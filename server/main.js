'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { createOpenAPI, toolsManifest } = require('./openapi');
const root = path.resolve(__dirname, '..'), host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 8787);
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(root, 'data/control-tower.sqlite');
const tokens = [['admin', process.env.API_ADMIN_TOKEN], ['planner', process.env.API_PLANNER_TOKEN], ['viewer', process.env.API_VIEWER_TOKEN]].filter(x => x[1]);
const localOnly = ['127.0.0.1', 'localhost', '::1'].includes(host);
if (!localOnly && !tokens.some(([r, t]) => r === 'admin' && t.length >= 20)) throw Error('对外监听需要设置至少20字符的API_ADMIN_TOKEN');
const sessions = new Map(), jobs = new Map();
const equal = (a, b) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function auth(req) {
  if (!tokens.length && localOnly) return { role: 'admin', actor: 'local' };
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (bearer) for (const [role, token] of tokens) if (equal(bearer, token)) return { role, actor: 'token:' + role };
  const sid = (req.headers.cookie || '').match(/(?:^|;\s*)tower_session=([^;]+)/)?.[1], session = sessions.get(sid);
  if (session && session.expires > Date.now()) return session;
  return null;
}
class Lane {
  constructor() { this.pending = new Map(); this.spawn(); }
  spawn() {
    this.worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: { dbPath }, resourceLimits: { maxOldGenerationSizeMb: 6144 } });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.worker.on('message', m => { if (m.ready) return this.resolveReady(); const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); if (m.error) p.reject(Object.assign(Error(m.error.message), m.error)); else p.resolve(m.result); });
    this.worker.on('error', e => { this.rejectReady(e); for (const p of this.pending.values()) p.reject(e); this.pending.clear(); });
    this.worker.on('exit', code => { if (!stopping) { for (const p of this.pending.values()) p.reject(Error('计算进程退出，请重试；导入以数据库事务结果为准')); this.pending.clear(); setTimeout(() => this.spawn(), 1000); } });
  }
  async call(method, args, actor) { await this.ready; if (this.pending.size >= 32) throw Object.assign(Error('计算队列繁忙，请稍后重试'), { status: 429 }); const id = randomUUID(); return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, method, args, actor }); }); }
}
let stopping = false;
const writer = new Lane();
let reader;
function json(res, status, value) { const body = JSON.stringify(value); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body); }
async function body(req, binary = false) {
  const chunks = []; let size = 0; for await (const c of req) { size += c.length; if (size > (binary ? 512 : 64) * 1024 * 1024) throw Object.assign(Error('请求数据过大'), { status: 413 }); chunks.push(c); }
  const b = Buffer.concat(chunks); if (binary) return b;
  try { return b.length ? JSON.parse(b.toString('utf8')) : {}; } catch { throw Object.assign(Error('JSON请求格式错误'), { status: 400 }); }
}
function requireRole(user, role) { const rank = { viewer: 0, planner: 1, admin: 2 }; if (rank[user.role] < rank[role]) throw Object.assign(Error('当前角色无权执行此操作'), { status: 403 }); }
function job(res, method, args, user) {
  for (const [id, j] of jobs) if (j.expires < Date.now() && j.status !== 'running') jobs.delete(id);
  if ([...jobs.values()].filter(j => j.status === 'running').length >= 24 || jobs.size > 100) throw Object.assign(Error('后台任务队列已满'), { status: 429 });
  const id = randomUUID(), entry = { id, actor: user.actor, status: 'running', created_at: new Date().toISOString(), expires: Date.now() + 3600000 };
  jobs.set(id, entry); writer.call(method, args, user.actor).then(result => { entry.status = 'completed'; entry.result = result; }).catch(e => { entry.status = 'failed'; entry.error = { message: e.message, status: e.status || 500, details: e.details }; });
  json(res, 202, { jobId: id, status: 'running', poll: '/api/jobs/' + id });
}
const staticFiles = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/base.css', 'base.css'], ['/forecast.css', 'forecast.css'], ['/forecast-app.js', 'forecast-app.js'], ['/forecast-core.js', 'forecast-core.js'], ['/forecast-graph.js', 'forecast-graph.js'], ['/vendor/echarts.js', 'vendor/echarts.js'], ['/vendor/xlsx.js', 'vendor/xlsx.js'], ['/vendor/g6.min.js', 'vendor/g6.min.js']]);
const readRoutes = new Map([['/api/meta', 'meta'], ['/api/analysis', 'list'], ['/api/nodes', 'detail'], ['/api/graph', 'graph'], ['/api/reports', 'report'], ['/api/tables', 'table']]);
const writeRoutes = new Map([['/api/import/preview', ['preview', 'admin']], ['/api/import/commit', ['commit', 'admin']], ['/api/config', ['config', 'admin']], ['/api/sample', ['sample', 'admin']], ['/api/sample-large', ['sampleLarge', 'admin']], ['/api/restore', ['restore', 'admin']], ['/api/scenarios', ['simulate', 'planner']]]);
writeRoutes.set('/api/maintain', ['maintain', 'admin']);
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'), q = Object.fromEntries(url.searchParams), pathname = url.pathname;
    if (localOnly && !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host || '')) throw Object.assign(Error('Host不被允许'), { status: 403 });
    if (pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method) && req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw Object.assign(Error('拒绝跨站写入'), { status: 403 });
    if (req.method === 'GET' && staticFiles.has(pathname)) {
      const file = path.join(root, staticFiles.get(pathname)), ext = path.extname(file), types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
      res.writeHead(200, { 'Content-Type': types[ext] + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" }); fs.createReadStream(file).pipe(res); return;
    }
    if (pathname === '/api/health') return json(res, 200, { ok: true, engine: 'topological-dag', queue: writer.pending.size + (reader?.pending.size || 0) });
    if (pathname === '/api/session' && req.method === 'POST') {
      const data = await body(req), token = String(data.token || ''), match = tokens.find(([, t]) => equal(token, t));
      if (!match) throw Object.assign(Error('访问令牌无效'), { status: 401 });
      const sid = randomUUID(); sessions.set(sid, { role: match[0], actor: 'token:' + match[0], expires: Date.now() + 8 * 3600000 });
      res.setHeader('Set-Cookie', `tower_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`); return json(res, 200, { role: match[0] });
    }
    const user = auth(req); if (!user) throw Object.assign(Error('请使用访问令牌登录'), { status: 401 });
    if (pathname === '/api/session' && req.method === 'GET') return json(res, 200, user);
    if (pathname === '/api/openapi.json') return json(res, 200, createOpenAPI());
    if (pathname === '/api/ai/tools') return json(res, 200, toolsManifest());
    if (pathname.startsWith('/api/jobs/') && req.method === 'GET') {
      const entry = jobs.get(pathname.split('/').at(-1)); if (!entry || entry.actor !== user.actor) throw Object.assign(Error('任务不存在或无权访问'), { status: 404 });
      return json(res, 200, { id: entry.id, status: entry.status, result: entry.result, error: entry.error, created_at: entry.created_at });
    }
    if (readRoutes.has(pathname) && req.method === 'GET') { const result = await reader.call(readRoutes.get(pathname), q, user.actor); return json(res, 200, result); }
    if (pathname === '/api/export' && req.method === 'GET') { const bytes = await reader.call('export', q, user.actor); res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="supply-data.xlsx"' }); res.end(Buffer.from(bytes)); return; }
    if (pathname === '/api/import/file' && req.method === 'POST') { requireRole(user, 'admin'); return job(res, 'upload', { name: String(q.name || ''), bytes: await body(req, true) }, user); }
    if (writeRoutes.has(pathname) && req.method === 'POST') { const [method, role] = writeRoutes.get(pathname); requireRole(user, role); return job(res, method, await body(req), user); }
    if (pathname === '/api/ai/invoke' && req.method === 'POST') {
      const b = await body(req), methods = { analyze_supply: 'list', explain_code: 'detail', inspect_network: 'graph', get_reports: 'report' };
      if (b.tool === 'simulate_forecast') { requireRole(user, 'planner'); return job(res, 'simulate', b.arguments || {}, user); }
      if (!methods[b.tool]) throw Object.assign(Error('不支持该工具；不接受任意SQL或代码执行'), { status: 400 });
      return json(res, 200, await reader.call(methods[b.tool], b.arguments || {}, user.actor));
    }
    throw Object.assign(Error('接口不存在'), { status: 404 });
  } catch (e) { if (!res.headersSent) json(res, e.status || 500, { error: { code: String(e.status || 500), message: e.message, details: e.details } }); else res.end(); }
});
server.requestTimeout = 120000;
(async () => { await writer.ready; reader = new Lane(); await reader.ready; server.listen(port, host, () => console.log(`供应预测控制塔 http://${host}:${port} | 数据库 ${dbPath} | ${tokens.length ? '令牌权限已启用' : '仅本机访问'} `)); })().catch(e => { console.error(e); process.exitCode = 1; stopping = true; writer.worker.terminate(); reader?.worker.terminate(); });
function shutdown() { stopping = true; server.close(); writer.worker.terminate(); reader?.worker.terminate(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
