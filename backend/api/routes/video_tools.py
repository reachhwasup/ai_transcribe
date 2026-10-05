"""In-place video tools: cut, flip, rotate, crop, blur, logo, resize, speed, burn subtitles, audio separation."""
import asyncio
import os
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Literal, Optional, List
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database.db import get_db
from backend.database.models import Project, Segment
from backend.services.video_service import (
    stem_url,
    stem_peaks,
    separation_progress,
    stems_ready,
    separate_audio,
    flip_video,
    rotate_video,
    crop_video,
    blur_regions,
    split_video,
    get_duration_ffprobe,
    burn_subtitles,
    apply_logo_overlay,
    clear_derived_audio,
)

router = APIRouter(prefix="/projects/{project_id}/export", tags=["export"])


# --- Video cut/trim ---


# --- Audio separation ---


@router.post("/separate-audio")
async def separate_audio_endpoint(
    project_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Separate audio from video into vocals and BGM tracks, stored with the project."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No video file found for this project")

    project_dir = os.path.dirname(project.video_path)

    try:
        await asyncio.to_thread(
            separate_audio,
            video_path=project.video_path,
            project_dir=project_dir,
        )
    except (RuntimeError, FileNotFoundError) as e:
        print(f"[separate-audio] {project_id} failed: {e}", flush=True)
        raise HTTPException(500, str(e))

    return {
        "status": "done",
        "vocals_url": stem_url(project_id, project_dir, "vocals"),
        "bgm_url": stem_url(project_id, project_dir, "bgm"),
    }


class CleanBgmRequest(BaseModel):
    level: Literal["off", "light", "strong", "max"]
    # put back sound effects Demucs filed under vocals; None keeps the project's setting
    keep_effects: Optional[bool] = None


async def caption_spans(db: AsyncSession, project_id: str) -> list[list[float]]:
    """[start, end] of every spoken caption — dialogue, whatever the voice detector heard."""
    from backend.database.models import Segment

    rows = (await db.execute(
        select(Segment.start_time, Segment.end_time, Segment.text, Segment.speaker, Segment.voice_profile)
        .where(Segment.project_id == project_id)
    )).all()
    return [[float(a), float(b)] for a, b, text, spk, vp in rows
            if (text or "").strip() and spk != "Freeze" and vp != "freeze" and "intro hook" not in (spk or "").lower()]


@router.post("/separate-audio/clean-bgm")
async def clean_bgm_endpoint(project_id: str, body: CleanBgmRequest, db: AsyncSession = Depends(get_db)):
    """Remove leftover dialogue from the isolated BGM — no new separation, a few seconds."""
    from backend.services.video_service import clean_bgm

    project = await db.get(Project, project_id)
    if not project or not project.video_path:
        raise HTTPException(404, "Project not found")
    project_dir = os.path.dirname(project.video_path)
    try:
        await asyncio.to_thread(clean_bgm, project_dir, body.level, body.keep_effects,
                                await caption_spans(db, project_id))
    except FileNotFoundError as e:
        raise HTTPException(400, str(e))
    except (RuntimeError, ValueError) as e:
        raise HTTPException(500, str(e))
    from backend.services.video_service import bgm_keeps_effects

    return {"level": body.level, "keep_effects": bgm_keeps_effects(project_dir),
            "bgm_url": stem_url(project_id, project_dir, "bgm")}


@router.get("/stem-peaks")
async def stem_peaks_endpoint(
    project_id: str,
    name: str = "vocals",
    db: AsyncSession = Depends(get_db),
):
    """Waveform envelope of the vocals or BGM track, for drawing it in the timeline."""
    if name not in ("vocals", "bgm"):
        raise HTTPException(400, "name must be 'vocals' or 'bgm'")

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project or not project.video_path:
        raise HTTPException(404, "Project not found")

    try:
        peaks = await asyncio.to_thread(stem_peaks, os.path.dirname(project.video_path), name)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    return {"name": name, "peaks": peaks}


