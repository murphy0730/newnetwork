'use strict';
// Opt-in end-to-end scale test: real >512MiB streamed upload, isolated build, atomic load.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks'), { constants } = require('node:buffer');
const Store = require('../server/store');
const count = Number(process.env.SCALE_CODES || 120000), monthCount = 11, width = Math.ceil(count / 10), port = Number(process.env.SCALE_PORT || 8796);
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-output', 'artifact-scale-' + Date.now()), dbPath = path.join(out, 'catalog.sqlite'); fs.mkdirSync(out, { recursive: true });
const code = i => 'P' + String(i).padStart(6, '0'), months = Array.from({ length: monthCount }, (_, i) => new Date(Date.UTC(2026, 8 + i, 1)).toISOString().slice(0, 7));
function csv(name, header, generate) { const filename = path.join(process.env.SCALE_INPUT_DIR || out, name + '.csv'); if (process.env.SCALE_INPUT_DIR) { const rows = name === 'forecast' ? count * monthCount : name === 'attributes' ? count : name === 'industry' ? 2 : (count - width) / 2 * 11; return { filename, name: name + '.csv', rows, bytes: fs.statSync(filename).size }; } const fd = fs.openSync(filename, 'w'); let buffer = header + '\r\n', rows = 0; try { for (const row of generate()) { buffer += row + '\r\n'; if (++rows % 1000 === 0) { fs.writeSync(fd, buffer); buffer = ''; } } if (buffer) fs.writeSync(fd, buffer); } finally { fs.closeSync(fd); } return { filename, name: name + '.csv', rows, bytes: fs.statSync(filename).size }; }
const notes = 'N'.repeat(430);
const files = [
  csv('forecast', 'plan_date,code,month,qty,site_code,site_name,supplier_code,supplier_name,type,org_id,product_line,product_family,notes', function* () { for (let i = 0; i < count; i++) for (const m of months) yield ['2026-09-10', code(i), m, 1000 + i % 500, 'S' + i % 300, 'Site' + i % 300, 'V' + i % 300, 'Vendor', 'part', 'ORG', 'line', 'family', notes].join(','); }),
  csv('bom', 'parent,child,qty', function* () { for (let i = width; i < count; i++) for (let p = 0; p < (i % 2 ? 5 : 6); p++) yield [code((Math.floor(i / width) - 1) * width + ((i % width + p * 7) % width)), code(i), .2].join(','); }),
  csv('attributes', 'code,make_dept,lead_mean,lead_cv', function* () { for (let i = 0; i < count; i++) yield [code(i), Math.floor(i / width) % 3 ? 'local' : 'external', 10, .2].join(','); }),
  csv('industry', 'make_dept,is_local', function* () { yield 'local,true'; yield 'external,false'; })
];
console.log('Generated: ' + JSON.stringify(files.map(f => ({ name: f.name, bytes: f.bytes, rows: f.rows }))));
const server = spawn(process.execPath, ['server/main.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: dbPath, API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '', BUILD_HEAP_MB: '8192' } });
let logs = ''; server.stdout.on('data', b => logs += b); server.stderr.on('data', b => logs = (logs + b).slice(-8000));
const base = 'http://127.0.0.1:' + port, timings = {}, health = []; let monitor, monitorPending = false;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function request(url, body) { const r = await fetch(base + url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const value = await r.json(); if (!r.ok) throw Error(JSON.stringify(value)); return value; }
async function poll(initial) { let previous = ''; for (let n = 0; n < 1800; n++) { const job = await request(initial.poll); if (job.status === 'failed') throw Error(JSON.stringify(job.error)); if (job.status === 'completed') return job.result; if (job.phase !== previous) { previous = job.phase; console.log(job.phase + ': ' + job.message); } await pause(500); } throw Error('build timeout'); }
async function timed(name, fn) { const begin = performance.now(), result = await fn(); timings[name] = performance.now() - begin; console.log(name + ': ' + timings[name].toFixed(1) + ' ms'); return result; }
(async () => {
  for (let i = 0; i < 100; i++) { try { if ((await request('/api/health')).ok) break; } catch {} await pause(100); }
  monitor = setInterval(async () => { if (monitorPending) return; monitorPending = true; const begin = performance.now(); try { await request('/api/health'); health.push(performance.now() - begin); } finally { monitorPending = false; } }, 500);
  const uploaded = await timed('stream_upload_and_inspect', async () => { const uploaded = []; for (const file of files) { const r = await fetch(base + '/api/import/file?name=' + file.name, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: fs.createReadStream(file.filename), duplex: 'half' }); assert.equal(r.status, 202); uploaded.push(await poll(await r.json())); } return uploaded; });
  const preview = await timed('isolated_build', () => request('/api/import/preview', { baseRevision: 0, files: uploaded.map(f => ({ id: f.id, selections: f.sheets.filter(s => s.detected).map(s => ({ sheet: s.name, table: s.detected.table, headerRow: s.detected.headerRow })) })) }).then(poll));
  assert.equal((await request('/api/meta')).revision, 0); assert.equal(preview.codes, count);
  const meta = await timed('load_and_activate', () => request('/api/import/commit', { previewId: preview.previewId }).then(poll)); assert.equal(meta.codes, count);
  await timed('detail_11_months', async () => { const detail = await request('/api/nodes?code=' + code(count - 1) + '&month=2026-09&mode=cross'); assert.equal(detail.details.length, 11); assert.equal(detail.trace.revision, 1); });
  await timed('analysis_page', async () => { const page = await request('/api/analysis?month=2026-09&mode=cross&limit=100'); assert.equal(page.total, count); assert.equal(page.rows.length, 100); });
  const store = new Store(dbPath), artifact = store.artifact(), manifest = artifact.manifest;
  const report = { measured_at: new Date().toISOString(), node: process.version, counts: meta.counts, codes: meta.codes, edges: meta.edges, levels: meta.levels, input_bytes: files.map(f => ({ name: f.name, bytes: f.bytes })), forecast_cells: files[0].rows * 13, table_json_characters: manifest.tableJsonCharacters, old_string_limit: constants.MAX_STRING_LENGTH, max_chunk_bytes: manifest.maxChunkBytes, artifact_bytes: fs.statSync(artifact.filename).size, catalog_bytes: fs.statSync(dbPath).size, timings_ms: timings, health_max_ms: Math.max(...health), health_requests: health.length };
  if (count >= 120000) { assert.ok(files[0].bytes > 512 * 1024 * 1024); assert.ok(manifest.tableJsonCharacters > constants.MAX_STRING_LENGTH); assert.ok(report.forecast_cells > 12000000); }
  assert.ok(report.health_max_ms < 5000); store.close(); fs.writeFileSync(path.join(root, 'test-output/artifact-benchmark.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(e => { console.error(e); console.error(logs); process.exitCode = 1; }).finally(() => { clearInterval(monitor); server.kill(); });
