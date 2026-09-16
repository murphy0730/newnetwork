'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const C = require('../forecast-core'), Engine = require('../server/engine'), Summary = require('../server/supply-summary'), { Service } = require('../server/service');

function fixture() {
  const s = C.empty(); s.kind = 'imported';
  for (const [code, make_dept, qty] of [['A', 'a', 100], ['B1', 'a', 80], ['B2', 'a', 20], ['C', 'c', 650], ['ISO', 'c', 7]]) {
    s.tables.attributes.push({ code, make_dept, lead_mean: 1, lead_cv: .1 });
    for (let i = 0; i < 6; i++) { const month = C.addMonth('2026-09', i); s.tables.forecast.push({ code, plan_date: '2026-08-24', month, qty, site_code: 'S' }); s.tables.inventory.push({ code, date: month + '-01', qty: 30 }); }
  }
  s.tables.bom.push({ id: '1', parent: 'A', child: 'B1', qty: 2 }, { id: '2', parent: 'B1', child: 'C', qty: 3 }, { id: '3', parent: 'B2', child: 'C', qty: 5 });
  return s;
}
function serviceTest(run) {
  const service = new Service(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'supply-summary-')), 'test.sqlite'));
  try { service.publish(fixture(), 0, 'test', 'test'); run(service); } finally { service.store.close(); }
}
const q = { summary: 1, role: 'supply', month: '2026-09', limit: 20 };

test('supplier ordering is bottom-up, then scope sources, then forecast presence before pagination', () => serviceTest(s => {
  const data = C.empty(); data.kind = 'imported';
  for (const [code, make_dept, qty] of [['ROOT', 'a', 10000], ['MID', 'a', 1], ['DEEP', 'c', 1000], ['ZERO', 'c', 0], ['MISSING', 'c', null], ['LOCAL', 'a', 50000], ['ISO', 'a', 99]]) {
    data.tables.attributes.push({ code, make_dept, lead_mean: 1 });
    if (qty != null) data.tables.forecast.push({ code, plan_date: '2026-08-24', month: q.month, qty, site_code: 'S' });
    // A different month's record must not qualify as a current-month forecast.
    data.tables.forecast.push({ code, plan_date: '2026-08-24', month: '2026-10', qty: code === 'MISSING' ? 5 : 0, site_code: 'S' });
  }
  for (const [parent, child] of [['ROOT', 'MID'], ['MID', 'DEEP'], ['ROOT', 'ZERO'], ['ROOT', 'MISSING'], ['ROOT', 'LOCAL']]) data.tables.bom.push({ id: parent + '-' + child, parent, child, qty: 1 });
  s.publish(data, 1, 'test', 'test');
  for (const mode of ['direct', 'cross', 'top']) {
    const all = s.list({ ...q, mode }, 'test');
    const expected = mode === 'cross' ? ['DEEP', 'ZERO', 'MISSING', 'ISO', 'LOCAL', 'MID', 'ROOT'] : ['DEEP', 'LOCAL', 'ZERO', 'MISSING', 'ISO', 'MID', 'ROOT'];
    assert.deepEqual(all.rows.map(r => r.code), expected, mode);
    const paged = [];
    for (let offset = 0; offset < all.total; offset += 2) paged.push(...s.list({ ...q, mode, limit: 2, offset }, 'test').rows.map(r => r.code));
    assert.deepEqual(paged, expected, 'pagination retains global order');
    const filtered = s.list({ ...q, mode, codes: ['ROOT', 'MISSING', 'DEEP'] }, 'test');
    assert.deepEqual(filtered.rows.map(r => r.code), ['DEEP', 'MISSING', 'ROOT']);
  }
  const later = s.list({ ...q, mode: 'cross', month: '2026-10' }, 'test');
  assert.deepEqual(later.rows.map(r => r.code), ['DEEP', 'MISSING', 'ZERO', 'ISO', 'LOCAL', 'MID', 'ROOT']);
  // Multi-month display keeps the start-month ordering used by the table filters.
  assert.deepEqual(s.list({ ...q, mode: 'cross', span: 2 }, 'test').rows.map(r => r.code), ['DEEP', 'ZERO', 'MISSING', 'ISO', 'LOCAL', 'MID', 'ROOT']);
}));

