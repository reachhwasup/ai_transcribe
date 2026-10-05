"""Lines that overlap in time, moved apart so their voices take turns.

Subtitle files for dramas often show two lines at once — a question and its answer on screen
together — so the second line starts before the first has finished. Read on screen that is
fine; dubbed, the two voices talk over each other for half a second or more, which sounds like
a line being cut off, or said twice. Here the later line waits for the earlier one to finish.
"""
GAP = 0.05          # between one voice ending and the next starting
MIN_LINE = 0.5      # no line is squeezed shorter than this to make room


def _spoken(seg) -> bool:
    return bool((seg.text or "").strip()) and getattr(seg, "speaker", "") != "Freeze" \
        and getattr(seg, "voice_profile", "") != "freeze" \
        and "intro hook" not in (getattr(seg, "speaker", "") or "").lower()


def overlapping(segments: list) -> int:
    """How many spoken lines start before the one before them has ended."""
    lines = sorted((s for s in segments if _spoken(s)), key=lambda s: s.start_time)
    return sum(1 for a, b in zip(lines, lines[1:]) if b.start_time < a.end_time - 0.01)


def space_overlaps(segments: list) -> list:
    """Move each line that starts inside the line before it to just after that one ends.

    The moved line keeps its length when there is room before the line after it, and gives up
    what it must otherwise. When the moved line would be left too short, the earlier line ends
    early instead. Returns the lines whose timing changed — their voices no longer fit."""
    lines = sorted((s for s in segments if _spoken(s)), key=lambda s: s.start_time)
    changed = []
    for i in range(len(lines) - 1):
        cur, nxt = lines[i], lines[i + 1]
        if nxt.start_time >= cur.end_time - 0.01:
            continue
        following = lines[i + 2].start_time if i + 2 < len(lines) else float("inf")
        start = round(cur.end_time + GAP, 2)
        length = nxt.end_time - nxt.start_time
        end = round(max(nxt.end_time, min(start + length, following - GAP)), 2)
        if end - start >= MIN_LINE:
            nxt.start_time, nxt.end_time = start, end
            if nxt not in changed:
                changed.append(nxt)
        elif nxt.start_time - GAP - cur.start_time >= MIN_LINE:
            cur.end_time = round(nxt.start_time - GAP, 2)
            if cur not in changed:
                changed.append(cur)
    return changed
