"""Burned-in caption images, drawn to match the editor's live preview.

Every style setting the Style tab offers is honoured here: font family and weight (from the
fonts bundled in backend/fonts, the same Google Fonts the preview loads), colours, outline,
box with rounded corners and border, letter spacing, line height, upper/lower case and the
soft / hard / glow shadows. Pixel values in a style are "design pixels" on a 720-high frame,
which is what the preview scales by too — so a 2px outline is the same weight at any size.

Khmer and Latin in one line are drawn run by run, each in a font that has its glyphs, so an
English name inside a Khmer caption is never dropped.
"""
from __future__ import annotations

import os
import re
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFilter, ImageFont, features

FONT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "fonts")
_LAYOUT = ImageFont.Layout.RAQM if features.check("raqm") else ImageFont.Layout.BASIC

# family name (as the Style tab writes it) → (regular file, bold file or None for a variable font)
_FAMILIES = {
    "kantumruy pro": ("KantumruyPro[wght].ttf", None),
    "battambang": ("Battambang-Regular.ttf", "Battambang-Bold.ttf"),
    "moul": ("Moul-Regular.ttf", "Moul-Regular.ttf"),
    "koulen": ("Koulen-Regular.ttf", "Koulen-Regular.ttf"),
    "siemreap": ("Siemreap.ttf", "Siemreap.ttf"),
    "hanuman": ("Hanuman[wght].ttf", None),
    "noto sans khmer": ("NotoSansKhmer[wdth,wght].ttf", None),
    "inter": ("Inter[opsz,wght].ttf", None),
    "outfit": ("Outfit[wght].ttf", None),
    "montserrat": ("Montserrat[wght].ttf", None),
    "bebas neue": ("BebasNeue-Regular.ttf", "BebasNeue-Regular.ttf"),
    "poppins": ("Poppins-Regular.ttf", "Poppins-Bold.ttf"),
    "impact": ("/System/Library/Fonts/Supplemental/Impact.ttf", "/System/Library/Fonts/Supplemental/Impact.ttf"),
}
_KHMER_FALLBACK = "kantumruy pro"
_LATIN_FALLBACK = "inter"

_KHMER = re.compile(r"[ក-៿᧠-᧿​-‍]+")


def _family_key(css_family: str | None) -> str:
    """First family in a CSS stack: "'Kantumruy Pro', sans-serif" → "kantumruy pro"."""
    first = (css_family or "").split(",")[0].strip().strip("'\"").lower()
    return first if first in _FAMILIES else _KHMER_FALLBACK


def _weight(style: dict) -> int:
    w = str(style.get("fontWeight") or "bold")
    return 900 if w == "900" else 700 if w == "bold" else 400


def _path(name: str) -> str:
    return name if os.path.isabs(name) else os.path.join(FONT_DIR, name)


@lru_cache(maxsize=256)
def _font(family: str, weight: int, size: int) -> ImageFont.FreeTypeFont:
    regular, bold = _FAMILIES[family]
    name = (bold if weight >= 600 and bold else regular)
    path = _path(name)
    if not os.path.exists(path):
        family = _LATIN_FALLBACK if family in ("impact",) else _KHMER_FALLBACK
        return _font(family, weight, size)
    font = ImageFont.truetype(path, size, layout_engine=_LAYOUT)
    if bold is None:
        # variable font: pick the weight on its axis, clamped to what it supports
        try:
            axes = font.get_variation_axes()
            values = []
            for ax in axes:
                tag = ax.get("name", b"")
                tag = tag.decode() if isinstance(tag, bytes) else str(tag)
                if tag.lower() == "weight":
                    values.append(max(ax["minimum"], min(ax["maximum"], weight)))
                else:
                    values.append(ax.get("default", ax["minimum"]))
            font.set_variation_by_axes(values)
        except Exception:
            pass
    return font


@lru_cache(maxsize=64)
def _coverage(family: str) -> tuple[bool, bool]:
    """(has Khmer, has Latin) for a family's regular file."""
    try:
        from fontTools.ttLib import TTFont

        cmap = TTFont(_path(_FAMILIES[family][0]), fontNumber=0, lazy=True).getBestCmap()
        return 0x1780 in cmap, ord("A") in cmap
    except Exception:
        return family not in ("inter", "outfit", "montserrat", "bebas neue", "poppins", "impact"), True


def _transform(text: str, how: str | None) -> str:
    if how == "uppercase":
        return text.upper()
    if how == "lowercase":
        return text.lower()
    if how == "capitalize":
        return re.sub(r"\b([a-z])", lambda m: m.group(1).upper(), text)
    return text


