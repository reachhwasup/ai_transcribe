"""Split one long upload into several part projects, and join the finished parts back together.

The cut is a stream copy, so it takes seconds rather than re-encoding minutes of video. Stream
copies can only start on a keyframe, so every requested cut point is first snapped to the nearest
real keyframe: the parts then line up exactly end-to-end, with no gap and no repeated frame.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import uuid

MIN_PART_SECONDS = 60.0     # a part shorter than this is not worth its own project
# Only a guard against a typo turning into hundreds of projects; the real limit is
# MIN_PART_SECONDS, which keeps each part long enough to be worth its own project.
MAX_PARTS = 100
KEYFRAME_SEARCH = 8.0       # how far either side of a cut point to look for a keyframe


def _ffmpeg() -> str:
    return shutil.which("ffmpeg") or "ffmpeg"


def _ffprobe() -> str:
    return shutil.which("ffprobe") or "ffprobe"


def probe_duration(path: str) -> float:
    try:
        out = subprocess.run(
            [_ffprobe(), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=60,
        ).stdout.strip()
        return float(out) if out else 0.0
    except Exception:
        return 0.0


def _nearest_keyframe(path: str, target: float) -> float:
    """The keyframe timestamp closest to `target`, or `target` itself if none can be read."""
    start = max(0.0, target - KEYFRAME_SEARCH)
    try:
        res = subprocess.run(
            [
                _ffprobe(), "-v", "error",
                "-read_intervals", f"{start:.3f}%+{KEYFRAME_SEARCH * 2:.3f}",
                "-select_streams", "v:0",
                "-skip_frame", "nokey",
                "-show_entries", "frame=pts_time",
                "-of", "csv=p=0",
                path,
            ],
            capture_output=True, text=True, timeout=120,
        )
        # csv=p=0 still prints a trailing field separator per row ("644.000000,")
        times = []
        for row in res.stdout.replace(",", " ").split():
            try:
                times.append(float(row))
            except ValueError:
                continue
    except Exception:
        times = []
    if not times:
        return target
    return min(times, key=lambda t: abs(t - target))


def count_parts_for_length(duration: float, part_seconds: float) -> int:
    """How many parts a video falls into when each one runs `part_seconds`.

    A leftover tail shorter than MIN_PART_SECONDS is absorbed by the final part rather than
    becoming a stub of its own, so asking for 10-minute parts of a 30:20 video gives 3, not 4.
    """
    if part_seconds < MIN_PART_SECONDS:
        raise ValueError(f"Parts must be at least {int(MIN_PART_SECONDS)} seconds long")
    if duration <= part_seconds:
        raise ValueError("That is longer than the video — use a shorter part length")
    whole = int(duration // part_seconds)
    remainder = duration - whole * part_seconds
    return whole + 1 if remainder >= MIN_PART_SECONDS else whole


def plan_parts(
    video_path: str,
    duration: float,
    parts: int | None = None,
    part_seconds: float | None = None,
) -> list[tuple[float, float]]:
    """Cut points snapped to keyframes. Returns [(start, end), ...] covering the whole video.

    Give either `parts` (split into N equal pieces) or `part_seconds` (pieces of a set length,
    with the last one running to the end of the video).
    """
    if duration <= 0:
        duration = probe_duration(video_path)
    if duration <= 0:
        raise ValueError("Could not read the video duration")

    if part_seconds:
        count = count_parts_for_length(duration, part_seconds)
        step = float(part_seconds)
    else:
        count = max(2, int(parts or 2))
        step = duration / count

    if count > MAX_PARTS:
        raise ValueError(f"That would make {count} parts — the most allowed is {MAX_PARTS}")
    if count < 2:
        raise ValueError("A split needs at least 2 parts")
    if step < MIN_PART_SECONDS:
        raise ValueError(
            f"{count} parts would each be under {int(MIN_PART_SECONDS)}s — use fewer parts"
        )

    boundaries = [0.0]
    for i in range(1, count):
        snapped = _nearest_keyframe(video_path, step * i)
        # keep boundaries strictly increasing even if two cut points snap to the same keyframe
        if snapped <= boundaries[-1] + 1.0:
            snapped = boundaries[-1] + step
        boundaries.append(round(min(snapped, duration), 3))
    boundaries.append(duration)
    return [(boundaries[i], boundaries[i + 1]) for i in range(count)]


def cut_part(video_path: str, out_path: str, start: float, end: float, is_last: bool) -> None:
    """Stream-copy one part out of the source. `start` must already be on a keyframe."""
    cmd = [_ffmpeg(), "-y", "-ss", f"{start:.3f}", "-i", video_path]
    if not is_last:
        cmd += ["-t", f"{end - start:.3f}"]
    cmd += [
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        "-reset_timestamps", "1",
        "-movflags", "+faststart",
        out_path,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if res.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        raise RuntimeError(f"Could not cut part at {start:.1f}s: {res.stderr[-400:]}")


async def cut_part_async(video_path: str, out_path: str, start: float, end: float, is_last: bool) -> None:
    await asyncio.to_thread(cut_part, video_path, out_path, start, end, is_last)


def concat_videos(paths: list[str], out_path: str) -> None:
    """Join finished part renders back into one file.

    Tries a stream copy first — the parts come from one source and are rendered with the same
    settings, so it almost always works. Falls back to a re-encode if the copy is rejected.
    """
    if not paths:
        raise ValueError("Nothing to join")
    list_dir = os.path.dirname(out_path) or "."
    list_file = os.path.join(list_dir, f"concat_{uuid.uuid4().hex}.txt")
    with open(list_file, "w") as f:
        for p in paths:
            f.write(f"file '{os.path.abspath(p)}'\n")
    try:
        base = [_ffmpeg(), "-y", "-f", "concat", "-safe", "0", "-i", list_file]
        res = subprocess.run(
            base + ["-c", "copy", "-movflags", "+faststart", out_path],
            capture_output=True, text=True, timeout=3600,
        )
        if res.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            res = subprocess.run(
                base + [
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out_path,
                ],
                capture_output=True, text=True, timeout=7200,
            )
            if res.returncode != 0:
                raise RuntimeError(f"Joining the parts failed: {res.stderr[-400:]}")
    finally:
        try:
            os.remove(list_file)
        except OSError:
            pass


async def concat_videos_async(paths: list[str], out_path: str) -> None:
    await asyncio.to_thread(concat_videos, paths, out_path)
