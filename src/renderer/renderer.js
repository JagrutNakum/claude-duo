const { ipcRenderer } = require('electron');

let currentState = null;
let currentSettings = null;

const LOCK_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const TIMER_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
const EYE_OPEN_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>`;

function formatCountdown(epochSeconds) {
  if (!epochSeconds) return 'Resets in --';
  const diffSec = Math.floor(epochSeconds - (Date.now() / 1000));
  if (diffSec <= 0) return 'Resetting now';
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  if (hours > 0) return `Resets in ${hours}h ${minutes}m`;
  return `Resets in ${minutes}m`;
}

function formatUpdated(ts) {
  if (!ts) return 'Waiting for update';
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return 'Updated just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `Updated ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `Updated ${hours}h ago`;
}

function formatActivity(ts, isActive, isOnline) {
  if (isOnline === false) return 'Waiting for connection';
  if (isActive) return 'Active now';
  if (!ts) return 'No activity in 5h';
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return 'Active just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `Active ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `Active ${hours}h ago`;
}

function formatTokens(t) {
  if (t == null) return '—';
  if (t === 0) return '0 tok';
  if (t >= 1000000) {
    return `${(t / 1000000).toFixed(1)}M tok`;
  } else if (t >= 1000) {
    return `${Math.round(t / 1000)}k tok`;
  }
  return `${t} tok`;
}

function formatTokenLoad(tokens5h, model, effort) {
  if (tokens5h == null) return '—';
  const tokStr = formatTokens(tokens5h);
  const parts = [tokStr];
  if (model) parts.push(model);
  if (effort) parts.push(effort);
  return parts.join(' · ');
}

function renderSessions(sessions) {
  const panel = document.getElementById('sessions-panel');
  const listEl = document.getElementById('sessions-list');
  if (!panel || !listEl) return;

  if (!sessions || sessions.length === 0) {
    panel.style.display = 'none';
    listEl.innerHTML = '';
    return;
  }

  panel.style.display = 'flex';
  listEl.innerHTML = '';
  const rows = sessions.slice(0, 5);
  for (const s of rows) {
    const row = document.createElement('div');
    row.className = 'session-row';

    const titleEl = document.createElement('span');
    titleEl.className = 'session-title';
    titleEl.textContent = s.title || 'Untitled session';
    titleEl.title = titleEl.textContent;
    row.appendChild(titleEl);

    const parts = [];
    if (s.model) parts.push(s.model);
    if (s.effort) parts.push(s.effort);
    if (parts.length > 0) {
      const subEl = document.createElement('span');
      subEl.className = 'session-sub';
      subEl.textContent = parts.join(' · ');
      row.appendChild(subEl);
    }

    const tokensEl = document.createElement('span');
    tokensEl.className = 'session-tokens';
    const totalTok = s.tokens != null ? s.tokens : ((s.input || 0) + (s.output || 0) + (s.cacheWrite || 0));
    tokensEl.textContent = formatTokens(totalTok);
    row.appendChild(tokensEl);

    const pctEl = document.createElement('span');
    pctEl.className = 'session-pct';
    pctEl.textContent = s.costSharePct != null ? `${Number(s.costSharePct).toFixed(1)}% of this PC` : '—';
    row.appendChild(pctEl);

    listEl.appendChild(row);
  }
}

