import os
import re
import asyncio
import shutil
import subprocess
import tempfile
import uuid
from collections import OrderedDict
from typing import AsyncGenerator
import google.generativeai as genai
from backend.services.gemini_client import CHUNK_DURATION, CHUNK_OVERLAP, CHUNK_THRESHOLD, MAX_PARALLEL_CHUNKS, _build_media_proxy_for_gemini, _configure_genai, _generate_with_fallback, _get_video_duration, _split_video_chunks, _transcribe_media_with_fallback, GeminiBlocked, GeminiTruncated
from backend.services.transcript_cleanup import _clean_khmer_spacing, _safe_json_loads


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
   - Output the exact verbatim spoken dialogue in the native spoken language of the audio."""
    elif target_language == "km":
        target_inst = """2. "text" — CINEMATIC CAMBODIAN KHMER DUBBING & SUBTITLE LOCALIZATION (ភាសាខ្មែរ / អក្សរខ្មែរ):
   - Translate the spoken dialogue into natural, expressive, cinematic spoken Cambodian Khmer (ភាសានិយាយភាពយន្ត / សម្រាយរឿង / ភាពយន្តភាគ).
   - Use authentic contextual pronouns (បង/អូន, ឯង/យើង, លោកយាយ/លោកតា, ព្រះអង្គ/លោកម្ចាស់, ខ្ញុំ/លោក).
   - Write 100% EXCLUSIVELY in authentic CAMBODIAN KHMER SCRIPT (អក្សរខ្មែរ). NEVER mix Chinese Hanzi, Thai script, or English letters in "text".
   - Use correct Khmer spelling and natural conversational cadence without robotic phrasing."""
    else:
        target_inst = f"""2. "text" — NATURAL {lang_name.upper()} LOCALIZATION:
   - Translate and adapt the dialogue into natural, expressive, cinematic spoken {lang_name}."""

    return f"""You are a master film speech transcriber, multilingual recognizer, character diarization expert, and subtitle localization engine.

Listen to the audio carefully through background music, sound effects, action sounds, and ambient noise.

CRITICAL RULES:
1. READABLE SUBTITLE LINES:
   - Each segment is one subtitle line the viewer must be able to READ: aim for 2.0s to 5.0s.
   - HARD LIMIT: at most 80 characters per segment. A Khmer viewer reads about 16 characters a
     second, so 80 characters already fills 5 seconds. A longer line cannot be read in time and
     cannot be dubbed without the voice racing.
   - NEVER put more than ONE sentence in a segment. If the speaker says several sentences in a
     row, emit one segment per sentence, each with its own start_time and end_time.
   - Keep one speaker per segment, and never span a change of speaker.
   - Split any speech that runs longer than about 5 seconds into consecutive segments.

2. "original_text" — VERBATIM SPOKEN DIALOGUE (NATIVE SCRIPT):
   - Transcribe the EXACT spoken words in native script (e.g. Chinese Hanzi "唐兄，好久不见！" or English "Hey John, long time no see!").
   - NEVER leave "original_text" blank.

{target_inst}

3. CHARACTER NAME IDENTIFICATION & VOICE ARCHETYPES:
   - Listen carefully to character names spoken in dialogue, and reuse the SAME name for that character every time they speak.
   - NEVER output placeholder labels such as "Unnamed", "Unknown", "Speaker", "Character" or "?".
   - If a character's name is never said, label them by who they are in the scene, consistently:
     e.g. "Narrator", "Young Man", "Older Woman", "Guard", "Waitress" — never a placeholder.
   - Classify each voice from the audible speech, not the character name or dialogue text. Keep the profile consistent for the same speaker.
   - Assign exact "voice_profile": "female", "male", "grandma", "grandpa", "child_boy", "child_girl".
   - Tag authentic "emotion": "neutral", "angry", "happy", "sad", "crying", "laughing", "fearful", "excited", "surprised", "serious", "calm", "whisper", "scream".
   - Infer emotion from audible delivery, not merely words: a calm threat stays calm; a question is not automatically fearful. Use neutral when uncertain.
   - Preserve natural punctuation and pauses in the translated dialogue for clear pronunciation. Keep character names spelled consistently and put performance directions only in the emotion field, never in spoken text.

4. EXACT TIGHT AUDIO-SYNCHRONIZED TIMESTAMPS:
   - "start_time" MUST match the EXACT second where the speaker begins vocalizing the first audible phoneme or word. DO NOT start early before the character speaks.
   - "end_time" MUST match the EXACT second where the speaker STOPS vocalizing that line (typically 2.0s to 5.0s duration).
   - CRITICAL: NEVER extend "end_time" across silent pauses, action/fight sequences, or background music until the next line. If a character speaks from 10.0s to 12.5s and the next line is at 30.0s, end_time MUST be 12.5s (NOT 30.0s).

5. 100% COMPLETE & EXHAUSTIVE COVERAGE:
   - Transcribe EVERY SINGLE spoken utterance from 0.0s to the very end of the media without skipping any line.

