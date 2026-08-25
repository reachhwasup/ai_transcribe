import { useState, useRef, RefObject, useEffect, useMemo } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { appendVideoFileToTimeline, addVideoClip } from '../api/client';
import {
  Upload,
  Play,
  Pause,
  Film,
  Music,
  Plus,
  Trash2,
  FileVideo,
  Clock,
  Loader2,
  FolderOpen,
  Sparkles,
  Layers,
  CheckCircle2,
  Radio,
  Image as ImageIcon,
  HardDrive,
  Download,
  Filter,
  Volume2,
  Sliders,
  Scissors,
} from 'lucide-react';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  vocalsUrl: string | null;
  bgmUrl: string | null;
  audioSeparated: boolean;
}

type AssetFilter = 'all' | 'video' | 'audio' | 'clips';

export default function MediaPool({ videoRef, vocalsUrl, bgmUrl, audioSeparated }: Props) {
  const { currentProject, uploadVideo, setVideoClips, videoClips, currentTime, setCurrentTime } = useProjectStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const appendInputRef = useRef<HTMLInputElement>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isAppending, setIsAppending] = useState(false);
  const [activeFilter, setActiveFilter] = useState<AssetFilter>('all');
  const [playingAudioKey, setPlayingAudioKey] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);

  const hasVideo = !!currentProject?.video_path;

  // Capture video thumbnail
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hasVideo) {
      setThumbnailUrl(null);
      return;
    }

    const capture = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          setThumbnailUrl(canvas.toDataURL('image/jpeg', 0.8));
        }
      } catch {}
    };

    if (video.readyState >= 2) capture();
    else {
      video.addEventListener('loadeddata', capture, { once: true });
      return () => video.removeEventListener('loadeddata', capture);
    }
  }, [videoRef, hasVideo, currentProject?.video_path]);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2500);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProject) return;
    if (fileInputRef.current) fileInputRef.current.value = '';
    await uploadVideo(file);
    showToast('Video uploaded successfully');
  };

  const handleAppendFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProject) return;
    if (appendInputRef.current) appendInputRef.current.value = '';
    setIsAppending(true);
    try {
      const updated = await appendVideoFileToTimeline(currentProject.id, file);
      setVideoClips(updated);
      showToast('New clip added to timeline');
    } catch (err) {
      console.error('Failed to append video to timeline:', err);
    } finally {
      setIsAppending(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && currentProject) {
      if (hasVideo) {
        setIsAppending(true);
        try {
          const updated = await appendVideoFileToTimeline(currentProject.id, file);
          setVideoClips(updated);
          showToast('Clip added to timeline');
        } catch (err) {
          console.error('Failed to append video to timeline:', err);
        } finally {
          setIsAppending(false);
        }
      } else {
        await uploadVideo(file);
        showToast('Video uploaded successfully');
      }
    }
  };

  const formatDuration = (sec?: number) => {
    if (!sec) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const handleTogglePlayAudio = (key: string, url: string) => {
    if (playingAudioKey === key) {
      audioPreviewRef.current?.pause();
      audioPreviewRef.current = null;
      setPlayingAudioKey(null);
      return;
    }
    if (audioPreviewRef.current) {
      audioPreviewRef.current.pause();
      audioPreviewRef.current = null;
    }
    const audio = new Audio(url);
    audioPreviewRef.current = audio;
    setPlayingAudioKey(key);
    audio.onended = () => setPlayingAudioKey(null);
    audio.onerror = () => setPlayingAudioKey(null);
    audio.play().catch(() => setPlayingAudioKey(null));
  };

  return (
    <div className="flex flex-col h-full bg-[#111317] text-[#e1e3e6] select-none font-sans overflow-hidden relative">
      {/* Toast Notification */}
      {toastMsg && (
        <div className="absolute top-3 right-3 z-30 bg-teal-950/95 border border-teal-500/50 text-teal-200 px-3 py-1.5 rounded-xl shadow-xl text-xs flex items-center gap-1.5 animate-in fade-in slide-in-from-top-1">
          <CheckCircle2 className="w-3.5 h-3.5 text-teal-400" />
          <span>{toastMsg}</span>
        </div>
      )}

      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,audio/*,image/*"
        className="hidden"
        onChange={handleFileUpload}
      />
      <input
        ref={appendInputRef}
        type="file"
        accept="video/*,audio/*"
        className="hidden"
        onChange={handleAppendFile}
      />

      {/* Top Filter Chips & Asset Counter */}
      <div className="px-4 py-2.5 border-b border-[#1f222b] bg-[#14161d] flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1.5 bg-[#181a24] p-0.5 rounded-xl border border-[#242838]">
          <button
            onClick={() => setActiveFilter('all')}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
              activeFilter === 'all'
                ? 'bg-teal-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            All Media
          </button>
          <button
            onClick={() => setActiveFilter('video')}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all ${
              activeFilter === 'video'
                ? 'bg-teal-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Film className="w-3 h-3" />
            <span>Videos</span>
          </button>
          <button
            onClick={() => setActiveFilter('audio')}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all ${
              activeFilter === 'audio'
                ? 'bg-teal-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Music className="w-3 h-3" />
            <span>Audio Stems</span>
          </button>
          {videoClips.length > 0 && (
            <button
              onClick={() => setActiveFilter('clips')}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all ${
                activeFilter === 'clips'
                  ? 'bg-teal-600 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Scissors className="w-3 h-3" />
              <span>Clips ({videoClips.length})</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 text-[11px] text-zinc-400 font-mono">
          <span className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#1b1e28] border border-[#272c3d] text-teal-300">
            <HardDrive className="w-3 h-3 text-teal-400" />
            <span>{hasVideo ? '1 Master Video' : '0 Assets'}</span>
          </span>
        </div>
      </div>

      {/* Main Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-[#0f1115]">
        {/* Modern Drag and Drop Upload Box */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-2xl p-4 flex flex-col items-center justify-center text-center transition-all ${
            isDragging
              ? 'border-teal-400 bg-teal-500/10 shadow-lg shadow-teal-950/40 scale-[1.01]'
              : 'border-[#262b3a] hover:border-teal-500/50 bg-[#141720]'
          }`}
        >
          <div className="w-10 h-10 rounded-2xl bg-[#1d212e] border border-[#2d3448] flex items-center justify-center mb-2 text-teal-400 shadow-sm">
            {isAppending ? (
              <Loader2 className="w-5 h-5 animate-spin text-teal-400" />
            ) : (
              <Upload className="w-5 h-5" />
            )}
          </div>
          <p className="text-xs font-bold text-white mb-0.5">
            {hasVideo ? 'Drop additional video clips or audio files here' : 'Drop video file here to start editing'}
          </p>
          <p className="text-[10px] text-zinc-400 mb-3">
            Supports MP4, MOV, WebM, MKV, MP3, WAV
          </p>

          <div className="flex items-center gap-2">
            <button
              onClick={() => appendInputRef.current?.click()}
              disabled={isAppending}
              className="px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-teal-600 to-emerald-600 hover:from-teal-500 hover:to-emerald-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-teal-950/40 active:scale-95 transition-all disabled:opacity-50"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{hasVideo ? 'Append to Timeline' : 'Upload Video'}</span>
            </button>

            {hasVideo && (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-1.5 rounded-xl bg-[#1d212c] hover:bg-[#282e3c] border border-[#2e3546] text-zinc-300 hover:text-white text-xs font-semibold transition-colors"
              >
                Replace Master
              </button>
            )}
          </div>
        </div>

        {/* Project Asset Cards Grid */}
        {hasVideo ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-teal-400" />
                Project Stems & Media ({hasVideo ? 1 + (audioSeparated ? 2 : 0) : 0})
              </span>
              <button
                onClick={() => appendInputRef.current?.click()}
                className="text-[11px] font-bold text-teal-400 hover:text-teal-300 flex items-center gap-1 transition-colors"
              >
                <Plus className="w-3 h-3" />
                <span>Add Clip</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {/* Main Video Item */}
              {(activeFilter === 'all' || activeFilter === 'video') && (
                <div
                  className="bg-[#141720] border border-[#242938] hover:border-teal-500/70 rounded-2xl p-2.5 space-y-2 group relative shadow-md shadow-black/30 transition-all cursor-pointer overflow-hidden"
                  onClick={async () => {
                    if (!currentProject) return;
                    try {
                      const updated = await addVideoClip(currentProject.id, 0, currentProject.duration || 10);
                      setVideoClips(updated);
                      showToast('Placed master clip on Timeline (V1)');
                    } catch (err) {
                      console.error('Failed to add clip:', err);
                    }
                  }}
                  title="Click to place master video clip on Timeline Track V1"
                >
                  <div className="aspect-video bg-black rounded-xl overflow-hidden relative flex items-center justify-center border border-[#1e2332]">
                    {thumbnailUrl ? (
                      <img src={thumbnailUrl} alt="Thumbnail" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                    ) : (
                      <Film className="w-7 h-7 text-zinc-600" />
                    )}

                    {/* Track Pill */}
                    <span className="absolute top-1.5 left-1.5 px-2 py-0.5 rounded-md bg-teal-600/90 text-white font-mono text-[9px] font-bold shadow-sm">
                      V1 Master
                    </span>

                    {/* Duration Badge */}
                    <span className="absolute bottom-1.5 right-1.5 px-2 py-0.5 rounded-md bg-black/80 backdrop-blur-sm text-[10px] font-mono text-zinc-200 font-bold border border-white/10">
                      {formatDuration(currentProject?.duration)}
                    </span>

                    {/* Hover Overlay */}
                    <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                      <span className="px-3 py-1.5 rounded-xl bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-lg shadow-teal-950/60 active:scale-95 transition-transform">
                        <Plus className="w-3.5 h-3.5" />
                        <span>Place on Timeline</span>
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-0.5">
                    <p className="text-xs font-bold text-white truncate max-w-[120px]">
                      {currentProject?.video_filename || 'Master Video'}
                    </p>
                    <span className="text-[10px] text-teal-400 font-semibold font-mono">
                      Master
                    </span>
                  </div>
                </div>
              )}

              {/* Separated Vocals Track */}
              {audioSeparated && vocalsUrl && (activeFilter === 'all' || activeFilter === 'audio') && (
                <div className="bg-[#141720] border border-[#242938] hover:border-purple-500/60 rounded-2xl p-2.5 space-y-2 group relative shadow-md shadow-black/30 transition-all">
                  <div className="aspect-video bg-gradient-to-br from-purple-950/60 to-[#141720] border border-purple-500/20 rounded-xl flex flex-col items-center justify-center relative overflow-hidden">
                    {/* Animated Equalizer Waveform while playing */}
                    {playingAudioKey === 'vocals' ? (
                      <div className="flex items-end gap-1 mb-2 h-6">
                        <div className="w-1 bg-purple-400 rounded animate-bounce [animation-delay:-0.3s] h-5" />
                        <div className="w-1 bg-purple-300 rounded animate-bounce [animation-delay:-0.1s] h-6" />
                        <div className="w-1 bg-purple-400 rounded animate-bounce [animation-delay:-0.4s] h-3" />
                        <div className="w-1 bg-purple-200 rounded animate-bounce [animation-delay:-0.2s] h-6" />
                        <div className="w-1 bg-purple-400 rounded animate-bounce [animation-delay:-0.5s] h-4" />
                      </div>
                    ) : null}

                    <button
                      onClick={() => handleTogglePlayAudio('vocals', vocalsUrl)}
                      className="w-10 h-10 rounded-full bg-purple-600 hover:bg-purple-500 text-white flex items-center justify-center shadow-lg shadow-purple-950/50 transition-all active:scale-95"
                    >
                      {playingAudioKey === 'vocals' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                    </button>
                    <span className="absolute top-1.5 left-1.5 px-2 py-0.5 rounded-md bg-purple-600/90 text-white font-mono text-[9px] font-bold">
                      A1 Vocal Stem
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-purple-300 truncate">Isolated Vocals</p>
                    <span className="text-[10px] text-purple-400 font-mono">Clean Stem</span>
                  </div>
                </div>
              )}

              {/* Separated BGM Track */}
              {audioSeparated && bgmUrl && (activeFilter === 'all' || activeFilter === 'audio') && (
                <div className="bg-[#141720] border border-[#242938] hover:border-blue-500/60 rounded-2xl p-2.5 space-y-2 group relative shadow-md shadow-black/30 transition-all">
                  <div className="aspect-video bg-gradient-to-br from-blue-950/60 to-[#141720] border border-blue-500/20 rounded-xl flex flex-col items-center justify-center relative overflow-hidden">
                    {/* Animated Equalizer Waveform while playing */}
                    {playingAudioKey === 'bgm' ? (
                      <div className="flex items-end gap-1 mb-2 h-6">
                        <div className="w-1 bg-blue-400 rounded animate-bounce [animation-delay:-0.2s] h-5" />
                        <div className="w-1 bg-blue-300 rounded animate-bounce [animation-delay:-0.4s] h-6" />
                        <div className="w-1 bg-blue-400 rounded animate-bounce [animation-delay:-0.1s] h-4" />
                        <div className="w-1 bg-blue-200 rounded animate-bounce [animation-delay:-0.3s] h-6" />
                        <div className="w-1 bg-blue-400 rounded animate-bounce [animation-delay:-0.5s] h-3" />
                      </div>
                    ) : null}

                    <button
                      onClick={() => handleTogglePlayAudio('bgm', bgmUrl)}
                      className="w-10 h-10 rounded-full bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center shadow-lg shadow-blue-950/50 transition-all active:scale-95"
                    >
                      {playingAudioKey === 'bgm' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                    </button>
                    <span className="absolute top-1.5 left-1.5 px-2 py-0.5 rounded-md bg-blue-600/90 text-white font-mono text-[9px] font-bold">
                      A2 Music Stem
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-blue-300 truncate">Background Music</p>
                    <span className="text-[10px] text-blue-400 font-mono">BGM Stem</span>
                  </div>
                </div>
              )}
            </div>

            {/* Sliced Timeline Clips Sub-list */}
            {videoClips.length > 1 && (activeFilter === 'all' || activeFilter === 'clips') && (
              <div className="pt-2 space-y-2">
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1">
                  <Scissors className="w-3 h-3 text-teal-400" />
                  Timeline Clips ({videoClips.length})
                </span>
                <div className="space-y-1.5">
                  {videoClips.map((clip, idx) => {
                    const dur = Math.max(0, clip.source_end - clip.source_start);
                    return (
                      <div
                        key={clip.id}
                        onClick={() => {
                          if (videoRef.current) videoRef.current.currentTime = clip.source_start;
                          setCurrentTime(clip.source_start);
                        }}
                        className="p-2 rounded-xl bg-[#151821] border border-[#232736] hover:border-teal-500/60 flex items-center justify-between cursor-pointer transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono font-bold text-teal-400">Clip #{idx + 1}</span>
                          <span className="text-[10px] text-zinc-300 font-mono">
                            {formatDuration(clip.source_start)} - {formatDuration(clip.source_end)}
                          </span>
                        </div>
                        <span className="text-[10px] font-mono text-zinc-500">
                          {dur.toFixed(1)}s
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-8 space-y-2.5">
            <div className="w-12 h-12 rounded-2xl bg-[#161922] border border-[#242938] flex items-center justify-center text-zinc-500 mx-auto">
              <FolderOpen className="w-6 h-6 text-teal-400" />
            </div>
            <h4 className="text-xs font-bold text-white">Media Pool is Empty</h4>
            <p className="text-[11px] text-zinc-400 max-w-xs mx-auto">
              Upload your video file or drag and drop media to populate your project media pool.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
