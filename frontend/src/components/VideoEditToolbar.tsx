import { useState, useRef, RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjectStore } from '../stores/projectStore';
import {
  createProject,
  flipVideo, resizeVideo, changeVideoSpeed,
  burnSubtitles, separateProjectAudio, uploadVideo,
  cutVideo, generateSelectedVideo, splitClipAtPlayhead,
} from '../api/client';
import {
  Loader2,
  Check,
  AlertCircle,
  FlipHorizontal2,
  FlipVertical2,
  Maximize2,
  Gauge,
  SplitSquareVertical,
  Type,
  Film,
  RefreshCw,
  Scissors,
  Upload,
  Download,
  Music,
  X,
} from 'lucide-react';

type Tool = 'upload' | 'cut' | 'flip' | 'resize' | 'speed' | 'subtitle' | 'split' | 'generate' | 'separate' | null;

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  onOpenExport: () => void;
  audioSeparated: boolean;
  onAudioSeparated: (vocalsUrl: string, bgmUrl: string) => void;
}

const RESIZE_PRESETS = [
  { label: '1080p', w: 1920, h: 1080 },
  { label: '720p', w: 1280, h: 720 },
  { label: '480p', w: 854, h: 480 },
  { label: '9:16', w: 1080, h: 1920 },
  { label: 'Square', w: 1080, h: 1080 },
];

const FONT_COLORS = [
  { label: 'White', value: 'white' },
  { label: 'Yellow', value: 'yellow' },
  { label: 'Red', value: 'red' },
  { label: 'Green', value: 'green' },
  { label: 'Cyan', value: 'cyan' },
];

