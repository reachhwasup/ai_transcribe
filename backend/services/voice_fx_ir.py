"""Reverb spaces for the voice effects, made as impulse responses and applied by convolution.

ffmpeg's `aecho` repeats the voice a few times, which reads as a metallic flutter rather than a
room. A real space is dense, diffuse and darker as it dies away; these impulse responses are
built that way (shaped noise, highs decaying faster than lows, a handful of early reflections)
and fed to `afir`. They are generated once from fixed seeds, so every render is identical.

Each space is stereo, with a different tail in each ear: the voice stays in the centre and the
room opens up around it. The same tail in both ears is what made the spaces sound small and
boxy, however long they rang.
"""
from __future__ import annotations

import os
import re
import tempfile
from dataclasses import dataclass

import numpy as np

IR_RATE = 24000
IR_VERSION = 2
TAIL = 0.5   # seconds of reverb kept after the voice when the effect is baked in


@dataclass(frozen=True)
class Space:
    rt60: float            # seconds for the tail to fall 60 dB (mid band)
    predelay: float = 0.0  # seconds before the tail starts
    damping: float = 0.5   # how much faster the highs die: 0 = bright, 1 = very dark
    early: int = 0         # number of early reflections
    seed: int = 1


SPACES = {
    "booth": Space(rt60=0.22, damping=0.7, early=3, seed=11),          # a tiny dry room
    "plate": Space(rt60=0.9, predelay=0.012, damping=0.7, early=2, seed=18),   # close, inside the head
    "hall": Space(rt60=1.9, predelay=0.02, damping=0.45, early=6, seed=12),
    "dream": Space(rt60=3.0, predelay=0.035, damping=0.8, early=0, seed=13),
    "memory": Space(rt60=1.5, predelay=0.02, damping=0.75, early=4, seed=14),
    "heaven": Space(rt60=3.6, predelay=0.05, damping=0.15, early=0, seed=15),
    "abyss": Space(rt60=4.2, predelay=0.06, damping=0.9, early=0, seed=16),
    "ghost": Space(rt60=3.4, predelay=0.04, damping=0.35, early=0, seed=17),
}


def _bands(noise: np.ndarray) -> list[tuple[np.ndarray, float]]:
    """Split noise into four bands (by FFT masking) with each band's centre frequency."""
    spec = np.fft.rfft(noise)
    freqs = np.fft.rfftfreq(len(noise), 1 / IR_RATE)
    edges = [0, 400, 1600, 4500, IR_RATE / 2 + 1]
    out = []
    for lo, hi in zip(edges, edges[1:]):
        mask = (freqs >= lo) & (freqs < hi)
        out.append((np.fft.irfft(spec * mask, len(noise)), max(200.0, (lo + hi) / 2)))
    return out


def build_ir(space: Space) -> np.ndarray:
    """The space as (samples, 2): left and right share its character but not its noise."""
    return np.column_stack([_build_channel(space, space.seed), _build_channel(space, space.seed + 100)])


def _build_channel(space: Space, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    length = int(IR_RATE * min(space.rt60 * 1.1 + space.predelay, 5.0))
    t = np.arange(length) / IR_RATE
    tail = np.zeros(length)
    for band, centre in _bands(rng.standard_normal(length)):
        # highs lose energy faster; damping sets how much
        rt = space.rt60 * (1.0 - space.damping * min(1.0, np.log2(centre / 200) / 5)) if centre > 1000 else space.rt60
        tail += band * np.exp(-6.9078 * t / max(rt, 0.05))
    # the tail builds up over its first few ms instead of starting at full density
    tail *= 1 - np.exp(-t / 0.012)
    ir = np.zeros(length + int(space.predelay * IR_RATE))
    start = int(space.predelay * IR_RATE)
    ir[start:start + length] = tail[: len(ir) - start]
    for _ in range(space.early):
        at = start + int(rng.uniform(0.004, 0.045) * IR_RATE)
        if at < len(ir):
            ir[at] += rng.choice([-1, 1]) * rng.uniform(0.3, 0.7) * np.abs(tail).max()
    return (ir / np.sqrt(np.sum(ir ** 2))).astype(np.float32)


def _cache_dir() -> str:
    d = os.path.join(tempfile.gettempdir(), f"ai_transcript_voice_ir_v{IR_VERSION}")
    os.makedirs(d, exist_ok=True)
    return d


def ir_path(name: str) -> str:
    """A wav of the named space, written on first use."""
    import soundfile as sf

    path = os.path.join(_cache_dir(), f"{name}.wav")
    if not os.path.isfile(path):
        tmp = f"{path}.{os.getpid()}.tmp.wav"
        sf.write(tmp, build_ir(SPACES[name]), IR_RATE, subtype="FLOAT")
        os.replace(tmp, path)
    return path


def _quote(path: str) -> str:
    if not re.fullmatch(r"[\w/.\-~ ]+", path):
        raise RuntimeError(f"Reverb file path has characters ffmpeg can't take: {path!r}")
    return path.replace(" ", r"\ ")


def reverb(name: str, mix: float, pre: str = "", post: str = "", tag: str = "r") -> str:
    """A filter-graph fragment that adds the space to the voice: dry plus `mix` of the reverb.

    `pre` shapes only what goes into the reverb (e.g. a high-pass so the tail isn't boomy) and
    `post` only what comes out of it. The fragment has one input and one output, so it drops
    into a plain `-af` chain between commas. The voice is padded so the space rings on for
    TAIL seconds after the last word and then fades out, rather than stopping dead; restyling
    an existing clip trims that off again to keep the clip's length.
    """
    send = f"{pre}," if pre else ""
    ret = f",{post}" if post else ""
    # `pan` copies the voice to both ears at full level; a plain mono-to-stereo conversion
    # would drop it 3 dB against lines that have no effect.
    both = "pan=stereo|c0=c0|c1=c0"
    return (
        f"apad=pad_dur={TAIL},asplit=2[{tag}d][{tag}s];"
        f"amovie={_quote(ir_path(name))},aformat=channel_layouts=stereo[{tag}ir];"
        f"[{tag}s]{send}{both}[{tag}in];"
        f"[{tag}in][{tag}ir]afir=gtype=none:irnorm=-1[{tag}w0];"
        f"[{tag}w0]volume={mix:.3f}{ret}[{tag}w];"
        f"[{tag}d]{both}[{tag}dm];"
        f"[{tag}dm][{tag}w]amix=inputs=2:normalize=0:duration=first,"
        f"areverse,afade=t=in:d={TAIL * 0.8:.2f}:curve=qsin,areverse"
    )
