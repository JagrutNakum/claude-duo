"""
Command-Line Interface for Claude-Duo.
Commands: init, start, status, ping, test-alert, proxy.
"""

import sys
import os
import time
import argparse
from pathlib import Path
from datetime import datetime

from .config import load_config, save_config, generate_secret_topic, DEFAULT_CONFIG_FILE
from .metrics import UsageAggregator, compute_combined_split
from .watcher import ClaudeLogWatcher
from .alert_engine import AlertEngine
from .notifier import notify_desktop
from .channels import get_channel
from .proxy import run_proxy

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Terminal formatting helpers
BOLD = "\033[1m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
CYAN = "\033[36m"
MAGENTA = "\033[35m"
RESET = "\033[0m"
DIM = "\033[2m"

def render_meter(pct: float, width: int = 24) -> str:
    filled = int((min(pct, 100.0) / 100.0) * width)
    empty = width - filled
    color = GREEN if pct < 70 else (YELLOW if pct < 88 else RED)
    bar = "=" * filled + "-" * empty
    return f"{color}[{bar}] {pct:.1f}%{RESET}"

def format_relative_time(epoch_ts: float) -> str:
    if not epoch_ts:
        return "Never"
    diff = time.time() - epoch_ts
    if diff < 60:
        return f"{int(diff)}s ago"
    elif diff < 3600:
        return f"{int(diff // 60)}m ago"
    elif diff < 86400:
        return f"{int(diff // 3600)}h ago"
    else:
        return f"{int(diff // 86400)}d ago"

def cmd_init():
    print(f"\n{BOLD}{CYAN}=== Claude-Duo Setup Wizard ==={RESET}")
    print("Track shared Claude usage between two machines & get alerted on spikes.\n")

    cfg = load_config()

    user_default = cfg.get("user_name") or os.environ.get("USERNAME") or "User1"
    user_input = input(f"Enter YOUR alias/name [{user_default}]: ").strip()
    cfg["user_name"] = user_input if user_input else user_default

    peer_default = cfg.get("peer_name") or "Teammate"
    peer_input = input(f"Enter YOUR COLLEAGUE'S alias/name [{peer_default}]: ").strip()
    cfg["peer_name"] = peer_input if peer_input else peer_default

    print(f"\nSelect Internet Sync Channel:")
    print("  1. ntfy.sh (Recommended - Zero account/setup, instant push & phone alerts)")
    print("  2. Discord (Paste a Discord Webhook URL)")
    print("  3. Telegram (Bot Token & Chat ID)")
    print("  4. Upstash Redis (Serverless cloud DB for live bidirectional stats)")
    print("  5. Custom HTTP Webhook / Cloudflare Relay")

    choice = input("Choice [1-5, default 1]: ").strip()

    if choice == "2":
        cfg["channel"] = "discord"
        current_url = cfg["channels_config"]["discord"].get("webhook_url", "")
        url = input(f"Discord Webhook URL [{current_url}]: ").strip()
        if url:
            cfg["channels_config"]["discord"]["webhook_url"] = url
    elif choice == "3":
        cfg["channel"] = "telegram"
        token = input("Telegram Bot Token: ").strip()
        chat_id = input("Telegram Chat ID: ").strip()
        if token:
            cfg["channels_config"]["telegram"]["bot_token"] = token
        if chat_id:
            cfg["channels_config"]["telegram"]["chat_id"] = chat_id
    elif choice == "4":
        cfg["channel"] = "upstash"
        url = input("Upstash REST URL (https://...upstash.io): ").strip()
        token = input("Upstash REST Token: ").strip()
        if url:
            cfg["channels_config"]["upstash"]["url"] = url
        if token:
            cfg["channels_config"]["upstash"]["token"] = token
    elif choice == "5":
        cfg["channel"] = "webhook"
        url = input("Webhook URL: ").strip()
        if url:
            cfg["channels_config"]["webhook"]["url"] = url
    else:
        cfg["channel"] = "ntfy"
        topic = cfg["channels_config"]["ntfy"].get("topic") or generate_secret_topic()
        print(f"\nUsing secret ntfy topic: {BOLD}{topic}{RESET}")
        custom_topic = input(f"Keep this topic or enter shared topic [{topic}]: ").strip()
        if custom_topic:
            topic = custom_topic
        cfg["channels_config"]["ntfy"]["topic"] = topic

    save_config(cfg)
    print(f"\n{GREEN}✓ Configuration saved to {DEFAULT_CONFIG_FILE}{RESET}")
    print(f"\n{BOLD}NEXT STEP FOR YOUR COLLEAGUE ({cfg['peer_name']}):{RESET}")
    print(f"1. Install Claude-Duo on their machine.")
    if cfg["channel"] == "ntfy":
        print(f"2. Run `claude-duo init` and enter topic: {BOLD}{cfg['channels_config']['ntfy']['topic']}{RESET}")
    print(f"3. Both run: {BOLD}claude-duo start{RESET} to begin tracking!\n")

