"""
Self-contained Python HTTP Relay for Claude-Duo.
Run on any machine/VPS: python simple_relay.py --port 9000
"""

import json
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

STATE_STORE = {}
EVENTS = []

class RelayHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        len_h = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(len_h) if len_h > 0 else b"{}"
        try:
            data = json.loads(body.decode("utf-8"))
            user = data.get("sender", "anon").lower()
            if data.get("type") == "state_sync":
                STATE_STORE[user] = data
            else:
                EVENTS.append(data)
                if len(EVENTS) > 100:
                    EVENTS.pop(0)

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        except Exception as e:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(f'{{"error":"{str(e)}"}}'.encode("utf-8"))

    def do_GET(self):
        parts = self.path.strip("/").split("/")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()

        if len(parts) >= 2 and parts[0] == "state":
            user = parts[1].lower()
            res = STATE_STORE.get(user, {})
            self.wfile.write(json.dumps(res).encode("utf-8"))
        elif self.path == "/events":
            self.wfile.write(json.dumps(EVENTS[-20:]).encode("utf-8"))
        else:
            self.wfile.write(json.dumps({"status": "running", "active_users": list(STATE_STORE.keys())}).encode("utf-8"))

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9000)
    args = parser.parse_args()
    print(f"Claude-Duo Relay running on port {args.port}...")
    HTTPServer(("0.0.0.0", args.port), RelayHandler).serve_forever()
