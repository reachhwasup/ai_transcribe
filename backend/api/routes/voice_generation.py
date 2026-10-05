"""TTS voice generation for whole videos and per-segment audio."""
import asyncio
import bisect
import json
import os
import re
from dataclasses import dataclass
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, field_validator
from typing import Optional, List
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.services.voice_capture import VoiceEQ
from backend.config import settings
from backend.database.db import get_db
from backend.database.models import Project, Segment
from backend.api.schemas import SegmentResponse

_active_voice_streams: set[str] = set()

router = APIRouter(prefix="/projects/{project_id}/export", tags=["export"])


@dataclass(frozen=True)
class VoiceSegmentSnapshot:
    id: str
    text: str
    start_time: float
    end_time: float
    voice_profile: str
    voice_name: str
    audio_speed: float
    speaker: str
    emotion: str
    audio_url: str
    voice_fx: str

    @classmethod
    def from_segment(cls, segment):
        return cls(**{name: getattr(segment, name) for name in cls.__dataclass_fields__})


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
            "voice_fx": s.voice_fx or "normal",
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
    fit_mode: str = "B"  # A=use gap before next line, B=fit subtitle slot, C=no speed change
    voice_name: Optional[str] = None  # custom neural voice name
    emotion: Optional[str] = None  # emotion prosody offset
    voice_fx: Optional[str] = None

    @field_validator("voice_fx")
    @classmethod
    def _known_effect(cls, v):
        return _check_voice_fx(v)
    skip_existing: bool = True  # If True, continue/skip segments that already have valid dubbed audio


def _fit_max_speedup(fit_mode: str) -> Optional[float]:
    """Return max_speedup for generate_fitted_segment_audio based on fit mode.
    Lines are only ever sped up, never slowed down.
    A: up to 2.0× so speech ends before the next line starts.
    B: up to 2.0× so speech ends with its subtitle.
    C: never change speed (1.0×); long lines may overlap the next one.
    """
    return 1.0 if fit_mode == "C" else 2.0


def _fit_max_duration(fit_mode: str, target_dur: float, room: Optional[float]) -> Optional[float]:
    """Return max_duration parameter based on fit mode.
    A: may run into the gap before the next line.
    B: must end with its own subtitle.
    C: no limit (speed cap of 1.0 means natural length).
    """
    if fit_mode == "B":
        return target_dur
    elif fit_mode == "C":
        return None
    else:  # A
        return room


@router.post("/generate-voice-segments")
async def generate_voice_segments_endpoint(
    project_id: str,
    body: GenerateSegmentVoiceRequest,
    db: AsyncSession = Depends(get_db),
):
    """Generate AI voice for each segment individually, store audio_url on segment."""
    from backend.services.tts_service import generate_fitted_segment_audio, speaker_pitch_offsets, profile_engine, _get_active_tts_engine

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    # Fetch segments
    from backend.services.series_memory import apply_voices
    await apply_voices(db, project_id)

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
    pitch_res = await db.execute(
        select(Segment.speaker, Segment.voice_name, Segment.voice_profile).where(Segment.project_id == project_id)
    )
    pitch_offsets = speaker_pitch_offsets(pitch_res.all())
    # a cast member of the series sounds the same in every episode: their own pitch and pace
    # replace the one this episode alone would have given them
    from backend.services.series_memory import project_voice_settings
    series_voices = await project_voice_settings(db, project_id)
    pitch_offsets.update({name: pitch for name, (pitch, _) in series_voices.items()})
    rate_offsets = {name: rate for name, (_, rate) in series_voices.items()}

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
        if p.get("gender") and p.get("is_built_in"):
            profile_map[p["gender"].lower()] = p
        if p.get("voice_profile") and p.get("is_built_in"):
            profile_map[p["voice_profile"].lower()] = p

    updated = []
    for seg in segments:
        if not seg.text or not seg.text.strip():
            updated.append(SegmentResponse.model_validate(seg))
            continue

        target_dur = max(0.5, seg.end_time - seg.start_time)
        seg_speed = seg.audio_speed if seg.audio_speed and seg.audio_speed != 1.0 else body.speed
        speed_pct = int((seg_speed - 1.0) * 100) + rate_offsets.get(seg.speaker or "", 0)
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
        engine = profile_engine(prof)
        ref_audio = prof.get("sample_audio_url", "")
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
                voice_fx=body.voice_fx if body.voice_fx is not None else (seg.voice_fx or "normal"),
                engine=engine,
                reference_audio=ref_audio,
                max_duration=effective_max_dur,
                max_speedup=effective_speedup,
                pitch_offset=pitch_offsets.get(seg.speaker or "", 0),
            )
            rel_path = os.path.relpath(audio_path, ".")
            new_url = "/" + rel_path.replace("\\", "/")
            if seg.audio_url and seg.audio_url != new_url:
                old_fpath = seg.audio_url.lstrip("/")
                if os.path.exists(old_fpath):
                    try:
                        os.remove(old_fpath)
                    except OSError:
                        pass
            if body.voice_fx is not None:
                seg.voice_fx = body.voice_fx
            seg.audio_url = new_url
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


