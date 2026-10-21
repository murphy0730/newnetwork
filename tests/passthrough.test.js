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

test('直接父子：B 无预测时永停直接父项 B（预测按 0、已知），不再上溯到 A', () => {
  const s = chain({ bQty: null });   // B 不在表1，但在表6有维护行
  const e = new C.Engine(s), a = e.compute(MONTH, 'direct'), b = a.get('B'), c = a.get('C');
  assert.ok(e.graph.codes.includes('B'), '全量 BOM 网络应包含无预测记录的 B');
  assert.equal(c.demand, 0);   // 直接父子停在 B，B 无预测按 0 计
  assert.equal(c.supply, 50); assert.equal(c.gap, -50); assert.equal(c.complete, true);   // 富余 50，不再标不完整
  assert.deepEqual(e.relations('C', 'direct', MONTH, true).map(r => r.code), ['B']);   // 来源显示直接父项 B
  assert.equal(b.passThrough, true); assert.equal(b.gap, null);   // B 自身仍透传，不计缺口
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

test('整条上游都无预测记录：直接父子按 0 计，跨产业/最顶层标数据不完整', () => {
  const s = chain({ aQtyPresent: false, bQty: null });
  const e = new C.Engine(s);
  const cd = e.compute(MONTH, 'direct').get('C'), bd = e.compute(MONTH, 'direct').get('B');
  assert.equal(cd.complete, true); assert.equal(cd.demand, 0); assert.equal(cd.gap, -50);   // 直接父子：B 无预测按 0（已知），C 富余
  assert.equal(bd.passThrough, false);   // 上游无预测，不算透传
  for (const mode of ['cross', 'top']) {
    const c = e.compute(MONTH, mode).get('C');
    assert.equal(c.complete, false, mode); assert.equal(c.demand, null); assert.equal(c.gap, null);
    assert.ok(c.risks.includes('预测或产业数据不完整'), mode);
    assert.equal(e.compute(MONTH, mode).get('B').passThrough, false, mode);
  }
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

test('情况1：B 有维护但无预测 → C 跨产业找到 A 而不是 B（targets 与数值一致）', () => {
  // C 属产业1，B/A 属产业2；A=100，C=50，B 无预测
  const s = chain({ aDept: '产业2', bDept: '产业2', cDept: '产业1', bQty: null });
  const e = new C.Engine(s);
  const c = e.compute(MONTH, 'cross').get('C');
  assert.equal(c.demand, 100); assert.equal(c.gap, 50); assert.equal(c.complete, true);
  const cross = e.relations('C', 'cross', MONTH, true);
  assert.deepEqual(cross.map(r => [r.code, r.kind]), [['A', '跨产业首个编码']]);   // 跨产业跳过无预测的 B，上溯到 A
  assert.deepEqual(e.relations('C', 'direct', MONTH, true).map(r => r.code), ['B']);   // 直接父子永停直接父项 B
  const b = e.compute(MONTH, 'cross').get('B');
  assert.equal(b.passThrough, true); assert.equal(b.gap, null);
});

test('情况2：B 完全不在表6 → 未知部门 + 无预测，同样继续上溯到 A；B 有预测时停在 B', () => {
  const s = chain({ aDept: '产业2', cDept: '产业1', bAttr: false, bQty: null });
  const e = new C.Engine(s);
  assert.equal(e.dept('B'), '未知部门');
  const c = e.compute(MONTH, 'cross').get('C');
  assert.equal(c.demand, 100); assert.equal(c.complete, true);
  assert.deepEqual(e.relations('C', 'cross', MONTH, true).map(r => [r.code, r.kind]), [['A', '跨产业首个编码']]);
  // B 有预测 80：跨产业边界停在 B（B 是未知部门 ≠ 产业1）
  const withB = new C.Engine(chain({ aDept: '产业2', cDept: '产业1', bAttr: false, bQty: 80 }));
  const cw = withB.compute(MONTH, 'cross').get('C');
  assert.equal(cw.demand, 80); assert.equal(cw.gap, 30);
  assert.deepEqual(withB.relations('C', 'cross', MONTH, true).map(r => [r.code, r.kind]), [['B', '跨产业首个编码']]);
});

test('多层连续无预测：直接父子停在 B2（按 0），跨产业/最顶层上溯到 A', () => {
  const s = C.empty(), t = s.tables;
  for (const [code, dept] of [['A', 'X'], ['B1', 'X'], ['B2', 'X'], ['C', 'X']]) t.attributes.push({ code, make_dept: dept, lead_mean: 1 });
  t.bom.push({ id: '1', parent: 'A', child: 'B1', qty: 1 }, { id: '2', parent: 'B1', child: 'B2', qty: 1 }, { id: '3', parent: 'B2', child: 'C', qty: 1 });
  t.forecast.push({ plan_date: VERSION, code: 'A', month: MONTH, qty: 100, site_code: 'S' }, { plan_date: VERSION, code: 'C', month: MONTH, qty: 50, site_code: 'S' });
  const e = new C.Engine(s);
  const cd = e.compute(MONTH, 'direct').get('C');
  assert.equal(cd.demand, 0); assert.equal(cd.gap, -50);   // 直接父子停 B2，按 0
  assert.deepEqual(e.relations('C', 'direct', MONTH, true).map(r => r.code), ['B2']);
  const cc = e.compute(MONTH, 'cross').get('C');
  assert.equal(cc.demand, 100); assert.equal(cc.gap, 50);   // 跨产业上溯到 A
  assert.deepEqual(e.relations('C', 'cross', MONTH, true).map(r => r.code), ['A']);
  assert.equal(e.compute(MONTH, 'cross').get('B1').passThrough, true);
  assert.equal(e.compute(MONTH, 'cross').get('B2').passThrough, true);
});

test('无预测透传编码可在搜索栏搜到（按编码，部门显示未知部门）', () => {
  const service = new Service(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tower-search-pt-')), 't.sqlite'));
  try {
    service.publish(chain({ bAttr: false, bQty: null }), 0, 'test', 'test');
    const found = service.list({ month: MONTH, mode: 'direct', search: 'B', limit: 40 }, 'test');
    assert.ok(found.rows.some(r => r.code === 'B'), '透传节点 B 应能被搜到');
    assert.equal(found.rows.find(r => r.code === 'B').make_dept, '未知部门');
  } finally { service.store.close(); }
});

test('聚焦编码只保留有向上下游闭包，兄弟/堂兄弟不进图', () => {
  const service = new Service(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tower-focus-')), 't.sqlite'));
  try {
    const s = C.empty(), t = s.tables;
    // A → B → C，A → B2 → D：B2 是 B 的兄弟，D 是堂兄弟（无向 3 跳内但不在有向链路上）
    for (const code of ['A', 'B', 'C', 'B2', 'D']) t.attributes.push({ code, make_dept: 'X', lead_mean: 1 });
    t.bom.push({ id: '1', parent: 'A', child: 'B', qty: 1 }, { id: '2', parent: 'B', child: 'C', qty: 1 }, { id: '3', parent: 'A', child: 'B2', qty: 1 }, { id: '4', parent: 'B2', child: 'D', qty: 1 });
    for (const code of ['A', 'B', 'C', 'B2', 'D']) t.forecast.push({ plan_date: VERSION, code, month: MONTH, qty: 10, site_code: 'S' });
    service.publish(s, 0, 'test', 'test');
    const g = service.graph({ code: 'B', month: MONTH, mode: 'direct', depth: 3 }, 'test');
    const codes = g.nodes.map(n => n.code);
    assert.ok(codes.includes('A') && codes.includes('B') && codes.includes('C'));
    assert.ok(!codes.includes('B2'), '兄弟不应进图');
    assert.ok(!codes.includes('D'), '堂兄弟不应进图');
    // 直接下层（depth=1）结果与原来一致：上 1 + 下 1
    const g1 = service.graph({ code: 'B', month: MONTH, mode: 'direct', depth: 1 }, 'test');
    assert.deepEqual(g1.nodes.map(n => n.code).sort(), ['A', 'B', 'C']);
  } finally { service.store.close(); }
});

test('详情与汇总表 targets 也取上溯后的有效需求，与矩阵一致', () => {
  const service = new Service(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tower-passthrough-')), 't.sqlite'));
  try {
    service.publish(chain({ bQty: null }), 0, 'test', 'test');
    const detail = service.detail({ code: 'C', month: MONTH, mode: 'direct' }, 'test');
    assert.equal(detail.targets.length, 1);
    assert.equal(detail.targets[0].code, 'B');   // 直接父子停直接父项 B，预测按 0
    assert.equal(detail.targets[0].demand, 0);
    assert.equal(detail.targets[0].known, true);
    const row = service.list({ summary: 1, role: 'supply', code: 'C', month: MONTH, mode: 'direct', span: 1, limit: 20 }, 'test').rows[0];
    assert.equal(row.demand, 0); assert.equal(row.gap, -50); assert.equal(row.complete, true);
    const bRow = service.list({ summary: 1, role: 'supply', code: 'B', month: MONTH, mode: 'direct', span: 1, limit: 20 }, 'test').rows[0];
    assert.equal(bRow.demand, 100); assert.equal(bRow.gap, null); assert.equal(bRow.passThrough, true); assert.equal(bRow.complete, false);
    const dashboard = service.list({ month: MONTH, mode: 'direct', limit: 20 }, 'test').dashboard;
    assert.equal(dashboard.incomplete, 0);   // 透传节点不计入数据不完整 KPI
  } finally { service.store.close(); }
});
