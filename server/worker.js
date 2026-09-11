'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { Service } = require('./service');
const { performance } = require('node:perf_hooks');
const service = new Service(workerData.dbPath);
if (workerData.preload) service.preload(workerData.preload.path, workerData.preload.revision);
parentPort.on('message', ({ id, method, args, actor }) => {
  const started = performance.now();
  try { const result = service[method](args, actor); parentPort.postMessage({ id, result, durationMs: performance.now() - started, memory: process.memoryUsage() }); }
  catch (e) { parentPort.postMessage({ id, error: { message: e.message, status: e.status || 400, details: e.details, code: e.code } }); }
});
parentPort.postMessage({ ready: true });
