import type { VideoClip } from '../types';

/**
 * CapCut-style clip time mapping.
 * Clips are laid out sequentially on the timeline (no gaps).
 * "Timeline time" = position on the editing timeline (0 → total clip duration).
 * "Source time" = position in the original video file.
 */

export interface ClipLayout {
  clip: VideoClip;
  timelineStart: number; // where this clip starts on the editing timeline
  timelineEnd: number;   // where this clip ends on the editing timeline
  clipDuration: number;  // source_end - source_start
}

/** Build the sequential layout for an ordered list of clips */
export function buildClipLayout(clips: VideoClip[]): ClipLayout[] {
  const sorted = [...clips].sort((a, b) => a.index - b.index);
  const layout: ClipLayout[] = [];
  let offset = 0;
  for (const clip of sorted) {
    const dur = clip.source_end - clip.source_start;
    layout.push({
      clip,
      timelineStart: offset,
      timelineEnd: offset + dur,
      clipDuration: dur,
    });
    offset += dur;
  }
  return layout;
}

/** Total duration of all clips combined (= timeline duration) */
export function totalTimelineDuration(clips: VideoClip[]): number {
  return clips.reduce((sum, c) => sum + (c.source_end - c.source_start), 0);
}

/** Convert timeline time → source time in the video file. Returns null if past all clips. */
export function timelineToSource(layout: ClipLayout[], timelineTime: number): { sourceTime: number; clipIndex: number } | null {
  for (let i = 0; i < layout.length; i++) {
    const l = layout[i];
    if (timelineTime >= l.timelineStart && timelineTime < l.timelineEnd) {
      const offset = timelineTime - l.timelineStart;
      return { sourceTime: l.clip.source_start + offset, clipIndex: i };
    }
  }
  // Exactly at end of last clip
  if (layout.length > 0) {
    const last = layout[layout.length - 1];
    if (Math.abs(timelineTime - last.timelineEnd) < 0.01) {
      return { sourceTime: last.clip.source_end, clipIndex: layout.length - 1 };
    }
  }
  return null;
}

/** Convert source time → timeline time. Finds the clip that contains sourceTime. */
export function sourceToTimeline(layout: ClipLayout[], sourceTime: number): number {
  for (const l of layout) {
    if (sourceTime >= l.clip.source_start && sourceTime <= l.clip.source_end) {
      const offset = sourceTime - l.clip.source_start;
      return l.timelineStart + offset;
    }
  }
  // If source time is between clips (in a gap), find the closest clip
  for (let i = 0; i < layout.length - 1; i++) {
    const curr = layout[i];
    const next = layout[i + 1];
    if (sourceTime >= curr.clip.source_end && sourceTime <= next.clip.source_start) {
      return curr.timelineEnd; // snap to end of current clip
    }
  }
  // Past all clips
  if (layout.length > 0) {
    return layout[layout.length - 1].timelineEnd;
  }
  return 0;
}

/** Find which clip layout entry a timeline time falls in */
export function findClipAtTimelineTime(layout: ClipLayout[], timelineTime: number): ClipLayout | null {
  for (const l of layout) {
    if (timelineTime >= l.timelineStart && timelineTime < l.timelineEnd) {
      return l;
    }
  }
  return null;
}

/**
 * Convert a source time range [sourceStart, sourceEnd] to timeline coordinates [timelineStart, timelineEnd].
 * Returns isVisible: false if the range is completely outside any active clips (e.g. cut/deleted portion of video).
 */
export function sourceRangeToTimeline(
  layout: ClipLayout[],
  sourceStart: number,
  sourceEnd: number
): { timelineStart: number; timelineEnd: number; isVisible: boolean } {
  if (layout.length === 0) {
    return { timelineStart: sourceStart, timelineEnd: sourceEnd, isVisible: true };
  }

  let bestStart: number | null = null;
  let bestEnd: number | null = null;

  for (const l of layout) {
    // Find overlap with this clip
    const overlapStart = Math.max(sourceStart, l.clip.source_start);
    const overlapEnd = Math.min(sourceEnd, l.clip.source_end);

    if (overlapStart < overlapEnd) {
      const mappedStart = l.timelineStart + (overlapStart - l.clip.source_start);
      const mappedEnd = l.timelineStart + (overlapEnd - l.clip.source_start);

      if (bestStart === null || mappedStart < bestStart) bestStart = mappedStart;
      if (bestEnd === null || mappedEnd > bestEnd) bestEnd = mappedEnd;
    }
  }

  if (bestStart !== null && bestEnd !== null) {
    return { timelineStart: bestStart, timelineEnd: Math.max(bestStart + 0.05, bestEnd), isVisible: true };
  }

  return { timelineStart: 0, timelineEnd: 0, isVisible: false };
}
