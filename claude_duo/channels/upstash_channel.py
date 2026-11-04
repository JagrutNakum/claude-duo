"""
Upstash Redis Channel implementation.
Uses serverless Redis over HTTPS REST for live bidirectional state sync & event queues.
"""

import json
import time
import urllib.request
import urllib.error
import threading
from typing import Callable, Optional, Dict, Any
from .base import BaseChannel

class UpstashChannel(BaseChannel):
    def __init__(self, config: Dict[str, Any], global_config: Dict[str, Any]):
        super().__init__(config, global_config)
        self.url = config.get("url", "").rstrip("/")
        self.token = config.get("token", "").strip()
        self.peer_name = global_config.get("peer_name", "Teammate")
        self.listener_thread = None
        self.running = False
        self.peer_state_cache = None

    def _request(self, path: str, method: str = "GET", data: Optional[Any] = None) -> Optional[Any]:
        if not self.url or not self.token:
            return None
        url = f"{self.url}{path}"
        body = None
        headers = {
            "Authorization": f"Bearer {self.token}",
            "User-Agent": "ClaudeDuo/1.0"
        }
        if data is not None:
            body = json.dumps(data).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                res_data = json.loads(resp.read().decode("utf-8"))
                return res_data.get("result")
        except Exception:
            return None

    def publish_event(self, event_type: str, title: str, message: str,
                      payload: Optional[Dict[str, Any]] = None, priority: int = 3) -> bool:
        envelope = {
            "type": event_type,
            "sender": self.user_name,
            "machine": self.machine_id,
            "title": title,
            "message": message,
            "payload": payload or {},
            "priority": priority,
            "timestamp": time.time()
        }
        # Push to events list (capped at 50 recent events)
        res = self._request("/lpush/claude_duo:events", method="POST", data=json.dumps(envelope))
        self._request("/ltrim/claude_duo:events/0/49", method="POST")
        return res is not None

    def publish_state(self, state_dict: Dict[str, Any]) -> bool:
        envelope = {
            "user": self.user_name,
            "machine": self.machine_id,
            "state": state_dict,
            "timestamp": time.time()
        }
        key = f"claude_duo:state:{self.user_name.lower()}"
        res = self._request(f"/set/{key}", method="POST", data=json.dumps(envelope))
        return res is not None

    def fetch_peer_state(self) -> Optional[Dict[str, Any]]:
        target_user = self.peer_name.lower()
        key = f"claude_duo:state:{target_user}"
        raw = self._request(f"/get/{key}")
        if raw:
            try:
                data = json.loads(raw) if isinstance(raw, str) else raw
                self.peer_state_cache = data.get("state", {})
                self.peer_state_cache["_last_sync"] = data.get("timestamp")
                self.peer_state_cache["_sender"] = data.get("user")
                return self.peer_state_cache
            except Exception:
                pass
        return self.peer_state_cache

    def start_listener(self, on_message: Callable[[Dict[str, Any]], None]):
        if not self.url or not self.token or self.running:
            return
        self.running = True
        last_seen_ts = time.time()

        def _poll_worker():
            while self.running:
                try:
                    # Poll top 5 events
                    events = self._request("/lrange/claude_duo:events/0/4")
                    if isinstance(events, list):
                        for ev_str in reversed(events):
                            try:
                                ev = json.loads(ev_str) if isinstance(ev_str, str) else ev_str
                                ev_ts = ev.get("timestamp", 0)
                                if ev_ts > last_seen_ts and ev.get("sender") != self.user_name:
                                    on_message(ev)
                            except Exception:
                                continue
                    # Also refresh peer state
                    self.fetch_peer_state()
                except Exception:
                    pass
                time.sleep(10)

        self.listener_thread = threading.Thread(target=_poll_worker, daemon=True)
        self.listener_thread.start()

    def stop_listener(self):
        self.running = False
