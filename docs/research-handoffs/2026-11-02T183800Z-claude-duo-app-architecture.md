# Technical Handoff: Claude-Duo Cross-Machine Shared Quota Companion App

## Objective

Build, package, and maintain **Claude-Duo**: a local-first, zero-knowledge privacy-preserving companion desktop application for two developers (Jagrut and Kaushik) sharing a single $20/month Claude Pro subscription across two separate Windows 11 machines over the internet.

The tool provides real-time shared 5-hour rolling limit tracking, live peer activity presence (preventing concurrent prompt collisions), fair per-user consumption attribution based on rolling token weights, Windows desktop notifications, and a 20-minute priority focus reservation lock.

## Requested Downstream Outcome

For Claude Code / Antigravity:
1. Maintain the native desktop application (`dist/Claude-Duo-win32-x64/Claude-Duo.exe`) and ensure runtime stability.
2. Monitor and respect the zero-knowledge E2EE relay channel over `ntfy.sh` (change-driven streaming, 250 msgs/day budget).
3. Provide desktop UI polish adhering to `unslop` and `hallmark` principles.

## Context & Environment

- Repository / Project: `C:\Users\jagru\Projects\claude-duo`
- Current Git Branch: `HEAD` (local git repository)
- Source Agent: Antigravity / Claude
- Dev Environment: Windows 11 x64, Node.js `v22.22.0`, npm `10.9.4`, Electron `v45.2.1`
- Active Hook: `~/.claude/settings.json` configured with `statusLine.command` pointing to `node "C:\Users\jagru\Projects\claude-duo\src\main\statusline_hook.js"`
- User Profile: `~/.claude-duo/config.json` configured with `user_name: "jagrut"`, `peer_name: "kaushik"`, topic: `"claude-duo-jagrut-kaushik"`
- Handoff Created: `2026-11-02T18:38:00Z` (Updated: `2026-11-02T18:55:00Z`)

## Architectural Discoveries & Core Specifications

### 1. Anthropic Quota Telemetry Surface
- Anthropic does **not** expose a deterministic token pool for Claude Pro ($20/mo). Quota is an opaque, model- and feature-weighted rolling allowance.
- Claude Code officially provides exact real-time quota telemetry through stdin JSON to its configured status-line command:
  - `rate_limits.five_hour.used_percentage` (0–100%)
  - `rate_limits.five_hour.resets_at` (Unix epoch seconds)
  - `rate_limits.seven_day.used_percentage` & `resets_at`
- This avoids all web scraping, API hammering, or account-ban risk.
- Peer readings are adopted when newer (`fiveHourUpdatedAt`), ensuring idle machines remain synchronized with the official account quota.

### 2. Attribution Mathematics ($q_k$ Rolling Share Ratio)
- Local consumption is extracted by `src/main/transcript_watcher.js` tailing local `~/.claude/projects/**/*.jsonl` files (including subagents) across the rolling 5-hour window.
- Weighted tokens formula:
  $$q_k = w_{\text{model}} \cdot \left( i + 1.25 c_w + 0.1 c_r + 5 o \right)$$
  - $i$ = `input_tokens`
  - $c_w$ = `cache_creation_input_tokens` (1h ephemeral cache)
  - $c_r$ = `cache_read_input_tokens` (discounted)
  - $o$ = `output_tokens` (Note: thinking tokens are already counted within `output_tokens` in Claude Code JSONL transcripts; using $5o$ accounts for both without double counting)
- Individual share percentages are calculated as the ratio of each peer's rolling 5-hour score:
  $$\text{Share}_{\text{local}} = 100 \cdot \frac{q_{\text{local}}}{q_{\text{local}} + q_{\text{peer}}}$$

### 3. Relay Architecture & Rate-Limit Budget
- `ntfy.sh` public limits: 60-request burst (refilled at 1 req/5s) and 250 messages per day per visitor.
- **Receiving:** Uses one persistent streaming subscription (`GET /<topic>/json?since=30m`) instead of periodic polling.
- **Publishing:** Change-driven:
  - Urgent changes (pings, reservation changes, active/idle transitions): throttled to at most once per 10s.
  - Normal updates (quota %, shares): coalesced to at most once per 5 minutes.
  - Heartbeat: sent once every 10 minutes of silence to keep peer online.
  - Automatic 15-minute backoff if HTTP 429 is encountered.
- UI displays current relay health: `connected`, `connecting`, `offline`, or `rate-limited`.

### 4. Strict Privacy Boundary & Zero-Knowledge E2EE
- ZERO prompts, ZERO source code, ZERO file paths, and ZERO task names leave the PC.
- Only a ~150-byte encrypted payload is transmitted over the wire:
  - Encrypted with AES-256-GCM using PBKDF2 key derivation from a shared passphrase.
  - Random 12-byte IVs, 16-byte auth tags, and sequence numbers.
  - Configurable private `e2ee_passphrase` in `~/.claude-duo/config.json`.

### 5. Desktop UI & Native Executable
- Designed adhering to `unslop` and `hallmark` principles:
  - 780 × 560 instrument-grade graphite theme (`#0d0f14`), quiet chrome, clean SVG iconography (no cartoon emojis).
  - Clear terminology: `Reserve 20m Focus` instead of arcade jargon.
  - High-contrast capacity meter and side-by-side user presence cards.
- Packaged with `@electron/packager` into a native standalone binary:
  `dist/Claude-Duo-win32-x64/Claude-Duo.exe`.
- Desktop shortcut `Claude-Duo.lnk` points directly to the `.exe`.

## Code & Config Changes Summary

| File | Status | Description |
|---|---|---|
| `src/main/statusline_hook.js` | Updated | Fast non-blocking status line hook; prints summary line |
| `src/main/statusline_receiver.js` | Updated | Auto-configures `settings.json` safely; rejects browser origins |
| `src/main/transcript_watcher.js` | Added | Tails JSONL transcripts, extracts token usage, calculates $q$ without double-counting thinking |
| `src/main/quota_engine.js` | Updated | Rolling $q$ ratio shares, peer liveness tracking, last-writer-wins reservations |
| `src/main/relay_client.js` | Updated | Streaming subscription, change-driven publishing respecting 250 msgs/day budget |
| `src/main/notifications.js` | Updated | Native Windows toasts; silences self-pings and replayed toasts |
| `src/main/index.js` | Updated | Window lifecycle, tray integration, "Start with Windows" toggle |
| `src/renderer/index.html` | Updated | Un-slopped UI; SVG icons; clear `#relay-status` and `#relay-topic` badges |
| `src/renderer/style.css` | Updated | Graphite palette, 4px grid rhythm, responsive at 640x480 minimum |
| `src/renderer/renderer.js` | Updated | SVG button states, live countdown, relay status indicators |
| `simulate_teammate.js` | Updated | Matches new wire format (`fiveHourUpdatedAt`, `setAt`, budget guidance) |

## Quality Verification

- Pass/fail test suite in Task 001: 18/18 passing.
- UI tested at 780x560 and 640x480 without layout breakages or scrollbars.
- `npm run package` builds standalone `Claude-Duo.exe` cleanly.
