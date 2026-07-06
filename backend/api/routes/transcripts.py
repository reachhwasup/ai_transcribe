from __future__ import annotations
import os
import re
import shutil
import subprocess
import tempfile
import uuid
import json
import asyncio
from typing import List
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.database.db import get_db, async_session
from backend.database.models import Project, Segment, VideoClip
from backend.api.schemas import SegmentUpdate, SegmentResponse, TranscribeRequest, ProjectResponse
from backend.services.gemini_service import transcribe_video, transcribe_video_streaming, generate_narration


router = APIRouter(prefix="/projects/{project_id}/transcripts", tags=["transcripts"])


async def _cleanup_segment_audio(db: AsyncSession, project_id: str):
    """Delete TTS audio files on disk for all segments of a project."""
    result = await db.execute(
        select(Segment.audio_url).where(
            Segment.project_id == project_id,
            Segment.audio_url != "",
            Segment.audio_url.isnot(None),
        )
    )
    for (audio_url,) in result.all():
        file_path = audio_url.lstrip("/")
        if file_path and os.path.exists(file_path):
            try:
                os.remove(file_path)
            except OSError:
                pass


def _get_ffmpeg() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found")
    return ffmpeg


async def _extract_clips_video(video_path: str, clips: list[VideoClip]) -> tuple[str | None, list[tuple[float, float]]]:
    """
    If clips don't cover the full video, extract only the clipped portions
    into a temp file using ffmpeg. Returns (temp_path, clip_ranges) where
    clip_ranges are the (source_start, source_end) pairs used.
    Returns (None, []) if no extraction needed (use original).
    """
    if not clips:
        return None, []

    # Sort clips by source_start
    sorted_clips = sorted(clips, key=lambda c: c.source_start)
    clip_ranges = [(c.source_start, c.source_end) for c in sorted_clips]

    # Build ffmpeg concat filter for extracting clip portions
    ffmpeg = _get_ffmpeg()
    tmp_dir = tempfile.mkdtemp(prefix="transcribe_clip_")
    output_path = os.path.join(tmp_dir, "clipped.mp4")

    if len(sorted_clips) == 1:
        # Single clip: simple trim
        c = sorted_clips[0]
        duration = c.source_end - c.source_start
        cmd = [
            ffmpeg, "-y",
            "-ss", str(c.source_start),
            "-i", video_path,
            "-t", str(duration),
            "-c", "copy",
            "-avoid_negative_ts", "make_zero",
            output_path,
        ]
    else:
        # Multiple clips: use complex filter to concat
        filter_parts = []
        for i, c in enumerate(sorted_clips):
            filter_parts.append(
                f"[0:v]trim=start={c.source_start}:end={c.source_end},setpts=PTS-STARTPTS[v{i}];"
                f"[0:a]atrim=start={c.source_start}:end={c.source_end},asetpts=PTS-STARTPTS[a{i}];"
            )
        concat_v = "".join(f"[v{i}]" for i in range(len(sorted_clips)))
        concat_a = "".join(f"[a{i}]" for i in range(len(sorted_clips)))
        filter_complex = "".join(filter_parts) + f"{concat_v}{concat_a}concat=n={len(sorted_clips)}:v=1:a=1[outv][outa]"
        cmd = [
            ffmpeg, "-y",
            "-i", video_path,
            "-filter_complex", filter_complex,
            "-map", "[outv]", "-map", "[outa]",
            output_path,
        ]

    result = await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=True, timeout=300
    )
    if result.returncode != 0:
        # Cleanup on failure
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise RuntimeError(f"ffmpeg clip extraction failed: {result.stderr[-300:]}")

    return output_path, clip_ranges


