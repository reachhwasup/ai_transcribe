import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, History, Loader2, Pencil, RotateCcw, Save, Trash2, X } from 'lucide-react';
import {
  deleteVersion,
  listVersions,
  renameVersion,
  restoreVersion,
  saveVersion,
  VERSION_RESTORED_EVENT,
  type ProjectVersion,
} from '../api/client';

interface Props {
  projectId: string;
  onClose: () => void;
  /** Reload the project after a restore */
  onRestored: () => Promise<void> | void;
}

const clock = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

const ago = (iso: string) => {
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const errorText = (e: any, fallback: string) =>
  e?.response?.data?.detail || (e instanceof Error ? e.message : fallback);

export default function VersionsModal({ projectId, onClose, onRestored }: Props) {
  const [versions, setVersions] = useState<ProjectVersion[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null); // 'save' or a version id
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [showAuto, setShowAuto] = useState(true);
  const nameRef = useRef<HTMLInputElement>(null);

  const refresh = () =>
    listVersions(projectId)
      .then(setVersions)
      .catch((e) => setError(errorText(e, 'Could not load versions')));

  useEffect(() => {
    refresh();
    nameRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !renaming && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy('save');
    setError(null);
    try {
      await saveVersion(projectId, trimmed);
      setName('');
      setNotice(`Saved “${trimmed}”`);
      await refresh();
    } catch (e) {
      setError(errorText(e, 'Could not save the version'));
    } finally {
      setBusy(null);
    }
  };

  const restore = async (v: ProjectVersion) => {
    if (busy) return;
    const ok = confirm(
      `Restore “${v.name}”?\n\n` +
        `Captions, voices, cuts and text overlays go back to how they were ${ago(v.created_at)}.\n` +
        `Your current edit is saved as a version first, so you can switch back.`,
    );
    if (!ok) return;
    setBusy(v.id);
    setError(null);
    try {
      const res = await restoreVersion(projectId, v.id);
      await onRestored();
      window.dispatchEvent(new CustomEvent(VERSION_RESTORED_EVENT, { detail: { projectId } }));
      setNotice(
        `Restored “${v.name}”.` +
          (res.missing_audio
            ? ` ${res.missing_audio} voice ${res.missing_audio === 1 ? 'clip is' : 'clips are'} no longer on disk — generate ${res.missing_audio === 1 ? 'it' : 'them'} again.`
            : ''),
      );
      await refresh();
    } catch (e) {
      setError(errorText(e, 'Could not restore the version'));
    } finally {
      setBusy(null);
    }
  };

  const commitRename = async () => {
    if (!renaming) return;
    const trimmed = renaming.name.trim();
    const id = renaming.id;
    setRenaming(null);
    if (!trimmed) return;
    try {
      await renameVersion(projectId, id, trimmed);
      await refresh();
    } catch (e) {
      setError(errorText(e, 'Could not rename'));
    }
  };

  const remove = async (v: ProjectVersion) => {
    if (busy || !confirm(`Delete “${v.name}”? This can't be undone.`)) return;
    setBusy(v.id);
    try {
      await deleteVersion(projectId, v.id);
      await refresh();
    } catch (e) {
      setError(errorText(e, 'Could not delete'));
    } finally {
      setBusy(null);
    }
  };

  const shown = (versions || []).filter((v) => showAuto || !v.auto);
  const autoCount = (versions || []).filter((v) => v.auto).length;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-lg rounded-2xl border border-[var(--s4)] bg-[var(--s2)] shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--s3)] shrink-0">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 p-2 rounded-lg bg-blue-500/10 text-blue-300 shrink-0">
              <History className="w-4 h-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-white">Versions</h2>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                Save the edit — captions, voices, cuts and overlays — and go back to it any time.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-zinc-500 hover:text-white hover:bg-white/10" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 border-b border-[var(--s3)] shrink-0">
          <div className="flex gap-2">
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') void save();
              }}
              maxLength={200}
              placeholder="Name this version, e.g. Final Khmer dub"
              className="flex-1 min-w-0 rounded-lg border border-[var(--s4)] bg-[var(--s1)] px-3 py-2 text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-blue-500/60"
            />
            <button
              onClick={() => void save()}
              disabled={!name.trim() || !!busy}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold text-white"
            >
              {busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save
            </button>
          </div>
          {notice && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] text-emerald-300">
              <Check className="w-3.5 h-3.5 shrink-0 mt-px" /> {notice}
            </p>
          )}
          {error && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] text-red-300">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" /> {error}
            </p>
          )}
        </div>

        <div className="overflow-y-auto px-5 py-3">
          {autoCount > 0 && (
            <label className="flex items-center gap-2 mb-2 text-[11px] text-zinc-400 select-none cursor-pointer w-fit">
              <input type="checkbox" checked={showAuto} onChange={(e) => setShowAuto(e.target.checked)} className="accent-blue-500" />
              Show automatic backups ({autoCount})
            </label>
          )}

          {!versions && !error && (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-zinc-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading versions…
            </div>
          )}

          {versions && shown.length === 0 && (
            <p className="py-8 text-center text-xs text-zinc-500">
              No versions yet. Name the current edit above to save one.
              <br />
              <span className="text-zinc-600">
                A backup is also saved automatically before re-transcribing, cutting or removing duplicates.
              </span>
            </p>
          )}

          <ul className="space-y-1.5">
            {shown.map((v) => (
              <li
                key={v.id}
                className="group flex items-center gap-3 rounded-xl border border-[var(--s4)] bg-[var(--s1)] px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  {renaming?.id === v.id ? (
                    <input
                      autoFocus
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: v.id, name: e.target.value })}
                      onBlur={() => void commitRename()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') void commitRename();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      maxLength={200}
                      className="w-full rounded border border-blue-500/50 bg-[var(--s2)] px-1.5 py-0.5 text-xs text-white focus:outline-none"
                    />
                  ) : (
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={`truncate text-xs font-medium ${v.auto ? 'text-zinc-400' : 'text-white'}`}>{v.name}</span>
                      {v.auto && (
                        <span className="shrink-0 px-1 rounded bg-white/5 text-[9px] uppercase tracking-wide text-zinc-500">auto</span>
                      )}
                    </div>
                  )}
                  <div className="mt-0.5 text-[10px] text-zinc-500 tabular-nums">
                    {ago(v.created_at)} · {v.segment_count} captions · {v.voiced_count} voiced
                    {v.clip_count > 0 && ` · ${clock(v.timeline_seconds)}`}
                    {v.clip_count > 1 && ` in ${v.clip_count} clips`}
                  </div>
                </div>

                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    onClick={() => setRenaming({ id: v.id, name: v.name })}
                    className="p-1.5 rounded text-zinc-500 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 focus:opacity-100"
                    title={v.auto ? 'Name it to keep it' : 'Rename'}
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => void remove(v)}
                    disabled={!!busy}
                    className="p-1.5 rounded text-zinc-500 hover:text-red-300 hover:bg-red-950/40 opacity-0 group-hover:opacity-100 focus:opacity-100"
                    title="Delete"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => void restore(v)}
                    disabled={!!busy}
                    className="ml-1 flex items-center gap-1 px-2 py-1 rounded-md border border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/20 text-[11px] font-medium text-blue-200 disabled:opacity-40 disabled:cursor-wait"
                  >
                    {busy === v.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                    Restore
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {autoCount > 0 && (
            <p className="mt-3 text-[10px] text-zinc-600">
              The latest 15 automatic backups are kept. Rename one to keep it for good.
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
