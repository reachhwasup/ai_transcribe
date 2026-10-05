import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Loader2, Mic, RefreshCw, Wand2 } from 'lucide-react';
import { fetchSeriesReview, fixSeries, redubReviewLines, type ReviewLine, type SeriesReview as Review } from '../api/client';
import { jumpToLine } from '../utils/jumpToLine';
import { toast } from '../utils/toast';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const TONE = {
  problem: { chip: 'border-red-500/40 text-red-200', on: 'bg-red-500/20 border-red-400/60 text-red-100', tag: 'text-red-300', edge: 'border-l-red-500/70' },
  check: { chip: 'border-amber-500/40 text-amber-200', on: 'bg-amber-500/20 border-amber-400/60 text-amber-100', tag: 'text-amber-300', edge: 'border-l-amber-500/70' },
};

/**
 * Every line that needs a look, across all the episodes — one list instead of opening each
 * episode to find them. It covers the captions (untranslated, locked spellings, overlaps, too
 * many words) and the dub itself as it sounds (missing, silent, cut short, rushed, running over).
 */
export default function SeriesReview({ projectId, active, onOpenLine, onQueued }: { projectId?: string; active: boolean; onOpenLine?: () => void; onQueued?: () => void }) {
  const navigate = useNavigate();
  const [review, setReview] = useState<Review | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const [kind, setKind] = useState<string | null>(null);
  const [redubbing, setRedubbing] = useState(false);
  const [fixing, setFixing] = useState(false);
  // what the automatic fix can put right; an untranslated line is left for a person
  const fixable = review ? Object.entries(review.kinds).filter(([key]) => key !== 'untranslated').reduce((n, [, info]) => n + info.count, 0) : 0;
  const fixAll = async () => {
    if (!projectId) return;
    setFixing(true);
    try {
      const done = await fixSeries(projectId);
      const said = [
        done.spellings_found ? `${done.spellings_fixed} of ${done.spellings_found} spellings corrected.` : '',
        done.queued ? `${done.queued} episode${done.queued === 1 ? '' : 's'} queued: overlaps spaced, long lines shortened, changed lines dubbed again.` : '',
        done.busy ? `${done.busy} being worked on right now ${done.busy === 1 ? 'was' : 'were'} left alone.` : '',
        done.spelling_error ? `Spellings were not corrected: ${done.spelling_error}` : '',
      ].filter(Boolean).join(' ');
      toast({ tone: done.queued || done.spellings_fixed ? 'success' : 'warning', title: done.queued ? 'Fixing the series' : 'Nothing was queued', detail: said || 'There was nothing a machine can fix.' });
      if (done.queued) onQueued?.();
      await check();
    } catch (e: any) {
      toast({ tone: 'error', title: 'Could not start the fix', detail: e?.response?.data?.detail || e?.message });
    } finally { setFixing(false); }
  };

  const check = useCallback(async () => {
    if (!projectId) return;
    setChecking(true);
    setFailed(false);
    try {
      setReview(await fetchSeriesReview(projectId));
    } catch {
      setFailed(true);
    } finally { setChecking(false); }
  }, [projectId]);

  // checked when the tab is first opened; after that only when asked, since it reads every voice file
  useEffect(() => { if (active && !review && !checking && !failed) void check(); }, [active, review, checking, failed, check]);
  useEffect(() => { setReview(null); setKind(null); }, [projectId]);

  const shown = useMemo(() => (review?.items || []).filter((line) => !kind || line.kind === kind), [review, kind]);
  // one card per line, with every reason it was picked out for, under its episode
  const byEpisode = useMemo(() => {
    const groups: { id: string; episode: number; lines: { line: ReviewLine; reasons: ReviewLine[] }[] }[] = [];
    for (const line of shown) {
      let group = groups[groups.length - 1];
      if (!group || group.id !== line.project_id) groups.push(group = { id: line.project_id, episode: line.episode, lines: [] });
      const card = group.lines.find((c) => c.line.segment_id === line.segment_id);
      if (card) card.reasons.push(line);
      else group.lines.push({ line, reasons: [line] });
    }
    return groups;
  }, [shown]);
  const canRedub = shown.filter((line) => line.redub);

  const redub = async (lines: ReviewLine[]) => {
    if (!projectId || !lines.length) return;
    setRedubbing(true);
    try {
      const done = await redubReviewLines(projectId, [...new Set(lines.map((line) => line.segment_id))]);
      toast({
        tone: done.lines ? 'success' : 'warning',
        title: `${done.lines} line${done.lines === 1 ? '' : 's'} queued for dubbing again`,
        detail: done.busy ? `${done.busy} episode${done.busy === 1 ? ' is' : 's are'} being dubbed right now and ${done.busy === 1 ? 'was' : 'were'} left alone.` : `In ${done.episodes} episode${done.episodes === 1 ? '' : 's'}. Follow it under Work.`,
      });
      await check();
    } catch {
      toast({ tone: 'error', title: 'Could not queue the lines' });
    } finally { setRedubbing(false); }
  };

  if (!review) {
    return (
      <div className="p-3 text-[11px] leading-relaxed text-zinc-400">
        {failed ? (
          <>The episodes could not be checked. <button onClick={() => void check()} className="underline hover:text-white">Try again</button></>
        ) : (
          <span className="flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" /> Reading every episode's captions and listening to the voices…</span>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="text-[11px] text-zinc-300">
          {review.total
            ? <><span className="font-semibold text-white">{review.total}</span> to look at in {review.episodes_flagged} of {review.episodes_checked} episodes</>
            : <span className="flex items-center gap-1.5 text-emerald-300"><Check className="h-3.5 w-3.5" /> Nothing to look at in {review.episodes_checked} episodes</span>}
        </p>
        <button onClick={() => void check()} disabled={checking} title="Check again" aria-label="Check again"
          className="rounded-md p-1 text-zinc-400 hover:bg-white/10 hover:text-white disabled:opacity-40">
          <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {review.total > 0 && (
        <div className="flex flex-wrap gap-1 px-1">
          {Object.entries(review.kinds).map(([key, info]) => (
            <button key={key} onClick={() => setKind(kind === key ? null : key)} aria-pressed={kind === key}
              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${kind === key ? TONE[info.severity].on : `${TONE[info.severity].chip} hover:bg-white/5`}`}>
              {info.label} · {info.count}
            </button>
          ))}
        </div>
      )}

      {fixable > 0 && (
        <div className="rounded-lg border border-[var(--s5)] bg-white/[0.02] p-2">
          <button onClick={() => void fixAll()} disabled={fixing || redubbing}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-blue-500 disabled:opacity-40">
            {fixing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
            {fixing ? 'Starting…' : 'Fix all automatically'}
          </button>
          <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-500">
            Corrects locked spellings, spaces overlapping captions, shortens lines that do not fit, and dubs the changed lines again. A version of each episode is saved first. Check again when the work is done.
          </p>
        </div>
      )}

      {canRedub.length > 0 && (
        <button onClick={() => void redub(canRedub)} disabled={redubbing || fixing}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--s5)] px-2.5 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-white/5 disabled:opacity-40">
          {redubbing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mic className="h-3.5 w-3.5" />}
          Dub {canRedub.length === 1 ? 'this line' : `these ${new Set(canRedub.map((line) => line.segment_id)).size} lines`} again
        </button>
      )}

      {byEpisode.map((group) => (
        <section key={group.id}>
          <h4 className="sticky top-0 z-10 bg-[var(--s2)] px-1 py-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
            Episode {group.episode} · {group.lines.length} line{group.lines.length === 1 ? '' : 's'}
          </h4>
          <ul className="space-y-1">
            {group.lines.map(({ line, reasons }) => {
              const worst = reasons.some((r) => r.severity === 'problem') ? 'problem' : 'check';
              return (
                <li key={line.segment_id}>
                  <button
                    onClick={() => { jumpToLine({ projectId: line.project_id, segmentId: line.segment_id, time: line.start_time }, (path) => navigate(path), projectId); onOpenLine?.(); }}
                    title="Open this line in the editor"
                    className={`block w-full rounded-md border border-l-2 border-[var(--s4)] ${TONE[worst].edge} bg-white/[0.02] px-2.5 py-1.5 text-left hover:bg-white/[0.06]`}
                  >
                    <span className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                      <span className="tabular-nums">{clock(line.start_time)}{line.speaker ? ` · ${line.speaker}` : ''}</span>
                    </span>
                    <span className="mt-0.5 block truncate font-khmer text-[12px] text-zinc-100">{line.text}</span>
                    {reasons.map((reason) => (
                      <span key={reason.kind} className="mt-0.5 block text-[10px] leading-snug text-zinc-500">
                        <span className={`font-semibold ${TONE[reason.severity].tag}`}>{reason.label}</span> — {reason.detail}
                      </span>
                    ))}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {review.shown < review.total && (
        <p className="px-1 text-[10px] text-zinc-500">Showing the first {review.shown} of {review.total}. Fix these and check again for the rest.</p>
      )}
    </div>
  );
}
