import { useEffect, useRef, useState } from 'react';
import { createVoiceGroup, fetchVoiceGroups, fetchVoiceProfiles, updateVoiceProfile, type VoiceGroup, type VoiceProfileItem } from '../api/client';

export default function VoiceGroups({ selected, onSelect, refresh, disabled }: {
  selected: string; onSelect: (id: string) => void; refresh: number; disabled: boolean;
}) {
  const [groups, setGroups] = useState<VoiceGroup[]>([]);
  const [profiles, setProfiles] = useState<VoiceProfileItem[]>([]);
  const [filter, setFilter] = useState('all');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => { audio.current?.pause(); }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([fetchVoiceGroups(), fetchVoiceProfiles()]).then(([g, p]) => {
      if (active) { setGroups(g); setProfiles(p.filter(v => !v.is_built_in)); setError(''); }
    }).catch(() => { if (active) setError('Unable to load voice groups.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh, retry]);
  async function addGroup() {
    if (!name.trim()) return;
    setPending(true); setError('');
    try {
      const group = await createVoiceGroup(name);
      setGroups(g => [...g, group]); onSelect(group.id); setFilter(group.id); setName(''); setAdding(false);
    } catch (e: any) { setError(e.response?.data?.detail || 'Unable to create group.'); }
    finally { setPending(false); }
  }
  async function moveProfile(profile: VoiceProfileItem, groupId: string) {
    setPending(true); setError('');
    try {
      const updated = await updateVoiceProfile(profile.id, { group_id: groupId });
      setProfiles(items => items.map(p => p.id === profile.id ? updated : p));
    } catch { setError('Unable to move voice to this group.'); }
    finally { setPending(false); }
  }
  const visible = profiles.filter(p => filter === 'all' || (p.group_id || '') === filter);
  const locked = disabled || pending || loading;
  return <section className="space-y-3 border-t border-[var(--s5)] pt-4">
    <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Voice group</h3>
    <div className="flex flex-wrap gap-1.5">
      {[{ id: 'all', name: 'All voices' }, { id: '', name: 'Ungrouped' }, ...groups].map(g => <button key={g.id} disabled={locked} aria-pressed={filter === g.id}
        onClick={() => { setFilter(g.id); if (g.id !== 'all') onSelect(g.id); }}
        className={`rounded-full border px-2 py-1 text-[11px] disabled:opacity-40 ${filter === g.id ? 'border-purple-400 bg-purple-500/20 text-purple-200' : 'border-[var(--s6)] text-zinc-400'}`}>
        {g.name} · {profiles.filter(p => g.id === 'all' || (p.group_id || '') === g.id).length}
      </button>)}
      <button disabled={locked} onClick={() => setAdding(!adding)} className="rounded-full border border-dashed border-zinc-600 px-2 py-1 text-[11px] text-purple-300">+ New group</button>
    </div>
    {adding && <div className="flex gap-2"><input autoFocus aria-label="New voice group name" placeholder="Group name" maxLength={80} value={name} disabled={pending} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void addGroup(); } }} className="min-w-0 flex-1 rounded border border-[var(--s6)] bg-[var(--s3)] px-2 py-1 text-xs" />
      <button disabled={locked || !name.trim()} onClick={() => void addGroup()} className="text-xs text-purple-300 disabled:opacity-40">Create</button></div>}
    <label className="block text-xs text-zinc-400 space-y-1">Save new voice in<select value={selected} disabled={locked} onChange={e => onSelect(e.target.value)} className="block w-full rounded border border-[var(--s6)] bg-[var(--s3)] p-2 text-zinc-200">
      <option value="">Ungrouped</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
    </select></label>
    <div className="max-h-48 overflow-y-auto space-y-2">
      {loading ? <p className="text-xs text-zinc-500">Loading voices…</p> : !visible.length && <p className="text-xs text-zinc-500">No saved voices in this group yet.</p>}
      {visible.map(p => <div key={p.id} className="rounded border border-[var(--s5)] p-2 space-y-1">
        <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-purple-400 shrink-0" /><span className="truncate flex-1 text-xs" title={p.name}>{p.name}</span>
          <button disabled={disabled || !p.sample_audio_url} aria-label={`${playing === p.id ? 'Stop' : 'Preview'} ${p.name}`} className="text-xs text-purple-300 disabled:opacity-30" onClick={() => {
            audio.current?.pause();
            if (playing === p.id) { setPlaying(''); return; }
            const player = new Audio(p.sample_audio_url); audio.current = player; setPlaying(p.id);
            player.onended = () => setPlaying('');
            void player.play().catch(() => { setPlaying(''); setError('Unable to play this voice sample.'); });
          }}>{playing === p.id ? 'Stop' : '▶'}</button></div>
        <select aria-label={`Group for ${p.name}`} disabled={locked} value={p.group_id || ''} onChange={e => void moveProfile(p, e.target.value)} className="w-full bg-[var(--s3)] text-[11px] text-zinc-400 rounded p-1">
          <option value="">Ungrouped</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>)}
    </div>
    {error && <p role="alert" className="text-xs text-red-400">{error} <button onClick={() => setRetry(r => r + 1)} className="underline">Retry</button></p>}
  </section>;
}