# The longest one line's voice may take before it is skipped. A cloned (VoxCPM) voice of a long
# line takes about a minute on this machine; Edge takes seconds.
LINE_TIMEOUT_SECONDS = 180


@router.post("/generate-voice-segments-stream")
async def generate_voice_segments_stream(
    project_id: str,
    body: GenerateSegmentVoiceRequest,
    db: AsyncSession = Depends(get_db),
):
    """Stream AI voice generation progress per segment via SSE preserving video alignment."""
    if project_id in _active_voice_streams:
        raise HTTPException(409, "Voice generation is already running for this project. Wait for it to finish or stop it first.")
    from backend.database.db import async_session as make_session
    from backend.services.tts_service import generate_fitted_segment_audio, speaker_pitch_offsets, profile_engine, _get_active_tts_engine
    from backend.api.routes.settings import _get_custom_voice_profiles, DEFAULT_SAMPLE_VOICE_PROFILES

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    from backend.services.series_memory import apply_voices
    await apply_voices(db, project_id)

    segments_snap = []
    if body.segment_ids is not None:
        # Explicit segment list requested by user (e.g. filtered by character / selection)
        clean_ids = [str(sid).strip() for sid in body.segment_ids if str(sid).strip()]
        if clean_ids:
            stmt = select(Segment).where(
                Segment.project_id == project_id,
                Segment.id.in_(clean_ids),
            ).order_by(Segment.start_time)
            result = await db.execute(stmt)
            segments_snap = [VoiceSegmentSnapshot.from_segment(s) for s in result.scalars().all()]
        if not segments_snap:
            raise HTTPException(400, "None of the specified segment IDs were found in this project.")
    else:
        # Fall back to all segments only if segment_ids was completely omitted (None)
        stmt_all = select(Segment).where(
            Segment.project_id == project_id,
        ).order_by(Segment.start_time)
        res_all = await db.execute(stmt_all)
        segments_snap = [VoiceSegmentSnapshot.from_segment(s) for s in res_all.scalars().all()]
        if not segments_snap:
            raise HTTPException(400, "No segments found in this project to generate voice for.")

    total = len(segments_snap)
    request_speed = body.speed
    pitch_res = await db.execute(
        select(Segment.speaker, Segment.voice_name, Segment.voice_profile).where(Segment.project_id == project_id)
    )
    pitch_offsets = speaker_pitch_offsets(pitch_res.all())
    # a cast member of the series sounds the same in every episode: their own pitch and pace
    # replace the one this episode alone would have given them
    from backend.services.series_memory import project_voice_settings
    series_voices = await project_voice_settings(db, project_id)
    pitch_offsets.update({name: pitch for name, (pitch, _) in series_voices.items()})
    rate_offsets = {name: rate for name, (_, rate) in series_voices.items()}
    project_language = project.language or ""

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
        if p.get("gender") and p.get("is_built_in"):
            profile_map[p["gender"].lower()] = p
        if p.get("voice_profile") and p.get("is_built_in"):
            profile_map[p["voice_profile"].lower()] = p

    async def event_stream():
        # Check again after preparing the response: two requests may have arrived together.
        if project_id in _active_voice_streams:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Voice generation is already running for this project.'})}\n\n"
            return
        _active_voice_streams.add(project_id)
        completed = 0
        failed = 0
        pending: dict = {}   # index -> in-flight synthesis task; the finally below cancels these
        try:
            yield f"data: {json.dumps({'type': 'start', 'total': total})}\n\n"

            # Edge TTS is a network call per line, so a few are synthesised ahead while earlier
            # ones are still being saved. Local VoxCPM stays sequential (single GPU).
            uses_local_engine = (await _get_active_tts_engine()).lower() == "voxcpm" or any(
                profile_engine(profile_map.get((body.voice_name or snap.voice_name or "").lower()) or {}).lower() == "voxcpm"
                for snap in segments_snap
            )
            prefetch = 1 if uses_local_engine else 4

            def _synthesis_args(idx: int, snap):
                text_, o_start, o_end = snap.text, snap.start_time, snap.end_time
                v_profile, v_name = snap.voice_profile, snap.voice_name
                a_speed, spk, emo, fx = snap.audio_speed, snap.speaker, snap.emotion, snap.voice_fx
                target_dur = max(0.5, o_end - o_start)
                seg_speed = a_speed if a_speed and a_speed != 1.0 else request_speed
                eff_voice = body.voice_name or v_name or ""
                next_room = None
                if idx < len(segments_snap) - 1:
                    nxt = segments_snap[idx + 1].start_time
                    if nxt > o_start:
                        next_room = max(target_dur, nxt - o_start - 0.05)
                prof = (
                    profile_map.get((eff_voice or "").lower())
                    or profile_map.get((v_profile or "").lower())
                    or profile_map.get((spk or "").lower())
                    or {}
                )
                return dict(
                    text=text_,
                    voice_profile=v_profile or "female",
                    target_duration=target_dur,
                    rate=f"{int((seg_speed - 1.0) * 100) + rate_offsets.get(spk or '', 0):+d}%",
                    voice_name=eff_voice,
                    language=project_language,
                    emotion=body.emotion or emo or "",
                    voice_fx=body.voice_fx if body.voice_fx is not None else (fx or "normal"),
                    engine=profile_engine(prof),
                    reference_audio=prof.get("sample_audio_url", ""),
                    max_duration=_fit_max_duration(body.fit_mode or "B", target_dur, next_room),
                    max_speedup=_fit_max_speedup(body.fit_mode or "B") or 2.5,
                    pitch_offset=pitch_offsets.get(spk or "", 0),
                )

            def _needs_audio(snap) -> bool:
                has_text = bool(snap.text and snap.text.strip())
                cached = (body.voice_fx is None or body.voice_fx == (snap.voice_fx or "normal")) and body.skip_existing and snap.audio_url and _audio_file_valid(snap.audio_url)
                return has_text and not cached

            def _fill_queue(from_idx: int) -> None:
                i = from_idx
                while len(pending) < prefetch and i < len(segments_snap):
                    if i not in pending and _needs_audio(segments_snap[i]):
                        pending[i] = asyncio.create_task(
                            generate_fitted_segment_audio(**_synthesis_args(i, segments_snap[i]))
                        )
                    i += 1

            _fill_queue(0)

            for idx, s in enumerate(segments_snap):
                seg_id, text = s.id, s.text
                orig_start, orig_end = s.start_time, s.end_time
                voice_name, audio_speed = s.voice_name, s.audio_speed
                emotion, existing_audio_url = s.emotion, s.audio_url
                if not text or not text.strip():
                    completed += 1
                    yield f"data: {json.dumps({'type': 'progress', 'completed': completed, 'total': total, 'segment_id': seg_id, 'status': 'skipped'})}\n\n"
                    continue

                # Smart resume / continue: if segment was already dubbed before and file exists on disk, skip it!
                if (body.voice_fx is None or body.voice_fx == (s.voice_fx or "normal")) and body.skip_existing and existing_audio_url and _audio_file_valid(existing_audio_url):
                    completed += 1
                    yield f"data: {json.dumps({'type': 'progress', 'completed': completed, 'total': total, 'segment_id': seg_id, 'audio_url': existing_audio_url, 'start_time': orig_start, 'end_time': orig_end, 'status': 'done', 'cached': True})}\n\n"
                    continue

                yield f"data: {json.dumps({'type': 'segment_start', 'segment_id': seg_id, 'index': idx, 'total': total})}\n\n"

                seg_speed = audio_speed if audio_speed and audio_speed != 1.0 else request_speed
                effective_voice = body.voice_name or voice_name or ""
                effective_emotion = body.emotion or emotion or ""

                try:
                    task = pending.pop(idx, None)
                    if task is None:
                        task = asyncio.create_task(
                            generate_fitted_segment_audio(**_synthesis_args(idx, s))
                        )
                    _fill_queue(idx + 1)  # keep the queue topped up while this one finishes
                    # One line never holds up the rest: whatever it is waiting on, after this
                    # long it is counted as failed and the next line goes ahead.
                    done_now, _ = await asyncio.wait({task}, timeout=LINE_TIMEOUT_SECONDS)
                    if task not in done_now:
                        task.cancel()
                        task.add_done_callback(lambda t: t.cancelled() or t.exception())
                        raise TimeoutError(
                            f"the voice took longer than {LINE_TIMEOUT_SECONDS // 60} minutes and was skipped — "
                            "dub this line again on its own"
                        )
                    audio_path, actual_duration = task.result()
                    rel_path = os.path.relpath(audio_path, ".")
                    audio_url = "/" + rel_path.replace("\\", "/")

                    final_end = orig_end
                    if actual_duration > 0 and (orig_start + actual_duration) > orig_end:
                        final_end = round(orig_start + actual_duration, 2)

                    async with make_session() as sess:
                        res2 = await sess.execute(select(Segment).where(Segment.id == seg_id))
                        seg = res2.scalar_one_or_none()
                        if seg:
                            if seg.audio_url and seg.audio_url != audio_url:
                                old_fpath = seg.audio_url.lstrip("/")
                                if os.path.exists(old_fpath):
                                    try:
                                        os.remove(old_fpath)
                                    except OSError:
                                        pass
                            if body.voice_fx is not None:
                                seg.voice_fx = body.voice_fx
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
                    minutes, seconds = divmod(max(0, orig_start), 60)
                    line_error = f"At {int(minutes)}:{seconds:05.2f}: {e}"
                    yield f"data: {json.dumps({'type': 'progress', 'completed': completed, 'total': total, 'segment_id': seg_id, 'status': 'error', 'message': line_error})}\n\n"

            yield f"data: {json.dumps({'type': 'done', 'completed': completed, 'total': total, 'failed': failed})}\n\n"

        except asyncio.CancelledError:
            # The browser stopped the dub. Lines already written to the database keep their
            # audio; drop the work queued behind them so a local engine is not left synthesising
            # into a connection nobody is reading.
            print(f"[dub] stopped by the client after {completed} of {total} lines")
            raise
        except Exception as e:
            import traceback
            print(f"[event_stream exception]: {e}")
            traceback.print_exc()
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
        finally:
            for task in pending.values():
                task.cancel()
            if pending:
                await asyncio.gather(*pending.values(), return_exceptions=True)
            pending.clear()
            _active_voice_streams.discard(project_id)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


