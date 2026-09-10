/* Forecast graph renderer (AntV G6 v5). No DOM/storage coupling; consumes
 * {nodes, edges} from the server /api/graph response and manages layout,
 * clustering, coloring, path highlighting and node selection. */
(function (root) {
  'use strict';
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
      this._hover = null;
      this.ready = false;
      this.graph = null;
      this._renderQueue = Promise.resolve();
      this._renderRevision = 0;
      this._init();
    }

    _init() {
      const self = this;
      this.graph = new G6.Graph({
        container: this.el,
        autoFit: 'view',
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
            labelText: (d) => d.id,
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
      this.graph.on('aftertransform', () => this._scheduleHulls());
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
      // 容器尺寸变化（如右侧面板展开/收起）时同步画布与凸包，避免边界遮挡
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
        this._applyStates(this._hover === id ? id : null);
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
      this.graph.on('node:pointerenter', (evt) => {
        this._hover = evt.target.id;
        this._applyStates(this._hover);
      });
      this.graph.on('node:pointerleave', () => {
        this._hover = null;
        this._applyStates();
      });
      this.ready = true;
    }

    _node(id) { for (const n of this.nodes) if (n.code === id) return n; return null; }

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
      return { size, fill, stroke, lineWidth };
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
      if (this.cluster === 'none' || !this.graph || !this.nodes.length) return;
      const rect = this.el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      svg.setAttribute('width', rect.width); svg.setAttribute('height', rect.height);
      const groups = new Map();
      for (const n of this.nodes) for (const key of this._clusterKeys(n)) {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(n);
      }
      const NS = 'http://www.w3.org/2000/svg', PAD = 26;
      for (const [key, members] of groups) {
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
        const minY = Math.min(...pts.map(p => p[1])), cx = (Math.min(...pts.map(p => p[0])) + Math.max(...pts.map(p => p[0]))) / 2;
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
        const preset = this._usePreset() ? this._presetPos(n) : null;
        if (preset) { style.x = preset[0]; style.y = preset[1]; }
        return { id: n.code, data: { ...n, ...(preset ? { x: preset[0], y: preset[1] } : {}) }, style, ...(combo ? { combo } : {}) };
      });
      const edges = this.edges.map((e, i) => ({ id: '__e' + i, source: e.source, target: e.target, data: { ...e }, style: this._edgeStyle(e) }));
      const combos = [...groups.entries()].map(([key, g]) => ({ id: g.id, data: { key, count: g.count }, style: { labelText: `${g.label} · ${g.count}`, fill: hashColor(String(key)), stroke: hashColor(String(key)) } }));
      return { nodes, edges, combos };
    }

    // 分层纵向间距自适应：宽度受限时 autoFit 会按"最宽一层"缩小画布，静态 ranksep 在屏幕上被压扁。
    // 按最宽层估算缩放比（节点+标签约100px宽），反推让层级带在屏幕上占满约70%视口高度的 ranksep
    _adaptiveRanksep() {
      const counts = {};
      let max = 1;
      for (const n of this.nodes) { const l = Math.min(8, n.level || 0); counts[l] = (counts[l] || 0) + 1; if (counts[l] > max) max = counts[l]; }
      const zoom = Math.max(1, (max * 100) / (this.el.clientWidth || 1000));
      const levels = Math.max(1, Object.keys(counts).length - 1);
      return Math.round(Math.min(600, Math.max(130, (0.7 * (this.el.clientHeight || 700) * zoom) / levels)));
    }

    // 分层布局的降级策略：无聚类且节点超过阈值时 dagre 耗时不可接受，按 BOM 层级直接计算行位置（preset）
    _usePreset() { return this.layoutMode === 'layered' && this.cluster === 'none' && this.nodes.length > (this.presetThreshold || 300); }

    _presetPos(n) {
      if (!this._presetMap) {
        this._presetMap = new Map();
        const byLevel = new Map();
        for (const node of this.nodes) { const l = Math.min(8, node.level || 0); if (!byLevel.has(l)) byLevel.set(l, []); byLevel.get(l).push(node.code); }
        const perRow = 36; let y = 0;
        for (const [l, codes] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
          codes.forEach((c, i) => this._presetMap.set(c, [(i % perRow) * 52, y + Math.floor(i / perRow) * 56]));
          y += Math.ceil(codes.length / perRow) * 56 + 120;
        }
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
      const walk = (forward) => {
        const queue = [id];
        while (queue.length) {
          const c = queue.pop();
          this.edges.forEach((e, i) => {
            if ((forward ? e.source : e.target) !== c || edges.has('__e' + i)) return;
            edges.add('__e' + i);
            const next = forward ? e.target : e.source;
            if (!nodes.has(next)) { nodes.add(next); queue.push(next); }
          });
        }
      };
      walk(true); walk(false);
      return { nodes, edges };
    }

    _applyHighlight() {
      const keep = new Set();
      if (this.highlight === 'critical') { for (const c of (this.criticalPath || [])) keep.add(c); }
      else { for (const e of this.edges) if (e.risk) { keep.add(e.source); keep.add(e.target); } }
      const states = {};
      for (const n of this.nodes) states[n.code] = this.highlight && keep.size && !keep.has(n.code) ? ['dim'] : [];
      this.edges.forEach((e, i) => { states['__e' + i] = []; });
      return this.graph.setElementState(states);
    }

    // 统一计算节点/边状态：关键路径或风险路径高亮 > 单击链路 > 悬浮邻居
    _applyStates(hoverId) {
      if (this.highlight) {
        const p = this._applyHighlight();
        return hoverId ? p.then(() => this.graph && this.graph.setElementState({ [hoverId]: ['active'] })) : p;
      }
      let focus = null;
      if (this.chainCode) focus = this._chain(this.chainCode);
      if (hoverId) {
        const adj = this._adjacency(hoverId);
        if (focus) { adj.nodes.forEach(x => focus.nodes.add(x)); adj.edges.forEach(x => focus.edges.add(x)); }
        else focus = adj;
      }
      const states = {};
      for (const n of this.nodes) states[n.code] = focus && !focus.nodes.has(n.code) ? ['dim'] : [];
      this.edges.forEach((e, i) => { states['__e' + i] = focus ? (focus.edges.has('__e' + i) ? ['active'] : ['dim']) : []; });
      if (hoverId) states[hoverId] = ['active'];
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
      this.chainCode = '';
      this._hover = null;
      this._presetMap = null;
      return this.render();
    }

    render() {
      const revision = ++this._renderRevision;
      this._renderQueue = this._renderQueue.catch(() => {}).then(async () => {
        if (!this.graph || revision !== this._renderRevision) return;
        const layered = { type: 'dagre', rankdir: 'TB', nodesep: 40, ranksep: this._adaptiveRanksep() };
        const preset = this._usePreset(); // 节点多时 dagre 不可用，按 BOM 层级预计算列位置
        const layout = this.cluster === 'none'
          ? preset ? { type: 'preset' } : this.layoutMode === 'layered' ? layered : { type: 'force' }
          : { type: 'combo-combined', comboPadding: 36, comboSpacing: 60, nodeSize: 50, nodeSpacing: 20,
              layout: comboId => comboId ? this.layoutMode === 'layered' ? { type: 'dagre', rankdir: 'TB', nodesep: 40, ranksep: this._adaptiveRanksep() } : { type: 'concentric', preventOverlap: true } : preset ? { type: 'preset' } : this.layoutMode === 'layered' ? { type: 'force', preventOverlap: true } : { type: 'force', preventOverlap: true } };
        this.graph.setLayout(layout);
        this.graph.setData(this._buildData());
        await this.graph.render();
        if (this.graph && revision === this._renderRevision) {
          // 分层（纵向）视图：按宽度适配，允许垂直/水平拖拽查看，避免横向压缩把行距压扁
          if (this.layoutMode === 'layered') await this.graph.fitView({ direction: 'x', when: 'overflow' }).catch(() => this.graph.fitView());
          await this._applyStates();
        }
      });
      return this._renderQueue;
    }

    setLayout(mode) { if (mode === this.layoutMode) return Promise.resolve(); this.layoutMode = mode; return this.render(); }
    setCluster(c) { this.cluster = c; return this.render(); }
    setColorBy(c) { this.colorBy = c; return this.render(); }
    setHighlight(kind) { this.highlight = kind; return this.render(); }
    setEdgeOpacity(v) { this.edgeOpacity = Math.min(1, Math.max(0.05, Number(v) || 0.8)); return this.render(); }
    setShowRatio(v) { this.showRatio = !!v; return this.render(); }
    select(code) { this.selected = code; return this.render(); }
    fit() { this.graph.fitView(); }
    zoomIn() { this.graph.zoomBy(1.25); }
    zoomOut() { this.graph.zoomBy(0.8); }
    destroy() { this._renderRevision++; this._dragging = false; if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; } if (this._hullRaf) { cancelAnimationFrame(this._hullRaf); this._hullRaf = 0; } if (this.hullLayer) { this.hullLayer.remove(); this.hullLayer = null; } if (this.graph) { this.graph.destroy(); this.graph = null; } }
  }

  root.ForecastGraph = ForecastGraph;
})(typeof window !== 'undefined' ? window : this);
