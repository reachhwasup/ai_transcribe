import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Flame, ImageIcon, Info, Loader2, Upload } from 'lucide-react';
import { saveProjectSetting } from '../../utils/projectSettings';

/**
 * The project's logo / watermark. Shown live on the player, placed by the same rules as the
 * export (video_service.py: logo width = scale % of the frame, 3% margins, custom = top-left
 * corner at x/y %), and applied automatically to every export while it is on.
 */
export interface LogoSettings {
  enabled: boolean;
  url: string;
  position: 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right' | 'center' | 'custom';
  scale_pct: number;
  opacity: number;
  x_pct: number;
  y_pct: number;
  /** timeline seconds; null = from the start / until the end */
  start?: number | null;
  end?: number | null;
}

/** Fired whenever logo settings are saved, so the player, timeline and export stay in step. */
export const LOGO_SETTINGS_CHANGED = 'logo-settings-changed';
/** Ask the player to open the Logo panel (a double-click on the timeline's logo track). */
export const OPEN_LOGO_PANEL = 'open-logo-panel';

export const DEFAULT_LOGO: LogoSettings = {
  enabled: false, url: '', position: 'top_right', scale_pct: 15, opacity: 1, x_pct: 80, y_pct: 5,
};

export const logoStorageKey = (projectId: string) => `meatika_logo_settings_${projectId}`;

export function loadLogoSettings(projectId: string): LogoSettings {
  try {
    const raw = localStorage.getItem(logoStorageKey(projectId));
    if (raw) return { ...DEFAULT_LOGO, ...JSON.parse(raw) };
  } catch {
    /* unavailable or corrupt: start fresh */
  }
  return { ...DEFAULT_LOGO };
}

export function saveLogoSettings(projectId: string, s: LogoSettings) {
  try {
    localStorage.setItem(logoStorageKey(projectId), JSON.stringify(s));
  } catch {
    /* private mode — it still works for this session */
  }
  saveProjectSetting(projectId, 'logo', s);
  window.dispatchEvent(new CustomEvent(LOGO_SETTINGS_CHANGED, { detail: { projectId } }));
}

/** Top-left of the logo in frame pixels, exactly as the export places it. */
function logoTopLeft(s: LogoSettings, W: number, H: number, lw: number, lh: number) {
  const padX = W * 0.03;
  const padY = H * 0.03;
  switch (s.position) {
    case 'top_left': return { x: padX, y: padY };
    case 'top_right': return { x: W - lw - padX, y: padY };
    case 'bottom_left': return { x: padX, y: H - lh - padY };
    case 'bottom_right': return { x: W - lw - padX, y: H - lh - padY };
    case 'center': return { x: (W - lw) / 2, y: (H - lh) / 2 };
    default: return { x: (W * s.x_pct) / 100, y: (H * s.y_pct) / 100 };
  }
}

