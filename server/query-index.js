'use strict';
const C = require('../forecast-core');
const engines = new WeakMap();
const compare = (a, b) => (b.gap ?? -Infinity) - (a.gap ?? -Infinity) || a.code.localeCompare(b.code);
function lru(map, key, value, limit) { if (map.has(key)) map.delete(key); map.set(key, value); if (map.size > limit) map.delete(map.keys().next().value); return value; }
function view(engine, month, mode, source) {
  let views = engines.get(engine); if (!views) engines.set(engine, views = new Map());
  const key = JSON.stringify([month, mode, source]);
  if (views.has(key)) return lru(views, key, views.get(key), 2);
  const rows = [...engine.compute(month, mode, source).values()];
  const dashboard = { total: rows.length, shortage: 0, coverageShortage: 0, single: 0, concentrated: 0, incomplete: 0, unknownSites: 0 };
  for (const r of rows) { dashboard.shortage += Number(r.gap > C.EPS); dashboard.coverageShortage += Number(r.coverageGap > C.EPS); dashboard.single += Number(r.sites.single); dashboard.concentrated += Number(r.sites.count > 1 && r.sites.maxShare >= engine.cfg.concentration); dashboard.incomplete += Number(!r.complete); dashboard.unknownSites += Number(r.sites.unassigned > C.EPS); }
  rows.sort(compare);
  return lru(views, key, { rows, dashboard, filters: new Map() }, 2);
}
function filter(view, q, engine, input = view.rows) {
  const search = String(q.search || '').toLowerCase(), key = JSON.stringify([search, q.site || '', q.industry || '', q.risk || '']);
  if (!search && !q.site && !q.industry && !q.risk) return input;
  if (input === view.rows && view.filters.has(key)) return lru(view.filters, key, view.filters.get(key), 4);
  const rows = input.filter(r => (!search || [r.code, r.attr.name, r.attr.make_dept].some(v => String(v || '').toLowerCase().includes(search))) && (!q.site || r.sites.sites.some(s => s.key === q.site)) && (!q.industry || r.attr.make_dept === q.industry) && (!q.risk || (q.risk === 'shortage' ? r.gap > C.EPS : q.risk === 'coverage' ? r.coverageGap > C.EPS : q.risk === 'single' ? r.sites.single : q.risk === 'concentrated' ? r.sites.count > 1 && r.sites.maxShare >= engine.cfg.concentration : q.risk === 'incomplete' ? !r.complete : r.risks.length > 0)));
  return input === view.rows ? lru(view.filters, key, rows, 4) : rows;
}
function dependencies(engine, root, month, mode, source) {
  const reachable = new Set([root]), queue = [root], amounts = new Map([[root, 1]]), out = [], demand = engine.net(root, month).demand;
  const stop = c => c !== root && (mode === 'direct' || (mode === 'cross' && engine.local(c) !== true));
  for (let i = 0; i < queue.length; i++) if (!stop(queue[i])) for (const edge of engine.graph.children.get(queue[i]) || []) if (!reachable.has(edge.child)) { reachable.add(edge.child); queue.push(edge.child); }
  queue.sort((a, b) => engine.orderIndex.get(a) - engine.orderIndex.get(b));
  for (const code of queue) {
    if (code !== root) out.push({ ...engine.row(code, month, mode, source), coeff: amounts.get(code), contribution: demand == null ? null : demand * amounts.get(code) });
    if (!stop(code)) for (const edge of engine.graph.children.get(code) || []) { const value = (amounts.get(edge.child) || 0) + amounts.get(code) * edge.qty; if (!Number.isFinite(value)) throw Error('BOM累计用量超出计算范围'); amounts.set(edge.child, value); }
  }
  return out;
}
module.exports = { view, filter, dependencies, compare, lru };
