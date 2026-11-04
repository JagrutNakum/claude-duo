const { Tray, BrowserWindow, Menu, nativeImage, screen } = require('electron');
const path = require('path');

function createDotIcon(colorHex) {
  // 16x16 crisp circle SVG
  const svg = `
    <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="6" fill="${colorHex}" />
      <circle cx="8" cy="8" r="6" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1" />
    </svg>
  `.trim();
  return nativeImage.createFromBuffer(Buffer.from(svg));
}

const COLORS = {
  green: '#2ea043',
  amber: '#d29922',
  red: '#f85149',
  purple: '#a371f7',
  gray: '#6e7681'
};

class TrayManager {
  constructor(onAction) {
    this.tray = null;
    this.window = null;
    this.onAction = onAction; // callback for menu actions
    this.currentState = 'gray';
  }

  init() {
    this.tray = new Tray(createDotIcon(COLORS.gray));
    this.tray.setToolTip('Claude-Duo · Initializing...');

    this.createWindow();

    this.tray.on('click', () => {
      this.toggleWindow();
    });

    this.tray.on('right-click', () => {
      this.showContextMenu();
    });
  }

  createWindow() {
    this.window = new BrowserWindow({
      width: 320,
      height: 220,
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    this.window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    this.window.on('blur', () => {
      this.window.hide();
    });
  }

  toggleWindow() {
    if (!this.window) return;
    if (this.window.isVisible()) {
      this.window.hide();
    } else {
      this.positionWindow();
      this.window.show();
    }
  }

  positionWindow() {
    const trayBounds = this.tray.getBounds();
    const windowBounds = this.window.getBounds();
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

    // Position above tray icon near taskbar
    let x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
    let y = Math.round(trayBounds.y - windowBounds.height - 4);

    // Keep within screen edges
    x = Math.max(8, Math.min(x, screenWidth - windowBounds.width - 8));
    y = Math.max(8, Math.min(y, screenHeight - windowBounds.height - 8));

    this.window.setPosition(x, y, false);
  }

  updateIcon(stateType, tooltipText) {
    let color = COLORS.gray;
    if (stateType === 'collision') color = COLORS.amber;
    else if (stateType === 'priority') color = COLORS.purple;
    else if (stateType === 'critical') color = COLORS.red;
    else if (stateType === 'active') color = COLORS.amber;
    else if (stateType === 'safe') color = COLORS.green;

    if (color !== this.currentState) {
      this.currentState = color;
      this.tray.setImage(createDotIcon(color));
    }
    if (tooltipText) {
      this.tray.setToolTip(tooltipText);
    }
  }

  showContextMenu() {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Request 20m focus',
        click: () => this.onAction('take_priority')
      },
      {
        label: 'Release focus',
        click: () => this.onAction('release_priority')
      },
      { type: 'separator' },
      {
        label: 'Quit Claude-Duo',
        click: () => this.onAction('quit')
      }
    ]);
    this.tray.popUpContextMenu(menu);
  }

  sendToRenderer(channel, data) {
    if (this.window && this.window.webContents) {
      this.window.webContents.send(channel, data);
    }
  }
}

module.exports = {
  TrayManager
};
