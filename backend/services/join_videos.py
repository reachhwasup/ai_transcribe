"""Join finished episodes into one long video, with a chapter for each.

A series is exported as one file per episode; the long-form platforms want a compilation. The
files are taken from the folder the exports were saved to and put in episode order. Exports
made with the same settings share their codec and size, so they are joined without encoding
again — minutes of video in seconds, and no loss. Files that differ are encoded to match the
first one.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import tempfile

VIDEO_EXTENSIONS = (".mp4", ".mov", ".m4v", ".mkv")


def episode_of(filename: str) -> int | None:
    """The episode a file is, from the last number in its name ("… - EP012.mp4" → 12)."""
    found = re.findall(r"\d+", os.path.splitext(os.path.basename(filename))[0])
    return int(found[-1]) if found else None


def _plain(name: str) -> str:
    return re.sub(r"[\W_]+", "", name).lower()


def is_joined(name: str) -> bool:
    """A file this made earlier — "Movie - Episode (1-10).mp4" — which is not joined again."""
    return re.search(r"\(\d+\s*-\s*\d+\)", os.path.splitext(name)[0]) is not None


def find_videos(folder: str, series: str = "") -> list[dict]:
    """The episode files in a folder, in episode order. Files with no number, and files this
    made earlier, are left out; of two files for one episode the newer is kept. An export
    folder often holds several series: given a series name, only the files that carry it are
    taken — unless none does (the files were renamed), when all are."""
    try:
        names = os.listdir(folder)
    except OSError:
        return []
    found = []
    for name in names:
        path = os.path.join(folder, name)
        if name.startswith(".") or not name.lower().endswith(VIDEO_EXTENSIONS) or is_joined(name) or not os.path.isfile(path):
            continue
        episode = episode_of(name)
        if episode is not None:
            found.append({"name": name, "path": path, "episode": episode, "size": os.path.getsize(path), "modified": os.path.getmtime(path)})
    if _plain(series):
        found = [v for v in found if _plain(series) in _plain(v["name"])] or found
    best: dict[int, dict] = {}
    for entry in found:
        if entry["episode"] not in best or entry["modified"] > best[entry["episode"]]["modified"]:
            best[entry["episode"]] = entry
    return [best[n] for n in sorted(best)]


def probe(path: str) -> dict:
    """What the joiner needs to know about a file. Raises RuntimeError when it cannot be read."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RuntimeError("ffprobe is not installed")
    done = subprocess.run([ffprobe, "-v", "error", "-show_entries",
                           "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,pix_fmt",
                           "-of", "json", path], capture_output=True, text=True, timeout=30)
    if done.returncode != 0:
        raise RuntimeError(f"{os.path.basename(path)} could not be read")
    data = json.loads(done.stdout or "{}")
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not video:
        raise RuntimeError(f"{os.path.basename(path)} has no picture")
    return {
        "duration": float((data.get("format") or {}).get("duration") or 0.0),
        "video": (video.get("codec_name"), video.get("width"), video.get("height"), video.get("r_frame_rate"), video.get("pix_fmt")),
        "audio": (audio.get("codec_name"), audio.get("sample_rate"), audio.get("channels")) if audio else None,
        "width": int(video.get("width") or 0), "height": int(video.get("height") or 0),
        "fps": video.get("r_frame_rate") or "30",
    }


def alike(probes: list[dict]) -> bool:
    """Whether the files can be joined as they are, without encoding again."""
    return all(p["video"] == probes[0]["video"] and p["audio"] == probes[0]["audio"] for p in probes)


def clock(seconds: float) -> str:
    seconds = int(seconds)
    hours, minutes, secs = seconds // 3600, seconds % 3600 // 60, seconds % 60
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def chapters(durations: list[float], titles: list[str]) -> list[dict]:
    """Where each episode starts in the joined video."""
    out, at = [], 0.0
    for duration, title in zip(durations, titles):
        out.append({"start": round(at, 3), "end": round(at + duration, 3), "title": title})
        at += duration
    return out


def chapter_text(marks: list[dict]) -> str:
    """The chapter list as a video description takes it: "0:00 Episode 1" on each line."""
    return "\n".join(f"{clock(m['start'])} {m['title']}" for m in marks)


