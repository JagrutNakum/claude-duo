"""
Metrics engine for token counting, cost computation, and rolling windows.
Tracks local usage history and merges with peer data.
"""

import time
import json
from pathlib import Path
from typing import Dict, List, Any, Optional
from .pricing import estimate_cost

HISTORY_FILE = Path.home() / ".claude-duo" / "usage_history.json"

class UsageAggregator:
    def __init__(self, history_file: Path = HISTORY_FILE):
        self.history_file = history_file
        self.turns: List[Dict[str, Any]] = []
        self._load_history()

    def _load_history(self):
        if not self.history_file.exists():
            return
        try:
            with open(self.history_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                cutoff = time.time() - (48 * 3600) # Keep 48 hours
                self.turns = [t for t in data if t.get("timestamp", 0) > cutoff]
        except Exception:
            self.turns = []

    def save_history(self):
        try:
            self.history_file.parent.mkdir(parents=True, exist_ok=True)
            # Prune older than 48 hours
            cutoff = time.time() - (48 * 3600)
            self.turns = [t for t in self.turns if t.get("timestamp", 0) > cutoff]
            with open(self.history_file, "w", encoding="utf-8") as f:
                json.dump(self.turns, f)
        except Exception:
            pass

    def record_turn(self, model: str, input_tokens: int, output_tokens: int,
                    cache_read: int = 0, cache_write: int = 0,
                    thinking_tokens: int = 0, timestamp: Optional[float] = None,
                    session_id: str = "", auto_save: bool = True) -> Dict[str, Any]:
        ts = timestamp if timestamp is not None else time.time()
        cost = estimate_cost(model, input_tokens, output_tokens, cache_read, cache_write)
        total_tokens = input_tokens + output_tokens + cache_write

        turn = {
            "timestamp": ts,
            "model": model or "claude-sonnet-3-5",
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_tokens": cache_read,
            "cache_write_tokens": cache_write,
            "thinking_tokens": thinking_tokens,
            "total_tokens": total_tokens,
            "cost_usd": cost,
            "session_id": session_id
        }
        self.turns.append(turn)
        if auto_save:
            self.save_history()
        return turn

    def get_window_usage(self, seconds: float) -> Dict[str, Any]:
        now = time.time()
        start = now - seconds
        relevant = [t for t in self.turns if t.get("timestamp", 0) >= start]

        total_tokens = sum(t.get("total_tokens", 0) for t in relevant)
        input_tokens = sum(t.get("input_tokens", 0) for t in relevant)
        output_tokens = sum(t.get("output_tokens", 0) for t in relevant)
        cache_read = sum(t.get("cache_read_tokens", 0) for t in relevant)
        cache_write = sum(t.get("cache_write_tokens", 0) for t in relevant)
        total_cost = sum(t.get("cost_usd", 0.0) for t in relevant)
        count = len(relevant)

        return {
            "turn_count": count,
            "total_tokens": total_tokens,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_tokens": cache_read,
            "cache_write_tokens": cache_write,
            "total_cost_usd": round(total_cost, 4),
            "last_active": max([t.get("timestamp", 0) for t in relevant], default=0)
        }

    def get_5h_usage(self) -> Dict[str, Any]:
        return self.get_window_usage(5 * 3600)

    def get_15m_usage(self) -> Dict[str, Any]:
        return self.get_window_usage(15 * 60)

    def get_today_usage(self) -> Dict[str, Any]:
        # Seconds since local midnight
        lt = time.localtime()
        midnight = time.time() - (lt.tm_hour * 3600 + lt.tm_min * 60 + lt.tm_sec)
        return self.get_window_usage(time.time() - midnight)

    def get_local_summary(self) -> Dict[str, Any]:
        h5 = self.get_5h_usage()
        today = self.get_today_usage()
        m15 = self.get_15m_usage()
        last_turn = self.turns[-1] if self.turns else {}

        return {
            "tokens_5h": h5["total_tokens"],
            "turns_5h": h5["turn_count"],
            "cost_5h": h5["total_cost_usd"],
            "tokens_today": today["total_tokens"],
            "cost_today": today["total_cost_usd"],
            "turns_today": today["turn_count"],
            "tokens_15m": m15["total_tokens"],
            "last_active_ts": last_turn.get("timestamp", 0),
            "last_model": last_turn.get("model", "None")
        }

def compute_combined_split(local_name: str, local_summary: Dict[str, Any],
                           peer_name: str, peer_summary: Optional[Dict[str, Any]],
                           rolling_limit_tokens: int = 600000) -> Dict[str, Any]:
    peer = peer_summary or {}
    local_5h = local_summary.get("tokens_5h", 0)
    peer_5h = peer.get("tokens_5h", 0)
    combined_5h = local_5h + peer_5h

    local_cost_today = local_summary.get("cost_today", 0.0)
    peer_cost_today = peer.get("cost_today", 0.0)
    combined_cost_today = local_cost_today + peer_cost_today

    local_share_5h = round((local_5h / combined_5h * 100), 1) if combined_5h > 0 else 0.0
    peer_share_5h = round((peer_5h / combined_5h * 100), 1) if combined_5h > 0 else 0.0

    quota_5h_pct = round((combined_5h / rolling_limit_tokens * 100), 1) if rolling_limit_tokens > 0 else 0.0

    # Check if peer has actually connected / joined in the last 15 minutes
    now = time.time()
    peer_sync_ts = peer.get("_last_sync", 0)
    peer_joined = bool(peer) and (now - peer_sync_ts) < 900 and peer.get("_online", False)

    local_active = (now - local_summary.get("last_active_ts", 0)) < 300
    peer_last_active = peer.get("last_active_ts", 0)
    peer_active = peer_joined and (now - peer_last_active) < 300 and peer_last_active > 0
    is_concurrent = local_active and peer_active

    return {
        "peer_joined": peer_joined,
        "combined_5h_tokens": combined_5h,
        "combined_5h_quota_pct": quota_5h_pct,
        "combined_cost_today": round(combined_cost_today, 4),
        "is_concurrent": is_concurrent,
        "local": {
            "name": local_name,
            "tokens_5h": local_5h,
            "share_5h_pct": local_share_5h,
            "cost_today": local_cost_today,
            "tokens_today": local_summary.get("tokens_today", 0),
            "is_active": local_active,
            "last_model": local_summary.get("last_model")
        },
        "peer": {
            "name": peer_name,
            "tokens_5h": peer_5h,
            "share_5h_pct": peer_share_5h,
            "cost_today": peer_cost_today,
            "tokens_today": peer.get("tokens_today", 0),
            "is_active": peer_active,
            "last_model": peer.get("last_model")
        }
    }
