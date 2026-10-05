"""AI-generated content: narration, assistant agent, titles, hooks, social scripts, TTS previews."""
from __future__ import annotations
import os
import re
import shutil
import subprocess
import uuid
import json
import asyncio
import logging
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.config import settings
from backend.database.db import get_db
from backend.database.models import Project, Segment
from backend.api.schemas import SegmentResponse
from backend.services.gemini_marketing import generate_catchy_hooks
from backend.services.tts_service import generate_segment_audio, _probe_duration, profile_engine

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects/{project_id}/transcripts", tags=["transcripts"])


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
                engine = profile_engine(p)
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
        voice_fx=body.get("voice_fx", "normal"),
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


# --- Publish kit: titles, descriptions and tags, written once and kept with the project ---

PUBLISH_KIT_FIELDS = ("titles", "hook", "description", "short_caption", "facebook_caption",
                      "hashtags", "hashtags_off", "seo_keywords", "pinned_comment", "thumbnail_texts", "chosen_title")


async def _publish_lines(project_id: str, db: AsyncSession) -> tuple[list[str], list[dict]]:
    """The transcript as lines for the writer, and as the records its fingerprint is taken from."""
    result = await db.execute(select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time))
    lines, records = [], []
    for seg in result.scalars().all():
        text = (seg.text or "").strip()
        if not text or seg.speaker == "Freeze" or seg.voice_profile == "freeze":
            continue
        lines.append(f"{(seg.speaker or '').strip() + ': ' if (seg.speaker or '').strip() else ''}{text}")
        records.append({"start": seg.start_time, "text": text})
    return lines, records


async def _series_context(project_id: str, project_name: str, db: AsyncSession) -> dict:
    """What is known about the series this project is a part of.

    A project that has none yet is offered the series of the project worked on last, with its
    own part number read from its name — parts of one series are made one after another, and
    typing the series in for each of them would not get done."""
    from backend.database.models import AppSetting
    from backend.services.publish_kit import clean_series, guess_part

    row = await db.get(AppSetting, f"publish_series:{project_id}")
    if row and row.value:
        try:
            return {**clean_series(json.loads(row.value)), "suggested": False}
        except ValueError:
            pass
    last = await db.get(AppSetting, "publish_series:last")
    try:
        offered = clean_series(json.loads(last.value)) if last and last.value else clean_series({})
    except ValueError:
        offered = clean_series({})
    offered["part"] = guess_part(project_name)
    if not offered["series_name"]:
        try:      # the poster's own title, once it has been read, is the series' name
            with open(os.path.join(settings.upload_dir, project_id, "poster", "reading.json"), encoding="utf-8") as src:
                offered["series_name"] = str(json.load(src).get("title") or "")
        except (OSError, ValueError):
            pass
    return {**offered, "suggested": True}


@router.get("/publish-series")
async def get_publish_series(project_id: str, db: AsyncSession = Depends(get_db)):
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return await _series_context(project_id, project.name or "", db)


@router.put("/publish-series")
async def save_publish_series(project_id: str, body: dict, db: AsyncSession = Depends(get_db)):
    """Keep what this project's series is, and remember it as the one to offer the next project."""
    from backend.api.routes.settings import _set_setting
    from backend.services.publish_kit import clean_series

    if not await db.get(Project, project_id):
        raise HTTPException(404, "Project not found")
    series = clean_series(body)
    await _set_setting(db, f"publish_series:{project_id}", json.dumps(series, ensure_ascii=False))
    if series["series_name"] or series["premise"]:
        await _set_setting(db, "publish_series:last", json.dumps({**series, "part": 0}, ensure_ascii=False))
    await db.commit()
    return {**series, "suggested": False}


