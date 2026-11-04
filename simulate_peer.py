"""
Simulate your teammate locally on this PC.
Tests pings, high usage alerts, concurrency, and live dashboard sync without needing a second PC.
"""

import time
import sys

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from claude_duo.config import load_config
from claude_duo.channels import get_channel

def get_simulated_peer():
    cfg = load_config()
    peer_name = cfg.get("peer_name", "Teammate")
    local_name = cfg.get("user_name", "You")

    peer_cfg = dict(cfg)
    peer_cfg["user_name"] = peer_name
    peer_cfg["machine_id"] = f"{peer_name.lower()}-remote-pc-sim"

    channel = get_channel(peer_cfg)
    return cfg, peer_name, local_name, channel

def send_sim_ping(channel, peer_name, local_name, msg=None):
    if msg is None:
        msg = f"Hey! Testing desktop notification from {peer_name}."
    print(f"\n[>] Sending test ping from {peer_name} to {local_name}...")
    title = f"Ping from {peer_name}"
    ok = channel.publish_event("manual_ping", title, msg, {"user": peer_name}, priority=4)
    if ok:
        print("[OK] Ping sent! Look at the bottom-right corner of your screen for the Windows notification.")
    else:
        print("[!] Failed to send ping.")

def send_sim_heartbeat(channel, peer_name, tokens_5h=450000, cost=5.80):
    print(f"\n[>] Sending heartbeat from {peer_name} (making his card ACTIVE on your dashboard)...")
    state = {
        "tokens_5h": tokens_5h,
        "turns_5h": 28,
        "cost_5h": cost,
        "tokens_today": tokens_5h + 120000,
        "cost_today": cost + 1.40,
        "turns_today": 35,
        "tokens_15m": 35000,
        "last_active_ts": time.time(),
        "last_model": "claude-3-5-sonnet"
    }
    ok = channel.publish_state(state)
    if ok:
        print(f"[OK] Heartbeat sent! Check your dashboard: {peer_name}'s card should now show ACTIVE.")
    else:
        print("[!] Failed to send heartbeat.")

def send_sim_heavy_turn(channel, peer_name, local_name):
    print(f"\n[>] Simulating a HEAVY prompt turn from {peer_name} (85,000 tokens on Opus-5)...")
    title = f"Heavy Usage Turn: {peer_name}"
    msg = f"{peer_name} ran a heavy turn (85,000 tokens, $1.45) using claude-opus-5 (out: 3,800 tok)."
    payload = {
        "tokens": 85000,
        "output_tokens": 3800,
        "cost_usd": 1.45,
        "model": "claude-opus-5",
        "user": peer_name
    }
    ok = channel.publish_event("high_single_turn", title, msg, payload, priority=4)
    if ok:
        print("[OK] Alert sent! You should see a Windows Toast alert pop up right now.")
    else:
        print("[!] Failed to send alert.")

def send_sim_concurrency(channel, peer_name, local_name):
    print(f"\n[>] Simulating concurrent usage (both users active)...")
    # Send heartbeat with current timestamp
    send_sim_heartbeat(channel, peer_name, tokens_5h=650000, cost=8.20)
    print("[OK] Check your dashboard: The red '⚡ Concurrency Alert' banner should now appear.")

def main():
    cfg, peer_name, local_name, channel = get_simulated_peer()
    topic = cfg.get("channels_config", {}).get("ntfy", {}).get("topic", "")

    print("=" * 60)
    print(f"      CLAUDE-DUO TEAMMATE SIMULATOR")
    print("=" * 60)
    print(f"Simulating Teammate: {peer_name} (Remote PC)")
    print(f"Your Local Name:    {local_name}")
    print(f"Shared Pair Topic:  {topic}")
    print("-" * 60)

    while True:
        print("\nChoose a test action:")
        print(f"  1. Ping yourself as {peer_name} (Test Windows Toast notification)")
        print(f"  2. Connect {peer_name} (Make his card turn 🟢 Active on dashboard)")
        print(f"  3. Simulate {peer_name} running a Heavy 85k Turn (Test High Usage alert)")
        print(f"  4. Simulate Concurrency (Triggers shared activity warning)")
        print(f"  5. Loop simulation (Sends periodic activity every 4s)")
        print(f"  0. Exit")

        choice = input("\nEnter choice [0-5]: ").strip()

        if choice == "1":
            msg = input("Enter custom ping message (or press Enter for default): ").strip()
            if not msg:
                msg = f"Hey {local_name}! Testing local Windows notification from {peer_name}."
            send_sim_ping(channel, peer_name, local_name, msg)
        elif choice == "2":
            send_sim_heartbeat(channel, peer_name)
        elif choice == "3":
            send_sim_heavy_turn(channel, peer_name, local_name)
        elif choice == "4":
            send_sim_concurrency(channel, peer_name, local_name)
        elif choice == "5":
            print("\nStarting live simulation loop. Press Ctrl+C to stop...\n")
            try:
                tokens = 450000
                while True:
                    tokens += 12000
                    send_sim_heartbeat(channel, peer_name, tokens_5h=tokens, cost=round(tokens * 0.000015, 2))
                    time.sleep(4)
            except KeyboardInterrupt:
                print("\nStopped loop.")
        elif choice == "0":
            print("Exiting simulator.")
            break
        else:
            print("Invalid choice.")

if __name__ == "__main__":
    main()
