"""
Flask Web Dashboard & API backend for Claude-Duo Desktop App.
"""

import time
import threading
from pathlib import Path
from flask import Flask, render_template, jsonify, request

from .config import load_config, save_config
from .metrics import UsageAggregator, compute_combined_split
from .watcher import ClaudeLogWatcher
from .alert_engine import AlertEngine
from .notifier import notify_desktop
from .channels import get_channel

template_folder = str(Path(__file__).parent / "templates")
app = Flask(__name__, template_folder=template_folder)

# In-memory shared state
cfg = load_config()
aggregator = UsageAggregator()
channel = get_channel(cfg)
RECENT_EVENTS = []
EVENT_LOCK = threading.Lock()

def record_event(title: str, message: str, ev_type: str = "info"):
    with EVENT_LOCK:
        RECENT_EVENTS.append({
            "title": title,
            "message": message,
            "type": ev_type,
            "timestamp": time.time()
        })
        if len(RECENT_EVENTS) > 30:
            RECENT_EVENTS.pop(0)

# Peer Message Handler
def on_peer_message(envelope: dict):
    ev_type = envelope.get("type", "")
    sender = envelope.get("sender", cfg.get("peer_name", "Teammate"))
    title = envelope.get("title", "Alert")
    msg = envelope.get("message", "")

    if ev_type == "state_sync":
        return

    record_event(f"[{sender}] {title}", msg, ev_type)

    if cfg.get("thresholds", {}).get("enable_desktop_notifications", True):
        notify_desktop(f"Claude-Duo ({sender})", msg, cfg.get("thresholds", {}).get("enable_sound_bell", True))

channel.start_listener(on_peer_message)

# Alert Trigger Handler
def on_local_alert(ev_type: str, title: str, msg: str, payload: dict, priority: int):
    record_event(title, msg, ev_type)
    # Broadcast to internet channel so PEER gets notified on their Windows screen.
    # Do NOT notify local desktop for local user's own actions.
    channel.publish_event(ev_type, title, msg, payload, priority)

alert_engine = AlertEngine(cfg, on_local_alert)

# New Turn Handler
def on_new_turn(turn: dict):
    model = turn.get("model", "Claude")
    tot = turn.get("total_tokens", 0)
    cost = turn.get("cost_usd", 0.0)
    record_event(f"Local Turn ({model})", f"Consumed {tot:,} tokens (${cost:.4f})", "turn")

    alert_engine.evaluate_turn(turn, cfg.get("user_name", "User"))
    m15 = aggregator.get_15m_usage()
    alert_engine.evaluate_velocity(m15["total_tokens"], cfg.get("user_name", "User"))
    channel.publish_state(aggregator.get_local_summary())

# Start Watcher
watcher = ClaudeLogWatcher(cfg["claude_projects_dir"], aggregator, on_new_turn=on_new_turn)
watcher.start()

# Background Sync Thread
def background_sync_worker():
    last_sync = 0
    last_quota_eval = 0
    while True:
        try:
            now = time.time()
            if (now - last_sync) >= cfg.get("state_sync_interval_sec", 30):
                channel.publish_state(aggregator.get_local_summary())
                last_sync = now

            if (now - last_quota_eval) >= 60:
                peer_state = channel.fetch_peer_state()
                split = compute_combined_split(
                    local_name=cfg.get("user_name", "User"),
                    local_summary=aggregator.get_local_summary(),
                    peer_name=cfg.get("peer_name", "Teammate"),
                    peer_summary=peer_state,
                    rolling_limit_tokens=cfg.get("thresholds", {}).get("rolling_5h_limit_tokens", 600000)
                )
                alert_engine.evaluate_combined(split)
                last_quota_eval = now
        except Exception:
            pass
        time.sleep(5)

sync_thread = threading.Thread(target=background_sync_worker, daemon=True)
sync_thread.start()

# Routes
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/status")
def get_status():
    local_summary = aggregator.get_local_summary()
    peer_summary = channel.fetch_peer_state()
    limit_tokens = cfg.get("thresholds", {}).get("rolling_5h_limit_tokens", 600000)

    split = compute_combined_split(
        local_name=cfg.get("user_name", "You"),
        local_summary=local_summary,
        peer_name=cfg.get("peer_name", "Teammate"),
        peer_summary=peer_summary,
        rolling_limit_tokens=limit_tokens
    )

    with EVENT_LOCK:
        events = list(RECENT_EVENTS)

    topic = cfg.get("channels_config", {}).get("ntfy", {}).get("topic", "")

    return jsonify({
        "split": split,
        "local_summary": local_summary,
        "peer_summary": peer_summary,
        "limit_tokens": limit_tokens,
        "events": events,
        "channel_topic": topic
    })

@app.route("/api/ping", methods=["POST"])
def send_ping():
    data = request.get_json() or {}
    msg = data.get("message") or "Ping!"
    user = cfg.get("user_name", "User")
    peer = cfg.get("peer_name", "Teammate")

    title = f"Ping from {user}"
    ok = channel.publish_event("manual_ping", title, msg, {"user": user}, priority=4)
    record_event(f"Sent Ping to {peer}", msg, "ping")
    return jsonify({"success": ok})

@app.route("/api/test-alert", methods=["POST"])
def send_test_alert():
    user = cfg.get("user_name", "User")
    msg = f"Simulated test alert: {user} ran a 45,000 token turn."
    notify_desktop("Claude-Duo Test", msg, sound=True)
    channel.publish_event("test_alert", f"Test Alert ({user})", msg, priority=4)
    record_event(f"Test Alert Triggered", msg, "test")
    return jsonify({"success": True})

@app.route("/api/config", methods=["GET", "POST"])
def handle_config():
    global cfg, channel, watcher, alert_engine
    if request.method == "POST":
        data = request.get_json() or {}
        if "user_name" in data and data["user_name"]:
            cfg["user_name"] = data["user_name"]
        if "peer_name" in data and data["peer_name"]:
            cfg["peer_name"] = data["peer_name"]
        if "topic" in data and data["topic"]:
            cfg["channels_config"]["ntfy"]["topic"] = data["topic"]

        save_config(cfg)

        # Re-initialize channel with updated credentials
        channel.stop_listener()
        channel = get_channel(cfg)
        channel.start_listener(on_peer_message)
        alert_engine = AlertEngine(cfg, on_local_alert)

        record_event("Settings Updated", f"User: {cfg['user_name']}, Topic: {cfg['channels_config']['ntfy']['topic']}", "config")
        return jsonify({"success": True, "config": cfg})

    return jsonify(cfg)

@app.route("/api/shutdown", methods=["POST"])
def shutdown_server():
    def _kill():
        time.sleep(0.5)
        import os
        os._exit(0)
    threading.Thread(target=_kill, daemon=True).start()
    return jsonify({"success": True, "message": "Server shutting down"})

def run_app(port: int = 5242):
    import logging
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)
