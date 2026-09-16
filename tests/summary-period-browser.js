'use strict';
// 汇总表单独/累计月份：按界面文字选择并验证逐月异值和Excel。
// 通过 Chrome DevTools Protocol 驱动，无第三方依赖。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-output'); fs.mkdirSync(out, { recursive: true });
const suffix = Date.now(), appPort = Number(process.env.TEST_PORT || 8799), debugPort = Number(process.env.DEBUG_PORT || 9339);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const env = { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', DB_PATH: path.join(out, `period-ui-${suffix}.sqlite`), API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '' };
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
  const C = require('../forecast-core'), { Service } = require('../server/service'), data = C.empty();
  data.kind = 'imported'; data.config.input_mode = 'raw';
  data.tables.attributes = [{ code: 'P', make_dept: 'a', lead_mean: 1 }, { code: 'C', make_dept: 'b', lead_mean: 1 }];
  data.tables.bom = [{ id: 'B1', parent: 'P', child: 'C', qty: 2 }];
  for (let i = 0; i < 3; i++) {
    const month = C.addMonth('2026-09', i);
    for (const [code, qty] of [['P', 200 + i * 100], ['C', 100 + i * 100]]) data.tables.forecast.push({ code, month, plan_date: '2026-09-01', qty, site_code: 'S' });
    data.tables.adjust.push({ code: 'C', purchase_code: 'BUY-C', direction: '供应', month, qty: 10 * (i + 1) }, { code: 'C', purchase_code: '', direction: '使用', month, qty: 5 * (i + 1) });
    data.tables.inventory.push({ code: 'C', date: month + '-01', qty: [50, 700, 900][i] });
  }
  const s = new Service(db); try { s.publish(data, 0, 'local', 'test'); } finally { s.store.close(); }
}
async function choose(label) {
  await js(`{ const el=document.querySelector('#tbl-period-mode'); const option=[...el.options].find(o=>o.textContent===${JSON.stringify(label)}); if(!option) throw Error('Missing option'); el.value=option.value; el.dispatchEvent(new Event('change')); }`);
  const expected = label === '累计月份' ? 1 : 3;
  await wait(() => js(`document.querySelectorAll('#tbl-body th[data-period-start]').length===${expected}`), label);
  return js(`({value:document.querySelector('#tbl-period-mode').value, headings:[...document.querySelectorAll('#tbl-body th[data-period-start]')].map(c=>c.textContent), groups:(()=>{const row=document.querySelector('#tbl-body tr[data-supplier="C"]'); const headers=[...document.querySelector('#tbl-body thead').rows[1].cells]; let offset=0; return [...document.querySelectorAll('#tbl-body th[data-period-start]')].map(h=>{const values={}; for(let i=0;i<h.colSpan;i++) values[headers[offset+i].textContent]=row.cells[7+offset+i].textContent; offset+=h.colSpan;return values;});})()})`);
}
async function exported() {
  await js('window.__exported=null;XLSX.writeFile=wb=>window.__exported=XLSX.utils.sheet_to_json(wb.Sheets.data)');
  await click('#export-table'); await wait(() => js('!!window.__exported && !document.body.hasAttribute("aria-busy")'), 'Excel export');
  return js('window.__exported');
}
(async () => {
  const base = 'http://127.0.0.1:' + appPort;
  await wait(async () => (await fetch(base + '/api/health')).ok, 'server');
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(out, 'period-chrome-' + suffix), 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); chrome.stderr.on('data', b => logs += b);
  let targets; await wait(async () => { targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json(); return targets.some(t => t.type === 'page'); }, 'Chrome');
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: base }); await click('#seg-view [data-view="table"]');
  await wait(() => js("!!document.querySelector('#tbl-span')"), 'table');
  await js("document.querySelector('#sc-code').value='C';document.querySelector('#apply').click()");
  await wait(() => js("document.querySelector('#pg-total')?.textContent.includes('共 1 个编码')"), 'focus');
  await js("{const el=document.querySelector('#tbl-span');el.value='3';el.dispatchEvent(new Event('change'));}");
  await wait(() => js("document.querySelectorAll('#tbl-body th[data-period-start]').length===3"), 'three months');
  const evidence = [];
  for (const mode of ['direct', 'cross', 'top']) {
    await click('#seg-mode [data-mode="' + mode + '"]');
    await wait(() => js("!!document.querySelector('#tbl-period-mode')"), 'mode render');
    const individual = await choose('单独月份');
    assert.ok(await js("document.querySelector('#tbl-count').textContent.includes('3个月分别展示3组结果，不跨月累加')"));
    assert.equal(individual.value, 'individual'); assert.deepEqual(individual.headings, ['2026年9月', '2026年10月', '2026年11月']);
    for (const [field, expected] of [['表1预测', ['100', '200', '300']], ['供应添加', ['10', '20', '30']], ['使用剔除', ['5', '10', '15']], ['净供应', ['110', '220', '330']], ['来源折算需求', ['400', '600', '800']], ['预测缺口', ['290', '380', '470']]]) assert.deepEqual(individual.groups.map(g => g[field]), expected, mode + '/' + field);
    assert.deepEqual(individual.groups.map(g => g['库存后缺口']), ['240', undefined, undefined]);
    const separateExport = await exported();
    assert.equal(separateExport[0]['计算方式'], '单独月份'); assert.equal(separateExport[0]['净供应 2026年10月'], 220);
    const cumulative = await choose('累计月份'); assert.equal(cumulative.value, 'cumulative'); assert.deepEqual(cumulative.headings, ['2026年9-11月']);
    assert.ok(await js("document.querySelector('#tbl-count').textContent.includes('3个月合并为1组供需合计')"));
    const total = cumulative.groups[0];
    for (const [field, expected] of Object.entries({ '表1预测': '600', '供应添加': '60', '使用剔除': '30', '净供应': '660', '来源折算需求': '1,800', '预测缺口': '1,140', '起始月库存': '50', '库存后缺口': '1,090' })) assert.equal(total[field], expected, mode + '/' + field);
    const cumulativeExport = await exported(); assert.equal(cumulativeExport[0]['计算方式'], '累计月份'); assert.equal(cumulativeExport[0]['净供应 2026年9-11月'], 660);
    assert.equal(cumulativeExport[0]['库存后缺口 2026年9-11月'], 1090);
    evidence.push({ mode, individual, cumulative }); checks.push(mode + ': label selection, per-month values, cumulative sums and Excel agree');
    assert.deepEqual(await choose('单独月份'), individual); checks.push(mode + ': switching back restores individual values');
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'summary-period-browser.json'), JSON.stringify({ checks, errors, evidence }, null, 2));
  console.log(JSON.stringify({ checks, errors, individualSupply: [110, 220, 330], cumulativeSupply: 660, individualDemand: [400, 600, 800], cumulativeDemand: 1800 }, null, 2));
})().catch(e => { console.error(e); console.error(logs.slice(-2000)); process.exitCode = 1; }).finally(() => { ws?.close(); chrome?.kill(); app.kill(); });
