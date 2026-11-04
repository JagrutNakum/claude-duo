"""
Alert & Rule Engine for Claude-Duo.
Detects heavy single turns, velocity spikes, 5h quota limits, and concurrency.
"""

import time
from typing import Dict, Any, Optional, Callable

class AlertEngine:
    def __init__(self, config: Dict[str, Any], trigger_callback: Callable[[str, str, str, Dict[str, Any], int], None]):
        self.config = config
        self.thresholds = config.get("thresholds", {})
        self.trigger = trigger_callback # callback(event_type, title, message, payload, priority)

        # Debounce state timestamps
        self.last_velocity_alert_ts = 0
        self.last_concurrency_alert_ts = 0
        self.last_quota_warn_level = 0 # 0, 75, 90

    def evaluate_turn(self, turn: Dict[str, Any], user_name: str):
        total_tok = turn.get("total_tokens", 0)
        out_tok = turn.get("output_tokens", 0)
        cache_write = turn.get("cache_write_tokens", 0)
        input_tok = turn.get("input_tokens", 0)
        model = turn.get("model", "Claude")
        cost = turn.get("cost_usd", 0.0)

        # A turn is ONLY concerning if:
        # 1. Output generation is massive (> 3500 tokens)
        # 2. Or dollar cost is high (> $1.00 in a single turn)
        # 3. Or fresh context creation is massive (> 80,000 tokens)
        is_heavy_generation = out_tok >= 3500
        is_expensive = cost >= 1.00
        is_massive_context = (input_tok + cache_write) >= 80000

        if is_heavy_generation or is_expensive or is_massive_context:
            title = f"Heavy Usage Turn: {user_name}"
            msg = (
                f"{user_name} ran a heavy turn ({total_tok:,} tokens, ${cost:.4f}) "
                f"using {model} (out: {out_tok:,} tok)."
            )
            payload = {
                "tokens": total_tok,
                "output_tokens": out_tok,
                "cost_usd": cost,
                "model": model,
                "user": user_name
            }
            self.trigger("high_single_turn", title, msg, payload, 4)

    def evaluate_velocity(self, tokens_15m: int, user_name: str):
        now = time.time()
        velocity_threshold = self.thresholds.get("velocity_15m_tokens", 500000)

        if tokens_15m >= velocity_threshold and (now - self.last_velocity_alert_ts) > 1200:
            self.last_velocity_alert_ts = now
            title = f"Heavy Velocity Spike: {user_name}"
            msg = f"{user_name} consumed {tokens_15m:,} tokens in the last 15 minutes! Pacing advised."
            payload = {"tokens_15m": tokens_15m, "user": user_name}
            self.trigger("velocity_spike", title, msg, payload, 4)

    def evaluate_combined(self, split_info: Dict[str, Any]):
        now = time.time()
        peer_joined = split_info.get("peer_joined", False)

        # DO NOT fire shared quota or concurrency alerts if peer hasn't even joined!
        if not peer_joined:
            return

        quota_pct = split_info.get("combined_5h_quota_pct", 0.0)
        warn_pct = self.thresholds.get("rolling_5h_warn_pct", 80)

        # 2. Rolling 5-hour limit warnings (only if both users are sharing)
        if quota_pct >= 90 and self.last_quota_warn_level < 90:
            self.last_quota_warn_level = 90
            local_user = split_info["local"]["name"]
            peer_user = split_info["peer"]["name"]
            msg = (
                f"🚨 Shared Claude 5h limit is at {quota_pct}%! "
                f"{local_user}: {split_info['local']['share_5h_pct']}% | "
                f"{peer_user}: {split_info['peer']['share_5h_pct']}%. "
                f"Lockout imminent!"
            )
            self.trigger("quota_critical", "5h Rolling Limit Critical (90%)", msg, split_info, 5)

        elif quota_pct >= warn_pct and self.last_quota_warn_level < warn_pct:
            self.last_quota_warn_level = warn_pct
            local_user = split_info["local"]["name"]
            peer_user = split_info["peer"]["name"]
            msg = (
                f"Shared Claude 5-hour limit reached {quota_pct}%. "
                f"{local_user}: {split_info['local']['share_5h_pct']}% | "
                f"{peer_user}: {split_info['peer']['share_5h_pct']}%."
            )
            self.trigger("quota_warning", f"5h Limit Warning ({quota_pct}%)", msg, split_info, 3)

        elif quota_pct < (warn_pct - 10):
            # Reset warning levels when usage cools down
            self.last_quota_warn_level = 0

        # 3. Concurrency warning (only if both are actively running prompts right now)
        if split_info.get("is_concurrent"):
            if (now - self.last_concurrency_alert_ts) > 900:
                self.last_concurrency_alert_ts = now
                title = "Concurrent Claude Activity"
                msg = (
                    f"Both {split_info['local']['name']} and {split_info['peer']['name']} "
                    f"are actively querying Claude simultaneously. Limits deplete twice as fast."
                )
                self.trigger("concurrency_alert", title, msg, split_info, 3)
