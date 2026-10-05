import { useShallow } from 'zustand/react/shallow';
import { useEffect, useState, type ReactNode } from 'react';
import SubtitleOverlay from './SubtitleOverlay';
import { useProjectStore } from '../stores/projectStore';
import {
  FONT_OPTIONS,
  DEFAULT_SUBTITLE_STYLE,
  SubtitleStyle,
} from '../types/subtitleStyle';
import {
  PRESET_TEMPLATES,
  SAVED_PRESETS_KEY,
  loadSavedPresets,
  styleFromPreset,
  withoutPlacement,
  type Preset,
} from '../utils/captionPresets';
import {
  Type,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Palette,
  Eye,
  EyeOff,
  RotateCcw,
  Check,
  ChevronDown,
  Wand2,
  Plus,
  X,
} from 'lucide-react';

const TEXT_SWATCHES = ['#FFFFFF', '#facc15', '#38bdf8', '#4ade80', '#ec4899', '#a855f7', '#f87171', '#000000'];
const HIGHLIGHT_SWATCHES = ['#facc15', '#38bdf8', '#4ade80', '#ec4899', '#fb923c', '#2563eb', '#ffffff'];

/** A titled group that folds away, so the panel is a short list of headings rather than one
 *  long scroll of every control. */
function Section({ title, summary, open, onToggle, children }: {
  title: string; summary: string; open: boolean; onToggle: () => void; children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[var(--s4)] bg-[var(--s3)]">
      <button onClick={onToggle} aria-expanded={open} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left">
        <span className="text-[11px] font-bold text-white uppercase tracking-wider">{title}</span>
        <span className="flex items-center gap-2 min-w-0">
          {!open && <span className="truncate text-[10px] text-zinc-500">{summary}</span>}
          <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {open && <div className="px-4 pb-4 space-y-3.5">{children}</div>}
    </section>
  );
}

function Slider({ label, value, display, min, max, step, onChange, onReset }: {
  label: string; value: number; display: string; min: number; max: number; step: number;
  onChange: (v: number) => void; onReset?: () => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] text-zinc-400">
        <span>{label}</span>
        <button
          onClick={onReset}
          disabled={!onReset}
          title={onReset ? 'Click to reset' : undefined}
          className="font-mono text-white tabular-nums enabled:hover:text-blue-300"
        >{display}</button>
      </div>
      <input
        type="range" aria-label={label} min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 bg-zinc-800 rounded-lg accent-blue-500 cursor-pointer"
      />
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly (readonly [T, ReactNode])[]; onChange: (v: T) => void;
}) {
  return (
    <div className="space-y-1">
      <span className="text-[10px] text-zinc-400 block">{label}</span>
      <div className="flex gap-1 bg-[var(--s2)] p-0.5 rounded-xl border border-zinc-800 text-[10px]" role="radiogroup" aria-label={label}>
        {options.map(([id, content]) => (
          <button
            key={id} role="radio" aria-checked={value === id} onClick={() => onChange(id)}
            className={`flex-1 py-1.5 flex items-center justify-center rounded-lg transition-colors ${
              value === id ? 'bg-blue-600 text-white font-bold' : 'text-zinc-400 hover:text-white'
            }`}
          >{content}</button>
        ))}
      </div>
    </div>
  );
}

function ColorRow({ label, value, swatches, onChange }: {
  label: string; value: string; swatches: string[]; onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[10px] text-zinc-400">
        <span>{label}</span>
        <span className="font-mono text-white uppercase">{value}</span>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {swatches.map((color) => (
          <button
            key={color} aria-label={`${label} ${color}`} onClick={() => onChange(color)}
            className={`w-6 h-6 rounded-full border transition-all ${
              value.toLowerCase() === color.toLowerCase()
                ? 'ring-2 ring-blue-500 ring-offset-2 ring-offset-[var(--s3)] border-white'
                : 'border-white/20 hover:scale-105'
            }`}
            style={{ backgroundColor: color }}
          />
        ))}
        <label className="w-6 h-6 rounded-full border border-dashed border-zinc-500 flex items-center justify-center cursor-pointer hover:border-white transition-colors relative" title="Pick any colour">
          <Palette className="w-3 h-3 text-zinc-400" />
          <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
        </label>
      </div>
    </div>
  );
}

