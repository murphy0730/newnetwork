'use strict';
// 地图版渲染器的纯函数回归：块聚合 / 尺寸 / 排布 / 流 Top-N 裁剪。
const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateBlocks, blockSizes, placeBlocks, placeColumns, aggregateFlows, flowWidth, layered } = require('../forecast-graph.map.js');

const N = (code, level, extra) => Object.assign({ code, level }, extra || {});

test('aggregateBlocks 计数与风险统计正确', () => {
  const nodes = [
    N('A-001', 0, { make_dept: '整机', gap: 5 }),
    N('A-002', 1, { make_dept: '整机', single: true }),
    N('B-001', 2, { make_dept: '材料' }),
    N('B-002', 3, { make_dept: '材料', multiLevel: true })
  ];
  const blocks = aggregateBlocks(nodes, n => n.make_dept);
  assert.equal(blocks.length, 2);
  const zj = blocks.find(b => b.key === '整机'), cl = blocks.find(b => b.key === '材料');
  assert.equal(zj.count, 2); assert.equal(zj.gapCount, 1); assert.equal(zj.singleCount, 1); assert.equal(zj.riskCount, 2);
  assert.equal(zj.meanLevel, 0.5);
  assert.equal(cl.count, 2); assert.equal(cl.multiCount, 1); assert.equal(cl.riskCount, 0);
});

test('aggregateBlocks 缺键归入「未分组」', () => {
  const blocks = aggregateBlocks([N('X', 0, {})], () => null);
  assert.equal(blocks[0].key, '未分组');
});

test('blockSizes 面积随 count 单调不减，且落在给定区间', () => {
  const blocks = [{ key: 'a', count: 1 }, { key: 'b', count: 100 }, { key: 'c', count: 10000 }];
  const s = blockSizes(blocks);
  assert.ok(s.get('a').w <= s.get('b').w && s.get('b').w <= s.get('c').w);
  assert.equal(s.get('a').w, 76);
  assert.equal(s.get('c').w, 260);
});

test('placeBlocks 确定性且同带内不重叠', () => {
  const blocks = [1, 2, 3, 4, 5, 6].map(i => ({ key: 'k' + i, count: i * 10, meanLevel: i % 3 }));
  const a = placeBlocks(blocks), b = placeBlocks(blocks);
  for (const k of a.pos.keys()) assert.deepEqual(a.pos.get(k), b.pos.get(k));   // 同输入同输出
  const list = [...a.pos.values()];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const p = list[i], q = list[j];
    const overlapX = p.x < q.x + q.w && q.x < p.x + p.w;
    const overlapY = p.y < q.y + q.h && q.y < p.y + p.h;
    assert.ok(!(overlapX && overlapY), '块不应重叠: ' + i + ',' + j);
  }
});

test('placeBlocks 空输入安全', () => {
  const r = placeBlocks([]);
  assert.equal(r.pos.size, 0); assert.ok(r.width > 0 && r.height > 0);
});

test('aggregateFlows 排除自环、按每源 Top-N 与总量上限裁剪、按流量降序', () => {
  const BLK = { x1: 'X', x2: 'X', x3: 'X', y1: 'Y', y2: 'Y', z1: 'Z' };
  const blockOf = c => BLK[c];
  const edges = [
    { source: 'x1', target: 'y1' }, { source: 'x1', target: 'y1' }, { source: 'x1', target: 'y2' }, // X->Y = 3
    { source: 'x2', target: 'z1' },                                                                // X->Z = 1
    { source: 'y1', target: 'z1' },                                                                // Y->Z = 1
    { source: 'x1', target: 'x2' }                                                                 // 自环（同块）应被排除
  ];
  // 每源只留 1 条最强：X 留 X->Y(3)，Y 留 Y->Z(1) → 2 条
  const flows = aggregateFlows(edges, blockOf, { perSource: 1, max: 10 });
  assert.equal(flows.length, 2);
  assert.deepEqual([flows[0].s, flows[0].t, flows[0].count], ['X', 'Y', 3]);
  // 按流量降序
  assert.ok(flows[0].count >= flows[1].count);
  // 自环被排除
  assert.ok(flows.every(f => f.s !== f.t));
  // 总量上限生效
  const capped = aggregateFlows(edges, blockOf, { perSource: 99, max: 2 });
  assert.equal(capped.length, 2);
  // 不裁剪时 3 条（X->Y, X->Z, Y->Z）
  assert.equal(aggregateFlows(edges, blockOf, { perSource: 99, max: 99 }).length, 3);
});

