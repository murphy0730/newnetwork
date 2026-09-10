'use strict';
const { performance } = require('node:perf_hooks'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const C = require('../forecast-core');
function generate(size = 30000, months = 11) {
  const s = C.empty(); s.kind = 'benchmark'; const width = Math.ceil(size / 10);
  s.tables.industry = [{ make_dept: '本产业', is_local: true }, { make_dept: '上层产业', is_local: false }];
  for (let i = 0; i < size; i++) { const code = `P${String(i).padStart(5, '0')}`, layer = Math.floor(i / width); s.tables.attributes.push({ code, make_dept: layer % 3 ? '本产业' : '上层产业', lead_mean: 2 + i % 12, lead_cv: .1 + (i % 5) / 10, sample_count: 30 });
    for (let m = 0; m < months; m++) s.tables.forecast.push({ code, plan_date: '2026-08-24', month: C.addMonth('2026-09', m), qty: 1000 + i % 500, site_code: `S${i % 300}`, site_name: `加工地${i % 300}` });
    s.tables.inventory.push({ id: code, code, date: '2026-09-01', qty: i % 100, sub_type: '正常库存' });
    if (layer > 0) for (let p = 0; p < (i % 2 ? 5 : 6); p++) { const parent = (layer - 1) * width + ((i % width + p * 7) % width); s.tables.bom.push({ id: `${i}-${p}`, parent: `P${String(parent).padStart(5, '0')}`, child: code, qty: .2 }); }
  }
  return s;
}
if (require.main === module) {
  const measure = (name, f) => { const t = performance.now(), result = f(), ms = performance.now() - t; console.log(name + ': ' + ms.toFixed(1) + 'ms'); return { result, ms }; };
  const generated = measure('generate', () => generate()), s = generated.result;
  const construction = measure('build_indexes', () => new C.Engine(s)), e = construction.result;
  const warm = measure('all_months_three_modes_precompute', () => e.precompute());
  const cached = measure('cached_month_hydration', () => e.compute('2026-09', 'cross'));
  const relation = measure('one_supplier_contributions', () => e.relations('P29999', 'top'));
  const impacted = measure('one_demand_downstream', () => e.downstream('P00000', '2026-09', 'top'));
  const modified = { ...s, tables: { ...s.tables, forecast: s.tables.forecast.map(r => r.code === 'P29999' && r.month === '2026-09' ? { ...r, qty: r.qty * 1.2 } : r) } };
  const simulation = measure('one_month_scenario_with_index_build', () => { const sim = new C.Engine(modified, '2026-08-24', e.graph); return sim.compute('2026-09', 'cross').get('P29999').gap; });
  const report = { measured_at: new Date().toISOString(), node: process.version, cpu: os.cpus()[0].model, logical_cpus: os.cpus().length, total_memory_gb: os.totalmem() / 2 ** 30, codes: e.graph.codes.length, edges: s.tables.bom.length, layers: 10, sites: 300, forecast_rows: s.tables.forecast.length, months: 11, milliseconds: { indexes: construction.ms, precompute: warm.ms, cached_month: cached.ms, contributions: relation.ms, downstream: impacted.ms, scenario_one_month: simulation.ms }, memory_mb: Object.fromEntries(Object.entries(process.memoryUsage()).map(([k, v]) => [k, v / 2 ** 20])) };
  fs.mkdirSync(path.join(__dirname, '../test-output'), { recursive: true }); fs.writeFileSync(path.join(__dirname, '../test-output/benchmark.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
module.exports = { generate };
