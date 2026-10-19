'use strict';
// 全量 BOM 网络 + 无预测记录时沿 BOM 继续上溯的验收测试。
// 场景对应：C→B→A 中 B 无预测时，C 仍能拿到 A 的预测；B 只透传，不计自身缺口。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const C = require('../forecast-core'), { Service } = require('../server/service');

const VERSION = '2026-09-24', MONTH = '2026-09';
// A 是顶层，B 是组件，C 是原料；A→B→C 配比 1:1。
function chain({ aDept = 'X', bDept = 'X', cDept = 'X', aQty = 100, bQty = 80, cQty = 50, bAttr = true, aQtyPresent = true } = {}) {
  const s = C.empty(), t = s.tables;
  t.attributes.push({ code: 'A', make_dept: aDept, lead_mean: 1 });
  if (bAttr) t.attributes.push({ code: 'B', make_dept: bDept, lead_mean: 1 });
  t.attributes.push({ code: 'C', make_dept: cDept, lead_mean: 1 });
  t.bom.push({ id: '1', parent: 'A', child: 'B', qty: 1 }, { id: '2', parent: 'B', child: 'C', qty: 1 });
  const f = (code, qty) => { if (qty != null) t.forecast.push({ plan_date: VERSION, code, month: MONTH, qty, site_code: 'S' }); };
  if (aQtyPresent) f('A', aQty);
  f('B', bQty); f('C', cQty);
  return s;
}

test('直接父子：B 无预测时 C 沿 BOM 上溯到 A；B 透传且不计自身缺口', () => {
  const s = chain({ bQty: null });   // B 不在表1，但在表6有维护行
  const e = new C.Engine(s), a = e.compute(MONTH, 'direct'), b = a.get('B'), c = a.get('C');
  assert.ok(e.graph.codes.includes('B'), '全量 BOM 网络应包含无预测记录的 B');
  assert.equal(c.demand, 100);   // C 的需求 = A 的预测 100 × 1 × 1
  assert.equal(c.supply, 50); assert.equal(c.gap, 50); assert.equal(c.complete, true);
  assert.equal(b.knownDemand, 100); assert.equal(b.passThrough, true); assert.equal(b.complete, false);
  assert.equal(b.demand, null); assert.equal(b.gap, null);   // 透传节点自身不算缺口
  assert.ok(!b.risks.includes('预测或产业数据不完整'));
});

test('直接父子：B 有预测时停在直接父项，不再叠加更上层', () => {
  const e = new C.Engine(chain());
  const c = e.compute(MONTH, 'direct').get('C');
  assert.equal(c.demand, 80); assert.equal(c.gap, 30);
});

test('跨产业/最顶层：B 无预测时仍沿 BOM 上溯；B 有预测时沿用原口径', () => {
  const noB = new C.Engine(chain({ bQty: null }));
  for (const mode of ['cross', 'top']) {
    const c = noB.compute(MONTH, mode).get('C');
    assert.equal(c.demand, 100, mode); assert.equal(c.gap, 50, mode);
  }
  const withB = new C.Engine(chain());
  assert.equal(withB.compute(MONTH, 'cross').get('C').demand, 100);   // 同产业中间层 B 的 80 不下传
  assert.equal(withB.compute(MONTH, 'top').get('C').demand, 100);
  // A=50 时跨产业 C-A 恰好满足，不再管 C 供不上 B 的 30
  const a50 = new C.Engine(chain({ aQty: 50 }));
  assert.equal(a50.compute(MONTH, 'cross').get('C').demand, 50);
  assert.equal(a50.compute(MONTH, 'cross').get('C').gap, 0);
});

test('跨产业边界上的 B 无预测时也继续上溯，而不是标数据不完整', () => {
  // A 与 B/C 不同产业，B 与 C 同产业；B 无预测
  const e = new C.Engine(chain({ aDept: 'X', bDept: 'Y', cDept: 'Y', bQty: null }));
  const b = e.compute(MONTH, 'cross').get('B'), c = e.compute(MONTH, 'cross').get('C');
  assert.equal(b.passThrough, true);
  assert.equal(c.demand, 100); assert.equal(c.gap, 50); assert.equal(c.complete, true);
});

test('整条上游都无预测记录：标数据不完整，不静默按 0，也不算透传', () => {
  const s = chain({ aQtyPresent: false, bQty: null });
  const e = new C.Engine(s), c = e.compute(MONTH, 'direct').get('C'), b = e.compute(MONTH, 'direct').get('B');
  assert.equal(c.complete, false); assert.equal(c.demand, null); assert.equal(c.gap, null);
  assert.ok(c.risks.includes('预测或产业数据不完整'));
  assert.equal(b.passThrough, false);
});

test('无表6维护行的透传编码统一按未知部门参与计算', () => {
  const s = chain({ bAttr: false, bQty: null });
  const scoped = C.scopeTables(s.tables);
  assert.equal(scoped.after.bom, 2);   // 表3 不按表1筛选
  const e = new C.Engine(s);
  assert.equal(e.dept('B'), '未知部门');
  const c = e.compute(MONTH, 'cross').get('C');
  assert.equal(c.demand, 100); assert.equal(c.complete, true);
});

test('详情与汇总表 targets 也取上溯后的有效需求，与矩阵一致', () => {
  const service = new Service(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tower-passthrough-')), 't.sqlite'));
  try {
    service.publish(chain({ bQty: null }), 0, 'test', 'test');
    const detail = service.detail({ code: 'C', month: MONTH, mode: 'direct' }, 'test');
    assert.equal(detail.targets.length, 1);
    assert.equal(detail.targets[0].code, 'B');
    assert.equal(detail.targets[0].demand, 100);   // B 自身无预测，target 取 A 的预测
    assert.equal(detail.targets[0].known, true);
    const row = service.list({ summary: 1, role: 'supply', code: 'C', month: MONTH, mode: 'direct', span: 1, limit: 20 }, 'test').rows[0];
    assert.equal(row.demand, 100); assert.equal(row.gap, 50); assert.equal(row.complete, true);
    const bRow = service.list({ summary: 1, role: 'supply', code: 'B', month: MONTH, mode: 'direct', span: 1, limit: 20 }, 'test').rows[0];
    assert.equal(bRow.demand, 100); assert.equal(bRow.gap, null); assert.equal(bRow.passThrough, true); assert.equal(bRow.complete, false);
    const dashboard = service.list({ month: MONTH, mode: 'direct', limit: 20 }, 'test').dashboard;
    assert.equal(dashboard.incomplete, 0);   // 透传节点不计入数据不完整 KPI
  } finally { service.store.close(); }
});
