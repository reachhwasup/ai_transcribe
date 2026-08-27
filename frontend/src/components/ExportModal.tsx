import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useProjectStore } from '../stores/projectStore';
import {
  fetchPlatforms,
  exportVideoForPlatform,
  getExportUrl,
  translateSegments,
  getDefaultFolders,
  openFolderInSystem,
  selectFolderInSystem,
  generateMovieTitles,
  generateViralMetadata,
  generateSocialMediaScript,
  uploadProjectLogo,
  type PlatformPreset,
} from '../api/client';
import {
  X,
  Download,
  Loader2,
  Monitor,
  FileText,
  Check,
  Play,
  Pause,
  Scissors,
  SplitSquareHorizontal,
  Volume2,
  Captions,
  Crop,
  ChevronDown,
  Sparkles,
  Music,
  Film,
  Zap,
  Sliders,
  Settings2,
  CheckCircle2,
  Folder,
  FolderOpen,
  FolderPlus,
  Copy,
  Hash,
  MessageSquare,
  Tag,
  Flame,
  CheckCheck,
  Clock,
  RotateCcw,
  Layers,
  Image as ImageIcon,
  Upload,
} from 'lucide-react';
import { buildClipLayout, totalTimelineDuration, timelineToSource } from '../utils/clipTimemap';
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

const RESOLUTION_OPTIONS = [
  { id: '720p', label: '720p HD', desc: 'Fast render, smaller size' },
  { id: '1080p', label: '1080p Full HD', desc: 'Crystal clear (Recommended)' },
  { id: '4k', label: '4K Ultra HD', desc: 'Maximum crispness' },
];

const FPS_OPTIONS = ['30 FPS', '60 FPS'];

