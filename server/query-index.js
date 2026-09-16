'use strict';
const C = require('../forecast-core');
const engines = new WeakMap();
// 优先展示能计算出结果（数据完整）的编码，再按缺口降序
const compare = (a, b) => Number(b.complete) - Number(a.complete) || (b.gap ?? -Infinity) - (a.gap ?? -Infinity) || a.code.localeCompare(b.code);
function lru(map, key, value, limit) { if (map.has(key)) map.delete(key); map.set(key, value); if (map.size > limit) map.delete(map.keys().next().value); return value; }
function summarize(rows, engine) {
  const dashboard = { total: rows.length, shortage: 0, coverageShortage: 0, single: 0, concentrated: 0, incomplete: 0, unknownSites: 0 };
  for (const r of rows) { dashboard.shortage += Number(r.gap > C.EPS); dashboard.coverageShortage += Number(r.coverageGap > C.EPS); dashboard.single += Number(r.sites.single); dashboard.concentrated += Number(r.sites.count > 1 && r.sites.maxShare >= engine.cfg.concentration); dashboard.incomplete += Number(!r.complete); dashboard.unknownSites += Number(r.sites.unassigned > C.EPS); }
  return dashboard;
}
function view(engine, month, mode, source) {
  let views = engines.get(engine); if (!views) engines.set(engine, views = new Map());
  const key = JSON.stringify([month, mode, source]);
  if (views.has(key)) return lru(views, key, views.get(key), 2);
  const rows = [...engine.compute(month, mode, source).values()];
  const dashboard = summarize(rows, engine);
  rows.sort(compare);
  return lru(views, key, { rows, dashboard, filters: new Map() }, 2);
}
function selections(value) {
  if (value == null || value === '') return [];
  if (typeof value === 'string' && value.startsWith('[')) {
    try { value = JSON.parse(value); } catch { throw Object.assign(Error('多选参数须为 JSON 字符串数组'), { status: 400 }); }
  }
  if (!Array.isArray(value)) value = [value];
  if (value.some(v => typeof v !== 'string')) throw Object.assign(Error('多选参数须为字符串数组'), { status: 400 });
  return [...new Set(value.map(v => v.trim()).filter(Boolean))].sort();
}
function filter(view, q, engine, input = view.rows) {
  const search = String(q.search || '').toLowerCase(), sites = selections(q.site), codes = selections(q.codes), codeSet = new Set(codes), siteSet = new Set(sites);
  const key = JSON.stringify([search, sites, codes, q.industry || '', q.category || '', q.risk || '']);
  if (!search && !sites.length && !codes.length && !q.industry && !q.category && !q.risk) return input;
  if (input === view.rows && view.filters.has(key)) return lru(view.filters, key, view.filters.get(key), 4);
  const rows = input.filter(r => ((!search && !codes.length) || codeSet.has(r.code) || (search && [r.code, r.attr.name, r.attr.make_dept].some(v => String(v || '').toLowerCase().includes(search)))) && (!sites.length || r.sites.sites.some(s => siteSet.has(s.key))) && (!q.industry || r.attr.make_dept === q.industry) && (!q.category || r.attr.part_category === q.category) && (!q.risk || (q.risk === 'shortage' ? r.gap > C.EPS : q.risk === 'coverage' ? r.coverageGap > C.EPS : q.risk === 'single' ? r.sites.single : q.risk === 'concentrated' ? r.sites.count > 1 && r.sites.maxShare >= engine.cfg.concentration : q.risk === 'incomplete' ? !r.complete : r.risks.length > 0)));
  return input === view.rows ? lru(view.filters, key, rows, 4) : rows;
}
function dependencies(engine, root, month, mode, source) {
  const reachable = new Set([root]), queue = [root], amounts = new Map([[root, 1]]), out = [], rootNet = engine.net(root, month).demand, demand = rootNet == null ? null : Math.abs(rootNet);
  const stop = c => c !== root && (mode === 'direct' || (mode === 'cross' && !engine.sameIndustry(c, root)));
  for (let i = 0; i < queue.length; i++) if (!stop(queue[i])) for (const edge of engine.graph.children.get(queue[i]) || []) if (!reachable.has(edge.child)) { reachable.add(edge.child); queue.push(edge.child); }
  queue.sort((a, b) => engine.orderIndex.get(a) - engine.orderIndex.get(b));
  for (const code of queue) {
    if (code !== root) out.push({ ...engine.row(code, month, mode, source), coeff: amounts.get(code), contribution: demand == null ? null : demand * amounts.get(code) });
    if (!stop(code)) for (const edge of engine.graph.children.get(code) || []) { const value = (amounts.get(edge.child) || 0) + amounts.get(code) * edge.qty; if (!Number.isFinite(value)) throw Error('BOM累计用量超出计算范围'); amounts.set(edge.child, value); }
  }
  return out;
}
module.exports = { view, filter, dependencies, compare, lru, selections, summarize };
