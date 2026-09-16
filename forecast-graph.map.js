/* Forecast graph renderer（地图版 / cluster-block map）— AntV G6 v5.
 *
 * 设计：以「聚类对象」为主视觉单元的三档语义缩放（地图化）。
 *   A 集群视图：只画聚类块（面积 ∝ 编码数），块间只画 Top-N 汇总流，画布上没有一个编码点。
 *   B 分组视图：每个聚类块沿纵向展开为 BOM 层子块，层间仍只画 Top-N 汇总流。
 *   C 编码视图：仅聚焦块内的编码（硬上限 MAX_CODES），只画局部边，关键编码才带标签。
 *
 * 交互：滚轮连续缩放换档（相对 fit 缩放 + 迟滞，避免抖动）+ 点击块下钻 + 面包屑返回。
 * 三档共用同一世界坐标系（块的位置不变），保证缩放/切换时坐标连续 = 空间记忆。
 *
 * 兼容原 ForecastGraph 公开 API（构造签名、setData/setLayout/setCluster/setColorBy/
 * setHighlight/setEdgeOpacity/setShowRatio/select/fit/zoomIn/zoomOut/destroy + graph 字段），
 * 因此 forecast-app.js 与 index.map.html 无需改动。
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
    const o = Object.assign({ gap: 22, iterations: 320, vBias: 0.85, squash: 0.62 }, opts || {});
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

  // B 档：每个聚类块一列，列内按 BOM 层纵向堆叠；列按总规模降序自左向右，整体居中于原点。
  function placeColumns(units, opts) {
    const o = Object.assign({ colGap: 78, rowGap: 16 }, opts || {});
    if (!units.length) return { pos: new Map(), width: 1, height: 1, columns: [] };
    const sizes = blockSizes(units, { minSize: 58, maxSize: 158, ratio: 0.78, minH: 42 });
    const cols = new Map();
    for (const u of units) {
      const [bk, lv] = u.key.split('\u0000');
      if (!cols.has(bk)) cols.set(bk, { key: bk, total: 0, items: [] });
      const c = cols.get(bk); c.total += u.count; c.items.push({ lv: Number(lv), u });
    }
    const list = [...cols.values()].sort((a, b) => b.total - a.total || String(a.key).localeCompare(String(b.key)));
    const pos = new Map();
    let x = 0, maxH = 0;
    for (const c of list) {
      let w = 0; for (const it of c.items) w = Math.max(w, sizes.get(it.u.key).w);
      c.w = w; c.x = x; c.top = 0;
      let y = 0;
      for (const it of c.items.slice().sort((a, b) => a.lv - b.lv)) {
        const s = sizes.get(it.u.key);
        pos.set(it.u.key, { x: x + (w - s.w) / 2, y, w: s.w, h: s.h, cx: x + w / 2, cy: y + s.h / 2 });
        y += s.h + o.rowGap;
      }
      c.h = Math.max(0, y - o.rowGap); maxH = Math.max(maxH, c.h);
      x += w + o.colGap;
    }
    const totalW = Math.max(0, x - o.colGap), ox = totalW / 2, oy = maxH / 2;
    for (const [k, p] of pos) pos.set(k, { x: p.x - ox, y: p.y - oy, w: p.w, h: p.h, cx: p.cx - ox, cy: p.cy - oy });
    return { pos, width: totalW, height: maxH, columns: list.map(c => ({ key: c.key, total: c.total, cx: c.x + c.w / 2 - ox, top: -oy, w: c.w })) };
  }

  // 块间流聚合 + Top-N 裁剪：每个源块保留 strongest perSource 条，总量不超过 max
  function aggregateFlows(edges, keyOf, opts) {
    const o = Object.assign({ perSource: 2, max: 26 }, opts || {});
    const pairs = new Map();
    for (const e of edges) {
      const s = keyOf(e.source), t = keyOf(e.target);
      if (s == null || t == null || s === t) continue;
      const k = s + '\u0000' + t;
      let f = pairs.get(k);
      if (!f) { f = { s, t, count: 0, critical: false, risk: false }; pairs.set(k, f); }
      f.count++; f.critical = f.critical || !!e.critical; f.risk = f.risk || !!e.risk;
    }
    const rank = (a, b) => b.count - a.count || (b.critical ? 1 : 0) - (a.critical ? 1 : 0) || (b.risk ? 1 : 0) - (a.risk ? 1 : 0);
    const bySource = new Map();
    for (const f of pairs.values()) { if (!bySource.has(f.s)) bySource.set(f.s, []); bySource.get(f.s).push(f); }
    let kept = [];
    for (const arr of bySource.values()) { arr.sort(rank); kept = kept.concat(arr.slice(0, o.perSource)); }
    kept.sort(rank);
    return kept.slice(0, o.max);
  }

  // 流宽：对数压缩 + 上限，避免少数超大流吞掉全部视觉带宽（块永远主导画面）
  function flowWidth(count) { return Math.min(4.6, 1.0 + Math.log2(1 + Math.max(0, count)) * 0.7); }

  const api = { layered, aggregateBlocks, blockSizes, placeBlocks, placeColumns, aggregateFlows, flowWidth };
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
  const MAX_CODES = 120;          // C 档画布编码数硬上限
  const MAX_FLOWS = 26;           // 单档汇总流总上限
  const FLOWS_PER_SOURCE = 2;     // 每个块的出向流保留条数
  const MAX_CODE_EDGES = 260;     // C 档边上限
  const ZIN = 1.55, ZOUT = 0.645, HYST = 0.18;   // 换档阶梯：放大 1.55 倍进下一档 / 缩小则退回（相对本档 fit）

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
      this.chainCode = '';
      this.ready = false;
      this.graph = null;
      this._renderQueue = Promise.resolve();
      this._renderRevision = 0;
      this._didInitialFit = false;
      this._fitZoom = 1;                             // 本档 fitView 后的缩放（倍率基准）
      this._pad = [40, 40, 40, 40];                  // 与 Graph options.padding 一致（解析式 fit 用）
      this._transitioning = false;                   // 换档进行中：忽略 transform 事件
      this._levelWorld = { width: 1, height: 1 };   // 当前档内容的世界尺寸
      this._lastData = null;                        // 最近一次 build 的图数据（供 fit 重算）
      this._progDepth = 0;           // >0 表示正在执行程序化视口操作（期间忽略换档事件）
      this._level = 'A';             // A 集群 | B 分组 | C 编码
      this._focus = null;            // null | { block, level? }
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
        animation: false,
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
            labelFill: d => d.style?.labelFill || '#e6eefc',
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
        behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element']
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
    _blockLabel(b) {
      const risk = this.colorBy === 'risk' && b.riskCount ? ' · 风险' + b.riskCount : '';
      return b.key + ' · ' + b.count + risk;
    }

    // ---- 档 A：集群视图（只画块，无编码点）----
    _buildLevelA() {
      const world = this._world();
      this._blkIds = new Map(); this._blkRev = new Map();
      const nodes = [];
      world.blocks.forEach((b, i) => {
        const p = world.pos.get(b.key); if (!p) return;
        const id = '__blk_' + i; this._blkIds.set(b.key, id); this._blkRev.set(id, { key: b.key });
        nodes.push({
          id, type: 'rect',
          data: { __block: true, key: b.key, count: b.count, riskCount: b.riskCount, codes: b.codes, x: p.cx, y: p.cy },
          style: {
            size: [p.w, p.h], radius: 10, x: p.cx, y: p.cy,
            fill: this._blockFill(b), stroke: this._blockStroke(b),
            lineWidth: this._focus && this._focus.block === b.key ? 2.4 : (b.riskCount ? 1.6 : 1),
            labelText: this._blockLabel(b), labelPlacement: 'center', labelFontSize: 12, labelFill: '#101a2b'
          }
        });
      });
      const flows = aggregateFlows(this.edges, c => this._blockKeyOf(c), { perSource: FLOWS_PER_SOURCE, max: MAX_FLOWS });
      const edges = flows.map((f, i) => ({
        id: '__f' + i, type: 'quadratic',
        source: this._blkIds.get(f.s), target: this._blkIds.get(f.t),
        data: { __flow: true, count: f.count, critical: f.critical, risk: f.risk },
        style: this._flowStyle(f, 18)
      })).filter(e => e.source && e.target);
      this._renderedCodes = [];
      this._renderedEdgeIdx = [];
      this._rendered = { level: 'A', units: nodes.length, flows: edges.length, totalCodes: this.nodes.length, totalEdges: this.edges.length };
      return { nodes, edges, combos: [] };
    }

    _flowStyle(f, curve) {
      const st = { stroke: FLOW.normal, lineWidth: flowWidth(f.count), opacity: 0.30, endArrow: false, curveOffset: curve };
      if (f.critical) { st.stroke = FLOW.critical; st.opacity = 0.55; }
      if (f.risk) { st.stroke = FLOW.risk; st.opacity = 0.58; }
      const hitCritical = this.highlight === 'critical' && f.critical;
      const hitRisk = this.highlight === 'risk' && f.risk;
      if (hitCritical || hitRisk) { st.lineWidth = Math.max(st.lineWidth, 3.2); st.opacity = 0.95; }
      else if (this.highlight) st.opacity = 0.08;
      return st;
    }

    // ---- 档 B：分组视图（块内按 BOM 层拆子块；每块一列，列内有列标题）----
    _buildLevelB() {
      const units = aggregateBlocks(this.nodes, n => this._blockKey(n) + '\u0000' + this._levelOf(n));
      const plan = placeColumns(units);
      const byUnit = new Map(units.map(u => [u.key, u]));
      const LEVEL_COUNT = Math.max(...units.map(u => Number(u.key.split('\u0000')[1])), 0) + 1;
      this._subIds = new Map(); this._subRev = new Map();
      this._headRev = new Map();
      const nodes = [];
      // 列标题：块名 + 总编码数，置于列顶
      plan.columns.forEach((c, i) => {
        const id = '__head_' + i; this._headRev.set(id, { key: c.key });
        nodes.push({
          id, type: 'rect',
          data: { __head: true, key: c.key, x: c.cx, y: c.top - 26 },
          style: {
            size: [Math.max(c.w, 96), 26], radius: 6, x: c.cx, y: c.top - 26,
            fill: rgba(hashColor(c.key), 0.94), stroke: 'rgba(230,240,255,.28)', lineWidth: 1,
            labelText: c.key + ' · ' + c.total, labelPlacement: 'center', labelFontSize: 12, labelFill: '#0d1729'
          }
        });
      });
      units.forEach((u, i) => {
        const p = plan.pos.get(u.key); if (!p) return;
        const [bk, lv] = u.key.split('\u0000'); const level = Number(lv);
        const id = '__sub_' + i; this._subIds.set(u.key, id); this._subRev.set(id, { block: bk, level });
        const focused = this._focus && this._focus.block === bk;
        const ratio = u.riskCount / Math.max(1, u.count);
        const fill = this.colorBy === 'risk'
          ? (ratio >= 0.5 ? RISK_FILL.high : ratio >= 0.2 ? RISK_FILL.mid : RISK_FILL.low)
          : levelColor(level);
        nodes.push({
          id, type: 'rect',
          data: { __sub: true, key: u.key, block: bk, level, count: u.count, riskCount: u.riskCount, codes: u.codes, x: p.cx, y: p.cy },
          style: {
            size: [p.w, p.h], radius: 8, x: p.cx, y: p.cy,
            fill, stroke: focused ? '#f0e0b0' : rgba(hashColor(bk), 0.9),
            lineWidth: focused ? 2.4 : 1.2,
            labelText: (level + 1) + '层 · ' + u.count + (this.colorBy === 'risk' && u.riskCount ? ' · 险' + u.riskCount : ''),
            labelPlacement: 'center', labelFontSize: 12, labelFill: '#0d1729'
          }
        });
      });
      const keyOf = code => { const n = this._nodeMap.get(code); return n ? this._blockKey(n) + '\u0000' + this._levelOf(n) : null; };
      const flows = aggregateFlows(this.edges, keyOf, { perSource: 2, max: MAX_FLOWS });
      const edges = flows.map((f, i) => ({
        id: '__f' + i, type: 'quadratic',
        source: this._subIds.get(f.s), target: this._subIds.get(f.t),
        data: { __flow: true, count: f.count, critical: f.critical, risk: f.risk },
        style: this._flowStyle(f, 16)
      })).filter(e => e.source && e.target);
      this._renderedCodes = [];
      this._renderedEdgeIdx = [];
      this._rendered = { level: 'B', units: nodes.length, flows: edges.length, levels: LEVEL_COUNT, totalCodes: this.nodes.length, totalEdges: this.edges.length };
      return { nodes, edges, combos: [] };
    }

    _degree(code) { return (this._outEdges?.get(code)?.length || 0) + (this._inEdges?.get(code)?.length || 0); }
    _codeScore(n) {
      let s = this._degree(n.code);
      if ((n.gap || 0) > 1e-8) s += 1000;
      if (n.single) s += 200;
      if (n.multiLevel) s += 80;
      if (n.complete === false) s += 40;
      return s;
    }

    // ---- 档 C：编码视图（仅聚焦块，硬上限；按 BOM 层分行、整体居中于原点）----
    _buildLevelC() {
      const world = this._world();
      let focusKey = this._focus && this._focus.block;
      if (!focusKey) {   // 放到最大时自动进入编码数最多的块（面包屑可见、可返回）
        focusKey = world.blocks.slice().sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)))[0]?.key;
        this._focus = { block: focusKey };
      }
      const focusLevel = this._focus && this._focus.level;
      let members = this.nodes.filter(n => this._blockKey(n) === focusKey);
      if (focusLevel != null) members = members.filter(n => this._levelOf(n) === Number(focusLevel));
      const ranked = members.map(n => ({ n, s: this._codeScore(n) })).sort((a, b) => b.s - a.s || String(a.n.code).localeCompare(String(b.n.code)));
      const picked = ranked.slice(0, MAX_CODES).map(x => x.n);
      const pickedIds = new Set(picked.map(n => n.code));
      const ROW_GAP = 64, COL_W = 46;
      const byLevel = new Map();
      for (const n of picked) { const lv = this._levelOf(n); if (!byLevel.has(lv)) byLevel.set(lv, []); byLevel.get(lv).push(n); }
      const levels = [...byLevel.keys()].sort((a, b) => a - b);
      for (const lv of levels) byLevel.get(lv).sort((a, b) => (b.multiLevel ? 1 : 0) - (a.multiLevel ? 1 : 0) || String(a.code).localeCompare(String(b.code)));
      const totalH = Math.max(0, (levels.length - 1) * ROW_GAP);
      const maxCols = Math.max(1, ...levels.map(lv => byLevel.get(lv).length));
      const nodes = [];
      this._rowRev = new Map();
      levels.forEach((lv, ri) => {
        const arr = byLevel.get(lv);
        const y = ri * ROW_GAP - totalH / 2;
        const startX = -(arr.length - 1) * COL_W / 2;
        arr.forEach((n, k) => {
          const x = startX + k * COL_W;
          const st = this._nodeStyle(n, 'C');
          nodes.push({ id: n.code, type: 'circle', data: { ...n, x, y }, style: { ...st, x, y, labelPlacement: 'bottom' } });
          pickedIds.add(n.code);
        });
        // 行标签：第 N 层 + 本视图编码数
        const labelX = -((maxCols - 1) * COL_W) / 2 - 78;
        const rid = '__row_' + lv; this._rowRev.set(rid, { level: lv });
        nodes.push({
          id: rid, type: 'rect',
          data: { __row: true, level: lv, x: labelX, y },
          style: { size: [72, 26], radius: 6, x: labelX, y, fill: 'rgba(120,146,180,.10)', stroke: 'rgba(120,146,180,.30)', lineWidth: 1, labelText: (lv + 1) + '层 · ' + arr.length, labelPlacement: 'center', labelFontSize: 12, labelFill: '#c6d6ea' }
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
        const e = this.edges[i];
        return { id: '__e' + i, source: e.source, target: e.target, data: { ...e }, style: this._edgeStyle(e, 'C') };
      });
      this._rendered = { level: 'C', units: picked.length, flows: edges.length, focusKey, focusLevel: focusLevel != null ? Number(focusLevel) : null, members: members.length, dropped: members.length - picked.length, levels: levels.length, totalCodes: this.nodes.length, totalEdges: this.edges.length };
      return { nodes, edges, combos: [] };
    }

    _nodeStyle(n, level) {
      let fill;
      if (this.colorBy === 'risk') fill = this._riskColor(n);
      else if (this.colorBy === 'site') fill = this._siteColor(n);
      else if (this.colorBy === 'none') fill = '#9aa7b6';
      else fill = levelColor(n.level);
      let stroke = 'rgba(11,18,34,.9)', lineWidth = 1.6;
      if ((n.gap || 0) > 1e-8) { stroke = '#e0899a'; lineWidth = 2.4; }
      else if (n.single) { stroke = '#d8b06a'; lineWidth = 2.4; }
      const size = n.code === this.selected ? 22 : 17;
      const style = { size, fill, stroke, lineWidth };
      if (n.multiLevel) { style.lineDash = [3, 2]; if (stroke === 'rgba(11,18,34,.9)') stroke = '#c9a25e'; style.stroke = stroke; }
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
    _isKeyNode(n) { return n.code === this.selected || n.code === this.chainCode || !!n.multiLevel || (n.gap || 0) > 1e-8 || !!n.single; }

    _edgeStyle(e, level) {
      let stroke = '#4d6c8c', width = 1.1;
      if (e.critical) { stroke = FLOW.critical; width = 2.2; }
      else if (e.risk) { stroke = FLOW.risk; width = 2; }
      const dashed = e.kind && (e.kind.includes('跨产业') || e.kind === 'BOM');
      const style = { stroke, lineWidth: width, opacity: Math.min(0.75, this.edgeOpacity * 0.7), lineDash: dashed ? [4, 3] : undefined, endArrow: true };
      if (this.showRatio && e.qty != null) style.labelText = '×' + (Math.round(e.qty * 100) / 100);
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
      const edges = this.edges.map((e, i) => ({ id: '__e' + i, source: e.source, target: e.target, data: { ...e }, style: this._edgeStyle(e, 'C') }));
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

    // 世界包围盒尺寸（仅用于诊断/计数，不参与取景）
    _boundsOf(data) {
      let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
      for (const n of ((data && data.nodes) || [])) {
        const sx = n.style && n.style.x, sy = n.style && n.style.y;
        if (typeof sx !== 'number' || typeof sy !== 'number') continue;
        const sz = n.style && n.style.size;
        const hw = Array.isArray(sz) ? (Number(sz[0]) || 0) / 2 : (typeof sz === 'number' ? sz / 2 : 0);
        const hh = Array.isArray(sz) ? (Number(sz[1]) || 0) / 2 : (typeof sz === 'number' ? sz / 2 : 0);
        mnx = Math.min(mnx, sx - hw); mxx = Math.max(mxx, sx + hw);
        mny = Math.min(mny, sy - hh); mxy = Math.max(mxy, sy + hh);
      }
      if (!(mxx > mnx) || !(mxy > mny)) return { width: 1, height: 1 };
      return { width: Math.max(1, mxx - mnx), height: Math.max(1, mxy - mny) };
    }

    // 解析式适配缩放 = min(可用宽/世界宽, 可用高/世界高)。
    // 与官方 fitView 完全等价（已实测吻合到 5 位小数）：
    //   A 世界 760×488, 可用 1004×764 → min(1.3211,1.5656)=1.3211（实测 1.32164）
    //   B 世界 2631×765, 可用 1004×764 → min(0.38160,0.99869)=0.38160（实测 0.38165）
    // 关键：它在 setData/fitView 之前就能算出，因此换档期间「基准」始终与当前档一致，
    // 不会出现「用旧基准量新缩放」的误判（那会导致 A/B 互相跳档的死循环）。
    _fitOf(world) {
      const { cw, ch } = this._size();
      const p = this._pad || [40, 40, 40, 40];       // Graph options.padding: [top,right,bottom,left]
      const availW = Math.max(1, cw - (p[1] || 0) - (p[3] || 0));
      const availH = Math.max(1, ch - (p[0] || 0) - (p[2] || 0));
      const z = Math.min(availW / Math.max(1, world.width), availH / Math.max(1, world.height));
      return Math.min(32, Math.max(0.005, z));
    }

    _measure(data) {
      this._lastData = data;
      this._levelWorld = this._boundsOf(data);
      this._fitZoom = this._fitOf(this._levelWorld);   // 基准在 setData 前就位
      return this._levelWorld;
    }

    // 取景 = fitView（官方实现，按 padding 缩放并居中，落点与 _fitOf 一致）
    async _applyViewport() {
      if (!this.graph) return;
      this._progDepth++;
      try {
        try { await this.graph.fitView({ when: 'always', direction: 'both' }, { duration: 0 }); } catch { /* 忽略 */ }
      } finally { this._progDepth--; }
    }

    // 视觉放大倍率：r > 1 = 比「本档适配」更放大（因为 像素 = 世界 × zoom）。
    _ratioOf(zoom) {
      const z = zoom != null ? zoom : (this.graph ? this.graph.getZoom() : this._fitZoom);
      return this._fitZoom > 0 ? z / this._fitZoom : 1;
    }

    // 重新按当前档内容取景（窗口尺寸变化 / 手动 fit 时用）
    async _fitToContent() {
      if (this._lastData) this._measure(this._lastData);
      await this._applyViewport();
    }

    // resize 后重新取景：仅在「当前就处在适配倍率附近」时重取，避免打断用户已放大/平移的视图
    async _recenter() {
      if (!this.graph) return;
      if (Math.abs(this._ratioOf() - 1) < 0.05) await this._applyViewport();
    }


    // ---- 换档阶梯（r 相对当前档自身 fit，见 _ratioOf）----
    _levelForZr(r, prev) {
      const H = HYST;
      if (prev === 'A') return r >= ZIN + H ? 'B' : 'A';
      if (prev === 'B') return r >= ZIN + H ? 'C' : (r <= ZOUT - H ? 'A' : 'B');
      return r <= ZOUT - H ? 'B' : 'C';      // prev === 'C'
    }

    _onTransform() {
      if (!this._usePreset() || !this.graph || !this._fitZoom) return;
      if (this._transitioning) return;      // 换档进行中：此期间的 transform 事件不代表用户意图
      let z; try { z = this.graph.getZoom(); } catch { return; }
      const next = this._levelForZr(this._ratioOf(z), this._level);
      if (next !== this._level) this._setLevel(next);
      else this._updateCrumb();
    }

    // 换到 level 并按该档自身的 fit 展示（三档坐标系互不相同：A 打包 / B 柱列 / C 层行，
    // 绝对 zoom 不可比，故每档进入时都用 fitView 以「本档自己的内容」重新取景）。
    _setLevel(level) {
      if (!this.graph) return;
      const prev = this._level; this._level = level;
      const revision = ++this._renderRevision;
      this._transitioning = true;
      this._renderQueue = this._renderQueue.catch(() => {}).then(async () => {
        if (!this.graph || revision !== this._renderRevision) { this._transitioning = false; return; }
        const data = this._buildData();
        this._measure(data);                       // 世界尺寸 + 解析式 fit（先于 setData 就位）
        this.graph.setData(data);
        await this.graph.render();
        if (this.graph && revision === this._renderRevision) {
          await this._applyViewport();             // fitView：按本档内容缩放 + 居中
          await this._applyStates();
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
      parts.push('<span class="mchint">视图 <b>' + this._lodLabel(this._level) + '</b> · 滚轮缩放 · 点击块下钻 · 双击直达编码</span>');
      this.crumb.innerHTML = parts.join('');
    }
    _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    _escA(s) { return this._esc(s); }

    // 下钻 / 返回：一律按目标档【自身的 fit】展示。
    // 三档世界尺寸不同、绝对 zoom 不可比，只有以各自 fit 为基准才能保证该档结构完整可见。
    _gotoLevel(level) {
      this._setLevel(level);
    }

    _crumbGo(kind, key, level) {
      if (kind === 'root') { this._focus = null; this._gotoLevel('A'); }
      else if (kind === 'block') { this._focus = { block: key }; this._gotoLevel('B'); }
      else if (kind === 'level') { this._focus = { block: key, level: Number(level) }; this._gotoLevel('C'); }
    }

    // ---- 点击：用自管 id 前缀识别块/子块/列标题，避免依赖 G6 读数据 API ----
    _onNodeClick(evt) {
      const id = String(evt.target.id);
      const blk = this._blkRev.get(id), head = this._headRev.get(id);
      if (blk || head) { this._focus = { block: (blk || head).key }; this._gotoLevel('B'); return; }
      const sub = this._subRev.get(id);
      if (sub) { this._focus = { block: sub.block, level: sub.level }; this._gotoLevel('C'); return; }
      const n = this._node(id);
      if (!n) return;
      if (this.chainCode === id) { this.chainCode = ''; this.selected = ''; this._applyStates(); this.onCanvasClick(); return; }
      this.chainCode = id; this.selected = id;
      this._applyStates(); this.onNodeClick(id, n);
    }

    _onNodeDblClick(evt) {
      const id = String(evt.target.id);
      const blk = this._blkRev.get(id), head = this._headRev.get(id);
      if (blk || head) { this._focus = { block: (blk || head).key }; this._gotoLevel('C'); return; }
      const sub = this._subRev.get(id);
      if (sub) { this._focus = { block: sub.block, level: sub.level }; this._gotoLevel('C'); return; }
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
        else if (r.level === 'B') el.textContent = '当前显示 ' + r.units + ' 个层块 · ' + r.flows + ' 条层间流 ｜ 范围 ' + r.totalCodes + ' 编码 / ' + r.totalEdges + ' 边';
        else if (r.level === 'C') el.textContent = '当前显示 ' + r.units + ' 个编码（上限 ' + MAX_CODES + '）· ' + r.flows + ' 条边 ｜ 本块共 ' + r.members + ' 编码' + (r.dropped > 0 ? '，已折叠 ' + r.dropped + ' 个次要编码' : '');
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
      this._level = 'A';          // 换数据后从集群视图开始
      this._focus = null;
      this._worldCache = null;
      this._dataRev++;
      this._didInitialFit = false;
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
        const world = this._boundsOf(data);
        const prevWorld = this._levelWorld;
        this._measure(data);          // 记录本档世界尺寸（诊断/取景判断）
        this.graph.setData(data);
        await this.graph.render();
        if (this.graph && revision === this._renderRevision) {
          // 首次渲染，或内容尺度明显变化（换聚类维度/过滤/下钻）时重新取景；
          // 纯样式更新（高亮/配色/透明度）不动视口，避免打断用户已放大/平移的视图。
          const scaleChanged = !this._didInitialFit
            || Math.abs(world.width / Math.max(1, prevWorld.width) - 1) > 0.05
            || Math.abs(world.height / Math.max(1, prevWorld.height) - 1) > 0.05;
          if (scaleChanged) { await this._fitToContent(); this._didInitialFit = true; }
          await this._applyStates();
          this._afterRender();
          this.onLodChange(this._lodCode(this._level), this._lodLabel(this._level));
        }      });
      return this._renderQueue;
    }

    setLayout(mode) { if (mode === this.layoutMode) return Promise.resolve(); this.layoutMode = mode; this._worldCache = null; return this.render(); }
    setCluster(c) { if (c === this.cluster) return Promise.resolve(); this.cluster = c; this._focus = null; this._worldCache = null; return this.render(); }
    restyle(nodes = false, states = false) {
      if (!this._usePreset() || this._level !== 'C') return this.render();
      this._renderQueue = this._renderQueue.catch(() => {}).then(async () => {
        if (!this.graph) return;
        if (nodes) this.graph.updateNodeData((this._renderedCodes || []).map(code => { const n = this._node(code); return n ? { id: code, style: { ...this._nodeStyle(n, 'C'), x: undefined, y: undefined } } : null; }).filter(Boolean));
        else this.graph.updateEdgeData((this._renderedEdgeIdx || []).map(i => ({ id: '__e' + i, style: { ...this._edgeStyle(this.edges[i], 'C'), labelText: this.showRatio && this.edges[i].qty != null ? '×' + (Math.round(this.edges[i].qty * 100) / 100) : '' } })));
        await this.graph.draw();
        if (states) await this._applyStates();
      });
      return this._renderQueue;
    }
    setColorBy(c) { this.colorBy = c; return this.render(); }
    setHighlight(kind) { this.highlight = kind; return this._usePreset() && this._level === 'C' ? this._applyStates().then(() => this.render()) : this.render(); }
    setEdgeOpacity(v) { this.edgeOpacity = Math.min(1, Math.max(0.05, Number(v) || 0.8)); return this.render(); }
    setShowRatio(v) { this.showRatio = !!v; return this.render(); }
    select(code) { this.selected = code; return this.render(); }
    fit() { return this._usePreset() ? this._fitToContent() : this.graph.fitView(); }
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

  root.ForecastGraph = ForecastGraph;
})(typeof window !== 'undefined' ? window : this);
