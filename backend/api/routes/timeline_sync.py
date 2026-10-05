"""Timeline timing tools: shifting, restoring, auto-arranging and fitting audio to subtitles."""
from __future__ import annotations
import os
import re
import subprocess
import uuid
import asyncio
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database.db import get_db
from backend.database.models import Project, Segment
from backend.api.schemas import SegmentResponse
from backend.api.routes.transcripts import _get_ffmpeg

router = APIRouter(prefix="/projects/{project_id}/transcripts", tags=["transcripts"])


@router.post("/restore-segments")
@router.post("/restore-segments/")
async def restore_segments_endpoint(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Restore or sync all segments in a single transaction for fast undo/redo."""
    restored_segments = body.get("segments", [])
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    # Replace every caption with the snapshot. This used to build rows by hand with fields the
    # model does not have, which made every undo fail — and it dropped voice effect and speed.
    from backend.services.project_versions import replace_segments

    await replace_segments(db, project_id, restored_segments)
    await db.commit()
    return {"status": "ok", "count": len(restored_segments)}


# Caption readability: a line must stay on screen long enough to read, even when the
# character says it quickly. Khmer text is usually longer than the speech it translates.
MIN_CAPTION_SECONDS = 1.2
TARGET_CHARS_PER_SECOND = 16.0
MAX_EXTRA_SECONDS = 2.5      # never add more than this to one caption
MAX_CAPTION_SECONDS = 7.0
CAPTION_GAP = 0.08           # keep a sliver of space before the next caption
MAX_LEAD_IN_SECONDS = 1.5    # how early a caption may appear when the room is only behind it


def _extend_for_reading(segments: list, video_duration: float | None) -> list[float]:
    """Hold each caption long enough to read, using the silence after it and, when there is
    none, a little of the silence before it. Returns the seconds added per changed caption."""
    added = []
    for i, seg in enumerate(segments):
        text = (seg.text or "").strip()
        if not text:
            continue
        current = seg.end_time - seg.start_time
        needed = max(MIN_CAPTION_SECONDS, len(text) / TARGET_CHARS_PER_SECOND)
        needed = min(needed, MAX_CAPTION_SECONDS, current + MAX_EXTRA_SECONDS)
        if needed <= current:
            continue
        if i + 1 < len(segments):
            limit = segments[i + 1].start_time - CAPTION_GAP
        elif video_duration:
            limit = video_duration
        else:
            limit = seg.start_time + needed
        new_end = min(seg.start_time + needed, limit)
        gained = max(0.0, new_end - seg.end_time)

        # Still cramped and the silence sits before this line instead of after it: let the
        # caption appear a little early rather than flash by. The start never crosses the
        # previous caption, and the lead-in is capped so it stays tied to the speech.
        short_by = needed - (current + gained)
        # A dubbed line starts its voice where the caption starts, so moving the start would
        # pull the voice ahead of the actor's mouth: only undubbed lines may lead in.
        if short_by > 0.02 and not (getattr(seg, "audio_url", "") or "").strip():
            floor = (segments[i - 1].end_time + CAPTION_GAP) if i > 0 else 0.0
            new_start = max(floor, seg.start_time - min(short_by, MAX_LEAD_IN_SECONDS))
            if seg.start_time - new_start > 0.02:
                gained += seg.start_time - new_start
                seg.start_time = round(new_start, 2)

        if gained > 0.02:
            added.append(round(gained, 3))
            seg.end_time = round(new_end, 2)
    return added


# Merging: short consecutive lines from one speaker read better as a single subtitle
MERGE_MAX_GAP = 0.45          # silence between two lines that may still be joined
MERGE_MAX_DURATION = 6.0      # never build a caption longer than this
MERGE_MAX_CHARS = 90          # nor one with more text than a viewer can read
# Labels that do not identify a character: two lines sharing one of these may well be two
# different people, so they are never merged.
GENERIC_SPEAKERS = {"", "unnamed", "unknown", "narrator", "speaker", "speaker 1", "speaker 2", "?"}


# The labels this app gives a line when the transcript names nobody: "តួអង្គប្រុស (Male)",
# "Speaker 1 (Female)", "ក្មេងស្រី (Girl)"... They say what kind of voice it is, not who is
# speaking, so every unnamed man in a scene shares one.
_DEFAULT_LABEL = re.compile(
    r"^(speaker\s*\d*|តួអង្គ(ប្រុស|ស្រី|ទី[\d០-៩]+)?|បុរស|ស្ត្រី|លោកតា|លោកយាយ|ក្មេងប្រុស|ក្មេងស្រី|អ្នករៀបរាប់)"
    r"\s*(\((male|female|grandpa|grandma|boy|girl|narrator|ប្រុស|ស្រី)\))?$",
    re.IGNORECASE,
)


def _named_speaker(speaker: str | None) -> str | None:
    name = (speaker or "").strip()
    if name.lower() in GENERIC_SPEAKERS or _DEFAULT_LABEL.match(name):
        return None
    return name


def _trim_overlaps(segments: list) -> int:
    """End each caption before the next one starts. Returns how many were trimmed."""
    trimmed = 0
    for cur, nxt in zip(segments, segments[1:]):
        limit = nxt.start_time - CAPTION_GAP
        if cur.end_time > limit and limit > cur.start_time + 0.3:
            cur.end_time = round(limit, 2)
            trimmed += 1
    return trimmed


def _would_trim(segments: list) -> int:
    """How many captions `_trim_overlaps` would shorten, without changing any."""
    return sum(
        1 for cur, nxt in zip(segments, segments[1:])
        if cur.end_time > nxt.start_time - CAPTION_GAP and nxt.start_time - CAPTION_GAP > cur.start_time + 0.3
    )


def _plan_merges(segments: list, keep_dubbed: bool = True) -> list[list]:
    """Group consecutive captions that should become one subtitle line.

    A merged line is new text, so the voices recorded for its parts would have to be thrown
    away; with `keep_dubbed` lines that already have a voice are left as they are."""
    groups: list[list] = []
    for seg in segments:
        text = (seg.text or "").strip()
        if groups:
            group = groups[-1]
            last = group[-1]
            joined_chars = sum(len((s.text or "").strip()) for s in group) + len(text) + len(group)
            # Only merge lines known to come from the same character
            name = _named_speaker(seg.speaker)
            same_speaker = name is not None and name == _named_speaker(last.speaker)
            gap = seg.start_time - last.end_time
            span = seg.end_time - group[0].start_time
            # The merged line must still be readable in the span it occupies
            readable = joined_chars / max(0.5, span + MAX_EXTRA_SECONDS) <= TARGET_CHARS_PER_SECOND
            dubbed = bool((getattr(seg, "audio_url", "") or "").strip() or (getattr(last, "audio_url", "") or "").strip())
            if (
                same_speaker
                and not (keep_dubbed and dubbed)
                and 0 <= gap <= MERGE_MAX_GAP
                and span <= MERGE_MAX_DURATION
                and joined_chars <= MERGE_MAX_CHARS
                and readable
                and (last.end_time - last.start_time < 2.5 or seg.end_time - seg.start_time < 2.5)
            ):
                group.append(seg)
                continue
        groups.append([seg])
    return [g for g in groups if len(g) > 1]


@router.post("/tidy-captions")
@router.post("/tidy-captions/")
async def tidy_captions(
    project_id: str,
    body: dict | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Trim overlaps, merge short consecutive lines from the same speaker, then give every
    caption its reading time. Pass {"dry_run": true} to preview the counts only."""
    dry_run = bool((body or {}).get("dry_run"))

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    seg_res = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    segments = list(seg_res.scalars().all())
    if not segments:
        return {"merged_away": 0, "trimmed": 0, "extended": 0, "total": 0, "dubbed_cleared": 0}

    from backend.services.transcript_cleanup import strip_foreign_scripts

    groups = _plan_merges(segments)
    merged_away = sum(len(g) - 1 for g in groups)
    dubbed_cleared = sum(1 for g in groups for s in g if s.audio_url)
    # short lines that would have been joined if they were not dubbed already
    kept_dubbed = sum(len(g) - 1 for g in _plan_merges(segments, keep_dubbed=False)) - merged_away
    # Letters from other scripts that Gemini sometimes mixes into Khmer output
    stray = [s for s in segments if (s.text or "") != strip_foreign_scripts(s.text or "")]

    if dry_run:
        return {
            "merged_away": merged_away,
            "merged_into": len(groups),
            "kept_dubbed": kept_dubbed,
            "trimmed": _would_trim(segments),
            "total": len(segments),
            "dubbed_cleared": dubbed_cleared,
            "stray_chars": len(stray),
        }

    from backend.api.routes.transcripts import _delete_single_segment_audio

    survivors = []
    dropped = set()
    for group in groups:
        head = group[0]
        head.text = " ".join((s.text or "").strip() for s in group if (s.text or "").strip())
        head.original_text = " ".join((s.original_text or "").strip() for s in group if (s.original_text or "").strip())
        head.end_time = group[-1].end_time
        # The merged line is new text, so any audio recorded for these lines no longer matches
        for s in group:
            _delete_single_segment_audio(s)
            s.audio_url = ""
        for s in group[1:]:
            dropped.add(s.id)
            await db.delete(s)

    for seg in stray:
        seg.text = strip_foreign_scripts(seg.text or "")

    survivors = [s for s in segments if s.id not in dropped]
    trimmed = _trim_overlaps(survivors)
    extended = _extend_for_reading(survivors, project.duration)
    for i, seg in enumerate(survivors):
        seg.index = i
    await db.commit()

    seg_res = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    return {
        "merged_away": merged_away,
        "merged_into": len(groups),
        "trimmed": trimmed,
        "extended": len(extended),
        "kept_dubbed": kept_dubbed,
        "total": len(survivors),
        "dubbed_cleared": dubbed_cleared,
        "stray_chars": len(stray),
        "segments": [SegmentResponse.model_validate(s).model_dump(mode="json") for s in seg_res.scalars().all()],
    }


# a voice that starts this far from the actor's mouth, or is squeezed into a slot this much
# longer or shorter than it was made for, is heard as out of time
LIP_SHIFT_HEARD = 0.25
LIP_RESIZE_HEARD = 0.3


@router.post("/snap-to-speech")
@router.post("/snap-to-speech/")
async def snap_captions_to_speech(
    project_id: str,
    body: dict | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Move each caption onto the stretch of the isolated vocal track where the actor really
    speaks it: it starts when they start and ends when they stop. Captions with no speech
    nearby are left alone.

    With {"redub": true} this is lip timing for the dub as well: a line whose time changed
    enough to hear loses its voice, so the next dubbing fits the new voice to the time the
    actor's mouth is moving."""
    redub = bool((body or {}).get("redub"))
    from backend.services.video_service import stem_path
    from backend.services.speech_align import detect_speech_regions, snap_starts

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")
    if not project.video_path:
        raise HTTPException(400, "This project has no video")

    vocals = stem_path(os.path.dirname(project.video_path), "vocals")
    if not os.path.isfile(vocals):
        raise HTTPException(400, "Isolate vocals & BGM first — the vocal track is what speech is detected in.")

    seg_res = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    segments = list(seg_res.scalars().all())
    if not segments:
        return {"moved": 0, "total": 0, "median_shift": 0.0, "median_resize": 0.0, "to_revoice": 0}

    regions = await asyncio.to_thread(detect_speech_regions, vocals)
    starts = [r[0] for r in regions]
    by_start = {r[0]: r for r in regions}
    snapped = snap_starts([s.start_time for s in segments], starts)

    shifts, resizes = [], []
    revoice = 0
    if redub:
        from backend.services.project_versions import auto_save
        await auto_save(db, project_id, "Before lip timing")
    for idx, (seg, new_start) in enumerate(zip(segments, snapped)):
        if new_start is None:
            continue
        region = by_start.get(round(new_start, 3)) or by_start.get(new_start)
        if not region:
            continue
        # Caption runs exactly as long as the character speaks, without colliding with the next line
        # ...where the next line will be once it has been snapped too, not where it is now
        next_start = None
        if idx + 1 < len(segments):
            next_start = snapped[idx + 1] if snapped[idx + 1] is not None else segments[idx + 1].start_time
        new_end = region[1]
        if next_start is not None and new_end > next_start - 0.05:
            new_end = max(new_start + 0.5, next_start - 0.05)
        if new_end - new_start < 0.5:
            new_end = new_start + 0.5
        shift, resize = new_start - seg.start_time, (new_end - new_start) - (seg.end_time - seg.start_time)
        if abs(shift) < 0.02 and abs(resize) < 0.02:
            continue
        shifts.append(round(shift, 3))
        resizes.append(round(resize, 3))
        seg.start_time = round(new_start, 2)
        seg.end_time = round(new_end, 2)
        if redub and seg.audio_url and (abs(shift) >= LIP_SHIFT_HEARD or abs(resize) >= LIP_RESIZE_HEARD):
            seg.audio_url, seg.audio_speed = "", 1.0
            revoice += 1
    # Speech length alone can be too quick to read, so give each caption its reading time back
    _extend_for_reading(segments, project.duration)
    await db.commit()

    def _median(vals):
        return round(float(sorted(map(abs, vals))[len(vals) // 2]), 2) if vals else 0.0

    seg_res = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    return {
        "moved": len(shifts),
        "total": len(segments),
        "median_shift": _median(shifts),
        "median_resize": _median(resizes),
        "to_revoice": revoice,
        "segments": [SegmentResponse.model_validate(s).model_dump(mode="json") for s in seg_res.scalars().all()],
    }


# Fitting a voice to its line. A voice that is a little short of its box is slowed to end
# with it; one that runs past the room it has is sped up. Outside those limits the voice is
# left at its natural pace: it used to be forced to the box's exact length whatever that
# took, which turned short lines into slow motion (0.4x) and long ones into a gabble (5x).
AUTOFIT_MAX_SPEEDUP = 1.6     # faster than this stops sounding like speech
AUTOFIT_MIN_FILL = 0.8        # a voice shorter than this share of its box is left alone
AUTOFIT_KEEP_GAP = 0.12       # silence left before the next line
AUTOFIT_TOLERANCE = 0.05      # a mismatch smaller than this share is not worth re-encoding for


def plan_voice_fit(spoken: float, box: float, room: float) -> tuple[float, str]:
    """(tempo, what happens) for a voice `spoken` seconds long in a `box`-second caption
    with `room` seconds before the next line starts."""
    room = max(room, box)
    if spoken > room * (1 + AUTOFIT_TOLERANCE):
        needed = spoken / room
        return min(needed, AUTOFIT_MAX_SPEEDUP), "too_long" if needed > AUTOFIT_MAX_SPEEDUP else "sped_up"
    if spoken > box * (1 + AUTOFIT_TOLERANCE):
        return 1.0, "runs_on"          # it overruns the caption, but into silence: leave it
    if AUTOFIT_MIN_FILL <= spoken / box < 1 - AUTOFIT_TOLERANCE:
        return spoken / box, "slowed"
    return 1.0, "left"


@router.post("/auto-fit-audio")
@router.post("/auto-fit-audio/")
async def auto_fit_audio_to_subtitles(
    project_id: str,
    body: dict = None,
    db: AsyncSession = Depends(get_db),
):
    """Fit each voice to the room its line has, within the limits of natural speech.

    Old audio files are kept, so undoing the fit brings the previous voices back.
    {"dry_run": true} reports what would change.
    """
    body = body or {}
    segment_ids = body.get("segment_ids")
    dry_run = bool(body.get("dry_run"))

    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    result = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    all_segs = list(result.scalars().all())
    chosen = set(segment_ids) if segment_ids else None
    counts = {"sped_up": 0, "slowed": 0, "left": 0, "runs_on": 0, "too_long": 0}
    too_long: list[dict] = []
    if not all_segs:
        return {"ok": True, "updated_count": 0, **counts, "too_long_lines": [], "segments": []}

    ffmpeg = _get_ffmpeg()
    from backend.services.tts_service import build_retime_cmd, _probe_duration

    video_end = float(getattr(project, "duration", 0) or 0.0)
    export_dir = os.path.join(settings.upload_dir, "tts")
    os.makedirs(export_dir, exist_ok=True)

    updated_count = 0
    for i, seg in enumerate(all_segs):
        if (chosen and seg.id not in chosen) or not seg.audio_url:
            continue
        old_path = seg.audio_url.lstrip("/")
        if not os.path.exists(old_path):
            continue
        spoken = _probe_duration(ffmpeg, old_path)
        if spoken <= 0:
            continue

        box = max(0.3, seg.end_time - seg.start_time)
        if i + 1 < len(all_segs):
            room = all_segs[i + 1].start_time - AUTOFIT_KEEP_GAP - seg.start_time
        else:
            room = (video_end - seg.start_time) if video_end > seg.start_time else spoken
        room = max(room, box)
        tempo, outcome = plan_voice_fit(spoken, box, room)
        counts[outcome] += 1
        if outcome == "too_long":
            too_long.append({
                "id": seg.id, "start_time": round(seg.start_time, 2), "voice_seconds": round(spoken, 2),
                "room_seconds": round(room, 2), "text": (seg.text or "")[:60],
            })
        if dry_run:
            continue

        fitted = spoken
        if abs(tempo - 1.0) > 0.01:
            fitted_filename = f"{seg.id}_fitted_{uuid.uuid4().hex[:8]}.mp3"
            fitted_path = os.path.join(export_dir, fitted_filename)
            cmd = build_retime_cmd(ffmpeg, old_path, fitted_path, tempo)
            try:
                res = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True, timeout=60)
            except Exception as e:
                print(f"[AutoFit] Error fitting segment {seg.id}: {e}")
                continue
            if res.returncode != 0 or not os.path.exists(fitted_path) or os.path.getsize(fitted_path) == 0:
                continue
            fitted = _probe_duration(ffmpeg, fitted_path) or spoken / tempo
            seg.audio_url = f"/uploads/tts/{fitted_filename}"
            seg.audio_speed = round((seg.audio_speed or 1.0) * tempo, 2)
            updated_count += 1
        # the caption stays up for as long as its voice is speaking, short of the next line
        covered = round(seg.start_time + min(fitted, room), 2)
        if covered > seg.end_time + 0.02:
            seg.end_time = covered

    if not dry_run:
        await db.commit()

    return {
        "ok": True,
        "dry_run": dry_run,
        "updated_count": counts["sped_up"] + counts["slowed"] + counts["too_long"] if dry_run else updated_count,
        **counts,
        "too_long_lines": too_long[:30],
        "segments": [] if dry_run else [SegmentResponse.model_validate(s) for s in all_segs],
    }


# Lines with more words than their time. Speeding the voice up only goes so far before it
# stops sounding like speech; past that, the line itself has to be shorter.
SHORTEN_OVER = 1.25           # this many times the comfortable pace counts as too long
SHORTEN_ALLOW = 1.1           # a rewrite may be said slightly brisk
SHORTEN_MIN_CUT = 2           # a rewrite must actually be shorter to be worth offering


def plan_shorten(chars: int, room: float, spoken: float = 0.0, target_cps: float = 16.0) -> int | None:
    """The most characters a line should have for `room` seconds, or None when it already fits.

    With a voice, the voice is the measure: if it overruns the room, the text is cut in the
    same proportion. Without one, the text is measured against a comfortable speaking pace."""
    if room <= 0 or chars <= 0:
        return None
    budget = int(room * target_cps * SHORTEN_ALLOW)
    too_long = chars / (room * target_cps) > SHORTEN_OVER
    if spoken > room * 1.05:
        budget = min(budget, int(chars * room / spoken))
        too_long = True
    budget = max(8, budget)
    return budget if too_long and budget < chars - SHORTEN_MIN_CUT else None


@router.post("/shorten-to-fit")
@router.post("/shorten-to-fit/")
async def shorten_to_fit(
    project_id: str,
    body: dict | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Offer shorter wording for lines that cannot be said in their time, then apply the ones
    that are accepted.

    Without "apply" this finds the lines and returns a proposal for each — nothing is changed.
    With {"apply": [{"id", "text"}]} exactly those texts are written; their voices no longer
    match the words, so they are unlinked for re-dubbing (the files stay, for undo).
    """
    body = body or {}
    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")
    segments = list((await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )).scalars().all())

    if body.get("apply"):
        from backend.services.project_versions import auto_save

        wanted = {str(a.get("id")): str(a.get("text") or "").strip() for a in body["apply"] if isinstance(a, dict)}
        targets = [s for s in segments if wanted.get(s.id) and wanted[s.id] != (s.text or "").strip()]
        cleared = 0
        if targets:
            await auto_save(db, project_id, f"Before shortening {len(targets)} lines")
            for seg in targets:
                seg.text = wanted[seg.id]
                if seg.audio_url:
                    seg.audio_url, seg.audio_speed = "", 1.0
                    cleared += 1
            await db.commit()
        return {
            "applied": len(targets),
            "voices_cleared": cleared,
            "segments": [SegmentResponse.model_validate(s).model_dump(mode="json") for s in segments],
        }

    ffmpeg = _get_ffmpeg()
    from backend.services.tts_service import _probe_duration

    chosen = set(body.get("segment_ids") or []) or None
    video_end = float(project.duration or 0.0)
    found = []
    for i, seg in enumerate(segments):
        text = (seg.text or "").strip()
        if not text or (chosen and seg.id not in chosen):
            continue
        box = max(0.3, seg.end_time - seg.start_time)
        if i + 1 < len(segments):
            room = segments[i + 1].start_time - AUTOFIT_KEEP_GAP - seg.start_time
        else:
            room = (video_end - seg.start_time) if video_end > seg.start_time else box
        room = max(room, box)
        path = (seg.audio_url or "").lstrip("/")
        spoken = _probe_duration(ffmpeg, path) if path and os.path.exists(path) else 0.0
        budget = plan_shorten(len(text), room, spoken)
        if budget is not None:
            found.append((seg, text, budget, room))

    if not found:
        return {"candidates": 0, "proposals": [], "unchanged": 0}

    from backend.services.gemini_service import shorten_lines

    rewrites = await shorten_lines(
        [{"source": (seg.original_text or "").strip(), "text": text, "max_chars": budget} for seg, text, budget, _ in found],
        project.language or "km",
    )
    if not any(rewrites):
        raise HTTPException(502, "Could not get shorter wording. Check your Gemini API keys and try again.")
    proposals = []
    for (seg, text, budget, room), new in zip(found, rewrites):
        new = (new or "").strip()
        if not new or len(new) > len(text) - SHORTEN_MIN_CUT:
            continue
        proposals.append({
            "id": seg.id,
            "start_time": round(seg.start_time, 2),
            "seconds": round(room, 2),
            "before": text,
            "after": new,
            "chars_before": len(text),
            "chars_after": len(new),
            "budget": budget,
            "fits": len(new) <= budget * 1.15,
            "had_voice": bool(seg.audio_url),
        })
    return {"candidates": len(found), "proposals": proposals, "unchanged": len(found) - len(proposals)}


# Spreading captions into dead air: a dubbed line is often quicker than the acting it
# replaces, so the voice finishes early and the scene plays on in silence. Growing the line
# into the silence that follows and slowing the voice to match keeps the dub with the video.
DEAD_AIR_MIN = 0.6            # silence shorter than this is not worth taking
MAX_SLOWDOWN = 1.30           # a line may end up at most this much longer than it speaks
DEAD_AIR_KEEP = 0.12          # silence left before the next line


@router.post("/spread-into-silence")
@router.post("/spread-into-silence/")
async def spread_into_silence(
    project_id: str,
    body: dict | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Stretch each line into the silence after it, then slow its voice to match.

    A line only grows as far as its own voice can be slowed without sounding drawn out, so a
    five second hole is partly filled rather than turning one line into slow motion. Lines with
    no silence after them are left exactly as they are. {"dry_run": true} previews the change.
    """
    body = body or {}
    dry_run = bool(body.get("dry_run"))
    max_slowdown = float(body.get("max_slowdown", MAX_SLOWDOWN))
    refit_audio = bool(body.get("refit_audio", True))
    segment_ids = body.get("segment_ids")

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    seg_res = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    segments = list(seg_res.scalars().all())
    if not segments:
        return {"ok": True, "stretched": 0, "segments": []}

    ffmpeg = _get_ffmpeg()
    from backend.services.tts_service import build_retime_cmd, _probe_duration

    chosen = set(segment_ids) if segment_ids else None
    video_end = float(project.duration or 0.0)
    export_dir = os.path.join(settings.upload_dir, "tts")
    os.makedirs(export_dir, exist_ok=True)

    changes: list[dict] = []
    for i, seg in enumerate(segments):
        if chosen and seg.id not in chosen:
            continue
        if not (seg.text or "").strip():
            continue

        limit = segments[i + 1].start_time - DEAD_AIR_KEEP if i + 1 < len(segments) else (
            video_end if video_end > 0 else seg.end_time
        )
        silence = limit - seg.end_time
        if silence < DEAD_AIR_MIN:
            continue

        current = seg.end_time - seg.start_time
        path = (seg.audio_url or "").lstrip("/")
        spoken = _probe_duration(ffmpeg, path) if path and os.path.exists(path) else 0.0
        # Without a voice yet, the line itself is what may be stretched
        natural = spoken if spoken > 0 else current
        room = max(0.0, natural * max_slowdown - current)
        grow = min(silence, room)
        if grow < 0.1:
            continue

        new_end = round(seg.end_time + grow, 2)
        changes.append({
            "id": seg.id,
            "start_time": round(seg.start_time, 2),
            "old_end": round(seg.end_time, 2),
            "new_end": new_end,
            "gained": round(grow, 2),
            "silence_after": round(silence, 2),
            "voice_seconds": round(spoken, 2),
            "text": (seg.text or "")[:60],
        })
        if not dry_run:
            seg.end_time = new_end

    refitted = 0
    if not dry_run and changes:
        await db.commit()
        if refit_audio:
            by_id = {s.id: s for s in segments}
            for change in changes:
                seg = by_id[change["id"]]
                old_path = (seg.audio_url or "").lstrip("/")
                if not old_path or not os.path.exists(old_path):
                    continue
                target = round(seg.end_time - seg.start_time, 2)
                raw = _probe_duration(ffmpeg, old_path)
                if raw <= 0 or abs(raw - target) <= 0.05:
                    continue
                fitted_name = f"{seg.id}_spread_{uuid.uuid4().hex[:8]}.mp3"
                fitted_path = os.path.join(export_dir, fitted_name)
                cmd = build_retime_cmd(ffmpeg, old_path, fitted_path, raw / target)
                try:
                    res = await asyncio.to_thread(
                        subprocess.run, cmd, capture_output=True, text=True, timeout=60
                    )
                    if res.returncode == 0 and os.path.exists(fitted_path) and os.path.getsize(fitted_path) > 0:
                        # the old file stays on disk so undoing the stretch brings the voice back
                        seg.audio_url = f"/uploads/tts/{fitted_name}"
                        seg.audio_speed = round((seg.audio_speed or 1.0) * raw / target, 2)
                        refitted += 1
                except Exception as e:
                    print(f"[spread] could not refit {seg.id}: {e}")
            await db.commit()

    final = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    final_segs = list(final.scalars().all())
    silence_before = sum(
        max(0.0, b.start_time - a.end_time) for a, b in zip(segments, segments[1:])
    )
    silence_after = sum(
        max(0.0, b.start_time - a.end_time) for a, b in zip(final_segs, final_segs[1:])
    )
    return {
        "ok": True,
        "dry_run": dry_run,
        "stretched": len(changes),
        "refitted_voices": refitted,
        "seconds_reclaimed": round(sum(c["gained"] for c in changes), 2),
        "silence_before": round(silence_before, 1),
        "silence_after": round(silence_after if not dry_run else silence_before - sum(c["gained"] for c in changes), 1),
        "preview": changes[:30],
        "segments": [] if dry_run else [
            SegmentResponse.model_validate(s).model_dump(mode="json") for s in final_segs
        ],
    }


# Evening out speaking rate: a caption box should be about as long as its text takes to say.
# When boxes drift from that, fitting the voice to them makes some lines race and others drawl.
RATE_TARGET_CPS = 16.0         # Khmer characters per second at a comfortable pace
RATE_MIN_SECONDS = 1.0
RATE_MAX_SECONDS = 9.0
RATE_EDGE_GAP = 0.08           # silence kept between neighbouring lines
RATE_REDUB_TEMPO = 2.0         # past this, the stored voice is too mangled to re-fit
RATE_SLACK = 1.5               # a box is only shortened when it is this many times too long


@router.post("/normalize-speaking-rate")
@router.post("/normalize-speaking-rate/")
async def normalize_speaking_rate(
    project_id: str,
    body: dict | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Give every line a box about as long as its text takes to say.

    Each box is resized towards `chars / target_cps`, using whatever silence sits around it and
    never crossing a neighbour. A line keeps its start where possible, since that is where the
    speech begins; only when the room is behind it does the start move earlier.
    {"dry_run": true} reports the before/after spread without changing anything.
    """
    body = body or {}
    dry_run = bool(body.get("dry_run"))
    target_cps = float(body.get("target_cps", RATE_TARGET_CPS))

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    seg_res = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    segments = list(seg_res.scalars().all())
    if not segments:
        return {"ok": True, "adjusted": 0, "segments": []}

    video_end = float(project.duration or 0.0)
    ffmpeg = _get_ffmpeg()
    from backend.services.tts_service import _probe_duration

    def cps(seg, start, end):
        span = max(0.05, end - start)
        return len((seg.text or "").strip()) / span

    before_rates = [
        cps(s, s.start_time, s.end_time) for s in segments if (s.text or "").strip()
    ]

    changes: list[dict] = []
    for i, seg in enumerate(segments):
        text = (seg.text or "").strip()
        if not text:
            continue

        wanted = min(RATE_MAX_SECONDS, max(RATE_MIN_SECONDS, len(text) / target_cps))
        current = seg.end_time - seg.start_time
        if abs(wanted - current) < 0.15:
            continue

        # A line that already overlaps a neighbour must not lose room because of it: this is
        # about pacing, and cutting a crowded line down to the overlap made it race harder.
        floor = min(segments[i - 1].end_time + RATE_EDGE_GAP if i > 0 else 0.0, seg.start_time)
        ceiling = max(
            segments[i + 1].start_time - RATE_EDGE_GAP if i + 1 < len(segments)
            else (video_end if video_end > 0 else seg.end_time + wanted),
            seg.end_time,
        )
        dubbed = bool((seg.audio_url or "").strip())

        new_start, new_end = seg.start_time, seg.end_time
        if wanted > current:
            # grow forwards first — the start is where the speech actually begins
            new_end = min(seg.start_time + wanted, ceiling)
            short_by = wanted - (new_end - new_start)
            # a dubbed line keeps its start: its voice begins there, in step with the actor
            if short_by > 0.05 and not dubbed:
                new_start = max(floor, seg.start_time - short_by)
        else:
            # Too much room. Only a line with a lot to spare is shortened, and never below
            # the time it takes to read or the length of the voice it already has.
            if current < wanted * RATE_SLACK:
                continue
            keep = max(wanted, MIN_CAPTION_SECONDS)
            if dubbed:
                path = seg.audio_url.lstrip("/")
                keep = max(keep, _probe_duration(ffmpeg, path) if os.path.exists(path) else current)
            new_end = seg.start_time + min(current, keep)

        new_start, new_end = round(max(floor, new_start), 2), round(min(ceiling, new_end), 2)
        if abs(new_end - seg.end_time) + abs(new_start - seg.start_time) < 0.1:
            continue

        changes.append({
            "id": seg.id,
            "old": [round(seg.start_time, 2), round(seg.end_time, 2)],
            "new": [new_start, new_end],
            "chars": len(text),
            "old_cps": round(cps(seg, seg.start_time, seg.end_time), 1),
            "new_cps": round(cps(seg, new_start, new_end), 1),
            "needs_redub": (seg.audio_speed or 1.0) >= RATE_REDUB_TEMPO,
            "text": text[:50],
        })
        if not dry_run:
            seg.start_time, seg.end_time = new_start, new_end

    if not dry_run and changes:
        await db.commit()

    after_rates = []
    for s in segments:
        if not (s.text or "").strip():
            continue
        moved = next((c for c in changes if c["id"] == s.id), None)
        start, end = (moved["new"] if moved else [s.start_time, s.end_time])
        after_rates.append(cps(s, start, end))

    def spread(values):
        if not values:
            return {}
        vals = sorted(values)
        p10 = vals[int(len(vals) * 0.1)]
        p90 = vals[min(len(vals) - 1, int(len(vals) * 0.9))]
        return {
            "p10": round(p10, 1),
            "median": round(vals[len(vals) // 2], 1),
            "p90": round(p90, 1),
            "ratio": round(p90 / max(0.1, p10), 1),
        }

    final = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    final_segs = list(final.scalars().all())
    overlaps = sum(
        1 for a, b in zip(final_segs, final_segs[1:]) if a.end_time > b.start_time + 0.01
    )
    return {
        "ok": True,
        "dry_run": dry_run,
        "adjusted": len(changes),
        "total": len(segments),
        "needs_redub": sum(1 for c in changes if c["needs_redub"]),
        "rate_before": spread(before_rates),
        "rate_after": spread(after_rates),
        "overlaps": overlaps,
        "preview": changes[:30],
        "segments": [] if dry_run else [
            SegmentResponse.model_validate(s).model_dump(mode="json") for s in final_segs
        ],
    }


# Splitting over-long captions. A line holding more text than any box can show has to become
# several lines — resizing cannot help it. Khmer writes phrases without spaces between words,
# so the break points are sentence marks first, then the phrase spaces, then a zero-width space.
SPLIT_MAX_CHARS = 90           # the most text one caption should carry
SPLIT_MIN_CHARS = 12           # never leave a scrap this small on its own
SPLIT_GAP = 0.08               # silence between the pieces
_SENTENCE_MARKS = "។៕!?"
_PHRASE_MARKS = "៖,;:"


# Khmer stacks marks onto a base consonant: a subscript (coeng ្), a vowel sign or a
# diacritic cannot begin a line. Cutting blindly produces fragments like "្ពាន".
_KHMER_COMBINING = (
    "\u17b4\u17b5\u17b6\u17b7\u17b8\u17b9\u17ba\u17bb\u17bc\u17bd\u17be\u17bf"
    "\u17c0\u17c1\u17c2\u17c3\u17c4\u17c5\u17c6\u17c7\u17c8\u17c9\u17ca\u17cb"
    "\u17cc\u17cd\u17ce\u17cf\u17d0\u17d1\u17d2\u17d3\u200b"
)


def _safe_khmer_cut(text: str, position: int) -> int:
    """Move a cut point off a combining mark so neither side starts mid-syllable."""
    i = max(1, min(position, len(text) - 1))
    # walk forward past any mark, and past the consonant a coeng belongs to
    limit = min(len(text) - 1, i + 12)
    while i < limit and (text[i] in _KHMER_COMBINING or text[i - 1] == "\u17d2"):
        i += 1
    return i


def _best_break(text: str, lo: int, hi: int) -> int | None:
    """Index to break at, closest to the middle of [lo, hi], preferring stronger punctuation."""
    middle = (lo + hi) / 2
    for candidates in (_SENTENCE_MARKS, _PHRASE_MARKS, " ​"):
        spots = [i + 1 for i in range(lo, hi) if text[i] in candidates]
        spots = [i for i in spots if SPLIT_MIN_CHARS <= i <= len(text) - SPLIT_MIN_CHARS]
        if spots:
            return min(spots, key=lambda i: abs(i - middle))
    return None


def split_caption_text(text: str, max_chars: int = SPLIT_MAX_CHARS) -> list[str]:
    """Break one caption's text into readable pieces, on punctuation where possible."""
    text = (text or "").strip()
    if len(text) <= max_chars:
        return [text] if text else []
    cut = _best_break(text, 0, len(text))
    if cut is None:
        # no punctuation anywhere — fall back to an even split so it is at least readable
        cut = _safe_khmer_cut(text, len(text) // 2)
    left, right = text[:cut].strip(), text[cut:].strip()
    if not left or not right:
        return [text]
    return split_caption_text(left, max_chars) + split_caption_text(right, max_chars)


@router.post("/split-long-captions")
@router.post("/split-long-captions/")
async def split_long_captions(
    project_id: str,
    body: dict | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Break captions carrying more text than a box can show into several lines.

    Each piece gets time in proportion to its text, spread over the original line's slot plus
    whatever silence sits either side of it, without crossing a neighbour. The original voice
    covered the whole line, so it no longer matches any one piece: it is cleared, and the
    pieces need re-dubbing. {"dry_run": true} previews the split.
    """
    body = body or {}
    dry_run = bool(body.get("dry_run"))
    max_chars = int(body.get("max_chars", SPLIT_MAX_CHARS))
    target_cps = float(body.get("target_cps", RATE_TARGET_CPS))

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    seg_res = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    segments = list(seg_res.scalars().all())
    if not segments:
        return {"ok": True, "split": 0, "segments": []}

    video_end = float(project.duration or 0.0)
    previews: list[dict] = []
    hopeless: list[dict] = []
    new_rows: list[Segment] = []
    doomed: list[Segment] = []
    voices_cleared = 0

    for i, seg in enumerate(segments):
        text = (seg.text or "").strip()
        if len(text) <= max_chars:
            continue
        pieces = split_caption_text(text, max_chars)
        if len(pieces) < 2:
            continue

        # These lines often already overlap their neighbours, so a naive floor/ceiling can be
        # narrower than the box the line has today. The pieces must never end up with less
        # room than the whole line started with, or splitting makes the pacing worse.
        floor = min(segments[i - 1].end_time + SPLIT_GAP if i > 0 else 0.0, seg.start_time)
        ceiling = max(
            segments[i + 1].start_time - SPLIT_GAP if i + 1 < len(segments)
            else (video_end if video_end > 0 else seg.end_time + len(text) / target_cps),
            seg.end_time,
        )
        room = max(0.5, ceiling - floor)
        wanted = sum(len(p) for p in pieces) / target_cps + SPLIT_GAP * (len(pieces) - 1)
        allot = min(room, wanted)
        # keep the original start where the room allows, else slide back into the silence
        start = min(max(floor, seg.start_time), max(floor, ceiling - allot))

        spans = []
        speech = max(0.2, allot - SPLIT_GAP * (len(pieces) - 1))
        total_chars = sum(len(p) for p in pieces) or 1
        cursor = start
        for n, piece in enumerate(pieces):
            remaining_pieces = len(pieces) - n
            # never run past the ceiling: whatever is left is shared by the pieces still to come
            room_left = max(0.1, ceiling - cursor - SPLIT_GAP * (remaining_pieces - 1))
            share = min(speech * (len(piece) / total_chars), room_left)
            if remaining_pieces == 1:
                share = room_left
            piece_end = min(cursor + max(0.3, share), ceiling)
            spans.append((round(cursor, 2), round(piece_end, 2)))
            cursor = min(piece_end + SPLIT_GAP, ceiling)

        # Splitting divides the time that exists; it cannot create any. When the line holds
        # far more text than its slot could ever show, the pieces come out just as rushed and
        # the only real repair is re-transcribing that stretch so the text matches the audio.
        worst_cps = max(len(p) / max(0.1, e - s) for p, (s, e) in zip(pieces, spans))
        if worst_cps > target_cps * 2.5:
            hopeless.append({
                "id": seg.id,
                "start": round(seg.start_time, 2),
                "end": round(seg.end_time, 2),
                "chars": len(text),
                "needed_seconds": round(len(text) / target_cps, 1),
                "has_seconds": round(ceiling - floor, 1),
                "text": text[:50],
            })
            continue

        previews.append({
            "id": seg.id,
            "old": [round(seg.start_time, 2), round(seg.end_time, 2)],
            "chars": len(text),
            "pieces": [
                {"text": p[:44], "chars": len(p), "start": s, "end": e,
                 "cps": round(len(p) / max(0.1, e - s), 1)}
                for p, (s, e) in zip(pieces, spans)
            ],
            "had_voice": bool(seg.audio_url),
        })

        if dry_run:
            continue

        # the first piece reuses the original row so nothing else loses its reference
        seg.text = pieces[0]
        seg.start_time, seg.end_time = spans[0]
        if seg.audio_url:
            # The reference is dropped because that voice spoke the whole line and no longer
            # matches any one piece — but the file stays on disk, so undoing the split brings
            # the voice back with it. Old files are cleaned up by the usual pruning.
            seg.audio_url = ""
            seg.audio_speed = 1.0
            voices_cleared += 1
        for piece, (s, e) in zip(pieces[1:], spans[1:]):
            new_rows.append(Segment(
                id=str(uuid.uuid4()),
                project_id=project_id,
                index=0,
                start_time=s,
                end_time=e,
                text=piece,
                original_text="",
                speaker=seg.speaker,
                voice_profile=seg.voice_profile,
                voice_name=seg.voice_name,
                emotion=seg.emotion,
                audio_url="",
            ))

    trimmed = 0
    if not dry_run and (new_rows or previews):
        for row in new_rows:
            db.add(row)
        await db.commit()
        reindexed = await db.execute(
            select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
        )
        ordered = list(reindexed.scalars().all())
        # New pieces can settle on top of a neighbour that was already overlapping, so the
        # whole run is tidied afterwards rather than leaving two captions on screen at once.
        trimmed = _trim_overlaps(ordered)
        for n, seg in enumerate(ordered):
            seg.index = n
        await db.commit()

    final = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    final_segs = list(final.scalars().all())
    over = sum(1 for s in final_segs if len((s.text or "").strip()) > max_chars)
    return {
        "ok": True,
        "dry_run": dry_run,
        "split": len(previews),
        "new_lines": sum(len(p["pieces"]) for p in previews) - len(previews),
        "voices_cleared": voices_cleared if not dry_run else sum(1 for p in previews if p["had_voice"]),
        "still_too_long": len(previews) if dry_run else over,
        "overlaps_trimmed": trimmed,
        "needs_retranscribe": len(hopeless),
        "needs_retranscribe_preview": hopeless[:15],
        "total_before": len(segments),
        "total_after": len(segments) if dry_run else len(final_segs),
        "preview": previews[:20],
        "segments": [] if dry_run else [
            SegmentResponse.model_validate(s).model_dump(mode="json") for s in final_segs
        ],
    }
