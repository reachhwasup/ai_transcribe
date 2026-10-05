import { useShallow } from 'zustand/react/shallow';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useProjectStore } from '../stores/projectStore';
import {
  exportVideoForPlatform,
  fetchProjectParts,
  joinParts,
  getExportUrl,
  getDefaultFolders,
  openFolderInSystem,
  selectFolderInSystem,
  fetchProjectLogo,
  fetchRenderQueue,
  removeRenderJob,
  clearFinishedRenderJobs,
  type RenderJob,
  uploadProjectLogo,
  type ExportBlurArea,
} from '../api/client';
import { blurAreasForExport, blurStorageKey } from './player/BlurTools';
import { loadLogoSettings, saveLogoSettings } from './player/LogoTools';
import {
  X,
  Download,
  Loader2,
  FileText,
  Check,
  Play,
  Pause,
  Scissors,
  SplitSquareHorizontal,
  Sparkles,
  Music,
  Film,
  CheckCircle2,
  Folder,
  FolderOpen,
  FolderPlus,
} from 'lucide-react';
import { buildClipLayout, totalTimelineDuration, timelineToSource } from '../utils/clipTimemap';
import { FILTER_PRESETS, cssFilter, resolveSteps, useVideoFilter } from '../utils/videoFilters';
import TitlesTagsPanel from './TitlesTagsPanel';
import { toast } from '../utils/toast';
import { nameParts } from '../utils/names';
import SubtitleOverlay from './SubtitleOverlay';

interface Props {
  open: boolean;
  onClose: () => void;
  inline?: boolean;
}

const PLATFORM_PRESETS: {
  id: string;
  name: string;
  ratio: string;
  res: string;
  icon: string;
  badge?: string;
  width: number;
  height: number;
}[] = [
  {
    id: 'tiktok',
    name: 'TikTok / Reels / Shorts',
    ratio: '9:16',
    res: '1080 × 1920',
    icon: '📱',
    badge: 'Popular',
    width: 1080,
    height: 1920,
  },
  {
    id: 'youtube',
    name: 'YouTube Landscape',
    ratio: '16:9',
    res: '1920 × 1080',
    icon: '▶️',
    badge: 'Standard',
    width: 1920,
    height: 1080,
  },
  {
    id: 'instagram_portrait',
    name: 'Instagram Portrait',
    ratio: '4:5',
    res: '1080 × 1350',
    icon: '📸',
    width: 1080,
    height: 1350,
  },
  {
    id: 'instagram_square',
    name: 'Instagram / Square',
    ratio: '1:1',
    res: '1080 × 1080',
    icon: '⏹️',
    width: 1080,
    height: 1080,
  },
  {
    id: 'cinematic',
    name: 'Cinematic Widescreen',
    ratio: '21:9',
    res: '2560 × 1080',
    icon: '🎬',
    width: 2560,
    height: 1080,
  },
  {
    id: 'custom',
    name: 'Original / Match Source',
    ratio: 'Original',
    res: 'Source Native',
    icon: '⚙️',
    width: 1920,
    height: 1080,
  },
];

/** Short names for the formats, so none is cut off in its button */
const PLATFORM_LABELS: Record<string, string> = {
  tiktok: 'TikTok · Reels', youtube: 'YouTube', instagram_portrait: 'Instagram 4:5',
  instagram_square: 'Square', cinematic: 'Cinematic', custom: 'Original',
};
const QUALITY_LABELS: Record<string, string> = { compact: 'small file', standard: 'standard', high: 'best quality' };
/** What is heard, in the order a dub is usually exported */
const AUDIO_LABELS = {
  music: 'Dub + the film’s music',
  original: 'Dub + original sound',
  none: 'Dub only',
  original_clean: 'Original, no dub',
} as const;
const AUDIO_HINTS: Record<keyof typeof AUDIO_LABELS, string> = {
  music: 'New voices over the music; the original voices taken out',
  original: 'New voices over everything, original voices included',
  none: 'Only the new voices, no background',
  original_clean: 'The video’s own sound, untouched',
};

/** The file name an export starts with: the project's name, made safe for a file */
const defaultExportName = (project: { name?: string; video_filename?: string }) =>
  (project.name || (project.video_filename || '').split('/').pop() || 'export')
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim() || 'export';

