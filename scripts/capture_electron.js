const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const shotsDir = path.join(__dirname, '..', '.pair-ops', 'sessions', 'session-01', 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

const now = Date.now();

const mockSettings = {
  general: {
    closeToTray: true,
    startHidden: false,
    alwaysOnTop: false,
    startWithWindows: false,
    startWithWindowsAvailable: false
  },
  notifications: {
    quotaAlert: true,
    quotaAlertPct: 85,
    limitReset: true,
    ping: true,
    focus: true,
    sound: true
  },
  focus: {
    minutes: 20,
    choices: [10, 20, 30, 60]
  },
  connection: {
    userName: 'Alice',
    peerName: 'Bob',
    topic: 'claude-duo-demo',
    server: 'https://ntfy.sh',
    passphraseSet: false
  },
  info: {
    claudeAccount: 'developer@example.com',
    configPath: '~/.claude-duo/config.json',
    appVersion: '1.0.0',
    relayStatus: 'connected',
    statusLineHookInstalled: true,
    fiveHourHasReading: true,
    fiveHourSource: 'statusline',
    fiveHourUpdatedAt: now - 120000
  }
};

ipcMain.handle('get_state', () => null);
ipcMain.handle('get_settings', () => mockSettings);
ipcMain.handle('save_settings', (e, patch) => ({ ok: true, settings: mockSettings }));
ipcMain.handle('test_connection', () => ({ ok: true, ms: 84 }));
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
  await win.webContents.executeJavaScript(`document.documentElement.style.setProperty('--capture', '1');`);

  async function shot(name) {
    await new Promise(r => setTimeout(r, 450));
    const img = await win.webContents.capturePage();
    const dest = path.join(shotsDir, `${name}.png`);
    fs.writeFileSync(dest, img.toPNG());
    console.log('Captured:', name, fs.statSync(dest).size, 'bytes');
  }

  // 1. Settings - General (780x560)
  win.setSize(780, 560);
  await win.webContents.executeJavaScript(`
    renderSettings(${JSON.stringify(mockSettings)});
    openSettings('general');
  `);
  await shot('settings-general');

  // 2. Settings - Connection (passphrase not set, warning visible)
  await win.webContents.executeJavaScript(`
    openSettings('connection');
  `);
  await shot('settings-connection');

  // 3. Settings - About
  await win.webContents.executeJavaScript(`
    openSettings('about');
  `);
  await shot('settings-about');

  // 4. Dashboard - No Reading Yet (780x560)
  await win.webContents.executeJavaScript(`
    closeSettings();
    updateUI({
      fiveHourHasReading: false,
      fiveHourUsedPct: 0,
      fiveHourUpdatedAt: null,
      fiveHourResetsAt: null,
      sevenDayUsedPct: 15,
      relayStatus: 'connected',
      isCollision: false,
      local: { name: 'Alice', active: false, sharePct: 100, lastPromptTime: null },
      peer: { name: 'Bob', active: false, online: false, sharePct: 0, lastPromptTime: null }
    });
  `);
  await shot('dash-no-reading');

  // 5. Dashboard - Maximized (1920x1080)
  win.setSize(1920, 1080);
  await win.webContents.executeJavaScript(`
    updateUI({
      fiveHourHasReading: true,
      fiveHourUsedPct: 52,
      fiveHourUpdatedAt: ${now - 180000},
      fiveHourResetsAt: ${Math.floor(now / 1000) + 6400},
      sevenDayUsedPct: 28,
      relayStatus: 'connected',
      isCollision: false,
      local: { name: 'Alice', active: false, sharePct: 60, lastPromptTime: ${now - 300000} },
      peer: { name: 'Bob', active: false, online: true, sharePct: 40, lastPromptTime: ${now - 600000} }
    });
  `);
  await shot('dash-maximized-1920');

  // 6. Dashboard - Compact (640x480)
  win.setSize(640, 480);
  await win.webContents.executeJavaScript(`
    updateUI({
      fiveHourHasReading: true,
      fiveHourUsedPct: 42,
      fiveHourUpdatedAt: ${now - 60000},
      fiveHourResetsAt: ${Math.floor(now / 1000) + 7200},
      sevenDayUsedPct: 24,
      relayStatus: 'connected',
      isCollision: false,
      local: { name: 'Alice', active: false, sharePct: 70, lastPromptTime: ${now - 180000} },
      peer: { name: 'Bob', active: false, online: true, sharePct: 30, lastPromptTime: ${now - 600000} }
    });
  `);
  await shot('dash-640x480');

  app.quit();
});
