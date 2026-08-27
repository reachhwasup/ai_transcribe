import asyncio
import bisect
import json
import os
import shutil
import uuid
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import PlainTextResponse, JSONResponse, FileResponse, StreamingResponse
from pathlib import Path
from pydantic import BaseModel
from typing import Optional, List
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database.db import get_db
from backend.database.models import Project, Segment, VideoClip
from backend.api.schemas import SegmentResponse, SplitClipRequest, VideoClipResponse
from backend.services.export_service import export_srt, export_vtt, export_txt, export_json
from backend.services.video_service import (
    PLATFORM_PRESETS,
    export_video_for_platform,
    cut_video,
    extract_clips_to_temp,
    separate_audio,
    flip_video,
    rotate_video,
    crop_video,
    blur_region,
    blur_regions,
    resize_video,
    change_speed,
    split_video,
    get_duration_ffprobe,
    burn_subtitles,
    generate_selected_video,
    generate_selected_audio,
    mute_audio,
    apply_logo_overlay,
)

router = APIRouter(prefix="/projects/{project_id}/export", tags=["export"])


# --- Video Clips (non-destructive timeline editing) ---
# NOTE: These must be defined before the /{format} catch-all route

@router.get("/clips", response_model=List[VideoClipResponse])
async def get_clips(
    project_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get all video clips for a project, ordered by index. Auto-creates initial clip if needed."""
    import uuid as _uuid

    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    clips = list(result.scalars().all())

    proj_result = await db.execute(select(Project).where(Project.id == project_id))
    project = proj_result.scalar_one_or_none()

    # Auto-create initial clip for existing projects that have a video but no clips
    if not clips:
        if project and project.video_path and project.duration and project.duration > 0:
            initial_clip = VideoClip(
                id=str(_uuid.uuid4()),
                project_id=project_id,
                index=0,
                source_start=0.0,
                source_end=project.duration,
            )
            db.add(initial_clip)
            await db.commit()
            clips = [initial_clip]
    elif clips:
        actual_dur = project.duration if (project and project.duration and project.duration > 0) else 0.0
        if project and project.video_path and os.path.exists(project.video_path):
            try:
                from backend.services.video_service import get_duration_ffprobe
                probe_dur = get_duration_ffprobe(project.video_path)
                if probe_dur > 0:
                    actual_dur = probe_dur
                    if project.duration != probe_dur:
                        project.duration = probe_dur
            except Exception:
                pass

        modified = False
        for i, c in enumerate(clips):
            if c.source_end <= c.source_start:
                c.source_end = round(c.source_start + 5.0, 2)
                modified = True
            if actual_dur > 0 and c.source_end > actual_dur + 0.1:
                c.source_end = round(actual_dur, 2)
                modified = True

        if modified:
            await db.commit()

    return [VideoClipResponse.model_validate(c) for c in clips]


@router.post("/clips/split", response_model=List[VideoClipResponse])
async def split_clip_at_playhead(
    project_id: str,
    body: SplitClipRequest,
    db: AsyncSession = Depends(get_db),
):
    """Split the clip at the playhead timeline position into two clips."""
    import uuid as _uuid

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    # Get all clips ordered by index
    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    clips = list(result.scalars().all())

    if not clips:
        raise HTTPException(400, "No video clips found. Upload a video first.")

    playhead_time = body.time

    # Find which clip contains this source time position
    target_clip = None
    for clip in clips:
        if clip.source_start < playhead_time < clip.source_end:
            target_clip = clip
            break

    if not target_clip:
        raise HTTPException(400, "Playhead is not inside any clip")

    # Split at the source position directly
    source_split_point = playhead_time

    # Create two new clips from the target
    clip1 = VideoClip(
        id=str(_uuid.uuid4()),
        project_id=project_id,
        index=target_clip.index,
        source_start=target_clip.source_start,
        source_end=source_split_point,
    )
    clip2 = VideoClip(
        id=str(_uuid.uuid4()),
        project_id=project_id,
        index=target_clip.index + 1,
        source_start=source_split_point,
        source_end=target_clip.source_end,
    )

    # Delete the original clip
    await db.delete(target_clip)
    await db.flush()

    # Re-index all clips after the split point
    remaining = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    existing = list(remaining.scalars().all())

    # Insert new clips
    db.add(clip1)
    db.add(clip2)

    # Shift indices of clips that come after
    for c in existing:
        if c.index >= clip2.index:
            c.index += 1

    await db.commit()

    # Re-fetch all clips with correct ordering
    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    all_clips = list(result.scalars().all())

    # Normalize indices to be sequential
    for i, c in enumerate(all_clips):
        c.index = i
    await db.commit()

    return [VideoClipResponse.model_validate(c) for c in all_clips]


@router.delete("/clips/{clip_id}")
async def delete_clip(
    project_id: str,
    clip_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Delete a video clip (non-destructive). The source video is kept intact."""
    result = await db.execute(
        select(VideoClip).where(VideoClip.id == clip_id, VideoClip.project_id == project_id)
    )
    clip = result.scalar_one_or_none()
    if not clip:
        raise HTTPException(404, "Clip not found")

    await db.delete(clip)
    await db.commit()

    # Re-index remaining clips
    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    remaining_clips = list(result.scalars().all())
    for i, c in enumerate(remaining_clips):
        c.index = i
    await db.commit()

    return {
        "status": "ok",
        "remaining_clips": len(remaining_clips),
        "video_rebuilt": False,
        "clips": [VideoClipResponse.model_validate(c) for c in remaining_clips],
    }


class UpdateClipRequest(BaseModel):
    source_start: Optional[float] = None
    source_end: Optional[float] = None


@router.patch("/clips/{clip_id}", response_model=VideoClipResponse)
async def update_clip(
    project_id: str,
    clip_id: str,
    body: UpdateClipRequest,
    db: AsyncSession = Depends(get_db),
):
    """Update a clip's source boundaries."""
    result = await db.execute(
        select(VideoClip).where(VideoClip.id == clip_id, VideoClip.project_id == project_id)
    )
    clip = result.scalar_one_or_none()
    if not clip:
        raise HTTPException(404, "Clip not found")

    if body.source_start is not None and body.source_end is not None:
        result_proj = await db.execute(select(Project).where(Project.id == project_id))
        project = result_proj.scalar_one_or_none()
        if not project:
            raise HTTPException(404, "Project not found")

        new_start = max(0.0, body.source_start)
        new_end = min(body.source_end, project.duration or body.source_end)
        if new_end - new_start < 0.1:
            raise HTTPException(400, "Clip must be at least 0.1s long")

        clip.source_start = new_start
        clip.source_end = new_end

    await db.commit()
    return VideoClipResponse.model_validate(clip)


@router.put("/clips/restore", response_model=List[VideoClipResponse])
async def restore_clips(
    project_id: str,
    clips_data: List[SplitClipRequest],
    db: AsyncSession = Depends(get_db),
):
    """Restore clips from a snapshot (for undo/redo). Replaces all clips with the provided list."""
    import uuid as _uuid

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    # Delete all existing clips
    existing = await db.execute(
        select(VideoClip).where(VideoClip.project_id == project_id)
    )
    for c in existing.scalars().all():
        await db.delete(c)
    await db.flush()

    # Create new clips from snapshot
    for i, clip_data in enumerate(clips_data):
        clip = VideoClip(
            id=str(_uuid.uuid4()),
            project_id=project_id,
            index=i,
            source_start=clip_data.source_start,
            source_end=clip_data.source_end,
        )
        db.add(clip)

    await db.commit()

    # Re-fetch and return
    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
class ReorderClipsRequest(BaseModel):
    clip_ids: List[str]


@router.put("/clips/reorder", response_model=List[VideoClipResponse])
async def reorder_clips(
    project_id: str,
    body: ReorderClipsRequest,
    db: AsyncSession = Depends(get_db),
):
    """Reorder video clips by updating their index order."""
    result = await db.execute(
        select(VideoClip).where(VideoClip.project_id == project_id)
    )
    clips_by_id = {c.id: c for c in result.scalars().all()}

    for new_idx, clip_id in enumerate(body.clip_ids):
        if clip_id in clips_by_id:
            clips_by_id[clip_id].index = new_idx

    await db.commit()

    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    all_clips = list(result.scalars().all())
    return [VideoClipResponse.model_validate(c) for c in all_clips]


class AddClipRequest(BaseModel):
    source_start: float = 0.0
    source_end: float
    index: Optional[int] = None


@router.post("/clips/add", response_model=List[VideoClipResponse])
async def add_clip_to_timeline(
    project_id: str,
    body: AddClipRequest,
    db: AsyncSession = Depends(get_db),
):
    """Add a new video clip slice to the timeline."""
    proj_result = await db.execute(select(Project).where(Project.id == project_id))
    project = proj_result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    clips = list(result.scalars().all())

    next_idx = body.index if body.index is not None else len(clips)
    new_clip = VideoClip(
        id=str(uuid.uuid4()),
        project_id=project_id,
        index=next_idx,
        source_start=max(0.0, body.source_start),
        source_end=max(body.source_start + 0.1, body.source_end),
    )
    db.add(new_clip)
    await db.commit()

    # Refresh and return
    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    return [VideoClipResponse.model_validate(c) for c in result.scalars().all()]


@router.post("/clips/append-file", response_model=List[VideoClipResponse])
async def append_video_file_to_timeline(
    project_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    """Upload a new video file and append it seamlessly to the project master video and timeline."""
    proj_result = await db.execute(select(Project).where(Project.id == project_id))
    project = proj_result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    project_dir = os.path.join(settings.upload_dir, project_id)
    os.makedirs(project_dir, exist_ok=True)

    ext = os.path.splitext(file.filename or "video.mp4")[1].lower() or ".mp4"
    temp_clip_path = os.path.join(project_dir, f"temp_clip_{uuid.uuid4()}{ext}")

    content = await file.read()
    with open(temp_clip_path, "wb") as f:
        f.write(content)

    try:
        from backend.services.video_service import get_duration_ffprobe, concatenate_video_files
        new_clip_dur = get_duration_ffprobe(temp_clip_path)
    except Exception:
        new_clip_dur = 5.0

    if not project.video_path or not os.path.exists(project.video_path):
        master_path = os.path.join(project_dir, f"master_{uuid.uuid4()}{ext}")
        shutil.move(temp_clip_path, master_path)
        project.video_path = master_path
        project.video_filename = file.filename
        project.duration = new_clip_dur
        project.status = "uploaded"

        new_clip = VideoClip(
            id=str(uuid.uuid4()),
            project_id=project_id,
            index=0,
            source_start=0.0,
            source_end=new_clip_dur,
        )
        db.add(new_clip)
        await db.commit()
    else:
        old_duration = project.duration or get_duration_ffprobe(project.video_path)
        combined_path = os.path.join(project_dir, f"master_{uuid.uuid4()}{ext}")

        total_dur = await asyncio.to_thread(
            concatenate_video_files,
            [project.video_path, temp_clip_path],
            combined_path,
        )

        # Cleanup old master video if it was generated
        if os.path.exists(project.video_path) and "master_" in project.video_path:
            try:
                os.remove(project.video_path)
            except OSError:
                pass
        if os.path.exists(temp_clip_path):
            try:
                os.remove(temp_clip_path)
            except OSError:
                pass

        project.video_path = combined_path
        project.duration = total_dur

        clips_res = await db.execute(
            select(VideoClip).where(VideoClip.project_id == project_id).order_by(VideoClip.index)
        )
        clips = list(clips_res.scalars().all())

        if not clips:
            db.add(VideoClip(
                id=str(uuid.uuid4()),
                project_id=project_id,
                index=0,
                source_start=0.0,
                source_end=old_duration,
            ))
            next_idx = 1
        else:
            next_idx = len(clips)

        appended_clip = VideoClip(
            id=str(uuid.uuid4()),
            project_id=project_id,
            index=next_idx,
            source_start=old_duration,
            source_end=total_dur,
        )
        db.add(appended_clip)

        # Sanitize existing segments so no segment overshoots old_duration or exceeds 15s
        existing_segs_res = await db.execute(
            select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
        )
        existing_segs = list(existing_segs_res.scalars().all())
        for s in existing_segs:
            if s.end_time > old_duration:
                s.end_time = old_duration
            if (s.end_time - s.start_time) > 15.0:
                char_len = len((s.text or "").strip())
                s.end_time = round(s.start_time + max(2.5, min(char_len * 0.2, 10.0)), 2)

        # If project has transcripts, add a new segment for the appended clip so T1/A1 have an entry
        if existing_segs:
            new_clip_dur = total_dur - old_duration
            db.add(Segment(
                id=str(uuid.uuid4()),
                project_id=project_id,
                index=len(existing_segs),
                start_time=round(old_duration + 0.2, 2),
                end_time=round(min(old_duration + max(2.0, min(new_clip_dur, 5.0)), total_dur), 2),
                text="[New Clip Dialogue]",
                original_text="[New Clip Dialogue]",
                speaker=existing_segs[-1].speaker if existing_segs else "",
                voice_profile=existing_segs[-1].voice_profile if existing_segs else "female",
            ))

        await db.commit()

    # Return all updated clips
    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    return [VideoClipResponse.model_validate(c) for c in result.scalars().all()]



# --- Subtitle export (existing) ---

@router.get("/{format}")
async def export_transcript(
    project_id: str,
    format: str,
    language: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Export transcript in SRT, VTT, TXT, or JSON format. Optionally translate to target language."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    result = await db.execute(
        select(Segment)
        .where(
            Segment.project_id == project_id,
            Segment.speaker != "Freeze",
            Segment.voice_profile != "freeze",
        )
        .order_by(Segment.start_time)
    )
    segments = [
        {
            "index": s.index,
            "start_time": s.start_time,
            "end_time": s.end_time,
            "text": s.text,
            "speaker": s.speaker,
        }
        for s in result.scalars().all()
    ]

    if not segments:
        raise HTTPException(400, "No transcript segments to export")

    # Translate segments if a different language is requested
    if language and language != (project.language or "km"):
        from backend.services.gemini_service import translate_segments
        segments = await translate_segments(segments, language)

    safe_name = project.name.replace(" ", "_")

    if format == "srt":
        content = export_srt(segments)
        return PlainTextResponse(
            content,
            headers={"Content-Disposition": f'attachment; filename="{safe_name}.srt"'},
            media_type="text/plain; charset=utf-8",
        )
    elif format == "vtt":
        content = export_vtt(segments)
        return PlainTextResponse(
            content,
            headers={"Content-Disposition": f'attachment; filename="{safe_name}.vtt"'},
            media_type="text/vtt; charset=utf-8",
        )
    elif format == "txt":
        content = export_txt(segments)
        return PlainTextResponse(
            content,
            headers={"Content-Disposition": f'attachment; filename="{safe_name}.txt"'},
            media_type="text/plain; charset=utf-8",
        )
    elif format == "json":
        data = export_json(segments)
        return JSONResponse(
            content=data,
            headers={"Content-Disposition": f'attachment; filename="{safe_name}.json"'},
        )
    else:
        raise HTTPException(400, f"Unsupported format: {format}. Use srt, vtt, txt, or json.")


# --- Platform video export ---

@router.get("/video/platforms")
async def list_platforms():
    """Return available platform presets."""
    return {
        key: {
            "name": val["name"],
            "width": val["width"],
            "height": val["height"],
            "description": val["description"],
            "max_duration": val["max_duration"],
        }
        for key, val in PLATFORM_PRESETS.items()
    }


class VideoExportRequest(BaseModel):
    platform: str = "youtube"
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    include_subtitles: bool = False
    include_voice: bool = False
    mute_original_audio: bool = False
    background_audio: str = "original"  # original | music | none
    split_duration: Optional[float] = None  # seconds per part; None = single file
    subtitle_language: Optional[str] = None  # target language for subtitles
    scale_mode: str = "fit"  # fit | fill | blur
    subtitle_size_pct: float = 4.0  # burned subtitle height as % of frame height
    subtitle_position: str = "bottom"  # bottom | middle | top
    subtitle_style: Optional[dict] = None  # full caption style (colors, outline, box)
    export_folder: Optional[str] = None  # Destination folder path on local disk
    output_filename: Optional[str] = None  # Custom output filename
    quality: str = "standard"  # compact (~2.2M, ~70% smaller) | standard (~3.8M) | high (~6.5M)
    bgm_volume: Optional[float] = 0.35  # volume factor for background audio/music (0.0 to 1.0, default 0.35)
    logo_url: Optional[str] = None  # URL or path of logo / watermark image
    logo_enabled: bool = False
    logo_position: str = "top_right"  # top_left | top_right | bottom_left | bottom_right | center | custom
    logo_x_pct: Optional[float] = 85.0  # 0-100 percentage
    logo_y_pct: Optional[float] = 5.0  # 0-100 percentage
    logo_scale_pct: float = 15.0  # 5-50 percentage of video width
    logo_opacity: float = 1.0  # 0.0 - 1.0
    voice_offset_ms: int = 0  # Voice timing offset in milliseconds to nudge audio alignment with captions (-500 to +500)



async def _build_tts_from_existing(segments, total_duration, voice_offset_ms: int = 0, start_offset: float = 0.0) -> str:
    """
    Combine pre-generated per-segment audio files into a single TTS overlay track.
    Uses sample-accurate float32 audio mixing at 48kHz stereo to ensure zero timing drift
    and instant execution even for projects with 1,000+ voice segments.
    """
    import uuid as _uuid
    import numpy as np
    import soundfile as sf

    audio_segments = []
    for s in segments:
        if not s.audio_url:
            continue
        file_path = s.audio_url.lstrip("/")
        if os.path.exists(file_path):
            audio_segments.append({
                "path": file_path,
                "start_time": float(s.start_time),
                "end_time": float(s.end_time),
            })

    if not audio_segments:
        return None

    def _combine_worker():
        sr = 48000
        offset_sec = float(voice_offset_ms) / 1000.0

        # Calculate needed duration
        max_end = max((seg["end_time"] for seg in audio_segments), default=10.0)
        calc_dur = max(float(total_duration or 0), max_end - start_offset + offset_sec + 2.0)
        total_samples = max(sr, int(calc_dur * sr))

        master = np.zeros((total_samples, 2), dtype=np.float32)

        for seg in audio_segments:
            try:
                data, cur_sr = sf.read(seg["path"], dtype="float32")
                if len(data.shape) == 1:
                    data = np.column_stack([data, data])
                elif data.shape[1] > 2:
                    data = data[:, :2]

                if cur_sr != sr:
                    # High quality linear sample interpolation for rate matching
                    target_len = int(len(data) * sr / cur_sr)
                    idx = np.round(np.linspace(0, len(data) - 1, target_len)).astype(int)
                    data = data[idx]

                st_sec = max(0.0, seg["start_time"] - start_offset + offset_sec)
                st_sample = int(st_sec * sr)
                if st_sample >= total_samples:
                    continue

                end_sample = min(total_samples, st_sample + len(data))
                chunk_len = end_sample - st_sample
                if chunk_len > 0:
                    master[st_sample:end_sample] += data[:chunk_len]
            except Exception as read_err:
                print(f"Warning reading TTS segment {seg['path']}: {read_err}")
                continue

        # Prevent digital clipping with soft limiter
        np.clip(master, -1.0, 1.0, out=master)

        export_dir = os.path.join("uploads", "exports")
        os.makedirs(export_dir, exist_ok=True)
        out_path = os.path.join(export_dir, f"{_uuid.uuid4()}_voice_overlay.wav")
        sf.write(out_path, master, sr, subtype="PCM_16")
        return out_path

    try:
        return await asyncio.to_thread(_combine_worker)
    except Exception as e:
        print(f"Error in _build_tts_from_existing: {e}")
        return None


@router.post("/video")
async def export_video(
    project_id: str,
    body: VideoExportRequest,
    db: AsyncSession = Depends(get_db),
):
    """Export video formatted for a specific platform (TikTok, YouTube, Facebook, etc.)."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No video file found for this project")

    if body.platform not in PLATFORM_PRESETS:
        raise HTTPException(400, f"Unknown platform: {body.platform}. Available: {list(PLATFORM_PRESETS.keys())}")

    # --- Determine the actual video source (respect timeline clips) ---
    clips_temp_path = None
    clip_result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    clips = list(clip_result.scalars().all())

    video_source = project.video_path

    if clips:
        # Check if clips cover the full video (no editing happened)
        full_video = (
            len(clips) == 1
            and abs(clips[0].source_start) < 0.1
            and project.duration
            and abs(clips[0].source_end - project.duration) < 0.1
        )
        if not full_video:
            clips_data = [
                {"source_start": c.source_start, "source_end": c.source_end}
                for c in clips
            ]
            try:
                clips_temp_path = await asyncio.to_thread(
                    extract_clips_to_temp, project.video_path, clips_data
                )
                if clips_temp_path:
                    video_source = clips_temp_path
            except Exception as e:
                print(f"Clip extraction failed, using full video: {e}")

    # Fetch segments (needed for subtitles and/or voice)
    srt_path = None
    tts_audio_path = None
    seg_result = await db.execute(
        select(Segment)
        .where(Segment.project_id == project_id)
        .order_by(Segment.start_time)
    )
    all_segments = seg_result.scalars().all()

    # Generate SRT file if subtitles requested
    if body.include_subtitles and all_segments:
        start_cut = float(body.start_time) if body.start_time is not None else 0.0
        end_cut = float(body.end_time) if body.end_time is not None else float("inf")

        segments_data = []
        for s in all_segments:
            if s.end_time > start_cut and s.start_time < end_cut:
                segments_data.append({
                    "index": len(segments_data) + 1,
                    "start_time": max(0.0, s.start_time - start_cut),
                    "end_time": max(0.0, min(end_cut, s.end_time) - start_cut),
                    "text": s.text,
                    "speaker": s.speaker,
                })

        # Translate if a different subtitle language is requested
        if body.subtitle_language and body.subtitle_language != (project.language or "km"):
            from backend.services.gemini_service import translate_segments
            segments_data = await translate_segments(segments_data, body.subtitle_language)
        srt_content = export_srt(segments_data)
        srt_path = video_source + ".export.srt"
        with open(srt_path, "w", encoding="utf-8") as f:
            f.write(srt_content)

    # Build combined TTS audio if voice overlay requested
    if body.include_voice and all_segments:
        start_cut = float(body.start_time) if body.start_time is not None else 0.0
        end_cut = float(body.end_time) if body.end_time is not None else float("inf")
        target_segments = [s for s in all_segments if s.end_time > start_cut and s.start_time < end_cut]
        calc_dur = (end_cut - start_cut) if end_cut != float("inf") else project.duration

        # First try to use pre-generated audio files from segments
        tts_audio_path = await _build_tts_from_existing(
            target_segments, calc_dur, voice_offset_ms=getattr(body, "voice_offset_ms", 0), start_offset=start_cut
        )

        # Fall back to regenerating TTS if no pre-generated audio
        if not tts_audio_path:
            voice_segments = []
            for s in target_segments:
                if s.text and s.text.strip():
                    voice_segments.append({
                        "text": s.text,
                        "start_time": max(0.0, s.start_time - start_cut),
                        "end_time": max(0.0, min(end_cut, s.end_time) - start_cut),
                        "voice_profile": s.voice_profile or "female",
                        "voice_name": s.voice_name or "",
                        "emotion": s.emotion or "",
                    })
            if voice_segments:
                try:
                    from backend.services.tts_service import generate_segments_audio
                    tts_audio_path = await generate_segments_audio(
                        voice_segments,
                        output_format="wav",
                        total_duration=calc_dur,
                    )
                except Exception as e:
                    print(f"TTS generation for export failed: {e}")
                    tts_audio_path = None

    # Resolve the background audio choice into a music path + mute flag.
    music_audio_path = None
    mute_original = False
    if body.background_audio == "music":
        bgm_path = os.path.join(os.path.dirname(project.video_path), "bgm.wav")
        is_valid_bgm = False
        if os.path.exists(bgm_path):
            try:
                from backend.services.video_service import probe_video
                b_dur = float(probe_video(bgm_path).get("duration", 0))
                v_dur = float(probe_video(project.video_path).get("duration", 0))
                if v_dur > 0 and abs(b_dur - v_dur) <= 3.0:
                    is_valid_bgm = True
                else:
                    os.remove(bgm_path)
            except Exception:
                pass

        if not is_valid_bgm:
            try:
                from backend.services.video_service import separate_audio
                await asyncio.to_thread(separate_audio, project.video_path, os.path.dirname(project.video_path))
                if os.path.exists(bgm_path):
                    is_valid_bgm = True
            except Exception as e:
                print(f"Audio separation failed during export: {e}")

        if is_valid_bgm:
            music_audio_path = bgm_path
            mute_original = True
        else:
            mute_original = False
    elif body.background_audio == "none":
        mute_original = True
    else:  # 'original' or default
        mute_original = False

    try:
        output_path = await asyncio.to_thread(
            export_video_for_platform,
            video_path=video_source,
            platform=body.platform,
            start_time=body.start_time,
            end_time=body.end_time,
            include_subtitles=body.include_subtitles,
            srt_path=srt_path,
            tts_audio_path=tts_audio_path,
            mute_original_audio=mute_original,
            music_audio_path=music_audio_path,
            scale_mode=body.scale_mode,
            subtitle_size_pct=body.subtitle_size_pct,
            subtitle_position=body.subtitle_position,
            subtitle_style=body.subtitle_style,
            quality=getattr(body, "quality", "standard"),
            bgm_volume=getattr(body, "bgm_volume", 0.35),
            logo_url=getattr(body, "logo_url", None),
            logo_enabled=getattr(body, "logo_enabled", False),
            logo_position=getattr(body, "logo_position", "top_right"),
            logo_x_pct=getattr(body, "logo_x_pct", 85.0),
            logo_y_pct=getattr(body, "logo_y_pct", 5.0),
            logo_scale_pct=getattr(body, "logo_scale_pct", 15.0),
            logo_opacity=getattr(body, "logo_opacity", 1.0),
        )
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    finally:
        # Cleanup temp files
        if srt_path and os.path.exists(srt_path):
            os.remove(srt_path)
        if tts_audio_path and os.path.exists(tts_audio_path):
            os.remove(tts_audio_path)
        if clips_temp_path and os.path.exists(clips_temp_path):
            os.remove(clips_temp_path)

    safe_name = project.name.replace(" ", "_")

    # --- Split into multiple parts if requested ---
    if body.split_duration and body.split_duration > 0:
        import math as _math
        import zipfile as _zipfile
        import subprocess as _subprocess

        ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
        probe_dur = await asyncio.to_thread(get_duration_ffprobe, output_path)
        total_dur = probe_dur or 0
        if total_dur <= 0:
            # fallback – just return single file
            return FileResponse(
                output_path,
                media_type="video/mp4",
                filename=f"{safe_name}_{body.platform}.mp4",
            )

        num_parts = _math.ceil(total_dur / body.split_duration)
        if num_parts <= 1:
            return FileResponse(
                output_path,
                media_type="video/mp4",
                filename=f"{safe_name}_{body.platform}.mp4",
            )

        export_dir = os.path.join(settings.upload_dir, "exports")
        part_paths: list = []
        try:
            for i in range(num_parts):
                ss = i * body.split_duration
                part_path = os.path.join(export_dir, f"{uuid.uuid4()}_part{i+1}.mp4")
                cmd = [
                    ffmpeg, "-y",
                    "-ss", str(ss),
                    "-i", output_path,
                    "-t", str(body.split_duration),
                    "-c", "copy",
                    "-movflags", "+faststart",
                    part_path,
                ]
                r = await asyncio.to_thread(
                    _subprocess.run, cmd, capture_output=True, text=True, timeout=300
                )
                if r.returncode == 0 and os.path.exists(part_path):
                    part_paths.append(part_path)

            # Build ZIP
            zip_path = os.path.join(export_dir, f"{uuid.uuid4()}_{safe_name}.zip")
            with _zipfile.ZipFile(zip_path, "w", _zipfile.ZIP_STORED) as zf:
                for idx, pp in enumerate(part_paths, 1):
                    arcname = f"{safe_name}_part{idx}.mp4"
                    zf.write(pp, arcname)

            return FileResponse(
                zip_path,
                media_type="application/zip",
                filename=f"{safe_name}_{body.platform}_parts.zip",
            )
        finally:
            # Cleanup part files (zip itself cleaned later by OS or manual)
            for pp in part_paths:
                if os.path.exists(pp):
                    try:
                        os.remove(pp)
                    except OSError:
                        pass
            if os.path.exists(output_path):
                try:
                    os.remove(output_path)
                except OSError:
                    pass

    return FileResponse(
        output_path,
        media_type="video/mp4",
        filename=f"{safe_name}_{body.platform}.mp4",
    )


@router.get("/download-temp")
async def download_temp_file_endpoint(
    project_id: str,
    file: str,
):
    """Download a rendered video or zip export file."""
    safe_file = os.path.basename(file)
    file_path = os.path.join(settings.upload_dir, "exports", safe_file)
    if not os.path.exists(file_path):
        raise HTTPException(404, "Exported file not found")
    media_type = "application/zip" if safe_file.endswith(".zip") else "video/mp4"
    return FileResponse(file_path, media_type=media_type, filename=safe_file)


class OpenFolderRequest(BaseModel):
    path: str


@router.get("/default-folders")
async def get_default_folders_endpoint():
    """Return common user directories (Downloads, Desktop, Movies, etc.)."""
    home = os.path.expanduser("~")
    downloads = os.path.join(home, "Downloads")
    desktop = os.path.join(home, "Desktop")
    movies = os.path.join(home, "Movies")
    return {
        "home": home,
        "downloads": downloads if os.path.exists(downloads) else home,
        "desktop": desktop if os.path.exists(desktop) else home,
        "movies": movies if os.path.exists(movies) else home,
    }


@router.post("/open-folder")
async def open_folder_in_finder_endpoint(body: OpenFolderRequest):
    """Open a folder or reveal a file in macOS Finder / Windows Explorer."""
    raw_path = os.path.expanduser(body.path.strip())
    if not os.path.exists(raw_path):
        parent = os.path.dirname(raw_path)
        if os.path.exists(parent):
            raw_path = parent
        else:
            raise HTTPException(404, f"Path not found: {raw_path}")

    import sys
    import subprocess
    try:
        if sys.platform == "darwin":
            if os.path.isfile(raw_path):
                subprocess.Popen(["open", "-R", raw_path])
            else:
                subprocess.Popen(["open", raw_path])
        elif sys.platform == "win32":
            if os.path.isfile(raw_path):
                subprocess.Popen(["explorer", f"/select,{raw_path}"])
            else:
                subprocess.Popen(["explorer", raw_path])
        else:
            target = os.path.dirname(raw_path) if os.path.isfile(raw_path) else raw_path
            subprocess.Popen(["xdg-open", target])
        return {"status": "ok", "path": raw_path}
    except Exception as e:
        raise HTTPException(500, f"Could not open path: {e}")


@router.post("/video-stream")
async def export_video_stream_endpoint(
    project_id: str,
    body: VideoExportRequest,
    db: AsyncSession = Depends(get_db),
):
    """Export video with real-time SSE progress streaming."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No video file found for this project")

    # Load segments
    seg_result = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    all_segments = seg_result.scalars().all()

    # Load video clips layout
    clips_result = await db.execute(
        select(VideoClip).where(VideoClip.project_id == project_id).order_by(VideoClip.index)
    )
    all_clips = clips_result.scalars().all()

    async def event_stream():
        import json
        srt_path = None
        tts_audio_path = None
        clips_temp_path = None
        export_dir = os.path.join(settings.upload_dir, "exports")
        os.makedirs(export_dir, exist_ok=True)
        safe_name = project.name.replace(" ", "_").replace("/", "_")

        try:
            yield f"data: {json.dumps({'type': 'progress', 'percent': 5, 'message': 'Preparing video clips...'})}\n\n"

            # Check if we have multiple clips / trimmed clips to build first
            video_source = project.video_path
            if len(all_clips) > 0:
                clips_layout = [
                    {
                        "source_start": c.source_start,
                        "source_end": c.source_end,
                    }
                    for c in all_clips
                ]
                full_video = (
                    len(clips_layout) == 1
                    and abs(clips_layout[0]["source_start"]) < 0.1
                    and project.duration
                    and abs(clips_layout[0]["source_end"] - project.duration) < 0.1
                )
                if not full_video:
                    try:
                        from backend.services.video_service import extract_clips_to_temp
                        clips_temp_path = await asyncio.to_thread(
                            extract_clips_to_temp,
                            video_path=project.video_path,
                            clips=clips_layout,
                        )
                        if clips_temp_path and os.path.exists(clips_temp_path):
                            video_source = clips_temp_path
                    except Exception as e:
                        print(f"Timeline assembly failed, falling back to raw video: {e}")

            yield f"data: {json.dumps({'type': 'progress', 'percent': 10, 'message': 'Formatting subtitle captions...'})}\n\n"

            if body.include_subtitles and all_segments:
                start_cut = float(body.start_time) if body.start_time is not None else 0.0
                end_cut = float(body.end_time) if body.end_time is not None else float("inf")

                segments_data = []
                for s in all_segments:
                    if s.end_time > start_cut and s.start_time < end_cut:
                        segments_data.append({
                            "index": len(segments_data) + 1,
                            "start_time": max(0.0, s.start_time - start_cut),
                            "end_time": max(0.0, min(end_cut, s.end_time) - start_cut),
                            "text": s.text,
                            "speaker": s.speaker,
                        })

                if body.subtitle_language and body.subtitle_language != (project.language or "km"):
                    from backend.services.gemini_service import translate_segments
                    segments_data = await translate_segments(segments_data, body.subtitle_language)
                srt_content = export_srt(segments_data)
                srt_path = video_source + ".export.srt"
                with open(srt_path, "w", encoding="utf-8") as f:
                    f.write(srt_content)

            yield f"data: {json.dumps({'type': 'progress', 'percent': 15, 'message': 'Preparing AI voiceover & background music...'})}\n\n"

            if body.include_voice and all_segments:
                start_cut = float(body.start_time) if body.start_time is not None else 0.0
                end_cut = float(body.end_time) if body.end_time is not None else float("inf")
                target_segments = [s for s in all_segments if s.end_time > start_cut and s.start_time < end_cut]
                calc_dur = (end_cut - start_cut) if end_cut != float("inf") else project.duration

                tts_audio_path = await _build_tts_from_existing(
                    target_segments, calc_dur, voice_offset_ms=getattr(body, "voice_offset_ms", 0), start_offset=start_cut
                )
                if not tts_audio_path:
                    voice_segments = []
                    for s in target_segments:
                        if s.text and s.text.strip():
                            voice_segments.append({
                                "text": s.text,
                                "start_time": max(0.0, s.start_time - start_cut),
                                "end_time": max(0.0, min(end_cut, s.end_time) - start_cut),
                                "voice_profile": s.voice_profile or "female",
                                "voice_name": s.voice_name or "",
                                "emotion": s.emotion or "",
                            })
                    if voice_segments:
                        try:
                            from backend.services.tts_service import generate_segments_audio
                            tts_audio_path = await generate_segments_audio(
                                voice_segments,
                                output_format="wav",
                                total_duration=calc_dur,
                            )
                        except Exception as e:
                            print(f"TTS generation for export failed: {e}")
                            tts_audio_path = None

            music_audio_path = None
            mute_original = False
            if body.background_audio == "music":
                bgm_path = os.path.join(os.path.dirname(project.video_path), "bgm.wav")
                is_valid_bgm = False
                if os.path.exists(bgm_path):
                    try:
                        from backend.services.video_service import probe_video
                        b_dur = float(probe_video(bgm_path).get("duration", 0))
                        v_dur = float(probe_video(project.video_path).get("duration", 0))
                        if v_dur > 0 and abs(b_dur - v_dur) <= 3.0:
                            is_valid_bgm = True
                        else:
                            os.remove(bgm_path)
                    except Exception:
                        pass

                if not is_valid_bgm:
                    try:
                        from backend.services.video_service import separate_audio
                        await asyncio.to_thread(separate_audio, project.video_path, os.path.dirname(project.video_path))
                        if os.path.exists(bgm_path):
                            is_valid_bgm = True
                    except Exception as e:
                        print(f"Audio separation failed during export: {e}")

                if is_valid_bgm:
                    music_audio_path = bgm_path
                    mute_original = True
                else:
                    mute_original = False
            elif body.background_audio == "none":
                mute_original = True
            else:
                mute_original = False

            yield f"data: {json.dumps({'type': 'progress', 'percent': 20, 'message': 'Rendering video with hardware acceleration...'})}\n\n"

            loop = asyncio.get_running_loop()
            progress_q: asyncio.Queue = asyncio.Queue()

            def sync_progress_cb(pct: int, msg: str):
                overall = min(98, 20 + int(pct * 0.75))
                loop.call_soon_threadsafe(progress_q.put_nowait, {"percent": overall, "message": msg})

            async def run_render():
                try:
                    res = await asyncio.to_thread(
                        export_video_for_platform,
                        video_path=video_source,
                        platform=body.platform,
                        start_time=body.start_time,
                        end_time=body.end_time,
                        include_subtitles=body.include_subtitles,
                        srt_path=srt_path,
                        tts_audio_path=tts_audio_path,
                        mute_original_audio=mute_original,
                        music_audio_path=music_audio_path,
                        scale_mode=body.scale_mode,
                        subtitle_size_pct=body.subtitle_size_pct,
                        subtitle_position=body.subtitle_position,
                        subtitle_style=body.subtitle_style,
                        progress_callback=sync_progress_cb,
                        quality=getattr(body, "quality", "standard"),
                        bgm_volume=getattr(body, "bgm_volume", 0.35),
                        logo_url=getattr(body, "logo_url", None),
                        logo_enabled=getattr(body, "logo_enabled", False),
                        logo_position=getattr(body, "logo_position", "top_right"),
                        logo_x_pct=getattr(body, "logo_x_pct", 85.0),
                        logo_y_pct=getattr(body, "logo_y_pct", 5.0),
                        logo_scale_pct=getattr(body, "logo_scale_pct", 15.0),
                        logo_opacity=getattr(body, "logo_opacity", 1.0),
                    )
                    return ("ok", res)
                except Exception as e:
                    return ("err", str(e))

            render_task = asyncio.create_task(run_render())

            while not render_task.done():
                try:
                    item = await asyncio.wait_for(progress_q.get(), timeout=0.25)
                    yield f"data: {json.dumps({'type': 'progress', 'percent': item['percent'], 'message': item['message']})}\n\n"
                except asyncio.TimeoutError:
                    pass

            status, result_val = await render_task
            if status != "ok":
                raise RuntimeError(result_val)

            output_path = result_val

            final_filename = f"{safe_name}_{body.platform}.mp4"
            final_path = output_path
            if body.split_duration and body.split_duration > 0:
                import math as _math
                import zipfile as _zipfile
                import subprocess as _subprocess
                yield f"data: {json.dumps({'type': 'progress', 'percent': 96, 'message': 'Packaging video split parts...'})}\n\n"
                ffmpeg_bin = shutil.which("ffmpeg") or "ffmpeg"
                probe_dur = await asyncio.to_thread(get_duration_ffprobe, output_path)
                total_dur = probe_dur or 0
                if total_dur > body.split_duration:
                    num_parts = _math.ceil(total_dur / body.split_duration)
                    part_paths = []
                    for i in range(num_parts):
                        ss = i * body.split_duration
                        part_p = os.path.join(export_dir, f"{uuid.uuid4()}_part{i+1}.mp4")
                        cmd = [
                            ffmpeg_bin, "-y",
                            "-ss", str(ss),
                            "-i", output_path,
                            "-t", str(body.split_duration),
                            "-c", "copy",
                            "-movflags", "+faststart",
                            part_p,
                        ]
                        r = await asyncio.to_thread(_subprocess.run, cmd, capture_output=True, text=True, timeout=300)
                        if r.returncode == 0 and os.path.exists(part_p):
                            part_paths.append(part_p)

                    zip_name = f"{safe_name}_{body.platform}_parts.zip"
                    zip_path = os.path.join(export_dir, zip_name)
                    with _zipfile.ZipFile(zip_path, "w", _zipfile.ZIP_STORED) as zf:
                        for idx, pp in enumerate(part_paths, 1):
                            zf.write(pp, f"{safe_name}_part{idx}.mp4")
                    final_filename = zip_name
                    final_path = zip_path

            # Custom output filename if requested
            if body.output_filename and body.output_filename.strip():
                clean_name = body.output_filename.strip().replace("/", "_").replace("\\", "_")
                ext = ".zip" if final_path.endswith(".zip") else Path(final_path).suffix or ".mp4"
                if not clean_name.lower().endswith(ext.lower()):
                    clean_name = f"{clean_name}{ext}"
                final_filename = clean_name

            # Copy directly to destination folder on local machine
            target_folder = body.export_folder.strip() if body.export_folder and body.export_folder.strip() else None
            if not target_folder:
                os_downloads = os.path.join(os.path.expanduser("~"), "Downloads")
                if os.path.exists(os_downloads):
                    target_folder = os_downloads

            saved_local_path = None
            if target_folder:
                try:
                    dest_dir = os.path.expanduser(target_folder)
                    os.makedirs(dest_dir, exist_ok=True)
                    dest_file_path = os.path.join(dest_dir, final_filename)
                    shutil.copy2(final_path, dest_file_path)
                    saved_local_path = os.path.abspath(dest_file_path)
                except Exception as save_err:
                    print(f"Warning: Could not copy export to {target_folder}: {save_err}")

            out_basename = os.path.basename(final_path)
            yield f"data: {json.dumps({'type': 'done', 'percent': 100, 'message': 'Video successfully rendered!', 'download_url': f'/api/projects/{project_id}/export/download-temp?file={out_basename}', 'filename': final_filename, 'saved_path': saved_local_path, 'export_folder': target_folder})}\n\n"

        except Exception as e:
            import traceback
            traceback.print_exc()
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
        finally:
            if srt_path and os.path.exists(srt_path):
                try:
                    os.remove(srt_path)
                except OSError:
                    pass
            if tts_audio_path and os.path.exists(tts_audio_path):
                try:
                    os.remove(tts_audio_path)
                except OSError:
                    pass
            if clips_temp_path and os.path.exists(clips_temp_path):
                try:
                    os.remove(clips_temp_path)
                except OSError:
                    pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# --- Video cut/trim ---

class VideoCutRequest(BaseModel):
    start_time: float
    end_time: float


@router.post("/cut")
async def cut_video_endpoint(
    project_id: str,
    body: VideoCutRequest,
    db: AsyncSession = Depends(get_db),
):
    """Cut a portion of the video. Replaces the project video in-place."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No video file found for this project")

    if body.start_time < 0:
        raise HTTPException(400, "start_time must be >= 0")
    if body.end_time <= body.start_time:
        raise HTTPException(400, "end_time must be greater than start_time")
    if project.duration and body.end_time > project.duration + 1:
        raise HTTPException(400, "end_time exceeds video duration")

    try:
        output_path = cut_video(
            video_path=project.video_path,
            start_time=body.start_time,
            end_time=body.end_time,
        )
    except RuntimeError as e:
        raise HTTPException(500, str(e))

    return await _replace_project_video(project, output_path, db)


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
        paths = await asyncio.to_thread(
            separate_audio,
            video_path=project.video_path,
            project_dir=project_dir,
        )
    except RuntimeError as e:
        raise HTTPException(500, str(e))

    return {
        "status": "done",
        "vocals_url": f"/uploads/{project_id}/vocals.wav",
        "bgm_url": f"/uploads/{project_id}/bgm.wav",
    }


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

    project_dir = os.path.dirname(project.video_path) if project.video_path else ""
    for fname in ("vocals.wav", "bgm.wav"):
        fpath = os.path.join(project_dir, fname) if project_dir else ""
        if fpath and os.path.exists(fpath):
            os.remove(fpath)

    # Also clean up demucs temp dir if present
    demucs_tmp = os.path.join(project_dir, "_demucs_tmp") if project_dir else ""
    if demucs_tmp and os.path.isdir(demucs_tmp):
        shutil.rmtree(demucs_tmp, ignore_errors=True)

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
    vocals_path = os.path.join(project_dir, "vocals.wav") if project_dir else ""
    bgm_path = os.path.join(project_dir, "bgm.wav") if project_dir else ""

    separated = (
        bool(vocals_path)
        and os.path.exists(vocals_path)
        and bool(bgm_path)
        and os.path.exists(bgm_path)
    )

    if separated:
        return {
            "separated": True,
            "vocals_url": f"/uploads/{project_id}/vocals.wav",
            "bgm_url": f"/uploads/{project_id}/bgm.wav",
        }
    return {"separated": False}


# --- Mute audio (in-place) ---

@router.post("/mute-audio")
async def mute_audio_endpoint(
    project_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Remove audio track from the project video (mute). Modifies in-place."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No video file found for this project")

    try:
        output_path = mute_audio(video_path=project.video_path)
    except RuntimeError as e:
        raise HTTPException(500, str(e))

    return await _replace_project_video(project, output_path, db)


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

class VideoResizeRequest(BaseModel):
    width: int
    height: int


@router.post("/resize")
async def resize_video_endpoint(
    project_id: str,
    body: VideoResizeRequest,
    db: AsyncSession = Depends(get_db),
):
    """Resize video — modifies the project video in-place."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No video file found for this project")

    try:
        output_path = resize_video(
            video_path=project.video_path,
            width=body.width,
            height=body.height,
        )
    except (RuntimeError, ValueError) as e:
        raise HTTPException(500 if isinstance(e, RuntimeError) else 400, str(e))

    return await _replace_project_video(project, output_path, db)