export function LogoLayer({
  settings,
  W,
  H,
  currentTime,
  onChange,
  onCommit,
}: {
  settings: LogoSettings;
  W: number;
  H: number;
  currentTime: number;
  onChange: (patch: Partial<LogoSettings>) => void;
  onCommit: () => void;
}) {
  const [aspect, setAspect] = useState(1);
  if (!settings.enabled || !settings.url || !W || !H) return null;
  if ((settings.start != null && currentTime < settings.start) || (settings.end != null && currentTime > settings.end)) return null;
  const lw = Math.max(12, (W * Math.max(3, Math.min(80, settings.scale_pct))) / 100);
  const lh = lw / aspect;
  const { x, y } = logoTopLeft(settings, W, H, lw, lh);

  // Dragging switches to a custom spot, stored as the top-left corner in % — the export's unit
  const onPointerDown = (e: ReactPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = x;
    const oy = y;
    const move = (ev: PointerEvent) => {
      const nx = Math.max(0, Math.min(W - lw, ox + ev.clientX - sx));
      const ny = Math.max(0, Math.min(H - lh, oy + ev.clientY - sy));
      onChange({
        position: 'custom',
        x_pct: Math.round((nx / W) * 1000) / 10,
        y_pct: Math.round((ny / H) * 1000) / 10,
      });
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
    <img
      src={settings.url}
      alt="Logo"
      draggable={false}
      onLoad={(e) => {
        const im = e.currentTarget;
        if (im.naturalWidth && im.naturalHeight) setAspect(im.naturalWidth / im.naturalHeight);
      }}
      onPointerDown={onPointerDown}
      onClick={(e) => e.stopPropagation()}
      data-dropdown-container
      title="Drag to move the logo"
      className="absolute z-20 cursor-move touch-none select-none hover:outline hover:outline-1 hover:outline-dashed hover:outline-white/70"
      style={{ left: x, top: y, width: lw, height: lh, opacity: settings.opacity }}
    />
  );
}

const POSITIONS: { id: LogoSettings['position']; label: string }[] = [
  { id: 'top_left', label: '↖ Top left' },
  { id: 'top_right', label: '↗ Top right' },
  { id: 'center', label: '• Centre' },
  { id: 'bottom_left', label: '↙ Bottom left' },
  { id: 'bottom_right', label: '↘ Bottom right' },
  { id: 'custom', label: '✥ Where I dragged it' },
];

export function LogoPanel({
  settings,
  uploading,
  burning,
  error,
  onChange,
  onUpload,
  onBurn,
}: {
  settings: LogoSettings;
  uploading: boolean;
  burning: boolean;
  error: string;
  onChange: (patch: Partial<LogoSettings>) => void;
  onUpload: (file: File) => void;
  onBurn: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const chip = (on: boolean) =>
    `rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${
      on ? 'bg-sky-500/90 text-white' : 'bg-white/5 text-zinc-400 hover:text-white'
    }`;
  return (
    <div className="w-[340px] max-h-[calc(100vh-24px)] overflow-y-auto space-y-3 rounded-xl border border-[var(--s6)] bg-[var(--s3)] p-3 shadow-2xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-bold text-white">
          <ImageIcon className="h-4 w-4 text-sky-300" /> Your logo
        </div>
        {settings.url && (
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-300">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => onChange({ enabled: e.target.checked })}
              className="accent-sky-500"
            />
            Show & export
          </label>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUpload(f);
          e.target.value = '';
        }}
      />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        className="flex w-full items-center gap-3 rounded-lg border border-dashed border-[var(--s6)] bg-[var(--s2)] p-2.5 text-left transition-colors hover:border-sky-400/50"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-black/50">
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
          ) : settings.url ? (
            <img src={settings.url} alt="" className="max-h-full max-w-full object-contain" />
          ) : (
            <Upload className="h-4 w-4 text-zinc-400" />
          )}
        </span>
        <span>
          <span className="block text-xs font-semibold text-zinc-200">
            {uploading ? 'Uploading…' : settings.url ? 'Replace image' : 'Upload a logo'}
          </span>
          <span className="block text-[10px] text-zinc-500">Transparent PNG looks best · JPG, WebP, SVG</span>
        </span>
      </button>

      {settings.url && (
        <>
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Where — or drag it on the video</span>
            <div className="mt-1 grid grid-cols-3 gap-1">
              {POSITIONS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onChange({ position: p.id })}
                  disabled={p.id === 'custom' && settings.position !== 'custom'}
                  className={`${chip(settings.position === p.id)} disabled:opacity-30`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="flex justify-between text-[10.5px] text-zinc-400">
                Size <b className="font-mono">{settings.scale_pct}%</b>
              </span>
              <input type="range" min={4} max={50} value={settings.scale_pct}
                onChange={(e) => onChange({ scale_pct: Number(e.target.value) })}
                className="mt-1 w-full accent-sky-500" />
            </label>
            <label className="block">
              <span className="flex justify-between text-[10.5px] text-zinc-400">
                Opacity <b className="font-mono">{Math.round(settings.opacity * 100)}%</b>
              </span>
              <input type="range" min={0.1} max={1} step={0.05} value={settings.opacity}
                onChange={(e) => onChange({ opacity: Number(e.target.value) })}
                className="mt-1 w-full accent-sky-500" />
            </label>
          </div>
          <div className="flex gap-1">
            {[
              { label: 'Subtle mark', patch: { scale_pct: 10, opacity: 0.55 } },
              { label: 'Clear logo', patch: { scale_pct: 15, opacity: 1 } },
              { label: 'Big brand', patch: { scale_pct: 26, opacity: 0.9 } },
            ].map((p) => (
              <button key={p.label} onClick={() => onChange(p.patch)} className={chip(false)}>
                {p.label}
              </button>
            ))}
          </div>
        </>
      )}

      {error && <p className="text-[11px] text-red-300">{error}</p>}

      <div className="space-y-2 border-t border-white/5 pt-2.5">
        <p className="flex items-start gap-1.5 text-[10.5px] leading-snug text-zinc-400">
          <Info className="mt-px h-3 w-3 shrink-0 text-sky-300" />
          {settings.enabled && settings.url
            ? 'Added automatically to every export. Your source video is not changed.'
            : 'Upload a logo and tick “Show & export” to add it to your exports.'}
        </p>
        {settings.url && (
          <button
            onClick={onBurn}
            disabled={burning}
            title="Permanently re-encode the project video with the logo in it"
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 py-1.5 text-[11px] font-semibold text-zinc-300 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"
          >
            {burning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Flame className="h-3.5 w-3.5 text-orange-300" />}
            {burning ? 'Burning into the video…' : 'Burn into source video (permanent)'}
          </button>
        )}
      </div>
    </div>
  );
}