function updateUI(state) {
  if (!state) return;
  currentState = state;

  const hasReading = Boolean(state.fiveHourHasReading);
  const numEl = document.getElementById('quota-number');
  const fillNeutral = document.getElementById('quota-fill-neutral');
  const fillYou = document.getElementById('quota-fill-you');
  const fillPeer = document.getElementById('quota-fill-peer');
  const fillLegacy = document.getElementById('quota-fill');
  const relayStatus = document.getElementById('relay-status');
  const breakdownSplit = document.getElementById('breakdown-split');
  const breakdownUnsplit = document.getElementById('breakdown-unsplit');
  const breakdownUnsplitLabel = document.getElementById('breakdown-unsplit-label');
  const breakdownYou = document.getElementById('breakdown-you-label');
  const breakdownPeer = document.getElementById('breakdown-peer-label');
  const paceBadge = document.getElementById('pace-badge');
  const paceLabel = document.getElementById('pace-label');

  // 1. Quota Number & Split / Neutral Fills
  if (!hasReading) {
    numEl.innerText = '—';
    numEl.className = 'hero-number';
    if (fillNeutral) fillNeutral.style.width = '0%';
    if (fillYou) fillYou.style.width = '0%';
    if (fillPeer) fillPeer.style.width = '0%';
    if (fillLegacy) fillLegacy.style.width = '0%';
    if (breakdownSplit) breakdownSplit.style.display = 'none';
    if (breakdownUnsplit) {
      breakdownUnsplit.style.display = 'flex';
      if (breakdownUnsplitLabel) breakdownUnsplitLabel.innerText = 'Account total · split starts when teammate connects';
    }
    if (paceBadge) paceBadge.style.display = 'none';
    if (relayStatus) {
      relayStatus.innerText = 'No reading yet. Run claude in a terminal on either PC to start the meter.';
    }
  } else {
    const pct = Math.min(Math.max(state.fiveHourUsedPct || 0, 0), 100);
    if (state.fiveHourIsEstimated) {
      numEl.innerText = `~${pct}%`;
    } else {
      numEl.innerText = `${pct}%`;
    }
    if (pct >= 85) numEl.className = 'hero-number critical';
    else numEl.className = 'hero-number';

    if (fillLegacy) {
      fillLegacy.style.display = 'none';
      fillLegacy.style.width = '0%';
    }

    const peerName = state.peer?.name || 'teammate';
    const canSplit = Boolean(state.canSplit);

    if (!canSplit) {
      if (fillNeutral) fillNeutral.style.width = `${pct}%`;
      if (fillYou) fillYou.style.width = '0%';
      if (fillPeer) fillPeer.style.width = '0%';
      if (breakdownSplit) breakdownSplit.style.display = 'none';
      if (breakdownUnsplit) {
        breakdownUnsplit.style.display = 'flex';
        if (breakdownUnsplitLabel) {
          breakdownUnsplitLabel.innerText = `Account total · split starts when ${peerName} connects`;
        }
      }
    } else {
      if (fillNeutral) fillNeutral.style.width = '0%';
      const rec = state.reconciliation || {};
      const youPct = state.local?.quotaPct != null ? state.local.quotaPct : (rec.youPct || 0);
      const peerPct = state.peer?.quotaPct != null ? state.peer.quotaPct : (rec.peerPct || 0);

      if (fillYou) fillYou.style.width = `${youPct}%`;
      if (fillPeer) fillPeer.style.width = `${peerPct}%`;
      if (breakdownUnsplit) breakdownUnsplit.style.display = 'none';
      if (breakdownSplit) {
        breakdownSplit.style.display = 'flex';
        if (breakdownYou) breakdownYou.innerText = `You: ${youPct}%`;
        if (breakdownPeer) breakdownPeer.innerText = `${peerName}: ${peerPct}%`;
      }
    }

    if (paceBadge && paceLabel) {
      const pace = state.fiveHourPace;
      if (pace && pace.pct != null && pace.minutes) {
        paceBadge.style.display = 'inline-flex';
        paceLabel.innerText = `+${pace.pct}% in last ${pace.minutes}m`;
      } else {
        paceBadge.style.display = 'none';
      }
    }

    if (relayStatus) {
      if (state.fiveHourIsEstimated) {
        relayStatus.innerText = 'Estimated from local transcript · Run claude in terminal to lock to official %';
      } else if (state.fiveHourSource === 'peer') {
        relayStatus.innerText = `${formatUpdated(state.fiveHourUpdatedAt)} via ${peerName}`;
      } else {
        relayStatus.innerText = formatUpdated(state.fiveHourUpdatedAt);
      }
    }
  }

  const needsSignIn = Boolean(state.usageApi && state.usageApi.needsSignIn);
  const signinBtn = document.getElementById('usage-signin');
  if (signinBtn) signinBtn.style.display = needsSignIn ? '' : 'none';
  if (relayStatus && needsSignIn) relayStatus.innerText += ' · Live usage paused';

  // Countdown & Clock
  document.getElementById('reset-countdown').innerText = formatCountdown(state.fiveHourResetsAt);
  if (state.fiveHourResetsAt) {
    const d = new Date(state.fiveHourResetsAt * 1000);
    document.getElementById('reset-clock').innerText = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else {
    document.getElementById('reset-clock').innerText = '--:--';
  }

  // Dynamic updated line & weekly allowance vs Concurrency Warning
  const collisionAlert = document.getElementById('collision-alert');
  if (state.isCollision) {
    if (relayStatus) relayStatus.style.display = 'none';
    if (collisionAlert) collisionAlert.classList.add('active');
  } else {
    if (relayStatus) relayStatus.style.display = '';
    if (collisionAlert) collisionAlert.classList.remove('active');
  }
  // Weekly allowance
  if (!hasReading) {
    document.getElementById('weekly-ceiling').innerText = 'Weekly allowance: —';
  } else if (state.fiveHourIsEstimated && !state.sevenDayUsedPct) {
    document.getElementById('weekly-ceiling').innerText = 'Weekly allowance: Syncs via terminal';
  } else {
    const weeklyPct = Math.round(state.sevenDayUsedPct || 0);
    document.getElementById('weekly-ceiling').innerText = `Weekly allowance: ${weeklyPct}%`;
  }

  // Header Relay Status & Dot
  const headerLabels = {
    connecting: 'Connecting…',
    connected: 'Sync live',
    offline: 'Offline',
    'rate-limited': 'Rate-limited'
  };

  const statusKey = state.relayStatus || 'connecting';
  const relayTopicEl = document.getElementById('relay-topic');
  const relayDot = document.getElementById('relay-dot');
  const relayBadge = document.getElementById('relay-badge');
  const peerName = state.peer?.name || 'Teammate';

  if (statusKey === 'connected') {
    if (state.peer && state.peer.online) {
      relayTopicEl.innerText = 'Sync live';
      relayDot.className = 'dot connected';
      if (relayBadge) relayBadge.className = 'status-badge connected';
    } else {
      relayTopicEl.innerText = `Sync live · ${peerName} offline`;
      relayDot.className = 'dot peer-offline';
      if (relayBadge) relayBadge.className = 'status-badge peer-offline';
    }
  } else {
    relayTopicEl.innerText = headerLabels[statusKey] || headerLabels.connecting;
    relayDot.className = `dot ${statusKey}`;
    if (relayBadge) relayBadge.className = `status-badge ${statusKey}`;
  }

  // 3. Local Card (Signature presence dot, prose out of mono)
  document.getElementById('local-name').innerText = state.local?.name || 'You';
  const localShareEl = document.getElementById('local-share');
  if (state.canSplit && state.local?.quotaPct != null) {
    const shareText = state.local.sharePct !== null ? ` (${state.local.sharePct}% share)` : '';
    localShareEl.innerText = `${state.local.quotaPct}% of limit${shareText}`;
  } else {
    localShareEl.innerText = 'Not split';
  }
  const localTokensEl = document.getElementById('local-tokens');
  if (localTokensEl) {
    localTokensEl.innerText = formatTokenLoad(
      state.local?.tokens5h != null ? state.local.tokens5h : null,
      state.local?.model,
      state.local?.effort
    );
  }

  const localDot = document.getElementById('local-dot');
  const localStatus = document.getElementById('local-status');
  if (state.local?.active) {
    localDot.className = 'dot connected';
    localStatus.innerText = 'Active now';
  } else {
    localDot.className = 'dot offline';
    localStatus.innerText = 'Idle';
  }
  document.getElementById('local-activity').innerText = formatActivity(state.local?.lastActiveTime || state.local?.lastPromptTime, state.local?.active, true);

  // 4. Peer Card (Signature presence dot, prose out of mono)
  document.getElementById('peer-name').innerText = state.peer?.name || 'Teammate';
  const peerShareEl = document.getElementById('peer-share');
  if (!state.peer?.online) {
    peerShareEl.innerText = 'Waiting for peer';
  } else if (state.canSplit && state.peer?.quotaPct != null) {
    const shareText = state.peer.sharePct !== null ? ` (${state.peer.sharePct}% share)` : '';
    peerShareEl.innerText = `${state.peer.quotaPct}% of limit${shareText}`;
  } else {
    peerShareEl.innerText = 'Not split';
  }
  const peerTokensEl = document.getElementById('peer-tokens');
  if (peerTokensEl) {
    peerTokensEl.innerText = state.peer?.online
      ? formatTokenLoad(state.peer.tokens5h, state.peer.model, state.peer.effort)
      : 'Waiting for connection';
  }

  const peerDot = document.getElementById('peer-dot');
  const peerStatus = document.getElementById('peer-status');
  if (!state.peer.online) {
    peerDot.className = 'dot offline';
    peerStatus.innerText = 'Offline';
  } else if (state.peer.active) {
    peerDot.className = 'dot connected';
    peerStatus.innerText = 'Active now';
  } else {
    peerDot.className = 'dot offline';
    peerStatus.innerText = 'Idle';
  }
  document.getElementById('peer-activity').innerText = formatActivity(state.peer?.lastActiveTime || state.peer?.lastPromptTime, state.peer?.active, state.peer?.online);

  // 5. Priority Button
  const btn = document.getElementById('priority-btn');
  const icon = document.getElementById('priority-icon');
  const text = document.getElementById('priority-text');
  const res = state.reservation || {};
  const focusMins = currentSettings?.focus?.minutes || 20;

  if (res.holder === state.local.name && res.until > Date.now()) {
    const minsLeft = Math.max(1, Math.round((res.until - Date.now()) / 60000));
    btn.className = 'btn btn-priority active';
    icon.innerHTML = TIMER_ICON;
    text.innerText = `Release focus (${minsLeft}m left)`;
  } else if (res.holder && res.until > Date.now()) {
    const minsLeft = Math.max(1, Math.round((res.until - Date.now()) / 60000));
    btn.className = 'btn btn-priority';
    icon.innerHTML = TIMER_ICON;
    text.innerText = `${res.holder} requested focus (${minsLeft}m)`;
  } else {
    btn.className = 'btn btn-priority';
    icon.innerHTML = TIMER_ICON;
    text.innerText = `Request ${focusMins}m focus`;
  }

  // 6. Active sessions breakdown list
  renderSessions(state.sessions);

  // 7. Refresh Usage view if currently open
  const usageView = document.getElementById('usage-view');
  if (usageView && usageView.style.display !== 'none') {
    renderUsageDetails(state);
  }
}

async function sendPing() {
  const input = document.getElementById('ping-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  await ipcRenderer.invoke('send_ping', msg);
}

async function togglePriority() {
  if (!currentState) return;
  const res = currentState.reservation || {};

  if (res.holder === currentState.local.name && res.until > Date.now()) {
    const newState = await ipcRenderer.invoke('release_priority');
    updateUI(newState);
  } else if (!res.holder || res.until <= Date.now()) {
    const newState = await ipcRenderer.invoke('take_priority');
    updateUI(newState);
  }
}

// ---- Usage Details Navigation & Rendering ----

function openUsage() {
  const dash = document.getElementById('dashboard-view');
  const setts = document.getElementById('settings-view');
  const usage = document.getElementById('usage-view');
  if (dash) dash.style.display = 'none';
  if (setts) setts.style.display = 'none';
  if (usage) usage.style.display = 'flex';
  if (currentState) {
    renderUsageDetails(currentState);
  }
}

function closeUsage() {
  const usage = document.getElementById('usage-view');
  const dash = document.getElementById('dashboard-view');
  if (usage) usage.style.display = 'none';
  if (dash) dash.style.display = 'flex';
}

function renderUsageDetails(state) {
  if (!state) return;

  // 1. Window Totals
  const winGrid = document.getElementById('usage-window-grid');
  if (winGrid) {
    winGrid.replaceChildren();
    const w = state.window || {};
    const winMetrics = [
      { label: 'Turns', val: String(w.turns || 0) },
      { label: 'Input', val: formatTokens(w.input || 0) },
      {
        label: 'Output',
        val: formatTokens(w.output || 0),
        sub: w.thinking ? `incl. ${formatTokens(w.thinking)} thinking` : null
      },
      { label: 'Cache Writes', val: formatTokens(w.cacheWrite || 0) },
      { label: 'Cache Reads', val: formatTokens(w.cacheRead || 0) }
    ];

    for (const m of winMetrics) {
      const card = document.createElement('div');
      card.className = 'usage-metric-card';

      const lbl = document.createElement('div');
      lbl.className = 'usage-metric-label';
      lbl.textContent = m.label;
      card.appendChild(lbl);

      const val = document.createElement('div');
      val.className = 'usage-metric-val';
      val.textContent = m.val;
      card.appendChild(val);

      if (m.sub) {
        const sub = document.createElement('div');
        sub.className = 'usage-metric-sub';
        sub.textContent = m.sub;
        card.appendChild(sub);
      }

      winGrid.appendChild(card);
    }
  }

  // 2. Sessions
  const sessionsList = document.getElementById('usage-sessions-list');
  if (sessionsList) {
    sessionsList.replaceChildren();
    const sessions = state.sessions || [];
    if (sessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'usage-empty-note';
      empty.textContent = 'No sessions recorded in this 5-hour window.';
      sessionsList.appendChild(empty);
    } else {
      for (const s of sessions) {
        const row = document.createElement('div');
        row.className = 'usage-table-row';

        // Title & Project
        const colTitle = document.createElement('div');
        colTitle.className = 'col-title session-title-wrap';

        const nameEl = document.createElement('span');
        nameEl.className = 'session-name';
        nameEl.textContent = s.title || 'Untitled session';
        nameEl.title = nameEl.textContent;
        colTitle.appendChild(nameEl);

        if (s.project) {
          const projEl = document.createElement('span');
          projEl.className = 'session-project';
          projEl.textContent = s.project;
          projEl.title = s.project;
          colTitle.appendChild(projEl);
        }
        row.appendChild(colTitle);

        // Model · Effort · Thinking
        const colModel = document.createElement('div');
        colModel.className = 'col-model';
        const modelParts = [];
        if (s.model) modelParts.push(s.model);
        if (s.effort) modelParts.push(s.effort);
        if (s.thinking) modelParts.push(s.thinking === 'adaptive' ? 'adaptive' : 'thinking');
        colModel.textContent = modelParts.length > 0 ? modelParts.join(' · ') : '—';
        colModel.title = colModel.textContent;
        row.appendChild(colModel);

        // Output tokens
        const colOut = document.createElement('div');
        colOut.className = 'col-output';
        colOut.textContent = formatTokens(s.output != null ? s.output : 0);
        row.appendChild(colOut);

        // Cache reads
        const colCache = document.createElement('div');
        colCache.className = 'col-cache';
        colCache.textContent = formatTokens(s.cacheRead != null ? s.cacheRead : 0);
        row.appendChild(colCache);

        // Cost share
        const colCost = document.createElement('div');
        colCost.className = 'col-cost';
        colCost.textContent = s.costSharePct != null ? `${Number(s.costSharePct).toFixed(1)}% of this PC` : '—';
        row.appendChild(colCost);

        sessionsList.appendChild(row);
      }
    }
  }

  // 3. By Model
  const modelsList = document.getElementById('usage-models-list');
  if (modelsList) {
    modelsList.replaceChildren();
    const byModel = state.byModel || [];
    if (byModel.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'usage-empty-note';
      empty.textContent = 'No model activity recorded in this window.';
      modelsList.appendChild(empty);
    } else {
      for (const m of byModel) {
        const row = document.createElement('div');
        row.className = 'usage-table-row';

        const nameEl = document.createElement('div');
        nameEl.className = 'col-model-name';
        nameEl.textContent = m.model || 'Unknown';
        row.appendChild(nameEl);

        const turnsEl = document.createElement('div');
        turnsEl.className = 'col-model-turns';
        turnsEl.textContent = String(m.turns || 0);
        row.appendChild(turnsEl);

        const inEl = document.createElement('div');
        inEl.className = 'col-model-in';
        inEl.textContent = formatTokens(m.input || 0);
        row.appendChild(inEl);

        const outEl = document.createElement('div');
        outEl.className = 'col-model-out';
        let outText = formatTokens(m.output || 0);
        if (m.thinking) {
          outText += ` (${formatTokens(m.thinking)})`;
        }
        outEl.textContent = outText;
        row.appendChild(outEl);

        const cwEl = document.createElement('div');
        cwEl.className = 'col-model-cw';
        cwEl.textContent = formatTokens(m.cacheWrite || 0);
        row.appendChild(cwEl);

        const crEl = document.createElement('div');
        crEl.className = 'col-model-cr';
        crEl.textContent = formatTokens(m.cacheRead || 0);
        row.appendChild(crEl);

        modelsList.appendChild(row);
      }
    }
  }

  // 4. Totals by Period (today, last7d, allTime)
  const periodsGrid = document.getElementById('usage-periods-grid');
  if (periodsGrid) {
    periodsGrid.replaceChildren();
    const p = state.periods || {};
    const periodDefs = [
      { key: 'today', title: 'Today' },
      { key: 'last7d', title: 'Last 7 Days' },
      { key: 'allTime', title: 'All Time' }
    ];

    for (const def of periodDefs) {
      const data = p[def.key] || {};
      const card = document.createElement('div');
      card.className = 'period-card';

      const hdr = document.createElement('div');
      hdr.className = 'period-header';
      hdr.textContent = def.title;
      card.appendChild(hdr);

      const stats = [
        { key: 'Turns', val: String(data.turns || 0) },
        { key: 'Output', val: formatTokens(data.output || 0) },
        { key: 'Cache Writes', val: formatTokens(data.cacheWrite || 0) },
        { key: 'Cache Reads', val: formatTokens(data.cacheRead || 0) }
      ];

      for (const st of stats) {
        const row = document.createElement('div');
        row.className = 'period-stat';

        const k = document.createElement('span');
        k.className = 'period-stat-key';
        k.textContent = st.key;
        row.appendChild(k);

        const v = document.createElement('span');
        v.className = 'period-stat-val';
        v.textContent = st.val;
        row.appendChild(v);

        card.appendChild(row);
      }

      periodsGrid.appendChild(card);
    }
  }
}

// ---- Settings Navigation & Logic ----

function openSettings(tab = 'general') {
  document.getElementById('dashboard-view').style.display = 'none';
  const usageView = document.getElementById('usage-view');
  if (usageView) usageView.style.display = 'none';
  document.getElementById('settings-view').style.display = 'flex';
  switchSettingsTab(tab);
  loadSettings();
}

function closeSettings() {
  document.getElementById('settings-view').style.display = 'none';
  document.getElementById('dashboard-view').style.display = 'flex';
}

function switchSettingsTab(tabName) {
  document.querySelectorAll('.sidebar-tab').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
  });
  document.querySelectorAll('.settings-pane').forEach(pane => {
    pane.style.display = pane.id === `pane-${tabName}` ? 'flex' : 'none';
  });
}

