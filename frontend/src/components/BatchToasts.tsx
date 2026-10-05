import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import { useBatchStore } from '../utils/batchRunner';
import { toast, useToastStore, type Toast } from '../utils/toast';
import { usePipelineStore, usePipelineWatch, STEP_SHORT } from '../utils/pipelineWatch';
import { fetchAppUpdate, fetchJoins, fetchRenderQueue, type PipelineJob, type RenderJob } from '../api/client';
import { nameParts } from '../utils/names';

const STEP_WORDS: Record<string, string> = {
  music: 'isolating the music', repair: 'fixing captions', captions: 'writing captions', speakers: 'finding the speakers', dubbing: 'dubbing', export: 'queueing the export',
};
const short = (name: string) => nameParts(name).tail || name;

/**
 * The corner of the screen where work reports in, on every page: a small card while this tab
 * is still uploading or cutting (closing the tab would stop that), and a toast whenever work
 * starts or ends — including work done in the background, which nobody is watching.
 */
export default function BatchToasts() {
  const navigate = useNavigate();
  const { batches, setNavigate } = useBatchStore();
  const toasts = useToastStore((s) => s.toasts);
  useEffect(() => {
    setNavigate((path) => navigate(path));
    return () => setNavigate(null);
  }, [navigate, setNavigate]);

  useBackgroundAnnouncements();

  const inBrowser = batches.filter((b) => b.phase === 'browser');
  // uploads and the cut run in this tab; leaving the page would stop them half way
  useEffect(() => {
    if (!inBrowser.length) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [inBrowser.length]);

  if (!inBrowser.length && !toasts.length) return null;

  return (
    <div className="fixed top-14 right-4 z-[60] flex flex-col items-end gap-2 w-[min(360px,calc(100vw-32px))] pointer-events-none">
      {inBrowser.map((b) => (
        <div key={b.id} role="status" className="toast-in pointer-events-auto w-full rounded-xl border border-[var(--s5)] bg-[var(--s2)] shadow-2xl px-3.5 py-3">
          <p className="flex items-center gap-2 text-xs font-semibold text-white min-w-0">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400 shrink-0" />
            <span className="truncate">{b.kind === 'folder' ? `Adding “${b.title}”` : `Preparing “${b.title}”`}</span>
          </p>
          <p className="mt-1 text-[11px] text-zinc-400 truncate">{b.message}</p>
          <div className="mt-2 h-1 rounded-full bg-[var(--s4)] overflow-hidden">
            <div className="h-full bg-blue-500 transition-[width]" style={{ width: `${b.percent}%` }} />
          </div>
          <p className="mt-1.5 text-[10px] text-zinc-500">Keep this tab open until this is done. You can work in the editor meanwhile.</p>
        </div>
      ))}
      {toasts.map((t) => <ToastCard key={t.id} toast={t} />)}
    </div>
  );
}

const ICONS = { success: CheckCircle2, warning: AlertTriangle, error: XCircle, info: Info, working: Loader2 };
const TONES = {
  success: 'border-emerald-500/40 text-emerald-300',
  warning: 'border-amber-500/40 text-amber-300',
  error: 'border-red-500/40 text-red-300',
  info: 'border-blue-500/40 text-blue-300',
  working: 'border-blue-500/40 text-blue-300',
};

/** One toast. Slides in from the right; drag or swipe it right to send it away early. */
function ToastCard({ toast: t }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const [dx, setDx] = useState(0);
  const start = useRef<number | null>(null);
  const Icon = ICONS[t.tone];

  const onDown = (e: React.PointerEvent) => {
    start.current = e.clientX;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (start.current !== null) setDx(Math.max(0, e.clientX - start.current));   // right only
  };
  const onUp = () => {
    if (start.current === null) return;
    start.current = null;
    if (dx > 70) dismiss(t.id);
    else setDx(0);
  };

  return (
    <div
      role="status"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      style={dx ? { transform: `translateX(${dx}px)`, opacity: Math.max(0.2, 1 - dx / 220), transition: 'none' } : undefined}
      className={`${t.leaving ? 'toast-out' : 'toast-in'} pointer-events-auto w-full touch-pan-y select-none cursor-grab active:cursor-grabbing rounded-xl border bg-[var(--s2)] shadow-2xl px-3.5 py-3 flex items-start gap-2.5 transition-[transform,opacity] duration-200 ${TONES[t.tone]}`}
    >
      <Icon className={`w-4 h-4 shrink-0 mt-px ${t.tone === 'working' ? 'animate-spin' : ''}`} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-white break-words">{t.title}</p>
        {t.detail && <p className="mt-0.5 text-[11px] text-zinc-400 leading-snug break-words">{t.detail}</p>}
      </div>
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => dismiss(t.id)}
        aria-label="Dismiss"
        className="p-0.5 rounded text-zinc-500 hover:text-white shrink-0"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/**
 * Work on the server's queues — captions, dubbing, music, renders — has no button waiting on
 * it, so its start and end are announced from here, by watching the queues change.
 */
function useBackgroundAnnouncements() {
  usePipelineWatch();
  const jobs = usePipelineStore((s) => s.jobs);
  const seenJobs = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const before = seenJobs.current;
    const now = new Map(jobs.map((j) => [j.id, `${j.status}:${j.step}:${j.retry_at || ''}`]));
    seenJobs.current = now;
    if (!before) return;                  // the first look only learns what is already there
    for (const job of jobs) {
      const was = before.get(job.id);
      const is = now.get(job.id)!;
      if (was === is) continue;
      announceJob(job, was);
    }
  }, [jobs]);

  // renders: one poll here, so an export finishing is told wherever you are
  const seenRenders = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      let list: RenderJob[];
      try { list = await fetchRenderQueue(); } catch { return; }
      if (!alive) return;
      const before = seenRenders.current;
      seenRenders.current = new Map(list.map((j) => [j.id, j.status]));
      if (!before) return;
      for (const job of list) {
        const was = before.get(job.id);
        if (was === job.status) continue;
        const name = short(job.label || 'Export');
        if (job.status === 'rendering') toast({ tone: 'working', title: `Export started: ${name}` });
        else if (job.status === 'done') toast({ tone: 'success', title: `Export finished: ${name}` });
        else if (job.status === 'error') toast({ tone: 'error', title: `Export failed: ${name}`, detail: job.error || undefined });
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  // a newer version waiting in the project folder is said once, when the app is opened
  useEffect(() => {
    fetchAppUpdate()
      .then((status) => { if (status.update_ready) toast({ tone: 'info', title: 'An update is ready', detail: 'Open Settings → About and press Update now.' }); })
      .catch(() => {});
  }, []);

  // joined videos: started by hand or by themselves after a batch of exports
  const seenJoins = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      let list;
      try { list = await fetchJoins(); } catch { return; }
      if (!alive) return;
      const before = seenJoins.current;
      seenJoins.current = new Map(list.map((j) => [j.id, j.status]));
      if (!before) return;
      for (const job of list) {
        if (before.get(job.id) === job.status) continue;
        const file = job.saved_path?.split('/').pop();
        if (job.status === 'running') toast({ tone: 'working', title: `Joining ${job.count} episodes` });
        else if (job.status === 'done') toast({ tone: 'success', title: `${job.count} episodes joined`, detail: file });
        else if (job.status === 'error') toast({ tone: 'error', title: 'Could not join the episodes', detail: job.error || undefined });
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
}

/** the quota wait already announced: every waiting episode shares it, and it is said once */
let quotaWaitTold = '';

function announceJob(job: PipelineJob, was: string | undefined) {
  const name = short(job.project_name);
  if (job.status === 'queued' && job.retry_at) {
    if (quotaWaitTold === job.retry_at || new Date(job.retry_at).getTime() < Date.now()) return;
    quotaWaitTold = job.retry_at;
    const at = new Date(job.retry_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    toast({ tone: 'warning', title: `Gemini's quota is used up`, detail: `Captions and speakers wait and try again at ${at}. Music, dubbing and exports carry on.` });
    return;
  }
  if (job.status === 'running' && job.step) {
    // said once, when the job starts — a toast for every step of every episode buries the screen
    if (was && was.startsWith('running')) return;
    const plan = (job.steps || []).map((step) => STEP_SHORT[step] || step).join(' → ');
    toast({ tone: 'working', title: `${name}: ${STEP_WORDS[job.step] || 'working'}`, detail: plan || undefined });
  } else if (job.status === 'done') {
    toast({ tone: 'success', title: `${name}: finished`, detail: job.notes.join(' · ') || undefined });
  } else if (job.status === 'review') {
    toast({ tone: 'warning', title: `${name}: needs a look before export`, detail: (job.issues || []).map((i) => i.title).join(' · ') || undefined });
  } else if (job.status === 'error') {
    toast({ tone: 'error', title: `${name}: ${STEP_SHORT[job.step] || 'work'} failed`, detail: job.error || undefined });
  }
}
