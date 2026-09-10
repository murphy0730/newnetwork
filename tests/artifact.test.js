'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { DatabaseSync } = require('node:sqlite'), { gzipSync } = require('node:zlib');
const C = require('../forecast-core'), Engine = require('../server/engine'), Store = require('../server/store');
const { Artifact, buildSnapshot } = require('../server/artifact'), { run } = require('../server/build'), Stream = require('../server/import-stream');
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'supply-artifact-'));

test('artifact restores every version/mode/source without online topology, critical path or matrix computation', () => {
  const root = dir(), file = path.join(root, 'built.supply'), data = C.sample();
  data.tables.forecast.push(...data.tables.forecast.map(r => ({ ...r, plan_date: '2025-01-01', qty: r.qty * .8 })));
  const manifest = buildSnapshot(data, file), artifact = new Artifact(file);
  const compute = Engine.prototype.precompute, topology = C.topology;
  try {
    Engine.prototype.precompute = () => { throw Error('online computation forbidden'); }; C.topology = () => { throw Error('online topology forbidden'); };
    for (const version of manifest.versions) {
      const e = Engine.restore(artifact.load(12), version, artifact), ref = new C.Engine(data, version);
      for (const month of e.months) for (const mode of ['direct', 'cross', 'top']) for (const source of ['forecast', 'mo']) {
        for (const [code, row] of ref.compute(month, mode, source)) assert.deepEqual(e.row(code, month, mode, source), row);
      }
      for (const code of e.graph.codes) assert.deepEqual(e.criticalCache.get(code), ref.criticalCache.get(code));
      e.materialized.delete(JSON.stringify([e.months[0], 'cross', 'forecast']));
      assert.throws(() => e.row('A', e.months[0]), /不会自动重算/);
    }
  } finally { Engine.prototype.precompute = compute; C.topology = topology; artifact.close(); }
});

test('chunked artifact has no global snapshot blob and corruption is rejected before publication', () => {
  const root = dir(), file = path.join(root, 'built.supply'), manifest = buildSnapshot(C.sample(), file);
  const db = new DatabaseSync(file);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='snapshots'").get().n, 0);
  assert.ok(db.prepare('SELECT MAX(length(payload)) AS n FROM chunks').get().n < 2 * 1024 * 1024);
  db.exec("UPDATE matrices SET sha256='corrupted' WHERE rowid=(SELECT MIN(rowid) FROM matrices)"); db.close();
  const artifact = new Artifact(file); try { assert.throws(() => artifact.verify(), /矩阵损坏/); } finally { artifact.close(); }
  assert.equal(manifest.codes, 4);
});

test('legacy data and obsolete artifacts rebuild explicitly; online metadata never silently recomputes', async () => {
  const root = dir(), dbPath = path.join(root, 'catalog.sqlite'), store = new Store(dbPath), sample = C.sample(); sample.revision = 1;
  try {
    store.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?)').run(1, new Date().toISOString(), 'sample', gzipSync(JSON.stringify(sample)));
    assert.equal(store.info().needsBuild, true);
    const file = path.join(root, 'migrated.supply'); await run({ operation: 'rebuild', base: { dbPath, revision: 1 }, output: file }); store.activate(file, 1, 'test');
    assert.equal(store.info().needsBuild, false); assert.equal(store.load().tables.forecast.length, sample.tables.forecast.length);
    const rw = new DatabaseSync(file), manifest = JSON.parse(rw.prepare('SELECT data FROM manifest').get().data); manifest.algorithm = 'obsolete'; rw.prepare('UPDATE manifest SET data=?').run(JSON.stringify(manifest)); rw.close();
    assert.throws(() => new Artifact(file), /重新离线构建/);
    const rebuilt = path.join(root, 'rebuilt.supply'); await run({ operation: 'rebuild', base: { dbPath, revision: 2 }, output: rebuilt });
    const current = new Artifact(rebuilt); try { assert.equal(current.verify().codes, 4); } finally { current.close(); }
  } finally { store.close(); }
});

