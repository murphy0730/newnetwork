'use strict';
// 地图模式浏览器回归（统一世界坐标版）：自动进地图、块信息卡、滚轮阈值换档、指针就近聚焦、
// 点击下钻居中、面包屑无残留、列标题直达 C、屏幕尺寸标签、切回经典、独立页无 CSP 报错。
// 通过 Chrome DevTools Protocol 驱动。运行：node tests/map-browser.js
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-output'); fs.mkdirSync(out, { recursive: true });
const suffix = Date.now(), appPort = Number(process.env.TEST_PORT || 8798), debugPort = Number(process.env.DEBUG_PORT || 9340);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const env = { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', DB_PATH: path.join(out, `map-${suffix}.sqlite`), API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '' };
const app = spawn(process.execPath, ['server/main.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; app.stdout.on('data', b => logs += b); app.stderr.on('data', b => logs += b);
let chrome, ws, nextId = 1; const pending = new Map(), errors = [], checks = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, label, timeout = 30000) { const t = Date.now(); while (Date.now() - t < timeout) { try { if (await fn()) return; } catch {} await sleep(100); } throw Error('Timeout: ' + label); }
function cdp(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 240000); pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } }); ws.send(JSON.stringify({ id, method, params })); }); }
async function js(expression) { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ': ' + r.exceptionDetails.exception?.description); return r.result.value; }
async function click(selector) { await wait(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), selector); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function shot(name) { const s = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); }
const zoomIn = n => js(`(async()=>{for(let i=0;i<${n};i++)await window.__testMap.zoomIn();})()`);
const zoomOut = n => js(`(async()=>{for(let i=0;i<${n};i++)await window.__testMap.zoomOut();})()`);
(async () => {
  await wait(async () => (await fetch('http://127.0.0.1:' + appPort + '/api/health')).ok, 'server');
  const initial = await (await fetch('http://127.0.0.1:' + appPort + '/api/sample-large', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseRevision: 0 }) })).json();
  await wait(async () => (await (await fetch('http://127.0.0.1:' + appPort + '/api/jobs/' + initial.jobId)).json()).status === 'completed', 'sample', 120000);
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(out, 'map-chrome-' + suffix), 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', b => logs += b);
  let targets; await wait(async () => { targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json(); return targets.some(t => t.type === 'page'); }, 'Chrome');
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "let MC; Object.defineProperty(window,'ForecastGraphMap',{configurable:true,get:()=>MC,set:C=>{MC=class extends C{constructor(...a){super(...a);window.__testMap=this;}};}}); let KC; Object.defineProperty(window,'ForecastGraph',{configurable:true,get:()=>KC,set:C=>{KC=class extends C{constructor(...a){super(...a);window.__testGraph=this;}};}});" });

  // ---- 1. 主页面：千级编码自动进地图，A 档 = 块信息卡 ----
  await cdp('Page.navigate', { url: 'http://127.0.0.1:' + appPort + '/' });
  await wait(() => js("!!window.__testMap && !!document.querySelector('#graph-container canvas')"), 'map overview');
  await js('window.__testMap._renderQueue'); await sleep(400);
  assert.ok(await js("document.querySelector('#seg-layout [data-layout=\"map\"]').classList.contains('active')")); checks.push('large data auto-switches to map layout');
  assert.equal(await js('window.__testMap._level'), 'A'); checks.push('starts at cluster level A');
  const a = await js("(()=>{const g=window.__testMap,d=g.graph.getData();return {blocks:d.nodes.filter(n=>String(n.id).startsWith('__blk_')).length,badges:d.nodes.filter(n=>String(n.id).startsWith('__bdg_')).length,bars:d.nodes.filter(n=>String(n.id).startsWith('__barf_')).length,structs:d.nodes.filter(n=>String(n.id).startsWith('__str_')).length,edges:d.edges.length,total:g.nodes.length};})()");
  assert.ok(a.blocks > 3 && a.blocks < 60 && a.total > 800); checks.push('A renders ' + a.blocks + ' blocks over ' + a.total + ' codes');
  assert.ok(a.badges > 0 && a.bars > 0 && a.structs > 0); checks.push('block info card: ' + a.badges + ' risk badges + ' + a.bars + ' ratio bars + ' + a.structs + ' structure lines');
  assert.ok(a.edges <= 26); checks.push('A flows capped at ' + a.edges);
  assert.ok(await js("document.getElementById('g-legend').textContent.includes('风险徽标')")); checks.push('legend explains block instruments at L0');
  // 屏幕尺寸标签：任何缩放下当前档标签 ≥11px
  const fs0 = await js("(()=>{const g=window.__testMap,z=g.graph.getZoom();const st=g.graph.getElementRenderStyle([...g._blkIds.values()][0]);return st.labelFontSize*z;})()");
  assert.ok(fs0 >= 10.5 && fs0 <= 20, 'label px=' + fs0); checks.push('screen-space label compensation: ' + fs0.toFixed(1) + 'px at fit');
  await shot('map-v2-A-' + suffix);

  // ---- 2. 滚轮只缩放不换档；点击块下钻 B（聚焦展开 + 视口居中）----
  await zoomIn(6); await sleep(400);
  assert.equal(await js('window.__testMap._level'), 'A'); checks.push('wheel zoom never switches level (still A after 6 ticks)');
  const fs1 = await js("(()=>{const g=window.__testMap,z=g.graph.getZoom();const st=g.graph.getElementRenderStyle([...g._blkIds.values()][0]);return st.labelFontSize*z;})()");
  assert.ok(fs1 >= 10.5 && fs1 <= 20, 'label px=' + fs1); checks.push('labels stay readable while zooming: ' + fs1.toFixed(1) + 'px');
  await zoomOut(6); await sleep(400);
  const clickTarget = await js("(()=>{const g=window.__testMap;const key=g._world().blocks[0].key;const id=g._blkIds.get(key);g.graph.emit('node:click',{target:{id}});return key;})()");
  await wait(() => js("window.__testMap._level==='B' && window.__testMap._focus?.block===" + JSON.stringify(clickTarget)), 'click drill B'); await js('window.__testMap._renderQueue'); await sleep(500);
  const centered = await js("(()=>{const g=window.__testMap;const a=g._world().pos.get(g._focus.block);const c=g.graph.getClientByCanvas([a.cx,a.cy]);const r=g.el.getBoundingClientRect();return {dx:Math.abs(c[0]-(r.left+r.width/2)),dy:Math.abs(c[1]-(r.top+r.height/2))};})()");
  assert.ok(centered.dx < 200 && centered.dy < 200, JSON.stringify(centered)); checks.push('click drill centers viewport on block (dx=' + Math.round(centered.dx) + ' dy=' + Math.round(centered.dy) + ')');
  const b = await js("(()=>{const g=window.__testMap,d=g.graph.getData();return {focus:g._focus?.block,subs:d.nodes.filter(n=>String(n.id).startsWith('__sub_')).length,heads:d.nodes.filter(n=>String(n.id).startsWith('__head_')).length,ctx:d.nodes.filter(n=>String(n.id).startsWith('__ctx_')).length};})()");
  assert.ok(b.focus && b.subs > 0 && b.heads === 1 && b.ctx > 0); checks.push('B: focused expansion of 「' + b.focus + '」 with ' + b.subs + ' layer blocks + ' + b.ctx + ' context chips');
  // 世界不动：B 档焦点块锚点 == A 档位置
  const anchored = await js("(()=>{const g=window.__testMap;const w=g._world();const a=w.pos.get(g._focus.block);const t=g.graph.getElementPosition('__head_0');return Math.abs(a.cx-t[0])<g._world().width*0.2;})()");
  assert.ok(anchored); checks.push('unified world: focused column stays at its A-level anchor');
  // B 档滚轮同样不换档
  await zoomIn(5); await sleep(400);
  assert.equal(await js('window.__testMap._level'), 'B'); checks.push('wheel zoom in B only zooms, never jumps to C');
  await js('window.__testMap.fit()'); await sleep(300);
  await shot('map-v3-B-' + suffix);

  // ---- 3. 点击子块/列标题直达 C（B2）----
  await js("window.__testMap.graph.emit('node:click',{target:{id:'__sub_0'}})");
  await wait(() => js("window.__testMap._level==='C'"), 'sub to C'); await js('window.__testMap._renderQueue'); await sleep(500);
  const c = await js("(()=>{const g=window.__testMap,d=g.graph.getData();return {codes:g._renderedCodes.length,edges:d.edges.length,ctx:d.nodes.filter(n=>String(n.id).startsWith('__ctx_')).length,focusLevel:g._focus?.level};})()");
  assert.ok(c.codes > 0 && c.codes <= 120); checks.push('C via sub-block click: ' + c.codes + ' codes, level ' + c.focusLevel + ' focused');
  const fsC = await js("(()=>{const g=window.__testMap,z=g.graph.getZoom();const id=g._renderedCodes.find(c=>g.graph.getElementRenderStyle(c).labelText);if(!id)return 12;const st=g.graph.getElementRenderStyle(id);return st.labelText?st.labelFontSize*z:12;})()");
  assert.ok(fsC >= 9); checks.push('C labels readable: ' + Number(fsC).toFixed(1) + 'px');
  await shot('map-v3-C-' + suffix);
  // C 档点击参照色块切换焦点
  const ctxKey = await js("(()=>{const g=window.__testMap;const [id,v]=[...g._ctxRev.entries()][0];g.graph.emit('node:click',{target:{id}});return v.key;})()");
  await wait(() => js("window.__testMap._focus?.block===" + JSON.stringify(ctxKey) + " && window.__testMap._level==='C'"), 'ctx switch'); checks.push('context chip switches C focus to 「' + ctxKey + '」');
  // 编码点击开洞察
  const code = await js('window.__testMap._renderedCodes[0]');
  await js("window.__testMap.graph.emit('node:click',{target:{id:" + JSON.stringify(code) + "}})");
  await wait(() => js("document.getElementById('detail-body')?.innerText.includes(" + JSON.stringify(code) + ")"), 'code detail'); checks.push('code click opens business insight panel');

  // ---- 4. 面包屑逐级返回：C → 块(B) → 全部(A 世界全览)，无残留 ----
  await js("document.querySelector('.map-crumb [data-crumb=\"block\"]').click()");
  await wait(() => js("window.__testMap._level==='B'"), 'crumb to B'); checks.push('breadcrumb C → B keeps block focus');
  await js("document.querySelector('.map-crumb [data-crumb=\"root\"]').click()");
  await wait(() => js("window.__testMap._level==='A' && !window.__testMap._focus"), 'crumb root');
  await js('window.__testMap._renderQueue'); await sleep(400);
  const fitRatio = await js('window.__testMap._ratioOf()');
  assert.ok(Math.abs(fitRatio - 1) < 0.15, 'ratio=' + fitRatio); checks.push('crumb root refits world (ratio ' + fitRatio.toFixed(2) + ')');
  assert.ok(await js("document.querySelector('.map-crumb .mch.cur')?.textContent === '全部'")); checks.push('breadcrumb shows 全部 without residue');

  // ---- 5. 风险优先聚焦 + 画像档位映射（B3）----
  await js("window.__testMap.showLevel('C')"); await js('window.__testMap._renderQueue'); await sleep(400);
  const riskFirst = await js("(()=>{const g=window.__testMap;const blocks=g._world().blocks;const top=blocks.slice().sort((x,y)=>y.riskCount-x.riskCount||y.count-x.count)[0];return {focus:g._focus?.block,expect:top.key};})()");
  assert.equal(riskFirst.focus, riskFirst.expect); checks.push('risk-first auto focus: 「' + riskFirst.focus + '」');
  // 箭头方向与配比格式在地图模式同样生效
  await js("document.querySelector('#gs-direction [data-dir=\"bottom-up\"]').click()"); await js('window.__testMap._renderQueue');
  const rev = await js("(()=>{const g=window.__testMap;const e=g.graph.getEdgeData().find(x=>String(x.id).startsWith('__e'));const idx=Number(String(e.id).slice(3));const orig=g.edges[idx];return {source:e.source,target:e.target,expectSource:orig.target,expectTarget:orig.source};})()");
  assert.equal(rev.source, rev.expectSource); assert.equal(rev.target, rev.expectTarget); checks.push('map arrow direction bottom-up reverses edges');
  await js("document.querySelector('#gs-direction [data-dir=\"top-down\"]').click()");
  await js("const r=document.getElementById('gs-ratio');r.checked=true;r.dispatchEvent(new Event('change',{bubbles:true}))");
  await js("document.querySelector('#gs-ratio-style [data-ratio-style=\"ratio\"]').click()"); await js('window.__testMap._renderQueue');
  const ml = await js("(()=>{const g=window.__testMap;const e=g.graph.getEdgeData().find(x=>String(x.id).startsWith('__e'));return g.graph.getElementRenderStyle(e.id).labelText;})()");
  assert.ok(typeof ml === 'string' && ml.startsWith('1:')); checks.push('map ratio style 1:N configurable (' + ml + ')');
  await js("document.querySelector('#seg-persona [data-persona=\"executive\"]')?.click()"); await sleep(600);
  await wait(() => js("window.__testMap._level==='A'"), 'persona A'); checks.push('persona executive → level A');
  await js("document.querySelector('#seg-persona [data-persona=\"planner\"]')?.click()"); await sleep(600);
  await wait(() => js("window.__testMap._level==='C'"), 'persona C'); checks.push('persona planner → level C');
  await shot('map-v3-C-persona-' + suffix);

  // ---- 8. 布局联动：切经典全量回归 → 切回地图恢复离开时的档位/焦点 → 经典双击编码居中 → 地图聚焦其块 ----
  await click('[data-layout="layered"]');
  await wait(() => js("!!window.__testGraph && window.__testGraph.nodes.length > 800 && !!document.querySelector('#graph-container canvas')"), 'classic layered');
  await js('window.__testGraph._renderQueue');
  const classic = await js("(()=>{const d=window.__testGraph.graph.getData();return {nodes:d.nodes.length,total:window.__testGraph.nodes.length};})()");
  assert.equal(classic.nodes, classic.total); checks.push('classic layered renders full graph (' + classic.nodes + ' codes)');
  // 切回地图：恢复画像阶段保存的档位 C + 焦点块（选中编码为空时）
  await click('[data-layout="map"]');
  await wait(() => js("!!window.__testMap.graph && window.__testMap._level==='C' && !!window.__testMap._focus"), 'map restored'); checks.push('linkage: map restores saved level C + focus block after round-trip');
  // 经典视图双击编码 → 重建后视口居中到该编码
  await click('[data-layout="layered"]');
  await wait(() => js("!!window.__testGraph?.graph && window.__testGraph.nodes.length > 0 && !!document.querySelector('#graph-container canvas')"), 'classic again'); await js('window.__testGraph._renderQueue');
  const classicCode = await js("window.__testGraph.nodes[0].code");
  await js("window.__testGraph.graph.emit('node:dblclick',{target:{id:" + JSON.stringify(classicCode) + "}})");
  await wait(() => js("!!window.__testGraph && window.__testGraph.selected===" + JSON.stringify(classicCode)), 'classic select');
  // focusNode 延后到 ResizeObserver 重排之后执行，轮询等居中收敛
  await wait(() => js("(()=>{const g=window.__testGraph;if(!g?.graph)return false;try{const c=g.graph.getClientByCanvas(g.graph.getElementPosition(" + JSON.stringify(classicCode) + "));const r=g.el.getBoundingClientRect();return Math.abs(c[0]-(r.left+r.width/2))<8 && Math.abs(c[1]-(r.top+r.height/2))<8;}catch(e){return false;}})()"), 'focus centered', 10000);
  checks.push('linkage: classic centers viewport on drilled code (focusNode after resize-relayout)');
  // 再切回地图：选中编码的邻域子集（≤120）直接全量 C 档并高亮选中
  await click('[data-layout="map"]');
  await wait(() => js("!!window.__testMap.graph && window.__testMap._level==='C' && window.__testMap.selected===" + JSON.stringify(classicCode)), 'map focus from code');
  checks.push('linkage: map shows selected code ' + classicCode + ' at level C after classic drill');

  // ---- 9. 独立地图页：无白屏、无 CSP 报错（B5）----
  await cdp('Page.navigate', { url: 'http://127.0.0.1:' + appPort + '/index.map.html' });
  await wait(() => js("typeof window.ForecastGraphMap==='function' && !!document.querySelector('#graph-container canvas')"), 'standalone map page');
  await wait(() => js("!!window.__testMap && window.__testMap.nodes.length > 800"), 'standalone data');
  await js('window.__testMap._renderQueue'); await sleep(300);
  checks.push('standalone /index.map.html boots cleanly');
  await shot('map-v2-standalone-' + suffix);
  assert.deepEqual(errors, []); fs.writeFileSync(path.join(out, 'map-browser.json'), JSON.stringify({ checks, errors }, null, 2)); console.log(JSON.stringify({ checks, errors }, null, 2));
})().catch(e => { console.error(e); console.error(logs.slice(-3000)); process.exitCode = 1; }).finally(() => { ws?.close(); chrome?.kill(); app.kill(); });
