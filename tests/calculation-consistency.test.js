'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../forecast-core'), Engine = require('../server/engine'), { Service } = require('../server/service');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { buildSnapshot, Artifact } = require('../server/artifact');
const month = '2026-09', version = '2026-09-24';
function data(nodes, edges) {
  const s = C.empty();
  for (const [code, dept, qty] of nodes) {
    if (dept !== null) s.tables.attributes.push({ code, make_dept: dept, lead_mean: 1 });
    if (qty !== null) s.tables.forecast.push({ code, qty, month, plan_date: version, site_code: 'S' });
  }
  edges.forEach(([parent, child, qty = 1], i) => s.tables.bom.push({ id: String(i), parent, child, qty, parent_template: 'AI', child_template: 'AI' }));
  return s;
}
function service(engine) {
  const s = Object.create(Service.prototype);
  s.context = q => ({ engine, month: q.month || month, mode: q.mode, source: q.source || 'forecast', trace: { revision: 0, version } });
  return s;
}
function check(s, mode, expected) {
  const shared = new C.Engine(s), e = new Engine(s), svc = service(e), q = { summary: 1, code: 'C', mode, month };
  const res = svc.list(q, 'test'), row = res.rows[0];
  for (const r of [shared.compute(month, mode).get('C'), e.row('C', month, mode), row]) {
    assert.deepEqual([r.demand, r.gap, !!r.partial], expected);
  }
  assert.equal(res.dashboard.incomplete, Number(!row.complete && !row.passThrough));
  assert.equal(res.dashboard.shortage, Number(row.gap > C.EPS));
  assert.equal(svc.list({ ...q, risk: 'incomplete' }, 'test').total, res.dashboard.incomplete);
  assert.equal(svc.list({ ...q, risk: 'shortage' }, 'test').total, res.dashboard.shortage);
  if (row.demand != null) assert.equal(row.targets.reduce((sum, t) => sum + (t.demand || 0), 0), row.demand);
}
test('same-industry roots and missing direct forecasts use one calculation for graph, table, KPI and filters', () => {
  const s = data([['A', 'X', 100], ['B', 'X', null], ['C', 'X', 50]], [['A', 'B'], ['B', 'C']]);
  check(s, 'direct', [0, -50, false]);
  check(s, 'cross', [100, 50, false]);
  check(s, 'top', [100, 50, false]);
});
test('an unknown boundary followed by the original industry agrees with the resolved frontier', () => {
  const s = data([['D', 'Z', 200], ['A', 'X', 100], ['B', 'Y', null], ['C', 'X', 50]], [['D', 'A'], ['A', 'B'], ['B', 'C']]);
  check(s, 'cross', [200, 150, false]);
});
test('known zero plus an unknown branch computes the known part; all unknown stays unknown', () => {
  const s = data([['D', 'Z', null], ['B', 'X', null], ['P', 'Y', 0], ['C', 'X', 50]], [['D', 'B'], ['B', 'C'], ['P', 'C']]);
  for (const mode of ['cross', 'top']) check(s, mode, [0, -50, true]);
  s.tables.forecast = s.tables.forecast.filter(r => r.code !== 'P');
  for (const mode of ['cross', 'top']) check(s, mode, [null, null, false]);
});
test('another month record does not convert the selected month missing root into known zero', () => {
  const s = data([['A', 'Y', null], ['C', 'X', 50]], [['A', 'C']]);
  s.tables.forecast.push({ code: 'A', qty: 100, month: '2026-10', plan_date: version, site_code: 'S' });
  for (const mode of ['cross', 'top']) check(s, mode, [null, null, false]);
});
test('each month resolves its own frontier and source union records inactive contributions as zero', () => {
  const s = data([['A', 'X', 100], ['B', 'X', null], ['C', 'Y', 50]], [['A', 'B'], ['B', 'C']]);
  for (const [code, qty] of [['A', 200], ['B', 80], ['C', 50]]) s.tables.forecast.push({ code, qty, month: '2026-10', plan_date: version, site_code: 'S' });
  const svc = service(new Engine(s)), q = { summary: 1, code: 'C', mode: 'cross', month, span: 2 };
  const r = svc.list(q, 'test').rows[0];
  assert.deepEqual(r.periods.map(p => p.demand), [100, 80]);
  assert.equal(r.periods[1].demand, svc.list({ ...q, month: '2026-10', span: 1 }, 'test').rows[0].demand);
  assert.equal(svc.list({ ...q, periodMode: 'cumulative' }, 'test').rows[0].demand, 180);
  assert.deepEqual(r.targets.find(t => t.code === 'A').monthly.map(m => m.demand), [100, 0]);
  assert.deepEqual(r.targets.find(t => t.code === 'B').monthly.map(m => m.demand), [0, 80]);
});
test('cached graph, summary and KPI refresh inventory on the next query after midnight', () => {
  const now = Date.now;
  try {
    Date.now = () => Date.parse('2026-10-23T15:59:00Z');
    const s = data([['A', 'Y', 100], ['C', 'X', 50]], [['A', 'C']]);
    s.tables.inventory.push({ code: 'C', date: '2026-10-23', qty: 10 }, { code: 'C', date: '2026-10-24', qty: 60 });
    const e = new Engine(s), svc = service(e), q = { summary: 1, code: 'C', mode: 'cross', month };
    assert.equal(svc.list(q, 'test').rows[0].coverageGap, 40);
    Date.now = () => Date.parse('2026-10-23T16:01:00Z');
    const res = svc.list(q, 'test');
    assert.equal(res.rows[0].inventory, 60); assert.equal(res.rows[0].coverageGap, -10);
    assert.equal(res.dashboard.coverageShortage, 0); assert.equal(e.row('C', month, 'cross').inventory, 60);
  } finally { Date.now = now; }
});

test('offline matrices retain known-zero plus missing-source flags without online recalculation', () => {
  const s = data([['D', 'Z', null], ['B', 'X', null], ['P', 'Y', 0], ['C', 'X', 50]], [['D', 'B'], ['B', 'C'], ['P', 'C']]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'supply-flags-')), 'data.supply');
  buildSnapshot(s, file); const artifact = new Artifact(file);
  try {
    const e = Engine.restore(artifact.load(), version, artifact);
    e.compute = () => { throw Error('full-network hydration is not required'); };
    for (const mode of ['cross', 'top']) {
      const r = e.row('C', month, mode);
      assert.deepEqual([r.demand, r.gap, r.partial, r.complete], [0, -50, true, true]);
      assert.equal(e.matrix(month, mode)[e.orderIndex.get('C') * 2 + 1], 3);
    }
  } finally { artifact.close(); }
});