6. STRICTLY IGNORE & NEVER TRANSCRIBE BACKGROUND MUSIC OR SOUND EFFECTS:
   - NEVER transcribe background music, soundtrack, or ambient noise (e.g. NEVER output "[Music]", "[ភ្លេង]", "[តន្ត្រី]", "🎵").
   - ONLY transcribe genuine human dialogue.

Return a JSON array of subtitle segment objects:
[
  {{"start_time": 0.0, "end_time": 2.2, "original_text": "唐兄，好久不见！", "text": "បងថាង! មិនបានជួបគ្នាយូរហើយ!", "speaker": "Autumn Fragrance", "gender": "female", "voice_profile": "female", "emotion": "happy"}},
  {{"start_time": 2.4, "end_time": 4.5, "original_text": "秋香，别来无恙吧？", "text": "ឈីវស៊ាង! នាងសុខសប្បាយជាទេ?", "speaker": "Tang Bohu", "gender": "male", "voice_profile": "male", "emotion": "cheerful"}}
]

Rules:
- CONTINUOUS SECONDS: start_time and end_time MUST be numbers in seconds (e.g. 5.2, 62.5, 78.0).
- NO PREFIXES: Neither "original_text" nor "text" should contain speaker prefixes like "Speaker:".
- JSON ONLY: Return ONLY the raw JSON array. No markdown, no explanations."""


TRANSCRIBE_ATTEMPTS = 3
MIN_SPLIT_SECONDS = 75.0  # a blocked/truncated span is halved until pieces are this short
SPLIT_OVERLAP = 2.0

_CHUNK_TIMING_NOTE = (
    "\n\nCRITICAL MANDATE FOR TIME ALIGNMENT:\n"
    "- This audio starts at exact time 0.0s relative to this clip.\n"
    "- You MUST accurately measure any music, pause, or silence before speaking begins.\n"
    "- Do NOT start the first segment at 0.0s unless speaking literally starts at the very first millisecond.\n"
    "- Output readable 2.0 to 5.0 second segments, at most 80 characters and ONE sentence each, "
    "with exact timestamps matching the speech."
)


def _fmt_clock(seconds: float) -> str:
    seconds = int(max(0, seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _filter_boundary_duplicates(existing_segments: list, new_segments: list) -> list:
    """Drop segments from new_segments that repeat the tail of existing_segments (overlap regions)."""
    if not existing_segments:
        return new_segments
    clean_new = []
    for n_seg in new_segments:
        n_start = n_seg.get("start_time", 0.0)
        n_end = n_seg.get("end_time", 0.0)
        n_text = str(n_seg.get("text", "")).strip()
        n_orig = str(n_seg.get("original_text", "")).strip()
        if not n_text and not n_orig:
            continue
        is_dup = False
        for ex_seg in reversed(existing_segments[-40:]):
            ex_start = ex_seg.get("start_time", 0.0)
            ex_end = ex_seg.get("end_time", 0.0)
            ex_text = str(ex_seg.get("text", "")).strip()
            ex_orig = str(ex_seg.get("original_text", "")).strip()
            time_diff = abs(n_start - ex_start)
            if time_diff > (CHUNK_OVERLAP + 4.0):
                continue
            ov_len = max(0.0, min(n_end, ex_end) - max(n_start, ex_start))
            overlap_ratio = ov_len / max(0.2, min(n_end - n_start, ex_end - ex_start))
            if n_text and ex_text and (n_text == ex_text or n_text in ex_text or ex_text in n_text):
                is_dup = True
            elif n_orig and ex_orig and (n_orig == ex_orig or n_orig in ex_orig or ex_orig in n_orig):
                is_dup = True
            elif overlap_ratio > 0.5 or (time_diff < 0.8 and overlap_ratio > 0.3):
                is_dup = True
            if is_dup:
                break
        if not is_dup:
            clean_new.append(n_seg)
    return clean_new


async def _cut_audio(src: str, start: float, length: float, tmp_dir: str) -> str:
    out = os.path.join(tmp_dir, f"span_{uuid.uuid4().hex}.mp3")
    cmd = [shutil.which("ffmpeg") or "ffmpeg", "-y", "-ss", f"{start:.3f}", "-i", src, "-t", f"{length:.3f}",
           "-vn", "-c:a", "libmp3lame", "-ar", "16000", "-ac", "1", "-b:a", "64k", out]
    r = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True, timeout=300)
    if r.returncode != 0 or not os.path.exists(out):
        raise RuntimeError(f"audio cut failed: {r.stderr[-200:]}")
    return out


async def _transcribe_span(path: str, offset: float, duration: float, prompt: str, tmp_dir: str, failed: list) -> list:
    """Transcribe one audio file whose time 0 is `offset` in the video.
    Content blocks and truncated responses are retried by halving the span, so one bad scene
    only loses a short stretch. Spans that still fail are appended to `failed` and skipped."""
    last_err: Exception | None = None
    for attempt in range(TRANSCRIBE_ATTEMPTS):
        try:
            segs = await _transcribe_media_with_fallback(path, prompt)
        except (GeminiBlocked, GeminiTruncated) as e:
            if duration / 2 >= MIN_SPLIT_SECONDS:
                half = duration / 2
                print(f"[transcribe] {_fmt_clock(offset)}+{duration:.0f}s {e}; splitting in half", flush=True)
                first = await _cut_audio(path, 0, half, tmp_dir)
                second = await _cut_audio(path, half - SPLIT_OVERLAP, duration - half + SPLIT_OVERLAP, tmp_dir)
                a = await _transcribe_span(first, offset, half, prompt, tmp_dir, failed)
                b = await _transcribe_span(second, offset + half - SPLIT_OVERLAP, duration - half + SPLIT_OVERLAP, prompt, tmp_dir, failed)
                return a + _filter_boundary_duplicates(a, b)
            partial = e.segments if isinstance(e, GeminiTruncated) else []
            failed.append((offset, offset + duration, str(e)))
            segs = partial
        except Exception as e:
            last_err = e
            quota = any(x in str(e).lower() for x in ["429", "quota", "exhausted"])
            if attempt + 1 < TRANSCRIBE_ATTEMPTS:
                await asyncio.sleep((10.0 if quota else 3.0) * (attempt + 1))
            continue
        for seg in segs:
            seg["start_time"] = round(seg["start_time"] + offset, 2)
            seg["end_time"] = round(seg["end_time"] + offset, 2)
        return segs

    reason = str(last_err)
    if any(x in reason.lower() for x in ["429", "quota", "exhausted"]):
        reason = "Gemini quota exceeded"
    failed.append((offset, offset + duration, reason[:120]))
    return []


def _missing_ranges_warning(failed: list) -> str | None:
    if not failed:
        return None
    parts = [f"{_fmt_clock(a)}–{_fmt_clock(b)} ({why})" for a, b, why in sorted(failed)]
    return "Some parts could not be transcribed: " + "; ".join(parts) + ". Use Fill gaps to retry them."


async def transcribe_video(video_path: str, language: str = "km", shared_glossary: str = "") -> list:
    """Transcribe a (short) video or clip in one pass; blocked scenes are split and skipped."""
    media_path, tmp_dir = await _build_media_proxy_for_gemini(video_path)
    work_dir = tempfile.mkdtemp(prefix="gemini_spans_")
    try:
        duration = await _get_video_duration(media_path)
        failed: list = []
        segments = await _transcribe_span(media_path, 0.0, duration, _build_prompt(language) + shared_glossary, work_dir, failed)
        if failed and not segments:
            raise RuntimeError(_missing_ranges_warning(failed))
        return segments
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
        if tmp_dir and os.path.exists(tmp_dir):
            shutil.rmtree(tmp_dir, ignore_errors=True)


async def transcribe_video_streaming(video_path: str, language: str = "km", on_progress=None, shared_glossary: str = "") -> AsyncGenerator:
    """
    Transcribe a video's audio with Gemini.
    Long videos are split into CHUNK_DURATION parts (with CHUNK_OVERLAP lead-in) transcribed in
    parallel; each part's segments stream out as soon as every earlier part is done. A part that
    fails is skipped rather than aborting the whole run, and a final {"_warning": ...} item lists
    the missing time ranges.
    Yields {"_progress": ...}, segment dicts, and at most one {"_warning": ...}.
    """
    yield {"_progress": "Analyzing video audio timeline...", "percent": 3}
    await _configure_genai()

    duration = await _get_video_duration(video_path)
    prompt = _build_prompt(language) + shared_glossary
    long_video = duration > CHUNK_THRESHOLD
    if long_video:
        prompt += _CHUNK_TIMING_NOTE
        n = int(duration // CHUNK_DURATION) + (1 if duration % CHUNK_DURATION > 0 else 0)
        yield {"_progress": f"Video is {_fmt_clock(duration)} — transcribing {n} parts...", "current_chunk": 0, "total_chunks": n, "percent": 5}
    else:
        yield {"_progress": "Preparing audio for speech recognition...", "current_chunk": 0, "total_chunks": 1, "percent": 5}

    chunks, tmp_dir = await _split_video_chunks(video_path)
    work_dir = tempfile.mkdtemp(prefix="gemini_spans_")
    failed: list = []
    total_c = len(chunks)
    sem = asyncio.Semaphore(MAX_PARALLEL_CHUNKS)

    async def _run(i: int, path: str, offset: float) -> tuple[int, list]:
        async with sem:
            length = await _get_video_duration(path) or (duration - offset)
            segs = await _transcribe_span(path, offset, length, prompt, work_dir, failed)
            print(f"[transcribe] Part {i + 1}/{total_c} @ {_fmt_clock(offset)} -> {len(segs)} segments", flush=True)
            return i, segs

    tasks = [asyncio.create_task(_run(i, p, off)) for i, (p, off) in enumerate(chunks)]
    try:
        yield {"_progress": f"Transcribing {total_c} part(s), up to {MAX_PARALLEL_CHUNKS} at once...",
               "current_chunk": 0, "total_chunks": total_c, "percent": 8}
        results: list[list | None] = [None] * total_c
        next_to_emit = 0
        emitted: list = []
        completed = 0
        pending = set(tasks)
        started_at = asyncio.get_running_loop().time()
        while pending:
            done, pending = await asyncio.wait(pending, timeout=10, return_when=asyncio.FIRST_COMPLETED)
            if not done:
                elapsed = int(asyncio.get_running_loop().time() - started_at)
                yield {"_progress": f"Waiting for AI speech recognition ({elapsed}s elapsed); {completed}/{total_c} parts processed...",
                       "current_chunk": completed, "total_chunks": total_c,
                       "percent": round(8 + (completed / total_c) * 88)}
                continue
            for task in done:
                idx, segs = task.result()
                results[idx] = segs
                completed += 1
            yield {"_progress": f"Processed {completed}/{total_c} parts; saving captions...", "current_chunk": completed,
                   "total_chunks": total_c, "percent": round(8 + (completed / total_c) * 88)}
            while next_to_emit < total_c and results[next_to_emit] is not None:
                clean = _filter_boundary_duplicates(emitted, results[next_to_emit])
                emitted.extend(clean)
                results[next_to_emit] = []
                next_to_emit += 1
                for seg in clean:
                    yield seg

        if not emitted and failed:
            raise RuntimeError(_missing_ranges_warning(failed))
        yield {"_progress": f"Finalizing {len(emitted)} caption lines...", "current_chunk": total_c,
               "total_chunks": total_c, "percent": 99}
        warning = _missing_ranges_warning(failed)
        if warning:
            yield {"_warning": warning}
    finally:
        # On failure or client disconnect, stop remaining parts from burning API quota
        for t in tasks:
            if not t.done():
                t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        shutil.rmtree(work_dir, ignore_errors=True)
        if tmp_dir and os.path.isdir(tmp_dir):
            shutil.rmtree(tmp_dir, ignore_errors=True)


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


# Khmer dubbing runs at about this many characters a second; a translation longer than its
# slot allows has to be sped up, or runs into the next line.
DUB_CHARS_PER_SECOND = 16.0
CONTEXT_BEFORE = 4            # earlier lines shown to the translator for continuity
CONTEXT_AFTER = 2
GLOSSARY_MIN_LINES = 12       # below this the lines themselves are context enough
GLOSSARY_MAX_CHARS = 60000    # dialogue sent to build the glossary
_MALE_PROFILES = {"male", "grandpa", "child_boy"}
_PROFILE_WORDS = {
    "male": "man", "female": "woman", "grandpa": "old man", "grandma": "old woman",
    "child_boy": "boy", "child_girl": "girl", "child": "child",
}


def _source_text(seg: dict) -> str:
    return (seg.get("original_text") or seg.get("text") or "").strip()


def _line_label(seg: dict, with_gender: bool) -> str:
    parts = [p for p in ((seg.get("speaker") or "").strip(),
                         _PROFILE_WORDS.get((seg.get("voice_profile") or "").lower(), "") if with_gender else "") if p]
    return f"[{', '.join(parts)}]: " if parts else ""


def _time_budget(seg: dict, target: str) -> str:
    try:
        seconds = float(seg.get("end_time")) - float(seg.get("start_time"))
    except (TypeError, ValueError):
        return ""
    if seconds <= 0.2:
        return ""
    if target == "km":
        return f"({seconds:.1f}s, about {max(12, int(seconds * DUB_CHARS_PER_SECOND))} characters) "
    return f"({seconds:.1f}s) "


def _context_block(title: str, lines: list, with_gender: bool) -> str:
    """Neighbouring lines, with the translation they already have when there is one."""
    rows = []
    for seg in lines or []:
        source = _source_text(seg)
        if not source:
            continue
        done = (seg.get("translation") or "").strip()
        rows.append(f"- {_line_label(seg, with_gender)}{source}" + (f"  =>  {done}" if done and done != source else ""))
    return f"\n{title}\n" + "\n".join(rows) + "\n" if rows else ""


def _build_translation_prompt(
    chunk_segs: list,
    target_language: str,
    lang_name: str,
    glossary: str = "",
    before: list | None = None,
    after: list | None = None,
    with_gender: bool = False,
) -> str:
    target = "km" if target_language in ("km", "auto", "") else target_language
    numbered = "\n".join(
        f"{i + 1}. {_time_budget(seg, target)}{_line_label(seg, with_gender)}{_source_text(seg)}"
        for i, seg in enumerate(chunk_segs)
    )
    context = (
        _context_block("EARLIER LINES — for understanding only, do not translate or return them:", before, with_gender)
        + _context_block("LINES THAT FOLLOW — for understanding only, do not translate or return them:", after, with_gender)
    )
    if context:
        context += ('Where an earlier line shows "source  =>  translation", keep names, pronouns and tone '
                    "consistent with that translation.\n")
    glossary_block = (
        f"\nGLOSSARY AND CHARACTER NOTES — use these renderings exactly, every time:\n{glossary}\n" if glossary else ""
    )
    gender_rule = (
        "\n   - The label after a speaker (man, woman, boy…) is the voice that was heard. Let it decide "
        "gendered words; if the dialogue plainly contradicts it, trust the dialogue."
        if with_gender else ""
    )

    if target == "km":
        return f"""You are a master cinematic subtitle and movie dubbing translator specializing in Cambodian Khmer (ភាសាខ្មែរ).
