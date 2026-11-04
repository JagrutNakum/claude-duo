"""
File Watcher for Claude Code and Claude VS Code session transcripts.
Tails JSONL files under ~/.claude/projects/ in real time, extracting tokens & models.
"""

import os
import glob
import json
import time
import threading
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, Callable, Optional
from .metrics import UsageAggregator

WATCHER_STATE_FILE = Path.home() / ".claude-duo" / "watcher_state.json"

class ClaudeLogWatcher:
    def __init__(self, projects_dir: str, aggregator: UsageAggregator,
                 on_new_turn: Optional[Callable[[Dict[str, Any]], None]] = None):
        self.projects_dir = Path(os.path.expanduser(projects_dir))
        self.aggregator = aggregator
        self.on_new_turn = on_new_turn
        self.file_offsets: Dict[str, int] = {}
        self.running = False
        self.thread: Optional[threading.Thread] = None
        self._load_offsets()

    def _load_offsets(self):
        if WATCHER_STATE_FILE.exists():
            try:
                with open(WATCHER_STATE_FILE, "r", encoding="utf-8") as f:
                    self.file_offsets = json.load(f)
            except Exception:
                self.file_offsets = {}

    def _save_offsets(self):
        try:
            WATCHER_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(WATCHER_STATE_FILE, "w", encoding="utf-8") as f:
                json.dump(self.file_offsets, f)
        except Exception:
            pass

    def find_jsonl_files(self) -> list:
        if not self.projects_dir.exists():
            return []
        pattern = str(self.projects_dir / "**" / "*.jsonl")
        return glob.glob(pattern, recursive=True)

    def scan_once(self, bootstrap_fast: bool = False):
        files = self.find_jsonl_files()
        if not files:
            return

        now = time.time()
        new_turns_found = False

        for fpath in files:
            try:
                st = os.stat(fpath)
                # If file not tracked yet and was modified > 24h ago, fast-forward offset
                if fpath not in self.file_offsets and (now - st.st_mtime) > (24 * 3600):
                    self.file_offsets[fpath] = st.st_size
                    continue

                prev_offset = self.file_offsets.get(fpath, 0)

                # If file truncated or new, handle offset
                if st.st_size < prev_offset:
                    prev_offset = 0

                if st.st_size == prev_offset:
                    continue

                # If first discovery and bootstrap_fast is requested, skip old contents
                if fpath not in self.file_offsets and bootstrap_fast:
                    self.file_offsets[fpath] = st.st_size
                    continue

                # Read newly appended lines
                with open(fpath, "r", encoding="utf-8", errors="replace") as fp:
                    fp.seek(prev_offset)
                    for line in fp:
                        if not line.strip():
                            continue
                        try:
                            data = json.loads(line)
                            turn = self._process_log_entry(data)
                            if turn:
                                new_turns_found = True
                        except Exception:
                            continue
                    self.file_offsets[fpath] = fp.tell()

            except Exception:
                continue

        if new_turns_found:
            self.aggregator.save_history()

        self._save_offsets()

    def _process_log_entry(self, data: dict):
        # Look for usage in message or root
        msg = data.get("message")
        usage = None
        model = ""

        if isinstance(msg, dict):
            usage = msg.get("usage")
            model = msg.get("model") or ""

        if not usage:
            usage = data.get("usage")

        if not usage or not isinstance(usage, dict):
            return None

        if not model:
            model = data.get("advisorModel") or data.get("requestedModel") or data.get("model") or "claude-3-5-sonnet"

        # Check token fields
        in_tok = usage.get("input_tokens", 0)
        out_tok = usage.get("output_tokens", 0)
        cache_read = usage.get("cache_read_input_tokens", 0)
        cache_write = usage.get("cache_creation_input_tokens", 0)
        out_details = usage.get("output_tokens_details") or {}
        thinking_tok = out_details.get("thinking_tokens", 0)

        # Parse timestamp
        ts_val = time.time()
        raw_ts = data.get("timestamp")
        if raw_ts and isinstance(raw_ts, str):
            try:
                dt = datetime.fromisoformat(raw_ts.replace("Z", "+00:00"))
                ts_val = dt.timestamp()
            except Exception:
                ts_val = time.time()

        session_id = data.get("sessionId", "")

        # Record in aggregator without immediate disk write
        turn = self.aggregator.record_turn(
            model=model,
            input_tokens=in_tok,
            output_tokens=out_tok,
            cache_read=cache_read,
            cache_write=cache_write,
            thinking_tokens=thinking_tok,
            timestamp=ts_val,
            session_id=session_id,
            auto_save=False
        )

        if self.on_new_turn:
            self.on_new_turn(turn)
        return turn

    def start(self, poll_interval_sec: float = 1.5):
        if self.running:
            return
        self.running = True

        def _loop():
            # Initial pass
            self.scan_once(bootstrap_fast=False)
            while self.running:
                try:
                    self.scan_once(bootstrap_fast=False)
                except Exception:
                    pass
                time.sleep(poll_interval_sec)

        self.thread = threading.Thread(target=_loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False