def metadata_file(marks: list[dict]) -> str:
    lines = [";FFMETADATA1"]
    for m in marks:
        title = re.sub(r"([=;#\\\n])", r"\\\1", m["title"])
        lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={int(m['start'] * 1000)}", f"END={int(m['end'] * 1000)}", f"title={title}"]
    return "\n".join(lines) + "\n"


def copy_command(ffmpeg: str, list_path: str, meta_path: str, out_path: str) -> list[str]:
    return [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", list_path, "-i", meta_path,
            "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "1", "-map_chapters", "1",
            "-c", "copy", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", out_path]


def encode_command(ffmpeg: str, paths: list[str], probes: list[dict], meta_path: str, out_path: str) -> list[str]:
    """Files that differ are brought to the first one's size and frame rate and encoded once."""
    width, height, fps = probes[0]["width"], probes[0]["height"], probes[0]["fps"]
    command, parts = [ffmpeg, "-y"], []
    for index, (path, info) in enumerate(zip(paths, probes)):
        command += ["-i", path]
        parts.append(f"[{index}:v:0]scale={width}:{height}:force_original_aspect_ratio=decrease,"
                     f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps},format=yuv420p[v{index}]")
        if info["audio"]:
            parts.append(f"[{index}:a:0]aresample=48000,aformat=channel_layouts=stereo[a{index}]")
        else:
            parts.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={info['duration']:.3f}[a{index}]")
    joined = "".join(f"[v{i}][a{i}]" for i in range(len(paths)))
    parts.append(f"{joined}concat=n={len(paths)}:v=1:a=1[v][a]")
    return command + ["-i", meta_path, "-filter_complex", ";".join(parts), "-map", "[v]", "-map", "[a]",
                      "-map_metadata", str(len(paths)), "-map_chapters", str(len(paths)),
                      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "192k",
                      "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", out_path]


async def join(paths: list[str], titles: list[str], out_path: str, on_progress=None) -> dict:
    """Join the files in the order given. Returns {"chapters", "chapter_text", "duration",
    "reencoded"}. `on_progress(percent, message)` is called as it goes."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is not installed")
    if len(paths) < 2:
        raise RuntimeError("Choose at least two videos to join")
    probes = []
    for index, path in enumerate(paths):
        if on_progress:
            on_progress(0, f"Checking video {index + 1} of {len(paths)}…")
        probes.append(await asyncio.to_thread(probe, path))
    marks = chapters([p["duration"] for p in probes], titles)
    total = marks[-1]["end"] or 1.0
    same = alike(probes)
    work = tempfile.mkdtemp(prefix="join_")
    try:
        meta_path = os.path.join(work, "chapters.txt")
        with open(meta_path, "w", encoding="utf-8") as f:
            f.write(metadata_file(marks))
        if same:
            list_path = os.path.join(work, "files.txt")
            with open(list_path, "w", encoding="utf-8") as f:
                for path in paths:
                    escaped = os.path.abspath(path).replace("'", "'\\''")
                    f.write(f"file '{escaped}'\n")
            command = copy_command(ffmpeg, list_path, meta_path, out_path)
        else:
            command = encode_command(ffmpeg, paths, probes, meta_path, out_path)
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        errors = asyncio.ensure_future(process.stderr.read())
        try:
            async for raw in process.stdout:
                line = raw.decode("utf-8", "replace").strip()
                if line.startswith("out_time_ms=") and on_progress:
                    try:
                        done = int(line.split("=", 1)[1]) / 1_000_000
                    except ValueError:
                        continue
                    on_progress(min(99, int(100 * done / total)), "Joining…" if same else "Joining and encoding to one size…")
            code = await process.wait()
        except asyncio.CancelledError:
            process.kill()
            raise
        if code != 0:
            tail = (await errors).decode("utf-8", "replace").strip().splitlines()[-1:] or ["ffmpeg failed"]
            if os.path.exists(out_path):
                os.remove(out_path)
            raise RuntimeError(tail[0][:300])
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return {"chapters": marks, "chapter_text": chapter_text(marks), "duration": total, "reencoded": not same}
