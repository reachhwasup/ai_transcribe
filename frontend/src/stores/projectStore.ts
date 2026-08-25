import { create } from 'zustand';
import type { Project, ProjectListItem, Segment, VideoClip } from '../types';
import type { SubtitleStyle } from '../types/subtitleStyle';
import { DEFAULT_SUBTITLE_STYLE } from '../types/subtitleStyle';
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
  transcribePercent: number;
  transcribeChunkInfo: { current: number; total: number } | null;
  isGeneratingAudio: boolean;
  audioGenProgress: number;
  audioGenTotal: number;
  activeGeneratingSegmentId: string | null;
  selectedSegmentIds: Set<string>;
  videoMuted: boolean;
  uploadProgress: number;
  error: string | null;
  subtitleStyle: SubtitleStyle;
  subtitlesVisible: boolean;
  videoVisible: boolean;
  hiddenTracks: Set<string>;
  aspectRatio: string;
  canvasZoom: string;
  audioSeparated: boolean;
  vocalsUrl: string | null;
  bgmUrl: string | null;

  // Actions
  setAudioSeparated: (separated: boolean, vocalsUrl?: string | null, bgmUrl?: string | null) => void;
  checkAudioSeparation: (id?: string) => Promise<void>;
  setAspectRatio: (aspectRatio: string) => void;
  setCanvasZoom: (canvasZoom: string) => void;
  setSubtitleStyle: (style: Partial<SubtitleStyle>) => void;
  setSubtitlesVisible: (visible: boolean) => void;
  toggleSubtitlesVisible: () => void;
  setVideoVisible: (visible: boolean) => void;
  toggleVideoVisible: () => void;
  toggleTrackVisibility: (trackId: string) => void;
  loadProjects: () => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  createProject: (name: string, description?: string, language?: string) => Promise<Project>;
  updateProjectName: (name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  uploadVideo: (file: File) => Promise<void>;
  generateTranscript: (language?: string) => void;
  cancelTranscription: () => void;
  updateSegment: (segmentId: string, updates: Partial<Segment>) => Promise<void>;
  deleteSegment: (segmentId: string) => Promise<void>;
  deleteMultipleSegments: (segmentIds: string[]) => Promise<void>;
  deleteAllSegments: () => Promise<void>;
  rechunkSegments: (wordsPerSegment: number) => Promise<void>;
  addSegment: (segment: Partial<Segment>) => Promise<void>;
  bulkSetVoice: (voice: string, segmentIds?: string[]) => Promise<void>;
  generateVoiceForSegments: (
    segmentIds?: string[],
    speed?: number,
    fitMode?: string,
    voiceName?: string,
    emotion?: string
  ) => Promise<void>;
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
  transcribePercent: 0,
  transcribeChunkInfo: null,
  isGeneratingAudio: false,
  audioGenProgress: 0,
  audioGenTotal: 0,
  activeGeneratingSegmentId: null,
  selectedSegmentIds: new Set<string>(),
  videoMuted: false,
  uploadProgress: 0,
  subtitleStyle: DEFAULT_SUBTITLE_STYLE,
  subtitlesVisible: true,
  videoVisible: true,
  hiddenTracks: new Set<string>(),
  aspectRatio: '16:9',
  canvasZoom: 'fit',
  audioSeparated: false,
  vocalsUrl: null,
  bgmUrl: null,
  error: null,

  setAudioSeparated: (audioSeparated, vocalsUrl = null, bgmUrl = null) => {
    set({ audioSeparated, vocalsUrl, bgmUrl });
  },

  checkAudioSeparation: async (projectId) => {
    const id = projectId || get().currentProject?.id;
    if (!id) return;
    try {
      const status = await api.checkAudioSeparation(id);
      if (status.separated && status.vocals_url && status.bgm_url) {
        set({ audioSeparated: true, vocalsUrl: status.vocals_url, bgmUrl: status.bgm_url });
      } else {
        set({ audioSeparated: false, vocalsUrl: null, bgmUrl: null });
      }
    } catch {
      // ignore
    }
  },

  setAspectRatio: (aspectRatio: string) => set({ aspectRatio }),
  setCanvasZoom: (canvasZoom: string) => set({ canvasZoom }),
  setSubtitlesVisible: (subtitlesVisible: boolean) => set({ subtitlesVisible }),
  toggleSubtitlesVisible: () => set((state) => {
    const next = !state.subtitlesVisible;
    const hidden = new Set(state.hiddenTracks);
    if (!next) {
      hidden.add('T');
      hidden.add('T1');
    } else {
      hidden.delete('T');
      hidden.delete('T1');
    }
    return { subtitlesVisible: next, hiddenTracks: hidden };
  }),
  setVideoVisible: (videoVisible: boolean) => set({ videoVisible }),
  toggleVideoVisible: () => set((state) => {
    const next = !state.videoVisible;
    const hidden = new Set(state.hiddenTracks);
    if (!next) {
      hidden.add('V');
      hidden.add('V1');
    } else {
      hidden.delete('V');
      hidden.delete('V1');
    }
    return { videoVisible: next, hiddenTracks: hidden };
  }),
  toggleTrackVisibility: (trackId: string) => {
    const hidden = new Set(get().hiddenTracks);
    if (hidden.has(trackId)) {
      hidden.delete(trackId);
    } else {
      hidden.add(trackId);
    }
    const updates: Partial<ProjectStore> = { hiddenTracks: hidden };
    if (trackId === 'V' || trackId === 'V1') {
      updates.videoVisible = !hidden.has(trackId);
    }
    if (trackId === 'T' || trackId === 'T1') {
      updates.subtitlesVisible = !hidden.has(trackId);
    }
    set(updates);
  },

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
    const isCached = get().currentProject?.id === id;
    if (!isCached) {
      set({ isLoading: true, error: null });
    }
    try {
      const [project, sep] = await Promise.all([
        api.fetchProject(id),
        api.checkAudioSeparation(id).catch(() => ({ separated: false, vocals_url: null, bgm_url: null })),
      ]);

      // Restore this project's saved subtitle style
      let subtitleStyle: SubtitleStyle = { ...DEFAULT_SUBTITLE_STYLE };
      try {
        const raw = localStorage.getItem(`subtitle-style-${id}`);
        if (raw) subtitleStyle = { ...subtitleStyle, ...JSON.parse(raw) };
      } catch { /* ignore corrupted entry */ }

      const audioSeparated = !!(sep?.separated && sep?.vocals_url && sep?.bgm_url);
      const vocalsUrl = audioSeparated ? sep.vocals_url : null;
      const bgmUrl = audioSeparated ? sep.bgm_url : null;

      set({
        currentProject: project,
        isLoading: false,
        videoClips: project.video_clips || [],
        subtitleStyle,
        audioSeparated,
        vocalsUrl,
        bgmUrl,
      });
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

  createProject: async (name: string, description = '', language = 'km') => {
    set({ isLoading: true, error: null });
    try {
      const project = await api.createProject(name, description, language);
      await get().loadProjects();
      set({ isLoading: false });
      return project;
    } catch (e: any) {
      set({ error: e.message, isLoading: false });
      throw e;
    }
  },

  updateProjectName: async (name: string) => {
    const { currentProject } = get();
    if (!currentProject) return;
    try {
      const updated = await api.updateProject(currentProject.id, { name });
      set((state) => ({
        currentProject: state.currentProject ? { ...state.currentProject, name: updated.name } : null,
        projects: state.projects.map((p) => (p.id === currentProject.id ? { ...p, name: updated.name } : p)),
      }));
    } catch (e: any) {
      console.error('Failed to update project name:', e);
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

  generateTranscript: (language?: string) => {
    const project = get().currentProject;
    if (!project) return;
    const targetLang = language || project.language || 'km';
    set({
      isTranscribing: true,
      error: null,
      transcribeProgress: 'Initializing AI Speech Recognition...',
      transcribePercent: 5,
      transcribeChunkInfo: null,
    });

    // Clear existing segments in state
    set({
      currentProject: { ...project, segments: [], status: 'transcribing' },
    });

    _transcribeAbort = api.generateTranscriptStream(
      project.id,
      targetLang,
      // onSegment: add each segment as it arrives
      (segment) => {
        const curr = get().currentProject;
        if (!curr) return;
        const updated = [...curr.segments, segment].sort(
          (a, b) => a.start_time - b.start_time
        );
        set({
          currentProject: { ...curr, segments: updated },
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
            transcribePercent: 100,
            transcribeChunkInfo: null,
          });
        }
        _transcribeAbort = null;
      },
      // onError
      (errMsg) => {
        set({
          error: errMsg,
          isTranscribing: false,
          transcribeProgress: '',
          transcribePercent: 0,
          transcribeChunkInfo: null,
        });
        _transcribeAbort = null;
      },
      // onProgress
      (prog) => {
        set({
          transcribeProgress: prog.message || '',
          transcribePercent: prog.percent || (prog.currentChunk && prog.totalChunks ? Math.round((prog.currentChunk / prog.totalChunks) * 100) : 10),
          transcribeChunkInfo: prog.totalChunks > 0 ? { current: prog.currentChunk, total: prog.totalChunks } : null,
        });
      },
    );
  },

  cancelTranscription: () => {
    if (_transcribeAbort) {
      _transcribeAbort.abort();
      _transcribeAbort = null;
    }
    set({ isTranscribing: false, transcribeProgress: '', transcribePercent: 0, transcribeChunkInfo: null });
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
        selectedSegmentIds: new Set([...get().selectedSegmentIds].filter(id => id !== segmentId)),
        activeSegmentId: get().activeSegmentId === segmentId ? null : get().activeSegmentId,
      });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  deleteMultipleSegments: async (segmentIds: string[]) => {
    const project = get().currentProject;
    if (!project || segmentIds.length === 0) return;
    try {
      await Promise.all(segmentIds.map(id => api.deleteSegment(project.id, id)));
      const idsSet = new Set(segmentIds);
      set({
        currentProject: {
          ...project,
          segments: project.segments.filter((s) => !idsSet.has(s.id)),
        },
        selectedSegmentIds: new Set([...get().selectedSegmentIds].filter(id => !idsSet.has(id))),
        activeSegmentId: idsSet.has(get().activeSegmentId || '') ? null : get().activeSegmentId,
      });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  deleteAllSegments: async () => {
    const project = get().currentProject;
    if (!project) return;
    try {
      await api.deleteAllSegments(project.id);
      set({
        currentProject: {
          ...project,
          segments: [],
        },
        selectedSegmentIds: new Set<string>(),
        activeSegmentId: null,
      });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  rechunkSegments: async (wordsPerSegment: number) => {
    const project = get().currentProject;
    if (!project) return;
    try {
      const newSegments = await api.rechunkSegments(project.id, wordsPerSegment);
      set({
        currentProject: {
          ...project,
          segments: newSegments,
        },
        selectedSegmentIds: new Set<string>(),
        activeSegmentId: null,
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

  generateVoiceForSegments: async (
    segmentIds?: string[],
    speed: number = 1.0,
    fitMode: string = 'A',
    voiceName?: string,
    emotion?: string
  ) => {
    const project = get().currentProject;
    if (!project) return;

    set({ isGeneratingAudio: true, audioGenProgress: 0, audioGenTotal: 0, activeGeneratingSegmentId: null, error: null });

    try {
      const resp = await fetch(`/api/projects/${project.id}/export/generate-voice-segments-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segment_ids: segmentIds || null,
          speed,
          fit_mode: fitMode,
          voice_name: voiceName || null,
          emotion: emotion || null,
        }),
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
              set({ audioGenTotal: evt.total, audioGenProgress: 0 });
            } else if (evt.type === 'segment_start') {
              set({ activeGeneratingSegmentId: evt.segment_id });
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
                              ...(evt.start_time != null ? { start_time: evt.start_time } : {}),
                              ...(evt.end_time != null ? { end_time: evt.end_time } : {}),
                            }
                          : s
                      ),
                    },
                  });
                }
              }
            } else if (evt.type === 'done') {
              set({ activeGeneratingSegmentId: null, isGeneratingAudio: false });
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
      set({ isGeneratingAudio: false, activeGeneratingSegmentId: null });
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
