#!/usr/bin/env node
const http = require('http');

let input = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', chunk => {
  input += chunk;
});

process.stdin.on('end', () => {
  if (!input.trim()) process.exit(0);
  
  const req = http.request({
    hostname: '127.0.0.1',
    port: 4821,
    path: '/api/statusline',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(input)
    },
    timeout: 300
  }, (res) => {
    // The app answers with a one-line summary for Claude Code's status line.
    let body = '';
    res.setEncoding('utf8');
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      let line = '';
      try { line = JSON.parse(body).line || ''; } catch (e) {}
      if (line) process.stdout.write(line, () => process.exit(0));
      else process.exit(0);
    });
    res.on('error', () => process.exit(0));
  });

  req.on('timeout', () => { req.destroy(); process.exit(0); }); // App frozen: never block Claude Code
  req.on('error', () => process.exit(0)); // Fail silent and fast
  req.write(input);
  req.end();
});
