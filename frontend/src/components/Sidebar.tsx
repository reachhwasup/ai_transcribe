import { useRef, useState } from 'react';
import { useProjectStore } from '../stores/projectStore';
import {
  separateProjectAudio,
  muteProjectAudio,
  clearAllSegments,
  importSrtFile,
  getExportUrl,
} from '../api/client';
import {
  Upload,
  Wand2,
  MicOff,
  FileDown,
  FileUp,
  Film,
  Trash2,
  Loader2,
  Check,
} from 'lucide-react';

interface SidebarProps {
  onOpenExport?: () => void;
  audioSeparated?: boolean;
  onAudioSeparated?: (vocalsUrl: string, bgmUrl: string) => void;
}

export default function Sidebar({ onOpenExport, audioSeparated, onAudioSeparated }: SidebarProps) {
  const { currentProject, loadProject, uploadProgress, isTranscribing, uploadVideo } = useProjectStore();
  const videoInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);

  // Loading states
  const [isolating, setIsolating] = useState(false);
  const [muting, setMuting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');

  const hasVideo = !!currentProject?.video_path;
  const hasSegments = (currentProject?.segments?.length ?? 0) > 0;
  const hasAudio = currentProject?.segments?.some(s => s.audio_url) ?? false;
  const projectId = currentProject?.id || '';
  const projectName = currentProject?.name?.replace(/\s+/g, '_') || 'transcript';

  const step = !hasVideo ? 1 : !hasSegments ? 2 : !hasAudio ? 3 : 4;

  const reloadProject = async () => {
    if (currentProject) await loadProject(currentProject.id);
  };

  // Load Video — the store action drives the progress bar and error state
  const handleVideoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProject) return;
    if (videoInputRef.current) videoInputRef.current.value = '';
    await uploadVideo(file);
  };

  // Isolate BGM
  const handleIsolateBGM = async () => {
    if (!hasVideo || isolating) return;
    setIsolating(true); setError('');
    try {
      const result = await separateProjectAudio(projectId);
      onAudioSeparated?.(result.vocals_url, result.bgm_url);
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || 'Isolation failed');
    }
    setIsolating(false);
  };

  // Mute Audio
  const handleMuteAudio = async () => {
    if (!hasVideo || muting) return;
    if (!window.confirm('Remove audio from the video? This modifies your project video.')) return;
    setMuting(true); setError('');
    try {
      await muteProjectAudio(projectId);
      await reloadProject();
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || 'Mute failed');
    }
    setMuting(false);
  };

  // Export SRT
  const handleExportSRT = () => {
    if (!currentProject) return;
    const url = getExportUrl(projectId, 'srt');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectName}.srt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // Import SRT
  const handleSrtSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProject) return;
    if (srtInputRef.current) srtInputRef.current.value = '';
    setImporting(true); setError('');
    try {
      await importSrtFile(projectId, file);
      await reloadProject();
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || 'Import failed');
    }
    setImporting(false);
  };

  // Clear All Data
  const handleClearAll = async () => {
    if (!currentProject) return;
    if (!window.confirm('Delete all subtitle segments? This cannot be undone.')) return;
    setClearing(true); setError('');
    try {
      await clearAllSegments(projectId);
      await reloadProject();
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || 'Clear failed');
    }
    setClearing(false);
  };

  return (
    <>
      {/* Hidden file inputs */}
      <input ref={videoInputRef} type="file" accept="video/*" onChange={handleVideoSelect} className="hidden" />
      <input ref={srtInputRef} type="file" accept=".srt,.vtt" onChange={handleSrtSelect} className="hidden" />

      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-y-auto">
          {/* Upload progress */}
          {uploadProgress > 0 && uploadProgress < 100 && (
            <div className="px-3 pt-2">
              <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${uploadProgress}%` }} />
              </div>
              <p className="text-[9px] text-zinc-500 mt-0.5 text-right">{uploadProgress}%</p>
            </div>
          )}

          {/* Primary Action — contextual based on step */}
          <div className="px-3 pt-3 pb-2">
            {step === 1 && (
              <button
                onClick={() => videoInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors shadow-lg shadow-blue-600/20"
              >
                <Upload className="w-4.5 h-4.5" />
                Upload Video
              </button>
            )}
            {step === 2 && !isTranscribing && (
              <div className="space-y-2">
                <p className="text-[10px] text-zinc-500 px-0.5">
                  Video loaded! Click <strong className="text-zinc-300">Transcribe</strong> in the timeline toolbar below, or import subtitles:
                </p>
                <button
                  onClick={() => srtInputRef.current?.click()}
                  disabled={importing}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-orange-600/80 hover:bg-orange-500/80 text-white text-xs font-semibold transition-colors"
                >
                  {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileUp className="w-3.5 h-3.5" />}
                  {importing ? 'Importing...' : 'Import SRT / VTT'}
                </button>
              </div>
            )}
            {step === 3 && (
              <p className="text-[10px] text-zinc-500 px-0.5">
                {currentProject?.segments?.length} subtitles ready! Click <strong className="text-zinc-300">Generate Audio</strong> in the timeline toolbar to create AI voiceover.
              </p>
            )}
            {step === 4 && (
              <button
                onClick={onOpenExport}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white text-sm font-semibold transition-colors shadow-lg shadow-indigo-600/20"
              >
                <Film className="w-4.5 h-4.5" />
                Final Render
              </button>
            )}
          </div>

          <div className="h-px bg-zinc-800/60 mx-3" />

          {/* Quick Tools */}
          <div className="px-3 pt-3 pb-2 space-y-1.5">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-2">Quick Tools</p>

            {/* Upload / Replace Video */}
            {hasVideo && (
              <button
                onClick={() => videoInputRef.current?.click()}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-zinc-300 hover:bg-zinc-800/80 hover:text-white transition-colors text-left"
              >
                <Upload className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                <span>Replace Video</span>
              </button>
            )}

            {/* Import SRT */}
            {step > 1 && (
              <button
                onClick={() => srtInputRef.current?.click()}
                disabled={!hasVideo || importing}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-zinc-300 hover:bg-zinc-800/80 hover:text-white transition-colors text-left disabled:opacity-30"
              >
                <FileUp className="w-3.5 h-3.5 text-orange-400 shrink-0" />
                <span>{importing ? 'Importing...' : 'Import Subtitles (SRT)'}</span>
              </button>
            )}

            {/* Export SRT */}
            <button
              onClick={handleExportSRT}
              disabled={!hasSegments}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-zinc-300 hover:bg-zinc-800/80 hover:text-white transition-colors text-left disabled:opacity-30"
            >
              <FileDown className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>Export SRT</span>
            </button>

          </div>

          <div className="h-px bg-zinc-800/60 mx-3" />

          {/* Audio Tools */}
          <div className="px-3 pt-3 pb-2 space-y-1.5">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-2">Audio Tools</p>

            <button
              onClick={handleIsolateBGM}
              disabled={!hasVideo || isolating}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-zinc-300 hover:bg-zinc-800/80 hover:text-white transition-colors text-left disabled:opacity-30"
            >
              {isolating ? (
                <Loader2 className="w-3.5 h-3.5 text-pink-400 shrink-0 animate-spin" />
              ) : (
                <Wand2 className="w-3.5 h-3.5 text-pink-400 shrink-0" />
              )}
              <span>{audioSeparated ? 'Audio Isolated ✓' : isolating ? 'Isolating...' : 'Isolate Vocals / BGM'}</span>
              {audioSeparated && <Check className="w-3 h-3 text-emerald-400 ml-auto shrink-0" />}
            </button>

            <button
              onClick={handleMuteAudio}
              disabled={!hasVideo || muting}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-zinc-300 hover:bg-zinc-800/80 hover:text-white transition-colors text-left disabled:opacity-30"
            >
              {muting ? (
                <Loader2 className="w-3.5 h-3.5 text-teal-400 shrink-0 animate-spin" />
              ) : (
                <MicOff className="w-3.5 h-3.5 text-teal-400 shrink-0" />
              )}
              <span>{muting ? 'Muting...' : 'Mute Video Audio'}</span>
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="px-3 pb-2">
              <p className="text-[10px] text-red-400 px-1 leading-tight bg-red-900/20 border border-red-800/30 rounded-lg py-1.5 px-2">{error}</p>
            </div>
          )}

          {/* Danger Zone */}
          <div className="px-3 pb-3">
            <button
              onClick={handleClearAll}
              disabled={!currentProject || clearing || !hasSegments}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-zinc-800/50 hover:bg-red-900/30 border border-zinc-700/40 hover:border-red-700/50 text-zinc-500 hover:text-red-400 text-xs font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {clearing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              Clear All Subtitles
            </button>
          </div>
        </div>

      </div>
    </>
  );
}

