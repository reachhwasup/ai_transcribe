import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useProjectStore } from '../stores/projectStore';
import { checkAudioSeparation, deleteAudioSeparation, uploadVideo } from '../api/client';
import VideoPlayer from '../components/VideoPlayer';
import SubtitleDataPanel from '../components/SubtitleDataPanel';
import TimelineEditorPro from '../components/TimelineEditorPro';
import StatusBar from '../components/StatusBar';
import SettingsModal from '../components/SettingsModal';
import ExportModal from '../components/ExportModal';

import MediaPool from '../components/MediaPool';
import Sidebar from '../components/Sidebar';
import MeatikaTTSPanel from '../components/MeatikaTTSPanel';
import AIAssistantPanel from '../components/AIAssistantPanel';
import CaptionPropertiesPanel from '../components/CaptionPropertiesPanel';
import DubbingStudioHub from '../components/DubbingStudioHub';

import {
  LayoutGrid,
  Search,
  Upload,
  FolderPlus,
  List,
  ArrowUpDown,
  Trash2,
  GripVertical,
  GripHorizontal,
  Loader2,
  Smile,
  User,
  Settings,
  Film,
} from 'lucide-react';
import { useThemeStore } from '../stores/themeStore';

type MeatikaLeftTab = 'tts' | 'ai';
type MeatikaCenterTab = 'assets' | 'library' | 'captions' | 'dubbing';

