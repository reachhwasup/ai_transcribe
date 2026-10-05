import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Combine, Copy, Loader2 } from 'lucide-react';
import { cancelJoin, cancelJoinPlan, fetchJoinPlans, fetchJoinVideos, fetchJoins, selectFolderInSystem, startJoin, type JoinJob, type JoinPlan, type JoinVideo } from '../api/client';
import { toast } from '../utils/toast';

const field = 'mt-1 w-full rounded border border-[var(--s5)] bg-[var(--s2)] px-2 py-1.5 text-[11px] text-white';
const quiet = 'flex items-center justify-center gap-1.5 rounded-md border border-[var(--s5)] px-2.5 py-1.5 text-[11px] font-medium text-zinc-200 hover:bg-white/5 disabled:opacity-40';

/**
 * Join the exported episodes of a series into one long video, with a chapter for each — the
 * compilation the long-form platforms want. It works on the files in the export folder.
 */
export default function JoinEpisodes({ projectId, series, active }: { projectId?: string; series: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState('');
  const [videos, setVideos] = useState<JoinVideo[]>([]);
  const [looking, setLooking] = useState(false);
  const [first, setFirst] = useState(0);
  const [last, setLast] = useState(0);
  const [name, setName] = useState<string | null>(null);     // null: the series' own name
  const [job, setJob] = useState<JoinJob | null>(null);
  const [plans, setPlans] = useState<JoinPlan[]>([]);

  const look = useCallback(async (inFolder = '') => {
    if (!projectId) return;
    setLooking(true);
    try {
      const found = await fetchJoinVideos(projectId, inFolder, series);
      setFolder(found.folder);
      setVideos(found.videos);
      if (found.videos.length) {
        setFirst(found.videos[0].episode);
        setLast(found.videos[found.videos.length - 1].episode);
      }
    } catch {
      setVideos([]);
    } finally { setLooking(false); }
  }, [projectId, series]);

  useEffect(() => { if (open && active) void look(); }, [open, active, look]);

  // follow the join while it runs, and pick up one started before the panel was opened
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const poll = async () => {
      try {
        const [all, planned] = await Promise.all([fetchJoins(), fetchJoinPlans()]);
        if (!alive) return;
        setPlans(planned);
        const mine = all[all.length - 1] || null;
        setJob(mine);
      } catch { /* keep the last view */ }
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [active]);

  const waiting = plans.filter((p) => p.groups.some((g) => g.status === 'waiting' || g.status === 'joining'));
  const chosen = videos.filter((v) => v.episode >= first && v.episode <= last);
  const movie = (name ?? series).trim();
  const running = job?.status === 'running';
  const start = async () => {
    try {
      setJob(await startJoin({ folder, first, last, name: movie, series }));
    } catch (e: any) {
      toast({ tone: 'error', title: 'Could not start joining', detail: e?.response?.data?.detail || e?.message });
    }
  };

  return (
    <div className="mb-2 rounded-lg border border-[var(--s5)] bg-white/[0.02]">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold text-zinc-100">
        <span className="flex items-center gap-2"><Combine className="h-3.5 w-3.5 text-zinc-400" /> Join episodes into one video</span>
        <ChevronDown className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {waiting.length > 0 && (
        <div className="space-y-1 border-t border-[var(--s5)] px-3 py-2 text-[11px] text-zinc-300">
          {plans.map((plan) => plan.groups.some((g) => g.status === 'waiting' || g.status === 'joining') && (
            <div key={plan.id} className="flex items-start justify-between gap-2">
              <span className="min-w-0 leading-snug">
                <Loader2 className="mr-1 inline h-3 w-3 animate-spin text-blue-400" />
                Joins by itself when the exports finish: {plan.groups.filter((g) => g.status !== 'done').map((g) => `Episode (${g.episodes[0]}-${g.episodes[g.episodes.length - 1]})`).join(', ')}
              </span>
              <button onClick={() => void cancelJoinPlan(plan.id).then(() => setPlans((all) => all.filter((p) => p.id !== plan.id)))}
                className="shrink-0 text-zinc-500 hover:text-white">Cancel</button>
            </div>
          ))}
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-[var(--s5)] p-2.5">
          <label className="block text-[10px] text-zinc-400">
            Folder with the exported episodes
            <input value={folder} onChange={(e) => setFolder(e.target.value)} onBlur={() => void look(folder)} disabled={running} className={field} />
          </label>
          <button className={`${quiet} w-full`} disabled={running} onClick={async () => {
            const picked = await selectFolderInSystem();
            if (picked) void look(picked);
          }}>Choose folder…</button>

          {looking ? (
            <p className="flex items-center gap-1.5 text-[11px] text-zinc-400"><Loader2 className="h-3 w-3 animate-spin" /> Looking for episodes…</p>
          ) : videos.length < 2 ? (
            <p className="text-[11px] leading-relaxed text-amber-200">
              {videos.length ? 'Only one episode is in this folder.' : 'No exported episodes found in this folder.'} Export the episodes first, or choose the folder they were saved to.
            </p>
          ) : (
            <>
              <p className="text-[11px] text-zinc-400">{videos.length} episodes found · {videos[0].episode}–{videos[videos.length - 1].episode}</p>
              <div className="grid grid-cols-2 gap-2">
                {([['From episode', first, setFirst], ['To episode', last, setLast]] as const).map(([label, value, set]) => (
                  <label key={label} className="block text-[10px] text-zinc-400">
                    {label}
                    <select value={value} onChange={(e) => set(Number(e.target.value))} disabled={running} className={field}>
                      {videos.map((v) => <option key={v.episode} value={v.episode}>{v.episode}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <label className="block text-[10px] text-zinc-400">
                Movie name
                <input value={name ?? series} onChange={(e) => setName(e.target.value)} disabled={running} className={field} />
              </label>
              {chosen.length >= 2 && (
                <p className="break-all text-[10px] leading-relaxed text-zinc-500">
                  {movie ? `${movie} - ` : ''}Episode ({chosen[0].episode}-{chosen[chosen.length - 1].episode}).mp4 · {chosen.length} episodes, with a chapter for each
                </p>
              )}
              <button onClick={() => void start()} disabled={running || chosen.length < 2}
                className="flex w-full items-center justify-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-blue-500 disabled:opacity-40">
                {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Combine className="h-3.5 w-3.5" />}
                {running ? 'Joining…' : chosen.length < 2 ? 'Choose at least two episodes' : `Join ${chosen.length} episodes`}
              </button>
            </>
          )}

          {job && (
            <div className="rounded-md border border-[var(--s5)] p-2 text-[11px]">
              {job.status === 'running' && (
                <>
                  <div className="flex items-center justify-between gap-2 text-zinc-300">
                    <span className="truncate">{job.message}</span>
                    <button onClick={() => void cancelJoin(job.id)} className="shrink-0 text-zinc-500 hover:text-white">Cancel</button>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--s4)]"><div className="h-full bg-blue-500 transition-[width]" style={{ width: `${job.percent}%` }} /></div>
                </>
              )}
              {job.status === 'error' && <p className="text-red-300">Could not join: {job.error}</p>}
              {job.status === 'cancelled' && <p className="text-zinc-400">Joining was cancelled.</p>}
              {job.status === 'done' && (
                <div className="space-y-1.5">
                  <p className="text-emerald-300">{job.count} episodes joined{job.reencoded ? ' (encoded again: the files differed in size or format)' : ''}</p>
                  <p className="break-all text-zinc-400">{job.saved_path}</p>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500">Chapters for the description</span>
                    <button className="flex items-center gap-1 text-zinc-300 hover:text-white" onClick={async () => {
                      try { await navigator.clipboard.writeText(job.chapter_text); toast({ tone: 'success', title: 'Chapters copied' }); }
                      catch { toast({ tone: 'error', title: 'Could not copy' }); }
                    }}><Copy className="h-3 w-3" /> Copy</button>
                  </div>
                  <pre className="max-h-32 select-text overflow-y-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-[10px] leading-relaxed text-zinc-300">{job.chapter_text}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
