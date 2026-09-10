'use strict';
const { DatabaseSync } = require('node:sqlite');
const { gzipSync, gunzipSync } = require('node:zlib');
const { mkdirSync, readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { createHash } = require('node:crypto');
const C = require('../forecast-core');
// Persisted matrices must never silently survive a change to calculation rules.
const algorithm = 'dag-v3-' + createHash('sha256').update(readFileSync(join(__dirname, '../forecast-core.js'))).update(readFileSync(join(__dirname, 'engine.js'))).digest('hex').slice(0, 20);
class Store {
  constructor(path) {
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
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,created_at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,revision INTEGER,details TEXT);`);
  }
  revision() { return this.db.prepare('SELECT MAX(revision) AS rev FROM snapshots').get().rev || 0; }
  load(revision) {
    const r = revision == null ? this.db.prepare('SELECT payload FROM snapshots ORDER BY revision DESC LIMIT 1').get() : this.db.prepare('SELECT payload FROM snapshots WHERE revision=?').get(revision);
    if (!r) { if (revision) throw Object.assign(Error('数据快照不存在'), { status: 404 }); return C.empty(); }
    return JSON.parse(gunzipSync(r.payload));
  }
  save(next, expected, actor, action, prepared) {
    const published = { ...next, revision: expected + 1, updated_at: new Date().toISOString() };
    const payload = gzipSync(JSON.stringify(published));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.revision() !== expected) throw Object.assign(Error('数据已被其他操作更新，请重新预览或加载后再保存'), { status: 409 });
      this.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?)').run(published.revision, published.updated_at, published.kind, payload);
      this.db.exec('DELETE FROM records');
      const insert = this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?)');
      for (const [key, rows] of Object.entries(next.tables)) rows.forEach((r, i) => insert.run(key, i, r.code || null, r.parent || null, r.child || null, r.plan_date || null, r.month || null, r.site_code || null, r.date || null, JSON.stringify(r)));
      this.db.prepare('INSERT INTO audit(created_at,actor,action,revision,details) VALUES(?,?,?,?,?)').run(published.updated_at, actor, action, published.revision, JSON.stringify({ counts: Object.fromEntries(Object.entries(next.tables).map(([k, v]) => [k, v.length])) }));
      if (prepared?.version) this.saveDerived(published.revision, prepared.version, { materialized: prepared.materialized, stats: prepared.stats });
      this.db.exec('COMMIT'); Object.assign(next, published); return next;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  history() { return this.db.prepare('SELECT revision,created_at,kind FROM snapshots ORDER BY revision DESC LIMIT 50').all(); }
  derived(revision, version) { const row = this.db.prepare('SELECT payload FROM derived WHERE revision=? AND version=? AND algorithm=?').get(revision, version, algorithm); return row ? require('node:v8').deserialize(gunzipSync(row.payload)) : null; }
  saveDerived(revision, version, value) { this.db.prepare('INSERT OR REPLACE INTO derived VALUES(?,?,?,?)').run(revision, version, algorithm, gzipSync(require('node:v8').serialize(value))); }
  table(table, code, offset, limit) {
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
}
module.exports = Store;
