"""Re-transcribing selected segments and filling gaps in captions."""
from __future__ import annotations
import os
import re
import shutil
import subprocess
import tempfile
import uuid
import json
import asyncio
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database.db import get_db, async_session
from backend.database.models import Project, Segment, VideoClip
from backend.api.schemas import SegmentResponse
from backend.services.gemini_service import transcribe_video
from backend.services.transcript_cleanup import _is_music_or_noise_segment, _strip_inline_music_tags
from backend.api.routes.transcripts import _get_ffmpeg

router = APIRouter(prefix="/projects/{project_id}/transcripts", tags=["transcripts"])


# Repairing coverage: with an isolated vocal track we can find speech that has no caption,
# rather than trusting the gaps between captions. Missed lines are batched into a few spans,
# so one repair run costs a handful of Gemini requests instead of one per gap.
MISSED_SPAN_MERGE_GAP = 0.35   # bridge only brief pauses inside dialogue
MISSED_SPAN_MAX = 240.0        # longest span sent in one request
MISSED_SPAN_PAD = 0.4
# A repaired line that lands on top of an existing caption is a duplicate, not a repair.
DUPLICATE_OVERLAP = 0.5        # share of the new line that may sit under an existing one
# Gemini occasionally restates a run of earlier lines over later audio. A lone repeated line is
# usually a real catchphrase, so only a run of consecutive lines moving together counts.
REPEAT_BLOCK_MIN_RUN = 2       # consecutive lines that must match
REPEAT_BLOCK_MIN_SHIFT = 12.0  # how far apart the two copies must sit
REPEAT_BLOCK_TOLERANCE = 1.5   # how much the shift may vary across the run
# The restatement is often a paraphrase rather than a copy, so lines are compared on shared
# character triples. Khmer writes without spaces between words, which makes character n-grams
# a better measure of "the same line said differently" than any word-based comparison.
REPEAT_BLOCK_MAX_SHIFT = 240.0 # a restatement lands within a few minutes, not half an hour
REPEAT_SIMILAR_SEED = 0.62     # to start a run, where a false positive is costly
REPEAT_SIMILAR_RUN = 0.45      # to continue one, already backed by a matching time shift
# A gap of a second or two, heard on its own, transcribes badly — Gemini has no idea who is
# talking or what about. Each clip is widened with the audio around it, and only the lines
# whose middle falls inside the gap are kept; the neighbours are there just for context.
GAP_CONTEXT_PAD = 1.5          # audio added either side of a gap
GAP_MIN_CLIP = 5.0             # clips are widened to at least this long
GAP_CONTEXT_SLACK = 0.2        # how far a line's middle may stray outside the gap
# One request per gap made a 37-gap run into 37 Gemini calls — each 15-40s, and together
# enough to hit rate limits and their back-off waits. Gaps are sent in batches instead: their
# audio joined into one file, a stretch of silence between them so Gemini keeps them apart.
GAP_BATCH_SECONDS = 90.0       # audio per request, silences included
GAP_BATCH_SILENCE = 1.5        # between gaps inside a batch
GAP_CONCURRENCY = 3            # batches transcribed at once


def _plan_gap_batches(gaps: list[tuple[float, float]], video_dur: float) -> list[list[dict]]:
    """Group gaps into requests. Each batch is a list of pieces of source audio; a piece is one
    gap's context window, or several when their windows overlap, so no audio is sent twice."""
    pieces: list[dict] = []
    for idx, (g_start, g_end) in enumerate(gaps):
        a, b = _context_window(g_start, g_end, video_dur)
        if pieces and a <= pieces[-1]["end"]:
            pieces[-1]["end"] = max(pieces[-1]["end"], b)
            pieces[-1]["gaps"].append(idx)
        else:
            pieces.append({"start": a, "end": b, "gaps": [idx]})

    batches: list[list[dict]] = []
    length = 0.0
    for piece in pieces:
        piece_len = piece["end"] - piece["start"]
        if batches and length + GAP_BATCH_SILENCE + piece_len <= GAP_BATCH_SECONDS:
            batches[-1].append(piece)
            length += GAP_BATCH_SILENCE + piece_len
        else:
            batches.append([piece])
            length = piece_len
    # where each piece starts inside its batch's joined audio
    for batch in batches:
        cursor = 0.0
        for piece in batch:
            piece["offset"] = round(cursor, 3)
            cursor += piece["end"] - piece["start"] + GAP_BATCH_SILENCE
    return batches


