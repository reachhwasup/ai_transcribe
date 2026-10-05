import axios from 'axios';
import type { Project, ProjectListItem, Segment, VideoClip } from '../types';
import type { OverlayEntrance, OverlayExit } from '../utils/overlayMotion';
import { toast } from '../utils/toast';

export const api = axios.create({
  baseURL: '/api',
});

// --- Start and finish of long work, said with a toast wherever it was started from ---

interface Announced {
  match: RegExp;
  /** what is happening, and what it became; the project's name is added after */
  start: string;
  done: string;
  /** requests that only look (a preview, a dry run) say nothing */
  skip?: (body: any) => boolean;
}
const ANNOUNCED: Announced[] = [
  { match: /\/transcripts\/translate$/, start: 'Translating captions', done: 'Captions translated', skip: (b) => !!b?.preview },
  { match: /\/transcripts\/import-srt$/, start: 'Importing subtitles', done: 'Subtitles imported' },
  { match: /\/transcripts\/identify-speakers$/, start: 'Finding who speaks each line', done: 'Speakers identified' },
  { match: /\/export\/fix-character-genders$/, start: 'Fixing character voices', done: 'Character voices fixed', skip: (b) => !!b?.dry_run },
  { match: /\/transcripts\/auto-fit-audio$/, start: 'Fitting voices to their captions', done: 'Voices fitted', skip: (b) => !!b?.dry_run },
  { match: /\/transcripts\/shorten-to-fit$/, start: 'Shortening long lines', done: 'Lines shortened', skip: (b) => !b?.apply },
  { match: /\/transcripts\/space-overlaps$/, start: 'Spacing out overlapping lines', done: 'Overlapping lines spaced out' },
  { match: /\/export\/separate-audio$/, start: 'Isolating the background music', done: 'Background music isolated' },
  { match: /\/transcripts\/publish-kit$/, start: 'Writing titles & tags', done: 'Titles & tags written' },
  { match: /\/transcripts\/movie-recap$/, start: 'Writing the movie recap', done: 'Movie recap written' },
  { match: /\/transcripts\/generate-hooks\/?$/, start: 'Writing intro hooks', done: 'Intro hooks written' },
  { match: /\/transcripts\/poster\/remove-title$/, start: 'Removing the poster’s title', done: 'Poster title removed' },
  { match: /\/transcripts\/poster\/with-title$/, start: 'Making the poster with your title', done: 'Poster made — check its spelling' },
  { match: /\/transcripts\/poster\/read-title$/, start: 'Reading the poster’s title', done: 'Poster title translated' },
  { match: /^\/render-queue\/[^/]+$/, start: 'Adding the export to the queue', done: 'Export queued' },
];

type AnnouncedConfig = { _announce?: Announced; _project?: string };

const projectLabel = (url: string): string => {
  const id = url.match(/\/projects\/([^/]+)/)?.[1] || url.match(/^\/render-queue\/([^/]+)/)?.[1];
  if (!id) return '';
  // read lazily: the store imports this module
  const store = (globalThis as any).__projectStoreForToasts?.getState?.();
  const name = store?.currentProject?.id === id ? store.currentProject.name : store?.projects?.find((p: any) => p.id === id)?.name;
  if (!name) return '';
  const at = name.lastIndexOf(' - ');
  return at > 0 && name.length - at < 40 ? name.slice(at + 3) : name;
};

// A batch over many projects says how it went once, itself; the calls inside it stay quiet.
let quiet = 0;
export async function quietly<T>(work: () => Promise<T>): Promise<T> {
  quiet += 1;
  try { return await work(); } finally { quiet -= 1; }
}

api.interceptors.request.use((config) => {
  if (quiet > 0) return config;
  if ((config.method || 'get').toLowerCase() !== 'post') return config;
  const url = config.url || '';
  const rule = ANNOUNCED.find((r) => r.match.test(url));
  if (!rule) return config;
  let body: any = config.data;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* not JSON */ } }
  if (rule.skip?.(body)) return config;
  const project = projectLabel(url);
  (config as AnnouncedConfig)._announce = rule;
  (config as AnnouncedConfig)._project = project;
  toast({ tone: 'working', title: rule.start, detail: project || undefined });
  return config;
});

api.interceptors.response.use(
  (response) => {
    const config = response.config as AnnouncedConfig;
    if (config._announce) toast({ tone: 'success', title: config._announce.done, detail: config._project || undefined });
    return response;
  },
  (error) => {
    const config = (error?.config || {}) as AnnouncedConfig;
    if (config._announce && error?.code !== 'ERR_CANCELED') {
      const detail = error?.response?.data?.detail;
      toast({
        tone: 'error',
        title: `${config._announce.start} failed`,
        detail: [config._project, (typeof detail === 'string' && detail) || error?.message].filter(Boolean).join(' — ') || undefined,
      });
    }
    return Promise.reject(error);
  },
);

// Projects
export async function fetchProjects(): Promise<ProjectListItem[]> {
  const { data } = await api.get('/projects/');
  return data;
}

export async function fetchProject(id: string): Promise<Project> {
  const { data } = await api.get(`/projects/${id}`);
  return data;
}

export async function createProject(
  name: string,
  description = '',
  language = 'km',
  /** One of several projects made together from a folder, shown together in that order */
  batch?: { id: string; name: string; index: number },
): Promise<Project> {
  const { data } = await api.post('/projects/', {
    name, description, language,
    ...(batch ? { batch_id: batch.id, batch_name: batch.name, batch_index: batch.index } : {}),
  });
  return data;
}

export async function updateProject(id: string, updates: Partial<Project>): Promise<Project> {
  const { data } = await api.patch(`/projects/${id}`, updates);
  return data;
}

export async function deleteProject(id: string): Promise<void> {
  await api.delete(`/projects/${id}`);
}

// Video upload
export async function uploadVideo(projectId: string, file: File, onProgress?: (pct: number) => void): Promise<Project> {
  const formData = new FormData();
  formData.append('file', file);
  const { data } = await api.post(`/projects/${projectId}/upload`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (e) => {
      if (onProgress && e.total) {
        onProgress(Math.round((e.loaded * 100) / e.total));
      }
    },
  });
  return data;
}

// Transcription
export async function generateTranscript(projectId: string, language = 'km'): Promise<Project> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/generate`, { language });
  return data;
}

export interface TranscribeProgressEvent {
  message: string;
  percent: number;
  currentChunk: number;
  totalChunks: number;
}

// Streaming transcription via SSE
export function generateTranscriptStream(
  projectId: string,
  language: string = 'km',
  onSegment: (segment: Segment) => void,
  onDone: (total: number, warning?: string | null) => void,
  onError: (error: string) => void,
  onProgress?: (progress: TranscribeProgressEvent) => void,
): AbortController {
  const controller = new AbortController();

  fetch(`/api/projects/${projectId}/transcripts/generate-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language }),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        const text = await response.text();
        onError(text || 'Transcription failed');
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        onError('No response stream');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          try {
            const evt = JSON.parse(payload);
            if (evt.type === 'segment') {
              onSegment({
                ...evt.segment,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              });
            } else if (evt.type === 'progress') {
              onProgress?.({
                message: evt.message || '',
                percent: evt.percent || 0,
                currentChunk: evt.current_chunk || 0,
                totalChunks: evt.total_chunks || 0,
              });
            } else if (evt.type === 'done') {
              onDone(evt.total_segments, evt.warning);
              return;
            } else if (evt.type === 'error') {
              onError(evt.message);
              return;
            }
          } catch {
            // skip malformed lines
          }
        }
      }
      onError('Transcription connection closed before completion. Reload the project to check saved captions, then retry if needed.');
    })
    .catch((e) => {
      if (e.name !== 'AbortError') {
        onError(e.message || 'Transcription failed');
      }
    });

  return controller;
}

// Segments
export async function updateSegment(projectId: string, segmentId: string, updates: Partial<Segment>): Promise<Segment> {
  const { data } = await api.patch(`/projects/${projectId}/transcripts/${segmentId}`, updates);
  return data;
}

export async function deleteSegment(projectId: string, segmentId: string): Promise<void> {
  await api.delete(`/projects/${projectId}/transcripts/${segmentId}`);
}

export async function deleteAllSegments(projectId: string): Promise<void> {
  await api.delete(`/projects/${projectId}/transcripts/all`);
}

export async function rechunkSegments(projectId: string, wordsPerSegment: number): Promise<Segment[]> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/rechunk`, {
    words_per_segment: wordsPerSegment,
  });
  return data;
}

export async function addSegment(projectId: string, segment: Partial<Segment>): Promise<Segment> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/`, segment);
  return data;
}

