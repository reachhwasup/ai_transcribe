import type { VoiceEQ } from '../api/client';

export const DEFAULT_VOICE_EQ: VoiceEQ = { enabled: false, low_cut: 80, warmth: 0, mud: 0, presence: 0, air: 0 };
const presets: Record<string, Omit<VoiceEQ, 'enabled'>> = {
  Flat: { low_cut: 20, warmth: 0, mud: 0, presence: 0, air: 0 },
  'Clear voice': { low_cut: 90, warmth: 0, mud: -3, presence: 3, air: 1 },
  Warm: { low_cut: 60, warmth: 3, mud: -1, presence: 0, air: -1 },
  Bright: { low_cut: 80, warmth: -1, mud: -2, presence: 3, air: 4 },
  'De-boom': { low_cut: 140, warmth: -4, mud: -3, presence: 1, air: 0 },
};
const bands = [
  { key: 'low_cut', label: 'Low cut', hint: '12 dB/oct', min: 20, max: 300, step: 5, unit: 'Hz' },
  { key: 'warmth', label: 'Warmth', hint: '150 Hz', min: -12, max: 12, step: 0.5, unit: 'dB' },
  { key: 'mud', label: 'Mud', hint: '350 Hz', min: -12, max: 12, step: 0.5, unit: 'dB' },
  { key: 'presence', label: 'Presence', hint: '3 kHz', min: -12, max: 12, step: 0.5, unit: 'dB' },
  { key: 'air', label: 'Air', hint: '8 kHz', min: -12, max: 12, step: 0.5, unit: 'dB' },
] as const;

export default function VoiceEQPanel({ value, onChange, disabled }: { value: VoiceEQ; onChange: (value: VoiceEQ) => void; disabled: boolean }) {
  return <fieldset disabled={disabled} className="rounded-xl border border-[var(--s6)] bg-[rgb(var(--s3-rgb)/0.5)] p-4 space-y-4">
    <div className="flex justify-between items-center">
      <label className="flex gap-2 items-center text-sm font-semibold"><input type="checkbox" checked={value.enabled} onChange={e => onChange({ ...value, enabled: e.target.checked })} className="accent-purple-500" />Voice EQ</label>
      <button className="text-xs text-purple-300" onClick={() => onChange({ ...DEFAULT_VOICE_EQ, enabled: value.enabled })}>Reset</button>
    </div>
    <p className="text-xs text-zinc-400">Shape the captured voice. Listen to selection previews these settings; saving applies them to the cloning sample.</p>
    <div className="flex gap-2 flex-wrap">{Object.entries(presets).map(([name, preset]) => <button key={name}
      aria-pressed={value.enabled && Object.entries(preset).every(([k, v]) => value[k as keyof VoiceEQ] === v)}
      onClick={() => onChange({ ...preset, enabled: true })}
      className={`rounded-full border px-3 py-1 text-xs ${value.enabled && Object.entries(preset).every(([k, v]) => value[k as keyof VoiceEQ] === v) ? 'border-purple-400 text-purple-200 bg-purple-500/20' : 'border-[var(--s6)] text-zinc-400'}`}>{name}</button>)}</div>
    <div className={`grid grid-cols-2 sm:grid-cols-5 gap-3 ${value.enabled ? '' : 'opacity-40'}`}>
      {bands.map(band => <label key={band.key} className="space-y-2 text-xs min-w-0">
        <span className="block text-zinc-200">{band.label}</span><span className="block text-[10px] text-zinc-500">{band.hint}</span>
        <input aria-label={band.label} disabled={!value.enabled || disabled} type="range" min={band.min} max={band.max} step={band.step} value={value[band.key]}
          onChange={e => onChange({ ...value, [band.key]: Number(e.target.value) })} className="w-full accent-purple-500" />
        <output className="block text-purple-300 font-mono">{value[band.key] > 0 && band.unit === 'dB' ? '+' : ''}{value[band.key]} {band.unit}</output>
      </label>)}
    </div>
    <p className="text-[11px] text-zinc-500">{value.enabled ? 'EQ enabled · peak limiting protects the saved sample from clipping.' : 'EQ bypassed · original audio will be captured.'}</p>
  </fieldset>;
}
