"""
Ntfy.sh Channel implementation.
Provides zero-setup, serverless, instant internet pub/sub and push alerts.
"""

import json
import time
import urllib.request
import urllib.error
import threading
from typing import Callable, Optional, Dict, Any
from .base import BaseChannel

class NtfyChannel(BaseChannel):
    def __init__(self, config: Dict[str, Any], global_config: Dict[str, Any]):
        super().__init__(config, global_config)
        self.server = config.get("server", "https://ntfy.sh").rstrip("/")
        self.topic = config.get("topic", "").strip()
        self.listener_thread = None
        self.running = False
        self.peer_state_cache = None

    def publish_event(self, event_type: str, title: str, message: str,
                      payload: Optional[Dict[str, Any]] = None, priority: int = 3) -> bool:
        if not self.topic:
            return False

        tags = "robot"
        if "alert" in event_type.lower() or priority >= 4:
            tags = "warning,rotating_light"
        elif "ping" in event_type.lower():
            tags = "speech_balloon,bell"
        elif "quota" in event_type.lower():
            tags = "chart_with_upwards_trend,hourglass"

        envelope = {
            "type": event_type,
            "sender": self.user_name,
            "machine": self.machine_id,
            "title": title,
            "message": message,
            "payload": payload or {},
            "timestamp": time.time()
        }

        body = json.dumps(envelope).encode("utf-8")
        url = f"{self.server}/{self.topic}"
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Title": title[:200],
                "Priority": str(min(max(priority, 1), 5)),
                "Tags": tags,
                "Content-Type": "application/json"
            }
        )
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                return resp.status in (200, 201)
        except Exception as e:
            return False

    def publish_state(self, state_dict: Dict[str, Any]) -> bool:
        return self.publish_event(
            event_type="state_sync",
            title=f"Usage Sync: {self.user_name}",
            message=f"{self.user_name} active. 5h tokens: {state_dict.get('tokens_5h', 0):,}",
            payload=state_dict,
            priority=1
        )

    def fetch_peer_state(self) -> Optional[Dict[str, Any]]:
        if not self.topic:
            return self.peer_state_cache
        try:
            # Poll only recent messages (last 30 minutes, not 12 hours!)
            url = f"{self.server}/{self.topic}/json?poll=1&since=30m"
            req = urllib.request.Request(url, headers={"User-Agent": "ClaudeDuo/1.0"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                lines = resp.read().decode("utf-8").strip().split("\n")
                now = time.time()
                for line in reversed(lines):
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                        raw_msg = record.get("message", "")
                        envelope = json.loads(raw_msg) if raw_msg.startswith("{") else {}
                        sender = envelope.get("sender") or record.get("title", "")
                        machine = envelope.get("machine", "")

                        # Ignore our own messages or same machine
                        if sender.lower() == self.user_name.lower() or machine == self.machine_id:
                            continue

                        if envelope.get("type") == "state_sync":
                            sync_ts = envelope.get("timestamp", record.get("time", 0))
                            # Ignore if older than 15 minutes
                            if (now - sync_ts) > 900:
                                continue
                            self.peer_state_cache = envelope.get("payload", {})
                            self.peer_state_cache["_last_sync"] = sync_ts
                            self.peer_state_cache["_sender"] = sender
                            self.peer_state_cache["_online"] = True
                            return self.peer_state_cache
                    except Exception:
                        continue
        except Exception:
            pass
        return self.peer_state_cache

    def start_listener(self, on_message: Callable[[Dict[str, Any]], None]):
        if not self.topic or self.running:
            return
        self.running = True
        start_time = time.time()

        def _listen_worker():
            backoff = 2
            while self.running:
                try:
                    url = f"{self.server}/{self.topic}/json"
                    req = urllib.request.Request(url, headers={"User-Agent": "ClaudeDuo/1.0"})
                    with urllib.request.urlopen(req, timeout=120) as resp:
                        backoff = 2
                        for line in resp:
                            if not self.running:
                                break
                            if not line:
                                continue
                            try:
                                record = json.loads(line.decode("utf-8"))
                                if record.get("event") != "message":
                                    continue
                                raw_msg = record.get("message", "")
                                if raw_msg.startswith("{"):
                                    envelope = json.loads(raw_msg)
                                else:
                                    envelope = {
                                        "type": "custom_alert",
                                        "sender": record.get("title", "Peer"),
                                        "machine": "",
                                        "title": record.get("title", "Alert"),
                                        "message": raw_msg,
                                        "payload": {},
                                        "timestamp": record.get("time", time.time())
                                    }

                                sender = envelope.get("sender", "")
                                machine = envelope.get("machine", "")
                                msg_ts = envelope.get("timestamp", record.get("time", time.time()))

                                # STRICT FILTER 1: Ignore messages from this machine or our username
                                if sender.lower() == self.user_name.lower() or (machine and machine == self.machine_id):
                                    continue

                                # STRICT FILTER 2: Ignore historical messages sent before listener started
                                if msg_ts < (start_time - 15):
                                    continue

                                if envelope.get("type") == "state_sync":
                                    self.peer_state_cache = envelope.get("payload", {})
                                    self.peer_state_cache["_last_sync"] = msg_ts
                                    self.peer_state_cache["_sender"] = sender
                                    self.peer_state_cache["_online"] = True

                                on_message(envelope)
                            except Exception:
                                continue
                except Exception:
                    time.sleep(backoff)
                    backoff = min(backoff * 1.5, 30)

        self.listener_thread = threading.Thread(target=_listen_worker, daemon=True)
        self.listener_thread.start()

    def stop_listener(self):
        self.running = False
