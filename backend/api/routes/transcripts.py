from __future__ import annotations
from backend.services.series_memory import translation_memory
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
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.services.project_versions import auto_save
from backend.config import settings
from backend.database.db import get_db, async_session
from backend.database.models import Project, Segment, VideoClip
from backend.api.schemas import SegmentUpdate, SegmentResponse, TranscribeRequest, ProjectResponse
from backend.services.gemini_service import transcribe_video, transcribe_video_streaming
from backend.services.tts_service import assign_speaker_voices

router = APIRouter(prefix="/projects/{project_id}/transcripts", tags=["transcripts"])


def _delete_single_segment_audio(seg: Segment | None, keep: frozenset[str] = frozenset()):
    """Delete all audio files on disk associated with a single segment, except those in `keep`."""
    if not seg:
        return
    if getattr(seg, "audio_url", None):
        file_path = seg.audio_url.lstrip("/")
        if file_path and file_path not in keep and os.path.exists(file_path):
            try:
                os.remove(file_path)
            except OSError:
                pass
    seg_id = getattr(seg, "id", None)
    if seg_id:
        tts_dir = os.path.join(settings.upload_dir, "tts")
        if os.path.isdir(tts_dir):
            for fname in os.listdir(tts_dir):
                if fname.startswith(seg_id) and os.path.join(tts_dir, fname).lstrip("./") not in keep:
                    try:
                        os.remove(os.path.join(tts_dir, fname))
                    except OSError:
                        pass


async def _cleanup_segment_audio(db: AsyncSession, project_id: str):
    """Delete TTS audio files on disk for all segments of a project — except voices a saved
    version still uses, so restoring that version brings the dub back too."""
    from backend.services.project_versions import audio_in_versions

    keep = await audio_in_versions(db, project_id)
    result = await db.execute(
        select(Segment).where(
            Segment.project_id == project_id,
        )
    )
    for seg in result.scalars().all():
        _delete_single_segment_audio(seg, keep)


def _get_ffmpeg() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found")
    return ffmpeg


