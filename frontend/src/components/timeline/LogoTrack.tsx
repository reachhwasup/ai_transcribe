import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  loadLogoSettings,
  saveLogoSettings,
  LOGO_SETTINGS_CHANGED,
  OPEN_LOGO_PANEL,
  type LogoSettings,
} from '../player/LogoTools';
import { PROJECT_SETTINGS_SYNCED } from '../../utils/projectSettings';

const MIN_SECONDS = 0.5;

/** The project's logo settings, kept in step with the player's Logo panel. */
export function useLogoSettings(projectId?: string) {
  const [logo, setLogo] = useState<LogoSettings | null>(null);
  useEffect(() => {
    if (!projectId) {
      setLogo(null);
      return;
    }
    const load = () => setLogo(loadLogoSettings(projectId));
    load();
    const onChanged = (e: Event) => (e as CustomEvent).detail?.projectId === projectId && load();
    window.addEventListener(LOGO_SETTINGS_CHANGED, onChanged);
    window.addEventListener(PROJECT_SETTINGS_SYNCED, onChanged);
    return () => {
      window.removeEventListener(LOGO_SETTINGS_CHANGED, onChanged);
      window.removeEventListener(PROJECT_SETTINGS_SYNCED, onChanged);
    };
  }, [projectId]);
  return [logo, setLogo] as const;
}

const openLogoPanel = () => window.dispatchEvent(new CustomEvent(OPEN_LOGO_PANEL));

export function LogoTrackLabel({ height, logo }: { height: number; logo: LogoSettings | null }) {
  const on = !!(logo?.enabled && logo.url);
  return (
    <div
      className="flex items-center justify-between px-2.5 border-b border-[var(--s4)] bg-sky-950/15 hover:bg-[var(--s3)] transition-colors"
      style={{ height }}
    >
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30 font-mono shrink-0">
          LG
        </span>
        <span className="text-[11px] text-zinc-400 truncate">Logo{logo?.url && !on ? ' (off)' : ''}</span>
      </span>
      <button
        onClick={openLogoPanel}
        className="rounded px-1.5 py-0.5 text-[10px] text-sky-300 hover:bg-sky-500/20 hover:text-white shrink-0"
        title="Open the Logo panel"
      >
        {logo?.url ? 'Edit' : '+ Logo'}
      </button>
    </div>
  );
}

/**
 * The logo's time on screen as one clip: drag the middle to move it, an edge to change when it
 * appears or disappears, double-click to open the Logo panel. Spanning the whole video is
 * stored as "no range", so the logo keeps covering it if the edit gets longer.
 */
export function LogoTrackLane({
  projectId,
  logo,
  setLogo,
  height,
  duration,
  timeToX,
  xToSeconds,
  markers,
  selected,
  onSelect,
}: {
  projectId: string;
  logo: LogoSettings | null;
  setLogo: (l: LogoSettings) => void;
  height: number;
  duration: number;
  timeToX: (t: number) => number;
  xToSeconds: (px: number) => number;
  markers: number[];
  selected: boolean;
  onSelect: (on: boolean) => void;
}) {
  const latest = useRef(logo);
  latest.current = logo;
  const has = !!logo?.url;
  const start = logo?.start ?? 0;
  const end = logo?.end ?? duration;
  const whole = logo?.start == null && logo?.end == null;

  const commit = (l: LogoSettings) => {
    // the full length is saved as open-ended
    const s = l.start != null && l.start <= 0.01 ? null : l.start;
    const e = l.end != null && l.end >= duration - 0.01 ? null : l.end;
    saveLogoSettings(projectId, { ...l, start: s, end: e });
  };

  const drag = (mode: 'move' | 'start' | 'end') => (ev: ReactPointerEvent) => {
    if (!logo || ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    onSelect(true);
    const sx = ev.clientX;
    const s0 = start;
    const e0 = end;
    const len = e0 - s0;
    let moved = false;
    const move = (m: PointerEvent) => {
      const dt = xToSeconds(m.clientX - sx);
      if (Math.abs(m.clientX - sx) > 2) moved = true;
      let a = s0;
      let b = e0;
      if (mode === 'move') {
        a = Math.max(0, Math.min(duration - len, s0 + dt));
        b = a + len;
      } else if (mode === 'start') {
        a = Math.max(0, Math.min(e0 - MIN_SECONDS, s0 + dt));
      } else {
        b = Math.max(s0 + MIN_SECONDS, Math.min(duration, e0 + dt));
      }
      const r = (v: number) => Math.round(v * 100) / 100;
      setLogo({ ...latest.current!, start: r(a), end: r(b) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved && latest.current) commit(latest.current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const left = timeToX(start);
  const width = Math.max(10, timeToX(end) - left);

  return (
    <div
      className="relative border-b border-zinc-700/30 bg-sky-950/10"
      style={{ height }}
      onClick={(e) => e.target === e.currentTarget && onSelect(false)}
      onDoubleClick={(e) => e.target === e.currentTarget && openLogoPanel()}
    >
      {markers.map((t) => (
        <div key={`lg-grid-${t}`} className="absolute top-0 bottom-0 w-px bg-zinc-700/15" style={{ left: timeToX(t) }} />
      ))}
      {!has ? (
        <button
          onClick={openLogoPanel}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-sky-300/60 hover:text-sky-200"
        >
          No logo yet — click to add one
        </button>
      ) : (
        <div
          onPointerDown={drag('move')}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => {
            e.stopPropagation();
            openLogoPanel();
          }}
          className={`group/lg absolute top-1.5 rounded-lg cursor-grab active:cursor-grabbing select-none touch-none overflow-hidden ${
            logo!.enabled ? '' : 'opacity-40 grayscale'
          } ${selected ? 'ring-2 ring-sky-300 z-20' : ''}`}
          style={{
            left,
            width,
            height: height - 12,
            background: 'linear-gradient(135deg, rgba(14,165,233,0.8), rgba(2,132,199,0.7))',
            border: '1px solid rgba(186,230,253,0.5)',
          }}
          title={`Logo ${whole ? 'for the whole video' : `${start.toFixed(2)}s → ${end.toFixed(2)}s`}${logo!.enabled ? '' : ' (switched off)'}\nDrag to move · drag an edge to change when it shows · double-click to edit · Delete to remove it from the video`}
        >
          <div onPointerDown={drag('start')} className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/40 z-10" />
          <div onPointerDown={drag('end')} className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/40 z-10" />
          <div className="flex h-full items-center gap-1.5 px-2.5 pointer-events-none">
            {width > 30 && (
              <img src={logo!.url} alt="" className="h-5 w-auto max-w-[40px] object-contain rounded-sm bg-black/30" />
            )}
            {width > 90 && (
              <span className="truncate text-[10px] font-semibold text-white">
                {logo!.enabled ? (whole ? 'Logo · whole video' : 'Logo') : 'Logo · off'}
              </span>
            )}
          </div>
          {!whole && width > 60 && (
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                commit({ ...logo!, start: null, end: null });
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded bg-black/50 p-0.5 text-sky-100 opacity-0 group-hover/lg:opacity-100 hover:bg-sky-600 z-20"
              title="Show for the whole video"
            >
              <RotateCcw className="w-2.5 h-2.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