Translate the following sequential video dialogue lines into natural, fluent spoken Khmer dialogue.
These are existing subtitle cues: a sentence may continue across several cues. Read them together
to understand the sentence, but return each cue separately with its own meaning and index.
Do not turn dialogue into narration, add explanations, invent relationships, or move meaning between cues.

CRITICAL LOCALIZATION & TRANSLATION RULES:
1. NATURAL SPOKEN KHMER (ភាសាខ្មែរ):
   - Translate into rich, natural spoken Cambodian Khmer suited for video dubbing, movie subtitles, and storytelling.
   - Accurately capture emotional nuances, dramatic tension, jokes, sarcasm, and character personality.
   - Write 100% EXCLUSIVELY in Cambodian Khmer script (អក្សរខ្មែរ). NEVER output Chinese characters (中文), Thai script (ภาษาไทย), or English in the dialogue.
   - Ensure correct Khmer orthography, vowel placement, and continuous script without broken syllables.

2. CHARACTER NAMES & SPEAKER TRANSLATION:
   - Localize all speaker and character names into Cambodian Khmer pronunciation (e.g. 唐伯虎 -> តាំង ប៉ូហ៊ូ, 秋香 -> ឈីវស៊ាង, 华夫人 -> លោកស្រី ហួ, 石榴姐 -> អ្នកបង ស៊ីលៀវ).
   - A name is spelled the same way every time it appears. When a glossary is given, its spelling is the one to use.
   - NEVER output Chinese characters for speaker names.
   - DO NOT include speaker name prefixes in the "text" field.

