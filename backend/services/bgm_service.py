"""Background Music (BGM) generation service.

Uses Gemini to analyze video mood, then generates fitting music
via Meta's MusicGen (audiocraft). Falls back to a simple tone generator
if audiocraft is not installed.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import uuid
from typing import Optional

from backend.config import settings


def _get_ffmpeg() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found. Please install ffmpeg: brew install ffmpeg")
    return ffmpeg


async def analyze_video_mood(video_path: str) -> dict:
    """Use Gemini to analyze a video and return a music description."""
    from backend.services.gemini_service import _configure_genai, _upload_and_wait
    import google.generativeai as genai

    await _configure_genai()
    video_file = await _upload_and_wait(video_path)
    model = genai.GenerativeModel(settings.gemini_model)

    prompt = """Analyze this video and describe what kind of background music would fit it perfectly.

Return a JSON object with these fields:
{
  "prompt": "A detailed music description for AI generation (e.g. 'upbeat lo-fi hip hop beat with soft piano and gentle drums, warm and cozy atmosphere')",
  "mood": "The overall mood (e.g. happy, sad, energetic, calm, dramatic, mysterious)",
  "genre": "Suggested genre (e.g. lo-fi, cinematic, electronic, acoustic, ambient)",
  "tempo": "Suggested tempo (slow, medium, fast)",
  "energy": "Energy level (low, medium, high)",
  "instruments": "Key instruments that would fit (e.g. piano, guitar, synth, drums)"
}

Rules:
- The "prompt" field should be a detailed, natural language description suitable for AI music generation.
- Make the music fit the video's content, mood, and pacing.
- For talking-head or narration videos, suggest subtle background music that won't overpower speech.
- For action or fast-paced content, suggest more energetic music.
- JSON ONLY: Return only the JSON object. No markdown, no explanation."""

    response = await asyncio.to_thread(
        model.generate_content,
        [video_file, prompt],
        generation_config=genai.types.GenerationConfig(
            temperature=0.7,
            response_mime_type="application/json",
            max_output_tokens=2048,
        ),
    )

    try:
        await asyncio.to_thread(genai.delete_file, video_file.name)
    except Exception:
        pass

    text = response.text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\n?", "", text)
        text = re.sub(r"\n?```$", "", text)

    try:
        # Try direct parse first
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Fix trailing commas
    fixed = re.sub(r",\s*([}\]])", r"\1", text)
    try:
        return json.loads(fixed)
    except json.JSONDecodeError:
        pass

    # Last resort: extract the prompt field with regex
    prompt_match = re.search(r'"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    mood_match = re.search(r'"mood"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    return {
        "prompt": prompt_match.group(1) if prompt_match else "gentle ambient background music, soft and calm",
        "mood": mood_match.group(1) if mood_match else "calm",
    }


async def generate_bgm(
    video_path: str,
    duration: float,
    prompt: Optional[str] = None,
    mood: Optional[str] = None,
) -> str:
    """Generate background music for a video.

    If no prompt is provided, Gemini analyzes the video first.
    Returns the path to the generated audio file.
    """
    export_dir = os.path.join(settings.upload_dir, "bgm")
    os.makedirs(export_dir, exist_ok=True)

    # Step 1: Get music description from Gemini if no prompt given
    if not prompt:
        mood_info = await analyze_video_mood(video_path)
        prompt = mood_info.get("prompt", "gentle ambient background music, soft and calm")
        mood = mood_info.get("mood", mood)

    # Step 2: Try MusicGen, fall back to ambient tone
    output_path = os.path.join(export_dir, f"{uuid.uuid4()}_bgm.wav")

    try:
        await _generate_with_musicgen(prompt, duration, output_path)
    except ImportError:
        # audiocraft not installed — generate simple ambient audio
        await _generate_ambient_tone(duration, output_path, mood or "calm")

    # Step 3: Convert to mp3 for smaller file size
    mp3_path = output_path.replace(".wav", ".mp3")
    ffmpeg = _get_ffmpeg()
    cmd = [ffmpeg, "-y", "-i", output_path, "-codec:a", "libmp3lame", "-b:a", "192k", mp3_path]
    result = await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=True, timeout=120
    )
    if result.returncode == 0 and os.path.exists(mp3_path):
        try:
            os.remove(output_path)
        except OSError:
            pass
        return mp3_path

    return output_path


async def _generate_with_musicgen(prompt: str, duration: float, output_path: str):
    """Generate music using Meta's MusicGen model."""
    import torch
    from audiocraft.models import MusicGen
    import soundfile as sf

    def _do_generate():
        # Use the small model (300M params) for speed
        model = MusicGen.get_pretrained("facebook/musicgen-small")
        model.set_generation_params(
            duration=min(duration, 30),  # MusicGen max ~30s per chunk
            temperature=1.0,
            top_k=250,
            top_p=0.0,
        )

        wav = model.generate([prompt])
        audio = wav[0].cpu().numpy()

        # If duration > 30s, we need to loop/extend
        if audio.shape[-1] / 32000 < duration:
            import numpy as np
            target_samples = int(duration * 32000)
            # Smooth loop by crossfading
            extended = np.tile(audio, (1, int(target_samples / audio.shape[-1]) + 1))
            audio = extended[:, :target_samples]

        # Save
        if audio.ndim == 2:
            audio = audio.T  # soundfile expects (samples, channels)
        sf.write(output_path, audio, 32000)

    await asyncio.to_thread(_do_generate)