// Bulk voice update
export async function bulkUpdateVoice(
  projectId: string,
  voiceProfile: string,
  segmentIds?: string[]
): Promise<Segment[]> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/bulk-voice`, {
    voice_profile: voiceProfile,
    segment_ids: segmentIds || null,
  });
  return data;
}

// Translate segments to target language
export interface TranslateProgressEvent {
  current: number;
  total: number;
  percent: number;
  segmentId?: string;
}

export function translateSegmentsStream(
  projectId: string,
  language: string = 'km',
  segmentIds?: string[],
  onProgress?: (progress: TranslateProgressEvent) => void,
  onSegmentUpdated?: (segment: Segment) => void,
  onDone?: (total: number, failed: number) => void,
  onError?: (error: string) => void,
): AbortController {
  const controller = new AbortController();

  fetch(`/api/projects/${projectId}/transcripts/translate-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language, segment_ids: segmentIds || null }),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        const text = await response.text();
        onError?.(text || 'Translation failed');
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        onError?.('No response stream');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          try {
            const evt = JSON.parse(payload);
            if (evt.type === 'segment_updated') {
              if (evt.segment) {
                onSegmentUpdated?.(evt.segment);
              }
              onProgress?.({
                current: evt.current,
                total: evt.total,
                percent: evt.percent,
                segmentId: evt.segment?.id,
              });
            } else if (evt.type === 'progress') {
              onProgress?.({
                current: evt.current,
                total: evt.total,
                percent: evt.percent,
                segmentId: evt.segment_id,
              });
            } else if (evt.type === 'done') {
              completed = true;
              onDone?.(evt.total, evt.failed || 0);
            } else if (evt.type === 'error') {
              completed = true;
              onError?.(evt.message);
            }
          } catch {
            // skip malformed lines
          }
        }
      }
      if (!completed) onError?.('Translation connection ended before completion. Please retry the remaining lines.');
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        onError?.(err.message || 'Stream connection failed');
      }
    });

  return controller;
}

/** Translate captions. With `preview` the translation is only returned; without it, it
 *  replaces the captions' text in the project. */
export async function translateSegments(
  projectId: string,
  language: string,
  segmentIds?: string[],
  preview = false,
): Promise<Array<{ id: string; start_time: number; end_time: number; text: string; speaker: string }>> {
  const { data } = await api.post(
    `/projects/${projectId}/transcripts/translate`,
    { language, segment_ids: segmentIds || null, preview },
    { timeout: 300000 },
  );
  return data;
}

export async function snapCaptionsToSpeech(
  projectId: string,
  /** lip timing: lines whose time changed enough to hear lose their voice, to be dubbed to fit */
  redub = false,
): Promise<{ moved: number; total: number; median_shift: number; to_revoice?: number }> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/snap-to-speech`, { redub }, { timeout: 600000 });
  return data;
}

export interface TidyCaptionsResult {
  merged_away: number;
  merged_into?: number;
  trimmed: number;
  extended?: number;
  total: number;
  dubbed_cleared: number;
  /** short lines left unmerged because they already have a voice */
  kept_dubbed?: number;
}

export async function tidyCaptions(projectId: string, dryRun = false): Promise<TidyCaptionsResult> {
  const { data } = await api.post(
    `/projects/${projectId}/transcripts/tidy-captions`,
    { dry_run: dryRun },
    { timeout: 120000 },
  );
  return data;
}

export async function retranscribeSelected(
  projectId: string,
  segmentIds: string[],
): Promise<Segment[]> {
  const { data } = await api.post(
    `/projects/${projectId}/transcripts/retranscribe-selected`,
    { segment_ids: segmentIds },
    { timeout: 300000 },
  );
  return data;
}

// Export
export function getExportUrl(projectId: string, format: string, language?: string): string {
  let url = `/api/projects/${projectId}/export/${format}`;
  if (language) url += `?language=${language}`;
  return url;
}

/** The subtitle formats the importer reads. */
export const SUBTITLE_ACCEPT = '.srt,.vtt,.ass,.ssa,.json';
export const SUBTITLE_RE = /\.(srt|vtt|ass|ssa)$/i;

export interface SubtitleImportPreview {
  format: string;
  encoding: string;
  /** Captions that would be imported */
  lines: number;
  /** Cues found in the file before cleaning */
  found: number;
  dropped: { empty: number; music: number; bad_time: number; duplicate: number };
  shortened: number;
  overlaps: number;
  speakers: string[];
  /** Language of the file, guessed from its script; '' when unclear */
  language: string;
  project_language: string;
  needs_translation: boolean;
  first: number;
  last: number;
  timeline_seconds: number;
  beyond_timeline: number;
  has_video: boolean;
  existing_captions: number;
  existing_voiced: number;
  /** How many existing captions the file lines up with in time (for use as a translation) */
  would_pair: number;
  sample: string[];
}

/** What importing this subtitle file would do. Changes nothing. */
export async function previewSubtitleImport(projectId: string, file: File): Promise<SubtitleImportPreview> {
  const formData = new FormData();
  formData.append('file', file);
  const { data } = await api.post(`/projects/${projectId}/transcripts/import-subtitles/preview`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' }, timeout: 30000,
  });
  return data;
}

/** Import a subtitle file (SRT, WebVTT, ASS/SSA, JSON). "replace" makes it the project's
 *  captions; "translation" keeps the captions and uses the file as their translation. */
export async function importSrtFile(
  projectId: string,
  file: File,
  mode: 'replace' | 'translation' = 'replace',
): Promise<import('../types').Segment[]> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('mode', mode);
  const { data } = await api.post(
    `/projects/${projectId}/transcripts/import-srt`,
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 30000 },
  );
  return data;
}

/** Work out from the audio who speaks each caption that names nobody (or every caption). */
export async function identifySpeakers(projectId: string, all = false): Promise<{
  labelled: number;
  asked: number;
  characters: { name: string; profile: string; lines: number }[];
  voices_cleared: number;
}> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/identify-speakers`, { all }, { timeout: 1800000 });
  return data;
}

// Video export for platform with real-time SSE progress
// The payload built by the most recent exportVideoForPlatform call, so "Add to queue" can
// send precisely the settings shown in the dialog without rebuilding them.

export interface RenderJob {
  id: string;
  project_id: string;
  project_name: string;
  label: string;
  status: 'queued' | 'rendering' | 'done' | 'error' | 'cancelled';
  percent: number;
  message: string;
  filename?: string | null;
  saved_path?: string | null;
  download_url?: string | null;
  error?: string | null;
  queued_at: string;
  finished_at?: string | null;
}

export async function addToRenderQueue(
  projectId: string,
  label: string,
  request: Record<string, unknown>,
): Promise<RenderJob> {
  const { data } = await api.post(`/render-queue/${projectId}`, { label, request });
  return data;
}

export async function fetchRenderQueue(): Promise<RenderJob[]> {
  const { data } = await api.get('/render-queue');
  return data;
}

export async function removeRenderJob(jobId: string): Promise<void> {
  await api.delete(`/render-queue/${jobId}`);
}

export async function clearFinishedRenderJobs(): Promise<void> {
  await api.delete('/render-queue');
}

