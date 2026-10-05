"""Split a long upload into part projects, and join the finished parts back into one video.

Each part is an ordinary project — it transcribes, dubs and exports like any other — but it
remembers which project it came from and where it starts in the original, so the finished parts
can be stitched back together in order.
"""
from __future__ import annotations

import json
import os
import shutil
import uuid
from urllib.parse import quote
from typing import AsyncGenerator, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.api.routes.export import VideoExportRequest
from backend.api.schemas import ProjectResponse
from backend.config import settings
from backend.database.db import async_session, get_db
from backend.database.models import Project, VideoClip
from backend.services.split_service import (
    MAX_PARTS,
    MIN_PART_SECONDS,
    concat_videos_async,
    cut_part_async,
    plan_parts,
    probe_duration,
)

router = APIRouter(prefix="/projects", tags=["video-parts"])


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def _fmt(seconds: float) -> str:
    m, s = divmod(int(round(seconds)), 60)
    return f"{m}:{s:02d}"


class SplitPlanRequest(BaseModel):
    parts: Optional[int] = 2
    part_seconds: Optional[float] = None  # set this instead of `parts` for fixed-length parts


@router.post("/{project_id}/split/plan")
async def preview_split(project_id: str, body: SplitPlanRequest, db: AsyncSession = Depends(get_db)):
    """Where the cuts would land, without changing anything.

    The cut points are snapped to keyframes, so they rarely sit on an exact round number —
    this lets the modal show the real part lengths before committing.
    """
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")
    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "This project has no video to split")

    duration = project.duration or probe_duration(project.video_path)
    try:
        spans = plan_parts(project.video_path, duration, body.parts, body.part_seconds)
    except ValueError as e:
        raise HTTPException(400, str(e))

    size = os.path.getsize(project.video_path)
    return {
        "duration": round(duration, 2),
        "part_count": len(spans),
        "parts": [
            {
                "index": i + 1,
                "start": round(s, 2),
                "end": round(e, 2),
                "seconds": round(e - s, 2),
                "label": f"{_fmt(s)} – {_fmt(e)}",
            }
            for i, (s, e) in enumerate(spans)
        ],
        "source_bytes": size,
        "max_parts": MAX_PARTS,
        "min_part_seconds": MIN_PART_SECONDS,
    }


class SplitRequest(BaseModel):
    parts: Optional[int] = 2
    part_seconds: Optional[float] = None  # set this instead of `parts` for fixed-length parts
    delete_source_video: bool = False   # frees the disk the original takes up
    name_template: Optional[str] = None  # default: "<project name> — Part N"


@router.post("/{project_id}/split")
async def split_into_parts(project_id: str, body: SplitRequest):
    """Cut the video into N part projects, reporting progress as each part is written."""

    async def event_stream() -> AsyncGenerator[str, None]:
        async with async_session() as db:
            result = await db.execute(select(Project).where(Project.id == project_id))
            project = result.scalar_one_or_none()
            if not project:
                yield _sse({"type": "error", "message": "Project not found"})
                return
            source_video = project.video_path
            if not source_video or not os.path.exists(source_video):
                yield _sse({"type": "error", "message": "This project has no video to split"})
                return
            if project.part_index:
                yield _sse({"type": "error", "message": "This project is already a part of a split video"})
                return

            duration = project.duration or probe_duration(source_video)
            try:
                spans = plan_parts(source_video, duration, body.parts, body.part_seconds)
            except ValueError as e:
                yield _sse({"type": "error", "message": str(e)})
                return

            total = len(spans)
            base_name = (project.name or "Untitled").strip()
            template = body.name_template or f"{base_name} — Part {{n}}"
            ext = os.path.splitext(source_video)[1] or ".mp4"
            created: list[dict] = []

            yield _sse({"type": "progress", "percent": 2, "message": f"Cutting {total} parts…"})

            for i, (start, end) in enumerate(spans):
                new_id = str(uuid.uuid4())
                part_dir = os.path.join(settings.upload_dir, new_id)
                os.makedirs(part_dir, exist_ok=True)
                out_path = os.path.join(part_dir, f"{uuid.uuid4()}{ext}")
                try:
                    await cut_part_async(source_video, out_path, start, end, is_last=(i == total - 1))
                except Exception as e:
                    yield _sse({"type": "error", "message": str(e)})
                    return

                part_duration = probe_duration(out_path) or (end - start)
                part = Project(
                    id=new_id,
                    name=template.replace("{n}", str(i + 1)),
                    description=f"Part {i + 1} of {total} of “{base_name}” ({_fmt(start)} – {_fmt(end)})",
                    video_filename=project.video_filename,
                    video_path=out_path,
                    duration=part_duration,
                    status="uploaded",
                    language=project.language,
                    preview_status="none",
                    source_project_id=project_id,
                    part_index=i + 1,
                    part_count=total,
                    part_offset=round(start, 3),
                )
                db.add(part)
                db.add(VideoClip(
                    id=str(uuid.uuid4()),
                    project_id=new_id,
                    index=0,
                    source_start=0.0,
                    source_end=part_duration,
                ))
                await db.commit()

                created.append({
                    "id": new_id,
                    "name": part.name,
                    "part_index": i + 1,
                    "part_count": total,
                    "seconds": round(part_duration, 2),
                    "label": f"{_fmt(start)} – {_fmt(end)}",
                })
                yield _sse({
                    "type": "progress",
                    "percent": int(5 + (i + 1) / total * 90),
                    "message": f"Part {i + 1} of {total} ready ({_fmt(part_duration)})",
                    "part": created[-1],
                })

            project.part_count = total
            freed = 0
            if body.delete_source_video:
                # The whole original goes, not just its video file. The parts carry the id of
                # the project they came from, so they still group together without it — and a
                # parent left behind with no video and no captions is only confusing.
                project_dir = os.path.dirname(source_video)
                try:
                    freed = sum(
                        os.path.getsize(os.path.join(root, f))
                        for root, _, files in os.walk(project_dir)
                        for f in files
                    )
                except OSError:
                    freed = 0
                await db.delete(project)
                await db.commit()
                shutil.rmtree(project_dir, ignore_errors=True)
            else:
                await db.commit()

            yield _sse({
                "type": "done",
                "percent": 100,
                "message": f"Split into {total} parts",
                "parts": created,
                "freed_bytes": freed,
            })

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@router.get("/{project_id}/parts", response_model=list[ProjectResponse])
async def list_parts(project_id: str, db: AsyncSession = Depends(get_db)):
    """Every part belonging to the same split as this project, in order.

    Works whether you ask with the original project's id or with any one of its parts.
    """
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    root_id = project.source_project_id or project_id
    parts = await db.execute(
        select(Project)
        .options(selectinload(Project.segments), selectinload(Project.video_clips))
        .where(Project.source_project_id == root_id)
        .order_by(Project.part_index)
    )
    return [ProjectResponse.model_validate(p) for p in parts.scalars().all()]


