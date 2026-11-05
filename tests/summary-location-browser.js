'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-output'); fs.mkdirSync(out, { recursive: true });
const suffix = Date.now(), appPort = Number(process.env.TEST_PORT || 8810), debugPort = Number(process.env.DEBUG_PORT || 9350);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const env = { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', DB_PATH: path.join(out, `summary-location-${suffix}.sqlite`), API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '' };
{
  const C = require('../forecast-core'), { Service } = require('../server/service'), data = C.empty();
  for (const code of ['UP', 'ROOT', 'ISO', ...Array.from({ length: 30 }, (_, i) => 'L' + String(i).padStart(2, '0'))]) {
    const leaf = code.startsWith('L'), shared = !leaf || code === 'L01';
    data.tables.attributes.push({ code, name: '零件' + code, make_dept: leaf ? '子产业' : code === 'ROOT' ? '父产业' : '上产业', part_category: shared ? '父大类' : '子大类', lead_mean: 1 });
    for (const month of ['2026-09', '2026-10']) data.tables.forecast.push({ code, month, plan_date: '2026-09-24', qty: leaf ? 10 : 1000, site_code: shared ? 'S_TARGET' : 'S_LEAF' });
    if (leaf || code === 'ROOT') data.tables.bom.push({ parent: leaf ? 'ROOT' : 'UP', child: code, qty: 1, parent_template: 'AI', child_template: 'AI' });
  }
  const svc = new Service(env.DB_PATH); try { svc.publish(data, 0, 'local', 'test'); } finally { svc.store.close(); }
}
const app = spawn(process.execPath, ['server/main.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', chrome, ws, nextId = 1; const pending = new Map(), checks = [], errors = [];
app.stdout.on('data', b => logs += b); app.stderr.on('data', b => logs += b);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, label, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { try { if (await fn()) return; } catch {} await sleep(100); } throw Error('Timeout: ' + label); }
function cdp(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 30000); pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } }); ws.send(JSON.stringify({ id, method, params })); }); }
async function js(expression) { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
async function click(selector) { await wait(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), selector); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function focus(code) { await js(`document.querySelector('#sc-code').value=${JSON.stringify(code)};document.querySelector('#apply').click()`); await wait(() => js(`!!document.querySelector(${JSON.stringify('[data-supplier="' + code + '"]')}) && document.querySelector('#pg-total').textContent.includes('共 1 个编码')`), 'focus ' + code); }
async function expand(code) { await js(`{const button=document.querySelector(${JSON.stringify('[data-toggle-supplier="' + code + '"]')});if(button.getAttribute('aria-expanded')==='false')button.click();}`); await wait(() => js(`document.querySelector(${JSON.stringify('[data-toggle-supplier="' + code + '"]')}).getAttribute('aria-expanded')==='true'`), 'expand ' + code); }
async function located(code) { await wait(() => js(`!!document.querySelector(${JSON.stringify('tr.supplier-start.supplier-located[data-supplier="' + code + '"]')}) && document.activeElement.dataset.code===${JSON.stringify(code)}`), 'locate ' + code); }
async function select(id, value) { await js(`{const el=document.getElementById(${JSON.stringify(id)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change'));}`); }
// 搜索候选有 250ms 防抖；满负载时首次 input 事件可能落在面板重建的空窗里被丢弃。
// 派发一次后轮询 3s（期间不能重复派发，否则会清空候选并重置防抖），仍无结果才重试。
async function typeSearch(term, code, timeout = 15000) { const start = Date.now(); while (Date.now() - start < timeout) { await js(`{const el=document.querySelector('#sc-search');el.value=${JSON.stringify(term)};el.dispatchEvent(new Event('input',{bubbles:true}));}`); const deadline = Date.now() + 3000; while (Date.now() < deadline) { await sleep(200); if (await js(`!!document.querySelector('#code-options input[value=${JSON.stringify(code)}]')`)) return; } } throw Error('Timeout: code candidate ' + code); }
(async () => {
  const base = 'http://127.0.0.1:' + appPort;
  await wait(async () => (await fetch(base + '/api/health')).ok, 'server');
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(out, 'location-chrome-' + suffix), 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); chrome.stderr.on('data', b => logs += b);
  let targets; await wait(async () => { targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json(); return targets.some(t => t.type === 'page'); }, 'Chrome');
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: base }); await click('#seg-view [data-view=table]'); await wait(() => js("!!document.querySelector('#tbl-span')"), 'table');
  await js("window.__fetch=window.fetch;window.__analysis=[];window.fetch=(url,opts)=>{if(new URL(url,location.href).pathname==='/api/analysis')window.__analysis.push(String(url));return window.__fetch(url,opts);}");
  await select('tbl-span', '2'); await wait(() => js("document.querySelectorAll('#tbl-body th[data-period-start]').length===2"), 'two months');
  await select('tbl-period-mode', 'cumulative'); await wait(() => js("document.querySelector('#tbl-period-mode')?.value==='cumulative' && document.querySelectorAll('#tbl-body th[data-period-start]').length===1"), 'cumulative');
  for (const mode of ['direct', 'cross', 'top']) {
    await click('#clear'); await wait(() => js("document.querySelector('#sc-code')?.value===''") , 'clear filters');
    await click('#seg-mode [data-mode=' + mode + ']'); await wait(() => js(`document.querySelector('#seg-mode [data-mode=${mode}]')?.classList.contains('active') && !!document.querySelector('#tbl-body')`), mode);
    await focus('L00'); await expand('L00');
    const target = mode === 'top' ? 'UP' : 'ROOT', before = await js('window.__analysis.length');
    await click('[data-locate-code="' + target + '"]'); await located(target);
    assert.equal(await js('window.__analysis.length'), before + 1, 'locate loads one sorted page without scanning pages or fetching again');
    assert.ok(await js("!document.querySelector('#graph-container') && document.querySelector('#pg-jump').value==='2' && document.querySelector('#sc-code').value===''") );
    assert.deepEqual(await js("[document.querySelector('#sc-version').value,document.querySelector('#sc-month').value,document.querySelector('#tbl-span').value,document.querySelector('#tbl-period-mode').value]"), ['2026-09-24','2026-09','2','cumulative']);
    assert.ok(await js(`document.querySelector('#seg-mode [data-mode=${mode}]').classList.contains('active')`));
    assert.ok(await js(`(()=>{const r=document.querySelector(${JSON.stringify('tr.supplier-start.supplier-located[data-supplier="' + target + '"]')}).getBoundingClientRect(),w=document.querySelector('#tbl-body .fc-tablewrap').getBoundingClientRect();return r.top>=w.top&&r.bottom<=w.bottom;})()`));
    checks.push(mode + ': source click stays in table, clears excluding focus, jumps to page two and highlights/focuses target without changing calculation settings');
  }
  await click('#seg-mode [data-mode=cross]'); await wait(() => js("document.querySelector('#seg-mode [data-mode=cross]')?.classList.contains('active') && !!document.querySelector('#tbl-body')"), 'cross mode');
  await focus('L00');
  await typeSearch('L00', 'L00');
  await js("{const box=document.querySelector('#code-options input[value=L00]');box.checked=true;box.dispatchEvent(new Event('change'));const site=document.querySelector('#sc-site input[value=S_LEAF]');site.checked=true;site.dispatchEvent(new Event('change'));document.querySelector('#sc-industry').value='子产业';document.querySelector('#sc-category').value='子大类';document.querySelector('#sc-risk').value='shortage';document.querySelector('#apply').click();}");
  await wait(() => js("document.querySelector('#sc-industry')?.value==='子产业' && !!document.querySelector('#tbl-body [data-supplier=L00]') && !document.querySelector('#apply').disabled"), 'excluding dimensions');
  await select('tbl-source-industry', '父产业'); await wait(() => js("document.querySelector('#tbl-source-industry')?.value==='父产业' && !!document.querySelector('#tbl-body [data-supplier=L00]')"), 'source industry');
  await expand('L00'); await click('[data-locate-code=ROOT]'); await located('ROOT');
  assert.deepEqual(await js("['sc-code','sc-search','sc-industry','sc-category','sc-risk','tbl-source-industry'].map(id=>document.getElementById(id).value)"), ['','','','','','']);
  assert.equal(await js("document.querySelectorAll('#sc-site input:checked').length+document.querySelectorAll('#code-chips button').length"), 0);
  assert.ok(await js("document.querySelector('#msg').textContent.includes('已解除筛选') && document.querySelector('#pg-jump').value==='2'"));
  const shot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'summary-location.png'), Buffer.from(shot.data, 'base64'));
  checks.push('conflicting code selection, site, industry, category, risk and source industry are removed together and reflected in controls');
  await focus('L01');
  await js("{const box=document.querySelector('#sc-site input[value=S_TARGET]');box.checked=true;box.dispatchEvent(new Event('change'));document.querySelector('#sc-category').value='父大类';document.querySelector('#sc-risk').value='single';document.querySelector('#apply').click();}");
  await wait(() => js("document.querySelector('#sc-category')?.value==='父大类' && !document.querySelector('#apply').disabled && !!document.querySelector('#tbl-body [data-supplier=L01]')"), 'compatible filters');
  await expand('L01'); await click('[data-locate-code=ROOT]'); await located('ROOT');
  assert.deepEqual(await js("[document.querySelector('#sc-category').value,document.querySelector('#sc-risk').value,document.querySelector('#sc-site input:checked').value]"), ['父大类','single','S_TARGET']);
  checks.push('compatible category, risk and site filters stay selected');
  await click('#clear'); await wait(() => js("document.querySelector('#sc-code')?.value===''") , 'clear'); await focus('L00'); await expand('L00');
  await js("window.__table=document.querySelector('#tbl-body');window.__source=document.querySelector('[data-locate-code=ROOT]');window.__source.dataset.locateCode='MISSING';window.__source.click()");
  await wait(() => js("document.querySelector('#modal[open]')?.textContent.includes('搜索不到编码')"), 'missing source');
  assert.ok(await js("window.__table===document.querySelector('#tbl-body') && document.querySelector('#sc-code').value==='L00'"));
  await click('#modal-close'); await js("window.__source.dataset.locateCode='ROOT'");
  checks.push('a missing source opens the dismissible dialog without clearing the current table or filters');
  await js("window.fetch=(url,opts)=>new URL(url,location.href).searchParams.has('locateCode')?new Promise(resolve=>window.__releaseLocate=resolve):window.__fetch(url,opts);document.querySelector('[data-locate-code=ROOT]').click()");
  await wait(() => js("typeof window.__releaseLocate==='function'"), 'pending locate');
  await click('#seg-mode [data-mode=top]'); await wait(() => js("document.querySelector('#seg-mode [data-mode=top]')?.classList.contains('active') && !!document.querySelector('#tbl-body')"), 'newer table');
  await js("window.__releaseLocate(new Response(JSON.stringify({error:{message:'编码不存在'}}),{status:404,headers:{'Content-Type':'application/json'}}));window.fetch=window.__fetch");
  await sleep(100); assert.ok(await js("!document.querySelector('#modal').open && document.querySelector('#sc-code').value==='L00' && !document.querySelector('.supplier-located')"));
  checks.push('late locate responses cannot change a newer table or open a stale dialog');
  await click('#tbl-body [data-supplier=L00] .fc-supplier-code [data-code]');
  await wait(() => js("!!document.querySelector('#graph-container') && document.querySelector('#sc-code').value==='L00'"), 'supplier network jump');
  checks.push('supplier code click continues to open its network graph');
  assert.deepEqual(errors, []); fs.writeFileSync(path.join(out, 'summary-location-browser.json'), JSON.stringify({ checks, errors }, null, 2)); console.log(JSON.stringify({ checks, errors }, null, 2));
})().catch(e => { console.error(e); console.error(logs.slice(-2500)); process.exitCode = 1; }).finally(() => { ws?.close(); chrome?.kill(); app.kill(); });
