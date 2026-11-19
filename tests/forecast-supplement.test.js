'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const C = require('../forecast-core'), Engine = require('../server/engine'), I = require('../server/importer'), Stream = require('../server/import-stream');
const { Artifact, buildSnapshot } = require('../server/artifact'), { run } = require('../server/build'), { Service } = require('../server/service');
const XLSX = require('../vendor/xlsx');
const version = '2026-10-26', month = '2026-10';
const directory = () => { const parent = path.join(__dirname, '../test-output'); fs.mkdirSync(parent, { recursive: true }); return fs.mkdtempSync(path.join(parent, 'forecast-supplement-')); };
function supplement(s, table, code, values, make_dept = '', plan_date = version) { s.tables['forecastSupplement' + table].push({ code, plan_date, make_dept, ...values }); }
function forecast(s, code, qty, m = month) { s.tables.forecast.push({ code, qty, month: m, plan_date: version, site_code: 'S' }); }
function fixture() {
  const s = C.empty();
  s.tables.attributes.push({ code: 'A', make_dept: '整机' }, { code: 'C', make_dept: '材料', part_category: '材料类' });
  s.tables.bom.push({ parent: 'A', child: 'B', qty: 2, parent_template: 'AI', child_template: 'AI' }, { parent: 'B', child: 'C', qty: 3, parent_template: 'AI', child_template: 'AI' });
  forecast(s, 'A', 100); forecast(s, 'C', 50);
  supplement(s, 1, 'B', { m1: 30, m2: 40 }, '模组');
  supplement(s, 2, 'B', { m1: 999, m2: 999 }, '后备部门');
  s.tables.adjust.push({ direction: '供应', code: 'B', purchase_code: 'BUY', month, qty: 5 }, { direction: '使用', code: 'B', purchase_code: '', month, qty: 4 });
  s.tables.inventory.push({ code: 'B', date: '2020-01-01', qty: 7 });
  return s;
}

test('supplement schemas preserve text codes, explicit zero and blanks; malformed numbers/dates are rejected', () => {
  const api = require('../server/openapi').createOpenAPI();
  assert.deepEqual(api.paths['/api/import/preview'].post.requestBody.content['application/json'].schema.properties.batches.items.properties.table.enum, Object.keys(C.schemas));
  assert.ok(api.paths['/api/jobs/{id}/issues'].get.parameters.find(p => p.name === 'table').schema.enum.includes('forecastSupplement2'));
  const matrix = [['item_code', 'plantdate', 'make_dept', 'm1', 'm2', 'm18', '备注'], ['00301', version, '部门', 0, '', 18, '原始备注']];
  const parsed = C.parseMatrix('forecastSupplement1', matrix);
  assert.deepEqual(parsed.errors, []); assert.equal(parsed.rows[0].code, '00301');
  assert.equal(parsed.rows[0].m1, 0); assert.equal(parsed.rows[0].m2, null); assert.equal(parsed.rows[0]._extra['备注'], '原始备注');
  assert.equal(C.detect(matrix), null, 'identical schemas must not guess a source');
  assert.equal(C.detect(matrix, ['预测表-补充1.xlsx']).table, 'forecastSupplement1');
  assert.equal(C.detect(matrix, ['预测表-补充2', '预测表-补充1.xlsx']).table, 'forecastSupplement2', 'sheet name precedes file name');
  assert.ok(C.parseMatrix('forecastSupplement1', [matrix[0], ['A', '2026-02-30', '', -1, 'bad']]).errors.length >= 3);
  assert.match(C.parseMatrix('forecastSupplement1', [['item_code', 'plantdate'], ['A', version]]).errors[0].message, /m1～m18/);
});

test('fallback is per version/code/month; zero blocks lower sources and same-source rows aggregate', () => {
  const s = C.empty(); forecast(s, 'A', 0); forecast(s, 'MULTI', 2); forecast(s, 'MULTI', 3);
  supplement(s, 1, 'A', { m1: 100, m2: 0, m3: null, m18: 18 });
  supplement(s, 1, 'MULTI', { m1: 999 });
  supplement(s, 1, 'SUM', { m1: 2 }); supplement(s, 1, 'SUM', { m1: 3 });
  supplement(s, 2, 'SUM', { m1: 100 });
  supplement(s, 2, 'A', { m1: 200, m2: 200, m3: 237 });
  supplement(s, 1, 'ONLY-OTHER-VERSION', { m1: 1000 }, '', '2026-10-27');
  const e = new C.Engine(s, version);
  assert.equal(e.net('A', month).raw, 0); assert.equal(e.net('MULTI', month).raw, 5); assert.equal(e.net('SUM', month).raw, 5);
  assert.equal(e.net('A', '2026-11').raw, 0); assert.equal(e.net('A', '2026-11').known, true);
  assert.equal(e.net('A', '2026-12').raw, 237); assert.equal(e.net('A', '2027-01').known, false);
  assert.equal(e.net('A', '2028-03').raw, 18); assert.equal(e.months.length, 18);
  assert.equal(e.net('ONLY-OTHER-VERSION', month).known, false);
});

