'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const XLSX = require('../vendor/xlsx');

function exportRows(rows, overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../forecast-app.js'), 'utf8');
  const start = source.indexOf('  function downloadRows('), end = source.indexOf('  async function refreshMeta(', start);
  let workbook, filename;
  const context = { XLSX: { ...XLSX, writeFile: (wb, name) => { workbook = wb; filename = name; }, ...overrides } };
  vm.runInNewContext(source.slice(start, end), context);
  context.downloadRows('供应汇总', rows);
  return { workbook, filename };
}

test('expanded supplier exports keep worksheet property counts bounded and preserve Excel values', () => {
  // 8,000 suppliers expand to 24,000 source rows, rather than 8,000 Excel rows.
  const rows = [];
  for (let code = 0; code < 8000; code++) for (let source = 0; source < 3; source++) {
    rows.push({ 编码: 'C' + code, 名称: '零件-' + code, 跨产业编码: 'P' + source,
      累计BOM用量: source + 1, 来源折算需求: 10 * (source + 1),
      净供应: source === 0 ? 50 : '', 跨产业总需求: source === 0 ? 60 : '',
      供需结余: source === 0 ? -10 : '', 最新库存: source === 0 ? 20 : '',
      库存后结余: source === 0 ? 10 : '', 预测版本: '2026-09-24', 起始月份: '2026-09' });
  }
  const { workbook, filename } = exportRows(rows);
  assert.equal(filename, '供应汇总.xlsx');
  const sheet = workbook.Sheets.data;
  assert.equal(XLSX.utils.decode_range(sheet['!ref']).e.r, rows.length);
  assert.ok(Object.keys(sheet).length < 1024, 'a worksheet must not collect every cell as a property on one object');
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const restored = XLSX.read(bytes, { type: 'buffer', dense: true });
  const actual = XLSX.utils.sheet_to_json(restored.Sheets.data);
  assert.deepEqual(actual, rows);
  assert.equal(actual.reduce((sum, row) => sum + (row.净供应 || 0), 0), 8000 * 50);
  assert.equal(actual.reduce((sum, row) => sum + (row.供需结余 || 0), 0), 8000 * -10);
});

test('empty exports still produce a valid workbook', () => {
  const { workbook } = exportRows([]);
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const restored = XLSX.read(bytes, { type: 'buffer' });
  assert.deepEqual(XLSX.utils.sheet_to_json(restored.Sheets.data), []);
});

test('export errors retain the original cause and identify the failing stage and expanded row count', () => {
  for (const stage of ['准备Excel数据', '生成Excel文件']) {
    const error = new RangeError('Too many properties to enumerate');
    const fail = () => { throw error; };
    const overrides = stage === '准备Excel数据' ? { utils: { ...XLSX.utils, json_to_sheet: fail } } : { writeFile: fail };
    assert.throws(() => exportRows([{ code: 'C', target: 'P1' }, { code: 'C', target: 'P2' }], overrides), e => {
      assert.equal(e, error);
      assert.equal(e.message, `${stage}失败（2行）：Too many properties to enumerate`);
      return true;
    });
  }
});
