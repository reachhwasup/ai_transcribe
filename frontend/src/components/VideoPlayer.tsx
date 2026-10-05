import { useShallow } from 'zustand/react/shallow';
import { useEffect, RefObject, useCallback, useRef, useMemo, useState } from 'react';
import { useProjectStore } from '../stores/projectStore';
import {
  Play,
  Upload,
  Maximize,
  Minimize,
  ChevronDown,
  EyeOff,
  Sparkles,
  Check,
  Snowflake,
  Eraser,
  Type,
  Image as ImageIcon,
  Pause,
  SkipBack,
  SkipForward,
  Rewind,
  FastForward,
} from 'lucide-react';
import { blurVideoRegions, uploadProjectLogo, applyVideoLogo, fetchProjectLogo, OPEN_TEXT_OVERLAYS, TEXT_OVERLAYS_CHANGED } from '../api/client';
import { BlurLayer, BlurPanel, blurAreasForExport, type BlurShape } from './player/BlurTools';
import { LogoLayer, LogoPanel, loadLogoSettings, saveLogoSettings, LOGO_SETTINGS_CHANGED, OPEN_LOGO_PANEL, type LogoSettings } from './player/LogoTools';
import { buildClipLayout, timelineToSource, totalTimelineDuration, findClipAtTimelineTime, sourceRangeToTimeline } from '../utils/clipTimemap';
import SubtitleOverlay from './SubtitleOverlay';
import TextOverlayLayer from './TextOverlayLayer';
import TextOverlayModal from './TextOverlayModal';
import SidePanel from './player/SidePanel';
import { saveProjectSetting, PROJECT_SETTINGS_SYNCED } from '../utils/projectSettings';
import { FILTER_PRESETS, DEFAULT_VIDEO_FILTER, cssFilter, isFiltered, resolveSteps, useVideoFilter } from '../utils/videoFilters';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
}

export type AspectRatioType = '16:9' | '9:16' | '1:1' | '4:5' | '21:9';

export const ASPECT_RATIOS: { id: AspectRatioType; label: string; name: string; use: string; ratio: string; w: number; h: number }[] = [
  { id: '9:16', label: '9:16 (TikTok/Reels)', name: 'Vertical', use: 'TikTok · Reels · Shorts', ratio: '9 / 16', w: 1080, h: 1920 },
  { id: '16:9', label: '16:9 (Landscape)', name: 'Landscape', use: 'YouTube · Facebook', ratio: '16 / 9', w: 1920, h: 1080 },
  { id: '1:1', label: '1:1 (Square)', name: 'Square', use: 'Instagram feed', ratio: '1 / 1', w: 1080, h: 1080 },
  { id: '4:5', label: '4:5 (Portrait)', name: 'Portrait', use: 'Instagram · Facebook feed', ratio: '4 / 5', w: 1080, h: 1350 },
  { id: '21:9', label: '21:9 (Ultrawide)', name: 'Cinematic', use: 'Wide film look', ratio: '21 / 9', w: 2560, h: 1080 },
];

