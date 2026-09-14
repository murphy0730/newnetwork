'use strict';
const fs = require('node:fs'), path = require('node:path');
const C = require('../forecast-core'), Store = require('./store'), Importer = require('./importer');
const Stream = require('./import-stream'), { Artifact, buildSnapshot } = require('./artifact');
const { Issues, scopeIssues } = require('./import-issues');
const fail = (message, status = 422, details) => Object.assign(Error(message), { status, details });
function normalized(table, rows, issues) {
  if (!Object.hasOwn(C.schemas, table) || !Array.isArray(rows)) throw fail('表名或数据行无效');
  const result = [];
  for (let i = 0; i < rows.length; i += 2000) {
    const part = Importer.publicRows(table, rows.slice(i, i + 2000));
    if (part.errors.length && !issues) throw fail('字段校验失败', 422, part.errors.map(e => ({ ...e, row: e.row + i })));
    const invalid = new Set(part.errors.map(e => e.row));
    for (const e of part.errors) {
      const raw = rows[e.row + i - 2] || {}, key = Object.keys(C.schemas[table].fields).find(k => C.schemas[table].fields[k].label === e.field);
      issues.add({ ...e, row: e.row + i, table, code: raw.code ?? raw.part_no ?? raw['编码'], parent: raw.parent ?? raw['父项'], child: raw.child ?? raw['子项'], value: raw[e.field] ?? raw[key], raw });
    }
    if (issues && table === 'bom') for (let j = i; j < Math.min(i + 2000, rows.length); j++) {
      const r = rows[j], value = r.qty ?? r[C.schemas.bom.fields.qty.label];
      if (value != null && String(value).trim() && Number(value) >= 0 && Number(value) < 0.01) issues.add({ table, file: 'API', sheet: table, row: j + 2, parent: r.parent, child: r.child, field: 'qty', value, raw: r, severity: 'warning', message: 'BOM配比小于0.01', action: '按既有规则过滤此父子项' });
    }
    for (const row of part.rows) if (!invalid.has(row._source.row)) { row._source.row += i; result.push(row); }
  }
  return result;
}
async function run(spec, progress = () => {}) {
  const body = spec.body || {}, operation = spec.operation || 'preview';
  let store, base = C.empty();
  const issues = new Issues(spec.reportPrefix || (spec.output || spec.path) + '.issues');
  try {
    if (spec.action === 'inspect') return { sheets: await Stream.inspect(spec.path, spec.name), issues: issues.summary() };
    if (spec.action === 'verify') { const artifact = new Artifact(spec.path); try { return { manifest: artifact.verify(progress), issues: issues.summary() }; } finally { artifact.close(); } }
    if (spec.base?.dbPath) { store = new Store(spec.base.dbPath, { allowObsolete: true }); base = store.load(spec.base.revision ?? store.revision()); }
    else if (spec.base?.artifact) { const artifact = new Artifact(spec.base.artifact, { allowDifferentAlgorithm: true }); try { base = artifact.load(); } finally { artifact.close(); } }
    progress({ phase: 'read', message: '读取基线和输入表', percent: 5 });
    let next = base, summaries = [], sources = [];
    if (operation === 'preview') {
      const inputs = await Stream.readInputs(spec.files || [], progress, issues);
      for (const b of body.batches || []) {
        try { const rows = normalized(b.table, b.rows, issues); if (!rows.length) throw fail('导入空表不执行清空'); inputs.batches.push({ table: b.table, rows }); inputs.summaries.push({ table: b.table, rows: rows.length }); }
        catch (e) { for (const detail of e.details || [{ message: e.message }]) issues.add({ table: b.table, file: 'API', sheet: b.table, ...detail }); }
      }
      if (!inputs.batches.length && !issues.counts.errors) throw fail('请至少选择一张有数据的工作表');
      next = Stream.merge(base, inputs.batches); summaries = inputs.summaries; sources = inputs.sources;
    } else if (operation === 'sample' || operation === 'sampleLarge') next = operation === 'sample' ? C.sample() : C.sampleLarge();
    else if (operation === 'restore') { if (!store || !Number.isInteger(body.revision) || body.revision < 1) throw fail('恢复版本无效'); next = store.load(body.revision); }
    else if (operation === 'config') {
      next = { ...base, tables: { ...base.tables }, config: { ...base.config, ...body.config } };
      const c = next.config;
      if (!['net', 'raw'].includes(c.input_mode) || !Number.isFinite(c.cv_threshold) || c.cv_threshold < 0 || c.cv_threshold > 10 || !Number.isFinite(c.concentration) || c.concentration <= 0 || c.concentration > 1) throw fail('配置口径或阈值无效');
    } else if (operation === 'maintain') {
      if (!['attributes', 'adjust'].includes(body.table)) throw fail('仅支持制造属性或调整表维护');
      const rows = normalized(body.table, body.rows, issues); next = { ...base, tables: { ...base.tables } };
      if (body.table === 'attributes') { const codes = new Set(rows.map(r => r.code)); next.tables.attributes = base.tables.attributes.filter(r => !codes.has(r.code)).concat(rows); } else next.tables.adjust = rows;
    } else if (operation !== 'rebuild') throw fail('未知构建操作');
    // 编码范围预处理（仅业务数据路径；示例数据保留边界与不完整场景）：表1编码 ∩ 表6已维护制造部门
    if (['preview', 'maintain', 'config', 'restore'].includes(operation)) {
      scopeIssues(next.tables, issues);
      const scope = C.scopeTables(next.tables), dropped = scope.before.forecast - scope.after.forecast + scope.before.inventory - scope.after.inventory + scope.before.bom - scope.after.bom;
      if (dropped) { progress({ phase: 'scope', message: `编码范围以表1∩表6制造部门为准（${scope.range}个编码），过滤 ${dropped} 行超范围数据`, percent: 22 }); spec.scopeWarning = `编码范围预处理：以表1编码且表6已维护制造部门为准（${scope.range}个编码），预测 ${scope.before.forecast}→${scope.after.forecast}、库存 ${scope.before.inventory}→${scope.after.inventory}、BOM ${scope.before.bom}→${scope.after.bom}`; }
    }
    progress({ phase: 'validate', message: '校验表关联与BOM循环依赖', percent: 25 });
    const validation = C.validate(next);
    if (validation.errors.length) {
      const bySource = new Map();
      for (const [table, rows] of Object.entries(next.tables)) for (const row of rows) if (row._source) bySource.set(JSON.stringify([row._source.file, row._source.sheet, row._source.row]), { table, row });
      for (const detail of validation.errors) {
        const found = bySource.get(JSON.stringify([detail.file, detail.sheet, detail.row]));
        const table = found?.table || Object.keys(C.schemas).find(t => detail.message.startsWith(C.schemas[t].label)) || (detail.field === 'BOM' ? 'bom' : detail.field === '使用剔除' ? 'adjust' : 'unknown');
        issues.add({ ...detail, table, code: found?.row.code, parent: found?.row.parent, child: found?.row.child, raw: found?.row });
      }
    }
    if (issues.counts.errors) throw fail('字段校验失败；本批次各输入表的问题已汇总，请下载完整清单', 422);
    const manifest = buildSnapshot(next, spec.output, { progress, validation, sources: [...sources, ...(spec.base ? [{ base: spec.base }] : [])] });
    if (spec.scopeWarning) manifest.warnings.push(spec.scopeWarning);
    return { path: spec.output, manifest, summaries, warnings: manifest.warnings, counts: manifest.counts, replacesSample: base.kind === 'sample' && operation === 'preview', issues: issues.summary() };
  } catch (e) {
    if (!issues.counts.errors) for (const detail of e.details || [{ message: e.message }]) issues.add({ file: spec.name || '', table: detail.table || (detail.field === 'BOM' ? 'bom' : undefined), ...detail });
    e.issues = issues.summary(); e.details = issues.preview; throw e;
  } finally { store?.close(); issues.close(); }
}
async function cli() {
  const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
  if (args.includes('--help') || !args.includes('--config')) { console.log('用法: node --max-old-space-size=8192 server/build.js --config build.json --out dataset.supply\n配置: {"files":[{"path":"forecast.csv","table":"forecast"}],"base":{"dbPath":"data/control-tower.sqlite","revision":1}}\n仅重建现有库: 在配置中设置 "operation":"rebuild"。Excel可自动识别工作表，也可提供selections。'); return; }
  const configPath = path.resolve(value('--config')), spec = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')), baseDir = path.dirname(configPath);
  spec.files = (spec.files || []).map(f => ({ ...f, path: path.resolve(baseDir, f.path) }));
  if (spec.base?.dbPath) spec.base.dbPath = path.resolve(baseDir, spec.base.dbPath);
  if (spec.base?.artifact) spec.base.artifact = path.resolve(baseDir, spec.base.artifact);
  spec.output = path.resolve(args.includes('--out') ? value('--out') : path.resolve(baseDir, spec.output || 'dataset.supply'));
  const result = await run(spec, p => console.log(JSON.stringify({ ...p, at: new Date().toISOString() })));
  console.log(JSON.stringify({ output: result.path, buildId: result.manifest.buildId, codes: result.manifest.codes, counts: result.counts, issues: result.issues, issueReport: spec.output + '.issues.csv' }));
}
if (require.main === module) {
  if (process.send) process.once('message', async spec => {
    let last = 0, phase;
    const progress = p => { if (p.phase !== phase || Date.now() - last > 250 || p.percent === 95) { last = Date.now(); phase = p.phase; process.send({ progress: p }); } };
    try { const result = await run(spec, progress); process.send({ result }, () => process.disconnect()); }
    catch (e) { process.send({ error: { message: e.message, status: e.status || 422, details: e.details, code: e.code, issues: e.issues } }, () => process.disconnect()); }
  });
  else cli().catch(e => { console.error(JSON.stringify({ error: e.message, details: e.details, issues: e.issues })); process.exitCode = 1; });
}
module.exports = { run, normalized };