test('supplier table retains all codes; focus is exact and demand role is suspended only for summary', () => serviceTest(s => {
  for (const mode of ['direct', 'cross', 'top']) {
    const all = s.list({ ...q, mode }, 'test'); assert.equal(all.total, 5);
    assert.deepEqual(all.rows.map(r => r.code).sort(), ['A', 'B1', 'B2', 'C', 'ISO']);
    const focus = s.list({ ...q, mode, code: 'C' }, 'test'); assert.equal(focus.total, 1); assert.equal(focus.rows[0].code, 'C');
    for (const code of ['A', 'B2', 'ISO']) { const r = all.rows.find(r => r.code === code); assert.equal(r.demand, null); assert.equal(r.gap, 0); assert.equal(r.coverageGap, 0); assert.equal(r.inventory, 30); assert.ok(r.supply > 0); }
  }
  assert.throws(() => s.list({ ...q, code: 'MISSING' }, 'test'), /编码不存在/);
  assert.throws(() => s.list({ ...q, role: 'demand' }, 'test'), /暂不支持需求方/);
  assert.ok(s.list({ month: q.month, mode: 'direct', role: 'demand', code: 'A' }, 'test').rows.some(r => r.code === 'B1'));
}));

test('direct, cross and top rows expose source contributions; GAP subtracts supply exactly once', () => serviceTest(s => {
  const direct = s.list({ ...q, mode: 'direct', code: 'C' }, 'test').rows[0];
  assert.deepEqual(direct.targets.map(t => [t.code, t.coeff, t.demand]).sort(), [['B1', 3, 240], ['B2', 5, 100]]);
  assert.equal(direct.demand, 340); assert.equal(direct.gap, -310);
  for (const mode of ['cross', 'top']) {
    const r = s.list({ ...q, mode, code: 'C' }, 'test').rows[0];
    const isCross = mode === 'cross', demand = isCross ? 340 : 700;
    assert.deepEqual(r.targets.map(t => [t.code, t.coeff, t.demand]).sort(), isCross ? [['B1', 3, 240], ['B2', 5, 100]] : [['A', 6, 600], ['B2', 5, 100]]);
    assert.equal(r.demand, demand); assert.equal(r.gap, demand - 650); assert.equal(r.coverageGap, demand - 680);
    const risk = s.list({ ...q, mode, risk: 'shortage' }, 'test'); assert.equal(risk.rows.some(r => r.code === 'C'), !isCross);
    const focused = s.list({ ...q, mode, code: 'C', industry: 'c' }, 'test'); assert.equal(focused.rows[0].demand, demand);
    assert.equal(focused.trace.relationRule, 'first-cross-industry-v2');
  }
  assert.equal(s.list({ ...q, mode: 'cross', code: 'B1' }, 'test').rows[0].applicable, false);
  const multi = s.list({ ...q, mode: 'cross', code: 'C', span: 6 }, 'test').rows[0];
  assert.equal(multi.monthly.length, 6); assert.equal(multi.demand, 2040); assert.equal(multi.supply, 3900); assert.equal(multi.coverageGap, -1890); assert.equal(multi.firstShortage, null);
  assert.equal(multi.targets[0].monthly.length, 6);
  const top = s.list({ ...q, mode: 'top', code: 'A', span: 6 }, 'test').rows[0]; assert.equal(top.demand, null); assert.equal(top.gap, 0); assert.equal(top.coverageGap, 0);
}));

test('cross stops at the first different industry; forecasts beyond the boundary do not affect demand', () => {
  const data = fixture();
  data.tables.attributes.push({ code: 'U', make_dept: 'u' });
  data.tables.forecast.push({ code: 'U', plan_date: '2026-08-24', month: q.month, qty: 1000 });
  data.tables.bom.push({ id: '4', parent: 'U', child: 'A', qty: 2 }, { id: '5', parent: 'A', child: 'B2', qty: 4 });
  const e = new Engine(data);
  assert.deepEqual(Summary.relations(e, 'C', 'cross').map(r => [r.code, r.coeff]).sort(), [['B1', 3], ['B2', 5]]);
  assert.equal(Summary.view(e, q.month, 'cross', 'forecast').byCode.get('C').demand, 340);
  assert.equal(Summary.view(e, q.month, 'top', 'forecast').byCode.get('C').demand, 52000);
  // A is beyond the boundary: a missing A does not invalidate B1/B2 demand.
  data.tables.forecast = data.tables.forecast.filter(r => r.code !== 'A');
  const missingAncestor = new Engine(data);
  assert.equal(Summary.view(missingAncestor, q.month, 'cross', 'forecast').byCode.get('C').demand, 340);
  data.tables.forecast = data.tables.forecast.filter(r => r.code !== 'B1');
  const unknown = new Engine(data); assert.equal(Summary.view(unknown, q.month, 'cross', 'forecast').byCode.get('C').demand, null);
});

