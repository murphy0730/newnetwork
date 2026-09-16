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

test('demo table2 covers exactly 100 codes uniformly across actual BOM levels and applies after persisted loading', () => {
  const snapshot = D.demo(), graph = C.topology(snapshot.tables), adjustments = snapshot.tables.adjust;
  const selected = new Set(adjustments.map(r => r.code)), months = [...new Set(snapshot.tables.forecast.map(r => r.month))].sort();
  assert.equal(snapshot.config.input_mode, 'raw');
  assert.equal(selected.size, 100); assert.equal(adjustments.length, 100 * 11 * 2);
  const counts = new Map();
  for (const code of selected) counts.set(graph.level.get(code), (counts.get(graph.level.get(code)) || 0) + 1);
  assert.deepEqual([...counts].sort((a, b) => a[0] - b[0]).map(([level, count]) => [level + 1, count]), [[1, 15], [2, 15], [3, 14], [4, 14], [5, 14], [6, 14], [7, 14]]);
  const engine = new C.Engine(snapshot);
  for (const code of selected) for (const month of months) {
    const rows = adjustments.filter(r => r.code === code && r.month === month), net = engine.net(code, month);
    assert.equal(rows.length, 2);
    assert.ok(rows.find(r => r.direction === '供应').purchase_code);
    assert.equal(rows.find(r => r.direction === '使用').purchase_code, '');
    assert.ok(net.add > 0 && net.remove > 0 && net.remove <= net.raw);
    assert.equal(net.supply, net.raw + net.add); assert.equal(net.demand, net.raw - net.remove);
  }
  const exportedAdjustments = decode(I.workbook(snapshot)).tables.adjust;
  assert.equal(exportedAdjustments.length, adjustments.length);
  exportedAdjustments.forEach(({ _source, _extra, ...row }, i) => assert.deepEqual(row, adjustments[i]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-adjust-')), db = path.join(dir, 'test.sqlite');
  let service = new Service(db);
  try {
    service.sampleLarge({ baseRevision: 0 }, 'test'); service.store.close(); service = new Service(db);
    assert.equal(service.meta('test').config.input_mode, 'raw');
    assert.equal(service.table({ table: 'adjust' }).total, 2200);
    for (const mode of ['direct', 'cross', 'top']) {
      const rows = service.list({ summary: 1, role: 'supply', mode, month: months[0], codes: [...selected], limit: 1000 }, 'test').rows;
      assert.equal(rows.length, 100);
      for (const row of rows) {
        const net = engine.net(row.code, months[0]);
        assert.equal(row.add, net.add); assert.equal(row.remove, net.remove); assert.equal(row.supply, net.supply);
      }
    }
  } finally { service.store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
