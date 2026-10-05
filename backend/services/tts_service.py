from __future__ import annotations
import os
import uuid
import asyncio
import subprocess
import shutil
import logging
import unicodedata
from weakref import WeakKeyDictionary
from typing import Optional
from backend.config import settings

import re

# Khmer voices. Edge TTS offers exactly two Khmer neural voices, so every profile maps onto
# one of them; the character is carried by pitch and delivery, not by a different voice.
KHMER_FEMALE = "km-KH-SreymomNeural"
KHMER_MALE = "km-KH-PisethNeural"

VOICE_MAP = {
    "km": {
        "female": KHMER_FEMALE,
        "male": KHMER_MALE,
        "child_boy": KHMER_MALE,
        "child_girl": KHMER_FEMALE,
        "child": KHMER_FEMALE,
        "young": KHMER_FEMALE,
        "grandpa": KHMER_MALE,
        "grandma": KHMER_FEMALE,
        "old": KHMER_MALE,
    },
}

# Default fallback (Khmer)
DEFAULT_VOICE_MAP = VOICE_MAP["km"]

VOICE_POOLS = {
    "km": {
        "female": [KHMER_FEMALE],
        "male": [KHMER_MALE],
        "child_boy": [KHMER_MALE],
        "child_girl": [KHMER_FEMALE],
        "child": [KHMER_FEMALE],
        "young": [KHMER_FEMALE],
        "grandpa": [KHMER_MALE],
        "grandma": [KHMER_FEMALE],
        "old": [KHMER_MALE],
    },
}


def assign_speaker_voices(segments: list, language: str = "") -> list:
    """Give each distinct detected speaker their own TTS voice & profile."""
    pools = VOICE_POOLS["km"]  # Khmer is the only dubbing target
    assigned: dict[tuple, str] = {}
    next_index = {"female": 0, "male": 0, "child": 0, "grandma": 0, "grandpa": 0, "child_boy": 0, "child_girl": 0}

    for seg in segments:
        vp = str(seg.get("voice_profile") or "").lower().strip()
        speaker = str(seg.get("speaker") or "").strip().lower()

        from backend.services.voice_profiles import resolve_voice_profile
        gender = resolve_voice_profile(vp, seg.get("gender"), speaker)
        seg["voice_profile"] = gender

        key = (speaker, gender)
        if key not in assigned:
            pool = list(pools.get(gender) or pools.get("female") or [DEFAULT_VOICE_MAP["female"]])
            assigned[key] = pool[next_index.get(gender, 0) % len(pool)]
            next_index[gender] = next_index.get(gender, 0) + 1
        seg["voice_name"] = assigned[key]
    return segments


# Emotion → prosody offsets (rate %, pitch Hz, volume %) tuned for natural, warm, and catchy speech.
EMOTION_PROSODY: dict[str, tuple[int, int, int]] = {
    "laughing": (6, 5, 2),
    "laugh": (6, 5, 2),
    "chuckle": (4, 3, 1),
    "playful": (5, 4, 1),
    "cheerful": (4, 3, 1),
    "happy": (4, 3, 1),
    "excited": (6, 5, 2),
    "sad": (-5, -3, -1),
    "crying": (-8, -4, -3),
    "angry": (4, 3, 2),
    "scream": (7, 6, 3),
    "screaming": (7, 6, 3),
    "shout": (5, 4, 2),
    "shouting": (5, 4, 2),
    "calm": (-3, -2, 0),
    "serious": (-3, -2, 0),
    "fearful": (4, 3, 1),
    "surprised": (5, 4, 2),
    "whisper": (-5, -3, -2),
    "whispering": (-5, -3, -2),
}


# Pitch offsets (Hz) given to successive characters that share one TTS voice, most-spoken first.
# Khmer has only one male and one female Edge voice, so this is what keeps characters apart.
SPEAKER_PITCH_STEPS = (0, -14, 12, -24, 22, -7, 7, -30, 28)

# In "fit subtitle" mode a dub at least this fraction of the slot is stretched to fill it
# (so a 4.2s line in a 5s slot ends with the speech instead of 0.8s early).
MAX_FILL_STRETCH = 0.8


def speaker_pitch_offsets(rows) -> dict[str, int]:
    """rows: iterable of (speaker, voice_name, voice_profile). Returns speaker -> pitch offset in Hz.
    Speakers are ranked by line count within each base voice, so the main character keeps the
    natural voice and side characters get progressively shifted pitch."""
    from collections import Counter
    counts = Counter()
    for speaker, voice_name, voice_profile in rows:
        if speaker:
            counts[(voice_name or voice_profile or "", speaker)] += 1
    by_voice: dict[str, list] = {}
    for (voice, speaker), n in counts.most_common():
        by_voice.setdefault(voice, []).append(speaker)
    offsets: dict[str, int] = {}
    for speakers in by_voice.values():
        for rank, speaker in enumerate(speakers):
            offsets.setdefault(speaker, SPEAKER_PITCH_STEPS[rank % len(SPEAKER_PITCH_STEPS)])
    return offsets


def _emotion_prosody(emotion: str, base_rate: str = "+0%", voice_profile: str = "", pitch_offset: int = 0) -> tuple[str, str, str]:
    """Combine the caller's rate with emotion offsets, voice profile and character pitch → (rate, pitch, volume)."""
    try:
        base = int(base_rate.strip().rstrip("%"))
    except ValueError:
        base = 0
    r, p, v = EMOTION_PROSODY.get((emotion or "").lower().strip(), (0, 0, 0))
    vp = (voice_profile or "").lower().strip()
    if vp in ("child_boy", "boy"):
        p += 7
        r += 5
    elif vp in ("child_girl", "girl", "child", "young"):
        p += 8
        r += 4
    elif vp in ("grandpa", "elderly_male", "old_man"):
        p -= 4
        r -= 6
    elif vp in ("grandma", "elderly_female", "old_woman", "elderly", "old"):
        p -= 2
        r -= 5
    p += pitch_offset
    return (f"{base + r:+d}%", f"{p:+d}Hz", f"{v:+d}%")


def _get_ffmpeg() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found. Please install ffmpeg: brew install ffmpeg")
    return ffmpeg


def _probe_duration(ffmpeg: str, path: str) -> float:
    """Probe the duration of an audio file in seconds."""
    probe_cmd = [
        ffmpeg.replace("ffmpeg", "ffprobe") if "ffmpeg" in ffmpeg else "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        path,
    ]
    try:
        result = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=10)
        return float(result.stdout.strip())
    except (ValueError, subprocess.TimeoutExpired):
        return 0.0


# --- VoxCPM lazy-loaded model cache ---
_voxcpm_model = None
import threading as _threading
_voxcpm_lock = _threading.Lock()


def _get_voxcpm_model():
    global _voxcpm_model
    if _voxcpm_model is None:
        with _voxcpm_lock:
            if _voxcpm_model is None:  # double-check inside lock
                try:
                    from voxcpm import VoxCPM as _VoxCPM
                except ImportError:
                    raise RuntimeError(
                        "VoxCPM is not installed. Run: pip install voxcpm\n"
                        "Or switch TTS engine back to 'edge-tts' in Settings."
                    )
                import torch
                if torch.backends.mps.is_available():
                    device = "mps"
                elif torch.cuda.is_available():
                    device = "cuda"
                else:
                    device = "cpu"
                print(f"[VoxCPM] Loading model on {device} …")
                _voxcpm_model = _VoxCPM.from_pretrained(
                    settings.voxcpm_model_path,
                    load_denoiser=False,
                )
                print("[VoxCPM] Model ready.")
    return _voxcpm_model


