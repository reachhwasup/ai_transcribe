"""Updating the app from inside the app.

The desktop app shows pages that were built once and runs a server that was started once.
When the code in the project folder has changed since — new screens, new server code — the
app is behind it. This says so, and brings it up to date: the pages are built again, and the
server is started again when its own code changed.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import time

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/app", tags=["app"])

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
FRONTEND = os.path.join(ROOT, "frontend")
DIST_INDEX = os.path.join(FRONTEND, "dist", "index.html")
STARTED_AT = time.time()
RESTART_CODE = 75            # the desktop app starts the server again when it exits with this
BUILD_SECONDS = 300
_building = False


def newest(folder: str, endings: tuple[str, ...], skip: tuple[str, ...] = ()) -> float:
    """When the most recently changed file under a folder was changed."""
    latest = 0.0
    for here, folders, files in os.walk(folder):
        folders[:] = [d for d in folders if d not in skip and not d.startswith(".")]
        for name in files:
            if name.endswith(endings):
                try:
                    latest = max(latest, os.path.getmtime(os.path.join(here, name)))
                except OSError:
                    pass
    return latest


def pages_changed_at() -> float:
    extra = (os.path.join(FRONTEND, "index.html"), os.path.join(FRONTEND, "package.json"))
    return max([newest(os.path.join(FRONTEND, "src"), (".ts", ".tsx", ".css"))]
               + [os.path.getmtime(p) for p in extra if os.path.isfile(p)])


def server_changed_at() -> float:
    return newest(os.path.join(ROOT, "backend"), (".py",), skip=("venv", "tests", "__pycache__"))


def status(built_at: float | None = None, started_at: float | None = None) -> dict:
    built_at = (os.path.getmtime(DIST_INDEX) if os.path.isfile(DIST_INDEX) else 0.0) if built_at is None else built_at
    started_at = STARTED_AT if started_at is None else started_at
    # a server started by start.sh restarts itself when its code changes; only the desktop
    # app's own server has to be asked to
    restartable = os.environ.get("DUBBING_STUDIO_OWNED") == "1"
    pages = pages_changed_at() > built_at + 1
    server = restartable and server_changed_at() > started_at + 1
    return {"pages_behind": pages, "server_behind": server, "update_ready": pages or server,
            "built_at": built_at, "started_at": started_at, "can_restart": restartable, "building": _building}


async def working_now() -> int:
    """How many jobs an update would interrupt. They pick up again afterwards, from the step
    they were on."""
    from backend.api.routes import join, pipeline, render_queue

    return (sum(1 for j in pipeline._jobs if j.status == "running")
            + sum(1 for j in render_queue._jobs if j.status == "rendering")
            + sum(1 for j in join._jobs if j.status == "running"))


@router.get("/update")
async def update_status():
    return {**status(), "working": await working_now()}


async def build_pages() -> None:
    npm = shutil.which("npm")
    if not npm:
        raise HTTPException(500, "npm was not found, so the pages cannot be built. Install Node.js.")
    process = await asyncio.create_subprocess_exec(npm, "run", "build", cwd=FRONTEND,
                                                   stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        output, _ = await asyncio.wait_for(process.communicate(), BUILD_SECONDS)
    except asyncio.TimeoutError:
        process.kill()
        raise HTTPException(500, "Building the pages took too long and was stopped.")
    if process.returncode != 0:
        tail = "\n".join(output.decode("utf-8", "replace").strip().splitlines()[-6:])
        raise HTTPException(500, f"The pages could not be built, so nothing was changed:\n{tail}")


def restart_soon(delay: float = 0.8) -> None:
    """Leave, so the desktop app starts the server again with the new code — after the answer
    to this request has gone out."""
    asyncio.get_running_loop().call_later(delay, os._exit, RESTART_CODE)


@router.post("/update")
async def update_now():
    """Bring the app up to date with the code in the project folder."""
    global _building
    if _building:
        raise HTTPException(409, "An update is already being applied.")
    before = status()
    _building = True
    try:
        if before["pages_behind"] or not os.path.isfile(DIST_INDEX):
            await build_pages()
    finally:
        _building = False
    restarting = before["server_behind"]
    if restarting:
        restart_soon()
    return {"pages_built": before["pages_behind"], "restarting": restarting}
