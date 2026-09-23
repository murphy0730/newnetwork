'use strict';
// 地图版渲染器的纯函数回归：块聚合 / 尺寸 / 排布 / 流 Top-N 裁剪。
const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateBlocks, blockSizes, placeBlocks, placeSubColumn, placeCodeRows, fitLabel, pickFocusBlock, aggregateFlows, flowWidth, layered, pickInitialLevel, LOD_SMALL_MAX, LOD_MEDIUM_MAX } = require('../forecast-graph.map.js');

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

test('placeSubColumn：子块列锚定焦点块中心、按层自顶向下、确定性', () => {
  const anchor = { x: 100, y: 50, w: 200, h: 120, cx: 200, cy: 110 };
  const units = [{ key: 'A0', count: 12 }, { key: 'A1', count: 30 }, { key: 'A2', count: 5 }];
  const col = placeSubColumn(anchor, units);
  assert.equal(col.pos.size, 3);
  const a0 = col.pos.get('A0'), a1 = col.pos.get('A1');
  assert.equal(a0.cx, anchor.cx); assert.equal(a1.cx, anchor.cx);
  assert.ok(a0.cy < a1.cy, '同列低层应在上方');
  assert.ok(col.width >= anchor.w, '列宽不小于锚点宽度');
  assert.ok(col.title.cy < a0.cy && col.title.cx === anchor.cx, '标题在列顶且居中');
  const again = placeSubColumn(anchor, units);
  for (const k of col.pos.keys()) assert.deepEqual(col.pos.get(k), again.pos.get(k));
});

test('placeCodeRows：行以锚点为中心、编码等距、行标签在最左列之外', () => {
  const anchor = { cx: 500, cy: 300 };
  const rows = [{ level: 0, codes: ['a', 'b', 'c'] }, { level: 1, codes: ['d', 'e'] }];
  const plan = placeCodeRows(anchor, rows);
  const y0 = plan.pos.get('a').y, y1 = plan.pos.get('d').y;
  assert.ok(y0 < y1, '低层在上');
  assert.equal(plan.pos.get('b').x - plan.pos.get('a').x, 60);
  assert.equal((plan.pos.get('a').x + plan.pos.get('c').x) / 2, anchor.cx, '行中心对齐锚点');
  assert.ok(plan.rowRects.get(0).cx < plan.pos.get('d').x, '行标签在行块左侧');
  assert.equal((y0 + y1) / 2, anchor.cy, '整体垂直居中于锚点');
});

test('fitLabel：屏幕宽度不足时省略，足够时原样', () => {
  assert.equal(fitLabel('电机产业 · 85', 500, 12), '电机产业 · 85');
  const t = fitLabel('电机产业 · 85', 60, 12);
  assert.ok(t.endsWith('…') && t.length < 8);
  assert.equal(fitLabel('', 0, 12), '');
  assert.equal(fitLabel('AB', 0, 12), 'A…');
});

test('pickFocusBlock：风险数优先，平手取编码数，空输入安全', () => {
  const blocks = [
    { key: '甲', count: 100, riskCount: 3 },
    { key: '乙', count: 40, riskCount: 9 },
    { key: '丙', count: 90, riskCount: 9 }
  ];
  assert.equal(pickFocusBlock(blocks), '丙');   // 风险并列 → 编码数多者
  assert.equal(pickFocusBlock([{ key: 'x', count: 1, riskCount: 0 }]), 'x');
  assert.equal(pickFocusBlock([]), null);
});

test('aggregateFlows 风险加权：风险边多的流排前', () => {
  const BLK = { x1: 'X', x2: 'X', y1: 'Y', z1: 'Z' };
  const edges = [
    { source: 'x1', target: 'y1' }, { source: 'x1', target: 'y1' }, { source: 'x1', target: 'y1' },   // X->Y 3 条无风险
    { source: 'x2', target: 'z1', risk: true }, { source: 'x2', target: 'z1', risk: true }            // X->Z 2 条全风险 → 权重 4
  ];
  const flows = aggregateFlows(edges, c => BLK[c], { perSource: 5, max: 10 });
  assert.equal(flows[0].t, 'Z');            // 2 条风险边（权重4）压过 3 条普通边
  assert.equal(flows[0].riskCount, 2);
});

test('placeBlocks 以原点为中心（换档可 zoomTo(z,[0,0]) 居中）', () => {
  const blocks = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ key: 'k' + i, count: i * 7, meanLevel: (i % 4) }));
  const r = placeBlocks(blocks);
  const v = [...r.pos.values()];
  const cx = (Math.min(...v.map(p => p.x)) + Math.max(...v.map(p => p.x + p.w))) / 2;
  const cy = (Math.min(...v.map(p => p.y)) + Math.max(...v.map(p => p.y + p.h))) / 2;
  assert.ok(Math.abs(cx) < 1e-6 && Math.abs(cy) < 1e-6, '应以原点为中心');
});

test('pickInitialLevel：聚焦直达 C，小数据集全量 C，中等 B，大规模 A', () => {
  assert.equal(pickInitialLevel(5000, true), 'C');                    // 有聚焦（选中编码）直达明细
  assert.equal(pickInitialLevel(1, false), 'C');
  assert.equal(pickInitialLevel(LOD_SMALL_MAX, false), 'C');          // 小数据集边界：直接全量
  assert.equal(pickInitialLevel(LOD_SMALL_MAX + 1, false), 'B');
  assert.equal(pickInitialLevel(LOD_MEDIUM_MAX, false), 'B');         // 中等数据集边界：层内结构
  assert.equal(pickInitialLevel(LOD_MEDIUM_MAX + 1, false), 'A');     // 大规模从聚类总览开始
});

test('保留的旧 layered() 仍可用（向后兼容）', () => {
  const nodes = [N('A', 0, {}), N('B', 1, {}), N('C', 1, {})];
  const plan = layered(nodes, [], 0, 0, n => 'g');
  assert.equal(plan.positions.size, 3);
  assert.equal(plan.groups.length, 1);
  assert.ok(plan.width > 0 && plan.height > 0);
});
