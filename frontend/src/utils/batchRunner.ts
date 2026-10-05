/**
 * Work on many new projects at once — every video in a folder, or every part of a long video —
 * carried on in the background while you work in the editor.
 *
 * Only two things here need this browser tab: uploading a folder's videos (the files are on this
 * computer) and waiting for a long video to be cut. Everything after that is a job on the
 * server's queue. This module does both without any window open, watches the queue, and says
 * so with a toast when the batch is finished.
 */
import { create } from 'zustand';
import {
  addToPipeline,
  api,
  applyTemplate,
  createProject,
  fetchPipeline,
  importSrtFile,
  splitProject,
  translateSegmentsStream,
  uploadVideo,
  type PipelineJob,
  type SplitSpec,
} from '../api/client';
import { useProjectStore } from '../stores/projectStore';
import { needsKhmerTranslation } from './translation';
import { closeTab, openTabs } from './openTabs';
import { toast } from './toast';

export interface BatchOptions {
  language: string;
  music: boolean;
  captions: boolean;
  dub: boolean;
  export: boolean;
  hold: boolean;
  platform: string;
  /** The look every project starts with: a whole template, or just a caption style */
  templateId?: string;
  captionStyle?: Record<string, unknown>;
}

type ItemState = 'waiting' | 'working' | 'server' | 'held' | 'done' | 'failed';

export interface BatchItem {
  name: string;
  video?: File;
  subtitle?: File;
  projectId?: string;
  jobId?: string;
  state: ItemState;
  note: string;
}

export interface Batch {
  id: string;
  kind: 'folder' | 'video';
  /** For a long video: its project, which is open while it uploads and is cut */
  projectId?: string;
  title: string;
  /** 'browser' while this tab is uploading or cutting; 'server' once only the queue is left */
  phase: 'browser' | 'server' | 'finished';
  /** What the browser part is doing now, for the little progress card */
  message: string;
  percent: number;
  items: BatchItem[];
  options: BatchOptions;
}

/** A batch opens its first few projects as tabs, not all of them: a folder of 80 videos
 *  would otherwise bury the tab bar. The rest are in the progress panel and on the dashboard. */
export const MAX_BATCH_TABS = 4;

interface BatchState {
  batches: Batch[];
  /** Asks the editor to open its progress panel, once, when a batch takes you there */
  showProgress: number;
  /** Set by the toaster, which lives inside the router */
  navigate: ((path: string) => void) | null;
  setNavigate: (go: ((path: string) => void) | null) => void;
}

export const useBatchStore = create<BatchState>((set) => ({
  batches: [],
  showProgress: 0,
  navigate: null,
  setNavigate: (navigate) => set({ navigate }),
}));

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const updateBatch = (id: string, change: Partial<Batch> | ((b: Batch) => Partial<Batch>)) =>
  useBatchStore.setState((s) => ({
    batches: s.batches.map((b) => (b.id === id ? { ...b, ...(typeof change === 'function' ? change(b) : change) } : b)),
  }));
const updateItem = (id: string, index: number, change: Partial<BatchItem>) =>
  updateBatch(id, (b) => ({ items: b.items.map((item, i) => (i === index ? { ...item, ...change } : item)) }));

const showProgress = () => useBatchStore.setState((s) => ({ showProgress: s.showProgress + 1 }));

const go = (path: string) => {
  const navigate = useBatchStore.getState().navigate;
  if (navigate) navigate(path);
  else window.location.assign(path);
};
const onProject = (id: string) => window.location.pathname === `/project/${id}`;

/** Bring the open editor and the project list up to date after a project changed behind them. */
function refresh(projectId?: string) {
  const store = useProjectStore.getState();
  void store.loadProjects();
  if (projectId && store.currentProject?.id === projectId) void store.loadProject(projectId);
}

async function applyLook(projectId: string, options: BatchOptions) {
  if (options.templateId) await applyTemplate(options.templateId, projectId);
  if (options.captionStyle) {
    // saved on the project itself, so the editor shows it and the export uses it
    await api.patch(`/projects/${projectId}/editor-settings`, { caption_style: options.captionStyle });
  }
}

/** Hand a new project to the server's queue. Returns the job, or null when there is nothing to do. */
async function queueWork(projectId: string, hasSubtitle: boolean, o: BatchOptions): Promise<PipelineJob | null> {
  const captions = o.captions && !hasSubtitle;
  if (!captions && !o.music && !o.dub && !o.export) return null;
  return addToPipeline(projectId, {
    language: o.language,
    music: o.music,
    captions,
    // a subtitle file does not say who speaks, and dubbing needs to know
    speakers: o.dub && hasSubtitle,
    dub: o.dub,
    export: o.export,
    hold_for_review: o.hold,
    export_request: {
      platform: o.platform,
      include_subtitles: true,
      include_voice: o.dub,
      // a dubbed export keeps the film's music and drops its original voices
      background_audio: o.dub ? 'music' : 'original',
    },
  });
}

const failure = (err: any, fallback: string) => {
  const detail = err?.response?.data?.detail;
  return (typeof detail === 'string' && detail) || err?.message || fallback;
};

