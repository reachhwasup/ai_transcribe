import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * A tool panel that opens BESIDE the player instead of dropping over the picture — the Blur
 * and Logo tools are used by dragging things on the video, so the video has to stay visible.
 * Goes to the player's left when there is room (over the caption list), else its right, else
 * over the player's top corner as a last resort.
 */
export default function SidePanel({
  anchor,
  width = 390,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  width?: number;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const gap = 8;
      const top = Math.max(8, r.top + 44);
      if (r.left - width - gap >= 8) setPos({ left: r.left - width - gap, top });
      else if (r.right + gap + width <= window.innerWidth - 8) setPos({ left: r.right + gap, top });
      else setPos({ left: Math.max(8, r.right - width - 8), top });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, width]);

  if (!pos) return null;
  // data-dropdown-container: clicks inside must not count as "outside" and close it
  return createPortal(
    <div data-dropdown-container className="fixed z-[90]" style={{ left: pos.left, top: pos.top }}>
      {children}
    </div>,
    document.body,
  );
}
