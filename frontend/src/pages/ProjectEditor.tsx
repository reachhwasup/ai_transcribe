import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useProjectStore } from '../stores/projectStore';
import { checkAudioSeparation, deleteAudioSeparation } from '../api/client';
import VideoPlayer from '../components/VideoPlayer';
import VideoEditToolbar from '../components/VideoEditToolbar';
import Sidebar from '../components/Sidebar';
import SubtitleDataPanel from '../components/SubtitleDataPanel';
import TimelineEditorPro from '../components/TimelineEditorPro';
import StatusBar from '../components/StatusBar';
import SettingsModal from '../components/SettingsModal';
import ExportModal from '../components/ExportModal';
import MediaPool from '../components/MediaPool';
import NarrationPanel from '../components/NarrationPanel';
import { ArrowLeft, Loader2, Settings, Moon, Sun, Video, GripVertical, GripHorizontal, Film, LayoutGrid, Mic, Music } from 'lucide-react';
import { useThemeStore } from '../stores/themeStore';

export default function ProjectEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { currentProject, isLoading, error, loadProject, clearError } = useProjectStore();
  const { mode, toggle: toggleTheme } = useThemeStore();
  const videoRef = useRef<HTMLVideoElement>(null);
  const vocalsRef = useRef<HTMLAudioElement>(null);
  const bgmRef = useRef<HTMLAudioElement>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [leftTab, setLeftTab] = useState<'media' | 'tools' | 'narrate'>('tools');

  // Resizable panel sizes
  // Layout defaults: wider left column (bigger video preview) and a taller
  // timeline; user drag adjustments persist across refreshes.
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem('editor-sidebar-width')) || 380);
  const [timelineHeight, setTimelineHeight] = useState(() => Number(localStorage.getItem('editor-timeline-height')) || 280);

  useEffect(() => {
    localStorage.setItem('editor-sidebar-width', String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    localStorage.setItem('editor-timeline-height', String(timelineHeight));
  }, [timelineHeight]);
  const draggingRef = useRef<'sidebar' | 'timeline' | null>(null);
  const startPosRef = useRef(0);
  const startSizeRef = useRef(0);

  const handleResizeStart = useCallback((e: React.MouseEvent, target: 'sidebar' | 'timeline') => {
    e.preventDefault();
    draggingRef.current = target;
    startPosRef.current = target === 'sidebar' ? e.clientX : e.clientY;
    startSizeRef.current = target === 'sidebar' ? sidebarWidth : timelineHeight;

    const handleMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      if (draggingRef.current === 'sidebar') {
        const dx = ev.clientX - startPosRef.current;
        setSidebarWidth(Math.max(220, Math.min(600, startSizeRef.current + dx)));
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
  }, [sidebarWidth, timelineHeight]);

  // Audio separation state
  const [audioSeparated, setAudioSeparated] = useState(false);
  const [vocalsUrl, setVocalsUrl] = useState<string | null>(null);
  const [bgmUrl, setBgmUrl] = useState<string | null>(null);

  useEffect(() => {
    if (id) loadProject(id);
  }, [id]);

  // Restore audio separation state on load — show V1/B1 tracks if already separated
  useEffect(() => {
    if (!currentProject?.id) return;
    checkAudioSeparation(currentProject.id).then((status) => {
      if (status.separated && status.vocals_url && status.bgm_url) {
        setVocalsUrl(status.vocals_url);
        setBgmUrl(status.bgm_url);
        setAudioSeparated(true);
      } else {
        setAudioSeparated(false);
        setVocalsUrl(null);
        setBgmUrl(null);
      }
    }).catch(() => {});
  }, [currentProject?.id]);

  // Sync separated audio elements with video playback
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !audioSeparated) return;

    const syncTime = () => {
      const vocals = vocalsRef.current;
      const bgm = bgmRef.current;
      if (vocals) vocals.currentTime = video.currentTime;
      if (bgm) bgm.currentTime = video.currentTime;
    };

    const handlePlay = () => {
      syncTime();
      vocalsRef.current?.play().catch(() => {});
      bgmRef.current?.play().catch(() => {});
    };

    const handlePause = () => {
      vocalsRef.current?.pause();
      bgmRef.current?.pause();
    };

    const handleSeeked = () => syncTime();

    // Periodic drift correction — every 3 seconds, re-sync if drift > 0.15s
    const driftInterval = setInterval(() => {
      if (video.paused) return;
      const vocals = vocalsRef.current;
      const bgm = bgmRef.current;
      const vt = video.currentTime;
      if (vocals && Math.abs(vocals.currentTime - vt) > 0.15) vocals.currentTime = vt;
      if (bgm && Math.abs(bgm.currentTime - vt) > 0.15) bgm.currentTime = vt;
    }, 3000);

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('seeked', handleSeeked);

    // If video is already playing when this effect mounts (e.g. after separation completes)
    if (!video.paused) handlePlay();

    return () => {
      clearInterval(driftInterval);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('seeked', handleSeeked);
    };
  }, [audioSeparated, vocalsUrl, bgmUrl]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs/textareas
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.target as HTMLElement)?.isContentEditable) return;

      // Don't trigger when settings/export modals are open
      if (showSettings || showExport) return;

      const video = videoRef.current;

      switch (e.key) {
        case ' ': // Space — Play/Pause
          e.preventDefault();
          if (video) {
            if (video.paused) video.play();
            else video.pause();
          }
          break;

        case 'ArrowLeft': // Seek backward
          e.preventDefault();
          if (video) {
            const step = e.shiftKey ? 1 : 5;
            video.currentTime = Math.max(0, video.currentTime - step);
          }
          break;

        case 'ArrowRight': // Seek forward
          e.preventDefault();
          if (video) {
            const step = e.shiftKey ? 1 : 5;
            video.currentTime = Math.min(video.duration || 0, video.currentTime + step);
          }
          break;

        case 's': // Split clip at playhead
        case 'S':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('timeline-split'));
          }
          break;

        case 'Delete': // Delete selected clip
        case 'Backspace':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('timeline-delete-selected'));
          }
          break;

        case 'm': // Mute/Unmute
        case 'M':
          if (video) {
            video.muted = !video.muted;
          }
          break;

        case 'Home': // Go to beginning
          e.preventDefault();
          if (video) video.currentTime = 0;
          break;

        case 'End': // Go to end
          e.preventDefault();
          if (video) video.currentTime = video.duration || 0;
          break;

        case '=': // Ctrl/Cmd + = → Zoom in
        case '+':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('timeline-zoom', { detail: 'in' }));
          }
          break;

        case '-': // Ctrl/Cmd + - → Zoom out
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('timeline-zoom', { detail: 'out' }));
          }
          break;

        case 'z': // Ctrl/Cmd + Z → Undo, Ctrl/Cmd + Shift + Z → Redo
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

        case 'y': // Ctrl/Cmd + Y → Redo (alternative)
        case 'Y':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('timeline-redo'));
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showSettings, showExport]);

  const handleAudioSeparated = (newVocalsUrl: string, newBgmUrl: string) => {
    setVocalsUrl(newVocalsUrl);
    setBgmUrl(newBgmUrl);
    setAudioSeparated(true);
  };

  const handleRemoveAudioSeparation = async () => {
    if (!currentProject?.id) return;
    try {
      await deleteAudioSeparation(currentProject.id);
      setAudioSeparated(false);
      setVocalsUrl(null);
      setBgmUrl(null);
      if (vocalsRef.current) { vocalsRef.current.pause(); vocalsRef.current.src = ''; }
      if (bgmRef.current) { bgmRef.current.pause(); bgmRef.current.src = ''; }
    } catch (e) {
      console.error('Failed to remove separated audio:', e);
    }
  };

  if (isLoading && !currentProject) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--bg-base)' }}>
        <Loader2 className="w-8 h-8 text-khmer-500 animate-spin" />
      </div>
    );
  }

  if (!currentProject) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--bg-base)' }}>
        <div className="text-center">
          <p className="text-zinc-400 mb-4">Project not found</p>
          <button
            onClick={() => navigate('/')}
            className="text-khmer-400 hover:text-khmer-300 text-sm"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg-base)' }}>
      {/* Error Toast */}
      {error && (
        <div className={`fixed top-4 right-4 z-50 border text-red-200 px-4 py-3 rounded-lg shadow-lg ${
          error.includes('quota') || error.includes('API')
            ? 'bg-red-900/95 border-red-600 max-w-lg'
            : 'bg-red-900/90 border-red-700 max-w-md'
        }`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              {(error.includes('quota') || error.includes('API')) && (
                <p className="text-xs font-bold text-red-400 mb-1 uppercase tracking-wide">⚠ API Quota Exceeded</p>
              )}
              <p className="text-sm leading-relaxed">{error}</p>
            </div>
            <button onClick={clearError} className="text-red-400 hover:text-red-200 text-xs shrink-0 mt-0.5">
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Top Header Bar — DAI Dubber Pro style */}
      <header className="flex items-center justify-between px-4 py-2 border-b shrink-0" style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-panel)' }}>
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--text-secondary)' }}
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-khmer-500 to-purple-600 flex items-center justify-center shadow-lg shadow-khmer-500/20">
            <span className="text-base">🎬</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold" style={{ color: 'var(--text-bright)' }}>DAI Dubber Pro</h1>
              <span className="text-sm">👑</span>
            </div>
            <p className="text-[10px] text-khmer-400 font-medium">
              Khmer Edition Workspace - PRO
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            title={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {mode === 'dark' ? (
              <Moon className="w-4 h-4" />
            ) : (
              <Sun className="w-4 h-4 text-amber-500" />
            )}
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 rounded-lg transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            title="Settings"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Panel — Video + Project Info + Tools */}
        <div
          className="shrink-0 border-r border-zinc-800 bg-zinc-900/30 flex flex-col overflow-hidden"
          style={{ width: sidebarWidth }}
        >
          {/* Project title */}
          <div className="px-3 py-2 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <Video className="w-3.5 h-3.5 text-zinc-500" />
              <span className="text-xs text-zinc-300 font-medium truncate">
                {currentProject.name}
              </span>
            </div>
            {currentProject.video_filename && (
              <p className="text-[10px] text-zinc-600 mt-0.5 ml-5 truncate">
                {currentProject.video_filename}
              </p>
            )}
          </div>

          {/* Video Player */}
          <div className="shrink-0">
            <VideoPlayer videoRef={videoRef} />
          </div>

          {/* Tab Switcher */}
          <div className="flex border-b border-zinc-800 shrink-0">
            <button
              onClick={() => setLeftTab('tools')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium transition-colors border-b-2 ${
                leftTab === 'tools'
                  ? 'text-khmer-400 border-khmer-500 bg-zinc-800/30'
                  : 'text-zinc-500 border-transparent hover:text-zinc-300 hover:bg-zinc-800/20'
              }`}
            >
              <LayoutGrid className="w-3 h-3" />
              Workflow
            </button>
            <button
              onClick={() => setLeftTab('media')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium transition-colors border-b-2 ${
                leftTab === 'media'
                  ? 'text-khmer-400 border-khmer-500 bg-zinc-800/30'
                  : 'text-zinc-500 border-transparent hover:text-zinc-300 hover:bg-zinc-800/20'
              }`}
            >
              <Film className="w-3 h-3" />
              Media
            </button>
            <button
              onClick={() => setLeftTab('narrate')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium transition-colors border-b-2 ${
                leftTab === 'narrate'
                  ? 'text-indigo-400 border-indigo-500 bg-indigo-900/20'
                  : 'text-zinc-500 border-transparent hover:text-zinc-300 hover:bg-zinc-800/20'
              }`}
            >
              <Mic className="w-3 h-3" />
              Narrate
            </button>
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-auto">
            {leftTab === 'media' ? (
              <MediaPool
                videoRef={videoRef}
                vocalsUrl={vocalsUrl}
                bgmUrl={bgmUrl}
                audioSeparated={audioSeparated}
              />
            ) : leftTab === 'narrate' ? (
              <NarrationPanel />
            ) : (
              <Sidebar
                onOpenExport={() => setShowExport(true)}
                audioSeparated={audioSeparated}
                onAudioSeparated={handleAudioSeparated}
              />
            )}
          </div>
        </div>

        {/* Sidebar resize handle */}
        <div
          className="w-1 shrink-0 bg-zinc-800 hover:bg-khmer-500/60 cursor-col-resize transition-colors relative group"
          onMouseDown={(e) => handleResizeStart(e, 'sidebar')}
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
          <div className="absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
            <GripVertical className="w-3 h-3 text-khmer-400" />
          </div>
        </div>

        {/* Right Panel — Subtitle Data + Timeline */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {/* Subtitle Data Table */}
          <div className="flex-1 overflow-hidden">
            <SubtitleDataPanel videoRef={videoRef} />
          </div>

          {/* Timeline resize handle */}
          <div
            className="h-1 shrink-0 bg-zinc-800 hover:bg-khmer-500/60 cursor-row-resize transition-colors relative group"
            onMouseDown={(e) => handleResizeStart(e, 'timeline')}
          >
            <div className="absolute inset-x-0 -top-1 -bottom-1" />
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
              <GripHorizontal className="w-3 h-3 text-khmer-400" />
            </div>
          </div>

          {/* Timeline Editor */}
          <div
            className="border-t border-zinc-800 shrink-0"
            style={{ height: timelineHeight }}
          >
            <TimelineEditorPro
              videoRef={videoRef}
              vocalsRef={vocalsRef}
              bgmRef={bgmRef}
              audioSeparated={audioSeparated}
              onAudioSeparated={handleAudioSeparated}
              onRemoveAudioSeparation={handleRemoveAudioSeparation}
            />
          </div>
        </div>
      </div>

      {/* Hidden audio elements for separated tracks — always rendered so refs are stable */}
      <audio ref={vocalsRef} src={vocalsUrl || undefined} preload="auto" style={{ display: 'none' }} />
      <audio ref={bgmRef} src={bgmUrl || undefined} preload="auto" style={{ display: 'none' }} />

      {/* Hidden audio for project-level generated BGM — always rendered so ref is stable */}

      {/* Status Bar */}
      <StatusBar />

      {/* Settings Modal */}
      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />

      {/* Export Modal */}
      <ExportModal open={showExport} onClose={() => setShowExport(false)} />
    </div>
  );
}
