const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

// Undocumented endpoint behind Claude Code's /usage; may change without notice.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

// Never refresh the token here: rotating it can sign Claude Code out.
function readAccessToken() {
  try {
    const o = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')).claudeAiOauth;
    if (!o || !o.accessToken) return { token: null, reason: 'not-signed-in' };
    if (typeof o.expiresAt === 'number' && o.expiresAt < Date.now() + 30000) return { token: null, reason: 'token-expired' };
    return { token: o.accessToken };
  } catch (e) {
    return { token: null, reason: 'no-credentials' };
  }
}

function toSeconds(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function fetchUsage() {
  const { token, reason } = readAccessToken();
  if (!token) return Promise.resolve({ ok: false, reason });
  return new Promise((resolve) => {
    const req = https.get(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-duo'
      },
      timeout: 8000
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 256 * 1024) body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, reason: 'http', status: res.statusCode });
        try {
          const j = JSON.parse(body);
          if (!j.five_hour || typeof j.five_hour.utilization !== 'number') return resolve({ ok: false, reason: 'unexpected-shape' });
          const rateLimits = {
            five_hour: { used_percentage: j.five_hour.utilization, resets_at: toSeconds(j.five_hour.resets_at) }
          };
          if (j.seven_day && typeof j.seven_day.utilization === 'number') {
            rateLimits.seven_day = { used_percentage: j.seven_day.utilization, resets_at: toSeconds(j.seven_day.resets_at) };
          }
          resolve({ ok: true, rateLimits, fetchedAt: Date.now() });
        } catch (e) {
          resolve({ ok: false, reason: 'bad-json' });
        }
      });
      res.on('error', () => resolve({ ok: false, reason: 'network' }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false, reason: 'network' }));
  });
}

module.exports = { fetchUsage, CREDENTIALS_PATH };
