const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

class StatuslineReceiver {
  constructor(port = 4821, onUpdate) {
    this.port = port;
    this.onUpdate = onUpdate;
    this.server = null;
  }

  start() {
    this.server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/statusline') {
        // Only the local hook may post. Browsers always send Origin, and cannot send
        // application/json cross-origin without a CORS preflight, which we never answer.
        const contentType = (req.headers['content-type'] || '').toLowerCase();
        if (req.headers.origin || !contentType.startsWith('application/json')) {
          res.writeHead(403);
          res.end();
          req.resume();
          return;
        }
        let body = '';
        let tooLarge = false;
        req.on('data', chunk => {
          body += chunk;
          if (body.length > 1024 * 1024) {
            tooLarge = true;
            req.destroy();
          }
        });
        req.on('end', () => {
          if (tooLarge) return;
          let line = '';
          try {
            const data = JSON.parse(body);
            if (this.onUpdate) line = this.onUpdate(data) || '';
          } catch (e) {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, line }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.server.on('error', () => {}); // Port in use or permission
    this.server.listen(this.port, '127.0.0.1');
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  static installHook() {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const hookScriptPath = path.join(__dirname, 'statusline_hook.js');

    try {
      let settings = {};
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      }
      
      const hookCommand = `node "${hookScriptPath.replace(/\\/g, '\\\\')}"`;
      const current = settings.statusLine;
      // Never replace a status line the user set up for something else.
      if (current && current.command && !String(current.command).includes('statusline_hook.js')) {
        return false;
      }
      // Already installed: leave settings.json untouched.
      if (current && current.type === 'command' && current.command === hookCommand) {
        return true;
      }
      settings.statusLine = {
        type: 'command',
        command: hookCommand
      };

      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
      return true;
    } catch (e) {
      return false;
    }
  }
}

module.exports = {
  StatuslineReceiver
};
