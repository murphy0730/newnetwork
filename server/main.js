'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Lane = require('./lane');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const os = require('node:os');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { createOpenAPI, toolsManifest } = require('./openapi');
const Store = require('./store'), BuildJobs = require('./build-jobs'), C = require('../forecast-core');
const { Artifact } = require('./artifact');
const root = path.resolve(__dirname, '..'), host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 8787);
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(root, 'data/control-tower.sqlite');
const catalog = new Store(dbPath);
const tokens = [['admin', process.env.API_ADMIN_TOKEN], ['planner', process.env.API_PLANNER_TOKEN], ['viewer', process.env.API_VIEWER_TOKEN]].filter(x => x[1]);
const localOnly = ['127.0.0.1', 'localhost', '::1'].includes(host);
if (!localOnly && !tokens.some(([r, t]) => r === 'admin' && t.length >= 20)) throw Error('对外监听需要设置至少20字符的API_ADMIN_TOKEN');
const sessions = new Map();
const equal = (a, b) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function auth(req) {
  if (!tokens.length && localOnly) return { role: 'admin', actor: 'local' };
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (bearer) for (const [role, token] of tokens) if (equal(bearer, token)) return { role, actor: 'token:' + role };
  const sid = (req.headers.cookie || '').match(/(?:^|;\s*)tower_session=([^;]+)/)?.[1], session = sessions.get(sid);
  if (session && session.expires > Date.now()) return session;
  return null;
}
let stopping = false;
const lanes = new Set();
const currentPreload = () => { const ref = catalog.db.prepare('SELECT path,revision FROM artifact_refs WHERE revision=?').get(catalog.revision()); return ref ? { path: path.resolve(path.dirname(dbPath), ref.path), revision: ref.revision } : undefined; };
const makeLane = options => { const lane = new Lane({ dbPath, loadTimeoutMs: Number(process.env.LOAD_TIMEOUT_MS || 120000), onClose: item => lanes.delete(item), ...options }); lanes.add(lane); return lane; };
const writer = makeLane({ timeoutMs: Number(process.env.SIMULATION_TIMEOUT_MS || 120000) });
let reader = makeLane({ getPreload: currentPreload, timeoutMs: Number(process.env.QUERY_TIMEOUT_MS || 30000) }), publication = Promise.resolve();
const eventLoop = monitorEventLoopDelay({ resolution: 20 }); eventLoop.enable();
const buildJobs = new BuildJobs(catalog, activateArtifact);
function activateArtifact(filename, expected, actor, action, progress, job) {
  const task = publication.catch(() => {}).then(async () => {
    if (job.status !== 'running') throw Object.assign(Error('装载任务已取消'), { status: 409 });
    if (catalog.revision() !== expected) throw Object.assign(Error('当前版本已变化，构建产物未发布，请重新构建'), { status: 409 });
    progress({ phase: 'load', percent: 96, message: '装载预计算产物，当前版本继续提供查询' });
    const staged = makeLane({ preload: { path: filename, revision: expected + 1 }, timeoutMs: Number(process.env.QUERY_TIMEOUT_MS || 30000) });
    buildJobs.cancellers.set(job.id, () => staged.retire());
    try {
      await staged.ready;
      if (job.status !== 'running') throw Object.assign(Error('装载已取消'), { status: 409 });
      progress({ phase: 'publish', percent: 99, message: '原子切换在线版本' });
      catalog.activate(filename, expected, actor, action);
      const previous = reader; reader = staged; delete staged.options.preload; staged.options.getPreload = currentPreload; previous.retire();
      return catalog.info();
    } catch (e) { staged.retire(); throw e; } finally { buildJobs.cancellers.delete(job.id); }
  });
  publication = task; return task;
}
function json(res, status, value) { const body = JSON.stringify(value); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body); }
async function body(req) {
  const chunks = []; let size = 0; for await (const c of req) { size += c.length; if (size > 64 * 1024 * 1024) throw Object.assign(Error('JSON请求超过64MiB，大型数据请用CSV或构建产物流式上传'), { status: 413 }); chunks.push(c); }
  const b = Buffer.concat(chunks);
  try { const parsed = b.length ? JSON.parse(b.toString('utf8')) : {}; if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('object required'); return parsed; } catch { throw Object.assign(Error('JSON请求格式错误，请传入对象'), { status: 400 }); }
}
function requireRole(user, role) { const rank = { viewer: 0, planner: 1, admin: 2 }; if (rank[user.role] < rank[role]) throw Object.assign(Error('当前角色无权执行此操作'), { status: 403 }); }
function job(res, method, args, user) {
  const task = method === 'simulate' ? buildJobs.create(user.actor, 'simulate', () => writer.call(method, args, user.actor)) : method === 'preview' ? buildJobs.preview(args, user.actor) : method === 'commit' ? buildJobs.commit(args, user.actor) : buildJobs.mutation(method, args, user.actor);
  json(res, 202, task);
}
const staticFiles = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/base.css', 'base.css'], ['/forecast.css', 'forecast.css'], ['/forecast-app.js', 'forecast-app.js'], ['/forecast-core.js', 'forecast-core.js'], ['/forecast-layout.js', 'forecast-layout.js'], ['/forecast-graph.js', 'forecast-graph.js'], ['/index.map.html', 'index.map.html'], ['/forecast-graph.map.js', 'forecast-graph.map.js'], ['/vendor/echarts.js', 'vendor/echarts.js'], ['/vendor/xlsx.js', 'vendor/xlsx.js'], ['/vendor/g6.min.js', 'vendor/g6.min.js']]);
const readRoutes = new Map([['/api/meta', 'meta'], ['/api/analysis', 'list'], ['/api/nodes', 'detail'], ['/api/insights', 'insights'], ['/api/graph', 'graph'], ['/api/reports', 'report'], ['/api/tables', 'table']]);
const writeRoutes = new Map([['/api/import/preview', ['preview', 'admin']], ['/api/import/commit', ['commit', 'admin']], ['/api/config', ['config', 'admin']], ['/api/sample', ['sample', 'admin']], ['/api/sample-large', ['sampleLarge', 'admin']], ['/api/restore', ['restore', 'admin']], ['/api/scenarios', ['simulate', 'planner']]]);
writeRoutes.set('/api/maintain', ['maintain', 'admin']);
writeRoutes.set('/api/builds/rebuild', ['rebuild', 'admin']);
const server = http.createServer(async (req, res) => {
  const requestId = /^[a-zA-Z0-9_-]{1,64}$/.test(req.headers['x-request-id'] || '') ? req.headers['x-request-id'] : randomUUID();
  res.setHeader('X-Request-ID', requestId);
  const requestAbort = new AbortController(); res.once('close', () => { if (!res.writableEnded) requestAbort.abort(); });
  try {
    const url = new URL(req.url, 'http://localhost'), q = Object.fromEntries(url.searchParams), pathname = url.pathname;
    if (localOnly && !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host || '')) throw Object.assign(Error('Host不被允许'), { status: 403 });
    if (pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method) && req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw Object.assign(Error('拒绝跨站写入'), { status: 403 });
    if (req.method === 'GET' && staticFiles.has(pathname)) {
      const file = path.join(root, staticFiles.get(pathname)), ext = path.extname(file), types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
      res.writeHead(200, { 'Content-Type': types[ext] + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" }); fs.createReadStream(file).pipe(res); return;
    }
    if (pathname === '/api/health') return json(res, 200, { ok: true, engine: 'prebuilt-artifact', ready: reader.loaded, loadError: reader.lastError, queue: writer.pending.size + reader.pending.size });
    if (pathname === '/api/ready') return json(res, reader.loaded ? 200 : 503, { ready: reader.loaded, error: reader.lastError });
    if (pathname === '/api/session' && req.method === 'POST') {
      const data = await body(req), token = String(data.token || ''), match = tokens.find(([, t]) => equal(token, t));
      if (!match) throw Object.assign(Error('访问令牌无效'), { status: 401 });
      const sid = randomUUID(); sessions.set(sid, { role: match[0], actor: 'token:' + match[0], expires: Date.now() + 8 * 3600000 });
      res.setHeader('Set-Cookie', `tower_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`); return json(res, 200, { role: match[0] });
    }
    const user = auth(req); if (!user) throw Object.assign(Error('请使用访问令牌登录'), { status: 401 });
    if (pathname === '/api/diagnostics' && req.method === 'GET') {
      requireRole(user, 'admin');
      const disk = fs.statfsSync(path.dirname(dbPath));
      return json(res, 200, { revision: catalog.revision(), uptimeSeconds: process.uptime(), node: process.version, memory: process.memoryUsage(), systemMemory: { freeBytes: os.freemem(), totalBytes: os.totalmem() }, disk: { availableBytes: disk.bavail * disk.bsize }, eventLoop: { p95Ms: eventLoop.percentile(95) / 1e6, maxMs: eventLoop.max / 1e6 }, reader: reader.diagnostics(), simulation: writer.diagnostics(), loadingReaders: [...lanes].filter(l => l !== reader && l !== writer).map(l => l.diagnostics()), builds: { running: [...buildJobs.jobs.values()].filter(j => j.status === 'running').length, childProcesses: buildJobs.children.size }, note: '延迟为最近128次线程调用（含排队）；RSS为整个服务进程，包含线程，不可逐线程相加。构建子进程内存不在此RSS内。' });
    }
    if (pathname === '/api/scenarios/prepare' && req.method === 'POST') {
      requireRole(user, 'planner'); const args = await body(req), pinned = { ...args, revision: args.revision == null ? catalog.revision() : args.revision }; delete pinned.scenario;
      return json(res, 202, buildJobs.create(user.actor, 'prepareSimulation', async (job, progress) => { progress({ phase: 'load', message: '正在装载推演基线，可继续浏览网络', percent: 10 }); return writer.call('prepareSimulation', pinned, user.actor); }));
    }
    if (pathname === '/api/session' && req.method === 'GET') return json(res, 200, user);
    if (pathname === '/api/openapi.json') return json(res, 200, createOpenAPI());
    if (pathname === '/api/ai/tools') return json(res, 200, toolsManifest());
    if (pathname === '/api/import/schema' && req.method === 'GET') return json(res, 200, { schemas: C.schemas, formats: ['csv', 'xlsx', 'xls', 'supply'], upload: '流式落盘，无固定总文件/单元格/编码数量上限；单个CSV字段最多16Mi字符，构建受机器内存与磁盘约束', dates: 'YYYY-MM-DD', months: 'YYYY-MM', codes: '文本格式以保留前导零', template: '/api/export?kind=template' });
    if (pathname === '/api/builds' && req.method === 'GET') return json(res, 200, { jobs: buildJobs.list(user.actor) });
    if (pathname === '/api/import/discard' && req.method === 'POST') { requireRole(user, 'admin'); return json(res, 200, buildJobs.discard((await body(req)).ids || [], user.actor)); }
    if (/^\/api\/jobs\/[^/]+\/cancel$/.test(pathname) && req.method === 'POST') return json(res, 200, buildJobs.cancel(pathname.split('/')[3], user.actor));
    if (/^\/api\/jobs\/[^/]+\/issues$/.test(pathname) && req.method === 'GET') {
      const filename = buildJobs.report(pathname.split('/')[3], user.actor, q.table || '');
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="import-issues.csv"', 'Cache-Control': 'no-store' });
      const stream = fs.createReadStream(filename); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return;
    }
    if (pathname.startsWith('/api/jobs/') && req.method === 'GET') {
      return json(res, 200, buildJobs.get(pathname.split('/').at(-1), user.actor));
    }
    if (pathname === '/api/meta' && req.method === 'GET') return json(res, 200, catalog.info());
    if (pathname === '/api/export' && req.method === 'GET' && q.kind === 'template') { const bytes = require('./importer').workbook(C.empty(), true, q.table); res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="supply-template' + (q.table ? '-' + q.table : '') + '.xlsx"' }); res.end(bytes); return; }
    if (readRoutes.has(pathname) && req.method === 'GET') { const pinned = !q.scenario && (q.revision == null || q.revision === '') ? { ...q, revision: catalog.revision() } : q; const result = await reader.call(readRoutes.get(pathname), pinned, user.actor, { signal: requestAbort.signal }); return json(res, 200, result); }
    if (pathname === '/api/export' && req.method === 'GET' && ['artifact', 'csv'].includes(q.kind)) {
      const ref = catalog.db.prepare('SELECT path FROM artifact_refs WHERE revision=?').get(catalog.revision());
      if (!ref) throw Object.assign(Error('当前数据尚未构建，请先启动重建'), { status: 409 });
      const filename = path.resolve(path.dirname(dbPath), ref.path);
      if (q.kind === 'artifact') { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="supply-build.supply"', 'Content-Length': fs.statSync(filename).size }); const stream = fs.createReadStream(filename); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return; }
      if (!Object.hasOwn(C.schemas, q.table)) throw Object.assign(Error('CSV导出须指定有效table'), { status: 400 });
      const artifact = new Artifact(filename), keys = Object.keys(C.schemas[q.table].fields), csvCell = value => '"' + String(value == null ? '' : typeof value === 'boolean' ? value ? '是' : '否' : value).replace(/"/g, '""') + '"';
      try {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${q.table}.csv"` }); res.write('\uFEFF' + keys.map(k => csvCell(C.schemas[q.table].fields[k].label)).join(',') + '\r\n');
        let batch = [], count = 0;
        for (const row of artifact.rows('table/' + q.table)) { if (res.destroyed) break; batch.push(keys.map(k => csvCell(row[k])).join(',')); if (++count % 1000 === 0) { if (!res.write(batch.join('\r\n') + '\r\n')) await new Promise(resolve => { const done = () => { res.off('drain', done); res.off('close', done); res.off('error', done); resolve(); }; res.once('drain', done); res.once('close', done); res.once('error', done); }); batch = []; await new Promise(resolve => setImmediate(resolve)); } }
        if (!res.destroyed) res.end(batch.length ? batch.join('\r\n') + '\r\n' : '');
      } finally { artifact.close(); }
      return;
    }
    if (pathname === '/api/export' && req.method === 'GET' && q.kind === 'data' && Object.values(catalog.info().counts).some(n => n >= 1000000)) throw Object.assign(Error('当前数据超过单张Excel工作表容量，请下载完整构建产物或按表导出CSV'), { status: 422 });
    if (pathname === '/api/export' && req.method === 'GET') { const bytes = await reader.call('export', q, user.actor); res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="supply-data.xlsx"' }); res.end(Buffer.from(bytes)); return; }
    if (pathname === '/api/import/folder') {
      const dir = process.env.IMPORT_DIR ? path.resolve(process.env.IMPORT_DIR) : path.join(root, 'import');
      fs.mkdirSync(dir, { recursive: true });
      const files = fs.readdirSync(dir).filter(f => ['.csv', '.xlsx', '.xls'].includes(path.extname(f).toLowerCase()));
      if (req.method === 'GET') return json(res, 200, { dir, files: files.map(f => ({ name: f, bytes: fs.statSync(path.join(dir, f)).size })) });
      if (req.method !== 'POST') throw Object.assign(Error('接口不存在'), { status: 404 });
      requireRole(user, 'admin');
      // 一键导入：文件夹内全部表格作为同一批次，自动识别工作表、校验、构建并原子发布
      if (!files.length) throw Object.assign(Error('import 文件夹中还没有表格文件。请把 CSV / Excel 放入 ' + dir + ' 后再点击'), { status: 422 });
      const baseRevision = catalog.revision(), output = path.join(catalog.artifactDir, randomUUID() + '.supply');
      const inputs = files.map(f => ({ path: path.join(dir, f), name: f }));
      return json(res, 202, buildJobs.create(user.actor, 'build', async (job, progress) => {
        progress({ phase: 'read', message: `读取 import 文件夹：${files.join('、')}`, percent: 2 });
        await buildJobs.child(job, { operation: 'preview', files: inputs, body: { baseRevision }, base: { dbPath: catalog.path, revision: baseRevision }, output }, progress);
        return buildJobs.activate(output, baseRevision, user.actor, 'import-folder', progress, job);
      }, [output + '.partial', output + '.partial-journal'], false, [output]));
    }
    if (pathname === '/api/import/file' && req.method === 'POST') { requireRole(user, 'admin'); const item = await buildJobs.receive(req, String(q.name || ''), user.actor); return json(res, 202, buildJobs.upload(item)); }
    if (pathname === '/api/import/artifact' && req.method === 'POST') { requireRole(user, 'admin'); const revision = q.baseRevision == null ? catalog.revision() : Number(q.baseRevision); const item = await buildJobs.receive(req, String(q.name || ''), user.actor, true); return json(res, 202, buildJobs.uploadArtifact(item, revision)); }
    if (writeRoutes.has(pathname) && req.method === 'POST') { const [method, role] = writeRoutes.get(pathname); requireRole(user, role); return job(res, method, await body(req), user); }
    if (pathname === '/api/ai/invoke' && req.method === 'POST') {
      const b = await body(req), methods = { analyze_supply: 'list', explain_code: 'detail', inspect_network: 'graph', get_reports: 'report', summarize_code: 'insights' };
      if (b.tool === 'simulate_forecast') { requireRole(user, 'planner'); return job(res, 'simulate', b.arguments || {}, user); }
      if (!Object.hasOwn(methods, b.tool)) throw Object.assign(Error('不支持该工具；不接受任意SQL或代码执行'), { status: 400 });
      const args = b.arguments || {}, pinned = !args.scenario && (args.revision == null || args.revision === '') ? { ...args, revision: catalog.revision() } : args;
      return json(res, 200, await reader.call(methods[b.tool], pinned, user.actor, { signal: requestAbort.signal }));
    }
    throw Object.assign(Error('接口不存在'), { status: 404 });
  } catch (e) { if (!res.headersSent) json(res, e.status || 500, { error: { code: e.code || String(e.status || 500), message: e.message, details: e.details, requestId } }); else res.end(); }
});
server.requestTimeout = 0; // Large uploads stream to disk; the browser controls build jobs separately.
server.listen(port, host, () => console.log(`供应预测控制塔 http://${host}:${port} | 数据库 ${dbPath} | ${tokens.length ? '令牌权限已启用' : '仅本机访问'} | 离线构建/在线装载`));
function shutdown() { stopping = true; buildJobs.shutdown(); server.close(); for (const lane of lanes) lane.close(); eventLoop.disable(); catalog.close(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
