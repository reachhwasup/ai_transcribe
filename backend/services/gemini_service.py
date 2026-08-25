import os
import json
import re
import asyncio
import queue
import shutil
import subprocess
import tempfile
from typing import AsyncGenerator
import google.generativeai as genai
from backend.config import settings
from backend.database.db import async_session
from backend.database.models import ApiKey
from sqlalchemy import select

# Chunking settings for dense, ultra-fast, complete video dialogue coverage
CHUNK_DURATION = 600    # 600 seconds (10 minutes) per macro-chunk
CHUNK_OVERLAP = 3       # 3 second overlap between chunks to avoid boundary gaps
CHUNK_THRESHOLD = 600   # Split videos exceeding 10 minutes into macro chunks
MAX_PARALLEL_CHUNKS = 3  # Process up to 3 chunks simultaneously (key-rotated)

# Gemini File API rejects uploads larger than 2 GiB. Compress anything that
# gets close, so we stay safely under the hard limit.
GEMINI_UPLOAD_LIMIT = 2 * 1024 * 1024 * 1024      # 2 GiB hard limit
UPLOAD_COMPRESS_THRESHOLD = 1900 * 1024 * 1024    # compress above ~1.9 GB

# Track which key index we used last for round-robin
_last_key_index = 0


async def _get_active_keys() -> list:
    """Load all active API keys from the database."""
    async with async_session() as db:
        result = await db.execute(
            select(ApiKey.key).where(ApiKey.is_active == True).order_by(ApiKey.created_at)
        )
        all_keys = [row[0].strip() for row in result.all()]
        valid_keys = [k for k in all_keys if k and not k.startswith("AQ.")]
        return valid_keys if valid_keys else all_keys


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
    candidates = [
        initial_model or settings.gemini_model or "gemini-3.1-flash-lite",
        "gemini-3.1-flash-lite",
        "gemini-3.5-flash-lite",
        "gemini-3.5-flash",
        "gemini-3.6-flash",
        "gemini-flash-latest",
        "gemini-flash-lite-latest",
        "gemini-2.5-pro",
    ]
    seen = set()
    models_to_try = [m for m in candidates if not (m in seen or seen.add(m))]

    last_err = None
    attempts = max(1, len(keys))
    for key_idx in range(attempts):
        if key_idx < len(keys):
            genai.configure(api_key=keys[key_idx])
        for m_name in models_to_try:
            try:
                model = genai.GenerativeModel(m_name)
                if generation_config:
                    response = await asyncio.to_thread(
                        model.generate_content,
                        contents,
                        generation_config=generation_config,
                    )
                else:
                    response = await asyncio.to_thread(model.generate_content, contents)
                if response and response.text:
                    return response
            except Exception as e:
                last_err = e
                continue
        # Switch to next key
        await _configure_genai()

    raise last_err or Exception("All Gemini models and API keys failed")


async def _get_video_duration(video_path: str) -> float:
    """Get video duration in seconds via ffprobe."""
    ffprobe = shutil.which("ffprobe") or "ffprobe"
    cmd = [
        ffprobe, "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_path,
    ]
    try:
        res = await asyncio.to_thread(
            subprocess.run, cmd, capture_output=True, text=True, timeout=15
        )
        if res.returncode == 0 and res.stdout.strip():
            return float(res.stdout.strip())
    except Exception:
        pass
    return 0.0


async def _split_video_chunks(video_path: str, chunk_duration: float = CHUNK_DURATION):
    """Extract full audio once in <4s, then quickly slice into macro-chunks (15 min each).
    Each chunk overlaps by CHUNK_OVERLAP seconds so boundary speech isn't lost.
    Returns list of (chunk_audio_path, start_offset_seconds).
    Caller must clean up the temp directory."""
    duration = await _get_video_duration(video_path)
    if duration <= 0 or duration <= chunk_duration * 1.15:
        # Don't split short videos or if we can't determine duration
        audio_path, tmp_dir = await _extract_audio_for_gemini(video_path)
        if audio_path:
            return [(audio_path, 0.0)], tmp_dir
        return [(video_path, 0.0)], None

    ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
    tmp_dir = tempfile.mkdtemp(prefix="gemini_chunks_")
    full_audio_path = os.path.join(tmp_dir, "full_audio.mp3")

    # Step 1: Extract complete 16kHz mono audio once in 2-3 seconds
    extract_cmd = [
        ffmpeg, "-y",
        "-i", video_path,
        "-vn",
        "-acodec", "libmp3lame",
        "-ar", "16000",
        "-ac", "1",
        "-b:a", "64k",
        full_audio_path,
    ]
    res = await asyncio.to_thread(subprocess.run, extract_cmd, capture_output=True, text=True, timeout=120)
    if res.returncode != 0 or not os.path.exists(full_audio_path) or os.path.getsize(full_audio_path) == 0:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return [(video_path, 0.0)], None

    # Step 2: Instant audio slicing from full_audio.mp3 (<0.01s per slice)
    chunks = []
    step = 0.0
    idx = 0
    while step < duration:
        extract_start = max(0, step - CHUNK_OVERLAP) if step > 0 else 0.0
        extract_dur = min(chunk_duration + (step - extract_start), duration - extract_start)
        chunk_path = os.path.join(tmp_dir, f"chunk_{idx}.mp3")
        cmd = [
            ffmpeg, "-y",
            "-ss", str(extract_start),
            "-i", full_audio_path,
            "-t", str(extract_dur),
            "-vn",
            "-acodec", "libmp3lame",
            "-ar", "16000",
            "-ac", "1",
            "-b:a", "64k",
            chunk_path,
        ]
        result = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True, timeout=60)
        if result.returncode == 0 and os.path.exists(chunk_path) and os.path.getsize(chunk_path) > 0:
            chunks.append((chunk_path, extract_start))
        step += chunk_duration
        idx += 1

    if not chunks:
        chunks.append((full_audio_path, 0.0))

    return chunks, tmp_dir


def _build_prompt(target_language: str = "km") -> str:
    lang_map = {
        "auto": "Native Spoken Language (Original Dialogue)",
        "km": "Khmer (ភាសាខ្មែរ - Cambodia)",
        "en": "English",
        "zh": "Chinese (Mandarin)",
        "ja": "Japanese",
        "ko": "Korean",
        "th": "Thai",
        "vi": "Vietnamese",
        "fr": "French",
        "es": "Spanish",
        "de": "German",
        "pt": "Portuguese",
        "ru": "Russian",
        "ar": "Arabic",
        "hi": "Hindi",
        "id": "Indonesian",
        "ms": "Malay",
    }
    lang_name = lang_map.get(target_language, "Khmer (ភាសាខ្មែរ)")

    if target_language == "auto":
        target_inst = """2. "text" — VERBATIM NATIVE TRANSCRIPTION:
   - Output the exact verbatim spoken dialogue in the native spoken language of the audio (e.g. Chinese, English, etc.)."""
    elif target_language == "km":
        target_inst = """2. "text" — CINEMATIC CAMBODIAN KHMER DUBBING & SUBTITLE LOCALIZATION (ភាសាខ្មែរ / អក្សរខ្មែរ):
   - Translate the dialogue into natural, expressive, cinematic spoken Cambodian Khmer suited for high-quality movie dubbing, character acting, and video storytelling (ភាសានិយាយភាពយន្ត / សម្រាយរឿង / ភាពយន្តភាគ).
   - Use authentic contextual pronouns matching character dynamics:
     * Husband/Wife / Lovers: បង / អូន
     * Close Friends / Peers: ឯង / យើង / គ្នាយើង
     * Elders / Grandparents: លោកយាយ / លោកតា / ចៅ
     * Royalty / Masters / Leaders: ព្រះអង្គ / លោកម្ចាស់ / ទូលបង្គំ / លោកមេបញ្ជាការ / លោកគ្រូ
     * Polite / Everyday: ខ្ញុំ / លោក / លោកស្រី / អ្នកនាង
     * Hostile / Confrontational: ឯង / អញ / ពួកឯង
   - Write 100% EXCLUSIVELY in authentic CAMBODIAN KHMER SCRIPT (អក្សរខ្មែរ). NEVER mix Chinese Hanzi, Thai script, or English letters in the "text" field.
   - Use correct Khmer spelling, smooth grammar, and natural conversational cadence without robotic phrasing."""
    else:
        target_inst = f"""2. "text" — NATURAL {lang_name.upper()} LOCALIZATION:
   - Translate and adapt the dialogue into natural, expressive, cinematic spoken {lang_name} suited for movie dubbing and video captions."""

    return f"""You are a master film transcriber, multilingual speech recognizer, character diarization expert, and movie dialogue localization engine.

Watch and listen to the audio carefully through all background music, sound effects, action sounds, and ambient noise.

CRITICAL DUAL-FIELD SPECIFICATION:
1. "original_text" — VERBATIM SPOKEN DIALOGUE (NATIVE SCRIPT):
   - Transcribe the EXACT spoken words in the native spoken language of the characters in the video (e.g. Chinese Hanzi "唐兄，好久不见！" or English "Hey John, long time no see!").
   - NEVER leave "original_text" blank.

{target_inst}

3. INTELLIGENT CHARACTER NAME IDENTIFICATION & VOICE PROFILES:
   - Listen carefully to character names spoken, addressed, or referenced in dialogue (e.g. "Tang Bohu", "Autumn Fragrance", "Madame Hua", "Grandma", "Elena", "Brother Chen", "Master", "Doctor Lin", "Xiao Yan").
   - Accurately assign the detected character name to the "speaker" field.
   - Assign the EXACT "voice_profile" archetype for each character:
     * "female": Adult Woman / Young Lady / Heroine (e.g. 秋香, Autumn Fragrance, 石榴姐, Lady, Girl)
     * "male": Adult Male / Young Man / Hero (e.g. 唐伯虎, Tang Bohu, Scholar, General)
     * "grandma": Elderly Grandmother / Old Woman / Madame (e.g. 华夫人, Madame Hua, Grandma, 老奶奶, យាយ, ម៉ែ)
     * "grandpa": Elderly Grandfather / Old Master (e.g. Grandpa, Master, Elder, 老爷, 老爷爷, តា)
     * "child_boy": Young Boy (e.g. Son, Little Boy, ក្មេងប្រុស)
     * "child_girl": Young Girl (e.g. Daughter, Little Girl, ក្មេងស្រី)
   - Tag authentic "emotion": "neutral", "angry", "happy", "sad", "fearful", "excited", "serious", "calm", "whisper".

4. EXACT AUDIO-SYNCHRONIZED TIMESTAMPS:
   - "start_time" MUST match the EXACT timestamp (in seconds) where the speaker's vocal audio begins for that phrase. DO NOT start early during silence, pause, or background music.
   - "end_time" MUST match the exact timestamp where the speaker stops speaking.
   - Break long sentences at natural speech pauses into 1.0 to 3.5s segments.
   - All timestamps MUST accurately match the audio timeline.

5. 100% COMPLETE & EXHAUSTIVE COVERAGE:
   - Transcribe EVERY SINGLE spoken utterance from 0.0s to the very end of the media without skipping any line.

Return a JSON array of granular segment objects:
[
  {{"start_time": 0.0, "end_time": 2.2, "original_text": "唐兄，好久不见！", "text": "បងថាង! មិនបានជួបគ្នាយូរហើយ!", "speaker": "Autumn Fragrance", "gender": "female", "emotion": "happy"}},
  {{"start_time": 2.4, "end_time": 4.5, "original_text": "秋香，别来无恙吧？", "text": "ឈីវស៊ាង! នាងសុខសប្បាយជាទេ?", "speaker": "Tang Bohu", "gender": "male", "emotion": "cheerful"}}
]

Rules:
- CONTINUOUS SECONDS: start_time and end_time MUST be continuous numbers in seconds (e.g. 5.2, 62.5, 78.0, 89.2).
- NO PREFIXES: Neither "original_text" nor "text" should contain speaker prefixes like "Speaker:".
- JSON ONLY: Return ONLY the raw JSON array. No markdown formatting, no explanations."""