def _batch_audio_filter(batch: list[dict]) -> str:
    """ffmpeg filter graph that joins a batch's pieces with silence between them."""
    parts, labels = [], []
    for i, piece in enumerate(batch):
        parts.append(
            f"[0:a]atrim=start={piece['start']:.3f}:end={piece['end']:.3f},asetpts=PTS-STARTPTS,"
            f"aformat=sample_rates=24000:channel_layouts=mono[p{i}]"
        )
        labels.append(f"[p{i}]")
        if i < len(batch) - 1:
            parts.append(f"anullsrc=r=24000:cl=mono,atrim=duration={GAP_BATCH_SILENCE}[s{i}]")
            labels.append(f"[s{i}]")
    parts.append(f"{''.join(labels)}concat=n={len(labels)}:v=0:a=1[out]")
    return ";".join(parts)


def _split_batch_lines(batch: list[dict], lines: list, gaps: list[tuple[float, float]]) -> dict[int, list]:
    """Hand each line Gemini returned for a joined batch back to its gap, in source time."""
    per_gap: dict[int, list] = {idx: [] for piece in batch for idx in piece["gaps"]}
    for raw in lines:
        try:
            t0, t1 = float(raw.get("start_time", 0.0)), float(raw.get("end_time", 0.0))
        except (TypeError, ValueError):
            continue
        mid = (t0 + max(t0, t1)) / 2
        # the piece whose stretch of the joined audio holds the line's middle
        piece = next(
            (p for p in batch if p["offset"] - 0.3 <= mid <= p["offset"] + (p["end"] - p["start"]) + 0.3),
            None,
        )
        if piece is None:
            continue  # heard in a silence between pieces — nothing real to place
        shift = piece["start"] - piece["offset"]
        src_mid = mid + shift
        idx = min(piece["gaps"], key=lambda i: 0.0 if gaps[i][0] <= src_mid <= gaps[i][1]
                  else min(abs(src_mid - gaps[i][0]), abs(src_mid - gaps[i][1])))
        per_gap[idx].append({**raw, "start_time": round(t0 + shift, 3), "end_time": round(max(t0, t1) + shift, 3)})
    return per_gap


def _context_window(g_start: float, g_end: float, video_dur: float) -> tuple[float, float]:
    """The stretch of audio sent to Gemini for one gap: the gap plus context either side."""
    start, end = g_start - GAP_CONTEXT_PAD, g_end + GAP_CONTEXT_PAD
    short = GAP_MIN_CLIP - (end - start)
    if short > 0:
        start, end = start - short / 2, end + short / 2
    # Context that would fall off either end of the video is taken from the other side instead
    if start < 0:
        start, end = 0.0, end - start
    if video_dur > 0 and end > video_dur:
        start, end = max(0.0, start - (end - video_dur)), video_dur
    return round(start, 2), round(end, 2)


def _trigrams(text: str) -> set[str]:
    text = (text or "").strip()
    return {text[i : i + 3] for i in range(max(0, len(text) - 2))}


def _similar(a: str, b: str) -> float:
    """Share of character triples two lines have in common (0 to 1)."""
    ga, gb = _trigrams(a), _trigrams(b)
    if not ga or not gb:
        return 1.0 if a.strip() == b.strip() else 0.0
    return len(ga & gb) / len(ga | gb)


def _is_duplicate(start: float, end: float, existing: list[tuple[float, float]]) -> bool:
    """True when an existing caption already covers most of this new line."""
    if end <= start:
        return True
    uncovered = _uncovered_ranges([(start, end)], existing, min_seconds=0)
    covered_seconds = end - start - sum(b - a for a, b in uncovered)
    return covered_seconds / (end - start) >= DUPLICATE_OVERLAP


