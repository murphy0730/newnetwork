'use strict';
// UI 交互回归：右下角设置面板（连线透明度）、KPI 卡片过滤、悬浮/单击链路高亮、双击下钻、节点洞察面板。
// 通过 Chrome DevTools Protocol 驱动，无第三方依赖。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-output'); fs.mkdirSync(out, { recursive: true });
const suffix = Date.now(), appPort = Number(process.env.TEST_PORT || 8794), debugPort = Number(process.env.DEBUG_PORT || 9336);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const env = { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', DB_PATH: path.join(out, `ui-${suffix}.sqlite`), API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '' };
const app = spawn(process.execPath, ['server/main.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; app.stdout.on('data', b => logs += b); app.stderr.on('data', b => logs += b);
let chrome, ws, nextId = 1; const pending = new Map(), errors = [], checks = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, label, timeout = 30000) { const t = Date.now(); while (Date.now() - t < timeout) { try { if (await fn()) return; } catch {} await sleep(100); } throw Error('Timeout: ' + label); }
function cdp(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 60000); pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } }); ws.send(JSON.stringify({ id, method, params })); }); }
async function js(expression) { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ': ' + r.exceptionDetails.exception?.description); return r.result.value; }
async function click(selector) { await wait(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), selector); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); }
(async () => {
  await wait(async () => (await fetch('http://127.0.0.1:' + appPort + '/api/health')).ok, 'server');
  const initial = await (await fetch('http://127.0.0.1:' + appPort + '/api/sample-large', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseRevision: 0 }) })).json();
  await wait(async () => (await (await fetch('http://127.0.0.1:' + appPort + '/api/jobs/' + initial.jobId)).json()).status === 'completed', 'sample', 120000);
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(out, 'ui-chrome-' + suffix), 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', b => logs += b);
  let targets; await wait(async () => { targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json(); return targets.some(t => t.type === 'page'); }, 'Chrome');
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "let GraphClass; Object.defineProperty(window,'ForecastGraph',{configurable:true,get:()=>GraphClass,set:C=>{GraphClass=class extends C {constructor(...args){super(...args);window.__testGraph=this;} setData(...a){window.__graphRev=(window.__graphRev||0)+1;return super.setData(...a);}};}});" });
  await cdp('Page.navigate', { url: 'http://127.0.0.1:' + appPort + '/' });
  await wait(() => js("!!window.__testGraph?.nodes.length && !!document.querySelector('#graph-container canvas')"), 'overview');
  await js('window.__testGraph._renderQueue');
  const total = await js('window.__testGraph.nodes.length');
  const N0 = await js('window.__testGraph.nodes[0].code');

  // 1. 右下角设置按钮与连线透明度滑块
  await click('#btn-graph-settings');
  assert.ok(await js("document.getElementById('g-settings-panel').classList.contains('show')")); checks.push('settings button opens panel');
  await js("const s=document.getElementById('gs-edge-opacity');s.value='30';s.dispatchEvent(new Event('input',{bubbles:true}))");
  await js('window.__testGraph._renderQueue');
  assert.equal(await js('window.__testGraph.edgeOpacity'), 0.3);
  assert.ok(await js("Math.abs(window.__testGraph.graph.getElementRenderStyle('__e0').opacity-0.3)<1e-6")); checks.push('edge opacity slider applies to rendered edges');
  await js("const k=document.getElementById('gs-kpi-show');k.checked=false;k.dispatchEvent(new Event('change',{bubbles:true}))");
  assert.ok(await js("document.getElementById('kpi-grid').classList.contains('hidden')")); checks.push('kpi strip toggle');
  await js("const k2=document.getElementById('gs-kpi-show');k2.checked=true;k2.dispatchEvent(new Event('change',{bubbles:true}))");
  await click('#btn-gs-close');
  assert.ok(await js("!document.getElementById('g-settings-panel').classList.contains('show')")); checks.push('settings panel closes');

  // 2. KPI 卡片点击过滤节点
  const revA = await js('window.__graphRev||0');
  await click('.kpi[data-key="shortage"]');
  await wait(() => js("window.__graphRev>"+revA+" && !!document.querySelector('.kpi[data-key=shortage].active') && window.__testGraph.nodes.length>0 && window.__testGraph.nodes.every(n=>(n.gap||0)>1e-8)"), 'kpi filter');
  checks.push('kpi card filters graph to shortage nodes only');
  const revB = await js('window.__graphRev');
  await click('.kpi[data-key="coverageShortage"]');
  await wait(() => js("window.__graphRev>"+revB+" && !!document.querySelector('.kpi[data-key=coverageShortage].active') && !document.querySelector('.kpi[data-key=shortage].active') && window.__testGraph.nodes.length>0 && window.__testGraph.nodes.every(n=>(n.coverageGap||0)>1e-8)"), 'coverage filter');
  checks.push('kpi coverage filter switches');
  const revC = await js('window.__graphRev');
  await click('.kpi[data-key="coverageShortage"]');
  await wait(() => js("window.__graphRev>"+revC+" && !document.querySelector('.kpi.active') && window.__testGraph.nodes.length==="+total), 'kpi filter cleared'); checks.push('clicking active kpi card clears filter');

  // 3. 悬浮高亮相邻链路
  await js("window.__testGraph.graph.emit('node:pointerenter',{target:{id:" + JSON.stringify(N0) + "}})");
  assert.ok(await js("window.__testGraph.graph.getNodeData().some(n=>window.__testGraph.graph.getElementState(n.id).includes('dim'))")); checks.push('hover dims non-adjacent nodes');
  await js("window.__testGraph.graph.emit('node:pointerleave',{target:{id:" + JSON.stringify(N0) + "}})");
  assert.ok(await js("window.__testGraph.graph.getNodeData().every(n=>!window.__testGraph.graph.getElementState(n.id).includes('dim'))")); checks.push('hover leave restores');

  // 4. 单击：锁定链路 + 右侧洞察，不下钻
  await js("window.__testGraph.graph.emit('node:click',{target:{id:" + JSON.stringify(N0) + "}})");
  await wait(() => js("document.getElementById('detail-body')?.innerText.includes(" + JSON.stringify(N0) + ")"), 'click insight');
  assert.equal(await js('window.__testGraph.nodes.length'), total);
  assert.ok(await js("window.__testGraph.chainCode===" + JSON.stringify(N0) + " && window.__testGraph.graph.getNodeData().some(n=>window.__testGraph.graph.getElementState(n.id).includes('dim'))"));
  assert.ok(await js("!document.getElementById('ov-root').classList.contains('d-off')")); checks.push('single click locks chain and opens insight without drilling');
  assert.ok(await js("!!document.querySelector('#detail-body .dt-hero') && !!document.querySelector('#detail-body .dt-metrics') && !!document.querySelector('#detail-body .dt-block')")); checks.push('insight panel uses dt-* card structure');
  await wait(() => js("document.getElementById('insight-body')?.innerText.includes('业务洞察')"), 'insight render');
  assert.ok(await js("!!document.querySelector('#insight-body .ins-card .ins-headline') && !!document.querySelector('#insight-body .ins-status') && document.getElementById('insight-body').innerText.includes('规则生成')")); checks.push('insight card renders status headline and generator label');

  // 5. 双击：下钻到编码链路并显示洞察
  await js("window.__testGraph.graph.emit('node:dblclick',{target:{id:" + JSON.stringify(N0) + "}})");
  await wait(() => js("window.__testGraph.nodes.length>0 && window.__testGraph.nodes.length<"+total+" && window.__testGraph.nodes.some(n=>n.code==="+JSON.stringify(N0)+")"), 'dblclick drill');
  await wait(() => js("document.getElementById('detail-body')?.innerText.includes(" + JSON.stringify(N0) + ")"), 'drill insight'); checks.push('double click drills into code chain with insight');

  // 6. 聚类不规则凸包边框（SVG overlay，虚线半透明 + 顶部标签）
  await js("document.getElementById('btn-showall')?.click()"); await wait(() => js("window.__testGraph.nodes.length==="+total), 'show all');
  await click('[data-cluster="industry"]'); await js('window.__testGraph._renderQueue');
  await wait(() => js("document.querySelectorAll('#graph-container .cluster-hull-layer path[data-cluster]').length>1"), 'hulls');
  const hull = await js("(()=>{const p=document.querySelector('#graph-container .cluster-hull-layer path[data-cluster]');return {dash:p.getAttribute('stroke-dasharray'),d:p.getAttribute('d'),labels:document.querySelectorAll('#graph-container .cluster-hull-layer text').length};})()");
  assert.ok(hull.dash === '5 4' && hull.d.startsWith('M') && hull.d.includes('C') && hull.labels > 1); checks.push('cluster hull irregular dashed border with labels');

  // 7. 加工地聚类：多加工地编码同时出现在多个凸包组
  await click('[data-cluster="site"]'); await js('window.__testGraph._renderQueue');
  await wait(() => js("document.querySelectorAll('#graph-container .cluster-hull-layer path[data-cluster]').length>1"), 'site hulls');
  const multi = await js("(()=>{const g=window.__testGraph;const n=g.nodes.find(x=>(x.sites||[]).length>1);if(!n)return null;const paths=[...document.querySelectorAll('#graph-container .cluster-hull-layer path[data-cluster]')].filter(p=>(p.getAttribute('data-members')||'').split(',').includes(n.code));return {code:n.code,sites:n.sites.length,groups:paths.length};})()");
  assert.ok(multi && multi.sites > 1 && multi.groups >= 2); checks.push('multi-site code ' + multi.code + ' in ' + multi.groups + ' site hulls');

  // 8. 缩放后凸包跟随视口
  const hullBefore = await js("document.querySelector('#graph-container .cluster-hull-layer path').getAttribute('d')");
  await js('window.__testGraph.zoomIn()'); await sleep(500);
  const hullAfter = await js("document.querySelector('#graph-container .cluster-hull-layer path').getAttribute('d')");
  assert.notEqual(hullBefore, hullAfter); checks.push('hulls follow viewport transform');

  // 9. 配比关系标签：≥100 节点默认关闭，手动开启后边上展示 ×配比
  assert.equal(await js('window.__testGraph.showRatio'), false);
  await js("document.getElementById('btn-graph-settings').click()");
  await js("const r=document.getElementById('gs-ratio');r.checked=true;r.dispatchEvent(new Event('change',{bubbles:true}))");
  await js('window.__testGraph._renderQueue');
  const ratioLabel = await js("window.__testGraph.graph.getElementRenderStyle('__e0').labelText");
  assert.ok(typeof ratioLabel === 'string' && ratioLabel.startsWith('×')); checks.push('edge ratio labels when enabled (' + ratioLabel + ')');

  // 10. 展开深度设置按钮
  await js("document.querySelector('#gs-depth [data-depth=\"5\"]').click()");
  assert.ok(await js("document.querySelector('#gs-depth [data-depth=\"5\"]').classList.contains('active')")); checks.push('depth setting buttons');

  // 11. 关系口径移到工具栏，点击切换
  await js("document.querySelector('#seg-mode [data-mode=\"direct\"]').click()");
  await wait(() => js("document.querySelector('#seg-mode [data-mode=\"direct\"]').classList.contains('active') && !!document.querySelector('#graph-container canvas') && !!window.__testGraph.nodes.length"), 'mode switch');
  assert.ok(await js("!document.getElementById('sc-mode')")); checks.push('mode segment in toolbar switches relation scope');

  // 12. 推演页后台准备状态
  await click('[data-tab="simulate"]');
  await wait(() => js("!!document.getElementById('sim-prep') && document.getElementById('sim-prep').textContent.length>0"), 'sim prep status');
  await wait(() => js("document.getElementById('sim-prep').textContent==='推演已就绪'"), 'sim ready', 120000); checks.push('scenario prepare reaches ready state');

  const shot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'ui-overview.png'), Buffer.from(shot.data, 'base64'));
  assert.deepEqual(errors, []); fs.writeFileSync(path.join(out, 'ui-browser.json'), JSON.stringify({ checks, errors }, null, 2)); console.log(JSON.stringify({ checks, errors }, null, 2));
})().catch(e => { console.error(e); console.error(logs.slice(-3000)); process.exitCode = 1; }).finally(() => { ws?.close(); chrome?.kill(); app.kill(); });
