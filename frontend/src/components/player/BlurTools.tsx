import { type PointerEvent as ReactPointerEvent } from 'react';
import { Clock, Eraser, Eye, EyeOff, Flame, Info, Loader2, Plus, Trash2 } from 'lucide-react';

/**
 * Blur boxes: areas of the ORIGINAL video to hide — a burned-in subtitle strip, another
 * channel's logo. Positions are percentages of the video picture itself (not the letterboxed
 * frame around it), which is what the export and "Burn" both measure against.
 */
export interface BlurShape {
  id: string;
  name: string;
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Blur px (or mosaic block px) on a 720-high frame — the same unit the export scales */
  blurRadius: number;
  /** tint darkness 0-1, drawn as black at 70% of this */
  opacity: number;
  borderRadius: number;
  style?: 'blur' | 'pixelate' | 'solid';
  color?: string;
  /** timeline seconds; missing = the whole video */
  start?: number | null;
  end?: number | null;
}

export const blurStorageKey = (projectId: string) => `meatika_blur_shapes_${projectId}`;

/** What the export and the burn endpoint expect for the enabled boxes. */
export function blurAreasForExport(shapes: BlurShape[]) {
  return shapes
    .filter((s) => s.enabled)
    .map((s) => ({
      x_pct: s.x,
      y_pct: s.y,
      width_pct: s.width,
      height_pct: s.height,
      style: s.style || 'blur',
      strength: s.blurRadius,
      tint: s.style === 'solid' ? 0 : s.opacity,
      color: s.color || '#000000',
      start: s.start ?? null,
      end: s.end ?? null,
    }));
}

const QUICK: { label: string; hint: string; shape: Partial<BlurShape> }[] = [
  { label: 'Subtitle strip', hint: 'Old burned-in captions along the bottom', shape: { name: 'Subtitles', x: 0, y: 80, width: 100, height: 15 } },
  { label: 'Top-left logo', hint: 'A channel logo in the top-left corner', shape: { name: 'Top-left logo', x: 3, y: 3, width: 22, height: 9 } },
  { label: 'Top-right logo', hint: 'A channel logo in the top-right corner', shape: { name: 'Top-right logo', x: 75, y: 3, width: 22, height: 9 } },
  { label: 'Bottom-right', hint: 'A watermark in the bottom-right corner', shape: { name: 'Bottom-right mark', x: 72, y: 86, width: 25, height: 10 } },
  { label: 'Centre box', hint: 'Anywhere — then drag it into place', shape: { name: 'Box', x: 35, y: 40, width: 30, height: 20 } },
];

export function newBlurShape(count: number, patch: Partial<BlurShape> = {}): BlurShape {
  return {
    id: `blur-${Date.now()}-${Math.round(Math.random() * 1e4)}`,
    name: `Box ${count + 1}`,
    enabled: true,
    x: 35, y: 40, width: 30, height: 20,
    blurRadius: 18,
    opacity: 0.3,
    borderRadius: 0,
    style: 'blur',
    color: '#000000',
    start: null,
    end: null,
    ...patch,
  };
}

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

// ---------------------------------------------------------------------------------------
// On-video layer: shows each enabled box as it will render, drag to move, corners to resize
// ---------------------------------------------------------------------------------------