test('aggregateFlows 保留 critical / risk 并集标记', () => {
  const edges = [{ source: 'a', target: 'b', critical: true }, { source: 'a', target: 'b', risk: true }];
  const flows = aggregateFlows(edges, c => c, { perSource: 5, max: 5 });
  assert.equal(flows.length, 1);
  assert.equal(flows[0].count, 2); assert.equal(flows[0].critical, true); assert.equal(flows[0].risk, true);
});

test('flowWidth 单调、有上界', () => {
  assert.ok(flowWidth(1) < flowWidth(10));
  assert.ok(flowWidth(10) <= flowWidth(10000));
  assert.equal(flowWidth(10000), 4.6);
});

test('placeColumns 每块一列、列内按层自顶向下、列间不重叠、居中于原点', () => {
  const U = (bk, lv, count) => ({ key: bk + '\u0000' + lv, count, meanLevel: lv, riskCount: 0 });
  const units = [U('甲', 0, 5), U('甲', 1, 40), U('乙', 0, 9), U('乙', 1, 3), U('丙', 1, 20)];
  const plan = placeColumns(units);
  assert.equal(plan.columns.length, 3);
  // 列按总规模降序：甲(45) 乙(12) 丙(20) → 甲, 丙, 乙
  assert.deepEqual(plan.columns.map(c => c.key), ['甲', '丙', '乙']);
  // 同列内层 0 在层 1 之上
  const a0 = plan.pos.get('甲\u00000'), a1 = plan.pos.get('甲\u00001');
  assert.ok(a0.cy < a1.cy, '同列低层应在上方');
  assert.equal(a0.cx, a1.cx, '同列应共享 cx');
  // 居中：整体 bbox 中心接近原点
  const xs = [...plan.pos.values()]; const cxAvg = (Math.min(...xs.map(p => p.x)) + Math.max(...xs.map(p => p.x + p.w))) / 2;
  assert.ok(Math.abs(cxAvg) < 1e-6, '应水平居中于原点');
  const cyAvg = (Math.min(...xs.map(p => p.y)) + Math.max(...xs.map(p => p.y + p.h))) / 2;
  assert.ok(Math.abs(cyAvg) < 1e-6, '应垂直居中于原点');
});

test('placeBlocks 以原点为中心（换档可 zoomTo(z,[0,0]) 居中）', () => {
  const blocks = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ key: 'k' + i, count: i * 7, meanLevel: (i % 4) }));
  const r = placeBlocks(blocks);
  const v = [...r.pos.values()];
  const cx = (Math.min(...v.map(p => p.x)) + Math.max(...v.map(p => p.x + p.w))) / 2;
  const cy = (Math.min(...v.map(p => p.y)) + Math.max(...v.map(p => p.y + p.h))) / 2;
  assert.ok(Math.abs(cx) < 1e-6 && Math.abs(cy) < 1e-6, '应以原点为中心');
});

test('保留的旧 layered() 仍可用（向后兼容）', () => {
  const nodes = [N('A', 0, {}), N('B', 1, {}), N('C', 1, {})];
  const plan = layered(nodes, [], 0, 0, n => 'g');
  assert.equal(plan.positions.size, 3);
  assert.equal(plan.groups.length, 1);
  assert.ok(plan.width > 0 && plan.height > 0);
});
