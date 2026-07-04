import { useState, useRef, RefObject, useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';
import {
  Film,
  Music2,
  Mic2,
  Play,
  Pause,
  FileVideo,
  FileAudio,
  Clock,
  HardDrive,
  ImagePlus,
  Trash2,
  Volume2,
  VolumeX,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  vocalsUrl: string | null;
  bgmUrl: string | null;
  audioSeparated: boolean;
}

interface MediaItem {
  id: string;
  name: string;
  type: 'video' | 'audio' | 'tts';
  url: string;
  duration?: number;
  icon: 'video' | 'audio' | 'mic';
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export default function MediaPool({ videoRef, vocalsUrl, bgmUrl, audioSeparated }: Props) {
  const { currentProject } = useProjectStore();
  const [expandedSections, setExpandedSections] = useState({
    video: true,
    audio: true,
    tts: true,
  });
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const audioPreviewRef = useRef<HTMLAudioElement>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  const hasVideo = !!currentProject?.video_path;
  const projectId = currentProject?.id || '';

  // Generate video thumbnail from first frame
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hasVideo) {
      setThumbnailUrl(null);
      return;
    }

    const captureThumbnail = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          setThumbnailUrl(canvas.toDataURL('image/jpeg', 0.7));
        }
      } catch {
        // Cross-origin or other issues
      }
    };

    if (video.readyState >= 2) {
      captureThumbnail();
    } else {
      video.addEventListener('loadeddata', captureThumbnail, { once: true });
      return () => video.removeEventListener('loadeddata', captureThumbnail);
    }
  }, [videoRef, hasVideo, currentProject?.video_path]);

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const handlePreviewAudio = (url: string, id: string) => {
    const audio = audioPreviewRef.current;
    if (!audio) return;

    if (playingAudioId === id) {
      audio.pause();
      setPlayingAudioId(null);
      return;
    }

    audio.src = url;
    audio.play().catch(() => {});
    setPlayingAudioId(id);
  };

  useEffect(() => {
    const audio = audioPreviewRef.current;
    if (!audio) return;
    const onEnded = () => setPlayingAudioId(null);
    audio.addEventListener('ended', onEnded);
    return () => audio.removeEventListener('ended', onEnded);
  }, []);

  // Build media items from project data
  const videoItems: MediaItem[] = [];
  if (hasVideo && currentProject) {
    videoItems.push({
      id: 'main-video',
      name: currentProject.video_filename || 'Video',
      type: 'video',
      url: `/uploads/${projectId}/${currentProject.video_path?.split('/').pop()}`,
      duration: currentProject.duration,
      icon: 'video',
    });
  }

  const audioItems: MediaItem[] = [];
  if (audioSeparated && vocalsUrl) {
    audioItems.push({
      id: 'vocals',
      name: 'Vocals Track',
      type: 'audio',
      url: vocalsUrl,
      icon: 'audio',
    });
  }
  if (audioSeparated && bgmUrl) {
    audioItems.push({
      id: 'bgm',
      name: 'Background Music',
      type: 'audio',
      url: bgmUrl,
      icon: 'audio',
    });
  }

  const ttsItems: MediaItem[] = [];
  const segments = currentProject?.segments || [];
  for (const seg of segments) {
    if (seg.audio_url) {
      ttsItems.push({
        id: `tts-${seg.id}`,
        name: seg.text.length > 30 ? seg.text.slice(0, 30) + '…' : seg.text,
        type: 'tts',
        url: seg.audio_url,
        duration: seg.end_time - seg.start_time,
        icon: 'mic',
      });
    }
  }

  const totalItems = videoItems.length + audioItems.length + ttsItems.length;

  const SectionHeader = ({
    title,
    count,
    section,
    icon,
    iconColor,
  }: {
    title: string;
    count: number;
    section: keyof typeof expandedSections;
    icon: React.ReactNode;
    iconColor: string;
  }) => (
    <button
      onClick={() => toggleSection(section)}
      className="flex items-center gap-2 w-full px-2 py-1.5 hover:bg-zinc-800/50 rounded-lg transition-colors group"
    >
      {expandedSections[section] ? (
        <ChevronDown className="w-3 h-3 text-zinc-500" />
      ) : (
        <ChevronRight className="w-3 h-3 text-zinc-500" />
      )}
      <div className={`w-4 h-4 rounded flex items-center justify-center ${iconColor}`}>
        {icon}
      </div>
      <span className="text-[11px] font-medium text-zinc-300 flex-1 text-left">{title}</span>
      <span className="text-[10px] text-zinc-600 tabular-nums">{count}</span>
    </button>
  );

  const MediaCard = ({ item }: { item: MediaItem }) => {
    const isPlaying = playingAudioId === item.id;

    return (
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-zinc-800/60 transition-colors group cursor-default">
        {/* Thumbnail / Icon */}
        <div className="w-10 h-10 rounded-md bg-zinc-800 border border-zinc-700/50 flex items-center justify-center shrink-0 overflow-hidden">
          {item.type === 'video' && thumbnailUrl ? (
            <img src={thumbnailUrl} alt="" className="w-full h-full object-cover" />
          ) : item.icon === 'video' ? (
            <FileVideo className="w-4 h-4 text-blue-400" />
          ) : item.icon === 'mic' ? (
            <Mic2 className="w-4 h-4 text-green-400" />
          ) : (
            <FileAudio className="w-4 h-4 text-amber-400" />
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <p className="text-[11px] text-zinc-300 truncate leading-tight">{item.name}</p>
          <div className="flex items-center gap-2 mt-0.5">
            {item.duration != null && (
              <span className="text-[9px] text-zinc-500 flex items-center gap-0.5">
                <Clock className="w-2.5 h-2.5" />
                {formatDuration(item.duration)}
              </span>
            )}
            <span className="text-[9px] text-zinc-600 uppercase">
              {item.type === 'video' ? 'MP4' : item.type === 'tts' ? 'TTS' : 'WAV'}
            </span>
          </div>
        </div>

        {/* Play button for audio items */}
        {(item.type === 'audio' || item.type === 'tts') && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handlePreviewAudio(item.url, item.id);
            }}
            className="p-1 rounded-md hover:bg-zinc-700 transition-colors opacity-0 group-hover:opacity-100"
            title={isPlaying ? 'Stop' : 'Preview'}
          >
            {isPlaying ? (
              <Pause className="w-3 h-3 text-khmer-400" />
            ) : (
              <Play className="w-3 h-3 text-zinc-400" />
            )}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/60">
        <div className="flex items-center gap-2">
          <Film className="w-4 h-4 text-zinc-400" />
          <span className="text-xs font-semibold text-zinc-300 tracking-wide">Media Pool</span>
        </div>
        <span className="text-[10px] text-zinc-600 tabular-nums">
          {totalItems} item{totalItems !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {totalItems === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="w-10 h-10 rounded-xl bg-zinc-800/60 flex items-center justify-center mb-2">
              <ImagePlus className="w-5 h-5 text-zinc-600" />
            </div>
            <p className="text-[11px] text-zinc-500">No media files yet</p>
            <p className="text-[10px] text-zinc-600 mt-0.5">Upload a video to get started</p>
          </div>
        ) : (
          <>
            {/* Video Section */}
            {videoItems.length > 0 && (
              <div>
                <SectionHeader
                  title="Video"
                  count={videoItems.length}
                  section="video"
                  icon={<FileVideo className="w-2.5 h-2.5 text-white" />}
                  iconColor="bg-blue-600"
                />
                {expandedSections.video && (
                  <div className="ml-3 mt-0.5 space-y-0.5">
                    {videoItems.map((item) => (
                      <MediaCard key={item.id} item={item} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Audio Section */}
            {audioItems.length > 0 && (
              <div>
                <SectionHeader
                  title="Audio Tracks"
                  count={audioItems.length}
                  section="audio"
                  icon={<Music2 className="w-2.5 h-2.5 text-white" />}
                  iconColor="bg-amber-500"
                />
                {expandedSections.audio && (
                  <div className="ml-3 mt-0.5 space-y-0.5">
                    {audioItems.map((item) => (
                      <MediaCard key={item.id} item={item} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TTS Audio Section */}
            {ttsItems.length > 0 && (
              <div>
                <SectionHeader
                  title="Voice Clips"
                  count={ttsItems.length}
                  section="tts"
                  icon={<Mic2 className="w-2.5 h-2.5 text-white" />}
                  iconColor="bg-green-600"
                />
                {expandedSections.tts && (
                  <div className="ml-3 mt-0.5 space-y-0.5">
                    {ttsItems.map((item) => (
                      <MediaCard key={item.id} item={item} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer — Project media summary */}
      {hasVideo && currentProject && (
        <div className="border-t border-zinc-800/60 px-3 py-2">
          <div className="flex items-center gap-3 text-[9px] text-zinc-600">
            <span className="flex items-center gap-1">
              <Clock className="w-2.5 h-2.5" />
              {formatDuration(currentProject.duration || 0)}
            </span>
            <span className="flex items-center gap-1">
              <HardDrive className="w-2.5 h-2.5" />
              {currentProject.video_filename?.split('.').pop()?.toUpperCase() || 'MP4'}
            </span>
          </div>
        </div>
      )}

      {/* Hidden audio element for previews */}
      <audio ref={audioPreviewRef} style={{ display: 'none' }} />
    </div>
  );
}
