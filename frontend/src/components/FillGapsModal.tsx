import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader2, Scan, Scissors, Search, X } from 'lucide-react';
import { fetchGapPlan, fetchDeadAirPlan, removeTimelineRanges, type CaptionGap, type GapPlan } from '../api/client';

const clock = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};

interface Props {
  projectId: string;
  videoSeconds: number;
  onClose: () => void;
  /**
   * What this dialog is for. The two lists are opposites — speech that has no caption, and
   * stretches where nobody speaks — and so are the actions, so each opens as its own dialog:
   * "fill" finds missing captions to transcribe, "cut" finds dead air to remove from the video.
   */
  mode: 'fill' | 'cut';
  /** Fill only: transcribe these stretches. */
  onConfirm?: (gaps: { start: number; end: number }[]) => void;
  /** Jump the player to a gap so it can be listened to before deciding. */
  onPreview?: (seconds: number) => void;
  /** Reload the project after the video has been cut. */
  onChanged?: () => void;
  /** Called just before the cut lands, so the timeline can snapshot the edit for Ctrl+Z. */
  onBeforeCut?: () => void;
}

export default function FillGapsModal({
  projectId,
  videoSeconds,
  onClose,
  onConfirm,
  onPreview,
  onChanged,
  mode,
  onBeforeCut,
}: Props) {
  const [plan, setPlan] = useState<GapPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [cutting, setCutting] = useState(false);
  const cut = mode === 'cut';

  /** Cut the selected stretches out of the video entirely — the recap use: drop the parts
   *  where nobody speaks so the finished video is tighter. */
  const removeFromVideo = async () => {
    if (!chosen.length || cutting) return;
    setCutting(true);
    try {
      const ranges = chosen.map((g) => ({ start: g.start, end: g.end }));
      const preview = await removeTimelineRanges(projectId, ranges, { dryRun: true });
      const splits = (preview.clips_after ?? 0) - (preview.clips_before ?? 0);
      const ok = confirm(
        `Cut ${chosen.length} ${chosen.length === 1 ? 'stretch' : 'stretches'} out of the video?\n\n` +
          `Each one is split off at both ends and the piece between is dropped:\n` +
          `  ${preview.clips_before ?? 1} ${preview.clips_before === 1 ? 'clip' : 'clips'} → ` +
          `${preview.clips_after ?? 1}` +
          (splits > 0 ? ` (${splits} new cut ${splits === 1 ? 'point' : 'points'})` : '') +
          `\n  Length: ${preview.timeline_before.toFixed(1)}s → ${preview.timeline_after.toFixed(1)}s ` +
          `(${preview.removed_seconds.toFixed(1)}s removed)\n` +
          `  Captions: ${preview.captions_kept} kept` +
          (preview.captions_dropped ? `, ${preview.captions_dropped} removed with the cut` : '') +
          `\n\nThe source file is untouched — this changes the edit, and everything after each ` +
          `cut moves earlier so the dub stays in sync. Ctrl+Z puts it back.`,
      );
      if (!ok) return;
      onBeforeCut?.();          // snapshot first, so Ctrl+Z can undo the whole cut
      const res = await removeTimelineRanges(projectId, ranges);
      onChanged?.();
      onClose();
      alert(
        `Removed ${res.removed_seconds.toFixed(1)}s across ` +
          `${(res.clips_after ?? 1) - 1} ${(res.clips_after ?? 1) - 1 === 1 ? 'cut' : 'cuts'}. ` +
          `Video is now ${res.timeline_after.toFixed(1)}s, ${res.captions_kept} captions kept. ` +
          `Ctrl+Z undoes it.`,
      );
    } catch (e: any) {
      setError(e?.response?.data?.detail || (e instanceof Error ? e.message : 'Could not cut the video'));
    } finally {
      setCutting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setPlan(null);
    setError(null);
    setSkipped(new Set());
    const load = cut ? fetchDeadAirPlan(projectId) : fetchGapPlan(projectId);
    load
      .then((p) => !cancelled && setPlan(p))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Scan failed'));
    return () => {
      cancelled = true;
    };
  }, [projectId, cut]);

  const chosen = useMemo(
    () => (plan?.gaps || []).filter((g) => !skipped.has(g.index)),
    [plan, skipped],
  );
  const chosenSeconds = chosen.reduce((t, g) => t + g.seconds, 0);

  const toggle = (index: number) =>
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const span = Math.max(1, plan?.video_seconds || videoSeconds || 1);

  const selectAll = () => setSkipped(new Set());
  const selectNone = () => setSkipped(new Set((plan?.gaps || []).map((g) => g.index)));
  // Stretches this short are usually a breath or a clipped syllable rather than a missed line
  const SHORT_GAP = 0.8;
  const shortCount = (plan?.gaps || []).filter((g) => g.seconds < SHORT_GAP).length;
  const skipShort = () =>
    setSkipped((prev) => {
      const next = new Set(prev);
      (plan?.gaps || []).forEach((g) => g.seconds < SHORT_GAP && next.add(g.index));
      return next;
    });

  // Rendered from a panel whose ancestors are transformed, which would otherwise box this
  // dialog inside that panel instead of the viewport.
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-xl rounded-2xl border border-[var(--s4)] bg-[var(--s2)] shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--s3)] shrink-0">
          <div className="flex items-start gap-3 min-w-0">
            <span className={`mt-0.5 p-2 rounded-lg shrink-0 ${cut ? 'bg-rose-500/10 text-rose-300' : 'bg-blue-500/10 text-blue-400'}`}>
              {cut ? <Scissors className="w-4 h-4" /> : <Scan className="w-4 h-4" />}
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-white">
                {cut ? 'Cut dead air' : 'Fill missing captions'}
              </h2>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                {plan
                  ? `${plan.total_gaps} stretches · ${plan.total_seconds.toFixed(1)}s`
                  : 'Scanning the timeline…'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-zinc-500 hover:text-white hover:bg-white/10 transition-colors shrink-0"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="px-5 pt-4 text-[11px] text-zinc-400 leading-relaxed shrink-0">
          {cut
            ? 'Stretches where nobody is speaking and no caption shows. Cutting them makes the video tighter; everything after each cut moves earlier.'
            : 'Stretches where someone seems to be speaking but there is no caption. Preview each one to check for dialogue, then transcribe the ones you tick.'}
        </p>

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          {!plan && !error && (
            <div className="flex items-center gap-2 py-8 justify-center text-xs text-zinc-500">
              <Loader2 className="w-4 h-4 animate-spin" /> {cut ? 'Looking for stretches where nobody speaks…' : 'Looking for speech without captions…'}
            </div>
          )}

          {error && (
            <p className="flex items-start gap-2 text-[11px] text-red-300 py-4">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
            </p>
          )}

          {plan && plan.total_gaps === 0 && (
            <p className="text-xs text-emerald-300 py-6 text-center">
              {cut ? 'No dead-air stretches detected.' : 'No uncovered speech detected. Quiet dialogue or missing words inside an existing caption may still need manual review.'}
            </p>
          )}

          {plan && plan.total_gaps > 0 && (
            <>
              {!plan.vocals_available && (
                <p className="flex items-start gap-2 text-[11px] text-amber-300/90">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  Vocals aren't isolated for this project, so these are the blank stretches
                  between captions rather than where speech actually is. Isolating vocals first
                  gives a far more accurate list.
                </p>
              )}

              {/* Where the gaps fall across the whole video */}
              <div className="relative h-7 rounded-lg bg-[var(--s1)] border border-[var(--s4)] overflow-hidden">
                {plan.gaps.map((g) => (
                  <span
                    key={g.index}
                    onClick={() => onPreview?.(g.start)}
                    title={`${clock(g.start)} – ${clock(g.end)}`}
                    className={`absolute top-0 bottom-0 cursor-pointer transition-colors ${
                      skipped.has(g.index) ? 'bg-zinc-600/40' : cut ? 'bg-rose-500/70 hover:bg-rose-400' : 'bg-blue-500/70 hover:bg-blue-400'
                    }`}
                    style={{
                      left: `${(g.start / span) * 100}%`,
                      width: `${Math.max(0.35, (g.seconds / span) * 100)}%`,
                    }}
                  />
                ))}
              </div>

              <div className="flex items-center gap-3 text-[10px] text-zinc-500">
                <button onClick={selectAll} className="hover:text-white transition-colors">
                  Select all
                </button>
                <button onClick={selectNone} className="hover:text-white transition-colors">
                  Select none
                </button>
                {!cut && shortCount > 0 && (
                  <button
                    onClick={skipShort}
                    className="hover:text-white transition-colors"
                    title={`Untick the ${shortCount} stretches shorter than ${SHORT_GAP}s`}
                  >
                    Skip {shortCount} under {SHORT_GAP}s
                  </button>
                )}
              </div>

              <ul className="rounded-xl border border-[var(--s4)] bg-[var(--s1)] divide-y divide-[var(--s3)]">
                {plan.gaps.map((g: CaptionGap) => {
                  const off = skipped.has(g.index);
                  return (
                    <li
                      key={g.index}
                      className={`flex items-center gap-3 px-3 py-2 text-[11px] transition-opacity ${
                        off ? 'opacity-40' : ''
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={!off}
                        onChange={() => toggle(g.index)}
                        className="accent-blue-500 shrink-0"
                      />
                      <span className="w-6 text-zinc-600 tabular-nums shrink-0">{g.index}</span>
                      <span className="text-zinc-300 tabular-nums">
                        {clock(g.start)} – {clock(g.end)}
                      </span>
                      <span className="text-zinc-500 tabular-nums ml-auto shrink-0">
                        {g.seconds.toFixed(1)}s
                      </span>
                      {onPreview && (
                        <button
                          onClick={() => onPreview(g.start)}
                          className="p-1 rounded text-zinc-500 hover:text-blue-300 hover:bg-blue-950/40 transition-colors shrink-0"
                          title="Jump the player here"
                        >
                          <Search className="w-3 h-3" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-t border-[var(--s3)] bg-[var(--s1)] shrink-0">
          <span className="text-[11px] text-zinc-500">
            {plan && plan.total_gaps > 0 &&
              `${chosen.length} of ${plan.total_gaps} selected · ${(chosenSeconds / 60).toFixed(1)} min`}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-2 rounded-lg text-xs text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
            >
              Cancel
            </button>
            {cut ? (
              <button
                onClick={removeFromVideo}
                disabled={!plan || chosen.length === 0 || cutting}
                title="Cut these stretches out of the video and pull everything after them earlier"
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors inline-flex items-center gap-1.5"
              >
                {cutting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Scissors className="w-3.5 h-3.5" />}
                Cut {chosen.length || ''} {chosen.length === 1 ? 'stretch' : 'stretches'} from video
              </button>
            ) : (
              <button
                onClick={() => onConfirm?.(chosen.map((g) => ({ start: g.start, end: g.end })))}
                disabled={!plan || chosen.length === 0}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
              >
                Fill {chosen.length || ''} {chosen.length === 1 ? 'gap' : 'gaps'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