def cmd_status():
    cfg = load_config()
    aggregator = UsageAggregator()
    channel = get_channel(cfg)

    # Trigger a quick scan to capture any fresh turns
    watcher = ClaudeLogWatcher(cfg["claude_projects_dir"], aggregator)
    watcher.scan_once()

    local_name = cfg.get("user_name", "You")
    peer_name = cfg.get("peer_name", "Teammate")
    local_summary = aggregator.get_local_summary()

    print(f"\n{CYAN}Fetching peer state over internet ({cfg.get('channel')})...{RESET}")
    peer_summary = channel.fetch_peer_state()

    split = compute_combined_split(
        local_name=local_name,
        local_summary=local_summary,
        peer_name=peer_name,
        peer_summary=peer_summary,
        rolling_limit_tokens=cfg.get("thresholds", {}).get("rolling_5h_limit_tokens", 600000)
    )

    print("\n" + "=" * 65)
    print(f"{BOLD}{MAGENTA}             CLAUDE-DUO USAGE & ATTRIBUTION DASHBOARD{RESET}")
    print("=" * 65)

    quota_pct = split["combined_5h_quota_pct"]
    meter = render_meter(quota_pct, width=28)
    print(f"\n{BOLD}Rolling 5-Hour Shared Quota:{RESET}")
    print(f"  {meter}  ({split['combined_5h_tokens']:,} / {cfg.get('thresholds', {}).get('rolling_5h_limit_tokens', 600000):,} tokens)")

    if split["is_concurrent"]:
        print(f"\n  {RED}{BOLD}⚡ CAUTION: Both {local_name} and {peer_name} are active right now!{RESET}")

    col1_w = 22
    col2_w = 20
    col3_w = 20

    print("\n" + "-" * 67)
    header_local = (local_name + " (You)")[:col2_w]
    header_peer = peer_name[:col3_w]
    print(f"{BOLD}{'METRIC':<{col1_w}} | {header_local:<{col2_w}} | {header_peer:<{col3_w}}{RESET}")
    print("-" * 67)

    local_active_str = "Active" if split['local']['is_active'] else "Idle"
    peer_active_str = "Active" if split['peer']['is_active'] else "Idle"
    print(f"{'Status':<{col1_w}} | {local_active_str:<{col2_w}} | {peer_active_str:<{col3_w}}")

    local_time_str = format_relative_time(local_summary["last_active_ts"])
    peer_time_str = format_relative_time(peer_summary.get("last_active_ts", 0)) if peer_summary else "No data"
    print(f"{'Last Activity':<{col1_w}} | {local_time_str:<{col2_w}} | {peer_time_str:<{col3_w}}")

    local_5h_str = f"{local_summary['tokens_5h']:,} ({split['local']['share_5h_pct']}%)"
    peer_5h_str = f"{split['peer']['tokens_5h']:,} ({split['peer']['share_5h_pct']}%)"
    print(f"{'Rolling 5h Tokens':<{col1_w}} | {local_5h_str:<{col2_w}} | {peer_5h_str:<{col3_w}}")

    print(f"{'5h Turns':<{col1_w}} | {str(local_summary['turns_5h']):<{col2_w}} | {str(peer_summary.get('turns_5h', 0) if peer_summary else 0):<{col3_w}}")

    local_today_tok = f"{local_summary['tokens_today']:,}"
    peer_today_tok = f"{split['peer']['tokens_today']:,}"
    print(f"{'Today Tokens':<{col1_w}} | {local_today_tok:<{col2_w}} | {peer_today_tok:<{col3_w}}")

    local_today_cost = f"${local_summary['cost_today']:.4f}"
    peer_today_cost = f"${split['peer']['cost_today']:.4f}"
    print(f"{'Today Est. Cost':<{col1_w}} | {local_today_cost:<{col2_w}} | {peer_today_cost:<{col3_w}}")

    local_model = str(local_summary.get('last_model', 'None'))[:col2_w]
    peer_model = str(peer_summary.get('last_model', 'None') if peer_summary else 'None')[:col3_w]
    print(f"{'Recent Model':<{col1_w}} | {local_model:<{col2_w}} | {peer_model:<{col3_w}}")
    print("-" * 67)

    print(f"\n{BOLD}Combined Today's Est. Cost:{RESET} ${split['combined_cost_today']:.4f}")
    ch_info = cfg.get("channel", "ntfy")
    if ch_info == "ntfy":
        ch_detail = f"ntfy.sh topic: {cfg['channels_config']['ntfy']['topic']}"
    else:
        ch_detail = ch_info
    print(f"{DIM}Channel: {ch_detail}{RESET}\n")