# The model holds about 7 GB while it is loaded. Left loaded after the dubbing is done, it
# keeps that from everything else the Mac is doing — isolating music, rendering — for as long
# as the server runs. It is let go once it has sat unused this long, and loads again (about
# 25 s) the next time a cloned voice is asked for.
VOXCPM_IDLE_SECONDS = 600
_voxcpm_in_use = 0
_voxcpm_unload_timer = None


def unload_voxcpm() -> bool:
    """Free the model's memory if nothing is using it. True when it was let go."""
    global _voxcpm_model
    if _voxcpm_model is None or _voxcpm_in_use:
        return False
    with _voxcpm_lock:
        _voxcpm_model = None
    import gc

    gc.collect()
    try:
        import torch

        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        elif torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    print("[VoxCPM] Unused for a while — memory released.", flush=True)
    return True


def _unload_voxcpm_when_idle() -> None:
    """(Re)start the countdown to letting the model go. Called after each use."""
    global _voxcpm_unload_timer
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if _voxcpm_unload_timer is not None:
        _voxcpm_unload_timer.cancel()
    _voxcpm_unload_timer = loop.call_later(VOXCPM_IDLE_SECONDS, unload_voxcpm)


def voxcpm_takes(steps: int) -> int:
    """How many times a line may be spoken to get one of the right length. A take that comes
    out half-spoken or rambling is tried again; on the light setting, once is the limit — the
    retakes are where a slow line gets three times slower."""
    return 2 if steps <= 10 else 3


# Map voice_profile + emotion → VoxCPM natural-language voice description
_VOXCPM_EMOTION_WORDS = {
    "cheerful": "cheerful and bright",
    "happy": "warm and happy",
    "sad": "soft and melancholic",
    "crying": "tearful and trembling, with gentle pauses",
    "laughing": "playful and amused, with a smiling delivery",
    "scream": "urgent and forceful, projecting clearly",
    "surprised": "startled and expressive",
    "angry": "firm and intense",
    "excited": "energetic and excited",
    "calm": "calm and soothing",
    "serious": "clear and professional",
    "fearful": "tense and anxious",
    "whisper": "soft whispering and breathy",
    "neutral": "natural and clear",
    "": "natural and clear",
}


def _build_voxcpm_prompt(text: str, voice_profile: str, emotion: str) -> str:
    """Prepend a VoxCPM voice design description to the text."""
    age_map = {
        "child_boy": "young child",
        "child_girl": "young child",
        "child": "young child",
        "young": "young teenager",
        "female": "middle-aged",
        "male": "middle-aged",
        "grandpa": "elderly grandfather",
        "grandma": "elderly grandmother",
        "old": "elderly",
    }
    gender_map = {
        "female": "female",
        "male": "male",
        "child_boy": "male",
        "child_girl": "female",
        "child": "female",
        "young": "female",
        "grandpa": "male",
        "grandma": "female",
        "old": "male",
    }
    emotion_map = _VOXCPM_EMOTION_WORDS
    age = age_map.get(voice_profile, "middle-aged")
    gender = gender_map.get(voice_profile, "female")
    tone = emotion_map.get(emotion or "", "natural and clear")
    description = f"A {age} {gender}, {tone} voice"
    return f"({description}){text}"


def _voxcpm_style_prefix(emotion: str) -> str:
    """Style control for a cloned line, e.g. "(tense and anxious)".

    Cloning copies the delivery of the reference sample, so the emotion cannot come from the
    reference without designing a separate speaker per emotion. VoxCPM2 takes the style in
    parentheses ahead of the text instead, which keeps one voice per character.
    """
    key = (emotion or "").lower().strip()
    if key in ("", "neutral"):
        return ""
    tone = _VOXCPM_EMOTION_WORDS.get(key, "")
    return f"({tone})" if tone else ""


# Fixed seed per voice profile, used once to create the reference sample.
_VOXCPM_VOICE_SEEDS = {
    "female": 42,
    "male": 1337,
    "child_boy": 105,
    "child_girl": 7,
    "child": 7,
    "young": 7,
    "grandpa": 99,
    "grandma": 204,
    "old": 99,
}

# Spoken by the generated reference sample; must match its audio exactly.
_VOXCPM_REF_TEXT = "ខ្ញុំរីករាយណាស់ដែលបានជួបអ្នកនៅថ្ងៃនេះ ហើយសូមស្វាគមន៍មកកាន់កម្មវិធីរបស់យើង"


def _get_voxcpm_reference(model, voice_profile: str) -> str:
    """Return the cached reference sample that gives this character its voice.

    Voice design draws a new random speaker on every generation — even with a fixed seed the
    voice varies with the text. To keep ONE voice across all segments we design a sample once
    per profile, cache it on disk, and clone from it for every line.

    There is one sample per character, not one per emotion: emotion is applied as style control
    on the line itself (see `_voxcpm_style_prefix`). Designing a separate speaker per emotion
    made a character's voice change whenever the mood did, and multiplied the chances of a bad
    design being cached.
    """
    ref_dir = os.path.join(settings.upload_dir, "tts", "voxcpm_refs")
    os.makedirs(ref_dir, exist_ok=True)
    ref_path = os.path.join(ref_dir, f"{voice_profile}.wav")
    if not os.path.exists(ref_path):
        import random
        import numpy as np
        import soundfile as sf
        import torch
        # The seed is per profile, not per emotion, so every emotion of one character is
        # designed from the same starting point and still sounds like that character.
        seed = _VOXCPM_VOICE_SEEDS.get(voice_profile, 42)
        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)
        prompt = _build_voxcpm_prompt(_VOXCPM_REF_TEXT, voice_profile, "neutral")

        def _design():
            return model.generate(
                prompt,
                cfg_value=settings.voxcpm_cfg_value,
                inference_timesteps=max(10, settings.voxcpm_inference_steps),
                normalize=True,
            )

        # Voice design sometimes rambles past the end of the text or stops halfway through it.
        # A reference is cloned by every line of that character, so a bad one is not a single
        # bad take — it is that character ruined for the whole project. Hold it to the same
        # duration window a segment gets, and keep the closest take rather than the first.
        rate = model.tts_model.sample_rate
        est = _estimated_speech_seconds(_VOXCPM_REF_TEXT)
        low, high = est * 0.6, est * 1.5
        attempts = []
        for _ in range(3):
            wav = _design()
            seconds = len(wav) / rate
            attempts.append((seconds, wav))
            if low <= seconds <= high:
                break
        else:
            seconds, wav = min(attempts, key=lambda a: abs(a[0] - est))
            print(
                f"[VoxCPM] {voice_profile} reference is {seconds:.1f}s for a ~{est:.1f}s line "
                f"after {len(attempts)} tries; keeping the closest take."
            )
        sf.write(ref_path, np.array(wav), model.tts_model.sample_rate)
    return ref_path


