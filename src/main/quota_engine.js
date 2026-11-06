const fs = require('fs');
const path = require('path');
const os = require('os');

const MODEL_WEIGHTS = {
  'opus': 5.0,
  'sonnet': 1.0,
  'haiku': 0.25
};

function getModelWeight(model) {
  if (!model) return 1.0;
  const m = model.toLowerCase();
  if (m.includes('opus')) return MODEL_WEIGHTS['opus'];
  if (m.includes('haiku')) return MODEL_WEIGHTS['haiku'];
  return MODEL_WEIGHTS['sonnet'];
}

function computeTurnQuota(turn) {
  const wm = getModelWeight(turn.model);
  const i = turn.inputTokens || 0;
  const cw = turn.cacheWriteTokens || 0;
  const cr = turn.cacheReadTokens || 0;
  // Claude Code transcripts already include thinking tokens inside output_tokens
  // (usage.output_tokens_details.thinking_tokens is a subset), so they are not added again.
  const o = turn.outputTokens || 0;
  return wm * (i + 1.25 * cw + 0.1 * cr + 5 * o);
}

function formatModelName(model) {
  if (!model) return 'Sonnet';
  const m = String(model).trim();
  const lower = m.toLowerCase();
  const families = ['opus', 'sonnet', 'haiku', 'fable'];

  for (const fam of families) {
    if (!lower.includes(fam)) continue;
    const capFam = fam.charAt(0).toUpperCase() + fam.slice(1);

    const beforeMatch = lower.match(new RegExp(`(\\d+[\\.-]\\d+|\\d+)[\\.-]${fam}`));
    if (beforeMatch) {
      const ver = beforeMatch[1].replace('-', '.');
      return `${capFam} ${ver}`;
    }

    // Minor is 1-2 digits so a date suffix (claude-opus-4-20250514) isn't read as a version.
    const afterMatch = lower.match(new RegExp(`${fam}[\\.-](\\d+(?:[\\.-]\\d{1,2})?)(?!\\d)`));
    if (afterMatch) {
      const ver = afterMatch[1].replace('-', '.');
      return `${capFam} ${ver}`;
    }

    return capFam;
  }

  return m;
}

// Peer is considered online if we heard from it recently. Peers publish a heartbeat
// at least every 10 minutes (see relay_client.js), so allow two missed heartbeats.
const PEER_ONLINE_MS = 25 * 60 * 1000;
// A peer that reported "active" but then went silent (sleep/crash) is shown idle after this.
const PEER_ACTIVE_STALE_MS = 12 * 60 * 1000;
const ACTIVE_WINDOW_MS = 3 * 60 * 1000;

const WINDOW_MS = 5 * 3600 * 1000;
const PACE_WINDOW_MS = 30 * 60 * 1000;
const FACTS_TTL_MS = 10 * 1000;
const DAY_MS = 24 * 3600 * 1000;

// resets_at jitters by under a second between readings of the same window.
function sameWindow(a, b) {
  return Boolean(a && b) && Math.abs(a - b) < 120;
}

function turnTokens(turn) {
  return (turn.inputTokens || 0) + (turn.outputTokens || 0) + (turn.cacheWriteTokens || 0);
}

