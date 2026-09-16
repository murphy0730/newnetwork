/* Forecast graph renderer (AntV G6 v5). No DOM/storage coupling; consumes
 * {nodes, edges} from the server /api/graph response and manages layout,
 * clustering, coloring, path highlighting and node selection. */
(function (root) {
  'use strict';
  // 地图化分带布局：横轴 = 分组带（制造部门 / 产品大类 / 加工地），纵轴 = BOM 层。
  // width/height 参数保留以兼容原调用签名，但分带布局尺寸由「带数 × 层数 × 桶内节点数」决定，
  // 与视口尺寸无关 —— 这正是"地图可滑动"的前提：世界平面比视口大。
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
    // 每个 (group, level) 桶
    const buckets = new Map();
    for (const n of nodes) {
      const key = String(group(n) || '') + '\u0000' + (Math.max(0, Number(n.level) || 0));
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(n);
    }
    // 带宽 / 层高自适应：按桶内最大节点数排成接近方阵，避免单带过挤
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
    // 带 / 层的累计起点
    const groupX = new Map(); let x = 0;
    for (const g of groups) { groupX.set(g, x); x += bandWidths.get(g); }
    const levelY = new Map(); let y = 0;
    for (const l of levels) { levelY.set(l, y); y += levelHeights.get(l); }
    // 桶内网格排布（同组同层节点无父子关系，顺序不影响拓扑）
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
    // BOM 层分区（供分层标签与凸包），count = 该层节点总数
    const regions = levels.map(l => ({ level: l, top: levelY.get(l) - 8, bottom: levelY.get(l) + levelHeights.get(l) + 8, count: 0 }));
    for (const n of nodes) {
      const l = Math.max(0, Number(n.level) || 0);
      const rg = regions.find(r => r.level === l);
      if (rg) rg.count++;
    }
    // 桶信息（L0 战略层聚合块使用）：每个 (group, level) 桶 → { key, level, codes, cx, cy }
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
  // Keep layout and renderer in one browser asset, including during server upgrades.
  if (typeof module === 'object' && module.exports) { module.exports = { layered }; return; }
  root.ForecastLayout = { layered };
  const G6 = root.G6;
  if (!G6) { console.error('G6 未加载'); return; }

  const LEVEL_COLORS = ['#4A90E2', '#E8A33D', '#5BBF8A', '#7788a0'];
  const PALETTE = ['#67a7f5', '#55d4ba', '#edb464', '#b994f4', '#f39db7', '#8cbf73', '#e86a6a', '#4fc3f7', '#ffb74d', '#9575cd', '#5eead4', '#f4c463'];

  function levelColor(level) { return LEVEL_COLORS[Math.min(3, level || 0)]; }
  function hashColor(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return PALETTE[h % PALETTE.length]; }
  function hexToRgb(hex) { const v = parseInt(hex.slice(1), 16); return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 }; }
  function rgba(hex, a) { const { r, g, b } = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }

  /* 凸包几何：单调链求凸包 → 质心外扩 → Catmull-Rom 平滑闭合路径 */
  function convexHull(points) {
    const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = []; for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    const upper = []; for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    lower.pop(); upper.pop(); return lower.concat(upper);
  }
  function padHull(hull, pad) {
    let cx = 0, cy = 0; for (const p of hull) { cx += p[0]; cy += p[1]; } cx /= hull.length; cy /= hull.length;
    return hull.map(([x, y]) => { const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1; return [x + dx / d * pad, y + dy / d * pad]; });
  }
  function smoothClosedPath(pts) {
    const n = pts.length, f = v => v.toFixed(1);
    let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])},${f(p2[1])}`;
    }
    return d + 'Z';
  }
  function hullPath(points, pad) {
    if (points.length === 1) { const [x, y] = points[0]; return `M${x + pad},${y}A${pad},${pad} 0 1,0 ${x - pad},${y}A${pad},${pad} 0 1,0 ${x + pad},${y}Z`; }
    if (points.length === 2) {
      const [a, b] = points, dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, nx = -dy / len * pad, ny = dx / len * pad;
      return smoothClosedPath([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]]);
    }
    return smoothClosedPath(padHull(convexHull(points), pad));
  }

  class ForecastGraph {
    constructor(el, opts) {
      this.el = el;
      this.opts = opts || {};
      this.onNodeClick = this.opts.onNodeClick || function () {};
      this.onNodeDblClick = this.opts.onNodeDblClick || function () {};
      this.onCanvasClick = this.opts.onCanvasClick || function () {};
      this.nodes = [];
      this.edges = [];
      this.layoutMode = 'force';     // force | layered
      this.cluster = 'none';         // none | industry | category | site
      this.colorBy = 'level';        // level | risk | site | none
      this.highlight = '';           // '' | critical | risk
      this.selected = '';
      this.edgeOpacity = 0.8;        // 连线透明度，设置面板可调
      this.showRatio = false;        // 边上是否展示配比关系（×数量）
      this.chainCode = '';           // 单击选中的链路中心节点
      this.ready = false;
      this.graph = null;
      this._renderQueue = Promise.resolve();
      this._renderRevision = 0;
      this._didInitialFit = false;
      // —— 地图化 LOD（语义缩放）——
      // L0 战略层（聚合块+关键路径骨架）< L1 聚合层（缩小节点+关键边）< L2 网络层（分级标签）< L3 编码层（全标签）
      this._lod = 'L3';
      this._lodPrev = '';
      this.onLodChange = this.opts.onLodChange || function () {};
      this._buckets = [];             // L0 聚合块用：layered() 产出的桶
      this._init();
    }

    _init() {
      const self = this;
      this.graph = new G6.Graph({
        container: this.el,
        autoFit: false,   // 关闭自动适配：LOD 分档重建需保留缩放/平移，fitView 由 render() 手动控制
        autoResize: true,
        animation: false,
        padding: [36, 36, 36, 36],
        data: { nodes: [], edges: [] },
        layout: { type: 'force' },
        node: {
          type: 'circle',
          style: {
            size: d => d.style?.size || 24,
            fill: d => d.style?.fill || '#5597e7',
            stroke: d => d.style?.stroke || '#0b1222',
            lineWidth: d => d.style?.lineWidth || 2,
            opacity: 1,
            labelText: (d) => d.style?.labelText ?? d.id,
            labelFill: '#dae7f9',
            labelFontSize: 11,
            labelPlacement: 'bottom',
            labelOffsetY: 4
          },
          state: {
            selected: { stroke: '#ffffff', lineWidth: 3, halo: true, haloLineWidth: 8, haloStroke: '#3d8bff', haloStrokeOpacity: 0.35 },
            active: { stroke: '#7db4ff', lineWidth: 3 },
            dim: { opacity: 0.12 }
          }
        },
        edge: {
          type: 'line',
          style: { stroke: d => d.style?.stroke || '#456489', lineWidth: d => d.style?.lineWidth || 1.5, endArrow: true, opacity: d => d.style?.opacity ?? 0.8, labelText: d => d.style?.labelText || '', labelFill: '#9db8dc', labelFontSize: 10, labelBackground: true, labelBackgroundFill: 'rgba(9,15,30,.85)', labelBackgroundRadius: 3, labelPadding: [1, 4, 1, 4] },
          state: { active: { stroke: '#7db4ff', lineWidth: 2.5, opacity: 1 }, dim: { opacity: 0.05 } }
        },
        combo: {
          // combo 仅用于分组布局；可见边框由凸包 overlay 绘制（不规则形状，多加工地节点可跨组）
          type: 'rect',
          style: { padding: 20, fillOpacity: 0, strokeOpacity: 0, labelOpacity: 0, labelFill: 'transparent', labelBackground: false }
        },
        behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element']
      });
      // 凸包边框 overlay 层
      this.hullLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.hullLayer.classList.add('cluster-hull-layer');
      this.el.appendChild(this.hullLayer);
      this.graph.on('afterrender', () => this._scheduleHulls());
      this.graph.on('aftertransform', () => { this._scheduleHulls(); this._detectLod(); });
      this.graph.on('node:drag', () => this._scheduleHulls());
      this.graph.on('node:dragend', () => this._scheduleHulls());
      this.graph.on('combo:drag', () => this._scheduleHulls());
      this.graph.on('combo:dragend', () => this._scheduleHulls());
      // 拖拽期间逐帧重绘凸包，保证边框与节点同步移动
      const dragLoop = () => { this._drawHulls(); if (this._dragging) requestAnimationFrame(dragLoop); };
      const dragStart = () => { if (!this._dragging) { this._dragging = true; dragLoop(); } };
      const dragEnd = () => { this._dragging = false; this._scheduleHulls(); };
      this.graph.on('node:dragstart', dragStart);
      this.graph.on('combo:dragstart', dragStart);
      this.graph.on('node:dragend', dragEnd);
      this.graph.on('combo:dragend', dragEnd);
      // 容器尺寸变化（如右侧面板展开/收起）时仅同步画布与凸包，不重排全图
      // —— 地图化后坐标系与视口解耦，resize 不应改变节点位置。
      if (typeof ResizeObserver !== 'undefined') {
        this._resizeObserver = new ResizeObserver(() => { if (this.graph) { this.graph.resize(); this._scheduleHulls(); } });
        this._resizeObserver.observe(this.el);
      }
      this.graph.on('node:click', (evt) => {
        const id = evt.target.id;
        const n = this._node(id);
        if (!n) return;
        if (this.chainCode === id) {
          // 再次点击同一节点：取消链路高亮
          this.chainCode = '';
          this.selected = '';
          this._applyStates();
          this.onCanvasClick();
          return;
        }
        this.chainCode = id;
        this.selected = id;
        this._applyStates();
        this.onNodeClick(id, n);
      });
      this.graph.on('node:dblclick', (evt) => {
        const id = evt.target.id;
        const n = this._node(id);
        if (n) this.onNodeDblClick(id, n);
      });
      this.graph.on('canvas:click', () => {
        this.chainCode = '';
        this._applyStates();
        this.onCanvasClick();
      });
      this.ready = true;
    }

    _node(id) { return this._nodeMap?.get(id) || null; }

    _nodeStyle(n) {
      let fill;
      if (this.colorBy === 'risk') fill = this._riskColor(n);
      else if (this.colorBy === 'site') fill = this._siteColor(n);
      else if (this.colorBy === 'none') fill = '#7788a0';
      else fill = levelColor(n.level);
      let stroke = '#0b1222', lineWidth = 2;
      if ((n.gap || 0) > 1e-8) { stroke = '#ff7899'; lineWidth = 3; }
      else if (n.single) { stroke = '#f4c463'; lineWidth = 3; }
      const size = n.code === this.selected ? 30 : 24;
      const style = { size, fill, stroke, lineWidth };
      // 多层级归属标记：同一编码在 BOM 中跨多个层级（minLevel < maxLevel），
      // 用金色虚线外圈区分，提示"该编码不仅属于当前层，还出现在更浅/更深的层级"。
      if (n.multiLevel) { style.multiLevel = true; style.lineDash = [3, 2]; if (stroke === '#0b1222') stroke = '#d9a64a'; style.stroke = stroke; }
      return style;
    }

    _riskColor(n) {
      if ((n.gap || 0) > 1e-8) return '#e24b4a';
      if (n.single) return '#f4c463';
      if (n.complete === false) return '#64748b';
      return '#5BBF8A';
    }

    _siteColor(n) {
      const s = n.sites && n.sites[0] && (n.sites[0].key || n.sites[0].name);
      return s ? hashColor(String(s)) : '#7788a0';
    }

    _clusterKey(n) {
      if (this.cluster === 'industry') return n.make_dept || '未分配部门';
      if (this.cluster === 'category') return n.category || '未分类';
      if (this.cluster === 'site') return (n.sites && n.sites[0] && (n.sites[0].key || n.sites[0].name)) || '未分配加工地';
      return null;
    }

    // 凸包分组成员：加工地维度下一个编码可属于多个组（多加工地产出）
    _clusterKeys(n) {
      if (this.cluster === 'site') {
        const keys = (n.sites || []).map(s => s.key || s.name).filter(Boolean);
        return keys.length ? keys : ['未分配加工地'];
      }
      const key = this._clusterKey(n);
      return key == null ? [] : [key];
    }

    _scheduleHulls() {
      if (this._hullRaf) return;
      this._hullRaf = requestAnimationFrame(() => { this._hullRaf = 0; this._drawHulls(); });
    }

    _drawHulls() {
      const svg = this.hullLayer;
      if (!svg) return;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      if (!this.graph || !this.nodes.length) return;
      const rect = this.el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      svg.setAttribute('width', rect.width); svg.setAttribute('height', rect.height);
      if (this._usePreset() && this._regions) for (const band of this._regions) {
        const top = this.graph.getClientByCanvas([0, band.top])[1] - rect.top;
        const bottom = this.graph.getClientByCanvas([0, band.bottom])[1] - rect.top;
        if (bottom < 0 || top > rect.height) continue;
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', 8); text.setAttribute('y', Math.max(15, top + 12));
        text.setAttribute('fill', '#849bbd'); text.setAttribute('font-size', '10');
        text.setAttribute('data-bom-level', band.level);
        text.textContent = 'BOM 第' + (band.level + 1) + '层 · ' + band.count;
        svg.appendChild(text);
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        for (const [k, v] of Object.entries({ x1: 6, x2: rect.width - 6, y1: bottom + 8, y2: bottom + 8, stroke: '#38527b', 'stroke-opacity': 0.35, 'stroke-dasharray': '3 7' })) line.setAttribute(k, v);
        svg.appendChild(line);
      }
      if (this.cluster === 'none') return;
      const groups = new Map();
      for (const n of this.nodes) for (const key of this._clusterKeys(n)) {
        const bucket = this._usePreset() ? JSON.stringify([key, n.level]) : key;
        if (!groups.has(bucket)) groups.set(bucket, { key, members: [] });
        groups.get(bucket).members.push(n);
      }
      const NS = 'http://www.w3.org/2000/svg', PAD = 26;
      for (const { key, members } of groups.values()) {
        const pts = [];
        for (const n of members) {
          try {
            const c = this.graph.getClientByCanvas(this.graph.getElementPosition(n.code));
            pts.push([c[0] - rect.left, c[1] - rect.top]);
          } catch { /* 节点尚未完成布局 */ }
        }
        if (!pts.length) continue;
        const color = hashColor(String(key));
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', hullPath(pts, PAD));
        path.setAttribute('fill', rgba(color, 0.09));
        path.setAttribute('stroke', rgba(color, 0.55));
        path.setAttribute('stroke-width', '1.5');
        path.setAttribute('stroke-dasharray', '5 4');
        path.setAttribute('data-cluster', String(key));
        path.setAttribute('data-members', members.map(m => m.code).join(','));
        svg.appendChild(path);
        // 组标签：凸包顶部外侧
        let site = null;
        if (this.cluster === 'site') for (const n of members) { site = (n.sites || []).find(s => (s.key || s.name) === key) || null; if (site) break; }
        const label = (site ? `${site.name || site.key}${site.code && site.name !== site.code ? ' (' + site.code + ')' : ''}` : String(key)) + ' · ' + members.length;
        let minY = Infinity, minX = Infinity, maxX = -Infinity; for (const [x, y] of pts) { minY = Math.min(minY, y); minX = Math.min(minX, x); maxX = Math.max(maxX, x); } const cx = (minX + maxX) / 2;
        const w = label.length * 7 + 14, lx = Math.max(4, Math.min(rect.width - w - 4, cx - w / 2)), ly = Math.max(2, minY - PAD - 24);
        const bg = document.createElementNS(NS, 'rect');
        bg.setAttribute('x', lx); bg.setAttribute('y', ly); bg.setAttribute('width', w); bg.setAttribute('height', 18); bg.setAttribute('rx', 4);
        bg.setAttribute('fill', 'rgba(9,15,30,.88)'); bg.setAttribute('stroke', rgba(color, 0.6));
        const text = document.createElementNS(NS, 'text');
        text.setAttribute('x', lx + 7); text.setAttribute('y', ly + 13);
        text.setAttribute('fill', '#eaf2ff'); text.setAttribute('font-size', '11'); text.setAttribute('font-weight', '600');
        text.textContent = label;
        svg.appendChild(bg); svg.appendChild(text);
      }
    }

    _edgeStyle(e) {
      let stroke = '#456489', width = 1.5;
      if (this.highlight === 'critical' && e.critical) { stroke = '#5eead4'; width = 3; }
      else if (this.highlight === 'risk' && e.risk) { stroke = '#fbbf24'; width = 3; }
      const dashed = e.kind && (e.kind.includes('跨产业') || e.kind === 'BOM');
      const style = { stroke, lineWidth: width, opacity: this.edgeOpacity, lineDash: dashed ? [4, 3] : undefined, endArrow: true };
      if (this.showRatio && e.qty != null) style.labelText = '×' + (Math.round(e.qty * 100) / 100);
      return style;
    }

    _buildData() {
      // LOD 语义缩放只在地图分层模式生效；力导向保持全量渲染。
      const lod = this._usePreset() ? this._lod : 'L3';
      if (lod === 'L0') return this._buildLod0();
      return this._buildFull(lod);
    }

    // 关键编码（在 L1/L2 档位仍显示标签）：选中 / 链路中心 / 跨多层归属 / 有风险
    _isKeyNode(n) {
      return n.code === this.selected || n.code === this.chainCode || !!n.multiLevel || (n.gap || 0) > 1e-8 || !!n.single;
    }

    _buildFull(lod) {
      const groups = new Map(), ids = new Set(this.nodes.map(n => n.code));
      const nodes = this.nodes.map((n) => {
        const key = this._clusterKey(n);
        let combo;
        if (key != null) {
          if (!groups.has(key)) {
            let id = '__forecast_cluster_' + groups.size;
            while (ids.has(id)) id += '_';
            ids.add(id);
            const site = this.cluster === 'site' ? n.sites?.[0] : null;
            const label = site ? `${site.name || site.key}${site.code && site.name !== site.code ? ' (' + site.code + ')' : ''}` : String(key);
            groups.set(key, { id, label, count: 0 });
          }
          const group = groups.get(key); group.count++; combo = group.id;
        }
        const style = this._nodeStyle(n);
        // L1 聚合层：节点缩小；L2 网络层：正常尺寸
        if (lod === 'L1') style.size = Math.max(10, Math.round((style.size || 24) * 0.55));
        // 标签分级：L3 全标签；L2/L1 仅关键编码显示标签
        if (lod !== 'L3' && !this._isKeyNode(n)) style.labelText = '';
        const preset = this._usePreset() ? this._presetPos(n) : null;
        if (preset) { style.x = preset[0]; style.y = preset[1]; }
        return { id: n.code, data: { ...n, ...(preset ? { x: preset[0], y: preset[1] } : {}) }, style, ...(combo ? { combo } : {}) };
      });
      // 边分级：L1 聚合层只保留关键边（关键路径 / 风险 / 当前链路 / 跨产业），避免连线淹没节点。
      // 边 id 保持原始索引（'__e'+i），便于状态回填时不引用未渲染边。
      // 若当前范围无任何关键边（如演示数据默认口径），降级为保留全部边但降低透明度，避免视图空无一物。
      let edgeIdx = this.edges.map((e, i) => i);
      let lod1Degrade = false;
      if (lod === 'L1') {
        const focus = this.chainCode ? this._chain(this.chainCode).edges : new Set();
        const filtered = edgeIdx.filter(i => { const e = this.edges[i]; return e.critical || e.risk || (this.chainCode && focus.has('__e' + i)) || (e.kind && (e.kind.includes('跨产业') || e.kind === 'BOM')); });
        if (filtered.length) edgeIdx = filtered; else lod1Degrade = true;
      }
      this._renderedEdgeIdx = edgeIdx;
      const edges = edgeIdx.map(i => { const e = this.edges[i]; const st = this._edgeStyle(e); if (lod1Degrade) st.opacity = Math.min(st.opacity || 0.8, 0.35); return { id: '__e' + i, source: e.source, target: e.target, data: { ...e }, style: st }; });
      const combos = [...groups.entries()].map(([key, g]) => ({ id: g.id, data: { key, count: g.count }, style: { labelText: `${g.label} · ${g.count}`, fill: hashColor(String(key)), stroke: hashColor(String(key)) } }));
      return { nodes, edges, combos };
    }

    // L0 战略层：把每个 (聚类组, BOM 层) 桶聚合成一个超节点（地图的"聚合块"），
    // 只叠加关键路径骨架，实现"缩小看全局关键路径、不渲染上万图元"。
    _buildLod0() {
      this._presetPos({ code: '__force__', level: 0 }); // 触发 preset 计算，填充 _buckets
      const ids = new Set();
      const criticalCodes = new Set(this.criticalPath || []);
      const riskCodes = new Set(this.edges.filter(e => e.risk).flatMap(e => [e.source, e.target]));
      const keyCodes = new Set([...criticalCodes, ...riskCodes]);
      // 桶间边：两个桶之间存在 BOM 边即连一条汇总边
      const bucketByCode = new Map();
      for (const b of this._buckets) for (const code of b.codes) bucketByCode.set(code, b);
      const bucketIdx = new Map(this._buckets.map((b, i) => [b.key + '\u0000' + b.level, i]));
      const edgeAgg = new Map();
      for (const e of this.edges) {
        const sb = bucketByCode.get(e.source), tb = bucketByCode.get(e.target);
        if (!sb || !tb || sb === tb) continue;
        const k = bucketIdx.get(sb.key + '\u0000' + sb.level) + '>' + bucketIdx.get(tb.key + '\u0000' + tb.level);
        const agg = edgeAgg.get(k) || { source: sb, target: tb, count: 0, critical: false, risk: false };
        agg.count++; agg.critical = agg.critical || !!e.critical; agg.risk = agg.risk || !!e.risk; edgeAgg.set(k, agg);
      }
      const nodes = [];
      for (const b of this._buckets) {
        const id = '__lod0_' + b.key.replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, '') + '_' + b.level;
        ids.add(id);
        const hasKey = b.codes.some(c => keyCodes.has(c));
        const size = Math.min(72, 22 + Math.round(Math.sqrt(b.count) * 4));
        nodes.push({
          id, data: { code: id, __bucket: b, __agg: true },
          style: {
            size, fill: hasKey ? '#4a6a8a' : '#2c3f55', stroke: hasKey ? '#5eead4' : '#456489', lineWidth: hasKey ? 2.5 : 1.5,
            x: b.cx, y: b.cy, labelText: `${b.key || '未分组'} · ${b.count}`, labelFill: '#cfe0f5', labelFontSize: 12, labelPlacement: 'center'
          }
        });
      }
      const edges = [...edgeAgg.values()].map((a, i) => ({
        id: '__lod0e' + i,
        source: '__lod0_' + a.source.key.replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, '') + '_' + a.source.level,
        target: '__lod0_' + a.target.key.replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, '') + '_' + a.target.level,
        data: { agg: true, count: a.count },
        style: { stroke: a.critical ? '#5eead4' : a.risk ? '#fbbf24' : '#3c5878', lineWidth: a.critical ? 3 : 1.5, opacity: a.critical || a.risk ? 0.95 : 0.5, endArrow: false, lineDash: a.critical ? undefined : [3, 4] }
      }));
      return { nodes, edges, combos: [] };
    }

    // 由当前缩放比例判定 LOD 档位
    _detectLod() {
      if (!this._usePreset() || !this.graph) return;
      let z;
      try { z = this.graph.getZoom(); } catch { return; }  // G6 初始化阶段的 aftertransform 可能尚未就绪
      const lod = z < 0.28 ? 'L0' : z < 0.6 ? 'L1' : z < 1.2 ? 'L2' : 'L3';
      if (lod !== this._lod) this._applyLod(lod);
    }

    // 切换 LOD：分档重建数据，但保留视口（zoom + 中心），避免"闪跳"。
    _applyLod(lod) {
      if (!this.graph) return;
      const prev = this._lod; this._lod = lod; this._lodPrev = prev;
      let zoom, center;
      try { zoom = this.graph.getZoom(); center = this.graph.getViewportCenter(); } catch { zoom = 1; center = undefined; }
      const revision = ++this._renderRevision;
      this._renderQueue = this._renderQueue.catch(() => {}).then(async () => {
        if (!this.graph || revision !== this._renderRevision) return;
        this.graph.setLayout({ type: 'preset' });
        this.graph.setData(this._buildData());
        await this.graph.render();
        if (this.graph && revision === this._renderRevision) {
          // 恢复视口（L0 聚合块世界坐标跨度与全量一致，无需 re-fit）
          this.graph.zoomTo(zoom, center);
          await this._applyStates();
        }
      });
      this.onLodChange(lod, this._lodLabel(lod));
    }

    _lodLabel(lod) {
      return { L0: '战略层 · 聚合块与关键路径', L1: '聚合层 · 关键编码与风险边', L2: '网络层 · 分级标签', L3: '编码层 · 全量详情' }[lod] || lod;
    }

    // 地图化：分层模式始终走分带 preset（不再有"节点 >800 才 preset"的硬阈值，
    // 否则力导向按钮在超过 800 节点时变成假开关）；力导向保持原语义。
    _usePreset() { return this.layoutMode === 'layered'; }

    _presetPos(n) {
      if (!this._presetMap) {
        // 地图化：布局尺寸由数据量决定，不再绑定容器尺寸（0,0 为占位，函数内部忽略）
        const plan = layered(this.nodes, this.edges, 0, 0, node => this._clusterKey(node));
        this._presetMap = plan.positions; this._regions = plan.regions; this._buckets = plan.buckets || [];
      }
      return this._presetMap.get(n.code) || [0, 0];
    }

    _adjacency(id) {
      const nodes = new Set([id]), edges = new Set();
      this.edges.forEach((e, i) => {
        if (e.source === id || e.target === id) { edges.add('__e' + i); nodes.add(e.source); nodes.add(e.target); }
      });
      return { nodes, edges };
    }

    // 节点的完整链路：沿边方向的上游闭包 + 下游闭包
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

    _applyHighlight() {
      const keep = new Set();
      if (this.highlight === 'critical') { for (const c of (this.criticalPath || [])) keep.add(c); }
      else { for (const e of this.edges) if (e.risk) { keep.add(e.source); keep.add(e.target); } }
      const states = {};
      for (const n of this.nodes) states[n.code] = this.highlight && keep.size && !keep.has(n.code) ? ['dim'] : [];
      (this._renderedEdgeIdx || this.edges.map((e, i) => i)).forEach(i => { states['__e' + i] = []; });
      return this.graph.setElementState(states);
    }

    // 统一计算节点/边状态：关键路径或风险路径高亮 > 单击链路
    _applyStates() {
      // L0 战略层为聚合块视图，节点/边为虚拟 id，不参与真实编码状态（骨架颜色已在 _buildLod0 表达）
      if (this._usePreset() && this._lod === 'L0') return Promise.resolve();
      if (this.highlight) {
        return this._applyHighlight();
      }
      let focus = null;
      if (this.chainCode) focus = this._chain(this.chainCode);
      const states = {};
      for (const n of this.nodes) states[n.code] = focus && !focus.nodes.has(n.code) ? ['dim'] : [];
      (this._renderedEdgeIdx || this.edges.map((e, i) => i)).forEach(i => { states['__e' + i] = focus ? (focus.edges.has('__e' + i) ? ['active'] : ['dim']) : []; });
      if (this.selected && states[this.selected] && !states[this.selected].includes('dim')) states[this.selected] = [...states[this.selected], 'selected'];
      return this.graph.setElementState(states);
    }

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
      this._presetMap = null;
      this._lod = 'L3';              // 换数据后从编码层开始，首次 fitView 后再按缩放自动降档
      this._didInitialFit = false;   // 换数据后重新 fitView 一次
      return this.render();
    }

    render() {
      const revision = ++this._renderRevision;
      this._renderQueue = this._renderQueue.catch(() => {}).then(async () => {
        if (!this.graph || revision !== this._renderRevision) return;
        this._presetMap = null;
        const preset = this._usePreset();
        const layout = preset ? { type: 'preset' } : this.cluster === 'none' ? { type: 'force' }
          : { type: 'combo-combined', comboPadding: 36, comboSpacing: 60, nodeSize: 50, nodeSpacing: 20,
              layout: comboId => comboId ? { type: 'concentric', preventOverlap: true } : { type: 'force', preventOverlap: true } };
        this.graph.setLayout(layout);
        this.graph.setData(this._buildData());
        await this.graph.render();
        if (this.graph && revision === this._renderRevision) {
          // 地图化：仅在首次（或换数据后）fitView 一次建立全局感，之后不再自动 fit，
          // 让用户平移 / 缩放时视口保持稳定。力导向与分层首次均需 fit。
          if (!this._didInitialFit) { await this.graph.fitView(); this._didInitialFit = true; if (preset) this._detectLod(); }
          await this._applyStates();
        }
      });
      return this._renderQueue;
    }

    setLayout(mode) { if (mode === this.layoutMode) return Promise.resolve(); this.layoutMode = mode; return this.render(); }
    setCluster(c) { this.cluster = c; return this.render(); }
    restyle(nodes = false, states = false) {
      // L0 聚合块视图不适用增量重绘（虚拟 id），退化为完整重建
      if (this._usePreset() && this._lod === 'L0') return this.render();
      this._renderQueue = this._renderQueue.catch(() => {}).then(async () => {
        if (!this.graph) return;
        if (nodes) this.graph.updateNodeData(this.nodes.map(n => ({ id: n.code, style: this._nodeStyle(n) })));
        else this.graph.updateEdgeData(this.edges.map((e, i) => ({ id: '__e' + i, style: { ...this._edgeStyle(e), labelText: this.showRatio && e.qty != null ? '×' + (Math.round(e.qty * 100) / 100) : '' } })));
        await this.graph.draw();
        if (this.graph && states) await this._applyStates();
      });
      return this._renderQueue;
    }
    setColorBy(c) { this.colorBy = c; return this.restyle(true); }
    setHighlight(kind) { this.highlight = kind; return this.restyle(false, true); }
    setEdgeOpacity(v) { this.edgeOpacity = Math.min(1, Math.max(0.05, Number(v) || 0.8)); return this.restyle(); }
    setShowRatio(v) { this.showRatio = !!v; return this.restyle(); }
    select(code) { this.selected = code; return this.render(); }
    fit() { this.graph.fitView(); }
    zoomIn() { this.graph.zoomBy(1.25); }
    zoomOut() { this.graph.zoomBy(0.8); }
    destroy() { clearTimeout(this._resizeTimer); this._renderRevision++; this._dragging = false; if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; } if (this._hullRaf) { cancelAnimationFrame(this._hullRaf); this._hullRaf = 0; } if (this.hullLayer) { this.hullLayer.remove(); this.hullLayer = null; } if (this.graph) { this.graph.destroy(); this.graph = null; } }
  }

  root.ForecastGraph = ForecastGraph;
})(typeof window !== 'undefined' ? window : this);
