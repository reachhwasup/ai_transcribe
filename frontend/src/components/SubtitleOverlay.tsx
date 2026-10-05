import React, { useState, useRef, useEffect } from 'react';
import type { SubtitleStyle } from '../types/subtitleStyle';
import { hexToRgba, FONT_OPTIONS, DEFAULT_SUBTITLE_STYLE } from '../types/subtitleStyle';
import {
  Type,
  Bold,
  AlignLeft,
  AlignCenter,
  AlignRight,
  ChevronDown,
  Eye,
  EyeOff,
  Check,
  RotateCcw,
  Minus,
  Plus,
  MoreHorizontal,
  Sliders,
  Trash2,
} from 'lucide-react';

interface Props {
  text: string;
  style: SubtitleStyle;
  frameHeight?: number;
  currentTime?: number;
  segmentStart?: number;
  segmentEnd?: number;
  isSelected?: boolean;
  onSelect?: () => void;
  onChangeStyle?: (newStyle: Partial<SubtitleStyle>) => void;
  onUpdateText?: (newText: string) => void;
  onToggleVisible?: () => void;
  onDeleteSegment?: () => void;
  isSubtitlesVisible?: boolean;
}

export default function SubtitleOverlay({
  text,
  style,
  frameHeight = 360,
  currentTime,
  segmentStart,
  segmentEnd,
  isSelected = false,
  onSelect,
  onChangeStyle,
  onUpdateText,
  onToggleVisible,
  onDeleteSegment,
  isSubtitlesVisible = true,
}: Props) {
  const [showFontDropdown, setShowFontDropdown] = useState(false);
  const [showOtherMenu, setShowOtherMenu] = useState(false);
  const [isEditingText, setIsEditingText] = useState(false);
  const [editText, setEditText] = useState(text);
  const containerRef = useRef<HTMLDivElement>(null);
  const otherMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEditText(text);
  }, [text]);

  // Split words for Karaoke / Highlight Animations
  const words = React.useMemo(() => {
    if (!text) return [];
    const rawTokens = text.trim().split(/\s+/);
    return rawTokens.length > 0 ? rawTokens : [text];
  }, [text]);

  const activeWordIdx = React.useMemo(() => {
    if (words.length <= 1) return 0;
    if (typeof currentTime === 'number' && typeof segmentStart === 'number' && typeof segmentEnd === 'number') {
      const segDur = Math.max(0.1, segmentEnd - segmentStart);
      const elapsed = Math.max(0, currentTime - segmentStart);
      const progress = Math.min(1, Math.max(0, elapsed / segDur));
      return Math.min(words.length - 1, Math.floor(progress * words.length));
    }
    return 0;
  }, [currentTime, segmentStart, segmentEnd, words.length]);

  const posCls =
    style.position === 'top'
      ? 'top-[6%]'
      : style.position === 'middle'
      ? 'top-1/2 -translate-y-1/2'
      : 'bottom-[8%]';

  // Same sizing as the export (caption_render.py): the font is sizePct of the frame height
  // (×0.75, the export's em), and every other pixel value is a "design px" on a 720-high
  // frame scaled by k — so what shows here is what renders, at any player size.
  const k = frameHeight / 720;
  const calcFontSize = Math.max(6, (frameHeight * (style.sizePct || 4.5) * 0.75) / 100);
  const weight = style.fontWeight === '900' ? 900 : style.fontWeight === 'bold' ? 700 : 400;

  const ow = (style.outlineWidth || 0) * k;
  let stroke =
    ow > 0
      ? [
          `${ow}px ${ow}px`,
          `-${ow}px ${ow}px`,
          `${ow}px -${ow}px`,
          `-${ow}px -${ow}px`,
          `${ow}px 0`,
          `-${ow}px 0`,
          `0 ${ow}px`,
          `0 -${ow}px`,
        ]
          .map((o) => `${o} 0 ${style.outlineColor || '#000000'}`)
          .join(', ')
      : undefined;

  // Add custom shadow if selected
  const shadow =
    style.textShadow === 'soft'
      ? `0 ${2 * k}px ${8 * k}px rgba(0,0,0,0.8)`
      : style.textShadow === 'hard'
      ? `${3 * k}px ${3 * k}px 0px rgba(0,0,0,0.95)`
      : style.textShadow === 'glow'
      ? `0 0 ${12 * k}px ${style.textColor || '#38bdf8'}`
      : '';
  if (shadow) stroke = stroke ? `${stroke}, ${shadow}` : shadow;

  const handleFontChange = (fontVal: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    e?.preventDefault();
    onChangeStyle?.({ fontFamily: fontVal });
    setShowFontDropdown(false);
  };

  const handleFontSizeChange = (delta: number, e?: React.MouseEvent) => {
    e?.stopPropagation();
    e?.preventDefault();
    // ± buttons nudge the size by half a percent of the frame
    const pct = Math.max(2, Math.min(12, (style.sizePct || 4.5) + (delta > 0 ? 0.5 : -0.5)));
    onChangeStyle?.({ sizePct: Number(pct.toFixed(2)) });
  };

  const currentFontLabel =
    FONT_OPTIONS.find((f) => f.value === style.fontFamily)?.label || 'Kantumruy Pro';

  return (
    <div
      ref={containerRef}
      className={`absolute left-[4%] right-[4%] ${posCls} select-none z-40 flex flex-col pointer-events-none ${
        style.textAlign === 'left'
          ? 'items-start'
          : style.textAlign === 'right'
          ? 'items-end'
          : 'items-center'
      }`}
    >
      {/* Floating Caption Quick Toolbar (Visible when caption is selected) */}
      {isSelected && onChangeStyle && (
        <div
          className="mb-2 bg-[rgb(var(--s3-rgb)/0.95)] backdrop-blur-md border border-[var(--s6)] rounded-xl shadow-2xl p-1.5 flex items-center gap-1.5 text-xs text-zinc-200 z-50 pointer-events-auto animate-in fade-in slide-in-from-bottom-1 relative"
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Font Family Dropdown */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowFontDropdown(!showFontDropdown);
                setShowOtherMenu(false);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--s4)] hover:bg-[var(--s6)] text-white font-medium text-[11px] transition-colors border border-zinc-700/50"
              title="Change Font Family"
            >
              <Type className="w-3 h-3 text-zinc-400" />
              <span className="truncate max-w-[90px]">{currentFontLabel}</span>
              <ChevronDown className="w-3 h-3 text-zinc-400" />
            </button>

            {showFontDropdown && (
              <div
                className="absolute bottom-full left-0 mb-1.5 w-48 bg-[var(--s3)] border border-[var(--s6)] rounded-xl shadow-2xl py-1 z-50 max-h-56 overflow-y-auto"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="px-2.5 py-1 text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                  Font Family
                </div>
                {FONT_OPTIONS.map((f) => (
                  <button
                    key={f.label}
                    onClick={(e) => handleFontChange(f.value, e)}
                    onMouseDown={(e) => e.stopPropagation()}
                    className={`w-full px-3 py-1.5 text-left text-xs flex items-center justify-between hover:bg-[var(--s5)] transition-colors ${
                      style.fontFamily === f.value ? 'text-zinc-400 font-bold bg-[var(--s5)]' : 'text-zinc-300'
                    }`}
                    style={{ fontFamily: f.value }}
                  >
                    <span>{f.label}</span>
                    {style.fontFamily === f.value && <Check className="w-3 h-3 text-zinc-400" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="w-px h-4 bg-zinc-700/60" />

          {/* Font Size Minus / Plus */}
          <div
            className="flex items-center gap-0.5 bg-[var(--s4)] rounded-lg border border-zinc-700/50 px-1 py-0.5"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={(e) => handleFontSizeChange(-2, e)}
              onMouseDown={(e) => e.stopPropagation()}
              className="p-1 hover:bg-[var(--s6)] rounded text-zinc-400 hover:text-white transition-colors"
              title="Decrease Font Size"
            >
              <Minus className="w-2.5 h-2.5" />
            </button>
            <span className="font-mono text-[11px] font-bold text-white px-1.5 min-w-[28px] text-center">
              {(style.sizePct || 4.5).toFixed(1)}%
            </span>
            <button
              onClick={(e) => handleFontSizeChange(2, e)}
              onMouseDown={(e) => e.stopPropagation()}
              className="p-1 hover:bg-[var(--s6)] rounded text-zinc-400 hover:text-white transition-colors"
              title="Increase Font Size"
            >
              <Plus className="w-2.5 h-2.5" />
            </button>
          </div>

          <div className="w-px h-4 bg-zinc-700/60" />

          {/* Bold Toggle */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onChangeStyle({
                fontWeight: style.fontWeight === 'bold' ? 'normal' : 'bold',
              });
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className={`p-1.5 rounded-lg border transition-colors ${
              style.fontWeight === 'bold'
                ? 'bg-white/10 text-zinc-200 border-white/10'
                : 'bg-[var(--s4)] border-zinc-700/50 text-zinc-400 hover:text-white'
            }`}
            title="Toggle Bold"
          >
            <Bold className="w-3 h-3" />
          </button>

          {/* Text Color Input Swatch */}
          <label
            className="flex items-center gap-1 cursor-pointer bg-[var(--s4)] border border-zinc-700/50 rounded-lg px-1.5 py-1 hover:bg-[var(--s6)] transition-colors"
            title="Text Color"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="w-3 h-3 rounded-full border border-white/40" style={{ backgroundColor: style.textColor || '#FFFFFF' }} />
            <input
              type="color"
              value={style.textColor || '#FFFFFF'}
              onChange={(e) => {
                e.stopPropagation();
                onChangeStyle({ textColor: e.target.value });
              }}
              className="w-0 h-0 opacity-0 absolute pointer-events-none"
            />
          </label>

          {/* Box / Background Color Swatch */}
          <label
            className="flex items-center gap-1 cursor-pointer bg-[var(--s4)] border border-zinc-700/50 rounded-lg px-1.5 py-1 hover:bg-[var(--s6)] transition-colors"
            title="Background Box Color"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="w-3 h-3 rounded border border-white/40" style={{ backgroundColor: style.boxColor || '#000000' }} />
            <input
              type="color"
              value={style.boxColor || '#000000'}
              onChange={(e) => {
                e.stopPropagation();
                onChangeStyle({ boxColor: e.target.value, boxOpacity: style.boxOpacity || 0.6 });
              }}
              className="w-0 h-0 opacity-0 absolute pointer-events-none"
            />
          </label>

          {/* Position Top / Middle / Bottom */}
          <div
            className="flex items-center gap-0.5 bg-[var(--s4)] rounded-lg border border-zinc-700/50 p-0.5"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {(['top', 'middle', 'bottom'] as const).map((p) => (
              <button
                key={p}
                onClick={(e) => {
                  e.stopPropagation();
                  onChangeStyle({ position: p });
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className={`px-1.5 py-0.5 rounded text-[10px] capitalize transition-colors ${
                  style.position === p
                    ? 'bg-white/10 text-white font-bold'
                    : 'text-zinc-400 hover:text-white'
                }`}
                title={`Position: ${p}`}
              >
                {p[0].toUpperCase()}
              </button>
            ))}
          </div>

          <div className="w-px h-4 bg-zinc-700/60" />

          {/* Visibility CC Toggle */}
          {onToggleVisible && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleVisible();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className={`p-1.5 rounded-lg border transition-colors ${
                isSubtitlesVisible
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                  : 'bg-[var(--s4)] text-zinc-500 border-zinc-700/50'
              }`}
              title={isSubtitlesVisible ? 'Hide Caption on Screen' : 'Show Caption on Screen'}
            >
              {isSubtitlesVisible ? <Eye className="w-3 h-3 text-emerald-400" /> : <EyeOff className="w-3 h-3" />}
            </button>
          )}

          {/* Three Dots (...) Button — Opens "Other / Advanced" Menu */}
          <div className="relative" ref={otherMenuRef}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowOtherMenu(!showOtherMenu);
                setShowFontDropdown(false);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className={`p-1.5 rounded-lg border transition-colors ${
                showOtherMenu
                  ? 'bg-blue-600 text-white border-blue-500'
                  : 'bg-[var(--s4)] border-zinc-700/50 text-zinc-300 hover:text-white hover:bg-[var(--s6)]'
              }`}
              title="More Caption Settings (Other)"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>

            {/* "Other" Advanced Settings Popover */}
            {showOtherMenu && (
              <div
                className="absolute bottom-full right-0 mb-2 w-64 bg-[var(--s3)] border border-[var(--s6)] rounded-2xl shadow-2xl p-3 z-50 space-y-3 animate-in fade-in slide-in-from-bottom-2 text-zinc-300 font-sans"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                  <span className="text-[11px] font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                    <Sliders className="w-3.5 h-3.5 text-blue-400" /> Advanced Style
                  </span>
                  <button
                    onClick={() => onChangeStyle(DEFAULT_SUBTITLE_STYLE)}
                    className="text-[10px] text-zinc-400 hover:text-white flex items-center gap-1 transition-colors"
                    title="Reset to default"
                  >
                    <RotateCcw className="w-2.5 h-2.5" /> Reset
                  </button>
                </div>

                {/* Text Alignment */}
                <div className="space-y-1">
                  <span className="text-[10px] text-zinc-400 block font-medium">Text Alignment</span>
                  <div className="grid grid-cols-3 gap-1 bg-[var(--s2)] p-1 rounded-xl border border-zinc-800">
                    {[
                      { id: 'left', icon: AlignLeft, label: 'Left' },
                      { id: 'center', icon: AlignCenter, label: 'Center' },
                      { id: 'right', icon: AlignRight, label: 'Right' },
                    ].map((align) => {
                      const Icon = align.icon;
                      const isActive = (style.textAlign || 'center') === align.id;
                      return (
                        <button
                          key={align.id}
                          onClick={() => onChangeStyle({ textAlign: align.id as any })}
                          className={`py-1 rounded-lg text-xs flex items-center justify-center gap-1 transition-colors ${
                            isActive
                              ? 'bg-blue-600 text-white font-bold'
                              : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                          }`}
                        >
                          <Icon className="w-3 h-3" />
                          <span className="text-[10px]">{align.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Capitalization / Transform */}
                <div className="space-y-1">
                  <span className="text-[10px] text-zinc-400 block font-medium">Capitalization</span>
                  <div className="grid grid-cols-4 gap-1 bg-[var(--s2)] p-1 rounded-xl border border-zinc-800 text-[10px]">
                    {[
                      { id: 'none', label: 'Default' },
                      { id: 'uppercase', label: 'ALL CAPS' },
                      { id: 'lowercase', label: 'lower' },
                      { id: 'capitalize', label: 'Title' },
                    ].map((item) => {
                      const isActive = (style.textTransform || 'none') === item.id;
                      return (
                        <button
                          key={item.id}
                          onClick={() => onChangeStyle({ textTransform: item.id as any })}
                          className={`py-1 rounded-lg transition-colors truncate px-1 text-center ${
                            isActive
                              ? 'bg-white/10 text-white font-bold'
                              : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                          }`}
                        >
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Text Shadow & Glow */}
                <div className="space-y-1">
                  <span className="text-[10px] text-zinc-400 block font-medium">Text Shadow / Glow</span>
                  <div className="grid grid-cols-4 gap-1 bg-[var(--s2)] p-1 rounded-xl border border-zinc-800 text-[10px]">
                    {[
                      { id: 'none', label: 'None' },
                      { id: 'soft', label: 'Soft Blur' },
                      { id: 'hard', label: 'Drop' },
                      { id: 'glow', label: 'Neon' },
                    ].map((item) => {
                      const isActive = (style.textShadow || 'none') === item.id;
                      return (
                        <button
                          key={item.id}
                          onClick={() => onChangeStyle({ textShadow: item.id as any })}
                          className={`py-1 rounded-lg transition-colors truncate px-1 text-center ${
                            isActive
                              ? 'bg-white/10 text-white font-bold'
                              : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                          }`}
                        >
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Letter Spacing */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[10px] text-zinc-400">
                    <span>Letter Spacing</span>
                    <span className="font-mono text-white">{style.letterSpacing || 0}px</span>
                  </div>
                  <input
                    type="range"
                    min={-1}
                    max={6}
                    step={0.5}
                    value={style.letterSpacing || 0}
                    onChange={(e) => onChangeStyle({ letterSpacing: parseFloat(e.target.value) })}
                    className="w-full h-1 bg-zinc-800 rounded accent-blue-500 cursor-pointer"
                  />
                </div>

                {/* Box Corner Radius */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[10px] text-zinc-400">
                    <span>Box Corner Radius</span>
                    <span className="font-mono text-white">{style.borderRadius || 6}px</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 bg-[var(--s2)] p-1 rounded-xl border border-zinc-800 text-[10px]">
                    {[
                      { val: 0, label: '0px' },
                      { val: 6, label: '6px' },
                      { val: 14, label: '14px' },
                      { val: 999, label: 'Pill' },
                    ].map((item) => {
                      const isActive = (style.borderRadius || 6) === item.val;
                      return (
                        <button
                          key={item.label}
                          onClick={() => onChangeStyle({ borderRadius: item.val })}
                          className={`py-1 rounded-lg transition-colors truncate px-1 text-center ${
                            isActive
                              ? 'bg-blue-600 text-white font-bold'
                              : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                          }`}
                        >
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Motion / Animation */}
                <div className="space-y-1">
                  <span className="text-[10px] text-zinc-400 block font-medium">Animation Effect</span>
                  <div className="grid grid-cols-2 gap-1 bg-[var(--s2)] p-1 rounded-xl border border-zinc-800 text-[10px]">
                    {[
                      { id: 'none', label: 'Static (None)' },
                      { id: 'karaoke', label: '🎤 Word Highlight' },
                      { id: 'pop', label: '✨ Pop In Zoom' },
                      { id: 'glow', label: '🌟 Pulse Glow' },
                    ].map((item) => {
                      const isActive = (style.animation || 'none') === item.id;
                      return (
                        <button
                          key={item.id}
                          onClick={() => onChangeStyle({ animation: item.id as any })}
                          className={`py-1.5 rounded-lg transition-colors truncate px-2 text-left ${
                            isActive
                              ? 'bg-emerald-600 text-white font-bold'
                              : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                          }`}
                        >
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Delete Segment */}
                {onDeleteSegment && (
                  <div className="pt-1 border-t border-zinc-800">
                    <button
                      onClick={() => {
                        onDeleteSegment();
                        setShowOtherMenu(false);
                      }}
                      className="w-full py-1.5 px-3 rounded-xl bg-red-950/40 hover:bg-red-900/60 text-red-300 border border-red-800/60 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Delete Subtitle Line
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main Interactive Caption Box */}
      <div
        className={`relative inline-block cursor-pointer transition-all duration-150 pointer-events-auto max-w-[90%] mx-auto text-center ${
          isSelected
            ? 'ring-2 ring-white/20 ring-offset-2 ring-offset-black/50 rounded-lg shadow-2xl'
            : 'rounded'
        }`}
        onMouseDown={(e) => {
          e.stopPropagation();
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          onSelect?.();
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setIsEditingText(true);
        }}
      >
        {isEditingText ? (
          <input
            type="text"
            value={editText}
            autoFocus
            onChange={(e) => setEditText(e.target.value)}
            onBlur={() => {
              setIsEditingText(false);
              if (editText !== text) onUpdateText?.(editText);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setIsEditingText(false);
                if (editText !== text) onUpdateText?.(editText);
              }
            }}
            className="bg-black/80 text-white border-2 border-white/10 rounded px-2 py-1 text-center outline-none font-semibold max-w-full"
            style={{
              fontSize: `${calcFontSize}px`,
              fontFamily: style.fontFamily || "'Kantumruy Pro', sans-serif",
            }}
          />
        ) : style.animation === 'karaoke' || style.animation === 'badge' ? (
          <span
            className="inline-block leading-snug max-w-full font-khmer transition-all text-center break-words"
            style={{
              fontFamily: style.fontFamily || "'Kantumruy Pro', sans-serif",
              fontSize: `${calcFontSize}px`,
              fontWeight: weight,
              letterSpacing: `${(style.letterSpacing || 0) * k}px`,
              lineHeight: style.lineHeight || 1.3,
              textAlign: (style.textAlign as any) || 'center',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflowWrap: 'anywhere',
              textTransform: style.textTransform || 'none',
              padding: `${calcFontSize * 0.15}px ${calcFontSize * 0.35}px`,
              backgroundColor:
                (style.boxOpacity || 0) > 0
                  ? hexToRgba(style.boxColor || '#000000', style.boxOpacity || 0.6)
                  : 'transparent',
              border:
                (style.boxOutlineWidth || 0) > 0
                  ? `${(style.boxOutlineWidth || 0) * k}px solid ${style.boxOutlineColor || '#000000'}`
                  : undefined,
              borderRadius: `${(style.borderRadius ?? 6) * k}px`,
            }}
          >
            {words.map((w, idx) => {
              const isActive = idx === activeWordIdx;
              const isPast = idx < activeWordIdx;
              const activeColor = style.activeWordColor || '#facc15';
              const isBadge = style.highlightStyle === 'badge' || style.animation === 'badge';
              const isScale = style.highlightStyle === 'scale';

              return (
                <span
                  key={idx}
                  className={`inline-block transition-all duration-150 ${
                    isActive ? 'anim-word-active' : ''
                  }`}
                  style={{
                    backgroundColor: isActive && isBadge ? activeColor : 'transparent',
                    color: isActive && isBadge ? '#000000' : isActive ? activeColor : style.textColor || '#FFFFFF',
                    opacity: isActive ? 1 : isPast ? 0.95 : 0.65,
                    padding: isActive && isBadge ? '1px 6px' : '0 2px',
                    borderRadius: isActive && isBadge ? '6px' : undefined,
                    fontWeight: isActive ? 900 : weight,
                    textShadow: isActive && !isBadge ? (stroke ? `${stroke}, 0 0 14px ${activeColor}` : `0 0 14px ${activeColor}`) : stroke,
                    transform: isActive && isScale ? 'scale(1.18)' : isActive ? 'scale(1.06)' : 'none',
                    margin: '0 2px',
                  }}
                >
                  {w}
                </span>
              );
            })}
          </span>
        ) : (
          <span
            className={`inline-block leading-snug max-w-full font-khmer transition-all text-center break-words ${
              style.animation === 'pop'
                ? 'anim-caption-pop'
                : style.animation === 'slide'
                ? 'anim-caption-slide'
                : style.animation === 'glow'
                ? 'anim-caption-glow'
                : style.animation === 'wave'
                ? 'anim-caption-wave'
                : ''
            }`}
            style={{
              fontFamily: style.fontFamily || "'Kantumruy Pro', sans-serif",
              fontSize: `${calcFontSize}px`,
              fontWeight: weight,
              letterSpacing: `${(style.letterSpacing || 0) * k}px`,
              lineHeight: style.lineHeight || 1.3,
              textAlign: (style.textAlign as any) || 'center',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflowWrap: 'anywhere',
              textTransform: style.textTransform || 'none',
              padding: `${calcFontSize * 0.15}px ${calcFontSize * 0.35}px`,
              color: style.textColor || '#FFFFFF',
              textShadow: stroke,
              backgroundColor:
                (style.boxOpacity || 0) > 0
                  ? hexToRgba(style.boxColor || '#000000', style.boxOpacity || 0.6)
                  : 'transparent',
              border:
                (style.boxOutlineWidth || 0) > 0
                  ? `${(style.boxOutlineWidth || 0) * k}px solid ${style.boxOutlineColor || '#000000'}`
                  : undefined,
              borderRadius: `${(style.borderRadius ?? 6) * k}px`,
            }}
          >
            {text}
          </span>
        )}

        {/* Selection Bounding Box Resize & Move Handles */}
        {isSelected && !isEditingText && (
          <>
            <div className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-white/10 border-2 border-white rounded-full shadow" />
            <div className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-white/10 border-2 border-white rounded-full shadow" />
            <div className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-white/10 border-2 border-white rounded-full shadow" />
            <div className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white/10 border-2 border-white rounded-full shadow" />
          </>
        )}
      </div>
    </div>
  );
}
