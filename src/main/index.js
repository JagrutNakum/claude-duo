const { app, BrowserWindow, ipcMain, Tray, Menu, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { QuotaEngine } = require('./quota_engine');
const { RelayClient } = require('./relay_client');
const { NotificationManager } = require('./notifications');
const { StatuslineReceiver } = require('./statusline_receiver');
const { TranscriptWatcher } = require('./transcript_watcher');
const { UsageDb } = require('./usage_db');
const Settings = require('./settings');
const { fetchUsage, CREDENTIALS_PATH } = require('./usage_api');
const { initUpdater } = require('./updater');

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

// Launched by "Start with Windows" (--hidden) or with "Start hidden in tray" on: stay in the tray.
const launchedHidden = process.argv.includes('--hidden');
const LOGIN_ITEM = { path: process.execPath, args: ['--hidden'] };

function isAutoStartEnabled() {
  try {
    return app.getLoginItemSettings(LOGIN_ITEM).openAtLogin;
  } catch (e) {
    return false;
  }
}

function setAutoStart(enabled) {
  try {
    app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: enabled });
  } catch (e) {}
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.setAlwaysOnTop(cfg.app.always_on_top);
}

// Opening the shortcut while the app sits in the tray should bring the window back.
app.on('second-instance', () => showMainWindow());

// Windows AppUserModelID for stable, unthrottled notifications
app.setAppUserModelId('com.claudeduo.app');

// Settings come from ~/.claude-duo/config.json (see settings.js) and can be changed in the app.
let cfg = Settings.load();

let mainWindow = null;
let tray = null;
const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.ico');
const iconPng = path.join(__dirname, '..', '..', 'assets', 'icon.png');

let quotaEngine = new QuotaEngine(cfg.userName, cfg.peerName);
let notifier = new NotificationManager(cfg.app);
// Last ping this machine sent; it rides along in every published state and the peer dedupes by ts.
let lastSentPing = null;

let relayClient = new RelayClient({
  userName: cfg.userName,
  // Both machines must use the same passphrase. Without one in config.json the fallback keeps older
  // builds compatible, but it is public in this source code.
  passphrase: cfg.passphrase,
  topic: cfg.topic,
  relayUrl: cfg.server,
  deviceId: os.hostname(),
  stateProvider: () => peerView(quotaEngine.getStateSummary())
});

// Sessions, titles and history stay on this PC; the peer only gets numeric totals and heatmap activity.
function peerView(s) {
  const { sessions, byModel, periods, window, heatmap, ...rest } = s;
  return {
    ...rest,
    lastPing: lastSentPing,
    heatmap: heatmap && heatmap.local ? { daily: heatmap.local.daily, hourly: heatmap.local.hourly } : null
  };
}

let statuslineReceiver = null;
let transcriptWatcher = null;
let shownTrayHint = false;
let hookInstalled = false;

function settingsView() {
  const s = quotaEngine.getStateSummary();
  return {
    general: {
      closeToTray: cfg.app.close_to_tray,
      startHidden: cfg.app.start_hidden,
      alwaysOnTop: cfg.app.always_on_top,
      startWithWindows: app.isPackaged && isAutoStartEnabled(),
      startWithWindowsAvailable: app.isPackaged
    },
    notifications: {
      quotaAlert: cfg.app.notify_quota_alert,
      quotaAlertPct: cfg.app.quota_alert_pct,
      limitReset: cfg.app.notify_limit_reset,
      ping: cfg.app.notify_ping,
      focus: cfg.app.notify_focus,
      sound: cfg.app.notify_sound
    },
    focus: {
      minutes: cfg.app.focus_minutes,
      choices: Settings.FOCUS_CHOICES
    },
    connection: {
      userName: cfg.userName,
      peerName: cfg.peerName,
      topic: cfg.topic,
      server: cfg.server,
      passphraseSet: !cfg.passphraseIsDefault // the passphrase itself never leaves the main process
    },
    info: {
      claudeAccount: Settings.claudeAccount(),
      configPath: Settings.CONFIG_PATH,
      appVersion: app.getVersion(),
      relayStatus: relayClient.status,
      statusLineHookInstalled: hookInstalled,
      fiveHourHasReading: s.fiveHourHasReading,
      fiveHourSource: s.fiveHourSource,
      fiveHourUpdatedAt: s.fiveHourUpdatedAt
    }
  };
}

