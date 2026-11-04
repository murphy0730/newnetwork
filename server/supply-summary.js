'use strict';
const C = require('../forecast-core');
const Query = require('./query-index');
const cache = new WeakMap();
const bottomRanks = new WeakMap();
const adjustmentActivity = new WeakMap();
const sourceMatches = new WeakMap();
const periodScores = new WeakMap();

function sortSuppliers(rows, engine, scores) {
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
  return rows.sort((a, b) => {
    const ag = scores ? scores.get(a.code) : a.gap, bg = scores ? scores.get(b.code) : b.gap;
    const as = ag > C.EPS, bs = bg > C.EPS;
    if (as !== bs) return Number(bs) - Number(as);
    if (as && Math.abs(bg - ag) > C.EPS) return bg - ag;
    return ranks.get(a.code) - ranks.get(b.code) || Number(b.applicable) - Number(a.applicable) || Number(!!b.known) - Number(!!a.known) || a.code.localeCompare(b.code);
  });
}

function sortForPeriods(engine, rows, months, mode, source, periodMode) {
  if (months.length <= 1) return rows; // 单月已由view全局排序。
  let cache = periodScores.get(engine); if (!cache) periodScores.set(engine, cache = new Map());
  const key = JSON.stringify([months, mode, source, periodMode]);
  let scores = cache.get(key); if (!scores) { scores = new Map(); Query.lru(cache, key, scores, 4); }
  const missing = rows.filter(row => !scores.has(row.code)), cumulative = periodMode === 'cumulative';
  for (const row of missing) scores.set(row.code, cumulative ? 0 : null);
  for (const month of months) {
    const covered = engine.months.includes(month);
    for (const row of missing) {
      const gap = !row.applicable ? 0 : month === months[0] ? row.gap : covered ? engine.row(row.code, month, mode, source).gap : null;
      const previous = scores.get(row.code);
      scores.set(row.code, cumulative ? previous == null || gap == null ? null : previous + gap : gap == null ? previous : previous == null ? gap : Math.max(previous, gap));
    }
  }
  return sortSuppliers([...rows], engine, scores);
}

function view(engine, month, mode, source) {
  engine.refreshInventory();
  let views = cache.get(engine); if (!views) cache.set(engine, views = new Map());
  const key = JSON.stringify([month, mode, source, engine.inventorySnapshotDate]);
  if (views.has(key)) return Query.lru(views, key, views.get(key), 2);
  const input = Query.view(engine, month, mode, source);
  const rows = sortSuppliers(input.rows.map(row => {
    const applicable = engine.graph.parents.get(row.code).length > 0;
    return { ...row, applicable, demand: applicable ? row.demand : null, gap: applicable ? row.gap : 0, coverageGap: applicable ? row.coverageGap : 0 };
  }), engine);
  const byCode = new Map(rows.map(r => [r.code, r]));
  return Query.lru(views, key, { rows, byCode, filters: new Map(), dashboard: Query.summarize(rows, engine) }, 2);
}

function relations(engine, code, mode, month) {
  return engine.relations(code, mode, month, true);
}

function sourceIndustries(engine, months, mode) {
  return [...new Set(engine.graph.order.filter(code => engine.graph.children.get(code).length && (mode === 'direct' || !engine.graph.parents.get(code).length || (mode === 'cross' && months.some(m => engine.byCodeMonth.has(JSON.stringify([code, m])))))).map(code => engine.dept(code)))].sort();
}

