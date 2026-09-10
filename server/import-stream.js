'use strict';
const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const C = require('../forecast-core'), XLSX = require('../vendor/xlsx');
const bad = (message, details) => Object.assign(Error(message), { status: 422, details });

async function encodingFor(filename, prefixOnly = false) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try { for await (const chunk of fs.createReadStream(filename, { ...(prefixOnly ? { end: 65535 } : {}) })) decoder.decode(chunk, { stream: true }); if (!prefixOnly) decoder.decode(); return 'utf-8'; }
  catch (e) { if (e.code && e.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw e; return 'gb18030'; }
}
async function* csvRows(filename, { encoding = 'utf-8', progress = () => {}, maxRows = Infinity, stats = {} } = {}) {
  const decoder = new TextDecoder(encoding, { fatal: true }), digest = createHash('sha256');
  let row = [], parts = [], length = 0, quoted = false, afterQuote = false, skipLF = false, records = 0, bytes = 0, lastProgress = 0;
  // Only a single field is bounded; there is no total-file/cell/row budget.
  function append(value) { if (!value) return; length += value.length; if (length > 16 * 1024 * 1024) throw bad('单个CSV字段超过16Mi字符，请检查分隔符或未闭合引号'); parts.push(value); }
  function finish() { const value = parts.join(''); parts = []; length = 0; return value; }
  function* consume(text) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (skipLF) { skipLF = false; if (ch === '\n') continue; }
      // Append spans instead of retaining per-character V8 cons-string chains.
      if (quoted) { const end = text.indexOf('"', i); if (end < 0) { append(text.slice(i)); break; } append(text.slice(i, end)); i = end; quoted = false; afterQuote = true; continue; }
      if (afterQuote && ch === '"') { append('"'); quoted = true; afterQuote = false; continue; }
      if (afterQuote && ch !== ',' && ch !== '\r' && ch !== '\n') throw bad(`CSV第${records + 1}条记录：闭合引号后必须是分隔符或换行`);
      if (ch === '"') { if (length) throw bad(`CSV第${records + 1}条记录：字段引号格式错误`); quoted = true; }
      else if (ch === ',') { row.push(finish()); afterQuote = false; }
      else if (ch === '\r' || ch === '\n') { row.push(finish()); afterQuote = false; const done = row; row = []; records++; skipLF = ch === '\r'; yield done; }
      else { let end = i + 1; while (end < text.length && text[end] !== ',' && text[end] !== '"' && text[end] !== '\r' && text[end] !== '\n') end++; append(text.slice(i, end)); i = end - 1; }
    }
  }
  const total = fs.statSync(filename).size;
  for await (const chunk of fs.createReadStream(filename, { highWaterMark: 256 * 1024 })) {
    digest.update(chunk); bytes += chunk.length;
    for (const row of consume(decoder.decode(chunk, { stream: true }))) { yield row; if (records >= maxRows) return; }
    if (Date.now() - lastProgress > 200) { progress({ phase: 'parse', message: `读取CSV：${records} 行`, processed: bytes, total }); lastProgress = Date.now(); }
  }
  for (const row of consume(decoder.decode())) yield row;
  if (quoted) throw bad('CSV引号未闭合');
  if (length || row.length || afterQuote) { row.push(finish()); records++; yield row; }
  Object.assign(stats, { bytes, rows: records, sha256: digest.digest('hex') });
}
function excel(filename) { return XLSX.read(fs.readFileSync(filename), { type: 'buffer', cellNF: true, cellText: true, cellFormula: true }); }
function* sheetRows(sheet, name, maxRows = Infinity) {
  if (!sheet['!ref']) return;
  const range = XLSX.utils.decode_range(sheet['!ref']);
  for (let ri = 0; ri <= range.e.r && ri < maxRows; ri++) {
    const row = [];
    for (let ci = 0; ci <= range.e.c; ci++) { const cell = sheet[XLSX.utils.encode_cell({ r: ri, c: ci })]; if (cell?.f && cell.v == null) throw bad(`${name}第${ri + 1}行公式无缓存值，请在Excel中计算并保存`); row.push(cell ? cell.t === 'n' && /^0+$/.test(cell.z || '') && cell.w ? cell.w : cell.v ?? '' : ''); }
    yield row;
  }
}
async function inspect(filename, name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.csv') {
    const rows = [];
    for await (const row of csvRows(filename, { encoding: await encodingFor(filename, true), maxRows: 20 })) rows.push(row);
    return [{ name: path.basename(name, path.extname(name)), rows: null, detected: C.detect(rows), preview: rows.slice(0, 5) }];
  }
  if (!['.xlsx', '.xls'].includes(ext)) throw bad('支持CSV、xlsx、xls原始表，或.supply构建产物');
  const wb = excel(filename);
  return wb.SheetNames.map(name => { const sheet = wb.Sheets[name], rows = [...sheetRows(sheet, name, 20)], detected = C.detect(rows); return { name, rows: sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']).e.r : 0, detected: detected && rows.slice(detected.headerRow + 1).some(row => row.some(v => v !== '' && v != null)) ? detected : null, preview: rows.slice(0, 5) }; });
}
async function normalize(iterator, table, meta, destination, progress = () => {}) {
  if (!Object.hasOwn(C.schemas, table)) throw bad('目标表无效');
  const headerRow = Number(meta.headerRow || 0);
  if (!Number.isInteger(headerRow) || headerRow < 0 || headerRow > 9) throw bad('表头行须为1至10');
  let header, rowNumber = 0, batch = [], count = 0, start = headerRow + 1;
  const flush = () => {
    if (!batch.length) return;
    const result = C.parseMatrix(table, [header, ...batch], { ...meta, headerRow: 0 });
    const errors = result.errors.map(e => ({ ...e, row: e.row === 1 ? headerRow + 1 : e.row + start - 1 }));
    if (errors.length && !errors.every(e => e.message === '没有数据行，未执行清空')) throw bad('字段校验失败', errors);
    for (const r of result.rows) { r._source.row += start - 1; destination.push(r); count++; }
    batch = []; start = rowNumber;
    progress({ phase: 'normalize', message: `${meta.sheet}：已校验 ${count} 行` });
  };
  for await (const row of iterator) { const index = rowNumber++; if (index < headerRow) continue; if (index === headerRow) { header = row; continue; } batch.push(row); if (batch.length >= 2000) flush(); }
  flush();
  if (!count) throw bad('没有有效数据行，未执行清空', [{ ...meta, row: headerRow + 1, message: '空表请跳过' }]);
  return count;
}
async function readInputs(files, progress = () => {}) {
  const groups = new Map(), summaries = [], sources = [];
  for (const file of files) {
    const ext = path.extname(file.name || file.path).toLowerCase(), name = file.name || path.basename(file.path);
    const destination = table => { if (!groups.has(table)) groups.set(table, []); return groups.get(table); };
    if (ext === '.csv') {
      const selected = (file.selections || [{ sheet: path.basename(name, ext), table: file.table, headerRow: file.headerRow }]).filter(s => s.table);
      if (selected.length > 1) throw bad('同一CSV不能重复选择多个目标表');
      for (const selection of selected) { const stats = {}, rows = await normalize(csvRows(file.path, { encoding: await encodingFor(file.path), progress, stats }), selection.table, { file: name, sheet: selection.sheet, headerRow: selection.headerRow }, destination(selection.table), progress); summaries.push({ file: name, sheet: selection.sheet, table: selection.table, rows }); sources.push({ name, ...stats }); }
    } else if (['.xlsx', '.xls'].includes(ext)) {
      progress({ phase: 'parse', message: `解析Excel ${name}（大型工作簿需足够内存，可改用分片CSV）` });
      const wb = excel(file.path), selections = file.selections || wb.SheetNames.map(sheet => ({ sheet, ...C.detect([...sheetRows(wb.Sheets[sheet], sheet, 20)]) }));
      for (const selection of selections.filter(s => s.table)) { if (!wb.Sheets[selection.sheet]) throw bad('指定工作表不存在'); const rows = await normalize(sheetRows(wb.Sheets[selection.sheet], selection.sheet), selection.table, { file: name, sheet: selection.sheet, headerRow: selection.headerRow, date1904: !!wb.Workbook?.WBProps?.date1904 }, destination(selection.table), progress); summaries.push({ file: name, sheet: selection.sheet, table: selection.table, rows }); }
      const digest = createHash('sha256'); for await (const chunk of fs.createReadStream(file.path)) digest.update(chunk); sources.push({ name, bytes: fs.statSync(file.path).size, sha256: digest.digest('hex') });
    } else throw bad('原始表格式应为CSV、xlsx或xls');
  }
  return { batches: [...groups].map(([table, rows]) => ({ table, rows })), summaries, sources };
}
function merge(base, batches) {
  const starting = base.kind === 'sample' ? C.empty() : base, next = { ...starting, tables: { ...starting.tables }, config: { ...starting.config }, kind: 'imported' }, groups = new Map();
  for (const batch of batches) { if (!groups.has(batch.table)) groups.set(batch.table, []); for (const r of batch.rows) groups.get(batch.table).push(r); }
  for (const [table, rows] of groups) {
    if (table === 'forecast' || table === 'inventory') { const key = table === 'forecast' ? 'plan_date' : 'date', replacing = new Set(rows.map(r => r[key])); next.tables[table] = starting.tables[table].filter(r => !replacing.has(r[key])).concat(rows); }
    else next.tables[table] = rows;
  }
  return next;
}
module.exports = { inspect, csvRows, normalize, readInputs, merge };
