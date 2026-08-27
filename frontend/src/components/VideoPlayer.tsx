import { useEffect, RefObject, useCallback, useRef, useMemo, useState } from 'react';
import { useProjectStore } from '../stores/projectStore';
import {
  Play,
  Pause,
  Square,
  Repeat,
  Volume2,
  VolumeX,
  Upload,
  Maximize,
  Minimize,
  ChevronDown,
  SkipBack,
  SkipForward,
  RotateCw,
  Move,
  Eye,
  EyeOff,
  Sparkles,
  Layers,
  Ratio,
  SlidersHorizontal,
  Check,
  Snowflake,
  Eraser,
  Loader2,
  Plus,
  Trash2,
  Image as ImageIcon,
} from 'lucide-react';
import { blurVideoRegion, blurVideoRegions } from '../api/client';
import { buildClipLayout, sourceToTimeline, timelineToSource, totalTimelineDuration, findClipAtTimelineTime, sourceRangeToTimeline } from '../utils/clipTimemap';
import SubtitleOverlay from './SubtitleOverlay';
import LogoOverlayModal from './LogoOverlayModal';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
}

export type AspectRatioType = '16:9' | '9:16' | '1:1' | '4:5' | '21:9';

export const ASPECT_RATIOS: { id: AspectRatioType; label: string; ratio: string; w: number; h: number }[] = [
  { id: '16:9', label: '16:9 (Landscape)', ratio: '16 / 9', w: 1920, h: 1080 },
  { id: '9:16', label: '9:16 (TikTok/Reels)', ratio: '9 / 16', w: 1080, h: 1920 },
  { id: '1:1', label: '1:1 (Square)', ratio: '1 / 1', w: 1080, h: 1080 },
  { id: '4:5', label: '4:5 (Portrait)', ratio: '4 / 5', w: 1080, h: 1350 },
  { id: '21:9', label: '21:9 (Ultrawide)', ratio: '21 / 9', w: 2560, h: 1080 },
];

export const CANVAS_ZOOM_LEVELS = [
  { label: 'Fit to Screen', value: 1.0 },
  { label: '50%', value: 0.5 },
  { label: '75%', value: 0.75 },
  { label: '100% (Original)', value: 1.0 },
  { label: '125%', value: 1.25 },
  { label: '150%', value: 1.5 },
  { label: '200%', value: 2.0 },
];

export const FILTER_PRESETS: { id: string; name: string; filterStyle: string }[] = [
  { id: 'none', name: 'Original', filterStyle: 'none' },
  { id: 'vivid', name: 'Vivid Pop', filterStyle: 'saturate(1.4) contrast(1.15) brightness(1.05)' },
  { id: 'cinematic', name: 'Cinematic Teal', filterStyle: 'contrast(1.2) saturate(1.1) hue-rotate(-10deg) brightness(0.95)' },
  { id: 'noir', name: 'Noir B&W', filterStyle: 'grayscale(1) contrast(1.3) brightness(0.9)' },
  { id: 'sunset', name: 'Golden Sunset', filterStyle: 'sepia(0.35) saturate(1.4) hue-rotate(-15deg) contrast(1.1)' },
  { id: 'cyberpunk', name: 'Cyberpunk Neon', filterStyle: 'contrast(1.25) saturate(1.6) hue-rotate(45deg)' },
  { id: 'vintage', name: '70s Vintage', filterStyle: 'sepia(0.4) contrast(0.95) brightness(1.05) saturate(0.85)' },
  { id: 'cool_blue', name: 'Cool Crisp', filterStyle: 'saturate(1.2) hue-rotate(15deg) contrast(1.05)' },
];

/**
 * Accurately find the active segment at a given timeline timestamp.
 * Uses half-open intervals [start_time, end_time) to prevent previous segments
 * (e.g. #289) from incorrectly claiming the boundary when clicking the next (#290).
 */
export function findActiveSegmentAtTime(
  segments: any[] | undefined,
  time: number,
  clipLayout?: any[]
): any | null {
  if (!segments || segments.length === 0) return null;
  const filtered = segments.filter(
    (s) => s.speaker !== 'Freeze' && s.voice_profile !== 'freeze' && !(s.text && s.text.includes('Freeze Frame'))
  );
  if (filtered.length === 0) return null;

  for (const s of filtered) {
    const range = clipLayout && clipLayout.length > 0
      ? sourceRangeToTimeline(clipLayout, s.start_time, s.end_time)
      : { timelineStart: s.start_time, timelineEnd: s.end_time, isVisible: true };

    if (range.isVisible && time >= range.timelineStart && time < range.timelineEnd) {
      return s;
    }
  }

  // Exact start match
  for (const s of filtered) {
    const range = clipLayout && clipLayout.length > 0
      ? sourceRangeToTimeline(clipLayout, s.start_time, s.end_time)
      : { timelineStart: s.start_time, timelineEnd: s.end_time, isVisible: true };

    if (range.isVisible && Math.abs(time - range.timelineStart) < 0.05) {
      return s;
    }
  }

  // Boundary check
  for (const s of filtered) {
    const range = clipLayout && clipLayout.length > 0
      ? sourceRangeToTimeline(clipLayout, s.start_time, s.end_time)
      : { timelineStart: s.start_time, timelineEnd: s.end_time, isVisible: true };

    if (range.isVisible && time >= range.timelineStart - 0.02 && time <= range.timelineEnd) {
      return s;
    }
  }

  return null;
}

