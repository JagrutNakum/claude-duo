const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  ts INTEGER NOT NULL,
  model TEXT,
  effort TEXT,
  thinking TEXT,
  speed TEXT,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  thinking_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  sidechain INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS turns_ts ON turns(ts);
CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id, ts);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  project TEXT
);
CREATE TABLE IF NOT EXISTS readings (
  ts INTEGER PRIMARY KEY,
  pct_5h REAL,
  resets_at INTEGER,
  pct_7d REAL,
  source TEXT
);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  offset INTEGER NOT NULL,
  size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS peer_daily (
  peer_name TEXT NOT NULL,
  day TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (peer_name, day)
);
`;

const SUMS = `COUNT(*) AS turns, COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output,
  COALESCE(SUM(thinking_tokens),0) AS thinking, COALESCE(SUM(cache_write),0) AS cacheWrite, COALESCE(SUM(cache_read),0) AS cacheRead`;

class UsageDb {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    const s = (sql) => this.db.prepare(sql);
    this.q = {
      // A message is logged once per content block; keep the largest numbers seen.
      upsertTurn: s(`INSERT INTO turns (id, session_id, ts, model, effort, thinking, speed, input, output, thinking_tokens, cache_write, cache_read, sidechain)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET input = max(input, excluded.input), output = max(output, excluded.output),
          thinking_tokens = max(thinking_tokens, excluded.thinking_tokens), cache_write = max(cache_write, excluded.cache_write),
          cache_read = max(cache_read, excluded.cache_read), effort = COALESCE(effort, excluded.effort), thinking = COALESCE(thinking, excluded.thinking)`),
      upsertSession: s(`INSERT INTO sessions (id, title, project) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = COALESCE(excluded.title, title), project = COALESCE(project, excluded.project)`),
      addReading: s('INSERT OR IGNORE INTO readings (ts, pct_5h, resets_at, pct_7d, source) VALUES (?, ?, ?, ?, ?)'),
      setFile: s('INSERT INTO files (path, offset, size) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, size = excluded.size'),
      getFile: s('SELECT offset, size FROM files WHERE path = ?'),
      totals: s(`SELECT ${SUMS} FROM turns WHERE ts > ? AND ts <= ?`),
      sessions: s(`SELECT t.session_id AS id, s.title, s.project, ${SUMS}, MIN(t.ts) AS firstTs, MAX(t.ts) AS lastTs
        FROM turns t LEFT JOIN sessions s ON s.id = t.session_id
        WHERE t.ts > ? AND t.ts <= ? AND t.session_id IS NOT NULL
        GROUP BY t.session_id ORDER BY lastTs DESC LIMIT ?`),
      latestOfSession: s('SELECT model, effort, thinking, speed FROM turns WHERE session_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1'),
      byModel: s(`SELECT model, ${SUMS} FROM turns WHERE ts > ? AND ts <= ? GROUP BY model ORDER BY output DESC`),
      readingsSince: s('SELECT ts, pct_5h AS pct, resets_at AS resetsAt FROM readings WHERE ts > ? ORDER BY ts'),
      turnsSince: s(`SELECT id, session_id AS sessionId, ts AS timestamp, model, effort, thinking, speed, input AS inputTokens,
        output AS outputTokens, thinking_tokens AS thinkingTokens, cache_write AS cacheWriteTokens, cache_read AS cacheReadTokens
        FROM turns WHERE ts > ? ORDER BY ts`),
      dailyUsage: s(`SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day,
        COUNT(*) AS turns, COALESCE(SUM(output), 0) AS output,
        COALESCE(SUM(input + output + cache_write), 0) AS tokens
        FROM turns WHERE ts > ? AND ts <= ?
        GROUP BY day ORDER BY day ASC`),
      hourlyUsage: s(`SELECT strftime('%Y-%m-%d %H:00', ts / 1000, 'unixepoch', 'localtime') AS slot,
        strftime('%H', ts / 1000, 'unixepoch', 'localtime') AS hour,
        COUNT(*) AS turns, COALESCE(SUM(output), 0) AS output,
        COALESCE(SUM(input + output + cache_write), 0) AS tokens
        FROM turns WHERE ts > ? AND ts <= ?
        GROUP BY slot ORDER BY slot ASC`),
      upsertPeerDaily: s(`INSERT INTO peer_daily (peer_name, day, turns, tokens, output) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(peer_name, day) DO UPDATE SET turns = excluded.turns, tokens = excluded.tokens, output = excluded.output`),
      peerDailyUsage: s(`SELECT day, turns, tokens, output FROM peer_daily WHERE peer_name = ? AND day >= ? ORDER BY day ASC`)
    };
  }

  upsertTurn(t) {
    this.q.upsertTurn.run(t.id, t.sessionId || null, t.timestamp, t.model || null, t.effort || null, t.thinking || null, t.speed || null,
      t.inputTokens || 0, t.outputTokens || 0, t.thinkingTokens || 0, t.cacheWriteTokens || 0, t.cacheReadTokens || 0, t.sidechain ? 1 : 0);
  }

  upsertSession(id, { title = null, project = null } = {}) {
    if (id) this.q.upsertSession.run(id, title, project);
  }

  addReading(ts, pct5h, resetsAt, pct7d, source) {
    this.q.addReading.run(Math.round(ts), pct5h, resetsAt || null, pct7d == null ? null : pct7d, source || null);
  }

  // Byte offset of the last complete line read, so a restart resumes instead of re-reading.
  getFileOffset(file, size) {
    const row = this.q.getFile.get(file);
    return row && row.offset <= size ? row.offset : 0;
  }

  setFileOffset(file, offset, size) {
    this.q.setFile.run(file, offset, size);
  }

  totals(from, to) {
    return { ...this.q.totals.get(from, to) };
  }

  sessions(from, to, limit = 20) {
    return this.q.sessions.all(from, to, limit).map(r => ({ ...r, ...this.q.latestOfSession.get(r.id, to) }));
  }

  byModel(from, to) {
    return this.q.byModel.all(from, to).map(r => ({ ...r }));
  }

  turnsSince(ts) {
    return this.q.turnsSince.all(ts).map(r => ({ ...r }));
  }

  readingsSince(ts) {
    return this.q.readingsSince.all(ts).map(r => ({ ...r }));
  }

  dailyUsage(from, to) {
    return this.q.dailyUsage.all(from, to).map(r => ({ ...r }));
  }

  hourlyUsage(from, to) {
    return this.q.hourlyUsage.all(from, to).map(r => ({ ...r }));
  }

  upsertPeerDaily(peerName, day, turns, tokens, output) {
    if (peerName && day) this.q.upsertPeerDaily.run(peerName, day, turns || 0, tokens || 0, output || 0);
  }

  peerDailyUsage(peerName, fromDay) {
    if (!peerName) return [];
    return this.q.peerDailyUsage.all(peerName, fromDay || '').map(r => ({ ...r }));
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close() {
    this.db.close();
  }
}

module.exports = { UsageDb };