3. CONTEXTUAL PRONOUNS:
   - Use natural Khmer dialogue pronouns: បង/អូន (couples), ឯង/យើង (friends), ខ្ញុំ/លោក (polite), ឯង/អញ (rivals/enemies).
   - A man answers បាទ and a woman ចាស; keep each character's way of speaking the same from line to line.{gender_rule}

4. FIT THE TIME — THESE LINES WILL BE SPOKEN:
   - Each line starts with how long the character speaks and roughly how many Khmer characters fit in that time.
   - Stay within that length: choose the shorter natural phrasing and drop filler words. Never pad a short line.
   - Meaning comes first. If a line cannot be said that briefly without losing what matters, go a little over rather than cut the meaning.
{glossary_block}{context}
Return a JSON array of objects:
[
  {{"index": 1, "speaker": "Character name in Khmer (e.g. តាំង ប៉ូហ៊ូ)", "text": "Translated Khmer dialogue ONLY"}}
]
matching all {len(chunk_segs)} lines in exact order.
Return ONLY valid JSON array without markdown formatting.

Lines to translate:
{numbered}"""
    return f"""You are a master video subtitle and film dialogue translator. Translate the following sequential dialogue lines into natural, fluent {lang_name}.

Translation rules:
- Produce natural, fluent {lang_name} dialogue suited for cinematic subtitles and dubbing — NOT literal word-for-word machine translation.
- Accurately preserve the original meaning, character emotion, and dramatic context.
- Use vocabulary and phrasing that native {lang_name} speakers naturally use in films and videos.
- Spell each name the same way every time. When a glossary is given, use its spelling.{gender_rule}
- DO NOT include speaker name prefixes in your translated "text" output.
- Each line starts with how long it is on screen. Keep the translation short enough to be read or spoken in that time.
{glossary_block}{context}
- Return a JSON array of objects: [{{"index": 1, "speaker": "Character Name", "text": "translated dialogue"}}, ...] matching all {len(chunk_segs)} lines.
Return ONLY valid JSON array without markdown formatting.

