import { create } from 'zustand';
import type { Project, ProjectListItem, Segment, VideoClip } from '../types';
import type { SubtitleStyle } from '../types/subtitleStyle';
import { DEFAULT_SUBTITLE_STYLE } from '../types/subtitleStyle';
import * as api from '../api/client';

interface CachedProjectState {
  project: Project;
  videoClips: VideoClip[];
  audioSeparated: boolean;
  vocalsUrl: string | null;
  bgmUrl: string | null;
  subtitleStyle: SubtitleStyle;
  aspectRatio: string;
}

// In-memory global caches so switching projects is instantaneous and background tasks never stop
const _projectCache = new Map<string, CachedProjectState>();
const _transcribeAbortMap = new Map<string, AbortController>();
const _transcribeStatusMap = new Map<
  string,
  { progress: string; percent: number; chunkInfo: { current: number; total: number } | null }
>();
const _voiceGenStatusMap = new Map<
  string,
  { progress: number; total: number; activeSegmentId: string | null }
>();

interface ProjectStore {
  // State
  projects: ProjectListItem[];
  currentProject: Project | null;
  activeSegmentId: string | null;
  currentTime: number;
  isPlaying: boolean;
  isLoading: boolean;
  videoClips: VideoClip[];
  transcribingProjectId: string | null;
  generatingVoiceProjectId: string | null;
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
  removeVideo: () => Promise<void>;
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
    emotion?: string,
    skipExisting?: boolean
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
  return {
    projects: [],
    currentProject: null,
    activeSegmentId: null,
    currentTime: 0,
    isPlaying: false,
    isLoading: false,
    videoClips: [],
    transcribingProjectId: null,
    generatingVoiceProjectId: null,
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
      const cur = get().currentProject;
      if (cur) {
        const cached = _projectCache.get(cur.id);
        if (cached) {
          _projectCache.set(cur.id, { ...cached, audioSeparated, vocalsUrl, bgmUrl });
        }
      }
      set({ audioSeparated, vocalsUrl, bgmUrl });
    },

    checkAudioSeparation: async (projectId) => {
      const id = projectId || get().currentProject?.id;
      if (!id) return;
      try {
        const res = await api.checkAudioSeparation(id);
        const cached = _projectCache.get(id);
        const vocalsUrl = res.vocals_url ?? null;
        const bgmUrl = res.bgm_url ?? null;
        if (cached) {
          _projectCache.set(id, {
            ...cached,
            audioSeparated: res.separated,
            vocalsUrl,
            bgmUrl,
          });
        }
        if (get().currentProject?.id === id) {
          set({
            audioSeparated: res.separated,
            vocalsUrl,
            bgmUrl,
          });
        }
      } catch {
        // ignore
      }
    },

    setAspectRatio: (aspectRatio: string) => {
      set({ aspectRatio });
      const cur = get().currentProject;
      if (cur) {
        localStorage.setItem(`aspect-ratio-${cur.id}`, aspectRatio);
        localStorage.setItem('meatika-user-aspect-ratio', aspectRatio);
        const cached = _projectCache.get(cur.id);
        if (cached) {
          _projectCache.set(cur.id, { ...cached, aspectRatio });
        }
      } else {
        localStorage.setItem('meatika-user-aspect-ratio', aspectRatio);
      }
    },
    setCanvasZoom: (canvasZoom: string) => {
      set({ canvasZoom });
    },
    setSubtitlesVisible: (subtitlesVisible: boolean) => {
      set({ subtitlesVisible });
    },
    toggleSubtitlesVisible: () => {
      set((state) => ({ subtitlesVisible: !state.subtitlesVisible }));
    },
    setVideoVisible: (videoVisible: boolean) => {
      set({ videoVisible });
    },
    toggleVideoVisible: () => {
      set((state) => ({ videoVisible: !state.videoVisible }));
    },
    toggleTrackVisibility: (trackId: string) => {
      set((state) => {
        const next = new Set(state.hiddenTracks);
        if (next.has(trackId)) {
          next.delete(trackId);
        } else {
          next.add(trackId);
        }
        return { hiddenTracks: next };
      });
    },

    loadProjects: async () => {
      try {
        const projects = await api.fetchProjects();
        set({ projects });
      } catch (e: any) {
        set({ error: e.message });
      }
    },

