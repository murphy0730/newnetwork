'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const C = require('../forecast-core'), Engine = require('../server/engine'), Summary = require('../server/supply-summary'), { Service } = require('../server/service');

function fixture() {
  const s = C.empty(); s.kind = 'imported';
  for (const [code, make_dept, qty] of [['A', 'a', 100], ['B1', 'a', 80], ['B2', 'a', 20], ['C', 'c', 650], ['ISO', 'c', 7]]) {
    s.tables.attributes.push({ code, make_dept, lead_mean: 1, lead_cv: .1 });
    for (let i = 0; i < 6; i++) { const month = C.addMonth('2026-09', i); s.tables.forecast.push({ code, plan_date: '2026-08-24', month, qty, site_code: 'S' }); s.tables.inventory.push({ code, date: month + '-01', qty: 30 }); }
  }
  s.tables.bom.push({ id: '1', parent: 'A', child: 'B1', qty: 2 }, { id: '2', parent: 'B1', child: 'C', qty: 3 }, { id: '3', parent: 'B2', child: 'C', qty: 5 });
  return s;
}
function serviceTest(run) {
  const service = new Service(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'supply-summary-')), 'test.sqlite'));
  try { service.publish(fixture(), 0, 'test', 'test'); run(service); } finally { service.store.close(); }
}
const q = { summary: 1, role: 'supply', month: '2026-09', limit: 20 };

test('supplier table retains all codes; focus is exact and demand role is suspended only for summary', () => serviceTest(s => {
  for (const mode of ['direct', 'cross', 'top']) {
    const all = s.list({ ...q, mode }, 'test'); assert.equal(all.total, 5);
    assert.deepEqual(all.rows.map(r => r.code).sort(), ['A', 'B1', 'B2', 'C', 'ISO']);
    const focus = s.list({ ...q, mode, code: 'C' }, 'test'); assert.equal(focus.total, 1); assert.equal(focus.rows[0].code, 'C');
    for (const code of ['A', 'B2', 'ISO']) { const r = all.rows.find(r => r.code === code); assert.equal(r.demand, null); assert.equal(r.gap, 0); assert.equal(r.coverageGap, 0); assert.equal(r.inventory, 30); assert.ok(r.supply > 0); }
  }
  assert.throws(() => s.list({ ...q, code: 'MISSING' }, 'test'), /编码不存在/);
  assert.throws(() => s.list({ ...q, role: 'demand' }, 'test'), /暂不支持需求方/);
  assert.ok(s.list({ month: q.month, mode: 'direct', role: 'demand', code: 'A' }, 'test').rows.some(r => r.code === 'B1'));
}));

test('direct, cross and top rows expose source contributions; GAP subtracts supply exactly once', () => serviceTest(s => {
  const direct = s.list({ ...q, mode: 'direct', code: 'C' }, 'test').rows[0];
  assert.deepEqual(direct.targets.map(t => [t.code, t.coeff, t.demand]).sort(), [['B1', 3, 240], ['B2', 5, 100]]);
  assert.equal(direct.demand, 340); assert.equal(direct.gap, -310);
  for (const mode of ['cross', 'top']) {
    const r = s.list({ ...q, mode, code: 'C' }, 'test').rows[0];
    assert.deepEqual(r.targets.map(t => [t.code, t.coeff, t.demand]).sort(), [['A', 6, 600], ['B2', 5, 100]]);
    assert.equal(r.demand, 700); assert.equal(r.gap, 50); assert.equal(r.coverageGap, 20);
    const risk = s.list({ ...q, mode, risk: 'shortage' }, 'test'); assert.ok(risk.rows.some(r => r.code === 'C'));
    const focused = s.list({ ...q, mode, code: 'C', industry: 'c' }, 'test'); assert.equal(focused.rows[0].demand, 700);
  }
  assert.equal(s.list({ ...q, mode: 'cross', code: 'B1' }, 'test').rows[0].applicable, false);
  const multi = s.list({ ...q, mode: 'cross', code: 'C', span: 6 }, 'test').rows[0];
  assert.equal(multi.monthly.length, 6); assert.equal(multi.demand, 4200); assert.equal(multi.supply, 3900); assert.equal(multi.coverageGap, 270); assert.equal(multi.firstShortage, '2026-09');
  assert.equal(multi.targets[0].monthly.length, 6);
  const top = s.list({ ...q, mode: 'top', code: 'A', span: 6 }, 'test').rows[0]; assert.equal(top.demand, null); assert.equal(top.gap, 0); assert.equal(top.coverageGap, 0);
}));