Lines to translate:
{numbered}"""


TRANSLATION_LANGUAGES = {
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
TRANSLATE_CHUNK_SIZE = 30
MAX_PARALLEL_TRANSLATIONS = 3
TRANSLATE_ATTEMPTS = 2
_TRANSLATION_CACHE_MAX = 500  # chunks

# (target, prompt) -> [{"text", "speaker"}, ...]; repeat exports reuse it
_translation_cache: OrderedDict = OrderedDict()
_glossary_cache: OrderedDict = OrderedDict()


def _effective_target(target_language: str) -> str:
    return "km" if target_language in ("km", "auto", "") else target_language


def _clean_translation(item: dict, target: str) -> dict:
    text = item.get("text") or ""
    speaker = item.get("speaker") or ""
    if target == "km":
        # A mixed-language answer is incomplete, not text to repair by deleting words.
        # Leave it pending so the caller retries it without losing source meaning.
        if any(char.isalpha() and not "\u1780" <= char <= "\u17ff" for char in text):
            return {"text": "", "speaker": ""}
        text = _clean_khmer_spacing(text.strip())
        if re.search(r'[一-鿿]', speaker):
            speaker = ""
    return {"text": text, "speaker": speaker}


def _glossary_text(parsed) -> str:
    """The model's glossary as the plain lines that go into each translation prompt."""
    if not isinstance(parsed, dict):
        return ""
    rows = []
    for term in (parsed.get("terms") or [])[:80]:
        if isinstance(term, dict):
            source, rendered = str(term.get("source") or "").strip(), str(term.get("target") or "").strip()
            if source and rendered and source != rendered:
                rows.append(f"{source} = {rendered}")
    notes = str(parsed.get("notes") or "").strip()
    if notes:
        rows.append(f"Notes: {notes[:1200]}")
    return "\n".join(rows)


