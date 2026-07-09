import asyncio
import bisect
import json
import os
import shutil
import uuid
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse, JSONResponse, FileResponse, StreamingResponse
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
    resize_video,
    change_speed,
    split_video,
    get_duration_ffprobe,
    burn_subtitles,
    generate_selected_video,
    generate_selected_audio,
    mute_audio,
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

    # Auto-create initial clip for existing projects that have a video but no clips
    if not clips:
        proj_result = await db.execute(select(Project).where(Project.id == project_id))
        project = proj_result.scalar_one_or_none()
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

    # Count remaining before deleting
    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
    )
    all_clips = list(result.scalars().all())
    if len(all_clips) <= 1:
        raise HTTPException(400, "Cannot delete the last clip")

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
    source_start: float
    source_end: float


@router.patch("/clips/{clip_id}", response_model=VideoClipResponse)
async def update_clip(
    project_id: str,
    clip_id: str,
    body: UpdateClipRequest,
    db: AsyncSession = Depends(get_db),
):
    """Update a clip's source boundaries (for resize/expand)."""
    result = await db.execute(
        select(VideoClip).where(VideoClip.id == clip_id, VideoClip.project_id == project_id)
    )
    clip = result.scalar_one_or_none()
    if not clip:
        raise HTTPException(404, "Clip not found")

    # Get project duration for validation
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
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
    all_clips = list(result.scalars().all())
    return [VideoClipResponse.model_validate(c) for c in all_clips]


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
        .where(Segment.project_id == project_id)
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


