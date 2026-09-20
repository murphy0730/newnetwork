'use strict';
// 轻量 CDP 截图脚本：连接已在跑的 8787 服务，加载页面并截取大样本效果。
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const out = path.resolve(__dirname, '..', 'test-output'); fs.mkdirSync(out, { recursive: true });
const APP = process.env.APP_URL || 'http://127.0.0.1:8787/';
const debugPort = Number(process.env.DEBUG_PORT || 9336);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let chrome, ws, nextId = 1; const pending = new Map(); const errors = [];
async function wait(fn, label, timeout = 30000) { const t = Date.now(); while (Date.now() - t < timeout) { try { if (await fn()) return; } catch {} await sleep(150); } throw Error('Timeout: ' + label); }
function cdp(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000); pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } }); ws.send(JSON.stringify({ id, method, params })); }); }
async function js(expression) { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; }
(async () => {
  await wait(async () => (await fetch(APP.replace(/\/$/, '') + '/api/health', { signal: AbortSignal.timeout(1000) })).ok, 'server ' + APP);
  console.log('server ready');
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(out, 'chrome-live-' + Date.now()), 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', b => {}); chrome.on('error', e => console.error('chrome err', e.message));
  let targets; await wait(async () => { targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) })).json(); return targets.some(t => t.type === 'page'); }, 'chrome');
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise((r, reject) => { const t = setTimeout(() => reject(Error('ws timeout')), 10000); ws.onopen = () => { clearTimeout(t); r(); }; ws.onerror = () => reject(Error('ws fail')); });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: APP });
  // 等待图 canvas 出现
  await wait(() => js(`document.querySelectorAll('canvas').length>0`), 'canvas');
  // 等待图上节点渲染完成（读取自定义状态或 gGraph 计数）
  await sleep(2500);
  const state = await js(`(() => {
    const info = {};
    try { info.text = document.body.innerText.slice(0, 400); } catch {}
    info.canvasCount = document.querySelectorAll('canvas').length;
    info.gCount = document.getElementById('g-count') ? document.getElementById('g-count').textContent : null;
    info.kpis = Array.from(document.querySelectorAll('.kpi-strip .kpi, .kpi-strip [class*=kpi]')).slice(0, 6).map(e => e.textContent.trim()).filter(Boolean);
    return info;
  })()`);
  console.log('page state:', JSON.stringify(state, null, 2));
  await sleep(1500);
  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const p = path.join(out, 'live-large-' + Date.now() + '.png'); fs.writeFileSync(p, Buffer.from(shot.data, 'base64')); console.log('saved', p);
  const jserr = await js(`window.__errs || []`).catch(() => []);
  console.log('runtime exceptions:', JSON.stringify(errors));
  fs.writeFileSync(path.join(out, 'live-large.json'), JSON.stringify({ errors, page: state }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { try { ws?.close(); } catch {} try { chrome?.kill(); } catch {} });
