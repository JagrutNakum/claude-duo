"""
Desktop App Launcher for Claude-Duo.
Launches the Flask server and opens a native standalone app window via MS Edge or Chrome.
"""

import sys
import os
import time
import socket
import subprocess
import webbrowser
import threading
from .app import run_app

def find_browser_app_executable() -> str:
    candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    return ""

def is_port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(('127.0.0.1', port)) == 0

def launch_desktop():
    port = 5242
    url = f"http://127.0.0.1:{port}"
    browser = find_browser_app_executable()

    if is_port_in_use(port):
        # Already running, just open app window
        if browser:
            subprocess.Popen([browser, f"--app={url}", "--window-size=980,720"])
        else:
            webbrowser.open(url)
        return

    # Start browser in a helper thread once server is verified accepting connections
    def open_window_when_ready():
        server_ready = False
        for _ in range(100): # Wait up to 10 seconds
            if is_port_in_use(port):
                server_ready = True
                break
            time.sleep(0.1)

        if not server_ready:
            return

        time.sleep(0.3)
        if browser:
            subprocess.Popen([browser, f"--app={url}", "--window-size=980,720"])
        else:
            webbrowser.open(url)

    launcher_thread = threading.Thread(target=open_window_when_ready, daemon=True)
    launcher_thread.start()

    # Run Flask in the main process (blocking so it never dies)
    run_app(port)

if __name__ == "__main__":
    try:
        launch_desktop()
    except Exception as e:
        err_path = os.path.expanduser("~/.claude-duo/error.log")
        os.makedirs(os.path.dirname(err_path), exist_ok=True)
        with open(err_path, "w", encoding="utf-8") as f:
            import traceback
            traceback.print_exc(file=f)