export async function exportVideoForPlatform(
  projectId: string,
  platform: string,
  startTime?: number,
  endTime?: number,
  includeSubtitles?: boolean,
  onProgress?: (pct: number, message?: string) => void,
  includeVoice?: boolean,
  splitDuration?: number,
  subtitleLanguage?: string,
  muteOriginalAudio?: boolean,
  scaleMode?: string,
  subtitleStyle?: import('../types/subtitleStyle').SubtitleStyle,
  backgroundAudio?: string,
  exportFolder?: string,
  outputFilename?: string,
  quality?: 'compact' | 'standard' | 'high',
  bgmVolume?: number,
  voiceOffsetMs?: number,
  logoOptions?: {
    logo_url?: string;
    logo_enabled?: boolean;
    logo_position?: string;
    logo_scale_pct?: number;
    logo_opacity?: number;
    logo_x_pct?: number;
    logo_y_pct?: number;
    logo_start?: number | null;
    logo_end?: number | null;
  },
  blurAreas?: ExportBlurArea[],
  /** When set, the export is added to the render queue with this label instead of running now. */
  queueLabel?: string,
  audioOptions?: { duck_music?: boolean; normalize_loudness?: boolean; video_filter?: [string, number][] },
): Promise<{ blob: Blob; filename?: string; savedPath?: string; exportFolder?: string; queuedJob?: RenderJob }> {
  const payload = {
    platform,
    start_time: startTime ?? null,
    end_time: endTime ?? null,
    include_subtitles: includeSubtitles ?? false,
    include_voice: includeVoice ?? false,
    mute_original_audio: muteOriginalAudio ?? false,
    background_audio: backgroundAudio || 'original',
    split_duration: splitDuration ?? null,
    subtitle_language: subtitleLanguage || null,
    scale_mode: scaleMode || 'fit',
    blur_areas: blurAreas && blurAreas.length ? blurAreas : null,
    duck_music: audioOptions?.duck_music ?? true,
    normalize_loudness: audioOptions?.normalize_loudness ?? true,
    video_filter: audioOptions?.video_filter?.length ? audioOptions.video_filter : null,
    subtitle_size_pct: subtitleStyle?.sizePct ?? 4,
    subtitle_position: subtitleStyle?.position || 'bottom',
    subtitle_style: subtitleStyle ?? null,
    export_folder: exportFolder || null,
    output_filename: outputFilename || null,
    quality: quality || 'standard',
    bgm_volume: bgmVolume !== undefined ? bgmVolume : 0.35,
    voice_offset_ms: voiceOffsetMs ?? 0,
    logo_url: logoOptions?.logo_url || null,
    logo_enabled: logoOptions?.logo_enabled || false,
    logo_position: logoOptions?.logo_position || 'top_right',
    logo_scale_pct: logoOptions?.logo_scale_pct || 15.0,
    logo_opacity: logoOptions?.logo_opacity !== undefined ? logoOptions.logo_opacity : 1.0,
    logo_x_pct: logoOptions?.logo_x_pct !== undefined ? logoOptions.logo_x_pct : 85.0,
    logo_y_pct: logoOptions?.logo_y_pct !== undefined ? logoOptions.logo_y_pct : 5.0,
    logo_start: logoOptions?.logo_start ?? null,
    logo_end: logoOptions?.logo_end ?? null,
  };

  if (queueLabel) {
    const job = await addToRenderQueue(projectId, queueLabel, payload);
    return { blob: new Blob(), queuedJob: job };
  }

  try {
    const response = await fetch(`/api/projects/${projectId}/export/video-stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText || 'Failed to start video rendering');
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Unable to read video stream');
    }

    const decoder = new TextDecoder();
    let downloadUrl = '';
    let finalFilename = '';
    let savedLocalPath: string | undefined;
    let savedFolder: string | undefined;
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) {
          try {
            const data = JSON.parse(trimmed.slice(5).trim());
            if (data.type === 'progress') {
              onProgress?.(data.percent || 0, data.message);
            } else if (data.type === 'done') {
              onProgress?.(100, data.message || 'Video successfully rendered!');
              downloadUrl = data.download_url;
              finalFilename = data.filename;
              savedLocalPath = data.saved_path;
              savedFolder = data.export_folder;
            } else if (data.type === 'error') {
              throw new Error(data.message || 'Rendering failed');
            }
          } catch (err: any) {
            if (err.message && !err.message.includes('JSON')) {
              throw err;
            }
          }
        }
      }
    }

    if (!downloadUrl) {
      throw new Error('Render finished without download URL');
    }

    // If the file was already saved directly to the local disk (destination folder),
    // skip fetching multi-GB video blob into browser memory to eliminate the 95% loading delay
    let blob: Blob;
    if (savedLocalPath) {
      blob = new Blob([], { type: 'video/mp4' });
    } else {
      const fileRes = await fetch(downloadUrl);
      if (!fileRes.ok) {
        throw new Error('Failed to download rendered video file');
      }
      blob = await fileRes.blob();
    }
    return { blob, filename: finalFilename, savedPath: savedLocalPath, exportFolder: savedFolder };
  } catch (streamErr: any) {
    console.warn('Streaming video export error, falling back to direct endpoint:', streamErr);
    const { data } = await api.post(
      `/projects/${projectId}/export/video`,
      payload,
      {
        responseType: 'blob',
        timeout: 600000,
        onDownloadProgress: (e) => {
          if (onProgress && e.total) {
            onProgress(Math.round((e.loaded * 100) / e.total), 'Downloading video...');
          }
        },
      },
    );
    return { blob: data };
  }
}

// Get system default folders (Downloads, Desktop, etc.)
export async function getDefaultFolders(): Promise<{
  home: string;
  downloads: string;
  desktop: string;
  movies: string;
}> {
  const { data } = await api.get('/projects/default-folders');
  return data;
}

// Reveal or open a folder in macOS Finder / Windows Explorer
export async function openFolderInSystem(path: string): Promise<{ status: string; path: string }> {
  const { data } = await api.post('/projects/open-folder', { path });
  return data;
}

// Open native OS folder chooser dialog
export async function selectFolderInSystem(): Promise<string | null> {
  try {
    const { data } = await api.post('/projects/select-folder');
    return data?.path || null;
  } catch {
    return null;
  }
}

// Audio separation (in-app playback, not download)
export interface AudioSeparationResult {
  status: string;
  vocals_url: string;
  bgm_url: string;
}

export interface AudioSeparationStatus {
  separated: boolean;
  separating?: boolean;
  percent?: number;
  eta_seconds?: number | null;
  vocals_url?: string;
  bgm_url?: string;
  /** How much leftover dialogue has been removed from the BGM */
  bgm_clean?: BgmCleanLevel;
  /** Sound effects Demucs filed under vocals are put back into the BGM */
  bgm_keep_effects?: boolean;
}

export type BgmCleanLevel = 'off' | 'light' | 'strong' | 'max';

/** Remove leftover source dialogue from the isolated BGM. Seconds, no new separation. */
export async function cleanBgm(
  projectId: string,
  level: BgmCleanLevel,
  keepEffects?: boolean,
): Promise<{ level: BgmCleanLevel; keep_effects: boolean; bgm_url: string }> {
  const { data } = await api.post(
    `/projects/${projectId}/export/separate-audio/clean-bgm`,
    { level, keep_effects: keepEffects ?? null },
    { timeout: 600000 },
  );
  return data;
}

export async function fetchStemPeaks(projectId: string, name: 'vocals' | 'bgm'): Promise<number[]> {
  const { data } = await api.get(`/projects/${projectId}/export/stem-peaks`, { params: { name }, timeout: 120000 });
  return data.peaks || [];
}

export async function separateProjectAudio(projectId: string): Promise<AudioSeparationResult> {
  const { data } = await api.post(`/projects/${projectId}/export/separate-audio`);
  return data;
}

export async function checkAudioSeparation(projectId: string): Promise<AudioSeparationStatus> {
  const { data } = await api.get(`/projects/${projectId}/export/separate-audio/status`);
  return data;
}

export async function deleteAudioSeparation(projectId: string): Promise<void> {
  await api.delete(`/projects/${projectId}/export/separate-audio`);
}

// Video tools response (in-place modification)
export interface VideoToolResult {
  status: string;
  video_path: string;
  duration: number;
}

// Video flip (in-place)
export async function flipVideo(
  projectId: string,
  direction: 'horizontal' | 'vertical',
): Promise<VideoToolResult> {
  const { data } = await api.post(
    `/projects/${projectId}/export/flip`,
    { direction },
    { timeout: 600000 },
  );
  return data;
}

// Video rotate (in-place)
export async function rotateVideo(
  projectId: string,
  angle: number,
): Promise<VideoToolResult> {
  const { data } = await api.post(
    `/projects/${projectId}/export/rotate`,
    { angle },
    { timeout: 600000 },
  );
  return data;
}

// Video crop (in-place)
export async function cropVideo(
  projectId: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<VideoToolResult> {
  const { data } = await api.post(
    `/projects/${projectId}/export/crop`,
    { x, y, width, height },
    { timeout: 600000 },
  );
  return data;
}

// Video blur regions (in-place) — e.g. to hide multiple logos/watermarks/subtitles
/** A box to hide at render time, as percentages of the source picture. */
export interface ExportBlurArea {
  x_pct: number; y_pct: number; width_pct: number; height_pct: number;
  style?: 'blur' | 'pixelate' | 'solid'; strength?: number; tint?: number; color?: string;
  start?: number | null; end?: number | null;
}

export async function blurVideoRegions(
  projectId: string,
  regions: Array<{
    x: number; y: number; width: number; height: number;
    style?: 'blur' | 'pixelate' | 'solid'; strength?: number; tint?: number; color?: string;
    start?: number | null; end?: number | null;
  }>,
): Promise<VideoToolResult> {
  const { data } = await api.post(
    `/projects/${projectId}/export/blur-regions`,
    { regions },
    { timeout: 600000 },
  );
  return data;
}

// Logo / Watermark / Image Overlay
export interface Pronunciation {
  word: string;
  say_as: string;
  /** when the spoken form was last set (seconds); dubs older than it say the word the old way */
  changed_at?: number;
}

/** Dubbed lines that still say a dictionary word the way it was said before */
export async function fetchStalePronunciations(): Promise<{ lines: number; projects: number; words: Record<string, number> }> {
  return (await api.get('/settings/pronunciations/stale')).data;
}
/** Clear those dubs and queue their projects for dubbing again */
export async function redubStalePronunciations(): Promise<{ lines: number; projects: number; queued: number; busy: number }> {
  return (await api.post('/settings/pronunciations/redub')).data;
}
/** The text as a dub would say it, dictionary applied; an object URL to play */
export async function listenToPronunciation(text: string): Promise<string> {
  const { data } = await api.post('/settings/pronunciations/listen', { text }, { responseType: 'blob', timeout: 60000 });
  return URL.createObjectURL(data);
}

// --- Joining a series' exported episodes into one long video ---
export interface JoinVideo { name: string; episode: number; size: number }
export interface JoinJob {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  percent: number;
  message: string;
  name: string;
  count: number;
  saved_path?: string | null;
  chapter_text: string;
  reencoded: boolean;
  error?: string | null;
  started_at: string;
  finished_at?: string | null;
}
export async function fetchJoinVideos(projectId: string, folder = '', series = ''): Promise<{ folder: string; exists: boolean; videos: JoinVideo[] }> {
  return (await api.get('/join/videos', { params: { project_id: projectId, folder, series } })).data;
}
export async function startJoin(body: { folder: string; first: number; last: number; name: string; series: string }): Promise<JoinJob> {
  return (await api.post('/join', body)).data;
}
export async function fetchJoins(): Promise<JoinJob[]> {
  return (await api.get('/join')).data;
}
/** Episodes being exported, to be joined in these groups once their files arrive */
export interface JoinPlan {
  id: string;
  folder: string;
  name: string;
  groups: { episodes: number[]; status: 'waiting' | 'joining' | 'done' | 'error'; saved_path?: string | null; error?: string | null }[];
}
export async function planJoin(body: { folder: string; series: string; name: string; groups: number[][] }): Promise<JoinPlan> {
  return (await api.post('/join/plans', body)).data;
}
export async function fetchJoinPlans(): Promise<JoinPlan[]> {
  return (await api.get('/join/plans')).data;
}
export async function cancelJoinPlan(id: string): Promise<void> {
  await api.delete(`/join/plans/${id}`);
}
export async function cancelJoin(id: string): Promise<void> {
  await api.delete(`/join/${id}`);
}

export interface CaptionCoverage {
  available: boolean;
  reason?: string;
  missed_bursts?: number;
  missed_seconds?: number;
  spans?: number;
}

export async function fetchCaptionCoverage(projectId: string): Promise<CaptionCoverage> {
  const { data } = await api.get(`/projects/${projectId}/transcripts/coverage`, { timeout: 120000 });
  return data;
}

export async function fetchPronunciations(): Promise<Pronunciation[]> {
  const { data } = await api.get('/settings/pronunciations');
  return data;
}

export async function savePronunciations(entries: Pronunciation[]): Promise<Pronunciation[]> {
  const { data } = await api.put('/settings/pronunciations', entries);
  return data;
}

export async function fetchProjectLogo(projectId: string): Promise<string | null> {
  const { data } = await api.get(`/projects/${projectId}/watermark`);
  return data.url || null;
}

export async function uploadProjectLogo(
  projectId: string,
  file: File,
): Promise<{ url: string; filename: string; path: string }> {
  const formData = new FormData();
  formData.append('file', file);
  const { data } = await api.post(`/projects/${projectId}/watermark`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function applyVideoLogo(
  projectId: string,
  options: {
    logo_url: string;
    position?: string;
    scale_pct?: number;
    opacity?: number;
    x_pct?: number;
    y_pct?: number;
  },
): Promise<VideoToolResult> {
  const { data } = await api.post(
    `/projects/${projectId}/export/apply-logo`,
    options,
    { timeout: 600000 },
  );
  return data;
}

// Burn subtitles into video (in-place)
export async function burnSubtitles(
  projectId: string,
  fontSize?: number,
  fontColor?: string,
  position?: string,
  bgOpacity?: number,
): Promise<VideoToolResult> {
  const { data } = await api.post(
    `/projects/${projectId}/export/burn-subtitles`,
    {
      font_size: fontSize ?? 28,
      font_color: fontColor ?? 'white',
      position: position ?? 'bottom',
      bg_opacity: bgOpacity ?? 0.5,
    },
    { timeout: 600000 },
  );
  return data;
}

// Settings
export interface ApiKeyInfo {
  usable?: boolean;
  id: string;
  label: string;
  preview: string;
  is_active: boolean;
  created_at: string;
}

export interface AppSettings {
  gemini_model: string;
  speaker_voice: string;
  tts_engine: string;
  voxcpm_model_path: string;
  voxcpm_inference_steps: number;
  /** how hard vocal/BGM isolation drives the GPU */
  separation_pace?: 'fast' | 'balanced' | 'cool';
  available_models: { id: string; name: string; description: string }[];
  api_keys: ApiKeyInfo[];
}

export async function fetchSettings(): Promise<AppSettings> {
  const { data } = await api.get('/settings/');
  return data;
}

export async function updateSettings(updates: { gemini_model?: string; speaker_voice?: string; tts_engine?: string; voxcpm_model_path?: string; voxcpm_inference_steps?: number; separation_pace?: 'fast' | 'balanced' | 'cool' }): Promise<AppSettings> {
  const { data } = await api.patch('/settings/', updates);
  return data;
}

export async function addApiKey(key: string, label: string = ''): Promise<ApiKeyInfo> {
  const { data } = await api.post('/settings/api-keys', { key, label });
  return data;
}

export async function toggleApiKey(keyId: string, isActive: boolean): Promise<ApiKeyInfo> {
  const { data } = await api.patch(`/settings/api-keys/${keyId}`, { is_active: isActive });
  return data;
}

export async function deleteApiKey(keyId: string): Promise<void> {
  await api.delete(`/settings/api-keys/${keyId}`);
}

// --- Video Clips (non-destructive timeline editing) ---

export async function getVideoClips(projectId: string): Promise<VideoClip[]> {
  const { data } = await api.get(`/projects/${projectId}/export/clips`);
  return data;
}

export async function splitClipAtPlayhead(
  projectId: string,
  time: number,
): Promise<VideoClip[]> {
  const { data } = await api.post(
    `/projects/${projectId}/export/clips/split`,
    { time },
  );
  return data;
}

export async function deleteVideoClip(
  projectId: string,
  clipId: string,
): Promise<{ status: string; remaining_clips: number; video_rebuilt: boolean; clips?: VideoClip[] }> {
  const { data } = await api.delete(`/projects/${projectId}/export/clips/${clipId}`);
  return data;
}

export async function restoreVideoClips(
  projectId: string,
  clips: { source_start: number; source_end: number }[],
): Promise<VideoClip[]> {
  const { data } = await api.put(
    `/projects/${projectId}/export/clips/restore`,
    clips,
  );
  return data;
}

export async function updateVideoClip(
  projectId: string,
  clipId: string,
  source_start: number,
  source_end: number,
): Promise<VideoClip> {
  const { data } = await api.patch(
    `/projects/${projectId}/export/clips/${clipId}`,
    { source_start, source_end },
  );
  return data;
}

export async function reorderVideoClips(
  projectId: string,
  clipIds: string[],
): Promise<VideoClip[]> {
  const { data } = await api.put(
    `/projects/${projectId}/export/clips/reorder`,
    { clip_ids: clipIds },
  );
  return data;
}

export async function addVideoClip(
  projectId: string,
  source_start: number,
  source_end: number,
  index?: number,
): Promise<VideoClip[]> {
  const { data } = await api.post(
    `/projects/${projectId}/export/clips/add`,
    { source_start, source_end, index },
  );
  return data;
}

export async function appendVideoFileToTimeline(
  projectId: string,
  file: File,
): Promise<VideoClip[]> {
  const formData = new FormData();
  formData.append('file', file);
  const { data } = await api.post(
    `/projects/${projectId}/export/clips/append-file`,
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 },
  );
  return data;
}

// --- Meatika AI Agent & Direct TTS ---

export async function generateTtsPreview(
  projectId: string,
  options: {
    text: string;
    voice_profile?: string;
    voice_name?: string;
    speed?: number;
    emotion?: string;
    engine?: string;
    reference_audio?: string;
    sample_audio_url?: string;
  },
): Promise<{
  audio_url: string;
  duration: number;
  text: string;
  voice_name: string;
  voice_profile: string;
}> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/tts-preview`, options);
  return data;
}

export async function generateTtsDirect(
  projectId: string,
  options: {
    text: string;
    voice_profile?: string;
    voice_name?: string;
    speed?: number;
    start_time?: number;
    speaker?: string;
    audio_url?: string;
    duration?: number;
    emotion?: string;
    engine?: string;
    reference_audio?: string;
    sample_audio_url?: string;
  },
): Promise<Segment> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/tts-direct`, options);
  return data;
}

// Voice Profiles & Custom Voices API
export interface VoiceProfileItem {
  group_id?: string;
  id: string;
  name: string;
  gender: 'female' | 'male' | 'child_boy' | 'child_girl' | 'grandpa' | 'grandma' | 'child' | 'elderly' | string;
  voice_name: string;
  engine: 'edge-tts' | 'voxcpm';
  language: string;
  pitch: string;
  rate: string;
  emotion: string;
  description: string;
  sample_audio_url?: string;
  is_built_in: boolean;
  created_at?: string;
}

export interface VoiceProfileCreate {
  group_id?: string;
  name: string;
  gender: string;
  voice_name: string;
  engine: string;
  language: string;
  pitch?: string;
  rate?: string;
  emotion?: string;
  description?: string;
  sample_audio_url?: string;
}

export interface VoiceProfileUpdate {
  group_id?: string;
  name?: string;
  gender?: string;
  voice_name?: string;
  engine?: string;
  language?: string;
  pitch?: string;
  rate?: string;
  emotion?: string;
  description?: string;
  sample_audio_url?: string;
}

export async function fetchVoiceProfiles(): Promise<VoiceProfileItem[]> {
  const { data } = await api.get('/settings/voice-profiles');
  return data;
}

export async function createVoiceProfile(profile: VoiceProfileCreate): Promise<VoiceProfileItem> {
  const { data } = await api.post('/settings/voice-profiles', profile);
  window.dispatchEvent(new Event('voice-profiles-changed'));
  return data;
}

export async function updateVoiceProfile(profileId: string, updates: VoiceProfileUpdate): Promise<VoiceProfileItem> {
  const { data } = await api.patch(`/settings/voice-profiles/${profileId}`, updates);
  window.dispatchEvent(new Event('voice-profiles-changed'));
  return data;
}

export async function deleteVoiceProfile(profileId: string): Promise<void> {
  await api.delete(`/settings/voice-profiles/${profileId}`);
  window.dispatchEvent(new Event('voice-profiles-changed'));
}

export async function generateVoiceSample(req: {
  text?: string;
  voice_name?: string;
  voice_profile?: string;
  engine?: string;
  language?: string;
  pitch?: string;
  rate?: string;
  emotion?: string;
  sample_audio_url?: string;
}): Promise<{ ok: boolean; audio_url: string; text: string }> {
  const { data } = await api.post('/settings/voice-profiles/test-sample', req);
  return data;
}

export async function uploadVoiceSampleAudio(file: File): Promise<{ ok: boolean; audio_url: string; filename: string }> {
  const formData = new FormData();
  formData.append('file', file);
  const { data } = await api.post('/settings/voice-profiles/upload-sample', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export interface AutoFitResult {
  ok: boolean;
  updated_count: number;
  sped_up: number;
  slowed: number;
  /** the voice already fits, or is too short to stretch without drawling */
  left: number;
  /** the voice overruns its caption, but into silence */
  runs_on: number;
  /** even at the fastest natural pace the voice does not fit before the next line */
  too_long: number;
  too_long_lines: { id: string; start_time: number; voice_seconds: number; room_seconds: number; text: string }[];
  segments: Segment[];
}

export async function autoFitAudioToSubtitles(
  projectId: string,
  segmentIds?: string[],
  dryRun = false,
): Promise<AutoFitResult> {
  const { data } = await api.post(
    `/projects/${projectId}/transcripts/auto-fit-audio`,
    { segment_ids: segmentIds, dry_run: dryRun },
    { timeout: 300000 },
  );
  return data;
}

export interface CaptionGap {
  index: number;
  start: number;
  end: number;
  seconds: number;
}

export interface GapPlan {
  source: string;
  vocals_available: boolean;
  missed_bursts: number;
  gaps: CaptionGap[];
  total_gaps: number;
  total_seconds: number;
  video_seconds: number;
  segment_count: number;
}

/** Stretches with no speech and no caption — the parts a recap cuts out. */
export async function fetchDeadAirPlan(projectId: string, minSeconds = 1.2): Promise<GapPlan> {
  const res = await fetch(`/api/projects/${projectId}/transcripts/dead-air-plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ min_seconds: minSeconds }),
  });
  if (!res.ok) throw new Error((await res.text()) || 'Could not scan for dead air');
  return res.json();
}