export default function VideoPlayer({ videoRef }: Props) {
  const {
    currentProject,
    loadProject,
    currentTime,
    isPlaying,
    setCurrentTime,
    setIsPlaying,
    setActiveSegment,
    videoClips,
    activeSegmentId,
    subtitleStyle,
    setSubtitleStyle,
    updateSegment,
    deleteSegment,
    subtitlesVisible,
    videoVisible,
    hiddenTracks,
    toggleSubtitlesVisible,
    toggleVideoVisible,
    aspectRatio,
    setAspectRatio,
    canvasZoom,
    setCanvasZoom,
    audioSeparated,
    videoMuted,
  } = useProjectStore();

  const isVideoVisible = videoVisible && !hiddenTracks.has('V') && !hiddenTracks.has('V1');
  const isSubtitlesVisible = subtitlesVisible && !hiddenTracks.has('T') && !hiddenTracks.has('T1') && !hiddenTracks.has('T2');

  const [volume, setVolume] = useState(() => {
    try {
      const saved = localStorage.getItem('player-volume');
      return saved !== null ? parseFloat(saved) : 1.0;
    } catch {
      return 1.0;
    }
  });
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem('player-muted') === 'true';
    } catch {
      return false;
    }
  });
  const [loop, setLoop] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const selectedRatio = (aspectRatio as AspectRatioType) || '16:9';
  const zoomLevel = canvasZoom;
  const [activeFilter, setActiveFilter] = useState('none');
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const [showRatioDropdown, setShowRatioDropdown] = useState(false);
  const [showSpeedDropdown, setShowSpeedDropdown] = useState(false);
  const [showCanvasZoomDropdown, setShowCanvasZoomDropdown] = useState(false);
  const [showBlurDropdown, setShowBlurDropdown] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | null>(null);

  // Multiple Blur Shapes / Watermark Mask State (Isolated per project)
  const defaultBlurShapes = [
    {
      id: 'blur-1',
      name: 'Bottom Subtitles',
      enabled: false,
      x: 0,
      y: 82,
      width: 100,
      height: 16,
      blurRadius: 24,
      opacity: 0.75,
      borderRadius: 0,
    },
  ];

  const [blurShapes, setBlurShapes] = useState<Array<{
    id: string;
    name: string;
    enabled: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    blurRadius: number;
    opacity: number;
    borderRadius: number;
  }>>(defaultBlurShapes);
  const [activeBlurShapeId, setActiveBlurShapeId] = useState<string>('blur-1');
  const [showLogoTools, setShowLogoTools] = useState(false);

  // Load project-specific blur shapes when switching projects
  useEffect(() => {
    if (!currentProject?.id) return;
    try {
      const stored = localStorage.getItem(`meatika_blur_shapes_${currentProject.id}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setBlurShapes(parsed);
          setActiveBlurShapeId(parsed[0].id || 'blur-1');
          return;
        }
      }
    } catch {}
    setBlurShapes(defaultBlurShapes);
    setActiveBlurShapeId('blur-1');
  }, [currentProject?.id]);

  // Persist blur shapes per project
  const saveBlurShapes = (shapes: typeof blurShapes) => {
    setBlurShapes(shapes);
    if (currentProject?.id) {
      try {
        localStorage.setItem(`meatika_blur_shapes_${currentProject.id}`, JSON.stringify(shapes));
      } catch {}
    }
  };

  // Close dropdowns on click outside
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-dropdown-container]')) {
        setShowRatioDropdown(false);
        setShowFilterDropdown(false);
        setShowBlurDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const activeBlurShape = blurShapes.find((s) => s.id === activeBlurShapeId) || blurShapes[0] || null;

  const updateActiveBlurShape = (updates: Partial<typeof blurShapes[0]>) => {
    if (!activeBlurShape) return;
    const targetId = activeBlurShape.id;
    const updated = blurShapes.map((s) => (s.id === targetId ? { ...s, ...updates } : s));
    saveBlurShapes(updated);
  };

  const handleAddBlurShape = () => {
    const newId = `blur-${Date.now()}`;
    const newShape = {
      id: newId,
      name: `Blur Box ${blurShapes.length + 1}`,
      enabled: true,
      x: 15,
      y: 15,
      width: 35,
      height: 14,
      blurRadius: 24,
      opacity: 0.75,
      borderRadius: 8,
    };
    const updated = [...blurShapes, newShape];
    saveBlurShapes(updated);
    setActiveBlurShapeId(newId);
  };

  const handleDeleteBlurShape = (id: string) => {
    const filtered = blurShapes.filter((s) => s.id !== id);
    saveBlurShapes(filtered);
    if (filtered.length > 0) {
      if (activeBlurShapeId === id) {
        setActiveBlurShapeId(filtered[0].id);
      }
    } else {
      setActiveBlurShapeId('');
    }
  };

  const [isBurningBlur, setIsBurningBlur] = useState(false);

  // Drag state for active blur shape repositioning
  const blurDragRef = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);

  const handleBurnPermanentBlur = async () => {
    if (!currentProject || isBurningBlur) return;
    const enabledShapes = blurShapes.filter((s) => s.enabled);
    if (enabledShapes.length === 0) {
      alert('Please enable at least one blur shape first.');
      return;
    }

    setIsBurningBlur(true);
    try {
      const vid = videoRef.current;
      const w = vid?.videoWidth || 1280;
      const h = vid?.videoHeight || 720;

      const regions = enabledShapes.map((s) => ({
        x: Math.round((s.x / 100) * w),
        y: Math.round((s.y / 100) * h),
        width: Math.max(4, Math.round((s.width / 100) * w)),
        height: Math.max(4, Math.round((s.height / 100) * h)),
        x_pct: s.x,
        y_pct: s.y,
        width_pct: s.width,
        height_pct: s.height,
      }));

      await blurVideoRegions(currentProject.id, regions);
      await loadProject(currentProject.id);
      if (videoRef.current) {
        videoRef.current.load();
      }
      const resetShapes = blurShapes.map((s) => ({ ...s, enabled: false }));
      saveBlurShapes(resetShapes);
      setShowBlurDropdown(false);
      alert(`Permanent blur applied successfully to ${regions.length} region(s)!`);
    } catch (err: any) {
      console.error('Burn blur failed:', err);
      alert(`Blur failed: ${err?.response?.data?.detail || err.message || err}`);
    } finally {
      setIsBurningBlur(false);
    }
  };

  // On-canvas overlay drag/scale position
  const [overlayPos, setOverlayPos] = useState({ x: 0, y: 0 });
  const [overlayScale, setOverlayScale] = useState(1.0);
  const [isDraggingOverlay, setIsDraggingOverlay] = useState(false);
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, posX: 0, posY: 0 });

  const containerRef = useRef<HTMLDivElement>(null);
  const seekValueRef = useRef<number | null>(null);
  const wasPlayingRef = useRef(false);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const timelineTimeRef = useRef(currentTime);
  const playbackRateRef = useRef(playbackRate);

  useEffect(() => {
    timelineTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    if (videoRef.current) {
      if (audioSeparated || videoMuted) {
        videoRef.current.muted = true;
        videoRef.current.volume = 0;
      } else {
        videoRef.current.volume = volume;
        videoRef.current.muted = muted;
      }
    }
  }, [videoRef, volume, muted, audioSeparated, videoMuted]);

  const handleVolumeChange = useCallback((newVol: number) => {
    const clamped = Math.max(0, Math.min(1, newVol));
    setVolume(clamped);
    try { localStorage.setItem('player-volume', clamped.toString()); } catch {}

    const shouldMute = clamped === 0;
    if (shouldMute !== muted) {
      setMuted(shouldMute);
      try { localStorage.setItem('player-muted', shouldMute.toString()); } catch {}
    }

    if (videoRef.current) {
      if (audioSeparated || videoMuted) {
        videoRef.current.muted = true;
        videoRef.current.volume = 0;
      } else {
        videoRef.current.volume = clamped;
        videoRef.current.muted = shouldMute;
      }
    }

    window.dispatchEvent(new CustomEvent('master-volume-change', {
      detail: { volume: clamped, muted: shouldMute }
    }));
  }, [muted, videoRef, audioSeparated, videoMuted]);

  const toggleMute = useCallback(() => {
    const nextMuted = !muted;
    setMuted(nextMuted);
    try { localStorage.setItem('player-muted', nextMuted.toString()); } catch {}

    if (videoRef.current) {
      if (audioSeparated || videoMuted) {
        videoRef.current.muted = true;
        videoRef.current.volume = 0;
      } else {
        videoRef.current.muted = nextMuted;
        videoRef.current.volume = volume;
      }
    }

    window.dispatchEvent(new CustomEvent('master-volume-change', {
      detail: { volume, muted: nextMuted }
    }));
  }, [muted, volume, videoRef, audioSeparated, videoMuted]);

  useEffect(() => {
    playbackRateRef.current = playbackRate;
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, videoRef]);

  const videoFile = currentProject?.video_path ? currentProject.video_path.split('/').pop() : '';
  const videoSrc = currentProject?.video_path && videoFile
    ? `/uploads/${currentProject.id}/${videoFile}`
    : '';

  const clipLayout = useMemo(() => buildClipLayout(videoClips), [videoClips]);

  const duration = useMemo(() => {
    const tl = totalTimelineDuration(videoClips);
    return tl > 0 ? tl : (currentProject?.duration || videoDuration);
  }, [videoClips, currentProject?.duration, videoDuration]);

  const updateProgressBar = useCallback((time: number) => {
    if (duration <= 0) return;
    const pct = Math.min(100, Math.max(0, (time / duration) * 100));
    if (fillRef.current) fillRef.current.style.width = `${pct}%`;
    if (thumbRef.current) thumbRef.current.style.left = `${pct}%`;
  }, [duration]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoSrc) return;
    video.playbackRate = playbackRateRef.current;
    video.load();
  }, [videoSrc, videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onDuration = () => {
      if (video.duration && isFinite(video.duration) && video.duration > 0) {
        setVideoDuration(video.duration);
        const curr = useProjectStore.getState().currentProject;
        if (curr && (!curr.duration || Math.abs(curr.duration - video.duration) > 0.5)) {
          useProjectStore.setState({
            currentProject: { ...curr, duration: video.duration },
          });
        }
      }
    };
    video.addEventListener('loadedmetadata', onDuration);
    video.addEventListener('durationchange', onDuration);
    if (video.duration && isFinite(video.duration) && video.duration > 0) {
      onDuration();
    }
    return () => {
      video.removeEventListener('loadedmetadata', onDuration);
      video.removeEventListener('durationchange', onDuration);
    };
  }, [videoRef, videoSrc]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let rafId: number | null = null;

    const updateTime = () => {
      if (seekValueRef.current !== null) return;
      const srcTime = video.currentTime;

      if (clipLayout.length === 0) {
        timelineTimeRef.current = srcTime;
        setCurrentTime(srcTime);
        updateProgressBar(srcTime);
        const seg = findActiveSegmentAtTime(currentProject?.segments, srcTime);
        setActiveSegment(seg?.id || null);
        return;
      }

      // Multi-clip sequential playback:
      const totalDur = totalTimelineDuration(videoClips);
      const currentTlTime = timelineTimeRef.current;
      const currentEntry = findClipAtTimelineTime(clipLayout, currentTlTime) || clipLayout[0];
      const currentIdx = clipLayout.indexOf(currentEntry);

      // Check if video reached or exceeded the end of current clip's source range
      if (srcTime >= currentEntry.clip.source_end - 0.05) {
        if (currentIdx < clipLayout.length - 1) {
          // Progress smoothly to next clip
          const nextEntry = clipLayout[currentIdx + 1];
          video.currentTime = nextEntry.clip.source_start;
          timelineTimeRef.current = nextEntry.timelineStart;
          setCurrentTime(nextEntry.timelineStart);
          updateProgressBar(nextEntry.timelineStart);
          const seg = findActiveSegmentAtTime(currentProject?.segments, nextEntry.timelineStart);
          setActiveSegment(seg?.id || null);
          if (video.paused) {
            video.play().catch(() => {});
          }
          return;
        } else {
          // Reached the true end of the final clip on timeline
          video.pause();
          timelineTimeRef.current = totalDur;
          setCurrentTime(totalDur);
          updateProgressBar(totalDur);
          setIsPlaying(false);
          return;
        }
      }

      // Check if srcTime belongs to another clip (e.g. natural video progression or user click)
      const matchingEntry = clipLayout.find(
        (entry) => srcTime >= entry.clip.source_start - 0.05 && srcTime < entry.clip.source_end
      );

      const activeEntry = matchingEntry || currentEntry;
      const offsetInClip = Math.max(0, Math.min(activeEntry.clipDuration, srcTime - activeEntry.clip.source_start));
      const newTlTime = Math.min(activeEntry.timelineEnd, activeEntry.timelineStart + offsetInClip);

      timelineTimeRef.current = newTlTime;
      setCurrentTime(newTlTime);
      updateProgressBar(newTlTime);

      const seg = findActiveSegmentAtTime(currentProject?.segments, newTlTime);
      setActiveSegment(seg?.id || null);
    };

    const tick = () => {
      updateTime();
      if (!video.paused && !video.ended) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const onPlay = () => {
      video.playbackRate = playbackRateRef.current;
      setIsPlaying(true);
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    };

    const onPause = () => {
      setIsPlaying(false);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      updateTime();
    };

    const onSeeked = () => {
      updateTime();
    };

    const onEnded = () => {
      const currentTlTime = timelineTimeRef.current;
      const currentEntry = findClipAtTimelineTime(clipLayout, currentTlTime) || clipLayout[0];
      const currentIdx = clipLayout.indexOf(currentEntry);

      if (clipLayout.length > 1 && currentIdx < clipLayout.length - 1) {
        // More clips remain on timeline! Jump to next clip and continue playing!
        const nextEntry = clipLayout[currentIdx + 1];
        video.currentTime = nextEntry.clip.source_start;
        timelineTimeRef.current = nextEntry.timelineStart;
        setCurrentTime(nextEntry.timelineStart);
        updateProgressBar(nextEntry.timelineStart);
        const seg = findActiveSegmentAtTime(currentProject?.segments, nextEntry.timelineStart);
        setActiveSegment(seg?.id || null);
        video.play().catch(() => {});
        return;
      }

      setIsPlaying(false);
      const totalDur = clipLayout.length > 0
        ? totalTimelineDuration(videoClips)
        : (video.duration || 0);
      timelineTimeRef.current = totalDur;
      setCurrentTime(totalDur);
      updateProgressBar(totalDur);
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('ended', onEnded);

    if (!video.paused) {
      rafId = requestAnimationFrame(tick);
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('ended', onEnded);
    };
  }, [videoRef, currentProject?.segments, clipLayout, videoClips, updateProgressBar, setCurrentTime, setIsPlaying, setActiveSegment]);

  useEffect(() => {
    updateProgressBar(currentTime);
  }, [currentTime, updateProgressBar]);

  const seekToTimelineTime = useCallback((tlTime: number) => {
    const video = videoRef.current;
    if (!video) return;
    if (clipLayout.length > 0) {
      const result = timelineToSource(clipLayout, tlTime);
      if (result) {
        video.currentTime = result.sourceTime;
      }
    } else {
      video.currentTime = tlTime;
    }
    timelineTimeRef.current = tlTime;
    setCurrentTime(tlTime);
    updateProgressBar(tlTime);
  }, [clipLayout, videoRef, setCurrentTime, updateProgressBar]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      const totalDur = clipLayout.length > 0
        ? totalTimelineDuration(videoClips)
        : (video.duration || currentProject?.duration || 0);

      // If at or near the end of the video, restart smoothly from the beginning
      if (
        video.ended ||
        (totalDur > 0 && currentTime >= totalDur - 0.15)
      ) {
        const startSrc = clipLayout.length > 0 ? (clipLayout[0]?.clip.source_start ?? 0) : 0;
        video.currentTime = startSrc;
        timelineTimeRef.current = 0;
        setCurrentTime(0);
        updateProgressBar(0);
      } else {
        if (clipLayout.length > 0) {
          const result = timelineToSource(clipLayout, currentTime);
          const targetSrc = result ? result.sourceTime : (clipLayout[0]?.clip.source_start ?? 0);
          video.currentTime = targetSrc;
          timelineTimeRef.current = currentTime;
        } else {
          video.currentTime = currentTime;
          timelineTimeRef.current = currentTime;
        }
      }
      video.playbackRate = playbackRateRef.current;
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  const stop = () => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    if (clipLayout.length > 0) {
      video.currentTime = clipLayout[0].clip.source_start;
    } else {
      video.currentTime = 0;
    }
    setCurrentTime(0);
  };

  const stepFrame = (forward: boolean, frames = 1) => {
    const video = videoRef.current;
    if (!video) return;
    const delta = (frames / 30) * (forward ? 1 : -1);
    const newTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + delta));
    video.currentTime = newTime;
  };

  const handleSpeedChange = (spd: number) => {
    const clamped = Math.max(0.25, Math.min(3.0, Math.round(spd * 100) / 100));
    setPlaybackRate(clamped);
    if (videoRef.current) {
      videoRef.current.playbackRate = clamped;
    }
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  // Timecode format: 00:00:00:00
  const formatTimecode = (s: number) => {
    const totalMs = Math.max(0, s * 1000);
    const h = Math.floor(totalMs / 3600000);
    const m = Math.floor((totalMs % 3600000) / 60000);
    const sec = Math.floor((totalMs % 60000) / 1000);
    const f = Math.floor(((totalMs % 1000) / 1000) * 30);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}:${f.toString().padStart(2, '0')}`;
  };

  const activeFilterStyle = FILTER_PRESETS.find((f) => f.id === activeFilter)?.filterStyle || 'none';
  const ratioConfig = ASPECT_RATIOS.find((r) => r.id === selectedRatio) || ASPECT_RATIOS[0];

  if (!videoSrc) {
    return (
      <div className="h-full flex items-center justify-center bg-zinc-950 border-b border-zinc-800">
        <div className="text-center text-zinc-600 py-12">
          <Upload className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p className="text-xs font-medium opacity-60">No video loaded in project</p>
          <p className="text-[10px] text-zinc-600 mt-1">Upload a video or import subtitles to begin</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex flex-col bg-zinc-950 border-b border-zinc-800 select-none relative group/player h-full"
    >
      {/* Top Viewport Header Toolbar */}
      <div className="h-10 px-3 bg-[#121316] border-b border-[#1c1e24] flex items-center justify-between shrink-0 text-xs text-zinc-300 z-30 gap-2 overflow-visible relative">
        {/* Left: Aspect Ratio Switcher */}
        <div className="relative shrink-0" data-dropdown-container>
          <button
            onClick={() => {
              setShowRatioDropdown(!showRatioDropdown);
              setShowFilterDropdown(false);
              setShowSpeedDropdown(false);
              setShowBlurDropdown(false);
            }}
            className="h-7 flex items-center gap-1.5 px-2.5 rounded-lg bg-[#181a20] hover:bg-[#22252e] text-zinc-200 hover:text-white border border-[#262933] hover:border-[#3b4050] transition-all text-[11px] font-semibold shadow-xs cursor-pointer"
          >
            <Ratio className="w-3.5 h-3.5 text-pink-400 shrink-0" />
            <span className="font-mono">{selectedRatio}</span>
            <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
          </button>

          {showRatioDropdown && (
            <div className="absolute left-0 top-full mt-1.5 w-48 bg-[#181a20] border border-[#2a2e3b] rounded-xl shadow-2xl py-1 z-50 backdrop-blur-md">
              {ASPECT_RATIOS.map((r) => (
                <button
                  key={r.id}
                  onClick={() => {
                    setAspectRatio(r.id);
                    setShowRatioDropdown(false);
                  }}
                  className={`w-full px-3 py-1.5 text-left text-xs flex items-center justify-between hover:bg-white/5 transition-colors cursor-pointer ${
                    selectedRatio === r.id ? 'text-pink-400 font-semibold bg-pink-500/10' : 'text-zinc-300'
                  }`}
                >
                  <span>{r.label}</span>
                  <span className="text-[10px] text-zinc-500 font-mono">{r.w}x{r.h}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right Tools: Filter, Blur, Logo, Fullscreen */}
        <div className="flex items-center gap-1.5 shrink-0 flex-nowrap overflow-visible">
          {/* Visual Filters Dropdown */}
          <div className="relative shrink-0" data-dropdown-container>
            <button
              onClick={() => {
                setShowFilterDropdown(!showFilterDropdown);
                setShowRatioDropdown(false);
                setShowSpeedDropdown(false);
                setShowBlurDropdown(false);
              }}
              className={`h-7 flex items-center gap-1.5 px-2.5 rounded-lg text-[11px] font-medium transition-all cursor-pointer ${
                activeFilter !== 'none'
                  ? 'bg-purple-600/20 text-purple-200 border border-purple-500/50 shadow-xs'
                  : 'bg-[#181a20] hover:bg-[#22252e] text-zinc-300 hover:text-white border border-[#262933] hover:border-[#3b4050]'
              }`}
              title="Visual Color Filters & LUTs"
            >
              <Sparkles className="w-3.5 h-3.5 text-purple-400 shrink-0" />
              <span>{FILTER_PRESETS.find((f) => f.id === activeFilter)?.name || 'Filter'}</span>
            </button>

            {showFilterDropdown && (
              <div className="absolute right-0 top-full mt-1.5 w-44 bg-[#181a20] border border-[#2a2e3b] rounded-xl shadow-2xl py-1 z-50 backdrop-blur-md">
                {FILTER_PRESETS.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => {
                      setActiveFilter(f.id);
                      setShowFilterDropdown(false);
                    }}
                    className={`w-full px-3 py-1.5 text-left text-xs flex items-center justify-between hover:bg-white/5 transition-colors cursor-pointer ${
                      activeFilter === f.id ? 'text-purple-400 font-semibold bg-purple-500/10' : 'text-zinc-300'
                    }`}
                  >
                    <span>{f.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Blur Shape / Text Mask Dropdown */}
          <div className="relative shrink-0" data-dropdown-container>
            <button
              onClick={() => {
                setShowBlurDropdown(!showBlurDropdown);
                setShowFilterDropdown(false);
                setShowRatioDropdown(false);
                setShowCanvasZoomDropdown(false);
                setShowSpeedDropdown(false);
              }}
              className={`h-7 flex items-center gap-1.5 px-2.5 rounded-lg text-[11px] font-medium transition-all cursor-pointer ${
                blurShapes.some((s) => s.enabled)
                  ? 'bg-pink-600/20 text-pink-200 border border-pink-500/50 shadow-xs'
                  : 'bg-[#181a20] hover:bg-[#22252e] text-zinc-300 hover:text-white border border-[#262933] hover:border-[#3b4050]'
              }`}
              title="Blur multiple logos, watermarks, or subtitles on original video"
            >
              <Eraser className="w-3.5 h-3.5 text-pink-400 shrink-0" />
              <span>Blur ({blurShapes.filter((s) => s.enabled).length})</span>
            </button>

            {showBlurDropdown && (
              <div className="absolute right-0 top-full mt-1.5 w-80 bg-[#181a20] border border-[#2a2e3b] rounded-xl shadow-2xl p-3 z-50 backdrop-blur-md space-y-3">
                {/* Header & Add Shape */}
                <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                  <div className="flex items-center gap-1.5 font-bold text-xs text-white">
                    <Eraser className="w-4 h-4 text-pink-400" />
                    <span>Blur Shapes & Masks</span>
                  </div>
                  <button
                    onClick={handleAddBlurShape}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg bg-pink-600/20 hover:bg-pink-600/30 text-pink-300 border border-pink-500/30 text-[11px] font-bold transition-all active:scale-95"
                    title="Add another blur shape"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Shape</span>
                  </button>
                </div>

                {/* Shape List / Tabs */}
                <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                  {blurShapes.length === 0 ? (
                    <div className="py-3 px-2 text-center text-zinc-500 text-xs flex flex-col items-center gap-2">
                      <p>No blur shapes added yet.</p>
                      <button
                        onClick={handleAddBlurShape}
                        className="px-3 py-1 rounded bg-pink-600 hover:bg-pink-500 text-white font-bold text-[11px] flex items-center gap-1"
                      >
                        <Plus className="w-3 h-3" /> Add Blur Shape
                      </button>
                    </div>
                  ) : (
                    blurShapes.map((shape) => {
                      const isActive = shape.id === activeBlurShapeId;
                      return (
                        <div
                          key={shape.id}
                          onClick={() => setActiveBlurShapeId(shape.id)}
                          className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs cursor-pointer transition-all border ${
                            isActive
                              ? 'bg-pink-950/40 border-pink-500/50 text-white font-semibold shadow-xs'
                              : 'bg-zinc-800/60 hover:bg-zinc-800 border-zinc-700/50 text-zinc-300'
                          }`}
                        >
                          <div className="flex items-center gap-2 truncate">
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: shape.enabled ? '#ec4899' : '#71717a' }} />
                            <span className="truncate">{shape.name}</span>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                            {/* Toggle ON/OFF */}
                            <button
                              onClick={() => {
                                const updated = blurShapes.map((s) => (s.id === shape.id ? { ...s, enabled: !s.enabled } : s));
                                saveBlurShapes(updated);
                              }}
                              className={`px-2 py-0.5 rounded text-[10px] font-bold transition-colors ${
                                shape.enabled
                                  ? 'bg-pink-600 text-white'
                                  : 'bg-zinc-700 text-zinc-400 hover:text-zinc-200'
                              }`}
                            >
                              {shape.enabled ? 'ON' : 'OFF'}
                            </button>

                            {/* Delete Shape */}
                            <button
                              onClick={() => handleDeleteBlurShape(shape.id)}
                              className="p-1 text-zinc-500 hover:text-red-400 transition-colors"
                              title={`Delete ${shape.name}`}
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Active Shape Settings */}
                {activeBlurShape && (
                  <div className="space-y-2.5 pt-2 border-t border-zinc-800">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold text-pink-400 uppercase tracking-wider">
                        Edit: {activeBlurShape.name}
                      </span>
                      <span className="text-[10px] text-zinc-500">
                        {activeBlurShape.enabled ? 'Active on Canvas' : 'Disabled'}
                      </span>
                    </div>

                    {/* Presets */}
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        onClick={() =>
                          updateActiveBlurShape({
                            enabled: true,
                            x: 0,
                            y: 82,
                            width: 100,
                            height: 16,
                            borderRadius: 0,
                          })
                        }
                        className="px-2 py-1 rounded bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 text-[10px] text-left transition-colors truncate"
                      >
                        🔤 Bottom Subtitles
                      </button>
                      <button
                        onClick={() =>
                          updateActiveBlurShape({
                            enabled: true,
                            x: 10,
                            y: 84,
                            width: 80,
                            height: 12,
                            borderRadius: 12,
                          })
                        }
                        className="px-2 py-1 rounded bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 text-[10px] text-left transition-colors truncate"
                      >
                        💬 Compact Box
                      </button>
                      <button
                        onClick={() =>
                          updateActiveBlurShape({
                            enabled: true,
                            x: 74,
                            y: 4,
                            width: 22,
                            height: 10,
                            borderRadius: 8,
                          })
                        }
                        className="px-2 py-1 rounded bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 text-[10px] text-left transition-colors truncate"
                      >
                        🏷️ Top-Right Logo
                      </button>
                      <button
                        onClick={() =>
                          updateActiveBlurShape({
                            enabled: true,
                            x: 4,
                            y: 4,
                            width: 22,
                            height: 10,
                            borderRadius: 8,
                          })
                        }
                        className="px-2 py-1 rounded bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 text-[10px] text-left transition-colors truncate"
                      >
                        🏷️ Top-Left Logo
                      </button>
                    </div>

                    {/* Blur Strength Slider */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-zinc-400">Blur Strength</span>
                        <span className="text-pink-400 font-mono font-bold">{activeBlurShape.blurRadius}px</span>
                      </div>
                      <input
                        type="range"
                        min={4}
                        max={50}
                        value={activeBlurShape.blurRadius}
                        onChange={(e) => updateActiveBlurShape({ blurRadius: Number(e.target.value) })}
                        className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-pink-500"
                      />
                    </div>

                    {/* Dark Tint Opacity */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-zinc-400">Tint Darkness</span>
                        <span className="text-pink-400 font-mono font-bold">
                          {Math.round(activeBlurShape.opacity * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={activeBlurShape.opacity}
                        onChange={(e) => updateActiveBlurShape({ opacity: Number(e.target.value) })}
                        className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-pink-500"
                      />
                    </div>

                    {/* Position X & Y */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="text-zinc-400">X Position</span>
                          <span className="text-pink-400 font-mono font-bold">{Math.round(activeBlurShape.x)}%</span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={Math.max(0, 100 - activeBlurShape.width)}
                          value={activeBlurShape.x}
                          onChange={(e) => updateActiveBlurShape({ x: Number(e.target.value) })}
                          className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-pink-500"
                        />
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="text-zinc-400">Y Position</span>
                          <span className="text-pink-400 font-mono font-bold">{Math.round(activeBlurShape.y)}%</span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={Math.max(0, 100 - activeBlurShape.height)}
                          value={activeBlurShape.y}
                          onChange={(e) => updateActiveBlurShape({ y: Number(e.target.value) })}
                          className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-pink-500"
                        />
                      </div>
                    </div>

                    {/* Width & Height */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="text-zinc-400">Width</span>
                          <span className="text-pink-400 font-mono font-bold">{Math.round(activeBlurShape.width)}%</span>
                        </div>
                        <input
                          type="range"
                          min={4}
                          max={100}
                          value={activeBlurShape.width}
                          onChange={(e) => updateActiveBlurShape({ width: Number(e.target.value) })}
                          className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-pink-500"
                        />
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="text-zinc-400">Height</span>
                          <span className="text-pink-400 font-mono font-bold">{Math.round(activeBlurShape.height)}%</span>
                        </div>
                        <input
                          type="range"
                          min={3}
                          max={60}
                          value={activeBlurShape.height}
                          onChange={(e) => updateActiveBlurShape({ height: Number(e.target.value) })}
                          className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-pink-500"
                        />
                      </div>
                    </div>

                    {/* Delete Active Shape Button */}
                    <div className="pt-1.5">
                      <button
                        onClick={() => handleDeleteBlurShape(activeBlurShape.id)}
                        className="w-full py-1.5 px-3 rounded-lg bg-red-950/40 hover:bg-red-900/60 border border-red-800/40 text-red-300 hover:text-red-100 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete {activeBlurShape.name}</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Permanent Blur Action Button */}
                <div className="pt-2 border-t border-zinc-800">
                  <button
                    onClick={handleBurnPermanentBlur}
                    disabled={isBurningBlur || !blurShapes.some((s) => s.enabled)}
                    className="w-full py-2 px-3 rounded-lg bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500 text-white text-xs font-bold shadow-md shadow-pink-950/50 flex items-center justify-center gap-1.5 transition-all active:scale-95 disabled:opacity-50"
                  >
                    {isBurningBlur ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Rendering Video Blur...</span>
                      </>
                    ) : (
                      <>
                        <Eraser className="w-3.5 h-3.5" />
                        <span>
                          Burn All Blur Shapes ({blurShapes.filter((s) => s.enabled).length}) to Video
                        </span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Logo / Image Overlay Button */}
          <button
            onClick={() => setShowLogoTools(true)}
            className="h-7 flex items-center gap-1.5 px-2.5 rounded-lg text-[11px] font-medium bg-[#181a20] hover:bg-[#22252e] text-zinc-300 hover:text-white border border-[#262933] hover:border-[#3b4050] transition-all cursor-pointer shrink-0"
            title="Add Image or Brand Logo Watermark Overlay"
          >
            <ImageIcon className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
            <span>Logo</span>
          </button>

          {/* Fullscreen */}
          <button
            onClick={toggleFullscreen}
            className="h-7 w-7 rounded-lg bg-[#181a20] hover:bg-[#22252e] text-zinc-400 hover:text-white border border-[#262933] hover:border-[#3b4050] flex items-center justify-center transition-all cursor-pointer shrink-0"
            title="Fullscreen"
          >
            {isFullscreen ? <Minimize className="w-3.5 h-3.5" /> : <Maximize className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Main Canvas Viewport Area */}
      <div
        className="flex-1 relative bg-black flex items-center justify-center p-3 overflow-hidden"
        onClick={() => setSelectedCaptionId(null)}
      >
        {/* Canvas Frame matching aspect ratio */}
        <div
          className="relative flex items-center justify-center max-w-full max-h-full rounded-lg shadow-2xl bg-zinc-950 border border-zinc-800/80 overflow-hidden"
          style={{
            aspectRatio: ratioConfig.ratio,
            transform:
              zoomLevel === '50%'
                ? 'scale(0.5)'
                : zoomLevel === '75%'
                ? 'scale(0.75)'
                : zoomLevel === '100%'
                ? 'scale(1.0)'
                : zoomLevel === '125%'
                ? 'scale(1.25)'
                : zoomLevel === '150%'
                ? 'scale(1.5)'
                : zoomLevel === '200%'
                ? 'scale(2.0)'
                : 'none',
            transition: 'transform 0.2s ease-out, aspect-ratio 0.3s ease-out',
          }}
        >
          {/* Video element */}
          <video
            ref={videoRef}
            src={videoSrc}
            className={`w-full h-full object-contain pointer-events-auto cursor-pointer transition-opacity duration-150 ${
              isVideoVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            style={{ filter: activeFilterStyle }}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedCaptionId(null);
              togglePlay();
            }}
            preload="metadata"
          />

          {/* Hidden Video Track Placeholder */}
          {!isVideoVisible && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950/90 text-zinc-500 gap-2 select-none">
              <EyeOff className="w-8 h-8 opacity-40 text-red-400" />
              <span className="text-xs font-mono font-medium tracking-wide">Video Track (V1) Hidden</span>
            </div>
          )}

          {/* Active Freeze Frame Overlay */}
          {(() => {
            const freezeSeg = currentProject?.segments?.find(
              (s) => (s.speaker === 'Freeze' || s.voice_profile === 'freeze' || s.text.includes('Freeze Frame')) &&
                     currentTime >= s.start_time && currentTime <= s.end_time
            );
            if (!freezeSeg) return null;
            return (
              <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center">
                {freezeSeg.audio_url && (
                  <img
                    src={freezeSeg.audio_url}
                    alt="Frozen Frame Snapshot"
                    className="w-full h-full object-contain pointer-events-none"
                  />
                )}
                <div className="absolute top-4 left-4 flex items-center gap-1.5 px-3 py-1 rounded-full bg-cyan-950/80 border border-cyan-400/60 text-cyan-300 text-xs font-bold backdrop-blur-md shadow-lg shadow-cyan-950/50">
                  <Snowflake className="w-3.5 h-3.5 text-cyan-400 animate-spin" style={{ animationDuration: '6s' }} />
                  <span>FREEZE FRAME</span>
                </div>
              </div>
            );
          })()}

          {/* Video Blur Shape Masks Overlay (Multiple Shapes) */}
          {blurShapes
            .filter((s) => s.enabled)
            .map((shape) => {
              const isSelected = shape.id === activeBlurShapeId;
              return (
                <div
                  key={shape.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveBlurShapeId(shape.id);
                  }}
                  className={`absolute z-20 group/blur cursor-move transition-shadow select-none ${
                    isSelected
                      ? 'ring-2 ring-pink-500 shadow-xl shadow-pink-500/30'
                      : 'border border-dashed border-white/50 hover:border-pink-400/90'
                  }`}
                  style={{
                    left: `${shape.x}%`,
                    top: `${shape.y}%`,
                    width: `${shape.width}%`,
                    height: `${shape.height}%`,
                    borderRadius: `${shape.borderRadius}px`,
                    backdropFilter: `blur(${shape.blurRadius}px)`,
                    WebkitBackdropFilter: `blur(${shape.blurRadius}px)`,
                    backgroundColor: `rgba(0, 0, 0, ${shape.opacity * 0.7})`,
                    touchAction: 'none',
                  }}
                  onMouseDown={(e) => {
                    // Only initiate drag if clicking the box body, not resize handles
                    if ((e.target as HTMLElement).dataset.resizeHandle) return;
                    e.stopPropagation();
                    e.preventDefault();
                    setActiveBlurShapeId(shape.id);
                    const container = e.currentTarget.parentElement;
                    if (!container) return;
                    const rect = container.getBoundingClientRect();
                    const startX = e.clientX;
                    const startY = e.clientY;
                    const origX = shape.x;
                    const origY = shape.y;
                    let lastX = origX;
                    let lastY = origY;

                    const onMove = (me: MouseEvent) => {
                      const dx = ((me.clientX - startX) / rect.width) * 100;
                      const dy = ((me.clientY - startY) / rect.height) * 100;
                      lastX = Math.max(0, Math.min(100 - shape.width, origX + dx));
                      lastY = Math.max(0, Math.min(100 - shape.height, origY + dy));

                      setBlurShapes((prev) =>
                        prev.map((s) =>
                          s.id === shape.id
                            ? {
                                ...s,
                                x: Math.round(lastX * 10) / 10,
                                y: Math.round(lastY * 10) / 10,
                              }
                            : s
                        )
                      );
                    };

                    const onUp = () => {
                      window.removeEventListener('mousemove', onMove);
                      window.removeEventListener('mouseup', onUp);
                      setBlurShapes((prev) => {
                        const finalUpdated = prev.map((s) =>
                          s.id === shape.id
                            ? {
                                ...s,
                                x: Math.round(lastX * 10) / 10,
                                y: Math.round(lastY * 10) / 10,
                              }
                            : s
                        );
                        saveBlurShapes(finalUpdated);
                        return finalUpdated;
                      });
                    };

                    window.addEventListener('mousemove', onMove);
                    window.addEventListener('mouseup', onUp);
                  }}
                >
                  {/* Drag hint badge + Quick Delete */}
                  <div
                    className={`absolute -top-6 left-0 px-2 py-0.5 rounded bg-black/90 text-[10px] text-zinc-200 font-mono flex items-center gap-1.5 shadow-lg z-30 transition-opacity ${
                      isSelected ? 'opacity-100' : 'opacity-0 group-hover/blur:opacity-100'
                    }`}
                  >
                    <Eraser className="w-3 h-3 text-pink-400" />
                    <span>{shape.name}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        handleDeleteBlurShape(shape.id);
                      }}
                      className="ml-1 p-0.5 text-zinc-400 hover:text-red-400 rounded transition-colors cursor-pointer"
                      title="Delete this blur box"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>

                  {/* Corner & Edge Resize Handles (Active / Hover) */}
                  {isSelected && (
                    <>
                      {/* Bottom-Right Corner Handle */}
                      <div
                        data-resize-handle="se"
                        className="absolute -bottom-1.5 -right-1.5 w-4 h-4 cursor-se-resize flex items-center justify-center z-30"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          const container = (e.currentTarget.parentElement?.parentElement as HTMLElement) || null;
                          if (!container) return;
                          const rect = container.getBoundingClientRect();
                          const startX = e.clientX;
                          const startY = e.clientY;
                          const origW = shape.width;
                          const origH = shape.height;
                          let lastW = origW;
                          let lastH = origH;

                          const onResizeMove = (me: MouseEvent) => {
                            const dw = ((me.clientX - startX) / rect.width) * 100;
                            const dh = ((me.clientY - startY) / rect.height) * 100;
                            lastW = Math.max(4, Math.min(100 - shape.x, origW + dw));
                            lastH = Math.max(2, Math.min(100 - shape.y, origH + dh));

                            setBlurShapes((prev) =>
                              prev.map((s) =>
                                s.id === shape.id
                                  ? {
                                      ...s,
                                      width: Math.round(lastW * 10) / 10,
                                      height: Math.round(lastH * 10) / 10,
                                    }
                                  : s
                              )
                            );
                          };

                          const onResizeUp = () => {
                            window.removeEventListener('mousemove', onResizeMove);
                            window.removeEventListener('mouseup', onResizeUp);
                            setBlurShapes((prev) => {
                              const finalUpdated = prev.map((s) =>
                                s.id === shape.id
                                  ? {
                                      ...s,
                                      width: Math.round(lastW * 10) / 10,
                                      height: Math.round(lastH * 10) / 10,
                                    }
                                  : s
                              );
                              saveBlurShapes(finalUpdated);
                              return finalUpdated;
                            });
                          };

                          window.addEventListener('mousemove', onResizeMove);
                          window.addEventListener('mouseup', onResizeUp);
                        }}
                      >
                        <div className="w-3 h-3 bg-pink-500 rounded-sm border border-white shadow-md hover:scale-125 transition-transform" />
                      </div>

                      {/* Bottom Edge Handle */}
                      <div
                        data-resize-handle="s"
                        className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-8 h-3 cursor-s-resize flex items-center justify-center z-30"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          const container = (e.currentTarget.parentElement?.parentElement as HTMLElement) || null;
                          if (!container) return;
                          const rect = container.getBoundingClientRect();
                          const startY = e.clientY;
                          const origH = shape.height;
                          let lastH = origH;

                          const onResizeMove = (me: MouseEvent) => {
                            const dh = ((me.clientY - startY) / rect.height) * 100;
                            lastH = Math.max(2, Math.min(100 - shape.y, origH + dh));

                            setBlurShapes((prev) =>
                              prev.map((s) =>
                                s.id === shape.id
                                  ? {
                                      ...s,
                                      height: Math.round(lastH * 10) / 10,
                                    }
                                  : s
                              )
                            );
                          };

                          const onResizeUp = () => {
                            window.removeEventListener('mousemove', onResizeMove);
                            window.removeEventListener('mouseup', onResizeUp);
                            setBlurShapes((prev) => {
                              const finalUpdated = prev.map((s) =>
                                s.id === shape.id
                                  ? {
                                      ...s,
                                      height: Math.round(lastH * 10) / 10,
                                    }
                                  : s
                              );
                              saveBlurShapes(finalUpdated);
                              return finalUpdated;
                            });
                          };

                          window.addEventListener('mousemove', onResizeMove);
                          window.addEventListener('mouseup', onResizeUp);
                        }}
                      >
                        <div className="w-6 h-1.5 bg-pink-500 rounded-full border border-white shadow-md" />
                      </div>

                      {/* Right Edge Handle */}
                      <div
                        data-resize-handle="e"
                        className="absolute -right-1 top-1/2 -translate-y-1/2 w-3 h-8 cursor-e-resize flex items-center justify-center z-30"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          const container = (e.currentTarget.parentElement?.parentElement as HTMLElement) || null;
                          if (!container) return;
                          const rect = container.getBoundingClientRect();
                          const startX = e.clientX;
                          const origW = shape.width;
                          let lastW = origW;

                          const onResizeMove = (me: MouseEvent) => {
                            const dw = ((me.clientX - startX) / rect.width) * 100;
                            lastW = Math.max(4, Math.min(100 - shape.x, origW + dw));

                            setBlurShapes((prev) =>
                              prev.map((s) =>
                                s.id === shape.id
                                  ? {
                                      ...s,
                                      width: Math.round(lastW * 10) / 10,
                                    }
                                  : s
                              )
                            );
                          };

                          const onResizeUp = () => {
                            window.removeEventListener('mousemove', onResizeMove);
                            window.removeEventListener('mouseup', onResizeUp);
                            setBlurShapes((prev) => {
                              const finalUpdated = prev.map((s) =>
                                s.id === shape.id
                                  ? {
                                      ...s,
                                      width: Math.round(lastW * 10) / 10,
                                    }
                                  : s
                              );
                              saveBlurShapes(finalUpdated);
                              return finalUpdated;
                            });
                          };

                          window.addEventListener('mousemove', onResizeMove);
                          window.addEventListener('mouseup', onResizeUp);
                        }}
                      >
                        <div className="w-1.5 h-6 bg-pink-500 rounded-full border border-white shadow-md" />
                      </div>
                    </>
                  )}
                </div>
              );
            })}


          {/* Styled Interactive Subtitle Overlay */}
          {isSubtitlesVisible && (() => {
            const seg = findActiveSegmentAtTime(currentProject?.segments, currentTime, clipLayout);
            if (!seg?.text || seg.speaker === 'Freeze' || seg.voice_profile === 'freeze' || seg.text.includes('Freeze Frame')) return null;
            const isSel = !isPlaying && selectedCaptionId === seg.id;
            return (
              <div
                className="absolute inset-0 flex flex-col justify-end p-4 pointer-events-none"
                style={{
                  transform: `translate(${overlayPos.x}px, ${overlayPos.y}px) scale(${overlayScale})`,
                }}
              >
                <SubtitleOverlay
                  text={seg.text}
                  style={subtitleStyle}
                  frameHeight={containerRef.current?.clientHeight || 360}
                  segmentId={seg.id}
                  currentTime={currentTime}
                  segmentStart={seg.start_time}
                  segmentEnd={seg.end_time}
                  isSelected={isSel}
                  onSelect={() => {
                    setSelectedCaptionId(seg.id);
                    setActiveSegment(seg.id);
                  }}
                  onChangeStyle={(newStyle) => setSubtitleStyle(newStyle)}
                  onUpdateText={(newText) => updateSegment(seg.id, { text: newText })}
                  onToggleVisible={toggleSubtitlesVisible}
                  onDeleteSegment={() => deleteSegment(seg.id)}
                  isSubtitlesVisible={isSubtitlesVisible}
                />
              </div>
            );
          })()}

          {/* Center Play Overlay on Pause */}
          {!isPlaying && (
            <div
              className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 group-hover/player:opacity-100 transition-opacity"
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  togglePlay();
                }}
                className="w-14 h-14 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center text-white shadow-xl hover:scale-110 active:scale-95 transition-transform pointer-events-auto cursor-pointer"
                title="Play Video"
              >
                <Play className="w-7 h-7 ml-1" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Playback Transport Controls */}
      <div className="px-3 py-2 bg-zinc-900/95 border-t border-zinc-800 shrink-0 flex flex-col gap-1.5">
        {/* Scrubber Bar */}
        {(() => {
          const maxDur = duration;
          return (
            <div
              className="w-full px-1 group/seek relative flex items-center h-4 cursor-pointer"
              onPointerDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                const t = ratio * maxDur;
                setIsSeeking(true);
                seekValueRef.current = t;
                wasPlayingRef.current = !videoRef.current?.paused;
                if (videoRef.current && !videoRef.current.paused) videoRef.current.pause();
                seekToTimelineTime(t);
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!isSeeking) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                const t = ratio * maxDur;
                seekValueRef.current = t;
                seekToTimelineTime(t);
              }}
              onPointerUp={() => {
                const t = seekValueRef.current;
                seekValueRef.current = null;
                setIsSeeking(false);
                if (t !== null) seekToTimelineTime(t);
                if (wasPlayingRef.current && videoRef.current) videoRef.current.play();
              }}
            >
              <div className="absolute left-0 right-0 h-1 bg-zinc-800 rounded-full group-hover/seek:h-1.5 transition-all" />
              <div
                ref={fillRef}
                className="absolute left-0 h-1 bg-gradient-to-r from-pink-500 to-purple-600 rounded-full group-hover/seek:h-1.5 transition-all pointer-events-none"
                style={{ width: '0%' }}
              />
              <div
                ref={thumbRef}
                className="absolute w-3.5 h-3.5 bg-white rounded-full shadow-lg pointer-events-none opacity-0 group-hover/seek:opacity-100 transition-opacity ring-2 ring-pink-500/50"
                style={{ left: 'calc(0% - 7px)' }}
              />
            </div>
          );
        })()}

      </div>

      {/* Dedicated Logo & Image Overlay Modal */}
      <LogoOverlayModal open={showLogoTools} onClose={() => setShowLogoTools(false)} videoRef={videoRef} />
    </div>
  );
}