async def _build_tts_from_existing(segments, total_duration) -> str:
    """
    Combine pre-generated per-segment audio files into a single TTS overlay track.
    Returns path to combined wav file, or None if no pre-generated audio exists.
    """
    import shutil as _shutil
    import subprocess as _subprocess
    import uuid as _uuid

    audio_segments = []
    for s in segments:
        if not s.audio_url:
            continue
        # Resolve file path from URL (e.g. /uploads/tts/xxx.mp3 -> ./uploads/tts/xxx.mp3)
        file_path = s.audio_url.lstrip("/")
        if os.path.exists(file_path):
            audio_segments.append({
                "path": file_path,
                "start_time": s.start_time,
            })

    if not audio_segments:
        return None

    ffmpeg = _shutil.which("ffmpeg")
    if not ffmpeg:
        return None

    export_dir = os.path.join("uploads", "exports")
    os.makedirs(export_dir, exist_ok=True)
    output_path = os.path.join(export_dir, f"{_uuid.uuid4()}_voice_overlay.wav")

    if len(audio_segments) == 1:
        # Single segment: add delay to position it at the right time
        seg = audio_segments[0]
        delay_ms = int(seg["start_time"] * 1000)
        cmd = [
            ffmpeg, "-y",
            "-i", seg["path"],
            "-af", f"adelay={delay_ms}|{delay_ms}",
            "-c:a", "pcm_s16le",
            output_path,
        ]
    else:
        # Multiple segments: use filter_complex to position each at its timeline time
        inputs = []
        filter_parts = []
        for i, seg in enumerate(audio_segments):
            inputs += ["-i", seg["path"]]
            delay_ms = int(seg["start_time"] * 1000)
            filter_parts.append(f"[{i}]adelay={delay_ms}|{delay_ms}[d{i}]")

        mix_inputs = "".join(f"[d{i}]" for i in range(len(audio_segments)))
        filter_parts.append(f"{mix_inputs}amix=inputs={len(audio_segments)}:normalize=0[out]")
        filter_complex = ";".join(filter_parts)

        cmd = [ffmpeg, "-y"] + inputs + [
            "-filter_complex", filter_complex,
            "-map", "[out]",
            "-c:a", "pcm_s16le",
            output_path,
        ]

    try:
        result = await asyncio.to_thread(
            _subprocess.run, cmd, capture_output=True, text=True, timeout=300
        )
        if result.returncode != 0:
            print(f"TTS combine failed: {result.stderr[-300:]}")
            return None
        return output_path
    except Exception as e:
        print(f"TTS combine error: {e}")
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
        segments_data = [
            {
                "index": s.index,
                "start_time": s.start_time,
                "end_time": s.end_time,
                "text": s.text,
                "speaker": s.speaker,
            }
            for s in all_segments
        ]
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
        # First try to use pre-generated audio files from segments
        tts_audio_path = await _build_tts_from_existing(all_segments, project.duration)

        # Fall back to regenerating TTS if no pre-generated audio
        if not tts_audio_path:
            voice_segments = []
            for s in all_segments:
                if s.text and s.text.strip():
                    voice_segments.append({
                        "text": s.text,
                        "start_time": s.start_time,
                        "end_time": s.end_time,
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
                        total_duration=project.duration,
                    )
                except Exception as e:
                    print(f"TTS generation for export failed: {e}")
                    tts_audio_path = None

    # Resolve the background audio choice into a music path + mute flag.
    music_audio_path = None
    mute_original = body.mute_original_audio
    if body.background_audio == "music":
        # Use the isolated music-only stem (from Isolate Vocals/BGM), if present
        bgm_path = os.path.join(os.path.dirname(project.video_path), "bgm.wav")
        if os.path.exists(bgm_path):
            music_audio_path = bgm_path
        else:
            # No isolation done — fall back to muting so voices aren't left in
            mute_original = True
    elif body.background_audio == "none":
        mute_original = True

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
    await db.commit()
    await db.refresh(project)

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

    updated = []
    for seg in segments:
        if not seg.text or not seg.text.strip():
            updated.append(SegmentResponse.model_validate(seg))
            continue

        target_dur = seg.end_time - seg.start_time
        if target_dur <= 0:
            updated.append(SegmentResponse.model_validate(seg))
            continue

        # Use per-segment speed if set, otherwise fall back to request body speed
        seg_speed = seg.audio_speed if seg.audio_speed and seg.audio_speed != 1.0 else body.speed
        speed_pct = int((seg_speed - 1.0) * 100)
        rate = f"{speed_pct:+d}%"

        try:
            audio_path, actual_duration = await generate_fitted_segment_audio(
                text=seg.text,
                voice_profile=seg.voice_profile or "female",
                target_duration=target_dur,
                rate=rate,
                voice_name=seg.voice_name or "",
                language=project.language or "",
                emotion=seg.emotion or "",
                max_duration=_room_until_next(seg.start_time),
            )
            # Store as URL relative to /uploads/
            rel_path = os.path.relpath(audio_path, ".")
            seg.audio_url = "/" + rel_path.replace("\\", "/")
            seg.audio_speed = seg_speed
            # Auto-extend segment if speech couldn't fit within max speedup
            if actual_duration > target_dur + 0.05:
                seg.end_time = seg.start_time + actual_duration
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
    """Stream AI voice generation progress per segment via SSE."""
    from backend.database.db import async_session as make_session
    from backend.services.tts_service import generate_fitted_segment_audio

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
    segments_snap = [(s.id, s.text, s.start_time, s.end_time, s.voice_profile, s.voice_name, s.audio_speed, s.speaker, s.emotion or "") for s in result.scalars().all()]
    total = len(segments_snap)
    request_speed = body.speed
    project_language = project.language or ""

    if not segments_snap:
        raise HTTPException(400, "No segments found")

    # All segment start times in the project, to bound each audio by the room
    # until the next segment so generated speech can never overlap it.
    starts_res = await db.execute(
        select(Segment.start_time).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    all_starts = [row[0] for row in starts_res.all()]
    project_duration = project.duration or 0.0

    def _room_until_next(start_time: float):
        idx = bisect.bisect_right(all_starts, start_time)
        if idx < len(all_starts):
            return all_starts[idx] - start_time
        if project_duration > start_time:
            return project_duration - start_time
        return None

    # edge-tts is fast and stateless — run up to 6 segments in parallel.
    # VoxCPM uses a single shared model that is not concurrency-safe — run sequentially.
    from backend.config import settings as _cfg
    CONCURRENCY = 1 if _cfg.tts_engine == "voxcpm" else 6

    async def _process_one(seg_tuple):
        seg_id, text, start_time, end_time, voice_profile, voice_name, audio_speed, speaker, emotion = seg_tuple
        target_dur = end_time - start_time
        if not text or not text.strip() or target_dur <= 0:
            return seg_id, "skipped", None, None, None
        seg_speed = audio_speed if audio_speed and audio_speed != 1.0 else request_speed
        speed_pct = int((seg_speed - 1.0) * 100)
        rate = f"{speed_pct:+d}%"
        try:
            audio_path, actual_duration = await generate_fitted_segment_audio(
                text=text,
                voice_profile=voice_profile or "female",
                target_duration=target_dur,
                rate=rate,
                voice_name=voice_name or "",
                language=project_language,
                emotion=emotion,
                max_duration=_room_until_next(start_time),
            )
            rel_path = os.path.relpath(audio_path, ".")
            audio_url = "/" + rel_path.replace("\\", "/")
            new_end_time = start_time + actual_duration if actual_duration > target_dur + 0.05 else None

            async with make_session() as sess:
                res2 = await sess.execute(select(Segment).where(Segment.id == seg_id))
                seg = res2.scalar_one_or_none()
                if seg:
                    seg.audio_url = audio_url
                    seg.audio_speed = seg_speed
                    if new_end_time is not None:
                        seg.end_time = new_end_time
                    await sess.commit()

            return seg_id, "done", audio_url, new_end_time, None
        except Exception as e:
            print(f"TTS failed for segment {seg_id}: {e}")
            return seg_id, "error", None, None, str(e)

    async def event_stream():
        completed = 0
        failed = 0
        sem = asyncio.Semaphore(CONCURRENCY)

        async def _bounded(seg_tuple):
            async with sem:
                return await _process_one(seg_tuple)

        try:
            yield f"data: {json.dumps({'type': 'start', 'total': total})}\n\n"

            tasks = [asyncio.ensure_future(_bounded(s)) for s in segments_snap]
            for fut in asyncio.as_completed(tasks):
                seg_id, status, audio_url, new_end_time, err_msg = await fut
                completed += 1
                if status == "error":
                    failed += 1
                evt = {'type': 'progress', 'completed': completed, 'total': total, 'segment_id': seg_id, 'status': status}
                if audio_url:
                    evt['audio_url'] = audio_url
                if new_end_time is not None:
                    evt['end_time'] = new_end_time
                if err_msg:
                    evt['message'] = err_msg
                yield f"data: {json.dumps(evt)}\n\n"

            yield f"data: {json.dumps({'type': 'done', 'completed': completed, 'failed': failed, 'total': total})}\n\n"
        except Exception as e:
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
