import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Render outside the editor's clipped and contained scrolling panels. */
export default function VoiceMenuPopover({ anchor, onClose, children }: {
  anchor: HTMLButtonElement; onClose: () => void; children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 288 });
  useLayoutEffect(() => {
    const place = () => {
      if (!anchor.isConnected) { close.current(); return; }
      const rect = anchor.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) { close.current(); return; }
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const openAbove = below < 240 && above > below;
      const maxHeight = Math.max(40, Math.min(288, openAbove ? above : below));
      const height = Math.min(menu.current?.scrollHeight || 288, maxHeight);
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 232)),
        top: Math.max(8, openAbove ? rect.top - height - 6 : rect.bottom + 6),
        maxHeight,
      });
    };
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) close.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); anchor.focus(); }
    };
    place();
    const observer = new ResizeObserver(place);
    if (menu.current) observer.observe(menu.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    /** Focus the dialog itself: focusing the first item scrolls the header out of view. */
    if (menu.current) { menu.current.scrollTop = 0; menu.current.focus({ preventScroll: true }); }
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [anchor]);
  return createPortal(<div ref={menu} role="dialog" aria-label="Choose character or saved voice"
    tabIndex={-1} onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}
    style={{ ...position, width: 'min(224px, calc(100vw - 16px))', zIndex: 1000 }}
    className="fixed overflow-y-auto overscroll-contain bg-[var(--s3)] text-zinc-200 border border-[var(--s7)] rounded-xl shadow-2xl p-1 space-y-0.5 outline-none">
    {children}
  </div>, document.body);
}
