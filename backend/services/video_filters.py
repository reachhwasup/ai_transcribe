"""Colour filters for the exported video, matching the editor's live preview.

The editor previews a filter with CSS (`filter: saturate(1.4) contrast(1.15) …`). Those CSS
functions are defined as exact colour arithmetic, so the same list of steps can be turned into
ffmpeg filters that give the same picture. Before this the filter existed only in the preview:
it was not saved, and the exported video came out unfiltered.

A filter is a list of steps, [[name, value], …], applied in order.
"""
from __future__ import annotations

import math

# name -> (lowest, highest, value that changes nothing)
STEPS = {
    "brightness": (0.0, 2.0, 1.0),
    "contrast": (0.0, 2.0, 1.0),
    "saturate": (0.0, 2.5, 1.0),
    "grayscale": (0.0, 1.0, 0.0),
    "sepia": (0.0, 1.0, 0.0),
    "hue-rotate": (-180.0, 180.0, 0.0),
}
MAX_STEPS = 12


def clean_steps(raw) -> list[tuple[str, float]]:
    """The usable steps from whatever was sent: known names, numbers in range, no-ops dropped."""
    steps = []
    for item in (raw or [])[:MAX_STEPS]:
        try:
            name, value = str(item[0]), float(item[1])
        except (TypeError, ValueError, IndexError, KeyError):
            continue
        if name not in STEPS or not math.isfinite(value):
            continue
        low, high, neutral = STEPS[name]
        value = max(low, min(high, value))
        if abs(value - neutral) > 1e-4:
            steps.append((name, value))
    return steps


def _matrix(name: str, v: float) -> list[list[float]] | None:
    """The 3×3 colour matrix the CSS Filter Effects spec gives for this step."""
    if name == "brightness":
        return [[v, 0, 0], [0, v, 0], [0, 0, v]]
    if name == "saturate":
        return [[0.213 + 0.787 * v, 0.715 - 0.715 * v, 0.072 - 0.072 * v],
                [0.213 - 0.213 * v, 0.715 + 0.285 * v, 0.072 - 0.072 * v],
                [0.213 - 0.213 * v, 0.715 - 0.715 * v, 0.072 + 0.928 * v]]
    if name == "grayscale":
        t = 1 - v
        return [[0.2126 + 0.7874 * t, 0.7152 - 0.7152 * t, 0.0722 - 0.0722 * t],
                [0.2126 - 0.2126 * t, 0.7152 + 0.2848 * t, 0.0722 - 0.0722 * t],
                [0.2126 - 0.2126 * t, 0.7152 - 0.7152 * t, 0.0722 + 0.9278 * t]]
    if name == "sepia":
        t = 1 - v
        return [[0.393 + 0.607 * t, 0.769 - 0.769 * t, 0.189 - 0.189 * t],
                [0.349 - 0.349 * t, 0.686 + 0.314 * t, 0.168 - 0.168 * t],
                [0.272 - 0.272 * t, 0.534 - 0.534 * t, 0.131 + 0.869 * t]]
    if name == "hue-rotate":
        c, s = math.cos(math.radians(v)), math.sin(math.radians(v))
        return [[0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
                [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
                [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]]
    return None


def filter_chain(raw) -> str:
    """The ffmpeg filters for these steps, or "" when they change nothing.

    One filter per step, as CSS applies them, so a colour pushed out of range by one step is
    clipped before the next exactly as the browser does it."""
    steps = clean_steps(raw)
    if not steps:
        return ""
    parts = ["format=rgb24"]
    for name, v in steps:
        if name == "contrast":
            expr = f"clip((val-127.5)*{v:.4f}+127.5,0,255)"
            parts.append(f"lutrgb=r='{expr}':g='{expr}':b='{expr}'")
            continue
        m = _matrix(name, v)
        coefficients = ":".join(
            f"{row}{col}={max(-2.0, min(2.0, m[i][j])):.5f}"
            for i, row in enumerate("rgb") for j, col in enumerate("rgb")
        )
        parts.append(f"colorchannelmixer={coefficients}")
    return ",".join(parts)


def css_result(raw, rgb: tuple[float, float, float]) -> tuple[int, int, int]:
    """What a browser shows for this pixel under these steps — the reference the ffmpeg chain
    is checked against."""
    r, g, b = (float(x) for x in rgb)
    for name, v in clean_steps(raw):
        if name == "contrast":
            r, g, b = ((x - 127.5) * v + 127.5 for x in (r, g, b))
        else:
            m = _matrix(name, v)
            r, g, b = (m[i][0] * r + m[i][1] * g + m[i][2] * b for i in range(3))
        r, g, b = (max(0.0, min(255.0, x)) for x in (r, g, b))
    return round(r), round(g), round(b)
