import { useProjectStore } from '../stores/projectStore';
import { Type } from 'lucide-react';

/** Compact controls for burned-in subtitle style (size + position).
 *  Live preview shows on the video player; applied when exporting with subtitles. */
export default function SubtitleStyleBar() {
  const { subtitleStyle, setSubtitleStyle } = useProjectStore();

  return (
    <div className="flex items-center gap-5 px-4 py-2 border-b border-zinc-800 bg-zinc-900/60 shrink-0 flex-wrap">
      <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-zinc-500">
        <Type className="w-3 h-3" /> Subtitle Style
      </span>

      <div className="flex items-center gap-2">
        <label className="text-xs text-zinc-400">Size</label>
        <input
          type="range"
          min={2.5}
          max={7}
          step={0.5}
          value={subtitleStyle.sizePct}
          onChange={(e) => setSubtitleStyle({ sizePct: Number(e.target.value) })}
          className="w-32 accent-khmer-500"
        />
        <span className="text-[10px] font-mono text-zinc-500 w-9">{subtitleStyle.sizePct}%</span>
      </div>

      <div className="flex items-center gap-1">
        <label className="text-xs text-zinc-400 mr-1">Position</label>
        {(['top', 'middle', 'bottom'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setSubtitleStyle({ position: p })}
            className={`px-2.5 py-1 rounded text-xs capitalize border transition-colors ${
              subtitleStyle.position === p
                ? 'border-khmer-500 bg-khmer-900/20 text-khmer-300'
                : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
            }`}
          >
            {p}
          </button>
        ))}
      </div>

      <span className="text-[10px] text-zinc-600 ml-auto">
        Live preview on the video · burned into exports with subtitles
      </span>
    </div>
  );
}