test('streaming CSV handles split quotes, multiline fields, text identifiers and logical row errors', async () => {
  const root = dir(), file = path.join(root, 'forecast.csv');
  const text = '\uFEFF计划日期,编码,预测月份,预测数量,加工地代码,备注\r\n2026-09-10,000001,2026-09,10,S1,"带逗号,和""引号""\r\n下一行"\r\n';
  fs.writeFileSync(file, text);
  const result = await Stream.readInputs([{ path: file, table: 'forecast' }]);
  assert.equal(result.batches[0].rows[0].code, '000001'); assert.equal(result.batches[0].rows[0]._extra['备注'], '带逗号,和"引号"\r\n下一行');
  assert.ok(result.sources[0].sha256); assert.equal(result.batches[0].rows[0]._source.row, 2);
  fs.writeFileSync(file, '计划日期,编码,预测月份,预测数量\n2026-09-10,A,2026-09,bad\n');
  await assert.rejects(Stream.readInputs([{ path: file, table: 'forecast' }]), e => e.details[0].row === 2 && e.details[0].field === '预测数量');
  fs.writeFileSync(file, 'a,b\n"not closed'); await assert.rejects(async () => { for await (const row of Stream.csvRows(file)) void row; }, /引号未闭合/);
});

test('merge retains unrelated versions by reference and never serializes/copies the full baseline', () => {
  const data = C.sample(); data.kind = 'imported'; const row = { ...data.tables.forecast[0], plan_date: '2025-01-01' };
  const next = Stream.merge(data, [{ table: 'forecast', rows: [row] }]);
  assert.equal(next.tables.bom, data.tables.bom); assert.equal(next.tables.attributes, data.tables.attributes); assert.equal(next.tables.forecast[0], data.tables.forecast[0]);
  assert.equal(data.tables.forecast.length, 55); assert.equal(next.tables.forecast.length, 56);
});

test('CSV fields and escaped quotes survive stream boundaries without character chains', async () => {
  const file = path.join(dir(), 'boundary.csv'), long = 'x'.repeat(256 * 1024 - 2);
  fs.writeFileSync(file, '"' + long + '""end",next\r\n' + 'z'.repeat(300000) + ',last');
  const rows = []; for await (const row of Stream.csvRows(file)) rows.push(row);
  assert.deepEqual(rows, [[long + '"end', 'next'], ['z'.repeat(300000), 'last']]);
});

test('CLI builds split CSV and Excel inputs using paths relative to its config', async () => {
  const { spawn } = require('node:child_process'), root = dir(), XLSX = require('../vendor/xlsx');
  const header = 'plan_date,code,month,qty,site_code\n';
  fs.writeFileSync(path.join(root, 'part1.csv'), header + '2026-09-10,00001,2026-09,20,S1\n');
  fs.writeFileSync(path.join(root, 'part2.csv'), header + '2026-09-10,00002,2026-09,30,S2\n');
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['parent', 'child', 'qty'], ['00001', '00002', 2]]), 'bom');
  fs.writeFileSync(path.join(root, 'bom.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  fs.writeFileSync(path.join(root, 'build.json'), JSON.stringify({ files: [{ path: 'part1.csv', table: 'forecast' }, { path: 'part2.csv', table: 'forecast' }, { path: 'bom.xlsx' }], output: 'result.supply' }));
  const child = spawn(process.execPath, ['server/build.js', '--config', path.join(root, 'build.json')], { cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let logs = ''; child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
  assert.equal(await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); }), 0, logs);
  const artifact = new Artifact(path.join(root, 'result.supply')); try { const e = Engine.restore(artifact.load(), '2026-09-10', artifact); assert.equal(e.row('00002', '2026-09', 'direct').demand, 40); assert.equal(artifact.manifest.counts.forecast, 2); assert.equal(artifact.manifest.sources.length, 3); } finally { artifact.close(); }
});

test('delay beyond the prebuilt horizon remains an independent scenario', () => {
  const { Service } = require('../server/service'), service = new Service(path.join(dir(), 'scenario.sqlite'));
  try {
    const meta = service.sample({ baseRevision: 0 }, 'test'), version = meta.versions.at(-1), month = meta.months.at(-1);
    const baseline = service.engine({ version }), row = baseline.snapshot.tables.forecast.find(r => r.month === month && r.plan_date === version && r.qty > 0);
    const original = row.qty, result = service.simulate({ baseRevision: meta.revision, version, month, type: 'quality', code: row.code, delayDays: 40, mode: 'cross', source: 'forecast' }, 'test');
    assert.ok(result.affected.some(r => r.month > month)); assert.equal(row.qty, original); assert.equal(service.store.revision(), meta.revision);
    service.engines.clear(); const reopened = service.engine({ scenario: result.id }, 'test'); assert.ok(reopened.months.some(m => m > month));
  } finally { service.store.close(); }
});