const TOOLS: { key: Tool; label: string; icon: React.ReactNode; color: string }[] = [
  { key: 'upload', label: 'Upload', icon: <Upload className="w-4 h-4" />, color: 'text-blue-400' },
  { key: 'cut', label: 'Cut', icon: <Scissors className="w-4 h-4" />, color: 'text-orange-400' },
  { key: 'flip', label: 'Flip', icon: <FlipHorizontal2 className="w-4 h-4" />, color: 'text-cyan-400' },
  { key: 'resize', label: 'Resize', icon: <Maximize2 className="w-4 h-4" />, color: 'text-emerald-400' },
  { key: 'speed', label: 'Speed', icon: <Gauge className="w-4 h-4" />, color: 'text-amber-400' },
  { key: 'subtitle', label: 'Subtitle', icon: <Type className="w-4 h-4" />, color: 'text-rose-400' },
  { key: 'split', label: 'Split', icon: <SplitSquareVertical className="w-4 h-4" />, color: 'text-violet-400' },
  { key: 'generate', label: 'Clip', icon: <Film className="w-4 h-4" />, color: 'text-blue-400' },
  { key: 'separate', label: 'Audio', icon: <Music className="w-4 h-4" />, color: 'text-purple-400' },
];

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export default function VideoEditToolbar({
  videoRef,
  onOpenExport,
  audioSeparated,
  onAudioSeparated,
}: Props) {
  const navigate = useNavigate();
  const { currentProject, loadProject, setVideoClips } = useProjectStore();
  const hasVideo = !!currentProject?.video_path;
  const duration = currentProject?.duration || 0;

  const [activeTool, setActiveTool] = useState<Tool>(null);
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [processing, setProcessing] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [separating, setSeparating] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Flip state
  const [flipDir, setFlipDir] = useState<'horizontal' | 'vertical'>('horizontal');

  // Resize state
  const [resizeW, setResizeW] = useState('1920');
  const [resizeH, setResizeH] = useState('1080');

  // Speed state
  const [speed, setSpeed] = useState('1.0');

  // Subtitle state
  const [fontSize, setFontSize] = useState('28');
  const [fontColor, setFontColor] = useState('white');
  const [textPosition, setTextPosition] = useState('bottom');
  const [bgOpacity, setBgOpacity] = useState('0.5');

  // Cut state
  const [cutStart, setCutStart] = useState('0');
  const [cutEnd, setCutEnd] = useState('');

  // Clip/Generate state
  const [clipStart, setClipStart] = useState('0');
  const [clipEnd, setClipEnd] = useState('');
  const [clipText, setClipText] = useState('');
  const [clipFontSize, setClipFontSize] = useState('48');
  const [clipFontColor, setClipFontColor] = useState('white');
  const [clipPosition, setClipPosition] = useState('bottom');

  const resetState = () => { setDone(false); setError(''); };

  const reloadProject = async () => {
    if (currentProject) {
      await loadProject(currentProject.id);
      if (videoRef.current) videoRef.current.load();
    }
  };

  const toggleTool = (tool: Tool) => {
    resetState();
    setActiveTool(activeTool === tool ? null : tool);
  };

  // Upload
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProject) return;
    if (fileInputRef.current) fileInputRef.current.value = '';

    // If project already has a video, prompt to create a new project
    if (hasVideo) {
      setPendingFile(file);
      setShowNewProjectDialog(true);
      return;
    }

    // First upload to current project (no video yet)
    await doUploadToCurrent(file);
  };

  const doUploadToCurrent = async (file: File) => {
    if (!currentProject) return;
    setUploadProgress(0);
    setProcessing(true);
    try {
      await uploadVideo(currentProject.id, file, (pct) => setUploadProgress(pct));
      await reloadProject();
      setUploadProgress(0);
    } catch (err: any) {
      setError(err?.message || 'Upload failed');
    }
    setProcessing(false);
  };

  const handleNewProject = async () => {
    if (!pendingFile) return;
    setShowNewProjectDialog(false);
    setUploadProgress(0);
    setProcessing(true);
    try {
      const name = pendingFile.name.replace(/\.[^/.]+$/, '');
      const project = await createProject(name);
      await uploadVideo(project.id, pendingFile, (pct) => setUploadProgress(pct));
      setUploadProgress(0);
      setPendingFile(null);
      navigate(`/project/${project.id}`);
    } catch (err: any) {
      setError(err?.message || 'Failed to create new project');
    }
    setProcessing(false);
  };

  const handleReplaceVideo = async () => {
    setShowNewProjectDialog(false);
    if (pendingFile) {
      await doUploadToCurrent(pendingFile);
      setPendingFile(null);
    }
  };

  // Separate Audio
  const handleSeparate = async () => {
    if (!currentProject || separating || audioSeparated) return;
    setSeparating(true); resetState();
    try {
      const result = await separateProjectAudio(currentProject.id);
      onAudioSeparated(result.vocals_url, result.bgm_url);
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || 'Audio separation failed');
    }
    setSeparating(false);
  };

  // Flip
  const handleFlip = async () => {
    if (!currentProject) return;
    setProcessing(true); resetState();
    try {
      await flipVideo(currentProject.id, flipDir);
      await reloadProject();
      setDone(true); setTimeout(() => setDone(false), 2000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Flip failed');
    }
    setProcessing(false);
  };

  // Resize
  const handleResize = async () => {
    if (!currentProject) return;
    setProcessing(true); resetState();
    try {
      await resizeVideo(currentProject.id, parseInt(resizeW) || 1920, parseInt(resizeH) || 1080);
      await reloadProject();
      setDone(true); setTimeout(() => setDone(false), 2000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Resize failed');
    }
    setProcessing(false);
  };

  // Speed
  const handleSpeed = async () => {
    if (!currentProject) return;
    setProcessing(true); resetState();
    try {
      await changeVideoSpeed(currentProject.id, parseFloat(speed) || 1.0);
      await reloadProject();
      setDone(true); setTimeout(() => setDone(false), 2000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Speed change failed');
    }
    setProcessing(false);
  };

  // Burn Subtitles
  const handleSubtitle = async () => {
    if (!currentProject) return;
    const segments = currentProject.segments || [];
    if (segments.length === 0) { setError('No subtitle segments. Transcribe first.'); return; }
    setProcessing(true); resetState();
    try {
      await burnSubtitles(
        currentProject.id,
        parseInt(fontSize) || 28, fontColor, textPosition, parseFloat(bgOpacity) || 0.5,
      );
      await reloadProject();
      setDone(true); setTimeout(() => setDone(false), 2000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Burn subtitles failed');
    }
    setProcessing(false);
  };

  // Split (non-destructive, splits clip at playhead on timeline)
  const handleSplit = async () => {
    if (!currentProject) return;
    const time = videoRef.current?.currentTime;
    if (time === undefined || time <= 0) { setError('Move the playhead to where you want to split'); return; }
    setProcessing(true); resetState();
    try {
      const clips = await splitClipAtPlayhead(currentProject.id, time);
      setVideoClips(clips);
      setDone(true); setTimeout(() => setDone(false), 2000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Split failed');
    }
    setProcessing(false);
  };

  // Cut (in-place)
  const handleCut = async () => {
    if (!currentProject) return;
    const s = parseFloat(cutStart) || 0;
    const e2 = parseFloat(cutEnd) || 0;
    if (e2 <= s) { setError('End time must be greater than start time'); return; }
    setProcessing(true); resetState();
    try {
      await cutVideo(currentProject.id, s, e2);
      await reloadProject();
      setDone(true); setTimeout(() => setDone(false), 2000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Cut failed');
    }
    setProcessing(false);
  };

  // Clip/Generate (in-place)
  const handleClip = async () => {
    if (!currentProject) return;
    const s = parseFloat(clipStart) || 0;
    const e2 = parseFloat(clipEnd) || 0;
    if (e2 <= s) { setError('End time must be greater than start time'); return; }
    setProcessing(true); resetState();
    try {
      await generateSelectedVideo(
        currentProject.id, s, e2,
        clipText || undefined,
        parseInt(clipFontSize) || 48,
        clipFontColor, clipPosition, 0.5,
      );
      await reloadProject();
      setDone(true); setTimeout(() => setDone(false), 2000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Generate failed');
    }
    setProcessing(false);
  };

  return (
    <div className="flex flex-col bg-zinc-900/50">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        onChange={handleUpload}
        className="hidden"
      />

      {/* CapCut-style toolbar strip */}
      <div className="border-b border-zinc-800/80">
        <div className="flex items-center overflow-x-auto scrollbar-none px-1 py-1.5 gap-0.5">
          {TOOLS.map((tool) => {
            const isActive = activeTool === tool.key;
            const isDisabled = tool.key !== 'upload' && !hasVideo;
            return (
              <button
                key={tool.key}
                onClick={() => {
                  if (tool.key === 'upload') {
                    fileInputRef.current?.click();
                    return;
                  }
                  if (tool.key === 'separate') {
                    handleSeparate();
                    return;
                  }
                  if (!isDisabled) toggleTool(tool.key);
                }}
                disabled={isDisabled && tool.key !== 'upload'}
                className={`flex flex-col items-center justify-center min-w-[52px] px-1.5 py-1.5 rounded-lg transition-all shrink-0
                  ${isActive
                    ? 'bg-zinc-700/80 ring-1 ring-zinc-600'
                    : 'hover:bg-zinc-800/60'
                  }
                  ${isDisabled && tool.key !== 'upload' ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'}
                `}
              >
                <span className={`${isActive ? tool.color : 'text-zinc-400'} transition-colors`}>
                  {tool.key === 'separate' && separating ? (
                    <Loader2 className="w-4 h-4 animate-spin text-purple-400" />
                  ) : tool.key === 'separate' && audioSeparated ? (
                    <Check className="w-4 h-4 text-green-400" />
                  ) : (
                    tool.icon
                  )}
                </span>
                <span className={`text-[9px] mt-0.5 leading-tight ${isActive ? 'text-white' : 'text-zinc-500'}`}>
                  {tool.key === 'separate' && separating
                    ? 'Wait...'
                    : tool.key === 'separate' && audioSeparated
                    ? 'Done ✓'
                    : tool.label}
                </span>
              </button>
            );
          })}

          {/* Export button - special styling */}
          <button
            onClick={onOpenExport}
            disabled={!hasVideo && !(currentProject?.segments?.length)}
            className="flex flex-col items-center justify-center min-w-[52px] px-1.5 py-1.5 rounded-lg hover:bg-zinc-800/60 transition-all shrink-0 disabled:opacity-30"
          >
            <Download className="w-4 h-4 text-green-400" />
            <span className="text-[9px] mt-0.5 text-zinc-500 leading-tight">Export</span>
          </button>
        </div>

        {/* Upload progress bar */}
        {uploadProgress > 0 && uploadProgress < 100 && (
          <div className="px-2 pb-1.5">
            <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${uploadProgress}%` }} />
            </div>
            <p className="text-[9px] text-zinc-500 mt-0.5 text-center">{uploadProgress}%</p>
          </div>
        )}
      </div>

      {/* Expandable inline panel */}
      {activeTool && hasVideo && (
        <div className="border-b border-zinc-800/80 bg-zinc-900/80 animate-in slide-in-from-top-1 duration-150">
          {/* Panel header */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800/50">
            <span className="text-[11px] font-medium text-zinc-300">
              {TOOLS.find((t) => t.key === activeTool)?.label}
            </span>
            <button onClick={() => setActiveTool(null)} className="p-0.5 hover:bg-zinc-800 rounded">
              <X className="w-3 h-3 text-zinc-500" />
            </button>
          </div>

          <div className="px-3 py-2.5 space-y-2.5 max-h-[260px] overflow-y-auto">
            {/* FLIP */}
            {activeTool === 'flip' && (
              <>
                <div className="flex gap-2">
                  <button
                    onClick={() => setFlipDir('horizontal')}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border text-xs transition-all ${
                      flipDir === 'horizontal'
                        ? 'bg-cyan-900/30 border-cyan-600 text-cyan-300'
                        : 'bg-zinc-800/60 border-zinc-700 text-zinc-400 hover:border-zinc-500'
                    }`}
                  >
                    <FlipHorizontal2 className="w-4 h-4" /> Horizontal
                  </button>
                  <button
                    onClick={() => setFlipDir('vertical')}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border text-xs transition-all ${
                      flipDir === 'vertical'
                        ? 'bg-cyan-900/30 border-cyan-600 text-cyan-300'
                        : 'bg-zinc-800/60 border-zinc-700 text-zinc-400 hover:border-zinc-500'
                    }`}
                  >
                    <FlipVertical2 className="w-4 h-4" /> Vertical
                  </button>
                </div>
                <button onClick={handleFlip} disabled={processing}
                  className="w-full py-1.5 rounded-lg text-xs font-medium bg-cyan-700 hover:bg-cyan-600 text-white disabled:opacity-50 flex items-center justify-center gap-1.5 transition-colors">
                  {processing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : done ? <Check className="w-3.5 h-3.5" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  {done ? 'Applied!' : processing ? 'Processing...' : 'Apply Flip'}
                </button>
              </>
            )}

            {/* RESIZE */}
            {activeTool === 'resize' && (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {RESIZE_PRESETS.map((p) => (
                    <button key={p.label}
                      onClick={() => { setResizeW(String(p.w)); setResizeH(String(p.h)); }}
                      className={`px-2.5 py-1 rounded-md text-[10px] border transition-colors ${
                        resizeW === String(p.w) && resizeH === String(p.h)
                          ? 'bg-emerald-900/30 border-emerald-600 text-emerald-300'
                          : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-500'
                      }`}
                    >{p.label}</button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-zinc-500 mb-0.5 block">Width</label>
                    <input type="number" min={100} max={7680} value={resizeW}
                      onChange={(e) => setResizeW(e.target.value)}
                      className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-white font-mono focus:outline-none focus:border-emerald-500" />
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-500 mb-0.5 block">Height</label>
                    <input type="number" min={100} max={4320} value={resizeH}
                      onChange={(e) => setResizeH(e.target.value)}
                      className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-white font-mono focus:outline-none focus:border-emerald-500" />
                  </div>
                </div>
                <button onClick={handleResize} disabled={processing}
                  className="w-full py-1.5 rounded-lg text-xs font-medium bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-50 flex items-center justify-center gap-1.5 transition-colors">
                  {processing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : done ? <Check className="w-3.5 h-3.5" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  {done ? 'Applied!' : processing ? 'Processing...' : 'Apply Resize'}
                </button>
              </>
            )}

            {/* SPEED */}
            {activeTool === 'speed' && (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {[0.5, 0.75, 1.0, 1.05, 1.25, 1.5, 2.0].map((s) => (
                    <button key={s}
                      onClick={() => setSpeed(String(s))}
                      className={`px-2.5 py-1 rounded-md text-[10px] border transition-colors ${
                        speed === String(s)
                          ? 'bg-amber-900/30 border-amber-600 text-amber-300'
                          : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-500'
                      }`}
                    >{s}x</button>
                  ))}
                </div>
                <input type="number" min={0.25} max={4.0} step={0.05} value={speed}
                  onChange={(e) => setSpeed(e.target.value)}
                  className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-white font-mono focus:outline-none focus:border-amber-500" />
                <div className="flex items-center justify-between px-2 py-1 bg-zinc-800/40 rounded-lg text-[10px]">
                  <span className="text-zinc-500">New duration</span>
                  <span className="font-mono text-amber-400">{formatTime(duration / (parseFloat(speed) || 1))}</span>
                </div>
                <button onClick={handleSpeed} disabled={processing}
                  className="w-full py-1.5 rounded-lg text-xs font-medium bg-amber-700 hover:bg-amber-600 text-white disabled:opacity-50 flex items-center justify-center gap-1.5 transition-colors">
                  {processing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : done ? <Check className="w-3.5 h-3.5" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  {done ? 'Applied!' : processing ? 'Processing...' : 'Apply Speed'}
                </button>
              </>
            )}

            {/* SUBTITLE */}
            {activeTool === 'subtitle' && (
              <>
                <div className="flex items-center justify-between px-2 py-1 bg-zinc-800/60 rounded-lg">
                  <span className="text-[10px] text-zinc-500">Segments</span>
                  <span className="text-xs font-mono text-rose-400">{currentProject?.segments?.length || 0}</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="text-[10px] text-zinc-500 mb-0.5 block">Size</label>
                    <input type="number" min={12} max={200} value={fontSize}
                      onChange={(e) => setFontSize(e.target.value)}
                      className="w-full px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-[11px] text-white font-mono focus:outline-none focus:border-rose-500" />
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-500 mb-0.5 block">Color</label>
                    <select value={fontColor} onChange={(e) => setFontColor(e.target.value)}
                      className="w-full px-1.5 py-1 bg-zinc-800 border border-zinc-700 rounded text-[11px] text-white focus:outline-none focus:border-rose-500">
                      {FONT_COLORS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-500 mb-0.5 block">Position</label>
                    <select value={textPosition} onChange={(e) => setTextPosition(e.target.value)}
                      className="w-full px-1.5 py-1 bg-zinc-800 border border-zinc-700 rounded text-[11px] text-white focus:outline-none focus:border-rose-500">
                      <option value="top">Top</option>
                      <option value="center">Center</option>
                      <option value="bottom">Bottom</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-zinc-500 mb-0.5 block">BG Opacity: {bgOpacity}</label>
                  <input type="range" min={0} max={1} step={0.1} value={bgOpacity}
                    onChange={(e) => setBgOpacity(e.target.value)}
                    className="w-full h-1 accent-rose-500" />
                </div>
                <button onClick={handleSubtitle} disabled={processing || !(currentProject?.segments?.length)}
                  className="w-full py-1.5 rounded-lg text-xs font-medium bg-rose-700 hover:bg-rose-600 text-white disabled:opacity-50 flex items-center justify-center gap-1.5 transition-colors">
                  {processing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : done ? <Check className="w-3.5 h-3.5" /> : <Type className="w-3.5 h-3.5" />}
                  {done ? 'Burned!' : processing ? 'Burning...' : 'Burn Subtitles'}
                </button>
              </>
            )}

            {/* SPLIT */}
            {activeTool === 'split' && (
              <>
                <p className="text-[10px] text-zinc-500">
                  Move the video playhead to where you want to split, then click the button.
                  The video will be split into clips visible on the timeline.
                </p>
                {/* Current playhead position */}
                <div className="flex items-center justify-between px-2 py-1.5 bg-zinc-800/60 rounded-lg">
                  <span className="text-[10px] text-zinc-500">Playhead position</span>
                  <span className="font-mono text-xs text-violet-400">
                    {formatTime(videoRef.current?.currentTime || 0)}
                  </span>
                </div>
                {/* Mini timeline showing playhead */}
                {duration > 0 && (
                  <div className="relative h-4 bg-zinc-800 rounded overflow-hidden">
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-violet-500"
                      style={{ left: `${((videoRef.current?.currentTime || 0) / duration) * 100}%` }}
                    />
                  </div>
                )}
                <button onClick={handleSplit} disabled={processing}
                  className="w-full py-1.5 rounded-lg text-xs font-medium bg-violet-700 hover:bg-violet-600 text-white disabled:opacity-50 flex items-center justify-center gap-1.5 transition-colors">
                  {processing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : done ? <Check className="w-3.5 h-3.5" /> : <SplitSquareVertical className="w-3.5 h-3.5" />}
                  {done ? 'Split!' : processing ? 'Splitting...' : 'Split at Playhead'}
                </button>
              </>
            )}

            {/* CUT */}
            {activeTool === 'cut' && (
              <>
                <p className="text-[10px] text-zinc-500">Trim video to selected range. Replaces your project video.</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-zinc-500 mb-0.5 block">Start (s)</label>
                    <div className="flex gap-1">
                      <input type="number" min={0} max={duration} step={0.1} value={cutStart}
                        onChange={(e) => setCutStart(e.target.value)}
                        className="flex-1 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-white font-mono focus:outline-none focus:border-orange-500" />
                      <button onClick={() => { const t = videoRef.current?.currentTime; if (t !== undefined) setCutStart(t.toFixed(2)); }}
                        className="px-1.5 py-1 bg-zinc-800 border border-zinc-700 rounded text-[9px] text-zinc-400 hover:text-white">Set</button>
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-500 mb-0.5 block">End (s)</label>
                    <div className="flex gap-1">
                      <input type="number" min={0} max={duration} step={0.1} value={cutEnd}
                        onChange={(e) => setCutEnd(e.target.value)}
                        className="flex-1 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-white font-mono focus:outline-none focus:border-orange-500" />
                      <button onClick={() => { const t = videoRef.current?.currentTime; if (t !== undefined) setCutEnd(t.toFixed(2)); }}
                        className="px-1.5 py-1 bg-zinc-800 border border-zinc-700 rounded text-[9px] text-zinc-400 hover:text-white">Set</button>
                    </div>
                  </div>
                </div>
                {duration > 0 && (
                  <div className="relative h-4 bg-zinc-800 rounded overflow-hidden">
                    <div className="absolute top-0 bottom-0 bg-orange-600/30 border-l border-r border-orange-500"
                      style={{
                        left: `${((parseFloat(cutStart) || 0) / duration) * 100}%`,
                        width: `${(Math.max(0, (parseFloat(cutEnd) || 0) - (parseFloat(cutStart) || 0)) / duration) * 100}%`,
                      }} />
                  </div>
                )}
                <div className="flex items-center justify-between px-2 py-1 bg-zinc-800/40 rounded-lg text-[10px]">
                  <span className="text-zinc-500">New duration</span>
                  <span className="font-mono text-orange-400">{formatTime(Math.max(0, (parseFloat(cutEnd) || 0) - (parseFloat(cutStart) || 0)))}</span>
                </div>
                <button onClick={handleCut} disabled={processing}
                  className="w-full py-1.5 rounded-lg text-xs font-medium bg-orange-700 hover:bg-orange-600 text-white disabled:opacity-50 flex items-center justify-center gap-1.5 transition-colors">
                  {processing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : done ? <Check className="w-3.5 h-3.5" /> : <Scissors className="w-3.5 h-3.5" />}
                  {done ? 'Applied!' : processing ? 'Cutting...' : 'Apply Cut'}
                </button>
              </>
            )}

            {/* CLIP / GENERATE */}
            {activeTool === 'generate' && (
              <>
                <p className="text-[10px] text-zinc-500">Extract a clip with optional text overlay. Replaces your project video.</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-zinc-500 mb-0.5 block">Start (s)</label>
                    <div className="flex gap-1">
                      <input type="number" min={0} max={duration} step={0.1} value={clipStart}
                        onChange={(e) => setClipStart(e.target.value)}
                        className="flex-1 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-white font-mono focus:outline-none focus:border-blue-500" />
                      <button onClick={() => { const t = videoRef.current?.currentTime; if (t !== undefined) setClipStart(t.toFixed(2)); }}
                        className="px-1.5 py-1 bg-zinc-800 border border-zinc-700 rounded text-[9px] text-zinc-400 hover:text-white">Set</button>
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-500 mb-0.5 block">End (s)</label>
                    <div className="flex gap-1">
                      <input type="number" min={0} max={duration} step={0.1} value={clipEnd}
                        onChange={(e) => setClipEnd(e.target.value)}
                        className="flex-1 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-white font-mono focus:outline-none focus:border-blue-500" />
                      <button onClick={() => { const t = videoRef.current?.currentTime; if (t !== undefined) setClipEnd(t.toFixed(2)); }}
                        className="px-1.5 py-1 bg-zinc-800 border border-zinc-700 rounded text-[9px] text-zinc-400 hover:text-white">Set</button>
                    </div>
                  </div>
                </div>
                {duration > 0 && (
                  <div className="relative h-4 bg-zinc-800 rounded overflow-hidden">
                    <div className="absolute top-0 bottom-0 bg-blue-600/30 border-l border-r border-blue-500"
                      style={{
                        left: `${((parseFloat(clipStart) || 0) / duration) * 100}%`,
                        width: `${(Math.max(0, (parseFloat(clipEnd) || 0) - (parseFloat(clipStart) || 0)) / duration) * 100}%`,
                      }} />
                  </div>
                )}
                <div>
                  <label className="text-[10px] text-zinc-500 mb-0.5 block">Text Overlay <span className="text-zinc-600">(optional)</span></label>
                  <input type="text" value={clipText} onChange={(e) => setClipText(e.target.value)}
                    placeholder="Add text..."
                    className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-white focus:outline-none focus:border-blue-500" />
                </div>
                {clipText && (
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-[10px] text-zinc-500 mb-0.5 block">Size</label>
                      <input type="number" min={12} max={200} value={clipFontSize}
                        onChange={(e) => setClipFontSize(e.target.value)}
                        className="w-full px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-[11px] text-white font-mono focus:outline-none focus:border-blue-500" />
                    </div>
                    <div>
                      <label className="text-[10px] text-zinc-500 mb-0.5 block">Color</label>
                      <select value={clipFontColor} onChange={(e) => setClipFontColor(e.target.value)}
                        className="w-full px-1.5 py-1 bg-zinc-800 border border-zinc-700 rounded text-[11px] text-white focus:outline-none focus:border-blue-500">
                        {FONT_COLORS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-zinc-500 mb-0.5 block">Position</label>
                      <select value={clipPosition} onChange={(e) => setClipPosition(e.target.value)}
                        className="w-full px-1.5 py-1 bg-zinc-800 border border-zinc-700 rounded text-[11px] text-white focus:outline-none focus:border-blue-500">
                        <option value="top">Top</option>
                        <option value="center">Center</option>
                        <option value="bottom">Bottom</option>
                      </select>
                    </div>
                  </div>
                )}
                <button onClick={handleClip} disabled={processing}
                  className="w-full py-1.5 rounded-lg text-xs font-medium bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50 flex items-center justify-center gap-1.5 transition-colors">
                  {processing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : done ? <Check className="w-3.5 h-3.5" /> : <Film className="w-3.5 h-3.5" />}
                  {done ? 'Applied!' : processing ? 'Generating...' : 'Apply Clip'}
                </button>
              </>
            )}

            {/* Error */}
            {error && (
              <div className="flex items-center gap-1.5 px-2 py-1.5 bg-red-900/20 border border-red-800/30 rounded-lg">
                <AlertCircle className="w-3 h-3 text-red-400 shrink-0" />
                <p className="text-[10px] text-red-300 leading-tight">{error}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* New Project Dialog */}
      {showNewProjectDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[360px] p-5">
            <h3 className="text-sm font-semibold text-white mb-2">Upload New Video</h3>
            <p className="text-xs text-zinc-400 mb-4">
              This project already has a video. Would you like to create a new project for this video, or replace the current video?
            </p>
            {pendingFile && (
              <div className="flex items-center gap-2 px-3 py-2 bg-zinc-800 rounded-lg mb-4">
                <Upload className="w-4 h-4 text-blue-400 shrink-0" />
                <span className="text-xs text-zinc-300 truncate">{pendingFile.name}</span>
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => { setShowNewProjectDialog(false); setPendingFile(null); }}
                className="flex-1 py-2 rounded-lg text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleReplaceVideo}
                className="flex-1 py-2 rounded-lg text-xs font-medium bg-zinc-700 hover:bg-zinc-600 text-white transition-colors"
              >
                Replace Video
              </button>
              <button
                onClick={handleNewProject}
                className="flex-1 py-2 rounded-lg text-xs font-medium bg-khmer-600 hover:bg-khmer-700 text-white transition-colors"
              >
                New Project
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
