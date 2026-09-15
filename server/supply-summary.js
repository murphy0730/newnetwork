'use strict';
const C = require('../forecast-core');
const Query = require('./query-index');
const cache = new WeakMap();
const bottomRanks = new WeakMap();

function sortSuppliers(rows, engine) {
  let ranks = bottomRanks.get(engine);
  if (!ranks) {
    ranks = new Map();
    // Reverse topology: all leaves (including independent codes) share rank 0.
    // Rank a parent by its longest distance to a leaf, regardless of root depth.
    for (let i = engine.graph.order.length - 1; i >= 0; i--) {
      const code = engine.graph.order[i]; let rank = 0;
      for (const edge of engine.graph.children.get(code)) rank = Math.max(rank, ranks.get(edge.child) + 1);
      ranks.set(code, rank);
    }
    bottomRanks.set(engine, ranks);
  }
  return rows.sort((a, b) => ranks.get(a.code) - ranks.get(b.code)
    || Number(b.applicable) - Number(a.applicable)
    || Number(!!b.known) - Number(!!a.known)
    || a.code.localeCompare(b.code));
}

function replaceDemand(row, demand, applicable, known) {
  const complete = row.supply != null && known;
  const gap = !applicable ? 0 : complete ? demand - row.supply : null;
  const risks = row.risks.filter(r => r !== '预测总量不足' && r !== '预测或产业数据不完整');
  if (!complete) risks.unshift('预测或产业数据不完整');
  if (gap > C.EPS) risks.unshift('预测总量不足');
  return { ...row, applicable, demand: applicable && known ? demand : null, complete, gap, coverageGap: !applicable ? 0 : gap != null && row.inventory != null ? gap - row.inventory : null, risks };
}

// Two forward DAG passes folded into one: industry-internal demand, then cross-boundary
// demand. O(V+E) per month, no enumeration of paths or pairwise transitive closure.
function view(engine, month, mode, source) {
  let views = cache.get(engine); if (!views) cache.set(engine, views = new Map());
  const key = JSON.stringify([month, mode, source]);
  if (views.has(key)) return Query.lru(views, key, views.get(key), 2);
  const input = Query.view(engine, month, mode === 'cross' ? 'direct' : mode, source);
  let byCode;
  if (mode === 'cross') {
    const internal = new Map(), external = new Map(); byCode = new Map();
    for (const code of engine.graph.order) {
      const parents = engine.graph.parents.get(code), net = engine.net(code, month);
      const same = parents.filter(e => engine.sameIndustry(e.parent, code));
      const block = { amount: 0, known: true };
      if (!same.length) { block.amount = net.demand || 0; block.known = net.known && engine.dept(code) != null; }
      else for (const edge of same) { const p = internal.get(edge.parent); block.amount += p.amount * edge.qty; block.known &&= p.known; }
      internal.set(code, block);
      const cross = { amount: 0, known: true, applicable: false };
      for (const edge of parents) {
        const sameDept = engine.sameIndustry(edge.parent, code), p = sameDept ? external.get(edge.parent) : internal.get(edge.parent);
        cross.amount += p.amount * edge.qty;
        cross.known &&= p.known && engine.dept(code) != null;
        cross.applicable ||= !sameDept || p.applicable;
      }
      if (!Number.isFinite(block.amount) || !Number.isFinite(cross.amount)) throw Error('BOM累计需求超出计算范围');
      external.set(code, cross);
    }
    for (const row of input.rows) { const x = external.get(row.code); byCode.set(row.code, replaceDemand(row, x.amount, x.applicable, x.known)); }
  } else {
    const totals = new Map();
    for (const code of engine.graph.order) {
      const total = { amount: 0, known: true };
      for (const edge of engine.graph.parents.get(code)) {
        const net = engine.net(edge.parent, month);
        const p = mode === 'direct' || !engine.graph.parents.get(edge.parent).length ? { amount: net.demand || 0, known: net.known } : totals.get(edge.parent);
        total.amount += p.amount * edge.qty; total.known &&= p.known;
      }
      if (!Number.isFinite(total.amount)) throw Error('BOM累计需求超出计算范围');
      totals.set(code, total);
    }
    byCode = new Map(input.rows.map(r => { const x = totals.get(r.code); return [r.code, replaceDemand(r, x.amount, !!engine.graph.parents.get(r.code).length, x.known)]; }));
  }
  const rows = sortSuppliers([...byCode.values()], engine);
  return Query.lru(views, key, { rows, byCode, filters: new Map(), dashboard: Query.summarize(rows, engine) }, 2);
}

// Relations are materialized only for the requested page, never an all-pairs BOM closure.
function relations(engine, code, mode) {
  if (mode !== 'cross') return engine.relations(code, mode);
  // State 0 searches the supplier's industry; state 1 follows the next industry's
  // own same-department parents to its roots. Distinct states allow converging paths.
  const visited = [new Set([code]), new Set()], queue = [[code, 0]], amounts = [new Map([[code, 1]]), new Map()], unknown = [new Set(), new Set()], targets = new Map();
  const next = (c, state) => (engine.graph.parents.get(c) || []).filter(e => state === 0 || engine.sameIndustry(c, e.parent)).map(e => [e.parent, state === 0 && engine.sameIndustry(c, e.parent) ? 0 : 1, e.qty]);
  for (let i = 0; i < queue.length; i++) for (const [parent, state] of next(...queue[i])) if (!visited[state].has(parent)) { visited[state].add(parent); queue.push([parent, state]); }
  queue.sort((a, b) => engine.orderIndex.get(b[0]) - engine.orderIndex.get(a[0]));
  for (const [c, state] of queue) {
    const edges = next(c, state), coeff = amounts[state].get(c) || 0;
    if (engine.dept(c) == null) unknown[state].add(c);
    if (state === 1 && !edges.length) targets.set(c, { code: c, coeff, kind: unknown[state].has(c) ? '产业未确认' : '跨产业链顶端' });
    for (const [parent, ps, qty] of edges) { const value = (amounts[ps].get(parent) || 0) + coeff * qty; if (!Number.isFinite(value)) throw Error('BOM累计用量超出计算范围'); amounts[ps].set(parent, value); if (unknown[state].has(c)) unknown[ps].add(parent); }
  }
  return [...targets.values()];
}