class CaptureVoiceRequest(BaseModel):
    eq: Optional[VoiceEQ] = None
    group_id: str = ""
    name: str
    start_time: float
    end_time: float
    speaker: Optional[str] = None


@router.post("/capture-voice")
async def capture_voice(
    project_id: str,
    body: CaptureVoiceRequest,
    db: AsyncSession = Depends(get_db),
):
    """Capture original movie audio and save a reusable VoxCPM voice profile."""
    import math
    import uuid
    from pathlib import Path
    from datetime import datetime, timezone
    from backend.services.voice_capture import extract_voice_sample
    from backend.api.routes.settings import _get_custom_voice_profiles, _set_setting, _validate_voice_group

    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    if not project.video_path or not os.path.isfile(project.video_path):
        raise HTTPException(400, "Upload a movie before capturing a voice")
    if not body.name.strip() or len(body.name.strip()) > 100:
        raise HTTPException(400, "Enter a voice name of 1–100 characters")
    start, end = body.start_time, body.end_time
    if (not all(math.isfinite(t) for t in (start, end)) or start < 0
            or end > project.duration or not 3 <= end - start <= 30):
        raise HTTPException(400, "Choose 3–30 seconds within the original movie")
    segments = []
    if body.speaker:
        result = await db.execute(select(Segment).where(
            Segment.project_id == project_id, Segment.speaker == body.speaker,
        ))
        segments = result.scalars().all()
        if not segments:
            raise HTTPException(400, "Character not found in this project")
    await _validate_voice_group(db, body.group_id)
    profile_id = f"custom_{uuid.uuid4().hex[:10]}"
    filename = f"capture_{uuid.uuid4().hex}.wav"
    destination = Path(settings.upload_dir) / "tts" / "samples" / filename
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        await asyncio.to_thread(extract_voice_sample, project.video_path, str(destination), start, end, body.eq)
        profile = {
            "group_id": body.group_id,
            "eq": body.eq.model_dump() if body.eq else None,
            "id": profile_id, "name": body.name.strip(), "gender": "female",
            "voice_name": profile_id, "engine": "voxcpm", "language": project.language or "km",
            "pitch": "+0Hz", "rate": "+0%", "emotion": "neutral",
            "description": f"Captured from {project.name}: {start:.2f}–{end:.2f}s",
            "sample_audio_url": f"/uploads/tts/samples/{filename}",
            "is_built_in": False, "created_at": datetime.now(timezone.utc).isoformat(),
        }
        profiles = await _get_custom_voice_profiles(db)
        profiles.append(profile)
        await _set_setting(db, "custom_voice_profiles", json.dumps(profiles))
        for segment in segments:
            segment.voice_name = profile_id
            segment.audio_url = ""  # Regenerate cached dubbing with the captured voice.
        await db.commit()
    except Exception as exc:
        await db.rollback()
        destination.unlink(missing_ok=True)
        if isinstance(exc, ValueError):
            raise HTTPException(400, str(exc)) from exc
        raise HTTPException(500, "Voice capture failed; check the movie audio and FFmpeg installation") from exc
    return {"profile": profile, "assigned_segments": len(segments)}