# Measured across 240 real Khmer dubs in this app: median 0.086 s per Khmer character.
# 0.09 sits inside that spread and is what the fitting loop has always been tuned around.
KHMER_SECONDS_PER_CHAR = 0.09

# VoxCPM speaks faster than Edge: measured at 0.58-0.80 (median ~0.65) of the Edge-calibrated
# estimate over 15 takes. Its takes are judged against this, not against Edge's pace.
VOXCPM_RATE_FACTOR = 0.65


def _estimated_speech_seconds(text: str) -> float:
    """Rough estimate (seconds) of how long a Khmer line takes to speak."""
    khmer = len(re.findall(r"[\u1780-\u17FF]", text))
    # digits and punctuation still take time to say, but far less than a syllable
    other = max(len(text) - khmer, 0)
    return khmer * KHMER_SECONDS_PER_CHAR + other * 0.04


async def _generate_voxcpm_audio(
    text: str,
    voice_profile: str = "female",
    emotion: str = "",
    reference_wav_path: str = "",
    timesteps: Optional[int] = None,
) -> str:
    """Generate TTS audio with VoxCPM2, cloning the profile's reference voice or custom audio."""
    import soundfile as sf
    import numpy as np

    global _voxcpm_in_use
    _voxcpm_in_use += 1
    try:
        return await _voxcpm_take(text, voice_profile, emotion, reference_wav_path, timesteps)
    finally:
        _voxcpm_in_use -= 1
        _unload_voxcpm_when_idle()


async def _voxcpm_take(text: str, voice_profile: str, emotion: str, reference_wav_path: str, timesteps: Optional[int]) -> str:
    import soundfile as sf
    import numpy as np

    model = await asyncio.to_thread(_get_voxcpm_model)
    infer_steps = timesteps or settings.voxcpm_inference_steps or 10

    def _generate():
        if reference_wav_path and os.path.exists(reference_wav_path):
            # A captured voice keeps its own delivery; the emotion lives in the sample
            return model.generate(
                text,
                reference_wav_path=reference_wav_path,
                cfg_value=settings.voxcpm_cfg_value,
                inference_timesteps=infer_steps,
                normalize=True,
            )
        # Clone from the sample without claiming to know its transcript. Voice design does not
        # reliably speak the words it was given — it once turned "I am very glad to have met
        # you today" into "Hello grandma Rina" — and pairing a sample with a transcript it does
        # not match teaches the model the wrong sound for those words, which is what made dubbed
        # lines come out saying something other than their caption.
        ref_wav = _get_voxcpm_reference(model, voice_profile)
        return model.generate(
            _voxcpm_style_prefix(emotion) + text,
            reference_wav_path=ref_wav,
            cfg_value=settings.voxcpm_cfg_value,
            inference_timesteps=infer_steps,
            normalize=True,
        )

    sample_rate = model.tts_model.sample_rate
    # KHMER_SECONDS_PER_CHAR was measured on Edge dubs, and VoxCPM reads noticeably faster:
    # across 15 takes of 3 lines it came out at 0.58-0.80 of that estimate, never above it.
    # Judging VoxCPM against the Edge figure let a half-spoken take through (0.45 of the Edge
    # estimate is 0.67 of VoxCPM's natural length) and, when the window failed, made
    # "closest to the estimate" pick the longest, most rambling take of the three.
    est = _estimated_speech_seconds(text) * VOXCPM_RATE_FACTOR
    ceiling = max(2.0, est * 1.5 + 0.5)
    floor = est * 0.7

    # Run primary generation
    candidate = await asyncio.to_thread(_generate)
    dur = len(candidate) / sample_rate

    # If first pass is within normal duration window, use it directly (saves 2x-3x time!)
    if floor <= dur <= ceiling:
        wav = candidate
    else:
        attempts = [(dur, candidate)]
        for _ in range(voxcpm_takes(infer_steps) - 1):
            candidate = await asyncio.to_thread(_generate)
            dur = len(candidate) / sample_rate
            attempts.append((dur, candidate))
            if floor <= dur <= ceiling:
                break
        dur, wav = min(attempts, key=lambda t: abs(t[0] - max(est, 0.6)))

    export_dir = os.path.join(settings.upload_dir, "tts")
    os.makedirs(export_dir, exist_ok=True)
    output_path = os.path.join(export_dir, f"{uuid.uuid4()}.wav")

    sample_rate = model.tts_model.sample_rate
    await asyncio.to_thread(sf.write, output_path, np.array(wav), sample_rate)

    return output_path


# word -> how it should be pronounced, loaded from app settings and refreshed when saved
_pronunciations: list[tuple[str, str]] = []
_pronunciations_loaded = False


def set_pronunciations(entries: list[dict]) -> None:
    """Replace the in-memory dictionary (called on startup and whenever it is saved)."""
    global _pronunciations, _pronunciations_loaded
    cleaned = []
    for e in entries or []:
        word = str(e.get("word", "")).strip()
        say = str(e.get("say_as", "")).strip()
        if word and say:
            cleaned.append((word, say))
    # longest first, so "Tang Bohu" wins over "Tang"
    _pronunciations = sorted(cleaned, key=lambda p: len(p[0]), reverse=True)
    _pronunciations_loaded = True


async def _ensure_pronunciations() -> None:
    global _pronunciations_loaded
    if _pronunciations_loaded:
        return
    _pronunciations_loaded = True
    try:
        import json

        from sqlalchemy import select as _select

        from backend.database.db import async_session
        from backend.database.models import AppSetting

        async with async_session() as db:
            row = await db.execute(_select(AppSetting).where(AppSetting.key == "pronunciations"))
            setting = row.scalar_one_or_none()
        if setting and setting.value:
            set_pronunciations(json.loads(setting.value))
    except Exception as e:
        print(f"[tts] could not load pronunciations: {e}", flush=True)


def apply_pronunciations(text: str) -> str:
    """Swap words for their spoken spelling. Only the audio changes; captions keep the original."""
    if not text or not _pronunciations:
        return text
    # A single pass prevents a replacement from being replaced a second time.
    # ASCII boundaries also work when a Latin name touches Khmer text.
    patterns = []
    replacements = {}
    for index, (word, say) in enumerate(_pronunciations):
        name = f"word{index}"
        escaped = re.escape(word)
        pattern = rf"(?<![A-Za-z0-9_]){escaped}(?![A-Za-z0-9_])" if word.isascii() else escaped
        patterns.append(f"(?P<{name}>{pattern})")
        replacements[name] = say
    return re.sub('|'.join(patterns), lambda match: replacements[match.lastgroup], text, flags=re.IGNORECASE)


def says_word(text: str, word: str) -> bool:
    """Whether the dictionary entry for `word` would change how this text is spoken."""
    if not text or not word:
        return False
    escaped = re.escape(word)
    pattern = rf"(?<![A-Za-z0-9_]){escaped}(?![A-Za-z0-9_])" if word.isascii() else escaped
    return re.search(pattern, text, flags=re.IGNORECASE) is not None


