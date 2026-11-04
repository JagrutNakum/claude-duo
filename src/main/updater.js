const { app, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');

let updateState = {
  state: 'idle', // 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  version: null,
  error: null
};

function initUpdater(getMainWindow) {
  // Never attempt auto-updates in unpackaged / development mode
  if (!app.isPackaged) {
    return;
  }

  // Automatic background downloads; install staged seamlessly when user quits
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  function broadcastUpdateState() {
    const win = getMainWindow && getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('update_status', updateState);
    }
  }

  autoUpdater.on('checking-for-update', () => {
    updateState = { state: 'checking', version: null, error: null };
    broadcastUpdateState();
  });

  autoUpdater.on('update-available', (info) => {
    updateState = { state: 'downloading', version: info.version, error: null };
    broadcastUpdateState();
  });

  autoUpdater.on('update-not-available', () => {
    updateState = { state: 'idle', version: null, error: null };
    broadcastUpdateState();
  });

  autoUpdater.on('error', (err) => {
    // Fail silently without interrupting the user or crashing the process
    updateState = { state: 'error', version: null, error: err?.message || 'Update check failed' };
    broadcastUpdateState();
  });

  autoUpdater.on('download-progress', (progressObj) => {
    if (updateState.state === 'downloading') {
      updateState.percent = Math.round(progressObj.percent || 0);
      broadcastUpdateState();
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateState = { state: 'ready', version: info.version, error: null };
    broadcastUpdateState();
  });

  ipcMain.handle('get_update_status', () => updateState);

  ipcMain.handle('check_for_updates', async () => {
    if (!app.isPackaged) return { ok: false, reason: 'dev-mode' };
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || 'Check failed' };
    }
  });

  ipcMain.handle('install_update', () => {
    if (updateState.state === 'ready') {
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    }
    return { ok: false, reason: 'not-ready' };
  });

  // Delay first check by 15s to ensure zero impact on cold startup
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 15000);

  // Periodic background check every 4 hours
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 4 * 3600 * 1000);
}

module.exports = { initUpdater };