    loadProject: async (id: string) => {
      const isAlreadyOnThis = get().currentProject?.id === id;
      const cached = _projectCache.get(id);
      const savedRatio = localStorage.getItem(`aspect-ratio-${id}`) || cached?.aspectRatio || localStorage.getItem('meatika-user-aspect-ratio') || '16:9';

      // Check ongoing background job status for this project
      const hasOngoingTranscribe = _transcribeAbortMap.has(id);
      const transcribeStatus = _transcribeStatusMap.get(id);
      const hasOngoingVoiceGen = _voiceGenStatusMap.has(id);
      const voiceGenStatus = _voiceGenStatusMap.get(id);

      if (cached) {
        // Instant 0ms transition from memory cache (NO loading spinner!)
        set({
          currentProject: cached.project,
          videoClips: cached.videoClips,
          subtitleStyle: cached.subtitleStyle,
          audioSeparated: cached.audioSeparated,
          vocalsUrl: cached.vocalsUrl,
          bgmUrl: cached.bgmUrl,
          aspectRatio: cached.aspectRatio || savedRatio,
          isLoading: false,
          error: null,
          transcribingProjectId: hasOngoingTranscribe ? id : null,
          isTranscribing: hasOngoingTranscribe,
          transcribeProgress: transcribeStatus?.progress || '',
          transcribePercent: transcribeStatus?.percent || 0,
          transcribeChunkInfo: transcribeStatus?.chunkInfo || null,
          generatingVoiceProjectId: hasOngoingVoiceGen ? id : null,
          isGeneratingAudio: hasOngoingVoiceGen,
          audioGenProgress: voiceGenStatus?.progress || 0,
          audioGenTotal: voiceGenStatus?.total || 0,
          activeGeneratingSegmentId: voiceGenStatus?.activeSegmentId || null,
          ...(isAlreadyOnThis ? {} : { activeSegmentId: null, currentTime: 0, isPlaying: false, selectedSegmentIds: new Set() }),
        });
      } else {
        // Cold start for first load
        set({
          isLoading: true,
          error: null,
          aspectRatio: savedRatio,
          audioSeparated: false,
          vocalsUrl: null,
          bgmUrl: null,
          ...(isAlreadyOnThis ? {} : { currentProject: null, videoClips: [], activeSegmentId: null, currentTime: 0, isPlaying: false, selectedSegmentIds: new Set() }),
          isTranscribing: hasOngoingTranscribe,
          transcribingProjectId: hasOngoingTranscribe ? id : null,
          isGeneratingAudio: hasOngoingVoiceGen,
          generatingVoiceProjectId: hasOngoingVoiceGen ? id : null,
        });
      }

      // Fetch fresh data in the background and silently update
      try {
        const [project, clips, sep] = await Promise.all([
          api.fetchProject(id),
          api.getVideoClips(id).catch(() => []),
          api.checkAudioSeparation(id).catch(() => ({ separated: false, vocals_url: null, bgm_url: null })),
        ]);

        let subtitleStyle: SubtitleStyle = { ...DEFAULT_SUBTITLE_STYLE };
        try {
          const raw = localStorage.getItem(`subtitle-style-${id}`);
          if (raw) subtitleStyle = { ...subtitleStyle, ...JSON.parse(raw) };
        } catch { /* ignore */ }

        const audioSeparated = !!(sep?.separated && sep?.vocals_url && sep?.bgm_url);
        const vocalsUrl = (audioSeparated ? sep.vocals_url : null) ?? null;
        const bgmUrl = (audioSeparated ? sep.bgm_url : null) ?? null;
        const effectiveClips = clips && clips.length > 0 ? clips : (project.video_clips || []);

        const updatedState: CachedProjectState = {
          project,
          videoClips: effectiveClips,
          subtitleStyle,
          audioSeparated,
          vocalsUrl,
          bgmUrl,
          aspectRatio: savedRatio,
        };

        // Cache for instant zero-latency future switches
        _projectCache.set(id, updatedState);

        // Only update UI if user is currently viewing this project
        if (get().currentProject?.id === id || !get().currentProject) {
          const activeTrans = _transcribeAbortMap.has(id);
          const activeVoice = _voiceGenStatusMap.has(id);
          set({
            currentProject: project,
            isLoading: false,
            videoClips: effectiveClips,
            subtitleStyle,
            audioSeparated,
            vocalsUrl,
            bgmUrl,
            aspectRatio: savedRatio,
            isTranscribing: activeTrans,
            transcribingProjectId: activeTrans ? id : null,
            isGeneratingAudio: activeVoice,
            generatingVoiceProjectId: activeVoice ? id : null,
          });
        }
      } catch (e: any) {
        if (!cached) {
          set({ error: e.message, isLoading: false });
        }
      }
    },