test('an earlier supplement fills missing forecasts by production month in a newer table1 version', () => {
  const s = C.empty(), selected = '2026-11-16', november = '2026-11', code = '000123';
  s.tables.forecast.push({ code: 'P', plan_date: selected, month: november, qty: 1000 });
  s.tables.forecast.push({ code, plan_date: selected, month: '2026-12', qty: 0 });
  s.tables.bom.push({ parent: 'P', child: code, qty: 1, parent_template: 'AI', child_template: 'AI' });
  const parsed = C.parseMatrix('forecastSupplement1', [
    ['item_code', 'plantdate', 'm1', 'm2', 'm3', 'm4'],
    [code, '2026-10-26T00:00', 357, 893.4286, 845.7142857, 50],
    [code, '2026-10-25', 360, 900, 840, 80],
    [code, '2026-11-15', '', 500, 0, ''],
    [code, '2026-11-17', 888, 300, 100, 200]
  ]);
  assert.deepEqual(parsed.errors, []);
  s.tables.forecastSupplement1 = parsed.rows;
  supplement(s, 2, code, { m1: 999, m3: 999 }, '', selected);
  const root = directory(), service = new Service(path.join(root, 'test.sqlite'));
  try {
    service.publish(s, 0, 'test', 'fixture');
    const q = { version: selected, month: november, mode: 'direct', code, summary: 1 };
    const { months, rows: [row] } = service.list(q, 'test');
    assert.equal(months[0], november, 'an older supplement must not shift the start month back');
    assert.equal(row.periods[0].raw, 893.4286);
    assert.equal(row.gap, 1000 - 893.4286);
    const source = service.detail(q, 'test').sources[0];
    assert.deepEqual([source.forecastTable, source.forecastDate, source.qty], ['forecastSupplement1', '2026-10-26', 893.4286]);
    for (const [month, forecastTable] of [['2026-12', 'forecast'], ['2027-01', 'forecastSupplement1']]) {
      const detail = service.detail({ ...q, month }, 'test');
      assert.equal(detail.raw, 0); assert.equal(detail.sources[0].forecastTable, forecastTable);
    }
  } finally { service.store.close(); }
});

test('supplement raw forecasts always apply table2, while table1 follows its selected input mode', () => {
  const s = fixture();
  s.tables.adjust.push({ direction: '供应', code: 'C', purchase_code: 'BUY-C', month, qty: 8 });
  let e = new Engine(s, version);
  assert.deepEqual([e.net('B', month).raw, e.net('B', month).supply, e.net('B', month).demand], [30, 35, 26]);
  assert.equal(e.net('C', month).supply, 50, 'net table1 bypasses table2');
  assert.equal(e.periodAdds.get('B'), 5); assert.equal(e.periodAdds.has('C'), false);
  assert.equal(e.net('B', month).sites.unassigned, 35, 'missing processing sites stay unknown');
  forecast(s, 'B', 0); e = new Engine(s, version);
  assert.equal(e.net('B', month).supply, 0); assert.equal(e.net('B', month).remove, 0, 'table1 zero blocks raw supplement');
  s.config.input_mode = 'raw'; e = new Engine(s, version);
  assert.equal(e.net('B', month).supply, 5); assert.equal(e.net('B', month).demand, -4); assert.equal(e.net('C', month).supply, 58);
});

