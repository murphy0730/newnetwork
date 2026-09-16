'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const C = require('../forecast-core'), D = require('../server/demo-data'), I = require('../server/importer'), XLSX = require('../vendor/xlsx');
const { Service } = require('../server/service'), { run } = require('../server/build');

function decode(bytes) {
  const snapshot = C.empty();
  for (const sheet of I.readFile('sample.xlsx', bytes)) {
    if (!sheet.detected) continue;
    const { table, headerRow } = sheet.detected;
    const parsed = C.parseMatrix(table, sheet.matrix, { headerRow });
    assert.deepEqual(parsed.errors, [], table);
    snapshot.tables[table] = parsed.rows;
  }
  return snapshot;
}
function scale(snapshot) {
  const g = C.topology(snapshot.tables);
  assert.equal(g.codes.length, 1004); assert.equal(Math.max(...g.level.values()) + 1, 7);
  // 真实 DAG 特征：大量编码跨多层级归属（minLevel ≠ maxLevel，同一编码被不同层级的父项引用）
  let multi = 0; for (const c of g.codes) if (g.minLevel.get(c) < g.level.get(c)) multi++;
  assert.ok(multi > g.codes.length * 0.5, `multiLevel 占比应超过 50%，实际 ${(multi / g.codes.length * 100).toFixed(1)}%`);
  assert.equal(new Set(snapshot.tables.attributes.map(r => r.make_dept)).size, 12);
  assert.equal(new Set(snapshot.tables.forecast.map(r => r.site_code)).size, 58);
  assert.deepEqual(C.validate(snapshot).errors, []);
}

test('demo has 1004 codes with true DAG BOM (75% multi-level), twelve industries and seven BOM levels across loading and export', async () => {
  scale(D.demo());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-test-')), service = new Service(path.join(dir, 'test.sqlite'));
  try {
    service.sampleLarge({ baseRevision: 0 }, 'test'); scale(service.state());
    const exported = decode(service.export({ kind: 'sample' })); scale(exported);
    const e = new C.Engine(exported);
    assert.equal(e.months.length, 11);
    for (const mode of ['direct', 'cross', 'top']) assert.equal(e.compute(e.months[0], mode).size, 1004);
    const build = await run({ operation: 'sampleLarge', output: path.join(dir, 'demo.supply') });
    assert.equal(build.manifest.codes, 1004); assert.equal(build.manifest.counts.attributes, 1004);
  } finally { service.store.close(); }
});

test('each standalone template contains exactly three valid examples and a guide; all templates import together', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-test-')), files = [];
  for (const table of Object.keys(C.schemas)) {
    const bytes = I.workbook(C.empty(), true, table), wb = XLSX.read(bytes, { type: 'buffer' });
    assert.deepEqual(wb.SheetNames, [table, '填写说明']);
    const snapshot = decode(bytes); assert.equal(snapshot.tables[table].length, 3, table);
    const filename = path.join(dir, table + '.xlsx'); fs.writeFileSync(filename, bytes); files.push({ path: filename });
  }
  const all = decode(I.workbook(C.empty(), true));
  for (const table of Object.keys(C.schemas)) assert.equal(all.tables[table].length, 3, table);
  assert.deepEqual(C.validate(all).errors, []);
  const imported = await run({ files, output: path.join(dir, 'templates.supply') });
  assert.equal(imported.manifest.codes, 3);
  for (const table of Object.keys(C.schemas)) assert.equal(imported.manifest.counts[table], 3, table);
  assert.throws(() => I.workbook(C.empty(), true, '__proto__'), /表名无效/);
});