    setSubtitleStyle: (style) => {
      const merged = { ...get().subtitleStyle, ...style };
      const cur = get().currentProject;
      if (cur) {
        const cached = _projectCache.get(cur.id);
        if (cached) _projectCache.set(cur.id, { ...cached, subtitleStyle: merged });
        localStorage.setItem(`subtitle-style-${cur.id}`, JSON.stringify(merged));
      }
      set({ subtitleStyle: merged });
    },

    createProject: async (name: string, description = '', language = 'km') => {
      set({ isLoading: true, error: null });
      try {
        const project = await api.createProject(name, description, language);
        const initialRatio = localStorage.getItem('meatika-user-aspect-ratio') || '16:9';
        _projectCache.set(project.id, {
          project,
          videoClips: project.video_clips || [],
          subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
          audioSeparated: false,
          vocalsUrl: null,
          bgmUrl: null,
          aspectRatio: initialRatio,
        });
        await get().loadProjects();
        set({ isLoading: false, aspectRatio: initialRatio });
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
        const cached = _projectCache.get(currentProject.id);
        if (cached) _projectCache.set(currentProject.id, { ...cached, project: updated });
        set({ currentProject: updated });
        await get().loadProjects();
      } catch (e: any) {
        set({ error: e.message });
      }
    },

    deleteProject: async (id: string) => {
      try {
        await api.deleteProject(id);
        _projectCache.delete(id);
        _transcribeAbortMap.get(id)?.abort();
        _transcribeAbortMap.delete(id);
        _transcribeStatusMap.delete(id);
        _voiceGenStatusMap.delete(id);
        set((state) => ({
          projects: state.projects.filter((p) => p.id !== id),
          currentProject: state.currentProject?.id === id ? null : state.currentProject,
        }));
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
        const cached = _projectCache.get(project.id);
        if (cached) {
          _projectCache.set(project.id, {
            ...cached,
            project: updated,
            videoClips: updated.video_clips || [],
          });
        }
        set({ currentProject: updated, uploadProgress: 100, videoClips: updated.video_clips || [] });
      } catch (e: any) {
        set({ error: e.message, uploadProgress: 0 });
      }
    },

    removeVideo: async () => {
      const project = get().currentProject;
      if (!project) return;
      try {
        const updated = await api.removeProjectVideo(project.id);
        const cached = _projectCache.get(project.id);
        if (cached) {
          _projectCache.set(project.id, {
            ...cached,
            project: updated,
            videoClips: [],
          });
        }
        set({
          currentProject: updated,
          videoClips: [],
          currentTime: 0,
          isPlaying: false,
        });
      } catch (e: any) {
        set({ error: e.message });
      }
    },

