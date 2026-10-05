import { useMemo } from 'react';
import { Loader2, Mic, Music, Trash2, Volume1, Volume2, VolumeX } from 'lucide-react';
import type { BgmCleanLevel } from '../../api/client';

export type StemKind = 'vocals' | 'bgm';

// Full class strings (not interpolated) so Tailwind can see them
const STEM_THEMES = {
  vocals: {
    Icon: Mic,
    shortName: 'Vocals',
    longName: 'Isolated Vocals',
    laneTitle: 'Isolated Vocals (Speech)',
    selectionId: 'vocals-track',
    gridKey: 'v1',
    labelBg: 'bg-blue-950/20',
    iconText: 'text-blue-400',
    nameText: 'text-blue-300',
    volumeBorder: 'border-blue-500/20',
    muteHover: 'hover:bg-blue-900/50',
    sliderAccent: 'accent-blue-400',
    percentText: 'text-blue-300/90',
    laneBg: 'bg-[#0c121e]/50',
    selectedRing: 'ring-2 ring-blue-400 ring-offset-1 ring-offset-zinc-950 shadow-[0_0_15px_rgba(96,165,250,0.4)]',
    selectedBorder: '2px solid #60a5fa',
    border: '1px solid rgba(59, 130, 246, 0.4)',
    gradient: 'linear-gradient(180deg, #1e3a8a 0%, #172554 100%)',
    dots: 'bg-[radial-gradient(#60a5fa_1px,transparent_1px)]',
    laneIcon: 'text-blue-300',
    laneTitleText: 'text-blue-100',
    waveFill: 'fill-blue-300/70',
    bars: ['h-2.5 bg-blue-300', 'h-4 bg-blue-200', 'h-2 bg-blue-300', 'h-3.5 bg-blue-200', 'h-2.5 bg-blue-300'],
  },
  bgm: {
    Icon: Music,
    shortName: 'BGM',
    longName: 'Isolated BGM',
    laneTitle: 'Isolated BGM (Background Music)',
    selectionId: 'bgm-track',
    gridKey: 'b1',
    labelBg: 'bg-amber-950/20',
    iconText: 'text-amber-400',
    nameText: 'text-amber-300',
    volumeBorder: 'border-amber-500/20',
    muteHover: 'hover:bg-amber-900/50',
    sliderAccent: 'accent-amber-400',
    percentText: 'text-amber-300/90',
    laneBg: 'bg-[#1a1205]/50',
    selectedRing: 'ring-2 ring-amber-400 ring-offset-1 ring-offset-zinc-950 shadow-[0_0_15px_rgba(251,191,36,0.4)]',
    selectedBorder: '2px solid #fbbf24',
    border: '1px solid rgba(245, 158, 11, 0.4)',
    gradient: 'linear-gradient(180deg, #78350f 0%, #451a03 100%)',
    dots: 'bg-[radial-gradient(#fbbf24_1px,transparent_1px)]',
    laneIcon: 'text-amber-300',
    laneTitleText: 'text-amber-100',
    waveFill: 'fill-amber-300/70',
    bars: ['h-3.5 bg-amber-300', 'h-2 bg-amber-200', 'h-4.5 bg-amber-300', 'h-2.5 bg-amber-200', 'h-3.5 bg-amber-300'],
  },
} as const;

const confirmRemove = (onRemove?: () => void) => {
  if (confirm('Remove isolated vocals & BGM?')) onRemove?.();
};

interface LabelProps {
  kind: StemKind;
  height: number;
  volume: number;
  muted: boolean;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  onRemove?: () => void;
}