/** After the browser's part is over: watch the queue, or finish now if nothing went to it. */
function handOver(id: string) {
  updateBatch(id, { phase: 'server', message: '', percent: 100 });
  const batch = useBatchStore.getState().batches.find((b) => b.id === id);
  if (batch && !batch.items.some((i) => i.state === 'server')) finish(batch);
  else ensurePolling();
}

/**
 * Every video in a folder becomes a project. Goes to the first project's editor as soon as it
 * exists; the uploads carry on from there.
 */
export function runFolderBatch(title: string, videos: { name: string; video: File; subtitle?: File }[], options: BatchOptions) {
  const id = newId();
  const items: BatchItem[] = videos.map((v) => ({ ...v, state: 'waiting', note: '' }));
  useBatchStore.setState((s) => ({
    batches: [...s.batches, { id, kind: 'folder', title, phase: 'browser', message: 'Starting…', percent: 0, items, options }],
  }));
  toast({ tone: 'working', title: `Adding ${items.length} video${items.length === 1 ? '' : 's'}`, detail: `from “${title}”` });
  void (async () => {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const step = `Video ${i + 1} of ${items.length}`;
      try {
        updateItem(id, i, { state: 'working' });
        updateBatch(id, { message: `${step}: creating the project`, percent: 0 });
        const project = await createProject(item.name, '', options.language, { id, name: title, index: i + 1 });
        updateItem(id, i, { projectId: project.id });
        if (i < MAX_BATCH_TABS) openTabs([{ id: project.id, name: project.name }]);
        if (i === 0) {
          go(`/project/${project.id}`);
          showProgress();
        }
        await uploadVideo(project.id, item.video!, (percent) => updateBatch(id, { message: `${step}: uploading`, percent }));
        await applyLook(project.id, options);
        refresh(project.id);

        let note = 'Video uploaded';
        if (item.subtitle) {
          updateBatch(id, { message: `${step}: importing ${item.subtitle.name}` });
          const lines = await importSrtFile(project.id, item.subtitle);
          note = `${lines.length} captions from ${item.subtitle.name}`;
          if (options.captions) {
            // Khmer keeps lines that are already Khmer; any other language translates them all
            const ids = options.language === 'km' ? lines.filter((l) => needsKhmerTranslation(l.text)).map((l) => l.id) : undefined;
            if (!ids || ids.length) {
              updateBatch(id, { message: `${step}: translating the subtitles` });
              await new Promise<void>((resolve, reject) => {
                translateSegmentsStream(project.id, options.language, ids,
                  (progress) => updateBatch(id, { percent: progress.percent }),
                  undefined,
                  (_total, failed) => failed
                    ? reject(new Error(`${failed} subtitle lines could not be translated. Open the project and retry translation.`))
                    : resolve(),
                  (error) => reject(new Error(error)),
                );
              });
              note += ', translated';
            }
          }
          refresh(project.id);
        }
        const job = await queueWork(project.id, !!item.subtitle, options);
        updateItem(id, i, job ? { state: 'server', jobId: job.id, note: 'In the queue' } : { state: 'done', note });
      } catch (err) {
        updateItem(id, i, { state: 'failed', note: failure(err, 'Failed') });
      }
    }
    handOver(id);
  })();
}

/**
 * A long video, already a project, is cut into parts; each part is then queued like a folder
 * video. The editor is open on the long video meanwhile, and moves to Part 1 once it exists.
 */
export function runSplitBatch(video: { id: string; name: string }, spec: SplitSpec, deleteSource: boolean, options: BatchOptions) {
  const id = newId();
  useBatchStore.setState((s) => ({
    batches: [...s.batches, { id, kind: 'video', projectId: video.id, title: video.name, phase: 'browser', message: 'Cutting the video…', percent: 0, items: [], options }],
  }));
  if (!onProject(video.id)) go(`/project/${video.id}`);
  showProgress();
  toast({ tone: 'working', title: 'Cutting the video into parts', detail: video.name });
  void cutAndQueue(id, video, spec, deleteSource, options);
}

/**
 * A long video picked on the dashboard: its project is made and opened at once, and the file
 * uploads in the background before it is cut — nobody waits on a window for a large upload.
 */
export function runUploadAndSplitBatch(file: File, name: string, spec: SplitSpec, deleteSource: boolean, options: BatchOptions) {
  const id = newId();
  useBatchStore.setState((s) => ({
    batches: [...s.batches, { id, kind: 'video', title: name, phase: 'browser', message: 'Creating the project…', percent: 0, items: [], options }],
  }));
  void (async () => {
    let project;
    try {
      project = await createProject(name, '', options.language);
      updateBatch(id, { projectId: project.id });
      toast({ tone: 'working', title: 'Uploading the long video', detail: `${name} — it is cut into parts once it is in` });
      openTabs([{ id: project.id, name: project.name }]);
      go(`/project/${project.id}`);
      showProgress();
      await uploadVideo(project.id, file, (percent) => updateBatch(id, { message: 'Uploading the video', percent }));
    } catch (err) {
      updateBatch(id, { phase: 'finished' });
      toast({ tone: 'error', title: `“${name}” could not be uploaded`, detail: failure(err, 'The upload failed') });
      return;
    }
    refresh(project.id);
    updateBatch(id, { message: 'Cutting the video…', percent: 0 });
    await cutAndQueue(id, { id: project.id, name }, spec, deleteSource, options);
  })();
}

