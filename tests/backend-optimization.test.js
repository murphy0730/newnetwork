'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const C = require('../forecast-core'), Engine = require('../server/engine');
const { Service, changesFor } = require('../server/service');
const Importer = require('../server/importer');

test('server numeric matrices and sparse rows match shared engine across modes, sources and incomplete data', () => {
  for (const sample of [C.sample(), C.sampleLarge()]) for (const raw of [false, true]) {
    const month = sample.tables.forecast[0].month, code = sample.tables.forecast[0].code;
    const data = C.copy(sample);
    if (raw) { data.config.input_mode = 'raw'; data.tables.adjust = [{ direction: '供应', code, month, qty: 10, purchase_code: 'PO' }, { direction: '使用', code, month, qty: 5 }]; }
    data.tables.mo = [{ mo_no: 'M1', code, qty: 123, due_date: month + '-10', site_code: 'S9' }];
    const ref = new C.Engine(data), e = new Engine(data);
    e.precompute(); assert.equal(e.monthCache.size, 0);
    for (const m of e.months) for (const mode of ['direct', 'cross', 'top']) for (const source of ['forecast', 'mo']) {
      const expected = ref.compute(m, mode, source);
      for (const c of e.graph.codes) assert.deepEqual(e.row(c, m, mode, source), expected.get(c));
    }
    for (const mode of ['direct', 'cross', 'top']) {
      assert.deepEqual(e.cumulative(code, month, 3, mode), ref.cumulative(code, month, 3, mode));
      const actual = e.paths(code, month, mode), expected = ref.paths(code, month, mode);
      assert.deepEqual(actual.critical, expected.critical); assert.deepEqual(new Set(actual.riskNodes), new Set(expected.riskNodes));
      assert.deepEqual(new Set(actual.edges.map(r => JSON.stringify(r))), new Set(expected.edges.map(r => JSON.stringify(r))));
    }
  }
});

test('import budgets reject excessive columns and malformed API rows before normalization', () => {
  assert.throws(() => Importer.parseCSV(Array(201).fill('x').join(',')), /200列/);
  assert.throws(() => Importer.publicRows('forecast', [null]), /数据行/);
  assert.throws(() => Importer.publicRows('forecast', [Object.fromEntries(Array.from({ length: 201 }, (_, i) => ['col' + i, 'x']))]), /200列/);
});

test('failed commit rolls back records, revision and candidate metadata; indexed pagination matches stored data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-atomic-')), s = new Service(path.join(dir, 'test.sqlite'));
  try {
    s.sample({ baseRevision: 0 }, 'test'); const before = s.state(), candidate = C.copy(before);
    s.store.db.exec("CREATE TRIGGER reject_record BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT,'test rollback'); END");
    assert.throws(() => s.store.save(candidate, 1, 'test', 'test'), /rollback/);
    assert.equal(s.store.revision(), 1); assert.deepEqual(candidate, before);
    const page = s.table({ table: 'forecast', code: 'A', offset: 2, limit: 3 });
    const expected = before.tables.forecast.filter(r => r.code === 'A');
    assert.equal(page.total, expected.length); assert.deepEqual(page.rows, expected.slice(2, 5));
    s.store.db.exec('DROP TRIGGER reject_record');
    const restored = new Service(path.join(dir, 'test.sqlite'));
    assert.equal(restored.engine().precomputed.restored, true);
    assert.equal(restored.engine().row('A', restored.engine().months[0]).gap, 100);
    restored.store.db.close();
  } finally { s.store.db.close(); }
});

test('indexed batch changes preserve sequential site/global operations, zero distribution and other versions', () => {
  const s = C.sample(), version = s.tables.forecast[0].plan_date, month = s.tables.forecast[0].month;
  s.tables.forecast.push({ code: 'D', month, plan_date: '2025-01-01', qty: 999 });
  const before = C.copy(s), changed = changesFor(s, { changes: [
    { code: 'D', month, operation: 'add', value: 550 },
    { code: 'D', month, site_code: 'S4', operation: 'set', value: 0 },
    { code: 'D', month, site_code: 'S5', operation: 'percent', value: 50 }
  ] }, version);
  assert.deepEqual(s, before);
  assert.equal(changed.tables.forecast.find(r => r.code === 'D' && r.month === month && r.site_code === 'S4').qty, 0);
  assert.equal(changed.tables.forecast.find(r => r.code === 'D' && r.month === month && r.site_code === 'S5').qty, 90);
  assert.equal(changed.tables.forecast.at(-1).qty, 999);
  const zero = changesFor(changed, { changes: [{ code: 'D', month, site_code: 'S4', operation: 'add', value: 7 }] }, version);
  assert.equal(zero.tables.forecast.find(r => r.code === 'D' && r.month === month && r.site_code === 'S4').qty, 7);
});

test('detail reads precomputed single-code rows without full-network hydration; scenario reopen reuses untouched months', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-opt-')), db = path.join(dir, 'test.sqlite'), s = new Service(db), actor = 'test';
  try {
    s.sample({ baseRevision: 0 }, actor); const e = s.engine(), month = e.months[0], version = e.version;
    e.compute = () => { throw Error('full hydration must not run for detail'); };
    assert.equal(s.detail({ code: 'A', month, version }, actor).gap, 100);
    delete e.compute;
    const sim = s.simulate({ version, month, changes: [{ code: 'A', month, operation: 'add', value: 200 }] }, actor);
    s.engines.clear(); const baseline = s.engine({ version });
    const reopened = s.engine({ scenario: sim.id }, actor);
    assert.equal(reopened.materialized.get(JSON.stringify([e.months[1], 'cross', 'forecast'])), baseline.materialized.get(JSON.stringify([e.months[1], 'cross', 'forecast'])));
    assert.equal(reopened.row('A', month, 'cross').gap, -100);
    assert.equal(baseline.row('A', month, 'cross').gap, 100);
    assert.throws(() => s.engine({ scenario: sim.id }, 'stranger'), /无权/);
  } finally { s.store.db.close(); }
});
