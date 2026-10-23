'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../forecast-core'), Engine = require('../server/engine'), { Service } = require('../server/service');
function fixture() {
  const s = C.empty(), month = '2026-09', version = '2026-09-24';
  for (const code of ['ZERO', 'MISSING', 'STOCK', 'NEG_STOCK', 'REMOVE', 'ADD', 'LATER', 'OUTSIDE', 'EXCLUDED', 'NEG_FORECAST', 'C']) {
    s.tables.attributes.push({ code, make_dept: code === 'C' ? 'Y' : 'X' });
    if (code !== 'MISSING') for (const m of [month, '2026-10']) s.tables.forecast.push({ code, month: m, plan_date: version, qty: code === 'C' ? 50 : code === 'NEG_FORECAST' ? -3 : code === 'LATER' && m === '2026-10' ? 4 : 0 });
    if (code !== 'C') s.tables.bom.push({ parent: code, child: 'C', qty: 1 });
  }
  s.tables.inventory = [{ code: 'STOCK', date: '2020-01-01', qty: 8 }, { code: 'NEG_STOCK', date: '2020-01-01', qty: -2 }, { code: 'EXCLUDED', date: '2020-01-01', qty: 10, sub_type: '备件-坏件子库' }];
  s.tables.adjust = [{ code: 'REMOVE', month, direction: '使用', qty: 3 }, { code: 'ADD', month, direction: '供应', qty: 5 }, { code: 'OUTSIDE', month: '2026-11', direction: '供应', qty: 9 }];
  return s;
}
function query(s, options = {}) {
  const engine = new Engine(s), svc = Object.create(Service.prototype);
  svc.context = q => ({ engine, month: q.month, mode: q.mode, source: q.source || 'forecast', trace: { revision: 0, version: engine.version } });
  return svc.list({ summary: 1, code: 'C', month: '2026-09', mode: 'cross', ...options }, 'test');
}

test('empty-source metadata checks source forecasts, effective inventory and original adjustments in all modes', () => {
  for (const input_mode of ['net', 'raw']) for (const mode of ['direct', 'cross', 'top']) {
    const s = fixture(); s.config.input_mode = input_mode;
    const result = query(s, { mode }), row = result.rows[0];
    assert.deepEqual(row.targets.filter(t => t.empty).map(t => t.code).sort(), ['EXCLUDED', 'LATER', 'MISSING', 'OUTSIDE', 'ZERO']);
    // Visibility is metadata: no sources, totals or KPI counts are removed from calculation.
    assert.equal(row.targetCount, 10); assert.equal(row.targets.length, 10);
    assert.equal(row.demand, input_mode === 'raw' ? 6 : 3);
    assert.equal(result.total, 1);
    assert.equal(result.dashboard.incomplete, Number(!row.complete && !row.passThrough));
  }
});

test('multi-month visibility checks each month before aggregation, retaining later activity and signed amounts', () => {
  for (const periodMode of ['individual', 'cumulative']) {
    const row = query(fixture(), { span: 2, periodMode }).rows[0];
    assert.deepEqual(row.targets.filter(t => t.empty).map(t => t.code).sort(), ['EXCLUDED', 'MISSING', 'OUTSIDE', 'ZERO']);
    assert.equal(row.targets.find(t => t.code === 'NEG_STOCK').empty, false);
    assert.equal(row.targets.find(t => t.code === 'NEG_FORECAST').empty, false);
  }
  const s = fixture();
  s.tables.forecast.filter(r => r.code === 'LATER').forEach(r => { r.qty = r.month === '2026-09' ? 4 : -4; });
  assert.equal(query(s, { span: 2, periodMode: 'cumulative' }).rows[0].targets.find(t => t.code === 'LATER').empty, false);
});

test('missing inventory snapshots and missing predictions qualify; nonzero adjustments never cancel for visibility', () => {
  const s = fixture(); s.tables.inventory = [];
  s.tables.adjust.push({ code: 'ZERO', month: '2026-09', direction: '供应', qty: 5 }, { code: 'ZERO', month: '2026-09', direction: '供应', qty: -5 });
  const row = query(s).rows[0];
  assert.equal(row.targets.find(t => t.code === 'MISSING').empty, true);
  assert.equal(row.targets.find(t => t.code === 'STOCK').empty, true);
  assert.equal(row.targets.find(t => t.code === 'ZERO').empty, false);
});
