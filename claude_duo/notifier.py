"""
Desktop notifications & audio/terminal alerts for Windows, macOS, and Linux.
Fails gracefully if notifications are unavailable in the environment.
"""

import sys
import subprocess
import os

def notify_desktop(title: str, message: str, sound: bool = True):
    if sound:
        sys.stdout.write("\a")
        sys.stdout.flush()

    platform = sys.platform
    try:
        if platform.startswith("win"):
            _notify_windows(title, message)
        elif platform == "darwin":
            _notify_macos(title, message)
        elif platform.startswith("linux"):
            _notify_linux(title, message)
    except Exception as e:
        # Graceful fallback: print to stdout
        pass

def _notify_windows(title: str, message: str):
    ps1_path = os.path.join(os.path.dirname(__file__), "notify_windows.ps1")
    if os.path.exists(ps1_path):
        subprocess.Popen(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1_path, "-Title", title, "-Message", message],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
    else:
        clean_title = title.replace('"', '`"').replace("'", "''")
        clean_msg = message.replace('"', '`"').replace("'", "''")
        ps_cmd = (
            f"[reflection.assembly]::loadwithpartialname('System.Windows.Forms') | Out-Null; "
            f"$b = New-Object System.Windows.Forms.NotifyIcon; "
            f"$b.Icon = [System.Drawing.SystemIcons]::Warning; "
            f"$b.BalloonTipTitle = '{clean_title}'; "
            f"$b.BalloonTipText = '{clean_msg}'; "
            f"$b.Visible = $True; "
            f"$b.ShowBalloonTip(3000); "
            f"Start-Sleep -Milliseconds 400; "
            f"$b.Dispose()"
        )
        subprocess.Popen(
            ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps_cmd],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )

def _notify_macos(title: str, message: str):
    clean_title = title.replace('"', '\\"')
    clean_msg = message.replace('"', '\\"')
    apple_script = f'display notification "{clean_msg}" with title "{clean_title}"'
    subprocess.Popen(
        ["osascript", "-e", apple_script],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )

def _notify_linux(title: str, message: str):
    subprocess.Popen(
        ["notify-send", title, message],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
