'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const C = require('../forecast-core'), Query = require('../server/query-index'), { Service, changesFor } = require('../server/service');
function setup(data = C.sample()) { const s = new Service(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'supply-insights-')), 'catalog.sqlite')); s.publish(data, 0, 'test', 'test'); return s; }

test('insights give reconciled evidence, actionable simulation and explicit shared-supply semantics', () => {
  const s = setup(); try {
    const e = s.engine(), q = { code: 'A', month: e.months[0], mode: 'cross' };
    e.compute = () => { throw Error('selected insight must not hydrate the entire network'); };
    const result = s.insights(q, 'test'); assert.equal(result.generator.llmUsed, false); assert.equal(result.status, 'risk'); assert.equal(result.trace.buildId, e.precomputed.buildId);
    const shortage = result.facts.find(f => f.id === 'supply_shortage'); assert.equal(shortage.evidence.gap, 100); assert.equal(result.demandContributors.knownContribution, shortage.evidence.demand);
    assert.equal(result.scopeComparison.length, 3); assert.equal(result.dependencies.allocation, false);
    const action = result.actions.find(a => a.id === 'test_supply_increase'); assert.equal(action.request.changes[0].value, 100);
    const sim = s.simulate(action.request, 'test'); assert.ok(sim.affected.some(r => r.code === 'A' && Math.abs(r.afterGap) < C.EPS));
    assert.equal(s.insights(q, 'test').cache.hit, true); assert.equal(s.store.revision(), 1);
    const scen = s.insights({ ...q, scenario: sim.id }, 'test'); assert.equal(scen.trace.scenario, sim.id); assert.ok(!scen.actions.some(a => a.id === 'test_supply_increase'));
    assert.throws(() => s.insights({ ...q, scenario: sim.id }, 'different-actor'), /无权|不可访问/);
  } finally { s.store.close(); }
});

test('missing data, terminal codes and inventory coverage are never described as confirmed delivery', () => {
  const data = C.sample(); data.tables.inventory = []; data.tables.attributes = data.tables.attributes.filter(r => r.code !== 'A'); data.tables.forecast = data.tables.forecast.filter(r => r.code !== 'A');
  const s = setup(data); try {
    const e = s.engine(), a = s.insights({ code: 'A', month: e.months[0] }, 'test'); assert.equal(a.confidence.supplyComplete, false); assert.ok(a.facts.some(f => f.id === 'supply_unknown')); assert.ok(!a.actions.some(f => f.id === 'test_supply_increase')); assert.ok(!a.facts.some(f => f.id === 'supply_covered'));
    const top = e.graph.codes.find(c => !e.graph.parents.get(c).length), result = s.insights({ code: top, month: e.months[0] }, 'test'); assert.ok(result.facts.some(f => f.id === 'supply_not_applicable')); assert.ok(result.dependencies.incompleteCount > 0); assert.equal(result.confidence.inventoryKnown, false);
    assert.throws(() => s.insights({ code: top, span: 'NaN' }, 'test'), /窗口/);
  } finally { s.store.close(); }
});

test('selected graphs stay sparse; sorting/filter cache respects source, scope, version and pagination', () => {
  const s = setup(); try {
    const e = s.engine(), q = { code: 'A', month: e.months[0], mode: 'cross', graphRelations: 'bom' };
    e.compute = () => { throw Error('selected graph must not hydrate the entire network'); }; assert.ok(s.graph(q, 'test').nodes.length); delete e.compute;
    const first = s.list({ month: q.month, limit: 1 }, 'test'); e.compute = () => { throw Error('cached page must not recompute or resort'); };
    const second = s.list({ month: q.month, offset: 1, limit: 1 }, 'test'); assert.equal(second.total, first.total); assert.notEqual(first.rows[0].code, second.rows[0].code);
    const filtered = s.list({ month: q.month, risk: 'shortage' }, 'test'); assert.ok(filtered.rows.every(r => r.gap > C.EPS));
    assert.throws(() => s.list({ risk: 'invalid' }, 'test'), /风险筛选/);
    delete e.compute;
    for (const mode of ['direct', 'cross', 'top']) for (const source of ['forecast', 'mo']) {
      const root = e.graph.codes.find(c => !e.graph.parents.get(c).length), actual = Query.dependencies(e, root, q.month, mode, source), reference = new C.Engine(e.snapshot);
      const expected = reference.downstream(root, q.month, mode);
      assert.deepEqual(actual.map(r => [r.code, r.coeff, r.contribution]), expected.map(r => [r.code, r.coeff, r.contribution]));
      for (const row of actual) assert.equal(row.gap, reference.compute(q.month, mode, source).get(row.code).gap);
    }
  } finally { s.store.close(); }
});

test('trusted quantity overlays preserve raw preprocessing validation without rebuilding the BOM', () => {
  const data = C.sample(); data.config.input_mode = 'raw'; const r = data.tables.forecast[0]; data.tables.adjust = [{ code: r.code, direction: '使用', month: r.month, qty: 10 }];
  assert.throws(() => changesFor(data, { changes: [{ code: r.code, month: r.month, operation: 'set', value: 5 }] }, r.plan_date, true), /使用剔除/);
  const validate = C.validate; C.validate = () => { throw Error('unnecessary structural validation'); };
  try { const next = changesFor(data, { changes: [{ code: r.code, month: r.month, operation: 'add', value: 1 }] }, r.plan_date, true); assert.equal(next.tables.bom, data.tables.bom); assert.notEqual(next.tables.forecast, data.tables.forecast); } finally { C.validate = validate; }
});

test('table reads remain pinned to requested revision after baseline changes', () => {
  const s = setup(); try { const first = s.table({ table: 'forecast', revision: 1 }); const data = C.sample(); data.tables.forecast = data.tables.forecast.map(r => ({ ...r, qty: r.qty * 2 })); s.publish(data, 1, 'test', 'test'); assert.deepEqual(s.table({ table: 'forecast', revision: 1 }), first); assert.equal(s.table({ table: 'forecast', revision: 2 }).rows[0].qty, first.rows[0].qty * 2); } finally { s.store.close(); }
});

test('insight top-ten contributors never change full demand and unknown months remain explicit', () => {
  const data = C.empty(); data.kind = 'imported';
  for (let i = 0; i < 12; i++) {
    const code = 'UP' + i;
    data.tables.bom.push({ parent: code, child: 'LOW', qty: 1 });
    data.tables.attributes.push({ code, make_dept: 'D', lead_mean: 2, lead_cv: .1 });
    for (const month of ['2026-09', '2026-11']) data.tables.forecast.push({ code, plan_date: '2026-09-01', month, qty: 1, site_code: 'S' });
  }
  data.tables.attributes.push({ code: 'LOW', make_dept: 'D', lead_mean: 2, lead_cv: .1 }); data.tables.industry.push({ make_dept: 'D', is_local: false });
  for (const month of ['2026-09', '2026-11']) data.tables.forecast.push({ code: 'LOW', plan_date: '2026-09-01', month, qty: 10, site_code: 'S' });
  const s = setup(data); try { const r = s.insights({ code: 'LOW', month: '2026-09', span: 4 }, 'test'); assert.equal(r.demandContributors.total, 12); assert.equal(r.demandContributors.rows.length, 10); assert.equal(r.demandContributors.knownContribution, 12); assert.equal(r.demandContributors.truncated, true); assert.equal(r.horizon.complete, false); const missing = r.facts.find(f => f.id === 'horizon_unknown'); assert.deepEqual(missing.evidence.incompleteMonths, ['2026-10']); assert.equal(missing.evidence.beyondAvailableMonths, 1); } finally { s.store.close(); }
});
