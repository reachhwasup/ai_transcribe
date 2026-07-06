from __future__ import annotations
import os
import uuid
import subprocess
import shutil
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
    "facebook": {
        "name": "Facebook",
        "width": 1280,
        "height": 720,
        "video_bitrate": "4M",
        "audio_bitrate": "128k",
        "fps": 30,
        "max_duration": None,
        "description": "16:9 landscape, 1280x720, optimized for Facebook",
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
    "custom": {
        "name": "Custom",
        "width": 1920,
        "height": 1080,
        "video_bitrate": "6M",
        "audio_bitrate": "128k",
        "fps": 30,
        "max_duration": None,
        "description": "Custom resolution and settings",
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


def _has_subtitles_filter(ffmpeg: str) -> bool:
    """Check if ffmpeg has the subtitles filter (requires libass)."""
    try:
        result = subprocess.run(
            [ffmpeg, "-filters"], capture_output=True, text=True, timeout=10
        )
        return "subtitles" in result.stdout
    except Exception:
        return False


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


def _generate_subtitle_images(srt_path: str, width: int, height: int):
    """
    Generate transparent PNG images for each subtitle using Pillow.
    Returns list of {path, start, end} dicts.
    """
    from PIL import Image, ImageDraw, ImageFont, features

    segments = _parse_srt(srt_path)
    if not segments:
        return []

    # Use raqm layout engine for complex scripts (Khmer, Thai, Arabic, etc.)
    layout_engine = None
    if features.check("raqm"):
        layout_engine = ImageFont.Layout.RAQM

    font_size = max(16, min(32, width // 40)) if width < height else max(20, min(40, width // 48))

    def _load_font(paths):
        for fp in paths:
            try:
                return ImageFont.truetype(fp, font_size, layout_engine=layout_engine)
            except Exception:
                continue
        return ImageFont.load_default()

    # Detect if text contains Khmer Unicode range (U+1780–U+17FF)
    def _has_khmer(text):
        return any("\u1780" <= ch <= "\u17FF" for ch in text)

    khmer_font = _load_font([
        os.path.expanduser("~/Library/Fonts/NotoSansKhmerUI-Regular.ttf"),
        os.path.expanduser("~/Library/Fonts/Battambang.ttf"),
        os.path.expanduser("~/Library/Fonts/Kh Battambang.ttf"),
        "/System/Library/Fonts/Supplemental/Khmer Sangam MN.ttf",
        "/System/Library/Fonts/Supplemental/Khmer MN.ttc",
    ])
    latin_font = _load_font([
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    ])

    export_dir = os.path.join(settings.upload_dir, "exports")
    os.makedirs(export_dir, exist_ok=True)

    max_text_width = int(width * 0.85)

    sub_images = []
    for i, seg in enumerate(segments):
        img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        text = seg["text"]

        # Pick font based on script in this segment's text
        font = khmer_font if _has_khmer(text) else latin_font

        # Word-wrap using pixel width measurement (works for all scripts)
        wrapped = []
        for line in text.split("\n"):
            bbox_line = draw.textbbox((0, 0), line, font=font)
            line_w = bbox_line[2] - bbox_line[0]
            if line_w <= max_text_width:
                wrapped.append(line)
            else:
                # Try splitting by spaces first; fall back to char-by-char
                words = line.split(" ")
                if len(words) > 1:
                    current = words[0]
                    for w in words[1:]:
                        test = current + " " + w
                        tw_test = draw.textbbox((0, 0), test, font=font)
                        if (tw_test[2] - tw_test[0]) <= max_text_width:
                            current = test
                        else:
                            wrapped.append(current)
                            current = w
                    wrapped.append(current)
                else:
                    # No spaces (e.g. Khmer/CJK) — split by character clusters
                    current = ""
                    for ch in line:
                        test = current + ch
                        tw_test = draw.textbbox((0, 0), test, font=font)
                        if (tw_test[2] - tw_test[0]) <= max_text_width:
                            current = test
                        else:
                            if current:
                                wrapped.append(current)
                            current = ch
                    if current:
                        wrapped.append(current)
        text = "\n".join(wrapped)

        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        x = (width - tw) // 2
        y = height - th - max(40, height // 15)
        pad = 8
        draw.rectangle(
            [x - pad, y - pad, x + tw + pad, y + th + pad],
            fill=(0, 0, 0, 180),
        )
        # Offset text position by bbox origin so text aligns with the background
        draw.text((x - bbox[0], y - bbox[1]), text, fill=(255, 255, 255, 255), font=font)
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

    # Determine subtitle strategy
    want_subs = include_subtitles and srt_path and os.path.exists(srt_path)
    has_libass = want_subs and _has_subtitles_filter(ffmpeg)
    sub_images = []  # PNG overlay fallback

    if want_subs and not has_libass:
        sub_images = _generate_subtitle_images(srt_path, w, h)

    has_tts = bool(tts_audio_path and os.path.exists(tts_audio_path))

    # Probe whether video has audio
    has_video_audio = False
    if has_tts or mute_original_audio:
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

    # Add subtitle PNG inputs (if using overlay fallback)
    sub_start_idx = next_idx
    for si in sub_images:
        cmd += ["-loop", "1", "-i", si["path"]]
        next_idx += 1

    # Add TTS audio input
    tts_idx = None
    if has_tts:
        tts_idx = next_idx
        cmd += ["-i", tts_audio_path]
        next_idx += 1

    # ---- Build video filter ----
    vf_base = f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black"

    if has_libass:
        escaped_srt = srt_path.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
        # ASS FontSize lives in the subtitles filter's default 384x288 script
        # space and scales with output height: 16 ≈ 5.5% of frame height,
        # which looks huge on 9:16 exports. Target ~4% vertical, ~4.7% horizontal.
        font_size = 11 if w < h else 13
        vf_base += f",subtitles='{escaped_srt}':force_style='FontSize={font_size},PrimaryColour=&HFFFFFF&,Outline=1'"

    # Decide if we need filter_complex or simple -vf
    need_filter_complex = bool(sub_images) or (has_tts and has_video_audio and not mute_original_audio)

    if need_filter_complex:
        fc_parts = []
        # Scale/pad the video first
        fc_parts.append(f"[0:v]{vf_base}[scaled]")
        prev_label = "scaled"

        # Chain subtitle PNG overlays
        for i, si in enumerate(sub_images):
            inp_idx = sub_start_idx + i
            out_label = f"sub{i}"
            fc_parts.append(
                f"[{prev_label}][{inp_idx}:v]overlay=0:0:"
                f"enable='between(t,{si['start']:.3f},{si['end']:.3f})':"
                f"shortest=1[{out_label}]"
            )
            prev_label = out_label

        # Audio mixing
        audio_map = None
        if has_tts and has_video_audio and not mute_original_audio:
            fc_parts.append(
                f"[0:a][{tts_idx}:a]amix=inputs=2:duration=first:dropout_transition=0[aout]"
            )
            audio_map = "[aout]"
        elif has_tts:
            audio_map = f"{tts_idx}:a"

        fc = ";".join(fc_parts)
        cmd += ["-filter_complex", fc, "-map", f"[{prev_label}]"]
        if audio_map:
            cmd += ["-map", audio_map]
        elif mute_original_audio:
            cmd += ["-an"]
        else:
            cmd += ["-map", "0:a?"]
    else:
        # Simple case: just -vf
        cmd += ["-vf", vf_base]
        if has_tts:
            cmd += ["-map", "0:v", "-map", f"{tts_idx}:a"]
        elif mute_original_audio:
            cmd += ["-an"]

    cmd += [
        "-c:v", "libx264",
        "-preset", "medium",
        "-b:v", preset["video_bitrate"],
        "-c:a", "aac",
        "-b:a", preset["audio_bitrate"],
        "-r", str(preset["fps"]),
        "-movflags", "+faststart",
        "-pix_fmt", "yuv420p",
        output_path,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {result.stderr[-500:]}")
    finally:
        # Clean up subtitle PNG images
        for si in sub_images:
            if os.path.exists(si["path"]):
                try:
                    os.remove(si["path"])
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
                os.remove(pf)


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

    # Extract full audio from video first
    full_path = os.path.join(project_dir, "full_audio.wav")
    cmd_full = [
        ffmpeg, "-y", "-i", video_path,
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


def _separate_with_demucs(
    audio_path: str, vocals_path: str, bgm_path: str, project_dir: str
) -> bool:
    """
    Use Meta's Demucs (htdemucs) for high-quality vocal/BGM separation.
    Returns True if successful, False if demucs is not available.
    """
    import sys
    python = sys.executable

    # Check demucs is importable
    check = subprocess.run(
        [python, "-c", "import demucs"],
        capture_output=True, text=True, timeout=10,
    )
    if check.returncode != 0:
        return False

    # Run demucs with two-stems mode (vocals vs no_vocals)
    demucs_out = os.path.join(project_dir, "_demucs_tmp")
    os.makedirs(demucs_out, exist_ok=True)

    cmd = [
        python, "-m", "demucs",
        "--two-stems", "vocals",
        # Fine-tuned model: ~4x slower than plain htdemucs but separates
        # vocals from music noticeably more cleanly.
        "-n", "htdemucs_ft",
        "--shifts", "0",
        "--overlap", "0.25",
        "--jobs", "2",
        "--out", demucs_out,
        audio_path,
    ]
    print(f"Running demucs: {' '.join(cmd)}")
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        # Cleanup and signal failure
        shutil.rmtree(demucs_out, ignore_errors=True)
        raise RuntimeError(f"Demucs failed: {r.stderr[-500:]}")

    # Demucs outputs to: <out>/<model>/<stem_name>/vocals.wav and no_vocals.wav
    stem_name = Path(audio_path).stem  # e.g. "full_audio"
    demucs_vocals = os.path.join(demucs_out, "htdemucs_ft", stem_name, "vocals.wav")
    demucs_bgm = os.path.join(demucs_out, "htdemucs_ft", stem_name, "no_vocals.wav")

    if not os.path.exists(demucs_vocals) or not os.path.exists(demucs_bgm):
        shutil.rmtree(demucs_out, ignore_errors=True)
        raise RuntimeError("Demucs output files not found")

    # Move results to project directory
    shutil.move(demucs_vocals, vocals_path)
    shutil.move(demucs_bgm, bgm_path)

    # Cleanup demucs temp directory
    shutil.rmtree(demucs_out, ignore_errors=True)

    print("Demucs separation completed successfully")
    return True


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
