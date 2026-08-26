from __future__ import annotations
import os
import json
import uuid
import subprocess
import shutil
import threading
from pathlib import Path
from backend.config import settings


# Platform presets: (width, height, video_bitrate, audio_bitrate, fps, codec_extra)
PLATFORM_PRESETS = {
    "tiktok": {
        "name": "TikTok",
        "width": 1080,
        "height": 1920,
        "video_bitrate": "6M",
        "audio_bitrate": "128k",
        "fps": 30,
        "max_duration": 600,  # 10 min
        "description": "9:16 vertical, 1080x1920, optimized for TikTok",
    },
    "youtube": {
        "name": "YouTube",
        "width": 1920,
        "height": 1080,
        "video_bitrate": "8M",
        "audio_bitrate": "192k",
        "fps": 30,
        "max_duration": None,
        "description": "16:9 landscape, 1920x1080, optimized for YouTube",
    },
    "youtube_shorts": {
        "name": "YouTube Shorts",
        "width": 1080,
        "height": 1920,
        "video_bitrate": "6M",
        "audio_bitrate": "128k",
        "fps": 30,
        "max_duration": 60,
        "description": "9:16 vertical, 1080x1920, max 60s for Shorts",
    },
    "instagram": {
        "name": "Instagram Square",
        "width": 1080,
        "height": 1080,
        "video_bitrate": "6M",
        "audio_bitrate": "128k",
        "fps": 30,
        "max_duration": 600,
        "description": "1:1 square, 1080x1080, for Instagram Feed",
    },
    "instagram_reels": {
        "name": "Instagram Reels",
        "width": 1080,
        "height": 1920,
        "video_bitrate": "6M",
        "audio_bitrate": "128k",
        "fps": 30,
        "max_duration": 90,
        "description": "9:16 vertical, 1080x1920, for Instagram Reels",
    },
    "facebook": {
        "name": "Facebook Portrait",
        "width": 1080,
        "height": 1350,
        "video_bitrate": "6M",
        "audio_bitrate": "128k",
        "fps": 30,
        "max_duration": None,
        "description": "4:5 portrait, 1080x1350, optimized for Facebook",
    },
    "facebook_reels": {
        "name": "Facebook Reels",
        "width": 1080,
        "height": 1920,
        "video_bitrate": "6M",
        "audio_bitrate": "128k",
        "fps": 30,
        "max_duration": 90,
        "description": "9:16 vertical, 1080x1920, max 90s for Reels",
    },
    "custom": {
        "name": "Original Source",
        "width": 1920,
        "height": 1080,
        "video_bitrate": "8M",
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


def _has_subtitles_filter(ffmpeg: str) -> bool:
    """Check if ffmpeg has the subtitles filter (requires libass)."""
    try:
        result = subprocess.run(
            [ffmpeg, "-filters"], capture_output=True, text=True, timeout=10
        )
        return "subtitles" in result.stdout
    except Exception:
        return False


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

    sorted_subs = sorted(sub_images, key=lambda s: s["start"])
    lines = ["ffconcat version 1.0"]

    current_time = 0.0
    for si in sorted_subs:
        start = max(0.0, float(si["start"]))
        end = max(start, float(si["end"]))
        img_path = os.path.abspath(si["path"])

        # Transparent gap before subtitle
        if start > current_time + 0.005:
            gap = start - current_time
            lines.append(f"file '{trans_path}'")
            lines.append(f"duration {gap:.4f}")
            current_time = start

        dur = max(0.05, end - start)
        lines.append(f"file '{img_path}'")
        lines.append(f"duration {dur:.4f}")
        current_time = end

    # Trailing transparent padding
    lines.append(f"file '{trans_path}'")
    lines.append("duration 3600.0")
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
    Generate transparent PNG images for each subtitle using Pillow.
    size_pct: subtitle size as % of frame height; position: bottom | middle | top.
    style: caption style dict (textColor, outlineColor, outlineWidth, boxColor,
           boxOpacity, boxOutlineColor, boxOutlineWidth). None = white-on-black default.
    Returns list of {path, start, end} dicts.
    """
    from PIL import Image, ImageDraw, ImageFont, features

    segments = _parse_srt(srt_path)
    if not segments:
        return []

    # Resolve caption style, scaling outline widths to the export resolution so
    # they look the same as in the (smaller) preview.
    style = style or {}
    scale = height / 720.0  # preview reference height
    text_rgb = _hex_rgb(style.get("textColor"), (255, 255, 255))
    outline_rgb = _hex_rgb(style.get("outlineColor"), (0, 0, 0))
    outline_w = round(float(style.get("outlineWidth", 2)) * scale)
    box_rgb = _hex_rgb(style.get("boxColor"), (0, 0, 0))
    box_alpha = int(max(0.0, min(1.0, float(style.get("boxOpacity", 0.55)))) * 255)
    box_border_rgb = _hex_rgb(style.get("boxOutlineColor"), (0, 0, 0))
    box_border_w = round(float(style.get("boxOutlineWidth", 0)) * scale)

    # Use raqm layout engine for complex scripts (Khmer, Thai, Arabic, etc.)
    layout_engine = None
    if features.check("raqm"):
        layout_engine = ImageFont.Layout.RAQM

    font_size = max(14, round(height * size_pct / 100 * 0.75))

    khmer_paths = [
        os.path.expanduser("~/Library/Fonts/NotoSansKhmerUI-Regular.ttf"),
        os.path.expanduser("~/Library/Fonts/Battambang.ttf"),
        os.path.expanduser("~/Library/Fonts/Kh Battambang.ttf"),
        "/System/Library/Fonts/Supplemental/Khmer Sangam MN.ttf",
        "/System/Library/Fonts/Supplemental/Khmer MN.ttc",
    ]
    latin_paths = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    ]

    def _load_font(paths, size=None):
        f_size = size or font_size
        for fp in paths:
            try:
                return ImageFont.truetype(fp, f_size, layout_engine=layout_engine)
            except Exception:
                continue
        return ImageFont.load_default()

    # Detect if text contains Khmer Unicode range (U+1780–U+17FF)
    def _has_khmer(text):
        return any("\u1780" <= ch <= "\u17FF" for ch in text)

    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    # Max width with safe 9% padding on both sides
    max_text_width = int(width * 0.82)

    import re

    def _wrap_text(raw_text: str, active_font, max_w: int, draw_obj) -> str:
        wrapped_lines = []
        for line in raw_text.split("\n"):
            line = line.strip()
            if not line:
                continue
            bbox_line = draw_obj.textbbox((0, 0), line, font=active_font)
            line_w = bbox_line[2] - bbox_line[0]
            if line_w <= max_w:
                wrapped_lines.append(line)
            else:
                # First try splitting by spaces
                words = line.split(" ")
                if len(words) > 1:
                    current = words[0]
                    for w in words[1:]:
                        test = current + " " + w
                        tw_test = draw_obj.textbbox((0, 0), test, font=active_font)
                        if (tw_test[2] - tw_test[0]) <= max_w:
                            current = test
                        else:
                            wrapped_lines.append(current)
                            current = w
                    if current:
                        wrapped_lines.append(current)
                else:
                    # Single long word / Khmer text without spaces
                    # Split by Unicode grapheme clusters
                    clusters = re.findall(r"[\u1780-\u17B3][\u17B4-\u17DD]*|.", line)
                    current = ""
                    for cl in clusters:
                        test = current + cl
                        tw_test = draw_obj.textbbox((0, 0), test, font=active_font)
                        if (tw_test[2] - tw_test[0]) <= max_w:
                            current = test
                        else:
                            if current:
                                wrapped_lines.append(current)
                            current = cl
                    if current:
                        wrapped_lines.append(current)
        return "\n".join(wrapped_lines) if wrapped_lines else raw_text

    sub_images = []
    for i, seg in enumerate(segments):
        img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        raw_text = seg["text"]

        # Pick font based on script in this segment's text
        font_paths = khmer_paths if _has_khmer(raw_text) else latin_paths
        cur_font_size = font_size
        active_font = _load_font(font_paths, cur_font_size)

        # Wrap text for target width
        text = _wrap_text(raw_text, active_font, max_text_width, draw)

        # Determine text alignment
        align = str(style.get("textAlign") or "center").lower()
        if align not in ("left", "center", "right"):
            align = "center"

        bbox = draw.textbbox((0, 0), text, font=active_font, align=align)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]

        # Auto-reduce font size if too tall (> 25% of screen height) or too wide
        while (tw > max_text_width or th > int(height * 0.25)) and cur_font_size > 14:
            cur_font_size = max(14, int(cur_font_size * 0.90))
            active_font = _load_font(font_paths, cur_font_size)
            text = _wrap_text(raw_text, active_font, max_text_width, draw)
            bbox = draw.textbbox((0, 0), text, font=active_font, align=align)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]

        if align == "left":
            x = int(width * 0.09)
        elif align == "right":
            x = int(width * 0.91) - tw
        else:  # center
            x = (width - tw) // 2

        if position == "top":
            y = max(24, height // 16)
        elif position == "middle":
            y = (height - th) // 2
        else:
            y = height - th - max(40, height // 12)
        pad = max(8, round(cur_font_size * 0.25))

        # Background box (fill + optional border), only if visible
        if box_alpha > 0 or box_border_w > 0:
            box = [x - pad, y - pad, x + tw + pad, y + th + pad]
            draw.rectangle(
                box,
                fill=(box_rgb[0], box_rgb[1], box_rgb[2], box_alpha) if box_alpha > 0 else None,
                outline=(box_border_rgb[0], box_border_rgb[1], box_border_rgb[2], 255) if box_border_w > 0 else None,
                width=max(1, box_border_w),
            )

        # Text: draw the outline (stroke) then the fill on top
        tx, ty = x - bbox[0], y - bbox[1]
        draw.text(
            (tx, ty), text, font=active_font,
            align=align,
            fill=(text_rgb[0], text_rgb[1], text_rgb[2], 255),
            stroke_width=outline_w if outline_w > 0 else 0,
            stroke_fill=(outline_rgb[0], outline_rgb[1], outline_rgb[2], 255) if outline_w > 0 else None,
        )
        img_path = os.path.join(export_dir, f"_sub_{uuid.uuid4()}_{i}.png")
        img.save(img_path)
        sub_images.append({"path": img_path, "start": seg["start"], "end": seg["end"]})

    return sub_images


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
) -> str:
    """
    Export video formatted for a specific platform.
    Optionally burns subtitles and mixes TTS audio overlay.
    Returns path to the exported file.
    """
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

    # Determine subtitle strategy
    want_subs = include_subtitles and srt_path and os.path.exists(srt_path)
    has_libass = want_subs and _has_subtitles_filter(ffmpeg)
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

    # Input 0: video
    if start_time is not None:
        cmd += ["-ss", str(start_time)]
    cmd += ["-i", video_path]
    if end_time is not None:
        duration = end_time - (start_time or 0)
        cmd += ["-t", str(duration)]

    # Track next input index
    next_idx = 1

    # Add subtitle concat stream (single input for all subtitles!)
    sub_input_idx = None
    if sub_concat_path:
        sub_input_idx = next_idx
        cmd += ["-f", "concat", "-safe", "0", "-i", sub_concat_path]
        next_idx += 1

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
        cmd += ["-i", music_audio_path]
        if end_time is not None:
            cmd += ["-t", str(end_time - (start_time or 0))]
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
    # True when: no subtitle burn, scale mode is default/native, only audio mix
    audio_only_change = (
        not sub_concat_path
        and not has_libass
        and not want_subs
        and scale_mode == "fit"
    )

    # Decide if we need filter_complex (subtitles overlay, or mixing two audios)
    need_filter_complex = bool(sub_concat_path) or (has_tts and bg_audio is not None)

    if need_filter_complex:
        fc_parts = []
        if not audio_only_change:
            fc_parts.append(f"[0:v]{vf_base}[scaled]")
            prev_label = "scaled"
        else:
            prev_label = "0:v"

        # Apply single subtitle overlay if using concat demuxer
        if sub_concat_path and sub_input_idx is not None:
            fc_parts.append(f"[{prev_label}][{sub_input_idx}:v]overlay=0:0:shortest=1[subout]")
            prev_label = "subout"

        # Audio mixing
        audio_map = None
        if has_tts and bg_audio is not None:
            fc_parts.append(
                f"[{bg_audio}][{tts_idx}:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]"
            )
            audio_map = "[aout]"
        elif has_tts:
            audio_map = f"{tts_idx}:a"
        elif bg_audio is not None:
            audio_map = bg_audio

        fc = ";".join(fc_parts)
        if fc_parts and not audio_only_change:
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
    if audio_only_change:
        cmd += [
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", preset["audio_bitrate"],
            "-movflags", "+faststart",
            output_path,
        ]
    else:
        # Video re-encoding: use Apple Silicon Hardware GPU Encoder if available
        if _has_videotoolbox(ffmpeg):
            cmd += [
                "-c:v", "h264_videotoolbox",
                "-b:v", preset["video_bitrate"],
                "-c:a", "aac",
                "-b:a", preset["audio_bitrate"],
                "-r", str(preset["fps"]),
                "-movflags", "+faststart",
                "-pix_fmt", "yuv420p",
                output_path,
            ]
        else:
            cmd += [
                "-c:v", "libx264",
                "-preset", "fast",
                "-threads", "0",
                "-b:v", preset["video_bitrate"],
                "-c:a", "aac",
                "-b:a", preset["audio_bitrate"],
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
                stderr=subprocess.PIPE,
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

            proc.wait(timeout=600)
            if proc.returncode != 0:
                err_msg = proc.stderr.read() if proc.stderr else ""
                raise RuntimeError(f"ffmpeg failed: {err_msg[-500:]}")
            if progress_callback:
                progress_callback(100, "Rendering complete!")
        else:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
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


def cut_video(
    video_path: str,
    start_time: float,
    end_time: float,
) -> str:
    """
    Cut a portion of the video without re-encoding (fast copy).
    Returns path to the cut file.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    if end_time <= start_time:
        raise ValueError("end_time must be greater than start_time")

    ffmpeg = _get_ffmpeg()

    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    ext = Path(video_path).suffix or ".mp4"
    output_filename = f"{uuid.uuid4()}_cut{ext}"
    output_path = os.path.join(export_dir, output_filename)

    duration = end_time - start_time

    cmd = [
        ffmpeg, "-y",
        "-ss", str(start_time),
        "-i", video_path,
        "-t", str(duration),
        "-c", "copy",
        "-movflags", "+faststart",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg cut failed: {result.stderr[-500:]}")

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
    import tempfile
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


def separate_audio(
    video_path: str,
    project_dir: str,
) -> dict:
    """
    Separate audio from video into vocals and background music tracks.
    Uses Meta's Demucs neural network for high-quality separation if available,
    with ffmpeg frequency filtering as fallback.
    Saves vocals.wav and bgm.wav into the project directory for in-app playback.
    Returns dict with paths to: vocals, bgm files.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    ffmpeg = _get_ffmpeg()
    os.makedirs(project_dir, exist_ok=True)

    # Check if video has an audio stream
    probe_cmd = [ffmpeg, "-i", video_path, "-hide_banner"]
    probe = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=30)
    probe_output = probe.stdout + probe.stderr
    if "Audio:" not in probe_output:
        raise RuntimeError("This video file does not contain an audio track. Cannot isolate vocals.")

    vocals_path = os.path.join(project_dir, "vocals.wav")
    bgm_path = os.path.join(project_dir, "bgm.wav")

    # Extract full audio from video first (throttled to 2 threads so UI stays smooth)
    full_path = os.path.join(project_dir, "full_audio.wav")
    cmd_full = [
        ffmpeg, "-y",
        "-threads", "2",
        "-i", video_path,
        "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2",
        full_path,
    ]
    r = subprocess.run(cmd_full, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"Audio extraction failed: {r.stderr[-500:]}")

    # Try Demucs first (high-quality neural network separation)
    demucs_success = False
    try:
        demucs_success = _separate_with_demucs(full_path, vocals_path, bgm_path, project_dir)
    except Exception as e:
        print(f"Demucs separation failed, falling back to ffmpeg: {e}")

    if not demucs_success:
        _separate_with_ffmpeg(full_path, vocals_path, bgm_path, ffmpeg)

    # Clean up full audio (not needed for playback)
    if os.path.exists(full_path):
        os.remove(full_path)

    return {"vocals": vocals_path, "bgm": bgm_path}


# Lazy-loaded in-process Demucs model cache with GPU / Apple Silicon MPS acceleration
_demucs_model_cache = None
_demucs_model_lock = threading.Lock()


def _get_demucs_model():
    """Lazy load and cache the Demucs model on GPU/MPS/CPU with thread limits."""
    global _demucs_model_cache
    if _demucs_model_cache is None:
        with _demucs_model_lock:
            if _demucs_model_cache is None:
                import torch
                from demucs.pretrained import get_model
                # Cap PyTorch threads so macOS UI, window server, and browser stay 100% responsive
                torch.set_num_threads(2)
                if hasattr(torch, "set_num_interop_threads"):
                    try:
                        torch.set_num_interop_threads(2)
                    except RuntimeError:
                        pass
                if torch.cuda.is_available():
                    device = "cuda"
                elif torch.backends.mps.is_available():
                    device = "mps"
                else:
                    device = "cpu"
                print(f"[Demucs] Loading htdemucs neural model on {device} (2-thread limited)...")
                model = get_model("htdemucs")
                model.to(device)
                model.eval()
                _demucs_model_cache = (model, device)
                print(f"[Demucs] Model loaded and ready on {device}.")
    return _demucs_model_cache


def _separate_with_demucs(
    audio_path: str, vocals_path: str, bgm_path: str, project_dir: str
) -> bool:
    """
    Use Meta's Demucs (htdemucs) with hardware acceleration (Apple Silicon MPS / CUDA).
    Runs in-process to avoid Python startup overhead and uses GPU tensor operations with CPU/RAM caps.
    """
    # 1. Fast in-process GPU / MPS neural separation with memory safeguards
    try:
        import torch
        import gc
        from demucs.apply import apply_model
        from demucs.audio import save_audio, AudioFile

        # Ensure CPU thread throttling
        torch.set_num_threads(2)

        model, device = _get_demucs_model()
        print(f"[Demucs] Starting smooth background separation on {device}: {audio_path}")

        audio_file = AudioFile(audio_path)
        wav = audio_file.read(streams=0, samplerate=model.samplerate, channels=model.audio_channels)

        with torch.inference_mode():
            ref = wav.mean(0)
            wav_norm = (wav - ref.mean()) / max(ref.std().item(), 1e-4)
            sources = apply_model(
                model,
                wav_norm[None].to(device),
                device=device,
                shifts=0,
                split=True,
                overlap=0.10,
                progress=False,
            )[0]
            sources = sources * ref.std() + ref.mean()

            vocal_idx = model.sources.index("vocals")
            vocals = sources[vocal_idx]

            # BGM is the sum of drums + bass + other (clean instrumental background)
            bgm = sum(sources[i] for i in range(len(model.sources)) if i != vocal_idx)

            # Save to disk directly
            save_audio(vocals.cpu(), vocals_path, samplerate=model.samplerate)
            save_audio(bgm.cpu(), bgm_path, samplerate=model.samplerate)

        # Release GPU Unified Memory and tensor buffers immediately
        del wav, wav_norm, sources, vocals, bgm
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        elif torch.cuda.is_available():
            torch.cuda.empty_cache()
        gc.collect()

        if os.path.exists(vocals_path) and os.path.exists(bgm_path):
            print(f"[Demucs] In-process neural separation completed smoothly on {device}!")
            return True
    except Exception as e:
        print(f"[Demucs] In-process separation failed: {e}. Trying CLI fallback...")

    # 2. CLI fallback with explicit device flag (-d mps / -d cuda)
    try:
        import sys
        import glob
        python = sys.executable

        import torch
        device_flag = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")

        demucs_out = os.path.join(project_dir, "_demucs_tmp")
        os.makedirs(demucs_out, exist_ok=True)

        cmd = [
            python, "-m", "demucs",
            "--two-stems", "vocals",
            "-n", "htdemucs",
            "-d", device_flag,
            "--shifts", "0",
            "--overlap", "0.10",
            "--out", demucs_out,
            audio_path,
        ]
        print(f"Running fallback demucs CLI: {' '.join(cmd)}")
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=1200)
        if r.returncode != 0:
            shutil.rmtree(demucs_out, ignore_errors=True)
            return False

        v_matches = glob.glob(os.path.join(demucs_out, "**", "vocals.wav"), recursive=True)
        b_matches = glob.glob(os.path.join(demucs_out, "**", "no_vocals.wav"), recursive=True)

        if v_matches and b_matches:
            shutil.move(v_matches[0], vocals_path)
            shutil.move(b_matches[0], bgm_path)
            shutil.rmtree(demucs_out, ignore_errors=True)
            print("Demucs CLI fallback completed successfully")
            return True
    except Exception as e:
        print(f"Demucs CLI failed: {e}")

    return False


def _separate_with_ffmpeg(
    audio_path: str, vocals_path: str, bgm_path: str, ffmpeg: str
) -> None:
    """Fallback: ffmpeg frequency-based vocal/BGM separation."""
    # Vocals: center-channel (mid) extraction + voice bandpass
    cmd_vocals = [
        ffmpeg, "-y", "-i", audio_path,
        "-af", (
            "pan=mono|c0=0.5*c0+0.5*c1,"
            "highpass=f=85:p=2,"
            "lowpass=f=8000:p=2,"
            "equalizer=f=250:t=h:w=200:g=3,"
            "equalizer=f=2500:t=h:w=2000:g=4,"
            "equalizer=f=5000:t=h:w=3000:g=-3,"
            "dynaudnorm=p=0.9:m=100"
        ),
        "-ac", "2", vocals_path,
    ]
    r = subprocess.run(cmd_vocals, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"Vocal extraction failed: {r.stderr[-500:]}")

    # BGM: side-channel + frequency rejection
    cmd_bgm = [
        ffmpeg, "-y", "-i", audio_path,
        "-af", (
            "pan=stereo|c0=c0-c1|c1=c1-c0,"
            "bandreject=f=800:t=h:w=2000,"
            "bandreject=f=2500:t=h:w=1500,"
            "highpass=f=30:p=2,"
            "lowpass=f=16000:p=2,"
            "equalizer=f=80:t=h:w=100:g=4,"
            "equalizer=f=10000:t=h:w=5000:g=3,"
            "dynaudnorm=p=0.85:m=100"
        ),
        bgm_path,
    ]
    r = subprocess.run(cmd_bgm, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"BGM extraction failed: {r.stderr[-500:]}")


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
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
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
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
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
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg crop failed: {result.stderr[-500:]}")

    return output_path


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

    valid_regions = []
    for r in regions:
        if "x_pct" in r and "width_pct" in r:
            rx = int(round((float(r["x_pct"]) / 100.0) * vid_w))
            ry = int(round((float(r.get("y_pct", 0)) / 100.0) * vid_h))
            rw = int(round((float(r["width_pct"]) / 100.0) * vid_w))
            rh = int(round((float(r.get("height_pct", 10)) / 100.0) * vid_h))
        else:
            rx = int(r.get("x", 0))
            ry = int(r.get("y", 0))
            rw = int(r.get("width", 100))
            rh = int(r.get("height", 50))

        rx = max(0, min(rx, vid_w - 4))
        ry = max(0, min(ry, vid_h - 4))
        rw = max(4, min(rw, vid_w - rx))
        rh = max(4, min(rh, vid_h - ry))

        if rx % 2 != 0: rx -= 1
        if ry % 2 != 0: ry -= 1
        if rw % 2 != 0: rw += 1
        if rh % 2 != 0: rh += 1

        rx = max(0, min(rx, vid_w - 4))
        ry = max(0, min(ry, vid_h - 4))
        rw = max(4, min(rw, vid_w - rx))
        rh = max(4, min(rh, vid_h - ry))

        blur_size_x = max(6, min(32, rw // 2))
        blur_size_y = max(6, min(32, rh // 2))

        valid_regions.append({
            "x": rx, "y": ry, "width": rw, "height": rh,
            "blur_x": blur_size_x, "blur_y": blur_size_y
        })

    if not valid_regions:
        return video_path

    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    ext = Path(video_path).suffix or ".mp4"
    output_filename = f"{uuid.uuid4()}_blur{ext}"
    output_path = os.path.join(export_dir, output_filename)

    n = len(valid_regions)
    split_tags = "".join(f"[c{i}]" for i in range(n))
    filters = [f"[0:v]split={n+1}[base]{split_tags}"]
    for i, r in enumerate(valid_regions):
        filters.append(f"[c{i}]crop={r['width']}:{r['height']}:{r['x']}:{r['y']},avgblur=sizeX={r['blur_x']}:sizeY={r['blur_y']}[b{i}]")

    current_input = "[base]"
    for i, r in enumerate(valid_regions):
        is_last = (i == n - 1)
        next_tag = "[outv]" if is_last else f"[tmp{i}]"
        fmt = ",format=yuv420p" if is_last else ""
        filters.append(f"{current_input}[b{i}]overlay={r['x']}:{r['y']}{fmt}{next_tag}")
        current_input = next_tag

    filter_complex = ";".join(filters)

    cmd = [
        ffmpeg, "-y",
        "-i", video_path,
        "-filter_complex", filter_complex,
        "-map", "[outv]", "-map", "0:a?",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-crf", "18",
        "-c:a", "copy",
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
            "-movflags", "+faststart",
            output_path,
        ]
        result_fb = subprocess.run(cmd_fb, capture_output=True, text=True, timeout=600)
        if result_fb.returncode != 0:
            raise RuntimeError(f"FFmpeg multi-blur failed: {result_fb.stderr[-300:]}")

    return output_path


def blur_region(
    video_path: str,
    x: int,
    y: int,
    width: int,
    height: int,
) -> str:
    """Blur a single rectangular region of the video."""
    return blur_regions(video_path, [{"x": x, "y": y, "width": width, "height": height}])


def resize_video(
    video_path: str,
    width: int,
    height: int,
) -> str:
    """
    Resize video to exact dimensions with padding to maintain aspect ratio.
    Returns path to resized video.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    if width < 100 or height < 100 or width > 7680 or height > 4320:
        raise ValueError("Dimensions must be between 100 and 7680")

    # Force even dimensions for h264
    width = width if width % 2 == 0 else width + 1
    height = height if height % 2 == 0 else height + 1

    ffmpeg = _get_ffmpeg()
    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    output_filename = f"{uuid.uuid4()}_resize_{width}x{height}.mp4"
    output_path = os.path.join(export_dir, output_filename)

    vf = f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black"

    cmd = [
        ffmpeg, "-y",
        "-i", video_path,
        "-vf", vf,
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg resize failed: {result.stderr[-500:]}")

    return output_path


def change_speed(
    video_path: str,
    speed: float,
) -> str:
    """
    Change video playback speed.
    speed: 0.5 = half speed, 1.5 = 1.5x speed, 2.0 = double speed, etc.
    Returns path to the speed-adjusted video.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    if speed < 0.25 or speed > 4.0:
        raise ValueError("Speed must be between 0.25 and 4.0")

    ffmpeg = _get_ffmpeg()
    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    ext = Path(video_path).suffix or ".mp4"
    output_filename = f"{uuid.uuid4()}_speed_{speed}x{ext}"
    output_path = os.path.join(export_dir, output_filename)

    # Video: setpts adjusts presentation timestamps (1/speed)
    # Audio: atempo adjusts audio speed (must be between 0.5 and 2.0, chain if needed)
    video_filter = f"setpts={1/speed}*PTS"

    audio_filters = []
    remaining = speed
    while remaining > 2.0:
        audio_filters.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        audio_filters.append("atempo=0.5")
        remaining /= 0.5
    audio_filters.append(f"atempo={remaining:.4f}")
    audio_filter = ",".join(audio_filters)

    cmd = [
        ffmpeg, "-y",
        "-i", video_path,
        "-vf", video_filter,
        "-af", audio_filter,
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-movflags", "+faststart",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg speed change failed: {result.stderr[-500:]}")

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


def mute_audio(video_path: str) -> str:
    """Remove audio from video (mute). Returns path to muted video."""
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    ffmpeg = _get_ffmpeg()
    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    ext = Path(video_path).suffix or ".mp4"
    output_path = os.path.join(export_dir, f"{uuid.uuid4()}_muted{ext}")

    cmd = [
        ffmpeg, "-y",
        "-i", video_path,
        "-c:v", "copy",
        "-an",
        "-movflags", "+faststart",
        output_path,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg mute failed: {r.stderr[-500:]}")
    return output_path


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
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg burn subtitles failed: {result.stderr[-500:]}")

    return output_path


def generate_selected_video(
    video_path: str,
    start_time: float,
    end_time: float,
    text: str | None = None,
    font_size: int = 48,
    font_color: str = "white",
    position: str = "bottom",
    bg_opacity: float = 0.5,
) -> str:
    """
    Generate a selected portion of the video (trim) with optional text overlay.
    Returns path to the output video.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    if end_time <= start_time:
        raise ValueError("end_time must be greater than start_time")

    ffmpeg = _get_ffmpeg()
    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    ext = Path(video_path).suffix or ".mp4"
    output_filename = f"{uuid.uuid4()}_selected{ext}"
    output_path = os.path.join(export_dir, output_filename)

    duration = end_time - start_time

    if text and text.strip():
        # With text overlay — need re-encoding
        safe_text = text.replace("\\", "\\\\\\\\").replace("'", "'\\\\\\''").replace(":", "\\:").replace("%", "%%")
        pos_map = {
            "top": "x=(w-text_w)/2:y=50",
            "center": "x=(w-text_w)/2:y=(h-text_h)/2",
            "bottom": "x=(w-text_w)/2:y=h-text_h-50",
        }
        xy = pos_map.get(position, pos_map["bottom"])
        bg_color = f"black@{bg_opacity}"
        drawtext = (
            f"drawtext=text='{safe_text}':"
            f"fontsize={font_size}:"
            f"fontcolor={font_color}:"
            f"{xy}:"
            f"box=1:boxcolor={bg_color}:boxborderw=10"
        )
        cmd = [
            ffmpeg, "-y",
            "-ss", str(start_time),
            "-i", video_path,
            "-t", str(duration),
            "-vf", drawtext,
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            output_path,
        ]
    else:
        # Without text — fast copy
        cmd = [
            ffmpeg, "-y",
            "-ss", str(start_time),
            "-i", video_path,
            "-t", str(duration),
            "-c", "copy",
            "-movflags", "+faststart",
            output_path,
        ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg generate selected failed: {result.stderr[-500:]}")

    return output_path


def generate_selected_audio(
    video_path: str,
    start_time: float,
    end_time: float,
    audio_format: str = "mp3",
) -> str:
    """
    Extract audio from a selected portion of the video.
    Returns path to the output audio file.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    if end_time <= start_time:
        raise ValueError("end_time must be greater than start_time")

    allowed_formats = {"mp3", "wav", "aac", "flac"}
    if audio_format not in allowed_formats:
        raise ValueError(f"Unsupported format: {audio_format}. Use: {', '.join(allowed_formats)}")

    ffmpeg = _get_ffmpeg()
    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    output_filename = f"{uuid.uuid4()}_selected.{audio_format}"
    output_path = os.path.join(export_dir, output_filename)

    duration = end_time - start_time

    codec_map = {
        "mp3": ["-c:a", "libmp3lame", "-b:a", "192k"],
        "wav": ["-c:a", "pcm_s16le"],
        "aac": ["-c:a", "aac", "-b:a", "192k"],
        "flac": ["-c:a", "flac"],
    }

    cmd = [
        ffmpeg, "-y",
        "-ss", str(start_time),
        "-i", video_path,
        "-t", str(duration),
        "-vn",  # no video
        *codec_map[audio_format],
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg generate selected audio failed: {result.stderr[-500:]}")

    return output_path
