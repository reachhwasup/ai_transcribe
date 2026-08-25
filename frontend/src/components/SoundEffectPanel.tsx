import { useState, useRef } from 'react';
import { useProjectStore } from '../stores/projectStore';
import {
  Search,
  Play,
  Pause,
  Plus,
  Heart,
  Check,
  Volume2,
  Sparkles,
  Zap,
  Activity,
} from 'lucide-react';

interface SoundEffect {
  id: string;
  name: string;
  category: 'popular' | 'general' | 'transitions' | 'impacts' | 'uiclick';
  categoryLabel: string;
  duration: string;
  size: string;
  type: 'whoosh' | 'pop' | 'ding' | 'boom' | 'shutter' | 'laser' | 'chime' | 'glitch' | 'click' | 'bubble';
  icon: string;
  color: string;
}

const SFX_ITEMS: SoundEffect[] = [
  { id: 'sfx-bubble', name: 'Ancient Game Suction Bubble', category: 'popular', categoryLabel: 'Popular Sound Effect', duration: '00:01', size: '6.97KB', type: 'bubble', icon: '🫧', color: 'from-cyan-900/40 to-black' },
  { id: 'sfx-pause', name: 'Pause Button Click', category: 'uiclick', categoryLabel: 'UI Click Sound', duration: '00:01', size: '20.03KB', type: 'click', icon: '🔘', color: 'from-blue-900/40 to-black' },
  { id: 'sfx-retro-chirp', name: 'Retro Game Menu Chirp', category: 'uiclick', categoryLabel: 'UI Click Sound', duration: '00:01', size: '2.07KB', type: 'ding', icon: '🎮', color: 'from-amber-900/40 to-black' },
  { id: 'sfx-clean-btn', name: 'Clean Interface Buttons', category: 'popular', categoryLabel: 'Popular Sound Effect', duration: '00:01', size: '12.28KB', type: 'click', icon: '🖱️', color: 'from-purple-900/40 to-black' },
  { id: 'sfx-wood-block', name: 'Wooden Block Light Impact', category: 'impacts', categoryLabel: 'Impact Sound', duration: '00:01', size: '3.16KB', type: 'pop', icon: '🪵', color: 'from-yellow-900/40 to-black' },
  { id: 'sfx-designed-ui', name: 'UI Designed Simple Pop', category: 'uiclick', categoryLabel: 'UI Click Sound', duration: '00:01', size: '4.66KB', type: 'pop', icon: '🎯', color: 'from-emerald-900/40 to-black' },
  { id: 'sfx-bell-notif', name: 'Bell Notification 02', category: 'popular', categoryLabel: 'Popular Sound Effect', duration: '00:01', size: '12.28KB', type: 'chime', icon: '🔔', color: 'from-amber-900/40 to-black' },
  { id: 'sfx-mech-cancel', name: 'UI Mechanical Cancel FX', category: 'uiclick', categoryLabel: 'UI Click Sound', duration: '00:01', size: '13.81KB', type: 'glitch', icon: '⚡', color: 'from-red-900/40 to-black' },
  { id: 'sfx-cool-ui', name: 'Cool UI Button 1', category: 'uiclick', categoryLabel: 'UI Click Sound', duration: '00:01', size: '1.66KB', type: 'click', icon: '✨', color: 'from-teal-900/40 to-black' },
  { id: 'sfx-retro-echo', name: 'Retro Game Echo Select', category: 'uiclick', categoryLabel: 'UI Click Sound', duration: '00:02', size: '31.05KB', type: 'ding', icon: '🕹️', color: 'from-indigo-900/40 to-black' },
  { id: 'sfx-click-sound', name: 'Punchy Click Sound Effect', category: 'popular', categoryLabel: 'Popular Sound Effect', duration: '00:01', size: '2.79KB', type: 'click', icon: '👆', color: 'from-blue-900/40 to-black' },
  { id: 'sfx-cinematic-boom', name: 'Deep Cinematic Sub Boom', category: 'impacts', categoryLabel: 'Impact Sound', duration: '00:02', size: '42.10KB', type: 'boom', icon: '💥', color: 'from-red-900/40 to-black' },
  { id: 'sfx-fast-whoosh', name: 'Fast Whip Transition Whoosh', category: 'transitions', categoryLabel: 'Transitions', duration: '00:01', size: '8.45KB', type: 'whoosh', icon: '💨', color: 'from-cyan-900/40 to-black' },
  { id: 'sfx-camera-shutter', name: 'DSLR Camera Snap Shutter', category: 'general', categoryLabel: 'General FX', duration: '00:01', size: '9.12KB', type: 'shutter', icon: '📸', color: 'from-zinc-800 to-black' },
];