def _offset_segments_to_clips(segments: list[dict], clip_ranges: list[tuple[float, float]]) -> list[dict]:
    """
    Map timestamps from concatenated clip-space back to original video time.
    Gemini returns timestamps relative to the clipped video (starting from 0).
    We need to offset them back to the original video's time.
    """
    if not clip_ranges:
        return segments

    # Build a mapping: for each position in the concatenated clip,
    # determine which clip it falls in and offset accordingly
    clip_offsets = []  # (concat_start, concat_end, source_start)
    concat_pos = 0.0
    for src_start, src_end in clip_ranges:
        clip_dur = src_end - src_start
        clip_offsets.append((concat_pos, concat_pos + clip_dur, src_start))
        concat_pos += clip_dur

    total_clip_duration = concat_pos

    def map_time(t: float) -> float:
        for concat_start, concat_end, source_start in clip_offsets:
            if t <= concat_end + 0.1:  # small tolerance
                return source_start + (t - concat_start)
        # Past the end — clamp to last clip's end
        if clip_ranges:
            return clip_ranges[-1][1]
        return t

    result = []
    for seg in segments:
        mapped_start = map_time(seg["start_time"])
        mapped_end = map_time(seg["end_time"])
        # Only keep segments that fall within clip boundaries
        if mapped_end > mapped_start:
            seg["start_time"] = round(mapped_start, 2)
            seg["end_time"] = round(mapped_end, 2)
            result.append(seg)

    return result


