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
} from 'lucide-react';
import { blurVideoRegion } from '../api/client';
import { buildClipLayout, sourceToTimeline, timelineToSource, totalTimelineDuration, findClipAtTimelineTime } from '../utils/clipTimemap';
import SubtitleOverlay from './SubtitleOverlay';

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
export function findActiveSegmentAtTime(segments: any[] | undefined, time: number): any | null {
  if (!segments || segments.length === 0) return null;
  const filtered = segments.filter(
    (s) => s.speaker !== 'Freeze' && s.voice_profile !== 'freeze' && !(s.text && s.text.includes('Freeze Frame'))
  );
  if (filtered.length === 0) return null;

  // 1. Strict half-open interval [start_time, end_time)
  const strict = filtered.find((s) => time >= s.start_time && time < s.end_time);
  if (strict) return strict;

  // 2. Exact match at start_time (or within 0.05s after start_time)
  const startMatch = filtered.find((s) => Math.abs(time - s.start_time) < 0.05);
  if (startMatch) return startMatch;

  // 3. Fallback: boundary check with small tolerance
  const boundaryMatch = filtered.find((s) => time >= s.start_time - 0.02 && time <= s.end_time);
  return boundaryMatch || null;
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

  // Blur Shape / Watermark Mask State
  const [blurMask, setBlurMask] = useState<{
    enabled: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    blurRadius: number;
    opacity: number;
    borderRadius: number;
  }>({
    enabled: false,
    x: 0,
    y: 82,
    width: 100,
    height: 16,
    blurRadius: 24,
    opacity: 0.75,
    borderRadius: 0,
  });
  const [isBurningBlur, setIsBurningBlur] = useState(false);
  const blurCanvasRef = useRef<HTMLCanvasElement>(null);
  const blurAnimFrameRef = useRef<number | null>(null);

  // Drag state for blur shape repositioning
  const blurDragRef = useRef<{ dragging: boolean; startX: number; startY: number; origX: number; origY: number } | null>(null);

  // Continuously paint blurred video frames into the canvas overlay
  useEffect(() => {
    if (!blurMask.enabled) {
      if (blurAnimFrameRef.current) cancelAnimationFrame(blurAnimFrameRef.current);
      blurAnimFrameRef.current = null;
      return;
    }
    const video = videoRef.current;
    const canvas = blurCanvasRef.current;
    if (!video || !canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId: number;
    const paint = () => {
      if (!video.paused || true) { // always repaint when enabled
        const cw = canvas.width;
        const ch = canvas.height;
        // Source rectangle: the portion of the video corresponding to the mask
        const sx = (blurMask.x / 100) * video.videoWidth;
        const sy = (blurMask.y / 100) * video.videoHeight;
        const sw = (blurMask.width / 100) * video.videoWidth;
        const sh = (blurMask.height / 100) * video.videoHeight;
        try {
          ctx.save();
          ctx.filter = `blur(${blurMask.blurRadius}px)`;
          ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch);
          ctx.restore();
          // Tint overlay
          ctx.fillStyle = `rgba(0, 0, 0, ${blurMask.opacity * 0.6})`;
          ctx.fillRect(0, 0, cw, ch);
        } catch {
          // video not ready yet
        }
      }
      rafId = requestAnimationFrame(paint);
    };

    rafId = requestAnimationFrame(paint);
    blurAnimFrameRef.current = rafId;
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [blurMask, videoRef]);

  const handleBurnPermanentBlur = async () => {
    if (!currentProject || isBurningBlur) return;
    setIsBurningBlur(true);
    try {
      const vid = videoRef.current;
      const w = vid?.videoWidth || 1280;
      const h = vid?.videoHeight || 720;

      const pxX = Math.round((blurMask.x / 100) * w);
      const pxY = Math.round((blurMask.y / 100) * h);
      const pxW = Math.max(4, Math.round((blurMask.width / 100) * w));
      const pxH = Math.max(4, Math.round((blurMask.height / 100) * h));

      await blurVideoRegion(currentProject.id, pxX, pxY, pxW, pxH);
      await loadProject(currentProject.id);
      if (videoRef.current) {
        videoRef.current.load();
      }
      setBlurMask((prev) => ({ ...prev, enabled: false }));
      setShowBlurDropdown(false);
      alert('Permanent blur applied successfully to video!');
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
      const currentTlTime = timelineTimeRef.current;
      const currentEntry = findClipAtTimelineTime(clipLayout, currentTlTime) || clipLayout[0];
      const currentIdx = clipLayout.indexOf(currentEntry);
      const totalDur = totalTimelineDuration(videoClips);

      // Verify srcTime is within reasonable range of current clip to avoid asynchronous seek lag triggers
      if (srcTime < currentEntry.clip.source_start - 0.5 || srcTime > currentEntry.clip.source_end + 1.0) {
        // Find if srcTime corresponds to ANY clip on the timeline (e.g. user clicked a segment in another clip)
        const matchingEntry = clipLayout.find(
          (entry) => srcTime >= entry.clip.source_start - 0.1 && srcTime <= entry.clip.source_end + 0.1
        );
        if (matchingEntry) {
          const offsetInClip = Math.max(0, srcTime - matchingEntry.clip.source_start);
          const newTl = Math.min(matchingEntry.timelineEnd, matchingEntry.timelineStart + offsetInClip);
          timelineTimeRef.current = newTl;
          setCurrentTime(newTl);
          updateProgressBar(newTl);
          const seg = findActiveSegmentAtTime(currentProject?.segments, newTl);
          setActiveSegment(seg?.id || null);
          return;
        }

        const expectedSrc = currentEntry.clip.source_start + Math.max(0, currentTlTime - currentEntry.timelineStart);
        if (Math.abs(video.currentTime - expectedSrc) > 0.05) {
          video.currentTime = expectedSrc;
        }
        return;
      }

      // Check if video reached or exceeded the end of current clip's source range
      if (srcTime >= currentEntry.clip.source_end - 0.05) {
        if (currentIdx < clipLayout.length - 1) {
          // Jump immediately to start of next clip
          const nextEntry = clipLayout[currentIdx + 1];
          video.currentTime = nextEntry.clip.source_start;
          timelineTimeRef.current = nextEntry.timelineStart;
          setCurrentTime(nextEntry.timelineStart);
          updateProgressBar(nextEntry.timelineStart);
          return;
        } else if (currentTlTime >= totalDur - 0.15) {
          // Reached end of all clips on timeline
          video.pause();
          timelineTimeRef.current = totalDur;
          setCurrentTime(totalDur);
          updateProgressBar(totalDur);
          setIsPlaying(false);
          return;
        }
      }

      // Inside the current clip: map smoothly to timeline
      const offsetInClip = Math.max(0, srcTime - currentEntry.clip.source_start);
      const newTlTime = Math.min(currentEntry.timelineEnd, currentEntry.timelineStart + offsetInClip);

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
      className="flex flex-col bg-zinc-950 border-b border-zinc-800 overflow-hidden select-none relative group/player h-full"
    >
      {/* Top Viewport Header Toolbar */}
      <div className="px-3 py-1.5 bg-zinc-900/90 border-b border-zinc-800/80 flex items-center justify-between shrink-0 text-xs text-zinc-300 z-10">
        {/* Aspect Ratio Switcher */}
        <div className="relative">
          <button
            onClick={() => {
              setShowRatioDropdown(!showRatioDropdown);
              setShowFilterDropdown(false);
              setShowSpeedDropdown(false);
            }}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors text-[11px] font-semibold"
          >
            <Ratio className="w-3.5 h-3.5 text-pink-400" />
            <span>{selectedRatio}</span>
            <ChevronDown className="w-3 h-3 text-zinc-400" />
          </button>

          {showRatioDropdown && (
            <div className="absolute left-0 top-full mt-1 w-44 bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl py-1 z-50">
              {ASPECT_RATIOS.map((r) => (
                <button
                  key={r.id}
                  onClick={() => {
                    setAspectRatio(r.id);
                    setShowRatioDropdown(false);
                  }}
                  className={`w-full px-3 py-1.5 text-left text-xs flex items-center justify-between hover:bg-zinc-800 transition-colors ${
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

        {/* Right Tools: Zoom, Filter, Fullscreen */}
        <div className="flex items-center gap-1.5">
          {/* Visual Filters Dropdown */}
          <div className="relative">
            <button
              onClick={() => {
                setShowFilterDropdown(!showFilterDropdown);
                setShowRatioDropdown(false);
                setShowSpeedDropdown(false);
              }}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors ${
                activeFilter !== 'none' ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
              }`}
              title="Visual Color Filters & LUTs"
            >
              <Sparkles className="w-3 h-3 text-purple-400" />
              <span>{FILTER_PRESETS.find((f) => f.id === activeFilter)?.name || 'Filter'}</span>
            </button>

            {showFilterDropdown && (
              <div className="absolute right-0 top-full mt-1 w-44 bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl py-1 z-50">
                {FILTER_PRESETS.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => {
                      setActiveFilter(f.id);
                      setShowFilterDropdown(false);
                    }}
                    className={`w-full px-3 py-1.5 text-left text-xs flex items-center justify-between hover:bg-zinc-800 transition-colors ${
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
          <div className="relative">
            <button
              onClick={() => {
                setShowBlurDropdown(!showBlurDropdown);
                setShowFilterDropdown(false);
                setShowRatioDropdown(false);
                setShowCanvasZoomDropdown(false);
                setShowSpeedDropdown(false);
              }}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors ${
                blurMask.enabled
                  ? 'bg-pink-600 text-white shadow-md shadow-pink-950/40 font-semibold'
                  : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
              }`}
              title="Blur text / subtitles on original video"
            >
              <Eraser className="w-3 h-3 text-pink-300" />
              <span>Blur Shape</span>
            </button>

            {showBlurDropdown && (
              <div className="absolute right-0 top-full mt-1 w-72 bg-zinc-900/98 border border-zinc-800 rounded-xl shadow-2xl p-3 z-50 backdrop-blur-md space-y-3">
                {/* Toggle ON/OFF */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-semibold text-xs text-white">
                    <Eraser className="w-3.5 h-3.5 text-pink-400" />
                    <span>Video Blur Shape Mask</span>
                  </div>
                  <button
                    onClick={() => setBlurMask({ ...blurMask, enabled: !blurMask.enabled })}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${
                      blurMask.enabled
                        ? 'bg-pink-600 text-white shadow-md'
                        : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {blurMask.enabled ? 'ON' : 'OFF'}
                  </button>
                </div>

                {/* Presets */}
                <div className="space-y-1">
                  <span className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">Presets</span>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => setBlurMask({ ...blurMask, enabled: true, x: 0, y: 82, width: 100, height: 16, borderRadius: 0 })}
                      className="px-2 py-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 text-[11px] text-left transition-colors flex items-center gap-1.5"
                    >
                      <span>🔤</span>
                      <span className="truncate">Bottom Subtitles</span>
                    </button>
                    <button
                      onClick={() => setBlurMask({ ...blurMask, enabled: true, x: 10, y: 84, width: 80, height: 12, borderRadius: 12 })}
                      className="px-2 py-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 text-[11px] text-left transition-colors flex items-center gap-1.5"
                    >
                      <span>💬</span>
                      <span className="truncate">Compact Box</span>
                    </button>
                    <button
                      onClick={() => setBlurMask({ ...blurMask, enabled: true, x: 74, y: 4, width: 22, height: 10, borderRadius: 8 })}
                      className="px-2 py-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 text-[11px] text-left transition-colors flex items-center gap-1.5"
                    >
                      <span>🏷️</span>
                      <span className="truncate">Top-Right Logo</span>
                    </button>
                    <button
                      onClick={() => setBlurMask({ ...blurMask, enabled: true, x: 4, y: 4, width: 22, height: 10, borderRadius: 8 })}
                      className="px-2 py-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 text-[11px] text-left transition-colors flex items-center gap-1.5"
                    >
                      <span>🏷️</span>
                      <span className="truncate">Top-Left Logo</span>
                    </button>
                  </div>
                </div>

                {/* Blur Radius Slider */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-zinc-400">Blur Strength</span>
                    <span className="text-pink-400 font-mono font-bold">{blurMask.blurRadius}px</span>
                  </div>
                  <input
                    type="range"
                    min={4}
                    max={50}
                    value={blurMask.blurRadius}
                    onChange={(e) => setBlurMask({ ...blurMask, blurRadius: Number(e.target.value) })}
                    className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-pink-500"
                  />
                </div>

                {/* Dark Tint Opacity Slider */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-zinc-400">Tint Darkness</span>
                    <span className="text-pink-400 font-mono font-bold">{Math.round(blurMask.opacity * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={blurMask.opacity}
                    onChange={(e) => setBlurMask({ ...blurMask, opacity: Number(e.target.value) })}
                    className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-pink-500"
                  />
                </div>

                {/* Position X & Y Sliders */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-zinc-400">Position X</span>
                      <span className="text-pink-400 font-mono font-bold">{Math.round(blurMask.x)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, 100 - blurMask.width)}
                      value={blurMask.x}
                      onChange={(e) => setBlurMask({ ...blurMask, x: Number(e.target.value) })}
                      className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-pink-500"
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-zinc-400">Position Y</span>
                      <span className="text-pink-400 font-mono font-bold">{Math.round(blurMask.y)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, 100 - blurMask.height)}
                      value={blurMask.y}
                      onChange={(e) => setBlurMask({ ...blurMask, y: Number(e.target.value) })}
                      className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-pink-500"
                    />
                  </div>
                </div>

                {/* Width & Height Sliders */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-zinc-400">Width</span>
                      <span className="text-pink-400 font-mono font-bold">{Math.round(blurMask.width)}%</span>
                    </div>
                    <input
                      type="range"
                      min={4}
                      max={100}
                      value={blurMask.width}
                      onChange={(e) => setBlurMask({ ...blurMask, width: Number(e.target.value) })}
                      className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-pink-500"
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-zinc-400">Height</span>
                      <span className="text-pink-400 font-mono font-bold">{Math.round(blurMask.height)}%</span>
                    </div>
                    <input
                      type="range"
                      min={3}
                      max={60}
                      value={blurMask.height}
                      onChange={(e) => setBlurMask({ ...blurMask, height: Number(e.target.value) })}
                      className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-pink-500"
                    />
                  </div>
                </div>

                {/* Corner Roundness */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-zinc-400">Corner Radius</span>
                    <span className="text-pink-400 font-mono font-bold">{blurMask.borderRadius}px</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={32}
                    value={blurMask.borderRadius}
                    onChange={(e) => setBlurMask({ ...blurMask, borderRadius: Number(e.target.value) })}
                    className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-pink-500"
                  />
                </div>

                {/* Permanent Blur Action Button */}
                <div className="pt-2 border-t border-zinc-800">
                  <button
                    onClick={handleBurnPermanentBlur}
                    disabled={isBurningBlur}
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
                        <span>Burn Blur Permanently to Video</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Fullscreen */}
          <button
            onClick={toggleFullscreen}
            className="p-1 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
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

          {/* Video Blur Shape Mask Overlay — canvas-based blur (works on <video> elements) */}
          {blurMask.enabled && (
            <div
              className="absolute z-20 group/blur cursor-move"
              style={{
                left: `${blurMask.x}%`,
                top: `${blurMask.y}%`,
                width: `${blurMask.width}%`,
                height: `${blurMask.height}%`,
                borderRadius: `${blurMask.borderRadius}px`,
                overflow: 'hidden',
                boxShadow: '0 0 0 1px rgba(255,255,255,0.15), 0 4px 20px rgba(0,0,0,0.5)',
                userSelect: 'none',
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                const container = e.currentTarget.parentElement;
                if (!container) return;
                const rect = container.getBoundingClientRect();
                blurDragRef.current = {
                  dragging: true,
                  startX: e.clientX,
                  startY: e.clientY,
                  origX: blurMask.x,
                  origY: blurMask.y,
                };
                const onMove = (me: MouseEvent) => {
                  if (!blurDragRef.current?.dragging) return;
                  const dx = ((me.clientX - blurDragRef.current.startX) / rect.width) * 100;
                  const dy = ((me.clientY - blurDragRef.current.startY) / rect.height) * 100;
                  setBlurMask((prev) => ({
                    ...prev,
                    x: Math.max(0, Math.min(100 - prev.width, blurDragRef.current!.origX + dx)),
                    y: Math.max(0, Math.min(100 - prev.height, blurDragRef.current!.origY + dy)),
                  }));
                };
                const onUp = () => {
                  blurDragRef.current = null;
                  window.removeEventListener('mousemove', onMove);
                  window.removeEventListener('mouseup', onUp);
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
              }}
            >
              {/* Canvas renders blurred video frames directly */}
              <canvas
                ref={blurCanvasRef}
                width={200}
                height={80}
                className="absolute inset-0 w-full h-full"
                style={{ borderRadius: `${blurMask.borderRadius}px` }}
              />
              {/* Drag hint badge */}
              <div className="absolute top-1 left-2 px-1.5 py-0.5 rounded bg-black/80 text-[9px] text-zinc-300 font-mono opacity-0 group-hover/blur:opacity-100 transition-opacity pointer-events-none flex items-center gap-1">
                <Eraser className="w-2.5 h-2.5 text-pink-400" />
                <span>Blur Shape · Drag to move</span>
              </div>

              {/* Corner resize handle */}
              <div
                className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize flex items-center justify-center opacity-0 group-hover/blur:opacity-100 transition-opacity z-10"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const container = e.currentTarget.parentElement?.parentElement;
                  if (!container) return;
                  const rect = container.getBoundingClientRect();
                  const startX = e.clientX;
                  const startY = e.clientY;
                  const origW = blurMask.width;
                  const origH = blurMask.height;
                  const onResizeMove = (me: MouseEvent) => {
                    const dw = ((me.clientX - startX) / rect.width) * 100;
                    const dh = ((me.clientY - startY) / rect.height) * 100;
                    setBlurMask((prev) => ({
                      ...prev,
                      width: Math.max(4, Math.min(100 - prev.x, origW + dw)),
                      height: Math.max(3, Math.min(100 - prev.y, origH + dh)),
                    }));
                  };
                  const onResizeUp = () => {
                    window.removeEventListener('mousemove', onResizeMove);
                    window.removeEventListener('mouseup', onResizeUp);
                  };
                  window.addEventListener('mousemove', onResizeMove);
                  window.addEventListener('mouseup', onResizeUp);
                }}
              >
                <div className="w-2.5 h-2.5 bg-pink-500 rounded-sm border border-white shadow-md" />
              </div>
            </div>
          )}


          {/* Styled Interactive Subtitle Overlay */}
          {isSubtitlesVisible && (() => {
            let effectiveSourceTime = currentTime;
            if (clipLayout.length > 0) {
              const res = timelineToSource(clipLayout, currentTime);
              if (res) effectiveSourceTime = res.sourceTime;
            } else if (videoRef.current) {
              effectiveSourceTime = videoRef.current.currentTime;
            }

            const seg = findActiveSegmentAtTime(currentProject?.segments, effectiveSourceTime);
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

        {/* Controls Bar */}
        <div className="flex items-center justify-between gap-2 px-2 py-1">
          {/* Left: Time indicator */}
          <div className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-400">
            <span className="text-pink-400 font-semibold">{formatTimecode(currentTime)}</span>
            <span className="text-zinc-600">/</span>
            <span>{formatTimecode(duration)}</span>
          </div>

          {/* Right: Speed, Volume, Loop */}
          <div className="flex items-center gap-3 justify-end">
            {/* Speed selector */}
            <div className="relative">
              <button
                onClick={() => {
                  setShowSpeedDropdown(!showSpeedDropdown);
                  setShowFilterDropdown(false);
                  setShowRatioDropdown(false);
                  setShowCanvasZoomDropdown(false);
                }}
                className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors ${
                  playbackRate !== 1.0
                    ? 'bg-pink-500/20 text-pink-300 border border-pink-500/40 font-bold'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                }`}
                title="Playback Speed"
              >
                {playbackRate}x
              </button>

              {showSpeedDropdown && (
                <div className="absolute right-0 bottom-full mb-1 w-52 bg-zinc-900/98 border border-zinc-800 rounded-xl shadow-2xl p-2.5 z-50 backdrop-blur-md">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-semibold text-zinc-300">Speed</span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleSpeedChange(playbackRate - 0.05)}
                        className="w-5 h-5 flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono"
                        title="-0.05x"
                      >
                        -
                      </button>
                      <span className="text-xs font-mono font-bold text-pink-400 min-w-[36px] text-center">
                        {playbackRate.toFixed(2)}x
                      </span>
                      <button
                        onClick={() => handleSpeedChange(playbackRate + 0.05)}
                        className="w-5 h-5 flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono"
                        title="+0.05x"
                      >
                        +
                      </button>
                    </div>
                  </div>

                  {/* Slider */}
                  <input
                    type="range"
                    min={0.25}
                    max={2.0}
                    step={0.05}
                    value={playbackRate}
                    onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
                    className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-pink-500 mb-2"
                  />

                  {/* Presets Grid */}
                  <div className="grid grid-cols-4 gap-1 pt-1 border-t border-zinc-800/80">
                    {[0.5, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0, 1.25].map((spd) => (
                      <button
                        key={spd}
                        onClick={() => {
                          handleSpeedChange(spd);
                          setShowSpeedDropdown(false);
                        }}
                        className={`py-1 rounded text-[10px] font-mono text-center transition-colors ${
                          playbackRate === spd
                            ? 'bg-pink-500 text-white font-bold'
                            : 'bg-zinc-800/70 hover:bg-zinc-700 text-zinc-300'
                        }`}
                      >
                        {spd}x
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Volume Control */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={toggleMute}
                className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200 transition-colors"
                title={muted || volume === 0 ? 'Unmute (M)' : 'Mute (M)'}
              >
                {muted || volume === 0 ? (
                  <VolumeX className="w-4 h-4 text-red-400" />
                ) : (
                  <Volume2 className="w-4 h-4" />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={muted ? 0 : volume}
                onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                className="w-16 h-1.5 accent-pink-500 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                title={`Volume: ${Math.round((muted ? 0 : volume) * 100)}%`}
              />
            </div>

            {/* Loop */}
            <button
              onClick={() => {
                if (videoRef.current) {
                  videoRef.current.loop = !loop;
                  setLoop(!loop);
                }
              }}
              className={`p-1 rounded transition-colors ${loop ? 'text-pink-400 bg-pink-500/10' : 'text-zinc-500 hover:text-zinc-300'}`}
              title="Loop Playback"
            >
              <Repeat className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
