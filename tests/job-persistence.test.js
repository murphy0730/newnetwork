'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const BuildJobs = require('../server/build-jobs'), Store = require('../server/store');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-persistence-'));
  const store = new Store(path.join(dir, 'test.sqlite')), jobs = new BuildJobs(store, () => {});
  t.after(() => { jobs.shutdown(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, jobs };
}
test('transient Windows rename locks retain complete old JSON and retry atomically', t => {
  const { dir, jobs } = fixture(t), filename = path.join(dir, 'state.json');
  jobs.write(filename, { version: 1 });
  const rename = fs.renameSync; let attempts = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), { version: 1 });
    if (++attempts < 3) throw Object.assign(Error('temporary file lock'), { code: 'EPERM' });
    return rename(from, to);
  });
  jobs.write(filename, { version: 2 });
  assert.equal(attempts, 3); assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), { version: 2 });
  assert.equal(fs.existsSync(filename + '.tmp'), false);
});
test('initial task persistence failure releases uploads without leaving a running task', t => {
  const { jobs } = fixture(t), upload = path.join(jobs.root, 'uploads', 'input.csv');
  fs.writeFileSync(upload, 'input');
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(Error('disk failure'), { code: 'EIO' }); });
  assert.throws(() => jobs.create('test', 'build', () => {}, [upload]), /disk failure/);
  assert.equal(jobs.jobs.size, 0); assert.equal(fs.existsSync(upload), false);
});
for (const phase of ['progress', 'exit']) test(`persistent ${phase}-write errors fail the child task without crashing or leaking uploads`, async t => {
  const { jobs } = fixture(t), upload = path.join(jobs.root, 'uploads', 'input.csv');
  fs.writeFileSync(upload, 'plan_date,code,month,qty\n2026-09-15,A,2026-09,100\n');
  const rename = fs.renameSync; let progressWrites = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    // Allow queued/starting records, then fail on a child progress/result event.
    if (to.includes(path.sep + 'jobs' + path.sep) && ++progressWrites >= 3) throw Object.assign(Error('locked task record'), { code: 'EPERM' });
    return rename(from, to);
  });
  const spec = phase === 'exit' ? { action: 'inspect', path: upload, name: 'input.csv' } : { files: [{ path: upload }], output: path.join(jobs.catalog.artifactDir, 'candidate.supply') };
  const task = jobs.create('test', 'build', (job, progress) => jobs.child(job, spec, progress), [upload]);
  const deadline = Date.now() + 10000;
  while ((jobs.get(task.jobId, 'test').status === 'running' || fs.existsSync(upload)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const job = jobs.get(task.jobId, 'test');
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'EPERM');
  assert.equal(job.persistenceError.code, 'EPERM'); assert.equal(fs.existsSync(upload), false);
  assert.equal(jobs.children.size, 0);
  assert.equal(fs.existsSync(jobs.file('jobs', task.jobId) + '.tmp'), false);
});

test('a completed operation retains its result if the final task record cannot be saved', async t => {
  const { jobs } = fixture(t), rename = fs.renameSync; let calls = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (++calls > 1) throw Object.assign(Error('disk full'), { code: 'ENOSPC' });
    return rename(from, to);
  });
  const task = jobs.create('test', 'activate', async () => ({ revision: 7 }));
  await new Promise(resolve => setImmediate(resolve));
  const job = jobs.get(task.jobId, 'test');
  assert.equal(job.status, 'completed'); assert.deepEqual(job.result, { revision: 7 });
  assert.equal(job.persistenceError.code, 'ENOSPC'); assert.equal(job.error, undefined);
});