def _repeats_nearby_caption(start, end, text, original_text, existing):
    """Catch a boundary line repeated with slightly shifted AI timestamps.

    Compare source dialogue as well as translations. Keep short catchphrases and
    repeated dialogue elsewhere in the video; these can be legitimate new speech.
    """
    def normalize(value):
        return ''.join(c for c in (value or '').casefold() if c.isalnum() or '\u1780' <= c <= '\u17ff')

    candidate = [normalize(text), normalize(original_text)]
    for seg in existing:
        if start > seg.end_time + 0.8 or end < seg.start_time - 0.8:
            continue
        for a, b in zip(candidate, [normalize(seg.text), normalize(seg.original_text)]):
            if min(len(a), len(b)) < 8:
                continue
            if a == b or (min(len(a), len(b)) / max(len(a), len(b)) >= 0.85 and _similar(a, b) >= 0.85):
                return True
    return False


VOICE_BORROW_WINDOW = 15.0     # how far away a caption may be and still lend its voice


def _borrowed_voice(start: float, end: float, raw: dict, neighbours: list) -> tuple[str, str, str]:
    """(speaker, voice_profile, voice_name) for a repaired line.

    Gemini only heard a few seconds, so its speaker label ("Speaker 1") means nothing next to
    the project's cast. The closest caption nearby usually belongs to the same conversation;
    when Gemini could tell the voice's gender, only a caption of that gender is borrowed from.
    """
    guessed = str(raw.get("voice_profile") or "").lower()
    fallback = (raw.get("speaker") or "Speaker", guessed or "female", "")
    near = []
    for n in neighbours:
        if not (n.speaker or n.voice_profile) or n.speaker == "Freeze":
            continue
        gap = max(0.0, n.start_time - end, start - n.end_time)
        if gap <= VOICE_BORROW_WINDOW:
            near.append((gap, n))
    if guessed in ("male", "female"):
        near = [(g, n) for g, n in near if (n.voice_profile or "").lower() == guessed]
    if not near:
        return fallback
    n = min(near, key=lambda x: x[0])[1]
    return n.speaker or fallback[0], n.voice_profile or fallback[1], n.voice_name or ""


def _uncovered_ranges(regions, covered, min_seconds=0.35):
    """Subtract the union of caption intervals, preserving partially covered speech."""
    covered = sorted((a, b) for a, b in covered if b > a)
    missing = []
    for start, end in regions:
        cursor = start
        for a, b in covered:
            if b <= cursor:
                continue
            if a >= end:
                break
            if a - cursor >= min_seconds:
                missing.append((cursor, min(a, end)))
            cursor = max(cursor, b)
            if cursor >= end:
                break
        if end - cursor >= min_seconds:
            missing.append((cursor, end))
    return missing


async def _missed_speech_spans(video_path: str, valid_segs: list, max_spans: int):
    """(spans, audio_path, uncovered_count) using the vocal track, or ([], video_path, 0)."""
    from backend.services.video_service import stem_path

    vocals = stem_path(os.path.dirname(video_path), "vocals")
    if not os.path.isfile(vocals):
        return [], video_path, 0

    from backend.services.speech_align import detect_speech_regions, QUIET_REGION_BELOW_PEAK_DB

    # Suppress quiet stem residue (music bleed and background noise).
    regions = await asyncio.to_thread(
        detect_speech_regions, vocals, QUIET_REGION_BELOW_PEAK_DB
    )
    covered = [(x.start_time, x.end_time) for x in valid_segs if (x.text or '').strip()]
    missed = _uncovered_ranges(regions, covered)
    if not missed:
        return [], vocals, 0

    def _captioned_between(x: float, y: float) -> bool:
        """Is any existing caption sitting in the stretch between two uncovered bursts?"""
        return any(cs < y - 0.2 and ce > x + 0.2 for cs, ce in covered)

    spans: list[list[float]] = []
    for a, b in missed:
        if (
            spans
            and a - spans[-1][1] <= MISSED_SPAN_MERGE_GAP
            and b - spans[-1][0] <= MISSED_SPAN_MAX
            # Merging over a captioned stretch would re-transcribe lines that already exist
            # and come back as duplicates, so a caption in between ends the span.
            and not _captioned_between(spans[-1][1], a)
        ):
            spans[-1][1] = b
        else:
            spans.append([a, b])
    # Padding supplies context, but must not pull an already-captioned line back in.
    gaps = []
    for a, b in spans:
        left = max([0.0, a - MISSED_SPAN_PAD] + [ce for cs, ce in covered if ce <= a])
        right = min([b + MISSED_SPAN_PAD] + [cs for cs, ce in covered if cs >= b])
        gaps.append((round(left, 2), round(right, 2)))
    print(f"[fill-gaps] {len(missed)} uncovered speech bursts -> {len(gaps)} spans", flush=True)
    return gaps[:max_spans], vocals, len(missed)


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


