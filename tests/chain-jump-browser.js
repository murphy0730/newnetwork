'use strict';
// 汇总表点击编码跳转网络图：应自动锁定该编码并高亮整条关联链路（等效手动单击节点）。
// 通过包装 ForecastGraph.prototype.selectChain 记录调用与生效后的 chainCode 来验证联动。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-output'); fs.mkdirSync(out, { recursive: true });
const suffix = Date.now(), appPort = Number(process.env.TEST_PORT || 8801), debugPort = Number(process.env.DEBUG_PORT || 9341);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const env = { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', DB_PATH: path.join(out, `chain-jump-${suffix}.sqlite`), API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '' };
const app = spawn(process.execPath, ['server/main.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; app.stdout.on('data', b => logs += b); app.stderr.on('data', b => logs += b);
let chrome, ws, nextId = 1; const pending = new Map(), errors = [], checks = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, label, timeout = 30000) { const t = Date.now(); while (Date.now() - t < timeout) { try { if (await fn()) return; } catch {} await sleep(100); } throw Error('Timeout: ' + label); }
function cdp(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 10000); pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } }); ws.send(JSON.stringify({ id, method, params })); }); }
async function js(expression) { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ': ' + r.exceptionDetails.exception?.description); return r.result.value; }
async function click(selector) { await wait(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), selector); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); }
(async () => {
  console.log('Starting chain-jump browser test');
  await wait(async () => (await fetch(`http://127.0.0.1:${appPort}/api/health`, { signal: AbortSignal.timeout(1000) })).ok, 'server');
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(out, 'chrome-' + suffix), 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', b => logs += b); chrome.on('error', e => logs += e.message);
  let targets; await wait(async () => { targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) })).json(); return targets.some(t => t.type === 'page'); }, 'chrome');
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise((r, reject) => { const t = setTimeout(() => reject(Error('WebSocket open timeout')), 10000); ws.onopen = () => { clearTimeout(t); r(); }; ws.onerror = () => reject(Error('WebSocket connection failed')); });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  // 导入示例数据（独立构建流程：上传 → 确认工作表 → 构建完成 → 激活）
  const workbook = Buffer.from(await (await fetch(`http://127.0.0.1:${appPort}/api/export?kind=sample`)).arrayBuffer()), filePath = path.join(out, 'chain-jump-sample.xlsx'); fs.writeFileSync(filePath, workbook);
  await cdp('Page.navigate', { url: `http://127.0.0.1:${appPort}/?tab=data` }); await wait(() => js(`!!document.getElementById('upload-files')`), 'data page');
  const dom = await cdp('DOM.getDocument'); const input = await cdp('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '#upload-files' }); await cdp('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [filePath] });
  await wait(() => js(`document.querySelector('#modal[open]')?.innerText.includes('确认工作表')`), 'sheet selection'); await click('#modal-btn-0'); await wait(() => js(`document.querySelector('#modal[open]')?.innerText.includes('构建完成')`), 'independent build', 120000); await click('#modal-btn-0'); await wait(() => js(`!document.querySelector('#modal[open]') && !document.body.hasAttribute('aria-busy')`), 'activation');
  // 包装两个图类的 selectChain，记录调用编码与生效后的实例状态
  await js(`window.__chainCalls = []; window.__chainState = [];
    for (const key of ['ForecastGraph', 'ForecastGraphMap']) {
      const cls = window[key]; if (!cls || !cls.prototype.selectChain) continue;
      const orig = cls.prototype.selectChain;
      cls.prototype.selectChain = function (code) {
        window.__chainCalls.push(key + ':' + code);
        return Promise.resolve(orig.call(this, code)).then(() => { window.__chainState.push(this.chainCode + '|' + this.selected); });
      };
    } true`);
  // 进入汇总表并点击第一个编码链接
  await click('[data-tab="overview"]'); await wait(() => js(`!!document.getElementById('graph-container')`), 'graph view');
  await click('#seg-view [data-view="table"]'); await wait(() => js(`!!document.querySelector('#tbl-body .fc-code')`), 'summary table rows');
  const clicked = await js(`document.querySelector('#tbl-body .fc-code').textContent.trim()`);
  await js(`document.querySelector('#tbl-body .fc-code').click()`);
  await wait(() => js(`window.__chainCalls.length > 0 && !!document.getElementById('graph-container')`), 'auto chain highlight', 15000);
  await wait(() => js(`window.__chainState.length > 0`), 'chain state applied', 15000);
  assert.ok((await js(`window.__chainCalls`)).some(c => c.endsWith(':' + clicked)), 'selectChain called with clicked code ' + clicked);
  assert.ok((await js(`window.__chainState`)).some(s => s === clicked + '|' + clicked), 'chainCode/selected applied: ' + JSON.stringify(await js('window.__chainState')));
  assert.equal(await js(`document.getElementById('sc-code').value`), clicked);
  checks.push('summary table code jump auto-locks node and highlights chain');
  // 跳转后画布上存在 dim 状态（其余节点被压暗），说明链路高亮确实生效
  await sleep(600);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'chain-jump.png'), Buffer.from(shot.data, 'base64'));
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'chain-jump.json'), JSON.stringify({ clicked, calls: await js('window.__chainCalls'), state: await js('window.__chainState'), checks, errors }, null, 2));
  console.log(JSON.stringify({ clicked, checks, errors }, null, 2));
})().catch(e => { console.error(e); console.error(logs); process.exitCode = 1; }).finally(() => { ws?.close(); chrome?.kill(); app.kill(); });