test('department fallback uses the selected version and nonempty table6, supplement1, supplement2 in order', () => {
  const s = fixture(); s.tables.attributes.push({ code: 'B', make_dept: '  ', lead_mean: 5 });
  supplement(s, 1, 'D', { m1: 1 }, ' '); supplement(s, 2, 'D', { m1: 2 }, '备选');
  supplement(s, 1, 'UNKNOWN', { m1: 0 }, ''); supplement(s, 2, 'UNKNOWN', { m1: 0 }, '');
  supplement(s, 1, 'C', { m1: 100 }, '不应覆盖材料');
  supplement(s, 1, 'B', { m1: 80 }, '旧版部门', '2026-10-25');
  const before = C.copy(s), e = new Engine(s, version);
  assert.equal(e.dept('B'), '模组'); assert.equal(e.attributes.get('B').lead_mean, 5); assert.equal(e.dept('C'), '材料');
  assert.equal(e.dept('D'), '备选'); assert.equal(e.dept('UNKNOWN'), '未知部门');
  assert.equal(new Engine(s, '2026-10-25').dept('B'), '旧版部门'); assert.deepEqual(s, before, 'raw tables remain unchanged');
});

test('supplement forecast and department change BOM frontiers, demand and balances consistently', () => {
  const s = fixture();
  for (const E of [C.Engine, Engine]) {
    const e = new E(s, version);
    for (const mode of ['direct', 'cross']) {
      assert.deepEqual(e.relations('C', mode, month, true).map(r => r.code), ['B']);
      const r = e.row('C', month, mode); assert.deepEqual([r.demand, r.supply, r.gap], [78, 50, 28]);
    }
    assert.equal(e.row('C', month, 'top').demand, 600);
    assert.deepEqual([e.row('B', month, 'cross').demand, e.row('B', month, 'cross').gap, e.row('B', month, 'cross').coverageGap], [200, 169, 162]);
    s.tables.forecast.push({ code: 'B', qty: 0, month, plan_date: version });
    const zero = new E(s, version); assert.equal(zero.row('C', month, 'cross').demand, 0);
    s.tables.forecast.pop();
  }
});

test('scope retains supplement codes and inventory without table6, including overlapping table1 rows', () => {
  const s = fixture(); forecast(s, 'B', 0); forecast(s, 'OUT', 99); s.tables.inventory.push({ code: 'OUT', date: '2020-01-01', qty: 9 });
  const scope = C.scopeTables(s.tables);
  assert.equal(scope.range, 3); assert.ok(s.tables.forecast.some(r => r.code === 'B')); assert.ok(!s.tables.forecast.some(r => r.code === 'OUT'));
  assert.deepEqual(s.tables.inventory.map(r => r.code), ['B']); assert.equal(s.tables.bom.length, 2);
  assert.equal(new Engine(s, version).net('B', month).raw, 0);
});

test('CSV/Excel auto-detection, preview, templates and independent version replacement support both supplements', async () => {
  const root = directory(), files = [];
  for (const i of [1, 2]) {
    const file = path.join(root, `预测表-补充${i}.csv`); fs.writeFileSync(file, `item_code,plantdate,make_dept,m1,m2\n0001,${version},部门${i},${i},\n`); files.push({ path: file });
    assert.equal((await Stream.inspect(file, path.basename(file)))[0].detected.table, 'forecastSupplement' + i);
  }
  const csv = await Stream.readInputs(files); assert.deepEqual(csv.batches.map(b => b.table), C.supplementTables);
  const wb = XLSX.utils.book_new();
  for (const i of [1, 2]) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['item_code', 'plantdate', 'm1'], ['0002', version, i]]), `预测表-补充${i}`);
  const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), file = path.join(root, 'both.xlsx'); fs.writeFileSync(file, bytes);
  assert.deepEqual(I.readFile('both.xlsx', bytes).map(s => s.detected.table), C.supplementTables);
  assert.deepEqual((await Stream.readInputs([{ path: file }])).batches.map(b => b.table), C.supplementTables);
  for (const table of C.supplementTables) {
    const template = I.readFile(table + '.xlsx', I.workbook(C.empty(), true, table)).find(s => s.detected);
    assert.equal(template.detected.table, table); assert.equal(C.parseMatrix(table, template.matrix).rows.length, 3);
  }
  const s = fixture(); s.kind = 'imported'; supplement(s, 1, 'OLD', { m1: 9 }, '', '2026-09-26');
  const batch = [{ table: 'forecastSupplement1', rows: [{ code: 'NEW', plan_date: version, m1: 1 }] }];
  for (const next of [Stream.merge(s, batch), C.prepare(s, batch).next]) {
    assert.deepEqual(next.tables.forecastSupplement1.map(r => r.code), ['OLD', 'NEW']); assert.equal(next.tables.forecastSupplement2[0].code, 'B');
  }
});

