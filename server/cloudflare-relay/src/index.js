import { DurableObject } from 'cloudflare:workers';

const ROOM_PATH = /^\/v1\/rooms\/([a-f0-9]{64})$/;
const DEVICE_ID = /^[\w.-]{1,64}$/;
const MAX_MESSAGE_CHARS = 32 * 1024;
const MAX_SOCKETS_PER_ROOM = 8;
const RATE_WINDOW_MS = 10 * 1000;
const RATE_MAX_MESSAGES = 30;
const STATE_TTL_MS = 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/health') return Response.json({ healthy: true });

    const room = url.pathname.match(ROOM_PATH);
    if (!room) return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    if (!DEVICE_ID.test(url.searchParams.get('device') || '')) return new Response('Bad device id', { status: 400 });

    return env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(request);
  }
};

// Payloads are end-to-end encrypted by the apps; the room only stores and forwards opaque strings.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS states (device TEXT PRIMARY KEY, env TEXT NOT NULL, ts INTEGER NOT NULL)');
    // Answered without waking the object, so keepalives cost no duration.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const device = new URL(request.url).searchParams.get('device');
    for (const old of this.ctx.getWebSockets(device)) {
      try { old.close(4000, 'Replaced by a newer connection'); } catch (e) {}
    }
    const open = this.ctx.getWebSockets().filter(ws => ws.readyState === WebSocket.OPEN);
    if (open.length >= MAX_SOCKETS_PER_ROOM) return new Response('Room is full', { status: 429 });

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [device]);
    server.serializeAttachment({ device, windowStart: 0, count: 0 });

    this.ctx.storage.sql.exec('DELETE FROM states WHERE ts < ?', Date.now() - STATE_TTL_MS);
    const states = this.ctx.storage.sql.exec('SELECT device, env FROM states WHERE device != ?', device).toArray();
    server.send(JSON.stringify({ t: 'snapshot', states }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_CHARS) {
      ws.close(1009, 'Message too large');
      return;
    }
    const a = ws.deserializeAttachment();
    const now = Date.now();
    if (now - a.windowStart > RATE_WINDOW_MS) { a.windowStart = now; a.count = 0; }
    a.count++;
    ws.serializeAttachment(a);
    if (a.count > RATE_MAX_MESSAGES) {
      ws.close(4029, 'Rate limited');
      return;
    }

    let msg;
    try { msg = JSON.parse(message); } catch (e) { return; }
    if (!msg || msg.t !== 'state' || typeof msg.env !== 'string') return;

    this.ctx.storage.sql.exec(
      'INSERT INTO states (device, env, ts) VALUES (?, ?, ?) ON CONFLICT(device) DO UPDATE SET env = excluded.env, ts = excluded.ts',
      a.device, msg.env, now
    );
    const out = JSON.stringify({ t: 'state', device: a.device, env: msg.env });
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;
      try { peer.send(out); } catch (e) {}
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'Closed'); } catch (e) {}
  }

  async webSocketError() {}
}
