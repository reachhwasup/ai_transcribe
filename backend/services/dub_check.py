"""Listen to a dub before it is exported.

A line can have a voice file and still be wrong in the video: the file is silent, the voice was
squeezed so hard to fit that nobody can follow it, it is still talking when the next line
starts, or it is distorted. None of that shows in the caption list. Each voice file is measured
once — its length, its loudness, how much of it is at full scale — and the lines that would
spoil the video are named.
"""
from __future__ import annotations

import os
import statistics

SILENT_DB = -50.0            # quieter than this all the way through is no voice at all
SILENT_SECONDS = 0.15
RUNS_OVER_SECONDS = 0.5      # still speaking this long after the next line has started
RUSHED_FACTOR = 1.5          # this much faster than the rest of the episode is spoken
CUT_FACTOR = 3.0             # so much faster that part of the line is simply not there
RUSHED_WITHOUT_BASELINE = 2.0
MIN_LINES_FOR_BASELINE = 8
MIN_CHARS_TO_JUDGE_PACE = 6  # "Hey!" says nothing about pace
CLIPPED_SHARE = 0.005        # of the samples at full scale

_measured: dict[str, tuple[float, dict | None]] = {}


def measure(path: str) -> dict | None:
    """{"seconds", "db", "clipped"} for a voice file; None when it cannot be read. Remembered
    until the file changes, so a series is only measured once."""
    try:
        modified = os.path.getmtime(path)
    except OSError:
        return None
    known = _measured.get(path)
    if known and known[0] == modified:
        return known[1]
    try:
        import numpy as np
        import soundfile as sf

        samples, rate = sf.read(path, dtype="float32", always_2d=True)
        mono = samples.mean(axis=1)
        if not len(mono):
            result = {"seconds": 0.0, "db": -120.0, "clipped": 0.0}
        else:
            rms = float(np.sqrt(np.mean(np.square(mono))))
            result = {
                "seconds": len(mono) / float(rate),
                "db": 20.0 * float(np.log10(max(rms, 1e-6))),
                "clipped": float(np.mean(np.abs(mono) >= 0.999)),
            }
    except Exception:
        result = None
    _measured[path] = (modified, result)
    return result


def _pace(seg, seconds: float) -> float | None:
    """How fast the line is spoken, against how long its words would take: 1.0 is as written."""
    from backend.services.tts_service import _estimated_speech_seconds

    text = (seg.text or "").strip()
    if len(text) < MIN_CHARS_TO_JUDGE_PACE or seconds <= 0:
        return None
    return _estimated_speech_seconds(text) / seconds


def check_dub(segments: list, measure=measure) -> dict[str, list[tuple]]:
    """{kind: [(segment, what is wrong)]} for the dubbed lines of one project, in time order.

    silent — problem: nothing is heard. cut_short — problem: most of the line is missing.
    rushed, runs_over, distorted — worth a listen."""
    found: dict[str, list[tuple]] = {"silent": [], "cut_short": [], "rushed": [], "runs_over": [], "distorted": []}
    heard = []
    for index, seg in enumerate(segments):
        url = (seg.audio_url or "").strip()
        if not url or not (seg.text or "").strip():
            continue
        info = measure(url.lstrip("/"))
        if info is None:
            continue                    # a missing file is reported as missing, not as silent
        heard.append((index, seg, info))
    paces = [p for p in (_pace(seg, info["seconds"]) for _, seg, info in heard) if p is not None]
    usual = statistics.median(paces) if len(paces) >= MIN_LINES_FOR_BASELINE else None
    for index, seg, info in heard:
        if info["seconds"] < SILENT_SECONDS or info["db"] < SILENT_DB:
            found["silent"].append((seg, "Nothing is heard in the voice file"))
            continue
        pace = _pace(seg, info["seconds"])
        if pace is not None:
            against = pace / usual if usual else pace / (RUSHED_WITHOUT_BASELINE / RUSHED_FACTOR)
            if against >= CUT_FACTOR:
                found["cut_short"].append((seg, f"Only {info['seconds']:.1f} s of voice for this many words"))
            elif against >= RUSHED_FACTOR:
                found["rushed"].append((seg, f"Spoken {against:.1f}× faster than the rest"))
        nxt = next((s for s in segments[index + 1:] if (s.text or "").strip()), None)
        if nxt is not None:
            over = seg.start_time + info["seconds"] - nxt.start_time
            if over >= RUNS_OVER_SECONDS:
                found["runs_over"].append((seg, f"Still speaking {over:.1f} s into the next line"))
        if info["clipped"] >= CLIPPED_SHARE:
            found["distorted"].append((seg, "The voice is distorted (too loud)"))
    return found


KINDS = {
    # key: (severity, one line, many lines, what to do)
    "silent": ("problem", "voice is silent", "voices are silent", "Dub those lines again."),
    "cut_short": ("problem", "voice is cut short", "voices are cut short", "Dub those lines again, or shorten the words."),
    "rushed": ("check", "voice is rushed", "voices are rushed", "Shorten the words, or give the line more time."),
    "runs_over": ("check", "voice runs into the next line", "voices run into the next line", "Shorten the words, or move the next line later."),
    "distorted": ("check", "voice is distorted", "voices are distorted", "Dub those lines again."),
}
