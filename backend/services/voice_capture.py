"""Extract bounded reference speech from an original movie."""
import subprocess
from pydantic import BaseModel, Field


class VoiceEQ(BaseModel):
    enabled: bool = False
    low_cut: float = Field(default=80, ge=20, le=300, allow_inf_nan=False)
    warmth: float = Field(default=0, ge=-12, le=12, allow_inf_nan=False)
    mud: float = Field(default=0, ge=-12, le=12, allow_inf_nan=False)
    presence: float = Field(default=0, ge=-12, le=12, allow_inf_nan=False)
    air: float = Field(default=0, ge=-12, le=12, allow_inf_nan=False)


def eq_filters(eq: VoiceEQ | None) -> list[str]:
    if not eq or not eq.enabled:
        return []
    filters = [f"highpass=f={eq.low_cut}:p=2"]
    for frequency, gain in [(150, eq.warmth), (350, eq.mud), (3000, eq.presence), (8000, eq.air)]:
        filters.append(f"equalizer=f={frequency}:t=q:w=0.8:g={gain}")
    filters.append("alimiter=limit=0.95:level=0:latency=1")
    return ["-af", ",".join(filters)]


def extract_voice_sample(source: str, destination: str, start: float, end: float, eq: VoiceEQ | None = None) -> None:
    from backend.services.video_service import _get_ffmpeg

    result = subprocess.run(
        [_get_ffmpeg(), "-y", "-ss", str(start), "-i", source,
         "-t", str(end - start), "-map", "0:a:0", "-vn", "-ac", "1",
         "-ar", "24000", *eq_filters(eq), "-c:a", "pcm_s16le", destination],
        capture_output=True, timeout=60,
    )
    if result.returncode:
        raise ValueError("Could not capture speech. Check that the movie has an audio track.")


def voice_waveform(source: str, start: float, duration: float) -> list[float]:
    """Read a small audio window, keeping memory bounded even for long movies."""
    from array import array
    import sys
    from backend.services.video_service import _get_ffmpeg

    result = subprocess.run(
        [_get_ffmpeg(), "-v", "error", "-ss", str(start), "-i", source,
         "-t", str(duration), "-map", "0:a:0", "-vn", "-ac", "1",
         "-ar", "8000", "-f", "s16le", "pipe:1"],
        capture_output=True, timeout=60,
    )
    if result.returncode or not result.stdout:
        raise ValueError("Unable to read the movie audio waveform")
    samples = array('h', result.stdout)
    if sys.byteorder != 'little':
        samples.byteswap()
    count = 600
    return [round(max((abs(v) for v in samples[i * len(samples) // count:(i + 1) * len(samples) // count]), default=0) / 32768, 4) for i in range(count)]


from functools import lru_cache


@lru_cache(maxsize=8)
def full_voice_waveform(source: str, modified: int, duration: float) -> list[float]:
    """Cache an overview; spool decoded PCM to disk instead of holding a movie in RAM."""
    from array import array
    import tempfile
    import sys
    from backend.services.video_service import _get_ffmpeg

    with tempfile.TemporaryFile() as pcm:
        result = subprocess.run(
            [_get_ffmpeg(), "-v", "error", "-i", source, "-t", str(duration),
             "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"],
            stdout=pcm, stderr=subprocess.PIPE, timeout=180,
        )
        sample_count = pcm.tell() // 2
        if result.returncode or not sample_count:
            raise ValueError("Unable to read the full movie audio")
        pcm.seek(0)
        peaks = []
        for i in range(1200):
            remaining = ((i + 1) * sample_count // 1200 - i * sample_count // 1200) * 2
            peak = 0
            while remaining:
                block = pcm.read(min(remaining, 65536))
                if not block:
                    break
                remaining -= len(block)
                samples = array('h', block)
                if sys.byteorder != 'little':
                    samples.byteswap()
                peak = max(peak, max(map(abs, samples), default=0))
            peaks.append(round(peak / 32768, 4))
        return peaks