async def _compress_for_upload(video_path: str):
    """Transcode an oversized video into a compact proxy that fits under
    Gemini's 2 GiB upload cap. Gemini samples video at ~1 fps at low
    resolution regardless of input, so a downscaled / low-fps proxy carries
    the same information at a fraction of the size. Audio is preserved for
    speech timing. Returns (proxy_path, tmp_dir) — caller cleans up tmp_dir,
    or (video_path, None) if compression isn't possible."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return video_path, None

    video_dir = os.path.dirname(os.path.abspath(video_path))
    cached_proxy = os.path.join(video_dir, "gemini_proxy.mp4")
    if os.path.exists(cached_proxy) and os.path.getsize(cached_proxy) > 1000:
        orig_dur = await _get_video_duration(video_path)
        proxy_dur = await _get_video_duration(cached_proxy)
        if orig_dur > 0 and proxy_dur > 0 and abs(orig_dur - proxy_dur) < 2.0:
            return cached_proxy, None
        try:
            os.remove(cached_proxy)
        except OSError:
            pass

    proxy_path = cached_proxy if os.access(video_dir, os.W_OK) else os.path.join(tempfile.mkdtemp(prefix="gemini_proxy_"), "proxy.mp4")
    tmp_dir = None if proxy_path == cached_proxy else os.path.dirname(proxy_path)

    cmd = [
        ffmpeg, "-y",
        "-i", video_path,
        "-vf", "scale='min(640,iw)':-2,fps=2",
        "-r", "2",
        "-c:v", "libx264", "-crf", "32", "-preset", "ultrafast", "-tune", "fastdecode", "-threads", "0",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
        "-movflags", "+faststart",
        proxy_path,
    ]
    try:
        result = await asyncio.to_thread(
            subprocess.run, cmd, capture_output=True, text=True, timeout=3600
        )
    except Exception as e:
        print(f"[gemini] proxy transcode failed to run: {e}")
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        return video_path, None

    if result.returncode == 0 and os.path.exists(proxy_path) and os.path.getsize(proxy_path) > 0:
        new_size = os.path.getsize(proxy_path)
        print(f"[gemini] compressed video for upload: "
              f"{os.path.getsize(video_path) / 1e9:.2f} GB -> {new_size / 1e9:.2f} GB")
        if new_size < GEMINI_UPLOAD_LIMIT:
            return proxy_path, tmp_dir
        print("[gemini] proxy still exceeds upload limit")
    else:
        print(f"[gemini] proxy transcode failed: {result.stderr[-500:] if result.returncode else ''}")

    if tmp_dir:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    return video_path, None


async def _upload_and_wait(video_path: str, on_progress=None):
    """Upload video to Gemini and wait for processing.

    Large uploads occasionally die mid-transfer (BrokenPipeError /
    connection reset) — retry a few times with backoff before giving up.
    Files near the 2 GiB API limit are compressed to a proxy first.
    """
    proxy_dir = None
    try:
        if os.path.getsize(video_path) >= UPLOAD_COMPRESS_THRESHOLD:
            if on_progress:
                on_progress("Video is large — compressing for upload...")
            video_path, proxy_dir = await _compress_for_upload(video_path)
            if os.path.getsize(video_path) >= GEMINI_UPLOAD_LIMIT:
                raise Exception(
                    "Video is larger than Gemini's 2 GB upload limit and could not "
                    "be compressed enough. Please shorten or re-encode the video."
                )
    except OSError:
        pass

    try:
        last_err: Exception | None = None
        for attempt in range(3):
            try:
                video_file = await asyncio.to_thread(genai.upload_file, video_path)
                break
            except (BrokenPipeError, ConnectionError, OSError) as e:
                last_err = e
                print(f"[gemini] upload attempt {attempt + 1}/3 failed: {e}")
                await asyncio.sleep(2 * (attempt + 1))
        else:
            raise Exception(f"Video upload to Gemini failed after 3 attempts: {last_err}")

        poll_count = 0
        while video_file.state.name == "PROCESSING":
            poll_count += 1
            await asyncio.sleep(1)
            video_file = await asyncio.to_thread(genai.get_file, video_file.name)

        if video_file.state.name == "FAILED":
            raise Exception("Video processing failed in Gemini API")

        return video_file
    finally:
        if proxy_dir:
            shutil.rmtree(proxy_dir, ignore_errors=True)


def _safe_json_loads(text: str) -> list:
    """Parse JSON with fallback repair for common Gemini issues
    (trailing commas, unescaped newlines in strings, etc.)."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Fix 1: Remove trailing commas before ] or }
    fixed = re.sub(r",\s*([}\]])", r"\1", text)
    try:
        return json.loads(fixed)
    except json.JSONDecodeError:
        pass

    # Fix 2: Also escape unescaped newlines inside string values
    fixed2 = re.sub(r'(?<=": ")((?:[^"\\]|\\.)*)(?=")', lambda m: m.group(0).replace("\n", "\\n"), fixed)
    try:
        return json.loads(fixed2)
    except json.JSONDecodeError:
        pass

    # Fix 3: Salvage every complete top-level object from a truncated/malformed
    # array. Gemini responses get cut off mid-array (token limits, dropped
    # connections), which leaves a trailing half-written object that no repair
    # above can fix. Scan brace-by-brace (respecting strings/escapes), json.loads
    # each balanced {...}, and keep the ones that parse — discarding only the
    # incomplete tail. This recovers nearly all segments instead of losing the
    # whole chunk.
    recovered = []
    depth = 0
    start = -1
    in_str = False
    escape = False
    for i, ch in enumerate(text):
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    obj = text[start:i + 1]
                    try:
                        recovered.append(json.loads(obj))
                    except json.JSONDecodeError:
                        try:
                            recovered.append(json.loads(re.sub(r",\s*([}\]])", r"\1", obj)))
                        except json.JSONDecodeError:
                            pass
                    start = -1
    if recovered:
        return recovered

    raise ValueError(f"Could not parse Gemini JSON response: {text[:200]}")


def _clean_khmer_spacing(text: str) -> str:
    """Clean artificial spaces and broken glyph sequences from Khmer text while keeping natural clause structure."""
    if not text:
        return text
    # Check if text contains Khmer characters
    if not re.search(r'[\u1780-\u17FF]', text):
        return text.strip()

    # Fix split Khmer subscripts (e.g. consonant + space + ្ + consonant)
    text = re.sub(r'([\u1780-\u17B3])\s+([\u17D2][\u1780-\u17B3])', r'\1\2', text)
    text = re.sub(r'([\u1780-\u17B3][\u17D2])\s+([\u1780-\u17B3])', r'\1\2', text)
    # Fix split vowels/diacritics
    text = re.sub(r'([\u1780-\u17B3])\s+([\u17B4-\u17D1\u17D3])', r'\1\2', text)

    # Normalize multiple whitespace into single space
    text = re.sub(r'\s+', ' ', text)
    # Remove spaces before Khmer punctuation (។, ៗ, ៕, etc.) and general punctuation
    text = re.sub(r'\s+([។ៗ៕!?,:;])', r'\1', text)
    text = re.sub(r'([!?,:;])\s*([។ៗ៕])', r'\1\2', text)
    return text.strip()


def _split_segment_into_subsegments(seg: dict) -> list[dict]:
    """Split segments longer than 3.2 seconds at natural sentence, clause, or conjunction boundaries.
    Preserves whole words, keeps punctuation bound to sentences, and avoids orphan punctuation chunks."""
    text = seg.get("text", "").strip()
    s = float(seg.get("start_time", 0))
    e = float(seg.get("end_time", 0))
    dur = e - s

    # If duration is crisp and punchy (<= 3.2s), or text has no meaningful characters, do not split
    if dur <= 3.2 or not text or not re.search(r'[\w\u1780-\u17FF\u4E00-\u9FFF]', text):
        return [seg]

    # Split on sentence punctuation boundaries while keeping punctuation attached to the preceding sentence
    raw_sentences = [p.strip() for p in re.split(r'(?<=[!?,.។;:\n…，。！？、])\s+', text) if p.strip()]

    # If no punctuation split or sentence is still long, split on Khmer conjunction boundaries
    conj = ['ហើយ', 'ប៉ុន្តែ', 'ព្រោះ', 'ដូច្នេះ', 'បន្ទាប់មក', 'តែ', 'ប្រសិនបើ', 'ពីព្រោះ', 'ដោយសារ', 'ពេល']
    sentences = []
    for s_item in raw_sentences:
        if len(s_item) > 20:
            split_done = False
            for c in conj:
                if c in s_item and not s_item.startswith(c):
                    sub = s_item.split(c, 1)
                    if len(sub[0].strip()) >= 8 and len(sub[1].strip()) >= 6:
                        sentences.append(sub[0].strip())
                        sentences.append((c + sub[1]).strip())
                        split_done = True
                        break
            if not split_done:
                sentences.append(s_item)
        else:
            sentences.append(s_item)

    # Filter out empty or punctuation-only pieces and merge them back with previous sentences
    filtered = []
    for piece in sentences:
        p_clean = piece.strip()
        if not p_clean:
            continue
        if not re.search(r'[\w\u1780-\u17FF\u4E00-\u9FFF]', p_clean):
            if filtered:
                filtered[-1] += p_clean
            continue
        filtered.append(p_clean)

    if len(filtered) <= 1:
        return [seg]

    total_chars = sum(len(st) for st in filtered)
    if total_chars == 0:
        return [seg]

    res = []
    curr_s = s
    for i, st in enumerate(filtered):
        ratio = len(st) / total_chars
        sub_dur = dur * ratio
        sub_e = round(curr_s + sub_dur, 2)
        if i == len(filtered) - 1:
            sub_e = e
        sub_seg = dict(seg)
        sub_seg["start_time"] = round(curr_s, 2)
        sub_seg["end_time"] = round(sub_e, 2)
        sub_seg["text"] = st.strip()
        if "original_text" not in sub_seg or not sub_seg["original_text"]:
            sub_seg["original_text"] = seg.get("original_text", st.strip())
        res.append(sub_seg)
        curr_s = sub_e

    return res


