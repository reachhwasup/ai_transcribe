"""Reading subtitle files: SRT, WebVTT, ASS/SSA and this app's own JSON export.

Imported subtitles are the starting point of most projects, so the reader is forgiving about
what real files look like: Windows encodings, missing cue numbers, short timecodes, styling
tags, and the several ways a file can say who is speaking.
"""
from __future__ import annotations

import json
import re

SUPPORTED = ("srt", "vtt", "ass", "ssa", "json")

_TIME = r"(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})"
_CUE = re.compile(rf"{_TIME}\s*-->\s*{_TIME}")
_TAGS = re.compile(r"<[^>]+>|\{\\[^}]*\}")           # <i>, <font …>, {\an8}, {\pos(…)}
_VOICE = re.compile(r"<v(?:\.[\w.-]+)?\s+([^>]+)>")   # WebVTT voice span: <v Roger>
# "Name: text", "Name：text", "[Name] text", "【Name】text", "(Name) text"
_PREFIXES = (
    re.compile(r"^\s*[\[【(（]\s*([^\]】)）\n]{1,24}?)\s*[\]】)）]\s*[:：]?\s*(.+)$", re.S),
    re.compile(r"^\s*([^\s:：\[\]【】()（）<>][^:：\n]{0,23}?)\s*[:：]\s*(\S.*)$", re.S),
)
MAX_CUE_SECONDS = 30.0       # a cue longer than this is almost always a broken end time


class SubtitleError(ValueError):
    """The file could not be read as subtitles; the message says why, for the user."""


def decode(raw: bytes) -> tuple[str, str]:
    """(text, encoding name). UTF-8 and UTF-16 by their marks; otherwise UTF-8 if it is valid,
    then the Chinese and Western Windows encodings subtitle files are still saved in. Decoding
    those as Latin-1 — the old fallback — turned every Chinese line into gibberish."""
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw[3:].decode("utf-8", "replace"), "UTF-8"
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16", "replace"), "UTF-16"
    try:
        return raw.decode("utf-8"), "UTF-8"
    except UnicodeDecodeError:
        pass
    for name, label in (("gb18030", "GB18030 (Chinese)"), ("big5", "Big5 (Chinese)")):
        try:
            text = raw.decode(name)
        except UnicodeDecodeError:
            continue
        # a Western file decodes as "Chinese" too, but into rare characters, not common ones
        cjk = len(re.findall(r"[一-鿿]", text))
        odd = len(re.findall(r"[㐀-䶿-\U00020000-\U0002ffff]", text))
        if cjk and odd <= cjk * 0.05:
            return text, label
    return raw.decode("cp1252", "replace"), "Windows-1252"


def _seconds(h: str | None, m: str, s: str, frac: str) -> float:
    return int(h or 0) * 3600 + int(m) * 60 + int(s) + int(frac.ljust(3, "0")[:3]) / 1000


def _clean(text: str) -> str:
    text = _TAGS.sub("", text).replace("\\N", "\n").replace("\\n", "\n").replace("\\h", " ")
    lines = [re.sub(r"\s+", " ", ln).strip(" ​") for ln in text.split("\n")]
    # a dash at the start of each line marks two people talking in one cue; keep it readable
    return " ".join(ln for ln in lines if ln).strip()


def _parse_timed_text(content: str) -> list[dict]:
    """SRT and WebVTT: any block with a `start --> end` line, with or without a cue number or
    identifier above it, and hours optional."""
    cues = []
    for block in re.split(r"\n\s*\n", content.replace("\r\n", "\n").replace("\r", "\n")):
        lines = block.strip("\n").split("\n")
        at = next((i for i, ln in enumerate(lines) if _CUE.search(ln)), None)
        if at is None:
            continue
        m = _CUE.search(lines[at])
        body = "\n".join(lines[at + 1:])
        voice = _VOICE.search(body)
        cues.append({
            "start": _seconds(*m.groups()[:4]),
            "end": _seconds(*m.groups()[4:]),
            "text": _clean(body),
            "speaker": voice.group(1).strip() if voice else "",
        })
    return cues


def _parse_ass(content: str) -> list[dict]:
    """ASS/SSA: `Dialogue:` lines, read by the column order the file's own `Format:` line gives.
    Comments, drawings and karaoke/positioning tags are dropped; the Name column is the speaker."""
    fields: list[str] = []
    cues = []
    in_events = False
    for line in content.replace("\r\n", "\n").split("\n"):
        stripped = line.strip()
        if stripped.startswith("["):
            in_events = stripped.lower() == "[events]"
            continue
        if not in_events:
            continue
        if stripped.lower().startswith("format:"):
            fields = [f.strip().lower() for f in stripped.split(":", 1)[1].split(",")]
            continue
        if not stripped.lower().startswith("dialogue:") or not fields:
            continue
        parts = stripped.split(":", 1)[1].split(",", len(fields) - 1)
        if len(parts) < len(fields):
            continue
        row = dict(zip(fields, (p.strip() for p in parts)))
        text = row.get("text", "")
        if re.search(r"\{[^}]*\\p[1-9]", text):       # a vector drawing, not words
            continue

        def clock(value: str) -> float | None:
            m = re.fullmatch(r"(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})", value)
            return None if not m else int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) + int(m[4].ljust(2, "0")[:2]) / 100

        start, end = clock(row.get("start", "")), clock(row.get("end", ""))
        if start is None or end is None:
            continue
        cues.append({"start": start, "end": end, "text": _clean(text), "speaker": row.get("name", "") or row.get("actor", "")})
    return cues


