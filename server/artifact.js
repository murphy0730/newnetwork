'use strict';
// Immutable, portable build output. No whole-snapshot JSON string or duplicate row store.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs'), path = require('node:path');
const { gzipSync, gunzipSync } = require('node:zlib');
const { createHash, randomUUID } = require('node:crypto');
const C = require('../forecast-core'), Engine = require('./engine');
const FORMAT = 'supply-build-v1';
const algorithm = 'dag-artifact-1-' + createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../forecast-core.js'))).update(fs.readFileSync(path.join(__dirname, 'engine.js'))).digest('hex');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => Object.assign(Error(message), { status: 422 });
const maximumLevel = graph => { let max = -1; for (const level of graph.level.values()) max = Math.max(max, level); return max + 1; };

function buildSnapshot(snapshot, filename, { progress = () => {}, sources = [], prepared } = {}) {
  if (fs.existsSync(filename)) throw fail('构建目标已存在，请使用新的产物文件名');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = filename + '.partial', started = Date.now();
  const validation = C.validate(snapshot);
  if (validation.errors.length) throw Object.assign(fail('关联校验失败'), { details: validation.errors.slice(0, 1000) });
  progress({ phase: 'graph', message: '建立BOM图及周期路径', percent: 35 });
  const graph = C.topology(snapshot.tables), versions = [...new Set(snapshot.tables.forecast.map(r => r.plan_date))].sort();
  const counts = Object.fromEntries(Object.entries(snapshot.tables).map(([k, rows]) => [k, rows.length]));
  const manifest = { format: FORMAT, algorithm, buildId: randomUUID(), builtAt: new Date().toISOString(), kind: snapshot.kind, config: snapshot.config, counts, versions, monthsByVersion: {}, statsByVersion: {}, codes: graph.codes.length, edges: snapshot.tables.bom.length, levels: maximumLevel(graph), warnings: validation.warnings, sources, summaries: [], sites: [], industry: snapshot.tables.industry, tableJsonCharacters: 0, maxChunkBytes: 0 };
  const sites = new Map();
  for (const r of snapshot.tables.forecast) if (r.site_code || r.site_name) { const code = r.site_code || '名称:' + r.site_name; sites.set(code, { code, name: r.site_name || r.site_code }); }
  manifest.sites = [...sites.values()];
  manifest.categories = [...new Set(snapshot.tables.attributes.map(r => r.part_category).filter(Boolean))].sort();
  const db = new DatabaseSync(temporary);
  try {
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE manifest(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
      CREATE TABLE chunks(section TEXT NOT NULL,seq INTEGER NOT NULL,rows INTEGER NOT NULL,payload BLOB NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(section,seq));
      CREATE TABLE matrices(version TEXT NOT NULL,key TEXT NOT NULL,cells INTEGER NOT NULL,payload BLOB NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(version,key));
      BEGIN IMMEDIATE;`);
    const insert = db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?)');
    function writeRows(section, rows) {
      let batch = [], bytes = 2, seq = 0;
      const flush = () => { if (!batch.length) return; const raw = Buffer.from('[' + batch.join(',') + ']'), payload = gzipSync(raw, { level: 1 }); manifest.maxChunkBytes = Math.max(manifest.maxChunkBytes, raw.length); insert.run(section, seq++, batch.length, payload, hash(payload)); batch = []; bytes = 2; };
      for (const row of rows) { const json = JSON.stringify(row); if (section.startsWith('table/')) manifest.tableJsonCharacters += json.length + 1; if (batch.length && (bytes + Buffer.byteLength(json) > 2 * 1024 * 1024 || batch.length >= 2000)) flush(); batch.push(json); bytes += Buffer.byteLength(json) + 1; }
      flush();
    }
    progress({ phase: 'write', message: '分块写入数据表（不生成整份JSON）', percent: 40 });
    for (const [table, rows] of Object.entries(snapshot.tables)) { writeRows('table/' + table, rows); progress({ phase: 'write', message: `已写入 ${table}：${rows.length} 行`, percent: 45 }); }
    const matrixInsert = db.prepare('INSERT INTO matrices VALUES(?,?,?,?,?)');
    let graphWritten = false;
    for (let vi = 0; vi < Math.max(1, versions.length); vi++) {
      const version = versions[vi], e = new Engine(snapshot, version, graph), begun = Date.now();
      if (!graphWritten) {
        writeRows('graph', (function* () { for (const code of graph.codes) yield [code, e.orderIndex.get(code), graph.level.get(code), e.criticalCache.get(code)]; })());
        graphWritten = true;
      }
      if (!version) continue;
      let matrices = 0;
      for (let mi = 0; mi < e.months.length; mi++) {
        const month = e.months[mi];
        for (const mode of ['direct', 'cross', 'top']) for (const source of ['forecast', 'mo']) {
          const key = JSON.stringify([month, mode, source]);
          const matrix = prepared?.version === version && prepared.materialized.has(key) ? prepared.materialized.get(key) : e.matrix(month, mode, source);
          // Explicit little-endian encoding makes the artifact independent of V8 serialization.
          const raw = Buffer.allocUnsafe(matrix.length * 8);
          for (let i = 0; i < matrix.length; i++) raw.writeDoubleLE(matrix[i], i * 8);
          const payload = gzipSync(raw, { level: 1 });
          matrixInsert.run(version, key, matrix.length, payload, hash(payload)); matrices++;
        }
        e.materialized.clear();
        progress({ phase: 'compute', message: `${version} / ${month}：三种口径及两种供应来源已完成`, percent: 50 + Math.round(40 * (vi + (mi + 1) / e.months.length) / versions.length) });
      }
      manifest.monthsByVersion[version] = e.months;
      manifest.statsByVersion[version] = { milliseconds: Date.now() - begun, matrices, cells: graph.codes.length * e.months.length * 6 };
    }
    manifest.milliseconds = Date.now() - started;
    db.prepare('INSERT INTO manifest VALUES(1,?)').run(JSON.stringify(manifest));
    db.exec('COMMIT'); db.close();
    fs.renameSync(temporary, filename);
    progress({ phase: 'built', message: '构建产物已完成，等待在线装载', percent: 95 });
    return manifest;
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} try { db.close(); } catch {} try { fs.unlinkSync(temporary); } catch {} try { fs.unlinkSync(temporary + '-journal'); } catch {} throw e; }
}

class Artifact {
  constructor(filename, { allowDifferentAlgorithm = false } = {}) {
    this.filename = filename;
    this.db = new DatabaseSync(filename, { readOnly: true });
    try {
      const row = this.db.prepare('SELECT data FROM manifest WHERE id=1').get();
      this.manifest = row ? JSON.parse(row.data) : null;
      if (this.manifest?.format !== FORMAT) throw fail('不是有效的供应网络构建产物');
      if (!allowDifferentAlgorithm && this.manifest.algorithm !== algorithm) throw Object.assign(fail('构建产物的计算规则与当前服务不一致，请使用当前版本重新离线构建'), { code: 'BUILD_REQUIRED' });
      if (!Array.isArray(this.manifest.versions) || !Number.isSafeInteger(this.manifest.codes) || this.manifest.codes < 0) throw fail('产物清单格式无效');
    } catch (e) { this.db.close(); throw e; }
  }
  *rows(section, verify = true) {
    let seq = 0;
    for (const part of this.db.prepare('SELECT * FROM chunks WHERE section=? ORDER BY seq').iterate(section)) {
      if (part.seq !== seq++ || (verify && hash(part.payload) !== part.sha256)) throw fail('构建产物数据块损坏：' + section);
      const rows = JSON.parse(gunzipSync(part.payload));
      if (!Array.isArray(rows) || rows.length !== part.rows) throw fail('构建产物分块行数不符：' + section);
      yield* rows;
    }
  }
  load(revision = 0) {
    if (!this.snapshot) {
      const tables = {};
      for (const table of Object.keys(C.schemas)) { const rows = []; for (const row of this.rows('table/' + table)) rows.push(row); if (rows.length !== this.manifest.counts[table]) throw fail('构建产物表行数不符：' + table); tables[table] = rows; }
      this.snapshot = { format: 1, revision, kind: this.manifest.kind, updated_at: this.manifest.builtAt, config: this.manifest.config, tables };
    }
    return { ...this.snapshot, revision };
  }
  graph(snapshot) {
    if (this.loadedGraph) return this.loadedGraph;
    const codes = [], order = [], level = new Map(), critical = new Map(), parents = new Map(), children = new Map();
    for (const [code, index, depth, cp] of this.rows('graph')) {
      if (parents.has(code) || !Number.isInteger(index) || index < 0 || index >= this.manifest.codes || order[index] != null) throw fail('产物拓扑索引无效');
      codes.push(code); order[index] = code; level.set(code, depth); critical.set(code, cp); parents.set(code, []); children.set(code, []);
    }
    if (codes.length !== this.manifest.codes || order.length !== codes.length) throw fail('产物图规模不符');
    const indices = new Map(order.map((code, i) => [code, i]));
    for (const edge of snapshot.tables.bom) {
      if (!parents.has(edge.child) || !children.has(edge.parent) || indices.get(edge.parent) >= indices.get(edge.child)) throw fail('产物BOM与拓扑序不一致');
      parents.get(edge.child).push(edge); children.get(edge.parent).push(edge);
    }
    return this.loadedGraph = { graph: { codes, order, level, parents, children }, critical };
  }
  derived(version) {
    const materialized = new Map();
    if (!version) return { materialized, stats: { matrices: 0, cells: 0 } };
    for (const part of this.db.prepare('SELECT * FROM matrices WHERE version=?').iterate(version)) {
      if (part.cells !== this.manifest.codes * 2 || hash(part.payload) !== part.sha256) throw fail('产物计算矩阵损坏');
      const raw = gunzipSync(part.payload);
      if (raw.length !== part.cells * 8) throw fail('产物计算矩阵尺寸不符');
      const values = new Float64Array(part.cells);
      for (let i = 0; i < values.length; i++) { const value = raw.readDoubleLE(i * 8); if (!Number.isFinite(value) || (i % 2 && value !== 0 && value !== 1)) throw fail('产物计算矩阵数值无效'); values[i] = value; }
      materialized.set(part.key, values);
    }
    for (const month of this.manifest.monthsByVersion[version] || []) for (const mode of ['direct', 'cross', 'top']) for (const source of ['forecast', 'mo']) if (!materialized.has(JSON.stringify([month, mode, source]))) throw fail('构建产物缺少预计算矩阵，请重新构建');
    return { materialized, stats: this.manifest.statsByVersion[version] };
  }
  verify(progress = () => {}) {
    if (this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw fail('构建产物SQLite校验失败');
    const snap = this.load(); this.graph(snap);
    for (const version of this.manifest.versions) { this.derived(version); progress({ phase: 'verify', message: `已校验产物版本 ${version}`, percent: 80 }); }
    return this.manifest;
  }
  table(table, code, offset, limit) {
    if (this.snapshot) {
      const values = this.snapshot.tables[table];
      if (!code) return { total: values.length, rows: values.slice(offset, offset + limit) };
      this.tableIndexes ||= new Map();
      if (!this.tableIndexes.has(table)) {
        const index = new Map(); for (const row of values) { if (!index.has(row.code)) index.set(row.code, []); index.get(row.code).push(row); }
        if (this.tableIndexes.size >= 2) this.tableIndexes.delete(this.tableIndexes.keys().next().value);
        this.tableIndexes.set(table, index);
      }
      const matches = this.tableIndexes.get(table).get(code) || []; return { total: matches.length, rows: matches.slice(offset, offset + limit) };
    }
    let total = 0; const rows = [];
    const values = this.snapshot ? this.snapshot.tables[table] : this.rows('table/' + table);
    for (const row of values) if (!code || row.code === code) { if (total >= offset && rows.length < limit) rows.push(row); total++; }
    return { total, rows };
  }
  close() { this.db.close(); }
}
module.exports = { Artifact, buildSnapshot, algorithm, FORMAT, maximumLevel };