/** What Fill gaps would scan, without transcribing anything. */
export async function fetchGapPlan(projectId: string, minGapSeconds = 0.35): Promise<GapPlan> {
  const res = await fetch(`/api/projects/${projectId}/transcripts/gap-plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ min_gap: minGapSeconds }),
  });
  if (!res.ok) {
    let msg = 'Could not scan for gaps';
    try {
      msg = JSON.parse(await res.text()).detail || msg;
    } catch {
      /* not a JSON error body */
    }
    throw new Error(msg);
  }
  return res.json();
}

export interface FillGapsResult {
  message: string;
  gaps_detected: number;
  filled_count: number;
  skipped_duplicates?: number;
  failed_count?: number;
  /** Gaps whose transcription failed even after a retry — offered for another try. */
  failed_spans?: { start: number; end: number; error?: string }[];
}

export function fillMissingCaptionsStream(
  projectId: string,
  minGapSeconds: number = 1.5,
  onProgress?: (info: { message: string; percent: number; currentGap: number; totalGaps: number; gapStart?: number; gapEnd?: number; filledCount: number; failedCount?: number }) => void,
  onSegment?: (segment: any) => void,
  onDone?: (result: FillGapsResult) => void,
  onError?: (err: string) => void,
  spans?: { start: number; end: number }[],
): () => void {
  const controller = new AbortController();

  fetch(`/api/projects/${projectId}/transcripts/fill-missing-captions-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ min_gap: minGapSeconds, spans: spans?.length ? spans : undefined }),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        const text = await response.text();
        let msg = text || 'Failed to scan gaps';
        try {
          msg = JSON.parse(text).detail || msg;
        } catch {
          /* not a JSON error body */
        }
        onError?.(msg);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        onError?.('No response stream');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          try {
            const evt = JSON.parse(payload);
            if (evt.type === 'start') {
              onProgress?.({
                message: evt.message || 'Scanning video for gaps...',
                percent: 5,
                currentGap: 0,
                totalGaps: evt.gaps_count || 0,
                filledCount: 0,
              });
            } else if (evt.type === 'progress') {
              onProgress?.({
                message: evt.message || '',
                percent: evt.percent || 0,
                currentGap: evt.current_gap || 0,
                totalGaps: evt.total_gaps || 0,
                gapStart: evt.gap_start,
                gapEnd: evt.gap_end,
                filledCount: evt.filled_count || 0,
                failedCount: evt.failed_count || 0,
              });
            } else if (evt.type === 'segment') {
              onSegment?.(evt.segment);
            } else if (evt.type === 'done') {
              onDone?.(evt);
            } else if (evt.type === 'error') {
              onError?.(evt.message);
            }
          } catch {
            // skip malformed
          }
        }
      }
    })
    .catch((e) => {
      if (e.name !== 'AbortError') {
        onError?.(e.message || 'Scanning gaps failed');
      }
    });

  return () => controller.abort();
}