    generateTranscript: (language?: string) => {
      const project = get().currentProject;
      if (!project) return;
      const targetProjectId = project.id;
      const targetLang = language || project.language || 'km';

      // Cancel any prior transcription for this project
      _transcribeAbortMap.get(targetProjectId)?.abort();

      const initialStatus = {
        progress: 'Initializing AI Speech Recognition...',
        percent: 5,
        chunkInfo: null,
      };
      _transcribeStatusMap.set(targetProjectId, initialStatus);

      set({
        transcribingProjectId: targetProjectId,
        isTranscribing: true,
        error: null,
        transcribeProgress: initialStatus.progress,
        transcribePercent: initialStatus.percent,
        transcribeChunkInfo: null,
      });

      // Clear existing segments in cached project
      const cached = _projectCache.get(targetProjectId);
      if (cached) {
        _projectCache.set(targetProjectId, {
          ...cached,
          project: { ...cached.project, segments: [], status: 'transcribing' },
        });
      }
      if (get().currentProject?.id === targetProjectId) {
        set({
          currentProject: { ...project, segments: [], status: 'transcribing' },
        });
      }

      const abortCtrl = api.generateTranscriptStream(
        targetProjectId,
        targetLang,
        // onSegment: append segment both to cache and active UI
        (segment) => {
          const c = _projectCache.get(targetProjectId);
          if (c) {
            const updated = [...c.project.segments, segment].sort((a, b) => a.start_time - b.start_time);
            _projectCache.set(targetProjectId, {
              ...c,
              project: { ...c.project, segments: updated },
            });
          }
          if (get().currentProject?.id === targetProjectId) {
            const cur = get().currentProject!;
            const updated = [...cur.segments, segment].sort((a, b) => a.start_time - b.start_time);
            set({ currentProject: { ...cur, segments: updated } });
          }
        },
        // onDone
        () => {
          _transcribeAbortMap.delete(targetProjectId);
          _transcribeStatusMap.delete(targetProjectId);
          const c = _projectCache.get(targetProjectId);
          if (c) {
            _projectCache.set(targetProjectId, {
              ...c,
              project: { ...c.project, status: 'completed' },
            });
          }
          if (get().currentProject?.id === targetProjectId) {
            set({
              transcribingProjectId: null,
              currentProject: { ...get().currentProject!, status: 'completed' },
              isTranscribing: false,
              transcribeProgress: '',
              transcribePercent: 100,
              transcribeChunkInfo: null,
            });
          }
        },
        // onError
        (errMsg) => {
          _transcribeAbortMap.delete(targetProjectId);
          _transcribeStatusMap.delete(targetProjectId);
          if (get().currentProject?.id === targetProjectId) {
            set({
              transcribingProjectId: null,
              error: errMsg,
              isTranscribing: false,
              transcribeProgress: '',
              transcribePercent: 0,
              transcribeChunkInfo: null,
            });
          }
        },
        // onProgress
        (prog) => {
          const newStatus = {
            progress: prog.message || '',
            percent: prog.percent || (prog.currentChunk && prog.totalChunks ? Math.round((prog.currentChunk / prog.totalChunks) * 100) : 10),
            chunkInfo: prog.totalChunks > 0 ? { current: prog.currentChunk, total: prog.totalChunks } : null,
          };
          _transcribeStatusMap.set(targetProjectId, newStatus);
          if (get().currentProject?.id === targetProjectId) {
            set({
              isTranscribing: true,
              transcribeProgress: newStatus.progress,
              transcribePercent: newStatus.percent,
              transcribeChunkInfo: newStatus.chunkInfo,
            });
          }
        }
      );

      _transcribeAbortMap.set(targetProjectId, abortCtrl);
    },

    cancelTranscription: () => {
      const cur = get().currentProject;
      if (cur) {
        _transcribeAbortMap.get(cur.id)?.abort();
        _transcribeAbortMap.delete(cur.id);
        _transcribeStatusMap.delete(cur.id);
      }
      set({
        transcribingProjectId: null,
        isTranscribing: false,
        transcribeProgress: '',
        transcribePercent: 0,
        transcribeChunkInfo: null,
      });
    },

    updateSegment: async (segmentId: string, updates: Partial<Segment>) => {
      const project = get().currentProject;
      if (!project) return;
      const prevSegments = project.segments;
      const updatedList = project.segments.map((s) => (s.id === segmentId ? { ...s, ...updates } : s));

      const cached = _projectCache.get(project.id);
      if (cached) {
        _projectCache.set(project.id, {
          ...cached,
          project: { ...cached.project, segments: updatedList },
        });
      }
      set({
        currentProject: {
          ...project,
          segments: updatedList,
        },
      });

      try {
        const updated = await api.updateSegment(project.id, segmentId, updates);
        const cur = get().currentProject;
        if (cur && cur.id === project.id) {
          const finalList = cur.segments.map((s) => (s.id === segmentId ? updated : s));
          const c = _projectCache.get(cur.id);
          if (c) _projectCache.set(cur.id, { ...c, project: { ...c.project, segments: finalList } });
          set({ currentProject: { ...cur, segments: finalList } });
        }
      } catch (e: any) {
        // Rollback on failure
        const cur = get().currentProject;
        if (cur && cur.id === project.id) {
          set({ currentProject: { ...cur, segments: prevSegments }, error: e.message });
        }
      }
    },

    deleteSegment: async (segmentId: string) => {
      const project = get().currentProject;
      if (!project) return;
      const prevSegments = project.segments;
      const updatedList = project.segments.filter((s) => s.id !== segmentId);

      const cached = _projectCache.get(project.id);
      if (cached) {
        _projectCache.set(project.id, {
          ...cached,
          project: { ...cached.project, segments: updatedList },
        });
      }
      set({
        currentProject: {
          ...project,
          segments: updatedList,
        },
        selectedSegmentIds: new Set([...get().selectedSegmentIds].filter((id) => id !== segmentId)),
        activeSegmentId: get().activeSegmentId === segmentId ? null : get().activeSegmentId,
      });

      try {
        await api.deleteSegment(project.id, segmentId);
      } catch (e: any) {
        const cur = get().currentProject;
        if (cur && cur.id === project.id) {
          set({ currentProject: { ...cur, segments: prevSegments }, error: e.message });
        }
      }
    },

