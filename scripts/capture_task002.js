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
  { id: 'sess-1', title: 'Refactor quota attribution & usage API polling', model: 'Opus 5.5', effort: 'high', thinking: 'adaptive', speed: 'standard', tokens: 290000, turns: 42, pct: 28.5, lastTs: now - 60000 },
  { id: 'sess-2', title: 'Cloudflare relay worker with SQLite DO', model: 'Sonnet 3.7', effort: 'medium', thinking: null, speed: 'standard', tokens: 185000, turns: 24, pct: 16.2, lastTs: now - 180000 },
  { id: 'sess-3', title: null, model: 'Opus 5.5', effort: 'xhigh', thinking: 'enabled', speed: 'fast', tokens: 120000, turns: 15, pct: 10.4, lastTs: now - 600000 },
  { id: 'sess-4', title: 'Fix formatModelName family version parsing', model: 'Haiku 3.5', effort: 'low', thinking: null, speed: 'standard', tokens: 45000, turns: 8, pct: 3.8, lastTs: now - 1200000 },
  { id: 'sess-5', title: 'Desktop icon and statusline telemetry polish', model: 'Sonnet 3.7', effort: 'medium', thinking: null, speed: 'standard', tokens: 32000, turns: 6, pct: 2.1, lastTs: now - 1800000 },
  { id: 'sess-6', title: 'Older extra session (should be capped/scrolled)', model: 'Sonnet 3.5', effort: 'low', thinking: null, speed: 'standard', tokens: 12000, turns: 2, pct: 0.8, lastTs: now - 2400000 }
];

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

  const baseState = {
    fiveHourHasReading: true,
    fiveHourUsedPct: 82,
    fiveHourUpdatedAt: now - 20000,
    fiveHourResetsAt: Math.floor(now / 1000) + 5400,
    fiveHourSource: 'api',
    sevenDayUsedPct: 58,
    relayStatus: 'connected',
    reconciliation: {
      officialPct: 82,
      youPct: 61,
      peerPct: 14,
      unattributedPct: 7,
      hasReading: true,
      isEstimated: false
    },
    local: {
      name: 'Dev',
      active: true,
      sharePct: 81,
      quotaPct: 61,
      tokens5h: 672000,
      model: 'Opus 5.5',
      effort: 'high',
      severity: 'Heavy',
      lastPromptTime: now - 45000
    },
    peer: {
      name: 'Kaushik',
      active: false,
      online: true,
      sharePct: 19,
      quotaPct: 14,
      tokens5h: 154000,
      model: 'Sonnet 3.7',
      effort: 'medium',
      severity: 'Light',
      lastPromptTime: now - 450000
    },
    unattributedQuotaPct: 7,
    isCollision: false,
    reservation: { holder: null, until: null, setAt: 0 },
    sessions: mockSessions
  };

  // 1. 780x560 View with sessions present
  win.setSize(780, 560);
  await win.webContents.executeJavaScript(`updateUI(${JSON.stringify(baseState)});`);
  await shot('task002-780x560');

  // 2. 640x480 Compact View with sessions present
  win.setSize(640, 480);
  await win.webContents.executeJavaScript(`updateUI(${JSON.stringify(baseState)});`);
  await shot('task002-640x480');

  app.quit();
});
