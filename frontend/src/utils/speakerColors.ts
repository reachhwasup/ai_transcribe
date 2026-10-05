/** One colour per speaker, in the order they first appear — the colours the timeline gives
 *  its caption clips, so a line in a list and its clip below are recognisably the same. */
const PALETTE = ['#3d8eff', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1'];

export function speakerColorMap(segments: { speaker?: string | null }[]): Record<string, string> {
  const found: Record<string, string> = {};
  let n = 0;
  for (const seg of segments) {
    if (seg.speaker && !found[seg.speaker]) found[seg.speaker] = PALETTE[n++ % PALETTE.length];
  }
  return found;
}
