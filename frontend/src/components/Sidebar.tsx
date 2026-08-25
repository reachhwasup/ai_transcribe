import { useState } from 'react';
import {
  Sparkles,
  Volume2,
  Smile,
  Image as ImageIcon,
  Flame,
  Music,
} from 'lucide-react';
import MotionGraphicPanel from './MotionGraphicPanel';
import SoundEffectPanel from './SoundEffectPanel';
import MemesGifPanel from './MemesGifPanel';

interface SidebarProps {
  onOpenExport?: () => void;
  audioSeparated?: boolean;
  onAudioSeparated?: (vocalsUrl: string, bgmUrl: string) => void;
}

export default function Sidebar({}: SidebarProps) {
  const [activeLibraryTab, setActiveLibraryTab] = useState<'motion' | 'sfx' | 'memes' | 'gif'>('motion');

  const LIBRARY_TABS = [
    {
      id: 'motion',
      label: 'Motion Graphics',
      short: 'Motion',
      icon: <Sparkles className="w-3.5 h-3.5 text-amber-400" />,
      color: 'text-amber-400',
      desc: 'Animated Titles & Lower Thirds',
    },
    {
      id: 'sfx',
      label: 'Sound Effects',
      short: 'SFX',
      icon: <Volume2 className="w-3.5 h-3.5 text-blue-400" />,
      color: 'text-blue-400',
      desc: 'Whooshes, Pops & UI Audio',
    },
    {
      id: 'memes',
      label: 'Viral Memes',
      short: 'Memes',
      icon: <Smile className="w-3.5 h-3.5 text-emerald-400" />,
      color: 'text-emerald-400',
      desc: 'Khmer & Trending Meme Soundbites',
    },
    {
      id: 'gif',
      label: 'GIFs & Stickers',
      short: 'GIFs',
      icon: <ImageIcon className="w-3.5 h-3.5 text-pink-400" />,
      color: 'text-pink-400',
      desc: 'Animated Reaction Stickers',
    },
  ] as const;

  return (
    <div className="flex flex-col h-full bg-[#121316] text-[#e1e3e6] select-none font-sans overflow-hidden">
      {/* Sub-library Tabs Header */}
      <div className="h-10 border-b border-[#1c1e24] bg-[#121316] flex items-center px-4 gap-1.5 shrink-0 overflow-x-auto scrollbar-none">
        {LIBRARY_TABS.map((tab) => {
          const isActive = activeLibraryTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveLibraryTab(tab.id as any)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${
                isActive
                  ? 'bg-[#22242b] text-white shadow-sm ring-1 ring-white/10'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-[#17191e]'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Library Tab Content */}
      <div className="flex-1 overflow-hidden">
        {activeLibraryTab === 'motion' && <MotionGraphicPanel />}
        {activeLibraryTab === 'sfx' && <SoundEffectPanel />}
        {activeLibraryTab === 'memes' && <MemesGifPanel initialMode="memes" />}
        {activeLibraryTab === 'gif' && <MemesGifPanel initialMode="gif" />}
      </div>
    </div>
  );
}
