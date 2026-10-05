import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Captions, Download, FileText, Film, FolderOpen, HardDrive, Loader2, Mic2, Music, Scissors, X,
} from 'lucide-react';
import {
  listTemplates,
  type SeriesTemplate,
  SUBTITLE_RE,
  planSplit,
  type SplitPlan,
  type SplitSpec,
} from '../api/client';
import { DEFAULT_SUBTITLE_STYLE } from '../types/subtitleStyle';
import { PRESET_TEMPLATES, loadSavedPresets, styleFromPreset } from '../utils/captionPresets';
import { runFolderBatch, runSplitBatch, runUploadAndSplitBatch, type BatchOptions } from '../utils/batchRunner';
import { nameParts } from '../utils/names';

// the video types a project accepts (see ALLOWED_EXTENSIONS in the projects route)
const VIDEO_RE = /\.(mp4|mkv|avi|mov|webm|m4v|flv)$/i;
const stem = (name: string) => name.replace(/\.[^.]+$/, '');
const sizeText = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
const clock = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(Math.round(seconds % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

interface Item {
  /** A video from the folder; a part of a long video has none — it is cut on the server */
  video?: File;
  /** A subtitle file with the same name beside the video: imported instead of transcribing */
  subtitle?: File;
  name: string;
  /** For a part: where it sits in the long video, and how long it is */
  label?: string;
  seconds?: number;
}

// the same limits the server applies when it plans a cut (services/split_service.py)
const MIN_PART_SECONDS = 60;
const MAX_PARTS = 100;

/**
 * Where the cuts will fall, worked out here from the file's length before anything is
 * uploaded — so the choices can be made and confirmed straight away. The server snaps each cut
 * to the nearest keyframe, a few seconds either way, when it really cuts.
 */
function estimatePlan(duration: number, spec: SplitSpec, bytes: number): SplitPlan {
  let count: number;
  let step: number;
  if ('partSeconds' in spec) {
    if (spec.partSeconds < MIN_PART_SECONDS) throw new Error(`Parts must be at least ${MIN_PART_SECONDS} seconds long`);
    if (duration <= spec.partSeconds) throw new Error('That is longer than the video — use a shorter part length');
    const whole = Math.floor(duration / spec.partSeconds);
    count = duration - whole * spec.partSeconds >= MIN_PART_SECONDS ? whole + 1 : whole;
    step = spec.partSeconds;
  } else {
    count = Math.max(2, spec.parts);
    step = duration / count;
  }
  if (count > MAX_PARTS) throw new Error(`That would make ${count} parts — the most allowed is ${MAX_PARTS}`);
  if (step < MIN_PART_SECONDS) throw new Error(`${count} parts would each be under ${MIN_PART_SECONDS}s — use fewer parts`);
  const parts = Array.from({ length: count }, (_, i) => {
    const start = step * i;
    const end = i === count - 1 ? duration : step * (i + 1);
    return { index: i + 1, start, end, seconds: end - start, label: `${clock(start)} – ${clock(end)}` };
  });
  return { duration, part_count: count, parts, source_bytes: bytes, max_parts: MAX_PARTS, min_part_seconds: MIN_PART_SECONDS };
}

/** The length of a video file, read here without uploading it; 0 when this browser cannot. */
function readDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    const done = (seconds: number) => {
      clearTimeout(timer);
      probe.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
    };
    const timer = setTimeout(() => done(0), 15000);
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => done(probe.duration);
    probe.onerror = () => done(0);
    probe.src = url;
  });
}

/** The long video, once it is a project on the server */
export interface LongVideo {
  id: string;
  name: string;
  duration: number;
  language?: string;
}

const PLATFORMS: [string, string][] = [
  ['tiktok', 'TikTok (9:16)'],
  ['youtube_shorts', 'YouTube Shorts (9:16)'],
  ['instagram_reels', 'Instagram Reels (9:16)'],
  ['facebook', 'Facebook (4:5)'],
  ['youtube', 'YouTube (16:9)'],
  ['instagram', 'Instagram (1:1)'],
];

