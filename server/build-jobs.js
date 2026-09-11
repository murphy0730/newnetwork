'use strict';
const fs = require('node:fs'), path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const failure = (message, status = 400) => Object.assign(Error(message), { status });
class BuildJobs {
  constructor(catalog, activate) {
    this.catalog = catalog; this.activate = activate; this.root = catalog.path + '.tasks'; this.jobs = new Map(); this.children = new Map(); this.cancellers = new Map(); this.tail = Promise.resolve();
    for (const name of ['jobs', 'uploads', 'previews']) fs.mkdirSync(path.join(this.root, name), { recursive: true });
    fs.mkdirSync(catalog.artifactDir, { recursive: true });
    for (const name of fs.readdirSync(path.join(this.root, 'jobs'))) if (/^[a-f0-9-]+\.json$/.test(name)) {
      try { const job = JSON.parse(fs.readFileSync(path.join(this.root, 'jobs', name), 'utf8')); this.jobs.set(job.id, job); if (job.status === 'running') { job.status = 'failed'; job.error = { message: '服务重启中断了构建，请重新上传或重新启动构建；已提交版本保留', status: 409 }; this.cleanup([...(job.resources || []), ...(job.outputs || [])]); this.persist(job); } } catch {}
    }
    this.sweep();
  }
  file(name, id) { if (!/^[a-f0-9-]{36}$/.test(id || '')) throw failure('无效任务标识'); return path.join(this.root, name, id + '.json'); }
  write(filename, value) { fs.writeFileSync(filename + '.tmp', JSON.stringify(value)); fs.renameSync(filename + '.tmp', filename); }
  persist(job) { job.updated_at = new Date().toISOString(); this.write(this.file('jobs', job.id), job); }
  cleanup(files) {
    const inUse = new Set([...this.jobs.values()].filter(j => j.status === 'running').flatMap(j => [...(j.resources || []), ...(j.outputs || [])]).map(f => path.resolve(f)));
    for (const filename of files) { const full = path.resolve(filename), relative = path.relative(this.root, full), artifactRelative = path.relative(this.catalog.artifactDir, full); if ((!relative.startsWith('..') && !path.isAbsolute(relative)) || (!artifactRelative.startsWith('..') && !path.isAbsolute(artifactRelative))) {
      if (inUse.has(full)) continue;
      // Published history is immutable, including when cancellation races with
      // publication or an interrupted job is recovered after a restart.
      if (path.extname(full) === '.supply' && this.catalog.db.prepare('SELECT 1 FROM artifact_refs WHERE path=?').get(path.relative(path.dirname(this.catalog.path), full))) continue;
      try { fs.unlinkSync(full); } catch {}
    } }
  }
  sweep() {
    const now = Date.now();
    for (const [id, job] of this.jobs) if (job.status !== 'running' && now - Date.parse(job.updated_at) > 7 * 86400000) { this.jobs.delete(id); this.cleanup([this.file('jobs', id)]); }
    const inUse = new Set([...this.jobs.values()].filter(j => j.status === 'running').flatMap(j => j.resources || []));
    for (const kind of ['uploads', 'previews']) for (const name of fs.readdirSync(path.join(this.root, kind))) if (/^[a-f0-9-]+\.json$/.test(name)) {
      const filename = path.join(this.root, kind, name);
      try { const item = JSON.parse(fs.readFileSync(filename, 'utf8')); if (item.expires < now && !inUse.has(filename)) this.cleanup([filename, item.path]); } catch {}
    }
  }
  create(actor, kind, run, resources = [], keepResourcesOnSuccess = false, outputs = []) {
    this.sweep(); if ([...this.jobs.values()].filter(j => j.status === 'running').length >= 8) { this.cleanup(resources); throw failure('已有8项后台任务，请稍后重试；本次暂存已释放', 429); }
    const job = { id: randomUUID(), actor, kind, status: 'running', phase: 'queued', message: '任务已排队，可继续查看当前版本', percent: 0, created_at: new Date().toISOString(), resources, outputs };
    this.jobs.set(job.id, job); this.persist(job);
    const progress = p => { if (job.status === 'running') { Object.assign(job, p); this.persist(job); } };
    Promise.resolve().then(() => run(job, progress)).then(result => { if (job.status !== 'running') return; job.status = 'completed'; job.phase = 'completed'; job.percent = 100; job.result = result; this.persist(job); }).catch(e => { job.status = 'failed'; job.phase = 'failed'; job.error = { message: e.message, status: e.status || 500, details: e.details, code: e.code }; this.persist(job); }).finally(() => { if (!keepResourcesOnSuccess || job.status !== 'completed') this.cleanup(resources); if (job.status !== 'completed') this.cleanup(outputs); });
    return { jobId: job.id, status: 'running', poll: '/api/jobs/' + job.id };
  }
  public(job) {
    const { actor, resources, outputs, ...result } = job;
    result.canActivate = false;
    if (job.status === 'completed' && job.result?.previewId) {
      try { const preview = JSON.parse(fs.readFileSync(this.file('previews', job.result.previewId), 'utf8')); result.canActivate = preview.expires > Date.now() && preview.baseRevision === this.catalog.revision(); } catch {}
    }
    return result;
  }
  get(id, actor) { const job = this.jobs.get(id); if (!job || job.actor !== actor) throw failure('任务不存在或无权访问', 404); return this.public(job); }
  list(actor) { return [...this.jobs.values()].filter(j => j.actor === actor).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 30).map(j => this.public(j)); }
  cancel(id, actor) { const job = this.jobs.get(id); this.get(id, actor); if (job.status !== 'running') return this.public(job); if (job.phase === 'publish') throw failure('版本正在原子发布，请等待完成', 409); job.status = 'failed'; job.error = { message: '任务已取消，当前数据版本未被替换', status: 409 }; this.persist(job); this.children.get(id)?.kill(); this.cancellers.get(id)?.(); this.cleanup(job.resources); return this.public(job); }
  child(job, spec, progress) {
    const task = this.tail.catch(() => {}).then(() => {
      if (job.status !== 'running') throw failure('任务已取消', 409);
      progress({ phase: 'starting', message: '独立构建进程启动', percent: 1 });
      return new Promise((resolve, reject) => {
        const heap = Number(process.env.BUILD_HEAP_MB || 8192);
        if (!Number.isInteger(heap) || heap < 256) return reject(failure('BUILD_HEAP_MB须为至少256的整数'));
        const child = fork(path.join(__dirname, 'build.js'), [], { windowsHide: true, execArgv: ['--max-old-space-size=' + heap], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        this.children.set(job.id, child); let output = '', message, childError;
        child.stderr.on('data', b => { output = (output + b).slice(-4000); });
        child.on('message', m => { if (m.progress) progress(m.progress); else message = m; });
        child.on('error', e => { childError = e; reject(e); });
        child.on('exit', (code, signal) => {
          this.children.delete(job.id);
          // Do not overlap two multi-GB builders: their heap is released on exit,
          // not when the result message happens to reach the HTTP process.
          if (childError) return;
          if (job.status !== 'running') return reject(failure('构建已取消', 409));
          if (message?.error) return reject(Object.assign(Error(message.error.message), message.error));
          if (code === 0 && message && Object.hasOwn(message, 'result')) return resolve(message.result);
          reject(failure(`构建进程退出（${signal || code}）。当前版本保留；请检查内存/磁盘或拆分文件重试。${/heap out of memory|Allocation failed/i.test(output) ? ' 构建进程内存不足，可调整BUILD_HEAP_MB。' : ''}`, 500));
        });
        child.send(spec);
      });
    });
    this.tail = task; return task;
  }
  async receive(req, name, actor, artifact = false) {
    this.sweep(); const id = randomUUID(), extension = path.extname(name).toLowerCase();
    if (!(artifact ? ['.supply'] : ['.csv', '.xlsx', '.xls']).includes(extension)) throw failure(artifact ? '构建产物须为.supply文件' : '支持CSV、xlsx、xls；构建产物请使用产物导入');
    const filename = path.join(artifact ? this.catalog.artifactDir : path.join(this.root, 'uploads'), id + extension), digest = createHash('sha256'); let bytes = 0;
    const meter = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; digest.update(chunk); callback(null, chunk); } });
    try { await pipeline(req, meter, fs.createWriteStream(filename, { flags: 'wx' })); if (!bytes) throw failure('文件为空'); }
    catch (e) { this.cleanup([filename]); throw e; }
    const item = { id, path: filename, name, actor, bytes, sha256: digest.digest('hex'), expires: Date.now() + 86400000 };
    if (!artifact) this.write(this.file('uploads', id), item);
    return item;
  }
  upload(item) {
    return this.create(item.actor, 'inspect', async (job, progress) => {
      try { const result = await this.child(job, { action: 'inspect', path: item.path, name: item.name }, progress); return { id: item.id, name: item.name, bytes: item.bytes, ...result }; }
      catch (e) { this.cleanup([item.path, this.file('uploads', item.id)]); throw e; }
    }, [item.path, this.file('uploads', item.id)], true);
  }
  getUpload(id, actor) {
    let item; try { item = JSON.parse(fs.readFileSync(this.file('uploads', id), 'utf8')); } catch { throw failure('上传文件已释放或过期，请重新上传', 404); }
    if (item.actor !== actor || item.expires < Date.now()) throw failure('上传文件已过期或无权访问', 404); return item;
  }
  previewRecord(actor, filename, baseRevision, result) {
    const id = randomUUID(), preview = { id, actor, path: filename, baseRevision, expires: Date.now() + 86400000 };
    this.write(this.file('previews', id), preview);
    return { previewId: id, baseRevision, summaries: result.summaries || [], warnings: result.manifest.warnings, counts: result.manifest.counts, replacesSample: !!result.replacesSample, buildId: result.manifest.buildId, codes: result.manifest.codes, versions: result.manifest.versions };
  }
  preview(body, actor) {
    const files = [], resources = [];
    try {
      for (const f of body.files || []) { const item = this.getUpload(f.id, actor); if (resources.includes(item.path) || [...this.jobs.values()].some(j => j.status === 'running' && j.resources.includes(item.path))) throw failure('文件已在本次或其他构建中使用，请等待完成后重新上传', 409); files.push({ path: item.path, name: item.name, selections: f.selections }); resources.push(item.path, this.file('uploads', item.id)); }
      if (body.baseRevision !== this.catalog.revision()) throw failure('数据版本已变化，请重新上传并构建', 409);
      const output = path.join(this.catalog.artifactDir, randomUUID() + '.supply'); resources.push(output + '.partial', output + '.partial-journal');
      return this.create(actor, 'build', async (job, progress) => {
        const result = await this.child(job, { operation: 'preview', files, body, base: { dbPath: this.catalog.path, revision: body.baseRevision }, output }, progress);
        return this.previewRecord(actor, output, body.baseRevision, result);
      }, resources, false, [output]);
    } catch (e) { this.cleanup(resources); throw e; }
  }
  uploadArtifact(item, baseRevision) {
    if (baseRevision !== this.catalog.revision()) { this.cleanup([item.path]); throw failure('数据版本已变化，请重新上传产物', 409); }
    return this.create(item.actor, 'verify', async (job, progress) => {
      try { const result = await this.child(job, { action: 'verify', path: item.path }, progress); return this.previewRecord(item.actor, item.path, baseRevision, result); }
      catch (e) { this.cleanup([item.path]); throw e; }
    }, [item.path], true);
  }
  commit(body, actor) {
    const previewFile = this.file('previews', body.previewId);
    const previous = [...this.jobs.values()].find(j => j.actor === actor && j.kind === 'activate' && ['running', 'completed'].includes(j.status) && j.resources.includes(previewFile));
    if (previous) return { jobId: previous.id, status: previous.status, poll: '/api/jobs/' + previous.id };
    let preview; try { preview = JSON.parse(fs.readFileSync(this.file('previews', body.previewId), 'utf8')); } catch { throw failure('构建预览已失效，请重新构建或上传产物', 404); }
    if (preview.actor !== actor || preview.expires < Date.now()) throw failure('构建预览过期或无权访问', 404);
    return this.create(actor, 'activate', (job, progress) => this.activate(preview.path, preview.baseRevision, actor, 'import', progress, job), [this.file('previews', preview.id)], false, [preview.path]);
  }
  mutation(operation, body, actor) {
    if (body.baseRevision !== this.catalog.revision()) throw failure('数据版本已变化，请重新加载', 409);
    const output = path.join(this.catalog.artifactDir, randomUUID() + '.supply');
    return this.create(actor, operation, async (job, progress) => {
      const result = await this.child(job, { operation, body, base: { dbPath: this.catalog.path, revision: body.baseRevision }, output }, progress);
      return this.activate(result.path, body.baseRevision, actor, operation, progress, job);
    }, [output + '.partial', output + '.partial-journal'], false, [output]);
  }
  discard(ids, actor) { for (const id of ids) { try { const item = this.getUpload(id, actor); if ([...this.jobs.values()].some(j => j.status === 'running' && j.resources.includes(item.path))) throw failure('文件正在构建，任务完成后会自动释放', 409); this.cleanup([item.path, this.file('uploads', id)]); } catch (e) { if (e.status !== 404) throw e; } } return { released: true }; }
  shutdown() { for (const child of this.children.values()) child.kill(); for (const cancel of this.cancellers.values()) cancel(); }
}
module.exports = BuildJobs;
