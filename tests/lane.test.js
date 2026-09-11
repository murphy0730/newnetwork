'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Lane = require('../server/lane');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-lane-')), workerFile = path.join(root, 'fixture.js');
fs.writeFileSync(workerFile, "const {parentPort}=require('node:worker_threads');parentPort.on('message',m=>{if(m.method==='hang'){while(true){}}if(m.method==='slow')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,80);parentPort.postMessage({id:m.id,result:m.args});});parentPort.postMessage({ready:true});");
const pause = ms => new Promise(r => setTimeout(r, ms));
test('queue is bounded before readiness; active timeout restarts worker and queued cancellation removes work', async () => {
  const lane = new Lane({ workerFile, queueLimit: 2, timeoutMs: 250 });
  try {
    const first = lane.call('slow', 1), controller = new AbortController(), second = lane.call('slow', 2, 'test', { signal: controller.signal });
    await assert.rejects(lane.call('echo', 3), e => e.status === 429);
    controller.abort(); await assert.rejects(second, e => e.status === 499); assert.equal(await first, 1);
    await assert.rejects(lane.call('hang', null), e => e.status === 504);
    for (let n = 0; n < 100 && !lane.loaded; n++) await pause(20);
    assert.equal(await lane.call('echo', 4), 4); assert.equal(lane.diagnostics().timedOut, 1); assert.equal(lane.diagnostics().rejected, 1);
  } finally { lane.close(); }
});
test('retirement drains accepted work and rejects new calls; failed preload does not hang forever', async () => {
  const lane = new Lane({ workerFile, timeoutMs: 1000 }); await lane.ready;
  const result = lane.call('slow', 'accepted'); lane.retire(); await assert.rejects(lane.call('echo', null), e => e.status === 503); assert.equal(await result, 'accepted'); lane.close();
  const silent = path.join(root, 'silent.js'); fs.writeFileSync(silent, 'setInterval(()=>{},1000)');
  const broken = new Lane({ workerFile: silent, loadTimeoutMs: 50 }); try { await assert.rejects(broken.ready, e => e.status === 504); await assert.rejects(broken.call('echo', null), e => e.status === 503); } finally { broken.close(); }
});