export async function generateCatchyHooks(
  projectId: string,
  options: {
    originalTitle?: string;
    language?: string;
    durationSeconds?: number;
    tone?: string;
  } = {},
): Promise<
  Array<{
    hook_id: string;
    text: string;
    category: string;
    category_label: string;
    estimated_seconds: number;
    why_it_works: string;
  }>
> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/generate-hooks`, {
    original_title: options.originalTitle,
    language: options.language || 'km',
    duration_seconds: options.durationSeconds ?? 4.0,
    tone: options.tone || 'viral',
  });
  return data;
}

export async function retimeIntroHook(
  projectId: string,
  segmentIds: string[],
): Promise<{
  hook_seconds: number;
  planned_seconds: number;
  overflow_seconds: number;
  pushed_segments: number;
  segments: Segment[];
}> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/retime-intro-hook`, {
    segment_ids: segmentIds,
  });
  return data;
}

export async function insertIntroHook(
  projectId: string,
  payload: {
    text: string;
    duration_seconds?: number;
    words_per_segment?: number;
    speaker?: string;
    voice_profile?: string;
    emotion?: string;
  }
): Promise<{
  success: boolean;
  segment_id: string;
  segment_ids?: string[];
  replaced_captions?: number;
  segments: Segment[];
}> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/insert-intro-hook`, payload);
  return data;
}

export async function restoreSegments(projectId: string, segments: Segment[]): Promise<{ status: string; count: number }> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/restore-segments`, { segments });
  return data;
}

export async function captureMovieVoice(projectId: string, request: {
  name: string; start_time: number; end_time: number; speaker?: string; group_id?: string; eq?: VoiceEQ;
}): Promise<{ profile: VoiceProfileItem; assigned_segments: number }> {
  const { data } = await api.post(`/projects/${projectId}/export/capture-voice`, request, { timeout: 90000 });
  window.dispatchEvent(new Event('voice-profiles-changed'));
  return data;
}

export async function fetchVoiceWaveform(projectId: string, start: number, signal: AbortSignal, overview = false): Promise<{ start: number; duration: number; peaks: number[] }> {
  const { data } = await api.get(`/projects/${projectId}/export/voice-waveform`, { params: { start, overview }, signal, timeout: overview ? 200000 : 90000 });
  return data;
}

export interface VoiceGroup { id: string; name: string; }
export async function fetchVoiceGroups(): Promise<VoiceGroup[]> {
  const { data } = await api.get('/settings/voice-groups');
  return data;
}
export async function createVoiceGroup(name: string): Promise<VoiceGroup> {
  const { data } = await api.post('/settings/voice-groups', { name });
  return data;
}

export interface VoiceEQ {
  enabled: boolean;
  low_cut: number;
  warmth: number;
  mud: number;
  presence: number;
  air: number;
}
export async function previewCapturedVoice(projectId: string, start: number, end: number, eq: VoiceEQ, signal: AbortSignal): Promise<Blob> {
  const { data } = await api.post(`/projects/${projectId}/export/preview-capture-voice`, { start_time: start, end_time: end, eq }, { responseType: 'blob', signal, timeout: 90000 });
  return data;
}

// ---------------------------------------------------------------------------
// Splitting a long video into part projects, and joining the finished parts
// ---------------------------------------------------------------------------

export interface SplitPartPlan {
  index: number;
  start: number;
  end: number;
  seconds: number;
  label: string;
}

export interface SplitPlan {
  duration: number;
  part_count: number;
  parts: SplitPartPlan[];
  source_bytes: number;
  max_parts: number;
  min_part_seconds: number;
}

/** Either "cut into N parts" or "cut into parts of this many seconds". */
export type SplitSpec = { parts: number } | { partSeconds: number };

const splitBody = (spec: SplitSpec) =>
  'parts' in spec ? { parts: spec.parts } : { part_seconds: spec.partSeconds };

/** Preview where the cuts would land. Changes nothing. */
export async function planSplit(projectId: string, spec: SplitSpec): Promise<SplitPlan> {
  const res = await fetch(`/api/projects/${projectId}/split/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(splitBody(spec)),
  });
  if (!res.ok) {
    let msg = 'Could not plan the split';
    try {
      msg = JSON.parse(await res.text()).detail || msg;
    } catch {
      /* not a JSON error body */
    }
    throw new Error(msg);
  }
  return res.json();
}

export interface CreatedPart {
  id: string;
  name: string;
  part_index: number;
  part_count: number;
  seconds: number;
  label: string;
}

/** Read an SSE stream of {type, ...} events, calling back per event. */
async function readEventStream(
  res: Response,
  onEvent: (evt: any) => void,
): Promise<void> {
  if (!res.ok) throw new Error((await res.text()) || 'Request failed');
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response stream');
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        onEvent(JSON.parse(line.slice(6)));
      } catch {
        /* ignore malformed keep-alive lines */
      }
    }
  }
}

/** Cut the project's video into N part projects. Resolves with the parts that were created. */
export async function splitProject(
  projectId: string,
  opts: { spec: SplitSpec; deleteSourceVideo?: boolean; nameTemplate?: string },
  onProgress?: (percent: number, message: string) => void,
): Promise<{ parts: CreatedPart[]; freedBytes: number }> {
  const res = await fetch(`/api/projects/${projectId}/split`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...splitBody(opts.spec),
      delete_source_video: !!opts.deleteSourceVideo,
      name_template: opts.nameTemplate || null,
    }),
  });
  let created: CreatedPart[] = [];
  let freed = 0;
  let failure: string | null = null;
  await readEventStream(res, (evt) => {
    if (evt.type === 'progress') onProgress?.(evt.percent || 0, evt.message || '');
    else if (evt.type === 'done') {
      created = evt.parts || [];
      freed = evt.freed_bytes || 0;
    } else if (evt.type === 'error') failure = evt.message || 'Split failed';
  });
  if (failure) throw new Error(failure);
  return { parts: created, freedBytes: freed };
}

/** Every part belonging to the same split, in order. Accepts a part id or the original's id. */
export async function fetchProjectParts(projectId: string): Promise<Project[]> {
  const res = await fetch(`/api/projects/${projectId}/parts`);
  if (!res.ok) return [];
  return res.json();
}

/** Render every part with these export settings and stitch them into one video. */
export async function joinParts(
  projectId: string,
  exportRequest: Record<string, unknown>,
  outputFilename: string | null,
  onProgress?: (percent: number, message: string) => void,
): Promise<{ filename: string; savedPath: string | null; downloadUrl: string; seconds: number }> {
  const res = await fetch(`/api/projects/${projectId}/parts/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ export: exportRequest, output_filename: outputFilename }),
  });
  let done: any = null;
  let failure: string | null = null;
  await readEventStream(res, (evt) => {
    if (evt.type === 'progress') onProgress?.(evt.percent || 0, evt.message || '');
    else if (evt.type === 'done') done = evt;
    else if (evt.type === 'error') failure = evt.message || 'Join failed';
  });
  if (failure) throw new Error(failure);
  if (!done) throw new Error('The join ended without producing a file');
  return {
    filename: done.filename,
    savedPath: done.saved_path || null,
    downloadUrl: done.download_url,
    seconds: done.seconds || 0,
  };
}