def _clean_repetitive_text(text: str) -> str:
    """Remove repetitive loop hallucinations (e.g. repeated Khmer/Chinese words or phrases)."""
    if not text:
        return ""
    t = text
    for _ in range(3):
        t = re.sub(r'([\u1780-\u17FF\u4E00-\u9FFF\w\s]{3,30}?)(?:\s*\1){2,}', r'\1', t)
        t = re.sub(r'(\b\S+\b(?:\s+\b\S+\b)?)(?:\s+\1){2,}', r'\1', t, flags=re.IGNORECASE)
    words = t.split()
    if len(words) > 6:
        counts = {}
        filtered = []
        for w in words:
            counts[w] = counts.get(w, 0) + 1
            if counts[w] <= 2:
                filtered.append(w)
            elif counts[w] == 3 and w in ('និង', 'ហើយ', 'ដែល', 'ទៅ', 'មក', 'នៃ', 'the', 'and', 'to'):
                filtered.append(w)
        t = ' '.join(filtered)
    return t.strip()


def _parse_timestamp(val, prev_ref: float = 0.0) -> float:
    """Parse float seconds from numbers or timecode strings (e.g. 12.34, '01:23.4', '1:05', '100.90')."""
    if isinstance(val, (int, float)):
        raw_val = float(val)
    else:
        val_str = str(val).strip()
        if ":" in val_str:
            parts = val_str.split(":")
            try:
                if len(parts) == 2:
                    return float(parts[0]) * 60.0 + float(parts[1])
                elif len(parts) == 3:
                    return float(parts[0]) * 3600.0 + float(parts[1]) * 60.0 + float(parts[2])
            except (ValueError, TypeError):
                pass
        try:
            raw_val = float(val_str)
        except (ValueError, TypeError):
            return 0.0

    # Auto-detect omitted-colon MMSS.ss format (e.g. 100.90 for 01:00.90, 102.70 for 01:02.70)
    if raw_val >= 100.0:
        int_p = int(raw_val)
        sec_p = (int_p % 100) + (raw_val - int_p)
        min_p = int_p // 100
        if min_p >= 1 and (int_p % 100) < 60 and sec_p < 60.0:
            converted = min_p * 60.0 + sec_p
            if prev_ref > 0 and (raw_val - prev_ref) > 20.0 and abs(converted - prev_ref) < abs(raw_val - prev_ref):
                return round(converted, 2)

    return round(raw_val, 2)


def sanitize_segments(segments: list) -> list:
    """Sanitize, fix intra-chunk minute rollovers, deduplicate boundary copies, and strictly resolve all overlaps."""
    if not segments:
        return []

    # Step 1: Fix minute rollovers per chunk and invalid timestamps
    minute_offset = 0.0
    prev_start = 0.0
    fixed = []
    for s in segments:
        start = _parse_timestamp(s.get("start_time", 0), prev_ref=prev_start)
        end = _parse_timestamp(s.get("end_time", 0), prev_ref=start)

        # Check if timestamp rolled over a 60s boundary within a chunk response (e.g. 58.5s -> 1.2s)
        while (start + minute_offset) < prev_start - 10.0 and start < 60.0:
            minute_offset += 60.0

        start += minute_offset
        end += minute_offset
        if end <= start + 0.2:
            end = start + 1.2

        prev_start = start
        item = dict(s)
        item["start_time"] = round(start, 2)
        item["end_time"] = round(end, 2)
        fixed.append(item)

    # Step 2: Sort strictly by start_time, then end_time
    fixed.sort(key=lambda x: (x["start_time"], x["end_time"]))

    # Step 3: Global sliding-window deduplication (eliminates chunk-overlap copies)
    deduped = []
    for seg in fixed:
        is_dup = False
        s_text = seg.get("text", "").strip()
        s_orig = seg.get("original_text", "").strip()
        for ex in reversed(deduped[-40:]):
            if abs(seg["start_time"] - ex["start_time"]) > 60.0:
                continue
            ex_text = ex.get("text", "").strip()
            ex_orig = ex.get("original_text", "").strip()
            # If text is identical and timestamps within 40s
            if s_text and ex_text and s_text == ex_text and abs(seg["start_time"] - ex["start_time"]) < 40.0:
                is_dup = True
                break
            # If original_text is identical and timestamps within 40s
            if s_orig and ex_orig and s_orig == ex_orig and abs(seg["start_time"] - ex["start_time"]) < 40.0:
                is_dup = True
                break
            # If start and end times are virtually identical
            if abs(seg["start_time"] - ex["start_time"]) < 0.3 and abs(seg["end_time"] - ex["end_time"]) < 0.3:
                is_dup = True
                break
        if not is_dup:
            deduped.append(seg)

    # Step 4: Re-sort and strictly eliminate any overlapping segment bounds
    deduped.sort(key=lambda x: x["start_time"])
    resolved = []
    for seg in deduped:
        if not resolved:
            resolved.append(seg)
            continue
        prev = resolved[-1]

        # If current segment starts before previous segment ends
        if seg["start_time"] < prev["end_time"]:
            if (prev["end_time"] - prev["start_time"]) > 1.2:
                mid = round((prev["end_time"] + seg["start_time"]) / 2, 2)
                prev["end_time"] = mid
                seg["start_time"] = mid
            else:
                prev["end_time"] = round(seg["start_time"], 2)

            if prev["end_time"] <= prev["start_time"]:
                prev["end_time"] = round(prev["start_time"] + 0.5, 2)
                seg["start_time"] = prev["end_time"]

        if seg["end_time"] <= seg["start_time"]:
            seg["end_time"] = round(seg["start_time"] + 1.0, 2)

        resolved.append(seg)

    # Step 5: Final strict monotonicity pass
    final_pass = []
    for seg in resolved:
        if final_pass:
            if seg["start_time"] < final_pass[-1]["end_time"]:
                seg["start_time"] = final_pass[-1]["end_time"]
            if seg["end_time"] <= seg["start_time"]:
                seg["end_time"] = round(seg["start_time"] + 0.8, 2)
        final_pass.append(seg)

    # Re-index
    for idx, s in enumerate(final_pass):
        s["index"] = idx

    return final_pass