def _clean_and_detect_emotion(text: str, default_emotion: str = "") -> tuple[str, str]:
    """Respect explicit delivery and remove only recognized performance directions."""
    aliases = {
        "laugh": "laughing", "laughs": "laughing", "laughter": "laughing",
        "chuckle": "laughing", "giggle": "laughing", "សើច": "laughing",
        "cry": "crying", "cries": "crying", "weeping": "crying", "sobbing": "crying", "យំ": "crying",
        "whispering": "whisper", "ខ្សឹប": "whisper",
        "shout": "scream", "shouting": "scream", "screaming": "scream", "ស្រែក": "scream",
        "scared": "fearful", "ភ័យ": "fearful", "ខ្លាច": "fearful",
        "ខឹង": "angry", "សប្បាយ": "happy", "រីករាយ": "happy",
        "សោកសៅ": "sad", "រំភើប": "excited", "ស្ងប់": "calm",
    }
    def canonical(value):
        value = (value or '').lower().strip()
        return aliases.get(value, value)

    selected = canonical(default_emotion)
    explicit = selected in EMOTION_PROSODY or selected == 'neutral'
    detected = selected if explicit else ''

    def strip_direction(match):
        nonlocal detected
        tag = match.group(0)[1:-1].strip()
        tone = canonical(tag)
        if tone in EMOTION_PROSODY or tone == 'neutral':
            if not explicit and not detected:
                detected = tone
            return ' '
        if tag.lower() in ('music', 'background music', 'noise', 'silence', 'ភ្លេង', 'តន្ត្រី'):
            return ' '
        return match.group(0)  # Parentheses may contain actual dialogue.

    clean = re.sub(r'\([^()]*\)|\[[^\[\]]*\]|\{[^{}]*\}', strip_direction, text)
    clean = re.sub(r'\s+', ' ', clean).strip()
    if not detected and re.search(r'\b(?:ha){2,}\b|\b(?:he){2,}\b|ហាហា|ហិហិ', clean, re.IGNORECASE):
        detected = 'laughing'
    if not clean and detected == 'laughing':
        clean = 'ហាហាហា!' if re.search(r'[\u1780-\u17ff]', text) else 'Haha!'
    return clean, detected or 'neutral'


def profile_engine(profile: dict) -> str:
    """The engine a voice profile *insists* on, if any.

    A built-in profile names an engine only as its default, so it must not override the engine
    chosen in Settings — otherwise switching to VoxCPM would leave every default Khmer line on
    Edge. A profile the user created (a captured voice, say) does insist: its sample can only be
    reproduced by the engine it was made for.
    """
    if not profile or profile.get("is_built_in"):
        return ""
    return (profile.get("engine") or "").strip()


async def _get_active_tts_engine() -> str:
    """Dynamically get active TTS engine from db/settings."""
    try:
        from backend.database.db import async_session
        from sqlalchemy import select
        from backend.database.models import AppSetting
        async with async_session() as db:
            res = await db.execute(select(AppSetting.value).where(AppSetting.key == "tts_engine"))
            val = res.scalar_one_or_none()
            if val:
                return val
    except Exception:
        pass
    return settings.tts_engine or "edge-tts"


# Shared across preview, single-line and batch requests in each server event loop.
_edge_request_limits = WeakKeyDictionary()
_logger = logging.getLogger(__name__)


async def finish_within(coro, seconds: float):
    """Await `coro`, giving up after `seconds` even if it will not stop.

    asyncio.wait_for cancels the work on timeout and then waits for it to finish cancelling.
    A websocket that has gone quiet can sit in its close handshake indefinitely, and then
    wait_for never returns: one dead Edge request held its slot, the next lines queued behind
    it, and a dubbing job sat at the same line for good. Here the stuck work is cancelled and
    left behind, and the caller carries on."""
    task = asyncio.ensure_future(coro)
    done, _ = await asyncio.wait({task}, timeout=seconds)
    if task in done:
        return task.result()
    task.cancel()
    # retrieve whatever it ends with later, so it is not reported as never retrieved
    task.add_done_callback(lambda t: t.cancelled() or t.exception())
    raise TimeoutError(f"gave up after {seconds:.0f}s")


async def _save_edge_audio(text: str, voice: str, output_path: str, *, rate: str, pitch: str, volume: str) -> None:
    import edge_tts
    from aiohttp import ClientError
    from edge_tts.exceptions import EdgeTTSException, NoAudioReceived

    # Control-only and punctuation-only captions cannot produce speech. Preserve Khmer
    # combining marks and joiners; stripping those changes pronunciation.
    text = ''.join(' ' if char.isspace() else char for char in text
                   if char.isspace() or unicodedata.category(char) != 'Cc').strip()
    if not any(char.isalnum() for char in text):
        raise ValueError("This line has no spoken words. Add dialogue before generating its voice.")

    if voice.startswith("km-KH-") and re.search(r'[\u3400-\u9fff]', text) and not re.search(r'[\u1780-\u17b3]', text):
        raise ValueError(
            "This line is still in Chinese. Translate it to Khmer in Captions before generating a Khmer voice."
        )

    loop = asyncio.get_running_loop()
    limiter = _edge_request_limits.setdefault(loop, asyncio.Semaphore(2))
    for attempt in range(4):
        try:
            async with limiter:
                communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)
                await finish_within(communicate.save(output_path), 30)
                if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
                    raise NoAudioReceived("Edge TTS returned an empty audio file.")
            return
        except asyncio.CancelledError:
            _cleanup_files([output_path])
            raise
        except (EdgeTTSException, ClientError, TimeoutError) as error:
            _cleanup_files([output_path])
            _logger.warning("Edge TTS attempt %s/4 failed: voice=%s chars=%s rate=%s pitch=%s error=%s",
                            attempt + 1, voice, len(text), rate, pitch, type(error).__name__)
            if attempt == 3:
                raise RuntimeError(
                    f"Edge TTS returned no usable audio for {voice} after 4 attempts. "
                    "Retry this line in a moment. If it keeps failing, check the dialogue text "
                    "or choose another voice. Completed audio has been kept."
                ) from error
            # Give the remote service time to recover; do not hold a request slot while waiting.
            await asyncio.sleep(2 ** attempt)
        except Exception:
            _cleanup_files([output_path])
            raise


