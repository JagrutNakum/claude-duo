const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { deriveKey, encryptPayload, decryptPayload } = require('./crypto_e2ee');

// ntfy.sh public limits (docs.ntfy.sh/publish, "Limitations"): 60-request burst refilled at
// one request per 5s, and 250 messages per day per visitor. The old design (publish every 3s,
// poll every 4s) exhausted both within minutes, so publishing is now change-driven:
//  - urgent changes (ping, reservation, active/idle flip): at most one publish per 10s
//  - other changes (quota %, shares): coalesced, at most one publish per 5 min
//  - heartbeat: one publish after 10 min of silence, so the peer knows we are online
// Receiving uses one long-lived streaming subscription instead of polling.
const URGENT_GAP_MS = 10 * 1000;
const NORMAL_GAP_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 10 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;
const STREAM_STALL_MS = 2 * 60 * 1000; // ntfy sends keepalives every ~45s
const INITIAL_SINCE = '30m';

// Own relay (server/cloudflare-relay), selected by a ws:// or wss:// server URL. No message caps,
// so only coalesce enough to stay well inside the free plan's 100k SQLite writes per day.
const WS_URGENT_GAP_MS = 1000;
const WS_NORMAL_GAP_MS = 5000;
const WS_HEARTBEAT_MS = 5 * 60 * 1000;
const WS_PING_MS = 30 * 1000;
const WS_STALL_MS = 75 * 1000;

function isWsUrl(u) {
  return /^wss?:\/\//i.test(u || '');
}

class RelayClient extends EventEmitter {
  constructor(config = {}) {
    super();
    this.serverUrl = config.relayUrl || 'https://ntfy.sh';
    this.roomTopic = config.topic || 'claude-duo-room-default';
    this.passphrase = config.passphrase || 'default-shared-pass';
    this.key = deriveKey(this.passphrase);
    this.deviceId = config.deviceId || 'device-' + Math.random().toString(36).substring(2, 8);
    this.userName = config.userName || 'User';
    this.stateProvider = config.stateProvider || null;

    this.seq = 0;
    this.lastPeerSeen = 0;
    this.status = 'connecting'; // connecting | connected | offline | rate-limited

    // Publish scheduling
    this.lastPublishAt = 0;
    this.publishTimer = null;
    this.publishDueAt = 0;
    this.publishBlockedUntil = 0;
    this.heartbeatTimer = null;

    // Subscription
    this.stopped = true;
    this.req = null;
    this.lastEventId = null;
    this.lastDataAt = 0;
    this.retryDelay = 5000;
    this.reconnectTimer = null;
    this.watchdog = null;
    this.lastTsByDevice = new Map();
    this.ws = null;
    this.pingTimer = null;
  }

  get usesOwnRelay() {
    return isWsUrl(this.serverUrl);
  }

  // Unguessable room name; the key cannot be recovered from it.
  _roomId() {
    return crypto.createHash('sha256').update('claude-duo-room-v1').update(this.key).update(this.roomTopic).digest('hex');
  }

  setCredentials(userName, passphrase, topic) {
    this.userName = userName;
    this.passphrase = passphrase;
    this.key = deriveKey(passphrase);
    if (topic) this.roomTopic = topic;
  }

  // Apply new connection settings. Returns true when the channel itself changed (topic, server or
  // key), in which case history from the old channel is dropped and the stream reconnects.
  reconfigure({ userName, passphrase, topic, relayUrl }) {
    if (userName) this.userName = userName;
    const channelChanged = (passphrase && passphrase !== this.passphrase) || (topic && topic !== this.roomTopic) || (relayUrl && relayUrl !== this.serverUrl);
    if (!channelChanged) return false;
    if (passphrase) { this.passphrase = passphrase; this.key = deriveKey(passphrase); }
    if (topic) this.roomTopic = topic;
    if (relayUrl) this.serverUrl = relayUrl;
    this.lastEventId = null;
    this.lastTsByDevice.clear();
    this.lastPeerSeen = 0;
    this.publishBlockedUntil = 0;
    this._setStatus('connecting');
    this.startListening();
    return true;
  }