function applySettings(prev, next) {
  notifier.setPrefs(next.app);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(next.app.always_on_top);
  if (prev.userName !== next.userName || prev.peerName !== next.peerName) {
    quotaEngine.setNames(next.userName, next.peerName);
  }
  const channelChanged = relayClient.reconfigure({
    userName: next.userName,
    passphrase: next.passphrase,
    topic: next.topic,
    relayUrl: next.server
  });
  if (channelChanged) {
    quotaEngine.resetPeer();
    lastUrgentKey = null; // announce ourselves on the new channel
  }
  buildTrayMenu();
  broadcastState();
  checkPublish();
}

// Publish only when something the peer cares about changed (see relay_client.js for the budget).
let lastUrgentKey = null;
let lastNormalKey = null;

function checkPublish() {
  const s = quotaEngine.getStateSummary();
  const urgentKey = JSON.stringify([
    s.local.active,
    s.reservation.holder,
    s.reservation.until,
    lastSentPing ? lastSentPing.ts : 0,
    s.fiveHourHasReading && s.fiveHourUsedPct >= cfg.app.quota_alert_pct
  ]);
  const normalKey = JSON.stringify([
    s.fiveHourUsedPct,
    s.fiveHourResetsAt,
    s.sevenDayUsedPct,
    s.local.rollingQ
  ]);
  if (lastUrgentKey === null) {
    // First check after launch: announce ourselves.
    lastUrgentKey = urgentKey;
    lastNormalKey = normalKey;
    relayClient.requestPublish(true);
    return;
  }
  if (urgentKey !== lastUrgentKey) {
    lastUrgentKey = urgentKey;
    lastNormalKey = normalKey;
    relayClient.requestPublish(true);
  } else if (normalKey !== lastNormalKey) {
    lastNormalKey = normalKey;
    relayClient.requestPublish(false);
  }
}

function handleOfficialChange(prev) {
  const cur = quotaEngine.officialFiveHour;
  if (!quotaEngine.getStateSummary().fiveHourHasReading) return;
  notifier.checkQuotaThreshold(cur.usedPercentage, cur.resetsAt);
  // A new 5-hour window started: reset time moved forward and usage dropped.
  if (prev.resetsAt && cur.resetsAt && cur.resetsAt > prev.resetsAt + 60 && cur.usedPercentage < prev.usedPercentage) {
    notifier.notifyReset();
  }
}

function statusLineText() {
  const s = quotaEngine.getStateSummary();
  let peer = `${s.peer.name} offline`;
  if (s.peer.online) peer = `${s.peer.name} ${s.peer.active ? 'active' : 'idle'}`;
  const tok = s.local.tokens5h >= 1000 ? `${Math.round(s.local.tokens5h / 1000)}k` : String(s.local.tokens5h || 0);
  const shareText = s.local.quotaPct != null ? `you ${s.local.quotaPct}% · ${tok} tok` : `you ${tok} tok`;
  const parts = [s.fiveHourHasReading ? `Duo 5h ${s.fiveHourUsedPct}%` : 'Duo 5h --', shareText, peer];
  const r = s.reservation;
  if (r.holder && r.until > Date.now()) {
    parts.push(`focus: ${r.holder} ${Math.max(1, Math.round((r.until - Date.now()) / 60000))}m`);
  }
  if (s.isCollision) parts.push('both prompting');
  return parts.join(' | ');
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 780,
    height: 560,
    minWidth: 640,
    minHeight: 480,
    center: true,
    show: false,
    icon: fs.existsSync(iconPath) ? iconPath : iconPng,
    title: 'Claude-Duo',
    backgroundColor: '#161513',
    alwaysOnTop: cfg.app.always_on_top,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // No File / Edit / View / Window bar: everything lives in the app's own settings and the tray.
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const maybeShow = () => {
    if (!launchedHidden && !cfg.app.start_hidden && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  };
  mainWindow.once('ready-to-show', maybeShow);
  setTimeout(maybeShow, 800);
  mainWindow.on('show', refreshNow);
  mainWindow.on('focus', refreshNow);

  mainWindow.on('close', (event) => {
    if (!cfg.app.close_to_tray) {
      app.isQuitting = true; // "Close quits the app"
      return;
    }
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (!shownTrayHint) {
        shownTrayHint = true;
        notifier.showToast('Claude-Duo is still running', 'It keeps syncing from the system tray. Right-click the tray icon to quit.', false);
      }
    }
  });
}

function buildTrayMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Claude-Duo',
      click: () => showMainWindow()
    },
    {
      label: 'Settings...',
      click: () => {
        showMainWindow();
        if (mainWindow) mainWindow.webContents.send('open_settings');
      }
    },
    { type: 'separator' },
    {
      // Off by default. Only the packaged exe can register itself; `npm start` runs electron.exe.
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.isPackaged && isAutoStartEnabled(),
      enabled: app.isPackaged,
      click: (item) => {
        setAutoStart(item.checked);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings_updated', settingsView());
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
}

function createTray() {
  const chosenIcon = fs.existsSync(iconPath) ? iconPath : iconPng;
  try {
    tray = new Tray(chosenIcon);
    tray.setToolTip('Claude-Duo');
    buildTrayMenu();
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.focus();
        } else {
          mainWindow.show();
        }
      }
    });
  } catch (err) {}
}

function broadcastState() {
  const state = appState();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state_updated', state);
  }
  if (tray) {
    const peerStatus = `${state.peer.name} ${state.peer.online ? (state.peer.active ? 'active' : 'idle') : 'offline'}`;
    const pct = state.fiveHourHasReading ? `${state.fiveHourUsedPct}%` : 'no reading yet';
    tray.setToolTip(`Claude-Duo Â· 5h ${pct} Â· ${peerStatus}`);
  }
}

function checkClaudeJsonLimits() {
  try {
    const claudeJsonPath = path.join(os.homedir(), '.claude.json');
    if (!fs.existsSync(claudeJsonPath)) return false;
    const raw = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    const cache = raw.cachedUsageUtilization;
    const u = cache?.utilization;
    if (!u) return false;
    const fetchedAt = typeof cache.fetchedAtMs === 'number' ? cache.fetchedAtMs : fs.statSync(claudeJsonPath).mtimeMs;

    let fiveHour = null;
    let sevenDay = null;

    if (u.five_hour && typeof u.five_hour.utilization === 'number') {
      const resetSec = u.five_hour.resets_at ? Math.floor(new Date(u.five_hour.resets_at).getTime() / 1000) : null;
      fiveHour = {
        used_percentage: u.five_hour.utilization,
        resets_at: resetSec
      };
    }

    if (u.seven_day && typeof u.seven_day.utilization === 'number') {
      const resetSec = u.seven_day.resets_at ? Math.floor(new Date(u.seven_day.resets_at).getTime() / 1000) : null;
      sevenDay = {
        used_percentage: u.seven_day.utilization,
        resets_at: resetSec
      };
    }

    if (fiveHour) {
      const prev = { ...quotaEngine.officialFiveHour };
      const changed = quotaEngine.updateOfficialLimits({
        rate_limits: { five_hour: fiveHour, seven_day: sevenDay }
      }, fetchedAt, 'cache');
      if (changed) {
        handleOfficialChange(prev);
        broadcastState();
        checkPublish();
      }
      return changed;
    }
  } catch (e) {
    return false;
  }
}

// Watch the directory: a file watch dies when Claude Code replaces the file.
let claudeJsonTimer = null;
function watchClaudeJson() {
  try {
    fs.watch(os.homedir(), (event, filename) => {
      if (filename && filename !== '.claude.json') return;
      if (claudeJsonTimer) clearTimeout(claudeJsonTimer);
      claudeJsonTimer = setTimeout(() => {
        claudeJsonTimer = null;
        checkClaudeJsonLimits();
      }, 500);
    });
  } catch (e) {}
}

const USAGE_POLL_VISIBLE_MS = 30 * 1000;
const USAGE_POLL_HIDDEN_MS = 2 * 60 * 1000;
const USAGE_ON_DEMAND_GAP_MS = 10 * 1000;
const USAGE_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const SIGN_IN_REASONS = ['not-signed-in', 'token-expired', 'no-credentials', 'http-401'];
let usageApi = { status: 'starting', lastOkAt: 0, lastAttemptAt: 0, blockedUntil: 0, inFlight: false };
let usagePollTimer = null;

function windowVisible() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
}

function scheduleUsagePoll() {
  if (usagePollTimer) clearTimeout(usagePollTimer);
  usagePollTimer = setTimeout(() => pollUsageApi(), windowVisible() ? USAGE_POLL_VISIBLE_MS : USAGE_POLL_HIDDEN_MS);
}