async def generate_segment_audio(
    text: str,
    voice_profile: str = "female",
    rate: str = "+0%",
    voice_name: str = "",
    language: str = "",
    emotion: str = "",
    voice_fx: str = "",
    pitch: str = "",
    engine: str = "",
    reference_audio: str = "",
    timesteps: Optional[int] = None,
    apply_fx: bool = True,
    pitch_offset: int = 0,
) -> str:
    await _ensure_pronunciations()
    clean_text, detected_emotion = _clean_and_detect_emotion(text, emotion)
    clean_text = apply_pronunciations(clean_text)
    if not clean_text:
        raise ValueError("No spoken text remains after removing performance directions.")
    active_engine = await _get_active_tts_engine()
    requested_engine = (engine or "").lower().strip()
    if not requested_engine and (voice_name or '').startswith('voxcpm-'):
        requested_engine = 'voxcpm'

    # Resolve local reference audio file if provided
    ref_wav_path = ""
    if reference_audio:
        ref_audio_clean = reference_audio.replace("/uploads/", "")
        candidate_path = os.path.join(settings.upload_dir, ref_audio_clean)
        if os.path.exists(candidate_path):
            ref_wav_path = candidate_path
        elif os.path.exists(reference_audio):
            ref_wav_path = reference_audio

    # An explicit profile engine takes precedence over the global default.
    is_voxcpm = requested_engine == "voxcpm" or (
        not requested_engine and (
            active_engine == "voxcpm"
            or (active_engine != "edge-tts" and bool(ref_wav_path))
        )
    )
    if requested_engine == "voxcpm" and reference_audio and not ref_wav_path:
        raise ValueError("The captured voice sample is missing. Capture the voice again.")
    if is_voxcpm:
        try:
            local_audio = await _generate_voxcpm_audio(
                clean_text,
                voice_profile,
                detected_emotion,
                reference_wav_path=ref_wav_path,
                timesteps=timesteps,
            )
            if apply_fx:
                return await _apply_voice_filters(local_audio, voice_profile, detected_emotion, voice_fx)
            return local_audio
        except Exception as e:
            if requested_engine == "voxcpm" and reference_audio:
                raise RuntimeError(f"Cloned voice generation failed: {e}") from e
            print(f"[VoxCPM] Generation failed: {e}. Falling back to Edge-TTS.")
            if voice_name and "voxcpm" in voice_name.lower():
                voice_name = ""

    # This app dubs into Khmer, so the voice always comes from the Khmer set. Picking the voice
    # by sniffing the text used to hand a stray Chinese or Latin line to a Chinese or English
    # voice mid-scene, which is never what a Khmer dub wants.
    if voice_name and not voice_name.startswith("km-KH-"):
        print(f"[tts] ignoring non-Khmer voice {voice_name!r}; using the Khmer set instead", flush=True)
        voice_name = ""
    voice = voice_name or DEFAULT_VOICE_MAP.get(voice_profile, KHMER_FEMALE)

    tts_rate, tts_pitch, tts_volume = _emotion_prosody(detected_emotion, rate, voice_profile=voice_profile, pitch_offset=pitch_offset)
    if pitch and pitch != "+0Hz":
        tts_pitch = pitch

    export_dir = os.path.join(settings.upload_dir, "tts")
    os.makedirs(export_dir, exist_ok=True)

    import hashlib
    # voice_fx belongs in the key: the same words in the same voice sound different as an
    # inner thought than as a dream, and without it every style shares one cached file.
    cache_key = hashlib.sha256(
        f"{clean_text}_{voice}_{tts_rate}_{tts_pitch}_{tts_volume}_{voice_profile}"
        f"_fx-v3_{detected_emotion}_{apply_fx}_{(voice_fx or 'normal')}".encode("utf-8")
    ).hexdigest()
    cache_file = os.path.join(export_dir, f"cache_{cache_key}.mp3")
    if os.path.exists(cache_file) and os.path.getsize(cache_file) > 0:
        target_path = os.path.join(export_dir, f"{uuid.uuid4()}.mp3")
        shutil.copyfile(cache_file, target_path)
        return target_path

    output_path = os.path.join(export_dir, f"{uuid.uuid4()}.mp3")

    await _save_edge_audio(
        clean_text, voice, output_path, rate=tts_rate, pitch=tts_pitch, volume=tts_volume,
    )

    if apply_fx:
        output_path = await _apply_voice_filters(output_path, voice_profile, detected_emotion, voice_fx)

    if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
        try:
            shutil.copyfile(output_path, cache_file)
        except OSError:
            pass
    return output_path


async def generate_fitted_segment_audio(
    text: str,
    voice_profile: str = "female",
    target_duration: float = 3.0,
    rate: str = "+0%",
    voice_name: str = "",
    language: str = "",
    emotion: str = "",
    voice_fx: str = "",
    engine: str = "",
    reference_audio: str = "",
    max_duration: Optional[float] = None,
    max_speedup: Optional[float] = 2.0,
    pitch_offset: int = 0,
) -> tuple:
    """Generate TTS audio for a single segment.

    Speech dynamically scales speed (atempo) to finish speaking within the allocated
    time limit before the next segment starts, completely preventing voice overlap.
    Returns (path_to_fitted_mp3, actual_duration)."""
    await _ensure_pronunciations()
    clean_text, detected_emotion = _clean_and_detect_emotion(text, emotion)
    clean_text = apply_pronunciations(clean_text)
    if not clean_text:
        raise ValueError("No spoken text remains after removing performance directions.")
    raw_path = await generate_segment_audio(
        clean_text,
        voice_profile,
        rate,
        voice_name=voice_name,
        language=language,
        emotion=detected_emotion,
        voice_fx=voice_fx,
        engine=engine,
        reference_audio=reference_audio,
        apply_fx=False,
        pitch_offset=pitch_offset,
    )

    ffmpeg = _get_ffmpeg()
    export_dir = os.path.join(settings.upload_dir, "tts")
    os.makedirs(export_dir, exist_ok=True)
    fitted_path = os.path.join(export_dir, f"{uuid.uuid4()}_fitted.mp3")

    # Probe the natural audio duration
    raw_duration = _probe_duration(ffmpeg, raw_path)
    spd_cap = min(3.0, max(1.0, max_speedup)) if max_speedup is not None else 2.5

    if raw_duration > 0 and target_duration > 0:
        # Determine ceiling: if max_duration is specified and > 0, use it, else lock to target_duration
        ceiling = max_duration if (max_duration is not None and max_duration > 0) else target_duration

        lock_to_slot = max_duration is not None and max_duration == target_duration
        if raw_duration <= target_duration:
            # Fills most of the slot already: stretch a little so the dub lasts as long as the
            # character speaks. Much shorter lines stay natural and simply end early.
            if lock_to_slot and raw_duration >= target_duration * MAX_FILL_STRETCH:
                actual_duration = target_duration
            else:
                actual_duration = raw_duration
        elif raw_duration <= ceiling:
            # Audio is longer than target_duration but fits within ceiling:
            # Accelerate dynamically so speech stays fast and snappy with the video action
            target_fit = max(target_duration, raw_duration / 1.35)
            tempo = min(raw_duration / target_fit, spd_cap)
            actual_duration = max(0.2, raw_duration / tempo)
        else:
            # Audio exceeds ceiling: accelerate with atempo so speech finishes strictly within the allocated window
            tempo = min(raw_duration / ceiling, spd_cap)
            actual_duration = max(0.2, raw_duration / tempo)
    else:
        actual_duration = target_duration

    # Pass the exact tempo we decided on
    tempo_cap = (raw_duration / actual_duration) if (actual_duration > 0 and raw_duration > 0) else 1.0
    cmd = _build_tempo_cmd(
        ffmpeg,
        raw_path,
        fitted_path,
        actual_duration,
        max_speedup=max(1.0, tempo_cap, spd_cap),
        voice_profile=voice_profile,
        emotion=detected_emotion,
        voice_fx=voice_fx,
    )
    result = await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=True, timeout=120
    )
    _cleanup_files([raw_path])

    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg tempo failed: {result.stderr[-300:]}")

    return fitted_path, _probe_duration(ffmpeg, fitted_path) or actual_duration


