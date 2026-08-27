from __future__ import annotations
import os
import uuid
import asyncio
import subprocess
import shutil
from typing import Optional
from backend.config import settings

import re

# Voice mapping by language
VOICE_MAP = {
    "km": {
        "female": "km-KH-SreymomNeural",
        "male": "km-KH-PisethNeural",
        "child_boy": "km-KH-PisethNeural",
        "child_girl": "km-KH-SreymomNeural",
        "child": "km-KH-SreymomNeural",
        "young": "km-KH-SreymomNeural",
        "grandpa": "km-KH-PisethNeural",
        "grandma": "km-KH-SreymomNeural",
        "old": "km-KH-PisethNeural",
    },
    "zh": {
        "female": "zh-CN-XiaoxiaoNeural",
        "male": "zh-CN-YunxiNeural",
        "child_boy": "zh-CN-XiaoyiNeural",
        "child_girl": "zh-CN-XiaoyiNeural",
        "child": "zh-CN-XiaoyiNeural",
        "young": "zh-CN-XiaoyiNeural",
        "grandpa": "zh-CN-YunjianNeural",
        "grandma": "zh-CN-XiaoxiaoNeural",
        "old": "zh-CN-YunjianNeural",
    },
    "en": {
        "female": "en-US-AvaMultilingualNeural",
        "male": "en-US-AndrewMultilingualNeural",
        "child_boy": "en-US-AnaNeural",
        "child_girl": "en-US-AnaNeural",
        "child": "en-US-AnaNeural",
        "young": "en-US-AnaNeural",
        "grandpa": "en-US-EricNeural",
        "grandma": "en-US-JennyNeural",
        "old": "en-US-EricNeural",
    },
    "ja": {
        "female": "ja-JP-NanamiNeural",
        "male": "ja-JP-KeitaNeural",
        "child_boy": "ja-JP-KeitaNeural",
        "child_girl": "ja-JP-NanamiNeural",
        "child": "ja-JP-NanamiNeural",
        "young": "ja-JP-NanamiNeural",
        "grandpa": "ja-JP-KeitaNeural",
        "grandma": "ja-JP-NanamiNeural",
        "old": "ja-JP-KeitaNeural",
    },
    "ko": {
        "female": "ko-KR-SunHiNeural",
        "male": "ko-KR-InJoonNeural",
        "child_boy": "ko-KR-InJoonNeural",
        "child_girl": "ko-KR-SunHiNeural",
        "child": "ko-KR-SunHiNeural",
        "young": "ko-KR-SunHiNeural",
        "grandpa": "ko-KR-InJoonNeural",
        "grandma": "ko-KR-SunHiNeural",
        "old": "ko-KR-InJoonNeural",
    },
}

# Default fallback (Khmer)
DEFAULT_VOICE_MAP = VOICE_MAP["km"]

VOICE_POOLS = {
    "km": {
        "female": ["km-KH-SreymomNeural"],
        "male": ["km-KH-PisethNeural"],
        "child_boy": ["km-KH-PisethNeural"],
        "child_girl": ["km-KH-SreymomNeural"],
        "child": ["km-KH-SreymomNeural"],
        "grandpa": ["km-KH-PisethNeural"],
        "grandma": ["km-KH-SreymomNeural"],
    },
    "zh": {
        "female": ["zh-CN-XiaoxiaoNeural", "zh-CN-XiaoyiNeural", "zh-CN-liaoning-XiaobeiNeural", "zh-CN-shaanxi-XiaoniNeural"],
        "male": ["zh-CN-YunxiNeural", "zh-CN-YunjianNeural", "zh-CN-YunyangNeural", "zh-CN-YunxiaNeural"],
        "child": ["zh-CN-XiaoyiNeural"],
    },
    "en": {
        "female": ["en-US-AvaMultilingualNeural", "en-US-JennyNeural", "en-US-AriaNeural", "en-US-MichelleNeural"],
        "male": ["en-US-AndrewMultilingualNeural", "en-US-GuyNeural", "en-US-ChristopherNeural", "en-US-BrianNeural"],
        "child": ["en-US-AnaNeural"],
    },
    "ja": {
        "female": ["ja-JP-NanamiNeural", "ja-JP-MayuNeural", "ja-JP-AoiNeural"],
        "male": ["ja-JP-KeitaNeural", "ja-JP-DaichiNeural", "ja-JP-NaokiNeural"],
        "child": ["ja-JP-NanamiNeural"],
    },
    "ko": {
        "female": ["ko-KR-SunHiNeural", "ko-KR-JiMinNeural", "ko-KR-SeoHyeonNeural"],
        "male": ["ko-KR-InJoonNeural", "ko-KR-HyunsuMultilingualNeural", "ko-KR-BongJinNeural"],
        "child": ["ko-KR-SunHiNeural"],
    },
}


