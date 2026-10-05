import { useShallow } from 'zustand/react/shallow';
import { VOICE_EFFECT_GROUPS, applyEffectToLines, effectLabel } from '../utils/voiceEffects';
import React, { useState, useRef, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import VoiceMenuPopover from './VoiceMenuPopover';
import SubtitleImportDialog from './SubtitleImportDialog';
import CastPanel from './CastPanel';
import { useProjectStore } from '../stores/projectStore';
import { speakerColorMap } from '../utils/speakerColors';
import { latestJob, usePipelineStore, usePipelineWatch } from '../utils/pipelineWatch';
import { removePipelineJob, spaceOverlappingLines, fetchVoiceProfiles, type VoiceProfileItem, SUBTITLE_ACCEPT, identifySpeakers, fixCharacterGenders, generateCatchyHooks, insertIntroHook, retimeIntroHook } from '../api/client';
import { buildClipLayout, timelineToSource } from '../utils/clipTimemap';
import {
  UploadCloud,
  ChevronDown,
  Play,
  Pause,
  Loader2,
  Check,
  Sparkles,
  Volume2,
  AlignCenter,
  AlignJustify,
  AlignLeft,
  RotateCcw,
  Mic,
  Users,
  CheckCircle2,
  Pencil,
  Trash2,
  CheckSquare,
  Search,
  X,
  Copy,
  Clock,
  AlertTriangle,
  Flame,
  Wand2,
} from 'lucide-react';

interface VoiceActor {
  id: string;
  name: string;
  avatar: string;
  profile: 'female' | 'male' | 'auto';
  tag: string;
  color: string;
}

// Every generate/preview path reads id 'auto' as "use the line's own assigned voice"
const AUTO_VOICE_ACTOR: VoiceActor = {
  id: 'auto',
  name: 'Each line’s voice',
  avatar: '🎭',
  profile: 'auto',
  tag: 'Per line',
  color: 'text-zinc-300',
};


type FitMode = 'A' | 'B' | 'C';

interface FitModeInfo {
  title: string;
  description: string;
  icon: React.ReactNode;
}

// Lines are only ever sped up (max 2×), never slowed down — see voice_generation._fit_max_*
const FIT_MODES: Record<FitMode, FitModeInfo> = {
  A: {
    title: 'Use the gap',
    description: 'Long lines may run into the silence before the next line, sped up only as needed (max 2×).',
    icon: <AlignLeft className="w-3.5 h-3.5" />,
  },
  B: {
    title: 'Fit subtitle (recommended)',
    description: 'Long lines are sped up to end with their subtitle (max 2×). Short lines play at normal speed.',
    icon: <AlignJustify className="w-3.5 h-3.5" />,
  },
  C: {
    title: 'No speed change',
    description: 'Every line plays at normal speed. Long lines may overlap the next one.',
    icon: <AlignCenter className="w-3.5 h-3.5" />,
  },
};

const EMOTIONS_LIST = [
  { id: 'crying', label: 'Crying / Weeping', emoji: '😭', color: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
  { id: 'laughing', label: 'Laughing / Haha', emoji: '😂', color: 'bg-white/10 text-zinc-200 border-white/10' },
  { id: 'scream', label: 'Scream / Shout', emoji: '📢', color: 'bg-red-500/20 text-red-300 border-red-500/40' },
  { id: 'angry', label: 'Angry', emoji: '😡', color: 'bg-orange-500/20 text-orange-300 border-orange-500/40' },
  { id: 'fearful', label: 'Fearful', emoji: '😰', color: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
  { id: 'whisper', label: 'Whisper', emoji: '🤫', color: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
  { id: 'happy', label: 'Happy', emoji: '😊', color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
  { id: 'excited', label: 'Excited', emoji: '⚡', color: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40' },
  { id: 'serious', label: 'Serious', emoji: '🧐', color: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
  { id: 'calm', label: 'Calm', emoji: '😌', color: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
  { id: 'sad', label: 'Sad', emoji: '😢', color: 'bg-white/10 text-zinc-200 border-white/10' },
  { id: 'neutral', label: 'Neutral', emoji: '😐', color: 'bg-zinc-800 text-zinc-400 border-zinc-700' },
];

export default function DubbingStudioPanel({ hookPanelTarget = null, onCloseHookPanel }: {
  hookPanelTarget?: HTMLElement | null;
  onCloseHookPanel?: () => void;
}) {
  const {
    currentProject,
    loadProject,
    generateVoiceForSegments,
    generateTranscript,
    updateSegment,
    deleteSegment,
    isGeneratingAudio,
    isTranscribing,
    transcribeProgress,
    transcribePercent,
    audioGenProgress,
    audioGenTotal,
    activeGeneratingSegmentId,
    activeSegmentId,
    setActiveSegment,
    setCurrentTime,
    isPlaying,
    videoClips,
  } = useProjectStore(useShallow(state => ({ currentProject: state.currentProject, loadProject: state.loadProject, generateVoiceForSegments: state.generateVoiceForSegments, generateTranscript: state.generateTranscript, updateSegment: state.updateSegment, deleteSegment: state.deleteSegment, isGeneratingAudio: state.isGeneratingAudio, isTranscribing: state.isTranscribing, transcribeProgress: state.transcribeProgress, transcribePercent: state.transcribePercent, audioGenProgress: state.audioGenProgress, audioGenTotal: state.audioGenTotal, activeGeneratingSegmentId: state.activeGeneratingSegmentId, activeSegmentId: state.activeSegmentId, setActiveSegment: state.setActiveSegment, setCurrentTime: state.setCurrentTime, isPlaying: state.isPlaying, videoClips: state.videoClips })));

  const clipLayout = useMemo(() => buildClipLayout(videoClips), [videoClips]);

  const seekToSegment = (seg: any) => {
    setActiveSegment(seg.id);
    setCurrentTime(seg.start_time);
    const video = document.querySelector('video');
    if (video) {
      if (clipLayout.length > 0) {
        const res = timelineToSource(clipLayout, seg.start_time);
        video.currentTime = res ? res.sourceTime : seg.start_time;
      } else {
        video.currentTime = seg.start_time;
      }
    }
  };

  // Dubbing handed to the server (from a folder or a split) is shown here as it goes, and the
  // buttons that would start a second, competing run are held until it is done.
  usePipelineWatch();
  const serverJob = latestJob(usePipelineStore((s) => s.jobs), currentProject?.id);
  const serverSteps = serverJob?.steps || [];
  const serverDubbing = serverJob?.status === 'running' && serverJob.step === 'dubbing';
  const serverWillDub = !!serverJob && serverSteps.includes('dubbing') && (
    serverJob.status === 'queued' ||
    (serverJob.status === 'running' && serverSteps.indexOf(serverJob.step) <= serverSteps.indexOf('dubbing'))
  );
  const serverDubLabel = serverDubbing
    ? `Dubbing on the server${serverJob?.percent ? ` ${serverJob.percent}%` : '…'}`
    : serverJob?.status === 'queued' ? 'Dubbing queued on the server' : 'Dubbed on the server next';

  const segments = (currentProject?.segments || []).filter(
    (s) => s.speaker !== 'Freeze' && s.voice_profile !== 'freeze' && !s.text.includes('Freeze Frame')
  );

  const [savedVoices, setSavedVoices] = useState<VoiceProfileItem[]>([]);
  const [voiceLoadError, setVoiceLoadError] = useState('');
  const refreshSavedVoices = () => {
    void fetchVoiceProfiles().then(profiles => {
      setSavedVoices(profiles.filter(p => !p.is_built_in));
      setVoiceLoadError('');
    }).catch(() => setVoiceLoadError('Unable to load saved voices. Open the voice selector to retry.'));
  };
  useEffect(() => {
    refreshSavedVoices();
    window.addEventListener('voice-profiles-changed', refreshSavedVoices);
    window.addEventListener('focus', refreshSavedVoices);
    return () => {
      window.removeEventListener('voice-profiles-changed', refreshSavedVoices);
      window.removeEventListener('focus', refreshSavedVoices);
    };
  }, []);
  const savedVoiceLabel = (voice: VoiceProfileItem) => `${voice.name}${savedVoices.filter(p => p.name === voice.name).length > 1 ? ` · ${voice.id.slice(-6)}` : ''}`;
  // Dubbing always uses each line's own character voice, set from the line's voice picker.
  // A panel-wide override used to sit here and silently forced one voice on every line.
  const [selectedVoiceActor, setSelectedVoiceActor] = useState<VoiceActor>(AUTO_VOICE_ACTOR);
  const [fitMode, setFitMode] = useState<FitMode>('B');
  const [hoveredFitMode, setHoveredFitMode] = useState<FitMode | null>(null);
  const [selectedCharacterFilter, setSelectedCharacterFilter] = useState<string>('all');
  const [fixingGenders, setFixingGenders] = useState(false);

  /** The transcriber guesses man or woman line by line, so one character can end up with
   *  both and be dubbed in two voices. This decides each character once and applies it. */
  const handleFixCharacterGenders = async () => {
    if (!currentProject?.id || fixingGenders) return;
    setFixingGenders(true);
    try {
      const plan = await fixCharacterGenders(currentProject.id, true);
      if (!plan.characters.length) {
        alert(
          plan.named_characters
            ? 'Every named character already has one voice across all of their lines.'
            : 'No named characters to check. Lines labelled only by voice type are left as they are.',
        );
        return;
      }
      const label: Record<string, string> = {
        male: 'man', female: 'woman', grandpa: 'old man', grandma: 'old woman', child_boy: 'boy', child_girl: 'girl',
      };
      const list = plan.characters
        .slice(0, 12)
        .map((c) => `• ${c.name} → ${label[c.profile] || c.profile} (${c.lines_changed} of ${c.lines} lines change${c.decided_by === 'majority' ? ', by majority' : ''})`)
        .join('\n');
      const ok = confirm(
        `Give ${plan.characters.length} character${plan.characters.length === 1 ? '' : 's'} one voice each?\n\n${list}` +
          (plan.characters.length > 12 ? `\n…and ${plan.characters.length - 12} more` : '') +
          (plan.voices_cleared
            ? `\n\n${plan.voices_cleared} dubbed line${plan.voices_cleared === 1 ? ' was' : 's were'} spoken in the wrong voice and will need dubbing again.`
            : '') +
          `\n\nA version is saved first. If one is wrong, set that character's voice by hand afterwards.`,
      );
      if (!ok) return;
      const res = await fixCharacterGenders(currentProject.id);
      await loadProject(currentProject.id);
      alert(`${res.lines_changed} lines updated${res.voices_cleared ? `, ${res.voices_cleared} need dubbing again` : ''}.`);
    } catch (err: any) {
      alert(err?.response?.data?.detail || err?.message || 'Could not check the character genders');
    } finally {
      setFixingGenders(false);
    }
  };
  const [statusFilter, setStatusFilter] = useState<'all' | 'dubbed' | 'undubbed'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [speechSpeed, setSpeechSpeed] = useState<number>(1.0);

  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const [generatingSegmentId, setGeneratingSegmentId] = useState<string | null>(null);
  const [playingSegmentId, setPlayingSegmentId] = useState<string | null>(null);

  // Catchy Hook Generator State

  const [hookDuration, setHookDuration] = useState<number>(4.5);
  const [hookTone, setHookTone] = useState<string>('viral');
  const [hookWordsLimit, setHookWordsLimit] = useState<number>(5);
  const [isGeneratingHooks, setIsGeneratingHooks] = useState(false);
  const [generatedHooks, setGeneratedHooks] = useState<
    Array<{
      hook_id: string;
      text: string;
      category: string;
      category_label: string;
      estimated_seconds: number;
      lines?: number;
      why_it_works: string;
    }>
  >([]);
  const [previewingHookId, setPreviewingHookId] = useState<string | null>(null);
  const [insertingHookId, setInsertingHookId] = useState<string | null>(null);

  // Multi-segment selection for custom batch dubbing
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<Set<string>>(new Set());
  const lastSelectedIdxRef = useRef<number | null>(null);

  const [editingSegId, setEditingSegId] = useState<string | null>(null);
  const [editSegText, setEditSegText] = useState('');

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [voiceMenuAnchor, setVoiceMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const [activeSpeakerPopoverId, setActiveSpeakerPopoverId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // Clean up any preview audio playing when panel unmounts to prevent memory leaks
  useEffect(() => {
    return () => {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current = null;
      }
    };
  }, []);

  const [hookToast, setHookToast] = useState<string | null>(null);

  const CHARACTER_PRESETS = [
    { label: 'តួអង្គប្រុស (Male)', speaker: 'តួអង្គប្រុស (Male)', gender: 'male', voice_profile: 'male', voice_name: 'km-KH-PisethNeural', avatar: '👨' },
    { label: 'តួអង្គស្រី (Female)', speaker: 'តួអង្គស្រី (Female)', gender: 'female', voice_profile: 'female', voice_name: 'km-KH-SreymomNeural', avatar: '👩' },
    { label: 'អ្នករៀបរាប់ (Narrator)', speaker: 'អ្នករៀបរាប់ (Narrator)', gender: 'male', voice_profile: 'male', voice_name: 'km-KH-PisethNeural', avatar: '🎙️' },
    { label: 'លោកតា (Grandpa)', speaker: 'លោកតា (Grandpa)', gender: 'male', voice_profile: 'grandpa', voice_name: 'km-KH-PisethNeural', avatar: '👴' },
    { label: 'លោកយាយ (Grandma)', speaker: 'លោកយាយ (Grandma)', gender: 'female', voice_profile: 'grandma', voice_name: 'km-KH-SreymomNeural', avatar: '👵' },
    { label: 'ក្មេងប្រុស (Boy)', speaker: 'ក្មេងប្រុស (Boy)', gender: 'male', voice_profile: 'child_boy', voice_name: 'km-KH-PisethNeural', avatar: '👦' },
    { label: 'ក្មេងស្រី (Girl)', speaker: 'ក្មេងស្រី (Girl)', gender: 'female', voice_profile: 'child_girl', voice_name: 'km-KH-SreymomNeural', avatar: '👧' },
  ];

  // Lines are drawn a page at a time: a 2,500-line project drew all of them at once — about
  // 200,000 page elements and a second's freeze every time the tab opened. More pages load
  // as the list is scrolled.
  const PAGE = 50;
  const [renderLimit, setRenderLimit] = useState(PAGE);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setRenderLimit(PAGE);
  }, [selectedCharacterFilter, statusFilter, searchQuery, currentProject?.id]);
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setRenderLimit((n) => n + PAGE),
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  });

  /** Scroll a line into view, first drawing enough of the list to include it. */
  const pendingRevealRef = useRef<string | null>(null);
  const revealLine = (id: string | null) => {
    if (!id) return;
    const idx = displayedSegments.findIndex((x) => x.id === id);
    if (idx >= renderLimit) {
      pendingRevealRef.current = id; // scrolled to once it has been drawn
      setRenderLimit(idx + PAGE);
      return;
    }
    document.getElementById(`dub-seg-${id}`)?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  };
  // Only a reveal that was waiting for its line to be drawn scrolls after a page loads —
  // scrolling down to load more must not jump back to the selected line.
  useEffect(() => {
    const id = pendingRevealRef.current;
    if (!id) return;
    pendingRevealRef.current = null;
    document.getElementById(`dub-seg-${id}`)?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }, [renderLimit]);

  // Auto-scroll to selected segment when clicked from timeline or active in project (only when not playing)
  useEffect(() => {
    if (activeSegmentId && !isPlaying) revealLine(activeSegmentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSegmentId, isPlaying]);

  // Auto-scroll to currently dubbing segment
  useEffect(() => {
    revealLine(activeGeneratingSegmentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGeneratingSegmentId]);

  // Close the hook side panel on Escape.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && hookPanelTarget) {
        onCloseHookPanel?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hookPanelTarget, onCloseHookPanel]);

  // Extract unique character list
  const characters = useMemo(() => {
    const set = new Set<string>();
    segments.forEach((s) => {
      if (s.speaker && s.speaker.trim()) set.add(s.speaker.trim());
    });
    return Array.from(set);
  }, [segments]);

  const characterOptions = useMemo(() => {
    return characters.map((char) => {
      const count = segments.filter((s) => s.speaker === char).length;
      const charSegs = segments.filter((s) => s.speaker === char);
      const profiles = charSegs.map((s) => (s.voice_profile || '').toLowerCase());
      const genders = charSegs.map((s) => (s.gender || '').toLowerCase());

      let avatar = '🎭';
      let isFemale = false;
      let isMale = false;

      if (/intro hook|hook/i.test(char)) {
        avatar = '🎯';
        isMale = true;
      } else if (/narrator|អ្នករៀបរាប់/i.test(char)) {
        avatar = '🎙️';
        isMale = true;
      } else if (profiles.some((p) => p.includes('grandpa')) || /grandpa|លោកតា|ជីតា/i.test(char)) {
        avatar = '👴';
        isMale = true;
      } else if (profiles.some((p) => p.includes('grandma')) || /grandma|លោកយាយ|ជីដូន/i.test(char)) {
        avatar = '👵';
        isFemale = true;
      } else if (profiles.some((p) => p.includes('child_boy')) || /child boy|ក្មេងប្រុស/i.test(char)) {
        avatar = '👦';
        isMale = true;
      } else if (profiles.some((p) => p.includes('child_girl')) || /child girl|ក្មេងស្រី/i.test(char)) {
        avatar = '👧';
        isFemale = true;
      } else if (profiles.some((p) => p.includes('female')) || genders.some((g) => g === 'female') || /woman|girl|female|ស្រី|អ្នកនាង|កញ្ញា|លោកស្រី|តួអង្គស្រី|តួឯកស្រី/i.test(char)) {
        avatar = '👩';
        isFemale = true;
      } else if (profiles.some((p) => p.includes('male')) || genders.some((g) => g === 'male') || /man|boy|male|បុរស|ប្រុស|តួអង្គប្រុស|តួឯកប្រុស/i.test(char)) {
        avatar = '👨';
        isMale = true;
      }

      return {
        name: char,
        count,
        avatar,
        isFemale,
        isMale,
      };
    });
  }, [characters, segments]);


  // Filtered segments with search & status filters
  const displayedSegments = useMemo(() => {
    return segments.filter((s) => {
      // 1. Character Filter
      if (selectedCharacterFilter !== 'all' && s.speaker !== selectedCharacterFilter) {
        return false;
      }
      // 2. Status Filter
      if (statusFilter === 'dubbed' && !s.audio_url) return false;
      if (statusFilter === 'undubbed' && !!s.audio_url) return false;
      // 3. Search Query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchText = (s.text || '').toLowerCase().includes(q);
        const matchOrig = (s.original_text || '').toLowerCase().includes(q);
        const matchSpeaker = (s.speaker || '').toLowerCase().includes(q);
        if (!matchText && !matchOrig && !matchSpeaker) return false;
      }
      return true;
    });
  }, [segments, selectedCharacterFilter, statusFilter, searchQuery]);

  const dubbedCount = useMemo(() => segments.filter((s) => !!s.audio_url).length, [segments]);
  const hookHeading = 'text-[11px] font-semibold uppercase tracking-wider text-blue-200/90';
  const speakerColors = useMemo(() => speakerColorMap(currentProject?.segments || []), [currentProject?.segments]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms}`;
  };

  const toggleSelectSegment = (segId: string, idx: number, shiftKey: boolean) => {
    setSelectedSegmentIds((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastSelectedIdxRef.current !== null) {
        const start = Math.min(lastSelectedIdxRef.current, idx);
        const end = Math.max(lastSelectedIdxRef.current, idx);
        for (let i = start; i <= end; i++) {
          const s = displayedSegments[i];
          if (s) next.add(s.id);
        }
      } else {
        if (next.has(segId)) {
          next.delete(segId);
        } else {
          next.add(segId);
        }
        lastSelectedIdxRef.current = idx;
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (displayedSegments.every(s => selectedSegmentIds.has(s.id))) {
      setSelectedSegmentIds(new Set());
    } else {
      setSelectedSegmentIds(new Set(displayedSegments.map((s) => s.id)));
    }
  };

  const handleSelectUndubbed = () => {
    const undubbed = displayedSegments.filter((s) => !s.audio_url).map((s) => s.id);
    setSelectedSegmentIds(new Set(undubbed));
  };

  const handleClearSelection = () => {
    setSelectedSegmentIds(new Set());
    lastSelectedIdxRef.current = null;
  };


  const handleAssignCharacterSingle = async (segId: string, preset: typeof CHARACTER_PRESETS[0]) => {
    await updateSegment(segId, {
      speaker: preset.speaker,
      gender: preset.gender,
      voice_profile: preset.voice_profile,
      voice_name: preset.voice_name,
    });
    setActiveSpeakerPopoverId(null);
  };

  // Dubbing used to fail silently (console only); say what went wrong instead
  const [dubError, setDubError] = useState<string | null>(null);
  const reportDubError = (e?: unknown) => {
    const msg = e
      ? (e as any)?.response?.data?.detail || (e instanceof Error ? e.message : String(e))
      : useProjectStore.getState().error;
    setDubError(msg || null);
  };
  const [fxBusyId, setFxBusyId] = useState<string | null>(null);
  const setLineEffect = async (segId: string, fx: string) => {
    setFxBusyId(segId);
    try {
      await applyEffectToLines([segId], fx);
    } catch (e) {
      reportDubError(e);
    } finally {
      setFxBusyId(null);
    }
  };

  const handleGenerateSelectedSpeech = async () => {
    if (!currentProject?.id || selectedSegmentIds.size === 0) return;
    const validIds = Array.from(selectedSegmentIds).filter((id) =>
      segments.some((s) => s.id === id)
    );
    if (validIds.length === 0) return;
    setIsGeneratingAll(true);
    try {
      const voiceParam = selectedVoiceActor.id === 'auto' ? undefined : selectedVoiceActor.id;
      await generateVoiceForSegments(validIds, speechSpeed, fitMode, voiceParam, undefined, true);
      reportDubError();
      await loadProject(currentProject.id);
    } catch (e) {
      reportDubError(e);
    } finally {
      setIsGeneratingAll(false);
    }
  };

  const handleGenerateAllSpeech = async (forceRedub = false) => {
    if (!currentProject?.id || segments.length === 0) return;
    setIsGeneratingAll(true);
    try {
      const voiceParam = selectedVoiceActor.id === 'auto' ? undefined : selectedVoiceActor.id;
      const targetIds =
        selectedCharacterFilter === 'all' && statusFilter === 'all' && !searchQuery
          ? undefined
          : displayedSegments.map((s) => s.id);
      await generateVoiceForSegments(targetIds, speechSpeed, fitMode, voiceParam, undefined, !forceRedub);
      reportDubError();
      await loadProject(currentProject.id);
    } catch (e) {
      reportDubError(e);
    } finally {
      setIsGeneratingAll(false);
    }
  };

  // Lines that start before the one before them has finished are dubbed on top of each other:
  // half a second of two voices at once, heard as a line cut off or said twice.
  const overlapCount = useMemo(() => {
    const spoken = segments
      .filter((s) => (s.text || '').trim() && s.speaker !== 'Freeze' && s.voice_profile !== 'freeze' && !(s.speaker || '').toLowerCase().includes('intro hook'))
      .sort((a, b) => a.start_time - b.start_time);
    return spoken.filter((s, i) => i > 0 && s.start_time < spoken[i - 1].end_time - 0.01).length;
  }, [segments]);
  const [spacing, setSpacing] = useState(false);
  const handleSpaceOverlaps = async () => {
    if (!currentProject?.id || spacing) return;
    setSpacing(true);
    try {
      const { to_revoice } = await spaceOverlappingLines(currentProject.id);
      await loadProject(currentProject.id);
      if (to_revoice.length) {
        // only the lines that moved are voiced again, in their new place
        setIsGeneratingAll(true);
        const voiceParam = selectedVoiceActor.id === 'auto' ? undefined : selectedVoiceActor.id;
        await generateVoiceForSegments(to_revoice, speechSpeed, fitMode, voiceParam, undefined, true);
        reportDubError();
        await loadProject(currentProject.id);
      }
    } catch (e) {
      reportDubError(e);
    } finally {
      setIsGeneratingAll(false);
      setSpacing(false);
    }
  };

  const handleGenerateSingleLine = async (segId: string) => {
    if (!currentProject?.id || !segId) return;
    setGeneratingSegmentId(segId);
    try {
      const voiceParam = selectedVoiceActor.id === 'auto' ? undefined : selectedVoiceActor.id;
      await generateVoiceForSegments([segId], speechSpeed, fitMode, voiceParam, undefined, false);
      reportDubError();
      await loadProject(currentProject.id);
    } catch (e) {
      reportDubError(e);
    } finally {
      setGeneratingSegmentId(null);
    }
  };

  const getSegmentEmotion = (seg: { emotion?: string; text: string }) => {
    if (seg.emotion) {
      const found = EMOTIONS_LIST.find((e) => e.id === seg.emotion);
      if (found) return found;
    }
    const lower = (seg.text || '').toLowerCase();
    if (
      lower.includes('កាប់សម្លាប់') ||
      lower.includes('សម្លាប់') ||
      lower.includes('កម្ទេច') ||
      lower.includes('ស្រែក') ||
      lower.includes('ប្រហារ') ||
      lower.includes('បាញ់វា') ||
      lower.includes('វាយវា') ||
      lower.includes('(scream)') ||
      lower.includes('(shout)') ||
      lower.includes('[scream]') ||
      lower.includes('[shout]')
    ) {
      return EMOTIONS_LIST.find((e) => e.id === 'scream')!;
    }
    if (
      lower.includes('យំ') ||
      lower.includes('ទារកយំ') ||
      lower.includes('កូនយំ') ||
      lower.includes('ខ្សឹកខ្សួល') ||
      lower.includes('cry') ||
      lower.includes('crying') ||
      lower.includes('weep') ||
      lower.includes('sobbing') ||
      lower.includes('[baby crying]')
    ) {
      return EMOTIONS_LIST.find((e) => e.id === 'crying')!;
    }
    if (
      lower.includes('ហាហា') ||
      lower.includes('សើច') ||
      lower.includes('laugh') ||
      lower.includes('giggle') ||
      lower.includes('haha')
    ) {
      return EMOTIONS_LIST.find((e) => e.id === 'laughing')!;
    }
    if (lower.includes('កំហឹង') || lower.includes('ខឹង') || lower.includes('ឈប់ភ្លាម')) {
      return EMOTIONS_LIST.find((e) => e.id === 'angry')!;
    }
    if (lower.includes('ខ្សឹប') || lower.includes('សម្ងាត់')) {
      return EMOTIONS_LIST.find((e) => e.id === 'whisper')!;
    }
    if (lower.includes('ភ័យ') || lower.includes('ខ្លាច') || lower.includes('ជួយផង')) {
      return EMOTIONS_LIST.find((e) => e.id === 'fearful')!;
    }
    return EMOTIONS_LIST.find((e) => e.id === 'neutral')!;
  };

  const handlePlaySample = async (text: string, segId: string) => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
    }

    if (playingSegmentId === segId) {
      setPlayingSegmentId(null);
      return;
    }

    const seg = segments.find((s) => s.id === segId);
    if (seg?.audio_url && (selectedVoiceActor.id === 'auto' || selectedVoiceActor.id === seg.voice_name)) {
      const audio = new Audio(seg.audio_url);
      previewAudioRef.current = audio;
      setPlayingSegmentId(segId);
      audio.onended = () => {
        setPlayingSegmentId(null);
        previewAudioRef.current = null;
      };
      audio.onerror = () => {
        setPlayingSegmentId(null);
        previewAudioRef.current = null;
      };
      audio.play().catch(() => setPlayingSegmentId(null));
      return;
    }

    // Neural TTS preview on the fly
    if (!currentProject?.id) return;
    setPlayingSegmentId(segId);
    try {
      const emo = getSegmentEmotion(seg || { text });
      const voiceParam = selectedVoiceActor.id === 'auto' ? (seg?.voice_name || '') : selectedVoiceActor.id;
      const resp = await fetch(`/api/projects/${currentProject.id}/transcripts/tts-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voice_name: voiceParam,
          voice_profile: seg?.voice_profile || 'female',
          voice_fx: seg?.voice_fx || 'normal',
          speed: speechSpeed,
          emotion: emo.id,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.audio_url) {
          const audio = new Audio(data.audio_url);
          previewAudioRef.current = audio;
          audio.onended = () => {
            setPlayingSegmentId(null);
            previewAudioRef.current = null;
          };
          audio.onerror = () => {
            setPlayingSegmentId(null);
            previewAudioRef.current = null;
          };
          audio.play().catch(() => setPlayingSegmentId(null));
          return;
        }
      }
    } catch (e) {
      console.error(e);
    }
    setPlayingSegmentId(null);
  };

  const handleStartEdit = (segId: string, text: string) => {
    setEditingSegId(segId);
    setEditSegText(text);
  };

  const handleSaveEdit = async (segId: string) => {
    if (!editingSegId) return;
    await updateSegment(segId, { text: editSegText });
    setEditingSegId(null);
  };

  const handleCopyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const [importFile, setImportFile] = useState<File | null>(null);
  const handleImportSrt = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';  // so the same file can be picked again
    if (file && currentProject?.id) setImportFile(file);
  };

  const [identifying, setIdentifying] = useState(false);
  const [showCast, setShowCast] = useState(false);

  /** Imported subtitles say what is said, not who says it, so every line would get the same
   *  voice. This listens to the video and labels each line with its speaker. */
  const handleIdentifySpeakers = async () => {
    if (!currentProject?.id || identifying) return;
    const unnamed = segments.filter((seg) => !(seg.speaker || '').trim()).length;
    const all = unnamed === 0;
    if (!confirm(
      (all
        ? `Every line already has a speaker. Listen to the video again and relabel all ${segments.length} lines?`
        : `Listen to the video and work out who speaks the ${unnamed} line${unnamed === 1 ? '' : 's'} that name nobody?`) +
        `\n\nEach character gets a voice to match (man, woman, child…). This uses your Gemini quota and takes a while on a long video. A version is saved first.`,
    )) return;
    setIdentifying(true);
    try {
      const res = await identifySpeakers(currentProject.id, all);
      await loadProject(currentProject.id);
      const cast = res.characters.slice(0, 8).map((c) => `• ${c.name} — ${c.lines} line${c.lines === 1 ? '' : 's'}`).join('\n');
      alert(
        `${res.labelled} of ${res.asked} lines now have a speaker.\n\n${cast}` +
          (res.characters.length > 8 ? `\n…and ${res.characters.length - 8} more` : '') +
          (res.voices_cleared ? `\n\n${res.voices_cleared} dubbed lines were in the wrong voice and need dubbing again.` : ''),
      );
    } catch (err: any) {
      alert(err?.response?.data?.detail || err?.message || 'Could not identify the speakers');
    } finally {
      setIdentifying(false);
    }
  };

  const handleGenerateHooks = async (targetDuration?: number | React.MouseEvent, targetTone?: string) => {
    if (!currentProject?.id) return;
    const dur = typeof targetDuration === 'number' ? targetDuration : hookDuration;
    const tone = typeof targetTone === 'string' ? targetTone : hookTone;
    setIsGeneratingHooks(true);
    try {
      const hooks = await generateCatchyHooks(currentProject.id, {
        originalTitle: currentProject.name,
        language: currentProject.language || 'km',
        durationSeconds: dur,
        tone: tone,
      });
      setGeneratedHooks(hooks || []);
    } catch (err) {
      console.error('Failed to generate hooks:', err);
    } finally {
      setIsGeneratingHooks(false);
    }
  };

  const handlePreviewHookTTS = async (text: string, hookId: string) => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
    }
    if (previewingHookId === hookId) {
      setPreviewingHookId(null);
      return;
    }

    setPreviewingHookId(hookId);
    try {
      // /api/tts/speak never existed; the line audition's preview route does the same job
      const res = await fetch(`/api/projects/${currentProject?.id}/transcripts/tts-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice_profile: 'male', speed: speechSpeed }),
      });
      const data = res.ok ? await res.json() : null;
      if (data?.audio_url) {
        const audio = new Audio(data.audio_url);
        previewAudioRef.current = audio;
        audio.onended = () => {
          setPreviewingHookId(null);
          previewAudioRef.current = null;
        };
        audio.onerror = () => {
          setPreviewingHookId(null);
          previewAudioRef.current = null;
        };
        audio.play().catch(() => setPreviewingHookId(null));
      } else {
        setPreviewingHookId(null);
      }
    } catch (e) {
      console.error('Preview TTS failed:', e);
      setPreviewingHookId(null);
    }
  };

  const handleInsertHookSegment = async (hook: { text: string; estimated_seconds?: number }, dubNow: boolean = false) => {
    if (!currentProject?.id) return;
    const dur = hook.estimated_seconds || hookDuration || 4.0;
    const replacing = segments.filter((s) => s.start_time < dur).length;
    if (
      replacing > 0 &&
      !confirm(
        `The hook takes over the first ${dur.toFixed(1)}s of the video.\n\n` +
          `${replacing} existing caption${replacing > 1 ? 's' : ''} there will be replaced.\n\nContinue?`
      )
    ) {
      return;
    }
    setInsertingHookId(hook.text);
    try {
      // 1. Call atomic backend endpoint to clean up 0:00-dur and insert the intro hook chunked by 4-6 words
      const res = await insertIntroHook(currentProject.id, {
        text: hook.text,
        duration_seconds: dur,
        words_per_segment: hookWordsLimit,
        speaker: 'Intro Hook (អ្នករៀបរាប់)',
        voice_profile: 'male',
        emotion: 'excited',
      });

      if (res?.segments) {
        // Direct store sync to immediately update timeline and caption panels
        useProjectStore.setState((state) => {
          if (!state.currentProject) return state;
          return {
            ...state,
            currentProject: {
              ...state.currentProject,
              segments: res.segments,
            },
          };
        });
      }

      // Auto-close modal immediately so the user returns to their project
      onCloseHookPanel?.();
      setHookToast(dubNow ? `⚡ Intro Hook (4-6 words/segment) replaced 0:00–${dur.toFixed(0)}s & dubbed!` : `✨ Intro Hook (4-6 words/segment) replaced 0:00–${dur.toFixed(0)}s!`);
      setTimeout(() => setHookToast(null), 4000);

      const targetIds = res?.segment_ids && res.segment_ids.length > 0
        ? res.segment_ids
        : res?.segment_id ? [res.segment_id] : [];

      if (dubNow && targetIds.length > 0) {
        const voiceParam = selectedVoiceActor.id === 'auto' ? undefined : selectedVoiceActor.id;
        await generateVoiceForSegments(targetIds, speechSpeed, fitMode, voiceParam, undefined, false);
        // The chunks were timed from an estimate; move them onto the real spoken audio
        try {
          const timing = await retimeIntroHook(currentProject.id, targetIds);
          if (timing.overflow_seconds > 0.3) {
            setHookToast(
              `Hook runs ${timing.hook_seconds.toFixed(1)}s (${timing.overflow_seconds.toFixed(1)}s over the ${timing.planned_seconds.toFixed(1)}s you picked)` +
                (timing.pushed_segments ? ` · the rest of the captions moved ${timing.overflow_seconds.toFixed(1)}s later so nothing is talked over` : '')
            );
            setTimeout(() => setHookToast(null), 6000);
          }
        } catch {
          /* keep the estimated timing if re-timing fails */
        }
        await loadProject(currentProject.id);
      }
    } catch (err) {
      console.error('Insert hook failed:', err);
      onCloseHookPanel?.();
    } finally {
      setInsertingHookId(null);
    }
  };

  const tooltipMode = hoveredFitMode ? FIT_MODES[hoveredFitMode] : null;

  return (
    <div className="flex flex-col h-full bg-[var(--s1)] text-[#e1e4ea] select-none font-sans overflow-hidden">
      {/* Hidden File Input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={SUBTITLE_ACCEPT}
        className="hidden"
        onChange={handleImportSrt}
      />
      {showCast && currentProject?.id && (
        <CastPanel
          projectId={currentProject.id}
          segments={segments}
          onClose={(changed) => {
            setShowCast(false);
            if (changed) void loadProject(currentProject.id);
          }}
        />
      )}
      {importFile && currentProject?.id && (
        <SubtitleImportDialog
          projectId={currentProject.id}
          file={importFile}
          onClose={(changed) => {
            setImportFile(null);
            if (changed) void loadProject(currentProject.id);
          }}
        />
      )}

      {/* Toast Notification for Hook Insert / Actions */}
      {hookToast && (
        <div className="mx-4 mt-2 px-3.5 py-2 rounded-xl bg-white/10 border border-white/10 text-zinc-100 text-xs font-semibold flex items-center justify-between shadow-lg animate-in fade-in slide-in-from-top-2 shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-zinc-200 animate-spin" style={{ animationDuration: '3s' }} />
            <span>{hookToast}</span>
          </div>
          <button onClick={() => setHookToast(null)} className="text-zinc-400 hover:text-white cursor-pointer ml-2">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {voiceLoadError && <div role="alert" className="px-4 py-1.5 border-b border-white/5 text-xs text-red-400">{voiceLoadError}</div>}
      {/* 1. Header: how much is dubbed, and the tools for who speaks */}
      <div className="px-3 py-2 border-b border-[var(--s4)] flex items-center justify-end gap-3 shrink-0 relative z-40">
        <div className="flex items-center gap-1 shrink-0">
          {segments.length > 0 && !!currentProject?.video_path && (
            <button
              onClick={() => void handleIdentifySpeakers()}
              disabled={identifying}
              title="Listen to the video and work out who speaks each line — for imported subtitles, which do not say"
              className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {identifying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mic className="w-3.5 h-3.5" />}
              <span className="hidden lg:inline">{identifying ? 'Listening…' : 'Identify speakers'}</span>
            </button>
          )}
          {characters.length > 0 && (
            <button
              onClick={() => void handleFixCharacterGenders()}
              disabled={fixingGenders}
              title="Give each character one voice: fixes a man dubbed as a woman on some of his lines, and the reverse"
              className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {fixingGenders ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
              <span className="hidden lg:inline">Fix genders</span>
            </button>
          )}
          {characters.length > 0 && (
            <button
              onClick={() => setShowCast(true)}
              title="Every character once: rename them, and choose the voice they are dubbed in"
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white transition-colors whitespace-nowrap"
            >
              <Users className="w-3.5 h-3.5" />
              <span>Cast</span>
            </button>
          )}
        </div>
      </div>

      {/* Search & Quick Filters Bar */}

      {/* 3. Search & Quick Filters Bar */}
      {segments.length > 0 && (
        <div className="px-3 py-2 border-b border-[var(--s3)] flex items-center justify-between gap-2 shrink-0">
          {/* Search Input */}
          <div className="relative flex-1 flex items-center">
            <Search className="w-3.5 h-3.5 absolute left-2.5 text-zinc-500 pointer-events-none" />
            <input
              type="text"
              placeholder="Search words or a speaker…"
              aria-label="Search the lines"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-7 py-1 rounded-lg bg-[var(--s3)] border border-[var(--s5)] text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-white/10 transition-all font-sans"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 text-zinc-400 hover:text-white"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Status Tabs: All / Dubbed / Undubbed */}
          <div className="flex items-center gap-1 bg-[var(--s3)] p-0.5 rounded-lg border border-[var(--s5)] shrink-0 text-[11px]">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-2 py-0.5 rounded-md font-medium transition-all ${
                statusFilter === 'all' ? 'bg-[var(--s5)] text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              All ({segments.length})
            </button>
            <button
              onClick={() => setStatusFilter('dubbed')}
              className={`px-2 py-0.5 rounded-md font-medium transition-all ${
                statusFilter === 'dubbed' ? 'bg-emerald-500/20 text-emerald-300 font-bold' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Dubbed ({dubbedCount})
            </button>
            <button
              onClick={() => setStatusFilter('undubbed')}
              className={`px-2 py-0.5 rounded-md font-medium transition-all ${
                statusFilter === 'undubbed' ? 'bg-amber-500/20 text-amber-300 font-bold' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              No voice ({segments.length - dubbedCount})
            </button>
          </div>
        </div>
      )}

      {/* 4. Who speaks (click a name for their lines), and choosing lines to dub together */}
      {segments.length > 0 && (
        <div className="px-3 py-1.5 border-b border-[var(--s3)] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none min-w-0">
            {characterOptions.length > 1 && characterOptions.map((char) => {
              const on = selectedCharacterFilter === char.name;
              const color = speakerColors[char.name] || '#71717a';
              return (
                <button
                  key={char.name}
                  onClick={() => setSelectedCharacterFilter(on ? 'all' : char.name)}
                  aria-pressed={on}
                  title={on ? 'Show every line' : `Show only ${char.name}’s lines`}
                  className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] whitespace-nowrap border transition-colors ${
                    on ? 'text-white border-transparent' : 'text-zinc-300 border-[var(--s5)] hover:border-zinc-600'
                  }`}
                  style={on ? { background: `${color}55` } : undefined}
                >
                  <span className="w-2 h-2 rounded-full" style={{ background: color }} />
                  {char.name}
                  <span className="text-zinc-500 tabular-nums">{char.count}</span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1 shrink-0 text-[11px]">
            {selectedSegmentIds.size > 0 ? (
              <>
                <span className="font-semibold text-white tabular-nums">{selectedSegmentIds.size} selected</span>
                <button
                  onClick={handleGenerateSelectedSpeech}
                  disabled={isGeneratingAll}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white font-semibold disabled:opacity-50 cursor-pointer"
                >
                  <Sparkles className="w-3 h-3" /> Dub them
                </button>
                <button onClick={handleClearSelection} className="px-2 py-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/10">Clear</button>
              </>
            ) : (
              <>
                <button onClick={handleSelectAll} disabled={!displayedSegments.length} className="flex items-center gap-1 px-2 py-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-40">
                  <CheckSquare className="w-3.5 h-3.5" /> Select all
                </button>
                {segments.length - dubbedCount > 0 && (
                  <button onClick={handleSelectUndubbed} className="px-2 py-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/10" title="Select every line that has no voice yet">
                    Select those with no voice
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {dubError && (
        <div role="alert" className="mx-4 mt-2 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-950/40 px-3 py-2 text-[11px] text-red-200">
          <span className="flex-1">Dubbing failed: {dubError}</span>
          <button onClick={() => setDubError(null)} className="text-red-300 hover:text-white" aria-label="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* 5. Main Dialogue Segments Scroll Area */}
      <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
        {/* Overlapping lines: their voices would talk over each other */}
        {overlapCount > 0 && !isGeneratingAll && !isGeneratingAudio && !serverWillDub && (
          <div role="status" className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between gap-3">
            <div className="flex items-start gap-2.5 min-w-0">
              <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
              <p className="text-[11px] text-amber-100 leading-snug">
                <span className="font-semibold">{overlapCount} line{overlapCount === 1 ? '' : 's'} start{overlapCount === 1 ? 's' : ''} before the line before {overlapCount === 1 ? 'it' : 'them'} has finished</span>
                {' '}— their voices talk over each other, which sounds cut off or said twice.
              </p>
            </div>
            <button
              onClick={() => void handleSpaceOverlaps()}
              disabled={spacing}
              title="Move each overlapping line to start after the one before it, then dub just those lines again"
              className="px-2.5 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-[11px] font-bold shrink-0 disabled:opacity-50 cursor-pointer"
            >
              {spacing ? 'Fixing…' : 'Space out & re-dub'}
            </button>
          </div>
        )}

        {/* The server's dubbing of this project — the same progress as the top strip and the panel */}
        {serverWillDub && !isGeneratingAll && !isGeneratingAudio && serverJob && (
          <div role="status" className="p-3 rounded-xl bg-blue-600/10 border border-blue-500/25 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-7 h-7 rounded-lg bg-blue-600/20 flex items-center justify-center shrink-0">
                  {serverDubbing ? <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-300" /> : <Clock className="w-3.5 h-3.5 text-blue-300" />}
                </div>
                <div className="min-w-0">
                  <h4 className="text-xs font-bold text-white">{serverDubLabel}</h4>
                  <p className="text-[11px] text-zinc-300 leading-tight truncate">
                    {serverDubbing
                      ? `${serverJob.message || 'Voicing the lines'} — the voices appear here as they are made`
                      : serverJob.status === 'running'
                        ? `${serverJob.message || 'Working'} first; dubbing comes after`
                        : 'It starts when the projects before it are done'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  if (!confirm('Stop the server’s work on this project? Lines already voiced keep their voice; anything after dubbing (such as the export) is not done.')) return;
                  void removePipelineJob(serverJob.id).catch(() => {});
                }}
                title="Stop the server's work on this project"
                className="px-2.5 py-1 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-400/30 text-[11px] font-semibold text-red-200 hover:text-red-100 transition-colors cursor-pointer shrink-0"
              >
                Stop
              </button>
            </div>
            {serverDubbing && (
              <div className="h-1 rounded-full bg-white/10 overflow-hidden">
                <div className="h-full bg-blue-500 transition-[width]" style={{ width: `${serverJob.percent || 0}%` }} />
              </div>
            )}
          </div>
        )}

        {/* Progress Banner During Audio Synthesis */}
        {(isGeneratingAll || isGeneratingAudio) && (
          <div className="p-3 rounded-xl bg-gradient-to-r from-[#141b2c] to-[#1e1733] border border-white/10 shadow-xl flex flex-col gap-2 animate-in fade-in">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-white/10 border border-white/10 flex items-center justify-center text-zinc-200 shadow-inner">
                  <Volume2 className="w-3.5 h-3.5 animate-pulse text-zinc-400" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                    <span>Synthesizing Voice Track (Mode {fitMode})</span>
                  </h4>
                  <p className="text-[11px] text-zinc-100 leading-tight">
                    {audioGenTotal > 0
                      ? `Dubbed line ${audioGenProgress} of ${audioGenTotal}...`
                      : 'Generating natural emotional speech & audio waveform timing...'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
                <button
                  onClick={() => useProjectStore.getState().cancelVoiceGeneration()}
                  title="Stop dubbing — lines already done keep their voice"
                  className="px-2.5 py-1 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-400/30 text-[11px] font-semibold text-red-200 hover:text-red-100 transition-colors cursor-pointer"
                >
                  Stop
                </button>
              </div>
            </div>

            {/* Progress Bar */}
            <div className="w-full h-2 bg-black/50 rounded-full overflow-hidden border border-white/5">
              <div
                className="h-full bg-white/10 rounded-full transition-all duration-300 shadow-lg"
                style={{
                  width:
                    audioGenTotal > 0
                      ? `${Math.round((audioGenProgress / audioGenTotal) * 100)}%`
                      : '100%',
                }}
              />
            </div>
          </div>
        )}

        {displayedSegments.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-white/10 border border-white/10 flex items-center justify-center text-zinc-400 mb-1">
              <Users className="w-7 h-7" />
            </div>
            <div>
              <h4 className="text-sm font-bold text-white">No Dialogue Segments Found</h4>
              <p className="text-xs text-zinc-400 max-w-sm leading-relaxed mt-1">
                {selectedCharacterFilter !== 'all'
                  ? `No dialogue lines found for character "${selectedCharacterFilter}".`
                  : searchQuery
                  ? `No dialogue lines match "${searchQuery}".`
                  : 'Dubbing requires text lines to speak. Transcribe your video or import subtitles first.'}
              </p>
            </div>

            {selectedCharacterFilter === 'all' && !searchQuery && (
              <div className="flex flex-col sm:flex-row items-center gap-2 pt-2">
                <button
                  onClick={() => generateTranscript('km')}
                  disabled={isTranscribing}
                  className={`relative overflow-hidden flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-xs shadow-lg transition-all border ${
                    isTranscribing
                      ? 'bg-[#1f162e] border-white/10 text-white min-w-[210px]'
                      : 'bg-white/10 hover:bg-white/10 border-white/10 text-white'
                  }`}
                >
                  {isTranscribing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-zinc-100" />
                      <span>{transcribeProgress || 'Transcribing...'} ({transcribePercent || 0}%)</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      <span>Transcribe Video to Dialogue</span>
                    </>
                  )}
                </button>

                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[var(--s3)] hover:bg-[var(--s4)] border border-[var(--s6)] text-zinc-300 hover:text-white font-semibold text-xs transition-colors"
                >
                  <UploadCloud className="w-4 h-4" />
                  <span>Import subtitles</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-1.5">
            {displayedSegments.slice(0, renderLimit).map((seg, idx) => {
              const isGenThis = isGeneratingAudio
                ? activeGeneratingSegmentId === seg.id
                : generatingSegmentId === seg.id;
              const isPlayThis = playingSegmentId === seg.id;
              const isEditing = editingSegId === seg.id;
              const isActive = activeSegmentId === seg.id;
              const isSelected = selectedSegmentIds.has(seg.id);
              const profileGender = ['female', 'grandma', 'child_girl'].includes(seg.voice_profile || '')
                ? 'female'
                : ['male', 'grandpa', 'child_boy'].includes(seg.voice_profile || '') ? 'male' : seg.gender;
              const isFemale = profileGender
                ? profileGender === 'female'
                : Boolean(seg.speaker && /\b(woman|girl|female)\b|ស្រី|កញ្ញា|លោកស្រី/i.test(seg.speaker));
              const isMale = profileGender
                ? profileGender === 'male'
                : Boolean(seg.speaker && /\b(man|boy|male)\b|ប្រុស/i.test(seg.speaker));

              const speakerColor = speakerColors[seg.speaker] || '#71717a';

              return (
                <div
                  id={`dub-seg-${seg.id}`}
                  key={seg.id}
                  onClick={() => seekToSegment(seg)}
                  className={`border rounded-xl pl-4 pr-2.5 py-2 space-y-1.5 transition-colors relative overflow-hidden cursor-pointer group/card [content-visibility:auto] [contain-intrinsic-size:auto_80px] ${
                    isGenThis
                      ? 'bg-blue-600/10 border-blue-500/60'
                      : isSelected
                      ? 'bg-blue-600/10 border-blue-500/50'
                      : isActive
                      ? 'bg-[var(--s3)] border-blue-500/50'
                      : 'bg-[var(--s3)]/60 border-[var(--s4)] hover:border-zinc-600 hover:bg-[var(--s3)]'
                  }`}
                >
                  {/* the speaker's colour, as on the timeline */}
                  <span aria-hidden className="absolute left-0 top-0 bottom-0 w-1" style={{ background: speakerColor }} />

                  {/* Top Meta Bar */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                      {/* Checkbox Selector */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelectSegment(seg.id, idx, e.shiftKey);
                        }}
                        aria-pressed={isSelected}
                        className={`w-4 h-4 rounded flex items-center justify-center transition-colors shrink-0 ${
                          isSelected ? 'bg-blue-600 text-white' : 'border border-zinc-600 hover:border-zinc-400 text-transparent'
                        }`}
                        title="Select line (Hold Shift for multi-select range)"
                      >
                        <Check className="w-2.5 h-2.5 stroke-[3]" />
                      </button>

                      {/* Interactive Speaker / Character Switcher Badge */}
                      <div className="relative">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            refreshSavedVoices();
                            setVoiceMenuAnchor(e.currentTarget);
                            setActiveSpeakerPopoverId(activeSpeakerPopoverId === seg.id ? null : seg.id);
                          }}
                          className="text-[11px] font-semibold flex items-center gap-1 rounded px-1 -mx-1 hover:bg-white/10 transition-colors cursor-pointer"
                          style={{ color: seg.speaker ? speakerColor : undefined }}
                          aria-haspopup="dialog"
                          aria-expanded={activeSpeakerPopoverId === seg.id}
                          title="Click to change character & voice"
                        >
                          <span>{seg.speaker || <span className="text-zinc-500 font-normal">No speaker · {isMale ? 'male voice' : isFemale ? 'female voice' : 'default voice'}</span>}{savedVoices.find(v => v.id === seg.voice_name) ? ` · ${savedVoiceLabel(savedVoices.find(v => v.id === seg.voice_name)!)}` : ''}</span>
                          <ChevronDown className="w-2.5 h-2.5 opacity-60" />
                        </button>

                        {activeSpeakerPopoverId === seg.id && voiceMenuAnchor && (
                          <VoiceMenuPopover anchor={voiceMenuAnchor} onClose={() => setActiveSpeakerPopoverId(null)}>
                            <div className="px-2 py-0.5 text-[8.5px] font-bold text-zinc-400 uppercase tracking-wider border-b border-white/5">
                              Switch Character / Voice
                            </div>
                            {savedVoices.length > 0 && <div className="px-2 pt-1 text-[9px] text-purple-300">Saved voices</div>}
                            {savedVoices.map(voice => <button key={voice.id}
                              disabled={isGeneratingAll || isGeneratingAudio}
                              onClick={async () => {
                                try {
                                  await updateSegment(seg.id, { voice_name: voice.id, audio_url: '' });
                                  setSelectedVoiceActor(AUTO_VOICE_ACTOR);
                                  setActiveSpeakerPopoverId(null);
                                } catch { setVoiceLoadError('Unable to assign the saved voice. Try again.'); }
                              }}
                              className="w-full px-2 py-1 rounded-lg hover:bg-white/10 text-purple-200 text-[10.5px] text-left disabled:opacity-40">
                              {seg.voice_name === voice.id ? '✓ ' : '🎙 '}{savedVoiceLabel(voice)}
                            </button>)}
                            {CHARACTER_PRESETS.map((preset) => (
                              <button
                                key={preset.speaker}
                                onClick={() => handleAssignCharacterSingle(seg.id, preset)}
                                className="w-full px-2 py-1 rounded-lg hover:bg-white/10 hover:text-white text-zinc-300 text-[10.5px] font-medium flex items-center gap-2 transition-colors text-left cursor-pointer"
                              >
                                <span className="text-sm leading-none">{preset.avatar}</span>
                                <span className="truncate">{preset.label}</span>
                              </button>
                            ))}
                          </VoiceMenuPopover>
                        )}
                      </div>

                      <span className="font-mono text-[11px] text-zinc-500 shrink-0">
                        {formatTime(seg.start_time)} – {formatTime(seg.end_time)}
                      </span>

                      {/* Emotion Switcher */}
                      {(() => {
                        const emo = getSegmentEmotion(seg);
                        return (
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              const order = ['scream', 'angry', 'fearful', 'whisper', 'happy', 'excited', 'serious', 'calm', 'neutral'];
                              const nextIdx = (order.indexOf(emo.id) + 1) % order.length;
                              const nextEmo = order[nextIdx];
                              await updateSegment(seg.id, { emotion: nextEmo });
                            }}
                            className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium border flex items-center gap-1 transition-all hover:brightness-125 ${emo.color}`}
                            title={`Emotion: ${emo.label} (Click to switch)`}
                          >
                            <span>{emo.emoji}</span>
                            <span>{emo.label}</span>
                          </button>
                        );
                      })()}

                      {/* Voice effect: instant for a dubbed line, remembered for one not yet dubbed */}
                      <label
                        onClick={(e) => e.stopPropagation()}
                        className={`relative text-[10px] px-1.5 py-0.5 rounded-full font-medium border flex items-center gap-1 cursor-pointer ${
                          (seg.voice_fx || 'normal') !== 'normal'
                            ? 'bg-purple-500/15 text-purple-200 border-purple-500/40'
                            : 'bg-white/5 text-zinc-400 border-white/10 hover:text-zinc-200'
                        }`}
                        title="Voice effect for this line"
                      >
                        {fxBusyId === seg.id ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Wand2 className="w-2.5 h-2.5" />}
                        <span>{effectLabel(seg.voice_fx)}</span>
                        <select
                          value={seg.voice_fx || 'normal'}
                          disabled={fxBusyId === seg.id || isGenThis}
                          onChange={(e) => void setLineEffect(seg.id, e.target.value)}
                          className="absolute inset-0 cursor-pointer opacity-0"
                          aria-label="Voice effect"
                        >
                          {VOICE_EFFECT_GROUPS.map(({ group, items }) =>
                            group === 'Normal' ? (
                              items.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)
                            ) : (
                              <optgroup key={group} label={group}>
                                {items.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                              </optgroup>
                            ),
                          )}
                        </select>
                      </label>

                      {/* has it a voice */}
                      {!isGenThis && (seg.audio_url ? (
                        <span className="flex items-center gap-0.5 text-[10px] text-emerald-400/90 shrink-0" title="This line has a voice">
                          <CheckCircle2 className="w-2.5 h-2.5" /> voiced
                        </span>
                      ) : (
                        <span className="text-[10px] text-amber-300/90 shrink-0" title="This line has no voice yet">no voice</span>
                      ))}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {/* Audition / Preview Audio Button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handlePlaySample(seg.text, seg.id);
                        }}
                        disabled={isGenThis}
                        aria-label={isPlayThis ? 'Pause' : 'Listen to this line'}
                        className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors disabled:opacity-40 ${
                          isPlayThis ? 'bg-blue-600 text-white' : 'bg-white/10 hover:bg-white/20 text-zinc-200 hover:text-white'
                        }`}
                        title={isPlayThis ? 'Pause' : seg.audio_url ? 'Play Dubbed Audio' : 'Audition Line'}
                      >
                        {isPlayThis ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                      </button>

                      {/* Dub Line Button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleGenerateSingleLine(seg.id);
                        }}
                        disabled={isGenThis}
                        className={`px-2.5 h-7 rounded-md text-[11px] font-semibold flex items-center gap-1 transition-colors disabled:opacity-50 ${
                          isGenThis
                            ? 'bg-white/10 text-white'
                            : seg.audio_url
                            ? 'text-zinc-400 hover:text-white hover:bg-white/10'
                            : 'bg-blue-600 hover:bg-blue-500 text-white'
                        }`}
                        title={seg.audio_url ? 'Re-generate voice for this line' : 'Generate voice for this line'}
                      >
                        {isGenThis ? (
                          <>
                            <Loader2 className="w-2.5 h-2.5 animate-spin text-white" />
                            <span>Dubbing…</span>
                          </>
                        ) : seg.audio_url ? (
                          <>
                            <RotateCcw className="w-2.5 h-2.5 text-zinc-200" />
                            <span>Dub again</span>
                          </>
                        ) : (
                          <>
                            <Sparkles className="w-2.5 h-2.5 text-zinc-100" />
                            <span>Dub</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Subtitle Dialogue Text or Inline Editor */}
                  {isEditing ? (
                    <div className="space-y-1.5 mt-0.5 pl-1" onClick={(e) => e.stopPropagation()}>
                      <textarea
                        value={editSegText}
                        onChange={(e) => setEditSegText(e.target.value)}
                        rows={2}
                        className="w-full bg-[var(--s1)] border border-white/10 rounded-lg p-2 text-xs text-white font-khmer focus:outline-none leading-relaxed resize-none shadow-inner"
                        autoFocus
                      />
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => setEditingSegId(null)}
                          className="px-2 py-0.5 rounded bg-[var(--s4)] hover:bg-[var(--s5)] text-[11px] text-zinc-300 font-medium"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleSaveEdit(seg.id)}
                          className="px-2.5 py-0.5 rounded bg-white/10 hover:bg-white/10 text-[11px] text-white font-bold"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {/* Spoken Khmer Translation */}
                      <p className={`font-khmer leading-snug ${
                        /hook/i.test(seg.speaker || '') || (seg as any).is_hook
                          ? 'text-sm font-bold text-zinc-100 tracking-wide'
                          : 'text-[13px] text-white'
                      }`}>
                        {seg.text}
                      </p>

                      {/* Subtitle Footer Bar (Original Context & Actions) */}
                      <div className="flex items-center justify-between gap-1.5">
                        <p className="text-[11px] text-zinc-500 truncate font-sans" title={seg.original_text || undefined}>
                          {seg.original_text && seg.original_text.trim() !== seg.text.trim() ? seg.original_text : /hook/i.test(seg.speaker || '') ? 'Opening hook' : ''}
                        </p>

                        <div className="flex items-center gap-0.5 shrink-0 opacity-40 group-hover/card:opacity-100 focus-within:opacity-100 transition-opacity">
                          <span className="text-[10px] text-zinc-600 font-mono mr-1">#{idx + 1}</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCopyText(seg.text, seg.id);
                            }}
                            className="p-1 rounded text-zinc-300 hover:text-white hover:bg-white/10 transition-colors"
                            title="Copy the words"
                          >
                            {copiedId === seg.id ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>

                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStartEdit(seg.id, seg.text);
                            }}
                            className="p-1 rounded text-zinc-300 hover:text-white hover:bg-white/10 transition-colors"
                            title="Edit the words"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>

                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteSegment(seg.id);
                            }}
                            className="p-1 rounded text-zinc-300 hover:text-red-400 hover:bg-white/10 transition-colors"
                            title="Delete this line"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {renderLimit < displayedSegments.length && (
              <div ref={loadMoreRef} className="py-3 text-center text-[11px] text-zinc-500">
                Showing {renderLimit} of {displayedSegments.length} lines — scroll for more
              </div>
            )}
          </div>
        )}
      </div>

      {/* 6. Pinned Bottom Studio Deck (Fit Mode, Speed, Master Dub Button) */}
      <div className="border-t border-[var(--s4)] bg-[rgb(var(--s2-rgb)/0.95)] backdrop-blur-md shrink-0 shadow-2xl">
        {/* Fit Mode Tooltip Drawer */}
        {tooltipMode && (
          <div className="px-4 pt-2 pb-2 border-b border-[var(--s4)]">
            <div className="flex items-start gap-2 text-[11px]">
              <span className="mt-0.5 text-zinc-500 shrink-0">{tooltipMode.icon}</span>
              <div>
                <div className="text-zinc-200">{tooltipMode.title}</div>
                <p className="text-zinc-500 leading-relaxed">{tooltipMode.description}</p>
              </div>
            </div>
          </div>
        )}

        {/* Studio Controls Row (Compact & Sleek) */}
        <div className="px-3 py-2 flex items-center justify-between gap-2 flex-wrap">
          {/* Left: Fit Mode Selector */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-400 font-semibold mr-0.5">Fit Mode</span>
            {(['A', 'B', 'C'] as const).map((mode) => {
              const info = FIT_MODES[mode];
              const isActive = fitMode === mode;
              const isHovered = hoveredFitMode === mode;
              return (
                <button
                  key={mode}
                  onClick={() => setFitMode(mode)}
                  onMouseEnter={() => setHoveredFitMode(mode)}
                  onMouseLeave={() => setHoveredFitMode(null)}
                  className={`w-6 h-6 sm:w-7 sm:h-7 rounded-md text-[10px] sm:text-[11px] font-semibold transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-blue-600 text-white'
                      : isHovered
                      ? 'bg-white/10 text-white'
                      : 'bg-white/5 text-zinc-400 hover:text-white'
                  }`}
                  title={`Mode ${mode}: ${info.title}`}
                >
                  {mode}
                </button>
              );
            })}
          </div>

          {/* Right: Speed Selector & Master Action Buttons */}
          <div className="flex items-center gap-2">
            {/* Speed Selector */}
            <div className="flex items-center gap-1 bg-[var(--s3)] border border-[var(--s5)] hover:border-white/10 rounded-lg px-2 py-0.5 h-7 transition-colors">
              <span className="text-[9.5px] text-zinc-400 font-semibold">Speed</span>
              <select
                value={speechSpeed}
                onChange={(e) => setSpeechSpeed(Number(e.target.value))}
                className="bg-transparent text-[10px] text-white focus:outline-none font-mono font-bold cursor-pointer"
              >
                <option value={0.85} className="bg-[var(--s3)] text-white">0.85x (Slow)</option>
                <option value={1.0} className="bg-[var(--s3)] text-white">1.0x (Normal)</option>
                <option value={1.15} className="bg-[var(--s3)] text-white">1.15x (Brisk)</option>
                <option value={1.25} className="bg-[var(--s3)] text-white">1.25x (Fast)</option>
                <option value={1.35} className="bg-[var(--s3)] text-white">1.35x (Rapid)</option>
              </select>
            </div>

            {/* Action Hero Buttons */}
            {selectedSegmentIds.size > 0 ? (
              <>
                <button
                  onClick={handleGenerateSelectedSpeech}
                  disabled={isGeneratingAll}
                  className="h-7 px-3 rounded-lg bg-white/10 hover:bg-white/10 text-white font-bold text-[11px] shadow-md active:scale-95 transition-all disabled:opacity-40 flex items-center gap-1.5 border border-white/20 cursor-pointer"
                  title="Generate voice for selected segments"
                >
                  {isGeneratingAll ? (
                    <span className="flex items-center gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin text-white" />
                      <span>Synthesizing ({audioGenProgress}/{audioGenTotal || selectedSegmentIds.size})...</span>
                    </span>
                  ) : (
                    <>
                      <Sparkles className="w-3 h-3 text-yellow-300" />
                      <span>Dub Selected ({selectedSegmentIds.size})</span>
                    </>
                  )}
                </button>

                <button
                  onClick={() => handleGenerateAllSpeech(false)}
                  disabled={isGeneratingAll || serverWillDub || displayedSegments.length === 0}
                  className="h-7 px-2.5 rounded-lg bg-[var(--s4)] hover:bg-[var(--s6)] text-zinc-300 hover:text-white font-semibold text-[11px] border border-[var(--s7)] transition-all disabled:opacity-40 cursor-pointer"
                  title={serverWillDub ? `${serverDubLabel} — ${serverJob?.message || 'every line will get a voice'}` : 'Continue dubbing all lines in project'}
                >
                  {serverWillDub ? serverDubLabel : displayedSegments.filter((s) => !s.audio_url).length > 0 && displayedSegments.filter((s) => !s.audio_url).length < displayedSegments.length
                    ? `Continue (${displayedSegments.filter((s) => !s.audio_url).length} left)`
                    : `Dub All (${displayedSegments.length})`}
                </button>
              </>
            ) : (
              <button
                onClick={() => handleGenerateAllSpeech(false)}
                disabled={isGeneratingAll || serverWillDub || displayedSegments.length === 0}
                className="h-7 px-3.5 rounded-lg bg-white/10 to-blue-600 hover:bg-white/10 hover:to-blue-500 text-white font-bold text-[11px] shadow-md active:scale-95 transition-all disabled:opacity-40 flex items-center gap-1.5 border border-white/10 cursor-pointer"
                title={serverWillDub ? `${serverDubLabel} — ${serverJob?.message || 'every line will get a voice'}. The voices appear here as they are made.` : 'Continue voice dubbing for remaining lines'}
              >
                {serverWillDub ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className={`w-3 h-3 text-blue-300 ${serverDubbing ? 'animate-spin' : ''}`} />
                    <span>{serverDubbing && serverJob?.message ? serverJob.message.replace(/^Voiced/, 'Server: voiced') : serverDubLabel}</span>
                  </span>
                ) : isGeneratingAll ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin text-white" />
                    <span>Synthesizing ({audioGenProgress}/{audioGenTotal || displayedSegments.length})...</span>
                  </span>
                ) : (
                  <>
                    <Mic className="w-3 h-3 text-zinc-100" />
                    <span>
                      {selectedCharacterFilter === 'all'
                        ? displayedSegments.filter((s) => !s.audio_url).length > 0 && displayedSegments.filter((s) => !s.audio_url).length < displayedSegments.length
                          ? `Continue Dubbing (${displayedSegments.filter((s) => !s.audio_url).length} left)`
                          : 'Dub All Lines'
                        : displayedSegments.filter((s) => !s.audio_url).length > 0 && displayedSegments.filter((s) => !s.audio_url).length < displayedSegments.length
                        ? `Continue ${selectedCharacterFilter} (${displayedSegments.filter((s) => !s.audio_url).length} left)`
                        : `Dub ${selectedCharacterFilter} (${displayedSegments.length})`}
                    </span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Hook studio lives in the editor's docked side panel. */}
      {hookPanelTarget &&
        createPortal(
            <section className="w-full h-full min-h-0 flex flex-col bg-[var(--s2)] text-zinc-200">
              <header className="flex items-center justify-between border-b border-white/10 px-4 py-3 shrink-0">
                <h2 className="text-sm font-semibold flex items-center gap-2"><Flame className="w-4 h-4 text-blue-300" />Intro Hook</h2>
                <button onClick={() => onCloseHookPanel?.()} aria-label="Close Intro Hook" title="Close (Esc)" className="p-1 hover:bg-white/10 rounded">
                  <X className="w-4 h-4" />
                </button>
              </header>

              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
                <p className="text-xs text-zinc-400">
                  Writes a few opening lines to grab the viewer, from this video’s captions. Pick one and it goes at 0:00 as a caption named “Intro Hook”.
                </p>

                {/* How long */}
                <fieldset disabled={isGeneratingHooks} className="space-y-2">
                  <legend className={hookHeading}>How long</legend>
                  <div className="grid grid-cols-8 gap-1 pt-1">
                    {[3, 4.5, 6, 8, 10, 15, 20, 30].map((sec) => (
                      <button
                        key={sec}
                        type="button"
                        aria-pressed={hookDuration === sec}
                        onClick={() => {
                          setHookDuration(sec);
                          if (generatedHooks.length > 0) handleGenerateHooks(sec, hookTone);
                        }}
                        className={`py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                          hookDuration === sec ? 'bg-blue-600 text-white' : 'bg-[var(--s3)] text-zinc-300 hover:bg-[var(--s4)] border border-[var(--s6)]'
                        }`}
                      >
                        {sec}s
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    {hookDuration > 10
                      ? `A long hook is several lines: the grabber, who it is about, the secret, the conflict, the stakes and a cliffhanger. It narrates over the first ${hookDuration}s, replacing the captions there.`
                      : 'One or two punchy lines, spoken before the story starts.'}
                  </p>
                </fieldset>

                {/* What kind */}
                <fieldset disabled={isGeneratingHooks} className="space-y-2">
                  <legend className={hookHeading}>What kind</legend>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {([['viral', 'Curiosity'], ['suspense', 'Suspense'], ['shocking', 'Shocking'], ['comedy', 'Comedy'], ['emotional', 'Emotional']] as const).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={hookTone === id}
                        onClick={() => {
                          setHookTone(id);
                          if (generatedHooks.length > 0) handleGenerateHooks(hookDuration, id);
                        }}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                          hookTone === id ? 'bg-blue-600 text-white' : 'bg-[var(--s3)] text-zinc-300 hover:bg-[var(--s4)] border border-[var(--s6)]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>

                {/* How it is shown */}
                <fieldset className="space-y-2">
                  <legend className={hookHeading}>Words on screen at once</legend>
                  <div className="flex rounded-lg border border-[var(--s6)] overflow-hidden mt-1" role="radiogroup" aria-label="Words on screen at once">
                    {[[4, '4 words'], [5, '5 words'], [6, '6 words'], [100, 'Whole line']].map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        role="radio"
                        aria-checked={hookWordsLimit === val}
                        onClick={() => setHookWordsLimit(val as number)}
                        className={`flex-1 px-3 py-2 text-xs font-semibold transition-colors cursor-pointer ${
                          hookWordsLimit === val ? 'bg-blue-600 text-white' : 'bg-[var(--s3)] text-zinc-300 hover:bg-[var(--s4)]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    {hookWordsLimit <= 6 ? `The hook is cut into captions of ${hookWordsLimit} words, which reads faster on a phone.` : 'The hook stays as one caption.'}
                  </p>
                </fieldset>

                <button
                  onClick={() => handleGenerateHooks()}
                  disabled={isGeneratingHooks}
                  className="w-full rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-3 py-2.5 text-sm font-semibold text-white flex items-center justify-center gap-2 cursor-pointer"
                >
                  {isGeneratingHooks ? <><Loader2 className="w-4 h-4 animate-spin" /> Writing…</> : generatedHooks.length > 0 ? 'Write new hooks' : 'Write hooks'}
                </button>

                {/* The hooks to choose from */}
                {isGeneratingHooks && generatedHooks.length === 0 ? (
                  <p role="status" className="py-6 text-center text-xs text-zinc-400">Reading the captions and writing a few to choose from…</p>
                ) : generatedHooks.length > 0 && (
                  <div className="space-y-2">
                    <p className={hookHeading}>{generatedHooks.length} to choose from</p>
                    {generatedHooks.map((hook, hIdx) => {
                      const isPreviewing = previewingHookId === (hook.hook_id || `hook-${hIdx}`);
                      const isInserting = insertingHookId === hook.text;
                      const isCopied = copiedId === `hook-${hIdx}`;
                      return (
                        <div key={hook.hook_id || hIdx} className="rounded-xl border border-[var(--s6)] bg-[var(--s3)]/60 p-3 space-y-2.5">
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="text-zinc-400">
                              <span className="font-semibold text-zinc-200">{hook.category_label || hook.category || 'Hook'}</span>
                              {' '}· about {hook.estimated_seconds || hookDuration}s{hook.lines && hook.lines > 1 ? ` · ${hook.lines} lines` : ''}
                            </span>
                            <div className="flex items-center gap-0.5">
                              <button
                                onClick={() => handlePreviewHookTTS(hook.text, hook.hook_id || `hook-${hIdx}`)}
                                title={isPreviewing ? 'Stop' : 'Hear it in the AI voice'}
                                className={`flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer ${isPreviewing ? 'bg-blue-600 text-white' : 'text-zinc-300 hover:text-white hover:bg-white/10'}`}
                              >
                                {isPreviewing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />} {isPreviewing ? 'Stop' : 'Listen'}
                              </button>
                              <button
                                onClick={() => handleCopyText(hook.text, `hook-${hIdx}`)}
                                title="Copy the words"
                                className="flex items-center gap-1 px-2 py-1 rounded-md text-zinc-300 hover:text-white hover:bg-white/10 cursor-pointer"
                              >
                                {isCopied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />} {isCopied ? 'Copied' : 'Copy'}
                              </button>
                            </div>
                          </div>

                          <p className="text-sm text-white font-khmer leading-relaxed select-text">{hook.text}</p>

                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => handleInsertHookSegment(hook, false)}
                              disabled={isInserting}
                              title="Add it at 0:00 as a caption, without a voice yet"
                              className="px-3 py-1.5 rounded-lg border border-[var(--s6)] text-xs font-semibold text-zinc-200 hover:bg-white/10 disabled:opacity-50 cursor-pointer"
                            >
                              Add at 0:00
                            </button>
                            <button
                              onClick={() => handleInsertHookSegment(hook, true)}
                              disabled={isInserting}
                              title="Add it at 0:00 and make its voice now"
                              className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                            >
                              {isInserting ? <><Loader2 className="w-3 h-3 animate-spin" /> Adding…</> : 'Add and dub'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>,
          hookPanelTarget
        )}
    </div>
  );
}
