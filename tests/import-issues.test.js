'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const C = require('../forecast-core'), { run } = require('../server/build'), { Artifact } = require('../server/artifact');
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tower-issues-'));

test('all files and later CSV batches are scanned; reports exceed parser/UI error limits with original rows', async () => {
  const root = dir(), output = path.join(root, 'result.supply');
  const forecast = path.join(root, 'forecast.csv'), bom = path.join(root, 'bom.csv'), attr = path.join(root, 'attributes.csv');
  fs.writeFileSync(forecast, 'plan_date,code,month,qty,site_code\n' + Array.from({ length: 2501 }, (_, i) => `2026-09-10,P${i},2026-09,invalid${i},S1\n`).join(''));
  fs.writeFileSync(bom, 'parent,child,qty\nA,B,bad-ratio\n');
  fs.writeFileSync(attr, 'part_no,make_dept\nB,\nA,D\n');
  let failure;
  try { await run({ output, files: [{ path: forecast, table: 'forecast' }, { path: bom, table: 'bom' }, { path: attr, table: 'attributes' }] }); } catch (e) { failure = e; }
  assert.ok(failure); assert.ok(failure.issues.errors >= 2502); assert.equal(failure.details.length, 100);
  assert.ok(failure.issues.byTable.forecast >= 2501); assert.ok(failure.issues.byTable.bom >= 1); assert.ok(failure.issues.byTable.attributes >= 1);
  assert.equal(fs.existsSync(output), false);
  const csv = fs.readFileSync(output + '.issues.forecast.csv', 'utf8');
  assert.ok(csv.includes('invalid2500')); assert.ok(csv.includes('"2502"')); assert.ok(csv.includes('P2500'));
  const rows = require('../server/importer').parseCSV(csv.replace(/^\uFEFF/, ''));
  assert.ok(rows.length > 2501); assert.equal(rows.find(r => r[5] === 'P2000')[4], '2002');
});

test('successful scope filtering reports empty departments, small BOM ratios and every excluded input row', async () => {
  const root = dir(), output = path.join(root, 'result.supply');
  const data = C.sample(); data.tables.attributes.find(r => r.code === 'A').make_dept = '';
  data.tables.bom.push({ parent: 'B', child: 'D', qty: .001 });
  const result = await run({ output, body: { batches: Object.entries(data.tables).filter(([, rows]) => rows.length).map(([table, rows]) => ({ table, rows })) } });
  assert.equal(result.issues.errors, 0); assert.ok(result.issues.warnings > 0);
  for (const table of ['attributes', 'forecast', 'inventory', 'bom']) assert.ok(result.issues.byTable[table] > 0);
  assert.ok(fs.readFileSync(output + '.issues.attributes.csv', 'utf8').includes('make_dept'));
  assert.ok(fs.readFileSync(output + '.issues.bom.csv', 'utf8').includes('0.01'));
  const artifact = new Artifact(output); try { assert.ok([...artifact.rows('table/forecast')].every(r => r.code !== 'A')); } finally { artifact.close(); }
});

test('every supported API input table gets its own downloadable issue file', async () => {
  const root = dir(), output = path.join(root, 'result.supply');
  const batches = Object.keys(C.schemas).map(table => ({ table, rows: [{}] }));
  await assert.rejects(run({ output, body: { batches } }), e => {
    for (const table of Object.keys(C.schemas)) assert.ok(e.issues.byTable[table] > 0, table);
    return true;
  });
  for (const table of Object.keys(C.schemas)) assert.ok(fs.existsSync(output + '.issues.' + table + '.csv'));
});

test('Excel scans multiple selected worksheets and preserves worksheet names in reports', async () => {
  const root = dir(), output = path.join(root, 'result.supply'), filename = path.join(root, 'multiple.xlsx');
  const XLSX = require('../vendor/xlsx'), wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['说明'], ['plan_date', 'code', 'month', 'qty'], ['2026-09-10', 'BAD-XLSX', '2026-09', 'bad']]), '预测来源');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['parent', 'child', 'qty'], ['A', 'B', 'bad']]), 'BOM来源');
  fs.writeFileSync(filename, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  await assert.rejects(run({ output, files: [{ path: filename, selections: [{ table: 'forecast', sheet: '预测来源', headerRow: 1 }, { table: 'bom', sheet: 'BOM来源', headerRow: 0 }] }] }), e => {
    assert.ok(e.issues.byTable.forecast); assert.ok(e.issues.byTable.bom); return true;
  });
  const csv = fs.readFileSync(output + '.issues.forecast.csv', 'utf8');
  assert.ok(csv.includes('预测来源')); assert.ok(csv.includes('"3","BAD-XLSX"'));
});

test('filter-rule data never blocks CSV import: small BOM ratios and empty make_dept only enter the issue list', async () => {
  const root = dir(), output = path.join(root, 'result.supply');
  const forecast = path.join(root, 'forecast.csv'), bom = path.join(root, 'bom.csv'), attr = path.join(root, 'attributes.csv');
  fs.writeFileSync(forecast, 'plan_date,code,month,qty,site_code\n2026-09-10,A,2026-09,100,S1\n2026-09-10,B,2026-09,50,S1\n');
  fs.writeFileSync(bom, 'parent,child,qty\nA,B,0.005\nA,C,0.001\n'); // 全部行配比<0.01
  fs.writeFileSync(attr, 'part_no,make_dept,lead_mean\nA,甲部门,5\nB,,\n'); // make_dept为空；lead_mean为空不算异常
  const result = await run({ output, files: [{ path: forecast }, { path: bom }, { path: attr }] });
  assert.equal(result.issues.errors, 0); assert.ok(result.issues.warnings >= 4);
  assert.ok(result.issues.byTable.bom >= 3); // 两行配比 + 整表过滤汇总
  const attrCsv = fs.readFileSync(output + '.issues.attributes.csv', 'utf8');
  assert.equal(result.issues.byTable.attributes, 1); // 表6仅检查 make_dept 为空，其他字段留空不记异常
  assert.ok(attrCsv.includes('make_dept'));
  const artifact = new Artifact(output); try {
    assert.equal([...artifact.rows('table/bom')].length, 0); // 过滤后不进入后续计算
    assert.deepEqual([...artifact.rows('table/forecast')].map(r => r.code), ['A']); // B 被范围预处理过滤
  } finally { artifact.close(); }
});

test('association errors also have an untruncated report after the shared validation step', async () => {
  const root = dir(), output = path.join(root, 'result.supply');
  await assert.rejects(run({ output, body: { batches: [{ table: 'attributes', rows: Array.from({ length: 1201 }, () => ({ code: 'DUP', make_dept: 'D', lead_mean: 1 })) }] } }), e => { assert.equal(e.issues.errors, 1200); return true; });
  const csv = fs.readFileSync(output + '.issues.attributes.csv', 'utf8');
  assert.ok(csv.includes('"1202"')); assert.ok(csv.includes('重复键'));
});