def _parse_segments(text: str) -> list:
    """Parse JSON segments from Gemini response text and ensure granular sentence-level splitting."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\n?", "", text)
        text = re.sub(r"\n?```$", "", text)

    segments = _safe_json_loads(text)
    raw_cleaned = []
    minute_offset = 0.0
    prev_start = 0.0

    for i, seg in enumerate(segments):
        raw_vp = str(seg.get("voice_profile", "")).lower().strip()
        gender = str(seg.get("gender", "")).lower().strip()
        raw_spk = seg.get("speaker")
        if raw_spk and str(raw_spk).strip():
            speaker = str(raw_spk).strip()
        else:
            speaker = "Speaker"
        speaker_lower = speaker.lower()

        # Detailed character voice profile mapping
        if raw_vp in ("grandma", "elderly_female") or any(k in speaker_lower or k in gender for k in ["grandma", "grandmother", "madame", "mrs", "elderly woman", "old woman", "យាយ", "លោកយាយ", "ជីដូន", "ម៉ែ", "夫人", "婆婆", "老奶奶", "华夫人"]):
            voice_profile = "grandma"
        elif raw_vp in ("grandpa", "elderly_male") or any(k in speaker_lower or k in gender for k in ["grandpa", "grandfather", "master", "elder", "old man", "elderly man", "តា", "លោកតា", "ជីតា", "ឪ", "老爷", "老爷爷", "老太爷"]):
            voice_profile = "grandpa"
        elif raw_vp in ("child_boy", "boy") or any(k in speaker_lower for k in ["boy", "son", "young boy", "little boy", "ក្មេងប្រុស", "កូនប្រុស", "男孩", "童子"]):
            voice_profile = "child_boy"
        elif raw_vp in ("child_girl", "girl") or any(k in speaker_lower for k in ["girl", "daughter", "young girl", "little girl", "ក្មេងស្រី", "កូនស្រី", "女孩", "丫头"]):
            voice_profile = "child_girl"
        elif raw_vp == "child" or any(k in speaker_lower or k in gender for k in ["child", "kid", "baby", "young", "ក្មេង", "កូន", "小孩"]):
            voice_profile = "child"
        elif gender == "male" or any(k in speaker_lower for k in ["male", "man", "lord", "officer", "scholar", "swordsman", "leader", "boss", "father", "guy", "brother", "husband", "ប្រុស", "លោក", "បង", "男", "公子", "唐伯虎", "秀才"]):
            voice_profile = "male"
        else:
            voice_profile = "female"

        seg_text = str(seg.get("text", "")).strip()
        orig_text = str(seg.get("original_text", "")).strip()

        # Remove speaker prefixes like "Speaker 1:"
        seg_text = re.sub(r"^(?:male|female|child|speaker\s*\d*)\s*:\s*", "", seg_text, flags=re.IGNORECASE).strip()
        orig_text = re.sub(r"^(?:male|female|child|speaker\s*\d*)\s*:\s*", "", orig_text, flags=re.IGNORECASE).strip()

        # Robust bidirectional fallback so neither text nor original_text is ever empty
        if not orig_text and seg_text:
            orig_text = seg_text
        if not seg_text and orig_text:
            seg_text = orig_text

        # If seg_text has both Khmer and Chinese characters mixed together (e.g. "唐伯虎 (តាំងប៉ហូ)" or "唐兄: បងថាង"),
        # clean the Chinese characters from the Khmer text field so it is 100% pure Khmer.
        if re.search(r'[\u1780-\u17FF]', seg_text) and re.search(r'[\u4E00-\u9FFF]', seg_text):
            cleaned_km = re.sub(r'[\u4E00-\u9FFF]+', '', seg_text)
            cleaned_km = re.sub(r'\(\s*\)|\[\s*\]', '', cleaned_km)
            cleaned_km = re.sub(r'^[:\s\-–—]+', '', cleaned_km).strip()
            if cleaned_km:
                seg_text = cleaned_km
            elif orig_text:
                seg_text = orig_text

        seg_text = _clean_repetitive_text(_clean_khmer_spacing(seg_text))
        if not seg_text and orig_text:
            seg_text = _clean_repetitive_text(orig_text)

        s_time = _parse_timestamp(seg.get("start_time", 0), prev_ref=prev_start)
        e_time = _parse_timestamp(seg.get("end_time", 0), prev_ref=s_time)

        # Auto-detect minute rollover within a chunk response (e.g. 59s -> 2s)
        while (s_time + minute_offset) < prev_start - 10.0 and s_time < 60.0:
            minute_offset += 60.0

        s_fixed = s_time + minute_offset
        e_fixed = e_time + minute_offset
        if e_fixed <= s_fixed:
            e_fixed = s_fixed + 1.2
        prev_start = s_fixed

        raw_cleaned.append({
            "index": i,
            "start_time": round(s_fixed, 2),
            "end_time": round(e_fixed, 2),
            "text": seg_text,
            "original_text": orig_text,
            "speaker": speaker,
            "voice_profile": voice_profile,
            "emotion": str(seg.get("emotion", "neutral")).lower().strip() or "neutral",
        })

    # Expand any multi-sentence segments into individual subsegments
    final_segments = []
    for seg in raw_cleaned:
        txt = seg.get("text", "").strip()
        orig = seg.get("original_text", "").strip()
        if not txt and orig:
            seg["text"] = orig
            txt = orig
        if not txt and not orig:
            continue
        sub_segs = _split_segment_into_subsegments(seg)
        for s in sub_segs:
            s_txt = s.get("text", "").strip()
            s_orig = s.get("original_text", "").strip()
            if not s_txt and s_orig:
                s["text"] = s_orig
                s_txt = s_orig
            if s_txt:
                final_segments.append(s)

    # Re-index
    for idx, s in enumerate(final_segments):
        s["index"] = idx

    return final_segments


def _build_narration_prompt(
    language: str = "km",
    style: str = "summary",
    prompt_hint: str = "",
    video_duration: float = 0.0,
) -> tuple[str, float]:
    """Build a prompt for AI narration/voiceover of a video.
    Returns (prompt, temperature) — temperature is part of the style."""
    lang_map = {
        "km": "Khmer", "en": "English", "zh": "Chinese (Mandarin)",
        "ja": "Japanese", "ko": "Korean", "th": "Thai", "vi": "Vietnamese",
        "fr": "French", "es": "Spanish", "de": "German",
    }
    lang_name = lang_map.get(language, language)

    # Each style controls not just a description, but the actual OUTPUT SHAPE:
    # tone, pacing/segment length, whether to weave in actor dialogue, and how
    # to open. Keeping these style-specific (instead of one shared rule set) is
    # what makes the styles come out genuinely different rather than converging.
    styles = {
        "recap_tiktok": {
            "headline": "a VIRAL TIKTOK / REELS SHORT-FORM MOVIE RECAP (សម្រាយរឿងបែប TikTok & Reels) — ultra-fast, high-hook, punchy lines designed for short-form retention.",
            "voice": [
                "Open with a high-energy retention hook in the first 1-2 seconds ('តើអ្នកជឿទេថា...', 'កុំមើលរំលងឱ្យសោះ...', 'មើលទៅបុរសម្នាក់នេះ...').",
                "Use humorous, catchy movie recap nicknames ('អាប្រុសខូច', 'ស្រីស្អាត', 'បុរសអាវខ្មៅ', 'លោកពូសក់វែង', 'មេបក្សកំណាច').",
                "Keep sentences ultra-short and rapid-fire (1.8 to 3.2 seconds per line).",
                "Insert high-suspense beat transitions ('តែស្រាប់តែពេលនោះ!', 'អ្វីដែលមិននឹកស្មានដល់នោះគឺ!', 'គ្រោះកាចបានមកដល់!').",
                "Conclude with an irresistible call-to-action or cliffhanger ('តើគាត់អាចរួចខ្លួនដែរឬទេ? ចុច Like និង Follow ដើម្បីទស្សនាភាគបន្ត!').",
            ],
            "pacing": "Rapid-fire 1.8-3.2 second segments, energetic cadence matching fast cuts.",
            "dialogue": "light",
            "opening": "Start with an explosive hook question or shocking reveal in the very first sentence.",
            "temperature": 0.82,
        },
        "recap_viral": {
            "headline": "a VIRAL MOVIE RECAP (សម្រាយរឿងបែបកក្រើក) — fast, punchy, high-tension, addictive recap style.",
            "voice": [
                "Hook the audience immediately in the first 2 seconds describing the opening situation.",
                "Use classic movie recap phrasing and nicknames ('មើលទៅបុរសម្នាក់នេះ', 'នារីកំសត់', 'មេបក្សកំណាច').",
                "Keep suspense at maximum intensity between beats ('មិននឹកស្មានដល់ថា...', 'ស្រាប់តែពេលនោះ...', 'តើមានអ្វីកើតឡើងបន្ត?').",
                "Directly follow the physical actions, fights, and reveals on screen.",
            ],
            "pacing": "Short, rapid segments, 2.5-4.0 seconds each, synchronized with scene cuts.",
            "dialogue": "light",
            "opening": "The first line must shock the viewer and describe the opening visual hook.",
            "temperature": 0.80,
        },
        "recap_cinema": {
            "headline": "a CINEMATIC MOVIE RECAP (សម្រាយរឿងបែបភាពយន្ត) — dramatic, visually-grounded, scene-by-scene storytelling.",
            "voice": [
                "Narrate the exact physical actions, confrontations, and drama occurring on screen with cinematic flair.",
                "Describe character gestures, expressions, weapon moves, and discoveries as they unfold in each shot.",
                "Use smooth cinematic narration transitions ('ពេលនោះស្រាប់តែ...', 'ឈុតឆាកបន្ត...', 'តួអង្គបានសម្រេចចិត្ត...').",
                "Keep every line concise and directly anchored to visible on-screen events.",
            ],
            "pacing": "Punchy 2.5-4.5 second segments, perfectly synchronized with visual scene changes.",
            "dialogue": "light",
            "opening": "Hook the viewer with a dramatic opening statement describing the initial scene.",
            "temperature": 0.75,
        },
        "recap_action": {
            "headline": "an ACTION & THRILLER RECAP (សម្រាយរឿងវាយប្រហារ & ក្បាច់គុន) — high adrenaline, fast-paced momentum.",
            "voice": [
                "High-octane cadence describing strikes, martial arts moves, escapes, and showdowns.",
                "Punchy action verbs ('ទាត់មួយជើង...', 'គេចផុតយ៉ាងលឿន...', 'ការប្រយុទ្ធដ៏ស្វិតស្វាញ').",
                "Match every strike and camera movement closely.",
            ],
            "pacing": "Rapid-fire 2.0-3.5 second segments matching physical action on screen.",
            "dialogue": "light",
            "opening": "Open directly into the heat of the action or imminent danger in the first frame.",
            "temperature": 0.78,
        },
        "summary": {
            "headline": "a concise, factual SUMMARY — like a clean explainer or news breakdown.",
            "voice": [
                "Neutral, clear, informative — an objective narrator.",
                "Report the key events plainly without artificial hype or cliffhangers.",
                "Cover the essential plot points scene by scene.",
            ],
            "pacing": "Medium segments, 3.0-4.5 seconds.",
            "dialogue": "none",
            "opening": "Open by stating plainly what the video is about.",
            "temperature": 0.35,
        },
        "educational": {
            "headline": "an engaging EDUCATIONAL / DOCUMENTARY narration — structured, authoritative, and fascinating.",
            "voice": [
                "Storyteller-educator tone with engaging phrasing.",
                "Highlight key concepts, historical facts, or scientific insights shown on screen.",
                "Clear, measured cadence suited for learning.",
            ],
            "pacing": "Medium segments, 3.5-5.0 seconds.",
            "dialogue": "none",
            "opening": "Open with a fascinating observation of the opening visual.",
            "temperature": 0.45,
        },
        "story": {
            "headline": "a STORYTELLING narration — turn the video into an immersive classic story.",
            "voice": [
                "Classic narrative arc: exposition, rising action, climax, and emotional payoff.",
                "Warm storytelling voice describing the characters' journey.",
            ],
            "pacing": "Varied segments, 3.0-4.5 seconds.",
            "dialogue": "light",
            "opening": "Open with an evocative story premise.",
            "temperature": 0.70,
        },
    }

    cfg = styles.get(style, styles.get("recap_viral", styles["summary"]))
    voice_lines = "\n".join(f"- {v}" for v in cfg["voice"])

    dialogue_directive = {
        "none": (
            "DIALOGUE: Do NOT create any \"dialogue\" segments. Use ONLY type \"narration\". "
            "Describe what people say in your own words instead of quoting them."
        ),
        "light": (
            "DIALOGUE: Mostly narration, but occasionally (roughly 1 out of every 5-6 segments) "
            "quote an actor's strongest line as a type \"dialogue\" segment, timed to when they speak."
        ),
        "heavy": (
            "DIALOGUE: Frequently (roughly 1 out of every 3 segments) weave in the actors' most dramatic "
            "lines as type \"dialogue\" segments, timed to when they speak, to heighten the drama."
        ),
    }[cfg["dialogue"]]

    custom_hint_section = f"\nUSER SPECIAL DIRECTION:\n- {prompt_hint}\n" if prompt_hint and prompt_hint.strip() else ""

    duration_guide = ""
    if video_duration and video_duration > 0:
        total_min = int(video_duration // 60)
        total_sec = int(video_duration % 60)
        duration_str = f"{total_min:02d}:{total_sec:02d} ({video_duration:.1f} seconds)"
        duration_guide = f"""
CRITICAL TIMELINE & FULL COVERAGE RULES (ហាមឈប់មុនចប់វីដេអូ):
- The video duration is EXACTLY {duration_str}.
- You MUST write recap narration covering the ENTIRE duration from timestamp 0.0s all the way to {video_duration:.1f}s.
- DO NOT finish early or stop at 1-2 minutes!
- Distribute your segments evenly across all scenes:
  * Opening Hook: 0.0s to {video_duration * 0.2:.1f}s
  * Middle Story & Battles: {video_duration * 0.2:.1f}s to {video_duration * 0.7:.1f}s
  * Climax & Final Conclusion / Outro: {video_duration * 0.7:.1f}s to {video_duration:.1f}s
- The last segment MUST finish at or near {video_duration:.1f}s."""

    khmer_specific_guide = ""
    if language == "km":
        khmer_specific_guide = """