async def _extract_clips_video(
    video_path: str, clips: list[VideoClip], audio_only: bool = False
) -> tuple[str | None, list[tuple[float, float]]]:
    """
    If clips don't cover the full video, extract only the clipped portions
    into a temp file using ffmpeg. Returns (temp_path, clip_ranges) where
    clip_ranges are the (source_start, source_end) pairs used.
    Returns (None, []) if no extraction needed (use original).

    audio_only=True skips video re-encoding and writes 16 kHz mono FLAC, which is
    all transcription needs — far faster and smaller on long videos, and FLAC
    keeps later chunk seeks sample-accurate.
    """
    if not clips:
        return None, []

    # Sort clips by index (timeline playback order)
    sorted_clips = sorted(clips, key=lambda c: c.index)
    clip_ranges = [(c.source_start, c.source_end) for c in sorted_clips]

    # Build ffmpeg concat filter for extracting clip portions
    ffmpeg = _get_ffmpeg()
    tmp_dir = tempfile.mkdtemp(prefix="transcribe_clip_")
    output_path = os.path.join(tmp_dir, "clipped.flac" if audio_only else "clipped.mp4")
    audio_out = ["-c:a", "flac", "-ar", "16000", "-ac", "1"] if audio_only else ["-c:a", "aac", "-b:a", "128k"]

    if len(sorted_clips) == 1 and audio_only:
        c = sorted_clips[0]
        cmd = [
            ffmpeg, "-y",
            "-ss", str(c.source_start),
            "-i", video_path,
            "-t", str(c.source_end - c.source_start),
            "-vn", *audio_out,
            output_path,
        ]
    elif audio_only:
        filter_complex = "".join(
            f"[0:a]atrim=start={c.source_start}:end={c.source_end},asetpts=PTS-STARTPTS[a{i}];"
            for i, c in enumerate(sorted_clips)
        ) + "".join(f"[a{i}]" for i in range(len(sorted_clips))) + f"concat=n={len(sorted_clips)}:v=0:a=1[outa]"
        cmd = [
            ffmpeg, "-y",
            "-i", video_path,
            "-filter_complex", filter_complex,
            "-map", "[outa]", *audio_out,
            output_path,
        ]
    elif len(sorted_clips) == 1:
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
        # Multiple clips: use complex filter to concat (streams must be interleaved [v0][a0][v1][a1]... for concat=v=1:a=1)
        filter_parts = []
        concat_inputs = []
        for i, c in enumerate(sorted_clips):
            filter_parts.append(
                f"[0:v]trim=start={c.source_start}:end={c.source_end},setpts=PTS-STARTPTS[v{i}];"
                f"[0:a]atrim=start={c.source_start}:end={c.source_end},asetpts=PTS-STARTPTS[a{i}];"
            )
            concat_inputs.append(f"[v{i}][a{i}]")

        filter_complex = "".join(filter_parts) + "".join(concat_inputs) + f"concat=n={len(sorted_clips)}:v=1:a=1[outv][outa]"
        cmd = [
            ffmpeg, "-y",
            "-i", video_path,
            "-filter_complex", filter_complex,
            "-map", "[outv]", "-map", "[outa]",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
            "-c:a", "aac", "-b:a", "128k",
            output_path,
        ]

    # Long sources can take a while even with ultrafast encoding
    result = await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=True, timeout=1800
    )
    if result.returncode != 0:
        # Cleanup on failure
        shutil.rmtree(tmp_dir, ignore_errors=True)
        # Fallback to full source video if clipping fails
        print(f"[clips] FFmpeg clip extraction failed ({result.stderr[-200:]}), falling back to source video")
        return None, []

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
            clipped_path, clip_ranges = await _extract_clips_video(project.video_path, video_clips, audio_only=True)
            actual_path = clipped_path

        # Transcribe using Gemini
        segments_data = await transcribe_video(
            actual_path,
            language=request.language or project.language,
            shared_glossary=await translation_memory(db, project_id, request.language or project.language),
        )

        # Offset timestamps if we used a clipped video
        if clip_ranges:
            segments_data = _offset_segments_to_clips(segments_data, clip_ranges)

        # One gender per character before voices are chosen: the per-line guesses flip
        try:
            from backend.services.cast import apply_cast_to_dicts, decide_cast
            apply_cast_to_dicts(segments_data, await decide_cast(segments_data))
        except Exception as exc:
            print(f"[cast] skipped: {type(exc).__name__}", flush=True)

        # Give each detected speaker their own TTS voice
        assign_speaker_voices(segments_data, request.language or project.language)

        # Delete existing segments and their TTS audio files
        await auto_save(db, project_id, "Before re-transcribing")
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
    await auto_save(db, project_id, "Before clearing all captions")
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
    await auto_save(db, project_id, "Before re-chunking captions")
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


# --- Importing subtitles ------------------------------------------------------------------
# Most projects start from a subtitle file, so this path does more than read one format:
# SRT, WebVTT, ASS/SSA and this app's JSON; Windows and Chinese encodings; speakers named in
# the file; a preview before anything is replaced; and a second file used as the translation
# of captions that are already there.

PAIR_MIN_OVERLAP = 0.4        # share of the shorter line two captions must share to be the same moment


async def _timeline_ranges(db: AsyncSession, project_id: str) -> list[tuple[float, float]]:
    clips = (await db.execute(
        select(VideoClip).where(VideoClip.project_id == project_id).order_by(VideoClip.index)
    )).scalars().all()
    return [(c.source_start, c.source_end) for c in clips]


def _onto_timeline(cues: list[dict], ranges: list[tuple[float, float]]) -> tuple[list[dict], int]:
    """A subtitle file is timed against the video as it plays, which here is the timeline. When
    the timeline has been trimmed or re-cut, its times are mapped onto the source video the
    same way a transcription's are; left as they were, a file imported after trimming the
    start of the video landed on the removed part and never appeared.
    Returns (lines in source time, how many fell past the end of the timeline)."""
    lines = [{**c, "start_time": c["start"], "end_time": c["end"]} for c in cues]
    if not ranges:
        return lines, 0
    length = sum(b - a for a, b in ranges)
    beyond = sum(1 for line in lines if line["start_time"] >= length)
    return _offset_segments_to_clips([l for l in lines if l["start_time"] < length], ranges), beyond


