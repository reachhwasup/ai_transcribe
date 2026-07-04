import os
from pathlib import Path
from moviepy import VideoFileClip
from backend.config import settings


async def extract_audio(video_path: str) -> tuple[str, float]:
    """
    Extract audio from video file.
    Returns (audio_path, duration_in_seconds).
    """
    video = VideoFileClip(video_path)
    duration = video.duration

    audio_path = str(Path(video_path).with_suffix(".mp3"))
    video.audio.write_audiofile(audio_path, logger=None)
    video.close()

    return audio_path, duration


def get_video_duration(video_path: str) -> float:
    """Get video duration in seconds."""
    video = VideoFileClip(video_path)
    duration = video.duration
    video.close()
    return duration
