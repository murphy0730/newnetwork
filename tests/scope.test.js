'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../forecast-core.js');

test('编码范围预处理：表1编码 ∩ 表6已维护制造部门，筛选预测/库存/BOM', () => {
  const s = C.empty(), t = s.tables;
  t.attributes.push({ code: 'A', make_dept: '甲部门' }, { code: 'B', make_dept: '' }, { code: 'X', make_dept: '乙部门' });
  t.forecast.push({ plan_date: '2026-09-14', code: 'A', month: '2026-09', qty: 10 }, { plan_date: '2026-09-14', code: 'B', month: '2026-09', qty: 20 }, { plan_date: '2026-09-14', code: 'C', month: '2026-09', qty: 30 }, { plan_date: '2026-09-14', code: 'X', month: '2026-09', qty: 5 });
  t.inventory.push({ date: '2026-09-01', code: 'A', qty: 5 }, { date: '2026-09-01', code: 'C', qty: 7 });
  t.bom.push({ id: '1', parent: 'X', child: 'A', qty: 1 }, { id: '2', parent: 'X', child: 'B', qty: 1 }, { id: '3', parent: 'X', child: 'C', qty: 1 });
  const r = C.scopeTables(t);
  assert.equal(r.range, 2); // A、X 在范围；B 的 make_dept 为空、C 不在表6，均出范围
  assert.deepEqual(t.forecast.map(x => x.code), ['A', 'X']);
  assert.deepEqual(t.inventory.map(x => x.code), ['A']);
  assert.deepEqual(t.bom.map(x => x.id), ['1']);
  assert.deepEqual([r.before.bom, r.after.bom], [3, 1]);
});

test('库存预处理：子库类型可空，负数可用量按减法计入', () => {
  const inv = C.parseMatrix('inventory', [['创建日期', '编码', '可用量', '子库类型'], ['2026-09-01', 'A', '100', ''], ['2026-09-01', 'A', '-40', '']]);
  assert.equal(inv.errors.length, 0);
  const s = C.empty(); s.tables.inventory = inv.rows; const e = new C.Engine(s);
  assert.equal(e.inventory.get(JSON.stringify(['A', '2026-09-01'])), 60);
});

test('BOM预处理：配比小于0.01的父子项自动过滤，其余按两位小数修约', () => {
  const p = C.parseMatrix('bom', [['父项', '子项', '子项单位用量'], ['P', 'A', '0.005'], ['P', 'B', '0.01'], ['P', 'C', '0.555'], ['P', 'C', '1']]);
  assert.equal(p.errors.length, 0);
  assert.deepEqual(p.rows.map(r => [r.child, r.qty]), [['B', 0.01], ['C', 0.56], ['C', 1]]);
});