@router.get("/coverage")
async def caption_coverage(project_id: str, db: AsyncSession = Depends(get_db)):
    """How much spoken audio has no caption. Needs the isolated vocal track."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")
    if not project.video_path:
        return {"available": False, "reason": "no video"}

    from backend.services.video_service import stem_path

    if not os.path.isfile(stem_path(os.path.dirname(project.video_path), "vocals")):
        return {"available": False, "reason": "isolate vocals first"}

    seg_res = await db.execute(select(Segment).where(Segment.project_id == project_id))
    valid = [
        s for s in seg_res.scalars().all()
        if s.speaker != "Freeze" and s.voice_profile != "freeze"
    ]
    spans, _audio, missed_bursts = await _missed_speech_spans(project.video_path, valid, 999)
    missed_seconds = sum(b - a for a, b in spans)
    return {
        "available": True,
        "missed_bursts": missed_bursts,
        "missed_seconds": round(missed_seconds, 1),
        "spans": len(spans),
        "first_spans": [
            {"start": round(a, 1), "end": round(b, 1)} for a, b in spans[:5]
        ],
    }


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

    min_gap_sec = float((body or {}).get("min_gap", 2.5))

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

    from backend.services.video_service import stem_path

    has_vocals = os.path.isfile(stem_path(os.path.dirname(video_path), "vocals"))
    detected_spans, span_audio, missed_bursts = await _missed_speech_spans(
        video_path, valid_segs, int((body or {}).get("max_spans", 12))
    )
    # With a vocal track, its answer is the whole answer — an empty result means nothing is
    # missing, not "fall back to the silences between captions and transcribe those".
    if has_vocals:
        gaps, video_path = detected_spans, (span_audio if detected_spans else video_path)
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
    # Where captions already sit; repaired lines are checked against this and appended to it
    occupied = [(x.start_time, x.end_time) for x in valid_segs]
    skipped_duplicates = 0

    try:
        sem = asyncio.Semaphore(4)

        async def _process_gap(gap_idx: int, g_start: float, g_end: float):
            g_dur = g_end - g_start
            clip_path = os.path.join(tmp_dir, f"gap_{gap_idx}.mp3")
            cmd = [
                ffmpeg, "-y",
                "-ss", str(g_start),
                "-i", video_path,
                "-t", str(g_dur),
                "-vn",
                "-ac", "1",
                "-ar", "24000",
                "-c:a", "libmp3lame",
                "-b:a", "128k",
                clip_path,
            ]
            proc = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True, timeout=30)
            if proc.returncode != 0 or not os.path.exists(clip_path) or os.path.getsize(clip_path) == 0:
                return []

            async with sem:
                gap_segs = await transcribe_video(clip_path, language=language)
                if not gap_segs:
                    return []
                return [(raw_s, g_start, g_end) for raw_s in gap_segs]

        tasks = [_process_gap(idx, gs, ge) for idx, (gs, ge) in enumerate(gaps)]
        gap_results = await asyncio.gather(*tasks, return_exceptions=True)

        for res in gap_results:
            if not isinstance(res, list):
                continue
            for raw_s, g_start, g_end in res:
                s_txt = _strip_inline_music_tags(str(raw_s.get("text", "")).strip())
                s_orig = _strip_inline_music_tags(str(raw_s.get("original_text", s_txt)).strip())
                if not s_txt and not s_orig:
                    continue
                if _is_music_or_noise_segment(s_txt, s_orig):
                    continue
                if not re.search(r'[\w\u1780-\u17FF\u4E00-\u9FFF]', s_txt or s_orig):
                    continue

                abs_start = round(min(g_end, max(g_start, g_start + float(raw_s.get("start_time", 0.0)))), 2)
                abs_end = round(min(g_end, max(abs_start + 0.5, g_start + float(raw_s.get("end_time", 0.5)))), 2)

                # A span can still take in audio that already has a caption, so drop anything
                # landing on top of one — including lines added earlier in this same run.
                if _is_duplicate(abs_start, abs_end, occupied) or _repeats_nearby_caption(
                    abs_start, abs_end, s_txt, s_orig, [*valid_segs, *new_segments_created]
                ):
                    skipped_duplicates += 1
                    continue
                occupied.append((abs_start, abs_end))

                speaker, voice_profile, voice_name = _borrowed_voice(abs_start, abs_end, raw_s, valid_segs)
                seg = Segment(
                    id=str(uuid.uuid4()),
                    project_id=project_id,
                    index=0,
                    start_time=abs_start,
                    end_time=abs_end,
                    text=s_txt or s_orig,
                    original_text=s_orig or s_txt,
                    speaker=speaker,
                    voice_profile=voice_profile,
                    voice_name=voice_name,
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
            "skipped_duplicates": skipped_duplicates,
            "segments": [SegmentResponse.model_validate(s) for s in all_segs],
        }

    except Exception as e:
        await db.rollback()
        raise HTTPException(500, f"Failed to fill missing captions: {str(e)}")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@router.post("/fill-missing-captions-stream")
async def fill_missing_captions_stream_endpoint(
    project_id: str,
    body: Optional[dict] = None,
):
    """Detect blank time gaps and stream progress in real-time as each gap is scanned."""
    async with async_session() as db:
        result = await db.execute(select(Project).where(Project.id == project_id))
        project = result.scalar_one_or_none()
        if not project:
            raise HTTPException(404, "Project not found")
        if not project.video_path or not os.path.exists(project.video_path):
            raise HTTPException(400, "No valid video file found for this project")

        min_gap_sec = float((body or {}).get("min_gap", 2.0))
        video_path = project.video_path
        language = project.language or "km"
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

    from backend.services.video_service import stem_path

    # The modal already detected these ranges. Do not analyze the vocal track again.
    chosen = (body or {}).get("spans")
    if chosen is not None:
        import math
        if not isinstance(chosen, list):
            raise HTTPException(400, "Selected gaps must be a list")
        gaps = []
        for item in chosen:
            try:
                a, b = (float(item[0]), float(item[1])) if isinstance(item, (list, tuple)) \
                    else (float(item["start"]), float(item["end"]))
            except (TypeError, ValueError, KeyError, IndexError):
                raise HTTPException(400, "Invalid selected gap")
            if not math.isfinite(a) or not math.isfinite(b) or a < 0 or b <= a:
                raise HTTPException(400, "Invalid selected gap")
            # Padding can carry the last gap a little past the end; trim it rather than
            # rejecting the whole batch. Only a gap starting past the end is dropped.
            if video_dur > 0:
                if a >= video_dur - 0.05:
                    continue
                b = min(b, video_dur)
            gaps.append((round(a, 2), round(b, 2)))
        vocals = stem_path(os.path.dirname(video_path), "vocals")
        if os.path.isfile(vocals):
            video_path = vocals
    else:
        has_vocals = os.path.isfile(stem_path(os.path.dirname(video_path), "vocals"))
        detected_spans, span_audio, _missed_bursts = await _missed_speech_spans(
            video_path, valid_segs, int((body or {}).get("max_spans", 12))
        )
        if has_vocals:
            gaps, video_path = detected_spans, (span_audio if detected_spans else video_path)

    def _event(payload: dict) -> str:
        return f"data: {json.dumps(payload)}\n\n"

    async def event_stream():
        if not gaps:
            yield _event({'type': 'done', 'message': 'No blank gaps found in video', 'gaps_detected': 0, 'filled_count': 0, 'failed_count': 0, 'failed_spans': [], 'percent': 100})
            return

        total_gaps = len(gaps)
        yield _event({'type': 'start', 'gaps_count': total_gaps, 'message': f'Transcribing {total_gaps} gaps, up to {GAP_CONCURRENCY} at once...'})

        ffmpeg = _get_ffmpeg()
        tmp_dir = tempfile.mkdtemp(prefix="fill_gaps_stream_")
        new_segments_created = []
        # Where captions already sit; repaired lines are checked against this and appended to it
        occupied = [(x.start_time, x.end_time) for x in valid_segs]
        skipped_duplicates = 0
        failed_spans: list[dict] = []
        sem = asyncio.Semaphore(GAP_CONCURRENCY)
        batches = _plan_gap_batches(gaps, video_dur)

        async def _run_batch(b_idx: int, batch: list[dict]):
            """[(gap index, clip start, raw lines, error)] for every gap in one batch."""
            gap_ids = [i for piece in batch for i in piece["gaps"]]
            clip_path = os.path.join(tmp_dir, f"batch_{b_idx}.mp3")
            cmd = [
                ffmpeg, "-y", "-i", video_path,
                "-filter_complex", _batch_audio_filter(batch), "-map", "[out]",
                "-c:a", "libmp3lame", "-b:a", "128k", clip_path,
            ]
            try:
                async with sem:
                    proc = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True, timeout=60)
                    if proc.returncode != 0 or not os.path.exists(clip_path) or os.path.getsize(clip_path) == 0:
                        raise RuntimeError("could not extract the audio")
                    lines = (await transcribe_video(clip_path, language=language)) or []
            except Exception as e:
                print(f"[fill gap] Batch {b_idx+1} ({len(gap_ids)} gaps) failed: {e}", flush=True)
                return [(i, 0.0, [], str(e) or type(e).__name__) for i in gap_ids]
            per_gap = _split_batch_lines(batch, lines, gaps)
            # lines now carry source times, so the clip starts at 0
            return [(i, 0.0, per_gap.get(i, []), None) for i in gap_ids]

        print(f"[fill gap] {total_gaps} gaps in {len(batches)} requests", flush=True)
        yield _event({'type': 'progress', 'message': f'Sending {total_gaps} gaps to Gemini in {len(batches)} {"request" if len(batches) == 1 else "requests"}...', 'current_gap': 0, 'total_gaps': total_gaps, 'percent': 5, 'filled_count': 0, 'failed_count': 0})

        tasks = [asyncio.create_task(_run_batch(i, b)) for i, b in enumerate(batches)]
        try:
            done_count = 0
            # Batches are handled as they land, so a slow one never holds up the rest.
            for fut in asyncio.as_completed(tasks):
                for idx, clip_start, gap_segs, err in await fut:
                    done_count += 1
                    g_start, g_end = gaps[idx]
                    pct = round(done_count / total_gaps * 90) + 5

                    if err:
                        failed_spans.append({"start": g_start, "end": g_end, "error": err[:200]})
                        yield _event({'type': 'progress', 'message': f'Gap {idx+1} failed: {err[:80]}', 'current_gap': done_count, 'total_gaps': total_gaps, 'percent': pct, 'gap_start': g_start, 'gap_end': g_end, 'filled_count': len(new_segments_created), 'failed_count': len(failed_spans)})
                        continue

                    found_here = 0
                    async with async_session() as db:
                        for raw_s in gap_segs:
                            s_txt = _strip_inline_music_tags(str(raw_s.get("text", "")).strip())
                            s_orig = _strip_inline_music_tags(str(raw_s.get("original_text", s_txt)).strip())
                            if not s_txt and not s_orig:
                                continue
                            if _is_music_or_noise_segment(s_txt, s_orig):
                                continue
                            if not re.search(r'[\wក-៿一-鿿]', s_txt or s_orig):
                                continue

                            try:
                                raw_start = clip_start + float(raw_s.get("start_time", 0.0))
                                raw_end = clip_start + float(raw_s.get("end_time", 0.0))
                            except (TypeError, ValueError):
                                continue
                            # The context either side was only there to help Gemini understand the
                            # gap; lines centred in it belong to captions that already exist.
                            mid = (raw_start + max(raw_start, raw_end)) / 2
                            if mid < g_start - GAP_CONTEXT_SLACK or mid > g_end + GAP_CONTEXT_SLACK:
                                continue

                            abs_start = round(min(g_end, max(g_start, raw_start)), 2)
                            abs_end = round(min(g_end, max(abs_start + 0.5, raw_end)), 2)

                            # A span can still take in audio that already has a caption, so drop
                            # anything landing on top of one — including lines added in this run.
                            if _is_duplicate(abs_start, abs_end, occupied) or _repeats_nearby_caption(
                                abs_start, abs_end, s_txt, s_orig, [*valid_segs, *new_segments_created]
                            ):
                                skipped_duplicates += 1
                                continue
                            occupied.append((abs_start, abs_end))

                            speaker, voice_profile, voice_name = _borrowed_voice(abs_start, abs_end, raw_s, valid_segs)
                            seg = Segment(
                                id=str(uuid.uuid4()),
                                project_id=project_id,
                                index=0,
                                start_time=abs_start,
                                end_time=abs_end,
                                text=s_txt or s_orig,
                                original_text=s_orig or s_txt,
                                speaker=speaker,
                                voice_profile=voice_profile,
                                voice_name=voice_name,
                                emotion=raw_s.get("emotion", "neutral"),
                            )
                            db.add(seg)
                            new_segments_created.append(seg)
                            found_here += 1
                            await db.flush()
                            await db.refresh(seg)

                            seg_dict = {
                                "id": seg.id,
                                "index": seg.index,
                                "start_time": seg.start_time,
                                "end_time": seg.end_time,
                                "text": seg.text,
                                "original_text": seg.original_text,
                                "speaker": seg.speaker,
                                "voice_profile": seg.voice_profile,
                                "voice_name": seg.voice_name,
                                "emotion": seg.emotion,
                            }
                            short_txt = seg.text[:30] if seg.text else ""
                            msg_str = f"Found speech in gap {idx+1}: {short_txt}"
                            yield _event({'type': 'segment', 'segment': seg_dict, 'message': msg_str, 'filled_count': len(new_segments_created)})

                        # Commit per gap, so stopping part-way keeps what was already found.
                        await db.commit()

                    note = f'+{found_here} caption{"s" if found_here != 1 else ""}' if found_here else 'no new speech'
                    yield _event({'type': 'progress', 'message': f'Gap {idx+1} @ {g_start:.1f}s – {g_end:.1f}s: {note}', 'current_gap': done_count, 'total_gaps': total_gaps, 'percent': pct, 'gap_start': g_start, 'gap_end': g_end, 'filled_count': len(new_segments_created), 'failed_count': len(failed_spans)})

            # Re-index all segments chronologically
            async with async_session() as db:
                all_result = await db.execute(
                    select(Segment)
                    .where(Segment.project_id == project_id)
                    .order_by(Segment.start_time)
                )
                all_segs = all_result.scalars().all()
                for i_idx, s in enumerate(all_segs):
                    s.index = i_idx
                await db.commit()

            dup_note = f' · skipped {skipped_duplicates} already captioned' if skipped_duplicates else ''
            fail_note = f' · {len(failed_spans)} failed' if failed_spans else ''
            failed_spans.sort(key=lambda f: f["start"])
            yield _event({'type': 'done', 'message': f'Finished {total_gaps} gaps · Generated {len(new_segments_created)} missing captions{dup_note}{fail_note}', 'gaps_detected': total_gaps, 'filled_count': len(new_segments_created), 'skipped_duplicates': skipped_duplicates, 'failed_count': len(failed_spans), 'failed_spans': failed_spans, 'percent': 100})

        except Exception as e:
            yield _event({'type': 'error', 'message': str(e)})
        finally:
            # Also runs when the client stops the run: no gap keeps calling Gemini after that.
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
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


@router.post("/gap-plan")
@router.post("/gap-plan/")
async def gap_plan(
    project_id: str,
    body: dict | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Every stretch that would be scanned for missing speech, without transcribing anything.

    Lets the Fill gaps button show what it found — start, end and length of each gap — so the
    run can be reviewed, and narrowed, before it costs any API calls.
    """
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")
    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "No valid video file found for this project")

    seg_res = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    valid_segs = [
        s for s in seg_res.scalars().all()
        if s.speaker != "Freeze" and s.voice_profile != "freeze" and (s.text or "").strip()
    ]

    video_dur = float(project.duration or 0.0)

    # The vocal track shows where speech actually is. When it is there, its answer is the
    # whole answer — including "nothing is missing". Falling back to the silences between
    # captions in that case would report quiet as missing speech.
    from backend.services.video_service import stem_path

    has_vocals = os.path.isfile(stem_path(os.path.dirname(project.video_path), "vocals"))
    spans, _audio, missed_bursts = await _missed_speech_spans(project.video_path, valid_segs, 999)
    source = "vocals"

    if not has_vocals:
        raise HTTPException(
            400,
            "Isolate vocals first to detect speech without captions. Blank or silent stretches are not marked as missing.",
        )

    # Padding can push the last span past the end of the video
    if video_dur > 0:
        spans = [(a, min(b, video_dur)) for a, b in spans if a < video_dur - 0.05]
    gaps = [
        {
            "index": i + 1,
            "start": round(a, 2),
            "end": round(b, 2),
            "seconds": round(b - a, 2),
        }
        for i, (a, b) in enumerate(spans)
    ]
    return {
        "source": source,
        "vocals_available": source == "vocals",
        "missed_bursts": missed_bursts,
        "gaps": gaps,
        "total_gaps": len(gaps),
        "total_seconds": round(sum(g["seconds"] for g in gaps), 2),
        "video_seconds": round(video_dur, 2),
        "segment_count": len(valid_segs),
    }


