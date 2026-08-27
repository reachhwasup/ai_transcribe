import { useState, useEffect, useRef, RefObject } from 'react';
import { useProjectStore } from '../stores/projectStore';
import {
  flipVideo, resizeVideo, changeVideoSpeed, splitVideo,
  burnSubtitles, generateSelectedVideo,
  separateProjectAudio, checkAudioSeparation,
  uploadProjectLogo, applyVideoLogo,
} from '../api/client';
import {
  X,
  Loader2,
  Check,
  Download,
  AlertCircle,
  FlipHorizontal2,
  FlipVertical2,
  Maximize2,
  Gauge,
  SplitSquareVertical,
  Plus,
  Trash2,
  Play,
  Type,
  Film,
  RefreshCw,
  Mic,
  Music,
  Image as ImageIcon,
  Upload,
} from 'lucide-react';

type Tab = 'flip' | 'resize' | 'speed' | 'text' | 'logo' | 'generate' | 'split' | 'isolate_vocal' | 'isolate_bgm';

interface Props {
  open: boolean;
  onClose: () => void;
  videoRef: RefObject<HTMLVideoElement | null>;
  initialTab?: Tab;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const TABS: { key: Tab; label: string; icon: React.ReactNode; color: string }[] = [
  { key: 'flip', label: 'Flip', icon: <FlipHorizontal2 className="w-3.5 h-3.5" />, color: 'text-cyan-400' },
  { key: 'resize', label: 'Resize', icon: <Maximize2 className="w-3.5 h-3.5" />, color: 'text-emerald-400' },
  { key: 'speed', label: 'Speed', icon: <Gauge className="w-3.5 h-3.5" />, color: 'text-amber-400' },
  { key: 'text', label: 'Subtitle', icon: <Type className="w-3.5 h-3.5" />, color: 'text-rose-400' },
  { key: 'logo', label: 'Logo / Image', icon: <ImageIcon className="w-3.5 h-3.5" />, color: 'text-indigo-400' },
  { key: 'generate', label: 'Generate', icon: <Film className="w-3.5 h-3.5" />, color: 'text-blue-400' },
  { key: 'split', label: 'Split', icon: <SplitSquareVertical className="w-3.5 h-3.5" />, color: 'text-violet-400' },
  { key: 'isolate_vocal', label: 'Vocal', icon: <Mic className="w-3.5 h-3.5" />, color: 'text-purple-400' },
  { key: 'isolate_bgm', label: 'BGM', icon: <Music className="w-3.5 h-3.5" />, color: 'text-pink-400' },
];

const RESIZE_PRESETS = [
  { label: '1080p', w: 1920, h: 1080 },
  { label: '720p', w: 1280, h: 720 },
  { label: '480p', w: 854, h: 480 },
  { label: '9:16', w: 1080, h: 1920 },
  { label: 'Square', w: 1080, h: 1080 },
  { label: '4:3', w: 1440, h: 1080 },
];

const FONT_COLORS = [
  { label: 'White', value: 'white' },
  { label: 'Yellow', value: 'yellow' },
  { label: 'Red', value: 'red' },
  { label: 'Green', value: 'green' },
  { label: 'Cyan', value: 'cyan' },
  { label: 'Black', value: 'black' },
];

export default function VideoToolsModal({ open, onClose, videoRef, initialTab = 'logo' }: Props) {
  const { currentProject, loadProject } = useProjectStore();
  const duration = currentProject?.duration || 0;

  const [tab, setTab] = useState<Tab>(initialTab || 'logo');
  const [processing, setProcessing] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open && initialTab) {
      setTab(initialTab);
    }
  }, [open, initialTab]);

  // Flip
  const [flipDir, setFlipDir] = useState<'horizontal' | 'vertical'>('horizontal');

  // Resize
  const [resizeW, setResizeW] = useState('1920');
  const [resizeH, setResizeH] = useState('1080');

  // Speed
  const [speed, setSpeed] = useState('1.0');

  // Text overlay
  const [fontSize, setFontSize] = useState('28');
  const [fontColor, setFontColor] = useState('white');
  const [textPosition, setTextPosition] = useState('bottom');
  const [bgOpacity, setBgOpacity] = useState('0.5');

  // Generate selected
  const [genStart, setGenStart] = useState('0');
  const [genEnd, setGenEnd] = useState(String(Math.min(60, Math.floor(duration))));
  const [genText, setGenText] = useState('');
  const [genFontSize, setGenFontSize] = useState('48');
  const [genFontColor, setGenFontColor] = useState('white');
  const [genPosition, setGenPosition] = useState('bottom');

  // Split
  const [splitPoints, setSplitPoints] = useState<string[]>(['']);

  // Audio isolation
  const [audioSeparated, setAudioSeparated] = useState(false);
  const [vocalsUrl, setVocalsUrl] = useState('');
  const [bgmUrl, setBgmUrl] = useState('');

  // Logo / Watermark
  const [logoUrl, setLogoUrl] = useState('');
  const [logoPosition, setLogoPosition] = useState('top_right');
  const [logoScalePct, setLogoScalePct] = useState(15);
  const [logoOpacity, setLogoOpacity] = useState(1.0);
  const [logoXPct, setLogoXPct] = useState(85);
  const [logoYPct, setLogoYPct] = useState(5);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const projectName = currentProject?.name?.replace(/\s+/g, '_') || 'video';
  const hasVideo = !!currentProject?.video_path;

  const resetState = () => { setDone(false); setError(''); };

  // Check if audio has already been separated when modal opens
  useEffect(() => {
    if (!open || !currentProject?.id) return;
    checkAudioSeparation(currentProject.id).then((status) => {
      if (status.separated && status.vocals_url && status.bgm_url) {
        setAudioSeparated(true);
        setVocalsUrl(status.vocals_url);
        setBgmUrl(status.bgm_url);
      }
    }).catch(() => { /* ignore */ });
  }, [open, currentProject?.id]);

  const reloadProject = async () => {
    if (currentProject) {
      await loadProject(currentProject.id);
      if (videoRef.current) {
        videoRef.current.load();
      }
    }
  };

  // --- In-place handlers ---

  const handleFlip = async () => {
    if (!currentProject) return;
    setProcessing(true); resetState();
    try {
      await flipVideo(currentProject.id, flipDir);
      await reloadProject();
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Flip failed');
    }
    setProcessing(false);
  };

  const handleResize = async () => {
    if (!currentProject) return;
    setProcessing(true); resetState();
    try {
      await resizeVideo(currentProject.id, parseInt(resizeW) || 1920, parseInt(resizeH) || 1080);
      await reloadProject();
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Resize failed');
    }
    setProcessing(false);
  };

  const handleSpeed = async () => {
    if (!currentProject) return;
    setProcessing(true); resetState();
    try {
      await changeVideoSpeed(currentProject.id, parseFloat(speed) || 1.0);
      await reloadProject();
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Speed change failed');
    }
    setProcessing(false);
  };

  const handleTextOverlay = async () => {
    if (!currentProject) return;
    const segments = currentProject.segments || [];
    if (segments.length === 0) { setError('No subtitle segments. Transcribe the video first.'); return; }
    setProcessing(true); resetState();
    try {
      await burnSubtitles(
        currentProject.id,
        parseInt(fontSize) || 28, fontColor, textPosition, parseFloat(bgOpacity) || 0.5,
      );
      await reloadProject();
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Burn subtitles failed');
    }
    setProcessing(false);
  };

  // --- In-place handlers ---

  const handleGenerate = async () => {
    if (!currentProject) return;
    const s = parseFloat(genStart) || 0;
    const e2 = parseFloat(genEnd) || 0;
    if (e2 <= s) { setError('End time must be greater than start time'); return; }
    setProcessing(true); resetState();
    try {
      await generateSelectedVideo(
        currentProject.id, s, e2,
        genText || undefined, parseInt(genFontSize) || 48,
        genFontColor, genPosition, 0.5,
      );
      await reloadProject();
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Generate failed');
    }
    setProcessing(false);
  };

  const downloadAudioUrl = (url: string, filename: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleIsolateVocal = async () => {
    if (!currentProject) return;
    if (audioSeparated && vocalsUrl) {
      downloadAudioUrl(vocalsUrl, `${projectName}_vocals.wav`);
      return;
    }
    setProcessing(true); resetState();
    try {
      const result = await separateProjectAudio(currentProject.id);
      setVocalsUrl(result.vocals_url);
      setBgmUrl(result.bgm_url);
      setAudioSeparated(true);
      downloadAudioUrl(result.vocals_url, `${projectName}_vocals.wav`);
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Vocal isolation failed');
    }
    setProcessing(false);
  };

  const handleIsolateBGM = async () => {
    if (!currentProject) return;
    if (audioSeparated && bgmUrl) {
      downloadAudioUrl(bgmUrl, `${projectName}_bgm.wav`);
      return;
    }
    setProcessing(true); resetState();
    try {
      const result = await separateProjectAudio(currentProject.id);
      setVocalsUrl(result.vocals_url);
      setBgmUrl(result.bgm_url);
      setAudioSeparated(true);
      downloadAudioUrl(result.bgm_url, `${projectName}_bgm.wav`);
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'BGM isolation failed');
    }
    setProcessing(false);
  };

  const handleSplit = async () => {
    if (!currentProject) return;
    const pts = splitPoints.map((p) => parseFloat(p)).filter((p) => !isNaN(p) && p > 0);
    if (pts.length === 0) { setError('Add at least one valid split point'); return; }
    setProcessing(true); resetState();
    try {
      await splitVideo(currentProject.id, pts);
      await reloadProject();
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Split failed');
    }
    setProcessing(false);
  };

  const handleUploadLogo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProject) return;
    setUploadingLogo(true);
    setError('');
    try {
      const res = await uploadProjectLogo(currentProject.id, file);
      setLogoUrl(res.url);
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || 'Failed to upload logo image');
    }
    setUploadingLogo(false);
  };

  const handleApplyLogo = async () => {
    if (!currentProject) return;
    if (!logoUrl) {
      setError('Please upload a logo / image first');
      return;
    }
    setProcessing(true); resetState();
    try {
      await applyVideoLogo(currentProject.id, {
        logo_url: logoUrl,
        position: logoPosition,
        scale_pct: logoScalePct,
        opacity: logoOpacity,
        x_pct: logoPosition === 'custom' ? logoXPct : undefined,
        y_pct: logoPosition === 'custom' ? logoYPct : undefined,
      });
      await reloadProject();
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Failed to apply logo overlay');
    }
    setProcessing(false);
  };

  // Split helpers
  const addSplitPoint = () => {
    const t = videoRef.current?.currentTime;
    setSplitPoints((prev) => [...prev, t ? t.toFixed(2) : '']);
  };
  const removeSplitPoint = (i: number) => setSplitPoints((prev) => prev.filter((_, idx) => idx !== i));
  const updateSplitPoint = (i: number, val: string) => setSplitPoints((prev) => prev.map((p, idx) => (idx === i ? val : p)));

  const setFromPlayhead = (setter: (v: string) => void) => {
    const t = videoRef.current?.currentTime;
    if (t !== undefined) setter(t.toFixed(2));
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  if (!open) return null;

  const actionMap: Record<Tab, () => void> = {
    flip: handleFlip, resize: handleResize, speed: handleSpeed,
    text: handleTextOverlay, logo: handleApplyLogo, generate: handleGenerate, split: handleSplit,
    isolate_vocal: handleIsolateVocal, isolate_bgm: handleIsolateBGM,
  };

  const isInPlace = tab === 'flip' || tab === 'resize' || tab === 'speed' || tab === 'text' || tab === 'logo';

  const actionLabels: Record<Tab, string> = {
    flip: 'Apply Flip',
    resize: 'Apply Resize',
    speed: 'Apply Speed',
    text: 'Burn Subtitles',
    logo: 'Burn Logo Overlay',
    generate: 'Generate & Download',
    split: 'Split & Download (.zip)',
    isolate_vocal: audioSeparated ? 'Download Vocals' : 'Isolate Vocal',
    isolate_bgm: audioSeparated ? 'Download BGM' : 'Isolate BGM',
  };

  const tabColors: Record<Tab, string> = {
    flip: 'bg-cyan-700 hover:bg-cyan-600',
    resize: 'bg-emerald-700 hover:bg-emerald-600',
    speed: 'bg-amber-700 hover:bg-amber-600',
    text: 'bg-rose-700 hover:bg-rose-600',
    logo: 'bg-indigo-700 hover:bg-indigo-600',
    generate: 'bg-blue-700 hover:bg-blue-600',
    split: 'bg-violet-700 hover:bg-violet-600',
    isolate_vocal: 'bg-purple-700 hover:bg-purple-600',
    isolate_bgm: 'bg-pink-700 hover:bg-pink-600',
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-xl mx-4 shadow-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
          <h2 className="text-lg font-semibold text-white">Video Tools</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-zinc-800 rounded-lg transition-colors">
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-zinc-800 shrink-0">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => { setTab(t.key); resetState(); }}
              className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2.5 text-[11px] font-medium transition-colors
                ${tab === t.key
                  ? `${t.color} border-b-2 border-current bg-zinc-800/40`
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/20'
                }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4 overflow-y-auto flex-1">
          {!hasVideo ? (
            <p className="text-center text-zinc-500 py-4">No video uploaded.</p>
          ) : (
            <>
              {/* Duration info */}
              <div className="flex items-center justify-between px-3 py-2 bg-zinc-800/60 rounded-lg">
                <span className="text-xs text-zinc-500">Video Duration</span>
                <span className="text-sm font-mono text-zinc-300">
                  {formatTime(duration)} ({duration.toFixed(1)}s)
                </span>
              </div>

              {/* In-place notice */}
              {isInPlace && (
                <div className="flex items-center gap-2 px-3 py-2 bg-blue-900/20 border border-blue-800/30 rounded-lg">
                  <RefreshCw className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                  <p className="text-[11px] text-blue-300">This will modify your actual project video. The video player will update automatically.</p>
                </div>
              )}

              {/* ---- FLIP ---- */}
              {tab === 'flip' && (
                <div className="space-y-4">
                  <p className="text-xs text-zinc-400">Mirror video to avoid visual fingerprinting.</p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setFlipDir('horizontal')}
                      className={`flex-1 flex flex-col items-center gap-2 p-4 rounded-lg border transition-all ${
                        flipDir === 'horizontal'
                          ? 'bg-cyan-900/30 border-cyan-600 text-cyan-300'
                          : 'bg-zinc-800/60 border-zinc-700 text-zinc-400 hover:border-zinc-500'
                      }`}
                    >
                      <FlipHorizontal2 className="w-8 h-8" />
                      <span className="text-xs font-medium">Horizontal</span>
                    </button>
                    <button
                      onClick={() => setFlipDir('vertical')}
                      className={`flex-1 flex flex-col items-center gap-2 p-4 rounded-lg border transition-all ${
                        flipDir === 'vertical'
                          ? 'bg-cyan-900/30 border-cyan-600 text-cyan-300'
                          : 'bg-zinc-800/60 border-zinc-700 text-zinc-400 hover:border-zinc-500'
                      }`}
                    >
                      <FlipVertical2 className="w-8 h-8" />
                      <span className="text-xs font-medium">Vertical</span>
                    </button>
                  </div>
                </div>
              )}

              {/* ---- RESIZE ---- */}
              {tab === 'resize' && (
                <div className="space-y-4">
                  <p className="text-xs text-zinc-400">Change dimensions — different resolution helps bypass content matching.</p>
                  <div className="flex flex-wrap gap-2">
                    {RESIZE_PRESETS.map((p) => (
                      <button
                        key={p.label}
                        onClick={() => { setResizeW(String(p.w)); setResizeH(String(p.h)); }}
                        className={`px-3 py-1.5 rounded-md text-xs border transition-colors ${
                          resizeW === String(p.w) && resizeH === String(p.h)
                            ? 'bg-emerald-900/30 border-emerald-600 text-emerald-300'
                            : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-zinc-400 block mb-1">Width (px)</label>
                      <input type="number" min={100} max={7680} value={resizeW} onChange={(e) => setResizeW(e.target.value)}
                        className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-emerald-500" />
                    </div>
                    <div>
                      <label className="text-xs text-zinc-400 block mb-1">Height (px)</label>
                      <input type="number" min={100} max={4320} value={resizeH} onChange={(e) => setResizeH(e.target.value)}
                        className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-emerald-500" />
                    </div>
                  </div>
                </div>
              )}

              {/* ---- SPEED ---- */}
              {tab === 'speed' && (
                <div className="space-y-4">
                  <p className="text-xs text-zinc-400">Even small speed changes (1.05x) can avoid audio fingerprinting.</p>
                  <div className="flex flex-wrap gap-2">
                    {[0.5, 0.75, 0.9, 1.05, 1.1, 1.25, 1.5, 2.0].map((s) => (
                      <button key={s}
                        onClick={() => setSpeed(String(s))}
                        className={`px-3 py-1.5 rounded-md text-xs border transition-colors ${
                          speed === String(s)
                            ? 'bg-amber-900/30 border-amber-600 text-amber-300'
                            : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500'
                        }`}
                      >{s}x</button>
                    ))}
                  </div>
                  <div>
                    <label className="text-xs text-zinc-400 block mb-1">Custom Speed (0.25 - 4.0)</label>
                    <input type="number" min={0.25} max={4.0} step={0.05} value={speed}
                      onChange={(e) => setSpeed(e.target.value)}
                      className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-amber-500" />
                  </div>
                  <div className="px-3 py-2 bg-zinc-800/40 rounded-lg border border-zinc-700/50">
                    <span className="text-xs text-zinc-500">New duration: </span>
                    <span className="text-sm font-mono text-amber-400">
                      {formatTime(duration / (parseFloat(speed) || 1))} ({(duration / (parseFloat(speed) || 1)).toFixed(1)}s)
                    </span>
                  </div>
                </div>
              )}

              {/* ---- BURN SUBTITLES ---- */}
              {tab === 'text' && (
                <div className="space-y-3">
                  <p className="text-xs text-zinc-400">Burn your transcribed subtitles into the video permanently.</p>

                  {/* Subtitle preview */}
                  {(() => {
                    const segments = currentProject?.segments || [];
                    return segments.length > 0 ? (
                      <>
                        <div className="flex items-center justify-between px-3 py-2 bg-zinc-800/60 rounded-lg">
                          <span className="text-xs text-zinc-500">Subtitle Segments</span>
                          <span className="text-sm font-mono text-rose-400">{segments.length} segments</span>
                        </div>
                        <div className="max-h-[120px] overflow-y-auto space-y-1 border border-zinc-800 rounded-lg p-2">
                          {segments.slice(0, 20).map((seg, i) => (
                            <div key={seg.id || i} className="flex items-start gap-2 text-[11px]">
                              <span className="text-zinc-600 font-mono shrink-0 w-[80px]">
                                {formatTime(seg.start_time)} - {formatTime(seg.end_time)}
                              </span>
                              <span className="text-zinc-300 truncate">{seg.text}</span>
                            </div>
                          ))}
                          {segments.length > 20 && (
                            <p className="text-[10px] text-zinc-600 text-center">...and {segments.length - 20} more</p>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="flex items-center gap-2 px-3 py-3 bg-amber-900/20 border border-amber-800/30 rounded-lg">
                        <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                        <p className="text-xs text-amber-300">No subtitle segments found. Transcribe the video first.</p>
                      </div>
                    );
                  })()}

                  {/* Style controls */}
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-xs text-zinc-400 block mb-1">Font Size</label>
                      <input type="number" min={12} max={200} value={fontSize} onChange={(e) => setFontSize(e.target.value)}
                        className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-rose-500" />
                    </div>
                    <div>
                      <label className="text-xs text-zinc-400 block mb-1">Color</label>
                      <select value={fontColor} onChange={(e) => setFontColor(e.target.value)}
                        className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-rose-500">
                        {FONT_COLORS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-zinc-400 block mb-1">Position</label>
                      <select value={textPosition} onChange={(e) => setTextPosition(e.target.value)}
                        className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-rose-500">
                        <option value="top">Top</option>
                        <option value="center">Center</option>
                        <option value="bottom">Bottom</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-zinc-400 block mb-1">Background Opacity</label>
                    <input type="range" min={0} max={1} step={0.1} value={bgOpacity}
                      onChange={(e) => setBgOpacity(e.target.value)}
                      className="w-full" />
                    <div className="flex justify-between text-[10px] text-zinc-600">
                      <span>Transparent</span><span>{bgOpacity}</span><span>Opaque</span>
                    </div>
                  </div>
                </div>
              )}

              {/* ---- LOGO / IMAGE OVERLAY ---- */}
              {tab === 'logo' && (
                <div className="space-y-4">
                  <p className="text-xs text-zinc-400">
                    Add an image or brand logo watermark to your video with customizable scale, opacity, and positioning.
                  </p>

                  {/* Upload Image Section */}
                  <div className="border border-dashed border-zinc-700 hover:border-indigo-500/70 bg-zinc-800/40 rounded-xl p-4 transition-colors">
                    <input
                      ref={logoInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/svg+xml"
                      className="hidden"
                      onChange={handleUploadLogo}
                    />

                    {logoUrl ? (
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-12 rounded-lg bg-zinc-900 border border-zinc-700 flex items-center justify-center overflow-hidden p-1">
                            <img src={logoUrl} alt="Logo" className="max-w-full max-h-full object-contain" />
                          </div>
                          <div>
                            <p className="text-xs font-medium text-white">Logo Uploaded</p>
                            <p className="text-[10px] text-zinc-400 truncate max-w-[200px]">{logoUrl.split('/').pop()}</p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => logoInputRef.current?.click()}
                          disabled={uploadingLogo}
                          className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs font-medium transition-colors"
                        >
                          Change Image
                        </button>
                      </div>
                    ) : (
                      <div
                        onClick={() => logoInputRef.current?.click()}
                        className="flex flex-col items-center justify-center py-4 cursor-pointer text-center"
                      >
                        <div className="w-10 h-10 rounded-full bg-indigo-500/10 flex items-center justify-center text-indigo-400 mb-2">
                          {uploadingLogo ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
                        </div>
                        <p className="text-xs font-medium text-zinc-200">
                          {uploadingLogo ? 'Uploading logo...' : 'Click to upload Logo / Image (PNG, JPG, SVG, WebP)'}
                        </p>
                        <p className="text-[10px] text-zinc-500 mt-0.5">Supports transparent PNG watermarks & stickers</p>
                      </div>
                    )}
                  </div>

                  {/* Position & Appearance Controls */}
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs text-zinc-400 block mb-1.5 font-medium">Position on Video</label>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { id: 'top_left', label: 'Top-Left ↖' },
                          { id: 'top_right', label: 'Top-Right ↗' },
                          { id: 'bottom_left', label: 'Bottom-Left ↙' },
                          { id: 'bottom_right', label: 'Bottom-Right ↘' },
                          { id: 'center', label: 'Center 🎯' },
                          { id: 'custom', label: 'Custom XY 🎛️' },
                        ].map((pos) => (
                          <button
                            key={pos.id}
                            type="button"
                            onClick={() => setLogoPosition(pos.id)}
                            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                              logoPosition === pos.id
                                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30'
                                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white border border-zinc-700/60'
                            }`}
                          >
                            {pos.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {logoPosition === 'custom' && (
                      <div className="grid grid-cols-2 gap-3 bg-zinc-800/40 p-3 rounded-lg border border-zinc-700/40">
                        <div>
                          <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                            <span>X Position (Left-Right)</span>
                            <span className="font-mono text-indigo-400">{logoXPct}%</span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={logoXPct}
                            onChange={(e) => setLogoXPct(Number(e.target.value))}
                            className="w-full"
                          />
                        </div>
                        <div>
                          <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                            <span>Y Position (Top-Bottom)</span>
                            <span className="font-mono text-indigo-400">{logoYPct}%</span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={logoYPct}
                            onChange={(e) => setLogoYPct(Number(e.target.value))}
                            className="w-full"
                          />
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <div className="flex justify-between text-xs text-zinc-400 mb-1">
                          <span>Size / Scale</span>
                          <span className="font-mono text-indigo-400">{logoScalePct}% width</span>
                        </div>
                        <input
                          type="range"
                          min={5}
                          max={50}
                          value={logoScalePct}
                          onChange={(e) => setLogoScalePct(Number(e.target.value))}
                          className="w-full"
                        />
                      </div>

                      <div>
                        <div className="flex justify-between text-xs text-zinc-400 mb-1">
                          <span>Opacity</span>
                          <span className="font-mono text-indigo-400">{Math.round(logoOpacity * 100)}%</span>
                        </div>
                        <input
                          type="range"
                          min={0.1}
                          max={1.0}
                          step={0.05}
                          value={logoOpacity}
                          onChange={(e) => setLogoOpacity(Number(e.target.value))}
                          className="w-full"
                        />
                      </div>
                    </div>

                    {/* Interactive Visual Preview Box */}
                    {logoUrl && (
                      <div className="border border-zinc-700/60 rounded-xl p-2 bg-zinc-950/60">
                        <span className="text-[10px] text-zinc-500 block mb-1">Live Placement Preview:</span>
                        <div className="relative aspect-video w-full bg-zinc-900 rounded-lg overflow-hidden border border-zinc-800 flex items-center justify-center">
                          <span className="text-[11px] text-zinc-600 select-none">Video Canvas Preview</span>
                          <div
                            className="absolute pointer-events-none transition-all duration-150"
                            style={{
                              width: `${logoScalePct}%`,
                              opacity: logoOpacity,
                              ...(logoPosition === 'top_left' ? { top: '6%', left: '4%' } :
                                  logoPosition === 'top_right' ? { top: '6%', right: '4%' } :
                                  logoPosition === 'bottom_left' ? { bottom: '8%', left: '4%' } :
                                  logoPosition === 'bottom_right' ? { bottom: '8%', right: '4%' } :
                                  logoPosition === 'center' ? { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' } :
                                  { top: `${logoYPct}%`, left: `${logoXPct}%`, transform: 'translate(-50%, -50%)' })
                            }}
                          >
                            <img src={logoUrl} alt="Watermark" className="w-full h-auto object-contain drop-shadow" />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ---- GENERATE SELECTED ---- */}
              {tab === 'generate' && (
                <div className="space-y-3">
                  <p className="text-xs text-zinc-400">Select a portion and optionally add text. Downloads the generated clip.</p>

                  {/* Timeline visual */}
                  <div className="space-y-1">
                    <div className="relative h-6 bg-zinc-800 rounded-lg overflow-hidden">
                      {duration > 0 && (
                        <div className="absolute top-0 bottom-0 bg-blue-600/30 border-l-2 border-r-2 border-blue-500"
                          style={{
                            left: `${((parseFloat(genStart) || 0) / duration) * 100}%`,
                            width: `${(Math.max(0, (parseFloat(genEnd) || 0) - (parseFloat(genStart) || 0)) / duration) * 100}%`,
                          }} />
                      )}
                    </div>
                    <div className="flex justify-between text-[10px] text-zinc-600 font-mono">
                      <span>0:00</span>
                      <span>{formatTime(duration)}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-zinc-400 block mb-1">Start Time (s)</label>
                      <div className="flex gap-1.5">
                        <input type="number" min={0} max={duration} step={0.1} value={genStart}
                          onChange={(e) => setGenStart(e.target.value)}
                          className="flex-1 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-blue-500" />
                        <button onClick={() => setFromPlayhead(setGenStart)}
                          className="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-[10px] text-zinc-400 hover:text-white hover:border-zinc-500">Set</button>
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-zinc-400 block mb-1">End Time (s)</label>
                      <div className="flex gap-1.5">
                        <input type="number" min={0} max={duration} step={0.1} value={genEnd}
                          onChange={(e) => setGenEnd(e.target.value)}
                          className="flex-1 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-blue-500" />
                        <button onClick={() => setFromPlayhead(setGenEnd)}
                          className="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-[10px] text-zinc-400 hover:text-white hover:border-zinc-500">Set</button>
                      </div>
                    </div>
                  </div>

                  {/* Clip info */}
                  <div className="px-3 py-2 bg-zinc-800/40 rounded-lg border border-zinc-700/50">
                    <span className="text-xs text-zinc-500">Clip: </span>
                    <span className="text-sm font-mono text-blue-400">
                      {Math.max(0, (parseFloat(genEnd) || 0) - (parseFloat(genStart) || 0)).toFixed(1)}s
                    </span>
                  </div>

                  {/* Quick presets */}
                  <div className="flex gap-2 flex-wrap">
                    {[15, 30, 60, 90].filter((d) => d <= duration).map((d) => (
                      <button key={d}
                        onClick={() => { setGenStart('0'); setGenEnd(String(d)); }}
                        className="px-2.5 py-1 rounded-md text-xs bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 transition-colors"
                      >First {d < 60 ? `${d}s` : `${d / 60}m`}</button>
                    ))}
                  </div>

                  {/* Optional text overlay */}
                  <div className="border-t border-zinc-800 pt-3">
                    <label className="text-xs text-zinc-400 block mb-1">Text Overlay <span className="text-zinc-600">(optional)</span></label>
                    <input type="text" value={genText} onChange={(e) => setGenText(e.target.value)}
                      placeholder="Add text to the clip..."
                      className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500" />
                  </div>
                  {genText && (
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="text-xs text-zinc-400 block mb-1">Size</label>
                        <input type="number" min={12} max={200} value={genFontSize} onChange={(e) => setGenFontSize(e.target.value)}
                          className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-blue-500" />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-400 block mb-1">Color</label>
                        <select value={genFontColor} onChange={(e) => setGenFontColor(e.target.value)}
                          className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500">
                          {FONT_COLORS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-zinc-400 block mb-1">Position</label>
                        <select value={genPosition} onChange={(e) => setGenPosition(e.target.value)}
                          className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500">
                          <option value="top">Top</option>
                          <option value="center">Center</option>
                          <option value="bottom">Bottom</option>
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ---- SPLIT ---- */}
              {tab === 'split' && (
                <div className="space-y-3">
                  <p className="text-xs text-zinc-400">Split video at timestamps. Downloads all parts as a zip.</p>
                  <div className="space-y-1">
                    <div className="relative h-6 bg-zinc-800 rounded-lg overflow-hidden">
                      {splitPoints.map((p, i) => {
                        const sec = parseFloat(p);
                        if (isNaN(sec) || sec <= 0 || duration <= 0) return null;
                        return (
                          <div key={i} className="absolute top-0 bottom-0 w-0.5 bg-violet-500"
                            style={{ left: `${(sec / duration) * 100}%` }}>
                            <div className="absolute -top-0.5 -left-1.5 w-3 h-2 bg-violet-500 rounded-sm" />
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex justify-between text-[10px] text-zinc-600 font-mono">
                      <span>0:00</span><span>{formatTime(duration)}</span>
                    </div>
                  </div>
                  <div className="space-y-2 max-h-[100px] overflow-y-auto">
                    {splitPoints.map((p, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-[10px] text-zinc-500 w-5">#{i + 1}</span>
                        <input type="number" min={0} max={duration} step={0.1} value={p}
                          onChange={(e) => updateSplitPoint(i, e.target.value)} placeholder="sec"
                          className="flex-1 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-violet-500" />
                        <button onClick={() => { const t = videoRef.current?.currentTime; if (t !== undefined) updateSplitPoint(i, t.toFixed(2)); }}
                          className="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-[10px] text-zinc-400 hover:text-white hover:border-zinc-500">
                          <Play className="w-3 h-3" />
                        </button>
                        {splitPoints.length > 1 && (
                          <button onClick={() => removeSplitPoint(i)} className="p-1 text-zinc-500 hover:text-red-400">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button onClick={addSplitPoint} className="flex items-center gap-1.5 text-xs text-violet-400 hover:text-violet-300">
                    <Plus className="w-3.5 h-3.5" /> Add split point
                  </button>
                  <div className="px-3 py-2 bg-zinc-800/40 rounded-lg border border-zinc-700/50">
                    <span className="text-xs text-zinc-500">Output: </span>
                    <span className="text-sm font-mono text-violet-400">
                      {splitPoints.filter((p) => parseFloat(p) > 0).length + 1} parts
                    </span>
                  </div>
                </div>
              )}

              {/* ---- ISOLATE VOCAL ---- */}
              {tab === 'isolate_vocal' && (
                <div className="space-y-4">
                  <p className="text-xs text-zinc-400">Extract the vocal track from your video's audio using frequency-based center-channel separation.</p>
                  {audioSeparated ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 px-3 py-2 bg-purple-900/20 border border-purple-800/30 rounded-lg">
                        <Check className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                        <p className="text-[11px] text-purple-300">Audio has already been separated. You can download the vocal track below.</p>
                      </div>
                      <audio controls className="w-full rounded-lg" src={vocalsUrl}>
                        Your browser does not support the audio element.
                      </audio>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 px-3 py-2 bg-zinc-800/40 border border-zinc-700/50 rounded-lg">
                      <Mic className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                      <p className="text-[11px] text-zinc-400">Click "Isolate Vocal" to process. This will extract and download <span className="text-purple-300">vocals.wav</span>.</p>
                    </div>
                  )}
                </div>
              )}

              {/* ---- ISOLATE BGM ---- */}
              {tab === 'isolate_bgm' && (
                <div className="space-y-4">
                  <p className="text-xs text-zinc-400">Extract the background music/instrumental track from your video's audio using vocal-zone rejection.</p>
                  {audioSeparated ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 px-3 py-2 bg-pink-900/20 border border-pink-800/30 rounded-lg">
                        <Check className="w-3.5 h-3.5 text-pink-400 shrink-0" />
                        <p className="text-[11px] text-pink-300">Audio has already been separated. You can download the BGM track below.</p>
                      </div>
                      <audio controls className="w-full rounded-lg" src={bgmUrl}>
                        Your browser does not support the audio element.
                      </audio>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 px-3 py-2 bg-zinc-800/40 border border-zinc-700/50 rounded-lg">
                      <Music className="w-3.5 h-3.5 text-pink-400 shrink-0" />
                      <p className="text-[11px] text-zinc-400">Click "Isolate BGM" to process. This will extract and download <span className="text-pink-300">bgm.wav</span>.</p>
                    </div>
                  )}
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="flex items-center gap-2 px-3 py-2 bg-red-900/20 border border-red-800/30 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  <p className="text-xs text-red-300">{error}</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-zinc-800 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors">
            Cancel
          </button>
          {hasVideo && (
            <button
              onClick={actionMap[tab]}
              disabled={processing}
              className={`flex items-center gap-2 px-4 py-2 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${tabColors[tab]}`}
            >
              {processing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : done ? (
                <Check className="w-4 h-4" />
              ) : isInPlace ? (
                <RefreshCw className="w-4 h-4" />
              ) : tab === 'isolate_vocal' ? (
                audioSeparated ? <Download className="w-4 h-4" /> : <Mic className="w-4 h-4" />
              ) : tab === 'isolate_bgm' ? (
                audioSeparated ? <Download className="w-4 h-4" /> : <Music className="w-4 h-4" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              {done ? (tab === 'isolate_vocal' || tab === 'isolate_bgm' ? 'Downloaded!' : 'Applied!') : processing ? 'Processing...' : actionLabels[tab]}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