async def _build_glossary(lines: list, target: str) -> str:
    """One pass over the whole dialogue to fix how names are written and who everyone is.

    The lines are translated thirty at a time, and each batch used to choose
    its own spelling for a name and its own guess at who was speaking to whom. Deciding that
    once, up front, is what keeps a character's name and manner the same across the video.
    Returns "" when it cannot be built; translation then carries on without it.
    """
    with_gender = len({(s.get("voice_profile") or "").lower() in _MALE_PROFILES for s in lines}) > 1
    dialogue = [f"{_line_label(seg, with_gender)}{_source_text(seg)}" for seg in lines if _source_text(seg)]
    if len(dialogue) < GLOSSARY_MIN_LINES:
        return ""
    text = "\n".join(dialogue)
    if len(text) > GLOSSARY_MAX_CHARS:
        # a long film: sample evenly, the cast is the same throughout
        step = len(text) / GLOSSARY_MAX_CHARS
        text = "\n".join(dialogue[int(i * step)] for i in range(int(len(dialogue) / step)))
    key = (target, text)
    if key in _glossary_cache:
        _glossary_cache.move_to_end(key)
        return _glossary_cache[key]

    lang_name = TRANSLATION_LANGUAGES.get(target, target)
    prompt = f"""You are preparing a film's dialogue for translation into {lang_name}.
Read the dialogue below and return a JSON object:
{{
  "terms": [{{"source": "name or term exactly as written in the dialogue", "target": "the one {lang_name} rendering to use every time"}}],
  "notes": "two to five short sentences: who the main characters are, whether each is a man or a woman, and how they relate (family, rank, lovers, rivals) — whatever decides the pronouns and forms of address between them"
}}
Include every character name, nickname, title, place and recurring special term (at most 60). Do not include ordinary words.
Only state genders and relationships supported by the dialogue; leave uncertain ones unknown.
Write "target" and "notes" for a translator working into {lang_name}{"; render names in Khmer script by their sound" if target == "km" else ""}.
Return ONLY the JSON object.

Dialogue:
{text}"""
    glossary = ""
    try:
        response = await _generate_with_fallback(
            prompt,
            generation_config=genai.types.GenerationConfig(temperature=0.1, response_mime_type="application/json"),
        )
        glossary = _glossary_text(_safe_json_loads(response.text.strip()))
    except Exception as e:
        print(f"[translate] glossary skipped: {e}", flush=True)
    if glossary:
        _glossary_cache[key] = glossary
        if len(_glossary_cache) > 50:
            _glossary_cache.popitem(last=False)
    return glossary


async def _translate_chunk(
    chunk_segs: list,
    target: str,
    glossary: str = "",
    before: list | None = None,
    after: list | None = None,
    with_gender: bool = False,
) -> list[dict]:
    """Translate one chunk with retries. Returns one {"text", "speaker"} per line;
    text is "" for lines Gemini did not translate."""
    lang_name = TRANSLATION_LANGUAGES.get(target, target)

    def prompt_for(segs):
        return _build_translation_prompt(segs, target, lang_name, glossary, before, after, with_gender)

    key = (target, prompt_for(chunk_segs))
    if key in _translation_cache:
        _translation_cache.move_to_end(key)
        return _translation_cache[key]

    out = [{"text": "", "speaker": ""} for _ in chunk_segs]
    pending = list(range(len(chunk_segs)))
    for attempt in range(TRANSLATE_ATTEMPTS):
        try:
            # a retry asks only for the lines that are still missing
            response = await _generate_with_fallback(
                prompt_for([chunk_segs[i] for i in pending]),
                generation_config=genai.types.GenerationConfig(
                    temperature=0.2,
                    response_mime_type="application/json",
                ),
            )
            raw = response.text.strip()
            if raw.startswith("```"):
                raw = re.sub(r"^```(?:json)?\n?", "", raw)
                raw = re.sub(r"\n?```$", "", raw)
            extracted = _extract_translated_list(_safe_json_loads(raw), len(pending))
            for i, item in zip(pending, extracted):
                if item and item.get("text"):
                    out[i] = _clean_translation(item, target)
            pending = [i for i in pending if not out[i]["text"]]
            if not pending:
                break
        except Exception as e:
            print(f"[translate] chunk attempt {attempt + 1} failed: {e}", flush=True)

    if not pending:
        _translation_cache[key] = out
        if len(_translation_cache) > _TRANSLATION_CACHE_MAX:
            _translation_cache.popitem(last=False)
    return out