async function pollUsageApi(onDemand = false) {
  const now = Date.now();
  if (usageApi.inFlight || now < usageApi.blockedUntil) return;
  if (onDemand && now - usageApi.lastAttemptAt < USAGE_ON_DEMAND_GAP_MS) return;
  usageApi.inFlight = true;
  usageApi.lastAttemptAt = now;
  try {
    const r = await fetchUsage();
    const before = usageApi.status;
    if (r.ok) {
      usageApi.status = 'live';
      usageApi.lastOkAt = r.fetchedAt;
      const prev = { ...quotaEngine.officialFiveHour };
      const changed = quotaEngine.updateOfficialLimits({ rate_limits: r.rateLimits }, r.fetchedAt, 'api');
      if (changed) handleOfficialChange(prev);
      checkPublish();
    } else {
      usageApi.status = r.reason === 'http' ? `http-${r.status}` : r.reason;
      if (r.status === 429) usageApi.blockedUntil = Date.now() + USAGE_RATE_LIMIT_BACKOFF_MS;
    }
    if (r.ok || before !== usageApi.status) broadcastState();
  } finally {
    usageApi.inFlight = false;
    scheduleUsagePoll();
  }
}

function usageApiView() {
  return {
    status: usageApi.status,
    lastOkAt: usageApi.lastOkAt || null,
    needsSignIn: SIGN_IN_REASONS.includes(usageApi.status)
  };
}

function appState() {
  return { ...quotaEngine.getStateSummary(), relayStatus: relayClient.status, usageApi: usageApiView() };
}

function watchCredentials() {
  let t = null;
  try {
    fs.watch(path.dirname(CREDENTIALS_PATH), (event, filename) => {
      if (filename && filename !== path.basename(CREDENTIALS_PATH)) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        usageApi.blockedUntil = 0;
        usageApi.lastAttemptAt = 0;
        pollUsageApi(true);
      }, 1000);
    });
  } catch (e) {}
}

