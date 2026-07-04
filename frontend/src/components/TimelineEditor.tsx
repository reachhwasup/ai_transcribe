import { useRef, useState, useCallback, useEffect, RefObject } from 'react';
import { useProjectStore } from '../stores/projectStore';
import type { Segment } from '../types';
import { ZoomIn, ZoomOut, SkipBack, SkipForward } from 'lucide-react';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
}

const COLORS = [
  '#3d8eff', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
];

export default function TimelineEditor({ videoRef }: Props) {
  const {
    currentProject,
    currentTime,
    activeSegmentId,
    setActiveSegment,
    updateSegment,
  } = useProjectStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [dragging, setDragging] = useState<{
    segmentId: string;
    type: 'move' | 'resize-start' | 'resize-end';
    startX: number;
    originalStart: number;
    originalEnd: number;
  } | null>(null);

  const duration = currentProject?.duration || 60;
  const segments = currentProject?.segments || [];
  const pixelsPerSecond = 20 * zoom;
  const totalWidth = duration * pixelsPerSecond;

  // Speaker color map
  const speakerColors: Record<string, string> = {};
  let colorIndex = 0;
  segments.forEach((s) => {
    if (s.speaker && !speakerColors[s.speaker]) {
      speakerColors[s.speaker] = COLORS[colorIndex % COLORS.length];
      colorIndex++;
    }
  });

  const timeToX = useCallback((time: number) => time * pixelsPerSecond, [pixelsPerSecond]);
  const xToTime = useCallback((x: number) => Math.max(0, Math.min(x / pixelsPerSecond, duration)), [pixelsPerSecond, duration]);

  // Handle seeking on timeline click
  const handleTimelineClick = (e: React.MouseEvent) => {
    if (dragging) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left + (containerRef.current?.scrollLeft || 0);
    const time = xToTime(x);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
  };

  // Drag handling
  const handleSegmentMouseDown = (e: React.MouseEvent, seg: Segment, type: 'move' | 'resize-start' | 'resize-end') => {
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

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - dragging.startX;
      const dt = dx / pixelsPerSecond;

      let newStart = dragging.originalStart;
      let newEnd = dragging.originalEnd;

      if (dragging.type === 'move') {
        const segDuration = dragging.originalEnd - dragging.originalStart;
        newStart = Math.max(0, dragging.originalStart + dt);
        newEnd = newStart + segDuration;
        if (newEnd > duration) {
          newEnd = duration;
          newStart = newEnd - segDuration;
        }
      } else if (dragging.type === 'resize-start') {
        newStart = Math.max(0, Math.min(dragging.originalStart + dt, dragging.originalEnd - 0.5));
      } else if (dragging.type === 'resize-end') {
        newEnd = Math.min(duration, Math.max(dragging.originalEnd + dt, dragging.originalStart + 0.5));
      }

      // Optimistically update in store
      const project = currentProject;
      if (project) {
        useProjectStore.setState({
          currentProject: {
            ...project,
            segments: project.segments.map((s) =>
              s.id === dragging.segmentId
                ? { ...s, start_time: newStart, end_time: newEnd }
                : s
            ),
          },
        });
      }
    };

    const handleMouseUp = async () => {
      if (dragging) {
        const seg = currentProject?.segments.find((s) => s.id === dragging.segmentId);
        if (seg) {
          await updateSegment(seg.id, {
            start_time: seg.start_time,
            end_time: seg.end_time,
          });
        }
      }
      setDragging(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, pixelsPerSecond, duration, currentProject]);

  // Auto-scroll playhead into view
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

  // Generate time markers
  const markerInterval = zoom >= 2 ? 5 : zoom >= 1 ? 10 : 30;
  const markers: number[] = [];
  for (let t = 0; t <= duration; t += markerInterval) {
    markers.push(t);
  }

  const formatMarkerTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: 'var(--bg-panel)' }}>
      {/* Timeline Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-1">
          <span className="text-xs text-zinc-500 mr-2">Timeline</span>
          <button
            onClick={() => {
              if (videoRef.current) {
                const seg = segments.find((s) => s.end_time <= currentTime);
                if (seg) videoRef.current.currentTime = seg.start_time;
              }
            }}
            className="p-1 hover:bg-zinc-800 rounded transition-colors"
            title="Previous segment"
          >
            <SkipBack className="w-3.5 h-3.5 text-zinc-400" />
          </button>
          <button
            onClick={() => {
              if (videoRef.current) {
                const seg = segments.find((s) => s.start_time > currentTime);
                if (seg) videoRef.current.currentTime = seg.start_time;
              }
            }}
            className="p-1 hover:bg-zinc-800 rounded transition-colors"
            title="Next segment"
          >
            <SkipForward className="w-3.5 h-3.5 text-zinc-400" />
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setZoom(Math.max(0.25, zoom / 1.5))}
            className="p-1 hover:bg-zinc-800 rounded transition-colors"
            title="Zoom out"
          >
            <ZoomOut className="w-3.5 h-3.5 text-zinc-400" />
          </button>
          <span className="text-[10px] text-zinc-500 min-w-[40px] text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom(Math.min(8, zoom * 1.5))}
            className="p-1 hover:bg-zinc-800 rounded transition-colors"
            title="Zoom in"
          >
            <ZoomIn className="w-3.5 h-3.5 text-zinc-400" />
          </button>
        </div>
      </div>

      {/* Timeline Canvas */}
      <div
        ref={containerRef}
        className="flex-1 overflow-x-auto overflow-y-hidden relative select-none"
        onClick={handleTimelineClick}
        onScroll={(e) => setScrollLeft((e.target as HTMLDivElement).scrollLeft)}
      >
        <div className="relative" style={{ width: `${totalWidth}px`, minHeight: '100%' }}>
          {/* Time markers */}
          <div className="h-6 border-b border-zinc-800 relative">
            {markers.map((t) => (
              <div
                key={t}
                className="absolute top-0 h-full flex flex-col items-center"
                style={{ left: `${timeToX(t)}px` }}
              >
                <span className="text-[9px] text-zinc-600 mt-0.5">{formatMarkerTime(t)}</span>
                <div className="flex-1 w-px bg-zinc-800" />
              </div>
            ))}
          </div>

          {/* Segment track */}
          <div className="relative h-[calc(100%-24px)]">
            {/* Track background grid lines */}
            {markers.map((t) => (
              <div
                key={`grid-${t}`}
                className="absolute top-0 bottom-0 w-px bg-zinc-800/40"
                style={{ left: `${timeToX(t)}px` }}
              />
            ))}

            {/* Segments */}
            <div className="absolute top-3 left-0 right-0" style={{ height: '50px' }}>
              {segments.map((seg) => {
                const left = timeToX(seg.start_time);
                const width = Math.max(timeToX(seg.end_time) - left, 4);
                const color = speakerColors[seg.speaker] || COLORS[0];
                const isActive = seg.id === activeSegmentId;

                return (
                  <div
                    key={seg.id}
                    className={`timeline-segment absolute top-0 h-full rounded-md cursor-grab active:cursor-grabbing ${
                      isActive ? 'active' : ''
                    }`}
                    style={{
                      left: `${left}px`,
                      width: `${width}px`,
                      backgroundColor: `${color}33`,
                      borderTop: `2px solid ${color}`,
                    }}
                    onMouseDown={(e) => handleSegmentMouseDown(e, seg, 'move')}
                  >
                    {/* Resize handle - start */}
                    <div
                      className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-white/20 rounded-l-md"
                      onMouseDown={(e) => handleSegmentMouseDown(e, seg, 'resize-start')}
                    />

                    {/* Label */}
                    {width > 40 && (
                      <div className="px-1.5 py-0.5 overflow-hidden">
                        <p className="text-[10px] text-white/80 truncate font-khmer">{seg.text}</p>
                        {seg.speaker && width > 80 && (
                          <p className="text-[9px] text-white/40 truncate">{seg.speaker}</p>
                        )}
                      </div>
                    )}

                    {/* Resize handle - end */}
                    <div
                      className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-white/20 rounded-r-md"
                      onMouseDown={(e) => handleSegmentMouseDown(e, seg, 'resize-end')}
                    />
                  </div>
                );
              })}
            </div>

            {/* Playhead */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-20 pointer-events-none"
              style={{ left: `${timeToX(currentTime)}px` }}
            >
              <div className="w-3 h-3 bg-red-500 rounded-full -translate-x-[5px] -translate-y-0.5" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
