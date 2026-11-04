'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../forecast-core'), Engine = require('../server/engine'), Summary = require('../server/supply-summary'), { Service } = require('../server/service');
const month = '2026-09', version = '2026-09-24';
function fixture() {
  const s = C.empty();
  for (const [code, dept, sep, oct] of [['A', 'X', 100, 200], ['B', 'Y', null, 80], ['C', 'Z', 50, 50], ['D', '', 0, 0], ['E', 'Z', 30, 30]]) {
    s.tables.attributes.push({ code, name: '名称' + code, make_dept: dept, part_category: '大类' + code, part_subcategory: '小类' + code, make_obj_package1: '包' + code });
    for (const [m, qty] of [[month, sep], ['2026-10', oct]]) if (qty != null) s.tables.forecast.push({ code, qty, month: m, plan_date: version });
  }
  for (const [parent, child] of [['A', 'B'], ['B', 'C'], ['D', 'C'], ['A', 'E']]) s.tables.bom.push({ parent, child, qty: 1, parent_template: 'AI', child_template: 'AI' });
  s.tables.inventory = [{ code: 'C', date: '2020-01-01', qty: 20 }];
  return s;
}
function service(engine) {
  const s = Object.create(Service.prototype);
  s.context = q => ({ engine, month: q.month || month, mode: q.mode || 'cross', source: q.source || 'forecast', trace: { revision: 0, version } });
  return s;
}
const q = { summary: 1, month, mode: 'cross' };
test('manufacturing attributes import and summary preserve the three exact supplier fields', () => {
  const parsed = C.parseMatrix('attributes', [['part_no', 'make_dept', '产品大类', '产品小类', '加工对象包'], ['C', 'Z', '大类C', '小类C', '包C']]);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows[0].part_subcategory, '小类C'); assert.equal(parsed.rows[0].make_obj_package1, '包C');
  const row = service(new Engine(fixture())).list({ ...q, code: 'C' }, 'test').rows[0];
  assert.deepEqual([row.part_category, row.part_subcategory, row.make_obj_package1], ['大类C', '小类C', '包C']);
});
test('summary preserves supplied balances independently of a missing demand field', () => {
  const engine = new Engine(fixture()), original = engine.row.bind(engine);
  engine.row = (code, m, mode, source) => { const row = original(code, m, mode, source); return code === 'C' ? { ...row, demand: null, gap: -50, coverageGap: -70, complete: false } : row; };
  const svc = service(engine), single = svc.list({ ...q, code: 'C' }, 'test').rows[0];
  assert.deepEqual([single.demand, single.gap, single.coverageGap], [null, -50, -70]);
  const cumulative = svc.list({ ...q, code: 'C', span: 2, periodMode: 'cumulative' }, 'test').rows[0];
  assert.deepEqual([cumulative.demand, cumulative.gap, cumulative.coverageGap], [null, -100, -120]);
});
test('zero demand retains known balances and genuinely unknown source demand remains unknown', () => {
  const zero = fixture(); zero.tables.forecast.filter(r => r.code !== 'C' && r.code !== 'E').forEach(r => { r.qty = 0; });
  const row = service(new Engine(zero)).list({ ...q, code: 'C' }, 'test').rows[0];
  assert.deepEqual([row.demand, row.gap, row.coverageGap], [0, -50, -70]);
  const unknown = fixture(); unknown.tables.forecast = unknown.tables.forecast.filter(r => !['A', 'B', 'D'].includes(r.code));
  const missing = service(new Engine(unknown)).list({ ...q, code: 'C' }, 'test').rows[0];
  assert.deepEqual([missing.demand, missing.gap, missing.coverageGap], [null, null, null]);
});
test('an independent inventory balance survives even when the supply balance is missing', () => {
  const engine = new Engine(fixture()), original = engine.row.bind(engine);
  engine.row = (code, m, mode, source) => { const row = original(code, m, mode, source); return code === 'C' ? { ...row, demand: null, gap: m === month ? null : -50, coverageGap: -70, complete: false } : row; };
  const svc = service(engine);
  for (const periodMode of ['individual', 'cumulative']) {
    const row = svc.list({ ...q, code: 'C', periodMode }, 'test').rows[0];
    assert.deepEqual([row.demand, row.gap, row.coverageGap], [null, null, -70]);
    assert.equal(row.periods[0].coverageGap, -70);
    assert.equal(svc.list({ ...q, code: 'C', span: 2, periodMode }, 'test').rows[0].coverageGap, -120);
  }
});
test('source industry filters before pagination and retains full supplier totals while narrowing source details', () => {
  const svc = service(new Engine(fixture()));
  for (const mode of ['direct', 'cross', 'top']) for (const span of [1, 2]) {
    const all = svc.list({ ...q, mode, span }, 'test');
    for (const industry of ['X', 'Y', 'Z', '未知部门']) {
      const expected = all.rows.filter(r => r.targets.some(t => t.make_dept === industry));
      const filtered = svc.list({ ...q, mode, span, sourceIndustry: industry, limit: 1 }, 'test');
      assert.equal(filtered.total, expected.length, `${mode}/${span}/${industry}`);
      assert.equal(filtered.dashboard.total, expected.length);
      const codes = [];
      for (let offset = 0; offset < filtered.total; offset++) {
        const r = svc.list({ ...q, mode, span, sourceIndustry: industry, limit: 1, offset }, 'test').rows[0], base = expected.find(b => b.code === r.code);
        codes.push(r.code); assert.ok(r.targets.every(t => t.make_dept === industry));
        assert.deepEqual([r.demand, r.gap, r.coverageGap], [base.demand, base.gap, base.coverageGap]);
      }
      assert.deepEqual(codes, expected.map(r => r.code));
    }
  }
});
test('source matching propagates industry flags without resolving every supplier frontier', () => {
  const engine = new Engine(fixture()), rows = [...engine.compute(month, 'cross').values()];
  for (const mode of ['direct', 'cross', 'top']) for (const months of [[month], ['2026-10'], [month, '2026-10']]) for (const industry of ['X', 'Y', 'Z', '未知部门']) {
    const expected = rows.filter(r => months.some(m => engine.relations(r.code, mode, m, true).some(t => engine.dept(t.code) === industry))).map(r => r.code);
    const original = engine.relations; engine.relations = () => { throw Error('Filtering must not materialize every source frontier'); };
    try { assert.deepEqual(Summary.filterSourceIndustry(engine, rows, months, mode, industry).map(r => r.code), expected); } finally { engine.relations = original; }
  }
});
test('industry matching agrees with source frontiers on converging BOMs, sparse forecasts and missing departments', () => {
  for (const seed of [17, 2026, 123456]) {
    const s = C.empty(); let state = seed;
    const random = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
    for (let i = 0; i < 70; i++) {
      const code = 'P' + i;
      if (random(5)) s.tables.attributes.push({ code, make_dept: 'D' + random(4) });
      for (let m = 0; m < 3; m++) if (random(4)) s.tables.forecast.push({ code, qty: random(3) ? 100 : 0, month: C.addMonth(month, m), plan_date: version });
      if (i > 8) for (let p = 0; p < 3; p++) s.tables.bom.push({ parent: 'P' + random(i), child: code, qty: 1 });
    }
    const engine = new Engine(s), rows = engine.graph.order.map(code => ({ code }));
    for (const mode of ['direct', 'cross', 'top']) for (const months of [[month], [month, '2026-10', '2026-11']]) for (const industry of ['D0', 'D1', 'D2', 'D3', '未知部门']) {
      const expected = rows.filter(r => months.some(m => engine.relations(r.code, mode, m, true).some(t => engine.dept(t.code) === industry))).map(r => r.code);
      assert.deepEqual(Summary.filterSourceIndustry(engine, rows, months, mode, industry).map(r => r.code), expected);
      assert.deepEqual(Summary.filterSourceIndustry(engine, rows.slice(0, 10), months, mode, industry).map(r => r.code), expected.filter(code => rows.slice(0, 10).some(r => r.code === code)));
    }
  }
});
