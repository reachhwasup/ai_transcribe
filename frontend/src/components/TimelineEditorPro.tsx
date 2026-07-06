import { useRef, useState, useCallback, useEffect, useMemo, RefObject } from 'react';
import { useProjectStore } from '../stores/projectStore';
import type { Segment, VideoClip } from '../types';
import { getVideoClips, splitClipAtPlayhead, deleteVideoClip, restoreVideoClips, updateVideoClip, updateProject, flipVideo, rotateVideo, changeVideoSpeed, cropVideo } from '../api/client';
import { buildClipLayout, totalTimelineDuration, timelineToSource, sourceToTimeline } from '../utils/clipTimemap';
import {
  Volume2,
  VolumeX,
  Languages,
  Sparkles,
  AudioLines,
  ChevronDown,
  Music,
  Mic,
  Loader2,
  Check,
  X,
  Scissors,
  Trash2,
  Film,
  MousePointer2,
  Undo2,
  Redo2,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  MoreHorizontal,
  FlipHorizontal,
  Gauge,
  Plus,
  ZoomIn,
  ZoomOut,
  FlipVertical,
  RotateCw,
  RotateCcw,
  Crop,
} from 'lucide-react';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  vocalsRef?: RefObject<HTMLAudioElement | null>;
  bgmRef?: RefObject<HTMLAudioElement | null>;
  audioSeparated?: boolean;
  onAudioSeparated?: (vocalsUrl: string, bgmUrl: string) => void;
  onRemoveAudioSeparation?: () => void;
}

const COLORS = [
  '#3d8eff', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
];

const _UNUSED_SPEED = 0; // speed is now per-segment in SubtitleDataPanel

