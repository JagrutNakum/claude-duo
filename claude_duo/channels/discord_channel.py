"""
Discord Webhook Channel implementation.
Sends rich, color-coded embed messages and alerts to a Discord channel.
"""

import json
import time
import urllib.request
import urllib.error
from typing import Callable, Optional, Dict, Any
from .base import BaseChannel

class DiscordChannel(BaseChannel):
    def __init__(self, config: Dict[str, Any], global_config: Dict[str, Any]):
        super().__init__(config, global_config)
        self.webhook_url = config.get("webhook_url", "").strip()
        self.peer_state_cache = None

    def publish_event(self, event_type: str, title: str, message: str,
                      payload: Optional[Dict[str, Any]] = None, priority: int = 3) -> bool:
        if not self.webhook_url:
            return False

        # Color codes: Red for critical, Amber for warning, Blue/Green for info
        if priority >= 4 or "alert" in event_type.lower():
            color = 0xED4245 # Red
        elif priority == 3:
            color = 0xFEE75C # Amber
        else:
            color = 0x5865F2 # Blurple

        embed = {
            "title": title[:256],
            "description": message[:2048],
            "color": color,
            "footer": {
                "text": f"Claude-Duo • User: {self.user_name} • Machine: {self.machine_id}"
            },
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        }

        if payload:
            fields = []
            if "model" in payload:
                fields.append({"name": "Model", "value": str(payload["model"]), "inline": True})
            if "tokens" in payload:
                fields.append({"name": "Tokens", "value": f"{payload['tokens']:,}", "inline": True})
            if "cost_usd" in payload:
                fields.append({"name": "Est. Cost", "value": f"${payload['cost_usd']:.4f}", "inline": True})
            if "rolling_5h_pct" in payload:
                fields.append({"name": "5h Quota Used", "value": f"{payload['rolling_5h_pct']}%", "inline": True})
            if fields:
                embed["fields"] = fields[:6]

        data = {
            "username": f"Claude-Duo ({self.user_name})",
            "embeds": [embed]
        }

        body = json.dumps(data).encode("utf-8")
        req = urllib.request.Request(
            self.webhook_url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "ClaudeDuo/1.0"
            }
        )
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                return resp.status in (200, 204)
        except Exception:
            return False

    def publish_state(self, state_dict: Dict[str, Any]) -> bool:
        # Periodic state summary in Discord (every few hours or when requested)
        return False

    def fetch_peer_state(self) -> Optional[Dict[str, Any]]:
        return self.peer_state_cache

    def start_listener(self, on_message: Callable[[Dict[str, Any]], None]):
        # Discord webhooks are inbound-to-Discord only
        pass

    def stop_listener(self):
        pass
