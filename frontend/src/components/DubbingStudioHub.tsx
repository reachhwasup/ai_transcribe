import { useState } from 'react';
import { Mic, Film } from 'lucide-react';
import DubbingStudioPanel from './DubbingStudioPanel';
import NarrationPanel from './NarrationPanel';

export default function DubbingStudioHub() {
  const [activeDubTab, setActiveDubTab] = useState<'character' | 'recap' | 'social'>('character');

  return (
    <div className="flex flex-col h-full bg-[#121316] text-[#e1e3e6] select-none font-sans overflow-hidden [contain:strict]">
      {/* Sub-tabs header for Character Dubbing, Movie Recap & Shorts Studio */}
      <div className="h-10 border-b border-[#1c1e24] bg-[#121316] flex items-center px-4 gap-1.5 shrink-0 overflow-x-auto scrollbar-none">
        {[
          { id: 'character', label: 'Character Dubbing', icon: <Mic className="w-3.5 h-3.5 text-purple-400" /> },
          { id: 'recap', label: 'Movie Recap Narration', icon: <Film className="w-3.5 h-3.5 text-blue-400" /> },
          { id: 'social', label: 'Shorts & Social Studio', icon: <Film className="w-3.5 h-3.5 text-pink-400" /> },
        ].map((tab) => {
          const isActive = activeDubTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveDubTab(tab.id as any)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all duration-150 cursor-pointer ${
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

      {/* Body content — hardware-accelerated smooth visibility switches */}
      <div className="flex-1 overflow-hidden relative [contain:content]">
        <div
          className={`h-full w-full transition-opacity duration-150 ease-out ${
            activeDubTab === 'character'
              ? 'opacity-100 visible relative z-10'
              : 'opacity-0 invisible pointer-events-none absolute inset-0 z-0'
          }`}
        >
          <DubbingStudioPanel />
        </div>
        <div
          className={`h-full w-full transition-opacity duration-150 ease-out ${
            activeDubTab !== 'character'
              ? 'opacity-100 visible relative z-10'
              : 'opacity-0 invisible pointer-events-none absolute inset-0 z-0'
          }`}
        >
          <NarrationPanel
            initialTab={activeDubTab === 'social' ? 'social' : 'narration'}
            hideInnerTabs={true}
          />
        </div>
      </div>
    </div>
  );
}
