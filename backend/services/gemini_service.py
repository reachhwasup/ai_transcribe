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

# Chunking settings for long videos
CHUNK_DURATION = 300   # 5 minutes per chunk
CHUNK_OVERLAP = 30     # 30 second overlap between chunks to avoid boundary gaps
CHUNK_THRESHOLD = 360  # Only chunk videos longer than 6 minutes

# Track which key index we used last for round-robin
_last_key_index = 0


async def _get_active_keys() -> list:
    """Load all active API keys from the database."""
    async with async_session() as db:
        result = await db.execute(
            select(ApiKey.key).where(ApiKey.is_active == True).order_by(ApiKey.created_at)
        )
        return [row[0] for row in result.all()]


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


async def _get_video_duration(video_path: str) -> float:
    """Get video duration in seconds using ffprobe."""
    ffmpeg = shutil.which("ffmpeg")
    ffprobe_path = shutil.which("ffprobe")
    if not ffprobe_path and ffmpeg:
        ffprobe_path = ffmpeg.replace("ffmpeg", "ffprobe")
    if not ffprobe_path:
        ffprobe_path = "ffprobe"
    cmd = [
        ffprobe_path, "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_path,
    ]
    try:
        result = await asyncio.to_thread(
            subprocess.run, cmd, capture_output=True, text=True, timeout=30
        )
        return float(result.stdout.strip())
    except (ValueError, subprocess.TimeoutExpired):
        return 0.0


async def _split_video_chunks(video_path: str, chunk_duration: float = CHUNK_DURATION):
    """Split video into overlapping time-based chunks using ffmpeg.
    Each chunk overlaps by CHUNK_OVERLAP seconds so boundary speech isn't lost.
    Returns list of (chunk_path, start_offset_seconds).
    Caller must clean up the temp directory."""
    duration = await _get_video_duration(video_path)
    if duration <= 0 or duration <= chunk_duration * 1.2:
        # Don't split short videos or if we can't determine duration
        return [(video_path, 0.0)], None

    ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
    tmp_dir = tempfile.mkdtemp(prefix="gemini_chunks_")
    chunks = []
    step = 0.0
    idx = 0
    while step < duration:
        # Each chunk starts CHUNK_OVERLAP seconds before its step (except first)
        extract_start = max(0, step - CHUNK_OVERLAP) if step > 0 else 0.0
        extract_dur = min(chunk_duration + (step - extract_start), duration - extract_start)
        chunk_path = os.path.join(tmp_dir, f"chunk_{idx}.mp4")
        cmd = [
            ffmpeg, "-y",
            "-ss", str(extract_start),
            "-i", video_path,
            "-t", str(extract_dur),
            "-c", "copy",
            "-avoid_negative_ts", "make_zero",
            chunk_path,
        ]
        result = await asyncio.to_thread(
            subprocess.run, cmd, capture_output=True, text=True, timeout=120
        )
        if result.returncode == 0 and os.path.exists(chunk_path):
            chunks.append((chunk_path, extract_start))
        step += chunk_duration
        idx += 1

    if not chunks:
        # Fallback: use original video
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return [(video_path, 0.0)], None

    return chunks, tmp_dir


