"""What is worth a look before a project is exported.

A batch can caption, dub and export a folder of videos with nobody watching, and an export
takes minutes to render. The things that make a finished video wrong are cheap to detect
first: a line with no voice, a line that cannot be said in its time, text that was never
translated. This lists them, so a person — or the pipeline — can stop before rendering.
"""
from __future__ import annotations

import os
import re

_KHMER = re.compile(r"[ក-៿]")
_LETTER = re.compile(r"[^\W\d_]", re.UNICODE)
KEEP_GAP = 0.12
MAX_IDS = 60


READ_TOLERANCE = 0.75      # shown for less than this share of its reading time is a flash


def too_brief(spoken: list) -> list[tuple]:
    """[(segment, seconds it needs)] for captions that leave the screen before they can be read.
    The same reading time the timeline gives a caption when it tidies one."""
    from backend.api.routes.timeline_sync import MAX_CAPTION_SECONDS, MIN_CAPTION_SECONDS, TARGET_CHARS_PER_SECOND

    found = []
    for seg in spoken:
        shown = seg.end_time - seg.start_time
        needed = min(max(MIN_CAPTION_SECONDS, len(seg.text.strip()) / TARGET_CHARS_PER_SECOND), MAX_CAPTION_SECONDS)
        if shown < needed * READ_TOLERANCE:
            found.append((seg, needed))
    return found


def _issue(key: str, severity: str, lines: list, title: str, hint: str) -> dict:
    return {
        "key": key, "severity": severity, "count": len(lines), "title": title, "hint": hint,
        "segment_ids": [s.id for s in lines[:MAX_IDS]],
        "first_time": round(min(s.start_time for s in lines), 2),
    }


def review_project(segments: list, language: str = "km", video_seconds: float = 0.0,
                   file_exists=os.path.exists, measure=None) -> dict:
    """The issues in a project's captions and dub. `segments` in time order.

    "problem" issues make the exported video wrong; "check" issues are worth a look but may be
    intended. Returns {"issues": [...], "problems": n, "checks": n, "lines", "voiced"}.
    """
    from backend.api.routes.timeline_sync import _named_speaker, plan_shorten
    from backend.services.cast import family

    spoken = [s for s in segments if (s.text or "").strip()]
    voiced = [s for s in spoken if (s.audio_url or "").strip()]
    issues: list[dict] = []
    if not spoken:
        return {"issues": [{
            "key": "no_captions", "severity": "problem", "count": 0, "title": "There are no captions",
            "hint": "Generate or import captions first.", "segment_ids": [], "first_time": 0.0,
        }], "problems": 1, "checks": 0, "lines": 0, "voiced": 0}

    # a dub that covers some lines and not others plays in silence over the rest
    if voiced and len(voiced) < len(spoken):
        missing = [s for s in spoken if not (s.audio_url or "").strip()]
        issues.append(_issue("unvoiced", "problem", missing,
                             f"{len(missing)} line{'s have' if len(missing) != 1 else ' has'} no voice",
                             "They will play silent in a dubbed export. Use Continue dubbing."))
    lost = [s for s in voiced if not file_exists((s.audio_url or "").lstrip("/"))]
    if lost:
        issues.append(_issue("audio_missing", "problem", lost,
                             f"{len(lost)} voice file{'s are' if len(lost) != 1 else ' is'} missing from disk",
                             "Dub those lines again."))

    if language == "km":
        foreign = [s for s in spoken if _LETTER.search(s.text) and not _KHMER.search(s.text)]
        if foreign:
            issues.append(_issue("untranslated", "problem", foreign,
                                 f"{len(foreign)} line{'s are' if len(foreign) != 1 else ' is'} not in Khmer",
                                 "Run Translate in the Captions panel."))

    too_long = []
    for i, seg in enumerate(spoken):
        box = max(0.3, seg.end_time - seg.start_time)
        room = (spoken[i + 1].start_time - KEEP_GAP - seg.start_time) if i + 1 < len(spoken) else (
            (video_seconds - seg.start_time) if video_seconds > seg.start_time else box)
        if plan_shorten(len(seg.text.strip()), max(room, box)) is not None:
            too_long.append(seg)
    if too_long:
        issues.append(_issue("too_long", "check", too_long,
                             f"{len(too_long)} line{'s have' if len(too_long) != 1 else ' has'} more words than time",
                             "The voice will be rushed or run into the next line. Use Shorten on the timeline."))

    overlapping = [a for a, b in zip(spoken, spoken[1:]) if a.end_time > b.start_time + 0.05]
    if overlapping:
        issues.append(_issue("overlap", "check", overlapping,
                             f"{len(overlapping)} caption{'s overlap' if len(overlapping) != 1 else ' overlaps'} the next one",
                             "Two captions show at once. Use Tidy on the timeline."))

    brief = [seg for seg, _ in too_brief(spoken)]
    if brief:
        issues.append(_issue("too_brief", "check", brief,
                             f"{len(brief)} caption{'s are' if len(brief) != 1 else ' is'} on screen too briefly to read",
                             "Use Tidy on the timeline, which holds each caption for its reading time."))

    by_character: dict[str, set] = {}
    for seg in spoken:
        name = _named_speaker(seg.speaker)
        if name:
            by_character.setdefault(name, set()).add(family(seg.voice_profile))
    mixed = [s for s in spoken if len(by_character.get(_named_speaker(s.speaker) or "", ())) > 1]
    if mixed:
        people = sum(1 for genders in by_character.values() if len(genders) > 1)
        issues.append(_issue("mixed_voice", "check", mixed,
                             f"{people} character{'s are' if people != 1 else ' is'} dubbed as both a man and a woman",
                             "Open Cast in Dubbing and give each one voice."))

    unnamed = [s for s in spoken if not _named_speaker(s.speaker)]
    if voiced and len(unnamed) > len(spoken) * 0.5:
        issues.append(_issue("unnamed", "check", unnamed,
                             f"{len(unnamed)} lines name no speaker",
                             "They are all dubbed in a default voice. Use Identify speakers in Dubbing."))

    # the dub itself, listened to: silent, cut short, rushed, running over, distorted
    from backend.services import dub_check

    for key, lines in dub_check.check_dub(spoken, **({"measure": measure} if measure else {})).items():
        if lines:
            severity, one, many, hint = dub_check.KINDS[key]
            issues.append(_issue(key, severity, [seg for seg, _ in lines], f"{len(lines)} {one if len(lines) == 1 else many}", hint))

    return {
        "issues": issues,
        "problems": sum(1 for i in issues if i["severity"] == "problem"),
        "checks": sum(1 for i in issues if i["severity"] == "check"),
        "lines": len(spoken),
        "voiced": len(voiced),
    }


