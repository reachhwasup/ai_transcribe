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
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.database.db import get_db, async_session
from backend.database.models import Project, Segment, VideoClip
from backend.api.schemas import SegmentUpdate, SegmentResponse, TranscribeRequest, ProjectResponse
from backend.services.gemini_service import (
    transcribe_video,
    transcribe_video_streaming,
    generate_narration,
    run_ai_agent,
    generate_movie_titles,
    generate_social_media_script,
)
from backend.services.tts_service import assign_speaker_voices, generate_segment_audio


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

    # Sort clips by index (timeline playback order)
    sorted_clips = sorted(clips, key=lambda c: c.index)
    clip_ranges = [(c.source_start, c.source_end) for c in sorted_clips]

    # Build ffmpeg concat filter for extracting clip portions
    ffmpeg = _get_ffmpeg()
    tmp_dir = tempfile.mkdtemp(prefix="transcribe_clip_")
    output_path = os.path.join(tmp_dir, "clipped.mp4")

    if len(sorted_clips) == 1:
        # Single clip: sample-accurate ultrafast trim
        c = sorted_clips[0]
        duration = c.source_end - c.source_start
        cmd = [
            ffmpeg, "-y",
            "-ss", str(c.source_start),
            "-i", video_path,
            "-t", str(duration),
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
            "-c:a", "aac", "-b:a", "128k",
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
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
            "-c:a", "aac", "-b:a", "128k",
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

    clip_offsets = []  # (concat_start, concat_end, source_start, source_end)
    concat_pos = 0.0
    for src_start, src_end in clip_ranges:
        clip_dur = src_end - src_start
        clip_offsets.append((concat_pos, concat_pos + clip_dur, src_start, src_end))
        concat_pos += clip_dur

    def map_time(t: float) -> float:
        for concat_start, concat_end, source_start, source_end in clip_offsets:
            if t < concat_end:
                return source_start + max(0, t - concat_start)
        return clip_offsets[-1][3] if clip_offsets else t

    result = []
    for seg in segments:
        mapped_start = map_time(seg["start_time"])
        mapped_end = map_time(seg["end_time"])
        if mapped_end > mapped_start:
            seg["start_time"] = round(mapped_start, 2)
            seg["end_time"] = round(mapped_end, 2)
            result.append(seg)
        elif clip_offsets and mapped_start < clip_offsets[-1][3]:
            seg["start_time"] = round(mapped_start, 2)
            seg["end_time"] = round(mapped_start + 1.5, 2)
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

        # Give each detected speaker their own TTS voice
        assign_speaker_voices(segments_data, request.language or project.language)

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
                original_text=seg_data.get("original_text", seg_data["text"]),
                speaker=seg_data.get("speaker", ""),
                voice_profile=seg_data.get("voice_profile", "female"),
                voice_name=seg_data.get("voice_name", ""),
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


class RechunkRequest(BaseModel):
    words_per_segment: int = 7  # 1, 3, 5, 7, 10, 0 (0 = full sentences)


@router.post("/rechunk")
async def rechunk_segments(
    project_id: str,
    body: RechunkRequest,
    db: AsyncSession = Depends(get_db),
):
    """Re-chunk current subtitle segments according to the desired words-per-caption limit."""
    result = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    old_segments = result.scalars().all()
    if not old_segments:
        return []

    w_limit = body.words_per_segment
    new_segments_data = []

    if w_limit <= 0:
        # Merge into continuous full sentences
        current_words = []
        seg_start = old_segments[0].start_time
        seg_speaker = old_segments[0].speaker
        seg_voice = old_segments[0].voice_profile
        last_end = old_segments[0].end_time

        for seg in old_segments:
            words = seg.text.strip().split()
            if not words:
                continue
            if (seg.start_time - last_end > 1.5) or (seg.speaker != seg_speaker and current_words):
                new_segments_data.append({
                    "start_time": seg_start,
                    "end_time": last_end,
                    "text": " ".join(current_words),
                    "speaker": seg_speaker,
                    "voice_profile": seg_voice,
                })
                current_words = []
                seg_start = seg.start_time
                seg_speaker = seg.speaker
                seg_voice = seg.voice_profile

            current_words.extend(words)
            last_end = seg.end_time

        if current_words:
            new_segments_data.append({
                "start_time": seg_start,
                "end_time": last_end,
                "text": " ".join(current_words),
                "speaker": seg_speaker,
                "voice_profile": seg_voice,
            })
    else:
        # Split segments into word chunks of max size w_limit
        for seg in old_segments:
            raw_text = seg.text.strip()
            words = raw_text.split()
            if not words:
                continue

            if len(words) <= w_limit:
                new_segments_data.append({
                    "start_time": seg.start_time,
                    "end_time": seg.end_time,
                    "text": raw_text,
                    "speaker": seg.speaker,
                    "voice_profile": seg.voice_profile,
                })
            else:
                total_duration = max(0.2, seg.end_time - seg.start_time)
                total_chars = max(1, sum(len(w) for w in words))
                chunks = [words[i:i + w_limit] for i in range(0, len(words), w_limit)]
                cur_time = seg.start_time

                for idx, chunk in enumerate(chunks):
                    chunk_text = " ".join(chunk)
                    chunk_chars = sum(len(w) for w in chunk)
                    chunk_dur = (chunk_chars / total_chars) * total_duration
                    chunk_end = min(seg.end_time, cur_time + chunk_dur)
                    if idx == len(chunks) - 1:
                        chunk_end = seg.end_time

                    new_segments_data.append({
                        "start_time": round(cur_time, 3),
                        "end_time": round(chunk_end, 3),
                        "text": chunk_text,
                        "speaker": seg.speaker,
                        "voice_profile": seg.voice_profile,
                    })
                    cur_time = chunk_end

    # Delete old segments and insert newly chunked ones
    await db.execute(delete(Segment).where(Segment.project_id == project_id))
    created_segments = []
    for i, s_data in enumerate(new_segments_data):
        new_seg = Segment(
            id=str(uuid.uuid4()),
            project_id=project_id,
            index=i,
            start_time=s_data["start_time"],
            end_time=s_data["end_time"],
            text=s_data["text"],
            original_text=s_data["text"],
            speaker=s_data["speaker"],
            voice_profile=s_data["voice_profile"],
        )
        db.add(new_seg)
        created_segments.append(new_seg)

    await db.commit()
    return [{"id": s.id, "start_time": s.start_time, "end_time": s.end_time, "text": s.text, "speaker": s.speaker} for s in created_segments]


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

            # Stream and save segments immediately as each chunk arrives!
            async for item in transcribe_video_streaming(actual_video_path, language):
                # Progress update (not a segment)
                if "_progress" in item:
                    prog_evt = {
                        'type': 'progress',
                        'message': item['_progress'],
                        'current_chunk': item.get('current_chunk', 0),
                        'total_chunks': item.get('total_chunks', 0),
                        'percent': item.get('percent', 0),
                    }
                    yield f"data: {json.dumps(prog_evt)}\n\n"
                    continue

                seg_data = item
                if clip_ranges:
                    seg_data_list = _offset_segments_to_clips([seg_data], clip_ranges)
                    if seg_data_list:
                        seg_data = seg_data_list[0]

                seg_id = str(uuid.uuid4())
                speaker = str(seg_data.get("speaker", f"Speaker {segment_index + 1}")).strip()
                voice_profile = seg_data.get("voice_profile", "female")
                voice_name = seg_data.get("voice_name", "")
                emotion = seg_data.get("emotion", "neutral")

                # Save segment to DB immediately
                orig_text = seg_data.get("original_text", seg_data["text"])
                async with async_session() as db:
                    segment = Segment(
                        id=seg_id,
                        project_id=project_id,
                        index=segment_index,
                        start_time=seg_data["start_time"],
                        end_time=seg_data["end_time"],
                        text=seg_data["text"],
                        original_text=orig_text,
                        speaker=speaker,
                        voice_profile=voice_profile,
                        voice_name=voice_name,
                        emotion=emotion,
                    )
                    db.add(segment)
                    await db.commit()

                # Send segment to client immediately so it appears on screen one-by-one
                seg_response = {
                    "type": "segment",
                    "segment": {
                        "id": seg_id,
                        "project_id": project_id,
                        "index": segment_index,
                        "start_time": seg_data["start_time"],
                        "end_time": seg_data["end_time"],
                        "text": seg_data["text"],
                        "original_text": orig_text,
                        "speaker": speaker,
                        "voice_profile": voice_profile,
                        "voice_name": voice_name,
                        "emotion": emotion,
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


@router.post("/sanitize-timeline")
@router.post("/sanitize-timeline/")
async def sanitize_project_timeline(
    project_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Sanitize all project segments: resolve overlaps, fix minute rollovers, and remove duplicates."""
    from backend.services.gemini_service import sanitize_segments

    result = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    db_segments = list(result.scalars().all())
    if not db_segments:
        return []

    raw = [
        {
            "id": s.id,
            "index": s.index,
            "start_time": s.start_time,
            "end_time": s.end_time,
            "text": s.text,
            "original_text": s.original_text,
            "speaker": s.speaker,
            "voice_profile": s.voice_profile,
            "voice_name": s.voice_name,
            "emotion": s.emotion,
            "audio_path": s.audio_path,
        }
        for s in db_segments
    ]

    sanitized = sanitize_segments(raw)

    # Delete existing and replace with sanitized
    await db.execute(delete(Segment).where(Segment.project_id == project_id))

    new_db_segs = []
    for idx, s in enumerate(sanitized):
        seg_id = s.get("id") or str(uuid.uuid4())
        seg = Segment(
            id=seg_id,
            project_id=project_id,
            index=idx,
            start_time=s["start_time"],
            end_time=s["end_time"],
            text=s["text"],
            original_text=s.get("original_text", s["text"]),
            speaker=s.get("speaker", "Speaker 1"),
            voice_profile=s.get("voice_profile", "female"),
            voice_name=s.get("voice_name", ""),
            emotion=s.get("emotion", "neutral"),
            audio_path=s.get("audio_path", ""),
        )
        db.add(seg)
        new_db_segs.append(seg)

    await db.commit()
    return [
        {
            "id": s.id,
            "project_id": s.project_id,
            "index": s.index,
            "start_time": s.start_time,
            "end_time": s.end_time,
            "text": s.text,
            "original_text": s.original_text,
            "speaker": s.speaker,
            "voice_profile": s.voice_profile,
            "voice_name": s.voice_name,
            "emotion": s.emotion,
            "audio_path": s.audio_path,
        }
        for s in new_db_segs
    ]


@router.post("/translate")
@router.post("/translate/")
async def translate_project_segments(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Translate all or selected project segments to a target language using Gemini and save to DB."""
    target_language = body.get("language", "km")
    segment_ids = body.get("segment_ids", None)

    query = select(Segment).where(Segment.project_id == project_id)
    if segment_ids:
        query = query.where(Segment.id.in_(segment_ids))
    query = query.order_by(Segment.start_time)

    result = await db.execute(query)
    db_segments = list(result.scalars().all())
    if not db_segments:
        return []

    segments = [
        {
            "id": s.id,
            "start_time": s.start_time,
            "end_time": s.end_time,
            "text": s.original_text if (s.original_text and s.original_text.strip()) else s.text,
            "speaker": s.speaker,
        }
        for s in db_segments
    ]

    from backend.services.gemini_service import translate_segments
    translated = await translate_segments(segments, target_language)

    for i, t_seg in enumerate(translated):
        if i < len(db_segments):
            db_segments[i].text = t_seg.get("text", db_segments[i].text)
            new_spk = t_seg.get("speaker")
            if new_spk and not re.search(r'[\u4E00-\u9FFF]', new_spk):
                db_segments[i].speaker = new_spk

    await db.commit()
    return [SegmentResponse.model_validate(s) for s in db_segments]


@router.post("/translate-stream")
@router.post("/translate-stream/")
async def translate_project_segments_stream(
    project_id: str,
    body: dict,
):
    """Stream translation progress and update segments in real-time as each chunk completes."""
    target_language = body.get("language", "km")
    segment_ids = body.get("segment_ids", None)

    async def event_stream():
        async with async_session() as db:
            query = select(Segment).where(Segment.project_id == project_id)
            if segment_ids:
                query = query.where(Segment.id.in_(segment_ids))
            query = query.order_by(Segment.start_time)
            result = await db.execute(query)
            db_segments = list(result.scalars().all())

        if not db_segments:
            yield f"data: {json.dumps({'type': 'done', 'total': 0})}\n\n"
            return

        segments = [
            {
                "id": s.id,
                "start_time": s.start_time,
                "end_time": s.end_time,
                "text": s.original_text if (s.original_text and s.original_text.strip()) else s.text,
                "speaker": s.speaker,
            }
            for s in db_segments
        ]

        from backend.services.gemini_service import translate_segments_stream

        try:
            async for item in translate_segments_stream(segments, target_language):
                seg_id = item.get("id")
                new_text = item.get("text", "")
                if seg_id and new_text:
                    async with async_session() as db:
                        result = await db.execute(select(Segment).where(Segment.id == seg_id))
                        db_seg = result.scalar_one_or_none()
                        if db_seg:
                            db_seg.text = new_text
                            await db.commit()
                            await db.refresh(db_seg)
                            yield f"data: {json.dumps({'type': 'segment_updated', 'segment': SegmentResponse.model_validate(db_seg).model_dump(mode='json'), 'current': item.get('current'), 'total': item.get('total'), 'percent': item.get('percent')})}\n\n"
                        else:
                            yield f"data: {json.dumps({'type': 'progress', 'current': item.get('current'), 'total': item.get('total'), 'percent': item.get('percent'), 'segment_id': seg_id})}\n\n"
                else:
                    yield f"data: {json.dumps({'type': 'progress', 'current': item.get('current'), 'total': item.get('total'), 'percent': item.get('percent'), 'segment_id': seg_id})}\n\n"

            yield f"data: {json.dumps({'type': 'done', 'total': len(segments)})}\n\n"
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
        old_voice_name = old_segments[0].voice_name if old_segments else ""
        new_segments = []
        for j, seg_data in enumerate(segments_data):
            seg = Segment(
                id=str(uuid.uuid4()),
                project_id=project_id,
                index=insert_idx + j,
                start_time=seg_data["start_time"],
                end_time=seg_data["end_time"],
                text=seg_data["text"],
                original_text=seg_data.get("original_text", seg_data["text"]),
                speaker=seg_data.get("speaker", ""),
                voice_profile=seg_data.get("voice_profile", old_voice),
                voice_name=old_voice_name,
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


@router.post("/fill-missing-captions")
async def fill_missing_captions_endpoint(
    project_id: str,
    body: Optional[dict] = None,
    db: AsyncSession = Depends(get_db),
):
    """Detect all blank time gaps in the video without captions and generate captions exclusively for those missing parts."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")
    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No valid video file found for this project")

    min_gap_sec = float((body or {}).get("min_gap", 1.5))

    # Fetch existing non-freeze segments
    result = await db.execute(
        select(Segment)
        .where(Segment.project_id == project_id)
        .order_by(Segment.start_time)
    )
    existing_segs = result.scalars().all()
    valid_segs = [
        s for s in existing_segs
        if s.speaker != "Freeze" and s.voice_profile != "freeze" and not (s.text and "Freeze Frame" in s.text)
    ]

    video_path = project.video_path
    video_dur = project.duration or 0.0
    if video_dur <= 0:
        ffprobe = shutil.which("ffprobe")
        if ffprobe:
            try:
                cmd = [
                    ffprobe, "-v", "error",
                    "-show_entries", "format=duration",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    video_path,
                ]
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
                if proc.returncode == 0 and proc.stdout.strip():
                    video_dur = float(proc.stdout.strip())
            except Exception:
                pass

    # Detect all blank time gaps
    gaps = []
    if not valid_segs:
        if video_dur > 0:
            gaps.append((0.0, round(video_dur, 2)))
    else:
        # Gap before first segment
        if valid_segs[0].start_time >= min_gap_sec:
            gaps.append((0.0, round(valid_segs[0].start_time, 2)))

        # Gaps between consecutive segments
        for i in range(len(valid_segs) - 1):
            curr_end = valid_segs[i].end_time
            next_start = valid_segs[i + 1].start_time
            if (next_start - curr_end) >= min_gap_sec:
                gaps.append((round(curr_end, 2), round(next_start, 2)))

        # Gap after last segment
        if video_dur > 0 and (video_dur - valid_segs[-1].end_time) >= min_gap_sec:
            gaps.append((round(valid_segs[-1].end_time, 2), round(video_dur, 2)))

    if not gaps:
        return {
            "status": "ok",
            "message": "No blank gaps found in video",
            "gaps_detected": 0,
            "filled_count": 0,
            "segments": [SegmentResponse.model_validate(s) for s in existing_segs],
        }

    language = project.language or "km"
    ffmpeg = _get_ffmpeg()
    tmp_dir = tempfile.mkdtemp(prefix="fill_gaps_")
    new_segments_created = []

    try:
        for gap_idx, (g_start, g_end) in enumerate(gaps):
            g_dur = g_end - g_start
            clip_path = os.path.join(tmp_dir, f"gap_{gap_idx}.mp3")

            cmd = [
                ffmpeg, "-y",
                "-ss", str(g_start),
                "-i", video_path,
                "-t", str(g_dur),
                "-vn",
                "-ac", "1",
                "-ar", "16000",
                "-c:a", "libmp3lame",
                "-b:a", "96k",
                clip_path,
            ]
            proc = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True, timeout=30)
            if proc.returncode != 0 or not os.path.exists(clip_path):
                continue

            gap_segs = await transcribe_video(clip_path, language=language)
            if not gap_segs:
                continue

            for raw_s in gap_segs:
                s_txt = str(raw_s.get("text", "")).strip()
                s_orig = str(raw_s.get("original_text", s_txt)).strip()
                if not s_txt and not s_orig:
                    continue
                if not re.search(r'[\w\u1780-\u17FF\u4E00-\u9FFF]', s_txt or s_orig):
                    continue

                abs_start = round(min(g_end, max(g_start, g_start + raw_s["start_time"])), 2)
                abs_end = round(min(g_end, max(abs_start + 0.5, g_start + raw_s["end_time"])), 2)

                seg = Segment(
                    id=str(uuid.uuid4()),
                    project_id=project_id,
                    index=0,
                    start_time=abs_start,
                    end_time=abs_end,
                    text=s_txt or s_orig,
                    original_text=s_orig or s_txt,
                    speaker=raw_s.get("speaker", "Speaker"),
                    voice_profile=raw_s.get("voice_profile", "female"),
                    voice_name="",
                    emotion=raw_s.get("emotion", "neutral"),
                )
                db.add(seg)
                new_segments_created.append(seg)

        await db.flush()

        # Re-index all segments chronologically
        all_result = await db.execute(
            select(Segment)
            .where(Segment.project_id == project_id)
            .order_by(Segment.start_time)
        )
        all_segs = all_result.scalars().all()
        for idx, s in enumerate(all_segs):
            s.index = idx

        await db.commit()

        return {
            "status": "ok",
            "message": f"Scanned {len(gaps)} blank gaps and generated {len(new_segments_created)} missing captions",
            "gaps_detected": len(gaps),
            "filled_count": len(new_segments_created),
            "segments": [SegmentResponse.model_validate(s) for s in all_segs],
        }

    except Exception as e:
        await db.rollback()
        raise HTTPException(500, f"Failed to fill missing captions: {str(e)}")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@router.post("/generate-narration")
@router.post("/generate-narration/")
async def generate_narration_endpoint(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Generate AI narration/voiceover script for the video."""
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.video_clips))
        .where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")
    if not project.video_path:
        raise HTTPException(400, "No video uploaded for this project")

    language = body.get("language", project.language or "km")
    style = body.get("style", "summary")

    # If the timeline is trimmed, upload only the clipped portions (like
    # transcription does) instead of the full source video.
    video_clips = sorted(project.video_clips, key=lambda c: c.index)
    full_duration = project.duration or 0.0
    needs_clip = False
    if video_clips:
        total_clip_dur = sum(c.source_end - c.source_start for c in video_clips)
        if full_duration > 0 and abs(total_clip_dur - full_duration) > 0.5:
            needs_clip = True
        elif len(video_clips) > 1:
            needs_clip = True

    clipped_path = None
    clip_ranges: list[tuple[float, float]] = []
    try:
        if needs_clip:
            clipped_path, clip_ranges = await _extract_clips_video(
                project.video_path, video_clips
            )
        actual_video_path = clipped_path if clipped_path else project.video_path
        prompt_hint = body.get("prompt_hint", "")
        effective_duration = sum(c.source_end - c.source_start for c in video_clips) if video_clips else (project.duration or 0.0)
        narration_segments = await generate_narration(
            actual_video_path,
            language=language,
            style=style,
            prompt_hint=prompt_hint,
            video_duration=effective_duration,
        )

        # Map timestamps from clip-space back to the original video time.
        if clip_ranges:
            narration_segments = _offset_segments_to_clips(narration_segments, clip_ranges)

        return {"segments": narration_segments, "style": style, "language": language}
    except Exception as e:
        raise HTTPException(500, f"Narration generation failed: {str(e)}")
    finally:
        if clipped_path:
            shutil.rmtree(os.path.dirname(clipped_path), ignore_errors=True)


@router.post("/apply-narration")
@router.post("/apply-narration/")
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

    # Normalize timings so segments always fit the timeline: sort, sequential placement, non-overlapping
    duration = project.duration or 0.0
    narration_segments = sorted(narration_segments, key=lambda s: float(s.get("start_time", 0)))
    normalized = []
    current_cursor = 0.0
    for seg_data in narration_segments:
        start = max(0.0, float(seg_data.get("start_time", 0)))
        end = float(seg_data.get("end_time", 0))
        text = str(seg_data.get("text", "")).strip()
        if not text:
            continue

        words = len(text.split())
        est_duration = max(1.8, words * 0.35)

        if start < current_cursor:
            start = round(current_cursor, 2)
        if end <= start or (end - start) < 0.5:
            end = round(start + est_duration, 2)

        if duration > 0:
            start = min(start, duration)
            end = min(end, duration)
            if start >= duration:
                break

        normalized.append({**seg_data, "start_time": start, "end_time": end})
        current_cursor = end + 0.05
    narration_segments = normalized
    if not narration_segments:
        raise HTTPException(400, "No narration segments fit within the video duration")

    # Create new segments from narration. Dialogue segments (actor lines)
    # keep the character as speaker and use a gender-matched voice; narration
    # segments use the chosen narrator voice.
    voice_input = body.get("voice_profile", "female")
    new_segments = []
    for i, seg_data in enumerate(narration_segments):
        is_dialogue = str(seg_data.get("type") or "narration") == "dialogue"
        gender = str(seg_data.get("gender") or "").lower()
        if is_dialogue:
            speaker = str(seg_data.get("speaker") or "").strip() or "Actor"
            voice_profile = "male" if gender == "male" else "female"
            voice_name = "km-KH-PisethNeural" if gender == "male" else "km-KH-SreymomNeural"
        else:
            speaker = "Narrator"
            if "Neural" in voice_input:
                voice_name = voice_input
                voice_profile = "male" if "Piseth" in voice_input or "male" in voice_input.lower() else "female"
            else:
                voice_profile = voice_input
                voice_name = "km-KH-PisethNeural" if voice_input == "male" else "km-KH-SreymomNeural"

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
            voice_name=voice_name,
            emotion=str(seg_data.get("emotion") or "neutral") or "neutral",
        )
        db.add(seg)
        new_segments.append(seg)

    await db.commit()
    for seg in new_segments:
        await db.refresh(seg)

    return [SegmentResponse.model_validate(s) for s in new_segments]


@router.post("/ai-agent")
@router.post("/ai-agent/")
async def ai_agent_endpoint(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Meatika AI Video Agent assistant."""
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.segments))
        .where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    action = body.get("action", "custom_chat")
    custom_prompt = body.get("prompt", "")

    segments_data = [
        {
            "start_time": s.start_time,
            "end_time": s.end_time,
            "speaker": s.speaker,
            "text": s.text,
            "original_text": s.original_text,
        }
        for s in sorted(project.segments, key=lambda x: x.start_time)
    ]

    try:
        response = await run_ai_agent(
            project_name=project.name,
            video_duration=project.duration or 0.0,
            segments=segments_data,
            action=action,
            custom_prompt=custom_prompt,
        )
        return response
    except Exception as e:
        logger.error(f"Error in ai_agent_endpoint: {e}")
        return {
            "action": action,
            "content": f"AI Assistant Notice: {str(e)}",
        }


@router.post("/tts-preview")
@router.post("/tts-preview/")
async def tts_preview_endpoint(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Generate standalone TTS audio file without modifying the project timeline."""
    text = body.get("text", "").strip()
    if not text:
        raise HTTPException(400, "Text is required")

    voice_profile = body.get("voice_profile", "female")
    voice_name = body.get("voice_name", "")
    speed = float(body.get("speed", 1.0))
    emotion = body.get("emotion", "")
    engine = body.get("engine", "")
    reference_audio = body.get("reference_audio", "") or body.get("sample_audio_url", "")

    # Look up custom voice profile if not explicitly provided
    from backend.api.routes.settings import _get_custom_voice_profiles, DEFAULT_SAMPLE_VOICE_PROFILES
    custom_profiles = await _get_custom_voice_profiles(db)
    all_profiles = list(DEFAULT_SAMPLE_VOICE_PROFILES) + list(custom_profiles)
    for p in all_profiles:
        if (
            (p.get("id") and p["id"].lower() == voice_name.lower())
            or (p.get("name") and p["name"].lower() == voice_name.lower())
            or (p.get("voice_name") and p["voice_name"].lower() == voice_name.lower())
            or (p.get("id") and p["id"].lower() == voice_profile.lower())
        ):
            if not engine:
                engine = p.get("engine", "")
            if not reference_audio:
                reference_audio = p.get("sample_audio_url", "")
            break

    pct = int((speed - 1.0) * 100)
    rate_str = f"+{pct}%" if pct >= 0 else f"{pct}%"

    file_path = await generate_segment_audio(
        text=text,
        voice_profile=voice_profile,
        rate=rate_str,
        voice_name=voice_name,
        emotion=emotion,
        engine=engine,
        reference_audio=reference_audio,
    )

    # Calculate real duration with ffprobe
    duration = max(1.5, len(text) * 0.08 / max(0.5, speed))
    try:
        cmd = [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "json",
            file_path,
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        data = json.loads(res.stdout)
        duration = float(data.get("format", {}).get("duration", duration))
    except Exception:
        pass

    from backend.config import settings
    rel_path = os.path.relpath(file_path, settings.upload_dir).replace("\\", "/")
    audio_url = f"/uploads/{rel_path}"

    return {
        "audio_url": audio_url,
        "duration": round(duration, 2),
        "text": text,
        "voice_name": voice_name,
        "voice_profile": voice_profile,
    }


@router.post("/suggest-titles")
@router.post("/suggest-titles/")
async def suggest_titles_endpoint(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Generate viral, high-CTR movie recap titles."""
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.segments))
        .where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    original_title = body.get("original_title", "").strip() or project.name or ""
    language = body.get("language", project.language or "km")

    # Combine transcript text if available
    transcript_text = "\n".join([
        f"[{s.start_time:.1f}s - {s.end_time:.1f}s] {s.speaker}: {s.text}"
        for s in sorted(project.segments, key=lambda x: x.start_time)
        if s.text and s.text.strip()
    ])

    titles = await generate_movie_titles(
        original_title=original_title,
        transcript_text=transcript_text,
        video_path=project.video_path or "",
        language=language,
    )
    return {"original_title": original_title, "titles": titles}


@router.post("/generate-social-script")
@router.post("/generate-social-script/")
async def generate_social_script_endpoint(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Generate viral social media post, synopsis, CTA, and hashtags."""
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.segments))
        .where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    original_title = body.get("original_title", "").strip() or project.name or ""
    language = body.get("language", project.language or "km")

    transcript_text = "\n".join([
        f"[{s.start_time:.1f}s - {s.end_time:.1f}s] {s.speaker}: {s.text}"
        for s in sorted(project.segments, key=lambda x: x.start_time)
        if s.text and s.text.strip()
    ])

    social_data = await generate_social_media_script(
        original_title=original_title,
        transcript_text=transcript_text,
        video_path=project.video_path or "",
        language=language,
    )
    return social_data


@router.post("/tts-direct")
async def tts_direct_endpoint(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Generate standalone TTS audio and create a subtitle segment on the timeline."""
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.segments))
        .where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    text = body.get("text", "").strip()
    if not text:
        raise HTTPException(400, "Text is required")

    voice_profile = body.get("voice_profile", "female")
    voice_name = body.get("voice_name", "")
    speed = float(body.get("speed", 1.0))
    start_time = float(body.get("start_time", 0.0))
    audio_url = body.get("audio_url", "")
    duration = float(body.get("duration", 0.0))

    if duration <= 0:
        duration = max(1.5, len(text) * 0.08 / max(0.5, speed))

    end_time = start_time + duration

    emotion = body.get("emotion", "")
    engine = body.get("engine", "")
    reference_audio = body.get("reference_audio", "") or body.get("sample_audio_url", "")

    # Look up custom voice profile if not explicitly provided
    from backend.api.routes.settings import _get_custom_voice_profiles, DEFAULT_SAMPLE_VOICE_PROFILES
    custom_profiles = await _get_custom_voice_profiles(db)
    all_profiles = list(DEFAULT_SAMPLE_VOICE_PROFILES) + list(custom_profiles)
    for p in all_profiles:
        if (
            (p.get("id") and p["id"].lower() == voice_name.lower())
            or (p.get("name") and p["name"].lower() == voice_name.lower())
            or (p.get("voice_name") and p["voice_name"].lower() == voice_name.lower())
            or (p.get("id") and p["id"].lower() == voice_profile.lower())
        ):
            if not engine:
                engine = p.get("engine", "")
            if not reference_audio:
                reference_audio = p.get("sample_audio_url", "")
            break

    # If audio_url not already provided from preview, generate it
    if not audio_url:
        pct = int((speed - 1.0) * 100)
        rate_str = f"+{pct}%" if pct >= 0 else f"{pct}%"
        try:
            file_path = await generate_segment_audio(
                text=text,
                voice_profile=voice_profile,
                rate=rate_str,
                voice_name=voice_name,
                emotion=emotion,
                engine=engine,
                reference_audio=reference_audio,
            )
            from backend.config import settings
            rel_path = os.path.relpath(file_path, settings.upload_dir).replace("\\", "/")
            audio_url = f"/uploads/{rel_path}"
        except Exception:
            audio_url = ""

    # Create segment
    max_idx = max([s.index for s in project.segments], default=-1)
    seg = Segment(
        id=str(uuid.uuid4()),
        project_id=project_id,
        index=max_idx + 1,
        start_time=start_time,
        end_time=end_time,
        text=text,
        original_text=text,
        speaker=body.get("speaker", voice_name or "Narrator"),
        voice_profile=voice_profile,
        voice_name=voice_name,
        emotion=emotion or "neutral",
        audio_speed=speed,
        audio_url=audio_url,
    )
    db.add(seg)
    await db.commit()
    await db.refresh(seg)

    return SegmentResponse.model_validate(seg)


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
    if segment_id == "all":
        return await clear_all_segments(project_id, db)
    result = await db.execute(
        select(Segment).where(Segment.id == segment_id, Segment.project_id == project_id)
    )
    segment = result.scalar_one_or_none()
    if not segment:
        raise HTTPException(404, "Segment not found")

    await db.delete(segment)
    await db.commit()


@router.post("/shift-timestamps")
@router.post("/shift-timestamps/")
async def shift_project_timestamps_endpoint(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Shift all or selected segments by a given offset in seconds (e.g. +0.5, -0.5, +1.0)."""
    offset = float(body.get("offset", 0.0))
    segment_ids = body.get("segment_ids", None)

    query = select(Segment).where(Segment.project_id == project_id)
    if segment_ids:
        query = query.where(Segment.id.in_(segment_ids))
    query = query.order_by(Segment.start_time)

    result = await db.execute(query)
    segs = list(result.scalars().all())
    if not segs:
        return []

    for s in segs:
        s.start_time = round(max(0.0, s.start_time + offset), 2)
        s.end_time = round(max(s.start_time + 0.3, s.end_time + offset), 2)

    await db.commit()
    return [SegmentResponse.model_validate(s) for s in segs]