def assign_speaker_voices(segments: list, language: str = "") -> list:
    """Give each distinct detected speaker their own TTS voice & profile."""
    pools = VOICE_POOLS.get(language, VOICE_POOLS["km"])
    assigned: dict[tuple, str] = {}
    next_index = {"female": 0, "male": 0, "child": 0, "grandma": 0, "grandpa": 0, "child_boy": 0, "child_girl": 0}

    for seg in segments:
        vp = str(seg.get("voice_profile") or "").lower().strip()
        speaker = str(seg.get("speaker") or "").strip().lower()

        if vp in ("grandma", "elderly_female") or any(k in speaker for k in ["grandma", "grandmother", "madame", "mrs", "elderly woman", "old woman", "យាយ", "លោកយាយ", "ជីដូន", "ម៉ែ", "夫人", "婆婆", "老奶奶", "华夫人"]):
            gender = "grandma"
            seg["voice_profile"] = "grandma"
        elif vp in ("grandpa", "elderly_male") or any(k in speaker for k in ["grandpa", "grandfather", "master", "elder", "old man", "elderly man", "តា", "លោកតា", "ជីតា", "ឪ", "老爷", "老爷爷", "老太爷"]):
            gender = "grandpa"
            seg["voice_profile"] = "grandpa"
        elif vp in ("child_boy", "boy") or any(k in speaker for k in ["boy", "son", "young boy", "little boy", "ក្មេងប្រុស", "កូនប្រុស", "男孩", "童子"]):
            gender = "child_boy"
            seg["voice_profile"] = "child_boy"
        elif vp in ("child_girl", "girl") or any(k in speaker for k in ["girl", "daughter", "young girl", "little girl", "ក្មេងស្រី", "កូនស្រី", "女孩", "丫头"]):
            gender = "child_girl"
            seg["voice_profile"] = "child_girl"
        elif vp == "child" or any(k in speaker for k in ["child", "kid", "baby", "young", "ក្មេង", "កូន", "小孩"]):
            gender = "child"
            seg["voice_profile"] = "child"
        elif vp == "male" or any(k in speaker for k in ["male", "man", "lord", "officer", "scholar", "swordsman", "leader", "boss", "father", "guy", "brother", "husband", "ប្រុស", "លោក", "បង", "男", "公子", "唐伯虎", "秀才"]):
            gender = "male"
            seg["voice_profile"] = "male"
        else:
            gender = "female"
            seg["voice_profile"] = "female"

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


def _emotion_prosody(emotion: str, base_rate: str = "+0%", voice_profile: str = "") -> tuple[str, str, str]:
    """Combine the caller's rate with emotion offsets and voice profile → (rate, pitch, volume)."""
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
    return (f"{base + r:+d}%", f"{p:+d}Hz", f"{v:+d}%")