def cmd_start():
    cfg = load_config()
    user_name = cfg.get("user_name", "User")
    peer_name = cfg.get("peer_name", "Teammate")
    aggregator = UsageAggregator()
    channel = get_channel(cfg)

    print(f"\n{BOLD}{GREEN}✓ Claude-Duo Daemon Started{RESET}")
    print(f"  User: {BOLD}{user_name}{RESET} | Colleague: {BOLD}{peer_name}{RESET}")
    print(f"  Channel: {BOLD}{cfg.get('channel')}{RESET}")
    print(f"  Monitoring: {cfg['claude_projects_dir']}")
    print(f"  Desktop Notifications: {'Enabled' if cfg['thresholds'].get('enable_desktop_notifications') else 'Disabled'}")
    print(f"\n{DIM}Listening for Claude activity & peer alerts... Press Ctrl+C to stop.{RESET}\n")

    def handle_peer_message(envelope: dict):
        ev_type = envelope.get("type", "")
        sender = envelope.get("sender", peer_name)
        title = envelope.get("title", "Claude-Duo Alert")
        msg = envelope.get("message", "")

        if ev_type == "state_sync":
            return # Silent sync

        print(f"\n{YELLOW}[INCOMING FROM {sender.upper()}]{RESET} {BOLD}{title}{RESET}: {msg}")

        if cfg["thresholds"].get("enable_desktop_notifications", True):
            notify_desktop(
                title=f"Claude-Duo ({sender})",
                message=msg,
                sound=cfg["thresholds"].get("enable_sound_bell", True)
            )

    channel.start_listener(handle_peer_message)

    def trigger_alert(ev_type: str, title: str, msg: str, payload: dict, priority: int):
        print(f"\n{RED}[LOCAL ALERT TRIGGERED]{RESET} {BOLD}{title}{RESET}: {msg}")
        # Publish to Internet Channel so teammate is alerted
        channel.publish_event(ev_type, title, msg, payload, priority)

    alert_engine = AlertEngine(cfg, trigger_alert)

    def on_new_turn(turn: dict):
        total = turn.get("total_tokens", 0)
        model = turn.get("model", "Claude")
        cost = turn.get("cost_usd", 0.0)
        print(f"{CYAN}[TURN RECORDED]{RESET} {model}: {total:,} tokens (${cost:.4f})")

        # Evaluate turn rules
        alert_engine.evaluate_turn(turn, user_name)

        # Check 15m velocity
        m15 = aggregator.get_15m_usage()
        alert_engine.evaluate_velocity(m15["total_tokens"], user_name)

        # Sync state immediately after turn
        channel.publish_state(aggregator.get_local_summary())

    watcher = ClaudeLogWatcher(cfg["claude_projects_dir"], aggregator, on_new_turn=on_new_turn)
    watcher.start()

    # Initial state sync
    channel.publish_state(aggregator.get_local_summary())

    last_sync = time.time()
    last_quota_eval = time.time()

    try:
        while True:
            time.sleep(2)
            now = time.time()

            # Periodic state sync (every 30s)
            if (now - last_sync) >= cfg.get("state_sync_interval_sec", 30):
                channel.publish_state(aggregator.get_local_summary())
                last_sync = now

            # Periodic quota and concurrency evaluation (every 60s)
            if (now - last_quota_eval) >= 60:
                peer_state = channel.fetch_peer_state()
                split = compute_combined_split(
                    local_name=user_name,
                    local_summary=aggregator.get_local_summary(),
                    peer_name=peer_name,
                    peer_summary=peer_state,
                    rolling_limit_tokens=cfg.get("thresholds", {}).get("rolling_5h_limit_tokens", 600000)
                )
                alert_engine.evaluate_combined(split)
                last_quota_eval = now

    except KeyboardInterrupt:
        print(f"\n{YELLOW}Stopping Claude-Duo...{RESET}")
        watcher.stop()
        channel.stop_listener()
        print(f"{GREEN}Claude-Duo stopped safely.{RESET}")

