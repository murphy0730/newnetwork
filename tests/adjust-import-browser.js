'use strict';
// 表2真实浏览器回归：模板下载、上传、装载、口径切换和汇总表取值。
// 通过 Chrome DevTools Protocol 驱动，无第三方依赖。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-output'); fs.mkdirSync(out, { recursive: true });
const suffix = Date.now(), appPort = Number(process.env.TEST_PORT || 8798), debugPort = Number(process.env.DEBUG_PORT || 9338);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const env = { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', DB_PATH: path.join(out, `adjust-ui-${suffix}.sqlite`), API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '' };
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
const base = 'http://127.0.0.1:' + appPort;
async function upload(filename, previousRevision, commit = true) {
  await fileInput('#upload-files', filename);
  await wait(() => js("document.querySelector('#modal[open]')?.innerText.includes('确认工作表')"), 'sheet selection');
  await click('#modal-btn-0');
  await wait(() => js("document.querySelector('#modal[open]')?.innerText.includes('构建完成')"), 'build preview');
  assert.equal((await meta()).revision, previousRevision, 'Preview does not change published data');
  if (!commit) return;
  await click('#modal-btn-0');
  await wait(async () => (await meta()).revision === previousRevision + 1, 'activation');
  await wait(() => js("!document.body.hasAttribute('aria-busy') && !document.querySelector('#modal[open]')"), 'activation UI');
}
async function summary(expected) {
  await click('[data-tab="overview"]');
  await click('#seg-view [data-view="table"]');
  await wait(() => js("document.querySelectorAll('#tbl-body tr.supplier-start').length===3"), 'three suppliers');
  for (const mode of ['direct', 'cross', 'top']) {
    await click('#seg-mode [data-mode="' + mode + '"]');
    await wait(() => js("document.querySelectorAll('#tbl-body tr.supplier-start').length===3"), 'summary mode');
    const cells = await js("Object.fromEntries([...document.querySelectorAll('#tbl-body tr.supplier-start')].map(r=>[r.dataset.supplier,[...r.cells].slice(7,11).map(c=>Number(c.textContent.replaceAll(',','')))]))");
    assert.deepEqual(cells, expected, mode + ': forecast/add/remove/supply');
  }
  return expected;
}
(async () => {
  await wait(async () => (await fetch(base + '/api/health')).ok, 'server');
  const XLSX = require('../vendor/xlsx'), folder = path.join(out, 'adjust-repro-' + suffix); fs.mkdirSync(folder);
  const all = Buffer.from(await (await fetch(base + '/api/export?kind=template')).arrayBuffer());
  const initial = XLSX.read(all, { type: 'buffer' });
  // Import actual template forecast/BOM/attributes first, then the separately downloaded table2.
  initial.SheetNames = initial.SheetNames.filter(n => n !== 'adjust'); delete initial.Sheets.adjust;
  const foundation = path.join(folder, '01-foundation.xlsx'); fs.writeFileSync(foundation, XLSX.write(initial, { type: 'buffer', bookType: 'xlsx' }));
  const adjustment = path.join(folder, '02-adjust-template.xlsx');
  fs.writeFileSync(adjustment, Buffer.from(await (await fetch(base + '/api/export?kind=template&table=adjust')).arrayBuffer()));
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(folder, 'chrome'), 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', b => logs += b);
  let targets; await wait(async () => { targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json(); return targets.some(t => t.type === 'page'); }, 'Chrome');
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: base + '/?tab=data' }); await wait(() => js("!!document.querySelector('#upload-files')"), 'import page');
  await upload(foundation, 0);
  assert.equal((await meta()).counts.adjust, 0); checks.push('foundation template imports with no table2 rows');
  await upload(adjustment, 1, false);
  assert.equal((await meta()).counts.adjust, 0); checks.push('completed preview alone leaves table2 empty in the published version');
  assert.ok(await js("document.querySelector('#modal').textContent.includes('表2不再重复应用')"));
  await click('#modal-btn-0'); await wait(async () => (await meta()).revision === 2, 'table2 published');
  await wait(() => js("!document.querySelector('#modal[open]') && !document.body.hasAttribute('aria-busy')"), 'table2 published UI');
  assert.equal((await meta()).counts.adjust, 3);
  const net = await summary({ 'DEMO-001': [100, 0, 0, 100], 'DEMO-002': [250, 0, 0, 250], 'DEMO-003': [800, 0, 0, 800] });
  checks.push('net mode stores all three adjustments but summary intentionally displays zero');
  await click('[data-tab="config"]'); await wait(() => js("!!document.querySelector('#cfg-input')"), 'config');
  await js("document.querySelector('#cfg-input').value='raw'"); await click('#cfg-save');
  await wait(async () => (await meta()).revision === 3, 'raw rebuilt');
  await wait(() => js("!document.body.hasAttribute('aria-busy')"), 'config complete');
  const expected = { 'DEMO-001': [100, 10, 0, 110], 'DEMO-002': [250, 0, 20, 250], 'DEMO-003': [800, 30, 0, 830] };
  const raw = await summary(expected); checks.push('switching raw through the UI applies table2 in all three summary modes without reimport');
  await click('[data-tab="data"]'); await wait(() => js("!!document.querySelector('#upload-files')"), 'return to import');
  await upload(adjustment, 3); assert.equal((await meta()).counts.adjust, 3);
  await summary(expected); checks.push('reimporting standalone table2 in raw mode preserves and does not double adjustments');
  assert.deepEqual(errors, []);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'adjust-import-browser.png'), Buffer.from(shot.data, 'base64'));
  const result = { checks, errors, columns: ['forecast', 'add', 'remove', 'supply'], net, raw, fixtureFolder: folder };
  fs.writeFileSync(path.join(out, 'adjust-import-browser.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(e => { console.error(e); console.error(logs.slice(-2000)); process.exitCode = 1; }).finally(() => { ws?.close(); chrome?.kill(); app.kill(); });
