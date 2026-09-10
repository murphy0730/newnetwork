'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { Service } = require('./service');
const service = new Service(workerData.dbPath);
if (workerData.preload) service.preload(workerData.preload.path, workerData.preload.revision);
parentPort.on('message', ({ id, method, args, actor }) => {
  try { const result = service[method](args, actor); parentPort.postMessage({ id, result }); }
  catch (e) { parentPort.postMessage({ id, error: { message: e.message, status: e.status || 400, details: e.details, code: e.code } }); }
});
parentPort.postMessage({ ready: true });