export default function ExportModal({ open, onClose, inline = false }: Props) {
  const { currentProject, videoClips, videoMuted, subtitleStyle, currentTime, aspectRatio, audioSeparated, bgmUrl } = useProjectStore();
  const previewRef = useRef<HTMLVideoElement>(null);
  const previewBgRef = useRef<HTMLVideoElement>(null);
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const [previewBoxH, setPreviewBoxH] = useState(320);
  const rafRef = useRef<number>(0);
  const aiAudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const clipLayout = useMemo(() => buildClipLayout(videoClips), [videoClips]);

  const [tab, setTab] = useState<'video' | 'subtitles' | 'audio' | 'metadata'>('video');
  const [selectedPlatform, setSelectedPlatform] = useState('tiktok');
  const [resolution, setResolution] = useState('1080p');
  const [fps, setFps] = useState('30 FPS');
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
  const [subtitleLanguage, setSubtitleLanguage] = useState('');
  const [translatedSegments, setTranslatedSegments] = useState<
    Array<{ start_time: number; end_time: number; text: string }>
  >([]);
  const [translating, setTranslating] = useState(false);

  // Viral Metadata & Publishing Tab State
  const [titlesList, setTitlesList] = useState<
    Array<{ category: string; category_label: string; title: string; description: string }>
  >([]);
  const [socialScriptData, setSocialScriptData] = useState<{
    platform?: string;
    hook?: string;
    viral_titles?: string[];
    captions?: {
      tiktok?: string;
      youtube_shorts?: string;
      facebook_reels?: string;
      full_description?: string;
    };
    hashtags?: string[];
    pinned_comment?: string;
    call_to_action?: string;
    suggested_sound?: string;
    cover_text_hook?: string;
    seo_keywords?: string[];
    thumbnail_text_ideas?: string[];
  } | null>(null);
  const [generatingMetadata, setGeneratingMetadata] = useState(false);
  const [metadataTone, setMetadataTone] = useState<'viral' | 'suspense' | 'comedy' | 'action' | 'emotional'>('viral');
  const [metadataPlatform, setMetadataPlatform] = useState<'all' | 'tiktok' | 'youtube' | 'facebook'>('all');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [videoFormat, setVideoFormat] = useState<'mp4' | 'mov' | 'webm'>('mp4');
  const [videoQuality, setVideoQuality] = useState<'1080p' | '4k' | '720p'>('1080p');
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
  const [exportLogoUrl, setExportLogoUrl] = useState('');
  const [exportLogoPosition, setExportLogoPosition] = useState('top_right');
  const [exportLogoScalePct, setExportLogoScalePct] = useState(15);
  const [exportLogoOpacity, setExportLogoOpacity] = useState(1.0);
  const [exportLogoXPct, setExportLogoXPct] = useState(85);
  const [exportLogoYPct, setExportLogoYPct] = useState(5);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const exportLogoInputRef = useRef<HTMLInputElement>(null);

  const handleExportLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProject) return;
    setUploadingLogo(true);
    try {
      const res = await uploadProjectLogo(currentProject.id, file);
      setExportLogoUrl(res.url);
      setExportLogoEnabled(true);
    } catch (err: any) {
      console.error('Failed to upload logo:', err);
    }
    setUploadingLogo(false);
  };

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

  useEffect(() => {
    if (
      !subtitleLanguage ||
      !currentProject ||
      subtitleLanguage === (currentProject.language || 'km')
    ) {
      setTranslatedSegments([]);
      return;
    }
    let cancelled = false;
    setTranslating(true);
    translateSegments(currentProject.id, subtitleLanguage)
      .then((segs) => {
        if (!cancelled) setTranslatedSegments(segs);
      })
      .catch(() => {
        if (!cancelled) setTranslatedSegments([]);
      })
      .finally(() => {
        if (!cancelled) setTranslating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [subtitleLanguage, currentProject?.id, currentProject?.language]);

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
        const base = (currentProject.video_filename || currentProject.name || 'meatika_export').replace(
          /\.[^.]+$/,
          ''
        );
        setExportName(base);
      }
    } else if (!open) {
      initializedOpenRef.current = false;
    }
  }, [open, currentProject]);

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

  const pauseAllAiAudio = useCallback(() => {
    aiAudioRefs.current.forEach((audio) => {
      if (!audio.paused) {
        audio.pause();
        audio.currentTime = 0;
      }
    });
  }, []);

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
      syncAiAudio(srcTime);
      rafRef.current = requestAnimationFrame(tick);
    };

    video.playbackRate = 1.0;
    video.play().catch(() => setPreviewPlaying(false));
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [previewPlaying, clipLayout, previewTlDuration, pauseAllAiAudio, scaleMode]);

  useEffect(() => {
    if (!previewPlaying) {
      if (previewRef.current && !previewRef.current.paused) previewRef.current.pause();
      pauseAllAiAudio();
    }
  }, [previewPlaying, pauseAllAiAudio]);

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
    },
    [clipLayout, previewTlDuration]
  );

  const handleSubtitleExport = (format: string) => {
    if (!currentProject) return;
    window.open(getExportUrl(currentProject.id, format, subtitleLanguage || undefined), '_blank');
  };

  const handleVideoExport = async () => {
    if (!currentProject) return;
    setExporting(true);
    setError('');
    setProgress(0);
    setStatusMessage('Preparing render...');
    setDone(false);
    try {
      setSavedLocalPath(null);
      const safeName = (exportName.trim() || currentProject.name || 'meatika_video')
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, '_');
      const targetFilename = `${safeName}.${videoFormat || 'mp4'}`;

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
        subtitleLanguage || undefined,
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
        },
      );
      const blob = result.blob;
      if (result.savedPath) {
        setSavedLocalPath(result.savedPath);
        // Automatically open & highlight the saved file in macOS Finder / system file manager
        openFolderInSystem(result.savedPath).catch(() => {});
      } else {
        // Fallback: trigger browser web download only if not saved directly to local disk
        const isZip =
          blob.type === 'application/zip' || (splitEnabled && parseFloat(splitDuration) > 0);
        const ext = isZip ? 'zip' : videoFormat || 'mp4';
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
      setTimeout(() => setDone(false), 10000);
    } catch (e: any) {
      const msg = e?.response?.data
        ? (await e.response.data.text?.()) || 'Export failed'
        : e.message || 'Export failed';
      setError(typeof msg === 'string' ? msg : 'Export failed');
    }
    setExporting(false);
  };

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
        (quality === 'compact' ? 0.28 : quality === 'high' ? 0.82 : 0.48) *
        (videoQuality === '4k' ? 1.6 : videoQuality === '720p' ? 0.7 : 1.0)) *
        10
    ) / 10
  );

  const copyToClipboard = (text: string, key: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2500);
  };

  const handleGenerateMetadata = async () => {
    if (!currentProject) return;
    setGeneratingMetadata(true);
    try {
      const [titlesRes, data] = await Promise.all([
        generateMovieTitles(currentProject.id, currentProject.name, currentProject.language || 'km').catch(() => []),
        generateViralMetadata(currentProject.id, {
          originalTitle: currentProject.name,
          language: currentProject.language || 'km',
          tone: metadataTone,
          platform: metadataPlatform,
        }).catch(() => null),
      ]);

      if (titlesRes && Array.isArray(titlesRes) && titlesRes.length > 0) {
        setTitlesList(titlesRes);
      } else if (data && data.titles && Array.isArray(data.titles)) {
        const categories = [
          { cat: 'viral_hook', label: 'ចំណងជើងទាក់ទាញ (Viral Hook)' },
          { cat: 'suspense', label: 'រន្ធត់ & ភ្ញាក់ផ្អើល (Suspense)' },
          { cat: 'comedy', label: 'កំប្លុកកំប្លែង (Humor)' },
          { cat: 'action', label: 'វាយប្រហារ (Action)' },
          { cat: 'short', label: 'ខ្លីខ្លឹមបែប TikTok (Short)' },
        ];
        const normalized = data.titles.map((t: any, idx: number) => {
          if (typeof t === 'string') {
            const c = categories[idx % categories.length];
            return {
              category: c.cat,
              category_label: c.label,
              title: t,
              description: 'ចំណងជើងទាក់ទាញបង្កើតការចង់ដឹងចង់ឃើញខ្ពស់',
            };
          }
          return {
            category: t.category || 'viral_hook',
            category_label: t.category_label || t.category || 'ចំណងជើងទាក់ទាញ',
            title: t.title || t.text || String(t || ''),
            description: t.description || '',
          };
        });
        setTitlesList(normalized);
      }

      if (data) {
        setSocialScriptData({
          hook: data.hook || '',
          captions: {
            full_description: (data as any).description || (data as any)?.captions?.full_description || (data as any)?.captions?.youtube_shorts || '',
            youtube_shorts: (data as any).description || (data as any)?.captions?.youtube_shorts || (data as any)?.captions?.full_description || '',
            tiktok: (data as any).short_caption || (data as any)?.captions?.tiktok || '',
          },
          hashtags: data.hashtags || [],
          seo_keywords: (data as any).seo_keywords || (data as any)?.seo_tags || [
            'សម្រាយរឿង',
            'សម្រាយរឿងពេញ',
            currentProject.name || 'សម្រាយរឿងថ្មី',
            'movie recap khmer',
            'រឿងចិននិយាយខ្មែរ',
            'ភាពយន្តភាគចិន',
            'ក្បាច់គុនបុរាណ',
            'cinema khmer',
            'film recap khmer',
            'រឿងពេញ 2024',
          ],
          pinned_comment: data.pinned_comment || '',
          call_to_action: data.call_to_action || '',
          thumbnail_text_ideas: (data as any).thumbnail_text_ideas || [
            'នឹកស្មានមិនដល់! 😱',
            'ការពិតត្រូវបានទម្លាយ! 💥',
            'កុំមើលរំលងឱ្យសោះ! 🔥',
            'ស្ដេចសង្គ្រាមត្រឡប់មកវិញ! ⚔️',
          ],
        } as any);
      }
    } catch (err) {
      console.error('Generate metadata failed:', err);
    } finally {
      setGeneratingMetadata(false);
    }
  };

  return (
    <div
      className={
        inline
          ? 'w-full h-full flex flex-col bg-[#0e1015] text-white select-none font-sans overflow-hidden'
          : 'fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/85 backdrop-blur-md animate-in fade-in duration-200'
      }
      onClick={!inline ? onClose : undefined}
    >
      <div
        className={`bg-[#111318] text-[#e1e3e6] flex flex-col relative ${
          inline
            ? 'w-full h-full'
            : 'border border-white/10 rounded-3xl w-full max-w-5xl shadow-2xl shadow-purple-950/20 overflow-hidden max-h-[94vh]'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Gradient Accent Line */}
        <div className="h-[2px] w-full bg-gradient-to-r from-pink-500 via-purple-500 to-indigo-500 shrink-0" />

        {/* Header Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between px-6 py-4 border-b border-white/5 bg-[#141720]/80 backdrop-blur-md gap-3 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-2xl bg-gradient-to-tr from-pink-600 via-purple-600 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-pink-500/25 shrink-0">
              <Download className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">
                  Export Studio
                </h2>
                <span className="text-[9px] font-mono font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-pink-500/15 text-pink-300 border border-pink-500/25">
                  Meatika Engine
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                {currentProject?.name ? `Project: ${currentProject.name} · ` : ''}Render MP4, subtitles, or create viral titles & tags
              </p>
            </div>
          </div>

          {/* Top Tabs Bar */}
          <div className="flex items-center gap-1.5 bg-[#0a0b0e]/80 p-1 rounded-2xl border border-white/5 shadow-inner">
            {[
              { id: 'video', label: '🎬 Render Video', icon: Film },
              { id: 'metadata', label: '🔥 Viral Titles & Tags', icon: Sparkles, badge: 'AI' },
              { id: 'subtitles', label: '💬 Subtitles', icon: FileText },
              { id: 'audio', label: '🎵 Audio Stems', icon: Music },
            ].map((t) => {
              const Icon = t.icon;
              const isActive = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id as any)}
                  className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                    isActive
                      ? t.id === 'metadata'
                        ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white shadow-md shadow-pink-500/25'
                        : 'bg-white text-black shadow-md'
                      : 'text-zinc-400 hover:text-white hover:bg-white/5'
                  }`}
                >
                  <Icon className={`w-3.5 h-3.5 ${t.id === 'metadata' && !isActive ? 'text-pink-400' : ''}`} />
                  <span>{t.label}</span>
                  {t.badge && !isActive && (
                    <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-pink-500/20 text-pink-300 border border-pink-500/30">
                      {t.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {!inline && (
            <button
              onClick={onClose}
              className="hidden sm:flex p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-6">
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
                    className="p-4 rounded-2xl bg-[#181a1f] border border-[#26282e] hover:border-pink-500/60 hover:bg-[#1e2128] text-left transition-all group disabled:opacity-30 disabled:cursor-not-allowed shadow-sm"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-white group-hover:text-pink-300 transition-colors">
                        {item.label}
                      </span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-pink-500/20 text-pink-300 font-semibold">
                        {item.ext}
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 leading-relaxed mb-3">{item.desc}</p>
                    <div className="flex items-center text-[11px] font-bold text-pink-400 group-hover:translate-x-1 transition-transform gap-1">
                      <Download className="w-3.5 h-3.5" /> Download {item.ext}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* AUDIO ONLY TAB */}
          {tab === 'audio' && (
            <div className="space-y-4 max-w-xl mx-auto py-4">
              <div className="text-center space-y-1 mb-6">
                <h3 className="text-sm font-bold text-white">Export Audio Tracks</h3>
                <p className="text-xs text-zinc-400">
                  Download separate audio, isolated vocals, or background music
                </p>
              </div>

              <div className="space-y-3">
                {[
                  {
                    id: 'mix',
                    title: 'Full Master Mix Audio',
                    ext: '.MP3 / .WAV',
                    desc: 'Combined original audio, AI voiceover dubbing, and music',
                  },
                  {
                    id: 'vocals',
                    title: 'Isolated Vocals / Speech Only',
                    ext: '.MP3',
                    desc: 'Cleaned human dialogue with background music removed',
                  },
                  {
                    id: 'bgm',
                    title: 'Isolated BGM / Instrumental Track',
                    ext: '.MP3',
                    desc: 'Instrumental background music with vocals removed',
                  },
                ].map((a) => (
                  <div
                    key={a.id}
                    className="p-4 rounded-2xl bg-[#181a1f] border border-[#26282e] flex items-center justify-between gap-4"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white">{a.title}</span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-500/20 text-blue-300">
                          {a.ext}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-400 mt-0.5">{a.desc}</p>
                    </div>
                    <button
                      onClick={() => handleSubtitleExport('txt')}
                      className="px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs font-bold flex items-center gap-1.5 shrink-0 transition-all shadow-md shadow-blue-950/40 active:scale-95 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" /> Export Audio
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* VIRAL TITLES & SOCIAL METADATA TAB */}
          {tab === 'metadata' && (
            <div className="space-y-6 max-w-3xl mx-auto py-2">
              {/* Generator Control Card */}
              <div className="p-5 rounded-2xl bg-gradient-to-br from-[#1c1a29] via-[#161822] to-[#12131a] border border-purple-500/20 shadow-xl space-y-4">
                {/* Top Action Bar */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-pink-500 to-purple-600 flex items-center justify-center text-white shadow-md shadow-pink-950/40 shrink-0">
                      <Sparkles className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-white tracking-wide flex items-center gap-1.5">
                        <span>AI Viral Title & Tags Engine</span>
                        <span className="text-[9px] px-1.5 py-0.2 rounded bg-pink-500/20 text-pink-300 border border-pink-500/30 font-bold font-mono">
                          Auto-SEO
                        </span>
                      </h4>
                      <p className="text-[11px] text-zinc-400">
                        Analyzes your video transcript to generate viral titles, first 3s hook, descriptions & tags
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={handleGenerateMetadata}
                    disabled={generatingMetadata}
                    className="w-full sm:w-auto justify-center px-4 py-2 rounded-xl bg-gradient-to-r from-pink-600 via-purple-600 to-indigo-600 hover:from-pink-500 hover:to-indigo-500 text-white text-xs font-bold shadow-lg shadow-purple-950/50 flex items-center gap-2 transition-all active:scale-95 disabled:opacity-50 cursor-pointer shrink-0"
                  >
                    {generatingMetadata ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>AI Generating Package...</span>
                      </>
                    ) : (
                      <>
                        <Zap className="w-3.5 h-3.5 text-yellow-300" />
                        <span>{titlesList.length > 0 ? 'Regenerate Titles & Tags' : 'Generate Viral Package'}</span>
                      </>
                    )}
                  </button>
                </div>

                {/* Tone & Target Filter Bar */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-white/5">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1">
                      <Flame className="w-3 h-3 text-pink-400" />
                      Content Vibe / Tone
                    </label>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {[
                        { id: 'viral', label: '🔥 Viral Hook' },
                        { id: 'suspense', label: '🎭 Suspense & Drama' },
                        { id: 'comedy', label: '😂 Comedy' },
                        { id: 'action', label: '⚡ Action Battle' },
                        { id: 'emotional', label: '❤️ Emotional' },
                      ].map((t) => (
                        <button
                          key={t.id}
                          onClick={() => setMetadataTone(t.id as any)}
                          className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all cursor-pointer ${
                            metadataTone === t.id
                              ? 'bg-purple-600 text-white shadow-xs'
                              : 'bg-[#1e2029] text-zinc-400 hover:text-zinc-200 border border-white/5'
                          }`}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1">
                      <Monitor className="w-3 h-3 text-blue-400" />
                      Target Social Platform
                    </label>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {[
                        { id: 'all', label: 'All Platforms' },
                        { id: 'tiktok', label: 'TikTok / Shorts' },
                        { id: 'youtube', label: 'YouTube' },
                        { id: 'facebook', label: 'Facebook Reels' },
                      ].map((p) => (
                        <button
                          key={p.id}
                          onClick={() => setMetadataPlatform(p.id as any)}
                          className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all cursor-pointer ${
                            metadataPlatform === p.id
                              ? 'bg-pink-600 text-white shadow-xs'
                              : 'bg-[#1e2029] text-zinc-400 hover:text-zinc-200 border border-white/5'
                          }`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* 1. Catchy Titles Section */}
              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                  <h4 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                    <Flame className="w-4 h-4 text-pink-400" />
                    Catchy Video Titles (ចំណងជើងទាក់ទាញ)
                  </h4>
                  <span className="text-[10px] text-zinc-400 font-mono">
                    {titlesList.length} Variations Generated
                  </span>
                </div>

                {titlesList.length === 0 && !generatingMetadata ? (
                  <div className="p-8 rounded-2xl bg-[#181a1f] border border-[#26282e] text-center space-y-2">
                    <Sparkles className="w-6 h-6 text-pink-400 mx-auto animate-bounce" />
                    <p className="text-xs text-zinc-300 font-medium">No titles generated yet</p>
                    <p className="text-[11px] text-zinc-500">
                      Click "Generate Viral Package" to create 5+ high-CTR titles from this video's dialogue
                    </p>
                  </div>
                ) : generatingMetadata && titlesList.length === 0 ? (
                  <div className="p-8 rounded-2xl bg-[#181a1f] border border-[#26282e] text-center space-y-2">
                    <Loader2 className="w-6 h-6 text-purple-400 animate-spin mx-auto" />
                    <p className="text-xs text-zinc-300">Crafting high-CTR viral titles from your transcript...</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2.5">
                    {titlesList.map((rawItem, idx) => {
                      const item = typeof rawItem === 'string'
                        ? { category: 'viral_hook', category_label: 'ចំណងជើងទាក់ទាញ (Viral Hook)', title: rawItem, description: '' }
                        : {
                            category: (rawItem as any).category || 'viral_hook',
                            category_label: (rawItem as any).category_label || (rawItem as any).category || 'ចំណងជើងទាក់ទាញ',
                            title: (rawItem as any).title || (rawItem as any).text || String(rawItem || ''),
                            description: (rawItem as any).description || '',
                          };
                      const isCopied = copiedKey === `title-${idx}`;
                      return (
                        <div
                          key={idx}
                          className="p-3.5 rounded-xl bg-[#181a1f] hover:bg-[#1f2229] border border-[#26282e] hover:border-purple-500/40 transition-all flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 group"
                        >
                          <div className="space-y-1 flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/25">
                                {item.category_label || item.category}
                              </span>
                            </div>
                            <p className="text-xs sm:text-sm font-bold text-white font-khmer leading-relaxed select-text break-words">
                              {item.title}
                            </p>
                            {item.description && (
                              <p className="text-[11px] text-zinc-400 font-khmer leading-normal break-words">
                                {item.description}
                              </p>
                            )}
                          </div>

                          <button
                            onClick={() => copyToClipboard(item.title, `title-${idx}`)}
                            className={`w-full sm:w-auto justify-center px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 shrink-0 transition-all cursor-pointer ${
                              isCopied
                                ? 'bg-emerald-600 text-white shadow-sm'
                                : 'bg-[#252833] hover:bg-[#323645] text-zinc-200 hover:text-white border border-white/10'
                            }`}
                          >
                            {isCopied ? (
                              <>
                                <CheckCheck className="w-3.5 h-3.5 text-white" />
                                <span>Copied!</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                <span>Copy Title</span>
                              </>
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 2. First 3-Seconds Hook / On-Screen Text */}
              {socialScriptData?.hook && (
                <div className="p-4 rounded-2xl bg-[#181a1f] border border-pink-500/20 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-pink-400 uppercase tracking-wider flex items-center gap-1.5">
                      <Zap className="w-3.5 h-3.5 text-yellow-300" />
                      First 3-Seconds Video Hook (ឃ្លាទាក់ទាញ 3 វិនាទីដំបូង)
                    </span>
                    <button
                      onClick={() => copyToClipboard(socialScriptData.hook || '', 'hook')}
                      className="text-[11px] text-zinc-400 hover:text-pink-300 font-semibold flex items-center gap-1 cursor-pointer"
                    >
                      {copiedKey === 'hook' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedKey === 'hook' ? 'Copied' : 'Copy Hook'}</span>
                    </button>
                  </div>
                  <p className="text-sm text-zinc-100 font-khmer font-semibold bg-black/40 p-3 rounded-xl border border-white/5 select-text leading-relaxed">
                    "{socialScriptData.hook}"
                  </p>
                </div>
              )}

              {/* 3. Social Media Descriptions & Captions */}
              {socialScriptData?.captions && (
                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                    <FileText className="w-4 h-4 text-blue-400" />
                    Video Description & Caption (ការពិពណ៌នាវីដេអូ)
                  </h4>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {socialScriptData.captions.tiktok && (
                      <div className="p-3.5 rounded-xl bg-[#181a1f] border border-[#26282e] space-y-2 flex flex-col justify-between">
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[10px] font-bold text-pink-300 uppercase tracking-wider">
                              📱 TikTok / Reels Caption
                            </span>
                            <button
                              onClick={() => copyToClipboard(socialScriptData?.captions?.tiktok || '', 'desc-tiktok')}
                              className="text-[10px] text-zinc-400 hover:text-white font-semibold flex items-center gap-1 cursor-pointer"
                            >
                              {copiedKey === 'desc-tiktok' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                              <span>{copiedKey === 'desc-tiktok' ? 'Copied' : 'Copy'}</span>
                            </button>
                          </div>
                          <p className="text-[11px] text-zinc-300 whitespace-pre-line select-text line-clamp-6">
                            {socialScriptData.captions.tiktok}
                          </p>
                        </div>
                      </div>
                    )}

                    {(socialScriptData.captions.youtube_shorts || socialScriptData.captions.full_description) && (
                      <div className="p-3.5 rounded-xl bg-[#181a1f] border border-[#26282e] space-y-2 flex flex-col justify-between">
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[10px] font-bold text-red-300 uppercase tracking-wider">
                              ▶️ YouTube / Full Description
                            </span>
                            <button
                              onClick={() => copyToClipboard(socialScriptData?.captions?.youtube_shorts || socialScriptData?.captions?.full_description || '', 'desc-yt')}
                              className="text-[10px] text-zinc-400 hover:text-white font-semibold flex items-center gap-1 cursor-pointer"
                            >
                              {copiedKey === 'desc-yt' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                              <span>{copiedKey === 'desc-yt' ? 'Copied' : 'Copy'}</span>
                            </button>
                          </div>
                          <p className="text-[11px] text-zinc-300 whitespace-pre-line select-text line-clamp-6">
                            {socialScriptData.captions.youtube_shorts || socialScriptData.captions.full_description}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 4. Trending Hashtags Cloud */}
              {socialScriptData?.hashtags && socialScriptData.hashtags.length > 0 && (
                <div className="p-4 rounded-2xl bg-[#181a1f] border border-[#26282e] space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                      <Hash className="w-3.5 h-3.5 text-indigo-400" />
                      Trending Hashtags ({socialScriptData.hashtags.length} Tags)
                    </span>
                    <button
                      onClick={() => {
                        const allFormatted = (socialScriptData.hashtags || []).map((t) => {
                          const clean = String(t || '').trim().replace(/^#+/, '').replace(/\s+/g, '');
                          return clean ? `#${clean}` : '';
                        }).filter(Boolean);
                        copyToClipboard(allFormatted.join(' '), 'tags-all');
                      }}
                      className="px-2.5 py-1 rounded-lg bg-indigo-600/30 hover:bg-indigo-600 text-indigo-200 hover:text-white text-[11px] font-bold border border-indigo-500/30 flex items-center gap-1 transition-all cursor-pointer"
                    >
                      {copiedKey === 'tags-all' ? <Check className="w-3 h-3 text-emerald-300" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedKey === 'tags-all' ? 'All Copied!' : 'Copy All Hashtags'}</span>
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {socialScriptData.hashtags.map((tag, idx) => {
                      const cleanTag = String(tag || '').trim().replace(/^#+/, '').replace(/\s+/g, '');
                      const formattedTag = cleanTag ? `#${cleanTag}` : tag;
                      const isTagCopied = copiedKey === `tag-${idx}`;
                      return (
                        <button
                          key={idx}
                          onClick={() => copyToClipboard(formattedTag, `tag-${idx}`)}
                          className="px-2 py-0.5 rounded-lg bg-[#222633] hover:bg-purple-900/40 text-zinc-300 hover:text-purple-200 text-[11px] font-mono border border-white/5 hover:border-purple-500/30 transition-colors flex items-center gap-1 cursor-pointer"
                          title="Click to copy single hashtag"
                        >
                          <span>{formattedTag}</span>
                          {isTagCopied && <Check className="w-2.5 h-2.5 text-emerald-400" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 4.5. YouTube Studio SEO Tags (Comma-separated) */}
              {socialScriptData?.seo_keywords && socialScriptData.seo_keywords.length > 0 && (
                <div className="p-4 rounded-2xl bg-[#181a1f] border border-[#26282e] space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-emerald-300 uppercase tracking-wider flex items-center gap-1.5 font-khmer">
                      <span>🏷️</span> YouTube Studio SEO Tags ({socialScriptData.seo_keywords.length} Keywords)
                    </span>
                    <button
                      onClick={() => copyToClipboard((socialScriptData.seo_keywords || []).join(', '), 'seo-tags-all')}
                      className="px-2.5 py-1 rounded-lg bg-emerald-600/30 hover:bg-emerald-600 text-emerald-200 hover:text-white text-[11px] font-bold border border-emerald-500/30 flex items-center gap-1 transition-all cursor-pointer"
                    >
                      {copiedKey === 'seo-tags-all' ? <Check className="w-3 h-3 text-white" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedKey === 'seo-tags-all' ? 'All Copied!' : 'Copy for YouTube Studio (Comma Separated)'}</span>
                    </button>
                  </div>
                  <p className="text-[11px] text-zinc-400 font-khmer leading-relaxed">
                    ពាក្យគន្លឹះទាំងនេះបំបែកដោយសញ្ញាក្បៀស (,) អាច Copy យកទៅ Paste ផ្ទាល់ក្នុងប្រអប់ Tags នៃ YouTube Studio ដើម្បីបង្កើនលំដាប់ Ranking ស្វែងរក៖
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {socialScriptData.seo_keywords.map((kw, idx) => {
                      const isKwCopied = copiedKey === `kw-${idx}`;
                      return (
                        <button
                          key={idx}
                          onClick={() => copyToClipboard(kw, `kw-${idx}`)}
                          className="px-2 py-0.5 rounded-lg bg-[#1a2920] hover:bg-emerald-900/40 text-emerald-300 hover:text-emerald-100 text-[11px] font-khmer border border-emerald-500/20 hover:border-emerald-400/40 transition-colors flex items-center gap-1 cursor-pointer"
                          title="Click to copy single tag"
                        >
                          <span>{kw}</span>
                          {isKwCopied && <Check className="w-2.5 h-2.5 text-emerald-400" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 5. Pinned Comment & Engagement CTA */}
              {socialScriptData?.pinned_comment && (
                <div className="p-3.5 rounded-xl bg-[#181a1f] border border-[#26282e] space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-yellow-400 uppercase tracking-wider flex items-center gap-1">
                      <MessageSquare className="w-3 h-3 text-yellow-400" />
                      Pinned Comment Hook (ខមមិនទាក់ទាញអ្នកទស្សនា)
                    </span>
                    <button
                      onClick={() => copyToClipboard(socialScriptData.pinned_comment || '', 'comment')}
                      className="text-[10px] text-zinc-400 hover:text-white font-semibold flex items-center gap-1 cursor-pointer"
                    >
                      {copiedKey === 'comment' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedKey === 'comment' ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <p className="text-xs text-zinc-300 select-text bg-black/30 p-2 rounded-lg border border-white/5">
                    {socialScriptData.pinned_comment}
                  </p>
                </div>
              )}

              {/* 6. High-CTR Thumbnail Text Overlays */}
              {socialScriptData?.thumbnail_text_ideas && socialScriptData.thumbnail_text_ideas.length > 0 && (
                <div className="p-4 rounded-2xl bg-gradient-to-br from-[#1b1926] via-[#161822] to-[#12131a] border border-amber-500/25 space-y-3 shadow-lg">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-amber-300 uppercase tracking-wider flex items-center gap-1.5 font-khmer">
                      <span>🖼️</span> Thumbnail Cover Text Ideas (ពាក្យគន្លឹះដាក់លើផ្ទាំងរូបភាព Thumbnail)
                    </span>
                    <span className="text-[10px] text-amber-400/80 font-mono">
                      High-CTR Overlays
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-400 font-khmer leading-relaxed">
                    ប្រើពាក្យខ្លីៗទាំងនេះ (3-4 ពាក្យ) ដាក់ជាអក្សរធំៗ ពណ៌លឿង ឬសកាត់ខ្មៅ លើផ្ទាំងរូបភាព Thumbnail ដើម្បីទាក់ទាញភ្នែកអ្នកទស្សនា៖
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {socialScriptData.thumbnail_text_ideas.map((idea, idx) => {
                      const isThumbCopied = copiedKey === `thumb-${idx}`;
                      return (
                        <div
                          key={idx}
                          className="p-3 rounded-xl bg-black/40 hover:bg-black/60 border border-amber-500/20 hover:border-amber-400/50 transition-all flex items-center justify-between gap-2 group"
                        >
                          <span className="text-xs font-bold text-amber-200 font-khmer select-text">
                            {idea}
                          </span>
                          <button
                            onClick={() => copyToClipboard(idea, `thumb-${idx}`)}
                            className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 shrink-0 transition-all cursor-pointer ${
                              isThumbCopied
                                ? 'bg-emerald-600 text-white'
                                : 'bg-amber-500/20 hover:bg-amber-500/40 text-amber-300 border border-amber-500/30'
                            }`}
                          >
                            {isThumbCopied ? (
                              <>
                                <Check className="w-3 h-3 text-white" />
                                <span>Copied</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3" />
                                <span>Copy Text</span>
                              </>
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* VIDEO EXPORT TAB */}
          {tab === 'video' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left Column: Live Video & Subtitle Preview Player */}
              <div className="lg:col-span-5 space-y-3 lg:sticky lg:top-0">
                <div className="w-full rounded-2xl overflow-hidden border border-white/10 bg-[#090a0d] shadow-2xl flex flex-col relative group">
                  {/* Monitor Top Status Bar */}
                  <div className="px-3 py-2 bg-[#12141a]/90 border-b border-white/5 flex items-center justify-between text-[10px] text-zinc-400">
                    <div className="flex items-center gap-1.5 font-mono">
                      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                      <span className="font-bold text-zinc-300">STUDIO MONITOR</span>
                    </div>
                    <span className="font-mono text-zinc-400">
                      {selectedPreset.ratio} ({selectedPreset.width}×{selectedPreset.height})
                    </span>
                  </div>

                  {/* Centered Preview Canvas Stage */}
                  <div className="w-full bg-[#07080a] py-3 px-3 flex items-center justify-center min-h-[340px]">
                    <div
                      ref={previewBoxRef}
                      className="relative cursor-pointer bg-black rounded-xl flex items-center justify-center overflow-hidden mx-auto shadow-2xl border border-white/10"
                      style={{
                        aspectRatio: `${selectedPreset.width} / ${selectedPreset.height}`,
                        height: '330px',
                        maxWidth: '100%',
                      }}
                      onClick={togglePreview}
                    >
                      {scaleMode === 'blur' && (
                        <video
                          ref={previewBgRef}
                          src={videoSrc}
                          className="absolute inset-0 w-full h-full object-cover blur-2xl scale-125 opacity-60 pointer-events-none"
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
                        preload="metadata"
                        muted={videoMuted}
                      />

                    {/* Live Burned-in Subtitles Preview */}
                    {burnSubtitles &&
                      (() => {
                        const segs =
                          translatedSegments.length > 0
                            ? translatedSegments
                            : currentProject?.segments || [];
                        const seg = segs.find(
                          (s) =>
                            currentSourceTime >= s.start_time && currentSourceTime < s.end_time
                        );
                        return seg ? (
                          <div className="absolute inset-0 pointer-events-none z-20 overflow-hidden">
                            <SubtitleOverlay
                              text={seg.text}
                              style={subtitleStyle}
                              frameHeight={previewBoxH}
                            />
                          </div>
                        ) : null;
                      })()}

                    {/* Play Overlay */}
                    {!previewPlaying && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/30 pointer-events-none backdrop-blur-[2px]">
                        <div className="w-12 h-12 rounded-2xl bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center text-white shadow-2xl transition-transform group-hover:scale-110">
                          <Play className="w-5 h-5 ml-0.5" />
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                  {/* Scrubber & Player Controls */}
                  <div className="p-3 bg-[#13151b] border-t border-white/5 flex items-center gap-3">
                    <button
                      onClick={togglePreview}
                      className="w-7 h-7 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-zinc-200 hover:text-white transition-colors shrink-0 cursor-pointer"
                    >
                      {previewPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
                    </button>

                    <div
                      className="flex-1 h-2 bg-[#20232b] rounded-full cursor-pointer relative group"
                      onClick={seekPreview}
                    >
                      <div
                        className="h-full bg-gradient-to-r from-pink-500 to-purple-600 rounded-full"
                        style={{
                          width: `${
                            previewTlDuration > 0
                              ? (previewTime / previewTlDuration) * 100
                              : 0
                          }%`,
                        }}
                      />
                    </div>

                    <span className="text-[10px] text-zinc-400 font-mono shrink-0 font-semibold">
                      {fmt(previewTime)} / {fmt(previewTlDuration)}
                    </span>
                  </div>
                </div>

                {/* Estimate Summary Box */}
                <div className="p-3.5 rounded-2xl bg-[#14161d] border border-white/5 grid grid-cols-3 gap-2 text-center text-xs shadow-sm">
                  <div className="bg-black/20 p-2 rounded-xl border border-white/5">
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider block font-semibold">Est. Size</span>
                    <span className="font-mono font-bold text-emerald-400">~{estimatedSizeMb} MB</span>
                  </div>
                  <div className="bg-black/20 p-2 rounded-xl border border-white/5">
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider block font-semibold">Duration</span>
                    <span className="font-mono font-bold text-white">{fmt(previewTlDuration)}</span>
                  </div>
                  <div className="bg-black/20 p-2 rounded-xl border border-white/5">
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider block font-semibold">Aspect</span>
                    <span className="font-mono font-bold text-pink-400">{selectedPreset.ratio}</span>
                  </div>
                </div>
              </div>

              {/* Right Column: Export Settings */}
              <div className="lg:col-span-7 space-y-4">
                {/* Platform Presets */}
                <div className="p-4 rounded-2xl bg-[#14161d] border border-white/5 space-y-2.5 shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-zinc-300 uppercase tracking-wider block flex items-center gap-1.5">
                      <Monitor className="w-3.5 h-3.5 text-pink-400" />
                      Platform & Aspect Ratio
                    </span>
                    <span className="text-[10px] text-zinc-500 font-mono">Select target format</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {PLATFORM_PRESETS.map((p) => {
                      const isActive = selectedPlatform === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setSelectedPlatform(p.id)}
                          className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                            isActive
                              ? 'bg-pink-500/15 border-pink-500 text-white shadow-md shadow-pink-500/10 ring-1 ring-pink-500/40'
                              : 'bg-[#181a22] border-white/5 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-base">{p.icon}</span>
                            {p.badge && (
                              <span className="text-[9px] px-1.5 py-0.2 rounded bg-pink-500/20 text-pink-300 font-semibold">
                                {p.badge}
                              </span>
                            )}
                          </div>
                          <p className="text-xs font-bold text-white truncate">{p.name}</p>
                          <p className="text-[10px] text-zinc-400 font-mono mt-0.5">
                            {p.ratio} · {p.res}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Video Format & Resolution */}
                <div className="p-4 rounded-2xl bg-[#14161d] border border-white/5 space-y-3 shadow-sm">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">
                        Video Container
                      </span>
                      <div className="grid grid-cols-3 gap-1 bg-[#181a22] border border-white/5 rounded-xl p-1">
                        {[
                          { id: 'mp4', label: 'MP4', badge: 'H.264' },
                          { id: 'mov', label: 'MOV', badge: 'Apple' },
                          { id: 'webm', label: 'WebM', badge: 'Web' },
                        ].map((f) => (
                          <button
                            key={f.id}
                            type="button"
                            onClick={() => setVideoFormat(f.id as any)}
                            className={`py-1.5 px-1 rounded-lg text-center transition-all cursor-pointer ${
                              videoFormat === f.id
                                ? 'bg-pink-600 text-white font-bold shadow-sm'
                                : 'text-zinc-400 hover:text-white hover:bg-white/5'
                            }`}
                          >
                            <p className="text-xs font-bold leading-none">{f.label}</p>
                            <p className="text-[9px] opacity-70 mt-0.5">{f.badge}</p>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">
                        Resolution
                      </span>
                      <div className="grid grid-cols-3 gap-1 bg-[#181a22] border border-white/5 rounded-xl p-1">
                        {[
                          { id: '1080p', label: '1080p', badge: 'FHD' },
                          { id: '4k', label: '4K', badge: 'UHD' },
                          { id: '720p', label: '720p', badge: 'HD' },
                        ].map((q) => (
                          <button
                            key={q.id}
                            type="button"
                            onClick={() => setVideoQuality(q.id as any)}
                            className={`py-1.5 px-1 rounded-lg text-center transition-all cursor-pointer ${
                              videoQuality === q.id
                                ? 'bg-purple-600 text-white font-bold shadow-sm'
                                : 'text-zinc-400 hover:text-white hover:bg-white/5'
                            }`}
                          >
                            <p className="text-xs font-bold leading-none">{q.label}</p>
                            <p className="text-[9px] opacity-70 mt-0.5">{q.badge}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Quality Profiles */}
                  <div className="space-y-1.5 pt-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">
                        File Size & Bitrate Profile
                      </span>
                      <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full font-bold">
                        Est. Output: ~{estimatedSizeMb} MB
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        {
                          id: 'compact',
                          icon: '⚡',
                          label: 'Compact / Web',
                          badge: '~70% Smaller',
                          desc: '~2.2 Mbps · Fast Share',
                        },
                        {
                          id: 'standard',
                          icon: '✨',
                          label: 'Standard HD',
                          badge: 'Balanced',
                          desc: '~3.8 Mbps · Crisp 1080p',
                        },
                        {
                          id: 'high',
                          icon: '💎',
                          label: 'High Bitrate',
                          badge: 'Master',
                          desc: '~6.5 Mbps · Pristine Detail',
                        },
                      ].map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setQuality(opt.id as any)}
                          className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                            quality === opt.id
                              ? 'bg-emerald-500/15 border-emerald-500/70 text-white shadow-sm ring-1 ring-emerald-500/30'
                              : 'bg-[#181a22] border-white/5 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1 mb-1">
                            <span className="text-xs">{opt.icon}</span>
                            <span
                              className={`text-[9px] font-bold px-1.5 py-0.2 rounded-md ${
                                quality === opt.id
                                  ? 'bg-emerald-500/30 text-emerald-300'
                                  : 'bg-white/5 text-zinc-400'
                              }`}
                            >
                              {opt.badge}
                            </span>
                          </div>
                          <p className="text-xs font-bold text-white leading-tight">{opt.label}</p>
                          <p className="text-[9.5px] text-zinc-400 mt-0.5">{opt.desc}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Video Trimming & Clip Cutting */}
                <div className="p-4 rounded-2xl bg-[#14161d] border border-white/5 space-y-3 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-xl bg-pink-500/15 text-pink-400 flex items-center justify-center border border-pink-500/20">
                        <Scissors className="w-3.5 h-3.5" />
                      </div>
                      <div>
                        <span className="text-xs font-bold text-white block leading-tight">
                          Trim Video (Clip Cutting)
                        </span>
                        <p className="text-[10px] text-zinc-400">
                          {trimEnabled
                            ? `Range: ${fmt(parsedStart)} → ${fmt(parsedEnd)} (${fmt(activeExportDuration)})`
                            : `Full Video (${fmt(previewTlDuration)})`}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const next = !trimEnabled;
                        setTrimEnabled(next);
                        if (next && (!endTime || endTime === '' || endTime === '0')) {
                          setEndTime(previewTlDuration.toFixed(1));
                        }
                      }}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer ${
                        trimEnabled ? 'bg-pink-600' : 'bg-zinc-700'
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                          trimEnabled ? 'translate-x-4' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  {trimEnabled && (
                    <div className="space-y-3 pt-2 border-t border-white/5 animate-in fade-in">
                      {/* Quick Presets */}
                      <div className="space-y-1.5">
                        <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">
                          Quick Range Presets
                        </span>
                        <div className="grid grid-cols-4 gap-1.5">
                          {[
                            { label: '⚡ First 60s', s: 0, e: Math.min(60, previewTlDuration || 60) },
                            { label: '⏱️ First 3m', s: 0, e: Math.min(180, previewTlDuration || 180) },
                            { label: '🎬 First 5m', s: 0, e: Math.min(300, previewTlDuration || 300) },
                            { label: '🔄 Full Video', s: 0, e: previewTlDuration || 0 },
                          ].map((pre, idx) => (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => {
                                setStartTime(pre.s.toString());
                                setEndTime(pre.e.toFixed(1));
                              }}
                              className="py-1 px-1.5 rounded-lg bg-[#181a22] hover:bg-[#222530] border border-white/5 text-[10px] font-medium text-zinc-300 text-center transition-colors truncate cursor-pointer"
                            >
                              {pre.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Visual Range Bar */}
                      {previewTlDuration > 0 && (
                        <div className="space-y-1 bg-black/20 p-2.5 rounded-xl border border-white/5">
                          <div className="flex justify-between text-[10px] text-zinc-400 font-mono">
                            <span>Start: {fmt(parsedStart)}</span>
                            <span className="text-pink-400 font-bold">Selected: {fmt(activeExportDuration)}</span>
                            <span>End: {fmt(parsedEnd)}</span>
                          </div>
                          <div className="relative h-2.5 bg-zinc-800/80 rounded-full overflow-hidden">
                            <div
                              className="absolute top-0 bottom-0 bg-gradient-to-r from-pink-500 to-purple-600 rounded-full shadow-sm"
                              style={{
                                left: `${Math.max(0, Math.min(100, (parsedStart / previewTlDuration) * 100))}%`,
                                width: `${Math.max(
                                  1,
                                  Math.min(100, (activeExportDuration / previewTlDuration) * 100)
                                )}%`,
                              }}
                            />
                          </div>
                        </div>
                      )}

                      {/* Precise Start & End Time Inputs */}
                      <div className="grid grid-cols-2 gap-2.5">
                        <div className="space-y-1.5 bg-black/20 p-2.5 rounded-xl border border-white/5">
                          <div className="flex items-center justify-between">
                            <label className="text-[10px] font-bold text-zinc-400 uppercase">
                              Start Time (sec)
                            </label>
                            <span className="text-[10px] font-mono text-pink-400 font-bold">
                              {fmt(parsedStart)}
                            </span>
                          </div>
                          <input
                            type="number"
                            step="0.5"
                            min="0"
                            max={parsedEnd}
                            value={startTime}
                            onChange={(e) => setStartTime(e.target.value)}
                            className="w-full bg-[#181a22] border border-white/10 focus:border-pink-500 rounded-lg px-2.5 py-1 text-xs text-white font-mono focus:outline-none transition-colors"
                          />
                          <button
                            type="button"
                            onClick={() => setStartTime(previewTime.toFixed(1))}
                            className="w-full text-[9px] text-zinc-400 hover:text-white bg-white/5 hover:bg-white/10 py-1 rounded-lg text-center transition-colors cursor-pointer"
                          >
                            📍 Set at Playhead ({fmt(previewTime)})
                          </button>
                        </div>

                        <div className="space-y-1.5 bg-black/20 p-2.5 rounded-xl border border-white/5">
                          <div className="flex items-center justify-between">
                            <label className="text-[10px] font-bold text-zinc-400 uppercase">
                              End Time (sec)
                            </label>
                            <span className="text-[10px] font-mono text-pink-400 font-bold">
                              {fmt(parsedEnd)}
                            </span>
                          </div>
                          <input
                            type="number"
                            step="0.5"
                            min={parsedStart}
                            max={previewTlDuration || 999999}
                            value={endTime}
                            onChange={(e) => setEndTime(e.target.value)}
                            className="w-full bg-[#181a22] border border-white/10 focus:border-pink-500 rounded-lg px-2.5 py-1 text-xs text-white font-mono focus:outline-none transition-colors"
                          />
                          <button
                            type="button"
                            onClick={() => setEndTime(previewTime.toFixed(1))}
                            className="w-full text-[9px] text-zinc-400 hover:text-white bg-white/5 hover:bg-white/10 py-1 rounded-lg text-center transition-colors cursor-pointer"
                          >
                            📍 Set at Playhead ({fmt(previewTime)})
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Auto Split Option */}
                  <div className="pt-2 border-t border-white/5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <SplitSquareHorizontal className="w-3.5 h-3.5 text-purple-400" />
                        <span className="text-xs font-medium text-zinc-300">
                          Split into Multi-Part Episodes (.ZIP)
                        </span>
                      </div>
                      <input
                        type="checkbox"
                        checked={splitEnabled}
                        onChange={(e) => setSplitEnabled(e.target.checked)}
                        className="rounded accent-purple-500 cursor-pointer"
                      />
                    </div>

                    {splitEnabled && (
                      <div className="mt-2 grid grid-cols-4 gap-1 bg-[#181a22] p-1 rounded-xl border border-white/5 animate-in fade-in">
                        {[
                          { id: '60', label: '60s (1m)' },
                          { id: '90', label: '90s (1.5m)' },
                          { id: '180', label: '180s (3m)' },
                          { id: '300', label: '300s (5m)' },
                        ].map((part) => (
                          <button
                            key={part.id}
                            type="button"
                            onClick={() => setSplitDuration(part.id)}
                            className={`py-1 px-1 rounded-lg text-center text-[10px] font-bold transition-colors cursor-pointer ${
                              splitDuration === part.id
                                ? 'bg-purple-600 text-white shadow-sm'
                                : 'text-zinc-400 hover:text-white hover:bg-white/5'
                            }`}
                          >
                            {part.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Subtitle & Audio Options */}
                <div className="p-4 rounded-2xl bg-[#14161d] border border-white/5 space-y-3.5 shadow-sm">
                  {/* Framing & Captions Burn-in */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">
                        Captions Burn-in
                      </span>
                      <label className="flex items-center gap-2 p-2 rounded-xl bg-[#181a22] border border-white/5 cursor-pointer hover:border-pink-500/50 transition-colors">
                        <input
                          type="checkbox"
                          checked={burnSubtitles}
                          onChange={(e) => setBurnSubtitles(e.target.checked)}
                          className="rounded accent-pink-500 cursor-pointer"
                        />
                        <span className="text-xs text-zinc-200 font-medium">Burn Subtitles on Video</span>
                      </label>
                    </div>

                    <div className="space-y-1.5">
                      <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">
                        Framing Mode
                      </span>
                      <div className="grid grid-cols-3 gap-1 bg-[#181a22] border border-white/5 rounded-xl p-1">
                        {[
                          { id: 'blur', label: 'Blur' },
                          { id: 'fit', label: 'Fit' },
                          { id: 'fill', label: 'Crop' },
                        ].map((mode) => (
                          <button
                            key={mode.id}
                            type="button"
                            onClick={() => setScaleMode(mode.id as any)}
                            className={`py-1 px-1 rounded-lg text-center text-xs font-bold transition-all cursor-pointer ${
                              scaleMode === mode.id
                                ? 'bg-blue-600 text-white shadow-sm'
                                : 'text-zinc-400 hover:text-white hover:bg-white/5'
                            }`}
                          >
                            {mode.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Audio Mix & Volume */}
                  <div className="space-y-2 pt-1 border-t border-white/5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block flex items-center gap-1.5">
                        <Music className="w-3 h-3 text-pink-400" />
                        Audio Mix & Background Music
                      </span>
                      {bgAudio !== 'none' && (
                        <span className="text-[10px] font-mono text-pink-400 font-bold bg-pink-500/10 border border-pink-500/20 px-2 py-0.5 rounded-full">
                          Vol: {Math.round(bgmVolume * 100)}%
                        </span>
                      )}
                    </div>

                    <select
                      value={bgAudio}
                      onChange={(e) => setBgAudio(e.target.value as any)}
                      className="w-full bg-[#181a22] border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-pink-500 transition-colors"
                    >
                      <option value="original_clean">🎬 Original Video Audio (Original Track & Voice, No AI Dubbing)</option>
                      <option value="music">🎵 AI Voice + BGM Only (Original Vocals Removed)</option>
                      <option value="original">🗣️ AI Voice + Original Audio (With Original Voices)</option>
                      <option value="none">🔇 AI Voice Only (Muted Background)</option>
                    </select>

                    {bgAudio !== 'none' && (
                      <div className="p-3 rounded-xl bg-black/20 border border-white/5 space-y-2.5 animate-in fade-in">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-zinc-300 font-medium">
                            Background Music Track Volume
                          </span>
                          <span className="text-xs font-mono font-bold text-pink-400 bg-pink-950/50 px-2 py-0.5 rounded-md border border-pink-500/20">
                            {Math.round(bgmVolume * 100)}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={bgmVolume}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setBgmVolume(v);
                            if (currentProject?.id) {
                              const key = audioSeparated ? `timeline-bgm-volume-${currentProject.id}` : `timeline-video-volume-${currentProject.id}`;
                              localStorage.setItem(key, String(v));
                            }
                          }}
                          className="w-full h-1.5 bg-zinc-800 accent-pink-500 rounded-lg cursor-pointer"
                        />
                        <div className="flex items-center gap-1.5 pt-0.5">
                          {[
                            { label: '🔇 0%', val: 0 },
                            { label: '🔉 20%', val: 0.2 },
                            { label: '🎵 35%', val: 0.35 },
                            { label: '60%', val: 0.6 },
                            { label: '🔊 100%', val: 1.0 },
                          ].map((p) => (
                            <button
                              key={p.val}
                              type="button"
                              onClick={() => {
                                setBgmVolume(p.val);
                                if (currentProject?.id) {
                                  const key = audioSeparated ? `timeline-bgm-volume-${currentProject.id}` : `timeline-video-volume-${currentProject.id}`;
                                  localStorage.setItem(key, String(p.val));
                                }
                              }}
                              className={`text-[9px] px-1.5 py-0.5 rounded-lg transition-colors flex-1 cursor-pointer ${
                                Math.abs(bgmVolume - p.val) < 0.04
                                  ? 'bg-pink-600 text-white font-bold'
                                  : 'bg-[#181a22] text-zinc-400 hover:text-zinc-200 border border-white/5'
                              }`}
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                        <p className="text-[9.5px] text-emerald-400/90 flex items-center gap-1">
                          <span>✓</span>
                          <span>Auto-synced with timeline volume ({Math.round(bgmVolume * 100)}%)</span>
                        </p>
                      </div>
                    )}

                    {/* Voice Timing & Subtitle Sync Offset */}
                    <div className="p-3 rounded-xl bg-black/20 border border-white/5 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] text-zinc-300 font-medium">
                            🎙️ Voice Sync Timing (Nudge)
                          </span>
                          <span className="text-[9px] text-zinc-500 font-normal">
                            ({voiceOffsetMs >= 0 ? `+${voiceOffsetMs}ms` : `${voiceOffsetMs}ms`})
                          </span>
                        </div>
                        <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded-md border ${
                          voiceOffsetMs === 0
                            ? 'text-zinc-400 bg-zinc-800/60 border-zinc-700/40'
                            : voiceOffsetMs > 0
                            ? 'text-amber-400 bg-amber-950/50 border-amber-500/20'
                            : 'text-cyan-400 bg-cyan-950/50 border-cyan-500/20'
                        }`}>
                          {voiceOffsetMs === 0 ? '0ms (Exact)' : voiceOffsetMs > 0 ? `+${voiceOffsetMs}ms (Delay Voice)` : `${voiceOffsetMs}ms (Advance Voice)`}
                        </span>
                      </div>
                      <input
                        type="range"
                        min="-500"
                        max="800"
                        step="50"
                        value={voiceOffsetMs}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setVoiceOffsetMs(v);
                          if (currentProject?.id) {
                            localStorage.setItem(`export-voice-offset-${currentProject.id}`, String(v));
                          }
                        }}
                        className="w-full h-1.5 bg-zinc-800 accent-pink-500 rounded-lg cursor-pointer"
                      />
                      <div className="flex items-center gap-1.5 pt-0.5">
                        {[
                          { label: '⚡ -200ms', val: -200 },
                          { label: 'Exact (0ms)', val: 0 },
                          { label: '⏱️ +150ms', val: 150 },
                          { label: '⏱️ +250ms', val: 250 },
                          { label: '⏱️ +400ms', val: 400 },
                        ].map((p) => (
                          <button
                            key={p.label}
                            type="button"
                            onClick={() => {
                              setVoiceOffsetMs(p.val);
                              if (currentProject?.id) {
                                localStorage.setItem(`export-voice-offset-${currentProject.id}`, String(p.val));
                              }
                            }}
                            className={`flex-1 py-1 text-[10px] font-mono rounded-lg transition-all border ${
                              voiceOffsetMs === p.val
                                ? 'bg-pink-500/20 border-pink-500/50 text-pink-300 font-bold shadow-sm'
                                : 'bg-zinc-800/50 hover:bg-zinc-800 border-white/5 text-zinc-400'
                            }`}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                      <p className="text-[9.5px] text-zinc-400/90 leading-relaxed">
                        💡 If the voice finishes faster than the captions, choose <strong className="text-amber-300">+150ms</strong> or <strong className="text-amber-300">+250ms</strong> to delay audio start and match visual subtitle pace.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Output Filename & Destination */}
                <div className="p-4 rounded-2xl bg-[#14161d] border border-white/5 space-y-3 shadow-sm">
                  {/* File Name */}
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">
                      Output File Name
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={exportName}
                        onChange={(e) => setExportName(e.target.value)}
                        className="flex-1 bg-[#181a22] border border-white/10 focus:border-pink-500 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none transition-colors"
                        placeholder="export_video_name"
                      />
                      <span className="text-xs text-pink-400 font-mono shrink-0 font-bold bg-pink-500/10 border border-pink-500/20 px-2.5 py-1.5 rounded-xl">
                        .{videoFormat}
                      </span>
                    </div>
                  </div>

                  {/* Destination Folder Path */}
                  <div className="space-y-1.5 pt-1">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
                        <Folder className="w-3.5 h-3.5 text-pink-400" />
                        <span>Destination Folder</span>
                      </label>
                      <div className="flex items-center gap-1">
                        {defaultFolders.downloads && (
                          <button
                            type="button"
                            onClick={() => {
                              setExportFolder(defaultFolders.downloads!);
                              localStorage.setItem('meatika_export_folder', defaultFolders.downloads!);
                            }}
                            className={`text-[10px] px-2 py-0.5 rounded-md transition-colors cursor-pointer ${
                              exportFolder === defaultFolders.downloads
                                ? 'bg-pink-500/25 text-pink-300 font-bold border border-pink-500/30'
                                : 'bg-white/5 text-zinc-400 hover:text-zinc-200'
                            }`}
                          >
                            Downloads
                          </button>
                        )}
                        {defaultFolders.desktop && (
                          <button
                            type="button"
                            onClick={() => {
                              setExportFolder(defaultFolders.desktop!);
                              localStorage.setItem('meatika_export_folder', defaultFolders.desktop!);
                            }}
                            className={`text-[10px] px-2 py-0.5 rounded-md transition-colors cursor-pointer ${
                              exportFolder === defaultFolders.desktop
                                ? 'bg-pink-500/25 text-pink-300 font-bold border border-pink-500/30'
                                : 'bg-white/5 text-zinc-400 hover:text-zinc-200'
                            }`}
                          >
                            Desktop
                          </button>
                        )}
                        {defaultFolders.movies && (
                          <button
                            type="button"
                            onClick={() => {
                              setExportFolder(defaultFolders.movies!);
                              localStorage.setItem('meatika_export_folder', defaultFolders.movies!);
                            }}
                            className={`text-[10px] px-2 py-0.5 rounded-md transition-colors cursor-pointer ${
                              exportFolder === defaultFolders.movies
                                ? 'bg-pink-500/25 text-pink-300 font-bold border border-pink-500/30'
                                : 'bg-white/5 text-zinc-400 hover:text-zinc-200'
                            }`}
                          >
                            Movies
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="relative flex-1">
                        <Folder className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          type="text"
                          value={exportFolder}
                          onChange={(e) => {
                            setExportFolder(e.target.value);
                            localStorage.setItem('meatika_export_folder', e.target.value);
                          }}
                          className="w-full bg-[#181a22] border border-white/10 focus:border-pink-500 rounded-xl pl-8 pr-3 py-2 text-xs text-zinc-200 font-mono focus:outline-none transition-colors"
                          placeholder="/Users/username/Downloads"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          const selected = await selectFolderInSystem();
                          if (selected) {
                            setExportFolder(selected);
                            localStorage.setItem('meatika_export_folder', selected);
                          }
                        }}
                        title="Choose custom folder on your computer"
                        className="px-3 py-2 bg-[#181a22] border border-white/10 hover:border-pink-500 hover:bg-pink-950/20 text-zinc-300 hover:text-pink-300 rounded-xl text-xs font-semibold flex items-center gap-1.5 shrink-0 transition-colors shadow-sm cursor-pointer"
                      >
                        <FolderPlus className="w-3.5 h-3.5 text-pink-400" />
                        <span>Browse...</span>
                      </button>
                      {exportFolder && (
                        <button
                          type="button"
                          onClick={() => openFolderInSystem(exportFolder)}
                          title="Open folder in Finder"
                          className="px-3 py-2 bg-[#181a22] border border-white/10 hover:border-pink-500 hover:bg-pink-950/20 text-zinc-300 hover:text-pink-300 rounded-xl text-xs font-semibold flex items-center gap-1.5 shrink-0 transition-colors shadow-sm cursor-pointer"
                        >
                          <FolderOpen className="w-3.5 h-3.5 text-pink-400" />
                          <span>Finder</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Real-Time Progress Bar & Status */}
                {exporting && (
                  <div className="p-4 rounded-2xl bg-gradient-to-r from-pink-950/40 via-purple-950/30 to-indigo-950/40 border border-pink-500/40 space-y-2.5 shadow-xl animate-in fade-in">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-pink-300 flex items-center gap-2 truncate max-w-[80%]">
                        <Loader2 className="w-4 h-4 animate-spin text-pink-400 shrink-0" />
                        <span className="truncate">{statusMessage || 'Rendering Video...'}</span>
                      </span>
                      <span className="font-mono font-extrabold text-white text-sm shrink-0 ml-2">{progress}%</span>
                    </div>
                    <div className="w-full h-2.5 bg-black/40 rounded-full overflow-hidden p-0.5 border border-white/10 shadow-inner">
                      <div
                        className="h-full bg-gradient-to-r from-pink-500 via-purple-500 to-emerald-400 rounded-full transition-all duration-300 shadow-md shadow-pink-500/30"
                        style={{ width: `${Math.max(2, progress)}%` }}
                      />
                    </div>
                  </div>
                )}

                {error && (
                  <div className="p-3.5 rounded-2xl bg-red-950/60 border border-red-800 text-red-200 text-xs leading-relaxed">
                    {error}
                  </div>
                )}

                {done && (
                  <div className="p-4 rounded-2xl bg-emerald-950/60 border border-emerald-700/60 text-emerald-200 text-xs space-y-3 shadow-xl animate-in fade-in">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-bold">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span>Video successfully rendered and saved!</span>
                      </div>
                      {savedLocalPath && (
                        <button
                          type="button"
                          onClick={() => openFolderInSystem(savedLocalPath)}
                          className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold flex items-center gap-1 shadow transition-all active:scale-95 cursor-pointer"
                        >
                          <FolderOpen className="w-3.5 h-3.5" />
                          <span>Show in Finder</span>
                        </button>
                      )}
                    </div>
                    {savedLocalPath && (
                      <p className="text-[11px] text-emerald-300/90 font-mono truncate bg-black/30 p-2 rounded-xl border border-emerald-700/40">
                        {savedLocalPath}
                      </p>
                    )}

                    {/* Quick CTA to Generate Viral Titles & Tags */}
                    <div className="pt-2 border-t border-emerald-800/40 flex items-center justify-between">
                      <span className="text-[11px] text-emerald-200 font-medium">
                        Ready to post? Generate viral titles & tags:
                      </span>
                      <button
                        type="button"
                        onClick={() => setTab('metadata')}
                        className="px-3.5 py-1.5 bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-md shadow-pink-950/40 transition-all active:scale-95 cursor-pointer"
                      >
                        <Sparkles className="w-3.5 h-3.5 text-yellow-300 animate-pulse" />
                        <span>Generate Titles & Tags</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 border-t border-white/5 bg-[#141720]/80 backdrop-blur-md flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 text-xs text-zinc-400 font-medium">
            <Sparkles className="w-3.5 h-3.5 text-pink-400" />
            <span>Meatika High-Performance FFmpeg Render Engine</span>
          </div>

          <div className="flex items-center gap-3">
            {!inline && (
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
              >
                Cancel
              </button>
            )}

            {tab === 'video' && (
              <button
                onClick={handleVideoExport}
                disabled={exporting || !hasVideo}
                className={`relative overflow-hidden group flex items-center gap-2.5 px-6 py-2.5 rounded-xl text-xs font-bold transition-all shadow-xl active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${
                  done
                    ? 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white shadow-emerald-950/50 border border-emerald-400/40'
                    : 'bg-gradient-to-r from-pink-600 via-purple-600 to-indigo-600 hover:from-pink-500 hover:via-purple-500 hover:to-indigo-500 text-white shadow-purple-950/60 border border-white/20 hover:border-white/40'
                }`}
              >
                <span className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/25 to-white/0 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700 pointer-events-none" />
                {exporting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-pink-200" />
                    <span className="tracking-wide">Rendering ({progress}%)...</span>
                  </>
                ) : done ? (
                  <>
                    <Check className="w-4 h-4 text-emerald-200 group-hover:scale-110 transition-transform" />
                    <span className="tracking-wide">Render Finished!</span>
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4 text-pink-200 group-hover:translate-y-[-1px] transition-transform" />
                    <span className="tracking-wide">Export & Download MP4</span>
                    <Sparkles className="w-3.5 h-3.5 text-yellow-300 animate-pulse" />
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* AI Audio Preload Elements */}
      {(currentProject?.segments || [])
        .filter((s) => s.audio_url)
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
