"""Local speech-to-text using Whisper (mlx-whisper, Apple Silicon).

Transcribes the video's audio fully on-device, then translates the
segment texts to the project's target language with Gemini. If the
translation call fails (e.g. no API key / offline), the original
source-language segments are kept so transcription still succeeds.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import tempfile
import uuid
from typing import AsyncGenerator

from backend.config import settings
from backend.services.gemini_service import translate_segments


def _get_ffmpeg() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found. Please install ffmpeg: brew install ffmpeg")
    return ffmpeg


def _extract_audio(video_path: str) -> str:
    """Extract mono 16 kHz WAV (what Whisper expects) to a temp file."""
    tmp_dir = tempfile.mkdtemp(prefix="whisper_")
    audio_path = os.path.join(tmp_dir, f"{uuid.uuid4()}.wav")
    cmd = [
        _get_ffmpeg(), "-y", "-i", video_path,
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        audio_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0 or not os.path.exists(audio_path):
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise RuntimeError(f"ffmpeg audio extraction failed: {result.stderr[-300:]}")
    return audio_path


def _run_whisper(audio_path: str) -> dict:
    try:
        import mlx_whisper
    except ImportError:
        raise RuntimeError(
            "mlx-whisper is not installed. Run: pip install mlx-whisper\n"
            "Or switch the transcription engine back to 'gemini' in Settings."
        )
    return mlx_whisper.transcribe(
        audio_path,
        path_or_hf_repo=settings.whisper_model,
        word_timestamps=False,
    )


def _map_segments(result: dict) -> list:
    """Convert Whisper output to the app's segment dict shape."""
    segments = []
    for seg in result.get("segments", []):
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        segments.append({
            "start_time": float(seg.get("start", 0.0)),
            "end_time": float(seg.get("end", 0.0)),
            "text": text,
            "speaker": "",
            "voice_profile": "female",
            "emotion": "neutral",
        })
    return segments


async def transcribe_video_streaming(video_path: str, language: str = "km") -> AsyncGenerator:
    """Yield {'_progress': msg} updates, then the finished segment dicts.

    Mirrors gemini_service.transcribe_video_streaming so the SSE route can
    consume either engine interchangeably.
    """
    model_name = settings.whisper_model.rsplit("/", 1)[-1]
    yield {"_progress": "Extracting audio from video..."}
    audio_path = await asyncio.to_thread(_extract_audio, video_path)
    try:
        yield {"_progress": f"Transcribing on this Mac with {model_name} (first run downloads the model)..."}
        result = await asyncio.to_thread(_run_whisper, audio_path)
    finally:
        shutil.rmtree(os.path.dirname(audio_path), ignore_errors=True)

    segments = _map_segments(result)
    detected = (result.get("language") or "").lower()

    if segments and language and detected != language:
        yield {"_progress": f"Translating {len(segments)} segments with Gemini..."}
        try:
            segments = await translate_segments(segments, target_language=language)
        except Exception as e:
            # Keep the source-language transcript rather than failing the run
            yield {"_progress": f"Translation failed ({e}); keeping original language."}

    for seg in segments:
        yield seg


async def transcribe_video(video_path: str, language: str = "km") -> list:
    """Non-streaming variant: returns the list of segment dicts."""
    segments = []
    async for item in transcribe_video_streaming(video_path, language):
        if "_progress" not in item:
            segments.append(item)
    return segments
