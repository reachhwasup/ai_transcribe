import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { GripVertical, Plus, Type, X } from 'lucide-react';
import {
  fetchTextOverlays,
  saveTextOverlays,
  OPEN_TEXT_OVERLAYS,
  TEXT_OVERLAYS_CHANGED,
  VERSION_RESTORED_EVENT,
  type TextOverlay,
} from '../../api/client';

const MIN_SECONDS = 0.3;

/** The project's text overlays, kept in step with the editor and the player. */
export function useTextOverlays(projectId?: string) {
  const [overlays, setOverlays] = useState<TextOverlay[]>([]);
  useEffect(() => {
    if (!projectId) {
      setOverlays([]);
      return;
    }
    let cancelled = false;
    const load = () =>
      fetchTextOverlays(projectId)
        .then((list) => !cancelled && setOverlays(list))
        .catch(() => {});
    load();
    window.addEventListener(TEXT_OVERLAYS_CHANGED, load);
    window.addEventListener(VERSION_RESTORED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(TEXT_OVERLAYS_CHANGED, load);
      window.removeEventListener(VERSION_RESTORED_EVENT, load);
    };
  }, [projectId]);
  return [overlays, setOverlays] as const;
}

export const openOverlayEditor = (detail: { id?: string; create?: boolean } = {}) =>
  window.dispatchEvent(new CustomEvent(OPEN_TEXT_OVERLAYS, { detail }));

export type OverlayTrackPos = 'top' | 'middle' | 'bottom';
const POSITIONS: OverlayTrackPos[] = ['top', 'middle', 'bottom'];
const POS_KEY = 'meatika_text_track_position';

/** Where the text track sits: under the video, under the captions, or under the voices. */
export function useOverlayTrackPosition() {
  const [pos, setPos] = useState<OverlayTrackPos>(() => {
    try {
      const v = localStorage.getItem(POS_KEY) as OverlayTrackPos | null;
      return v && POSITIONS.includes(v) ? v : 'middle';
    } catch {
      return 'middle';
    }
  });
  const setPosition = (next: OverlayTrackPos) => {
    setPos(next);
    try {
      localStorage.setItem(POS_KEY, next);
    } catch {
      /* remembered for this session only */
    }
  };
  return { pos, setPosition };
}

const POS_HINT: Record<OverlayTrackPos, string> = {
  top: 'under the video',
  middle: 'under the captions',
  bottom: 'under the voices',
};

/**
 * Label of the text track. Drag it (a mouse drag or a three-finger trackpad drag) up or down
 * among the other track labels and it drops under the video, the captions or the voices,
 * whichever is nearest; a line shows where it will land.
 */
export function OverlayTrackLabel({
  height,
  count,
  pos,
  onMove,
}: {
  height: number;
  count: number;
  pos?: OverlayTrackPos;
  onMove?: (pos: OverlayTrackPos) => void;
}) {
  const [drag, setDrag] = useState<{ y: number; target: OverlayTrackPos; lineY: number } | null>(null);

  /** Where each position sits, from the other labels in the column (page Y). */
  const slots = (column: HTMLElement) => {
    const edge = (sel: string, which: 'top' | 'bottom') => {
      const els = [...column.querySelectorAll<HTMLElement>(sel)];
      if (!els.length) return null;
      const r = (which === 'top' ? els[0] : els[els.length - 1]).getBoundingClientRect();
      return which === 'top' ? r.top : r.bottom;
    };
    const capTop = edge('[data-track-group="captions"]', 'top');
    const capBottom = edge('[data-track-group="captions"]', 'bottom');
    const voiceBottom = edge('[data-track-group="voices"]', 'bottom') ?? capBottom;
    return [
      { pos: 'top' as const, y: capTop },
      { pos: 'middle' as const, y: capBottom },
      { pos: 'bottom' as const, y: voiceBottom },
    ].filter((x): x is { pos: OverlayTrackPos; y: number } => x.y != null);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!onMove || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const column = e.currentTarget.parentElement as HTMLElement;
    const colTop = column.getBoundingClientRect().top;
    const pick = (clientY: number) => {
      const options = slots(column);
      let best = options[0];
      for (const o of options) if (Math.abs(o.y - clientY) < Math.abs(best.y - clientY)) best = o;
      return best;
    };
    const startY = e.clientY;
    let moved = false;
    let target: OverlayTrackPos | null = null;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) < 4) return;
      moved = true;
      const best = pick(ev.clientY);
      if (!best) return;
      target = best.pos;
      // the column scrolls with the tracks, so the line is placed in its scrolled content
      setDrag({ y: ev.clientY - startY, target: best.pos, lineY: best.y - colTop + column.scrollTop });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (moved && target && target !== pos) onMove(target);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <>
      {/* where it will drop, drawn across the label column while dragging */}
      {drag && (
        <div
          className="pointer-events-none absolute left-0 right-0 z-40 h-0.5 bg-violet-400 shadow-[0_0_6px_rgba(167,139,250,0.9)]"
          style={{ top: drag.lineY - 1 }}
        />
      )}
      <div
        onPointerDown={onPointerDown}
        className={`relative flex items-center justify-between px-2.5 border-b border-[var(--s4)] bg-violet-950/15 hover:bg-[var(--s3)] transition-colors select-none touch-none ${
          onMove ? 'cursor-grab active:cursor-grabbing' : ''
        } ${drag ? 'z-30 opacity-80 shadow-lg ring-1 ring-violet-400/60 bg-[var(--s3)]' : ''}`}
        style={{ height, transform: drag ? `translateY(${drag.y}px)` : undefined }}
        title={onMove ? `Text track, ${pos ? POS_HINT[pos] : ''} — drag up or down to move it` : undefined}
      >
        <span className="flex items-center gap-1 min-w-0">
          {onMove && <GripVertical className="w-3 h-3 shrink-0 text-zinc-600" />}
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30 font-mono shrink-0">
            TX
          </span>
          <span className="text-[11px] text-zinc-400 truncate">Text{count ? ` (${count})` : ''}</span>
        </span>
        <button
          onClick={() => openOverlayEditor({ create: true })}
          className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-violet-300 hover:bg-violet-500/20 hover:text-white shrink-0"
          title="Add a text overlay at the playhead"
        >
          <Plus className="w-3 h-3" /> Text
        </button>
      </div>
    </>
  );
}

