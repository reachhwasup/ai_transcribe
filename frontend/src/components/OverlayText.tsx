import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { TextOverlay } from '../api/client';
import { overlayFrame } from '../utils/overlayMotion';

/**
 * One text overlay drawn over a frame of width W × height H (pixels) at time t.
 * Size, outline and padding follow the export's own proportions, and the motion comes from
 * overlayMotion.ts — the same arithmetic as the export — so this is what gets rendered.
 */
export default function OverlayText({
  overlay: o,
  t,
  W,
  H,
  selected = false,
  dimmed = false,
  onPointerDown,
}: {
  overlay: TextOverlay;
  t: number;
  W: number;
  H: number;
  selected?: boolean;
  dimmed?: boolean;
  onPointerDown?: (e: ReactPointerEvent<HTMLSpanElement>) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  // Motion depends on the box's own size (a ticker travels its width, a bounce stops at the
  // edge), so it is measured; offsetWidth ignores the scale transform, as the export does.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (!box || box.w !== w || box.h !== h) setBox({ w, h });
  });

  const px = Math.max(8, (H * o.size_pct) / 100);
  const outline = Math.max(0, o.outline_width) * (H / 720);
  const f = overlayFrame(o, t, W, H, box?.w ?? 0, box?.h ?? 0);

  return (
    <span
      ref={ref}
      onPointerDown={onPointerDown}
      className={`absolute left-0 top-0 whitespace-pre font-khmer leading-tight ${
        onPointerDown ? 'pointer-events-auto cursor-move touch-none' : ''
      } ${selected ? 'outline outline-2 outline-offset-2 outline-violet-400/90' : ''}`}
      style={{
        transform: `translate(${f.x}px, ${f.y}px) scale(${f.scale})`,
        transformOrigin: 'center',
        visibility: box ? 'visible' : 'hidden',
        fontSize: `${px}px`,
        fontWeight: o.bold ? 700 : 400,
        color: o.color,
        opacity: Math.max(0, Math.min(1, f.opacity)) * (dimmed ? 0.45 : 1),
        textAlign: 'center',
        padding: `${Math.max(8 * (H / 720), px / 3)}px`,
        borderRadius: `${px / 6}px`,
        background:
          o.box_opacity > 0
            ? `${o.box_color}${Math.round(o.box_opacity * 255).toString(16).padStart(2, '0')}`
            : 'transparent',
        WebkitTextStroke: outline > 0 ? `${outline}px ${o.outline_color}` : undefined,
        paintOrder: 'stroke fill',
      }}
    >
      {o.text}
    </span>
  );
}
