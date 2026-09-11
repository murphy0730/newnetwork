'use strict';
const C = require('../forecast-core'), Query = require('./query-index');
const caches = new WeakMap();
const names = { direct: '直接父子', cross: '跨产业', top: '最顶层' };
const fmt = value => value == null ? '未知' : Number(value.toFixed(2)).toLocaleString('zh-CN');
const brief = r => ({ code: r.code, name: r.attr.name || '', make_dept: r.attr.make_dept || '', supply: r.supply, demand: r.demand, gap: r.gap, inventory: r.inventory, coverageGap: r.coverageGap, complete: r.complete, risks: r.risks, coeff: r.coeff, contribution: r.contribution });
function insights(service, q, actor) {
  const { engine: e, month, mode, source, trace } = service.context(q, actor), code = q.code;
  if (!code || !e.orderIndex.has(code)) throw Object.assign(Error('请选择有效编码'), { status: 404 });
  if (!month) throw Object.assign(Error('尚无可分析的预测月份'), { status: 422 });
  const start = e.months.indexOf(month), span = q.span == null || q.span === '' ? Math.min(12, e.months.length - start) : Number(q.span);
  if (!Number.isInteger(span) || span < 1 || span > 120) throw Object.assign(Error('洞察窗口应为1至120个月'), { status: 400 });
  let cache = caches.get(e); if (!cache) caches.set(e, cache = new Map());
  const key = JSON.stringify([code, month, mode, source, span]);
  if (cache.has(key)) return { ...Query.lru(cache, key, cache.get(key), 32), trace, cache: { hit: true } };
  const row = e.row(code, month, mode, source), hasParents = e.graph.parents.get(code).length > 0;
  const scopeComparison = ['direct', 'cross', 'top'].map(scope => { const r = e.row(code, month, scope, source); return { mode: scope, label: names[scope], supply: r.supply, demand: r.demand, gap: r.gap, complete: r.complete, applicable: hasParents }; });
  const targets = e.relations(code, mode).map(rel => { const net = e.net(rel.code, month); return { ...rel, name: e.attributes.get(rel.code)?.name || '', make_dept: e.attributes.get(rel.code)?.make_dept || '', forecast: net.raw, netUsage: net.demand, contribution: net.demand == null ? null : net.demand * rel.coeff, known: net.known }; });
  targets.sort((a, b) => (b.contribution ?? -Infinity) - (a.contribution ?? -Infinity) || a.code.localeCompare(b.code));
  const contributionTotal = targets.reduce((sum, r) => sum + (r.contribution || 0), 0), targetsKnown = targets.every(r => r.known);
  const lower = Query.dependencies(e, code, month, mode, source), shortages = lower.filter(r => r.gap > C.EPS).sort(Query.compare), unknownLower = lower.filter(r => !r.complete);
  const months = e.months.slice(start, start + span), timeline = months.map(m => { const r = e.row(code, m, mode, source); return { month: m, supply: r.supply, demand: r.demand, gap: r.gap, complete: r.complete, inventory: r.inventory, coverageGap: r.coverageGap }; });
  const shortMonths = timeline.filter(r => r.gap > C.EPS), peak = shortMonths.reduce((best, r) => !best || r.gap > best.gap ? r : best, null);
  let consecutive = 0, longest = 0; for (const r of timeline) { consecutive = r.gap > C.EPS ? consecutive + 1 : 0; longest = Math.max(longest, consecutive); }
  const critical = e.criticalCache.get(code), periodSites = row.periodSites;
  const facts = [], actions = [];
  const fact = (id, level, text, evidence) => facts.push({ id, level, text, evidence });
  if (!hasParents) fact('supply_not_applicable', 'info', '本编码没有BOM上层，作为供应方的内部需求匹配不适用；请重点查看下层依赖。', { parentCount: 0 });
  else if (!row.complete) fact('supply_unknown', 'unknown', '预测或产业数据不完整，当前不能确认该编码是否足够供应上层。', { supply: row.supply, demand: row.demand, knownDemand: row.knownDemand, complete: false });
  else if (row.gap > C.EPS) fact('supply_shortage', 'risk', `当月供应 ${fmt(row.supply)}，上层折算需求 ${fmt(row.demand)}，总量缺口 ${fmt(row.gap)}。`, { supply: row.supply, demand: row.demand, gap: row.gap, shortageRatio: row.demand > 0 ? row.gap / row.demand : null });
  else fact('supply_covered', 'ok', `当月供应 ${fmt(row.supply)}，可覆盖上层折算需求 ${fmt(row.demand)}，余量 ${fmt(-row.gap)}。`, { supply: row.supply, demand: row.demand, surplus: -row.gap });
  if (row.inventory == null) fact('inventory_unknown', 'unknown', '缺少该月月初库存快照，库存能否覆盖缺口尚不确定。', { snapshotDate: month + '-01', inventory: null });
  else if (row.gap > C.EPS) fact('inventory_coverage', row.coverageGap > C.EPS ? 'risk' : 'attention', row.coverageGap > C.EPS ? `加入月初库存 ${fmt(row.inventory)} 后，月度总量仍缺 ${fmt(row.coverageGap)}。` : '月初库存可覆盖当月总量缺口，但预测本身仍不匹配；月内产出时点尚未验证。', { inventory: row.inventory, coverageGap: row.coverageGap });
  if (shortages.length) fact('lower_shortage', 'risk', `作为需求方，${lower.length} 个相关下层中有 ${shortages.length} 个编码总量不足；这是下层对所有相关上层的总缺口。`, { dependencyCount: lower.length, shortageCount: shortages.length, codes: shortages.slice(0, 10).map(r => r.code) });
  else if (lower.length && !unknownLower.length) fact('lower_covered', 'ok', `当前口径内 ${lower.length} 个下层均未发现月度总量缺口。`, { dependencyCount: lower.length, shortageCount: 0 });
  if (unknownLower.length) fact('lower_unknown', 'unknown', `${unknownLower.length} 个下层数据不完整，不能认定下层已经全部满足。`, { count: unknownLower.length, codes: unknownLower.slice(0, 10).map(r => r.code) });
  if (row.sites.single) fact('single_site', 'attention', '当月正数量产出集中在一个加工地；这代表计划集中，尚不能证明无替代加工能力。', { sites: row.sites.sites, periodSingle: periodSites.single });
  else if (row.sites.count > 1 && row.sites.maxShare >= e.cfg.concentration) fact('site_concentration', 'attention', `最大加工地承担 ${fmt(row.sites.maxShare * 100)}% 当月产出，达到集中度阈值。`, { maxShare: row.sites.maxShare, threshold: e.cfg.concentration });
  if (!row.sites.complete) fact('site_unknown', 'unknown', '加工地信息不完整，不能确认独家或分散供应。', { unassigned: row.sites.unassigned, siteComplete: false });
  fact('critical_path', critical?.complete ? 'info' : 'unknown', critical?.complete ? `按加工周期均值累计的最长依赖路径为 ${fmt(critical.days)} 天；该数值未包含运输、排队及生产日历。` : '链路中存在未维护的加工周期，无法确认完整关键路径时长。', critical || { complete: false });
  if (row.attr.lead_cv != null && row.attr.lead_cv >= e.cfg.cv_threshold) fact('cycle_variation', 'attention', '该编码加工周期波动达到阈值，建议核对样本时段与近期表现；CV不等于延期概率。', { meanDays: row.attr.lead_mean, cv: row.attr.lead_cv, threshold: e.cfg.cv_threshold, sampleCount: row.attr.sample_count ?? null });
  if (shortMonths.length) fact('future_shortage', 'risk', `所分析窗口的已知数据中，首个预测总量不足月份为 ${shortMonths[0].month}，最大缺口 ${fmt(peak.gap)}（${peak.month}），已确认最长连续 ${longest} 个月不足。`, { firstMonth: shortMonths[0].month, peak, longestConsecutiveMonths: longest, shortageMonths: shortMonths.length });
  if (months.length < span || timeline.some(r => !r.complete)) fact('horizon_unknown', 'unknown', '窗口内存在未知月份或超出已有预测的范围，已发现的首个不足月份不代表更早的未知月份一定充足。', { incompleteMonths: timeline.filter(r => !r.complete).map(r => r.month), beyondAvailableMonths: span - months.length });
  const gapToTest = hasParents && row.complete && row.gap > C.EPS ? row.gap : null;
  if (gapToTest != null && source === 'forecast') actions.push({ id: 'test_supply_increase', label: `模拟当月增加 ${fmt(gapToTest)} 产出`, explanation: '这是当前总量平衡的测试值，未验证产能或自动批准增产。该编码作为需求方时，其下层需求也会变化，须查看推演结果。', endpoint: '/api/scenarios', method: 'POST', requiresRole: 'planner', request: { baseRevision: trace.revision, version: trace.version, month, mode, source, type: 'forecast', changes: [{ code, month, operation: 'add', value: gapToTest }] } });
  if (targets.length) actions.push({ id: 'review_demand', label: '核对上层需求贡献', explanation: '结合上层预测、BOM配比及计划依据判断合理性；系统不自动认定预测虚高。', endpoint: '/api/nodes', method: 'GET', query: { code, version: trace.version, revision: trace.revision, month, mode, source, ...(q.scenario ? { scenario: q.scenario } : {}) } });
  if (shortages.length) actions.push({ id: 'review_lower', label: '查看下层总量风险', explanation: '由业务判断是否增加供应、修订预测或安排分配；各下层缺口不得跨编码直接求和。', endpoint: '/api/analysis', method: 'GET', query: { code, role: 'demand', risk: 'shortage', version: trace.version, revision: trace.revision, month, mode, source, ...(q.scenario ? { scenario: q.scenario } : {}) } });
  const missing = facts.filter(f => f.level === 'unknown').map(f => f.id), risk = facts.some(f => f.level === 'risk'), attention = facts.some(f => f.level === 'attention');
  // No chained simulation API exists: do not present a scenario-relative delta
  // as though it were an equivalent change to the original baseline.
  if (q.scenario) { const i = actions.findIndex(a => a.id === 'test_supply_increase'); if (i >= 0) actions.splice(i, 1); }
  const quantityUnknown = !row.known || (hasParents && !row.complete) || unknownLower.length > 0 || months.length < span || timeline.some(r => !r.complete);
  const status = risk ? 'risk' : quantityUnknown ? 'unknown' : attention || missing.length ? 'attention' : 'covered';
  const headline = risk ? '发现供需风险，建议核对计划' : quantityUnknown ? '部分供需数据未知，需补齐后判断' : attention || missing.length ? '总量未见不足，另有需核实事项' : '当前分析范围内未见供需缺口';
  const result = { schemaVersion: '1.0', generator: { kind: 'deterministic', label: '可核验规则洞察', rulesVersion: 'insight-1', llmUsed: false }, code, name: row.attr.name || '', status, headline, summary: facts.filter(f => ['supply_shortage', 'supply_covered', 'supply_unknown', 'supply_not_applicable', 'lower_shortage', 'lower_unknown', 'future_shortage'].includes(f.id)).map(f => f.text).join(' '), facts, confidence: { supplyComplete: row.complete, dependenciesComplete: unknownLower.length === 0, inventoryKnown: row.inventory != null, sitesComplete: row.sites.complete, criticalPathComplete: critical?.complete || false, missing, note: '完整性说明，不是预测准确率或概率评分。' }, scopeComparison, demandContributors: { total: targets.length, known: targetsKnown, knownContribution: contributionTotal, rows: targets.slice(0, 10).map(r => ({ ...r, shareOfKnownDemand: contributionTotal > 0 && r.contribution != null ? r.contribution / contributionTotal : null })), truncated: targets.length > 10 }, dependencies: { total: lower.length, shortageCount: shortages.length, incompleteCount: unknownLower.length, rows: shortages.slice(0, 10).map(brief), truncated: shortages.length > 10, allocation: false }, horizon: { requestedMonths: span, analyzedMonths: months.length, complete: months.length === span && timeline.every(r => r.complete), timeline, firstShortageMonth: shortMonths[0]?.month || null, peak, longestConsecutiveMonths: longest, cumulative: source === 'forecast' ? e.cumulative(code, month, span, mode) : null }, actions, limitations: ['月度总量匹配不代表月内逐日供货或确定停线日期。', '下层缺口是共享供应的全局总缺口，不是分配给当前编码的缺口。', '不同编码可能采用不同计量单位，缺口不得跨编码简单相加。', '关键路径基于BOM和加工周期均值；尚未建模运输、排队、并行资源与日历。', '本结论由规则和数据生成，未调用外部大模型。'], evidenceLinks: { detail: '/api/nodes', network: '/api/graph', parameters: { code, revision: trace.revision, version: trace.version, month, mode, source, ...(q.scenario ? { scenario: q.scenario } : {}) } } };
  Query.lru(cache, key, result, 32); return { ...result, trace, cache: { hit: false } };
}
module.exports = insights;
