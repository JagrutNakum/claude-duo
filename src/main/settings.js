const fs = require('fs');
const path = require('path');
const os = require('os');

// All settings live in ~/.claude-duo/config.json. Connection keys keep their existing names
// (user_name, peer_name, channels_config.ntfy.*, e2ee_passphrase) so older builds still read them.
// App preferences live under "app_settings". Keys this app does not know are preserved on save.
const CONFIG_PATH = path.join(os.homedir(), '.claude-duo', 'config.json');
const DEFAULT_PASSPHRASE = 'claude-pro-shared-pass';
const FOCUS_CHOICES = [10, 20, 30, 60];

const APP_DEFAULTS = {
  close_to_tray: true,
  start_hidden: false,
  always_on_top: false,
  notify_quota_alert: true,
  quota_alert_pct: 85,
  notify_limit_reset: true,
  notify_ping: true,
  notify_focus: true,
  notify_sound: true,
  focus_minutes: 20
};

function readRaw() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {}
  return {};
}

function getDefaultUserName() {
  try {
    const u = os.userInfo && os.userInfo().username;
    if (u) return u;
  } catch (e) {}
  return 'You';
}

function load() {
  const raw = readRaw();
  const ntfy = (raw.channels_config && raw.channels_config.ntfy) || {};
  return {
    raw,
    userName: raw.user_name || getDefaultUserName(),
    peerName: raw.peer_name || 'Teammate',
    topic: ntfy.topic || 'claude-duo-shared',
    server: ntfy.server || 'https://ntfy.sh',
    passphrase: raw.e2ee_passphrase || DEFAULT_PASSPHRASE,
    passphraseIsDefault: !raw.e2ee_passphrase,
    app: { ...APP_DEFAULTS, ...(raw.app_settings || {}) }
  };
}

// Validates a partial update from the renderer. Returns { errors, next } where next is the merged settings.
function validate(current, patch) {
  const errors = {};
  const next = { ...current, app: { ...current.app } };
  const c = patch.connection || {};
  const a = { ...(patch.general || {}), ...(patch.notifications || {}), ...(patch.focus || {}) };

  if (c.userName !== undefined) {
    const v = String(c.userName).trim();
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(v)) errors.userName = 'Use 1-32 letters, digits, dot, dash or underscore.';
    else next.userName = v;
  }
  if (c.peerName !== undefined) {
    const v = String(c.peerName).trim();
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(v)) errors.peerName = 'Use 1-32 letters, digits, dot, dash or underscore.';
    else next.peerName = v;
  }
  if (!errors.peerName && next.userName.toLowerCase() === next.peerName.toLowerCase()) {
    errors.peerName = 'Your name and your teammate\'s name must differ.';
  }
  if (c.topic !== undefined) {
    const v = String(c.topic).trim();
    // ntfy topic rules: up to 64 chars of letters, digits, dash and underscore.
    if (!/^[-_A-Za-z0-9]{1,64}$/.test(v)) errors.topic = 'Use 1-64 letters, digits, dash or underscore.';
    else next.topic = v;
  }
  if (c.server !== undefined) {
    const v = String(c.server).trim().replace(/\/+$/, '');
    let ok = false;
    try { ok = ['https:', 'http:', 'wss:', 'ws:'].includes(new URL(v).protocol); } catch (e) {}
    if (!ok) errors.server = 'Enter a full URL, like https://ntfy.sh or wss://your-relay.workers.dev';
    else next.server = v;
  }
  // Empty or missing passphrase means "keep the current one". It is never sent back to the renderer.
  if (c.passphrase !== undefined && String(c.passphrase).length > 0) {
    const v = String(c.passphrase);
    if (v.trim().length < 12) errors.passphrase = 'Use at least 12 characters.';
    else { next.passphrase = v.trim(); next.passphraseIsDefault = false; }
  }

  const bools = ['close_to_tray', 'start_hidden', 'always_on_top', 'notify_quota_alert', 'notify_limit_reset', 'notify_ping', 'notify_focus', 'notify_sound'];
  const camel = { close_to_tray: 'closeToTray', start_hidden: 'startHidden', always_on_top: 'alwaysOnTop', notify_quota_alert: 'quotaAlert', notify_limit_reset: 'limitReset', notify_ping: 'ping', notify_focus: 'focus', notify_sound: 'sound' };
  for (const key of bools) {
    const v = a[camel[key]];
    if (v !== undefined) next.app[key] = Boolean(v);
  }
  if (a.quotaAlertPct !== undefined) {
    const v = Number(a.quotaAlertPct);
    if (!Number.isInteger(v) || v < 50 || v > 95) errors.quotaAlertPct = 'Pick a whole number from 50 to 95.';
    else next.app.quota_alert_pct = v;
  }
  if (a.minutes !== undefined) {
    const v = Number(a.minutes);
    if (!FOCUS_CHOICES.includes(v)) errors.minutes = `Pick one of ${FOCUS_CHOICES.join(', ')}.`;
    else next.app.focus_minutes = v;
  }
  return { errors, next };
}

function save(next) {
  const raw = readRaw();
  raw.user_name = next.userName;
  raw.peer_name = next.peerName;
  raw.channels_config = raw.channels_config || {};
  raw.channels_config.ntfy = { ...(raw.channels_config.ntfy || {}), topic: next.topic, server: next.server };
  if (!next.passphraseIsDefault) raw.e2ee_passphrase = next.passphrase;
  raw.app_settings = { ...next.app };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}

function claudeAccount() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    return (j.oauthAccount && j.oauthAccount.emailAddress) || null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_PASSPHRASE,
  FOCUS_CHOICES,
  APP_DEFAULTS,
  load,
  validate,
  save,
  claudeAccount
};