/** Stretch each caption into the silence after it and slow its voice to match. */
export async function spreadIntoSilence(
  projectId: string,
  opts: { dryRun?: boolean; refitAudio?: boolean; maxSlowdown?: number } = {},
): Promise<{
  stretched: number;
  refitted_voices: number;
  seconds_reclaimed: number;
  silence_before: number;
  silence_after: number;
  preview: { start_time: number; old_end: number; new_end: number; gained: number; text: string }[];
}> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/spread-into-silence`, {
    dry_run: !!opts.dryRun,
    refit_audio: opts.refitAudio !== false,
    ...(opts.maxSlowdown ? { max_slowdown: opts.maxSlowdown } : {}),
  });
  return data;
}

/** Give every caption a box about as long as its text takes to say. */
export async function normalizeSpeakingRate(
  projectId: string,
  opts: { dryRun?: boolean; targetCps?: number } = {},
): Promise<{
  adjusted: number;
  total: number;
  needs_redub: number;
  overlaps: number;
  rate_before: { p10: number; median: number; p90: number; ratio: number };
  rate_after: { p10: number; median: number; p90: number; ratio: number };
}> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/normalize-speaking-rate`, {
    dry_run: !!opts.dryRun,
    ...(opts.targetCps ? { target_cps: opts.targetCps } : {}),
  });
  return data;
}

