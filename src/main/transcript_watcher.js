const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const WINDOW_MS = 5 * 3600 * 1000;
const READ_CHUNK = 1 << 20;
const MAX_DEPTH = 4;

// Tails Claude Code transcripts (~/.claude/projects/**/*.jsonl) into the usage database.
// Extracts usage numbers, model, effort, thinking mode, project and session titles; never message content.
// onTurn only receives turns from the last 5 hours (the live window).
class TranscriptWatcher {
  constructor(rootDir, { db = null, onTurn, onScanDone, onSessionTitle } = {}) {
    this.rootDir = rootDir;
    this.db = db;
    this.onTurn = onTurn;
    this.onScanDone = onScanDone;
    this.onSessionTitle = onSessionTitle;
    this.files = new Map(); // path -> { offset, rest, decoder, lastRequest }
    this.knownProjects = new Set();
    this.scanning = false;
    this.rescanRequested = false;
    this.timer = null;
    this.soonTimer = null;
  }

  start(intervalMs = 15000) {
    this.scan();
    this.timer = setInterval(() => this.scan(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.timer = null;
    this.soonTimer = null;
  }

  // Debounced scan, used when the status line reports activity.
  scanSoon(delayMs = 1500) {
    if (this.soonTimer) return;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      this.scan();
    }, delayMs);
  }

  async scan() {
    if (this.scanning) {
      this.rescanRequested = true;
      return;
    }
    this.scanning = true;
    let found = 0;
    try {
      const cutoff = Date.now() - WINDOW_MS;
      const files = await this._listJsonl(this.rootDir, 0);
      const live = new Set();
      for (const file of files) {
        let st;
        try { st = await fs.promises.stat(file); } catch (e) { continue; }
        // Without a database only the live window matters.
        if (!this.db && st.mtimeMs < cutoff) continue;
        live.add(file);
        let entry = this.files.get(file);
        if (!entry || st.size < entry.offset) {
          const resumeAt = entry || !this.db ? 0 : this.db.getFileOffset(file, st.size);
          entry = { offset: resumeAt, rest: '', decoder: new StringDecoder('utf8'), lastRequest: null };
          this.files.set(file, entry);
        }
        if (st.size === entry.offset) continue;
        found += await this._readNew(file, entry, st.size, cutoff);
      }
      for (const file of this.files.keys()) {
        if (!live.has(file)) this.files.delete(file);
      }
    } catch (e) {
      // Never let a transcript problem take the app down.
    } finally {
      this.scanning = false;
      if (this.onScanDone) {
        try { this.onScanDone(found); } catch (e) {}
      }
      if (this.rescanRequested) {
        this.rescanRequested = false;
        this.scan();
      }
    }
  }

  async _listJsonl(dir, depth) {
    if (depth > MAX_DEPTH) return [];
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return []; }
    const out = [];
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        out.push(...await this._listJsonl(full, depth + 1));
      } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }
    return out;
  }

  async _readNew(file, entry, size, cutoff) {
    let found = 0;
    let fh;
    try {
      fh = await fs.promises.open(file, 'r');
      while (entry.offset < size) {
        const len = Math.min(READ_CHUNK, size - entry.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, entry.offset);
        if (!bytesRead) break;
        entry.offset += bytesRead;
        const text = entry.rest + entry.decoder.write(buf.subarray(0, bytesRead));
        const lines = text.split('\n');
        entry.rest = lines.pop();
        const parseAll = () => {
          for (const line of lines) {
            if (this._parseLine(line, cutoff, entry)) found++;
          }
        };
        if (this.db) {
          this.db.transaction(() => {
            parseAll();
            this.db.setFileOffset(file, entry.offset - Buffer.byteLength(entry.rest), size);
          });
        } else {
          parseAll();
        }
      }
    } catch (e) {
      // File rotated or locked; retry on next scan.
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
    return found;
  }

  _parseLine(line, cutoff, entry) {
    if (!line) return false;
    const isTitle = line.indexOf('"ai-title"') !== -1;
    const isRequest = !isTitle && line.indexOf('"api-request"') !== -1;
    if (!isTitle && !isRequest && line.indexOf('"usage"') === -1) return false;
    let d;
    try { d = JSON.parse(line); } catch (e) { return false; }
    if (!d) return false;

    if (d.type === 'ai-title') {
      if (d.sessionId && typeof d.aiTitle === 'string') {
        const title = d.aiTitle.slice(0, 120);
        if (this.db) this.db.upsertSession(d.sessionId, { title });
        if (this.onSessionTitle) this.onSessionTitle(d.sessionId, title);
      }
      return false;
    }
    if (d.type === 'api-request') {
      // Settings of the request whose response follows in this file.
      const p = d.params || {};
      entry.lastRequest = {
        effort: (p.output_config && p.output_config.effort) || null,
        thinking: (p.thinking && p.thinking.type) || null
      };
      return false;
    }

    const m = d.message;
    if (d.type !== 'assistant' || !m || !m.usage || !m.id) return false;
    const ts = Date.parse(d.timestamp);
    if (!ts) return false;
    const u = m.usage;
    const req = entry.lastRequest || {};
    const turn = {
      id: m.id,
      model: m.model,
      timestamp: ts,
      sessionId: d.sessionId || null,
      sidechain: Boolean(d.isSidechain),
      effort: req.effort || null,
      thinking: req.thinking || null,
      speed: u.speed || null,
      inputTokens: u.input_tokens || 0,
      cacheWriteTokens: u.cache_creation_input_tokens || 0,
      cacheReadTokens: u.cache_read_input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      thinkingTokens: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0
    };
    if (this.db) {
      this.db.upsertTurn(turn);
      if (turn.sessionId && d.cwd && !this.knownProjects.has(turn.sessionId)) {
        this.knownProjects.add(turn.sessionId);
        this.db.upsertSession(turn.sessionId, { project: path.basename(d.cwd) });
      }
    }
    if (ts < cutoff) return false;
    this.onTurn(turn);
    return true;
  }
}

module.exports = {
  TranscriptWatcher
};