/** The frame's shape, drawn small */
function ShapeIcon({ w, h, size = 16, active = false }: { w: number; h: number; size?: number; active?: boolean }) {
  const style = w >= h
    ? { width: size, height: Math.max(5, Math.round((size * h) / w)) }
    : { height: size, width: Math.max(5, Math.round((size * w) / h)) };
  return (
    <span className="flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      <span className={`block rounded-[2px] border-[1.5px] ${active ? 'border-blue-300' : 'border-zinc-400'}`} style={style} />
    </span>
  );
}

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
    subtitleStyle,
    setSubtitleStyle,
    updateSegment,
    deleteSegment,
    subtitlesVisible,
    videoVisible,
    hiddenTracks,
    toggleSubtitlesVisible,
    aspectRatio,
    setAspectRatio,
    canvasZoom,
    audioSeparated,
    videoMuted,
  } = useProjectStore(useShallow(state => ({ currentProject: state.currentProject, loadProject: state.loadProject, currentTime: state.currentTime, isPlaying: state.isPlaying, setCurrentTime: state.setCurrentTime, setIsPlaying: state.setIsPlaying, setActiveSegment: state.setActiveSegment, videoClips: state.videoClips, subtitleStyle: state.subtitleStyle, setSubtitleStyle: state.setSubtitleStyle, updateSegment: state.updateSegment, deleteSegment: state.deleteSegment, subtitlesVisible: state.subtitlesVisible, videoVisible: state.videoVisible, hiddenTracks: state.hiddenTracks, toggleSubtitlesVisible: state.toggleSubtitlesVisible, aspectRatio: state.aspectRatio, setAspectRatio: state.setAspectRatio, canvasZoom: state.canvasZoom, audioSeparated: state.audioSeparated, videoMuted: state.videoMuted })));

  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const reportPlaybackError = useCallback((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    setPlaybackError(error instanceof Error ? error.message : 'Video playback failed. Reload the video and try again.');
    setIsPlaying(false);
  }, [setIsPlaying]);

  const isVideoVisible = videoVisible && !hiddenTracks.has('V') && !hiddenTracks.has('V1');
  const isSubtitlesVisible = subtitlesVisible && !hiddenTracks.has('T') && !hiddenTracks.has('T1') && !hiddenTracks.has('T2');

  const [volume] = useState(() => {
    try {
      const saved = localStorage.getItem('player-volume');
      return saved !== null ? parseFloat(saved) : 1.0;
    } catch {
      return 1.0;
    }
  });
  const [muted] = useState(() => {
    try {
      return localStorage.getItem('player-muted') === 'true';
    } catch {
      return false;
    }
  });
  const [isSeeking, setIsSeeking] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const [playbackRate] = useState(1.0);
  const selectedRatio = (aspectRatio as AspectRatioType) || '16:9';
  const zoomLevel = canvasZoom;
  // Saved with the project and applied by the export, so the picture here is the picture rendered
  const [videoFilter, setVideoFilter] = useVideoFilter(currentProject?.id);
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const [showRatioDropdown, setShowRatioDropdown] = useState(false);
  const [showBlurDropdown, setShowBlurDropdown] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | null>(null);

  // Blur boxes (areas of the original video to hide), stored per project
  const defaultBlurShapes: BlurShape[] = [];
  const [blurShapes, setBlurShapes] = useState<BlurShape[]>(defaultBlurShapes);
  // latest boxes, so a finished drag can be saved without reaching into a state updater
  const blurShapesRef = useRef(blurShapes);
  blurShapesRef.current = blurShapes;
  const [activeBlurShapeId, setActiveBlurShapeId] = useState<string>('blur-1');
  const [showLogoTools, setShowLogoTools] = useState(false);

  // The project's logo: shown live on the player and applied to every export while it is on
  const [logo, setLogo] = useState<LogoSettings>(() => loadLogoSettings(''));
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoBurning, setLogoBurning] = useState(false);
  const [logoError, setLogoError] = useState('');
  useEffect(() => {
    const id = currentProject?.id;
    if (!id) return;
    const saved = loadLogoSettings(id);
    setLogo(saved);
    setLogoError('');
    // a logo uploaded before settings were remembered is still on the server
    if (!saved.url) {
      fetchProjectLogo(id)
        .then((url) => url && setLogo((cur) => ({ ...cur, url })))
        .catch(() => {});
    }
  }, [currentProject?.id]);
  // "Use as logo" in the Assets tab writes the settings; pick them up without a reload
  useEffect(() => {
    const onChanged = (e: Event) => {
      const id = currentProject?.id;
      if (id && (e as CustomEvent).detail?.projectId === id) setLogo(loadLogoSettings(id));
    };
    window.addEventListener(LOGO_SETTINGS_CHANGED, onChanged);
    // after the server copy arrives: the logo, and the blur boxes, may be different
    const onSynced = (e: Event) => {
      const id = currentProject?.id;
      if (!id || (e as CustomEvent).detail?.projectId !== id) return;
      setLogo(loadLogoSettings(id));
      try {
        const stored = localStorage.getItem(`meatika_blur_shapes_${id}`);
        const parsed = stored ? JSON.parse(stored) : [];
        setBlurShapes(Array.isArray(parsed) ? parsed : []);
      } catch {
        /* keep the current boxes */
      }
    };
    window.addEventListener(PROJECT_SETTINGS_SYNCED, onSynced);
    // the timeline's logo track opens the panel on a double-click
    const openPanel = () => {
      setShowBlurDropdown(false);
      setShowLogoTools(true);
    };
    window.addEventListener(OPEN_LOGO_PANEL, openPanel);
    return () => {
      window.removeEventListener(LOGO_SETTINGS_CHANGED, onChanged);
      window.removeEventListener(PROJECT_SETTINGS_SYNCED, onSynced);
      window.removeEventListener(OPEN_LOGO_PANEL, openPanel);
    };
  }, [currentProject?.id]);
  const changeLogo = (patch: Partial<LogoSettings>, persist = true) => {
    setLogo((cur) => {
      const next = { ...cur, ...patch };
      if (persist && currentProject?.id) saveLogoSettings(currentProject.id, next);
      return next;
    });
  };
  const handleLogoUpload = async (file: File) => {
    if (!currentProject) return;
    setLogoUploading(true);
    setLogoError('');
    try {
      const res = await uploadProjectLogo(currentProject.id, file);
      changeLogo({ url: res.url, enabled: true });
    } catch (err: any) {
      setLogoError(err?.response?.data?.detail || err?.message || 'Could not upload the image');
    } finally {
      setLogoUploading(false);
    }
  };
  const handleBurnLogo = async () => {
    if (!currentProject || !logo.url || logoBurning) return;
    if (!confirm('Burn the logo permanently into the project video?\n\nThis re-encodes your source video. You usually do not need this — the logo is already added to every export while "Show & export" is on.')) return;
    setLogoBurning(true);
    setLogoError('');
    try {
      await applyVideoLogo(currentProject.id, {
        logo_url: logo.url,
        position: logo.position,
        scale_pct: logo.scale_pct,
        opacity: logo.opacity,
        x_pct: logo.position === 'custom' ? logo.x_pct : undefined,
        y_pct: logo.position === 'custom' ? logo.y_pct : undefined,
      });
      // it is in the picture now; drawing it again on top would double it
      changeLogo({ enabled: false });
      await loadProject(currentProject.id);
      videoRef.current?.load();
      setShowLogoTools(false);
    } catch (err: any) {
      setLogoError(err?.response?.data?.detail || err?.message || 'Could not burn the logo');
    } finally {
      setLogoBurning(false);
    }
  };

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
      saveProjectSetting(currentProject.id, 'blur_shapes', shapes);
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
        setShowLogoTools(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const [isBurningBlur, setIsBurningBlur] = useState(false);

  const handleBurnPermanentBlur = async () => {
    if (!currentProject || isBurningBlur) return;
    const areas = blurAreasForExport(blurShapes);
    if (areas.length === 0) return;
    if (!confirm(
      `Burn ${areas.length} box${areas.length === 1 ? '' : 'es'} permanently into the project video?\n\n` +
      'This re-encodes your source video. You usually do not need this — enabled boxes are already applied to every export.',
    )) return;

    setIsBurningBlur(true);
    try {
      const vid = videoRef.current;
      const w = vid?.videoWidth || 1280;
      const h = vid?.videoHeight || 720;
      // box times are timeline times; the burn works on the source video
      const toSource = (t: number | null) =>
        t == null ? null : clipLayout.length ? timelineToSource(clipLayout, t)?.sourceTime ?? t : t;
      const regions = areas.map((a) => ({
        x: Math.round((a.x_pct / 100) * w),
        y: Math.round((a.y_pct / 100) * h),
        width: Math.max(4, Math.round((a.width_pct / 100) * w)),
        height: Math.max(4, Math.round((a.height_pct / 100) * h)),
        style: a.style,
        strength: a.strength,
        tint: a.tint,
        color: a.color,
        start: toSource(a.start),
        end: toSource(a.end),
      }));

      await blurVideoRegions(currentProject.id, regions);
      await loadProject(currentProject.id);
      videoRef.current?.load();
      // they are in the picture now; applying them again at export would do it twice
      saveBlurShapes(blurShapes.map((s) => ({ ...s, enabled: false })));
      setShowBlurDropdown(false);
    } catch (err: any) {
      console.error('Burn blur failed:', err);
      alert(`Blur failed: ${err?.response?.data?.detail || err.message || err}`);
    } finally {
      setIsBurningBlur(false);
    }
  };

  // On-canvas overlay drag/scale position
  const [overlayPos] = useState({ x: 0, y: 0 });
  const [overlayScale] = useState(1.0);

  const containerRef = useRef<HTMLDivElement>(null);
  // The canvas frame the picture sits in (the export frame), and the video's own size inside
  // it. Overlays, captions and the logo are sized to the frame; blur boxes to the picture.
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameSize, setFrameSize] = useState({ w: 640, h: 360 });
  const [videoNatural, setVideoNatural] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFrameSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  });
  const picture = useMemo(() => {
    const { w: fw, h: fh } = frameSize;
    if (!videoNatural.w || !videoNatural.h) return { left: 0, top: 0, width: fw, height: fh };
    const k = Math.min(fw / videoNatural.w, fh / videoNatural.h);
    const width = videoNatural.w * k;
    const height = videoNatural.h * k;
    return { left: (fw - width) / 2, top: (fh - height) / 2, width, height };
  }, [frameSize, videoNatural]);
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

  useEffect(() => {
    playbackRateRef.current = playbackRate;
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, videoRef]);

  const videoFile = currentProject?.video_path ? currentProject.video_path.split('/').pop() : '';
  // The player shows the edit, not the file: with every clip deleted from the timeline there
  // is nothing to play, even though the file is kept so the delete can be undone.
  const timelineEmpty = !!currentProject?.timeline_cleared && videoClips.length === 0;
  const videoSrc = currentProject?.video_path && videoFile && !timelineEmpty
    ? `/uploads/${currentProject.id}/${videoFile}`
    : '';

  const [showTextOverlays, setShowTextOverlays] = useState(false);
  // The timeline's text track can open the editor on one overlay, or to add a new one
  const [overlayOpenWith, setOverlayOpenWith] = useState<{ id?: string; create?: boolean }>({});
  useEffect(() => {
    const open = (e: Event) => {
      setOverlayOpenWith((e as CustomEvent).detail || {});
      setShowTextOverlays(true);
    };
    window.addEventListener(OPEN_TEXT_OVERLAYS, open);
    return () => window.removeEventListener(OPEN_TEXT_OVERLAYS, open);
  }, []);
  // bumped after saving so the preview layer re-reads without a page reload
  const [overlayVersion, setOverlayVersion] = useState(0);

  /** hh:mm:ss:ff at 30fps — the timecode that used to sit in the timeline toolbar. */
  /** The time as people say it: 1:28, or 1:02:28 past an hour */
  const clock = (sec: number) => {
    const t = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const ss = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  };

  const formatFrameTime = (sec: number) => {
    const safe = Math.max(0, sec || 0);
    const h = Math.floor(safe / 3600);
    const m = Math.floor((safe % 3600) / 60);
    const s2 = Math.floor(safe % 60);
    const f = Math.floor((safe % 1) * 30);
    return [h, m, s2, f].map((n) => n.toString().padStart(2, '0')).join(':');
  };

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
    setPlaybackError(null);
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
            video.play().catch(reportPlaybackError);
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

    let lastPublishedFrame = 0;
    const tick = (now: number) => {
      // Keep React updates bounded on 120/144 Hz displays while preserving
      // immediate seek/pause updates through their event handlers.
      if (now - lastPublishedFrame >= 1000 / 30) {
        updateTime();
        lastPublishedFrame = now;
      }
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
        video.play().catch(reportPlaybackError);
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
  }, [videoRef, currentProject?.segments, clipLayout, videoClips, updateProgressBar, setCurrentTime, setIsPlaying, setActiveSegment, reportPlaybackError]);

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

  // where each caption starts on the timeline, for stepping from line to line
  const captionStarts = useMemo(() => {
    const starts: number[] = [];
    for (const seg of currentProject?.segments || []) {
      if (!(seg.text || '').trim()) continue;
      if (!clipLayout.length) { starts.push(seg.start_time); continue; }
      const range = sourceRangeToTimeline(clipLayout, seg.start_time, seg.end_time);
      if (range.isVisible) starts.push(range.timelineStart);
    }
    return starts.sort((x, y) => x - y);
  }, [currentProject?.segments, clipLayout]);
  const jumpCaption = (direction: 1 | -1) => {
    const target = direction > 0
      ? captionStarts.find((t) => t > currentTime + 0.05)
      // back: the start of this line first, then the one before it
      : [...captionStarts].reverse().find((t) => t < currentTime - 0.6);
    if (target !== undefined) seekToTimelineTime(target);
  };
  const transportButton = 'p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer';

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
      video.play().catch(reportPlaybackError);
    } else {
      video.pause();
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

  const activeFilterStyle = cssFilter(resolveSteps(videoFilter));
  const filterOn = isFiltered(videoFilter);
  const ratioConfig = ASPECT_RATIOS.find((r) => r.id === selectedRatio) || ASPECT_RATIOS[0];

  if (!videoSrc) {
    return (
      <div className="h-full flex items-center justify-center bg-zinc-950 border-b border-zinc-800">
        <div className="text-center text-zinc-600 py-12">
          <Upload className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p className="text-xs font-medium opacity-60">{timelineEmpty ? 'No video on the timeline' : 'No video loaded in project'}</p>
          <p className="text-[10px] text-zinc-600 mt-1">
            {timelineEmpty ? 'Add a video from Assets, or undo to bring the deleted clip back' : 'Upload a video or import subtitles to begin'}
          </p>
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
      <div className="h-10 px-3 bg-[var(--s2)] border-b border-[var(--s3)] flex items-center justify-between shrink-0 text-xs text-zinc-300 z-30 gap-2 overflow-visible relative">
        {/* Left: Aspect Ratio Switcher */}
        <div className="relative shrink-0" data-dropdown-container>
          <button
            onClick={() => {
              setShowRatioDropdown(!showRatioDropdown);
              setShowFilterDropdown(false);
              setShowBlurDropdown(false);
            }}
            aria-haspopup="menu"
            aria-expanded={showRatioDropdown}
            title="The shape of the video frame"
            className="h-7 flex items-center gap-1.5 px-2.5 rounded-lg bg-[var(--s3)] hover:bg-[var(--s4)] text-zinc-200 hover:text-white border border-[var(--s5)] hover:border-[var(--s8)] transition-all text-[11px] font-semibold cursor-pointer"
          >
            <ShapeIcon w={ratioConfig.w} h={ratioConfig.h} size={14} />
            <span>{ratioConfig.name}</span>
            <span className="font-mono text-zinc-500">{selectedRatio}</span>
            <ChevronDown className={`w-3 h-3 text-zinc-500 shrink-0 transition-transform ${showRatioDropdown ? 'rotate-180' : ''}`} />
          </button>

          {showRatioDropdown && (
            <div role="menu" className="absolute left-0 top-full mt-1.5 w-64 bg-[var(--s2)] border border-[var(--s6)] rounded-xl shadow-2xl p-1 z-50">
              <p className="px-2.5 pt-1.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Frame shape</p>
              {ASPECT_RATIOS.map((r) => {
                const on = selectedRatio === r.id;
                return (
                  <button
                    key={r.id}
                    role="menuitemradio"
                    aria-checked={on}
                    onClick={() => {
                      setAspectRatio(r.id);
                      setShowRatioDropdown(false);
                    }}
                    className={`w-full px-2.5 py-2 rounded-lg text-left flex items-center gap-3 transition-colors cursor-pointer ${
                      on ? 'bg-blue-600/15' : 'hover:bg-white/5'
                    }`}
                  >
                    <ShapeIcon w={r.w} h={r.h} size={22} active={on} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span className={`text-xs font-semibold ${on ? 'text-white' : 'text-zinc-200'}`}>{r.name}</span>
                        <span className="text-[10px] font-mono text-zinc-500">{r.id}</span>
                      </span>
                      <span className="block text-[10px] text-zinc-500 truncate">{r.use} · {r.w}×{r.h}</span>
                    </span>
                    {on && <Check className="w-3.5 h-3.5 text-blue-300 shrink-0" />}
                  </button>
                );
              })}
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
                setShowBlurDropdown(false);
              }}
              className={`h-7 flex items-center gap-1.5 px-2.5 rounded-lg text-[11px] font-medium transition-all cursor-pointer ${
                filterOn
                  ? 'bg-blue-600/20 text-blue-100 border border-blue-500/50 shadow-xs'
                  : 'bg-[var(--s3)] hover:bg-[var(--s4)] text-zinc-300 hover:text-white border border-[var(--s5)] hover:border-[var(--s8)]'
              }`}
              title="Colour filter — saved with the project and applied to the exported video"
            >
              <Sparkles className={`w-3.5 h-3.5 shrink-0 ${filterOn ? 'text-blue-300' : 'text-zinc-400'}`} />
              <span>{filterOn ? FILTER_PRESETS.find((f) => f.id === videoFilter.preset && f.id !== 'none')?.name || 'Adjusted' : 'Filter'}</span>
            </button>

            {showFilterDropdown && (
              <div className="absolute right-0 top-full mt-1.5 w-72 bg-[var(--s3)] border border-[var(--s6)] rounded-xl shadow-2xl p-3 z-50 backdrop-blur-md space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">Colour filter</span>
                  <button
                    onClick={() => setVideoFilter(DEFAULT_VIDEO_FILTER)}
                    disabled={!filterOn}
                    className="text-[10px] text-blue-300 hover:text-blue-200 disabled:opacity-30"
                  >
                    Reset
                  </button>
                </div>

                {/* Each look, shown on a colour strip so the difference is visible before choosing */}
                <div className="grid grid-cols-3 gap-1.5">
                  {FILTER_PRESETS.map((f) => {
                    const active = videoFilter.preset === f.id;
                    return (
                      <button
                        key={f.id}
                        onClick={() => setVideoFilter({ preset: f.id, intensity: 1 })}
                        title={f.hint}
                        aria-pressed={active}
                        className={`rounded-lg overflow-hidden border text-left transition-colors cursor-pointer ${
                          active ? 'border-blue-500 ring-1 ring-blue-500/40' : 'border-[var(--s6)] hover:border-[var(--s8)]'
                        }`}
                      >
                        <span
                          className="block h-7"
                          style={{
                            background: 'linear-gradient(90deg, #1f2937, #b45309, #f5d0a9, #38bdf8, #16a34a, #e11d48)',
                            filter: cssFilter(f.steps),
                          }}
                        />
                        <span className={`block px-1.5 py-1 text-[10px] truncate ${active ? 'text-white font-semibold' : 'text-zinc-300'}`}>{f.name}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="space-y-2 pt-1 border-t border-[var(--s5)]">
                  {([
                    ['intensity', 'Strength of the look', 0, 1, videoFilter.preset === 'none'],
                    ['brightness', 'Brightness', 0.5, 1.5, false],
                    ['contrast', 'Contrast', 0.5, 1.5, false],
                    ['saturation', 'Colour', 0, 2, false],
                  ] as const).map(([key, label, min, max, off]) => (
                    <label key={key} className={`block ${off ? 'opacity-40' : ''}`}>
                      <span className="flex items-center justify-between text-[10px] text-zinc-400">
                        <span>{label}</span>
                        <button
                          onClick={() => setVideoFilter({ [key]: 1 })}
                          title="Click to reset"
                          className="font-mono tabular-nums text-white hover:text-blue-300"
                        >
                          {Math.round(videoFilter[key] * 100)}%
                        </button>
                      </span>
                      <input
                        type="range" min={min} max={max} step={0.01} value={videoFilter[key]} disabled={off}
                        onChange={(e) => setVideoFilter({ [key]: parseFloat(e.target.value) })}
                        className="w-full h-1.5 bg-zinc-800 rounded-lg accent-blue-500 cursor-pointer"
                      />
                    </label>
                  ))}
                </div>
                <p className="text-[10px] text-zinc-500 leading-relaxed">
                  Saved with this project. The exported video gets the same colours; captions and the logo are not tinted.
                </p>
              </div>
            )}
          </div>

          {/* Blur Shape / Text Mask Dropdown */}
          <button
            onClick={() => {
            setOverlayOpenWith({});
            setShowTextOverlays(true);
          }}
            disabled={!currentProject?.video_path}
            title="Titles and callouts drawn over the picture"
            className="h-7 shrink-0 flex items-center gap-1.5 px-2.5 rounded-lg text-[11px] font-medium transition-all cursor-pointer bg-[var(--s3)] hover:bg-[var(--s4)] text-zinc-300 hover:text-white border border-[var(--s5)] hover:border-[var(--s8)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Type className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
            <span>Text</span>
          </button>

          <div className="relative shrink-0" data-dropdown-container>
            <button
              onClick={() => {
                setShowBlurDropdown(!showBlurDropdown);
                setShowFilterDropdown(false);
                setShowRatioDropdown(false);
              }}
              className={`h-7 flex items-center gap-1.5 px-2.5 rounded-lg text-[11px] font-medium transition-all cursor-pointer ${
                blurShapes.some((s) => s.enabled)
                  ? 'bg-white/10 text-zinc-100 border border-white/10 shadow-xs'
                  : 'bg-[var(--s3)] hover:bg-[var(--s4)] text-zinc-300 hover:text-white border border-[var(--s5)] hover:border-[var(--s8)]'
              }`}
              title="Blur multiple logos, watermarks, or subtitles on original video"
            >
              <Eraser className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
              <span>Blur{blurShapes.some((s) => s.enabled) ? ` (${blurShapes.filter((s) => s.enabled).length})` : ''}</span>
            </button>

            {showBlurDropdown && (
              <SidePanel anchor={containerRef}>
              <BlurPanel
                shapes={blurShapes}
                activeId={activeBlurShapeId}
                currentTime={currentTime}
                burning={isBurningBlur}
                onSelect={setActiveBlurShapeId}
                onSave={saveBlurShapes}
                onBurn={handleBurnPermanentBlur}
              />
              </SidePanel>
            )}
          </div>

          {/* Logo */}
          <div className="relative shrink-0" data-dropdown-container>
            <button
              onClick={() => {
                setShowLogoTools(!showLogoTools);
                setShowBlurDropdown(false);
                setShowFilterDropdown(false);
                setShowRatioDropdown(false);
              }}
              className={`h-7 flex items-center gap-1.5 px-2.5 rounded-lg text-[11px] font-medium transition-all cursor-pointer ${
                logo.enabled && logo.url
                  ? 'bg-sky-500/15 text-sky-100 border border-sky-400/30'
                  : 'bg-[var(--s3)] hover:bg-[var(--s4)] text-zinc-300 hover:text-white border border-[var(--s5)] hover:border-[var(--s8)]'
              }`}
              title="Your logo: shown on the video and added to every export"
            >
              <ImageIcon className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
              <span>Logo{logo.enabled && logo.url ? ' ✓' : ''}</span>
            </button>
            {showLogoTools && (
              <SidePanel anchor={containerRef}>
              <LogoPanel
                settings={logo}
                uploading={logoUploading}
                burning={logoBurning}
                error={logoError}
                onChange={(patch) => changeLogo(patch)}
                onUpload={handleLogoUpload}
                onBurn={handleBurnLogo}
              />
              </SidePanel>
            )}
          </div>

        </div>
      </div>

      {/* Main Canvas Viewport Area */}
      <div
        className="flex-1 relative bg-black flex items-center justify-center p-3 overflow-hidden"
        onClick={() => setSelectedCaptionId(null)}
      >
        {/* Canvas Frame matching aspect ratio */}
        <div
          ref={frameRef}
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
            onLoadedMetadata={(e) => setVideoNatural({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedCaptionId(null);
              togglePlay();
            }}
            onError={(e) => reportPlaybackError(new Error(e.currentTarget.error?.message || 'Could not load the video.'))}
            onCanPlay={() => setPlaybackError(null)}
            playsInline
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
                <div className="absolute top-4 left-4 flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-950/80 border border-blue-400/60 text-blue-300 text-xs font-bold backdrop-blur-md shadow-lg shadow-blue-950/50">
                  <Snowflake className="w-3.5 h-3.5 text-blue-400 animate-spin" style={{ animationDuration: '6s' }} />
                  <span>FREEZE FRAME</span>
                </div>
              </div>
            );
          })()}

          {/* Blur boxes sit over the video picture itself, the area the export measures them in */}
          <div
            data-blur-picture
            data-dropdown-container
            className="absolute pointer-events-none [&>*]:pointer-events-auto"
            style={{ left: picture.left, top: picture.top, width: picture.width, height: picture.height }}
          >
            <BlurLayer
              shapes={blurShapes}
              activeId={activeBlurShapeId}
              currentTime={currentTime}
              pictureHeight={picture.height}
              onSelect={(id) => {
                setActiveBlurShapeId(id);
                setShowBlurDropdown(true);
              }}
              onChange={(id, patch) => setBlurShapes((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))}
              onCommit={() => saveBlurShapes(blurShapesRef.current)}
            />
          </div>

          <LogoLayer
            settings={logo}
            currentTime={currentTime}
            W={frameSize.w}
            H={frameSize.h}
            onChange={(patch) => changeLogo(patch, false)}
            onCommit={() => changeLogo({})}
          />

          {/* Text overlays — the same percentages the export uses, so what shows here matches */}
          <TextOverlayLayer
            projectId={currentProject?.id}
            currentTime={currentTime}
            frameWidth={frameSize.w}
            frameHeight={frameSize.h}
            reloadKey={overlayVersion}
          />

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
                  frameHeight={frameSize.h}
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
              <div className="absolute left-0 right-0 h-1.5 bg-zinc-800 rounded-full group-hover/seek:h-2 transition-all" />
              <div
                ref={fillRef}
                className="absolute left-0 h-1.5 bg-blue-500 rounded-full group-hover/seek:h-2 transition-all pointer-events-none"
                style={{ width: '0%' }}
              />
              <div
                ref={thumbRef}
                className="absolute w-3.5 h-3.5 bg-blue-400 rounded-full shadow-lg pointer-events-none opacity-0 group-hover/seek:opacity-100 transition-opacity ring-2 ring-blue-500/30"
                style={{ left: 'calc(0% - 7px)' }}
              />
            </div>
          );
        })()}

        {playbackError && <div role="alert" className="flex items-center gap-2 rounded-lg bg-red-950/50 border border-red-500/30 p-2 text-xs text-red-200">
          <span className="flex-1">{playbackError}</span>
          <button className="shrink-0 rounded px-2 py-1 bg-white/10 hover:bg-white/20" onClick={() => {
            setPlaybackError(null);
            videoRef.current?.load();
          }}>Reload video</button>
        </div>}
        {/* Transport: moving around the video, under the picture */}
        <div className="flex items-center justify-between gap-3 px-1">
          <div className="font-mono text-xs text-zinc-200 whitespace-nowrap tabular-nums min-w-[92px]" title={`${formatFrameTime(currentTime)} of ${formatFrameTime(duration)} (hours:minutes:seconds:frames)`}>
            {clock(currentTime)}
            <span className="text-zinc-600"> / {clock(duration)}</span>
          </div>

          <div className="flex items-center gap-1">
            <button onClick={() => jumpCaption(-1)} disabled={!captionStarts.length} className={transportButton} title="Previous caption" aria-label="Previous caption">
              <SkipBack className="w-4 h-4" />
            </button>
            <button onClick={() => seekToTimelineTime(Math.max(0, currentTime - 5))} className={transportButton} title="Back 5 seconds" aria-label="Back 5 seconds">
              <Rewind className="w-4 h-4" />
            </button>
            <button
              onClick={togglePlay}
              className="mx-1 w-9 h-9 rounded-full bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center shadow-lg shadow-blue-950/50 active:scale-95 cursor-pointer"
              title="Play / Pause (Space)"
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
            </button>
            <button onClick={() => seekToTimelineTime(Math.min(duration, currentTime + 5))} className={transportButton} title="Forward 5 seconds" aria-label="Forward 5 seconds">
              <FastForward className="w-4 h-4" />
            </button>
            <button onClick={() => jumpCaption(1)} disabled={!captionStarts.length} className={transportButton} title="Next caption" aria-label="Next caption">
              <SkipForward className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center justify-end gap-1 min-w-[92px]">
            <button
              onClick={toggleFullscreen}
              className={transportButton}
              title={isFullscreen ? 'Leave full screen' : 'Full screen'}
              aria-label={isFullscreen ? 'Leave full screen' : 'Full screen'}
            >
              {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
            </button>
          </div>
        </div>

      </div>

      {/* Dedicated Logo & Image Overlay Modal */}
      {showTextOverlays && currentProject?.id && (
        <TextOverlayModal
          projectId={currentProject.id}
          currentTime={currentTime}
          videoSeconds={duration || currentProject.duration || 0}
          videoSrc={videoSrc}
          initialSelectedId={overlayOpenWith.id}
          createOnOpen={overlayOpenWith.create}
          toSourceTime={(t) => (clipLayout.length ? timelineToSource(clipLayout, t)?.sourceTime ?? t : t)}
          onClose={() => setShowTextOverlays(false)}
          onSaved={() => {
            setOverlayVersion((v) => v + 1);
            window.dispatchEvent(new CustomEvent(TEXT_OVERLAYS_CHANGED));
          }}
        />
      )}

    </div>
  );
}