@router.get("/publish-kit")
async def get_publish_kit(project_id: str, db: AsyncSession = Depends(get_db)):
    """The saved kit, with `stale` set when the captions have changed since it was written."""
    from backend.database.models import AppSetting

    if not await db.get(Project, project_id):
        raise HTTPException(404, "Project not found")
    row = await db.get(AppSetting, f"publish_kit:{project_id}")
    if not row or not row.value:
        return None
    try:
        kit = json.loads(row.value)
    except ValueError:
        return None
    _, records = await _publish_lines(project_id, db)
    kit["stale"] = bool(kit.get("transcript_fingerprint")) and kit["transcript_fingerprint"] != _transcript_fingerprint(records)
    return kit


@router.post("/publish-kit")
async def generate_publish_kit_endpoint(project_id: str, body: dict, db: AsyncSession = Depends(get_db)):
    """Write titles, descriptions and tags from this project's captions, and keep them."""
    from datetime import datetime, timezone
    from backend.api.routes.settings import _set_setting
    from backend.services.publish_kit import PLATFORMS, TONES, generate_publish_kit

    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    lines, records = await _publish_lines(project_id, db)
    if not lines:
        raise HTTPException(400, "Add captions first — the titles are written from what is said in the video.")
    tone = body.get("tone") if body.get("tone") in TONES else "viral"
    platform = body.get("platform") if body.get("platform") in PLATFORMS else "all"
    language = str(body.get("language") or project.language or "km")
    try:
        series = await _series_context(project_id, project.name or "", db)
        # an offered series is only a guess until the person has confirmed it by saving
        kit = await generate_publish_kit(lines, project.name or "", language, tone, platform,
                                         None if series["suggested"] else series)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc
    kit.update({
        "tone": tone, "platform": platform, "language": language,
        "series": None if series["suggested"] else {k: v for k, v in series.items() if k != "suggested"},
        "chosen_title": kit["titles"][0]["text"],
        "source_segments": len(lines),
        "transcript_fingerprint": _transcript_fingerprint(records),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    })
    await _set_setting(db, f"publish_kit:{project_id}", json.dumps(kit, ensure_ascii=False))
    await db.commit()
    return {**kit, "stale": False}


@router.put("/publish-kit")
async def save_publish_kit_edits(project_id: str, body: dict, db: AsyncSession = Depends(get_db)):
    """Keep edits made to the kit by hand."""
    from backend.api.routes.settings import _set_setting
    from backend.database.models import AppSetting

    row = await db.get(AppSetting, f"publish_kit:{project_id}")
    if not row or not row.value:
        raise HTTPException(404, "There is no kit to edit yet")
    kit = json.loads(row.value)
    for key in PUBLISH_KIT_FIELDS:
        if key in body:
            kit[key] = body[key]
    await _set_setting(db, f"publish_kit:{project_id}", json.dumps(kit, ensure_ascii=False))
    await db.commit()
    return {"saved": True}


async def _poster_state(project_id: str) -> dict:
    """What is kept for this project's poster, with addresses the browser can load."""
    from backend.services import codex_client

    folder = os.path.join(settings.upload_dir, project_id, "poster")
    state = {"original_url": None, "clean_url": None, "clean_engine": None,
             "titled_url": None, "titled_engine": None, "titled_title": None, "titled_subtitle": None,
             "reading": None,
             "codex_ready": (await codex_client.status())["signed_in"]}
    try:
        with open(os.path.join(folder, "titled.json"), encoding="utf-8") as src:
            made = json.load(src)
        state.update(titled_engine=made.get("engine"), titled_title=made.get("title"), titled_subtitle=made.get("subtitle"))
    except (OSError, ValueError):
        pass
    try:
        with open(os.path.join(folder, "reading.json"), encoding="utf-8") as src:
            state["reading"] = json.load(src)
    except (OSError, ValueError):
        pass
    note = os.path.join(folder, "clean.engine")
    if os.path.exists(note):
        with open(note) as src:
            state["clean_engine"] = src.read().strip() or None
    for name, field in (("original.jpg", "original_url"), ("clean.jpg", "clean_url"), ("titled.jpg", "titled_url")):
        path = os.path.join(folder, name)
        if os.path.exists(path):
            # the time in the address makes the browser fetch a replaced poster afresh
            state[field] = f"/uploads/{project_id}/poster/{name}?v={int(os.path.getmtime(path))}"
    return state