test('build/import/restore and service filters use supplement-only versions and preserve source provenance', async () => {
  const root = directory(), s = fixture(), output = path.join(root, 'test.supply');
  s.tables.forecast = []; supplement(s, 1, 'A', { m1: 100 }, '整机'); supplement(s, 2, 'C', { m1: 50 }, '材料');
  const result = await run({ output, body: { batches: Object.entries(s.tables).filter(([, rows]) => rows.length).map(([table, rows]) => ({ table, rows })) } });
  assert.deepEqual(result.manifest.versions, [version]); assert.equal(result.manifest.counts.forecast, 0); assert.ok(result.manifest.departments.includes('模组'));
  assert.equal(result.issues.preview.some(i => i.table === 'inventory' && i.code === 'B'), false, 'retained inventory is not reported as excluded');
  const artifact = new Artifact(output), service = new Service(path.join(root, 'test.sqlite'));
  try {
    const restored = Engine.restore(artifact.load(), version, artifact), fresh = new C.Engine(artifact.load(), version);
    for (const m of restored.months) for (const mode of ['direct', 'cross', 'top']) for (const source of ['forecast', 'mo']) {
      for (const code of restored.graph.codes) assert.deepEqual(restored.row(code, m, mode, source), fresh.row(code, m, mode, source));
    }
    service.store.activate(output, 0, 'test');
    assert.ok(service.meta('test').departments.includes('模组'));
    const q = { version, month, mode: 'cross', code: 'B', summary: 1 };
    const row = service.list({ ...q, industry: '模组', sourceIndustry: '整机' }, 'test').rows[0];
    assert.deepEqual([row.make_dept, row.raw, row.add, row.remove, row.inventory, row.gap], ['模组', 30, 5, 4, 7, 169]);
    assert.equal(service.detail(q, 'test').sources[0].forecastTable, 'forecastSupplement1');
  } finally { service.store.close(); artifact.close(); }
});

test('supplement predictions support independent quantity and quality scenarios without changing baseline or raw input mode', () => {
  const root = directory(), service = new Service(path.join(root, 'scenario.sqlite')), s = fixture();
  s.tables.forecastSupplement1 = [{ code: 'B', plan_date: '2026-09-26', make_dept: '模组', m2: 30, m3: 40 }];
  s.tables.forecastSupplement2 = [{ code: 'B', plan_date: '2026-09-26', make_dept: '后备部门', m2: 999, m3: 999 }];
  try {
    service.publish(s, 0, 'test', 'fixture');
    const body = { baseRevision: 1, version, month, code: 'B', mode: 'cross', source: 'forecast' };
    const sim = service.simulate({ ...body, type: 'forecast', changes: [{ code: 'B', month, operation: 'set', value: 60 }] }, 'test');
    const modified = service.engine({ scenario: sim.id }, 'test');
    assert.deepEqual([modified.net('B', month).raw, modified.net('B', month).supply, modified.net('B', month).demand], [60, 65, 56]);
    assert.equal(modified.row('C', month, 'cross').demand, 168);
    const quality = service.simulate({ ...body, type: 'quality', scrapQty: 10, delayDays: 0 }, 'test');
    assert.ok(Math.abs(service.engine({ scenario: quality.id }, 'test').net('B', month).raw - 20) < C.EPS);
    service.engines.clear(); assert.equal(service.engine({ scenario: sim.id }, 'test').net('B', month).supply, 65);
    assert.equal(service.engine({ version }).net('B', month).raw, 30); assert.equal(service.store.revision(), 1);
    assert.equal(service.state().tables.forecastSupplement1[0].m2, 30);
  } finally { service.store.close(); }
});

test('older artifacts without supplement sections can be loaded for explicit rebuilding', async () => {
  const { DatabaseSync } = require('node:sqlite'), root = directory(), old = path.join(root, 'old.supply');
  buildSnapshot(C.sample(), old);
  const db = new DatabaseSync(old), manifest = JSON.parse(db.prepare('SELECT data FROM manifest').get().data);
  for (const table of C.supplementTables) { delete manifest.counts[table]; db.prepare('DELETE FROM chunks WHERE section=?').run('table/' + table); }
  manifest.algorithm = 'old-rules'; db.prepare('UPDATE manifest SET data=?').run(JSON.stringify(manifest)); db.close();
  const result = await run({ operation: 'rebuild', base: { artifact: old }, output: path.join(root, 'rebuilt.supply') });
  assert.equal(result.manifest.codes, 4); assert.equal(result.manifest.counts.forecastSupplement1, 0); assert.equal(result.manifest.counts.forecastSupplement2, 0);
});
