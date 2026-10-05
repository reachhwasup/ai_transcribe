"""Dubbing Studio as a Mac app: its own window, and the server started and stopped with it.

Opened, it starts the server unless one is already running (the development one, say), waits
for it, and shows the app in a window. Closed, it stops the server it started. Work on the
server's queues is saved as it goes, so it carries on from where it was the next time.
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request

APP_NAME = "Dubbing Studio"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("DUBBING_STUDIO_PORT", "8008"))
URL = f"http://127.0.0.1:{PORT}"
LOG_DIR = os.path.expanduser(f"~/Library/Logs/{APP_NAME}")
START_SECONDS = 120          # the first start loads the voice and sound libraries
RESTART_CODE = 75            # the server left to be started again: an update was applied
# An app opened from the Finder is given a bare PATH; ffmpeg and the other tools the server
# runs live where Homebrew puts them.
TOOL_PATHS = ("/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin")

SPLASH = """<!doctype html><html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#0f1115;color:#e4e4e7;font:15px -apple-system,system-ui,sans-serif"><div style="text-align:center">
<div style="font-size:22px;font-weight:700;margin-bottom:10px">Dubbing Studio</div><div style="color:#a1a1aa">%s</div></div></body></html>"""


def healthy(url: str = URL, timeout: float = 1.5) -> bool:
    try:
        with urllib.request.urlopen(url + "/api/health", timeout=timeout) as response:
            return response.status == 200
    except Exception:
        return False


def serves_the_app(url: str = URL) -> bool:
    """Whether the server there hands out the app's pages (the frontend has been built)."""
    try:
        with urllib.request.urlopen(url + "/", timeout=3) as response:
            return response.status == 200 and b"<div id=\"root\"" in response.read(4000)
    except Exception:
        return False


def environment() -> dict:
    env = dict(os.environ)
    have = env.get("PATH", "").split(os.pathsep)
    env["PATH"] = os.pathsep.join([p for p in TOOL_PATHS if p not in have] + have)
    env["PYTHONUNBUFFERED"] = "1"
    env["DUBBING_STUDIO_OWNED"] = "1"     # tells the server this app can start it again
    return env


def start_server() -> subprocess.Popen:
    os.makedirs(LOG_DIR, exist_ok=True)
    log = open(os.path.join(LOG_DIR, "server.log"), "ab")
    return subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", str(PORT),
         "--timeout-graceful-shutdown", "3", "--timeout-keep-alive", "5"],
        cwd=ROOT, env=environment(), stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )


def stop_server(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=10)
    except Exception:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except Exception:
            pass


def wait_until_ready(process: subprocess.Popen | None, seconds: float = START_SECONDS) -> str:
    """'' once the server answers, else what went wrong."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        if healthy():
            return ""
        if process is not None and process.poll() is not None:
            return f"The server stopped while starting. See {LOG_DIR}/server.log"
        time.sleep(0.4)
    return f"The server did not start in {int(seconds)} seconds. See {LOG_DIR}/server.log"


def name_the_app(icon_path: str) -> None:
    """Show the app under its own name and icon. The process is Python, which the menu bar and
    the Dock would otherwise name and picture."""
    try:
        from AppKit import NSApplication, NSImage
        from Foundation import NSBundle

        info = NSBundle.mainBundle().localizedInfoDictionary() or NSBundle.mainBundle().infoDictionary()
        if info is not None:
            info["CFBundleName"] = APP_NAME
        if os.path.isfile(icon_path):
            image = NSImage.alloc().initWithContentsOfFile_(icon_path)
            if image is not None:
                NSApplication.sharedApplication().setApplicationIconImage_(image)
    except Exception:
        pass


def check() -> int:
    """Start the server as the app would, confirm it serves the app, stop it. For the build."""
    already = healthy()
    process = None if already else start_server()
    try:
        problem = wait_until_ready(process)
        if problem:
            print(problem)
            return 1
        if not serves_the_app():
            print("The server is up but does not serve the app. Build the frontend first.")
            return 1
        print(f"ok: {'using the server already running' if already else 'started the server'} on {URL}")
        return 0
    finally:
        stop_server(process)


def main() -> int:
    if "--check" in sys.argv:
        return check()
    import webview

    name_the_app(os.environ.get("DUBBING_STUDIO_ICON", ""))
    owned: dict = {"process": None}
    closing = threading.Event()
    window = webview.create_window(APP_NAME, html=SPLASH % "Starting…", width=1500, height=950, min_size=(1100, 700),
                                   background_color="#0f1115")

    def bring_up() -> None:
        if not healthy():
            owned["process"] = start_server()
        problem = wait_until_ready(owned["process"])
        if not problem and not serves_the_app():
            problem = "The app has not been built yet. Run desktop/build_mac_app.sh in the project folder."
        if problem:
            window.load_html(SPLASH % problem)
        else:
            window.load_url(URL)

    def keep_running() -> None:
        """After an update the server leaves to be started again with the new code; do that,
        and show the app again once it answers."""
        while not closing.is_set():
            process = owned["process"]
            if process is not None and process.poll() == RESTART_CODE:
                window.load_html(SPLASH % "Updating…")
                owned["process"] = start_server()
                problem = wait_until_ready(owned["process"])
                window.load_html(SPLASH % problem) if problem else window.load_url(URL)
            closing.wait(1.0)

    def on_start() -> None:
        bring_up()
        keep_running()

    webview.settings["ALLOW_DOWNLOADS"] = True      # export and subtitle downloads
    try:
        webview.start(on_start, private_mode=False, storage_path=os.path.expanduser(f"~/Library/Application Support/{APP_NAME}"))
    finally:
        closing.set()
        stop_server(owned["process"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
