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
        "young": "km-KH-SreymomNeural",
        "old": "km-KH-PisethNeural",
    },
    "zh": {
        "female": "zh-CN-XiaoxiaoNeural",
        "male": "zh-CN-YunxiNeural",
        "young": "zh-CN-XiaoyiNeural",
        "old": "zh-CN-YunjianNeural",
    },
    "en": {
        "female": "en-US-AvaMultilingualNeural",
        "male": "en-US-AndrewMultilingualNeural",
        "young": "en-US-AnaNeural",
        "old": "en-US-EricNeural",
    },
    "ja": {
        "female": "ja-JP-NanamiNeural",
        "male": "ja-JP-KeitaNeural",
        "young": "ja-JP-NanamiNeural",
        "old": "ja-JP-KeitaNeural",
    },
    "ko": {
        "female": "ko-KR-SunHiNeural",
        "male": "ko-KR-InJoonNeural",
        "young": "ko-KR-SunHiNeural",
        "old": "ko-KR-InJoonNeural",
    },
}

# Default fallback (Khmer)
DEFAULT_VOICE_MAP = VOICE_MAP["km"]

# Emotion → prosody offsets (rate %, pitch Hz, volume %).
# edge-tts applies these natively for every voice, including Khmer —
# unlike SSML express-as styles, which the Edge endpoint rejects
# (it reads the XML tags aloud).
EMOTION_PROSODY: dict[str, tuple[int, int, int]] = {
    "cheerful": (6, 15, 5),
    "happy": (6, 15, 5),
    "excited": (12, 25, 10),
    "sad": (-10, -15, -5),
    "angry": (8, -5, 15),
    "calm": (-6, -5, 0),
    "serious": (-4, -10, 0),
    "fearful": (10, 20, 0),
}


def _emotion_prosody(emotion: str, base_rate: str = "+0%") -> tuple[str, str, str]:
    """Combine the caller's rate with emotion offsets → (rate, pitch, volume)."""
    try:
        base = int(base_rate.strip().rstrip("%"))
    except ValueError:
        base = 0
    r, p, v = EMOTION_PROSODY.get((emotion or "").lower(), (0, 0, 0))
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
                # float16 on MPS/CUDA for ~2× faster inference
                try:
                    if device in ("mps", "cuda"):
                        _voxcpm_model = _voxcpm_model.to(device).half()
                    else:
                        _voxcpm_model = _voxcpm_model.to(device)
                except Exception:
                    try:
                        _voxcpm_model = _voxcpm_model.to(device)
                    except Exception:
                        pass
                print("[VoxCPM] Model ready.")
    return _voxcpm_model


# Map voice_profile + emotion → VoxCPM natural-language voice description
def _build_voxcpm_prompt(text: str, voice_profile: str, emotion: str) -> str:
    """Prepend a VoxCPM voice design description to the text."""
    age_map = {
        "young": "young",
        "old": "elderly",
        "female": "middle-aged",
        "male": "middle-aged",
    }
    gender_map = {
        "female": "female",
        "young": "female",
        "male": "male",
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
        "neutral": "natural and clear",
        "": "natural and clear",
    }
    age = age_map.get(voice_profile, "middle-aged")
    gender = gender_map.get(voice_profile, "female")
    tone = emotion_map.get(emotion or "", "natural and clear")
    description = f"A {age} {gender}, {tone} voice"
    return f"({description}){text}"


# Fixed seed per voice profile, used once to create the reference sample.
_VOXCPM_VOICE_SEEDS = {"female": 42, "male": 1337, "young": 7, "old": 99}

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


async def _generate_voxcpm_audio(
    text: str,
    voice_profile: str = "female",
    emotion: str = "",
) -> str:
    """Generate TTS audio with VoxCPM2, cloning the profile's reference voice."""
    import soundfile as sf
    import numpy as np

    model = await asyncio.to_thread(_get_voxcpm_model)

    def _generate():
        ref_wav, ref_text = _get_voxcpm_reference(model, voice_profile)
        return model.generate(
            text,
            prompt_wav_path=ref_wav,
            prompt_text=ref_text,
            cfg_value=2.0,
            inference_timesteps=settings.voxcpm_inference_steps,
            normalize=False,
        )

    wav = await asyncio.to_thread(_generate)

    export_dir = os.path.join(settings.upload_dir, "tts")
    os.makedirs(export_dir, exist_ok=True)
    output_path = os.path.join(export_dir, f"{uuid.uuid4()}.wav")

    sample_rate = model.tts_model.sample_rate
    await asyncio.to_thread(sf.write, output_path, np.array(wav), sample_rate)

    return output_path


