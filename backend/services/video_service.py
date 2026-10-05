from __future__ import annotations
import re
import os
import json
import uuid
import subprocess
import shutil
import threading
import time
from pathlib import Path
from typing import Any
from backend.config import settings


# Platform presets: (width, height, video_bitrate, audio_bitrate, fps, codec_extra)
PLATFORM_PRESETS = {
    "tiktok": {
        "name": "TikTok",
        "width": 1080,
        "height": 1920,
        "video_bitrate": "3.8M",
        "audio_bitrate": "128k",
        "fps": 30,
        "max_duration": 600,  # 10 min
        "description": "9:16 vertical, 1080x1920, optimized for TikTok",
    },
    "youtube": {
        "name": "YouTube",
        "width": 1920,
        "height": 1080,
        "video_bitrate": "4.5M",
        "audio_bitrate": "192k",
        "fps": 30,
        "max_duration": None,
        "description": "16:9 landscape, 1920x1080, optimized for YouTube",
    },
    "youtube_shorts": {
        "name": "YouTube Shorts",
        "width": 1080,
        "height": 1920,
        "video_bitrate": "3.8M",
        "audio_bitrate": "128k",
        "fps": 30,
        "max_duration": 60,
        "description": "9:16 vertical, 1080x1920, max 60s for Shorts",
    },
    "instagram": {
        "name": "Instagram Square",
        "width": 1080,
        "height": 1080,
        "video_bitrate": "3.2M",
        "audio_bitrate": "128k",
        "fps": 30,
        "max_duration": 600,
        "description": "1:1 square, 1080x1080, for Instagram Feed",
    },
    "instagram_reels": {
        "name": "Instagram Reels",
        "width": 1080,
        "height": 1920,
        "video_bitrate": "3.8M",
        "audio_bitrate": "128k",
        "fps": 30,
        "max_duration": 90,
        "description": "9:16 vertical, 1080x1920, for Instagram Reels",
    },
    "facebook": {
        "name": "Facebook Portrait",
        "width": 1080,
        "height": 1350,
        "video_bitrate": "3.5M",
        "audio_bitrate": "128k",
        "fps": 30,
        "max_duration": None,
        "description": "4:5 portrait, 1080x1350, optimized for Facebook",
    },
    "facebook_reels": {
        "name": "Facebook Reels",
        "width": 1080,
        "height": 1920,
        "video_bitrate": "3.8M",
        "audio_bitrate": "128k",
        "fps": 30,
        "max_duration": 90,
        "description": "9:16 vertical, 1080x1920, max 90s for Reels",
    },
    "custom": {
        "name": "Original Source",
        "width": 1920,
        "height": 1080,
        "video_bitrate": "4.5M",
        "audio_bitrate": "192k",
        "fps": 30,
        "max_duration": None,
        "description": "Match original video resolution",
    },
}


def _get_ffmpeg() -> str:
    """Find ffmpeg binary."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError(
            "ffmpeg not found. Please install ffmpeg: brew install ffmpeg"
        )
    return ffmpeg


def _get_ffprobe() -> str:
    """Find ffprobe binary."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        ffprobe = shutil.which("ffmpeg")
    return ffprobe or "ffprobe"


def probe_video(video_path: str) -> dict:
    """Probe video metadata including duration, width, height, fps."""
    if not os.path.exists(video_path):
        return {}
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        dur = get_duration_ffprobe(video_path)
        return {"duration": dur}
    try:
        cmd = [
            ffprobe, "-v", "error",
            "-show_entries", "stream=width,height,r_frame_rate,duration:format=duration",
            "-of", "json",
            video_path,
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if r.returncode == 0 and r.stdout.strip():
            import json as _json
            data = _json.loads(r.stdout)
            result = {}
            for stream in data.get("streams", []):
                if "width" in stream and "height" in stream:
                    result["width"] = stream["width"]
                    result["height"] = stream["height"]
                    if "duration" in stream:
                        try:
                            result["duration"] = float(stream["duration"])
                        except Exception:
                            pass
                    break
            if "duration" not in result:
                fmt_dur = data.get("format", {}).get("duration")
                if fmt_dur:
                    try:
                        result["duration"] = float(fmt_dur)
                    except Exception:
                        pass
            if "duration" not in result or result.get("duration", 0) <= 0:
                result["duration"] = get_duration_ffprobe(video_path)
            return result
    except Exception:
        pass
    return {"duration": get_duration_ffprobe(video_path)}


def generate_preview(video_path: str, out_path: str) -> str:
    """
    Transcode a video into a lightweight 720p proxy used by the editor's
    preview player. This lets the browser load/scrub a small file instead of
    the full-resolution (potentially multi-GB) source. Returns out_path.
    Raises RuntimeError on failure.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    ffmpeg = _get_ffmpeg()
    tmp_path = out_path + ".tmp.mp4"

    cmd = [
        ffmpeg, "-y",
        "-i", video_path,
        # Downscale so the longer side is at most 1280px, keeping aspect ratio
        # and even dimensions (required by libx264).
        "-vf", "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'",
        "-c:v", "libx264", "-crf", "26", "-preset", "veryfast",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",  # allow playback before full download
        tmp_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    if result.returncode != 0 or not os.path.exists(tmp_path):
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise RuntimeError(f"ffmpeg preview generation failed: {result.stderr[-500:]}")

    # Atomic-ish swap so the player never sees a half-written file.
    os.replace(tmp_path, out_path)
    return out_path


def _has_videotoolbox(ffmpeg: str) -> bool:
    """Check if ffmpeg supports Apple Silicon Hardware GPU Encoding (h264_videotoolbox)."""
    try:
        result = subprocess.run(
            [ffmpeg, "-encoders"], capture_output=True, text=True, timeout=10
        )
        return "h264_videotoolbox" in result.stdout
    except Exception:
        return False


def _build_subtitle_concat_demuxer(
    sub_images: list[dict], width: int, height: int, export_dir: str
) -> tuple[str | None, list[str]]:
    """
    Build a single concat demuxer file for subtitle overlays.
    Replaces dozens of separate FFmpeg overlay filter chains with a SINGLE timed input & 1 overlay filter.
    """
    if not sub_images:
        return None, []

    from PIL import Image

    abs_export_dir = os.path.abspath(export_dir)
    os.makedirs(abs_export_dir, exist_ok=True)

    trans_path = os.path.abspath(os.path.join(abs_export_dir, f"_sub_trans_{uuid.uuid4()}.png"))
    Image.new("RGBA", (width, height), (0, 0, 0, 0)).save(trans_path, "PNG")

    concat_path = os.path.abspath(os.path.join(abs_export_dir, f"_subs_concat_{uuid.uuid4()}.txt"))

    sorted_subs = sorted(sub_images, key=lambda s: float(s["start"]))
    lines = ["ffconcat version 1.0"]

    current_time = 0.0
    for idx, si in enumerate(sorted_subs):
        start = max(0.0, float(si["start"]))
        raw_end = max(start + 0.05, float(si["end"]))
        img_path = os.path.abspath(si["path"])

        # Lookahead: the next subtitle's start time prevents overlapping drift
        next_start = float(sorted_subs[idx + 1]["start"]) if idx + 1 < len(sorted_subs) else raw_end + 3600.0

        # Cap display end time so it never overflows into the next subtitle's start
        display_end = min(raw_end, max(start + 0.05, next_start))

        # 1. Insert transparent gap if there is silence/space before this subtitle
        if start > current_time:
            gap = start - current_time
            if gap > 0.001:
                lines.append(f"file '{trans_path}'")
                lines.append(f"duration {gap:.6f}")
                current_time = start
        elif start < current_time:
            # If previous subtitle ran up to current_time, start this subtitle immediately
            start = current_time
            display_end = max(start + 0.05, display_end)

        # 2. Add this subtitle's exact duration
        dur = max(0.05, display_end - start)
        lines.append(f"file '{img_path}'")
        lines.append(f"duration {dur:.6f}")
        current_time += dur

    # Trailing transparent padding to cover remainder of video
    lines.append(f"file '{trans_path}'")
    lines.append("duration 7200.0")
    lines.append(f"file '{trans_path}'")

    with open(concat_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    return concat_path, [trans_path, concat_path]


def _parse_srt(srt_path: str):
    """Parse SRT file into list of {start, end, text} dicts (times in seconds)."""
    import re
    segments = []
    with open(srt_path, "r", encoding="utf-8") as f:
        content = f.read()
    blocks = re.split(r"\n\s*\n", content.strip())
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) < 3:
            continue
        time_match = re.match(
            r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})",
            lines[1].strip(),
        )
        if not time_match:
            continue
        g = time_match.groups()
        start = int(g[0]) * 3600 + int(g[1]) * 60 + int(g[2]) + int(g[3]) / 1000
        end = int(g[4]) * 3600 + int(g[5]) * 60 + int(g[6]) + int(g[7]) / 1000
        text = "\n".join(lines[2:]).strip()
        if text:
            segments.append({"start": start, "end": end, "text": text})
    return segments


def _hex_rgb(hex_str: str, default=(255, 255, 255)):
    """Parse '#RRGGBB' into an (r, g, b) tuple."""
    try:
        h = str(hex_str).lstrip("#")
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except (ValueError, IndexError, TypeError):
        return default


def _generate_subtitle_images(srt_path: str, width: int, height: int, size_pct: float = 4.0, position: str = "bottom", style: dict | None = None):
    """
    Transparent full-frame PNGs for each caption, drawn by caption_render with the whole
    Style-tab style (font, weight, spacing, case, shadow, rounded box, word highlight) so the
    export looks like the editor's preview. size_pct / position fill in for older styles that
    predate those keys. Returns [{path, start, end}] — several per caption for a word highlight.
    """
    import concurrent.futures

    from backend.services.caption_render import render_caption, word_count

    segments = _parse_srt(srt_path)
    if not segments:
        return []

    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    full_style = {"sizePct": size_pct, "position": position, **(style or {})}
    karaoke = full_style.get("animation") in ("karaoke", "badge")

    def _save(img, name: str) -> str:
        path = os.path.join(export_dir, f"_sub_{uuid.uuid4()}_{name}.png")
        img.save(path, "PNG", compress_level=1)
        return path

    def _render_one(item):
        """One image per caption — or, for a word highlight, one per word, each shown for an
        equal share of the caption as the preview does."""
        i, seg = item
        n = word_count(seg["text"]) if karaoke else 1
        if n <= 1:
            return [{"path": _save(render_caption(seg["text"], full_style, width, height), str(i)),
                     "start": seg["start"], "end": seg["end"]}]
        out, step = [], (seg["end"] - seg["start"]) / n
        for w in range(n):
            img = render_caption(seg["text"], full_style, width, height, active_word=w)
            out.append({
                "path": _save(img, f"{i}_{w}"),
                "start": round(seg["start"] + w * step, 3),
                "end": round(seg["end"] if w == n - 1 else seg["start"] + (w + 1) * step, 3),
            })
        return out

    max_workers = min(8, max(2, (os.cpu_count() or 4)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        return [img for group in executor.map(_render_one, list(enumerate(segments))) for img in group]

# Matching the export's bitrate to the source. Every preset used to encode at its full
# bitrate (3.8 Mbit/s for a vertical video) whatever came in, so a clip that arrived at
# 0.5 Mbit/s left seven times its size without looking any better: bits cannot put back
# detail the source never had.
_EFFICIENT_CODECS = {"hevc", "h265", "av1", "vp9"}
REENCODE_HEADROOM = 1.5          # re-encoding, plus captions and logo drawn onto the picture
EFFICIENT_SOURCE_FACTOR = 2.2    # H.264 needs about twice the bits of HEVC/AV1/VP9, plus headroom
# Measured on a real 0.5 Mbit/s HEVC source with the hardware encoder (SSIM against the source):
# 1.2M 0.975, 1.5M 0.980, 1.8M 0.983, 3.8M 0.992. Past 1.5M each step costs a lot for little.
MIN_BITS_PER_PIXEL_SECOND = 1_500_000 / (1080 * 1920)


def probe_video_bitrate(video_path: str) -> tuple[float, str]:
    """(video bits per second, codec name) of a file's picture; (0, "") when unknown."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe or not os.path.exists(video_path):
        return 0.0, ""
    try:
        r = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name,bit_rate:format=bit_rate", "-of", "json", video_path],
            capture_output=True, text=True, timeout=15,
        )
        import json as _json
        data = _json.loads(r.stdout or "{}")
        stream = (data.get("streams") or [{}])[0]
        rate = stream.get("bit_rate") or data.get("format", {}).get("bit_rate") or 0
        return float(rate), str(stream.get("codec_name") or "").lower()
    except Exception:
        return 0.0, ""