export default function SoundEffectPanel() {
  const { currentProject, currentTime, addSegment, loadProject } = useProjectStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'fav' | 'general' | 'transitions' | 'impacts' | 'uiclick'>('all');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);

  const playSynthesizedSfx = (type: SoundEffect['type']) => {
    try {
      const ctx = audioCtxRef.current || new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtxRef.current = ctx;
      if (ctx.state === 'suspended') ctx.resume();

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'whoosh') {
        const bufferSize = ctx.sampleRate * 0.35;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(400, now);
        filter.frequency.exponentialRampToValueAtTime(3200, now + 0.18);
        filter.frequency.exponentialRampToValueAtTime(300, now + 0.35);
        noise.connect(filter);
        filter.connect(gain);
        gain.gain.setValueAtTime(0.01, now);
        gain.gain.linearRampToValueAtTime(0.5, now + 0.15);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        noise.start(now);
        noise.stop(now + 0.36);
        return;
      }

      if (type === 'pop' || type === 'bubble') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(300, now);
        osc.frequency.exponentialRampToValueAtTime(1200, now + 0.08);
        gain.gain.setValueAtTime(0.6, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
        osc.start(now);
        osc.stop(now + 0.13);
        return;
      }

      if (type === 'ding' || type === 'chime') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1760, now);
        gain.gain.setValueAtTime(0.4, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
        osc.start(now);
        osc.stop(now + 0.61);
        return;
      }

      if (type === 'boom') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(160, now);
        osc.frequency.exponentialRampToValueAtTime(30, now + 0.5);
        gain.gain.setValueAtTime(0.8, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
        osc.start(now);
        osc.stop(now + 0.61);
        return;
      }

      if (type === 'click') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(150, now + 0.04);
        gain.gain.setValueAtTime(0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
        osc.start(now);
        osc.stop(now + 0.06);
        return;
      }

      if (type === 'shutter') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(600, now);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
        osc.start(now);
        osc.stop(now + 0.06);
        return;
      }

      // Default quick beep
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, now);
      gain.gain.setValueAtTime(0.4, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      osc.start(now);
      osc.stop(now + 0.21);
    } catch (e) {
      console.error('Audio synthesis failed:', e);
    }
  };

  const handlePreview = (item: SoundEffect) => {
    setPlayingId(item.id);
    playSynthesizedSfx(item.type);
    setTimeout(() => {
      setPlayingId((prev) => (prev === item.id ? null : prev));
    }, 600);
  };

  const toggleFavorite = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleInsert = async (item: SoundEffect) => {
    if (!currentProject?.id) return;
    const start = currentTime || 0;
    const end = start + 1.5;

    await addSegment({
      start_time: start,
      end_time: end,
      text: `[SFX: ${item.name}]`,
      speaker: 'Sound FX',
    });
    await loadProject(currentProject.id);

    setToastMsg(`Inserted "${item.name}" at ${start.toFixed(1)}s`);
    setTimeout(() => setToastMsg(null), 2500);
  };

  const filteredItems = SFX_ITEMS.filter((item) => {
    if (activeFilter === 'fav' && !favorites.has(item.id)) return false;
    if (activeFilter !== 'all' && activeFilter !== 'fav' && item.category !== activeFilter) return false;
    if (searchQuery.trim() && !item.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="h-full flex flex-col bg-[#121316] text-[#e1e3e6] overflow-hidden select-none font-sans relative">
      {/* Toast Notification */}
      {toastMsg && (
        <div className="absolute top-3 right-3 z-30 bg-blue-950/95 border border-blue-500/50 text-blue-200 px-3 py-1.5 rounded-xl shadow-xl text-xs flex items-center gap-1.5 animate-in fade-in">
          <Check className="w-3.5 h-3.5 text-blue-400" />
          <span>{toastMsg}</span>
        </div>
      )}

      {/* Search Header */}
      <div className="p-3.5 pb-2 shrink-0 border-b border-[#1a1c22]">
        <div className="relative mb-2">
          <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search sound effects..."
            className="w-full bg-[#181a1f] border border-[#24272f] rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-[#3d424d]"
          />
        </div>

        {/* Filter Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
          {[
            { id: 'all', label: 'All FX' },
            { id: 'fav', label: 'Favorites' },
            { id: 'uiclick', label: 'UI Clicks' },
            { id: 'impacts', label: 'Impacts' },
            { id: 'transitions', label: 'Transitions' },
            { id: 'general', label: 'General' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveFilter(tab.id as any)}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${
                activeFilter === tab.id
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-[#181a1f] text-zinc-400 hover:text-white hover:bg-[#20232a]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* SFX List */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-2">
        {filteredItems.map((item) => {
          const isPlaying = playingId === item.id;
          const isFav = favorites.has(item.id);

          return (
            <div
              key={item.id}
              onClick={() => handlePreview(item)}
              className={`p-2.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-3 group ${
                isPlaying
                  ? 'bg-[#1a2035] border-blue-500 ring-1 ring-blue-500/50 shadow-md'
                  : 'bg-[#151720] border-[#222530] hover:border-[#32384a] hover:bg-[#181b26]'
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                {/* Play / Pause button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePreview(item);
                  }}
                  className={`w-8 h-8 rounded-xl flex items-center justify-center transition-all shrink-0 ${
                    isPlaying
                      ? 'bg-blue-600 text-white shadow-md shadow-blue-950/50 scale-105'
                      : 'bg-[#1e2230] text-zinc-300 hover:text-white hover:bg-[#262c3e]'
                  }`}
                >
                  {isPlaying ? (
                    <Activity className="w-4 h-4 animate-pulse text-white" />
                  ) : (
                    <Play className="w-3.5 h-3.5 ml-0.5" />
                  )}
                </button>

                {/* Title & Metadata */}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm">{item.icon}</span>
                    <p className="text-xs font-semibold text-white truncate">{item.name}</p>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-zinc-500 font-mono mt-0.5">
                    <span>{item.duration}</span>
                    <span>•</span>
                    <span>{item.categoryLabel}</span>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={(e) => toggleFavorite(item.id, e)}
                  className={`p-1.5 rounded-lg transition-colors ${
                    isFav ? 'text-rose-500' : 'text-zinc-600 hover:text-zinc-300 hover:bg-white/5'
                  }`}
                  title="Favorite"
                >
                  <Heart className={`w-3.5 h-3.5 ${isFav ? 'fill-rose-500' : ''}`} />
                </button>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleInsert(item);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold flex items-center gap-1 shadow-sm transition-all active:scale-95"
                  title="Insert to timeline at current playhead"
                >
                  <Plus className="w-3 h-3" />
                  <span>Add</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
