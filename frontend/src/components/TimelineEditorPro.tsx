import { useShallow } from 'zustand/react/shallow';
import VoicePlaybackAudio from './timeline/VoicePlaybackAudio';
import { useRef, useState, useCallback, useEffect, useLayoutEffect, useMemo, RefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useProjectStore } from '../stores/projectStore';
import type { Segment, VideoClip } from '../types';
import { getVideoClips, splitClipAtPlayhead, deleteVideoClip, restoreVideoClips, updateVideoClip, reorderVideoClips, updateProject, flipVideo, rotateVideo, cropVideo, appendVideoFileToTimeline, addVideoClip, separateProjectAudio, checkAudioSeparation, fetchStemPeaks, cleanBgm, type BgmCleanLevel, snapCaptionsToSpeech, addToPipeline, tidyCaptions, restoreSegments, autoFitAudioToSubtitles, fetchGapPlan, applyVoiceFx, previewVoiceFx, spreadIntoSilence, normalizeSpeakingRate, splitLongCaptions, saveTextOverlays, TEXT_OVERLAYS_CHANGED, type TextOverlay, type CaptionGap, proposeShorterLines, applyShortened } from '../api/client';
import { buildClipLayout, totalTimelineDuration, timelineToSource, sourceToTimeline, sourceRangeToTimeline } from '../utils/clipTimemap';
import { StemTrackLabel, StemTrackLane } from './timeline/StemTrack';
import { OverlayTrackLabel, OverlayTrackLane, useOverlayTrackPosition, useTextOverlays } from './timeline/OverlayTrack';
import { LogoTrackLabel, LogoTrackLane, useLogoSettings } from './timeline/LogoTrack';
import { saveLogoSettings, type LogoSettings } from './player/LogoTools';
import VoiceCaptureModal from './timeline/VoiceCaptureModal';
import { offerSplitIfLong } from '../utils/offerSplit';
import { PROJECT_SETTINGS_SYNCED, saveProjectSetting } from '../utils/projectSettings';
import CropModal from './timeline/CropModal';
import FillGapsModal from './FillGapsModal';
import { VOICE_EFFECTS, VOICE_EFFECT_GROUPS, applyEffectToLines } from '../utils/voiceEffects';
import {
  Volume2,
  Volume1,
  VolumeX,
  Sparkles,
  ChevronDown,
  Music,
  Mic,
  Loader2,
  AlertCircle,
  StretchHorizontal,
  Gauge,
  Split,
  X,
  Scissors,
  Trash2,
  Undo2,
  Redo2,
  Eye,
  EyeOff,
  FlipHorizontal,
  Plus,
  RotateCw,
  RotateCcw,
  FlipVertical,
  Crop,
  Snowflake,
  Bookmark,
  MoveHorizontal,
  Magnet,
  Timer,
  Maximize2,
  Upload,
  Check,
  Wand2,
  Users,
  Play,
  RefreshCw,
  Minimize2,
} from 'lucide-react';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  vocalsRef?: RefObject<HTMLAudioElement | null>;
  bgmRef?: RefObject<HTMLAudioElement | null>;
  audioSeparated?: boolean;
  onAudioSeparated?: (vocalsUrl: string, bgmUrl: string) => void;
  onRemoveAudioSeparation?: () => void;
  /** Height the timeline needs to show every track without scrolling. */
  onContentHeight?: (height: number) => void;
}

// Fixed rows above the tracks: toolbar, minimap, time ruler
const TIMELINE_CHROME_HEIGHT = 36 + 12 + 28;

/** A readable clip name: no extension and no trailing #hashtags from a download title. */
const clipTitle = (filename: string) => {
  const name = filename.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/#[^\s#]+/g, '').replace(/\s{2,}/g, ' ').trim();
  return name || filename;
};


const COLORS = [
  '#3d8eff', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
]; // speed is now per-segment in SubtitleDataPanel

const VOICE_TRACK_NAMES: Record<string, string> = {
  female: 'Voice · female',
  male: 'Voice · male',
  child: 'Voice · child',
  child_boy: 'Voice · boy',
  child_girl: 'Voice · girl',
  grandma: 'Voice · grandma',
  grandpa: 'Voice · grandpa',
};

/** Track code chip plus a human-readable track name, for the timeline's label column. */
function TrackTag({ code, name }: { code: string; name: string }) {
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30 font-mono shrink-0">
        {code}
      </span>
      <span className="text-[11px] text-zinc-400 truncate">{name}</span>
    </span>
  );
}

const MINIMAP_BUCKETS = 240;