class QuotaEngine {
  constructor(localUserName, peerUserName) {
    this.localUserName = localUserName || 'You';
    this.peerUserName = peerUserName || 'Teammate';
    
    // Official rate limits from Claude Code statusline
    this.officialFiveHour = {
      usedPercentage: 0,
      resetsAt: null,
      source: null, // 'api' (live usage endpoint) | 'statusline' (this PC's Claude Code CLI) | 'cache' (~/.claude.json) | 'peer' | null (no reading yet)
      lastUpdated: null
    };
    this.officialSevenDay = {
      usedPercentage: 0,
      resetsAt: null
    };

    // Attribution
    this.localRollingQ = 0;
    this.peerRollingQ = 0;
    this.localSharePct = 0;
    this.peerSharePct = 0;

    // Presence & Collision
    this.localActive = false;
    this.peerActive = false;
    this.lastLocalPromptTime = 0;
    this.lastPeerPromptTime = 0;
    this.peerOnline = false;
    this.lastPeerSeen = 0;
    this.peerReportedActive = false;

    // Reservation ("Take the Wheel"). setAt drives last-writer-wins merging between machines.
    this.reservation = {
      holder: null,
      until: null,
      setAt: 0
    };

    // Transcript tailing state
    this.claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
    this.processedLinesByFile = new Map();
    this.localTurns = []; // Last 5 hours of local turns
    this.localTurnsById = new Map(); // message.id -> turn (transcripts repeat a message once per content block)

    // Official % split between connected PCs by their usage in the current window; null when it can't be split.
    this.localQuotaPct = null;
    this.peerQuotaPct = null;
    this.unattributedQuotaPct = null;

    this.officialHistory = []; // recent readings, for the account pace
    this.peerWindow = null; // { resetsAt, q, tokens } reported by the peer
    this.peerDaily = [];
    this.peerHourly = [];
    this.db = null;
    this.factsCache = null;
  }

  attachDb(db) {
    this.db = db;
    this.factsCache = null;
  }

  _recordReading(ts, pct, resetsAt, source) {
    if (!resetsAt || typeof pct !== 'number') return;
    if (this.db) {
      try { this.db.addReading(ts, pct, resetsAt, this.officialSevenDay.usedPercentage, source); } catch (e) {}
    }
    const h = this.officialHistory;
    if (h.length && ts <= h[h.length - 1].ts) return;
    h.push({ ts, pct, resetsAt });
    while (h.length && h[0].ts < Date.now() - 2 * PACE_WINDOW_MS) h.shift();
  }

  // Official % added to the account over (up to) the last 30 minutes of this window.
  _pace(now) {
    const resetsAt = this.officialFiveHour.resetsAt;
    const inWindow = this.officialHistory.filter(r => sameWindow(r.resetsAt, resetsAt));
    if (inWindow.length < 2) return null;
    const latest = inWindow[inWindow.length - 1];
    const base = [...inWindow].reverse().find(r => r.ts <= now - PACE_WINDOW_MS) || inWindow[0];
    const minutes = Math.round((latest.ts - base.ts) / 60000);
    if (minutes < 5) return null;
    return { pct: Math.max(0, latest.pct - base.pct), minutes };
  }

  _windowStart(now) {
    const r = this.officialFiveHour.resetsAt;
    return r && r * 1000 > now ? r * 1000 - WINDOW_MS : now - WINDOW_MS;
  }

  _windowUsage(from) {
    let q = 0;
    let tokens = 0;
    for (const t of this.localTurns) {
      if (t.ts > from) { q += t.q; tokens += t.tokens; }
    }
    return { q, tokens };
  }

  // Exact token facts from the database, cached briefly because the UI asks every few seconds.
  _facts(now) {
    const from = this._windowStart(now);
    if (this.factsCache && now - this.factsCache.at < FACTS_TTL_MS && this.factsCache.from === from) return this.factsCache.value;
    let value = { window: null, sessions: [], byModel: [], periods: null };
    if (this.db) {
      try {
        const midnight = new Date(now);
        midnight.setHours(0, 0, 0, 0);
        const sessions = this.db.sessions(from, now, 8);
        const sessionQ = sessions.map(s => computeTurnQuota({ model: s.model, inputTokens: s.input, outputTokens: s.output, cacheWriteTokens: s.cacheWrite, cacheReadTokens: s.cacheRead }));
        const totalQ = sessionQ.reduce((a, b) => a + b, 0);
        value = {
          window: { from, to: now, ...this.db.totals(from, now) },
          sessions: sessions.map((s, i) => ({
            ...s,
            model: s.model ? formatModelName(s.model) : null,
            costSharePct: totalQ > 0 ? Math.round(sessionQ[i] / totalQ * 1000) / 10 : null
          })),
          byModel: this.db.byModel(from, now).map(m => ({ ...m, model: m.model ? formatModelName(m.model) : null })),
          periods: {
            today: this.db.totals(midnight.getTime(), now),
            last7d: this.db.totals(now - 7 * DAY_MS, now),
            allTime: this.db.totals(0, now)
          }
        };
      } catch (e) {}
    }
    this.factsCache = { at: now, from, value };
    return value;
  }

  // observedAt = when the data was true (cache: fetchedAtMs), not when we read it.
  updateOfficialLimits(statuslineData, observedAt = Date.now(), source = 'statusline') {
    if (!statuslineData || !statuslineData.rate_limits) return false;
    const rl = statuslineData.rate_limits;
    let changed = false;
    const readingAt = Math.min(observedAt || Date.now(), Date.now());
    if (rl.five_hour && readingAt <= (this.officialFiveHour.lastUpdated || 0)) return false;

    if (rl.five_hour) {
      const newPct = Math.round(rl.five_hour.used_percentage || 0);
      const newReset = rl.five_hour.resets_at || null;
      if (newPct !== this.officialFiveHour.usedPercentage || newReset !== this.officialFiveHour.resetsAt) {
        this.officialFiveHour.usedPercentage = newPct;
        this.officialFiveHour.resetsAt = newReset;
        changed = true;
      }
      this.officialFiveHour.lastUpdated = readingAt;
      this.officialFiveHour.source = source;
      this._recordReading(readingAt, newPct, newReset, source);
    }

    if (rl.seven_day) {
      this.officialSevenDay.usedPercentage = Math.round(rl.seven_day.used_percentage || 0);
      this.officialSevenDay.resetsAt = rl.seven_day.resets_at || null;
    }

    if (changed) {
      this.recalculateSplit();
    }
    return changed;
  }

  // Usage comes from transcripts only: the status line repeats the same context usage on every refresh.
  recordStatuslineTelemetry(data) {
    if (!data) return;
    if (data.model && typeof data.model === 'object' && data.model.display_name) {
      this.lastStatuslineModel = data.model.display_name;
    } else if (typeof data.model === 'string') {
      this.lastStatuslineModel = data.model;
    }
  }

  setNames(localUserName, peerUserName) {
    if (peerUserName && peerUserName !== this.peerUserName) {
      // A different teammate: forget the old one's presence and usage.
      this.lastPeerSeen = 0;
      this.peerReportedActive = false;
      this.peerRollingQ = 0;
      this.lastPeerPromptTime = 0;
      this.peerWindow = null;
    }
    if (localUserName) this.localUserName = localUserName;
    if (peerUserName) this.peerUserName = peerUserName;
    this.recalculateSplit();
  }

  // Called when the relay channel changes: nothing heard on the old channel is trustworthy any more.
  resetPeer() {
    this.lastPeerSeen = 0;
    this.peerReportedActive = false;
    this.peerRollingQ = 0;
    this.lastPeerPromptTime = 0;
    this.peerWindow = null;
    if (this.officialFiveHour.source === 'peer') {
      this.officialFiveHour = { usedPercentage: 0, resetsAt: null, source: null, lastUpdated: null };
    }
    this.recalculateSplit();
  }

  recordLocalTurn(turn) {
    const q = computeTurnQuota(turn);
    const ts = turn.timestamp || Date.now();
    if (turn.id) {
      const existing = this.localTurnsById.get(turn.id);
      if (existing) {
        existing.q = Math.max(existing.q, q);
        existing.tokens = Math.max(existing.tokens, turnTokens(turn));
        return existing.q;
      }
    }
    const rec = {
      id: turn.id || null,
      q,
      ts,
      model: turn.model,
      tokens: turnTokens(turn),
      sessionId: turn.sessionId || null,
      effort: turn.effort || null,
      thinking: turn.thinking || null,
      speed: turn.speed || null
    };
    this.localTurns.push(rec);
    if (turn.id) this.localTurnsById.set(turn.id, rec);
    if (ts > this.lastLocalPromptTime) this.lastLocalPromptTime = ts;
    return q;
  }

