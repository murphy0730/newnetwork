'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { performance } = require('node:perf_hooks');
const Store = require('../server/store'), { run } = require('../server/build');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-output', 'response-' + Date.now()), port = 8801;
fs.mkdirSync(out, { recursive: true });
const pause = ms => new Promise(r => setTimeout(r, ms)), base = 'http://127.0.0.1:' + port;
let child, monitor, monitoring = false; const health = [], measurements = {}; let logs = '';
async function request(url, body) { const response = await fetch(base + url, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(180000) }); const result = await response.json(); if (!response.ok) throw Error(JSON.stringify(result)); return result; }
async function poll(task) { for (let i = 0; i < 1800; i++) { const j = await request(task.poll); if (j.status === 'failed') throw Error(JSON.stringify(j.error)); if (j.status === 'completed') return j.result; await pause(100); } throw Error('task timeout'); }
async function measure(label, fn, repeat = 1) { const times = []; let result; for (let i = 0; i < repeat; i++) { const t = performance.now(); result = await fn(); times.push(performance.now() - t); } times.sort((a, b) => a - b); measurements[label] = { n: repeat, min: times[0], p50: times[Math.floor((repeat - 1) * .5)], p95: times[Math.ceil((repeat - 1) * .95)], max: times.at(-1) }; console.log(label + ': ' + JSON.stringify(measurements[label])); return result; }
(async () => {
  const source = new Store(path.resolve(process.env.AUDIT_DB || 'test-output/artifact-scale-1789044572273/catalog.sqlite'), { allowObsolete: true }); let filename;
  try { filename = source.artifact().filename; } finally { source.close(); }
  if (process.env.AUDIT_REBUILD === '1') { const result = await run({ base: { artifact: filename }, operation: 'rebuild', output: path.join(out, 'current.supply') }); filename = result.path; }
  const dbPath = path.join(out, 'catalog.sqlite'), catalog = new Store(dbPath); catalog.activate(filename, 0, 'benchmark'); catalog.close();
  const started = performance.now(); child = spawn(process.execPath, ['server/main.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: dbPath, API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '' } }); child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs = (logs + b).slice(-6000));
  for (let i = 0; i < 1800; i++) { try { if ((await request('/api/health')).ready) break; } catch {} await pause(100); }
  measurements.startup_ms = performance.now() - started;
  monitor = setInterval(async () => { if (monitoring) return; monitoring = true; const t = performance.now(); try { await request('/api/health'); health.push(performance.now() - t); } catch { health.push(180000); } finally { monitoring = false; } }, 100);
  const meta = await request('/api/meta'), version = meta.versions.at(-1), month = meta.months[0], leaf = 'P119999', parent = 'P000000', q = 'month=' + month + '&mode=cross';
  assert.equal(meta.codes, 120000);
  await measure('cold_selected_graph', () => request('/api/graph?code=' + leaf + '&' + q + '&graphRelations=bom&depth=3&limit=100'));
  await measure('list_first', () => request('/api/analysis?' + q));
  await measure('list_warm_no_version', () => request('/api/analysis?' + q + '&offset=100'), 15);
  await measure('list_warm_version', () => request('/api/analysis?' + q + '&version=' + version + '&offset=200'), 15);
  await measure('filtered_site', () => request('/api/analysis?' + q + '&site=S10'), 10);
  await measure('detail_leaf', () => request('/api/nodes?code=' + leaf + '&' + q), 10);
  await measure('detail_upper', () => request('/api/nodes?code=' + parent + '&' + q), 5);
  await measure('demand_view', () => request('/api/analysis?role=demand&code=' + parent + '&' + q), 5);
  await measure('report', () => request('/api/reports?' + q), 5);
  if (process.env.AUDIT_INSIGHTS === '1') {
    await measure('insights_first', () => request('/api/insights?code=' + leaf + '&' + q));
    await measure('insights_cached', () => request('/api/insights?code=' + leaf + '&' + q), 10);
    await measure('insights_upper', () => request('/api/insights?code=' + parent + '&' + q));
  }
  await measure('concurrent_8_lists', () => Promise.all(Array.from({ length: 8 }, (_, i) => request('/api/analysis?' + q + '&offset=' + i * 100))), 3);
  const scenario = await measure('scenario_single', () => request('/api/scenarios', { baseRevision: 1, version, month, changes: [{ code: leaf, month, operation: 'percent', value: 20 }] }).then(poll)); assert.ok(scenario.affectedRows);
  if (process.env.AUDIT_INSIGHTS === '1') await measure('scenario_warm', () => request('/api/scenarios', { baseRevision: 1, version, month, changes: [{ code: leaf, month, operation: 'percent', value: 10 }] }).then(poll), 3);
  assert.equal((await request('/api/meta')).revision, 1);
  const report = { measured_at: new Date().toISOString(), codes: meta.codes, counts: meta.counts, measurements, health_requests: health.length, health_max_ms: Math.max(...health), artifact: filename };
  if (process.env.AUDIT_INSIGHTS === '1') report.diagnostics = await request('/api/diagnostics');
  fs.writeFileSync(path.join(root, 'test-output', 'response-' + (process.env.AUDIT_LABEL || 'before') + '.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(e => { console.error(e); console.error(logs); process.exitCode = 1; }).finally(() => { clearInterval(monitor); child?.kill(); });