@router.post("/bulk-voice", response_model=list)
async def bulk_update_voice(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Update voice_profile for multiple segments at once."""
    voice = body.get("voice_profile", "female")
    segment_ids = body.get("segment_ids")  # None means all

    if segment_ids:
        stmt = select(Segment).where(
            Segment.project_id == project_id,
            Segment.id.in_(segment_ids),
        )
    else:
        stmt = select(Segment).where(Segment.project_id == project_id)

    result = await db.execute(stmt)
    segments = result.scalars().all()
    import os
    for seg in segments:
        if seg.voice_profile != voice and seg.audio_url:
            old_path = seg.audio_url.lstrip("/")
            if os.path.exists(old_path):
                os.remove(old_path)
            seg.audio_url = ""
            seg.audio_speed = 1.0
        seg.voice_profile = voice
    await db.commit()
    return [SegmentResponse.model_validate(s) for s in segments]


@router.post("/generate", response_model=ProjectResponse)
async def generate_transcript(
    project_id: str,
    request: TranscribeRequest = TranscribeRequest(),
    db: AsyncSession = Depends(get_db),
):
    """Transcribe the project video using Gemini API."""
    result = await db.execute(
        select(Project).options(selectinload(Project.video_clips)).where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    if not project.video_path:
        raise HTTPException(400, "No video uploaded for this project")

    project.status = "transcribing"
    await db.commit()

    clipped_path = None
    try:
        # Check if clips are trimmed
        video_clips = project.video_clips or []
        clip_ranges = []
        needs_clip = False
        if video_clips:
            full_duration = project.duration or 0.0
            total_clip_dur = sum(c.source_end - c.source_start for c in video_clips)
            if full_duration > 0 and abs(total_clip_dur - full_duration) > 0.5:
                needs_clip = True
            elif len(video_clips) > 1:
                needs_clip = True

        actual_path = project.video_path
        if needs_clip:
            clipped_path, clip_ranges = await _extract_clips_video(project.video_path, video_clips)
            actual_path = clipped_path

        # Transcribe using Gemini
        segments_data = await transcribe_video(
            actual_path,
            language=request.language or project.language,
        )

        # Offset timestamps if we used a clipped video
        if clip_ranges:
            segments_data = _offset_segments_to_clips(segments_data, clip_ranges)

        # Delete existing segments and their TTS audio files
        await _cleanup_segment_audio(db, project_id)
        await db.execute(
            delete(Segment).where(Segment.project_id == project_id)
        )

        # Create new segments
        for i, seg_data in enumerate(segments_data):
            segment = Segment(
                id=str(uuid.uuid4()),
                project_id=project_id,
                index=i,
                start_time=seg_data["start_time"],
                end_time=seg_data["end_time"],
                text=seg_data["text"],
                original_text=seg_data["text"],
                speaker=seg_data.get("speaker", ""),
                voice_profile=seg_data.get("voice_profile", "female"),
                emotion=seg_data.get("emotion", "neutral"),
            )
            db.add(segment)

        project.status = "completed"
        project.language = request.language or project.language
        await db.commit()

    except Exception as e:
        project.status = "error"
        await db.commit()
        raise HTTPException(500, f"Transcription failed: {str(e)}")
    finally:
        if clipped_path and os.path.exists(clipped_path):
            tmp_dir = os.path.dirname(clipped_path)
            shutil.rmtree(tmp_dir, ignore_errors=True)

    result = await db.execute(
        select(Project)
        .options(selectinload(Project.segments))
        .where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    return ProjectResponse.model_validate(project)


@router.get("/", response_model=List[SegmentResponse])
async def list_segments(project_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Segment)
        .where(Segment.project_id == project_id)
        .order_by(Segment.start_time)
    )
    return [SegmentResponse.model_validate(s) for s in result.scalars().all()]


@router.patch("/{segment_id}", response_model=SegmentResponse)
async def update_segment(
    project_id: str,
    segment_id: str,
    data: SegmentUpdate,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Segment).where(Segment.id == segment_id, Segment.project_id == project_id)
    )
    segment = result.scalar_one_or_none()
    if not segment:
        raise HTTPException(404, "Segment not found")

    updates = data.model_dump(exclude_unset=True)

    # If voice_profile, voice_name, or text changes, clear stale AI audio.
    # For timing changes, only invalidate if the segment *duration* changes
    # (moving a segment without changing its length should keep generated audio).
    invalidate = False
    if "voice_profile" in updates and updates["voice_profile"] != segment.voice_profile:
        invalidate = True
    if "voice_name" in updates and updates["voice_name"] != segment.voice_name:
        invalidate = True
    if "text" in updates and updates["text"] != segment.text:
        invalidate = True
    if "emotion" in updates and updates["emotion"] != segment.emotion:
        invalidate = True

    old_duration = segment.end_time - segment.start_time
    new_start = updates.get("start_time", segment.start_time)
    new_end = updates.get("end_time", segment.end_time)
    new_duration = new_end - new_start
    if abs(new_duration - old_duration) > 0.05:
        invalidate = True

    if invalidate and segment.audio_url:
        import os
        old_path = segment.audio_url.lstrip("/")
        if os.path.exists(old_path):
            os.remove(old_path)
        segment.audio_url = ""
        segment.audio_speed = 1.0

    for field, value in updates.items():
        setattr(segment, field, value)

    await db.commit()
    await db.refresh(segment)
    return SegmentResponse.model_validate(segment)


@router.delete("/{segment_id}", status_code=204)
async def delete_segment(
    project_id: str,
    segment_id: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Segment).where(Segment.id == segment_id, Segment.project_id == project_id)
    )
    segment = result.scalar_one_or_none()
    if not segment:
        raise HTTPException(404, "Segment not found")

    await db.delete(segment)
    await db.commit()


@router.post("/", response_model=SegmentResponse, status_code=201)
async def add_segment(
    project_id: str,
    data: SegmentUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Manually add a new segment."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    # Get next index
    result = await db.execute(
        select(Segment)
        .where(Segment.project_id == project_id)
        .order_by(Segment.index.desc())
    )
    last = result.scalars().first()
    next_index = (last.index + 1) if last else 0

    segment = Segment(
        id=str(uuid.uuid4()),
        project_id=project_id,
        index=next_index,
        start_time=data.start_time or 0.0,
        end_time=data.end_time or 0.0,
        text=data.text or "",
        original_text=data.text or "",
        speaker=data.speaker or "",
        voice_profile=data.voice_profile or "",
        voice_name=data.voice_name or "",
        audio_url=data.audio_url or "",
        audio_speed=data.audio_speed or 1.0,
    )
    db.add(segment)
    await db.commit()
    await db.refresh(segment)
    return SegmentResponse.model_validate(segment)


@router.delete("/all", status_code=204)
async def clear_all_segments(
    project_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Delete all subtitle segments for a project."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    if not result.scalar_one_or_none():
        raise HTTPException(404, "Project not found")
    await _cleanup_segment_audio(db, project_id)
    await db.execute(delete(Segment).where(Segment.project_id == project_id))
    await db.commit()


def _parse_srt(content: str) -> list[dict]:
    """Parse SRT subtitle content into a list of segment dicts."""
    segments = []
    # Split on double newlines to get blocks
    blocks = re.split(r'\n\s*\n', content.strip())
    for block in blocks:
        lines = block.strip().splitlines()
        if len(lines) < 3:
            continue
        # lines[0] = index, lines[1] = timecode, lines[2+] = text
        time_match = re.match(
            r'(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})',
            lines[1].strip()
        )
        if not time_match:
            continue
        g = time_match.groups()
        start = int(g[0]) * 3600 + int(g[1]) * 60 + int(g[2]) + int(g[3]) / 1000
        end = int(g[4]) * 3600 + int(g[5]) * 60 + int(g[6]) + int(g[7]) / 1000
        text = " ".join(lines[2:]).strip()
        if text and end > start:
            segments.append({"text": text, "start_time": start, "end_time": end})
    return segments


@router.post("/import-srt", response_model=List[SegmentResponse], status_code=201)
async def import_srt(
    project_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    """Import an SRT subtitle file, replacing all current segments."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    raw = await file.read()
    try:
        content = raw.decode("utf-8-sig")  # handle BOM
    except UnicodeDecodeError:
        content = raw.decode("latin-1", errors="replace")

    parsed = _parse_srt(content)
    if not parsed:
        raise HTTPException(400, "No valid subtitle entries found in SRT file")

    # Clear existing segments and their TTS audio files
    await _cleanup_segment_audio(db, project_id)
    await db.execute(delete(Segment).where(Segment.project_id == project_id))

    # Create new segments
    new_segments = []
    for i, seg_data in enumerate(parsed):
        seg = Segment(
            id=str(uuid.uuid4()),
            project_id=project_id,
            index=i,
            start_time=seg_data["start_time"],
            end_time=seg_data["end_time"],
            text=seg_data["text"],
            original_text=seg_data["text"],
        )
        db.add(seg)
        new_segments.append(seg)

    await db.commit()
    for seg in new_segments:
        await db.refresh(seg)
    return [SegmentResponse.model_validate(s) for s in new_segments]


@router.post("/generate-stream")
async def generate_transcript_stream(
    project_id: str,
    request: TranscribeRequest = TranscribeRequest(),
):
    """Stream transcription segments via SSE as they arrive from Gemini."""

    # Validate project first (using a separate session since SSE is long-lived)
    async with async_session() as db:
        result = await db.execute(select(Project).where(Project.id == project_id))
        project = result.scalar_one_or_none()
        if not project:
            raise HTTPException(404, "Project not found")
        if not project.video_path:
            raise HTTPException(400, "No video uploaded for this project")

        video_path = project.video_path
        full_duration = project.duration or 0.0
        language = request.language or project.language

        # Load video clips to determine trim boundaries
        clip_result = await db.execute(
            select(VideoClip)
            .where(VideoClip.project_id == project_id)
            .order_by(VideoClip.index)
        )
        video_clips = clip_result.scalars().all()

        project.status = "transcribing"
        await db.commit()

    async def event_stream():
        segment_index = 0
        clipped_path = None
        clip_ranges = []
        try:
            # Send start event
            yield f"data: {json.dumps({'type': 'start'})}\n\n"

            # Check if clips are trimmed (don't cover the full video)
            needs_clip = False
            if video_clips:
                total_clip_dur = sum(c.source_end - c.source_start for c in video_clips)
                if full_duration > 0 and abs(total_clip_dur - full_duration) > 0.5:
                    needs_clip = True
                elif len(video_clips) > 1:
                    needs_clip = True

            if needs_clip:
                yield f"data: {json.dumps({'type': 'progress', 'message': 'Extracting clipped video...'})}\n\n"
                clipped_path, clip_ranges = await _extract_clips_video(video_path, video_clips)

            actual_video_path = clipped_path if clipped_path else video_path

            # Delete existing segments and their TTS audio files
            async with async_session() as db:
                await _cleanup_segment_audio(db, project_id)
                await db.execute(
                    delete(Segment).where(Segment.project_id == project_id)
                )
                await db.commit()

            # Collect all segments first, then offset timestamps if clipped
            raw_segments = []
            async for item in transcribe_video_streaming(actual_video_path, language):
                # Progress update (not a segment)
                if "_progress" in item:
                    yield f"data: {json.dumps({'type': 'progress', 'message': item['_progress']})}\n\n"
                    continue
                raw_segments.append(item)

            # Offset timestamps from clip-space back to original video time
            if clip_ranges:
                segments_to_save = _offset_segments_to_clips(raw_segments, clip_ranges)
            else:
                segments_to_save = raw_segments

            for seg_data in segments_to_save:
                seg_id = str(uuid.uuid4())

                # Save segment to DB immediately
                async with async_session() as db:
                    segment = Segment(
                        id=seg_id,
                        project_id=project_id,
                        index=segment_index,
                        start_time=seg_data["start_time"],
                        end_time=seg_data["end_time"],
                        text=seg_data["text"],
                        original_text=seg_data["text"],
                        speaker=seg_data.get("speaker", ""),
                        voice_profile=seg_data.get("voice_profile", "female"),
                        emotion=seg_data.get("emotion", "neutral"),
                    )
                    db.add(segment)
                    await db.commit()

                # Send segment to client
                seg_response = {
                    "type": "segment",
                    "segment": {
                        "id": seg_id,
                        "project_id": project_id,
                        "index": segment_index,
                        "start_time": seg_data["start_time"],
                        "end_time": seg_data["end_time"],
                        "text": seg_data["text"],
                        "original_text": seg_data["text"],
                        "speaker": seg_data.get("speaker", ""),
                        "voice_profile": seg_data.get("voice_profile", "female"),
                        "emotion": seg_data.get("emotion", "neutral"),
                    },
                }
                yield f"data: {json.dumps(seg_response)}\n\n"
                segment_index += 1

            # Mark project completed
            async with async_session() as db:
                result = await db.execute(select(Project).where(Project.id == project_id))
                project = result.scalar_one_or_none()
                if project:
                    project.status = "completed"
                    project.language = language
                    await db.commit()

            yield f"data: {json.dumps({'type': 'done', 'total_segments': segment_index})}\n\n"

        except Exception as e:
            # Mark project as error
            async with async_session() as db:
                result = await db.execute(select(Project).where(Project.id == project_id))
                project = result.scalar_one_or_none()
                if project:
                    project.status = "error"
                    await db.commit()

            # Log the raw error for debugging
            import sys, traceback
            err_str = str(e)
            err_type = type(e).__name__
            print(f"[TRANSCRIBE ERROR] {err_type}: {err_str}", file=sys.stderr, flush=True)
            traceback.print_exc(file=sys.stderr)

            # Provide user-friendly messages for known errors
            if "429" in err_str or "quota" in err_str.lower() or ("resource" in err_str.lower() and "exhausted" in err_str.lower()):
                msg = (
                    "API quota exceeded. Your Gemini API key has reached its rate limit. "
                    "Please try: (1) Wait a few minutes and retry, "
                    "(2) Add another API key in Settings, or "
                    "(3) Upgrade to a paid Gemini plan at https://aistudio.google.com"
                )
            elif "api key" in err_str.lower() or "authenticate" in err_str.lower() or "permission" in err_str.lower():
                msg = "Invalid API key. Please check your Gemini API key in Settings."
            else:
                msg = err_str

            # Include raw error info for debugging
            yield f"data: {json.dumps({'type': 'error', 'message': msg})}\n\n"

        finally:
            # Clean up temp clipped video
            if clipped_path and os.path.exists(clipped_path):
                tmp_dir = os.path.dirname(clipped_path)
                shutil.rmtree(tmp_dir, ignore_errors=True)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/translate")
async def translate_segments_endpoint(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Translate all project segments to a target language using Gemini."""
    target_language = body.get("language", "en")

    result = await db.execute(
        select(Segment)
        .where(Segment.project_id == project_id)
        .order_by(Segment.start_time)
    )
    segments = [
        {
            "id": s.id,
            "start_time": s.start_time,
            "end_time": s.end_time,
            "text": s.text,
            "speaker": s.speaker,
        }
        for s in result.scalars().all()
    ]

    if not segments:
        return []

    from backend.services.gemini_service import translate_segments
    translated = await translate_segments(segments, target_language)
    return translated


@router.post("/retranscribe-selected")
async def retranscribe_selected_segments(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Re-transcribe only the selected segments by extracting their time ranges from the video."""
    segment_ids = body.get("segment_ids", [])
    if not segment_ids:
        raise HTTPException(400, "No segment IDs provided")

    result = await db.execute(
        select(Project).where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")
    if not project.video_path:
        raise HTTPException(400, "No video uploaded for this project")

    # Fetch the selected segments
    result = await db.execute(
        select(Segment)
        .where(Segment.id.in_(segment_ids), Segment.project_id == project_id)
        .order_by(Segment.start_time)
    )
    old_segments = result.scalars().all()
    if not old_segments:
        raise HTTPException(404, "No matching segments found")

    language = project.language or "km"
    video_path = project.video_path
    ffmpeg = _get_ffmpeg()

    # Combine all selected segments into one time range with small padding
    min_start = max(0, min(s.start_time for s in old_segments) - 0.5)
    max_end = max(s.end_time for s in old_segments) + 0.5

    # Extract the time range from the video into a temp file
    tmp_dir = tempfile.mkdtemp(prefix="retranscribe_")
    clip_path = os.path.join(tmp_dir, "clip.mp4")
    try:
        duration = max_end - min_start
        cmd = [
            ffmpeg, "-y",
            "-ss", str(min_start),
            "-i", video_path,
            "-t", str(duration),
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
            "-c:a", "aac",
            "-avoid_negative_ts", "make_zero",
            clip_path,
        ]
        proc = await asyncio.to_thread(
            subprocess.run, cmd, capture_output=True, text=True, timeout=60
        )
        if proc.returncode != 0 or not os.path.exists(clip_path):
            raise HTTPException(500, "Failed to extract video clip for re-transcription")

        # Transcribe just this clip
        segments_data = await transcribe_video(clip_path, language=language)

        # If Gemini returned nothing, keep the original segments unchanged
        if not segments_data:
            return [SegmentResponse.model_validate(s) for s in old_segments]

        # Offset timestamps back to original video time
        for seg in segments_data:
            seg["start_time"] = round(seg["start_time"] + min_start, 3)
            seg["end_time"] = round(seg["end_time"] + min_start, 3)

        # Delete old TTS audio files for the selected segments
        for old_seg in old_segments:
            if old_seg.audio_url:
                file_path = old_seg.audio_url.lstrip("/")
                if file_path and os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                    except OSError:
                        pass

        # Delete old segments from DB
        for old_seg in old_segments:
            await db.delete(old_seg)
        await db.flush()

        # Find the correct index offset for inserting new segments
        remaining = await db.execute(
            select(Segment)
            .where(Segment.project_id == project_id)
            .order_by(Segment.start_time)
        )
        remaining_segs = remaining.scalars().all()
        # Find insertion position by start_time
        insert_idx = 0
        for i, rs in enumerate(remaining_segs):
            if rs.start_time > min_start:
                insert_idx = i
                break
            insert_idx = i + 1

        # Create new segments — preserve voice_profile from old segments when possible
        old_voice = old_segments[0].voice_profile if old_segments else "female"
        new_segments = []
        for j, seg_data in enumerate(segments_data):
            seg = Segment(
                id=str(uuid.uuid4()),
                project_id=project_id,
                index=insert_idx + j,
                start_time=seg_data["start_time"],
                end_time=seg_data["end_time"],
                text=seg_data["text"],
                original_text=seg_data["text"],
                speaker=seg_data.get("speaker", ""),
                voice_profile=seg_data.get("voice_profile", old_voice),
                emotion=seg_data.get("emotion", "neutral"),
            )
            db.add(seg)
            new_segments.append(seg)

        # Re-index all segments
        await db.flush()
        all_result = await db.execute(
            select(Segment)
            .where(Segment.project_id == project_id)
            .order_by(Segment.start_time)
        )
        for idx, seg in enumerate(all_result.scalars().all()):
            seg.index = idx

        await db.commit()

        # Return ALL segments so the frontend gets the complete list
        final_result = await db.execute(
            select(Segment)
            .where(Segment.project_id == project_id)
            .order_by(Segment.start_time)
        )
        all_segments = final_result.scalars().all()
        return [SegmentResponse.model_validate(s) for s in all_segments]

    except HTTPException:
        raise
    except Exception as e:
        await db.rollback()
        raise HTTPException(500, f"Re-transcription failed: {str(e)}")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@router.post("/generate-narration")
async def generate_narration_endpoint(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Generate AI narration/voiceover script for the video."""
    result = await db.execute(
        select(Project).where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")
    if not project.video_path:
        raise HTTPException(400, "No video uploaded for this project")

    language = body.get("language", project.language or "km")
    style = body.get("style", "summary")

    try:
        narration_segments = await generate_narration(
            project.video_path, language=language, style=style
        )
        return {"segments": narration_segments, "style": style, "language": language}
    except Exception as e:
        raise HTTPException(500, f"Narration generation failed: {str(e)}")


@router.post("/apply-narration")
async def apply_narration_segments(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Replace project segments with narration segments."""
    narration_segments = body.get("segments", [])
    if not narration_segments:
        raise HTTPException(400, "No narration segments provided")

    result = await db.execute(
        select(Project).where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    # Delete existing segments and their audio files
    existing = await db.execute(
        select(Segment).where(Segment.project_id == project_id)
    )
    for seg in existing.scalars().all():
        if seg.audio_url:
            file_path = seg.audio_url.lstrip("/")
            if file_path and os.path.exists(file_path):
                try:
                    os.remove(file_path)
                except OSError:
                    pass
        await db.delete(seg)
    await db.flush()

    # Normalize timings so segments always fit the timeline: sort, clamp to
    # the video duration, drop empty windows, and trim overlaps.
    duration = project.duration or 0.0
    narration_segments = sorted(narration_segments, key=lambda s: float(s.get("start_time", 0)))
    normalized = []
    for seg_data in narration_segments:
        start = max(0.0, float(seg_data.get("start_time", 0)))
        end = float(seg_data.get("end_time", 0))
        if duration > 0:
            start = min(start, duration)
            end = min(end, duration)
        if normalized and start < normalized[-1]["end_time"]:
            start = normalized[-1]["end_time"]
        if end - start < 0.3:
            continue
        normalized.append({**seg_data, "start_time": start, "end_time": end})
    narration_segments = normalized
    if not narration_segments:
        raise HTTPException(400, "No narration segments fit within the video duration")

    # Create new segments from narration. Dialogue segments (actor lines)
    # keep the character as speaker and use a gender-matched voice; narration
    # segments use the chosen narrator voice.
    voice = body.get("voice_profile", "female")
    new_segments = []
    for i, seg_data in enumerate(narration_segments):
        is_dialogue = str(seg_data.get("type") or "narration") == "dialogue"
        gender = str(seg_data.get("gender") or "").lower()
        if is_dialogue:
            speaker = str(seg_data.get("speaker") or "").strip() or "Actor"
            voice_profile = "male" if gender == "male" else "female"
        else:
            speaker = "Narrator"
            voice_profile = voice
        seg = Segment(
            id=str(uuid.uuid4()),
            project_id=project_id,
            index=i,
            start_time=float(seg_data["start_time"]),
            end_time=float(seg_data["end_time"]),
            text=str(seg_data["text"]),
            original_text=str(seg_data["text"]),
            speaker=speaker,
            voice_profile=voice_profile,
            emotion=str(seg_data.get("emotion") or "neutral") or "neutral",
        )
        db.add(seg)
        new_segments.append(seg)

    await db.commit()
    for seg in new_segments:
        await db.refresh(seg)

    return [SegmentResponse.model_validate(s) for s in new_segments]
