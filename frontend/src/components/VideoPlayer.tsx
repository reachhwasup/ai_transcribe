import { useEffect, RefObject, useCallback, useRef, useMemo } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { Play, Pause, Square, Repeat, Volume2, VolumeX, Upload } from 'lucide-react';
import { useState } from 'react';
import { buildClipLayout, sourceToTimeline, timelineToSource, totalTimelineDuration } from '../utils/clipTimemap';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
}

export default function VideoPlayer({ videoRef }: Props) {
  const { currentProject, currentTime, isPlaying, setCurrentTime, setIsPlaying, setActiveSegment, videoClips, activeSegmentId, subtitleStyle } =
    useProjectStore();
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const seekValueRef = useRef<number | null>(null);
  const wasPlayingRef = useRef(false);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  const videoSrc = currentProject?.video_path
    ? `/uploads/${currentProject.id}/${currentProject.video_path.split('/').pop()}`
    : null;

  // Build sequential clip layout
  const clipLayout = useMemo(() => buildClipLayout(videoClips), [videoClips]);
  const tlDuration = useMemo(() => totalTimelineDuration(videoClips), [videoClips]);

  // Directly update progress bar DOM elements (avoids React re-render lag)
  const updateProgressBar = useCallback((time: number) => {
    const maxDur = clipLayout.length > 0 ? tlDuration : videoDuration;
    const pct = maxDur > 0 ? Math.min(100, (time / maxDur) * 100) : 0;
    if (fillRef.current) fillRef.current.style.width = `${pct}%`;
    if (thumbRef.current) thumbRef.current.style.left = `calc(${pct}% - 6px)`;
  }, [clipLayout, tlDuration, videoDuration]);

  // Force reload when video source changes (React doesn't call video.load() automatically)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoSrc) return;
    video.load();
  }, [videoSrc, videoRef]);

  // Track real video duration from the HTML video element
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onDuration = () => {
      if (video.duration && isFinite(video.duration)) setVideoDuration(video.duration);
    };
    video.addEventListener('loadedmetadata', onDuration);
    video.addEventListener('durationchange', onDuration);
    // If already loaded
    if (video.duration && isFinite(video.duration)) setVideoDuration(video.duration);
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
      // Skip store updates while user is dragging the seek bar
      if (seekValueRef.current !== null) return;

      const srcTime = video.currentTime;

      if (clipLayout.length > 0 && !video.paused) {
        // Find current clip layout entry for this source time
        let inClip = false;
        for (const l of clipLayout) {
          if (srcTime >= l.clip.source_start && srcTime < l.clip.source_end) {
            inClip = true;
            break;
          }
        }
        if (!inClip) {
          // Source time is in a gap or past clips — find next clip
          const sorted = [...clipLayout].sort((a, b) => a.clip.source_start - b.clip.source_start);
          let jumped = false;
          for (const l of sorted) {
            if (l.clip.source_start > srcTime) {
              video.currentTime = l.clip.source_start;
              // Update store to the timeline position of the jumped-to clip
              setCurrentTime(l.timelineStart);
              jumped = true;
              break;
            }
          }
          if (!jumped) {
            // Past all clips — pause at end
            const last = clipLayout[clipLayout.length - 1];
            if (last) {
              video.pause();
              video.currentTime = last.clip.source_end - 0.01;
              // Update store to timeline end so playhead shows at end
              setCurrentTime(last.timelineEnd);
            }
          }
          return;
        }
      }

      // Convert source time to timeline time for the store
      const tlTime = clipLayout.length > 0 ? sourceToTimeline(clipLayout, srcTime) : srcTime;
      setCurrentTime(tlTime);
      updateProgressBar(tlTime);

      const seg = currentProject?.segments?.find(
        (s) => srcTime >= s.start_time && srcTime <= s.end_time
      );
      setActiveSegment(seg?.id ?? null);
    };

    // Use rAF loop for smooth progress bar updates during playback
    const tick = () => {
      if (!video.paused) {
        updateTime();
      }
      rafId = requestAnimationFrame(tick);
    };

    const onPlay = () => {
      setIsPlaying(true);
      rafId = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setIsPlaying(false);
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      updateTime(); // Final update on pause
    };
    const onSeeked = () => updateTime();

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);

    // If already playing when effect mounts
    if (!video.paused) {
      rafId = requestAnimationFrame(tick);
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', onSeeked);
    };
  }, [videoRef, currentProject?.segments, clipLayout, updateProgressBar]);

  // Keep progress bar in sync when currentTime changes from external sources (e.g. segment click)
  useEffect(() => {
    updateProgressBar(currentTime);
  }, [currentTime, updateProgressBar]);

  /** Seek the video to a timeline time (converts to source time) */
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
    setCurrentTime(tlTime);
    updateProgressBar(tlTime);
  }, [clipLayout, videoRef, setCurrentTime, updateProgressBar]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      // Make sure we're at a valid source time
      if (clipLayout.length > 0) {
        const result = timelineToSource(clipLayout, currentTime);
        if (result) {
          video.currentTime = result.sourceTime;
        } else {
          // Past all clips — restart from beginning
          video.currentTime = clipLayout[0]?.clip.source_start ?? 0;
          setCurrentTime(0);
        }
      }
      video.play();
    } else {
      video.pause();
    }
  };

  const stop = () => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    if (clipLayout.length > 0) {
      video.currentTime = clipLayout[0].clip.source_start;
    } else {
      video.currentTime = 0;
    }
    setCurrentTime(0);
  };

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !muted;
      setMuted(!muted);
    }
  };

  const toggleLoop = () => {
    if (videoRef.current) {
      videoRef.current.loop = !loop;
      setLoop(!loop);
    }
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 100);
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  if (!videoSrc) {
    return (
      <div className="aspect-video flex items-center justify-center bg-black/40 border-b border-zinc-800">
        <div className="text-center text-zinc-600 py-8">
          <Upload className="w-10 h-10 mx-auto mb-3 opacity-20" />
          <p className="text-xs opacity-60">No video loaded</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col border-b border-zinc-800">
      {/* Video with play overlay */}
      <div className="relative bg-black flex items-center justify-center group" style={{ maxHeight: '300px' }}>
        <video
          ref={videoRef}
          src={videoSrc}
          className="w-full max-h-[300px] object-contain"
          onClick={togglePlay}
          preload="auto"
        />
        {/* Styled subtitle overlay — live preview of the export style */}
        {(() => {
          const seg = currentProject?.segments?.find((s) => s.id === activeSegmentId);
          if (!seg?.text) return null;
          const posCls =
            subtitleStyle.position === 'top'
              ? 'top-2'
              : subtitleStyle.position === 'middle'
              ? 'top-1/2 -translate-y-1/2'
              : 'bottom-2';
          return (
            <div className={`absolute left-2 right-2 ${posCls} text-center pointer-events-none`}>
              <span
                className="inline-block px-2 py-0.5 bg-black/60 rounded text-white leading-snug max-w-full"
                style={{ fontSize: `${Math.round(subtitleStyle.sizePct * 3)}px` }}
              >
                {seg.text}
              </span>
            </div>
          );
        })()}
        {/* Big play overlay when paused */}
        {!isPlaying && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-black/20 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={togglePlay}
          >
            <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
              <Play className="w-6 h-6 text-white ml-0.5" />
            </div>
          </div>
        )}
      </div>

      {/* Compact control bar */}
      <div className="flex items-center gap-1.5 px-2 py-1 bg-zinc-900/80">
        {/* Play/Pause */}
        <button
          onClick={togglePlay}
          className="p-1.5 hover:bg-zinc-800 rounded-md transition-colors"
          title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
        >
          {isPlaying ? (
            <Pause className="w-4 h-4 text-white" />
          ) : (
            <Play className="w-4 h-4 text-white" />
          )}
        </button>

        <button
          onClick={stop}
          className="p-1.5 hover:bg-zinc-800 rounded-md transition-colors"
          title="Stop (Home)"
        >
          <Square className="w-3 h-3 text-zinc-400" />
        </button>

        {/* Time */}
        <span className="text-[10px] font-mono text-zinc-300 min-w-[60px]">
          {formatTime(currentTime)}
        </span>
        <span className="text-[10px] font-mono text-zinc-600">/</span>
        <span className="text-[10px] font-mono text-zinc-500 min-w-[60px]">
          {formatTime(clipLayout.length > 0 ? tlDuration : videoDuration)}
        </span>

        {/* Seek bar */}
        {(() => {
          const maxDur = clipLayout.length > 0 ? tlDuration : videoDuration;
          return (
        <div
          className="flex-1 px-1 group/seek relative flex items-center h-5 cursor-pointer"
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
          {/* Track background */}
          <div className="absolute left-0 right-0 h-1 bg-zinc-700 rounded-full group-hover/seek:h-1.5 transition-[height]" />
          {/* Filled portion — updated via ref for instant sync */}
          <div
            ref={fillRef}
            className="absolute left-0 h-1 bg-blue-500 rounded-full group-hover/seek:h-1.5 transition-[height] pointer-events-none"
            style={{ width: '0%' }}
          />
          {/* Thumb — updated via ref for instant sync */}
          <div
            ref={thumbRef}
            className="absolute w-3 h-3 bg-white rounded-full shadow-md pointer-events-none opacity-0 group-hover/seek:opacity-100 transition-opacity"
            style={{ left: 'calc(0% - 6px)' }}
          />
        </div>
          );
        })()}

        {/* Volume */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={toggleMute}
            className="p-1 hover:bg-zinc-800 rounded transition-colors"
            title={muted ? 'Unmute (M)' : 'Mute (M)'}
          >
            {muted ? (
              <VolumeX className="w-3.5 h-3.5 text-red-400" />
            ) : (
              <Volume2 className="w-3.5 h-3.5 text-zinc-400" />
            )}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            defaultValue={1}
            onChange={(e) => {
              if (videoRef.current) videoRef.current.volume = parseFloat(e.target.value);
            }}
            className="w-12 h-1 accent-zinc-400 cursor-pointer"
          />
        </div>

        {/* Loop */}
        <button
          onClick={toggleLoop}
          className={`p-1 hover:bg-zinc-800 rounded transition-colors ${loop ? 'text-khmer-400' : 'text-zinc-600'}`}
          title="Loop"
        >
          <Repeat className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
