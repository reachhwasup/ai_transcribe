import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
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
  Smartphone,
  FileText,
  Check,
  Subtitles,
  Play,
  Pause,
} from 'lucide-react';
import { buildClipLayout, totalTimelineDuration, sourceToTimeline, timelineToSource } from '../utils/clipTimemap';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Render as an in-page panel (Deliver tab) instead of a floating modal */
  inline?: boolean;
}

const PLATFORM_ICONS: Record<string, string> = {
  tiktok: '🎵',
  youtube: '▶️',
  youtube_shorts: '📱',
  facebook: '📘',
  facebook_reels: '🎞️',
  instagram_reels: '📸',
  custom: '⚙️',
};

export default function ExportModal({ open, onClose, inline = false }: Props) {
  const { currentProject, videoClips, videoMuted, subtitleStyle } = useProjectStore();
  const previewRef = useRef<HTMLVideoElement>(null);
  const previewBgRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number>(0);
  const aiAudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const clipLayout = useMemo(() => buildClipLayout(videoClips), [videoClips]);
  const [tab, setTab] = useState<'subtitle' | 'video'>('video');
  const [platforms, setPlatforms] = useState<Record<string, PlatformPreset>>({});
  const [selectedPlatform, setSelectedPlatform] = useState('youtube');
  const [scaleMode, setScaleMode] = useState<'fit' | 'fill' | 'blur'>('fit');
  const [exportName, setExportName] = useState('export');
  const [trimEnabled, setTrimEnabled] = useState(false);
  const [startTime, setStartTime] = useState('0');
  const [endTime, setEndTime] = useState('');
  const [splitEnabled, setSplitEnabled] = useState(false);
  const [splitDuration, setSplitDuration] = useState('60');
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewTime, setPreviewTime] = useState(0); // timeline time

  // Keep the blurred background preview in sync with the main preview
  useEffect(() => {
    const bg = previewBgRef.current;
    const main = previewRef.current;
    if (!bg || !main || scaleMode !== 'blur') return;
    if (previewPlaying) bg.play().catch(() => {});
    else bg.pause();
    if (Math.abs(bg.currentTime - main.currentTime) > 0.35) {
      bg.currentTime = main.currentTime;
    }
  }, [previewPlaying, previewTime, scaleMode]);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [currentSourceTime, setCurrentSourceTime] = useState(0);
  const [subtitleLanguage, setSubtitleLanguage] = useState('');
  const [translatedSegments, setTranslatedSegments] = useState<Array<{ start_time: number; end_time: number; text: string }>>([]);
  const [translating, setTranslating] = useState(false);

  // Fetch translated segments when language changes
  useEffect(() => {
    if (!subtitleLanguage || !currentProject || subtitleLanguage === (currentProject.language || 'km')) {
      setTranslatedSegments([]);
      return;
    }
    let cancelled = false;
    setTranslating(true);
    translateSegments(currentProject.id, subtitleLanguage)
      .then(segs => { if (!cancelled) setTranslatedSegments(segs); })
      .catch(() => { if (!cancelled) setTranslatedSegments([]); })
      .finally(() => { if (!cancelled) setTranslating(false); });
    return () => { cancelled = true; };
  }, [subtitleLanguage, currentProject?.id, currentProject?.language]);

  const previewTlDuration = useMemo(() => {
    if (videoClips.length > 0) return totalTimelineDuration(videoClips);
    return currentProject?.duration || 0;
  }, [videoClips, currentProject?.duration]);

  useEffect(() => {
    if (open && currentProject) {
      setError('');
      setDone(false);
      setProgress(0);
      setPreviewPlaying(false);
      setPreviewTime(0);
      setEndTime(String(Math.floor(currentProject.duration || 60)));
      // Default export name = the uploaded video's filename (without extension)
      const base = (currentProject.video_filename || currentProject.name || 'export').replace(/\.[^.]+$/, '');
      setExportName(base);
      fetchPlatforms(currentProject.id)
        .then(setPlatforms)
        .catch(() => {});
    }
  }, [open, currentProject]);

  // When modal opens, seek to first clip start
  useEffect(() => {
    const video = previewRef.current;
    if (!video || !open) return;
    if (clipLayout.length > 0) {
      video.currentTime = clipLayout[0].clip.source_start;
    } else {
      video.currentTime = 0;
    }
  }, [open, clipLayout]);

  // Clip-aware playback loop using requestAnimationFrame
  useEffect(() => {
    const video = previewRef.current;
    if (!video || !previewPlaying) return;

    // Sync AI audio for a given source time
    const syncAiAudio = (srcTime: number) => {
      const segs = currentProject?.segments || [];
      segs.forEach((seg) => {
        if (!seg.audio_url) return;
        const audio = aiAudioRefs.current.get(seg.id);
        if (!audio) return;
        const inRange = srcTime >= seg.start_time && srcTime < seg.end_time;
        if (inRange) {
          const expectedTime = srcTime - seg.start_time;
          if (audio.paused) {
            audio.currentTime = expectedTime;
            audio.play().catch(() => {});
          } else if (Math.abs(audio.currentTime - expectedTime) > 0.3) {
            audio.currentTime = expectedTime;
          }
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

      if (clipLayout.length > 0) {
        // Check if in any clip
        let inClip = false;
        for (const l of clipLayout) {
          if (srcTime >= l.clip.source_start && srcTime < l.clip.source_end) {
            inClip = true;
            const tlTime = l.timelineStart + (srcTime - l.clip.source_start);
            setPreviewTime(tlTime);
            setCurrentSourceTime(srcTime);
            break;
          }
        }
        if (!inClip) {
          // Jump to next clip or stop
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
            // Past all clips — pause everything
            video.pause();
            pauseAllAiAudio();
            setPreviewPlaying(false);
            setPreviewTime(previewTlDuration);
            return;
          }
        }
      } else {
        // No clips — simple playback
        setPreviewTime(srcTime);
        setCurrentSourceTime(srcTime);
        if (srcTime >= (currentProject?.duration || video.duration)) {
          video.pause();
          pauseAllAiAudio();
          setPreviewPlaying(false);
          return;
        }
      }

      syncAiAudio(srcTime);
      rafRef.current = requestAnimationFrame(tick);
    };

    video.play().catch(() => setPreviewPlaying(false));
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [previewPlaying, clipLayout, previewTlDuration]);

  const pauseAllAiAudio = useCallback(() => {
    aiAudioRefs.current.forEach((audio) => {
      if (!audio.paused) {
        audio.pause();
        audio.currentTime = 0;
      }
    });
  }, []);

  // Pause video and AI audio when previewPlaying becomes false
  useEffect(() => {
    if (!previewPlaying) {
      if (previewRef.current && !previewRef.current.paused) {
        previewRef.current.pause();
      }
      pauseAllAiAudio();
    }
  }, [previewPlaying, pauseAllAiAudio]);

  // Clean up on modal close
  useEffect(() => {
    if (!open) {
      cancelAnimationFrame(rafRef.current);
      setPreviewPlaying(false);
      pauseAllAiAudio();
    }
  }, [open, pauseAllAiAudio]);

  const togglePreview = useCallback(() => {
    setPreviewPlaying((p) => !p);
  }, []);

  const seekPreview = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const newTlTime = pct * previewTlDuration;
    setPreviewTime(newTlTime);

    const video = previewRef.current;
    if (!video) return;

    if (clipLayout.length > 0) {
      const result = timelineToSource(clipLayout, newTlTime);
      if (result) {
        video.currentTime = result.sourceTime;
      }
    } else {
      video.currentTime = newTlTime;
    }
  }, [clipLayout, previewTlDuration]);

  const handleSubtitleExport = (format: string) => {
    if (!currentProject) return;
    const lang = subtitleLanguage || undefined;
    const url = getExportUrl(currentProject.id, format, lang);
    window.open(url, '_blank');
  };

  const handleVideoExport = async () => {
    if (!currentProject) return;
    setExporting(true);
    setError('');
    setProgress(0);
    setDone(false);

    try {
      const blob = await exportVideoForPlatform(
        currentProject.id,
        selectedPlatform,
        trimEnabled ? parseFloat(startTime) : undefined,
        trimEnabled ? parseFloat(endTime) : undefined,
        true,
        (p) => setProgress(p),
        true,
        splitEnabled ? parseFloat(splitDuration) : undefined,
        subtitleLanguage || undefined,
        videoMuted,
        scaleMode,
        subtitleStyle.sizePct,
        subtitleStyle.position,
      );

      // Download the blob
      const isZip = blob.type === 'application/zip' || (splitEnabled && parseFloat(splitDuration) > 0);
      const ext = isZip ? 'zip' : 'mp4';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = (exportName.trim() || currentProject.name || 'export').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_');
      a.download = `${safeName}${isZip ? '_parts' : ''}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch (e: any) {
      const msg = e?.response?.data
        ? await e.response.data.text?.() || 'Export failed'
        : e.message || 'Export failed';
      setError(typeof msg === 'string' ? msg : 'Export failed');
    }
    setExporting(false);
  };

  if (!open) return null;

  const preset = platforms[selectedPlatform];
  const hasVideo = !!currentProject?.video_path;
  const hasSegments = (currentProject?.segments?.length ?? 0) > 0;

  // Compute timeline duration from clips vs full video
  const fullDuration = currentProject?.duration || 0;
  const tlDuration = videoClips.length > 0 ? totalTimelineDuration(videoClips) : fullDuration;

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div
      className={
        inline
          ? 'h-full overflow-y-auto flex justify-center py-4 px-4'
          : 'fixed inset-0 bg-black/60 flex items-center justify-center z-50'
      }
      onClick={inline ? undefined : onClose}
    >
      <div
        className={`bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-2xl shadow-2xl flex flex-col ${
          inline ? 'h-fit' : 'mx-4 max-h-[90vh]'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-3">
            <Download className="w-5 h-5 text-green-400" />
            <h2 className="text-lg font-semibold text-white">Export</h2>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-zinc-800 rounded-lg transition-colors">
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-zinc-800 px-6 shrink-0">
          <button
            onClick={() => setTab('video')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === 'video'
                ? 'border-khmer-500 text-white'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <span className="flex items-center gap-2">
              <Monitor className="w-4 h-4" />
              Video Export
            </span>
          </button>
          <button
            onClick={() => setTab('subtitle')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === 'subtitle'
                ? 'border-khmer-500 text-white'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <span className="flex items-center gap-2">
              <FileText className="w-4 h-4" />
              Subtitle Export
            </span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-6 py-5">
          {tab === 'subtitle' ? (
            /* Subtitle export */
            <div className="space-y-3">
              <p className="text-sm text-zinc-400 mb-4">Download transcript as subtitle file</p>
              {[
                { fmt: 'srt', label: 'SubRip (.SRT)', desc: 'Most widely supported format' },
                { fmt: 'vtt', label: 'WebVTT (.VTT)', desc: 'HTML5 web video subtitles' },
                { fmt: 'txt', label: 'Plain Text (.TXT)', desc: 'Simple text transcript' },
                { fmt: 'json', label: 'JSON (.JSON)', desc: 'Structured data with timestamps' },
              ].map(({ fmt, label, desc }) => (
                <button
                  key={fmt}
                  onClick={() => handleSubtitleExport(fmt)}
                  disabled={!hasSegments}
                  className="w-full flex items-center gap-4 px-4 py-3 rounded-lg border border-zinc-800 hover:border-zinc-600 hover:bg-zinc-800/50 transition-all text-left disabled:opacity-30"
                >
                  <div className="w-10 h-10 rounded-lg bg-zinc-800 flex items-center justify-center shrink-0">
                    <FileText className="w-5 h-5 text-green-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white">{label}</p>
                    <p className="text-xs text-zinc-500">{desc}</p>
                  </div>
                  <Download className="w-4 h-4 text-zinc-500" />
                </button>
              ))}
            </div>
          ) : (
            /* Video export */
            <div className="space-y-5">
              {!hasVideo ? (
                <div className="text-center py-8 text-zinc-500">
                  <p>No video uploaded. Upload a video first to export.</p>
                </div>
              ) : (
                <>
                  {/* Video Preview with custom controls */}
                  <div className="rounded-lg overflow-hidden bg-black border border-zinc-700/50">
                    <div
                      className="relative cursor-pointer mx-auto bg-black flex items-center justify-center transition-all duration-300"
                      style={{
                        aspectRatio: preset ? `${preset.width} / ${preset.height}` : '16 / 9',
                        maxHeight: '240px',
                      }}
                      onClick={togglePreview}
                    >
                      {scaleMode === 'blur' && (
                        <video
                          ref={previewBgRef}
                          src={`/uploads/${currentProject.id}/${currentProject.video_path?.split('/').pop()}`}
                          className="absolute inset-0 w-full h-full object-cover blur-xl scale-110 opacity-80"
                          preload="metadata"
                          muted
                        />
                      )}
                      <video
                        ref={previewRef}
                        src={`/uploads/${currentProject.id}/${currentProject.video_path?.split('/').pop()}`}
                        className={`relative ${scaleMode === 'fill' ? 'w-full h-full object-cover' : 'max-w-full max-h-full object-contain'}`}
                        preload="metadata"
                        muted={videoMuted}
                      />
                      {/* Subtitle overlay */}
                      {showSubtitles && (() => {
                        const segments = translatedSegments.length > 0 ? translatedSegments : (currentProject?.segments || []);
                        const seg = segments.find(
                          s => currentSourceTime >= s.start_time && currentSourceTime < s.end_time
                        );
                        if (!seg) return null;
                        return (
                          <div className="absolute bottom-4 left-2 right-2 text-center pointer-events-none">
                            <span className="inline-block px-3 py-1 bg-black/70 rounded text-white text-sm font-medium leading-snug max-w-full">
                              {seg.text}
                            </span>
                          </div>
                        );
                      })()}
                      {translating && (
                        <div className="absolute top-2 right-2 pointer-events-none">
                          <span className="text-[10px] bg-black/60 text-yellow-400 px-2 py-0.5 rounded">Translating...</span>
                        </div>
                      )}
                      {!previewPlaying && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                          <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur flex items-center justify-center">
                            <Play className="w-6 h-6 text-white ml-0.5" />
                          </div>
                        </div>
                      )}
                    </div>
                    {/* Custom progress bar */}
                    <div className="px-3 py-2 bg-zinc-900/80 flex items-center gap-3">
                      <button onClick={togglePreview} className="text-white hover:text-zinc-300 transition-colors">
                        {previewPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                      </button>
                      <div
                        className="flex-1 h-1.5 bg-zinc-700 rounded-full cursor-pointer relative group"
                        onClick={seekPreview}
                      >
                        <div
                          className="h-full bg-khmer-500 rounded-full transition-[width] duration-75"
                          style={{ width: `${previewTlDuration > 0 ? (previewTime / previewTlDuration) * 100 : 0}%` }}
                        />
                        <div
                          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow opacity-0 group-hover:opacity-100 transition-opacity"
                          style={{ left: `${previewTlDuration > 0 ? (previewTime / previewTlDuration) * 100 : 0}%`, marginLeft: '-6px' }}
                        />
                      </div>
                      <button
                        onClick={() => setShowSubtitles(p => !p)}
                        className={`transition-colors ${showSubtitles ? 'text-yellow-400 hover:text-yellow-300' : 'text-zinc-500 hover:text-zinc-300'}`}
                        title={showSubtitles ? 'Hide subtitles' : 'Show subtitles'}
                      >
                        <Subtitles className="w-4 h-4" />
                      </button>
                      {showSubtitles && (
                        <select
                          value={subtitleLanguage}
                          onChange={e => setSubtitleLanguage(e.target.value)}
                          className="bg-zinc-800 border border-zinc-700 text-[10px] text-zinc-300 rounded px-1.5 py-0.5 focus:outline-none focus:border-zinc-500"
                          title="Subtitle language"
                        >
                          <option value="">Original</option>
                          <option value="en">English</option>
                          <option value="km">ខ្មែរ</option>
                          <option value="zh">中文</option>
                          <option value="ja">日本語</option>
                          <option value="ko">한국어</option>
                          <option value="th">ไทย</option>
                          <option value="vi">Tiếng Việt</option>
                          <option value="fr">Français</option>
                          <option value="es">Español</option>
                        </select>
                      )}
                      <span className="text-[10px] text-zinc-400 font-mono min-w-[70px] text-right">
                        {formatTime(previewTime)} / {formatTime(previewTlDuration)}
                      </span>
                    </div>
                  </div>

                  {/* Trim controls */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm text-zinc-300">Trim video before export</span>
                      <button
                        onClick={() => setTrimEnabled(p => !p)}
                        className={`relative w-10 h-5 rounded-full transition-colors ${
                          trimEnabled ? 'bg-khmer-500' : 'bg-zinc-700'
                        }`}
                      >
                        <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          trimEnabled ? 'translate-x-5' : 'translate-x-0'
                        }`} />
                      </button>
                    </div>

                    {trimEnabled && (
                      <div className="flex gap-3">
                        <div>
                          <label className="text-[10px] text-zinc-500 block mb-1">Start (sec)</label>
                          <input
                            type="number"
                            min={0}
                            step={0.1}
                            value={startTime}
                            onChange={(e) => setStartTime(e.target.value)}
                            className="w-24 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-white font-mono focus:outline-none focus:border-khmer-500"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-zinc-500 block mb-1">End (sec)</label>
                          <input
                            type="number"
                            min={0}
                            step={0.1}
                            value={endTime}
                            onChange={(e) => setEndTime(e.target.value)}
                            className="w-24 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-white font-mono focus:outline-none focus:border-khmer-500"
                          />
                        </div>
                        <div className="flex items-end">
                          <span className="text-[10px] text-zinc-600 pb-2">
                            Duration: {Math.max(0, parseFloat(endTime || '0') - parseFloat(startTime || '0')).toFixed(1)}s
                          </span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Split into multiple videos */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm text-zinc-300">Split into multiple videos</span>
                      <button
                        onClick={() => setSplitEnabled(p => !p)}
                        className={`relative w-10 h-5 rounded-full transition-colors ${
                          splitEnabled ? 'bg-khmer-500' : 'bg-zinc-700'
                        }`}
                      >
                        <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          splitEnabled ? 'translate-x-5' : 'translate-x-0'
                        }`} />
                      </button>
                    </div>

                    {splitEnabled && (() => {
                      const dur = parseFloat(splitDuration) || 0;
                      const totalDur = tlDuration || fullDuration;
                      const numParts = dur > 0 ? Math.ceil(totalDur / dur) : 0;
                      return (
                        <div className="space-y-2">
                          <div className="flex items-end gap-3">
                            <div>
                              <label className="text-[10px] text-zinc-500 block mb-1">Duration per part (sec)</label>
                              <input
                                type="number"
                                min={1}
                                step={1}
                                value={splitDuration}
                                onChange={(e) => setSplitDuration(e.target.value)}
                                className="w-28 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-white font-mono focus:outline-none focus:border-khmer-500"
                              />
                            </div>
                            <div className="pb-1">
                              <span className="text-[10px] text-zinc-500">
                                Total: {formatTime(totalDur)}
                              </span>
                            </div>
                          </div>
                          {dur > 0 && numParts > 0 && (
                            <p className="text-xs text-zinc-400">
                              Will produce <span className="text-white font-medium">{numParts} video{numParts !== 1 ? 's' : ''}</span>
                              {numParts > 1 && (
                                <span className="text-zinc-500">
                                  {' '}({numParts - 1} × {formatTime(dur)} + 1 × {formatTime(totalDur - (numParts - 1) * dur)})
                                </span>
                              )}
                              {' '}— downloaded as ZIP
                            </p>
                          )}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Platform selection */}
                  <div>
                    <label className="text-sm font-medium text-zinc-300 mb-3 block">
                      Choose Platform
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {Object.entries(platforms).map(([key, p]) => (
                        <button
                          key={key}
                          onClick={() => setSelectedPlatform(key)}
                          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-all ${
                            selectedPlatform === key
                              ? 'border-khmer-500 bg-khmer-900/20'
                              : 'border-zinc-800 hover:border-zinc-600 bg-zinc-800/40'
                          }`}
                        >
                          <span className="text-lg">{PLATFORM_ICONS[key] || '🎬'}</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-white truncate">{p.name}</p>
                            <p className="text-[10px] text-zinc-500 truncate">
                              {p.width}x{p.height}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Preset info */}
                  {preset && (
                    <div className="px-3 py-2.5 rounded-lg bg-zinc-800/60 border border-zinc-700/50">
                      <p className="text-xs text-zinc-400">{preset.description}</p>
                      <div className="flex gap-4 mt-1.5 text-[10px] text-zinc-500">
                        <span>Resolution: {preset.width}x{preset.height}</span>
                        {preset.max_duration && (
                          <span>Max: {preset.max_duration}s</span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Video fit — how the source fills the target frame */}
                  <div>
                    <label className="text-sm font-medium text-zinc-300 mb-2 block">
                      Video Fit
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {([
                        { id: 'fit', label: 'Fit', desc: 'Whole video, black bars' },
                        { id: 'fill', label: 'Zoom / Crop', desc: 'Fills frame, cuts sides' },
                        { id: 'blur', label: 'Blur Fill', desc: 'Blurred background' },
                      ] as const).map((m) => (
                        <button
                          key={m.id}
                          onClick={() => setScaleMode(m.id)}
                          className={`px-2 py-2 rounded-lg border text-center transition-all ${
                            scaleMode === m.id
                              ? 'border-khmer-500 bg-khmer-900/20'
                              : 'border-zinc-800 hover:border-zinc-600 bg-zinc-800/40'
                          }`}
                        >
                          <p className="text-xs font-medium text-white">{m.label}</p>
                          <p className="text-[9px] text-zinc-500 mt-0.5">{m.desc}</p>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Export file name */}
                  <div>
                    <label className="text-sm font-medium text-zinc-300 mb-2 block">
                      File Name
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={exportName}
                        onChange={(e) => setExportName(e.target.value)}
                        placeholder="export name"
                        className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-khmer-500"
                      />
                      <span className="text-xs text-zinc-500 shrink-0">.mp4</span>
                    </div>
                  </div>

                  {/* Progress */}
                  {exporting && (
                    <div className="space-y-2">
                      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-khmer-500 rounded-full transition-all"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <p className="text-xs text-zinc-500 text-center">
                        {progress > 0 ? `Downloading... ${progress}%` : 'Processing video...'}
                      </p>
                    </div>
                  )}

                  {/* Error */}
                  {error && (
                    <div className="px-3 py-2 bg-red-900/20 border border-red-800/30 rounded-lg">
                      <p className="text-xs text-red-300">{error}</p>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-zinc-800 shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          {tab === 'video' && hasVideo && (
            <button
              onClick={handleVideoExport}
              disabled={exporting}
              className="flex items-center gap-2 px-4 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
            >
              {exporting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : done ? (
                <Check className="w-4 h-4" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              {done ? 'Downloaded!' : exporting ? 'Exporting...' : 'Export Video'}
            </button>
          )}
        </div>
      </div>

      {/* Hidden audio elements for AI voice preview */}
      {(currentProject?.segments || []).filter(s => s.audio_url).map(seg => (
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