/** Break captions carrying more text than a box can show into several lines. */
export async function splitLongCaptions(
  projectId: string,
  opts: { dryRun?: boolean; maxChars?: number } = {},
): Promise<{
  split: number;
  new_lines: number;
  voices_cleared: number;
  overlaps_trimmed: number;
  needs_retranscribe: number;
  total_before: number;
  total_after: number;
  needs_retranscribe_preview: { start: number; chars: number; needed_seconds: number; has_seconds: number }[];
}> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/split-long-captions`, {
    dry_run: !!opts.dryRun,
    ...(opts.maxChars ? { max_chars: opts.maxChars } : {}),
  });
  return data;
}

export interface MovieRecap {
  sections?: { start_time: number | null; end_time: number | null; title?: string; script: string }[];
  source?: string; filename?: string;
  title: string; summary: string; key_events: string[];
  /** Who is in it and how they relate — written by the reading summary */
  characters?: { name: string; description: string }[];
  /** How this part ends and what is left open */
  ending?: string;
  mode?: 'summary' | 'voiceover';
  summary_characters?: number; summary_target_characters?: number; summary_expanded?: boolean;
  language: string; length: 'short' | 'standard' | 'detailed';
  windows_planned?: number; windows_written?: number; windows_missing?: number;
  windows_topped_up?: number; windows_wrong_language?: number; windows_language_retried?: number;
  spoken_seconds?: number; coverage_percent?: number | null;
  current_segments?: number; stale?: boolean;
  source_segments: number; generated_at: string;
}
export async function fetchMovieRecap(projectId: string): Promise<MovieRecap | null> {
  const { data } = await api.get(`/projects/${projectId}/transcripts/movie-recap`);
  return data;
}
export async function generateMovieRecap(
  projectId: string,
  language: string,
  length: MovieRecap['length'],
  input: { source: 'timeline' | 'file'; filename?: string; transcript?: string } = { source: 'timeline' },
  mode: 'summary' | 'voiceover' = 'summary',
): Promise<MovieRecap> {
  const { data } = await api.post(
    `/projects/${projectId}/transcripts/movie-recap`,
    { language, length, mode, ...input },
    { timeout: 1800000 },
  );
  return data;
}

/** Put the saved movie recap onto the timeline as caption lines (no dubbing). */
export async function importRecapToTimeline(
  projectId: string,
  opts: { dryRun?: boolean; keepExisting?: boolean } = {},
): Promise<any> {
  const { data } = await api.post(
    `/projects/${projectId}/transcripts/movie-recap/to-timeline`,
    { dry_run: !!opts.dryRun, keep_existing: !!opts.keepExisting },
    { timeout: 120000 },
  );
  return data;
}

/** Cut stretches out of the edit, pulling later clips and captions earlier. */
export async function removeTimelineRanges(
  projectId: string,
  ranges: { start: number; end: number }[],
  opts: { dryRun?: boolean } = {},
): Promise<{
  removed_seconds: number;
  timeline_before: number;
  timeline_after: number;
  clips_before?: number;
  clips_after?: number;
  captions_before?: number;
  captions_kept: number;
  captions_dropped: number;
}> {
  const { data } = await api.post(`/projects/${projectId}/export/clips/remove-ranges`, {
    ranges: ranges.map((r) => [r.start, r.end]),
    dry_run: !!opts.dryRun,
  });
  return data;
}

// ---------------------------------------------------------------------------
// Text overlays — titles and callouts drawn over the picture
// ---------------------------------------------------------------------------

export interface TextOverlay {
  id: string;
  text: string;
  start_time: number;
  end_time: number;
  x_pct: number;
  y_pct: number;
  anchor: 'center' | 'left' | 'right';
  size_pct: number;
  color: string;
  opacity: number;
  outline_color: string;
  outline_width: number;
  box_color: string;
  box_opacity: number;
  bold: boolean;
  fade_seconds: number;
  animation: OverlayEntrance;
  animation_seconds: number;
  /** How it leaves over its last exit_seconds; 'none' just fades */
  exit_animation?: OverlayExit;
  exit_seconds?: number;
}

export async function fetchTextOverlays(projectId: string): Promise<TextOverlay[]> {
  const { data } = await api.get(`/projects/${projectId}/overlays`);
  return data;
}

/** Save the whole set — the editor holds them as one list. */
export async function saveTextOverlays(
  projectId: string,
  overlays: TextOverlay[],
): Promise<TextOverlay[]> {
  const { data } = await api.put(`/projects/${projectId}/overlays`, { overlays });
  return data;
}

export async function deleteTextOverlay(projectId: string, overlayId: string): Promise<TextOverlay[]> {
  const { data } = await api.delete(`/projects/${projectId}/overlays/${overlayId}`);
  return data;
}

export interface ApplyVoiceFxResult {
  applied: string[];
  /** Clips with no clean copy of their voice — regenerate them as Normal, then apply again. */
  needs_voice: string[];
  segments: Segment[];
}

/** Restyle existing voice clips with ffmpeg — no new text-to-speech, so it is near instant. */
export async function applyVoiceFx(projectId: string, segmentIds: string[], voiceFx: string): Promise<ApplyVoiceFxResult> {
  const { data } = await api.post(`/projects/${projectId}/export/apply-voice-fx`, {
    segment_ids: segmentIds,
    voice_fx: voiceFx,
  });
  return data;
}

export interface ProjectVersion {
  id: string;
  name: string;
  /** Saved by the app before a step that rewrites the edit, rather than by you */
  auto: boolean;
  created_at: string;
  segment_count: number;
  voiced_count: number;
  clip_count: number;
  timeline_seconds: number;
}

export interface RestoreVersionResult {
  segments: number;
  clips: number;
  /** Voices whose audio file is gone — those lines need their voice generated again */
  missing_audio: number;
  restored: ProjectVersion;
  backup: ProjectVersion;
}

export async function listVersions(projectId: string): Promise<ProjectVersion[]> {
  const { data } = await api.get(`/projects/${projectId}/versions`);
  return data;
}

export async function saveVersion(projectId: string, name: string): Promise<ProjectVersion> {
  const { data } = await api.post(`/projects/${projectId}/versions`, { name });
  return data;
}

export async function renameVersion(projectId: string, versionId: string, name: string): Promise<ProjectVersion> {
  const { data } = await api.patch(`/projects/${projectId}/versions/${versionId}`, { name });
  return data;
}

export async function deleteVersion(projectId: string, versionId: string): Promise<void> {
  await api.delete(`/projects/${projectId}/versions/${versionId}`);
}

export async function restoreVersion(projectId: string, versionId: string): Promise<RestoreVersionResult> {
  const { data } = await api.post(`/projects/${projectId}/versions/${versionId}/restore`);
  return data;
}

/** Fired after a version is restored, so views that load their own data (overlays) re-read it. */
export const VERSION_RESTORED_EVENT = 'project-version-restored';

/** Render effects for listening only — the clips keep their current voice. */
export async function previewVoiceFx(
  projectId: string,
  segmentIds: string[],
  voiceFx: string,
): Promise<{ previews: Record<string, string>; needs_voice: string[] }> {
  const { data } = await api.post(`/projects/${projectId}/export/apply-voice-fx`, {
    segment_ids: segmentIds,
    voice_fx: voiceFx,
    preview: true,
  });
  return data;
}

// ---------------------------------------------------------------------------
// Asset library — files kept with the project on the server
// ---------------------------------------------------------------------------

export interface ProjectAsset {
  id: string;
  name: string;
  folder: string;
  type: 'video' | 'audio' | 'image';
  size: number;
  duration: number | null;
  url: string;
  thumb_url: string | null;
  added_at: number;
}

export async function listAssets(projectId: string): Promise<{ folders: string[]; items: ProjectAsset[] }> {
  const { data } = await api.get(`/projects/${projectId}/assets`);
  return data;
}

export async function uploadAssets(
  projectId: string,
  files: File[],
  folder: string,
  onProgress?: (fraction: number) => void,
): Promise<{ added: ProjectAsset[]; skipped: string[]; folders: string[] }> {
  const form = new FormData();
  files.forEach((f) => form.append('files', f));
  form.append('folder', folder);
  const { data } = await api.post(`/projects/${projectId}/assets`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 0,
    onUploadProgress: (e) => e.total && onProgress?.(e.loaded / e.total),
  });
  return data;
}

export async function deleteAsset(projectId: string, assetId: string): Promise<void> {
  await api.delete(`/projects/${projectId}/assets/${assetId}`);
}

export async function setAssetFolders(projectId: string, folders: string[]): Promise<string[]> {
  const { data } = await api.put(`/projects/${projectId}/assets/folders`, { folders });
  return data.folders;
}

export async function assetToTimeline(projectId: string, assetId: string): Promise<VideoClip[]> {
  const { data } = await api.post(`/projects/${projectId}/assets/${assetId}/to-timeline`, null, { timeout: 600000 });
  return data;
}

/** Fired after text overlays are saved anywhere, so every view re-reads them. */
export const TEXT_OVERLAYS_CHANGED = 'text-overlays-changed';
/** Ask the player to open the overlay editor: detail { id?: string } selects one, { create: true } adds one. */
export const OPEN_TEXT_OVERLAYS = 'open-text-overlays';

export interface CharacterGenderFix {
  dry_run: boolean;
  /** Characters whose lines do not all carry the same voice profile */
  characters: {
    name: string;
    profile: string;
    /** "dialogue": worked out from the names and what is said; "majority": most of their own lines */
    decided_by: 'dialogue' | 'majority';
    lines: number;
    lines_changed: number;
  }[];
  lines_changed: number;
  voices_cleared: number;
  named_characters: number;
}

/** Give every named character one gender across all of their lines. */
export async function fixCharacterGenders(projectId: string, dryRun = false): Promise<CharacterGenderFix> {
  const { data } = await api.post(
    `/projects/${projectId}/export/fix-character-genders`,
    { dry_run: dryRun },
    { timeout: 180000 },
  );
  return data;
}

// --- Review: what is worth a look before exporting ---

export interface ReviewIssue {
  key: string;
  /** 'problem' makes the exported video wrong; 'check' is worth a look but may be intended */
  severity: 'problem' | 'check';
  count: number;
  title: string;
  hint: string;
  segment_ids?: string[];
  first_time?: number;
}

// --- Pipeline queue: caption, dub and export on the server, with the page free to close ---

export interface PipelineJob {
  id: string;
  project_id: string;
  project_name: string;
  /** 'review': the export is waiting for someone to look at `issues` and approve it */
  status: 'queued' | 'running' | 'review' | 'done' | 'error' | 'cancelled';
  /** The step in progress: music | captions | speakers | dubbing | export */
  step: string;
  steps: string[];
  percent: number;
  message: string;
  /** What each finished step did */
  notes: string[];
  issues?: ReviewIssue[];
  error?: string | null;
  queued_at: string;
  finished_at?: string | null;
  /** Set while the job waits for Gemini quota: it is not tried again before this time */
  retry_at?: string | null;
}

/** Seconds until each running or waiting job is done; null until a step has been timed once */
export async function fetchPipelineEstimate(): Promise<{ jobs: Record<string, number | null>; waiting_for_quota: number }> {
  return (await api.get('/pipeline/estimate')).data;
}

/** Stop waiting for Gemini quota and try the waiting jobs again now */
export async function retryPipelineNow(): Promise<{ retried: number }> {
  return (await api.post('/pipeline/retry-now')).data;
}

export interface PipelineOptions {
  language?: string;
  /** Space overlapping lines, shorten the ones that do not fit, drop bad voices */
  repair?: boolean;
  /** Split the film's sound into voices and background music (on this computer, no quota) */
  music?: boolean;
  captions?: boolean;
  /** Work out who speaks each line that names nobody — for imported subtitles */
  speakers?: boolean;
  dub?: boolean;
  export?: boolean;
  /** Check the project before exporting and wait for approval if anything looks wrong (default on) */
  hold_for_review?: boolean;
  /** The render settings for the export step; defaults to dubbed voice with burned-in captions */
  export_request?: Record<string, unknown>;
}

export async function addToPipeline(projectId: string, options: PipelineOptions): Promise<PipelineJob> {
  const { data } = await api.post(`/pipeline/${projectId}`, options);
  return data;
}

export async function fetchPipeline(): Promise<PipelineJob[]> {
  const { data } = await api.get('/pipeline');
  return data;
}

/** Export a job that is held for review, as it is. */
export async function fixPipelineJob(jobId: string): Promise<PipelineJob> {
  const { data } = await api.post(`/pipeline/${jobId}/fix`);
  return data;
}

export async function approvePipelineJob(jobId: string): Promise<PipelineJob> {
  const { data } = await api.post(`/pipeline/${jobId}/approve`);
  return data;
}

export async function removePipelineJob(jobId: string): Promise<void> {
  await api.delete(`/pipeline/${jobId}`);
}

// --- Shorten to fit: lines with more words than their time ---

export interface ShortenProposal {
  id: string;
  start_time: number;
  /** Seconds the line has before the next one starts */
  seconds: number;
  before: string;
  after: string;
  chars_before: number;
  chars_after: number;
  budget: number;
  /** false when even the rewrite is longer than its time allows */
  fits: boolean;
  had_voice: boolean;
}

/** Find the lines that cannot be said in their time and get shorter wording for each.
 *  Nothing is changed until `applyShortened` is called. */
export async function proposeShorterLines(
  projectId: string,
  segmentIds?: string[],
): Promise<{ candidates: number; proposals: ShortenProposal[]; unchanged: number }> {
  const { data } = await api.post(
    `/projects/${projectId}/transcripts/shorten-to-fit`,
    { segment_ids: segmentIds || null },
    { timeout: 300000 },
  );
  return data;
}

export async function applyShortened(
  projectId: string,
  lines: { id: string; text: string }[],
): Promise<{ applied: number; voices_cleared: number }> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/shorten-to-fit`, { apply: lines });
  return data;
}

// --- The cast: one voice per character ---

export interface CastChange {
  /** The character as currently labelled */
  name: string;
  /** Rename; giving another character's name merges the two */
  new_name?: string;
  voice_profile?: string;
  /** '' means the built-in voice for the character's type */
  voice_name?: string;
}

export async function updateCast(projectId: string, changes: CastChange[]): Promise<{
  lines: number;
  renamed: number;
  voices_cleared: number;
}> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/cast`, { changes });
  return data;
}

// --- Series templates: a project's look, saved to reuse ---

export interface SeriesTemplate {
  id: string;
  name: string;
  created_at?: string;
  /** Export platform this series goes to, '' when none was saved */
  platform: string;
  source_project: string;
  /** Which parts of the look it carries: caption_style, video_filter, logo, aspect_ratio */
  has: string[];
}

export async function listTemplates(): Promise<SeriesTemplate[]> {
  const { data } = await api.get('/templates');
  return data;
}

export async function saveTemplate(name: string, projectId: string, platform = ''): Promise<SeriesTemplate> {
  const { data } = await api.post('/templates', { name, project_id: projectId, platform });
  return data;
}

export async function deleteTemplate(templateId: string): Promise<void> {
  await api.delete(`/templates/${templateId}`);
}

export async function applyTemplate(templateId: string, projectId: string): Promise<{ applied: string[]; platform: string }> {
  const { data } = await api.post(`/templates/${templateId}/apply/${projectId}`);
  return data;
}

// --- Publish kit: titles, descriptions and tags for posting the video ---

export interface PublishKit {
  titles: { style: string; label: string; text: string }[];
  /** The title picked to post with */
  chosen_title: string;
  hook: string;
  description: string;
  short_caption: string;
  facebook_caption: string;
  hashtags: string[];
  /** Hashtags switched off by hand; they stay in the list but are not copied */
  hashtags_off?: string[];
  seo_keywords: string[];
  pinned_comment: string;
  /** Two-line thumbnail wording, one option per angle (older kits hold plain strings) */
  thumbnail_texts: ({ angle: string; label: string; main: string; sub: string; highlight?: string } | string)[];
  tone: string;
  platform: string;
  language: string;
  source_segments: number;
  generated_at: string;
  /** The series details this set was written with, if any */
  series?: Omit<PublishSeries, 'suggested'> | null;
  /** The captions have changed since this was written */
  stale?: boolean;
}

/** The series a video is one part of; the titles are written knowing it is not the whole story */
export interface PublishSeries {
  series_name: string;
  /** 0 when not known */
  part: number;
  total_parts: number;
  premise: string;
  /** Offered from the last project and the project's name, not yet confirmed for this one */
  suggested?: boolean;
}

export async function fetchPublishSeries(projectId: string): Promise<PublishSeries> {
  const { data } = await api.get(`/projects/${projectId}/transcripts/publish-series`);
  return data;
}

export async function savePublishSeries(projectId: string, series: PublishSeries): Promise<PublishSeries> {
  const { data } = await api.put(`/projects/${projectId}/transcripts/publish-series`, series);
  return data;
}

export async function fetchPublishKit(projectId: string): Promise<PublishKit | null> {
  const { data } = await api.get(`/projects/${projectId}/transcripts/publish-kit`);
  return data;
}

export async function generatePublishKit(projectId: string, tone: string, platform: string): Promise<PublishKit> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/publish-kit`, { tone, platform }, { timeout: 300000 });
  return data;
}

