import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import { useProjectStore } from '../stores/projectStore';
import {
  Film,
  Plus,
  X,
  Sparkles,
  Search,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Video,
} from 'lucide-react';

interface TabItem {
  id: string;
  name: string;
}

export default function ProjectTabBar() {
  const navigate = useNavigate();
  const { id: currentProjectId } = useParams<{ id: string }>();
  const { projects, currentProject, loadProjects, createProject } = useProjectStore();

  const [tabs, setTabs] = useState<TabItem[]>(() => {
    try {
      const saved = localStorage.getItem('meatika_open_tabs');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [showDropdown, setShowDropdown] = useState(false);
  const [showNewModal, setShowNewModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectLang, setNewProjectLang] = useState('km');
  const [searchFilter, setSearchFilter] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Sync projects list
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Check scroll overflows
  const checkScroll = () => {
    if (!scrollRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current;
    setCanScrollLeft(scrollLeft > 4);
    setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 4);
  };

  useEffect(() => {
    checkScroll();
    window.addEventListener('resize', checkScroll);
    return () => window.removeEventListener('resize', checkScroll);
  }, [tabs]);

  // Keep tabs list updated with the currently open project
  useEffect(() => {
    if (!currentProject?.id) return;
    setTabs((prev) => {
      const exists = prev.find((t) => t.id === currentProject.id);
      let updated: TabItem[];
      if (exists) {
        // Update name in case it changed
        updated = prev.map((t) =>
          t.id === currentProject.id ? { ...t, name: currentProject.name || 'Untitled Video' } : t
        );
      } else {
        updated = [...prev, { id: currentProject.id, name: currentProject.name || 'Untitled Video' }];
      }
      try {
        localStorage.setItem('meatika_open_tabs', JSON.stringify(updated));
      } catch {}
      return updated;
    });
  }, [currentProject?.id, currentProject?.name]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    if (showDropdown) {
      window.addEventListener('mousedown', handleClickOutside);
    }
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [showDropdown]);

  const handleSelectTab = (tabId: string) => {
    if (tabId === currentProjectId) return;
    navigate(`/project/${tabId}`);
  };

  const handleCloseTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    const remaining = tabs.filter((t) => t.id !== tabId);
    setTabs(remaining);
    try {
      localStorage.setItem('meatika_open_tabs', JSON.stringify(remaining));
    } catch {}

    // If closing active tab, navigate to adjacent tab or dashboard
    if (tabId === currentProjectId) {
      if (remaining.length > 0) {
        const closedIdx = tabs.findIndex((t) => t.id === tabId);
        const nextTab = remaining[Math.min(closedIdx, remaining.length - 1)];
        navigate(`/project/${nextTab.id}`);
      } else {
        navigate('/');
      }
    }
  };

  const handleCreateNew = async () => {
    if (!newProjectName.trim() || isCreating) return;
    setIsCreating(true);
    try {
      const project = await createProject(newProjectName.trim(), '', newProjectLang);
      const newTabs = [...tabs.filter((t) => t.id !== project.id), { id: project.id, name: project.name }];
      setTabs(newTabs);
      localStorage.setItem('meatika_open_tabs', JSON.stringify(newTabs));
      setShowNewModal(false);
      setShowDropdown(false);
      setNewProjectName('');
      navigate(`/project/${project.id}`);
    } catch (err) {
      console.error('Failed to create tab project:', err);
    } finally {
      setIsCreating(false);
    }
  };

  const handleOpenExisting = (proj: { id: string; name: string }) => {
    const newTabs = tabs.find((t) => t.id === proj.id)
      ? tabs
      : [...tabs, { id: proj.id, name: proj.name || 'Untitled Video' }];
    setTabs(newTabs);
    localStorage.setItem('meatika_open_tabs', JSON.stringify(newTabs));
    setShowDropdown(false);
    navigate(`/project/${proj.id}`);
  };

  const scrollTabs = (dir: 'left' | 'right') => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollBy({ left: dir === 'left' ? -160 : 160, behavior: 'smooth' });
    setTimeout(checkScroll, 200);
  };

  const filteredProjects = projects.filter((p) => {
    if (!searchFilter.trim()) return true;
    const q = searchFilter.toLowerCase();
    return p.name?.toLowerCase().includes(q) || p.video_filename?.toLowerCase().includes(q);
  });

  return (
    <div className="flex items-center flex-1 min-w-0 max-w-5xl mx-2 h-full">
      {/* Tabs Container */}
      <div className="relative flex items-center flex-1 min-w-0 h-full">
        {/* Scroll Left Button */}
        {canScrollLeft && (
          <button
            onClick={() => scrollTabs('left')}
            className="absolute left-0 z-20 h-7 w-5 flex items-center justify-center bg-gradient-to-r from-[#121316] via-[#121316]/90 to-transparent text-zinc-400 hover:text-white"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Scrollable Tabs Track */}
        <div
          ref={scrollRef}
          onScroll={checkScroll}
          className="flex items-center gap-1.5 overflow-x-auto scrollbar-none h-full py-1 px-1 transition-all"
        >
          {tabs.map((tab) => {
            const isActive = tab.id === currentProjectId;
            return (
              <div
                key={tab.id}
                onClick={() => handleSelectTab(tab.id)}
                className={`group relative flex items-center gap-2 px-3 py-1.5 h-[34px] rounded-xl cursor-pointer transition-all duration-150 shrink-0 max-w-[200px] select-none ${
                  isActive
                    ? 'bg-gradient-to-b from-[#232735] to-[#1a1c27] text-white shadow-md shadow-black/40 ring-1 ring-white/10 font-semibold'
                    : 'bg-[#15171d]/60 hover:bg-[#1c1e28] text-zinc-400 hover:text-zinc-200 border border-transparent'
                }`}
                title={tab.name}
              >
                {/* Visual Icon */}
                <div
                  className={`w-4 h-4 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                    isActive
                      ? 'bg-purple-500/20 text-purple-300'
                      : 'text-zinc-500 group-hover:text-zinc-400'
                  }`}
                >
                  <Film className="w-3 h-3" />
                </div>

                {/* Tab Title */}
                <span className="text-xs truncate flex-1 font-sans">{tab.name}</span>

                {/* Close Tab Button */}
                <button
                  type="button"
                  onClick={(e) => handleCloseTab(e, tab.id)}
                  className={`w-4 h-4 rounded-md flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/10 transition-all ${
                    isActive ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-100'
                  }`}
                  title="Close Tab"
                >
                  <X className="w-3 h-3" />
                </button>

                {/* Active Indicator Underline Glow */}
                {isActive && (
                  <div className="absolute bottom-0 left-3 right-3 h-[2px] bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 rounded-full shadow-[0_0_8px_rgba(168,85,247,0.6)]" />
                )}
              </div>
            );
          })}
        </div>

        {/* Scroll Right Button */}
        {canScrollRight && (
          <button
            onClick={() => scrollTabs('right')}
            className="absolute right-8 z-20 h-7 w-5 flex items-center justify-center bg-gradient-to-l from-[#121316] via-[#121316]/90 to-transparent text-zinc-400 hover:text-white"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Plus / Add Tab Button */}
        <div className="relative shrink-0 ml-1.5" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setShowDropdown(!showDropdown)}
            className={`w-[30px] h-[30px] rounded-xl flex items-center justify-center transition-all cursor-pointer ${
              showDropdown
                ? 'bg-purple-600 text-white shadow-lg shadow-purple-950/60 ring-1 ring-purple-400/40'
                : 'bg-[#171920] hover:bg-[#222632] border border-[#262a36] text-zinc-400 hover:text-white hover:border-zinc-600 shadow-sm'
            }`}
            title="Open or Create Video Tab"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>

          {/* Tab Management Dropdown Menu */}
          {showDropdown && (
            <div className="absolute left-0 top-full mt-2 w-80 bg-[#151722]/98 border border-[#2b3042] rounded-2xl shadow-2xl p-2.5 z-50 backdrop-blur-xl space-y-2 animate-in zoom-in-95 duration-150">
              {/* New Video Action */}
              <button
                type="button"
                onClick={() => {
                  setShowDropdown(false);
                  setShowNewModal(true);
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-gradient-to-r from-purple-600/20 via-pink-600/20 to-purple-600/10 hover:from-purple-600/30 hover:to-pink-600/30 border border-purple-500/30 text-purple-200 hover:text-white text-xs font-bold transition-all text-left group cursor-pointer shadow-sm"
              >
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white shadow-md shadow-purple-950/40 group-hover:scale-105 transition-transform">
                  <Plus className="w-4 h-4" />
                </div>
                <div>
                  <div className="font-semibold text-white">Create New Video Project</div>
                  <div className="text-[10px] text-zinc-400 font-normal">Start fresh with auto-transcribe</div>
                </div>
              </button>

              {/* Open Existing Projects List */}
              <div className="space-y-1.5 pt-1.5 border-t border-[#232738]">
                <div className="flex items-center justify-between px-2 text-[10px] uppercase font-bold text-zinc-400 tracking-wider">
                  <span>Open Video in Tab</span>
                  <span className="font-mono text-zinc-500">{projects.length} Total</span>
                </div>

                {/* Quick Search */}
                {projects.length > 3 && (
                  <div className="relative px-1 pb-1">
                    <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
                    <input
                      type="text"
                      value={searchFilter}
                      onChange={(e) => setSearchFilter(e.target.value)}
                      placeholder="Filter by name..."
                      className="w-full bg-[#10121a] border border-[#272c3d] rounded-xl pl-8 pr-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500 font-sans"
                    />
                  </div>
                )}

                <div className="max-h-52 overflow-y-auto space-y-1 custom-scrollbar pr-1">
                  {filteredProjects.length === 0 ? (
                    <div className="p-4 text-center text-xs text-zinc-500">No matching videos found</div>
                  ) : (
                    filteredProjects.map((p) => {
                      const isAlreadyOpen = tabs.some((t) => t.id === p.id);
                      const isCurrent = p.id === currentProjectId;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => handleOpenExisting(p)}
                          className={`w-full flex items-center justify-between gap-2.5 px-3 py-2 rounded-xl text-xs transition-all text-left cursor-pointer ${
                            isCurrent
                              ? 'bg-purple-950/50 border border-purple-500/30 text-purple-200 font-semibold'
                              : 'hover:bg-[#1d202c] text-zinc-300 hover:text-white border border-transparent'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 truncate">
                            <div
                              className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 ${
                                isCurrent ? 'bg-purple-500/30 text-purple-300' : 'bg-[#12141c] text-zinc-500'
                              }`}
                            >
                              <Video className="w-3 h-3" />
                            </div>
                            <span className="truncate font-medium">{p.name || 'Untitled Video'}</span>
                          </div>
                          {isAlreadyOpen ? (
                            <span className="text-[9px] px-2 py-0.5 rounded-full bg-emerald-950/60 text-emerald-400 font-semibold border border-emerald-800/40 shrink-0">
                              Active
                            </span>
                          ) : null}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Quick New Project Modal in New Tab */}
      {showNewModal &&
        createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-150">
            <div className="bg-[#151722] border border-[#2b3042] rounded-3xl p-6 w-full max-w-sm shadow-2xl space-y-5 animate-in zoom-in-95 duration-150">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 text-white flex items-center justify-center font-bold shadow-md shadow-purple-950/50">
                    <Plus className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">New Video Project Tab</h3>
                    <p className="text-[11px] text-zinc-400">Open a parallel project workspace</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowNewModal(false)}
                  className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-3.5">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-semibold text-zinc-300">Project Title</label>
                  <input
                    type="text"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleCreateNew()}
                    placeholder="e.g. Episode 2 Recap"
                    autoFocus
                    className="w-full px-3.5 py-2.5 bg-[#0f1118] border border-[#272c3d] rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500 transition-colors shadow-inner"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-semibold text-zinc-300">Default Transcribe Language</label>
                  <select
                    value={newProjectLang}
                    onChange={(e) => setNewProjectLang(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-[#0f1118] border border-[#272c3d] rounded-xl text-xs text-white focus:outline-none focus:border-purple-500 transition-colors cursor-pointer"
                  >
                    <option value="km">🇰🇭 ខ្មែរ (Khmer)</option>
                    <option value="en">🇺🇸 English</option>
                    <option value="zh">🇨🇳 Chinese</option>
                    <option value="th">🇹🇭 Thai</option>
                    <option value="vi">🇻🇳 Vietnamese</option>
                    <option value="ja">🇯🇵 Japanese</option>
                    <option value="ko">🇰🇷 Korean</option>
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewModal(false)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleCreateNew}
                  disabled={!newProjectName.trim() || isCreating}
                  className="px-4 py-2 rounded-xl bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 disabled:opacity-50 text-white font-bold text-xs shadow-lg shadow-purple-950/50 transition-all active:scale-95 cursor-pointer"
                >
                  {isCreating ? 'Creating...' : 'Open in New Tab'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
