import { useState } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { Search, Check, Sparkles, Smile, Plus, Image as ImageIcon, Flame } from 'lucide-react';

interface MemeItem {
  id: string;
  title: string;
  duration: string;
  type: 'khmer' | 'english';
  avatar: string;
  color: string;
  bgGradient: string;
}

const MEMES: MemeItem[] = [
  { id: 'm1', title: 'តាចាស់ សើច (Funny Laugh)', duration: '00:04', type: 'khmer', avatar: '👴', color: '#f59e0b', bgGradient: 'from-amber-950/60 to-[#121316]' },
  { id: 'm2', title: 'មិនចង់ជឿម៉េចចោះ (Shocked King)', duration: '00:06', type: 'khmer', avatar: '👑', color: '#ef4444', bgGradient: 'from-red-950/60 to-[#121316]' },
  { id: 'm3', title: 'យាយប៊ិក ហែក (Grandma Screaming)', duration: '00:02', type: 'khmer', avatar: '👵', color: '#ec4899', bgGradient: 'from-pink-950/60 to-[#121316]' },
  { id: 'm4', title: 'idol - អាយដល (Best Dancer)', duration: '00:06', type: 'khmer', avatar: '🕺', color: '#8b5cf6', bgGradient: 'from-purple-950/60 to-[#121316]' },
  { id: 'm5', title: 'អាតេវ (Smirking Boy)', duration: '00:05', type: 'khmer', avatar: '😏', color: '#3b82f6', bgGradient: 'from-blue-950/60 to-[#121316]' },
  { id: 'm6', title: 'បើកភ្នែកមិនទាន់ (Morning Shock)', duration: '00:04', type: 'khmer', avatar: '😵', color: '#06b6d4', bgGradient: 'from-cyan-950/60 to-[#121316]' },
  { id: 'm7', title: 'ខ្ញុំគិតថាគាត់និយាយ... (Deep Thinker)', duration: '00:07', type: 'khmer', avatar: '🤔', color: '#10b981', bgGradient: 'from-emerald-950/60 to-[#121316]' },
  { id: 'm8', title: 'ស្ដាប់បានអត់បង? (Confused Guy)', duration: '00:04', type: 'khmer', avatar: '🤯', color: '#eab308', bgGradient: 'from-yellow-950/60 to-[#121316]' },
  { id: 'm9', title: 'Megamind ចម្អក (No Bitches?)', duration: '00:04', type: 'english', avatar: '👽', color: '#6366f1', bgGradient: 'from-indigo-950/60 to-[#121316]' },
  { id: 'm10', title: 'IShowSpeed Crazy Bark', duration: '00:07', type: 'english', avatar: '🐕', color: '#f43f5e', bgGradient: 'from-rose-950/60 to-[#121316]' },
  { id: 'm11', title: 'Skip skip ishowspeed', duration: '00:09', type: 'english', avatar: '⚡', color: '#f97316', bgGradient: 'from-orange-950/60 to-[#121316]' },
  { id: 'm12', title: 'Banana Cat Crying 🐱', duration: '00:04', type: 'english', avatar: '🍌', color: '#fbbf24', bgGradient: 'from-amber-950/60 to-[#121316]' },
];

const GIFS = [
  { id: 'g1', title: 'Good Morning Coffee Duck', category: 'hello', avatar: '🦆', tag: 'Morning', bg: 'from-amber-600/30 to-black' },
  { id: 'g2', title: 'Dave Chappelle YEAHHH', category: 'lol', avatar: '🎤', tag: 'YEAHHH', bg: 'from-blue-600/30 to-black' },
  { id: 'g3', title: 'Bright Happy Sunday', category: 'happy', avatar: '☀️', tag: 'Happy', bg: 'from-yellow-500/30 to-black' },
  { id: 'g4', title: 'Whitney Houston Wow', category: 'love', avatar: '✨', tag: 'Wow', bg: 'from-purple-600/30 to-black' },
  { id: 'g5', title: 'Morning Coffee Yawn', category: 'hello', avatar: '☕', tag: 'Coffee', bg: 'from-amber-700/30 to-black' },
  { id: 'g6', title: 'Man Exasperated Facepalm', category: 'lol', avatar: '🤦‍♂️', tag: 'Facepalm', bg: 'from-red-600/30 to-black' },
  { id: 'g7', title: 'Mind Blown Reaction', category: 'lol', avatar: '🤯', tag: 'Mind Blown', bg: 'from-cyan-600/30 to-black' },
  { id: 'g8', title: 'Cute Koala Cling', category: 'love', avatar: '🐨', tag: 'Hugs', bg: 'from-pink-600/30 to-black' },
  { id: 'g9', title: 'Bruce Lee Martial Focus', category: 'trending', avatar: '🥋', tag: 'Legend', bg: 'from-orange-600/30 to-black' },
];

interface Props {
  initialMode?: 'memes' | 'gif';
}