@router.delete("/separate-audio")
async def delete_separated_audio(
    project_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Delete separated vocals and BGM files for this project."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if project.video_path:
        clear_derived_audio(os.path.dirname(project.video_path))

    return JSONResponse({"status": "deleted"})


@router.get("/separate-audio/status")
async def separate_audio_status(
    project_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Check if audio separation has been done for this project."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    project_dir = os.path.dirname(project.video_path) if project.video_path else ""
    running = separation_progress.get(os.path.abspath(project_dir)) if project_dir else None
    if running:
        return {"separated": False, "separating": True, **running}
    if project_dir and stems_ready(project_dir):
        from backend.services.video_service import bgm_clean_level, bgm_keeps_effects

        return {
            "separated": True,
            "vocals_url": stem_url(project_id, project_dir, "vocals"),
            "bgm_url": stem_url(project_id, project_dir, "bgm"),
            "bgm_clean": bgm_clean_level(project_dir),
            "bgm_keep_effects": bgm_keeps_effects(project_dir),
        }
    return {"separated": False}


# --- Mute audio (in-place) ---


# --- Helper: replace project video in-place ---

async def _replace_project_video(project: Project, new_video_path: str, db: AsyncSession):
    """Replace the project's video file with a new one and update DB."""
    old_path = project.video_path

    # Move new file into project directory
    project_dir = os.path.dirname(old_path)
    ext = os.path.splitext(new_video_path)[1] or ".mp4"
    import uuid as _uuid
    new_filename = f"{_uuid.uuid4()}{ext}"
    dest_path = os.path.join(project_dir, new_filename)

    import shutil
    shutil.move(new_video_path, dest_path)

    # Remove old video
    if old_path and os.path.exists(old_path) and old_path != dest_path:
        os.remove(old_path)
    # Separated stems belong to the old video; drop them so they are rebuilt on demand
    clear_derived_audio(project_dir)

    # Get new duration
    new_duration = get_duration_ffprobe(dest_path)

    # Update DB
    project.video_path = dest_path
    if new_duration > 0:
        project.duration = new_duration
    # The old preview no longer matches the new video — regenerate it.
    project.preview_path = ""
    project.preview_status = "generating"
    await db.commit()
    await db.refresh(project)

    from backend.api.routes.projects import _generate_preview_task
    asyncio.create_task(_generate_preview_task(project.id, dest_path))

    return {
        "status": "ok",
        "video_path": dest_path,
        "duration": project.duration,
    }


# --- Video flip/mirror (in-place) ---

class VideoFlipRequest(BaseModel):
    direction: str = "horizontal"  # "horizontal" or "vertical"


@router.post("/flip")
async def flip_video_endpoint(
    project_id: str,
    body: VideoFlipRequest,
    db: AsyncSession = Depends(get_db),
):
    """Flip/mirror video — modifies the project video in-place."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No video file found for this project")

    if body.direction not in ("horizontal", "vertical"):
        raise HTTPException(400, "direction must be 'horizontal' or 'vertical'")

    try:
        output_path = await asyncio.to_thread(
            flip_video,
            video_path=project.video_path,
            direction=body.direction,
        )
    except RuntimeError as e:
        raise HTTPException(500, str(e))

    return await _replace_project_video(project, output_path, db)


# --- Video rotate (in-place) ---

class VideoRotateRequest(BaseModel):
    angle: int = 90  # 90, -90 (or 270), 180


@router.post("/rotate")
async def rotate_video_endpoint(
    project_id: str,
    body: VideoRotateRequest,
    db: AsyncSession = Depends(get_db),
):
    """Rotate video — modifies the project video in-place."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No video file found for this project")

    if body.angle not in (90, -90, 180, 270):
        raise HTTPException(400, "angle must be 90, -90, 180, or 270")

    try:
        output_path = await asyncio.to_thread(
            rotate_video,
            video_path=project.video_path,
            angle=body.angle,
        )
    except (RuntimeError, ValueError) as e:
        raise HTTPException(500 if isinstance(e, RuntimeError) else 400, str(e))

    return await _replace_project_video(project, output_path, db)


# --- Video crop (in-place) ---

class VideoCropRequest(BaseModel):
    x: int = 0
    y: int = 0
    width: int
    height: int


@router.post("/crop")
async def crop_video_endpoint(
    project_id: str,
    body: VideoCropRequest,
    db: AsyncSession = Depends(get_db),
):
    """Crop video — modifies the project video in-place."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No video file found for this project")

    try:
        output_path = await asyncio.to_thread(
            crop_video,
            video_path=project.video_path,
            x=body.x,
            y=body.y,
            width=body.width,
            height=body.height,
        )
    except (RuntimeError, ValueError) as e:
        raise HTTPException(500 if isinstance(e, RuntimeError) else 400, str(e))

    return await _replace_project_video(project, output_path, db)


# --- Blur a region (in-place) — e.g. to hide a logo/watermark ---

class VideoBlurRegionRequest(BaseModel):
    x: int
    y: int
    width: int
    height: int
    style: Literal["blur", "pixelate", "solid"] = "blur"
    strength: Optional[float] = None   # editor px on a 720-high frame
    tint: float = 0.0
    color: str = "#000000"
    start: Optional[float] = None      # source seconds; None = whole video
    end: Optional[float] = None


class VideoBlurRegionsRequest(BaseModel):
    regions: List[VideoBlurRegionRequest]


@router.post("/blur-regions")
async def blur_regions_endpoint(
    project_id: str,
    body: VideoBlurRegionsRequest,
    db: AsyncSession = Depends(get_db),
):
    """Blur multiple rectangular regions of the video in-place simultaneously."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No video file found for this project")

    try:
        regions_list = [r.dict() for r in body.regions]
        output_path = await asyncio.to_thread(
            blur_regions,
            video_path=project.video_path,
            regions=regions_list,
        )
    except (RuntimeError, ValueError) as e:
        raise HTTPException(500 if isinstance(e, RuntimeError) else 400, str(e))

    return await _replace_project_video(project, output_path, db)