  // peerState is the peer's getStateSummary(): the peer describes itself under `local`.
  // envelopeTs is the peer's send time, used for legacy peers that do not send setAt.
  // Returns what changed so the caller can decide on notifications.
  updatePeerState(peerState, envelopeTs) {
    const result = { officialChanged: false, reservationChanged: false, prevReservation: { ...this.reservation } };
    if (!peerState) return result;
    const now = Date.now();
    // Use the peer's send time: messages replayed from relay history must not look live.
    // Capped at now in case the peer's clock runs ahead.
    const sentAt = Math.min(envelopeTs || now, now);
    if (sentAt > this.lastPeerSeen) this.lastPeerSeen = sentAt;

    const pl = peerState.local || {};
    this.peerReportedActive = Boolean(pl.active);
    if (typeof pl.rollingQ === 'number') {
      this.peerRollingQ = pl.rollingQ;
    }
    if (pl.model) {
      this.peerModel = pl.model;
    }
    const peerTime = pl.lastActiveTime || pl.lastPromptTime;
    if (typeof peerTime === 'number' && peerTime > this.lastPeerPromptTime) {
      this.lastPeerPromptTime = peerTime;
    }
    if (pl.window && typeof pl.window.q === 'number') {
      this.peerWindow = { resetsAt: pl.window.resetsAt || null, q: pl.window.q, tokens: typeof pl.window.tokens === 'number' ? pl.window.tokens : null };
    }
    if (peerState.heatmap) {
      if (Array.isArray(peerState.heatmap.daily)) {
        this.peerDaily = peerState.heatmap.daily;
        if (this.db && this.peerUserName) {
          try {
            for (const d of this.peerDaily) {
              this.db.upsertPeerDaily(this.peerUserName, d.day, d.turns, d.tokens, d.output);
            }
          } catch (e) {}
        }
      }
      if (Array.isArray(peerState.heatmap.hourly)) {
        this.peerHourly = peerState.heatmap.hourly;
      }
    }

    // The 5-hour limit is account-wide. Adopt the peer's reading when it is newer than ours,
    // so this machine stays current while only the peer is using Claude Code.
    // A real reading always carries a reset time in the future; anything else (test data, a window
    // that already rolled over) is ignored rather than shown as if it were live.
    const peerUpdatedAt = peerState.fiveHourUpdatedAt || 0;
    const peerResetsAt = peerState.fiveHourResetsAt || 0;
    const peerReadingValid = peerResetsAt * 1000 > now && peerUpdatedAt > 0 && peerUpdatedAt <= now + 60000;
    if (peerReadingValid && !peerState.fiveHourIsEstimated && peerUpdatedAt > (this.officialFiveHour.lastUpdated || 0) && typeof peerState.fiveHourUsedPct === 'number') {
      if (peerState.fiveHourUsedPct !== this.officialFiveHour.usedPercentage || (peerState.fiveHourResetsAt || null) !== this.officialFiveHour.resetsAt) {
        result.officialChanged = true;
      }
      this.officialFiveHour.usedPercentage = peerState.fiveHourUsedPct;
      this.officialFiveHour.resetsAt = peerState.fiveHourResetsAt || null;
      this.officialFiveHour.lastUpdated = peerUpdatedAt;
      this.officialFiveHour.source = 'peer';
      this._recordReading(peerUpdatedAt, peerState.fiveHourUsedPct, peerState.fiveHourResetsAt, 'peer');
      if (typeof peerState.sevenDayUsedPct === 'number') {
        this.officialSevenDay.usedPercentage = peerState.sevenDayUsedPct;
      }
    }

    const r = peerState.reservation;
    if (r) {
      let adopt = null;
      if (typeof r.setAt === 'number') {
        // Last writer wins: a peer echoing an older view never overrides a newer local action.
        if (r.setAt > (this.reservation.setAt || 0)) adopt = { holder: r.holder || null, until: r.until || null, setAt: r.setAt };
      } else if (r.holder && r.until > now) {
        // Legacy peer (no setAt): accept an active reservation it announces.
        if (r.holder !== this.reservation.holder || r.until !== this.reservation.until) {
          adopt = { holder: r.holder, until: r.until, setAt: envelopeTs || now };
        }
      } else if (!r.holder && this.reservation.holder && this.reservation.holder === this.peerUserName) {
        // Legacy peer released its own reservation.
        adopt = { holder: null, until: null, setAt: envelopeTs || now };
      }
      if (adopt) {
        result.reservationChanged = adopt.holder !== this.reservation.holder || adopt.until !== this.reservation.until;
        this.reservation = adopt;
      }
    }

    this.recalculateSplit();
    return result;
  }