KHMER MOVIE RECAP SPECIFIC RULES (ភាសាសម្រាយរឿងខ្មែរ):
- Use natural Cambodian movie recap phrasing (e.g. នៅក្នុងឈុតឆាកនេះ, ភ្លាមនោះស្រាប់តែ, រឿងរ៉ាវកាន់តែតានតឹង, មិននឹកស្មានដល់ថា, ចុងក្រោយ).
- Standard continuous Khmer script with NO artificial spaces between syllables or words.
- Use natural spoken pronouns (ខ្ញុំ, ឯង, គាត់, នាង, បង, អូន, ពុក, ម៉ែ, មេ) matching character hierarchy."""

    prompt = f"""You are a master movie recap and video voiceover scriptwriter (អ្នកសម្រាយរឿងអាជីព).

Watch this video carefully from beginning to end. Analyze the exact visual action and scene changes occurring at each second.

NARRATION STYLE:
Write {cfg['headline']}
{voice_lines}
- PACING: {cfg['pacing']}
- OPENING: {cfg['opening']}
{duration_guide}{custom_hint_section}{khmer_specific_guide}

CRITICAL SCENE SYNCHRONIZATION RULES (ការផ្គូផ្គងសកម្មភាពក្នុងឈុតឆាក):
1. EXACT SCENE MATCH: Every segment's start_time and end_time MUST align with the exact moment the action or scene happens on screen.
   - If a character appears at 0:15 and runs away at 0:20, narrate that specific action between 15.0s and 20.0s.
   - Do NOT narrate events before they appear on screen or after the scene has already changed.
2. NATURAL DURATION & BREATH GAPS:
   - Make each spoken line concise so it can be spoken comfortably within its allotted time slot (~3-4 words or 12-16 Khmer characters per second).
   - Leave small natural breath gaps (0.5s - 1.0s) between distinct scenes.
3. STORY ARC PROGRESSION:
   - Accurately describe characters, weapons, plot twists, emotional stakes, and resolutions based directly on what is seen in the footage.

Return a JSON array of segments. Two segment types are allowed:
[
  {{"start_time": 0.0, "end_time": 4.5, "type": "narration", "text": "narration text in {lang_name}", "emotion": "excited"}},
  {{"start_time": 5.0, "end_time": 7.5, "type": "dialogue", "speaker": "Character Name", "gender": "female", "text": "the actor's line in {lang_name}", "emotion": "angry"}}
]

{dialogue_directive}
- For dialogue segments: transcribe and translate the line, keep it short. Set "speaker" and "gender" ("male" or "female").
- Narration and dialogue segments must NOT overlap.
- "emotion": one of cheerful, happy, excited, sad, angry, calm, serious, fearful, whisper, neutral.

Rules:
- TEXT must be in natural {lang_name} suited for movie recap narration.
- SHORT & CRISP: Each segment must be easy to speak comfortably within its timestamps.
- COMPLETE COVERAGE: Cover the entire video from start to end ({duration_str if video_duration > 0 else 'full length'}).
- JSON ONLY: Output ONLY the raw JSON array. No markdown fences, no explanation."""

    return prompt, cfg["temperature"]


async def generate_narration(
    video_path: str,
    language: str = "km",
    style: str = "recap_viral",
    prompt_hint: str = "",
    video_duration: float = 0.0,
) -> list:
    """
    Generate AI narration/voiceover script from video using lightweight media proxy for ultra-fast generation.
    Returns a list of narration segments with timestamps and text.
    """
    prompt, temperature = _build_narration_prompt(
        language, style, prompt_hint=prompt_hint, video_duration=video_duration
    )
    media_path, tmp_dir = await _build_media_proxy_for_gemini(video_path)

    keys = await _get_active_keys()
    if not keys:
        if not settings.gemini_api_key or settings.gemini_api_key == "your_gemini_api_key_here":
            raise RuntimeError("No API keys configured. Please add a Gemini API key in Settings.")
        keys = [settings.gemini_api_key]

    models_to_try = [
        settings.gemini_model or "gemini-flash-latest",
        "gemini-flash-latest",
        "gemini-3.6-flash",
        "gemini-3.7-flash",
        "gemini-flash-lite-latest",
    ]
    seen = set()
    models_to_try = [m for m in models_to_try if not (m in seen or seen.add(m))]

    last_err = None
    response_text = ""

    try:
        for key_idx, key in enumerate(keys):
            genai.configure(api_key=key)
            uploaded_file = None
            try:
                uploaded_file = await asyncio.to_thread(genai.upload_file, media_path)
                poll_count = 0
                while uploaded_file.state.name == "PROCESSING":
                    poll_count += 1
                    if poll_count > 30:
                        break
                    await asyncio.sleep(0.5)
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
                                temperature=temperature,
                                response_mime_type="application/json",
                                max_output_tokens=65536,
                            ),
                        )
                        if response and response.text:
                            response_text = response.text.strip()
                            break
                    except Exception as me:
                        last_err = me
                        continue

                if response_text:
                    break
            except Exception as ke:
                last_err = ke
                continue
            finally:
                if uploaded_file:
                    try:
                        await asyncio.to_thread(genai.delete_file, uploaded_file.name)
                    except Exception:
                        pass

        if not response_text:
            raise RuntimeError(f"Narration generation failed: {last_err or 'No response from AI model'}")

        # Parse response
        text = response_text
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\n?", "", text)
            text = re.sub(r"\n?```$", "", text)

        segments = _safe_json_loads(text)
        cleaned = []
        for i, seg in enumerate(segments):
            seg_text = str(seg.get("text", "")).strip()
            # Strip watermark URLs Gemini may have read off the video
            seg_text = re.sub(r"(?:https?://|www\.)\S+", "", seg_text).strip()
            if not seg_text:
                continue
            seg_type = str(seg.get("type") or "narration").lower()
            cleaned.append({
                "index": i,
                "start_time": float(seg.get("start_time", 0)),
                "end_time": float(seg.get("end_time", 0)),
                "text": seg_text,
                "type": seg_type if seg_type in ("narration", "dialogue") else "narration",
                "speaker": str(seg.get("speaker") or "").strip(),
                "gender": str(seg.get("gender") or "").strip().lower(),
                "emotion": str(seg.get("emotion") or "").strip().lower(),
            })
        return cleaned

    finally:
        if tmp_dir and os.path.exists(tmp_dir):
            shutil.rmtree(tmp_dir, ignore_errors=True)


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


async def _transcribe_media_with_fallback(media_path: str, prompt: str) -> list:
    """Upload media file with key rotation and generate transcript segments with model fallback."""
    keys = await _get_active_keys()
    if not keys:
        if not settings.gemini_api_key or settings.gemini_api_key == "your_gemini_api_key_here":
            raise RuntimeError("No API keys configured. Please add a Gemini API key in Settings.")
        keys = [settings.gemini_api_key]

    models_to_try = [
        settings.gemini_model or "gemini-3.1-flash-lite",
        "gemini-3.1-flash-lite",
        "gemini-3.5-flash-lite",
        "gemini-3.5-flash",
        "gemini-3.6-flash",
        "gemini-flash-latest",
        "gemini-flash-lite-latest",
    ]
    seen = set()
    models_to_try = [m for m in models_to_try if not (m in seen or seen.add(m))]

    last_err = None
    for key_idx, key in enumerate(keys):
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
                    print(f"[gemini] Key {key_idx+1} Model {m_name} failed: {me}", flush=True)
                    if any(x in err_str for x in ["429", "quota", "exhausted", "resource"]):
                        await asyncio.sleep(2.0)
                    continue
        except Exception as ke:
            last_err = ke
            print(f"[gemini] Key {key_idx+1} upload/transcribe failed: {ke}", flush=True)
        finally:
            if uploaded_file:
                try:
                    await asyncio.to_thread(genai.delete_file, uploaded_file.name)
                except Exception:
                    pass

    raise last_err or Exception("All Gemini API keys and models failed to transcribe media")


async def transcribe_video(video_path: str, language: str = "km") -> list:
    """
    Transcribe video using lightweight multimodal proxy with automatic multi-key and multi-model fallback.
    Auto-detects source language, correlates visual speech & audio, and formats natural captions.
    """
    media_path, tmp_dir = await _build_media_proxy_for_gemini(video_path)
    prompt = _build_prompt(language)
    try:
        segments = await _transcribe_media_with_fallback(media_path, prompt)
        return segments
    finally:
        if tmp_dir and os.path.exists(tmp_dir):
            shutil.rmtree(tmp_dir, ignore_errors=True)


def _iter_chunks_sync(model, content, prompt, chunk_queue: queue.Queue):
    """Synchronous helper that pushes streaming chunks into a queue (runs in a thread)."""
    try:
        response = model.generate_content(
            [content, prompt],
            stream=True,
            generation_config=genai.types.GenerationConfig(
                temperature=0.1,
                top_p=0.95,
            ),
        )
        for chunk in response:
            if chunk.text:
                chunk_queue.put(chunk.text)
    except Exception as e:
        chunk_queue.put(e)
    finally:
        chunk_queue.put(None)  # sentinel: stream finished


async def transcribe_video_streaming(video_path: str, language: str = "km", on_progress=None) -> AsyncGenerator:
    """
    Upload video/audio to Gemini and get transcription segments.
    For long videos (>6 min), splits into ~5-minute chunks and transcribes each
    separately for better coverage. Yields dicts: either {"_progress": "message"}
    for status updates, or segment dicts with start_time/end_time/text/speaker.
    """
    await _configure_genai()

    yield {"_progress": "Analyzing video length..."}

    duration = await _get_video_duration(video_path)
    prompt = _build_prompt(language)

    if duration > CHUNK_THRESHOLD:
        # ---- Long video: split into chunks and transcribe each ----
        num_chunks = int(duration // CHUNK_DURATION) + (1 if duration % CHUNK_DURATION > 0 else 0)
        yield {
            "_progress": f"Video is {int(duration)}s ({int(duration//60)}m {int(duration%60)}s) — transcribing {num_chunks} parts with full speech coverage...",
            "current_chunk": 0,
            "total_chunks": num_chunks,
            "percent": 5,
        }

        chunks, tmp_dir = await _split_video_chunks(video_path)
        all_segments = []

        chunk_prompt = prompt + (
            "\n\nCRITICAL MANDATE: This audio segment is part of a full-length video transcription. "
            "You MUST transcribe EVERY single spoken utterance from 0.0s to the very end of this clip. "
            "Never omit whispers, background dialogue, rapid speech, voiceovers, or quiet remarks. "
            "Output granular 1.0 to 3.5 second segments for every sentence."
        )

        def _filter_boundary_duplicates(existing_segments: list, new_segments: list) -> list:
            if not existing_segments:
                return new_segments
            if not new_segments:
                return []

            clean_new = []
            for n_seg in new_segments:
                n_start = n_seg.get("start_time", 0)
                n_end = n_seg.get("end_time", 0)
                n_text = n_seg.get("text", "").strip()
                n_orig = n_seg.get("original_text", "").strip()
                if not n_text and not n_orig:
                    continue

                is_dup = False
                for ex_seg in reversed(existing_segments[-40:]):
                    ex_start = ex_seg.get("start_time", 0)
                    ex_end = ex_seg.get("end_time", 0)
                    ex_text = ex_seg.get("text", "").strip()
                    ex_orig = ex_seg.get("original_text", "").strip()

                    if abs(n_start - ex_start) > 60.0:
                        continue

                    # Exact text match within 30s
                    if n_text and ex_text and n_text == ex_text and abs(n_start - ex_start) < 30.0:
                        is_dup = True
                        break
                    # Exact original text match within 40s
                    if n_orig and ex_orig and n_orig == ex_orig and abs(n_start - ex_start) < 40.0:
                        is_dup = True
                        break
                    # Substring overlap
                    if len(n_orig) > 15 and len(ex_orig) > 15 and (n_orig in ex_orig or ex_orig in n_orig) and abs(n_start - ex_start) < 25.0:
                        is_dup = True
                        break
                    # Boundary collision
                    if n_text == ex_text and n_start < ex_end - 0.2:
                        is_dup = True
                        break

                if not is_dup:
                    clean_new.append(n_seg)
            return clean_new

        async def _process_chunk(i: int, chunk_path: str, start_offset: float) -> tuple[int, list]:
            """Upload, transcribe, and offset one chunk with automatic retry across keys and models."""
            for attempt in range(4):
                try:
                    chunk_segments = await _transcribe_media_with_fallback(chunk_path, chunk_prompt)
                    if isinstance(chunk_segments, list):
                        for seg in chunk_segments:
                            seg["start_time"] = round(seg["start_time"] + start_offset, 2)
                            seg["end_time"] = round(seg["end_time"] + start_offset, 2)
                        print(f"[transcribe] Chunk {i+1}/{len(chunks)}: offset={start_offset:.1f}s -> {len(chunk_segments)} segments", flush=True)
                        return (i, chunk_segments)
                except Exception as e:
                    err_str = str(e).lower()
                    sleep_s = 5.0 * (attempt + 1) if any(x in err_str for x in ["429", "quota", "exhausted", "resource"]) else (2.0 * (attempt + 1))
                    print(f"[transcribe] Chunk {i+1} attempt {attempt+1} failed: {e} -> retrying in {sleep_s:.1f}s", flush=True)
                    await asyncio.sleep(sleep_s)
            return (i, [])

        try:
            total_c = len(chunks)
            # Semaphore limits how many chunks upload+transcribe simultaneously
            sem = asyncio.Semaphore(MAX_PARALLEL_CHUNKS)

            async def _process_chunk_limited(i: int, chunk_path: str, start_offset: float) -> tuple[int, list]:
                async with sem:
                    return await _process_chunk(i, chunk_path, start_offset)

            # Launch ALL chunks concurrently (semaphore controls actual parallelism)
            tasks = [
                asyncio.create_task(_process_chunk_limited(i, cp, off))
                for i, (cp, off) in enumerate(chunks)
            ]

            # Yield progress updates as tasks complete
            completed = 0
            chunk_results: list[list] = [[] for _ in range(total_c)]

            # Report initial progress
            yield {
                "_progress": f"Transcribing {total_c} parts in parallel (up to {MAX_PARALLEL_CHUNKS} at once)...",
                "current_chunk": 0,
                "total_chunks": total_c,
                "percent": 8,
            }

            for future in asyncio.as_completed(tasks):
                idx_done, segs = await future
                chunk_results[idx_done] = segs
                completed += 1
                pct = round(8 + (completed / total_c) * 88)
                yield {
                    "_progress": f"Completed part {completed}/{total_c}...",
                    "current_chunk": completed,
                    "total_chunks": total_c,
                    "percent": pct,
                }

            # Merge in time order and stream out
            all_segments = []
            for segs in chunk_results:
                if segs:
                    clean_segs = _filter_boundary_duplicates(all_segments, segs)
                    all_segments.extend(clean_segs)
                    for seg in clean_segs:
                        yield seg

            yield {
                "_progress": f"Transcribed {len(all_segments)} total caption lines across full video",
                "current_chunk": total_c,
                "total_chunks": total_c,
                "percent": 100,
            }

        finally:
            if tmp_dir and os.path.isdir(tmp_dir):
                shutil.rmtree(tmp_dir, ignore_errors=True)

    else:
        # ---- Short video: transcribe with multimodal video proxy ----
        yield {
            "_progress": "Preparing video for AI speech recognition...",
            "current_chunk": 0,
            "total_chunks": 1,
            "percent": 20,
        }

        media_path, tmp_dir = await _build_media_proxy_for_gemini(video_path)
        try:
            yield {
                "_progress": "AI is analyzing visual speech and dialogue...",
                "current_chunk": 1,
                "total_chunks": 1,
                "percent": 55,
            }
            segments = await _transcribe_media_with_fallback(media_path, prompt)
            yield {
                "_progress": f"Generated {len(segments)} caption lines",
                "current_chunk": 1,
                "total_chunks": 1,
                "percent": 98,
            }

            for seg in segments:
                yield seg
        finally:
            if tmp_dir and os.path.exists(tmp_dir):
                shutil.rmtree(tmp_dir, ignore_errors=True)


def _deduplicate_chunk_segments(segments: list) -> list:
    """Remove duplicate segments that may appear at chunk boundary overlaps.
    Preserves all dialogue turns, quick character replies, and distinct utterances."""
    if not segments:
        return []

    result = [segments[0]]
    for seg in segments[1:]:
        prev = result[-1]
        cur_text = str(seg.get("text", "")).strip()
        prev_text = str(prev.get("text", "")).strip()

        # Only drop if it is truly the exact same text spoken at almost the exact same timestamp (< 0.6s difference)
        if cur_text and prev_text and cur_text == prev_text and abs(seg["start_time"] - prev["start_time"]) < 0.6:
            continue

        # If huge overlap (>85%) with identical text
        overlap_start = max(prev["start_time"], seg["start_time"])
        overlap_end = min(prev["end_time"], seg["end_time"])
        overlap = max(0, overlap_end - overlap_start)
        seg_duration = max(0.1, seg["end_time"] - seg["start_time"])
        if overlap / seg_duration > 0.85 and cur_text == prev_text:
            continue

        result.append(seg)

    return result


async def translate_text(text: str, target_language: str = "km") -> str:
    """Translate a single text segment using Gemini."""
    await _configure_genai()
    lang_map = {
        "km": "Khmer", "en": "English", "zh": "Chinese (Mandarin)",
        "ja": "Japanese", "ko": "Korean", "th": "Thai",
        "vi": "Vietnamese", "fr": "French", "es": "Spanish",
        "de": "German", "pt": "Portuguese", "ru": "Russian",
        "ar": "Arabic", "hi": "Hindi", "id": "Indonesian", "ms": "Malay",
    }
    lang_name = lang_map.get(target_language, target_language)
    model = genai.GenerativeModel(settings.gemini_model)

    prompt = f"""You are a professional translator. Translate the following text to {lang_name}.
