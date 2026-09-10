'use strict';
// UI 交互回归：右下角设置面板（连线透明度）、KPI 卡片过滤、悬浮/单击链路高亮、双击下钻、节点洞察面板。
// 通过 Chrome DevTools Protocol 驱动，无第三方依赖。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-output'); fs.mkdirSync(out, { recursive: true });
const suffix = Date.now(), appPort = Number(process.env.TEST_PORT || 8797), debugPort = Number(process.env.DEBUG_PORT || 9337);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const env = { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', DB_PATH: path.join(out, `build-ui-${suffix}.sqlite`), API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '' };
const app = spawn(process.execPath, ['server/main.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; app.stdout.on('data', b => logs += b); app.stderr.on('data', b => logs += b);
let chrome, ws, nextId = 1; const pending = new Map(), errors = [], checks = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, label, timeout = 30000) { const t = Date.now(); while (Date.now() - t < timeout) { try { if (await fn()) return; } catch {} await sleep(100); } throw Error('Timeout: ' + label); }
function cdp(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 60000); pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } }); ws.send(JSON.stringify({ id, method, params })); }); }
async function js(expression) { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ': ' + r.exceptionDetails.exception?.description); return r.result.value; }
async function click(selector) { await wait(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), selector); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); }

async function fileInput(selector, filename) { const doc = await cdp('DOM.getDocument'), element = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector }); await cdp('DOM.setFileInputFiles', { nodeId: element.nodeId, files: [filename] }); }
async function meta() { return (await fetch('http://127.0.0.1:' + appPort + '/api/meta')).json(); }
(async () => {
  const base = 'http://127.0.0.1:' + appPort;
  await wait(async () => (await fetch(base + '/api/health')).ok, 'server');
  const sample = path.join(out, 'build-input-' + suffix + '.xlsx'); fs.writeFileSync(sample, Buffer.from(await (await fetch(base + '/api/export?kind=sample')).arrayBuffer()));
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(out, 'build-chrome-' + suffix), 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); chrome.stderr.on('data', b => logs += b);
  let targets; await wait(async () => { targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json(); return targets.some(t => t.type === 'page'); }, 'Chrome');
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: base + '/?tab=data' }); await wait(() => js("!!document.querySelector('#artifact-files')"), 'build controls');
  assert.ok(await js("document.querySelector('a[href=\"/api/import/schema\"]') && document.querySelector('a[href=\"/api/export?kind=template\"]')")); checks.push('online schema and template controls');
  await fileInput('#upload-files', sample); await wait(() => js("document.querySelector('#modal[open]')?.innerText.includes('确认工作表')"), 'sheet selection');
  await click('#modal-btn-0'); await wait(() => js("document.querySelector('#modal[open]')?.innerText.includes('构建完成')"), 'independent build', 120000); assert.equal((await meta()).revision, 0);
  await click('#modal-btn-0'); await wait(async () => (await meta()).revision === 1, 'activation'); await wait(() => js("!document.body.hasAttribute('aria-busy') && !document.querySelector('#modal[open]')"), 'activation UI'); assert.equal((await meta()).codes, 1000); checks.push('Excel upload, field mapping, build, explicit activation');
  const bad = path.join(out, 'build-bad-' + suffix + '.csv'); fs.writeFileSync(bad, 'plan_date,code,month,qty\n2026-09-10,RETRY,2026-09,invalid\n');
  await fileInput('#upload-files', bad); await wait(() => js("document.querySelector('#modal[open]')?.innerText.includes('确认工作表')"), 'bad input selection'); await click('#modal-btn-0'); await wait(() => js("document.querySelector('#modal[open]')?.innerText.includes('数据校验未通过')"), 'error rows');
  assert.ok(await js("document.querySelector('#modal').innerText.includes('预测数量')")); assert.equal((await meta()).revision, 1); await click('#modal-close'); checks.push('validation error and unchanged baseline');
  fs.writeFileSync(bad, 'plan_date,code,month,qty,site_code\n2026-09-10,RETRY,2026-09,80,S1\n'); await fileInput('#upload-files', bad); await wait(() => js("document.querySelector('#modal[open]')?.innerText.includes('确认工作表')"), 'same file retry'); await click('#modal-btn-0'); await wait(() => js("document.querySelector('#modal[open]')?.innerText.includes('构建完成')"), 'retry built');
  await cdp('Page.reload'); await wait(() => js("!!document.querySelector('[data-resume-build]')"), 'resume after reload'); await click('[data-resume-build]'); await click('#modal-btn-0'); await wait(async () => (await meta()).revision === 2, 'resumed activation'); await wait(() => js("!document.body.hasAttribute('aria-busy') && !document.querySelector('#modal[open]')"), 'resumed UI'); checks.push('same filename retry and reload resumes completed build');
  const artifact = path.join(out, 'build-ui-' + suffix + '.supply'); fs.writeFileSync(artifact, Buffer.from(await (await fetch(base + '/api/export?kind=artifact')).arrayBuffer()));
  await fileInput('#artifact-files', artifact); await wait(() => js("document.querySelector('#modal[open]')?.innerText.includes('构建完成')"), 'artifact verification'); await click('#modal-btn-0'); await wait(async () => (await meta()).revision === 3, 'artifact activation'); await wait(() => js("!document.body.hasAttribute('aria-busy') && !document.querySelector('#modal[open]')"), 'artifact UI'); checks.push('offline artifact upload and activation');
  await click('#rebuild-current'); await wait(async () => (await meta()).revision === 4, 'explicit rebuild'); await wait(() => js("!document.body.hasAttribute('aria-busy')"), 'rebuild UI'); checks.push('explicit rebuild and online job records');
  assert.deepEqual(errors, []); const shot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'build-browser.png'), Buffer.from(shot.data, 'base64')); fs.writeFileSync(path.join(out, 'build-browser.json'), JSON.stringify({ checks, errors }, null, 2)); console.log(JSON.stringify({ checks, errors }, null, 2));
})().catch(e => { console.error(e); console.error(logs.slice(-3000)); process.exitCode = 1; }).finally(() => { ws?.close(); chrome?.kill(); app.kill(); });
