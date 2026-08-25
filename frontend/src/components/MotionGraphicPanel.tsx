import { useState } from 'react';
import { useProjectStore } from '../stores/projectStore';
import {
  Search,
  SlidersHorizontal,
  Plus,
  Check,
  Sparkles,
  Heart,
} from 'lucide-react';

interface MotionGraphicCard {
  id: string;
  name: string;
  category: 'recent' | 'favorite' | 'my_motion' | 'customize';
  duration: string;
  thumbBg: string;
  tag: string;
  previewText: string;
  subText?: string;
  textColor: string;
  icon?: string;
}

const MOTION_CARDS: MotionGraphicCard[] = [
  { id: 'mg-battery', name: 'Battery Charging', category: 'recent', duration: '00:03', thumbBg: 'bg-[#18191d] border-amber-500/30 text-amber-400', tag: '⚡ 50%', previewText: '⚡ 50% CHARGING', textColor: '#f59e0b', icon: '🔋' },
  { id: 'mg-followers', name: 'Follower Counter', category: 'recent', duration: '00:04', thumbBg: 'bg-[#18191d] border-orange-500/30 text-orange-400', tag: '+1,068', previewText: '🔥 +1,068 Followers', textColor: '#f97316', icon: '👥' },
  { id: 'mg-register-green', name: 'Green Register', category: 'recent', duration: '00:03', thumbBg: 'bg-[#18191d] border-emerald-500/30 text-emerald-400', tag: 'ចុះឈ្មោះ', previewText: 'ចុះឈ្មោះឥឡូវនេះ', textColor: '#10b981', icon: '🏷️' },
  { id: 'mg-register-now', name: 'Register Now Banner', category: 'recent', duration: '00:04', thumbBg: 'bg-[#18191d] border-red-500/30 text-white', tag: 'REGISTER NOW', previewText: 'REGISTER NOW', textColor: '#ef4444', icon: '🎯' },
  { id: 'mg-popup-slide', name: 'Pop-Up Slide Banner', category: 'recent', duration: '00:03', thumbBg: 'bg-[#18191d] border-rose-500/30 text-rose-400', tag: 'LIMITED', previewText: 'Limited Offer', textColor: '#f43f5e', icon: '💥' },
  { id: 'mg-laptop-promo', name: '3D Promo Laptop', category: 'recent', duration: '00:05', thumbBg: 'bg-[#18191d] border-blue-500/30 text-blue-400', tag: 'TECH PROMO', previewText: 'Meatika Studio Pro', textColor: '#3b82f6', icon: '💻' },
  { id: 'mg-app-release', name: 'New App Release', category: 'recent', duration: '00:04', thumbBg: 'bg-[#18191d] border-pink-500/30 text-pink-400', tag: 'NEW APP', previewText: 'Download iOS & Android', textColor: '#ec4899', icon: '📱' },
  { id: 'mg-fb-follow', name: 'Facebook Follow', category: 'recent', duration: '00:03', thumbBg: 'bg-[#18191d] border-sky-500/30 text-sky-400', tag: 'FB PAGE', previewText: 'Follow Facebook Page', textColor: '#0284c7', icon: '📘' },
  { id: 'mg-yt-subscribe', name: 'YouTube Subscribe', category: 'recent', duration: '00:04', thumbBg: 'bg-[#18191d] border-red-500/30 text-red-400', tag: 'SUBSCRIBE', previewText: '🔔 Subscribe & Bell', textColor: '#dc2626', icon: '▶️' },
  { id: 'mg-history-book', name: 'History Book Cover', category: 'recent', duration: '00:04', thumbBg: 'bg-[#18191d] border-amber-500/30 text-amber-300', tag: 'មរតក', previewText: 'រឿងព្រេងខ្មែរ', textColor: '#fde047', icon: '📜' },
  { id: 'mg-book-title', name: 'Book Title Profile', category: 'recent', duration: '00:03', thumbBg: 'bg-[#18191d] border-yellow-500/30 text-yellow-400', tag: 'ចំណងជើង', previewText: 'ប្រវត្តិសាស្ត្រខ្មែរ', textColor: '#facc15', icon: '📖' },
  { id: 'mg-khmer-ribbon', name: 'Khmer Golden Ribbon', category: 'recent', duration: '00:04', thumbBg: 'bg-[#18191d] border-amber-600/30 text-amber-400', tag: 'កម្ពុជា', previewText: 'ព្រឹត្តិការណ៍ពិសេស', textColor: '#eab308', icon: '🎗️' },
];

