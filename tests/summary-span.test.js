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
    assert.equal(a.raw, 3000); assert.equal(a.add, 0); assert.equal(a.remove, 0);
    assert.equal(a.inventory, 200); assert.equal(a.coverageGap, 100); assert.equal(a.firstShortage, C.addMonth(m, 2));
    assert.equal(a.monthly.length, 3); assert.equal(a.monthly[0].gap, 100); assert.equal(a.monthly[0].raw, 1000);
    // 剩余月份不足所选月份数 → 数据不完整
    const tail = s.list({ month: e.months.at(-1), mode: 'cross', limit: 20, span: 6 }, 'test');
    assert.equal(tail.spanMonths.length, 1);
    assert.equal(tail.rows.find(r => r.code === 'A').complete, false);
    // span 超过 6 被拒绝
    assert.throws(() => s.list({ month: m, mode: 'cross', limit: 20, span: 9 }, 'test'), /超出范围/);
    // 独立编码（无上下级）在汇总表口径下不展示；表1预测/添加/剔除按数值输出
    const data2 = C.sample();
    data2.tables.attributes.push({ code: 'ISO', make_dept: '整机事业部', lead_mean: 1, lead_cv: .1 });
    data2.tables.forecast.push({ code: 'ISO', plan_date: data2.tables.forecast[0].plan_date, month: m, qty: 7, site_code: 'S1' });
    s.publish(data2, 1, 'test', 'test');
    const withIso = s.list({ month: m, mode: 'cross', limit: 20 }, 'test');
    assert.ok(withIso.rows.some(r => r.code === 'ISO'));
    const linked = s.list({ month: m, mode: 'cross', limit: 20, linked: 1 }, 'test');
    assert.ok(!linked.rows.some(r => r.code === 'ISO'));
    const dRow = linked.rows.find(r => r.code === 'D');
    assert.equal(dRow.raw, 550); assert.equal(dRow.add, 0); assert.equal(dRow.remove, 0);
    // 能计算出结果（数据完整）的编码排在前面
    data2.tables.forecast = data2.tables.forecast.filter(r => !(r.code === 'A' && r.month === m));
    s.publish(data2, 2, 'test', 'test');
    const sorted = s.list({ month: m, mode: 'cross', limit: 20 }, 'test');
    const firstIncomplete = sorted.rows.findIndex(r => !r.complete);
    assert.ok(firstIncomplete === -1 || sorted.rows.slice(0, firstIncomplete).every(r => r.complete));
    assert.ok(sorted.rows.some(r => !r.complete));
  } finally { s.store.close(); }
});