def _detect_text_language(text: str) -> str:
    """Detect language from text using character ranges."""
    # Count characters in each script
    cjk = len(re.findall(r'[\u4e00-\u9fff\u3400-\u4dbf]', text))
    khmer = len(re.findall(r'[\u1780-\u17ff]', text))
    japanese = len(re.findall(r'[\u3040-\u309f\u30a0-\u30ff]', text))
    korean = len(re.findall(r'[\uac00-\ud7af\u1100-\u11ff]', text))
    latin = len(re.findall(r'[a-zA-Z]', text))

    counts = {"zh": cjk, "km": khmer, "ja": japanese + cjk, "ko": korean, "en": latin}
    # Japanese detection: if both CJK and kana present, it's Japanese
    if japanese > 0:
        counts["ja"] = japanese + cjk
        counts["zh"] = 0
    best = max(counts, key=lambda k: counts[k])
    return best if counts[best] > 0 else ""


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


# Map voice_profile + emotion → VoxCPM natural-language voice description
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
    emotion_map = {
        "cheerful": "cheerful and bright",
        "happy": "warm and happy",
        "sad": "soft and melancholic",
        "angry": "firm and intense",
        "excited": "energetic and excited",
        "calm": "calm and soothing",
        "serious": "clear and professional",
        "fearful": "tense and anxious",
        "whisper": "soft whispering and breathy",
        "neutral": "natural and clear",
        "": "natural and clear",
    }
    age = age_map.get(voice_profile, "middle-aged")
    gender = gender_map.get(voice_profile, "female")
    tone = emotion_map.get(emotion or "", "natural and clear")
    description = f"A {age} {gender}, {tone} voice"
    return f"({description}){text}"


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


def _get_voxcpm_reference(model, voice_profile: str) -> tuple[str, str]:
    """Return (ref_wav_path, ref_text) for a voice profile.

    Voice design draws a new random speaker on every generation — even with a
    fixed seed the voice varies with the text. To keep ONE voice across all
    segments, we synthesize a reference sample once per profile (seeded voice
    design), cache it on disk, and clone from it for every segment.
    """
    ref_dir = os.path.join(settings.upload_dir, "tts", "voxcpm_refs")
    os.makedirs(ref_dir, exist_ok=True)
    ref_path = os.path.join(ref_dir, f"{voice_profile}.wav")
    if not os.path.exists(ref_path):
        import random
        import numpy as np
        import soundfile as sf
        import torch
        seed = _VOXCPM_VOICE_SEEDS.get(voice_profile, 42)
        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)
        prompt = _build_voxcpm_prompt(_VOXCPM_REF_TEXT, voice_profile, "neutral")
        wav = model.generate(
            prompt,
            cfg_value=2.0,
            inference_timesteps=max(10, settings.voxcpm_inference_steps),
            normalize=False,
        )
        sf.write(ref_path, np.array(wav), model.tts_model.sample_rate)
    return ref_path, _VOXCPM_REF_TEXT


def _estimated_speech_seconds(text: str) -> float:
    """Rough estimate (seconds) of how long the spoken text should be,
    weighted by script (a CJK char is a syllable; Khmer/Latin chars are not)."""
    khmer = len(re.findall(r"[ក-៿]", text))
    cjk = len(re.findall(r"[一-鿿]", text))
    latin = len(re.findall(r"[A-Za-z]", text))
    other = max(len(text) - khmer - cjk - latin, 0)
    return khmer * 0.09 + cjk * 0.30 + latin * 0.08 + other * 0.04


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

    model = await asyncio.to_thread(_get_voxcpm_model)
    infer_steps = timesteps or settings.voxcpm_inference_steps or 10

    def _generate():
        if reference_wav_path and os.path.exists(reference_wav_path):
            return model.generate(
                text,
                reference_wav_path=reference_wav_path,
                cfg_value=2.0,
                inference_timesteps=infer_steps,
                normalize=False,
            )
        ref_wav, ref_text = _get_voxcpm_reference(model, voice_profile)
        return model.generate(
            text,
            prompt_wav_path=ref_wav,
            prompt_text=ref_text,
            cfg_value=2.0,
            inference_timesteps=infer_steps,
            normalize=False,
        )

    sample_rate = model.tts_model.sample_rate
    est = _estimated_speech_seconds(text)
    ceiling = max(2.0, est * 1.8 + 0.8)
    floor = est * 0.45

    # Run primary generation
    candidate = await asyncio.to_thread(_generate)
    dur = len(candidate) / sample_rate

    # If first pass is within normal duration window, use it directly (saves 2x-3x time!)
    if floor <= dur <= ceiling:
        wav = candidate
    else:
        attempts = [(dur, candidate)]
        for _ in range(2):
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


