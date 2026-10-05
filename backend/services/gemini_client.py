"""Gemini API access: key rotation, model fallback, media upload and transcription calls."""
import os
import asyncio
import shutil
import subprocess
import tempfile
import google.generativeai as genai
from backend.config import settings
from backend.database.db import async_session
from backend.database.models import ApiKey
from sqlalchemy import select
from backend.services.transcript_cleanup import _parse_segments


# Chunking settings for dense, complete audio coverage with atomic sentence granularity
# Gemini returns steadily fewer lines the longer a single audio gets, so keep each part short.
CHUNK_DURATION = 120    # Smaller requests deliver captions sooner and reduce output truncation
CHUNK_OVERLAP = 4       # 4 second overlap at boundary transitions
CHUNK_THRESHOLD = CHUNK_DURATION * 1.15
MAX_PARALLEL_CHUNKS = 3  # Process up to 3 chunks simultaneously with key rotation

# Track which key index we used last for round-robin
_last_key_index = 0

# When a request was last refused for quota. A request that fails is retried on every other key
# and model, and the error that finally comes out often no longer says why — the work queue
# reads this to tell "out of quota, wait" from "broken, give up".
_quota_refused_at = 0.0
QUOTA_WORDS = ("429", "quota", "resource_exhausted", "resource exhausted", "rate limit")


def is_quota_error(error) -> bool:
    text = str(error).lower()
    return any(word in text for word in QUOTA_WORDS)


def note_error(error) -> None:
    global _quota_refused_at
    if is_quota_error(error):
        import time
        _quota_refused_at = time.time()


def quota_refused_since(moment: float) -> bool:
    return _quota_refused_at >= moment


async def _get_active_keys() -> list:
    """Load all active API keys from the database (filtering keys compatible with upload_file)."""
    async with async_session() as db:
        result = await db.execute(
            select(ApiKey.key).where(ApiKey.is_active == True).order_by(ApiKey.created_at)
        )
        # Google issues Gemini keys in more than one shape — the classic "AIzaSy…" and the
        # newer "AQ.…" both authenticate. Filtering by prefix silently threw away working
        # keys, so every non-empty key is used and a dead one is simply rotated past.
        return [k for k in (row[0].strip() for row in result.all()) if k]


async def _configure_genai():
    """Configure genai with the next available active key (round-robin)."""
    global _last_key_index

    keys = await _get_active_keys()

    # Fallback: if no keys in DB, use the config singleton (e.g. from .env)
    if not keys:
        if not settings.gemini_api_key or settings.gemini_api_key == "your_gemini_api_key_here":
            raise RuntimeError(
                "No API keys configured. "
                "Please add a Gemini API key in Settings. "
                "Get a key at https://aistudio.google.com/apikey"
            )
        genai.configure(api_key=settings.gemini_api_key)
        return

    # Round-robin key selection
    _last_key_index = _last_key_index % len(keys)
    chosen_key = keys[_last_key_index]
    _last_key_index = (_last_key_index + 1) % len(keys)

    genai.configure(api_key=chosen_key)


async def _generate_with_fallback(contents, generation_config=None, initial_model: str | None = None):
    """Generate content with automatic fallback across multiple active models and multiple API keys."""
    keys = await _get_active_keys()
    if not keys:
        if settings.gemini_api_key and settings.gemini_api_key != "your_gemini_api_key_here":
            keys = [settings.gemini_api_key]
        else:
            raise RuntimeError("No valid Gemini API keys configured.")

    # The model chosen in Settings goes first; the rest are fallbacks for quota/outage
    candidates = [
        initial_model or settings.gemini_model or "gemini-3.8-flash",
        "gemini-3.8-flash",
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
    ]
    seen = set()
    models_to_try = [m for m in candidates if not (m in seen or seen.add(m))]

    last_err = None
    for key_idx, key in enumerate(keys):
        genai.configure(api_key=key)
        for m_name in models_to_try:
            try:
                model = genai.GenerativeModel(m_name)
                if generation_config:
                    response = await asyncio.wait_for(
                        asyncio.to_thread(
                            model.generate_content,
                            contents,
                            generation_config=generation_config,
                        ),
                        timeout=30.0,
                    )
                else:
                    response = await asyncio.wait_for(
                        asyncio.to_thread(model.generate_content, contents),
                        timeout=30.0,
                    )
                if response and response.text:
                    return response
            except Exception as e:
                last_err = e
                note_error(e)
                print(f"[gemini fallback] Key {key_idx+1}/{len(keys)} Model {m_name} failed: {e}", flush=True)
                continue

    raise last_err or Exception("All Gemini models and API keys failed to generate content")