test('cross multiplies same-industry paths and sums convergent coefficients only up to the first boundary', () => {
  const data = fixture();
  for (const code of ['X', 'Y']) {
    data.tables.attributes.push({ code, make_dept: 'c' });
    data.tables.forecast.push({ code, plan_date: '2026-08-24', month: q.month, qty: 99999 });
  }
  data.tables.bom = data.tables.bom.filter(r => r.child !== 'C');
  for (const [parent, child, qty] of [['B1', 'X', 2], ['B1', 'Y', 3], ['X', 'C', 4], ['Y', 'C', 5], ['B2', 'C', 5]]) data.tables.bom.push({ id: parent + child, parent, child, qty });
  const e = new Engine(data), row = Summary.view(e, q.month, 'cross', 'forecast').byCode.get('C');
  assert.deepEqual(Summary.relations(e, 'C', 'cross').map(r => [r.code, r.coeff]).sort(), [['B1', 23], ['B2', 5]]);
  assert.equal(row.demand, 80 * (2 * 4 + 3 * 5) + 20 * 5);
  assert.equal(Summary.decorate(e, row, q.month, 1, [q.month], 'cross', 'forecast').demand, row.demand);
});

test('summary aggregate and source detail agree on mixed-department DAGs including unknown departments', () => {
  for (let variant = 0; variant < 5; variant++) {
    const data = fixture();
    for (let i = 0; i < 25; i++) {
      const code = 'N' + i; data.tables.attributes.push({ code, make_dept: i === variant ? '' : ['a', 'b', 'c'][i % 3] });
      data.tables.forecast.push({ code, plan_date: '2026-08-24', month: q.month, qty: i * 10 });
      for (let j = 1; j <= 3; j++) if (i >= j) data.tables.bom.push({ id: code + '-' + j, parent: 'N' + (i - j), child: code, qty: j });
    }
    const e = new Engine(data);
    for (const mode of ['direct', 'cross', 'top']) for (const row of Summary.view(e, q.month, mode, 'forecast').rows) {
      const base = { code: row.code, risks: row.risks };
      const detail = Summary.decorate(e, base, q.month, 1, [q.month], mode, 'forecast');
      assert.equal(detail.demand, row.demand, mode + '/' + row.code); assert.equal(detail.gap, row.gap, mode + '/' + row.code);
    }
  }
});

test('summary reads isolated scenario quantities and never changes baseline or another actor access', () => serviceTest(s => {
  const before = s.list({ ...q, mode: 'cross', code: 'C' }, 'test').rows[0];
  const ancestorScenario = s.simulate({ version: '2026-08-24', month: q.month, baseRevision: 1, changes: [{ code: 'A', month: q.month, operation: 'add', value: 10 }] }, 'test');
  assert.equal(s.list({ ...q, mode: 'cross', code: 'C', scenario: ancestorScenario.id }, 'test').rows[0].demand, before.demand);
  const scenario = s.simulate({ version: '2026-08-24', month: q.month, baseRevision: 1, changes: [{ code: 'B1', month: q.month, operation: 'add', value: 10 }] }, 'test');
  const after = s.list({ ...q, mode: 'cross', code: 'C', scenario: scenario.id }, 'test').rows[0];
  assert.equal(after.demand, 370); assert.equal(after.gap, -280); assert.equal(after.targets.find(t => t.code === 'B1').demand, 270);
  assert.equal(s.list({ ...q, mode: 'cross', code: 'C' }, 'test').rows[0].demand, before.demand);
  assert.throws(() => s.list({ ...q, scenario: scenario.id }, 'other'), /无权/);
}));

test('raw adjustments and production-order supply retain the same forecast demand basis', () => {
  const data = fixture(); data.config.input_mode = 'raw';
  data.tables.adjust.push({ code: 'B1', month: q.month, direction: '使用', qty: 10 }, { code: 'C', month: q.month, direction: '供应', qty: 25 });
  data.tables.mo.push({ id: 'MO1', code: 'C', sched_date: q.month + '-10', qty: 600, status: 'open', site_code: 'S' });
  const e = new Engine(data);
  for (const source of ['forecast', 'mo']) {
    const row = Summary.view(e, q.month, 'cross', source).byCode.get('C');
    const detail = Summary.decorate(e, { code: 'C', risks: row.risks }, q.month, 1, [q.month], 'cross', source);
    assert.equal(row.demand, 310); assert.equal(detail.demand, 310);
    assert.equal(detail.supply, source === 'forecast' ? 675 : 600);
    assert.equal(detail.gap, source === 'forecast' ? -365 : -290);
  }
});

