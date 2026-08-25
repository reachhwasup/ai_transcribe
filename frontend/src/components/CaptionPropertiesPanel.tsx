import React, { useState } from 'react';
import { useProjectStore } from '../stores/projectStore';
import {
  FONT_OPTIONS,
  DEFAULT_SUBTITLE_STYLE,
  SubtitleStyle,
  hexToRgba,
} from '../types/subtitleStyle';
import {
  Type,
  Bold,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Sparkles,
  Sliders,
  Palette,
  Eye,
  EyeOff,
  RotateCcw,
  Check,
  ChevronDown,
  Layers,
  Wand2,
} from 'lucide-react';

const PRESET_TEMPLATES: {
  id: string;
  name: string;
  desc: string;
  badge: string;
  style: Partial<SubtitleStyle>;
}[] = [
  {
    id: 'meatika_classic',
    name: 'Meatika Classic',
    desc: 'Bold Kantumruy, yellow accent, subtle dark box',
    badge: 'Popular',
    style: {
      fontFamily: "'Kantumruy Pro', sans-serif",
      fontSize: 30,
      fontWeight: 'bold',
      textColor: '#FFFFFF',
      boxColor: '#000000',
      boxOpacity: 0.65,
      boxOutlineWidth: 0,
      outlineWidth: 2,
      outlineColor: '#000000',
      borderRadius: 8,
      animation: 'karaoke',
      activeWordColor: '#facc15',
    },
  },
  {
    id: 'cyber_neon',
    name: 'Cyber Neon',
    desc: 'Bebas Neue bold with neon cyan glow and no box',
    badge: 'Glow',
    style: {
      fontFamily: "'Bebas Neue', sans-serif",
      fontSize: 36,
      fontWeight: 'bold',
      textColor: '#38bdf8',
      boxOpacity: 0,
      outlineWidth: 0,
      textShadow: 'glow',
      animation: 'glow',
      textTransform: 'uppercase',
      letterSpacing: 2,
    },
  },
  {
    id: 'cinema_clean',
    name: 'Cinema Clean',
    desc: 'Minimal white typography with soft drop shadow',
    badge: 'Clean',
    style: {
      fontFamily: "'Inter', sans-serif",
      fontSize: 26,
      fontWeight: 'bold',
      textColor: '#FFFFFF',
      boxOpacity: 0,
      outlineWidth: 1.5,
      outlineColor: '#000000',
      textShadow: 'soft',
      borderRadius: 4,
      animation: 'none',
    },
  },
  {
    id: 'moul_royal',
    name: 'Moul Royal',
    desc: 'Fancy Khmer traditional title display font',
    badge: 'Fancy',
    style: {
      fontFamily: "'Moul', 'Khmer OS Moul', cursive",
      fontSize: 32,
      fontWeight: 'bold',
      textColor: '#fef08a',
      outlineWidth: 3,
      outlineColor: '#854d0e',
      boxColor: '#451a03',
      boxOpacity: 0.8,
      boxOutlineColor: '#ca8a04',
      boxOutlineWidth: 1.5,
      borderRadius: 10,
      animation: 'pop',
    },
  },
  {
    id: 'pop_karaoke',
    name: 'Pop Karaoke',
    desc: 'Koulen Display with active yellow bounce',
    badge: 'Karaoke',
    style: {
      fontFamily: "'Koulen', cursive",
      fontSize: 32,
      fontWeight: 'bold',
      textColor: '#FFFFFF',
      boxColor: '#1e1b4b',
      boxOpacity: 0.85,
      boxOutlineColor: '#6366f1',
      boxOutlineWidth: 2,
      borderRadius: 999,
      animation: 'karaoke',
      activeWordColor: '#fbbf24',
    },
  },
];

const COLOR_SWATCHES = [
  '#FFFFFF',
  '#facc15',
  '#38bdf8',
  '#ec4899',
  '#a855f7',
  '#4ade80',
  '#f87171',
  '#000000',
];