export default function MemesGifPanel({ initialMode = 'memes' }: Props) {
  const { currentProject, currentTime, addSegment, loadProject } = useProjectStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [memeFilter, setMemeFilter] = useState<'all' | 'khmer' | 'english'>('all');
  const [gifFilter, setGifFilter] = useState<string>('trending');
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const isGifMode = initialMode === 'gif';

  const filteredMemes = MEMES.filter((m) => {
    if (memeFilter === 'khmer' && m.type !== 'khmer') return false;
    if (memeFilter === 'english' && m.type !== 'english') return false;
    if (searchQuery.trim() && !m.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const filteredGifs = GIFS.filter((g) => {
    if (gifFilter !== 'trending' && gifFilter !== 'recent' && g.category !== gifFilter) return false;
    if (searchQuery.trim() && !g.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const handleInsertMeme = async (item: MemeItem) => {
    if (!currentProject?.id) return;
    const start = currentTime || 0;
    const end = start + 3.0;

    await addSegment({
      start_time: start,
      end_time: end,
      text: `[MEME: ${item.title}]`,
      speaker: 'Meme Clip',
    });
    await loadProject(currentProject.id);

    setToastMsg(`Added "${item.title}" to timeline`);
    setTimeout(() => setToastMsg(null), 2500);
  };

  const handleInsertGif = async (item: typeof GIFS[0]) => {
    if (!currentProject?.id) return;
    const start = currentTime || 0;
    const end = start + 3.0;

    await addSegment({
      start_time: start,
      end_time: end,
      text: `[GIF: ${item.title}]`,
      speaker: 'GIF Sticker',
    });
    await loadProject(currentProject.id);

    setToastMsg(`Added "${item.title}" to timeline`);
    setTimeout(() => setToastMsg(null), 2500);
  };

  return (
    <div className="h-full flex flex-col bg-[#121316] text-[#e1e3e6] overflow-hidden select-none font-sans relative">
      {/* Toast Notification */}
      {toastMsg && (
        <div className="absolute top-3 right-3 z-30 bg-emerald-950/95 border border-emerald-500/50 text-emerald-200 px-3 py-1.5 rounded-xl shadow-xl text-xs flex items-center gap-1.5 animate-in fade-in">
          <Check className="w-3.5 h-3.5 text-emerald-400" />
          <span>{toastMsg}</span>
        </div>
      )}

      {/* Header Search & Filter */}
      <div className="p-3.5 pb-2 shrink-0 border-b border-[#1a1c22]">
        <div className="relative mb-2">
          <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={isGifMode ? 'Search reaction GIFs & stickers...' : 'Search viral memes...'}
            className="w-full bg-[#181a1f] border border-[#24272f] rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-[#3d424d]"
          />
        </div>

        {/* Filter Pills */}
        {!isGifMode ? (
          <div className="flex items-center gap-1.5">
            {[
              { id: 'all', label: 'All Memes' },
              { id: 'khmer', label: '🇰🇭 Khmer Memes' },
              { id: 'english', label: '🌐 International' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setMemeFilter(tab.id as any)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
                  memeFilter === tab.id
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'bg-[#181a1f] text-zinc-400 hover:text-white hover:bg-[#20232a]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
            {[
              { id: 'trending', label: '🔥 Trending' },
              { id: 'lol', label: '😂 Funny' },
              { id: 'hello', label: '☕ Morning' },
              { id: 'happy', label: '✨ Happy' },
              { id: 'love', label: '💖 Love' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setGifFilter(tab.id)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${
                  gifFilter === tab.id
                    ? 'bg-pink-600 text-white shadow-sm'
                    : 'bg-[#181a1f] text-zinc-400 hover:text-white hover:bg-[#20232a]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Grid List */}
      <div className="flex-1 overflow-y-auto p-3.5">
        {!isGifMode ? (
          <div className="grid grid-cols-2 gap-2.5">
            {filteredMemes.map((item) => (
              <div
                key={item.id}
                onClick={() => handleInsertMeme(item)}
                className="p-3 rounded-2xl bg-[#151720] border border-[#222530] hover:border-emerald-500/60 hover:bg-[#181b26] transition-all cursor-pointer group flex flex-col justify-between relative overflow-hidden"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-2xl group-hover:scale-125 transition-transform duration-300">
                    {item.avatar}
                  </span>
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-black/40 text-zinc-400">
                    {item.duration}
                  </span>
                </div>

                <div>
                  <p className="text-xs font-bold text-white truncate font-khmer">{item.title}</p>
                  <span className="text-[9px] text-emerald-400 font-semibold uppercase mt-0.5 inline-block">
                    {item.type === 'khmer' ? 'Khmer Viral' : 'Trending'}
                  </span>
                </div>

                <div className="absolute right-2 bottom-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="w-6 h-6 rounded-full bg-emerald-600 text-white flex items-center justify-center shadow-md">
                    <Plus className="w-3.5 h-3.5" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {filteredGifs.map((item) => (
              <div
                key={item.id}
                onClick={() => handleInsertGif(item)}
                className="p-2 rounded-xl bg-[#151720] border border-[#222530] hover:border-pink-500/60 hover:bg-[#181b26] transition-all cursor-pointer group flex flex-col items-center justify-center text-center relative"
              >
                <span className="text-2xl mb-1 group-hover:scale-125 transition-transform duration-300">
                  {item.avatar}
                </span>
                <span className="text-[10px] text-zinc-300 truncate w-full font-medium">
                  {item.tag}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