@router.get("/poster")
async def get_poster(project_id: str, db: AsyncSession = Depends(get_db)):
    if not await db.get(Project, project_id):
        raise HTTPException(404, "Project not found")
    return await _poster_state(project_id)


@router.post("/poster")
async def upload_poster(project_id: str, image: UploadFile = File(...), db: AsyncSession = Depends(get_db)):
    """Keep the film's original poster with the project, to make a thumbnail from."""
    from backend.services.poster import PosterError, prepare

    if not await db.get(Project, project_id):
        raise HTTPException(404, "Project not found")
    try:
        prepared, _, _ = await asyncio.to_thread(prepare, await image.read())
    except PosterError as exc:
        raise HTTPException(400, str(exc)) from exc
    folder = os.path.join(settings.upload_dir, project_id, "poster")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, "original.jpg"), "wb") as out:
        out.write(prepared)
    for name in ("clean.jpg", "clean.engine", "titled.jpg", "titled.json", "reading.json"):     # made from the poster this one replaces
        if os.path.exists(os.path.join(folder, name)):
            os.remove(os.path.join(folder, name))
    return await _poster_state(project_id)


@router.post("/poster/remove-title")
async def remove_poster_title(project_id: str, body: dict | None = None, db: AsyncSession = Depends(get_db)):
    """Paint the original title out of the poster. The new title is drawn by the editor."""
    from PIL import Image
    from backend.services.poster import PosterError, remove_title

    if not await db.get(Project, project_id):
        raise HTTPException(404, "Project not found")
    folder = os.path.join(settings.upload_dir, project_id, "poster")
    original = os.path.join(folder, "original.jpg")
    if not os.path.exists(original):
        raise HTTPException(400, "Upload the poster first.")
    with open(original, "rb") as src:
        prepared = src.read()
    with Image.open(original) as picture:
        width, height = picture.size
    try:
        cleaned, engine = await remove_title(prepared, width, height, str((body or {}).get("engine") or "auto"))
    except PosterError as exc:
        raise HTTPException(502, str(exc)) from exc
    with open(os.path.join(folder, "clean.jpg"), "wb") as out:
        out.write(cleaned)
    with open(os.path.join(folder, "clean.engine"), "w") as out:
        out.write(engine)
    return await _poster_state(project_id)


@router.post("/poster/read-title")
async def read_poster_title(project_id: str, body: dict | None = None, db: AsyncSession = Depends(get_db)):
    """Read the poster's own title and give it in the project's language, to use as the new title."""
    from backend.services.poster import PosterError, read_title

    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    folder = os.path.join(settings.upload_dir, project_id, "poster")
    original = os.path.join(folder, "original.jpg")
    if not os.path.exists(original):
        raise HTTPException(400, "Upload the poster first.")
    with open(original, "rb") as src:
        prepared = src.read()
    try:
        reading = await read_title(prepared, str((body or {}).get("language") or project.language or "km"))
    except PosterError as exc:
        raise HTTPException(502, str(exc)) from exc
    with open(os.path.join(folder, "reading.json"), "w", encoding="utf-8") as out:
        json.dump(reading, out, ensure_ascii=False)
    return await _poster_state(project_id)


