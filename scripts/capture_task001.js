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
    await new Promise(r => setTimeout(r, 400));
    const img = await win.webContents.capturePage();
    const dest = path.join(shotsDir, `${name}.png`);
    fs.writeFileSync(dest, img.toPNG());
    console.log('Captured:', name, fs.statSync(dest).size, 'bytes');
  }

  // 1. Peer Offline State (Relay connected, Peer offline, Model: Opus 5.5)
  win.setSize(780, 560);
  await win.webContents.executeJavaScript(`
    updateUI({
      fiveHourHasReading: true,
      fiveHourUsedPct: 65,
      fiveHourUpdatedAt: ${now - 45000},
      fiveHourResetsAt: ${Math.floor(now / 1000) + 7200},
      fiveHourSource: 'api',
      sevenDayUsedPct: 40,
      relayStatus: 'connected',
      reconciliation: {
        officialPct: 65,
        youPct: 50,
        peerPct: 0,
        unattributedPct: 15,
        hasReading: true,
        isEstimated: false
      },
      local: {
        name: 'Dev',
        active: true,
        sharePct: 100,
        quotaPct: 50,
        rollingQ: 3200000,
        tokens5h: 320000,
        model: 'Opus 5.5',
        severity: 'Moderate',
        lastPromptTime: ${now - 60000}
      },
      peer: {
        name: 'Kaushik',
        active: false,
        online: false,
        sharePct: 0,
        quotaPct: 0,
        rollingQ: 0,
        tokens5h: null,
        model: null,
        severity: 'Idle',
        lastPromptTime: null
      },
      unattributedQuotaPct: 15,
      isCollision: false,
      reservation: { holder: null, until: null, setAt: 0 }
    });
  `);
  await shot('task001-peer-offline');

  // 2. Peer Online State (Relay connected, Peer online, Sync live green)
  await win.webContents.executeJavaScript(`
    updateUI({
      fiveHourHasReading: true,
      fiveHourUsedPct: 75,
      fiveHourUpdatedAt: ${now - 15000},
      fiveHourResetsAt: ${Math.floor(now / 1000) + 6800},
      fiveHourSource: 'api',
      sevenDayUsedPct: 45,
      relayStatus: 'connected',
      reconciliation: {
        officialPct: 75,
        youPct: 45,
        peerPct: 20,
        unattributedPct: 10,
        hasReading: true,
        isEstimated: false
      },
      local: {
        name: 'Dev',
        active: true,
        sharePct: 69,
        quotaPct: 45,
        rollingQ: 2800000,
        tokens5h: 280000,
        model: 'Opus 5.5',
        severity: 'Heavy',
        lastPromptTime: ${now - 30000}
      },
      peer: {
        name: 'Kaushik',
        active: true,
        online: true,
        sharePct: 31,
        quotaPct: 20,
        rollingQ: 1200000,
        tokens5h: 120000,
        model: 'Sonnet 3.7',
        severity: 'Light',
        lastPromptTime: ${now - 90000}
      },
      unattributedQuotaPct: 10,
      isCollision: false,
      reservation: { holder: null, until: null, setAt: 0 }
    });
  `);
  await shot('task001-peer-online');

  app.quit();
});
