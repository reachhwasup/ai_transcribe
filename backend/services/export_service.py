def format_srt_time(seconds: float) -> str:
    """Convert seconds to SRT time format: HH:MM:SS,mmm"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def format_vtt_time(seconds: float) -> str:
    """Convert seconds to VTT time format: HH:MM:SS.mmm"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"


def export_srt(segments: list[dict]) -> str:
    """Export segments as SRT format."""
    lines = []
    for i, seg in enumerate(segments, 1):
        start = format_srt_time(seg["start_time"])
        end = format_srt_time(seg["end_time"])
        lines.append(f"{i}")
        lines.append(f"{start} --> {end}")
        lines.append(seg["text"])
        lines.append("")
    return "\n".join(lines)


def export_vtt(segments: list[dict]) -> str:
    """Export segments as WebVTT format."""
    lines = ["WEBVTT", ""]
    for i, seg in enumerate(segments, 1):
        start = format_vtt_time(seg["start_time"])
        end = format_vtt_time(seg["end_time"])
        lines.append(f"{i}")
        lines.append(f"{start} --> {end}")
        lines.append(seg["text"])
        lines.append("")
    return "\n".join(lines)


def export_txt(segments: list[dict]) -> str:
    """Export segments as plain text."""
    lines = []
    for seg in segments:
        speaker = seg.get("speaker", "")
        prefix = f"[{speaker}] " if speaker else ""
        lines.append(f"{prefix}{seg['text']}")
    return "\n".join(lines)


def export_json(segments: list[dict]) -> list[dict]:
    """Export segments as JSON-serializable list."""
    return [
        {
            "index": seg.get("index", i),
            "start_time": seg["start_time"],
            "end_time": seg["end_time"],
            "text": seg["text"],
            "speaker": seg.get("speaker", ""),
        }
        for i, seg in enumerate(segments)
    ]