class _Fonts:
    """The two fonts a caption is drawn with, and how each run of text maps to one."""

    def __init__(self, style: dict, size: int):
        fam = _family_key(style.get("fontFamily"))
        weight = _weight(style)
        has_khmer, has_latin = _coverage(fam)
        self.khmer = _font(fam if has_khmer else _KHMER_FALLBACK, weight, size)
        self.latin = _font(fam if has_latin else _KHMER_FALLBACK, weight, size)
        a1, d1 = self.khmer.getmetrics()
        a2, d2 = self.latin.getmetrics()
        self.ascent = max(a1, a2)
        self.descent = max(d1, d2)

    def runs(self, line: str):
        pos = 0
        for m in _KHMER.finditer(line):
            if m.start() > pos:
                yield False, line[pos:m.start()]
            yield True, m.group()
            pos = m.end()
        if pos < len(line):
            yield False, line[pos:]


def _run_width(draw, text: str, font, spacing: float, is_khmer: bool) -> float:
    if spacing and not is_khmer:
        # tracking is applied to Latin; spreading Khmer apart would break its clusters
        return sum(draw.textlength(ch, font=font) + spacing for ch in text)
    return draw.textlength(text, font=font)


def _line_width(draw, fonts: _Fonts, line: str, spacing: float) -> float:
    return sum(_run_width(draw, t, fonts.khmer if k else fonts.latin, spacing, k) for k, t in fonts.runs(line))


def _draw_line(draw, fonts: _Fonts, x: float, baseline: float, line: str, spacing: float, **kw) -> None:
    for is_khmer, text in fonts.runs(line):
        font = fonts.khmer if is_khmer else fonts.latin
        if spacing and not is_khmer:
            for ch in text:
                draw.text((x, baseline), ch, font=font, anchor="ls", **kw)
                x += draw.textlength(ch, font=font) + spacing
        else:
            draw.text((x, baseline), text, font=font, anchor="ls", **kw)
            x += draw.textlength(text, font=font)


def _wrap(draw, fonts: _Fonts, text: str, max_w: float, spacing: float) -> list[str]:
    """Lines that fit max_w: split at spaces, and inside long Khmer words at cluster edges."""
    out = []
    for para in text.split("\n"):
        para = para.strip()
        if not para:
            continue
        if _line_width(draw, fonts, para, spacing) <= max_w:
            out.append(para)
            continue
        # tokens: words with their trailing space, and Khmer broken into clusters
        tokens = re.findall(r"[ក-ឳ](?:្[ក-ឳ]|[឴-៑៓-៝])*|\S+\s*|\s+", para)
        current = ""
        for tok in tokens:
            trial = current + tok
            if current and _line_width(draw, fonts, trial.rstrip(), spacing) > max_w:
                out.append(current.rstrip())
                current = tok.lstrip()
            else:
                current = trial
        if current.strip():
            out.append(current.rstrip())
    return out or [text]


def _hex(color, default):
    c = str(color or "").lstrip("#")
    if re.fullmatch(r"[0-9a-fA-F]{6}", c):
        return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
    return default


def word_count(text: str) -> int:
    """Words as the preview's karaoke splits them: runs between spaces."""
    return len(text.split()) or 1


