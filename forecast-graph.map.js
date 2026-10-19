/* Forecast graph renderer（地图版 / cluster-block map）— AntV G6 v5.
 *
 * 设计：以「聚类对象」为主视觉单元的三档语义缩放（地图化），三档共用同一世界坐标系：
 *   A 集群视图：聚类块 = 业务仪表（标题 + 风险徽标 + 风险占比条 + 风险结构行），
 *     块间只画 Top-N 风险加权汇总流，画布上没有一个编码点。
 *   B 分组视图：焦点块在锚点原地展开为 BOM 层列，其余块折叠为锚点小色块（点击切焦点）。
 *   C 编码视图：焦点块编码在锚点处按层分行（硬上限 MAX_CODES），只画局部边，关键编码带标签。
 *
 * 交互：滚轮/按钮只缩放视野，不换档；点击块下钻（居中推近）、面包屑返回。
 *   块的位置永不动（统一世界坐标），换档只切换可见元素集合 = 空间记忆连续、无闪烁；
 *   标注按 zoom 反向补偿，任何缩放下 ≥11px。块不可拖动（块是锚点），拖拽 = 平移整个画布。
 *
 * 兼容原 ForecastGraph 公开 API（构造签名、setData/setLayout/setCluster/setColorBy/
 * setHighlight/setEdgeOpacity/setShowRatio/select/fit/zoomIn/zoomOut/destroy + graph 字段），
 * 并以 ForecastGraphMap 全局名导出（经典版缺席时才回退占用 ForecastGraph），
 * 因此主页面可同时加载两版按布局切换，独立 index.map.html 也无需改动。
 * setData 初始档由 pickInitialLevel 按数据量/选中编码智能决定（小数据直接全量明细）。
 */
