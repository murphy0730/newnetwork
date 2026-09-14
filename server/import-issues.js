'use strict';
const fs = require('node:fs'), path = require('node:path');
const C = require('../forecast-core');
const columns = ['table', 'severity', 'file', 'sheet', 'row', 'code', 'parent', 'child', 'field', 'value', 'message', 'action', 'raw'];
const headers = ['输入表', '级别', '文件', '工作表', '原始行号', '编码', '父项', '子项', '字段', '字段值', '问题原因', '处理方式', '行内容（原始或规范化）'];
const cell = value => { let s = String(value ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
class Issues {
  constructor(prefix) { this.prefix = prefix; this.counts = { total: 0, errors: 0, warnings: 0, byTable: {} }; this.preview = []; this.files = new Map(); fs.mkdirSync(path.dirname(prefix), { recursive: true }); }
  stream(key) { if (!this.files.has(key)) { const filename = this.prefix + (key ? '.' + key : '') + '.csv'; const fd = fs.openSync(filename, 'w'); fs.writeSync(fd, '\uFEFF' + headers.map(cell).join(',') + '\r\n'); this.files.set(key, { fd, buffer: '' }); } return this.files.get(key); }
  add(issue) {
    const row = { severity: 'error', action: '阻止本批次发布，请修正后重新导入', ...issue };
    row.table = Object.hasOwn(C.schemas, row.table) ? row.table : 'unknown';
    this.counts.total++; this.counts[row.severity === 'error' ? 'errors' : 'warnings']++;
    this.counts.byTable[row.table] = (this.counts.byTable[row.table] || 0) + 1;
    if (this.preview.length < 100) this.preview.push({ ...row, raw: undefined });
    const line = columns.map(k => cell(k === 'table' ? C.schemas[row.table]?.label || '文件/未识别表' : k === 'raw' ? JSON.stringify(row.raw ?? {}) : row[k])).join(',') + '\r\n';
    for (const key of ['', row.table]) { const out = this.stream(key); out.buffer += line; if (out.buffer.length >= 65536) { fs.writeSync(out.fd, out.buffer); out.buffer = ''; } }
  }
  record(table, row, field, message, action, severity = 'warning') { this.add({ table, ...(row._source || {}), code: row.code, parent: row.parent, child: row.child, field, value: row[field], message, action, severity, raw: row }); }
  summary() { return { ...this.counts, preview: this.preview }; }
  close() { this.stream(''); for (const out of this.files.values()) { if (out.buffer) fs.writeSync(out.fd, out.buffer); fs.closeSync(out.fd); } this.files.clear(); fs.writeFileSync(this.prefix + '.json', JSON.stringify(this.summary())); }
}
// Scope exclusions must be reported before scopeTables removes their provenance.
function scopeIssues(t, issues) {
  const depts = new Set((t.attributes || []).filter(r => r.make_dept).map(r => r.code));
  const range = new Set(t.forecast.filter(r => depts.has(r.code)).map(r => r.code));
  const mapped = new Set(t.industry.map(r => r.make_dept));
  for (const r of t.attributes) {
    if (!r.make_dept) issues.record('attributes', r, 'make_dept', '制造部门为空，无法确认编码所属产业', depts.size ? '保留属性记录；关联预测、库存和BOM按编码范围规则过滤' : '保留记录；全部制造部门缺失，现有编码范围预处理跳过');
    else if (!mapped.has(r.make_dept)) issues.record('attributes', r, 'make_dept', '制造部门未维护产业映射', '保留记录；产业口径显示不完整');
    if (r.lead_mean == null) issues.record('attributes', r, 'lead_mean', '未维护加工周期均值', '保留记录；关键路径周期显示未知');
  }
  for (const r of t.forecast) if (r.qty > 0 && !r.site_code) issues.record('forecast', r, 'site_code', r.site_name ? '仅维护加工地名称，缺少加工地代码' : '正数量预测缺少加工地', '保留范围内记录；加工地分析按现有缺失规则处理');
  if (!depts.size) return;
  for (const table of ['forecast', 'inventory', 'bom']) for (const r of t[table]) {
    const outside = table === 'bom' ? !range.has(r.parent) || !range.has(r.child) : !range.has(r.code);
    if (outside) issues.record(table, r, table === 'bom' ? 'parent/child' : 'code', '不在表1编码与表6有效制造部门编码的交集中', '按编码范围预处理规则排除，不参与本次分析');
  }
}
module.exports = { Issues, scopeIssues };