def render_caption(text: str, style: dict, width: int, height: int, active_word: int | None = None) -> Image.Image:
    """One caption as a full-frame transparent image. With `active_word`, words are drawn as
    the preview's karaoke / word-badge highlight shows them at that moment."""
    k = height / 720.0                                     # design px → this frame's px
    size_pct = float(style.get("sizePct") or 4.5)
    size = max(10, round(height * size_pct / 100 * 0.75))
    spacing = float(style.get("letterSpacing") or 0) * k
    line_ratio = float(style.get("lineHeight") or 1.3)
    text = _transform(text, style.get("textTransform"))

    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    max_w = width * 0.82

    # shrink until it fits: at most a quarter of the frame tall
    while True:
        fonts = _Fonts(style, size)
        lines = _wrap(draw, fonts, text, max_w, spacing)
        pitch = max(fonts.ascent + fonts.descent, round(size * line_ratio))
        widths = [_line_width(draw, fonts, ln, spacing) for ln in lines]
        tw = max(widths) if widths else 0
        th = pitch * (len(lines) - 1) + fonts.ascent + fonts.descent
        if (tw <= max_w and th <= height * 0.25) or size <= 12:
            break
        size = max(12, int(size * 0.9))

    align = str(style.get("textAlign") or "center").lower()
    if align == "left":
        x0 = width * 0.09
    elif align == "right":
        x0 = width * 0.91 - tw
    else:
        x0 = (width - tw) / 2
    position = str(style.get("position") or "bottom")
    if position == "top":
        y0 = max(24, height / 16)
    elif position == "middle":
        y0 = (height - th) / 2
    else:
        y0 = height - th - max(40, height / 12)

    # box: the preview pads 0.15em top/bottom and 0.35em left/right
    box_alpha = int(max(0.0, min(1.0, float(style.get("boxOpacity", 0.55)))) * 255)
    border_w = round(float(style.get("boxOutlineWidth") or 0) * k)
    if box_alpha > 0 or border_w > 0:
        px, py = size * 0.35, size * 0.15
        radius = round(float(style.get("borderRadius", 6) or 0) * k)
        draw.rounded_rectangle(
            [x0 - px, y0 - py, x0 + tw + px, y0 + th + py],
            radius=max(0, radius),
            fill=_hex(style.get("boxColor"), (0, 0, 0)) + (box_alpha,) if box_alpha > 0 else None,
            outline=_hex(style.get("boxOutlineColor"), (0, 0, 0)) + (255,) if border_w > 0 else None,
            width=max(1, border_w),
        )

    text_rgb = _hex(style.get("textColor"), (255, 255, 255))
    outline_rgb = _hex(style.get("outlineColor"), (0, 0, 0))
    outline_w = max(0, round(float(style.get("outlineWidth", 2) or 0) * k))

    def line_x(i: int) -> float:
        lw = widths[i]
        return x0 if align == "left" else x0 + tw - lw if align == "right" else x0 + (tw - lw) / 2

    # shadows sit under the text, as CSS text-shadow does
    shadow = style.get("textShadow") or "none"
    if shadow in ("soft", "hard", "glow"):
        layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        if shadow == "soft":
            colour, dx, dy, blur = (0, 0, 0, 204), 0, 2 * k, 4 * k       # 0 2px 8px rgba(0,0,0,.8)
        elif shadow == "hard":
            colour, dx, dy, blur = (0, 0, 0, 242), 3 * k, 3 * k, 0       # 3px 3px 0
        else:
            colour, dx, dy, blur = text_rgb + (255,), 0, 0, 6 * k        # 0 0 12px textColor
        for i, ln in enumerate(lines):
            _draw_line(ld, fonts, line_x(i) + dx, y0 + fonts.ascent + i * pitch + dy, ln, spacing,
                       fill=colour, stroke_width=outline_w, stroke_fill=colour)
        if blur > 0.3:
            layer = layer.filter(ImageFilter.GaussianBlur(blur))
        img = Image.alpha_composite(img, layer)
        draw = ImageDraw.Draw(img)

    if active_word is None:
        for i, ln in enumerate(lines):
            _draw_line(draw, fonts, line_x(i), y0 + fonts.ascent + i * pitch, ln, spacing,
                       fill=text_rgb + (255,), stroke_width=outline_w,
                       stroke_fill=outline_rgb + (255,) if outline_w else None)
        return img

    # Word highlight, as SubtitleOverlay draws it: the active word in the highlight colour (or on
    # a badge), words already said nearly full, words still to come dimmed.
    badge = style.get("animation") == "badge" or style.get("highlightStyle") == "badge"
    hi_rgb = _hex(style.get("activeWordColor"), (250, 204, 21))
    word = 0
    for i, ln in enumerate(lines):
        x = line_x(i)
        base = y0 + fonts.ascent + i * pitch
        for tok in re.findall(r"\S+|\s+", ln):
            w = _line_width(draw, fonts, tok, spacing)
            if tok.isspace():
                x += w
                continue
            if word == active_word:
                if badge:
                    pad = size * 0.12
                    draw.rounded_rectangle(
                        [x - pad, base - fonts.ascent - pad * 0.5, x + w + pad, base + fonts.descent + pad * 0.5],
                        radius=round(6 * k), fill=hi_rgb + (255,),
                    )
                    fill, alpha = (0, 0, 0), 255
                else:
                    fill, alpha = hi_rgb, 255
            else:
                fill, alpha = text_rgb, (242 if word < active_word else 166)
            _draw_line(draw, fonts, x, base, tok, spacing, fill=fill + (alpha,),
                       stroke_width=0 if (badge and word == active_word) else outline_w,
                       stroke_fill=outline_rgb + (alpha,) if outline_w else None)
            x += w
            word += 1
    return img