@router.get("/voice-waveform")
async def get_voice_waveform(project_id: str, start: float = 0, overview: bool = False, db: AsyncSession = Depends(get_db)):
    import math
    from backend.services.voice_capture import voice_waveform

    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    if not project.video_path or not os.path.isfile(project.video_path):
        raise HTTPException(400, "Upload a movie first")
    if not math.isfinite(start) or start < 0 or start >= project.duration:
        raise HTTPException(400, "Waveform start must be within the movie")
    duration = project.duration if overview else min(60, project.duration - start)
    try:
        if overview:
            from backend.services.voice_capture import full_voice_waveform
            start = 0
            peaks = await asyncio.to_thread(full_voice_waveform, project.video_path, os.stat(project.video_path).st_mtime_ns, duration)
        else:
            peaks = await asyncio.to_thread(voice_waveform, project.video_path, start, duration)
    except Exception as exc:
        raise HTTPException(500, "Unable to load audio waveform") from exc
    return {"start": start, "duration": duration, "peaks": peaks}


class VoicePreviewRequest(BaseModel):
    start_time: float
    end_time: float
    eq: Optional[VoiceEQ] = None


@router.post("/preview-capture-voice")
async def preview_capture_voice(project_id: str, body: VoicePreviewRequest, db: AsyncSession = Depends(get_db)):
    import math
    import tempfile
    from pathlib import Path
    from starlette.background import BackgroundTask
    from backend.services.voice_capture import extract_voice_sample
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    if not project.video_path or not os.path.isfile(project.video_path):
        raise HTTPException(400, "Upload a movie first")
    start, end = body.start_time, body.end_time
    if not all(math.isfinite(t) for t in (start, end)) or start < 0 or end > project.duration or not 3 <= end - start <= 30:
        raise HTTPException(400, "Choose 3–30 seconds within the movie")
    handle, filename = tempfile.mkstemp(suffix=".wav")
    os.close(handle)
    path = Path(filename)
    try:
        await asyncio.to_thread(extract_voice_sample, project.video_path, filename, start, end, body.eq)
    except Exception as exc:
        path.unlink(missing_ok=True)
        raise HTTPException(500, "Unable to prepare the voice EQ preview") from exc
    return FileResponse(filename, media_type="audio/wav", background=BackgroundTask(path.unlink, missing_ok=True))