class VideoApplyLogoRequest(BaseModel):
    logo_url: str
    position: str = "top_right"
    scale_pct: float = 15.0
    opacity: float = 1.0
    x_pct: Optional[float] = 85.0
    y_pct: Optional[float] = 5.0


@router.post("/apply-logo")
async def apply_logo_endpoint(
    project_id: str,
    body: VideoApplyLogoRequest,
    db: AsyncSession = Depends(get_db),
):
    """Burn a logo/watermark/image overlay onto the project video in-place."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No video file found for this project")

    # Resolve logo path from URL or filesystem
    raw_logo = body.logo_url.lstrip("/")
    if os.path.exists(raw_logo):
        logo_path = raw_logo
    elif os.path.exists(body.logo_url):
        logo_path = body.logo_url
    else:
        # Check in project watermarks directory
        watermark_dir = os.path.join(settings.upload_dir, project_id, "watermarks")
        cand = os.path.join(watermark_dir, os.path.basename(body.logo_url))
        if os.path.exists(cand):
            logo_path = cand
        else:
            raise HTTPException(400, f"Logo image not found at {body.logo_url}")

    try:
        output_path = await asyncio.to_thread(
            apply_logo_overlay,
            video_path=project.video_path,
            logo_path=logo_path,
            position=body.position,
            scale_pct=body.scale_pct,
            opacity=body.opacity,
            x_pct=body.x_pct,
            y_pct=body.y_pct,
        )
    except (RuntimeError, ValueError, FileNotFoundError) as e:
        raise HTTPException(500 if isinstance(e, RuntimeError) else 400, str(e))

    return await _replace_project_video(project, output_path, db)


# --- Video resize (in-place) ---


# --- Video speed change (in-place) ---


# --- Burn subtitles (in-place) ---

class BurnSubtitlesRequest(BaseModel):
    font_size: int = 28
    font_color: str = "white"
    position: str = "bottom"  # "top", "center", "bottom"
    bg_opacity: float = 0.5


@router.post("/burn-subtitles")
async def burn_subtitles_endpoint(
    project_id: str,
    body: BurnSubtitlesRequest,
    db: AsyncSession = Depends(get_db),
):
    """Burn project subtitle segments into video — modifies in-place."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No video file found for this project")

    # Fetch all segments for this project
    seg_result = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    segments = seg_result.scalars().all()
    if not segments:
        raise HTTPException(400, "No subtitle segments found. Transcribe the video first.")

    seg_dicts = [
        {"text": s.text, "start_time": s.start_time, "end_time": s.end_time}
        for s in segments
    ]

    try:
        output_path = burn_subtitles(
            video_path=project.video_path,
            segments=seg_dicts,
            font_size=body.font_size,
            font_color=body.font_color,
            position=body.position,
            bg_opacity=body.bg_opacity,
        )
    except (RuntimeError, ValueError) as e:
        raise HTTPException(500 if isinstance(e, RuntimeError) else 400, str(e))

    return await _replace_project_video(project, output_path, db)


# --- Generate selected video (trim + optional text, download) ---


# --- Video split (download) ---

class VideoSplitRequest(BaseModel):
    split_points: List[float]


@router.post("/split")
async def split_video_endpoint(
    project_id: str,
    body: VideoSplitRequest,
    db: AsyncSession = Depends(get_db),
):
    """Split video at first split point, keeping the first part as the project video."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No video file found for this project")

    if not body.split_points:
        raise HTTPException(400, "At least one split point is required")

    if project.duration:
        for pt in body.split_points:
            if pt <= 0 or pt >= project.duration:
                raise HTTPException(400, f"Split point {pt}s is out of range (0-{project.duration}s)")

    try:
        output_paths = split_video(
            video_path=project.video_path,
            split_points=body.split_points,
        )
    except (RuntimeError, ValueError) as e:
        raise HTTPException(500 if isinstance(e, RuntimeError) else 400, str(e))

    # Keep the first part as the project video, remove the rest
    first_part = output_paths[0]
    for path in output_paths[1:]:
        if os.path.exists(path):
            os.remove(path)

    return await _replace_project_video(project, first_part, db)


# --- Generate selected audio (extract audio from time range, download) ---