async def generate_segments_audio(
    segments: list[dict],
    output_format: str = "wav",
    total_duration: Optional[float] = None,
) -> str:
    """
    Generate TTS audio for multiple segments, with silence gaps matching timeline timing.
    Each segment dict: {text, start_time, end_time, voice_profile}
    Returns path to the combined audio file.
    """
    if not segments:
        raise ValueError("No segments provided")

    ffmpeg = _get_ffmpeg()
    export_dir = os.path.join(settings.upload_dir, "tts")
    os.makedirs(export_dir, exist_ok=True)

    sorted_segs = sorted(segments, key=lambda s: s["start_time"])

    # Generate individual TTS audio files
    tts_files = []
    for seg in sorted_segs:
        text = seg.get("text", "").strip()
        if not text:
            continue
        voice = seg.get("voice_profile", "female")
        try:
            path = await generate_segment_audio(
                text, voice,
                voice_name=seg.get("voice_name", ""),
                emotion=seg.get("emotion", ""),
                voice_fx=seg.get("voice_fx", "normal"),
            )
            tts_files.append({
                "path": path,
                "start_time": seg["start_time"],
                "end_time": seg["end_time"],
                "duration": seg["end_time"] - seg["start_time"],
            })
        except Exception as e:
            # Skip segments that fail TTS
            print(f"TTS failed for segment: {e}")
            continue

    if not tts_files:
        raise RuntimeError("No audio could be generated for any segment")

    # If only one segment, just convert format
    if len(tts_files) == 1:
        single = tts_files[0]
        output_path = os.path.join(export_dir, f"{uuid.uuid4()}_voice.{output_format}")

        # Speed-adjust to fit the segment duration (compress up to 2×)
        cmd = _build_tempo_cmd(ffmpeg, single["path"], output_path, single["duration"], max_speedup=2.0)
        result = await asyncio.to_thread(
            subprocess.run, cmd, capture_output=True, text=True, timeout=120
        )
        _cleanup_files([single["path"]])
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {result.stderr[-300:]}")
        return output_path

    # Multiple segments: build a combined audio with silence gaps
    output_path = os.path.join(export_dir, f"{uuid.uuid4()}_voice.{output_format}")
    temp_fitted = []

    # Fit each TTS audio to its segment duration (compress up to 2× so
    # segments in the combined track never overlap)
    for f in tts_files:
        fitted_path = os.path.join(export_dir, f"{uuid.uuid4()}_fitted.wav")
        cmd = _build_tempo_cmd(ffmpeg, f["path"], fitted_path, f["duration"], max_speedup=2.0)
        result = await asyncio.to_thread(
            subprocess.run, cmd, capture_output=True, text=True, timeout=120
        )
        if result.returncode != 0:
            temp_fitted.append(None)
            continue
        temp_fitted.append({"path": fitted_path, "start_time": f["start_time"]})

    temp_fitted = [t for t in temp_fitted if t is not None]

    if not temp_fitted:
        _cleanup_files([f["path"] for f in tts_files])
        raise RuntimeError("Failed to fit any audio segments")

    # Build ffmpeg filter complex to place each audio at its timeline position
    inputs = []
    filter_parts = []
    for i, t in enumerate(temp_fitted):
        inputs += ["-i", t["path"]]
        delay_ms = int(t["start_time"] * 1000)
        filter_parts.append(f"[{i}]adelay={delay_ms}|{delay_ms}[d{i}]")

    mix_inputs = "".join(f"[d{i}]" for i in range(len(temp_fitted)))
    filter_parts.append(f"{mix_inputs}amix=inputs={len(temp_fitted)}:normalize=0[out]")
    filter_complex = ";".join(filter_parts)

    cmd = [ffmpeg, "-y"] + inputs + [
        "-filter_complex", filter_complex,
        "-map", "[out]",
    ] + _codec_for_ext(output_path) + [
        output_path,
    ]

    result = await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=True, timeout=300
    )

    # Cleanup temp files
    _cleanup_files([f["path"] for f in tts_files] + [t["path"] for t in temp_fitted])

    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg combine failed: {result.stderr[-300:]}")

    return output_path


def _codec_for_ext(path: str) -> list:
    """Return ffmpeg codec flags based on file extension."""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".mp3":
        return ["-c:a", "libmp3lame", "-b:a", "192k"]
    elif ext == ".wav":
        return ["-c:a", "pcm_s16le"]
    elif ext == ".aac":
        return ["-c:a", "aac", "-b:a", "192k"]
    elif ext == ".flac":
        return ["-c:a", "flac"]
    return ["-c:a", "libmp3lame", "-b:a", "192k"]


# How a line is heard. These sit on top of the normal mastering chain, so an inner thought
# still has the same voice — it just reaches the viewer differently. Rooms, dreams and ghosts
# use convolution reverb (voice_fx_ir) rather than a few echo repeats, which sound metallic.
def _band(low: int, high: int) -> str:
    """Keep only low–high Hz, steeply. One high-pass and one low-pass roll off at 12 dB an
    octave, which leaves most of the voice's body in: a "phone" made that way was only 6 dB
    down in the bass and still sounded like the room mic. Two of each is 24 dB an octave."""
    return f"highpass=f={low},highpass=f={low},lowpass=f={high},lowpass=f={high}"


def _hiss(color: str, amount: float, tag: str, shape: str = "") -> str:
    """Lay line noise under the voice for as long as it lasts — a device is never silent."""
    shaped = f",{shape}" if shape else ""
    return (
        f"anull[{tag}v];anoisesrc=color={color}:amplitude={amount}:sample_rate=24000{shaped}[{tag}n];"
        f"[{tag}v][{tag}n]amix=inputs=2:normalize=0:duration=first"
    )


