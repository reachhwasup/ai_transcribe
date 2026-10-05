"""Per-project editor settings kept on the server, and copying them across a split video's parts.

Caption style, aspect ratio, blur boxes and the logo used to live only in the browser's
localStorage — lost with the browser's data, missing from saved versions, and set up again by
hand on every one of a split video's parts. They are stored here now; the browser keeps a copy.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database.db import get_db
from backend.database.models import AppSetting, Project

router = APIRouter(prefix="/projects/{project_id}", tags=["project-settings"])

SETTING_KEY = "editor_settings:{project_id}"
KEYS = ("caption_style", "aspect_ratio", "blur_shapes", "logo", "video_filter", "track_mutes")


async def load_editor_settings(db: AsyncSession, project_id: str) -> dict:
    row = await db.get(AppSetting, SETTING_KEY.format(project_id=project_id))
    try:
        data = json.loads(row.value) if row else {}
    except (TypeError, ValueError):
        data = {}
    return {k: v for k, v in data.items() if k in KEYS}


async def save_editor_settings(db: AsyncSession, project_id: str, data: dict) -> None:
    key = SETTING_KEY.format(project_id=project_id)
    row = await db.get(AppSetting, key)
    payload = json.dumps({k: v for k, v in data.items() if k in KEYS}, ensure_ascii=False)
    if row:
        row.value = payload
    else:
        db.add(AppSetting(key=key, value=payload))


async def _project(db: AsyncSession, project_id: str) -> Project:
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return project


@router.get("/editor-settings")
async def get_editor_settings(project_id: str, db: AsyncSession = Depends(get_db)):
    await _project(db, project_id)
    return await load_editor_settings(db, project_id)


@router.patch("/editor-settings")
async def patch_editor_settings(project_id: str, body: dict, db: AsyncSession = Depends(get_db)):
    """Merge the given keys in; a key set to null is removed."""
    await _project(db, project_id)
    data = await load_editor_settings(db, project_id)
    for k, v in body.items():
        if k not in KEYS:
            continue
        if v is None:
            data.pop(k, None)
        else:
            data[k] = v
    await save_editor_settings(db, project_id, data)
    await db.commit()
    return data


# --- A split video's parts ---------------------------------------------------------------

async def _siblings(db: AsyncSession, project: Project) -> list[Project]:
    """The other parts of the same split video — or the other videos added from the same
    folder — in order."""
    if not project.source_project_id:
        if not getattr(project, "batch_id", ""):
            return []
        rows = (await db.execute(
            select(Project)
            .where(Project.batch_id == project.batch_id, Project.id != project.id)
            .order_by(Project.batch_index)
        )).scalars().all()
        return list(rows)
    rows = (await db.execute(
        select(Project)
        .where(Project.source_project_id == project.source_project_id, Project.id != project.id)
        .order_by(Project.part_index)
    )).scalars().all()
    return list(rows)


def _has_stems(p: Project) -> bool:
    from backend.services.video_service import stems_ready

    return bool(p.video_path) and stems_ready(os.path.dirname(p.video_path))


@router.get("/other-parts")
async def list_parts(project_id: str, db: AsyncSession = Depends(get_db)):
    project = await _project(db, project_id)
    return [
        {"id": p.id, "name": p.name, "part_index": p.part_index, "has_stems": _has_stems(p)}
        for p in await _siblings(db, project)
    ]


@router.get("/series-logo")
async def series_logo(project_id: str, db: AsyncSession = Depends(get_db)):
    """The logo to put on every video of this folder or split film: this project's own if it
    has one switched on, otherwise the first sibling's that has."""
    project = await _project(db, project_id)
    for part in [project, *await _siblings(db, project)]:
        logo = (await load_editor_settings(db, part.id)).get("logo")
        if isinstance(logo, dict) and logo.get("enabled") and logo.get("url"):
            return {"logo": logo, "project_id": part.id, "project_name": part.name}
    return {"logo": None, "project_id": None, "project_name": None}


ApplyItem = Literal["caption_style", "aspect_ratio", "blur_shapes", "logo", "video_filter", "bgm"]


class ApplyToParts(BaseModel):
    items: List[ApplyItem]
    part_ids: Optional[List[str]] = None   # None = every other part


def _copy_logo(logo: dict, source_id: str, target: Project) -> dict:
    """A copy of the logo image inside the target part, so each part stands on its own."""
    url = str(logo.get("url") or "")
    path = url.lstrip("/")
    if not url or url.startswith("data:") or not os.path.isfile(path) or not target.video_path:
        return dict(logo)
    dest_dir = os.path.join(settings.upload_dir, target.id, "watermarks")
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, os.path.basename(path))
    if os.path.abspath(dest) != os.path.abspath(path):
        shutil.copyfile(path, dest)
    return {**logo, "url": "/" + os.path.relpath(dest, ".").replace("\\", "/")}


@router.post("/apply-to-parts")
async def apply_to_parts(project_id: str, body: ApplyToParts, db: AsyncSession = Depends(get_db)):
    """Copy this part's settings to the other parts of the same split video."""
    from backend.services.video_service import bgm_clean_level, clean_bgm

    project = await _project(db, project_id)
    targets = await _siblings(db, project)
    if body.part_ids is not None:
        targets = [p for p in targets if p.id in set(body.part_ids)]
    if not targets:
        raise HTTPException(400, "This project has no other parts to copy to")

    mine = await load_editor_settings(db, project_id)
    src_dir = os.path.dirname(project.video_path) if project.video_path else ""
    # copy the choice, not what is applied now: on Max effects are paused, not unwanted
    from backend.services.video_service import _stems_state

    bgm = ({"level": bgm_clean_level(src_dir), "keep_effects": bool(_stems_state(src_dir).get("keep_effects", False))}
           if src_dir else None)

    report = []
    for part in targets:
        done, skipped = [], []
        data = await load_editor_settings(db, part.id)
        for item in body.items:
            if item == "bgm":
                continue
            if item not in mine:
                skipped.append(f"{item} (not set here)")
                continue
            data[item] = _copy_logo(mine[item], project_id, part) if item == "logo" else mine[item]
            done.append(item)
        await save_editor_settings(db, part.id, data)
        if "bgm" in body.items:
            if not bgm or not _has_stems(project):
                skipped.append("bgm (this part is not isolated)")
            elif not _has_stems(part):
                skipped.append("bgm (isolate vocals & BGM on this part first)")
            else:
                try:
                    from backend.api.routes.video_tools import caption_spans

                    await asyncio.to_thread(clean_bgm, os.path.dirname(part.video_path), bgm["level"],
                                            bgm["keep_effects"], await caption_spans(db, part.id))
                    done.append("bgm")
                except Exception as e:
                    skipped.append(f"bgm ({e})")
        report.append({"id": part.id, "name": part.name, "applied": done, "skipped": skipped})
    await db.commit()
    return {"parts": report}
