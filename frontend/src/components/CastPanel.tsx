import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Pause, Play, Users, X } from 'lucide-react';
import { fetchVoiceProfiles, updateCast, type CastChange, type VoiceProfileItem } from '../api/client';
import type { Segment } from '../types';

const TYPES: [string, string][] = [
  ['male', 'Man'], ['female', 'Woman'], ['grandpa', 'Old man'], ['grandma', 'Old woman'],
  ['child_boy', 'Boy'], ['child_girl', 'Girl'],
];
const MALE = new Set(['male', 'grandpa', 'child_boy']);

interface Row {
  name: string;
  lines: number;
  dubbed: number;
  seconds: number;
  /** The type and voice most of this character's lines have */
  profile: string;
  voice: string;
  /** Their lines do not all share one type or one voice */
  mixed: boolean;
  sample: string;
}

interface Draft { newName: string; profile: string; voice: string }

const mostCommon = (values: string[]) => {
  const counts = new Map<string, number>();
  values.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
};

/**
 * Every character once, with the voice they are dubbed in. Voices used to be set line by line,
 * or through a filter and a bulk action; after speakers are identified from the audio, the
 * question is "is this the right voice for this person" — which is one decision per character.
 */
export default function CastPanel({ projectId, segments, onClose }: {
  projectId: string;
  segments: Segment[];
  /** `changed` is true when the cast was modified */
  onClose: (changed: boolean) => void;
}) {
  const [voices, setVoices] = useState<VoiceProfileItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    fetchVoiceProfiles().then(setVoices).catch(() => setVoices([]));
    return () => audio.current?.pause();
  }, []);

  const rows = useMemo<Row[]>(() => {
    const groups = new Map<string, Segment[]>();
    for (const seg of segments) {
      const name = (seg.speaker || '').trim();
      if (!name || !(seg.text || '').trim()) continue;
      groups.set(name, [...(groups.get(name) || []), seg]);
    }
    return [...groups.entries()]
      .map(([name, lines]) => {
        const profiles = lines.map((l) => l.voice_profile || 'female');
        const voiceNames = lines.map((l) => l.voice_name || '');
        const longest = [...lines].sort((a, b) => (b.text || '').length - (a.text || '').length)[0];
        return {
          name,
          lines: lines.length,
          dubbed: lines.filter((l) => l.audio_url).length,
          seconds: lines.reduce((t, l) => t + Math.max(0, l.end_time - l.start_time), 0),
          profile: mostCommon(profiles),
          voice: mostCommon(voiceNames),
          mixed: new Set(profiles).size > 1 || new Set(voiceNames).size > 1,
          sample: (longest?.text || '').slice(0, 90),
        };
      })
      .sort((a, b) => b.lines - a.lines);
  }, [segments]);

  const unnamed = segments.filter((s) => (s.text || '').trim() && !(s.speaker || '').trim()).length;

  // the built-in voice a type falls back to, so "Default" can say which one that is
  const builtIn = (profile: string) => (MALE.has(profile) ? 'km-KH-PisethNeural' : 'km-KH-SreymomNeural');
  const isBuiltIn = (voice: string) => !voice || /^km-KH-(Piseth|Sreymom)Neural$/.test(voice);
  const custom = voices.filter((v) => !v.is_built_in);
  // a caption refers to a saved voice by its id, which is what the profile calls voice_name
  const voiceId = (v: VoiceProfileItem) => v.voice_name || v.id;

  const draftOf = (row: Row): Draft =>
    drafts[row.name] || { newName: row.name, profile: row.profile, voice: isBuiltIn(row.voice) ? '' : row.voice };
  const setDraft = (row: Row, change: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [row.name]: { ...draftOf(row), ...change } }));

  const changes = useMemo<CastChange[]>(() => rows.flatMap((row) => {
    const d = drafts[row.name];
    if (!d) return [];
    const change: CastChange = { name: row.name };
    const newName = d.newName.trim();
    if (newName && newName !== row.name) change.new_name = newName;
    if (d.profile !== row.profile || row.mixed) change.voice_profile = d.profile;
    const current = isBuiltIn(row.voice) ? '' : row.voice;
    if (d.voice !== current || row.mixed || change.voice_profile) change.voice_name = d.voice;
    return Object.keys(change).length > 1 ? [change] : [];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [rows, drafts]);

  const redub = rows
    .filter((row) => changes.some((c) => c.name === row.name && (c.voice_profile !== undefined || c.voice_name !== undefined)))
    .reduce((t, row) => t + row.dubbed, 0);

  const play = async (row: Row) => {
    audio.current?.pause();
    if (playing === row.name) { setPlaying(''); return; }
    const d = draftOf(row);
    setPlaying(row.name);
    setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/transcripts/tts-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: row.sample, voice_profile: d.profile, voice_name: d.voice || builtIn(d.profile) }),
      });
      const data = res.ok ? await res.json() : null;
      if (!data?.audio_url) throw new Error('No audio came back');
      const el = new Audio(data.audio_url);
      audio.current = el;
      el.onended = el.onerror = () => setPlaying((p) => (p === row.name ? '' : p));
      await el.play();
    } catch {
      setPlaying('');
      setError('Could not play a sample of that voice.');
    }
  };

  const save = async () => {
    if (!changes.length || saving) return;
    setSaving(true);
    setError('');
    try {
      await updateCast(projectId, changes);
      onClose(true);
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || 'Could not save the cast');
      setSaving(false);
    }
  };

  const fieldClass = 'w-full bg-[var(--s3)] border border-[var(--s6)] rounded-lg px-2 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-blue-500';

  return createPortal(
    <div className="fixed inset-0 z-[110] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-3xl max-h-[88vh] flex flex-col rounded-2xl border border-[var(--s5)] bg-[var(--s2)] shadow-2xl text-zinc-200">
        <div className="flex items-start gap-3 px-5 py-4 border-b border-[var(--s3)]">
          <span className="mt-0.5 p-2 rounded-lg bg-blue-600 text-white shrink-0"><Users className="w-4 h-4" /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-white">Cast</h2>
            <p className="text-[11px] text-zinc-400">
              {rows.length} character{rows.length === 1 ? '' : 's'}. A change here applies to every line that character speaks.
            </p>
          </div>
          <button onClick={() => onClose(false)} disabled={saving} aria-label="Close" className="p-1.5 rounded-md text-zinc-500 hover:text-white hover:bg-white/10 disabled:opacity-30">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-2">
          {!rows.length && (
            <p className="py-8 text-center text-xs text-zinc-400">
              No characters yet. {unnamed ? `${unnamed} lines name no speaker — use Identify speakers to work out who says them.` : 'Add captions first.'}
            </p>
          )}

          {rows.length > 0 && (
            <div className="hidden sm:grid grid-cols-[minmax(0,1.4fr)_110px_minmax(0,1.2fr)_36px] gap-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              <span>Character</span><span>Voice type</span><span>Voice</span><span />
            </div>
          )}

          {rows.map((row) => {
            const d = draftOf(row);
            const touched = changes.some((c) => c.name === row.name);
            return (
              <div key={row.name} className={`rounded-xl border p-3 space-y-2 ${touched ? 'border-blue-500/60 bg-blue-600/5' : 'border-[var(--s5)] bg-[var(--s1)]'}`}>
                <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1.4fr)_110px_minmax(0,1.2fr)_36px] gap-2 items-center">
                  <input
                    aria-label={`Name of ${row.name}`}
                    value={d.newName}
                    onChange={(e) => setDraft(row, { newName: e.target.value })}
                    className={`${fieldClass} font-semibold`}
                    title="Rename. Typing another character's name merges the two."
                  />
                  <select aria-label={`Voice type of ${row.name}`} value={d.profile} onChange={(e) => setDraft(row, { profile: e.target.value })} className={fieldClass}>
                    {TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                  </select>
                  <select aria-label={`Voice of ${row.name}`} value={d.voice} onChange={(e) => setDraft(row, { voice: e.target.value })} className={fieldClass}>
                    <option value="">Default {MALE.has(d.profile) ? 'male' : 'female'} voice</option>
                    {custom.length > 0 && (
                      <optgroup label="Your voices">
                        {custom.map((v) => <option key={v.id} value={voiceId(v)}>{v.name}</option>)}
                      </optgroup>
                    )}
                    {d.voice && !custom.some((v) => voiceId(v) === d.voice) && <option value={d.voice}>A voice that is no longer saved</option>}
                  </select>
                  <button
                    onClick={() => void play(row)}
                    title="Hear this character's longest line in the chosen voice"
                    aria-label={`Play a sample for ${row.name}`}
                    className="h-8 w-9 flex items-center justify-center rounded-lg border border-[var(--s6)] text-zinc-300 hover:text-white hover:bg-[var(--s4)]"
                  >
                    {playing === row.name ? <Pause className="w-3.5 h-3.5 text-blue-300" /> : <Play className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <p className="text-[11px] text-zinc-500 truncate">
                  {row.lines} line{row.lines === 1 ? '' : 's'} · {Math.round(row.seconds)}s · {row.dubbed} dubbed
                  {row.mixed && <span className="text-amber-300"> · lines are in more than one voice — saving puts them all in this one</span>}
                  <span className="font-khmer"> · “{row.sample}”</span>
                </p>
              </div>
            );
          })}

          {unnamed > 0 && rows.length > 0 && (
            <p className="text-[11px] text-amber-300/90">
              {unnamed} line{unnamed === 1 ? ' names' : 's name'} no speaker and {unnamed === 1 ? 'is' : 'are'} not listed here. Identify speakers works out who says them.
            </p>
          )}
          {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-[var(--s3)]">
          <p className="text-[11px] text-zinc-500">
            {changes.length
              ? `${changes.length} character${changes.length === 1 ? '' : 's'} changed${redub ? ` · ${redub} dubbed line${redub === 1 ? '' : 's'} will need dubbing again` : ''}`
              : 'A version is saved before any change.'}
          </p>
          <div className="flex gap-2">
            <button onClick={() => onClose(false)} disabled={saving} className="px-4 py-2 rounded-xl text-xs text-zinc-400 hover:text-white hover:bg-[var(--s4)] disabled:opacity-40">Cancel</button>
            <button onClick={() => void save()} disabled={!changes.length || saving} className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-bold text-xs flex items-center gap-1.5">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save cast
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
