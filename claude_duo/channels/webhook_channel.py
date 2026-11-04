"""
Generic HTTP Webhook Channel implementation.
Compatible with custom servers, Cloudflare Workers, Slack webhooks, and relay scripts.
"""

import json
import time
import urllib.request
import urllib.error
from typing import Callable, Optional, Dict, Any
from .base import BaseChannel

class WebhookChannel(BaseChannel):
    def __init__(self, config: Dict[str, Any], global_config: Dict[str, Any]):
        super().__init__(config, global_config)
        self.url = config.get("url", "").strip()
        self.auth_header = config.get("auth_header", "").strip()
        self.peer_state_cache = None

    def publish_event(self, event_type: str, title: str, message: str,
                      payload: Optional[Dict[str, Any]] = None, priority: int = 3) -> bool:
        if not self.url:
            return False

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

        body = json.dumps(envelope).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "ClaudeDuo/1.0"
        }
        if self.auth_header:
            headers["Authorization"] = self.auth_header

        req = urllib.request.Request(self.url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                return resp.status in (200, 201, 202, 204)
        except Exception:
            return False

    def publish_state(self, state_dict: Dict[str, Any]) -> bool:
        return self.publish_event(
            event_type="state_sync",
            title=f"Usage Sync: {self.user_name}",
            message=f"{self.user_name} active state",
            payload=state_dict,
            priority=1
        )

    def fetch_peer_state(self) -> Optional[Dict[str, Any]]:
        return self.peer_state_cache

    def start_listener(self, on_message: Callable[[Dict[str, Any]], None]):
        pass

    def stop_listener(self):
        pass
