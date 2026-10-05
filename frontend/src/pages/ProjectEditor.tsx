import { useShallow } from 'zustand/react/shallow';
import { useEffect, useRef, useState, useCallback, lazy, Suspense, type ReactNode } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useBatchStore } from '../utils/batchRunner';
import { useProjectStore } from '../stores/projectStore';
import { buildClipLayout, timelineToSource } from '../utils/clipTimemap';
import { JUMP_TO_LINE, takePendingLine } from '../utils/jumpToLine';
import { deleteAudioSeparation, uploadVideo, fetchRenderQueue, VERSION_RESTORED_EVENT } from '../api/client';
import { syncProjectSettings } from '../utils/projectSettings';
import VideoPlayer from '../components/VideoPlayer';
import SubtitleDataPanel from '../components/SubtitleDataPanel';
import TimelineEditorPro from '../components/TimelineEditorPro';
import MediaPool from '../components/MediaPool';
import ProjectTabBar from '../components/ProjectTabBar';
import { SPLIT_SUGGEST_SECONDS } from '../utils/splitting';
import BatchProgressPanel from '../components/BatchProgressPanel';
import { useReloadWhileServerWorks } from '../utils/pipelineWatch';

import {
  LayoutGrid,
  Upload,
  GripVertical,
  GripHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Layers,
  Loader2,
  Download,
  Flame,
  Film,
  Settings,
  History,
  Copy,
  LayoutTemplate,
} from 'lucide-react';

// Heavy panels and modals are split into their own chunks and only fetched when first shown
const SettingsModal = lazy(() => import('../components/SettingsModal'));
const ExportModal = lazy(() => import('../components/ExportModal'));
const VersionsModal = lazy(() => import('../components/VersionsModal'));
const TemplatesModal = lazy(() => import('../components/TemplatesModal'));
const ApplyToPartsModal = lazy(() => import('../components/ApplyToPartsModal'));
const MeatikaTTSPanel = lazy(() => import('../components/MeatikaTTSPanel'));
// Imported directly, not lazy(): behind lazy() + Suspense the Dubbing tab (and the Intro Hook
// panel it hosts) could sit blank for a long time after switching to it. It still mounts only
// the first time the tab opens (MountOnFirstUse), and draws its lines a page at a time.
import DubbingStudioHub from '../components/DubbingStudioHub';
const MovieRecapPanel = lazy(() => import('../components/MovieRecapPanel'));
const NewProjectsModal = lazy(() => import('../components/NewProjectsModal'));

// Mounts children the first time `active` becomes true, then keeps them mounted
// so panel/modal state survives being hidden or closed.
function MountOnFirstUse({ active, children }: { active: boolean; children: ReactNode }) {
  const [used, setUsed] = useState(active);
  useEffect(() => {
    if (active) setUsed(true);
  }, [active]);
  if (!used && !active) return null;
  return <Suspense fallback={null}>{children}</Suspense>;
}

type MeatikaCenterTab = 'assets' | 'captions' | 'dubbing';

