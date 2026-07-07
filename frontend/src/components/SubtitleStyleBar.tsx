import { useProjectStore } from '../stores/projectStore';
import { DEFAULT_SUBTITLE_STYLE } from '../types/subtitleStyle';
import { Type, RotateCcw } from 'lucide-react';

/** CapCut-style controls for burned-in subtitle captions.
 *  Live preview shows on the video player; applied when exporting with subtitles. */
export default function SubtitleStyleBar() {
  const { subtitleStyle: s, setSubtitleStyle } = useProjectStore();

  const Swatch = ({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) => (
    <label className="flex items-center gap-1.5 cursor-pointer" title={label}>
      <span className="text-[10px] text-zinc-400 whitespace-nowrap">{label}</span>
      <span className="relative w-6 h-6 rounded border border-zinc-600 overflow-hidden shrink-0">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute -inset-1 w-8 h-8 cursor-pointer"
        />
      </span>
    </label>
  );

  const Slider = ({ label, value, min, max, step, onChange, fmt }: {
    label: string; value: number; min: number; max: number; step: number;
    onChange: (v: number) => void; fmt?: (v: number) => string;
  }) => (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-zinc-400 whitespace-nowrap">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-16 accent-khmer-500" />
      <span className="text-[9px] font-mono text-zinc-500 w-7">{fmt ? fmt(value) : value}</span>
    </div>
  );

  return (
    <div className="flex items-center gap-x-4 gap-y-2 px-4 py-2 border-b border-zinc-800 bg-zinc-900/60 shrink-0 flex-wrap">
      <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-zinc-500">
        <Type className="w-3 h-3" /> Caption Style
      </span>

      <Slider label="Size" value={s.sizePct} min={2.5} max={9} step={0.5}
        onChange={(v) => setSubtitleStyle({ sizePct: v })} fmt={(v) => `${v}%`} />

      <div className="flex items-center gap-1">
        <span className="text-[10px] text-zinc-400 mr-0.5">Pos</span>
        {(['top', 'middle', 'bottom'] as const).map((p) => (
          <button key={p} onClick={() => setSubtitleStyle({ position: p })}
            className={`px-2 py-0.5 rounded text-[10px] capitalize border transition-colors ${
              s.position === p ? 'border-khmer-500 bg-khmer-900/20 text-khmer-300'
                : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
            }`}>{p}</button>
        ))}
      </div>

      <div className="w-px h-5 bg-zinc-700" />

      {/* Text */}
      <Swatch label="Text" value={s.textColor} onChange={(v) => setSubtitleStyle({ textColor: v })} />
      <Swatch label="Outline" value={s.outlineColor} onChange={(v) => setSubtitleStyle({ outlineColor: v })} />
      <Slider label="Width" value={s.outlineWidth} min={0} max={8} step={0.5}
        onChange={(v) => setSubtitleStyle({ outlineWidth: v })} fmt={(v) => `${v}`} />

      <div className="w-px h-5 bg-zinc-700" />

      {/* Box */}
      <Swatch label="Box" value={s.boxColor} onChange={(v) => setSubtitleStyle({ boxColor: v })} />
      <Slider label="Fill" value={s.boxOpacity} min={0} max={1} step={0.05}
        onChange={(v) => setSubtitleStyle({ boxOpacity: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
      <Swatch label="Border" value={s.boxOutlineColor} onChange={(v) => setSubtitleStyle({ boxOutlineColor: v })} />
      <Slider label="W" value={s.boxOutlineWidth} min={0} max={8} step={0.5}
        onChange={(v) => setSubtitleStyle({ boxOutlineWidth: v })} fmt={(v) => `${v}`} />

      <button onClick={() => setSubtitleStyle(DEFAULT_SUBTITLE_STYLE)}
        className="flex items-center gap-1 ml-auto text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
        title="Reset caption style">
        <RotateCcw className="w-3 h-3" /> Reset
      </button>
    </div>
  );
}