function IconButton({ onClick, disabled, title, active, label, children }: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  active?: boolean;
  /** Shown beside the icon. Without it the button stays icon-only. */
  label?: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex items-center gap-1.5 rounded-md transition-colors cursor-pointer whitespace-nowrap disabled:opacity-30 disabled:cursor-not-allowed ${
        label ? 'px-2 h-7 text-[11px] font-medium' : 'p-1.5'
      } ${active ? 'bg-blue-600/30 text-blue-200' : 'text-zinc-400 hover:text-white hover:bg-white/10'}`}
    >
      {children}
      {label && <span>{label}</span>}
    </button>
  );
}

export default function TimelineEditor({ videoRef, vocalsRef, bgmRef, audioSeparated, onAudioSeparated, onRemoveAudioSeparation, onContentHeight }: Props) {
  const {
    currentProject,
    currentTime,
    isPlaying,
    activeSegmentId,
    isTranscribing,
    transcribePercent,
    setActiveSegment,
    setCurrentTime,
    updateSegment,
    generateVoiceForSegments,
    videoClips,
    setVideoClips,
    loadProject,
    selectedSegmentIds,
    setSelectedSegmentIds,
    deleteSegment,
    deleteMultipleSegments,
    videoMuted: a2Muted,
    setVideoMuted: setA2Muted,
    subtitlesVisible,
    videoVisible,
    hiddenTracks,
    toggleTrackVisibility,
    isGeneratingAudio,
  } = useProjectStore(useShallow(state => ({ currentProject: state.currentProject, currentTime: state.currentTime, isPlaying: state.isPlaying, activeSegmentId: state.activeSegmentId, isTranscribing: state.isTranscribing, transcribePercent: state.transcribePercent, setActiveSegment: state.setActiveSegment, setCurrentTime: state.setCurrentTime, updateSegment: state.updateSegment, generateVoiceForSegments: state.generateVoiceForSegments, videoClips: state.videoClips, setVideoClips: state.setVideoClips, loadProject: state.loadProject, selectedSegmentIds: state.selectedSegmentIds, setSelectedSegmentIds: state.setSelectedSegmentIds, deleteSegment: state.deleteSegment, deleteMultipleSegments: state.deleteMultipleSegments, videoMuted: state.videoMuted, setVideoMuted: state.setVideoMuted, subtitlesVisible: state.subtitlesVisible, videoVisible: state.videoVisible, hiddenTracks: state.hiddenTracks, toggleTrackVisibility: state.toggleTrackVisibility, isGeneratingAudio: state.isGeneratingAudio })));

  // Right-click menu on a voice clip. Opened where the click landed, so the timeline never
  // shifts to make room for it.
  const [voiceMenu, setVoiceMenu] = useState<{ segmentId: string; x: number; y: number } | null>(null);
  // Apply the chosen effect to just this clip, or to every voiced line by the same speaker
  const [voiceMenuScope, setVoiceMenuScope] = useState<'line' | 'selected' | 'speaker'>('line');
  const [regeneratingVoice, setRegeneratingVoice] = useState(false);
  const [previewingFx, setPreviewingFx] = useState<string | null>(null);
  const linePreviewRef = useRef<HTMLAudioElement | null>(null);
  const [applyingVoiceEffect, setApplyingVoiceEffect] = useState<string | null>(null);
  const [voiceEffectError, setVoiceEffectError] = useState('');
  const voiceMenuRef = useRef<HTMLDivElement>(null);
  const voiceMenuSeg = voiceMenu ? currentProject?.segments.find(s => s.id === voiceMenu.segmentId) : undefined;
  // Voiced lines in the current multi-selection, when the right-clicked clip is one of them
  const selectedVoiceIds = useMemo(() => {
    if (!voiceMenuSeg || !selectedSegmentIds.has(voiceMenuSeg.id)) return [];
    return (currentProject?.segments || []).filter(s => s.audio_url && selectedSegmentIds.has(s.id)).map(s => s.id);
  }, [voiceMenuSeg, selectedSegmentIds, currentProject?.segments]);
  const speakerVoiceIds = useMemo(() => {
    if (!voiceMenuSeg?.speaker) return [];
    return (currentProject?.segments || [])
      .filter(s => s.audio_url && s.speaker === voiceMenuSeg.speaker)
      .map(s => s.id);
  }, [voiceMenuSeg?.speaker, currentProject?.segments]);
  const closeVoiceMenu = useCallback(() => {
    setVoiceMenu(null);
    setVoiceEffectError('');
  }, []);
  useEffect(() => {
    closeVoiceMenu();
  }, [currentProject?.id, closeVoiceMenu]);
  useEffect(() => {
    if (!voiceMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!voiceMenuRef.current?.contains(e.target as Node)) closeVoiceMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeVoiceMenu();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', closeVoiceMenu);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', closeVoiceMenu);
    };
  }, [voiceMenu, closeVoiceMenu]);
  // A caption clip and its voice clip are the same line, so a selection is a set of lines.
  // What Delete should take depends on where the selection was made: in the voice lane it
  // removes the voices and keeps the captions. It used to delete the whole line either way.
  const [selectionLane, setSelectionLane] = useState<'caption' | 'voice'>('caption');

  /** Take the dubbed audio off these lines, leaving their captions. The files stay on disk,
   *  so undo brings the voices back. */
  const removeVoices = async (ids: string[]) => {
    const voiced = ids.filter((id) => currentProject?.segments.find((s) => s.id === id)?.audio_url);
    if (!voiced.length) return 0;
    pushUndo();
    for (const id of voiced) await updateSegment(id, { audio_url: '' });
    return voiced.length;
  };

  const removeMenuVoice = async () => {
    const seg = voiceMenuSeg;
    if (!seg || isGeneratingAudio) return;
    const ids =
      voiceMenuScope === 'speaker' && speakerVoiceIds.length > 1
        ? speakerVoiceIds
        : voiceMenuScope === 'selected' && selectedVoiceIds.length > 1
        ? selectedVoiceIds
        : [seg.id];
    closeVoiceMenu();
    await removeVoices(ids);
  };

  const applyTimelineVoiceEffect = async (fx: string) => {
    const seg = voiceMenuSeg;
    if (!seg || !currentProject || isGeneratingAudio || applyingVoiceEffect) return;
    const ids =
      voiceMenuScope === 'speaker' && speakerVoiceIds.length > 1
        ? speakerVoiceIds
        : voiceMenuScope === 'selected' && selectedVoiceIds.length > 1
        ? selectedVoiceIds
        : [seg.id];
    if (ids.length === 1 && fx === (seg.voice_fx || 'normal')) return closeVoiceMenu();
    setApplyingVoiceEffect(fx);
    setVoiceEffectError('');
    try {
      pushUndo(); // so Ctrl+Z puts the previous effect back
      // Effects are filters on the finished voice, so this is ffmpeg only — no new TTS
      await applyEffectToLines(ids, fx);
      closeVoiceMenu();
    } catch (error: any) {
      // Stay open on failure so the message can be read
      setVoiceEffectError(error?.response?.data?.detail || (error instanceof Error ? error.message : 'Could not apply voice effect'));
    } finally {
      setApplyingVoiceEffect(null);
    }
  };
  const regenerateMenuVoice = async () => {
    const seg = voiceMenuSeg;
    if (!seg || !currentProject || isGeneratingAudio || regeneratingVoice) return;
    const projectId = currentProject.id;
    setRegeneratingVoice(true);
    setVoiceEffectError('');
    try {
      await generateVoiceForSegments([seg.id], seg.audio_speed || 1, 'B', undefined, undefined, false, 'normal');
      const genError = useProjectStore.getState().error;
      if (genError) throw new Error(genError);
      // Keep the clip's effect: regenerate clean, then restyle
      if (seg.voice_fx && seg.voice_fx !== 'normal') await applyVoiceFx(projectId, [seg.id], seg.voice_fx);
      if (useProjectStore.getState().currentProject?.id === projectId) await loadProject(projectId);
      closeVoiceMenu();
    } catch (error: any) {
      setVoiceEffectError(error?.response?.data?.detail || (error instanceof Error ? error.message : 'Could not regenerate the voice'));
    } finally {
      setRegeneratingVoice(false);
    }
  };
  /** Hear this line with an effect, without applying it. */
  const previewMenuEffect = async (fx: string) => {
    const seg = voiceMenuSeg;
    if (!seg || !currentProject || previewingFx) return;
    setPreviewingFx(fx);
    setVoiceEffectError('');
    try {
      const res = await previewVoiceFx(currentProject.id, [seg.id], fx);
      const url = res.previews[seg.id];
      if (!url) {
        setVoiceEffectError('This voice was made with its effect built in — use Regenerate voice first to preview others.');
        return;
      }
      linePreviewRef.current?.pause();
      videoRef.current?.pause();
      useProjectStore.getState().setIsPlaying(false);
      const audio = new Audio(url);
      linePreviewRef.current = audio;
      await audio.play();
    } catch (error: any) {
      setVoiceEffectError(error?.response?.data?.detail || 'Could not preview this effect');
    } finally {
      setPreviewingFx(null);
    }
  };
  /** Hear just this clip, without starting the whole timeline. */
  const playMenuLine = () => {
    if (!voiceMenuSeg?.audio_url) return;
    linePreviewRef.current?.pause();
    videoRef.current?.pause();
    useProjectStore.getState().setIsPlaying(false);
    const audio = new Audio(voiceMenuSeg.audio_url);
    linePreviewRef.current = audio;
    void audio.play().catch(() => setVoiceEffectError('Could not play this clip'));
    closeVoiceMenu();
  };
  useEffect(() => () => linePreviewRef.current?.pause(), []);

  const containerRef = useRef<HTMLDivElement>(null);
  const trackLabelsRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(3);
  // While on, the timeline keeps the whole video in view: it re-fits when the video's length
  // changes and when the panel is resized. Zooming by hand turns it off; Fit turns it back on.
  const [fitMode, setFitMode] = useState(true);
  const [dragging, setDragging] = useState<{
    segmentId: string;
    type: 'move' | 'resize-start' | 'resize-end';
    startX: number;
    originalStart: number;
    originalEnd: number;
  } | null>(null);
  const [mutedTracks, setMutedTracks] = useState<Set<number>>(() => {
    try {
      const pId = currentProject?.id;
      if (!pId) return new Set();
      const raw = localStorage.getItem(`timeline-mutes-${pId}`);
      if (raw) return new Set<number>(JSON.parse(raw).tracks || []);
    } catch {}
    return new Set();
  });
  const [aiMutedProfiles, setAiMutedProfiles] = useState<Set<string>>(() => {
    try {
      const pId = currentProject?.id;
      if (!pId) return new Set();
      const raw = localStorage.getItem(`timeline-mutes-${pId}`);
      if (raw) return new Set<string>(JSON.parse(raw).ai || []);
    } catch {}
    return new Set();
  });
  const [b1Muted, setB1Muted] = useState<boolean>(() => {
    try {
      const pId = currentProject?.id;
      if (!pId) return false;
      const raw = localStorage.getItem(`timeline-mutes-${pId}`);
      if (raw) return !!JSON.parse(raw).b1;
    } catch {}
    return false;
  });
  const [v1Muted, setV1Muted] = useState<boolean>(() => {
    try {
      const pId = currentProject?.id;
      if (!pId) return false;
      const raw = localStorage.getItem(`timeline-mutes-${pId}`);
      if (raw) return !!JSON.parse(raw).v1;
    } catch {}
    return false;
  });
  const [videoVolume, setVideoVolume] = useState<number>(() => {
    try {
      const pId = currentProject?.id;
      if (!pId) return 0.6;
      const raw = localStorage.getItem(`timeline-video-volume-${pId}`);
      return raw ? Number(raw) : 0.6;
    } catch {
      return 0.6;
    }
  });
  const [bgmVolume, setBgmVolume] = useState<number>(() => {
    try {
      const pId = currentProject?.id;
      if (!pId) return 0.6;
      const raw = localStorage.getItem(`timeline-bgm-volume-${pId}`);
      return raw ? Number(raw) : 0.6;
    } catch {
      return 0.6;
    }
  });
  const [vocalsVolume, setVocalsVolume] = useState<number>(() => {
    try {
      const pId = currentProject?.id;
      if (!pId) return 1.0;
      const raw = localStorage.getItem(`timeline-vocals-volume-${pId}`);
      return raw ? Number(raw) : 1.0;
    } catch {
      return 1.0;
    }
  });

  const [masterVolume, setMasterVolume] = useState(() => {
    try {
      const saved = localStorage.getItem('player-volume');
      return saved !== null ? parseFloat(saved) : 1.0;
    } catch {
      return 1.0;
    }
  });
  const [masterMuted, setMasterMuted] = useState(() => {
    try {
      return localStorage.getItem('player-muted') === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const onMasterVol = (e: any) => {
      const { volume, muted } = e.detail || {};
      if (volume !== undefined) setMasterVolume(volume);
      if (muted !== undefined) setMasterMuted(muted);
    };
    window.addEventListener('master-volume-change', onMasterVol);
    return () => window.removeEventListener('master-volume-change', onMasterVol);
  }, []);

  // The mutes are kept with the project on the server too. Once the server's copy has arrived
  // it is read in, and only from then on are changes sent back — so the defaults a fresh
  // browser starts with never overwrite what was saved.
  const [mutesFromServer, setMutesFromServer] = useState(0);
  const mutesSyncedRef = useRef(false);
  useEffect(() => {
    mutesSyncedRef.current = false;
    const onSynced = (e: Event) => {
      if ((e as CustomEvent).detail?.projectId !== currentProject?.id) return;
      mutesSyncedRef.current = true;
      setMutesFromServer((n) => n + 1);
    };
    window.addEventListener(PROJECT_SETTINGS_SYNCED, onSynced);
    return () => window.removeEventListener(PROJECT_SETTINGS_SYNCED, onSynced);
  }, [currentProject?.id]);

  // Restore this project's saved mute choices (so they survive refresh)
  const mutesLoadedRef = useRef(false);
  useEffect(() => {
    if (!currentProject?.id) return;
    try {
      const raw = localStorage.getItem(`timeline-mutes-${currentProject.id}`);
      if (raw) {
        const m = JSON.parse(raw);
        setMutedTracks(new Set<number>(m.tracks || []));
        setAiMutedProfiles(new Set<string>(m.ai || []));
        setB1Muted(!!m.b1);
        setV1Muted(!!m.v1);
        setA2Muted(!!m.a2);
      }
    } catch {
      // corrupted entry — ignore
    }
    mutesLoadedRef.current = true;
  }, [currentProject?.id, mutesFromServer]);

  // "Mute the original voices in all" in the progress panel reaches the open project here
  useEffect(() => {
    const follow = (e: Event) => {
      const { muted, projectIds } = (e as CustomEvent).detail || {};
      if (currentProject?.id && (projectIds || []).includes(currentProject.id)) setV1Muted(!!muted);
    };
    window.addEventListener('vocals-mute-changed', follow);
    return () => window.removeEventListener('vocals-mute-changed', follow);
  }, [currentProject?.id]);

  // Persist mute choices and volumes per project
  useEffect(() => {
    if (!currentProject?.id) return;
    const mutes = {
      tracks: Array.from(mutedTracks),
      ai: Array.from(aiMutedProfiles),
      b1: b1Muted,
      v1: v1Muted,
      a2: a2Muted,
    };
    localStorage.setItem(`timeline-mutes-${currentProject.id}`, JSON.stringify(mutes));
    if (mutesSyncedRef.current) saveProjectSetting(currentProject.id, 'track_mutes', mutes);
    localStorage.setItem(`timeline-video-volume-${currentProject.id}`, String(videoVolume));
    localStorage.setItem(`timeline-bgm-volume-${currentProject.id}`, String(bgmVolume));
    localStorage.setItem(`timeline-vocals-volume-${currentProject.id}`, String(vocalsVolume));
  }, [currentProject?.id, mutedTracks, aiMutedProfiles, b1Muted, v1Muted, a2Muted, videoVolume, bgmVolume, vocalsVolume]);

  // Generate Voice Audio state
  const [isAutoFitting, setIsAutoFitting] = useState(false);

  // Editing tools state
  const [isFlipping, setIsFlipping] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [showCropModal, setShowCropModal] = useState(false);
  const [captureTime, setCaptureTime] = useState<number | null>(null);
  const [isCropping, setIsCropping] = useState(false);
  const [cropX, setCropX] = useState(0);
  const [cropY, setCropY] = useState(0);
  const [cropW, setCropW] = useState(0);
  const [cropH, setCropH] = useState(0);
  const zoomDropdownRef = useRef<HTMLDivElement>(null);
  const [showZoomDropdown, setShowZoomDropdown] = useState(false);

  // Video clips local UI state
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [splitProcessing, setSplitProcessing] = useState(false);
  const [clipDragging, setClipDragging] = useState<{
    clipId: string;
    type: 'resize-start' | 'resize-end' | 'move';
    startX: number;
    originalStart: number;
    originalEnd: number;
    currentDeltaX?: number;
    targetIndex?: number;
  } | null>(null);

  // User bookmarks / markers
  const [bookmarks, setBookmarks] = useState<number[]>(() => {
    try {
      const saved = localStorage.getItem(`timeline-bookmarks-${currentProject?.id || 'default'}`);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Voice recording
  const [isSeparatingAudio, setIsSeparatingAudio] = useState(false);
  const [separationProgress, setSeparationProgress] = useState<{ percent: number; eta: number | null } | null>(null);
  const [stemPeaks, setStemPeaks] = useState<{ vocals?: number[]; bgm?: number[] }>({});

  // Leftover source dialogue removed from the BGM: off / light / strong
  const [bgmClean, setBgmClean] = useState<BgmCleanLevel>('off');
  const [bgmCleaning, setBgmCleaning] = useState<BgmCleanLevel | null>(null);
  const [bgmKeepEffects, setBgmKeepEffects] = useState(false);
  const [effectsBusy, setEffectsBusy] = useState(false);
  const storeBgmUrl = useProjectStore((s) => s.bgmUrl);
  useEffect(() => {
    const projectId = currentProject?.id;
    if (!audioSeparated || !projectId) return;
    checkAudioSeparation(projectId)
      .then((s) => {
        setBgmClean(s.bgm_clean ?? 'off');
        setBgmKeepEffects(!!s.bgm_keep_effects);
      })
      .catch(() => {});
  }, [audioSeparated, currentProject?.id]);
  const handleBgmClean = async (level: BgmCleanLevel) => {
    const projectId = currentProject?.id;
    if (!projectId || bgmCleaning || effectsBusy || level === bgmClean) return;
    setBgmCleaning(level);
    try {
      const res = await cleanBgm(projectId, level);
      setBgmClean(res.level);
      setBgmKeepEffects(res.keep_effects);
      const { vocalsUrl } = useProjectStore.getState();
      onAudioSeparated?.(vocalsUrl || '', res.bgm_url);
    } catch (err: any) {
      alert(err?.response?.data?.detail || err?.message || 'Could not clean the BGM');
    } finally {
      setBgmCleaning(null);
    }
  };

  const handleKeepEffects = async (on: boolean) => {
    const projectId = currentProject?.id;
    if (!projectId || effectsBusy || bgmCleaning) return;
    setEffectsBusy(true);
    try {
      const res = await cleanBgm(projectId, bgmClean, on);
      setBgmKeepEffects(res.keep_effects);
      const { vocalsUrl } = useProjectStore.getState();
      onAudioSeparated?.(vocalsUrl || '', res.bgm_url);
    } catch (err: any) {
      alert(err?.response?.data?.detail || err?.message || 'Could not update the BGM');
    } finally {
      setEffectsBusy(false);
    }
  };

  // Waveform data for the isolated tracks (computed and cached by the backend)
  useEffect(() => {
    const projectId = currentProject?.id;
    if (!audioSeparated || !projectId) {
      setStemPeaks({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [vocals, bgm] = await Promise.all([
          fetchStemPeaks(projectId, 'vocals'),
          fetchStemPeaks(projectId, 'bgm'),
        ]);
        if (!cancelled) setStemPeaks({ vocals, bgm });
      } catch {
        if (!cancelled) setStemPeaks({});
      }
    })();
    return () => {
      cancelled = true;
    };
    // storeBgmUrl changes when the BGM is cleaned, which reshapes its waveform
  }, [audioSeparated, currentProject?.id, storeBgmUrl]);

  // Poll backend progress while isolating (it can take minutes on long videos)
  useEffect(() => {
    if (!isSeparatingAudio || !currentProject?.id) {
      setSeparationProgress(null);
      return;
    }
    const projectId = currentProject.id;
    const timer = setInterval(async () => {
      try {
        const s = await checkAudioSeparation(projectId);
        if (s.separating) setSeparationProgress({ percent: s.percent ?? 0, eta: s.eta_seconds ?? null });
      } catch {
        // transient; keep polling
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [isSeparatingAudio, currentProject?.id]);

  const separationLabel = separationProgress
    ? `Isolating audio… ${separationProgress.percent}%${
        separationProgress.eta != null ? ` · ~${Math.max(1, Math.round(separationProgress.eta / 60))} min left` : ''
      }`
    : 'Isolating audio…';

  const [isSnapping, setIsSnapping] = useState(false);

  const handleSnapToSpeech = async () => {
    if (!currentProject?.id || isSnapping) return;
    setIsSnapping(true);
    try {
      pushUndo();  // so Ctrl+Z brings the old captions back
      const res = await snapCaptionsToSpeech(currentProject.id);
      await loadProject(currentProject.id);
      alert(
        res.moved
          ? `Moved ${res.moved} of ${res.total} captions onto the nearest speech (typical move ${res.median_shift}s).`
          : 'Captions already line up with the speech — nothing moved.'
      );
    } catch (err: any) {
      alert(err?.response?.data?.detail || err?.message || 'Could not align captions to speech');
    } finally {
      setIsSnapping(false);
    }
  };

  // Lip timing: the same move as Snap, and then the dub follows — a line whose time changed
  // enough to hear is voiced again to fit the time the actor's mouth is moving
  const [isLipTiming, setIsLipTiming] = useState(false);
  const handleLipTiming = async () => {
    if (!currentProject?.id || isLipTiming) return;
    if (!confirm('Match this video\'s dub to the actors\' mouths?\n\nEach line is moved to where the original actor starts and stops speaking. Lines whose time changes are dubbed again to fit. A version is saved first.')) return;
    setIsLipTiming(true);
    try {
      pushUndo();
      const res = await snapCaptionsToSpeech(currentProject.id, true);
      if (res.to_revoice) await addToPipeline(currentProject.id, { language: currentProject.language || 'km', captions: false, dub: true });
      await loadProject(currentProject.id);
      alert(
        res.moved
          ? `Moved ${res.moved} of ${res.total} lines onto the actors' speech. ${res.to_revoice || 0} ${res.to_revoice === 1 ? 'is' : 'are'} being dubbed again to fit — follow it in the Dubbing tab.`
          : 'Every line already sits on its speech — nothing moved.'
      );
    } catch (err: any) {
      alert(err?.response?.data?.detail || err?.message || 'Could not match the dub to the speech');
    } finally {
      setIsLipTiming(false);
    }
  };

  const [isSplitting, setIsSplittingCaptions] = useState(false);

  /** A caption holding more text than a box can ever show has to become several lines —
   *  no amount of resizing helps it. Splitting divides the time that exists, so lines with
   *  nowhere near enough room are left alone and reported instead. */
  const handleSplitLongCaptions = async () => {
    if (!currentProject?.id || isSplitting) return;
    setIsSplittingCaptions(true);
    try {
      const preview = await splitLongCaptions(currentProject.id, { dryRun: true });
      if (!preview.split && !preview.needs_retranscribe) {
        alert('No caption is carrying more text than it can show.');
        return;
      }
      const ok = confirm(
        `Split ${preview.split} over-long captions into ${preview.split + preview.new_lines} lines?\n\n` +
          (preview.needs_retranscribe
            ? `${preview.needs_retranscribe} more hold far more text than their slot could ever show — ` +
              `splitting cannot help those, they need re-transcribing. They are left untouched.\n\n`
            : '') +
          `The voice of a split line covered the whole line, so it is cleared and those lines need re-dubbing.`,
      );
      if (!ok) return;
      pushUndo();  // so Ctrl+Z brings the old captions back
      const res = await splitLongCaptions(currentProject.id);
      await loadProject(currentProject.id);
      alert(
        `Split ${res.split} captions into ${res.split + res.new_lines} lines ` +
          `(${res.total_before} → ${res.total_after} segments).\n` +
          `${res.voices_cleared} voices cleared for re-dubbing, ${res.overlaps_trimmed} overlaps tidied.` +
          (res.needs_retranscribe ? `\n${res.needs_retranscribe} lines still need re-transcribing.` : ''),
      );
    } catch (err: any) {
      alert(err?.response?.data?.detail || err?.message || 'Could not split the captions');
    } finally {
      setIsSplittingCaptions(false);
    }
  };

  const [isEvening, setIsEvening] = useState(false);

  /** Some lines race and others drawl because their caption boxes bear little relation to how
   *  much text they hold. This resizes each box towards the length its text takes to say. */
  const handleNormalizeRate = async () => {
    if (!currentProject?.id || isEvening) return;
    setIsEvening(true);
    try {
      const preview = await normalizeSpeakingRate(currentProject.id, { dryRun: true });
      if (!preview.adjusted) {
        alert('Every caption already matches the length of its text.');
        return;
      }
      const b = preview.rate_before;
      const a = preview.rate_after;
      const ok = confirm(
        `Resize ${preview.adjusted} of ${preview.total} caption boxes to match their text?\n\n` +
          `Speaking rate spread: ${b.ratio}x → ${a.ratio}x\n` +
          `  slowest ${b.p10} → ${a.p10} chars/sec, fastest ${b.p90} → ${a.p90}\n\n` +
          (preview.needs_redub
            ? `${preview.needs_redub} lines were compressed so hard their voice can't be recovered by re-fitting — re-dub those afterwards.\n\n`
            : '') +
          `Only the caption timings change here; run auto-fit afterwards to match the voices.`,
      );
      if (!ok) return;
      pushUndo();  // so Ctrl+Z brings the old timings back
      const res = await normalizeSpeakingRate(currentProject.id);
      await loadProject(currentProject.id);
      alert(
        `Resized ${res.adjusted} caption boxes. Speaking rate spread ${res.rate_before.ratio}x → ${res.rate_after.ratio}x.` +
          (res.needs_redub ? `\n${res.needs_redub} lines still need re-dubbing.` : ''),
      );
    } catch (err: any) {
      alert(err?.response?.data?.detail || err?.message || 'Could not even out the speaking rate');
    } finally {
      setIsEvening(false);
    }
  };

  const [isShortening, setIsShortening] = useState(false);

  /** A voice can only be sped up so far. Lines with more words than their time are offered
   *  shorter wording instead; nothing changes until the proposals are accepted. */
  const handleShortenToFit = async () => {
    if (!currentProject?.id || isShortening) return;
    setIsShortening(true);
    try {
      const targetIds = selectedSegmentIds.size > 0 ? Array.from(selectedSegmentIds) : undefined;
      const plan = await proposeShorterLines(currentProject.id, targetIds);
      if (!plan.candidates) {
        alert(targetIds ? 'The selected lines can be said in the time they have.' : 'Every line can be said in the time it has.');
        return;
      }
      if (!plan.proposals.length) {
        alert(`${plan.candidates} lines are too long for their time, but none could be worded any shorter without losing meaning. Give them more room on the timeline, or edit them by hand.`);
        return;
      }
      const stillLong = plan.proposals.filter((line) => !line.fits).length;
      const voiced = plan.proposals.filter((line) => line.had_voice).length;
      const sample = plan.proposals
        .slice(0, 6)
        .map((line) => `${line.chars_before} → ${line.chars_after} characters (${line.seconds}s)\n   ${line.before}\n → ${line.after}`)
        .join('\n\n');
      const ok = confirm(
        `Shorten ${plan.proposals.length} lines so they can be said in their time?\n\n${sample}` +
          (plan.proposals.length > 6 ? `\n\n…and ${plan.proposals.length - 6} more` : '') +
          (stillLong ? `\n\n${stillLong} will still be a little long after shortening.` : '') +
          (plan.unchanged ? `\n${plan.unchanged} could not be shortened and stay as they are.` : '') +
          (voiced ? `\n\n${voiced} of these already have a voice, which will need dubbing again.` : '') +
          `\n\nA version is saved first, and Ctrl+Z undoes it.`,
      );
      if (!ok) return;
      pushUndo();
      const res = await applyShortened(currentProject.id, plan.proposals.map((line) => ({ id: line.id, text: line.after })));
      await loadProject(currentProject.id);
      alert(`Shortened ${res.applied} lines${res.voices_cleared ? ` — ${res.voices_cleared} need dubbing again` : ''}.`);
    } catch (err: any) {
      alert(err?.response?.data?.detail || err?.message || 'Could not shorten the lines');
    } finally {
      setIsShortening(false);
    }
  };

  const [isSpreading, setIsSpreading] = useState(false);

  /** Dubbed lines often finish before the acting does, leaving the scene playing in silence.
   *  This grows each line into the silence after it and slows its voice to match. */
  const handleSpreadIntoSilence = async () => {
    if (!currentProject?.id || isSpreading) return;
    setIsSpreading(true);
    try {
      const preview = await spreadIntoSilence(currentProject.id, { dryRun: true });
      if (!preview.stretched) {
        alert('No usable silence after the captions — nothing to stretch.');
        return;
      }
      const ok = confirm(
        `Stretch ${preview.stretched} lines into the silence that follows them?\n\n` +
          `Dead air: ${preview.silence_before}s → ${preview.silence_after}s ` +
          `(${preview.seconds_reclaimed}s reclaimed)\n` +
          `Each voice is slowed to match, never by more than 30%, so short lines stay natural.\n\n` +
          `Their generated voices are re-fitted, which replaces those audio files.`,
      );
      if (!ok) return;
      pushUndo();  // so Ctrl+Z brings the old timings back
      const res = await spreadIntoSilence(currentProject.id);
      await loadProject(currentProject.id);
      alert(
        `Stretched ${res.stretched} lines (+${res.seconds_reclaimed}s), re-fitted ${res.refitted_voices} voices.\n` +
          `Dead air: ${res.silence_before}s → ${res.silence_after}s.`,
      );
    } catch (err: any) {
      alert(err?.response?.data?.detail || err?.message || 'Could not stretch the captions');
    } finally {
      setIsSpreading(false);
    }
  };

  const [isFixingReading, setIsFixingReading] = useState(false);

  // Speech with no caption, drawn straight onto the timeline so the holes are visible
  // where the captions are, instead of only as a number in a panel.
  const [showMissing, setShowMissing] = useState(false);
  // Opens the same review list the captions panel uses, on the dead-air tab: the stretches
  // where nobody speaks are the ones a recap cuts out.
  const [showCutPanel, setShowCutPanel] = useState(false);
  const [missingGaps, setMissingGaps] = useState<CaptionGap[]>([]);
  const [loadingMissing, setLoadingMissing] = useState(false);
  const [missingError, setMissingError] = useState<string | null>(null);
  const missingRequest = useRef(0);

  const loadMissingGaps = useCallback(async () => {
    if (!currentProject?.id) return;
    const request = ++missingRequest.current;
    setLoadingMissing(true);
    setMissingError(null);
    try {
      const plan = await fetchGapPlan(currentProject.id);
      if (request !== missingRequest.current) return;
      setMissingGaps(plan.gaps);
      if (!plan.vocals_available) {
        setMissingError('Isolate vocals first to detect speech without captions');
      }
    } catch (e) {
      if (request !== missingRequest.current) return;
      setMissingGaps([]);
      setMissingError(e instanceof Error ? e.message : 'Could not scan for missing captions');
    } finally {
      if (request === missingRequest.current) setLoadingMissing(false);
    }
  }, [currentProject?.id]);

  const toggleMissing = useCallback(() => {
    setShowMissing((on) => !on);
  }, []);


  const handleTidyCaptions = async () => {
    if (!currentProject?.id || isFixingReading) return;
    setIsFixingReading(true);
    try {
      const plan = await tidyCaptions(currentProject.id, true);
      const lines = [
        `Merge ${plan.merged_away} short captions into ${plan.merged_into ?? 0} longer ones`,
        `Trim ${plan.trimmed} overlapping captions`,
        'Hold short captions on screen longer',
      ];
      if (plan.dubbed_cleared) lines.push(`${plan.dubbed_cleared} merged lines lose their dubbed audio and need re-dubbing`);
      if (plan.kept_dubbed) lines.push(`${plan.kept_dubbed} short lines stay separate because they are already dubbed`);
      if (!confirm(`Tidy captions for this project?\n\n• ${lines.join('\n• ')}`)) return;
      pushUndo();  // so Ctrl+Z brings the old captions back
      const res = await tidyCaptions(currentProject.id);
      await loadProject(currentProject.id);
      alert(`${res.total} captions now (merged ${res.merged_away}, trimmed ${res.trimmed}, held ${res.extended ?? 0} longer).`);
    } catch (err: any) {
      alert(err?.response?.data?.detail || err?.message || 'Could not tidy captions');
    } finally {
      setIsFixingReading(false);
    }
  };

  const handleSeparateAudioClick = async () => {
    if (!currentProject?.id || isSeparatingAudio) return;
    if (audioSeparated) {
      if (confirm('Remove separated Vocals & BGM tracks?')) {
        onRemoveAudioSeparation?.();
      }
      return;
    }

    setIsSeparatingAudio(true);
    try {
      const res = await separateProjectAudio(currentProject.id);
      onAudioSeparated?.(res.vocals_url, res.bgm_url);
    } catch (err: any) {
      alert(err?.response?.data?.detail || err?.message || 'Audio separation failed');
    } finally {
      setIsSeparatingAudio(false);
    }
  };

  // Unified Undo/Redo project history (tracks subtitle segments + video clips)
  type HistorySnapshot = {
    segments: Segment[];
    videoClips: { source_start: number; source_end: number }[];
  };
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const undoStackRef = useRef<HistorySnapshot[]>([]);
  const redoStackRef = useRef<HistorySnapshot[]>([]);

  const pushUndo = useCallback(() => {
    const project = useProjectStore.getState().currentProject;
    if (!project) return;
    const snap: HistorySnapshot = {
      segments: JSON.parse(JSON.stringify(project.segments || [])),
      videoClips: videoClips.map((c) => ({ source_start: c.source_start, source_end: c.source_end })),
    };
    undoStackRef.current.push(snap);
    if (undoStackRef.current.length > 50) {
      undoStackRef.current.shift();
    }
    redoStackRef.current = [];
    undoLogRef.current.push({ kind: 'core' });
    setCanUndo(true);
    setCanRedo(false);
  }, [videoClips]);

  // AI audio playback refs
  const aiAudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const audioInitiatedRef = useRef<Map<string, boolean>>(new Map());

  // Ruler scrubbing (drag playhead on time ruler)
  const [rulerDragging, setRulerDragging] = useState(false);
  const rulerWasPlayingRef = useRef(false);

  // Track lock state
  const [lockedTracks] = useState<Set<string>>(new Set());

  // Video thumbnails — extracted from video element
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const thumbGenRef = useRef(false);

  // Wire A2 mute and videoVolume to actual video audio (scaled by master volume)
  useEffect(() => {
    if (videoRef.current) {
      if (audioSeparated || a2Muted || masterMuted) {
        videoRef.current.muted = true;
        videoRef.current.volume = 0;
      } else {
        videoRef.current.muted = false;
        videoRef.current.volume = Math.max(0.0, Math.min(1.0, videoVolume * masterVolume));
      }
    }
  }, [a2Muted, audioSeparated, masterMuted, masterVolume, videoVolume, videoRef]);

  // Wire V1 mute and volume to vocals audio element (scaled by master volume)
  useEffect(() => {
    if (vocalsRef?.current) {
      vocalsRef.current.muted = v1Muted || masterMuted;
      vocalsRef.current.volume = (v1Muted || masterMuted) ? 0 : Math.max(0.0, Math.min(1.0, vocalsVolume * masterVolume));
    }
  }, [v1Muted, vocalsVolume, masterMuted, masterVolume, vocalsRef]);

  // Wire B1 mute and volume to BGM audio element (scaled by master volume)
  useEffect(() => {
    if (bgmRef?.current) {
      bgmRef.current.muted = b1Muted || masterMuted;
      bgmRef.current.volume = (b1Muted || masterMuted) ? 0 : Math.max(0.0, Math.min(1.0, bgmVolume * masterVolume));
    }
  }, [b1Muted, bgmVolume, masterMuted, masterVolume, bgmRef]);

  // When audio isolation is activated, ensure original video track (A2) is muted
  useEffect(() => {
    if (audioSeparated) {
      setA2Muted(true);
      if (videoRef.current) {
        videoRef.current.muted = true;
        videoRef.current.volume = 0;
      }
    }
  }, [audioSeparated, videoRef, setA2Muted]);

  // Generate video thumbnails for the timeline strip (showing 1 representative frame per clip)
  useEffect(() => {
    if (!currentProject?.video_path || !currentProject?.duration || thumbGenRef.current) return;
    const dur = currentProject.duration;
    if (dur <= 0) return;
    thumbGenRef.current = true;

    const videoFilename = currentProject.video_path.split('/').pop();
    const videoSrc = `/uploads/${currentProject.id}/${videoFilename}`;
    const thumbCount = Math.min(Math.max(Math.ceil(dur / 5), 4), 20);
    const interval = dur / thumbCount;

    const vid = document.createElement('video');
    vid.crossOrigin = 'anonymous';
    vid.muted = true;
    vid.preload = 'auto';
    vid.src = videoSrc;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = 120;
    canvas.height = 68;

    const thumbs: string[] = [];
    let idx = 0;

    vid.addEventListener('loadeddata', () => {
      const captureNext = () => {
        if (idx >= thumbCount) {
          setThumbnails(thumbs);
          vid.remove();
          return;
        }
        vid.currentTime = Math.max(0.05, idx * interval + 0.1);
      };

      vid.addEventListener('seeked', () => {
        ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
        thumbs.push(canvas.toDataURL('image/jpeg', 0.6));
        // Instantly display first captured frame to UI without waiting
        if (thumbs.length === 1) {
          setThumbnails([...thumbs]);
        }
        idx++;
        captureNext();
      });

      captureNext();
    });

    vid.addEventListener('error', () => {
      thumbGenRef.current = false;
    });

    return () => {
      vid.pause();
      vid.src = '';
    };
  }, [currentProject?.id, currentProject?.video_path, currentProject?.duration]);

  // Load video clips when project changes
  useEffect(() => {
    if (!currentProject?.id) return;
    // Use clips from project data if available, otherwise fetch
    if (currentProject.video_clips && currentProject.video_clips.length > 0) {
      setVideoClips(currentProject.video_clips);
    } else if (currentProject.video_path) {
      getVideoClips(currentProject.id).then(setVideoClips).catch(() => {});
    }
  }, [currentProject?.id, currentProject?.video_clips, currentProject?.video_path]);

  // CapCut-style: clips laid out sequentially, total timeline = sum of clip durations
  const clipLayout = useMemo(() => buildClipLayout(videoClips), [videoClips]);

  // Compute distinct AI audio tracks by voice_profile
  const aiTrackProfiles = useMemo(() => {
    const segs = currentProject?.segments || [];
    const profiles = new Set<string>();
    segs.forEach((s) => {
      if (s.audio_url) profiles.add(s.voice_profile || 'female');
    });
    // If no audio yet, check if multiple voice_profiles exist from transcription
    if (profiles.size === 0) {
      segs.forEach((s) => profiles.add(s.voice_profile || 'female'));
    }
    const arr = Array.from(profiles).sort(); // female first, male second
    return arr.length > 1 ? arr : ['_all']; // '_all' = single combined track
  }, [currentProject?.segments]);

  // Memoized sorted segments to avoid re-allocating and re-sorting on every 60fps frame update
  const sortedSegments = useMemo(
    () => [...(currentProject?.segments || [])].sort((a, b) => a.start_time - b.start_time),
    [currentProject?.segments]
  );

  const toggleAiTrackMute = useCallback((profile: string) => {
    setAiMutedProfiles((prev) => {
      const next = new Set(prev);
      if (next.has(profile)) next.delete(profile);
      else next.add(profile);
      return next;
    });
  }, []);

  // Browser media players are a limited resource. Keep a small look-ahead window
  // instead of mounting thousands of audio elements for a fully dubbed movie.
  const playbackSegments = useMemo(() => sortedSegments.filter(seg => {
    if (!seg.audio_url) return false;
    const range = clipLayout.length > 0
      ? sourceRangeToTimeline(clipLayout, seg.start_time, seg.end_time)
      : { timelineStart: seg.start_time, timelineEnd: seg.end_time, isVisible: true };
    if (!range.isVisible) return false;
    const audio = aiAudioRefs.current.get(seg.id);
    const audioEnd = range.timelineStart + (Number.isFinite(audio?.duration) ? audio!.duration : 0);
    return range.timelineStart <= currentTime + 10
      && Math.max(range.timelineEnd, audioEnd) >= currentTime - 2;
  }).slice(0, 32), [sortedSegments, clipLayout, currentTime]);

  // AI audio playback: sync with timeline time
  useEffect(() => {
    const segs = playbackSegments;

    if (!isPlaying) {
      // When paused or stopped, pause all audios and clear initiation state
      audioInitiatedRef.current.clear();
      segs.forEach((seg) => {
        const audio = aiAudioRefs.current.get(seg.id);
        if (audio && !audio.paused) {
          audio.pause();
        }
      });
      return;
    }

    segs.forEach((seg) => {
      if (!seg.audio_url) return;
      const audio = aiAudioRefs.current.get(seg.id);
      if (!audio) return;

      const profile = seg.voice_profile || 'female';
      const isMuted = aiTrackProfiles[0] === '_all'
        ? aiMutedProfiles.has('_all')
        : aiMutedProfiles.has(profile);

      if (isMuted) {
        if (!audio.paused) audio.pause();
        return;
      }

      const range = clipLayout.length > 0
        ? sourceRangeToTimeline(clipLayout, seg.start_time, seg.end_time)
        : { timelineStart: seg.start_time, timelineEnd: seg.end_time, isVisible: true };

      if (!range.isVisible) {
        if (!audio.paused) audio.pause();
        return;
      }

      // Audio plays for its full natural spoken duration (never prematurely cut off by next segment)
      const rawClipDur = Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : Math.max(0.5, range.timelineEnd - range.timelineStart);
      const clipDuration = Math.max(rawClipDur, range.timelineEnd - range.timelineStart);

      const offset = currentTime - range.timelineStart;
      const isWithinWindow = offset >= 0.0 && offset < (clipDuration + 0.35);

      if (isWithinWindow) {
        audio.volume = isMuted ? 0 : 1;
        audio.muted = isMuted;

        const isInitiated = audioInitiatedRef.current.get(seg.id);
        if (!isInitiated && offset >= rawClipDur - 0.05) {
          // the playhead is already past the end of this voice (its caption runs longer):
          // starting it here would only play its last moment, or the whole line late
          audioInitiatedRef.current.set(seg.id, true);
        } else if (!isInitiated) {
          audioInitiatedRef.current.set(seg.id, true);
          // If starting near segment boundary (offset <= 0.05s), start cleanly from 0 so the first word is never skipped
          const startSeek = offset <= 0.05 ? 0 : Math.min(clipDuration - 0.1, offset);
          try {
            audio.currentTime = startSeek;
          } catch {}
          audio.play().catch(() => {});
        } else {
          // If paused (e.g. user unmuted/resumed), ensure it keeps playing — but not once it
          // has played to its end: play() on a finished clip starts it again from the top, and
          // a voice shorter than its caption was heard twice.
          const finished = audio.ended || offset >= rawClipDur - 0.05;
          if (audio.paused && !finished) {
            audio.play().catch(() => {});
          }
          // Only re-sync on extreme manual scrub/seek drift (> 1.2s) to avoid buffer stutter
          const expectedTime = Math.max(0, offset);
          if (!finished && Math.abs(audio.currentTime - expectedTime) > 1.2) {
            try {
              audio.currentTime = expectedTime;
            } catch {}
          }
        }
      } else {
        // Outside active window — reset initiation and pause cleanly
        if (audioInitiatedRef.current.get(seg.id)) {
          audioInitiatedRef.current.delete(seg.id);
        }
        if (!audio.paused) {
          audio.pause();
        }
        if (audio.currentTime !== 0) {
          try {
            audio.currentTime = 0;
          } catch {}
        }
      }
    });
  }, [currentTime, isPlaying, aiMutedProfiles, aiTrackProfiles, playbackSegments, clipLayout, videoRef]);

  // Split clip at playhead
  const handleSplitAtPlayhead = useCallback(async () => {
    if (!currentProject || splitProcessing) return;
    // Convert timeline time to source time for the API
    let sourceTime = currentTime;
    if (clipLayout.length > 0) {
      const result = timelineToSource(clipLayout, currentTime);
      if (!result) return; // playhead not on any clip
      sourceTime = result.sourceTime;
    }
    setSplitProcessing(true);
    pushUndo();
    try {
      const clips = await splitClipAtPlayhead(currentProject.id, sourceTime);
      setVideoClips(clips);
    } catch (err: any) {
      console.error('Split failed:', err?.response?.data?.detail || err?.message);
      undoStackRef.current.pop(); // revert snapshot on failure
    }
    setSplitProcessing(false);
  }, [currentProject, currentTime, splitProcessing, pushUndo, clipLayout]);

  // Add / Append new video file to timeline
  const addVideoInputRef = useRef<HTMLInputElement>(null);
  const [isUploadingClip, setIsUploadingClip] = useState(false);
  const [isTimelineDragging, setIsTimelineDragging] = useState(false);

  const handleAddVideoFile = useCallback(async (file: File) => {
    if (!currentProject) return;
    setIsUploadingClip(true);
    pushUndo();
    const timelineWasEmpty = useProjectStore.getState().videoClips.length === 0;
    try {
      const updatedClips = await appendVideoFileToTimeline(currentProject.id, file);
      setVideoClips(updatedClips);
      await loadProject(currentProject.id);
      if (videoRef.current) {
        videoRef.current.load();
      }
      offerSplitIfLong(timelineWasEmpty);
    } catch (err: any) {
      console.error('Failed to append video file to timeline:', err);
      alert(`Failed to append video: ${err?.response?.data?.detail || err.message || err}`);
    } finally {
      setIsUploadingClip(false);
    }
  }, [currentProject, pushUndo, setVideoClips, loadProject, videoRef]);

  const handleAddClipClick = () => {
    addVideoInputRef.current?.click();
  };

  // Delete a clip from timeline (leaves master asset in MY ASSETS)
  const handleDeleteClip = useCallback(async (clipId: string) => {
    if (!currentProject) return;
    pushUndo();
    try {
      if (clipId === 'vocals-track' || clipId === 'bgm-track') {
        onRemoveAudioSeparation?.();
        setSelectedClipId(null);
        return;
      }
      const targetId = clipId === 'main-clip' ? (videoClips[0]?.id || clipId) : clipId;
      const result = await deleteVideoClip(currentProject.id, targetId);
      if (result.clips && result.clips.length > 0) {
        setVideoClips(result.clips);
      } else {
        setVideoClips([]);
        // the last clip is gone: the player goes empty too (it comes back with undo)
        const project = useProjectStore.getState().currentProject;
        if (project?.id === currentProject.id) {
          useProjectStore.setState({ currentProject: { ...project, timeline_cleared: true } });
        }
      }
      setSelectedClipId(null);
    } catch (err: any) {
      console.error('Delete clip failed:', err?.response?.data?.detail || err?.message);
      // If error (e.g. clipId was synthetic 'main-clip'), clear local clips
      setVideoClips(videoClips.filter((c) => c.id !== clipId));
      setSelectedClipId(null);
      undoStackRef.current.pop(); // revert snapshot on failure
    }
  }, [currentProject, videoClips, setVideoClips, pushUndo, onRemoveAudioSeparation]);

  // Delete a segment with full undo support
  const handleDeleteSegment = useCallback(async (segmentId: string) => {
    if (!currentProject) return;
    pushUndo();
    await deleteSegment(segmentId);
  }, [currentProject, pushUndo, deleteSegment]);

  // Undo (Restores previous full project state)
  const handleUndo = useCallback(async () => {
    const project = useProjectStore.getState().currentProject;
    if (!project || undoStackRef.current.length === 0) return;

    // 1. Snapshot current state to redo
    const currentSnap: HistorySnapshot = {
      segments: JSON.parse(JSON.stringify(project.segments || [])),
      videoClips: videoClips.map((c) => ({ source_start: c.source_start, source_end: c.source_end })),
    };
    redoStackRef.current.push(currentSnap);
    if (redoStackRef.current.length > 50) {
      redoStackRef.current.shift();
    }

    // 2. Pop target state from undo stack
    const targetSnap = undoStackRef.current.pop()!;
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);

    // 3. Instant local memory update (0ms latency)
    useProjectStore.setState({
      currentProject: {
        ...project,
        segments: targetSnap.segments,
      },
    });

    // 4. Sync restored state to backend
    try {
      const clipsChanged = JSON.stringify(targetSnap.videoClips) !== JSON.stringify(currentSnap.videoClips);
      if (clipsChanged && targetSnap.videoClips.length > 0) {
        const restoredClips = await restoreVideoClips(project.id, targetSnap.videoClips);
        setVideoClips(restoredClips);
      }
      await restoreSegments(project.id, targetSnap.segments);
    } catch (err: any) {
      console.error('Undo sync failed:', err);
    }
  }, [videoClips, setVideoClips]);

  // Redo (Restores next full project state)
  const handleRedo = useCallback(async () => {
    const project = useProjectStore.getState().currentProject;
    if (!project || redoStackRef.current.length === 0) return;

    // 1. Snapshot current state to undo
    const currentSnap: HistorySnapshot = {
      segments: JSON.parse(JSON.stringify(project.segments || [])),
      videoClips: videoClips.map((c) => ({ source_start: c.source_start, source_end: c.source_end })),
    };
    undoStackRef.current.push(currentSnap);
    if (undoStackRef.current.length > 50) {
      undoStackRef.current.shift();
    }

    // 2. Pop target state from redo stack
    const targetSnap = redoStackRef.current.pop()!;
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);

    // 3. Instant local memory update (0ms latency)
    useProjectStore.setState({
      currentProject: {
        ...project,
        segments: targetSnap.segments,
      },
    });

    // 4. Sync restored state to backend
    try {
      const clipsChanged = JSON.stringify(targetSnap.videoClips) !== JSON.stringify(currentSnap.videoClips);
      if (clipsChanged && targetSnap.videoClips.length > 0) {
        const restoredClips = await restoreVideoClips(project.id, targetSnap.videoClips);
        setVideoClips(restoredClips);
      }
      await restoreSegments(project.id, targetSnap.segments);
    } catch (err: any) {
      console.error('Redo sync failed:', err);
    }
  }, [videoClips, setVideoClips]);

  // Listen for keyboard shortcut events from ProjectEditor
  useEffect(() => {
    const onSplit = () => handleSplitAtPlayhead();
    const onDeleteSelected = () => {
      if (selectedClipId) {
        handleDeleteClip(selectedClipId);
      } else if (activeSegmentId) {
        handleDeleteSegment(activeSegmentId);
      }
    };
    const onZoom = (e: Event) => {
      const dir = (e as CustomEvent).detail;
      zoomBy(dir === 'in' ? 1.3 : 1 / 1.3);
    };

    const onUndo = () => handleUndo();
    const onRedo = () => handleRedo();

    window.addEventListener('timeline-split', onSplit);
    window.addEventListener('timeline-delete-selected', onDeleteSelected);
    window.addEventListener('timeline-zoom', onZoom);
    window.addEventListener('timeline-undo', onUndo);
    window.addEventListener('timeline-redo', onRedo);
    return () => {
      window.removeEventListener('timeline-split', onSplit);
      window.removeEventListener('timeline-delete-selected', onDeleteSelected);
      window.removeEventListener('timeline-zoom', onZoom);
      window.removeEventListener('timeline-undo', onUndo);
      window.removeEventListener('timeline-redo', onRedo);
    };
  }, [handleSplitAtPlayhead, handleDeleteClip, selectedClipId, activeSegmentId, videoClips.length, handleDeleteSegment, handleUndo, handleRedo]);

  const sourceDuration =
    currentProject?.duration && currentProject.duration > 0
      ? currentProject.duration
      : (videoRef.current?.duration && isFinite(videoRef.current.duration) && videoRef.current.duration > 0
          ? videoRef.current.duration
          : 30);
  const segments = currentProject?.segments || [];
  const pixelsPerSecond = 20 * zoom;
  const [textOverlays, setTextOverlays] = useTextOverlays(currentProject?.id);
  const txTrack = useOverlayTrackPosition();
  const [logoSettings, setLogoSettings] = useLogoSettings(currentProject?.id);
  // Ref so drag handlers always read the latest value without re-mounting listeners
  const pixelsPerSecondRef = useRef(pixelsPerSecond);
  pixelsPerSecondRef.current = pixelsPerSecond;

  // Zoom is read through a ref inside the wheel handler so the listener is registered once
  // instead of being replaced on every zoom step.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;

  // What to keep still while zooming: the moment under the pointer, or the playhead.
  const zoomAnchorRef = useRef<{ time: number; pointerX: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    const el = containerRef.current;
    if (!anchor || !el) return;
    zoomAnchorRef.current = null;
    // runs after the track has its new width, so there is no frame where the old width is used
    el.scrollLeft = Math.max(0, anchor.time * pixelsPerSecond - anchor.pointerX);
  }, [pixelsPerSecond]);
  const sourceDurationRef = useRef(sourceDuration);
  sourceDurationRef.current = sourceDuration;

  const timelineDuration = useMemo(() => {
    const tl = totalTimelineDuration(videoClips);
    return tl > 0 ? tl : sourceDuration;
  }, [videoClips, sourceDuration]);
  // For rendering: use timeline duration (sequential) when clips exist, else source duration
  const duration = timelineDuration;
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const END_ROOM = 68;    // px kept after the end of the video for the add-clip button
  const ZOOM_MIN = 0.0005;
  const ZOOM_MAX = 20;
  const zoomBy = useCallback((factor: number) => {
    const el = containerRef.current;
    if (el) {
      // keep the playhead where it is on screen, or the middle of the view if it is off-screen
      const pps = pixelsPerSecondRef.current;
      const playheadX = currentTimeRef.current * pps - el.scrollLeft;
      const anchorX = playheadX >= 0 && playheadX <= el.clientWidth ? playheadX : el.clientWidth / 2;
      zoomAnchorRef.current = { time: (anchorX + el.scrollLeft) / pps, pointerX: anchorX };
    }
    setFitMode(false);   // a zoom the user chose is kept
    setZoom(prev => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prev * factor)));
  }, []);
  const getFitZoom = useCallback(() => {
    const el = containerRef.current;
    if (!el || duration <= 0) return 1;
    const availableWidth = Math.max(100, el.clientWidth - END_ROOM);
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, +(availableWidth / (duration * 20)).toFixed(4)));
  }, [duration]);

  const isFitZoom = fitMode || Math.abs(zoom - getFitZoom()) < 0.015 || zoom <= getFitZoom() * 1.05;
  const totalWidth = Math.max(
    containerRef.current?.clientWidth || 1000,
    duration * pixelsPerSecond + END_ROOM
  );

  // Assign each segment to a lane (track) using rendered timeline coordinates so overlapping segments go to T2, T3, etc.
  const { laneMap, laneCount } = useMemo(() => {
    const mapped = segments.map((seg) => {
      const range = clipLayout.length > 0
        ? sourceRangeToTimeline(clipLayout, seg.start_time, seg.end_time)
        : { timelineStart: seg.start_time, timelineEnd: seg.end_time, isVisible: true };
      return { seg, range };
    }).filter((item) => item.range.isVisible);

    mapped.sort((a, b) => a.range.timelineStart - b.range.timelineStart);

    const lanes: { end: number }[] = []; // each lane tracks its latest timelineEnd
    const map = new Map<string, number>();

    for (const item of mapped) {
      let assigned = false;
      for (let i = 0; i < lanes.length; i++) {
        if (item.range.timelineStart >= lanes[i].end - 0.05) {
          lanes[i].end = item.range.timelineEnd;
          map.set(item.seg.id, i);
          assigned = true;
          break;
        }
      }
      if (!assigned) {
        map.set(item.seg.id, lanes.length);
        lanes.push({ end: item.range.timelineEnd });
      }
    }

    return { laneMap: map, laneCount: Math.max(lanes.length, 1) };
  }, [segments, clipLayout]);

  const speakerColors: Record<string, string> = {};
  let colorIndex = 0;
  segments.forEach((s) => {
    if (s.speaker && !speakerColors[s.speaker]) {
      speakerColors[s.speaker] = COLORS[colorIndex % COLORS.length];
      colorIndex++;
    }
  });

  const timeToX = useCallback((time: number) => time * pixelsPerSecond, [pixelsPerSecond]);
  const xToTime = useCallback(
    (x: number) => Math.max(0, Math.min(x / pixelsPerSecond, duration)),
    [pixelsPerSecond, duration]
  );

  const handleTimelineClick = (e: React.MouseEvent) => {
    if (dragging || rulerDragging) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left + (containerRef.current?.scrollLeft || 0);
    const time = xToTime(x); // timeline time
    if (clipLayout.length > 0) {
      const result = timelineToSource(clipLayout, time);
      if (result && videoRef.current) videoRef.current.currentTime = result.sourceTime;
    } else if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
    setCurrentTime(time);
  };

  /** Move the playhead to a timeline time, mapping through the clip layout like ruler scrubbing. */
  const seekToTime = useCallback(
    (time: number) => {
      if (clipLayout.length > 0) {
        const result = timelineToSource(clipLayout, time);
        if (result && videoRef.current) videoRef.current.currentTime = result.sourceTime;
      } else if (videoRef.current) {
        videoRef.current.currentTime = time;
      }
      setCurrentTime(time);
    },
    [clipLayout, videoRef, setCurrentTime],
  );

  // Captions changed, so anything already marked is out of date
  const missingScanKey = useMemo(() => JSON.stringify(segments.map((s) => [s.id, s.start_time, s.end_time, s.text, s.speaker, s.voice_profile])), [segments]);
  useEffect(() => {
    ++missingRequest.current;
    setMissingGaps([]);
    setMissingError(null);
    setLoadingMissing(false);
    if (!showMissing || isTranscribing) return;
    const timer = window.setTimeout(() => { void loadMissingGaps(); }, 400);
    return () => {
      window.clearTimeout(timer);
      ++missingRequest.current;
    };
  }, [missingScanKey, showMissing, isTranscribing, loadMissingGaps]);

  // Ruler scrub: mousedown on ruler starts drag-to-seek
  const handleRulerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRulerDragging(true);
    rulerWasPlayingRef.current = !!videoRef.current && !videoRef.current.paused;
    if (videoRef.current && !videoRef.current.paused) videoRef.current.pause();
    // Seek immediately to click position
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left + (containerRef.current?.scrollLeft || 0);
    const time = xToTime(x); // timeline time
    if (clipLayout.length > 0) {
      const result = timelineToSource(clipLayout, time);
      if (result && videoRef.current) videoRef.current.currentTime = result.sourceTime;
    } else if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
    setCurrentTime(time);
  };

  useEffect(() => {
    if (!rulerDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (e.buttons === 0) {
        // Mouse button is no longer held — the mouseup was missed
        // (released outside the window, app switch, …). End the drag.
        handleMouseUp();
        return;
      }
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left + (containerRef.current?.scrollLeft || 0);
      const time = xToTime(x); // timeline time
      if (clipLayout.length > 0) {
        const result = timelineToSource(clipLayout, time);
        if (result && videoRef.current) videoRef.current.currentTime = result.sourceTime;
      } else if (videoRef.current) {
        videoRef.current.currentTime = time;
      }
      setCurrentTime(time);
    };

    const handleMouseUp = () => {
      setRulerDragging(false);
      if (rulerWasPlayingRef.current && videoRef.current) {
        videoRef.current.play();
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [rulerDragging, xToTime, setCurrentTime, videoRef, clipLayout]);

  /** Click selection shared by caption and voice clips — both are views of the same line.
   *  Shift adds the range from the active line, Cmd/Ctrl toggles one line, a plain click
   *  selects just this one. */
  const selectWithModifiers = (e: React.MouseEvent, seg: Segment) => {
    const currentSelected = new Set(useProjectStore.getState().selectedSegmentIds);
    const sortedSegs = [...(currentProject?.segments || [])].sort((a, b) => a.start_time - b.start_time);

    if (e.shiftKey) {
      // Shift+Click: Range selection between activeSegmentId and clicked seg
      const activeId = useProjectStore.getState().activeSegmentId;
      if (activeId) {
        const fromIdx = sortedSegs.findIndex((s) => s.id === activeId);
        const toIdx = sortedSegs.findIndex((s) => s.id === seg.id);
        if (fromIdx !== -1 && toIdx !== -1) {
          const start = Math.min(fromIdx, toIdx);
          const end = Math.max(fromIdx, toIdx);
          for (let i = start; i <= end; i++) {
            currentSelected.add(sortedSegs[i].id);
          }
          setSelectedSegmentIds(new Set(currentSelected));
        } else {
          currentSelected.add(seg.id);
          setSelectedSegmentIds(new Set(currentSelected));
        }
      } else {
        currentSelected.add(seg.id);
        setSelectedSegmentIds(new Set(currentSelected));
      }
    } else if (e.metaKey || e.ctrlKey) {
      // Cmd/Ctrl+Click: Toggle individual segment in/out of selection
      if (currentSelected.has(seg.id)) {
        currentSelected.delete(seg.id);
      } else {
        currentSelected.add(seg.id);
      }
      setSelectedSegmentIds(new Set(currentSelected));
    } else {
      // Single Click: If segment wasn't already selected, focus select just this one
      if (!currentSelected.has(seg.id) || currentSelected.size > 1) {
        setSelectedSegmentIds(new Set([seg.id]));
      }
    }
  };

  // --- Box (marquee) selection ---
  // Dragging across empty space in the caption or voice lanes selects every clip the box
  // touches — what a three-finger drag on a Mac trackpad does. A plain click still seeks.
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueeJustEndedRef = useRef(false);
  const handleMarqueeStart = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const container = containerRef.current;
    if (e.button !== 0 || !container) return;
    const lane = target.closest<HTMLElement>('[data-marquee-lane]');
    if (!lane || target.closest('[data-seg-id], button, input, select')) return;
    setSelectionLane(lane.dataset.marqueeLane === 'voice' ? 'voice' : 'caption');

    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const base = additive ? new Set(useProjectStore.getState().selectedSegmentIds) : new Set<string>();
    const toContent = (clientX: number, clientY: number) => {
      const r = container.getBoundingClientRect();
      return { x: clientX - r.left + container.scrollLeft, y: clientY - r.top + container.scrollTop };
    };
    const start = toContent(e.clientX, e.clientY);
    const startClient = { x: e.clientX, y: e.clientY };
    let active = false;
    let last = { x: e.clientX, y: e.clientY };
    let frame = 0;

    const update = () => {
      frame = 0;
      const end = toContent(last.x, last.y);
      setMarquee({ x0: start.x, y0: start.y, x1: end.x, y1: end.y });
      // compare in screen space against where each clip is actually drawn
      const r = container.getBoundingClientRect();
      const box = {
        left: Math.min(start.x, end.x) - container.scrollLeft + r.left,
        right: Math.max(start.x, end.x) - container.scrollLeft + r.left,
        top: Math.min(start.y, end.y) - container.scrollTop + r.top,
        bottom: Math.max(start.y, end.y) - container.scrollTop + r.top,
      };
      const next = new Set(base);
      container.querySelectorAll<HTMLElement>('[data-seg-id]').forEach((el) => {
        const c = el.getBoundingClientRect();
        if (c.right >= box.left && c.left <= box.right && c.bottom >= box.top && c.top <= box.bottom) {
          next.add(el.dataset.segId!);
        }
      });
      setSelectedSegmentIds(next);
    };

    const onMove = (ev: MouseEvent) => {
      last = { x: ev.clientX, y: ev.clientY };
      if (!active) {
        // a few pixels of slack, so a click with a wobble is still a click
        if (Math.hypot(ev.clientX - startClient.x, ev.clientY - startClient.y) < 5) return;
        active = true;
      }
      // keep going past the visible edge on a long timeline
      const r = container.getBoundingClientRect();
      if (ev.clientX > r.right - 30) container.scrollLeft += 20;
      else if (ev.clientX < r.left + 30) container.scrollLeft -= 20;
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (frame) cancelAnimationFrame(frame);
      if (active) {
        update();
        marqueeJustEndedRef.current = true;
        // if no click follows (released outside the timeline), don't swallow the next real one
        setTimeout(() => (marqueeJustEndedRef.current = false), 0);
      }
      setMarquee(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleSegmentMouseDown = (
    e: React.MouseEvent,
    seg: Segment,
    type: 'move' | 'resize-start' | 'resize-end'
  ) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectionLane('caption');
    selectWithModifiers(e, seg);

    setDragging({
      segmentId: seg.id,
      type,
      startX: e.clientX,
      originalStart: seg.start_time,
      originalEnd: seg.end_time,
    });
    setActiveSegment(seg.id);
  };

  // Dragging a caption. The clip is moved straight on the page, once per frame, and the
  // project only hears about it when the clip is dropped. Writing every mouse move into the
  // store re-rendered the whole editor each time and re-packed the caption lanes mid-drag,
  // so the clip stuttered behind the pointer and hopped between rows.
  const clipLayoutRef = useRef(clipLayout);
  clipLayoutRef.current = clipLayout;

  useEffect(() => {
    if (!dragging) return;

    const snap = dragging; // stable snapshot of drag start state
    const container = containerRef.current;
    const startScroll = container?.scrollLeft ?? 0;
    const length = Math.max(0.1, snap.originalEnd - snap.originalStart);
    const round = (t: number) => Math.round(t * 100) / 100;
    // the caption clip and its voice clip are the same line, so both follow the pointer
    const clips = () =>
      Array.from(container?.querySelectorAll<HTMLElement>(`[data-seg-id="${CSS.escape(snap.segmentId)}"]`) ?? []);

    let pointerX = snap.startX;
    let moved = false;
    let pos = { start: snap.originalStart, end: snap.originalEnd };
    let frame = 0;
    let done = false;

    const readout = document.createElement('div');
    readout.className =
      'fixed z-[100] pointer-events-none rounded bg-black/85 px-1.5 py-0.5 text-[10px] font-mono text-white shadow-lg';
    readout.style.display = 'none';
    document.body.appendChild(readout);
    const bodyCursor = document.body.style.cursor;
    document.body.style.cursor = snap.type === 'move' ? 'grabbing' : 'ew-resize';

    const place = () => {
      const pps = pixelsPerSecondRef.current || (20 * zoom) || 20;
      // scrolling under a still pointer moves the clip too
      const dx = pointerX - snap.startX + ((container?.scrollLeft ?? startScroll) - startScroll);
      const dt = dx / pps;
      const maxAllowedDuration = Math.max(
        durationRef.current || 0,
        sourceDurationRef.current || 0,
        currentProject?.duration || 0,
        3600
      );

      let newStart = snap.originalStart;
      let newEnd = snap.originalEnd;
      if (snap.type === 'move') {
        newStart = Math.max(0, Math.min(snap.originalStart + dt, maxAllowedDuration - length));
        newEnd = newStart + length;
      } else if (snap.type === 'resize-start') {
        newStart = Math.max(0, Math.min(snap.originalStart + dt, snap.originalEnd - 0.2));
      } else {
        newEnd = Math.min(maxAllowedDuration, Math.max(snap.originalEnd + dt, snap.originalStart + 0.2));
      }
      pos = { start: newStart, end: newEnd };

      const layout = clipLayoutRef.current;
      const range = layout.length > 0
        ? sourceRangeToTimeline(layout, newStart, newEnd)
        : { timelineStart: newStart, timelineEnd: newEnd };
      const left = range.timelineStart * pps;
      const width = Math.max(range.timelineEnd * pps - left, 6);
      for (const el of clips()) {
        el.style.transition = 'none';
        el.style.left = `${left}px`;
        el.style.width = `${width}px`;
      }
      readout.textContent = snap.type === 'resize-end'
        ? `${formatFrameTime(newEnd)}  (${(newEnd - newStart).toFixed(2)}s)`
        : snap.type === 'resize-start'
        ? `${formatFrameTime(newStart)}  (${(newEnd - newStart).toFixed(2)}s)`
        : `${formatFrameTime(newStart)} → ${formatFrameTime(newEnd)}`;
    };

    const tick = () => {
      frame = 0;
      if (done) return;
      // Near an edge the timeline keeps scrolling for as long as the pointer rests there,
      // faster the closer it is — it used to advance only while the mouse was moving.
      if (container) {
        const rect = container.getBoundingClientRect();
        const edge = 60;
        const before = container.scrollLeft;
        if (pointerX > rect.right - edge) {
          container.scrollLeft += Math.ceil(Math.min(1, (pointerX - (rect.right - edge)) / edge) * 18);
        } else if (pointerX < rect.left + edge) {
          container.scrollLeft -= Math.ceil(Math.min(1, (rect.left + edge - pointerX) / edge) * 18);
        }
        if (container.scrollLeft !== before) frame = requestAnimationFrame(tick);
      }
      place();
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (e.buttons === 0) {
        handleMouseUp();
        return;
      }
      pointerX = e.clientX;
      if (!moved) {
        // a click with a wobble is still a click: nothing moves, nothing is saved
        if (Math.abs(e.clientX - snap.startX) < 3) return;
        moved = true;
        pushUndo();
        readout.style.display = 'block';
      }
      readout.style.left = `${e.clientX + 12}px`;
      readout.style.top = `${e.clientY - 28}px`;
      if (!frame) frame = requestAnimationFrame(tick);
    };

    const cleanup = () => {
      done = true;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      if (frame) cancelAnimationFrame(frame);
      readout.remove();
      document.body.style.cursor = bodyCursor;
      for (const el of clips()) el.style.transition = '';
    };

    const handleMouseUp = async () => {
      if (done) return;
      if (moved) place(); // the last mouse position, not the last painted frame
      cleanup();
      setDragging(null);
      if (!moved) return;
      const start = round(pos.start);
      // a move keeps the line's exact length, so its voice is not thrown away as mismatched
      const end = snap.type === 'move' ? round(start + length) : round(pos.end);
      await updateSegment(snap.segmentId, { start_time: start, end_time: end });
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return cleanup;
  }, [dragging]); // no currentProject/pixelsPerSecond — read from refs/store instead

  // Clip whole-body move drag handler
  const handleClipBodyMouseDown = useCallback((
    e: React.MouseEvent,
    clip: VideoClip
  ) => {
    e.stopPropagation();
    if (lockedTracks.has('V') || lockedTracks.has('V1')) return;
    pushUndo();
    setClipDragging({
      clipId: clip.id,
      type: 'move',
      startX: e.clientX,
      originalStart: clip.source_start,
      originalEnd: clip.source_end,
    });
    setSelectedClipId(clip.id);
  }, [pushUndo, lockedTracks]);

  // Nudge clip forward / backward by delta seconds
  const handleNudgeClip = async (clipId: string, delta: number) => {
    const clips = videoClipsRef.current;
    const clip = clips.find(c => c.id === clipId);
    if (!clip || !currentProject) return;
    const sorted = [...clips].sort((a, b) => a.source_start - b.source_start);
    const clipIdx = sorted.findIndex(c => c.id === clipId);
    const prevClip = clipIdx > 0 ? sorted[clipIdx - 1] : null;
    const nextClip = clipIdx < sorted.length - 1 ? sorted[clipIdx + 1] : null;

    const clipDur = clip.source_end - clip.source_start;
    const minStart = prevClip ? prevClip.source_end : 0;
    const maxEnd = nextClip ? nextClip.source_start : (currentProject.duration || sourceDurationRef.current);

    const newStart = Math.max(minStart, Math.min(clip.source_start + delta, Math.max(minStart, maxEnd - clipDur)));
    const newEnd = newStart + clipDur;

    pushUndo();
    setVideoClips(clips.map(c => c.id === clipId ? { ...c, source_start: newStart, source_end: newEnd } : c));
    try {
      await updateVideoClip(currentProject.id, clip.id, newStart, newEnd);
    } catch (err: any) {
      console.error('Nudge clip failed:', err);
    }
  };

  // Nudge V1 track time / selected clip forward / backward
  const handleNudgeV1Track = (delta: number) => {
    if (selectedClipId) {
      handleNudgeClip(selectedClipId, delta);
      return;
    }
    if (videoRef.current) {
      const nextTime = Math.max(0, Math.min(duration, currentTime + delta));
      videoRef.current.currentTime = nextTime;
      setCurrentTime(nextTime);
    }
  };

  useEffect(() => {
    const handleNudgeEvent = (e: CustomEvent<number>) => {
      handleNudgeV1Track(e.detail);
    };
    window.addEventListener('timeline-nudge' as any, handleNudgeEvent);
    return () => window.removeEventListener('timeline-nudge' as any, handleNudgeEvent);
  }, [selectedClipId, duration, currentTime]);

  // Clip resize drag handler
  const handleClipResizeDown = useCallback((
    e: React.MouseEvent,
    clip: VideoClip,
    type: 'resize-start' | 'resize-end'
  ) => {
    e.stopPropagation();
    e.preventDefault();
    pushUndo();
    setClipDragging({
      clipId: clip.id,
      type,
      startX: e.clientX,
      originalStart: clip.source_start,
      originalEnd: clip.source_end,
    });
    setSelectedClipId(clip.id);
  }, [pushUndo]);

  // Use refs to avoid stale closures during drag
  const videoClipsRef = useRef(videoClips);
  videoClipsRef.current = videoClips;

  useEffect(() => {
    if (!clipDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (e.buttons === 0) {
        handleMouseUp();
        return;
      }
      const dx = e.clientX - clipDragging.startX;
      const dt = dx / pixelsPerSecond;
      const clipId = clipDragging.clipId;
      const clips = videoClipsRef.current;

      let newStart = clipDragging.originalStart;
      let newEnd = clipDragging.originalEnd;

      // Find neighboring clips for boundary constraints
      const sorted = [...clips].sort((a, b) => a.source_start - b.source_start);
      const clipIdx = sorted.findIndex(c => c.id === clipId);
      const prevClip = clipIdx > 0 ? sorted[clipIdx - 1] : null;
      const nextClip = clipIdx < sorted.length - 1 ? sorted[clipIdx + 1] : null;

      if (clipDragging.type === 'resize-start') {
        const minStart = prevClip ? prevClip.source_end : 0;
        newStart = Math.max(minStart, Math.min(clipDragging.originalStart + dt, clipDragging.originalEnd - 0.1));
        setVideoClips(clips.map(c =>
          c.id === clipId ? { ...c, source_start: newStart, source_end: newEnd } : c
        ));
      } else if (clipDragging.type === 'resize-end') {
        const maxEnd = nextClip ? nextClip.source_start : sourceDurationRef.current;
        newEnd = Math.max(clipDragging.originalStart + 0.1, Math.min(clipDragging.originalEnd + dt, maxEnd));
        setVideoClips(clips.map(c =>
          c.id === clipId ? { ...c, source_start: newStart, source_end: newEnd } : c
        ));
      } else if (clipDragging.type === 'move') {
        const layout = buildClipLayout(clips);
        const currentLayout = layout.find(l => l.clip.id === clipId);
        const currentIdx = sorted.findIndex(c => c.id === clipId);

        if (currentLayout && clips.length > 1) {
          const draggedCenterTime = currentLayout.timelineStart + dt + currentLayout.clipDuration / 2;
          let targetSlot = currentIdx;
          let minDistance = Infinity;
          layout.forEach((l, sIdx) => {
            const slotCenter = l.timelineStart + l.clipDuration / 2;
            const dist = Math.abs(draggedCenterTime - slotCenter);
            if (dist < minDistance) {
              minDistance = dist;
              targetSlot = sIdx;
            }
          });
          setClipDragging(prev => prev ? { ...prev, currentDeltaX: dx, targetIndex: targetSlot } : null);
        } else {
          const clipDur = clipDragging.originalEnd - clipDragging.originalStart;
          const minStart = prevClip ? prevClip.source_end : 0;
          const maxEnd = nextClip ? nextClip.source_start : sourceDurationRef.current;
          newStart = Math.max(minStart, Math.min(clipDragging.originalStart + dt, Math.max(minStart, maxEnd - clipDur)));
          newEnd = newStart + clipDur;
          setVideoClips(clips.map(c =>
            c.id === clipId ? { ...c, source_start: newStart, source_end: newEnd } : c
          ));
        }
      }
    };

    const handleMouseUp = async () => {
      const clipId = clipDragging.clipId;
      const clips = videoClipsRef.current;
      const sorted = [...clips].sort((a, b) => a.index - b.index);

      if (clipDragging.type === 'move' && clips.length > 1) {
        const currentIdx = sorted.findIndex(c => c.id === clipId);
        const targetIdx = clipDragging.targetIndex ?? currentIdx;
        if (targetIdx !== currentIdx && targetIdx >= 0 && targetIdx < sorted.length) {
          const reordered = [...sorted];
          const [moved] = reordered.splice(currentIdx, 1);
          reordered.splice(targetIdx, 0, moved);
          const newClips = reordered.map((c, i) => ({ ...c, index: i }));
          setVideoClips(newClips);
          if (currentProject) {
            try {
              const updated = await reorderVideoClips(currentProject.id, newClips.map(c => c.id));
              setVideoClips(updated);
            } catch (err: any) {
              console.error('Failed to reorder clips on drag release:', err);
              undoStackRef.current.pop();
            }
          }
          setClipDragging(null);
          return;
        }
      }

      const clip = videoClipsRef.current.find(c => c.id === clipDragging.clipId);
      if (clip && currentProject) {
        try {
          await updateVideoClip(currentProject.id, clip.id, clip.source_start, clip.source_end);
        } catch (err: any) {
          console.error('Clip resize save failed:', err?.response?.data?.detail || err?.message);
          undoStackRef.current.pop();
        }
      }
      setClipDragging(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [clipDragging, pixelsPerSecond, currentProject, setVideoClips]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const playheadX = timeToX(currentTime);
    const viewLeft = container.scrollLeft;
    const viewRight = viewLeft + container.clientWidth;
    if (playheadX < viewLeft + 50 || playheadX > viewRight - 50) {
      container.scrollLeft = playheadX - container.clientWidth / 3;
    }
  }, [currentTime, timeToX]);

  const handleGenerateVoice = async () => {
    if (!currentProject || segments.length === 0) return;
    try {
      const isSelection = selectedSegmentIds.size > 0;
      const ids = isSelection ? Array.from(selectedSegmentIds) : undefined;
      await generateVoiceForSegments(ids, 1.0, 'A', undefined, undefined, !isSelection);
    } catch (err) {
      console.error('Generate voice failed:', err);
    }
  };

  // --- Editing tool handlers ---

  const handleFlip = async (direction: 'horizontal' | 'vertical') => {
    if (!currentProject || isFlipping) return;
    setIsFlipping(true);
    try {
      await flipVideo(currentProject.id, direction);
      await loadProject(currentProject.id);
    } catch (err: any) {
      console.error('Flip failed:', err);
    }
    setIsFlipping(false);
  };

  const handleRotate = async (angle: number) => {
    if (!currentProject || isRotating) return;
    setIsRotating(true);
    try {
      await rotateVideo(currentProject.id, angle);
      await loadProject(currentProject.id);
    } catch (err: any) {
      console.error('Rotate failed:', err);
    }
    setIsRotating(false);
  };

  const handleOpenCrop = () => {
    // Default crop to full video dimensions from the video element
    const vid = videoRef.current;
    if (vid) {
      setCropX(0);
      setCropY(0);
      setCropW(vid.videoWidth);
      setCropH(vid.videoHeight);
    } else {
      setCropX(0);
      setCropY(0);
      setCropW(1920);
      setCropH(1080);
    }
    setShowCropModal(true);
  };

  const handleCrop = async () => {
    if (!currentProject || isCropping) return;
    setIsCropping(true);
    try {
      const result = await cropVideo(currentProject.id, cropX, cropY, cropW, cropH);
      await updateProject(currentProject.id, { video_path: result.video_path });
      window.location.reload();
    } catch (err: any) {
      console.error('Crop failed:', err);
    }
    setIsCropping(false);
    setShowCropModal(false);
  };

  const handleToggleBookmark = () => {
    const t = Math.round(currentTime * 10) / 10;
    setBookmarks((prev) => {
      const exists = prev.some((b) => Math.abs(b - t) < 0.2);
      const next = exists ? prev.filter((b) => Math.abs(b - t) >= 0.2) : [...prev, t].sort((a, b) => a - b);
      if (currentProject?.id) {
        try {
          localStorage.setItem(`timeline-bookmarks-${currentProject.id}`, JSON.stringify(next));
        } catch {}
      }
      return next;
    });
  };

  // --- Deleting with the keyboard ---------------------------------------------------------
  // Whatever is selected on the timeline goes on Delete / Backspace: a text overlay, the logo,
  // a video clip, caption and voice lines, or the isolated stems. With nothing selected
  // nothing is deleted — the old fallback removed the line under the playhead, or, failing
  // that, every caption in the project.
  const [objectSel, setObjectSel] = useState<{ kind: 'overlay'; id: string } | { kind: 'logo' } | null>(null);
  const selectObject = (sel: typeof objectSel) => {
    setObjectSel(sel);
    if (sel) {
      setSelectedSegmentIds(new Set());
      setSelectedClipId(null);
    }
  };
  // picking a caption, voice or video clip takes the selection away from text and logo
  useEffect(() => {
    if (selectedSegmentIds.size > 0 || selectedClipId) setObjectSel(null);
  }, [selectedSegmentIds, selectedClipId]);

  /** Every undoable step in order, so Ctrl+Z also brings back a deleted text or logo. */
  type UndoEntry =
    | { kind: 'core' }
    | { kind: 'overlays'; before: TextOverlay[] }
    | { kind: 'logo'; before: LogoSettings };
  const undoLogRef = useRef<UndoEntry[]>([]);

  const removeOverlay = async (id: string) => {
    if (!currentProject?.id) return;
    const before = textOverlays;
    try {
      const saved = await saveTextOverlays(currentProject.id, before.filter((o) => o.id !== id));
      setTextOverlays(saved);
      window.dispatchEvent(new CustomEvent(TEXT_OVERLAYS_CHANGED));
      undoLogRef.current.push({ kind: 'overlays', before });
      setCanUndo(true);
      setObjectSel(null);
    } catch (e: any) {
      alert(`Could not delete the text: ${e?.message || e}`);
    }
  };

  const removeLogo = () => {
    if (!currentProject?.id || !logoSettings) return;
    undoLogRef.current.push({ kind: 'logo', before: logoSettings });
    setCanUndo(true);
    // off the video and out of exports; the image stays uploaded for the Logo button
    saveLogoSettings(currentProject.id, { ...logoSettings, url: '', enabled: false });
    setObjectSel(null);
  };

  const undoAny = async () => {
    const last = undoLogRef.current.pop();
    if (last?.kind === 'overlays' && currentProject?.id) {
      const saved = await saveTextOverlays(currentProject.id, last.before);
      setTextOverlays(saved);
      window.dispatchEvent(new CustomEvent(TEXT_OVERLAYS_CHANGED));
    } else if (last?.kind === 'logo' && currentProject?.id) {
      saveLogoSettings(currentProject.id, last.before);
    } else {
      await handleUndo();
    }
    setCanUndo(undoLogRef.current.length > 0 || undoStackRef.current.length > 0);
  };

  const handleDeleteSelected = async () => {
    if (objectSel?.kind === 'overlay') return removeOverlay(objectSel.id);
    if (objectSel?.kind === 'logo') return removeLogo();
    if (selectedClipId) {
      if (
        (selectedClipId === 'vocals-track' || selectedClipId === 'bgm-track') &&
        !confirm('Remove the isolated vocals & BGM? This deletes the separated audio and cannot be undone.')
      ) {
        return;
      }
      handleDeleteClip(selectedClipId);
      return;
    }
    const selectedIds = Array.from(selectedSegmentIds);
    if (selectedIds.length > 0 && selectionLane === 'voice') {
      // selected in the voice lane: the voices go, the captions stay
      await removeVoices(selectedIds);
      return;
    }
    if (selectedIds.length > 0) {
      pushUndo(); // so Ctrl+Z brings the lines back
      await deleteMultipleSegments(selectedIds);
      setSelectedSegmentIds(new Set());
      if (currentProject?.id) await loadProject(currentProject.id);
    }
  };
  const deleteSelectedRef = useRef(handleDeleteSelected);
  deleteSelectedRef.current = handleDeleteSelected;
  const undoAnyRef = useRef(undoAny);
  undoAnyRef.current = undoAny;

  const handleAutoFitAudio = useCallback(async () => {
    if (!currentProject?.id || isAutoFitting) return;
    setIsAutoFitting(true);
    try {
      const targetIds = selectedSegmentIds.size > 0 ? Array.from(selectedSegmentIds) : undefined;
      const plan = await autoFitAudioToSubtitles(currentProject.id, targetIds, true);
      if (!plan.updated_count) {
        alert(
          plan.runs_on
            ? `Every voice already fits. ${plan.runs_on} run past their caption into silence, which is fine.`
            : 'Every voice already fits its line — nothing to change.',
        );
        return;
      }
      pushUndo();  // so Ctrl+Z brings the old voices back
      const res = await autoFitAudioToSubtitles(currentProject.id, targetIds);
      await loadProject(currentProject.id);
      const tooLong = res.too_long_lines
        .slice(0, 5)
        .map((l) => `  ${l.start_time.toFixed(1)}s  ${l.text}`)
        .join('\n');
      alert(
        `Fitted ${res.updated_count} voices: ${res.sped_up + res.too_long} sped up, ${res.slowed} slowed slightly. ` +
          `${res.left + res.runs_on} left at their natural pace.` +
          (res.too_long
            ? `\n\n${res.too_long} still run into the next line even at the fastest natural pace — ` +
              `use Shorten in the toolbar to reword them, or give them more room:\n${tooLong}`
            : ''),
      );
    } catch (e: any) {
      alert(e?.response?.data?.detail || e?.message || 'Could not fit the voices');
    } finally {
      setIsAutoFitting(false);
    }
  }, [currentProject?.id, isAutoFitting, selectedSegmentIds, loadProject, pushUndo]);

  const handleFitToView = useCallback(() => {
    if (!containerRef.current || duration <= 0) return;
    setFitMode(true);
    setZoom(getFitZoom());
    containerRef.current.scrollLeft = 0;
  }, [duration, getFitZoom]);

  // Fit the whole video to the timeline, and keep it fitted.
  // This used to happen once, on the first render — which is before the project has loaded,
  // so it fitted a 30-second placeholder and never looked again. It also only ever zoomed
  // out, so a short clip was left filling a fraction of the width.
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    observer.observe(el);
    setContainerWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  // a different project starts fitted, whatever zoom the last one was left at
  useEffect(() => {
    setFitMode(true);
  }, [currentProject?.id]);

  useEffect(() => {
    if (!fitMode || duration <= 0 || !containerRef.current || dragging) return;
    const fit = getFitZoom();
    if (Math.abs(fit - zoomRef.current) > fit * 0.002) {
      setZoom(fit);
      containerRef.current.scrollLeft = 0;
    }
  }, [fitMode, duration, containerWidth, getFitZoom, dragging]);

  // Wheel handling:
  // - Ctrl/Cmd + Wheel: Zoom in/out horizontally at pointer position
  // - Shift + Wheel (or trackpad deltaX): Smoothly scroll timeline horizontally left/right
  // - Vertical Wheel (no modifier):
  //     - If tracks overflow vertically, scroll tracks Up / Down
  //     - If no vertical overflow, scroll timeline horizontally Left / Right
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // 1. Ctrl / Cmd + Wheel -> Zoom In / Out
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const pointerX = e.clientX - rect.left;
        const current = zoomRef.current;
        const pointerTime = (pointerX + el.scrollLeft) / (20 * current);
        // Scale with how hard the wheel/trackpad was pushed. A fixed step per event made a
        // trackpad — which fires many small deltas — lurch 15% at a time.
        const factor = Math.exp(-e.deltaY * 0.0022);
        const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, current * factor));
        if (Math.abs(newZoom - current) < 0.0001) return;
        // Hold the moment under the pointer still; the scroll is corrected after layout,
        // once the track is actually its new width.
        zoomAnchorRef.current = { time: pointerTime, pointerX };
        setFitMode(false);
        setZoom(newZoom);
        return;
      }

      // 2. Shift + Wheel or Alt + Wheel -> Force horizontal scroll
      if (e.shiftKey || e.altKey) {
        e.preventDefault();
        el.scrollLeft += (e.deltaY || e.deltaX) * 0.95;
        return;
      }

      // 3. Trackpad 2-finger horizontal swipe (deltaX predominant) -> Horizontal scroll
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        el.scrollLeft += e.deltaX;
        return;
      }

      // 4. Vertical mouse wheel / Trackpad vertical swipe -> Scroll tracks Up & Down
      if (Math.abs(e.deltaY) > 0) {
        const hasVerticalOverflow = el.scrollHeight > el.clientHeight + 10;
        if (hasVerticalOverflow) {
          // Native vertical scroll through tracks
          el.scrollTop += e.deltaY;
          if (trackLabelsRef.current) {
            trackLabelsRef.current.scrollTop = el.scrollTop;
          }
        } else if (el.scrollWidth > el.clientWidth) {
          // If no vertical overflow, convert to horizontal scroll for convenience
          e.preventDefault();
          el.scrollLeft += e.deltaY * 0.95;
        }
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Close the zoom menu on outside click
  useEffect(() => {
    if (!showZoomDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (zoomDropdownRef.current && !zoomDropdownRef.current.contains(e.target as Node)) setShowZoomDropdown(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showZoomDropdown]);

  const [viewportScrollLeft, setViewportScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(800);

  // Time markers calculation — spans the full scrollable width of the timeline
  const targetPxBetweenMarkers = 85;
  const rawSeconds = targetPxBetweenMarkers / Math.max(pixelsPerSecond, 0.1);
  const standardSteps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const markerInterval = standardSteps.find((s) => s >= rawSeconds) || 60;

  const maxRulerTime = totalWidth / Math.max(pixelsPerSecond, 0.1);
  const markers: number[] = [];
  const firstMarker = Math.max(0, Math.floor((viewportScrollLeft - viewportWidth) / Math.max(pixelsPerSecond, 0.1) / markerInterval) * markerInterval);
  const lastMarker = Math.min(maxRulerTime, (viewportScrollLeft + 2 * viewportWidth) / Math.max(pixelsPerSecond, 0.1));
  for (let t = firstMarker; t <= lastMarker; t += markerInterval) {
    markers.push(+t.toFixed(3));
  }

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const f = Math.floor((s % 1) * 30);
    if (markerInterval < 1) {
      return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}:${f.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  const TRACK_LABEL_WIDTH = 182;
  const TRACK_HEIGHT = 52;
  const VIDEO_TRACK_HEIGHT = 72;
  const toggleHidden = (t: string) => {
    toggleTrackVisibility(t);
  };
  const [showTransform, setShowTransform] = useState(false);
  const [rippleEnabled, setRippleEnabled] = useState(false);
  const minimapRef = useRef<HTMLDivElement>(null);

  // Bucketed caption density for the minimap: constant cost regardless of project size.
  const captionDensity = useMemo(() => {
    const buckets = new Array(MINIMAP_BUCKETS).fill(false);
    if (duration <= 0) return buckets;
    for (const seg of segments) {
      const from = Math.max(0, Math.floor((seg.start_time / duration) * MINIMAP_BUCKETS));
      const to = Math.min(MINIMAP_BUCKETS - 1, Math.floor((seg.end_time / duration) * MINIMAP_BUCKETS));
      for (let i = from; i <= to; i++) buckets[i] = true;
    }
    return buckets;
  }, [segments, duration]);

  // Only the visible slice of the timeline is rendered, with a screen of margin either side,
  // so a 2,000-caption project doesn't build tens of thousands of DOM nodes.
  const visibleWindow = useMemo(() => {
    const margin = viewportWidth;
    const pps = Math.max(0.0001, pixelsPerSecond);
    return {
      from: Math.max(0, (viewportScrollLeft - margin) / pps),
      to: (viewportScrollLeft + viewportWidth + margin) / pps,
    };
  }, [viewportScrollLeft, viewportWidth, pixelsPerSecond]);

  const [hoverRulerTime, setHoverRulerTime] = useState<number | null>(null);

  // Sync viewport width & scrollLeft for minimap
  const updateViewportMetrics = useCallback(() => {
    if (containerRef.current) {
      setViewportScrollLeft(containerRef.current.scrollLeft);
      setViewportWidth(containerRef.current.clientWidth);
    }
  }, []);

  useEffect(() => {
    updateViewportMetrics();
    const handleResize = () => updateViewportMetrics();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [updateViewportMetrics, totalWidth]);

  // Jump to previous cut point / bookmark
  const handleJumpPrevCut = useCallback(() => {
    const cutPoints: number[] = [0];
    clipLayout.forEach((c) => {
      cutPoints.push(c.timelineStart);
      cutPoints.push(c.timelineEnd);
    });
    segments.forEach((s) => {
      cutPoints.push(s.start_time);
      cutPoints.push(s.end_time);
    });
    bookmarks.forEach((b) => cutPoints.push(b));

    const sorted = Array.from(new Set(cutPoints)).sort((a, b) => a - b);
    const prevPoints = sorted.filter((p) => p < currentTime - 0.05);
    const target = prevPoints.length > 0 ? prevPoints[prevPoints.length - 1] : 0;

    setCurrentTime(target);
    if (videoRef.current) {
      if (clipLayout.length > 0) {
        const res = timelineToSource(clipLayout, target);
        if (res) videoRef.current.currentTime = res.sourceTime;
      } else {
        videoRef.current.currentTime = target;
      }
    }
  }, [clipLayout, segments, bookmarks, currentTime, setCurrentTime, videoRef]);

  // Jump to next cut point / bookmark
  const handleJumpNextCut = useCallback(() => {
    const cutPoints: number[] = [duration];
    clipLayout.forEach((c) => {
      cutPoints.push(c.timelineStart);
      cutPoints.push(c.timelineEnd);
    });
    segments.forEach((s) => {
      cutPoints.push(s.start_time);
      cutPoints.push(s.end_time);
    });
    bookmarks.forEach((b) => cutPoints.push(b));

    const sorted = Array.from(new Set(cutPoints)).sort((a, b) => a - b);
    const nextPoints = sorted.filter((p) => p > currentTime + 0.05);
    const target = nextPoints.length > 0 ? nextPoints[0] : duration;

    setCurrentTime(target);
    if (videoRef.current) {
      if (clipLayout.length > 0) {
        const res = timelineToSource(clipLayout, target);
        if (res) videoRef.current.currentTime = res.sourceTime;
      } else {
        videoRef.current.currentTime = target;
      }
    }
  }, [clipLayout, segments, bookmarks, currentTime, duration, setCurrentTime, videoRef]);

  // Step 1 frame
  const handleStepFrame = useCallback((deltaFrames: number) => {
    const frameTime = 1 / 30; // 30fps
    const target = Math.max(0, Math.min(duration, currentTime + deltaFrames * frameTime));
    setCurrentTime(target);
    if (videoRef.current) {
      if (clipLayout.length > 0) {
        const res = timelineToSource(clipLayout, target);
        if (res) videoRef.current.currentTime = res.sourceTime;
      } else {
        videoRef.current.currentTime = target;
      }
    }
  }, [currentTime, duration, clipLayout, setCurrentTime, videoRef]);

  // Minimap drag to seek & scroll
  const handleMinimapMouseDown = (e: React.MouseEvent) => {
    if (!minimapRef.current || duration <= 0) return;
    const rect = minimapRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetTime = ratio * duration;

    setCurrentTime(targetTime);
    if (videoRef.current) {
      if (clipLayout.length > 0) {
        const res = timelineToSource(clipLayout, targetTime);
        if (res) videoRef.current.currentTime = res.sourceTime;
      } else {
        videoRef.current.currentTime = targetTime;
      }
    }

    if (containerRef.current && totalWidth > 0) {
      const scrollPos = ratio * totalWidth - containerRef.current.clientWidth / 2;
      containerRef.current.scrollLeft = Math.max(0, scrollPos);
    }
  };

  // Keyboard Shortcuts Listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (videoRef.current) {
          if (videoRef.current.paused) {
            videoRef.current.play();
          } else {
            videoRef.current.pause();
          }
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (e.shiftKey) {
          handleStepFrame(-30);
        } else {
          handleStepFrame(-1);
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (e.shiftKey) {
          handleStepFrame(30);
        } else {
          handleStepFrame(1);
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        setCurrentTime(0);
        if (videoRef.current) videoRef.current.currentTime = 0;
      } else if (e.key === 'End') {
        e.preventDefault();
        setCurrentTime(duration);
        if (videoRef.current) videoRef.current.currentTime = duration;
      } else if (e.key === 's' || e.key === 'S' || e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        handleSplitAtPlayhead();
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        handleToggleBookmark();
      } else if (e.key === 'z' || e.key === 'Z') {
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          if (e.shiftKey) {
            handleRedo();
          } else {
            undoAnyRef.current();
          }
        } else {
          e.preventDefault();
          handleFitToView();
        }
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        handleRedo();
      } else if (e.key === '[' || (e.altKey && e.key === 'ArrowLeft')) {
        e.preventDefault();
        handleJumpPrevCut();
      } else if (e.key === ']' || (e.altKey && e.key === 'ArrowRight')) {
        e.preventDefault();
        handleJumpNextCut();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        const allIds = new Set((currentProject?.segments || []).map((s) => s.id));
        setSelectionLane('caption');
        setSelectedSegmentIds(allIds);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelectedRef.current();
      } else if (e.key === 'Escape') {
        setSelectedSegmentIds(new Set());
        setObjectSel(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleStepFrame, handleSplitAtPlayhead, handleToggleBookmark, handleFitToView, handleJumpPrevCut, handleJumpNextCut, handleUndo, handleRedo, duration, setCurrentTime, videoRef]);

  // Tell the page how tall the timeline wants to be, so it can fit the tracks on screen
  // +1: the text overlay track (TX), always shown so text can be added from the timeline
  // The text (TX) and logo (LG) tracks appear only once there is something on them — text
  // added with the Text button above the video, a logo with the Logo button
  const hasText = textOverlays.length > 0;
  const hasLogo = !!logoSettings?.url;
  const trackCount = laneCount + (hasText ? 1 : 0) + (hasLogo ? 1 : 0) + aiTrackProfiles.length + (audioSeparated ? 2 : 0);
  // The text overlay track (TX): drag clips to move, their edges to resize, double-click to edit
  const txLabel = (
    <>
      {hasText && (
        <OverlayTrackLabel
          height={TRACK_HEIGHT}
          count={textOverlays.length}
          pos={txTrack.pos}
          onMove={txTrack.setPosition}
        />
      )}
      {hasLogo && <LogoTrackLabel height={TRACK_HEIGHT} logo={logoSettings} />}
    </>
  );
  const txLane = currentProject?.id && hasText ? (
    <OverlayTrackLane
      projectId={currentProject.id}
      overlays={textOverlays}
      setOverlays={setTextOverlays}
      height={TRACK_HEIGHT}
      duration={duration}
      timeToX={timeToX}
      xToSeconds={(px) => px / pixelsPerSecond}
      markers={markers}
      currentTime={currentTime}
      selectedId={objectSel?.kind === 'overlay' ? objectSel.id : null}
      onSelect={(id) => selectObject(id ? { kind: 'overlay', id } : null)}
      onDelete={(o) => removeOverlay(o.id)}
    />
  ) : null;
  // The logo track (LG) travels with the text track wherever that is dragged
  const lgLane = currentProject?.id && logoSettings?.url ? (
    <LogoTrackLane
      projectId={currentProject.id}
      logo={logoSettings}
      setLogo={setLogoSettings}
      height={TRACK_HEIGHT}
      duration={duration}
      timeToX={timeToX}
      xToSeconds={(px) => px / pixelsPerSecond}
      markers={markers}
      selected={objectSel?.kind === 'logo'}
      onSelect={(on) => selectObject(on ? { kind: 'logo' } : null)}
    />
  ) : null;
  useEffect(() => {
    onContentHeight?.(TIMELINE_CHROME_HEIGHT + VIDEO_TRACK_HEIGHT + TRACK_HEIGHT * trackCount + 6);
  }, [trackCount, VIDEO_TRACK_HEIGHT, TRACK_HEIGHT, onContentHeight]);

  const formatFrameTime = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const f = Math.floor((sec % 1) * 30);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${f.toString().padStart(2, '0')}`;
  };

  // the toolbar's tools are grouped by what they act on, each group named
  const groupLabel = 'hidden 2xl:inline text-[9px] font-bold uppercase tracking-wider text-zinc-600 pl-1 pr-0.5 select-none';
  const divider = 'w-px h-4 bg-white/10 mx-1.5 shrink-0';

  return (
    <div className="flex flex-col h-full bg-[var(--s1)] text-[#e1e4ea] select-none font-sans">
      {/* Timeline toolbar: all editing tools visible, grouped by purpose */}
      <div className="h-10 border-b border-[var(--s4)] bg-[var(--s2)] px-2 flex items-center justify-between shrink-0 gap-2 relative z-30 overflow-visible">
        <div className="flex items-center gap-0.5 text-zinc-400 shrink min-w-0">
          <IconButton onClick={() => undoAny()} disabled={!canUndo} title="Undo (Ctrl+Z)">
            <Undo2 className="w-4 h-4" />
          </IconButton>
          <IconButton onClick={handleRedo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
            <Redo2 className="w-4 h-4" />
          </IconButton>
          <IconButton onClick={handleSplitAtPlayhead} disabled={!currentProject?.video_path || splitProcessing} title="Split at playhead (S)">
            {splitProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scissors className="w-4 h-4" />}
          </IconButton>
          <IconButton
            onClick={handleDeleteSelected}
            disabled={!objectSel && !selectedClipId && selectedSegmentIds.size === 0}
            title={
              selectedSegmentIds.size > 0 && selectionLane === 'voice' && !objectSel && !selectedClipId
                ? 'Remove the selected voices and keep their captions (Delete / Backspace)'
                : 'Delete what is selected (Delete / Backspace)'
            }
          >
            <Trash2 className="w-4 h-4" />
          </IconButton>

          <div className={divider} />

          {/* Captions: finding and fixing the lines */}
          <span className={groupLabel}>Captions</span>
          <button
            onClick={toggleMissing}
            disabled={!currentProject?.video_path || isTranscribing}
            title={showMissing ? 'Hide the speech that has no caption' : 'Mark speech that has no caption on the timeline'}
            className={`flex items-center gap-1.5 px-2 h-7 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
              showMissing ? 'bg-amber-500/20 text-amber-200' : 'text-zinc-400 hover:text-white hover:bg-white/10'
            }`}
          >
            {loadingMissing ? <Loader2 className="w-4 h-4 animate-spin" /> : <AlertCircle className="w-4 h-4" />}
            {loadingMissing ? 'Scanning…' : showMissing
              ? missingError && missingGaps.length === 0 ? 'Scan unavailable' : `${missingGaps.length} gaps`
              : 'Missing'}
          </button>
          {showMissing && missingError && (
            <span role="status" className="text-[11px] text-amber-300 max-w-64 truncate" title={missingError}>{missingError}</span>
          )}
          <IconButton onClick={handleSplitLongCaptions} disabled={isSplitting || !segments.length} title="Split captions that hold more text than they can show" label="Split long">
            {isSplitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Split className="w-4 h-4" />}
          </IconButton>
          <IconButton onClick={handleNormalizeRate} disabled={isEvening || !segments.length} title="Even out speaking rate: resize caption boxes to match their text" label="Even out">
            {isEvening ? <Loader2 className="w-4 h-4 animate-spin" /> : <Gauge className="w-4 h-4" />}
          </IconButton>
          <IconButton onClick={handleSnapToSpeech} disabled={isSnapping} title="Snap captions to speech (needs isolated vocals)" label="Snap">
            {isSnapping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Magnet className="w-4 h-4" />}
          </IconButton>
          <IconButton onClick={handleTidyCaptions} disabled={isFixingReading} title="Tidy captions: merge short lines, remove overlaps, fix reading speed" label="Tidy">
            {isFixingReading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Timer className="w-4 h-4" />}
          </IconButton>

          <div className={divider} />

          {/* Voices: making the dub fit its time */}
          <span className={groupLabel}>Voices</span>
          <IconButton
            onClick={() => {
              videoRef.current?.pause();
              useProjectStore.getState().setIsPlaying(false);
              const sourceTime = clipLayout.length ? timelineToSource(clipLayout, currentTime)?.sourceTime : currentTime;
              setCaptureTime(sourceTime ?? 0);
            }}
            disabled={!currentProject?.video_path}
            title="Capture a character's voice from the movie, to dub with"
            label="Capture"
          >
            <Mic className="w-4 h-4" />
          </IconButton>
          <IconButton
            onClick={handleAutoFitAudio}
            disabled={isAutoFitting || !segments.some((sg) => !!sg.audio_url)}
            title="Auto-fit: speed up voices that run into the next line, and gently stretch ones that end just short"
            label="Auto-fit"
          >
            {isAutoFitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          </IconButton>
          <IconButton onClick={handleLipTiming} disabled={isLipTiming || !segments.length} title="Lip timing: move each line onto the actor's speech and dub the changed lines again to fit (needs isolated vocals)" label="Lip timing">
            {isLipTiming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}
          </IconButton>
          <IconButton onClick={handleSpreadIntoSilence} disabled={isSpreading || !segments.length} title="Stretch captions into the silence after them, slowing each voice to match" label="Stretch">
            {isSpreading ? <Loader2 className="w-4 h-4 animate-spin" /> : <StretchHorizontal className="w-4 h-4" />}
          </IconButton>
          <IconButton onClick={handleShortenToFit} disabled={isShortening || !segments.length} title="Shorten to fit: reword lines that have more words than their time (or just the selected lines)" label="Shorten">
            {isShortening ? <Loader2 className="w-4 h-4 animate-spin" /> : <Minimize2 className="w-4 h-4" />}
          </IconButton>

          <div className={divider} />

          {/* Video and its sound */}
          <span className={groupLabel}>Video</span>
          <IconButton onClick={() => setShowCutPanel(true)} disabled={!segments.length} title="Review the stretches with no speech and cut them out of the video" label="Cut silence">
            <Scissors className="w-4 h-4" />
          </IconButton>
          <IconButton
            onClick={handleSeparateAudioClick}
            disabled={isSeparatingAudio}
            active={audioSeparated}
            title={audioSeparated ? 'The music is isolated. Click to remove the isolated voices and music.' : 'Isolate the voices and the background music'}
            label="Music"
          >
            {isSeparatingAudio ? <Loader2 className="w-4 h-4 animate-spin" /> : <Music className="w-4 h-4" />}
          </IconButton>
          {/* crop, rotate and flip are rarely needed: one button opens them */}
          <div className="relative" onMouseLeave={() => setShowTransform(false)}>
            <IconButton onClick={() => setShowTransform((v) => !v)} active={showTransform} title="Crop, rotate or flip the video" label="Transform">
              {isRotating || isFlipping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Crop className="w-4 h-4" />}
            </IconButton>
            {showTransform && (
              <div role="menu" className="absolute left-0 top-full z-50 w-48 rounded-lg border border-[var(--s5)] bg-[var(--s2)] shadow-xl py-1">
                {([
                  ['Crop…', Crop, handleOpenCrop, false],
                  ['Rotate right', RotateCw, () => handleRotate(90), isRotating],
                  ['Rotate left', RotateCcw, () => handleRotate(270), isRotating],
                  ['Flip left–right', FlipHorizontal, () => handleFlip('horizontal'), isFlipping],
                  ['Flip top–bottom', FlipVertical, () => handleFlip('vertical'), isFlipping],
                ] as [string, typeof Crop, () => void, boolean][]).map(([name, Icon, run, busy]) => (
                  <button
                    key={name}
                    role="menuitem"
                    disabled={busy}
                    onClick={() => { setShowTransform(false); run(); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] text-zinc-300 hover:text-white hover:bg-white/10 disabled:opacity-40 cursor-pointer"
                  >
                    <Icon className="w-3.5 h-3.5" /> {name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className={divider} />

          <IconButton onClick={handleToggleBookmark} title="Toggle bookmark at playhead (M)">
            <Bookmark className="w-4 h-4" />
          </IconButton>
          <IconButton onClick={() => setRippleEnabled(!rippleEnabled)} active={rippleEnabled} title={rippleEnabled ? 'Ripple edit is on: cutting or moving a clip moves everything after it' : 'Ripple edit: move everything after a clip when it is cut or moved'}>
            <MoveHorizontal className="w-4 h-4" />
          </IconButton>

          {isSeparatingAudio && (
            <span className="ml-1 flex items-center gap-1 text-[11px] text-zinc-500">
              <Loader2 className="w-3 h-3 animate-spin" /> {separationLabel}
            </span>
          )}
        </div>

        {/* Selection actions */}
        {selectedSegmentIds.size > 0 && (
          <div className="flex items-center gap-1 text-[11px] text-zinc-300 shrink-0">
            <span className="font-mono">{selectedSegmentIds.size} selected</span>
            <button
              onClick={handleGenerateVoice}
              disabled={isGeneratingAudio}
              className="px-2 py-0.5 rounded-md bg-white/10 hover:bg-white/15 flex items-center gap-1 cursor-pointer disabled:opacity-40"
              title="Dub selected segments with AI voice"
            >
              {isGeneratingAudio ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mic className="w-3 h-3" />}
              Dub
            </button>
            <IconButton onClick={handleDeleteSelected} title="Delete selected">
              <Trash2 className="w-3.5 h-3.5" />
            </IconButton>
            <IconButton onClick={() => setSelectedSegmentIds(new Set())} title="Deselect all (Esc)">
              <X className="w-3.5 h-3.5" />
            </IconButton>
          </div>
        )}

        {/* Zoom */}
        <div className="flex items-center gap-0.5 shrink-0">

          <IconButton onClick={handleFitToView} active={fitMode} title={fitMode ? 'The whole video is kept in view. Zoom in to turn this off (Z to fit again)' : 'Fit the whole video in view and keep it fitted (Z)'}>
            <Maximize2 className="w-3.5 h-3.5" />
          </IconButton>
          <div className="relative" ref={zoomDropdownRef}>
            <button
              onClick={() => {
                setShowZoomDropdown(!showZoomDropdown);
              }}
              className="flex items-center gap-1 px-1.5 py-1 rounded-md hover:bg-white/10 text-xs font-mono text-zinc-400 hover:text-white cursor-pointer"
              title="Timeline zoom (Ctrl + scroll)"
            >
              {isFitZoom ? 'Fit' : `${Math.round(zoom * 100)}%`}
              <ChevronDown className="w-3 h-3" />
            </button>

            {showZoomDropdown && (
              <div className="absolute bottom-full right-0 mb-1 w-28 bg-[var(--s2)] border border-[var(--s5)] rounded-lg shadow-xl py-1 z-50">
                {[
                  { label: 'Fit', value: 'fit' },
                  { label: '25%', value: 0.25 },
                  { label: '50%', value: 0.5 },
                  { label: '100%', value: 1.0 },
                  { label: '200%', value: 2.0 },
                  { label: '300%', value: 3.0 },
                ].map((item) => {
                  const isCurrent = item.value === 'fit' ? isFitZoom : Math.abs(zoom - (item.value as number)) < 0.02;
                  return (
                    <button
                      key={item.label}
                      onClick={() => {
                        if (item.value === 'fit') handleFitToView();
                        else {
                          setFitMode(false);
                          setZoom(item.value as number);
                        }
                        setShowZoomDropdown(false);
                      }}
                      className={`w-full px-3 py-1 text-left text-xs font-mono hover:bg-white/5 cursor-pointer ${
                        isCurrent ? 'text-white' : 'text-zinc-400'
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ──── Mini Timeline Navigator (Minimap) ──── */}
      {duration > 0 && (
        <div
          ref={minimapRef}
          onMouseDown={handleMinimapMouseDown}
          className="h-3 bg-[var(--s1)] border-b border-[var(--s3)] relative cursor-pointer group/minimap overflow-hidden shrink-0 select-none"
          title="Overview Navigator — Click or drag to jump anywhere across the video"
        >
          {/* Clips Representation */}
          <div className="absolute inset-0 flex items-center opacity-40 pointer-events-none">
            {clipLayout.map((c, i) => (
              <div
                key={`mini-clip-${c.clip.id || i}`}
                className="h-1.5 bg-blue-500/80 rounded-xs mx-px"
                style={{
                  width: `${((c.timelineEnd - c.timelineStart) / duration) * 100}%`,
                }}
              />
            ))}
          </div>

          {/* Subtitles Representation — bucketed, so the strip costs the same at any project size */}
          <div className="absolute inset-0 flex items-center opacity-70 pointer-events-none">
            {captionDensity.map((filled, i) =>
              filled ? (
                <div
                  key={`mini-bucket-${i}`}
                  className="absolute h-1 bg-zinc-400/70 rounded-xs"
                  style={{ left: `${(i / MINIMAP_BUCKETS) * 100}%`, width: `${100 / MINIMAP_BUCKETS}%` }}
                />
              ) : null
            )}
          </div>

          {/* Bookmarks */}
          {bookmarks.map((bm, i) => (
            <div
              key={`mini-bm-${i}`}
              className="absolute top-0 bottom-0 w-0.5 bg-blue-400 pointer-events-none z-10"
              style={{ left: `${(bm / duration) * 100}%` }}
            />
          ))}

          {/* Current Playhead indicator */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-blue-400 z-20"
            style={{ left: `${(currentTime / duration) * 100}%` }}
          />

          {/* Active Viewport Window Box */}
          {totalWidth > 0 && (
            <div
              className="absolute top-0.5 bottom-0.5 rounded-xs border border-white/40 bg-white/10 group-hover/minimap:bg-white/20 transition-colors pointer-events-none z-15"
              style={{
                left: `${(viewportScrollLeft / Math.max(1, totalWidth)) * 100}%`,
                width: `${Math.min(100, Math.max(2, (viewportWidth / Math.max(1, totalWidth)) * 100))}%`,
              }}
            />
          )}
        </div>
      )}

      {/* Timeline body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Track labels sidebar */}
        <div
          ref={trackLabelsRef}
          className="relative shrink-0 border-r border-[var(--s4)] overflow-hidden bg-[var(--s2)] select-none"
          style={{ width: TRACK_LABEL_WIDTH }}
          onWheel={(e) => {
            if (containerRef.current) {
              containerRef.current.scrollTop += e.deltaY;
            }
          }}
        >
          {/* Time ruler spacer */}
          <div className="h-7 border-b border-[var(--s4)] bg-[var(--s2)]" />

          {/* V1 — Video Track */}
          <div
            className="flex items-center justify-between px-2 border-b border-[var(--s4)] group relative bg-[rgb(var(--s2-rgb)/0.6)] hover:bg-[var(--s3)] transition-colors"
            style={{ height: VIDEO_TRACK_HEIGHT }}
          >
            <div className="flex items-center gap-1.5">
              <TrackTag code="V1" name="Video" />
            </div>
            <div className="flex items-center gap-1 text-zinc-400">
              {!audioSeparated ? (
                <div className="flex items-center gap-0.5 bg-[var(--s1)] px-1 py-0.5 rounded-lg border border-blue-500/20" title={`Video Audio Volume: ${Math.round(videoVolume * 100)}%`}>
                  <button
                    onClick={() => setA2Muted(!a2Muted)}
                    className="p-0.5 rounded hover:bg-blue-900/50 text-zinc-400 hover:text-white transition-colors cursor-pointer"
                    title={a2Muted ? 'Unmute Video Audio' : 'Mute Video Audio'}
                  >
                    {a2Muted || videoVolume === 0 ? (
                      <VolumeX className="w-3 h-3 text-red-400" />
                    ) : videoVolume < 0.5 ? (
                      <Volume1 className="w-3 h-3 text-blue-400" />
                    ) : (
                      <Volume2 className="w-3 h-3 text-blue-400" />
                    )}
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={a2Muted ? 0 : videoVolume}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setVideoVolume(v);
                      if (a2Muted && v > 0) setA2Muted(false);
                    }}
                    className="w-10 h-1 bg-zinc-700 accent-blue-400 rounded-lg cursor-pointer"
                    title={`Video Audio Volume: ${Math.round(videoVolume * 100)}%`}
                  />
                </div>
              ) : (
                <button
                  onClick={() => setA2Muted(!a2Muted)}
                  className="p-1 rounded hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
                  title="Mute video audio"
                >
                  {a2Muted ? <VolumeX className="w-3 h-3 text-red-400" /> : <Volume2 className="w-3 h-3" />}
                </button>
              )}
              <button
                onClick={() => toggleHidden('V1')}
                className="p-1 rounded hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
                title={hiddenTracks.has('V1') || hiddenTracks.has('V') || !videoVisible ? 'Show video track' : 'Hide video track'}
              >
                {hiddenTracks.has('V1') || hiddenTracks.has('V') || !videoVisible ? <EyeOff className="w-3 h-3 text-red-400" /> : <Eye className="w-3 h-3" />}
              </button>
            </div>
          </div>

          {/* TX — text overlays: under the video, the captions or the voices, as chosen */}
          {txTrack.pos === 'top' && txLabel}

          {/* T tracks / Subtitles */}
          {Array.from({ length: laneCount }, (_, i) => {
            const laneKey = `T${i + 1}`;
            const isHidden = hiddenTracks.has(laneKey) || hiddenTracks.has('T') || !subtitlesVisible;
            return (
              <div
                key={`t-label-${i}`}
                data-track-group="captions"
                className="flex items-center justify-between px-2.5 border-b border-[var(--s4)] group bg-[rgb(var(--s2-rgb)/0.4)] hover:bg-[var(--s3)] transition-colors"
                style={{ height: TRACK_HEIGHT }}
              >
                <TrackTag code={`T${i + 1}`} name={laneCount > 1 ? `Captions ${i + 1}` : 'Captions'} />
                <div className="flex items-center gap-1.5 text-zinc-400">
                  <button
                    onClick={() => toggleHidden(laneKey)}
                    className="p-1 rounded hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
                    title={isHidden ? 'Show track subtitles' : 'Hide track subtitles'}
                  >
                    {isHidden ? <EyeOff className="w-3 h-3 text-red-400" /> : <Eye className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            );
          })}

          {txTrack.pos === 'middle' && txLabel}

          {/* A1 — AI Audio */}
          {aiTrackProfiles.map((profile, idx) => {
            const isMuted = aiMutedProfiles.has(profile);
            const aKey = `A${idx + 1}`;
            const isAHidden = hiddenTracks.has(aKey) || hiddenTracks.has('A');
            return (
              <div
                key={`ai-label-${profile}`}
                data-track-group="voices"
                className="flex items-center justify-between px-2.5 border-b border-[var(--s4)] group bg-[rgb(var(--s3-rgb)/0.4)] hover:bg-[var(--s3)] transition-colors"
                style={{ height: TRACK_HEIGHT }}
              >
                <TrackTag code={`A${idx + 1}`} name={profile === '_all' ? 'AI voice' : VOICE_TRACK_NAMES[profile] || profile} />
                <div className="flex items-center gap-1 text-zinc-400">
                  <button
                    onClick={() => toggleAiTrackMute(profile)}
                    className="p-1 rounded hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
                    title="Mute AI voice"
                  >
                    {isMuted ? <VolumeX className="w-3 h-3 text-red-400" /> : <Volume2 className="w-3 h-3" />}
                  </button>
                  <button
                    onClick={() => toggleHidden(aKey)}
                    className="p-1 rounded hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
                    title={isAHidden ? 'Show track' : 'Hide track'}
                  >
                    {isAHidden ? <EyeOff className="w-3 h-3 text-red-400" /> : <Eye className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            );
          })}

          {txTrack.pos === 'bottom' && txLabel}

          {/* Isolated Vocals / BGM Tracks */}
          {audioSeparated && (
            <>
              <StemTrackLabel kind="vocals" height={TRACK_HEIGHT} volume={vocalsVolume} muted={v1Muted} setVolume={setVocalsVolume} setMuted={setV1Muted} onRemove={onRemoveAudioSeparation} />
              <StemTrackLabel kind="bgm" height={TRACK_HEIGHT} volume={bgmVolume} muted={b1Muted} setVolume={setBgmVolume} setMuted={setB1Muted} onRemove={onRemoveAudioSeparation} />
            </>
          )}
        </div>

        {/* Scrollable timeline */}
        <div
          ref={containerRef}
          className={`flex-1 overflow-auto relative select-none transition-colors ${
            isTimelineDragging ? 'bg-blue-950/20 ring-2 ring-inset ring-blue-500/50' : ''
          }`}
          onClick={handleTimelineClick}
          onMouseDown={handleMarqueeStart}
          onClickCapture={(e) => {
            // the click that ends a box selection must not also move the playhead or clear it
            if (marqueeJustEndedRef.current) {
              marqueeJustEndedRef.current = false;
              e.stopPropagation();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            if (!isTimelineDragging) setIsTimelineDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setIsTimelineDragging(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            setIsTimelineDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) {
              handleAddVideoFile(file);
            }
          }}
          onScroll={(e) => {
            if (trackLabelsRef.current) {
              trackLabelsRef.current.scrollTop = e.currentTarget.scrollTop;
            }
            setViewportScrollLeft(e.currentTarget.scrollLeft);
          }}
        >
          {marquee && (
            <div
              className="absolute z-50 pointer-events-none rounded-sm border border-blue-300/90 bg-blue-400/15"
              style={{
                left: Math.min(marquee.x0, marquee.x1),
                top: Math.min(marquee.y0, marquee.y1),
                width: Math.abs(marquee.x1 - marquee.x0),
                height: Math.abs(marquee.y1 - marquee.y0),
              }}
            />
          )}

          {/* Drag & Drop Overlay Indicator */}
          {isTimelineDragging && (
            <div className="sticky left-0 top-0 w-full h-full min-h-[220px] z-50 pointer-events-none bg-blue-950/80 backdrop-blur-sm border-2 border-dashed border-blue-400 flex flex-col items-center justify-center gap-2 text-blue-200 animate-in fade-in">
              <Upload className="w-9 h-9 text-blue-300 animate-bounce" />
              <span className="text-sm font-bold text-white tracking-wide shadow-sm">
                Drop video file to add to timeline
              </span>
              <span className="text-xs text-blue-300/80 font-mono">
                Supports MP4, MOV, WebM, MKV, AVI, TS
              </span>
            </div>
          )}

          <div className="relative" style={{ width: totalWidth, minHeight: '100%' }}>
            {/* Speech with no caption: a band down the whole timeline so the holes line up
                with the caption track. Not clickable, so it never blocks clip dragging —
                the chips on the ruler above are the handles. */}
            {showMissing &&
              missingGaps.map((g) => (
                <div
                  key={`missing-band-${g.index}`}
                  className="absolute top-7 bottom-0 z-20 pointer-events-none bg-amber-400/10 border-x border-amber-400/40"
                  style={{
                    left: timeToX(g.start),
                    width: Math.max(2, timeToX(g.end) - timeToX(g.start)),
                  }}
                />
              ))}

            {/* Time ruler — click or drag to scrub */}
            <div
              className="h-7 border-b border-zinc-700/40 relative cursor-pointer group/ruler"
              style={{ backgroundColor: 'var(--bg-hover)' } as React.CSSProperties}
              onMouseDown={handleRulerMouseDown}
              onMouseMove={(e) => {
                const rect = containerRef.current?.getBoundingClientRect();
                if (!rect) return;
                const x = e.clientX - rect.left + (containerRef.current?.scrollLeft || 0);
                const t = Math.max(0, Math.min(duration, xToTime(x)));
                setHoverRulerTime(t);
              }}
              onMouseLeave={() => setHoverRulerTime(null)}
            >
              {showMissing &&
                missingGaps.map((g) => (
                  <button
                    key={`missing-chip-${g.index}`}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      seekToTime(g.start);
                    }}
                    title={`No caption here: ${fmtTime(g.start)} – ${fmtTime(g.end)} (${g.seconds.toFixed(1)}s). Click to jump.`}
                    className="absolute bottom-0 h-2 z-30 bg-amber-400/80 hover:bg-amber-300 rounded-sm cursor-pointer"
                    style={{
                      left: timeToX(g.start),
                      width: Math.max(3, timeToX(g.end) - timeToX(g.start)),
                    }}
                  />
                ))}

              {markers.map((t) => (
                <div
                  key={t}
                  className="absolute top-0 h-full flex flex-col items-center pointer-events-none"
                  style={{ left: timeToX(t) }}
                >
                  <span className="text-[9px] text-zinc-500 mt-1.5 whitespace-nowrap font-mono">
                    {fmtTime(t)}
                  </span>
                  <div className="flex-1 w-px bg-zinc-700/30" />
                </div>
              ))}
              {/* Bookmark Pins on Ruler */}
              {bookmarks.map((bm) => (
                <div
                  key={`bm-${bm}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurrentTime(bm);
                    if (videoRef.current) {
                      if (clipLayout.length > 0) {
                        const res = timelineToSource(clipLayout, bm);
                        if (res) videoRef.current.currentTime = res.sourceTime;
                      } else {
                        videoRef.current.currentTime = bm;
                      }
                    }
                  }}
                  className="absolute top-0 bottom-0 z-30 cursor-pointer group/bm"
                  style={{ left: timeToX(bm) }}
                  title={`Bookmark at ${formatFrameTime(bm)} (Click to jump)`}
                >
                  <div className="w-2.5 h-3 bg-blue-500 rounded-b-sm shadow-md flex items-center justify-center text-[9px] text-white -translate-x-1/2 hover:scale-125 transition-transform">
                    ★
                  </div>
                  <div className="w-px h-full bg-blue-500/50" />
                </div>
              ))}

              {/* Hover Ghost Needle & Time Pill */}
              {hoverRulerTime !== null && (
                <div
                  className="absolute top-0 bottom-0 pointer-events-none z-25"
                  style={{ left: timeToX(hoverRulerTime) }}
                >
                  <div className="w-px h-full bg-blue-400/70" />
                  <div className="absolute top-0.5 -translate-x-1/2 bg-[#0c131a] text-blue-300 border border-blue-500/60 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded shadow-lg whitespace-nowrap">
                    {formatFrameTime(hoverRulerTime)}
                  </div>
                </div>
              )}

              {/* Playhead handle on ruler — draggable */}
              <div
                className="absolute bottom-0 z-30 cursor-grab active:cursor-grabbing"
                style={{ left: timeToX(currentTime), padding: '0 6px', marginLeft: '-6px' }}
                onMouseDown={(e) => {
                  // Same as ruler drag, but initiated from handle
                  handleRulerMouseDown(e);
                }}
              >
                <div
                  className="w-0 h-0 -translate-x-[5px]"
                  style={{
                    borderLeft: '6px solid transparent',
                    borderRight: '6px solid transparent',
                    borderTop: '8px solid var(--text-bright)',
                    filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))',
                  }}
                />
              </div>
            </div>

            {/* ──── V0 Track — Video Clips with Thumbnails ──── */}
            <div
              className={`relative border-b border-zinc-700/30 transition-opacity ${hiddenTracks.has('V') || hiddenTracks.has('V1') || !videoVisible ? 'opacity-20' : ''}`}
              style={{ height: VIDEO_TRACK_HEIGHT }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file) handleAddVideoFile(file);
              }}
            >
              {/* Grid lines */}
              {markers.map((t) => (
                <div
                  key={`v0-grid-${t}`}
                  className="absolute top-0 bottom-0 w-px bg-zinc-700/15"
                  style={{ left: timeToX(t) }}
                />
              ))}

              {clipLayout.length > 0 ? (
                clipLayout.map((layoutItem) => {
                  const clip = layoutItem.clip;
                  const clipDuration = layoutItem.clipDuration;
                  const left = timeToX(layoutItem.timelineStart);
                  const width = Math.max(timeToX(layoutItem.timelineEnd) - left, 6);
                  const isSelected = clip.id === selectedClipId;

                  // Show resize handles if clip is trimmed or there are multiple clips
                  const canResize = !lockedTracks.has('V') && (videoClips.length > 1 || clip.source_start > 0 || clip.source_end < sourceDuration);

                  return (
                    <div
                      key={clip.id}
                      className={`absolute top-2 rounded-md cursor-grab active:cursor-grabbing transition-all group select-none ${
                        clipDragging?.clipId === clip.id
                          ? 'z-40 shadow-2xl scale-[1.02] ring-2 ring-blue-300 border-blue-300 pointer-events-none'
                          : isSelected
                          ? 'ring-2 ring-teal-300/70 z-20'
                          : 'z-10 hover:brightness-110'
                      }`}
                      style={{
                        left,
                        width,
                        height: VIDEO_TRACK_HEIGHT - 16,
                        border: `1px solid ${isSelected || clipDragging?.clipId === clip.id ? '#5eead4' : 'rgba(45, 212, 191, 0.35)'}`,
                        background: 'var(--s1)',
                        transform: clipDragging?.clipId === clip.id ? `translateX(${clipDragging.currentDeltaX || 0}px)` : undefined,
                        opacity: clipDragging?.clipId === clip.id ? 0.92 : 1,
                      }}
                      onMouseDown={(e) => handleClipBodyMouseDown(e, clip)}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!lockedTracks.has('V')) setSelectedClipId(isSelected ? null : clip.id);
                      }}
                    >
                      {/* Left resize handle */}
                      {canResize && (
                        <div
                          className="absolute top-0 w-3 h-full cursor-col-resize z-20 hover:bg-blue-400/30 transition-colors"
                          style={{ left: -4 }}
                          onMouseDown={(e) => handleClipResizeDown(e, clip, 'resize-start')}
                        >
                          <div className="absolute top-1/2 left-1 -translate-y-1/2 w-0.5 h-5 bg-blue-400/60 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      )}

                      {/* Right resize handle */}
                      {canResize && (
                        <div
                          className="absolute top-0 w-3 h-full cursor-col-resize z-20 hover:bg-blue-400/30 transition-colors"
                          style={{ right: -4 }}
                          onMouseDown={(e) => handleClipResizeDown(e, clip, 'resize-end')}
                        >
                          <div className="absolute top-1/2 right-1 -translate-y-1/2 w-0.5 h-5 bg-blue-400/60 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      )}

                      {/* Filmstrip: frames from this clip's own stretch of the source, edge to edge */}
                      {(() => {
                        const stripHeight = VIDEO_TRACK_HEIGHT - 20;
                        const frameWidth = Math.max(24, (stripHeight * 16) / 9);
                        const tiles = Math.min(120, Math.max(1, Math.ceil(width / frameWidth)));
                        const frameAt = (i: number) => {
                          if (!thumbnails.length || sourceDuration <= 0) return null;
                          const t = clip.source_start + ((i + 0.5) / tiles) * clipDuration;
                          const k = Math.min(thumbnails.length - 1, Math.max(0, Math.floor((t / sourceDuration) * thumbnails.length)));
                          return thumbnails[k];
                        };
                        const fullName = currentProject?.video_filename || 'Master video';
                        const title = clipTitle(fullName);
                        return (
                          <div className="relative h-full w-full overflow-hidden rounded-[5px] bg-[var(--s1)]" title={fullName}>
                            <div className="absolute inset-0 flex pointer-events-none">
                              {Array.from({ length: tiles }, (_, i) => {
                                const src = frameAt(i);
                                return src ? (
                                  <img
                                    key={i}
                                    src={src}
                                    alt=""
                                    draggable={false}
                                    className="h-full object-cover shrink-0 border-r border-black/40"
                                    style={{ width: frameWidth }}
                                  />
                                ) : (
                                  // frames are still being captured, or the video could not be read
                                  <div key={i} className="h-full shrink-0 bg-teal-950/50 border-r border-black/40" style={{ width: frameWidth }} />
                                );
                              })}
                            </div>
                            {/* Keeps the labels readable over bright frames */}
                            <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-transparent to-black/45 pointer-events-none" />

                            <div className="absolute top-1 left-1.5 right-8 flex items-center gap-1.5 min-w-0 pointer-events-none">
                              <span className="shrink-0 w-4 h-4 rounded bg-teal-500/90 text-[9px] font-bold text-black flex items-center justify-center">
                                {String.fromCharCode(65 + (clip.index ?? 0))}
                              </span>
                              {width > 90 && (
                                <span className="truncate text-[11px] font-medium text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
                                  {title}
                                </span>
                              )}
                            </div>

                            {width > 60 && (
                              <div className="absolute bottom-1 right-1.5 flex items-center gap-1 pointer-events-none">
                                <span className="hidden group-hover:inline px-1 py-px rounded bg-black/60 text-[9px] font-mono text-zinc-300">
                                  {fmtTime(clip.source_start)} → {fmtTime(clip.source_end)}
                                </span>
                                <span className="px-1 py-px rounded bg-black/60 text-[10px] font-mono text-teal-200">
                                  {fmtTime(clipDuration)}
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {/* Delete button (on selection or hover) */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!lockedTracks.has('V')) handleDeleteClip(clip.id);
                        }}
                        className={`absolute top-1 right-1 p-1 rounded bg-red-950/90 hover:bg-red-800 text-red-200 border border-red-700/60 transition-opacity z-30 shadow cursor-pointer ${
                          isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                        }`}
                        title="Delete clip (Delete/Backspace key)"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })
              ) : currentProject?.video_path ? (
                <div
                  onClick={async () => {
                    if (!currentProject) return;
                    try {
                      const updated = await addVideoClip(currentProject.id, 0, currentProject.duration || 10);
                      setVideoClips(updated);
                    } catch (err) {
                      console.error('Failed to add clip:', err);
                    }
                  }}
                  className="px-4 py-2 flex items-center gap-2.5 h-full cursor-pointer hover:bg-blue-950/30 text-blue-400 hover:text-blue-300 border border-dashed border-blue-500/40 rounded-lg mx-2 my-1 transition-all"
                  title="Click to place master video from My Assets back onto Timeline"
                >
                  <Plus className="w-4 h-4" />
                  <span className="text-xs font-semibold">
                    + Place "{currentProject.video_filename || 'Master Video'}" from My Assets onto Timeline
                  </span>
                </div>
              ) : (
                <div
                  onClick={handleAddClipClick}
                  className="px-4 py-2 flex items-center gap-2.5 h-full cursor-pointer hover:bg-blue-950/30 text-blue-400 hover:text-blue-300 border border-dashed border-blue-500/40 rounded-lg mx-2 my-1 transition-all"
                  title="Upload a new video to timeline"
                >
                  <Plus className="w-4 h-4" />
                  <span className="text-xs font-semibold">Click to Add / Upload Video to Timeline</span>
                </div>
              )}

              {/* Quick Append Video Button at end of timeline */}
              <button
                onClick={handleAddClipClick}
                disabled={isUploadingClip}
                aria-label="Add another video to the end of the timeline"
                className="absolute top-2 w-10 rounded-md border border-dashed border-blue-500/40 hover:border-blue-400 bg-blue-950/30 hover:bg-blue-900/50 text-blue-300 hover:text-blue-100 flex items-center justify-center transition-all z-20"
                // the same top and height as the video clips beside it
                style={{ left: timeToX(duration) + 12, height: VIDEO_TRACK_HEIGHT - 16 }}
                title="Add another video to the end of the timeline"
              >
                {isUploadingClip ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              </button>
            </div>

            {txTrack.pos === 'top' && txLane}
            {txTrack.pos === 'top' && lgLane}

            {/* ──── Text Tracks: T1, T2... ──── */}
            {Array.from({ length: laneCount }, (_, laneIdx) => {
              const isLaneHidden = hiddenTracks.has(`T${laneIdx + 1}`) || hiddenTracks.has('T') || !subtitlesVisible;
              return (
              <div
                key={`t-track-${laneIdx}`}
                data-marquee-lane="caption"
                className={`relative border-b border-zinc-700/30 transition-opacity ${isLaneHidden ? 'opacity-25' : ''}`}
                style={{ height: TRACK_HEIGHT }}
                onClick={(e) => {
                  if (e.target === e.currentTarget) {
                    setSelectedSegmentIds(new Set());
                  }
                }}
              >
                {markers.map((t) => (
                  <div
                    key={`t${laneIdx}-grid-${t}`}
                    className="absolute top-0 bottom-0 w-px bg-zinc-700/15 pointer-events-none"
                    style={{ left: timeToX(t) }}
                  />
                ))}

                {segments
                  .filter(
                    (seg) =>
                      laneMap.get(seg.id) === laneIdx
                  )
                  .map((seg) => {
                    const range = clipLayout.length > 0
                      ? sourceRangeToTimeline(clipLayout, seg.start_time, seg.end_time)
                      : { timelineStart: seg.start_time, timelineEnd: seg.end_time, isVisible: true };

                    // the clip being dragged stays mounted even when its saved position scrolls out of view
                    if (!range.isVisible || (dragging?.segmentId !== seg.id && (range.timelineEnd < visibleWindow.from || range.timelineStart > visibleWindow.to))) return null;

                    const left = timeToX(range.timelineStart);
                    const width = Math.max(timeToX(range.timelineEnd) - left, 6);
                    const color = speakerColors[seg.speaker] || COLORS[0];
                    const isActive = seg.id === activeSegmentId;
                    const isSelected = selectedSegmentIds.has(seg.id);

                    const isFreeze = seg.speaker === 'Freeze' || seg.voice_profile === 'freeze' || seg.text.includes('Freeze Frame');

                    return (
                      <div
                        key={seg.id}
                        data-seg-id={seg.id}
                        className={`absolute top-1.5 rounded-lg cursor-grab active:cursor-grabbing transition-[filter,box-shadow] select-none group/seg ${
                          isSelected
                            ? 'ring-2 ring-blue-400 border-2 border-blue-300 shadow-lg shadow-blue-950/70 z-20 brightness-110'
                            : isActive
                            ? 'ring-2 ring-white/70 shadow-md z-15'
                            : 'hover:brightness-125 hover:ring-1 hover:ring-white/30'
                        } ${mutedTracks.has(laneIdx) ? 'opacity-30' : ''}`}
                        style={{
                          left,
                          width,
                          height: TRACK_HEIGHT - 12,
                          background: isFreeze
                            ? 'linear-gradient(135deg, rgba(8, 145, 178, 0.6) 0%, rgba(6, 182, 212, 0.8) 50%, rgba(14, 165, 233, 0.6) 100%)'
                            : isSelected
                            ? 'linear-gradient(135deg, rgba(37, 99, 235, 0.75) 0%, rgba(29, 78, 216, 0.9) 100%)'
                            : `${color}55`,
                          borderLeft: isFreeze ? '3px solid #38bdf8' : isSelected ? '3px solid #60a5fa' : `3px solid ${color}`,
                          border: isFreeze ? '1px solid #38bdf8' : isSelected ? '1px solid #60a5fa' : undefined,
                          boxShadow: isFreeze ? '0 0 10px rgba(56, 189, 248, 0.4)' : isSelected ? '0 0 12px rgba(59, 130, 246, 0.5)' : undefined,
                          borderRadius: '7px',
                        }}
                        onMouseDown={(e) => handleSegmentMouseDown(e, seg, 'move')}
                        title={`${formatFrameTime(seg.start_time)} → ${formatFrameTime(seg.end_time)}  (${(seg.end_time - seg.start_time).toFixed(1)}s)${seg.speaker ? `\n${seg.speaker}` : ''}\n${seg.text}`}
                      >
                        {width >= 18 && (
                        <>
                        {/* Left Trim/Resize Handle */}
                        <div
                          className="absolute left-0 top-0 bottom-0 w-2.5 cursor-ew-resize hover:bg-white/40 active:bg-blue-400 rounded-l-lg flex items-center justify-center opacity-0 group-hover/seg:opacity-100 transition-opacity z-30"
                          onMouseDown={(e) => handleSegmentMouseDown(e, seg, 'resize-start')}
                          title="Drag to trim start time"
                        >
                          <div className="w-0.5 h-3 bg-white/70 rounded-full pointer-events-none" />
                        </div>

                        {width > 24 && (
                          <div className="px-2 py-0.5 overflow-hidden h-full flex flex-col justify-center pointer-events-none">
                            <p className="text-[10px] text-white font-khmer font-semibold truncate leading-tight flex items-center gap-1">
                              {isFreeze && <Snowflake className="w-2.5 h-2.5 text-blue-300 shrink-0 animate-pulse" />}
                              <span>{seg.text}</span>
                            </p>
                            {seg.speaker && width > 70 && (
                              <p className="text-[9px] text-white/70 font-mono truncate">
                                {isFreeze ? '2.0s Freeze' : seg.speaker}
                              </p>
                            )}
                          </div>
                        )}

                        {/* Right Trim/Resize Handle */}
                        <div
                          className="absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize hover:bg-white/40 active:bg-blue-400 rounded-r-lg flex items-center justify-center opacity-0 group-hover/seg:opacity-100 transition-opacity z-30"
                          onMouseDown={(e) => handleSegmentMouseDown(e, seg, 'resize-end')}
                          title="Drag to extend/trim end time"
                        >
                          <div className="w-0.5 h-3 bg-white/70 rounded-full pointer-events-none" />
                        </div>
                        </>
                        )}
                      </div>
                    );
                  })}

                {laneIdx === 0 && segments.length === 0 && !isTranscribing && (
                  <div className="sticky left-3 top-0 h-full flex items-center pointer-events-none">
                    <span className="text-[11px] text-zinc-600">No captions yet — use “Generate captions” in the Captions panel</span>
                  </div>
                )}

                {/* Real-time Streaming Pulse Indicator when AI is transcribing */}
                {isTranscribing && laneIdx === 0 && (
                  <div
                    className="absolute top-1.5 h-7 rounded-md bg-gradient-to-r from-blue-500/20 via-blue-500/30 to-transparent border border-dashed border-blue-500/50 animate-pulse pointer-events-none flex items-center px-2 z-10"
                    style={{
                      left: timeToX(segments.length > 0 ? segments[segments.length - 1].end_time : 0),
                      width: Math.max(90, timeToX(Math.max(1, (transcribePercent / 100) * duration)) - timeToX(segments.length > 0 ? segments[segments.length - 1].end_time : 0)),
                    }}
                  >
                    <span className="text-[9px] font-mono font-bold text-blue-300 flex items-center gap-1 truncate">
                      <Sparkles className="w-2.5 h-2.5 animate-spin text-blue-400" />
                      <span>Transcribing queue... ({transcribePercent}%)</span>
                    </span>
                  </div>
                )}
              </div>
            );
            })}

            {txTrack.pos === 'middle' && txLane}
            {txTrack.pos === 'middle' && lgLane}

            {/* ──── AI Audio Tracks — one per voice_profile ──── */}
            {aiTrackProfiles.map((profile, trackIdx) => {
              const isMuted = aiMutedProfiles.has(profile);
              const aKey = `A${trackIdx + 1}`;
              const isAHidden = hiddenTracks.has(aKey) || hiddenTracks.has('A');
              const trackSegs = profile === '_all'
                ? segments.filter(seg => seg.audio_url)
                : segments.filter(seg => seg.audio_url && (seg.voice_profile || 'female') === profile);
              const emptySegs = profile === '_all'
                ? segments.filter(s => s.audio_url).length === 0
                : trackSegs.length === 0;
              const trackLabel = profile === '_all' ? 'AI Audio' : `AI ${profile === 'male' ? '♂' : '♀'}`;
              return (
                <div
                  key={`ai-track-${profile}`}
                  data-marquee-lane="voice"
                  className={`relative border-b border-zinc-700/30 transition-opacity ${isAHidden ? 'opacity-25' : ''}`}
                  style={{ height: TRACK_HEIGHT }}
                  onClick={(e) => {
                    if (e.target === e.currentTarget) setSelectedSegmentIds(new Set());
                  }}
                >
                  {markers.map((t) => (
                    <div
                      key={`a${trackIdx + 1}-grid-${t}`}
                      className="absolute top-0 bottom-0 w-px bg-zinc-700/15"
                      style={{ left: timeToX(t) }}
                    />
                  ))}

                  {trackSegs.map((seg, idx) => {
                    const range = clipLayout.length > 0
                      ? sourceRangeToTimeline(clipLayout, seg.start_time, seg.end_time)
                      : { timelineStart: seg.start_time, timelineEnd: seg.end_time, isVisible: true };

                    // the clip being dragged stays mounted even when its saved position scrolls out of view
                    if (!range.isVisible || (dragging?.segmentId !== seg.id && (range.timelineEnd < visibleWindow.from || range.timelineStart > visibleWindow.to))) return null;

                    const left = timeToX(range.timelineStart);
                    const width = Math.max(timeToX(range.timelineEnd) - left, 6);
                    const isActive = seg.id === activeSegmentId;
                    const isSelected = selectedSegmentIds.has(seg.id) && selectedSegmentIds.size > 1;
                    return (
                      <div
                        key={`ai-${seg.id}`}
                        data-seg-id={seg.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`Voice clip: ${seg.speaker || seg.text.slice(0, 24)}`}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); e.currentTarget.click(); } }}
                        className={`absolute top-1 rounded-xl transition-[filter,box-shadow] overflow-hidden cursor-pointer shadow-md shadow-blue-950/30 select-none ${
                          isSelected
                            ? 'ring-2 ring-blue-400 ring-offset-1 ring-offset-black brightness-110 z-10'
                            : isActive
                            ? 'ring-2 ring-white ring-offset-1 ring-offset-black'
                            : 'hover:brightness-110'
                        } ${isMuted ? 'opacity-30' : ''}`}
                        style={{
                          left,
                          width,
                          height: TRACK_HEIGHT - 8,
                          background: 'linear-gradient(135deg, #7c3aed 0%, #9333ea 50%, #6d28d9 100%)',
                          border: '1px solid rgba(196, 181, 253, 0.4)',
                        }}
                        title={`${seg.voice_fx && seg.voice_fx !== 'normal' ? `Effect: ${VOICE_EFFECTS.find(v => v.value === seg.voice_fx)?.label ?? seg.voice_fx} · ` : ''}Cmd/Ctrl-click or Shift-click to select several · double-click for all of ${seg.speaker || 'this speaker'} · right-click for voice effects`}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setActiveSegment(seg.id);
                          setVoiceEffectError('');
                          // The keyboard menu key reports no pointer position, so anchor to the clip
                          const r = e.currentTarget.getBoundingClientRect();
                          const x = e.clientX || r.left + 8;
                          const y = e.clientY || r.bottom;
                          // Right-clicking inside a multi-selection acts on the whole selection
                          const sel = useProjectStore.getState().selectedSegmentIds;
                          setVoiceMenuScope(sel.size > 1 && sel.has(seg.id) ? 'selected' : 'line');
                          setSelectionLane('voice');
                          setVoiceMenu({ segmentId: seg.id, x, y });
                        }}
                        onMouseDown={(e) => {
                          // stops the browser selecting text on double-click / shift-click
                          if (e.detail > 1 || e.shiftKey) e.preventDefault();
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          const modified = e.shiftKey || e.metaKey || e.ctrlKey;
                          setSelectionLane('voice');
                          selectWithModifiers(e, seg);
                          if (!modified) {
                            // a plain click also moves the playhead, as before
                            if (videoRef.current) videoRef.current.currentTime = seg.start_time;
                            const tlTime = clipLayout.length > 0 ? sourceToTimeline(clipLayout, seg.start_time) : seg.start_time;
                            setCurrentTime(tlTime);
                          }
                          // Shift extends from the active line, so it stays put while extending
                          if (!e.shiftKey) setActiveSegment(seg.id);
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          // every voiced line by this speaker (or, unnamed, on this voice track)
                          const same = segments.filter(s =>
                            s.audio_url && (seg.speaker ? s.speaker === seg.speaker : (s.voice_profile || 'female') === (seg.voice_profile || 'female')),
                          );
                          setSelectedSegmentIds(new Set(same.map(s => s.id)));
                          setActiveSegment(seg.id);
                        }}
                      >
                        {width >= 28 && <>
                        {/* Audio Clip Header Title */}
                        <div className="px-2.5 pt-1 flex items-center justify-between gap-1 z-10 relative">
                          <span className="text-[10px] font-medium text-white/95 truncate">
                            {seg.speaker ? `${seg.speaker}.wav` : seg.text ? `${seg.text.slice(0, 24)}...wav` : 'speech.wav'}
                          </span>
                          <span className="flex items-center gap-1 text-[9px] font-mono text-blue-200/70 shrink-0">
                            {seg.voice_fx && seg.voice_fx !== 'normal' && <Wand2 className="w-2.5 h-2.5 text-purple-100" />}
                            {seg.audio_speed ? `${seg.audio_speed}x` : '1.0x'}
                          </span>
                        </div>

                        {/* Waveform Graphic */}
                        <div className="absolute inset-x-0 bottom-0 top-3 flex items-end justify-between px-1.5 pb-1 opacity-75 pointer-events-none gap-[1.5px] overflow-hidden">
                          {Array.from({ length: Math.min(100, Math.max(12, Math.floor(width / 3.5))) }).map((_, barIdx) => {
                            const barHeight = Math.sin((barIdx * 0.45) + (idx * 1.5)) * 40 + 50;
                            return (
                              <div
                                key={barIdx}
                                className="flex-1 bg-white/90 rounded-full"
                                style={{
                                  height: `${Math.max(15, Math.min(95, barHeight))}%`,
                                  minWidth: '1.5px',
                                  maxWidth: '3px',
                                }}
                              />
                            );
                          })}
                        </div>
                        </>}
                      </div>
                    );
                  })}

                  {emptySegs && (
                    <div className="px-3 py-1 flex items-center h-full">
                      <span className="text-[10px] text-blue-300/25">{trackLabel}</span>
                    </div>
                  )}
                </div>
              );
            })}

            {txTrack.pos === 'bottom' && txLane}
            {txTrack.pos === 'bottom' && lgLane}

            {/* ──── Isolated Vocals / BGM Tracks ──── */}
            {audioSeparated &&
              (['vocals', 'bgm'] as const).map((kind) => (
                <StemTrackLane
                  key={kind}
                  kind={kind}
                  peaks={stemPeaks[kind]}
                  height={TRACK_HEIGHT}
                  width={Math.max(timeToX(duration), 60)}
                  markers={markers}
                  timeToX={timeToX}
                  // greyed out when muted or turned down to nothing
                  muted={kind === 'vocals' ? v1Muted || vocalsVolume === 0 : b1Muted || bgmVolume === 0}
                  cleanLevel={kind === 'bgm' ? bgmClean : undefined}
                  onCleanLevel={kind === 'bgm' ? handleBgmClean : undefined}
                  cleaning={kind === 'bgm' ? bgmCleaning : undefined}
                  keepEffects={kind === 'bgm' ? bgmKeepEffects : undefined}
                  onKeepEffects={kind === 'bgm' ? handleKeepEffects : undefined}
                  effectsBusy={kind === 'bgm' ? effectsBusy : undefined}
                  selectedClipId={selectedClipId}
                  onSelect={(selectionId) => {
                    setSelectedClipId(selectionId);
                    setActiveSegment(null);
                  }}
                  onRemove={onRemoveAudioSeparation}
                />
              ))}

            {/* ──── Playhead — vertical line ──── */}
            <div
              className="absolute top-0 w-px z-20 pointer-events-none timeline-playhead"
              style={{
                left: timeToX(currentTime),
                // every track: captions, text, each voice track and the stems
                height: 7 + VIDEO_TRACK_HEIGHT + TRACK_HEIGHT * trackCount,
              }}
            />
          </div>
        </div>
      </div>

      {/* Hidden audio elements for AI audio playback */}
      {playbackSegments.map(seg => {
        const profile = seg.voice_profile || 'female';
        const isMuted = aiTrackProfiles[0] === '_all'
          ? aiMutedProfiles.has('_all')
          : aiMutedProfiles.has(profile);
        return (
          <VoicePlaybackAudio
            key={`ai-audio-${seg.id}-${seg.audio_url}`}
            id={seg.id}
            players={aiAudioRefs.current}
            initiated={audioInitiatedRef.current}
            src={seg.audio_url.startsWith('http') || seg.audio_url.startsWith('/') ? seg.audio_url : '/' + seg.audio_url.replace(/^\.\//, '')}
            muted={isMuted}
          />
        );
      })}

      {captureTime !== null && <VoiceCaptureModal initialTime={captureTime} onClose={() => setCaptureTime(null)} />}

      {showCropModal && (
        <CropModal
          rect={{ x: cropX, y: cropY, w: cropW, h: cropH }}
          onChange={(r) => {
            setCropX(r.x);
            setCropY(r.y);
            setCropW(r.w);
            setCropH(r.h);
          }}
          onApply={handleCrop}
          onClose={() => setShowCropModal(false)}
          busy={isCropping}
        />
      )}


      {voiceMenu && voiceMenuSeg && createPortal(
        <div
          ref={voiceMenuRef}
          role="menu"
          aria-label="Voice effect"
          onKeyDown={e => e.stopPropagation()}
          onContextMenu={e => e.preventDefault()}
          className="fixed z-[200] w-72 max-h-[calc(100vh-16px)] overflow-y-auto rounded-lg border border-[var(--s5)] bg-[var(--s2)] shadow-2xl py-1 text-xs"
          style={{
            // keep the whole menu on screen near the right and bottom edges
            left: Math.max(8, Math.min(voiceMenu.x, window.innerWidth - 296)),
            top: Math.max(8, Math.min(voiceMenu.y, window.innerHeight - 560)),
            // scroll rather than run off the bottom on a short window
            maxHeight: `calc(100vh - ${Math.max(8, Math.min(voiceMenu.y, window.innerHeight - 560))}px - 8px)`,
          }}
        >
          <div className="px-3 pt-1 pb-1.5 border-b border-[var(--s4)] mb-1">
            <div className="text-zinc-300 truncate" title={voiceMenuSeg.text}>{voiceMenuSeg.speaker || voiceMenuSeg.text.slice(0, 30) || 'Selected voice'}</div>
          </div>
          <button
            role="menuitem"
            onClick={playMenuLine}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-zinc-300 hover:bg-white/5"
          >
            <span className="w-3.5 shrink-0 flex justify-center"><Play className="w-3 h-3" /></span>
            Play this line
          </button>
          <button
            role="menuitem"
            onClick={() => void regenerateMenuVoice()}
            disabled={isGeneratingAudio || regeneratingVoice || !!applyingVoiceEffect}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-zinc-300 hover:bg-white/5 disabled:opacity-50 disabled:cursor-wait"
          >
            <span className="w-3.5 shrink-0 flex justify-center">
              {regeneratingVoice ? <Loader2 className="w-3 h-3 animate-spin text-purple-300" /> : <RefreshCw className="w-3 h-3" />}
            </span>
            {regeneratingVoice ? 'Regenerating…' : 'Regenerate voice'}
          </button>
          <div className="px-3 pt-2 pb-1 mt-1 border-t border-[var(--s4)] text-[10px] uppercase tracking-wide text-purple-300/80">Voice effect</div>
          {(speakerVoiceIds.length > 1 || selectedVoiceIds.length > 1) && (
            <div className="mx-3 mb-1 flex gap-0.5 p-0.5 rounded-md bg-[var(--s1)] border border-[var(--s4)] text-[10px]">
              {([
                ['line', 'This line'],
                ...(selectedVoiceIds.length > 1 ? [['selected', `Selected (${selectedVoiceIds.length})`]] : []),
                ...(speakerVoiceIds.length > 1 ? [['speaker', `All ${speakerVoiceIds.length} by speaker`]] : []),
              ] as ['line' | 'selected' | 'speaker', string][]).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setVoiceMenuScope(key)}
                  title={
                    key === 'speaker'
                      ? `Every voiced line by ${voiceMenuSeg.speaker}`
                      : key === 'selected'
                      ? 'Every voice clip you have selected'
                      : undefined
                  }
                  className={`flex-1 flex items-center justify-center gap-1 py-1 rounded ${
                    voiceMenuScope === key ? 'bg-purple-600/70 text-white' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {key === 'speaker' && <Users className="w-2.5 h-2.5" />}
                  {label}
                </button>
              ))}
            </div>
          )}
          {VOICE_EFFECT_GROUPS.map(({ group, items }) => (
          <div key={group}>
          {group !== 'Normal' && <div className="px-3 pt-1 text-[9px] uppercase tracking-wide text-zinc-500">{group}</div>}
          <div className="grid grid-cols-2 gap-1 px-2 pb-1">
            {items.map(({ value, label, hint }) => {
              const current = (voiceMenuSeg.voice_fx || 'normal') === value;
              const applying = applyingVoiceEffect === value;
              const busy = isGeneratingAudio || !!applyingVoiceEffect || regeneratingVoice;
              return (
                <div
                  key={value}
                  className={`group/fx relative flex items-center rounded-md border transition-colors ${
                    current ? 'border-purple-400/60 bg-purple-500/15' : 'border-transparent hover:bg-white/5'
                  } ${applyingVoiceEffect && !applying ? 'opacity-50' : ''}`}
                >
                  <button
                    role="menuitemradio"
                    aria-checked={current}
                    disabled={busy}
                    onClick={() => void applyTimelineVoiceEffect(value)}
                    title={hint}
                    className={`flex-1 min-w-0 flex items-center gap-1.5 pl-2 pr-6 py-1.5 text-left disabled:cursor-wait ${
                      current ? 'text-white' : 'text-zinc-300'
                    }`}
                  >
                    {applying ? (
                      <Loader2 className="w-3 h-3 shrink-0 animate-spin text-purple-300" />
                    ) : current ? (
                      <Check className="w-3 h-3 shrink-0 text-purple-300" />
                    ) : null}
                    <span className="truncate">{label}</span>
                  </button>
                  <button
                    onClick={() => void previewMenuEffect(value)}
                    disabled={!!previewingFx}
                    aria-label={`Preview ${label}`}
                    title={`Listen with ${label} — doesn't change the clip`}
                    className={`absolute right-1 p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 ${
                      previewingFx === value ? 'opacity-100' : 'opacity-0 group-hover/fx:opacity-100 focus:opacity-100'
                    }`}
                  >
                    {previewingFx === value ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Play className="w-2.5 h-2.5" />}
                  </button>
                </div>
              );
            })}
          </div>
          </div>
          ))}
          <p className="px-3 pb-1 text-[10px] text-zinc-500">Hover an effect and press ▶ to hear it first.</p>
          <div className="mt-1 border-t border-[var(--s4)] px-2 pt-1.5 pb-1">
            <button
              role="menuitem"
              disabled={isGeneratingAudio}
              onClick={() => void removeMenuVoice()}
              title="Take the dubbed voice off and keep the caption (Delete does the same for clips selected in this lane)"
              className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left text-red-300 hover:bg-red-500/15 disabled:opacity-40"
            >
              <Trash2 className="w-3 h-3 shrink-0" />
              <span className="truncate">
                {voiceMenuScope === 'speaker' && speakerVoiceIds.length > 1
                  ? `Remove ${speakerVoiceIds.length} voices of ${voiceMenuSeg.speaker}`
                  : voiceMenuScope === 'selected' && selectedVoiceIds.length > 1
                  ? `Remove ${selectedVoiceIds.length} selected voices`
                  : 'Remove voice'}
              </span>
              <span className="ml-auto text-[10px] text-zinc-500">keeps caption</span>
            </button>
          </div>
          {voiceEffectError && <div role="alert" className="px-3 pt-1.5 pb-1 mt-1 border-t border-[var(--s4)] text-red-300">{voiceEffectError}</div>}
        </div>,
        document.body,
      )}

      {showCutPanel && currentProject?.id && (
        <FillGapsModal
          projectId={currentProject.id}
          videoSeconds={duration}
          mode="cut"
          onBeforeCut={pushUndo}
          onClose={() => setShowCutPanel(false)}
          onPreview={(seconds: number) => seekToTime(seconds)}
          onChanged={() => {
            loadProject(currentProject.id);
            loadMissingGaps();
          }}
        />
      )}

    </div>
  );
}
