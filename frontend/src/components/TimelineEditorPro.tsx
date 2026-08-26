import { useRef, useState, useCallback, useEffect, useMemo, RefObject } from 'react';
import { useProjectStore } from '../stores/projectStore';
import type { Segment, VideoClip } from '../types';
import { getVideoClips, splitClipAtPlayhead, deleteVideoClip, restoreVideoClips, updateVideoClip, reorderVideoClips, updateProject, flipVideo, rotateVideo, changeVideoSpeed, cropVideo, blurVideoRegion, appendVideoFileToTimeline, addVideoClip, separateProjectAudio, sanitizeProjectTimeline } from '../api/client';
import { buildClipLayout, totalTimelineDuration, timelineToSource, sourceToTimeline, sourceRangeToTimeline } from '../utils/clipTimemap';
import {
  Volume2,
  Volume1,
  VolumeX,
  Languages,
  Sparkles,
  AudioLines,
  ChevronDown,
  Music,
  Mic,
  Loader2,
  Check,
  X,
  Scissors,
  Trash2,
  Film,
  MousePointer2,
  Undo2,
  Redo2,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  MoreHorizontal,
  FlipHorizontal,
  Gauge,
  Plus,
  ZoomIn,
  ZoomOut,
  FlipVertical,
  RotateCw,
  RotateCcw,
  Crop,
  Eraser,
  Copy,
  Type,
  Snowflake,
  Bookmark,
  TrendingUp,
  Play,
  Pause,
  Magnet,
  MoveHorizontal,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  Shuffle,
  GripHorizontal,
  ArrowLeftRight,
  Keyboard,
  SkipBack,
  SkipForward,
  Maximize2,
  Wand2,
  Zap,
  Upload,
} from 'lucide-react';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  vocalsRef?: RefObject<HTMLAudioElement | null>;
  bgmRef?: RefObject<HTMLAudioElement | null>;
  audioSeparated?: boolean;
  onAudioSeparated?: (vocalsUrl: string, bgmUrl: string) => void;
  onRemoveAudioSeparation?: () => void;
}

const COLORS = [
  '#3d8eff', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
];

const _UNUSED_SPEED = 0; // speed is now per-segment in SubtitleDataPanel