function filterSourceIndustry(engine, rows, months, mode, industry) {
  if (!industry) return rows;
  let cache = sourceMatches.get(engine); if (!cache) sourceMatches.set(engine, cache = new Map());
  const key = JSON.stringify([months, mode, industry]);
  let matches = cache.get(key);
  if (!matches) {
    const order = engine.graph.order, depts = order.map(code => engine.dept(code));
    const cross = mode === 'cross', scopes = cross ? new Set(depts) : [null], incoming = new Uint8Array(order.length);
    matches = new Set();
    // 仅传播是否存在指定产业来源，不展开全量编码之间的来源关系。
    for (const month of months) {
      const known = cross ? order.map(code => engine.byCodeMonth.has(JSON.stringify([code, month]))) : [];
      for (const dept of scopes) {
        incoming.fill(0);
        for (let i = 0; i < order.length; i++) {
          const code = order[i], root = !engine.graph.parents.get(code).length;
          if (incoming[i] && (!cross || depts[i] === dept)) matches.add(code);
          const originate = mode === 'direct' || root || (cross && depts[i] !== dept && known[i]);
          const outgoing = originate ? depts[i] === industry : incoming[i];
          if (outgoing) for (const edge of engine.graph.children.get(code)) incoming[engine.orderIndex.get(edge.child)] = 1;
        }
      }
    }
    Query.lru(cache, key, matches, 4);
  }
  return rows.filter(row => matches.has(row.code));
}