    deleteMultipleSegments: async (segmentIds: string[]) => {
      const project = get().currentProject;
      if (!project || segmentIds.length === 0) return;
      const prevSegments = project.segments;
      const idsSet = new Set(segmentIds);
      const updatedList = project.segments.filter((s) => !idsSet.has(s.id));

      const cached = _projectCache.get(project.id);
      if (cached) {
        _projectCache.set(project.id, {
          ...cached,
          project: { ...cached.project, segments: updatedList },
        });
      }
      set({
        currentProject: {
          ...project,
          segments: updatedList,
        },
        selectedSegmentIds: new Set([...get().selectedSegmentIds].filter((id) => !idsSet.has(id))),
        activeSegmentId: idsSet.has(get().activeSegmentId || '') ? null : get().activeSegmentId,
      });

      try {
        await Promise.all(segmentIds.map((id) => api.deleteSegment(project.id, id)));
      } catch (e: any) {
        const cur = get().currentProject;
        if (cur && cur.id === project.id) {
          set({ currentProject: { ...cur, segments: prevSegments }, error: e.message });
        }
      }
    },

    deleteAllSegments: async () => {
      const project = get().currentProject;
      if (!project) return;
      const cached = _projectCache.get(project.id);
      if (cached) {
        _projectCache.set(project.id, {
          ...cached,
          project: { ...cached.project, segments: [] },
        });
      }
      set({
        currentProject: { ...project, segments: [] },
        selectedSegmentIds: new Set<string>(),
        activeSegmentId: null,
      });
      try {
        await api.deleteAllSegments(project.id);
      } catch (e: any) {
        set({ error: e.message });
      }
    },

