'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../forecast-core');
const { changesFor } = require('../server/service');
const I = require('../server/importer');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
function example() { const s = C.sample(), e = new C.Engine(s); return { s, e, m: e.months[0], v: e.version }; }
test('shared supplier demand sums all parents exactly once; own forecast is not added to demand', () => {
  const { e, m } = example(); for (const mode of ['direct', 'cross', 'top']) { const a = e.compute(m, mode).get('A'); assert.equal(a.supply, 1000); assert.equal(a.demand, 1100); assert.equal(a.gap, 100); assert.equal(a.coverageGap, -100); const d = e.downstream('B', m, mode).find(r => r.code === 'A'); assert.equal(d.contribution, 800); assert.equal(d.gap, 100); }
});
test('direct differs from top/cross: intermediate forecast stays independent', () => {
  const { e, m } = example(); assert.equal(e.compute(m, 'direct').get('D').demand, 500); assert.equal(e.compute(m, 'cross').get('D').demand, 550); assert.equal(e.compute(m, 'top').get('D').demand, 550);
});
test('multi-path quantities sum, no ancestor double counting; dynamic engine matches independently enumerated frontier', () => {
  let seed = 1024; const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let run = 0; run < 20; run++) {
    const s = C.empty(), m = '2026-09', version = '2026-08-24';
    for (let i = 0; i < 18; i++) { const code = String(i); s.tables.attributes.push({ code, make_dept: rand() > .3 ? 'L' : 'X', lead_mean: i % 5 }); s.tables.forecast.push({ code, month: m, plan_date: version, qty: 100 + i, site_code: 'S' }); for (let j = i + 1; j < 18; j++) if (rand() < .15) s.tables.bom.push({ parent: code, child: String(j), qty: 0.5 + Math.floor(rand() * 3), id: `${i}-${j}` }); }
    const e = new C.Engine(s);
    for (const mode of ['direct', 'cross', 'top']) for (const code of e.graph.codes) {
      const targets = new Map(); function walk(c, qty) { const parents = e.graph.parents.get(c); if (c !== code && (mode === 'direct' || !parents.length || (mode === 'cross' && !e.sameIndustry(c, code)))) { targets.set(c, (targets.get(c) || 0) + qty); return; } for (const r of parents) walk(r.parent, qty * r.qty); } walk(code, 1);
      const expected = [...targets].reduce((sum, [c, q]) => sum + e.net(c, m).demand * q, 0); near(e.compute(m, mode).get(code).demand, expected); assert.deepEqual(new Map(e.relations(code, mode).map(r => [r.code, r.coeff])), targets);
    }
  }
});
test('monthly vs period single-site, unknown sites, zero rows and concentration', () => {
  const { e, m } = example(), a = e.compute(m).get('A'); assert.equal(a.sites.single, true); assert.equal(a.periodSites.single, false); assert.equal(e.compute(m).get('D').sites.count, 2); assert.ok(e.compute(m).get('D').risks.includes('加工地高度集中'));
  assert.equal(C.siteSummary([{ qty: 10, site_code: 'S1' }, { qty: 0, site_code: 'S2' }]).single, true);
  assert.equal(C.siteSummary([{ qty: 10, site_code: 'S1' }, { qty: 10 }]).single, false);
  assert.equal(C.siteSummary([{ qty: 0 }]).single, false);
});
test('missing forecasts are unknown, explicit zero is a real plan; versions stay isolated', () => {
  const { s, m, v } = example(); s.tables.forecast = s.tables.forecast.filter(r => r.code !== 'C' || r.month !== m); s.tables.forecast.push({ code: 'C', month: m, plan_date: '2020-01-01', qty: 30000, site_code: 'S3' }); const e = new C.Engine(s, v); assert.equal(e.compute(m).get('A').gap, null); s.tables.forecast.push({ code: 'C', month: m, plan_date: v, qty: 0, site_code: 'S3' }); assert.equal(new C.Engine(s, v).compute(m).get('A').demand, 800);
});
test('inventory snapshot exclusions and cumulative inventory counted once', () => {
  const { s, m } = example(); s.tables.inventory.push({ code: 'A', date: m + '-01', qty: 999, sub_type: '备件-机修' }, { code: 'A', date: m + '-02', qty: 999, sub_type: '正常' }); const e = new C.Engine(s); const c = e.cumulative('A', m, 3, 'cross'); assert.equal(c.supply, 3000); assert.equal(c.demand, 3300); assert.equal(c.coverageGap, 100); assert.equal(c.firstShortage, C.addMonth(m, 2)); assert.equal(e.compute(m).get('A').inventory, 200);
});
test('risk paths include non-critical branches; missing cycle data never means zero duration', () => {
  const { s, m } = example(); s.tables.attributes.push({ code: 'E', make_dept: '基础制造部', lead_mean: 1, lead_cv: .8 }); s.tables.bom.push({ parent: 'B', child: 'E', qty: 1 }); s.tables.forecast.push({ code: 'E', plan_date: C.today(), month: m, qty: 0, site_code: 'S5' }); let e = new C.Engine(s), p = e.paths('B', m, 'cross'); assert.deepEqual(p.critical.path, ['B', 'A', 'D']); assert.ok(p.edges.some(r => r.child === 'E')); delete s.tables.attributes.find(r => r.code === 'E').lead_mean; e = new C.Engine(s); assert.equal(e.criticalCache.get('B').complete, false);
});
test('preprocessing only applies in raw mode and removal is independent of forecast', () => {
  const { s, m } = example(); s.tables.adjust = [{ direction: '供应', code: 'A', purchase_code: 'P', month: m, qty: 200 }, { direction: '使用', code: 'B', purchase_code: '', month: m, qty: 50 }]; assert.equal(new C.Engine(s).compute(m).get('A').gap, 100); s.config.input_mode = 'raw'; const a = new C.Engine(s).compute(m).get('A'); assert.equal(a.supply, 1200); assert.equal(a.demand, 1000); s.tables.adjust[1].qty = 10000; assert.equal(C.validate(s).errors.length, 0); const nb = new C.Engine(s).net('B', m); assert.equal(nb.demand, nb.raw - 10000); assert.ok(nb.demand < 0);
});
test('forecast changes preserve baseline, additive and percentage math, zero quality scenario stable', () => {
  const { s, e, m, v } = example(), before = JSON.stringify(s);
  const modified = changesFor(s, { type: 'forecast', changes: [{ code: 'A', month: m, operation: 'percent', value: 20 }] }, v); assert.equal(new C.Engine(modified, v).compute(m).get('A').gap, -100); assert.equal(JSON.stringify(s), before);
  const unchanged = changesFor(s, { type: 'quality', code: 'A', month: m, scrapQty: 0, delayDays: 0 }, v); near(new C.Engine(unchanged, v).compute(m).get('A').gap, e.compute(m).get('A').gap);
  assert.throws(() => changesFor(s, { changes: [{ code: 'A', month: m, operation: 'add', value: -1001 }] }, v));
});
test('instruction source excludes completed/cancelled work, not added to forecast; shift actual date', () => {
  const { s, m, v } = example(); s.tables.mo = [{ mo_no: '1', code: 'A', qty: 400, due_date: m + '-28', site_code: 'S1' }, { mo_no: '2', code: 'A', qty: 5000, due_date: m + '-28', site_code: 'S1', actual_date: m + '-01' }, { mo_no: '3', code: 'A', qty: 5000, due_date: m + '-28', site_code: 'S1', status: '取消' }]; assert.equal(new C.Engine(s).compute(m, 'cross', 'mo').get('A').supply, 400);
  const after = changesFor(s, { type: 'quality', source: 'mo', code: 'A', month: m, scrapQty: 100, delayDays: 10 }, v); assert.equal(new C.Engine(after).compute(m, 'cross', 'mo').get('A').supply, 0); assert.equal(after.tables.mo.find(r => r.mo_no === '1').qty, 300);
});
test('actual headers, multi-sheets, Excel dates, text IDs, CSV quotes, wide adjustments', () => {
  const s = C.sample(), sheets = I.readFile('sample.xlsx', I.workbook(s)); assert.equal(sheets.length, 6); for (const x of sheets.filter(x => x.matrix.length > 1)) { assert.ok(x.detected); const p = C.parseMatrix(x.detected.table, x.matrix, { date1904: x.date1904 }); assert.deepEqual(p.errors, []); }
  const matrix = [['父项', '子项', '子项单位用量'], ['00123', '00234', .555]]; assert.equal(C.detect(matrix).table, 'bom'); const parsed = C.parseMatrix('bom', matrix); assert.equal(parsed.rows[0].qty, .56); assert.equal(parsed.rows[0].parent, '00123');
  assert.equal(C.date(46280), '2026-09-15'); assert.equal(C.date('2026/9/15'), '2026-09-15'); assert.throws(() => C.date('2026-02-30')); assert.throws(() => C.num('NaN'));
  const csv = I.readFile('bom.csv', Buffer.from('\uFEFF父项,子项,子项单位用量\n"P,1",C,2')); assert.equal(csv[0].detected.table, 'bom'); assert.equal(csv[0].matrix[1][0], 'P,1');
  const p = C.parseMatrix('adjust', [['供应/使用', '项目编码', '外购编码', '2026-09'], ['供应', 'A', 'P', 200]]); assert.equal(p.rows[0].qty, 200); assert.equal(p.errors.length, 0);
});
test('cycles rejected; version upsert does not erase historical versions or retain demo records', () => {
  const { s, m } = example(); const cyc = C.copy(s); cyc.tables.bom.push({ parent: 'D', child: 'B', qty: 1 }); assert.ok(C.validate(cyc).errors.length); const p = C.prepare(s, [{ table: 'forecast', rows: [{ code: 'X', plan_date: '2026-01-01', month: m, qty: 0 }] }]); assert.equal(p.next.tables.bom.length, 0); assert.equal(p.next.tables.forecast.length, 1); const q = C.prepare(p.next, [{ table: 'forecast', rows: [{ code: 'X', plan_date: '2026-02-01', month: m, qty: 0 }] }]); assert.equal(q.next.tables.forecast.length, 2);
});
test('precomputed numeric matrices equal cold computation', () => { const { s, e, m } = example(); e.precompute(); const cold = new C.Engine(s); cold.materialized = e.materialized; for (const mode of ['direct', 'cross', 'top']) assert.deepEqual([...cold.compute(m, mode)], [...e.compute(m, mode)]); });