def pair_by_time(existing: list, lines: list[dict]) -> dict[str, str]:
    """Which imported lines belong to which existing caption: the one each overlaps most.
    Returns {caption id: text}; several short lines over one caption are joined in order."""
    paired: dict[str, list[str]] = {}
    for line in lines:
        best, best_share = None, 0.0
        for seg in existing:
            overlap = min(seg.end_time, line["end_time"]) - max(seg.start_time, line["start_time"])
            if overlap <= 0:
                continue
            shorter = max(0.1, min(seg.end_time - seg.start_time, line["end_time"] - line["start_time"]))
            if overlap / shorter > best_share:
                best, best_share = seg, overlap / shorter
        if best is not None and best_share >= PAIR_MIN_OVERLAP:
            paired.setdefault(best.id, []).append(line["text"])
    return {seg_id: " ".join(texts) for seg_id, texts in paired.items()}


async def _read_subtitle_upload(file: UploadFile) -> dict:
    from backend.services.subtitle_import import SubtitleError, parse_subtitles

    try:
        return parse_subtitles(file.filename or "subtitles.srt", await file.read())
    except SubtitleError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/import-subtitles/preview")
async def preview_subtitle_import(
    project_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    """What importing this file would do, without doing it."""
    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")
    parsed = await _read_subtitle_upload(file)
    ranges = await _timeline_ranges(db, project_id)
    lines, beyond = _onto_timeline(parsed["cues"], ranges)
    existing = list((await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )).scalars().all())
    timeline = sum(b - a for a, b in ranges) if ranges else float(project.duration or 0.0)
    language = parsed["language"]
    return {
        "format": parsed["format"],
        "encoding": parsed["encoding"],
        "lines": len(lines),
        "found": parsed["found"],
        "dropped": parsed["dropped"],
        "shortened": parsed["shortened"],
        "overlaps": parsed["overlaps"],
        "speakers": parsed["speakers"][:30],
        "language": language,
        "project_language": project.language or "km",
        "needs_translation": bool(language) and language != (project.language or "km"),
        "first": parsed["first"],
        "last": parsed["last"],
        "timeline_seconds": round(timeline, 2),
        "beyond_timeline": beyond,
        "has_video": bool(project.video_path),
        "existing_captions": len(existing),
        "existing_voiced": sum(1 for s in existing if s.audio_url),
        "would_pair": len(pair_by_time(existing, lines)) if existing else 0,
        "sample": [l["text"] for l in lines[:3]],
    }


