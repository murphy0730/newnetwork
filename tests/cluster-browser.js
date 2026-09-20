'use strict';
// Dependency-free browser integration tests through Chrome DevTools Protocol.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-output'); fs.mkdirSync(out, { recursive: true });
const suffix = Date.now(), appPort = Number(process.env.TEST_PORT || 8793), debugPort = Number(process.env.DEBUG_PORT || 9335);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const env = { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', DB_PATH: path.join(out, `browser-${suffix}.sqlite`), API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '' };
const app = spawn(process.execPath, ['server/main.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; app.stdout.on('data', b => logs += b); app.stderr.on('data', b => logs += b);
let chrome, ws, nextId = 1; const pending = new Map(), errors = [], checks = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, label, timeout = 30000) { const t = Date.now(); while (Date.now() - t < timeout) { try { if (await fn()) return; } catch {} await sleep(100); } throw Error('Timeout: ' + label); }
function cdp(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 240000); pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } }); ws.send(JSON.stringify({ id, method, params })); }); }
async function js(expression) { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ': ' + r.exceptionDetails.exception?.description); return r.result.value; }
async function click(selector) { await wait(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), selector); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function select(id, value) { await js(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)};document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change',{bubbles:true}))`); }
(async () => {
  await wait(async () => (await fetch('http://127.0.0.1:' + appPort + '/api/health')).ok, 'server');
  const initial = await (await fetch('http://127.0.0.1:' + appPort + '/api/sample-large', {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify({baseRevision:0})})).json();
  await wait(async () => (await (await fetch('http://127.0.0.1:' + appPort + '/api/jobs/' + initial.jobId)).json()).status === 'completed', 'sample', 120000);
  chrome=spawn(chromePath,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port='+debugPort,'--user-data-dir='+path.join(out,'cluster-chrome-'+suffix),'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',b=>logs+=b);
  let targets; await wait(async()=>{targets=await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();return targets.some(t=>t.type==='page');},'Chrome');
  ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);};
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Emulation.setDeviceMetricsOverride',{width:1600,height:1100,deviceScaleFactor:1,mobile:false});
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:"let GraphClass; Object.defineProperty(window,'ForecastGraph',{configurable:true,get:()=>GraphClass,set:C=>{GraphClass=class extends C {constructor(...args){super(...args);window.__testGraph=this;}};}});"});
  await cdp('Page.navigate',{url:'http://127.0.0.1:'+appPort+'/'});
  await wait(()=>js("!!window.__testGraph?.nodes.length && !!document.querySelector('#graph-container canvas')"),'overview');
  await js('window.__testGraph._renderQueue');
  const nodeCount = await js('window.__testGraph.nodes.length'); // 万级示例按 limit 截取，含父项补齐
  assert.ok(nodeCount > 100);
  const positions = await js('window.__testGraph.graph.getNodeData().map(n=>[n.id,...window.__testGraph.graph.getElementPosition(n.id)])');
  for(const layout of ['force','layered']) {
    await click('[data-layout="'+layout+'"]'); await js('window.__testGraph._renderQueue');
    for(const mode of ['industry','category','site']) {
      await click('[data-cluster="'+mode+'"]'); await js('window.__testGraph._renderQueue');
      const result=await js("(()=>{const g=window.__testGraph,d=g.graph.getData();return {mode:g.cluster,combos:d.combos.map(c=>({id:c.id,label:c.style.labelText})),nodes:d.nodes.map(n=>({id:n.id,combo:n.combo,position:g.graph.getElementPosition(n.id)})),edges:d.edges.length};})()");
      assert.equal(result.mode,mode); assert.ok(result.combos.length>1); assert.equal(result.nodes.length,nodeCount); assert.ok(result.edges>0);
      assert.ok(result.nodes.every(n=>result.combos.some(c=>c.id===n.combo)&&n.position.every(Number.isFinite)));
      assert.ok(result.combos.every(c=>/\d+$/.test(c.label)));
      assert.ok(result.nodes.some(n=>{const old=positions.find(p=>p[0]===n.id);return Math.abs(old[1]-n.position[0])+Math.abs(old[2]-n.position[1])>10;}));
      checks.push(layout+' / '+mode+' => '+result.combos.length+' spatial groups');
      const shot=await cdp('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'cluster-'+layout+'-'+mode+'.png'),Buffer.from(shot.data,'base64'));
    }
  }
  await click('[data-color="risk"]');await js('window.__testGraph._renderQueue');
  assert.ok(await js("window.__testGraph.graph.getNodeData().filter(n=>n.data.gap>0).every(n=>window.__testGraph.graph.getElementRenderStyle(n.id).fill==='#e24b4a')"));checks.push('risk coloring remains independent of clustering');
  await click('[data-cluster="none"]');await js('window.__testGraph._renderQueue');
  assert.equal(await js('window.__testGraph.graph.getComboData().length'),0);checks.push('none removes groups');
  await js("for(const c of ['industry','category','site','none','industry'])document.querySelector('[data-cluster=\"'+c+'\"]').click(); window.__testGraph._renderQueue");
  assert.equal(await js('window.__testGraph.cluster'),'industry');assert.ok(await js('window.__testGraph.graph.getComboData().length>1'));checks.push('rapid switching settles on last selection');
  await click('#btn-hl-risk');await js('window.__testGraph._renderQueue');await click('#btn-hl-risk');await js('window.__testGraph._renderQueue');
  assert.ok(await js("window.__testGraph.graph.getNodeData().every(n=>!window.__testGraph.graph.getElementState(n.id).includes('dim'))"));checks.push('highlight reset clears dimmed nodes');
  const firstCode = await js('window.__testGraph.nodes[0].code');
  await js("window.__testGraph.graph.emit('node:click',{target:{id:" + JSON.stringify(firstCode) + "}})");
  await wait(()=>js("document.getElementById('detail-body')?.innerText.includes(" + JSON.stringify(firstCode) + ")"),'node detail');checks.push('node selection still opens business details');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'cluster-browser.json'),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors},null,2));
})().catch(e=>{console.error(e);console.error(logs.slice(-3000));process.exitCode=1;}).finally(()=>{ws?.close();chrome?.kill();app.kill();});
