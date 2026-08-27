import axios from 'axios';
import type { Project, ProjectListItem, Segment, VideoClip } from '../types';

const api = axios.create({
  baseURL: '/api',
});

// Projects
export async function fetchProjects(): Promise<ProjectListItem[]> {
  const { data } = await api.get('/projects/');
  return data;
}

export async function fetchProject(id: string): Promise<Project> {
  const { data } = await api.get(`/projects/${id}`);
  return data;
}

export async function createProject(name: string, description = '', language = 'km'): Promise<Project> {
  const { data } = await api.post('/projects/', { name, description, language });
  return data;
}

export async function updateProject(id: string, updates: Partial<Project>): Promise<Project> {
  const { data } = await api.patch(`/projects/${id}`, updates);
  return data;
}

export async function deleteProject(id: string): Promise<void> {
  await api.delete(`/projects/${id}`);
}

export async function removeProjectVideo(projectId: string): Promise<Project> {
  const { data } = await api.delete(`/projects/${projectId}/video`);
  return data;
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
  onDone: (total: number) => void,
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
              onDone(evt.total_segments);
            } else if (evt.type === 'error') {
              onError(evt.message);
            }
          } catch {
            // skip malformed lines
          }
        }
      }
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
  onDone?: (total: number) => void,
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
              onDone?.(evt.total);
            } else if (evt.type === 'error') {
              onError?.(evt.message);
            }
          } catch {
            // skip malformed lines
          }
        }
      }
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        onError?.(err.message || 'Stream connection failed');
      }
    });

  return controller;
}

export async function translateSegments(
  projectId: string,
  language: string,
  segmentIds?: string[],
): Promise<Array<{ id: string; start_time: number; end_time: number; text: string; speaker: string }>> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/translate`, {
    language,
    segment_ids: segmentIds || null,
  });
  return data;
}

export async function sanitizeProjectTimeline(projectId: string): Promise<Segment[]> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/sanitize-timeline`);
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

// Mute audio (in-place, removes audio track)
export async function muteProjectAudio(
  projectId: string,
): Promise<{ status: string; video_path: string; duration: number }> {
  const { data } = await api.post(
    `/projects/${projectId}/export/mute-audio`,
    {},
    { timeout: 300000 },
  );
  return data;
}

// Clear all subtitle segments
export async function clearAllSegments(projectId: string): Promise<void> {
  await api.delete(`/projects/${projectId}/transcripts/all`);
}

// AI Narration — generate voiceover script
export interface NarrationSegment {
  index: number;
  start_time: number;
  end_time: number;
  text: string;
  type?: 'narration' | 'dialogue';
  speaker?: string;
  gender?: string;
  emotion?: string;
}

export async function generateNarration(
  projectId: string,
  language: string,
  style: string,
  promptHint?: string,
): Promise<{ segments: NarrationSegment[]; style: string; language: string }> {
  const { data } = await api.post(
    `/projects/${projectId}/transcripts/generate-narration`,
    { language, style, prompt_hint: promptHint || '' },
    // Long videos take Gemini a while to analyze — allow up to 15 minutes
    { timeout: 900000 },
  );
  return data;
}

export async function applyNarration(
  projectId: string,
  segments: NarrationSegment[],
  voiceProfile: string,
): Promise<Segment[]> {
  const { data } = await api.post(
    `/projects/${projectId}/transcripts/apply-narration`,
    { segments, voice_profile: voiceProfile },
    { timeout: 300000 },
  );
  return data;
}

export interface ViralTitleItem {
  category: string;
  category_label: string;
  title: string;
  description: string;
}

export interface ScriptBlockItem {
  time_range: string;
  start_time: number;
  end_time: number;
  block_name: string;
  visual: string;
  text_on_screen: string;
  sound_effect?: string;
  voiceover: string;
  voiceover_tone?: string;
}

export interface SocialMediaScriptResult {
  title?: string;
  total_duration?: string;
  platform?: string;
  tone?: string;
  bgm_suggestion?: string;
  hook: string;
  synopsis: string;
  call_to_action: string;
  pinned_comment?: string;
  editing_tips?: string[];
  blocks?: ScriptBlockItem[];
  titles?: string[];
  description?: string;
  hashtags: string[];
  seo_tags?: string[];
  full_post: string;
  full_script_markdown?: string;
}

