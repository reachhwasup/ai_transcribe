import { useEffect, useState } from 'react';
import { X, Film, Loader2, ListPlus, Mic, FileText, Copy, Download, Check } from 'lucide-react';
import { useProjectStore } from '../stores/projectStore';
import { fetchMovieRecap, generateMovieRecap, importRecapToTimeline, type MovieRecap } from '../api/client';

export default function MovieRecapPanel({ onClose }: { onClose: () => void }) {
  const project = useProjectStore(s => s.currentProject);
  const [language, setLanguage] = useState(project?.language || 'km');
  const [source, setSource] = useState<'timeline' | 'file'>('timeline');
  const [file, setFile] = useState<{ filename: string; transcript: string } | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const [length, setLength] = useState<MovieRecap['length']>('standard');
  const [mode, setMode] = useState<'summary' | 'voiceover'>('voiceover');
  const [recap, setRecap] = useState<MovieRecap | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState('');
  // Off by default: a recap normally stands in for the transcript rather than joining it
  const [keepExisting, setKeepExisting] = useState(false);
  const count = project?.segments.filter(s => s.speaker !== 'Freeze' && s.voice_profile !== 'freeze' && !/intro hook/i.test(s.speaker || '') && (s.original_text || s.text || '').trim()).length || 0;
  useEffect(() => {
    if (!project) return;
    let active = true;
    fetchMovieRecap(project.id).then(value => { if (active) setRecap(value); }).catch(() => { if (active) setError('Could not load the saved recap.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [project?.id]);
  async function generate() {
    if (!project || busy) return;
    setBusy(true); setError(''); setCopied(false);
    try { setRecap(await generateMovieRecap(project.id, language, length, source === 'file' ? { source, ...file! } : { source }, mode)); }
    catch (e: any) { setError(e.response?.data?.detail || 'Unable to generate recap. Please try again.'); }
    finally { setBusy(false); }
  }
  const loadProject = useProjectStore(s => s.loadProject);

  /** Put the recap script on the timeline as captions so it can be read and edited there.
   *  No voices are made here — dubbing stays a deliberate timeline step. */
  async function importToTimeline() {
    if (!project || importing) return;
    setImporting(true); setError(''); setImported('');
    try {
      const plan = await importRecapToTimeline(project.id, { dryRun: true, keepExisting });
      const existing = project.segments?.length || 0;
      const thin = typeof plan.coverage_percent === 'number' && plan.coverage_percent < 50;
      const ok = confirm(
        `Put the recap on the timeline as ${plan.lines} caption lines covering ${plan.spans}?` +
        (typeof plan.coverage_percent === 'number'
          ? `\n\nThis script speaks for ${plan.spoken_seconds}s of a ${plan.video_seconds}s video — ` +
            `${plan.coverage_percent}% coverage.`
          : '') +
        (thin
          ? `\n\nA movie recap video normally narrates most of the runtime. This is a summary ` +
            `for reading; for a voiceover that covers the whole video, choose “Voiceover ` +
            `narration” above and write it again.`
          : '') +
        (existing
          ? keepExisting
            ? `\n\nYour ${existing} existing caption(s) are kept — the recap lines are added after them.`
            : `\n\nThis REPLACES the ${existing} caption(s) already on the timeline. A version is saved first — restore it from Versions to get them back.`
          : '') +
        `\n\nNo voices are generated — dub them from the timeline when the script reads right.`,
      );
      if (!ok) return;
      const segs = await importRecapToTimeline(project.id, { keepExisting });
      await loadProject(project.id);
      setImported(`${Array.isArray(segs) ? segs.length : plan.lines} lines added to the timeline.`);
    } catch (e: any) {
      setError(e.response?.data?.detail || 'Could not import the recap to the timeline.');
    } finally {
      setImporting(false);
    }
  }

  const timestamp = (seconds: number | null) => seconds === null ? 'Untimed' : `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds % 3600 / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
  const clock = (seconds: number | null) => seconds === null ? '—' : `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
  const ready = source === 'timeline' ? count > 0 : !!file;
  const sections = recap?.sections || [];
  const people = recap?.characters || [];
  const isVoiceover = recap?.mode === 'voiceover' || typeof recap?.coverage_percent === 'number';
  const text = recap ? [
    recap.title,
    recap.summary,
    people.length ? `Characters\n${people.map(c => `• ${c.name}${c.description ? ` — ${c.description}` : ''}`).join('\n')}` : '',
    recap.key_events.length ? `Key events\n${recap.key_events.map((e, i) => `${i + 1}. ${e}`).join('\n')}` : '',
    sections.length ? sections.map(s => `${timestamp(s.start_time)} → ${timestamp(s.end_time)}${s.title ? `  ${s.title}` : ''}\n${s.script}`).join('\n\n') : '',
    recap.ending ? `How it ends\n${recap.ending}` : '',
  ].filter(Boolean).join('\n\n') : '';

  const fieldClass = 'block w-full bg-[var(--s3)] rounded-lg border border-[var(--s6)] px-2.5 py-2 text-xs text-zinc-100 focus:outline-none focus:border-blue-400/60';
  const headingClass = 'text-[11px] font-semibold uppercase tracking-wider text-blue-200/90';
  const modes = [
    { id: 'voiceover' as const, icon: Mic, name: 'Voiceover narration', hint: 'A script to speak over the whole film, beat by beat.' },
    { id: 'summary' as const, icon: FileText, name: 'Summary to read', hint: 'A written recap: the story, the characters, each scene and how it ends.' },
  ];
  const lengths: { id: MovieRecap['length']; name: string; hint: string }[] = [
    { id: 'short', name: 'Short', hint: 'A quick overview — just enough to follow the story.' },
    { id: 'standard', name: 'Standard', hint: 'Every major development, who is involved and why.' },
    { id: 'detailed', name: 'Detailed', hint: 'Goes through every exchange: who says what to whom, why, and what it changes. Longer the more dialogue there is.' },
  ];

  return <section className="h-full min-h-0 flex flex-col bg-[var(--s2)] text-zinc-200">
    <header className="flex items-center justify-between border-b border-white/10 px-4 py-3 shrink-0">
      <h2 className="text-sm font-semibold flex items-center gap-2"><Film className="w-4 h-4 text-blue-300" />Movie Recap</h2>
      <button onClick={onClose} aria-label="Close Movie Recap" className="p-1 hover:bg-white/10 rounded"><X className="w-4 h-4" /></button>
    </header>
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <p className="text-xs text-zinc-400">Writes a recap from the transcript, using the original dialogue where there is one.</p>

      {/* What to write */}
      <fieldset disabled={busy || loading} className="space-y-2">
        <legend className={headingClass}>What to write</legend>
        <div className="grid grid-cols-2 gap-2 pt-1">
          {modes.map(({ id, icon: Icon, name, hint }) => (
            <button key={id} type="button" aria-pressed={mode === id} onClick={() => setMode(id)}
              className={`text-left rounded-xl border p-3 transition-colors disabled:opacity-50 ${
                mode === id ? 'border-blue-400/70 bg-blue-500/10' : 'border-[var(--s6)] hover:border-[var(--s8)] hover:bg-[var(--s3)]'
              }`}>
              <span className="flex items-center gap-2 text-xs font-semibold text-zinc-100">
                <Icon className={`w-3.5 h-3.5 ${mode === id ? 'text-blue-300' : 'text-zinc-500'}`} />{name}
              </span>
              <span className="block text-[11px] text-zinc-400 mt-1 leading-relaxed">{hint}</span>
            </button>
          ))}
        </div>
      </fieldset>

      {/* How much — only the reading summary has a length; narration fills the runtime */}
      {mode === 'summary' ? (
        <fieldset disabled={busy || loading} className="space-y-2">
          <legend className={headingClass}>How much detail</legend>
          <div className="flex rounded-lg border border-[var(--s6)] overflow-hidden mt-1" role="radiogroup" aria-label="Summary length">
            {lengths.map(l => (
              <button key={l.id} type="button" role="radio" aria-checked={length === l.id} onClick={() => setLength(l.id)}
                className={`flex-1 px-3 py-2 text-xs font-semibold transition-colors ${
                  length === l.id ? 'bg-blue-600 text-white' : 'bg-[var(--s3)] text-zinc-300 hover:bg-[var(--s4)]'
                }`}>{l.name}</button>
            ))}
          </div>
          <p className="text-[11px] text-zinc-400 leading-relaxed">{lengths.find(l => l.id === length)?.hint}</p>
        </fieldset>
      ) : (
        <p className="text-[11px] text-zinc-400 leading-relaxed">
          The runtime is split into 25-second beats and each gets enough script to narrate it, so the recap runs the length of the video.
        </p>
      )}

      {/* From what, in which language */}
      <fieldset disabled={busy || readingFile || loading} className="grid grid-cols-2 gap-3">
        <label className="text-xs space-y-1.5"><span className="text-zinc-300">Transcript</span>
          <select value={source} onChange={e => setSource(e.target.value as 'timeline' | 'file')} className={fieldClass}>
            <option value="timeline">The timeline ({count} lines)</option><option value="file">A file…</option>
          </select>
        </label>
        <label className="text-xs space-y-1.5"><span className="text-zinc-300">Write it in</span>
          <select value={language} onChange={e => setLanguage(e.target.value)} className={fieldClass}>
            {Object.entries({ km: 'Khmer', en: 'English', zh: 'Chinese', th: 'Thai', vi: 'Vietnamese', ja: 'Japanese', ko: 'Korean', fr: 'French', es: 'Spanish', de: 'German' }).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        {source === 'file' && <div className="col-span-2 space-y-2">
          <input type="file" accept=".srt,.vtt,.json,.txt" aria-label="Import recap transcript" className="text-xs w-full" onChange={async e => {
            const selected = e.target.files?.[0];
            setFile(null); setError('');
            if (!selected) return;
            if (selected.size > 2000000) { setError('Choose a transcript smaller than 2 MB.'); return; }
            setReadingFile(true);
            try {
              const transcript = await selected.text();
              if (!transcript.trim()) throw new Error('The transcript file is empty.');
              setFile({ filename: selected.name, transcript });
            } catch (e: any) { setError(e.message || 'Unable to read transcript file.'); }
            finally { setReadingFile(false); }
          }} />
          <p className="text-[11px] text-zinc-400">SRT, VTT, JSON, or UTF-8 TXT · up to 2 MB. The timeline captions are not changed.</p>
          {file && <p className="text-[11px] text-blue-300">Loaded: {file.filename}</p>}
          {file?.filename.toLowerCase().endsWith('.txt') && <p className="text-[11px] text-amber-300">Plain text has no timestamps, so scenes will be untimed. Use SRT or VTT to keep start and end times.</p>}
        </div>}
      </fieldset>

      <button disabled={busy || loading || readingFile || !ready} onClick={() => void generate()} className="w-full rounded-lg bg-blue-600 hover:bg-blue-500 py-2.5 text-sm font-semibold disabled:opacity-40 flex items-center justify-center gap-2 transition-colors">
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
        {busy
          ? (mode === 'voiceover' ? 'Writing narration beat by beat…' : 'Reading the transcript…')
          : mode === 'voiceover'
            ? (recap ? 'Write the voiceover again' : 'Write the voiceover')
            : (recap ? 'Write the summary again' : 'Write the summary')}
      </button>
      {source === 'timeline' && !count && <p className="text-xs text-amber-300">Generate or import the movie transcript first.</p>}
      {busy && <p role="status" className="text-xs text-zinc-400">A long transcript is read in parts and then combined. You can keep editing while this runs.</p>}
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      {loading && <p className="text-xs text-zinc-400">Loading the saved recap…</p>}

      {recap && <article className="rounded-xl border border-[var(--s6)] bg-[var(--s1)] p-4 space-y-5">
        <div className="space-y-1.5">
          <h3 className="text-base font-semibold text-blue-100 leading-snug select-text">{recap.title}</h3>
          <p className="text-[11px] text-zinc-500">
            {new Date(recap.generated_at).toLocaleString()} · from {recap.source_segments} lines
            {recap.source === 'file' ? ` in ${recap.filename}` : ' on the timeline'}
            {typeof recap.summary_characters === 'number' && ` · ${recap.summary_characters.toLocaleString()} characters`}
            {!!sections.length && ` · ${sections.length} ${isVoiceover ? 'beats' : 'scenes'}`}
            {!!people.length && ` · ${people.length} characters in the story`}
          </p>
          {recap.summary_expanded && <p className="text-[11px] text-zinc-500">The first draft came back short, so it was written again in full.</p>}
        </div>

        {recap.stale && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 leading-relaxed">
            <strong className="font-semibold">This recap no longer matches your transcript.</strong>{' '}
            It was written from {recap.source_segments} lines; the timeline now has{' '}
            {recap.current_segments}. Write it again so it follows the captions you have.
          </div>
        )}

        <div className="space-y-2">
          <h4 className={headingClass}>The story</h4>
          <div className="whitespace-pre-wrap text-sm leading-7 select-text font-khmer">{recap.summary}</div>
        </div>

        {!!people.length && <div className="space-y-2">
          <h4 className={headingClass}>Characters</h4>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {people.map((c, i) => <li key={i} className="rounded-lg border border-[var(--s5)] bg-[var(--s3)] px-3 py-2 select-text">
              <p className="text-xs font-semibold text-zinc-100 font-khmer">{c.name}</p>
              {c.description && <p className="text-[11px] text-zinc-400 leading-relaxed mt-0.5 font-khmer">{c.description}</p>}
            </li>)}
          </ul>
        </div>}

        {!!recap.key_events.length && <div className="space-y-2">
          <h4 className={headingClass}>Key events</h4>
          <ol className="space-y-1.5 select-text">
            {recap.key_events.map((event, i) => <li key={i} className="flex gap-2.5 text-xs leading-6 font-khmer">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500/20 text-[10px] font-bold text-blue-200">{i + 1}</span>
              <span>{event}</span>
            </li>)}
          </ol>
        </div>}

        {!!sections.length && <div className="space-y-2">
          <h4 className={headingClass}>{isVoiceover ? 'Narration script' : 'Scene by scene'}</h4>
          <ol className="space-y-2">
            {sections.map((section, index) => <li key={index} className="rounded-lg border border-[var(--s5)] bg-[var(--s3)] p-3 space-y-1.5 select-text">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-mono text-blue-200 tabular-nums" title={`${timestamp(section.start_time)} → ${timestamp(section.end_time)} in the source video`}>
                  {section.start_time === null ? 'Untimed' : `${clock(section.start_time)} – ${clock(section.end_time)}`}
                </span>
                {section.title && <span className="text-xs font-semibold text-zinc-100 font-khmer">{section.title}</span>}
              </div>
              <p className="text-sm leading-7 whitespace-pre-wrap font-khmer">{section.script}</p>
            </li>)}
          </ol>
        </div>}

        {recap.ending && <div className="space-y-2">
          <h4 className={headingClass}>How it ends</h4>
          <p className="text-sm leading-7 whitespace-pre-wrap select-text font-khmer">{recap.ending}</p>
        </div>}

        {typeof recap.coverage_percent === 'number' && (
          <div className={`rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
            recap.coverage_percent >= 70
              ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-200'
              : 'border-amber-500/30 bg-amber-500/5 text-amber-200'
          }`}>
            Narration speaks for {recap.spoken_seconds}s — {recap.coverage_percent}% of the film,
            across {recap.windows_written} of {recap.windows_planned} beats.
            {!!recap.windows_topped_up && ` ${recap.windows_topped_up} were rewritten longer.`}
            {!!recap.windows_missing && ` ${recap.windows_missing} could not be written — write it again to fill them.`}
            {!!recap.windows_language_retried &&
              ` ${recap.windows_language_retried} came back in the wrong language and were asked for again.`}
            {!!recap.windows_wrong_language && ` ${recap.windows_wrong_language} stayed wrong and were dropped.`}
            {recap.coverage_percent < 70 && ' Below 70% the video plays quiet in places; writing it again usually improves it.'}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--s5)] pt-3 text-xs">
          <button
            onClick={() => { void importToTimeline(); }}
            disabled={importing || !sections.length}
            title={keepExisting
              ? 'Add the recap lines after the captions already on the timeline'
              : 'Replace the captions on the timeline with the recap script'}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed font-semibold border ${
              keepExisting
                ? 'bg-blue-600/20 hover:bg-blue-600/30 text-blue-100 border-blue-500/40'
                : 'bg-amber-600/20 hover:bg-amber-600/30 text-amber-100 border-amber-500/40'
            }`}
          >
            {importing ? <Loader2 className="w-3 h-3 animate-spin" /> : <ListPlus className="w-3 h-3" />}
            {importing
              ? 'Working...'
              : keepExisting
                ? 'Add Recap to Timeline'
                : 'Replace Timeline with Recap'}
          </button>
          <label
            className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200 cursor-pointer select-none"
            title="Leave the captions already on the timeline alone and put the recap after them"
          >
            <input
              type="checkbox"
              checked={keepExisting}
              onChange={e => setKeepExisting(e.target.checked)}
              className="accent-blue-500"
            />
            Keep existing captions
          </label>
          <span className="ml-auto flex items-center gap-1">
            <button
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-[var(--s4)]"
              onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => setError('Unable to copy. Select the text to copy it by hand.')); }}
            >
              {copied ? <Check className="w-3 h-3 text-emerald-300" /> : <Copy className="w-3 h-3" />}{copied ? 'Copied' : 'Copy all'}
            </button>
            <button
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-[var(--s4)]"
              onClick={() => { const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = 'movie-recap.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}
            >
              <Download className="w-3 h-3" />TXT
            </button>
          </span>
        </div>
        {imported && <p className="text-xs text-emerald-300">{imported}</p>}
      </article>}
    </div>
  </section>;
}