def fit_video_bitrate(ceiling_bps: float, source_bps: float, source_codec: str, out_pixels: int) -> int:
    """The bitrate to encode at: enough to carry what the source holds, never more than the
    preset allows, and never so little that the picture breaks up at this frame size."""
    if source_bps <= 0:
        return int(ceiling_bps)
    factor = EFFICIENT_SOURCE_FACTOR if source_codec in _EFFICIENT_CODECS else REENCODE_HEADROOM
    floor = max(500_000.0, MIN_BITS_PER_PIXEL_SECOND * out_pixels)
    return int(min(ceiling_bps, max(source_bps * factor, floor)))


def _bitrate_bps(text: str) -> float:
    """ffmpeg bitrate notation ("3.8M", "2200k") in bits per second."""
    text = str(text).strip().lower()
    scale = 1_000_000 if text.endswith("m") else 1_000 if text.endswith("k") else 1
    return float(text.rstrip("mk")) * scale


def export_video_for_platform(
    video_path: str,
    platform: str,
    start_time: float | None = None,
    end_time: float | None = None,
    include_subtitles: bool = False,
    srt_path: str | None = None,
    tts_audio_path: str | None = None,
    mute_original_audio: bool = False,
    music_audio_path: str | None = None,  # isolated music-only bed (replaces original audio)
    scale_mode: str = "fit",  # fit (black bars) | fill (crop/zoom) | blur (blurred background)
    subtitle_size_pct: float = 4.0,  # subtitle height as % of frame height
    subtitle_position: str = "bottom",  # bottom | middle | top
    subtitle_style: dict | None = None,  # full caption style (colors, outline, box)
    progress_callback: Any = None,  # Optional callable (percent: int, message: str) -> None
    quality: str = "standard",  # compact (~2.2M, ~70% smaller) | standard (~3.8M, balanced) | high (~6.5M, master)
    bgm_volume: float = 0.35,  # volume factor for background audio/music (0.0 to 1.0, default 0.35 so TTS is clear)
    duck_music: bool = True,   # dip the music while the dubbed voice speaks, lift it again in gaps
    normalize_loudness: bool = True,  # even out the final audio to broadcast/streaming loudness
    logo_path: str | None = None,  # image file path for watermark/logo overlay
    logo_url: str | None = None,  # optional alias for logo_path
    text_overlays: list[dict] | None = None,  # titles/callouts drawn over the picture
    logo_enabled: bool = False,
    blur_areas: list[dict] | None = None,  # regions to blur, as percentages of the source frame
    logo_position: str = "top_right",  # top_left | top_right | bottom_left | bottom_right | center | custom
    logo_x_pct: float | None = None,  # 0-100 percentage for custom position
    logo_y_pct: float | None = None,  # 0-100 percentage for custom position
    logo_scale_pct: float = 15.0,  # width of logo as % of video width (5% - 50%)
    logo_opacity: float = 1.0,  # 0.0 - 1.0
    logo_start: float | None = None,  # timeline seconds the logo appears (None = from the start)
    logo_end: float | None = None,    # …and disappears (None = until the end)
    source_path: str | None = None,   # the project's own video, when video_path is a re-cut intermediate
    video_filter: list | None = None,  # colour filter steps [[name, value], …], as the preview shows them
) -> str:
    """
    Export video formatted for a specific platform.
    Optionally burns subtitles, overlays watermark/logo, and mixes TTS audio overlay.
    Returns path to the exported file.
    """
    if not logo_path and logo_url:
        logo_path = logo_url.lstrip("/") if os.path.exists(logo_url.lstrip("/")) else logo_url

    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    preset = PLATFORM_PRESETS.get(platform)
    if not preset:
        raise ValueError(f"Unknown platform: {platform}")

    ffmpeg = _get_ffmpeg()

    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)
    output_path = os.path.join(export_dir, f"{uuid.uuid4()}_{platform}.mp4")

    w = preset["width"]
    h = preset["height"]

    # Quality and Bitrate optimization
    if quality == "compact":
        target_v_bitrate = "2200k"
        target_crf = "26"
        target_a_bitrate = "96k"
    elif quality == "high":
        target_v_bitrate = "6500k"
        target_crf = "20"
        target_a_bitrate = "192k"
    else:  # standard (default)
        target_v_bitrate = preset.get("video_bitrate", "3.8M")
        target_crf = "23"
        target_a_bitrate = preset.get("audio_bitrate", "128k")

    if platform == "custom":
        try:
            p_info = probe_video(video_path)
            src_w = int(p_info.get("width", 0))
            src_h = int(p_info.get("height", 0))
            if src_w > 0 and src_h > 0:
                w = src_w
                h = src_h
        except Exception:
            pass

    # "High" is the master and keeps its full bitrate. The other two do not spend more than
    # the source can use. The source is measured on the project's own file: a timeline that
    # was re-cut reaches here as an intermediate encoded at a much higher bitrate.
    if quality != "high":
        source_bps, source_codec = probe_video_bitrate(source_path or video_path)
        fitted = fit_video_bitrate(_bitrate_bps(target_v_bitrate), source_bps, source_codec, w * h)
        target_v_bitrate = f"{max(1, fitted // 1000)}k"

    # Determine subtitle strategy
    want_subs = include_subtitles and srt_path and os.path.exists(srt_path)
    # Captions are always drawn by caption_render, which honours the whole Style tab. The libass
    # route only knew a font size and position, so on an ffmpeg built with libass every other
    # style setting was silently dropped — the same project exported differently per machine.
    has_libass = False
    sub_images = []  # PNG overlay fallback
    sub_concat_path = None
    sub_extra_files = []

    if want_subs and not has_libass:
        sub_images = _generate_subtitle_images(srt_path, w, h, subtitle_size_pct, subtitle_position, subtitle_style)
        if sub_images:
            sub_concat_path, sub_extra_files = _build_subtitle_concat_demuxer(sub_images, w, h, export_dir)

    has_tts = bool(tts_audio_path and os.path.exists(tts_audio_path))
    # Isolated music-only bed: when present it becomes the background audio
    # instead of the original mix, so voices are gone but music stays.
    has_music = bool(music_audio_path and os.path.exists(music_audio_path))
    has_logo = bool(logo_enabled and logo_path and os.path.exists(logo_path))

    # Probe whether video has audio
    has_video_audio = False
    if has_tts or mute_original_audio or has_music:
        probe_cmd = [ffmpeg, "-i", video_path, "-hide_banner"]
        probe_result = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=30)
        has_video_audio = any(
            "Audio:" in line and "Stream #0:" in line
            for line in probe_result.stderr.splitlines()
        )

    # ---- Build ffmpeg command ----
    cmd = [ffmpeg, "-y"]

    # Input 0: video. -ss and -t must both precede -i to apply to THIS input.
    trim_duration = (end_time - (start_time or 0)) if end_time is not None else None
    if start_time is not None:
        cmd += ["-ss", str(start_time)]
    if trim_duration is not None:
        cmd += ["-t", str(trim_duration)]
    cmd += ["-i", video_path]

    # Track next input index
    next_idx = 1

    # Add subtitle concat stream (single input for all subtitles!)
    sub_input_idx = None
    if sub_concat_path:
        sub_input_idx = next_idx
        cmd += ["-f", "concat", "-safe", "0", "-i", sub_concat_path]
        next_idx += 1

    # Add Watermark / Logo input
    logo_input_idx = None
    if has_logo:
        logo_input_idx = next_idx
        cmd += ["-i", logo_path]
        next_idx += 1

    # Text overlays: one transparent PNG per overlay, laid over the picture at its own time
    overlay_inputs: list[dict] = []
    if text_overlays:
        try:
            # written beside the other export scratch files so the existing cleanup finds them
            overlay_dir = os.path.join(export_dir, f"overlays_{uuid.uuid4().hex[:8]}")
            os.makedirs(overlay_dir, exist_ok=True)
            for item in render_text_overlays(text_overlays, w, h, overlay_dir):
                item["input_idx"] = next_idx
                # A still PNG carries one frame at t=0, so a fade keyed to a later timestamp
                # would evaluate that frame as fully transparent and the overlay would never
                # appear. Looping it gives the filter frames to work on across the whole span.
                cmd += ["-loop", "1", "-t", f"{item['end'] + 0.5:.3f}", "-i", item["path"]]
                next_idx += 1
                overlay_inputs.append(item)
        except Exception as overlay_err:
            print(f"[export] text overlays skipped: {overlay_err}", flush=True)
            overlay_inputs = []

    # Add TTS audio input
    tts_idx = None
    if has_tts:
        tts_idx = next_idx
        cmd += ["-i", tts_audio_path]
        next_idx += 1

    # Add isolated music input, trimmed to the same window as the video
    music_idx = None
    if has_music:
        if start_time is not None:
            cmd += ["-ss", str(start_time)]
        if trim_duration is not None:
            cmd += ["-t", str(trim_duration)]
        cmd += ["-i", music_audio_path]
        music_idx = next_idx
        next_idx += 1

    # ---- Build video filter ----
    if scale_mode == "fill":
        # Zoom to fill the frame, cropping the overflow (explicit center crop)
        vf_base = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}:(in_w-out_w)/2:(in_h-out_h)/2"
    elif scale_mode == "blur":
        # Video fitted at natural size over a blurred, zoomed copy of itself (centered)
        # Optimized: downscale bg to 1/4 size before blur for 15x faster rendering with identical smooth bokeh look
        bg_w = max(64, w // 4)
        bg_h = max(64, h // 4)
        vf_base = (
            f"split[bgin][fgin];"
            f"[bgin]scale={bg_w}:{bg_h}:force_original_aspect_ratio=increase,crop={bg_w}:{bg_h}:(in_w-out_w)/2:(in_h-out_h)/2,boxblur=10:1,scale={w}:{h}[bg];"
            f"[fgin]scale={w}:{h}:force_original_aspect_ratio=decrease[fg];"
            f"[bg][fg]overlay=(W-w)/2:(H-h)/2"
        )
    else:  # fit
        vf_base = f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black"

    # Blur requested areas of the source frame before any scaling, so the percentages the
    # editor stored still line up whatever platform size is being rendered.
    if blur_areas:
        src = probe_video(video_path)
        src_w, src_h = int(src.get("width") or 1920), int(src.get("height") or 1080)
        prefix = blur_filter_prefix(normalize_blur_regions(blur_areas, src_w, src_h), float(start_time or 0))
        if prefix:
            vf_base = prefix + vf_base

    # The colour filter goes on the film itself, before it is fitted to the frame — so captions,
    # the logo and the black bars of a letterboxed video keep their own colours, as they do in
    # the editor, where the filter sits on the video and the captions float above it.
    from backend.services.video_filters import filter_chain
    colour_chain = filter_chain(video_filter)
    if colour_chain:
        vf_base = colour_chain + "," + vf_base

    if has_libass:
        escaped_srt = srt_path.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
        font_size = max(6, min(24, round(288 * subtitle_size_pct / 100)))
        alignment = {"bottom": 2, "middle": 5, "top": 8}.get(subtitle_position, 2)
        vf_base += (
            f",subtitles='{escaped_srt}':force_style="
            f"'FontSize={font_size},Alignment={alignment},MarginV=16,PrimaryColour=&HFFFFFF&,Outline=1'"
        )

    # Background audio source: isolated music if available, else the original
    # video audio (unless muted). This is what TTS narration mixes on top of.
    if has_music:
        bg_audio = f"{music_idx}:a"
    elif not mute_original_audio and has_video_audio:
        bg_audio = "0:a"
    else:
        bg_audio = None

    # Detect if we can skip video re-encoding (only audio is changing)
    # True when: no subtitle burn, no logo watermark, scale mode is default/native, only audio mix
    audio_only_change = (
        not sub_concat_path
        and not has_libass
        and not want_subs
        and not has_logo
        and not blur_areas  # blurring means the frames must be re-encoded
        and not text_overlays  # drawing text on the picture does too
        and not colour_chain   # so does recolouring it
        and scale_mode == "fit"
    )

    # Decide if we need filter_complex (subtitles overlay, logo overlay, mixing two audios, or adjusting volume)
    bg_vol = max(0.0, min(2.0, float(bgm_volume if bgm_volume is not None else 0.35)))
    need_filter_complex = (
        bool(sub_concat_path)
        or bool(has_logo)
        or bool(overlay_inputs)          # text overlays are drawn in the complex chain too
        or (has_tts and bg_audio is not None)
        or (bg_audio is not None and bg_vol != 1.0)
    )

    if need_filter_complex:
        fc_parts = []
        if not audio_only_change:
            fc_parts.append(f"[0:v]{vf_base}[scaled]")
            prev_label = "scaled"
        else:
            prev_label = "0:v"

        # Apply single subtitle overlay if using concat demuxer
        if sub_concat_path and sub_input_idx is not None:
            fc_parts.append(f"[{sub_input_idx}:v]setpts=PTS-STARTPTS[sub_sync]")
            fc_parts.append(f"[{prev_label}][sub_sync]overlay=0:0:shortest=1[subout]")
            prev_label = "subout"

        # Apply Brand Logo / Watermark overlay
        if has_logo and logo_input_idx is not None:
            logo_w = max(24, round(w * max(3.0, min(80.0, float(logo_scale_pct or 15.0))) / 100.0))
            pad_x = max(16, round(w * 0.03))
            pad_y = max(16, round(h * 0.03))

            if logo_position == "top_left":
                ox = f"{pad_x}"
                oy = f"{pad_y}"
            elif logo_position == "top_right":
                ox = f"main_w-overlay_w-{pad_x}"
                oy = f"{pad_y}"
            elif logo_position == "bottom_left":
                ox = f"{pad_x}"
                oy = f"main_h-overlay_h-{pad_y}"
            elif logo_position == "bottom_right":
                ox = f"main_w-overlay_w-{pad_x}"
                oy = f"main_h-overlay_h-{pad_y}"
            elif logo_position == "center":
                ox = "(main_w-overlay_w)/2"
                oy = "(main_h-overlay_h)/2"
            else:  # custom coordinates
                cx = max(0, min(100, float(logo_x_pct if logo_x_pct is not None else 85.0)))
                cy = max(0, min(100, float(logo_y_pct if logo_y_pct is not None else 5.0)))
                ox = f"round(main_w*{cx}/100)"
                oy = f"round(main_h*{cy}/100)"

            op = max(0.05, min(1.0, float(logo_opacity if logo_opacity is not None else 1.0)))
            fc_parts.append(
                f"[{logo_input_idx}:v]scale={logo_w}:-1:force_original_aspect_ratio=decrease,format=rgba,colorchannelmixer=aa={op}[logo_scaled]"
            )
            # shown only within its time range, measured from where this render starts
            logo_enable = ""
            if logo_start is not None or logo_end is not None:
                off = float(start_time or 0)
                a = float(logo_start or 0) - off
                b = (float(logo_end) if logo_end is not None else 1e9) - off
                logo_enable = f":enable='between(t,{a:.3f},{b:.3f})'"
            fc_parts.append(f"[{prev_label}][logo_scaled]overlay={ox}:{oy}{logo_enable}[logo_out]")
            prev_label = "logo_out"

        for n, item in enumerate(overlay_inputs):
            # each overlay shows only between its own start and end, fading in and out so it
            # does not pop on screen
            label_in, label_out = f"ov{n}", f"ovout{n}"
            fade = item.get("fade") or 0.0
            span = max(0.05, item["end"] - item["start"])
            fade = min(fade, span / 2)
            chain = "format=rgba"
            factor = _overlay_scale_expr(item)
            if factor:
                # Scale the text about its centre, then pad onto a fixed canvas: overlay needs
                # the same frame size every frame, and the canvas leaves room for the overshoot.
                cw, ch = _overlay_canvas(item)
                chain += (
                    f",scale=w='max(2\\,trunc(iw*{factor}/2)*2)':h=-2:eval=frame"
                    f",pad=w={cw}:h={ch}:x='(ow-iw)/2':y='(oh-ih)/2':color=black@0:eval=frame"
                )
            if fade > 0.01:
                chain += (
                    f",fade=t=in:st={item['start']:.3f}:d={fade:.3f}:alpha=1"
                    f",fade=t=out:st={max(item['start'], item['end'] - fade):.3f}:d={fade:.3f}:alpha=1"
                )
            fc_parts.append(f"[{item['input_idx']}:v]{chain}[{label_in}]")
            pos_x, pos_y = _overlay_position_exprs(item)
            fc_parts.append(
                f"[{prev_label}][{label_in}]overlay=x='{pos_x}':y='{pos_y}'"
                f":enable='between(t,{item['start']:.3f},{item['end']:.3f})'[{label_out}]"
            )
            prev_label = label_out

        # Audio mixing
        audio_map = None
        bg_vol = max(0.0, min(2.0, float(bgm_volume if bgm_volume is not None else 0.35)))
        if has_tts and bg_audio is not None:
            # Attenuate background audio/music so AI narration is always crisp, clear, and prominent
            tts_vol = 1.15
            if duck_music:
                # Sidechain: the voice drives a compressor on the music, so the bed dips under
                # speech and comes back up in the gaps instead of sitting at one flat level.
                fc_parts.append(
                    f"[{bg_audio}]volume={bg_vol}[bg_attenuated];"
                    f"[{tts_idx}:a]volume={tts_vol}[tts_boosted];"
                    f"[tts_boosted]asplit=2[tts_mix][tts_key];"
                    f"[bg_attenuated][tts_key]sidechaincompress="
                    f"threshold=0.05:ratio=8:attack=20:release=400:makeup=1[bg_ducked];"
                    f"[bg_ducked][tts_mix]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[amixed]"
                )
            else:
                fc_parts.append(
                    f"[{bg_audio}]volume={bg_vol}[bg_attenuated];"
                    f"[{tts_idx}:a]volume={tts_vol}[tts_boosted];"
                    f"[bg_attenuated][tts_boosted]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[amixed]"
                )
            audio_map = "[amixed]"
        elif has_tts:
            audio_map = f"{tts_idx}:a"
        elif bg_audio is not None:
            if bg_vol != 1.0:
                fc_parts.append(f"[{bg_audio}]volume={bg_vol}[bg_attenuated]")
                audio_map = "[bg_attenuated]"
            else:
                audio_map = bg_audio

        # Even out the overall level (EBU R128, the target streaming platforms expect)
        if normalize_loudness and audio_map:
            src = audio_map.strip("[]") if audio_map.startswith("[") else audio_map
            fc_parts.append(f"[{src}]loudnorm=I=-16:TP=-1.5:LRA=11[aout]")
            audio_map = "[aout]"

        fc = ";".join(fc_parts)
        # Map whatever the chain actually produced. Keying this off `audio_only_change` left
        # a video stage (a text overlay) dangling when nothing else touched the picture.
        if fc_parts and prev_label != "0:v":
            cmd += ["-filter_complex", fc, "-map", f"[{prev_label}]"]
        elif fc_parts:
            cmd += ["-filter_complex", fc, "-map", "0:v"]
        else:
            cmd += ["-map", "0:v"]

        if audio_map:
            cmd += ["-map", audio_map]
        else:
            cmd += ["-an"]
    else:
        # Simple case: just -vf
        if not audio_only_change:
            cmd += ["-vf", vf_base]
        if has_tts:
            cmd += ["-map", "0:v", "-map", f"{tts_idx}:a"]
        elif bg_audio is not None:
            cmd += ["-map", "0:v", "-map", bg_audio]
        elif mute_original_audio:
            cmd += ["-an"]

    # When only audio is changing (no subtitle burn, no video scaling),
    # stream-copy the video track — avoids full re-encode, instantaneous export.
    if trim_duration is not None:
        cmd += ["-t", str(trim_duration)]

    if audio_only_change:
        cmd += [
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", target_a_bitrate,
            "-movflags", "+faststart",
            output_path,
        ]
    else:
        # Video re-encoding: use Apple Silicon Hardware GPU Encoder if available
        if _has_videotoolbox(ffmpeg):
            cmd += [
                "-c:v", "h264_videotoolbox",
                "-b:v", target_v_bitrate,
                "-c:a", "aac",
                "-b:a", target_a_bitrate,
                "-r", str(preset["fps"]),
                "-movflags", "+faststart",
                "-pix_fmt", "yuv420p",
                output_path,
            ]
        else:
            cmd += [
                "-c:v", "libx264",
                "-preset", "fast",
                "-crf", target_crf,
                "-threads", "0",
                "-b:v", target_v_bitrate,
                "-c:a", "aac",
                "-b:a", target_a_bitrate,
                "-r", str(preset["fps"]),
                "-movflags", "+faststart",
                "-pix_fmt", "yuv420p",
                output_path,
            ]

    try:
        if progress_callback:
            cmd_with_progress = cmd[:-1] + ["-progress", "pipe:1", "-nostats", cmd[-1]]
            proc = subprocess.Popen(
                cmd_with_progress,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )

            total_dur = (end_time or 0) - (start_time or 0)
            if total_dur <= 0:
                try:
                    p_info = probe_video(video_path)
                    total_dur = float(p_info.get("duration", 0))
                except Exception:
                    total_dur = 0.0

            speed = ""
            fps_val = ""
            for line in proc.stdout:
                line = line.strip()
                if line.startswith("speed="):
                    speed = line.split("=")[1].strip()
                elif line.startswith("fps="):
                    fps_val = line.split("=")[1].strip()
                elif line.startswith("out_time_us="):
                    try:
                        us = int(line.split("=")[1])
                        if total_dur > 0:
                            pct = min(99, max(1, int((us / (total_dur * 1_000_000)) * 100)))
                            status_msg = f"Rendering video... {pct}%"
                            if speed:
                                status_msg += f" ({speed})"
                            progress_callback(pct, status_msg)
                    except Exception:
                        pass

            render_timeout = max(1800, int((total_dur or 0) * 3))
            proc.wait(timeout=render_timeout)
            if proc.returncode != 0:
                err_msg = proc.stderr.read() if proc.stderr else ""
                raise RuntimeError(f"ffmpeg failed: {err_msg[-500:]}")
            if progress_callback:
                progress_callback(100, "Rendering complete!")
        else:
            p_dur = 0.0
            try:
                p_info = probe_video(video_path)
                p_dur = float(p_info.get("duration", 0))
            except Exception:
                pass
            render_timeout = max(1800, int(p_dur * 3))
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=render_timeout)
            if result.returncode != 0:
                raise RuntimeError(f"ffmpeg failed: {result.stderr[-500:]}")
    finally:
        # Clean up subtitle PNG images and temporary concat files
        for si in sub_images:
            if os.path.exists(si["path"]):
                try:
                    os.remove(si["path"])
                except OSError:
                    pass
        for fp in sub_extra_files:
            if os.path.exists(fp):
                try:
                    os.remove(fp)
                except OSError:
                    pass

    return output_path


def extract_clips_to_temp(
    video_path: str,
    clips: list[dict],
) -> str | None:
    """
    Given a list of clip dicts with source_start/source_end,
    extract and concatenate only those portions into a temp video file.
    Returns path to the temp file, or None if clips cover the full video
    (meaning no extraction is needed).
    """
    if not clips or not os.path.exists(video_path):
        return None

    ffmpeg = _get_ffmpeg()

    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    # Single clip: fast path with stream copy
    if len(clips) == 1:
        clip = clips[0]
        ext = Path(video_path).suffix or ".mp4"
        output_path = os.path.join(export_dir, f"{uuid.uuid4()}_clips{ext}")
        duration = clip["source_end"] - clip["source_start"]
        cmd = [
            ffmpeg, "-y",
            "-ss", str(clip["source_start"]),
            "-i", video_path,
            "-t", str(duration),
            "-c", "copy",
            "-movflags", "+faststart",
            output_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg clip extract failed: {result.stderr[-500:]}")
        return output_path

    # Multiple clips: extract each then concatenate
    part_files = []
    try:
        for i, clip in enumerate(clips):
            part_path = os.path.join(export_dir, f"{uuid.uuid4()}_part{i}.ts")
            duration = clip["source_end"] - clip["source_start"]
            cmd = [
                ffmpeg, "-y",
                "-ss", str(clip["source_start"]),
                "-i", video_path,
                "-t", str(duration),
                "-c", "copy",
                "-bsf:v", "h264_mp4toannexb",
                "-f", "mpegts",
                part_path,
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if result.returncode != 0:
                raise RuntimeError(f"ffmpeg part extract failed: {result.stderr[-500:]}")
            part_files.append(part_path)

        # Concatenate parts
        ext = Path(video_path).suffix or ".mp4"
        output_path = os.path.join(export_dir, f"{uuid.uuid4()}_clips{ext}")
        concat_input = "concat:" + "|".join(part_files)
        cmd = [
            ffmpeg, "-y",
            "-i", concat_input,
            "-c", "copy",
            "-movflags", "+faststart",
            output_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg concat failed: {result.stderr[-500:]}")
        return output_path
    finally:
        for pf in part_files:
            if os.path.exists(pf):
                try:
                    os.remove(pf)
                except OSError:
                    pass


def concatenate_video_files(
    video_paths: list[str],
    output_path: str,
) -> float:
    """
    Concatenate multiple arbitrary video files into a single master video file.
    Normalizes resolution, framerate, and audio sample rates so videos of different
    formats/resolutions stitch together seamlessly without synchronization errors.
    Returns total duration in seconds.
    """
    valid_paths = [p for p in video_paths if os.path.exists(p)]
    if not valid_paths:
        raise FileNotFoundError("No valid video files provided for concatenation")
    if len(valid_paths) == 1:
        shutil.copyfile(valid_paths[0], output_path)
        return get_duration_ffprobe(output_path)

    ffmpeg = _get_ffmpeg()
    ffprobe = _get_ffprobe()

    # Determine master resolution from first video
    w, h = 1920, 1080
    try:
        probe_cmd = [
            ffprobe, "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "json",
            valid_paths[0],
        ]
        res = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=10)
        if res.returncode == 0:
            p_data = json.loads(res.stdout)
            streams = p_data.get("streams", [])
            if streams and "width" in streams[0] and "height" in streams[0]:
                w = int(streams[0]["width"])
                h = int(streams[0]["height"])
    except Exception:
        pass

    # Ensure even dimensions
    if w % 2 != 0:
        w -= 1
    if h % 2 != 0:
        h -= 1

    # Check audio stream presence for each input
    inputs = []
    filter_parts = []
    for i, p in enumerate(valid_paths):
        inputs.extend(["-i", p])
        filter_parts.append(
            f"[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v{i}];"
        )

        has_audio = False
        try:
            probe_a = [
                ffprobe, "-v", "error",
                "-select_streams", "a:0",
                "-show_entries", "stream=index",
                "-of", "csv=p=0",
                p,
            ]
            res_a = subprocess.run(probe_a, capture_output=True, text=True, timeout=5)
            has_audio = bool(res_a.stdout.strip())
        except Exception:
            has_audio = True

        if has_audio:
            filter_parts.append(
                f"[{i}:a]aformat=sample_rates=44100:channel_layouts=stereo[a{i}];"
            )
        else:
            filter_parts.append(
                f"anullsrc=channel_layout=stereo:sample_rate=44100,atrim=end=7200[a{i}];"
            )

    concat_inputs = "".join(f"[v{i}][a{i}]" for i in range(len(valid_paths)))
    filter_complex = "".join(filter_parts) + f"{concat_inputs}concat=n={len(valid_paths)}:v=1:a=1[outv][outa]"

    import sys
    is_macos = sys.platform == "darwin"
    if is_macos:
        v_codec = ["-c:v", "h264_videotoolbox", "-b:v", "8M", "-pix_fmt", "yuv420p"]
    else:
        v_codec = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "20"]

    cmd = [
        ffmpeg, "-y",
        *inputs,
        "-filter_complex", filter_complex,
        "-map", "[outv]", "-map", "[outa]",
        *v_codec,
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        cmd_fb = [
            ffmpeg, "-y",
            *inputs,
            "-filter_complex", filter_complex,
            "-map", "[outv]", "-map", "[outa]",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-crf", "22",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            output_path,
        ]
        res_fb = subprocess.run(cmd_fb, capture_output=True, text=True, timeout=600)
        if res_fb.returncode != 0:
            raise RuntimeError(f"Video concatenation failed: {res_fb.stderr[-400:]}")

    return get_duration_ffprobe(output_path)


# Vocal / BGM stems live next to the project video. New stems are FLAC (lossless, ~half
# the size of WAV); older projects may still have WAV, which stem_path() also finds.
STEM_NAMES = ("vocals", "bgm")
DEMUCS_MODEL = "htdemucs"
SEPARATION_CHUNK_SECONDS = 180.0   # bounds GPU/unified memory per inference call
# Separation keeps the GPU at full load, which on a long video heats a Mac up for minutes.
# A slower pace works in shorter bursts and rests between them: (chunk seconds, rest as a
# multiple of the time the chunk took). The overlap crossfade keeps the joins seamless.
SEPARATION_PACES = {
    "fast": (180.0, 0.0),
    "balanced": (60.0, 0.5),
    "cool": (30.0, 1.2),
}
SEPARATION_OVERLAP_SECONDS = 4.0   # crossfaded between chunks so joins are seamless

_separation_locks: dict[str, threading.Lock] = {}
# project_dir -> {"percent": int, "eta_seconds": int | None} while a separation is running
separation_progress: dict[str, dict] = {}
_separation_locks_guard = threading.Lock()
_demucs_model_cache = None
_demucs_model_lock = threading.Lock()
_demucs_infer_lock = threading.Lock()  # one inference at a time on the shared model/device


def stem_path(project_dir: str, name: str) -> str:
    """Existing stem file for `name` ('vocals' | 'bgm'), else the path a new one is written to."""
    for ext in (".flac", ".wav"):
        p = os.path.join(project_dir, name + ext)
        if os.path.exists(p):
            return p
    return os.path.join(project_dir, name + ".flac")


def stem_url(project_id: str, project_dir: str, name: str) -> str:
    path = stem_path(project_dir, name)
    # The file is rewritten in place when the BGM is cleaned; the version makes players reload it
    # (nanoseconds: two level changes can land within the same second)
    version = os.stat(path).st_mtime_ns // 1_000_000 if os.path.exists(path) else 0
    return f"/uploads/{project_id}/{os.path.basename(path)}?v={version}"


# --- Removing leftover dialogue from the BGM ---
# Demucs leaves some of the original voice in the music, so the source dialogue can be heard
# faintly under a dub. The vocal stem says where, in time and frequency, that voice is; the
# BGM is turned down only there (a Wiener-style soft mask). Measured on a drama: how closely
# the music's speech band follows the dialogue fell from 0.53 (raw) to 0.29 (light) and
# 0.16 (strong), while the music's overall level moved by under 1 dB.
BGM_CLEAN_LEVELS = {
    # level: (how hard the voice is weighed against the music, the most any bin is lowered)
    "light": (1.0, 0.15),
    "strong": (3.0, 0.05),
    "max": (6.0, 0.02),
}
BGM_CLEAN_DEFAULT = "light"
_BGM_BLOCK_SECONDS = 30.0
_BGM_PAD_SECONDS = 1.0   # context either side of a block, well over one FFT window
_BGM_NFFT, _BGM_HOP = 2048, 512


def _stems_state_path(project_dir: str) -> str:
    return os.path.join(project_dir, "stems.json")


def _stems_state(project_dir: str) -> dict:
    import json

    try:
        with open(_stems_state_path(project_dir)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def bgm_clean_level(project_dir: str) -> str:
    return _stems_state(project_dir).get("bgm_clean", "off")


def bgm_keeps_effects(project_dir: str) -> bool:
    """Whether sound effects are in the BGM right now. Max switches them off for as long as
    it is chosen; the user's own choice ("keep_effects") is kept and returns with Light/Strong."""
    state = _stems_state(project_dir)
    return bool(state.get("effects_active", state.get("keep_effects", False)))


# --- Sound effects that Demucs files under "vocals" ---
# Demucs separates music; a door slam, a punch or a whoosh is not music, so it often lands in
# the vocal stem — and disappears when that stem is replaced by the dub. A voice-activity
# detector (Silero VAD) marks where speech really is; everything else in the vocal stem is put
# back into the BGM. Measured on a 5-minute drama: 43 s of non-speech sound recovered this way,
# none of it dialogue.
_vad_model = None
_vad_lock = threading.Lock()
_EFFECTS_PAD = 0.08      # s of margin kept around each speech region
# Silero's own default is 0.5, which misses shouts, cries and lines over loud music — and what
# it misses is restored as an "effect", putting the original voice back under the dub. At 0.2,
# on a shouting scene, the voice left in the BGM fell below even the raw separation's
# (speech-band match 0.28 vs 0.36; it was 0.44 at 0.5) while 12 s of real effects still came
# back. Any more sensitive only loses effects. Bump the version when changing it.
_VAD_THRESHOLD = 0.2
_VAD_VERSION = "silero-0.2"
_EFFECTS_FADE = 0.03     # s crossfade at the edges, so nothing clicks


def detect_speech_seconds(vocals_path: str) -> list[list[float]]:
    """[start, end] of real speech in a vocal stem (Silero VAD)."""
    import librosa
    import soundfile as sf
    import torch
    from silero_vad import get_speech_timestamps, load_silero_vad

    global _vad_model
    with _vad_lock:
        if _vad_model is None:
            _vad_model = load_silero_vad()
        data, sr = sf.read(vocals_path, dtype="float32", always_2d=True)
        mono16 = librosa.resample(data.mean(1), orig_sr=sr, target_sr=16000)
        stamps = get_speech_timestamps(
            torch.from_numpy(mono16), _vad_model, sampling_rate=16000, return_seconds=True,
            threshold=_VAD_THRESHOLD, min_silence_duration_ms=150, speech_pad_ms=60,
        )
    return [[round(float(x["start"]), 3), round(float(x["end"]), 3)] for x in stamps]


def _speech_mask(regions: list[list[float]], start: int, frames: int, sr: int):
    """1 inside speech (plus a margin), 0 elsewhere, with short ramps — for samples
    start..start+frames."""
    import numpy as np

    mask = np.zeros(frames, dtype=np.float32)
    pad, fade = int(_EFFECTS_PAD * sr), max(1, int(_EFFECTS_FADE * sr))
    ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
    for a, b in regions:
        s0 = int(a * sr) - pad - start
        s1 = int(b * sr) + pad - start
        if s1 <= -fade or s0 >= frames + fade:
            continue
        lo, hi = max(0, s0), min(frames, s1)
        if hi > lo:
            mask[lo:hi] = 1.0
        # ramps just outside the region
        for i, v in enumerate(ramp):
            j = s0 - fade + i
            if 0 <= j < frames:
                mask[j] = max(mask[j], v)
            k = s1 + fade - 1 - i
            if 0 <= k < frames:
                mask[k] = max(mask[k], v)
    return mask


def _mask_block(bgm, voc, sr: int, weight: float, floor: float):
    import numpy as np
    from scipy.ndimage import uniform_filter
    from scipy.signal import istft, stft

    out = np.empty_like(bgm)
    for ch in range(bgm.shape[1]):
        _, _, B = stft(bgm[:, ch], sr, nperseg=_BGM_NFFT, noverlap=_BGM_NFFT - _BGM_HOP)
        _, _, V = stft(voc[:, ch % voc.shape[1]], sr, nperseg=_BGM_NFFT, noverlap=_BGM_NFFT - _BGM_HOP)
        music = np.abs(B) ** 2
        # smoothed a little so the mask does not flicker bin to bin ("musical noise")
        voice = uniform_filter(np.abs(V) ** 2, size=(3, 3))
        mask = np.maximum(floor, music / (music + weight * voice + 1e-10))
        _, y = istft(B * mask, sr, nperseg=_BGM_NFFT, noverlap=_BGM_NFFT - _BGM_HOP)
        out[:, ch] = y[: len(bgm)] if len(y) >= len(bgm) else np.pad(y, (0, len(bgm) - len(y)))
    return out


def clean_bgm(project_dir: str, level: str, keep_effects: bool | None = None,
              dialogue: list[list[float]] | None = None) -> str:
    """Set how much leftover dialogue is removed from the BGM: 'off', 'light', 'strong' or 'max' —
    and, with keep_effects, put back the sound effects Demucs filed under vocals.
    The untouched BGM is kept as bgm.raw.flac, so any setting can be chosen again later.
    keep_effects=None keeps whatever this project had.

    `dialogue` is the captioned lines ([start, end] seconds). The voice detector misses shouts,
    cries and lines buried in loud music; anything inside a caption is dialogue whatever the
    detector thinks, so it is never restored as an "effect" and is cleaned out of the music."""
    import json

    import numpy as np
    import soundfile as sf

    if level != "off" and level not in BGM_CLEAN_LEVELS:
        raise ValueError(f"Unknown BGM clean level {level!r}")
    bgm = stem_path(project_dir, "bgm")
    vocals = stem_path(project_dir, "vocals")
    if not (os.path.exists(bgm) and os.path.exists(vocals)):
        raise FileNotFoundError("Isolate vocals & BGM first")

    raw = os.path.join(project_dir, "bgm.raw.flac")
    if not os.path.exists(raw):
        # first clean: whatever is there now is the untouched Demucs output
        if bgm_clean_level(project_dir) != "off":
            raise RuntimeError("The original BGM is missing; isolate the audio again")
        if bgm.endswith(".flac"):
            shutil.copyfile(bgm, raw)
        else:
            data, sr = sf.read(bgm, dtype="float32", always_2d=True)
            sf.write(raw, data, sr, subtype="PCM_16", format="FLAC")

    state = _stems_state(project_dir)
    # the user's choice, remembered on its own so a spell on Max does not erase it
    wants_effects = bool(state.get("keep_effects", False)) if keep_effects is None else bool(keep_effects)
    # Max also suppresses vocal energy missed by speech detection. Restoring the
    # non-speech stem here would reintroduce exactly those missed words, so it is
    # skipped for as long as Max is chosen — and comes back with Light or Strong.
    keep_effects = wants_effects and level != "max"
    # speech found with an older, less sensitive setting is looked for again
    speech = state.get("speech") if state.get("speech_version") == _VAD_VERSION else None
    if speech is None and (keep_effects or level not in ("off", "max")):
        try:
            speech = detect_speech_seconds(vocals)
        except Exception as e:  # without VAD, fall back to treating the whole stem as voice
            print(f"[BGM] speech detection unavailable: {e}", flush=True)
            speech = None

    # where speech is: what the detector heard, plus every captioned line
    speech_used = speech
    if dialogue:
        speech_used = sorted([*(speech or []), *[[float(a), float(b)] for a, b in dialogue if b > a]])

    target = os.path.join(project_dir, "bgm.flac")
    part = os.path.join(project_dir, "bgm.part.flac")
    try:
        if level == "off" and not keep_effects:
            shutil.copyfile(raw, part)
        else:
            weight, floor = BGM_CLEAN_LEVELS.get(level, (0.0, 1.0))
            info = sf.info(raw)
            sr, frames = info.samplerate, info.frames
            block, pad = int(_BGM_BLOCK_SECONDS * sr), int(_BGM_PAD_SECONDS * sr)
            with sf.SoundFile(part, "w", sr, info.channels, subtype="PCM_16", format="FLAC") as out:
                for start in range(0, frames, block):
                    a, b = max(0, start - pad), min(frames, start + block + pad)
                    music = sf.read(raw, start=a, frames=b - a, dtype="float32", always_2d=True)[0]
                    voice = sf.read(vocals, start=a, frames=b - a, dtype="float32", always_2d=True)[0]
                    if len(voice) < len(music):
                        voice = np.pad(voice, ((0, len(music) - len(voice)), (0, 0)))
                    voice = voice[: len(music)]
                    if voice.shape[1] != music.shape[1]:
                        voice = np.repeat(voice[:, :1], music.shape[1], axis=1)
                    # which part of the vocal stem is really speech
                    speaking = (_speech_mask(speech_used, a, len(music), sr) if speech_used is not None
                                else np.ones(len(music), dtype=np.float32))[:, None]
                    if level != "off":
                        # guided by speech only, so sound effects in the BGM are not turned down
                        guide = voice if level == "max" else voice * speaking
                        result = _mask_block(music, guide, sr, weight, floor)
                    else:
                        result = music
                    if keep_effects and speech_used is not None:
                        result = result + voice * (1.0 - speaking)
                    # keep only this block's own stretch; the padding was context
                    head = start - a
                    out.write(np.clip(result[head: head + min(block, frames - start)], -1, 1))
        os.replace(part, target)
    finally:
        _remove_quietly(part)
    if bgm != target:
        _remove_quietly(bgm)   # an older WAV stem, now replaced by the FLAC
    _remove_quietly(os.path.join(project_dir, "bgm.peaks.json"))
    with open(_stems_state_path(project_dir), "w") as f:
        json.dump({"bgm_clean": level, "keep_effects": wants_effects,
                   "effects_active": bool(keep_effects), "speech": speech,
                   "speech_version": _VAD_VERSION if speech is not None else None}, f)
    return target


def stems_ready(project_dir: str, video_path: str | None = None) -> bool:
    """Both stems exist (and, if video_path is given, are newer than the video)."""
    paths = [stem_path(project_dir, n) for n in STEM_NAMES]
    if not all(os.path.exists(p) for p in paths):
        return False
    if video_path and os.path.exists(video_path):
        return all(os.path.getmtime(p) >= os.path.getmtime(video_path) for p in paths)
    return True


def separate_audio(video_path: str, project_dir: str) -> dict:
    """
    Separate the video's audio into vocals and background music (BGM) with Demucs.
    Runs at most once per project at a time; a concurrent caller waits and reuses the result.
    Raises RuntimeError if separation fails — there is no lower-quality silent fallback.
    """
    video_path = os.path.abspath(video_path)
    project_dir = os.path.abspath(project_dir)

    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    with _separation_locks_guard:
        lock = _separation_locks.setdefault(project_dir, threading.Lock())

    with lock:
        if stems_ready(project_dir, video_path):
            return {n: stem_path(project_dir, n) for n in STEM_NAMES}

        ffmpeg = _get_ffmpeg()
        os.makedirs(project_dir, exist_ok=True)

        probe = subprocess.run([ffmpeg, "-i", video_path, "-hide_banner"], capture_output=True, text=True, timeout=30)
        if "Audio:" not in probe.stdout + probe.stderr:
            raise RuntimeError("This video file does not contain an audio track. Cannot isolate vocals.")

        # Drop stale stems (either format) before writing new ones
        for n in STEM_NAMES:
            for ext in (".flac", ".wav"):
                _remove_quietly(os.path.join(project_dir, n + ext))
        _remove_quietly(os.path.join(project_dir, "bgm.raw.flac"))
        _remove_quietly(_stems_state_path(project_dir))

        separation_progress[project_dir] = {"percent": 1, "eta_seconds": None}
        full_path = os.path.join(project_dir, "full_audio.wav")
        out = {n: os.path.join(project_dir, n + ".flac") for n in STEM_NAMES}
        tmp_out = {n: os.path.join(project_dir, f"{n}.part.flac") for n in STEM_NAMES}
        try:
            r = subprocess.run(
                [ffmpeg, "-y", "-i", video_path, "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", full_path],
                capture_output=True, text=True, timeout=1800,
            )
            if r.returncode != 0:
                raise RuntimeError(f"Audio extraction failed: {r.stderr[-500:]}")

            started = time.monotonic()

            def _on_progress(fraction: float):
                elapsed = time.monotonic() - started
                eta = int(elapsed / fraction - elapsed) if fraction > 0.02 else None
                separation_progress[project_dir] = {"percent": max(3, min(99, int(3 + fraction * 96))), "eta_seconds": eta}

            _run_demucs_chunked(full_path, tmp_out["vocals"], tmp_out["bgm"], _on_progress)
            for n in STEM_NAMES:
                os.replace(tmp_out[n], out[n])
            print(f"[Demucs] Done in {time.monotonic() - started:.0f}s", flush=True)
            try:
                clean_bgm(project_dir, BGM_CLEAN_DEFAULT, keep_effects=True)
            except Exception as e:  # the raw BGM is still usable
                print(f"[Demucs] BGM cleanup skipped: {e}", flush=True)
        finally:
            separation_progress.pop(project_dir, None)
            # Always drop the full-length temp WAV (hundreds of MB) and partial outputs
            _remove_quietly(full_path)
            for p in tmp_out.values():
                _remove_quietly(p)

        return out


def _get_demucs_model(device: str | None = None):
    """Lazy-load and cache Demucs on CUDA/MPS/CPU. Passing a different device reloads it there."""
    global _demucs_model_cache
    with _demucs_model_lock:
        if _demucs_model_cache is None or (device and _demucs_model_cache[1] != device):
            import torch
            from demucs.pretrained import get_model
            torch.set_num_threads(min(8, max(2, os.cpu_count() or 4)))
            if device is None:
                device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
            print(f"[Demucs] Loading {DEMUCS_MODEL} on {device}...")
            model = get_model(DEMUCS_MODEL)
            model.to(device)
            model.eval()
            _demucs_model_cache = (model, device)
    return _demucs_model_cache


def _demucs_chunk(model, device: str, chunk, norm: tuple[float, float] | None = None):
    """Separate one (frames, 2) float32 chunk. Returns (vocals, bgm) arrays of the same shape.

    `norm` is the (mean, std) of the WHOLE track, as Demucs's own tool uses. Demucs is not
    linear, so scaling each chunk by its own level made the result depend on where the chunk
    boundaries fell — two chunkings of the same audio differed by as much as the BGM itself.
    """
    import numpy as np
    import torch
    from demucs.apply import apply_model

    wav = torch.from_numpy(np.ascontiguousarray(chunk.T))
    if norm is None:
        ref = wav.mean(0)
        norm = (float(ref.mean()), float(ref.std()))
    mean, std = norm[0], max(norm[1], 1e-4)
    with torch.inference_mode():
        sources = apply_model(
            model, ((wav - mean) / std)[None].to(device), device=device,
            shifts=0, split=True, overlap=0.15, progress=False,
        )[0]
        sources = (sources * std + mean).cpu()
    vocal_idx = model.sources.index("vocals")
    vocals = sources[vocal_idx]
    bgm = sum(sources[i] for i in range(len(model.sources)) if i != vocal_idx)  # drums + bass + other
    return vocals.numpy().T.astype(np.float32), bgm.numpy().T.astype(np.float32)


def _run_demucs_chunked(audio_path: str, vocals_out: str, bgm_out: str, on_progress=None,
                        pace: str | None = None) -> None:
    """Separate a 44.1 kHz stereo WAV chunk by chunk, crossfading the overlaps, streaming to FLAC.
    Retries once on CPU if the GPU run fails."""
    import gc
    import numpy as np
    import soundfile as sf
    import torch

    def _attempt(device: str | None):
        model, dev = _get_demucs_model(device)
        info = sf.info(audio_path)
        sr = info.samplerate
        if sr != model.samplerate:
            raise RuntimeError(f"Expected {model.samplerate} Hz input, got {sr}")
        chunk_seconds, rest_ratio = SEPARATION_PACES.get(pace or settings.separation_pace, SEPARATION_PACES["balanced"])
        # the whole track's level, read once in blocks so a long video never sits in memory
        total = total_sq = 0.0
        count = 0
        for blk in sf.blocks(audio_path, blocksize=sr * 60, dtype="float32", always_2d=True):
            mono = blk.mean(1).astype(np.float64)
            total += mono.sum()
            total_sq += (mono * mono).sum()
            count += len(mono)
        g_mean = total / max(1, count)
        norm = (g_mean, float(np.sqrt(max(0.0, total_sq / max(1, count) - g_mean * g_mean))))
        chunk = int(chunk_seconds * sr)
        overlap = int(SEPARATION_OVERLAP_SECONDS * sr)
        fade_in = np.linspace(0.0, 1.0, overlap, dtype=np.float32)[:, None]
        print(f"[Demucs] Separating {info.frames / sr:.0f}s on {dev} in {chunk_seconds:.0f}s chunks"
              f"{f', resting {rest_ratio:g}x between them' if rest_ratio else ''}", flush=True)

        with _demucs_infer_lock, \
                sf.SoundFile(vocals_out, "w", sr, 2, subtype="PCM_16", format="FLAC") as fv, \
                sf.SoundFile(bgm_out, "w", sr, 2, subtype="PCM_16", format="FLAC") as fb:
            prev_tail = None  # previous chunk's (vocals, bgm) overlap region, faded out into this one
            start = 0
            while start < info.frames:
                block = sf.read(audio_path, start=start, frames=chunk + overlap, dtype="float32", always_2d=True)[0]
                if block.shape[1] == 1:
                    block = np.repeat(block, 2, axis=1)
                burst = time.monotonic()
                v, b = _demucs_chunk(model, dev, block, norm)
                burst = time.monotonic() - burst
                is_last = start + chunk >= info.frames
                head = 0
                if prev_tail is not None:
                    n = min(len(prev_tail[0]), len(v))
                    w = fade_in[:n]
                    fv.write(np.clip(prev_tail[0][:n] * (1 - w) + v[:n] * w, -1, 1))
                    fb.write(np.clip(prev_tail[1][:n] * (1 - w) + b[:n] * w, -1, 1))
                    head = n
                body_end = len(v) if is_last else max(head, len(v) - overlap)
                fv.write(np.clip(v[head:body_end], -1, 1))
                fb.write(np.clip(b[head:body_end], -1, 1))
                prev_tail = None if is_last else (v[body_end:], b[body_end:])
                start += chunk
                if on_progress:
                    on_progress(min(1.0, start / info.frames))
                del block, v, b
                gc.collect()
                if rest_ratio and start < info.frames:
                    time.sleep(burst * rest_ratio)   # let the GPU cool before the next burst

        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        elif torch.cuda.is_available():
            torch.cuda.empty_cache()

    try:
        _attempt(None)
    except Exception as e:
        device = _demucs_model_cache[1] if _demucs_model_cache else None
        if device == "cpu":
            raise RuntimeError(f"Vocal/BGM separation failed: {e}") from e
        print(f"[Demucs] {device} separation failed ({e}); retrying on CPU (slower)")
        try:
            _attempt("cpu")
        except Exception as e2:
            raise RuntimeError(f"Vocal/BGM separation failed: {e2}") from e2


# Files in a project dir that can be rebuilt from the source video
DERIVED_AUDIO_FILES = (
    "bgm.flac", "vocals.flac", "bgm.wav", "vocals.wav",
    "bgm.part.flac", "vocals.part.flac", "full_audio.wav",
    "bgm.peaks.json", "vocals.peaks.json",
    "bgm.raw.flac", "stems.json",
)


def _remove_quietly(path: str) -> None:
    try:
        if os.path.isfile(path):
            os.remove(path)
    except OSError:
        pass


def clear_derived_audio(project_dir: str) -> None:
    """Delete separated stems and temp audio so they get rebuilt for the current video."""
    for name in DERIVED_AUDIO_FILES:
        _remove_quietly(os.path.join(project_dir, name))
    shutil.rmtree(os.path.join(project_dir, "_demucs_tmp"), ignore_errors=True)


PEAKS_BUCKETS = 2000  # resolution of the cached waveform, enough for a full-width timeline


def stem_peaks(project_dir: str, name: str, buckets: int = PEAKS_BUCKETS) -> list[float]:
    """Loudness envelope (0..1) of a separated stem, for drawing it in the timeline.
    Cached next to the stem, since scanning a long FLAC takes a few seconds."""
    import json

    import numpy as np
    import soundfile as sf

    path = stem_path(project_dir, name)
    if not os.path.isfile(path):
        raise FileNotFoundError(f"{name} track not found")

    cache = os.path.join(project_dir, f"{name}.peaks.json")
    if os.path.exists(cache) and os.path.getmtime(cache) >= os.path.getmtime(path):
        try:
            with open(cache) as f:
                cached = json.load(f)
            if isinstance(cached, list) and len(cached) == buckets:
                return cached
        except (OSError, ValueError):
            pass

    info = sf.info(path)
    frames_per_bucket = max(1, info.frames // buckets)
    peaks: list[float] = []
    with sf.SoundFile(path) as f:
        while len(peaks) < buckets:
            block = f.read(frames_per_bucket, dtype="float32", always_2d=True)
            if not len(block):
                break
            peaks.append(float(np.abs(block).max()))
    if not peaks:
        return []
    loudest = max(peaks) or 1.0
    peaks = [round(min(1.0, p / loudest), 3) for p in peaks]
    peaks += [0.0] * (buckets - len(peaks))
    try:
        with open(cache, "w") as f:
            json.dump(peaks, f)
    except OSError:
        pass
    return peaks


EXPORT_RETENTION_DAYS = 3


def prune_old_exports(upload_dir: str, max_age_days: int = EXPORT_RETENTION_DAYS) -> int:
    """Delete rendered exports older than `max_age_days`. They are copies of files already
    saved to the user's chosen folder. Returns how many were removed."""
    export_dir = os.path.join(upload_dir, "exports")
    if not os.path.isdir(export_dir):
        return 0
    cutoff = time.time() - max_age_days * 86400
    removed = 0
    for entry in os.scandir(export_dir):
        try:
            if entry.is_file() and entry.stat().st_mtime < cutoff:
                os.remove(entry.path)
                removed += 1
        except OSError:
            pass
    return removed


def cleanup_stale_temp_files(upload_dir: str) -> None:
    """Startup sweep: remove temp audio and old renders."""
    prune_old_exports(upload_dir)
    if not os.path.isdir(upload_dir):
        return
    for entry in os.scandir(upload_dir):
        if entry.is_dir():
            for name in ("full_audio.wav", "bgm.part.flac", "vocals.part.flac"):
                _remove_quietly(os.path.join(entry.path, name))
            shutil.rmtree(os.path.join(entry.path, "_demucs_tmp"), ignore_errors=True)


def flip_video(
    video_path: str,
    direction: str = "horizontal",
) -> str:
    """
    Flip/mirror video horizontally or vertically.
    direction: 'horizontal' (left-right mirror) or 'vertical' (upside-down).
    Returns path to flipped video.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    ffmpeg = _get_ffmpeg()
    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    ext = Path(video_path).suffix or ".mp4"
    output_filename = f"{uuid.uuid4()}_flip_{direction}{ext}"
    output_path = os.path.join(export_dir, output_filename)

    vf = "hflip" if direction == "horizontal" else "vflip"

    cmd = [
        ffmpeg, "-y",
        "-i", video_path,
        "-vf", vf,
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg flip failed: {result.stderr[-500:]}")

    return output_path


def rotate_video(
    video_path: str,
    angle: int = 90,
) -> str:
    """
    Rotate video by a given angle.
    angle: 90 (clockwise), -90/270 (counter-clockwise), or 180.
    Returns path to rotated video.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    ffmpeg = _get_ffmpeg()
    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    ext = Path(video_path).suffix or ".mp4"
    output_filename = f"{uuid.uuid4()}_rotate_{angle}{ext}"
    output_path = os.path.join(export_dir, output_filename)

    # Map angle to ffmpeg transpose values
    if angle == 90:
        vf = "transpose=1"  # 90 clockwise
    elif angle in (-90, 270):
        vf = "transpose=2"  # 90 counter-clockwise
    elif angle == 180:
        vf = "transpose=1,transpose=1"  # 180 degrees
    else:
        raise ValueError(f"Unsupported rotation angle: {angle}. Use 90, -90, 180, or 270.")

    cmd = [
        ffmpeg, "-y",
        "-i", video_path,
        "-vf", vf,
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg rotate failed: {result.stderr[-500:]}")

    return output_path


def crop_video(
    video_path: str,
    x: int,
    y: int,
    width: int,
    height: int,
) -> str:
    """
    Crop video to a region defined by (x, y, width, height).
    Returns path to cropped video.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    if width < 2 or height < 2:
        raise ValueError("Crop width and height must be at least 2")
    if x < 0 or y < 0:
        raise ValueError("Crop x and y must be non-negative")

    # Force even dimensions for h264
    width = width if width % 2 == 0 else width - 1
    height = height if height % 2 == 0 else height - 1

    ffmpeg = _get_ffmpeg()
    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    ext = Path(video_path).suffix or ".mp4"
    output_filename = f"{uuid.uuid4()}_crop{ext}"
    output_path = os.path.join(export_dir, output_filename)

    vf = f"crop={width}:{height}:{x}:{y}"

    cmd = [
        ffmpeg, "-y",
        "-i", video_path,
        "-vf", vf,
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg crop failed: {result.stderr[-500:]}")

    return output_path


def normalize_blur_regions(regions: list[dict], vid_w: int, vid_h: int) -> list[dict]:
    """Regions may arrive as percentages (x_pct/width_pct…) or pixels. Returns pixel rects
    clamped to the frame (even sizes), each with how it is hidden:

    style     "blur" (default), "pixelate" or "solid"
    strength  as the editor shows it: CSS blur px (or mosaic block px) on a 720-high frame,
              scaled here to this video's height; missing means the old automatic size
    tint      0-1 darkening laid over a blur or mosaic, as the editor previews it
    color     fill for "solid"
    start/end optional seconds; missing means the whole video
    """
    out = []
    for r in regions or []:
        if "x_pct" in r and "width_pct" in r:
            rx = int(round((float(r["x_pct"]) / 100.0) * vid_w))
            ry = int(round((float(r.get("y_pct", 0)) / 100.0) * vid_h))
            rw = int(round((float(r["width_pct"]) / 100.0) * vid_w))
            rh = int(round((float(r.get("height_pct", 10)) / 100.0) * vid_h))
        else:
            rx, ry = int(r.get("x", 0)), int(r.get("y", 0))
            rw, rh = int(r.get("width", 100)), int(r.get("height", 50))

        rx = max(0, min(rx, vid_w - 4))
        ry = max(0, min(ry, vid_h - 4))
        rw = max(4, min(rw, vid_w - rx))
        rh = max(4, min(rh, vid_h - ry))
        rx -= rx % 2
        ry -= ry % 2
        rw += rw % 2
        rh += rh % 2
        rw = min(rw, vid_w - rx)
        rh = min(rh, vid_h - ry)

        style = str(r.get("style") or "blur")
        if style not in ("blur", "pixelate", "solid"):
            style = "blur"
        strength = r.get("strength")
        scale = vid_h / 720.0
        start, end = r.get("start"), r.get("end")
        out.append({
            "x": rx, "y": ry, "width": rw, "height": rh,
            "blur_x": max(6, min(32, rw // 2)), "blur_y": max(6, min(32, rh // 2)),
            "style": style,
            # CSS blur(r) is a Gaussian with standard deviation r, which is what gblur's sigma is
            "sigma": None if strength is None else round(max(1.0, float(strength) * scale), 2),
            "block": max(2, round((float(strength) if strength is not None else 16) * scale)),
            "tint": max(0.0, min(1.0, float(r.get("tint") or 0))),
            "color": _hex_ffmpeg(r.get("color") or "#000000"),
            "start": None if start is None else max(0.0, float(start)),
            "end": None if end is None else float(end),
        })
    return out


def _hex_ffmpeg(color: str) -> str:
    c = str(color or "").strip().lstrip("#")
    return f"0x{c.upper()}" if re.fullmatch(r"[0-9a-fA-F]{6}", c) else "black"


def _blur_region_chain(r: dict) -> str:
    """Filters applied to one cropped region: how it is hidden, then its tint."""
    if r["style"] == "solid":
        return f"drawbox=x=0:y=0:w=iw:h=ih:color={r['color']}@1:t=fill"
    if r["style"] == "pixelate":
        b = r["block"]
        chain = (f"scale=w='max(1\\,trunc(iw/{b}))':h='max(1\\,trunc(ih/{b}))':flags=area,"
                 f"scale={r['width']}:{r['height']}:flags=neighbor")
    elif r.get("sigma"):
        chain = f"gblur=sigma={r['sigma']}:steps=3"
    else:
        chain = f"avgblur=sizeX={r['blur_x']}:sizeY={r['blur_y']}"
    if r["tint"] > 0.001:
        # the editor previews the tint as black at 70% of the chosen darkness
        chain += f",drawbox=x=0:y=0:w=iw:h=ih:color=black@{r['tint'] * 0.7:.3f}:t=fill"
    return chain


def _blur_enable(r: dict, time_offset: float) -> str:
    if r.get("start") is None and r.get("end") is None:
        return ""
    a = (r.get("start") or 0.0) - time_offset
    b = (r["end"] if r.get("end") is not None else 1e9) - time_offset
    return f":enable='between(t,{a:.3f},{b:.3f})'"


def blur_filter_prefix(regions_px: list[dict], time_offset: float = 0.0) -> str:
    """Filtergraph that hides the given pixel rects of the incoming video, ending with a comma
    so the rest of the video chain (scaling, padding…) can be appended. `time_offset` is where
    the incoming video starts in the edit, for a render that begins part-way in."""
    if not regions_px:
        return ""
    n = len(regions_px)
    parts = [f"split={n + 1}[base]" + "".join(f"[c{i}]" for i in range(n))]
    for i, r in enumerate(regions_px):
        parts.append(f"[c{i}]crop={r['width']}:{r['height']}:{r['x']}:{r['y']},{_blur_region_chain(r)}[b{i}]")
    graph = ";".join(parts) + ";"
    current = "[base]"
    for i, r in enumerate(regions_px):
        last = i == n - 1
        graph += f"{current}[b{i}]overlay={r['x']}:{r['y']}:format=auto{_blur_enable(r, time_offset)}"
        if last:
            graph += ","
        else:
            graph += f"[t{i}];"
            current = f"[t{i}]"
    return graph


def blur_regions(
    video_path: str,
    regions: list[dict],
) -> str:
    """
    Blur multiple rectangular regions of the video simultaneously (e.g. watermark + subtitles)
    while leaving the rest of the frame untouched. Returns path to output video.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")
    if not regions:
        return video_path

    ffmpeg = _get_ffmpeg()
    ffprobe = _get_ffprobe()

    # Probe actual video dimensions to clamp crop region accurately
    vid_w, vid_h = 1920, 1080
    try:
        probe_cmd = [
            ffprobe, "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "json",
            video_path,
        ]
        res = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=15)
        if res.returncode == 0:
            p_data = json.loads(res.stdout)
            streams = p_data.get("streams", [])
            if streams and "width" in streams[0] and "height" in streams[0]:
                vid_w = int(streams[0]["width"])
                vid_h = int(streams[0]["height"])
    except Exception as ex:
        print(f"Warning: Could not probe video dimensions for blur: {ex}")

    valid_regions = normalize_blur_regions(regions, vid_w, vid_h)

    if not valid_regions:
        return video_path

    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    ext = Path(video_path).suffix or ".mp4"
    output_filename = f"{uuid.uuid4()}_blur{ext}"
    output_path = os.path.join(export_dir, output_filename)

    # the same graph the export uses, so a burned blur looks exactly like an exported one
    filter_complex = "[0:v]" + blur_filter_prefix(valid_regions) + "null[outv]"

    v_codec = (
        ["-c:v", "h264_videotoolbox", "-b:v", "6500k", "-pix_fmt", "yuv420p"]
        if _has_videotoolbox(ffmpeg)
        else ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "22"]
    )

    cmd = [
        ffmpeg, "-y",
        "-i", video_path,
        "-filter_complex", filter_complex,
        "-map", "[outv]", "-map", "0:a?",
        *v_codec,
        "-c:a", "copy",
        "-threads", "0",
        "-movflags", "+faststart",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        cmd_fb = [
            ffmpeg, "-y",
            "-i", video_path,
            "-filter_complex", filter_complex,
            "-map", "[outv]", "-map", "0:a?",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-crf", "20",
            "-c:a", "aac", "-b:a", "192k",
            "-threads", "0",
            "-movflags", "+faststart",
            output_path,
        ]
        result_fb = subprocess.run(cmd_fb, capture_output=True, text=True, timeout=600)
        if result_fb.returncode != 0:
            raise RuntimeError(f"FFmpeg multi-blur failed: {result_fb.stderr[-300:]}")

    return output_path


def apply_logo_overlay(
    video_path: str,
    logo_path: str,
    position: str = "top_right",
    scale_pct: float = 15.0,
    opacity: float = 1.0,
    x_pct: float | None = None,
    y_pct: float | None = None,
) -> str:
    """Burn logo/watermark/image overlay onto video in-place with hardware acceleration."""
    video_path = os.path.abspath(video_path)
    logo_path = os.path.abspath(logo_path)
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")
    if not os.path.exists(logo_path):
        raise FileNotFoundError(f"Logo image not found: {logo_path}")

    ffmpeg = _get_ffmpeg()
    info = probe_video(video_path)
    w, h = info["width"], info["height"]
    if w <= 0 or h <= 0:
        w, h = 1920, 1080

    logo_w = max(24, round(w * max(3.0, min(80.0, float(scale_pct or 15.0))) / 100.0))
    if position == "top_left":
        ox, oy = "24", "24"
    elif position == "top_right":
        ox, oy = "main_w-overlay_w-24", "24"
    elif position == "bottom_left":
        ox, oy = "24", "main_h-overlay_h-36"
    elif position == "bottom_right":
        ox, oy = "main_w-overlay_w-24", "main_h-overlay_h-36"
    elif position == "center":
        ox, oy = "(main_w-overlay_w)/2", "(main_h-overlay_h)/2"
    else:  # custom
        cx = max(0, min(100, float(x_pct if x_pct is not None else 85.0)))
        cy = max(0, min(100, float(y_pct if y_pct is not None else 5.0)))
        ox = f"(main_w-overlay_w)*{cx/100.0:.3f}"
        oy = f"(main_h-overlay_h)*{cy/100.0:.3f}"

    op = max(0.05, min(1.0, float(opacity if opacity is not None else 1.0)))

    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)
    ext = Path(video_path).suffix or ".mp4"
    output_filename = f"{uuid.uuid4()}_logo{ext}"
    output_path = os.path.join(export_dir, output_filename)

    fc = (
        f"[1:v]scale={logo_w}:-1:force_original_aspect_ratio=decrease,format=rgba,colorchannelmixer=aa={op}[logo_scaled];"
        f"[0:v][logo_scaled]overlay={ox}:{oy}:format=auto[outv]"
    )

    v_codec = (
        ["-c:v", "h264_videotoolbox", "-b:v", "6500k", "-pix_fmt", "yuv420p"]
        if _has_videotoolbox(ffmpeg)
        else ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "22"]
    )

    cmd = [
        ffmpeg, "-y",
        "-i", video_path,
        "-i", logo_path,
        "-filter_complex", fc,
        "-map", "[outv]", "-map", "0:a?",
        *v_codec,
        "-c:a", "copy",
        "-threads", "0",
        "-movflags", "+faststart",
        output_path,
    ]

    r = subprocess.run(cmd, capture_output=True, text=True, timeout=1200)
    if r.returncode != 0:
        cmd_fb = [
            ffmpeg, "-y",
            "-i", video_path,
            "-i", logo_path,
            "-filter_complex", fc,
            "-map", "[outv]", "-map", "0:a?",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-crf", "20",
            "-c:a", "aac", "-b:a", "192k",
            "-threads", "0",
            "-movflags", "+faststart",
            output_path,
        ]
        r_fb = subprocess.run(cmd_fb, capture_output=True, text=True, timeout=1200)
        if r_fb.returncode != 0:
            raise RuntimeError(f"Failed to burn logo overlay: {r_fb.stderr[-300:]}")

    return output_path


def split_video(
    video_path: str,
    split_points: list[float],
) -> list[str]:
    """
    Split video at specified timestamps into multiple parts.
    split_points: list of timestamps in seconds where to split.
    Returns list of paths to split video files.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    if not split_points:
        raise ValueError("At least one split point is required")

    ffmpeg = _get_ffmpeg()
    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    ext = Path(video_path).suffix or ".mp4"
    split_id = uuid.uuid4().hex[:8]

    # Sort and deduplicate
    points = sorted(set(split_points))
    # Create intervals: [0, p1], [p1, p2], ..., [pN, end]
    boundaries = [0.0] + points + [None]  # None = to end

    output_paths = []
    for i in range(len(boundaries) - 1):
        start = boundaries[i]
        end = boundaries[i + 1]

        output_filename = f"{split_id}_part{i+1}{ext}"
        output_path = os.path.join(export_dir, output_filename)

        cmd = [ffmpeg, "-y", "-ss", str(start), "-i", video_path]
        if end is not None:
            cmd += ["-t", str(end - start)]
        cmd += ["-c", "copy", "-movflags", "+faststart", output_path]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg split part {i+1} failed: {result.stderr[-500:]}")

        output_paths.append(output_path)

    return output_paths


def get_duration_ffprobe(video_path: str) -> float:
    """Get video duration using ffprobe."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        ffprobe = shutil.which("ffmpeg")
        if not ffprobe:
            return 0.0
        # Use ffmpeg -i to read duration (fallback)
        cmd = [ffprobe, "-i", video_path]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        # Parse duration from stderr
        import re
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+)\.(\d+)", r.stderr)
        if m:
            return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + int(m.group(4)) / 100
        return 0.0

    cmd = [
        ffprobe, "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_path,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if r.returncode == 0 and r.stdout.strip():
        try:
            return float(r.stdout.strip())
        except ValueError:
            pass
    return 0.0


def _escape_drawtext(text: str) -> str:
    """Escape text for ffmpeg drawtext filter."""
    t = text.replace("\\", "\\\\\\\\").replace("'", "'\\\\\\''")
    t = t.replace(":", "\\:").replace("%", "%%")
    return t


def burn_subtitles(
    video_path: str,
    segments: list[dict],
    font_size: int = 28,
    font_color: str = "white",
    position: str = "bottom",
    bg_opacity: float = 0.5,
) -> str:
    """
    Burn subtitle segments into video as drawtext overlays.
    Each segment dict needs: text, start_time, end_time.
    Returns path to output video.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    if not segments:
        raise ValueError("No subtitle segments to burn")

    ffmpeg = _get_ffmpeg()
    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    ext = Path(video_path).suffix or ".mp4"
    output_filename = f"{uuid.uuid4()}_subtitled{ext}"
    output_path = os.path.join(export_dir, output_filename)

    pos_map = {
        "top": "x=(w-text_w)/2:y=50",
        "center": "x=(w-text_w)/2:y=(h-text_h)/2",
        "bottom": "x=(w-text_w)/2:y=h-text_h-50",
    }
    xy = pos_map.get(position, pos_map["bottom"])
    bg_color = f"black@{bg_opacity}"

    # Build chained drawtext filters — one per segment
    filters = []
    for seg in segments:
        text = seg.get("text", "").strip()
        if not text:
            continue
        safe_text = _escape_drawtext(text)
        st = seg.get("start_time", 0)
        et = seg.get("end_time", st + 1)
        enable = f"between(t,{st},{et})"
        f = (
            f"drawtext=text='{safe_text}':"
            f"fontsize={font_size}:"
            f"fontcolor={font_color}:"
            f"{xy}:"
            f"box=1:boxcolor={bg_color}:boxborderw=8:"
            f"enable='{enable}'"
        )
        filters.append(f)

    if not filters:
        raise ValueError("No non-empty subtitle segments to burn")

    vf = ",".join(filters)

    cmd = [
        ffmpeg, "-y",
        "-i", video_path,
        "-vf", vf,
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg burn subtitles failed: {result.stderr[-500:]}")

    return output_path


# --- Mixed Khmer + Latin text ---
# The Khmer fonts used for captions and overlays (Noto Sans Khmer UI, Battambang) have no Latin
# letters at all, so "ចំណងជើង Pop" drew as just the Khmer and every English word, name or
# number beside Khmer vanished. Mixed lines are drawn run by run instead: Khmer runs in the
# Khmer font, everything else in the Latin one, on a shared baseline.
_KHMER_RUN = re.compile(r"[\u1780-\u17FF\u19E0-\u19FF\u200B-\u200D]+")


def _is_mixed_script(text: str) -> bool:
    """Khmer plus anything the Khmer font lacks (letters, digits, most punctuation)."""
    if not _KHMER_RUN.search(text or ""):
        return False
    rest = _KHMER_RUN.sub("", text)
    return any(not ch.isspace() for ch in rest)


def _script_runs(line: str) -> list[tuple[bool, str]]:
    """[(is_khmer, text)] in order."""
    runs, pos = [], 0
    for m in _KHMER_RUN.finditer(line):
        if m.start() > pos:
            runs.append((False, line[pos:m.start()]))
        runs.append((True, m.group()))
        pos = m.end()
    if pos < len(line):
        runs.append((False, line[pos:]))
    return runs


def _runs_width(draw, line: str, khmer_font, latin_font) -> float:
    return sum(draw.textlength(t, font=khmer_font if k else latin_font) for k, t in _script_runs(line))


def _runs_metrics(khmer_font, latin_font) -> tuple[int, int]:
    """(ascent, line height) that fits both fonts."""
    ka, kd = khmer_font.getmetrics()
    la, ld = latin_font.getmetrics()
    return max(ka, la), max(ka, la) + max(kd, ld)


def _draw_runs(draw, x: float, top: float, line: str, khmer_font, latin_font, **kwargs) -> None:
    """Draw one line from its top-left, each script in its own font, on one baseline."""
    ascent, _ = _runs_metrics(khmer_font, latin_font)
    for is_khmer, text in _script_runs(line):
        font = khmer_font if is_khmer else latin_font
        draw.text((x, top + ascent), text, font=font, anchor="ls", **kwargs)
        x += draw.textlength(text, font=font)

def render_text_overlays(overlays: list[dict], width: int, height: int, work_dir: str) -> list[dict]:
    """Draw each text overlay to a transparent PNG sized for the export frame.

    Khmer goes through Pillow with the raqm layout engine, exactly as the burned captions do:
    ffmpeg's drawtext renders Khmer consonant stacks in the wrong order.
    Returns [{path, start, end, x, y, fade}] with x/y already in pixels.
    """
    from PIL import Image, ImageDraw, ImageFont, features

    if not overlays:
        return []

    layout_engine = ImageFont.Layout.RAQM if features.check("raqm") else None
    khmer_paths = [
        os.path.expanduser("~/Library/Fonts/NotoSansKhmerUI-Regular.ttf"),
        os.path.expanduser("~/Library/Fonts/Battambang.ttf"),
        os.path.expanduser("~/Library/Fonts/Kh Battambang.ttf"),
        "/System/Library/Fonts/Supplemental/Khmer Sangam MN.ttf",
        "/System/Library/Fonts/Supplemental/Khmer MN.ttc",
    ]
    latin_paths = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    ]

    def _font(paths: list[str], size: int):
        for path in paths:
            if os.path.exists(path):
                try:
                    return ImageFont.truetype(path, size, layout_engine=layout_engine)
                except Exception:
                    continue
        return ImageFont.load_default()

    rendered = []
    for overlay in overlays:
        text = str(overlay.get("text") or "").strip()
        if not text:
            continue
        size = max(16, round(height * float(overlay.get("size_pct") or 6.0) / 100))
        khmer = bool(re.search(r"[ក-៿]", text))
        font = _font(khmer_paths if khmer else latin_paths, size)
        mixed = _is_mixed_script(text)
        latin_font = _font(latin_paths, size) if mixed else None

        lines = text.split("\n")
        pad = max(8, size // 3)
        probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
        if mixed:
            _, run_h = _runs_metrics(font, latin_font)
            line_sizes = [(0, 0, round(_runs_width(probe, line, font, latin_font)), run_h) for line in lines]
        else:
            line_sizes = [probe.textbbox((0, 0), line, font=font) for line in lines]
        text_w = max((b[2] - b[0]) for b in line_sizes) if line_sizes else 0
        line_h = max((b[3] - b[1]) for b in line_sizes) if line_sizes else size
        gap = round(line_h * 0.35)
        box_w = text_w + pad * 2
        box_h = line_h * len(lines) + gap * (len(lines) - 1) + pad * 2

        img = Image.new("RGBA", (max(1, box_w), max(1, box_h)), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)

        box_alpha = int(max(0.0, min(1.0, float(overlay.get("box_opacity") or 0.0))) * 255)
        if box_alpha:
            draw.rounded_rectangle(
                [0, 0, box_w - 1, box_h - 1], radius=max(4, pad // 2),
                fill=_hex_rgb(overlay.get("box_color"), (0, 0, 0)) + (box_alpha,),
            )

        text_rgb = _hex_rgb(overlay.get("color"), (255, 255, 255))
        outline_rgb = _hex_rgb(overlay.get("outline_color"), (0, 0, 0))
        text_alpha = int(max(0.05, min(1.0, float(overlay.get("opacity", 1.0)))) * 255)
        stroke = round(float(overlay.get("outline_width") or 0) * (height / 720.0))
        y = pad
        for line, bbox in zip(lines, line_sizes):
            line_w = bbox[2] - bbox[0]
            x = (box_w - line_w) // 2
            if mixed:
                _draw_runs(draw, x, y, line, font, latin_font, fill=text_rgb + (text_alpha,),
                           stroke_width=stroke, stroke_fill=outline_rgb + (text_alpha,))
            else:
                draw.text((x, y), line, font=font, fill=text_rgb + (text_alpha,),
                          stroke_width=stroke, stroke_fill=outline_rgb + (text_alpha,))
            y += line_h + gap

        path = os.path.join(work_dir, f"overlay_{uuid.uuid4().hex}.png")
        img.save(path)

        # percentage position → pixels, anchored so the text does not fall off the frame
        x_pct = max(0.0, min(100.0, float(overlay.get("x_pct", 50.0))))
        y_pct = max(0.0, min(100.0, float(overlay.get("y_pct", 12.0))))
        anchor = str(overlay.get("anchor") or "center")
        cx = width * x_pct / 100
        if anchor == "left":
            px = cx
        elif anchor == "right":
            px = cx - box_w
        else:
            px = cx - box_w / 2
        py = height * y_pct / 100 - box_h / 2
        rendered.append({
            "path": path,
            "start": round(float(overlay.get("start_time") or 0), 3),
            "end": round(float(overlay.get("end_time") or 0), 3),
            # resting top-left of the text box
            "x": int(max(0, min(width - box_w, px))),
            "y": int(max(0, min(height - box_h, py))),
            "box_w": box_w,
            "box_h": box_h,
            "fade": max(0.0, float(overlay.get("fade_seconds") or 0)),
            "animation": str(overlay.get("animation") or "fade"),
            "animation_seconds": max(0.0, float(overlay.get("animation_seconds") or 0)),
            "exit_animation": str(overlay.get("exit_animation") or "none"),
            "exit_seconds": max(0.0, float(overlay.get("exit_seconds") or 0)),
        })
    return rendered


def _overlay_scale_expr(item: dict) -> str | None:
    """Per-frame scale of an overlay (1 = full size), or None when it never changes size.
    Mirrors overlayScale() in frontend/src/utils/overlayMotion.ts."""
    start, end = float(item.get("start") or 0), float(item.get("end") or 0)
    motion = item.get("animation") or "fade"
    seconds = float(item.get("animation_seconds") or 0)
    exit_motion = item.get("exit_animation") or "none"
    exit_seconds = float(item.get("exit_seconds") or 0)
    factor = None
    if motion in ("zoom", "pop") and seconds > 0.01:
        p = f"clip((t-{start:.3f})/{seconds:.3f}\\,0\\,1)"
        if motion == "zoom":
            factor = f"(0.6+0.4*(1-pow(1-{p}\\,3)))"
        else:
            factor = f"(0.3+0.7*(1+2.70158*pow({p}-1\\,3)+1.70158*pow({p}-1\\,2)))"
    if exit_motion == "zoom" and exit_seconds > 0.01:
        k = f"clip((t-{end - exit_seconds:.3f})/{exit_seconds:.3f}\\,0\\,1)"
        shrink = f"(1-0.7*pow({k}\\,3))"
        factor = f"{factor}*{shrink}" if factor else shrink
    return factor


def _overlay_position_exprs(item: dict) -> tuple[str, str]:
    """ffmpeg overlay x/y for one text overlay, as functions of t.

    Mirrors overlayFrame() in frontend/src/utils/overlayMotion.ts, so the player preview shows
    what gets rendered. Entrances start off an edge and ease in over `animation_seconds`; the
    looping motions never settle; an exit accelerates away over the last `exit_seconds`.
    Commas inside an expression are escaped or ffmpeg reads them as the next filter.
    """
    X, Y = item["x"], item["y"]
    # the text box's own size — the image laid over the picture can be padded bigger
    w, h = str(item.get("box_w") or "overlay_w"), str(item.get("box_h") or "overlay_h")
    motion = item.get("animation") or "fade"
    seconds = float(item.get("animation_seconds") or 0)
    start, end = float(item["start"]), float(item["end"])
    e = f"(t-{start:.3f})"
    x, y = str(X), str(Y)

    if seconds > 0.01:
        travel = f"(1-(1-pow(1-clip({e}/{seconds:.3f}\\,0\\,1)\\,3)))"
        if motion in ("marquee_left", "marquee_right"):
            span = f"(main_w+{w})"
            travelled = f"mod({e}*{span}/{seconds:.3f}\\,{span})"
            x = f"main_w-{travelled}" if motion == "marquee_left" else f"0-{w}+{travelled}"
        elif motion == "drift":
            period = max(4.0, seconds * 8)
            x = f"{X}+main_w*0.02*sin(2*PI*{e}/{period:.3f})"
            y = f"{Y}+main_h*0.02*sin(2*PI*{e}/{period * 1.37:.3f})"
        elif motion == "bounce":
            px = max(1.0, seconds * 6)
            py = px * 1.31
            fx, fy = f"(main_w-{w})", f"(main_h-{h})"
            x = f"abs(mod({e}*{fx}/{px:.3f}\\,2*{fx})-{fx})"
            y = f"abs(mod({e}*{fy}/{py:.3f}\\,2*{fy})-{fy})"
        elif motion == "corners":
            hold = max(1.0, seconds * 4)
            step = f"mod(trunc({e}/{hold:.3f})\\,4)"
            pad_x, pad_y = "(main_w*0.06)", "(main_h*0.06)"
            right, bottom = f"(main_w-{w}-{pad_x})", f"(main_h-{h}-{pad_y})"
            # 0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left
            x = f"if(eq({step}\\,0)+eq({step}\\,3)\\,{pad_x}\\,{right})"
            y = f"if(lt({step}\\,2)\\,{pad_y}\\,{bottom})"
        elif motion == "slide_left":       # comes in from the right edge
            x = f"{X}+(main_w-{X})*{travel}"
        elif motion == "slide_right":      # from the left edge
            x = f"{X}-({X}+{w})*{travel}"
        elif motion == "slide_up":         # from the bottom
            y = f"{Y}+(main_h-{Y})*{travel}"
        elif motion == "slide_down":       # from the top
            y = f"{Y}-({Y}+{h})*{travel}"

    exit_motion = item.get("exit_animation") or "none"
    exit_seconds = float(item.get("exit_seconds") or 0)
    if exit_motion in ("slide_left", "slide_right", "slide_up", "slide_down") and exit_seconds > 0.01:
        kk = f"pow(clip((t-{end - exit_seconds:.3f})/{exit_seconds:.3f}\\,0\\,1)\\,3)"
        if exit_motion == "slide_left":
            x = f"({x})-(({x})+{w})*{kk}"
        elif exit_motion == "slide_right":
            x = f"({x})+(main_w-({x}))*{kk}"
        elif exit_motion == "slide_up":
            y = f"({y})-(({y})+{h})*{kk}"
        else:
            y = f"({y})+(main_h-({y}))*{kk}"

    # A scaled overlay is padded onto a larger canvas with the text centred on it, so the
    # canvas's top-left sits half the extra size up and left of the text box
    pad_w, pad_h = _overlay_canvas(item)
    ox, oy = (pad_w - int(item.get("box_w") or pad_w)) // 2, (pad_h - int(item.get("box_h") or pad_h)) // 2
    if ox:
        x = f"({x})-{ox}"
    if oy:
        y = f"({y})-{oy}"
    return x, y


def _overlay_canvas(item: dict) -> tuple[int, int]:
    """Size of the image overlaid for an item: the text box, or — when it scales — a canvas
    12% larger so a pop's overshoot never outgrows it. Even sizes, centred on the text."""
    bw, bh = int(item.get("box_w") or 0), int(item.get("box_h") or 0)
    if not _overlay_scale_expr(item) or not bw:
        return bw, bh
    grow = lambda n: n + ((round(n * 0.12) + 2) // 2) * 2 + (n % 2)
    return grow(bw), grow(bh)
