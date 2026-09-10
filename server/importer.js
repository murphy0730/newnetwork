'use strict';
const XLSX = require('../vendor/xlsx');
const C = require('../forecast-core');
function guardZip(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) return;
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw Error('Excel压缩目录损坏');
  let pos = buf.readUInt32LE(end + 16), total = 0, count = buf.readUInt16LE(end + 10);
  if (count > 4096 || count === 65535) throw Error('Excel内部文件数量超限');
  for (let i = 0; i < count; i++) { if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw Error('Excel压缩目录无效'); total += buf.readUInt32LE(pos + 24); if (total > 2 * 1024 * 1024 * 1024) throw Error('Excel解压后超过2GB，请拆分为CSV'); pos += 46 + buf.readUInt16LE(pos + 28) + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32); }
}
function parseCSV(s) {
  const out = []; let row = [], cell = '', quoted = false, cells = 0;
  const pushCell = () => { if (row.length >= 200 || ++cells > 100000000) throw Error('CSV最多200列、1亿单元格，请拆分文件'); row.push(cell); cell = ''; };
  const pushRow = () => { if (out.length >= 5000000) throw Error('单文件总行数超过500万'); out.push(row); row = []; };
  for (let i = 0; i < s.length; i++) { const c = s[i]; if (quoted) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; } else if (c === '"' && cell === '') quoted = true; else if (c === ',') { pushCell(); } else if (c === '\r' || c === '\n') { if (c === '\r' && s[i + 1] === '\n') i++; pushCell(); pushRow(); } else cell += c; }
  if (quoted) throw Error('CSV引号未闭合'); if (cell || row.length) { pushCell(); pushRow(); }
  return out;
}
function readFile(name, buffer) {
  const ext = name.split('.').at(-1).toLowerCase(), buf = Buffer.from(buffer);
  if (!['csv', 'xlsx', 'xls'].includes(ext)) throw Error('仅支持CSV、xlsx、xls');
  if (!buf.length || buf.length > 512 * 1024 * 1024) throw Error('单文件须为1字节至500MB');
  let sheets;
  if (ext === 'csv') {
    let content; try { content = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { content = new TextDecoder('gb18030').decode(buf); }
    sheets = [{ name: name.replace(/\.csv$/i, ''), matrix: parseCSV(content), date1904: false }];
  } else {
    if (buf.length >= 4) guardZip(buf);
    const wb = XLSX.read(buf, { type: 'buffer', cellNF: true, cellText: true, cellFormula: true });
    sheets = wb.SheetNames.map(name => {
      const ws = wb.Sheets[name], matrix = [];
      if (!ws['!ref']) return { name, matrix, date1904: false };
      const range = XLSX.utils.decode_range(ws['!ref']);
      if (range.e.r > 1048575 || range.e.c > 199) throw Error('单工作表最多Excel上限行数、200列');
      if ((range.e.r + 1) * (range.e.c + 1) > 100000000) throw Error('工作表有效范围超过1亿单元格，请清理多余格式或拆分CSV');
      for (let r = 0; r <= range.e.r; r++) { const row = []; for (let c = 0; c <= range.e.c; c++) { const cell = ws[XLSX.utils.encode_cell({ r, c })]; if (cell?.f && cell.v == null) throw Error(`${name}第${r + 1}行公式无缓存值，请在Excel中计算并保存`); row.push(cell ? cell.t === 'n' && /^0+$/.test(cell.z || '') && cell.w ? cell.w : cell.v == null ? '' : cell.v : ''); } matrix.push(row); }
      return { name, matrix, date1904: !!wb.Workbook?.WBProps?.date1904 };
    });
  }
  if (sheets.reduce((s, x) => s + x.matrix.length, 0) > 5000000) throw Error('单文件总行数超过500万');
  if (sheets.reduce((s, x) => s + x.matrix.reduce((n, row) => n + row.length, 0), 0) > 100000000) throw Error('单文件总单元格超过1亿，请拆分文件');
  return sheets.map(s => { const detected = C.detect(s.matrix); return { ...s, detected: detected && s.matrix.slice(detected.headerRow + 1).some(row => row.some(v => v !== '' && v != null)) ? detected : null }; });
}
function publicRows(table, rows) {
  if (!C.schemas[table] || !Array.isArray(rows) || rows.length > 5000000) throw Error('表名或数据行无效');
  const fields = new Set();
  for (const r of rows) { if (!r || typeof r !== 'object' || Array.isArray(r)) throw Error('数据行须为对象'); for (const key of Object.keys(r)) if (!key.startsWith('_')) fields.add(key); if (fields.size > 200) throw Error('API数据最多200列'); }
  const keys = [...fields];
  if (keys.length * rows.length > 100000000) throw Error('单批API数据最多1亿单元格');
  return C.parseMatrix(table, [keys, ...rows.map(r => keys.map(k => r[k] == null ? '' : r[k]))], { file: 'API', sheet: table });
}
function workbook(snapshot, template = false) {
  const wb = XLSX.utils.book_new(), sample = C.sample();
  for (const [table, schema] of Object.entries(C.schemas)) {
    const keys = Object.keys(schema.fields), rows = template ? [] : snapshot.tables[table];
    const matrix = [keys.map(k => schema.fields[k].label)];
    for (const r of rows) matrix.push(keys.map(k => typeof r[k] === 'boolean' ? r[k] ? '是' : '否' : r[k] == null ? '' : r[k]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(matrix), table);
  }
  if (template) {
    // 填写说明页：表头不匹配任何数据表，导入预览时默认跳过
    const guide = [
      ['供应网络控制塔 · 导入模板填写说明'],
      ['1. 每张工作表对应一类数据，表头须与本模板一致，可位于前10行内任意一行；空表直接跳过即可，不会清空已有数据。'],
      ['2. 编码请用文本格式保存（避免科学计数法）；月份格式YYYY-MM；日期格式YYYY-MM-DD；布尔字段填 是/否。'],
      ['3. 预测按计划日期覆盖完整版本，库存按日期覆盖完整快照；BOM、制造属性、调整表、产业映射整表替换；多文件多表作为同一批次校验，确认后原子提交并预计算。'],
      ['4. 大型数据建议按表分片CSV。在线流式上传，独立进程构建，页面可查看阶段、错误和结果；不设文件总量/总单元格/编码数上限，实际受机器内存、磁盘及Excel格式限制。'],
      ['5. 同一预测版本或库存日期的全部分片应作为同一批次提交。构建完成后装载.supply产物，不再在线全量重算；产物保存完整数据及计算结果，可回溯。'],
      [],
      ['工作表', '数据名称', '必填字段'],
      ...Object.entries(C.schemas).map(([k, s]) => [k, s.label, s.required.map(f => s.fields[f].label).join('、')])
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(guide), '填写说明');
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
module.exports = { readFile, publicRows, workbook, parseCSV };
