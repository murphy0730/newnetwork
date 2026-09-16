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

// Propagate demand through the supplier's industry; crossing an industry boundary
// starts from that immediate parent's own net forecast. O(V+E) per month.
function view(engine, month, mode, source) {
  let views = cache.get(engine); if (!views) cache.set(engine, views = new Map());
  const key = JSON.stringify([month, mode, source]);
  if (views.has(key)) return Query.lru(views, key, views.get(key), 2);
  const input = Query.view(engine, month, mode === 'cross' ? 'direct' : mode, source);
  let byCode;
  if (mode === 'cross') {
    const external = new Map(); byCode = new Map();
    for (const code of engine.graph.order) {
      const parents = engine.graph.parents.get(code);
      const cross = { amount: 0, known: true, applicable: false };
      for (const edge of parents) {
        const sameDept = engine.sameIndustry(edge.parent, code);
        const net = sameDept ? null : engine.net(edge.parent, month);
        const p = sameDept ? external.get(edge.parent) : { amount: Math.abs(net.demand || 0), known: net.known && engine.dept(edge.parent) != null, applicable: true };
        cross.amount += p.amount * edge.qty;
        cross.known &&= p.known && engine.dept(code) != null;
        cross.applicable ||= !sameDept || p.applicable;
      }
      if (!Number.isFinite(cross.amount)) throw Error('BOM累计需求超出计算范围');
      external.set(code, cross);
    }
    for (const row of input.rows) { const x = external.get(row.code); byCode.set(row.code, replaceDemand(row, x.amount, x.applicable, x.known)); }
  } else {
    const totals = new Map();
    for (const code of engine.graph.order) {
      const total = { amount: 0, known: true };
      for (const edge of engine.graph.parents.get(code)) {
        const net = engine.net(edge.parent, month);
        const p = mode === 'direct' || !engine.graph.parents.get(edge.parent).length ? { amount: Math.abs(net.demand || 0), known: net.known } : totals.get(edge.parent);
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
  // Reuse the graph/insights frontier, stopping at the first different make_dept.
  // A same-industry root is not a cross-industry demand source for this table.
  return engine.relations(code, mode).filter(link => link.kind !== '本产业最顶层');
}

function decorate(engine, base, month, span, months, mode, source, periodMode = 'individual') {
  const links = relations(engine, base.code, mode);
  const targets = links.map(link => ({ ...link, make_dept: engine.dept(link.code) || '',
    monthly: months.map(m => { const net = engine.net(link.code, m); return { month: m, forecast: net.raw, remove: net.remove, netDemand: net.demand, demand: net.demand == null ? null : Math.abs(net.demand) * link.coeff }; }) }));
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