const LANGUAGES: [string, string][] = [
  ['km', '🇰🇭 ខ្មែរ (Khmer)'],
  ['en', '🇺🇸 English'],
  ['zh', '🇨🇳 中文 (Chinese)'],
  ['ja', '🇯🇵 日本語 (Japanese)'],
  ['ko', '🇰🇷 한국어 (Korean)'],
  ['th', '🇹🇭 ไทย (Thai)'],
  ['vi', '🇻🇳 Tiếng Việt'],
];

// The choices are the same batch after batch — a series is added a folder or a film at a
// time — so they are remembered instead of being set again every time.
const PREFS_KEY = 'folderProjects.prefs';
interface Prefs {
  language: string; captions: boolean; music: boolean; dub: boolean; export: boolean;
  hold: boolean; platform: string; look: string;
}
const DEFAULT_PREFS: Prefs = {
  language: 'km', captions: true, music: true, dub: false, export: false, hold: true, platform: 'tiktok', look: '',
};
function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return DEFAULT_PREFS;
  }
}

const STEP_NAMES: Record<string, string> = {
  upload: 'Upload', split: 'Split', subtitles: 'Subtitles', music: 'Music', captions: 'Captions',
  speakers: 'Speakers', dubbing: 'Dub', export: 'Export',
};

/** Pair each video in the folder with a same-named .srt, in the order a person would number them. */
function planFolder(files: File[]): Item[] {
  const subtitles = new Map<string, File>();
  for (const f of files) {
    // if a video has both, the .srt wins: it is the format most tools write cleanly
    const key = stem(f.webkitRelativePath || f.name).toLowerCase();
    if (SUBTITLE_RE.test(f.name) && (!subtitles.has(key) || /\.srt$/i.test(f.name))) subtitles.set(key, f);
  }
  return files
    .filter((f) => VIDEO_RE.test(f.name) && !f.name.startsWith('.'))
    .sort((a, b) =>
      (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }),
    )
    .map((video) => ({
      video,
      subtitle: subtitles.get(stem(video.webkitRelativePath || video.name).toLowerCase()),
      name: stem(video.name),
    }));
}

/**
 * Many projects at once, made the same way: every video in a folder, or every part of one
 * long video. Either way each project then gets the same treatment on the server — the music
 * isolated, captions written, lines dubbed, the video exported — so both start here, in one
 * window. The only difference is where the projects come from, and that a folder can bring
 * its own subtitle files.
 *
 * Confirming closes it straight away and opens the editor: the work carries on in the
 * background (see utils/batchRunner) and a toast says when it is finished.
 */
