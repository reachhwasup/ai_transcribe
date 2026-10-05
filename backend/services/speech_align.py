"""Align caption timings to the actual speech in a project's isolated vocal track.

Gemini's timestamps are estimates, so lines often start a few tenths of a second early or late.
The isolated vocals contain speech only (no music), which makes speech starts easy to find by
energy, and each caption can then be nudged to the nearest one.
"""
import numpy as np
import soundfile as sf

FRAME_SECONDS = 0.02
FLOOR_WINDOW_SECONDS = 2.0     # local noise floor window
ACTIVE_MARGIN_DB = 6.0         # speech is this far above the local floor
MIN_SILENCE_SECONDS = 0.20     # silence needed before a new onset counts
MIN_SPEECH_SECONDS = 0.10      # speech must hold this long to count
DEFAULT_MAX_SHIFT = 0.8        # never move a caption further than this
MERGE_GAP_SECONDS = 0.35       # pauses shorter than this stay inside one spoken burst
MIN_REGION_SECONDS = 0.35      # ignore blips shorter than this
# The activity test above is purely relative, so quiet residue left in the vocal stem — music
# bleed, room tone, a door closing — can clear a low local floor and look like a spoken line.
# Speech in a stem sits within roughly this much of the track's loud frames, so anything far
# below that is not someone talking.
QUIET_REGION_BELOW_PEAK_DB = 20.0
TAIL_PAD_SECONDS = 0.15        # keep a little air after the last word


def snap_starts(starts: list[float], onsets: list[float], max_shift: float = DEFAULT_MAX_SHIFT) -> list[float | None]:
    """For each caption start, the nearest speech onset within max_shift, else None.

    Two captions never snap to the same onset: the closer one wins, so overlapping
    lines keep their original order.
    """
    if not onsets:
        return [None] * len(starts)
    onset_arr = np.asarray(onsets)
    taken: dict[int, tuple[int, float]] = {}  # onset index -> (caption index, distance)
    result: list[float | None] = [None] * len(starts)
    for i, start in enumerate(starts):
        j = int(np.searchsorted(onset_arr, start))
        best, best_dist = None, max_shift
        for cand in (j - 1, j):
            if 0 <= cand < len(onset_arr):
                dist = abs(onset_arr[cand] - start)
                if dist <= best_dist:
                    best, best_dist = cand, dist
        if best is None:
            continue
        holder = taken.get(best)
        if holder and holder[1] <= best_dist:
            continue
        if holder:
            result[holder[0]] = None
        taken[best] = (i, best_dist)
        result[i] = float(onset_arr[best])
    return result


def _frame_energy_db(vocals_path: str):
    """Per-frame energy in dB for an isolated vocal track."""
    # A movie-length stereo float array can exceed a gigabyte. Keep only the
    # per-frame energy and decode 30 seconds at a time, aligned to frame boundaries.
    energies = []
    with sf.SoundFile(vocals_path) as source:
        hop = max(1, int(source.samplerate * FRAME_SECONDS))
        while True:
            audio = source.read(hop * 1500, dtype="float32", always_2d=True)
            frames = len(audio) // hop
            if not frames:
                break
            mono = audio[:frames * hop].mean(axis=1)
            energies.append((mono.reshape(frames, hop) ** 2).mean(axis=1))
    if not energies:
        return np.zeros(0, dtype=float)
    energy = np.concatenate(energies)
    if len(energy) < 3:
        return np.zeros(0, dtype=float)
    return 10 * np.log10(energy + 1e-9)


def _frame_activity(vocals_path: str, energy_db=None):
    """(active frames as bool array, frame duration) for an isolated vocal track."""
    if energy_db is None:
        energy_db = _frame_energy_db(vocals_path)
    if not len(energy_db):
        return np.zeros(0, dtype=bool)
    frames = len(energy_db)
    half = max(1, int(FLOOR_WINDOW_SECONDS / FRAME_SECONDS))
    padded = np.pad(energy_db, half, mode="edge")
    windows = np.lib.stride_tricks.sliding_window_view(padded, 2 * half + 1)[:frames]
    floor = np.empty(frames)
    for start in range(0, frames, 4096):
        floor[start:start + 4096] = np.percentile(windows[start:start + 4096], 20, axis=1)
    return energy_db > floor + ACTIVE_MARGIN_DB


def detect_speech_regions(
    vocals_path: str,
    quiet_margin_db: float | None = None,
) -> list[tuple[float, float]]:
    """(start, end) of each spoken burst — one line of dialogue, pauses inside it kept.

    With `quiet_margin_db` set, bursts more than that far below the track's loud frames are
    dropped as stem residue rather than someone speaking. The two callers want opposite
    things, so this is a parameter rather than a fixed rule: hunting for missing captions
    must not send you to silence, while snapping existing captions would rather catch a
    quiet line than miss it.
    """
    energy_db = _frame_energy_db(vocals_path)
    if not len(energy_db):
        return []
    quiet_cutoff = (
        float(np.percentile(energy_db, 95)) - quiet_margin_db
        if quiet_margin_db is not None
        else float("-inf")
    )

    active = _frame_activity(vocals_path, energy_db)
    if not len(active):
        return []
    merge_gap = int(MERGE_GAP_SECONDS / FRAME_SECONDS)
    regions: list[list[int]] = []
    for i, is_active in enumerate(active):
        if not is_active:
            continue
        if regions and i - regions[-1][1] <= merge_gap:
            regions[-1][1] = i
        else:
            regions.append([i, i])
    out = []
    for start_f, end_f in regions:
        start, end = start_f * FRAME_SECONDS, end_f * FRAME_SECONDS + TAIL_PAD_SECONDS
        if end - start < MIN_REGION_SECONDS:
            continue
        # mean of the frames inside the burst, not the peak, so one click does not carry it
        level = float(energy_db[start_f : end_f + 1].mean()) if end_f >= start_f else quiet_cutoff
        if level < quiet_cutoff:
            continue
        out.append((round(start, 3), round(end, 3)))
    return out
