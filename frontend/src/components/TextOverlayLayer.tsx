import { useEffect, useState } from 'react';
import { fetchTextOverlays, TEXT_OVERLAYS_CHANGED, VERSION_RESTORED_EVENT, type TextOverlay } from '../api/client';
import OverlayText from './OverlayText';

/** Draws the saved text overlays over the player, so they can be seen without exporting.
 *
 * Sizes and positions are percentages of the frame, exactly as the export uses them, so what
 * shows here lines up with what gets rendered.
 */
export default function TextOverlayLayer({
  projectId,
  currentTime,
  frameWidth,
  frameHeight,
  reloadKey = 0,
}: {
  projectId?: string;
  currentTime: number;
  frameWidth: number;
  frameHeight: number;
  /** Bump to re-read after the overlay editor saves. */
  reloadKey?: number;
}) {
  const [overlays, setOverlays] = useState<TextOverlay[]>([]);
  // Restoring a version rewrites the overlays behind this component's back
  const [restoredTick, setRestoredTick] = useState(0);
  useEffect(() => {
    const bump = () => setRestoredTick((n) => n + 1);
    window.addEventListener(VERSION_RESTORED_EVENT, bump);
    // the timeline's text track saves moves and resizes itself
    window.addEventListener(TEXT_OVERLAYS_CHANGED, bump);
    return () => {
      window.removeEventListener(VERSION_RESTORED_EVENT, bump);
      window.removeEventListener(TEXT_OVERLAYS_CHANGED, bump);
    };
  }, []);

  useEffect(() => {
    if (!projectId) {
      setOverlays([]);
      return;
    }
    let cancelled = false;
    fetchTextOverlays(projectId)
      .then((list) => !cancelled && setOverlays(list))
      .catch(() => !cancelled && setOverlays([]));
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey, restoredTick]);

  const showing = overlays.filter(
    (o) => currentTime >= o.start_time && currentTime <= o.end_time,
  );
  if (!showing.length) return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {showing.map((o) => (
        <OverlayText key={o.id} overlay={o} t={currentTime} W={frameWidth} H={frameHeight} />
      ))}
    </div>
  );
}
