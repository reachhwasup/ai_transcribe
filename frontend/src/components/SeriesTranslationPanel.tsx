import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Trash2, Loader2, Play, Sparkles, Users, Lock, Volume2 } from 'lucide-react';
import { fetchSeriesMemory, saveSeriesMemory, applySeriesCast, scanTranslations, fetchVoiceProfiles,
  learnSeriesCast, suggestSeriesTerms, checkSeriesSpellings, fixSeriesSpellings, fetchVoiceSample,
  updateSegment, translateSegments, type SeriesMemory, type SeriesCharacter, type TranslationReview, type VoiceProfileItem } from '../api/client';
import type { Project, Segment, VideoClip } from '../types';
import { buildClipLayout, timelineToSource } from '../utils/clipTimemap';

const input = 'w-full rounded-lg border border-white/10 bg-black/20 px-2.5 py-2 text-xs text-white focus:border-blue-500 focus:outline-none';
const button = 'rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-200 hover:bg-white/10 disabled:opacity-40';
const primary = `${button} bg-blue-600 border-blue-500 hover:bg-blue-500`;
const profiles = ['', 'male', 'female', 'grandpa', 'grandma', 'child_boy', 'child_girl'];
const voiceStyles: [string, string][] = [['', 'Chosen for them'], ['deep', 'Deep'], ['low', 'Low'], ['natural', 'Natural'], ['bright', 'Bright'], ['high', 'High']];
const seriesStyles: [string, string, string][] = [
  ['', 'Left to the translator', ''],
  ['formal', 'Formal', 'Polite, complete sentences, courteous forms of address'],
  ['everyday', 'Everyday', 'How people really talk at home and with friends'],
  ['street', 'Street', 'Blunt and colloquial, with slang; insults stay hard'],
];
const errorText = (e: any) => {
  const detail = e?.response?.data?.detail;
  return typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((d: any) => d.msg).join('; ') : e?.message || 'Request failed';
};