def _voice_fx_chains() -> dict:
    from backend.services.voice_fx_ir import reverb

    # Pushed into a soft clipper: the edge a small speaker or a cheap amplifier puts on a voice
    drive = "volume=5dB,asoftclip=type=tanh"
    return {
        # a thought, heard inside the character's head: darker than speech and held in a
        # close, soft space, so it is plainly not said out loud
        "inner": ("lowpass=f=4200,equalizer=f=200:t=q:w=1:g=3,"
                  + reverb("plate", 0.4, pre="highpass=f=250", post="lowpass=f=3800")),
        # the dream family --------------------------------------------------------------------
        # a dream: soft top end, a slow gentle shimmer and a big dark wash behind the words
        "dream": ("lowpass=f=5200,chorus=0.7:0.9:40|55:0.3|0.25:0.25|0.4:2|2.3,"
                  + reverb("dream", 0.6, pre="highpass=f=250", post="lowpass=f=4500")),
        # a flashback: faded and a little worn, like an old film, in a mid-sized memory room
        "flashback": (_band(200, 4200) + ",equalizer=f=1200:t=q:w=1:g=3,vibrato=f=0.8:d=0.03,"
                      + reverb("memory", 0.45, pre="highpass=f=300")),
        # a nightmare: pitched down, slowly swirling, swallowed by a dark endless space
        "nightmare": ("aresample=24000,asetrate=24000*0.9,aresample=24000,atempo=1.1111111,"
                      "flanger=delay=3:depth=4:regen=25:width=60:speed=0.25,"
                      + reverb("abyss", 0.5, pre="highpass=f=120", post="lowpass=f=3200")),
        # heavenly or divine: open and bright, with a long airy tail — a god, an angel, a vision.
        # A generated voice has almost nothing above 6 kHz to brighten, so the exciter makes
        # that air from the voice's own harmonics before the shelf lifts it.
        "heavenly": ("aresample=48000,highpass=f=120,aexciter=amount=1.5:drive=6:freq=3500,highshelf=f=5000:g=2.5,"
                     "chorus=0.7:0.9:25|38:0.25|0.2:0.3|0.45:1.5|2,"
                     + reverb("heaven", 0.65, pre="highpass=f=450")),
        # ---------------------------------------------------------------------------------------
        # heard down a phone line: the narrow band of a handset, squashed and a little gritty
        "phone": (_band(400, 3000) + ",equalizer=f=1800:t=q:w=1.2:g=4,"
                  "acompressor=threshold=-20dB:ratio=6:attack=5:release=80,"
                  "acrusher=bits=9:samples=3:mix=0.35,asoftclip=type=tanh,lowpass=f=3400"),
        # a tannoy or a radio set: a small speaker ringing in a room, with a bed of hiss
        "radio": (_band(320, 4200) + ",equalizer=f=2200:t=q:w=1:g=4,acompressor=threshold=-18dB:ratio=5,"
                  "asoftclip=type=tanh,aecho=0.9:0.5:16|70:0.2|0.12,"
                  + _hiss("pink", 0.012, "rn", "highpass=f=400")),
        # otherworldly: dropped in pitch, thin and airy, with a long tail
        "ghost": ("aresample=48000,asetrate=48000*0.92,aresample=48000,atempo=1.0869565,highpass=f=220,"
                  "aexciter=amount=1:drive=5:freq=4000,"
                  + reverb("ghost", 0.75, pre="highpass=f=500", post="lowpass=f=7000")),
        # a big hall, a temple or a cave
        "hall": reverb("hall", 0.6, pre="highpass=f=150"),
        # shouting across a valley: clear repeats that fall away, each a little further off
        "echo": "aecho=0.85:0.75:190|380|570:0.4|0.24|0.13",
        # a loudhailer at a protest or a school sports day: a honking horn, overdriven, with
        # the slap of the sound coming back off a wall
        "megaphone": (_band(650, 3400) + ",equalizer=f=1700:t=q:w=0.8:g=7,"
                      "acompressor=threshold=-22dB:ratio=8:attack=3:release=60,"
                      + drive + ",acrusher=bits=8:mix=0.2,aecho=0.8:0.45:60:0.22,lowpass=f=3800"),
        # a walkie-talkie or police radio: narrower and grittier than a phone, over static
        "walkie": (_band(550, 2600) + ",equalizer=f=1500:t=q:w=1:g=5,"
                   "acompressor=threshold=-24dB:ratio=10:attack=2:release=50,"
                   + drive + ",acrusher=bits=6:samples=3:mix=0.45,lowpass=f=3000,"
                   + _hiss("white", 0.014, "wn", "highpass=f=900,lowpass=f=3500")),
        # heard from under the water, or through a wall
        "underwater": ("lowpass=f=650,lowpass=f=900,equalizer=f=300:t=q:w=1:g=4,"
                       "vibrato=f=3.5:d=0.3,aecho=0.8:0.7:40|75:0.35|0.2"),
        # a machine or AI voice: flattened phase with a metallic ring
        "robot": ("afftfilt=real='hypot(re,im)':imag='0':win_size=512:overlap=0.75,aecho=0.8:0.88:6:0.4,"
                  "highpass=f=120,equalizer=f=2500:t=q:w=1:g=4"),
        # a demon or a monster: pitch dropped a long way, speed kept, with a growl and some size
        "monster": ("aresample=24000,asetrate=24000*0.78,aresample=24000,atempo=1.282,"
                    "equalizer=f=120:t=q:w=1:g=4,lowpass=f=3500," + drive + ","
                    + reverb("hall", 0.2, pre="highpass=f=200", post="lowpass=f=2500")),
        # an old tape or a recording from long ago: thin, boxy, wavering, over surface noise
        "vintage": (_band(280, 3400) + ",equalizer=f=1400:t=q:w=1:g=5,vibrato=f=0.7:d=0.06,"
                    "acrusher=bits=9:mix=0.3,asoftclip=type=tanh,"
                    + _hiss("pink", 0.015, "vn", "highpass=f=500")),
    }


class _LazyChains(dict):
    """Built on first use: the reverb fragments write their impulse responses to disk."""

    def _fill(self):
        if not dict.__len__(self):
            self.update(_voice_fx_chains())

    def __getitem__(self, k):
        self._fill()
        return dict.__getitem__(self, k)

    def get(self, k, default=None):
        self._fill()
        return dict.get(self, k, default)

    def __contains__(self, k):
        self._fill()
        return dict.__contains__(self, k)


VOICE_FX_CHAINS = _LazyChains()

# Bumped when an effect is re-tuned, so restyled copies made with the old sound aren't reused
VOICE_FX_VERSION = 3

VOICE_FX_LABELS = {
    "normal": "Normal",
    "inner": "Inner voice",
    "dream": "Dream",
    "flashback": "Flashback",
    "nightmare": "Nightmare",
    "heavenly": "Heavenly / divine",
    "phone": "Phone call",
    "radio": "Radio / PA",
    "ghost": "Ghostly",
    "hall": "Hall / temple",
    "echo": "Echo / canyon",
    "megaphone": "Megaphone",
    "walkie": "Walkie-talkie",
    "underwater": "Underwater",
    "robot": "Robot / AI",
    "monster": "Monster / demon",
    "vintage": "Old recording",
}


