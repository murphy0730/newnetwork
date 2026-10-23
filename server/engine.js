'use strict';
const C = require('../forecast-core');

// Server-only implementation. Keep the browser contract and shared business rules intact.
class Engine extends C.Engine {
  static restore(snapshot, version, artifact) {
    // Rehydrate saved topology, critical paths and matrices. Never invoke topology/precompute.
    const e = Object.create(Engine.prototype), m = artifact.manifest, saved = artifact.graph(snapshot);
    Object.assign(e, { snapshot, t: snapshot.tables, cfg: { ...C.defaults, ...snapshot.config }, graph: saved.graph, criticalCache: saved.critical, versions: m.versions, version: version || m.versions.at(-1), sealed: true });
    e.months = m.monthsByVersion[e.version] || [];
    e.attributes = new Map(e.t.attributes.map(r => [r.code, r]));
    e.orderIndex = new Map(e.graph.order.map((code, i) => [code, i]));
    e.forecast = []; e.byCodeMonth = new Map(); e.byCode = new Map();
    for (const r of e.t.forecast) if (r.plan_date === e.version) { e.forecast.push(r); const key = JSON.stringify([r.code, r.month]); if (!e.byCodeMonth.has(key)) e.byCodeMonth.set(key, []); e.byCodeMonth.get(key).push(r); if (!e.byCode.has(r.code)) e.byCode.set(r.code, []); e.byCode.get(r.code).push(r); }
    e.inventory = new Map(); e.inventoryDates = new Set(); e.excludedInventory = 0;
    for (const r of e.t.inventory) { e.inventoryDates.add(r.date); if (/^(生产-三品|备件-)/.test(r.sub_type)) { e.excludedInventory++; continue; } const key = JSON.stringify([r.code, r.date]); e.inventory.set(key, (e.inventory.get(key) || 0) + r.qty); }
    // 表4取值规则：快照按日刷新（每日零点一版），取「当日最新」——不晚于今天的最大快照日期；无则库存未知
    e.inventorySnapshotDate = null;
    for (const d of e.inventoryDates) if (d <= C.today() && (!e.inventorySnapshotDate || d > e.inventorySnapshotDate)) e.inventorySnapshotDate = d;
    e.adjustments = new Map(); e.periodAdds = new Map();
    if (e.cfg.input_mode === 'raw') for (const r of e.t.adjust) { const key = JSON.stringify([r.code, r.month]); if (!e.adjustments.has(key)) e.adjustments.set(key, { add: 0, remove: 0 }); e.adjustments.get(key)[r.direction === '供应' ? 'add' : 'remove'] += r.qty; }
    for (const [key, adj] of e.adjustments) { const [code, month] = JSON.parse(key); if (e.months.includes(month)) e.periodAdds.set(code, (e.periodAdds.get(code) || 0) + adj.add); }
    e.moByCodeMonth = new Map();
    for (const r of e.t.mo) if (!r.actual_date && !/取消|关闭|完成|cancel|closed|complete/i.test(r.status || '')) { const key = JSON.stringify([r.code, (r.sched_date || r.due_date).slice(0, 7)]); if (!e.moByCodeMonth.has(key)) e.moByCodeMonth.set(key, []); e.moByCodeMonth.get(key).push({ ...r, site_name: r.site_name || r.site_code }); }
    for (const cache of ['relationCache', 'monthCache', 'netCache', 'periodSiteCache']) e[cache] = new Map();
    const derived = artifact.derived(e.version); e.materialized = derived.materialized; e.precomputed = { ...derived.stats, restored: true, buildId: m.buildId };
    return e;
  }
  matrix(month, mode = 'cross', source = 'forecast') {
    const key = JSON.stringify([month, mode, source]);
    if (this.materialized.has(key)) return this.materialized.get(key);
    if (this.sealed) throw Object.assign(Error('已装载产物缺少所需计算结果，请重新构建；在线查询不会自动重算'), { status: 503, code: 'BUILD_REQUIRED' });
    return super.matrix(month, mode, source);
  }
  balance(code, month, mode = 'cross', source = 'forecast') {
    const r = this.row(code, month, mode, source);
    return { supply: r.supply, demand: r.demand, gap: r.gap, single: r.sites.single, partial: r.partial };
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
    const demand = complete ? rows.reduce((s, r) => s + r.demand, 0) : null, remove = complete ? rows.reduce((s, r) => s + r.remove, 0) : null, supply = complete ? rows.reduce((s, r) => s + r.supply, 0) : null;
    let water = inv, minWater = inv, firstShortage = null;
    for (let i = 0; i < rows.length; i++) { const r = rows[i]; if (water == null || !r.complete) { water = null; minWater = null; continue; } water += r.supply - r.demand - r.remove; minWater = Math.min(minWater, water); if (water < -C.EPS && !firstShortage) firstShortage = months[i]; }
    const total = complete ? demand + remove : null;
    return { months, complete, demand, supply, inventory: inv, gap: complete ? total - supply : null, coverageGap: complete && inv != null ? total - supply - inv : null, firstShortage, minWater: complete ? minWater : null };
  }
}
module.exports = Engine;
