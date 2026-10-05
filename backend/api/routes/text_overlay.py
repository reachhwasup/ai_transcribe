"""Text overlays: titles, callouts and credits drawn on top of the video.

Separate from captions — a caption follows the dialogue, an overlay is something you place.
Khmer is rendered through Pillow with the raqm layout engine, the same path the burned
captions take, because ffmpeg's drawtext cannot shape Khmer script.
"""
from __future__ import annotations

import json
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database.db import get_db
from backend.database.models import AppSetting, Project

router = APIRouter(prefix="/projects/{project_id}/overlays", tags=["overlays"])

SETTING_KEY = "text_overlays:{project_id}"
MAX_OVERLAYS = 60


class TextOverlay(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    text: str = Field(min_length=1, max_length=400)
    start_time: float = Field(ge=0)
    end_time: float = Field(gt=0)
    # position as a percentage of the frame, so it survives any export resolution
    x_pct: float = Field(default=50.0, ge=0, le=100)
    y_pct: float = Field(default=12.0, ge=0, le=100)
    anchor: Literal["center", "left", "right"] = "center"
    size_pct: float = Field(default=6.0, gt=0, le=40)     # of frame height
    color: str = "#FFFFFF"
    # How solid the text is. A watermark usually sits well under 1 so it marks the video
    # without fighting the picture.
    opacity: float = Field(default=1.0, ge=0.05, le=1.0)
    outline_color: str = "#000000"
    outline_width: float = Field(default=3.0, ge=0, le=20)
    box_color: str = "#000000"
    box_opacity: float = Field(default=0.0, ge=0, le=1)
    bold: bool = True
    fade_seconds: float = Field(default=0.25, ge=0, le=3)
    # How the text arrives. "fade" just appears; the slides travel in from an edge and
    # settle at the position above.
    animation: Literal[
        "fade", "slide_left", "slide_right", "slide_up", "slide_down", "zoom",
        # grows from small with a little overshoot, then settles — for titles and callouts
        "pop",
        # these two never settle — the text crosses the frame and comes round again,
        # the way a sponsor strap or a news ticker runs
        "marquee_left", "marquee_right",
        # watermark motions: a slow wander, a DVD-style float that bounces off the edges,
        # and a hop between the four corners
        "drift", "bounce", "corners",
    ] = "fade"
    # entrance length, or for a marquee the time one full crossing takes
    animation_seconds: float = Field(default=0.5, ge=0.1, le=30)
    # How the text leaves, over its last exit_seconds. "none" just fades by fade_seconds.
    exit_animation: Literal["none", "slide_left", "slide_right", "slide_up", "slide_down", "zoom"] = "none"
    exit_seconds: float = Field(default=0.4, ge=0.1, le=5)


class OverlayList(BaseModel):
    overlays: list[TextOverlay] = Field(default_factory=list, max_length=MAX_OVERLAYS)


async def load_overlays(db: AsyncSession, project_id: str) -> list[dict]:
    """Every overlay saved for a project, in time order. Used by the export too."""
    row = await db.get(AppSetting, SETTING_KEY.format(project_id=project_id))
    if not row:
        return []
    try:
        items = json.loads(row.value)
    except (TypeError, ValueError):
        return []
    return sorted(
        (o for o in items if isinstance(o, dict) and str(o.get("text") or "").strip()),
        key=lambda o: float(o.get("start_time") or 0),
    )


async def _save(db: AsyncSession, project_id: str, overlays: list[dict]) -> None:
    key = SETTING_KEY.format(project_id=project_id)
    row = await db.get(AppSetting, key)
    payload = json.dumps(overlays, ensure_ascii=False)
    if row:
        row.value = payload
    else:
        db.add(AppSetting(key=key, value=payload))
    await db.commit()


@router.get("", response_model=list[TextOverlay])
@router.get("/", response_model=list[TextOverlay])
async def list_overlays(project_id: str, db: AsyncSession = Depends(get_db)):
    if not await db.get(Project, project_id):
        raise HTTPException(404, "Project not found")
    return [TextOverlay.model_validate(o) for o in await load_overlays(db, project_id)]


@router.put("", response_model=list[TextOverlay])
@router.put("/", response_model=list[TextOverlay])
async def replace_overlays(project_id: str, body: OverlayList, db: AsyncSession = Depends(get_db)):
    """Save the whole set. The editor holds them in one list, so it writes them as one."""
    if not await db.get(Project, project_id):
        raise HTTPException(404, "Project not found")
    cleaned = []
    for overlay in body.overlays:
        if overlay.end_time <= overlay.start_time:
            overlay.end_time = round(overlay.start_time + 2.0, 2)
        cleaned.append(overlay.model_dump())
    cleaned.sort(key=lambda o: o["start_time"])
    await _save(db, project_id, cleaned)
    return [TextOverlay.model_validate(o) for o in cleaned]


@router.delete("/{overlay_id}", response_model=list[TextOverlay])
async def delete_overlay(project_id: str, overlay_id: str, db: AsyncSession = Depends(get_db)):
    overlays = [o for o in await load_overlays(db, project_id) if o.get("id") != overlay_id]
    await _save(db, project_id, overlays)
    return [TextOverlay.model_validate(o) for o in overlays]