def _clean_and_detect_emotion(text: str, default_emotion: str = "") -> tuple[str, str]:
    """Extract emotion from direction tags, strip all bracketed notes, and detect emotional keywords."""
    detected_emotion = ""
    # If default_emotion is provided and NOT "neutral", treat it as an explicit emotion choice
    if default_emotion and default_emotion.lower().strip() not in ("neutral", "auto", "default", "none", ""):
        detected_emotion = default_emotion.lower().strip()

    bracket_tags = re.findall(r'[\(\[\{]([^\)\]\}]+)[\)\]\}]', text)
    for tag_str in bracket_tags:
        t = tag_str.lower().strip()
        if any(k in t for k in ("whisper", "ខ្សឹប", "secret", "breathy", "shh", "psst")):
            detected_emotion = "whisper"
        elif any(k in t for k in ("fear", "fearful", "scared", "terrified", "panic", "panicked", "ភ័យ", "ខ្លាច")):
            detected_emotion = "fearful"
        elif any(k in t for k in ("scream", "screaming", "shout", "shouting", "yell", "yelling", "roar", "ស្រែក")):
            detected_emotion = "scream"
        elif any(k in t for k in ("angry", "furious", "mad", "rage", "ខឹង", "កំហឹង")):
            detected_emotion = "angry"
        elif any(k in t for k in ("laugh", "laughing", "laughter", "chuckle", "giggle", "chuckles", "giggles", "សើច", "អស់សំណើច", "កំប្លែង", "ហាហា", "ហិហិ")):
            detected_emotion = "laughing"
        elif any(k in t for k in ("happy", "cheerful", "joy", "smile", "សប្បាយ", "រីករាយ")):
            detected_emotion = "happy"
        elif any(k in t for k in ("sad", "crying", "grief", "depressed", "melancholy", "ពិបាកចិត្ត", "យំ", "សោកសៅ")):
            detected_emotion = "sad"
        elif any(k in t for k in ("excited", "enthusiastic", "energy", "រំភើប")):
            detected_emotion = "excited"
        elif any(k in t for k in ("serious", "stern", "authoritative", "ម៉ឺងម៉ាត់")):
            detected_emotion = "serious"
        elif any(k in t for k in ("calm", "gentle", "soft", "ស្ងប់")):
            detected_emotion = "calm"

    # Also detect inline laughter keywords in text if no explicit emotion
    if not detected_emotion:
        text_lower = text.lower()
        if any(k in text_lower for k in ("ហាហា", "ហិហិ", "hahaha", "haha", "hehe", "keke", "សើច")):
            detected_emotion = "laughing"

    # Strip ALL bracketed/parenthesized direction tags so TTS NEVER pronounces them
    clean = re.sub(r'[\(\[\{][^\)\]\}]*[\)\]\}]', '', text)
    clean = re.sub(r'\s+', ' ', clean).strip()

    if not clean:
        # Segment was ONLY a bracketed tag like [Laughs] or (សើច)
        if detected_emotion in ("laughing", "happy") or any(k in text.lower() for k in ("laugh", "chuckle", "giggle", "សើច", "ហាហា", "haha")):
            has_khmer = any(0x1780 <= ord(c) <= 0x17FF for c in text)
            clean_text = "ហាហាហា!" if has_khmer else "Haha!"
            detected_emotion = "laughing"
        else:
            clean_text = text
    else:
        clean_text = clean

    return clean_text, detected_emotion or "neutral"


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


