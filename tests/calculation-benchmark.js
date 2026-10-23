'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { performance } = require('node:perf_hooks'), { createHash } = require('node:crypto');
const corePath = require.resolve('../forecast-core');
const baseline = process.argv[3] && !process.argv[3].startsWith('--') ? path.resolve(process.argv[3]) : null;
const C = require(baseline || corePath);
if (baseline) { require(corePath); require.cache[corePath].exports = C; }
const Engine = require('../server/engine'), { Service } = require('../server/service');
const { buildSnapshot } = require('../server/artifact');
const out = path.join(__dirname, '../test-output');
fs.mkdirSync(out, { recursive: true });
const label = process.argv[2] || 'current', repeats = 3, version = '2026-09-24';
function fixture(size, departments, fanout, sparse) {
  const s = C.empty(), width = Math.ceil(size / 8), codes = Array.from({ length: size }, (_, i) => 'P' + String(i).padStart(5, '0'));
  for (let i = 0; i < size; i++) {
    const code = codes[i], layer = Math.floor(i / width);
    if (i % 19) s.tables.attributes.push({ code, make_dept: 'D' + (i % departments), lead_mean: 2 });
    for (let m = 0; m < 6; m++) if (!sparse || (i + m) % 5) s.tables.forecast.push({ code, plan_date: version, month: C.addMonth('2026-09', m), qty: i % 13 ? 100 + i % 500 : 0, site_code: 'S' + i % 7 });
    s.tables.inventory.push({ code, date: '2026-09-01', qty: i % 20 });
    s.tables.mo.push({ code, mo_no: code, due_date: '2026-09-20', qty: 50, site_code: 'S' });
    if (layer) for (let p = 0; p < fanout; p++) s.tables.bom.push({ parent: codes[(layer - 1) * width + (i % width + p * 7) % width], child: code, qty: .2, parent_template: 'AI', child_template: 'AI' });
  }
  return s;
}
function measure(fn) { const start = performance.now(), result = fn(); return { ms: performance.now() - start, result }; }
function run(s) {
  const timings = {}, built = measure(() => new Engine(s)); timings.indexes = built.ms;
  const e = built.result;
  for (const mode of ['direct', 'cross', 'top']) timings[mode] = 0;
  // Match the offline artifact builder: finish all modes and sources for one month first.
  for (const m of e.months) for (const mode of ['direct', 'cross', 'top']) timings[mode] += measure(() => { for (const source of ['forecast', 'mo']) e.matrix(m, mode, source); }).ms;
  timings.precompute = timings.direct + timings.cross + timings.top;
  timings.hydrate = measure(() => e.compute(e.months[0], 'cross')).ms;
  timings.relations = measure(() => { for (const code of e.graph.order.slice(-100)) for (const m of e.months) e.relations(code, 'cross', m, true); }).ms;
  const svc = Object.create(Service.prototype);
  svc.context = q => ({ engine: e, month: q.month || e.months[0], mode: q.mode || 'cross', source: q.source || 'forecast', trace: { revision: 0, version } });
  timings.summary = measure(() => svc.list({ summary: 1, mode: 'cross', span: 6, limit: 20 }, 'benchmark')).ms;
  const hash = createHash('sha256');
  for (const [key, matrix] of e.materialized) { hash.update(key); hash.update(Buffer.from(matrix.buffer, matrix.byteOffset, matrix.byteLength)); }
  for (const code of e.graph.order.slice(-100)) for (const m of e.months) hash.update(JSON.stringify(e.relations(code, 'cross', m, true)));
  return { timings, checksum: hash.digest('hex'), memory: process.memoryUsage() };
}
const report = { label, node: process.version, cpu: os.cpus()[0].model, repeats, cases: [] };
for (const [size, departments, fanout, sparse] of [[8000, 20, 3, true], [30000, 12, 5, false]]) {
  const s = fixture(size, departments, fanout, sparse), results = [];
  for (let i = 0; i < repeats; i++) { if (global.gc) global.gc(); results.push(run(s)); }
  if (new Set(results.map(r => r.checksum)).size !== 1) throw Error('Non-deterministic calculation results');
  const median = Object.fromEntries(Object.keys(results[0].timings).map(key => [key, results.map(r => r.timings[key]).sort((a, b) => a - b)[Math.floor(repeats / 2)]]));
  const artifactTimes = [];
  if (process.argv.includes('--artifact')) for (let i = 0; i < repeats; i++) {
    if (global.gc) global.gc();
    const file = path.join(out, `calculation-${label}-${size}.supply`);
    const built = measure(() => buildSnapshot(s, file)); artifactTimes.push(built.ms);
    fs.unlinkSync(file);
  }
  if (artifactTimes.length) median.artifact = [...artifactTimes].sort((a, b) => a - b)[Math.floor(repeats / 2)];
  const entry = { codes: size, edges: s.tables.bom.length, months: 6, departments: departments + 1, sparse, median_ms: median, checksum: results[0].checksum, runs: results, artifact_ms: artifactTimes };
  report.cases.push(entry); console.log(JSON.stringify({ codes: size, edges: entry.edges, median_ms: median, checksum: entry.checksum }));
}
report.peak_rss_mb = process.resourceUsage().maxRSS / 1024;
fs.writeFileSync(path.join(out, 'calculation-' + label + '.json'), JSON.stringify(report, null, 2));
module.exports = { fixture };