/** A colour well beside a slider: the pair every "colour + amount" setting needs. */
function ColorAmount({ label, color, onColor, value, display, min, max, step, onChange }: {
  label: string; color: string; onColor: (v: string) => void; value: number; display: string;
  min: number; max: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[10px] text-zinc-400">
        <span>{label}</span>
        <span className="font-mono text-white tabular-nums">{display}</span>
      </div>
      <div className="flex items-center gap-3">
        <label className="w-7 h-7 rounded-lg border border-white/20 cursor-pointer relative shrink-0 shadow-sm" style={{ backgroundColor: color }} title={`${label} colour`}>
          <input type="color" value={color} onChange={(e) => onColor(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
        </label>
        <input
          type="range" aria-label={label} min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="flex-1 h-1.5 bg-zinc-800 rounded-lg accent-blue-500 cursor-pointer"
        />
      </div>
    </div>
  );
}

export default function CaptionPropertiesPanel() {
  const {
    subtitleStyle,
    setSubtitleStyle,
    subtitlesVisible,
    toggleSubtitlesVisible,
    aspectRatio,
    sampleLine,
  } = useProjectStore(useShallow(state => ({
    subtitleStyle: state.subtitleStyle,
    setSubtitleStyle: state.setSubtitleStyle,
    subtitlesVisible: state.subtitlesVisible,
    toggleSubtitlesVisible: state.toggleSubtitlesVisible,
    aspectRatio: state.aspectRatio,
    // one of the project's own captions makes a truer sample than a stock phrase
    sampleLine: state.currentProject?.segments.find((seg) => (seg.text || '').trim().length > 12)?.text || '',
  })));

  const [previewText, setPreviewText] = useState('');
  const [showFontMenu, setShowFontMenu] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({ text: true });
  const toggle = (key: string) => setOpen((o) => ({ ...o, [key]: !o[key] }));
  const [saved, setSaved] = useState<Preset[]>(loadSavedPresets);

  const s = { ...DEFAULT_SUBTITLE_STYLE, ...(subtitleStyle || {}) };
  const sample = previewText || sampleLine || 'សួស្តី នេះជាគំរូអក្សររត់';
  const currentFont = FONT_OPTIONS.find((f) => f.value === s.fontFamily) || FONT_OPTIONS[0];

  const applyPreset = (preset: Partial<SubtitleStyle>) => setSubtitleStyle(styleFromPreset(preset, s));

  const storeSaved = (list: Preset[]) => {
    setSaved(list);
    try { localStorage.setItem(SAVED_PRESETS_KEY, JSON.stringify(list)); } catch { /* storage full or blocked */ }
  };
  const saveCurrent = () => {
    const name = prompt('Name this style', `My style ${saved.length + 1}`)?.trim();
    if (!name) return;
    const { fontSize: _px, ...style } = withoutPlacement(s);
    storeSaved([...saved.filter((p) => p.name !== name), { id: `saved-${Date.now()}`, name, desc: 'Saved style', style }]);
  };

  // The frame the sample is drawn in follows the project, so a vertical video is judged on a
  // vertical frame — caption size is a share of the frame's height.
  const [w, h] = (aspectRatio || '16:9').split(':').map(Number);
  // kept short enough that the sample can stay pinned without crowding out the settings
  // tall enough to judge the text on; a wide frame is limited by the column it sits in
  const frameHeight = w >= h ? 150 : 300;
  const frameWidth = Math.round(frameHeight * (w / h || 16 / 9));

  // A looping clock for the sample, so the word highlight plays in it
  const [sampleT, setSampleT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSampleT((t) => (t + 0.1) % 3.2), 100);
    return () => clearInterval(id);
  }, []);

  const animation = s.animation || 'none';
  const wordHighlight = animation === 'karaoke' || animation === 'badge';
  const shadowName = { none: 'no shadow', soft: 'soft shadow', hard: 'hard shadow', glow: 'glow' }[s.textShadow || 'none'];

  const presetCard = (preset: Preset, onDelete?: () => void) => (
    <div key={preset.id} className="relative group">
      <button
        onClick={() => applyPreset(preset.style)}
        title={preset.desc}
        className="w-full rounded-xl border border-[var(--s5)] bg-[var(--s3)] hover:border-blue-500/60 hover:bg-[var(--s4)] text-left transition-colors overflow-hidden"
      >
        <span
          className="block bg-gradient-to-br from-slate-700 to-slate-900 py-3 px-2 text-center text-sm truncate"
          style={{
            fontFamily: preset.style.fontFamily,
            color: preset.style.textColor,
            fontWeight: preset.style.fontWeight === '900' ? 900 : preset.style.fontWeight,
            textTransform: preset.style.textTransform,
            letterSpacing: preset.style.letterSpacing,
            WebkitTextStroke: preset.style.outlineWidth ? `${Math.min(1.2, preset.style.outlineWidth / 3)}px ${preset.style.outlineColor || '#000'}` : undefined,
            paintOrder: 'stroke fill',
          }}
        >
          <span
            className="px-2 py-0.5"
            style={{
              backgroundColor: preset.style.boxOpacity ? `${preset.style.boxColor || '#000000'}${Math.round((preset.style.boxOpacity || 0) * 255).toString(16).padStart(2, '0')}` : undefined,
              borderRadius: Math.min(preset.style.borderRadius ?? 6, 12),
            }}
          >អក្សររត់ Aa</span>
        </span>
        <span className="block px-2.5 py-1.5">
          <span className="block text-[11px] font-bold text-white truncate">{preset.name}</span>
          <span className="block text-[10px] text-zinc-500 truncate">{preset.desc}</span>
        </span>
      </button>
      {onDelete && (
        <button
          onClick={onDelete}
          aria-label={`Delete saved style ${preset.name}`}
          className="absolute top-1 right-1 p-1 rounded-md bg-black/60 text-zinc-300 hover:text-red-300 opacity-0 group-hover:opacity-100 focus:opacity-100"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );

  return (
    // Wide enough, the sample sits in its own column beside the settings and stays in view;
    // narrower, it sits on top and the settings scroll under it.
    <div className="h-full flex flex-col xl:flex-row bg-[var(--s2)] text-[#e1e3e6] overflow-y-auto xl:overflow-hidden select-none font-sans">
      <div className="sticky top-0 xl:static z-20 bg-[var(--s2)] border-b xl:border-b-0 xl:border-r border-[var(--s3)] xl:w-[290px] xl:shrink-0 xl:overflow-y-auto">
        <div className="px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-blue-600 flex items-center justify-center text-white">
              <Type className="w-3.5 h-3.5" />
            </div>
            <div>
              <h2 className="text-xs font-bold text-white tracking-wide">Caption style</h2>
              <p className="text-[10px] text-zinc-500">For every caption in this project</p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => confirm('Reset the caption style to the default?') && setSubtitleStyle({ ...DEFAULT_SUBTITLE_STYLE, highlightStyle: 'color', position: s.position })}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-[var(--s3)] transition-colors"
              aria-label="Reset caption style"
              title="Reset to the default style"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={toggleSubtitlesVisible}
              className={`px-2 py-1 rounded-lg text-[10px] font-bold border flex items-center gap-1 transition-colors ${
                subtitlesVisible
                  ? 'bg-blue-600/20 text-blue-200 border-blue-500/50'
                  : 'bg-[var(--s3)] text-zinc-500 border-zinc-800'
              }`}
              title="Show or hide captions on the video"
            >
              {subtitlesVisible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
              <span>{subtitlesVisible ? 'Shown' : 'Hidden'}</span>
            </button>
          </div>
        </div>

        <div className="px-4 pb-3">
          {/* The real caption component, on a frame shaped like the project's video — the same
              drawing as the player, which in turn matches the export */}
          <div
            className="relative mx-auto overflow-hidden rounded-lg bg-gradient-to-br from-slate-600 via-slate-800 to-black"
            style={{ width: frameWidth, maxWidth: '100%', height: frameHeight }}
            aria-label="Caption style preview"
          >
            <div className="absolute inset-0 flex flex-col justify-end p-2 pointer-events-none">
              <SubtitleOverlay text={sample} style={s} frameHeight={frameHeight} currentTime={sampleT} segmentStart={0} segmentEnd={3} />
            </div>
            <span className="absolute top-1.5 left-2 text-[9px] font-mono text-white/40">{aspectRatio || '16:9'}</span>
          </div>
          <input
            aria-label="Preview text"
            value={previewText}
            onChange={(e) => setPreviewText(e.target.value)}
            maxLength={100}
            className="mt-2 w-full rounded-lg bg-[var(--s3)] border border-[var(--s5)] px-2.5 py-1.5 text-[11px] text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-blue-500"
            placeholder="Type to try your own text…"
          />
          <p className="mt-2 text-[10px] text-zinc-500 leading-relaxed hidden xl:block">
            This sample is drawn the same way as the video and the export. Changes show on the video straight away.
          </p>
        </div>
      </div>

      <div className="p-4 space-y-3 flex-1 min-w-0 xl:overflow-y-auto">
        {/* Presets */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-zinc-300 uppercase tracking-wider flex items-center gap-1.5">
              <Wand2 className="w-3.5 h-3.5 text-blue-400" /> Start from a style
            </span>
            <button
              onClick={saveCurrent}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold text-blue-300 hover:bg-blue-600/15"
              title="Keep the current style to reuse in any project"
            >
              <Plus className="w-3 h-3" /> Save current
            </button>
          </div>
          <div className="grid grid-cols-2 2xl:grid-cols-3 gap-2">
            {saved.map((p) => presetCard(p, () => storeSaved(saved.filter((x) => x.id !== p.id))))}
            {PRESET_TEMPLATES.map((p) => presetCard(p))}
          </div>
          <p className="text-[10px] text-zinc-500">A style changes the look only. Position and alignment stay as you set them.</p>
        </div>

        {/* Text */}
        <Section
          title="Text" open={!!open.text} onToggle={() => toggle('text')}
          summary={`${currentFont.label} · ${s.sizePct.toFixed(1)}%`}
        >
          <div className="space-y-1">
            <span className="text-[10px] text-zinc-400 block">Font</span>
            <div className="relative">
              <button
                onClick={() => setShowFontMenu(!showFontMenu)}
                aria-expanded={showFontMenu}
                className="w-full px-3 py-2 rounded-xl bg-[var(--s2)] border border-[var(--s6)] hover:border-[var(--s8)] text-left text-xs text-white flex items-center justify-between transition-colors"
                style={{ fontFamily: s.fontFamily }}
              >
                <span className="truncate">{currentFont.label} <span className="text-zinc-500">· {currentFont.category}</span></span>
                <ChevronDown className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
              </button>
              {showFontMenu && (
                <div className="absolute top-full left-0 right-0 mt-1.5 bg-[var(--s3)] border border-[var(--s6)] rounded-xl shadow-2xl py-1 z-30 max-h-60 overflow-y-auto">
                  {FONT_OPTIONS.map((f) => (
                    <button
                      key={f.label}
                      onClick={() => { setSubtitleStyle({ fontFamily: f.value }); setShowFontMenu(false); }}
                      className={`w-full px-3.5 py-2 text-left text-xs flex items-center justify-between hover:bg-[var(--s5)] transition-colors ${
                        s.fontFamily === f.value ? 'text-white bg-blue-600/20' : 'text-zinc-200'
                      }`}
                      style={{ fontFamily: f.value }}
                    >
                      <span>{f.label}<span className="text-[10px] text-zinc-500 ml-2">{f.category}</span></span>
                      {s.fontFamily === f.value && <Check className="w-3.5 h-3.5 text-blue-400" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <Slider
            label="Size" value={s.sizePct} display={`${s.sizePct.toFixed(1)}% of frame height`} min={2} max={12} step={0.25}
            onChange={(v) => setSubtitleStyle({ sizePct: v })}
            onReset={() => setSubtitleStyle({ sizePct: DEFAULT_SUBTITLE_STYLE.sizePct })}
          />

          <div className="grid grid-cols-2 gap-3">
            <Segmented
              label="Weight" value={s.fontWeight || 'bold'}
              options={[['normal', 'Regular'], ['bold', 'Bold'], ['900', 'Heavy']] as const}
              onChange={(v) => setSubtitleStyle({ fontWeight: v })}
            />
            <Segmented
              label="Letters" value={s.textTransform === 'uppercase' ? 'uppercase' : 'none'}
              options={[['none', 'As typed'], ['uppercase', 'ALL CAPS']] as const}
              onChange={(v) => setSubtitleStyle({ textTransform: v })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Slider
              label="Letter spacing" value={s.letterSpacing || 0} display={`${s.letterSpacing || 0}px`} min={-1} max={8} step={0.5}
              onChange={(v) => setSubtitleStyle({ letterSpacing: v })}
              onReset={() => setSubtitleStyle({ letterSpacing: 0 })}
            />
            <Slider
              label="Line height" value={s.lineHeight || 1.3} display={`${(s.lineHeight || 1.3).toFixed(2)}×`} min={1} max={2} step={0.05}
              onChange={(v) => setSubtitleStyle({ lineHeight: v })}
              onReset={() => setSubtitleStyle({ lineHeight: 1.3 })}
            />
          </div>
        </Section>

        {/* Colour, outline and shadow */}
        <Section
          title="Colour & outline" open={!!open.colour} onToggle={() => toggle('colour')}
          summary={`${s.textColor.toUpperCase()} · ${s.outlineWidth ? `${s.outlineWidth}px outline` : 'no outline'} · ${shadowName}`}
        >
          <ColorRow label="Text colour" value={s.textColor} swatches={TEXT_SWATCHES} onChange={(v) => setSubtitleStyle({ textColor: v })} />
          <ColorAmount
            label="Outline" color={s.outlineColor} onColor={(v) => setSubtitleStyle({ outlineColor: v })}
            value={s.outlineWidth || 0} display={s.outlineWidth ? `${s.outlineWidth}px` : 'Off'} min={0} max={8} step={0.5}
            onChange={(v) => setSubtitleStyle({ outlineWidth: v })}
          />
          <Segmented
            label="Shadow" value={s.textShadow || 'none'}
            options={[['none', 'None'], ['soft', 'Soft'], ['hard', 'Hard'], ['glow', 'Glow']] as const}
            onChange={(v) => setSubtitleStyle({ textShadow: v })}
          />
        </Section>

        {/* Background box */}
        <Section
          title="Background box" open={!!open.box} onToggle={() => toggle('box')}
          summary={s.boxOpacity ? `${Math.round(s.boxOpacity * 100)}% · ${s.borderRadius ?? 6}px corners` : 'Off'}
        >
          <ColorAmount
            label="Fill" color={s.boxColor} onColor={(v) => setSubtitleStyle({ boxColor: v })}
            value={s.boxOpacity ?? 0.6} display={s.boxOpacity ? `${Math.round(s.boxOpacity * 100)}%` : 'Off'} min={0} max={1} step={0.05}
            onChange={(v) => setSubtitleStyle({ boxOpacity: v })}
          />
          <div className={s.boxOpacity || s.boxOutlineWidth ? 'space-y-3.5' : 'space-y-3.5 opacity-40 pointer-events-none'}>
            <Slider
              label="Corner rounding" value={Math.min(s.borderRadius ?? 6, 40)}
              display={(s.borderRadius ?? 6) >= 40 ? 'Pill' : `${s.borderRadius ?? 6}px`} min={0} max={40} step={1}
              onChange={(v) => setSubtitleStyle({ borderRadius: v >= 40 ? 999 : v })}
              onReset={() => setSubtitleStyle({ borderRadius: 6 })}
            />
          </div>
          <ColorAmount
            label="Border" color={s.boxOutlineColor} onColor={(v) => setSubtitleStyle({ boxOutlineColor: v })}
            value={s.boxOutlineWidth || 0} display={s.boxOutlineWidth ? `${s.boxOutlineWidth}px` : 'Off'} min={0} max={6} step={0.5}
            onChange={(v) => setSubtitleStyle({ boxOutlineWidth: v })}
          />
        </Section>

        {/* Placement */}
        <Section
          title="Placement" open={!!open.place} onToggle={() => toggle('place')}
          summary={`${s.position} · ${s.textAlign || 'center'}`}
        >
          <div className="grid grid-cols-2 gap-3">
            <Segmented
              label="On the screen" value={s.position}
              options={[['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']] as const}
              onChange={(v) => setSubtitleStyle({ position: v })}
            />
            <Segmented
              label="Alignment" value={s.textAlign || 'center'}
              options={[
                ['left', <AlignLeft key="l" className="w-3.5 h-3.5" aria-label="Left" />],
                ['center', <AlignCenter key="c" className="w-3.5 h-3.5" aria-label="Centre" />],
                ['right', <AlignRight key="r" className="w-3.5 h-3.5" aria-label="Right" />],
              ] as const}
              onChange={(v) => setSubtitleStyle({ textAlign: v })}
            />
          </div>
        </Section>

        {/* Word highlight and motion */}
        <Section
          title="Word highlight" open={!!open.motion} onToggle={() => toggle('motion')}
          summary={animation === 'karaoke' ? 'Colour' : animation === 'badge' ? 'Badge' : animation === 'none' ? 'Off' : `${animation} (preview only)`}
        >
          <Segmented
            label="As each word is spoken" value={animation === 'karaoke' || animation === 'badge' ? animation : 'none'}
            options={[['none', 'Off'], ['karaoke', 'Colour the word'], ['badge', 'Badge behind it']] as const}
            onChange={(v) => setSubtitleStyle({ animation: v, highlightStyle: v === 'badge' ? 'badge' : 'color' })}
          />
          {wordHighlight && (
            <ColorRow
              label={animation === 'badge' ? 'Badge colour' : 'Highlight colour'} value={s.activeWordColor || '#facc15'}
              swatches={HIGHLIGHT_SWATCHES} onChange={(v) => setSubtitleStyle({ activeWordColor: v })}
            />
          )}

          {/* These move in the editor's player but are not drawn by the export, which renders
              each caption as a still image (one per word for a highlight). Kept apart and
              labelled so nobody styles a video around an effect that will not be in the file. */}
          <div className="pt-3 border-t border-[var(--s4)] space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-zinc-400">Entrance motion</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 font-semibold">Editor preview only</span>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px]">
              {([['pop', 'Pop'], ['slide', 'Slide'], ['glow', 'Pulse'], ['wave', 'Wave']] as const).map(([id, name]) => (
                <button
                  key={id}
                  aria-pressed={animation === id}
                  onClick={() => setSubtitleStyle({ animation: animation === id ? 'none' : id })}
                  className={`py-1.5 rounded-lg border transition-colors ${
                    animation === id ? 'bg-amber-500/15 border-amber-500/50 text-amber-100 font-bold' : 'bg-[var(--s2)] border-zinc-800 text-zinc-400 hover:text-white'
                  }`}
                >{name}</button>
              ))}
            </div>
            <p className="text-[10px] text-zinc-500 leading-relaxed">
              These play in the editor but are not in the exported video. The word highlight above is.
            </p>
          </div>
        </Section>
      </div>
    </div>
  );
}