@router.post("/import-srt", response_model=List[SegmentResponse], status_code=201)
async def import_srt(
    project_id: str,
    file: UploadFile = File(...),
    mode: str = Form("replace"),
    db: AsyncSession = Depends(get_db),
):
    """Import a subtitle file (SRT, WebVTT, ASS/SSA or JSON).

    mode "replace" (the default) makes the file the project's captions. mode "translation"
    keeps the captions that are there and uses the file as their translation, matched by time:
    the current text becomes the original and the imported text the line to dub.
    """
    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")
    if mode not in ("replace", "translation"):
        raise HTTPException(400, "mode must be 'replace' or 'translation'")

    parsed = await _read_subtitle_upload(file)
    lines, _ = _onto_timeline(parsed["cues"], await _timeline_ranges(db, project_id))
    if not lines:
        raise HTTPException(400, "Every subtitle in this file starts after the end of the timeline")

    if mode == "translation":
        existing = list((await db.execute(
            select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
        )).scalars().all())
        if not existing:
            raise HTTPException(400, "There are no captions to translate yet. Import this file as the captions instead.")
        paired = pair_by_time(existing, lines)
        if not paired:
            raise HTTPException(400, "None of this file's lines line up in time with the captions here.")
        await auto_save(db, project_id, "Before importing a translation")
        for seg in existing:
            text = paired.get(seg.id)
            if not text or text == seg.text:
                continue
            if not (seg.original_text or "").strip() or seg.original_text == seg.text:
                seg.original_text = seg.text
            seg.text = text
            if seg.audio_url:
                # the voice said the old words; the file stays on disk for undo
                seg.audio_url, seg.audio_speed = "", 1.0
        await db.commit()
        return [SegmentResponse.model_validate(s) for s in existing]

    # Clear existing segments and their TTS audio files
    await auto_save(db, project_id, "Before importing subtitles")
    await _cleanup_segment_audio(db, project_id)
    await db.execute(delete(Segment).where(Segment.project_id == project_id))

    from backend.services.voice_profiles import resolve_voice_profile

    new_segments = []
    for i, line in enumerate(lines):
        seg = Segment(
            id=str(uuid.uuid4()),
            project_id=project_id,
            index=i,
            start_time=line["start_time"],
            end_time=line["end_time"],
            text=line["text"],
            original_text=line.get("original") or line["text"],
            speaker=line.get("speaker") or "",
            # a label like "Mother" or "老人" says enough to pick a voice; anything else waits
            # for the speakers to be identified
            voice_profile=resolve_voice_profile(None, None, line.get("speaker")),
        )
        db.add(seg)
        new_segments.append(seg)

    # Lines shown on screen together would be dubbed on top of each other: the later one
    # waits for the earlier to finish, before any voice is made for them.
    from backend.services.spacing import space_overlaps
    space_overlaps(new_segments)

    await db.commit()
    for seg in new_segments:
        await db.refresh(seg)
    return [SegmentResponse.model_validate(s) for s in new_segments]


@router.post("/space-overlaps")
async def space_overlapping_lines(project_id: str, db: AsyncSession = Depends(get_db)):
    """Move overlapping lines apart so their voices take turns. A line that moved loses its
    voice (the file stays on disk for undo), so dubbing again voices just those lines."""
    from backend.services.spacing import space_overlaps

    segments = list((await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )).scalars().all())
    if not segments:
        raise HTTPException(404, "This project has no captions")
    await auto_save(db, project_id, "Before spacing out overlapping lines")
    changed = space_overlaps(segments)
    revoice = []
    for seg in changed:
        if seg.audio_url:
            seg.audio_url, seg.audio_speed = "", 1.0
            revoice.append(seg.id)
    await db.commit()
    return {"moved": len(changed), "to_revoice": revoice}


@router.get("/review")
async def review_before_export(project_id: str, db: AsyncSession = Depends(get_db)):
    """What is worth a look before this project is exported."""
    from backend.services.review import review_project

    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")
    segments = list((await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )).scalars().all())
    return review_project(segments, project.language or "km", float(project.duration or 0.0))


# --- The cast: one voice per character, set in one place -----------------------------------

VOICE_TYPES = ("male", "female", "grandpa", "grandma", "child_boy", "child_girl")


def apply_cast_changes(segments: list, changes: list[dict], default_voice: dict) -> dict:
    """Apply per-character changes to every line of that character.

    Each change names a character and may give it a new name (which merges it into another
    character of that name), a voice type and a voice. A line whose voice changes loses its
    dub — it was spoken in the old voice — but the file stays on disk for undo.
    Returns {"lines", "renamed", "voices_cleared"}.
    """
    by_name: dict[str, dict] = {}
    for change in changes:
        name = str(change.get("name") or "").strip()
        if name:
            by_name[name] = change
    lines = renamed = cleared = 0
    for seg in segments:
        change = by_name.get((seg.speaker or "").strip())
        if not change:
            continue
        touched = False
        new_name = str(change.get("new_name") or "").strip()
        if new_name and new_name != seg.speaker:
            seg.speaker = new_name[:120]
            renamed += 1
            touched = True
        profile = change.get("voice_profile")
        voice = change.get("voice_name")
        voice_changed = False
        if profile in VOICE_TYPES and profile != (seg.voice_profile or "female"):
            seg.voice_profile = profile
            voice_changed = True
        if voice is not None:
            # "" means the built-in voice for the character's type
            wanted = str(voice).strip() or default_voice.get(seg.voice_profile or "female", "")
            if wanted != (seg.voice_name or ""):
                seg.voice_name = wanted
                voice_changed = True
        elif voice_changed and (seg.voice_name or "") in set(default_voice.values()) | {""}:
            # the type changed and the line was on a built-in voice: move it to the right one
            seg.voice_name = default_voice.get(seg.voice_profile, "")
        if voice_changed:
            touched = True
            if seg.audio_url:
                seg.audio_url, seg.audio_speed = "", 1.0
                cleared += 1
        lines += touched
    return {"lines": lines, "renamed": renamed, "voices_cleared": cleared}


