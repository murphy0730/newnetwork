'use strict';
const path = require('node:path'), { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks'), { randomUUID } = require('node:crypto');
const failure = (message, status = 503) => Object.assign(Error(message), { status });
class Lane {
  constructor(options) {
    for (const key of ['queueLimit', 'timeoutMs', 'loadTimeoutMs']) if (options[key] != null && (!Number.isInteger(options[key]) || options[key] < 1)) throw Error(key + ' must be a positive integer');
    this.options = options; this.pending = new Map(); this.samples = []; this.counts = { completed: 0, failed: 0, timedOut: 0, rejected: 0, peakQueue: 0 }; this.spawn();
  }
  spawn() {
    this.loaded = false; this.lastError = null; this.active = null;
    const start = performance.now(), preload = this.options.preload || this.options.getPreload?.();
    const worker = this.worker = new Worker(this.options.workerFile || path.join(__dirname, 'worker.js'), { workerData: { dbPath: this.options.dbPath, preload }, resourceLimits: { maxOldGenerationSizeMb: Number(process.env.SERVICE_HEAP_MB || 6144) } });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; }); this.ready.catch(() => {});
    this.loadTimer = setTimeout(() => this.crash(failure('产物装载超时，请检查内存和磁盘，当前已提交版本保留', 504)), this.options.loadTimeoutMs || 120000); this.loadTimer.unref();
    worker.on('message', m => {
      if (this.worker !== worker) return;
      if (m.ready) { clearTimeout(this.loadTimer); this.loaded = true; this.loadMs = performance.now() - start; this.resolveReady(); return this.drain(); }
      const job = this.pending.get(m.id); clearTimeout(this.activeTimer); this.active = null;
      if (m.memory) this.memory = m.memory;
      if (job) this.settle(job, m.error ? Object.assign(Error(m.error.message), m.error) : null, m.result, m.durationMs);
      this.drain();
    });
    worker.on('error', error => { if (this.worker === worker) this.crash(error); });
    worker.on('exit', code => { if (this.worker === worker && !this.closed) this.crash(failure(`查询进程退出(${code})，已提交版本保留，请稍后重试`)); });
  }
  call(method, args, actor, { signal } = {}) {
    if (this.closed || this.retired) return Promise.reject(failure('查询版本正在切换，请重试'));
    if (this.lastError && !this.worker && !this.restartTimer) return Promise.reject(failure(this.lastError));
    if (this.pending.size >= (this.options.queueLimit || 32)) { this.counts.rejected++; return Promise.reject(failure('查询队列繁忙，请稍后重试', 429)); }
    if (signal?.aborted) return Promise.reject(failure('请求已取消', 499));
    return new Promise((resolve, reject) => {
      const job = { id: randomUUID(), method, args, actor, resolve, reject, created: performance.now(), signal };
      job.timer = setTimeout(() => { this.counts.timedOut++; const error = failure('查询等待或执行超时，请缩小范围后重试', 504); if (this.active === job.id) this.crash(error); else this.settle(job, error); }, this.options.timeoutMs || 30000); job.timer.unref();
      job.abort = () => this.settle(job, failure('请求已取消', 499)); signal?.addEventListener('abort', job.abort, { once: true });
      this.pending.set(job.id, job); this.counts.peakQueue = Math.max(this.counts.peakQueue, this.pending.size); this.drain();
    });
  }
  settle(job, error, result, durationMs) {
    if (!this.pending.delete(job.id)) return;
    if (!(error?.status === 499 && this.active === job.id)) clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    const elapsed = performance.now() - job.created;
    this.samples.push({ method: job.method, elapsedMs: elapsed, computeMs: durationMs ?? null, status: error?.status || (error ? 500 : 200) }); if (this.samples.length > 128) this.samples.shift();
    if (error) { this.counts.failed++; job.reject(error); } else { this.counts.completed++; job.resolve(result); }
  }
  drain() {
    if (this.closed || !this.loaded || this.active) return;
    const job = this.pending.values().next().value;
    if (!job) { if (this.retired) this.close(); return; }
    this.active = job.id;
    this.activeTimer = job.timer;
    try { this.worker.postMessage({ id: job.id, method: job.method, args: job.args, actor: job.actor }); }
    catch (e) { this.active = null; this.settle(job, e); this.drain(); }
  }
  crash(error) {
    const wasLoaded = this.loaded; this.loaded = false; this.lastError = error.message; clearTimeout(this.loadTimer); clearTimeout(this.activeTimer);
    this.rejectReady(error); for (const job of [...this.pending.values()]) this.settle(job, error);
    this.active = null; const worker = this.worker; this.worker = null; const stopped = worker?.terminate() || Promise.resolve();
    if (wasLoaded && !this.closed && !this.retired && !this.options.preload) stopped.finally(() => { if (this.closed) return; this.restartTimer = setTimeout(() => { this.restartTimer = null; if (!this.closed) this.spawn(); }, 100); this.restartTimer.unref(); });
    else if (this.retired) this.close();
  }
  retire() { this.retired = true; if (!this.loaded || (!this.pending.size && !this.active)) this.close(); }
  close() {
    if (this.closed) return; this.closed = true; this.loaded = false; clearTimeout(this.loadTimer); clearTimeout(this.restartTimer); clearTimeout(this.activeTimer);
    const error = failure('查询线程已关闭'); this.rejectReady(error); for (const job of [...this.pending.values()]) this.settle(job, error);
    const worker = this.worker; this.worker = null; worker?.terminate(); this.options.onClose?.(this);
  }
  diagnostics() {
    const times = this.samples.map(s => s.elapsedMs).sort((a, b) => a - b), quantile = p => times.length ? times[Math.ceil((times.length - 1) * p)] : null;
    return { ready: this.loaded, retired: !!this.retired, pending: this.pending.size, active: this.pending.get(this.active)?.method || null, loadMs: this.loadMs ?? null, lastError: this.lastError, ...this.counts, recent: { count: times.length, p50Ms: quantile(.5), p95Ms: quantile(.95), maxMs: times.at(-1) ?? null }, memory: this.memory || null };
  }
}
module.exports = Lane;
