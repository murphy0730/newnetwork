/* Forecast collaboration engine. No DOM/storage dependencies; shared API for future services. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ForecastCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const field = (label, aliases = [], type = 'text') => ({ label, aliases, type });
  const schemas = {
    forecast: { label: '表1 · 月度产出预测', required: ['plan_date', 'code', 'month', 'qty'], fields: {
      plan_date: field('计划日期', ['预测版本'], 'date'), code: field('编码', ['项目编码', 'part_no']),
      type: field('类型'), origin_month: field('预测所在年月', [], 'month'), month: field('预测月份', [], 'month'),
      qty: field('预测数量', ['净预测数量'], 'number'), site_code: field('加工地代码', ['加工地编码']), site_name: field('加工地名称', ['加工地', 'site']),
      supplier_code: field('供应商代码'), supplier_name: field('供应商名称'), period_type: field('周月预测'),
      org_id: field('组织ID'), org_code: field('组织代码'), product_line: field('产品线'), product_family: field('产品族'),
      package: field('加工对象包'), points: field('预测点数'), refreshed_at: field('数据刷新时间')
    } },
    bom: { label: '表3 · BOM基表', required: ['parent', 'child', 'qty'], fields: {
      id: field('id'), parent: field('父项', ['父项编码']), child: field('子项', ['子项编码']), qty: field('子项单位用量', ['配比数量'], 'number'),
      child_type: field('子项供应类型'), child_template: field('子项模板'), parent_type: field('父项供应类型'), parent_template: field('父项模板'), created_at: field('创建时间')
    } },
    inventory: { label: '表4 · 库存快照', required: ['date', 'code', 'qty'], fields: {
      id: field('id'), date: field('创建日期', ['盘点时间', 'snapshot_time'], 'date'), code: field('编码'), qty: field('可用量', ['可用库存', 'onhand'], 'number'),
      sub_type: field('子库类型'), template: field('项目模板'), subinventory: field('ERP子库'), location_name: field('货位描述'), location: field('货位'),
      org_id: field('组织ID'), category: field('产品大类'), subcategory: field('产品小类'), family: field('产品族')
    } },
    attributes: { label: '表6 · 制造属性及周期', required: ['code', 'make_dept'], fields: {
      code: field('part_no', ['编码']), make_dept: field('make_dept', ['制造部门']), name: field('名称', ['编码名称']),
      lead_mean: field('加工周期均值', ['正常加工周期均值', '平均加工周期', 'lead_time'], 'optionalNumber'),
      lead_cv: field('周期变异系数', ['加工周期变异系数', 'cv'], 'optionalNumber'), sample_count: field('周期样本量', ['样本量'], 'optionalNumber'),
      sample_start: field('统计开始日期', [], 'optionalDate'), sample_end: field('统计结束日期', [], 'optionalDate'), source: field('周期来源'),
      org_id: field('org_id', ['组织ID']), life_cycle_state: field('life_cycle_state'), part_category: field('part_category', ['产品大类']),
      part_subcategory: field('part_subcategory'), part_series: field('part_series'), product_line: field('product_line'), product_family: field('product_family')
    } },
    adjust: { label: '表2 · 供应添加 / 使用剔除', required: ['direction', 'code', 'purchase_code'], fields: {
      direction: field('供应/使用', ['供应／使用']), code: field('项目编码'), purchase_code: field('外购编码'), month: field('月份', [], 'month'), qty: field('数量', [], 'number')
    } },
    mo: { label: '生产指令（可选）', required: ['mo_no', 'code', 'qty', 'due_date', 'site_code'], fields: {
      mo_no: field('任务令号', ['生产指令号']), code: field('编码'), qty: field('计划产出数量', ['数量'], 'number'),
      due_date: field('计划完工日期', [], 'date'), sched_date: field('排产预计产出时间', [], 'optionalDate'), actual_date: field('实际完工日期', [], 'optionalDate'),
      site_code: field('加工地代码', ['加工地']), site_name: field('加工地名称'), status: field('排产状态'), planned_date: field('计划产出日期', [], 'optionalDate')
    } },
    industry: { label: '本产业映射', required: ['make_dept', 'is_local'], fields: {
      make_dept: field('制造部门', ['make_dept']), is_local: field('是否本产业', [], 'bool')
    } }
  };
  const defaults = { input_mode: 'net', cv_threshold: 0.3, concentration: 0.8 };
  const empty = () => ({ format: 1, revision: 0, kind: 'empty', updated_at: null, config: { ...defaults }, tables: Object.fromEntries(Object.keys(schemas).map(k => [k, []])) });
  const copy = x => JSON.parse(JSON.stringify(x));
  const text = x => String(x == null ? '' : x).trim();
  const header = x => text(x).replace(/^\uFEFF/, '').replace(/\s+/g, '').toLowerCase();
  const EPS = 1e-8;
  function today() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
  function addMonth(m, n) { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); }
  function date(value, monthOnly = false, date1904 = false) {
    let s = text(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 1 || value > 2958465 || (!date1904 && Math.floor(value) === 60)) throw Error('无效Excel日期');
      s = new Date((Math.floor(value) - (date1904 ? 24107 : 25569)) * 86400000).toISOString().slice(0, 10);
    }
    const m = s.match(/^(\d{4})[-/年](\d{1,2})(?:[-/月](\d{1,2})日?)?(?:[ T].*)?$/);
    if (!m) throw Error(monthOnly ? '月份应为YYYY-MM' : '日期应为YYYY-MM-DD');
    const y = +m[1], mo = +m[2], d = +(m[3] || 1);
    if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || (!monthOnly && !m[3] && typeof value !== 'number')) throw Error('日期或月份无效');
    return `${y}-${String(mo).padStart(2, '0')}` + (monthOnly ? '' : `-${String(d).padStart(2, '0')}`);
  }
  function num(v, optional = false) {
    if (text(v) === '') { if (optional) return null; throw Error('数量不能为空'); }
    const s = text(v), n = Number(s);
    if (!/^[+]?\d*\.?\d+(?:e[+-]?\d+)?$/i.test(s) || !Number.isFinite(n) || n < 0) throw Error('应为非负有限数值');
    return n;
  }
  // 库存可用量允许负数：按减法计入月初库存
  function numSigned(v, optional = false) {
    if (text(v) === '') { if (optional) return null; throw Error('数量不能为空'); }
    const s = text(v), n = Number(s);
    if (!/^[+-]?\d*\.?\d+(?:e[+-]?\d+)?$/i.test(s) || !Number.isFinite(n)) throw Error('应为有限数值');
    return n;
  }
  function bool(v) { if (['是', '本产业', 'true', '1'].includes(text(v).toLowerCase())) return true; if (['否', '跨产业', 'false', '0'].includes(text(v).toLowerCase())) return false; throw Error('填写是/否'); }
  function headerMap(table, row) {
    const map = new Map(), fields = schemas[table].fields;
    row.forEach((h, i) => {
      const key = Object.keys(fields).find(k => [k, fields[k].label, ...fields[k].aliases].some(a => header(a) === header(h)));
      if (key) { if (map.has(key)) throw Error(`字段重复：${fields[key].label}`); map.set(key, i); }
    });
    return map;
  }
  function detect(matrix) {
    const candidates = [];
    for (let row = 0; row < Math.min(10, matrix.length); row++) {
      for (const key of Object.keys(schemas)) {
        try {
          const map = headerMap(key, matrix[row]);
          if (schemas[key].required.every(k => map.has(k))) candidates.push({ table: key, headerRow: row, score: map.size });
        } catch (_) { /* The selected parser returns detailed duplicate-header errors. */ }
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.headerRow - b.headerRow);
    if (!candidates.length || (candidates[1] && candidates[0].score === candidates[1].score && candidates[0].headerRow === candidates[1].headerRow)) return null;
    return candidates[0];
  }
  function parseMatrix(table, matrix, meta = {}) {
    const errors = [], rows = [], schema = schemas[table], offset = meta.headerRow || 0;
    const fail = (row, field, message) => { if (errors.length < 1000) errors.push({ file: meta.file || '', sheet: meta.sheet || '', row, field, message }); };
    let map;
    try {
      map = headerMap(table, matrix[offset] || []);
      for (const key of schema.required) if (!map.has(key)) throw Error(`缺少列：${schema.fields[key].label}`);
    } catch (e) { fail(offset + 1, '表头', e.message); return { rows, errors }; }
    const months = table === 'adjust' ? (matrix[offset] || []).map((h, i) => ({ h: text(h), i })).filter(c => /^\d{4}-\d{2}$/.test(c.h)) : [];
    if (table === 'adjust' && !months.length && (!map.has('month') || !map.has('qty'))) fail(offset + 1, '表头', '需要YYYY-MM月份列，或月份、数量长表列');
    if (table === 'adjust' && months.length && (map.has('month') || map.has('qty'))) fail(offset + 1, '表头', '宽表月份列与长表字段不能混用');
    const seenMonths = new Set();
    for (const m of months) { try { date(m.h, true); if (seenMonths.has(m.h)) throw Error('月份列重复'); seenMonths.add(m.h); } catch (e) { fail(offset + 1, m.h, e.message); } }
    for (let ri = offset + 1; ri < matrix.length; ri++) {
      const cells = matrix[ri]; if (!cells.some(v => text(v) !== '')) continue;
      const out = { _source: { file: meta.file || '', sheet: meta.sheet || '', row: ri + 1 }, _extra: {} };
      (matrix[offset] || []).forEach((h, i) => { if (![...map.values()].includes(i) && !months.some(m => m.i === i)) out._extra[text(h)] = cells[i] == null ? '' : cells[i]; });
      for (const [key, ci] of map) {
        const f = schema.fields[key], v = cells[ci];
        try {
          if (table === 'inventory' && key === 'qty') out[key] = numSigned(v, false);
          else if (f.type === 'number' || f.type === 'optionalNumber') out[key] = num(v, f.type === 'optionalNumber');
          else if (f.type === 'date' || f.type === 'month' || f.type === 'optionalDate') out[key] = text(v) === '' && !schema.required.includes(key) ? null : date(v, f.type === 'month', meta.date1904);
          else if (f.type === 'bool') out[key] = bool(v);
          else { if (typeof v === 'number' && (!Number.isSafeInteger(v) || Math.abs(v) >= 1e15)) throw Error('编码/ID精度不可靠，请在Excel中改为文本后重新导出'); out[key] = text(v); }
          if (schema.required.includes(key) && key !== 'purchase_code' && text(out[key]) === '') throw Error('必填字段为空');
        } catch (e) { fail(ri + 1, f.label, e.message); }
      }
      if (table === 'adjust') {
        if (!['供应', '使用'].includes(out.direction)) fail(ri + 1, '供应/使用', '仅允许供应或使用');
        if (out.direction === '供应' && !out.purchase_code) fail(ri + 1, '外购编码', '供应行外购编码必填');
        if (out.direction === '使用' && out.purchase_code) fail(ri + 1, '外购编码', '使用行外购编码须为空');
        if (months.length) { for (const m of months) { try { rows.push({ ...out, month: m.h, qty: text(cells[m.i]) === '' ? 0 : num(cells[m.i]) }); } catch (e) { fail(ri + 1, m.h, e.message); } } } else rows.push(out);
      } else {
        let skip = false;
        if (table === 'bom') {
          if (out.parent === out.child) fail(ri + 1, '父项/子项', '不允许自环');
          else if (out.qty < 0.01) skip = true; // 预处理自动过滤配比过小的父子项
          else if (out.qty < 1) out.qty = Math.round((out.qty + Number.EPSILON) * 100) / 100;
        }
        if (table === 'attributes' && out.sample_count != null && !Number.isInteger(out.sample_count)) fail(ri + 1, '周期样本量', '样本量须为整数');
        if (table === 'attributes' && out.sample_start && out.sample_end && out.sample_start > out.sample_end) fail(ri + 1, '统计日期', '开始日期不能晚于结束日期');
        if (!skip) rows.push(out);
      }
    }
    if (!rows.length && !errors.length) fail(offset + 1, '数据', '没有数据行，未执行清空');
    return { rows, errors };
  }
  function topology(tables) {
    const codes = new Set(), parents = new Map(), children = new Map();
    for (const k of ['forecast', 'attributes', 'inventory', 'adjust', 'mo']) for (const r of tables[k] || []) if (r.code) codes.add(r.code);
    for (const r of tables.bom || []) { codes.add(r.parent); codes.add(r.child); }
    for (const c of codes) { parents.set(c, []); children.set(c, []); }
    for (const r of tables.bom || []) { parents.get(r.child).push(r); children.get(r.parent).push(r); }
    const deg = new Map([...codes].map(c => [c, parents.get(c).length]));
    const order = [...codes].filter(c => !deg.get(c)), level = new Map(order.map(c => [c, 0]));
    for (let i = 0; i < order.length; i++) for (const r of children.get(order[i])) { level.set(r.child, Math.max(level.get(r.child) || 0, level.get(r.parent) + 1)); deg.set(r.child, deg.get(r.child) - 1); if (!deg.get(r.child)) order.push(r.child); }
    if (order.length !== codes.size) throw Error('BOM存在循环依赖：' + [...codes].filter(c => deg.get(c) > 0).slice(0, 12).join('、'));
    return { codes: [...codes], parents, children, order, level };
  }
  function validate(snapshot) {
    const errors = [], warnings = [], t = snapshot.tables;
    const addError = (r, message) => errors.push({ ...(r._source || {}), field: '关联校验', message });
    for (const key of Object.keys(schemas)) {
      const seen = new Set();
      for (const r of t[key]) {
        let id;
        if (key === 'attributes') id = r.code;
        if (key === 'industry') id = r.make_dept;
        if (key === 'mo') id = r.mo_no;
        if (key === 'adjust') id = JSON.stringify([r.direction, r.code, r.purchase_code || '', r.month]);
        if (key === 'bom') id = r.id ? 'id:' + r.id : JSON.stringify([r.parent, r.child]);
        if (key === 'inventory' && r.id) id = JSON.stringify([r.date, r.id]);
        if (id !== undefined) { if (seen.has(id)) addError(r, `${schemas[key].label}存在重复键：${id}`); seen.add(id); }
      }
    }
    let graph;
    try { graph = topology(t); } catch (e) { errors.push({ field: 'BOM', message: e.message }); }
    const attr = new Map(t.attributes.map(r => [r.code, r])), mapped = new Set(t.industry.map(r => r.make_dept));
    if (graph) {
      const missing = graph.codes.filter(c => !attr.has(c));
      if (missing.length) warnings.push(`${missing.length}个编码缺制造属性（${missing.slice(0, 6).join('、')}），产业/周期分析不完整`);
    }
    const depts = [...new Set(t.attributes.map(r => r.make_dept))].filter(d => !mapped.has(d));
    if (depts.length) warnings.push(`请确认产业映射：${depts.join('、')}`);
    if (t.forecast.some(r => r.qty > 0 && !r.site_code && !r.site_name)) warnings.push('部分正数量预测缺加工地，相关单一加工地判定为数据不完整');
    if (t.forecast.some(r => r.qty > 0 && !r.site_code && r.site_name)) warnings.push('部分加工地只有名称，将按名称临时识别；建议补加工地代码');
    if (!t.inventory.length) warnings.push('尚无库存快照，仅能计算预测匹配；库存覆盖结果显示未知');
    if (snapshot.config.input_mode === 'net' && t.adjust.length) warnings.push('当前按已预处理净预测分析，表2不再重复应用');
    if (snapshot.config.input_mode === 'raw') {
      const totals = new Map();
      for (const r of t.forecast) { const k = JSON.stringify([r.plan_date, r.code, r.month]); totals.set(k, (totals.get(k) || 0) + r.qty); }
      const uses = new Map(); for (const r of t.adjust.filter(r => r.direction === '使用')) { const k = JSON.stringify([r.code, r.month]); uses.set(k, (uses.get(k) || 0) + r.qty); }
      for (const [k, v] of totals) { const [, c, m] = JSON.parse(k); if ((uses.get(JSON.stringify([c, m])) || 0) > v + EPS) errors.push({ field: '使用剔除', message: `${c} ${m}剔除量大于该版本原预测，请检查预处理口径` }); }
    }
    return { errors, warnings };
  }
  function prepare(current, batches) {
    const next = current.kind === 'sample' ? empty() : copy(current), grouped = new Map();
    for (const b of batches) { if (!grouped.has(b.table)) grouped.set(b.table, []); const target = grouped.get(b.table); for (const row of b.rows) target.push(row); }
    for (const [table, rows] of grouped) {
      if (table === 'forecast' || table === 'inventory') { const field = table === 'forecast' ? 'plan_date' : 'date', keys = new Set(rows.map(r => r[field])); next.tables[table] = next.tables[table].filter(r => !keys.has(r[field])).concat(rows); }
      else next.tables[table] = rows;
    }
    next.kind = 'imported'; next.updated_at = new Date().toISOString(); next.revision = current.revision + 1;
    return { next, ...validate(next) };
  }
  function siteSummary(rows, adjustment = 0) {
    const sites = new Map(); let total = 0, unassigned = adjustment;
    for (const r of rows) {
      if (!(r.qty > 0)) continue;
      total += r.qty;
      const key = r.site_code || (r.site_name ? '名称:' + r.site_name : '');
      if (!key) { unassigned += r.qty; continue; }
      if (!sites.has(key)) sites.set(key, { code: r.site_code || '', key, name: r.site_name || r.site_code, qty: 0, suppliers: new Set() });
      const site = sites.get(key); site.qty += r.qty; if (r.supplier_code || r.supplier_name) site.suppliers.add(r.supplier_name || r.supplier_code);
    }
    const list = [...sites.values()].sort((a, b) => b.qty - a.qty).map(s => ({ ...s, suppliers: [...s.suppliers], share: total + adjustment > 0 ? s.qty / (total + adjustment) : null }));
    return { sites: list, total, unassigned, count: sites.size, single: total > 0 && unassigned <= EPS && sites.size === 1, complete: unassigned <= EPS && total > 0, maxShare: list.length ? list[0].share : null };
  }
  class Engine {
    constructor(snapshot, planDate, sharedGraph) {
      this.snapshot = snapshot; this.t = snapshot.tables; this.cfg = { ...defaults, ...snapshot.config };
      this.graph = sharedGraph || topology(this.t); this.attributes = new Map(this.t.attributes.map(r => [r.code, r])); this.industries = new Map(this.t.industry.map(r => [r.make_dept, r.is_local]));
      this.orderIndex = new Map(this.graph.order.map((c, i) => [c, i]));
      this.versions = [...new Set(this.t.forecast.map(r => r.plan_date))].sort(); this.version = planDate || this.versions.at(-1);
      this.forecast = this.t.forecast.filter(r => r.plan_date === this.version); this.byCodeMonth = new Map(); this.byCode = new Map();
      for (const r of this.forecast) { const k = JSON.stringify([r.code, r.month]); if (!this.byCodeMonth.has(k)) this.byCodeMonth.set(k, []); this.byCodeMonth.get(k).push(r); if (!this.byCode.has(r.code)) this.byCode.set(r.code, []); this.byCode.get(r.code).push(r); }
      const months = [...new Set(this.forecast.map(r => r.month))].sort(); this.months = [];
      if (months.length && (Number(months.at(-1).slice(0, 4)) - Number(months[0].slice(0, 4))) * 12 + Number(months.at(-1).slice(5)) - Number(months[0].slice(5)) > 119) throw Error('单预测版本月份跨度不得超过120个月');
      if (months.length) for (let m = months[0]; m <= months.at(-1); m = addMonth(m, 1)) this.months.push(m);
      this.inventory = new Map(); this.inventoryDates = new Set(this.t.inventory.map(r => r.date)); this.excludedInventory = 0;
      for (const r of this.t.inventory) { if (/^(生产-三品|备件-)/.test(r.sub_type)) { this.excludedInventory++; continue; } const k = JSON.stringify([r.code, r.date]); this.inventory.set(k, (this.inventory.get(k) || 0) + r.qty); }
      this.adjustments = new Map();
      if (this.cfg.input_mode === 'raw') for (const r of this.t.adjust) { const k = JSON.stringify([r.code, r.month]); if (!this.adjustments.has(k)) this.adjustments.set(k, { add: 0, remove: 0 }); this.adjustments.get(k)[r.direction === '供应' ? 'add' : 'remove'] += r.qty; }
      this.periodAdds = new Map(); for (const [key, adjustment] of this.adjustments) { const [code, month] = JSON.parse(key); if (this.months.includes(month)) this.periodAdds.set(code, (this.periodAdds.get(code) || 0) + adjustment.add); }
      this.relationCache = new Map(); this.monthCache = new Map(); this.criticalCache = new Map(); this.netCache = new Map(); this.periodSiteCache = new Map(); this.materialized = new Map();
      this.moByCodeMonth = new Map();
      for (const r of this.t.mo || []) if (!r.actual_date && !/取消|关闭|完成|cancel|closed|complete/i.test(r.status || '')) {
        const m = (r.sched_date || r.due_date).slice(0, 7), k = JSON.stringify([r.code, m]);
        if (!this.moByCodeMonth.has(k)) this.moByCodeMonth.set(k, []); this.moByCodeMonth.get(k).push({ ...r, site_name: r.site_name || r.site_code });
      }
      for (const c of [...this.graph.order].reverse()) {
        const childPaths = this.graph.children.get(c).map(e => this.criticalCache.get(e.child));
        const best = childPaths.reduce((a, b) => !a || b.knownDays > a.knownDays ? b : a, null), a = this.attributes.get(c), mean = a?.lead_mean;
        const complete = mean != null && childPaths.every(p => p.complete);
        this.criticalCache.set(c, { path: [c, ...(best?.path || [])], knownDays: (mean || 0) + (best?.knownDays || 0), days: complete ? (mean || 0) + (best?.knownDays || 0) : null, complete });
      }
    }
    local(code) { const a = this.attributes.get(code); return a ? this.industries.get(a.make_dept) : undefined; }
    net(code, month) {
      if (!this.netCache.has(month)) { if (this.netCache.size >= 2) this.netCache.delete(this.netCache.keys().next().value); this.netCache.set(month, new Map()); }
      const cache = this.netCache.get(month), key = JSON.stringify([code, month]); if (cache.has(code)) return cache.get(code);
      const rows = this.byCodeMonth.get(key) || [], adj = this.adjustments.get(key) || { add: 0, remove: 0 };
      const raw = rows.reduce((s, r) => s + r.qty, 0), known = rows.length > 0;
      const result = { raw, known, supply: known ? raw + adj.add : null, demand: known ? raw - adj.remove : null, ...adj, sites: siteSummary(rows, adj.add) };
      cache.set(code, result); return result;
    }
    relations(code, mode) {
      const key = JSON.stringify([code, mode]); if (this.relationCache.has(key)) return this.relationCache.get(key);
      const amounts = new Map([[code, 1]]), targets = new Map(), reachable = new Set([code]), queue = [code];
      for (let i = 0; i < queue.length; i++) {
        const c = queue[i], parents = this.graph.parents.get(c) || [];
        if (c !== code && (mode === 'direct' || !parents.length || (mode === 'cross' && this.local(c) !== true))) continue;
        for (const r of parents) if (!reachable.has(r.parent)) { reachable.add(r.parent); queue.push(r.parent); }
      }
      // Reverse topological propagation sums converging path coefficients without enumerating paths.
      for (const c of [...reachable].sort((a, b) => this.orderIndex.get(b) - this.orderIndex.get(a))) {
        if (!amounts.has(c)) continue;
        const parents = this.graph.parents.get(c), local = this.local(c);
        if (c !== code && (mode === 'direct' || !parents.length || (mode === 'cross' && local !== true))) {
          const qty = amounts.get(c); if (!Number.isFinite(qty)) throw Error('BOM累计用量超出计算范围');
          targets.set(c, { code: c, coeff: qty, kind: mode === 'cross' ? local === true ? '本产业最顶层' : local === false ? '跨产业首个编码' : '产业未确认' : mode === 'top' ? '最顶层' : '直接父项' }); continue;
        }
        for (const r of parents) amounts.set(r.parent, (amounts.get(r.parent) || 0) + amounts.get(c) * r.qty);
      }
      const result = [...targets.values()]; if (this.relationCache.size > 256) this.relationCache.delete(this.relationCache.keys().next().value); this.relationCache.set(key, result); return result;
    }
    compute(month, mode = 'cross', source = 'forecast') {
      const key = JSON.stringify([month, mode, source]); if (this.monthCache.has(key)) return this.monthCache.get(key);
      const result = new Map(), incoming = new Map(), incomingKnown = new Map(), saved = this.materialized.get(key), numeric = saved || new Float64Array(this.graph.order.length * 2);
      // O(V+E) per month. Never materialize the all-pairs BOM closure for aggregate analysis.
      for (let index = 0; index < this.graph.order.length; index++) {
        const code = this.graph.order[index];
        const net = this.net(code, month), moRows = this.moByCodeMonth.get(JSON.stringify([code, month])) || [];
        const own = source === 'mo' ? { ...net, supply: this.t.mo.length ? moRows.reduce((s, r) => s + r.qty, 0) : null, sites: siteSummary(moRows) } : net;
        const complete = saved ? !!saved[index * 2 + 1] : own.supply != null && (incomingKnown.get(code) !== false);
        const knownDemand = saved ? saved[index * 2] : incoming.get(code) || 0, demand = complete ? knownDemand : null, gap = complete && this.graph.parents.get(code).length ? demand - own.supply : null;
        if (!saved) { numeric[index * 2] = knownDemand; numeric[index * 2 + 1] = Number(complete); }
        const snapshotDate = month + '-01', inventory = this.inventoryDates.has(snapshotDate) ? this.inventory.get(JSON.stringify([code, snapshotDate])) || 0 : null;
        if (!this.periodSiteCache.has(code)) this.periodSiteCache.set(code, siteSummary(this.byCode.get(code) || [], this.periodAdds.get(code) || 0));
        const periodSites = this.periodSiteCache.get(code);
        const attr = this.attributes.get(code) || {}, risks = [];
        if (!complete) risks.push('预测或产业数据不完整');
        if (gap > EPS) risks.push('预测总量不足');
        if (own.sites.single) risks.push('当月单一加工地');
        if (own.sites.count > 1 && own.sites.maxShare >= this.cfg.concentration) risks.push('加工地高度集中');
        if (own.sites.unassigned > EPS) risks.push('加工地未完整分配');
        if (attr.lead_cv != null && attr.lead_cv >= this.cfg.cv_threshold) risks.push('加工周期波动');
        if (attr.lead_mean == null) risks.push('加工周期未维护');
        result.set(code, { code, attr, ...own, complete, demand, knownDemand, gap, inventory, snapshotDate, coverageGap: gap != null && inventory != null ? gap - inventory : null, coverage: demand > 0 ? own.supply / demand : null, periodSites, risks });
        if (saved) continue;
        const boundary = mode === 'direct' || !this.graph.parents.get(code).length || (mode === 'cross' && this.local(code) !== true);
        const outgoing = boundary ? (net.demand || 0) : knownDemand;
        const outgoingKnown = boundary ? net.known && (mode !== 'cross' || this.local(code) !== undefined) : incomingKnown.get(code) !== false;
        for (const edge of this.graph.children.get(code)) {
          const val = (incoming.get(edge.child) || 0) + outgoing * edge.qty;
          if (!Number.isFinite(val)) throw Error('BOM累计需求超出计算范围'); incoming.set(edge.child, val);
          if (!outgoingKnown) incomingKnown.set(edge.child, false);
        }
      }
      this.materialized.set(key, numeric);
      if (this.monthCache.size >= 2) this.monthCache.delete(this.monthCache.keys().next().value);
      this.monthCache.set(key, result); return result;
    }
    precompute() {
      const started = Date.now();
      for (const m of this.months) for (const mode of ['direct', 'cross', 'top']) for (const source of this.t.mo.length ? ['forecast', 'mo'] : ['forecast']) this.compute(m, mode, source);
      return { milliseconds: Date.now() - started, cells: this.graph.codes.length * this.months.length * 3, matrices: this.materialized.size };
    }
    descendantCodes(root) {
      const visited = new Set([root]), queue = [root];
      for (let i = 0; i < queue.length; i++) for (const r of this.graph.children.get(queue[i]) || []) if (!visited.has(r.child)) { visited.add(r.child); queue.push(r.child); }
      return visited;
    }
    downstream(root, month, mode) {
      const all = this.compute(month, mode), amounts = new Map([[root, 1]]), out = [];
      for (const c of this.graph.order) if (amounts.has(c)) {
        if (c !== root) out.push({ ...all.get(c), contribution: this.net(root, month).demand == null ? null : this.net(root, month).demand * amounts.get(c), coeff: amounts.get(c) });
        if (c !== root && (mode === 'direct' || (mode === 'cross' && this.local(c) !== true))) continue;
        // Inspect dependency risk even when the selected material is not a frontier object.
        // Its own folded quantity is a reference, not an allocation of the lower material's gap.
        for (const r of this.graph.children.get(c)) amounts.set(r.child, (amounts.get(r.child) || 0) + amounts.get(c) * r.qty);
      }
      return out;
    }
    paths(root, month, mode, source = 'forecast') {
      const all = this.compute(month, mode, source), descendants = this.descendantCodes(root), active = new Set();
      for (const c of [...this.graph.order].reverse()) if (descendants.has(c)) {
        if ((all.get(c)?.risks.length || 0) > 0 || (this.graph.children.get(c) || []).some(r => active.has(r.child))) active.add(c);
      }
      const edges = this.t.bom.filter(r => descendants.has(r.parent) && active.has(r.child));
      return { critical: this.criticalCache.get(root), riskNodes: [...descendants].filter(c => all.get(c)?.risks.length), edges, active };
    }
    cumulative(code, start, count, mode) {
      const startIndex = this.months.indexOf(start), months = this.months.slice(startIndex, startIndex + count), rows = months.map(m => this.compute(m, mode).get(code));
      const complete = months.length === count && rows.every(r => r.complete), inv = rows[0]?.inventory;
      const demand = complete ? rows.reduce((s, r) => s + r.demand, 0) : null, supply = complete ? rows.reduce((s, r) => s + r.supply, 0) : null;
      let water = inv, minWater = inv, firstShortage = null;
      for (let i = 0; i < rows.length; i++) { const r = rows[i]; if (water == null || !r.complete) { water = null; minWater = null; continue; } water += r.supply - r.demand; minWater = Math.min(minWater, water); if (water < -EPS && !firstShortage) firstShortage = months[i]; }
      return { months, complete, demand, supply, inventory: inv, gap: complete ? demand - supply : null, coverageGap: complete && inv != null ? demand - supply - inv : null, firstShortage, minWater: complete ? minWater : null };
    }
  }
  function sample() {
    const s = empty(), m = today().slice(0, 7), t = s.tables; s.kind = 'sample'; s.updated_at = new Date().toISOString();
    t.industry = [{ make_dept: '基础制造部', is_local: true }, { make_dept: '整机事业部', is_local: false }];
    t.attributes = [ ['A', '共用模块', '基础制造部', 10, .4], ['B', '整机B', '整机事业部', 8, .12], ['C', '整机C', '整机事业部', 6, .15], ['D', '模块原料', '基础制造部', 15, .08] ].map(([code, name, make_dept, lead_mean, lead_cv]) => ({ code, name, make_dept, lead_mean, lead_cv, sample_count: 30, source: '示例维护' }));
    t.bom = [{ id: '1', parent: 'B', child: 'A', qty: 2 }, { id: '2', parent: 'C', child: 'A', qty: 1 }, { id: '3', parent: 'A', child: 'D', qty: .5 }];
    for (let i = 0; i < 11; i++) {
      const month = addMonth(m, i);
      for (const [code, qty, site_code, site_name] of [['A', 1000, i % 2 ? 'S2' : 'S1', i % 2 ? '乙加工地' : '甲加工地'], ['B', 400, 'S3', '整机加工地'], ['C', 300, 'S3', '整机加工地'], ['D', 520, 'S4', '原料加工地甲'], ['D', 30, 'S5', '原料加工地乙']]) t.forecast.push({ plan_date: today(), code, month, origin_month: m, qty, site_code, site_name, supplier_code: 'V-' + site_code, supplier_name: '供应商-' + site_code, type: code === 'B' || code === 'C' ? '成品' : '半成品' });
      for (const code of ['A', 'B', 'C', 'D']) t.inventory.push({ id: code + month, date: month + '-01', code, qty: code === 'A' ? 200 : 0, sub_type: '正常库存', template: '标准' });
    }
    return s;
  }
  // scale=1 为完整示例（约1万编码，供"加载示例"直接使用）；导出 Excel 用缩小比例，避免文件超过导入上限
  function sampleLarge(scale = 1) {
    const s = empty(), t = s.tables, v = today(), m = today().slice(0, 7);
    s.kind = 'sample'; s.updated_at = new Date().toISOString();
    const months = []; for (let i = 0; i < 11; i++) months.push(addMonth(m, i));
    const N = months.length;
    let seed = 20260910;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const code = (p, n) => p + '-' + String(n).padStart(2, '0');
    const gIndex = (c) => Number(c.split('-')[1]);
    // 7 层 BOM：整机→模组→部件→结构件→基础料→深基础料→原料；外购件为跨产业叶子。完整规模共5000编码
    const GRP0 = { FG: 100, MD: 350, PT: 600, SB: 800, RW: 1000, BS: 1000, RM: 700, EX: 450 };
    const GRP = Object.fromEntries(Object.entries(GRP0).map(([g, n]) => [g, Math.max(2, Math.round(n * scale))]));
    const LEVEL = ['FG', 'MD', 'PT', 'SB', 'RW', 'BS', 'RM']; // 逐层父子
    // 12 个本产业制造部门（同一大类按编码奇偶分到两个部门）＋3 个跨产业外协厂
    const DEPT = { FG: ['整机事业部', '总装测试部'], MD: ['模组制造部', '电子装联部'], PT: ['部件加工部', '注塑成型部'], SB: ['精密结构件厂', '钣金加工部'], RW: ['基础材料厂', '表面处理部'], BS: ['深加工厂', '热处理部'], RM: ['原料厂'] };
    const EX_DEPT = ['芯片外协厂', '连接器外协厂', '五金外协厂'];
    const NM = { FG: '整机', MD: '模组', PT: '部件', SB: '结构件', RW: '基础料', BS: '深基础料', RM: '原料', EX: '外购件' };
    const RANGE = { FG: [5, 9], MD: [7, 13], PT: [8, 15], SB: [10, 18], RW: [14, 26], BS: [20, 42], RM: [25, 50], EX: [16, 34] };
    // 约 200 个加工地：每类编码只在自己大类的加工地片区分流
    const SITE_COUNT = { FG: 12, MD: 24, PT: 32, SB: 36, RW: 36, BS: 32, RM: 16, EX: 12 };
    const REGION = ['东莞', '深圳', '苏州', '成都', '武汉', '西安', '合肥', '长沙', '重庆', '天津', '宁波', '青岛', '佛山', '无锡', '郑州', '惠州'];
    const SITES = {}; { let si = 0; for (const g of Object.keys(SITE_COUNT)) { SITES[g] = []; for (let i = 0; i < SITE_COUNT[g]; i++) { si++; SITES[g].push({ code: 'S' + String(si).padStart(3, '0'), name: REGION[si % REGION.length] + NM[g] + '加工地' }); } } }
    // 约 400 个产品大类
    const CAT = []; for (let i = 1; i <= 400; i++) CAT.push('C' + String(i).padStart(3, '0') + '类');
    t.industry = [];
    for (const g of Object.keys(DEPT)) for (const d of DEPT[g]) t.industry.push({ make_dept: d, is_local: true });
    for (const d of EX_DEPT) t.industry.push({ make_dept: d, is_local: false });
    const by = {}, all = [];
    for (const g of Object.keys(GRP)) { by[g] = []; for (let i = 1; i <= GRP[g]; i++) { const c = code(g, i); by[g].push(c); all.push(c); } }
    const GRP_OFF = { FG: 0, MD: 37, PT: 71, SB: 113, RW: 151, BS: 199, RM: 241, EX: 283 };
    for (const g of Object.keys(GRP)) for (const c of by[g]) {
      const gi = gIndex(c);
      const dept = g === 'EX' ? EX_DEPT[gi % EX_DEPT.length] : DEPT[g][gi % DEPT[g].length];
      t.attributes.push({ code: c, make_dept: dept, name: NM[g] + '-' + c.split('-')[1], lead_mean: ri(RANGE[g][0], RANGE[g][1]), lead_cv: g === 'BS' || g === 'RM' ? .32 : +(0.13 + (gi % 5) * .05).toFixed(2), sample_count: ri(20, 140), source: '示例维护', part_category: CAT[(gi * 7 + GRP_OFF[g]) % CAT.length], product_line: '示例产品线', product_family: NM[g] });
    }
    const need = {}, factor = {};
    for (const c of all) { need[c] = new Array(N).fill(0); factor[c] = 0.94 + rnd() * 0.18; }
    let bid = 0;
    const bom = (parent, child, qty) => { bid++; t.bom.push({ id: String(bid), parent, child, qty }); };
    const pushF = (c, mm, qty, site_code, site_name) => { const g = c.slice(0, 2); t.forecast.push({ plan_date: v, code: c, month: mm, origin_month: m, qty, site_code, site_name, supplier_code: site_code ? 'V-' + site_code : '', supplier_name: site_code ? '供应商-' + site_code : '', type: NM[g] }); };
    const rounds = (x) => Math.round(x);
    // 加工地形态：5% 单一、10% 高度集中、5% 未完整分配、约13% 三地共线、其余双地分流
    const siteShape = (gi) => { const r = gi % 20; if (r === 0) return 'single'; if (r === 1 || r === 2) return 'conc'; if (r === 3) return 'miss'; if (gi % 6 === 2) return 'tri'; return 'dual'; };
    const emit = (c, mm, qty) => {
      if (qty <= 0) return;
      const g = c.slice(0, 2), gi = gIndex(c), sites = SITES[g], len = sites.length, shape = siteShape(gi);
      const put = (q, si) => { if (q > 0) pushF(c, mm, q, sites[si].code, sites[si].name); };
      if (shape === 'single') { put(qty, gi % len); return; }
      if (shape === 'tri') {
        // 三地共线：主产地约五成，其余两地分担，起始地随编码轮换
        const shares = [.5, .3, .2], off = gi % len; let acc = 0;
        shares.forEach((sh, i) => { const q = i === 2 ? qty - acc : rounds(qty * sh); acc += q; put(q, (off + i) % len); });
        return;
      }
      const main = rounds(qty * (shape === 'conc' ? .9 : shape === 'miss' ? .85 : .55 + rnd() * .2)), rest = qty - main, a = gi % len, b = (gi + 1) % len;
      if (shape === 'miss') { put(main, a); if (rest > 0) pushF(c, mm, rest, '', ''); return; }
      put(main, a); put(rest, b);
    };
    // 层级 BOM：半成品之间多层嵌套。父项可跨 1-3 层（70% 相邻层 / 25% 跨2层 / 5% 跨3层），
    // 每个编码 1-4 个父项；每层 20% 共用料承接约 60% 的引用，形成真实的共用与汇聚关系
    const parentsOf = {};
    const hotPool = (P) => P.slice(0, Math.max(2, Math.floor(P.length * 0.2)));
    for (let li = 1; li < LEVEL.length; li++) {
      const g = LEVEL[li];
      for (const c of by[g]) {
        const list = [], chosen = new Set();
        const pn = rnd() < .25 ? 1 : rnd() < .62 ? 2 : rnd() < .9 ? 3 : 4;
        for (let p = 0; p < pn; p++) {
          const back = rnd() < .7 ? 1 : rnd() < .85 ? 2 : 3;
          const P = by[LEVEL[Math.max(0, li - back)]], hot = hotPool(P);
          const parent = rnd() < .6 ? hot[ri(0, hot.length - 1)] : P[ri(0, P.length - 1)];
          if (chosen.has(parent)) continue;
          chosen.add(parent);
          const q = ri(1, 3); bom(parent, c, q); list.push([parent, q]);
        }
        parentsOf[c] = list;
      }
    }
    // 顶层整机需求逐月展开
    by.FG.forEach((fg, i) => { const base = 120 + (i % 40) * 6; for (let k = 0; k < N; k++) { const q = rounds(base * (1 + k * .02) * (.94 + rnd() * .12)); need[fg][k] = q; emit(fg, months[k], q); } });
    // 逐层：需求=Σ父项需求×配比；供应按覆盖系数（0.8~1.1）形成少量真实缺口
    for (const g of LEVEL.slice(1)) by[g].forEach((c) => {
      const ps = parentsOf[c] || [];
      for (let k = 0; k < N; k++) { let d = 0; for (const [p, q] of ps) d += need[p][k] * q; need[c][k] = rounds(d); emit(c, months[k], rounds(d * factor[c])); }
    });
    // 外购件:无内部预测,只被引用(数据不完整/跨产业边界)，挂到上 1-4 层的 1-2 个父项
    by.EX.forEach((ex, i) => { const pool = [by.FG, by.MD, by.PT, by.SB][i % 4], n = rnd() < .7 ? 1 : 2; for (let p = 0; p < n; p++) bom(pool[ri(0, pool.length - 1)], ex, ri(1, 2)); });
    // 库存快照:整机与部分共用模组/部件月初覆盖一部分
    const invCodes = new Set([...by.FG, ...by.MD.filter((c, i) => i % 10 === 1), ...by.PT.filter((c, i) => i % 17 === 3)]);
    for (const c of invCodes) for (let k = 0; k < N; k++) {
      const cover = c.startsWith('FG') ? .08 : .12;
      const qty = rounds((need[c][k] || 0) * cover * (0.5 + rnd()));
      t.inventory.push({ id: c + months[k], date: months[k] + '-01', code: c, qty, sub_type: '正常库存', template: '标准' });
    }
    return s;
  }
  return { schemas, defaults, empty, copy, today, addMonth, date, num, bool, detect, headerMap, parseMatrix, topology, validate, prepare, siteSummary, Engine, sample, sampleLarge, EPS };
});
