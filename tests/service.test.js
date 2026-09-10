'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Service } = require('../server/service');
const C = require('../forecast-core');
test('transaction preview, persistence, stale conflict, actor isolation and pinned scenario', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-test-')), db = path.join(dir, 'test.sqlite'), service = new Service(db), actor = 'test';
  try {
    assert.equal(service.meta(actor).codes, 0); service.sample({ baseRevision: 0 }, actor); const meta = service.meta(actor), version = meta.versions.at(-1), month = meta.months[0];
    const baseline = service.list({ version, month, mode: 'cross', search: 'A' }, actor); assert.equal(baseline.rows.find(r => r.code === 'A').gap, 100);
    const scenario = service.simulate({ baseRevision: 1, version, month, changes: [{ code: 'A', month, operation: 'percent', value: 20 }] }, actor); assert.equal(service.store.revision(), 1); assert.equal(service.detail({ code: 'A', scenario: scenario.id, month }, actor).gap, -100); assert.throws(() => service.detail({ code: 'A', scenario: scenario.id, month }, 'other'), /无权/);
    const noOp = service.simulate({ baseRevision: 1, version, month, type: 'quality', code: 'A', delayDays: 0, scrapQty: 0 }, actor); assert.equal(noOp.affectedRows, 0);
    assert.throws(() => service.preview({ baseRevision: 1, batches: [{ table: 'bom', rows: [{ parent: 'A', child: 'A', qty: 1 }] }] }, actor)); assert.equal(service.store.revision(), 1);
    const s = C.sample(), batches = Object.entries(s.tables).filter(([, rows]) => rows.length).map(([table, rows]) => ({ table, rows })); const p = service.preview({ baseRevision: 1, batches }, actor); service.commit({ previewId: p.previewId }, actor); assert.equal(service.store.revision(), 2);
    assert.throws(() => service.config({ baseRevision: 1, config: C.defaults }, actor), /过期/); assert.equal(service.detail({ code: 'A', scenario: scenario.id, month }, actor).gap, -100);
    const restored = new Service(db); assert.equal(restored.meta(actor).revision, 2); assert.equal(restored.meta(actor).precomputed.restored, true); restored.store.db.close();
  } finally { service.store.db.close(); }
});
