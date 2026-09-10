'use strict';
const C = require('../forecast-core');

// Server-only implementation. Keep the browser contract and shared business rules intact.
class Engine extends C.Engine {
  matrix(month, mode = 'cross', source = 'forecast') {
    const key = JSON.stringify([month, mode, source]);
    if (this.materialized.has(key)) return this.materialized.get(key);
    const numeric = new Float64Array(this.graph.order.length * 2);
    const unknown = new Uint8Array(this.graph.order.length);
    for (let i = 0; i < this.graph.order.length; i++) {
      const code = this.graph.order[i], net = this.net(code, month);
      const supplyKnown = source === 'mo' ? this.t.mo.length > 0 : net.known;
      numeric[i * 2 + 1] = Number(supplyKnown && !unknown[i]);
      const boundary = mode === 'direct' || !this.graph.parents.get(code).length || (mode === 'cross' && this.local(code) !== true);
      const outgoing = boundary ? (net.demand || 0) : numeric[i * 2];
      const known = boundary ? net.known && (mode !== 'cross' || this.local(code) !== undefined) : !unknown[i];
      for (const edge of this.graph.children.get(code)) {
        const j = this.orderIndex.get(edge.child), value = numeric[j * 2] + outgoing * edge.qty;
        if (!Number.isFinite(value)) throw Error('BOM累计需求超出计算范围');
        numeric[j * 2] = value;
        if (!known) unknown[j] = 1;
      }
    }
    this.materialized.set(key, numeric);
    return numeric;
  }
  row(code, month, mode = 'cross', source = 'forecast') {
    const index = this.orderIndex.get(code);
    if (index == null) return undefined;
    const key = JSON.stringify([month, mode, source]), cached = this.monthCache.get(key);
    if (cached) return cached.get(code);
    const numeric = this.matrix(month, mode, source), net = this.net(code, month);
    const moRows = this.moByCodeMonth.get(JSON.stringify([code, month])) || [];
    const own = source === 'mo' ? { ...net, supply: this.t.mo.length ? moRows.reduce((s, r) => s + r.qty, 0) : null, sites: C.siteSummary(moRows) } : net;
    const complete = !!numeric[index * 2 + 1], knownDemand = numeric[index * 2];
    const demand = complete ? knownDemand : null, gap = complete && this.graph.parents.get(code).length ? demand - own.supply : null;
    const snapshotDate = month + '-01', inventory = this.inventoryDates.has(snapshotDate) ? this.inventory.get(JSON.stringify([code, snapshotDate])) || 0 : null;
    if (!this.periodSiteCache.has(code)) this.periodSiteCache.set(code, C.siteSummary(this.byCode.get(code) || [], this.periodAdds.get(code) || 0));
    const attr = this.attributes.get(code) || {}, risks = [];
    if (!complete) risks.push('预测或产业数据不完整');
    if (gap > C.EPS) risks.push('预测总量不足');
    if (own.sites.single) risks.push('当月单一加工地');
    if (own.sites.count > 1 && own.sites.maxShare >= this.cfg.concentration) risks.push('加工地高度集中');
    if (own.sites.unassigned > C.EPS) risks.push('加工地未完整分配');
    if (attr.lead_cv != null && attr.lead_cv >= this.cfg.cv_threshold) risks.push('加工周期波动');
    if (attr.lead_mean == null) risks.push('加工周期未维护');
    return { code, attr, ...own, complete, demand, knownDemand, gap, inventory, snapshotDate, coverageGap: gap != null && inventory != null ? gap - inventory : null, coverage: demand > 0 ? own.supply / demand : null, periodSites: this.periodSiteCache.get(code), risks };
  }
  balance(code, month, mode = 'cross', source = 'forecast') {
    const key = JSON.stringify([month, mode, source]), cached = this.monthCache.get(key)?.get(code);
    if (cached) return { supply: cached.supply, demand: cached.demand, gap: cached.gap, single: cached.sites.single };
    const i = this.orderIndex.get(code), matrix = this.matrix(month, mode, source), net = this.net(code, month);
    const mo = source === 'mo' ? this.moByCodeMonth.get(JSON.stringify([code, month])) || [] : null;
    const supply = mo ? this.t.mo.length ? mo.reduce((s, r) => s + r.qty, 0) : null : net.supply;
    const demand = matrix[i * 2 + 1] ? matrix[i * 2] : null;
    return { supply, demand, gap: demand != null && this.graph.parents.get(code).length ? demand - supply : null, single: mo ? C.siteSummary(mo).single : net.sites.single };
  }
  compute(month, mode = 'cross', source = 'forecast') {
    const key = JSON.stringify([month, mode, source]);
    if (this.monthCache.has(key)) return this.monthCache.get(key);
    this.matrix(month, mode, source);
    const rows = new Map();
    for (const code of this.graph.order) rows.set(code, this.row(code, month, mode, source));
    if (this.monthCache.size >= 2) this.monthCache.delete(this.monthCache.keys().next().value);
    this.monthCache.set(key, rows);
    return rows;
  }
  precompute() {
    const started = Date.now(), sources = this.t.mo.length ? ['forecast', 'mo'] : ['forecast'];
    for (const month of this.months) for (const mode of ['direct', 'cross', 'top']) for (const source of sources) this.matrix(month, mode, source);
    // Aggregation is persisted as compact numeric matrices; decorate only requested rows.
    this.netCache.clear();
    return { milliseconds: Date.now() - started, cells: this.graph.codes.length * this.months.length * 3 * sources.length, matrices: this.materialized.size };
  }
  paths(root, month, mode, source = 'forecast') {
    const descendants = this.descendantCodes(root), active = new Set(), riskNodes = [];
    for (const code of descendants) if (this.row(code, month, mode, source)?.risks.length) { active.add(code); riskNodes.push(code); }
    for (const code of [...descendants].sort((a, b) => this.orderIndex.get(b) - this.orderIndex.get(a))) {
      if (this.graph.children.get(code).some(edge => active.has(edge.child))) active.add(code);
    }
    const edges = [];
    for (const code of descendants) for (const edge of this.graph.children.get(code)) if (active.has(edge.child)) edges.push(edge);
    return { critical: this.criticalCache.get(root), riskNodes, edges, active };
  }
  cumulative(code, start, count, mode) {
    const startIndex = this.months.indexOf(start), months = this.months.slice(startIndex, startIndex + count), rows = months.map(m => this.row(code, m, mode));
    const complete = months.length === count && rows.every(r => r.complete), inv = rows[0]?.inventory;
    const demand = complete ? rows.reduce((s, r) => s + r.demand, 0) : null, supply = complete ? rows.reduce((s, r) => s + r.supply, 0) : null;
    let water = inv, minWater = inv, firstShortage = null;
    for (let i = 0; i < rows.length; i++) { const r = rows[i]; if (water == null || !r.complete) { water = null; minWater = null; continue; } water += r.supply - r.demand; minWater = Math.min(minWater, water); if (water < -C.EPS && !firstShortage) firstShortage = months[i]; }
    return { months, complete, demand, supply, inventory: inv, gap: complete ? demand - supply : null, coverageGap: complete && inv != null ? demand - supply - inv : null, firstShortage, minWater: complete ? minWater : null };
  }
}
module.exports = Engine;
