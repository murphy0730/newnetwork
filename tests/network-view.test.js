'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const C = require('../forecast-core'), { Service } = require('../server/service'), { layered } = require('../forecast-layout');

test('complete graph exceeds legacy node/edge caps; multi-select filters preserve demand and category cache isolation', () => {
  const data = C.empty(), sample = C.sample();
  for (let l = 0; l < 7; l++) for (let i = 0; i < 200; i++) {
    const code = `L${l}-${i}`;
    data.tables.forecast.push({ ...sample.tables.forecast[0], code, qty: 100, site_code: 'S' + (i % 3), site_name: 'Site' + (i % 3) });
    data.tables.attributes.push({ code, name: 'Part' + i, make_dept: 'D', part_category: i % 2 ? 'odd' : 'even', lead_mean: 1, lead_cv: 0 });
    if (l) for (let j = 0; j < 5; j++) data.tables.bom.push({ parent: `L${l-1}-${(i+j)%200}`, child: code, qty: 1 });
  }
  const s = new Service(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tower-network-')), 'test.sqlite'));
  try {
    s.publish(data, 0, 'test', 'test');
    const q = { month: data.tables.forecast[0].month, mode: 'direct', graphRelations: 'bom' };
    const all = s.graph({ ...q, limit: 1 }, 'test');
    assert.equal(all.nodes.length, 1400); assert.equal(all.edges.length, 6000); assert.equal(all.truncated, false);
    assert.equal(s.graph({ ...q, code: 'L3-1', depth: 10, limit: 1 }, 'test').truncated, false);
    const selected = ['L2-0', 'L2-1', 'L2-2'];
    const list = s.list({ ...q, site: JSON.stringify(['S0', 'S1']), codes: JSON.stringify(selected) }, 'test');
    assert.deepEqual(list.rows.map(r => r.code).sort(), selected.slice(0, 2));
    const graph = s.graph({ ...q, site: ['S0', 'S1'], codes: selected }, 'test');
    assert.equal(graph.matchedNodes, 2); assert.ok(graph.nodes.length > 2);
    for (const row of list.rows) assert.equal(row.demand, all.nodes.find(n => n.code === row.code).demand);
    const odd = s.list({ ...q, category: 'odd' }, 'test'), even = s.list({ ...q, category: 'even' }, 'test');
    assert.equal(odd.total, 700); assert.equal(even.total, 700);
    assert.ok(odd.rows.every(r => r.category === 'odd')); assert.ok(even.rows.every(r => r.category === 'even'));
    assert.equal(s.list({ ...q, site: 'S0' }, 'test').total, s.list({ ...q, site: ['S0'] }, 'test').total);
    assert.throws(() => s.list({ ...q, codes: '[1]' }, 'test'), /字符串数组/);
  } finally { s.store.close(); }
});

test('BOM bands keep all ten levels and parent-before-child order with clustering, resize and large data', () => {
  const nodes = [], edges = [];
  for (let l = 0; l < 10; l++) for (let i = 0; i < 120; i++) {
    const code = l + ':' + i; nodes.push({ code, level: l, category: i % 2 ? 'finished' : 'raw' });
    if (l) edges.push({ source: (l-1) + ':' + i, target: code });
  }
  for (const [w, h] of [[1200, 600], [600, 900]]) {
    const plan = layered(nodes, edges, w, h, n => n.category);
    assert.equal(plan.positions.size, nodes.length); assert.equal(plan.regions.length, 10);
    for (const e of edges) assert.ok(plan.positions.get(e.source)[1] < plan.positions.get(e.target)[1]);
    for (let i = 1; i < plan.regions.length; i++) assert.ok(plan.regions[i-1].bottom < plan.regions[i].top);
    assert.ok(Math.abs(plan.width / plan.height - w / h) < 0.3);
  }
  assert.notDeepEqual(layered(nodes, edges, 1200, 600).positions, layered(nodes, edges, 600, 900).positions);
  const big = Array.from({ length: 100000 }, (_, i) => ({ code: 'P' + i, level: i % 10 }));
  const plan = layered(big, [], 1400, 700);
  assert.equal(plan.positions.size, 100000); assert.equal(plan.regions.length, 10);
  assert.ok([...plan.positions.values()].every(p => p.every(Number.isFinite)));
});

test('graph nodes carry the 表3 parent/child template for type coloring', () => {
  const data = C.sample(), s = new Service(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tower-template-')), 'test.sqlite'));
  try {
    s.publish(data, 0, 'test', 'test');
    const g = s.graph({ month: data.tables.forecast[0].month, mode: 'direct', limit: 1 }, 'test');
    const type = Object.fromEntries(g.nodes.map(n => [n.code, n.template]));
    assert.equal(type.B, '成品模板'); assert.equal(type.C, '成品模板');
    assert.equal(type.A, '半成品模板'); assert.equal(type.D, '原材料模板');
  } finally { s.store.close(); }
});
