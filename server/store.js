'use strict';
const { DatabaseSync } = require('node:sqlite');
const { gzipSync, gunzipSync } = require('node:zlib');
const { mkdirSync, readFileSync } = require('node:fs');
const { dirname, join, resolve, relative, basename } = require('node:path');
const { createHash } = require('node:crypto');
const C = require('../forecast-core');
const { Artifact, buildSnapshot, algorithm } = require('./artifact');
const { randomUUID } = require('node:crypto');
// Persisted matrices must never silently survive a change to calculation rules.
class Store {
  constructor(path, options = {}) {
    this.allowObsolete = !!options.allowObsolete;
    this.path = resolve(path); this.artifactDir = join(dirname(this.path), basename(this.path) + '.builds'); this.artifacts = new Map();
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS snapshots (revision INTEGER PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL, payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS records (table_name TEXT NOT NULL,row_no INTEGER NOT NULL,code TEXT,parent TEXT,child TEXT,version TEXT,month TEXT,site TEXT,snapshot_date TEXT,data TEXT NOT NULL,PRIMARY KEY(table_name,row_no));
      CREATE INDEX IF NOT EXISTS idx_records_code ON records(table_name,code);
      CREATE INDEX IF NOT EXISTS idx_records_parent ON records(table_name,parent);
      CREATE INDEX IF NOT EXISTS idx_records_child ON records(table_name,child);
      CREATE INDEX IF NOT EXISTS idx_records_forecast ON records(table_name,version,month,code,site);
      CREATE INDEX IF NOT EXISTS idx_records_inventory ON records(table_name,snapshot_date,code);
      CREATE TABLE IF NOT EXISTS derived(revision INTEGER NOT NULL,version TEXT NOT NULL,algorithm TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(revision,version,algorithm));
      CREATE TABLE IF NOT EXISTS scenarios(id TEXT PRIMARY KEY,actor TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,request TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,created_at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,revision INTEGER,details TEXT);
      CREATE TABLE IF NOT EXISTS artifact_refs(revision INTEGER PRIMARY KEY,path TEXT NOT NULL,build_id TEXT NOT NULL);`);
  }
  revision() { return this.db.prepare('SELECT MAX(revision) AS rev FROM snapshots').get().rev || 0; }
  load(revision) {
    const ref = this.artifact(revision == null ? this.revision() : revision); if (ref) return ref.load(revision == null ? this.revision() : revision);
    const r = revision == null ? this.db.prepare('SELECT payload FROM snapshots ORDER BY revision DESC LIMIT 1').get() : this.db.prepare('SELECT payload FROM snapshots WHERE revision=?').get(revision);
    if (!r) { if (revision) throw Object.assign(Error('数据快照不存在'), { status: 404 }); return C.empty(); }
    const data = JSON.parse(gunzipSync(r.payload));
    if (data.storage === 'artifact') return this.openArtifact(resolve(dirname(this.path), data.path)).load(data.revision);
    return data;
  }
  save(next, expected, actor, action, prepared) {
    const filename = join(this.artifactDir, randomUUID() + '.supply');
    buildSnapshot(next, filename, { prepared });
    try { this.activate(filename, expected, actor, action); next.revision = expected + 1; next.updated_at = new Date().toISOString(); return next; }
    catch (e) { try { require('node:fs').unlinkSync(filename); } catch {} throw e; }
  }
  activate(filename, expected, actor, action = 'import') {
    const artifact = new Artifact(filename), m = artifact.manifest; artifact.close();
    const revision = expected + 1, updated_at = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.revision() !== expected) throw Object.assign(Error('数据已被其他操作更新，请重新预览或加载后再保存'), { status: 409 });
      const descriptor = { storage: 'artifact', path: relative(dirname(this.path), resolve(filename)), revision, buildId: m.buildId };
      this.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?)').run(revision, updated_at, m.kind, gzipSync(JSON.stringify(descriptor)));
      this.db.prepare('INSERT INTO artifact_refs VALUES(?,?,?)').run(revision, descriptor.path, m.buildId);
      this.db.prepare('INSERT INTO audit(created_at,actor,action,revision,details) VALUES(?,?,?,?,?)').run(updated_at, actor, action, revision, JSON.stringify({ buildId: m.buildId, counts: m.counts }));
      this.db.exec('COMMIT'); return revision;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  openArtifact(filename) {
    if (!this.artifacts.has(filename)) { if (this.artifacts.size >= 2) { const key = this.artifacts.keys().next().value; this.artifacts.get(key).close(); this.artifacts.delete(key); } this.artifacts.set(filename, new Artifact(filename, { allowDifferentAlgorithm: this.allowObsolete })); }
    return this.artifacts.get(filename);
  }
  artifact(revision = this.revision()) {
    const row = this.db.prepare('SELECT path FROM artifact_refs WHERE revision=?').get(revision);
    if (!row) return null;
    return this.openArtifact(resolve(dirname(this.path), row.path));
  }
  info() {
    const revision = this.revision(), latest = this.db.prepare('SELECT created_at,kind FROM snapshots WHERE revision=?').get(revision);
    let artifact;
    try { artifact = this.artifact(revision); } catch (e) { return this.emptyInfo(revision, latest, e.message); }
    if (!artifact) return this.emptyInfo(revision, latest, revision ? '现有数据是旧版快照，请从数据管理启动重建或离线构建；在线服务不会重算' : null);
    const m = artifact.manifest, version = m.versions.at(-1);
    return { revision, kind: m.kind, updated_at: latest.created_at, config: m.config, counts: m.counts, versions: m.versions, months: m.monthsByVersion[version] || [], codes: m.codes, edges: m.edges, levels: m.levels, precomputed: { ...m.statsByVersion[version], restored: true, buildId: m.buildId }, sites: m.sites, warnings: m.warnings, industry: m.industry, history: this.history(), needsBuild: false };
  }
  emptyInfo(revision, latest, message) { return { revision, kind: latest?.kind || 'empty', updated_at: latest?.created_at || null, config: C.defaults, counts: Object.fromEntries(Object.keys(C.schemas).map(k => [k, 0])), versions: [], months: [], codes: 0, edges: 0, levels: 0, sites: [], warnings: message ? [message] : [], industry: [], history: this.history(), needsBuild: !!message }; }
  history() { return this.db.prepare('SELECT revision,created_at,kind FROM snapshots ORDER BY revision DESC LIMIT 50').all(); }
  derived(revision, version) { const artifact = this.artifact(revision); if (artifact) return artifact.derived(version); const row = this.db.prepare('SELECT payload FROM derived WHERE revision=? AND version=? AND algorithm=?').get(revision, version, algorithm); return row ? require('node:v8').deserialize(gunzipSync(row.payload)) : null; }
  saveDerived(revision, version, value) { this.db.prepare('INSERT OR REPLACE INTO derived VALUES(?,?,?,?)').run(revision, version, algorithm, gzipSync(require('node:v8').serialize(value))); }
  table(table, code, offset, limit, revision = this.revision()) {
    const artifact = this.artifact(revision); if (artifact) return artifact.table(table, code, offset, limit);
    if (revision !== this.revision()) { const values = this.load(revision).tables[table], rows = code ? values.filter(r => r.code === code) : values; return { total: rows.length, rows: rows.slice(offset, offset + limit) }; }
    const where = code ? 'table_name=? AND code=?' : 'table_name=?', args = code ? [table, code] : [table];
    this.db.exec('BEGIN');
    try {
      const total = this.db.prepare('SELECT COUNT(*) AS n FROM records WHERE ' + where).get(...args).n;
      const rows = this.db.prepare('SELECT data FROM records WHERE ' + where + ' ORDER BY row_no LIMIT ? OFFSET ?').all(...args, limit, offset).map(r => JSON.parse(r.data));
      this.db.exec('COMMIT'); return { total, rows };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  scenarioSave(id, actor, revision, request) { this.db.prepare('INSERT INTO scenarios VALUES(?,?,?,?,?)').run(id, actor, revision, new Date().toISOString(), JSON.stringify(request)); }
  scenario(id, actor) { const r = this.db.prepare('SELECT * FROM scenarios WHERE id=? AND actor=?').get(id, actor); if (!r) throw Object.assign(Error('推演不存在或无权访问'), { status: 404 }); return { ...r, request: JSON.parse(r.request) }; }
  close() { for (const artifact of this.artifacts.values()) artifact.close(); this.artifacts.clear(); this.db.close(); }
}
module.exports = Store;