- The translation must be natural and fluent, not word-for-word literal.
- Preserve the original meaning, tone, and intent.
- Use vocabulary and grammar that native {lang_name} speakers would naturally use.
- Keep proper nouns and brand names as-is.
- Return ONLY the translated text, nothing else.

{text}"""
    response = await asyncio.to_thread(model.generate_content, prompt)
    return response.text.strip()

def _extract_translated_list(parsed, expected_len: int) -> list[str]:
    """Robustly extract translated strings from any JSON structure returned by Gemini."""
    out = [""] * expected_len
    if isinstance(parsed, list):
        for idx_item, item in enumerate(parsed):
            if isinstance(item, dict):
                raw_idx = item.get("index") or item.get("id") or item.get("line") or item.get("no") or (idx_item + 1)
                try:
                    idx = int(raw_idx) - 1
                except (ValueError, TypeError):
                    idx = idx_item

                txt = ""
                for key in ["text", "translation", "translated_text", "translated", "khmer", "target", "content", "msg", "line_text"]:
                    if key in item and item[key]:
                        txt = str(item[key]).strip()
                        break
                if not txt and len(item) == 1:
                    txt = str(list(item.values())[0]).strip()

def _extract_translated_list(parsed, expected_len: int) -> list[dict]:
    out = [{"text": "", "speaker": ""} for _ in range(expected_len)]
    if isinstance(parsed, list):
        for idx_item, item in enumerate(parsed):
            if isinstance(item, dict):
                idx = item.get("index", idx_item + 1)
                try:
                    idx = int(idx) - 1
                except (ValueError, TypeError):
                    idx = idx_item

                txt = ""
                for key in ["text", "translation", "translated_text", "translated", "khmer", "target", "content", "msg", "line_text"]:
                    if key in item and item[key]:
                        txt = str(item[key]).strip()
                        break
                if not txt and len(item) == 1:
                    txt = str(list(item.values())[0]).strip()

                spk = str(item.get("speaker", "")).strip()

                # Clean any leading speaker brackets in text like [Tang Bohu]: or 唐伯虎:
                txt = re.sub(r'^(?:\[[^\]]+\]|【[^】]+】|[\u1780-\u17FF\w\s\u4E00-\u9FFF]+[:：])\s*', '', txt).strip()

                if 0 <= idx < expected_len and txt:
                    out[idx] = {"text": txt, "speaker": spk}
            elif isinstance(item, str) and item.strip():
                clean_str = re.sub(r'^(?:\[[^\]]+\]|【[^】]+】|[\u1780-\u17FF\w\s\u4E00-\u9FFF]+[:：])\s*', '', item.strip()).strip()
                if idx_item < expected_len:
                    out[idx_item] = {"text": clean_str, "speaker": ""}
    elif isinstance(parsed, dict):
        if "translations" in parsed and isinstance(parsed["translations"], list):
            return _extract_translated_list(parsed["translations"], expected_len)
        if "segments" in parsed and isinstance(parsed["segments"], list):
            return _extract_translated_list(parsed["segments"], expected_len)
        for k, v in parsed.items():
            try:
                idx = int(k) - 1
                if 0 <= idx < expected_len:
                    if isinstance(v, str):
                        clean_str = re.sub(r'^(?:\[[^\]]+\]|【[^】]+】|[\u1780-\u17FF\w\s\u4E00-\u9FFF]+[:：])\s*', '', v.strip()).strip()
                        out[idx] = {"text": clean_str, "speaker": ""}
                    elif isinstance(v, dict):
                        sub_txt = ""
                        for sub_k in ["text", "translation", "translated_text", "khmer"]:
                            if sub_k in v and v[sub_k]:
                                sub_txt = str(v[sub_k]).strip()
                                break
                        sub_txt = re.sub(r'^(?:\[[^\]]+\]|【[^】]+】|[\u1780-\u17FF\w\s\u4E00-\u9FFF]+[:：])\s*', '', sub_txt).strip()
                        out[idx] = {"text": sub_txt, "speaker": str(v.get("speaker", "")).strip()}
            except (ValueError, TypeError):
                pass
    return out


def _build_translation_prompt(chunk_segs: list, target_language: str, lang_name: str) -> str:
    lines_formatted = []
    for i, seg in enumerate(chunk_segs):
        spk = seg.get("speaker") or ""
        txt = seg.get("original_text") or seg.get("text", "")
        if spk:
            lines_formatted.append(f"{i+1}. [{spk}]: {txt}")
        else:
            lines_formatted.append(f"{i+1}. {txt}")
    numbered = "\n".join(lines_formatted)

    if target_language in ("km", "auto", ""):
        return f"""You are a master cinematic subtitle and movie dubbing translator specializing in Cambodian Khmer (ភាសាខ្មែរ).