function renderSettings(settings) {
  if (!settings) return;
  currentSettings = settings;

  // General
  const g = settings.general || {};
  document.getElementById('set-gen-closeToTray').checked = Boolean(g.closeToTray);
  const winAuto = document.getElementById('set-gen-startWithWindows');
  winAuto.checked = Boolean(g.startWithWindows);
  winAuto.disabled = !g.startWithWindowsAvailable;
  const hintWin = document.getElementById('hint-startWithWindows');
  if (hintWin) {
    hintWin.innerText = g.startWithWindowsAvailable
      ? 'Launch automatically when Windows starts.'
      : 'Only in the installed app';
  }
  document.getElementById('set-gen-startHidden').checked = Boolean(g.startHidden);
  document.getElementById('set-gen-alwaysOnTop').checked = Boolean(g.alwaysOnTop);

  // Notifications
  const n = settings.notifications || {};
  document.getElementById('set-notif-quotaAlert').checked = Boolean(n.quotaAlert);
  document.getElementById('set-notif-quotaAlertPct').value = n.quotaAlertPct || 85;
  document.getElementById('set-notif-limitReset').checked = Boolean(n.limitReset);
  document.getElementById('set-notif-ping').checked = Boolean(n.ping);
  document.getElementById('set-notif-focus').checked = Boolean(n.focus);
  document.getElementById('set-notif-sound').checked = Boolean(n.sound);

  // Focus
  const f = settings.focus || {};
  const currentMins = f.minutes || 20;
  document.querySelectorAll('#focus-segmented .segment-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.getAttribute('data-minutes')) === currentMins);
  });

  // Update dashboard priority button label if idle
  if (currentState) updateUI(currentState);

  // Connection
  const c = settings.connection || {};
  document.getElementById('conn-userName').value = c.userName || '';
  document.getElementById('conn-peerName').value = c.peerName || '';
  document.getElementById('conn-topic').value = c.topic || '';
  document.getElementById('conn-server').value = c.server || '';
  document.getElementById('conn-passphrase').value = '';

  const badge = document.getElementById('passphrase-status-badge');
  const warn = document.getElementById('passphrase-warning');
  if (c.passphraseSet) {
    badge.innerText = 'Set';
    badge.className = 'badge set';
    warn.style.display = 'none';
  } else {
    badge.innerText = 'Not set, using public default';
    badge.className = 'badge warning';
    warn.style.display = 'flex';
  }

  // Info
  const inf = settings.info || {};
  document.getElementById('info-account').innerText = inf.claudeAccount || 'Not detected';
  document.getElementById('info-config-path').innerText = inf.configPath || '-';
  document.getElementById('info-version').innerText = `Claude-Duo v${inf.appVersion || '1.0.0'}`;
  document.getElementById('info-relay').innerText = inf.relayStatus || '-';

  const quotaSrc = document.getElementById('info-quota-source');
  if (inf.fiveHourHasReading) {
    const src = { peer: 'peer', cache: 'Claude Code usage cache', api: 'live usage' }[inf.fiveHourSource] || 'local status line';
    quotaSrc.innerText = `Active (${src}, ${formatUpdated(inf.fiveHourUpdatedAt)})`;
  } else {
    quotaSrc.innerText = 'No reading yet (waiting for claude terminal CLI)';
  }

  const hookWarn = document.getElementById('hook-warning');
  if (hookWarn) {
    hookWarn.style.display = inf.statusLineHookInstalled === false ? 'flex' : 'none';
  }
}

