'use strict';
const { randomUUID } = require('node:crypto');
const Store = require('./store');
const Importer = require('./importer');
const C = require('../forecast-core');
const Engine = require('./engine');
const error = (message, status = 400, details) => Object.assign(Error(message), { status, details });
const int = (x, fallback, min, max) => { if (x == null || x === '') return fallback; const n = Number(x); if (!Number.isInteger(n) || n < min || n > max) throw error(`整数参数超出范围${min}~${max}`); return n; };
function checkConfig(cfg) {
  if (!['net', 'raw'].includes(cfg.input_mode)) throw error('预测输入口径无效');
  if (!(Number.isFinite(cfg.cv_threshold) && cfg.cv_threshold >= 0 && cfg.cv_threshold <= 10)) throw error('CV阈值应为0~10');
  if (!(Number.isFinite(cfg.concentration) && cfg.concentration > 0 && cfg.concentration <= 1)) throw error('集中度阈值应为0~1');
}
function changesFor(base, body, version) {
  const next = { ...base, tables: { ...base.tables } }, changes = body.changes || [], seen = new Set();
  if (!Array.isArray(changes) || changes.length > 1000) throw error('每个推演最多1000项修改');
  if ((body.type || 'forecast') === 'forecast') {
    if (!changes.length) throw error('请提供至少一项预测修改');
    const rows = base.tables.forecast.slice(), index = new Map(), versionCodes = new Set();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]; if (r.plan_date !== version) continue;
      versionCodes.add(r.code); const k = JSON.stringify([r.code, r.month]);
      if (!index.has(k)) index.set(k, []); index.get(k).push(i);
    }
    for (const change of changes) {
      const month = C.date(change.month, true), code = String(change.code || ''), key = JSON.stringify([code, month, change.site_code || '']);
      if (seen.has(key)) throw error('同一编码/月份/加工地不能重复修改'); seen.add(key);
      if (!versionCodes.has(code)) throw error(`编码不在所选预测版本：${code}`);
      const matches = (index.get(JSON.stringify([code, month])) || []).filter(i => !change.site_code || rows[i].site_code === change.site_code);
      if (!matches.length) throw error(`${code} ${month}无对应预测，请先导入明确的零数量记录`);
      const total = matches.reduce((s, i) => s + rows[i].qty, 0), value = Number(change.value);
      if (!Number.isFinite(value)) throw error('推演修改值必须为有限数值');
      let target;
      if (change.operation === 'set') target = value;
      else if (change.operation === 'add') target = total + value;
      else if (change.operation === 'percent') target = total * (1 + value / 100);
      else throw error('推演操作须为set/add/percent');
      if (!Number.isFinite(target) || target < 0) throw error('修改后预测数量不能小于0或溢出');
      for (const i of matches) rows[i] = { ...rows[i], qty: total > 0 ? rows[i].qty * target / total : target / matches.length };
    }
    next.tables.forecast = rows;
  } else if (['quality', 'outage'].includes(body.type)) {
    const days = int(body.delayDays ?? body.days, 0, 0, 365), scrap = Number(body.scrapQty || 0), month = C.date(body.month, true);
    if (!Number.isFinite(scrap) || scrap < 0) throw error('报废数量须非负');
    if (body.type === 'quality' && !body.code) throw error('质量推演需指定编码');
    if (body.type === 'outage' && !body.site_code) throw error('停工推演需指定加工地代码');
    const match = r => body.type === 'quality' ? r.code === body.code : r.site_code === body.site_code;
    if (body.source === 'mo') {
      let remaining = scrap, matched = 0;
      next.tables.mo = base.tables.mo.slice().sort((a, b) => (a.sched_date || a.due_date).localeCompare(b.sched_date || b.due_date)).map(r => {
        if (!match(r) || r.actual_date || /取消|关闭|完成|cancel|closed|complete/i.test(r.status || '') || (r.sched_date || r.due_date).slice(0, 7) !== month) return r;
        matched++; const cut = Math.min(r.qty, remaining); remaining -= cut;
        return { ...r, qty: r.qty - cut, sched_date: new Date(Date.parse((r.sched_date || r.due_date) + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10) };
      });
      if (!matched) throw error('该月没有匹配的未完工指令'); if (remaining > C.EPS) throw error('报废数量超过该月可扣减指令数量');
    } else {
      const matches = base.tables.forecast.filter(r => r.plan_date === version && r.month === month && match(r));
      if (!matches.length) throw error('该月没有匹配的预测产出');
      const total = matches.reduce((s, r) => s + r.qty, 0); if (scrap > total + C.EPS) throw error('损失数量超过该月预测');
      const dayCount = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).getUTCDate(), matched = new Set(matches), rows = [];
      // Monthly forecast has no intramonth schedule: explicitly assume uniform daily output.
      for (const r of base.tables.forecast) {
        if (!matched.has(r)) { rows.push(r); continue; }
        const qty = total > 0 ? r.qty * (1 - scrap / total) : 0, buckets = new Map([[month, 0]]);
        for (let d = 0; d < dayCount; d++) { const target = new Date(Date.parse(month + '-01T00:00:00Z') + (d + days) * 86400000).toISOString().slice(0, 7); buckets.set(target, (buckets.get(target) || 0) + qty / dayCount); }
        for (const [m, q] of buckets) rows.push({ ...r, month: m, qty: q });
      }
      next.tables.forecast = rows;
    }
  } else throw error('未知推演类型');
  const validation = C.validate(next); if (validation.errors.length) throw error('推演数据校验失败', 422, validation.errors.slice(0, 100));
  return next;
}
class Service {
  constructor(dbPath) { this.store = new Store(dbPath); this.cached = null; this.engines = new Map(); this.files = new Map(); this.previews = new Map(); }
  preload(filename, revision) {
    const artifact = this.store.openArtifact(filename), snapshot = artifact.load(revision), engine = Engine.restore(snapshot, undefined, artifact);
    this.cached = snapshot; this.cacheEngine(JSON.stringify([revision, engine.version, '']), engine);
    return { buildId: artifact.manifest.buildId, codes: engine.graph.codes.length };
  }
  state(revision) {
    const rev = revision == null ? this.store.revision() : Number(revision);
    if (this.cached?.revision === rev) return this.cached;
    const s = this.store.load(rev); if (revision == null) this.cached = s; return s;
  }
  engine(q = {}, actor = 'local') {
    // Check ownership even for a cached scenario; resolve its pinned revision first.
    const scenario = q.scenario ? this.store.scenario(q.scenario, actor) : null;
    const revision = scenario ? scenario.revision : q.revision == null || q.revision === '' ? this.store.revision() : int(q.revision, 0, 0, 1e9);
    let version = scenario ? scenario.request.version : q.version;
    const existing = this.engines.get(JSON.stringify([revision, version, q.scenario || '']));
    if (existing) return existing;
    let snap = this.state(revision);
    version ||= [...new Set(snap.tables.forecast.map(r => r.plan_date))].sort().at(-1);
    const key = JSON.stringify([snap.revision, version, q.scenario || '']);
    if (!this.engines.has(key)) {
      const baseline = scenario ? this.engine({ revision, version }, actor) : null;
      if (scenario) snap = changesFor(snap, scenario.request, version);
      if (version && !snap.tables.forecast.some(r => r.plan_date === version)) throw error('预测版本不存在', 404);
      const artifact = !scenario ? this.store.artifact(revision) : null;
      if (!scenario && version && !artifact) throw error('当前数据缺少离线构建产物，请从数据管理启动重建', 503);
      const e = artifact ? Engine.restore(snap, version, artifact) : new Engine(snap, version, baseline?.graph);
      if (scenario) this.reuseMatrices(baseline, e, scenario.request);
      this.cacheEngine(key, e);
    }
    return this.engines.get(key);
  }
  cacheEngine(key, engine) {
    if (!this.engines.has(key) && this.engines.size >= 2) {
      // Consecutive what-if requests should keep the reusable baseline in memory.
      const discard = [...this.engines.keys()].find(k => JSON.parse(k)[2]) || this.engines.keys().next().value;
      this.engines.delete(discard);
    }
    this.engines.set(key, engine);
  }
  reuseMatrices(before, after, request) {
    const touched = new Set((request.changes || []).map(c => C.date(c.month, true)));
    if (request.type === 'quality' || request.type === 'outage') {
      touched.add(C.date(request.month, true));
      const table = request.source === 'mo' ? 'mo' : 'forecast', original = new Set(before.t[table]);
      for (const r of after.t[table]) if (!original.has(r)) touched.add(table === 'mo' ? (r.sched_date || r.due_date).slice(0, 7) : r.month);
    }
    after.materialized = new Map([...before.materialized].filter(([k]) => !touched.has(JSON.parse(k)[0])));
    return touched;
  }
  context(q, actor) {
    const engine = this.engine(q, actor), month = q.month || engine.months[0], mode = q.mode || 'cross', source = q.source || 'forecast';
    if (!['direct', 'cross', 'top'].includes(mode) || !['forecast', 'mo'].includes(source)) throw error('分析口径无效');
    if (month) C.date(month, true);
    if (month && !engine.months.includes(month)) throw error('月份不在该预测版本内');
    return { engine, month, mode, source, trace: { revision: engine.snapshot.revision, version: engine.version || null, month: month || null, mode, source, scenario: q.scenario || null, input_mode: engine.cfg.input_mode, calculated_at: new Date().toISOString() } };
  }
  publish(next, expected, actor, action, prepared) {
    this.store.save(next, expected, actor, action, prepared); this.cached = null; this.engines.clear();
    return this.meta(actor);
  }
  meta(actor) {
    const revision = this.store.revision();
    if (this.metaCache?.revision === revision) return this.metaCache;
    this.metaCache = this.store.info();
    return this.metaCache;
  }
  list(q, actor) {
    const { engine, month, mode, source, trace } = this.context(q, actor); if (!month) return { trace, rows: [], total: 0, dashboard: {}, months: [] };
    const all = [...engine.compute(month, mode, source).values()];
    const dashboard = { total: all.length, shortage: all.filter(r => r.gap > C.EPS).length, coverageShortage: all.filter(r => r.coverageGap > C.EPS).length, single: all.filter(r => r.sites.single).length, concentrated: all.filter(r => r.sites.count > 1 && r.sites.maxShare >= engine.cfg.concentration).length, incomplete: all.filter(r => !r.complete).length, unknownSites: all.filter(r => r.sites.unassigned > C.EPS).length };
    const search = String(q.search || '').toLowerCase();
    let rows = q.role === 'demand' && q.code ? engine.downstream(q.code, month, mode).map(r => ({ ...engine.compute(month, mode, source).get(r.code), contribution: r.contribution, coeff: r.coeff })) : all;
    rows = rows.filter(r => (!search || [r.code, r.attr.name, r.attr.make_dept].some(v => String(v || '').toLowerCase().includes(search))) && (!q.site || r.sites.sites.some(s => s.key === q.site)) && (!q.industry || r.attr.make_dept === q.industry) && (!q.risk || (q.risk === 'shortage' ? r.gap > C.EPS : q.risk === 'coverage' ? r.coverageGap > C.EPS : q.risk === 'single' ? r.sites.single : q.risk === 'concentrated' ? r.sites.count > 1 && r.sites.maxShare >= engine.cfg.concentration : q.risk === 'incomplete' ? !r.complete : r.risks.length > 0)));
    rows.sort((a, b) => (b.gap ?? -Infinity) - (a.gap ?? -Infinity) || a.code.localeCompare(b.code));
    const total = rows.length, offset = int(q.offset, 0, 0, 1e9), limit = int(q.limit, 100, 1, 1000);
    return { trace, dashboard, total, offset, limit, months: engine.months, rows: rows.slice(offset, offset + limit).map(r => this.compact(r)), scopeNote: '筛选仅改变展示；每个下层的需求仍覆盖当前口径内全部上层，不进行缺口分配。' };
  }
  compact(r) { return { code: r.code, name: r.attr.name || '', make_dept: r.attr.make_dept || '', category: r.attr.part_category || '', supply: r.supply, demand: r.demand, gap: r.gap, inventory: r.inventory, coverageGap: r.coverageGap, complete: r.complete, siteCount: r.sites.count, single: r.sites.single, siteComplete: r.sites.complete, sites: r.sites.sites, maxShare: r.sites.maxShare, unassigned: r.sites.unassigned, periodSingle: r.periodSites.single, risks: r.risks, lead_mean: r.attr.lead_mean ?? null, lead_cv: r.attr.lead_cv ?? null, contribution: r.contribution, coeff: r.coeff }; }
  detail(q, actor) {
    const { engine: e, month, mode, source, trace } = this.context(q, actor), code = q.code;
    if (!e.graph.codes.includes(code)) throw error('编码不存在', 404);
    const row = e.row(code, month, mode, source), targets = e.relations(code, mode).map(r => { const net = e.net(r.code, month); return { ...r, forecast: net.raw, remove: net.remove, known: net.known, demand: net.demand == null ? null : net.demand * r.coeff, make_dept: e.attributes.get(r.code)?.make_dept || '' }; });
    const paths = e.paths(code, month, mode, source), details = e.months.map(m => { const r = e.row(code, m, mode, source); return { month: m, raw: r.raw, add: r.add, remove: r.remove, ...this.compact(r) }; });
    return { trace, ...this.compact(row), attributes: row.attr, raw: row.raw, add: row.add, remove: row.remove, targets: targets.slice(0, 1000), targetCount: targets.length, details, critical: paths.critical, riskNodes: paths.riskNodes.slice(0, 1000), riskNodeCount: paths.riskNodes.length, cumulative: source === 'forecast' ? e.cumulative(code, month, int(q.span, 3, 1, 120), mode) : null, periodSites: row.periodSites, parents: e.graph.parents.get(code).slice(0, 1000), children: e.graph.children.get(code).slice(0, 1000), sources: (e.byCodeMonth.get(JSON.stringify([code, month])) || []).slice(0, 100).map(r => ({ qty: r.qty, site_code: r.site_code, site_name: r.site_name, source: r._source })) };
  }
  graph(q, actor) {
    const { engine: e, month, mode, source, trace } = this.context(q, actor), all = e.compute(month, mode, source), limit = int(q.limit, 500, 1, 1000), depth = int(q.depth, 3, 1, 10);
    let visible, truncated = false;
    if (q.code && all.has(q.code)) {
      visible = new Set([q.code]); let queue = [q.code];
      for (let d = 0; d < depth; d++) { const next = []; for (const c of queue) for (const edge of [...e.graph.parents.get(c), ...e.graph.children.get(c)]) { const id = edge.parent === c ? edge.child : edge.parent; if (visible.has(id)) continue; if (visible.size >= limit) { truncated = true; continue; } visible.add(id); next.push(id); } queue = next; }
    } else {
      const list = this.list({ ...q, limit, offset: 0 }, actor);
      const filtered = !!(q.risk || q.search || q.site || q.industry);
      if (filtered) {
        // 风险/搜索等过滤视图严格只展示匹配节点
        visible = new Set(list.rows.map(r => r.code)); truncated = list.total > visible.size;
      } else {
        // 编码规模大时按缺口排序截取会只剩末端层级、链路断裂；先取高缺口编码，再沿折叠关系向上补齐父项，保住可视链路
        const primary = list.rows.slice(0, Math.floor(limit * 0.6));
        visible = new Set(primary.map(r => r.code)); truncated = list.total > visible.size;
        for (const r of primary) {
          for (const rel of e.relations(r.code, mode)) {
            if (visible.size >= limit) { truncated = true; break; }
            if (!visible.has(rel.code) && all.has(rel.code)) visible.add(rel.code);
          }
          if (visible.size >= limit) { truncated = true; break; }
        }
      }
    }
    const paths = q.code && all.has(q.code) ? e.paths(q.code, month, mode, source) : null, criticalEdges = new Set(), riskEdges = new Set();
    if (paths?.critical?.complete) for (let i = 1; i < paths.critical.path.length; i++) criticalEdges.add(JSON.stringify([paths.critical.path[i - 1], paths.critical.path[i]]));
    if (paths) for (const r of paths.edges) riskEdges.add(JSON.stringify([r.parent, r.child]));
    const raw = q.graphRelations === 'bom', links = [];
    for (const code of visible) {
      const rs = raw ? e.graph.parents.get(code).map(r => ({ code: r.parent, coeff: r.qty, kind: 'BOM' })) : e.relations(code, mode);
      for (const r of rs) if (visible.has(r.code)) links.push({ source: r.code, target: code, qty: r.coeff, kind: r.kind, critical: criticalEdges.has(JSON.stringify([r.code, code])), risk: riskEdges.has(JSON.stringify([r.code, code])) });
    }
    return { trace, nodes: [...visible].map(code => ({ ...this.compact(all.get(code)), level: e.graph.level.get(code), local: e.local(code) ?? null })), edges: links.slice(0, 5000), truncated: truncated || links.length > 5000, totalNodes: e.graph.codes.length, critical: paths?.critical, relationNote: raw ? '真实BOM链路，用于完整周期与风险路径' : '按分析口径折叠关系；查看路径时自动切换真实BOM' };
  }
  report(q, actor) {
    const { engine: e, month, mode, source, trace } = this.context(q, actor), rows = [...e.compute(month, mode, source).values()], sites = new Map();
    for (const r of rows) for (const s of r.sites.sites) { if (!sites.has(s.key)) sites.set(s.key, { code: s.key, name: s.name, codes: 0, single: 0, shortage: 0, quantity: 0 }); const x = sites.get(s.key); x.codes++; x.quantity += s.qty; if (r.sites.single) x.single++; if (r.gap > C.EPS) x.shortage++; }
    const top = rows.filter(r => r.gap > C.EPS).sort((a, b) => b.gap - a.gap).slice(0, 20);
    const heatCodes = top.slice(0, 12).map(r => r.code), matrix = e.months.map(m => { return heatCodes.map(c => e.row(c, m, mode, source).gap); });
    return { trace, sites: [...sites.values()].sort((a, b) => b.shortage - a.shortage), top: top.map(r => this.compact(r)), single: rows.filter(r => r.sites.single).slice(0, 200).map(r => this.compact(r)), singleTotal: rows.filter(r => r.sites.single).length, heatmap: heatCodes.map((code, i) => ({ code, cells: matrix.map(row => row[i]) })), months: e.months, note: '加工地数量为当前月计划安排；无历史指令时不生成交期健康度结论。' };
  }
  simulate(body, actor) {
    const base = this.state(body.baseRevision == null ? undefined : int(body.baseRevision, 0, 0, 1e9)), version = body.version || [...new Set(base.tables.forecast.map(r => r.plan_date))].sort().at(-1);
    const request = { ...body, version }, after = changesFor(base, request, version), beforeEngine = this.engine({ revision: base.revision, version }, actor), afterEngine = new Engine(after, version, beforeEngine.graph);
    const month = body.month || beforeEngine.months[0], mode = body.mode || 'cross', source = body.source || 'forecast';
    if (!['direct', 'cross', 'top'].includes(mode) || !['forecast', 'mo'].includes(source)) throw error('推演口径无效');
    const touched = this.reuseMatrices(beforeEngine, afterEngine, request);
    const months = [...touched].sort(), affected = [], adverse = new Set(), changedCodes = new Set();
    let outsideHorizon;
    for (const m of months) {
      const comparison = beforeEngine.months.includes(m) ? beforeEngine : (outsideHorizon ||= new Engine(base, version, beforeEngine.graph));
      comparison.matrix(m, mode, source); afterEngine.matrix(m, mode, source);
      for (const code of afterEngine.graph.order) { const b = comparison.balance(code, m, mode, source), r = afterEngine.balance(code, m, mode, source); const gapChanged = b.gap !== r.gap && (b.gap == null || r.gap == null || Math.abs(b.gap - r.gap) > C.EPS), supplyChanged = b.supply !== r.supply && (b.supply == null || r.supply == null || Math.abs(b.supply - r.supply) > C.EPS);
        if (gapChanged || supplyChanged || b.single !== r.single) { changedCodes.add(code); const worse = r.gap != null && (b.gap == null || r.gap > b.gap + C.EPS); if (worse) adverse.add(code); affected.push({ code, month: m, beforeSupply: b.supply, afterSupply: r.supply, beforeDemand: b.demand, afterDemand: r.demand, beforeGap: b.gap, afterGap: r.gap, worse, risks: afterEngine.row(code, m, mode, source).risks }); }
      }
    }
    const upstream = new Set(adverse), queue = [...adverse];
    for (let i = 0; i < queue.length; i++) for (const r of beforeEngine.graph.parents.get(queue[i]) || []) if (!upstream.has(r.parent)) { upstream.add(r.parent); queue.push(r.parent); }
    const id = randomUUID(); this.store.scenarioSave(id, actor, base.revision, request);
    this.cacheEngine(JSON.stringify([base.revision, version, id]), afterEngine);
    affected.sort((a, b) => Number(b.worse) - Number(a.worse) || (b.afterGap || 0) - (a.afterGap || 0));
    return { id, trace: { revision: base.revision, version, month, mode, source, scenario: id }, changedCodes: changedCodes.size, affectedRows: affected.length, affected: affected.slice(0, 500), upstreamCount: upstream.size, upstream: [...upstream].slice(0, 500), assumption: body.type === 'quality' || body.type === 'outage' ? source === 'mo' ? '只修改匹配月份未完工指令；按实际计划日期顺延。' : '月度预测按每日均匀产出估算延期；调整产出计划同时影响其供应与使用角色。' : '按指定编码/月份修改预测；未指定加工地时按原加工地数量占比分摊修改量。', note: '基线未修改。关联上层表示需关注的链路，不代表已分配缺口或确定停产。' };
  }
  upload(body, actor) {
    this.expire(); if (this.files.size >= 16) throw error('待导入文件过多，请完成或等待30分钟过期', 429);
    const sheets = Importer.readFile(body.name, body.bytes), id = randomUUID();
    const cells = sheets.reduce((sum, s) => sum + s.matrix.reduce((n, row) => n + row.length, 0), 0);
    this.files.set(id, { actor, name: body.name, sheets, cells, expires: Date.now() + 1800000 });
    return { id, name: body.name, sheets: sheets.map(s => ({ name: s.name, rows: Math.max(0, s.matrix.length - 1), detected: s.detected, preview: s.matrix.slice(0, 5) })) };
  }
  expire() { for (const map of [this.files, this.previews]) for (const [k, v] of map) if (v.expires < Date.now()) map.delete(k); }
  preview(body, actor) {
    this.expire(); const current = this.state(); if (body.baseRevision !== current.revision) throw error('数据版本已变化，请刷新后重新导入', 409);
    const batches = [], errors = [], summaries = [];
    if (body.batches) for (const b of body.batches) { const parsed = Importer.publicRows(b.table, b.rows); errors.push(...parsed.errors); batches.push({ table: b.table, rows: parsed.rows }); summaries.push({ table: b.table, rows: parsed.rows.length }); }
    for (const f of body.files || []) {
      const file = this.files.get(f.id); if (!file || file.actor !== actor) throw error('上传文件已过期或不可访问', 404);
      for (const selection of f.selections) {
        if (!selection.table) continue; const sheet = file.sheets.find(s => s.name === selection.sheet); if (!sheet || !C.schemas[selection.table]) throw error('工作表或目标表无效');
        const parsed = C.parseMatrix(selection.table, sheet.matrix, { file: file.name, sheet: sheet.name, date1904: sheet.date1904, headerRow: int(selection.headerRow, sheet.detected?.headerRow || 0, 0, 9) });
        errors.push(...parsed.errors); batches.push({ table: selection.table, rows: parsed.rows }); summaries.push({ file: file.name, sheet: sheet.name, table: selection.table, rows: parsed.rows.length });
      }
    }
    if (!batches.length) throw error('请至少选择一张工作表');
    if (errors.length) throw error(`导入校验失败，共${errors.length}项错误`, 422, errors.slice(0, 1000));
    const next = require('./import-stream').merge(current, batches), prep = { next, ...C.validate(next) }; if (prep.errors.length) throw error('关联校验失败', 422, prep.errors.slice(0, 1000));
    const e = new Engine(prep.next);
    const stats = e.precompute();
    const id = randomUUID(); if (this.previews.size >= 4) this.previews.delete(this.previews.keys().next().value);
    this.previews.set(id, { actor, next: prep.next, prepared: { version: e.version, materialized: e.materialized, stats }, baseRevision: current.revision, expires: Date.now() + 1800000 });
    return { previewId: id, baseRevision: current.revision, summaries, warnings: prep.warnings, replacesSample: current.kind === 'sample', counts: Object.fromEntries(Object.entries(prep.next.tables).map(([k, v]) => [k, v.length])) };
  }
  commit(body, actor) {
    this.expire(); const p = this.previews.get(body.previewId); if (!p || p.actor !== actor) throw error('预览已过期，请重新上传', 404);
    const result = this.publish(p.next, p.baseRevision, actor, 'import', p.prepared); this.previews.delete(body.previewId); for (const [id, f] of this.files) if (f.actor === actor) this.files.delete(id); return result;
  }
  config(body, actor) {
    const base = this.state(), s = { ...base, tables: { ...base.tables }, config: { ...base.config } }; if (body.baseRevision !== s.revision) throw error('配置已过期，请重新加载', 409);
    s.config = { ...s.config, ...body.config }; checkConfig(s.config);
    if (body.industry) { const p = Importer.publicRows('industry', body.industry); if (p.errors.length) throw error('产业映射无效', 422, p.errors); s.tables.industry = p.rows; }
    const v = C.validate(s); if (v.errors.length) throw error('配置导致数据校验失败', 422, v.errors);
    return this.publish(s, body.baseRevision, actor, 'config');
  }
  sample(body, actor) { const s = this.state(); if (body.baseRevision !== s.revision) throw error('数据版本已变化', 409); return this.publish(C.sample(), s.revision, actor, 'sample'); }
  sampleLarge(body, actor) { const s = this.state(); if (body.baseRevision !== s.revision) throw error('数据版本已变化', 409); return this.publish(C.sampleLarge(), s.revision, actor, 'sample'); }
  restore(body, actor) { const s = this.state(); if (body.baseRevision !== s.revision) throw error('数据版本已变化', 409); const old = this.store.load(int(body.revision, 0, 1, 1e9)); return this.publish(old, s.revision, actor, 'restore'); }
  maintain(body, actor) {
    if (!['attributes', 'adjust'].includes(body.table)) throw error('仅支持制造属性或表2维护');
    const base = this.state(), s = { ...base, tables: { ...base.tables }, config: { ...base.config } }; if (body.baseRevision !== s.revision) throw error('数据已更新，请重新加载', 409);
    const p = Importer.publicRows(body.table, body.rows); if (p.errors.length) throw error('维护数据校验失败', 422, p.errors);
    if (body.table === 'attributes') { const changed = new Set(p.rows.map(r => r.code)); s.tables.attributes = s.tables.attributes.filter(r => !changed.has(r.code)).concat(p.rows); }
    else s.tables.adjust = p.rows;
    const v = C.validate(s); if (v.errors.length) throw error('关联校验失败', 422, v.errors);
    return this.publish(s, body.baseRevision, actor, 'maintain:' + body.table);
  }
  table(q) { if (!C.schemas[q.table]) throw error('表名无效'); return this.store.table(q.table, q.code, int(q.offset, 0, 0, 1e9), int(q.limit, 100, 1, 1000)); }
  export(q) { return Importer.workbook(q.kind === 'template' ? C.empty() : q.kind === 'sample' ? C.sampleLarge(0.1) : this.state(), q.kind === 'template'); }
}
module.exports = { Service, changesFor, error };