export function BlurLayer({
  shapes,
  activeId,
  currentTime,
  pictureHeight,
  onSelect,
  onChange,
  onCommit,
}: {
  shapes: BlurShape[];
  activeId: string;
  currentTime: number;
  /** height of the video picture on screen, to scale blur px like the export does */
  pictureHeight: number;
  onSelect: (id: string) => void;
  /** live update while dragging */
  onChange: (id: string, patch: Partial<BlurShape>) => void;
  /** drag finished — persist */
  onCommit: () => void;
}) {
  const scale = pictureHeight / 720;

  const drag = (shape: BlurShape, mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') => (e: ReactPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect(shape.id);
    const box = (e.currentTarget as HTMLElement).closest('[data-blur-picture]') as HTMLElement | null;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const o = { x: shape.x, y: shape.y, w: shape.width, h: shape.height };
    const move = (ev: PointerEvent) => {
      const dx = ((ev.clientX - sx) / rect.width) * 100;
      const dy = ((ev.clientY - sy) / rect.height) * 100;
      let { x, y, w, h } = o;
      if (mode === 'move') {
        x = Math.max(0, Math.min(100 - w, o.x + dx));
        y = Math.max(0, Math.min(100 - h, o.y + dy));
      } else {
        if (mode.includes('w')) {
          x = Math.max(0, Math.min(o.x + o.w - 3, o.x + dx));
          w = o.w + (o.x - x);
        } else {
          w = Math.max(3, Math.min(100 - o.x, o.w + dx));
        }
        if (mode.includes('n')) {
          y = Math.max(0, Math.min(o.y + o.h - 2, o.y + dy));
          h = o.h + (o.y - y);
        } else {
          h = Math.max(2, Math.min(100 - o.y, o.h + dy));
        }
      }
      const r = (v: number) => Math.round(v * 10) / 10;
      onChange(shape.id, { x: r(x), y: r(y), width: r(w), height: r(h) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onCommit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <>
      {shapes
        .filter((s) => s.enabled)
        .filter((s) => (s.start == null || currentTime >= s.start) && (s.end == null || currentTime <= s.end))
        .map((shape) => {
          const selected = shape.id === activeId;
          const style = shape.style || 'blur';
          const px = Math.max(1, shape.blurRadius * scale);
          const tint = style === 'solid' ? 0 : shape.opacity * 0.7;
          return (
            <div
              key={shape.id}
              onPointerDown={drag(shape, 'move')}
              onClick={(e) => e.stopPropagation()}
              className={`absolute z-20 group/blur cursor-move select-none touch-none ${
                selected ? 'ring-2 ring-pink-400/90' : 'outline outline-1 outline-dashed outline-white/50 hover:outline-white'
              }`}
              style={{
                left: `${shape.x}%`,
                top: `${shape.y}%`,
                width: `${shape.width}%`,
                height: `${shape.height}%`,
                ...(style === 'solid'
                  ? { background: shape.color || '#000' }
                  : style === 'pixelate'
                  ? {
                      // CSS cannot pixelate what is behind it; a heavy blur under a grid of the
                      // export's block size reads the same at a glance
                      backdropFilter: `blur(${px * 0.8}px)`,
                      WebkitBackdropFilter: `blur(${px * 0.8}px)`,
                      backgroundColor: `rgba(0,0,0,${tint})`,
                      backgroundImage:
                        'linear-gradient(to right, rgba(0,0,0,.18) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,0,0,.18) 1px, transparent 1px)',
                      backgroundSize: `${px}px ${px}px`,
                    }
                  : {
                      backdropFilter: `blur(${px}px)`,
                      WebkitBackdropFilter: `blur(${px}px)`,
                      backgroundColor: `rgba(0,0,0,${tint})`,
                    }),
              }}
            >
              <div
                className={`absolute -top-6 left-0 whitespace-nowrap rounded bg-black/85 px-1.5 py-0.5 text-[10px] text-zinc-200 transition-opacity ${
                  selected ? 'opacity-100' : 'opacity-0 group-hover/blur:opacity-100'
                }`}
              >
                {shape.name}
                {shape.start != null || shape.end != null ? ' · timed' : ''}
              </div>
              {selected &&
                (['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                  <div
                    key={corner}
                    onPointerDown={drag(shape, corner)}
                    className="absolute z-30 h-3 w-3 rounded-sm border border-pink-300 bg-white shadow"
                    style={{
                      [corner.includes('n') ? 'top' : 'bottom']: -6,
                      [corner.includes('w') ? 'left' : 'right']: -6,
                      cursor: corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize',
                    }}
                  />
                ))}
            </div>
          );
        })}
    </>
  );
}

// ---------------------------------------------------------------------------------------
// Panel: add, pick, and tune boxes
// ---------------------------------------------------------------------------------------

export function BlurPanel({
  shapes,
  activeId,
  currentTime,
  burning,
  onSelect,
  onSave,
  onBurn,
}: {
  shapes: BlurShape[];
  activeId: string;
  currentTime: number;
  burning: boolean;
  onSelect: (id: string) => void;
  onSave: (shapes: BlurShape[]) => void;
  onBurn: () => void;
}) {
  const active = shapes.find((s) => s.id === activeId) || null;
  const update = (patch: Partial<BlurShape>) =>
    active && onSave(shapes.map((s) => (s.id === active.id ? { ...s, ...patch } : s)));
  const add = (patch: Partial<BlurShape>) => {
    const s = newBlurShape(shapes.length, patch);
    onSave([...shapes, s]);
    onSelect(s.id);
  };
  const remove = (id: string) => {
    const rest = shapes.filter((s) => s.id !== id);
    onSave(rest);
    if (id === activeId) onSelect(rest[0]?.id || '');
  };
  const enabledCount = shapes.filter((s) => s.enabled).length;
  const style = active?.style || 'blur';
  const chip = (on: boolean) =>
    `rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
      on ? 'bg-pink-500/90 text-white' : 'bg-white/5 text-zinc-400 hover:text-white'
    }`;

  return (
    <div className="w-[380px] max-h-[calc(100vh-24px)] overflow-y-auto space-y-3 rounded-xl border border-[var(--s6)] bg-[var(--s3)] p-3 shadow-2xl">
      <div>
        <div className="flex items-center gap-1.5 text-xs font-bold text-white">
          <Eraser className="h-4 w-4 text-pink-300" /> Hide parts of the video
        </div>
        <p className="mt-0.5 text-[10.5px] leading-snug text-zinc-500">
          Cover old subtitles or another channel's logo. Drag a box on the video to move it, pull a corner to resize.
        </p>
      </div>

      <div>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Add a box</span>
        <div className="mt-1 grid grid-cols-3 gap-1">
          {QUICK.map((q) => (
            <button
              key={q.label}
              onClick={() => add(q.shape)}
              title={q.hint}
              className="flex items-center gap-1 rounded-lg border border-[var(--s5)] bg-[var(--s2)] px-2 py-1.5 text-left text-[11px] text-zinc-300 transition-colors hover:border-pink-400/50 hover:text-white"
            >
              <Plus className="h-3 w-3 shrink-0 text-pink-300" />
              <span className="truncate">{q.label}</span>
            </button>
          ))}
        </div>
      </div>

      {shapes.length > 0 && (
        <div className="max-h-32 space-y-1 overflow-y-auto pr-0.5">
          {shapes.map((s) => (
            <div
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-xs transition-colors ${
                s.id === activeId ? 'border-pink-400/40 bg-pink-500/10 text-white' : 'border-transparent bg-white/[0.03] text-zinc-300 hover:bg-white/5'
              }`}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSave(shapes.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)));
                }}
                className={s.enabled ? 'text-pink-300' : 'text-zinc-600'}
                title={s.enabled ? 'On — hide it' : 'Off — show it'}
              >
                {s.enabled ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              </button>
              <span className="flex-1 truncate">{s.name}</span>
              <span className="text-[10px] text-zinc-500">
                {s.style === 'pixelate' ? 'Mosaic' : s.style === 'solid' ? 'Solid' : 'Blur'}
                {s.start != null || s.end != null ? ' · timed' : ''}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  remove(s.id);
                }}
                className="text-zinc-600 hover:text-red-400"
                title="Delete"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {active && (
        <div className="space-y-2.5 border-t border-white/5 pt-2.5">
          <input
            value={active.name}
            onChange={(e) => update({ name: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
            className="w-full rounded-md border border-transparent bg-transparent px-1 text-xs font-semibold text-white hover:border-white/10 focus:border-pink-400/50 focus:outline-none"
            title="Rename"
          />
          <div className="flex gap-1">
            {(['blur', 'pixelate', 'solid'] as const).map((k) => (
              <button key={k} onClick={() => update({ style: k })} className={chip(style === k)}>
                {k === 'blur' ? 'Blur' : k === 'pixelate' ? 'Mosaic' : 'Solid colour'}
              </button>
            ))}
          </div>

          {style !== 'solid' ? (
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="flex justify-between text-[10.5px] text-zinc-400">
                  {style === 'pixelate' ? 'Block size' : 'Strength'} <b className="font-mono">{active.blurRadius}</b>
                </span>
                <input type="range" min={4} max={50} value={active.blurRadius}
                  onChange={(e) => update({ blurRadius: Number(e.target.value) })}
                  className="mt-1 w-full accent-pink-500" />
              </label>
              <label className="block">
                <span className="flex justify-between text-[10.5px] text-zinc-400">
                  Darken <b className="font-mono">{Math.round(active.opacity * 100)}%</b>
                </span>
                <input type="range" min={0} max={1} step={0.05} value={active.opacity}
                  onChange={(e) => update({ opacity: Number(e.target.value) })}
                  className="mt-1 w-full accent-pink-500" />
              </label>
            </div>
          ) : (
            <label className="flex items-center gap-2 text-[11px] text-zinc-400">
              Colour
              <input type="color" value={active.color || '#000000'} onChange={(e) => update({ color: e.target.value })}
                className="h-7 w-14 cursor-pointer rounded border border-[var(--s5)] bg-transparent" />
              <span className="text-[10px] text-zinc-500">Tip: match the letterbox or a banner behind it</span>
            </label>
          )}

          <div>
            <span className="flex items-center gap-1 text-[10.5px] text-zinc-400">
              <Clock className="h-3 w-3" />
              {active.start == null && active.end == null
                ? 'On for the whole video'
                : `From ${active.start != null ? clock(active.start) : 'the start'} to ${active.end != null ? clock(active.end) : 'the end'}`}
            </span>
            <div className="mt-1 flex flex-wrap gap-1">
              <button onClick={() => update({ start: Number(currentTime.toFixed(2)) })} className={chip(false)}>
                Start at playhead
              </button>
              <button onClick={() => update({ end: Number(currentTime.toFixed(2)) })} className={chip(false)}>
                End at playhead
              </button>
              {(active.start != null || active.end != null) && (
                <button onClick={() => update({ start: null, end: null })} className={chip(false)}>
                  Whole video
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="space-y-2 border-t border-white/5 pt-2.5">
        <p className="flex items-start gap-1.5 text-[10.5px] leading-snug text-zinc-400">
          <Info className="mt-px h-3 w-3 shrink-0 text-pink-300" />
          {enabledCount
            ? `${enabledCount} box${enabledCount === 1 ? '' : 'es'} will be applied automatically when you export. Nothing changes in your source video.`
            : 'Turn a box on and it is applied automatically when you export.'}
        </p>
        <button
          onClick={onBurn}
          disabled={burning || enabledCount === 0}
          title="Permanently re-encode the project video with these boxes. Use this only if you need the cleaned video itself."
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 py-1.5 text-[11px] font-semibold text-zinc-300 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"
        >
          {burning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Flame className="h-3.5 w-3.5 text-orange-300" />}
          {burning ? 'Burning into the video…' : 'Burn into source video (permanent)'}
        </button>
      </div>
    </div>
  );
}