function decorate(engine, base, month, span, months, mode, source, periodMode = 'individual') {
  // 展示判断取原始表2；net模式不重复应用调整，但非零调整记录仍应保留展示。
  let activeAdjustments = adjustmentActivity.get(engine);
  if (!activeAdjustments) {
    activeAdjustments = new Set();
    for (const row of engine.t.adjust) if (row.qty) activeAdjustments.add(JSON.stringify([row.code, row.month]));
    adjustmentActivity.set(engine, activeAdjustments);
  }
  const monthSet = new Set(engine.months), targetMap = new Map();
  const linksByMonth = months.map(m => relations(engine, base.code, mode, m));
  for (const links of linksByMonth) for (const link of links) if (!targetMap.has(link.code)) {
    targetMap.set(link.code, { ...link, make_dept: engine.dept(link.code), monthly: [] });
  }
  const targets = [...targetMap.values()];
  for (let i = 0; i < months.length; i++) {
    const m = months[i], links = new Map(linksByMonth[i].map(link => [link.code, link]));
    for (const target of targets) {
      const link = links.get(target.code), net = engine.net(target.code, m);
      const out = link ? engine.edgeDemand(target.code, base.code, m, mode) : null;
      target.monthly.push({ month: m, active: !!link, coeff: link?.coeff || 0, forecast: net.raw, remove: net.remove, netDemand: net.demand, demand: !monthSet.has(m) ? null : !link ? 0 : out.known ? out.value * link.coeff : null });
    }
  }
  for (const target of targets) {
    const coeffs = new Set(target.monthly.filter(r => r.active).map(r => r.coeff));
    target.coeff = coeffs.size === 1 ? coeffs.values().next().value : null;
    const inventory = engine.inventorySnapshotDate ? engine.inventory.get(JSON.stringify([target.code, engine.inventorySnapshotDate])) || 0 : null;
    target.empty = (inventory == null || inventory === 0) && target.monthly.every(r => (r.forecast == null || r.forecast === 0) && !activeAdjustments.has(JSON.stringify([target.code, r.month])));
  }
  const applicable = targets.length > 0;
  const monthly = months.map((m, i) => {
    const own = monthSet.has(m) ? engine.row(base.code, m, mode, source) : { known: false, raw: null, add: null, remove: null, supply: null, demand: null, gap: null, complete: false, inventory: engine.inventorySnapshotDate ? engine.inventory.get(JSON.stringify([base.code, engine.inventorySnapshotDate])) || 0 : null, risks: ['预测或产业数据不完整'], sites: C.siteSummary([]) };
    const inventoryIncluded = periodMode === 'cumulative' || i === 0;
    const monthApplicable = linksByMonth[i].length > 0;
    const gap = monthApplicable ? own.gap : 0;
    return { month: m, raw: own.known || own.zeroFilled ? own.raw : null, add: own.add, remove: own.remove, supply: own.supply, demand: monthApplicable ? own.demand : null, gap, inventoryIncluded, inventory: inventoryIncluded ? own.inventory : null, coverageGap: !inventoryIncluded ? null : !monthApplicable ? 0 : own.coverageGap, complete: own.complete, passThrough: !!own.passThrough, partial: !!own.partial, risks: own.risks, sites: own.sites.sites, siteCount: own.sites.count, maxShare: own.sites.maxShare, unassigned: own.sites.unassigned };
  });
  const complete = months.length === span && monthly.every(r => r.complete);
  const sum = key => monthly.every(r => r[key] != null) && months.length === span ? monthly.reduce((s, r) => s + r[key], 0) : null;
  const supply = sum('supply'), demand = applicable ? sum('demand') : null;
  // 保留每月已计算的结余；需求字段缺失时不丢弃独立存在的结余，也不将未知需求补0。
  const gap = !applicable ? 0 : complete && demand != null ? demand + (sum('remove') || 0) - supply : sum('gap');
  const inventory = monthly[0]?.inventory ?? null;
  // 库存结余也独立保留；累计时仅首月结余含库存，后续只叠加不含库存的缺口。
  const firstCoverage = monthly[0]?.coverageGap;
  const coverageGap = !applicable ? 0 : gap != null && inventory != null ? gap - inventory : firstCoverage != null && monthly.slice(1).every(r => r.gap != null) ? firstCoverage + monthly.slice(1).reduce((sum, r) => sum + r.gap, 0) : null;
  let water = inventory, firstShortage = null;
  if (applicable) for (const r of monthly) {
    water = water != null && r.complete ? water + r.supply - r.demand - (r.remove || 0) : null;
    if (water != null && water < -C.EPS && !firstShortage) firstShortage = r.month;
  }
  const periodSites = C.siteSummary(monthly.flatMap(r => r.sites.map(site => ({ qty: site.qty, site_code: site.code, site_name: site.name }))), monthly.reduce((sum, r) => sum + r.unassigned, 0));
  const risks = [...new Set(monthly.flatMap(r => r.risks))].filter(r => !['预测总量不足', '预测或产业数据不完整', '当月单一加工地', '加工地高度集中'].includes(r));
  if (periodSites.single) risks.push('期间单一加工地');
  if (periodSites.count > 1 && periodSites.maxShare >= engine.cfg.concentration) risks.push('加工地高度集中');
  if (!complete && !monthly.some(r => r.passThrough)) risks.unshift('预测或产业数据不完整');
  if (gap > C.EPS) risks.unshift('预测总量不足');
  for (const target of targets) target.demand = target.monthly.length === span && target.monthly.every(r => r.demand != null) ? target.monthly.reduce((s, r) => s + r.demand, 0) : null;
  const aggregate = { raw: sum('raw'), add: sum('add'), remove: sum('remove'), supply, demand, gap, inventory, coverageGap, firstShortage, complete, passThrough: monthly.some(r => r.passThrough), partial: monthly.some(r => r.partial), risks, sites: periodSites.sites, siteCount: periodSites.count, maxShare: periodSites.maxShare };
  const periods = periodMode === 'cumulative' ? [{ ...aggregate, inventoryIncluded: true, start: months[0], end: months.at(-1), label: periodLabel(months[0], months.at(-1)) }] : monthly.map(r => ({ ...r, start: r.month, end: r.month, label: periodLabel(r.month, r.month) }));
  const attr = engine.attributes.get(base.code) || {};
  return { ...base, part_category: attr.part_category || '', part_subcategory: attr.part_subcategory || '', make_obj_package1: attr.make_obj_package1 || '', ...aggregate, applicable, targets, targetCount: targets.length, periodMode, periods, monthly: span > 1 ? monthly : undefined };
}
function periodLabel(start, end) {
  const [sy, sm] = start.split('-'), [ey, em] = end.split('-');
  if (start === end) return `${sy}年${Number(sm)}月`;
  return sy === ey ? `${sy}年${Number(sm)}-${Number(em)}月` : `${sy}年${Number(sm)}月-${ey}年${Number(em)}月`;
}
module.exports = { relations, decorate, view, periodLabel, sourceIndustries, filterSourceIndustry, sortForPeriods };
