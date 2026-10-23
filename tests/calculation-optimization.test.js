'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../forecast-core'), Engine = require('../server/engine');
const version = '2026-09-24';
function fixture(seed) {
  const s = C.empty(); s.config.input_mode = 'raw';
  let state = seed;
  const random = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  for (let i = 0; i < 90; i++) {
    const code = 'P' + i;
    if (random(5)) s.tables.attributes.push({ code, make_dept: random(6) ? 'D' + random(5) : '', lead_mean: 1 });
    for (let m = 0; m < 4; m++) {
      const month = C.addMonth('2026-09', m);
      if (random(4)) s.tables.forecast.push({ code, plan_date: version, month, qty: random(9) ? random(200) - 20 : 0 });
      s.tables.adjust.push({ code, month, direction: '使用', qty: random(20) });
    }
    if (i > 11) for (let p = 0; p < 3; p++) s.tables.bom.push({ parent: 'P' + random(i), child: code, qty: [0.25, 0.5, 1, 2][random(4)], parent_template: 'AI', child_template: 'AI' });
  }
  return s;
}

test('indexed demand propagation matches independently resolved sources across sparse converging BOMs', () => {
  for (const seed of [1, 17, 2026, 123456, 4294967295]) {
    const s = fixture(seed), e = new Engine(s);
    for (const month of e.months) for (const mode of ['direct', 'cross', 'top']) {
      const matrix = e.matrix(month, mode, 'forecast');
      for (const code of e.graph.order) {
        let amount = 0, flags = e.graph.parents.get(code).length ? 0 : 1;
        for (const link of e.relations(code, mode, month, true)) {
          const net = e.net(link.code, month), known = mode === 'direct' || net.known;
          if (known) amount += Math.abs(net.demand || 0) * link.coeff;
          flags |= known ? 1 : 2;
        }
        const i = e.orderIndex.get(code);
        assert.equal(matrix[i * 2], amount, `${seed}/${month}/${mode}/${code} amount`);
        assert.equal(matrix[i * 2 + 1], flags, `${seed}/${month}/${mode}/${code} known flags`);
      }
    }
  }
});

test('supply sources share demand buffers in either calculation order while retaining distinct supplies', () => {
  for (const sources of [['forecast', 'mo'], ['mo', 'forecast']]) {
    const s = C.empty();
    s.tables.attributes = [{ code: 'A', make_dept: 'X' }, { code: 'C', make_dept: 'Y' }];
    s.tables.bom = [{ parent: 'A', child: 'C', qty: 2, parent_template: 'AI', child_template: 'AI' }];
    s.tables.forecast = [{ code: 'A', plan_date: version, month: '2026-09', qty: 100 }, { code: 'C', plan_date: version, month: '2026-09', qty: 50 }];
    s.tables.mo = [{ code: 'C', due_date: '2026-09-20', qty: 30 }];
    for (const Type of [C.Engine, Engine]) {
      const e = new Type(s);
      for (const mode of ['direct', 'cross', 'top']) {
        assert.equal(e.matrix('2026-09', mode, sources[0]), e.matrix('2026-09', mode, sources[1]));
        const forecast = e.row('C', '2026-09', mode, 'forecast'), mo = e.row('C', '2026-09', mode, 'mo');
        assert.deepEqual([forecast.demand, forecast.supply, forecast.gap], [200, 50, 150]);
        assert.deepEqual([mo.demand, mo.supply, mo.gap], [200, 30, 170]);
      }
    }
  }
});

test('shared BOM topology does not share department indexes between scenarios', () => {
  const s = C.empty();
  s.tables.attributes = [{ code: 'A', make_dept: 'X' }, { code: 'B', make_dept: 'X' }, { code: 'C', make_dept: 'Y' }];
  s.tables.bom = [{ parent: 'A', child: 'B', qty: 1 }, { parent: 'B', child: 'C', qty: 1 }];
  s.tables.forecast = [['A', 100], ['B', 80], ['C', 50]].map(([code, qty]) => ({ code, qty, plan_date: version, month: '2026-09' }));
  const e = new Engine(s); assert.equal(e.row('C', '2026-09', 'cross').demand, 80);
  const modified = C.copy(s); modified.tables.attributes[1].make_dept = 'Y';
  const scenario = new Engine(modified, version, e.graph);
  assert.equal(scenario.row('C', '2026-09', 'cross').demand, 100);
  assert.equal(e.row('C', '2026-09', 'cross').demand, 80);
});