  // Reachability check that does not spend the daily message budget (ntfy's health endpoint).
  testConnection(relayUrl) {
    const base = (relayUrl || this.serverUrl).replace(/^ws(s?):\/\//i, 'http$1://');
    return new Promise((resolve) => {
      let url;
      try { url = new URL('/v1/health', base); } catch (e) { return resolve({ ok: false, error: 'Invalid server URL' }); }
      const client = url.protocol === 'https:' ? https : http;
      const started = Date.now();
      const req = client.request(url, { method: 'GET', headers: { 'User-Agent': 'ClaudeDuo/1.1' }, timeout: 5000 }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { if (body.length < 4096) body += c; });
        res.on('end', () => {
          const ms = Date.now() - started;
          if (res.statusCode === 429) return resolve({ ok: false, ms, error: 'Rate-limited by the relay' });
          let healthy = res.statusCode === 200;
          try { healthy = healthy && JSON.parse(body).healthy !== false; } catch (e) {}
          resolve(healthy ? { ok: true, ms } : { ok: false, ms, error: `Relay answered HTTP ${res.statusCode}` });
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'No answer within 5 seconds' }); });
      req.on('error', (e) => resolve({ ok: false, error: e.code === 'ENOTFOUND' ? 'Server not found' : 'Could not connect' }));
      req.end();
    });
  }

  _setStatus(status) {
    if (this.status !== status) {
      this.status = status;
      this.emit('status', status);
    }
  }

  // Ask for the current state (from stateProvider) to be published, respecting the rate budget.
  requestPublish(urgent = false) {
    const now = Date.now();
    const gap = this.usesOwnRelay ? (urgent ? WS_URGENT_GAP_MS : WS_NORMAL_GAP_MS) : (urgent ? URGENT_GAP_MS : NORMAL_GAP_MS);
    const dueAt = Math.max(now, this.lastPublishAt + gap, this.publishBlockedUntil);
    if (this.publishTimer && this.publishDueAt <= dueAt) return; // an earlier publish is already queued
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishDueAt = dueAt;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.publishDueAt = 0;
      if (this.stateProvider) this.publishState(this.stateProvider());
    }, dueAt - now);
  }

  _scheduleHeartbeat() {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => this.requestPublish(false), this.usesOwnRelay ? WS_HEARTBEAT_MS : HEARTBEAT_MS);
  }

  publishState(stateObj) {
    if (!this.key || !this.roomTopic) return;
    this.seq++;
    this.lastPublishAt = Date.now();
    this._scheduleHeartbeat();

    const payload = {
      v: 1,
      sender: this.userName,
      deviceId: this.deviceId,
      state: stateObj,
      ts: Date.now(),
      seq: this.seq
    };

    const envelope = encryptPayload(payload, this.key, this.seq);
    if (!envelope) return;

    const data = JSON.stringify(envelope);
    if (this.usesOwnRelay) {
      // Not connected: the open handler publishes the current state instead.
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'state', env: data }));
      return;
    }
    const url = new URL(`/${this.roomTopic}`, this.serverUrl);
    const client = url.protocol === 'https:' ? https : http;

    const req = client.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Title': 'sync'
      },
      timeout: 5000
    }, res => {
      res.resume();
      if (res.statusCode === 429) {
        this.publishBlockedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        this._setStatus('rate-limited');
      } else if (res.statusCode >= 200 && res.statusCode < 300 && this.status === 'rate-limited') {
        this._setStatus(this.req ? 'connected' : 'connecting');
      }
    });

    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
    req.write(data);
    req.end();
  }

  startListening() {
    this.stopListening();
    this.stopped = false;
    this._connect();
    this.watchdog = setInterval(() => {
      const stalledFor = this.lastDataAt ? Date.now() - this.lastDataAt : 0;
      if (this.ws && stalledFor > WS_STALL_MS) {
        this.ws.close(); // triggers reconnect
      } else if (this.req && stalledFor > STREAM_STALL_MS) {
        this.req.destroy(); // triggers reconnect
      }
    }, 15000);
  }

  _connectWs() {
    let url;
    try {
      url = new URL(`/v1/rooms/${this._roomId()}`, this.serverUrl);
      url.searchParams.set('device', crypto.createHash('sha256').update(this.key).update(this.deviceId).digest('hex').slice(0, 32));
    } catch (e) {
      this._setStatus('offline');
      return;
    }
    const ws = new WebSocket(url.toString());
    this.ws = ws;
    const current = () => this.ws === ws;

    ws.addEventListener('open', () => {
      if (!current()) return;
      this.retryDelay = 5000;
      this.lastDataAt = Date.now();
      this._setStatus('connected');
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, WS_PING_MS);
      if (this.stateProvider) this.publishState(this.stateProvider());
    });
    ws.addEventListener('message', (ev) => {
      if (!current()) return;
      this.lastDataAt = Date.now();
      if (ev.data === 'pong' || typeof ev.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === 'snapshot' && Array.isArray(msg.states)) {
        for (const s of msg.states) this._handleEnvelopeText(s.env);
      } else if (msg.t === 'state') {
        this._handleEnvelopeText(msg.env);
      }
    });
    ws.addEventListener('close', (ev) => {
      if (!current()) return;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.ws = null;
      if (ev.code === 4029) {
        this._setStatus('rate-limited');
        this._reconnect(60000);
      } else {
        this._setStatus('offline');
        this._reconnect();
      }
    });
    ws.addEventListener('error', () => {}); // close follows
  }

  _connect() {
    if (this.stopped || !this.key || !this.roomTopic) return;
    if (this.usesOwnRelay) return this._connectWs();
    const since = this.lastEventId || INITIAL_SINCE;
    const url = new URL(`/${this.roomTopic}/json?since=${encodeURIComponent(since)}`, this.serverUrl);
    const client = url.protocol === 'https:' ? https : http;

    // Late events from an old request must not spawn a second stream.
    let req = null;
    const drop = (delayMs) => {
      if (this.req !== req) return;
      this._reconnect(delayMs);
    };

    req = client.request(url, {
      method: 'GET',
      headers: { 'User-Agent': 'ClaudeDuo/1.1' }
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        if (res.statusCode === 429) {
          this._setStatus('rate-limited');
          drop(RATE_LIMIT_BACKOFF_MS);
        } else {
          this._setStatus('offline');
          drop();
        }
        return;
      }
      this.retryDelay = 5000;
      this.lastDataAt = Date.now();
      if (Date.now() >= this.publishBlockedUntil) this._setStatus('connected');
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', chunk => {
        this.lastDataAt = Date.now();
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          this._handleLine(line);
        }
      });
      res.on('end', () => drop());
      res.on('error', () => drop());
      res.on('close', () => drop());
    });

    req.on('error', () => {
      if (this.req === req && this.status !== 'rate-limited') this._setStatus('offline');
      drop();
    });
    req.end();
    this.req = req;
  }

  _reconnect(delayMs) {
    this.req = null;
    if (this.stopped || this.reconnectTimer) return;
    const delay = delayMs || this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, 60000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _handleLine(line) {
    if (!line) return;
    try {
      const raw = JSON.parse(line);
      if (raw.event !== 'message' || !raw.message) return;
      if (raw.id) this.lastEventId = raw.id;
      this._handleEnvelopeText(raw.message);
    } catch (e) {}
  }

  _handleEnvelopeText(text) {
    try {
      const envelope = JSON.parse(text);
      const decrypted = decryptPayload(envelope, this.key);
      if (!decrypted) return;

      // Discard our own machine events
      if (decrypted.deviceId === this.deviceId) return;

      // Drop duplicates and out-of-order replays (e.g. after reconnecting)
      const prevTs = this.lastTsByDevice.get(decrypted.deviceId) || 0;
      if (decrypted.ts && decrypted.ts <= prevTs) return;
      if (decrypted.ts) this.lastTsByDevice.set(decrypted.deviceId, decrypted.ts);

      this.lastPeerSeen = Date.now();
      this.emit('peer_update', decrypted);
    } catch (e) {}
  }

  isPeerOnline() {
    return (Date.now() - this.lastPeerSeen) < (25 * 60 * 1000);
  }

  stopListening() {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.watchdog = null;
    this.reconnectTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.ws) {
      const w = this.ws;
      this.ws = null;
      try { w.close(); } catch (e) {}
    }
    if (this.req) {
      const r = this.req;
      this.req = null;
      r.destroy();
    }
  }
}

module.exports = {
  RelayClient
};