function decorate(engine, base, month, span, months, mode, source, periodMode = 'individual') {
  const links = relations(engine, base.code, mode);
  const targets = links.map(link => ({ ...link, make_dept: engine.dept(link.code) || '',
    monthly: months.map(m => { const net = engine.net(link.code, m); return { month: m, forecast: net.raw, remove: net.remove, netDemand: net.demand, demand: net.demand == null ? null : net.demand * link.coeff }; }) }));
  const applicable = targets.length > 0;
  const monthSet = new Set(engine.months);
  const monthly = months.map((m, i) => {
    const own = monthSet.has(m) ? engine.row(base.code, m, 'direct', source) : { known: false, raw: null, add: null, remove: null, supply: null, inventory: engine.inventoryDates.has(m + '-01') ? engine.inventory.get(JSON.stringify([base.code, m + '-01'])) || 0 : null, risks: [], sites: C.siteSummary([]) };
    const demandKnown = targets.every(t => t.kind !== '产业未确认' && t.monthly[i].demand != null);
    const demand = applicable && demandKnown ? targets.reduce((sum, t) => sum + t.monthly[i].demand, 0) : null;
    if (demand != null && !Number.isFinite(demand)) throw Error('BOM累计需求超出计算范围');
    const complete = monthSet.has(m) && own.supply != null && demandKnown;
    const gap = !applicable ? 0 : complete ? demand - own.supply : null;
    const inventoryIncluded = periodMode === 'cumulative' || i === 0;
    const risks = own.risks.filter(r => r !== '预测总量不足' && r !== '预测或产业数据不完整');
    if (!complete) risks.unshift('预测或产业数据不完整');
    if (gap > C.EPS) risks.unshift('预测总量不足');
    return { month: m, raw: own.known ? own.raw : null, add: own.add, remove: own.remove, supply: own.supply, demand, gap, inventoryIncluded, inventory: inventoryIncluded ? own.inventory : null, coverageGap: !inventoryIncluded ? null : !applicable ? 0 : gap != null && own.inventory != null ? gap - own.inventory : null, complete, risks, sites: own.sites.sites, siteCount: own.sites.count, maxShare: own.sites.maxShare, unassigned: own.sites.unassigned };
  });
  const complete = months.length === span && monthly.every(r => r.complete);
  const sum = key => monthly.every(r => r[key] != null) && months.length === span ? monthly.reduce((s, r) => s + r[key], 0) : null;
  const supply = sum('supply'), demand = applicable ? sum('demand') : null;
  const gap = !applicable ? 0 : complete ? demand - supply : null;
  const inventory = monthly[0]?.inventory ?? null;
  let water = inventory, firstShortage = null;
  if (applicable) for (const r of monthly) {
    water = water != null && r.complete ? water + r.supply - r.demand : null;
    if (water != null && water < -C.EPS && !firstShortage) firstShortage = r.month;
  }
  const periodSites = C.siteSummary(monthly.flatMap(r => r.sites.map(site => ({ qty: site.qty, site_code: site.code, site_name: site.name }))), monthly.reduce((sum, r) => sum + r.unassigned, 0));
  const risks = [...new Set(monthly.flatMap(r => r.risks))].filter(r => !['预测总量不足', '预测或产业数据不完整', '当月单一加工地', '加工地高度集中'].includes(r));
  if (periodSites.single) risks.push('期间单一加工地');
  if (periodSites.count > 1 && periodSites.maxShare >= engine.cfg.concentration) risks.push('加工地高度集中');
  if (!complete) risks.unshift('预测或产业数据不完整');
  if (gap > C.EPS) risks.unshift('预测总量不足');
  for (const target of targets) target.demand = target.monthly.length === span && target.monthly.every(r => r.demand != null) ? target.monthly.reduce((s, r) => s + r.demand, 0) : null;
  const aggregate = { raw: sum('raw'), add: sum('add'), remove: sum('remove'), supply, demand, gap, inventory, coverageGap: !applicable ? 0 : gap != null && inventory != null ? gap - inventory : null, firstShortage, complete, risks, sites: periodSites.sites, siteCount: periodSites.count, maxShare: periodSites.maxShare };
  const periods = periodMode === 'cumulative' ? [{ ...aggregate, inventoryIncluded: true, start: months[0], end: months.at(-1), label: periodLabel(months[0], months.at(-1)) }] : monthly.map(r => ({ ...r, start: r.month, end: r.month, label: periodLabel(r.month, r.month) }));
  return { ...base, ...aggregate, applicable, targets, targetCount: targets.length, periodMode, periods, monthly: span > 1 ? monthly : undefined };
}
function periodLabel(start, end) {
  const [sy, sm] = start.split('-'), [ey, em] = end.split('-');
  if (start === end) return `${sy}年${Number(sm)}月`;
  return sy === ey ? `${sy}年${Number(sm)}-${Number(em)}月` : `${sy}年${Number(sm)}月-${ey}年${Number(em)}月`;
}
module.exports = { relations, decorate, view, periodLabel };
