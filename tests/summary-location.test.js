'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../forecast-core'), Engine = require('../server/engine'), { Service } = require('../server/service');
const month = '2026-09', version = '2026-09-24';
function service() {
  const s = C.empty();
  for (const code of ['UP', 'ROOT', 'ISO', ...Array.from({ length: 30 }, (_, i) => 'L' + String(i).padStart(2, '0'))]) {
    const leaf = code.startsWith('L');
    s.tables.attributes.push({ code, make_dept: leaf ? '子产业' : code === 'ROOT' ? '父产业' : '上产业', part_category: leaf ? '子大类' : '父大类', lead_mean: 1 });
    for (const m of [month, '2026-10']) s.tables.forecast.push({ code, month: m, plan_date: version, qty: leaf ? 10 : 1000, site_code: leaf ? 'S_LEAF' : 'S_TARGET' });
    if (leaf || code === 'ROOT') s.tables.bom.push({ parent: leaf ? 'ROOT' : 'UP', child: code, qty: 1 });
  }
  const engine = new Engine(s), svc = Object.create(Service.prototype);
  svc.context = q => ({ engine, month: q.month || month, mode: q.mode || 'cross', source: q.source || 'forecast', trace: { revision: 1, version } });
  return svc;
}
const base = { summary: 1, month, mode: 'cross', limit: 20 };
test('locates a supplier on its actual sorted page in every mode and period calculation', () => {
  const svc = service();
  for (const mode of ['direct', 'cross', 'top']) for (const periodMode of ['individual', 'cumulative']) {
    const q = { ...base, mode, periodMode, span: 2 };
    const all = svc.list({ ...q, limit: 1000 }, 'test'), index = all.rows.findIndex(r => r.code === 'ROOT');
    const located = svc.list({ ...q, locateCode: 'ROOT' }, 'test');
    assert.ok(index >= 20); assert.equal(located.location.index, index);
    assert.equal(located.offset, Math.floor(index / 20) * 20); assert.equal(located.location.page, 2);
    assert.deepEqual(located.location.clearedFilters, []);
    assert.equal(located.rows[index - located.offset].code, 'ROOT');
    assert.equal(located.total, all.total); assert.deepEqual(located.spanMonths, all.spanMonths);
  }
});
test('automatically clears exactly the dimensions excluding a target without mutating the request', () => {
  const svc = service(), q = { ...base, locateCode: 'ROOT', span: 2, periodMode: 'cumulative', code: 'L00', search: 'L', codes: ['L00'], site: ['S_LEAF'], industry: '子产业', category: '子大类', risk: 'shortage', sourceIndustry: '父产业' };
  const original = C.copy(q), result = svc.list(q, 'test');
  assert.deepEqual(q, original);
  assert.deepEqual([...result.location.clearedFilters].sort(), ['code', 'search', 'codes', 'site', 'industry', 'category', 'risk', 'sourceIndustry'].sort());
  assert.deepEqual(result.location.filters, { code: '', search: '', codes: [], site: [], industry: '', category: '', risk: '', sourceIndustry: '' });
  assert.ok(result.rows.some(r => r.code === 'ROOT')); assert.equal(result.periodMode, 'cumulative');
  assert.deepEqual(result.spanMonths, [month, '2026-10']);
});
test('preserves compatible filters and the search-or-selected-code semantics', () => {
  const svc = service(), q = { ...base, locateCode: 'ROOT', search: 'does-not-match', codes: ['ROOT', 'L00'], site: ['S_TARGET'], industry: '父产业', category: '父大类', risk: 'single', sourceIndustry: '上产业' };
  const result = svc.list(q, 'test');
  assert.deepEqual(result.location.clearedFilters, []); assert.equal(result.total, 1);
  assert.equal(result.rows[0].code, 'ROOT'); assert.equal(result.location.filters.search, q.search);
  assert.deepEqual(result.location.filters.codes, ['L00', 'ROOT']);
  assert.equal(result.location.filters.sourceIndustry, '上产业');
});
test('can locate an independent supplier and rejects a missing code without changing filters', () => {
  const svc = service(), isolated = svc.list({ ...base, locateCode: 'ISO', linked: '1', sourceIndustry: '父产业' }, 'test');
  assert.ok(isolated.rows.some(r => r.code === 'ISO'));
  assert.deepEqual([...isolated.location.clearedFilters].sort(), ['linked', 'sourceIndustry']);
  assert.throws(() => svc.list({ ...base, locateCode: 'MISSING', code: 'L00' }, 'test'), e => e.status === 404 && e.message === '编码不存在');
  assert.throws(() => svc.list({ ...base, summary: 0, locateCode: 'ROOT' }, 'test'), /仅供应汇总表支持编码定位/);
});
