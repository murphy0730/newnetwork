'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const Store = require('../server/store'), BuildJobs = require('../server/build-jobs');
const { buildSnapshot } = require('../server/artifact'), C = require('../forecast-core');
const pause = ms => new Promise(r => setTimeout(r, ms));

test('online builds release failed uploads, preserve baseline, reject stale activation and survive restart', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-build-http-')), dbPath = path.join(dir, 'catalog.sqlite'), port = 8798, base = 'http://127.0.0.1:' + port;
  let child;
  function start() { child = spawn(process.execPath, ['server/main.js'], { cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'ignore', env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DB_PATH: dbPath, API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '' } }); }
  async function stop() { const done = new Promise(r => child.once('exit', r)); child.kill(); await done; }
  async function request(url, body) { const r = await fetch(base + url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const value = await r.json(); assert.ok(r.ok, JSON.stringify(value)); return value; }
  async function ready() { for (let i = 0; i < 100; i++) { try { if ((await request('/api/health')).ok) return; } catch {} await pause(100); } throw Error('server timeout'); }
  async function poll(task, success = true) { for (let i = 0; i < 600; i++) { const j = await request(task.poll); if (j.status !== 'running') { assert.equal(j.status, success ? 'completed' : 'failed', JSON.stringify(j)); return success ? j.result : j; } await pause(50); } throw Error('job timeout'); }
  async function upload(text, name = 'forecast.csv', artifact = false, revision = 0) { const r = await fetch(base + (artifact ? '/api/import/artifact?baseRevision=' + revision + '&name=' : '/api/import/file?name=') + name, { method: 'POST', body: text }); assert.equal(r.status, 202); return poll(await r.json()); }
  const previewBody = (f, revision) => ({ baseRevision: revision, files: [{ id: f.id, selections: [{ sheet: f.sheets[0].name, table: 'forecast' }] }] });
  try {
    start(); await ready();
    assert.ok((await request('/api/import/schema')).schemas.forecast.fields.site_code);
    assert.equal((await fetch(base + '/api/export?kind=template')).status, 200);
    const seed = await poll(await request('/api/sample', { baseRevision: 0 })); assert.equal(seed.revision, 1);
    const header = 'plan_date,code,month,qty,site_code\n';
    for (let attempt = 0; attempt < 3; attempt++) {
      const file = await upload(header + '2026-09-10,RETRY,2026-09,invalid,S1\n');
      const failed = await poll(await request('/api/import/preview', previewBody(file, 1)), false);
      assert.equal(failed.error.details[0].row, 2); assert.equal((await request('/api/meta')).revision, 1);
      await pause(50); assert.deepEqual(fs.readdirSync(dbPath + '.tasks/uploads'), []);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'catalog.sqlite.builds')).filter(f => f.includes('partial')), []);
    }
    const file = await upload(header + '2026-09-10,RETRY,2026-09,80,S1\n');
    const buildTask = await request('/api/import/preview', previewBody(file, 1));
    const old = await request('/api/analysis?month=' + seed.months[0]); assert.equal(old.trace.revision, 1);
    const preview = await poll(buildTask);
    assert.equal((await request(buildTask.poll)).canActivate, true);
    await stop(); start(); await ready();
    assert.ok((await request('/api/builds')).jobs.some(j => j.id === buildTask.jobId && j.result.previewId === preview.previewId));
    assert.equal((await poll(await request('/api/import/commit', { previewId: preview.previewId }))).revision, 2);
    assert.equal((await request(buildTask.poll)).canActivate, false);
    const page = await request('/api/analysis?version=2026-09-10&month=2026-09'); assert.equal(page.rows.find(r => r.code === 'RETRY').supply, 80);
    const exported = Buffer.from(await (await fetch(base + '/api/export?kind=artifact')).arrayBuffer());
    const built = await upload(exported, 'built.supply', true, 2);
    await poll(await request('/api/builds/rebuild', { baseRevision: 2 }));
    const stale = await poll(await request('/api/import/commit', { previewId: built.previewId }), false); assert.equal(stale.error.status, 409); assert.equal((await request('/api/meta')).revision, 3);
    const builtAgain = await upload(exported, 'built.supply', true, 3);
    assert.equal((await poll(await request('/api/import/commit', { previewId: builtAgain.previewId }))).revision, 4);
    const csv = await (await fetch(base + '/api/export?kind=csv&table=forecast')).text(); assert.ok(csv.includes('RETRY')); assert.ok(csv.includes('80'));
    const invalid = await fetch(base + '/api/import/artifact?name=bad.supply&baseRevision=4', { method: 'POST', body: 'not a database' }); await poll(await invalid.json(), false); assert.equal((await request('/api/meta')).revision, 4);
  } finally { await stop(); }
});

test('cancel and restart cleanup remove temporary outputs but never published history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-cleanup-')), store = new Store(path.join(dir, 'catalog.sqlite'));
  const jobs = new BuildJobs(store, () => {}), published = path.join(store.artifactDir, 'published.supply');
  try {
    buildSnapshot(C.sample(), published); store.activate(published, 0, 'test');
    const file = path.join(jobs.root, 'uploads', randomUUID() + '.csv'); fs.writeFileSync(file, 'pending');
    let release; const task = jobs.create('test', 'build', () => new Promise(r => release = r), [file], false, [published]);
    await pause(0); jobs.cancel(task.jobId, 'test'); release({}); await pause(20);
    assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(published), true);
    const partial = path.join(store.artifactDir, 'interrupted.supply'); fs.writeFileSync(partial, 'not published');
    const id = randomUUID(); jobs.write(jobs.file('jobs', id), { id, actor: 'test', kind: 'build', status: 'running', resources: [], outputs: [partial, published], created_at: new Date().toISOString() });
    const restarted = new BuildJobs(store, () => {}); assert.equal(restarted.get(id, 'test').status, 'failed'); assert.equal(fs.existsSync(partial), false); assert.equal(fs.existsSync(published), true);
  } finally { jobs.shutdown(); store.close(); }
});