def _build_prompt(target_language: str = "km") -> str:
    lang_map = {
        "km": "Khmer",
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

    return f"""You are a professional transcription and translation service.

Listen to this video very carefully multiple times if needed.

STEP 1: Identify the language spoken in this video.
STEP 2: If the spoken language IS {lang_name} — write down EXACTLY what each person says, word for word in {lang_name}. This is a verbatim transcription. Do NOT rephrase, summarize, or change any words.
STEP 3: If the spoken language is NOT {lang_name} — you MUST translate every segment into {lang_name}. The "text" field MUST contain the {lang_name} translation, NOT the original language. Do NOT return text in the original language.
  - Translation MUST be natural, fluent {lang_name} — not word-for-word literal translation.
  - Preserve the original meaning, tone, and intent accurately.
  - Use vocabulary and phrasing that native {lang_name} speakers would naturally use in conversation.
  - Keep proper nouns, brand names, and technical terms as-is (or transliterate if standard in {lang_name}).

Return a JSON array of segments:
[
  {{"start_time": 0.5, "end_time": 3.2, "text": "the {lang_name} text here", "speaker": "Speaker 1", "gender": "male", "emotion": "neutral"}}
]

Rules:
- TEXT FIELD: The "text" field must ALWAYS be in {lang_name}. If the video is in another language, translate to natural, fluent {lang_name}.
- VERBATIM: For same-language content, write exactly what is spoken. Every word matters.
- TIMESTAMPS: Precise start/end in seconds. Each segment 2-6 seconds.
- COMPLETE: You MUST transcribe ALL speech from the very beginning (0:00) to the very end of the video. Do not skip any speech, even background dialogue, narration, or overlapping speakers. Every spoken sentence must appear as a segment.
- NO GAPS: Make sure there are no large time gaps between segments where someone is speaking. If speech is continuous, segments should be back-to-back.
- SPEAKERS: Use "Speaker 1", "Speaker 2" etc for different voices.
- GENDER: For each segment, detect the speaker's gender from their voice. Set "gender" to "male" or "female". Listen carefully to pitch and vocal characteristics.
- EMOTION: For each segment, detect the emotional tone of the speech. Set "emotion" to one of: neutral, cheerful, sad, angry, excited, calm, serious, fearful. Listen to the speaker's tone, pitch, and delivery.
- TEXT PURITY: The "text" field must contain ONLY the spoken words. Do NOT prefix text with speaker names, gender labels, or any metadata like "male:", "female:", "Speaker 1:" etc. Those belong in the "speaker" and "gender" fields only.
- JSON ONLY: Return only the JSON array. No markdown, no explanation."""


async def _upload_and_wait(video_path: str, on_progress=None):
    """Upload video to Gemini and wait for processing."""
    video_file = await asyncio.to_thread(genai.upload_file, video_path)

    poll_count = 0
    while video_file.state.name == "PROCESSING":
        poll_count += 1
        await asyncio.sleep(1)
        video_file = await asyncio.to_thread(genai.get_file, video_file.name)

    if video_file.state.name == "FAILED":
        raise Exception("Video processing failed in Gemini API")

    return video_file


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

    # Fix 3: Extract individual JSON objects with regex as last resort
    pattern = r'\{\s*"start_time"\s*:\s*([\d.]+)\s*,\s*"end_time"\s*:\s*([\d.]+)\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}'
    matches = re.findall(pattern, text, re.DOTALL)
    if matches:
        return [{"start_time": float(m[0]), "end_time": float(m[1]), "text": m[2]} for m in matches]

    raise ValueError(f"Could not parse Gemini JSON response: {text[:200]}")


def _parse_segments(text: str) -> list:
    """Parse JSON segments from Gemini response text."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\n?", "", text)
        text = re.sub(r"\n?```$", "", text)

    segments = _safe_json_loads(text)
    cleaned = []
    for i, seg in enumerate(segments):
        # Map gender to voice_profile
        gender = str(seg.get("gender", "")).lower().strip()
        voice_profile = "male" if gender == "male" else "female"

        # Clean text: strip "male:", "female:", "Speaker N:" prefixes Gemini sometimes adds
        seg_text = str(seg.get("text", ""))
        seg_text = re.sub(r"^(?:male|female|speaker\s*\d*)\s*:\s*", "", seg_text, flags=re.IGNORECASE).strip()

        cleaned.append({
            "index": i,
            "start_time": float(seg.get("start_time", 0)),
            "end_time": float(seg.get("end_time", 0)),
            "text": seg_text,
            "speaker": str(seg.get("speaker", f"Speaker {i + 1}")),
            "voice_profile": voice_profile,
        })
    return cleaned


def _build_narration_prompt(language: str = "km", style: str = "summary") -> str:
    """Build a prompt for AI narration/voiceover of a video."""
    lang_map = {
        "km": "Khmer", "en": "English", "zh": "Chinese (Mandarin)",
        "ja": "Japanese", "ko": "Korean", "th": "Thai", "vi": "Vietnamese",
        "fr": "French", "es": "Spanish", "de": "German",
    }
    lang_name = lang_map.get(language, language)

    style_instructions = {
        "summary": f"Write a concise, engaging SUMMARY narration of what happens in this video. Describe the key events, actions, and information clearly. Like a TikTok recap or news summary. The narration should be in {lang_name}.",
        "commentary": f"Write an entertaining COMMENTARY narration for this video, like a TikTok storyteller. Add reactions, opinions, and engaging hooks (e.g. 'Wait for it...', 'You won't believe what happens next...'). The narration should be in {lang_name}.",
        "educational": f"Write an EDUCATIONAL narration explaining what is happening in this video. Break down concepts, provide context, and teach the viewer. Like a documentary narrator. The narration should be in {lang_name}.",
        "story": f"Write a STORYTELLING narration that turns this video into a compelling story. Use narrative structure with a beginning, middle, and end. Add dramatic flair. The narration should be in {lang_name}.",
    }

    style_desc = style_instructions.get(style, style_instructions["summary"])

    return f"""You are a professional video narrator creating voiceover scripts.

Watch this video carefully from beginning to end. Analyze everything: visuals, actions, speech, text on screen, and context.

TASK: {style_desc}

Return a JSON array of narration segments that can be spoken as voiceover:
[
  {{"start_time": 0.0, "end_time": 5.0, "text": "narration text in {lang_name}"}},
  {{"start_time": 5.5, "end_time": 10.0, "text": "next narration segment"}}
]

Rules:
- TEXT must be in {lang_name}. Write natural, fluent {lang_name} that sounds good when spoken aloud.
- Each segment should be 3-8 seconds long (suitable for TTS).
- CRITICAL — TEXT LENGTH: Each segment's text MUST be short enough to speak within its time window. Estimate roughly 2-3 words per second (or 4-6 syllables per second for Asian languages). For a 5-second segment, use at most 12-15 words. Do NOT write long paragraphs in short segments. If you have more to say, split into multiple segments.
- COMPLETE COVERAGE: You MUST narrate the ENTIRE video from the very first second (0:00) to the very last second. Do NOT stop partway through. Every major scene, event, or moment in the video must have narration.
- NO GAPS: Do not leave large sections of the video without narration. If the video is 60 seconds long, your narration segments should span from 0s to 60s. Check the video duration and make sure your last segment's end_time is near the end of the video.
- Timestamps should be precise and not overlap.
- Do NOT just transcribe what people say — write NEW narration ABOUT the video.
- The narration should make sense even without seeing the video (describe what's happening).
- Use engaging, conversational tone appropriate for social media.
- IMPORTANT: Before finishing, verify that your segments cover the full video duration. If the video is long, generate MORE segments. Do not cut short.
- JSON ONLY: Return only the JSON array. No markdown, no explanation."""


async def generate_narration(video_path: str, language: str = "km", style: str = "summary") -> list:
    """
    Upload video to Gemini and generate AI narration/voiceover script.
    Returns a list of narration segments with timestamps and text.
    """
    await _configure_genai()

    video_file = await _upload_and_wait(video_path)
    model = genai.GenerativeModel(settings.gemini_model)
    prompt = _build_narration_prompt(language, style)

    response = await asyncio.to_thread(
        model.generate_content,
        [video_file, prompt],
        generation_config=genai.types.GenerationConfig(
            temperature=0.7,
            response_mime_type="application/json",
            max_output_tokens=65536,
        ),
    )

    try:
        await asyncio.to_thread(genai.delete_file, video_file.name)
    except Exception:
        pass

    # Parse response
    text = response.text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\n?", "", text)
        text = re.sub(r"\n?```$", "", text)

    segments = _safe_json_loads(text)
    cleaned = []
    for i, seg in enumerate(segments):
        seg_text = str(seg.get("text", "")).strip()
        if not seg_text:
            continue
        cleaned.append({
            "index": i,
            "start_time": float(seg.get("start_time", 0)),
            "end_time": float(seg.get("end_time", 0)),
            "text": seg_text,
        })
    return cleaned


async def transcribe_video(video_path: str, language: str = "km") -> list:
    """
    Upload video to Gemini and get full transcription.
    Auto-detects source language and translates to target.
    """
    await _configure_genai()

    video_file = await _upload_and_wait(video_path)
    model = genai.GenerativeModel(settings.gemini_model)
    prompt = _build_prompt(language)

    response = await asyncio.to_thread(
        model.generate_content,
        [video_file, prompt],
        generation_config=genai.types.GenerationConfig(
            temperature=0,
            response_mime_type="application/json",
            max_output_tokens=65536,
        ),
    )
    segments = _parse_segments(response.text)

    try:
        await asyncio.to_thread(genai.delete_file, video_file.name)
    except Exception:
        pass

    return segments


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
    Upload video to Gemini and get transcription segments.
    For long videos (>6 min), splits into ~5-minute chunks and transcribes each
    separately for better coverage. Yields dicts: either {"_progress": "message"}
    for status updates, or segment dicts with start_time/end_time/text/speaker.
    """
    await _configure_genai()

    yield {"_progress": "Analyzing video length..."}

    duration = await _get_video_duration(video_path)
    model = genai.GenerativeModel(settings.gemini_model)
    prompt = _build_prompt(language)

    if duration > CHUNK_THRESHOLD:
        # ---- Long video: split into chunks and transcribe each ----
        num_chunks = int(duration // CHUNK_DURATION) + (1 if duration % CHUNK_DURATION > 0 else 0)
        yield {"_progress": f"Video is {int(duration)}s — splitting into {num_chunks} chunks for full coverage..."}

        chunks, tmp_dir = await _split_video_chunks(video_path)
        all_segments = []

        try:
            for i, (chunk_path, start_offset) in enumerate(chunks):
                yield {"_progress": f"Uploading chunk {i + 1}/{len(chunks)}..."}

                video_file = await asyncio.to_thread(genai.upload_file, chunk_path)

                poll_count = 0
                while video_file.state.name == "PROCESSING":
                    poll_count += 1
                    yield {"_progress": f"Processing chunk {i + 1}/{len(chunks)}... ({poll_count}s)"}
                    await asyncio.sleep(1)
                    video_file = await asyncio.to_thread(genai.get_file, video_file.name)

                if video_file.state.name == "FAILED":
                    yield {"_progress": f"Chunk {i + 1} failed, skipping..."}
                    continue

                yield {"_progress": f"Transcribing chunk {i + 1}/{len(chunks)}..."}

                # Extra instruction for chunks to avoid dropping speech at edges
                chunk_prompt = prompt + (
                    "\n\nCRITICAL: This clip is one part of a longer video. "
                    "You MUST transcribe EVERY spoken word from the VERY FIRST second "
                    "to the VERY LAST second of this clip. Do NOT skip anything at the "
                    "beginning or end. Even partial sentences must be included."
                )

                # Re-configure genai for each chunk in case of key rotation
                await _configure_genai()

                response = await asyncio.to_thread(
                    model.generate_content,
                    [video_file, chunk_prompt],
                    generation_config=genai.types.GenerationConfig(
                        temperature=0,
                        response_mime_type="application/json",
                        max_output_tokens=65536,
                    ),
                )

                try:
                    chunk_segments = _parse_segments(response.text)
                    # Offset timestamps to original video time
                    for seg in chunk_segments:
                        seg["start_time"] = round(seg["start_time"] + start_offset, 2)
                        seg["end_time"] = round(seg["end_time"] + start_offset, 2)
                    print(f"Chunk {i+1}: offset={start_offset}s, got {len(chunk_segments)} segments"
                          f" ({chunk_segments[0]['start_time']:.1f}s - {chunk_segments[-1]['end_time']:.1f}s)" if chunk_segments else f"Chunk {i+1}: 0 segments")
                    all_segments.extend(chunk_segments)
                except Exception as e:
                    print(f"Failed to parse chunk {i + 1}: {e}")

                # Cleanup uploaded file
                try:
                    await asyncio.to_thread(genai.delete_file, video_file.name)
                except Exception:
                    pass

            # Sort by start_time and deduplicate overlapping segments
            all_segments.sort(key=lambda s: s["start_time"])
            deduped = _deduplicate_chunk_segments(all_segments)

            print(f"Chunked transcription: {len(all_segments)} total -> {len(deduped)} after dedup")
            yield {"_progress": f"Processed {len(deduped)} segments from {len(chunks)} chunks"}

            for seg in deduped:
                yield seg

        finally:
            # Cleanup temp chunk files
            if tmp_dir and os.path.isdir(tmp_dir):
                shutil.rmtree(tmp_dir, ignore_errors=True)

    else:
        # ---- Short video: transcribe in one shot ----
        yield {"_progress": "Uploading video to Gemini..."}

        video_file = await asyncio.to_thread(genai.upload_file, video_path)

        poll_count = 0
        while video_file.state.name == "PROCESSING":
            poll_count += 1
            yield {"_progress": f"AI is processing video... ({poll_count}s)"}
            await asyncio.sleep(1)
            video_file = await asyncio.to_thread(genai.get_file, video_file.name)

        if video_file.state.name == "FAILED":
            raise Exception("Video processing failed in Gemini API")

        yield {"_progress": "AI is transcribing... this may take a moment"}

        response = await asyncio.to_thread(
            model.generate_content,
            [video_file, prompt],
            generation_config=genai.types.GenerationConfig(
                temperature=0,
                response_mime_type="application/json",
                max_output_tokens=65536,
            ),
        )

        yield {"_progress": "Processing results..."}

        try:
            segments = _parse_segments(response.text)
        except Exception:
            segments = []

        for seg in segments:
            yield seg

        try:
            await asyncio.to_thread(genai.delete_file, video_file.name)
        except Exception:
            pass


def _deduplicate_chunk_segments(segments: list) -> list:
    """Remove duplicate segments that may appear at chunk boundary overlaps.
    Segments are considered duplicates if they overlap significantly in time
    or have very close start times."""
    if not segments:
        return []

    result = [segments[0]]
    for seg in segments[1:]:
        prev = result[-1]
        # Check if this segment overlaps significantly with the previous one
        overlap_start = max(prev["start_time"], seg["start_time"])
        overlap_end = min(prev["end_time"], seg["end_time"])
        overlap = max(0, overlap_end - overlap_start)
        seg_duration = seg["end_time"] - seg["start_time"]
        prev_duration = prev["end_time"] - prev["start_time"]

        # Skip if >40% overlap relative to either segment
        if seg_duration > 0 and overlap / seg_duration > 0.4:
            continue
        if prev_duration > 0 and overlap / prev_duration > 0.4:
            continue
        # Skip if start times are very close (within 1.0s) — likely same utterance
        if abs(seg["start_time"] - prev["start_time"]) < 1.0:
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


async def translate_segments(segments: list, target_language: str = "en") -> list:
    """Translate all segment texts to the target language using Gemini in one batch call."""
    if not segments:
        return segments

    lang_map = {
        "km": "Khmer",
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
    model = genai.GenerativeModel(settings.gemini_model)

    # Build a batch translation prompt
    texts = [seg["text"] for seg in segments]
    numbered = "\n".join(f"{i+1}. {t}" for i, t in enumerate(texts))

    prompt = f"""You are a professional subtitle translator. These are video subtitle lines that need to be translated to {lang_name}.

Translation rules:
- Produce natural, fluent {lang_name} — NOT word-for-word literal translation.
- Preserve the original meaning, tone, and intent of each line accurately.
- Use vocabulary and phrasing that native {lang_name} speakers would naturally use.
- Keep proper nouns, brand names, and technical terms as-is (or transliterate if standard in {lang_name}).
- Each translated line should be concise and suitable for subtitles.
- The lines are sequential dialogue from a video — use surrounding lines as context for better translation.

Return a JSON array of {len(texts)} strings where each element is the translated text for the corresponding line.
Return ONLY the JSON array, no markdown, no explanation.

{numbered}"""

    response = await asyncio.to_thread(
        model.generate_content,
        prompt,
        generation_config=genai.types.GenerationConfig(
            temperature=0,
            response_mime_type="application/json",
        ),
    )

    raw = response.text.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\n?", "", raw)
        raw = re.sub(r"\n?```$", "", raw)

    translated = json.loads(raw)

    result = []
    for i, seg in enumerate(segments):
        new_seg = dict(seg)
        if i < len(translated):
            new_seg["text"] = str(translated[i])
        result.append(new_seg)

    return result
