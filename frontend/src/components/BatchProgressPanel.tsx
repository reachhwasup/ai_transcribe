import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronDown, Download, Layers, Loader2, Mic, Music, Palette, RefreshCw, Sparkles, Tags, TriangleAlert, Trash2, Users, Volume2, VolumeX, X } from 'lucide-react';
import {
  fetchProjects,
  selectFolderInSystem,
  fetchRenderQueue,
  removeRenderJob,
  addToPipeline,
  fetchPipeline,
  removePipelineJob,
  approvePipelineJob,
  fixPipelineJob,
  retryPipelineNow,
  fetchPipelineEstimate,
  planJoin,
  fetchSeriesLogo,
  quietly,
  spaceOverlappingLines,
  snapCaptionsToSpeech,
  fixCharacterGenders,
  savePublishSeries,
  generatePublishKit,
  type PipelineJob,
  type RenderJob,
} from '../api/client';
import type { ProjectListItem } from '../types';
import { useBatchStore } from '../utils/batchRunner';
import { nameParts, episodeNumber, episodeFileName } from '../utils/names';
import { toast } from '../utils/toast';
import JoinEpisodes from './JoinEpisodes';
import SeriesReview from './SeriesReview';
import { applyToParts, saveProjectSetting } from '../utils/projectSettings';

const REFRESH_MS = 4000;
/** Fired when the original voices are muted or unmuted for a set of projects at once */
export const VOCALS_MUTE_CHANGED = 'vocals-mute-changed';

