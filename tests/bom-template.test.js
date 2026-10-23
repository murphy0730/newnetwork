'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const C = require('../forecast-core'), Engine = require('../server/engine');
const { run } = require('../server/build'), { Artifact } = require('../server/artifact');
const Summary = require('../server/supply-summary');

function fixture() {
  const s = C.empty();
  s.tables.attributes.push({ code: '03028VPE', make_dept: 'D1' }, { code: '02315NVE', make_dept: 'D1' });
  s.tables.forecast.push({ code: '03028VPE', plan_date: '2026-09-24', month: '2026-10', qty: 50, site_code: 'S' });
  for (const [parent, child, parent_template] of [['02233VXE', '02302155', 'POC'], ['02302155', '02315NVE', 'AI'], ['02315NVE', '03028VPE', 'AI']]) {
    s.tables.bom.push({ id: parent, parent, child, qty: 1, parent_template, child_template: 'AI' });
  }
  return s;
}

test('AI scope stops the real example at 02302155 in both shared and server engines without deleting raw BOM', () => {
  const data = fixture();
  for (const Type of [C.Engine, Engine]) {
    const e = new Type(data);
    assert.deepEqual(e.graph.parents.get('02302155'), []);
    assert.ok(!e.graph.codes.includes('02233VXE'));
    for (const mode of ['cross', 'top']) {
      assert.deepEqual(e.relations('03028VPE', mode, '2026-10', true).map(r => r.code), ['02302155']);
      if (Type === Engine) {
        const row = Summary.decorate(e, { code: '03028VPE' }, '2026-10', 1, ['2026-10'], mode, 'forecast');
        assert.deepEqual(row.targets.map(r => [r.code, r.make_dept, r.demand]), [['02302155', '未知部门', null]]);
        assert.equal(row.complete, false);
      }
    }
  }
  assert.equal(data.tables.bom.length, 3);
});

test('template decisions use every parent/child occurrence; conflicts and missing templates stay with source warnings', () => {
  const rows = [
    { parent: 'U', child: 'X', qty: 1, parent_template: 'AI', child_template: 'AI', _source: { file: 'one.csv', row: 2 } },
    { parent: 'X', child: 'C', qty: 1, parent_template: 'POC', child_template: 'AI', _source: { file: 'two.csv', row: 3 } },
    { parent: 'M', child: 'C', qty: 1, parent_template: '', child_template: 'AI' },
    { parent: 'M', child: 'D', qty: 1, parent_template: 'POC', child_template: 'AI' },
    { parent: 'N', child: 'C', qty: 1, parent_template: 'POC', child_template: 'AI' },
    { parent: 'U', child: 'N', qty: 1, parent_template: 'AI', child_template: 'POC' }
  ];
  const issues = [], result = C.bomTemplateScope(rows, issue => issues.push(issue));
  assert.deepEqual(result.rows, rows.slice(0, 4));
  assert.equal(result.excluded, 2);
  assert.ok(issues.some(r => r.code === 'X' && r.field === 'child_template' && r.row === 2 && r.file === 'one.csv' && r.message.includes('不一致') && r.action.includes('保留')));
  assert.ok(issues.some(r => r.code === 'X' && r.field === 'parent_template' && r.row === 3 && r.file === 'two.csv'));
  assert.ok(issues.some(r => r.code === 'M' && r.message.includes('缺失')));
  assert.ok(issues.every(r => r.severity === 'warning'));
  assert.deepEqual(C.bomTemplateScope([...rows].reverse()).rows, rows.slice(0, 4).reverse());
});

test('excluded templates do not introduce false cycles and an AI child is not reconnected across an excluded parent', () => {
  const s = C.empty();
  s.tables.bom = [
    { parent: 'A', child: 'P', qty: 1, parent_template: 'AI', child_template: 'POC' },
    { parent: 'P', child: 'C', qty: 1, parent_template: 'POC', child_template: 'AI' },
    { parent: 'C', child: 'A', qty: 1, parent_template: 'AI', child_template: 'AI' }
  ];
  assert.equal(C.validate(s).errors.length, 0);
  const e = new Engine(s);
  assert.deepEqual(e.graph.parents.get('C'), []);
  assert.deepEqual(e.graph.parents.get('A').map(r => r.parent), ['C']);
});

test('API builds and artifact rebuilds retain raw template evidence and restore the same AI-only graph', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bom-template-')), output = path.join(root, 'data.supply');
  const data = fixture();
  const result = await run({ output, body: { batches: Object.entries(data.tables).filter(([, rows]) => rows.length).map(([table, rows]) => ({ table, rows })) } });
  assert.equal(result.issues.errors, 0);
  assert.equal(result.manifest.counts.bom, 3);
  assert.equal(result.manifest.edges, 2);
  assert.ok(fs.readFileSync(output + '.issues.bom.csv', 'utf8').includes('02233VXE'));
  for (const file of [output, path.join(root, 'rebuilt.supply')]) {
    if (file !== output) await run({ output: file, operation: 'rebuild', base: { artifact: output } });
    const artifact = new Artifact(file);
    try {
      assert.equal([...artifact.rows('table/bom')].length, 3);
      const e = Engine.restore(artifact.load(), '2026-09-24', artifact);
      assert.deepEqual(e.relations('03028VPE', 'cross', '2026-10', true).map(r => r.code), ['02302155']);
      assert.equal(e.graph.parents.get('02302155').length, 0);
    } finally { artifact.close(); }
  }
});

test('CSV template conflicts across files report original rows and do not block import or remove the conflicted code', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bom-template-csv-'));
  const first = path.join(root, 'one.csv'), second = path.join(root, 'two.csv'), output = path.join(root, 'data.supply');
  fs.writeFileSync(first, 'parent,child,qty,parent_template,child_template\nU,X,1,AI,AI\n');
  fs.writeFileSync(second, 'parent,child,qty,parent_template,child_template\nX,C,1,POC,AI\nM,C,1,,AI\n');
  const result = await run({ output, files: [{ path: first, table: 'bom' }, { path: second, table: 'bom' }] });
  assert.equal(result.issues.errors, 0);
  assert.equal(result.manifest.edges, 3);
  const report = fs.readFileSync(output + '.issues.bom.csv', 'utf8');
  assert.ok(report.includes('不一致') && report.includes('缺失') && report.includes('one.csv') && report.includes('two.csv'));
  assert.ok(report.includes('保留'));
});

test('rebuilding preserves conflict evidence even when the AI occurrence is on an excluded relation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bom-template-conflict-')), first = path.join(root, 'first.supply');
  const rows = [
    { parent: 'U', child: 'X', qty: 1, parent_template: 'POC', child_template: 'AI' },
    { parent: 'X', child: 'C', qty: 1, parent_template: 'POC', child_template: 'AI' }
  ];
  await run({ output: first, body: { batches: [{ table: 'bom', rows }] } });
  const rebuilt = path.join(root, 'rebuilt.supply');
  await run({ output: rebuilt, operation: 'rebuild', base: { artifact: first } });
  const artifact = new Artifact(rebuilt);
  try {
    const restored = Engine.restore(artifact.load(), undefined, artifact);
    assert.equal(artifact.manifest.edges, 1);
    assert.equal([...artifact.rows('table/bom')].length, 2);
    assert.deepEqual(restored.graph.parents.get('C').map(r => r.parent), ['X']);
  } finally { artifact.close(); }
});
