# Claude-Duo ⚡

> **Local-first, zero-knowledge companion desktop application for two developers sharing a single $20/month Claude Pro subscription on Windows 11.**

When two developers share a single Claude Pro account across separate machines, they run into rolling limits without knowing:
- *Who is prompting right now?*
- *How much of the rolling 5-hour quota remains before reset?*
- *Who consumed what share of the limit?*

**Claude-Duo** solves this safely and silently:
1. Reads Anthropic's **official Claude Code status-line stdin telemetry** (`rate_limits.five_hour.used_percentage` and `resets_at`).
2. Syncs lightweight, **zero-knowledge end-to-end encrypted** state updates over HTTPS via `ntfy.sh` without leaking prompts, code, or tasks.
3. Provides an instrument-grade dark desktop window, Windows notifications, and a 20-minute priority focus reservation lock.

---

## 🌟 Key Features

- ⏱️ **Official 5-Hour Rolling Meter:** Directly reflects Anthropic's server-side rate limits and countdown clock.
- 🟢 **Live Peer Activity:** Know instantly when your teammate is actively prompting Claude to avoid concurrent collision burns.
- 📊 **Attribution Share:** Fair, model-weighted token calculation ($q = w_m \cdot (i + 1.25c_w + 0.1c_r + 5o)$) across the rolling 5-hour window.
- 🔒 **Priority Focus Reservation:** Claim a 20-minute priority focus session so your partner knows to hold off on heavy runs.
- 💬 **Desktop Pings:** Send instant native Windows toast pings to your partner's screen.
- 🛡️ **Zero-Knowledge Privacy:** Only ~150 bytes of encrypted numbers and timestamps leave your PC. Prompts, files, and project paths never leave local storage.
- 🔌 **Zero-Setup Hook:** Automatically registers into `~/.claude/settings.json` on launch.

---

## 🚀 Running the App

### 1. Launch the Desktop Application
- Double-click the **`Claude-Duo`** shortcut on your Desktop (or run `dist/Claude-Duo-win32-x64/Claude-Duo.exe`).
- The window opens centered on your screen (780 × 560) and is visible in your Windows taskbar.
- Minimizing or closing the window sends it to the system tray. Right-click the tray icon to re-open or toggle "Start with Windows".

### 2. Testing Teammate Activity Locally
To simulate your teammate on your local machine without needing a second PC:
```powershell
node simulate_teammate.js
# Or double-click Simulate-Teammate.bat
```
Options allow testing pings, active prompt state, and focus reservations.

---

## 🛠️ Building & Packaging

To rebuild the standalone native executable from source:

```powershell
# In PowerShell (clearing VS Code Electron environment variables)
$env:ELECTRON_RUN_AS_NODE = ""
npm run package
```

The output will be placed in `dist/Claude-Duo-win32-x64/Claude-Duo.exe`.

UI verification screenshots across test states can be generated via `cmd.exe /c "set ELECTRON_RUN_AS_NODE=& npx electron scripts/capture_electron.js"` (outputs to `assets/shots/`).

---

## 🔒 Configuration

Settings are stored in `~/.claude-duo/config.json`:
```json
{
  "user_name": "Alice",
  "peer_name": "Bob",
  "channels_config": {
    "ntfy": {
      "topic": "claude-duo-my-team-secret",
      "server": "https://ntfy.sh"
    }
  },
  "e2ee_passphrase": "your-shared-secret-passphrase"
}
```
*(Both machines must share the same `topic` and `e2ee_passphrase`).*
