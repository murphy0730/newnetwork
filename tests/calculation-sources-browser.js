'use strict';
// 逐月有效来源、路径系数、累计结果的页面和Excel回归。
// 通过 Chrome DevTools Protocol 驱动，无第三方依赖。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-output'); fs.mkdirSync(out, { recursive: true });
const suffix = Date.now(), appPort = Number(process.env.TEST_PORT || 8798), debugPort = Number(process.env.DEBUG_PORT || 9338);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const env = { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', DB_PATH: path.join(out, `source-ui-${suffix}.sqlite`), API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '' };
seedFixture(env.DB_PATH);
const app = spawn(process.execPath, ['server/main.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; app.stdout.on('data', b => logs += b); app.stderr.on('data', b => logs += b);
let chrome, ws, nextId = 1; const pending = new Map(), errors = [], checks = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, label, timeout = 30000) { const t = Date.now(); while (Date.now() - t < timeout) { try { if (await fn()) return; } catch {} await sleep(100); } throw Error('Timeout: ' + label); }
function cdp(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 60000); pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } }); ws.send(JSON.stringify({ id, method, params })); }); }
async function js(expression) { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ': ' + r.exceptionDetails.exception?.description); return r.result.value; }
async function click(selector) { await wait(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), selector); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); }

function seedFixture(db) {
  const C = require('../forecast-core'), { Service } = require('../server/service'), data = C.empty(); data.kind = 'imported';
  for (const [code, make_dept] of [['A','X'], ['B','X'], ['C','Y'], ['R','Z'], ['B1','Y'], ['B2','X'], ['V','X']]) data.tables.attributes.push({ code, make_dept, lead_mean: 1 });
  const f = (code, qty, month) => data.tables.forecast.push({ code, qty, month, plan_date: '2026-09-24', site_code: 'S' });
  for (const [code, qty] of [['A',100], ['C',50], ['R',100], ['V',50]]) f(code, qty, '2026-09');
  for (const [code, qty] of [['A',200], ['B',80], ['C',50], ['R',100], ['B1',30], ['V',50]]) f(code, qty, '2026-10');
  for (const [parent, child, qty] of [['A','B',1], ['B','C',1], ['R','B1',2], ['R','B2',3], ['B1','V',1], ['B2','V',1]]) data.tables.bom.push({ id: parent+'-'+child, parent, child, qty, parent_template: 'AI', child_template: 'AI' });
  const service = new Service(db); try { service.publish(data, 0, 'local', 'test'); } finally { service.store.close(); }
}
async function exported() {
  await js('window.__exported=null;XLSX.writeFile=wb=>window.__exported=XLSX.utils.sheet_to_json(wb.Sheets.data)');
  await click('#export-table'); await wait(() => js('!!window.__exported && !document.body.hasAttribute("aria-busy")'), 'Excel export');
  return js('window.__exported');
}
(async () => {
  const base = 'http://127.0.0.1:' + appPort;
  await wait(async () => (await fetch(base + '/api/health')).ok, 'server');
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(out, 'source-chrome-' + suffix), 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); chrome.stderr.on('data', b => logs += b);
  let targets; await wait(async () => { targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json(); return targets.some(t => t.type === 'page'); }, 'Chrome');
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: base }); await click('#seg-view [data-view="table"]');
  await wait(() => js("!!document.querySelector('#tbl-span')"), 'table ready');
  await click('#seg-mode [data-mode="cross"]');
  await wait(() => js("!!document.querySelector('#tbl-span') && document.querySelector('#seg-mode [data-mode=cross]')?.classList.contains('active')"), 'cross table ready');
  await js("document.querySelector('#sc-code').value='C';document.querySelector('#apply').click()");
  await wait(() => js("document.querySelector('#pg-total')?.textContent.includes('共 1 个编码')"), 'focus C');
  await js("{const el=document.querySelector('#tbl-span');el.value='2';el.dispatchEvent(new Event('change'));}");
  await wait(() => js("document.querySelectorAll('#tbl-body th[data-period-start]').length===2 && document.querySelectorAll('#tbl-body tr[data-supplier=\"C\"]').length===2"), 'source union');
  const rows = await exported(), a = rows.find(r => r['跨产业编码']==='A'), b = rows.find(r => r['跨产业编码']==='B');
  assert.equal(a['来源折算需求 2026年9月'],100); assert.equal(a['来源折算需求 2026年10月'],0);
  assert.equal(b['来源折算需求 2026年9月'],0); assert.equal(b['来源折算需求 2026年10月'],80);
  assert.equal(rows.reduce((sum,r)=>sum+(r['跨产业总需求 2026年10月']||0),0),80);
  assert.equal(rows.reduce((sum,r)=>sum+(r['供需结余 2026年10月']||0),0),-30);
  assert.ok(await js("!document.querySelector('#tbl-body').textContent.includes('数据不完整')"));
  checks.push('changing monthly frontier displays and exports A=100/0 and B=0/80');
  await js("{const el=document.querySelector('#tbl-span');el.value='1';el.dispatchEvent(new Event('change'));}");
  await wait(() => js("document.querySelectorAll('#tbl-body th[data-period-start]').length===1"), 'one month');
  await js("{const el=document.querySelector('#sc-month');el.value='2026-10';el.dispatchEvent(new Event('change'));}");
  await wait(() => js("document.querySelector('#tbl-body th[data-period-start]')?.dataset.periodStart==='2026-10'"), 'October');
  const october = await exported(); assert.equal(october[0]['跨产业总需求 2026年10月'],80);
  checks.push('October-only export agrees with October inside a September-start query');
  await js("{const el=document.querySelector('#sc-month');el.value='2026-09';el.dispatchEvent(new Event('change'));}");
  await wait(() => js("document.querySelector('#tbl-body th[data-period-start]')?.dataset.periodStart==='2026-09'"), 'September');
  await js("document.querySelector('#sc-code').value='V';document.querySelector('#apply').click()");
  await wait(() => js("!!document.querySelector('#tbl-body tr[data-supplier=\"V\"]')"), 'focus V');
  await js("{const el=document.querySelector('#tbl-span');el.value='2';el.dispatchEvent(new Event('change'));}");
  await wait(() => js("document.querySelectorAll('#tbl-body th[data-period-start]').length===2"), 'varying coefficient months');
  const varying = await exported(), root = varying.find(r=>r['跨产业编码']==='R');
  assert.equal(root['来源BOM用量 2026年9月'],5); assert.equal(root['来源BOM用量 2026年10月'],3);
  assert.equal(root['跨产业总需求 2026年9月'],500); assert.equal(root['跨产业总需求 2026年10月'],330);
  assert.ok(String(root['累计BOM用量']).includes('2026-09：5') && String(root['累计BOM用量']).includes('2026-10：3'));
  assert.ok(await js("document.querySelector('#tbl-body').textContent.includes('2026-09：5；2026-10：3')"));
  checks.push('variable source coefficients are visible and exported as 5 then 3');
  await js("{const el=document.querySelector('#tbl-period-mode');el.value='cumulative';el.dispatchEvent(new Event('change'));}");
  await wait(() => js("document.querySelectorAll('#tbl-body th[data-period-start]').length===1"), 'cumulative');
  const cumulative = await exported(); assert.equal(cumulative.reduce((sum,r)=>sum+(r['跨产业总需求 2026年9-10月']||0),0),830);
  assert.deepEqual(errors, []); checks.push('cumulative export sums the per-month frontiers exactly once');
  fs.writeFileSync(path.join(out, 'calculation-sources-browser.json'), JSON.stringify({checks,errors,rows,varying,cumulative},null,2));
  console.log(JSON.stringify({checks,errors},null,2));
})().catch(e => { console.error(e); console.error(logs.slice(-2000)); process.exitCode = 1; }).finally(() => { ws?.close(); chrome?.kill(); app.kill(); });