async def _get_video_duration(video_path: str) -> float:
    """Get video/audio duration in seconds using ffprobe."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return 0.0
    cmd = [
        ffprobe, "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_path
    ]
    try:
        res = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True, timeout=10)
        if res.returncode == 0 and res.stdout.strip():
            return float(res.stdout.strip())
    except Exception:
        pass
    return 0.0


async def _split_video_chunks(video_path: str, chunk_duration: float = CHUNK_DURATION):
    """Encode each chunk (plus CHUNK_OVERLAP lead-in) straight from the source as
    16 kHz mono 64k MP3 — the same format as short videos. No full-length
    intermediate file, and per-chunk input seeking keeps each ffmpeg run short.
    Returns (list of (chunk_audio_path, start_offset_seconds), tmp_dir)."""
    duration = await _get_video_duration(video_path)
    if duration <= 0 or duration <= chunk_duration * 1.15:
        audio_path, tmp_dir = await _extract_audio_for_gemini(video_path)
        if audio_path:
            return [(audio_path, 0.0)], tmp_dir
        return [(video_path, 0.0)], None

    ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
    tmp_dir = tempfile.mkdtemp(prefix="gemini_chunks_")

    async def _encode(idx: int, start: float, length: float):
        chunk_path = os.path.join(tmp_dir, f"chunk_{idx}.mp3")
        cmd = [
            ffmpeg, "-y",
            "-ss", f"{start:.3f}",  # input seek; transcoding keeps it sample-accurate
            "-i", video_path,
            "-t", f"{length:.3f}",
            "-vn",
            "-c:a", "libmp3lame",
            "-ar", "16000",
            "-ac", "1",
            "-b:a", "64k",
            chunk_path,
        ]
        res = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True, timeout=600)
        if res.returncode != 0 or not os.path.exists(chunk_path) or os.path.getsize(chunk_path) == 0:
            raise RuntimeError(f"Audio chunk {idx + 1} extraction failed: {res.stderr[-300:]}")
        return chunk_path, start

    specs = []
    step = 0.0
    while step < duration:
        start = max(0.0, step - CHUNK_OVERLAP)
        specs.append((start, min(chunk_duration + (step - start), duration - start)))
        step += chunk_duration

    try:
        # A few ffmpeg processes at once; each only decodes its own window
        sem = asyncio.Semaphore(MAX_PARALLEL_CHUNKS)

        async def _limited(i, spec):
            async with sem:
                return await _encode(i, *spec)

        chunks = await asyncio.gather(*(_limited(i, sp) for i, sp in enumerate(specs)))
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise

    return list(chunks), tmp_dir


async def _extract_audio_for_gemini(video_path: str) -> tuple[str, str | None]:
    """Extract audio from video file to high-efficiency MP3 (16kHz Mono 64k).
    Takes <0.1s and produces a tiny file (~200KB per 30s) that uploads to Gemini
    instantly and processes with maximum accuracy."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return video_path, None
    tmp_dir = tempfile.mkdtemp(prefix="gemini_audio_")
    audio_path = os.path.join(tmp_dir, "audio.mp3")
    cmd = [
        ffmpeg, "-y",
        "-i", video_path,
        "-vn",
        "-acodec", "libmp3lame",
        "-ar", "16000",
        "-ac", "1",
        "-b:a", "64k",
        audio_path,
    ]
    res = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True)
    if res.returncode == 0 and os.path.exists(audio_path) and os.path.getsize(audio_path) > 0:
        return audio_path, tmp_dir
    shutil.rmtree(tmp_dir, ignore_errors=True)
    return video_path, None


async def _build_media_proxy_for_gemini(video_path: str) -> tuple[str, str | None]:
    """Extract audio directly for crystal-clear, fast, 100% complete dialogue recognition."""
    audio_path, tmp_dir = await _extract_audio_for_gemini(video_path)
    if audio_path and os.path.exists(audio_path) and os.path.getsize(audio_path) > 0:
        return audio_path, tmp_dir
    return video_path, None


class GeminiBlocked(RuntimeError):
    """Gemini refused the content (safety / prohibited). Retrying the same media won't help."""


class GeminiTruncated(RuntimeError):
    """The response hit the output token limit; `segments` holds what was parsed before the cut."""

    def __init__(self, message: str, segments: list):
        super().__init__(message)
        self.segments = segments


