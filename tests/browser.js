'use strict';
// Dependency-free browser integration tests through Chrome DevTools Protocol.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-output'); fs.mkdirSync(out, { recursive: true });
const suffix = Date.now(), appPort = Number(process.env.TEST_PORT || 8792), debugPort = Number(process.env.DEBUG_PORT || 9334);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const env = { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', DB_PATH: path.join(out, `browser-${suffix}.sqlite`), API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '' };
const app = spawn(process.execPath, ['server/main.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; app.stdout.on('data', b => logs += b); app.stderr.on('data', b => logs += b);
let chrome, ws, nextId = 1; const pending = new Map(), errors = [], checks = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, label, timeout = 30000) { const t = Date.now(); while (Date.now() - t < timeout) { try { if (await fn()) return; } catch {} await sleep(100); } throw Error('Timeout: ' + label); }
function cdp(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 10000); pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } }); ws.send(JSON.stringify({ id, method, params })); }); }
async function js(expression) { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ': ' + r.exceptionDetails.exception?.description); return r.result.value; }
async function click(selector) { await wait(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), selector); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function select(id, value) { await js(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)};document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change',{bubbles:true}))`); }
(async () => {
  console.log('Starting browser integration');
  await wait(async () => (await fetch(`http://127.0.0.1:${appPort}/api/health`, { signal: AbortSignal.timeout(1000) })).ok, 'server');
  console.log('Server ready');
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(out, 'chrome-' + suffix), 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', b => logs += b); chrome.on('error', e => logs += e.message);
  let targets; await wait(async () => { targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) })).json(); return targets.some(t => t.type === 'page'); }, 'chrome');
  console.log('Chrome ready');
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise((r, reject) => { const t = setTimeout(() => reject(Error('WebSocket open timeout')), 10000); ws.onopen = () => { clearTimeout(t); r(); }; ws.onerror = () => reject(Error('WebSocket connection failed')); });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${appPort}/` }); await wait(() => js(`document.body.innerText.includes('导入预测，开始')`), 'empty state'); checks.push('empty data state');
  await click('#go-data'); await wait(() => js(`!!document.getElementById('upload-files')`), 'data page');
  const workbook = Buffer.from(await (await fetch(`http://127.0.0.1:${appPort}/api/export?kind=sample`)).arrayBuffer()), filePath = path.join(out, 'browser-sample.xlsx'); fs.writeFileSync(filePath, workbook);
  const dom = await cdp('DOM.getDocument'); const input = await cdp('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '#upload-files' }); await cdp('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [filePath] });
  await wait(() => js(`document.querySelector('dialog[open]')?.innerText.includes('确认工作表')`), 'sheet preview'); await click('#modal-btn-0'); await wait(() => js(`document.querySelector('dialog[open]')?.innerText.includes('导入校验通过')`), 'validated preview'); await click('#modal-btn-0'); await wait(() => js(`!document.querySelector('dialog[open]') && document.body.innerText.includes('业务数据') && !document.body.hasAttribute('aria-busy')`), 'committed import'); checks.push('xlsx multi-sheet upload, preview and commit');
  await click('[data-tab="overview"]'); await wait(() => js(`document.querySelectorAll('#sc-graph canvas').length>0`), 'network chart');
  assert.equal(await js(`document.getElementById('tb-codes').textContent`), '4');
  await js(`document.getElementById('sc-code').value='A'`); await click('#apply'); await wait(() => js(`document.getElementById('sc-detail')?.innerText.includes('上层需求贡献')`), 'A detail');
  assert.ok(await js(`document.getElementById('sc-detail').innerText.includes('1,100')`)); checks.push('shared supplier detail and contributions');
  await select('sc-cluster', 'industry'); await sleep(400); await click('#hl-critical'); await sleep(400); await click('#hl-risk'); await sleep(400); checks.push('industry clustering and critical/risk highlights');
  await js(`document.getElementById('sc-code').value='B';document.getElementById('sc-role').value='demand'`); await click('#apply'); await wait(() => js(`document.getElementById('sc-detail')?.innerText.includes('整机B')`), 'demand perspective'); assert.ok(await js(`document.body.innerText.includes('800')`)); checks.push('demand perspective retains shared supplier global gap');
  await click('[data-tab="simulate"]'); await wait(() => js(`!!document.getElementById('sim-code-0')`), 'simulation'); await js(`document.getElementById('sim-code-0').value='A';document.getElementById('sim-value-0').value='20'`); await click('#sim-run'); await wait(() => js(`document.getElementById('sim-output')?.innerText.includes('推演结果')`), 'scenario result'); assert.ok(await js(`document.getElementById('sim-output').innerText.includes('-100')`)); await click('#view-scenario'); await wait(() => js(`!!document.getElementById('exit-scenario')`), 'scenario graph'); checks.push('20% forecast scenario and graph inspection');
  await click('#exit-scenario'); await wait(() => js(`!document.getElementById('exit-scenario')&&!!document.getElementById('sc-graph')`), 'baseline restored');
  await click('[data-tab="reports"]'); await wait(() => js(`document.querySelectorAll('#heatmap canvas').length>0`), 'report heatmap'); checks.push('site report and monthly heatmap');
  await click('[data-tab="config"]'); await wait(() => js(`!!document.getElementById('cfg-save')`), 'config'); await click('#cfg-save'); await wait(() => js(`!document.body.hasAttribute('aria-busy')`), 'config save'); checks.push('configuration transaction');
  await click('[data-tab="overview"]'); await wait(() => js(`!!document.querySelector('#sc-graph canvas')`), 'overview screenshot'); await sleep(600); const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(out, 'overview.png'), Buffer.from(shot.data, 'base64'));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await sleep(400); assert.ok(await js('document.documentElement.scrollWidth<=window.innerWidth+1')); const mobile = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'mobile.png'), Buffer.from(mobile.data, 'base64')); checks.push('mobile viewport without page overflow');
  await cdp('Page.reload'); await wait(() => js(`!!document.querySelector('#sc-graph canvas')`), 'persistent reload'); assert.equal(await js(`document.getElementById('tb-codes').textContent`), '4'); checks.push('persistent reload');
  assert.deepEqual(errors, []); fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify({ checks, errors }, null, 2)); console.log(JSON.stringify({ checks, errors }, null, 2));
})().catch(e => { console.error(e); console.error(logs); process.exitCode = 1; }).finally(() => { ws?.close(); chrome?.kill(); app.kill(); });