# what each line-level issue is called in a list of lines, and whether dubbing again fixes it
LINE_KINDS = {
    "unvoiced": ("problem", "No voice", True),
    "audio_missing": ("problem", "Voice file missing", True),
    "silent": ("problem", "Voice is silent", True),
    "cut_short": ("problem", "Voice cut short", True),
    "untranslated": ("problem", "Not translated", False),
    "spelling": ("check", "Locked spelling missed", False),
    "rushed": ("check", "Voice rushed", False),
    "runs_over": ("check", "Runs into next line", False),
    "distorted": ("check", "Voice distorted", True),
    "too_long": ("check", "More words than time", False),
    "overlap": ("check", "Overlaps next caption", False),
    "too_brief": ("check", "Too brief to read", False),
}


def flagged_lines(segments: list, language: str = "km", video_seconds: float = 0.0,
                  file_exists=os.path.exists, measure=None, memory=None) -> list[dict]:
    """Every line of a project that needs a look, one entry per line and reason, in time order:
    [{"segment", "kind", "severity", "label", "detail", "redub"}]. The same checks as
    `review_project`, plus the series' locked spellings when its memory is given."""
    from backend.api.routes.timeline_sync import plan_shorten
    from backend.services import dub_check

    spoken = [s for s in segments if (s.text or "").strip()]
    voiced = [s for s in spoken if (s.audio_url or "").strip()]
    found: list[tuple] = []
    if voiced:
        found += [(s, "unvoiced", "It will play silent in a dubbed export") for s in spoken if not (s.audio_url or "").strip()]
    found += [(s, "audio_missing", "Its voice file is no longer on disk") for s in voiced
              if not file_exists((s.audio_url or "").lstrip("/"))]
    if language == "km":
        found += [(s, "untranslated", "No Khmer in this line") for s in spoken
                  if _LETTER.search(s.text) and not _KHMER.search(s.text)]
    if memory is not None:
        from backend.services.series_memory import locked_misses

        found += [(seg, "spelling", "Expected " + ", ".join(f"{t.source} → {t.target}" for t in missing))
                  for seg, missing in locked_misses(spoken, memory, language)]
    for i, seg in enumerate(spoken):
        box = max(0.3, seg.end_time - seg.start_time)
        room = (spoken[i + 1].start_time - KEEP_GAP - seg.start_time) if i + 1 < len(spoken) else (
            (video_seconds - seg.start_time) if video_seconds > seg.start_time else box)
        if plan_shorten(len(seg.text.strip()), max(room, box)) is not None:
            found.append((seg, "too_long", "The voice will be rushed or run into the next line"))
    found += [(a, "overlap", "Two captions show at once") for a, b in zip(spoken, spoken[1:]) if a.end_time > b.start_time + 0.05]
    found += [(seg, "too_brief", f"On screen {seg.end_time - seg.start_time:.1f} s; it takes about {needed:.1f} s to read")
              for seg, needed in too_brief(spoken)]
    for key, lines in dub_check.check_dub(spoken, **({"measure": measure} if measure else {})).items():
        found += [(seg, key, detail) for seg, detail in lines]
    order = list(LINE_KINDS)
    found.sort(key=lambda item: (item[0].start_time, order.index(item[1])))
    return [{"segment": seg, "kind": kind, "severity": LINE_KINDS[kind][0], "label": LINE_KINDS[kind][1],
             "detail": detail, "redub": LINE_KINDS[kind][2]} for seg, kind, detail in found]