export interface GenerateSocialScriptOptions {
  originalTitle?: string;
  language?: string;
  platform?: string;
  tone?: string;
  durationTarget?: string;
  customNotes?: string;
}

export async function generateSocialMediaScript(
  projectId: string,
  optionsOrTitle?: string | GenerateSocialScriptOptions,
  legacyLanguage?: string,
): Promise<SocialMediaScriptResult> {
  const payload = typeof optionsOrTitle === 'object' && optionsOrTitle !== null
    ? {
        original_title: optionsOrTitle.originalTitle || '',
        language: optionsOrTitle.language || 'km',
        platform: optionsOrTitle.platform || 'tiktok',
        tone: optionsOrTitle.tone || 'suspense',
        duration_target: optionsOrTitle.durationTarget || '30-60s',
        custom_notes: optionsOrTitle.customNotes || '',
      }
    : {
        original_title: optionsOrTitle || '',
        language: legacyLanguage || 'km',
        platform: 'tiktok',
        tone: 'suspense',
        duration_target: '30-60s',
      };

  const { data } = await api.post(
    `/projects/${projectId}/transcripts/generate-social-script`,
    payload,
    { timeout: 600000 },
  );
  return data;
}

// Import SRT file as project segments
export async function importSrtFile(projectId: string, file: File): Promise<import('../types').Segment[]> {
  const formData = new FormData();
  formData.append('file', file);
  const { data } = await api.post(
    `/projects/${projectId}/transcripts/import-srt`,
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 30000 },
  );
  return data;
}

// Platform presets
export interface PlatformPreset {
  name: string;
  width: number;
  height: number;
  description: string;
  max_duration: number | null;
}

export async function fetchPlatforms(projectId: string): Promise<Record<string, PlatformPreset>> {
  const { data } = await api.get(`/projects/${projectId}/export/video/platforms`);
  return data;
}

// Video export for platform with real-time SSE progress
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
  },
): Promise<{ blob: Blob; filename?: string; savedPath?: string; exportFolder?: string }> {
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
  };

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

// Video cut/trim (in-place, replaces project video)
export async function cutVideo(
  projectId: string,
  startTime: number,
  endTime: number,
): Promise<{ status: string; video_path: string; duration: number }> {
  const { data } = await api.post(
    `/projects/${projectId}/export/cut`,
    { start_time: startTime, end_time: endTime },
    { timeout: 300000 },
  );
  return data;
}

// Audio separation (in-app playback, not download)
export interface AudioSeparationResult {
  status: string;
  vocals_url: string;
  bgm_url: string;
}

