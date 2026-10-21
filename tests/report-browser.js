'use strict';
// 报告页浏览器回归：执行摘要（KPI + 结论）、产业分布/逐月趋势图表、原有明细保留。
// 通过 Chrome DevTools Protocol 驱动。运行：node tests/report-browser.js
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-output'); fs.mkdirSync(out, { recursive: true });
const suffix = Date.now(), appPort = Number(process.env.TEST_PORT || 8799), debugPort = Number(process.env.DEBUG_PORT || 9341);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const env = { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', DB_PATH: path.join(out, `report-${suffix}.sqlite`), API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '' };
const app = spawn(process.execPath, ['server/main.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; app.stdout.on('data', b => logs += b); app.stderr.on('data', b => logs += b);
let chrome, ws, nextId = 1; const pending = new Map(), errors = [], checks = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, label, timeout = 30000) { const t = Date.now(); while (Date.now() - t < timeout) { try { if (await fn()) return; } catch {} await sleep(100); } throw Error('Timeout: ' + label); }
function cdp(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 240000); pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } }); ws.send(JSON.stringify({ id, method, params })); }); }
async function js(expression) { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ': ' + r.exceptionDetails.exception?.description); return r.result.value; }
(async () => {
  await wait(async () => (await fetch('http://127.0.0.1:' + appPort + '/api/health')).ok, 'server');
  const initial = await (await fetch('http://127.0.0.1:' + appPort + '/api/sample-large', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseRevision: 0 }) })).json();
  await wait(async () => (await (await fetch('http://127.0.0.1:' + appPort + '/api/jobs/' + initial.jobId)).json()).status === 'completed', 'sample', 120000);
  // 服务端聚合正确性（不依赖浏览器）：kpi / depts / monthly
  const rep = await (await fetch('http://127.0.0.1:' + appPort + '/api/reports')).json();
  assert.ok(rep.kpi.total > 800 && rep.kpi.shortage > 0 && rep.kpi.gapSum > 0); checks.push(`server kpi: ${rep.kpi.total} codes / ${rep.kpi.shortage} shortage / gapSum ${Math.round(rep.kpi.gapSum)}`);
  assert.ok(rep.depts.length > 3 && rep.depts[0].gapSum >= rep.depts[1].gapSum); checks.push('server depts sorted by gapSum, top = ' + rep.depts[0].dept);
  assert.ok(rep.monthly.length > 6 && rep.monthly.every(m => m.month && m.shortage >= 0)); checks.push(`server monthly trend: ${rep.monthly.length} months, peak ${Math.max(...rep.monthly.map(m => m.shortage))}`);
  const deptShortage = rep.depts.reduce((s, d) => s + d.shortage, 0);
  assert.equal(deptShortage, rep.kpi.shortage); checks.push('dept shortage sums to kpi shortage');
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(out, 'report-chrome-' + suffix), 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', b => logs += b);
  let targets; await wait(async () => { targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json(); return targets.some(t => t.type === 'page'); }, 'Chrome');
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: 'http://127.0.0.1:' + appPort + '/' });
  await wait(() => js("!!document.querySelector('#seg-layout') && !!document.querySelector('.kpi-strip')"), 'overview ready');   // 等总览渲染完再切页，避免与 init 的 render 竞态
  await js("document.querySelector('[data-tab=\"reports\"]').click()");
  await sleep(2000);
  console.log('diag:', await js("JSON.stringify({err:document.querySelector('#workspace .fc-notice.error')?.textContent||'',findings:document.querySelectorAll('.fc-findings li').length,dept:!!document.querySelector('#deptchart canvas'),trend:!!document.querySelector('#trendchart canvas'),heat:!!document.querySelector('#heatmap canvas'),heatEl:!!document.querySelector('#heatmap')})"));
  await wait(() => js("!!document.querySelector('.fc-findings li') && !!document.querySelector('#deptchart canvas') && !!document.querySelector('#trendchart canvas') && !!document.querySelector('#heatmap canvas')"), 'reports rendered');
  const summary = await js("(()=>({kpis:document.querySelectorAll('.kpi-strip .kpi').length,findings:document.querySelectorAll('.fc-findings li').length,title:document.querySelector('.fc-section')?.textContent}))()");
  assert.equal(summary.kpis, 6); assert.ok(summary.findings >= 3); checks.push(`executive summary: 6 KPI cards + ${summary.findings} findings`);
  const findingTexts = await js("[...document.querySelectorAll('.fc-findings li')].map(x=>x.textContent)");
  assert.ok(findingTexts[0].includes('总量不足') || findingTexts[0].includes('供需总体平衡')); checks.push('finding[0]: ' + findingTexts[0].slice(0, 40) + '…');
  assert.ok(findingTexts.some(t => t.includes('缺口集中在'))); checks.push('finding: dept concentration present');
  assert.ok(findingTexts.some(t => t.includes('逐月看'))); checks.push('finding: monthly trend present');
  // 原有明细保留
  assert.ok(await js("document.body.textContent.includes('风险编码 Top20') && document.body.textContent.includes('加工地供应集中与关联缺口') && document.body.textContent.includes('当月单一加工地')")); checks.push('detail sections (Top20 / sites / single) retained');
  // 切换口径控件仍在
  assert.ok(await js("!!document.getElementById('sc-version') && !!document.getElementById('sc-month')")); checks.push('report controls retained');
  const shot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'report-page-' + suffix + '.png'), Buffer.from(shot.data, 'base64'));
  assert.deepEqual(errors, []); fs.writeFileSync(path.join(out, 'report-browser.json'), JSON.stringify({ checks, errors }, null, 2)); console.log(JSON.stringify({ checks, errors }, null, 2));
})().catch(e => { console.error(e); console.error(logs.slice(-2000)); process.exitCode = 1; }).finally(() => { ws?.close(); chrome?.kill(); app.kill(); });
