'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-output'); fs.mkdirSync(out, { recursive: true });
const suffix = Date.now(), appPort = Number(process.env.TEST_PORT || 8808), debugPort = Number(process.env.DEBUG_PORT || 9348);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const env = { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', DB_PATH: path.join(out, `search-miss-${suffix}.sqlite`), API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '' };
{
  const C = require('../forecast-core'), { Service } = require('../server/service'), data = C.empty();
  for (const code of ['A', 'B', ...Array.from({ length: 25 }, (_, i) => 'C' + String(i).padStart(2, '0'))]) {
    data.tables.attributes.push({ code, name: '零件' + code, make_dept: code.startsWith('C') ? 'X' : 'Y', lead_mean: 1 });
    data.tables.forecast.push({ code, plan_date: '2026-09-24', month: '2026-09', qty: code.startsWith('C') ? 50 : 100, site_code: 'S' });
    if (code.startsWith('C')) for (const parent of ['A', 'B']) data.tables.bom.push({ parent, child: code, qty: 1, parent_template: 'AI', child_template: 'AI' });
  }
  const service = new Service(env.DB_PATH); try { service.publish(data, 0, 'local', 'test'); } finally { service.store.close(); }
}
const app = spawn(process.execPath, ['server/main.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', chrome, ws, nextId = 1; const pending = new Map(), errors = [], checks = [];
app.stdout.on('data', b => logs += b); app.stderr.on('data', b => logs += b);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, label, timeout = 30000) { const t = Date.now(); while (Date.now() - t < timeout) { try { if (await fn()) return; } catch {} await sleep(100); } throw Error('Timeout: ' + label); }
function cdp(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 30000); pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } }); ws.send(JSON.stringify({ id, method, params })); }); }
async function js(expression) { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
async function click(selector) { await wait(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), selector); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function miss() { await wait(() => js("document.querySelector('#modal[open]')?.textContent.includes('搜索不到编码') && !document.querySelector('#apply').disabled"), 'missing-code dialog'); }
async function escape() { for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await wait(() => js("!document.querySelector('#modal').open"), 'Escape closes dialog'); }
(async () => {
  const base = 'http://127.0.0.1:' + appPort;
  await wait(async () => (await fetch(base + '/api/health')).ok, 'server');
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(out, 'search-chrome-' + suffix), 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); chrome.stderr.on('data', b => logs += b);
  let targets; await wait(async () => { targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json(); return targets.some(t => t.type === 'page'); }, 'Chrome');
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: base });
  await wait(() => js("document.querySelector('#g-count')?.textContent.includes('全部 27 个')"), 'graph ready');
  await js("window.__graph=document.querySelector('#graph-container');window.__root=document.querySelector('#ov-root');document.querySelector('#sc-code').value='MISSING<script>" + "';document.querySelector('#apply').click()");
  await miss();
  assert.ok(await js("window.__graph===document.querySelector('#graph-container') && window.__root===document.querySelector('#ov-root') && !document.querySelector('#retry')"));
  assert.equal(await js("document.querySelector('#modal-close').textContent"), '×');
  assert.equal(await js("document.querySelector('#modal').getAttribute('aria-label')"), '搜索不到编码');
  assert.equal(await js("document.querySelector('#modal script')"), null);
  assert.ok(await js("document.querySelector('#modal').textContent.includes('MISSING<script>') && document.querySelector('#modal').getBoundingClientRect().width<=440"));
  assert.ok(await js("{const r=document.querySelector('#modal').getBoundingClientRect();Math.abs(r.left+r.width/2-innerWidth/2)<1 && Math.abs(r.top+r.height/2-innerHeight/2)<1 && document.querySelector('#modal-close').getBoundingClientRect().left>r.left+r.width/2;}"), 'dialog is centred with the close button on the right');
  const shot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'search-miss.png'), Buffer.from(shot.data, 'base64'));
  await click('#modal-close'); await wait(() => js("!document.querySelector('#modal').open && document.activeElement.id==='sc-code'"), 'close restores input focus');
  checks.push('missing focused code opens an escaped, labelled, compact dialog with an X and preserves the graph');
  await js("document.querySelector('#sc-code').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))"); await miss(); await escape();
  await js("document.querySelector('#sc-code').value='C00';document.querySelector('#apply').click()");
  await wait(() => js("document.querySelector('#sc-code')?.value==='C00' && document.querySelector('#graph-container')!==window.__graph && !document.querySelector('#retry')"), 'valid focused search');
  checks.push('Enter opens the dialog, Escape closes it, and a corrected code still navigates normally');
  await click('#seg-view [data-view=table]'); await wait(() => js("!!document.querySelector('#tbl-body tr[data-supplier=C00]')"), 'table ready');
  await click('#clear'); await wait(() => js("document.querySelector('#pg-total')?.textContent.includes('共 27 个编码')"), 'all table codes');
  await js("{const el=document.querySelector('#pg-jump');el.value='2';el.dispatchEvent(new Event('change'));}");
  await wait(() => js("document.querySelector('#pg-jump')?.value==='2' && !!document.querySelector('#tbl-body tbody tr')"), 'second page');
  await js("window.__table=document.querySelector('#tbl-body');window.__tableHtml=window.__table.innerHTML;document.querySelector('#sc-code').value='MISSING';document.querySelector('#apply').click()");
  await miss(); assert.ok(await js("window.__table===document.querySelector('#tbl-body') && window.__tableHtml===window.__table.innerHTML && document.querySelector('#pg-jump').value==='2'"));
  await click('#modal-close');
  await js("document.querySelector('#sc-code').value='';document.querySelector('#sc-search').value='MISSING-KEYWORD';document.querySelector('#apply').click()");
  await miss(); assert.ok(await js("window.__table===document.querySelector('#tbl-body') && document.querySelector('#pg-jump').value==='2'"));
  await escape();
  checks.push('missing focused and keyword searches leave summary rows, pagination and filter controls in place');
  await js("document.querySelector('#sc-search').value='零件C00';document.querySelector('#apply').click()");
  await wait(() => js("document.querySelector('#pg-total')?.textContent.includes('共 1 个编码') && !!document.querySelector('#tbl-body tr[data-supplier=C00]')"), 'valid name search');
  await js("window.__table=document.querySelector('#tbl-body');window.__link=window.__table.querySelector('.fc-code');window.__code=window.__link.dataset.code;window.__link.dataset.code='STALE-CODE';window.__link.click()");
  await miss(); assert.ok(await js("window.__table===document.querySelector('#tbl-body') && !document.querySelector('#graph-container')"));
  await click('#modal-close'); await js("window.__link.dataset.code=window.__code");
  checks.push('valid name searches work, and a stale code link shows a dialog without leaving the table');
  await js("window.__fetch=window.fetch;window.fetch=async (url,opts)=>String(url).startsWith('/api/analysis?')?new Response(JSON.stringify({error:{message:'测试服务异常'}}),{status:500,headers:{'Content-Type':'application/json'}}):window.__fetch(url,opts);document.querySelector('#sc-code').value='C01';document.querySelector('#apply').click()");
  await wait(() => js("document.querySelector('#msg').textContent.includes('测试服务异常') && !document.querySelector('#apply').disabled"), 'other request error');
  assert.ok(await js("!document.querySelector('#modal').open && window.__table===document.querySelector('#tbl-body')")); await js("window.fetch=window.__fetch");
  checks.push('service errors keep their original message and do not become a missing-code dialog');
  await js("window.fetch=(url,opts)=>new URL(url,location.href).searchParams.get('code')==='DELAYED-MISS'?new Promise(resolve=>window.__release=resolve):window.__fetch(url,opts);document.querySelector('#sc-code').value='DELAYED-MISS';document.querySelector('#apply').click()");
  await wait(() => js("typeof window.__release==='function'"), 'pending lookup');
  await click('#seg-mode [data-mode=cross]');
  await wait(() => js("document.querySelector('#seg-mode [data-mode=cross]')?.classList.contains('active') && document.querySelector('#sc-code')?.value===''") , 'newer render');
  await js("window.__release(new Response(JSON.stringify({error:{message:'编码不存在'}}),{status:404,headers:{'Content-Type':'application/json'}}));window.fetch=window.__fetch");
  await sleep(150); assert.ok(await js("!document.querySelector('#modal').open && !!document.querySelector('#tbl-body') && !document.querySelector('#retry')"));
  checks.push('late missing-code responses cannot overwrite a newer view');
  assert.deepEqual(errors, []); fs.writeFileSync(path.join(out, 'search-miss-browser.json'), JSON.stringify({ checks, errors }, null, 2)); console.log(JSON.stringify({ checks, errors }, null, 2));
})().catch(e => { console.error(e); console.error(logs.slice(-2500)); process.exitCode = 1; }).finally(() => { ws?.close(); chrome?.kill(); app.kill(); });