# --- Voice effects without re-synthesis ---
# A style is just a filter on top of the finished voice, so changing it needs ffmpeg, not TTS.
# The clean ("dry") voice stays at its own path and each style is written beside it as
# <name>.fx-<style>.mp3, which makes switching instant and switching back free.

_FX_SUFFIX = re.compile(r"\.fx-[a-z]+(?:-v\d+)?(?=\.[^./\\]+$)")


def _check_voice_fx(value: Optional[str]) -> Optional[str]:
    from backend.services.tts_service import VOICE_FX_LABELS

    if value is not None and value not in VOICE_FX_LABELS:
        raise ValueError(f"Unknown voice effect {value!r}")
    return value


class ApplyVoiceFxRequest(BaseModel):
    segment_ids: List[str]
    voice_fx: str
    # Render the styled audio and hand back its URL without changing the clip
    preview: bool = False

    @field_validator("voice_fx")
    @classmethod
    def _known_effect(cls, v):
        return _check_voice_fx(v)


def _dry_voice_path(path: str, current_fx: str) -> str:
    """The un-styled voice a clip's audio was made from, or "" when there is none on disk."""
    if (current_fx or "normal") == "normal":
        return path if os.path.isfile(path) else ""
    dry = _FX_SUFFIX.sub("", path)
    # A clip generated with its style baked in has no clean copy to start from
    return dry if dry != path and os.path.isfile(dry) else ""