export default function CaptionPropertiesPanel() {
  const {
    subtitleStyle,
    setSubtitleStyle,
    subtitlesVisible,
    toggleSubtitlesVisible,
  } = useProjectStore();

  const [showFontMenu, setShowFontMenu] = useState(false);

  const s = subtitleStyle || DEFAULT_SUBTITLE_STYLE;

  const currentFont =
    FONT_OPTIONS.find((f) => f.value === s.fontFamily) || FONT_OPTIONS[0];

  const handleApplyPreset = (presetStyle: Partial<SubtitleStyle>) => {
    setSubtitleStyle({ ...presetStyle });
  };

  return (
    <div className="h-full flex flex-col bg-[#121316] text-[#e1e3e6] overflow-y-auto select-none font-sans">
      {/* Panel Header */}
      <div className="px-5 py-3 border-b border-[#1c1e24] bg-[#121316] flex items-center justify-between shrink-0 sticky top-0 z-20 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-pink-500/20 border border-pink-500/40 flex items-center justify-center text-pink-400">
            <Type className="w-3.5 h-3.5" />
          </div>
          <div>
            <h2 className="text-xs font-bold text-white tracking-wide">Caption Properties</h2>
            <p className="text-[10px] text-zinc-500 font-medium">Customize Typography & Styling</p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setSubtitleStyle(DEFAULT_SUBTITLE_STYLE)}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-[#1e2025] transition-colors"
            title="Reset to Default Style"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={toggleSubtitlesVisible}
            className={`px-2 py-1 rounded-lg text-[10px] font-bold border flex items-center gap-1 transition-all ${
              subtitlesVisible
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                : 'bg-[#181a1f] text-zinc-500 border-zinc-800'
            }`}
            title="Toggle Subtitle Visibility"
          >
            {subtitlesVisible ? <Eye className="w-3 h-3 text-emerald-400" /> : <EyeOff className="w-3 h-3" />}
            <span>{subtitlesVisible ? 'CC On' : 'CC Off'}</span>
          </button>
        </div>
      </div>

      <div className="p-4 space-y-5 flex-1">

        {/* 1-Click Style Preset Templates */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
              <Wand2 className="w-3.5 h-3.5 text-pink-400" /> Style Presets
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {PRESET_TEMPLATES.map((tmpl) => (
              <button
                key={tmpl.id}
                onClick={() => handleApplyPreset(tmpl.style)}
                className="p-2.5 rounded-xl border border-[#282b33] bg-[#181a1f] hover:border-pink-500/60 hover:bg-[#20232a] text-left transition-all group relative overflow-hidden"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-bold text-white group-hover:text-pink-300 transition-colors">
                    {tmpl.name}
                  </span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-pink-500/20 text-pink-300 font-medium">
                    {tmpl.badge}
                  </span>
                </div>
                <p className="text-[10px] text-zinc-400 line-clamp-2 leading-relaxed">
                  {tmpl.desc}
                </p>
              </button>
            ))}
          </div>
        </div>

        {/* Typography Section */}
        <div className="space-y-3 bg-[#181a1f] border border-[#26282e] rounded-2xl p-4">
          <span className="text-[11px] font-bold text-white uppercase tracking-wider block">
            Typography
          </span>

          {/* Font Family Selection */}
          <div className="space-y-1">
            <label className="text-[10px] text-zinc-400 block font-medium">Font Family</label>
            <div className="relative">
              <button
                onClick={() => setShowFontMenu(!showFontMenu)}
                className="w-full px-3 py-2 rounded-xl bg-[#121316] border border-[#2b2f3a] hover:border-[#3f4553] text-left text-xs text-white flex items-center justify-between transition-colors"
                style={{ fontFamily: s.fontFamily || "'Kantumruy Pro', sans-serif" }}
              >
                <span className="truncate">{currentFont.label} ({currentFont.category})</span>
                <ChevronDown className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
              </button>

              {showFontMenu && (
                <div className="absolute top-full left-0 right-0 mt-1.5 bg-[#1a1c22] border border-[#2e323b] rounded-xl shadow-2xl py-1 z-50 max-h-60 overflow-y-auto">
                  {FONT_OPTIONS.map((f) => (
                    <button
                      key={f.label}
                      onClick={() => {
                        setSubtitleStyle({ fontFamily: f.value });
                        setShowFontMenu(false);
                      }}
                      className={`w-full px-3.5 py-2 text-left text-xs flex items-center justify-between hover:bg-[#252830] transition-colors ${
                        s.fontFamily === f.value ? 'text-pink-400 font-bold bg-[#252830]' : 'text-zinc-200'
                      }`}
                      style={{ fontFamily: f.value }}
                    >
                      <div>
                        <span>{f.label}</span>
                        <span className="text-[10px] text-zinc-500 ml-2">({f.category})</span>
                      </div>
                      {s.fontFamily === f.value && <Check className="w-3.5 h-3.5 text-pink-400" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Font Size & Weight */}
          <div className="grid grid-cols-2 gap-3 pt-1">
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-zinc-400">
                <span>Font Size</span>
                <span className="font-mono text-white">{s.fontSize || 28}px</span>
              </div>
              <input
                type="range"
                min={14}
                max={72}
                step={1}
                value={s.fontSize || 28}
                onChange={(e) => setSubtitleStyle({ fontSize: parseInt(e.target.value) })}
                className="w-full h-1.5 bg-zinc-800 rounded-lg accent-pink-500 cursor-pointer"
              />
            </div>

            <div className="space-y-1">
              <span className="text-[10px] text-zinc-400 block">Weight</span>
              <div className="grid grid-cols-2 gap-1 bg-[#121316] p-0.5 rounded-xl border border-zinc-800 text-[10px]">
                <button
                  onClick={() => setSubtitleStyle({ fontWeight: 'normal' })}
                  className={`py-1 rounded-lg transition-colors ${
                    s.fontWeight !== 'bold'
                      ? 'bg-pink-500 text-white font-bold'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Regular
                </button>
                <button
                  onClick={() => setSubtitleStyle({ fontWeight: 'bold' })}
                  className={`py-1 rounded-lg transition-colors ${
                    s.fontWeight === 'bold'
                      ? 'bg-pink-500 text-white font-bold'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Bold
                </button>
              </div>
            </div>
          </div>

          {/* Alignment & Text Transform */}
          <div className="grid grid-cols-2 gap-3 pt-1">
            <div className="space-y-1">
              <span className="text-[10px] text-zinc-400 block">Alignment</span>
              <div className="grid grid-cols-3 gap-1 bg-[#121316] p-0.5 rounded-xl border border-zinc-800">
                {[
                  { id: 'left', icon: AlignLeft },
                  { id: 'center', icon: AlignCenter },
                  { id: 'right', icon: AlignRight },
                ].map((item) => {
                  const Icon = item.icon;
                  const isActive = (s.textAlign || 'center') === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setSubtitleStyle({ textAlign: item.id as any })}
                      className={`py-1 flex items-center justify-center rounded-lg transition-colors ${
                        isActive
                          ? 'bg-pink-500 text-white'
                          : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1">
              <span className="text-[10px] text-zinc-400 block">Capitalization</span>
              <div className="grid grid-cols-2 gap-1 bg-[#121316] p-0.5 rounded-xl border border-zinc-800 text-[10px]">
                <button
                  onClick={() => setSubtitleStyle({ textTransform: 'none' })}
                  className={`py-1 rounded-lg transition-colors ${
                    s.textTransform !== 'uppercase'
                      ? 'bg-pink-500 text-white font-bold'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Normal
                </button>
                <button
                  onClick={() => setSubtitleStyle({ textTransform: 'uppercase' })}
                  className={`py-1 rounded-lg transition-colors ${
                    s.textTransform === 'uppercase'
                      ? 'bg-pink-500 text-white font-bold'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  ALL CAPS
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Colors & Appearance Section */}
        <div className="space-y-3 bg-[#181a1f] border border-[#26282e] rounded-2xl p-4">
          <span className="text-[11px] font-bold text-white uppercase tracking-wider block">
            Colors & Styling
          </span>

          {/* Text Color Swatches */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[10px] text-zinc-400">
              <span>Text Color</span>
              <span className="font-mono text-white uppercase">{s.textColor}</span>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {COLOR_SWATCHES.map((color) => (
                <button
                  key={color}
                  onClick={() => setSubtitleStyle({ textColor: color })}
                  className={`w-6 h-6 rounded-full border transition-all ${
                    s.textColor === color
                      ? 'ring-2 ring-pink-500 ring-offset-2 ring-offset-black scale-110 border-white'
                      : 'border-white/20 hover:scale-105'
                  }`}
                  style={{ backgroundColor: color }}
                />
              ))}
              <label className="w-6 h-6 rounded-full border border-dashed border-zinc-500 flex items-center justify-center cursor-pointer hover:border-white transition-colors relative">
                <Palette className="w-3 h-3 text-zinc-400" />
                <input
                  type="color"
                  value={s.textColor || '#FFFFFF'}
                  onChange={(e) => setSubtitleStyle({ textColor: e.target.value })}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
              </label>
            </div>
          </div>

          {/* Background Box Fill & Opacity */}
          <div className="space-y-2 pt-2 border-t border-[#26282e]">
            <div className="flex items-center justify-between text-[10px] text-zinc-400">
              <span>Background Box</span>
              <span className="font-mono text-white">{Math.round((s.boxOpacity || 0) * 100)}% Opacity</span>
            </div>
            <div className="flex items-center gap-3">
              <label className="w-7 h-7 rounded-lg border border-white/20 flex items-center justify-center cursor-pointer relative shrink-0 shadow-sm" style={{ backgroundColor: s.boxColor || '#000000' }}>
                <input
                  type="color"
                  value={s.boxColor || '#000000'}
                  onChange={(e) => setSubtitleStyle({ boxColor: e.target.value })}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={s.boxOpacity ?? 0.6}
                onChange={(e) => setSubtitleStyle({ boxOpacity: parseFloat(e.target.value) })}
                className="flex-1 h-1.5 bg-zinc-800 rounded-lg accent-pink-500 cursor-pointer"
              />
            </div>
          </div>

          {/* Outline Stroke */}
          <div className="space-y-2 pt-2 border-t border-[#26282e]">
            <div className="flex items-center justify-between text-[10px] text-zinc-400">
              <span>Outline Stroke</span>
              <span className="font-mono text-white">{s.outlineWidth || 0}px</span>
            </div>
            <div className="flex items-center gap-3">
              <label className="w-7 h-7 rounded-lg border border-white/20 flex items-center justify-center cursor-pointer relative shrink-0 shadow-sm" style={{ backgroundColor: s.outlineColor || '#000000' }}>
                <input
                  type="color"
                  value={s.outlineColor || '#000000'}
                  onChange={(e) => setSubtitleStyle({ outlineColor: e.target.value })}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
              </label>
              <input
                type="range"
                min={0}
                max={8}
                step={0.5}
                value={s.outlineWidth || 0}
                onChange={(e) => setSubtitleStyle({ outlineWidth: parseFloat(e.target.value) })}
                className="flex-1 h-1.5 bg-zinc-800 rounded-lg accent-pink-500 cursor-pointer"
              />
            </div>
          </div>

          {/* Position Selection */}
          <div className="space-y-1.5 pt-2 border-t border-[#26282e]">
            <span className="text-[10px] text-zinc-400 block font-medium">Vertical Placement</span>
            <div className="grid grid-cols-3 gap-2">
              {(['top', 'middle', 'bottom'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setSubtitleStyle({ position: p })}
                  className={`py-1.5 rounded-xl border text-xs font-semibold capitalize transition-all ${
                    s.position === p
                      ? 'bg-pink-500 text-white border-pink-400 shadow-md shadow-pink-500/20'
                      : 'bg-[#121316] border-zinc-800 text-zinc-400 hover:text-white'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Motion & Animation Studio */}
        <div className="space-y-4 bg-[#181a1f] border border-[#26282e] rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-white uppercase tracking-wider block">
              Animation & Highlights
            </span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-pink-500/20 text-pink-300 font-semibold">
              Pro Motion
            </span>
          </div>

          {/* Animation Presets Grid */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            {[
              { id: 'none', label: '⏹️ Static (None)', desc: 'Clean subtitle' },
              { id: 'karaoke', label: '🎤 Word Highlight', desc: 'Active word pop' },
              { id: 'badge', label: '🏷️ Word Badge Box', desc: 'Glowing highlight box' },
              { id: 'pop', label: '✨ Pop In Zoom', desc: 'Dynamic bounce' },
              { id: 'slide', label: '🚀 Slide Up Reveal', desc: 'Smooth entry' },
              { id: 'glow', label: '🌟 Neon Glow Pulse', desc: 'Vibrant aura' },
              { id: 'wave', label: '🌊 Kinetic Wave', desc: 'Rhythmic float' },
            ].map((anim) => {
              const isActive = (s.animation || 'none') === anim.id;
              return (
                <button
                  key={anim.id}
                  onClick={() => setSubtitleStyle({ animation: anim.id as any })}
                  className={`py-2 px-3 rounded-xl border text-left transition-all ${
                    isActive
                      ? 'bg-gradient-to-r from-pink-600 to-purple-600 text-white border-pink-400 shadow-lg shadow-pink-600/30'
                      : 'bg-[#121316] border-zinc-800 text-zinc-300 hover:text-white hover:border-zinc-700'
                  }`}
                >
                  <span className="font-bold text-xs block leading-tight">{anim.label}</span>
                  <span className={`text-[10px] block mt-0.5 ${isActive ? 'text-pink-100' : 'text-zinc-500'}`}>
                    {anim.desc}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Highlight Color & Style (Visible for Karaoke & Word Badge) */}
          {(s.animation === 'karaoke' || s.animation === 'badge') && (
            <div className="space-y-3 pt-3 border-t border-[#26282e] animate-in fade-in duration-200">
              {/* Active Word Highlight Color */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[10px] text-zinc-400">
                  <span>Active Word Highlight Color</span>
                  <span className="font-mono text-white uppercase">{s.activeWordColor || '#facc15'}</span>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {[
                    '#facc15', // Vibrant Gold / Yellow
                    '#38bdf8', // Electric Cyan
                    '#4ade80', // Neon Green
                    '#ec4899', // Hot Pink
                    '#fb923c', // Sunset Orange
                    '#a855f7', // Vivid Purple
                    '#ffffff', // Pure White
                  ].map((color) => (
                    <button
                      key={color}
                      onClick={() => setSubtitleStyle({ activeWordColor: color })}
                      className={`w-6 h-6 rounded-full border transition-all ${
                        (s.activeWordColor || '#facc15') === color
                          ? 'ring-2 ring-pink-500 ring-offset-2 ring-offset-black scale-110 border-white'
                          : 'border-white/20 hover:scale-105'
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                  <label className="w-6 h-6 rounded-full border border-dashed border-zinc-500 flex items-center justify-center cursor-pointer hover:border-white transition-colors relative">
                    <Palette className="w-3 h-3 text-zinc-400" />
                    <input
                      type="color"
                      value={s.activeWordColor || '#facc15'}
                      onChange={(e) => setSubtitleStyle({ activeWordColor: e.target.value })}
                      className="absolute inset-0 opacity-0 cursor-pointer"
                    />
                  </label>
                </div>
              </div>

              {/* Highlight Effect Mode */}
              <div className="space-y-1.5">
                <span className="text-[10px] text-zinc-400 block font-medium">Highlight Style Mode</span>
                <div className="grid grid-cols-3 gap-1.5 text-[11px]">
                  {[
                    { id: 'color', label: 'Color Glow' },
                    { id: 'badge', label: 'Badge Box' },
                    { id: 'scale', label: 'Scale Pop' },
                  ].map((mode) => {
                    const isActive = (s.highlightStyle || (s.animation === 'badge' ? 'badge' : 'color')) === mode.id;
                    return (
                      <button
                        key={mode.id}
                        onClick={() =>
                          setSubtitleStyle({
                            highlightStyle: mode.id as any,
                            animation: mode.id === 'badge' ? 'badge' : 'karaoke',
                          })
                        }
                        className={`py-1.5 rounded-lg border text-center font-medium transition-colors ${
                          isActive
                            ? 'bg-pink-500 text-white border-pink-400 font-bold'
                            : 'bg-[#121316] border-zinc-800 text-zinc-400 hover:text-white'
                        }`}
                      >
                        {mode.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