# --- Video speed change (in-place) ---

class VideoSpeedRequest(BaseModel):
    speed: float


@router.post("/speed")
async def speed_video_endpoint(
    project_id: str,
    body: VideoSpeedRequest,
    db: AsyncSession = Depends(get_db),
):
    """Change video speed — modifies the project video in-place."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No video file found for this project")

    try:
        output_path = change_speed(
            video_path=project.video_path,
            speed=body.speed,
        )
    except (RuntimeError, ValueError) as e:
        raise HTTPException(500 if isinstance(e, RuntimeError) else 400, str(e))

    return await _replace_project_video(project, output_path, db)


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

class GenerateSelectedRequest(BaseModel):
    start_time: float
    end_time: float
    text: Optional[str] = None
    font_size: int = 48
    font_color: str = "white"
    position: str = "bottom"
    bg_opacity: float = 0.5


@router.post("/generate-selected")
async def generate_selected_endpoint(
    project_id: str,
    body: GenerateSelectedRequest,
    db: AsyncSession = Depends(get_db),
):
    """Generate a selected portion of the video with optional text overlay. Replaces the project video in-place."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No video file found for this project")

    if body.start_time < 0:
        raise HTTPException(400, "start_time must be >= 0")
    if body.end_time <= body.start_time:
        raise HTTPException(400, "end_time must be greater than start_time")

    try:
        output_path = generate_selected_video(
            video_path=project.video_path,
            start_time=body.start_time,
            end_time=body.end_time,
            text=body.text,
            font_size=body.font_size,
            font_color=body.font_color,
            position=body.position,
            bg_opacity=body.bg_opacity,
        )
    except (RuntimeError, ValueError) as e:
        raise HTTPException(500 if isinstance(e, RuntimeError) else 400, str(e))

    return await _replace_project_video(project, output_path, db)


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