test('removal exceeding forecast propagates the deficit as positive demand on children', () => {
  // 用户示例：A为子项，B为父项；B预测600、使用剔除2000 → 净需求-1400，缺口1400仍以正向拉动A
  const s = C.empty(), m = '2026-09', v = '2026-08-24'; s.kind = 'imported'; s.config.input_mode = 'raw';
  s.tables.attributes.push({ code: 'A', make_dept: 'X', lead_mean: 1, lead_cv: .1 }, { code: 'B', make_dept: 'X', lead_mean: 1, lead_cv: .1 });
  s.tables.forecast.push({ code: 'A', plan_date: v, month: m, qty: 1074, site_code: 'S' }, { code: 'B', plan_date: v, month: m, qty: 600, site_code: 'S' });
  s.tables.bom.push({ id: '1', parent: 'B', child: 'A', qty: 1 });
  s.tables.adjust.push({ direction: '供应', code: 'A', purchase_code: 'P', month: m, qty: 50 }, { direction: '使用', code: 'B', purchase_code: '', month: m, qty: 2000 });
  const e = new C.Engine(s);
  assert.equal(e.net('B', m).demand, -1400); // 净需求保留符号，仅用于展示
  const a = e.compute(m, 'direct').get('A');
  assert.equal(a.supply, 1124); assert.equal(a.demand, 1400); assert.equal(a.gap, 276);
  assert.equal(e.downstream('B', m, 'direct').find(r => r.code === 'A').contribution, 1400);
  const svc = new Service(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tower-deficit-')), 't.sqlite'));
  try {
    svc.publish(s, 0, 'test', 'test');
    for (const mode of ['direct', 'top']) {
      const row = svc.list({ summary: 1, month: m, mode, code: 'A' }, 'test').rows[0];
      assert.equal(row.raw, 1074); assert.equal(row.add, 50); assert.equal(row.supply, 1124);
      assert.equal(row.demand, 1400); assert.equal(row.gap, 276);
    }
  } finally { svc.store.close(); }
});

test('cumulative span zero-fills codes without forecast records in a covered month', () => {
  // A、B仅9月有预测；10月版本覆盖但两编码无记录 → 累计2个月时10月按0计入，而不是整行写“—”
  const s = C.empty(), m = '2026-09', m2 = '2026-10', v = '2026-08-24'; s.kind = 'imported'; s.config.input_mode = 'raw';
  s.tables.attributes.push({ code: 'A', make_dept: 'X', lead_mean: 1, lead_cv: .1 }, { code: 'B', make_dept: 'X', lead_mean: 1, lead_cv: .1 }, { code: 'Z', make_dept: 'X', lead_mean: 1, lead_cv: .1 });
  s.tables.forecast.push({ code: 'A', plan_date: v, month: m, qty: 1074, site_code: 'S' }, { code: 'B', plan_date: v, month: m, qty: 600, site_code: 'S' }, { code: 'Z', plan_date: v, month: m2, qty: 5, site_code: 'S' });
  s.tables.bom.push({ id: '1', parent: 'B', child: 'A', qty: 1 });
  s.tables.adjust.push({ direction: '供应', code: 'A', purchase_code: 'P', month: m, qty: 50 }, { direction: '使用', code: 'B', purchase_code: '', month: m, qty: 2000 });
  const svc = new Service(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tower-zerofill-')), 't.sqlite'));
  try {
    svc.publish(s, 0, 'test', 'test');
    const cum = svc.list({ summary: 1, month: m, mode: 'direct', code: 'A', span: 2, periodMode: 'cumulative' }, 'test').rows[0];
    assert.equal(cum.raw, 1074); assert.equal(cum.supply, 1124); assert.equal(cum.demand, 1400); assert.equal(cum.gap, 276); assert.equal(cum.complete, true);
    const ind = svc.list({ summary: 1, month: m, mode: 'direct', code: 'A', span: 2, periodMode: 'individual' }, 'test').rows[0];
    const oct = ind.periods[1];
    assert.equal(oct.month, m2); assert.equal(oct.raw, 0); assert.equal(oct.supply, 0); assert.equal(oct.demand, 0); assert.equal(oct.gap, 0); assert.equal(oct.complete, true);
    // 版本未覆盖的月份（11月）仍按数据不完整处理
    const beyond = svc.list({ summary: 1, month: m, mode: 'direct', code: 'A', span: 3, periodMode: 'cumulative' }, 'test').rows[0];
    assert.equal(beyond.complete, false); assert.equal(beyond.raw, null); assert.equal(beyond.demand, null);
  } finally { svc.store.close(); }
});

test('own usage removal counts on the demand side of the gap: B gap = 上层需求 + 剔除 − 供应 − 库存', () => {
  // 用户示例：A←B←C1/C2 配比均1:1；B预测600、使用剔除2000、库存490；C1预测2000、C2预测50
  // B库存后缺口 = 2050 + 2000 − 600 − 490 = 2960（旧口径960漏掉了B自身被剔除的消耗）
  const s = C.empty(), m = '2026-09', v = '2026-08-24'; s.kind = 'imported'; s.config.input_mode = 'raw';
  for (const [code, qty] of [['A', 1074], ['B', 600], ['C1', 2000], ['C2', 50]]) {
    s.tables.attributes.push({ code, make_dept: 'X', lead_mean: 1, lead_cv: .1 });
    s.tables.forecast.push({ code, plan_date: v, month: m, qty, site_code: 'S' });
  }
  s.tables.bom.push({ id: '1', parent: 'B', child: 'A', qty: 1 }, { id: '2', parent: 'C1', child: 'B', qty: 1 }, { id: '3', parent: 'C2', child: 'B', qty: 1 });
  s.tables.adjust.push({ direction: '供应', code: 'A', purchase_code: 'P', month: m, qty: 50 }, { direction: '使用', code: 'B', purchase_code: '', month: m, qty: 2000 });
  s.tables.inventory.push({ id: 'B' + m, date: m + '-01', code: 'B', qty: 490, sub_type: '正常库存' });
  const e = new C.Engine(s);
  for (const mode of ['direct', 'cross', 'top']) {
    const b = e.compute(m, mode).get('B');
    assert.equal(b.demand, 2050, mode + '/demand'); assert.equal(b.supply, 600, mode + '/supply');
    assert.equal(b.gap, 3450, mode + '/gap'); assert.equal(b.coverageGap, 2960, mode + '/coverageGap');
  }
  const svc = new Service(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tower-ownremove-')), 't.sqlite'));
  try {
    svc.publish(s, 0, 'test', 'test');
    const row = svc.list({ summary: 1, month: m, mode: 'direct', code: 'B' }, 'test').rows[0];
    assert.equal(row.demand, 2050); assert.equal(row.remove, 2000); assert.equal(row.supply, 600);
    assert.equal(row.gap, 3450); assert.equal(row.inventory, 490); assert.equal(row.coverageGap, 2960);
  } finally { svc.store.close(); }
});
