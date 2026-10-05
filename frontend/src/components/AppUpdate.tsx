import { useEffect, useState } from 'react';
import { CheckCircle2, Download, Loader2 } from 'lucide-react';
import { applyAppUpdate, fetchAppUpdate, type AppUpdateStatus } from '../api/client';
import { toast } from '../utils/toast';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for the server to answer again after it has been started with the new code */
async function serverIsBack(seconds = 150): Promise<boolean> {
  await sleep(2500);       // it has to go down first
  for (let waited = 0; waited < seconds; waited += 1.5) {
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      if (response.ok) return true;
    } catch { /* still starting */ }
    await sleep(1500);
  }
  return false;
}

/**
 * Whether the app is behind the code in the project folder, and the button that brings it up
 * to date — the pages are built again, the server started again if its code changed, and the
 * window reloaded.
 */
export default function AppUpdate() {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [updating, setUpdating] = useState('');
  const [problem, setProblem] = useState('');

  const check = () => fetchAppUpdate().then(setStatus).catch(() => setStatus(null));
  useEffect(() => { void check(); }, []);

  const update = async () => {
    if (!status) return;
    if (status.working && !confirm(`${status.working} job${status.working === 1 ? ' is' : 's are'} running. Updating restarts ${status.working === 1 ? 'it' : 'them'} from the step ${status.working === 1 ? 'it is' : 'they are'} on. Update now?`)) return;
    setProblem('');
    setUpdating('Building the new version…');
    try {
      const done = await applyAppUpdate();
      if (done.restarting) {
        setUpdating('Starting the new version…');
        if (!(await serverIsBack())) throw new Error('The app did not come back. Quit it and open it again.');
      }
      setUpdating('Reloading…');
      window.location.reload();
    } catch (e: any) {
      setProblem(e?.response?.data?.detail || e?.message || 'The update could not be applied.');
      setUpdating('');
      void check();
    }
  };

  const builtAt = status?.built_at ? new Date(status.built_at * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';

  return (
    <div className="p-3.5 rounded-xl bg-[var(--s3)] border border-[var(--s5)] space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-white">App update</p>
          <p className="text-[11px] text-zinc-400 mt-0.5">
            {!status ? 'Checking…'
              : status.update_ready ? 'A newer version is ready in the project folder.'
              : `Up to date${builtAt ? ` · built ${builtAt}` : ''}`}
          </p>
        </div>
        {status?.update_ready ? (
          <button onClick={() => void update()} disabled={!!updating}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white disabled:opacity-50 cursor-pointer">
            {updating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            {updating || 'Update now'}
          </button>
        ) : status ? (
          <button onClick={() => void check().then(() => toast({ tone: 'info', title: 'Checked for updates' }))}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-zinc-200 cursor-pointer">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Check again
          </button>
        ) : null}
      </div>
      {problem && <p role="alert" className="text-[11px] text-red-300 whitespace-pre-wrap break-words">{problem}</p>}
      <p className="text-[10px] text-zinc-500 leading-relaxed">
        Updating builds the new screens, restarts the app's server if its code changed, and reloads this window. Your videos, projects and settings are not touched.
      </p>
    </div>
  );
}
