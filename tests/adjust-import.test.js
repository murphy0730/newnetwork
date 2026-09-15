'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const C = require('../forecast-core'), I = require('../server/importer'), D = require('../server/demo-data');
const { run } = require('../server/build'), { Artifact, buildSnapshot } = require('../server/artifact'), { Service } = require('../server/service');

test('template adjustments survive import and restoration: net skips application, raw applies without reimport', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'table2-repro-')), file = path.join(dir, 'templates.xlsx'), db = path.join(dir, 'test.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(file, I.workbook(C.empty(), true));
  const net = await run({ files: [{ path: file }], output: path.join(dir, 'net.supply') });
  let service = new Service(db);
  try { service.store.activate(net.path, 0, 'test'); } finally { service.store.close(); }
  const read = () => { const s = new Service(db); try { const month = s.meta('test').months[0]; return { config: s.meta('test').config, stored: s.table({ table: 'adjust' }).rows, rows: s.list({ summary: 1, role: 'supply', source: 'forecast', mode: 'direct', month }, 'test').rows }; } finally { s.store.close(); } };
  const before = read(); assert.equal(before.stored.length, 3); assert.equal(before.config.input_mode, 'net');
  assert.ok(before.rows.every(r => r.add === 0 && r.remove === 0));
  assert.ok(net.warnings.some(w => w.includes('表2不再重复应用')));
  const raw = await run({ operation: 'config', base: { dbPath: db }, body: { config: { ...before.config, input_mode: 'raw' } }, output: path.join(dir, 'raw.supply') });
  service = new Service(db); try { service.store.activate(raw.path, 1, 'test', 'config'); } finally { service.store.close(); }
  const after = read(); assert.deepEqual(after.stored, before.stored);
  const pick = code => after.rows.find(r => r.code === code);
  assert.equal(pick('DEMO-001').add, 10); assert.equal(pick('DEMO-001').supply, 110);
  assert.equal(pick('DEMO-002').remove, 20); assert.equal(pick('DEMO-002').supply, 250);
  assert.equal(pick('DEMO-003').add, 30); assert.equal(pick('DEMO-003').supply, 830);
  assert.equal(before.rows.find(r => r.code === 'DEMO-003').demand, 850);
  assert.equal(pick('DEMO-003').demand, 790);
  t.diagnostic(JSON.stringify({ storedAdjustRows: before.stored.length, before: before.rows.map(r => ({ code: r.code, add: r.add, remove: r.remove, supply: r.supply, demand: r.demand })), after: after.rows.map(r => ({ code: r.code, add: r.add, remove: r.remove, supply: r.supply, demand: r.demand })) }));
});

test('first template import over demo data preserves the selected raw input mode', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'table2-demo-repro-')), seed = D.demo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  seed.config = { input_mode: 'raw', concentration: .85, cv_threshold: .4 };
  const seedFile = path.join(dir, 'seed.supply'); buildSnapshot(seed, seedFile);
  const file = path.join(dir, 'templates.xlsx'); fs.writeFileSync(file, I.workbook(C.empty(), true));
  const result = await run({ base: { artifact: seedFile }, files: [{ path: file }], output: path.join(dir, 'imported.supply') });
  const artifact = new Artifact(result.path);
  try {
    assert.deepEqual(artifact.manifest.config, seed.config);
    const loaded = artifact.load(); assert.equal(loaded.tables.attributes.length, 3);
    assert.equal(new C.Engine(loaded).net('DEMO-001', loaded.tables.forecast[0].month).add, 10);
  } finally { artifact.close(); }
});

test('preserved raw mode validates excessive removal; direct preview and commit retain mode as well', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'table2-raw-')), service = new Service(path.join(dir, 'test.sqlite'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seed = D.demo(); seed.config.input_mode = 'raw';
  try {
    service.publish(seed, 0, 'test', 'sample');
    const template = D.templateSample(), batches = Object.entries(template.tables).map(([table, rows]) => ({ table, rows }));
    const body = { baseRevision: 1, batches };
    template.tables.adjust.find(r => r.direction === '使用').qty = 99999;
    assert.throws(() => service.preview(body, 'test'), /关联校验失败/);
    await assert.rejects(run({ base: { dbPath: service.store.path }, body, output: path.join(dir, 'invalid.supply') }), e => e.details.some(r => r.message.includes('剔除量大于')));
    template.tables.adjust.find(r => r.direction === '使用').qty = 20;
    const preview = service.preview(body, 'test'); service.commit({ previewId: preview.previewId }, 'test');
    assert.equal(service.meta('test').config.input_mode, 'raw');
    const month = template.tables.forecast[0].month;
    assert.equal(service.list({ summary: 1, month, mode: 'direct', code: 'DEMO-002' }, 'test').rows[0].remove, 20);
  } finally { service.store.close(); }
});

for (const format of ['xlsx', 'csv']) test(`standalone table2 ${format} import applies to existing forecasts and repeated import does not double quantities`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'table2-single-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seed = D.templateSample(), month = seed.tables.forecast[0].month;
  seed.kind = 'imported'; seed.config.input_mode = 'raw'; seed.tables.adjust = [];
  const seedFile = path.join(dir, 'seed.supply'); buildSnapshot(seed, seedFile);
  const file = path.join(dir, 'adjust.' + format);
  if (format === 'xlsx') fs.writeFileSync(file, I.workbook(C.empty(), true, 'adjust'));
  else fs.writeFileSync(file, '\uFEFFcode,purchase_code,direction,' + month + '\r\nDEMO-001,BUY-001,供应,10\r\nDEMO-002,,使用,20\r\nDEMO-003,BUY-003,供应,30\r\n', 'utf8');
  let base = seedFile;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await run({ base: { artifact: base }, files: [{ path: file }], output: path.join(dir, `import-${attempt}.supply`) });
    const artifact = new Artifact(result.path);
    try {
      const loaded = artifact.load();
      assert.equal(loaded.config.input_mode, 'raw');
      assert.equal(loaded.tables.adjust.length, 3);
      for (const table of ['forecast', 'bom', 'attributes', 'inventory', 'mo']) assert.deepEqual(loaded.tables[table], seed.tables[table]);
    } finally { artifact.close(); }
    const service = new Service(path.join(dir, `test-${attempt}.sqlite`));
    try {
      service.store.activate(result.path, 0, 'test');
      for (const mode of ['direct', 'cross', 'top']) {
        const rows = service.list({ summary: 1, role: 'supply', source: 'forecast', mode, month }, 'test').rows;
        assert.equal(rows.find(r => r.code === 'DEMO-001').add, 10);
        assert.equal(rows.find(r => r.code === 'DEMO-002').remove, 20);
        assert.equal(rows.find(r => r.code === 'DEMO-003').supply, 830);
        if (mode === 'direct') assert.equal(rows.find(r => r.code === 'DEMO-003').demand, 790);
      }
    } finally { service.store.close(); }
    base = result.path;
  }
});
