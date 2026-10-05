import { create } from 'zustand';
import { toast } from '../utils/toast';
import { nameParts } from '../utils/names';
import type { Project, ProjectListItem, Segment, VideoClip } from '../types';
import type { SubtitleStyle } from '../types/subtitleStyle';
import { DEFAULT_SUBTITLE_STYLE } from '../types/subtitleStyle';
import { saveProjectSetting, PROJECT_SETTINGS_SYNCED } from '../utils/projectSettings';
import * as api from '../api/client';
import { SPLIT_SUGGEST_SECONDS } from '../utils/splitting';
import { closeTab } from '../utils/openTabs';

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
const _voiceGenAbortMap = new Map<string, AbortController>();
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
  /** Project id whose freshly uploaded video is long enough to offer splitting into parts. */
  splitPromptProjectId: string | null;
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
  setSubtitleStyle: (style: Partial<SubtitleStyle>) => void;
  toggleSubtitlesVisible: () => void;
  toggleTrackVisibility: (trackId: string) => void;
  loadProjects: () => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  createProject: (name: string, description?: string, language?: string) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  uploadVideo: (file: File) => Promise<void>;
  setSplitPrompt: (projectId: string | null) => void;
  generateTranscript: (language?: string) => void;
  updateSegment: (segmentId: string, updates: Partial<Segment>) => Promise<void>;
  deleteSegment: (segmentId: string) => Promise<void>;
  deleteMultipleSegments: (segmentIds: string[]) => Promise<void>;
  deleteAllSegments: () => Promise<void>;
  rechunkSegments: (wordsPerSegment: number) => Promise<void>;
  addSegment: (segment: Partial<Segment>) => Promise<void>;
  bulkSetVoice: (voice: string, segmentIds?: string[]) => Promise<void>;
  cancelVoiceGeneration: (projectId?: string) => void;
  generateVoiceForSegments: (
    segmentIds?: string[],
    speed?: number,
    fitMode?: string,
    voiceName?: string,
    emotion?: string,
    skipExisting?: boolean,
    voiceFx?: string
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

/** Episodes share a long series name; the part that tells them apart is what a toast shows */
const shortName = (name: string) => nameParts(name).tail || name;

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
    splitPromptProjectId: null,
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
        saveProjectSetting(cur.id, 'aspect_ratio', aspectRatio);
        const cached = _projectCache.get(cur.id);
        if (cached) {
          _projectCache.set(cur.id, { ...cached, aspectRatio });
        }
      } else {
        localStorage.setItem('meatika-user-aspect-ratio', aspectRatio);
      }
    },
    toggleSubtitlesVisible: () => {
      set((state) => ({ subtitlesVisible: !state.subtitlesVisible }));
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
          // Size used to be a fixed pixel value the export never read; sizePct is the one
          // setting both use now, so drop the stale one.
          delete subtitleStyle.fontSize;
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
        saveProjectSetting(cur.id, 'caption_style', merged);
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

    deleteProject: async (id: string) => {
      try {
        await api.deleteProject(id);
        // A tab left pointing at a deleted project loads a 404, so it goes with it
        closeTab(id);
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
        set({
          currentProject: updated,
          uploadProgress: 100,
          videoClips: updated.video_clips || [],
          // Long uploads are offered a split into part projects; short ones are left alone.
          splitPromptProjectId:
            (updated.duration || 0) >= SPLIT_SUGGEST_SECONDS && !updated.part_index
              ? updated.id
              : null,
        });
      } catch (e: any) {
        set({ error: e.message, uploadProgress: 0 });
      }
    },

    setSplitPrompt: (projectId: string | null) => set({ splitPromptProjectId: projectId }),

    generateTranscript: (language?: string) => {
      const project = get().currentProject;
      if (!project) return;
      const targetProjectId = project.id;
      const targetLang = language || project.language || 'km';

      // Cancel any prior transcription for this project
      _transcribeAbortMap.get(targetProjectId)?.abort();
      toast({ tone: 'working', title: 'Writing captions', detail: shortName(project.name) });

      const initialStatus = {
        progress: 'Initializing AI Speech Recognition...',
        percent: 0,
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
        (_total, warning) => {
          toast(warning
            ? { tone: 'warning', title: 'Captions written, with gaps', detail: `${shortName(project.name)} — ${warning}` }
            : { tone: 'success', title: 'Captions written', detail: shortName(project.name) });
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
              ...(warning ? { error: warning } : {}),
            });
          }
        },
        // onError
        (errMsg) => {
          toast({ tone: 'error', title: 'Writing captions failed', detail: `${shortName(project.name)} — ${errMsg}` });
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
          const previousPercent = _transcribeStatusMap.get(targetProjectId)?.percent ?? 0;
          const newStatus = {
            progress: prog.message || '',
            percent: Math.min(99, Math.max(previousPercent, Number.isFinite(prog.percent) ? prog.percent : previousPercent)),
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

    cancelVoiceGeneration: (projectId?: string) => {
      const id = projectId || get().generatingVoiceProjectId || get().currentProject?.id;
      if (!id) return;
      _voiceGenAbortMap.get(id)?.abort();
      // Keep ownership until the aborted request finishes its cleanup.
      _voiceGenStatusMap.delete(id);
      set({
        generatingVoiceProjectId: null,
        ...(get().currentProject?.id === id
          ? { isGeneratingAudio: false, activeGeneratingSegmentId: null }
          : {}),
      });
    },

    generateVoiceForSegments: async (
      segmentIds?: string[],
      speed: number = 1.0,
      fitMode: string = 'B',
      voiceName?: string,
      emotion?: string,
      skipExisting: boolean = true,
      voiceFx?: string
    ) => {
      const project = get().currentProject;
      if (!project) return;
      const targetProjectId = project.id;
      if (_voiceGenAbortMap.has(targetProjectId)) {
        throw new Error('Voice generation is already running or stopping for this project. Wait for it to finish before starting again.');
      }

      _voiceGenStatusMap.set(targetProjectId, { progress: 0, total: 0, activeSegmentId: null });
      const lines = segmentIds?.length;
      toast({ tone: 'working', title: lines === 1 ? 'Dubbing a line' : lines ? `Dubbing ${lines} lines` : 'Dubbing', detail: shortName(project.name) });

      // Dubbing a long project can run for hours, so it has to be interruptible. Aborting the
      // fetch drops the connection, which is what tells the server to stop synthesising.
      const abortCtrl = new AbortController();
      _voiceGenAbortMap.set(targetProjectId, abortCtrl);

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
            voice_fx: voiceFx ?? null,
          }),
          signal: abortCtrl.signal,
        });

        if (!resp.ok) {
          const detail = await resp.json().catch(() => null);
          throw new Error(detail?.detail || 'Failed to generate voice audio');
        }

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
                  if (evt.status === 'error') {
                    set({ error: evt.message || 'Voice generation failed for a line. Please retry.' });
                  }
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
                toast(evt.failed > 0
                  ? { tone: 'warning', title: `Dubbing finished — ${evt.failed} line${evt.failed === 1 ? '' : 's'} failed`, detail: shortName(project.name) }
                  : { tone: 'success', title: 'Dubbing finished', detail: shortName(project.name) });
                _voiceGenStatusMap.delete(targetProjectId);
                if (isCurrent) set({ activeGeneratingSegmentId: null, isGeneratingAudio: false });
                if (isCurrent && evt.failed > 0 && !get().error) {
                  set({ error: `${evt.failed} voice clips failed to generate. Please retry those lines.` });
                }
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
        if (e?.name === 'AbortError') {
          // Stopped on purpose: lines dubbed so far are already saved.
          toast({ tone: 'info', title: 'Dubbing stopped', detail: `${shortName(project.name)} — voiced lines are kept` });
          if (get().currentProject?.id === targetProjectId) set({ isGeneratingAudio: false });
          return;
        }
        toast({ tone: 'error', title: 'Dubbing failed', detail: `${shortName(project.name)} — ${e.message}` });
        if (get().currentProject?.id === targetProjectId) {
          set({ error: e.message, isGeneratingAudio: false });
        }
        throw e;
      } finally {
        _voiceGenAbortMap.delete(targetProjectId);
        _voiceGenStatusMap.delete(targetProjectId);
        if (get().generatingVoiceProjectId === targetProjectId) {
          set({
            generatingVoiceProjectId: null,
            ...(get().currentProject?.id === targetProjectId ? { isGeneratingAudio: false, activeGeneratingSegmentId: null } : {}),
          });
        }
      }
    },

    setActiveSegment: (id) => { if (get().activeSegmentId !== id) set({ activeSegmentId: id }); },
    setCurrentTime: (time) => { if (get().currentTime !== time) set({ currentTime: time }); },
    setIsPlaying: (playing) => { if (get().isPlaying !== playing) set({ isPlaying: playing }); },
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

// Settings pulled from the server may differ from what was loaded from the browser copy
if (typeof window !== 'undefined') {
  window.addEventListener(PROJECT_SETTINGS_SYNCED, (e) => {
    const id = (e as CustomEvent).detail?.projectId;
    const st = useProjectStore.getState();
    if (!id || st.currentProject?.id !== id) return;
    try {
      const raw = localStorage.getItem(`subtitle-style-${id}`);
      const style = { ...DEFAULT_SUBTITLE_STYLE, ...(raw ? JSON.parse(raw) : {}) };
      delete (style as { fontSize?: number }).fontSize;
      const aspect = localStorage.getItem(`aspect-ratio-${id}`);
      useProjectStore.setState({ subtitleStyle: style, ...(aspect ? { aspectRatio: aspect } : {}) });
    } catch {
      /* keep what is loaded */
    }
  });
}

// The API client names the project in its start/finish toasts; it reads the store through this
// instead of importing it, which would be a circular import.
(globalThis as any).__projectStoreForToasts = useProjectStore;