async function loadSettings() {
  try {
    const s = await ipcRenderer.invoke('get_settings');
    renderSettings(s);
  } catch (e) {}
}

async function saveGeneralField(key, val) {
  try {
    await ipcRenderer.invoke('save_settings', { general: { [key]: val } });
  } catch (e) {}
}

async function saveNotifField(key, val) {
  try {
    await ipcRenderer.invoke('save_settings', { notifications: { [key]: val } });
  } catch (e) {}
}

async function saveNotifAlertPct(val) {
  const num = parseInt(val, 10);
  const errEl = document.getElementById('err-quotaAlertPct');
  if (errEl) errEl.innerText = '';
  if (isNaN(num)) return;
  const res = await ipcRenderer.invoke('save_settings', { notifications: { quotaAlertPct: num } });
  if (!res.ok && res.errors?.quotaAlertPct) {
    if (errEl) errEl.innerText = res.errors.quotaAlertPct;
  }
}

async function saveFocusMinutes(mins) {
  document.querySelectorAll('#focus-segmented .segment-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.getAttribute('data-minutes')) === mins);
  });
  if (currentSettings?.focus) currentSettings.focus.minutes = mins;
  if (currentState) updateUI(currentState);
  try {
    await ipcRenderer.invoke('save_settings', { focus: { minutes: mins } });
  } catch (e) {}
}