class GenerateSelectedAudioRequest(BaseModel):
    start_time: float
    end_time: float
    audio_format: str = "mp3"


@router.post("/generate-selected-audio")
async def generate_selected_audio_endpoint(
    project_id: str,
    body: GenerateSelectedAudioRequest,
    db: AsyncSession = Depends(get_db),
):
    """Extract audio from a selected portion of the video. Downloads the result."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No video file found for this project")

    if body.start_time < 0:
        raise HTTPException(400, "start_time must be >= 0")
    if body.end_time <= body.start_time:
        raise HTTPException(400, "end_time must be greater than start_time")

    allowed_formats = {"mp3", "wav", "aac", "flac"}
    if body.audio_format not in allowed_formats:
        raise HTTPException(400, f"Unsupported format: {body.audio_format}")

    try:
        output_path = generate_selected_audio(
            video_path=project.video_path,
            start_time=body.start_time,
            end_time=body.end_time,
            audio_format=body.audio_format,
        )
    except (RuntimeError, ValueError) as e:
        raise HTTPException(500 if isinstance(e, RuntimeError) else 400, str(e))

    mime_map = {
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
        "aac": "audio/aac",
        "flac": "audio/flac",
    }

    safe_name = project.name.replace(" ", "_")
    return FileResponse(
        output_path,
        media_type=mime_map.get(body.audio_format, "application/octet-stream"),
        filename=f"{safe_name}_audio_{int(body.start_time)}s-{int(body.end_time)}s.{body.audio_format}",
    )


# --- Generate voice audio from subtitles (TTS) ---

class GenerateVoiceRequest(BaseModel):
    segment_ids: Optional[List[str]] = None  # None = all segments
    output_format: str = "mp3"


@router.post("/generate-voice")
async def generate_voice_endpoint(
    project_id: str,
    body: GenerateVoiceRequest,
    db: AsyncSession = Depends(get_db),
):
    """Generate AI voice audio from subtitle segments using TTS. Downloads the result."""
    from backend.services.tts_service import generate_segments_audio

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    # Fetch segments
    if body.segment_ids:
        stmt = select(Segment).where(
            Segment.project_id == project_id,
            Segment.id.in_(body.segment_ids),
        ).order_by(Segment.start_time)
    else:
        stmt = select(Segment).where(
            Segment.project_id == project_id,
        ).order_by(Segment.start_time)

    result = await db.execute(stmt)
    segments = result.scalars().all()

    if not segments:
        raise HTTPException(400, "No segments found to generate voice for")

    seg_dicts = [
        {
            "text": s.text,
            "start_time": s.start_time,
            "end_time": s.end_time,
            "voice_profile": s.voice_profile or "female",
            "voice_name": s.voice_name or "",
            "emotion": s.emotion or "",
        }
        for s in segments
        if s.text and s.text.strip()
    ]

    if not seg_dicts:
        raise HTTPException(400, "No segments with text to generate voice for")

    allowed_formats = {"mp3", "wav"}
    fmt = body.output_format if body.output_format in allowed_formats else "mp3"

    try:
        output_path = await generate_segments_audio(
            segments=seg_dicts,
            output_format=fmt,
            total_duration=project.duration,
        )
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))

    mime_map = {"mp3": "audio/mpeg", "wav": "audio/wav"}
    safe_name = project.name.replace(" ", "_")

    return FileResponse(
        output_path,
        media_type=mime_map.get(fmt, "application/octet-stream"),
        filename=f"{safe_name}_voice.{fmt}",
    )


# --- Generate AI voice per-segment (saves audio_url to each segment) ---

class GenerateSegmentVoiceRequest(BaseModel):
    segment_ids: Optional[List[str]] = None  # None = all segments
    speed: float = 1.0  # voice speed multiplier
    fit_mode: str = "A"  # A=Natural length, B=Stretch audio, C=Stretch video
    voice_name: Optional[str] = None  # custom neural voice name
    emotion: Optional[str] = None  # emotion prosody offset
    skip_existing: bool = True  # If True, continue/skip segments that already have valid dubbed audio


def _fit_max_speedup(fit_mode: str) -> Optional[float]:
    """Return max_speedup for generate_fitted_segment_audio based on fit mode.
    A: Natural length — dynamic speedup up to 2.0× if bounded before next segment.
    B: Sync Slot Fit — dynamic speedup up to 2.0× so audio finishes speaking before segment ends.
    C: Stretch video — keep audio natural (1.0×); stretch the video underneath it.
    """
    if fit_mode == "B":
        return 2.0   # dynamic tempo acceleration so speech completes within segment window
    elif fit_mode == "C":
        return 1.0   # keep audio natural speed and stretch video frame
    else:  # A (natural length into room)
        return 2.0   # speedup up to 2.0x before next segment collision


def _fit_max_duration(fit_mode: str, target_dur: float, room: Optional[float]) -> Optional[float]:
    """Return max_duration parameter based on fit mode.
    A: Natural length — extend freely into available room on timeline.
    B: Stretch audio — locked to target_dur.
    C: Stretch video — natural audio duration, video underneath will stretch.
    """
    if fit_mode == "B":
        return target_dur   # locked to subtitle slot
    elif fit_mode == "C":
        return None         # unlimited / stretch video
    else:  # A - natural
        return room         # extend freely into available room


@router.post("/generate-voice-segments")
async def generate_voice_segments_endpoint(
    project_id: str,
    body: GenerateSegmentVoiceRequest,
    db: AsyncSession = Depends(get_db),
):
    """Generate AI voice for each segment individually, store audio_url on segment."""
    from backend.services.tts_service import generate_fitted_segment_audio

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    # Fetch segments
    if body.segment_ids:
        stmt = select(Segment).where(
            Segment.project_id == project_id,
            Segment.id.in_(body.segment_ids),
        ).order_by(Segment.start_time)
    else:
        stmt = select(Segment).where(
            Segment.project_id == project_id,
        ).order_by(Segment.start_time)

    result = await db.execute(stmt)
    segments = result.scalars().all()

    if not segments:
        raise HTTPException(400, "No segments found")

    # All segment start times in the project (not just the selection), so each
    # audio can be bounded by the room until the next segment.
    starts_res = await db.execute(
        select(Segment.start_time).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    all_starts = [row[0] for row in starts_res.all()]

    def _room_until_next(start_time: float) -> Optional[float]:
        idx = bisect.bisect_right(all_starts, start_time)
        if idx < len(all_starts):
            return all_starts[idx] - start_time
        if project.duration and project.duration > start_time:
            return project.duration - start_time
        return None

    # Fetch voice profiles for custom cloned voice reference audio
    from backend.api.routes.settings import _get_custom_voice_profiles, DEFAULT_SAMPLE_VOICE_PROFILES
    custom_profiles = await _get_custom_voice_profiles(db)
    all_profiles = list(DEFAULT_SAMPLE_VOICE_PROFILES) + list(custom_profiles)
    profile_map = {}
    for p in all_profiles:
        if p.get("id"):
            profile_map[p["id"].lower()] = p
        if p.get("name"):
            profile_map[p["name"].lower()] = p
        if p.get("voice_name"):
            profile_map[p["voice_name"].lower()] = p
        if p.get("gender"):
            profile_map[p["gender"].lower()] = p
        if p.get("voice_profile"):
            profile_map[p["voice_profile"].lower()] = p

    updated = []
    for seg in segments:
        if not seg.text or not seg.text.strip():
            updated.append(SegmentResponse.model_validate(seg))
            continue

        target_dur = max(0.5, seg.end_time - seg.start_time)
        seg_speed = seg.audio_speed if seg.audio_speed and seg.audio_speed != 1.0 else body.speed
        speed_pct = int((seg_speed - 1.0) * 100)
        rate = f"{speed_pct:+d}%"

        effective_voice = body.voice_name or seg.voice_name or ""
        effective_emotion = body.emotion or seg.emotion or ""
        next_room = _room_until_next(seg.start_time)

        prof = (
            profile_map.get((effective_voice or "").lower())
            or profile_map.get((seg.voice_profile or "").lower())
            or profile_map.get((seg.speaker or "").lower())
            or {}
        )
        engine = prof.get("engine", "")
        effective_max_dur = _fit_max_duration(body.fit_mode or "B", target_dur, next_room)
        effective_speedup = _fit_max_speedup(body.fit_mode or "B") or 2.5

        try:
            audio_path, actual_duration = await generate_fitted_segment_audio(
                text=seg.text,
                voice_profile=seg.voice_profile or "female",
                target_duration=target_dur,
                rate=rate,
                voice_name=effective_voice,
                language=project.language or "",
                emotion=effective_emotion,
                engine=engine,
                reference_audio=ref_audio,
                max_duration=effective_max_dur,
                max_speedup=effective_speedup,
            )
            rel_path = os.path.relpath(audio_path, ".")
            seg.audio_url = "/" + rel_path.replace("\\", "/")
            seg.audio_speed = seg_speed
            if actual_duration > 0 and (seg.start_time + actual_duration) > seg.end_time:
                seg.end_time = round(seg.start_time + actual_duration, 2)
            if effective_voice:
                seg.voice_name = effective_voice
            if effective_emotion:
                seg.emotion = effective_emotion

            await db.commit()
            await db.refresh(seg)
            updated.append(SegmentResponse.model_validate(seg))
        except Exception as e:
            print(f"TTS failed for segment {seg.id}: {e}")
            updated.append(SegmentResponse.model_validate(seg))
            continue

    return updated


@router.post("/generate-voice-segments-stream")
async def generate_voice_segments_stream(
    project_id: str,
    body: GenerateSegmentVoiceRequest,
    db: AsyncSession = Depends(get_db),
):
    """Stream AI voice generation progress per segment via SSE preserving video alignment."""
    from backend.database.db import async_session as make_session
    from backend.services.tts_service import generate_fitted_segment_audio
    from backend.api.routes.settings import _get_custom_voice_profiles, DEFAULT_SAMPLE_VOICE_PROFILES

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if body.segment_ids:
        stmt = select(Segment).where(
            Segment.project_id == project_id,
            Segment.id.in_(body.segment_ids),
        ).order_by(Segment.start_time)
    else:
        stmt = select(Segment).where(
            Segment.project_id == project_id,
        ).order_by(Segment.start_time)

    result = await db.execute(stmt)
    segments_snap = [(s.id, s.text, s.start_time, s.end_time, s.voice_profile, s.voice_name, s.audio_speed, s.speaker, s.emotion or "", s.audio_url or "") for s in result.scalars().all()]
    total = len(segments_snap)
    request_speed = body.speed
    project_language = project.language or ""

    if not segments_snap:
        raise HTTPException(400, "No segments found")

    def _audio_file_valid(url: str) -> bool:
        if not url:
            return False
        clean_p = url.replace("/uploads/", "")
        p = os.path.join(settings.upload_dir, clean_p)
        return os.path.exists(p) and os.path.getsize(p) > 0

    custom_profiles = await _get_custom_voice_profiles(db)
    all_profiles = list(DEFAULT_SAMPLE_VOICE_PROFILES) + list(custom_profiles)
    profile_map = {}
    for p in all_profiles:
        if p.get("id"):
            profile_map[p["id"].lower()] = p
        if p.get("name"):
            profile_map[p["name"].lower()] = p
        if p.get("voice_name"):
            profile_map[p["voice_name"].lower()] = p
        if p.get("gender"):
            profile_map[p["gender"].lower()] = p
        if p.get("voice_profile"):
            profile_map[p["voice_profile"].lower()] = p

    async def event_stream():
        completed = 0
        failed = 0
        try:
            yield f"data: {json.dumps({'type': 'start', 'total': total})}\n\n"

            for idx, s in enumerate(segments_snap):
                seg_id, text, orig_start, orig_end, voice_profile, voice_name, audio_speed, speaker, emotion, existing_audio_url = s
                if not text or not text.strip():
                    completed += 1
                    yield f"data: {json.dumps({'type': 'progress', 'completed': completed, 'total': total, 'segment_id': seg_id, 'status': 'skipped'})}\n\n"
                    continue

                # Smart resume / continue: if segment was already dubbed before and file exists on disk, skip it!
                if body.skip_existing and existing_audio_url and _audio_file_valid(existing_audio_url):
                    completed += 1
                    yield f"data: {json.dumps({'type': 'progress', 'completed': completed, 'total': total, 'segment_id': seg_id, 'audio_url': existing_audio_url, 'start_time': orig_start, 'end_time': orig_end, 'status': 'done', 'cached': True})}\n\n"
                    continue

                yield f"data: {json.dumps({'type': 'segment_start', 'segment_id': seg_id, 'index': idx, 'total': total})}\n\n"

                target_dur = max(0.5, orig_end - orig_start)
                seg_speed = audio_speed if audio_speed and audio_speed != 1.0 else request_speed
                speed_pct = int((seg_speed - 1.0) * 100)
                rate = f"{speed_pct:+d}%"
                effective_voice = body.voice_name or voice_name or ""
                effective_emotion = body.emotion or emotion or ""

                next_room = None
                if idx < len(segments_snap) - 1:
                    next_seg_start = segments_snap[idx + 1][2]
                    if next_seg_start > orig_start:
                        next_room = max(target_dur, next_seg_start - orig_start - 0.05)

                prof = (
                    profile_map.get((effective_voice or "").lower())
                    or profile_map.get((voice_profile or "").lower())
                    or profile_map.get((speaker or "").lower())
                    or {}
                )
                engine = prof.get("engine", "")
                ref_audio = prof.get("sample_audio_url", "")
                effective_max_dur = _fit_max_duration(body.fit_mode or "B", target_dur, next_room)
                effective_speedup = _fit_max_speedup(body.fit_mode or "B") or 2.5

                try:
                    audio_path, actual_duration = await generate_fitted_segment_audio(
                        text=text,
                        voice_profile=voice_profile or "female",
                        target_duration=target_dur,
                        rate=rate,
                        voice_name=effective_voice,
                        language=project_language,
                        emotion=effective_emotion,
                        engine=engine,
                        reference_audio=ref_audio,
                        max_duration=effective_max_dur,
                        max_speedup=effective_speedup,
                    )
                    rel_path = os.path.relpath(audio_path, ".")
                    audio_url = "/" + rel_path.replace("\\", "/")

                    final_end = orig_end
                    if actual_duration > 0 and (orig_start + actual_duration) > orig_end:
                        final_end = round(orig_start + actual_duration, 2)

                    async with make_session() as sess:
                        res2 = await sess.execute(select(Segment).where(Segment.id == seg_id))
                        seg = res2.scalar_one_or_none()
                        if seg:
                            seg.audio_url = audio_url
                            seg.audio_speed = seg_speed
                            seg.end_time = final_end
                            if effective_voice:
                                seg.voice_name = effective_voice
                            if effective_emotion:
                                seg.emotion = effective_emotion
                            await sess.commit()

                    completed += 1
                    evt = {
                        'type': 'progress',
                        'completed': completed,
                        'total': total,
                        'segment_id': seg_id,
                        'status': 'done',
                        'audio_url': audio_url,
                        'start_time': orig_start,
                        'end_time': final_end,
                    }
                    yield f"data: {json.dumps(evt)}\n\n"
                except Exception as e:
                    failed += 1
                    completed += 1
                    import traceback
                    traceback.print_exc()
                    yield f"data: {json.dumps({'type': 'progress', 'completed': completed, 'total': total, 'segment_id': seg_id, 'status': 'error', 'message': str(e)})}\n\n"

            yield f"data: {json.dumps({'type': 'done', 'completed': completed, 'total': total, 'failed': failed})}\n\n"

        except Exception as e:
            import traceback
            print(f"[event_stream exception]: {e}")
            traceback.print_exc()
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