Translate the following sequential video dialogue lines into natural, fluent, and expressive spoken Khmer (ភាសានិយាយភាពយន្ត / សម្រាយរឿង).

CRITICAL LOCALIZATION & TRANSLATION RULES:
1. NATURAL SPOKEN KHMER (ភាសាខ្មែរ):
   - Translate into rich, natural spoken Cambodian Khmer suited for video dubbing, movie subtitles, and storytelling.
   - Accurately capture emotional nuances, dramatic tension, jokes, sarcasm, and character personality.
   - Write 100% EXCLUSIVELY in Cambodian Khmer script (អក្សរខ្មែរ). NEVER output Chinese characters (中文), Thai script (ภาษาไทย), or English in the dialogue.
   - Ensure correct Khmer orthography, vowel placement, and continuous script without broken syllables.

2. CHARACTER NAMES & SPEAKER TRANSLATION:
   - Localize all speaker and character names into Cambodian Khmer pronunciation (e.g. 唐伯虎 -> តាំង ប៉ូហ៊ូ, 秋香 -> ឈីវស៊ាង, 华夫人 -> លោកស្រី ហួ, 石榴姐 -> អ្នកបង ស៊ីលៀវ).
   - NEVER output Chinese characters for speaker names.
   - DO NOT include speaker name prefixes in the "text" field.

3. CONTEXTUAL PRONOUNS:
   - Use natural Khmer dialogue pronouns: បង/អូន (couples), ឯង/យើង (friends), ខ្ញុំ/លោក (polite), ឯង/អញ (rivals/enemies).

Return a JSON array of objects:
[
  {{"index": 1, "speaker": "Character name in Khmer (e.g. តាំង ប៉ូហ៊ូ)", "text": "Translated Khmer dialogue ONLY"}}
]
matching all {len(chunk_segs)} lines in exact order.
Return ONLY valid JSON array without markdown formatting.

Lines to translate:
{numbered}"""
    else:
        return f"""You are a master video subtitle and film dialogue translator. Translate the following sequential dialogue lines into natural, fluent {lang_name}.

Translation rules:
- Produce natural, fluent {lang_name} dialogue suited for cinematic subtitles and dubbing — NOT literal word-for-word machine translation.
- Accurately preserve the original meaning, character emotion, and dramatic context.
- Use vocabulary and phrasing that native {lang_name} speakers naturally use in films and videos.
- DO NOT include speaker name prefixes in your translated "text" output.
- Keep each line concise and suitable for timed video subtitles.
- Return a JSON array of objects: [{{"index": 1, "speaker": "Character Name", "text": "translated dialogue"}}, ...] matching all {len(chunk_segs)} lines.
Return ONLY valid JSON array without markdown formatting.

Lines to translate:
{numbered}"""


async def translate_segments(segments: list, target_language: str = "km") -> list:
    """Translate all subtitle segments into the target language using Gemini."""
    if not segments:
        return []

    effective_target = "km" if target_language in ("km", "auto", "") else target_language

    lang_map = {
        "km": "Khmer (ភាសាខ្មែរ)",
        "en": "English",
        "zh": "Chinese (Mandarin)",
        "ja": "Japanese",
        "ko": "Korean",
        "th": "Thai",
        "vi": "Vietnamese",
        "fr": "French",
        "es": "Spanish",
        "de": "German",
        "pt": "Portuguese",
        "ru": "Russian",
        "ar": "Arabic",
        "hi": "Hindi",
        "id": "Indonesian",
        "ms": "Malay",
    }
    lang_name = lang_map.get(effective_target, effective_target)

    await _configure_genai()

    CHUNK_SIZE = 35
    translated_data = [{}] * len(segments)

    for start_idx in range(0, len(segments), CHUNK_SIZE):
        end_idx = min(start_idx + CHUNK_SIZE, len(segments))
        chunk_segs = segments[start_idx:end_idx]
        prompt = _build_translation_prompt(chunk_segs, effective_target, lang_name)

        try:
            response = await _generate_with_fallback(
                prompt,
                generation_config=genai.types.GenerationConfig(
                    temperature=0.2,
                    response_mime_type="application/json",
                ),
            )

            raw = response.text.strip()
            if raw.startswith("```"):
                raw = re.sub(r"^```(?:json)?\n?", "", raw)
                raw = re.sub(r"\n?```$", "", raw)

            parsed = _safe_json_loads(raw)
            extracted = _extract_translated_list(parsed, len(chunk_segs))
            for local_i, t_item in enumerate(extracted):
                if t_item and (t_item.get("text") or t_item.get("speaker")):
                    translated_data[start_idx + local_i] = t_item
        except Exception as e:
            print(f"[translate_segments] Chunk {start_idx}-{end_idx} failed: {e}", flush=True)

    result = []
    for i, seg in enumerate(segments):
        new_seg = dict(seg)
        t_item = translated_data[i] if i < len(translated_data) else {}
        t_text = t_item.get("text") if isinstance(t_item, dict) else (t_item or "")
        t_spk = t_item.get("speaker") if isinstance(t_item, dict) else ""
        if not t_text:
            t_text = seg.get("text", "")

        if effective_target == "km":
            clean_km = re.sub(r'[\u4E00-\u9FFF]+', '', t_text).strip()
            new_seg["text"] = _clean_khmer_spacing(clean_km or t_text)
            if t_spk and not re.search(r'[\u4E00-\u9FFF]', t_spk):
                new_seg["speaker"] = t_spk
        else:
            new_seg["text"] = t_text
            if t_spk:
                new_seg["speaker"] = t_spk

        result.append(new_seg)

    return result


async def translate_segments_stream(segments: list, target_language: str = "km"):
    """Async generator that translates subtitle segments in chunks and yields progress + translated segments in real time."""
    if not segments:
        return

    lang_map = {
        "km": "Khmer (ភាសាខ្មែរ)",
        "en": "English",
        "zh": "Chinese (Mandarin)",
        "ja": "Japanese",
        "ko": "Korean",
        "th": "Thai",
        "vi": "Vietnamese",
        "fr": "French",
        "es": "Spanish",
        "de": "German",
        "pt": "Portuguese",
        "ru": "Russian",
        "ar": "Arabic",
        "hi": "Hindi",
        "id": "Indonesian",
        "ms": "Malay",
    }
    lang_name = lang_map.get(target_language, target_language)

    await _configure_genai()

    CHUNK_SIZE = 30
    total_segments = len(segments)
    processed_count = 0

    for start_idx in range(0, total_segments, CHUNK_SIZE):
        end_idx = min(start_idx + CHUNK_SIZE, total_segments)
        chunk_segs = segments[start_idx:end_idx]
        effective_target = "km" if target_language in ("km", "auto", "") else target_language
        prompt = _build_translation_prompt(chunk_segs, effective_target, lang_name)

        chunk_translated = [{}] * len(chunk_segs)
        try:
            response = await _generate_with_fallback(
                prompt,
                generation_config=genai.types.GenerationConfig(
                    temperature=0.2,
                    response_mime_type="application/json",
                ),
            )

            raw = response.text.strip()
            if raw.startswith("```"):
                raw = re.sub(r"^```(?:json)?\n?", "", raw)
                raw = re.sub(r"\n?```$", "", raw)

            parsed = _safe_json_loads(raw)
            extracted = _extract_translated_list(parsed, len(chunk_segs))
            for local_i, t_item in enumerate(extracted):
                if t_item and (t_item.get("text") or t_item.get("speaker")):
                    chunk_translated[local_i] = t_item
        except Exception as e:
            print(f"[translate_segments_stream] Chunk {start_idx}-{end_idx} failed: {e}", flush=True)

        for local_idx, orig_seg in enumerate(chunk_segs):
            processed_count += 1
            t_item = chunk_translated[local_idx] if local_idx < len(chunk_translated) else {}
            if isinstance(t_item, dict):
                t_text = t_item.get("text", "")
                t_spk = t_item.get("speaker", "")
            elif isinstance(t_item, str):
                t_text = t_item
                t_spk = ""
            else:
                t_text = ""
                t_spk = ""

            if not t_text:
                t_text = orig_seg.get("text", "")

            if effective_target == "km":
                clean_km = re.sub(r'[\u4E00-\u9FFF]+', '', t_text).strip()
                final_text = _clean_khmer_spacing(clean_km or t_text)
            else:
                final_text = t_text

            yield {
                "id": orig_seg.get("id"),
                "index": start_idx + local_idx,
                "text": final_text,
                "speaker": t_spk,
                "current": processed_count,
                "total": total_segments,
                "percent": round((processed_count / total_segments) * 100),
            }


async def run_ai_agent(project_name: str, video_duration: float, segments: list[dict], action: str, custom_prompt: str = "") -> dict:
    """Meatika AI Video Agent assistant for content creators."""
    await _configure_genai()
    model = genai.GenerativeModel(settings.gemini_model)

    # Format transcript summary
    transcript_text = "\n".join(
        f"[{seg.get('start_time', 0):.1f}s - {seg.get('end_time', 0):.1f}s] ({seg.get('speaker', 'Speaker')}): {seg.get('text', '')}"
        for seg in segments[:100]
    )

    system_instruction = f"""You are Meatika AI Video Assistant (មាតិកា AI), an expert video editor, content strategist, scriptwriter, and social media creator.