@router.post("/poster/with-title")
async def paint_poster_title(project_id: str, body: dict, db: AsyncSession = Depends(get_db)):
    """Repaint the poster with a new title lettered where the original was, in its style."""
    from PIL import Image
    from backend.services.poster import PosterError, clean_line, paint_title

    if not await db.get(Project, project_id):
        raise HTTPException(404, "Project not found")
    folder = os.path.join(settings.upload_dir, project_id, "poster")
    original = os.path.join(folder, "original.jpg")
    if not os.path.exists(original):
        raise HTTPException(400, "Upload the poster first.")
    with open(original, "rb") as src:
        prepared = src.read()
    with Image.open(original) as picture:
        width, height = picture.size
    title, subtitle = clean_line(body.get("title")), clean_line(body.get("subtitle"))
    try:
        painted, engine = await paint_title(prepared, width, height, title, subtitle, str(body.get("engine") or "auto"))
    except PosterError as exc:
        raise HTTPException(400 if "Type the title" in str(exc) or "too long" in str(exc) else 502, str(exc)) from exc
    with open(os.path.join(folder, "titled.jpg"), "wb") as out:
        out.write(painted)
    with open(os.path.join(folder, "titled.json"), "w", encoding="utf-8") as out:
        json.dump({"engine": engine, "title": title, "subtitle": subtitle}, out, ensure_ascii=False)
    return await _poster_state(project_id)


@router.delete("/poster")
async def delete_poster(project_id: str):
    shutil.rmtree(os.path.join(settings.upload_dir, project_id, "poster"), ignore_errors=True)
    return await _poster_state(project_id)