export default function SeriesTranslationPanel({ project, clips, initialTab, onClose, onChanged }: {
  project: Project; clips: VideoClip[]; initialTab: 'series' | 'review'; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const [tab, setTab] = useState(initialTab);
  const [memory, setMemory] = useState<SeriesMemory | null>(null);
  const [family, setFamily] = useState(1);
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [voices, setVoices] = useState<VoiceProfileItem[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const [review, setReview] = useState<TranslationReview | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [active, setActive] = useState<Segment | null>(null);
  // each cast member's voice style as last saved, to know whose dubs a change makes stale
  const savedStyles = useRef<Record<string, string>>({});
  const [sampling, setSampling] = useState<number | null>(null);
  const remember = (m: SeriesMemory) => { savedStyles.current = Object.fromEntries(m.characters.map((c) => [c.source, c.voice_style || ''])); };
  const restyled = () => (memory?.characters || []).filter((c) => c.source in savedStyles.current && savedStyles.current[c.source] !== (c.voice_style || '')).map((c) => c.source);
  // the style a cast member with none chosen is given: by their place among the cast of the
  // same gender, as the dubbing does it, so what is heard here is what is dubbed
  const givenStyle = (index: number): string => {
    const isMale = (profile: string) => ['male', 'grandpa', 'child_boy'].includes(profile);
    const me = memory!.characters[index];
    if (!me.voice_profile) return 'natural';
    const before = memory!.characters.slice(0, index).filter((c) => !c.voice_style && c.voice_profile && isMale(c.voice_profile) === isMale(me.voice_profile)).length;
    return ['natural', 'low', 'bright', 'deep', 'high'][before % 5];
  };
  const playSample = async (index: number, c: SeriesCharacter) => {
    if (sampling !== null) return;
    setSampling(index);
    try {
      const url = await fetchVoiceSample(project.id, { voice_profile: c.voice_profile || 'female', voice_name: c.voice_name, voice_style: c.voice_style || givenStyle(index) });
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (e) { setError(errorText(e)); } finally { setSampling(null); }
  };
  // lines, across the series, that spell a locked name or term some other way
  const [misses, setMisses] = useState<{ lines: number; episodes: number } | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const previewEnd = useRef(0);
  const layout = buildClipLayout(clips);

  useEffect(() => {
    let cancelled = false;
    fetchSeriesMemory(project.id).then((data) => {
      if (!cancelled) { setMemory(data.memory); remember(data.memory); setFamily(data.projects); setSpeakers(data.speakers); }
    }).catch((e) => { if (!cancelled) setError(errorText(e)); });
    fetchVoiceProfiles().then((v) => { if (!cancelled) setVoices(v); }).catch(() => {});
    checkSeriesSpellings(project.id).then((m) => { if (!cancelled) setMisses(m); }).catch(() => {});
    return () => { cancelled = true; };
  }, [project.id]);

  const task = async (name: string, fn: () => Promise<void>) => {
    setBusy(name); setError(''); setMessage('');
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  };
  const scan = (semantic = false) => task('Scanning', async () => {
    setReview(await scanTranslations(project.id, semantic));
  });
  useEffect(() => { if (tab === 'review' && !review) void scan(); }, [tab]);

  const change = (patch: Partial<SeriesMemory>) => { if (memory) setMemory({ ...memory, ...patch }); setDirty(true); };
  const character = (index: number, patch: Partial<SeriesCharacter>) => change({ characters: memory!.characters.map((c, i) => i === index ? { ...c, ...patch } : c) });
  // saving does not forget whose voice style changed: their old dubs stay stale until the
  // cast is applied, which is what clears them
  const save = async () => {
    const saved = await saveSeriesMemory(project.id, memory!);
    setMemory(saved); setDirty(false);
    setMisses(await checkSeriesSpellings(project.id).catch(() => null));
  };
  const suggestTerms = () => task('Reading the episodes for names', async () => {
    const { suggestions } = await suggestSeriesTerms(project.id);
    const have = new Set([...memory!.terms, ...memory!.characters].map((t) => t.source));
    const fresh = suggestions.filter((t) => !have.has(t.source));
    if (!fresh.length) { setMessage('No new names or recurring terms found.'); return; }
    change({ terms: [...memory!.terms, ...fresh.map(({ source, target }) => ({ source, target }))] });
    setMessage(`${fresh.length} suggestion${fresh.length === 1 ? '' : 's'} added below. Check each spelling, remove any that are wrong, then save.`);
  });
  const learnCast = () => task('Collecting the speakers', async () => {
    if (dirty) await save();
    const result = await learnSeriesCast(project.id);
    setMemory(result.memory);
    setMessage(result.added.length
      ? `${result.added.length} speaker${result.added.length === 1 ? '' : 's'} added from ${result.projects} episode${result.projects === 1 ? '' : 's'}. Each keeps one voice type in every episode.`
      : 'Every named speaker is already in the cast.');
  });
  const fixSpellings = () => task('Fixing spellings in every episode', async () => {
    if (dirty) await save();
    const result = await fixSeriesSpellings(project.id);
    await onChanged();
    setMisses(await checkSeriesSpellings(project.id).catch(() => null));
    setMessage(result.found
      ? `${result.fixed} of ${result.found} lines corrected in ${result.episodes} episode${result.episodes === 1 ? '' : 's'}. Corrected lines need dubbing again.`
        + (result.failed.length ? ` Could not translate: ${result.failed.join(', ')}.` : '')
      : 'Every line already uses the locked spellings.');
  });
  const preview = (seg: Segment) => {
    setActive(seg);
    const start = Math.max(0, seg.start_time - 1);
    const mapped = layout.length ? timelineToSource(layout, start) : null;
    const source = mapped?.sourceTime ?? start;
    previewEnd.current = source + Math.max(2, seg.end_time - seg.start_time + 2);
    if (video.current) { video.current.currentTime = source; void video.current.play().catch(() => {}); }
  };
  const recheckLine = async (id: string) => {
    const basic = await scanTranslations(project.id);
    const merged = new Map(basic.issues.map((issue) => [issue.id, issue]));
    for (const issue of review?.issues || []) {
      if (issue.id === id) continue;
      const aiReasons = issue.reasons.filter((reason) => reason.startsWith('AI suggestion:'));
      if (aiReasons.length) merged.set(issue.id, { id: issue.id, reasons: [...(merged.get(issue.id)?.reasons || []), ...aiReasons] });
    }
    setReview({ ...basic, issues: [...merged.values()] });
  };
  const src = project.video_path ? `/uploads/${project.id}/${encodeURIComponent(project.video_path.split('/').pop()!)}` : '';

  return createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4">
    <section role="dialog" aria-modal="true" aria-label="Series and translation review" className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[var(--s2)] shadow-2xl">
      <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
        <div><h2 className="text-base font-semibold text-white">Series & translation review</h2><p className="text-xs text-zinc-500">{project.name} · {family} project{family === 1 ? '' : 's'} share series settings</p></div>
        <button className={button} disabled={!!busy} onClick={onClose} aria-label="Close"><X size={16} /></button>
      </header>
      <div className="flex gap-2 border-b border-white/10 px-5 py-2">
        <button className={tab === 'series' ? primary : button} onClick={() => setTab('series')}>Shared glossary & cast</button>
        <button className={tab === 'review' ? primary : button} disabled={!!busy} onClick={() => setTab('review')}>Review translations</button>
        {busy && <span role="status" className="flex items-center gap-2 text-xs text-blue-300"><Loader2 size={14} className="animate-spin" />{busy}…</span>}
      </div>
      {error && <p role="alert" className="px-5 py-2 text-xs text-red-300">{error}</p>}
      {message && <p role="status" className="px-5 py-2 text-xs text-emerald-300">{message}</p>}
      <div className="overflow-y-auto p-5 space-y-4">
        {tab === 'series' && !memory && <p className="text-xs text-zinc-400">Loading shared settings…</p>}
        {tab === 'series' && memory && <fieldset disabled={!!busy} className="space-y-4 disabled:opacity-60">
          <p className="text-xs leading-relaxed text-zinc-400">Approved names and relationship notes guide new translations across this folder or split series. Existing captions change only when you translate them again. Match characters by their speaker name or aliases.</p>
          <label className="block text-xs text-zinc-400">Target language code<input aria-label="Target language code" className={`${input} mt-1 max-w-28 block`} value={memory.language} onChange={(e) => change({ language: e.target.value })} /></label>
          <div className="rounded-xl border border-white/10 p-3 space-y-2">
            <h3 className="text-sm font-semibold text-white">How the series is worded</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Wording style">
              {seriesStyles.map(([key, label, hint]) => (
                <button key={key} type="button" role="radio" aria-checked={(memory.style || '') === key} onClick={() => change({ style: key as SeriesMemory['style'] })}
                  className={`rounded-lg border p-2 text-left ${(memory.style || '') === key ? 'border-blue-500 bg-blue-600/15' : 'border-white/10 hover:bg-white/5'}`}>
                  <span className="block text-xs font-semibold text-white">{label}</span>
                  {hint && <span className="mt-0.5 block text-[10px] leading-snug text-zinc-500">{hint}</span>}
                </button>
              ))}
            </div>
            <input aria-label="How people address each other" className={input} placeholder="How people address each other, e.g. Zhao calls her father លោកឪពុក; the thugs call each other ឯង"
              value={memory.address || ''} onChange={(e) => change({ address: e.target.value })} />
            <p className="text-[11px] text-zinc-500">Used whenever an episode is translated from now on. Captions already translated keep their wording until they are translated again.</p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-white">Names & recurring terms</h3>
            <div className="flex gap-2"><button className={button} onClick={suggestTerms} title="Reads the translated episodes and proposes the names and terms that recur, with the spelling already used most"><Sparkles size={12} className="inline mr-1" />Suggest from episodes</button>
              <button className={button} onClick={() => change({ terms: [...memory.terms, { source: '', target: '' }] })}><Plus size={12} className="inline mr-1" />Add term</button></div></div>
          {!!misses?.lines && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            <span><Lock size={12} className="inline mr-1" />{misses.lines} line{misses.lines === 1 ? '' : 's'} in {misses.episodes} episode{misses.episodes === 1 ? '' : 's'} spell a locked name differently.</span>
            <button className={button} onClick={fixSpellings}>Fix in all {family} episode{family === 1 ? '' : 's'}</button>
          </div>}
          {misses && !misses.lines && memory.terms.length > 0 && <p className="text-xs text-emerald-300"><Lock size={12} className="inline mr-1" />Every episode uses these spellings.</p>}
          {memory.terms.map((term, i) => <div key={i} className="flex gap-2">
            <input aria-label="Source term" className={input} placeholder="Original name or term" value={term.source} onChange={(e) => change({ terms: memory.terms.map((t, n) => n === i ? { ...t, source: e.target.value } : t) })} />
            <input aria-label="Preferred translation" className={input} placeholder="Preferred translation" value={term.target} onChange={(e) => change({ terms: memory.terms.map((t, n) => n === i ? { ...t, target: e.target.value } : t) })} />
            <button aria-label="Remove term" className={button} onClick={() => change({ terms: memory.terms.filter((_, n) => n !== i) })}><Trash2 size={14} /></button>
          </div>)}
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-white">Series cast <span className="font-normal text-zinc-500">· {memory.characters.length}</span></h3>
            <div className="flex gap-2"><button className={button} onClick={learnCast} title="Adds every named speaker of every episode, with the voice type most of their lines have"><Users size={12} className="inline mr-1" />Add speakers from all episodes</button>
              <button className={button} onClick={() => change({ characters: [...memory.characters, { source: '', target: '', aliases: [], voice_profile: '', voice_name: '', voice_style: '', notes: '' }] })}>+ Add character</button></div></div>
          <p className="text-[11px] leading-relaxed text-zinc-500">Speakers found when an episode's speakers are identified are added here by themselves, and later episodes are told these names so the same person keeps the same name and voice type.</p>
          <datalist id="series-speakers">{speakers.map((s) => <option key={s} value={s} />)}</datalist>
          {memory.characters.map((c, i) => <div key={i} className="rounded-xl border border-white/10 p-3 space-y-2">
            <div className="flex gap-2"><input aria-label="Character speaker name" list="series-speakers" className={input} placeholder="Speaker / source name" value={c.source} onChange={(e) => character(i, { source: e.target.value })} />
              <input aria-label="Translated character name" className={input} placeholder="Preferred translated name" value={c.target} onChange={(e) => character(i, { target: e.target.value })} />
              <button aria-label="Remove character" className={button} onClick={() => change({ characters: memory.characters.filter((_, n) => n !== i) })}><Trash2 size={14} /></button></div>
            <input aria-label="Character aliases" className={input} placeholder="Other speaker labels, separated by commas" value={c.aliases.join(',')} onChange={(e) => character(i, { aliases: e.target.value.split(',') })} />
            <div className="flex gap-2"><select aria-label="Character voice type" className={input} value={c.voice_profile} onChange={(e) => character(i, { voice_profile: e.target.value })}>{profiles.map((p) => <option key={p} value={p}>{p || 'Keep voice type'}</option>)}</select>
              <select aria-label="Character voice" className={input} value={c.voice_name} onChange={(e) => character(i, { voice_name: e.target.value })}><option value="">Automatic voice</option>{voices.map((v) => <option key={v.id} value={v.voice_name || v.id}>{v.name}</option>)}</select>
              <select aria-label="Character voice style" title="How this person's voice is pitched and paced, the same in every episode" className={input} value={c.voice_style || ''} onChange={(e) => character(i, { voice_style: e.target.value as SeriesCharacter['voice_style'] })}>{voiceStyles.map(([key, label]) => <option key={key} value={key}>{key ? label : `Chosen for them · ${givenStyle(i)}`}</option>)}</select>
              <button type="button" aria-label={`Hear ${c.source || 'this character'}`} title="Hear a line in this voice" className={button} disabled={sampling !== null} onClick={() => void playSample(i, c)}>{sampling === i ? <Loader2 size={14} className="animate-spin" /> : <Volume2 size={14} />}</button></div>
            <input aria-label="Character relationship notes" className={input} placeholder="Relationships and pronouns, e.g. elder brother of…" value={c.notes} onChange={(e) => character(i, { notes: e.target.value })} />
          </div>)}
          <textarea aria-label="Series translation notes" className={input} rows={3} placeholder="Series-wide tone, pronouns and relationships" value={memory.notes} onChange={(e) => change({ notes: e.target.value })} />
          <div className="flex flex-wrap gap-2"><button className={primary} onClick={() => task('Saving', async () => { await save(); setMessage('Shared settings saved for every episode.'); })}>{dirty ? 'Save shared settings' : 'Save settings'}</button>
            <button className={button} onClick={() => task('Applying cast', async () => { const changed = restyled(); await save(); const result = await applySeriesCast(project.id, changed); if (memory) remember(memory); await onChanged(); setMessage(`Updated ${result.changed} lines across ${result.projects} projects. Changed voices need dubbing again.`); })}>Save & apply voices across series</button></div>
          <p className="text-[11px] text-zinc-500">A voice style is how a person's voice is pitched and paced; left as "Chosen for them", each cast member gets a different one. Voice changes clear affected generated audio. Saved versions preserve earlier captions and voice settings. New dubbing also uses this cast automatically.</p>
        </fieldset>}
        {tab === 'review' && <>
          <div className="flex flex-wrap items-center gap-2"><button disabled={!!busy || dirty} className={button} onClick={() => scan()}>Scan basic checks</button><button disabled={!!busy || dirty} className={primary} onClick={() => scan(true)}>Check meaning with AI</button><span className="text-xs text-zinc-500">AI checks use your configured provider. Suggestions can be wrong.</span></div>
          {dirty && <p className="text-xs text-amber-300">Save shared settings before scanning with the updated glossary.</p>}
          {review?.warnings.map((w) => <p key={w} className="text-xs text-amber-300">{w}</p>)}
          {!!review?.without_source && <p className="text-xs text-amber-300">{review.without_source} lines have no source text for meaning comparison.</p>}
          {src && <video ref={video} src={src} controls preload="metadata" className="max-h-56 w-full rounded-lg bg-black" onTimeUpdate={() => { if (video.current && previewEnd.current && video.current.currentTime >= previewEnd.current) { video.current.pause(); previewEnd.current = 0; } }} />}
          {active && <p className="text-xs text-zinc-400">Preview: {active.speaker || 'Dialogue'} · {active.start_time.toFixed(1)}s</p>}
          {review && <p className="text-xs text-zinc-400">{review.issues.length} flagged of {review.checked} captions. Basic checks cover script and approved spellings; AI checks look for meaning changes.</p>}
          {review?.issues.map((issue) => {
            const seg = project.segments.find((s) => s.id === issue.id);
            if (!seg) return null;
            return <article key={seg.id} className="rounded-xl border border-amber-500/20 p-3 space-y-2">
              <div className="flex justify-between gap-2"><p className="text-xs text-amber-200">{issue.reasons.join(' · ')}</p><button className={button} onClick={() => preview(seg)}><Play size={12} className="inline" /> Preview</button></div>
              <div className="grid gap-3 md:grid-cols-2"><div><p className="mb-1 text-[10px] uppercase text-zinc-500">Source · {seg.speaker || 'Unknown speaker'}</p><p className="select-text text-sm text-zinc-300">{seg.original_text || 'No source available'}</p></div>
                <label className="text-[10px] uppercase text-zinc-500">Translation<textarea rows={3} className={`${input} mt-1 normal-case`} value={drafts[seg.id] ?? seg.text} onChange={(e) => setDrafts({ ...drafts, [seg.id]: e.target.value })} /></label></div>
              <div className="flex gap-2"><button disabled={!!busy || !(drafts[seg.id] ?? seg.text).trim()} className={primary} onClick={() => task('Saving translation', async () => { await updateSegment(project.id, seg.id, { text: drafts[seg.id] ?? seg.text }); await onChanged(); await recheckLine(seg.id); setMessage('Translation saved. Regenerate this line’s voice if needed.'); })}>Save correction</button>
                <button disabled={!!busy || dirty} className={button} onClick={() => task('Translating line', async () => { await translateSegments(project.id, project.language, [seg.id]); setDrafts((d) => { const next = { ...d }; delete next[seg.id]; return next; }); await onChanged(); await recheckLine(seg.id); })}>Translate again</button></div>
            </article>;
          })}
          {review && !review.issues.length && <p className="text-sm text-emerald-300">No suspicious lines found by this scan.</p>}
        </>}
      </div>
    </section>
  </div>, document.body);
}