def cmd_ping(args):
    cfg = load_config()
    user_name = cfg.get("user_name", "User")
    peer_name = cfg.get("peer_name", "Teammate")
    channel = get_channel(cfg)

    message = " ".join(args.message) if args.message else "Ping! Are you using Claude right now?"
    title = f"Ping from {user_name}"

    print(f"Sending ping to {peer_name} over {cfg.get('channel')}...")
    ok = channel.publish_event("manual_ping", title, message, {"user": user_name}, priority=4)
    if ok:
        print(f"{GREEN}✓ Ping delivered successfully!{RESET}")
    else:
        print(f"{RED}✗ Failed to deliver ping. Check network or channel configuration.{RESET}")

def cmd_test_alert():
    cfg = load_config()
    user_name = cfg.get("user_name", "User")
    channel = get_channel(cfg)

    title = f"Test High Usage Alert ({user_name})"
    msg = f"Simulated test alert: {user_name} burned 48,200 tokens ($0.72) on Opus-5."
    payload = {"tokens": 48200, "cost_usd": 0.72, "model": "claude-opus-5", "user": user_name}

    print("\n1. Testing local desktop notification...")
    notify_desktop("Claude-Duo Test", msg, sound=True)

    print(f"2. Publishing test alert to internet channel ({cfg.get('channel')})...")
    ok = channel.publish_event("test_alert", title, msg, payload, priority=4)
    if ok:
        print(f"{GREEN}✓ Test alert sent successfully over the internet!{RESET}\n")
    else:
        print(f"{RED}✗ Failed to send to internet channel.{RESET}\n")

def main():
    parser = argparse.ArgumentParser(
        prog="claude-duo",
        description="Shared Claude Account Usage Tracker & Alert System for Pairs."
    )
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("app", help="Launch the Desktop GUI application")
    subparsers.add_parser("init", help="Run interactive setup wizard")
    subparsers.add_parser("start", help="Start background monitoring daemon")
    subparsers.add_parser("status", help="View live usage and quota attribution dashboard")
    subparsers.add_parser("test-alert", help="Send a test notification & internet alert")
    subparsers.add_parser("simulate", help="Run interactive simulator to test as teammate locally")

    ping_p = subparsers.add_parser("ping", help="Send a ping message to your colleague")
    ping_p.add_argument("message", nargs="*", help="Optional message text")

    proxy_p = subparsers.add_parser("proxy", help="Run local Anthropic API proxy")
    proxy_p.add_argument("--port", type=int, default=8080, help="Proxy port (default: 8080)")

    args = parser.parse_args()

    if args.command == "app":
        from .desktop_launcher import launch_desktop
        launch_desktop()
    elif args.command == "init":
        cmd_init()
    elif args.command == "start":
        cmd_start()
    elif args.command == "status":
        cmd_status()
    elif args.command == "ping":
        cmd_ping(args)
    elif args.command == "test-alert":
        cmd_test_alert()
    elif args.command == "simulate":
        import subprocess
        sim_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "simulate_peer.py")
        subprocess.run([sys.executable, sim_path])
    elif args.command == "proxy":
        cfg = load_config()
        aggregator = UsageAggregator()
        print(f"{GREEN}Starting Claude API Proxy on http://127.0.0.1:{args.port}{RESET}")
        print(f"Set environment: ANTHROPIC_BASE_URL=http://127.0.0.1:{args.port}")
        run_proxy(args.port, aggregator)
    else:
        # Default: if no command given, launch desktop app!
        from .desktop_launcher import launch_desktop
        launch_desktop()

if __name__ == "__main__":
    main()