_GEMINI_REST_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
INLINE_MEDIA_LIMIT = 18 * 1024 * 1024  # inline requests are capped at 20 MB total
# How many (key, model) attempts are in flight at once for one chunk.
TRANSCRIBE_RACE_WIDTH = 3
# A chunk is at most CHUNK_DURATION of speech; measured good responses land in 15-40s, so a
# request still running after this is stuck and another model is the faster route. It used to be
# 600s, which meant one hung call held a chunk for ten minutes before anything else was tried.
TRANSCRIBE_READ_TIMEOUT = 150.0
_MEDIA_MIME = {".mp3": "audio/mp3", ".flac": "audio/flac", ".wav": "audio/wav", ".m4a": "audio/mp4", ".mp4": "video/mp4"}
_BLOCK_FINISH_REASONS = {"SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"}


async def generate_text_inline(key: str, model: str, prompt: str, temperature: float = 0.8,
                               max_output_tokens: int = 16384) -> str:
    """One text-only generateContent call over REST. The key travels with the request, so
    parallel calls using different keys cannot clash the way genai.configure does."""
    import httpx

    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": temperature,
            "responseMimeType": "application/json",
            "maxOutputTokens": max_output_tokens,
        },
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=30.0)) as client:
        r = await client.post(_GEMINI_REST_URL.format(model=model), headers={"x-goog-api-key": key}, json=body)
    if r.status_code != 200:
        raise RuntimeError(f"{r.status_code} {r.text[:300]}")
    payload = r.json()
    block = (payload.get("promptFeedback") or {}).get("blockReason")
    if block:
        raise GeminiBlocked(f"blocked by Gemini ({block})")
    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError("Gemini returned no candidates")
    if candidates[0].get("finishReason") in _BLOCK_FINISH_REASONS:
        raise GeminiBlocked(f"blocked by Gemini ({candidates[0].get('finishReason')})")
    return "".join(p.get("text", "") for p in (candidates[0].get("content") or {}).get("parts", []))


