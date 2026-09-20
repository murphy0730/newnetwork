'use strict';
const path = require('node:path'), fs = require('node:fs');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-output');
const suffix = Date.now(), appPort = 8811, debugPort = 9348;
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const env = { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', DB_PATH: path.join(out, `shot-${suffix}.sqlite`), IMPORT_DIR: path.join(out, `imp-${suffix}`), API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '' };
const app = spawn(process.execPath, ['server/main.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let chrome, ws, nextId = 1; const pending = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, label, timeout = 180000) { const t = Date.now(); while (Date.now() - t < timeout) { try { if (await fn()) return; } catch {} await sleep(100); } throw Error('Timeout: ' + label); }
function cdp(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function js(expression) { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
(async () => {
  await wait(async () => (await fetch('http://127.0.0.1:' + appPort + '/api/health')).ok, 'server');
  const initial = await (await fetch('http://127.0.0.1:' + appPort + '/api/sample-large', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseRevision: 0 }) })).json();
  await wait(async () => (await (await fetch('http://127.0.0.1:' + appPort + '/api/jobs/' + initial.jobId)).json()).status === 'completed', 'sample');
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(out, 'shot-chrome-' + suffix), 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let targets; await wait(async () => { targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json(); return targets.some(t => t.type === 'page'); }, 'Chrome');
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } } };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: 'http://127.0.0.1:' + appPort + '/' });
  await wait(() => js("!!document.querySelector('#graph-container canvas')"), 'overview');
  await js("document.querySelector('#seg-view [data-view=\"table\"]').click()");
  await wait(() => js("!!document.querySelector('#tbl-body tbody tr')"), 'table');
  await sleep(600);
  fs.writeFileSync(path.join(out, 'table-view.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  console.log('saved test-output/table-view.png');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { ws?.close(); chrome?.kill(); app.kill(); });
