'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const C = require('../forecast-core'), { Service } = require('../server/service');

// 跨产业边界只按表6 make_dept 判定：父子项制造部门不同即跨产业，需求在边界止步于子项自身预测
function chain(tDept, mDept, lDept, uDept = 'X') {
  const s = C.empty(), m = '2026-09', v = '2026-08-24'; s.kind = 'imported';
  for (const [code, dept, qty] of [['U', uDept, 1000], ['T', tDept, 100], ['M', mDept, 50], ['L', lDept, 500]]) {
    s.tables.attributes.push({ code, make_dept: dept, lead_mean: 1, lead_cv: .1 });
    s.tables.forecast.push({ code, plan_date: v, month: m, qty, site_code: 'S' });
  }
  s.tables.bom.push({ id: '1', parent: 'U', child: 'T', qty: 1 }, { id: '2', parent: 'T', child: 'M', qty: 1 }, { id: '3', parent: 'M', child: 'L', qty: 2 });
  return { s, m };
}
test('cross-industry boundary follows 表6 make_dept; merged-industry logic removed', () => {
  // U、T 同属 X 部，M、L 同属 Y 部：需求跨产业边在 T→M，M 只下达自身预测
  const { s, m } = chain('X', 'Y', 'Y'), e = new C.Engine(s);
  assert.equal(e.compute(m, 'cross').get('T').demand, 1000);
  assert.equal(e.compute(m, 'cross').get('M').demand, 100);
  assert.equal(e.compute(m, 'cross').get('L').demand, 200);
  const rel = e.relations('L', 'cross');
  assert.deepEqual(rel.map(r => [r.code, r.kind]), [['T', '跨产业首个编码']]);
  // 全部同一制造部门时退化为全量级联：需求逐级穿透到最顶层
  const same = chain('Y', 'Y', 'Y', 'Y'), e2 = new C.Engine(same.s);
  assert.equal(e2.compute(m, 'cross').get('M').demand, 1000);
  assert.equal(e2.compute(m, 'cross').get('L').demand, 2000);
  assert.deepEqual(e2.relations('L', 'cross').map(r => [r.code, r.kind]), [['U', '本产业最顶层']]);
  // make_dept 未维护 → 产业未确认且下游标记数据不完整
  const unk = chain('X', 'Y', 'Y'); delete unk.s.tables.attributes.find(r => r.code === 'M').make_dept;
  const e3 = new C.Engine(unk.s);
  assert.equal(e3.relations('L', 'cross')[0].kind, '产业未确认');
  assert.equal(e3.compute(m, 'cross').get('L').complete, false);
});

test('summary table aggregates up to 6 months with rolling inventory and cross-industry codes', () => {
  const s = new Service(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tower-span-test-')), 't.sqlite'));
  try {
    const data = C.sample(); s.publish(data, 0, 'test', 'test');
    const e = new C.Engine(data), m = e.months[0];
    const single = s.list({ month: m, mode: 'cross', limit: 20 }, 'test');
    const d1 = single.rows.find(r => r.code === 'D');
    assert.equal(d1.demand, 550); assert.equal(d1.monthly, undefined);
    assert.deepEqual(d1.cross.map(x => [x.code, x.make_dept]).sort(), [['B', '整机事业部'], ['C', '整机事业部']]);
    assert.equal(d1.crossCount, 2);
    const multi = s.list({ month: m, mode: 'cross', limit: 20, span: 3 }, 'test');
    assert.deepEqual(multi.spanMonths, [m, C.addMonth(m, 1), C.addMonth(m, 2)]);
    const a = multi.rows.find(r => r.code === 'A');
    assert.equal(a.supply, 3000); assert.equal(a.demand, 3300); assert.equal(a.gap, 300);
    assert.equal(a.inventory, 200); assert.equal(a.coverageGap, 100); assert.equal(a.firstShortage, C.addMonth(m, 2));
    assert.equal(a.monthly.length, 3); assert.equal(a.monthly[0].gap, 100);
    // 剩余月份不足所选月份数 → 数据不完整
    const tail = s.list({ month: e.months.at(-1), mode: 'cross', limit: 20, span: 6 }, 'test');
    assert.equal(tail.spanMonths.length, 1);
    assert.equal(tail.rows.find(r => r.code === 'A').complete, false);
    // span 超过 6 被拒绝
    assert.throws(() => s.list({ month: m, mode: 'cross', limit: 20, span: 9 }, 'test'), /超出范围/);
  } finally { s.store.close(); }
});