async function cutAndQueue(id: string, video: { id: string; name: string }, spec: SplitSpec, deleteSource: boolean, options: BatchOptions) {
  {
    let parts;
    try {
      ({ parts } = await splitProject(video.id, { spec, deleteSourceVideo: deleteSource }, (percent, message) =>
        updateBatch(id, { percent, message: message || 'Cutting the video…' })));
    } catch (err) {
      updateBatch(id, { phase: 'finished' });
      toast({ tone: 'error', title: `“${video.name}” could not be cut`, detail: failure(err, 'The split failed') });
      return;
    }
    const items: BatchItem[] = parts.map((p) => ({ name: p.name, projectId: p.id, state: 'waiting', note: '' }));
    updateBatch(id, { items, message: 'Queueing the parts…' });
    openTabs(parts.slice(0, MAX_BATCH_TABS).map((p) => ({ id: p.id, name: p.name })));
    // still looking at the long video: its video now lives in the parts, so go to the first one
    if (parts.length && onProject(video.id)) {
      go(`/project/${parts[0].id}`);
      closeTab(video.id);
    }
    refresh();
    toast({
      tone: 'info',
      title: `Cut into ${parts.length} parts`,
      detail: parts.length > MAX_BATCH_TABS
        ? `The first ${MAX_BATCH_TABS} are open as tabs; every part is in the progress panel. The rest runs on the server.`
        : 'They are open as tabs. The rest runs on the server.',
    });
    for (let i = 0; i < items.length; i++) {
      try {
        await applyLook(items[i].projectId!, options);
        const job = await queueWork(items[i].projectId!, false, options);
        updateItem(id, i, job ? { state: 'server', jobId: job.id, note: 'In the queue' } : { state: 'done', note: 'Part made' });
      } catch (err) {
        updateItem(id, i, { state: 'failed', note: failure(err, 'Failed') });
      }
    }
    handOver(id);
  }
}

// --- Watching the server's queue for every batch at once ---

let poller: ReturnType<typeof setInterval> | null = null;

function ensurePolling() {
  if (poller) return;
  poller = setInterval(() => void poll(), 5000);
  void poll();
}

async function poll() {
  const watched = useBatchStore.getState().batches.filter((b) => b.items.some((i) => i.state === 'server'));
  if (!watched.length) {
    if (poller) clearInterval(poller);
    poller = null;
    return;
  }
  let jobs: PipelineJob[];
  try { jobs = await fetchPipeline(); } catch { return; }
  for (const batch of watched) {
    batch.items.forEach((item, i) => {
      if (item.state !== 'server') return;
      const job = jobs.find((j) => j.id === item.jobId);
      if (!job) return;
      if (job.status === 'done') {
        updateItem(batch.id, i, { state: 'done', note: job.notes.join(' · ') });
        refresh(item.projectId);
      } else if (job.status === 'review') {
        updateItem(batch.id, i, { state: 'held', note: (job.issues || []).map((x) => x.title).join(' · ') });
      } else if (job.status === 'error' || job.status === 'cancelled') {
        updateItem(batch.id, i, { state: 'failed', note: job.error || job.message || 'Stopped' });
      }
    });
    const now = useBatchStore.getState().batches.find((b) => b.id === batch.id);
    if (now && now.phase === 'server' && !now.items.some((i) => i.state === 'server' || i.state === 'waiting' || i.state === 'working')) finish(now);
  }
}

/** Say how the batch went: one toast, for everything that was asked for. */
function finish(batch: Batch) {
  updateBatch(batch.id, { phase: 'finished' });
  const done = batch.items.filter((i) => i.state === 'done').length;
  const held = batch.items.filter((i) => i.state === 'held').length;
  const failed = batch.items.filter((i) => i.state === 'failed');
  const what = batch.kind === 'folder' ? 'project' : 'part';
  const did = [
    batch.options.music && 'music isolated',
    batch.options.captions && 'captions written',
    batch.options.dub && 'dubbed',
    batch.options.export && 'exported',
  ].filter(Boolean).join(', ');
  const total = batch.items.length;
  const parts = [
    did && done ? `${did[0].toUpperCase()}${did.slice(1)}.` : '',
    held ? `${held} waiting for you to check before export.` : '',
    failed.length ? `${failed.length} failed${failed[0]?.note ? ` — ${failed[0].name}: ${failed[0].note}` : ''}.` : '',
  ].filter(Boolean);
  toast({
    tone: failed.length ? (done ? 'warning' : 'error') : held ? 'warning' : 'success',
    title: failed.length || held
      ? `“${batch.title}”: ${done} of ${total} ${what}${total === 1 ? '' : 's'} finished`
      : `“${batch.title}” is finished — ${total} ${what}${total === 1 ? '' : 's'}`,
    detail: parts.join(' ') || undefined,
  });
}