@router.post("/apply-voice-fx")
async def apply_voice_fx(project_id: str, body: ApplyVoiceFxRequest, db: AsyncSession = Depends(get_db)):
    """Restyle existing voice clips. Clips with no clean copy come back in `needs_voice`,
    to be regenerated once as Normal and then styled here."""
    from backend.services.tts_service import VOICE_FX_VERSION, render_voice_fx

    res = await db.execute(
        select(Segment).where(Segment.project_id == project_id, Segment.id.in_(body.segment_ids))
    )
    segments = list(res.scalars().all())
    if not segments:
        raise HTTPException(404, "No matching voice clips")

    sem = asyncio.Semaphore(4)

    async def _style(seg):
        path = (seg.audio_url or "").lstrip("/")
        dry = _dry_voice_path(path, seg.voice_fx) if path else ""
        if not dry:
            return seg, None
        if body.voice_fx == "normal":
            return seg, dry
        stem, ext = os.path.splitext(dry)
        out = f"{stem}.fx-{body.voice_fx}-v{VOICE_FX_VERSION}{ext}"
        # Earlier styled copies are kept (undo may point at them), so reuse one when it is there
        if not (os.path.isfile(out) and os.path.getsize(out) > 0):
            async with sem:
                await asyncio.to_thread(render_voice_fx, dry, out, body.voice_fx)
        return seg, out

    results = await asyncio.gather(*[_style(s) for s in segments])
    if body.preview:
        return {
            "previews": {seg.id: "/" + out.replace("\\", "/") for seg, out in results if out},
            "needs_voice": [seg.id for seg, out in results if out is None],
        }

    applied, needs_voice = [], []
    for seg, out in results:
        if out is None:
            needs_voice.append(seg.id)
            continue
        seg.audio_url = "/" + out.replace("\\", "/")
        seg.voice_fx = body.voice_fx
        applied.append(seg)
    await db.commit()
    return {
        "applied": [s.id for s in applied],
        "needs_voice": needs_voice,
        "segments": [SegmentResponse.model_validate(s).model_dump(mode="json") for s in applied],
    }