DEAD_AIR_MIN_SECONDS = 1.2   # shorter than this is a natural pause, not a stretch worth cutting
DEAD_AIR_EDGE_PAD = 0.15     # leave a breath either side of what is cut


@router.post("/dead-air-plan")
@router.post("/dead-air-plan/")
async def dead_air_plan(
    project_id: str,
    body: dict | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Stretches where nobody speaks and no caption shows — the parts a recap cuts out.

    This is the opposite of the missing-caption scan: that one finds speech that was never
    written down, and cutting it would delete dialogue. This one finds the dead air.
    """
    min_seconds = float((body or {}).get("min_seconds", DEAD_AIR_MIN_SECONDS))

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")
    if not project.video_path or not os.path.exists(project.video_path):
        raise HTTPException(400, "This project has no video")

    seg_res = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    segments = [s for s in seg_res.scalars().all() if (s.text or "").strip()]

    clip_res = await db.execute(
        select(VideoClip).where(VideoClip.project_id == project_id).order_by(VideoClip.index)
    )
    clips = list(clip_res.scalars().all())
    timeline_end = sum(c.source_end - c.source_start for c in clips) or float(project.duration or 0.0)

    from backend.services.video_service import stem_path
    from backend.services.speech_align import detect_speech_regions, QUIET_REGION_BELOW_PEAK_DB

    vocals = stem_path(os.path.dirname(project.video_path), "vocals")
    has_vocals = os.path.isfile(vocals)
    speech = []
    if has_vocals:
        speech = await asyncio.to_thread(detect_speech_regions, vocals, QUIET_REGION_BELOW_PEAK_DB)

    # busy = a caption is showing, or somebody is speaking
    busy = [(s.start_time, s.end_time) for s in segments] + list(speech)
    busy.sort()
    merged: list[list[float]] = []
    for a, b in busy:
        if merged and a <= merged[-1][1] + 0.05:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])

    quiet: list[tuple[float, float]] = []
    cursor = 0.0
    for a, b in merged:
        if a - cursor >= min_seconds:
            quiet.append((cursor, a))
        cursor = max(cursor, b)
    if timeline_end - cursor >= min_seconds:
        quiet.append((cursor, timeline_end))

    gaps = []
    for i, (a, b) in enumerate(quiet):
        start = round(a + DEAD_AIR_EDGE_PAD, 2)
        end = round(b - DEAD_AIR_EDGE_PAD, 2)
        if end - start < min_seconds:
            continue
        gaps.append({"index": len(gaps) + 1, "start": start, "end": end,
                     "seconds": round(end - start, 2)})

    return {
        "source": "vocals + captions" if has_vocals else "captions only",
        "vocals_available": has_vocals,
        "gaps": gaps,
        "total_gaps": len(gaps),
        "total_seconds": round(sum(g["seconds"] for g in gaps), 2),
        "video_seconds": round(timeline_end, 2),
        "segment_count": len(segments),
    }