/** Track header in the left sidebar: name, mute toggle, volume slider, remove button. */
export function StemTrackLabel({ kind, height, volume, muted, setVolume, setMuted, onRemove }: LabelProps) {
  const t = STEM_THEMES[kind];
  const pct = Math.round(volume * 100);
  // silent either way: muted, or turned all the way down
  const silent = muted || volume === 0;
  return (
    <div
      className={`flex items-center justify-between gap-1 px-2 border-b border-[var(--s3)] ${silent ? 'bg-zinc-900/60' : t.labelBg} group`}
      style={{ height }}
    >
      <span className={`flex items-center gap-1.5 min-w-0 transition-opacity ${silent ? 'opacity-40 grayscale' : ''}`}>
        <t.Icon className={`w-3 h-3 ${t.iconText} shrink-0`} />
        <span className={`text-[11px] font-semibold ${t.nameText}`}>{t.shortName}</span>
      </span>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => setMuted(!muted)}
          className={`p-1 rounded ${t.muteHover} text-zinc-400 hover:text-white transition-colors`}
          title={muted ? `Unmute ${t.longName}` : `Mute ${t.longName} (now ${pct}%)`}
        >
          {muted || volume === 0 ? (
            <VolumeX className="w-3 h-3 text-red-400" />
          ) : volume < 0.5 ? (
            <Volume1 className={`w-3 h-3 ${t.iconText}`} />
          ) : (
            <Volume2 className={`w-3 h-3 ${t.iconText}`} />
          )}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={muted ? 0 : volume}
          onChange={(e) => {
            const v = Number(e.target.value);
            setVolume(v);
            if (muted && v > 0) setMuted(false);
          }}
          className={`w-12 h-1 bg-zinc-700 ${t.sliderAccent} rounded-lg cursor-pointer`}
          title={`${t.shortName} volume: ${pct}%`}
        />
        <button
          onClick={() => confirmRemove(onRemove)}
          className="p-1 rounded hover:bg-red-900/40 text-zinc-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
          title="Remove isolated audio"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}


/** Mirrored waveform as an SVG path; the viewBox stretches it to whatever width the lane has. */
function waveformPath(peaks: number[]): string {
  if (!peaks.length) return '';
  const top = peaks.map((p, i) => `${i},${50 - Math.max(1, p * 47)}`);
  const bottom = peaks.map((p, i) => `${i},${50 + Math.max(1, p * 47)}`).reverse();
  return `M${top.join('L')}L${bottom.join('L')}Z`;
}

interface LaneProps {
  kind: StemKind;
  peaks?: number[];
  height: number;
  width: number;
  markers: number[];
  timeToX: (t: number) => number;
  muted: boolean;
  selectedClipId: string | null;
  onSelect: (selectionId: string) => void;
  onRemove?: () => void;
  /** BGM only: how much leftover dialogue is removed, and a way to change it */
  cleanLevel?: BgmCleanLevel;
  onCleanLevel?: (level: BgmCleanLevel) => void;
  cleaning?: BgmCleanLevel | null;
  /** BGM only: sound effects Demucs put under vocals are added back */
  keepEffects?: boolean;
  onKeepEffects?: (on: boolean) => void;
  effectsBusy?: boolean;
}

const CLEAN_LEVELS: { value: BgmCleanLevel; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'The BGM exactly as separated' },
  { value: 'light', label: 'Light', hint: 'Removes most leftover dialogue, keeps the music full' },
  { value: 'strong', label: 'Strong', hint: 'Stronger cleanup in detected speech regions; music may dip' },
  { value: 'max', label: 'Max', hint: 'Also targets voices missed by speech detection. Disables sound-effect restoration; may soften music and effects. Reversible.' },
];