async def _iter_translated_chunks(segments: list, target: str, context: list | None = None, shared_glossary: str = ""):
    """Translate chunks in sequence so earlier translations inform subsequent dialogue.

    `context` is the whole dialogue in order (the lines being translated may be only some of
    it). It supplies the glossary and the lines either side of each chunk."""
    await _configure_genai()
    story = [dict(s) for s in (context or segments)]
    # The heard voice is only worth telling the translator when it was actually detected:
    # an imported subtitle file leaves every line on the same default.
    with_gender = len({(s.get("voice_profile") or "").lower() in _MALE_PROFILES for s in story}) > 1
    glossary = (await _build_glossary(story, target)) + shared_glossary
    position = {s.get("id"): i for i, s in enumerate(story) if s.get("id")}
    def _around(chunk, start):
        first, last = position.get(chunk[0].get("id")), position.get(chunk[-1].get("id"))
        if first is None or last is None:
            if context:
                return [], []
            first, last = start, start + len(chunk) - 1
        return story[max(0, first - CONTEXT_BEFORE):first], story[last + 1:last + 1 + CONTEXT_AFTER]

    for start in range(0, len(segments), TRANSLATE_CHUNK_SIZE):
        chunk = segments[start:start + TRANSLATE_CHUNK_SIZE]
        before, after = _around(chunk, start)
        translated = await _translate_chunk(chunk, target, glossary, before, after, with_gender)
        for offset, (seg, result) in enumerate(zip(chunk, translated)):
            at = position.get(seg.get("id"))
            if at is None and not context:
                at = start + offset
            if at is not None and result["text"]:
                story[at]["translation"] = result["text"]
        yield start, chunk, translated


async def translate_segments(segments: list, target_language: str = "km", context: list | None = None, shared_glossary: str = "") -> list:
    """Translate all subtitle segments; lines that fail keep their original text."""
    if not segments:
        return []
    target = _effective_target(target_language)
    result = []
    async for _, chunk_segs, translated in _iter_translated_chunks(segments, target, context, shared_glossary):
        for seg, t in zip(chunk_segs, translated):
            new_seg = dict(seg)
            if t["text"]:
                new_seg["text"] = t["text"]
                if t["speaker"]:
                    new_seg["speaker"] = t["speaker"]
            result.append(new_seg)
    return result


async def translate_segments_stream(segments: list, target_language: str = "km", context: list | None = None, shared_glossary: str = ""):
    """Yield one progress item per segment as chunks finish (in order).
    Failed lines have text "" and failed=True so callers don't overwrite them."""
    if not segments:
        return
    target = _effective_target(target_language)
    total = len(segments)
    processed = 0
    async for start, chunk_segs, translated in _iter_translated_chunks(segments, target, context, shared_glossary):
        for local_idx, (orig_seg, t) in enumerate(zip(chunk_segs, translated)):
            processed += 1
            yield {
                "id": orig_seg.get("id"),
                "index": start + local_idx,
                "text": t["text"],
                "speaker": t["speaker"],
                "failed": not t["text"],
                "current": processed,
                "total": total,
                "percent": round((processed / total) * 100),
            }


SHORTEN_CHUNK_SIZE = 30


async def shorten_lines(items: list, target_language: str = "km") -> list[str]:
    """Rewrite lines that are too long to say in their time, each within its own limit.

    `items` are {"source": original dialogue, "text": current line, "max_chars": limit}.
    Returns the rewritten text for each, or "" where no usable rewrite came back. Only the
    wording changes; the caller decides what to keep.
    """
    if not items:
        return []
    await _configure_genai()
    target = _effective_target(target_language)
    lang_name = TRANSLATION_LANGUAGES.get(target, target)
    out = [""] * len(items)

    async def one(start: int) -> None:
        chunk = items[start:start + SHORTEN_CHUNK_SIZE]
        numbered = "\n".join(
            f"{i + 1}. (limit {int(it['max_chars'])} characters; now {len(it['text'])})"
            + (f" original: {it['source']} |" if it.get("source") and it["source"] != it["text"] else "")
            + f" current: {it['text']}"
            for i, it in enumerate(chunk)
        )
        prompt = f"""These lines of dubbed film dialogue are too long: the voice cannot say them in the time the
character is speaking. Rewrite each one shorter, in natural spoken {lang_name}.

Rules:
- Each rewrite must be no longer than its limit, counted in characters.
- Keep what the line is for: the point, the feeling, who is addressed. Cut filler, repetition,
  and detail the scene already shows. Prefer the short everyday way of saying it.
- Keep names exactly as they are written in the current line.
- Write only {lang_name}{" in Khmer script" if target == "km" else ""}. No notes, no speaker labels.
- If a line cannot be said any shorter without losing its meaning, return it unchanged.

Return a JSON array, one object per line, in order: [{{"index": 1, "text": "shorter line"}}]
Return ONLY the JSON array.

Lines:
{numbered}"""
        try:
            response = await _generate_with_fallback(
                prompt,
                generation_config=genai.types.GenerationConfig(temperature=0.2, response_mime_type="application/json"),
            )
            raw = re.sub(r"^```(?:json)?\n?|\n?```$", "", response.text.strip())
            for i, item in enumerate(_extract_translated_list(_safe_json_loads(raw), len(chunk))):
                if item.get("text"):
                    out[start + i] = _clean_translation(item, target)["text"]
        except Exception as e:
            print(f"[shorten] chunk failed: {e}", flush=True)

    sem = asyncio.Semaphore(MAX_PARALLEL_TRANSLATIONS)

    async def limited(start: int) -> None:
        async with sem:
            await one(start)

    await asyncio.gather(*[limited(i) for i in range(0, len(items), SHORTEN_CHUNK_SIZE)])
    return out


