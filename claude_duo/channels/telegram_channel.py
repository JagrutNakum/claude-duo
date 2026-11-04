"""
Telegram Bot Channel implementation.
Sends formatted alerts to a Telegram chat or group.
"""

import json
import time
import urllib.request
import urllib.parse
from typing import Callable, Optional, Dict, Any
from .base import BaseChannel

class TelegramChannel(BaseChannel):
    def __init__(self, config: Dict[str, Any], global_config: Dict[str, Any]):
        super().__init__(config, global_config)
        self.bot_token = config.get("bot_token", "").strip()
        self.chat_id = str(config.get("chat_id", "")).strip()

    def publish_event(self, event_type: str, title: str, message: str,
                      payload: Optional[Dict[str, Any]] = None, priority: int = 3) -> bool:
        if not self.bot_token or not self.chat_id:
            return False

        icon = "🤖"
        if priority >= 4 or "alert" in event_type.lower():
            icon = "🚨"
        elif priority == 3:
            icon = "⚠️"

        text = f"{icon} *{title}*\n\n{message}\n\n_User: {self.user_name} | Machine: {self.machine_id}_"
        if payload:
            text += "\n"
            if "model" in payload:
                text += f"• *Model:* `{payload['model']}`\n"
            if "tokens" in payload:
                text += f"• *Tokens:* `{payload['tokens']:,}`\n"
            if "cost_usd" in payload:
                text += f"• *Cost:* `${payload['cost_usd']:.4f}`\n"

        url = f"https://api.telegram.org/bot{self.bot_token}/sendMessage"
        data = urllib.parse.urlencode({
            "chat_id": self.chat_id,
            "text": text,
            "parse_mode": "Markdown"
        }).encode("utf-8")

        req = urllib.request.Request(url, data=data)
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                return resp.status == 200
        except Exception:
            return False

    def publish_state(self, state_dict: Dict[str, Any]) -> bool:
        return False

    def fetch_peer_state(self) -> Optional[Dict[str, Any]]:
        return None

    def start_listener(self, on_message: Callable[[Dict[str, Any]], None]):
        pass

    def stop_listener(self):
        pass