test('individual months include inventory only in the selected first month; cumulative inventory stays unchanged', () => serviceTest(s => {
  const data = fixture();
  // Supply 650, 750, 850; top demand 700, direct/cross demand 340 each month.
  for (const r of data.tables.forecast) if (r.code === 'C') r.qty = { '2026-09': 650, '2026-10': 750, '2026-11': 850 }[r.month] ?? r.qty;
  for (const r of data.tables.inventory) if (r.code === 'C') r.qty = { '2026-09-01': 30, '2026-10-01': 100, '2026-11-01': 5 }[r.date] ?? r.qty;
  s.publish(data, 1, 'test', 'test');
  for (const mode of ['direct', 'cross', 'top']) {
    const args = { ...q, mode, span: 3, code: 'C' };
    const individual = s.list({ ...args, periodMode: 'individual' }, 'test'), cumulative = s.list({ ...args, periodMode: 'cumulative' }, 'test');
    assert.equal(individual.periods.length, 3); assert.equal(cumulative.periods.length, 1);
    assert.equal(cumulative.periods[0].label, '2026年9-11月');
    const separate = individual.rows[0].periods, combined = cumulative.rows[0].periods[0];
    assert.deepEqual(individual.periods.map(r => r.inventoryIncluded), [true, false, false]);
    assert.deepEqual(separate.map(r => r.inventoryIncluded), [true, false, false]);
    assert.deepEqual(separate.map(r => r.inventory), [30, null, null]);
    assert.deepEqual(separate.map(r => r.supply), [650, 750, 850]);
    assert.equal(combined.supply, 2250); assert.equal(combined.inventory, 30);
    assert.equal(combined.demand, separate.reduce((sum, r) => sum + r.demand, 0));
    assert.equal(combined.coverageGap, combined.demand - 2250 - 30);
    assert.deepEqual(individual.rows[0].targets.map(t => t.demand), cumulative.rows[0].targets.map(t => t.demand));
    if (mode === 'top') {
      assert.deepEqual(separate.map(r => r.gap), [50, -50, -150]);
      assert.deepEqual(separate.map(r => r.coverageGap), [20, null, null]);
      assert.equal(combined.coverageGap, -180); assert.equal(combined.firstShortage, '2026-09');
    }
  }
  const shifted = s.list({ ...q, month: '2026-10', code: 'C', mode: 'cross', span: 3, periodMode: 'individual' }, 'test').rows[0].periods;
  assert.equal(shifted[0].inventory, 100); assert.equal(shifted[0].gap, -410); assert.equal(shifted[0].coverageGap, -510);
  assert.equal(shifted[1].inventoryIncluded, false); assert.equal(shifted[1].gap, -510); assert.equal(shifted[1].coverageGap, null);
  data.tables.inventory = data.tables.inventory.filter(r => r.date !== '2026-09-01');
  s.publish(data, 2, 'test', 'test');
  const missingInventory = s.list({ ...q, code: 'C', mode: 'cross', span: 3, periodMode: 'individual' }, 'test').rows[0].periods;
  assert.equal(missingInventory[0].inventoryIncluded, true); assert.equal(missingInventory[0].coverageGap, null); assert.equal(missingInventory[0].gap, -310);
  assert.equal(missingInventory[1].gap, -410); assert.equal(missingInventory[1].complete, true);
  assert.throws(() => s.list({ ...q, periodMode: 'bad' }, 'test'), /月份计算方式无效/);
  for (const periodMode of ['individual', 'cumulative']) assert.throws(() => s.list({ ...q, span: 7, periodMode }, 'test'), /超出范围/);
}));

test('calendar months are never skipped; covered months without records count as zero and year ranges are explicit', () => serviceTest(s => {
  const data = fixture(); data.tables.forecast = data.tables.forecast.filter(r => r.month !== '2026-10');
  s.publish(data, 1, 'test', 'test');
  const result = s.list({ ...q, mode: 'cross', span: 3, code: 'C', periodMode: 'individual' }, 'test');
  assert.deepEqual(result.spanMonths, ['2026-09', '2026-10', '2026-11']);
  // 2026-10 在版本覆盖范围内但无任何预测记录 → 按0计入而非未知
  const rows = result.rows[0].periods; assert.equal(rows[1].complete, true); assert.equal(rows[1].supply, 0); assert.equal(rows[1].demand, 0); assert.equal(rows[1].gap, 0); assert.equal(rows[1].inventory, null); assert.equal(rows[1].inventoryIncluded, false); assert.equal(rows[2].complete, true);
  const combined = s.list({ ...q, mode: 'cross', span: 3, code: 'C', periodMode: 'cumulative' }, 'test').rows[0].periods[0];
  assert.equal(combined.complete, true); assert.equal(combined.supply, 1300); assert.equal(combined.demand, 680); assert.equal(combined.coverageGap, -650);
  const crossYear = s.list({ ...q, month: '2026-12', mode: 'cross', span: 3, code: 'C', periodMode: 'cumulative' }, 'test');
  assert.equal(crossYear.periods[0].label, '2026年12月-2027年2月');
  // 版本未覆盖的月份（2027-03起）仍按数据不完整处理
  const tail = s.list({ ...q, month: '2027-02', mode: 'cross', span: 6, code: 'C', periodMode: 'individual' }, 'test');
  assert.equal(tail.rows[0].periods.length, 6); assert.equal(tail.rows[0].periods.at(-1).complete, false);
}));