const clock = (seconds: number) => {
  const rounded = Math.max(0, Math.round(seconds));
  const m = Math.floor(rounded / 60);
  const s = rounded % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

/** When a job finished or was queued, the way a person says it: "17:40", "Yesterday 16:23". */
function when(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  return days <= 0 ? time : days === 1 ? `Yesterday ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/** Out of Gemini quota: the job is parked until `retry_at` and tried again then */
const waitsForQuota = (job: PipelineJob) => !!job.retry_at && new Date(job.retry_at).getTime() > Date.now();

/** "about 40 min", "about 2 h 10 min" — rounded, because it is an estimate */
function howLong(seconds: number): string {
  if (seconds < 90) return '1 min';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = Math.round((minutes % 60) / 5) * 5;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`;
}

type Stage = { label: string; tone: 'zinc' | 'blue' | 'amber' | 'emerald' | 'red'; progress: number };

const STEP_LABELS: Record<string, string> = {
  repair: 'Fixing captions', music: 'Music', captions: 'Captions', speakers: 'Speakers', dubbing: 'Dubbing', export: 'Export',
};

/** Where one project has got to: its job on the server's queue if it has one, else what the
 *  project list already says about its captions and voices. */
function stageOf(p: ProjectListItem, job?: PipelineJob): Stage {
  if (job?.status === 'running') {
    return { label: `${STEP_LABELS[job.step] || 'Working'}${job.percent ? ` ${job.percent}%` : '…'}`, tone: 'blue', progress: (job.percent || 0) / 100 };
  }
  if (job?.status === 'queued' && waitsForQuota(job)) return { label: 'Waiting for quota', tone: 'amber', progress: 0 };
  if (job?.status === 'queued') return { label: 'In the queue', tone: 'zinc', progress: 0 };
  if (job?.status === 'review') return { label: 'Needs a look', tone: 'amber', progress: 1 };
  if (job?.status === 'error') return { label: 'Failed', tone: 'red', progress: 0 };
  return stageFromCounts(p);
}

function stageFromCounts(p: ProjectListItem): Stage {
  const subs = p.segment_count || 0;
  const dubbed = p.dubbed_count || 0;
  if (p.status === 'error') return { label: 'Failed', tone: 'red', progress: 0 };
  if (p.status === 'transcribing') return { label: 'Writing captions…', tone: 'blue', progress: 0.35 };
  if (!subs) return { label: 'Waiting', tone: 'zinc', progress: 0 };
  if (dubbed >= subs) return { label: 'Dubbed', tone: 'emerald', progress: 1 };
  // The bar shows how much of this part is dubbed, nothing else. It used to sit at half for
  // "transcribed", which read as "half transcribed" — two meanings in one bar.
  return {
    label: dubbed > 0 ? `Needs ${subs - dubbed} voices` : 'No voice yet',
    tone: 'amber',
    progress: dubbed / subs,
  };
}

// Full class strings so Tailwind keeps them
const TONES: Record<Stage['tone'], { text: string; bar: string; dot: string }> = {
  zinc: { text: 'text-zinc-400', bar: 'bg-zinc-600', dot: 'bg-zinc-600' },
  blue: { text: 'text-blue-300', bar: 'bg-blue-500', dot: 'bg-blue-400' },
  amber: { text: 'text-amber-300', bar: 'bg-amber-500', dot: 'bg-amber-400' },
  emerald: { text: 'text-emerald-300', bar: 'bg-emerald-500', dot: 'bg-emerald-400' },
  red: { text: 'text-red-300', bar: 'bg-red-500', dot: 'bg-red-400' },
};

interface Props {
  open: boolean;
  currentProjectId?: string;
  onClose: () => void;
}

/** The episodes in groups of `size` (0: one group). A last group of one joins the group before
 *  it — one episode on its own is not a joined video. */
export function joinGroups(episodes: number[], size: number): number[][] {
  const sorted = [...new Set(episodes)].sort((a, b) => a - b);
  if (!size || size >= sorted.length) return [sorted];
  const groups: number[][] = [];
  for (let i = 0; i < sorted.length; i += size) groups.push(sorted.slice(i, i + size));
  if (groups.length > 1 && groups[groups.length - 1].length < 2) groups[groups.length - 2].push(...groups.pop()!);
  return groups;
}

/** A logo as the editor saves it, as the fields an export asks for */
function logoRequest(logo: Record<string, any>): Record<string, unknown> {
  const custom = logo.position === 'custom';
  return {
    logo_url: logo.url, logo_enabled: true, logo_position: logo.position || 'top_right',
    logo_scale_pct: logo.scale_pct ?? 15, logo_opacity: logo.opacity ?? 1,
    ...(custom ? { logo_x_pct: logo.x_pct, logo_y_pct: logo.y_pct } : {}),
    ...(logo.start != null ? { logo_start: logo.start } : {}),
    ...(logo.end != null ? { logo_end: logo.end } : {}),
  };
}

export default function BatchProgressPanel({ open, currentProjectId, onClose }: Props) {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [allJobs, setJobs] = useState<RenderJob[]>([]);
  const [allWork, setWork] = useState<PipelineJob[]>([]);
  const [tab, setTab] = useState<'parts' | 'work' | 'review' | 'exports'>('parts');
  const [loading, setLoading] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [reviewAction, setReviewAction] = useState<'fix' | 'export' | null>(null);
  const [exportPlatform, setExportPlatform] = useState('custom');
  const [exportFolder, setExportFolder] = useState('');
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [exportVoice, setExportVoice] = useState(true);
  const [exportQuality, setExportQuality] = useState<'compact' | 'standard' | 'high'>('standard');
  const [exportNumbered, setExportNumbered] = useState(true);
  const [exportName, setExportName] = useState<string | null>(null);   // null: the series' own name
  const [seriesLogo, setSeriesLogo] = useState<{ logo: Record<string, any>; from: string } | null>(null);
  const [exportLogo, setExportLogo] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [timeLeft, setTimeLeft] = useState<Record<string, number | null>>({});
  const [joinAfter, setJoinAfter] = useState(false);
  const [joinSize, setJoinSize] = useState(0);        // episodes per joined video; 0: all in one
  const [filter, setFilter] = useState<'all' | 'attention' | 'dubbed'>('all');
  const [search, setSearch] = useState('');
  const [refreshError, setRefreshError] = useState(false);


  const refresh = useCallback(async () => {
    const [list, queue, pipeline, estimate] = await Promise.allSettled([fetchProjects(), fetchRenderQueue(), fetchPipeline(), fetchPipelineEstimate()]);
    if (estimate.status === 'fulfilled') setTimeLeft(estimate.value.jobs);
    setRefreshError([list, queue, pipeline].some((result) => result.status === 'rejected'));
    // a failed poll leaves the last view in place rather than blanking the panel
    if (list.status === 'fulfilled') setProjects(list.value);
    if (queue.status === 'fulfilled') setJobs(queue.value);
    if (pipeline.status === 'fulfilled') setWork(pipeline.value);
  }, []);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    refresh().finally(() => setLoading(false));
    // keep it live while work is running, without hammering the API
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [open, refresh]);

  // The projects this one was made with: the parts of its split, or the videos of its folder
  const { parts, title, kind } = useMemo(() => {
    const current = projects.find((p) => p.id === currentProjectId);
    if (current?.batch_id) {
      const family = projects
        .filter((p) => p.batch_id === current.batch_id)
        .sort((a, b) => (a.batch_index || 0) - (b.batch_index || 0));
      return { parts: family, title: current.batch_name || 'This folder', kind: 'folder' as const };
    }
    const root = current?.source_project_id || current?.id;
    const family = projects
      .filter((p) => p.part_index && (p.source_project_id || p.id) === root)
      .sort((a, b) => (a.part_index || 0) - (b.part_index || 0));
    const name = (family[0]?.name || '').replace(/\s+—\s+Part\s+\d+$/, '');
    return { parts: family, title: name || current?.name || 'This project', kind: 'split' as const };
  }, [projects, currentProjectId]);
  const familyIds = useMemo(() => new Set(parts.length ? parts.map((p) => p.id) : [currentProjectId]), [parts, currentProjectId]);
  const jobs = useMemo(() => allJobs.filter((j) => !currentProjectId || familyIds.has(j.project_id)), [allJobs, familyIds, currentProjectId]);
  const work = useMemo(() => allWork.filter((j) => !currentProjectId || familyIds.has(j.project_id)), [allWork, familyIds, currentProjectId]);
  // the newest server job for each project
  const jobOf = useMemo(() => {
    const latest = new Map<string, PipelineJob>();
    for (const j of work) {
      const seen = latest.get(j.project_id);
      if (!seen || j.queued_at > seen.queued_at) latest.set(j.project_id, j);
    }
    return latest;
  }, [work]);
  // what this tab is still doing for the open project — uploading or cutting it
  const batches = useBatchStore((s) => s.batches);
  const inBrowser = batches.find((b) => b.phase === 'browser' && (b.projectId === currentProjectId || b.items.some((i) => i.projectId === currentProjectId)));
  const unit = kind === 'folder' ? 'video' : 'part';
  const activeHere = parts.filter((p) => jobOf.get(p.id)?.status === 'running' || jobOf.get(p.id)?.status === 'queued').length;
  const primaryAction = 'flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-blue-600 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40';
  const quietAction = 'flex items-center justify-center gap-1.5 rounded-lg border border-[var(--s5)] px-2.5 py-1.5 text-[11px] font-semibold text-zinc-300 transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40';

  // The original voices track of every project here, muted or not. It is kept with the other
  // track mutes in each project's own storage, and the open editor is told to follow.
  const [mutesVersion, setMutesVersion] = useState(0);
  const voicesMuted = (id: string) => {
    try { return !!JSON.parse(localStorage.getItem(`timeline-mutes-${id}`) || '{}').v1; } catch { return false; }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const allVoicesMuted = useMemo(() => parts.length > 0 && parts.every((p) => voicesMuted(p.id)), [parts, mutesVersion, open]);
  const muteVoices = (muted: boolean) => {
    for (const p of parts) {
      try {
        const key = `timeline-mutes-${p.id}`;
        const mutes = { ...JSON.parse(localStorage.getItem(key) || '{}'), v1: muted };
        localStorage.setItem(key, JSON.stringify(mutes));
        // kept with the project too, so it holds in another browser or after clearing this one
        saveProjectSetting(p.id, 'track_mutes', mutes);
      } catch { /* storage unavailable: nothing to remember */ }
    }
    window.dispatchEvent(new CustomEvent(VOCALS_MUTE_CHANGED, { detail: { muted, projectIds: parts.map((p) => p.id) } }));
    setMutesVersion((v) => v + 1);
  };

  const done = parts.filter((p) => (p.segment_count || 0) > 0).length;
  const dubbed = parts.filter((p) => (p.dubbed_count || 0) >= (p.segment_count || 0) && (p.segment_count || 0) > 0).length;
  const working = parts.some((p) => p.status === 'transcribing');
  const activeJobs = jobs.filter((j) => j.status === 'queued' || j.status === 'rendering');

  // The parts are worked through on the server, one at a time: each part already runs its own
  // chunks in parallel, and stacking parts on top trips the API rate limit. This used to be
  // driven from this page and stopped the moment it was closed.
  const [queueing, setQueueing] = useState(false);
  const available = parts.filter((p) => !['queued', 'running', 'review'].includes(jobOf.get(p.id)?.status || '') && p.status !== 'transcribing');
  const needTranscribe = available.filter((p) => !(p.segment_count || 0));
  const needDub = available.filter((p) => (p.segment_count || 0) > (p.dubbed_count || 0));
  const needAnything = available.filter((p) => !(p.segment_count || 0) || (p.segment_count || 0) > (p.dubbed_count || 0));
  const activeWork = work.filter((j) => j.status === 'queued' || j.status === 'running');
  const heldWork = work.filter((j) => j.status === 'review');

  const totalCaptions = parts.reduce((sum, p) => sum + (p.segment_count || 0), 0);
  const totalVoiced = parts.reduce((sum, p) => sum + Math.min(p.dubbed_count || 0, p.segment_count || 0), 0);
  const voicePercent = totalCaptions ? Math.round(totalVoiced / totalCaptions * 100) : 0;
  const needsAttention = (p: ProjectListItem) => {
    const stage = stageOf(p, jobOf.get(p.id));
    return ['amber', 'red'].includes(stage.tone) || !!p.transcribe_warning
      || (stage.label === 'Waiting' && !(p.segment_count || 0));
  };
  const attentionCount = parts.filter(needsAttention).length;
  const visibleParts = parts.filter((p) => p.name.toLowerCase().includes(search.toLowerCase())
    && (filter === 'all' || (filter === 'attention' ? needsAttention(p) : stageOf(p, jobOf.get(p.id)).label === 'Dubbed')));

  // Two things worth acting on before dubbing or exporting: work that failed, and episodes
  // whose lines name no speaker (those are all dubbed in one default voice).
  const failedParts = parts.filter((p) => jobOf.get(p.id)?.status === 'error');
  const unnamedParts = available.filter((p) => (p.unnamed_count || 0) > 0 && (p.segment_count || 0) > 0);
  const retryFailed = async (targets = failedParts) => {
    if (queueing || !targets.length) return;
    setQueueing(true);
    let count = 0;
    try {
      for (const part of targets) {
        const steps = jobOf.get(part.id)?.steps || [];
        try {
          // the same steps that were asked for; each one skips what is already done
          await addToPipeline(part.id, {
            language: part.language || 'km',
            music: steps.includes('music'),
            captions: steps.includes('captions'),
            speakers: steps.includes('speakers'),
            dub: steps.includes('dubbing'),
            export: steps.includes('export'),
          });
          count++;
        } catch { /* reported below by the count */ }
      }
      toast({ tone: count === targets.length ? 'success' : 'warning', title: `${count} of ${targets.length} queued again`, detail: 'Each step skips what was already done.' });
    } finally {
      setQueueing(false);
      await refresh();
    }
  };
  const identifyAll = async () => {
    if (queueing || !unnamedParts.length) return;
    setQueueing(true);
    let count = 0;
    try {
      for (const part of unnamedParts) {
        try {
          await addToPipeline(part.id, { language: part.language || 'km', captions: false, dub: false, speakers: true });
          count++;
        } catch { /* counted below */ }
      }
      toast({
        tone: count ? 'success' : 'error',
        title: `Finding the speakers in ${count} ${unit}${count === 1 ? '' : 's'}`,
        detail: 'Uses Gemini. Lines already voiced keep their voice — dub again the ones whose voice should change.',
      });
    } finally {
      setQueueing(false);
      await refresh();
    }
  };

  // --- More to do for every episode at once ---------------------------------------------
  const [moreOpen, setMoreOpen] = useState(false);
  const [allBusy, setAllBusy] = useState<{ key: string; done: number; total: number } | null>(null);
  const partName = (p: ProjectListItem) => (kind === 'folder' ? nameParts(p.name).tail : `Part ${p.part_index}`);
  /** Run one thing for each episode in turn, and say once how it went. */
  const forAll = async (
    key: string,
    targets: ProjectListItem[],
    one: (p: ProjectListItem, index: number) => Promise<string | void>,
    summary: (ok: number, notes: string[]) => { title: string; detail?: string },
  ) => {
    if (allBusy || !targets.length) return;
    setAllBusy({ key, done: 0, total: targets.length });
    const failures: string[] = [];
    const notes: string[] = [];
    let ok = 0;
    await quietly(async () => {
      for (const [i, p] of targets.entries()) {
        try {
          const note = await one(p, i);
          if (note) notes.push(note);
          ok++;
        } catch (e: any) {
          failures.push(`${partName(p)}: ${e?.response?.data?.detail || e?.message || 'failed'}`);
        }
        setAllBusy({ key, done: i + 1, total: targets.length });
      }
    });
    setAllBusy(null);
    const said = summary(ok, notes);
    toast({
      tone: failures.length ? (ok ? 'warning' : 'error') : 'success',
      title: said.title,
      detail: [said.detail, failures.length ? `${failures.length} failed — ${failures[0]}` : ''].filter(Boolean).join(' ') || undefined,
    });
    await refresh();
  };

  const isolateAll = () => forAll('music', available,
    (p) => addToPipeline(p.id, { language: p.language || 'km', captions: false, dub: false, music: true }).then(() => undefined),
    (ok) => ({ title: `Music isolation queued for ${ok} ${unit}${ok === 1 ? '' : 's'}`, detail: 'Those already isolated are skipped. It runs on this computer, one after another.' }));

  const lookForAll = async () => {
    if (allBusy || !currentProjectId || parts.length < 2) return;
    if (!confirm(`Give every other ${unit} this one’s look — caption style, frame shape, colour filter and logo?\n\nIt replaces what they have now.`)) return;
    setAllBusy({ key: 'look', done: 0, total: 1 });
    try {
      const report = await quietly(() => applyToParts(currentProjectId, ['caption_style', 'aspect_ratio', 'video_filter', 'logo']));
      toast({ tone: 'success', title: `Look copied to ${report.parts.length} ${unit}${report.parts.length === 1 ? '' : 's'}`, detail: 'Caption style, frame shape, colour filter and logo. Blur boxes are left as they are.' });
    } catch (e: any) {
      toast({ tone: 'error', title: 'The look could not be copied', detail: e?.response?.data?.detail || e?.message });
    } finally {
      setAllBusy(null);
    }
  };

  // lines that start before the one before them has finished are voiced on top of each other
  const overlapsForAll = () => forAll('overlaps', available.filter((p) => (p.segment_count || 0) > 0),
    async (p) => {
      const { moved, to_revoice } = await spaceOverlappingLines(p.id);
      if (to_revoice.length) await addToPipeline(p.id, { language: p.language || 'km', captions: false, dub: true });
      return moved ? `${moved}` : undefined;
    },
    (ok, notes) => {
      const moved = notes.reduce((sum, n) => sum + Number(n), 0);
      return moved
        ? { title: `${moved} overlapping lines spaced apart`, detail: `In ${notes.length} of ${ok} ${unit}s. The moved lines are being dubbed again.` }
        : { title: 'No overlapping lines found', detail: `Checked ${ok} ${unit}${ok === 1 ? '' : 's'}.` };
    });

  // each line moved onto the moment the actor really speaks it, and dubbed again to fit
  const lipTimingForAll = () => {
    const targets = available.filter((p) => (p.segment_count || 0) > 0);
    if (!targets.length) return;
    if (!confirm(`Match the dub to the actors' mouths in ${targets.length} ${unit}${targets.length === 1 ? '' : 's'}?\n\nEach line is moved to where the original actor starts and stops speaking, found in the isolated voice track. Lines whose time changes are dubbed again to fit. A version of each ${unit} is saved first. ${unit[0].toUpperCase()}${unit.slice(1)}s without isolated music are skipped.`)) return;
    void forAll('lips', targets,
      async (p) => {
        const { moved, to_revoice } = await snapCaptionsToSpeech(p.id, true);
        if (to_revoice) await addToPipeline(p.id, { language: p.language || 'km', captions: false, dub: true });
        return `${moved}:${to_revoice || 0}`;
      },
      (ok, notes) => {
        const moved = notes.reduce((sum, n) => sum + Number(n.split(':')[0]), 0);
        const again = notes.reduce((sum, n) => sum + Number(n.split(':')[1]), 0);
        return moved
          ? { title: `${moved} lines moved onto the actors' speech`, detail: `In ${ok} ${unit}${ok === 1 ? '' : 's'}. ${again} ${again === 1 ? 'is' : 'are'} being dubbed again to fit.` }
          : { title: 'Every line already sits on its speech', detail: `Checked ${ok} ${unit}${ok === 1 ? '' : 's'}.` };
      });
  };

  const gendersForAll = () => {
    if (!confirm(`Give each character one voice in every ${unit}?\n\nThis uses Gemini once per ${unit}. Lines whose voice changes are dubbed again.`)) return;
    void forAll('genders', available.filter((p) => (p.segment_count || 0) > 0),
      async (p) => {
        const fix = await fixCharacterGenders(p.id);
        const changed = fix.characters.reduce((sum, c) => sum + (c.lines_changed || 0), 0);
        if (changed) await addToPipeline(p.id, { language: p.language || 'km', captions: false, dub: true });
        return changed ? `${changed}` : undefined;
      },
      (ok, notes) => {
        const changed = notes.reduce((sum, n) => sum + Number(n), 0);
        return changed
          ? { title: `${changed} lines given their character’s voice`, detail: `In ${notes.length} of ${ok} ${unit}s. They are being dubbed again.` }
          : { title: 'Every character already has one voice', detail: `Checked ${ok} ${unit}${ok === 1 ? '' : 's'}.` };
      });
  };

  const titlesForAll = () => {
    const targets = parts.filter((p) => (p.segment_count || 0) > 0);
    if (!targets.length) return;
    if (!confirm(`Write titles and tags for ${targets.length} ${unit}${targets.length === 1 ? '' : 's'}?\n\nEach is written as part N of ${parts.length} of “${title}”, so the titles are about that ${unit} and carry its number. This uses Gemini once per ${unit} and replaces titles already written. Keep this tab open while it runs.`)) return;
    void forAll('titles', targets,
      async (p) => {
        // told it is one part of a series, each episode is written up as itself
        await savePublishSeries(p.id, { series_name: title, part: p.batch_index || p.part_index || 0, total_parts: parts.length, premise: '' });
        await generatePublishKit(p.id, 'viral', 'all');
      },
      (ok) => ({ title: `Titles and tags written for ${ok} ${unit}${ok === 1 ? '' : 's'}`, detail: 'Open Export → Titles & tags in each to read, edit and copy them.' }));
  };

  const runBatch = async (kind: 'transcribe' | 'dub' | 'both') => {
    const targets = kind === 'transcribe' ? needTranscribe : kind === 'dub' ? needDub : needAnything;
    if (!targets.length || queueing) return;
    const what = kind === 'transcribe' ? 'Transcribe' : kind === 'dub' ? 'Dub' : 'Transcribe and dub';
    if (
      !confirm(
        `${what} ${targets.length} ${unit}(s), one after another?\n\n` +
          `This runs on the server, so you can keep working or close the page. Progress shows under Work.`,
      )
    )
      return;
    setQueueing(true);
    try {
      for (const part of targets) {
        await addToPipeline(part.id, {
          language: part.language || 'km',
          captions: kind !== 'dub',
          // imported subtitles name nobody; the server works out who speaks before voicing
          // (and skips this when every line already has a speaker)
          speakers: kind !== 'transcribe',
          dub: kind !== 'transcribe',
        });
      }
      setTab('work');
    } catch (e: any) {
      alert(e?.response?.data?.detail || e?.message || `Could not queue the ${unit}s`);
    } finally {
      setQueueing(false);
      await refresh();
    }
  };
  const actOnReviews = async (action: 'fix' | 'export', targets = heldWork) => {
    if (reviewAction || !targets.length) return;
    setReviewAction(action);
    let count = 0;
    const failures: string[] = [];
    try {
      for (const job of targets) {
        try {
          await (action === 'fix' ? fixPipelineJob(job.id) : approvePipelineJob(job.id));
          count++;
        } catch { failures.push(job.project_name); }
      }
      toast({ tone: failures.length ? 'warning' : 'success',
        title: `${count} ${action === 'fix' ? 'repair jobs' : 'exports'} queued`,
        detail: failures.length ? `Could not queue: ${failures.join(', ')}. Refresh and try again.`
          : action === 'fix' ? 'Timing and long lines will be repaired, affected voices regenerated, then exports reviewed again.'
          : 'Review warnings bypassed. Follow rendering in Exports.',
      });
    } finally { setReviewAction(null); await refresh(); }
  };

  // one name for the whole series, numbered by episode, so the files sort in order
  const seriesName = exportName ?? title;
  const episodeOf = (part: ProjectListItem) => episodeNumber(part.name, kind === 'folder' ? (part.batch_index || 0) + 1 : part.part_index || 1);
  const fileNameOf = (part: ProjectListItem) => episodeFileName(seriesName, episodeOf(part), parts.length);

  // the logo any episode already shows, offered for all of them
  useEffect(() => {
    if (!exportOpen || !currentProjectId) return;
    let alive = true;
    fetchSeriesLogo(currentProjectId)
      .then((found) => { if (alive) setSeriesLogo(found.logo ? { logo: found.logo, from: found.project_name || '' } : null); })
      .catch(() => { if (alive) setSeriesLogo(null); });
    return () => { alive = false; };
  }, [exportOpen, currentProjectId]);

  // when this series' work will be done: the last of its jobs in the queue
  const lineUp = work.filter((j) => (j.status === 'running' || j.status === 'queued') && !waitsForQuota(j));
  const lefts = lineUp.map((j) => timeLeft[j.id]);
  const secondsLeft = lineUp.length && lefts.every((v) => typeof v === 'number') ? Math.max(...(lefts as number[])) : null;

  const waitingForQuota = work.filter((j) => j.status === 'queued' && waitsForQuota(j));
  const retryNow = async () => {
    setRetrying(true);
    try {
      const { retried } = await retryPipelineNow();
      toast({ tone: 'info', title: `Trying ${retried} video${retried === 1 ? '' : 's'} again now` });
    } catch {
      toast({ tone: 'error', title: 'Could not start them again' });
    } finally { setRetrying(false); await refresh(); }
  };

  const exportAll = async () => {
    if (exporting || inBrowser || !parts.length) return;
    setExporting(true);
    let queued = 0;
    let skipped = 0;
    const failures: string[] = [];
    const queuedEpisodes: number[] = [];
    try {
      // Refresh first: renders may have been started from another editor since the poll.
      const [renders, pipeline] = await Promise.all([fetchRenderQueue(), fetchPipeline()]);
      for (const part of parts) {
        const alreadyExporting = renders.some((j) => j.project_id === part.id && ['queued', 'rendering'].includes(j.status))
          || pipeline.some((j) => j.project_id === part.id && ['queued', 'running', 'review'].includes(j.status) && j.steps.includes('export'));
        if (alreadyExporting) { skipped++; continue; }
        try {
          await addToPipeline(part.id, {
            captions: false, dub: false, export: true, hold_for_review: true,
            export_request: {
              platform: exportPlatform,
              include_subtitles: true,
              include_voice: exportVoice,
              background_audio: exportVoice ? 'music' : 'original',
              ...(exportFolder.trim() ? { export_folder: exportFolder.trim() } : {}),
              quality: exportQuality,
              ...(exportNumbered ? { output_filename: fileNameOf(part) } : {}),
              ...(seriesLogo && exportLogo ? logoRequest(seriesLogo.logo) : {}),
            },
          });
          queued++;
          queuedEpisodes.push(episodeOf(part));
        } catch {
          failures.push(part.name);
        }
      }
      let joinNote = '';
      if (joinAfter && queuedEpisodes.length >= 2) {
        try {
          const groups = joinGroups(queuedEpisodes, joinSize);
          await planJoin({ folder: exportFolder.trim(), series: exportNumbered ? seriesName : title, name: seriesName, groups });
          joinNote = `They are joined into ${groups.length === 1 ? 'one video' : `${groups.length} videos`} when the exports finish.`;
        } catch {
          joinNote = 'Could not set up the joining; join them from the Exports tab afterwards.';
        }
      }
      setTab('work');
      setExportOpen(false);
      toast({
        tone: failures.length ? 'warning' : 'success',
        title: `${queued} export${queued === 1 ? '' : 's'} queued`,
        detail: [
          skipped ? `${skipped} already queued.` : '',
          failures.length ? `Could not queue: ${failures.join(', ')}. Try again for these videos.` : '',
          'Exports wait for current work and appear under Exports when rendering starts.',
          joinNote,
        ].filter(Boolean).join(' '),
      });
    } catch (e: any) {
      toast({ tone: 'error', title: 'Could not queue exports', detail: e?.message || 'Please try again.' });
    } finally {
      setExporting(false);
      await refresh();
    }
  };
  const finishedJobs = jobs.filter((j) => j.status !== 'queued' && j.status !== 'rendering');

  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden="true" />}
      <aside
        className={`fixed left-0 top-0 z-50 flex h-full w-[380px] max-w-[100vw] flex-col border-r border-[var(--s4)] bg-[var(--s2)] shadow-2xl transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-hidden={!open}
        inert={!open}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--s3)] px-4 py-3.5">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
              {tab === 'exports' ? (
                <Download className="h-4 w-4 text-blue-400" />
              ) : (
                <Layers className="h-4 w-4 text-blue-400" />
              )}
              {tab === 'exports' ? 'Export queue' : tab === 'work' ? 'Work queue' : kind === 'folder' ? 'Folder progress' : 'Parts progress'}
            </h2>
            <p className="mt-0.5 truncate text-[11px] text-zinc-400">
              {tab === 'exports'
                ? activeJobs.length
                  ? `${activeJobs.length} running or waiting`
                  : 'Renders run one at a time'
                : tab === 'work'
                  ? activeWork.length
                    ? `${activeWork.length} running or waiting`
                    : 'Captions and dubbing, one project at a time'
                  : title}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={async () => { setLoading(true); try { await refresh(); } finally { setLoading(false); } }}
              disabled={loading}
              className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-white/10 hover:text-white"
              aria-label="Refresh progress"
              title="Refresh now"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              aria-label="Close folder progress"
              className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex shrink-0 gap-1 border-b border-[var(--s3)] px-3 pb-2 pt-1">
          {([['parts', `${kind === 'folder' ? 'Videos' : 'Parts'}${parts.length ? ` (${parts.length})` : ''}`],
             ['work', `Work${activeWork.length + heldWork.length ? ` (${activeWork.length + heldWork.length})` : ''}`],
             ['review', 'Review'],
             ['exports', `Exports${activeJobs.length ? ` (${activeJobs.length})` : ''}`]] as const).map(
            ([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex-1 rounded-md py-1.5 text-[11px] font-semibold transition-colors ${
                  tab === key ? 'bg-white/10 text-white' : 'text-zinc-400 hover:bg-white/5 hover:text-white'
                }`}
              >
                {label}
              </button>
            ),
          )}
        </div>

        {refreshError && <p role="status" className="border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-[11px] text-amber-300">Could not refresh all progress. Showing the last available information.</p>}

        {tab === 'parts' && inBrowser && (
          <div role="status" className="shrink-0 border-b border-[var(--s3)] px-4 py-3">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-blue-300">
              <Loader2 className="h-3 w-3 animate-spin" />
              {inBrowser.kind === 'folder' ? `Adding “${inBrowser.title}”` : `Preparing “${inBrowser.title}”`}
            </p>
            <p className="mt-1 truncate text-[11px] text-zinc-400">{inBrowser.message}</p>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/5">
              <div className="h-full rounded-full bg-blue-500 transition-[width]" style={{ width: `${inBrowser.percent}%` }} />
            </div>
            <p className="mt-1.5 text-[10px] text-zinc-500">
              {inBrowser.kind === 'folder'
                ? 'The rest of the videos appear here as they are uploaded. Keep this tab open until then.'
                : 'The parts appear here once the video is cut. Keep this tab open until then.'}
            </p>
          </div>
        )}

        {tab === 'parts' && parts.length > 0 && (
          <div className="max-h-[65vh] shrink-0 overflow-y-auto border-b border-[var(--s3)] px-3 py-3 space-y-2.5">
            {/* where the whole batch stands */}
            <div>
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="text-zinc-300">
                  <span className="font-semibold text-white">{dubbed}</span> dubbed
                  <span className="text-zinc-600"> · </span>
                  <span className="font-semibold text-white">{done}</span> captioned
                  <span className="text-zinc-500"> of {parts.length}</span>
                </span>
                {(working || activeHere > 0) && (
                  <span className="flex items-center gap-1 text-blue-300">
                    <Loader2 className="h-3 w-3 animate-spin" /> {activeHere > 0 ? `${activeHere} working` : 'working'}
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex gap-0.5">
                {parts.map((p) => {
                  const stage = stageOf(p, jobOf.get(p.id));
                  return <button key={p.id} onClick={() => navigate(`/project/${p.id}`)}
                    aria-label={`${p.name}: ${stage.label}`} title={`${kind === 'folder' ? nameParts(p.name).tail : `Part ${p.part_index}`}: ${stage.label}`}
                    className="group flex h-4 min-w-0 flex-1 items-center rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400">
                    <span className={`h-1.5 w-full rounded-full transition-opacity group-hover:opacity-70 ${TONES[stage.tone].bar}`} />
                  </button>;
                })}
              </div>
            </div>

            <div className="flex items-center justify-between text-[10px] text-zinc-500">
              <span>{totalVoiced} / {totalCaptions} captions voiced</span>
              <span className="font-semibold tabular-nums text-zinc-300">{voicePercent}%</span>
            </div>
            {lineUp.length > 0 && (
              <p className="flex items-center justify-between gap-2 text-[11px] text-blue-200" title="Worked out from how long the videos already done took. Rendering the exports is not counted.">
                <span>{secondsLeft === null ? 'Time left: known once a video has finished' : `About ${howLong(secondsLeft)} left`}</span>
                {secondsLeft !== null && <span className="text-zinc-400">done around {new Date(Date.now() + secondsLeft * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
              </p>
            )}

            {/* what went wrong, and what would spoil the dub, with the fix beside it */}
            {waitingForQuota.length > 0 && (
              <div role="status" className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-100"
                title="Captions and speaker names need Gemini. Music, dubbing and exports do not, and carry on meanwhile. Adding another API key in Settings also helps.">
                <span className="min-w-0 leading-snug">
                  Gemini's quota is used up — {waitingForQuota.length} {unit}{waitingForQuota.length === 1 ? ' waits' : 's wait'} and
                  {' '}tr{waitingForQuota.length === 1 ? 'ies' : 'y'} again at {when(waitingForQuota[0].retry_at)}
                </span>
                <button onClick={() => void retryNow()} disabled={retrying} className="shrink-0 rounded-md bg-amber-500/20 px-2 py-0.5 font-semibold text-amber-50 hover:bg-amber-500/30 disabled:opacity-40">
                  {retrying ? 'Trying…' : 'Try now'}
                </button>
              </div>
            )}
            {failedParts.length > 0 && (
              <div role="alert" className="flex items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-200">
                <span className="flex min-w-0 items-center gap-1.5"><TriangleAlert className="h-3.5 w-3.5 shrink-0" /> {failedParts.length} failed</span>
                <button onClick={() => void retryFailed()} disabled={queueing} className="shrink-0 rounded-md bg-red-500/20 px-2 py-0.5 font-semibold text-red-100 hover:bg-red-500/30 disabled:opacity-40">
                  Retry {failedParts.length === 1 ? 'it' : 'all'}
                </button>
              </div>
            )}
            {unnamedParts.length > 0 && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-100"
                title="Imported subtitles do not say who speaks. Without speakers every line is dubbed in the same default voice.">
                <span className="min-w-0 leading-snug">
                  {unnamedParts.length} {unit}{unnamedParts.length === 1 ? ' has' : 's have'} lines with no speaker — one voice for everyone
                </span>
                <button onClick={() => void identifyAll()} disabled={queueing} className="shrink-0 rounded-md bg-amber-500/25 px-2 py-0.5 font-semibold text-amber-50 hover:bg-amber-500/40 disabled:opacity-40">
                  Identify
                </button>
              </div>
            )}

            {/* only what is still left to do is offered */}
            {needAnything.length > 0 ? (
              <div className="flex gap-1.5">
                {needTranscribe.length > 0 && needDub.length > needTranscribe.length ? (
                  <button onClick={() => runBatch('both')} disabled={queueing} className={primaryAction} title={`Write the captions and dub every ${unit} that still needs it, on the server`}>
                    {queueing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers className="h-3.5 w-3.5" />}
                    Caption & dub {needAnything.length}
                  </button>
                ) : needTranscribe.length > 0 ? (
                  <>
                    <button onClick={() => runBatch('both')} disabled={queueing} className={primaryAction} title={`Write the captions and dub every ${unit} that still needs it, on the server`}>
                      {queueing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers className="h-3.5 w-3.5" />}
                      Caption & dub {needAnything.length}
                    </button>
                    <button onClick={() => runBatch('transcribe')} disabled={queueing} className={quietAction} title={`${needTranscribe.length} ${unit}(s) have no captions yet`}>
                      <Sparkles className="h-3.5 w-3.5" /> Captions only
                    </button>
                  </>
                ) : (
                  <button onClick={() => runBatch('dub')} disabled={queueing} className={primaryAction} title={`${needDub.length} ${unit}(s) have captions without a voice`}>
                    {queueing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mic className="h-3.5 w-3.5" />}
                    Dub {needDub.length} {unit}{needDub.length === 1 ? '' : 's'}
                  </button>
                )}
              </div>
            ) : (
              <p className={`flex items-center gap-1.5 text-[11px] ${dubbed === parts.length ? 'text-emerald-300' : 'text-zinc-400'}`}>
                {dubbed === parts.length ? <Check className="h-3.5 w-3.5" /> : <Layers className="h-3.5 w-3.5" />}
                {dubbed === parts.length ? `Every ${unit} is captioned and dubbed` : 'Remaining work is queued or waiting for review'}
              </p>
            )}

            <button
              onClick={() => setExportOpen((value) => !value)}
              disabled={exporting || queueing || !!inBrowser}
              aria-expanded={exportOpen}
              className={`${quietAction} w-full`}
              title={inBrowser ? 'Wait for all videos to finish uploading' : 'Export each video as a separate MP4'}
            >
              <Download className="h-3.5 w-3.5" /> Export all {parts.length} {unit}{parts.length === 1 ? '' : 's'}
            </button>
            {exportOpen && (
              <div className="rounded-lg border border-[var(--s5)] bg-white/[0.02] p-2.5 space-y-2">
                <label className="block text-[10px] text-zinc-400">
                  Video format
                  <select value={exportPlatform} onChange={(e) => setExportPlatform(e.target.value)} disabled={exporting}
                    className="mt-1 w-full rounded border border-[var(--s5)] bg-[var(--s2)] px-2 py-1.5 text-[11px] text-white">
                    <option value="custom">Original · match source</option>
                    <option value="youtube">Landscape · 16:9</option>
                    <option value="tiktok">Vertical · 9:16</option>
                    <option value="facebook">Portrait · 4:5</option>
                  </select>
                </label>
                <label className="block text-[10px] text-zinc-400">
                  Quality
                  <select value={exportQuality} onChange={(e) => setExportQuality(e.target.value as typeof exportQuality)} disabled={exporting}
                    className="mt-1 w-full rounded border border-[var(--s5)] bg-[var(--s2)] px-2 py-1.5 text-[11px] text-white">
                    <option value="compact">Small file</option>
                    <option value="standard">Standard</option>
                    <option value="high">Best quality</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-[11px] text-zinc-300">
                  <input type="checkbox" checked={exportVoice} disabled={exporting} onChange={(e) => setExportVoice(e.target.checked)} />
                  Dubbed voices + background music
                </label>
                {seriesLogo && (
                  <label className="flex items-center gap-2 text-[11px] text-zinc-300" title={`The logo set up in ${nameParts(seriesLogo.from).tail}. Switched off, each video keeps its own logo if it has one.`}>
                    <input type="checkbox" checked={exportLogo} disabled={exporting} onChange={(e) => setExportLogo(e.target.checked)} />
                    Same logo on every video
                    <img src={seriesLogo.logo.url} alt="" className="ml-auto h-5 w-auto max-w-[64px] rounded bg-black/40 object-contain" />
                  </label>
                )}
                <label className="flex items-center gap-2 text-[11px] text-zinc-300">
                  <input type="checkbox" checked={exportNumbered} disabled={exporting} onChange={(e) => setExportNumbered(e.target.checked)} />
                  Name the files by episode number
                </label>
                {exportNumbered && parts.length > 0 && (
                  <div>
                    <input value={seriesName} onChange={(e) => setExportName(e.target.value)} disabled={exporting}
                      aria-label="Series name for the files" placeholder="Series name"
                      className="w-full rounded border border-[var(--s5)] bg-[var(--s2)] px-2 py-1.5 text-[11px] text-white" />
                    <p className="mt-1 break-all text-[10px] leading-relaxed text-zinc-500">
                      {fileNameOf(parts[0])}.mp4{parts.length > 1 ? ` … ${fileNameOf(parts[parts.length - 1])}.mp4` : ''}
                    </p>
                  </div>
                )}
                {parts.length > 1 && (
                  <div>
                    <label className="flex items-center gap-2 text-[11px] text-zinc-300" title="When the exports have finished, the episodes are also joined into one long video with a chapter for each. The separate files are kept.">
                      <input type="checkbox" checked={joinAfter} disabled={exporting} onChange={(e) => setJoinAfter(e.target.checked)} />
                      Also join them into one video afterwards
                    </label>
                    {joinAfter && (
                      <>
                        <select value={joinSize} onChange={(e) => setJoinSize(Number(e.target.value))} disabled={exporting} aria-label="Episodes in each joined video"
                          className="mt-1.5 w-full rounded border border-[var(--s5)] bg-[var(--s2)] px-2 py-1.5 text-[11px] text-white">
                          <option value={0}>All {parts.length} in one video</option>
                          {[5, 10, 20].filter((n) => n < parts.length).map((n) => <option key={n} value={n}>Every {n} episodes</option>)}
                        </select>
                        <p className="mt-1 break-all text-[10px] leading-relaxed text-zinc-500">
                          {(() => {
                            const groups = joinGroups(parts.map(episodeOf), joinSize);
                            const label = (g: number[]) => `${seriesName ? `${seriesName} - ` : ''}Episode (${g[0]}-${g[g.length - 1]}).mp4`;
                            return groups.length === 1 ? label(groups[0]) : `${groups.length} videos: ${label(groups[0])} … ${label(groups[groups.length - 1])}`;
                          })()}
                        </p>
                      </>
                    )}
                  </div>
                )}
                <label className="block text-[10px] text-zinc-400">
                  Save to folder (optional)
                  <input value={exportFolder} onChange={(e) => setExportFolder(e.target.value)} disabled={exporting}
                    placeholder="Default export location"
                    className="mt-1 w-full rounded border border-[var(--s5)] bg-[var(--s2)] px-2 py-1.5 text-[11px] text-white" />
                </label>
                <button disabled={choosingFolder || exporting} className={`${quietAction} w-full`} onClick={async () => {
                  setChoosingFolder(true);
                  try {
                    const folder = await selectFolderInSystem();
                    if (folder) setExportFolder(folder);
                  } finally { setChoosingFolder(false); }
                }}>{choosingFolder ? 'Choosing…' : 'Choose folder…'}</button>
                <p className="text-[10px] leading-relaxed text-zinc-500">
                  Separate MP4 files with captions. Uses each project's saved caption style, colour filter and logo.
                  Current work finishes first; videos needing review wait under Work.
                </p>
                <button onClick={exportAll} disabled={exporting || queueing || !!inBrowser} className={`${primaryAction} w-full`}>
                  {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  {exporting ? 'Queueing exports…' : `Queue all ${parts.length} exports`}
                </button>
              </div>
            )}

            {/* the less common things, each done for every episode at once */}
            <div className="rounded-lg border border-[var(--s5)]">
              <button
                onClick={() => setMoreOpen((v) => !v)}
                aria-expanded={moreOpen}
                className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-300 hover:bg-white/5"
              >
                <span>
                  {allBusy ? <span className="flex items-center gap-1.5 text-blue-300"><Loader2 className="h-3 w-3 animate-spin" /> Working… {allBusy.done} of {allBusy.total}</span> : `More for all ${parts.length} ${unit}s`}
                </span>
                <ChevronDown className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${moreOpen ? 'rotate-180' : ''}`} />
              </button>
              {moreOpen && (
                <div className="border-t border-[var(--s5)] p-1">
                  {([
                    ['music', Music, 'Isolate the music', 'On this computer · skips those already done', isolateAll],
                    ['look', Palette, `Copy this ${unit}’s look to all`, 'Caption style, frame shape, filter, logo', lookForAll],
                    ['overlaps', Layers, 'Fix overlapping voices', 'Spaces the lines apart and dubs them again', overlapsForAll],
                    ['lips', Mic, 'Lip timing', 'Moves each line onto the actor’s speech · re-dubs to fit', lipTimingForAll],
                    ['genders', Users, 'One voice per character', 'Uses Gemini · re-dubs changed lines', gendersForAll],
                    ['titles', Tags, 'Write titles & tags', 'Uses Gemini · written as part N of the series', titlesForAll],
                  ] as [string, typeof Music, string, string, () => void][]).map(([key, Icon, name, hint, run]) => (
                    <button
                      key={key}
                      onClick={() => run()}
                      disabled={!!allBusy || queueing || !!inBrowser}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {allBusy?.key === key ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-300" /> : <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />}
                      <span className="min-w-0">
                        <span className="block text-[11px] font-semibold text-zinc-100">{name}</span>
                        <span className="block truncate text-[10px] text-zinc-500">{hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* the film's own voices, off in every project at once */}
            <button
              onClick={() => muteVoices(!allVoicesMuted)}
              aria-pressed={allVoicesMuted}
              title="The original voices track (Vocals) in every one of these projects. This is for listening in the editor; a dubbed export already leaves the original voices out."
              className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] transition-colors ${
                allVoicesMuted ? 'border-blue-500/50 bg-blue-600/15 text-blue-100' : 'border-[var(--s5)] text-zinc-300 hover:bg-white/5'
              }`}
            >
              <span className="flex items-center gap-1.5">
                {allVoicesMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                {allVoicesMuted ? 'Original voices muted' : 'Mute original voices'}
              </span>
              <span aria-hidden className={`relative h-[16px] w-7 shrink-0 rounded-full transition-colors ${allVoicesMuted ? 'bg-blue-600' : 'bg-zinc-700'}`}>
                <span className={`absolute top-[3px] h-2.5 w-2.5 rounded-full bg-white transition-all ${allVoicesMuted ? 'left-[15px]' : 'left-[3px]'}`} />
              </span>
            </button>
          </div>
        )}

        {tab === 'parts' && parts.length > 0 && (
          <div className="shrink-0 space-y-2 border-b border-[var(--s3)] px-3 py-2.5">
            <input aria-label="Search episodes" placeholder="Find an episode…" value={search} onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-lg border border-[var(--s5)] bg-white/[0.03] px-3 py-2 text-xs text-white placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none" />
            <div className="flex gap-1">
              {(['all', 'attention', 'dubbed'] as const).map((value) => (
                <button key={value} onClick={() => setFilter(value)} aria-pressed={filter === value}
                  className={`rounded-full px-2.5 py-1 text-[10px] font-medium transition-colors ${filter === value ? 'bg-blue-500/15 text-blue-300' : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-300'}`}>
                  {value === 'all' ? 'All episodes' : value === 'attention' ? `Needs attention · ${attentionCount}` : 'Dubbed'}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className={`min-h-0 flex-1 overflow-y-auto p-2 ${tab === 'parts' ? '' : 'hidden'}`}>
          {parts.length === 0 ? (
            !inBrowser && (
              <p className="p-3 text-[11px] leading-relaxed text-zinc-500">
                This project wasn't made with others. Use From Folder or Split Long Video on the
                dashboard to make many projects at once — the progress of every one shows here.
              </p>
            )
          ) : (
            visibleParts.length === 0 ? <p className="p-3 text-xs text-zinc-500">No episodes match this view.</p> : visibleParts.map((p) => {
              const job = jobOf.get(p.id);
              const stage = stageOf(p, job);
              const tone = TONES[stage.tone];
              const isCurrent = p.id === currentProjectId;
              const subs = p.segment_count || 0;
              const voiced = Math.min(p.dubbed_count || 0, subs);
              const perMinute = subs > 0 && (p.duration || 0) > 0 ? Math.round(subs / ((p.duration || 1) / 60)) : 0;
              const busy = job?.status === 'running';
              return (
                <button
                  key={p.id}
                  aria-current={isCurrent ? 'page' : undefined}
                  onClick={() => navigate(`/project/${p.id}`)}
                  className={`mb-1 block w-full rounded-xl border border-transparent px-3 py-3 text-left transition-colors ${
                    isCurrent ? 'bg-blue-600/15 ring-1 ring-blue-500/40' : 'hover:bg-white/5'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
                      <span className="truncate text-xs font-medium text-white" title={p.name}>
                        {kind === 'folder' ? nameParts(p.name).tail : `Part ${p.part_index}`}
                      </span>
                    </span>
                    <span className={`flex shrink-0 items-center gap-1 text-[10px] font-semibold ${tone.text}`}>
                      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                      {stage.label === 'Dubbed' ? <><Check className="h-3 w-3" /> Dubbed</>
                        : stage.label === 'Failed' ? <><TriangleAlert className="h-3 w-3" /> Failed</>
                        : stage.label}
                    </span>
                  </div>

                  {/* a bar only while there is progress to show */}
                  {(busy || (voiced > 0 && voiced < subs)) && (
                    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/5">
                      <span className={`block h-full rounded-full transition-all duration-500 ${tone.bar}`} style={{ width: `${Math.max(6, stage.progress * 100)}%` }} />
                    </div>
                  )}

                  <div className="mt-1 flex items-center justify-between gap-2 pl-3.5 text-[10px] text-zinc-500">
                    <span className="truncate">
                      {clock(p.duration || 0)}
                      {subs > 0 ? ` · ${subs} captions` : ' · no captions'}
                      {voiced > 0 && ` · ${voiced} voiced`}
                    </span>
                    {p.transcribe_warning ? (
                      <span className="flex shrink-0 items-center gap-1 text-amber-400" title={p.transcribe_warning}>
                        <TriangleAlert className="h-3 w-3" /> gaps
                      </span>
                    ) : perMinute > 0 && perMinute < 12 ? (
                      <span className="shrink-0 text-amber-400" title="Few captions for its length — parts of the audio may have been missed">
                        only {perMinute}/min
                      </span>
                    ) : null}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {tab === 'work' && heldWork.length > 0 && (
          <div className="shrink-0 space-y-2 border-b border-[var(--s3)] bg-amber-500/[0.04] px-4 py-3">
            <p className="text-xs font-semibold text-amber-200">{heldWork.length} videos waiting for review</p>
            <div className="flex gap-2">
              <button disabled={!!reviewAction} onClick={() => actOnReviews('fix')} className={primaryAction}>
                {reviewAction === 'fix' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                Fix all ({heldWork.length})
              </button>
              <button disabled={!!reviewAction} onClick={() => actOnReviews('export')} className={quietAction}>
                {reviewAction === 'export' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                Export all anyway
              </button>
            </div>
            <p className="text-[10px] leading-relaxed text-zinc-500">Fix all repairs overlaps and long lines, regenerates affected voices, then checks again. Unresolved issues stay here. Export all anyway skips these warnings.</p>
          </div>
        )}

        {/* Work queue — captions and dubbing running on the server, for any project */}
        <div className={`min-h-0 flex-1 overflow-y-auto p-2 ${tab === 'work' ? '' : 'hidden'}`}>
          {work.length === 0 ? (
            <p className="p-3 text-[11px] leading-relaxed text-zinc-500">
              No work queued for this folder. Start captions or dubbing from the Videos tab. Work continues on the server when you close this panel.
            </p>
          ) : (
            <>
              {/* what is running or waiting first, then what finished, newest first */}
              {[...work]
                .sort((x, y) => {
                  const live = (j: PipelineJob) => (['running', 'review', 'queued'].includes(j.status) ? 0 : 1);
                  return live(x) - live(y) || (live(x) === 0
                    ? x.queued_at.localeCompare(y.queued_at)
                    : (y.finished_at || y.queued_at).localeCompare(x.finished_at || x.queued_at));
                })
                .map((job, index, sorted) => {
                const firstFinished = !['running', 'review', 'queued'].includes(job.status)
                  && (index === 0 || ['running', 'review', 'queued'].includes(sorted[index - 1].status));
                const { head, tail } = nameParts(job.project_name);
                const tone =
                  job.status === 'done' ? TONES.emerald
                    : job.status === 'error' ? TONES.red
                    : job.status === 'running' ? TONES.blue
                    : job.status === 'review' ? TONES.amber
                    : TONES.zinc;
                const step = job.step === 'repair' ? 'Fixing captions' : job.step === 'dubbing' ? 'Dubbing' : job.step === 'export' ? 'Export' : job.step === 'captions' ? 'Captions' : job.step === 'speakers' ? 'Speakers' : job.step === 'music' ? 'Music' : '';
                return (
                  <div key={job.id}>
                  {firstFinished && (
                    <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Finished <span className="ml-1 font-normal normal-case tracking-normal">· completed jobs clear after 2 min</span></p>
                  )}
                  <div className="mb-1 rounded-lg px-3 py-2.5 hover:bg-white/5">
                    <div className="flex items-center justify-between gap-2">
                      <button
                        onClick={() => navigate(`/project/${job.project_id}`)}
                        className="flex min-w-0 items-center gap-2 text-left"
                        title="Open this project"
                      >
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
                        <span className="min-w-0 flex items-baseline gap-1.5" title={job.project_name}>
                          <span className="shrink-0 text-xs font-semibold text-white">{tail}</span>
                          {head && <span className="truncate text-[10px] text-zinc-500">{head}</span>}
                        </span>
                      </button>
                      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-zinc-500">
                        {when(['running', 'review', 'queued'].includes(job.status) ? job.queued_at : job.finished_at)}
                      </span>
                      <button
                        onClick={async () => {
                          await removePipelineJob(job.id);
                          refresh();
                        }}
                        className="shrink-0 rounded p-1 text-zinc-600 transition-colors hover:bg-red-950/40 hover:text-red-400"
                        title={job.status === 'running' ? 'Stop this job' : job.status === 'queued' ? 'Remove from the queue' : job.status === 'review' ? 'Cancel the export' : 'Clear from the list'}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {job.status === 'running' && (
                      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/5">
                        <span className={`block h-full rounded-full transition-all duration-500 ${tone.bar}`} style={{ width: `${Math.max(4, job.percent)}%` }} />
                      </div>
                    )}
                    {job.status === 'review' && (
                      <div className="mt-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 space-y-1.5">
                        <p className="text-[10px] font-semibold text-amber-200">Export is waiting for you</p>
                        <ul className="space-y-0.5">
                          {(job.issues || []).map((issue) => (
                            <li key={issue.key} className={`text-[10px] leading-relaxed ${issue.severity === 'problem' ? 'text-red-300' : 'text-zinc-300'}`}>
                              • {issue.title}
                            </li>
                          ))}
                        </ul>
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => navigate(`/project/${job.project_id}`)}
                            className="flex-1 rounded-md bg-blue-600 py-1 text-[10px] font-semibold text-white hover:bg-blue-500"
                          >
                            Open to fix
                          </button>
                          <button
                            disabled={!!reviewAction}
                            onClick={() => actOnReviews('export', [job])}
                            title="Render it as it is"
                            className="flex-1 rounded-md border border-[var(--s6)] py-1 text-[10px] font-semibold text-zinc-200 hover:bg-white/10"
                          >
                            Export anyway
                          </button>
                        </div>
                      </div>
                    )}
                    <p className={`mt-1 text-[10px] leading-relaxed ${job.status === 'error' ? 'text-red-300' : 'text-zinc-500'}`}>
                      {job.status === 'error'
                        ? job.error || 'Failed'
                        : job.status === 'running'
                          ? `${step}${step ? ' · ' : ''}${job.message}`
                          : job.status === 'queued'
                            ? `Waiting · ${job.steps.join(', ')}`
                            : job.status === 'review'
                              ? job.notes.join(' · ')
                            : job.status === 'cancelled'
                              ? 'Cancelled'
                              : job.notes.join(' · ') || 'Finished'}
                    </p>
                  </div>
                  </div>
                );
              })}
              {work.some((j) => !['queued', 'running', 'review'].includes(j.status)) && (
                <button
                  onClick={async () => {
                    await Promise.all(work.filter((j) => !['queued', 'running', 'review'].includes(j.status)).map((j) => removePipelineJob(j.id)));
                    refresh();
                  }}
                  className="mt-1 w-full rounded-lg py-1.5 text-[11px] text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
                >
                  Clear finished
                </button>
              )}
            </>
          )}
        </div>

        {/* Review — every line that needs a look, across all the episodes */}
        <div className={`min-h-0 flex-1 overflow-y-auto p-2 ${tab === 'review' ? '' : 'hidden'}`}>
          <SeriesReview projectId={currentProjectId} active={open && tab === 'review'} onOpenLine={onClose} onQueued={() => { setTab('work'); void refresh(); }} />
        </div>

        {/* Export queue — renders run one after another, so this is where they queue up */}
        <div className={`min-h-0 flex-1 overflow-y-auto p-2 ${tab === 'exports' ? '' : 'hidden'}`}>
          {parts.length > 1 && <JoinEpisodes projectId={currentProjectId} series={title} active={open && tab === 'exports'} />}
          {jobs.length === 0 ? (
            <p className="p-3 text-[11px] leading-relaxed text-zinc-500">
              No exports for this folder yet. Choose “Export all” from the Videos tab to queue separate videos. Scheduled exports appear here after their work and review are complete.
            </p>
          ) : (
            <>
              {jobs.map((job) => {
                const tone =
                  job.status === 'done'
                    ? TONES.emerald
                    : job.status === 'error'
                      ? TONES.red
                      : job.status === 'rendering'
                        ? TONES.blue
                        : TONES.zinc;
                return (
                  <div key={job.id} className="mb-1 rounded-lg px-3 py-2.5 hover:bg-white/5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
                        <span className="truncate text-xs font-medium text-white">{job.label}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {job.status === 'done' && job.download_url && (
                          <a
                            href={job.download_url}
                            className="rounded p-1 text-zinc-500 transition-colors hover:bg-white/10 hover:text-emerald-300"
                            title="Download"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </a>
                        )}
                        <button
                          onClick={async () => {
                            await removeRenderJob(job.id);
                            refresh();
                          }}
                          className="rounded p-1 text-zinc-600 transition-colors hover:bg-red-950/40 hover:text-red-400"
                          title={job.status === 'rendering' ? 'Stop this render' : 'Remove from the queue'}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    </div>

                    {(job.status === 'rendering' || job.status === 'queued') && (
                      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/5">
                        <span
                          className={`block h-full rounded-full transition-all duration-500 ${tone.bar}`}
                          style={{ width: `${Math.max(job.status === 'rendering' ? 4 : 0, job.percent)}%` }}
                        />
                      </div>
                    )}

                    <p className={`mt-1.5 truncate text-[10px] ${tone.text}`}>
                      {job.status === 'rendering'
                        ? `${job.percent}% · ${job.message || 'Rendering…'}`
                        : job.status === 'error'
                          ? job.error || 'Failed'
                          : job.status === 'done'
                            ? job.saved_path || job.filename || 'Finished'
                            : job.message || job.status}
                    </p>
                    <p className="text-[10px] text-zinc-600">{job.project_name}</p>
                  </div>
                );
              })}
              {finishedJobs.length > 0 && (
                <button
                  onClick={async () => {
                    await Promise.all(finishedJobs.map((j) => removeRenderJob(j.id)));
                    refresh();
                  }}
                  className="mt-1 w-full rounded-lg py-2 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-white/5 hover:text-white"
                >
                  Clear {finishedJobs.length} finished
                </button>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