def _mean_volume_db(path: str) -> Optional[float]:
    proc = subprocess.run(
        [_get_ffmpeg(), "-i", path, "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True, timeout=30,
    )
    m = re.search(r"mean_volume:\s*(-?[\d.]+) dB", proc.stderr)
    return float(m.group(1)) if m else None


def _loudness(path: str) -> Optional[float]:
    """How loud the clip sounds (LUFS, as if mixed to both speakers), or its plain average
    level when it is too short to measure that way."""
    proc = subprocess.run(
        [_get_ffmpeg(), "-hide_banner", "-nostats", "-i", path, "-af", "ebur128", "-f", "null", "-"],
        capture_output=True, text=True, timeout=30,
    )
    found = re.findall(r"\bI:\s*(-?[\d.]+) LUFS", proc.stderr)
    if not found or float(found[-1]) <= -69:
        return _mean_volume_db(path)
    # A mono clip is played from both speakers, which the meter does not count; a stereo one
    # already is. Without this a stereo reverb would be matched 3 dB too quiet.
    mono = bool(re.search(r"Audio:.*\bmono\b", proc.stderr))
    return float(found[-1]) + (3.01 if mono else 0.0)


def render_voice_fx(dry: str, out: str, voice_fx: str) -> None:
    """Style an already-finished voice, keeping its length and its loudness.

    Band-limited styles (phone, walkie, megaphone) throw away most of a voice's energy and
    would otherwise sit several dB under the lines around them, so the styled copy is brought
    back to how loud the clean voice sounds, with a limiter guarding the peaks. Loudness is
    judged as the ear does: by plain signal level a megaphone or a robot voice came out
    about 2 dB quieter than the lines around it.
    """
    chain = VOICE_FX_CHAINS[voice_fx]
    length = _probe_duration(_get_ffmpeg(), dry)
    trim = []
    if length > 0.3:
        # Echo tails would run the line past its caption and out of sync with fitted timing
        chain += f",afade=t=out:st={length - 0.15:.3f}:d=0.15"
        trim = ["-t", f"{length:.3f}"]
    wet = f"{out}.wet.wav"
    try:
        proc = subprocess.run([_get_ffmpeg(), "-y", "-i", dry, *trim, "-af", chain, wet],
                              capture_output=True, text=True, timeout=30)
        if proc.returncode or not os.path.isfile(wet):
            raise RuntimeError(f"Could not apply voice effect: {proc.stderr[-300:]}")
        before, after = _loudness(dry), _loudness(wet)
        # A megaphone or a robot voice loses about 14 dB on the way through, so the ceiling
        # has to be above that; the limiter is left at unity so it only catches peaks.
        gain = 0.0 if before is None or after is None else max(-6.0, min(18.0, before - after))
        proc = subprocess.run(
            [_get_ffmpeg(), "-y", "-i", wet, "-af", f"volume={gain:.2f}dB,alimiter=limit=0.95:level=0",
             *_codec_for_ext(out), out],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode or not os.path.isfile(out) or os.path.getsize(out) == 0:
            raise RuntimeError(f"Could not apply voice effect: {proc.stderr[-300:]}")
    finally:
        _cleanup_files([wet])


async def _apply_voice_filters(path, voice_profile, emotion, voice_fx):
    chain = _build_filter_chain(voice_profile=voice_profile, emotion=emotion, voice_fx=voice_fx)
    output = os.path.join(os.path.dirname(path), f"{uuid.uuid4()}_fx{os.path.splitext(path)[1]}")
    command = [_get_ffmpeg(), '-y', '-i', path, '-af', chain] + _codec_for_ext(output) + [output]
    result = await asyncio.to_thread(subprocess.run, command, capture_output=True, text=True, timeout=30)
    if result.returncode or not os.path.isfile(output) or os.path.getsize(output) == 0:
        _cleanup_files([output])
        raise RuntimeError(f"Could not apply voice effect: {result.stderr[-300:]}")
    _cleanup_files([path])
    return output


def _build_filter_chain(voice_profile: str = "", emotion: str = "", atempo_filters: Optional[list[str]] = None,
                        voice_fx: str = "") -> str:
    """Build cinematic broadcast mastering audio graph for punchy, catchy, clear vocal delivery."""
    filters = []

    vp = (voice_profile or "").lower().strip()
    em = (emotion or "").lower().strip()

    # 1. Clean low-end rumble (HPF at 75Hz)
    filters.append("highpass=f=75")

    # 2. Vocal Presence & Warmth EQ (crisp high-mids for intelligibility + warm body)
    if vp in ("grandpa", "elderly_male"):
        filters.append("equalizer=f=180:t=q:w=1.2:g=2.2,equalizer=f=3200:t=q:w=1.2:g=1.5")
    elif vp in ("grandma", "elderly_female"):
        filters.append("equalizer=f=350:t=q:w=1.2:g=1.5,equalizer=f=3000:t=q:w=1.2:g=1.8")
    elif vp in ("child_boy", "child_girl", "child", "boy", "girl"):
        filters.append("equalizer=f=400:t=q:w=1.2:g=-1.0,equalizer=f=4000:t=q:w=1.2:g=2.5")
    elif vp == "male":
        filters.append("equalizer=f=200:t=q:w=1.2:g=1.8,equalizer=f=3300:t=q:w=1.2:g=2.2")
    else:
        filters.append("equalizer=f=280:t=q:w=1.2:g=1.2,equalizer=f=3500:t=q:w=1.2:g=2.4")

    # 3. Dynamic Emotion Tone Enhancements
    if em in ("laughing", "laugh", "happy", "cheerful", "playful"):
        filters.append("equalizer=f=5000:t=q:w=1.2:g=1.8")
    elif em in ("excited", "scream", "shout"):
        filters.append("equalizer=f=3800:t=q:w=1.0:g=2.0")

    # 4. Gentle broadcast vocal compressor (keeps dialogue punchy, tight, and audible over BGM)
    filters.append("acompressor=threshold=-18dB:ratio=2.5:attack=15:release=120:makeup=2dB")

    # 5. Clean peak limiter
    filters.append("alimiter=limit=0.96")

    # Fit the line to its slot before styling it: a reverb or an echo that is sped up along
    # with the words rings unnaturally fast.
    if atempo_filters:
        filters.extend(atempo_filters)

    # The style goes last so it colours the finished voice rather than being flattened by the
    # compressor and limiter above.
    style = VOICE_FX_CHAINS.get((voice_fx or "").lower().strip())
    if style:
        filters.append(style)

    return ",".join(filters) if filters else ""


def _build_tempo_cmd(
    ffmpeg: str,
    input_path: str,
    output_path: str,
    target_duration: float,
    max_speedup: float = 2.0,
    voice_profile: str = "",
    emotion: str = "",
    voice_fx: str = "",
) -> list:
    """Build ffmpeg command to apply child formant/pitch filters, emotion enhancements, and tempo adjustment."""
    probe_cmd = [
        ffmpeg.replace("ffmpeg", "ffprobe") if "ffmpeg" in ffmpeg else "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        input_path,
    ]
    try:
        probe = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=10)
        input_duration = float(probe.stdout.strip())
    except (ValueError, subprocess.TimeoutExpired):
        input_duration = target_duration

    atempo_filters = []
    if input_duration > 0 and target_duration > 0:
        tempo = input_duration / target_duration
        if tempo > 1.001:
            tempo = min(tempo, max_speedup)
            remaining = tempo
            while remaining > 2.0:
                atempo_filters.append("atempo=2.0")
                remaining /= 2.0
            if remaining > 1.001:
                atempo_filters.append(f"atempo={remaining:.4f}")
        elif tempo < 0.999:
            remaining = max(0.2, tempo)
            while remaining < 0.5:
                atempo_filters.append("atempo=0.5")
                remaining /= 0.5
            if remaining < 0.999:
                atempo_filters.append(f"atempo={remaining:.4f}")

    af = _build_filter_chain(voice_profile=voice_profile, emotion=emotion, atempo_filters=atempo_filters, voice_fx=voice_fx)

    if af:
        return [
            ffmpeg, "-y",
            "-i", input_path,
            "-af", af,
        ] + _codec_for_ext(output_path) + [
            output_path,
        ]

    return [ffmpeg, "-y", "-i", input_path] + _codec_for_ext(output_path) + [output_path]


def build_retime_cmd(ffmpeg: str, input_path: str, output_path: str, tempo: float) -> list:
    """Change the speed of a finished voice and nothing else.

    `_build_tempo_cmd` masters a raw voice (EQ, compressor, limiter) while it fits it. Using
    it again on a clip that is already mastered stacks that processing, so a line re-fitted
    a few times got brighter and more squashed each time.
    """
    steps, remaining = [], max(0.25, min(4.0, tempo))
    while remaining > 2.0:
        steps.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        steps.append("atempo=0.5")
        remaining /= 0.5
    steps.append(f"atempo={remaining:.4f}")
    return [ffmpeg, "-y", "-i", input_path, "-af", ",".join(steps)] + _codec_for_ext(output_path) + [output_path]


def _cleanup_files(paths: list[str]):
    for p in paths:
        try:
            if p and os.path.exists(p):
                os.remove(p)
        except Exception:
            pass