export default function TimelineEditor({ videoRef, vocalsRef, bgmRef, audioSeparated, onAudioSeparated, onRemoveAudioSeparation }: Props) {
  const {
    currentProject,
    currentTime,
    isPlaying,
    activeSegmentId,
    isTranscribing,
    transcribeProgress,
    transcribePercent,
    setActiveSegment,
    setCurrentTime,
    updateSegment,
    addSegment,
    generateTranscript,
    cancelTranscription,
    generateVoiceForSegments,
    videoClips,
    setVideoClips,
    loadProject,
    selectedSegmentIds,
    deleteSegment,
    deleteMultipleSegments,
    deleteAllSegments,
    videoMuted: a2Muted,
    setVideoMuted: setA2Muted,
    subtitlesVisible,
    videoVisible,
    hiddenTracks,
    toggleSubtitlesVisible,
    toggleVideoVisible,
    toggleTrackVisibility,
    aspectRatio,
    setAspectRatio,
    canvasZoom,
    setCanvasZoom,
    isGeneratingAudio,
    audioGenProgress,
    audioGenTotal,
  } = useProjectStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const trackLabelsRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(3);
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
  }, [currentProject?.id]);

  // Persist mute choices and volumes per project
  useEffect(() => {
    if (!currentProject?.id) return;
    localStorage.setItem(
      `timeline-mutes-${currentProject.id}`,
      JSON.stringify({
        tracks: Array.from(mutedTracks),
        ai: Array.from(aiMutedProfiles),
        b1: b1Muted,
        v1: v1Muted,
        a2: a2Muted,
      })
    );
    localStorage.setItem(`timeline-bgm-volume-${currentProject.id}`, String(bgmVolume));
    localStorage.setItem(`timeline-vocals-volume-${currentProject.id}`, String(vocalsVolume));
  }, [currentProject?.id, mutedTracks, aiMutedProfiles, b1Muted, v1Muted, a2Muted, bgmVolume, vocalsVolume]);

  // Generate Voice Audio state
  const [audioGenerating, setAudioGenerating] = useState(false);
  const [audioGenerated, setAudioGenerated] = useState(false);

  // Editing tools state
  const [showFlipPanel, setShowFlipPanel] = useState(false);
  const [showSpeedPanel, setShowSpeedPanel] = useState(false);
  const [isFlipping, setIsFlipping] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [showRotatePanel, setShowRotatePanel] = useState(false);
  const [isChangingSpeed, setIsChangingSpeed] = useState(false);
  const [showCropModal, setShowCropModal] = useState(false);
  const [isCropping, setIsCropping] = useState(false);
  const [cropX, setCropX] = useState(0);
  const [cropY, setCropY] = useState(0);
  const [cropW, setCropW] = useState(0);
  const [cropH, setCropH] = useState(0);
  const [showBlurModal, setShowBlurModal] = useState(false);
  const [isBlurring, setIsBlurring] = useState(false);
  const [blurSnapshot, setBlurSnapshot] = useState<string | null>(null);
  const [blurNatural, setBlurNatural] = useState({ w: 0, h: 0 });
  const [blurRegion, setBlurRegion] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [blurDrag, setBlurDrag] = useState<{
    mode: 'move' | 'tl' | 'tr' | 'bl' | 'br';
    startX: number;
    startY: number;
    orig: { x: number; y: number; width: number; height: number };
  } | null>(null);
  const blurImgRef = useRef<HTMLImageElement>(null);
  const flipPanelRef = useRef<HTMLDivElement>(null);
  const rotatePanelRef = useRef<HTMLDivElement>(null);
  const speedPanelRef = useRef<HTMLDivElement>(null);
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
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [isSeparatingAudio, setIsSeparatingAudio] = useState(false);

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
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<any>(null);

  // Undo/Redo history for video clips
  const undoStackRef = useRef<{ source_start: number; source_end: number }[][]>([]);
  const redoStackRef = useRef<{ source_start: number; source_end: number }[][]>([]);

  // Undo/Redo history for segment deletions
  type SegmentUndoAction = { type: 'delete-segment'; segment: Segment };
  const segmentUndoStackRef = useRef<SegmentUndoAction[]>([]);

  const snapshotClips = useCallback(() => {
    return videoClips.map(c => ({ source_start: c.source_start, source_end: c.source_end }));
  }, [videoClips]);

  const pushUndo = useCallback(() => {
    undoStackRef.current.push(snapshotClips());
    // Clear redo on new action
    redoStackRef.current = [];
  }, [snapshotClips]);

  // AI audio playback refs
  const aiAudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const audioInitiatedRef = useRef<Map<string, boolean>>(new Map());

  // Ruler scrubbing (drag playhead on time ruler)
  const [rulerDragging, setRulerDragging] = useState(false);
  const rulerWasPlayingRef = useRef(false);

  // Track lock state
  const [lockedTracks, setLockedTracks] = useState<Set<string>>(new Set());

  // Video thumbnails — extracted from video element
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const thumbGenRef = useRef(false);

  // Wire A2 mute to actual video audio (always mute video audio if stems are separated or a2Muted)
  useEffect(() => {
    if (videoRef.current) {
      if (audioSeparated || a2Muted || masterMuted) {
        videoRef.current.muted = true;
        videoRef.current.volume = 0;
      } else {
        videoRef.current.muted = false;
        videoRef.current.volume = masterVolume;
      }
    }
  }, [a2Muted, audioSeparated, masterMuted, masterVolume, videoRef]);

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

  // Generate video thumbnails for the timeline strip
  useEffect(() => {
    if (!currentProject?.video_path || !currentProject?.duration || thumbGenRef.current) return;
    const dur = currentProject.duration;
    if (dur <= 0) return;
    thumbGenRef.current = true;

    const videoFilename = currentProject.video_path.split('/').pop();
    const videoSrc = `/uploads/${currentProject.id}/${videoFilename}`;
    const thumbCount = Math.min(Math.max(Math.ceil(dur / 3), 8), 60);
    const interval = dur / thumbCount;

    const vid = document.createElement('video');
    vid.crossOrigin = 'anonymous';
    vid.muted = true;
    vid.preload = 'auto';
    vid.src = videoSrc;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = 80;
    canvas.height = 50;

    const thumbs: string[] = [];
    let idx = 0;

    vid.addEventListener('loadeddata', () => {
      const captureNext = () => {
        if (idx >= thumbCount) {
          setThumbnails(thumbs);
          vid.remove();
          return;
        }
        vid.currentTime = idx * interval + interval / 2;
      };

      vid.addEventListener('seeked', () => {
        ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
        thumbs.push(canvas.toDataURL('image/jpeg', 0.5));
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

  const toggleAiTrackMute = useCallback((profile: string) => {
    setAiMutedProfiles((prev) => {
      const next = new Set(prev);
      if (next.has(profile)) next.delete(profile);
      else next.add(profile);
      return next;
    });
  }, []);

  // AI audio playback: sync with timeline time
  useEffect(() => {
    const segs = [...(currentProject?.segments || [])].sort((a, b) => a.start_time - b.start_time);

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
      const isWithinWindow = offset >= -0.25 && offset < (clipDuration + 0.35);

      if (isWithinWindow) {
        audio.volume = isMuted ? 0 : 1;
        audio.muted = isMuted;

        const isInitiated = audioInitiatedRef.current.get(seg.id);
        if (!isInitiated) {
          audioInitiatedRef.current.set(seg.id, true);
          // If starting near segment boundary (offset <= 0.25s), start cleanly from 0 so the first word is never skipped
          const startSeek = offset <= 0.25 ? 0 : Math.min(clipDuration - 0.1, offset);
          try {
            audio.currentTime = startSeek;
          } catch {}
          audio.play().catch(() => {});
        } else {
          // If paused (e.g. user unmuted/resumed), ensure it keeps playing
          if (audio.paused) {
            audio.play().catch(() => {});
          }
          // Only re-sync on extreme manual scrub/seek drift (> 1.2s) to avoid buffer stutter
          const expectedTime = Math.max(0, offset);
          if (Math.abs(audio.currentTime - expectedTime) > 1.2) {
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
  }, [currentTime, isPlaying, aiMutedProfiles, aiTrackProfiles, currentProject?.segments, clipLayout, videoRef]);

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
    try {
      const updatedClips = await appendVideoFileToTimeline(currentProject.id, file);
      setVideoClips(updatedClips);
      await loadProject(currentProject.id);
      if (videoRef.current) {
        videoRef.current.load();
      }
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

  // Delete a clip (non-destructive — no video rebuild)
  const handleDeleteClip = useCallback(async (clipId: string) => {
    if (!currentProject) return;
    pushUndo();
    try {
      const result = await deleteVideoClip(currentProject.id, clipId);
      if (result.clips) {
        setVideoClips(result.clips);
      } else {
        setVideoClips(videoClips.filter(c => c.id !== clipId));
      }
      setSelectedClipId(null);
    } catch (err: any) {
      console.error('Delete clip failed:', err?.response?.data?.detail || err?.message);
      undoStackRef.current.pop(); // revert snapshot on failure
    }
  }, [currentProject, videoClips, setVideoClips, pushUndo]);

  // Delete a segment with undo support
  const handleDeleteSegment = useCallback(async (segmentId: string) => {
    if (!currentProject) return;
    const segment = currentProject.segments.find(s => s.id === segmentId);
    if (!segment) return;
    // Save to segment undo stack before deleting
    segmentUndoStackRef.current.push({ type: 'delete-segment', segment: { ...segment } });
    await deleteSegment(segmentId);
  }, [currentProject, deleteSegment]);

  // Undo
  const handleUndo = useCallback(async () => {
    if (!currentProject) return;

    // Segment undo takes priority (most recent user action)
    if (segmentUndoStackRef.current.length > 0) {
      const action = segmentUndoStackRef.current.pop()!;
      if (action.type === 'delete-segment') {
        const { id, project_id, created_at, updated_at, ...segData } = action.segment;
        await addSegment(segData);
      }
      return;
    }

    // Otherwise, undo video clip action
    if (undoStackRef.current.length === 0) return;
    const snapshot = undoStackRef.current.pop()!;
    // Save current state to redo
    redoStackRef.current.push(snapshotClips());
    try {
      const clips = await restoreVideoClips(currentProject.id, snapshot);
      setVideoClips(clips);
      setSelectedClipId(null);
    } catch (err: any) {
      console.error('Undo failed:', err?.response?.data?.detail || err?.message);
      // Put snapshot back on failure
      undoStackRef.current.push(snapshot);
      redoStackRef.current.pop();
    }
  }, [currentProject, snapshotClips, setVideoClips, addSegment]);

  // Redo
  const handleRedo = useCallback(async () => {
    if (!currentProject || redoStackRef.current.length === 0) return;
    const snapshot = redoStackRef.current.pop()!;
    // Save current state to undo
    undoStackRef.current.push(snapshotClips());
    try {
      const clips = await restoreVideoClips(currentProject.id, snapshot);
      setVideoClips(clips);
      setSelectedClipId(null);
    } catch (err: any) {
      console.error('Redo failed:', err?.response?.data?.detail || err?.message);
      // Revert on failure
      redoStackRef.current.push(snapshot);
      undoStackRef.current.pop();
    }
  }, [currentProject, snapshotClips, setVideoClips]);

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
  // Ref so drag handlers always read the latest value without re-mounting listeners
  const pixelsPerSecondRef = useRef(pixelsPerSecond);
  pixelsPerSecondRef.current = pixelsPerSecond;
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

  const ZOOM_MIN = 0.0005;
  const ZOOM_MAX = 20;
  const zoomBy = useCallback((factor: number) => {
    setZoom(prev => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, +(prev * factor).toFixed(4))));
  }, []);
  const getFitZoom = useCallback(() => {
    const el = containerRef.current;
    if (!el || duration <= 0) return 1;
    const availableWidth = Math.max(100, el.clientWidth - 40);
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, +(availableWidth / (duration * 20)).toFixed(4)));
  }, [duration]);

  const isFitZoom = Math.abs(zoom - getFitZoom()) < 0.015 || zoom <= getFitZoom() * 1.05;
  const totalWidth = Math.max(
    containerRef.current?.clientWidth || 1000,
    duration * pixelsPerSecond + (isFitZoom ? 0 : 300)
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

  const toggleTrackMute = (lane: number) => {
    setMutedTracks((prev) => {
      const next = new Set(prev);
      if (next.has(lane)) next.delete(lane);
      else next.add(lane);
      return next;
    });
  };

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

  const handleSegmentMouseDown = (
    e: React.MouseEvent,
    seg: Segment,
    type: 'move' | 'resize-start' | 'resize-end'
  ) => {
    e.stopPropagation();
    e.preventDefault();
    setDragging({
      segmentId: seg.id,
      type,
      startX: e.clientX,
      originalStart: seg.start_time,
      originalEnd: seg.end_time,
    });
    setActiveSegment(seg.id);
  };

  useEffect(() => {
    if (!dragging) return;

    const snap = dragging; // stable snapshot of drag start state

    const handleMouseMove = (e: MouseEvent) => {
      if (e.buttons === 0) {
        handleMouseUp();
        return;
      }
      const pps = pixelsPerSecondRef.current || (20 * zoom) || 20;
      const dx = e.clientX - snap.startX;
      const dt = dx / pps;
      const maxAllowedDuration = Math.max(
        durationRef.current || 0,
        sourceDurationRef.current || 0,
        currentProject?.duration || 0,
        3600
      );

      // Auto-scroll timeline container when dragging near edges
      if (containerRef.current) {
        const cRect = containerRef.current.getBoundingClientRect();
        const edgeThreshold = 60;
        if (e.clientX > cRect.right - edgeThreshold) {
          containerRef.current.scrollLeft += 10;
        } else if (e.clientX < cRect.left + edgeThreshold) {
          containerRef.current.scrollLeft -= 10;
        }
      }

      let newStart = snap.originalStart;
      let newEnd = snap.originalEnd;

      if (snap.type === 'move') {
        const segDur = Math.max(0.1, snap.originalEnd - snap.originalStart);
        newStart = Math.max(0, snap.originalStart + dt);
        newEnd = newStart + segDur;
        if (newEnd > maxAllowedDuration) {
          newEnd = maxAllowedDuration;
          newStart = Math.max(0, newEnd - segDur);
        }
      } else if (snap.type === 'resize-start') {
        newStart = Math.max(0, Math.min(snap.originalStart + dt, snap.originalEnd - 0.2));
      } else if (snap.type === 'resize-end') {
        newEnd = Math.min(maxAllowedDuration, Math.max(snap.originalEnd + dt, snap.originalStart + 0.2));
      }

      // Read latest project from store to avoid stale closure over currentProject
      const project = useProjectStore.getState().currentProject;
      if (project) {
        useProjectStore.setState({
          currentProject: {
            ...project,
            segments: project.segments.map((s) =>
              s.id === snap.segmentId
                ? { ...s, start_time: newStart, end_time: newEnd }
                : s
            ),
          },
        });
      }
    };

    const handleMouseUp = async () => {
      setDragging(null);
      // Read latest positions from store after all mousemove updates
      const project = useProjectStore.getState().currentProject;
      const seg = project?.segments.find((s) => s.id === snap.segmentId);
      if (seg) {
        await updateSegment(seg.id, {
          start_time: seg.start_time,
          end_time: seg.end_time,
        });
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
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

  // Swap / Reorder clip position (e.g. Move Clip A before B, or after C)
  const handleSwapClipOrder = async (clipId: string, direction: 'left' | 'right') => {
    if (!currentProject) return;
    const sorted = [...videoClipsRef.current].sort((a, b) => a.index - b.index);
    const idx = sorted.findIndex(c => c.id === clipId);
    if (idx === -1) return;
    const targetIdx = direction === 'left' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= sorted.length) return;

    pushUndo();
    const temp = sorted[idx];
    sorted[idx] = sorted[targetIdx];
    sorted[targetIdx] = temp;

    const newClips = sorted.map((c, i) => ({ ...c, index: i }));
    setVideoClips(newClips);

    try {
      const updated = await reorderVideoClips(currentProject.id, newClips.map(c => c.id));
      setVideoClips(updated);
    } catch (err: any) {
      console.error('Failed to reorder clips:', err);
    }
  };

  // Move clip to exact target index
  const handleMoveClipToIndex = async (clipId: string, targetIdx: number) => {
    if (!currentProject) return;
    const sorted = [...videoClipsRef.current].sort((a, b) => a.index - b.index);
    const currentIdx = sorted.findIndex(c => c.id === clipId);
    if (currentIdx === -1 || targetIdx < 0 || targetIdx >= sorted.length || currentIdx === targetIdx) return;

    pushUndo();
    const [moved] = sorted.splice(currentIdx, 1);
    sorted.splice(targetIdx, 0, moved);

    const newClips = sorted.map((c, i) => ({ ...c, index: i }));
    setVideoClips(newClips);

    try {
      const updated = await reorderVideoClips(currentProject.id, newClips.map(c => c.id));
      setVideoClips(updated);
    } catch (err: any) {
      console.error('Failed to reorder clips:', err);
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
    setAudioGenerating(true);
    setAudioGenerated(false);
    try {
      const ids = selectedSegmentIds.size > 0 ? Array.from(selectedSegmentIds) : undefined;
      await generateVoiceForSegments(ids);
      setAudioGenerated(true);
      setTimeout(() => setAudioGenerated(false), 3000);
    } catch (err) {
      console.error('Generate voice failed:', err);
    } finally {
      setAudioGenerating(false);
    }
  };

  // --- Editing tool handlers ---

  const handleFlip = async (direction: 'horizontal' | 'vertical') => {
    if (!currentProject || isFlipping) return;
    setIsFlipping(true);
    try {
      await flipVideo(currentProject.id, direction);
      await loadProject(currentProject.id);
      setShowFlipPanel(false);
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
      setShowRotatePanel(false);
    } catch (err: any) {
      console.error('Rotate failed:', err);
    }
    setIsRotating(false);
  };

  const handleSpeedChange = async (speed: number) => {
    if (!currentProject || isChangingSpeed) return;
    setIsChangingSpeed(true);
    try {
      await changeVideoSpeed(currentProject.id, speed);
      await loadProject(currentProject.id);
      setShowSpeedPanel(false);
    } catch (err: any) {
      console.error('Speed change failed:', err);
    }
    setIsChangingSpeed(false);
  };

  const handleOpenBlur = () => {
    const vid = videoRef.current;
    const w = vid?.videoWidth || 1280;
    const h = vid?.videoHeight || 720;

    // Snapshot the current (paused) frame so the user has a large, precise,
    // still reference to draw against instead of the small live player.
    try {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx && vid && vid.videoWidth > 0) {
        ctx.drawImage(vid, 0, 0, w, h);
        setBlurSnapshot(canvas.toDataURL('image/jpeg', 0.85));
      }
    } catch {
      // ignore cross-origin snapshot issues
    }
    setBlurNatural({ w, h });

    // Default to a bottom subtitle box or previously selected box
    setBlurRegion((prev) =>
      prev.width > 0 && prev.height > 0
        ? prev
        : {
            x: 0,
            y: Math.round(h * 0.80),
            width: w,
            height: Math.round(h * 0.18),
          }
    );
    setShowBlurModal(true);
  };

  const handleApplyBlur = async () => {
    if (!currentProject || isBlurring) return;
    setIsBlurring(true);
    try {
      const x = Math.max(0, Math.round(blurRegion.x));
      const y = Math.max(0, Math.round(blurRegion.y));
      const width = Math.max(4, Math.round(blurRegion.width));
      const height = Math.max(4, Math.round(blurRegion.height));

      await blurVideoRegion(currentProject.id, x, y, width, height);
      await loadProject(currentProject.id);
      if (videoRef.current) {
        videoRef.current.load();
      }
      setShowBlurModal(false);
    } catch (err: any) {
      console.error('Blur failed:', err);
      alert(`Blur operation failed: ${err?.response?.data?.detail || err.message || err}`);
    } finally {
      setIsBlurring(false);
    }
  };

  // Drag/resize the blur region box — same window-listener pattern as clip resizing.
  useEffect(() => {
    if (!blurDrag) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (e.buttons === 0) {
        setBlurDrag(null);
        return;
      }
      const img = blurImgRef.current;
      if (!img) return;
      const renderedW = img.getBoundingClientRect().width;
      const scale = renderedW > 0 ? blurNatural.w / renderedW : 1;
      const dx = (e.clientX - blurDrag.startX) * scale;
      const dy = (e.clientY - blurDrag.startY) * scale;
      const { orig } = blurDrag;
      const MIN = 8;
      const maxW = blurNatural.w;
      const maxH = blurNatural.h;

      let { x, y, width, height } = orig;
      const origRight = orig.x + orig.width;
      const origBottom = orig.y + orig.height;

      if (blurDrag.mode === 'move') {
        x = Math.min(Math.max(0, orig.x + dx), maxW - orig.width);
        y = Math.min(Math.max(0, orig.y + dy), maxH - orig.height);
      } else if (blurDrag.mode === 'tl') {
        x = Math.min(Math.max(0, orig.x + dx), origRight - MIN);
        y = Math.min(Math.max(0, orig.y + dy), origBottom - MIN);
        width = origRight - x;
        height = origBottom - y;
      } else if (blurDrag.mode === 'tr') {
        const right = Math.max(Math.min(maxW, origRight + dx), orig.x + MIN);
        y = Math.min(Math.max(0, orig.y + dy), origBottom - MIN);
        x = orig.x;
        width = right - orig.x;
        height = origBottom - y;
      } else if (blurDrag.mode === 'bl') {
        x = Math.min(Math.max(0, orig.x + dx), origRight - MIN);
        const bottom = Math.max(Math.min(maxH, origBottom + dy), orig.y + MIN);
        y = orig.y;
        width = origRight - x;
        height = bottom - orig.y;
      } else if (blurDrag.mode === 'br') {
        const right = Math.max(Math.min(maxW, origRight + dx), orig.x + MIN);
        const bottom = Math.max(Math.min(maxH, origBottom + dy), orig.y + MIN);
        x = orig.x;
        y = orig.y;
        width = right - orig.x;
        height = bottom - orig.y;
      }

      setBlurRegion({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
    };

    const handleMouseUp = () => setBlurDrag(null);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [blurDrag, blurNatural]);

  const handleAddSegmentAtPlayhead = async () => {
    if (!currentProject) return;
    let sourceTime = currentTime;
    if (clipLayout.length > 0) {
      const result = timelineToSource(clipLayout, currentTime);
      if (result) sourceTime = result.sourceTime;
    }
    const segStart = sourceTime;
    const segEnd = Math.min(segStart + 3, sourceDuration);
    await addSegment({ start_time: segStart, end_time: segEnd, text: '', speaker: 'Speaker 1' });
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

  const handleStartVoiceRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const audioUrl = URL.createObjectURL(audioBlob);
        const dur = Math.max(1.0, recordingSeconds);

        await addSegment({
          start_time: currentTime,
          end_time: currentTime + dur,
          text: '🎙️ Voiceover Clip',
          speaker: 'Voiceover',
          voice_profile: 'female',
          audio_url: audioUrl,
        });
        if (currentProject?.id) await loadProject(currentProject.id);
        setIsRecordingVoice(false);
        setRecordingSeconds(0);
        stream.getTracks().forEach((t) => t.stop());
      };

      mediaRecorder.start();
      setIsRecordingVoice(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      alert('Microphone access is required for voiceover recording.');
    }
  };

  const handleStopVoiceRecording = () => {
    if (mediaRecorderRef.current && isRecordingVoice) {
      clearInterval(recordingTimerRef.current);
      mediaRecorderRef.current.stop();
    }
  };

  const handleFreezeFrame = async () => {
    if (!currentProject) return;
    const video = videoRef.current;
    let frameSnapshot = '';
    if (video) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          frameSnapshot = canvas.toDataURL('image/jpeg', 0.85);
        }
      } catch (e) {
        console.warn('Could not capture frame snapshot:', e);
      }
    }
    const freezeDur = 2.0;
    const start = currentTime;
    const end = Math.min((currentProject.duration || 60), start + freezeDur);

    await addSegment({
      start_time: start,
      end_time: end,
      text: '❄️ Freeze Frame',
      speaker: 'Freeze',
      voice_profile: 'freeze',
      audio_url: frameSnapshot,
    });
    if (currentProject?.id) await loadProject(currentProject.id);
  };

  const handleDuplicate = async () => {
    if (selectedClipId && videoClips.length > 0) {
      const clip = videoClips.find((c) => c.id === selectedClipId);
      if (clip) {
        const newClips = [...videoClips, { ...clip, id: `clip-${Date.now()}` }];
        setVideoClips(newClips);
        return;
      }
    }
    const targetSeg =
      (activeSegmentId ? segments.find((s) => s.id === activeSegmentId) : null) ||
      segments.find((s) => currentTime >= s.start_time && currentTime <= s.end_time) ||
      segments[0];
    if (targetSeg && currentProject) {
      const dur = Math.max(1.0, targetSeg.end_time - targetSeg.start_time);
      await addSegment({
        start_time: targetSeg.end_time + 0.1,
        end_time: targetSeg.end_time + 0.1 + dur,
        text: targetSeg.text,
        speaker: targetSeg.speaker,
        voice_profile: targetSeg.voice_profile,
        audio_url: targetSeg.audio_url,
      });
      await loadProject(currentProject.id);
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedClipId) {
      handleDeleteClip(selectedClipId);
      return;
    }
    const selectedIds = Array.from(selectedSegmentIds);
    if (selectedIds.length > 0) {
      await deleteMultipleSegments(selectedIds);
      if (currentProject?.id) await loadProject(currentProject.id);
      return;
    }
    const targetSegId =
      activeSegmentId ||
      segments.find((s) => currentTime >= s.start_time && currentTime <= s.end_time)?.id;
    if (targetSegId) {
      await handleDeleteSegment(targetSegId);
      if (currentProject?.id) await loadProject(currentProject.id);
      return;
    }
    if (segments.length > 0) {
      await deleteAllSegments();
      if (currentProject?.id) await loadProject(currentProject.id);
    }
  };

  const handleFitToView = useCallback(() => {
    if (!containerRef.current || duration <= 0) return;
    setZoom(getFitZoom());
    containerRef.current.scrollLeft = 0;
  }, [duration, getFitZoom]);

  // Long videos start fully visible instead of 20,000px wide
  const autoFitDoneRef = useRef(false);
  useEffect(() => {
    if (autoFitDoneRef.current || duration <= 0 || !containerRef.current) return;
    autoFitDoneRef.current = true;
    const fit = getFitZoom();
    if (fit < zoom) {
      setZoom(fit);
      containerRef.current.scrollLeft = 0;
    }
  }, [duration, getFitZoom, zoom]);

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
        const scrollLeft = el.scrollLeft;
        const pointerTime = (pointerX + scrollLeft) / (20 * zoom);
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newZoom = Math.max(0.05, Math.min(20, +(zoom * factor).toFixed(3)));
        setZoom(newZoom);
        requestAnimationFrame(() => {
          el.scrollLeft = pointerTime * (20 * newZoom) - pointerX;
        });
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
  }, [zoom]);

  // Close flip/rotate/speed/zoom panels on outside click
  useEffect(() => {
    if (!showFlipPanel && !showRotatePanel && !showSpeedPanel && !showZoomDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (showFlipPanel && flipPanelRef.current && !flipPanelRef.current.contains(e.target as Node)) setShowFlipPanel(false);
      if (showRotatePanel && rotatePanelRef.current && !rotatePanelRef.current.contains(e.target as Node)) setShowRotatePanel(false);
      if (showSpeedPanel && speedPanelRef.current && !speedPanelRef.current.contains(e.target as Node)) setShowSpeedPanel(false);
      if (showZoomDropdown && zoomDropdownRef.current && !zoomDropdownRef.current.contains(e.target as Node)) setShowZoomDropdown(false);
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
    }, 10);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [showFlipPanel, showRotatePanel, showSpeedPanel, showZoomDropdown]);

  // Time markers calculation — spans the full scrollable width of the timeline
  const targetPxBetweenMarkers = 85;
  const rawSeconds = targetPxBetweenMarkers / Math.max(pixelsPerSecond, 0.1);
  const standardSteps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const markerInterval = standardSteps.find((s) => s >= rawSeconds) || 60;

  const maxRulerTime = Math.max(duration * 1.5, totalWidth / Math.max(pixelsPerSecond, 0.1) + 60);
  const markers: number[] = [];
  for (let t = 0; t <= maxRulerTime; t += markerInterval) {
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

  const TRACK_HEIGHT = 52;
  const VIDEO_TRACK_HEIGHT = 72;
  const TRACK_LABEL_W = 80;

  const toggleLock = (t: string) => {
    setLockedTracks(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; });
  };
  const toggleHidden = (t: string) => {
    toggleTrackVisibility(t);
  };

  const [magnetEnabled, setMagnetEnabled] = useState(true);
  const [rippleEnabled, setRippleEnabled] = useState(false);
  const minimapRef = useRef<HTMLDivElement>(null);
  const [viewportScrollLeft, setViewportScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(800);
  const [hoverRulerTime, setHoverRulerTime] = useState<number | null>(null);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [isSanitizingTimeline, setIsSanitizingTimeline] = useState(false);

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

  // Sanitize timeline overlaps
  const handleSanitizeTimeline = useCallback(async () => {
    if (!currentProject?.id) return;
    setIsSanitizingTimeline(true);
    try {
      await sanitizeProjectTimeline(currentProject.id);
      await loadProject(currentProject.id);
    } catch (err) {
      console.error('Failed to sanitize timeline:', err);
    } finally {
      setIsSanitizingTimeline(false);
    }
  }, [currentProject?.id, loadProject]);

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
        if (!e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          handleFitToView();
        }
      } else if (e.key === '[' || (e.altKey && e.key === 'ArrowLeft')) {
        e.preventDefault();
        handleJumpPrevCut();
      } else if (e.key === ']' || (e.altKey && e.key === 'ArrowRight')) {
        e.preventDefault();
        handleJumpNextCut();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleStepFrame, handleSplitAtPlayhead, handleToggleBookmark, handleFitToView, handleJumpPrevCut, handleJumpNextCut, duration, setCurrentTime, videoRef]);

  const formatFrameTime = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const f = Math.floor((sec % 1) * 30);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${f.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col h-full bg-[#121316] text-[#e1e3e6] select-none font-sans">
      {/* Meatika Timeline Toolbar */}
      <div className="h-10 border-b border-[#1c1e24] bg-[#121316] px-3 flex items-center justify-between shrink-0 gap-2 relative z-30 overflow-visible">
        {/* Left Action Tools */}
        <div className="flex items-center gap-1 text-zinc-400 shrink-0">
          {/* Undo */}
          <button
            onClick={handleUndo}
            disabled={undoStackRef.current.length === 0}
            className="p-1.5 rounded-lg hover:bg-[#1e2025] hover:text-white transition-colors disabled:opacity-30"
            title="Undo (Ctrl+Z)"
          >
            <Undo2 className="w-4 h-4" />
          </button>

          {/* Redo */}
          <button
            onClick={handleRedo}
            disabled={redoStackRef.current.length === 0}
            className="p-1.5 rounded-lg hover:bg-[#1e2025] hover:text-white transition-colors disabled:opacity-30"
            title="Redo (Ctrl+Shift+Z)"
          >
            <Redo2 className="w-4 h-4" />
          </button>

          <div className="w-px h-4 bg-[#24272f] mx-1" />

          {/* Split */}
          <button
            onClick={handleSplitAtPlayhead}
            disabled={!currentProject?.video_path || splitProcessing}
            className="p-1.5 rounded-lg hover:bg-[#1e2025] hover:text-white transition-colors disabled:opacity-30"
            title="Split at playhead (S / C)"
          >
            {splitProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scissors className="w-4 h-4" />}
          </button>

          {/* Crop */}
          <button
            onClick={handleOpenCrop}
            className="p-1.5 rounded-lg hover:bg-[#1e2025] hover:text-white transition-colors"
            title="Crop / Transform Video"
          >
            <Crop className="w-4 h-4" />
          </button>

          {/* Blur Watermark / Region */}
          <button
            onClick={handleOpenBlur}
            className="p-1.5 rounded-lg hover:bg-[#1e2025] hover:text-white transition-colors"
            title="Blur Logo / Watermark"
          >
            <Eraser className="w-4 h-4" />
          </button>

          {/* Duplicate */}
          <button
            onClick={handleDuplicate}
            className="p-1.5 rounded-lg hover:bg-[#1e2025] hover:text-white transition-colors"
            title="Duplicate Selected Clip / Segment (Ctrl+D)"
          >
            <Copy className="w-4 h-4" />
          </button>

          {/* Freeze Frame */}
          <button
            onClick={handleFreezeFrame}
            className="p-1.5 rounded-lg hover:bg-[#1e2025] hover:text-white transition-colors"
            title="Freeze Frame at Playhead"
          >
            <Snowflake className="w-4 h-4" />
          </button>

          {/* Delete */}
          <button
            onClick={handleDeleteSelected}
            className="p-1.5 rounded-lg hover:bg-[#1e2025] text-red-400 hover:text-red-300 transition-colors"
            title="Delete Selected (Delete / Backspace)"
          >
            <Trash2 className="w-4 h-4" />
          </button>

          {/* Add Bookmark / Marker */}
          <button
            onClick={handleToggleBookmark}
            className={`p-1.5 rounded-lg transition-colors ${
              bookmarks.some(b => Math.abs(b - currentTime) < 0.2)
                ? 'bg-purple-600/30 text-purple-300 border border-purple-500/40'
                : 'hover:bg-[#1e2025] hover:text-white'
            }`}
            title="Add / Remove Bookmark at Playhead (M)"
          >
            <Bookmark className="w-4 h-4" />
          </button>

          {/* Speed Curve / Speed Panel */}
          <div className="relative">
            <button
              onClick={() => {
                setShowSpeedPanel(!showSpeedPanel);
                setShowRotatePanel(false);
                setShowFlipPanel(false);
                setShowZoomDropdown(false);
              }}
              className={`p-1.5 rounded-lg transition-colors ${
                showSpeedPanel ? 'bg-blue-600 text-white' : 'hover:bg-[#1e2025] hover:text-white'
              }`}
              title="Change Video Speed"
            >
              <TrendingUp className="w-4 h-4" />
            </button>

            {showSpeedPanel && (
              <div
                ref={speedPanelRef}
                className="absolute top-full left-0 mt-1.5 bg-[#1e2025] border border-[#31353e] rounded-xl shadow-2xl p-2 z-50 w-44 space-y-1 animate-in fade-in"
              >
                <div className="text-[10px] text-zinc-400 font-bold px-2 py-1 uppercase tracking-wider">Video Speed</div>
                {[0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map((s) => (
                  <button
                    key={s}
                    onClick={() => handleSpeedChange(s)}
                    className="w-full px-2.5 py-1.5 text-left text-xs font-mono rounded-lg hover:bg-[#282c34] flex items-center justify-between text-zinc-200 transition-colors"
                  >
                    <span>{s}x</span>
                    {isChangingSpeed && <Loader2 className="w-3 h-3 animate-spin text-blue-400" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Rotate Video */}
          <div className="relative">
            <button
              onClick={() => {
                setShowRotatePanel(!showRotatePanel);
                setShowSpeedPanel(false);
                setShowFlipPanel(false);
                setShowZoomDropdown(false);
              }}
              className={`p-1.5 rounded-lg transition-colors ${
                showRotatePanel ? 'bg-blue-600 text-white' : 'hover:bg-[#1e2025] hover:text-white'
              }`}
              title="Rotate Video"
            >
              <RotateCw className="w-4 h-4" />
            </button>

            {showRotatePanel && (
              <div
                ref={rotatePanelRef}
                className="absolute top-full left-0 mt-1.5 bg-[#1e2025] border border-[#31353e] rounded-xl shadow-2xl p-2 z-50 w-44 space-y-1 animate-in fade-in"
              >
                <div className="text-[10px] text-zinc-400 font-bold px-2 py-1 uppercase tracking-wider">Rotate</div>
                <button
                  onClick={() => handleRotate(90)}
                  disabled={isRotating}
                  className="w-full px-2.5 py-1.5 text-left text-xs font-mono rounded-lg hover:bg-[#282c34] flex items-center justify-between text-zinc-200 transition-colors"
                >
                  <span>90° Clockwise</span>
                  {isRotating && <Loader2 className="w-3 h-3 animate-spin text-blue-400" />}
                </button>
                <button
                  onClick={() => handleRotate(270)}
                  disabled={isRotating}
                  className="w-full px-2.5 py-1.5 text-left text-xs font-mono rounded-lg hover:bg-[#282c34] flex items-center justify-between text-zinc-200 transition-colors"
                >
                  <span>90° Counter-CW</span>
                  {isRotating && <Loader2 className="w-3 h-3 animate-spin text-blue-400" />}
                </button>
                <button
                  onClick={() => handleRotate(180)}
                  disabled={isRotating}
                  className="w-full px-2.5 py-1.5 text-left text-xs font-mono rounded-lg hover:bg-[#282c34] flex items-center justify-between text-zinc-200 transition-colors"
                >
                  <span>180° Flip</span>
                  {isRotating && <Loader2 className="w-3 h-3 animate-spin text-blue-400" />}
                </button>
              </div>
            )}
          </div>

          {/* Flip Video */}
          <div className="relative">
            <button
              onClick={() => {
                setShowFlipPanel(!showFlipPanel);
                setShowSpeedPanel(false);
                setShowRotatePanel(false);
                setShowZoomDropdown(false);
              }}
              className={`p-1.5 rounded-lg transition-colors ${
                showFlipPanel ? 'bg-blue-600 text-white' : 'hover:bg-[#1e2025] hover:text-white'
              }`}
              title="Flip Video"
            >
              <FlipHorizontal className="w-4 h-4" />
            </button>

            {showFlipPanel && (
              <div
                ref={flipPanelRef}
                className="absolute top-full left-0 mt-1.5 bg-[#1e2025] border border-[#31353e] rounded-xl shadow-2xl p-2 z-50 w-44 space-y-1 animate-in fade-in"
              >
                <div className="text-[10px] text-zinc-400 font-bold px-2 py-1 uppercase tracking-wider">Flip Mirror</div>
                <button
                  onClick={() => handleFlip('horizontal')}
                  disabled={isFlipping}
                  className="w-full px-2.5 py-1.5 text-left text-xs font-mono rounded-lg hover:bg-[#282c34] flex items-center justify-between text-zinc-200 transition-colors"
                >
                  <span>Flip Horizontal</span>
                  {isFlipping && <Loader2 className="w-3 h-3 animate-spin text-blue-400" />}
                </button>
                <button
                  onClick={() => handleFlip('vertical')}
                  disabled={isFlipping}
                  className="w-full px-2.5 py-1.5 text-left text-xs font-mono rounded-lg hover:bg-[#282c34] flex items-center justify-between text-zinc-200 transition-colors"
                >
                  <span>Flip Vertical</span>
                  {isFlipping && <Loader2 className="w-3 h-3 animate-spin text-blue-400" />}
                </button>
              </div>
            )}
          </div>

          {/* Voiceover Live Recording */}
          <div className="flex items-center">
            {isRecordingVoice ? (
              <button
                onClick={handleStopVoiceRecording}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-mono transition-all animate-pulse"
                title="Stop Recording Voiceover"
              >
                <span className="w-2 h-2 rounded-full bg-white animate-ping" />
                <span>REC {recordingSeconds}s</span>
              </button>
            ) : (
              <button
                onClick={handleStartVoiceRecording}
                className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-[#1e2025] text-zinc-400 hover:text-white text-xs transition-colors"
                title="Record Voiceover at Playhead"
              >
                <Mic className="w-3.5 h-3.5 text-rose-400" />
                <span>Record</span>
              </button>
            )}
          </div>

          {/* Isolate Vocals & BGM (AI Demucs) */}
          <button
            onClick={handleSeparateAudioClick}
            disabled={isSeparatingAudio}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
              audioSeparated
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30'
                : 'bg-[#181a1f] border border-[#26282e] hover:border-amber-500/40 text-zinc-300 hover:text-white'
            }`}
            title={
              audioSeparated
                ? 'Audio separated into Vocals & BGM tracks — Click to remove'
                : 'Isolate video background music from vocals with AI Demucs'
            }
          >
            {isSeparatingAudio ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-400" />
                <span className="text-[11px] text-purple-300">Isolating BGM...</span>
              </>
            ) : audioSeparated ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-[11px]">BGM Isolated</span>
              </>
            ) : (
              <>
                <Music className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-[11px]">Isolate BGM</span>
              </>
            )}
          </button>
        </div>

        {/* Center Transport & Frame Navigation */}
        <div className="flex items-center gap-1 bg-[#181a1f] px-2 py-0.5 rounded-xl border border-[#24272f] shrink-0">
          <button
            onClick={handleJumpPrevCut}
            className="p-1 rounded hover:bg-[#282c34] text-zinc-400 hover:text-white transition-colors"
            title="Jump to Previous Cut Point ([)"
          >
            <SkipBack className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => handleStepFrame(-1)}
            className="p-1 rounded hover:bg-[#282c34] text-zinc-400 hover:text-white transition-colors"
            title="Step 1 Frame Backward (←)"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => {
              if (videoRef.current) {
                if (videoRef.current.paused) videoRef.current.play();
                else videoRef.current.pause();
              }
            }}
            className="p-1 px-1.5 rounded-lg bg-pink-600/30 hover:bg-pink-600/50 text-pink-300 hover:text-white border border-pink-500/30 transition-colors"
            title="Play / Pause (Space)"
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current" />}
          </button>
          <button
            onClick={() => handleStepFrame(1)}
            className="p-1 rounded hover:bg-[#282c34] text-zinc-400 hover:text-white transition-colors"
            title="Step 1 Frame Forward (→)"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleJumpNextCut}
            className="p-1 rounded hover:bg-[#282c34] text-zinc-400 hover:text-white transition-colors"
            title="Jump to Next Cut Point (])"
          >
            <SkipForward className="w-3.5 h-3.5" />
          </button>

          <div className="w-px h-3.5 bg-zinc-700/50 mx-1" />

          {/* Frame-accurate Timecode */}
          <div className="font-mono text-xs font-semibold text-zinc-200 tracking-wider px-1">
            <span className="text-pink-300 font-bold">{formatFrameTime(currentTime)}</span>
            <span className="text-zinc-600 mx-1">/</span>
            <span className="text-zinc-500">{formatFrameTime(duration)}</span>
          </div>
        </div>

        {/* Right Controls */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Fit to View Button */}
          <button
            onClick={handleFitToView}
            className="p-1.5 rounded-lg bg-[#181a1f] hover:bg-[#242730] text-zinc-400 hover:text-white border border-[#24272f] hover:border-zinc-600 transition-colors"
            title="Zoom to Fit Full Timeline (Z)"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>

          {/* Shortcuts Button */}
          <button
            onClick={() => setShowShortcutsModal(true)}
            className="p-1.5 rounded-lg bg-[#181a1f] hover:bg-[#242730] text-zinc-400 hover:text-white border border-[#24272f] transition-colors"
            title="Keyboard Shortcuts Cheatsheet"
          >
            <Keyboard className="w-3.5 h-3.5" />
          </button>

          {/* Timeline Track Zoom dropdown */}
          <div className="relative" ref={zoomDropdownRef}>
            <button
              onClick={() => setShowZoomDropdown(!showZoomDropdown)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#181a1f] border border-[#26282e] hover:border-[#3a3e49] text-xs font-mono text-zinc-300 hover:text-white transition-colors"
              title="Timeline Track Zoom"
            >
              <span>
                {Math.abs(zoom - getFitZoom()) < 0.015 || zoom <= getFitZoom() * 1.05
                  ? 'Fit'
                  : `${Math.round(zoom * 100)}%`}
              </span>
              <ChevronDown className="w-3 h-3 text-zinc-500" />
            </button>

            {showZoomDropdown && (
              <div className="absolute top-full right-0 mt-1.5 w-36 bg-[#1e2025] border border-[#31353e] rounded-xl shadow-2xl py-1 z-50 animate-in fade-in">
                {[
                  { label: 'Fit to View', value: 'fit' },
                  { label: '25%', value: 0.25 },
                  { label: '50%', value: 0.5 },
                  { label: '75%', value: 0.75 },
                  { label: '100% (1x)', value: 1.0 },
                  { label: '150%', value: 1.5 },
                  { label: '200% (2x)', value: 2.0 },
                  { label: '300% (3x)', value: 3.0 },
                ].map((item) => {
                  const isCurrent =
                    item.value === 'fit'
                      ? Math.abs(zoom - getFitZoom()) < 0.015 || zoom <= getFitZoom() * 1.05
                      : Math.abs(zoom - (item.value as number)) < 0.02;
                  return (
                    <button
                      key={item.label}
                      onClick={() => {
                        if (item.value === 'fit') {
                          handleFitToView();
                        } else {
                          setZoom(item.value as number);
                        }
                        setShowZoomDropdown(false);
                      }}
                      className={`w-full px-3 py-1.5 text-left text-xs font-mono hover:bg-[#282c34] flex items-center justify-between transition-colors ${
                        isCurrent ? 'text-pink-400 font-bold bg-[#282c34]' : 'text-zinc-300'
                      }`}
                    >
                      <span>{item.label}</span>
                      {isCurrent && <span className="w-1.5 h-1.5 rounded-full bg-pink-400" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Magnet Button Badge */}
          <button
            onClick={() => setMagnetEnabled(!magnetEnabled)}
            className={`p-1.5 rounded-lg transition-colors ${
              magnetEnabled ? 'bg-blue-600 text-white shadow-sm' : 'bg-[#181a1f] text-zinc-400 hover:text-white'
            }`}
            title="Snapping"
          >
            <Magnet className="w-3.5 h-3.5" />
          </button>

          {/* Ripple Button */}
          <button
            onClick={() => setRippleEnabled(!rippleEnabled)}
            className={`p-1.5 rounded-lg transition-colors ${
              rippleEnabled ? 'bg-blue-600 text-white shadow-sm' : 'bg-[#181a1f] text-zinc-400 hover:text-white'
            }`}
            title="Ripple Edit"
          >
            <MoveHorizontal className="w-3.5 h-3.5" />
          </button>

          {/* Timeline Zoom Slider */}
          <div className="flex items-center gap-1.5 pl-1">
            <button
              onClick={() => zoomBy(1 / 1.3)}
              className="p-1 rounded hover:bg-[#1e2025] text-zinc-400 hover:text-white transition-colors"
              title="Zoom Out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>

            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={Math.log(zoom / 0.05) / Math.log(20 / 0.05)}
              onChange={(e) => setZoom(+((0.05 * Math.pow(20 / 0.05, parseFloat(e.target.value))).toFixed(3)))}
              className="w-16 h-1 accent-white bg-[#26282e] rounded-lg cursor-pointer"
            />

            <button
              onClick={() => zoomBy(1.3)}
              className="p-1 rounded hover:bg-[#1e2025] text-zinc-400 hover:text-white transition-colors"
              title="Zoom In"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* ──── Mini Timeline Navigator (Minimap) ──── */}
      {duration > 0 && (
        <div
          ref={minimapRef}
          onMouseDown={handleMinimapMouseDown}
          className="h-3 bg-[#0c0d10] border-b border-[#1c1e24] relative cursor-pointer group/minimap overflow-hidden shrink-0 select-none"
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

          {/* Subtitles Representation */}
          <div className="absolute inset-0 flex items-center opacity-70 pointer-events-none">
            {segments.map((s, i) => (
              <div
                key={`mini-seg-${s.id || i}`}
                className="absolute h-1 bg-pink-400/80 rounded-xs"
                style={{
                  left: `${(s.start_time / duration) * 100}%`,
                  width: `${Math.max(0.2, ((s.end_time - s.start_time) / duration) * 100)}%`,
                }}
              />
            ))}
          </div>

          {/* Bookmarks */}
          {bookmarks.map((bm, i) => (
            <div
              key={`mini-bm-${i}`}
              className="absolute top-0 bottom-0 w-0.5 bg-purple-400 pointer-events-none z-10"
              style={{ left: `${(bm / duration) * 100}%` }}
            />
          ))}

          {/* Current Playhead indicator */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-pink-500 z-20 shadow-[0_0_6px_rgba(236,72,153,0.9)]"
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
        {/* Track labels */}
        <div
          ref={trackLabelsRef}
          className="shrink-0 border-r border-[#1c1e24] overflow-hidden bg-[#121316] select-none"
          style={{ width: 140 }}
          onWheel={(e) => {
            if (containerRef.current) {
              containerRef.current.scrollTop += e.deltaY;
            }
          }}
        >
          {/* Time ruler spacer */}
          <div className="h-7 border-b border-[#1c1e24]" />

          {/* V1 — Video Track */}
          <div
            className="flex items-center justify-between px-2.5 border-b border-[#1c1e24] group relative"
            style={{ height: VIDEO_TRACK_HEIGHT }}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-bold text-zinc-200">V1</span>
              {/* Nudge / Toggle V1 Track Forward / Backward */}
              <div className="flex items-center bg-[#181a1f] rounded border border-zinc-700/40 p-0.5 ml-0.5">
                <button
                  onClick={() => handleNudgeV1Track(-0.5)}
                  className="p-0.5 hover:bg-zinc-700/60 rounded text-zinc-400 hover:text-white transition-colors"
                  title="Nudge Video Backward (-0.5s)"
                >
                  <ChevronLeft className="w-2.5 h-2.5" />
                </button>
                <button
                  onClick={() => handleNudgeV1Track(0.5)}
                  className="p-0.5 hover:bg-zinc-700/60 rounded text-zinc-400 hover:text-white transition-colors"
                  title="Nudge Video Forward (+0.5s)"
                >
                  <ChevronRight className="w-2.5 h-2.5" />
                </button>
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-zinc-400">
              <button
                onClick={() => setA2Muted(!a2Muted)}
                className="hover:text-white transition-colors"
                title="Mute video audio"
              >
                {a2Muted ? <VolumeX className="w-3 h-3 text-red-400" /> : <Volume2 className="w-3 h-3" />}
              </button>
              <button
                onClick={() => toggleHidden('V1')}
                className="hover:text-white transition-colors"
                title={hiddenTracks.has('V1') || hiddenTracks.has('V') || !videoVisible ? 'Show video track' : 'Hide video track'}
              >
                {hiddenTracks.has('V1') || hiddenTracks.has('V') || !videoVisible ? <EyeOff className="w-3 h-3 text-red-400" /> : <Eye className="w-3 h-3" />}
              </button>
            </div>
          </div>

          {/* T tracks / V2 */}
          {Array.from({ length: laneCount }, (_, i) => {
            const laneKey = `T${i + 1}`;
            const isHidden = hiddenTracks.has(laneKey) || hiddenTracks.has('T') || !subtitlesVisible;
            return (
              <div
                key={`t-label-${i}`}
                className="flex items-center justify-between px-2.5 border-b border-[#1c1e24] group"
                style={{ height: TRACK_HEIGHT }}
              >
                <span className="text-[11px] font-bold text-zinc-300">T{i + 1}</span>
                <div className="flex items-center gap-1.5 text-zinc-400">
                  <button
                    onClick={() => toggleHidden(laneKey)}
                    className="hover:text-white transition-colors"
                    title={isHidden ? 'Show track subtitles' : 'Hide track subtitles'}
                  >
                    {isHidden ? <EyeOff className="w-3 h-3 text-red-400" /> : <Eye className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            );
          })}

          {/* A1 — AI Audio */}
          {aiTrackProfiles.map((profile, idx) => {
            const isMuted = aiMutedProfiles.has(profile);
            const aKey = `A${idx + 1}`;
            const isAHidden = hiddenTracks.has(aKey) || hiddenTracks.has('A');
            return (
              <div
                key={`ai-label-${profile}`}
                className="flex items-center justify-between px-2.5 border-b border-[#1c1e24] group"
                style={{ height: TRACK_HEIGHT }}
              >
                <span className="text-[11px] font-bold text-purple-300">A{idx + 1}</span>
                <div className="flex items-center gap-1.5 text-zinc-400">
                  <button
                    onClick={() => toggleAiTrackMute(profile)}
                    className="hover:text-white transition-colors"
                    title="Mute AI voice"
                  >
                    {isMuted ? <VolumeX className="w-3 h-3 text-red-400" /> : <Volume2 className="w-3 h-3" />}
                  </button>
                  <button
                    onClick={() => toggleHidden(aKey)}
                    className="hover:text-white transition-colors"
                    title={isAHidden ? 'Show track' : 'Hide track'}
                  >
                    {isAHidden ? <EyeOff className="w-3 h-3 text-red-400" /> : <Eye className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            );
          })}

          {/* Isolated Vocals Track */}
          {audioSeparated && (
            <div
              className="flex items-center justify-between px-2 border-b border-[#1c1e24] bg-blue-950/20 group"
              style={{ height: TRACK_HEIGHT }}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <Mic className="w-3 h-3 text-blue-400 shrink-0" />
                <span className="text-[11px] font-bold text-blue-300 truncate">Vocals</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="flex items-center gap-1 bg-[#101116] px-1.5 py-0.5 rounded-lg border border-blue-500/20" title={`Vocals Volume: ${Math.round(vocalsVolume * 100)}%`}>
                  <button
                    onClick={() => setV1Muted(!v1Muted)}
                    className="p-0.5 rounded hover:bg-blue-900/50 text-zinc-400 hover:text-white transition-colors"
                    title={v1Muted ? 'Unmute Isolated Vocals' : 'Mute Isolated Vocals'}
                  >
                    {v1Muted || vocalsVolume === 0 ? (
                      <VolumeX className="w-3 h-3 text-red-400" />
                    ) : vocalsVolume < 0.5 ? (
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
                    value={v1Muted ? 0 : vocalsVolume}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setVocalsVolume(v);
                      if (v1Muted && v > 0) setV1Muted(false);
                    }}
                    className="w-12 h-1 bg-zinc-700 accent-blue-400 rounded-lg cursor-pointer"
                    title={`Vocals Volume: ${Math.round(vocalsVolume * 100)}%`}
                  />
                  <span className="text-[9px] font-mono text-blue-300/90 w-6 text-right select-none">
                    {v1Muted ? '0%' : `${Math.round(vocalsVolume * 100)}%`}
                  </span>
                </div>
                <button
                  onClick={() => { if (confirm('Remove isolated vocals & BGM?')) onRemoveAudioSeparation?.(); }}
                  className="p-1 rounded hover:bg-red-900/40 text-zinc-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                  title="Remove isolated audio"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          )}

          {/* Isolated BGM Track */}
          {audioSeparated && (
            <div
              className="flex items-center justify-between px-2 border-b border-[#1c1e24] bg-amber-950/20 group"
              style={{ height: TRACK_HEIGHT }}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <Music className="w-3 h-3 text-amber-400 shrink-0" />
                <span className="text-[11px] font-bold text-amber-300 truncate">BGM</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="flex items-center gap-1 bg-[#101116] px-1.5 py-0.5 rounded-lg border border-amber-500/20" title={`BGM Volume: ${Math.round(bgmVolume * 100)}%`}>
                  <button
                    onClick={() => setB1Muted(!b1Muted)}
                    className="p-0.5 rounded hover:bg-amber-900/50 text-zinc-400 hover:text-white transition-colors"
                    title={b1Muted ? 'Unmute Isolated BGM' : 'Mute Isolated BGM'}
                  >
                    {b1Muted || bgmVolume === 0 ? (
                      <VolumeX className="w-3 h-3 text-red-400" />
                    ) : bgmVolume < 0.5 ? (
                      <Volume1 className="w-3 h-3 text-amber-400" />
                    ) : (
                      <Volume2 className="w-3 h-3 text-amber-400" />
                    )}
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={b1Muted ? 0 : bgmVolume}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setBgmVolume(v);
                      if (b1Muted && v > 0) setB1Muted(false);
                    }}
                    className="w-12 h-1 bg-zinc-700 accent-amber-400 rounded-lg cursor-pointer"
                    title={`BGM Volume: ${Math.round(bgmVolume * 100)}%`}
                  />
                  <span className="text-[9px] font-mono text-amber-300/90 w-6 text-right select-none">
                    {b1Muted ? '0%' : `${Math.round(bgmVolume * 100)}%`}
                  </span>
                </div>
                <button
                  onClick={() => { if (confirm('Remove isolated vocals & BGM?')) onRemoveAudioSeparation?.(); }}
                  className="p-1 rounded hover:bg-red-900/40 text-zinc-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                  title="Remove isolated audio"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          )}

        </div>

        {/* Scrollable timeline */}
        <div
          ref={containerRef}
          className={`flex-1 overflow-auto relative select-none transition-colors ${
            isTimelineDragging ? 'bg-teal-950/20 ring-2 ring-inset ring-teal-500/50' : ''
          }`}
          onClick={handleTimelineClick}
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
          {/* Drag & Drop Overlay Indicator */}
          {isTimelineDragging && (
            <div className="sticky left-0 top-0 w-full h-full min-h-[220px] z-50 pointer-events-none bg-teal-950/80 backdrop-blur-sm border-2 border-dashed border-teal-400 flex flex-col items-center justify-center gap-2 text-teal-200 animate-in fade-in">
              <Upload className="w-9 h-9 text-teal-300 animate-bounce" />
              <span className="text-sm font-bold text-white tracking-wide shadow-sm">
                Drop video file to add to timeline
              </span>
              <span className="text-xs text-teal-300/80 font-mono">
                Supports MP4, MOV, WebM, MKV, AVI, TS
              </span>
            </div>
          )}

          <div className="relative" style={{ width: totalWidth, minHeight: '100%' }}>
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
                  <div className="w-2.5 h-3 bg-purple-500 rounded-b-sm shadow-md flex items-center justify-center text-[7px] text-white -translate-x-1/2 hover:scale-125 transition-transform">
                    ★
                  </div>
                  <div className="w-px h-full bg-purple-500/50" />
                </div>
              ))}

              {/* Hover Ghost Needle & Time Pill */}
              {hoverRulerTime !== null && (
                <div
                  className="absolute top-0 bottom-0 pointer-events-none z-25"
                  style={{ left: timeToX(hoverRulerTime) }}
                >
                  <div className="w-px h-full bg-cyan-400/70" />
                  <div className="absolute top-0.5 -translate-x-1/2 bg-[#0c131a] text-cyan-300 border border-cyan-500/60 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded shadow-lg whitespace-nowrap">
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

                  // Calculate which thumbnails belong to this clip (use source time for indexing)
                  const thumbsPerClip = thumbnails.length > 0
                    ? thumbnails.slice(
                        Math.floor((clip.source_start / sourceDuration) * thumbnails.length),
                        Math.ceil((clip.source_end / sourceDuration) * thumbnails.length)
                      )
                    : [];

                  // Show resize handles if clip is trimmed or there are multiple clips
                  const canResize = !lockedTracks.has('V') && (videoClips.length > 1 || clip.source_start > 0 || clip.source_end < sourceDuration);

                  return (
                    <div
                      key={clip.id}
                      className={`absolute top-2 rounded-md cursor-grab active:cursor-grabbing transition-all group select-none ${
                        clipDragging?.clipId === clip.id
                          ? 'z-40 shadow-2xl scale-[1.02] ring-2 ring-teal-300 border-teal-300 pointer-events-none'
                          : isSelected
                          ? 'ring-2 ring-teal-400 ring-offset-1 ring-offset-[#1a1b26] z-20'
                          : 'z-10'
                      }`}
                      style={{
                        left,
                        width,
                        height: VIDEO_TRACK_HEIGHT - 16,
                        border: `2px solid ${isSelected || clipDragging?.clipId === clip.id ? '#2dd4bf' : '#0d9488'}`,
                        background: 'var(--bg-base)',
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
                          className="absolute top-0 w-3 h-full cursor-col-resize z-20 hover:bg-teal-400/30 transition-colors"
                          style={{ left: -4 }}
                          onMouseDown={(e) => handleClipResizeDown(e, clip, 'resize-start')}
                        >
                          <div className="absolute top-1/2 left-1 -translate-y-1/2 w-0.5 h-5 bg-teal-400/60 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      )}

                      {/* Right resize handle */}
                      {canResize && (
                        <div
                          className="absolute top-0 w-3 h-full cursor-col-resize z-20 hover:bg-teal-400/30 transition-colors"
                          style={{ right: -4 }}
                          onMouseDown={(e) => handleClipResizeDown(e, clip, 'resize-end')}
                        >
                          <div className="absolute top-1/2 right-1 -translate-y-1/2 w-0.5 h-5 bg-teal-400/60 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      )}

                      {/* One clean Thumbnail card + Sleek Clip Bar */}
                      <div className="relative flex items-center h-full w-full overflow-hidden rounded-md bg-[#131b24] border border-teal-900/50">
                        {thumbsPerClip.length > 0 ? (
                          <div className="relative h-full aspect-video shrink-0 bg-black/40 overflow-hidden border-r border-teal-500/30">
                            <img
                              src={thumbsPerClip[0]}
                              alt=""
                              className="w-full h-full object-cover"
                              draggable={false}
                            />
                            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-[#131b24]/80 pointer-events-none" />
                          </div>
                        ) : (
                          <div className="h-full aspect-video shrink-0 bg-teal-950/60 flex items-center justify-center border-r border-teal-500/30">
                            <Film className="w-4 h-4 text-teal-400/50" />
                          </div>
                        )}

                        {/* Clip Information & Status */}
                        <div className="flex-1 min-w-0 px-2.5 flex items-center justify-between gap-2 pointer-events-none">
                          <div className="flex items-center gap-1.5 truncate">
                            <span className="px-1.5 py-0.5 rounded bg-teal-950 border border-teal-400/40 text-[9px] font-black text-teal-300 uppercase tracking-wider shrink-0 shadow-sm">
                              Clip {String.fromCharCode(65 + (clip.index ?? 0))}
                            </span>
                            <span className="text-[11px] font-semibold text-zinc-200 truncate tracking-tight">
                              {currentProject?.video_filename || 'Video'}
                            </span>
                          </div>
                          <span className="text-[10px] text-teal-300/80 font-mono font-bold shrink-0 bg-black/40 px-1.5 py-0.5 rounded border border-white/5">
                            {fmtTime(clipDuration)}
                          </span>
                        </div>
                      </div>

                      {/* Bottom highlight bar */}
                      <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-gradient-to-r from-teal-500/40 via-teal-400/20 to-transparent pointer-events-none" />

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
                  className="absolute top-2 rounded-md overflow-hidden"
                  style={{
                    left: 0,
                    width: timeToX(duration),
                    height: VIDEO_TRACK_HEIGHT - 16,
                    border: '2px solid #0d9488',
                    background: 'var(--bg-base)',
                  }}
                >
                  <div className="relative flex items-center h-full w-full overflow-hidden rounded-md bg-[#131b24] border border-teal-900/50">
                    {thumbnails.length > 0 ? (
                      <div className="relative h-full aspect-video shrink-0 bg-black/40 overflow-hidden border-r border-teal-500/30">
                        <img
                          src={thumbnails[0]}
                          alt=""
                          className="w-full h-full object-cover"
                          draggable={false}
                        />
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-[#131b24]/80 pointer-events-none" />
                      </div>
                    ) : (
                      <div className="h-full aspect-video shrink-0 bg-teal-950/60 flex items-center justify-center border-r border-teal-500/30">
                        <Film className="w-4 h-4 text-teal-400/50" />
                      </div>
                    )}

                    <div className="flex-1 min-w-0 px-2.5 flex items-center justify-between gap-2 pointer-events-none">
                      <div className="flex items-center gap-1.5 truncate">
                        <span className="px-1.5 py-0.5 rounded bg-teal-950 border border-teal-400/40 text-[9px] font-black text-teal-300 uppercase tracking-wider shrink-0 shadow-sm">
                          Clip A
                        </span>
                        <span className="text-[11px] font-semibold text-zinc-200 truncate tracking-tight">
                          {currentProject?.video_filename || 'Video'}
                        </span>
                      </div>
                      <span className="text-[10px] text-teal-300/80 font-mono font-bold shrink-0 bg-black/40 px-1.5 py-0.5 rounded border border-white/5">
                        {fmtTime(duration)}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  onClick={handleAddClipClick}
                  className="px-4 py-2 flex items-center gap-2 h-full cursor-pointer hover:bg-teal-950/20 text-teal-400 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  <span className="text-xs font-medium">Click to Add Video to Timeline</span>
                </div>
              )}

              {/* Quick Append Video Button at end of timeline */}
              <button
                onClick={handleAddClipClick}
                disabled={isUploadingClip}
                className="absolute top-2.5 h-8 px-2.5 rounded-lg border border-dashed border-teal-500/40 hover:border-teal-400 bg-teal-950/30 hover:bg-teal-900/50 text-teal-300 hover:text-teal-100 flex items-center gap-1 text-[11px] font-semibold transition-all z-20"
                style={{ left: timeToX(duration) + 12 }}
                title="Upload & Append New Video Clip to V1"
              >
                {isUploadingClip ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                <span>+ Clip</span>
              </button>
            </div>

            {/* ──── Text Tracks: T1, T2... ──── */}
            {Array.from({ length: laneCount }, (_, laneIdx) => {
              const isLaneHidden = hiddenTracks.has(`T${laneIdx + 1}`) || hiddenTracks.has('T') || !subtitlesVisible;
              return (
              <div
                key={`t-track-${laneIdx}`}
                className={`relative border-b border-zinc-700/30 transition-opacity ${isLaneHidden ? 'opacity-25' : ''}`}
                style={{ height: TRACK_HEIGHT }}
              >
                {markers.map((t) => (
                  <div
                    key={`t${laneIdx}-grid-${t}`}
                    className="absolute top-0 bottom-0 w-px bg-zinc-700/15"
                    style={{ left: timeToX(t) }}
                  />
                ))}

                {segments
                  .filter((seg) => laneMap.get(seg.id) === laneIdx)
                  .map((seg) => {
                    const range = clipLayout.length > 0
                      ? sourceRangeToTimeline(clipLayout, seg.start_time, seg.end_time)
                      : { timelineStart: seg.start_time, timelineEnd: seg.end_time, isVisible: true };

                    if (!range.isVisible) return null;

                    const left = timeToX(range.timelineStart);
                    const width = Math.max(timeToX(range.timelineEnd) - left, 6);
                    const color = speakerColors[seg.speaker] || COLORS[0];
                    const isActive = seg.id === activeSegmentId;

                    const isFreeze = seg.speaker === 'Freeze' || seg.voice_profile === 'freeze' || seg.text.includes('Freeze Frame');

                    return (
                      <div
                        key={seg.id}
                        className={`absolute top-1.5 rounded-md cursor-grab active:cursor-grabbing transition-all ${
                          isActive ? 'ring-2 ring-white/40' : ''
                        } ${mutedTracks.has(laneIdx) ? 'opacity-30' : ''}`}
                        style={{
                          left,
                          width,
                          height: TRACK_HEIGHT - 12,
                          background: isFreeze
                            ? 'linear-gradient(135deg, rgba(8, 145, 178, 0.5) 0%, rgba(6, 182, 212, 0.7) 50%, rgba(14, 165, 233, 0.5) 100%)'
                            : `${color}55`,
                          borderLeft: isFreeze ? '3px solid #38bdf8' : `3px solid ${color}`,
                          border: isFreeze ? '1px solid #38bdf8' : undefined,
                          boxShadow: isFreeze ? '0 0 10px rgba(56, 189, 248, 0.3)' : undefined,
                          borderRadius: '6px',
                        }}
                        onMouseDown={(e) => handleSegmentMouseDown(e, seg, 'move')}
                      >
                        <div
                          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-white/20 rounded-l-md"
                          onMouseDown={(e) => handleSegmentMouseDown(e, seg, 'resize-start')}
                        />
                        {width > 30 && (
                          <div className="px-2 py-1 overflow-hidden h-full flex flex-col justify-center">
                            <p className="text-[10px] text-white/90 truncate font-khmer leading-tight flex items-center gap-1">
                              {isFreeze && <Snowflake className="w-2.5 h-2.5 text-cyan-300 shrink-0 animate-pulse" />}
                              <span>{seg.text}</span>
                            </p>
                            {seg.speaker && width > 80 && (
                              <p className="text-[8px] text-white/50 truncate">
                                {isFreeze ? '2.0s Freeze Snapshot' : seg.speaker}
                              </p>
                            )}
                          </div>
                        )}
                        <div
                          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-white/20 rounded-r-md"
                          onMouseDown={(e) => handleSegmentMouseDown(e, seg, 'resize-end')}
                        />
                      </div>
                    );
                  })}

                {/* Real-time Streaming Pulse Indicator when AI is transcribing */}
                {isTranscribing && laneIdx === 0 && (
                  <div
                    className="absolute top-1.5 h-7 rounded-md bg-gradient-to-r from-pink-500/20 via-purple-500/30 to-transparent border border-dashed border-pink-500/50 animate-pulse pointer-events-none flex items-center px-2 z-10"
                    style={{
                      left: timeToX(segments.length > 0 ? segments[segments.length - 1].end_time : 0),
                      width: Math.max(90, timeToX(Math.max(1, (transcribePercent / 100) * duration)) - timeToX(segments.length > 0 ? segments[segments.length - 1].end_time : 0)),
                    }}
                  >
                    <span className="text-[9px] font-mono font-bold text-pink-300 flex items-center gap-1 truncate">
                      <Sparkles className="w-2.5 h-2.5 animate-spin text-pink-400" />
                      <span>Transcribing queue... ({transcribePercent}%)</span>
                    </span>
                  </div>
                )}
              </div>
            );
            })}

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
                  className={`relative border-b border-zinc-700/30 transition-opacity ${isAHidden ? 'opacity-25' : ''}`}
                  style={{ height: TRACK_HEIGHT }}
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

                    if (!range.isVisible) return null;

                    const left = timeToX(range.timelineStart);
                    const width = Math.max(timeToX(range.timelineEnd) - left, 6);
                    const isActive = seg.id === activeSegmentId;
                    return (
                      <div
                        key={`ai-${seg.id}`}
                        className={`absolute top-1 rounded-xl transition-all overflow-hidden cursor-pointer shadow-md shadow-purple-950/30 ${
                          isActive ? 'ring-2 ring-white ring-offset-1 ring-offset-black' : 'hover:brightness-110'
                        } ${isMuted ? 'opacity-30' : ''}`}
                        style={{
                          left,
                          width,
                          height: TRACK_HEIGHT - 8,
                          background: 'linear-gradient(135deg, #7c3aed 0%, #9333ea 50%, #6d28d9 100%)',
                          border: '1px solid rgba(196, 181, 253, 0.4)',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveSegment(seg.id);
                          if (videoRef.current) videoRef.current.currentTime = seg.start_time;
                          const tlTime = clipLayout.length > 0 ? sourceToTimeline(clipLayout, seg.start_time) : seg.start_time;
                          setCurrentTime(tlTime);
                        }}
                      >
                        {/* Audio Clip Header Title */}
                        <div className="px-2.5 pt-1 flex items-center justify-between gap-1 z-10 relative">
                          <span className="text-[10px] font-medium text-white/95 truncate">
                            {seg.speaker ? `${seg.speaker}.wav` : seg.text ? `${seg.text.slice(0, 24)}...wav` : 'speech.wav'}
                          </span>
                          <span className="text-[9px] font-mono text-purple-200/70 shrink-0">
                            {seg.audio_speed ? `${seg.audio_speed}x` : '1.0x'}
                          </span>
                        </div>

                        {/* Waveform Graphic */}
                        <div className="absolute inset-x-0 bottom-0 top-3 flex items-end justify-between px-1.5 pb-1 opacity-75 pointer-events-none gap-[1.5px] overflow-hidden">
                          {Array.from({ length: Math.max(12, Math.floor(width / 3.5)) }).map((_, barIdx) => {
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
                      </div>
                    );
                  })}

                  {emptySegs && (
                    <div className="px-3 py-1 flex items-center h-full">
                      <span className="text-[10px] text-cyan-300/25">{trackLabel}</span>
                    </div>
                  )}
                </div>
              );
            })}

            {/* ──── Isolated Vocals Track ──── */}
            {audioSeparated && (
              <div
                className="relative border-b border-[#1c1e24] bg-[#0c121e]/50"
                style={{ height: TRACK_HEIGHT }}
              >
                {markers.map((t) => (
                  <div
                    key={`v1-grid-${t}`}
                    className="absolute top-0 bottom-0 w-px bg-zinc-700/15"
                    style={{ left: timeToX(t) }}
                  />
                ))}

                <div
                  className={`absolute top-1 rounded-lg border border-blue-500/40 overflow-hidden transition-all shadow-sm ${
                    v1Muted ? 'opacity-35 grayscale' : 'opacity-100'
                  }`}
                  style={{
                    left: 0,
                    width: Math.max(timeToX(duration), 60),
                    height: TRACK_HEIGHT - 8,
                    background: 'linear-gradient(180deg, #1e3a8a 0%, #172554 100%)',
                  }}
                >
                  {/* Subtle audio waveform dots */}
                  <div className="absolute inset-0 opacity-30 bg-[radial-gradient(#60a5fa_1px,transparent_1px)] [background-size:6px_6px]" />
                  <div className="relative px-2.5 flex items-center justify-between h-full z-10">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Mic className="w-3.5 h-3.5 text-blue-300 shrink-0" />
                      <span className="text-[11px] font-bold text-blue-100 truncate">
                        Isolated Vocals (Speech) {v1Muted && '· Muted'}
                      </span>
                    </div>
                    {/* Visual audio equalizer bars */}
                    <div className="flex items-center gap-0.5 opacity-70">
                      <div className="w-0.5 h-2.5 bg-blue-300 rounded-full" />
                      <div className="w-0.5 h-4 bg-blue-200 rounded-full" />
                      <div className="w-0.5 h-2 bg-blue-300 rounded-full" />
                      <div className="w-0.5 h-3.5 bg-blue-200 rounded-full" />
                      <div className="w-0.5 h-2.5 bg-blue-300 rounded-full" />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ──── Isolated BGM Track ──── */}
            {audioSeparated && (
              <div
                className="relative border-b border-[#1c1e24] bg-[#1a1205]/50"
                style={{ height: TRACK_HEIGHT }}
              >
                {markers.map((t) => (
                  <div
                    key={`b1-grid-${t}`}
                    className="absolute top-0 bottom-0 w-px bg-zinc-700/15"
                    style={{ left: timeToX(t) }}
                  />
                ))}

                <div
                  className={`absolute top-1 rounded-lg border border-amber-500/40 overflow-hidden transition-all shadow-sm ${
                    b1Muted ? 'opacity-35 grayscale' : 'opacity-100'
                  }`}
                  style={{
                    left: 0,
                    width: Math.max(timeToX(duration), 60),
                    height: TRACK_HEIGHT - 8,
                    background: 'linear-gradient(180deg, #78350f 0%, #451a03 100%)',
                  }}
                >
                  {/* Subtle audio waveform dots */}
                  <div className="absolute inset-0 opacity-30 bg-[radial-gradient(#fbbf24_1px,transparent_1px)] [background-size:6px_6px]" />
                  <div className="relative px-2.5 flex items-center justify-between h-full z-10">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Music className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                      <span className="text-[11px] font-bold text-amber-100 truncate">
                        Isolated BGM (Background Music) {b1Muted && '· Muted'}
                      </span>
                    </div>
                    {/* Visual audio equalizer bars */}
                    <div className="flex items-center gap-0.5 opacity-70">
                      <div className="w-0.5 h-3.5 bg-amber-300 rounded-full" />
                      <div className="w-0.5 h-2 bg-amber-200 rounded-full" />
                      <div className="w-0.5 h-4.5 bg-amber-300 rounded-full" />
                      <div className="w-0.5 h-2.5 bg-amber-200 rounded-full" />
                      <div className="w-0.5 h-3.5 bg-amber-300 rounded-full" />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ──── Playhead — vertical line ──── */}
            <div
              className="absolute top-0 w-px z-20 pointer-events-none timeline-playhead"
              style={{
                left: timeToX(currentTime),
                height: 7 + VIDEO_TRACK_HEIGHT + TRACK_HEIGHT * (laneCount + 1 + (audioSeparated ? 2 : 0)),
              }}
            />
          </div>
        </div>
      </div>

      {/* Hidden audio elements for AI audio playback */}
      {segments.filter(s => s.audio_url).map(seg => {
        const profile = seg.voice_profile || 'female';
        const isMuted = aiTrackProfiles[0] === '_all'
          ? aiMutedProfiles.has('_all')
          : aiMutedProfiles.has(profile);
        return (
          <audio
            key={`ai-audio-${seg.id}-${seg.audio_url}`}
            ref={(el) => {
              if (el) aiAudioRefs.current.set(seg.id, el);
              else aiAudioRefs.current.delete(seg.id);
            }}
            src={seg.audio_url.startsWith('http') || seg.audio_url.startsWith('/') ? seg.audio_url : '/' + seg.audio_url.replace(/^\.\//, '')}
            preload="auto"
            muted={isMuted}
          />
        );
      })}

      {/* Crop Modal */}
      {showCropModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowCropModal(false)}>
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-md p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2"><Crop className="w-4 h-4" /> Crop Video</h3>
              <button onClick={() => setShowCropModal(false)} className="p-1 rounded hover:bg-zinc-700 transition-colors">
                <X className="w-4 h-4 text-zinc-400" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] text-zinc-400 uppercase tracking-wide block mb-1">X (left)</label>
                <input
                  type="number"
                  value={cropX}
                  onChange={(e) => setCropX(Math.max(0, parseInt(e.target.value) || 0))}
                  min={0}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
                />
              </div>
              <div>
                <label className="text-[11px] text-zinc-400 uppercase tracking-wide block mb-1">Y (top)</label>
                <input
                  type="number"
                  value={cropY}
                  onChange={(e) => setCropY(Math.max(0, parseInt(e.target.value) || 0))}
                  min={0}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
                />
              </div>
              <div>
                <label className="text-[11px] text-zinc-400 uppercase tracking-wide block mb-1">Width</label>
                <input
                  type="number"
                  value={cropW}
                  onChange={(e) => setCropW(Math.max(2, parseInt(e.target.value) || 2))}
                  min={2}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
                />
              </div>
              <div>
                <label className="text-[11px] text-zinc-400 uppercase tracking-wide block mb-1">Height</label>
                <input
                  type="number"
                  value={cropH}
                  onChange={(e) => setCropH(Math.max(2, parseInt(e.target.value) || 2))}
                  min={2}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
                />
              </div>
            </div>

            <p className="text-[10px] text-zinc-500">Crop region is measured in pixels from the top-left corner of the video.</p>

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setShowCropModal(false)}
                className="px-4 py-2 rounded-lg text-xs font-medium text-zinc-300 bg-zinc-700 hover:bg-zinc-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCrop}
                disabled={isCropping}
                className="px-4 py-2 rounded-lg text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {isCropping && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Crop
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Blur Logo Modal */}
      {showBlurModal && blurSnapshot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowBlurModal(false)}>
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-xl p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2"><Eraser className="w-4 h-4 text-pink-400" /> Blur Subtitles / Watermark</h3>
              <button onClick={() => setShowBlurModal(false)} className="p-1 rounded hover:bg-zinc-700 transition-colors">
                <X className="w-4 h-4 text-zinc-400" />
              </button>
            </div>

            <p className="text-[11px] text-zinc-400">Choose a preset or drag and resize the box over original text/logos to permanently blur them.</p>

            {/* Quick Blur Presets */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Presets:</span>
              <button
                onClick={() => {
                  if (blurNatural.w > 0 && blurNatural.h > 0) {
                    setBlurRegion({
                      x: 0,
                      y: Math.round(blurNatural.h * 0.80),
                      width: blurNatural.w,
                      height: Math.round(blurNatural.h * 0.18),
                    });
                  }
                }}
                className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-200 font-medium border border-zinc-700/60 transition-colors flex items-center gap-1"
              >
                <span>🔤</span>
                <span>Bottom Subtitles</span>
              </button>
              <button
                onClick={() => {
                  if (blurNatural.w > 0 && blurNatural.h > 0) {
                    setBlurRegion({
                      x: Math.round(blurNatural.w * 0.10),
                      y: Math.round(blurNatural.h * 0.82),
                      width: Math.round(blurNatural.w * 0.80),
                      height: Math.round(blurNatural.h * 0.14),
                    });
                  }
                }}
                className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-200 font-medium border border-zinc-700/60 transition-colors flex items-center gap-1"
              >
                <span>💬</span>
                <span>Compact Box</span>
              </button>
              <button
                onClick={() => {
                  if (blurNatural.w > 0 && blurNatural.h > 0) {
                    setBlurRegion({
                      x: Math.round(blurNatural.w * 0.76),
                      y: Math.round(blurNatural.h * 0.04),
                      width: Math.round(blurNatural.w * 0.20),
                      height: Math.round(blurNatural.h * 0.10),
                    });
                  }
                }}
                className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-200 font-medium border border-zinc-700/60 transition-colors flex items-center gap-1"
              >
                <span>🏷️</span>
                <span>Top-Right Logo</span>
              </button>
              <button
                onClick={() => {
                  if (blurNatural.w > 0 && blurNatural.h > 0) {
                    setBlurRegion({
                      x: Math.round(blurNatural.w * 0.04),
                      y: Math.round(blurNatural.h * 0.04),
                      width: Math.round(blurNatural.w * 0.20),
                      height: Math.round(blurNatural.h * 0.10),
                    });
                  }
                }}
                className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-200 font-medium border border-zinc-700/60 transition-colors flex items-center gap-1"
              >
                <span>🏷️</span>
                <span>Top-Left Logo</span>
              </button>
            </div>

            <div className="relative select-none" style={{ touchAction: 'none' }}>
              <img
                ref={blurImgRef}
                src={blurSnapshot}
                alt="Video frame"
                className="w-full h-auto rounded-lg block"
                draggable={false}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                    setBlurNatural({ w: img.naturalWidth, h: img.naturalHeight });
                  }
                }}
              />
              {blurNatural.w > 0 && (
                <div
                  className="absolute border-2 border-blue-500 bg-blue-500/20 cursor-move"
                  style={{
                    left: `${(blurRegion.x / blurNatural.w) * 100}%`,
                    top: `${(blurRegion.y / blurNatural.h) * 100}%`,
                    width: `${(blurRegion.width / blurNatural.w) * 100}%`,
                    height: `${(blurRegion.height / blurNatural.h) * 100}%`,
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setBlurDrag({ mode: 'move', startX: e.clientX, startY: e.clientY, orig: { ...blurRegion } });
                  }}
                >
                  {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
                    <div
                      key={corner}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setBlurDrag({ mode: corner, startX: e.clientX, startY: e.clientY, orig: { ...blurRegion } });
                      }}
                      className="absolute w-3 h-3 bg-blue-500 border border-white rounded-full"
                      style={{
                        left: corner.includes('l') ? '-6px' : undefined,
                        right: corner.includes('r') ? '-6px' : undefined,
                        top: corner.includes('t') ? '-6px' : undefined,
                        bottom: corner.includes('b') ? '-6px' : undefined,
                        cursor: corner === 'tl' || corner === 'br' ? 'nwse-resize' : 'nesw-resize',
                      }}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setShowBlurModal(false)}
                disabled={isBlurring}
                className="px-4 py-2 rounded-lg text-xs font-medium text-zinc-300 bg-zinc-700 hover:bg-zinc-600 transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleApplyBlur}
                disabled={isBlurring}
                className="px-5 py-2 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 transition-colors disabled:opacity-50 flex items-center gap-2 shadow-md shadow-blue-950/50"
              >
                {isBlurring ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Rendering Blur to Video...</span>
                  </>
                ) : (
                  <>
                    <Eraser className="w-3.5 h-3.5" />
                    <span>Apply Permanent Blur</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ──── Keyboard Shortcuts Modal ──── */}
      {showShortcutsModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
          onClick={() => setShowShortcutsModal(false)}
        >
          <div
            className="bg-[#181a20] border border-[#2d3139] rounded-2xl shadow-2xl w-full max-w-lg p-5 text-zinc-200 animate-in fade-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#2d3139] pb-3 mb-4">
              <div className="flex items-center gap-2">
                <Keyboard className="w-5 h-5 text-pink-400" />
                <h3 className="font-semibold text-base text-white">Timeline Keyboard Shortcuts</h3>
              </div>
              <button
                onClick={() => setShowShortcutsModal(false)}
                className="p-1 rounded-lg hover:bg-[#252830] text-zinc-400 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="space-y-2">
                <h4 className="text-[11px] font-bold tracking-wider uppercase text-zinc-400 border-b border-zinc-700/50 pb-1">
                  Playback & Navigation
                </h4>
                <div className="flex items-center justify-between bg-[#121316] px-2.5 py-1.5 rounded-lg border border-zinc-800">
                  <span className="text-zinc-300">Play / Pause</span>
                  <kbd className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-200 font-mono">Space</kbd>
                </div>
                <div className="flex items-center justify-between bg-[#121316] px-2.5 py-1.5 rounded-lg border border-zinc-800">
                  <span className="text-zinc-300">Step 1 Frame</span>
                  <kbd className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-200 font-mono">← / →</kbd>
                </div>
                <div className="flex items-center justify-between bg-[#121316] px-2.5 py-1.5 rounded-lg border border-zinc-800">
                  <span className="text-zinc-300">Step 1 Second</span>
                  <kbd className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-200 font-mono">Shift + ← / →</kbd>
                </div>
                <div className="flex items-center justify-between bg-[#121316] px-2.5 py-1.5 rounded-lg border border-zinc-800">
                  <span className="text-zinc-300">Prev / Next Cut</span>
                  <kbd className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-200 font-mono">[ / ]</kbd>
                </div>
                <div className="flex items-center justify-between bg-[#121316] px-2.5 py-1.5 rounded-lg border border-zinc-800">
                  <span className="text-zinc-300">Jump Start / End</span>
                  <kbd className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-200 font-mono">Home / End</kbd>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="text-[11px] font-bold tracking-wider uppercase text-zinc-400 border-b border-zinc-700/50 pb-1">
                  Editing & Tools
                </h4>
                <div className="flex items-center justify-between bg-[#121316] px-2.5 py-1.5 rounded-lg border border-zinc-800">
                  <span className="text-zinc-300">Split at Playhead</span>
                  <kbd className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-200 font-mono">S or C</kbd>
                </div>
                <div className="flex items-center justify-between bg-[#121316] px-2.5 py-1.5 rounded-lg border border-zinc-800">
                  <span className="text-zinc-300">Add Marker</span>
                  <kbd className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-200 font-mono">M</kbd>
                </div>
                <div className="flex items-center justify-between bg-[#121316] px-2.5 py-1.5 rounded-lg border border-zinc-800">
                  <span className="text-zinc-300">Fit to Timeline</span>
                  <kbd className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-200 font-mono">Z</kbd>
                </div>
                <div className="flex items-center justify-between bg-[#121316] px-2.5 py-1.5 rounded-lg border border-zinc-800">
                  <span className="text-zinc-300">Zoom at Cursor</span>
                  <kbd className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-200 font-mono">Ctrl + Scroll</kbd>
                </div>
                <div className="flex items-center justify-between bg-[#121316] px-2.5 py-1.5 rounded-lg border border-zinc-800">
                  <span className="text-zinc-300">Horizontal Scroll</span>
                  <kbd className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-200 font-mono">Shift + Scroll</kbd>
                </div>
              </div>
            </div>

            <div className="mt-5 pt-3 border-t border-[#2d3139] flex justify-end">
              <button
                onClick={() => setShowShortcutsModal(false)}
                className="px-4 py-1.5 bg-pink-600 hover:bg-pink-500 text-white text-xs font-semibold rounded-xl shadow transition-colors cursor-pointer"
              >
                Got It
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