  recalculateSplit() {
    const now = Date.now();
    const cutoff = now - (5 * 3600 * 1000); // 5 hour window
    
    // Prune local turns older than 5 hours
    this.localTurns = this.localTurns.filter(t => {
      if (t.ts >= cutoff) return true;
      if (t.id) this.localTurnsById.delete(t.id);
      return false;
    });
    this.localRollingQ = this.localTurns.reduce((acc, t) => acc + t.q, 0);

    // Active state decay (idle after 3 minutes)
    this.localActive = (now - this.lastLocalPromptTime) < ACTIVE_WINDOW_MS;
    this.peerOnline = this.lastPeerSeen > 0 && (now - this.lastPeerSeen) < PEER_ONLINE_MS;
    this.peerActive = this.peerOnline && this.peerReportedActive && (now - this.lastPeerSeen) < PEER_ACTIVE_STALE_MS;

    // Clean up expired reservation (both machines expire it on their own; setAt is kept)
    if (this.reservation.until && now > this.reservation.until) {
      this.reservation = { holder: null, until: null, setAt: this.reservation.setAt || 0 };
    }

    // The server only knows the account total. Split it only when the peer reports its usage for the
    // same window; claude.ai and unconnected devices can't be seen, so they end up inside that split.
    const officialPct = Math.min(Math.max(this.officialFiveHour.usedPercentage || 0, 0), 100);
    const mine = this._windowUsage(this._windowStart(now)).q;
    const peerQ = this.peerOnline && this.peerWindow && sameWindow(this.peerWindow.resetsAt, this.officialFiveHour.resetsAt) ? this.peerWindow.q : null;
    if (officialPct > 0 && peerQ !== null && mine + peerQ > 0) {
      this.localSharePct = Math.round(mine / (mine + peerQ) * 100);
      this.peerSharePct = 100 - this.localSharePct;
      this.localQuotaPct = Math.round(officialPct * mine / (mine + peerQ));
      this.peerQuotaPct = officialPct - this.localQuotaPct;
    } else {
      this.localSharePct = null;
      this.peerSharePct = null;
      this.localQuotaPct = null;
      this.peerQuotaPct = null;
    }
    this.unattributedQuotaPct = null;
  }

  reservePriority(userName, durationMinutes = 20) {
    const now = Date.now();
    this.reservation = {
      holder: userName,
      until: now + (durationMinutes * 60 * 1000),
      setAt: now
    };
    return this.reservation;
  }

  takeTheWheel(userName, durationMinutes = 20) {
    return this.reservePriority(userName, durationMinutes);
  }

  releasePriority() {
    this.reservation = { holder: null, until: null, setAt: Date.now() };
    return this.reservation;
  }

  releaseTheWheel() {
    return this.releasePriority();
  }