export default function ExportModal({ open, onClose, inline = false }: Props) {
  const { currentProject, videoClips, subtitleStyle, currentTime, aspectRatio, audioSeparated, bgmUrl, vocalsUrl } = useProjectStore(useShallow(state => ({ currentProject: state.currentProject, videoClips: state.videoClips, subtitleStyle: state.subtitleStyle, currentTime: state.currentTime, aspectRatio: state.aspectRatio, audioSeparated: state.audioSeparated, bgmUrl: state.bgmUrl, vocalsUrl: state.vocalsUrl })));
  const previewRef = useRef<HTMLVideoElement>(null);
  const previewBgRef = useRef<HTMLVideoElement>(null);
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const [previewBoxH, setPreviewBoxH] = useState(320);
  const rafRef = useRef<number>(0);
  const aiAudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const clipLayout = useMemo(() => buildClipLayout(videoClips), [videoClips]);

  const [tab, setTab] = useState<'video' | 'subtitles' | 'audio' | 'metadata'>('video');
  const [showMore, setShowMore] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState('tiktok');
  const [quality, setQuality] = useState<'compact' | 'standard' | 'high'>('standard');
  const [scaleMode, setScaleMode] = useState<'blur' | 'fit' | 'fill'>('blur');
  const hasTtsVoice = (currentProject?.segments || []).some((s) => Boolean(s.audio_url));
  const [bgAudio, setBgAudio] = useState<'original_clean' | 'original' | 'music' | 'none'>(
    hasTtsVoice || audioSeparated || bgmUrl ? 'music' : 'original_clean'
  );
  const [bgmVolume, setBgmVolume] = useState<number>(() => {
    try {
      const pId = currentProject?.id;
      if (!pId) return 0.35;
      const raw = localStorage.getItem(`timeline-bgm-volume-${pId}`) || localStorage.getItem(`timeline-video-volume-${pId}`);
      return raw !== null ? Math.max(0.0, Math.min(1.0, Number(raw))) : 0.35;
    } catch {
      return 0.35;
    }
  });
  const [voiceOffsetMs, setVoiceOffsetMs] = useState<number>(() => {
    try {
      const pId = currentProject?.id;
      if (!pId) return 0;
      const raw = localStorage.getItem(`export-voice-offset-${pId}`);
      return raw !== null ? Number(raw) : 0;
    } catch {
      return 0;
    }
  });
  const [exportName, setExportName] = useState('meatika_video');
  const [burnSubtitles, setBurnSubtitles] = useState(true);
  const [trimEnabled, setTrimEnabled] = useState(false);
  const [startTime, setStartTime] = useState('0');
  const [endTime, setEndTime] = useState('');
  const [splitEnabled, setSplitEnabled] = useState(false);
  const [splitDuration, setSplitDuration] = useState('60');
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('Rendering video...');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [currentSourceTime, setCurrentSourceTime] = useState(0);


  const [exportFolder, setExportFolder] = useState<string>(
    () => localStorage.getItem('meatika_export_folder') || ''
  );
  const [defaultFolders, setDefaultFolders] = useState<{
    home?: string;
    downloads?: string;
    desktop?: string;
    movies?: string;
  }>({});
  const [savedLocalPath, setSavedLocalPath] = useState<string | null>(null);
  const initializedOpenRef = useRef(false);

  // Logo / Watermark Export State
  const [exportLogoEnabled, setExportLogoEnabled] = useState(false);
  // Blur boxes are drawn in the video player and stored per project
  const [duckMusic, setDuckMusic] = useState(true);
  // The colour filter chosen in the player: shown on the preview here and rendered into the file
  const [videoFilter] = useVideoFilter(currentProject?.id);
  const filterSteps = useMemo(() => resolveSteps(videoFilter), [videoFilter]);
  const [normalizeLoudness, setNormalizeLoudness] = useState(true);
  const [renderJobs, setRenderJobs] = useState<RenderJob[]>([]);

  const refreshQueue = useCallback(async () => {
    try {
      setRenderJobs(await fetchRenderQueue());
    } catch {
      /* server may be restarting */
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    refreshQueue();
    const timer = setInterval(refreshQueue, 2000);
    return () => clearInterval(timer);
  }, [open, refreshQueue]);

  const [blurAreas, setBlurAreas] = useState<ExportBlurArea[]>([]);
  const [applyBlur, setApplyBlur] = useState(true);
  const exportLogoInputRef = useRef<HTMLInputElement>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [exportLogoUrl, setExportLogoUrl] = useState('');
  const [exportLogoPosition, setExportLogoPosition] = useState('top_right');
  const [exportLogoScalePct, setExportLogoScalePct] = useState(15);
  const [exportLogoOpacity, setExportLogoOpacity] = useState(1.0);
  const [exportLogoXPct, setExportLogoXPct] = useState(85);
  // when the logo shows, as set on the timeline's logo track (null = the whole video)
  const [exportLogoRange, setExportLogoRange] = useState<{ start: number | null; end: number | null }>({ start: null, end: null });
  const [exportLogoYPct, setExportLogoYPct] = useState(5);

  // Fetch OS default user directories
  useEffect(() => {
    getDefaultFolders()
      .then((f) => {
        setDefaultFolders(f);
        if (!localStorage.getItem('meatika_export_folder') && f.downloads) {
          setExportFolder(f.downloads);
        }
      })
      .catch(() => {});
  }, []);

  // Auto-sync volume & mute preferences directly from the timeline
  useEffect(() => {
    if (!open || !currentProject?.id) return;
    try {
      const pId = currentProject.id;
      const mutesRaw = localStorage.getItem(`timeline-mutes-${pId}`);
      const mutes = mutesRaw ? JSON.parse(mutesRaw) : {};
      const bgmVolRaw = localStorage.getItem(`timeline-bgm-volume-${pId}`);
      const vidVolRaw = localStorage.getItem(`timeline-video-volume-${pId}`);

      if (audioSeparated) {
        if (mutes.b1) {
          setBgAudio('none');
          setBgmVolume(0);
        } else {
          setBgAudio('music');
          if (bgmVolRaw !== null && bgmVolRaw !== undefined) {
            setBgmVolume(Math.max(0.0, Math.min(1.0, Number(bgmVolRaw))));
          }
        }
      } else {
        if (mutes.a2) {
          setBgAudio('none');
          setBgmVolume(0);
        } else {
          setBgAudio('original');
          if (vidVolRaw !== null && vidVolRaw !== undefined) {
            setBgmVolume(Math.max(0.0, Math.min(1.0, Number(vidVolRaw))));
          }
        }
      }
    } catch (e) {
      console.warn('Failed to auto-sync timeline volume settings to export modal:', e);
    }
  }, [open, currentProject?.id, audioSeparated]);

  const selectedPreset =
    PLATFORM_PRESETS.find((p) => p.id === selectedPlatform) || PLATFORM_PRESETS[0];

  useEffect(() => {
    const bg = previewBgRef.current;
    const main = previewRef.current;
    if (main) main.playbackRate = 1.0;
    if (bg) bg.playbackRate = 1.0;
    if (!bg || !main || scaleMode !== 'blur') return;
    if (previewPlaying) {
      bg.currentTime = main.currentTime;
      bg.play().catch(() => {});
    } else {
      bg.pause();
    }
  }, [previewPlaying, scaleMode]);

  useEffect(() => {
    const el = previewBoxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setPreviewBoxH(el.clientHeight || 320));
    ro.observe(el);
    setPreviewBoxH(el.clientHeight || 320);
    return () => ro.disconnect();
  }, [open, inline, selectedPlatform]);

  const previewTlDuration = useMemo(() => {
    if (videoClips.length > 0) return totalTimelineDuration(videoClips);
    return currentProject?.duration || 0;
  }, [videoClips, currentProject?.duration]);

  useEffect(() => {
    if (open && currentProject) {
      if (!initializedOpenRef.current) {
        initializedOpenRef.current = true;
        setError('');
        setDone(false);
        setProgress(0);
        setPreviewPlaying(false);

        // Sync active aspect ratio with VideoPlayer once on opening
        if (aspectRatio === '9:16') setSelectedPlatform('tiktok');
        else if (aspectRatio === '16:9') setSelectedPlatform('youtube');
        else if (aspectRatio === '1:1') setSelectedPlatform('instagram');
        else if (aspectRatio === '4:5') setSelectedPlatform('facebook');
        else setSelectedPlatform('custom');

        // Sync initial preview timestamp with VideoPlayer
        const initialTime = currentTime || 0;
        setPreviewTime(initialTime);
        setCurrentSourceTime(initialTime);

        setEndTime(String(Math.floor(currentProject.duration || 60)));
        // Load custom export filename from localStorage if saved by user previously
        const savedCustomName = currentProject?.id
          ? localStorage.getItem(`meatika_export_name_${currentProject.id}`)
          : null;
        if (savedCustomName && savedCustomName.trim()) {
          setExportName(savedCustomName.trim());
        } else {
          setExportName(defaultExportName(currentProject));
        }
      }
    } else if (!open) {
      initializedOpenRef.current = false;
    }
  }, [open, currentProject]);

  useEffect(() => {
    if (!open || !currentProject?.id) return;
    try {
      const stored = localStorage.getItem(blurStorageKey(currentProject.id));
      const shapes = stored ? JSON.parse(stored) : [];
      // style, strength, tint and timing travel too, so the export matches the player
      setBlurAreas(blurAreasForExport(Array.isArray(shapes) ? shapes : []));
    } catch {
      setBlurAreas([]);
    }
  }, [open, currentProject?.id]);

  useEffect(() => {
    if (!open || !currentProject?.id) return;
    let cancelled = false;
    // The logo set up on the player comes along: on/off, where, how big, how solid
    const logo = loadLogoSettings(currentProject.id);
    setExportLogoEnabled(!!(logo.enabled && logo.url));
    setExportLogoPosition(logo.position);
    setExportLogoScalePct(logo.scale_pct);
    setExportLogoOpacity(logo.opacity);
    setExportLogoXPct(logo.x_pct);
    setExportLogoYPct(logo.y_pct);
    setExportLogoRange({ start: logo.start ?? null, end: logo.end ?? null });
    if (logo.url) setExportLogoUrl(logo.url);
    fetchProjectLogo(currentProject.id)
      .then((url) => {
        if (!cancelled && url && !logo.url) setExportLogoUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, currentProject?.id]);

  useEffect(() => {
    const video = previewRef.current;
    if (!video || !open) return;
    const initialTime = currentTime || 0;
    if (clipLayout.length > 0) {
      const r = timelineToSource(clipLayout, initialTime);
      video.currentTime = r ? r.sourceTime : clipLayout[0].clip.source_start;
    } else {
      video.currentTime = initialTime;
    }
  }, [open, clipLayout, currentTime]);

  // The preview is heard the way the export will sound, following the choice under "Captions &
  // sound": the film's own track is silenced when the dub goes over the isolated music (or over
  // nothing), and the music stem is played in its place. It used to play the film's track
  // whatever was chosen, so the original voices were heard under the dub.
  const previewBgmRef = useRef<HTMLAudioElement>(null);
  const previewUsesStem = bgAudio === 'music' && !!bgmUrl;
  const previewFilmSilent = bgAudio === 'none' || previewUsesStem;
  const previewHasDub = bgAudio !== 'original_clean';
  useEffect(() => {
    const video = previewRef.current;
    if (video) {
      video.muted = previewFilmSilent;
      // under a dub the original sound is turned down to the chosen level, as in the export
      video.volume = bgAudio === 'original' ? Math.max(0, Math.min(1, bgmVolume)) : 1;
    }
    const stem = previewBgmRef.current;
    if (stem) {
      stem.volume = Math.max(0, Math.min(1, bgmVolume));
      if (!previewUsesStem && !stem.paused) stem.pause();
    }
  }, [open, previewFilmSilent, previewUsesStem, bgAudio, bgmVolume]);

  const pauseAllAiAudio = useCallback(() => {
    if (previewBgmRef.current && !previewBgmRef.current.paused) previewBgmRef.current.pause();
    aiAudioRefs.current.forEach((audio) => {
      if (!audio.paused) {
        audio.pause();
        audio.currentTime = 0;
      }
    });
  }, []);

  // Guarantee all preview video and AI audio are paused when modal closes
  useEffect(() => {
    if (!open) {
      if (previewRef.current && !previewRef.current.paused) {
        previewRef.current.pause();
      }
      if (previewBgRef.current && !previewBgRef.current.paused) {
        previewBgRef.current.pause();
      }
      pauseAllAiAudio();
      setPreviewPlaying(false);
    }
  }, [open, pauseAllAiAudio]);

  // Clean up on component unmount
  useEffect(() => {
    return () => {
      if (previewRef.current && !previewRef.current.paused) {
        previewRef.current.pause();
      }
      if (previewBgRef.current && !previewBgRef.current.paused) {
        previewBgRef.current.pause();
      }
      pauseAllAiAudio();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [pauseAllAiAudio]);

  useEffect(() => {
    const video = previewRef.current;
    if (!video || !previewPlaying) return;
    const syncAiAudio = (srcTime: number) => {
      (currentProject?.segments || []).forEach((seg) => {
        if (!seg.audio_url) return;
        const audio = aiAudioRefs.current.get(seg.id);
        if (!audio) return;
        const inRange = srcTime >= seg.start_time && srcTime < seg.end_time;
        if (inRange) {
          const expectedTime = srcTime - seg.start_time;
          if (audio.paused) {
            audio.currentTime = expectedTime;
            audio.play().catch(() => {});
          } else if (Math.abs(audio.currentTime - expectedTime) > 0.3)
            audio.currentTime = expectedTime;
        } else {
          if (!audio.paused) {
            audio.pause();
            audio.currentTime = 0;
          }
        }
      });
    };
    const tick = () => {
      const srcTime = video.currentTime;

      // Sync background blur video directly on frame tick if needed
      if (scaleMode === 'blur' && previewBgRef.current) {
        const bg = previewBgRef.current;
        if (Math.abs(bg.currentTime - srcTime) > 0.2) {
          bg.currentTime = srcTime;
        }
      }

      if (clipLayout.length > 0) {
        let inClip = false;
        for (const l of clipLayout) {
          if (srcTime >= l.clip.source_start && srcTime < l.clip.source_end) {
            inClip = true;
            setPreviewTime(l.timelineStart + (srcTime - l.clip.source_start));
            setCurrentSourceTime(srcTime);
            break;
          }
        }
        if (!inClip) {
          const sorted = [...clipLayout].sort((a, b) => a.clip.source_start - b.clip.source_start);
          let jumped = false;
          for (const l of sorted) {
            if (l.clip.source_start > srcTime) {
              video.currentTime = l.clip.source_start;
              jumped = true;
              break;
            }
          }
          if (!jumped) {
            video.pause();
            if (previewBgRef.current) previewBgRef.current.pause();
            pauseAllAiAudio();
            setPreviewPlaying(false);
            setPreviewTime(previewTlDuration);
            return;
          }
        }
      } else {
        setPreviewTime(srcTime);
        setCurrentSourceTime(srcTime);
        if (srcTime >= (currentProject?.duration || video.duration)) {
          video.pause();
          if (previewBgRef.current) previewBgRef.current.pause();
          pauseAllAiAudio();
          setPreviewPlaying(false);
          return;
        }
      }
      if (previewHasDub) syncAiAudio(srcTime);
      const stem = previewBgmRef.current;
      if (stem && previewUsesStem) {
        if (stem.paused) {
          stem.currentTime = srcTime;
          stem.play().catch(() => {});
        } else if (Math.abs(stem.currentTime - srcTime) > 0.3) stem.currentTime = srcTime;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    video.playbackRate = 1.0;
    video.play().catch(() => setPreviewPlaying(false));
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [previewPlaying, clipLayout, previewTlDuration, pauseAllAiAudio, scaleMode, previewHasDub, previewUsesStem]);

  useEffect(() => {
    if (!previewPlaying || !previewHasDub) {
      if (!previewPlaying && previewRef.current && !previewRef.current.paused) previewRef.current.pause();
      pauseAllAiAudio();
    }
  }, [previewPlaying, previewHasDub, pauseAllAiAudio]);

  useEffect(() => {
    if (!open) {
      cancelAnimationFrame(rafRef.current);
      setPreviewPlaying(false);
      pauseAllAiAudio();
    }
  }, [open, pauseAllAiAudio]);

  const togglePreview = useCallback(() => setPreviewPlaying((p) => !p), []);
  const seekPreview = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const newTlTime =
        Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * previewTlDuration;
      setPreviewTime(newTlTime);
      const video = previewRef.current;
      if (!video) return;
      if (clipLayout.length > 0) {
        const r = timelineToSource(clipLayout, newTlTime);
        if (r) video.currentTime = r.sourceTime;
      } else video.currentTime = newTlTime;
      // the subtitle preview and the dubbed voices follow this, not the scrubber position
      setCurrentSourceTime(video.currentTime);
    },
    [clipLayout, previewTlDuration]
  );

  const handleSubtitleExport = (format: string) => {
    if (!currentProject) return;
    window.open(getExportUrl(currentProject.id, format), '_blank');
  };

  // When this project is one part of a split video, offer to render every part and
  // stitch them back into one file instead of exporting this part alone.
  const [siblingParts, setSiblingParts] = useState<{ id: string; name: string }[]>([]);
  const [joinAllParts, setJoinAllParts] = useState(false);
  const isPart = !!currentProject?.part_index;

  useEffect(() => {
    if (!open || !currentProject?.id || !isPart) {
      setSiblingParts([]);
      return;
    }
    let cancelled = false;
    fetchProjectParts(currentProject.id)
      .then((parts) => {
        if (!cancelled) setSiblingParts(parts.map((p) => ({ id: p.id, name: p.name })));
      })
      .catch(() => {
        if (!cancelled) setSiblingParts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, currentProject?.id, isPart]);

  /** The same settings the single-project export sends, as the backend's snake_case request. */
  const buildExportRequest = () => ({
    platform: selectedPlatform,
    include_subtitles: burnSubtitles,
    include_voice: bgAudio !== 'original_clean',
    mute_original_audio: bgAudio === 'none',
    background_audio: bgAudio === 'original_clean' ? 'original' : bgAudio,
    scale_mode: scaleMode,
    subtitle_style: subtitleStyle,
    export_folder: exportFolder?.trim() || undefined,
    quality,
    bgm_volume: bgmVolume,
    voice_offset_ms: voiceOffsetMs,
    logo_url: exportLogoUrl || undefined,
    logo_enabled: exportLogoEnabled,
    logo_position: exportLogoPosition,
    logo_scale_pct: exportLogoScalePct,
    logo_opacity: exportLogoOpacity,
    logo_x_pct: exportLogoPosition === 'custom' ? exportLogoXPct : undefined,
    logo_y_pct: exportLogoPosition === 'custom' ? exportLogoYPct : undefined,
    logo_start: exportLogoRange.start,
    logo_end: exportLogoRange.end,
    blur_areas: applyBlur ? blurAreas : [],
    duck_music: duckMusic,
    normalize_loudness: normalizeLoudness,
    video_filter: filterSteps.length ? filterSteps : null,
  });

  const handleJoinExport = async () => {
    if (!currentProject) return;
    setExporting(true);
    setError('');
    setProgress(0);
    setDone(false);
    setSavedLocalPath(null);
    setStatusMessage(`Rendering ${siblingParts.length} parts…`);
    const label = nameParts(currentProject.name).head || currentProject.name;
    toast({ tone: 'working', title: `Exporting ${siblingParts.length} parts as one video`, detail: label });
    try {
      const safeName = (exportName.trim() || currentProject.name || 'meatika_video')
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, '_');
      const res = await joinParts(
        currentProject.id,
        buildExportRequest(),
        `${safeName}.mp4`,
        (pct, msg) => {
          setProgress(pct);
          if (msg) setStatusMessage(msg);
        },
      );
      setDone(true);
      setStatusMessage(`Joined ${siblingParts.length} parts into one video`);
      toast({ tone: 'success', title: 'Export finished', detail: `${label} — ${siblingParts.length} parts joined` });
      if (res.savedPath) {
        setSavedLocalPath(res.savedPath);
        openFolderInSystem(res.savedPath).catch(() => {});
      } else {
        const a = document.createElement('a');
        a.href = res.downloadUrl;
        a.download = res.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Joining the parts failed');
      toast({ tone: 'error', title: 'Export failed', detail: `${label} — ${e instanceof Error ? e.message : 'joining the parts failed'}` });
    } finally {
      setExporting(false);
    }
  };

  const handleVideoExport = async (queueIt = false) => {
    if (!currentProject) return;
    setExporting(true);
    setError('');
    setProgress(0);
    setStatusMessage('Preparing render...');
    setDone(false);
    // a queued export is announced by the queue itself, when it starts and when it ends
    const label = nameParts(currentProject.name).tail || currentProject.name;
    if (!queueIt) toast({ tone: 'working', title: 'Export started', detail: label });
    try {
      setSavedLocalPath(null);
      const safeName = (exportName.trim() || currentProject.name || 'meatika_video')
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, '_');
      const targetFilename = `${safeName}.mp4`;

      const includeVoice = bgAudio !== 'original_clean';
      const actualBgAudio = bgAudio === 'original_clean' ? 'original' : bgAudio;

      const result = await exportVideoForPlatform(
        currentProject.id,
        selectedPlatform,
        trimEnabled ? parseFloat(startTime) : undefined,
        trimEnabled ? parseFloat(endTime) : undefined,
        burnSubtitles,
        (p, msg) => {
          setProgress(p);
          if (msg) setStatusMessage(msg);
        },
        includeVoice,
        splitEnabled ? parseFloat(splitDuration) : undefined,
        undefined, // subtitle language: captions are exported as they are
        bgAudio === 'none',
        scaleMode,
        subtitleStyle,
        actualBgAudio,
        exportFolder?.trim() || undefined,
        targetFilename,
        quality,
        bgmVolume,
        voiceOffsetMs,
        {
          logo_url: exportLogoUrl || undefined,
          logo_enabled: exportLogoEnabled,
          logo_position: exportLogoPosition,
          logo_scale_pct: exportLogoScalePct,
          logo_opacity: exportLogoOpacity,
          logo_x_pct: exportLogoPosition === 'custom' ? exportLogoXPct : undefined,
          logo_y_pct: exportLogoPosition === 'custom' ? exportLogoYPct : undefined,
          logo_start: exportLogoRange.start,
          logo_end: exportLogoRange.end,
        },
        applyBlur ? blurAreas : [],
        queueIt ? (exportName.trim() || currentProject.name || 'Export') : undefined,
        { duck_music: duckMusic, normalize_loudness: normalizeLoudness, video_filter: filterSteps },
      );
      if (result.queuedJob) {
        setExporting(false);
        setStatusMessage('');
        setProgress(0);
        await refreshQueue();
        return;
      }
      const blob = result.blob;
      if (result.savedPath) {
        setSavedLocalPath(result.savedPath);
        // Automatically open & highlight the saved file in macOS Finder / system file manager
        openFolderInSystem(result.savedPath).catch(() => {});
      } else {
        // Fallback: trigger browser web download only if not saved directly to local disk
        const isZip =
          blob.type === 'application/zip' || (splitEnabled && parseFloat(splitDuration) > 0);
        const ext = isZip ? 'zip' : 'mp4';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = result.filename || `${safeName}${isZip ? '_parts' : ''}.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
      setDone(true);
      toast({ tone: 'success', title: 'Export finished', detail: result.savedPath ? `${label} — saved to ${result.savedPath}` : label });
      setTimeout(() => setDone(false), 10000);
    } catch (e: any) {
      const msg = e?.response?.data
        ? (await e.response.data.text?.()) || 'Export failed'
        : e.message || 'Export failed';
      setError(typeof msg === 'string' ? msg : 'Export failed');
      if (!queueIt) toast({ tone: 'error', title: 'Export failed', detail: `${label} — ${typeof msg === 'string' ? msg : 'Export failed'}` });
    }
    setExporting(false);
  };

  // the volume slider also sets what the timeline plays, so the two stay the same
  const setVolume = (v: number) => {
    setBgmVolume(v);
    if (currentProject?.id) {
      const key = audioSeparated ? `timeline-bgm-volume-${currentProject.id}` : `timeline-video-volume-${currentProject.id}`;
      localStorage.setItem(key, String(v));
    }
  };
  const setOffset = (v: number) => {
    setVoiceOffsetMs(v);
    if (currentProject?.id) localStorage.setItem(`export-voice-offset-${currentProject.id}`, String(v));
  };
  // A logo set here is the project's logo: saving it puts it on the video in the editor and
  // gives it its track on the timeline, the same as setting it from the player's Logo panel.
  const keepLogo = (patch: Partial<ReturnType<typeof loadLogoSettings>>) => {
    if (!currentProject?.id) return;
    saveLogoSettings(currentProject.id, { ...loadLogoSettings(currentProject.id), ...patch });
  };
  const chooseFolder = (path: string) => {
    setExportFolder(path);
    localStorage.setItem('meatika_export_folder', path);
  };
  const pendingRenders = renderJobs.filter((j) => j.status === 'queued' || j.status === 'rendering').length;
  // what is switched on under "More options", so it is never forgotten while folded away
  const moreInUse = [
    trimEnabled && 'trimmed',
    splitEnabled && 'split',
    exportLogoEnabled && exportLogoUrl && 'logo',
    voiceOffsetMs !== 0 && `voice ${voiceOffsetMs > 0 ? '+' : ''}${voiceOffsetMs} ms`,
  ].filter(Boolean) as string[];
  const sectionClass = 'p-4 rounded-2xl bg-[var(--s2)] border border-white/5 space-y-3';
  const sectionTitle = (n: number, text: string, aside?: string) => (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-2">
        <span className="w-5 h-5 rounded-full bg-blue-600/20 text-blue-300 text-[10px] font-bold flex items-center justify-center">{n}</span>
        <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">{text}</span>
      </span>
      {aside && <span className="text-[10px] font-mono text-emerald-400">{aside}</span>}
    </div>
  );

  if (!open) return null;

  const hasVideo = !!currentProject?.video_path;
  const hasSegments = (currentProject?.segments?.length ?? 0) > 0;
  const fmt = (s: number) =>
    `${Math.floor(s / 60)}:${Math.floor(s % 60)
      .toString()
      .padStart(2, '0')}`;
  const videoSrc = currentProject
    ? `/uploads/${currentProject.id}/${currentProject.video_path?.split('/').pop()}`
    : '';

  const parsedStart = trimEnabled ? Math.max(0, parseFloat(startTime) || 0) : 0;
  const parsedEnd = trimEnabled
    ? Math.min(
        previewTlDuration || 999999,
        Math.max(parsedStart + 0.1, parseFloat(endTime) || previewTlDuration || 0)
      )
    : previewTlDuration || 0;
  const activeExportDuration = Math.max(1, parsedEnd - parsedStart);

  const estimatedSizeMb = Math.max(
    1.5,
    Math.round(
      (activeExportDuration *
        (quality === 'compact' ? 0.28 : quality === 'high' ? 0.82 : 0.48)) *
        10
    ) / 10
  );

  return (
    <div
      className={
        inline
          ? 'w-full h-full flex flex-col bg-[var(--s1)] text-white select-none font-sans overflow-hidden'
          : 'fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/85 backdrop-blur-md animate-in fade-in duration-200'
      }
      onClick={!inline ? onClose : undefined}
    >
      <div
        className={`bg-[var(--s2)] text-[#e1e3e6] flex flex-col relative ${
          inline
            ? 'w-full h-full'
            : 'border border-white/10 rounded-3xl w-full max-w-5xl shadow-2xl overflow-hidden max-h-[94vh]'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: what is being exported, and what kind of export */}
        <div className="flex flex-col md:flex-row md:items-center justify-between px-5 py-3.5 border-b border-white/5 gap-3 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-lg shrink-0">
              <Download className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-white">Export</h2>
              {currentProject?.name && (
                <p className="text-[11px] text-zinc-400 truncate" title={currentProject.name}>
                  <span className="text-zinc-200 font-semibold">{nameParts(currentProject.name).tail}</span>
                  {nameParts(currentProject.name).head && <span> · {nameParts(currentProject.name).head}</span>}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1 bg-[var(--s1)] p-1 rounded-xl border border-white/5" role="tablist">
              {[
                { id: 'video', label: 'Video', icon: Film },
                { id: 'metadata', label: 'Titles & tags', icon: Sparkles },
                { id: 'subtitles', label: 'Subtitles', icon: FileText },
                { id: 'audio', label: 'Audio', icon: Music },
              ].map((t) => {
                const Icon = t.icon;
                const isActive = tab === t.id;
                return (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setTab(t.id as any)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                      isActive ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>
            {!inline && (
              <button
                onClick={onClose}
                aria-label="Close"
                className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* SUBTITLE EXPORT TAB */}
          {tab === 'subtitles' && (
            <div className="space-y-4 max-w-xl mx-auto py-4">
              <div className="text-center space-y-1 mb-6">
                <h3 className="text-sm font-bold text-white">Download Subtitle Files</h3>
                <p className="text-xs text-zinc-400">
                  Export timestamps and text in standard subtitle formats for video editors
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {[
                  {
                    fmt: 'srt',
                    label: 'SubRip Subtitle',
                    ext: '.SRT',
                    desc: 'Standard for Premiere, CapCut, DaVinci, Final Cut',
                    badge: 'Universal',
                  },
                  {
                    fmt: 'vtt',
                    label: 'WebVTT File',
                    ext: '.VTT',
                    desc: 'HTML5 Web video & online player subtitles',
                    badge: 'Web',
                  },
                  {
                    fmt: 'txt',
                    label: 'Plain Text Script',
                    ext: '.TXT',
                    desc: 'Clean sentence text without timecodes',
                    badge: 'Text',
                  },
                  {
                    fmt: 'json',
                    label: 'Structured JSON',
                    ext: '.JSON',
                    desc: 'Full API dataset with speaker and word times',
                    badge: 'Dev',
                  },
                ].map((item) => (
                  <button
                    key={item.fmt}
                    onClick={() => handleSubtitleExport(item.fmt)}
                    disabled={!hasSegments}
                    className="p-4 rounded-2xl bg-[var(--s3)] border border-[var(--s4)] hover:border-white/10 hover:bg-[var(--s4)] text-left transition-all group disabled:opacity-30 disabled:cursor-not-allowed shadow-sm"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-white group-hover:text-zinc-200 transition-colors">
                        {item.label}
                      </span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/10 text-zinc-200 font-semibold">
                        {item.ext}
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 leading-relaxed mb-3">{item.desc}</p>
                    <div className="flex items-center text-[11px] font-bold text-zinc-400 group-hover:translate-x-1 transition-transform gap-1">
                      <Download className="w-3.5 h-3.5" /> Download {item.ext}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* AUDIO TAB — the separated tracks, as files */}
          {tab === 'audio' && (
            <div className="space-y-4 max-w-xl mx-auto py-4">
              <div className="text-center space-y-1 mb-6">
                <h3 className="text-sm font-bold text-white">Audio tracks</h3>
                <p className="text-xs text-zinc-400">The film’s own voices and its background music, as separate files</p>
              </div>

              {!audioSeparated && (
                <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
                  The music has not been isolated for this project yet. Isolate it from the timeline (the music track) and both files appear here.
                </p>
              )}

              <div className="space-y-3">
                {[
                  { id: 'vocals', title: 'Original voices', desc: 'The film’s dialogue with the music taken out', url: vocalsUrl },
                  { id: 'bgm', title: 'Background music', desc: 'The film’s music and sound with the voices taken out — what the dub plays over', url: bgmUrl },
                ].map((a) => (
                  <div key={a.id} className="p-4 rounded-2xl bg-[var(--s3)] border border-[var(--s4)] flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <span className="text-xs font-bold text-white">{a.title}</span>
                      <p className="text-[11px] text-zinc-400 mt-0.5">{a.desc}</p>
                    </div>
                    <a
                      href={a.url || undefined}
                      download={`${(exportName || currentProject?.name || 'audio').replace(/[\\/:*?"<>|]/g, '')} - ${a.id === 'vocals' ? 'voices' : 'music'}.${(a.url || '').split('?')[0].split('.').pop() || 'flac'}`}
                      aria-disabled={!a.url}
                      onClick={(e) => { if (!a.url) e.preventDefault(); }}
                      className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 shrink-0 transition-colors ${
                        a.url ? 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer' : 'bg-white/5 text-zinc-500 cursor-not-allowed'
                      }`}
                    >
                      <Download className="w-3.5 h-3.5" /> Download
                    </a>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-zinc-500 text-center">
                For the finished dub as sound only, export the video and take its audio — a separate audio export is not built yet.
              </p>
            </div>
          )}

          {/* TITLES & TAGS TAB */}
          {tab === 'metadata' && currentProject && (
            <TitlesTagsPanel
              projectId={currentProject.id}
              hasCaptions={(currentProject.segments || []).some((seg) => (seg.text || '').trim())}
              videoSrc={videoSrc || undefined}
              onUseAsFileName={(title: string) => setExportName(title)}
            />
          )}

          {/* VIDEO TAB */}
          {tab === 'video' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
              {/* Left: the preview, what will be made, and how the render is going — kept in view */}
              <div className="lg:col-span-5 space-y-3 lg:sticky lg:top-0">
                <div className="w-full rounded-2xl overflow-hidden border border-white/10 bg-[var(--s0)] flex flex-col relative group">
                  <div className="w-full bg-[var(--s0)] p-3 flex items-center justify-center min-h-[300px]">
                    <div
                      ref={previewBoxRef}
                      className="relative cursor-pointer bg-black rounded-xl flex items-center justify-center overflow-hidden mx-auto border border-white/10"
                      style={{
                        aspectRatio: `${selectedPreset.width} / ${selectedPreset.height}`,
                        height: '300px',
                        maxWidth: '100%',
                      }}
                      onClick={togglePreview}
                    >
                      {scaleMode === 'blur' && (
                        <video
                          ref={previewBgRef}
                          src={videoSrc}
                          className="absolute inset-0 w-full h-full object-cover blur-2xl scale-125 opacity-60 pointer-events-none"
                          // the blurred backdrop is the same film, so it carries the colour filter too
                          style={filterSteps.length ? { filter: `blur(40px) ${cssFilter(filterSteps)}` } : undefined}
                          preload="metadata"
                          muted
                        />
                      )}
                      <video
                        ref={previewRef}
                        src={videoSrc}
                        className={`relative z-10 ${
                          scaleMode === 'fill'
                            ? 'w-full h-full object-cover object-center'
                            : 'max-w-full max-h-full object-contain object-center'
                        }`}
                        style={{ filter: cssFilter(filterSteps) }}
                        preload="metadata"
                        muted={previewFilmSilent}
                      />

                      {/* the captions as they will be burned in */}
                      {burnSubtitles &&
                        (() => {
                          const segs = currentProject?.segments || [];
                          const seg = segs.find((s) => currentSourceTime >= s.start_time && currentSourceTime < s.end_time);
                          return seg ? (
                            <div className="absolute inset-0 pointer-events-none z-20 overflow-hidden">
                              <SubtitleOverlay text={seg.text} style={subtitleStyle} frameHeight={previewBoxH} />
                            </div>
                          ) : null;
                        })()}

                      {!previewPlaying && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/30 pointer-events-none">
                          <div className="w-11 h-11 rounded-2xl bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center text-white transition-transform group-hover:scale-110">
                            <Play className="w-5 h-5 ml-0.5" />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="px-3 py-2.5 bg-[var(--s2)] border-t border-white/5 flex items-center gap-3">
                    <button
                      onClick={togglePreview}
                      aria-label={previewPlaying ? 'Pause preview' : 'Play preview'}
                      className="w-7 h-7 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-zinc-200 hover:text-white transition-colors shrink-0 cursor-pointer"
                    >
                      {previewPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
                    </button>
                    <div className="flex-1 h-1.5 bg-[var(--s4)] rounded-full cursor-pointer relative" onClick={seekPreview}>
                      <div
                        className="h-full bg-blue-500 rounded-full"
                        style={{ width: `${previewTlDuration > 0 ? (previewTime / previewTlDuration) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-zinc-400 font-mono shrink-0">
                      {fmt(previewTime)} / {fmt(previewTlDuration)}
                    </span>
                  </div>
                </div>

                {/* What you will get, in one place */}
                <div className="rounded-2xl bg-[var(--s2)] border border-white/5 p-3.5">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-2">You will get</p>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[11px]">
                    <dt className="text-zinc-500">Format</dt>
                    <dd className="text-zinc-200 truncate">
                      {PLATFORM_LABELS[selectedPreset.id] || selectedPreset.name} · {selectedPreset.ratio}
                      {selectedPreset.id !== 'custom' && <span className="text-zinc-500"> · {selectedPreset.res}</span>}
                    </dd>
                    <dt className="text-zinc-500">Length</dt>
                    <dd className="text-zinc-200">
                      {fmt(activeExportDuration)}
                      {trimEnabled && <span className="text-zinc-500"> · {fmt(parsedStart)}–{fmt(parsedEnd)}</span>}
                      {splitEnabled && <span className="text-zinc-500"> · in {splitDuration}s parts (.zip)</span>}
                    </dd>
                    <dt className="text-zinc-500">Size</dt>
                    <dd className="text-zinc-200" title="The most this export can come to. A source that is already small exports smaller.">
                      up to ~{estimatedSizeMb} MB <span className="text-zinc-500">· {QUALITY_LABELS[quality]}</span>
                    </dd>
                    <dt className="text-zinc-500">Captions</dt>
                    <dd className="text-zinc-200">{burnSubtitles ? 'Burned in' : 'None'}</dd>
                    <dt className="text-zinc-500">Sound</dt>
                    <dd className="text-zinc-200 truncate">{AUDIO_LABELS[bgAudio]}</dd>
                    <dt className="text-zinc-500">Saved as</dt>
                    <dd className="text-zinc-200 truncate" title={`${exportFolder ? `${exportFolder}/` : ''}${exportName || 'export'}.mp4`}>
                      {exportName || 'export'}.mp4
                      {exportFolder && <span className="text-zinc-500"> in {exportFolder.split('/').filter(Boolean).pop()}</span>}
                    </dd>
                  </dl>
                </div>

                {/* How the render is going */}
                {exporting && (
                  <div role="status" className="p-3.5 rounded-2xl bg-blue-600/10 border border-blue-500/30 space-y-2">
                    <div className="flex items-center justify-between text-xs gap-2">
                      <span className="font-semibold text-zinc-100 flex items-center gap-2 min-w-0">
                        <Loader2 className="w-4 h-4 animate-spin text-blue-300 shrink-0" />
                        <span className="truncate">{statusMessage || 'Rendering…'}</span>
                      </span>
                      <span className="font-mono font-bold text-white shrink-0">{progress}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-black/40 rounded-full overflow-hidden">
                      <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${Math.max(2, progress)}%` }} />
                    </div>
                  </div>
                )}
                {error && (
                  <div role="alert" className="p-3 rounded-2xl bg-red-950/60 border border-red-800 text-red-200 text-xs leading-relaxed">{error}</div>
                )}
                {done && (
                  <div role="status" className="p-3.5 rounded-2xl bg-emerald-950/50 border border-emerald-700/60 text-emerald-100 text-xs space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 font-bold"><CheckCircle2 className="w-4 h-4 text-emerald-400" /> Video saved</span>
                      {savedLocalPath && (
                        <button
                          type="button"
                          onClick={() => openFolderInSystem(savedLocalPath)}
                          className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold flex items-center gap-1 cursor-pointer"
                        >
                          <FolderOpen className="w-3.5 h-3.5" /> Show in Finder
                        </button>
                      )}
                    </div>
                    {savedLocalPath && <p className="text-[11px] text-emerald-300/90 font-mono truncate" title={savedLocalPath}>{savedLocalPath}</p>}
                    <button
                      type="button"
                      onClick={() => setTab('metadata')}
                      className="w-full px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-[11px] font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Sparkles className="w-3.5 h-3.5" /> Next: titles & tags to post it with
                    </button>
                  </div>
                )}
              </div>

              {/* Right: the choices, most-used first */}
              <div className="lg:col-span-7 space-y-3.5">
                {/* 1. Format and framing */}
                <section className={sectionClass}>
                  {sectionTitle(1, 'Format')}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {PLATFORM_PRESETS.map((p) => {
                      const isActive = selectedPlatform === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setSelectedPlatform(p.id)}
                          aria-pressed={isActive}
                          className={`flex items-center gap-2.5 p-2.5 rounded-xl border text-left transition-colors cursor-pointer ${
                            isActive ? 'bg-blue-600/15 border-blue-500/70 ring-1 ring-blue-500/30' : 'bg-[var(--s3)] border-white/5 hover:border-zinc-600'
                          }`}
                        >
                          {/* the frame's shape, drawn */}
                          <span className="w-7 h-7 flex items-center justify-center shrink-0">
                            <span
                              className={`block rounded-[3px] border-2 ${isActive ? 'border-blue-300' : 'border-zinc-500'}`}
                              style={p.id === 'custom'
                                ? { width: 18, height: 18, borderStyle: 'dashed' }
                                : p.width >= p.height
                                  ? { width: 26, height: Math.max(8, Math.round((26 * p.height) / p.width)) }
                                  : { height: 26, width: Math.max(8, Math.round((26 * p.width) / p.height)) }}
                            />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-xs font-semibold text-white truncate">{PLATFORM_LABELS[p.id] || p.name}</span>
                            <span className="block text-[10px] text-zinc-400">{p.id === 'custom' ? 'Same as the video' : p.ratio}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    <span className="text-[11px] text-zinc-400">When the video is a different shape</span>
                    <div className="flex gap-1 bg-[var(--s3)] border border-white/5 rounded-xl p-1">
                      {[
                        { id: 'blur', label: 'Blur the edges' },
                        { id: 'fit', label: 'Black bars' },
                        { id: 'fill', label: 'Crop to fill' },
                      ].map((mode) => (
                        <button
                          key={mode.id}
                          type="button"
                          onClick={() => setScaleMode(mode.id as any)}
                          aria-pressed={scaleMode === mode.id}
                          className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors cursor-pointer ${
                            scaleMode === mode.id ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-white hover:bg-white/5'
                          }`}
                        >
                          {mode.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {filterSteps.length > 0 && (
                    <p className="text-[11px] text-blue-200/90 bg-blue-600/10 border border-blue-500/30 rounded-xl px-2.5 py-1.5">
                      Colour filter: <span className="font-semibold">{FILTER_PRESETS.find((f) => f.id === videoFilter.preset && f.id !== 'none')?.name || 'Adjusted'}</span>
                      {' '}— rendered in, as in the preview. Change it with Filter above the player.
                    </p>
                  )}
                </section>

                {/* 2. Quality */}
                <section className={sectionClass}>
                  {sectionTitle(2, 'Quality', `up to ~${estimatedSizeMb} MB`)}
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: 'compact', label: 'Small file', desc: 'Quick to upload · ~2 Mbps' },
                      { id: 'standard', label: 'Standard', desc: 'Sharp on phones · ~4 Mbps' },
                      { id: 'high', label: 'Best', desc: 'Most detail · ~6.5 Mbps' },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setQuality(opt.id as any)}
                        aria-pressed={quality === opt.id}
                        className={`p-2.5 rounded-xl border text-left transition-colors cursor-pointer ${
                          quality === opt.id ? 'bg-blue-600/15 border-blue-500/70 ring-1 ring-blue-500/30' : 'bg-[var(--s3)] border-white/5 hover:border-zinc-600'
                        }`}
                      >
                        <span className="block text-xs font-semibold text-white">{opt.label}</span>
                        <span className="block text-[10px] text-zinc-400 mt-0.5">{opt.desc}</span>
                      </button>
                    ))}
                  </div>
                </section>

                {/* 3. Captions and sound */}
                <section className={sectionClass}>
                  {sectionTitle(3, 'Captions & sound')}
                  <div className="flex flex-wrap gap-2">
                    <label className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--s3)] border border-white/5 cursor-pointer hover:border-white/10">
                      <input type="checkbox" checked={burnSubtitles} onChange={(e) => setBurnSubtitles(e.target.checked)} className="accent-blue-500 cursor-pointer" />
                      <span className="text-xs text-zinc-200">Burn the captions in</span>
                    </label>
                    {blurAreas.length > 0 && (
                      <label className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--s3)] border border-white/5 cursor-pointer hover:border-white/10">
                        <input type="checkbox" checked={applyBlur} onChange={(e) => setApplyBlur(e.target.checked)} className="accent-blue-500 cursor-pointer" />
                        <span className="text-xs text-zinc-200">Blur {blurAreas.length} area{blurAreas.length > 1 ? 's' : ''}</span>
                      </label>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {(Object.keys(AUDIO_LABELS) as (keyof typeof AUDIO_LABELS)[]).map((id) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setBgAudio(id as any)}
                        aria-pressed={bgAudio === id}
                        className={`p-2.5 rounded-xl border text-left transition-colors cursor-pointer ${
                          bgAudio === id ? 'bg-blue-600/15 border-blue-500/70 ring-1 ring-blue-500/30' : 'bg-[var(--s3)] border-white/5 hover:border-zinc-600'
                        }`}
                      >
                        <span className="block text-xs font-semibold text-white">{AUDIO_LABELS[id]}</span>
                        <span className="block text-[10px] text-zinc-400 mt-0.5">{AUDIO_HINTS[id]}</span>
                      </button>
                    ))}
                  </div>

                  {bgAudio !== 'none' && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-zinc-300">{bgAudio === 'original_clean' ? 'Video volume' : 'Music volume'}</span>
                        <span className="font-mono text-zinc-300">{Math.round(bgmVolume * 100)}%</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <input
                          type="range" min="0" max="1" step="0.05" value={bgmVolume}
                          onChange={(e) => setVolume(Number(e.target.value))}
                          aria-label="Background volume"
                          className="flex-1 h-1.5 bg-zinc-800 accent-blue-500 rounded-lg cursor-pointer"
                        />
                        <div className="flex gap-1">
                          {[0.2, 0.35, 0.6, 1].map((v) => (
                            <button
                              key={v}
                              type="button"
                              onClick={() => setVolume(v)}
                              className={`px-1.5 py-0.5 rounded-md text-[10px] font-semibold cursor-pointer ${
                                Math.abs(bgmVolume - v) < 0.04 ? 'bg-blue-600 text-white' : 'bg-[var(--s3)] text-zinc-400 hover:text-white'
                              }`}
                            >
                              {Math.round(v * 100)}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                        {bgAudio !== 'original_clean' && (
                          <label className="flex items-center gap-2 cursor-pointer" title="Music dips while the dubbed voice speaks and returns in the gaps">
                            <input type="checkbox" checked={duckMusic} onChange={(e) => setDuckMusic(e.target.checked)} className="accent-blue-500 cursor-pointer" />
                            <span className="text-[11px] text-zinc-300">Lower the music under voices</span>
                          </label>
                        )}
                        <label className="flex items-center gap-2 cursor-pointer" title="Match the loudness streaming platforms expect (-16 LUFS)">
                          <input type="checkbox" checked={normalizeLoudness} onChange={(e) => setNormalizeLoudness(e.target.checked)} className="accent-blue-500 cursor-pointer" />
                          <span className="text-[11px] text-zinc-300">Even out loudness for social media</span>
                        </label>
                      </div>
                    </div>
                  )}
                </section>

                {/* 4. Where it goes */}
                <section className={sectionClass}>
                  {sectionTitle(4, 'Save as')}
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={exportName}
                      onChange={(e) => {
                        const val = e.target.value;
                        setExportName(val);
                        if (currentProject?.id) {
                          if (val.trim()) localStorage.setItem(`meatika_export_name_${currentProject.id}`, val.trim());
                          else localStorage.removeItem(`meatika_export_name_${currentProject.id}`);
                        }
                      }}
                      aria-label="File name"
                      className="flex-1 min-w-0 bg-[var(--s3)] border border-white/10 focus:border-blue-500 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
                      placeholder="File name"
                    />
                    <span className="text-xs text-zinc-400 font-mono shrink-0">.mp4</span>
                    <button
                      type="button"
                      onClick={() => {
                        if (!currentProject) return;
                        setExportName(defaultExportName(currentProject));
                        localStorage.removeItem(`meatika_export_name_${currentProject.id}`);
                      }}
                      className="text-[11px] text-zinc-500 hover:text-zinc-200 shrink-0 cursor-pointer"
                      title="Use the project's name"
                    >
                      Reset
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative flex-1 min-w-[200px]">
                      <Folder className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={exportFolder}
                        onChange={(e) => chooseFolder(e.target.value)}
                        aria-label="Folder"
                        className="w-full bg-[var(--s3)] border border-white/10 focus:border-blue-500 rounded-xl pl-8 pr-3 py-2 text-[11px] text-zinc-200 font-mono focus:outline-none"
                        placeholder="/Users/you/Downloads"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={async () => { const selected = await selectFolderInSystem(); if (selected) chooseFolder(selected); }}
                      className="px-3 py-2 bg-[var(--s3)] border border-white/10 hover:bg-white/5 text-zinc-200 rounded-xl text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer"
                    >
                      <FolderPlus className="w-3.5 h-3.5" /> Choose…
                    </button>
                    {exportFolder && (
                      <button
                        type="button"
                        onClick={() => openFolderInSystem(exportFolder)}
                        title="Open this folder in Finder"
                        aria-label="Open the folder in Finder"
                        className="p-2 bg-[var(--s3)] border border-white/10 hover:bg-white/5 text-zinc-300 rounded-xl cursor-pointer"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {([['Downloads', defaultFolders.downloads], ['Desktop', defaultFolders.desktop], ['Movies', defaultFolders.movies]] as [string, string | undefined][])
                      .filter(([, path]) => !!path)
                      .map(([label, path]) => (
                        <button
                          key={label}
                          type="button"
                          onClick={() => chooseFolder(path!)}
                          className={`text-[10px] px-2 py-0.5 rounded-md cursor-pointer ${
                            exportFolder === path ? 'bg-blue-600 text-white font-semibold' : 'bg-white/5 text-zinc-400 hover:text-zinc-200'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                  </div>
                </section>

                {/* More: the options most exports never touch */}
                <section className="rounded-2xl bg-[var(--s2)] border border-white/5">
                  <button
                    type="button"
                    onClick={() => setShowMore((v) => !v)}
                    aria-expanded={showMore}
                    className="w-full flex items-center justify-between px-4 py-3 text-left cursor-pointer"
                  >
                    <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">More options</span>
                    <span className="flex items-center gap-2 text-[11px] text-zinc-500">
                      {moreInUse.length > 0 ? <span className="text-blue-300">{moreInUse.join(' · ')}</span> : 'Trim, split, logo, voice timing'}
                      <span className={`transition-transform ${showMore ? 'rotate-180' : ''}`}>▾</span>
                    </span>
                  </button>
                  {showMore && (
                    <div className="px-4 pb-4 space-y-4 border-t border-white/5 pt-3">
                      {/* Trim */}
                      <div className="space-y-2">
                        <label className="flex items-center justify-between gap-2 cursor-pointer">
                          <span className="flex items-center gap-2 text-xs font-semibold text-white"><Scissors className="w-3.5 h-3.5 text-zinc-400" /> Export only part of the video</span>
                          <input
                            type="checkbox"
                            checked={trimEnabled}
                            onChange={(e) => {
                              setTrimEnabled(e.target.checked);
                              if (e.target.checked && (!endTime || endTime === '0')) setEndTime(previewTlDuration.toFixed(1));
                            }}
                            className="accent-blue-500 cursor-pointer"
                          />
                        </label>
                        {trimEnabled && (
                          <div className="space-y-2 pl-5">
                            <div className="flex flex-wrap gap-1">
                              {[
                                { label: 'First minute', s: 0, e: Math.min(60, previewTlDuration || 60) },
                                { label: 'First 3 min', s: 0, e: Math.min(180, previewTlDuration || 180) },
                                { label: 'Whole video', s: 0, e: previewTlDuration || 0 },
                              ].map((pre) => (
                                <button key={pre.label} type="button" onClick={() => { setStartTime(String(pre.s)); setEndTime(pre.e.toFixed(1)); }}
                                  className="px-2 py-1 rounded-lg bg-[var(--s3)] hover:bg-[var(--s4)] text-[10px] text-zinc-300 cursor-pointer">
                                  {pre.label}
                                </button>
                              ))}
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              {([['From', startTime, setStartTime], ['To', endTime, setEndTime]] as [string, string, (v: string) => void][]).map(([label, value, setter]) => (
                                <div key={label} className="space-y-1">
                                  <div className="flex items-center justify-between text-[10px] text-zinc-400">
                                    <span>{label} (seconds)</span>
                                    <button type="button" onClick={() => setter(previewTime.toFixed(1))} className="text-blue-400 hover:text-blue-300 cursor-pointer">
                                      use {fmt(previewTime)}
                                    </button>
                                  </div>
                                  <input type="number" step="0.5" min="0" value={value} onChange={(e) => setter(e.target.value)}
                                    className="w-full bg-[var(--s3)] border border-white/10 focus:border-blue-500 rounded-lg px-2.5 py-1 text-xs text-white font-mono focus:outline-none" />
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Split */}
                      <div className="space-y-2">
                        <label className="flex items-center justify-between gap-2 cursor-pointer">
                          <span className="flex items-center gap-2 text-xs font-semibold text-white"><SplitSquareHorizontal className="w-3.5 h-3.5 text-zinc-400" /> Cut into short videos (.zip)</span>
                          <input type="checkbox" checked={splitEnabled} onChange={(e) => setSplitEnabled(e.target.checked)} className="accent-blue-500 cursor-pointer" />
                        </label>
                        {splitEnabled && (
                          <div className="flex gap-1 pl-5">
                            {['60', '90', '180', '300'].map((sec) => (
                              <button key={sec} type="button" onClick={() => setSplitDuration(sec)}
                                className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold cursor-pointer ${splitDuration === sec ? 'bg-blue-600 text-white' : 'bg-[var(--s3)] text-zinc-400 hover:text-white'}`}>
                                {Number(sec) >= 60 && Number(sec) % 60 === 0 ? `${Number(sec) / 60} min` : `${sec} s`}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Logo */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={exportLogoEnabled} onChange={(e) => { setExportLogoEnabled(e.target.checked); keepLogo({ enabled: e.target.checked, url: exportLogoUrl }); }} disabled={!exportLogoUrl} className="accent-blue-500 cursor-pointer" />
                            <span className="text-xs font-semibold text-white">Logo on the video</span>
                          </label>
                          <div className="flex items-center gap-2">
                            {exportLogoUrl && <img src={exportLogoUrl} alt="" className="h-6 w-auto max-w-[80px] object-contain rounded bg-black/40" />}
                            <input
                              ref={exportLogoInputRef}
                              type="file"
                              accept="image/png,image/jpeg,image/webp"
                              className="hidden"
                              onChange={async (e) => {
                                const file = e.target.files?.[0];
                                if (!file || !currentProject?.id) return;
                                setUploadingLogo(true);
                                try {
                                  const res = await uploadProjectLogo(currentProject.id, file);
                                  setExportLogoUrl(res.url);
                                  setExportLogoEnabled(true);
                                  keepLogo({ url: res.url, enabled: true });
                                } catch {
                                  /* upload failed; keep the previous logo */
                                } finally {
                                  setUploadingLogo(false);
                                  if (exportLogoInputRef.current) exportLogoInputRef.current.value = '';
                                }
                              }}
                            />
                            <button type="button" onClick={() => exportLogoInputRef.current?.click()} disabled={uploadingLogo}
                              className="px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-[11px] text-zinc-300 hover:text-white cursor-pointer disabled:opacity-50">
                              {uploadingLogo ? 'Uploading…' : exportLogoUrl ? 'Replace' : 'Upload'}
                            </button>
                          </div>
                        </div>
                        {exportLogoEnabled && exportLogoUrl && (
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pl-5">
                            <select value={exportLogoPosition} onChange={(e) => { setExportLogoPosition(e.target.value); keepLogo({ position: e.target.value as any }); }}
                              className="bg-[var(--s3)] border border-white/5 rounded-lg px-2 py-1.5 text-[11px] text-zinc-200 focus:outline-none focus:border-blue-500">
                              <option value="top_left">Top left</option>
                              <option value="top_right">Top right</option>
                              <option value="bottom_left">Bottom left</option>
                              <option value="bottom_right">Bottom right</option>
                              <option value="center">Centre</option>
                            </select>
                            <label className="flex items-center gap-2 text-[11px] text-zinc-400">
                              Size
                              <input type="range" min={5} max={40} value={exportLogoScalePct} onChange={(e) => { setExportLogoScalePct(Number(e.target.value)); keepLogo({ scale_pct: Number(e.target.value) }); }} className="flex-1 h-1 accent-blue-500 cursor-pointer" />
                              <span className="font-mono text-zinc-300 w-9 text-right">{exportLogoScalePct}%</span>
                            </label>
                            <label className="flex items-center gap-2 text-[11px] text-zinc-400">
                              Opacity
                              <input type="range" min={10} max={100} value={Math.round(exportLogoOpacity * 100)} onChange={(e) => { setExportLogoOpacity(Number(e.target.value) / 100); keepLogo({ opacity: Number(e.target.value) / 100 }); }} className="flex-1 h-1 accent-blue-500 cursor-pointer" />
                              <span className="font-mono text-zinc-300 w-9 text-right">{Math.round(exportLogoOpacity * 100)}%</span>
                            </label>
                          </div>
                        )}
                      </div>

                      {/* Voice timing */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-white">Voice timing</span>
                          <span className="font-mono text-[11px] text-zinc-300">
                            {voiceOffsetMs === 0 ? 'On time' : voiceOffsetMs > 0 ? `${voiceOffsetMs} ms later` : `${-voiceOffsetMs} ms earlier`}
                          </span>
                        </div>
                        <input type="range" min="-500" max="800" step="50" value={voiceOffsetMs} onChange={(e) => setOffset(Number(e.target.value))}
                          aria-label="Voice timing" className="w-full h-1.5 bg-zinc-800 accent-blue-500 rounded-lg cursor-pointer" />
                        <div className="flex gap-1">
                          {[-200, 0, 150, 250, 400].map((v) => (
                            <button key={v} type="button" onClick={() => setOffset(v)}
                              className={`flex-1 py-1 text-[10px] font-mono rounded-lg cursor-pointer ${voiceOffsetMs === v ? 'bg-blue-600 text-white font-bold' : 'bg-[var(--s3)] text-zinc-400 hover:text-white'}`}>
                              {v === 0 ? '0' : v > 0 ? `+${v}` : v}
                            </button>
                          ))}
                        </div>
                        <p className="text-[10px] text-zinc-500">If the voices start before the captions appear, move them a little later (+150 or +250 ms).</p>
                      </div>
                    </div>
                  )}
                </section>

                {/* Exports already queued or done */}
                {renderJobs.length > 0 && (
                  <section className="rounded-2xl bg-[var(--s2)] border border-white/5 p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">
                        Export queue{pendingRenders ? ` · ${pendingRenders} waiting` : ''}
                      </span>
                      {renderJobs.some((j) => ['done', 'error', 'cancelled'].includes(j.status)) && (
                        <button onClick={async () => { await clearFinishedRenderJobs(); refreshQueue(); }} className="text-[11px] text-zinc-400 hover:text-white cursor-pointer">
                          Clear finished
                        </button>
                      )}
                    </div>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {renderJobs.map((job) => (
                        <div key={job.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[var(--s3)]">
                          <span className="text-[11px] text-zinc-200 truncate flex-1" title={job.error || job.label}>
                            {nameParts(job.label || '').tail || job.label}
                          </span>
                          <span className={`text-[10px] shrink-0 ${job.status === 'done' ? 'text-emerald-400' : job.status === 'error' ? 'text-red-400' : job.status === 'rendering' ? 'text-blue-300' : 'text-zinc-500'}`}>
                            {job.status === 'rendering' ? `${job.percent}%` : job.status === 'queued' ? 'waiting' : job.status === 'done' ? 'done' : job.status}
                          </span>
                          {job.status === 'done' && job.download_url && (
                            <a href={job.download_url} className="text-[11px] text-blue-400 hover:text-blue-300" title={job.saved_path || 'Download'}>Download</a>
                          )}
                          <button
                            onClick={async () => { await removeRenderJob(job.id); refreshQueue(); }}
                            className="text-zinc-500 hover:text-red-400 cursor-pointer"
                            aria-label={job.status === 'rendering' ? 'Stop this render' : 'Remove from list'}
                            title={job.status === 'rendering' ? 'Stop this render' : 'Remove from list'}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-white/5 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            {tab === 'video' && isPart && siblingParts.length > 1 && (
              <label className="flex items-center gap-2 cursor-pointer" title="Render every part with these settings, then stitch them into one file">
                <input type="checkbox" checked={joinAllParts} onChange={(e) => setJoinAllParts(e.target.checked)} disabled={exporting} className="accent-blue-500" />
                <span>Join all {siblingParts.length} parts into one video</span>
              </label>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            {!inline && (
              <button onClick={onClose} className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white hover:bg-white/5 cursor-pointer">
                Close
              </button>
            )}
            {tab === 'video' && (
              <button
                onClick={() => handleVideoExport(true)}
                disabled={exporting || !hasVideo || joinAllParts}
                className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-white/5 hover:bg-white/10 text-zinc-200 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                title="Render it in the background and keep working; renders run one after another"
              >
                Add to queue
              </button>
            )}
            {tab === 'video' && (
              <button
                onClick={() => (joinAllParts ? handleJoinExport() : handleVideoExport())}
                disabled={exporting || !hasVideo}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-950/50 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                {exporting ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Rendering {progress}%</>
                ) : done ? (
                  <><Check className="w-4 h-4" /> Export again</>
                ) : (
                  <><Download className="w-4 h-4" /> {joinAllParts ? `Export ${siblingParts.length} parts as one` : 'Export video'}</>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Dubbed voices for the preview. Only the lines around the preview position are loaded:
          a player per line for the whole film meant hundreds of them all downloading at once
          each time this window opened. */}
      {previewUsesStem && <audio ref={previewBgmRef} src={bgmUrl || undefined} preload="auto" />}
      {(currentProject?.segments || [])
        .filter(
          (s) =>
            s.audio_url &&
            s.end_time >= currentSourceTime - 2 &&
            s.start_time <= currentSourceTime + 12
        )
        .slice(0, 24)
        .map((seg) => (
          <audio
            key={`preview-ai-${seg.id}`}
            ref={(el) => {
              if (el) aiAudioRefs.current.set(seg.id, el);
              else aiAudioRefs.current.delete(seg.id);
            }}
            src={seg.audio_url}
            preload="auto"
          />
        ))}
    </div>
  );
}
