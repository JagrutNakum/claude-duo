"""
Optional Transparent Anthropic API Proxy.
Allows developers using SDKs, IDE extensions, or custom tools to route requests through
localhost to automatically intercept and count token usage.
Usage:
  set ANTHROPIC_BASE_URL=http://localhost:8080
"""

import json
import time
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional
from .metrics import UsageAggregator

ANTHROPIC_UPSTREAM = "https://api.anthropic.com"

def create_proxy_handler(aggregator: UsageAggregator, on_turn_callback=None):
    class ClaudeProxyHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            content_len = int(self.headers.get("Content-Length", 0))
            req_body = self.rfile.read(content_len) if content_len > 0 else b""

            target_url = f"{ANTHROPIC_UPSTREAM}{self.path}"

            fwd_headers = {}
            for k, v in self.headers.items():
                if k.lower() not in ("host", "content-length"):
                    fwd_headers[k] = v

            req = urllib.request.Request(target_url, data=req_body, headers=fwd_headers, method="POST")

            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    resp_body = resp.read()
                    self.send_response(resp.status)
                    for k, v in resp.headers.items():
                        if k.lower() not in ("transfer-encoding", "content-encoding"):
                            self.send_header(k, v)
                    self.end_headers()
                    self.wfile.write(resp_body)

                    # Intercept usage from non-streaming JSON responses
                    try:
                        resp_json = json.loads(resp_body.decode("utf-8"))
                        usage = resp_json.get("usage")
                        if usage:
                            model = resp_json.get("model", "claude-sonnet-3-5")
                            turn = aggregator.record_turn(
                                model=model,
                                input_tokens=usage.get("input_tokens", 0),
                                output_tokens=usage.get("output_tokens", 0),
                                cache_read=usage.get("cache_read_input_tokens", 0),
                                cache_write=usage.get("cache_creation_input_tokens", 0),
                                timestamp=time.time()
                            )
                            if on_turn_callback:
                                on_turn_callback(turn)
                    except Exception:
                        pass

            except urllib.error.HTTPError as e:
                err_body = e.read()
                self.send_response(e.code)
                for k, v in e.headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(err_body)
            except Exception as e:
                self.send_response(502)
                self.end_headers()
                self.wfile.write(f"Proxy Error: {str(e)}".encode("utf-8"))

        def log_message(self, format, *args):
            pass # Suppress noisy HTTP logs

    return ClaudeProxyHandler

def run_proxy(port: int, aggregator: UsageAggregator, on_turn=None):
    handler = create_proxy_handler(aggregator, on_turn)
    server = HTTPServer(("127.0.0.1", port), handler)
    server.serve_forever()
