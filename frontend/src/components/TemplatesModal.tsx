import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { LayoutTemplate, Loader2, Trash2, X } from 'lucide-react';
import { applyTemplate, deleteTemplate, listTemplates, saveTemplate, type SeriesTemplate } from '../api/client';
import { syncProjectSettings } from '../utils/projectSettings';

const PART_NAMES: Record<string, string> = {
  caption_style: 'caption style', video_filter: 'colour filter', logo: 'logo', aspect_ratio: 'frame shape',
};
export const describeTemplate = (t: SeriesTemplate) => t.has.map((k) => PART_NAMES[k] || k).join(', ') || 'nothing';

/** Save this project's look as a template, or give it the look of one saved earlier. */
export default function TemplatesModal({ projectId, projectName, onClose }: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const [templates, setTemplates] = useState<SeriesTemplate[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const refresh = () => listTemplates().then(setTemplates).catch(() => setTemplates([]));
  useEffect(() => { void refresh(); }, []);

  const run = async (key: string, work: () => Promise<string>) => {
    if (busy) return;
    setBusy(key); setError(''); setNotice('');
    try {
      setNotice(await work());
      await refresh();
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setError((typeof detail === 'string' && detail) || err?.message || 'That did not work');
    } finally {
      setBusy('');
    }
  };

  const save = () => run('save', async () => {
    const existing = templates?.find((t) => t.name.toLowerCase() === name.trim().toLowerCase());
    if (existing && !confirm(`Replace the template “${existing.name}” with this project's look?`)) return '';
    const saved = await saveTemplate(name.trim(), projectId);
    setName('');
    return `Saved “${saved.name}”: ${describeTemplate(saved)}.`;
  });

  const apply = (t: SeriesTemplate) => run(`apply-${t.id}`, async () => {
    if (!confirm(`Give this project the look of “${t.name}”?\n\nIt replaces this project's ${describeTemplate(t)}. Captions, voices and blur boxes are not touched.`)) return '';
    const res = await applyTemplate(t.id, projectId);
    // pull what the server now holds into the editor, replacing the browser's copy
    await syncProjectSettings(projectId, true);
    return `Applied ${res.applied.map((k) => PART_NAMES[k] || k).join(', ')}.`;
  });

  const remove = (t: SeriesTemplate) => run(`delete-${t.id}`, async () => {
    if (!confirm(`Delete the template “${t.name}”? Projects that already use its look keep it.`)) return '';
    await deleteTemplate(t.id);
    return `Deleted “${t.name}”.`;
  });

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg rounded-2xl border border-[var(--s4)] bg-[var(--s2)] shadow-2xl overflow-hidden flex flex-col max-h-[85vh] text-zinc-200">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--s3)] shrink-0">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 p-2 rounded-lg bg-blue-500/10 text-blue-300 shrink-0"><LayoutTemplate className="w-4 h-4" /></span>
            <div>
              <h2 className="text-sm font-semibold text-white">Templates</h2>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                A template is a project's look — caption style, colour filter, logo and frame shape — saved to use on the next episode.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-zinc-500 hover:text-white hover:bg-white/10" title="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-5 py-4 border-b border-[var(--s3)] shrink-0 space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Save this project's look</p>
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && void save()}
              placeholder={`e.g. ${projectName.replace(/\s*[-—–]\s*(Episode|Part|Ep)\b.*$/i, '') || 'My series'}`}
              maxLength={80}
              className="flex-1 min-w-0 rounded-lg border border-[var(--s4)] bg-[var(--s1)] px-3 py-2 text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-blue-500/60"
            />
            <button
              onClick={() => void save()}
              disabled={!name.trim() || !!busy}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold text-white"
            >
              {busy === 'save' && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save as template
            </button>
          </div>
          {notice && <p role="status" className="text-[11px] text-emerald-300">{notice}</p>}
          {error && <p role="alert" className="text-[11px] text-red-300">{error}</p>}
        </div>

        <div className="overflow-y-auto px-5 py-3">
          {templates === null && <p className="py-6 text-center text-xs text-zinc-500 flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>}
          {templates?.length === 0 && (
            <p className="py-6 text-center text-xs text-zinc-500">
              No templates yet. Set this project up the way the series should look, then save it above.
            </p>
          )}
          <ul className="space-y-1.5">
            {templates?.map((t) => (
              <li key={t.id} className="group flex items-center gap-3 rounded-xl border border-[var(--s4)] bg-[var(--s1)] px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-white">{t.name}</p>
                  <p className="mt-0.5 text-[10px] text-zinc-500 truncate">
                    {describeTemplate(t)}{t.source_project && ` · from ${t.source_project}`}
                  </p>
                </div>
                <button
                  onClick={() => void remove(t)}
                  disabled={!!busy}
                  className="p-1.5 rounded text-zinc-500 hover:text-red-300 hover:bg-red-950/40 opacity-0 group-hover:opacity-100 focus:opacity-100"
                  title="Delete this template"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
                <button
                  onClick={() => void apply(t)}
                  disabled={!!busy}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/20 text-[11px] font-medium text-blue-200 disabled:opacity-40"
                >
                  {busy === `apply-${t.id}` && <Loader2 className="w-3 h-3 animate-spin" />} Apply here
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>,
    document.body,
  );
}