test('cross stops at next industry block; convergent paths sum and missing data stays unknown', () => {
  const data = fixture();
  data.tables.attributes.push({ code: 'U', make_dept: 'u' });
  data.tables.forecast.push({ code: 'U', plan_date: '2026-08-24', month: q.month, qty: 1000 });
  data.tables.bom.push({ id: '4', parent: 'U', child: 'A', qty: 2 }, { id: '5', parent: 'A', child: 'B2', qty: 4 });
  const e = new Engine(data);
  assert.deepEqual(Summary.relations(e, 'C', 'cross').map(r => [r.code, r.coeff]), [['A', 26]]);
  assert.equal(Summary.view(e, q.month, 'cross', 'forecast').byCode.get('C').demand, 2600);
  assert.equal(Summary.view(e, q.month, 'top', 'forecast').byCode.get('C').demand, 52000);
  // A is the demand source; B1's own forecast is not additionally summed.
  data.tables.forecast = data.tables.forecast.filter(r => r.code !== 'B1');
  const missingIntermediate = new Engine(data);
  assert.equal(Summary.view(missingIntermediate, q.month, 'cross', 'forecast').byCode.get('C').demand, 2600);
  data.tables.forecast = data.tables.forecast.filter(r => r.code !== 'A');
  const unknown = new Engine(data); assert.equal(Summary.view(unknown, q.month, 'cross', 'forecast').byCode.get('C').demand, null);
});

test('summary aggregate and source detail agree on mixed-department DAGs including unknown departments', () => {
  for (let variant = 0; variant < 5; variant++) {
    const data = fixture();
    for (let i = 0; i < 25; i++) {
      const code = 'N' + i; data.tables.attributes.push({ code, make_dept: i === variant ? '' : ['a', 'b', 'c'][i % 3] });
      data.tables.forecast.push({ code, plan_date: '2026-08-24', month: q.month, qty: i * 10 });
      for (let j = 1; j <= 3; j++) if (i >= j) data.tables.bom.push({ id: code + '-' + j, parent: 'N' + (i - j), child: code, qty: j });
    }
    const e = new Engine(data);
    for (const mode of ['direct', 'cross', 'top']) for (const row of Summary.view(e, q.month, mode, 'forecast').rows) {
      const base = { code: row.code, risks: row.risks };
      const detail = Summary.decorate(e, base, q.month, 1, [q.month], mode, 'forecast');
      assert.equal(detail.demand, row.demand, mode + '/' + row.code); assert.equal(detail.gap, row.gap, mode + '/' + row.code);
    }
  }
});

test('summary reads isolated scenario quantities and never changes baseline or another actor access', () => serviceTest(s => {
  const before = s.list({ ...q, mode: 'cross', code: 'C' }, 'test').rows[0];
  const scenario = s.simulate({ version: '2026-08-24', month: q.month, baseRevision: 1, changes: [{ code: 'A', month: q.month, operation: 'add', value: 10 }] }, 'test');
  const after = s.list({ ...q, mode: 'cross', code: 'C', scenario: scenario.id }, 'test').rows[0];
  assert.equal(after.demand, 760); assert.equal(after.gap, 110); assert.equal(after.targets.find(t => t.code === 'A').demand, 660);
  assert.equal(s.list({ ...q, mode: 'cross', code: 'C' }, 'test').rows[0].demand, before.demand);
  assert.throws(() => s.list({ ...q, scenario: scenario.id }, 'other'), /无权/);
}));

test('raw adjustments and production-order supply retain the same forecast demand basis', () => {
  const data = fixture(); data.config.input_mode = 'raw';
  data.tables.adjust.push({ code: 'A', month: q.month, direction: '使用', qty: 10 }, { code: 'C', month: q.month, direction: '供应', qty: 25 });
  data.tables.mo.push({ id: 'MO1', code: 'C', sched_date: q.month + '-10', qty: 600, status: 'open', site_code: 'S' });
  const e = new Engine(data);
  for (const source of ['forecast', 'mo']) {
    const row = Summary.view(e, q.month, 'cross', source).byCode.get('C');
    const detail = Summary.decorate(e, { code: 'C', risks: row.risks }, q.month, 1, [q.month], 'cross', source);
    assert.equal(row.demand, 640); assert.equal(detail.demand, 640);
    assert.equal(detail.supply, source === 'forecast' ? 675 : 600);
    assert.equal(detail.gap, source === 'forecast' ? -35 : 40);
  }
});
