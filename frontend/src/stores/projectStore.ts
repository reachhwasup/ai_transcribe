import { create } from 'zustand';
import type { Project, ProjectListItem, Segment, VideoClip } from '../types';
import * as api from '../api/client';

interface ProjectStore {
  // State
  projects: ProjectListItem[];
  currentProject: Project | null;
  activeSegmentId: string | null;
  currentTime: number;
  isPlaying: boolean;
  isLoading: boolean;
  videoClips: VideoClip[];
  isTranscribing: boolean;
  transcribeProgress: string;
  isGeneratingAudio: boolean;
  audioGenProgress: number;
  audioGenTotal: number;
  selectedSegmentIds: Set<string>;
  videoMuted: boolean;
  uploadProgress: number;
  error: string | null;
  subtitleStyle: { sizePct: number; position: 'bottom' | 'middle' | 'top' };

  // Actions
  setSubtitleStyle: (style: Partial<{ sizePct: number; position: 'bottom' | 'middle' | 'top' }>) => void;
  loadProjects: () => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  createProject: (name: string, description?: string) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  uploadVideo: (file: File) => Promise<void>;
  generateTranscript: () => void;
  cancelTranscription: () => void;
  updateSegment: (segmentId: string, updates: Partial<Segment>) => Promise<void>;
  deleteSegment: (segmentId: string) => Promise<void>;
  addSegment: (segment: Partial<Segment>) => Promise<void>;
  bulkSetVoice: (voice: string, segmentIds?: string[]) => Promise<void>;
  generateVoiceForSegments: (segmentIds?: string[], speed?: number) => Promise<void>;
  setActiveSegment: (id: string | null) => void;
  setCurrentTime: (time: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setVideoClips: (clips: VideoClip[]) => void;
  setSelectedSegmentIds: (ids: Set<string>) => void;
  retranscribeSelected: (segmentIds: string[]) => Promise<void>;
  setVideoMuted: (muted: boolean) => void;
  clearError: () => void;
}

export const useProjectStore = create<ProjectStore>((set, get) => {
  let _transcribeAbort: AbortController | null = null;

  return {
  projects: [],
  currentProject: null,
  activeSegmentId: null,
  currentTime: 0,
  isPlaying: false,
  isLoading: false,
  videoClips: [],
  isTranscribing: false,
  transcribeProgress: '',
  isGeneratingAudio: false,
  audioGenProgress: 0,
  audioGenTotal: 0,
  selectedSegmentIds: new Set<string>(),
  videoMuted: false,
  uploadProgress: 0,
  subtitleStyle: { sizePct: 4, position: 'bottom' as const },
  error: null,

  loadProjects: async () => {
    set({ isLoading: true, error: null });
    try {
      const projects = await api.fetchProjects();
      set({ projects, isLoading: false });
    } catch (e: any) {
      set({ error: e.message, isLoading: false });
    }
  },

  loadProject: async (id: string) => {
    set({ isLoading: true, error: null });
    try {
      const project = await api.fetchProject(id);
      // Restore this project's saved subtitle style
      let subtitleStyle: { sizePct: number; position: 'bottom' | 'middle' | 'top' } = { sizePct: 4, position: 'bottom' };
      try {
        const raw = localStorage.getItem(`subtitle-style-${id}`);
        if (raw) subtitleStyle = { ...subtitleStyle, ...JSON.parse(raw) };
      } catch { /* ignore corrupted entry */ }
      set({ currentProject: project, isLoading: false, activeSegmentId: null, videoClips: project.video_clips || [], subtitleStyle });
    } catch (e: any) {
      set({ error: e.message, isLoading: false });
    }
  },

  setSubtitleStyle: (style) => {
    const merged = { ...get().subtitleStyle, ...style };
    set({ subtitleStyle: merged });
    const id = get().currentProject?.id;
    if (id) localStorage.setItem(`subtitle-style-${id}`, JSON.stringify(merged));
  },

  createProject: async (name: string, description = '') => {
    set({ isLoading: true, error: null });
    try {
      const project = await api.createProject(name, description);
      await get().loadProjects();
      set({ isLoading: false });
      return project;
    } catch (e: any) {
      set({ error: e.message, isLoading: false });
      throw e;
    }
  },

  deleteProject: async (id: string) => {
    try {
      await api.deleteProject(id);
      const current = get().currentProject;
      if (current?.id === id) {
        set({ currentProject: null });
      }
      await get().loadProjects();
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  uploadVideo: async (file: File) => {
    const project = get().currentProject;
    if (!project) return;
    set({ uploadProgress: 0, error: null });
    try {
      const updated = await api.uploadVideo(project.id, file, (pct) => {
        set({ uploadProgress: pct });
      });
      set({ currentProject: updated, uploadProgress: 100 });
    } catch (e: any) {
      set({ error: e.message, uploadProgress: 0 });
    }
  },

  generateTranscript: () => {
    const project = get().currentProject;
    if (!project) return;
    set({ isTranscribing: true, error: null, transcribeProgress: 'Uploading video to AI...' });

    // Clear existing segments in state
    set({
      currentProject: { ...project, segments: [], status: 'transcribing' },
    });

    _transcribeAbort = api.generateTranscriptStream(
      project.id,
      project.language,
      // onSegment: add each segment as it arrives
      (segment) => {
        const curr = get().currentProject;
        if (!curr) return;
        const updated = [...curr.segments, segment].sort(
          (a, b) => a.start_time - b.start_time
        );
        set({
          currentProject: { ...curr, segments: updated },
          transcribeProgress: `Transcribing... ${updated.length} segments`,
        });
      },
      // onDone
      (total) => {
        const curr = get().currentProject;
        if (curr) {
          set({
            currentProject: { ...curr, status: 'completed' },
            isTranscribing: false,
            transcribeProgress: '',
          });
        }
        _transcribeAbort = null;
      },
      // onError
      (errMsg) => {
        set({ error: errMsg, isTranscribing: false, transcribeProgress: '' });
        _transcribeAbort = null;
      },
      // onProgress
      (message) => {
        set({ transcribeProgress: message });
      },
    );
  },

  cancelTranscription: () => {
    if (_transcribeAbort) {
      _transcribeAbort.abort();
      _transcribeAbort = null;
    }
    set({ isTranscribing: false, transcribeProgress: '' });
  },

  updateSegment: async (segmentId: string, updates: Partial<Segment>) => {
    const project = get().currentProject;
    if (!project) return;
    try {
      const updated = await api.updateSegment(project.id, segmentId, updates);
      set({
        currentProject: {
          ...project,
          segments: project.segments.map((s) =>
            s.id === segmentId ? updated : s
          ),
        },
      });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  deleteSegment: async (segmentId: string) => {
    const project = get().currentProject;
    if (!project) return;
    try {
      await api.deleteSegment(project.id, segmentId);
      set({
        currentProject: {
          ...project,
          segments: project.segments.filter((s) => s.id !== segmentId),
        },
      });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  addSegment: async (segment: Partial<Segment>) => {
    const project = get().currentProject;
    if (!project) return;
    try {
      const created = await api.addSegment(project.id, segment);
      set({
        currentProject: {
          ...project,
          segments: [...project.segments, created].sort(
            (a, b) => a.start_time - b.start_time
          ),
        },
      });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  bulkSetVoice: async (voice: string, segmentIds?: string[]) => {
    const project = get().currentProject;
    if (!project) return;
    try {
      const updated = await api.bulkUpdateVoice(project.id, voice, segmentIds);
      const updatedMap = new Map(updated.map((s) => [s.id, s]));
      set({
        currentProject: {
          ...project,
          segments: project.segments.map((s) =>
            updatedMap.has(s.id) ? updatedMap.get(s.id)! : s
          ),
        },
      });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  generateVoiceForSegments: async (segmentIds?: string[], speed: number = 1.0) => {
    const project = get().currentProject;
    if (!project) return;

    set({ isGeneratingAudio: true, audioGenProgress: 0, audioGenTotal: 0, error: null });

    try {
      const resp = await fetch(`/api/projects/${project.id}/export/generate-voice-segments-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segment_ids: segmentIds || null, speed }),
      });

      if (!resp.ok) throw new Error('Failed to generate voice audio');

      const reader = resp.body?.getReader();
      if (!reader) throw new Error('No stream');

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
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'start') {
              set({ audioGenTotal: evt.total });
            } else if (evt.type === 'progress') {
              set({ audioGenProgress: evt.completed, audioGenTotal: evt.total });
              // Update segment audio_url in store
              if (evt.status === 'done' && evt.audio_url) {
                const cur = get().currentProject;
                if (cur) {
                  set({
                    currentProject: {
                      ...cur,
                      segments: cur.segments.map((s) =>
                        s.id === evt.segment_id
                          ? {
                              ...s,
                              audio_url: evt.audio_url,
                              ...(evt.end_time != null ? { end_time: evt.end_time } : {}),
                            }
                          : s
                      ),
                    },
                  });
                }
              }
            } else if (evt.type === 'error') {
              throw new Error(evt.message);
            }
          } catch (parseErr: any) {
            if (parseErr.message && !parseErr.message.includes('JSON')) throw parseErr;
          }
        }
      }
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    } finally {
      set({ isGeneratingAudio: false });
    }
  },

  setActiveSegment: (id) => set({ activeSegmentId: id }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setVideoClips: (clips) => set({ videoClips: clips }),
  setSelectedSegmentIds: (ids) => set({ selectedSegmentIds: ids }),

  retranscribeSelected: async (segmentIds: string[]) => {
    const project = get().currentProject;
    if (!project || segmentIds.length === 0) return;
    set({ isTranscribing: true, transcribeProgress: 'Re-transcribing selected segments...' });
    try {
      // Backend now returns ALL segments (not just new ones)
      const allSegments = await api.retranscribeSelected(project.id, segmentIds);
      set({
        currentProject: { ...project, segments: allSegments },
        isTranscribing: false,
        transcribeProgress: '',
        selectedSegmentIds: new Set<string>(),
      });
    } catch (e: any) {
      // On error, re-fetch to ensure frontend is in sync with DB
      try {
        const refreshed = await api.fetchProject(project.id);
        set({ currentProject: refreshed });
      } catch { /* ignore refresh failure */ }
      set({ error: e.message, isTranscribing: false, transcribeProgress: '' });
    }
  },

  setVideoMuted: (muted) => set({ videoMuted: muted }),
  clearError: () => set({ error: null }),
};});
