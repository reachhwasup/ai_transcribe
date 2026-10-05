"""Project asset library: video, audio and image files kept with the project.

Files live in uploads/<project>/assets/ and the list (with folders) in app_settings, so the
library survives a reload — the old one only held in-memory browser links and emptied itself
every time the page was refreshed.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import time
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database.db import get_db
from backend.database.models import AppSetting, Project

router = APIRouter(prefix="/projects/{project_id}/assets", tags=["assets"])

SETTING_KEY = "assets:{project_id}"
VIDEO_EXT = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".ts"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def _kind(filename: str) -> Optional[str]:
    ext = os.path.splitext(filename.lower())[1]
    return "video" if ext in VIDEO_EXT else "audio" if ext in AUDIO_EXT else "image" if ext in IMAGE_EXT else None


def _asset_dir(project_id: str) -> str:
    d = os.path.join(settings.upload_dir, project_id, "assets")
    os.makedirs(d, exist_ok=True)
    return d


def _url(path: str) -> str:
    return "/" + os.path.relpath(path, ".").replace("\\", "/")


async def _load(db: AsyncSession, project_id: str) -> dict:
    row = await db.get(AppSetting, SETTING_KEY.format(project_id=project_id))
    try:
        data = json.loads(row.value) if row else {}
    except (TypeError, ValueError):
        data = {}
    return {"folders": list(data.get("folders") or []), "items": list(data.get("items") or [])}


async def _save(db: AsyncSession, project_id: str, data: dict) -> None:
    key = SETTING_KEY.format(project_id=project_id)
    row = await db.get(AppSetting, key)
    payload = json.dumps(data, ensure_ascii=False)
    if row:
        row.value = payload
    else:
        db.add(AppSetting(key=key, value=payload))
    await db.commit()


async def _project(db: AsyncSession, project_id: str) -> Project:
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return project


def _probe(path: str, kind: str, thumb_path: str) -> tuple[Optional[float], Optional[str]]:
    """(duration seconds, thumbnail path) — both best effort."""
    duration = None
    if kind in ("video", "audio"):
        ffprobe = shutil.which("ffprobe")
        if ffprobe:
            r = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                               capture_output=True, text=True, timeout=20)
            try:
                duration = round(float(r.stdout.strip()), 2)
            except ValueError:
                pass
    thumb = None
    try:
        if kind == "video":
            ffmpeg = shutil.which("ffmpeg")
            seek = str(min(1.0, (duration or 2) / 3))
            r = subprocess.run([ffmpeg, "-v", "error", "-y", "-ss", seek, "-i", path, "-frames:v", "1",
                                "-vf", "scale=320:-2", thumb_path], capture_output=True, timeout=30)
            thumb = thumb_path if r.returncode == 0 and os.path.exists(thumb_path) else None
        elif kind == "image":
            from PIL import Image

            with Image.open(path) as im:
                im.thumbnail((320, 320))
                im.convert("RGB").save(thumb_path, "JPEG", quality=82)
            thumb = thumb_path
    except Exception:
        thumb = None
    return duration, thumb


@router.get("")
@router.get("/")
async def list_assets(project_id: str, db: AsyncSession = Depends(get_db)):
    await _project(db, project_id)
    data = await _load(db, project_id)
    # drop entries whose file was removed outside the app
    data["items"] = [a for a in data["items"] if os.path.exists(a.get("path", ""))]
    return {"folders": data["folders"], "items": [_public(a) for a in data["items"]]}


def _public(a: dict) -> dict:
    return {k: v for k, v in a.items() if k != "path"}


@router.post("")
@router.post("/")
async def upload_assets(
    project_id: str,
    files: List[UploadFile] = File(...),
    folder: str = Form("Imported"),
    db: AsyncSession = Depends(get_db),
):
    await _project(db, project_id)
    folder = (folder or "Imported").strip()[:80] or "Imported"
    target = _asset_dir(project_id)
    added, skipped = [], []
    for up in files:
        name = os.path.basename(up.filename or "file")
        kind = _kind(name)
        if not kind:
            skipped.append(name)
            continue
        aid = uuid.uuid4().hex[:12]
        safe = re.sub(r"[^\w.\-]+", "_", name)[-80:]
        path = os.path.join(target, f"{aid}_{safe}")
        with open(path, "wb") as fh:
            while chunk := await up.read(1024 * 1024):
                fh.write(chunk)
        duration, thumb = await asyncio.to_thread(_probe, path, kind, os.path.join(target, f"{aid}_thumb.jpg"))
        added.append({
            "id": aid, "name": name, "folder": folder, "type": kind, "size": os.path.getsize(path),
            "duration": duration, "url": _url(path), "thumb_url": _url(thumb) if thumb else None,
            "added_at": time.time(), "path": path,
        })
    data = await _load(db, project_id)
    if added and folder not in data["folders"]:
        data["folders"].append(folder)
    data["items"].extend(added)
    await _save(db, project_id, data)
    return {"added": [_public(a) for a in added], "skipped": skipped, "folders": data["folders"]}


class AssetPatch(BaseModel):
    name: Optional[str] = None
    folder: Optional[str] = None


@router.patch("/{asset_id}")
async def update_asset(project_id: str, asset_id: str, body: AssetPatch, db: AsyncSession = Depends(get_db)):
    data = await _load(db, project_id)
    item = next((a for a in data["items"] if a["id"] == asset_id), None)
    if not item:
        raise HTTPException(404, "Asset not found")
    if body.name and body.name.strip():
        item["name"] = body.name.strip()[:200]
    if body.folder and body.folder.strip():
        item["folder"] = body.folder.strip()[:80]
        if item["folder"] not in data["folders"]:
            data["folders"].append(item["folder"])
    await _save(db, project_id, data)
    return _public(item)


@router.delete("/{asset_id}")
async def delete_asset(project_id: str, asset_id: str, db: AsyncSession = Depends(get_db)):
    data = await _load(db, project_id)
    item = next((a for a in data["items"] if a["id"] == asset_id), None)
    if not item:
        raise HTTPException(404, "Asset not found")
    data["items"] = [a for a in data["items"] if a["id"] != asset_id]
    await _save(db, project_id, data)
    for p in (item.get("path"), (item.get("thumb_url") or "").lstrip("/")):
        if p and os.path.isfile(p):
            try:
                os.remove(p)
            except OSError:
                pass
    return {"deleted": asset_id}


class FolderList(BaseModel):
    folders: List[str]


@router.put("/folders")
async def set_folders(project_id: str, body: FolderList, db: AsyncSession = Depends(get_db)):
    """Replace the folder list: add, reorder, or drop empty folders. A folder still holding assets
    is kept even if left out."""
    data = await _load(db, project_id)
    wanted = [f.strip()[:80] for f in body.folders if f.strip()]
    in_use = {a["folder"] for a in data["items"]}
    data["folders"] = list(dict.fromkeys(wanted + [f for f in data["folders"] if f in in_use and f not in wanted]))
    await _save(db, project_id, data)
    return {"folders": data["folders"]}


@router.post("/{asset_id}/to-timeline")
async def asset_to_timeline(project_id: str, asset_id: str, db: AsyncSession = Depends(get_db)):
    """Append a video asset to the end of the edit — already on the server, so no re-upload."""
    from backend.api.routes.clips import append_clip_file

    project = await _project(db, project_id)
    data = await _load(db, project_id)
    item = next((a for a in data["items"] if a["id"] == asset_id), None)
    if not item or not os.path.exists(item.get("path", "")):
        raise HTTPException(404, "Asset not found")
    if item["type"] != "video":
        raise HTTPException(400, "Only video assets can be added to the timeline")
    # the append moves or deletes the file it is given, so hand it a copy
    ext = os.path.splitext(item["path"])[1] or ".mp4"
    temp = os.path.join(settings.upload_dir, project_id, f"temp_clip_{uuid.uuid4()}{ext}")
    await asyncio.to_thread(shutil.copyfile, item["path"], temp)
    return await append_clip_file(project, db, temp, item["name"])