export default function TimelineEditor({ videoRef, vocalsRef, bgmRef, audioSeparated, onAudioSeparated, onRemoveAudioSeparation }: Props) {
  const {
    currentProject,
    currentTime,
    isPlaying,
    activeSegmentId,
    isTranscribing,
    transcribeProgress,
    setActiveSegment,
    setCurrentTime,
    updateSegment,
    addSegment,
    generateTranscript,
    cancelTranscription,
    generateVoiceForSegments,
    videoClips,
    setVideoClips,
    loadProject,
    selectedSegmentIds,
    deleteSegment,
    videoMuted: a2Muted,
    setVideoMuted: setA2Muted,
  } = useProjectStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(3);
  const [dragging, setDragging] = useState<{
    segmentId: string;
    type: 'move' | 'resize-start' | 'resize-end';
    startX: number;
    originalStart: number;
    originalEnd: number;
  } | null>(null);
  const [mutedTracks, setMutedTracks] = useState<Set<number>>(new Set());
  const [aiMutedProfiles, setAiMutedProfiles] = useState<Set<string>>(new Set());
  const [b1Muted, setB1Muted] = useState(false);
  const [v1Muted, setV1Muted] = useState(false);

  // Generate Voice Audio state
  const [showAudioPanel, setShowAudioPanel] = useState(false);
  const [audioGenerating, setAudioGenerating] = useState(false);
  const [audioGenerated, setAudioGenerated] = useState(false);
  const audioPanelRef = useRef<HTMLDivElement>(null);

  // Editing tools state
  const [showFlipPanel, setShowFlipPanel] = useState(false);
  const [showSpeedPanel, setShowSpeedPanel] = useState(false);
  const [isFlipping, setIsFlipping] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [showRotatePanel, setShowRotatePanel] = useState(false);
  const [isChangingSpeed, setIsChangingSpeed] = useState(false);
  const [showCropModal, setShowCropModal] = useState(false);
  const [isCropping, setIsCropping] = useState(false);
  const [cropX, setCropX] = useState(0);
  const [cropY, setCropY] = useState(0);
  const [cropW, setCropW] = useState(0);
  const [cropH, setCropH] = useState(0);
  const flipPanelRef = useRef<HTMLDivElement>(null);
  const rotatePanelRef = useRef<HTMLDivElement>(null);
  const speedPanelRef = useRef<HTMLDivElement>(null);

  // Video clips local UI state
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [splitProcessing, setSplitProcessing] = useState(false);
  const [clipDragging, setClipDragging] = useState<{
    clipId: string;
    type: 'resize-start' | 'resize-end';
    startX: number;
    originalStart: number;
    originalEnd: number;
  } | null>(null);

  // Undo/Redo history for video clips
  const undoStackRef = useRef<{ source_start: number; source_end: number }[][]>([]);
  const redoStackRef = useRef<{ source_start: number; source_end: number }[][]>([]);

  // Undo/Redo history for segment deletions
  type SegmentUndoAction = { type: 'delete-segment'; segment: Segment };
  const segmentUndoStackRef = useRef<SegmentUndoAction[]>([]);

  const snapshotClips = useCallback(() => {
    return videoClips.map(c => ({ source_start: c.source_start, source_end: c.source_end }));
  }, [videoClips]);

  const pushUndo = useCallback(() => {
    undoStackRef.current.push(snapshotClips());
    // Clear redo on new action
    redoStackRef.current = [];
  }, [snapshotClips]);

  // AI audio playback refs
  const aiAudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());

  // Ruler scrubbing (drag playhead on time ruler)
  const [rulerDragging, setRulerDragging] = useState(false);
  const rulerWasPlayingRef = useRef(false);

  // Track lock/visible state
  const [lockedTracks, setLockedTracks] = useState<Set<string>>(new Set());
  const [hiddenTracks, setHiddenTracks] = useState<Set<string>>(new Set());

  // Video thumbnails — extracted from video element
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const thumbGenRef = useRef(false);

  // Wire A2 mute to actual video audio
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = a2Muted;
  }, [a2Muted, videoRef]);

  // Wire V1 mute to vocals audio element
  useEffect(() => {
    if (vocalsRef?.current) vocalsRef.current.muted = v1Muted;
  }, [v1Muted, vocalsRef]);

  // Wire B1 mute to BGM audio element
  useEffect(() => {
    if (bgmRef?.current) bgmRef.current.muted = b1Muted;
  }, [b1Muted, bgmRef]);

  // When audio is separated, auto-mute A2 and unmute V1+B1
  useEffect(() => {
    if (audioSeparated) {
      setA2Muted(true);
      setV1Muted(false);
      setB1Muted(false);
    }
  }, [audioSeparated]);

  // Generate video thumbnails for the timeline strip
  useEffect(() => {
    if (!currentProject?.video_path || !currentProject?.duration || thumbGenRef.current) return;
    const dur = currentProject.duration;
    if (dur <= 0) return;
    thumbGenRef.current = true;

    const videoFilename = currentProject.video_path.split('/').pop();
    const videoSrc = `/uploads/${currentProject.id}/${videoFilename}`;
    const thumbCount = Math.min(Math.max(Math.ceil(dur / 3), 8), 60);
    const interval = dur / thumbCount;

    const vid = document.createElement('video');
    vid.crossOrigin = 'anonymous';
    vid.muted = true;
    vid.preload = 'auto';
    vid.src = videoSrc;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = 80;
    canvas.height = 50;

    const thumbs: string[] = [];
    let idx = 0;

    vid.addEventListener('loadeddata', () => {
      const captureNext = () => {
        if (idx >= thumbCount) {
          setThumbnails(thumbs);
          vid.remove();
          return;
        }
        vid.currentTime = idx * interval + interval / 2;
      };

      vid.addEventListener('seeked', () => {
        ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
        thumbs.push(canvas.toDataURL('image/jpeg', 0.5));
        idx++;
        captureNext();
      });

      captureNext();
    });

    vid.addEventListener('error', () => {
      thumbGenRef.current = false;
    });

    return () => {
      vid.pause();
      vid.src = '';
    };
  }, [currentProject?.id, currentProject?.video_path, currentProject?.duration]);

  // Load video clips when project changes
  useEffect(() => {
    if (!currentProject?.id) return;
    // Use clips from project data if available, otherwise fetch
    if (currentProject.video_clips && currentProject.video_clips.length > 0) {
      setVideoClips(currentProject.video_clips);
    } else if (currentProject.video_path) {
      getVideoClips(currentProject.id).then(setVideoClips).catch(() => {});
    }
  }, [currentProject?.id, currentProject?.video_clips, currentProject?.video_path]);

  // CapCut-style: clips laid out sequentially, total timeline = sum of clip durations
  const clipLayout = useMemo(() => buildClipLayout(videoClips), [videoClips]);

  // Compute distinct AI audio tracks by voice_profile
  const aiTrackProfiles = useMemo(() => {
    const segs = currentProject?.segments || [];
    const profiles = new Set<string>();
    segs.forEach((s) => {
      if (s.audio_url) profiles.add(s.voice_profile || 'female');
    });
    // If no audio yet, check if multiple voice_profiles exist from transcription
    if (profiles.size === 0) {
      segs.forEach((s) => profiles.add(s.voice_profile || 'female'));
    }
    const arr = Array.from(profiles).sort(); // female first, male second
    return arr.length > 1 ? arr : ['_all']; // '_all' = single combined track
  }, [currentProject?.segments]);

  const toggleAiTrackMute = useCallback((profile: string) => {
    setAiMutedProfiles((prev) => {
      const next = new Set(prev);
      if (next.has(profile)) next.delete(profile);
      else next.add(profile);
      return next;
    });
  }, []);

  // AI audio playback: sync with video time
  useEffect(() => {
    const segs = currentProject?.segments || [];
    // Convert timeline time to source time when clips exist
    let sourceTime = currentTime;
    if (clipLayout.length > 0) {
      const result = timelineToSource(clipLayout, currentTime);
      if (result) {
        sourceTime = result.sourceTime;
      }
    }
    segs.forEach((seg) => {
      if (!seg.audio_url) return;
      const audio = aiAudioRefs.current.get(seg.id);
      if (!audio) return;
      const profile = seg.voice_profile || 'female';
      const isMuted = aiTrackProfiles[0] === '_all'
        ? aiMutedProfiles.has('_all')
        : aiMutedProfiles.has(profile);
      const inRange = sourceTime >= seg.start_time && sourceTime < seg.end_time;
      if (inRange && isPlaying && !isMuted) {
        const offset = sourceTime - seg.start_time;
        const clipDur = Number.isFinite(audio.duration) ? audio.duration : Infinity;
        // Only (re)start if the playhead is still within the clip's own length —
        // otherwise an audio shorter than its slot restarts from the beginning
        // every time it finishes, repeating the speech until the slot ends.
        if (audio.paused && offset < clipDur - 0.05) {
          audio.currentTime = offset;
          audio.play().catch(() => {});
        }
      } else {
        // Grace window: the clip may have started a fraction late (timeupdate
        // granularity), so don't chop its last word exactly at end_time.
        const pastGrace = sourceTime < seg.start_time || sourceTime > seg.end_time + 0.35;
        if (!audio.paused && pastGrace) {
          audio.pause();
          audio.currentTime = 0;
        }
      }
    });
  }, [currentTime, isPlaying, aiMutedProfiles, aiTrackProfiles, currentProject?.segments, clipLayout]);

  // Split clip at playhead
  const handleSplitAtPlayhead = useCallback(async () => {
    if (!currentProject || splitProcessing) return;
    // Convert timeline time to source time for the API
    let sourceTime = currentTime;
    if (clipLayout.length > 0) {
      const result = timelineToSource(clipLayout, currentTime);
      if (!result) return; // playhead not on any clip
      sourceTime = result.sourceTime;
    }
    setSplitProcessing(true);
    pushUndo();
    try {
      const clips = await splitClipAtPlayhead(currentProject.id, sourceTime);
      setVideoClips(clips);
    } catch (err: any) {
      console.error('Split failed:', err?.response?.data?.detail || err?.message);
      undoStackRef.current.pop(); // revert snapshot on failure
    }
    setSplitProcessing(false);
  }, [currentProject, currentTime, splitProcessing, pushUndo, clipLayout]);

  // Delete a clip (non-destructive — no video rebuild)
  const handleDeleteClip = useCallback(async (clipId: string) => {
    if (!currentProject) return;
    pushUndo();
    try {
      const result = await deleteVideoClip(currentProject.id, clipId);
      if (result.clips) {
        setVideoClips(result.clips);
      } else {
        setVideoClips(videoClips.filter(c => c.id !== clipId));
      }
      setSelectedClipId(null);
    } catch (err: any) {
      console.error('Delete clip failed:', err?.response?.data?.detail || err?.message);
      undoStackRef.current.pop(); // revert snapshot on failure
    }
  }, [currentProject, videoClips, setVideoClips, pushUndo]);

  // Delete a segment with undo support
  const handleDeleteSegment = useCallback(async (segmentId: string) => {
    if (!currentProject) return;
    const segment = currentProject.segments.find(s => s.id === segmentId);
    if (!segment) return;
    // Save to segment undo stack before deleting
    segmentUndoStackRef.current.push({ type: 'delete-segment', segment: { ...segment } });
    await deleteSegment(segmentId);
  }, [currentProject, deleteSegment]);

  // Undo
  const handleUndo = useCallback(async () => {
    if (!currentProject) return;

    // Segment undo takes priority (most recent user action)
    if (segmentUndoStackRef.current.length > 0) {
      const action = segmentUndoStackRef.current.pop()!;
      if (action.type === 'delete-segment') {
        const { id, project_id, created_at, updated_at, ...segData } = action.segment;
        await addSegment(segData);
      }
      return;
    }

    // Otherwise, undo video clip action
    if (undoStackRef.current.length === 0) return;
    const snapshot = undoStackRef.current.pop()!;
    // Save current state to redo
    redoStackRef.current.push(snapshotClips());
    try {
      const clips = await restoreVideoClips(currentProject.id, snapshot);
      setVideoClips(clips);
      setSelectedClipId(null);
    } catch (err: any) {
      console.error('Undo failed:', err?.response?.data?.detail || err?.message);
      // Put snapshot back on failure
      undoStackRef.current.push(snapshot);
      redoStackRef.current.pop();
    }
  }, [currentProject, snapshotClips, setVideoClips, addSegment]);

  // Redo
  const handleRedo = useCallback(async () => {
    if (!currentProject || redoStackRef.current.length === 0) return;
    const snapshot = redoStackRef.current.pop()!;
    // Save current state to undo
    undoStackRef.current.push(snapshotClips());
    try {
      const clips = await restoreVideoClips(currentProject.id, snapshot);
      setVideoClips(clips);
      setSelectedClipId(null);
    } catch (err: any) {
      console.error('Redo failed:', err?.response?.data?.detail || err?.message);
      // Revert on failure
      redoStackRef.current.push(snapshot);
      undoStackRef.current.pop();
    }
  }, [currentProject, snapshotClips, setVideoClips]);

  // Listen for keyboard shortcut events from ProjectEditor
  useEffect(() => {
    const onSplit = () => handleSplitAtPlayhead();
    const onDeleteSelected = () => {
      if (selectedClipId && videoClips.length > 1) {
        handleDeleteClip(selectedClipId);
      } else if (activeSegmentId) {
        handleDeleteSegment(activeSegmentId);
      }
    };
    const onZoom = (e: Event) => {
      const dir = (e as CustomEvent).detail;
      setZoom(prev => dir === 'in'
        ? Math.min(20, +(prev + 0.5).toFixed(1))
        : Math.max(0.5, +(prev - 0.5).toFixed(1))
      );
    };

    const onUndo = () => handleUndo();
    const onRedo = () => handleRedo();

    window.addEventListener('timeline-split', onSplit);
    window.addEventListener('timeline-delete-selected', onDeleteSelected);
    window.addEventListener('timeline-zoom', onZoom);
    window.addEventListener('timeline-undo', onUndo);
    window.addEventListener('timeline-redo', onRedo);
    return () => {
      window.removeEventListener('timeline-split', onSplit);
      window.removeEventListener('timeline-delete-selected', onDeleteSelected);
      window.removeEventListener('timeline-zoom', onZoom);
      window.removeEventListener('timeline-undo', onUndo);
      window.removeEventListener('timeline-redo', onRedo);
    };
  }, [handleSplitAtPlayhead, handleDeleteClip, selectedClipId, activeSegmentId, videoClips.length, handleDeleteSegment, handleUndo, handleRedo]);

  const sourceDuration = currentProject?.duration || 60;
  const segments = currentProject?.segments || [];
  const pixelsPerSecond = 20 * zoom;
  // Ref so drag handlers always read the latest value without re-mounting listeners
  const pixelsPerSecondRef = useRef(pixelsPerSecond);
  pixelsPerSecondRef.current = pixelsPerSecond;

  const timelineDuration = useMemo(() => {
    const tl = totalTimelineDuration(videoClips);
    return tl > 0 ? tl : sourceDuration;
  }, [videoClips, sourceDuration]);
  // For rendering: use timeline duration (sequential) when clips exist, else source duration
  const duration = timelineDuration;
  const totalWidth = Math.max(duration * pixelsPerSecond, 800);

  // Assign each segment to a lane (track) so overlapping segments go to T2, T3, etc.
  const { laneMap, laneCount } = useMemo(() => {
    const sorted = [...segments].sort((a, b) => a.start_time - b.start_time);
    const lanes: { end: number }[] = []; // each lane tracks its latest end_time
    const map = new Map<string, number>();

    for (const seg of sorted) {
      let assigned = false;
      for (let i = 0; i < lanes.length; i++) {
        if (seg.start_time >= lanes[i].end) {
          lanes[i].end = seg.end_time;
          map.set(seg.id, i);
          assigned = true;
          break;
        }
      }
      if (!assigned) {
        map.set(seg.id, lanes.length);
        lanes.push({ end: seg.end_time });
      }
    }

    return { laneMap: map, laneCount: Math.max(lanes.length, 1) };
  }, [segments]);

  const toggleTrackMute = (lane: number) => {
    setMutedTracks((prev) => {
      const next = new Set(prev);
      if (next.has(lane)) next.delete(lane);
      else next.add(lane);
      return next;
    });
  };

  const speakerColors: Record<string, string> = {};
  let colorIndex = 0;
  segments.forEach((s) => {
    if (s.speaker && !speakerColors[s.speaker]) {
      speakerColors[s.speaker] = COLORS[colorIndex % COLORS.length];
      colorIndex++;
    }
  });

  const timeToX = useCallback((time: number) => time * pixelsPerSecond, [pixelsPerSecond]);
  const xToTime = useCallback(
    (x: number) => Math.max(0, Math.min(x / pixelsPerSecond, duration)),
    [pixelsPerSecond, duration]
  );

  const handleTimelineClick = (e: React.MouseEvent) => {
    if (dragging || rulerDragging) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left + (containerRef.current?.scrollLeft || 0);
    const time = xToTime(x); // timeline time
    if (clipLayout.length > 0) {
      const result = timelineToSource(clipLayout, time);
      if (result && videoRef.current) videoRef.current.currentTime = result.sourceTime;
    } else if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
    setCurrentTime(time);
  };

  // Ruler scrub: mousedown on ruler starts drag-to-seek
  const handleRulerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRulerDragging(true);
    rulerWasPlayingRef.current = !!videoRef.current && !videoRef.current.paused;
    if (videoRef.current && !videoRef.current.paused) videoRef.current.pause();
    // Seek immediately to click position
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left + (containerRef.current?.scrollLeft || 0);
    const time = xToTime(x); // timeline time
    if (clipLayout.length > 0) {
      const result = timelineToSource(clipLayout, time);
      if (result && videoRef.current) videoRef.current.currentTime = result.sourceTime;
    } else if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
    setCurrentTime(time);
  };

  useEffect(() => {
    if (!rulerDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (e.buttons === 0) {
        // Mouse button is no longer held — the mouseup was missed
        // (released outside the window, app switch, …). End the drag.
        handleMouseUp();
        return;
      }
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left + (containerRef.current?.scrollLeft || 0);
      const time = xToTime(x); // timeline time
      if (clipLayout.length > 0) {
        const result = timelineToSource(clipLayout, time);
        if (result && videoRef.current) videoRef.current.currentTime = result.sourceTime;
      } else if (videoRef.current) {
        videoRef.current.currentTime = time;
      }
      setCurrentTime(time);
    };

    const handleMouseUp = () => {
      setRulerDragging(false);
      if (rulerWasPlayingRef.current && videoRef.current) {
        videoRef.current.play();
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [rulerDragging, xToTime, setCurrentTime, videoRef, clipLayout]);

  const handleSegmentMouseDown = (
    e: React.MouseEvent,
    seg: Segment,
    type: 'move' | 'resize-start' | 'resize-end'
  ) => {
    e.stopPropagation();
    e.preventDefault();
    setDragging({
      segmentId: seg.id,
      type,
      startX: e.clientX,
      originalStart: seg.start_time,
      originalEnd: seg.end_time,
    });
    setActiveSegment(seg.id);
  };

  useEffect(() => {
    if (!dragging) return;

    const snap = dragging; // stable snapshot of drag start state

    const handleMouseMove = (e: MouseEvent) => {
      if (e.buttons === 0) {
        handleMouseUp();
        return;
      }
      const pps = pixelsPerSecondRef.current;
      const dx = e.clientX - snap.startX;
      const dt = dx / pps;
      const srcDur = sourceDurationRef.current;

      let newStart = snap.originalStart;
      let newEnd = snap.originalEnd;

      if (snap.type === 'move') {
        const segDur = snap.originalEnd - snap.originalStart;
        newStart = Math.max(0, snap.originalStart + dt);
        newEnd = newStart + segDur;
        if (newEnd > srcDur) {
          newEnd = srcDur;
          newStart = newEnd - segDur;
        }
      } else if (snap.type === 'resize-start') {
        newStart = Math.max(0, Math.min(snap.originalStart + dt, snap.originalEnd - 0.5));
      } else if (snap.type === 'resize-end') {
        newEnd = Math.min(srcDur, Math.max(snap.originalEnd + dt, snap.originalStart + 0.5));
      }

      // Read latest project from store to avoid stale closure over currentProject
      const project = useProjectStore.getState().currentProject;
      if (project) {
        useProjectStore.setState({
          currentProject: {
            ...project,
            segments: project.segments.map((s) =>
              s.id === snap.segmentId
                ? { ...s, start_time: newStart, end_time: newEnd }
                : s
            ),
          },
        });
      }
    };

    const handleMouseUp = async () => {
      setDragging(null);
      // Read latest positions from store after all mousemove updates
      const project = useProjectStore.getState().currentProject;
      const seg = project?.segments.find((s) => s.id === snap.segmentId);
      if (seg) {
        await updateSegment(seg.id, {
          start_time: seg.start_time,
          end_time: seg.end_time,
        });
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging]); // no currentProject/pixelsPerSecond — read from refs/store instead

  // Clip resize drag handler
  const handleClipResizeDown = useCallback((
    e: React.MouseEvent,
    clip: VideoClip,
    type: 'resize-start' | 'resize-end'
  ) => {
    e.stopPropagation();
    e.preventDefault();
    pushUndo();
    setClipDragging({
      clipId: clip.id,
      type,
      startX: e.clientX,
      originalStart: clip.source_start,
      originalEnd: clip.source_end,
    });
    setSelectedClipId(clip.id);
  }, [pushUndo]);

  // Use refs to avoid stale closures during drag
  const videoClipsRef = useRef(videoClips);
  videoClipsRef.current = videoClips;
  const sourceDurationRef = useRef(sourceDuration);
  sourceDurationRef.current = sourceDuration;

  useEffect(() => {
    if (!clipDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (e.buttons === 0) {
        handleMouseUp();
        return;
      }
      const dx = e.clientX - clipDragging.startX;
      const dt = dx / pixelsPerSecond;
      const clipId = clipDragging.clipId;
      const clips = videoClipsRef.current;

      let newStart = clipDragging.originalStart;
      let newEnd = clipDragging.originalEnd;

      // Find neighboring clips for boundary constraints
      const sorted = [...clips].sort((a, b) => a.source_start - b.source_start);
      const clipIdx = sorted.findIndex(c => c.id === clipId);
      const prevClip = clipIdx > 0 ? sorted[clipIdx - 1] : null;
      const nextClip = clipIdx < sorted.length - 1 ? sorted[clipIdx + 1] : null;

      if (clipDragging.type === 'resize-start') {
        const minStart = prevClip ? prevClip.source_end : 0;
        newStart = Math.max(minStart, Math.min(clipDragging.originalStart + dt, clipDragging.originalEnd - 0.1));
      } else {
        const maxEnd = nextClip ? nextClip.source_start : sourceDurationRef.current;
        newEnd = Math.max(clipDragging.originalStart + 0.1, Math.min(clipDragging.originalEnd + dt, maxEnd));
      }

      setVideoClips(clips.map(c =>
        c.id === clipId ? { ...c, source_start: newStart, source_end: newEnd } : c
      ));
    };

    const handleMouseUp = async () => {
      const clip = videoClipsRef.current.find(c => c.id === clipDragging.clipId);
      if (clip && currentProject) {
        try {
          await updateVideoClip(currentProject.id, clip.id, clip.source_start, clip.source_end);
        } catch (err: any) {
          console.error('Clip resize save failed:', err?.response?.data?.detail || err?.message);
          undoStackRef.current.pop();
        }
      }
      setClipDragging(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [clipDragging, pixelsPerSecond, currentProject, setVideoClips]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const playheadX = timeToX(currentTime);
    const viewLeft = container.scrollLeft;
    const viewRight = viewLeft + container.clientWidth;
    if (playheadX < viewLeft + 50 || playheadX > viewRight - 50) {
      container.scrollLeft = playheadX - container.clientWidth / 3;
    }
  }, [currentTime, timeToX]);

  // Close audio panel on outside click
  useEffect(() => {
    if (!showAudioPanel) return;
    const handleClick = (e: MouseEvent) => {
      if (audioPanelRef.current && !audioPanelRef.current.contains(e.target as Node)) {
        setShowAudioPanel(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showAudioPanel]);

  const handleOpenAudioPanel = () => {
    setAudioGenerated(false);
    setShowAudioPanel(prev => !prev);
  };

  const handleGenerateVoice = async () => {
    if (!currentProject || segments.length === 0) return;
    setAudioGenerating(true);
    setAudioGenerated(false);
    try {
      const ids = selectedSegmentIds.size > 0 ? Array.from(selectedSegmentIds) : undefined;
      await generateVoiceForSegments(ids);
      setAudioGenerated(true);
      setTimeout(() => setAudioGenerated(false), 3000);
    } catch (err) {
      console.error('Generate voice failed:', err);
    } finally {
      setAudioGenerating(false);
    }
  };

  // --- Editing tool handlers ---

  const handleFlip = async (direction: 'horizontal' | 'vertical') => {
    if (!currentProject || isFlipping) return;
    setIsFlipping(true);
    try {
      await flipVideo(currentProject.id, direction);
      await loadProject(currentProject.id);
      setShowFlipPanel(false);
    } catch (err: any) {
      console.error('Flip failed:', err);
    }
    setIsFlipping(false);
  };

  const handleRotate = async (angle: number) => {
    if (!currentProject || isRotating) return;
    setIsRotating(true);
    try {
      await rotateVideo(currentProject.id, angle);
      await loadProject(currentProject.id);
      setShowRotatePanel(false);
    } catch (err: any) {
      console.error('Rotate failed:', err);
    }
    setIsRotating(false);
  };

  const handleSpeedChange = async (speed: number) => {
    if (!currentProject || isChangingSpeed) return;
    setIsChangingSpeed(true);
    try {
      await changeVideoSpeed(currentProject.id, speed);
      await loadProject(currentProject.id);
      setShowSpeedPanel(false);
    } catch (err: any) {
      console.error('Speed change failed:', err);
    }
    setIsChangingSpeed(false);
  };

  const handleAddSegmentAtPlayhead = async () => {
    if (!currentProject) return;
    let sourceTime = currentTime;
    if (clipLayout.length > 0) {
      const result = timelineToSource(clipLayout, currentTime);
      if (result) sourceTime = result.sourceTime;
    }
    const segStart = sourceTime;
    const segEnd = Math.min(segStart + 3, sourceDuration);
    await addSegment({ start_time: segStart, end_time: segEnd, text: '', speaker: 'Speaker 1' });
  };

  const handleOpenCrop = () => {
    // Default crop to full video dimensions from the video element
    const vid = videoRef.current;
    if (vid) {
      setCropX(0);
      setCropY(0);
      setCropW(vid.videoWidth);
      setCropH(vid.videoHeight);
    } else {
      setCropX(0);
      setCropY(0);
      setCropW(1920);
      setCropH(1080);
    }
    setShowCropModal(true);
  };

  const handleCrop = async () => {
    if (!currentProject || isCropping) return;
    setIsCropping(true);
    try {
      const result = await cropVideo(currentProject.id, cropX, cropY, cropW, cropH);
      await updateProject(currentProject.id, { video_path: result.video_path });
      window.location.reload();
    } catch (err: any) {
      console.error('Crop failed:', err);
    }
    setIsCropping(false);
    setShowCropModal(false);
  };

  const handleFitToView = useCallback(() => {
    if (!containerRef.current || duration <= 0) return;
    const viewWidth = containerRef.current.clientWidth - 20;
    const idealPPS = viewWidth / duration;
    const idealZoom = idealPPS / 20;
    setZoom(Math.max(0.5, Math.min(20, +idealZoom.toFixed(1))));
    containerRef.current.scrollLeft = 0;
  }, [duration]);

  // Ctrl+wheel zoom on the timeline
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const pointerX = e.clientX - rect.left;
      const scrollLeft = el.scrollLeft;
      const pointerTime = (pointerX + scrollLeft) / (20 * zoom);
      const step = e.deltaY < 0 ? 0.5 : -0.5;
      const newZoom = Math.max(0.5, Math.min(20, +(zoom + step).toFixed(1)));
      setZoom(newZoom);
      // Keep the time under the pointer in the same screen position
      requestAnimationFrame(() => {
        el.scrollLeft = pointerTime * (20 * newZoom) - pointerX;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom]);

  // Close flip/rotate/speed panels on outside click
  useEffect(() => {
    if (!showFlipPanel && !showRotatePanel && !showSpeedPanel) return;
    const handleClick = (e: MouseEvent) => {
      if (showFlipPanel && flipPanelRef.current && !flipPanelRef.current.contains(e.target as Node)) setShowFlipPanel(false);
      if (showRotatePanel && rotatePanelRef.current && !rotatePanelRef.current.contains(e.target as Node)) setShowRotatePanel(false);
      if (showSpeedPanel && speedPanelRef.current && !speedPanelRef.current.contains(e.target as Node)) setShowSpeedPanel(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showFlipPanel, showRotatePanel, showSpeedPanel]);

  // Time markers
  const markerInterval = zoom >= 4 ? 1 : zoom >= 2 ? 5 : zoom >= 1 ? 10 : 30;
  const markers: number[] = [];
  for (let t = 0; t <= duration; t += markerInterval) markers.push(t);

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 100);
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  const TRACK_HEIGHT = 52;
  const VIDEO_TRACK_HEIGHT = 72;
  const TRACK_LABEL_W = 80;

  const toggleLock = (t: string) => {
    setLockedTracks(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; });
  };
  const toggleHidden = (t: string) => {
    setHiddenTracks(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; });
  };

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: 'var(--bg-panel)' }}>
      {/* CapCut-style Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1 border-b border-zinc-700/50 shrink-0" style={{ backgroundColor: 'var(--bg-hover)' }}>
        {/* Select tool */}
        <button className="p-1.5 rounded hover:bg-zinc-700/50 text-zinc-400 hover:text-white transition-colors" title="Select">
          <MousePointer2 className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-zinc-700/50 mx-0.5" />

        {/* Undo / Redo */}
        <button
          onClick={handleUndo}
          disabled={undoStackRef.current.length === 0}
          className="p-1.5 rounded hover:bg-zinc-700/50 text-zinc-400 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Undo (Ctrl+Z)"
        >
          <Undo2 className="w-4 h-4" />
        </button>
        <button
          onClick={handleRedo}
          disabled={redoStackRef.current.length === 0}
          className="p-1.5 rounded hover:bg-zinc-700/50 text-zinc-400 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Redo (Ctrl+Shift+Z)"
        >
          <Redo2 className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-zinc-700/50 mx-0.5" />

        {/* Split */}
        <button
          onClick={handleSplitAtPlayhead}
          disabled={!currentProject?.video_path || videoClips.length === 0 || splitProcessing}
          className="p-1.5 rounded hover:bg-zinc-700/50 text-zinc-400 hover:text-white transition-colors disabled:opacity-30"
          title="Split at playhead (S)"
        >
          {splitProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scissors className="w-4 h-4" />}
        </button>

        {/* Delete */}
        <button
          onClick={() => {
            if (selectedClipId && videoClips.length > 1) {
              handleDeleteClip(selectedClipId);
            } else if (activeSegmentId) {
              handleDeleteSegment(activeSegmentId);
            }
          }}
          disabled={!(selectedClipId && videoClips.length > 1) && !activeSegmentId}
          className="p-1.5 rounded hover:bg-zinc-700/50 text-zinc-400 hover:text-white transition-colors disabled:opacity-30"
          title="Delete selected (Delete)"
        >
          <Trash2 className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-zinc-700/50 mx-0.5" />

        {/* Flip — dropdown */}
        <div className="relative" ref={flipPanelRef}>
          <button
            onClick={() => { setShowFlipPanel(!showFlipPanel); setShowRotatePanel(false); setShowSpeedPanel(false); }}
            disabled={!currentProject?.video_path || isFlipping}
            className={`p-1.5 rounded transition-colors ${showFlipPanel ? 'bg-zinc-600/70 text-white' : 'hover:bg-zinc-700/50 text-zinc-400 hover:text-white'} disabled:opacity-30`}
            title="Flip video"
          >
            {isFlipping ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlipHorizontal className="w-4 h-4" />}
          </button>
          {showFlipPanel && (
            <div className="absolute left-0 top-full mt-1 w-36 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl z-50 p-1.5 space-y-0.5">
              <button
                onClick={() => handleFlip('horizontal')}
                disabled={isFlipping}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-[11px] text-zinc-300 hover:bg-zinc-700/60 hover:text-white transition-colors disabled:opacity-40"
              >
                <FlipHorizontal className="w-3.5 h-3.5" /> Horizontal
              </button>
              <button
                onClick={() => handleFlip('vertical')}
                disabled={isFlipping}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-[11px] text-zinc-300 hover:bg-zinc-700/60 hover:text-white transition-colors disabled:opacity-40"
              >
                <FlipVertical className="w-3.5 h-3.5" /> Vertical
              </button>
            </div>
          )}
        </div>

        {/* Rotate — dropdown */}
        <div className="relative" ref={rotatePanelRef}>
          <button
            onClick={() => { setShowRotatePanel(!showRotatePanel); setShowFlipPanel(false); setShowSpeedPanel(false); }}
            disabled={!currentProject?.video_path || isRotating}
            className={`p-1.5 rounded transition-colors ${showRotatePanel ? 'bg-zinc-600/70 text-white' : 'hover:bg-zinc-700/50 text-zinc-400 hover:text-white'} disabled:opacity-30`}
            title="Rotate video"
          >
            {isRotating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />}
          </button>
          {showRotatePanel && (
            <div className="absolute left-0 top-full mt-1 w-44 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl z-50 p-1.5 space-y-0.5">
              <button
                onClick={() => handleRotate(90)}
                disabled={isRotating}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-[11px] text-zinc-300 hover:bg-zinc-700/60 hover:text-white transition-colors disabled:opacity-40"
              >
                <RotateCw className="w-3.5 h-3.5" /> 90° Clockwise
              </button>
              <button
                onClick={() => handleRotate(-90)}
                disabled={isRotating}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-[11px] text-zinc-300 hover:bg-zinc-700/60 hover:text-white transition-colors disabled:opacity-40"
              >
                <RotateCcw className="w-3.5 h-3.5" /> 90° Counter-CW
              </button>
              <button
                onClick={() => handleRotate(180)}
                disabled={isRotating}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-[11px] text-zinc-300 hover:bg-zinc-700/60 hover:text-white transition-colors disabled:opacity-40"
              >
                <RotateCw className="w-3.5 h-3.5" /> 180°
              </button>
            </div>
          )}
        </div>

        {/* Speed — dropdown */}
        <div className="relative" ref={speedPanelRef}>
          <button
            onClick={() => { setShowSpeedPanel(!showSpeedPanel); setShowFlipPanel(false); setShowRotatePanel(false); }}
            disabled={!currentProject?.video_path || isChangingSpeed}
            className={`p-1.5 rounded transition-colors ${showSpeedPanel ? 'bg-zinc-600/70 text-white' : 'hover:bg-zinc-700/50 text-zinc-400 hover:text-white'} disabled:opacity-30`}
            title="Change speed"
          >
            {isChangingSpeed ? <Loader2 className="w-4 h-4 animate-spin" /> : <Gauge className="w-4 h-4" />}
          </button>
          {showSpeedPanel && (
            <div className="absolute left-0 top-full mt-1 w-40 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl z-50 p-1.5">
              <p className="text-[9px] text-zinc-500 px-2 pb-1 uppercase tracking-wider">Playback Speed</p>
              <div className="grid grid-cols-3 gap-0.5">
                {[0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 3.0].map(s => (
                  <button
                    key={s}
                    onClick={() => handleSpeedChange(s)}
                    disabled={isChangingSpeed}
                    className={`px-2 py-1.5 rounded text-[11px] font-medium transition-colors disabled:opacity-40 ${
                      s === 1.0
                        ? 'bg-khmer-700/60 text-khmer-200 hover:bg-khmer-600/60'
                        : 'text-zinc-300 hover:bg-zinc-700/60 hover:text-white'
                    }`}
                  >
                    {s}x
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="w-px h-4 bg-zinc-700/50 mx-0.5" />

        {/* Crop */}
        <button
          onClick={handleOpenCrop}
          disabled={!currentProject?.video_path || isCropping}
          className="p-1.5 rounded hover:bg-zinc-700/50 text-zinc-400 hover:text-white transition-colors disabled:opacity-30"
          title="Crop video"
        >
          {isCropping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Crop className="w-4 h-4" />}
        </button>
        <div className="w-px h-4 bg-zinc-700/50 mx-0.5" />

        {/* Fit to view */}
        <button
          onClick={handleFitToView}
          disabled={!currentProject?.video_path}
          className="p-1.5 rounded hover:bg-zinc-700/50 text-zinc-400 hover:text-white transition-colors disabled:opacity-30"
          title="Fit timeline to view"
        >
          <ZoomIn className="w-4 h-4" />
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right side: Transcribe, Generate Audio */}
        <div className="flex items-center gap-1.5">

          {/* Language selector */}
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-800/60">
            <Languages className="w-3 h-3 text-blue-400" />
            <select
              value={currentProject?.language || 'km'}
              onChange={async (e) => {
                if (!currentProject) return;
                await updateProject(currentProject.id, { language: e.target.value });
                loadProject(currentProject.id);
              }}
              className="bg-transparent text-[10px] text-zinc-300 outline-none cursor-pointer pr-1"
            >
              <option value="km">ខ្មែរ (Khmer)</option>
              <option value="en">English</option>
              <option value="zh">中文 (Chinese)</option>
              <option value="ja">日本語 (Japanese)</option>
              <option value="ko">한국어 (Korean)</option>
              <option value="th">ไทย (Thai)</option>
              <option value="vi">Tiếng Việt</option>
              <option value="fr">Français</option>
              <option value="es">Español</option>
              <option value="de">Deutsch</option>
              <option value="pt">Português</option>
              <option value="ru">Русский</option>
              <option value="ar">العربية</option>
              <option value="hi">हिन्दी</option>
              <option value="id">Bahasa Indonesia</option>
              <option value="ms">Bahasa Melayu</option>
            </select>
          </div>

          {/* Transcribe */}
          {isTranscribing ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-emerald-400 animate-pulse">
                {transcribeProgress || 'Transcribing...'}
              </span>
              <button
                onClick={() => cancelTranscription()}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-red-700/80 hover:bg-red-600 text-white transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => generateTranscript()}
              disabled={!currentProject?.video_path}
              className="flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-medium bg-emerald-700/80 hover:bg-emerald-600 text-white transition-colors disabled:opacity-40"
            >
              <Sparkles className="w-3 h-3" />
              Transcribe
            </button>
          )}

          {/* Generate Audio */}
          <div className="relative" ref={audioPanelRef}>
            <button
              disabled={segments.length === 0}
              onClick={handleOpenAudioPanel}
              className={`flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
                showAudioPanel
                  ? 'bg-khmer-700 text-white'
                  : 'bg-zinc-700/80 hover:bg-zinc-600 text-zinc-300'
              } disabled:opacity-30`}
            >
              <AudioLines className="w-3 h-3" />
              {selectedSegmentIds.size > 0 ? `Generate (${selectedSegmentIds.size})` : 'Generate Audio'}
              <ChevronDown className={`w-2.5 h-2.5 transition-transform ${showAudioPanel ? 'rotate-180' : ''}`} />
            </button>

            {/* Dropdown panel */}
            {showAudioPanel && (
              <div className="absolute right-0 top-full mt-1 w-80 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl z-50 p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-zinc-200">
                    {selectedSegmentIds.size > 0 ? `Generate Voice (${selectedSegmentIds.size} selected)` : 'Generate Voice from Subtitles'}
                  </span>
                  <button onClick={() => setShowAudioPanel(false)} className="p-0.5 rounded hover:bg-zinc-700">
                    <X className="w-3.5 h-3.5 text-zinc-400" />
                  </button>
                </div>
                <p className="text-[10px] text-zinc-400 leading-relaxed">
                  {selectedSegmentIds.size > 0
                    ? `AI will generate voice audio for ${selectedSegmentIds.size} selected segment(s). Audio appears in the AI track(s) below.`
                    : 'AI will generate voice audio for all subtitle segments. Audio appears in the AI track(s) below.'}
                </p>
                <div className="max-h-32 overflow-y-auto space-y-1 bg-zinc-800/50 rounded-md p-2">
                  {segments.slice(0, 10).map((seg, i) => (
                    <div key={seg.id} className="flex items-start gap-2 text-[10px]">
                      <span className="text-zinc-500 shrink-0 w-4">{i + 1}.</span>
                      <span className={`shrink-0 px-1 rounded ${seg.voice_profile === 'male' ? 'bg-blue-900/40 text-blue-300' : 'bg-pink-900/40 text-pink-300'}`}>
                        {seg.voice_profile === 'male' ? '♂' : '♀'}
                      </span>
                      <span className="text-zinc-300 font-khmer truncate">{seg.text}</span>
                      {seg.audio_url && <span className="text-emerald-400 shrink-0">✓</span>}
                    </div>
                  ))}
                  {segments.length > 10 && (
                    <p className="text-[10px] text-zinc-500 text-center">... and {segments.length - 10} more segments</p>
                  )}
                </div>
                <div className="text-[10px] text-zinc-500">
                  {segments.length} segments · {segments.filter(s => s.voice_profile === 'female').length} female · {segments.filter(s => s.voice_profile === 'male').length} male
                  {segments.filter(s => s.audio_url).length > 0 && (
                    <span className="text-emerald-400"> · {segments.filter(s => s.audio_url).length} generated</span>
                  )}
                </div>
                <button
                  onClick={handleGenerateVoice}
                  disabled={audioGenerating || segments.length === 0}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-medium bg-khmer-700 hover:bg-khmer-600 text-white transition-colors disabled:opacity-40"
                >
                  {audioGenerating ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating voice...</>
                  ) : audioGenerated ? (
                    <><Check className="w-3.5 h-3.5" /> Generated!</>
                  ) : (
                    <><AudioLines className="w-3.5 h-3.5" /> {selectedSegmentIds.size > 0 ? `Generate Voice (${selectedSegmentIds.size})` : 'Generate AI Voice'}</>
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Zoom */}
          <div className="flex items-center gap-1 ml-1">
            <button
              onClick={() => setZoom(prev => Math.max(0.5, +(prev - 0.5).toFixed(1)))}
              className="p-0.5 rounded hover:bg-zinc-700/60 text-zinc-400 hover:text-zinc-200 transition-colors"
              title="Zoom Out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <input
              type="range"
              min={0.5}
              max={20}
              step={0.5}
              value={zoom}
              onChange={(e) => setZoom(parseFloat(e.target.value))}
              className="w-16 h-1 accent-khmer-500 cursor-pointer"
            />
            <button
              onClick={() => setZoom(prev => Math.min(20, +(prev + 0.5).toFixed(1)))}
              className="p-0.5 rounded hover:bg-zinc-700/60 text-zinc-400 hover:text-zinc-200 transition-colors"
              title="Zoom In"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <span className="text-[9px] text-zinc-500 min-w-[28px]">{Math.round(zoom * 100)}%</span>
          </div>
        </div>
      </div>

      {/* Timeline body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Track labels */}
        <div
          className="shrink-0 border-r border-zinc-700/40 overflow-y-auto"
          style={{ width: TRACK_LABEL_W, backgroundColor: 'var(--bg-panel)' }}
        >
          {/* Time ruler spacer */}
          <div className="h-7 border-b border-zinc-700/40" />

          {/* V — Video Track */}
          <div
            className="flex items-center justify-between px-1.5 border-b border-zinc-700/30 group"
            style={{ height: VIDEO_TRACK_HEIGHT }}
          >
            <div className="flex items-center gap-1">
              <Film className="w-3 h-3 text-teal-400" />
              <span className="text-[10px] font-bold text-teal-400">Video</span>
            </div>
            <div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
              <button onClick={() => toggleLock('V')} className="p-0.5 rounded hover:bg-zinc-700/50" title="Lock track">
                {lockedTracks.has('V') ? <Lock className="w-2.5 h-2.5 text-yellow-400" /> : <Unlock className="w-2.5 h-2.5 text-zinc-500" />}
              </button>
              <button onClick={() => toggleHidden('V')} className="p-0.5 rounded hover:bg-zinc-700/50" title="Hide track">
                {hiddenTracks.has('V') ? <EyeOff className="w-2.5 h-2.5 text-red-400" /> : <Eye className="w-2.5 h-2.5 text-zinc-500" />}
              </button>
              <button
                onClick={() => setA2Muted(!a2Muted)}
                className="p-0.5 rounded hover:bg-zinc-700/50"
                title="Mute video audio"
              >
                {a2Muted ? <VolumeX className="w-2.5 h-2.5 text-red-400" /> : <Volume2 className="w-2.5 h-2.5 text-zinc-500" />}
              </button>
              <button className="p-0.5 rounded hover:bg-zinc-700/50">
                <MoreHorizontal className="w-2.5 h-2.5 text-zinc-500" />
              </button>
            </div>
          </div>

          {/* T tracks */}
          {Array.from({ length: laneCount }, (_, i) => (
            <div
              key={`t-label-${i}`}
              className="flex items-center justify-between px-1.5 border-b border-zinc-700/30 group"
              style={{ height: TRACK_HEIGHT }}
            >
              <span className="text-[10px] font-bold text-emerald-400">T{i + 1}</span>
              <div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => toggleTrackMute(i)}
                  className="p-0.5 rounded hover:bg-zinc-700/50"
                >
                  {mutedTracks.has(i) ? <VolumeX className="w-2.5 h-2.5 text-red-400" /> : <Volume2 className="w-2.5 h-2.5 text-zinc-500" />}
                </button>
              </div>
            </div>
          ))}

          {/* A1, A2... — AI Audio per voice_profile */}
          {aiTrackProfiles.map((profile, idx) => {
            const isMuted = aiMutedProfiles.has(profile);
            const label = profile === '_all'
              ? 'A1 AI'
              : `A${idx + 1} AI ${profile === 'male' ? '♂' : '♀'}`;
            return (
              <div
                key={`ai-label-${profile}`}
                className="flex items-center justify-between px-1.5 border-b border-zinc-700/30 group"
                style={{ height: TRACK_HEIGHT }}
              >
                <span className="text-[10px] font-bold text-cyan-400">{label}</span>
                <button
                  onClick={() => toggleAiTrackMute(profile)}
                  className="p-0.5 rounded hover:bg-zinc-700/50 opacity-60 group-hover:opacity-100"
                >
                  {isMuted ? <VolumeX className="w-2.5 h-2.5 text-red-400" /> : <Volume2 className="w-2.5 h-2.5 text-zinc-500" />}
                </button>
              </div>
            );
          })}

          {/* V1 — Vocals (only shown after isolation) */}
          {audioSeparated && (
            <div
              className="flex items-center justify-between px-1.5 border-b border-zinc-700/30 group"
              style={{ height: TRACK_HEIGHT }}
            >
              <div className="flex items-center gap-1">
                <Mic className="w-2.5 h-2.5 text-blue-400" />
                <span className="text-[10px] font-bold text-blue-400">V1</span>
              </div>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => setV1Muted(!v1Muted)}
                  className="p-0.5 rounded hover:bg-zinc-700/50 opacity-60 group-hover:opacity-100"
                >
                  {v1Muted ? <VolumeX className="w-2.5 h-2.5 text-red-400" /> : <Volume2 className="w-2.5 h-2.5 text-zinc-500" />}
                </button>
                <button
                  onClick={() => { if (confirm('Remove isolated vocals & BGM?')) onRemoveAudioSeparation?.(); }}
                  className="p-0.5 rounded hover:bg-red-900/40 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Remove isolated audio"
                >
                  <Trash2 className="w-2.5 h-2.5 text-red-400" />
                </button>
              </div>
            </div>
          )}

          {/* B1 — BGM (only shown after isolation) */}
          {audioSeparated && (
            <div
              className="flex items-center justify-between px-1.5 border-b border-zinc-700/30 group"
              style={{ height: TRACK_HEIGHT }}
            >
              <div className="flex items-center gap-1">
                <Music className="w-2.5 h-2.5 text-amber-400" />
                <span className="text-[10px] font-bold text-amber-400">B1</span>
              </div>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => setB1Muted(!b1Muted)}
                  className="p-0.5 rounded hover:bg-zinc-700/50 opacity-60 group-hover:opacity-100"
                >
                  {b1Muted ? <VolumeX className="w-2.5 h-2.5 text-red-400" /> : <Volume2 className="w-2.5 h-2.5 text-zinc-500" />}
                </button>
                <button
                  onClick={() => { if (confirm('Remove isolated vocals & BGM?')) onRemoveAudioSeparation?.(); }}
                  className="p-0.5 rounded hover:bg-red-900/40 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Remove isolated audio"
                >
                  <Trash2 className="w-2.5 h-2.5 text-red-400" />
                </button>
              </div>
            </div>
          )}

        </div>

        {/* Scrollable timeline */}
        <div
          ref={containerRef}
          className="flex-1 overflow-auto relative select-none"
          onClick={handleTimelineClick}
        >
          <div className="relative" style={{ width: totalWidth, minHeight: '100%' }}>
            {/* Time ruler — click or drag to scrub */}
            <div
              className="h-7 border-b border-zinc-700/40 relative cursor-pointer" style={{ backgroundColor: 'var(--bg-hover)' } as React.CSSProperties}
              onMouseDown={handleRulerMouseDown}
            >
              {markers.map((t) => (
                <div
                  key={t}
                  className="absolute top-0 h-full flex flex-col items-center pointer-events-none"
                  style={{ left: timeToX(t) }}
                >
                  <span className="text-[9px] text-zinc-500 mt-1.5 whitespace-nowrap font-mono">
                    {fmtTime(t)}
                  </span>
                  <div className="flex-1 w-px bg-zinc-700/30" />
                </div>
              ))}
              {/* Playhead handle on ruler — draggable */}
              <div
                className="absolute bottom-0 z-30 cursor-grab active:cursor-grabbing"
                style={{ left: timeToX(currentTime), padding: '0 6px', marginLeft: '-6px' }}
                onMouseDown={(e) => {
                  // Same as ruler drag, but initiated from handle
                  handleRulerMouseDown(e);
                }}
              >
                <div
                  className="w-0 h-0 -translate-x-[5px]"
                  style={{
                    borderLeft: '6px solid transparent',
                    borderRight: '6px solid transparent',
                    borderTop: '8px solid var(--text-bright)',
                    filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))',
                  }}
                />
              </div>
            </div>

            {/* ──── V0 Track — Video Clips with Thumbnails ──── */}
            <div
              className={`relative border-b border-zinc-700/30 ${hiddenTracks.has('V') ? 'opacity-20' : ''}`}
              style={{ height: VIDEO_TRACK_HEIGHT }}
            >
              {/* Grid lines */}
              {markers.map((t) => (
                <div
                  key={`v0-grid-${t}`}
                  className="absolute top-0 bottom-0 w-px bg-zinc-700/15"
                  style={{ left: timeToX(t) }}
                />
              ))}

              {clipLayout.length > 0 ? (
                clipLayout.map((layoutItem) => {
                  const clip = layoutItem.clip;
                  const clipDuration = layoutItem.clipDuration;
                  const left = timeToX(layoutItem.timelineStart);
                  const width = Math.max(timeToX(layoutItem.timelineEnd) - left, 6);
                  const isSelected = clip.id === selectedClipId;

                  // Calculate which thumbnails belong to this clip (use source time for indexing)
                  const thumbsPerClip = thumbnails.length > 0
                    ? thumbnails.slice(
                        Math.floor((clip.source_start / sourceDuration) * thumbnails.length),
                        Math.ceil((clip.source_end / sourceDuration) * thumbnails.length)
                      )
                    : [];

                  // Show resize handles if clip is trimmed or there are multiple clips
                  const canResize = !lockedTracks.has('V') && (videoClips.length > 1 || clip.source_start > 0 || clip.source_end < sourceDuration);

                  return (
                    <div
                      key={clip.id}
                      className={`absolute top-2 rounded-md cursor-pointer transition-all group ${
                        isSelected ? 'ring-2 ring-teal-400 ring-offset-1 ring-offset-[#1a1b26]' : ''
                      }`}
                      style={{
                        left,
                        width,
                        height: VIDEO_TRACK_HEIGHT - 16,
                        border: `2px solid ${isSelected ? '#2dd4bf' : '#0d9488'}`,
                        background: 'var(--bg-base)',
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!lockedTracks.has('V')) setSelectedClipId(isSelected ? null : clip.id);
                      }}
                    >
                      {/* Left resize handle */}
                      {canResize && (
                        <div
                          className="absolute top-0 w-3 h-full cursor-col-resize z-20 hover:bg-teal-400/30 transition-colors"
                          style={{ left: -4 }}
                          onMouseDown={(e) => handleClipResizeDown(e, clip, 'resize-start')}
                        >
                          <div className="absolute top-1/2 left-1 -translate-y-1/2 w-0.5 h-5 bg-teal-400/60 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      )}

                      {/* Right resize handle */}
                      {canResize && (
                        <div
                          className="absolute top-0 w-3 h-full cursor-col-resize z-20 hover:bg-teal-400/30 transition-colors"
                          style={{ right: -4 }}
                          onMouseDown={(e) => handleClipResizeDown(e, clip, 'resize-end')}
                        >
                          <div className="absolute top-1/2 right-1 -translate-y-1/2 w-0.5 h-5 bg-teal-400/60 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      )}
                      {/* Label overlay */}
                      <div className="absolute top-0 left-0 right-0 z-10 px-2 py-0.5 bg-gradient-to-b from-black/70 to-transparent">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-teal-200 font-medium truncate">
                            {currentProject?.video_filename || 'Video'}
                          </span>
                          <span className="text-[9px] text-teal-300/60 font-mono whitespace-nowrap">
                            {fmtTime(clipDuration)}
                          </span>
                        </div>
                      </div>

                      {/* Thumbnail strip */}
                      <div className="flex h-full overflow-hidden rounded-md">
                        {thumbsPerClip.length > 0 ? (
                          thumbsPerClip.map((src, i) => (
                            <img
                              key={i}
                              src={src}
                              alt=""
                              className="h-full object-cover shrink-0"
                              style={{ width: `${100 / thumbsPerClip.length}%`, minWidth: 0 }}
                              draggable={false}
                            />
                          ))
                        ) : (
                          /* Gradient placeholder while thumbnails load */
                          <div className="w-full h-full bg-gradient-to-r from-teal-900/40 via-teal-800/20 to-teal-900/40 flex items-center justify-center">
                            <Film className="w-4 h-4 text-teal-400/30" />
                          </div>
                        )}
                      </div>

                      {/* Bottom waveform decoration bar */}
                      <div className="absolute bottom-0 left-0 right-0 h-2 bg-gradient-to-t from-teal-500/30 to-transparent" />

                      {/* Delete on hover (selected) */}
                      {isSelected && videoClips.length > 1 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!lockedTracks.has('V')) handleDeleteClip(clip.id);
                          }}
                          className="absolute top-0.5 right-0.5 p-0.5 rounded bg-red-900/80 text-red-200 opacity-0 group-hover:opacity-100 transition-opacity z-20"
                          title="Delete clip"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  );
                })
              ) : currentProject?.video_path ? (
                <div className="absolute top-2 rounded-md overflow-hidden" style={{
                  left: 0,
                  width: timeToX(duration),
                  height: VIDEO_TRACK_HEIGHT - 16,
                  border: '2px solid #0d9488',
                  background: 'var(--bg-base)',
                }}>
                  <div className="flex h-full overflow-hidden">
                    {thumbnails.length > 0 ? (
                      thumbnails.map((src, i) => (
                        <img
                          key={i}
                          src={src}
                          alt=""
                          className="h-full object-cover shrink-0"
                          style={{ width: `${100 / thumbnails.length}%`, minWidth: 0 }}
                          draggable={false}
                        />
                      ))
                    ) : (
                      <div className="w-full h-full bg-gradient-to-r from-teal-900/40 via-teal-800/20 to-teal-900/40 flex items-center justify-center">
                        <Film className="w-4 h-4 text-teal-400/30" />
                      </div>
                    )}
                  </div>
                  <div className="absolute top-0 left-0 right-0 z-10 px-2 py-0.5 bg-gradient-to-b from-black/70 to-transparent">
                    <span className="text-[10px] text-teal-200 font-medium">
                      {currentProject?.video_filename || 'Video'}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="px-3 py-2 flex items-center h-full">
                  <span className="text-[10px] text-zinc-500">No video loaded</span>
                </div>
              )}
            </div>

            {/* ──── Text Tracks: T1, T2... ──── */}
            {Array.from({ length: laneCount }, (_, laneIdx) => (
              <div
                key={`t-track-${laneIdx}`}
                className="relative border-b border-zinc-700/30"
                style={{ height: TRACK_HEIGHT }}
              >
                {markers.map((t) => (
                  <div
                    key={`t${laneIdx}-grid-${t}`}
                    className="absolute top-0 bottom-0 w-px bg-zinc-700/15"
                    style={{ left: timeToX(t) }}
                  />
                ))}

                {segments
                  .filter((seg) => laneMap.get(seg.id) === laneIdx)
                  .map((seg) => {
                    const segTlStart = clipLayout.length > 0 ? sourceToTimeline(clipLayout, seg.start_time) : seg.start_time;
                    const segTlEnd = clipLayout.length > 0 ? sourceToTimeline(clipLayout, seg.end_time) : seg.end_time;
                    const left = timeToX(segTlStart);
                    const width = Math.max(timeToX(segTlEnd) - left, 6);
                    const color = speakerColors[seg.speaker] || COLORS[0];
                    const isActive = seg.id === activeSegmentId;

                    return (
                      <div
                        key={seg.id}
                        className={`absolute top-1.5 rounded-md cursor-grab active:cursor-grabbing transition-all ${
                          isActive ? 'ring-2 ring-white/40' : ''
                        } ${mutedTracks.has(laneIdx) ? 'opacity-30' : ''}`}
                        style={{
                          left,
                          width,
                          height: TRACK_HEIGHT - 12,
                          backgroundColor: `${color}55`,
                          borderLeft: `3px solid ${color}`,
                          borderRadius: '6px',
                        }}
                        onMouseDown={(e) => handleSegmentMouseDown(e, seg, 'move')}
                      >
                        <div
                          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-white/20 rounded-l-md"
                          onMouseDown={(e) => handleSegmentMouseDown(e, seg, 'resize-start')}
                        />
                        {width > 30 && (
                          <div className="px-2 py-1 overflow-hidden h-full flex flex-col justify-center">
                            <p className="text-[10px] text-white/90 truncate font-khmer leading-tight">
                              {seg.text}
                            </p>
                            {seg.speaker && width > 80 && (
                              <p className="text-[8px] text-white/40 truncate">{seg.speaker}</p>
                            )}
                          </div>
                        )}
                        <div
                          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-white/20 rounded-r-md"
                          onMouseDown={(e) => handleSegmentMouseDown(e, seg, 'resize-end')}
                        />
                      </div>
                    );
                  })}
              </div>
            ))}

            {/* ──── AI Audio Tracks — one per voice_profile ──── */}
            {aiTrackProfiles.map((profile, trackIdx) => {
              const isMuted = aiMutedProfiles.has(profile);
              const trackSegs = profile === '_all'
                ? segments.filter(seg => seg.audio_url)
                : segments.filter(seg => seg.audio_url && (seg.voice_profile || 'female') === profile);
              const emptySegs = profile === '_all'
                ? segments.filter(s => s.audio_url).length === 0
                : trackSegs.length === 0;
              const trackLabel = profile === '_all' ? 'AI Audio' : `AI ${profile === 'male' ? '♂' : '♀'}`;
              return (
                <div
                  key={`ai-track-${profile}`}
                  className="relative border-b border-zinc-700/30"
                  style={{ height: TRACK_HEIGHT }}
                >
                  {markers.map((t) => (
                    <div
                      key={`a${trackIdx + 1}-grid-${t}`}
                      className="absolute top-0 bottom-0 w-px bg-zinc-700/15"
                      style={{ left: timeToX(t) }}
                    />
                  ))}

                  {trackSegs.map((seg) => {
                    const segTlStart = clipLayout.length > 0 ? sourceToTimeline(clipLayout, seg.start_time) : seg.start_time;
                    const segTlEnd = clipLayout.length > 0 ? sourceToTimeline(clipLayout, seg.end_time) : seg.end_time;
                    const left = timeToX(segTlStart);
                    const width = Math.max(timeToX(segTlEnd) - left, 6);
                    const isActive = seg.id === activeSegmentId;
                    return (
                      <div
                        key={`ai-${seg.id}`}
                        className={`absolute top-1.5 rounded-md transition-all ${
                          isActive ? 'ring-2 ring-white/40' : ''
                        } ${isMuted ? 'opacity-30' : ''}`}
                        style={{
                          left,
                          width,
                          height: TRACK_HEIGHT - 12,
                          background: seg.voice_profile === 'male'
                            ? 'linear-gradient(90deg, #1e40afaa, #3b82f688, #1e40afaa)'
                            : 'linear-gradient(90deg, #0e7490aa, #06b6d488, #0e7490aa)',
                          borderLeft: `3px solid ${seg.voice_profile === 'male' ? '#60a5fa' : '#22d3ee'}`,
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveSegment(seg.id);
                          if (videoRef.current) videoRef.current.currentTime = seg.start_time;
                          const tlTime = clipLayout.length > 0 ? sourceToTimeline(clipLayout, seg.start_time) : seg.start_time;
                          setCurrentTime(tlTime);
                        }}
                      >
                        <div className="px-1.5 py-0.5 flex items-center gap-1 h-full overflow-hidden">
                          <span className="text-[9px] text-cyan-200/80 whitespace-nowrap">
                            {seg.voice_profile === 'male' ? '♂' : '♀'}
                          </span>
                          {width > 50 && (
                            <span className="text-[9px] text-cyan-200/60 whitespace-nowrap">
                              {seg.audio_speed ? `${seg.audio_speed}x` : '1.0x'}
                            </span>
                          )}
                          {width > 80 && (
                            <span className="text-[9px] text-cyan-200/50 truncate font-khmer">
                              {seg.text}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {emptySegs && (
                    <div className="px-3 py-1 flex items-center h-full">
                      <span className="text-[10px] text-cyan-300/25">{trackLabel}</span>
                    </div>
                  )}
                </div>
              );
            })}

            {/* ──── Vocals Track (only shown after isolation) ──── */}
            {audioSeparated && (
              <div
                className="relative border-b border-zinc-700/30"
                style={{ height: TRACK_HEIGHT }}
              >
                {markers.map((t) => (
                  <div
                    key={`v1-grid-${t}`}
                    className="absolute top-0 bottom-0 w-px bg-zinc-700/15"
                    style={{ left: timeToX(t) }}
                  />
                ))}

                {currentProject?.video_path && (
                  <div
                    className={`absolute top-1.5 rounded-md transition-opacity ${v1Muted ? 'opacity-30' : ''}`}
                    style={{
                      left: 0,
                      width: timeToX(duration),
                      height: TRACK_HEIGHT - 12,
                      background: 'linear-gradient(90deg, #1d4ed855, #3b82f644, #1d4ed855)',
                      borderLeft: '3px solid #3b82f6',
                    }}
                  >
                    <div className="px-2 py-1 flex items-center gap-2 h-full">
                      <Mic className="w-3 h-3 text-blue-300/60" />
                      <span className="text-[10px] text-blue-300/60 whitespace-nowrap">
                        {v1Muted ? 'Muted' : 'Vocals'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ──── BGM Track (only shown after isolation) ──── */}
            {audioSeparated && (
              <div
                className="relative border-b border-zinc-700/30"
                style={{ height: TRACK_HEIGHT }}
              >
                {markers.map((t) => (
                  <div
                    key={`b1-grid-${t}`}
                    className="absolute top-0 bottom-0 w-px bg-zinc-700/15"
                    style={{ left: timeToX(t) }}
                  />
                ))}

                {currentProject?.video_path && (
                  <div
                    className={`absolute top-1.5 rounded-md transition-opacity ${b1Muted ? 'opacity-30' : ''}`}
                    style={{
                      left: 0,
                      width: timeToX(duration),
                      height: TRACK_HEIGHT - 12,
                      background: 'linear-gradient(90deg, #92400e55, #f59e0b44, #92400e55)',
                      borderLeft: '3px solid #f59e0b',
                    }}
                  >
                    <div className="px-2 py-1 flex items-center gap-2 h-full">
                      <Music className="w-3 h-3 text-amber-300/60" />
                      <span className="text-[10px] text-amber-300/60 whitespace-nowrap">
                        {b1Muted ? 'Muted' : 'BGM'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ──── Playhead — vertical line ──── */}
            <div
              className="absolute top-0 w-px z-20 pointer-events-none timeline-playhead"
              style={{
                left: timeToX(currentTime),
                height: 7 + VIDEO_TRACK_HEIGHT + TRACK_HEIGHT * (laneCount + 1 + (audioSeparated ? 2 : 0)),
              }}
            />
          </div>
        </div>
      </div>

      {/* Hidden audio elements for AI audio playback */}
      {segments.filter(s => s.audio_url).map(seg => {
        const profile = seg.voice_profile || 'female';
        const isMuted = aiTrackProfiles[0] === '_all'
          ? aiMutedProfiles.has('_all')
          : aiMutedProfiles.has(profile);
        return (
          <audio
            key={`ai-audio-${seg.id}`}
            ref={(el) => {
              if (el) aiAudioRefs.current.set(seg.id, el);
              else aiAudioRefs.current.delete(seg.id);
            }}
            src={seg.audio_url}
            preload="auto"
            muted={isMuted}
          />
        );
      })}

      {/* Crop Modal */}
      {showCropModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowCropModal(false)}>
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-md p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2"><Crop className="w-4 h-4" /> Crop Video</h3>
              <button onClick={() => setShowCropModal(false)} className="p-1 rounded hover:bg-zinc-700 transition-colors">
                <X className="w-4 h-4 text-zinc-400" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] text-zinc-400 uppercase tracking-wide block mb-1">X (left)</label>
                <input
                  type="number"
                  value={cropX}
                  onChange={(e) => setCropX(Math.max(0, parseInt(e.target.value) || 0))}
                  min={0}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
                />
              </div>
              <div>
                <label className="text-[11px] text-zinc-400 uppercase tracking-wide block mb-1">Y (top)</label>
                <input
                  type="number"
                  value={cropY}
                  onChange={(e) => setCropY(Math.max(0, parseInt(e.target.value) || 0))}
                  min={0}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
                />
              </div>
              <div>
                <label className="text-[11px] text-zinc-400 uppercase tracking-wide block mb-1">Width</label>
                <input
                  type="number"
                  value={cropW}
                  onChange={(e) => setCropW(Math.max(2, parseInt(e.target.value) || 2))}
                  min={2}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
                />
              </div>
              <div>
                <label className="text-[11px] text-zinc-400 uppercase tracking-wide block mb-1">Height</label>
                <input
                  type="number"
                  value={cropH}
                  onChange={(e) => setCropH(Math.max(2, parseInt(e.target.value) || 2))}
                  min={2}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
                />
              </div>
            </div>

            <p className="text-[10px] text-zinc-500">Crop region is measured in pixels from the top-left corner of the video.</p>

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setShowCropModal(false)}
                className="px-4 py-2 rounded-lg text-xs font-medium text-zinc-300 bg-zinc-700 hover:bg-zinc-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCrop}
                disabled={isCropping}
                className="px-4 py-2 rounded-lg text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {isCropping && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Crop
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
