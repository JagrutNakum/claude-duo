const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const shotsDir = path.join(__dirname, '..', '.pair-ops', 'sessions', 'session-02', 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

const now = Date.now();

const mockSettings = {
  general: { closeToTray: true, startHidden: false, alwaysOnTop: false, startWithWindows: false, startWithWindowsAvailable: false },
  notifications: { quotaAlert: true, quotaAlertPct: 85, limitReset: true, ping: true, focus: true, sound: true },
  focus: { minutes: 20, choices: [10, 20, 30, 60] },
  connection: { userName: 'Dev', peerName: 'Kaushik', topic: 'claude-duo-shared', server: 'https://ntfy.sh', passphraseSet: true },
  info: { claudeAccount: 'developer@example.com', configPath: '~/.claude-duo/config.json', appVersion: '1.0.0', relayStatus: 'connected', statusLineHookInstalled: true, fiveHourHasReading: true, fiveHourSource: 'api', fiveHourUpdatedAt: now - 30000 }
};

ipcMain.handle('get_state', () => null);
ipcMain.handle('get_settings', () => mockSettings);
ipcMain.handle('save_settings', (e, patch) => ({ ok: true, settings: mockSettings }));
ipcMain.handle('test_connection', () => ({ ok: true, ms: 42 }));
ipcMain.handle('reveal_config', () => true);

const mockSessions = [
  {
    id: 'sess-1',
    title: 'Refactor quota attribution & telemetry facts',
    project: 'claude-duo',
    model: 'Opus 5.5',
    effort: 'high',
    thinking: 'adaptive',
    speed: 'standard',
    turns: 42,
    input: 195000,
    output: 45000,
    cacheWrite: 50000,
    cacheRead: 620000,
    costSharePct: 38.2,
    lastTs: now - 60000
  },
  {
    id: 'sess-2',
    title: 'Cloudflare relay worker with SQLite DO',
    project: 'cf-relay',
    model: 'Sonnet 3.7',
    effort: 'medium',
    thinking: null,
    speed: 'standard',
    turns: 28,
    input: 110000,
    output: 28000,
    cacheWrite: 22000,
    cacheRead: 340000,
    costSharePct: 24.5,
    lastTs: now - 180000
  },
  {
    id: 'sess-3',
    title: null,
    project: 'experiments',
    model: 'Opus 5.5',
    effort: 'xhigh',
    thinking: 'enabled',
    speed: 'fast',
    turns: 18,
    input: 85000,
    output: 22000,
    cacheWrite: 13000,
    cacheRead: 210000,
    costSharePct: 18.1,
    lastTs: now - 600000
  },
  {
    id: 'sess-4',
    title: 'Fix formatModelName family version parsing',
    project: 'claude-duo',
    model: 'Haiku 3.5',
    effort: 'low',
    thinking: null,
    speed: 'standard',
    turns: 12,
    input: 42000,
    output: 9000,
    cacheWrite: 6000,
    cacheRead: 110000,
    costSharePct: 11.4,
    lastTs: now - 1200000
  },
  {
    id: 'sess-5',
    title: 'Desktop icon and statusline telemetry polish',
    project: 'claude-duo',
    model: 'Sonnet 3.7',
    effort: 'medium',
    thinking: null,
    speed: 'standard',
    turns: 8,
    input: 26000,
    output: 6000,
    cacheWrite: 4000,
    cacheRead: 65000,
    costSharePct: 7.8,
    lastTs: now - 1800000
  }
];

const mockWindow = {
  from: now - 5 * 3600 * 1000,
  to: now,
  turns: 108,
  input: 458000,
  output: 110000,
  thinking: 28000,
  cacheWrite: 95000,
  cacheRead: 1345000
};

const mockByModel = [
  { model: 'Opus 5.5', turns: 60, input: 280000, output: 67000, thinking: 22000, cacheWrite: 63000, cacheRead: 830000 },
  { model: 'Sonnet 3.7', turns: 36, input: 136000, output: 34000, thinking: 6000, cacheWrite: 26000, cacheRead: 405000 },
  { model: 'Haiku 3.5', turns: 12, input: 42000, output: 9000, thinking: null, cacheWrite: 6000, cacheRead: 110000 }
];

const mockPeriods = {
  today: { turns: 142, input: 580000, output: 145000, thinking: 36000, cacheWrite: 120000, cacheRead: 1820000 },
  last7d: { turns: 684, input: 3200000, output: 890000, thinking: 190000, cacheWrite: 740000, cacheRead: 9400000 },
  allTime: { turns: 14620, input: 68400000, output: 18500000, thinking: 4200000, cacheWrite: 15200000, cacheRead: 210000000 }
};

const stateUnsplit = {
  fiveHourHasReading: true,
  fiveHourUsedPct: 82,
  fiveHourUpdatedAt: now - 20000,
  fiveHourResetsAt: Math.floor(now / 1000) + 5400,
  fiveHourSource: 'api',
  fiveHourPace: { pct: 14, minutes: 28 },
  sevenDayUsedPct: 58,
  relayStatus: 'connected',
  canSplit: false,
  reconciliation: {
    officialPct: 82,
    youPct: null,
    peerPct: null,
    unattributedPct: null,
    hasReading: true,
    isEstimated: false
  },
  local: {
    name: 'Dev',
    active: true,
    sharePct: null,
    quotaPct: null,
    tokens5h: 663000,
    model: 'Opus 5.5',
    effort: 'high',
    thinking: 'adaptive',
    severity: null,
    lastPromptTime: now - 45000
  },
  peer: {
    name: 'Kaushik',
    active: false,
    online: false,
    sharePct: null,
    quotaPct: null,
    tokens5h: null,
    model: null,
    effort: null,
    severity: null,
    lastPromptTime: now - 450000
  },
  unattributedQuotaPct: null,
  isCollision: false,
  reservation: { holder: null, until: null, setAt: 0 },
  window: mockWindow,
  sessions: mockSessions,
  byModel: mockByModel,
  periods: mockPeriods
};

const stateSplit = {
  ...stateUnsplit,
  canSplit: true,
  reconciliation: {
    officialPct: 82,
    youPct: 61,
    peerPct: 21,
    unattributedPct: null,
    hasReading: true,
    isEstimated: false
  },
  local: {
    ...stateUnsplit.local,
    quotaPct: 61,
    sharePct: 74
  },
  peer: {
    name: 'Kaushik',
    active: false,
    online: true,
    sharePct: 26,
    quotaPct: 21,
    tokens5h: 185000,
    model: 'Sonnet 3.7',
    effort: 'medium',
    severity: null,
    lastPromptTime: now - 180000
  }
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 780,
    height: 560,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await win.webContents.insertCSS('* { transition: none !important; }');

  async function shot(name) {
    await new Promise(r => setTimeout(r, 450));
    const img = await win.webContents.capturePage();
    const dest = path.join(shotsDir, `${name}.png`);
    fs.writeFileSync(dest, img.toPNG());
    console.log('Captured:', name, fs.statSync(dest).size, 'bytes');
  }

  // 1. canSplit = false (real case now), 780x560
  win.setSize(780, 560);
  await win.webContents.executeJavaScript(`
    closeUsage();
    closeSettings();
    updateUI(${JSON.stringify(stateUnsplit)});
  `);
  await shot('task003-unsplit-780x560');

  // 2. canSplit = false, 640x480
  win.setSize(640, 480);
  await win.webContents.executeJavaScript(`updateUI(${JSON.stringify(stateUnsplit)});`);
  await shot('task003-unsplit-640x480');

  // 3. canSplit = true (mock), 780x560
  win.setSize(780, 560);
  await win.webContents.executeJavaScript(`updateUI(${JSON.stringify(stateSplit)});`);
  await shot('task003-split-780x560');

  // 4. canSplit = true, 640x480
  win.setSize(640, 480);
  await win.webContents.executeJavaScript(`updateUI(${JSON.stringify(stateSplit)});`);
  await shot('task003-split-640x480');

  // 5. Usage detail view, 780x560
  win.setSize(780, 560);
  await win.webContents.executeJavaScript(`
    openUsage();
    renderUsageDetails(${JSON.stringify(stateUnsplit)});
  `);
  await shot('task003-usage-780x560');

  // 5b. Usage detail view scrolled to bottom, 780x560
  await win.webContents.executeJavaScript(`
    document.getElementById('usage-body').scrollTop = 9999;
  `);
  await shot('task003-usage-scrolled-780x560');

  // 6. Usage detail view, 640x480
  win.setSize(640, 480);
  await win.webContents.executeJavaScript(`
    document.getElementById('usage-body').scrollTop = 0;
    openUsage();
    renderUsageDetails(${JSON.stringify(stateUnsplit)});
  `);
  await shot('task003-usage-640x480');

  app.quit();
});