async function saveConnection() {
  const errFields = ['userName', 'peerName', 'topic', 'server', 'passphrase', '_form'];
  errFields.forEach(f => {
    const el = document.getElementById(`err-${f}`);
    if (el) el.innerText = '';
  });

  const userName = document.getElementById('conn-userName').value.trim();
  const peerName = document.getElementById('conn-peerName').value.trim();
  const topic = document.getElementById('conn-topic').value.trim();
  const server = document.getElementById('conn-server').value.trim();
  const passphrase = document.getElementById('conn-passphrase').value;

  const patch = {
    connection: { userName, peerName, topic, server }
  };
  if (passphrase && passphrase.length > 0) {
    patch.connection.passphrase = passphrase;
  }

  const res = await ipcRenderer.invoke('save_settings', patch);
  if (!res.ok) {
    if (res.errors) {
      Object.entries(res.errors).forEach(([k, msg]) => {
        const el = document.getElementById(`err-${k}`);
        if (el) el.innerText = msg;
      });
    }
  } else {
    const passInput = document.getElementById('conn-passphrase');
    if (passInput) {
      passInput.value = '';
      passInput.type = 'password';
      const eyeIcon = document.getElementById('pass-eye-icon');
      if (eyeIcon) eyeIcon.innerHTML = EYE_OPEN_ICON;
    }
    renderSettings(res.settings);
    const btnSpan = document.querySelector('#save-conn-btn span');
    if (btnSpan) {
      const orig = btnSpan.innerText;
      btnSpan.innerText = 'Saved';
      setTimeout(() => { btnSpan.innerText = orig; }, 1500);
    }
  }
}