export interface AudioSeparationStatus {
  separated: boolean;
  vocals_url?: string;
  bgm_url?: string;
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
export async function blurVideoRegions(
  projectId: string,
  regions: Array<{ x: number; y: number; width: number; height: number }>,
): Promise<VideoToolResult> {
  const { data } = await api.post(
    `/projects/${projectId}/export/blur-regions`,
    { regions },
    { timeout: 600000 },
  );
  return data;
}

export async function blurVideoRegion(
  projectId: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<VideoToolResult> {
  return blurVideoRegions(projectId, [{ x, y, width, height }]);
}

// Logo / Watermark / Image Overlay
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

// Video resize (in-place)
export async function resizeVideo(
  projectId: string,
  width: number,
  height: number,
): Promise<VideoToolResult> {
  const { data } = await api.post(
    `/projects/${projectId}/export/resize`,
    { width, height },
    { timeout: 600000 },
  );
  return data;
}

// Video speed change (in-place)
export async function changeVideoSpeed(
  projectId: string,
  speed: number,
): Promise<VideoToolResult> {
  const { data } = await api.post(
    `/projects/${projectId}/export/speed`,
    { speed },
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

// Generate selected video (trim + optional text, in-place)
export async function generateSelectedVideo(
  projectId: string,
  startTime: number,
  endTime: number,
  text?: string,
  fontSize?: number,
  fontColor?: string,
  position?: string,
  bgOpacity?: number,
): Promise<{ status: string; video_path: string; duration: number }> {
  const { data } = await api.post(
    `/projects/${projectId}/export/generate-selected`,
    {
      start_time: startTime,
      end_time: endTime,
      text: text || null,
      font_size: fontSize ?? 48,
      font_color: fontColor ?? 'white',
      position: position ?? 'bottom',
      bg_opacity: bgOpacity ?? 0.5,
    },
    { timeout: 600000 },
  );
  return data;
}

// Generate selected audio (extract audio from time range, downloads)
export async function generateSelectedAudio(
  projectId: string,
  startTime: number,
  endTime: number,
  audioFormat: string = 'mp3',
): Promise<Blob> {
  const { data } = await api.post(
    `/projects/${projectId}/export/generate-selected-audio`,
    {
      start_time: startTime,
      end_time: endTime,
      audio_format: audioFormat,
    },
    { responseType: 'blob', timeout: 600000 },
  );
  return data;
}

// Generate AI voice from subtitle text (TTS)
export async function generateVoiceAudio(
  projectId: string,
  segmentIds?: string[],
  outputFormat: string = 'mp3',
): Promise<Blob> {
  const { data } = await api.post(
    `/projects/${projectId}/export/generate-voice`,
    {
      segment_ids: segmentIds || null,
      output_format: outputFormat,
    },
    { responseType: 'blob', timeout: 600000 },
  );
  return data;
}

// Generate AI voice per-segment (saves audio_url to each segment, no download)
export async function generateVoiceSegments(
  projectId: string,
  segmentIds?: string[],
  speed: number = 1.0,
): Promise<Segment[]> {
  const { data } = await api.post(
    `/projects/${projectId}/export/generate-voice-segments`,
    {
      segment_ids: segmentIds || null,
      speed,
    },
    { timeout: 600000 },
  );
  return data;
}

// Video split (in-place, keeps first part)
export async function splitVideo(
  projectId: string,
  splitPoints: number[],
): Promise<{ status: string; video_path: string; duration: number }> {
  const { data } = await api.post(
    `/projects/${projectId}/export/split`,
    { split_points: splitPoints },
    { timeout: 600000 },
  );
  return data;
}

// Settings
export interface ApiKeyInfo {
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
  available_models: { id: string; name: string; description: string }[];
  api_keys: ApiKeyInfo[];
}

export async function fetchSettings(): Promise<AppSettings> {
  const { data } = await api.get('/settings/');
  return data;
}

export async function updateSettings(updates: { gemini_model?: string; speaker_voice?: string; tts_engine?: string; voxcpm_model_path?: string; voxcpm_inference_steps?: number }): Promise<AppSettings> {
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

export async function askAiAgent(
  projectId: string,
  action: string,
  prompt: string = '',
): Promise<{ action: string; content: string }> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/ai-agent`, {
    action,
    prompt,
  });
  return data;
}

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
  return data;
}

export async function updateVoiceProfile(profileId: string, updates: VoiceProfileUpdate): Promise<VoiceProfileItem> {
  const { data } = await api.patch(`/settings/voice-profiles/${profileId}`, updates);
  return data;
}

export async function deleteVoiceProfile(profileId: string): Promise<void> {
  await api.delete(`/settings/voice-profiles/${profileId}`);
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

export async function shiftProjectTimestamps(
  projectId: string,
  offsetSeconds: number,
  segmentIds?: string[]
): Promise<Segment[]> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/shift-timestamps`, {
    offset: offsetSeconds,
    segment_ids: segmentIds,
  });
  return data;
}

export async function fillMissingCaptions(
  projectId: string,
  minGapSeconds: number = 1.5,
): Promise<{ message: string; gaps_detected: number; captions_generated: number }> {
  const { data } = await api.post(
    `/projects/${projectId}/transcripts/fill-missing-captions`,
    { min_gap: minGapSeconds },
    { timeout: 600000 },
  );
  return data;
}

export async function generateMovieTitles(
  projectId: string,
  originalTitle?: string,
  language?: string,
): Promise<Array<{ category: string; category_label: string; title: string; description: string }>> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/generate-titles`, {
    original_title: originalTitle,
    language: language || 'km',
  });
  return data;
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

export async function generateViralMetadata(
  projectId: string,
  options: {
    originalTitle?: string;
    language?: string;
    tone?: string;
    platform?: string;
  } = {},
): Promise<{
  titles: Array<{ category: string; category_label: string; title: string; description: string }>;
  hook?: string;
  captions?: { tiktok?: string; youtube_shorts?: string };
  hashtags?: string[];
  pinned_comment?: string;
  call_to_action?: string;
}> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/generate-viral-metadata`, {
    original_title: options.originalTitle,
    language: options.language || 'km',
    tone: options.tone || 'viral',
    platform: options.platform || 'all',
  });
  return data;
}