# --- Voices that contradict the line's gender ---
# A panel-wide "Dubbing voice" picker (default: Piseth) used to be saved onto every line it
# dubbed, so women ended up with the male voice and the detected gender was ignored. Only the
# two built-in voices are checked: a saved or cloned voice is a deliberate choice.


# --- One gender per character ---
# The check above catches a voice that disagrees with its line's profile. This one catches the
# profile itself being wrong: the same character tagged male on some lines and female on others.

class FixCharacterGendersRequest(BaseModel):
    dry_run: bool = False


@router.post("/fix-character-genders")
async def fix_character_genders(project_id: str, body: FixCharacterGendersRequest, db: AsyncSession = Depends(get_db)):
    """Decide each named character's gender once and apply it to all of their lines.
    {"dry_run": true} reports what would change."""
    from backend.services.cast import apply_cast_to_segments, decide_cast, family
    from backend.services.project_versions import auto_save

    if not await db.get(Project, project_id):
        raise HTTPException(404, "Project not found")
    segs = (await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )).scalars().all()
    lines = [
        {"speaker": s.speaker, "voice_profile": s.voice_profile, "text": s.text, "original_text": s.original_text}
        for s in segs
    ]
    cast = await decide_cast(lines)
    report = []
    for name, decided in cast.items():
        wrong = decided["female_lines"] if family(decided["profile"]) == "male" else decided["male_lines"]
        mine = [s for s in segs if (s.speaker or "").strip() == name]
        off = sum(1 for s in mine if (s.voice_profile or "female").lower() != decided["profile"])
        if off:
            report.append({
                "name": name, "profile": decided["profile"], "decided_by": decided["decided_by"],
                "lines": len(mine), "lines_changed": off, "lines_wrong_gender": wrong,
            })
    report.sort(key=lambda r: -r["lines_changed"])
    changed = sum(r["lines_changed"] for r in report)
    cleared = 0
    if not body.dry_run and changed:
        await auto_save(db, project_id, f"Before giving {len(report)} characters one gender each")
        changed, cleared = apply_cast_to_segments(list(segs), cast)
        await db.commit()
    return {
        "dry_run": body.dry_run,
        "characters": report,
        "lines_changed": changed,
        "voices_cleared": cleared if not body.dry_run else sum(
            1 for s in segs
            if (s.audio_url or "") and cast.get((s.speaker or "").strip(), {}).get("profile") not in (None, (s.voice_profile or "female").lower())
        ),
        "named_characters": len(cast),
    }

