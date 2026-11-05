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
  const parents = ['ZERO', 'MISSING', 'STOCK', 'NEG_STOCK', 'REMOVE', 'ADD', 'LATER', 'OUTSIDE', 'EXCLUDED', 'NEG_FORECAST'];
  for (const code of [...parents, 'H', 'HONLY']) {
    data.tables.attributes.push({ code, make_dept: parents.includes(code) ? 'X' : 'Y', lead_mean: 1 });
    if (code !== 'MISSING') for (const month of ['2026-09', '2026-10']) f(code, code === 'H' || code === 'HONLY' ? 50 : code === 'NEG_FORECAST' ? -3 : code === 'LATER' && month === '2026-10' ? 4 : 0, month);
  }
  for (const parent of parents) data.tables.bom.push({ id: parent+'-H', parent, child: 'H', qty: 1, parent_template: 'AI', child_template: 'AI' });
  for (const parent of ['ZERO', 'MISSING']) data.tables.bom.push({ id: parent+'-HONLY', parent, child: 'HONLY', qty: 1, parent_template: 'AI', child_template: 'AI' });
  data.tables.inventory = [{ code: 'STOCK', date: '2020-01-01', qty: 8 }, { code: 'NEG_STOCK', date: '2020-01-01', qty: -2 }, { code: 'EXCLUDED', date: '2020-01-01', qty: 10, sub_type: '备件-坏件子库' }];
  data.tables.adjust = [{ code: 'REMOVE', month: '2026-09', direction: '使用', qty: 3 }, { code: 'ADD', month: '2026-09', direction: '供应', qty: 5 }, { code: 'OUTSIDE', month: '2026-11', direction: '供应', qty: 9 }];
  Object.assign(data.tables.attributes.find(r => r.code === 'C'), { name: '名称-C', part_category: '大类-C', part_subcategory: '小类-C', make_obj_package1: '对象包-C' });
  for (const code of ['ROOT-Y', 'ZERO-SUPPLY', ...Array.from({ length: 25 }, (_, i) => 'T' + String(i).padStart(2, '0'))]) {
    data.tables.attributes.push({ code, name: '不展示名称-' + code, make_dept: code === 'ROOT-Y' ? 'Y' : 'X', part_category: '大类-' + code, part_subcategory: '小类-' + code, make_obj_package1: '对象包-' + code });
    for (const month of ['2026-09', '2026-10']) f(code, code === 'ROOT-Y' ? 0 : 50, month);
    if (code !== 'ROOT-Y') for (const parent of code === 'ZERO-SUPPLY' ? ['ROOT-Y'] : ['ROOT-Y', 'R']) data.tables.bom.push({ id: parent + '-' + code, parent, child: code, qty: 1, parent_template: 'AI', child_template: 'AI' });
  }
  data.tables.inventory.push({ code: 'ZERO-SUPPLY', date: '2020-01-01', qty: 20 });
  const service = new Service(db); try { service.publish(data, 0, 'local', 'test'); } finally { service.store.close(); }
}
async function exported() {
  await js('window.__exported=null;XLSX.writeFile=wb=>window.__exported=XLSX.utils.sheet_to_json(wb.Sheets.data)');
  await click('#export-table'); await wait(() => js('!!window.__exported && !document.body.hasAttribute("aria-busy")'), 'Excel export');
  return js('window.__exported');
}
async function expandSupplier(code) {
  await wait(() => js(`!!document.querySelector(${JSON.stringify('[data-supplier="' + code + '"]')})`), 'supplier ' + code);
  await js(`{const button=document.querySelector(${JSON.stringify('[data-toggle-supplier="' + code + '"]')});if(button&&!button.disabled&&button.getAttribute('aria-expanded')==='false')button.click();}`);
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
  await wait(() => js("document.querySelectorAll('#tbl-body th[data-period-start]').length===2"), 'source months');
  await expandSupplier('C');
  await wait(() => js("document.querySelectorAll('#tbl-body tr[data-supplier=\"C\"]').length===2"), 'source union');
  const rows = await exported(), a = rows.find(r => r['跨产业编码']==='A'), b = rows.find(r => r['跨产业编码']==='B');
  assert.deepEqual(await js("[...document.querySelectorAll('#tbl-body thead tr:first-child th[rowspan=\"2\"]')].map(th=>th.firstChild.textContent)"), ['编码','产业部门','产品大类','产品小类','加工对象包','跨产业编码','来源产业','累计BOM用量']);
  assert.deepEqual([a['产品大类'], a['产品小类'], a['加工对象包']], ['大类-C','小类-C','对象包-C']); assert.equal('名称' in a, false);
  assert.ok(await js("document.querySelector('#tbl-body').textContent.includes('对象包-C') && !document.querySelector('#tbl-body').textContent.includes('名称-C')"));
  checks.push('supplier attributes use manufacturing fields in table and Excel, and the name column is removed');
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
  await expandSupplier('V');
  const varying = await exported(), root = varying.find(r=>r['跨产业编码']==='R');
  assert.equal(root['来源BOM用量 2026年9月'],5); assert.equal(root['来源BOM用量 2026年10月'],3);
  assert.equal(root['跨产业总需求 2026年9月'],500); assert.equal(root['跨产业总需求 2026年10月'],330);
  assert.ok(String(root['累计BOM用量']).includes('2026-09：5') && String(root['累计BOM用量']).includes('2026-10：3'));
  assert.ok(await js("document.querySelector('#tbl-body').textContent.includes('2026-09：5；2026-10：3')"));
  checks.push('variable source coefficients are visible and exported as 5 then 3');
  await js("{const el=document.querySelector('#tbl-period-mode');el.value='cumulative';el.dispatchEvent(new Event('change'));}");
  await wait(() => js("document.querySelectorAll('#tbl-body th[data-period-start]').length===1"), 'cumulative');
  const cumulative = await exported(); assert.equal(cumulative.reduce((sum,r)=>sum+(r['跨产业总需求 2026年9-10月']||0),0),830);
  await js("document.querySelector('#sc-code').value='H';document.querySelector('#apply').click()");
  await wait(() => js("document.querySelectorAll('#tbl-body tr[data-supplier=H]').length===1"), 'supplier collapsed by default');
  assert.equal(await js("document.querySelector('[data-toggle-supplier=H]').getAttribute('aria-expanded')"), 'false');
  assert.equal(await js("document.querySelectorAll('#tbl-body [data-code]').length"), 1);
  const foldedBalances = await js("[...document.querySelectorAll('#tbl-body .fc-gap')].map(el=>el.textContent)");
  const foldedExport = await exported(); assert.equal(foldedExport.length, 10);
  const foldedShot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'summary-folded.png'), Buffer.from(foldedShot.data, 'base64'));
  await expandSupplier('H');
  assert.equal(await js("document.querySelectorAll('#tbl-body tr[data-supplier=H]').length"), 10);
  assert.deepEqual(await js("[...document.querySelectorAll('#tbl-body .fc-gap')].map(el=>el.textContent)"), foldedBalances);
  await click('[data-toggle-supplier=H]');
  assert.equal(await js("document.querySelectorAll('#tbl-body tr[data-supplier=H]').length"), 1);
  assert.equal(await js("document.activeElement.dataset.toggleSupplier"), 'H');
  await expandSupplier('H');
  checks.push('suppliers default to one total row; expand/collapse preserves totals and focus while exports retain details');
  assert.equal(await js("document.querySelector('#tbl-hide-empty').getAttribute('aria-pressed')"), 'false');
  const beforeHide = await exported();
  const kpi = await js("document.querySelector('#kpi-grid').textContent");
  await click('#tbl-hide-empty');
  assert.equal(await js("document.querySelectorAll('#tbl-body tr[data-supplier=H]').length"), 6);
  assert.equal(await js("document.querySelector('#tbl-hide-empty').getAttribute('aria-pressed')"), 'true');
  assert.equal(await js("document.querySelector('#kpi-grid').textContent"), kpi);
  const labels = { direct: '父项编码', cross: '跨产业编码', top: '最顶层编码' };
  for (const mode of ['direct', 'cross', 'top']) {
    await click('#seg-mode [data-mode="' + mode + '"]');
    await wait(() => js("document.querySelector('#seg-mode [data-mode=" + mode + "]').classList.contains('active') && !!document.querySelector('#tbl-body tr[data-supplier=H]')"), 'hidden sources mode ' + mode);
    assert.equal(await js("document.querySelectorAll('#tbl-body tr[data-supplier=H]').length"), 1);
    assert.equal(await js("document.querySelectorAll('#tbl-body [data-code]').length"), 1);
    assert.equal(await js("document.querySelector('[data-toggle-supplier=H]').getAttribute('aria-expanded')"), 'false');
    const collapsedExport = await exported();
    await expandSupplier('H');
    assert.equal(await js("document.querySelectorAll('#tbl-body tr[data-supplier=H]').length"), 6);
    const hidden = await exported();
    assert.deepEqual(hidden, collapsedExport, mode + ': folding must not remove exported detail');
    assert.deepEqual(hidden.map(r=>r[labels[mode]]).sort(), ['ADD','LATER','NEG_FORECAST','NEG_STOCK','REMOVE','STOCK']);
    assert.equal(hidden.reduce((sum,r)=>sum+(r['供需结余 2026年9-10月']||0),0), beforeHide.reduce((sum,r)=>sum+(r['供需结余 2026年9-10月']||0),0));
    assert.equal(await js("document.querySelector('#tbl-body tr[data-supplier=H] td').rowSpan"), 6);
    await click('[data-toggle-supplier=H]');
    assert.equal(await js("document.querySelectorAll('#tbl-body tr[data-supplier=H]').length"), 1);
    await expandSupplier('H');
  }
  checks.push('direct, cross and top share default collapse, per-code expand/collapse and complete Excel detail');
  checks.push('toggle hides empty source rows in all three modes and Excel, retaining inventory, signed amounts and original adjustments');
  await js("{const el=document.querySelector('#tbl-period-mode');el.value='individual';el.dispatchEvent(new Event('change'));}");
  await wait(() => js("document.querySelectorAll('#tbl-body th[data-period-start]').length===2"), 'individual hidden sources');
  await expandSupplier('H');
  assert.equal(await js("document.querySelectorAll('#tbl-body tr[data-supplier=H]').length"), 6);
  await js("{const el=document.querySelector('#tbl-span');el.value='1';el.dispatchEvent(new Event('change'));}");
  await wait(() => js("document.querySelectorAll('#tbl-body th[data-period-start]').length===1"), 'single month source months');
  await expandSupplier('H');
  assert.equal(await js("document.querySelectorAll('#tbl-body tr[data-supplier=H]').length"), 5);
  checks.push('multi-month visibility uses every selected month in both individual and cumulative views');
  await click('#tbl-hide-empty');
  assert.equal(await js("document.querySelectorAll('#tbl-body tr[data-supplier=H]').length"), 10);
  await js("document.querySelector('#sc-code').value='HONLY';document.querySelector('#apply').click()");
  await expandSupplier('HONLY');
  assert.equal(await js("document.querySelectorAll('#tbl-body tr[data-supplier=HONLY]').length"), 2);
  const allEmpty = await exported();
  await click('#tbl-hide-empty');
  assert.equal(await js("document.querySelectorAll('#tbl-body tr[data-supplier=HONLY]').length"), 1);
  assert.ok(await js("document.querySelector('#tbl-body').textContent.includes('已隐藏全部无量来源')"));
  const placeholder = await exported();
  assert.equal(placeholder.length, 1); assert.equal(placeholder[0]['最顶层编码'], '已隐藏全部无量来源');
  for (const key of ['净供应 2026年9月', '最顶层总需求 2026年9月', '供需结余 2026年9月', '状态 2026年9月']) assert.equal(placeholder[0][key], allEmpty[0][key]);
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, 'summary-source-visibility.png'), Buffer.from(screenshot.data, 'base64'));
  await click('#tbl-hide-empty');
  assert.equal(await js("document.querySelectorAll('#tbl-body tr[data-supplier=HONLY]').length"), 2);
  checks.push('all-hidden sources keep a labelled supplier total, and toggling off restores source rows');
  await click('#clear');
  await wait(() => js("!!document.querySelector('#tbl-source-industry') && document.querySelector('#sc-code').value===''") , 'clear source filters');
  await click('#seg-mode [data-mode=cross]');
  await wait(() => js("document.querySelector('#seg-mode [data-mode=cross]').classList.contains('active') && !!document.querySelector('#tbl-source-industry')"), 'cross filter');
  await js("{const el=document.querySelector('#tbl-source-industry');el.value='Z';el.dispatchEvent(new Event('change'));}");
  await wait(() => js("document.querySelector('#tbl-source-industry')?.value==='Z' && document.querySelector('#pg-jump').options.length>1"), 'source industry before pagination');
  const expected = await (await fetch(base + '/api/analysis?summary=1&mode=cross&month=2026-09&sourceIndustry=Z&limit=1000')).json();
  assert.ok(expected.total>20); assert.ok(await js(`document.querySelector('#pg-total').textContent.includes('共 ${expected.total} 个编码')`));
  const selectedExport = await exported();
  assert.equal(selectedExport.length, expected.total); assert.ok(selectedExport.every(r=>r['来源产业']==='Z'));
  for (const row of selectedExport) { const original=expected.rows.find(r=>r.code===row['编码']), gap=original.periods[0].gap; assert.equal(row['供需结余 2026年9月'], gap == null ? '' : -gap || 0); }
  await js("{const el=document.querySelector('#pg-jump');el.value='2';el.dispatchEvent(new Event('change'));}");
  await wait(() => js("document.querySelector('#pg-jump')?.value==='2' && document.querySelector('#tbl-source-industry')?.value==='Z'"), 'filtered second page');
  const pageCodes = await js("[...document.querySelectorAll('#tbl-body [data-toggle-supplier]')].map(el=>el.dataset.toggleSupplier)");
  for (const code of pageCodes) await expandSupplier(code);
  assert.ok(await js("[...document.querySelectorAll('#tbl-body tbody tr[data-supplier]')].every(r=>r.textContent.includes('Z'))"));
  const columnsShot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'summary-columns-source-filter.png'), Buffer.from(columnsShot.data, 'base64'));
  checks.push('source industry selector filters suppliers before pagination, persists on page two and exports all matching rows');
  await click('#clear'); await wait(() => js("document.querySelector('#tbl-source-industry')?.value===''") , 'clear source industry');
  await js("document.querySelector('#sc-code').value='ZERO-SUPPLY';document.querySelector('#apply').click()");
  await wait(() => js("!!document.querySelector('#tbl-body tr[data-supplier=\"ZERO-SUPPLY\"]')"), 'zero demand');
  const zeroDemand = await exported();
  assert.deepEqual([zeroDemand[0]['跨产业总需求 2026年9月'],zeroDemand[0]['供需结余 2026年9月'],zeroDemand[0]['库存后结余 2026年9月']], [0,50,70]);
  await js("window.__originalFetch=window.fetch;window.fetch=async(url,opts)=>{const r=await window.__originalFetch(url,opts),u=new URL(url,location.href);if(u.pathname==='/api/analysis'&&u.searchParams.get('summary')==='1'&&u.searchParams.get('code')==='ZERO-SUPPLY'){const d=await r.json();for(const row of d.rows){row.demand=null;for(const p of row.periods)p.demand=null;}return new Response(JSON.stringify(d),{status:r.status,headers:{'Content-Type':'application/json'}});}return r;};document.querySelector('#apply').click()");
  await wait(() => js("(()=>{const th=[...document.querySelectorAll('#tbl-body thead tr:last-child th')],i=th.findIndex(h=>h.textContent==='跨产业总需求'),lead=document.querySelectorAll('#tbl-body thead tr:first-child th[rowspan=\"2\"]').length;return document.querySelector('#tbl-body tbody tr').cells[lead+i]?.textContent==='—';})()"), 'independent balances with missing demand');
  const missingDemand = await exported();
  assert.deepEqual([missingDemand[0]['跨产业总需求 2026年9月']??'',missingDemand[0]['供需结余 2026年9月'],missingDemand[0]['库存后结余 2026年9月']], ['',50,70]);
  assert.ok(await js("document.querySelector('#tbl-body tbody tr').textContent.includes('70')"));
  await js("window.fetch=window.__originalFetch");
  checks.push('zero or missing demand never masks independent supply and inventory balances in the table or Excel');
  assert.deepEqual(errors, []); checks.push('cumulative export sums the per-month frontiers exactly once');
  fs.writeFileSync(path.join(out, 'calculation-sources-browser.json'), JSON.stringify({checks,errors,rows,varying,cumulative},null,2));
  console.log(JSON.stringify({checks,errors},null,2));
})().catch(e => { console.error(e); console.error(logs.slice(-2000)); process.exitCode = 1; }).finally(() => { ws?.close(); chrome?.kill(); app.kill(); });