function togglePassphraseVisibility() {
  const input = document.getElementById('conn-passphrase');
  const iconSpan = document.getElementById('pass-eye-icon');
  if (!input || !iconSpan) return;
  if (input.type === 'password') {
    input.type = 'text';
    iconSpan.innerHTML = EYE_OFF_ICON;
  } else {
    input.type = 'password';
    iconSpan.innerHTML = EYE_OPEN_ICON;
  }
}

async function testConnection() {
  const resEl = document.getElementById('test-conn-result');
  if (!resEl) return;
  resEl.innerText = 'Testing…';
  resEl.className = 'test-result';

  const server = document.getElementById('conn-server').value.trim();
  try {
    const res = await ipcRenderer.invoke('test_connection', server);
    if (res.ok) {
      resEl.innerText = `OK (${res.ms}ms)`;
      resEl.className = 'test-result ok';
    } else {
      resEl.innerText = `Failed: ${res.error || 'Connection error'}`;
      resEl.className = 'test-result error';
    }
  } catch (e) {
    resEl.innerText = 'Test failed';
    resEl.className = 'test-result error';
  }
}

async function revealConfig() {
  try {
    await ipcRenderer.invoke('reveal_config');
  } catch (e) {}
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const settingsView = document.getElementById('settings-view');
    if (settingsView && settingsView.style.display !== 'none') {
      closeSettings();
      return;
    }
    const usageView = document.getElementById('usage-view');
    if (usageView && usageView.style.display !== 'none') {
      closeUsage();
      return;
    }
  }
});