@router.post("/generate-hooks")
@router.post("/generate-hooks/")
async def generate_hooks_endpoint(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Generate high-retention opening hooks with specific seconds before dubbing."""
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
    try:
        duration_seconds = float(body.get("duration_seconds") or 4.0)
    except (ValueError, TypeError):
        duration_seconds = 4.0
    tone = body.get("tone", "viral")

    transcript_text = "\n".join([
        f"[{s.start_time:.1f}s - {s.end_time:.1f}s] {s.speaker}: {s.text}"
        for s in sorted(project.segments, key=lambda x: x.start_time)
        if s.text and s.text.strip()
    ])

    hooks = await generate_catchy_hooks(
        original_title=original_title,
        transcript_text=transcript_text,
        video_path=project.video_path or "",
        language=language,
        duration_seconds=duration_seconds,
        tone=tone,
    )
    # A hook takes over the opening of the video for as long as it claims to last, so the claim
    # has to match the words: a short stand-in text (used when the AI is unavailable) must not
    # reserve — and clear the captions from — a long stretch it cannot fill.
    from backend.services.gemini_marketing import HOOK_CHARS_PER_SECOND
    for hook in hooks or []:
        spoken = len(str(hook.get("text") or "")) / HOOK_CHARS_PER_SECOND
        if duration_seconds > 10 and spoken < float(hook.get("estimated_seconds") or duration_seconds) * 0.7:
            hook["estimated_seconds"] = round(max(3.0, spoken * 1.1), 1)
    return hooks


def _chunk_intro_hook_segments(text: str, total_duration: float, words_per_chunk: int = 5) -> list[dict]:
    """Break hook text into clean 4, 5, or 6 word subtitle chunks with proportional timing."""
    import re
    KHMER_SPLIT_KEYWORDS = [
        'អ្នកណាទៅដឹងថា', 'ហេតុអ្វីបានជា', 'ស្រាប់តែត្រូវ', 'ស្រាប់តែ', 'អ្នកដែល', 'ដែលជា',
        'មហាសេដ្ឋី', 'គុណបុត្រ', 'ត្រកូល', 'អង្គរក្ស', 'សម្រុកចូល', 'ភូមិគ្រឹះ', 'កម្ទេច',
        'លាក់ខ្លួន', 'ធ្វើជា', 'ប្រុសស៊ីបាយកក', 'មើលងាយថា', 'មើលងាយ', 'ព្រមឱ្យគេ',
        'ទៅវិញ?', 'ទៅវិញ!', 'ទៅវិញ', 'ដល់ផ្ទះ', 'មិនធម្មតាទេ', 'ចាំមើល', 'វាយបកវិញ',
        'ចេញមុខ', 'ជះទឹក', 'បំបាក់មុខ', 'កក្រើក', 'សង្គ្រោះមុខមាត់', 'អតីត', 'ស្តេចសេចក្តីស្លាប់'
    ]
    processed = text
    for kw in sorted(KHMER_SPLIT_KEYWORDS, key=len, reverse=True):
        processed = re.sub(rf'(?<!\s)({re.escape(kw)})', r' \1', processed)
        processed = re.sub(rf'({re.escape(kw)})(?!\s)', r'\1 ', processed)

    processed = re.sub(r'([។!?,])', r'\1 ', processed)
    words = [w.strip() for w in processed.split() if w.strip()]
    if not words:
        words = [text]

    chunks = []
    i = 0
    w_limit = max(3, min(words_per_chunk, 6))
    while i < len(words):
        chunk_size = min(w_limit, len(words) - i)
        if len(words) - (i + chunk_size) == 1:
            chunk_size += 1
        chunk = words[i:i + chunk_size]
        chunks.append(' '.join(chunk))
        i += chunk_size

    if not chunks:
        chunks = [text]

    total_chars = sum(len(c) for c in chunks) or 1
    cur_t = 0.0
    result = []
    for idx, c in enumerate(chunks):
        c_dur = (len(c) / total_chars) * total_duration
        end_t = total_duration if idx == len(chunks) - 1 else round(min(total_duration, cur_t + c_dur), 2)
        result.append({
            'start_time': round(cur_t, 2),
            'end_time': round(end_t, 2),
            'text': c
        })
        cur_t = end_t
    return result


@router.post("/retime-intro-hook")
@router.post("/retime-intro-hook/")
async def retime_intro_hook(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Lay the hook's caption chunks onto the audio that was actually generated.

    The chunks are first timed from an estimate, so the captions drift from the voice. Once the
    audio exists we know each chunk's real length and can place them back to back.
    """
    from backend.services.tts_service import _get_ffmpeg, _probe_duration

    segment_ids = [str(i) for i in (body.get("segment_ids") or [])]
    if not segment_ids:
        raise HTTPException(400, "segment_ids is required")
    gap = float(body.get("gap_seconds") or 0.05)

    res = await db.execute(
        select(Segment).where(Segment.project_id == project_id, Segment.id.in_(segment_ids))
    )
    hook_segments = sorted(res.scalars().all(), key=lambda s: s.start_time)
    if not hook_segments:
        raise HTTPException(404, "Hook segments not found")

    planned_end = max(s.end_time for s in hook_segments)
    ffmpeg = _get_ffmpeg()
    cursor = round(min(s.start_time for s in hook_segments), 2)
    missing_audio = 0
    for seg in hook_segments:
        path = (seg.audio_url or "").lstrip("/")
        spoken = _probe_duration(ffmpeg, path) if path and os.path.exists(path) else 0.0
        if spoken <= 0:
            missing_audio += 1
            spoken = seg.end_time - seg.start_time  # keep its planned length
        seg.start_time = round(cursor, 2)
        seg.end_time = round(cursor + spoken, 2)
        cursor = seg.end_time + gap

    hook_end = round(cursor - gap, 2)
    overflow = round(hook_end - planned_end, 2)

    # Captions that now sit under the hook would be talked over; push them clear of it.
    pushed = 0
    if overflow > 0.05:
        others = await db.execute(
            select(Segment).where(Segment.project_id == project_id, Segment.id.not_in(segment_ids))
        )
        rest = sorted(others.scalars().all(), key=lambda s: s.start_time)
        clashing = [s for s in rest if s.start_time < hook_end + gap]
        if clashing:
            # One shared delta, so the captions keep their spacing instead of piling up on one start.
            shift = hook_end + gap - clashing[0].start_time
            for seg in rest:
                seg.start_time = round(seg.start_time + shift, 2)
                seg.end_time = round(seg.end_time + shift, 2)
            pushed = len(rest)

    await db.commit()
    all_res = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )
    return {
        "hook_seconds": hook_end,
        "planned_seconds": round(planned_end, 2),
        "overflow_seconds": overflow,
        "pushed_segments": pushed,
        "missing_audio": missing_audio,
        "segments": [SegmentResponse.model_validate(s).model_dump(mode="json") for s in all_res.scalars().all()],
    }


