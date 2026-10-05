import { applyVoiceFx } from '../api/client';
import { useProjectStore } from '../stores/projectStore';
import type { Segment } from '../types';

export type VoiceEffectGroup = 'Normal' | 'Mind & dreams' | 'Devices' | 'Places' | 'Characters';

// Ordered as a menu reads: everyday, inside the head, devices, places, then characters
export const VOICE_EFFECTS: { value: string; label: string; hint: string; group: VoiceEffectGroup }[] = [
  { value: 'normal', label: 'Normal', hint: 'The voice as generated', group: 'Normal' },
  { value: 'inner', label: 'Inner voice', hint: 'A thought, close and dry', group: 'Mind & dreams' },
  { value: 'dream', label: 'Dream', hint: 'Soft and floating, in a big dark wash', group: 'Mind & dreams' },
  { value: 'flashback', label: 'Flashback', hint: 'A memory: faded and worn, like an old film', group: 'Mind & dreams' },
  { value: 'nightmare', label: 'Nightmare', hint: 'Lower, swirling, swallowed by darkness', group: 'Mind & dreams' },
  { value: 'heavenly', label: 'Heavenly', hint: 'A god, an angel or a vision — bright and airy', group: 'Mind & dreams' },
  { value: 'phone', label: 'Phone', hint: 'A phone call', group: 'Devices' },
  { value: 'walkie', label: 'Walkie-talkie', hint: 'Police or security radio', group: 'Devices' },
  { value: 'radio', label: 'Radio / PA', hint: 'A broadcast or a tannoy', group: 'Devices' },
  { value: 'megaphone', label: 'Megaphone', hint: 'A loudhailer', group: 'Devices' },
  { value: 'vintage', label: 'Old recording', hint: 'A tape from long ago', group: 'Devices' },
  { value: 'hall', label: 'Hall / temple', hint: 'A big hall, temple or cave', group: 'Places' },
  { value: 'echo', label: 'Echo / canyon', hint: 'Calling across a valley', group: 'Places' },
  { value: 'underwater', label: 'Underwater', hint: 'Under water, or through a wall', group: 'Places' },
  { value: 'ghost', label: 'Ghostly', hint: 'Otherworldly, thin, with a long tail', group: 'Characters' },
  { value: 'robot', label: 'Robot / AI', hint: 'A machine voice', group: 'Characters' },
  { value: 'monster', label: 'Monster / demon', hint: 'Deep and menacing', group: 'Characters' },
];

/** The effects grouped for menus, in menu order. */
export const VOICE_EFFECT_GROUPS = VOICE_EFFECTS.reduce<{ group: VoiceEffectGroup; items: typeof VOICE_EFFECTS }[]>(
  (acc, fx) => {
    const last = acc[acc.length - 1];
    if (last && last.group === fx.group) last.items.push(fx);
    else acc.push({ group: fx.group, items: [fx] });
    return acc;
  },
  [],
);

export const effectLabel = (fx?: string | null) =>
  VOICE_EFFECTS.find((v) => v.value === (fx || 'normal'))?.label ?? fx ?? 'Normal';

/** Swap restyled lines into the store in place, so every view updates without a reload. */
function mergeSegments(updated: Segment[]) {
  const cur = useProjectStore.getState().currentProject;
  if (!cur || !updated.length) return;
  const byId = new Map(updated.map((s) => [s.id, s]));
  useProjectStore.setState({
    currentProject: { ...cur, segments: cur.segments.map((s) => (byId.has(s.id) ? { ...s, ...byId.get(s.id)! } : s)) },
  });
}

/**
 * Give lines a voice effect. Voiced lines are restyled with ffmpeg (no new TTS); lines whose
 * voice was made with an effect baked in are regenerated once as Normal and then styled.
 * Lines without a voice just remember the effect for when they are dubbed.
 */
export async function applyEffectToLines(ids: string[], fx: string): Promise<void> {
  const store = useProjectStore.getState();
  const project = store.currentProject;
  if (!project || !ids.length) return;
  const projectId = project.id;
  const voiced = ids.filter((id) => project.segments.find((s) => s.id === id)?.audio_url);
  const silent = ids.filter((id) => !voiced.includes(id));

  for (const id of silent) await store.updateSegment(id, { voice_fx: fx });
  if (!voiced.length) return;

  const res = await applyVoiceFx(projectId, voiced, fx);
  mergeSegments(res.segments);
  if (!res.needs_voice.length) return;

  const cur = useProjectStore.getState().currentProject;
  const bySpeed = new Map<number, string[]>();
  for (const id of res.needs_voice) {
    const speed = cur?.segments.find((s) => s.id === id)?.audio_speed || 1;
    bySpeed.set(speed, [...(bySpeed.get(speed) || []), id]);
  }
  for (const [speed, group] of bySpeed) {
    await useProjectStore.getState().generateVoiceForSegments(group, speed, 'B', undefined, undefined, false, 'normal');
  }
  const genError = useProjectStore.getState().error;
  if (genError) throw new Error(genError);
  if (fx !== 'normal') await applyVoiceFx(projectId, res.needs_voice, fx);
  if (useProjectStore.getState().currentProject?.id === projectId) await useProjectStore.getState().loadProject(projectId);
}