export default function ProjectEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    currentProject,
    isLoading,
    error,
    loadProject,
    clearError,
    audioSeparated,
    vocalsUrl,
    bgmUrl,
    setAudioSeparated,
    splitPromptProjectId,
    setSplitPrompt,
  } = useProjectStore(useShallow(state => ({ currentProject: state.currentProject, isLoading: state.isLoading, error: state.error, loadProject: state.loadProject, clearError: state.clearError, audioSeparated: state.audioSeparated, vocalsUrl: state.vocalsUrl, bgmUrl: state.bgmUrl, setAudioSeparated: state.setAudioSeparated, splitPromptProjectId: state.splitPromptProjectId, setSplitPrompt: state.setSplitPrompt })));

  const videoRef = useRef<HTMLVideoElement>(null);
  const vocalsRef = useRef<HTMLAudioElement>(null);
  const bgmRef = useRef<HTMLAudioElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Modals state
  const [showSettings, setShowSettings] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showApplyParts, setShowApplyParts] = useState(false);
  // Progress across every part of a split video, so the batch is visible after the
  // split dialog is gone rather than only while it is open.
  const [showBatchPanel, setShowBatchPanel] = useState(false);
  // a folder or a long video just confirmed brings you here: show how its projects are getting on
  const progressAsked = useBatchStore((s) => s.showProgress);
  useEffect(() => { if (progressAsked) setShowBatchPanel(true); }, [progressAsked]);
  // captions and voices made on the server show up here as they are made
  useReloadWhileServerWorks(currentProject?.id);
  // A badge on the drawer button, so a render running in the background is visible
  // without opening anything.
  const [activeRenderCount, setActiveRenderCount] = useState(0);
  useEffect(() => {
    let alive = true;
    let polling = false;
    const poll = async () => {
      if (polling || document.hidden) return;
      polling = true;
      try {
        const jobs = await fetchRenderQueue();
        if (alive) {
          setActiveRenderCount(
            jobs.filter((j) => j.status === 'queued' || j.status === 'rendering').length,
          );
        }
      } catch {
        /* the badge is a convenience; a failed poll just leaves the last count */
      } finally {
        polling = false;
      }
    };
    poll();
    const timer = setInterval(poll, 6000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const [showRecapPanel, setShowRecapPanel] = useState(false);
  const [showHookPanel, setShowHookPanel] = useState(false);
  const [hookPanelTarget, setHookPanelTarget] = useState<HTMLElement | null>(null);
  const closeHookPanel = useCallback(() => setShowHookPanel(false), []);
  // a line picked in the review list, perhaps in another episode: go to it once it is loaded
  useEffect(() => {
    const projectId = currentProject?.id;
    if (!projectId) return;
    const show = () => {
      const target = takePendingLine(projectId);
      const seg = target && currentProject.segments.find((s) => s.id === target.segmentId);
      if (!target) return;
      const state = useProjectStore.getState();
      const time = seg ? seg.start_time : target.time;
      setCenterTab('captions');
      state.setActiveSegment(seg ? seg.id : null);
      state.setCurrentTime(time);
      if (videoRef.current) {
        const layout = buildClipLayout(state.videoClips);
        const mapped = layout.length ? timelineToSource(layout, time) : null;
        videoRef.current.currentTime = mapped ? mapped.sourceTime : time;
      }
    };
    show();
    window.addEventListener(JUMP_TO_LINE, show);
    return () => window.removeEventListener(JUMP_TO_LINE, show);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id]);

  // the hook's content stays in its drawer until the drawer has slid away
  const [hookLingers, setHookLingers] = useState(false);
  useEffect(() => {
    if (showHookPanel) { setHookLingers(true); return; }
    const timer = setTimeout(() => setHookLingers(false), 220);
    return () => clearTimeout(timer);
  }, [showHookPanel]);
  useEffect(() => {
    if (!showRecapPanel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowRecapPanel(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showRecapPanel]);
  useEffect(() => { setShowHookPanel(false); setShowRecapPanel(false); }, [id]);

  // Tabs
  const [centerTab, setCenterTab] = useState<MeatikaCenterTab>(
    () => location.state?.initialCenterTab === 'assets' ? 'assets' : 'captions'
  );
  useEffect(() => {
    // The editor stays mounted when a new project is created from its tab bar.
    if (location.state?.initialCenterTab === 'assets') setCenterTab('assets');
  }, [id, location.key, location.state?.initialCenterTab]);

  // Panel sizing & responsiveness
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState<boolean>(
    () => localStorage.getItem('editor-left-panel-open') === 'true'
  );
  const [leftPanelWidth, setLeftPanelWidth] = useState(() => Number(localStorage.getItem('editor-left-panel-width')) || 360);
  const [timelineHeight, setTimelineHeight] = useState(() => Number(localStorage.getItem('editor-timeline-height')) || 260);
  // Once you drag the divider, your height wins; double-click it to go back to auto-fit
  const [timelineHeightIsManual, setTimelineHeightIsManual] = useState(() => {
    const flag = localStorage.getItem('editor-timeline-manual');
    if (flag !== null) return flag === 'true';
    // Height chosen before auto-fit existed: keep honouring it
    return localStorage.getItem('editor-timeline-height') !== null;
  });

  const fitTimelineToTracks = useCallback((needed: number) => {
    if (timelineHeightIsManual) return;
    setTimelineHeight(Math.round(Math.max(150, Math.min(needed, window.innerHeight * 0.6))));
  }, [timelineHeightIsManual]);

  useEffect(() => {
    localStorage.setItem('editor-left-panel-open', String(isLeftPanelOpen));
  }, [isLeftPanelOpen]);
  useEffect(() => {
    localStorage.setItem('editor-left-panel-width', String(leftPanelWidth));
  }, [leftPanelWidth]);
  useEffect(() => {
    localStorage.setItem('editor-timeline-height', String(timelineHeight));
  }, [timelineHeight]);
  useEffect(() => {
    localStorage.setItem('editor-timeline-manual', String(timelineHeightIsManual));
  }, [timelineHeightIsManual]);

  const draggingRef = useRef<'leftPanel' | 'timeline' | null>(null);
  const startPosRef = useRef(0);
  const startSizeRef = useRef(0);

  const handleResizeStart = useCallback((e: React.MouseEvent, target: 'leftPanel' | 'timeline') => {
    e.preventDefault();
    draggingRef.current = target;
    if (target === 'timeline') setTimelineHeightIsManual(true);
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
    if (vocalsRef.current) { vocalsRef.current.pause(); vocalsRef.current.src = ''; }
    if (bgmRef.current) { bgmRef.current.pause(); bgmRef.current.src = ''; }
    if (id) loadProject(id).then(() => syncProjectSettings(id));
  }, [id]);

  // a restored version brings its caption style, logo and blur boxes back from the server
  useEffect(() => {
    const onRestored = (e: Event) => {
      const pid = (e as CustomEvent).detail?.projectId;
      if (pid) syncProjectSettings(pid, true);
    };
    window.addEventListener(VERSION_RESTORED_EVENT, onRestored);
    return () => window.removeEventListener(VERSION_RESTORED_EVENT, onRestored);
  }, []);

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
    const uploaded = await uploadVideo(currentProject.id, file);
    await loadProject(currentProject.id);
    // A long video is worth offering to split into part projects before any work starts
    if ((uploaded?.duration || 0) >= SPLIT_SUGGEST_SECONDS && !uploaded?.part_index) {
      setSplitPrompt(currentProject.id);
    }
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[var(--s1)] text-[#e1e3e6] select-none font-sans">
      {/* Global Error Toast */}
      {error && (
        <div className="fixed top-4 right-4 z-50 bg-red-950/95 border border-red-800 text-red-200 px-4 py-3 rounded-xl shadow-2xl max-w-md animate-in slide-in-from-top-2">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs leading-relaxed">{error}</p>
            <button onClick={clearError} className="text-red-400 hover:text-red-200 text-xs shrink-0">✕</button>
          </div>
        </div>
      )}

      {/* Top Header Bar — Multi-Tab Video Project Workspace (Always Fixed & Mounted) */}
      <header className="h-11 border-b border-[var(--s3)] bg-[var(--s2)] px-3 flex items-center justify-between shrink-0 z-30">
        {/* Left: Meatika Menu & Panel Toggle */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => navigate('/')}
            className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
            title="Back to projects"
          >
            <LayoutGrid className="w-4 h-4" />
          </button>

          {/* Parts progress and the export queue both live in the left drawer, so this is
              useful on any project, not only a split one. */}
          <button
            onClick={() => setShowBatchPanel(true)}
            className="relative flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] font-medium text-blue-300 hover:text-white hover:bg-white/10 transition-colors"
            title="Parts progress and export queue"
          >
            <Layers className="w-4 h-4" />
            {(currentProject?.part_count || 0) > 0 && (
              <span className="hidden sm:inline">
                Part {currentProject?.part_index} / {currentProject?.part_count}
              </span>
            )}
            {activeRenderCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[9px] font-bold text-white">
                {activeRenderCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setIsLeftPanelOpen(!isLeftPanelOpen)}
            className={`p-1.5 rounded-md transition-colors ${
              isLeftPanelOpen ? 'text-white bg-white/10' : 'text-zinc-400 hover:text-white hover:bg-white/10'
            }`}
            title={isLeftPanelOpen ? 'Hide voiceover panel' : 'Show voiceover panel'}
          >
            {isLeftPanelOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
          </button>
        </div>

        {/* Center: Multi-Project Tabs */}
        <ProjectTabBar />

        {/* Right Actions: Export Video & Settings */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => { setShowRecapPanel(false); setShowHookPanel(open => !open); }}
            disabled={!currentProject || isLoading}
            aria-expanded={showHookPanel}
            aria-controls="intro-hook-panel"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium text-xs transition-colors disabled:opacity-40 ${showHookPanel ? 'bg-blue-600/25 text-blue-100' : 'bg-white/5 text-zinc-300 hover:bg-white/10'}`}
            title="Open Intro Hook side panel"
          >
            <Flame className="w-3.5 h-3.5" />
            <span>Intro Hook</span>
          </button>
          <button onClick={() => { setShowHookPanel(false); setShowRecapPanel(open => !open); }}
            disabled={!currentProject || isLoading} aria-expanded={showRecapPanel} aria-controls="movie-recap-panel"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium text-xs disabled:opacity-40 ${showRecapPanel ? 'bg-blue-600/25 text-blue-100' : 'bg-white/5 text-zinc-300 hover:bg-white/10'}`}>
            <Film className="w-3.5 h-3.5" /><span>Movie Recap</span>
          </button>
          {(currentProject?.part_count || 0) > 1 && (
            <button
              onClick={() => setShowApplyParts(true)}
              disabled={isLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white font-medium text-xs transition-colors disabled:opacity-40"
              title="Copy this part's caption style, logo, blur boxes and BGM setup to the other parts"
            >
              <Copy className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Copy to parts</span>
            </button>
          )}
          <button
            onClick={() => setShowTemplates(true)}
            disabled={!currentProject || isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white font-medium text-xs transition-colors disabled:opacity-40"
            title="Save this project's look as a template, or apply a saved one"
          >
            <LayoutTemplate className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Template</span>
          </button>
          <button
            onClick={() => setShowVersions(true)}
            disabled={!currentProject || isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white font-medium text-xs transition-colors disabled:opacity-40"
            title="Save and restore versions of this edit"
          >
            <History className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Versions</span>
          </button>
          <button
            onClick={() => setShowExportModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-500 font-medium text-xs transition-colors cursor-pointer"
            title="Export video, audio and subtitles"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Export</span>
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
            title="Settings"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Workspace Body */}
      {isLoading && !currentProject ? (
        <div className="flex-1 flex items-center justify-center bg-[var(--s1)]">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-5 h-5 text-zinc-500 animate-spin" />
            <p className="text-xs text-zinc-500">Loading project…</p>
          </div>
        </div>
      ) : !currentProject ? (
        <div className="flex-1 flex items-center justify-center bg-[var(--s1)]">
          <div className="text-center">
            <p className="text-zinc-400 mb-4">{error || 'Project not found or server reconnecting...'}</p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => id && loadProject(id)}
                className="px-3 py-1.5 bg-blue-600 text-white hover:bg-blue-500 text-xs font-medium rounded-md transition-colors"
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
      ) : (
        <>
          {/* Main Workspace Body — keyed by id so project switch cleanly remounts all panels */}
          <div key={id} className="flex-1 flex overflow-hidden">
        {/* Left Tool Panel (TTS & AI, collapsible) */}
        <div
          className={`shrink-0 border-r border-[var(--s3)] bg-[var(--s2)] flex flex-col overflow-hidden transition-all duration-150 ${
            isLeftPanelOpen ? '' : 'hidden'
          }`}
          style={{ width: isLeftPanelOpen ? leftPanelWidth : 0 }}
        >
          <div className="flex-1 overflow-hidden">
            <Suspense fallback={null}>
              <MeatikaTTSPanel onNavigate={tool => {
                if (tool === 'captions' || tool === 'dubbing') setCenterTab(tool);
                setShowRecapPanel(tool === 'recap');
                setShowHookPanel(tool === 'hooks');
              }} />
            </Suspense>
          </div>
        </div>

        {/* Left Panel Resize Handle */}
        {isLeftPanelOpen && (
          <div
            className="w-1 shrink-0 bg-[var(--s5)] hover:bg-[var(--accent-primary)] cursor-col-resize transition-colors relative group"
            onMouseDown={(e) => handleResizeStart(e, 'leftPanel')}
          >
            <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
            <div className="absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
              <GripVertical className="w-3 h-3 text-white" />
            </div>
          </div>
        )}

        {/* Center Production Hub (MY ASSETS, LIBRARY, CAPTIONS, DUBBING) */}
        <div className="flex-1 flex flex-col border-r border-[var(--s3)] min-w-0 overflow-hidden bg-[var(--s2)]">
          {/* Top Tabs */}
          <div className="h-9 border-b border-[var(--s3)] flex items-stretch px-3 gap-3 shrink-0">
            {([
              { id: 'captions', label: 'Captions' },
              { id: 'dubbing', label: 'Dubbing' },
              { id: 'assets', label: 'Assets' },
            ] as const).map((tab) => {
              const isActive = centerTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setCenterTab(tab.id as MeatikaCenterTab)}
                  className={`h-full px-2 text-xs border-b-2 transition-colors cursor-pointer ${
                    isActive ? 'border-blue-500 text-white' : 'border-transparent text-zinc-500 hover:text-zinc-200'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,audio/*,image/*"
              className="hidden"
              onChange={handleUploadFile}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="ml-auto self-center p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
              title="Upload media"
            >
              <Upload className="w-4 h-4" />
            </button>
          </div>

          {/* Center Tab Body */}
          <div className="flex-1 overflow-hidden flex flex-col bg-[var(--s2)]">
            <div className={`flex-1 flex-col overflow-hidden ${centerTab === 'assets' ? 'flex' : 'hidden'}`}>
              <MediaPool
                videoRef={videoRef}
                vocalsUrl={vocalsUrl}
                bgmUrl={bgmUrl}
                audioSeparated={audioSeparated}
              />
            </div>

            <div className={`flex-1 flex-col overflow-hidden ${centerTab === 'captions' ? 'flex' : 'hidden'}`}>
              <SubtitleDataPanel videoRef={videoRef} />
            </div>

            <div className={`flex-1 flex-col overflow-hidden ${centerTab === 'dubbing' ? 'flex' : 'hidden'}`}>
              <MountOnFirstUse active={centerTab === 'dubbing' || showHookPanel}>
                <DubbingStudioHub hookPanelTarget={showHookPanel || hookLingers ? hookPanelTarget : null} onCloseHookPanel={closeHookPanel} />
              </MountOnFirstUse>
            </div>
          </div>
        </div>

        {/* Right Top: Video Canvas Viewport */}
        <div className="relative isolate w-[42%] min-w-[340px] max-w-[55%] shrink-0 flex flex-col overflow-hidden bg-black">
          <VideoPlayer videoRef={videoRef} />
        </div>
      </div>

      {/* Timeline Resize Handle */}
      <div
        className="h-1 shrink-0 bg-[var(--s5)] hover:bg-[var(--accent-primary)] cursor-row-resize transition-colors relative group"
        onMouseDown={(e) => handleResizeStart(e, 'timeline')}
        onDoubleClick={() => setTimelineHeightIsManual(false)}
        title="Drag to resize · double-click to fit the tracks"
      >
        <div className="absolute inset-x-0 -top-1.5 -bottom-1.5" />
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
          <GripHorizontal className="w-3 h-3 text-white" />
        </div>
      </div>

      {/* Bottom Multi-Track Timeline — keyed by id so video tracks and clips re-initialize per project */}
      <div key={`timeline-${id}`} className="border-t border-[var(--s3)] shrink-0" style={{ height: timelineHeight }}>
        <TimelineEditorPro
          videoRef={videoRef}
          vocalsRef={vocalsRef}
          bgmRef={bgmRef}
          audioSeparated={audioSeparated}
          onAudioSeparated={handleAudioSeparated}
          onRemoveAudioSeparation={handleRemoveAudioSeparation}
          onContentHeight={fitTimelineToTracks}
        />
      </div>

        </>
      )}

      {/* Modals */}
      <MountOnFirstUse active={showSettings}>
        <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
      </MountOnFirstUse>
      <MountOnFirstUse active={showExportModal}>
        <ExportModal open={showExportModal} onClose={() => setShowExportModal(false)} />
      </MountOnFirstUse>

      {showApplyParts && currentProject?.id && (
        <Suspense fallback={null}>
          <ApplyToPartsModal
            projectId={currentProject.id}
            projectName={currentProject.name}
            onClose={() => setShowApplyParts(false)}
          />
        </Suspense>
      )}

      {showTemplates && currentProject?.id && (
        <Suspense fallback={null}>
          <TemplatesModal projectId={currentProject.id} projectName={currentProject.name} onClose={() => setShowTemplates(false)} />
        </Suspense>
      )}
      {showVersions && currentProject?.id && (
        <Suspense fallback={null}>
          <VersionsModal
            projectId={currentProject.id}
            onClose={() => setShowVersions(false)}
            onRestored={() => loadProject(currentProject.id)}
          />
        </Suspense>
      )}

      {/* Offered once, right after a long video finishes uploading */}
      {splitPromptProjectId && splitPromptProjectId === currentProject?.id && (
        <Suspense fallback={null}>
          <NewProjectsModal
            source="video"
            longVideo={{
              id: currentProject.id,
              name: currentProject.name,
              duration: currentProject.duration || 0,
              language: currentProject.language,
            }}
            onClose={() => setSplitPrompt(null)}
          />
        </Suspense>
      )}

      {/* Intro Hook and Movie Recap slide in from the right, over the editor, the way the
          progress panel slides in from the left — the video stays in view beside them. */}
      {(showHookPanel || showRecapPanel) && (
        <div
          className="fixed inset-0 z-40 bg-black/40"
          aria-hidden="true"
          onClick={() => { setShowHookPanel(false); setShowRecapPanel(false); }}
        />
      )}
      <aside
        id="movie-recap-panel"
        aria-label="Movie Recap"
        aria-hidden={!showRecapPanel}
        inert={!showRecapPanel}
        className={`fixed right-0 top-0 z-50 flex h-full w-[460px] max-w-[100vw] flex-col overflow-hidden border-l border-[var(--s4)] bg-[var(--s2)] shadow-2xl transition-transform duration-200 ${
          showRecapPanel ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <MountOnFirstUse active={showRecapPanel}><MovieRecapPanel onClose={() => setShowRecapPanel(false)} /></MountOnFirstUse>
      </aside>
      <aside
        id="intro-hook-panel"
        aria-label="Intro Hook"
        aria-hidden={!showHookPanel}
        inert={!showHookPanel}
        ref={setHookPanelTarget}
        className={`fixed right-0 top-0 z-50 flex h-full w-[460px] max-w-[100vw] flex-col overflow-hidden border-l border-[var(--s4)] bg-[var(--s2)] shadow-2xl transition-transform duration-200 ${
          showHookPanel ? 'translate-x-0' : 'translate-x-full'
        }`}
      />

      <BatchProgressPanel
        open={showBatchPanel}
        currentProjectId={currentProject?.id}
        onClose={() => setShowBatchPanel(false)}
      />

      {/* Hidden Audio Elements for Separated Stems */}
      <audio ref={vocalsRef} src={vocalsUrl || undefined} preload="metadata" style={{ display: 'none' }} />
      <audio ref={bgmRef} src={bgmUrl || undefined} preload="metadata" style={{ display: 'none' }} />
    </div>
  );
}