  getStateSummary() {
    this.recalculateSplit();
    const isCollision = this.localActive && this.peerActive;
    // Only a reading whose window has not rolled over yet counts. After resetsAt the old
    // percentage is meaningless, so the UI shows "no reading yet" until a new one arrives.
    const hasOfficialReading = Boolean(this.officialFiveHour.source && this.officialFiveHour.resetsAt && this.officialFiveHour.resetsAt * 1000 > Date.now());
    const hasReading = hasOfficialReading;
    const isEstimated = false;
    const fiveHourUsedPct = this.officialFiveHour.usedPercentage;
    const fiveHourResetsAt = this.officialFiveHour.resetsAt;
    const fiveHourSource = hasOfficialReading ? this.officialFiveHour.source : null;

    const latestTurn = this.localTurns.length > 0 ? this.localTurns[this.localTurns.length - 1] : null;
    const localModel = latestTurn ? formatModelName(latestTurn.model) : null;
    const now = Date.now();
    const facts = this._facts(now);
    const usage = this._windowUsage(this._windowStart(now));
    const thirtyDaysAgo = now - 30 * DAY_MS;
    const thirtyDaysAgoStr = new Date(thirtyDaysAgo).toISOString().slice(0, 10);
    const peerDailyFromDb = (this.db && this.peerUserName) ? this.db.peerDailyUsage(this.peerUserName, thirtyDaysAgoStr) : [];
    const peerDailyList = peerDailyFromDb.length > 0 ? peerDailyFromDb : (this.peerDaily || []);

    return {
      fiveHourUsedPct,
      fiveHourResetsAt,
      fiveHourUpdatedAt: isEstimated ? (this.lastLocalPromptTime || Date.now()) : this.officialFiveHour.lastUpdated,
      fiveHourHasReading: hasReading,
      fiveHourIsEstimated: isEstimated,
      fiveHourSource,
      sevenDayUsedPct: this.officialSevenDay.usedPercentage,
      fiveHourPace: hasReading ? this._pace(now) : null,
      canSplit: this.localQuotaPct !== null,
      reconciliation: {
        officialPct: fiveHourUsedPct,
        youPct: this.localQuotaPct,
        peerPct: this.peerQuotaPct,
        unattributedPct: this.unattributedQuotaPct,
        hasReading,
        isEstimated
      },
      local: {
        name: this.localUserName,
        active: this.localActive,
        sharePct: this.localSharePct,
        quotaPct: this.localQuotaPct,
        rollingQ: Math.round(this.localRollingQ),
        tokens5h: usage.tokens,
        window: { resetsAt: this.officialFiveHour.resetsAt, q: Math.round(usage.q), tokens: usage.tokens },
        model: localModel,
        effort: latestTurn ? latestTurn.effort : null,
        thinking: latestTurn ? latestTurn.thinking : null,
        severity: null,
        lastActiveTime: this.lastLocalPromptTime || null,
        lastPromptTime: this.lastLocalPromptTime || null
      },
      window: facts.window,
      sessions: facts.sessions,
      byModel: facts.byModel,
      periods: facts.periods,
      heatmap: {
        local: {
          daily: this.db ? this.db.dailyUsage(thirtyDaysAgo, now) : [],
          hourly: this.db ? this.db.hourlyUsage(now - 24 * 3600 * 1000, now) : []
        },
        peer: {
          daily: peerDailyList,
          hourly: this.peerHourly || []
        }
      },
      peer: {
        name: this.peerUserName,
        active: this.peerActive,
        online: this.peerOnline,
        sharePct: this.peerSharePct,
        quotaPct: this.peerQuotaPct,
        rollingQ: Math.round(this.peerRollingQ),
        tokens5h: this.peerWindow ? this.peerWindow.tokens : null,
        model: this.peerModel || null,
        severity: null,
        lastActiveTime: this.lastPeerPromptTime || null,
        lastPromptTime: this.lastPeerPromptTime || null
      },
      unattributedQuotaPct: this.unattributedQuotaPct,
      isCollision,
      reservation: { ...this.reservation }
    };
  }
}

module.exports = {
  QuotaEngine,
  computeTurnQuota
};