(function (root) {
  'use strict';

  // ============================================================
  // 旧分层网格布局（保留导出：ForecastLayout.layered，兼容其它用途）
  // ============================================================
  function layered(nodes, edges, width, height, group = () => '') {
    const positions = new Map(), ranks = new Map();
    const groupSet = new Map(), levelSet = new Map();
    for (const n of nodes) {
      const g = String(group(n) || '');
      if (!groupSet.has(g)) groupSet.set(g, 0);
      const l = Math.max(0, Number(n.level) || 0);
      ranks.set(n.code, l);
      if (!levelSet.has(l)) levelSet.set(l, 0);
    }
    const groups = [...groupSet.keys()].sort((a, b) => a.localeCompare(b));
    const levels = [...levelSet.keys()].sort((a, b) => a - b);
    if (!groups.length) groups.push('');
    if (!levels.length) levels.push(0);
    const buckets = new Map();
    for (const n of nodes) {
      const key = String(group(n) || '') + '\u0000' + (Math.max(0, Number(n.level) || 0));
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(n);
    }
    const CELL_W = 74, CELL_H = 44, BAND_PAD = 60, LEVEL_PAD = 64;
    const bandWidths = new Map(), levelHeights = new Map();
    for (const g of groups) {
      let m = 0;
      for (const l of levels) m = Math.max(m, (buckets.get(g + '\u0000' + l) || []).length);
      const cols = Math.max(2, Math.ceil(Math.sqrt(m)));
      bandWidths.set(g, Math.max(180, cols * CELL_W + BAND_PAD));
    }
    for (const l of levels) {
      let m = 0;
      for (const g of groups) m = Math.max(m, (buckets.get(g + '\u0000' + l) || []).length);
      const rows = Math.max(2, Math.ceil(Math.sqrt(m)));
      levelHeights.set(l, Math.max(150, rows * CELL_H + LEVEL_PAD));
    }
    const groupX = new Map(); let x = 0;
    for (const g of groups) { groupX.set(g, x); x += bandWidths.get(g); }
    const levelY = new Map(); let y = 0;
    for (const l of levels) { levelY.set(l, y); y += levelHeights.get(l); }
    for (const g of groups) {
      const gx = groupX.get(g), gw = bandWidths.get(g);
      for (const l of levels) {
        const arr = buckets.get(g + '\u0000' + l) || [];
        if (!arr.length) continue;
        const ly = levelY.get(l), lh = levelHeights.get(l);
        const cols = Math.max(1, Math.ceil(Math.sqrt(arr.length)));
        const rows = Math.ceil(arr.length / cols);
        const stepX = (gw - BAND_PAD) / cols, stepY = (lh - LEVEL_PAD) / rows;
        arr.forEach((n, i) => {
          const c = i % cols, r = Math.floor(i / cols);
          positions.set(n.code, [gx + BAND_PAD / 2 + (c + 0.5) * stepX, ly + LEVEL_PAD / 2 + (r + 0.5) * stepY]);
        });
      }
    }
    const regions = levels.map(l => ({ level: l, top: levelY.get(l) - 8, bottom: levelY.get(l) + levelHeights.get(l) + 8, count: 0 }));
    for (const n of nodes) {
      const l = Math.max(0, Number(n.level) || 0);
      const rg = regions.find(r => r.level === l);
      if (rg) rg.count++;
    }
    const bucketList = [];
    for (const g of groups) for (const l of levels) {
      const arr = buckets.get(g + '\u0000' + l) || [];
      if (!arr.length) continue;
      let sx = 0, sy = 0;
      for (const n of arr) { const p = positions.get(n.code); sx += p[0]; sy += p[1]; }
      bucketList.push({ key: g, level: l, codes: arr.map(n => n.code), cx: sx / arr.length, cy: sy / arr.length, count: arr.length });
    }
    return { positions, regions, width: x, height: y, ranks, groupX, groupY: levelY, groups, levels, buckets: bucketList };
  }

  // ============================================================
  // 地图版纯函数（无 DOM / 无 G6，可单测）
  // ============================================================

  // 把编码节点按 keyOf 聚合为「块」：块携带计数与风险统计
  function aggregateBlocks(nodes, keyOf) {
    const map = new Map();
    for (const n of nodes) {
      const raw = keyOf(n);
      const key = String(raw == null || raw === '' ? '未分组' : raw);
      let b = map.get(key);
      if (!b) { b = { key, codes: [], count: 0, levelSum: 0, gapCount: 0, singleCount: 0, multiCount: 0, incompleteCount: 0, riskCount: 0 }; map.set(key, b); }
      b.codes.push(n.code);
      b.count++;
      b.levelSum += Math.max(0, Number(n.level) || 0);
      const risky = (n.gap || 0) > 1e-8;
      if (risky) b.gapCount++;
      if (n.single) b.singleCount++;
      if (n.multiLevel) b.multiCount++;
      if (n.complete === false) b.incompleteCount++;
      if (risky || n.single || n.complete === false) b.riskCount++;
    }
    for (const b of map.values()) b.meanLevel = b.count ? b.levelSum / b.count : 0;
    return [...map.values()];
  }

  // 块尺寸：面积 ∝ √count，按本数据集把 min..max 拉满，保证视觉差异明显
  function blockSizes(blocks, opts) {
    const o = Object.assign({ minSize: 76, maxSize: 260, ratio: 0.72, minH: 52 }, opts || {});
    const roots = blocks.map(b => Math.sqrt(Math.max(1, b.count)));
    const lo = roots.length ? Math.min(...roots) : 1, hi = roots.length ? Math.max(...roots) : 1;
    const map = new Map();
    for (const b of blocks) {
      const t = hi > lo ? (Math.sqrt(Math.max(1, b.count)) - lo) / (hi - lo) : 0.5;
      const w = o.minSize + t * (o.maxSize - o.minSize);
      map.set(b.key, { w, h: Math.max(o.minH, w * o.ratio) });
    }
    return map;
  }

  // 确定性二维有机打包（地图式"群岛"）：面积降序 → 黄金角螺旋初始化 →
  // 迭代松弛（矩形分轴推开；前期叠加弱的「产业链位置」纵向偏置）。无随机数，同输入同输出。
  // 返回的坐标以原点为中心，便于换档时 zoomTo(z,[0,0]) 直接居中。
  function placeBlocks(blocks, opts) {
    const o = Object.assign({ gap: 56, iterations: 320, vBias: 0.85, squash: 0.62 }, opts || {});
    if (!blocks.length) return { pos: new Map(), width: 1, height: 1 };
    const sizes = blockSizes(blocks, o);
    const order = blocks.slice().sort((a, b) => {
      const sa = sizes.get(a.key), sb = sizes.get(b.key);
      return (sb.w * sb.h) - (sa.w * sa.h) || String(a.key).localeCompare(String(b.key));
    });
    const maxLevel = Math.max(1, ...blocks.map(b => b.meanLevel));
    const P = new Map();
    let acc = 0;
    order.forEach((b, i) => {
      const s = sizes.get(b.key);
      const r = Math.sqrt(acc / Math.PI) * 1.06 + Math.max(s.w, s.h) * 0.42;
      const th = i * 2.399963229728653;   // 黄金角
      P.set(b.key, { cx: Math.cos(th) * r, cy: Math.sin(th) * r * o.squash, w: s.w, h: s.h });
      acc += s.w * s.h;
    });
    const R = Math.sqrt(acc / Math.PI) * 1.06;
    const settle = Math.floor(o.iterations * 0.45);
    for (let it = 0; it < o.iterations; it++) {
      for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) {
        const a = P.get(order[i].key), b = P.get(order[j].key);
        const dx = b.cx - a.cx, dy = b.cy - a.cy;
        const ox = (a.w + b.w) / 2 + o.gap - Math.abs(dx);
        const oy = (a.h + b.h) / 2 + o.gap - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox < oy) { const s = (dx >= 0 ? 1 : -1) * ox / 2; a.cx -= s; b.cx += s; }
          else { const s = (dy >= 0 ? 1 : -1) * oy / 2; a.cy -= s; b.cy += s; }
        }
      }
      if (it < settle) for (const b of blocks) {
        const p = P.get(b.key);
        const targetY = ((b.meanLevel / maxLevel) - 0.5) * R * 1.05;
        p.cy += (targetY - p.cy) * 0.05 * o.vBias;
      }
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of blocks) { const p = P.get(b.key); minX = Math.min(minX, p.cx - p.w / 2); minY = Math.min(minY, p.cy - p.h / 2); maxX = Math.max(maxX, p.cx + p.w / 2); maxY = Math.max(maxY, p.cy + p.h / 2); }
    const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
    const pos = new Map();
    for (const b of blocks) {
      const p = P.get(b.key), x = p.cx - p.w / 2 - mx, y = p.cy - p.h / 2 - my;
      pos.set(b.key, { x, y, w: p.w, h: p.h, cx: x + p.w / 2, cy: y + p.h / 2 });
    }
    return { pos, width: maxX - minX, height: maxY - minY };
  }

  // B 档聚焦展开：焦点块的 BOM 层子块以锚点为中心纵向展开为列（列顶留标题行）。
  // 其他块仍钉在自己锚点上（折叠色块），因此整个世界坐标系不动 = 空间记忆连续。
  // units: 该块的 [{key, count, ...}]（key = block\0level）。返回子块 rect 表 + 标题 rect。
  function placeSubColumn(anchor, units, opts) {
    const o = Object.assign({ gap: 18, minW: 180, minH: 40, titleH: 32, topPad: 8 }, opts || {});
    const sorted = units.slice().sort((a, b) => Number(a.key.split('\u0000')[1]) - Number(b.key.split('\u0000')[1]));
    const sizes = blockSizes(sorted.length ? sorted : [{ key: '_', count: 1 }], { minSize: Math.min(o.minW, 120), maxSize: o.minW + 60, ratio: 0.34, minH: o.minH });
    const w = Math.max(o.minW, anchor.w * 1.25, ...sorted.map(u => sizes.get(u.key).w));
    const bodyH = sorted.reduce((h, u) => h + sizes.get(u.key).h, 0) + Math.max(0, sorted.length - 1) * o.gap;
    const totalH = o.titleH + o.topPad + bodyH;
    const y0 = anchor.cy - totalH / 2;
    const pos = new Map();
    let y = y0 + o.titleH + o.topPad;
    for (const u of sorted) {
      const s = sizes.get(u.key);
      pos.set(u.key, { x: anchor.cx - s.w / 2, y, w: s.w, h: s.h, cx: anchor.cx, cy: y + s.h / 2 });
      y += s.h + o.gap;
    }
    return { pos, title: { x: anchor.cx - w / 2, y: y0, w, h: o.titleH, cx: anchor.cx, cy: y0 + o.titleH / 2 }, width: w, height: totalH };
  }

  // C 档：编码按 BOM 层分行，行块整体居中于锚点（rows: [{level, codes}] 已排序）。
  function placeCodeRows(anchor, rows, opts) {
    const o = Object.assign({ rowGap: 84, colW: 60, labelW: 96, rowW: 78, rowH: 28 }, opts || {});
    const totalH = Math.max(0, (rows.length - 1) * o.rowGap);
    const maxCols = Math.max(1, ...rows.map(r => r.codes.length));
    const pos = new Map(), rowRects = new Map();
    rows.forEach((r, i) => {
      const y = anchor.cy - totalH / 2 + i * o.rowGap;
      const startX = anchor.cx - ((r.codes.length - 1) * o.colW) / 2;
      r.codes.forEach((code, k) => pos.set(code, { x: startX + k * o.colW, y }));
      const lx = anchor.cx - ((maxCols - 1) * o.colW) / 2 - o.labelW;
      rowRects.set(r.level, { x: lx - o.rowW / 2, y: y - o.rowH / 2, w: o.rowW, h: o.rowH, cx: lx, cy: y });
    });
    return { pos, rowRects };
  }

  // 标签按屏幕宽度省略：screenW 像素内能放多少字符（中文按 1、其余按 0.56 字宽）
  function fitLabel(text, screenW, fontPx) {
    const t = String(text == null ? '' : text);
    const px = Math.max(0, screenW) / Math.max(1, fontPx || 12);
    let used = 0, i = 0;
    for (; i < t.length; i++) { const w = t.charCodeAt(i) > 0xff ? 1 : 0.56; if (used + w > px) break; used += w; }
    return i >= t.length ? t : t.slice(0, Math.max(1, i - 1)) + '…';
  }

  // 风险优先聚焦：自动下钻时选风险最多的块（平手取编码数多、键名字典序，保证确定性）
  function pickFocusBlock(blocks) {
    const b = blocks.slice().sort((a, c) => c.riskCount - a.riskCount || c.count - a.count || String(a.key).localeCompare(String(c.key)))[0];
    return b ? b.key : null;
  }

  // 块间流聚合 + Top-N 裁剪：每个源块保留 strongest perSource 条，总量不超过 max。
  // 风险加权：排序与画宽按 max(边条数, 风险边数×2)，让风险传导路径在总览即凸显。
  function aggregateFlows(edges, keyOf, opts) {
    const o = Object.assign({ perSource: 2, max: 26 }, opts || {});
    const pairs = new Map();
    for (const e of edges) {
      const s = keyOf(e.source), t = keyOf(e.target);
      if (s == null || t == null || s === t) continue;
      const k = s + '\u0000' + t;
      let f = pairs.get(k);
      if (!f) { f = { s, t, count: 0, riskCount: 0, criticalCount: 0, critical: false, risk: false }; pairs.set(k, f); }
      f.count++;
      if (e.critical) { f.critical = true; f.criticalCount++; }
      if (e.risk) { f.risk = true; f.riskCount++; }
    }
    const wt = f => Math.max(f.count, f.riskCount * 2);
    const rank = (a, b) => wt(b) - wt(a) || b.count - a.count || (b.critical ? 1 : 0) - (a.critical ? 1 : 0);
    const bySource = new Map();
    for (const f of pairs.values()) { if (!bySource.has(f.s)) bySource.set(f.s, []); bySource.get(f.s).push(f); }
    let kept = [];
    for (const arr of bySource.values()) { arr.sort(rank); kept = kept.concat(arr.slice(0, o.perSource)); }
    kept.sort(rank);
    return kept.slice(0, o.max);
  }

  // 流宽：对数压缩 + 上限，避免少数超大流吞掉全部视觉带宽（块永远主导画面）
  function flowWidth(count) { return Math.min(4.6, 1.0 + Math.log2(1 + Math.max(0, count)) * 0.7); }

  // 数据量自适应初始档：有聚焦（如选中了编码）直达编码视图；
  // 小数据集直接全量明细，中等给层内结构，大规模才从聚类总览开始。
  const LOD_SMALL_MAX = 120, LOD_MEDIUM_MAX = 600;
  function pickInitialLevel(totalCodes, hasFocus) {
    if (hasFocus || totalCodes <= LOD_SMALL_MAX) return 'C';
    return totalCodes <= LOD_MEDIUM_MAX ? 'B' : 'A';
  }

  const api = { layered, aggregateBlocks, blockSizes, placeBlocks, placeSubColumn, placeCodeRows, fitLabel, pickFocusBlock, aggregateFlows, flowWidth, pickInitialLevel, LOD_SMALL_MAX, LOD_MEDIUM_MAX };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  root.ForecastLayout = api;
  const G6 = root.G6;
  if (!G6) { console.error('G6 未加载'); return; }

  // ============================================================
  // 视觉常量
  // ============================================================
  // 莫兰迪低饱和：聚类块分区色（哈希取用）
  const MORANDI = ['#8fa8c4', '#9dbcaa', '#c9bda1', '#b5a4c2', '#9fbab6', '#cbbfa4', '#b0a4a8', '#a7b6ca', '#b9c2a8', '#c4ada4', '#a3b0bd', '#b8c4cc'];
  // 7 级 BOM 层级色（成品→材料），补足旧版「只有 4 色、后 4 层全灰」的缺陷
  const LEVEL_COLORS = ['#8fb0d9', '#8ec0c0', '#a8c894', '#cfc98a', '#d8b183', '#cf9a90', '#a89ac9'];
  const FLOW = { normal: '#5f7d9e', critical: '#6fb3a8', risk: '#c9906f' };
  const RISK_FILL = { low: '#8fb0a8', mid: '#cfc08a', high: '#cf9a90' };
  const MAX_CODES = LOD_SMALL_MAX;  // C 档画布编码数硬上限（与智能初始档小数据集阈值同源）
  const MAX_FLOWS = 26;           // 单档汇总流总上限
  const FLOWS_PER_SOURCE = 2;     // 每个块的出向流保留条数
  const MAX_CODE_EDGES = 260;     // C 档边上限
  // 交互模型：滚轮只缩放视野，档位只随点击下钻/面包屑返回切换（滚轮不再换档，不会"字没看清就跳走"）
  const BADGE_FILL = '#c0503f';     // 风险徽标红
  const BAR_TRACK = 'rgba(16,26,43,.16)', BAR_FILL = '#c0503f';

  // 亮色/暗色主题：编码标签色随 <html data-theme> 切换（主题切换时 app 销毁重建图，无需监听）
  const isLight = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light';
  const labelInk = () => isLight() ? '#33415c' : '#e6eefc';

  function hexToRgb(hex) { const v = parseInt(hex.slice(1), 16); return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 }; }
  function rgba(hex, a) { const { r, g, b } = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }
  function hashColor(s) { let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) >>> 0; return MORANDI[h % MORANDI.length]; }
  function levelColor(level) { return LEVEL_COLORS[Math.max(0, Math.min(LEVEL_COLORS.length - 1, Number(level) || 0))]; }

  class ForecastGraph {
    constructor(el, opts) {
      this.el = el;
      this.opts = opts || {};
      this.onNodeClick = this.opts.onNodeClick || function () {};
      this.onNodeDblClick = this.opts.onNodeDblClick || function () {};
      this.onCanvasClick = this.opts.onCanvasClick || function () {};
      this.onLodChange = this.opts.onLodChange || function () {};
      this.nodes = [];
      this.edges = [];
      this.layoutMode = 'layered';   // force | layered（layered = 地图模式）
      this.cluster = 'none';         // none | industry | category | site
      this.colorBy = 'level';        // level | risk | site | none
      this.highlight = '';           // '' | critical | risk
      this.selected = '';
      this.edgeOpacity = 0.8;
      this.showRatio = false;
      this.edgeDirection = 'top-down';   // top-down 顶层→底层 | bottom-up 底层→顶层（仅视觉方向）
      this.ratioStyle = 'times';         // times ×N | ratio 1:N
      this.chainCode = '';
      this.ready = false;
      this.graph = null;
      this._renderQueue = Promise.resolve();
      this._renderRevision = 0;
      this._worldFit = 1;                            // 世界 fit 缩放（三档唯一倍率基准，随数据/聚类/尺寸重算）
      this._fittedRev = -1;                          // 已取景的数据版本（样式级 render 不再动视口）
      this._pad = [40, 40, 40, 40];                  // 与 Graph options.padding 一致（解析式 fit 用）
      this._transitioning = false;                   // 换档进行中：忽略 transform 事件
      this._lastData = null;                        // 最近一次 build 的图数据（标签补偿用）
      this._progDepth = 0;           // >0 表示正在执行程序化视口操作（期间忽略换档事件）
      this._level = 'A';             // A 集群 | B 分组 | C 编码
      this._focus = null;            // null | { block, level? }
      this._labelAt = 0;             // 标签补偿节流时间戳
      this._dataRev = 0;
      this._worldCache = null;
      this._renderedCodes = [];
      this._renderedEdgeIdx = [];
      this._blkIds = new Map(); this._blkRev = new Map();
      this._subIds = new Map(); this._subRev = new Map();
      this._headRev = new Map(); this._rowRev = new Map();
      this._init();
    }

    _init() {
      this.graph = new G6.Graph({
        container: this.el,
        autoFit: false,       // 换档需保留缩放/平移；fitView 由 render() 手动控制一次
        autoResize: true,
        // 元素数被 LOD 硬上限约束（≤~300），换档淡入/位移动画代价可忽略，消除硬切感
        animation: { duration: 250, easing: 'ease-in-out' },
        padding: [40, 40, 40, 40],
        data: { nodes: [], edges: [] },
        layout: { type: 'preset' },
        // 注意：不设 node.type / edge.type —— 交由每个元素自带 type 决定
        //（G6 优先取 options.type，缺省才用 e.type；故此处留空才能逐元素生效）
        node: {
          style: {
            size: d => d.style?.size || 24,
            fill: d => d.style?.fill || '#8fa8c4',
            stroke: d => d.style?.stroke || '#0b1222',
            lineWidth: d => d.style?.lineWidth || 1.5,
            radius: d => d.style?.radius || 0,
            opacity: 1,
            labelText: d => d.style?.labelText ?? '',
            labelFill: d => d.style?.labelFill || labelInk(),
            labelFontSize: d => d.style?.labelFontSize || 11,
            labelPlacement: d => d.style?.labelPlacement || 'bottom',
            labelOffsetY: 4
          },
          state: {
            selected: { stroke: '#ffffff', lineWidth: 3, halo: true, haloLineWidth: 8, haloStroke: '#6f9fd8', haloStrokeOpacity: 0.35 },
            active: { stroke: '#9dc0ea', lineWidth: 3 },
            dim: { opacity: 0.12 }
          }
        },
        edge: {
          style: {
            stroke: d => d.style?.stroke || '#5f7d9e',
            lineWidth: d => d.style?.lineWidth || 1.2,
            endArrow: d => d.style?.endArrow ?? false,
            opacity: d => d.style?.opacity ?? 0.5,
            lineDash: d => d.style?.lineDash || undefined,
            curveOffset: d => d.style?.curveOffset ?? 0,
            labelText: d => d.style?.labelText || '',
            labelFill: '#b7c6dd', labelFontSize: 10, labelBackground: true,
            labelBackgroundFill: 'rgba(10,17,31,.86)', labelBackgroundRadius: 3, labelPadding: [1, 4, 1, 4]
          },
          state: { active: { stroke: '#9dc0ea', lineWidth: 2.5, opacity: 1 }, dim: { opacity: 0.06 } }
        },
        // 地图交互：滚轮/按钮只缩放，拖拽只平移画布（块是锚点、不可拖动，信息卡永远是一个整体）
        behaviors: ['drag-canvas', 'zoom-canvas']
      });
      this._injectStyle();
      this._buildChrome();
      this.graph.on('aftertransform', () => this._onTransform());
      this.graph.on('afterrender', () => this._afterRender());
      this.graph.on('node:click', (evt) => this._onNodeClick(evt));
      this.graph.on('node:dblclick', (evt) => this._onNodeDblClick(evt));
      this.graph.on('canvas:click', () => { this.chainCode = ''; this._applyStates(); this.onCanvasClick(); });
      if (typeof ResizeObserver !== 'undefined') {
        // 地图化：坐标系与视口解耦，resize 只同步画布并重新居中（G6 resize() 不重新适配，
        // 否则容器缩放后内容会被右下裁切）
        this._resizeObserver = new ResizeObserver(() => { if (this.graph) { this.graph.resize(); this._recenter(); } });
        this._resizeObserver.observe(this.el);
      }
      this.ready = true;
    }

    // ---- 自有样式（不动共享 base.css / forecast.css，保护原版）----
    _injectStyle() {
      if (document.getElementById('map-graph-style')) return;
      const st = document.createElement('style');
      st.id = 'map-graph-style';
      st.textContent = [
        '.map-crumb{position:absolute;left:12px;top:10px;z-index:6;display:flex;align-items:center;gap:4px;max-width:calc(100% - 24px);flex-wrap:wrap;pointer-events:none}',
        '.map-crumb .mch{pointer-events:auto;border:1px solid rgba(120,150,190,.34);background:rgba(12,20,36,.82);color:#dbe7f6;border-radius:999px;padding:3px 10px;font-size:12px;line-height:1.5;cursor:pointer;backdrop-filter:blur(3px)}',
        '.map-crumb .mch:hover{border-color:rgba(150,185,225,.7);color:#fff}',
        '.map-crumb .mch.cur{background:rgba(46,78,120,.82);border-color:rgba(150,185,225,.6);cursor:default}',
        '.map-crumb .msep{color:#6d86a8;font-size:12px}',
        '.map-crumb .mchint{pointer-events:none;margin-left:6px;color:#8ea6c4;font-size:12px}',
        '.map-crumb .mchint b{color:#cfe0f5;font-weight:500}'
      ].join('\n');
      document.head.appendChild(st);
    }

    _buildChrome() {
      this.crumb = document.createElement('div');
      this.crumb.className = 'map-crumb';
      this.el.appendChild(this.crumb);
      this.crumb.addEventListener('click', e => {
        const btn = e.target.closest('[data-crumb]'); if (!btn) return;
        this._crumbGo(btn.dataset.crumb, btn.dataset.key || '', btn.dataset.level);
      });
    }

    // ---- 分组键：地图必须有权划，cluster='none' 退化为制造部门 ----
    _blockKey(n) {
      if (this.cluster === 'site') { const s = n.sites && n.sites[0] && (n.sites[0].key || n.sites[0].name); return s || '未分配加工地'; }
      if (this.cluster === 'category') return n.category || '未分类';
      return n.make_dept || '未分配部门';
    }
    _blockKeyOf(code) { const n = this._nodeMap && this._nodeMap.get(code); return n ? this._blockKey(n) : null; }
    _levelOf(n) { return Math.max(0, Number(n.level) || 0); }

    // ---- 世界坐标系（三档共用）----
    _world() {
      if (this._worldCache && this._worldCache.rev === this._dataRev) return this._worldCache;
      const blocks = aggregateBlocks(this.nodes, n => this._blockKey(n));
      const plan = placeBlocks(blocks);
      const byKey = new Map(blocks.map(b => [b.key, b]));
      this._worldCache = { rev: this._dataRev, blocks, byKey, pos: plan.pos, width: plan.width, height: plan.height };
      return this._worldCache;
    }

    _blockFill(b) {
      if (this.colorBy === 'risk') {
        const r = b.count ? b.riskCount / b.count : 0;
        return r >= 0.5 ? RISK_FILL.high : r >= 0.2 ? RISK_FILL.mid : RISK_FILL.low;
      }
      return hashColor(b.key);
    }
    _blockStroke(b) {
      const focused = this._focus && this._focus.block === b.key;
      if (focused) return '#e8d9a8';
      if (b.riskCount) return '#d99a8c';
      return 'rgba(190,214,242,.30)';
    }
    // 块 = 业务仪表：标题行（块名·编码数）+ 风险徽标 + 占比条 + 风险结构行
    _blockLabel(b) { return b.key + ' · ' + b.count; }
    _blockStructure(b) {
      const parts = [];
      if (b.gapCount) parts.push('缺口' + b.gapCount);
      if (b.singleCount) parts.push('单一' + b.singleCount);
      if (b.incompleteCount) parts.push('不完整' + b.incompleteCount);
      return parts.join(' · ');
    }

    // ---- 档 A：集群视图（聚类块信息卡 + 风险加权汇总流，画布上没有编码点）----
    _buildLevelA() {
      const world = this._world();
      this._blkIds = new Map(); this._blkRev = new Map();
      const nodes = [];
      world.blocks.forEach((b, i) => {
        const p = world.pos.get(b.key); if (!p) return;
        const id = '__blk_' + i; this._blkIds.set(b.key, id); this._blkRev.set(id, { key: b.key });
        const structure = this._blockStructure(b);
        nodes.push({
          id, type: 'rect',
          data: { __block: true, key: b.key, count: b.count, riskCount: b.riskCount, codes: b.codes, __fullLabel: this._blockLabel(b), x: p.cx, y: p.cy, w: p.w, h: p.h },
          style: {
            size: [p.w, p.h], radius: 10, x: p.cx, y: p.cy,
            fill: this._blockFill(b), stroke: this._blockStroke(b),
            lineWidth: this._focus && this._focus.block === b.key ? 2.4 : (b.riskCount ? 1.6 : 1),
            labelText: this._blockLabel(b), labelPlacement: 'center', labelFontSize: 12, labelFill: '#101a2b',
            labelOffsetY: structure ? -8 : 0
          }
        });
        if (b.riskCount) {
          // 风险徽标：块右上角红底白字（点击视同点击块）
          const bid = '__bdg_' + i; this._blkRev.set(bid, { key: b.key });
          nodes.push({
            id: bid, type: 'circle',
            data: { __badge: true, key: b.key, __fullLabel: String(b.riskCount), __noTrim: true, __fontPx: 11, x: p.x + p.w - 10, y: p.y + 8 },
            style: { size: 20, x: p.x + p.w - 10, y: p.y + 8, fill: BADGE_FILL, stroke: 'rgba(255,255,255,.9)', lineWidth: 1.2, labelText: String(b.riskCount), labelPlacement: 'center', labelFontSize: 11, labelFill: '#ffffff' }
          });
          // 风险占比条：块内底部 底槽 + 填充
          const tw = p.w - 20, fw = Math.max(3, tw * b.riskCount / b.count);
          const tid = '__bart_' + i, fid = '__barf_' + i;
          this._blkRev.set(tid, { key: b.key }); this._blkRev.set(fid, { key: b.key });
          nodes.push({ id: tid, type: 'rect', data: { __bar: true, key: b.key, x: p.cx, y: p.y + p.h - 10 }, style: { size: [tw, 5], radius: 2.5, x: p.cx, y: p.y + p.h - 10, fill: BAR_TRACK, stroke: 'rgba(0,0,0,0)', lineWidth: 0, labelText: '' } });
          nodes.push({ id: fid, type: 'rect', data: { __bar: true, key: b.key, x: p.x + 10 + fw / 2, y: p.y + p.h - 10 }, style: { size: [fw, 5], radius: 2.5, x: p.x + 10 + fw / 2, y: p.y + p.h - 10, fill: BAR_FILL, stroke: 'rgba(0,0,0,0)', lineWidth: 0, labelText: '' } });
        }
        if (structure) {
          const sid = '__str_' + i; this._blkRev.set(sid, { key: b.key });
          nodes.push({
            id: sid, type: 'rect',
            data: { __str: true, key: b.key, __fullLabel: structure, __fontPx: 9.5, x: p.cx, y: p.cy + 13, w: p.w - 16 },
            style: { size: [p.w - 16, 12], x: p.cx, y: p.cy + 13, fill: 'rgba(0,0,0,0)', stroke: 'rgba(0,0,0,0)', lineWidth: 0, labelText: structure, labelPlacement: 'center', labelFontSize: 9.5, labelFill: 'rgba(16,26,43,.80)' }
          });
        }
      });
      const flows = aggregateFlows(this.edges, c => this._blockKeyOf(c), { perSource: FLOWS_PER_SOURCE, max: MAX_FLOWS });
      const rev = this.edgeDirection === 'bottom-up';
      const edges = flows.map((f, i) => ({
        id: '__f' + i, type: 'quadratic',
        source: rev ? this._blkIds.get(f.t) : this._blkIds.get(f.s),
        target: rev ? this._blkIds.get(f.s) : this._blkIds.get(f.t),
        data: { __flow: true, count: f.count, critical: f.critical, risk: f.risk, riskCount: f.riskCount },
        style: this._flowStyle(f, 18)
      })).filter(e => e.source && e.target);
      this._renderedCodes = [];
      this._renderedEdgeIdx = [];
      this._rendered = { level: 'A', units: world.blocks.length, flows: edges.length, totalCodes: this.nodes.length, totalEdges: this.edges.length };
      return { nodes, edges, combos: [] };
    }

    _flowStyle(f, curve) {
      // 风险加权：含风险边的流按 max(条数, 风险边数×2) 画宽，管理层顺红流看传导
      const st = { stroke: FLOW.normal, lineWidth: flowWidth(Math.max(f.count, (f.riskCount || 0) * 2)), opacity: 0.30, endArrow: false, curveOffset: curve };
      if (f.critical) { st.stroke = FLOW.critical; st.opacity = 0.55; }
      if (f.risk) { st.stroke = FLOW.risk; st.opacity = 0.62; }
      const hitCritical = this.highlight === 'critical' && f.critical;
      const hitRisk = this.highlight === 'risk' && f.risk;
      if (hitCritical || hitRisk) { st.lineWidth = Math.max(st.lineWidth, 3.2); st.opacity = 0.95; }
      else if (this.highlight) st.opacity = 0.08;
      return st;
    }

    // ---- 档 B：分组视图（焦点块在锚点原地展开为 BOM 层列，其余块折叠为锚点色块）----
    _buildLevelB() {
      const world = this._world();
      let focusKey = this._focus && this._focus.block;
      if (!focusKey || !world.byKey.has(focusKey)) {   // 滚轮/初始进入无焦点：风险优先自动聚焦
        focusKey = pickFocusBlock(world.blocks);
        this._focus = focusKey ? { block: focusKey } : null;
      }
      this._subIds = new Map(); this._subRev = new Map(); this._headRev = new Map();
      this._ctxIds = new Map(); this._ctxRev = new Map();
      const nodes = [];
      if (focusKey) {
        const anchor = world.pos.get(focusKey), b = world.byKey.get(focusKey);
        const units = aggregateBlocks(this.nodes.filter(n => this._blockKey(n) === focusKey), n => focusKey + '\u0000' + this._levelOf(n));
        const col = placeSubColumn(anchor, units);
        // 列标题：块名 + 总编码数（B2：点击直达该块 C 档）
        const hid = '__head_0'; this._headRev.set(hid, { key: focusKey });
        nodes.push({
          id: hid, type: 'rect',
          data: { __head: true, key: focusKey, __fullLabel: focusKey + ' · ' + b.count, x: col.title.cx, y: col.title.cy },
          style: {
            size: [col.title.w, col.title.h], radius: 6, x: col.title.cx, y: col.title.cy,
            fill: rgba(hashColor(focusKey), 0.94), stroke: 'rgba(230,240,255,.28)', lineWidth: 1,
            labelText: focusKey + ' · ' + b.count, labelPlacement: 'center', labelFontSize: 12, labelFill: '#0d1729'
          }
        });
        units.forEach((u, i) => {
          const p = col.pos.get(u.key); if (!p) return;
          const level = Number(u.key.split('\u0000')[1]);
          const id = '__sub_' + i; this._subIds.set(u.key, id); this._subRev.set(id, { block: focusKey, level });
          const ratio = u.riskCount / Math.max(1, u.count);
          const fill = this.colorBy === 'risk'
            ? (ratio >= 0.5 ? RISK_FILL.high : ratio >= 0.2 ? RISK_FILL.mid : RISK_FILL.low)
            : levelColor(level);
          const label = (level + 1) + '层 · ' + u.count + (u.riskCount ? ' · 险' + u.riskCount : '');
          nodes.push({
            id, type: 'rect',
            data: { __sub: true, key: u.key, block: focusKey, level, count: u.count, riskCount: u.riskCount, codes: u.codes, __fullLabel: label, x: p.cx, y: p.cy, w: p.w },
            style: {
              size: [p.w, p.h], radius: 8, x: p.cx, y: p.cy,
              fill, stroke: rgba(hashColor(focusKey), 0.9), lineWidth: 1.2,
              labelText: label, labelPlacement: 'center', labelFontSize: 12, labelFill: '#0d1729'
            }
          });
        });
        // 其他块折叠为锚点小色块：钉在原地提供空间参照，点击切换焦点
        world.blocks.forEach((bb, i) => {
          if (bb.key === focusKey) return;
          const p = world.pos.get(bb.key); if (!p) return;
          const cid = '__ctx_' + i; this._ctxIds.set(bb.key, cid); this._ctxRev.set(cid, { key: bb.key });
          const label = bb.key + ' · ' + bb.count;
          nodes.push({
            id: cid, type: 'rect',
            data: { __ctx: true, key: bb.key, count: bb.count, riskCount: bb.riskCount, __fullLabel: label, x: p.cx, y: p.cy },
            style: {
              size: [Math.min(p.w, 110), 26], radius: 7, x: p.cx, y: p.cy,
              fill: rgba(hashColor(bb.key), isLight() ? 0.72 : 0.5),
              stroke: bb.riskCount ? '#d99a8c' : 'rgba(190,214,242,.30)', lineWidth: 1,
              labelText: label, labelPlacement: 'center', labelFontSize: 11, labelFill: '#101a2b'
            }
          });
        });
        // 流：焦点块内按层聚合，焦点块与其他块之间按块聚合到色块
        const keyOf = code => { const n = this._nodeMap.get(code); if (!n) return null; const bk = this._blockKey(n); return bk === focusKey ? bk + '\u0000' + this._levelOf(n) : bk; };
        const flows = aggregateFlows(this.edges, keyOf, { perSource: 2, max: MAX_FLOWS });
        const rev = this.edgeDirection === 'bottom-up';
        const edges = flows.map((f, i) => ({
          id: '__f' + i, type: 'quadratic',
          source: rev ? (this._subIds.get(f.t) || this._ctxIds.get(f.t)) : (this._subIds.get(f.s) || this._ctxIds.get(f.s)),
          target: rev ? (this._subIds.get(f.s) || this._ctxIds.get(f.s)) : (this._subIds.get(f.t) || this._ctxIds.get(f.t)),
          data: { __flow: true, count: f.count, critical: f.critical, risk: f.risk, riskCount: f.riskCount },
          style: this._flowStyle(f, 16)
        })).filter(e => e.source && e.target);
        this._renderedCodes = [];
        this._renderedEdgeIdx = [];
        this._rendered = { level: 'B', units: units.length, flows: edges.length, focusKey, levels: units.length, totalCodes: this.nodes.length, totalEdges: this.edges.length };
        return { nodes, edges, combos: [] };
      }
      this._rendered = { level: 'B', units: 0, flows: 0, totalCodes: this.nodes.length, totalEdges: this.edges.length };
      return { nodes, edges: [], combos: [] };
    }

    _degree(code) { return (this._outEdges?.get(code)?.length || 0) + (this._inEdges?.get(code)?.length || 0); }
    _codeScore(n) {
      let s = this._degree(n.code);
      if (n.code === this.selected) s += 100000;   // 选中编码必入 C 档裁剪集
      if ((n.gap || 0) > 1e-8) s += 1000;
      if (n.single) s += 200;
      if (n.multiLevel) s += 80;
      if (n.complete === false) s += 40;
      return s;
    }

    // ---- 档 C：编码视图（焦点块编码在锚点处按 BOM 层分行；无焦点且总量不超上限时全量；其余块留暗淡锚点参照）----
    _buildLevelC() {
      const world = this._world();
      let focusKey = this._focus && this._focus.block;
      const showAll = !focusKey && this.nodes.length <= MAX_CODES;
      if (!showAll && (!focusKey || !world.byKey.has(focusKey))) {   // 风险优先自动聚焦（面包屑可见、可返回）
        focusKey = pickFocusBlock(world.blocks);
        this._focus = focusKey ? { block: focusKey } : null;
      }
      const focusLevel = this._focus && this._focus.level;
      let members = showAll ? this.nodes.slice() : this.nodes.filter(n => this._blockKey(n) === focusKey);
      if (focusLevel != null) members = members.filter(n => this._levelOf(n) === Number(focusLevel));
      const ranked = members.map(n => ({ n, s: this._codeScore(n) })).sort((a, b) => b.s - a.s || String(a.n.code).localeCompare(String(b.n.code)));
      const picked = ranked.slice(0, MAX_CODES).map(x => x.n);
      const pickedIds = new Set(picked.map(n => n.code));
      const byLevel = new Map();
      for (const n of picked) { const lv = this._levelOf(n); if (!byLevel.has(lv)) byLevel.set(lv, []); byLevel.get(lv).push(n); }
      const levels = [...byLevel.keys()].sort((a, b) => a - b);
      for (const lv of levels) byLevel.get(lv).sort((a, b) => (b.multiLevel ? 1 : 0) - (a.multiLevel ? 1 : 0) || String(a.code).localeCompare(String(b.code)));
      // 锚点：焦点块原位（全量模式则居中于原点），行块整体居中于锚点
      const anchor = showAll || !focusKey ? { cx: 0, cy: 0 } : world.pos.get(focusKey);
      const plan = placeCodeRows(anchor, levels.map(lv => ({ level: lv, codes: byLevel.get(lv).map(n => n.code) })));
      const nodes = [];
      this._rowRev = new Map();
      this._ctxIds = new Map(); this._ctxRev = new Map();
      levels.forEach((lv) => {
        const arr = byLevel.get(lv);
        arr.forEach((n) => {
          const p = plan.pos.get(n.code); if (!p) return;
          const st = this._nodeStyle(n, 'C');
          // 编码标签在节点下方，不按节点直径截断（列距 60 世界单位足够容纳完整编码）
          nodes.push({ id: n.code, type: 'circle', data: { ...n, x: p.x, y: p.y, __fullLabel: st.labelText || '', __noTrim: true }, style: { ...st, x: p.x, y: p.y, labelPlacement: 'bottom' } });
          pickedIds.add(n.code);
        });
        // 行标签：第 N 层 + 本视图编码数
        const rr = plan.rowRects.get(lv);
        const rid = '__row_' + lv; this._rowRev.set(rid, { level: lv });
        nodes.push({
          id: rid, type: 'rect',
          data: { __row: true, level: lv, __fullLabel: (lv + 1) + '层 · ' + arr.length, x: rr.cx, y: rr.cy },
          style: { size: [rr.w, rr.h], radius: 6, x: rr.cx, y: rr.cy, fill: 'rgba(120,146,180,.10)', stroke: 'rgba(120,146,180,.30)', lineWidth: 1, labelText: (lv + 1) + '层 · ' + arr.length, labelPlacement: 'center', labelFontSize: 12, labelFill: isLight() ? '#33415c' : '#c6d6ea' }
        });
      });
      // 其他块的锚点参照（暗淡小色块，点击切换 C 档焦点）
      if (!showAll) world.blocks.forEach((bb, i) => {
        if (bb.key === focusKey) return;
        const p = world.pos.get(bb.key); if (!p) return;
        const cid = '__ctx_' + i; this._ctxIds.set(bb.key, cid); this._ctxRev.set(cid, { key: bb.key });
        nodes.push({
          id: cid, type: 'rect',
          data: { __ctx: true, key: bb.key, count: bb.count, __fullLabel: bb.key, __fontPx: 10, x: p.cx, y: p.cy },
          style: { size: [Math.min(p.w * 0.6, 84), 20], radius: 6, x: p.cx, y: p.cy, fill: rgba(hashColor(bb.key), 0.28), stroke: 'rgba(190,214,242,.18)', lineWidth: 1, labelText: bb.key, labelPlacement: 'center', labelFontSize: 10, labelFill: isLight() ? '#5b6d8c' : '#8ea6c4' }
        });
      });
      // 边：仅聚焦块内部；超限只留关键/风险 + 高度数
      let edgeIdx = [];
      this.edges.forEach((e, i) => { if (pickedIds.has(e.source) && pickedIds.has(e.target)) edgeIdx.push(i); });
      if (edgeIdx.length > MAX_CODE_EDGES) {
        const byScore = edgeIdx.slice().sort((a, b) => {
          const ea = this.edges[a], eb = this.edges[b];
          const sa = (ea.critical ? 2 : 0) + (ea.risk ? 1 : 0), sb = (eb.critical ? 2 : 0) + (eb.risk ? 1 : 0);
          return sb - sa || (this._degree(eb.source) + this._degree(eb.target)) - (this._degree(ea.source) + this._degree(ea.target));
        });
        edgeIdx = byScore.slice(0, MAX_CODE_EDGES);
      }
      this._renderedEdgeIdx = edgeIdx;
      this._renderedCodes = picked.map(n => n.code);
      const edges = edgeIdx.map(i => {
        const e = this.edges[i], rev = this.edgeDirection === 'bottom-up';
        return { id: '__e' + i, source: rev ? e.target : e.source, target: rev ? e.source : e.target, data: { ...e }, style: this._edgeStyle(e, 'C') };
      });
      this._rendered = { level: 'C', units: picked.length, flows: edges.length, focusKey: showAll ? null : focusKey, focusLevel: focusLevel != null ? Number(focusLevel) : null, members: members.length, dropped: members.length - picked.length, levels: levels.length, totalCodes: this.nodes.length, totalEdges: this.edges.length };
      return { nodes, edges, combos: [] };
    }

    _nodeStyle(n, level) {
      let fill;
      if (this.colorBy === 'risk') fill = this._riskColor(n);
      else if (this.colorBy === 'site') fill = this._siteColor(n);
      else if (this.colorBy === 'none') fill = '#9aa7b6';
      // 类型染色与经典版/图例同口径：模板优先；有模板数据时未维护节点灰色，完全无模板按层级兜底
      else fill = n.template ? hashColor(String(n.template)) : this._hasTemplates ? '#9aa7b6' : levelColor(n.level);
      let stroke = 'rgba(11,18,34,.9)', lineWidth = 1.6;
      if ((n.gap || 0) > 1e-8) { stroke = '#e0899a'; lineWidth = 2.4; }
      else if (n.single) { stroke = '#d8b06a'; lineWidth = 2.4; }
      const size = n.code === this.selected ? 22 : 17;
      const style = { size, fill, stroke, lineWidth };
      if (n.multiLevel) { style.lineDash = [3, 2]; if (stroke === 'rgba(11,18,34,.9)') stroke = '#c9a25e'; style.stroke = stroke; }
      if (n.passThrough) { style.lineDash = [3, 2]; if (stroke === 'rgba(11,18,34,.9)') stroke = '#8c99a8'; style.stroke = stroke; }   // 透传节点：无预测记录，虚线灰边
      // 标签分级：只有关键编码才带标签
      style.labelText = this._isKeyNode(n) ? String(n.code) : '';
      return style;
    }

    _riskColor(n) {
      if ((n.gap || 0) > 1e-8) return '#cf7f7f';
      if (n.single) return '#d8b06a';
      if (n.complete === false) return '#8c99a8';
      return '#8fb0a8';
    }
    _siteColor(n) {
      const s = n.sites && n.sites[0] && (n.sites[0].key || n.sites[0].name);
      return s ? hashColor(String(s)) : '#9aa7b6';
    }
    _isKeyNode(n) { return n.code === this.selected || n.code === this.chainCode || !!n.multiLevel || !!n.passThrough || (n.gap || 0) > 1e-8 || !!n.single; }

    _edgeStyle(e, level) {
      let stroke = '#4d6c8c', width = 1.1;
      if (e.critical) { stroke = FLOW.critical; width = 2.2; }
      else if (e.risk) { stroke = FLOW.risk; width = 2; }
      const dashed = e.kind && (e.kind.includes('跨产业') || e.kind === 'BOM');
      const style = { stroke, lineWidth: width, opacity: Math.min(0.75, this.edgeOpacity * 0.7), lineDash: dashed ? [4, 3] : undefined, endArrow: true };
      if (this.showRatio && e.qty != null) style.labelText = this.ratioStyle === 'ratio' ? '1:' + (Math.round(e.qty * 100) / 100) : '×' + (Math.round(e.qty * 100) / 100);
      return style;
    }

    // 力导向模式：保持原有全量渲染语义（地图档位只在分层模式生效）
    _buildForce() {
      const ids = new Set(this.nodes.map(n => n.code));
      const groups = new Map();
      const nodes = this.nodes.map(n => {
        const key = this.cluster === 'none' ? null : (this.cluster === 'site' ? ((n.sites && n.sites[0] && (n.sites[0].key || n.sites[0].name)) || '未分配加工地') : this.cluster === 'category' ? (n.category || '未分类') : (n.make_dept || '未分配部门'));
        let combo;
        if (key != null) {
          if (!groups.has(key)) { let id = '__cluster_' + groups.size; while (ids.has(id)) id += '_'; ids.add(id); groups.set(key, { id, count: 0 }); }
          const g = groups.get(key); g.count++; combo = g.id;
        }
        return { id: n.code, data: { ...n }, style: this._nodeStyle(n, 'C'), ...(combo ? { combo } : {}) };
      });
      this._renderedCodes = nodes.map(n => n.id);
      this._renderedEdgeIdx = this.edges.map((e, i) => i);
      const edges = this.edges.map((e, i) => {
        const rev = this.edgeDirection === 'bottom-up';
        return { id: '__e' + i, source: rev ? e.target : e.source, target: rev ? e.source : e.target, data: { ...e }, style: this._edgeStyle(e, 'C') };
      });
      this._rendered = { level: 'force', units: nodes.length, flows: edges.length, totalCodes: this.nodes.length, totalEdges: this.edges.length };
      return { nodes, edges, combos: [...groups.entries()].map(([key, g]) => ({ id: g.id, data: { key, count: g.count }, style: { labelText: key + ' · ' + g.count, fill: hashColor(key), stroke: hashColor(key) } })) };
    }

    _buildData() {
      if (!this._usePreset()) return this._buildForce();
      if (this._level === 'A') return this._buildLevelA();
      if (this._level === 'B') return this._buildLevelB();
      return this._buildLevelC();
    }

    _usePreset() { return this.layoutMode === 'layered'; }

    // ---- 视口：唯一来源是 G6 官方 fitView，语义全部由「像素真值」实测确认 ----
    //
    // 用 canvas getImageData 的像素包围盒作为真值（不用任何数学读数），实测结论：
    //   1) 光栅化尺度：画布像素 = 世界单位 × getZoom()。zoom 越大画面越大。
    //      三点验证：世界 760×488 → @0.80815 实测 615px（=760×0.80815）；
    //                @1.32164 → 1007px；@0.64652 → 492px。全部吻合。
    //   2) translateBy(arg) 使画面位移【恰好 = arg 像素，方向相同】。
    //      验证：translateBy([120,0]) → 像素包围盒整体 +120px。
    //   3) 官方 fitView({when:'always',direction:'both'}) 完全正确：按 Graph options
    //      的 padding 取 min(可用宽/内容宽, 可用高/内容高) 作相对倍率，并把内容居中。
    //      三档实测：内容尺寸 = 世界×zoom，中心 = 画布中心（误差 <1px）。
    //   4) 本 bundle 的 getCanvasByViewport / getViewportCenter 是坏的：
    //      读数尺度为 1/zoom（与真实渲染差 zoom² 因子）且以画布中心为零点，
    //      不能用于任何适配/居中计算。历史上「fitView 不可用、内容被推出画布」
    //      的结论就是在读数空间量出来的假象（推理正确、量错了对象）。
    //
    // 因此取景只用 fitView、倍率只用 getZoom()，读数接口一律不参与像素决策。

    _size() {
      return { cw: this.el.clientWidth || 960, ch: this.el.clientHeight || 640 };
    }

    // 解析式适配缩放 = min(可用宽/世界宽, 可用高/世界高)。
    // 与官方 fitView 完全等价（此前已实测吻合到 5 位小数），在 setData 前即可算出。
    _fitOf(world) {
      const { cw, ch } = this._size();
      const p = this._pad || [40, 40, 40, 40];       // Graph options.padding: [top,right,bottom,left]
      const availW = Math.max(1, cw - (p[1] || 0) - (p[3] || 0));
      const availH = Math.max(1, ch - (p[0] || 0) - (p[2] || 0));
      const z = Math.min(availW / Math.max(1, world.width), availH / Math.max(1, world.height));
      return Math.min(32, Math.max(0.005, z));
    }

    // 三档共用同一世界坐标系：倍率基准是「全部锚点」的 fit，每数据版本/聚类维度只算一次
    _computeWorldFit() {
      const w = this._world();
      return this._fitOf({ width: w.width, height: w.height });
    }

    // 取景 = fitView（官方实现，按 padding 缩放并居中）——仅用于：首次渲染 / fit 按钮 / 面包屑「全部」
    async _applyViewport() {
      if (!this.graph) return;
      this._progDepth++;
      try {
        try { await this.graph.fitView({ when: 'always', direction: 'both' }, { duration: 0 }); } catch { /* 忽略 */ }
      } finally { this._progDepth--; }
    }

    // 视觉放大倍率：r > 1 = 比「世界适配」更放大（因为 像素 = 世界 × zoom）。
    _ratioOf(zoom) {
      const z = zoom != null ? zoom : (this.graph ? this.graph.getZoom() : this._worldFit);
      return this._worldFit > 0 ? z / this._worldFit : 1;
    }

    // 下钻取景：把焦点块居中并推到目标倍率（倍率落在目标档稳定区间内，不会触发回弹）。
    // zoomTo 的 center 参数语义在本 bundle 未实测，改为「先缩放到视口中心，再按像素平移」：
    // getClientByCanvas（经典版凸包在用）与 translateBy（位移=像素，方向相同）均已实测可靠。
    async _drillView(center, r) {
      if (!this.graph || !center) return;
      this._progDepth++;
      try {
        const z = Math.min(32, Math.max(0.005, this._worldFit * r));
        try { await this.graph.zoomTo(z); } catch { /* 忽略 */ }
        try {
          const c = this.graph.getClientByCanvas(center);
          const rect = this.el.getBoundingClientRect();
          const dx = rect.left + rect.width / 2 - c[0], dy = rect.top + rect.height / 2 - c[1];
          if (Math.abs(dx) > 1 || Math.abs(dy) > 1) await this.graph.translateBy([dx, dy]);
        } catch { /* 忽略 */ }
      } finally { this._progDepth--; }
    }
    // 下钻取景目标：尽量让焦点列/行块整体可见（zoom 直接由内容尺寸与视口算出，无档位回弹问题——
    // 滚轮已不换档，zoom 只影响视野大小）
    _drillTo(level, blockKey) {
      const world = this._world();
      const p = world.pos.get(blockKey);
      if (!p) return null;
      const { cw, ch } = this._size();
      const availW = Math.max(1, cw - (this._pad[1] || 0) - (this._pad[3] || 0));
      const availH = Math.max(1, ch - (this._pad[0] || 0) - (this._pad[2] || 0));
      if (level === 'C') {
        const focusLevel = this._focus && this._focus.block === blockKey ? this._focus.level : null;
        let members = this.nodes.filter(n => this._blockKey(n) === blockKey);
        if (focusLevel != null) members = members.filter(n => this._levelOf(n) === Number(focusLevel));
        const byLv = new Map();
        for (const n of members) { const lv = this._levelOf(n); byLv.set(lv, (byLv.get(lv) || 0) + 1); }
        const nRows = Math.max(1, byLv.size), maxCols = Math.max(1, ...byLv.values());
        const zFit = Math.min(availW * 0.8 / (maxCols * 60 + 200), availH * 0.8 / (nRows * 84 + 80));
        const r = Math.min(Math.max(zFit / this._worldFit, 2.2), 24);   // 下限保证编码点足够大
        return { center: [p.cx, p.cy], r };
      }
      const units = aggregateBlocks(this.nodes.filter(n => this._blockKey(n) === blockKey), n => blockKey + '\u0000' + this._levelOf(n));
      const col = placeSubColumn(p, units);
      const zFit = Math.min(availW * 0.62 / col.width, availH * 0.82 / col.height);
      const r = Math.min(Math.max(zFit / this._worldFit, 1.3), 12);
      return { center: [p.cx, p.cy], r };
    }

    // resize 后重新取景：基准随画布尺寸重算；仅在「当前就处在适配倍率附近」时重取，
    // 避免打断用户已放大/平移的视图
    async _recenter() {
      if (!this.graph) return;
      this._worldFit = this._computeWorldFit();
      if (Math.abs(this._ratioOf() - 1) < 0.05) await this._applyViewport();
    }

    // ---- 屏幕尺寸标签（地图铁律：当前档该显示的名字在任何缩放下都 ≥11px）----
    // 世界字号 = 12 / zoom 反向补偿；名称按块宽×zoom 的屏幕像素省略。
    _syncLabels() {
      if (!this._usePreset() || !this.graph || !this._lastData) return;
      let z; try { z = this.graph.getZoom(); } catch { return; }
      if (!z) return;
      const updates = [];
      for (const n of this._lastData.nodes) {
        const d = n.data || {}, st = n.style || {};
        const full = d.__fullLabel;
        if (full == null) continue;
        const w = Array.isArray(st.size) ? st.size[0] : (typeof st.size === 'number' ? st.size : 40);
        const labelText = d.__noTrim ? full : fitLabel(full, w * z - 8, 12);
        updates.push({ id: n.id, style: { labelFontSize: Math.min(30, Math.max(3.5, (d.__fontPx || 12) / z)), labelText } });
      }
      if (!updates.length) return;
      this.graph.updateNodeData(updates);
      this.graph.draw();
    }
    _syncLabelsThrottled() {
      const now = Date.now();
      if (now - this._labelAt < 100) return;
      this._labelAt = now;
      this._syncLabels();
    }

    // 滚轮/平移只做两件事：标签按屏幕尺寸补偿 + 面包屑刷新。档位不随缩放变化——下钻只走点击。
    _onTransform() {
      if (!this._usePreset() || !this.graph) return;
      this._syncLabelsThrottled();
      if (this._transitioning || this._progDepth > 0) return;
      this._updateCrumb();
    }

    // 换档只切换可见元素集合；世界坐标不动、不 fitView = 空间记忆连续、无闪烁。
    // viewport：{fit:true} 回世界全览（面包屑「全部」/fit 按钮）；{center, r} 下钻居中（点击块）。
    _setLevel(level, viewport) {
      if (!this.graph) return;
      const prev = this._level; this._level = level;
      const revision = ++this._renderRevision;
      this._transitioning = true;
      this._renderQueue = this._renderQueue.catch(() => {}).then(async () => {
        if (!this.graph || revision !== this._renderRevision) { this._transitioning = false; return; }
        const data = this._buildData();
        this._lastData = data;
        this.graph.setData(data);
        await this.graph.render();
        if (this.graph && revision === this._renderRevision) {
          if (viewport && viewport.fit) await this._applyViewport();
          else if (viewport) await this._drillView(viewport.center, viewport.r);
          await this._applyStates();
          this._syncLabels();
          this._afterRender();
        }
        if (revision === this._renderRevision) this._transitioning = false;
      });
      if (prev !== level) this.onLodChange(this._lodCode(level), this._lodLabel(level));
      this._updateCrumb();
    }

    _lodCode(level) { return level === 'A' ? 'L0' : level === 'B' ? 'L1' : 'L2'; }
    _lodLabel(level) {
      return level === 'A' ? '集群视图 · 分区总览' : level === 'B' ? '分组视图 · 层内结构' : '编码视图 · 聚焦明细';
    }

    // ---- 面包屑 ----
    _updateCrumb() {
      if (!this.crumb) return;
      if (!this._usePreset()) { this.crumb.innerHTML = ''; return; }
      const world = this._world();
      const f = this._focus;
      const parts = ['<button class="mch' + (f ? '' : ' cur') + '" data-crumb="root">全部</button>'];
      if (f && f.block) {
        const b = world.byKey.get(f.block);
        parts.push('<span class="msep">›</span>');
        parts.push('<button class="mch' + (f.level == null ? ' cur' : '') + '" data-crumb="block" data-key="' + this._escA(f.block) + '">' + this._esc(f.block) + (b ? '（' + b.count + '）' : '') + '</button>');
        if (f.level != null) {
          const n = this._nodeMap.size ? this.nodes.filter(x => this._blockKey(x) === f.block && this._levelOf(x) === Number(f.level)).length : 0;
          parts.push('<span class="msep">›</span>');
          parts.push('<button class="mch cur" data-crumb="level" data-key="' + this._escA(f.block) + '" data-level="' + f.level + '">第' + (Number(f.level) + 1) + '层（' + n + '）</button>');
        }
      }
      parts.push('<span class="mchint">视图 <b>' + this._lodLabel(this._level) + '</b> · 滚轮只缩放 · 点击块下钻 · 双击直达编码 · 拖拽平移</span>');
      this.crumb.innerHTML = parts.join('');
    }
    _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    _escA(s) { return this._esc(s); }

    // 下钻 / 返回：世界坐标不动，只做元素切换；「全部」回世界全览，块/层带居中推近。
    _gotoLevel(level, viewport) {
      this._setLevel(level, viewport);
    }

    _crumbGo(kind, key, level) {
      if (kind === 'root') { this._focus = null; this._gotoLevel('A', { fit: true }); }
      else if (kind === 'block') { this._focus = { block: key }; this._gotoLevel('B', this._drillTo('B', key)); }
      else if (kind === 'level') { this._focus = { block: key, level: Number(level) }; this._gotoLevel('C', this._drillTo('C', key)); }
    }

    // ---- 点击：用自管 id 前缀识别块/子块/列标题/参照色块，避免依赖 G6 读数据 API ----
    _onNodeClick(evt) {
      const id = String(evt.target.id);
      const ctx = this._ctxRev && this._ctxRev.get(id);
      if (ctx) {   // 锚点参照色块：切换焦点（B 档重新展开该块，C 档切换明细范围）
        this._focus = { block: ctx.key };
        this._setLevel(this._level === 'B' ? 'B' : 'C', this._level === 'B' ? this._drillTo('B', ctx.key) : null);
        return;
      }
      const blk = this._blkRev.get(id);
      if (blk) {   // A 档点块：该块原地展开并居中推近（点国家→国家占满视野）
        this._focus = { block: blk.key };
        if (this._level === 'A') this._gotoLevel('B', this._drillTo('B', blk.key));
        else this._setLevel(this._level);
        return;
      }
      const head = this._headRev.get(id);
      if (head) { this._focus = { block: head.key }; this._gotoLevel('C', this._drillTo('C', head.key)); return; }   // B2：列标题直达编码档
      const sub = this._subRev.get(id);
      if (sub) { this._focus = { block: sub.block, level: sub.level }; this._gotoLevel('C', this._drillTo('C', sub.block)); return; }
      const n = this._node(id);
      if (!n) return;
      if (this.chainCode === id) { this.chainCode = ''; this.selected = ''; this._applyStates(); this.onCanvasClick(); return; }
      this.chainCode = id; this.selected = id;
      this._applyStates(); this.onNodeClick(id, n);
    }

    _onNodeDblClick(evt) {
      const id = String(evt.target.id);
      const blk = this._blkRev.get(id), head = this._headRev.get(id);
      if (blk || head) { this._focus = { block: (blk || head).key }; this._gotoLevel('C', this._drillTo('C', (blk || head).key)); return; }
      const sub = this._subRev.get(id);
      if (sub) { this._focus = { block: sub.block, level: sub.level }; this._gotoLevel('C', this._drillTo('C', sub.block)); return; }
      const n = this._node(id);
      if (n) this.onNodeDblClick(id, n);
    }

    _node(id) { return this._nodeMap?.get(id) || null; }

    // ---- 渲染后：计数 + 面包屑 ----
    _afterRender() {
      const r = this._rendered; if (!r) return;
      const el = document.getElementById('g-count');
      if (el) {
        if (r.level === 'A') el.textContent = '当前显示 ' + r.units + ' 个聚类块 · ' + r.flows + ' 条汇总流 ｜ 范围 ' + r.totalCodes + ' 编码 / ' + r.totalEdges + ' 边（编码点仅在放大后显示）';
        else if (r.level === 'B') el.textContent = '聚焦「' + (r.focusKey || '—') + '」：' + r.units + ' 个层块 · ' + r.flows + ' 条层间流 ｜ 范围 ' + r.totalCodes + ' 编码 / ' + r.totalEdges + ' 边（点击其他色块切换焦点）';
        else if (r.level === 'C') el.textContent = r.focusKey == null
          ? '当前显示全部 ' + r.units + ' 个编码 · ' + r.flows + ' 条边（范围较小，直接展示明细）'
          : '当前显示 ' + r.units + ' 个编码（上限 ' + MAX_CODES + '）· ' + r.flows + ' 条边 ｜ 本块共 ' + r.members + ' 编码' + (r.dropped > 0 ? '，已折叠 ' + r.dropped + ' 个次要编码' : '');
        else el.textContent = '当前显示 ' + r.units + ' 个编码 · ' + r.flows + ' 条边（范围 ' + r.totalCodes + ' / ' + r.totalEdges + '）';
      }
      this._updateCrumb();
    }

    // ---- 状态 ----
    _applyHighlight() {
      if (!this._usePreset() || this._level !== 'C') return Promise.resolve();
      const keep = new Set();
      if (this.highlight === 'critical') { for (const c of (this.criticalPath || [])) keep.add(c); }
      else { for (const e of this.edges) if (e.risk) { keep.add(e.source); keep.add(e.target); } }
      const states = {};
      for (const c of this._renderedCodes) states[c] = this.highlight && keep.size && !keep.has(c) ? ['dim'] : [];
      (this._renderedEdgeIdx || []).forEach(i => { states['__e' + i] = []; });
      return this.graph.setElementState(states);
    }

    _applyStates() {
      if (!this._usePreset()) {
        const states = {};
        for (const n of this.nodes) states[n.code] = [];
        this._renderedEdgeIdx.forEach(i => { states['__e' + i] = []; });
        return this.graph.setElementState(states);
      }
      if (this._level !== 'C') return Promise.resolve();   // A/B 为虚拟块，不参与真实编码状态
      if (this.highlight) return this._applyHighlight();
      let focus = null;
      if (this.chainCode) focus = this._chain(this.chainCode);
      const states = {};
      for (const c of this._renderedCodes) states[c] = focus && !focus.nodes.has(c) ? ['dim'] : [];
      (this._renderedEdgeIdx || []).forEach(i => { states['__e' + i] = focus ? (focus.edges.has('__e' + i) ? ['active'] : ['dim']) : []; });
      if (this.selected && states[this.selected] && !states[this.selected].includes('dim')) states[this.selected] = [...states[this.selected], 'selected'];
      return this.graph.setElementState(states);
    }

    _adjacency(id) {
      const nodes = new Set([id]), edges = new Set();
      this.edges.forEach((e, i) => { if (e.source === id || e.target === id) { edges.add('__e' + i); nodes.add(e.source); nodes.add(e.target); } });
      return { nodes, edges };
    }
    _chain(id) {
      const nodes = new Set([id]), edges = new Set();
      for (const adjacency of [this._outEdges, this._inEdges]) {
        const seen = new Set([id]), queue = [id];
        for (let j = 0; j < queue.length; j++) for (const item of adjacency.get(queue[j]) || []) {
          edges.add('__e' + item.i); nodes.add(item.next);
          if (!seen.has(item.next)) { seen.add(item.next); queue.push(item.next); }
        }
      }
      return { nodes, edges };
    }

    // ---- 公开 API ----
    setData(nodes, edges, opts) {
      opts = opts || {};
      if (opts.layoutMode) this.layoutMode = opts.layoutMode;
      if (opts.cluster !== undefined) this.cluster = opts.cluster;
      if (opts.colorBy) this.colorBy = opts.colorBy;
      if (opts.highlight !== undefined) this.highlight = opts.highlight;
      if (opts.selected !== undefined) this.selected = opts.selected;
      if (opts.criticalPath !== undefined) this.criticalPath = opts.criticalPath;
      this.nodes = nodes || [];
      this.edges = edges || [];
      this._nodeMap = new Map(this.nodes.map(n => [n.code, n]));
      this._outEdges = new Map(); this._inEdges = new Map();
      this.edges.forEach((e, i) => {
        for (const [map, key, next] of [[this._outEdges, e.source, e.target], [this._inEdges, e.target, e.source]]) {
          if (!map.has(key)) map.set(key, []); map.get(key).push({ i, next });
        }
      });
      this.chainCode = '';
      this._hasTemplates = this.nodes.some(n => n.template);
      // 选中编码自动聚焦所在块直达 C 档（小数据集则全量展示、选中高亮，与经典版等价）
      const selNode = this.selected && this._nodeMap.get(this.selected);
      this._focus = selNode && this.nodes.length > MAX_CODES ? { block: this._blockKey(selNode) } : null;
      this._level = pickInitialLevel(this.nodes.length, !!this._focus);
      if (this._level === 'B' && !this._focus) { const k = pickFocusBlock(aggregateBlocks(this.nodes, n => this._blockKey(n))); this._focus = k ? { block: k } : null; }
      this._worldCache = null;
      this._dataRev++;
      this._worldFit = this._computeWorldFit();      // 统一世界基准：随数据版本重算
      return this.render();
    }

    render() {
      const revision = ++this._renderRevision;
      this._renderQueue = this._renderQueue.catch(() => {}).then(async () => {
        if (!this.graph || revision !== this._renderRevision) return;
        const preset = this._usePreset();
        this.graph.setLayout(preset ? { type: 'preset' } : (this.cluster === 'none' ? { type: 'force' }
          : { type: 'combo-combined', comboPadding: 36, comboSpacing: 60, nodeSize: 50, nodeSpacing: 20,
              layout: comboId => comboId ? { type: 'concentric', preventOverlap: true } : { type: 'force', preventOverlap: true } }));
        const data = this._buildData();
        this._lastData = data;
        this.graph.setData(data);
        await this.graph.render();
        if (this.graph && revision === this._renderRevision) {
          // 世界坐标统一后：只有数据版本变化（换数据/换聚类/过滤）才重新取景；
          // 纯样式更新（高亮/配色/透明度/换档）不动视口，避免打断用户已放大/平移的视图。
          if (this._fittedRev !== this._dataRev) { await this._applyViewport(); this._fittedRev = this._dataRev; }
          await this._applyStates();
          this._syncLabels();
          this._afterRender();
          this.onLodChange(this._lodCode(this._level), this._lodLabel(this._level));
        }      });
      return this._renderQueue;
    }

    setLayout(mode) { if (mode === this.layoutMode) return Promise.resolve(); this.layoutMode = mode; this._worldCache = null; return this.render(); }
    setCluster(c) { if (c === this.cluster) return Promise.resolve(); this.cluster = c; this._focus = null; this._level = 'A'; this._worldCache = null; this._dataRev++; this._worldFit = this._computeWorldFit(); return this.render(); }
    // 公开：跳到指定档（画像/工具按钮用，带取景语义；A = 世界全览）
    showLevel(level) {
      if (!this._usePreset()) return Promise.resolve();
      if (level === 'A') { this._focus = null; this._setLevel('A', { fit: true }); }
      else {
        const world = this._world();
        if (!this._focus || !world.byKey.has(this._focus.block)) this._focus = { block: pickFocusBlock(world.blocks) };
        if (level === 'B') this._focus = { block: this._focus.block };
        this._setLevel(level, this._drillTo(level, this._focus.block));
      }
      return this._renderQueue;
    }
    // 布局切换联动：导出/恢复导航上下文（档位 + 焦点块），切走再切回时回到原处
    navState() { return { level: this._level, focus: this._focus ? { ...this._focus } : null }; }
    restoreNav(nav) {
      if (!this._usePreset() || !nav) return Promise.resolve();
      const world = this._world();
      if (nav.focus && !world.byKey.has(nav.focus.block)) nav = { level: 'A', focus: null };   // 筛选后焦点块可能已不存在
      this._focus = nav.focus || null;
      const level = nav.level || 'A';
      this._setLevel(level, level === 'A' ? { fit: true } : this._focus ? this._drillTo(level, this._focus.block) : { fit: true });
      return this._renderQueue;
    }
    restyle(nodes = false, states = false) {
      if (!this._usePreset() || this._level !== 'C') return this.render();
      this._renderQueue = this._renderQueue.catch(() => {}).then(async () => {
        if (!this.graph) return;
        if (nodes) this.graph.updateNodeData((this._renderedCodes || []).map(code => { const n = this._node(code); return n ? { id: code, style: { ...this._nodeStyle(n, 'C'), x: undefined, y: undefined } } : null; }).filter(Boolean));
        else this.graph.updateEdgeData((this._renderedEdgeIdx || []).map(i => ({ id: '__e' + i, style: this._edgeStyle(this.edges[i], 'C') })));
        await this.graph.draw();
        if (states) await this._applyStates();
      });
      return this._renderQueue;
    }
    setColorBy(c) { this.colorBy = c; return this.render(); }
    setHighlight(kind) { this.highlight = kind; return this._usePreset() && this._level === 'C' ? this._applyStates().then(() => this.render()) : this.render(); }
    setEdgeOpacity(v) { this.edgeOpacity = Math.min(1, Math.max(0.05, Number(v) || 0.8)); return this.render(); }
    setShowRatio(v) { this.showRatio = !!v; return this.render(); }
    setEdgeDirection(v) { this.edgeDirection = v === 'bottom-up' ? 'bottom-up' : 'top-down'; return this.render(); }
    setRatioStyle(v) { this.ratioStyle = v === 'ratio' ? 'ratio' : 'times'; return this.render(); }
    select(code) { this.selected = code; return this.render(); }
    // 编程式复现单击节点的效果：锁定该编码并高亮整条关联链路（汇总表跳转联动用）。
    // 选中节点属于关键节点（_isKeyNode 含 chainCode），会被保留在裁剪集内。
    selectChain(code) {
      this._renderQueue = this._renderQueue.catch(() => {}).then(async () => {
        if (!this.graph || !this._nodeMap?.has(code)) return;
        this.chainCode = code; this.selected = code;
        await this._applyStates();
      });
      return this._renderQueue;
    }
    fit() { return this._usePreset() ? this._applyViewport() : this.graph.fitView(); }
    // 方向：画布像素 = 世界 × getZoom() → 视觉「放大」= zoomBy(大于 1)
    zoomIn() { return this.graph.zoomBy(1.25); }
    zoomOut() { return this.graph.zoomBy(0.8); }
    destroy() {
      this._renderRevision++;
      if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
      if (this.crumb) { this.crumb.remove(); this.crumb = null; }
      if (this.graph) { this.graph.destroy(); this.graph = null; }
    }
  }

  ForecastGraph.hashColor = hashColor; // 暴露给图例：模板类型与节点颜色保持一致（对齐经典版）
  // 命名空间隔离：主页面同时加载经典版时用 ForecastGraphMap；独立地图页只加载本文件时回退为 ForecastGraph
  root.ForecastGraphMap = ForecastGraph;
  if (!root.ForecastGraph) root.ForecastGraph = ForecastGraph;
})(typeof window !== 'undefined' ? window : this);
