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

// Streaming transcription via SSE
export function generateTranscriptStream(
  projectId: string,
  language: string = 'km',
  onSegment: (segment: Segment) => void,
  onDone: (total: number) => void,
  onError: (error: string) => void,
  onProgress?: (message: string) => void,
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
              onProgress?.(evt.message);
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
export async function translateSegments(projectId: string, language: string): Promise<Array<{ id: string; start_time: number; end_time: number; text: string; speaker: string }>> {
  const { data } = await api.post(`/projects/${projectId}/transcripts/translate`, { language });
  return data;
}

// Re-transcribe only selected segments
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
}

export async function generateNarration(
  projectId: string,
  language: string,
  style: string,
): Promise<{ segments: NarrationSegment[]; style: string; language: string }> {
  const { data } = await api.post(
    `/projects/${projectId}/transcripts/generate-narration`,
    { language, style },
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
    { timeout: 60000 },
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

// Video export for platform
export async function exportVideoForPlatform(
  projectId: string,
  platform: string,
  startTime?: number,
  endTime?: number,
  includeSubtitles?: boolean,
  onProgress?: (pct: number) => void,
  includeVoice?: boolean,
  splitDuration?: number,
  subtitleLanguage?: string,
  muteOriginalAudio?: boolean,
  scaleMode?: string,
): Promise<Blob> {
  const { data } = await api.post(
    `/projects/${projectId}/export/video`,
    {
      platform,
      start_time: startTime ?? null,
      end_time: endTime ?? null,
      include_subtitles: includeSubtitles ?? false,
      include_voice: includeVoice ?? false,
      mute_original_audio: muteOriginalAudio ?? false,
      split_duration: splitDuration ?? null,
      subtitle_language: subtitleLanguage || null,
      scale_mode: scaleMode || 'fit',
    },
    {
      responseType: 'blob',
      timeout: 600000,
      onDownloadProgress: (e) => {
        if (onProgress && e.total) {
          onProgress(Math.round((e.loaded * 100) / e.total));
        }
      },
    },
  );
  return data;
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
