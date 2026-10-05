"""Named versions of a project's edit: capture, save and restore.

A version holds everything that makes up the edit — every caption with its voice, the clip
list that defines the cuts, and the text overlays. The source video and the voice audio files
are referenced rather than copied, so a version costs a few kilobytes.
"""
from __future__ import annotations

import json
import os
from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database.models import AppSetting, ProjectVersion, Segment, VideoClip

SEGMENT_FIELDS = (
    "id", "start_time", "end_time", "text", "original_text", "speaker", "voice_profile",
    "voice_name", "emotion", "voice_fx", "audio_url", "audio_speed",
)
OVERLAY_KEY = "text_overlays:{project_id}"
EDITOR_KEY = "editor_settings:{project_id}"
# Automatic versions pile up quickly; named ones are kept until deleted
MAX_AUTO_VERSIONS = 15


def segment_from_dict(project_id: str, index: int, d: dict) -> Segment:
    """A Segment row from a snapshot or undo payload. Unknown keys are ignored, and missing
    ones fall back to the column defaults rather than failing the whole restore."""
    import uuid

    def _float(key, default):
        try:
            return float(d.get(key, default))
        except (TypeError, ValueError):
            return default

    created = d.get("created_at")
    try:
        created_at = datetime.fromisoformat(created) if isinstance(created, str) else None
    except ValueError:
        created_at = None
    return Segment(
        id=d.get("id") or str(uuid.uuid4()),
        project_id=project_id,
        index=index,
        start_time=_float("start_time", 0.0),
        end_time=_float("end_time", 0.0),
        text=str(d.get("text") or ""),
        original_text=str(d.get("original_text") or ""),
        speaker=d.get("speaker") or "",
        voice_profile=d.get("voice_profile") or "female",
        voice_name=d.get("voice_name") or "",
        emotion=d.get("emotion") or "neutral",
        voice_fx=d.get("voice_fx") or "normal",
        audio_url=d.get("audio_url") or "",
        audio_speed=_float("audio_speed", 1.0) or 1.0,
        **({"created_at": created_at} if created_at else {}),
    )


async def replace_segments(db: AsyncSession, project_id: str, items: list[dict]) -> int:
    """Swap the project's captions for `items`. Returns how many voice files were missing and
    so were dropped — the line keeps its text and needs its voice generated again."""
    await db.execute(delete(Segment).where(Segment.project_id == project_id))
    await db.flush()
    missing = 0
    ordered = sorted(items, key=lambda d: float(d.get("start_time") or 0))
    for i, d in enumerate(ordered):
        seg = segment_from_dict(project_id, i, d)
        if seg.audio_url and not os.path.isfile(seg.audio_url.lstrip("/")):
            seg.audio_url = ""
            missing += 1
        db.add(seg)
    return missing


async def capture(db: AsyncSession, project_id: str) -> dict:
    segs = (await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )).scalars().all()
    clips = (await db.execute(
        select(VideoClip).where(VideoClip.project_id == project_id).order_by(VideoClip.index)
    )).scalars().all()
    overlay_row = await db.get(AppSetting, OVERLAY_KEY.format(project_id=project_id))
    editor_row = await db.get(AppSetting, EDITOR_KEY.format(project_id=project_id))
    return {
        # caption style, aspect ratio, blur boxes and logo
        "editor_settings": editor_row.value if editor_row else None,
        "segments": [
            {
                **{f: getattr(s, f) for f in SEGMENT_FIELDS},
                "created_at": s.created_at.isoformat() if s.created_at else None,
            }
            for s in segs
        ],
        "clips": [{"source_start": c.source_start, "source_end": c.source_end} for c in clips],
        "overlays": overlay_row.value if overlay_row else None,
    }


async def save_version(db: AsyncSession, project_id: str, name: str, auto: bool = False) -> ProjectVersion:
    """Snapshot the project's current edit. The caller commits."""
    data = await capture(db, project_id)
    version = ProjectVersion(
        project_id=project_id,
        name=name.strip()[:200] or "Untitled version",
        auto=auto,
        segment_count=len(data["segments"]),
        voiced_count=sum(1 for s in data["segments"] if s.get("audio_url")),
        clip_count=len(data["clips"]),
        timeline_seconds=round(sum(c["source_end"] - c["source_start"] for c in data["clips"]), 2),
        data=json.dumps(data, ensure_ascii=False),
    )
    db.add(version)
    await db.flush()
    if auto:
        old = (await db.execute(
            select(ProjectVersion.id)
            .where(ProjectVersion.project_id == project_id, ProjectVersion.auto.is_(True))
            .order_by(ProjectVersion.created_at.desc())
            .offset(MAX_AUTO_VERSIONS)
        )).scalars().all()
        if old:
            await db.execute(delete(ProjectVersion).where(ProjectVersion.id.in_(old)))
    return version


async def audio_in_versions(db: AsyncSession, project_id: str) -> frozenset[str]:
    """Voice files (as relative paths) that any saved version of the project refers to."""
    rows = (await db.execute(
        select(ProjectVersion.data).where(ProjectVersion.project_id == project_id)
    )).scalars().all()
    keep = set()
    for raw in rows:
        try:
            for seg in json.loads(raw).get("segments") or []:
                if seg.get("audio_url"):
                    keep.add(seg["audio_url"].lstrip("/"))
        except (TypeError, ValueError):
            continue
    return frozenset(keep)


async def auto_save(db: AsyncSession, project_id: str, name: str) -> None:
    """Keep a version before a step that rewrites the edit. Skipped for an empty project,
    and never allowed to block the step itself."""
    try:
        has_any = (await db.execute(
            select(Segment.id).where(Segment.project_id == project_id).limit(1)
        )).first() or (await db.execute(
            select(VideoClip.id).where(VideoClip.project_id == project_id).limit(1)
        )).first()
        if has_any:
            await save_version(db, project_id, name, auto=True)
    except Exception as e:  # pragma: no cover - a failed backup must not stop the edit
        print(f"[versions] auto-save '{name}' failed: {e}", flush=True)


async def restore(db: AsyncSession, project_id: str, version: ProjectVersion) -> dict:
    """Put the project's edit back to `version`. The caller commits."""
    data = json.loads(version.data)
    missing = await replace_segments(db, project_id, data.get("segments") or [])

    await db.execute(delete(VideoClip).where(VideoClip.project_id == project_id))
    for i, c in enumerate(data.get("clips") or []):
        db.add(VideoClip(project_id=project_id, index=i,
                         source_start=float(c["source_start"]), source_end=float(c["source_end"])))

    key = OVERLAY_KEY.format(project_id=project_id)
    row = await db.get(AppSetting, key)
    overlays = data.get("overlays")
    if overlays is None:
        if row:
            await db.delete(row)
    elif row:
        row.value = overlays
    else:
        db.add(AppSetting(key=key, value=overlays))

    # versions saved before editor settings were kept on the server have no entry: leave as is
    if "editor_settings" in data:
        key = EDITOR_KEY.format(project_id=project_id)
        erow = await db.get(AppSetting, key)
        value = data.get("editor_settings")
        if value is None:
            if erow:
                await db.delete(erow)
        elif erow:
            erow.value = value
        else:
            db.add(AppSetting(key=key, value=value))

    return {
        "segments": len(data.get("segments") or []),
        "clips": len(data.get("clips") or []),
        "missing_audio": missing,
    }