@router.post("/cast")
async def update_cast(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Set a name, voice type or voice for whole characters at once.
    Body: {"changes": [{"name", "new_name"?, "voice_profile"?, "voice_name"?}]}"""
    from backend.services.tts_service import DEFAULT_VOICE_MAP

    if not await db.get(Project, project_id):
        raise HTTPException(404, "Project not found")
    changes = [c for c in (body.get("changes") or []) if isinstance(c, dict)]
    if not changes:
        raise HTTPException(400, "No changes given")
    segments = list((await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )).scalars().all())
    await auto_save(db, project_id, f"Before changing the cast ({len(changes)} character{'s' if len(changes) != 1 else ''})")
    result = apply_cast_changes(segments, changes, dict(DEFAULT_VOICE_MAP))
    await db.commit()
    return {**result, "segments": [SegmentResponse.model_validate(s).model_dump(mode="json") for s in segments]}


@router.post("/identify-speakers")
async def identify_speakers(
    project_id: str,
    body: dict | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Work out from the audio who speaks each caption, and set the voice to match.

    Meant for imported subtitles, which carry words and times but no speakers. By default only
    lines without a named speaker are labelled; {"all": true} relabels every line.
    """
    body = body or {}
    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")
    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "This project has no video to listen to")

    from backend.api.routes.timeline_sync import _named_speaker
    from backend.services.cast import apply_cast_to_segments, decide_cast, family
    from backend.services.gemini_service import label_speakers
    from backend.services.tts_service import DEFAULT_VOICE_MAP, KHMER_FEMALE, KHMER_MALE
    from backend.services.voice_profiles import resolve_voice_profile

    segments = list((await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )).scalars().all())
    targets = [
        s for s in segments
        if (s.text or "").strip() and (body.get("all") or not _named_speaker(s.speaker))
    ]
    if not targets:
        return {"labelled": 0, "asked": 0, "characters": [], "voices_cleared": 0, "segments": []}

    from backend.services import series_memory
    _, memory = await series_memory.project_and_memory(db, project_id)
    try:
        labels = await label_speakers(project.video_path, [
            {"id": s.id, "start_time": s.start_time, "end_time": s.end_time,
             "text": (s.original_text or s.text or "").strip()}
            for s in targets
        ], known_cast=series_memory.known_cast(memory))
    except Exception as exc:
        raise HTTPException(502, f"Could not listen to the video: {exc}") from exc
    if not labels:
        raise HTTPException(502, "No speakers could be identified. Check your Gemini API keys and try again.")

    await auto_save(db, project_id, f"Before identifying the speakers of {len(labels)} lines")
    built_in = {"", KHMER_FEMALE, KHMER_MALE}
    cleared = 0
    for seg in targets:
        label = labels.get(seg.id)
        if not label:
            continue
        profile = resolve_voice_profile(label["voice_profile"], None, label["speaker"])
        changed = family(profile) != family(seg.voice_profile)
        seg.speaker, seg.voice_profile, seg.emotion = label["speaker"], profile, label["emotion"]
        if (seg.voice_name or "") in built_in:
            seg.voice_name = DEFAULT_VOICE_MAP.get(profile, KHMER_FEMALE)
            if changed and seg.audio_url:
                seg.audio_url = ""       # dubbed in the other voice; the file stays for undo
                cleared += 1

    # the labels are per line and can still flip for one person, so settle each character once
    try:
        cast = await decide_cast([
            {"speaker": s.speaker, "voice_profile": s.voice_profile, "text": s.text, "original_text": s.original_text}
            for s in segments
        ])
        cleared += apply_cast_to_segments(segments, cast)[1]
    except Exception as exc:
        print(f"[cast] skipped: {type(exc).__name__}", flush=True)
    await db.commit()
    # a cast member answered under another of their names is shown by the one they always are
    if series_memory.readable_speakers(memory, segments):
        await db.commit()
    # the next episode is told who these people are, and they keep their voice type there
    try:
        await series_memory.learn_from_projects(db, project, [project])
    except Exception as exc:
        print(f"[cast] series cast not updated: {type(exc).__name__}: {exc}", flush=True)

    names: dict[str, dict] = {}
    for seg in segments:
        if seg.id in labels:
            entry = names.setdefault(seg.speaker, {"name": seg.speaker, "profile": seg.voice_profile, "lines": 0})
            entry["lines"] += 1
    return {
        "labelled": len(labels),
        "asked": len(targets),
        "characters": sorted(names.values(), key=lambda c: -c["lines"]),
        "voices_cleared": cleared,
        "segments": [SegmentResponse.model_validate(s).model_dump(mode="json") for s in segments],
    }


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
        language = request.language or project.language or "km"
        project_language = language

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
                yield f"data: {json.dumps({'type': 'progress', 'message': 'Extracting audio from trimmed clips...'})}\n\n"
                clipped_path, clip_ranges = await _extract_clips_video(video_path, video_clips, audio_only=True)

            actual_video_path = clipped_path if clipped_path else video_path
            if not clipped_path:
                from backend.services.video_service import stem_path
                vocals = stem_path(os.path.dirname(video_path), "vocals")
                if os.path.isfile(vocals):
                    actual_video_path = vocals
                    yield f"data: {json.dumps({'type': 'progress', 'message': 'Using the isolated vocal track for cleaner transcription...'})}\n\n"

            # Delete existing segments and their TTS audio files
            async with async_session() as db:
                await auto_save(db, project_id, "Before re-transcribing")
                await _cleanup_segment_audio(db, project_id)
                await db.execute(
                    delete(Segment).where(Segment.project_id == project_id)
                )
                await db.commit()

            async with async_session() as db:
                shared_glossary = await translation_memory(db, project_id, language)

            # Stream and save segments immediately as each chunk arrives!
            warning = None
            async for item in transcribe_video_streaming(actual_video_path, language, shared_glossary=shared_glossary):
                if "_warning" in item:
                    warning = item["_warning"]
                    continue
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
                voice_profile = seg_data.get("voice_profile", "female")
                is_km = project_language == "km"
                if is_km:
                    if voice_profile == "grandpa":
                        default_spk = "លោកតា (Grandpa)"
                    elif voice_profile == "grandma":
                        default_spk = "លោកយាយ (Grandma)"
                    elif voice_profile == "child_boy":
                        default_spk = "ក្មេងប្រុស (Boy)"
                    elif voice_profile == "child_girl":
                        default_spk = "ក្មេងស្រី (Girl)"
                    elif voice_profile == "male":
                        default_spk = "តួអង្គប្រុស (Male)"
                    else:
                        default_spk = "តួអង្គស្រី (Female)"
                else:
                    default_spk = "Speaker 1 (Male)" if voice_profile in ("male", "grandpa", "child_boy") else "Speaker 2 (Female)"
                
                raw_spk = str(seg_data.get("speaker") or "").strip()
                # Gemini sometimes returns a placeholder instead of a character name
                if raw_spk.lower() in ("unnamed", "unknown", "speaker", "character", "?", "n/a", "none"):
                    raw_spk = ""
                if not raw_spk:
                    speaker = default_spk
                elif is_km and raw_spk in ("Speaker 1", "Speaker1", "Speaker 1 (Male)", "Speaker 1 (Female)"):
                    speaker = "តួអង្គទី១ (ប្រុស)" if voice_profile in ("male", "grandpa", "child_boy") else "តួអង្គទី១ (ស្រី)"
                elif is_km and raw_spk in ("Speaker 2", "Speaker2", "Speaker 2 (Male)", "Speaker 2 (Female)"):
                    speaker = "តួអង្គទី២ (ស្រី)" if voice_profile in ("female", "grandma", "child_girl") else "តួអង្គទី២ (ប្រុស)"
                elif is_km and re.search(r'[\u4E00-\u9FFF]', raw_spk):
                    speaker = default_spk
                else:
                    speaker = raw_spk

                voice_name = seg_data.get("voice_name", "")
                if not voice_name:
                    voice_name = "km-KH-PisethNeural" if voice_profile in ("male", "grandpa", "child_boy") else "km-KH-SreymomNeural"
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

            # One gender per character, now that every line is in. Lines were saved as they
            # arrived, each with its own guess, and the guesses flip for the same person.
            try:
                from backend.services.cast import apply_cast_to_segments, decide_cast
                async with async_session() as db:
                    rows = list((await db.execute(
                        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
                    )).scalars().all())
                    cast = await decide_cast([
                        {"speaker": r.speaker, "voice_profile": r.voice_profile, "text": r.text, "original_text": r.original_text}
                        for r in rows
                    ])
                    if apply_cast_to_segments(rows, cast)[0]:
                        await db.commit()
            except Exception as exc:
                print(f"[cast] skipped: {type(exc).__name__}", flush=True)

            # Mark project completed
            async with async_session() as db:
                result = await db.execute(select(Project).where(Project.id == project_id))
                proj = result.scalar_one_or_none()
                if proj:
                    proj.status = "completed"
                    proj.language = language
                    # Keep the "some stretches could not be transcribed" note. It used to exist
                    # only in the stream, so once the run ended the hole was invisible and the
                    # part looked finished.
                    from backend.database.models import AppSetting

                    key = f"transcribe_warning:{project_id}"
                    row = await db.get(AppSetting, key)
                    if warning:
                        if row:
                            row.value = warning
                        else:
                            db.add(AppSetting(key=key, value=warning))
                    elif row:
                        await db.delete(row)
                    await db.commit()

            yield f"data: {json.dumps({'type': 'done', 'total_segments': segment_index, 'warning': warning})}\n\n"

        except Exception as e:
            # Mark project as error
            async with async_session() as db:
                result = await db.execute(select(Project).where(Project.id == project_id))
                proj = result.scalar_one_or_none()
                if proj:
                    proj.status = "error"
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