async def generate_segment_audio(
    text: str,
    voice_profile: str = "female",
    rate: str = "+0%",
    voice_name: str = "",
    language: str = "",
    emotion: str = "",
) -> str:
    """Generate TTS audio for a single text segment. Returns path to mp3 file."""
    if settings.tts_engine == "voxcpm":
        return await _generate_voxcpm_audio(text, voice_profile, emotion)

    import edge_tts

    detected_lang = _detect_text_language(text)
    lang = detected_lang or language or ""

    if voice_name:
        voice = voice_name
    else:
        lang_map = VOICE_MAP.get(lang, DEFAULT_VOICE_MAP)
        voice = lang_map.get(voice_profile, lang_map.get("female", DEFAULT_VOICE_MAP["female"]))

    tts_rate, tts_pitch, tts_volume = _emotion_prosody(emotion, rate)

    export_dir = os.path.join(settings.upload_dir, "tts")
    os.makedirs(export_dir, exist_ok=True)

    output_path = os.path.join(export_dir, f"{uuid.uuid4()}.mp3")

    communicate = edge_tts.Communicate(text, voice, rate=tts_rate, pitch=tts_pitch, volume=tts_volume)
    await communicate.save(output_path)

    return output_path


async def generate_fitted_segment_audio(
    text: str,
    voice_profile: str = "female",
    target_duration: float = 3.0,
    rate: str = "+0%",
    voice_name: str = "",
    language: str = "",
    emotion: str = "",
    max_duration: Optional[float] = None,
) -> tuple:
    """Generate TTS audio for a single segment.

    Speech always plays at natural pace when possible: if it's longer than
    target_duration, the segment extends into the free room before the next
    segment (max_duration). Only when even that room is too small is the
    speech compressed (up to 2×) so it can never overlap the next segment.
    Returns (path_to_fitted_mp3, actual_duration)."""
    raw_path = await generate_segment_audio(text, voice_profile, rate, voice_name=voice_name, language=language, emotion=emotion)

    ffmpeg = _get_ffmpeg()
    export_dir = os.path.join(settings.upload_dir, "tts")
    fitted_path = os.path.join(export_dir, f"{uuid.uuid4()}_fitted.mp3")

    # Probe the natural audio duration
    raw_duration = _probe_duration(ffmpeg, raw_path)

    if raw_duration > 0 and target_duration > 0:
        if max_duration is None:
            room = max(raw_duration, target_duration)  # no neighbor — extend freely
        else:
            room = max(target_duration, max_duration)
        if raw_duration <= room:
            # Natural pace; extends into free room when longer than the slot
            actual_duration = raw_duration
        else:
            # Room exhausted — compress (up to 2×) to avoid overlapping the next segment
            tempo = min(raw_duration / room, 2.0)
            actual_duration = raw_duration / tempo
    else:
        actual_duration = target_duration

    # Pass the exact tempo we decided on — _build_tempo_cmd's own cap
    # defaults to 1.0 and would otherwise silently skip the speed-up.
    tempo_cap = raw_duration / actual_duration if actual_duration > 0 else 1.0
    cmd = _build_tempo_cmd(ffmpeg, raw_path, fitted_path, actual_duration, max_speedup=max(1.0, tempo_cap))
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


def _build_tempo_cmd(ffmpeg: str, input_path: str, output_path: str, target_duration: float, max_speedup: float = 1.0) -> list:
    """Build ffmpeg command to adjust audio tempo to fit target duration."""
    # Get input duration first
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
        input_duration = target_duration  # fallback: no tempo change

    if input_duration <= 0 or target_duration <= 0:
        # Simple copy/convert
        return [ffmpeg, "-y", "-i", input_path] + _codec_for_ext(output_path) + [output_path]

    tempo = input_duration / target_duration
    # Only speed up, never slow down — if audio is shorter than target, keep natural speed
    if tempo < 1.0:
        # Audio is already shorter than target; no need to stretch/slow it
        return [ffmpeg, "-y", "-i", input_path] + _codec_for_ext(output_path) + [output_path]
    # Cap speedup so speech doesn't become unintelligible
    tempo = min(tempo, max_speedup)

    # Chain atempo filters if needed (each can handle 0.5-100.0 range)
    atempo_filters = []
    remaining = tempo
    while remaining > 100.0:
        atempo_filters.append("atempo=100.0")
        remaining /= 100.0
    while remaining < 0.5:
        atempo_filters.append("atempo=0.5")
        remaining /= 0.5
    atempo_filters.append(f"atempo={remaining:.4f}")

    af = ",".join(atempo_filters)

    return [
        ffmpeg, "-y",
        "-i", input_path,
        "-af", af,
    ] + _codec_for_ext(output_path) + [
        output_path,
    ]


def _cleanup_files(paths: list[str]):
    for p in paths:
        try:
            if p and os.path.exists(p):
                os.remove(p)
        except Exception:
            pass