/** Full-length clip bar for a separated stem in the scrollable timeline area. */
export function StemTrackLane({ kind, peaks, height, width, markers, timeToX, muted, selectedClipId, onSelect, onRemove, cleanLevel, onCleanLevel, cleaning, keepEffects, onKeepEffects, effectsBusy }: LaneProps) {
  const t = STEM_THEMES[kind];
  const selected = selectedClipId === t.selectionId;
  const path = useMemo(() => waveformPath(peaks || []), [peaks]);
  return (
    <div className={`relative border-b border-[var(--s3)] ${t.laneBg}`} style={{ height }}>
      {markers.map((m) => (
        <div
          key={`${t.gridKey}-grid-${m}`}
          className="absolute top-0 bottom-0 w-px bg-zinc-700/15"
          style={{ left: timeToX(m) }}
        />
      ))}

      <div
        onClick={(e) => {
          e.stopPropagation();
          onSelect(t.selectionId);
        }}
        className={`group absolute top-1 rounded-lg overflow-hidden cursor-pointer transition-all shadow-sm select-none ${
          muted ? 'opacity-35 grayscale' : 'opacity-100'
        } ${selected ? t.selectedRing : 'hover:brightness-110'}`}
        style={{
          left: 0,
          width,
          height: height - 8,
          border: selected ? t.selectedBorder : t.border,
          background: t.gradient,
        }}
      >
        {/* Real waveform of this stem (falls back to a flat bar until the peaks load) */}
        {path ? (
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none"
            viewBox={`0 0 ${(peaks || []).length} 100`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d={path} className={t.waveFill} />
          </svg>
        ) : (
          <div className={`absolute inset-0 opacity-30 ${t.dots} [background-size:6px_6px] pointer-events-none`} />
        )}
        <div className="relative px-2.5 flex items-center h-full z-10 pointer-events-none">
          <span className={`flex items-center gap-1.5 min-w-0 px-1.5 py-0.5 rounded bg-black/45 backdrop-blur-[1px]`}>
            <t.Icon className={`w-3 h-3 ${t.laneIcon} shrink-0`} />
            <span className={`text-[10px] font-semibold ${t.laneTitleText} truncate`}>
              {t.laneTitle}{muted && ' · Muted'}
            </span>
          </span>
          {onCleanLevel && (
            // Source dialogue left in the music is heard under the dub; this removes it
            <span
              className="ml-2 flex items-center gap-1 px-1 py-0.5 rounded bg-black/55 pointer-events-auto"
              onClick={(e) => e.stopPropagation()}
              title="Remove the original dialogue that leaked into the BGM, so it isn't heard under the dub"
            >
              <span className="text-[9px] text-amber-200/80 pl-0.5 pr-0.5 whitespace-nowrap">Dialogue removal</span>
              {CLEAN_LEVELS.map(({ value, label, hint }) => {
                const on = (cleaning ?? cleanLevel ?? 'off') === value;
                return (
                  <button
                    key={value}
                    onClick={() => onCleanLevel(value)}
                    disabled={!!cleaning || !!effectsBusy}
                    aria-pressed={on}
                    title={hint}
                    className={`flex items-center gap-1 px-1.5 py-px rounded text-[9px] font-semibold transition-colors disabled:cursor-wait ${
                      on ? 'bg-amber-400 text-black' : 'text-amber-100/80 hover:bg-white/10'
                    }`}
                  >
                    {cleaning === value && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                    {label}
                  </button>
                );
              })}
            </span>
          )}
          {onKeepEffects && (
            // Demucs files door slams, hits and whooshes under "vocals"; this puts them back
            <button
              onClick={(e) => {
                e.stopPropagation();
                onKeepEffects(!keepEffects);
              }}
              disabled={!!effectsBusy || !!cleaning || cleanLevel === 'max'}
              title={cleanLevel === 'max' ? 'Unavailable with Max cleanup to avoid restoring missed vocals. Choose Light or Strong to restore effects.' : 'Restore effects from the vocal track. Speech missed by detection may also return.'}
              className={`ml-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/55 text-[9px] font-semibold pointer-events-auto disabled:cursor-wait ${
                keepEffects ? 'text-amber-200' : 'text-amber-100/50 hover:text-amber-100'
              }`}
            >
              {effectsBusy ? (
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
              ) : (
                <span className={`inline-block h-2.5 w-2.5 rounded-sm border ${keepEffects ? 'bg-amber-400 border-amber-400' : 'border-amber-200/60'}`} />
              )}
              {cleanLevel === 'max' ? 'Effects restore off (Max)' : 'Keep sound effects'}
            </button>
          )}
        </div>

        {/* Delete button (on selection or hover) */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            confirmRemove(onRemove);
          }}
          className={`absolute top-1 right-1 p-1 rounded-md bg-red-950/90 hover:bg-red-800 text-red-200 border border-red-700/60 transition-opacity z-30 shadow cursor-pointer ${
            selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          title="Delete / Remove Isolated Audio (Delete/Backspace key)"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