export default function ProjectEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const {
    currentProject,
    isLoading,
    error,
    loadProject,
    clearError,
    selectedSegmentIds,
    activeSegmentId,
    setActiveSegment,
    updateSegment,
    deleteSegment,
    deleteMultipleSegments,
    deleteAllSegments,
    audioSeparated,
    vocalsUrl,
    bgmUrl,
    setAudioSeparated,
  } = useProjectStore();
  const { mode, toggle: toggleTheme } = useThemeStore();

  const videoRef = useRef<HTMLVideoElement>(null);
  const vocalsRef = useRef<HTMLAudioElement>(null);
  const bgmRef = useRef<HTMLAudioElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Modals state
  const [showSettings, setShowSettings] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);

  // Tabs
  const [leftTab, setLeftTab] = useState<MeatikaLeftTab>('tts');
  const [centerTab, setCenterTab] = useState<MeatikaCenterTab>('captions');
  const [searchQuery, setSearchQuery] = useState('');

  // Panel sizing
  const [leftPanelWidth, setLeftPanelWidth] = useState(() => Number(localStorage.getItem('editor-left-panel-width')) || 380);
  const [timelineHeight, setTimelineHeight] = useState(() => Number(localStorage.getItem('editor-timeline-height')) || 280);

  useEffect(() => {
    localStorage.setItem('editor-left-panel-width', String(leftPanelWidth));
  }, [leftPanelWidth]);
  useEffect(() => {
    localStorage.setItem('editor-timeline-height', String(timelineHeight));
  }, [timelineHeight]);

  const draggingRef = useRef<'leftPanel' | 'timeline' | null>(null);
  const startPosRef = useRef(0);
  const startSizeRef = useRef(0);

  const handleResizeStart = useCallback((e: React.MouseEvent, target: 'leftPanel' | 'timeline') => {
    e.preventDefault();
    draggingRef.current = target;
    startPosRef.current = target === 'leftPanel' ? e.clientX : e.clientY;
    startSizeRef.current = target === 'leftPanel' ? leftPanelWidth : timelineHeight;

    const handleMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      if (draggingRef.current === 'leftPanel') {
        const dx = ev.clientX - startPosRef.current;
        setLeftPanelWidth(Math.max(280, Math.min(600, startSizeRef.current + dx)));
      } else {
        const dy = startPosRef.current - ev.clientY;
        setTimelineHeight(Math.max(120, Math.min(500, startSizeRef.current + dy)));
      }
    };

    const handleUp = () => {
      draggingRef.current = null;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [leftPanelWidth, timelineHeight]);

  useEffect(() => {
    if (id) loadProject(id);
  }, [id]);

  useEffect(() => {
    if (!id || currentProject?.preview_status !== 'generating') return;
    const timer = setInterval(() => loadProject(id), 5000);
    return () => clearInterval(timer);
  }, [id, currentProject?.preview_status]);

  // Sync separated audio elements with video playback
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // When audio is separated, mute video's embedded audio track so user only hears isolated stems
    if (audioSeparated) {
      video.muted = true;
    }

    const syncTime = () => {
      const vocals = vocalsRef.current;
      const bgm = bgmRef.current;
      if (vocals && Math.abs(vocals.currentTime - video.currentTime) > 0.5) {
        vocals.currentTime = video.currentTime;
      }
      if (bgm && Math.abs(bgm.currentTime - video.currentTime) > 0.5) {
        bgm.currentTime = video.currentTime;
      }
    };

    const handlePlay = () => {
      if (audioSeparated) {
        video.muted = true;
        video.volume = 0;
      }
      if (!audioSeparated) return;
      syncTime();
      if (vocalsRef.current) {
        vocalsRef.current.playbackRate = video.playbackRate;
        vocalsRef.current.play().catch(() => {});
      }
      if (bgmRef.current) {
        bgmRef.current.playbackRate = video.playbackRate;
        bgmRef.current.play().catch(() => {});
      }
    };

    const handlePause = () => {
      vocalsRef.current?.pause();
      bgmRef.current?.pause();
    };

    const handleSeeked = () => {
      if (audioSeparated) syncTime();
    };

    const handleRateChange = () => {
      if (vocalsRef.current) vocalsRef.current.playbackRate = video.playbackRate;
      if (bgmRef.current) bgmRef.current.playbackRate = video.playbackRate;
    };

    const driftInterval = setInterval(() => {
      if (!audioSeparated || video.paused) return;
      const vocals = vocalsRef.current;
      const bgm = bgmRef.current;
      const vt = video.currentTime;
      if (vocals && Math.abs(vocals.currentTime - vt) > 0.75) vocals.currentTime = vt;
      if (bgm && Math.abs(bgm.currentTime - vt) > 0.75) bgm.currentTime = vt;
    }, 2000);

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('seeked', handleSeeked);
    video.addEventListener('ratechange', handleRateChange);

    if (audioSeparated && !video.paused) {
      handlePlay();
    }

    return () => {
      clearInterval(driftInterval);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('seeked', handleSeeked);
      video.removeEventListener('ratechange', handleRateChange);
    };
  }, [audioSeparated, vocalsUrl, bgmUrl]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.target as HTMLElement)?.isContentEditable) return;
      if (showSettings || showExportModal) return;

      const video = videoRef.current;

      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('timeline-delete-selected'));
          }
          break;

        case '=':
        case '+':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('timeline-zoom', { detail: 'in' }));
          }
          break;

        case '-':
        case '_':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('timeline-zoom', { detail: 'out' }));
          }
          break;

        case 'z':
        case 'Z':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (e.shiftKey) {
              window.dispatchEvent(new CustomEvent('timeline-redo'));
            } else {
              window.dispatchEvent(new CustomEvent('timeline-undo'));
            }
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showSettings, showExportModal]);

  const handleAudioSeparated = (newVocalsUrl: string, newBgmUrl: string) => {
    setAudioSeparated(true, newVocalsUrl, newBgmUrl);
  };

  const handleRemoveAudioSeparation = async () => {
    if (!currentProject?.id) return;
    try {
      await deleteAudioSeparation(currentProject.id);
      setAudioSeparated(false, null, null);
      if (vocalsRef.current) { vocalsRef.current.pause(); vocalsRef.current.src = ''; }
      if (bgmRef.current) { bgmRef.current.pause(); bgmRef.current.src = ''; }
    } catch (e) {
      console.error('Failed to remove separated audio:', e);
    }
  };

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProject?.id) return;
    if (fileInputRef.current) fileInputRef.current.value = '';
    await uploadVideo(currentProject.id, file);
    await loadProject(currentProject.id);
  };

  if (isLoading && !currentProject) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#0d0e11]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-10 h-10 text-white animate-spin" />
          <p className="text-xs text-zinc-400 font-medium tracking-wide">Opening Meatika Editor...</p>
          <button
            onClick={() => id && loadProject(id)}
            className="mt-4 px-4 py-1.5 text-xs text-zinc-400 hover:text-white bg-white/5 hover:bg-white/10 rounded-lg border border-white/10 transition-all"
          >
            Click to Retry Connection
          </button>
        </div>
      </div>
    );
  }

  if (!currentProject) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#0d0e11]">
        <div className="text-center">
          <p className="text-zinc-400 mb-4">{error || 'Project not found or server reconnecting...'}</p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => id && loadProject(id)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow-lg transition-all"
            >
              Retry Loading
            </button>
            <button
              onClick={() => navigate('/')}
              className="text-zinc-400 hover:text-white text-xs font-medium px-3 py-2"
            >
              Back to Projects
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[#0d0e11] text-[#e1e3e6] select-none font-sans">
      {/* Global Error Toast */}
      {error && (
        <div className="fixed top-4 right-4 z-50 bg-red-950/95 border border-red-800 text-red-200 px-4 py-3 rounded-xl shadow-2xl max-w-md animate-in slide-in-from-top-2">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs leading-relaxed">{error}</p>
            <button onClick={clearError} className="text-red-400 hover:text-red-200 text-xs shrink-0">✕</button>
          </div>
        </div>
      )}

      {/* Top Header Bar — Exact Meatika Design */}
      <header className="h-12 border-b border-[#1c1e24] bg-[#121316] px-4 flex items-center justify-between shrink-0 z-30">
        {/* Left: Meatika 2x2 App Grid Icon */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-[#1f2127] transition-colors"
            title="Meatika Menu"
          >
            <div className="grid grid-cols-2 gap-0.5 w-4 h-4">
              <div className="w-1.5 h-1.5 rounded-sm bg-zinc-300" />
              <div className="w-1.5 h-1.5 rounded-sm bg-zinc-300" />
              <div className="w-1.5 h-1.5 rounded-sm bg-zinc-300" />
              <div className="w-1.5 h-1.5 rounded-sm bg-zinc-300" />
            </div>
          </button>
        </div>

        {/* Right Actions: Export Video & Avatar */}
        <div className="flex items-center gap-2.5">

          <button
            onClick={() => setShowExportModal(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#e5e5e9] hover:bg-white text-black font-semibold text-xs shadow-sm active:scale-95 transition-all"
          >
            <Smile className="w-3.5 h-3.5 text-black" />
            <span>Export Video</span>
          </button>


          {/* Settings Button */}
          <button
            onClick={() => setShowSettings(true)}
            className="w-8 h-8 rounded-lg bg-[#181a20] border border-[#262933] hover:border-[#3b4050] hover:bg-[#22252e] text-zinc-300 hover:text-white flex items-center justify-center shadow-sm transition-all active:scale-95"
            title="Settings"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Workspace Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Tool Panel (TTS & AI only, matching Meatika) */}
        <div
          className="shrink-0 border-r border-[#1c1e24] bg-[#121316] flex flex-col overflow-hidden"
          style={{ width: leftPanelWidth }}
        >
          {/* Top Horizontal Tool Tabs (TTS | AI) */}
          <div className="h-10 border-b border-[#1c1e24] bg-[#121316] flex items-center px-3 gap-1 shrink-0">
            {([
              { id: 'tts', label: 'TTS' },
              { id: 'ai', label: 'AI' },
            ] as const).map((tab) => {
              const isActive = leftTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setLeftTab(tab.id as MeatikaLeftTab)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-all ${
                    isActive
                      ? 'bg-[#22242b] text-white shadow-sm ring-1 ring-white/10'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-[#17191e]'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* Active Tool Content */}
          <div className="flex-1 overflow-hidden">
            {leftTab === 'tts' && <MeatikaTTSPanel />}
            {leftTab === 'ai' && <AIAssistantPanel />}
          </div>
        </div>

        {/* Left Panel Resize Handle */}
        <div
          className="w-1 shrink-0 bg-[#1c1e24] hover:bg-white/40 cursor-col-resize transition-colors relative group"
          onMouseDown={(e) => handleResizeStart(e, 'leftPanel')}
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
          <div className="absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
            <GripVertical className="w-3 h-3 text-white" />
          </div>
        </div>

        {/* Center Production Hub (MY ASSETS, LIBRARY, CAPTIONS, DUBBING) */}
        <div className="flex-1 flex flex-col border-r border-[#1c1e24] min-w-[320px] overflow-hidden bg-[#121316]">
          {/* Top Tabs */}
          <div className="h-10 border-b border-[#1c1e24] bg-[#121316] flex items-center px-4 gap-2 shrink-0">
            {([
              { id: 'assets', label: 'MY ASSETS' },
              { id: 'library', label: 'LIBRARY' },
              { id: 'captions', label: 'CAPTIONS' },
              { id: 'dubbing', label: 'DUBBING & RECAP' },
            ] as const).map((tab) => {
              const isActive = centerTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setCenterTab(tab.id as MeatikaCenterTab)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold tracking-wider transition-all ${
                    isActive
                      ? 'bg-[#22242b] text-white shadow-sm ring-1 ring-white/10'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-[#17191e]'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* Subheader Toolbar (Search + Action Buttons) */}
          <div className="px-4 py-2 border-b border-[#1c1e24] bg-[#121316] flex items-center justify-between gap-3 shrink-0">
            {/* Search Input */}
            <div className="relative flex-1 max-w-xs">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search media..."
                className="w-full bg-[#181a1f] border border-[#26282e] rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-[#3d424d]"
              />
            </div>

            {/* Action Buttons: Upload, Folder, View, Sort, Delete */}
            <div className="flex items-center gap-1 text-zinc-400">
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*,audio/*,image/*"
                className="hidden"
                onChange={handleUploadFile}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-1.5 rounded-lg hover:bg-[#1e2025] hover:text-white transition-colors"
                title="Upload Media"
              >
                <Upload className="w-4 h-4" />
              </button>

              <button
                onClick={() => {
                  const folderName = prompt('Enter new folder name:');
                  if (folderName) alert(`Folder "${folderName}" created.`);
                }}
                className="p-1.5 rounded-lg hover:bg-[#1e2025] hover:text-white transition-colors"
                title="New Folder"
              >
                <FolderPlus className="w-4 h-4" />
              </button>

              <button
                className="p-1.5 rounded-lg hover:bg-[#1e2025] hover:text-white transition-colors"
                title="List / Grid View"
              >
                <List className="w-4 h-4" />
              </button>

              <button
                className="p-1.5 rounded-lg hover:bg-[#1e2025] hover:text-white transition-colors"
                title="Sort Order"
              >
                <ArrowUpDown className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Center Tab Body */}
          <div className="flex-1 overflow-hidden flex flex-col bg-[#121316]">
            {centerTab === 'assets' && (
              <MediaPool
                videoRef={videoRef}
                vocalsUrl={vocalsUrl}
                bgmUrl={bgmUrl}
                audioSeparated={audioSeparated}
              />
            )}

            {centerTab === 'library' && (
              <Sidebar
                onOpenExport={() => setShowExportModal(true)}
                audioSeparated={audioSeparated}
                onAudioSeparated={handleAudioSeparated}
              />
            )}

            {centerTab === 'captions' && (
              <div className="flex-1 flex flex-col overflow-hidden">
                <SubtitleDataPanel videoRef={videoRef} />
              </div>
            )}

            {centerTab === 'dubbing' && <DubbingStudioHub />}
          </div>
        </div>

        {/* Right Top: Video Canvas Viewport */}
        <div className="w-[45%] shrink-0 flex flex-col overflow-hidden bg-black">
          <VideoPlayer videoRef={videoRef} />
        </div>
      </div>

      {/* Timeline Resize Handle */}
      <div
        className="h-1 shrink-0 bg-[#1c1e24] hover:bg-white/40 cursor-row-resize transition-colors relative group"
        onMouseDown={(e) => handleResizeStart(e, 'timeline')}
      >
        <div className="absolute inset-x-0 -top-1 -bottom-1" />
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
          <GripHorizontal className="w-3 h-3 text-white" />
        </div>
      </div>

      {/* Bottom Multi-Track Timeline */}
      <div className="border-t border-[#1c1e24] shrink-0" style={{ height: timelineHeight }}>
        <TimelineEditorPro
          videoRef={videoRef}
          vocalsRef={vocalsRef}
          bgmRef={bgmRef}
          audioSeparated={audioSeparated}
          onAudioSeparated={handleAudioSeparated}
          onRemoveAudioSeparation={handleRemoveAudioSeparation}
        />
      </div>

      {/* Status Bar */}
      <StatusBar />

      {/* Modals */}
      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
      <ExportModal open={showExportModal} onClose={() => setShowExportModal(false)} />

      {/* Hidden Audio Elements for Separated Stems */}
      <audio ref={vocalsRef} src={vocalsUrl || undefined} preload="auto" style={{ display: 'none' }} />
      <audio ref={bgmRef} src={bgmUrl || undefined} preload="auto" style={{ display: 'none' }} />
    </div>
  );
}