async def generate_segment_audio(
    text: str,
    voice_profile: str = "female",
    rate: str = "+0%",
    voice_name: str = "",
    language: str = "",
    emotion: str = "",
    pitch: str = "",
    engine: str = "",
    reference_audio: str = "",
    timesteps: Optional[int] = None,
    apply_fx: bool = True,
) -> str:
    clean_text, detected_emotion = _clean_and_detect_emotion(text, emotion)
    active_engine = await _get_active_tts_engine()
    requested_engine = (engine or "").lower().strip()

    # Resolve local reference audio file if provided
    ref_wav_path = ""
    if reference_audio:
        ref_audio_clean = reference_audio.replace("/uploads/", "")
        candidate_path = os.path.join(settings.upload_dir, ref_audio_clean)
        if os.path.exists(candidate_path):
            ref_wav_path = candidate_path
        elif os.path.exists(reference_audio):
            ref_wav_path = reference_audio

    # Determine whether to use VoxCPM or Edge-TTS:
    # 1. If global active_engine == "edge-tts" or requested_engine == "edge-tts":
    #    STRICTLY enforce Edge-TTS (clear any legacy voxcpm voice names)
    # 2. If global active_engine == "voxcpm" or requested_engine == "voxcpm":
    #    Use VoxCPM (with voice cloning if ref_wav_path is present)
    # 3. Otherwise default to Edge-TTS
    is_voxcpm = False
    if active_engine == "edge-tts" or requested_engine.startswith("edge"):
        is_voxcpm = False
        if voice_name and "voxcpm" in voice_name.lower():
            voice_name = ""
    elif active_engine == "voxcpm" or requested_engine == "voxcpm":
        is_voxcpm = True
    elif voice_name and "voxcpm" in voice_name.lower():
        is_voxcpm = True
    elif bool(ref_wav_path) and active_engine != "edge-tts":
        is_voxcpm = True
    if is_voxcpm:
        try:
            return await _generate_voxcpm_audio(
                clean_text,
                voice_profile,
                detected_emotion,
                reference_wav_path=ref_wav_path,
                timesteps=timesteps,
            )
        except Exception as e:
            print(f"[VoxCPM] Generation failed: {e}. Falling back to Edge-TTS.")
            if voice_name and "voxcpm" in voice_name.lower():
                voice_name = ""

    import edge_tts

    detected_lang = _detect_text_language(clean_text)
    lang = detected_lang or language or ""

    if voice_name:
        voice = voice_name
    else:
        lang_map = VOICE_MAP.get(lang, DEFAULT_VOICE_MAP)
        voice = lang_map.get(voice_profile, lang_map.get("female", DEFAULT_VOICE_MAP["female"]))

    tts_rate, tts_pitch, tts_volume = _emotion_prosody(detected_emotion, rate, voice_profile=voice_profile)
    if pitch and pitch != "+0Hz":
        tts_pitch = pitch

    export_dir = os.path.join(settings.upload_dir, "tts")
    os.makedirs(export_dir, exist_ok=True)

    import hashlib
    cache_key = hashlib.sha256(f"{clean_text}_{voice}_{tts_rate}_{tts_pitch}_{detected_emotion}_{apply_fx}".encode("utf-8")).hexdigest()
    cache_file = os.path.join(export_dir, f"cache_{cache_key}.mp3")
    if os.path.exists(cache_file) and os.path.getsize(cache_file) > 0:
        target_path = os.path.join(export_dir, f"{uuid.uuid4()}.mp3")
        shutil.copyfile(cache_file, target_path)
        return target_path

    output_path = os.path.join(export_dir, f"{uuid.uuid4()}.mp3")

    communicate = None
    last_err = None
    for attempt in range(3):
        try:
            communicate = edge_tts.Communicate(clean_text, voice, rate=tts_rate, pitch=tts_pitch, volume=tts_volume)
            await communicate.save(output_path)
            if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                break
        except Exception as e:
            last_err = e
            if attempt < 2:
                await asyncio.sleep(0.3 * (attempt + 1))

    if last_err and (not os.path.exists(output_path) or os.path.getsize(output_path) == 0):
        raise last_err

    # Apply transparent mastering filter graph
    if apply_fx:
        filter_chain = _build_filter_chain(voice_profile=voice_profile, emotion=detected_emotion)
        if filter_chain and os.path.exists(output_path):
            ffmpeg = _get_ffmpeg()
            filtered_path = os.path.join(export_dir, f"{uuid.uuid4()}_fx.mp3")
            fx_cmd = [ffmpeg, "-y", "-i", output_path, "-af", filter_chain] + _codec_for_ext(filtered_path) + [filtered_path]
            try:
                res = await asyncio.to_thread(subprocess.run, fx_cmd, capture_output=True, text=True, timeout=30)
                if res.returncode == 0 and os.path.exists(filtered_path) and os.path.getsize(filtered_path) > 0:
                    _cleanup_files([output_path])
                    try:
                        shutil.copyfile(filtered_path, cache_file)
                    except OSError:
                        pass
                    return filtered_path
            except Exception:
                pass

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
    engine: str = "",
    reference_audio: str = "",
    max_duration: Optional[float] = None,
    max_speedup: Optional[float] = 2.0,
) -> tuple:
    """Generate TTS audio for a single segment.

    Speech dynamically scales speed (atempo) to finish speaking within the allocated
    time limit before the next segment starts, completely preventing voice overlap.
    Returns (path_to_fitted_mp3, actual_duration)."""
    clean_text, detected_emotion = _clean_and_detect_emotion(text, emotion)
    raw_path = await generate_segment_audio(
        clean_text,
        voice_profile,
        rate,
        voice_name=voice_name,
        language=language,
        emotion=detected_emotion,
        engine=engine,
        reference_audio=reference_audio,
        apply_fx=False,
    )

    ffmpeg = _get_ffmpeg()
    export_dir = os.path.join(settings.upload_dir, "tts")
    fitted_path = os.path.join(export_dir, f"{uuid.uuid4()}_fitted.mp3")

    # Probe the natural audio duration
    raw_duration = _probe_duration(ffmpeg, raw_path)
    spd_cap = min(3.0, max(1.2, max_speedup)) if max_speedup is not None else 2.5

    if raw_duration > 0 and target_duration > 0:
        # Determine ceiling: if max_duration is specified and > 0, use it, else lock to target_duration
        ceiling = max_duration if (max_duration is not None and max_duration > 0) else target_duration

        if raw_duration <= target_duration:
            # Voice naturally fits inside the character's speaking window
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
    )
    result = await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=True, timeout=120
    )
    _cleanup_files([raw_path])

    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg tempo failed: {result.stderr[-300:]}")

    return fitted_path, actual_duration


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


def _build_filter_chain(voice_profile: str = "", emotion: str = "", atempo_filters: Optional[list[str]] = None) -> str:
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

    if atempo_filters:
        filters.extend(atempo_filters)

    return ",".join(filters) if filters else ""


def _build_tempo_cmd(
    ffmpeg: str,
    input_path: str,
    output_path: str,
    target_duration: float,
    max_speedup: float = 2.0,
    voice_profile: str = "",
    emotion: str = "",
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
            remaining = max(0.5, tempo)
            while remaining < 0.5:
                atempo_filters.append("atempo=0.5")
                remaining /= 0.5
            if remaining < 0.999:
                atempo_filters.append(f"atempo={remaining:.4f}")

    af = _build_filter_chain(voice_profile=voice_profile, emotion=emotion, atempo_filters=atempo_filters)

    if af:
        return [
            ffmpeg, "-y",
            "-i", input_path,
            "-af", af,
        ] + _codec_for_ext(output_path) + [
            output_path,
        ]

    return [ffmpeg, "-y", "-i", input_path] + _codec_for_ext(output_path) + [output_path]


def _cleanup_files(paths: list[str]):
    for p in paths:
        try:
            if p and os.path.exists(p):
                os.remove(p)
        except Exception:
            pass