# --- Who speaks each line of an imported subtitle -----------------------------------------
# A subtitle file gives the words and the times but almost never the speakers, and without a
# speaker and a gender every line is dubbed in the same default voice. The audio does know:
# the model is given each stretch of it with the lines that fall there and asked to label them.

def _label_prompt(numbered: str, cast: dict[str, str]) -> str:
    known = (
        "CHARACTERS ALREADY IDENTIFIED earlier in this film or in earlier episodes of the same "
        "series — when the same person speaks, use exactly the same name, and only make up a new "
        "name for someone who is not on this list:\n" + "\n".join(f"- {name} ({profile})" for name, profile in cast.items()) + "\n\n"
        if cast else ""
    )
    return f"""You are a film dialogue diarization expert. The audio is a stretch of a film. Below are the
subtitle lines spoken in it, each with a label (L1, L2…), its time in seconds from the start of
this audio, and its words. The words and times are already correct — do not change them.

Listen to the audio and decide, for EVERY line, who is speaking it.

{known}RULES:
- "speaker": the character's name if it is said in the dialogue, otherwise who they are in the
  scene ("Young Man", "Mother", "Guard", "Narrator"). Never "Unknown", "Speaker" or "?".
  Use the SAME name every time the same voice speaks.
- Write every name in ENGLISH letters, whatever language the dialogue is in: a Chinese name in
  pinyin ("Xiao Feng", "Shopkeeper Gu"), never in Chinese characters. The people editing this
  dub cannot read the original script.
- "voice_profile": exactly one of "male", "female", "grandpa", "grandma", "child_boy",
  "child_girl" — judged from the voice you hear, not from the name.
- "gender": "male" or "female", matching voice_profile.
- "emotion": one of "neutral", "angry", "happy", "sad", "crying", "laughing", "fearful",
  "excited", "surprised", "serious", "calm", "whisper", "scream" — from how the line is delivered.
- Return one object per line, in the same order, and no others.
- "text" and "original_text" must be the line's LABEL (for example "L7"), not its words.

Return ONLY a JSON array:
[{{"start_time": 1.2, "end_time": 3.0, "text": "L1", "original_text": "L1", "speaker": "Tang Bohu", "gender": "male", "voice_profile": "male", "emotion": "angry"}}]

LINES:
{numbered}"""


async def label_speakers(video_path: str, lines: list[dict], on_progress=None,
                         known_cast: dict[str, str] | None = None) -> dict[str, dict]:
    """Label each timed line with who speaks it. `lines` are {"id", "start_time", "end_time",
    "text"} in the video's own time. Returns {id: {"speaker", "voice_profile", "emotion"}} for
    the lines that could be labelled; a stretch that fails is left out, not guessed.

    The film is worked through in order, one stretch at a time, so each stretch is told the
    names used so far — in parallel, every stretch would name the same man differently.
    `known_cast` ({name: voice profile}) starts that list with the people the series already
    knows, so episode 40 calls a man what episode 1 called him.
    """
    if not lines:
        return {}
    await _configure_genai()
    chunks, tmp_dir = await _split_video_chunks(video_path)
    out: dict[str, dict] = {}
    cast: dict[str, str] = dict(known_cast or {})
    try:
        for index, (path, offset) in enumerate(chunks):
            # a stretch owns the lines that start in its own two minutes, not in its lead-in
            lo = index * CHUNK_DURATION if len(chunks) > 1 else 0.0
            hi = (index + 1) * CHUNK_DURATION if index + 1 < len(chunks) else float("inf")
            mine = [l for l in lines if lo <= l["start_time"] < hi]
            if on_progress:
                on_progress(index, len(chunks))
            if not mine:
                continue
            numbered = "\n".join(
                f"L{n + 1} [{max(0.0, l['start_time'] - offset):.1f}s–{max(0.0, l['end_time'] - offset):.1f}s] {l['text']}"
                for n, l in enumerate(mine)
            )
            try:
                answers = await _transcribe_media_with_fallback(path, _label_prompt(numbered, cast))
            except Exception as e:
                print(f"[speakers] stretch {index + 1}/{len(chunks)} failed: {type(e).__name__}", flush=True)
                continue
            for answer in answers or []:
                m = re.search(r"\bL\s*(\d+)\b", f"{answer.get('text', '')} {answer.get('original_text', '')}")
                if not m or not (1 <= int(m.group(1)) <= len(mine)):
                    continue
                speaker = str(answer.get("speaker") or "").strip()
                if not speaker or speaker.lower() in ("speaker", "unknown", "unnamed", "?"):
                    continue
                profile = str(answer.get("voice_profile") or "female")
                out[mine[int(m.group(1)) - 1]["id"]] = {
                    "speaker": speaker, "voice_profile": profile, "emotion": str(answer.get("emotion") or "neutral"),
                }
                cast.setdefault(speaker, profile)
        if on_progress:
            on_progress(len(chunks), len(chunks))
        return out
    finally:
        if tmp_dir and os.path.isdir(tmp_dir):
            shutil.rmtree(tmp_dir, ignore_errors=True)