/**
 * One clip per overlay. Drag the middle to move it, either edge to lengthen or shorten it,
 * double-click to open it in the editor. Changes save when the drag ends.
 */
export function OverlayTrackLane({
  projectId,
  overlays,
  setOverlays,
  height,
  duration,
  timeToX,
  xToSeconds,
  markers,
  currentTime,
  selectedId,
  onSelect,
  onDelete,
}: {
  projectId: string;
  overlays: TextOverlay[];
  setOverlays: (list: TextOverlay[]) => void;
  height: number;
  duration: number;
  timeToX: (t: number) => number;
  /** pixels → seconds at the current zoom */
  xToSeconds: (px: number) => number;
  markers: number[];
  currentTime: number;
  /** the timeline owns selection, so Delete/Backspace can remove whatever is selected */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDelete: (o: TextOverlay) => void;
}) {
  const selected = selectedId;
  const setSelected = onSelect;
  const latest = useRef(overlays);
  latest.current = overlays;

  const persist = async (list: TextOverlay[]) => {
    try {
      const saved = await saveTextOverlays(projectId, list);
      setOverlays(saved);
      window.dispatchEvent(new CustomEvent(TEXT_OVERLAYS_CHANGED));
    } catch (e: any) {
      alert(`Could not save the overlay: ${e?.response?.data?.detail?.[0]?.msg || e?.message || e}`);
    }
  };

  const drag = (o: TextOverlay, mode: 'move' | 'start' | 'end') => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    setSelected(o.id);
    const sx = e.clientX;
    const s0 = o.start_time;
    const e0 = o.end_time;
    const len = e0 - s0;
    const end = Math.max(duration, e0);
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dt = xToSeconds(ev.clientX - sx);
      if (Math.abs(ev.clientX - sx) > 2) moved = true;
      let a = s0;
      let b = e0;
      if (mode === 'move') {
        a = Math.max(0, Math.min(end - len, s0 + dt));
        b = a + len;
      } else if (mode === 'start') {
        a = Math.max(0, Math.min(e0 - MIN_SECONDS, s0 + dt));
      } else {
        b = Math.max(s0 + MIN_SECONDS, Math.min(end, e0 + dt));
      }
      const r = (v: number) => Math.round(v * 100) / 100;
      setOverlays(latest.current.map((x) => (x.id === o.id ? { ...x, start_time: r(a), end_time: r(b) } : x)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) persist(latest.current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const remove = (o: TextOverlay) => onDelete(o);

  return (
    <div
      className="relative border-b border-zinc-700/30 bg-violet-950/10"
      style={{ height }}
      onClick={(e) => e.target === e.currentTarget && setSelected(null)}
      onDoubleClick={(e) => e.target === e.currentTarget && openOverlayEditor({ create: true })}
      title="Double-click empty space to add text here"
    >
      {markers.map((t) => (
        <div key={`tx-grid-${t}`} className="absolute top-0 bottom-0 w-px bg-zinc-700/15" style={{ left: timeToX(t) }} />
      ))}
      {overlays.map((o) => {
        const left = timeToX(o.start_time);
        const width = Math.max(8, timeToX(o.end_time) - left);
        const isSel = selected === o.id;
        const live = currentTime >= o.start_time && currentTime <= o.end_time;
        return (
          <div
            key={o.id}
            onPointerDown={drag(o, 'move')}
            onClick={(e) => {
              e.stopPropagation();
              setSelected(o.id);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              openOverlayEditor({ id: o.id });
            }}
            className={`group/ov absolute top-1.5 rounded-lg cursor-grab active:cursor-grabbing select-none touch-none overflow-hidden transition-shadow ${
              isSel ? 'ring-2 ring-violet-300 z-20' : 'hover:brightness-110 z-10'
            }`}
            style={{
              left,
              width,
              height: height - 12,
              background: 'linear-gradient(135deg, rgba(124,58,237,0.85), rgba(109,40,217,0.75))',
              border: `1px solid ${live ? 'rgba(221,214,254,0.9)' : 'rgba(196,181,253,0.45)'}`,
            }}
            title={`${o.text}\n${o.start_time.toFixed(2)}s → ${o.end_time.toFixed(2)}s · ${o.animation}${o.exit_animation && o.exit_animation !== 'none' ? ` / ${o.exit_animation}` : ''}\nDrag to move · drag an edge to resize · double-click to edit · Delete to remove`}
          >
            {/* resize handles */}
            <div
              onPointerDown={drag(o, 'start')}
              className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/40 z-10"
            />
            <div
              onPointerDown={drag(o, 'end')}
              className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/40 z-10"
            />
            {width > 28 && (
              <div className="flex h-full items-center gap-1 px-2.5 pointer-events-none">
                <Type className="w-3 h-3 shrink-0 text-violet-100" />
                <span className="truncate font-khmer text-[10px] font-semibold text-white">{o.text}</span>
              </div>
            )}
            {width > 44 && (
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(o);
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded bg-black/50 p-0.5 text-violet-100 opacity-0 group-hover/ov:opacity-100 hover:bg-red-600 z-20"
                title="Delete (or select it and press Delete)"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
