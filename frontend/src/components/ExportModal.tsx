import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useProjectStore } from '../stores/projectStore';
import {
  fetchPlatforms,
  exportVideoForPlatform,
  getExportUrl,
  translateSegments,
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
    badge: 'Trending',
    width: 1080,
    height: 1920,
  },
  {
    id: 'youtube',
    name: 'YouTube Landscape',
    ratio: '16:9',
    res: '1920 × 1080',
    icon: '▶️',
    badge: 'Popular',
    width: 1920,
    height: 1080,
  },
  {
    id: 'instagram',
    name: 'Instagram Square',
    ratio: '1:1',
    res: '1080 × 1080',
    icon: '📸',
    width: 1080,
    height: 1080,
  },
  {
    id: 'facebook',
    name: 'Facebook Portrait',
    ratio: '4:5',
    res: '1080 × 1350',
    icon: '📘',
    width: 1080,
    height: 1350,
  },
  {
    id: 'custom',
    name: 'Original Source',
    ratio: 'Auto',
    res: 'Match Video',
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

  const [tab, setTab] = useState<'video' | 'subtitles' | 'audio'>('video');
  const [selectedPlatform, setSelectedPlatform] = useState('tiktok');
  const [resolution, setResolution] = useState('1080p');
  const [fps, setFps] = useState('30 FPS');
  const [quality, setQuality] = useState<'standard' | 'high'>('high');
  const [scaleMode, setScaleMode] = useState<'blur' | 'fit' | 'fill'>('blur');
  const [bgAudio, setBgAudio] = useState<'original' | 'music' | 'none'>(
    audioSeparated || bgmUrl ? 'music' : 'music'
  );
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

  const [videoFormat, setVideoFormat] = useState<'mp4' | 'mov' | 'webm'>('mp4');
  const [videoQuality, setVideoQuality] = useState<'1080p' | '4k' | '720p'>('1080p');
  const initializedOpenRef = useRef(false);

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
        true,
        splitEnabled ? parseFloat(splitDuration) : undefined,
        subtitleLanguage || undefined,
        bgAudio === 'none',
        scaleMode,
        subtitleStyle,
        bgAudio
      );
      const blob = result.blob;
      const isZip =
        blob.type === 'application/zip' || (splitEnabled && parseFloat(splitDuration) > 0);
      const ext = isZip ? 'zip' : videoFormat || 'mp4';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = (exportName.trim() || currentProject.name || 'meatika_video')
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, '_');
      a.download = result.filename || `${safeName}${isZip ? '_parts' : ''}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setDone(true);
      setTimeout(() => setDone(false), 4000);
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

  const estimatedSizeMb = Math.max(
    2.5,
    Math.round(
      (previewTlDuration *
        (resolution === '4k' ? 1.8 : resolution === '1080p' ? 0.65 : 0.35) *
        (quality === 'high' ? 1.3 : 1.0)) *
        10
    ) / 10
  );

  return (
    <div
      className={
        inline
          ? 'h-full w-full'
          : 'fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50 p-4 animate-in fade-in duration-200'
      }
      onClick={inline ? undefined : onClose}
    >
      <div
        className={`flex flex-col bg-[#121316] text-[#e1e3e6] ${
          inline
            ? 'w-full h-full'
            : 'border border-[#26282e] rounded-3xl w-full max-w-4xl shadow-2xl overflow-hidden max-h-[92vh]'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header Bar — Exact Meatika Aesthetics */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1c1e24] bg-[#121316] shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-pink-600 to-purple-600 flex items-center justify-center text-white shadow-lg shadow-pink-500/20">
              <Download className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                Export Studio
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-white/10 text-zinc-300">
                  Meatika Engine
                </span>
              </h2>
              <p className="text-[11px] text-zinc-400">
                Render MP4 video, subtitles, or audio with burned-in captions
              </p>
            </div>
          </div>

          {/* Top Tabs */}
          <div className="flex items-center gap-1.5 bg-[#181a1f] p-1 rounded-xl border border-[#26282e]">
            {[
              { id: 'video', label: 'Video (MP4)', icon: Film },
              { id: 'subtitles', label: 'Subtitles', icon: FileText },
              { id: 'audio', label: 'Audio Only', icon: Music },
            ].map((t) => {
              const Icon = t.icon;
              const isActive = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id as any)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    isActive
                      ? 'bg-white text-black shadow-sm'
                      : 'text-zinc-400 hover:text-white hover:bg-white/5'
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
              className="p-1.5 rounded-xl text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6">
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
                      className="px-3.5 py-1.5 rounded-xl bg-white hover:bg-zinc-200 text-black text-xs font-bold flex items-center gap-1.5 shrink-0 transition-colors shadow-sm"
                    >
                      <Download className="w-3.5 h-3.5" /> Export Audio
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* VIDEO EXPORT TAB */}
          {tab === 'video' && (
            <div className="grid grid-cols-12 gap-6 items-start">
              {/* Left Column: Live Video & Subtitle Preview Player */}
              <div className="col-span-5 space-y-3 sticky top-0">
                <div className="w-full rounded-2xl overflow-hidden border border-[#26282e] bg-[#090a0c] shadow-xl flex flex-col">
                  {/* Centered Preview Canvas Stage */}
                  <div className="w-full bg-[#090a0c] py-2 px-3 flex items-center justify-center min-h-[350px]">
                    <div
                      ref={previewBoxRef}
                      className="relative cursor-pointer bg-black rounded-xl flex items-center justify-center overflow-hidden mx-auto shadow-2xl border border-white/10"
                      style={{
                        aspectRatio: `${selectedPreset.width} / ${selectedPreset.height}`,
                        height: '340px',
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

                    {/* Live Burned-in Subtitles Preview - Identical to VideoPlayer */}
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
                      <div className="absolute inset-0 flex items-center justify-center bg-black/20 pointer-events-none">
                        <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center text-white shadow-2xl">
                          <Play className="w-5 h-5 ml-0.5" />
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                  {/* Scrubber & Player Controls */}
                  <div className="p-3 bg-[#16181d] border-t border-[#26282e] flex items-center gap-3">
                    <button
                      onClick={togglePreview}
                      className="p-1 rounded-lg text-zinc-300 hover:text-white transition-colors shrink-0"
                    >
                      {previewPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                    </button>

                    <div
                      className="flex-1 h-1.5 bg-[#26282e] rounded-full cursor-pointer relative group"
                      onClick={seekPreview}
                    >
                      <div
                        className="h-full bg-pink-500 rounded-full"
                        style={{
                          width: `${
                            previewTlDuration > 0
                              ? (previewTime / previewTlDuration) * 100
                              : 0
                          }%`,
                        }}
                      />
                    </div>

                    <span className="text-[10px] text-zinc-400 font-mono shrink-0">
                      {fmt(previewTime)} / {fmt(previewTlDuration)}
                    </span>
                  </div>
                </div>

                {/* Estimate Summary Box */}
                <div className="p-3 rounded-2xl bg-[#181a1f] border border-[#26282e] flex items-center justify-between text-xs">
                  <div>
                    <span className="text-[10px] text-zinc-500 block">Est. Output Size</span>
                    <span className="font-mono font-bold text-white">~{estimatedSizeMb} MB</span>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] text-zinc-500 block">Duration</span>
                    <span className="font-mono font-bold text-white">{fmt(previewTlDuration)}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] text-zinc-500 block">Preset</span>
                    <span className="font-mono font-bold text-pink-400">
                      {selectedPreset.ratio}
                    </span>
                  </div>
                </div>
              </div>

              {/* Right Column: Export Settings */}
              <div className="col-span-7 space-y-4">
                {/* Platform Presets */}
                <div className="space-y-2">
                  <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block">
                    Platform & Aspect Ratio
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    {PLATFORM_PRESETS.map((p) => {
                      const isActive = selectedPlatform === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setSelectedPlatform(p.id)}
                          className={`p-2.5 rounded-2xl border text-left transition-all ${
                            isActive
                              ? 'bg-pink-500/10 border-pink-500 text-white shadow-md shadow-pink-500/10 ring-1 ring-pink-500/40'
                              : 'bg-[#181a1f] border-[#26282e] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-base">{p.icon}</span>
                            {p.badge && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded bg-pink-500/20 text-pink-300 font-semibold">
                                {p.badge}
                              </span>
                            )}
                          </div>
                          <p className="text-xs font-bold text-white truncate">{p.name}</p>
                          <p className="text-[10px] text-zinc-500 font-mono mt-0.5">
                            {p.ratio} · {p.res}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Video Format & Quality */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">
                      Video Format
                    </span>
                    <div className="grid grid-cols-3 gap-1 bg-[#181a1f] border border-[#26282e] rounded-xl p-1">
                      {[
                        { id: 'mp4', label: 'MP4', badge: 'H.264' },
                        { id: 'mov', label: 'MOV', badge: 'Apple' },
                        { id: 'webm', label: 'WebM', badge: 'Web' },
                      ].map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => setVideoFormat(f.id as any)}
                          className={`py-1.5 px-1.5 rounded-lg text-center transition-all ${
                            videoFormat === f.id
                              ? 'bg-pink-500 text-white font-bold shadow-sm'
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
                    <div className="grid grid-cols-3 gap-1 bg-[#181a1f] border border-[#26282e] rounded-xl p-1">
                      {[
                        { id: '1080p', label: '1080p', badge: 'FHD' },
                        { id: '4k', label: '4K', badge: 'UHD' },
                        { id: '720p', label: '720p', badge: 'HD' },
                      ].map((q) => (
                        <button
                          key={q.id}
                          type="button"
                          onClick={() => setVideoQuality(q.id as any)}
                          className={`py-1.5 px-1.5 rounded-lg text-center transition-all ${
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

                {/* Framing / Scale Mode */}
                <div className="space-y-2">
                  <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block">
                    Video Framing & Background
                  </span>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: 'blur', label: 'Blur Fill', desc: 'Blurred bg' },
                      { id: 'fit', label: 'Fit Black Bars', desc: 'Letterbox' },
                      { id: 'fill', label: 'Zoom & Crop', desc: 'Full screen' },
                    ].map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        onClick={() => setScaleMode(mode.id as any)}
                        className={`p-2.5 rounded-xl border text-left transition-all ${
                          scaleMode === mode.id
                            ? 'bg-blue-600/20 border-blue-500 text-white shadow-sm'
                            : 'bg-[#181a1f] border-[#26282e] text-zinc-400 hover:border-zinc-700'
                        }`}
                      >
                        <p className="text-xs font-bold text-white">{mode.label}</p>
                        <p className="text-[10px] text-zinc-500">{mode.desc}</p>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Subtitle & Audio Options */}
                <div className="grid grid-cols-2 gap-3 bg-[#181a1f] border border-[#26282e] rounded-2xl p-3.5">
                  <div className="space-y-1.5">
                    <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">
                      Subtitles
                    </span>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={burnSubtitles}
                        onChange={(e) => setBurnSubtitles(e.target.checked)}
                        className="rounded accent-pink-500"
                      />
                      <span className="text-xs text-zinc-200 font-medium">Burn-in Captions</span>
                    </label>
                  </div>

                  <div className="space-y-1.5">
                    <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">
                      Audio Mix
                    </span>
                    <select
                      value={bgAudio}
                      onChange={(e) => setBgAudio(e.target.value as any)}
                      className="w-full bg-[#121316] border border-[#26282e] rounded-xl px-2.5 py-1.5 text-xs text-white focus:outline-none"
                    >
                      <option value="music">🎵 AI Voice + BGM Only (Original Vocals Removed)</option>
                      <option value="original">🗣️ AI Voice + Original Audio (With Original Voices)</option>
                      <option value="none">🔇 AI Voice Only (Muted Background)</option>
                    </select>
                  </div>
                </div>

                {/* Output Filename */}
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">
                    File Name
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={exportName}
                      onChange={(e) => setExportName(e.target.value)}
                      className="flex-1 bg-[#181a1f] border border-[#26282e] focus:border-pink-500 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none transition-colors"
                      placeholder="export_video_name"
                    />
                    <span className="text-xs text-zinc-400 font-mono shrink-0 font-bold">.{videoFormat}</span>
                  </div>
                </div>

                {/* Real-Time Progress Bar & Status */}
                {exporting && (
                  <div className="p-4 rounded-2xl bg-pink-950/30 border border-pink-500/40 space-y-2.5 animate-in fade-in">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-pink-300 flex items-center gap-2 truncate max-w-[80%]">
                        <Loader2 className="w-4 h-4 animate-spin text-pink-400 shrink-0" />
                        <span className="truncate">{statusMessage || 'Rendering Video...'}</span>
                      </span>
                      <span className="font-mono font-extrabold text-white text-sm shrink-0 ml-2">{progress}%</span>
                    </div>
                    <div className="w-full h-2.5 bg-zinc-800/90 rounded-full overflow-hidden p-0.5 border border-zinc-700/60 shadow-inner">
                      <div
                        className="h-full bg-gradient-to-r from-pink-500 via-purple-500 to-emerald-400 rounded-full transition-all duration-300 shadow-md shadow-pink-500/20"
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
                  <div className="p-3.5 rounded-2xl bg-emerald-950/60 border border-emerald-800 text-emerald-200 text-xs font-semibold flex items-center gap-2 animate-in fade-in">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span>Video successfully rendered and downloaded!</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 border-t border-[#1c1e24] bg-[#121316] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <Sparkles className="w-3.5 h-3.5 text-pink-400" />
            <span>Meatika High-Performance FFmpeg Render</span>
          </div>

          <div className="flex items-center gap-3">
            {!inline && (
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
            )}

            {tab === 'video' && (
              <button
                onClick={handleVideoExport}
                disabled={exporting || !hasVideo}
                className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-xs font-bold transition-all shadow-lg active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed ${
                  done
                    ? 'bg-emerald-600 text-white shadow-emerald-600/30'
                    : 'bg-gradient-to-r from-pink-500 to-purple-600 hover:from-pink-400 hover:to-purple-500 text-white shadow-pink-500/25'
                }`}
              >
                {exporting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Rendering ({progress}%)...</span>
                  </>
                ) : done ? (
                  <>
                    <Check className="w-4 h-4" />
                    <span>Downloaded!</span>
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    <span>Export & Download MP4</span>
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