async def _transcribe_inline(key: str, model: str, media_path: str, prompt: str) -> list:
    """One generateContent call over REST with the audio inline. The API key travels with the
    request, so concurrent chunks using different keys can't interfere (unlike genai.configure)."""
    import base64
    import httpx

    mime = _MEDIA_MIME.get(os.path.splitext(media_path)[1].lower(), "audio/mp3")
    with open(media_path, "rb") as f:
        data = base64.b64encode(f.read()).decode("ascii")
    body = {
        "contents": [{"parts": [{"inline_data": {"mime_type": mime, "data": data}}, {"text": prompt}]}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json", "maxOutputTokens": 65536},
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(TRANSCRIBE_READ_TIMEOUT, connect=15.0)) as client:
        r = await client.post(_GEMINI_REST_URL.format(model=model), headers={"x-goog-api-key": key}, json=body)
    if r.status_code != 200:
        raise RuntimeError(f"{r.status_code} {r.text[:300]}")
    payload = r.json()
    block = (payload.get("promptFeedback") or {}).get("blockReason")
    if block:
        raise GeminiBlocked(f"blocked by Gemini ({block})")
    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError("Gemini returned no candidates")
    finish = candidates[0].get("finishReason", "")
    if finish in _BLOCK_FINISH_REASONS:
        raise GeminiBlocked(f"blocked by Gemini ({finish})")
    text = "".join(p.get("text", "") for p in (candidates[0].get("content") or {}).get("parts", []))
    segments = _parse_segments(text) if text.strip() else []
    if finish == "MAX_TOKENS":
        raise GeminiTruncated("response was cut off at the output limit", segments if isinstance(segments, list) else [])
    if not isinstance(segments, list):
        raise RuntimeError("could not parse transcript JSON")
    return segments


async def _transcribe_media_with_fallback(media_path: str, prompt: str) -> list:
    """Upload media file with round-robin key rotation and generate transcript segments with model fallback."""
    global _last_key_index
    keys = await _get_active_keys()
    if not keys:
        if not settings.gemini_api_key or settings.gemini_api_key == "your_gemini_api_key_here":
            raise RuntimeError("No API keys configured. Please add a Gemini API key in Settings.")
        keys = [settings.gemini_api_key]

    # Rotate starting key index so load is spread evenly across all working keys
    start_idx = _last_key_index % len(keys)
    _last_key_index = (_last_key_index + 1) % len(keys)
    ordered_keys = keys[start_idx:] + keys[:start_idx]

    models_to_try = [
        settings.gemini_model or "gemini-3.8-flash",
        "gemini-3.8-flash",
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
    ]
    seen = set()
    models_to_try = [m for m in models_to_try if not (m in seen or seen.add(m))]

    last_err = None
    if os.path.getsize(media_path) <= INLINE_MEDIA_LIMIT:
        # Every (key, model) pair is an independent shot at the same audio, so they are raced in
        # small waves instead of queued one behind the other. When Gemini is broadly overloaded —
        # measured at 42 consecutive 503s across all four models — walking the matrix one call at
        # a time cost over three minutes for two minutes of audio, while the same calls raced a
        # few at a time find a live model in the first wave or two.
        attempts = [(k, m) for k in ordered_keys for m in models_to_try]
        for i in range(0, len(attempts), TRANSCRIBE_RACE_WIDTH):
            wave = attempts[i:i + TRANSCRIBE_RACE_WIDTH]
            tasks = {
                asyncio.ensure_future(_transcribe_inline(key, m_name, media_path, prompt)): (key, m_name)
                for key, m_name in wave
            }
            try:
                while tasks:
                    done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        key, m_name = tasks.pop(task)
                        try:
                            return task.result()
                        except (GeminiBlocked, GeminiTruncated):
                            raise      # the content itself is the problem; another key cannot help
                        except asyncio.CancelledError:
                            continue
                        except Exception as e:
                            last_err = e
                            print(f"[gemini] Key {key[:8]}... Model {m_name} failed: {str(e)[:200]}", flush=True)
            finally:
                for task in tasks:
                    task.cancel()
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
            # Racing gets through the key x model matrix about three times faster, which is the
            # point when one model is merely busy — but when the whole service is overloaded it
            # would also reach the end of the list three times sooner and give up on a chunk that
            # the slower walk outlasted. A short, growing pause between waves keeps the speed and
            # still spans enough time for the overload to pass.
            if i + TRANSCRIBE_RACE_WIDTH < len(attempts):
                await asyncio.sleep(min(6.0, 1.0 + i / TRANSCRIBE_RACE_WIDTH))
        raise last_err or RuntimeError("All Gemini API keys and models failed to transcribe media")

    for key in ordered_keys:
        genai.configure(api_key=key)
        uploaded_file = None
        try:
            uploaded_file = await asyncio.to_thread(genai.upload_file, media_path)
            poll_count = 0
            while uploaded_file.state.name == "PROCESSING":
                poll_count += 1
                if poll_count > 60:
                    break
                await asyncio.sleep(1)
                uploaded_file = await asyncio.to_thread(genai.get_file, uploaded_file.name)

            if uploaded_file.state.name == "FAILED":
                continue

            for m_name in models_to_try:
                try:
                    model = genai.GenerativeModel(m_name)
                    response = await asyncio.to_thread(
                        model.generate_content,
                        [uploaded_file, prompt],
                        generation_config=genai.types.GenerationConfig(
                            temperature=0,
                            response_mime_type="application/json",
                            max_output_tokens=65536,
                        ),
                    )
                    segments = _parse_segments(response.text)
                    if isinstance(segments, list):
                        return segments
                except Exception as me:
                    last_err = me
                    err_str = str(me).lower()
                    note_error(me)
                    print(f"[gemini] Key {key[:8]}... Model {m_name} failed: {me}", flush=True)
                    if any(x in err_str for x in ["429", "quota", "exhausted", "resource"]):
                        await asyncio.sleep(1.0)
                    continue
        except Exception as ke:
            note_error(ke)
            last_err = ke
            print(f"[gemini] Key {key[:8]}... upload/transcribe failed: {ke}", flush=True)
        finally:
            if uploaded_file:
                try:
                    await asyncio.to_thread(genai.delete_file, uploaded_file.name)
                except Exception:
                    pass

    raise last_err or Exception("All Gemini API keys and models failed to transcribe media")


# --- Files API over REST -----------------------------------------------------------------
# The google.generativeai SDK uploads through a discovery endpoint that rejects "AQ." keys
# with HTTP 400, which locked file-based features (narration) to the "AIza" keys alone.
# These call the Files API directly, so every key works and the key travels per request.

_GEMINI_UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files"
_GEMINI_FILES_URL = "https://generativelanguage.googleapis.com/v1beta/{name}"
FILE_ACTIVE_TIMEOUT = 600.0   # video is transcoded server-side before it can be used