ipcRenderer.on('open_settings', () => {
  openSettings();
});

ipcRenderer.on('settings_updated', (e, settings) => {
  renderSettings(settings);
});

ipcRenderer.on('state_updated', (e, state) => {
  updateUI(state);
});

ipcRenderer.on('update_status', (e, status) => {
  const updateBtn = document.getElementById('update-btn');
  if (!updateBtn) return;
  if (status.state === 'ready') {
    updateBtn.style.display = 'inline-flex';
    updateBtn.textContent = `Restart to update (v${status.version || ''})`;
    updateBtn.disabled = false;
  } else if (status.state === 'downloading') {
    updateBtn.style.display = 'inline-flex';
    updateBtn.textContent = status.percent ? `Downloading update (${status.percent}%)` : 'Downloading update…';
    updateBtn.disabled = true;
  } else {
    updateBtn.style.display = 'none';
  }
});

async function installUpdate() {
  await ipcRenderer.invoke('install_update');
}

document.getElementById('usage-signin')?.addEventListener('click', () => {
  ipcRenderer.invoke('open_claude_signin');
});

// Initial load
ipcRenderer.invoke('get_state').then(updateUI);
loadSettings();

// Refresh countdowns
setInterval(() => {
  if (currentState) updateUI(currentState);
}, 5000);
