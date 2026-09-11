'use strict';
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process'), assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks'), Store = require('../server/store');
const root = path.resolve(__dirname, '..'), dir = path.join(root, 'test-output', 'switch-' + Date.now()), port = 8802, base = 'http://127.0.0.1:' + port;
fs.mkdirSync(dir, { recursive: true });
const source = new Store(path.resolve(process.env.AUDIT_DB || 'test-output/artifact-scale-1789044572273/catalog.sqlite')), filename = source.artifact().filename; source.close();
const dbPath = path.join(dir, 'catalog.sqlite'), target = new Store(dbPath); target.activate(filename, 0, 'benchmark'); target.close();
const child = spawn(process.execPath, ['server/main.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: dbPath, API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '' } }); let logs = ''; child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs = (logs + b).slice(-6000));
const pause = ms => new Promise(r => setTimeout(r, ms)), samples = []; let timer, pending;
async function request(url, body) { const r = await fetch(base + url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw Error(JSON.stringify(data)); return data; }
(async () => {
  for (let i = 0; i < 1200; i++) { try { if ((await request('/api/health')).ready) break; } catch {} await pause(100); }
  const url = '/api/nodes?code=P119999&month=2026-09&mode=cross', before = await request(url); assert.equal(before.trace.revision, 1);
  timer = setInterval(() => { if (pending) return; const t = performance.now(); pending = request(url).then(r => { assert.equal(r.gap, before.gap); assert.ok([1, 2].includes(r.trace.revision)); samples.push({ ms: performance.now() - t, revision: r.trace.revision }); }).catch(e => samples.push({ error: e.message })).finally(() => pending = null); }, 250);
  const start = performance.now(), task = await request('/api/builds/rebuild', { baseRevision: 1 }); let status;
  for (let i = 0; i < 1200; i++) { status = await request(task.poll); if (status.status !== 'running') break; await pause(100); }
  assert.equal(status.status, 'completed', JSON.stringify(status)); assert.equal(status.result.revision, 2); assert.equal(status.result.codes, 120000);
  await pause(700); clearInterval(timer); if (pending) await pending;
  const failures = samples.filter(s => s.error), report = { measured_at: new Date().toISOString(), rebuild_and_switch_ms: performance.now() - start, reads: samples.length, read_max_ms: Math.max(...samples.map(s => s.ms || 0)), revisions: [...new Set(samples.map(s => s.revision))], failures, diagnostics: await request('/api/diagnostics') };
  assert.deepEqual(failures, []); assert.ok(report.revisions.includes(1) && report.revisions.includes(2)); assert.ok(report.read_max_ms < 5000);
  fs.writeFileSync(path.join(root, 'test-output/version-switch-benchmark.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(e => { console.error(e); console.error(logs); process.exitCode = 1; }).finally(() => { clearInterval(timer); child.kill(); });
