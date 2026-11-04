'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../forecast-core'), Engine = require('../server/engine'), { Service } = require('../server/service');
const month = '2026-09', version = '2026-09-24';
function service() {
  const s = C.empty();
  for (const [code, sep, oct] of [['P', 100, 100], ['SMALL', 95, 95], ['LARGE', 10, 10], ['SWING', 0, 250], ['LATER', 100, 0], ['UNKNOWN', null, null]]) {
    s.tables.attributes.push({ code, make_dept: code === 'P' ? 'X' : 'Y' });
    for (const [m, qty] of [[month, sep], ['2026-10', oct]]) if (qty != null) s.tables.forecast.push({ code, qty, month: m, plan_date: version });
    if (code !== 'P') s.tables.bom.push({ parent: 'P', child: code, qty: 1 });
  }
  s.tables.inventory.push({ code: 'LARGE', date: '2020-01-01', qty: 1000 });
  const engine = new Engine(s), svc = Object.create(Service.prototype);
  svc.context = q => ({ engine, month: q.month || month, mode: q.mode || 'cross', source: q.source || 'forecast', trace: { revision: 0, version } });
  return svc;
}
test('largest supply shortages lead globally before pagination in every summary mode', () => {
  const svc = service();
  for (const mode of ['direct', 'cross', 'top']) {
    const q = { summary: 1, month, mode }, all = svc.list(q, 'test');
    assert.deepEqual(all.rows.slice(0, 3).map(r => r.code), ['SWING', 'LARGE', 'SMALL']);
    assert.equal(all.rows[1].coverageGap, -910, 'inventory does not alter supply-shortage ordering');
    const paged = [];
    for (let offset = 0; offset < all.total; offset += 2) paged.push(...svc.list({ ...q, limit: 2, offset }, 'test').rows.map(r => r.code));
    assert.deepEqual(paged, all.rows.map(r => r.code));
  }
});
test('individual months rank the largest visible monthly shortage; cumulative months rank the net period shortage', () => {
  const svc = service();
  for (const mode of ['direct', 'cross', 'top']) {
    const q = { summary: 1, month, mode, span: 2 };
    const individual = svc.list(q, 'test'), cumulative = svc.list({ ...q, periodMode: 'cumulative' }, 'test');
    assert.deepEqual(individual.rows.slice(0, 4).map(r => r.code), ['LATER', 'SWING', 'LARGE', 'SMALL']);
    assert.deepEqual(cumulative.rows.slice(0, 3).map(r => r.code), ['LARGE', 'LATER', 'SMALL']);
    assert.equal(cumulative.rows.find(r => r.code === 'SWING').gap, -50);
    const filtered = svc.list({ ...q, sourceIndustry: 'X', limit: 2 }, 'test');
    assert.deepEqual(filtered.rows.map(r => r.code), ['LATER', 'SWING']);
  }
});
test('months outside the version remain unknown and do not cause online recomputation when sorting', () => {
  const svc = service(), q = { summary: 1, month, mode: 'cross', span: 3 };
  const individual = svc.list(q, 'test'), cumulative = svc.list({ ...q, periodMode: 'cumulative' }, 'test');
  assert.deepEqual(individual.rows.slice(0, 3).map(r => r.code), ['LATER', 'SWING', 'LARGE']);
  assert.equal(cumulative.rows.find(r => r.code === 'LARGE').gap, null);
  assert.equal(cumulative.rows.find(r => r.code === 'UNKNOWN').gap, null);
});