export default function NewProjectsModal({ source, longVideo, onClose }: {
  source: 'folder' | 'video';
  /** A long video that is already a project — offered for splitting right after its upload */
  longVideo?: LongVideo;
  onClose: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const [folder, setFolder] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const set = (change: Partial<Prefs>) => setPrefs((current) => {
    const next = { ...current, ...change };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* private mode: not remembered */ }
    return next;
  });
  const { language, platform } = prefs;
  const autoCaptions = prefs.captions;
  const isolateMusic = prefs.music;
  const autoDub = prefs.dub;
  const autoExport = prefs.export;
  const holdForReview = prefs.hold;
  // The caption look every new project starts with — and so what an unattended export burns in
  const [captionPresets] = useState(() => [...loadSavedPresets(), ...PRESET_TEMPLATES]);
  // …or a whole saved look: caption style, colour filter, logo and frame shape together
  const [templates, setTemplates] = useState<SeriesTemplate[]>([]);
  useEffect(() => { listTemplates().then(setTemplates).catch(() => setTemplates([])); }, []);
  // a remembered look that has since been deleted falls back to the default
  const captionStyleId = prefs.look && (captionPresets.some((p) => p.id === prefs.look) || templates.some((t) => `template:${t.id}` === prefs.look) || (!templates.length && prefs.look.startsWith('template:')))
    ? prefs.look : '';
  const [error, setError] = useState('');

  // --- A long video: already a project (offered after an upload in the editor), or a file
  // picked here that is uploaded in the background once the choices are confirmed ---
  const video = longVideo || null;
  const [picked, setPicked] = useState<{ file: File; name: string; duration: number } | null>(null);
  const [reading, setReading] = useState(false);
  const length = video?.duration || picked?.duration || 0;
  const [splitMode, setSplitMode] = useState<'count' | 'length'>('count');
  const [partCount, setPartCount] = useState(() => Math.min(6, Math.max(2, Math.round((longVideo?.duration || 0) / 600))));
  const [partMinutes, setPartMinutes] = useState('10');
  const [plan, setPlan] = useState<SplitPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState('');
  const [deleteSource, setDeleteSource] = useState(false);

  const minutesValue = parseFloat(partMinutes);
  const spec: SplitSpec | null = splitMode === 'count'
    ? { parts: partCount }
    : Number.isFinite(minutesValue) && minutesValue > 0 ? { partSeconds: Math.round(minutesValue * 60) } : null;
  const maxParts = length ? Math.min(MAX_PARTS, Math.max(2, Math.floor(length / MIN_PART_SECONDS))) : 30;

  // Re-plan whenever the choice changes; the cuts snap to keyframes, so the parts are never
  // exactly equal. The planned parts are the list of projects to come.
  useEffect(() => {
    if (source !== 'video' || (!video && !picked)) return;
    if (!spec) {
      setPlan(null);
      setPlanError('Enter how long each part should be');
      return;
    }
    const toItems = (p: SplitPlan) => p.parts.map((part) => ({ name: `Part ${part.index}`, label: part.label, seconds: part.seconds }));
    if (!video && picked) {
      setPlanning(false);
      if (!picked.duration) {
        // the file's length could not be read here; the server works the parts out after upload
        setPlan(null);
        setPlanError('');
        setItems('parts' in spec ? Array.from({ length: spec.parts }, (_, i) => ({ name: `Part ${i + 1}` })) : []);
        return;
      }
      try {
        const p = estimatePlan(picked.duration, spec, picked.file.size);
        setPlan(p);
        setPlanError('');
        setItems(toItems(p));
      } catch (e) {
        setPlan(null);
        setItems([]);
        setPlanError(e instanceof Error ? e.message : 'Those parts do not fit this video');
      }
      return;
    }
    if (!video) return;
    let cancelled = false;
    setPlanning(true);
    setPlanError('');
    planSplit(video.id, spec)
      .then((p) => {
        if (cancelled) return;
        setPlan(p);
        setItems(toItems(p));
      })
      .catch((e) => {
        if (!cancelled) { setPlan(null); setItems([]); setPlanError(e instanceof Error ? e.message : 'Could not plan the split'); }
      })
      .finally(() => { if (!cancelled) setPlanning(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, video?.id, picked, splitMode, partCount, partMinutes]);

  const pickLongVideo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!VIDEO_RE.test(file.name)) {
      setError('That file type is not supported. Use mp4, mkv, avi, mov, webm, m4v or flv.');
      return;
    }
    setError('');
    setReading(true);
    const duration = await readDuration(file);
    setReading(false);
    if (duration) setPartCount(Math.min(6, Math.max(2, Math.round(duration / 600))));
    setPicked({ file, name: stem(file.name), duration });
  };

  const handlePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setFolder((files[0].webkitRelativePath || '').split('/')[0] || 'Selected folder');
    setItems(planFolder(files));
  };

  const counts = useMemo(() => ({
    withSubtitle: items.filter((i) => i.subtitle).length,
    bytes: items.reduce((sum, i) => sum + (i.video?.size || 0), 0),
  }), [items]);

  /** What will be done to one project, in the order it happens */
  const stepsFor = (item: Item): string[] => [
    source === 'folder' ? 'upload' : 'split',
    ...(item.subtitle ? ['subtitles'] : []),
    ...(isolateMusic ? ['music'] : []),
    ...(autoCaptions && !item.subtitle ? ['captions'] : []),
    ...(autoDub && item.subtitle ? ['speakers'] : []),
    ...(autoDub ? ['dubbing'] : []),
    ...(autoExport ? ['export'] : []),
  ];
  // The steps each project goes through. Usually every one is the same, so it is said once.
  const trails = useMemo(() => {
    const found = new Map<string, { steps: string[]; count: number; withSubtitle: boolean }>();
    for (const item of items) {
      const steps = stepsFor(item);
      const key = steps.join();
      const seen = found.get(key);
      if (seen) seen.count += 1;
      else found.set(key, { steps, count: 1, withSubtitle: !!item.subtitle });
    }
    return [...found.values()];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, isolateMusic, autoCaptions, autoDub, autoExport, source]);

  // Confirming hands the work to the background and goes to the editor at once
  const confirm = () => {
    const template = templates.find((t) => `template:${t.id}` === captionStyleId);
    const chosen = captionPresets.find((preset) => preset.id === captionStyleId);
    const options: BatchOptions = {
      language, music: isolateMusic, captions: autoCaptions, dub: autoDub, export: autoExport, hold: holdForReview, platform,
      templateId: template?.id,
      captionStyle: chosen ? (styleFromPreset(chosen.style, DEFAULT_SUBTITLE_STYLE) as unknown as Record<string, unknown>) : undefined,
    };
    if (source === 'folder') {
      if (!items.length) return;
      runFolderBatch(folder, items.map((i) => ({ name: i.name, video: i.video!, subtitle: i.subtitle })), options);
    } else {
      if (!spec || (!plan && !(picked && !picked.duration))) return;
      if (video) runSplitBatch(video, spec, deleteSource, options);
      else if (picked) runUploadAndSplitBatch(picked.file, picked.name, spec, deleteSource, options);
      else return;
    }
    onClose();
  };

  const fieldClass =
    'w-full px-3 py-2 bg-[var(--s3)] border border-[var(--s6)] rounded-xl text-white text-xs focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-50';
  const ready = source === 'folder' ? items.length > 0 : !!(video || picked);
  const nothingYet = source === 'folder' ? !items.length : !(video || picked);
  const what = source === 'folder' ? 'video' : 'part';

  // the choices as cards: what it does, what it costs
  const choices: { key: keyof Prefs; on: boolean; icon: typeof Music; name: string; hint: string; cost: string }[] = [
    { key: 'music', on: isolateMusic, icon: Music, name: 'Isolate the background music',
      hint: 'Splits the sound into voices and music, so the dub keeps the music without the original voices.',
      cost: 'On this computer · no quota' },
    { key: 'captions', on: autoCaptions, icon: Captions, name: source === 'folder' ? 'Write and translate the captions' : 'Write the captions',
      hint: source === 'folder' ? 'From the audio, or from a subtitle file beside the video.' : 'Transcribed and translated from each part’s audio.',
      cost: 'Uses Gemini quota' },
    { key: 'dub', on: autoDub, icon: Mic2, name: 'Dub every line',
      hint: source === 'folder' ? 'A voice for each caption. For imported subtitles it first listens for who speaks each line.' : 'A voice for each caption.',
      cost: 'Needs captions' },
    { key: 'export', on: autoExport, icon: Download, name: 'Export the finished video',
      hint: 'Burns in the captions and adds the video to the render queue.',
      cost: 'Slowest step' },
  ];


  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className={`bg-[var(--s2)] border border-[var(--s5)] rounded-2xl p-6 w-full shadow-2xl max-h-[92vh] flex flex-col ${ready ? 'max-w-5xl' : 'max-w-xl'}`}>
        <div className="flex items-center gap-2.5 mb-1">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white shrink-0">
            {source === 'folder' ? <FolderOpen className="w-4 h-4" /> : <Scissors className="w-4 h-4" />}
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-white leading-tight">
              {source === 'folder' ? 'New projects from a folder' : 'New projects from a long video'}
            </h2>
            {source === 'folder' && items.length > 0 && (
              <p className="text-[11px] text-zinc-400 truncate">
                “{folder}” · {items.length} video{items.length === 1 ? '' : 's'} · {sizeText(counts.bytes)}
                {counts.withSubtitle > 0 && ` · ${counts.withSubtitle} with a subtitle file`}
              </p>
            )}
            {source === 'video' && (video || picked) && (
              <p className="text-[11px] text-zinc-400 truncate">
                “{video?.name || picked?.name}”{length ? ` · ${clock(length)}` : ''}{picked ? ` · ${sizeText(picked.file.size)} · uploaded after you confirm` : ''}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="ml-auto p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-[var(--s4)] disabled:opacity-30 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <input
          ref={picker}
          type="file"
          // @ts-ignore — folder picking is not in the DOM typings
          webkitdirectory=""
          directory=""
          multiple
          className="hidden"
          onChange={handlePick}
        />
        <input ref={filePicker} type="file" accept="video/*,.mkv,.flv" className="hidden" onChange={(e) => void pickLongVideo(e)} />

        {nothingYet ? (
          source === 'folder' ? (
            <>
              <p className="text-xs text-zinc-400 mb-4 mt-2">
                Every video in the folder becomes its own project, named after the file. A subtitle file
                with the same name (<span className="font-mono">Episode 1.srt</span>, .vtt or .ass) is imported with it.
              </p>
              <button
                onClick={() => picker.current?.click()}
                className="w-full rounded-xl border border-dashed border-[var(--s6)] hover:border-blue-500 hover:bg-blue-600/5 py-10 text-xs text-zinc-300 transition-colors"
              >
                <FolderOpen className="w-6 h-6 mx-auto mb-2 text-zinc-500" />
                {folder ? `No videos found in “${folder}”. Choose another folder` : 'Choose a folder'}
              </button>
            </>
          ) : (
            <>
              <p className="text-xs text-zinc-400 mb-4 mt-2">
                The video is cut into parts, and every part becomes its own project with the same
                treatment — music, captions, dubbing, export. Choose the video and the options; the upload
                and everything after it happen in the background while you work.
              </p>
              <label className="block text-[11px] font-semibold text-zinc-400 space-y-1.5 mb-3">
                <span>Language</span>
                <select value={language} onChange={(e) => set({ language: e.target.value })} className={fieldClass}>
                  {LANGUAGES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </label>
              {reading ? (
                <p className="flex items-center justify-center gap-2 py-10 text-xs text-zinc-400">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-400" /> Reading the video’s length…
                </p>
              ) : (
                <button
                  onClick={() => filePicker.current?.click()}
                  className="w-full rounded-xl border border-dashed border-[var(--s6)] hover:border-blue-500 hover:bg-blue-600/5 py-10 text-xs text-zinc-300 transition-colors"
                >
                  <Film className="w-6 h-6 mx-auto mb-2 text-zinc-500" />
                  Choose a long video
                  <span className="block mt-1 text-[11px] text-zinc-500">mp4, mkv, avi, mov, webm, m4v or flv</span>
                </button>
              )}
              {error && <p role="alert" className="mt-3 flex items-start gap-1.5 text-xs text-red-300"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />{error}</p>}
            </>
          )
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-5 mt-4 flex-1 min-h-0">
              {/* What happens to every project */}
              <div className="space-y-3 md:overflow-y-auto md:pr-1 min-h-0">
                <fieldset  className="space-y-2">
                  <legend className="text-[11px] font-bold uppercase tracking-wider text-zinc-300 mb-2">
                    {source === 'folder' ? 'After each video is uploaded' : 'After the video is cut, for each part'}
                  </legend>
                  {choices.map(({ key, on, icon: Icon, name, hint, cost }) => (
                    <label
                      key={key}
                      className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors focus-within:ring-1 focus-within:ring-blue-400 cursor-pointer ${
                        on ? 'border-blue-500/60 bg-blue-600/10' : 'border-[var(--s5)] bg-[var(--s1)] hover:border-[var(--s8)]'
                      }`}
                    >
                      <input type="checkbox" className="sr-only" checked={on} onChange={(e) => set({ [key]: e.target.checked })} />
                      <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${on ? 'bg-blue-600 text-white' : 'bg-[var(--s4)] text-zinc-500'}`}>
                        <Icon className="w-3.5 h-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className={`text-xs font-semibold ${on ? 'text-white' : 'text-zinc-300'}`}>{name}</span>
                          <span className="text-[10px] text-zinc-500 shrink-0">{cost}</span>
                        </span>
                        <span className="block text-[11px] text-zinc-400 leading-snug">{hint}</span>
                      </span>
                      {/* a switch, since each of these is simply on or off */}
                      <span aria-hidden className={`relative w-8 h-[18px] rounded-full shrink-0 transition-colors ${on ? 'bg-blue-600' : 'bg-zinc-700'}`}>
                        <span className={`absolute top-[3px] w-3 h-3 rounded-full bg-white transition-all ${on ? 'left-[17px]' : 'left-[3px]'}`} />
                      </span>
                    </label>
                  ))}
                  {autoExport && (
                    <label className="flex items-start gap-2 text-xs text-zinc-200 cursor-pointer pl-1">
                      <input type="checkbox" className="mt-0.5 accent-blue-500" checked={holdForReview} onChange={(e) => set({ hold: e.target.checked })} />
                      <span>Check each video first, and wait for me if something looks wrong
                        <span className="block text-[11px] text-zinc-500">Lines with no voice, untranslated text, lines too long for their time. A clean video exports straight away.</span>
                      </span>
                    </label>
                  )}
                  {autoDub && !autoCaptions && (
                    <p className="text-[11px] text-amber-300/90">
                      {source === 'folder' ? 'Dubbing needs captions: videos without a subtitle file beside them will fail at that step.' : 'Dubbing needs captions: turn on Write the captions, or every part will fail at that step.'}
                    </p>
                  )}
                  {autoDub && !isolateMusic && <p className="text-[11px] text-amber-300/90">Without the music isolated here, each dubbed export stops to isolate it first.</p>}
                </fieldset>

                <div className={`grid gap-3 ${autoExport ? 'grid-cols-3' : 'grid-cols-2'}`}>
                  <label className="block text-[11px] font-semibold text-zinc-400 space-y-1.5">
                    <span>Language</span>
                    <select value={language} onChange={(e) => set({ language: e.target.value })} className={fieldClass}>
                      {LANGUAGES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                    </select>
                  </label>
                  {autoExport && (
                    <label className="block text-[11px] font-semibold text-zinc-400 space-y-1.5">
                      <span>Export for</span>
                      <select value={platform} onChange={(e) => set({ platform: e.target.value })} className={fieldClass}>
                        {PLATFORMS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                      </select>
                    </label>
                  )}
                  <label className="block text-[11px] font-semibold text-zinc-400 space-y-1.5">
                  <span title="The caption style, or a whole template (caption style, colour filter, logo), every new project starts with">Look</span>
                  <select
                    value={captionStyleId}
                    
                    onChange={(e) => {
                      // a template made for a platform brings that choice with it
                      const picked = templates.find((t) => `template:${t.id}` === e.target.value);
                      set({ look: e.target.value, ...(picked?.platform ? { platform: picked.platform } : {}) });
                    }}
                    className={fieldClass}
                  >
                    <option value="">Default</option>
                    {templates.length > 0 && (
                      <optgroup label="Templates — caption style, filter, logo">
                        {templates.map((t) => <option key={t.id} value={`template:${t.id}`}>{t.name}</option>)}
                      </optgroup>
                    )}
                    <optgroup label="Caption style only">
                      {captionPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}{preset.id.startsWith('saved-') ? ' (saved)' : ''}</option>)}
                    </optgroup>
                  </select>
                  </label>
                </div>
                <p className="text-[11px] text-zinc-500">
                  The look is set on every new project and used when it is exported. Make a template from any project with Template in the editor.
                </p>
              </div>

              {/* The projects to come, and where each one has got to */}
              <div className="flex flex-col min-h-0">
                {source === 'video' && (
                  <fieldset className="mb-3 space-y-2.5">
                    <div className="flex gap-1 p-1 rounded-lg bg-[var(--s1)] border border-[var(--s4)]">
                      {([['count', 'Number of parts'], ['length', 'Length of each part']] as const).map(([key, label]) => (
                        <button key={key} onClick={() => setSplitMode(key)} aria-pressed={splitMode === key}
                          className={`flex-1 py-1.5 rounded-md text-[11px] font-semibold transition-colors ${splitMode === key ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-white hover:bg-white/5'}`}>
                          {label}
                        </button>
                      ))}
                    </div>
                    {splitMode === 'count' ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <input type="number" min={2} max={maxParts} value={partCount} aria-label="Number of parts"
                          onChange={(e) => { const n = parseInt(e.target.value, 10); if (!Number.isNaN(n)) setPartCount(Math.min(maxParts, Math.max(2, n))); }}
                          className="w-16 px-2.5 py-1.5 rounded-lg bg-[var(--s3)] border border-[var(--s5)] text-xs text-white focus:outline-none focus:border-blue-500" />
                        <span className="text-[11px] text-zinc-500 mr-1">parts (2–{maxParts})</span>
                        {[2, 3, 4, 6, 8, 10, 12, 20, 30].filter((n) => n <= maxParts).map((n) => (
                          <button key={n} onClick={() => setPartCount(n)} aria-pressed={partCount === n}
                            className={`w-8 h-7 rounded-md text-[11px] font-semibold border transition-colors ${partCount === n ? 'bg-blue-600 border-blue-500 text-white' : 'bg-[var(--s3)] border-[var(--s5)] text-zinc-400 hover:text-white'}`}>
                            {n}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <input type="number" min={1} value={partMinutes} aria-label="Minutes per part" onChange={(e) => setPartMinutes(e.target.value)}
                          className="w-16 px-2.5 py-1.5 rounded-lg bg-[var(--s3)] border border-[var(--s5)] text-xs text-white focus:outline-none focus:border-blue-500" />
                        <span className="text-[11px] text-zinc-500 mr-1">minutes per part</span>
                        {[5, 10, 15, 20, 30].map((m) => (
                          <button key={m} onClick={() => setPartMinutes(String(m))} aria-pressed={partMinutes === String(m)}
                            className={`px-2 h-7 rounded-md text-[11px] font-medium border transition-colors ${partMinutes === String(m) ? 'bg-blue-600/20 border-blue-500/40 text-blue-200' : 'bg-[var(--s3)] border-[var(--s5)] text-zinc-500 hover:text-white'}`}>
                            {m} min
                          </button>
                        ))}
                      </div>
                    )}
                    {plan && (
                      <label className="flex items-start gap-2 text-[11px] text-zinc-400 cursor-pointer">
                        <input type="checkbox" checked={deleteSource} onChange={(e) => setDeleteSource(e.target.checked)} className="mt-0.5 accent-blue-500" />
                        <span>
                          <span className="inline-flex items-center gap-1 font-medium text-zinc-300"><HardDrive className="w-3 h-3" /> Delete the original after cutting</span>
                          <span className="block text-zinc-500">The parts hold all of it ({sizeText(plan.source_bytes)}), so this only frees the second copy.</span>
                        </span>
                      </label>
                    )}
                  </fieldset>
                )}

                <div className="flex items-center justify-between gap-3 mb-2">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">
                    {items.length} {what}{items.length === 1 ? '' : 's'}
                    {source === 'folder' && counts.bytes > 0 && <span className="font-normal normal-case tracking-normal text-zinc-500"> · {sizeText(counts.bytes)}</span>}
                  </span>
                  {source === 'folder' && (
                    <button onClick={() => picker.current?.click()} className="text-[11px] text-blue-400 hover:text-blue-300 shrink-0">
                      Choose another folder
                    </button>
                  )}
                </div>

                {/* what each one goes through, said once instead of on every row */}
                {trails.length > 0 && (
                  <div className="mb-2 rounded-xl border border-[var(--s5)] bg-[var(--s1)] px-3 py-2 space-y-1.5">
                    {trails.map(({ steps, count, withSubtitle }) => (
                      <div key={steps.join()} className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px]">
                        <span className="text-zinc-400 mr-1">
                          {trails.length > 1 ? `${count} ${withSubtitle ? 'with a subtitle file' : 'without one'}:` : `Each ${what}:`}
                        </span>
                        {steps.map((name, n) => (
                          <span key={name} className="flex items-center gap-1.5">
                            {n > 0 && <span className="text-zinc-600">→</span>}
                            <span className="rounded-md px-1.5 py-0.5 font-semibold bg-blue-600/15 text-blue-200">{STEP_NAMES[name]}</span>
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                )}

                <ul className="flex-1 min-h-[160px] max-h-[46vh] md:max-h-none overflow-y-auto rounded-xl border border-[var(--s5)] bg-[var(--s1)] divide-y divide-[var(--s3)]">
                  {source === 'video' && planning && !items.length && (
                    <li className="flex items-center gap-2 px-3 py-4 text-[11px] text-zinc-500"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Finding the cut points…</li>
                  )}
                  {source === 'video' && picked && !picked.duration && (
                    <li className="px-3 py-3 text-[11px] text-zinc-400">
                      This browser cannot read the length of this file, so the parts are worked out after it is uploaded.
                      {splitMode === 'length' && ' Their number is not known until then.'}
                    </li>
                  )}
                  {source === 'video' && !planning && planError && (
                    <li className="flex items-start gap-2 px-3 py-3 text-[11px] text-amber-300"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {planError}</li>
                  )}
                  {items.map((item, i) => {
                    const { head, tail } = nameParts(item.name);
                    return (
                      <li key={`${item.video?.webkitRelativePath || item.video?.name || item.name}-${i}`} className={`group flex items-center gap-2.5 px-3 py-1.5 ${planning ? 'opacity-50' : ''}`}>
                        <span className="w-5 text-right text-[10px] font-mono text-zinc-600 shrink-0">{i + 1}</span>
                        <span className="min-w-0 flex-1 flex items-baseline gap-1.5" title={item.video?.webkitRelativePath || item.name}>
                          <span className="text-xs font-medium text-zinc-100 shrink-0">{tail}</span>
                          {head && <span className="text-[10px] text-zinc-500 truncate">{head}</span>}
                          {item.label && <span className="text-[10px] text-zinc-500 tabular-nums shrink-0">{item.label}</span>}
                        </span>
                        {item.subtitle ? (
                          <span className="shrink-0 flex items-center gap-0.5 rounded bg-emerald-500/15 px-1 py-px text-[9px] font-semibold text-emerald-300" title={`Subtitles from ${item.subtitle.name}`}>
                            <FileText className="w-2.5 h-2.5" />{item.subtitle.name.split('.').pop()?.toUpperCase()}
                          </span>
                        ) : source === 'folder' && (
                          <span className="shrink-0 text-[9px] text-zinc-500" title="No subtitle file with the same name beside this video">no subtitle file</span>
                        )}
                        <span className="shrink-0 w-14 text-right text-[11px] tabular-nums text-zinc-400">
                          {item.video ? sizeText(item.video.size) : item.seconds ? clock(item.seconds) : ''}
                        </span>
                        {source === 'folder' && (
                          <button
                            onClick={() => setItems((list) => list.filter((_, n) => n !== i))}
                            aria-label={`Leave out ${item.name}`}
                            title="Leave this video out"
                            className="shrink-0 p-1 rounded-md text-zinc-600 hover:text-red-300 hover:bg-white/10 opacity-50 group-hover:opacity-100"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 mt-4 pt-4 border-t border-[var(--s4)]">
              <p className="text-[11px] text-zinc-400 flex-1 min-w-[220px]">
                {source === 'folder'
                  ? 'The editor opens straight away and the videos upload in the background. Keep this tab open until they are in.'
                  : 'The editor opens straight away. The video is cut in the background and Part 1 opens when it is ready.'}
              </p>
              <button onClick={onClose} className="px-4 py-2 rounded-xl text-xs text-zinc-400 hover:text-white hover:bg-[var(--s4)] transition-colors">
                {source === 'video' ? 'Keep as one video' : 'Cancel'}
              </button>
              <button
                onClick={confirm}
                disabled={source === 'folder' ? !items.length : !spec || planning || (!plan && !(picked && !picked.duration))}
                className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-xs shadow-lg transition-all active:scale-95"
              >
                {source === 'folder'
                  ? `Create ${items.length} project${items.length === 1 ? '' : 's'}`
                  : plan || items.length ? `Cut into ${plan?.part_count ?? items.length} parts` : 'Cut into parts'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
