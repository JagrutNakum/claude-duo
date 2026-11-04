"""
Configuration manager for Claude-Duo.
Manages user aliases, shared internet channel settings, thresholds, and paths.
"""

import os
import json
import socket
import secrets
from pathlib import Path

DEFAULT_CONFIG_DIR = Path.home() / ".claude-duo"
DEFAULT_CONFIG_FILE = DEFAULT_CONFIG_DIR / "config.json"

DEFAULT_SETTINGS = {
    "user_name": "",
    "peer_name": "Teammate",
    "machine_id": socket.gethostname(),
    "channel": "ntfy",
    "channels_config": {
        "ntfy": {
            "topic": "",
            "server": "https://ntfy.sh"
        },
        "discord": {
            "webhook_url": ""
        },
        "telegram": {
            "bot_token": "",
            "chat_id": ""
        },
        "upstash": {
            "url": "",
            "token": ""
        },
        "webhook": {
            "url": "",
            "auth_header": ""
        }
    },
    "thresholds": {
        "single_turn_tokens": 250000,
        "velocity_15m_tokens": 500000,
        "rolling_5h_warn_pct": 80,
        "rolling_5h_limit_tokens": 15000000,
        "concurrent_window_minutes": 5,
        "enable_desktop_notifications": True,
        "enable_sound_bell": True
    },
    "claude_projects_dir": str(Path.home() / ".claude" / "projects"),
    "heartbeat_interval_sec": 60,
    "state_sync_interval_sec": 30
}

def generate_secret_topic() -> str:
    return f"claude-duo-{secrets.token_hex(6)}"

def load_config(config_path: Path = DEFAULT_CONFIG_FILE) -> dict:
    if not config_path.exists():
        return init_default_config(config_path)
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        merged = dict(DEFAULT_SETTINGS)
        merged.update(data)
        if "channels_config" in data:
            for k, v in data["channels_config"].items():
                if k in merged["channels_config"]:
                    merged["channels_config"][k].update(v)
                else:
                    merged["channels_config"][k] = v
        if "thresholds" in data:
            merged["thresholds"].update(data["thresholds"])
        return merged
    except Exception as e:
        print(f"[!] Warning: Failed to parse {config_path}: {e}. Using defaults.")
        return dict(DEFAULT_SETTINGS)

def save_config(cfg: dict, config_path: Path = DEFAULT_CONFIG_FILE):
    config_path.parent.mkdir(parents=True, exist_ok=True)
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)

def init_default_config(config_path: Path = DEFAULT_CONFIG_FILE) -> dict:
    cfg = dict(DEFAULT_SETTINGS)
    cfg["channels_config"]["ntfy"]["topic"] = generate_secret_topic()
    if not cfg["user_name"]:
        cfg["user_name"] = os.environ.get("USERNAME") or os.environ.get("USER") or "User"
    save_config(cfg, config_path)
    return cfg