def _parse_json(content: str) -> list[dict]:
    try:
        data = json.loads(content)
    except ValueError as exc:
        raise SubtitleError("This JSON file could not be read.") from exc
    rows = data.get("segments") if isinstance(data, dict) else data
    if not isinstance(rows, list):
        raise SubtitleError("The JSON has no list of captions (expected `segments`, or a list).")
    cues = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            start = float(row.get("start_time", row.get("start")))
            end = float(row.get("end_time", row.get("end")))
        except (TypeError, ValueError):
            continue
        cues.append({
            "start": start, "end": end,
            "text": _clean(str(row.get("text") or "")),
            "original": _clean(str(row.get("original_text") or "")),
            "speaker": str(row.get("speaker") or "").strip(),
        })
    return cues


def _split_speaker_prefixes(cues: list[dict]) -> int:
    """Move a leading "Name:" into the speaker field — but only when the file does it as a
    habit. One line that happens to contain a colon ("Note: he left") is not a speaker label,
    so the pattern must turn up on several lines and with names that repeat."""
    candidates: list[tuple[dict, str, str]] = []
    for cue in cues:
        if cue.get("speaker"):
            continue
        for pattern in _PREFIXES:
            m = pattern.match(cue["text"])
            if m and not re.search(r"\d{1,2}$", m.group(1)) and not m.group(1).lower().startswith("http"):
                candidates.append((cue, m.group(1).strip(), m.group(2).strip()))
                break
    if len(candidates) < 3:
        return 0
    names: dict[str, int] = {}
    for _, name, _ in candidates:
        names[name] = names.get(name, 0) + 1
    repeated = sum(n for n in names.values() if n >= 2)
    if repeated < max(3, len(candidates) * 0.5):
        return 0
    for cue, name, rest in candidates:
        if names[name] >= 2:
            cue["speaker"], cue["text"] = name, rest
    return repeated


def parse_subtitles(filename: str, raw: bytes) -> dict:
    """Read a subtitle file. Returns {"cues": [{start, end, text, speaker, original?}], plus what
    was found and what was dropped}. Raises SubtitleError with a message for the user."""
    from backend.services.transcript_cleanup import _is_music_or_noise_segment, _strip_inline_music_tags

    if not raw.strip():
        raise SubtitleError("The file is empty.")
    text, encoding = decode(raw)
    text = text.lstrip("﻿")
    extension = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    head = text.lstrip()[:400].lower()

    # go by what the file contains; the extension is only a tie-breaker
    if "[script info]" in head or "[events]" in text.lower() or extension in ("ass", "ssa"):
        kind, cues = "ASS", _parse_ass(text)
    elif extension == "json" or head.startswith(("{", "[")) and "-->" not in text:
        kind, cues = "JSON", _parse_json(text)
    else:
        kind, cues = ("WebVTT" if head.startswith("webvtt") else "SRT"), _parse_timed_text(text)
    if not cues:
        if "-->" not in text and kind in ("SRT", "WebVTT"):
            raise SubtitleError("No timed captions found. Expected SRT, WebVTT, ASS or JSON — a plain text file has no timings.")
        raise SubtitleError("No captions could be read from this file.")

    found = len(cues)
    dropped = {"empty": 0, "music": 0, "bad_time": 0, "duplicate": 0}
    kept = []
    for cue in cues:
        music_only = bool(cue["text"]) and _is_music_or_noise_segment(cue["text"])
        cue["text"] = _strip_inline_music_tags(cue["text"]).strip()
        if music_only:
            dropped["music"] += 1
        elif not cue["text"]:
            dropped["empty"] += 1
        elif not (cue["end"] > cue["start"] >= 0):
            dropped["bad_time"] += 1
        else:
            kept.append(cue)
    kept.sort(key=lambda c: (c["start"], c["end"]))

    # the same words at the same moment twice: styled layers in ASS, or a file merged with itself
    unique = []
    for cue in kept:
        prev = unique[-1] if unique else None
        if prev and cue["text"] == prev["text"] and cue["start"] < prev["end"] - 0.05:
            prev["end"] = max(prev["end"], cue["end"])
            dropped["duplicate"] += 1
        else:
            unique.append(cue)

    long_cues = 0
    for cue in unique:
        if cue["end"] - cue["start"] > MAX_CUE_SECONDS:
            cue["end"] = cue["start"] + MAX_CUE_SECONDS
            long_cues += 1
        cue["start"], cue["end"] = round(cue["start"], 3), round(cue["end"], 3)

    _split_speaker_prefixes(unique)
    for cue in unique:
        cue["speaker"] = re.sub(r"\s+", " ", cue.get("speaker") or "").strip()[:60]
    if not unique:
        raise SubtitleError("The file has no spoken captions — only empty lines or music cues.")

    overlaps = sum(1 for a, b in zip(unique, unique[1:]) if a["end"] > b["start"] + 0.05)
    speakers = sorted({c["speaker"] for c in unique if c["speaker"]})
    return {
        "cues": unique,
        "format": kind,
        "encoding": encoding,
        "found": found,
        "dropped": dropped,
        "shortened": long_cues,
        "overlaps": overlaps,
        "speakers": speakers,
        "language": guess_language(" ".join(c["text"] for c in unique[:200])),
        "first": unique[0]["start"],
        "last": unique[-1]["end"],
    }


def guess_language(text: str) -> str:
    """The script most of the text is written in, as a language code; "" when unsure."""
    counts = {
        "km": len(re.findall(r"[ក-៿]", text)),
        "zh": len(re.findall(r"[一-鿿]", text)),
        "ja": len(re.findall(r"[぀-ヿ]", text)) * 3,   # kana settles it against Chinese
        "ko": len(re.findall(r"[가-힯]", text)),
        "th": len(re.findall(r"[฀-๿]", text)),
        "en": len(re.findall(r"[A-Za-z]", text)) // 2,           # Latin letters: could be many languages
    }
    best = max(counts, key=counts.get)
    return best if counts[best] >= 8 else ""