@router.post("/insert-intro-hook")
@router.post("/insert-intro-hook/")
async def insert_intro_hook_endpoint(
    project_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Atomically insert an intro hook at 0:00 split into 4-6 word subtitle segments."""
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
        raise HTTPException(400, "Hook text is required")

    try:
        dur = float(body.get("duration_seconds") or 4.0)
    except (ValueError, TypeError):
        dur = 4.0

    words_limit = int(body.get("words_per_segment") or 5)
    speaker = body.get("speaker", "Intro Hook (អ្នករៀបរាប់)")
    voice_profile = body.get("voice_profile", "male")
    emotion = body.get("emotion", "excited")

    # 1. Clean up overlapping opening segments within [0.0s, dur]
    delete_ids = [s.id for s in project.segments if s.start_time < dur and s.end_time <= dur + 0.15]
    trim_segs = [s for s in project.segments if s.start_time < dur and s.end_time > dur]

    replaced_count = len(delete_ids)
    if delete_ids:
        from backend.services.project_versions import auto_save

        await auto_save(db, project_id, "Before inserting the intro hook")
        await db.execute(delete(Segment).where(Segment.id.in_(delete_ids)))

    for s in trim_segs:
        s.start_time = dur

    # 2. Break hook into 4, 5, or 6 word subtitle segments
    chunks = _chunk_intro_hook_segments(text, dur, words_per_chunk=words_limit)
    new_segments = []
    for c in chunks:
        seg = Segment(
            id=str(uuid.uuid4()),
            project_id=project.id,
            index=0,
            start_time=c["start_time"],
            end_time=c["end_time"],
            text=c["text"],
            speaker=speaker,
            voice_profile=voice_profile,
            emotion=emotion,
        )
        db.add(seg)
        new_segments.append(seg)

    await db.commit()

    # Re-fetch fresh sorted segments
    fresh_res = await db.execute(
        select(Project)
        .options(selectinload(Project.segments))
        .where(Project.id == project_id)
    )
    fresh_project = fresh_res.scalar_one()
    sorted_segs = sorted(fresh_project.segments, key=lambda x: x.start_time)

    # Re-index remaining segments
    for idx, s in enumerate(sorted_segs):
        s.index = idx
    await db.commit()

    return {
        "success": True,
        "segment_id": new_segments[0].id if new_segments else "",
        "segment_ids": [s.id for s in new_segments],
        "replaced_captions": replaced_count,
        "segments": [s.to_dict() if hasattr(s, "to_dict") else {
            "id": s.id,
            "project_id": s.project_id,
            "index": s.index,
            "start_time": s.start_time,
            "end_time": s.end_time,
            "text": s.text,
            "speaker": s.speaker,
            "voice_profile": s.voice_profile,
            "emotion": s.emotion,
            "audio_url": s.audio_url,
        } for s in sorted_segs]
    }


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
                engine = profile_engine(p)
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


from backend.services.movie_recap import RecapOptions, summarize_transcript, parse_external_transcript


_CJK_RUN = re.compile(r"[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]+")


def _strip_cjk(text: str) -> str:
    """Remove Chinese/Japanese/Korean characters from a line meant to be spoken in Khmer."""
    if not text or not _CJK_RUN.search(text):
        return text
    return re.sub(r"\s{2,}", " ", _CJK_RUN.sub("", text)).strip()


def _transcript_fingerprint(dialogue: list[dict]) -> str:
    """A short hash of the transcript a recap was built from.

    The segment count alone misses edits that keep the count the same, so the text goes in
    too — that is what lets the panel say "this recap no longer matches your transcript".
    """
    import hashlib

    joined = "\u0001".join(f"{d.get('start')}|{(d.get('text') or '').strip()}" for d in dialogue)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:16]


async def _timeline_dialogue(project_id: str, db: AsyncSession) -> list[dict]:
    """The transcript lines a recap is built from, in timeline order."""
    result = await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time, Segment.index)
    )
    dialogue = []
    for segment in result.scalars().all():
        if segment.speaker == 'Freeze' or segment.voice_profile == 'freeze' or 'intro hook' in (segment.speaker or '').lower():
            continue
        text = (segment.original_text or segment.text or '').strip()
        if text:
            dialogue.append({'start': segment.start_time, 'end': segment.end_time,
                             'speaker': segment.speaker, 'text': text})
    return dialogue


@router.get("/movie-recap")
async def get_movie_recap(project_id: str, db: AsyncSession = Depends(get_db)):
    from backend.database.models import AppSetting
    if not await db.get(Project, project_id):
        raise HTTPException(404, "Project not found")
    row = await db.get(AppSetting, f"movie_recap:{project_id}")
    if not row:
        return None
    recap = json.loads(row.value)

    # Tell the panel whether the transcript has moved on since this recap was written
    current = await _timeline_dialogue(project_id, db)
    recap["current_segments"] = len(current)
    saved_print = recap.get("transcript_fingerprint")
    if saved_print:
        recap["stale"] = saved_print != _transcript_fingerprint(current)
    else:
        # recaps saved before fingerprinting: fall back to the segment count
        recap["stale"] = bool(recap.get("source_segments")) and recap["source_segments"] != len(current)
    return recap


@router.post("/movie-recap")
async def generate_movie_recap(project_id: str, body: RecapOptions, db: AsyncSession = Depends(get_db)):
    from datetime import datetime, timezone
    from backend.api.routes.settings import _set_setting
    if not await db.get(Project, project_id):
        raise HTTPException(404, "Project not found")
    result = await db.execute(select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time, Segment.index))
    dialogue = []
    for segment in result.scalars().all():
        if segment.speaker == 'Freeze' or segment.voice_profile == 'freeze' or 'intro hook' in (segment.speaker or '').lower():
            continue
        text = (segment.original_text or segment.text or '').strip()
        if text:
            dialogue.append({'start': segment.start_time, 'end': segment.end_time, 'speaker': segment.speaker, 'text': text})
    if body.source == 'file':
        try:
            dialogue = parse_external_transcript(body.filename, body.transcript)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    if not dialogue:
        raise HTTPException(400, "Generate or import the movie transcript first.")
    try:
        recap = await summarize_transcript(dialogue, body)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc
    recap.update(body.model_dump(exclude={"transcript"}))
    recap.update({
        'source_segments': len(dialogue),
        'transcript_fingerprint': _transcript_fingerprint(dialogue),
        'generated_at': datetime.now(timezone.utc).isoformat(),
    })
    await _set_setting(db, f"movie_recap:{project_id}", json.dumps(recap, ensure_ascii=False))
    await db.commit()
    return recap


@router.post("/movie-recap/to-timeline")
@router.post("/movie-recap/to-timeline/")
async def movie_recap_to_timeline(
    project_id: str,
    body: dict | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Turn the saved movie recap into caption lines on the timeline.

    Each recap section carries its own start and end, so its script is broken into readable
    lines and spread across that span. Sections the model left untimed follow on from the last
    timed one. No voices are generated: the script goes on the timeline to be read and edited,
    and dubbing is the usual timeline step afterwards.
    """
    from backend.database.models import AppSetting
    from backend.api.routes.timeline_sync import split_caption_text, RATE_TARGET_CPS
    from backend.services.transcript_cleanup import strip_foreign_scripts

    body = body or {}
    dry_run = bool(body.get("dry_run"))
    max_chars = int(body.get("max_chars", 90))

    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    row = await db.get(AppSetting, f"movie_recap:{project_id}")
    if not row:
        raise HTTPException(400, "No movie recap has been generated for this project yet")
    recap = json.loads(row.value)

    sections = [s for s in (recap.get("sections") or []) if str(s.get("script") or "").strip()]
    if not sections:
        raise HTTPException(400, "This recap has no script sections to import")

    video_end = float(project.duration or 0.0)
    lines: list[dict] = []
    cursor = 0.0

    for section in sections:
        script = str(section.get("script") or "").strip()
        # Narration occasionally carries a word of the film's own language through. It reads as
        # a glitch and the Khmer voice cannot say it, so it is removed before the line is placed.
        script = strip_foreign_scripts(_strip_cjk(script))
        if not script:
            continue
        pieces = split_caption_text(script, max_chars) or [script]

        start = section.get("start_time")
        end = section.get("end_time")
        start = float(start) if start is not None else None
        end = float(end) if end is not None else None

        if start is None or end is None or end <= start:
            # untimed section: give it the time its text needs, after whatever came before
            start = max(cursor, 0.0)
            end = start + sum(len(p) for p in pieces) / RATE_TARGET_CPS
        start = max(start, cursor)
        if video_end > 0:
            end = min(end, video_end)
        if end <= start:
            end = start + sum(len(p) for p in pieces) / RATE_TARGET_CPS

        # The video is a hard wall: a beat that would start past the end has nowhere to play,
        # and letting the cursor drift pushes every later beat further out still.
        if video_end > 0:
            if start >= video_end - 0.5:
                break
            end = min(end, video_end)

        total_chars = sum(len(p) for p in pieces) or 1
        span = end - start
        needed = total_chars / RATE_TARGET_CPS
        # A recap line should stay up for as long as it takes to say, not for as long as the
        # scene it describes — stretching it across the whole section leaves one line sitting
        # on screen for a minute. It is only squeezed when the section is genuinely shorter.
        squeeze = min(1.0, span / needed) if needed > 0 else 1.0
        at = start
        for piece in pieces:
            share = (len(piece) / RATE_TARGET_CPS) * squeeze
            piece_end = at + max(0.8, share)
            if video_end > 0:
                piece_end = min(piece_end, video_end)
                if at >= video_end - 0.3:
                    break
            lines.append({
                "index": len(lines),
                "start_time": round(at, 2),
                "end_time": round(piece_end, 2),
                "text": piece,
                "type": "narration",
                "speaker": "Narrator",
                "gender": str(body.get("gender") or "female"),
                "emotion": "excited",
            })
            at = piece_end + 0.08
        cursor = at

    # How much of the video the script actually speaks over. A recap meant to be voiced should
    # fill most of the runtime; a summary written for reading covers a fraction of it, and the
    # difference is worth showing before it lands on the timeline.
    spoken = sum(l["end_time"] - l["start_time"] for l in lines)
    coverage = round(spoken / video_end * 100, 1) if video_end > 0 else None

    if dry_run:
        return {
            "dry_run": True,
            "sections": len(sections),
            "lines": len(lines),
            "spans": f"{lines[0]['start_time']:.1f}s – {lines[-1]['end_time']:.1f}s" if lines else "",
            "spoken_seconds": round(spoken, 1),
            "video_seconds": round(video_end, 1),
            "coverage_percent": coverage,
            "preview": lines[:12],
        }

    return await apply_narration_segments(
        project_id,
        {
            "segments": lines,
            "voice_profile": body.get("voice_profile", "female"),
            "generate_voice": bool(body.get("generate_voice", False)),
            "keep_existing": bool(body.get("keep_existing", False)),
        },
        db,
    )