function findClaudeCli() {
  try {
    const found = require('child_process').execFileSync('where', ['claude'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find(Boolean);
    if (found) return found.trim();
  } catch (e) {}
  try {
    const extDir = path.join(os.homedir(), '.vscode', 'extensions');
    const dirs = fs.readdirSync(extDir).filter(d => d.startsWith('anthropic.claude-code-')).sort().reverse();
    for (const d of dirs) {
      const exe = path.join(extDir, d, 'resources', 'native-binary', 'claude.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch (e) {}
  return null;
}

function refreshNow() {
  checkClaudeJsonLimits();
  pollUsageApi(true);
  broadcastState();
}

app.whenReady().then(() => {
  // 1. Auto-install Claude Code statusline hook
  hookInstalled = StatuslineReceiver.installHook();

  // 2. Create standard Desktop Window
  createMainWindow();
  initUpdater(() => mainWindow);

  // 3. Create Tray Icon
  createTray();

  // 4. Start Statusline Receiver
  statuslineReceiver = new StatuslineReceiver(4821, (data) => {
    const prev = { ...quotaEngine.officialFiveHour };
    // Idle sessions' status lines repeat stale numbers, so defer to live usage.
    const apiLive = usageApi.status === 'live' && Date.now() - usageApi.lastOkAt < 2 * USAGE_POLL_HIDDEN_MS;
    const changed = apiLive ? false : quotaEngine.updateOfficialLimits(data);
    if (apiLive) pollUsageApi(true);
    quotaEngine.recordStatuslineTelemetry(data);
    // The status line refreshes while Claude Code is working: pick up new transcript usage soon.
    if (transcriptWatcher) transcriptWatcher.scanSoon();
    if (changed) {
      handleOfficialChange(prev);
      broadcastState();
    }
    checkPublish();
    return statusLineText();
  });
  statuslineReceiver.start();

  // 5. Local attribution from Claude Code transcripts (numbers only, nothing leaves this PC)
  let usageDb = null;
  try {
    usageDb = new UsageDb(path.join(os.homedir(), '.claude-duo', 'usage.db'));
    quotaEngine.attachDb(usageDb);
    // Restarts resume transcripts where they stopped, so the live window comes from the database.
    for (const turn of usageDb.turnsSince(Date.now() - 5 * 3600 * 1000)) quotaEngine.recordLocalTurn(turn);
  } catch (e) {
    usageDb = null;
  }
  transcriptWatcher = new TranscriptWatcher(quotaEngine.claudeProjectsDir, {
    db: usageDb,
    onTurn: (turn) => quotaEngine.recordLocalTurn(turn),
    onScanDone: (found) => {
      checkClaudeJsonLimits();
      if (found) {
        broadcastState();
        checkPublish();
      }
    }
  });
  transcriptWatcher.start(15000);

  checkClaudeJsonLimits();
  setInterval(() => checkClaudeJsonLimits(), 15000);
  watchClaudeJson();

  pollUsageApi();
  watchCredentials();

  // 6. Start Relay Client
  let lastHandledPingTs = Date.now();
  const FRESH_MS = 2 * 60 * 1000; // don't toast about reservations replayed from history

  relayClient.on('peer_update', (envelope) => {
    if (envelope.state) {
      const prev = { ...quotaEngine.officialFiveHour };
      const result = quotaEngine.updatePeerState(envelope.state, envelope.ts);
      const fresh = envelope.ts && (Date.now() - envelope.ts) < FRESH_MS;

      // Handle peer ping toast
      if (envelope.state.lastPing && envelope.state.lastPing.sender !== cfg.userName) {
        if (envelope.state.lastPing.ts > lastHandledPingTs) {
          lastHandledPingTs = envelope.state.lastPing.ts;
          notifier.showToast(`Ping from ${envelope.state.lastPing.sender}`, envelope.state.lastPing.message || 'Hey! Are you using Claude right now?', false, 'ping');
        }
      }

      // Handle peer focus reservation
      if (result.reservationChanged && fresh) {
        const now = quotaEngine.reservation;
        const before = result.prevReservation;
        if (now.holder && now.holder !== cfg.userName && now.until > Date.now()) {
          const mins = Math.max(1, Math.round((now.until - Date.now()) / 60000));
          notifier.showToast('Focus requested', `${now.holder} requested ${mins} minutes of focus time.`, false, 'focus');
        } else if (!now.holder && before.holder && before.holder !== cfg.userName) {
          notifier.showToast('Focus finished', `${before.holder} finished focus time. Capacity is open.`, false, 'focus');
        }
      }

      if (result.officialChanged) handleOfficialChange(prev);

      broadcastState();
      checkPublish();
    }
  });
  relayClient.on('status', () => broadcastState());
  relayClient.startListening();

  // 7. Ticker (every 3 seconds): refresh UI and publish only if something changed
  setInterval(() => {
    broadcastState();
    checkPublish();
  }, 3000);

  broadcastState();
});

// IPC handlers
ipcMain.handle('get_state', () => {
  return appState();
});

ipcMain.handle('open_claude_signin', () => {
  const cli = findClaudeCli();
  if (!cli) {
    shell.openExternal('https://code.claude.com/docs/en/setup');
    return { ok: false, reason: 'cli-not-found' };
  }
  require('child_process').spawn('cmd.exe', ['/c', `start "Claude Code" cmd /k "${cli}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  return { ok: true };
});

ipcMain.handle('send_ping', (e, msg) => {
  lastSentPing = { sender: cfg.userName, message: msg || 'Are you using Claude right now?', ts: Date.now() };
  checkPublish();
  return true;
});

// Duration comes from Settings > Focus; the renderer's argument is ignored so both stay in sync.
ipcMain.handle('take_priority', () => {
  quotaEngine.takeTheWheel(cfg.userName, cfg.app.focus_minutes);
  checkPublish();
  broadcastState();
  return appState();
});

ipcMain.handle('release_priority', () => {
  quotaEngine.releaseTheWheel();
  checkPublish();
  broadcastState();
  return appState();
});

ipcMain.handle('quit_app', () => {
  app.isQuitting = true;
  app.quit();
});

// ---- Settings ----

ipcMain.handle('get_settings', () => settingsView());

// patch: any subset of { general, notifications, focus, connection } using the same keys as get_settings.
// connection.passphrase: a new passphrase, or empty/missing to keep the current one.
// Returns { ok: true, settings } or { ok: false, errors: { field: message } }.
ipcMain.handle('save_settings', (e, patch = {}) => {
  const { errors, next } = Settings.validate(cfg, patch);
  if (Object.keys(errors).length) return { ok: false, errors };
  try {
    Settings.save(next);
  } catch (err) {
    return { ok: false, errors: { _form: 'Could not write config.json: ' + err.message } };
  }
  const prev = cfg;
  cfg = next;
  if (patch.general && patch.general.startWithWindows !== undefined && app.isPackaged) {
    setAutoStart(Boolean(patch.general.startWithWindows));
  }
  applySettings(prev, next);
  const view = settingsView();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings_updated', view);
  return { ok: true, settings: view };
});

// Checks the relay server is reachable without spending any of the daily message budget.
ipcMain.handle('test_connection', (e, server) => relayClient.testConnection(server || cfg.server));

ipcMain.handle('reveal_config', () => {
  if (fs.existsSync(Settings.CONFIG_PATH)) shell.showItemInFolder(Settings.CONFIG_PATH);
  else shell.openPath(path.dirname(Settings.CONFIG_PATH));
  return true;
});