async def _generate_ambient_tone(duration: float, output_path: str, mood: str = "calm"):
    """Generate a simple ambient background using ffmpeg synthesis.
    This is the fallback when audiocraft is not installed.
    """
    ffmpeg = _get_ffmpeg()

    # Create ambient audio with ffmpeg's audio synthesis
    # Use sine waves with different frequencies based on mood
    mood_configs = {
        "calm": {"freq1": 220, "freq2": 330, "freq3": 440, "volume": 0.5},
        "happy": {"freq1": 261, "freq2": 392, "freq3": 523, "volume": 0.55},
        "sad": {"freq1": 196, "freq2": 293, "freq3": 370, "volume": 0.45},
        "energetic": {"freq1": 330, "freq2": 440, "freq3": 554, "volume": 0.6},
        "dramatic": {"freq1": 196, "freq2": 247, "freq3": 370, "volume": 0.5},
        "mysterious": {"freq1": 185, "freq2": 277, "freq3": 370, "volume": 0.45},
    }

    config = mood_configs.get(mood, mood_configs["calm"])
    f1, f2, f3 = config["freq1"], config["freq2"], config["freq3"]
    vol = config["volume"]

    # Generate layered ambient pad using ffmpeg with richer harmonics and normalization
    filter_complex = (
        f"sine=frequency={f1}:duration={duration}:sample_rate=44100,volume={vol}[s1];"
        f"sine=frequency={f2}:duration={duration}:sample_rate=44100,volume={vol * 0.7}[s2];"
        f"sine=frequency={f3}:duration={duration}:sample_rate=44100,volume={vol * 0.5}[s3];"
        f"sine=frequency={f1 * 0.5}:duration={duration}:sample_rate=44100,volume={vol * 0.4}[s4];"
        f"[s1][s2][s3][s4]amix=inputs=4:duration=longest,"
        f"lowpass=f=3000,highpass=f=60,"
        f"afade=t=in:st=0:d=2,afade=t=out:st={max(0, duration - 3)}:d=3,"
        f"loudnorm=I=-16:TP=-1.5:LRA=11"
    )

    cmd = [
        ffmpeg, "-y",
        "-f", "lavfi", "-i", f"anullsrc=r=44100:cl=stereo",
        "-filter_complex", filter_complex,
        "-t", str(duration),
        "-codec:a", "pcm_s16le",
        output_path,
    ]

    result = await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=True, timeout=120
    )

    if result.returncode != 0:
        raise RuntimeError(f"Failed to generate ambient audio: {result.stderr[-300:]}")


async def loop_bgm_to_duration(bgm_path: str, target_duration: float) -> str:
    """Loop a BGM file to match a target duration with crossfade."""
    ffmpeg = _get_ffmpeg()
    export_dir = os.path.join(settings.upload_dir, "bgm")
    output_path = os.path.join(export_dir, f"{uuid.uuid4()}_looped.mp3")

    # Get current duration
    probe_cmd = [
        ffmpeg.replace("ffmpeg", "ffprobe"),
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        bgm_path,
    ]
    result = await asyncio.to_thread(
        subprocess.run, probe_cmd, capture_output=True, text=True, timeout=10
    )
    current_duration = float(result.stdout.strip()) if result.returncode == 0 else 30.0

    if current_duration >= target_duration:
        # Just trim with fade out
        cmd = [
            ffmpeg, "-y", "-i", bgm_path,
            "-t", str(target_duration),
            "-af", f"afade=t=out:st={max(0, target_duration - 3)}:d=3",
            "-codec:a", "libmp3lame", "-b:a", "192k",
            output_path,
        ]
    else:
        # Loop and trim
        loops_needed = int(target_duration / current_duration) + 1
        cmd = [
            ffmpeg, "-y",
            "-stream_loop", str(loops_needed),
            "-i", bgm_path,
            "-t", str(target_duration),
            "-af", f"afade=t=in:st=0:d=1,afade=t=out:st={max(0, target_duration - 3)}:d=3",
            "-codec:a", "libmp3lame", "-b:a", "192k",
            output_path,
        ]

    result = await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=True, timeout=120
    )

    if result.returncode != 0:
        raise RuntimeError(f"Failed to loop BGM: {result.stderr[-300:]}")

    return output_path