class JoinRequest(BaseModel):
    export: VideoExportRequest
    output_filename: Optional[str] = None


@router.post("/{project_id}/parts/join")
async def join_parts(project_id: str, body: JoinRequest):
    """Render every part with the same export settings, then stitch them back into one video.

    Rendering happens here rather than reusing whatever each part exported earlier, so the joined
    file is always built from the current state of every part.
    """
    from backend.api.routes.export import run_export

    async def event_stream() -> AsyncGenerator[str, None]:
        async with async_session() as db:
            result = await db.execute(select(Project).where(Project.id == project_id))
            project = result.scalar_one_or_none()
            if not project:
                yield _sse({"type": "error", "message": "Project not found"})
                return
            root_id = project.source_project_id or project_id
            rows = await db.execute(
                select(Project).where(Project.source_project_id == root_id).order_by(Project.part_index)
            )
            parts = list(rows.scalars().all())

        if len(parts) < 2:
            yield _sse({"type": "error", "message": "This project has no parts to join"})
            return

        missing = [p.name for p in parts if not p.video_path or not os.path.exists(p.video_path)]
        if missing:
            yield _sse({"type": "error", "message": f"Missing video for: {', '.join(missing)}"})
            return

        rendered: list[str] = []
        total = len(parts)
        for i, part in enumerate(parts):
            share_base = int(i / total * 92)
            share_span = 92 / total
            yield _sse({
                "type": "progress",
                "percent": share_base,
                "message": f"Rendering {part.name} ({i + 1} of {total})…",
            })
            part_request = body.export.model_copy(update={
                "export_folder": None,      # only the joined file is saved to the user's folder
                "output_filename": None,
                "start_time": None,
                "end_time": None,
            })
            try:
                async for evt in run_export(part.id, part_request):
                    kind = evt.get("type")
                    if kind == "progress":
                        yield _sse({
                            "type": "progress",
                            "percent": int(share_base + (evt.get("percent") or 0) / 100 * share_span),
                            "message": f"{part.name}: {evt.get('message') or ''}",
                        })
                    elif kind == "error":
                        yield _sse({"type": "error", "message": f"{part.name}: {evt.get('message')}"})
                        return
                    elif kind == "done":
                        path = evt.get("temp_path")
                        if not path or not os.path.exists(path):
                            yield _sse({"type": "error", "message": f"{part.name} rendered but produced no file"})
                            return
                        rendered.append(path)
            except Exception as e:
                yield _sse({"type": "error", "message": f"{part.name}: {e}"})
                return

        yield _sse({"type": "progress", "percent": 94, "message": f"Joining {total} parts…"})

        export_dir = os.path.join(settings.upload_dir, "exports")
        os.makedirs(export_dir, exist_ok=True)
        out_basename = f"{uuid.uuid4()}_joined.mp4"
        out_path = os.path.join(export_dir, out_basename)
        try:
            await concat_videos_async(rendered, out_path)
        except Exception as e:
            yield _sse({"type": "error", "message": str(e)})
            return

        async with async_session() as db:
            root = (await db.execute(select(Project).where(Project.id == root_id))).scalar_one_or_none()
            root_name = (root.name if root else parts[0].name) or "joined"
        clean = (body.output_filename or root_name).strip().replace("/", "_").replace("\\", "_")
        if not clean.lower().endswith(".mp4"):
            clean += ".mp4"

        saved_path = None
        folder = body.export.export_folder
        if folder:
            try:
                dest_dir = os.path.expanduser(folder)
                os.makedirs(dest_dir, exist_ok=True)
                dest = os.path.join(dest_dir, clean)
                shutil.copy2(out_path, dest)
                saved_path = os.path.abspath(dest)
            except Exception as e:
                print(f"[join] could not copy to {folder}: {e}")

        yield _sse({
            "type": "done",
            "percent": 100,
            "message": f"Joined {total} parts",
            "filename": clean,
            "saved_path": saved_path,
            "seconds": round(probe_duration(out_path), 2),
            "download_url": f"/api/projects/{root_id}/export/download-temp?file={out_basename}&name={quote(clean)}",
        })

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )
