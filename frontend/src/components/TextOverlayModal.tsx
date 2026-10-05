import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Copy, Copyright, Loader2, LogIn, LogOut, Pause,
  Plus, Sparkles, Trash2, Type, X,
} from 'lucide-react';
import {
  fetchTextOverlays,
  saveTextOverlays,
  deleteTextOverlay,
  type TextOverlay,
} from '../api/client';
import type { OverlayEntrance, OverlayExit } from '../utils/overlayMotion';
import OverlayText from './OverlayText';

const clock = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

const POSITIONS: { label: string; x: number; y: number; anchor: TextOverlay['anchor'] }[] = [
  { label: 'Top', x: 50, y: 12, anchor: 'center' },
  { label: 'Middle', x: 50, y: 50, anchor: 'center' },
  { label: 'Bottom', x: 50, y: 82, anchor: 'center' },
  { label: 'Top left', x: 6, y: 12, anchor: 'left' },
  { label: 'Top right', x: 94, y: 12, anchor: 'right' },
  { label: 'Lower left', x: 6, y: 82, anchor: 'left' },
  { label: 'Lower right', x: 94, y: 82, anchor: 'right' },
];

const ENTRANCES: { key: OverlayEntrance; label: string; icon?: typeof ArrowUp }[] = [
  { key: 'fade', label: 'Fade' },
  { key: 'pop', label: 'Pop' },
  { key: 'zoom', label: 'Zoom' },
  { key: 'slide_up', label: 'From bottom', icon: ArrowUp },
  { key: 'slide_down', label: 'From top', icon: ArrowDown },
  { key: 'slide_right', label: 'From left', icon: ArrowRight },
  { key: 'slide_left', label: 'From right', icon: ArrowLeft },
];
const LOOPS: { key: OverlayEntrance; label: string }[] = [
  { key: 'marquee_left', label: 'Ticker ←' },
  { key: 'marquee_right', label: 'Ticker →' },
  { key: 'drift', label: 'Drift' },
  { key: 'bounce', label: 'Float & bounce' },
  { key: 'corners', label: 'Hop corners' },
];
const EXITS: { key: OverlayExit; label: string; icon?: typeof ArrowUp }[] = [
  { key: 'none', label: 'Fade' },
  { key: 'zoom', label: 'Zoom out' },
  { key: 'slide_down', label: 'To bottom', icon: ArrowDown },
  { key: 'slide_up', label: 'To top', icon: ArrowUp },
  { key: 'slide_left', label: 'To left', icon: ArrowLeft },
  { key: 'slide_right', label: 'To right', icon: ArrowRight },
];

const BASE: Omit<TextOverlay, 'id' | 'text' | 'start_time' | 'end_time'> = {
  x_pct: 50, y_pct: 12, anchor: 'center', size_pct: 7, color: '#FFFFFF', opacity: 1,
  outline_color: '#000000', outline_width: 3, box_color: '#000000', box_opacity: 0, bold: true,
  fade_seconds: 0.25, animation: 'pop', animation_seconds: 0.5, exit_animation: 'zoom', exit_seconds: 0.35,
};

/** One-click looks: position, style and motion together. */
const PRESETS: { name: string; hint: string; text: string; seconds: number; fields: Partial<TextOverlay> }[] = [
  {
    name: 'Title pop', hint: 'Big centred title that pops in and zooms away', text: 'ចំណងជើង', seconds: 3,
    fields: { x_pct: 50, y_pct: 40, anchor: 'center', size_pct: 11, color: '#FFFFFF', outline_width: 4, box_opacity: 0,
      animation: 'pop', animation_seconds: 0.55, exit_animation: 'zoom', exit_seconds: 0.35, fade_seconds: 0.2 },
  },
  {
    name: 'Lower third', hint: 'Name strap that slides in from the left and out again', text: 'ឈ្មោះ • តួនាទី', seconds: 4,
    fields: { x_pct: 5, y_pct: 80, anchor: 'left', size_pct: 5.5, color: '#FFFFFF', outline_width: 0,
      box_color: '#111827', box_opacity: 0.75, animation: 'slide_right', animation_seconds: 0.5,
      exit_animation: 'slide_left', exit_seconds: 0.4, fade_seconds: 0.15 },
  },
  {
    name: 'Breaking ticker', hint: 'News strap that scrolls right to left across the bottom', text: 'ព័ត៌មានថ្មីៗ • BREAKING', seconds: 12,
    fields: { x_pct: 50, y_pct: 93, anchor: 'center', size_pct: 5, color: '#FFFFFF', outline_width: 0,
      box_color: '#DC2626', box_opacity: 0.9, animation: 'marquee_left', animation_seconds: 9,
      exit_animation: 'none', fade_seconds: 0.3 },
  },
  {
    name: 'Callout', hint: 'Bright badge that pops in the corner and slides off', text: 'Subscribe!', seconds: 4,
    fields: { x_pct: 94, y_pct: 80, anchor: 'right', size_pct: 6, color: '#111111', outline_width: 0,
      box_color: '#FACC15', box_opacity: 1, animation: 'pop', animation_seconds: 0.45,
      exit_animation: 'slide_right', exit_seconds: 0.4, fade_seconds: 0.1 },
  },
  {
    name: 'Floating tag', hint: 'Keeps floating around the frame and bouncing off the edges', text: '@channel', seconds: 10,
    fields: { x_pct: 50, y_pct: 50, anchor: 'center', size_pct: 4.5, color: '#FFFFFF', opacity: 0.7, outline_width: 2,
      box_opacity: 0, animation: 'bounce', animation_seconds: 1.5, exit_animation: 'none', fade_seconds: 0.4 },
  },
];

