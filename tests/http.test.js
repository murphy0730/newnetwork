'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs'), os = require('node:os');
const { spawn } = require('node:child_process');
test('HTTP roles, AI read/simulation tools, async jobs, exports and protected baseline', { timeout: 300000 }, async () => {
  const port = 8795, base = 'http://127.0.0.1:' + port, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-http-'));
  const admin = 'admin-' + 'x'.repeat(24), planner = 'plan-' + 'x'.repeat(24), viewer = 'view-' + 'x'.repeat(24);
  const child = spawn(process.execPath, ['server/main.js'], { cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'ignore', env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DB_PATH: path.join(dir, 'test.sqlite'), API_ADMIN_TOKEN: admin, API_PLANNER_TOKEN: planner, API_VIEWER_TOKEN: viewer } });
  const req = async (url, token, data, headers = {}) => fetch(base + url, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(10000) });
  async function job(url, token, data) { const response = await req(url, token, data); assert.equal(response.status, 202); const initial = await response.json(); for (let n = 0; n < 400; n++) { await new Promise(r => setTimeout(r, 150)); const j = await (await req('/api/jobs/' + initial.jobId, token)).json(); if (j.status === 'failed') throw Error(JSON.stringify(j.error)); if (j.status === 'completed') return j.result; } throw Error('job timeout'); }
  try {
    for (let n = 0; n < 100; n++) { try { if ((await req('/api/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    assert.equal((await req('/api/meta')).status, 401);
    assert.equal((await req('/api/sample', viewer, { baseRevision: 0 })).status, 403);
    assert.equal((await req('/api/sample', admin, { baseRevision: 0 }, { Origin: 'https://untrusted.example' })).status, 403);
    const m = await job('/api/sample', admin, { baseRevision: 0 }), version = m.versions.at(-1), month = m.months[0];
    const query = new URLSearchParams({ version, month, mode: 'cross' });
    assert.equal((await req('/api/diagnostics', viewer)).status, 403);
    assert.ok((await (await req('/api/diagnostics', admin)).json()).reader.ready);
    const insight = await (await req('/api/insights?code=A&' + query, viewer)).json(); assert.equal(insight.generator.llmUsed, false); assert.equal(insight.facts.find(f => f.id === 'supply_shortage').evidence.gap, 100);
    const prepared = await job('/api/scenarios/prepare', planner, { version, month }); assert.equal(prepared.ready, true); assert.equal(prepared.trace.revision, 1);
    assert.equal((await req('/api/scenarios/prepare', viewer, {})).status, 403);
    const explanation = await (await req('/api/ai/invoke', viewer, { tool: 'summarize_code', arguments: { code: 'A', version, month } })).json(); assert.equal(explanation.code, 'A'); assert.equal(explanation.trace.revision, 1);
    const r = await (await req('/api/analysis?' + query, viewer)).json(); assert.equal(r.rows.find(r => r.code === 'A').gap, 100);
    const ai = await (await req('/api/ai/invoke', viewer, { tool: 'explain_code', arguments: { code: 'A', version, month } })).json(); assert.equal(ai.gap, 100); assert.equal(ai.trace.revision, 1);
    assert.equal((await req('/api/ai/invoke', viewer, { tool: 'simulate_forecast', arguments: {} })).status, 403);
    const sim = await job('/api/ai/invoke', planner, { tool: 'simulate_forecast', arguments: { version, month, baseRevision: 1, changes: [{ code: 'A', month, operation: 'add', value: 200 }] } }); assert.ok(sim.affected.some(x => x.code === 'A' && x.afterGap === -100));
    assert.equal((await req('/api/ai/invoke', viewer, { tool: 'execute_sql', arguments: {} })).status, 400);
    assert.equal((await req('/api/ai/invoke', viewer, { tool: 'constructor', arguments: {} })).status, 400);
    assert.equal((await req('/api/ai/invoke', viewer, [])).status, 400);
    assert.equal((await req('/api/tables?table=__proto__', viewer)).status, 400);
    const after = await (await req('/api/analysis?' + query, viewer)).json(); assert.equal(after.rows.find(r => r.code === 'A').gap, 100);
    const spec = await (await req('/api/openapi.json', viewer)).json(); assert.ok(spec.paths['/api/scenarios']); assert.ok(spec.paths['/api/import/preview']);
    const excel = await req('/api/export?kind=sample', viewer); assert.ok(excel.headers.get('content-type').includes('spreadsheetml'));
    const bytes = await excel.arrayBuffer();
    async function upload(name, bytes) {
      const response = await fetch(base + '/api/import/file?name=' + encodeURIComponent(name), { method: 'POST', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/octet-stream' }, body: bytes });
      assert.equal(response.status, 202); const initial = await response.json();
      for (let n = 0; n < 400; n++) { await new Promise(r => setTimeout(r, 150)); const result = await (await req('/api/jobs/' + initial.jobId, admin)).json(); if (result.status === 'failed') throw Error(JSON.stringify(result.error)); if (result.status === 'completed') return result.result; }
      throw Error('upload timeout');
    }
    const file = await upload('最新样例.xlsx', bytes);
    const preview = await job('/api/import/preview', admin, { baseRevision: 1, files: [{ id: file.id, selections: file.sheets.filter(s => s.detected).map(s => ({ sheet: s.name, table: s.detected.table })) }] });
    const imported = await job('/api/import/commit', admin, { previewId: preview.previewId });
    assert.equal(imported.codes, 1000); assert.equal(imported.kind, 'imported');
    const graph = await (await req('/api/graph?code=MD-01&graphRelations=bom&limit=100', viewer)).json(); assert.ok(graph.nodes.length); assert.ok(graph.edges.length);
    for (const asset of ['/forecast-graph.js', '/vendor/g6.min.js']) assert.equal((await req(asset)).status, 200);
    const csv = await upload('预测.csv', Buffer.from('计划日期,编码,预测月份,预测数量,加工地代码\n2026-09-10,CSV-0001,2026-09,120,S001\n'));
    const csvPreview = await job('/api/import/preview', admin, { baseRevision: imported.revision, files: [{ id: csv.id, selections: [{ sheet: csv.sheets[0].name, table: 'forecast' }] }] });
    const csvMeta = await job('/api/import/commit', admin, { previewId: csvPreview.previewId });
    assert.equal(csvMeta.revision, 3);
    const csvData = await (await req('/api/analysis?version=2026-09-10&month=2026-09&search=CSV-0001', viewer)).json(); assert.equal(csvData.rows[0].supply, 120); assert.equal(csvData.rows[0].single, true);
    assert.equal((await req('/data/control-tower.sqlite', admin)).status, 404);
  } finally { child.kill(); }
});