/** Move overlapping lines apart so their voices take turns; the moved lines lose their voice */
export async function spaceOverlappingLines(projectId: string): Promise<{ moved: number; to_revoice: string[] }> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/space-overlaps`);
  return data;
}

export async function savePublishKit(projectId: string, edits: Partial<PublishKit>): Promise<void> {
  await api.put(`/projects/${projectId}/transcripts/publish-kit`, edits);
}

/** The film's poster kept with a project: as uploaded, and with its title painted out */
export interface PosterState {
  original_url: string | null;
  clean_url: string | null;
  /** Which engine made the title-free version */
  clean_engine?: 'codex' | 'gemini' | null;
  /** The poster repainted by the AI with the new title lettered in, and the words it was asked for */
  titled_url?: string | null;
  titled_engine?: 'codex' | 'gemini' | null;
  titled_title?: string | null;
  titled_subtitle?: string | null;
  /** What the poster's own title says, and that title in the project's language */
  reading?: { original: string; romanised: string; meaning: string; title: string; subtitle: string; engine?: string } | null;
  /** Codex is installed here and signed in with ChatGPT */
  codex_ready?: boolean;
}

export type PosterEngine = 'auto' | 'codex' | 'gemini';

export async function fetchPoster(projectId: string): Promise<PosterState> {
  const { data } = await api.get(`/projects/${projectId}/transcripts/poster`);
  return data;
}

export async function uploadPoster(projectId: string, file: File): Promise<PosterState> {
  const formData = new FormData();
  formData.append('image', file);
  const { data } = await api.post(`/projects/${projectId}/transcripts/poster`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

/** Ask Codex or Gemini to erase the original title; Codex takes about two minutes */
export async function removePosterTitle(projectId: string, engine: PosterEngine = 'auto'): Promise<PosterState> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/poster/remove-title`, { engine }, { timeout: 900000 });
  return data;
}

/** Read the poster's own title and translate it into the project's language */
export async function readPosterTitle(projectId: string): Promise<PosterState> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/poster/read-title`, {}, { timeout: 300000 });
  return data;
}

/** Ask the AI to repaint the poster with this title in place of the original, in its style */
export async function paintPosterTitle(projectId: string, title: string, subtitle: string, engine: PosterEngine = 'auto'): Promise<PosterState> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/poster/with-title`, { title, subtitle, engine }, { timeout: 900000 });
  return data;
}

export async function deletePoster(projectId: string): Promise<PosterState> {
  const { data } = await api.delete(`/projects/${projectId}/transcripts/poster`);
  return data;
}

export interface SeriesTerm { source: string; target: string }
export interface SeriesCharacter extends SeriesTerm {
  aliases: string[]; voice_profile: string; voice_name: string; notes: string;
  /** how this person sounds in every episode; '' lets the series choose */
  voice_style?: '' | 'deep' | 'low' | 'natural' | 'bright' | 'high';
}
export interface SeriesMemory {
  language: string; terms: SeriesTerm[]; characters: SeriesCharacter[]; notes: string;
  /** how the whole series is worded; '' leaves it to the translator */
  style?: '' | 'formal' | 'everyday' | 'street';
  /** how people address each other */
  address?: string;
}
/** A line spoken as this cast member will be dubbed; an object URL to play */
export async function fetchVoiceSample(id: string, voice: { voice_profile: string; voice_name: string; voice_style: string }): Promise<string> {
  const { data } = await api.post(`/projects/${id}/series-memory/voice-sample`, voice, { responseType: 'blob', timeout: 60000 });
  return URL.createObjectURL(data);
}
export interface TranslationReview {
  issues: { id: string; reasons: string[] }[]; checked: number; warnings: string[]; without_source: number;
}
export async function fetchSeriesMemory(id: string): Promise<{ memory: SeriesMemory; projects: number; speakers: string[]; name: string }> {
  return (await api.get(`/projects/${id}/series-memory`)).data;
}
export async function saveSeriesMemory(id: string, memory: SeriesMemory): Promise<SeriesMemory> {
  return (await api.put(`/projects/${id}/series-memory`, memory)).data;
}
export async function applySeriesCast(id: string, restyled: string[] = []): Promise<{ changed: number; projects: number }> {
  return (await api.post(`/projects/${id}/series-memory/apply-cast`, { restyled }, { timeout: 300000 })).data;
}
/** One line of one episode that needs a look, and why */
export interface ReviewLine {
  project_id: string;
  project_name: string;
  episode: number;
  segment_id: string;
  start_time: number;
  end_time: number;
  speaker: string;
  text: string;
  kind: string;
  severity: 'problem' | 'check';
  label: string;
  detail: string;
  /** dubbing the line again is the fix */
  redub: boolean;
}
export interface SeriesReview {
  items: ReviewLine[];
  total: number;
  shown: number;
  episodes_checked: number;
  episodes_flagged: number;
  kinds: Record<string, { label: string; severity: 'problem' | 'check'; redub: boolean; count: number }>;
}
/** Every line that needs a look across all the episodes of the series */
export async function fetchSeriesReview(id: string): Promise<SeriesReview> {
  return (await api.get(`/projects/${id}/series-review`, { timeout: 300000 })).data;
}
/** Fix in every episode what the review found and a machine can put right */
export async function fixSeries(id: string): Promise<{ spellings_found: number; spellings_fixed: number; spelling_error: string; queued: number; busy: number }> {
  return (await api.post(`/projects/${id}/series-review/fix`, {}, { timeout: 0 })).data;
}
/** Throw away these lines' voices and queue their episodes for dubbing again */
export async function redubReviewLines(id: string, segmentIds: string[]): Promise<{ lines: number; episodes: number; queued: number; busy: number }> {
  return (await api.post(`/projects/${id}/series-review/redub`, { segment_ids: segmentIds })).data;
}
/** Add every named speaker of every episode to the series cast */
export async function learnSeriesCast(id: string): Promise<{ added: string[]; memory: SeriesMemory; projects: number }> {
  return (await api.post(`/projects/${id}/series-memory/learn-cast`)).data;
}
export interface SeriesTermSuggestion extends SeriesTerm { kind: 'character' | 'place' | 'term'; count: number }
/** Names and recurring terms found in the episodes, to approve */
export async function suggestSeriesTerms(id: string): Promise<{ suggestions: SeriesTermSuggestion[]; projects: number }> {
  return (await api.post(`/projects/${id}/series-memory/suggest-terms`, {}, { timeout: 180000 })).data;
}
/** How many lines spell a locked name or term some other way */
export async function checkSeriesSpellings(id: string, all = true): Promise<{ lines: number; episodes: number; checked: number }> {
  return (await api.post(`/projects/${id}/series-memory/spelling-check`, { all })).data;
}
/** Translate those lines again so they use the locked spellings */
export async function fixSeriesSpellings(id: string, all = true): Promise<{ found: number; fixed: number; remaining: number; episodes: number; checked: number; failed: string[] }> {
  return (await api.post(`/projects/${id}/series-memory/fix-spellings`, { all }, { timeout: 0 })).data;
}
/** The logo to put on every video of this folder or split film, if any episode has one */
export async function fetchSeriesLogo(id: string): Promise<{ logo: Record<string, any> | null; project_id: string | null; project_name: string | null }> {
  return (await api.get(`/projects/${id}/series-logo`)).data;
}
export async function scanTranslations(id: string, semantic = false): Promise<TranslationReview> {
  return (await api.post(`/projects/${id}/translation-review`, { semantic }, { timeout: 0 })).data;
}

// --- Updating the app from inside the app ---
export interface AppUpdateStatus {
  /** the screens have changed since the app's pages were built */
  pages_behind: boolean;
  /** the server's code has changed since it was started (desktop app only) */
  server_behind: boolean;
  update_ready: boolean;
  built_at: number;
  /** jobs an update would interrupt; they pick up again afterwards */
  working: number;
}
export async function fetchAppUpdate(): Promise<AppUpdateStatus> {
  return (await api.get('/app/update')).data;
}
/** Build the pages again and, when its code changed, start the server again */
export async function applyAppUpdate(): Promise<{ pages_built: boolean; restarting: boolean }> {
  return (await api.post('/app/update', {}, { timeout: 330000 })).data;
}