interface Props {
  projectId: string;
  /** Where the playhead is, used as the start time for a new overlay. */
  currentTime: number;
  videoSeconds: number;
  /** The project video, shown under the overlays in the live preview. */
  videoSrc?: string;
  /** Overlay times are timeline times; the preview seeks the source video. */
  toSourceTime?: (t: number) => number;
  /** Open with this overlay selected (a double-click on the timeline's text track) */
  initialSelectedId?: string;
  /** Open by adding a new overlay at the playhead */
  createOnOpen?: boolean;
  onClose: () => void;
  onSaved?: (overlays: TextOverlay[]) => void;
}

const SNAP = 2; // % of the frame within which a drag snaps to a centre line

export default function TextOverlayModal({
  projectId,
  currentTime,
  videoSeconds,
  videoSrc,
  toSourceTime = (t) => t,
  initialSelectedId,
  createOnOpen = false,
  onClose,
  onSaved,
}: Props) {
  const [overlays, setOverlays] = useState<TextOverlay[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Live preview: the time shown, and a loop being played over part of the selected overlay
  const [previewT, setPreviewT] = useState(currentTime);
  const [loop, setLoop] = useState<{ from: number; to: number } | null>(null);
  const [stage, setStage] = useState({ w: 640, h: 360 });
  const [aspect, setAspect] = useState(16 / 9);
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // The playhead when the editor opened. Read once: the video may keep playing underneath,
  // and reloading on every tick would throw away unsaved edits.
  const openedAt = useRef(currentTime).current;
  useEffect(() => {
    let cancelled = false;
    fetchTextOverlays(projectId)
      .then((list) => {
        if (cancelled) return;
        setOverlays(list);
        const here =
          list.find((o) => o.id === initialSelectedId) ||
          list.find((o) => openedAt >= o.start_time && openedAt <= o.end_time) ||
          list[0];
        setSelectedId(here?.id ?? null);
      })
      .catch((e) => !cancelled && setError(e?.message || 'Could not load overlays'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, openedAt]);

  const selected = overlays.find((o) => o.id === selectedId) || null;

  // "+ Text" on the timeline: add one as soon as the list has loaded
  const createdRef = useRef(false);
  useEffect(() => {
    if (!createOnOpen || loading || createdRef.current) return;
    createdRef.current = true;
    addOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createOnOpen, loading]);

  const patch = useCallback(
    (changes: Partial<TextOverlay>) => {
      if (!selectedId) return;
      setOverlays((list) => list.map((o) => (o.id === selectedId ? { ...o, ...changes } : o)));
      setDirty(true);
    },
    [selectedId],
  );

  // --- preview stage sizing ---
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  // --- preview time: follow a loop while playing, otherwise hold ---
  useEffect(() => {
    if (!loop) return;
    let raf = 0;
    const began = performance.now();
    const length = Math.max(0.2, loop.to - loop.from);
    const v = videoRef.current;
    if (v) {
      v.currentTime = toSourceTime(loop.from);
      v.play().catch(() => {});
    }
    const tick = () => {
      const t = loop.from + (((performance.now() - began) / 1000) % length);
      setPreviewT(t);
      // keep the picture roughly in step; re-seek when the loop wraps
      if (v && Math.abs(v.currentTime - toSourceTime(t)) > 0.35) v.currentTime = toSourceTime(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      v?.pause();
    };
    // toSourceTime is a fresh function each render; the loop only restarts on a new range
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loop]);

  // when not playing, show the frame under the preview time
  useEffect(() => {
    if (loop) return;
    const v = videoRef.current;
    if (v && Number.isFinite(previewT)) v.currentTime = toSourceTime(previewT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewT, loop]);

  const showAt = (t: number) => {
    setLoop(null);
    setPreviewT(t);
  };
  const playEntrance = () => {
    if (!selected) return;
    const long = (selected.animation || '').startsWith('marquee') || ['drift', 'bounce', 'corners'].includes(selected.animation);
    const lead = long ? 6 : (selected.animation_seconds || 0.5) + 1.2;
    setLoop({ from: Math.max(0, selected.start_time - 0.3), to: Math.min(selected.end_time, selected.start_time + lead) });
  };
  // After a preset is applied, play its entrance once the new values have landed
  const [autoPlay, setAutoPlay] = useState(false);
  useEffect(() => {
    if (!autoPlay || !selected) return;
    setAutoPlay(false);
    playEntrance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, selected]);
  const playExit = () => {
    if (!selected) return;
    const tail = (selected.exit_seconds || 0.4) + 1.2;
    setLoop({ from: Math.max(selected.start_time, selected.end_time - tail), to: selected.end_time + 0.3 });
  };

  // When the selection changes, show a moment where it is fully on screen
  useEffect(() => {
    if (!selected) return;
    if (previewT >= selected.start_time && previewT <= selected.end_time) return;
    const settled = selected.start_time + Math.min(
      (selected.end_time - selected.start_time) / 2,
      (selected.animation_seconds || 0.5) + 0.3,
    );
    showAt(settled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // --- drag to position ---
  const startDrag = (o: TextOverlay) => (e: ReactPointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(o.id);
    setLoop(null);
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const x0 = o.x_pct;
    const y0 = o.y_pct;
    const move = (ev: PointerEvent) => {
      let x = x0 + ((ev.clientX - startX) / rect.width) * 100;
      let y = y0 + ((ev.clientY - startY) / rect.height) * 100;
      const snapV = o.anchor === 'center' && Math.abs(x - 50) < SNAP;
      const snapH = Math.abs(y - 50) < SNAP;
      if (snapV) x = 50;
      if (snapH) y = 50;
      setGuides({ v: snapV, h: snapH });
      x = Math.max(0, Math.min(100, x));
      y = Math.max(0, Math.min(100, y));
      setOverlays((list) =>
        list.map((it) => (it.id === o.id ? { ...it, x_pct: Number(x.toFixed(1)), y_pct: Number(y.toFixed(1)) } : it)),
      );
      setDirty(true);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setGuides({ v: false, h: false });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // --- add / duplicate / remove ---
  const newId = () => `new-${Date.now()}-${Math.round(Math.random() * 1e4)}`;
  const insert = (o: TextOverlay) => {
    setOverlays((list) => [...list, o].sort((a, b) => a.start_time - b.start_time));
    setSelectedId(o.id);
    setDirty(true);
  };
  const startHere = () => Number(Math.max(0, Math.min(currentTime, Math.max(0, videoSeconds - 1))).toFixed(2));
  const addOverlay = () => {
    const start = startHere();
    insert({ ...BASE, id: newId(), text: 'ចំណងជើង', start_time: start, end_time: Number(Math.min(videoSeconds || start + 3, start + 3).toFixed(2)) });
  };
  const applyPreset = (p: (typeof PRESETS)[number]) => {
    if (selected) {
      // restyle what is selected, keeping its words and timing
      patch({ ...p.fields });
    } else {
      const start = startHere();
      insert({
        ...BASE, ...p.fields, id: newId(), text: p.text, start_time: start,
        end_time: Number(Math.min(videoSeconds || start + p.seconds, start + p.seconds).toFixed(2)),
      });
    }
    setAutoPlay(true); // show the motion straight away
  };
  const addWatermark = () => {
    insert({
      ...BASE, id: newId(),
      text: '© ' + (window.prompt('Whose video is this?', 'Dubbing Studio') || 'Dubbing Studio'),
      start_time: 0, end_time: Number((videoSeconds || 60).toFixed(2)),
      x_pct: 94, y_pct: 92, anchor: 'right', size_pct: 3.5, opacity: 0.45, outline_width: 2,
      fade_seconds: 0, animation: 'drift', animation_seconds: 1, exit_animation: 'none',
    });
  };
  const duplicate = () => {
    if (!selected) return;
    const length = selected.end_time - selected.start_time;
    const start = Number(Math.min(selected.end_time, Math.max(0, (videoSeconds || selected.end_time) - length)).toFixed(2));
    insert({ ...selected, id: newId(), start_time: start, end_time: Number((start + length).toFixed(2)) });
  };

  const removeOverlay = async (id: string) => {
    if (id.startsWith('new-')) {
      setOverlays((list) => list.filter((o) => o.id !== id));
      setSelectedId(null);
      setDirty(true);
      return;
    }
    try {
      const list = await deleteTextOverlay(projectId, id);
      // keep unsaved edits to the others
      setOverlays((cur) => cur.filter((o) => o.id !== id && (o.id.startsWith('new-') || list.some((l) => l.id === o.id))));
      setSelectedId(null);
      onSaved?.(list);
    } catch (e: any) {
      setError(e?.message || 'Could not delete that overlay');
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const list = await saveTextOverlays(projectId, overlays);
      setOverlays(list);
      setDirty(false);
      onSaved?.(list);
      onClose();
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setError(Array.isArray(detail) ? detail.map((d: any) => d.msg).join('; ') : detail || e?.message || 'Could not save the overlays');
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (dirty && !confirm('Discard your unsaved overlay changes?')) return;
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const visible = overlays.filter((o) => previewT >= o.start_time && previewT <= o.end_time);
  const looping = (selected?.animation || '').startsWith('marquee') || ['drift', 'bounce', 'corners'].includes(selected?.animation || '');

  const chip = (active: boolean) =>
    `inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
      active ? 'border-violet-500 bg-violet-600 text-white' : 'border-[var(--s5)] bg-[var(--s3)] text-zinc-400 hover:text-white'
    }`;
  const heading = 'text-[11px] font-semibold uppercase tracking-wide text-zinc-400';

  // The player sits inside transformed containers, and a transformed ancestor makes
  // `position: fixed` resolve against that ancestor instead of the viewport.
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[var(--s4)] bg-[var(--s2)] shadow-2xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--s3)] px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="rounded-lg bg-violet-500/10 p-2 text-violet-300">
              <Type className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-white">Text overlays</h2>
              <p className="text-[11px] text-zinc-400">
                Drag text on the preview to place it. What you see here is exactly what exports.
              </p>
            </div>
          </div>
          <button onClick={close} className="shrink-0 rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr] overflow-hidden">
          {/* list */}
          <div className="flex min-h-0 flex-col border-r border-[var(--s3)]">
            <div className="flex-1 overflow-y-auto p-2">
              {loading ? (
                <div className="flex items-center gap-2 p-3 text-[11px] text-zinc-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                </div>
              ) : overlays.length === 0 ? (
                <p className="p-3 text-[11px] leading-relaxed text-zinc-500">
                  No overlays yet. Pick a preset on the right, or add a plain one.
                </p>
              ) : (
                overlays.map((o) => (
                  <button
                    key={o.id}
                    onClick={() => setSelectedId(o.id)}
                    className={`mb-1 flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                      o.id === selectedId ? 'bg-violet-600/20 text-white' : 'text-zinc-400 hover:bg-white/5'
                    }`}
                  >
                    <span className="truncate font-khmer text-[11px] font-medium">{o.text || '(empty)'}</span>
                    <span className="text-[10px] tabular-nums text-zinc-500">
                      {clock(o.start_time)} – {clock(o.end_time)}
                    </span>
                  </button>
                ))
              )}
            </div>
            <div className="m-2 space-y-1.5">
              <button
                onClick={() => {
                  setSelectedId(null);
                  addOverlay();
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-600/15 py-2 text-[11px] font-semibold text-violet-200 transition-colors hover:bg-violet-600/25"
              >
                <Plus className="h-3.5 w-3.5" /> Add at playhead
              </button>
              <button
                onClick={addWatermark}
                title="Small faint credit in the corner, on screen for the whole video"
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--s5)] bg-[var(--s3)] py-2 text-[11px] font-semibold text-zinc-300 transition-colors hover:text-white"
              >
                <Copyright className="h-3.5 w-3.5" /> Owner watermark
              </button>
            </div>
          </div>

          {/* preview + editor */}
          <div className="min-h-0 overflow-y-auto p-4 space-y-4">
            {/* Live preview stage */}
            <div>
              <div
                ref={stageRef}
                className="relative mx-auto max-w-full overflow-hidden rounded-xl bg-black ring-1 ring-[var(--s4)] select-none"
                // A fixed height with the width from the video's shape, so a portrait video is
                // a tall narrow stage instead of a very long one that pushes the controls away
                style={{ height: 'min(46vh, 380px)', aspectRatio: String(aspect) }}
                onPointerDown={() => setLoop(null)}
              >
                {videoSrc && (
                  <video
                    ref={videoRef}
                    src={videoSrc}
                    muted
                    playsInline
                    preload="auto"
                    className="absolute inset-0 h-full w-full object-contain pointer-events-none"
                    onLoadedMetadata={(e) => {
                      const v = e.currentTarget;
                      if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
                      v.currentTime = toSourceTime(previewT);
                    }}
                  />
                )}
                {guides.v && <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-pink-400/90" />}
                {guides.h && <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-pink-400/90" />}
                <div className="pointer-events-none absolute inset-0">
                  {visible.map((o) => (
                    <OverlayText
                      key={o.id}
                      overlay={o}
                      t={previewT}
                      W={stage.w}
                      H={stage.h}
                      selected={o.id === selectedId && !loop}
                      dimmed={!!selectedId && o.id !== selectedId}
                      onPointerDown={startDrag(o)}
                    />
                  ))}
                </div>
                {selected && !visible.some((o) => o.id === selected.id) && (
                  <button
                    onClick={() => showAt(selected.start_time + Math.min(1, (selected.end_time - selected.start_time) / 2))}
                    className="absolute inset-x-0 bottom-3 mx-auto w-fit rounded-md bg-black/70 px-2.5 py-1 text-[11px] text-zinc-200"
                  >
                    Not on screen at {clock(previewT)} — show it
                  </button>
                )}
              </div>

              {/* transport */}
              {selected && (
                <div className="mx-auto mt-2 flex max-w-[560px] items-center gap-2">
                  <button onClick={loop ? () => setLoop(null) : playEntrance} className={chip(!!loop)} title="Loop how it comes in">
                    {loop ? <Pause className="h-3 w-3" /> : <LogIn className="h-3 w-3" />}
                    {loop ? 'Stop' : looping ? 'Play motion' : 'Entrance'}
                  </button>
                  {!looping && (
                    <button onClick={playExit} className={chip(false)} title="Loop how it leaves">
                      <LogOut className="h-3 w-3" /> Exit
                    </button>
                  )}
                  <input
                    type="range"
                    min={Math.max(0, selected.start_time - 0.5)}
                    max={selected.end_time + 0.5}
                    step={0.02}
                    value={Math.min(selected.end_time + 0.5, Math.max(selected.start_time - 0.5, previewT))}
                    onChange={(e) => showAt(Number(e.target.value))}
                    className="flex-1 accent-violet-500"
                    title="Scrub through this overlay"
                  />
                  <span className="w-12 text-right text-[10px] tabular-nums text-zinc-500">{clock(previewT)}</span>
                </div>
              )}
            </div>

            {/* Presets */}
            <div>
              <span className={heading}>
                <Sparkles className="mr-1 inline h-3 w-3 text-violet-300" />
                {selected ? 'Restyle with a preset' : 'Start from a preset'}
              </span>
              <div className="mt-1.5 grid grid-cols-5 gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p.name}
                    onClick={() => applyPreset(p)}
                    title={p.hint}
                    className="rounded-lg border border-[var(--s5)] bg-[var(--s3)] px-2 py-2 text-left transition-colors hover:border-violet-500/60 hover:bg-violet-600/10"
                  >
                    <span className="block text-[11px] font-semibold text-white">{p.name}</span>
                    <span className="block truncate text-[9.5px] text-zinc-500">{p.hint}</span>
                  </button>
                ))}
              </div>
            </div>

            {!selected ? (
              <p className="text-xs text-zinc-500">Pick an overlay on the left, or start from a preset.</p>
            ) : (
              <div className="space-y-4">
                <label className="block">
                  <span className={heading}>Text</span>
                  <textarea
                    value={selected.text}
                    onChange={(e) => patch({ text: e.target.value })}
                    rows={2}
                    className="mt-1.5 w-full rounded-lg border border-[var(--s5)] bg-[var(--s3)] px-3 py-2 font-khmer text-sm text-white focus:border-violet-500 focus:outline-none"
                  />
                </label>

                {/* Motion */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <span className={heading}>Comes in</span>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {ENTRANCES.map(({ key, label, icon: Icon }) => (
                        <button key={key} onClick={() => patch({ animation: key })} className={chip((selected.animation || 'fade') === key)}>
                          {Icon && <Icon className="h-3 w-3" />} {label}
                        </button>
                      ))}
                    </div>
                    <span className={`${heading} mt-3 block`}>…or keeps moving</span>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {LOOPS.map(({ key, label }) => (
                        <button key={key} onClick={() => patch({ animation: key })} className={chip(selected.animation === key)}>
                          {label}
                        </button>
                      ))}
                    </div>
                    {selected.animation !== 'fade' && (
                      <label className="mt-2 block">
                        <span className="text-[10px] text-zinc-500">
                          {(() => {
                            const a = selected.animation;
                            const v = selected.animation_seconds ?? 0.5;
                            if (a.startsWith('marquee')) return `One crossing — ${v}s (repeats until it ends)`;
                            if (a === 'bounce') return `Speed — ${v} (higher is slower)`;
                            if (a === 'corners') return `Holds each corner ~${(Math.max(1, v * 4)).toFixed(1)}s`;
                            if (a === 'drift') return `Wander cycle ~${Math.max(4, v * 8).toFixed(0)}s`;
                            return `Entrance — ${v}s`;
                          })()}
                        </span>
                        <input
                          type="range" min={0.1} max={selected.animation.startsWith('marquee') ? 20 : 2} step={0.05}
                          value={selected.animation_seconds ?? 0.5}
                          onChange={(e) => patch({ animation_seconds: Number(e.target.value) })}
                          className="mt-1 w-full accent-violet-500"
                        />
                      </label>
                    )}
                  </div>
                  <div>
                    <span className={heading}>Leaves</span>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {EXITS.map(({ key, label, icon: Icon }) => (
                        <button key={key} onClick={() => patch({ exit_animation: key })} className={chip((selected.exit_animation || 'none') === key)}>
                          {Icon && <Icon className="h-3 w-3" />} {label}
                        </button>
                      ))}
                    </div>
                    {(selected.exit_animation || 'none') !== 'none' && (
                      <label className="mt-2 block">
                        <span className="text-[10px] text-zinc-500">Exit — {selected.exit_seconds ?? 0.4}s</span>
                        <input
                          type="range" min={0.1} max={2} step={0.05} value={selected.exit_seconds ?? 0.4}
                          onChange={(e) => patch({ exit_seconds: Number(e.target.value) })}
                          className="mt-1 w-full accent-violet-500"
                        />
                      </label>
                    )}
                    <label className="mt-3 block">
                      <span className="text-[10px] text-zinc-500">Fade in & out — {selected.fade_seconds}s</span>
                      <input
                        type="range" min={0} max={1.5} step={0.05} value={selected.fade_seconds}
                        onChange={(e) => patch({ fade_seconds: Number(e.target.value) })}
                        className="mt-1 w-full accent-violet-500"
                      />
                    </label>
                  </div>
                </div>

                {/* Timing */}
                <div>
                  <span className={heading}>When</span>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <input
                      type="number" step="0.1" min={0} value={selected.start_time}
                      onChange={(e) => patch({ start_time: Number(e.target.value) })}
                      className="w-24 rounded-lg border border-[var(--s5)] bg-[var(--s3)] px-2.5 py-1.5 text-xs text-white focus:border-violet-500 focus:outline-none"
                      title="Start (seconds)"
                    />
                    <span className="text-[11px] text-zinc-500">to</span>
                    <input
                      type="number" step="0.1" min={0} value={selected.end_time}
                      onChange={(e) => patch({ end_time: Number(e.target.value) })}
                      className="w-24 rounded-lg border border-[var(--s5)] bg-[var(--s3)] px-2.5 py-1.5 text-xs text-white focus:border-violet-500 focus:outline-none"
                      title="End (seconds)"
                    />
                    <button
                      onClick={() => {
                        const len = selected.end_time - selected.start_time;
                        const s = startHere();
                        patch({ start_time: s, end_time: Number((s + len).toFixed(2)) });
                      }}
                      className={chip(false)}
                    >
                      Move to playhead
                    </button>
                    {[3, 5, 8].map((n) => (
                      <button
                        key={n}
                        onClick={() => patch({ end_time: Number(Math.min(videoSeconds || 1e9, selected.start_time + n).toFixed(2)) })}
                        className={chip(Math.abs(selected.end_time - selected.start_time - n) < 0.05)}
                      >
                        {n}s
                      </button>
                    ))}
                    <button
                      onClick={() => patch({ start_time: 0, end_time: Number((videoSeconds || 0).toFixed(2)) })}
                      className={chip(false)}
                    >
                      Whole video
                    </button>
                  </div>
                </div>

                {/* Position */}
                <div>
                  <span className={heading}>Position — or drag it on the preview</span>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {POSITIONS.map((p) => (
                      <button
                        key={p.label}
                        onClick={() => patch({ x_pct: p.x, y_pct: p.y, anchor: p.anchor })}
                        className={chip(Math.abs(selected.x_pct - p.x) < 1 && Math.abs(selected.y_pct - p.y) < 1)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Style */}
                <div className="grid grid-cols-2 gap-4">
                  <label className="block">
                    <span className={heading}>Size — {selected.size_pct}% of frame</span>
                    <input
                      type="range" min={2} max={20} step={0.5} value={selected.size_pct}
                      onChange={(e) => patch({ size_pct: Number(e.target.value) })}
                      className="mt-2 w-full accent-violet-500"
                    />
                  </label>
                  <label className="block">
                    <span className={heading}>Opacity — {Math.round((selected.opacity ?? 1) * 100)}%</span>
                    <input
                      type="range" min={0.05} max={1} step={0.05} value={selected.opacity ?? 1}
                      onChange={(e) => patch({ opacity: Number(e.target.value) })}
                      className="mt-2 w-full accent-violet-500"
                    />
                  </label>
                </div>
                <div className="grid grid-cols-4 gap-3">
                  <label className="block">
                    <span className={heading}>Text</span>
                    <input type="color" value={selected.color} onChange={(e) => patch({ color: e.target.value })}
                      className="mt-1.5 h-9 w-full cursor-pointer rounded-lg border border-[var(--s5)] bg-[var(--s3)]" />
                  </label>
                  <label className="block">
                    <span className={heading}>Outline</span>
                    <input type="color" value={selected.outline_color} onChange={(e) => patch({ outline_color: e.target.value })}
                      className="mt-1.5 h-9 w-full cursor-pointer rounded-lg border border-[var(--s5)] bg-[var(--s3)]" />
                  </label>
                  <label className="block">
                    <span className={heading}>Box</span>
                    <input type="color" value={selected.box_color} onChange={(e) => patch({ box_color: e.target.value, box_opacity: selected.box_opacity || 0.75 })}
                      className="mt-1.5 h-9 w-full cursor-pointer rounded-lg border border-[var(--s5)] bg-[var(--s3)]" />
                  </label>
                  <label className="block">
                    <span className={heading}>Box {Math.round(selected.box_opacity * 100)}%</span>
                    <input type="range" min={0} max={1} step={0.05} value={selected.box_opacity}
                      onChange={(e) => patch({ box_opacity: Number(e.target.value) })}
                      className="mt-3 w-full accent-violet-500" />
                  </label>
                </div>
                <label className="block">
                  <span className={heading}>Outline width — {selected.outline_width}</span>
                  <input type="range" min={0} max={12} step={0.5} value={selected.outline_width}
                    onChange={(e) => patch({ outline_width: Number(e.target.value) })}
                    className="mt-2 w-full accent-violet-500" />
                </label>

                <div className="flex items-center gap-2">
                  <button onClick={duplicate} className={chip(false)} title="Same look and motion, placed right after this one">
                    <Copy className="h-3 w-3" /> Duplicate
                  </button>
                  <button
                    onClick={() => removeOverlay(selected.id)}
                    className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-950/40"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--s3)] bg-[var(--s1)] px-5 py-3">
          <span className="text-[11px] text-zinc-500">
            {error ? <span className="text-red-300">{error}</span> : `${overlays.length} overlay(s)${dirty ? ' · unsaved changes' : ''}`}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={close} className="rounded-lg px-3 py-2 text-xs text-zinc-400 transition-colors hover:bg-white/5 hover:text-white">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving || !dirty}
              className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-violet-500 disabled:opacity-40"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save overlays
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
