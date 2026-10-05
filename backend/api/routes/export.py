from backend.services.series_memory import translation_memory
import asyncio
import json
import os
from urllib.parse import quote as _quote
import shutil
import uuid
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse, JSONResponse, FileResponse, StreamingResponse
from pathlib import Path
from pydantic import BaseModel
from typing import AsyncGenerator, Optional
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database.db import async_session, get_db
from backend.database.models import Project, Segment, VideoClip
from backend.api.routes.text_overlay import load_overlays
from backend.services.export_service import export_srt, export_vtt, export_txt, export_json
from backend.services.video_service import (
    separate_audio,
    PLATFORM_PRESETS,
    export_video_for_platform,
    extract_clips_to_temp,
    get_duration_ffprobe,
)

router = APIRouter(prefix="/projects/{project_id}/export", tags=["export"])


# --- Platform video export ---

async def _resolve_bgm(video_path: str) -> tuple[str | None, str | None]:
    """Return (bgm_path, error). Reuses existing stems or runs separation once."""
    try:
        paths = await asyncio.to_thread(separate_audio, video_path, os.path.dirname(video_path))
        return paths["bgm"], None
    except Exception as e:
        return None, f"Could not isolate background music, so the original voices can't be removed: {e}"


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
    logo_start: Optional[float] = None  # timeline seconds the logo appears; None = from the start
    logo_end: Optional[float] = None    # …and disappears; None = until the end
    voice_offset_ms: int = 0  # Voice timing offset in milliseconds to nudge audio alignment with captions (-500 to +500)
    blur_areas: Optional[list[dict]] = None  # regions to blur at render time (percentages of the frame)
    video_filter: Optional[list] = None  # colour filter steps [[name, value], …] from the editor
    duck_music: bool = True  # dip background music while the dubbed voice speaks
    normalize_loudness: bool = True  # even out final audio to streaming loudness


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
            segments_data = await translate_segments(segments_data, body.subtitle_language, shared_glossary=await translation_memory(db, project_id, body.subtitle_language))
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
        music_audio_path, bgm_error = await _resolve_bgm(project.video_path)
        if bgm_error:
            raise HTTPException(500, bgm_error)
        is_valid_bgm = music_audio_path is not None
        if is_valid_bgm:
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
            source_path=project.video_path,
            video_filter=body.video_filter,
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
            logo_start=getattr(body, "logo_start", None),
            logo_end=getattr(body, "logo_end", None),
            blur_areas=body.blur_areas,
            text_overlays=await load_overlays(db, project_id),
            duck_music=body.duck_music,
            normalize_loudness=body.normalize_loudness,
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
    name: Optional[str] = None,
):
    """Download a rendered export. `name` is the filename offered to the browser, so a custom
    export name is kept instead of the internal one."""
    safe_file = os.path.basename(file)
    file_path = os.path.join(settings.upload_dir, "exports", safe_file)
    if not os.path.exists(file_path):
        raise HTTPException(404, "Exported file not found")
    media_type = "application/zip" if safe_file.endswith(".zip") else "video/mp4"
    download_name = os.path.basename(name.strip()) if name and name.strip() else safe_file
    return FileResponse(file_path, media_type=media_type, filename=download_name)


async def run_export(project_id: str, body: VideoExportRequest) -> AsyncGenerator[dict, None]:
    """Render a project export, yielding progress dicts. Used by the live export endpoint and
    by the render queue, so both share exactly the same pipeline."""
    async with async_session() as db:
        result = await db.execute(select(Project).where(Project.id == project_id))
        project = result.scalar_one_or_none()
        if not project:
            raise HTTPException(404, "Project not found")
        if not project.video_path or not os.path.exists(project.video_path):
            raise HTTPException(400, "No video file found for this project")

        overlays = await load_overlays(db, project_id)
        seg_result = await db.execute(
            select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
        )
        all_segments = seg_result.scalars().all()
        clips_result = await db.execute(
            select(VideoClip).where(VideoClip.project_id == project_id).order_by(VideoClip.index)
        )
        all_clips = clips_result.scalars().all()

        srt_path = None
        tts_audio_path = None
        clips_temp_path = None
        export_dir = os.path.join(settings.upload_dir, "exports")
        os.makedirs(export_dir, exist_ok=True)
        safe_name = project.name.replace(" ", "_").replace("/", "_")

        try:
            yield {'type': 'progress', 'percent': 5, 'message': 'Preparing video clips...'}

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

            yield {'type': 'progress', 'percent': 10, 'message': 'Formatting subtitle captions...'}

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
                    segments_data = await translate_segments(segments_data, body.subtitle_language, shared_glossary=await translation_memory(db, project_id, body.subtitle_language))
                srt_content = export_srt(segments_data)
                srt_path = video_source + ".export.srt"
                with open(srt_path, "w", encoding="utf-8") as f:
                    f.write(srt_content)

            yield {'type': 'progress', 'percent': 15, 'message': 'Preparing AI voiceover & background music...'}

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
                yield {'type': 'progress', 'percent': 16, 'message': 'Isolating background music (first time can take a few minutes)...'}
                music_audio_path, bgm_error = await _resolve_bgm(project.video_path)
                if bgm_error:
                    yield {'type': 'error', 'message': bgm_error}
                    return
                is_valid_bgm = music_audio_path is not None
                if is_valid_bgm:
                    mute_original = True
                else:
                    mute_original = False
            elif body.background_audio == "none":
                mute_original = True
            else:
                mute_original = False

            yield {'type': 'progress', 'percent': 20, 'message': 'Rendering video with hardware acceleration...'}

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
                        source_path=project.video_path,
                        video_filter=body.video_filter,
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
                        logo_start=getattr(body, "logo_start", None),
                        logo_end=getattr(body, "logo_end", None),
                        blur_areas=body.blur_areas,
                        text_overlays=overlays,
                        duck_music=body.duck_music,
                        normalize_loudness=body.normalize_loudness,
                    )
                    return ("ok", res)
                except Exception as e:
                    return ("err", str(e))

            render_task = asyncio.create_task(run_render())

            while not render_task.done():
                try:
                    item = await asyncio.wait_for(progress_q.get(), timeout=0.25)
                    yield {'type': 'progress', 'percent': item['percent'], 'message': item['message']}
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
                yield {'type': 'progress', 'percent': 96, 'message': 'Packaging video split parts...'}
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

            # Old renders are copies of files already saved to the user's folder
            from backend.services.video_service import prune_old_exports
            prune_old_exports(settings.upload_dir)

            out_basename = os.path.basename(final_path)
            yield {'type': 'done', 'percent': 100, 'message': 'Video successfully rendered!', 'download_url': f'/api/projects/{project_id}/export/download-temp?file={out_basename}&name={_quote(final_filename)}', 'filename': final_filename, 'saved_path': saved_local_path, 'export_folder': target_folder, 'temp_path': final_path}

        except Exception as e:
            import traceback
            traceback.print_exc()
            yield {'type': 'error', 'message': str(e)}
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


@router.post("/video-stream")
async def export_video_stream_endpoint(
    project_id: str,
    body: VideoExportRequest,
):
    """Export a video, streaming progress as server-sent events."""

    async def event_stream():
        async for evt in run_export(project_id, body):
            yield f"data: {json.dumps(evt)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )



# --- Subtitle export ---
# Registered last: the catch-all "/{format}" would otherwise shadow GET routes like /download-temp

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
        segments = await translate_segments(segments, language, shared_glossary=await translation_memory(db, project_id, language))

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
