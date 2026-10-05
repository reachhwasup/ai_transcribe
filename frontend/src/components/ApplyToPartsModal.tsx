import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Copy, Loader2, X } from 'lucide-react';
import { applyToParts, listOtherParts, type ApplyItem, type OtherPart } from '../utils/projectSettings';

const ITEMS: { id: ApplyItem; label: string; hint: string }[] = [
  { id: 'caption_style', label: 'Caption style', hint: 'Font, colours, box, size, animation' },
  { id: 'logo', label: 'Logo', hint: 'Image, position, size, when it shows' },
  { id: 'blur_shapes', label: 'Blur boxes', hint: 'Covered subtitles and logos' },
  { id: 'aspect_ratio', label: 'Aspect ratio', hint: 'The frame shape' },
  { id: 'bgm', label: 'BGM cleanup', hint: 'Dialogue removal and Keep sound effects' },
];

/** Copy this part's setup to the other parts of the same split video. */
export default function ApplyToPartsModal({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const [parts, setParts] = useState<OtherPart[] | null>(null);
  const [chosenParts, setChosenParts] = useState<Set<string>>(new Set());
  const [items, setItems] = useState<Set<ApplyItem>>(new Set(['caption_style', 'logo', 'blur_shapes']));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<{ id: string; name: string; applied: string[]; skipped: string[] }[] | null>(null);

  useEffect(() => {
    listOtherParts(projectId)
      .then((list) => {
        setParts(list);
        setChosenParts(new Set(list.map((p) => p.id)));
      })
      .catch((e) => setError(e?.message || 'Could not load the other parts'));
  }, [projectId]);

  const toggle = <T,>(set: Set<T>, v: T) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await applyToParts(projectId, [...items], [...chosenParts]);
      setReport(res.parts);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Could not copy the settings');
    } finally {
      setBusy(false);
    }
  };

  const isolated = (parts || []).filter((p) => chosenParts.has(p.id) && p.has_stems).length;
  const label = (id: string) => ITEMS.find((i) => i.id === id)?.label || id;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[var(--s4)] bg-[var(--s2)] shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--s3)] px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded-lg bg-blue-500/10 p-2 text-blue-300">
              <Copy className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-white">Copy to other parts</h2>
              <p className="mt-0.5 text-[11px] text-zinc-400">Use {projectName}'s setup on the rest of this video.</p>
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="rounded-md p-1.5 text-zinc-500 hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          {report ? (
            <div className="space-y-1.5">
              {report.map((r) => (
                <div key={r.id} className="rounded-lg border border-[var(--s4)] bg-[var(--s1)] px-3 py-2 text-[11px]">
                  <div className="flex items-center gap-1.5 font-semibold text-white">
                    {r.applied.length ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />}
                    {r.name}
                  </div>
                  {r.applied.length > 0 && <div className="mt-0.5 text-zinc-400">Copied: {r.applied.map(label).join(', ')}</div>}
                  {r.skipped.length > 0 && <div className="mt-0.5 text-amber-300/80">Skipped: {r.skipped.join('; ')}</div>}
                </div>
              ))}
            </div>
          ) : (
            <>
              <div>
                <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">What to copy</span>
                <div className="mt-1.5 space-y-1">
                  {ITEMS.map((it) => (
                    <label key={it.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/5">
                      <input type="checkbox" checked={items.has(it.id)} onChange={() => setItems((s) => toggle(s, it.id))} className="accent-blue-500" />
                      <span className="text-xs text-white">{it.label}</span>
                      <span className="text-[10px] text-zinc-500">
                        {it.id === 'bgm' ? `${it.hint} · ${isolated} of ${chosenParts.size} parts isolated` : it.hint}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">To these parts</span>
                  {parts && parts.length > 0 && (
                    <button
                      onClick={() => setChosenParts(chosenParts.size === parts.length ? new Set() : new Set(parts.map((p) => p.id)))}
                      className="text-[10px] text-zinc-500 hover:text-white"
                    >
                      {chosenParts.size === parts.length ? 'Select none' : 'Select all'}
                    </button>
                  )}
                </div>
                {!parts && !error && (
                  <div className="flex items-center gap-2 py-3 text-xs text-zinc-500">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading parts…
                  </div>
                )}
                <div className="mt-1.5 grid grid-cols-3 gap-1">
                  {(parts || []).map((p) => (
                    <label
                      key={p.id}
                      className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] ${
                        chosenParts.has(p.id) ? 'border-blue-500/50 bg-blue-600/10 text-white' : 'border-[var(--s5)] text-zinc-400'
                      }`}
                    >
                      <input type="checkbox" checked={chosenParts.has(p.id)} onChange={() => setChosenParts((s) => toggle(s, p.id))} className="accent-blue-500" />
                      Part {p.part_index}
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
          {error && <p className="text-[11px] text-red-300">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--s3)] bg-[var(--s1)] px-5 py-3">
          <button onClick={onClose} disabled={busy} className="rounded-lg px-3 py-2 text-xs text-zinc-400 hover:bg-white/5 hover:text-white">
            {report ? 'Done' : 'Cancel'}
          </button>
          {!report && (
            <button
              onClick={apply}
              disabled={busy || !items.size || !chosenParts.size}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {busy ? 'Copying…' : `Copy to ${chosenParts.size} part${chosenParts.size === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