def _translation_lines(all_segments: list, segment_ids) -> tuple[list, list, list]:
    """(the segments to translate, their lines for the translator, the whole dialogue).

    The whole dialogue goes along so the translator can see what is said around each line
    and keep names consistent; a line outside this run carries its current translation."""
    chosen_ids = set(segment_ids) if segment_ids else None
    chosen, lines, story = [], [], []
    for s in all_segments:
        source = s.original_text if (s.original_text and s.original_text.strip()) else s.text
        picked = chosen_ids is None or s.id in chosen_ids
        line = {
            "id": s.id,
            "start_time": s.start_time,
            "end_time": s.end_time,
            "text": source,
            "speaker": s.speaker,
            "voice_profile": s.voice_profile,
            "translation": "" if picked else (s.text or ""),
        }
        story.append(line)
        if picked:
            chosen.append(s)
            lines.append(line)
    return chosen, lines, story


@router.post("/translate")
@router.post("/translate/")
async def translate_project_segments(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Translate all or selected project segments to a target language using Gemini.

    The translation is saved onto the captions unless {"preview": true} is sent, which only
    returns it — a preview in another language must not replace the project's captions.
    """
    target_language = body.get("language", "km")
    segment_ids = body.get("segment_ids", None)
    preview = bool(body.get("preview"))

    result = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    db_segments, segments, story = _translation_lines(list(result.scalars().all()), segment_ids)
    if not db_segments:
        return []

    from backend.services.gemini_service import translate_segments_stream

    shared_glossary = await translation_memory(db, project_id, target_language)
    failed = 0
    translated = {}
    async for item in translate_segments_stream(segments, target_language, story, shared_glossary=shared_glossary):
        seg = db_segments[item["index"]]
        if item["failed"]:
            failed += 1  # keep the existing text rather than overwriting it with the source line
            continue
        translated[seg.id] = item["text"]

    if failed == len(db_segments):
        raise HTTPException(502, "Translation failed. Check your Gemini API keys and try again.")
    if preview:
        return [
            {"id": s.id, "start_time": s.start_time, "end_time": s.end_time,
             "text": translated.get(s.id, s.text), "speaker": s.speaker}
            for s in db_segments
        ]
    # The speaker label is left alone: it is what groups a character's lines, and renaming it
    # on the one line being translated split that character in two.
    for seg in db_segments:
        if seg.id in translated:
            if seg.text != translated[seg.id]:
                seg.audio_url, seg.audio_speed = "", 1.0
            seg.text = translated[seg.id]
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
            result = await db.execute(
                select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
            )
            db_segments, segments, story = _translation_lines(list(result.scalars().all()), segment_ids)
            shared_glossary = await translation_memory(db, project_id, target_language)

        if not db_segments:
            yield f"data: {json.dumps({'type': 'done', 'total': 0})}\n\n"
            return

        from backend.services.gemini_service import TRANSLATE_CHUNK_SIZE, translate_segments_stream

        def _progress_evt(item, segment=None):
            evt = {'current': item.get('current'), 'total': item.get('total'), 'percent': item.get('percent')}
            if segment is not None:
                return {'type': 'segment_updated', 'segment': segment, **evt}
            return {'type': 'progress', 'segment_id': item.get('id'), **evt}

        async def _flush(batch):
            """Write one chunk's translations in a single transaction, then emit its events."""
            ids = [it["id"] for it in batch if it.get("id") and not it.get("failed")]
            by_id = {}
            if ids:
                async with async_session() as db:
                    result = await db.execute(select(Segment).where(Segment.id.in_(ids)))
                    by_id = {seg.id: seg for seg in result.scalars().all()}
                    for it in batch:
                        seg = by_id.get(it.get("id"))
                        if seg and not it.get("failed"):
                            if seg.text != it["text"]:
                                seg.audio_url, seg.audio_speed = "", 1.0
                            seg.text = it["text"]
                    await db.commit()
                    by_id = {k: SegmentResponse.model_validate(v).model_dump(mode='json') for k, v in by_id.items()}
            return [
                f"data: {json.dumps(_progress_evt(it, by_id.get(it.get('id'))))}\n\n"
                for it in batch
            ]

        failed = 0
        batch = []
        try:
            async for item in translate_segments_stream(segments, target_language, story, shared_glossary=shared_glossary):
                failed += bool(item.get("failed"))
                batch.append(item)
                if len(batch) >= TRANSLATE_CHUNK_SIZE or item.get("current") == item.get("total"):
                    for evt in await _flush(batch):
                        yield evt
                    batch = []

            if failed == len(segments):
                yield f"data: {json.dumps({'type': 'error', 'message': 'Translation failed for every line. Check your Gemini API keys and try again.'})}\n\n"
            else:
                yield f"data: {json.dumps({'type': 'done', 'total': len(segments), 'failed': failed})}\n\n"
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

    if "voice_fx" in updates and updates["voice_fx"] != segment.voice_fx:
        invalidate = True

    old_duration = segment.end_time - segment.start_time
    new_start = updates.get("start_time", segment.start_time)
    new_end = updates.get("end_time", segment.end_time)
    new_duration = new_end - new_start
    if abs(new_duration - old_duration) > 0.05:
        invalidate = True

    if invalidate and segment.audio_url:
        # The voice no longer matches the line, so it is unlinked and the line shows as needing
        # a dub. The file itself stays: undo and saved versions still point at it.
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
    _delete_single_segment_audio(segment)
    await db.delete(segment)
    await db.commit()