export default function MotionGraphicPanel() {
  const { currentProject, currentTime, addSegment, loadProject } = useProjectStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<'Recent' | 'Favorite' | 'My motion' | 'Customize'>('Recent');
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [insertedToast, setInsertedToast] = useState(false);

  const filteredCards = MOTION_CARDS.filter((c) => {
    if (activeFilter === 'Favorite' && !favorites.has(c.id)) return false;
    if (searchQuery.trim() && !c.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const toggleFavorite = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleInsert = async (card: MotionGraphicCard) => {
    if (!currentProject?.id) return;
    const start = currentTime || 0;
    const end = start + 3.5;

    await addSegment({
      start_time: start,
      end_time: end,
      text: card.previewText,
      speaker: `[MG] ${card.name}`,
    });
    await loadProject(currentProject.id);

    setInsertedToast(true);
    setTimeout(() => setInsertedToast(false), 2500);
  };

  return (
    <div className="h-full flex flex-col bg-[#121316] text-[#e1e3e6] overflow-hidden select-none font-sans">
      {/* Search Bar */}
      <div className="p-3.5 pb-2 shrink-0">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search motion graphics..."
            className="w-full bg-[#181a1f] border border-[#24272f] rounded-xl px-3.5 py-2 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-[#3d424d]"
          />
        </div>

        {/* Filter Pills */}
        <div className="flex items-center gap-1.5 pt-2.5 overflow-x-auto scrollbar-none">
          {(['Recent', 'Favorite', 'My motion', 'Customize'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveFilter(tab)}
              className={`px-3 py-1 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${
                activeFilter === tab
                  ? 'bg-white text-black shadow-sm font-bold'
                  : 'bg-[#181a1f] text-zinc-400 hover:text-white hover:bg-[#20232a]'
              }`}
            >
              {tab === 'Customize' ? (
                <span className="flex items-center gap-1">
                  <SlidersHorizontal className="w-3 h-3" /> Customize
                </span>
              ) : (
                tab
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Success Toast */}
      {insertedToast && (
        <div className="mx-3.5 my-1 p-2 bg-emerald-950/60 border border-emerald-800 text-emerald-300 text-xs rounded-xl flex items-center gap-2 animate-in fade-in shrink-0">
          <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span>Motion graphic added to timeline @{currentTime.toFixed(1)}s!</span>
        </div>
      )}

      {/* 3-Column Motion Graphics Grid (Exact Meatika Layout) */}
      <div className="flex-1 overflow-y-auto px-3.5 py-2">
        <div className="grid grid-cols-3 gap-2.5">
          {filteredCards.map((card) => {
            const isFav = favorites.has(card.id);
            return (
              <div
                key={card.id}
                onClick={() => handleInsert(card)}
                className="flex flex-col cursor-pointer group"
              >
                {/* Thumbnail Card */}
                <div className="h-20 rounded-xl bg-[#181a1f] border border-[#22242a] group-hover:border-[#383d47] p-2 flex flex-col items-center justify-between relative overflow-hidden transition-all group-hover:scale-[1.02]">
                  <div className="w-full flex items-center justify-between">
                    <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-black/50 text-zinc-400 font-mono">
                      {card.tag}
                    </span>
                    <button
                      onClick={(e) => toggleFavorite(card.id, e)}
                      className={`p-0.5 transition-colors ${
                        isFav ? 'text-rose-500' : 'text-zinc-600 hover:text-zinc-300'
                      }`}
                    >
                      <Heart className={`w-3 h-3 ${isFav ? 'fill-rose-500' : ''}`} />
                    </button>
                  </div>

                  <div className="text-xl group-hover:scale-125 transition-transform duration-300">
                    {card.icon}
                  </div>

                  <span className="text-[8px] text-zinc-500 font-mono">{card.duration}</span>
                </div>

                {/* Title */}
                <span className="text-[10px] text-zinc-400 group-hover:text-white mt-1 truncate px-0.5 font-medium">
                  {card.name}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
