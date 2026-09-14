'use strict';
const fs = require('node:fs'), path = require('node:path');
const C = require('../forecast-core'), Store = require('./store'), Importer = require('./importer');
const Stream = require('./import-stream'), { Artifact, buildSnapshot } = require('./artifact');
const fail = (message, status = 422, details) => Object.assign(Error(message), { status, details });
function normalized(table, rows) {
  if (!Object.hasOwn(C.schemas, table) || !Array.isArray(rows)) throw fail('表名或数据行无效');
  const result = [];
  for (let i = 0; i < rows.length; i += 2000) { const part = Importer.publicRows(table, rows.slice(i, i + 2000)); if (part.errors.length) throw fail('字段校验失败', 422, part.errors.map(e => ({ ...e, row: e.row + i }))); for (const row of part.rows) result.push(row); }
  return result;
}
async function run(spec, progress = () => {}) {
  if (spec.action === 'inspect') return { sheets: await Stream.inspect(spec.path, spec.name) };
  if (spec.action === 'verify') { const artifact = new Artifact(spec.path); try { return { manifest: artifact.verify(progress) }; } finally { artifact.close(); } }
  const body = spec.body || {}, operation = spec.operation || 'preview';
  let store, base = C.empty();
  try {
    if (spec.base?.dbPath) { store = new Store(spec.base.dbPath, { allowObsolete: true }); base = store.load(spec.base.revision ?? store.revision()); }
    else if (spec.base?.artifact) { const artifact = new Artifact(spec.base.artifact, { allowDifferentAlgorithm: true }); try { base = artifact.load(); } finally { artifact.close(); } }
    progress({ phase: 'read', message: '读取基线和输入表', percent: 5 });
    let next = base, summaries = [], sources = [];
    if (operation === 'preview') {
      const inputs = await Stream.readInputs(spec.files || [], progress);
      for (const b of body.batches || []) { const rows = normalized(b.table, b.rows); if (!rows.length) throw fail('导入空表不执行清空'); inputs.batches.push({ table: b.table, rows }); inputs.summaries.push({ table: b.table, rows: rows.length }); }
      if (!inputs.batches.length) throw fail('请至少选择一张有数据的工作表');
      next = Stream.merge(base, inputs.batches); summaries = inputs.summaries; sources = inputs.sources;
    } else if (operation === 'sample' || operation === 'sampleLarge') next = operation === 'sample' ? C.sample() : C.sampleLarge();
    else if (operation === 'restore') { if (!store || !Number.isInteger(body.revision) || body.revision < 1) throw fail('恢复版本无效'); next = store.load(body.revision); }
    else if (operation === 'config') {
      next = { ...base, tables: { ...base.tables }, config: { ...base.config, ...body.config } };
      const c = next.config;
      if (!['net', 'raw'].includes(c.input_mode) || !Number.isFinite(c.cv_threshold) || c.cv_threshold < 0 || c.cv_threshold > 10 || !Number.isFinite(c.concentration) || c.concentration <= 0 || c.concentration > 1) throw fail('配置口径或阈值无效');
      if (body.industry) next.tables.industry = normalized('industry', body.industry);
    } else if (operation === 'maintain') {
      if (!['attributes', 'adjust'].includes(body.table)) throw fail('仅支持制造属性或调整表维护');
      const rows = normalized(body.table, body.rows); next = { ...base, tables: { ...base.tables } };
      if (body.table === 'attributes') { const codes = new Set(rows.map(r => r.code)); next.tables.attributes = base.tables.attributes.filter(r => !codes.has(r.code)).concat(rows); } else next.tables.adjust = rows;
    } else if (operation !== 'rebuild') throw fail('未知构建操作');
    // 编码范围预处理（仅业务数据路径；示例数据保留边界与不完整场景）：表1编码 ∩ 表6已维护制造部门
    if (['preview', 'maintain', 'config', 'restore'].includes(operation)) {
      const scope = C.scopeTables(next.tables), dropped = scope.before.forecast - scope.after.forecast + scope.before.inventory - scope.after.inventory + scope.before.bom - scope.after.bom;
      if (dropped) { progress({ phase: 'scope', message: `编码范围以表1∩表6制造部门为准（${scope.range}个编码），过滤 ${dropped} 行超范围数据`, percent: 22 }); spec.scopeWarning = `编码范围预处理：以表1编码且表6已维护制造部门为准（${scope.range}个编码），预测 ${scope.before.forecast}→${scope.after.forecast}、库存 ${scope.before.inventory}→${scope.after.inventory}、BOM ${scope.before.bom}→${scope.after.bom}`; }
    }
    progress({ phase: 'validate', message: '校验表关联与BOM循环依赖', percent: 25 });
    const manifest = buildSnapshot(next, spec.output, { progress, sources: [...sources, ...(spec.base ? [{ base: spec.base }] : [])] });
    if (spec.scopeWarning) manifest.warnings.push(spec.scopeWarning);
    return { path: spec.output, manifest, summaries, warnings: manifest.warnings, counts: manifest.counts, replacesSample: base.kind === 'sample' && operation === 'preview' };
  } finally { store?.close(); }
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
  console.log(JSON.stringify({ output: result.path, buildId: result.manifest.buildId, codes: result.manifest.codes, counts: result.counts }));
}
if (require.main === module) {
  if (process.send) process.once('message', async spec => {
    let last = 0, phase;
    const progress = p => { if (p.phase !== phase || Date.now() - last > 250 || p.percent === 95) { last = Date.now(); phase = p.phase; process.send({ progress: p }); } };
    try { const result = await run(spec, progress); process.send({ result }, () => process.disconnect()); }
    catch (e) { process.send({ error: { message: e.message, status: e.status || 422, details: e.details, code: e.code } }, () => process.disconnect()); }
  });
  else cli().catch(e => { console.error(JSON.stringify({ error: e.message, details: e.details })); process.exitCode = 1; });
}
module.exports = { run, normalized };