    rechunkSegments: async (wordsPerSegment: number) => {
      const project = get().currentProject;
      if (!project) return;
      try {
        const newSegments = await api.rechunkSegments(project.id, wordsPerSegment);
        const cached = _projectCache.get(project.id);
        if (cached) {
          _projectCache.set(project.id, {
            ...cached,
            project: { ...cached.project, segments: newSegments },
          });
        }
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
        const updatedList = [...project.segments, created].sort((a, b) => a.start_time - b.start_time);
        const cached = _projectCache.get(project.id);
        if (cached) {
          _projectCache.set(project.id, {
            ...cached,
            project: { ...cached.project, segments: updatedList },
          });
        }
        set({
          currentProject: {
            ...project,
            segments: updatedList,
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
        const updatedList = project.segments.map((s) => (updatedMap.has(s.id) ? updatedMap.get(s.id)! : s));
        const cached = _projectCache.get(project.id);
        if (cached) {
          _projectCache.set(project.id, {
            ...cached,
            project: { ...cached.project, segments: updatedList },
          });
        }
        set({
          currentProject: {
            ...project,
            segments: updatedList,
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
      emotion?: string,
      skipExisting: boolean = true
    ) => {
      const project = get().currentProject;
      if (!project) return;
      const targetProjectId = project.id;

      _voiceGenStatusMap.set(targetProjectId, { progress: 0, total: 0, activeSegmentId: null });

      set({
        generatingVoiceProjectId: targetProjectId,
        isGeneratingAudio: true,
        audioGenProgress: 0,
        audioGenTotal: 0,
        activeGeneratingSegmentId: null,
        error: null,
      });

      try {
        const resp = await fetch(`/api/projects/${targetProjectId}/export/generate-voice-segments-stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            segment_ids: segmentIds || null,
            speed,
            fit_mode: fitMode,
            voice_name: voiceName || null,
            emotion: emotion || null,
            skip_existing: skipExisting,
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
              const isCurrent = get().currentProject?.id === targetProjectId;

              if (evt.type === 'start') {
                const curStatus = _voiceGenStatusMap.get(targetProjectId) || { progress: 0, total: 0, activeSegmentId: null };
                _voiceGenStatusMap.set(targetProjectId, { ...curStatus, total: evt.total, progress: 0 });
                if (isCurrent) set({ audioGenTotal: evt.total, audioGenProgress: 0 });
              } else if (evt.type === 'segment_start') {
                const curStatus = _voiceGenStatusMap.get(targetProjectId) || { progress: 0, total: 0, activeSegmentId: null };
                _voiceGenStatusMap.set(targetProjectId, { ...curStatus, activeSegmentId: evt.segment_id });
                if (isCurrent) set({ activeGeneratingSegmentId: evt.segment_id });
              } else if (evt.type === 'progress') {
                const curStatus = _voiceGenStatusMap.get(targetProjectId) || { progress: 0, total: 0, activeSegmentId: null };
                _voiceGenStatusMap.set(targetProjectId, { ...curStatus, progress: evt.completed, total: evt.total });

                if (evt.status === 'done' && evt.audio_url) {
                  // Update segment audio_url in persistent in-memory cache
                  const c = _projectCache.get(targetProjectId);
                  if (c) {
                    const updatedSegs = c.project.segments.map((s) =>
                      s.id === evt.segment_id
                        ? {
                            ...s,
                            audio_url: evt.audio_url,
                            ...(evt.start_time != null ? { start_time: evt.start_time } : {}),
                            ...(evt.end_time != null ? { end_time: evt.end_time } : {}),
                          }
                        : s
                    );
                    _projectCache.set(targetProjectId, {
                      ...c,
                      project: { ...c.project, segments: updatedSegs },
                    });
                  }
                }

                if (isCurrent) {
                  set({ audioGenProgress: evt.completed, audioGenTotal: evt.total });
                  if (evt.status === 'done' && evt.audio_url) {
                    const cur = get().currentProject;
                    if (cur && cur.id === targetProjectId) {
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
                }
              } else if (evt.type === 'done') {
                _voiceGenStatusMap.delete(targetProjectId);
                if (isCurrent) set({ activeGeneratingSegmentId: null, isGeneratingAudio: false });
              } else if (evt.type === 'error') {
                _voiceGenStatusMap.delete(targetProjectId);
                throw new Error(evt.message);
              }
            } catch (parseErr: any) {
              if (parseErr.message && !parseErr.message.includes('JSON')) throw parseErr;
            }
          }
        }
      } catch (e: any) {
        _voiceGenStatusMap.delete(targetProjectId);
        if (get().currentProject?.id === targetProjectId) {
          set({ error: e.message, isGeneratingAudio: false });
        }
        throw e;
      } finally {
        _voiceGenStatusMap.delete(targetProjectId);
        if (get().generatingVoiceProjectId === targetProjectId) {
          set({
            generatingVoiceProjectId: null,
            ...(get().currentProject?.id === targetProjectId ? { isGeneratingAudio: false, activeGeneratingSegmentId: null } : {}),
          });
        }
      }
    },

    setActiveSegment: (id) => set({ activeSegmentId: id }),
    setCurrentTime: (time) => set({ currentTime: time }),
    setIsPlaying: (playing) => set({ isPlaying: playing }),
    setVideoClips: (clips) => {
      const cur = get().currentProject;
      if (cur) {
        const cached = _projectCache.get(cur.id);
        if (cached) _projectCache.set(cur.id, { ...cached, videoClips: clips });
      }
      set({ videoClips: clips });
    },
    setSelectedSegmentIds: (ids) => set({ selectedSegmentIds: ids }),

    retranscribeSelected: async (segmentIds: string[]) => {
      const project = get().currentProject;
      if (!project || segmentIds.length === 0) return;
      set({ isTranscribing: true, transcribeProgress: 'Re-transcribing selected segments...' });
      try {
        const allSegments = await api.retranscribeSelected(project.id, segmentIds);
        const cached = _projectCache.get(project.id);
        if (cached) {
          _projectCache.set(project.id, {
            ...cached,
            project: { ...cached.project, segments: allSegments },
          });
        }
        set({
          currentProject: { ...project, segments: allSegments },
          isTranscribing: false,
          transcribeProgress: '',
          selectedSegmentIds: new Set<string>(),
        });
      } catch (e: any) {
        try {
          const refreshed = await api.fetchProject(project.id);
          const cached = _projectCache.get(project.id);
          if (cached) _projectCache.set(project.id, { ...cached, project: refreshed });
          set({ currentProject: refreshed });
        } catch { /* ignore */ }
        set({ error: e.message, isTranscribing: false, transcribeProgress: '' });
      }
    },

    setVideoMuted: (muted) => set({ videoMuted: muted }),
    clearError: () => set({ error: null }),
  };
});
