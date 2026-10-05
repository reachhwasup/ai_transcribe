import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, FileText, Loader2, TriangleAlert, X } from 'lucide-react';
import {
  identifySpeakers,
  importSrtFile,
  previewSubtitleImport,
  translateSegments,
  type SubtitleImportPreview,
} from '../api/client';
import { needsKhmerTranslation } from '../utils/translation';

const LANGUAGE_NAMES: Record<string, string> = {
  km: 'Khmer', zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', th: 'Thai', vi: 'Vietnamese',
};
const clock = (t: number) => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`;

type Step = 'import' | 'translate' | 'speakers';

/**
 * Importing a subtitle file used to replace every caption the moment the file was picked, with
 * no sign of what was in it. This reads the file first, says what it found and what importing
 * will do, and runs the steps an imported subtitle needs before it can be dubbed: translating
 * it, and working out who speaks each line.
 */
export default function SubtitleImportDialog({ projectId, file, onClose }: {
  projectId: string;
  file: File;
  /** `changed` is true when the project's captions were modified */
  onClose: (changed: boolean) => void;
}) {
  const [preview, setPreview] = useState<SubtitleImportPreview | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'replace' | 'translation'>('replace');
  const [translate, setTranslate] = useState(false);
  const [speakers, setSpeakers] = useState(false);
  const [running, setRunning] = useState<Step | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const [finished, setFinished] = useState(false);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    let active = true;
    previewSubtitleImport(projectId, file)
      .then((p) => {
        if (!active) return;
        setPreview(p);
        setTranslate(p.needs_translation);
        // a file that names its speakers needs no listening; one that does not cannot be dubbed
        // in the right voices without it
        setSpeakers(p.has_video && p.speakers.length === 0);
      })
      .catch((err) => active && setError(err?.response?.data?.detail || err?.message || 'Could not read this file'));
    return () => { active = false; };
  }, [projectId, file]);

  const run = async () => {
    if (!preview || running) return;
    setError('');
    const notes: string[] = [];
    try {
      setRunning('import');
      const lines = await importSrtFile(projectId, file, mode);
      setChanged(true);
      notes.push(mode === 'translation'
        ? `Translation applied to ${preview.would_pair} captions`
        : `${lines.length} captions imported`);
      setDone([...notes]);

      if (mode === 'replace' && translate) {
        setRunning('translate');
        const target = preview.project_language;
        // Khmer leaves lines that are already Khmer alone; any other language translates all
        const ids = target === 'km' ? lines.filter((l) => needsKhmerTranslation(l.text)).map((l) => l.id) : undefined;
        if (!ids || ids.length) {
          await translateSegments(projectId, target, ids);
          notes.push(`Translated ${ids ? ids.length : lines.length} lines into ${LANGUAGE_NAMES[target] || target}`);
        } else {
          notes.push('Nothing needed translating');
        }
        setDone([...notes]);
      }

      if (speakers) {
        setRunning('speakers');
        const result = await identifySpeakers(projectId);
        notes.push(result.asked
          ? `${result.labelled} of ${result.asked} lines given a speaker — ${result.characters.length} character${result.characters.length === 1 ? '' : 's'}`
          : 'Every line already had a speaker');
        setDone([...notes]);
      }
      setFinished(true);
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setError((typeof detail === 'string' && detail) || err?.message || 'The import stopped part-way');
    } finally {
      setRunning(null);
    }
  };

  const p = preview;
  const droppedTotal = p ? Object.values(p.dropped).reduce((a, b) => a + b, 0) : 0;
  const canPair = !!p && p.existing_captions > 0 && p.would_pair > 0;
  const pastVideo = !!p && p.timeline_seconds > 0 && p.last > p.timeline_seconds + 1;
  const language = p?.language ? LANGUAGE_NAMES[p.language] || p.language : '';
  const stepLabel = running === 'import' ? 'Importing…' : running === 'translate' ? 'Translating…' : running === 'speakers' ? 'Listening for who speaks each line…' : '';

  return createPortal(
    <div className="fixed inset-0 z-[110] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-lg max-h-[90vh] flex flex-col rounded-2xl border border-[var(--s5)] bg-[var(--s2)] shadow-2xl text-zinc-200">
        <div className="flex items-start gap-3 px-5 py-4 border-b border-[var(--s3)]">
          <span className="mt-0.5 p-2 rounded-lg bg-blue-600 text-white shrink-0"><FileText className="w-4 h-4" /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-white">Import subtitles</h2>
            <p className="text-[11px] text-zinc-400 truncate" title={file.name}>{file.name}</p>
          </div>
          <button onClick={() => onClose(changed)} disabled={!!running} aria-label="Close" className="p-1.5 rounded-md text-zinc-500 hover:text-white hover:bg-white/10 disabled:opacity-30">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          {!p && !error && (
            <p className="flex items-center gap-2 text-xs text-zinc-400"><Loader2 className="w-4 h-4 animate-spin" /> Reading the file…</p>
          )}

          {p && (
            <>
              {/* What is in the file */}
              <div className="rounded-xl border border-[var(--s5)] bg-[var(--s1)] p-3 space-y-2">
                <p className="text-xs text-white font-semibold">
                  {p.lines} caption{p.lines === 1 ? '' : 's'}
                  <span className="font-normal text-zinc-400"> · {clock(p.first)} to {clock(p.last)} · {p.format}{language && ` · ${language}`}</span>
                </p>
                <ul className="text-[11px] text-zinc-400 space-y-0.5">
                  {p.sample.map((line, i) => <li key={i} className="truncate font-khmer">“{line}”</li>)}
                </ul>
                <p className="text-[11px] text-zinc-500">
                  {p.speakers.length
                    ? `Names ${p.speakers.length} speaker${p.speakers.length === 1 ? '' : 's'}: ${p.speakers.slice(0, 5).join(', ')}${p.speakers.length > 5 ? '…' : ''}`
                    : 'Does not say who is speaking'}
                  {p.encoding !== 'UTF-8' && ` · read as ${p.encoding}`}
                </p>
                {droppedTotal > 0 && (
                  <p className="text-[11px] text-zinc-500">
                    Left out {droppedTotal} of {p.found}:
                    {[
                      p.dropped.music && `${p.dropped.music} music or sound cues`,
                      p.dropped.empty && `${p.dropped.empty} empty`,
                      p.dropped.duplicate && `${p.dropped.duplicate} repeated`,
                      p.dropped.bad_time && `${p.dropped.bad_time} with a broken time`,
                    ].filter(Boolean).map((t) => ` ${t}`).join(',')}
                  </p>
                )}
              </div>

              {/* Things worth knowing before importing */}
              {(p.beyond_timeline > 0 || pastVideo || p.overlaps > 0 || p.shortened > 0) && (
                <ul className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-1 text-[11px] text-amber-200">
                  {p.beyond_timeline > 0 && <li className="flex gap-1.5"><TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-px" />{p.beyond_timeline} line{p.beyond_timeline === 1 ? ' starts' : 's start'} after the end of the video ({clock(p.timeline_seconds)}) and will be left out.</li>}
                  {pastVideo && !p.beyond_timeline && <li className="flex gap-1.5"><TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-px" />The file runs to {clock(p.last)} but the video is {clock(p.timeline_seconds)} long. Check it is the subtitle for this video.</li>}
                  {p.overlaps > 0 && <li className="flex gap-1.5"><TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-px" />{p.overlaps} line{p.overlaps === 1 ? ' overlaps' : 's overlap'} the next one. Tidy on the timeline trims them.</li>}
                  {p.shortened > 0 && <li className="flex gap-1.5"><TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-px" />{p.shortened} line{p.shortened === 1 ? ' was' : 's were'} longer than 30 seconds and {p.shortened === 1 ? 'is' : 'are'} cut to 30.</li>}
                </ul>
              )}

              {!finished && (
                <fieldset disabled={!!running} className="space-y-3">
                  {/* What to do with it */}
                  {p.existing_captions > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">This project already has {p.existing_captions} captions</p>
                      {([
                        ['replace', 'Replace them with this file',
                          p.existing_voiced ? `${p.existing_voiced} dubbed voices are removed with them. A version is saved first.` : 'A version is saved first.'],
                        ['translation', 'Use this file as their translation',
                          canPair
                            ? `${p.would_pair} of ${p.existing_captions} captions line up in time. Their current text becomes the original and this file the line to dub.`
                            : 'None of its lines line up in time with the captions here.'],
                      ] as const).map(([id, name, hint]) => (
                        <label key={id} className={`flex items-start gap-2 rounded-xl border p-2.5 text-xs cursor-pointer ${
                          mode === id ? 'border-blue-500/70 bg-blue-600/10' : 'border-[var(--s5)] hover:bg-[var(--s3)]'
                        } ${id === 'translation' && !canPair ? 'opacity-40 pointer-events-none' : ''}`}>
                          <input type="radio" name="import-mode" className="mt-0.5 accent-blue-500" checked={mode === id} onChange={() => setMode(id)} />
                          <span>{name}<span className="block text-[11px] text-zinc-500">{hint}</span></span>
                        </label>
                      ))}
                    </div>
                  )}

                  {/* What an imported subtitle still needs */}
                  <div className="space-y-1.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Then</p>
                    {mode === 'replace' && (
                      <label className="flex items-start gap-2 text-xs cursor-pointer">
                        <input type="checkbox" className="mt-0.5 accent-blue-500" checked={translate} onChange={(e) => setTranslate(e.target.checked)} />
                        <span>
                          Translate into {LANGUAGE_NAMES[p.project_language] || p.project_language}
                          <span className="block text-[11px] text-zinc-500">
                            {p.needs_translation
                              ? `The file is in ${language}. The original is kept beside the translation.`
                              : language ? `The file is already in ${language}.` : 'Only lines that are not already in that language.'}
                          </span>
                        </span>
                      </label>
                    )}
                    <label className={`flex items-start gap-2 text-xs cursor-pointer ${p.has_video ? '' : 'opacity-40 pointer-events-none'}`}>
                      <input type="checkbox" className="mt-0.5 accent-blue-500" checked={speakers && p.has_video} onChange={(e) => setSpeakers(e.target.checked)} />
                      <span>
                        Work out who speaks each line
                        <span className="block text-[11px] text-zinc-500">
                          {!p.has_video
                            ? 'Needs the video: add it first, then use Identify speakers in Dubbing.'
                            : p.speakers.length
                              ? 'The file names its speakers; this fills in lines it leaves blank and sets each voice.'
                              : 'Listens to the video so men, women and children are dubbed in the right voice. Without it every line gets the same voice.'}
                        </span>
                      </span>
                    </label>
                    {(translate || speakers) && <p className="text-[11px] text-zinc-500">These use your Gemini quota.</p>}
                  </div>
                </fieldset>
              )}
            </>
          )}

          {(done.length > 0 || running) && (
            <ul className="space-y-1 text-xs">
              {done.map((note) => <li key={note} className="flex items-start gap-1.5 text-emerald-300"><Check className="w-3.5 h-3.5 shrink-0 mt-px" />{note}</li>)}
              {running && <li className="flex items-center gap-1.5 text-blue-300"><Loader2 className="w-3.5 h-3.5 animate-spin" />{stepLabel}</li>}
            </ul>
          )}
          {error && <p role="alert" className="text-xs text-red-300">{error}{changed && ' The steps before it were kept.'}</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-[var(--s3)]">
          <button onClick={() => onClose(changed)} disabled={!!running} className="px-4 py-2 rounded-xl text-xs text-zinc-400 hover:text-white hover:bg-[var(--s4)] disabled:opacity-40">
            {finished || changed ? 'Close' : 'Cancel'}
          </button>
          {p && !finished && !changed && (
            <button onClick={() => void run()} disabled={!!running} className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold text-xs">
              {running ? 'Working…' : mode === 'translation' ? 'Apply translation' : p.existing_captions ? 'Replace captions' : 'Import'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