Project: {project_name}
Duration: {video_duration:.1f} seconds
Total Subtitle Segments: {len(segments)}

Transcript Context:
{transcript_text if transcript_text else "(No subtitles loaded yet)"}
"""

    if action == "make_punchy":
        prompt = f"""{system_instruction}
TASK: Make this video script punchy and viral for TikTok / Instagram Reels / YouTube Shorts!
1. Provide 3 high-converting viral hooks (first 3 seconds).
2. Rewrite the key messages into high-energy, fast-paced talking points.
3. Suggest 3 call-to-actions (CTA) in Khmer & English.
4. Recommend optimal caption animation style and sound effect placement."""

    elif action == "summarize":
        prompt = f"""{system_instruction}
TASK: Summarize this video.
1. 1-sentence Executive Summary.
2. 4-6 Key Bullet Point Takeaways.
3. Target Audience & Core Value Proposition."""

    elif action == "youtube_seo":
        prompt = f"""{system_instruction}
TASK: Generate complete YouTube / Facebook SEO package:
1. 5 High-CTR Clickable Titles (in Khmer and English).
2. Engaging Video Description with intro hook and structured chapters/timestamps.
3. 25+ viral hashtags & search tags (comma-separated)."""

    elif action == "highlight_moments":
        prompt = f"""{system_instruction}
TASK: Identify the top 3-5 best highlight moments for viral clips:
For each moment provide:
- Start Timestamp & End Timestamp
- Clip Title & Why it's engaging
- Suggested On-Screen Text / Caption Hook
- Recommended Sound Effect (e.g. Whoosh, Boom, Ding)"""

    elif action == "refine_khmer":
        prompt = f"""{system_instruction}
TASK: Review the Khmer subtitles and refine phrasing for natural, modern, and engaging speech:
1. Identify awkward or literal phrasing and provide natural, colloquial Khmer alternatives.
2. Point out spelling or punctuation improvements.
3. Provide an updated polished version of the key dialogue."""

    elif action == "translate_all":
        target = custom_prompt or "English"
        prompt = f"""{system_instruction}
TASK: Translate the entire video transcript into {target}.
Provide a clear, polished, and natural translation preserving timing and speaker intent."""

    else:
        # Custom prompt or chat
        prompt = f"""{system_instruction}
USER REQUEST:
{custom_prompt}

Provide a comprehensive, professional, and actionable response for the video creator."""

    try:
        response = await asyncio.to_thread(
            model.generate_content,
            prompt,
        )
        content_text = ""
        try:
            content_text = response.text.strip()
        except Exception:
            if hasattr(response, "parts") and response.parts:
                content_text = "\n".join(p.text for p in response.parts if hasattr(p, "text")).strip()
            elif hasattr(response, "candidates") and response.candidates:
                first_cand = response.candidates[0]
                if hasattr(first_cand, "content") and hasattr(first_cand.content, "parts"):
                    content_text = "\n".join(p.text for p in first_cand.content.parts if hasattr(p, "text")).strip()

        if not content_text:
            content_text = "I have completed processing your request."

        return {
            "action": action,
            "content": content_text,
        }
    except Exception as e:
        logger.error(f"Error in run_ai_agent: {e}")
        return {
            "action": action,
            "content": f"AI Assistant Notice: {str(e)}",
        }


async def generate_movie_titles(
    original_title: str = "",
    transcript_text: str = "",
    video_path: str = "",
    language: str = "km",
) -> list[dict]:
    """Generate viral, high-CTR movie recap titles in multiple popular styles."""
    keys = await _get_active_keys()
    if not keys:
        if not settings.gemini_api_key or settings.gemini_api_key == "your_gemini_api_key_here":
            raise RuntimeError("No active Gemini API keys configured. Please add an API key in Settings.")
        keys = [settings.gemini_api_key]

    system_instruction = f"""You are a master movie recap creator and social media video editor specialized in viral TikTok, Facebook Reels, and YouTube titles.

Language: {language} (use natural conversational Khmer with standard continuous script if language is 'km').

Generate a structured set of 5-8 extremely catchy, viral movie recap titles across distinct popular categories:
1. "viral_hook": High-suspense / curiosity clickbait hook (ចំណងជើងទាក់ទាញ)
2. "comedy_nickname": Humorous & Cambodian character nicknames e.g., អាប្រុសខូច, បុរសអាវខ្មៅ, មេបក្សចាស់វស្សា (កំប្លុកកំប្លែង)
3. "action_battle": High-stakes action, martial arts & epic battle (វាយប្រហារ & ក្បាច់គុន)
4. "drama_mystery": Emotional drama & deep secret (មនោសញ្ចេតនា & អាថ៌កំបាំង)
5. "tiktok_short": Ultra-short, punchy title with emojis for TikTok / Reels (ខ្លីខ្លឹមបែប TikTok)

Output ONLY a JSON array of objects:
[
  {{
    "category": "viral_hook",
    "category_label": "ចំណងជើងទាក់ទាញ (Viral Hook)",
    "title": "កុំមើលងាយបុរសម្នាក់នេះឱ្យសោះ បើមិនចង់ស្តាយក្រោយ!",
    "description": "ចំណងជើងបែបភ្ញាក់ផ្អើល បង្កើតការចង់ដឹងចង់ឃើញខ្ពស់"
  }}
]"""

    user_content = f"Original Movie Title / Topic: {original_title or 'Untitled Movie / Video'}\n\n"
    if transcript_text:
        user_content += f"Subtitles / Dialogue Transcript Content:\n{transcript_text[:6000]}\n"

    models_to_try = [
        settings.gemini_model or "gemini-2.5-flash",
        "gemini-2.5-flash",
        "gemini-flash-latest",
        "gemini-3.6-flash",
        "gemini-flash-lite-latest",
        "gemini-3.7-flash",
    ]
    seen = set()
    models_to_try = [m for m in models_to_try if not (m in seen or seen.add(m))]

    last_err = None
    for api_key in keys:
        for model_name in models_to_try:
            try:
                genai.configure(api_key=api_key)
                model = genai.GenerativeModel(
                    model_name=model_name,
                    system_instruction=system_instruction,
                    generation_config=genai.GenerationConfig(
                        temperature=0.8,
                        response_mime_type="application/json",
                    ),
                )
                response = await asyncio.to_thread(model.generate_content, user_content)
                if response and response.text:
                    text = response.text.strip()
                    if text.startswith("```"):
                        text = re.sub(r"^```(?:json)?\n?", "", text)
                        text = re.sub(r"\n?```$", "", text)
                    titles = _safe_json_loads(text)
                    if isinstance(titles, list) and len(titles) > 0:
                        return titles
            except Exception as e:
                last_err = e
                continue

    if last_err:
        raise RuntimeError(f"Title generation failed: {last_err}")
    return []


async def generate_social_media_script(
    original_title: str = "",
    transcript_text: str = "",
    video_path: str = "",
    language: str = "km",
) -> dict:
    """Generate a complete social media caption, synopsis, CTA, and viral hashtags."""
    keys = await _get_active_keys()
    if not keys:
        if not settings.gemini_api_key or settings.gemini_api_key == "your_gemini_api_key_here":
            raise RuntimeError("No active Gemini API keys configured. Please add an API key in Settings.")
        keys = [settings.gemini_api_key]

    system_instruction = f"""You are a master viral short-form video director and scriptwriter for TikTok, YouTube Shorts, and Facebook Reels.

Language: {language} (use natural conversational Khmer with standard continuous script and engaging emojis if language is 'km', or English if 'en').

Generate a complete, high-converting Short-Form Video Production Script package matching this exact JSON schema:
{{
  "title": "Movie Title / Topic",
  "total_duration": "~45-50 seconds",
  "tone": "Fast-paced, intense, cinematic, high-energy",
  "bgm_suggestion": "Heavy epic dark cinematic drumbeat / fast wuxia battle music",
  "hook": "Opening viral hook line",
  "synopsis": "Engaging story summary with emojis and highlights",
  "call_to_action": "Engaging CTA for comments, likes, and follows",
  "blocks": [
    {{
      "time_range": "[00:00 - 00:03]",
      "start_time": 0.0,
      "end_time": 3.0,
      "block_name": "THE HOOK",
      "visual": "Description of scene action",
      "text_on_screen": "Punchy on-screen caption text with emojis",
      "sound_effect": "e.g. Whoosh / Blade Clashing SFX / Bass Drop",
      "voiceover": "Spoken voiceover script line",
      "voiceover_tone": "Hyped/Intense/Dramatic"
    }}
  ],
  "titles": [
    "Viral High-CTR Title 1 🗡️",
    "Viral High-CTR Title 2 ⚔️",
    "Viral High-CTR Title 3 😱"
  ],
  "description": "Formatted YouTube Shorts / TikTok description",
  "hashtags": ["#Tag1", "#Tag2", "#Tag3", "#Tag4", "#Tag5"],
  "seo_tags": ["keyword 1", "keyword 2", "keyword 3", "keyword 4"],
  "full_post": "Ready-to-copy social media caption combining hook, synopsis, CTA, and hashtags",
  "full_script_markdown": "Full formatted production script document in markdown"
}}

Output ONLY the raw JSON object."""

    user_content = f"Original Movie Title / Topic: {original_title or 'Movie Recap'}\n\n"
    if transcript_text:
        user_content += f"Subtitles / Dialogue Transcript Content:\n{transcript_text[:7000]}\n"

    models_to_try = [
        settings.gemini_model or "gemini-2.5-flash",
        "gemini-2.5-flash",
        "gemini-flash-latest",
        "gemini-3.6-flash",
        "gemini-flash-lite-latest",
        "gemini-3.7-flash",
    ]
    seen = set()
    models_to_try = [m for m in models_to_try if not (m in seen or seen.add(m))]

    last_err = None
    for api_key in keys:
        for model_name in models_to_try:
            try:
                genai.configure(api_key=api_key)
                model = genai.GenerativeModel(
                    model_name=model_name,
                    system_instruction=system_instruction,
                    generation_config=genai.GenerationConfig(
                        temperature=0.75,
                        response_mime_type="application/json",
                    ),
                )
                response = await asyncio.to_thread(model.generate_content, user_content)
                if response and response.text:
                    text = response.text.strip()
                    if text.startswith("```"):
                        text = re.sub(r"^```(?:json)?\n?", "", text)
                        text = re.sub(r"\n?```$", "", text)
                    data = _safe_json_loads(text)
                    if isinstance(data, dict) and "full_post" in data:
                        return data
            except Exception as e:
                last_err = e
                continue

    if last_err:
        raise RuntimeError(f"Social script generation failed: {last_err}")
    return {}

