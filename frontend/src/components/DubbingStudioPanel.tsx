import React, { useState, useRef, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useProjectStore } from '../stores/projectStore';
import { importSrtFile, generateCatchyHooks } from '../api/client';
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
  Languages,
  Users,
  MessageSquare,
  Globe,
  Sliders,
  Filter,
  CheckCircle2,
  Pencil,
  Trash2,
  Square,
  CheckSquare,
  ListChecks,
  Search,
  X,
  Copy,
  Info,
  Clock,
  Music,
  Activity,
  Smile,
  Target,
  Flame,
  Zap,
  Wand2,
} from 'lucide-react';
import type { Segment } from '../types';

interface VoiceActor {
  id: string;
  name: string;
  avatar: string;
  profile: 'female' | 'male' | 'auto';
  tag: string;
  color: string;
}

const VOICE_ACTORS: VoiceActor[] = [
  {
    id: 'auto',
    name: 'Auto-Cast by Character',
    avatar: '🎭',
    profile: 'auto',
    tag: 'Auto Male (Piseth) & Female (Sreymom)',
    color: 'text-purple-400',
  },
  {
    id: 'km-KH-PisethNeural',
    name: 'Piseth (ពិសិដ្ឋ)',
    avatar: '👨‍💼',
    profile: 'male',
    tag: 'Warm & Confident · Male (Khmer)',
    color: 'text-blue-400',
  },
  {
    id: 'km-KH-SreymomNeural',
    name: 'Sreymom (ស្រីមុំ)',
    avatar: '👩‍💼',
    profile: 'female',
    tag: 'Clear & Expressive · Female (Khmer)',
    color: 'text-pink-400',
  },
  {
    id: 'en-US-AndrewMultilingualNeural',
    name: 'Andrew (Multi)',
    avatar: '🎙️',
    profile: 'male',
    tag: 'Modern Host · Male',
    color: 'text-amber-400',
  },
  {
    id: 'en-US-AvaMultilingualNeural',
    name: 'Ava (Multi)',
    avatar: '✨',
    profile: 'female',
    tag: 'Expressive & Melodious · Female',
    color: 'text-teal-400',
  },
  {
    id: 'en-US-BrianMultilingualNeural',
    name: 'Brian (Multi)',
    avatar: '👔',
    profile: 'male',
    tag: 'Authoritative & Calm · Male',
    color: 'text-indigo-400',
  },
  {
    id: 'en-US-EmmaMultilingualNeural',
    name: 'Emma (Multi)',
    avatar: '🎀',
    profile: 'female',
    tag: 'Gentle Storyteller · Female',
    color: 'text-rose-400',
  },
  {
    id: 'en-US-SeraphinaMultilingualNeural',
    name: 'Seraphina (Multi)',
    avatar: '🌟',
    profile: 'female',
    tag: 'Cinematic & Dramatic · Female',
    color: 'text-purple-400',
  },
];

type FitMode = 'A' | 'B' | 'C';

interface FitModeInfo {
  label: string;
  title: string;
  description: string;
  detail: string;
  icon: React.ReactNode;
  color: string;
  example: string;
}

const FIT_MODES: Record<FitMode, FitModeInfo> = {
  B: {
    label: 'B',
    title: 'Sync Video Speed (Recommended)',
    description: 'Automatically speed up voice to match fast video dialogue.',
    detail: 'Dynamically accelerates speech tempo with pristine pitch preservation so the voice finishes speaking right with the actor.',
    icon: <AlignJustify className="w-3.5 h-3.5" />,
    color: 'from-orange-500 to-amber-500',
    example: '⚡ Dynamic Speed Matching (Video Pace Fit)',
  },
  A: {
    label: 'A',
    title: 'Natural Length',
    description: 'Natural length — audio plays at standard speed.',
    detail: 'Keeps speech at 100% natural conversational speed across available pauses.',
    icon: <AlignLeft className="w-3.5 h-3.5" />,
    color: 'from-blue-500 to-violet-500',
    example: '⏱ Natural speech pace',
  },
  C: {
    label: 'C',
    title: 'Extend Video',
    description: 'Keep audio natural and extend the video underneath.',
    detail: 'Speech plays at natural pace, while video frame underneath extends or freezes to fit.',
    icon: <AlignCenter className="w-3.5 h-3.5" />,
    color: 'from-indigo-500 to-purple-500',
    example: '⏱ Natural voice + extended video frame',
  },
};

const EMOTIONS_LIST = [
  { id: 'crying', label: 'Crying / Weeping', emoji: '😭', color: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
  { id: 'laughing', label: 'Laughing / Haha', emoji: '😂', color: 'bg-pink-500/20 text-pink-300 border-pink-500/40' },
  { id: 'scream', label: 'Scream / Shout', emoji: '📢', color: 'bg-red-500/20 text-red-300 border-red-500/40' },
  { id: 'angry', label: 'Angry', emoji: '😡', color: 'bg-orange-500/20 text-orange-300 border-orange-500/40' },
  { id: 'fearful', label: 'Fearful', emoji: '😰', color: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
  { id: 'whisper', label: 'Whisper', emoji: '🤫', color: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40' },
  { id: 'happy', label: 'Happy', emoji: '😊', color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
  { id: 'excited', label: 'Excited', emoji: '⚡', color: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40' },
  { id: 'serious', label: 'Serious', emoji: '🧐', color: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
  { id: 'calm', label: 'Calm', emoji: '😌', color: 'bg-teal-500/20 text-teal-300 border-teal-500/40' },
  { id: 'sad', label: 'Sad', emoji: '😢', color: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40' },
  { id: 'neutral', label: 'Neutral', emoji: '😐', color: 'bg-zinc-800 text-zinc-400 border-zinc-700' },
];

export default function DubbingStudioPanel() {
  const {
    currentProject,
    loadProject,
    addSegment,
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
    currentTime,
    setCurrentTime,
    isPlaying,
    videoClips,
  } = useProjectStore();

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

  const segments = (currentProject?.segments || []).filter(
    (s) => s.speaker !== 'Freeze' && s.voice_profile !== 'freeze' && !s.text.includes('Freeze Frame')
  );

  const [selectedVoiceActor, setSelectedVoiceActor] = useState<VoiceActor>(VOICE_ACTORS[0]);
  const [fitMode, setFitMode] = useState<FitMode>('B');
  const [hoveredFitMode, setHoveredFitMode] = useState<FitMode | null>(null);
  const [selectedCharacterFilter, setSelectedCharacterFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'dubbed' | 'undubbed'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [speechSpeed, setSpeechSpeed] = useState<number>(1.0);

  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const [generatingSegmentId, setGeneratingSegmentId] = useState<string | null>(null);
  const [playingSegmentId, setPlayingSegmentId] = useState<string | null>(null);

  // Catchy Hook Generator State
  const [showHookModal, setShowHookModal] = useState(false);
  const [hookDuration, setHookDuration] = useState<number>(4.0);
  const [hookTone, setHookTone] = useState<string>('viral');
  const [isGeneratingHooks, setIsGeneratingHooks] = useState(false);
  const [generatedHooks, setGeneratedHooks] = useState<
    Array<{
      hook_id: string;
      text: string;
      category: string;
      category_label: string;
      estimated_seconds: number;
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

  const [showVoiceDropdown, setShowVoiceDropdown] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [activeSpeakerPopoverId, setActiveSpeakerPopoverId] = useState<string | null>(null);
  const [showBatchSpeakerMenu, setShowBatchSpeakerMenu] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

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

  // Auto-scroll to selected segment when clicked from timeline or active in project (only when not playing)
  useEffect(() => {
    if (activeSegmentId && !isPlaying) {
      const el = document.getElementById(`dub-seg-${activeSegmentId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'auto', block: 'nearest' });
      }
    }
  }, [activeSegmentId, isPlaying]);

  // Auto-scroll to currently dubbing segment
  useEffect(() => {
    if (activeGeneratingSegmentId) {
      const el = document.getElementById(`dub-seg-${activeGeneratingSegmentId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'auto', block: 'nearest' });
      }
    }
  }, [activeGeneratingSegmentId]);

  // Close hook modal on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showHookModal) {
        setShowHookModal(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showHookModal]);

  // Extract unique character list
  const characters = useMemo(() => {
    const set = new Set<string>();
    segments.forEach((s) => {
      if (s.speaker && s.speaker.trim()) set.add(s.speaker.trim());
    });
    return Array.from(set);
  }, [segments]);

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
    if (selectedSegmentIds.size === displayedSegments.length) {
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

  const handleBatchAssignCharacter = async (preset: typeof CHARACTER_PRESETS[0]) => {
    const ids = Array.from(selectedSegmentIds);
    for (const id of ids) {
      await updateSegment(id, {
        speaker: preset.speaker,
        gender: preset.gender,
        voice_profile: preset.voice_profile,
        voice_name: preset.voice_name,
      });
    }
    setShowBatchSpeakerMenu(false);
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

  const handleGenerateSelectedSpeech = async () => {
    if (!currentProject?.id || selectedSegmentIds.size === 0) return;
    setIsGeneratingAll(true);
    try {
      const voiceParam = selectedVoiceActor.id === 'auto' ? undefined : selectedVoiceActor.id;
      await generateVoiceForSegments(Array.from(selectedSegmentIds), speechSpeed, fitMode, voiceParam, undefined, false);
      await loadProject(currentProject.id);
    } catch (e) {
      console.error(e);
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
      await loadProject(currentProject.id);
    } catch (e) {
      console.error(e);
    } finally {
      setIsGeneratingAll(false);
    }
  };

  const handleGenerateSingleLine = async (segId: string) => {
    if (!currentProject?.id || !segId) return;
    setGeneratingSegmentId(segId);
    try {
      const voiceParam = selectedVoiceActor.id === 'auto' ? undefined : selectedVoiceActor.id;
      await generateVoiceForSegments([segId], speechSpeed, fitMode, voiceParam, undefined, false);
      await loadProject(currentProject.id);
    } catch (e) {
      console.error(e);
    } finally {
      setGeneratingSegmentId(null);
    }
  };

  const getSegmentEmotion = (seg: { emotion?: string; text: string }) => {
    if (seg.emotion && seg.emotion !== 'neutral') {
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
    if (seg?.audio_url) {
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

  const handleImportSrt = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProject?.id) return;
    try {
      await importSrtFile(currentProject.id, file);
      await loadProject(currentProject.id);
    } catch (err) {
      console.error(err);
    }
  };

  const handleGenerateHooks = async () => {
    if (!currentProject?.id) return;
    setIsGeneratingHooks(true);
    try {
      const hooks = await generateCatchyHooks(currentProject.id, {
        originalTitle: currentProject.name,
        language: currentProject.language || 'km',
        durationSeconds: hookDuration,
        tone: hookTone,
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
      const voiceParam = selectedVoiceActor.id === 'auto' ? 'male' : selectedVoiceActor.id;
      const res = await fetch(`/api/tts/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voice: voiceParam,
          speed: speechSpeed,
          language: currentProject?.language || 'km',
        }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
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
    setInsertingHookId(hook.text);
    try {
      const newSeg = {
        start_time: 0.0,
        end_time: dur,
        text: hook.text,
        speaker: 'Intro Hook (អ្នករៀបរាប់)',
        voice_profile: 'male',
        emotion: 'excited',
      };
      await addSegment(newSeg);
      await loadProject(currentProject.id);

      // Auto-close modal immediately so the user returns to their project
      setShowHookModal(false);
      setHookToast(dubNow ? '⚡ Intro Hook inserted at 0:00 and dubbed!' : '✨ Intro Hook inserted at 0:00!');
      setTimeout(() => setHookToast(null), 4000);

      if (dubNow) {
        const fresh = useProjectStore.getState().currentProject?.segments || [];
        const target = fresh.find((s) => s.start_time === 0.0 && s.text === hook.text);
        if (target) {
          const voiceParam = selectedVoiceActor.id === 'auto' ? undefined : selectedVoiceActor.id;
          await generateVoiceForSegments([target.id], speechSpeed, fitMode, voiceParam, undefined, false);
          await loadProject(currentProject.id);
        }
      }
    } catch (err) {
      console.error('Insert hook failed:', err);
      setShowHookModal(false);
    } finally {
      setInsertingHookId(null);
    }
  };

  const tooltipMode = hoveredFitMode ? FIT_MODES[hoveredFitMode] : null;

  return (
    <div className="flex flex-col h-full bg-[#0d0f14] text-[#e1e4ea] select-none font-sans overflow-hidden">
      {/* Hidden File Input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".srt,.ass,.vtt"
        className="hidden"
        onChange={handleImportSrt}
      />

      {/* Toast Notification for Hook Insert / Actions */}
      {hookToast && (
        <div className="mx-4 mt-2 px-3.5 py-2 rounded-xl bg-gradient-to-r from-pink-950/90 to-purple-950/90 border border-pink-500/50 text-pink-200 text-xs font-semibold flex items-center justify-between shadow-lg shadow-pink-950/50 animate-in fade-in slide-in-from-top-2 shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-pink-300 animate-spin" style={{ animationDuration: '3s' }} />
            <span>{hookToast}</span>
          </div>
          <button onClick={() => setHookToast(null)} className="text-zinc-400 hover:text-white cursor-pointer ml-2">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 1. Header Bar with Stats & Voice Selector */}
      <div className="px-4 py-3 border-b border-[#1b1f2b] bg-[#12151e]/95 backdrop-blur-md flex items-center justify-between gap-3 shrink-0 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-2xl bg-gradient-to-tr from-purple-600 via-pink-600 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-purple-950/60 ring-1 ring-white/20">
            <Mic className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-bold text-white tracking-wide flex items-center gap-1.5">
                <span>AI Dubbing Studio</span>
                <span className="text-[9px] px-1.5 py-0.2 rounded-md bg-purple-500/20 text-purple-300 border border-purple-500/30 font-bold uppercase font-mono">
                  Neural Studio
                </span>
              </h3>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-zinc-400 mt-0.5">
              <span className="text-emerald-400 font-semibold font-mono">
                {dubbedCount} / {segments.length} Dubbed ({segments.length > 0 ? Math.round((dubbedCount / segments.length) * 100) : 0}%)
              </span>
              <span>•</span>
              <span>{characters.length} Voice Characters</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Catchy Intro Hook Generator Button */}
          <button
            onClick={() => {
              setShowHookModal(true);
              if (generatedHooks.length === 0 && !isGeneratingHooks) {
                handleGenerateHooks();
              }
            }}
            className="h-8 flex items-center gap-1.5 px-2.5 rounded-xl bg-pink-500/15 hover:bg-pink-500/25 border border-pink-500/30 hover:border-pink-400 text-pink-200 hover:text-white text-xs font-semibold shadow-xs transition-all active:scale-95 cursor-pointer shrink-0"
            title="Generate catchy Intro Hook voiceover before dubbing (First 3-8 seconds)"
          >
            <Flame className="w-3.5 h-3.5 text-pink-400 shrink-0" />
            <span>Intro Hook</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-pink-500/30 text-pink-300 font-mono font-bold">3-8s</span>
          </button>

          {/* Voice Actor Selector */}
          <div className="relative">
            <button
              onClick={() => setShowVoiceDropdown(!showVoiceDropdown)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[#181c26] border border-[#272d3d] hover:border-purple-500/60 text-xs font-semibold text-white shadow-sm transition-all hover:bg-[#1f2432]"
            >
              <span className="text-sm">{selectedVoiceActor.avatar}</span>
              <span className="truncate max-w-[130px] font-medium">{selectedVoiceActor.name}</span>
              <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
            </button>

            {showVoiceDropdown && (
              <div className="absolute top-full right-0 mt-1.5 w-72 bg-[#181c26] border border-[#2b3244] rounded-2xl shadow-2xl py-1.5 z-50 divide-y divide-[#222838] animate-in fade-in">
                <div className="px-3.5 py-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center justify-between">
                  <span>Neural Voice Selection</span>
                  <span className="text-[9px] text-purple-400 font-mono">High Quality</span>
                </div>
                <div className="py-1 max-h-72 overflow-y-auto">
                  {VOICE_ACTORS.map((v) => (
                    <button
                      key={v.id}
                      onClick={() => {
                        setSelectedVoiceActor(v);
                        setShowVoiceDropdown(false);
                      }}
                      className={`w-full px-3.5 py-2.5 text-left text-xs flex items-center justify-between hover:bg-[#222838] transition-colors ${
                        selectedVoiceActor.id === v.id ? 'bg-[#222838] text-white font-bold' : 'text-zinc-300'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="text-lg">{v.avatar}</span>
                        <div className="min-w-0">
                          <div className="font-semibold text-xs text-white truncate">{v.name}</div>
                          <div className="text-[10px] text-zinc-400 truncate">{v.tag}</div>
                        </div>
                      </div>
                      {selectedVoiceActor.id === v.id && <Check className="w-3.5 h-3.5 text-purple-400 shrink-0 ml-2" />}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 2. Character Cast Ribbon */}
      {characters.length > 0 && (
        <div className="px-4 py-2 bg-[#11141c] border-b border-[#1b1f2b] flex items-center gap-1.5 overflow-x-auto shrink-0 no-scrollbar">
          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mr-1 flex items-center gap-1">
            <Users className="w-3 h-3 text-zinc-500" />
            Cast:
          </span>

          <button
            onClick={() => setSelectedCharacterFilter('all')}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${
              selectedCharacterFilter === 'all'
                ? 'bg-purple-600 text-white shadow-sm shadow-purple-950/40 ring-1 ring-white/20'
                : 'bg-[#181c26] text-zinc-400 hover:text-zinc-200 border border-[#262c3b]'
            }`}
          >
            All Characters ({segments.length})
          </button>

          {characters.map((char) => {
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

            return (
              <button
                key={char}
                onClick={() => setSelectedCharacterFilter(char)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold whitespace-nowrap flex items-center gap-1.5 transition-all ${
                  selectedCharacterFilter === char
                    ? isFemale
                      ? 'bg-pink-600 text-white shadow-sm ring-1 ring-white/20'
                      : isMale
                      ? 'bg-blue-600 text-white shadow-sm ring-1 ring-white/20'
                      : 'bg-purple-600 text-white shadow-sm ring-1 ring-white/20'
                    : 'bg-[#181c26] text-zinc-400 hover:text-zinc-200 border border-[#262c3b]'
                }`}
              >
                <span>{avatar}</span>
                <span>{char}</span>
                <span className="text-[10px] opacity-75 font-mono">({count})</span>
              </button>
            );
          })}
        </div>
      )}

      {/* 3. Search & Quick Filters Bar */}
      {segments.length > 0 && (
        <div className="px-4 py-2 bg-[#12151d] border-b border-[#1b1f2b] flex items-center justify-between gap-2 shrink-0">
          {/* Search Input */}
          <div className="relative flex-1 flex items-center">
            <Search className="w-3.5 h-3.5 absolute left-2.5 text-zinc-500 pointer-events-none" />
            <input
              type="text"
              placeholder="Search dialogue or character..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-7 py-1 rounded-lg bg-[#181b24] border border-[#252b3a] text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-purple-500/60 transition-all font-sans"
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
          <div className="flex items-center gap-1 bg-[#181b24] p-0.5 rounded-lg border border-[#252b3a] shrink-0 text-[11px]">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-2 py-0.5 rounded-md font-medium transition-all ${
                statusFilter === 'all' ? 'bg-[#252b3a] text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
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
              Undubbed ({segments.length - dubbedCount})
            </button>
          </div>
        </div>
      )}

      {/* 4. Multi-Select Batch Action Toolbar */}
      {displayedSegments.length > 0 && (
        <div className="px-4 py-2 bg-[#141722] border-b border-[#1f2433] flex items-center justify-between gap-2 shrink-0 text-xs shadow-inner">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={handleSelectAll}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#1b202e] hover:bg-[#252c3f] text-zinc-300 hover:text-white border border-[#2b3347] transition-colors text-[11px] font-semibold"
            >
              <CheckSquare className="w-3.5 h-3.5 text-purple-400" />
              <span>
                {selectedSegmentIds.size === displayedSegments.length
                  ? 'Deselect All'
                  : `Select All (${displayedSegments.length})`}
              </span>
            </button>

            <button
              onClick={handleSelectUndubbed}
              className="px-2.5 py-1 rounded-lg bg-[#1b202e] hover:bg-[#252c3f] text-zinc-400 hover:text-zinc-200 border border-[#2b3347] transition-colors text-[11px]"
            >
              Select Undubbed
            </button>

            {selectedSegmentIds.size > 0 && (
              <button
                onClick={handleClearSelection}
                className="px-2 py-1 rounded-lg text-zinc-500 hover:text-zinc-300 transition-colors text-[11px]"
              >
                Clear Selection
              </button>
            )}
          </div>

          {selectedSegmentIds.size > 0 && (
            <div className="flex items-center gap-2 animate-in fade-in relative">
              <span className="text-[11px] font-bold text-purple-300 font-mono bg-purple-500/20 px-2.5 py-0.5 rounded-full border border-purple-500/40 shadow-sm">
                {selectedSegmentIds.size} Selected
              </span>

              {/* Batch Character Assign Dropdown */}
              <div className="relative">
                <button
                  onClick={() => setShowBatchSpeakerMenu(!showBatchSpeakerMenu)}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-[#1e2335] hover:bg-[#2a324b] text-zinc-200 hover:text-white border border-[#343f5d] text-xs font-semibold transition-all cursor-pointer"
                  title="Assign voice character to all selected lines"
                >
                  <Users className="w-3.5 h-3.5 text-pink-400" />
                  <span>Assign Character</span>
                  <ChevronDown className="w-3 h-3 text-zinc-400" />
                </button>

                {showBatchSpeakerMenu && (
                  <div className="absolute right-0 top-full mt-1.5 w-56 bg-[#161a27] border border-[#2b334a] rounded-xl shadow-2xl p-1.5 z-50 space-y-1 animate-in fade-in zoom-in-95">
                    <div className="px-2.5 py-1 text-[10px] font-bold text-zinc-400 uppercase tracking-wider border-b border-white/5">
                      Batch Assign ({selectedSegmentIds.size} lines)
                    </div>
                    {CHARACTER_PRESETS.map((preset) => (
                      <button
                        key={preset.speaker}
                        onClick={() => handleBatchAssignCharacter(preset)}
                        className="w-full px-2.5 py-1.5 rounded-lg hover:bg-purple-600/30 hover:text-white text-zinc-300 text-xs font-medium flex items-center gap-2 transition-colors text-left cursor-pointer"
                      >
                        <span className="text-base leading-none">{preset.avatar}</span>
                        <div className="flex-1 truncate">
                          <div>{preset.label}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button
                onClick={handleGenerateSelectedSpeech}
                disabled={isGeneratingAll}
                className="flex items-center gap-1.5 px-3.5 py-1 rounded-lg bg-gradient-to-r from-purple-600 via-pink-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold text-xs shadow-md shadow-purple-950/50 transition-all active:scale-95 disabled:opacity-50 border border-white/20 cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5 text-yellow-300" />
                <span>Dub Selected ({selectedSegmentIds.size})</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* 5. Main Dialogue Segments Scroll Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-[#0a0c10]">
        {/* Progress Banner During Audio Synthesis */}
        {(isGeneratingAll || isGeneratingAudio) && (
          <div className="p-4 rounded-2xl bg-gradient-to-r from-[#141b2c] to-[#1e1733] border border-purple-500/40 shadow-2xl shadow-purple-950/50 flex flex-col gap-2.5 animate-in fade-in">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-purple-600/30 border border-purple-500/40 flex items-center justify-center text-purple-300 shadow-inner">
                  <Volume2 className="w-4 h-4 animate-pulse text-purple-400" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                    <span>Synthesizing Voice Track (Mode {fitMode})</span>
                  </h4>
                  <p className="text-[11px] text-purple-200/80 leading-tight">
                    {audioGenTotal > 0
                      ? `Dubbed line ${audioGenProgress} of ${audioGenTotal}...`
                      : 'Generating natural emotional speech & audio waveform timing...'}
                  </p>
                </div>
              </div>
              <Loader2 className="w-4 h-4 animate-spin text-purple-400 shrink-0" />
            </div>

            {/* Progress Bar */}
            <div className="w-full h-2 bg-black/50 rounded-full overflow-hidden border border-white/5">
              <div
                className="h-full bg-gradient-to-r from-purple-500 via-pink-500 to-indigo-400 rounded-full transition-all duration-300 shadow-lg shadow-purple-500/50"
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
            <div className="w-14 h-14 rounded-2xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 mb-1">
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
                      ? 'bg-[#1f162e] border-purple-500/60 text-white shadow-purple-950/40 min-w-[210px]'
                      : 'bg-purple-600 hover:bg-purple-500 border-purple-500/40 text-white shadow-purple-600/30'
                  }`}
                >
                  {isTranscribing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-purple-200" />
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
                  className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#1a1c22] hover:bg-[#24272f] border border-[#2d303b] text-zinc-300 hover:text-white font-semibold text-xs transition-colors"
                >
                  <UploadCloud className="w-4 h-4" />
                  <span>Import .SRT File</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {displayedSegments.map((seg, idx) => {
              const isGenThis = isGeneratingAudio
                ? activeGeneratingSegmentId === seg.id
                : generatingSegmentId === seg.id;
              const isPlayThis = playingSegmentId === seg.id;
              const isEditing = editingSegId === seg.id;
              const isActive = activeSegmentId === seg.id;
              const isSelected = selectedSegmentIds.has(seg.id);
              const isFemale =
                seg.voice_profile === 'female' ||
                seg.voice_profile === 'grandma' ||
                seg.voice_profile === 'child_girl' ||
                seg.gender === 'female' ||
                Boolean(seg.speaker && /woman|girl|female|ស្រី|កញ្ញា|លោកស្រី/i.test(seg.speaker));
              const isMale =
                seg.voice_profile === 'male' ||
                seg.voice_profile === 'grandpa' ||
                seg.voice_profile === 'child_boy' ||
                seg.gender === 'male' ||
                Boolean(seg.speaker && /man|boy|male|ប្រុស/i.test(seg.speaker));

              const charAvatar =
                seg.voice_profile === 'grandpa' ? '👴' :
                seg.voice_profile === 'grandma' ? '👵' :
                seg.voice_profile === 'child_boy' ? '👦' :
                seg.voice_profile === 'child_girl' ? '👧' :
                /narrator|អ្នករៀបរាប់/i.test(seg.speaker || '') ? '🎙️' :
                isFemale ? '👩' : isMale ? '👨' : '🎭';

              return (
                <div
                  id={`dub-seg-${seg.id}`}
                  key={seg.id}
                  onClick={() => seekToSegment(seg)}
                  className={`border rounded-2xl p-4 space-y-3 transition-all shadow-sm relative cursor-pointer group/card ${
                    isGenThis
                      ? 'border-purple-500 bg-[#1c1630] ring-2 ring-purple-500/50 shadow-xl shadow-purple-950/50'
                      : isSelected
                      ? 'bg-[#1a162b] border-purple-500/90 ring-1 ring-purple-500/40 shadow-lg shadow-purple-950/30'
                      : isActive
                      ? 'bg-[#1b172a] border-purple-500/80 ring-2 ring-purple-500/40 shadow-lg shadow-purple-950/30'
                      : seg.audio_url
                      ? 'bg-[#12151e] border-[#222838] hover:border-purple-500/50 hover:bg-[#161a26]'
                      : 'bg-[#12151e] border-[#1d2230] hover:border-zinc-700 hover:bg-[#161a26]'
                  }`}
                >
                  {/* Left Accent Bar */}
                  <div
                    className={`absolute left-0 top-3 bottom-3 w-1 rounded-r transition-all ${
                      isActive
                        ? 'bg-purple-500 shadow-md shadow-purple-500/50'
                        : isFemale
                        ? 'bg-pink-500/50 group-hover/card:bg-pink-500'
                        : isMale
                        ? 'bg-blue-500/50 group-hover/card:bg-blue-500'
                        : 'bg-purple-500/30 group-hover/card:bg-purple-500'
                    }`}
                  />

                  {/* Top Meta Bar */}
                  <div className="flex items-center justify-between gap-2 pl-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* Checkbox Selector */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelectSegment(seg.id, idx, e.shiftKey);
                        }}
                        className={`w-4 h-4 rounded flex items-center justify-center transition-all ${
                          isSelected
                            ? 'bg-purple-600 text-white shadow-sm ring-1 ring-purple-400/60'
                            : 'border border-[#343b4e] bg-[#171b26] hover:border-purple-400 text-transparent'
                        }`}
                        title="Select line (Hold Shift for multi-select range)"
                      >
                        <Check className="w-3 h-3 stroke-[3]" />
                      </button>

                      <span className="text-[10px] font-bold text-zinc-500 font-mono">#{idx + 1}</span>

                      {/* Time Range */}
                      <span className="text-[10px] font-mono text-zinc-400 bg-black/30 px-2 py-0.5 rounded-md border border-white/5 flex items-center gap-1">
                        <Clock className="w-2.5 h-2.5 text-zinc-500" />
                        <span>{formatTime(seg.start_time)} → {formatTime(seg.end_time)}</span>
                      </span>

                      {/* Interactive Speaker / Character Switcher Badge */}
                      <div className="relative">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveSpeakerPopoverId(activeSpeakerPopoverId === seg.id ? null : seg.id);
                          }}
                          className={`text-[10px] px-2 py-0.5 rounded-full font-bold border flex items-center gap-1 transition-all hover:scale-105 active:scale-95 cursor-pointer ${
                            isFemale
                              ? 'bg-pink-500/15 text-pink-300 border-pink-500/30 hover:bg-pink-500/25'
                              : isMale
                              ? 'bg-blue-500/15 text-blue-300 border-blue-500/30 hover:bg-blue-500/25'
                              : 'bg-purple-500/15 text-purple-300 border-purple-500/30 hover:bg-purple-500/25'
                          }`}
                          title="Click to change character & voice"
                        >
                          <span>{charAvatar}</span>
                          <span>{seg.speaker || (isMale ? 'តួអង្គប្រុស' : 'តួអង្គស្រី')}</span>
                          <ChevronDown className="w-2.5 h-2.5 opacity-60" />
                        </button>

                        {activeSpeakerPopoverId === seg.id && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            className="absolute left-0 top-full mt-1 w-52 bg-[#161a27] border border-[#2b334a] rounded-xl shadow-2xl p-1.5 z-50 space-y-0.5 animate-in fade-in zoom-in-95"
                          >
                            <div className="px-2 py-1 text-[9px] font-bold text-zinc-400 uppercase tracking-wider border-b border-white/5">
                              Switch Character / Voice
                            </div>
                            {CHARACTER_PRESETS.map((preset) => (
                              <button
                                key={preset.speaker}
                                onClick={() => handleAssignCharacterSingle(seg.id, preset)}
                                className="w-full px-2 py-1 rounded-lg hover:bg-purple-600/30 hover:text-white text-zinc-300 text-[11px] font-medium flex items-center gap-2 transition-colors text-left cursor-pointer"
                              >
                                <span className="text-sm leading-none">{preset.avatar}</span>
                                <span className="truncate">{preset.label}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

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
                            className={`text-[9px] px-2 py-0.5 rounded-full font-semibold border flex items-center gap-1 transition-all active:scale-95 hover:brightness-125 ${emo.color}`}
                            title={`Emotion: ${emo.label} (Click to switch)`}
                          >
                            <span>{emo.emoji}</span>
                            <span>{emo.label}</span>
                          </button>
                        );
                      })()}

                      {/* Dubbed Status Badge */}
                      {seg.audio_url && !isGenThis && (
                        <span className="text-[9px] px-2 py-0.5 rounded-full font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1 animate-in fade-in duration-200">
                          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                          <span>Dubbed</span>
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {/* Audition / Preview Audio Button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handlePlaySample(seg.text, seg.id);
                        }}
                        disabled={isGenThis}
                        className={`p-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all disabled:opacity-40 ${
                          isPlayThis
                            ? 'bg-purple-600 text-white shadow-sm'
                            : 'bg-[#1a1e2a] hover:bg-[#252b3c] text-zinc-300 hover:text-white border border-[#2b3346]'
                        }`}
                        title={isPlayThis ? 'Pause' : seg.audio_url ? 'Play Dubbed Audio' : 'Audition Line'}
                      >
                        {isPlayThis ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                      </button>

                      {/* Dub Line Button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleGenerateSingleLine(seg.id);
                        }}
                        disabled={isGenThis}
                        className={`px-3 py-1 rounded-lg text-[11px] font-bold text-white flex items-center gap-1.5 transition-all disabled:opacity-50 ${
                          isGenThis
                            ? 'bg-purple-600 border border-purple-400/50 shadow-md shadow-purple-950/40'
                            : seg.audio_url
                            ? 'bg-[#1b202e] hover:bg-[#252c3f] text-zinc-200 hover:text-white border border-[#313a50]'
                            : 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 shadow-md shadow-purple-950/40'
                        }`}
                        title={seg.audio_url ? 'Re-generate voice for this line' : 'Generate voice for this line'}
                      >
                        {isGenThis ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin text-white" />
                            <span>Dubbing...</span>
                          </>
                        ) : seg.audio_url ? (
                          <>
                            <RotateCcw className="w-3 h-3 text-purple-300" />
                            <span>Re-Dub</span>
                          </>
                        ) : (
                          <>
                            <Sparkles className="w-3 h-3 text-purple-200" />
                            <span>Dub</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Subtitle Dialogue Text or Inline Editor */}
                  {isEditing ? (
                    <div className="space-y-2 mt-1 pl-1" onClick={(e) => e.stopPropagation()}>
                      <textarea
                        value={editSegText}
                        onChange={(e) => setEditSegText(e.target.value)}
                        rows={2}
                        className="w-full bg-[#0a0c10] border border-purple-500/80 rounded-xl p-3 text-xs text-white font-khmer focus:outline-none leading-relaxed resize-none shadow-inner"
                        autoFocus
                      />
                      <div className="flex justify-end gap-1.5">
                        <button
                          onClick={() => setEditingSegId(null)}
                          className="px-3 py-1 rounded-lg bg-[#1a1e2b] hover:bg-[#242a3c] text-xs text-zinc-300 font-medium"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleSaveEdit(seg.id)}
                          className="px-3 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-xs text-white font-bold"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1.5 pl-1">
                      {/* Spoken Khmer Translation */}
                      <p className={`font-khmer leading-relaxed ${
                        /hook/i.test(seg.speaker || '') || (seg as any).is_hook
                          ? 'text-base font-bold text-pink-200 tracking-wide'
                          : 'text-sm font-semibold text-zinc-100'
                      }`}>
                        {seg.text}
                      </p>

                      {/* Original Subtitle Context & Actions */}
                      {seg.original_text && (
                        <div className="flex items-center justify-between gap-2 pt-1 border-t border-white/5">
                          <p className="text-[11px] text-zinc-500 italic truncate font-sans">
                            orig: "{seg.original_text}"
                          </p>

                          <div className="flex items-center gap-1 shrink-0 opacity-60 group-hover/card:opacity-100 transition-opacity">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCopyText(seg.text, seg.id);
                              }}
                              className="p-1 text-zinc-500 hover:text-zinc-200 transition-colors"
                              title="Copy dialogue"
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
                              className="p-1 text-zinc-500 hover:text-zinc-200 transition-colors"
                              title="Edit line"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>

                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteSegment(seg.id);
                              }}
                              className="p-1 text-zinc-500 hover:text-red-400 transition-colors"
                              title="Delete line"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 6. Pinned Bottom Studio Deck (Fit Mode, Speed, Master Dub Button) */}
      <div className="border-t border-[#1b1f2b] bg-[#12151e]/95 backdrop-blur-md shrink-0 shadow-2xl">
        {/* Fit Mode Tooltip Drawer */}
        {tooltipMode && (
          <div className="px-4 pt-3 pb-2 border-b border-[#1b1f2b] animate-in fade-in slide-in-from-bottom-1 duration-150">
            <div
              className={`rounded-xl p-3 bg-gradient-to-r ${tooltipMode.color} bg-opacity-10 border border-white/10 backdrop-blur-sm`}
              style={{
                background: 'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.02) 100%)',
                borderColor: 'rgba(255,255,255,0.08)',
              }}
            >
              <div className="flex items-start gap-2.5">
                <div className={`mt-0.5 p-1.5 rounded-lg bg-gradient-to-br ${tooltipMode.color} text-white shrink-0`}>
                  {tooltipMode.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className={`text-[11px] font-black bg-gradient-to-r ${tooltipMode.color} bg-clip-text text-transparent`}>
                      Mode {tooltipMode.label} — {tooltipMode.title}
                    </span>
                  </div>
                  <p className="text-[10px] text-zinc-300 leading-relaxed">{tooltipMode.description}</p>
                  <p className="text-[10px] text-zinc-500 leading-relaxed mt-1">{tooltipMode.detail}</p>
                  <div className="mt-1.5 px-2 py-1 rounded-lg bg-white/5 border border-white/5 inline-block">
                    <span className="text-[10px] font-mono text-zinc-400">{tooltipMode.example}</span>
                  </div>
                </div>
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
                  className={`relative w-6 h-6 sm:w-7 sm:h-7 rounded-lg text-[10px] sm:text-[11px] font-black transition-all duration-150 cursor-pointer ${
                    isActive
                      ? `bg-gradient-to-br ${info.color} text-white shadow-md shadow-purple-950/60 ring-1 ring-white/30 scale-105`
                      : isHovered
                      ? 'bg-[#222838] border border-[#384259] text-white'
                      : 'bg-[#181b24] border border-[#252b3a] text-zinc-400 hover:text-white'
                  }`}
                  title={`Mode ${mode}: ${info.title}`}
                >
                  {mode}
                  {isActive && (
                    <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-white shadow-xs" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Right: Speed Selector & Master Action Buttons */}
          <div className="flex items-center gap-2">
            {/* Speed Selector */}
            <div className="flex items-center gap-1 bg-[#181b24] border border-[#252b3a] hover:border-purple-500/40 rounded-lg px-2 py-0.5 h-7 transition-colors">
              <span className="text-[9.5px] text-zinc-400 font-semibold">Speed</span>
              <select
                value={speechSpeed}
                onChange={(e) => setSpeechSpeed(Number(e.target.value))}
                className="bg-transparent text-[10px] text-white focus:outline-none font-mono font-bold cursor-pointer"
              >
                <option value={0.85} className="bg-[#181b24] text-white">0.85x (Slow)</option>
                <option value={1.0} className="bg-[#181b24] text-white">1.0x (Normal)</option>
                <option value={1.15} className="bg-[#181b24] text-white">1.15x (Brisk)</option>
                <option value={1.25} className="bg-[#181b24] text-white">1.25x (Fast)</option>
                <option value={1.35} className="bg-[#181b24] text-white">1.35x (Rapid)</option>
              </select>
            </div>

            {/* Action Hero Buttons */}
            {selectedSegmentIds.size > 0 ? (
              <>
                <button
                  onClick={handleGenerateSelectedSpeech}
                  disabled={isGeneratingAll}
                  className="h-7 px-3 rounded-lg bg-gradient-to-r from-purple-600 via-pink-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold text-[11px] shadow-md shadow-purple-950/70 active:scale-95 transition-all disabled:opacity-40 flex items-center gap-1.5 border border-white/20 cursor-pointer"
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
                  disabled={isGeneratingAll || displayedSegments.length === 0}
                  className="h-7 px-2.5 rounded-lg bg-[#1c2233] hover:bg-[#262f46] text-zinc-300 hover:text-white font-semibold text-[11px] border border-[#2e3952] transition-all disabled:opacity-40 cursor-pointer"
                  title="Continue dubbing all lines in project"
                >
                  {displayedSegments.filter((s) => !s.audio_url).length > 0 && displayedSegments.filter((s) => !s.audio_url).length < displayedSegments.length
                    ? `Continue (${displayedSegments.filter((s) => !s.audio_url).length} left)`
                    : `Dub All (${displayedSegments.length})`}
                </button>
              </>
            ) : (
              <button
                onClick={() => handleGenerateAllSpeech(false)}
                disabled={isGeneratingAll || displayedSegments.length === 0}
                className="h-7 px-3.5 rounded-lg bg-gradient-to-r from-purple-600 via-indigo-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white font-bold text-[11px] shadow-md shadow-purple-950/60 active:scale-95 transition-all disabled:opacity-40 flex items-center gap-1.5 border border-white/10 cursor-pointer"
                title="Continue voice dubbing for remaining lines"
              >
                {isGeneratingAll ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin text-white" />
                    <span>Synthesizing Voice Track...</span>
                  </span>
                ) : (
                  <>
                    <Mic className="w-3 h-3 text-purple-200" />
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

      {/* 6. AI Catchy Opening Hook Modal — Portaled to Body to prevent clipping */}
      {showHookModal &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md select-none font-sans"
            onClick={() => setShowHookModal(false)}
          >
            <div
              className="w-full max-w-xl bg-[#12141c] border border-white/10 rounded-2xl shadow-2xl shadow-black/90 overflow-hidden flex flex-col h-[80vh] max-h-[80vh] animate-in zoom-in-95 duration-150"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header (Fixed at top) */}
              <div className="px-4 py-3 border-b border-white/10 bg-[#161824] flex items-center justify-between shrink-0 z-10">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-pink-500 to-purple-600 flex items-center justify-center text-white shadow-md shadow-pink-500/20 shrink-0">
                    <Flame className="w-4 h-4 text-yellow-300" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-xs font-bold text-white tracking-wide truncate">
                        AI Intro Hook Studio
                      </h3>
                      <span className="text-[9px] px-2 py-0.5 rounded-full bg-pink-500/20 text-pink-300 border border-pink-500/30 font-bold uppercase tracking-wider font-mono">
                        First 3-8s
                      </span>
                    </div>
                    <p className="text-[10px] text-zinc-400 truncate">
                      Generate viral opening hooks to boost retention
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowHookModal(false)}
                  className="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/15 text-zinc-300 hover:text-white flex items-center justify-center transition-all cursor-pointer border border-white/10 shrink-0"
                  title="Close Studio (Esc)"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Modal Body (Strictly Scrollable with min-h-0) */}
              <div className="p-3.5 overflow-y-auto space-y-3 flex-1 min-h-0 bg-[#0d0f17]">
                {/* Duration & Tone Controls */}
                <div className="p-3 rounded-xl bg-[#161824] border border-white/5 space-y-2.5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 items-center">
                    {/* Duration Selector */}
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1">
                        <Clock className="w-3 h-3 text-pink-400" />
                        <span>Duration</span>
                      </label>
                      <div className="grid grid-cols-4 gap-1">
                        {[
                          { sec: 3.0, label: '3s' },
                          { sec: 4.5, label: '4.5s' },
                          { sec: 6.0, label: '6s' },
                          { sec: 8.0, label: '8s' },
                        ].map((item) => {
                          const active = hookDuration === item.sec;
                          return (
                            <button
                              key={item.sec}
                              onClick={() => setHookDuration(item.sec)}
                              className={`py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center justify-center font-mono ${
                                active
                                  ? 'bg-pink-600 text-white shadow-xs font-bold'
                                  : 'bg-[#1e2130] text-zinc-400 hover:text-white border border-white/5'
                              }`}
                            >
                              {item.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Tone Style Selector */}
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1">
                        <Wand2 className="w-3 h-3 text-amber-400" />
                        <span>Hook Vibe</span>
                      </label>
                      <select
                        value={hookTone}
                        onChange={(e) => setHookTone(e.target.value)}
                        className="w-full bg-[#1e2130] border border-white/10 rounded-lg px-2.5 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-pink-500 font-medium cursor-pointer"
                      >
                        <option value="viral">🔥 Viral Curiosity (តើអ្នកដឹងទេ...)</option>
                        <option value="suspense">🎭 Suspense & Mystery (រឿងរ៉ាវអាថ៌កំបាំង...)</option>
                        <option value="shocking">⚡ Action Shocking (នឹកស្មានមិនដល់...)</option>
                        <option value="comedy">😂 Comedy Commentary (សើចចុកពោះ...)</option>
                        <option value="emotional">❤️ Emotional Story (មនោសញ្ចេតនា...)</option>
                      </select>
                    </div>
                  </div>

                  {/* Generate Button Row */}
                  <div className="pt-2 border-t border-white/5 flex items-center justify-between gap-2">
                    <span className="text-[10px] text-zinc-400 truncate">
                      Crafts high-CTR Khmer opening hooks
                    </span>
                    <button
                      onClick={handleGenerateHooks}
                      disabled={isGeneratingHooks}
                      className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500 text-white text-xs font-bold shadow-md shadow-pink-500/20 flex items-center gap-1.5 transition-all active:scale-95 disabled:opacity-50 cursor-pointer shrink-0"
                    >
                      {isGeneratingHooks ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>Generating...</span>
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-3.5 h-3.5 text-yellow-300" />
                          <span>{generatedHooks.length > 0 ? 'Regenerate' : 'Generate Hooks'}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Generated Hook Cards */}
                {isGeneratingHooks && generatedHooks.length === 0 ? (
                  <div className="py-8 text-center space-y-2 rounded-xl bg-[#161824]/60 border border-white/5">
                    <Loader2 className="w-5 h-5 animate-spin text-pink-400 mx-auto" />
                    <p className="text-xs text-zinc-400">Crafting viral hook variations...</p>
                  </div>
                ) : generatedHooks.length === 0 ? (
                  <div className="py-8 text-center space-y-2 border border-dashed border-white/10 rounded-xl bg-[#161824]/30">
                    <Target className="w-5 h-5 text-pink-400 mx-auto" />
                    <p className="text-xs text-zinc-400">Click "Generate Hooks" above to craft intro voiceovers</p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between text-[11px] px-0.5 text-zinc-400">
                      <span className="font-semibold text-zinc-200">Hook Variations ({generatedHooks.length}):</span>
                      <span>Click Audition or Insert</span>
                    </div>

                    <div className="space-y-2">
                      {generatedHooks.map((hook, hIdx) => {
                        const isPreviewing = previewingHookId === (hook.hook_id || `hook-${hIdx}`);
                        const isInserting = insertingHookId === hook.text;
                        const isCopied = copiedId === `hook-${hIdx}`;

                        return (
                          <div
                            key={hook.hook_id || hIdx}
                            className="p-3 rounded-xl bg-[#161824] border border-white/5 hover:border-pink-500/40 transition-all space-y-2 relative group"
                          >
                            {/* Top Meta Row */}
                            <div className="flex items-center justify-between gap-1.5 flex-wrap">
                              <div className="flex items-center gap-1.5">
                                <span className="text-[9px] font-bold text-pink-400 font-mono bg-pink-500/10 px-1.5 py-0.5 rounded border border-pink-500/20">
                                  #{hIdx + 1}
                                </span>
                                <span className="text-[9px] px-2 py-0.5 rounded-full font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30">
                                  {hook.category_label || hook.category || 'Viral Hook'}
                                </span>
                                <span className="text-[9px] px-1.5 py-0.5 rounded font-mono bg-black/40 text-zinc-400 border border-white/5">
                                  ~{hook.estimated_seconds || hookDuration}s
                                </span>
                              </div>

                              <div className="flex items-center gap-1">
                                {/* 1-Click Copy */}
                                <button
                                  onClick={() => handleCopyText(hook.text, `hook-${hIdx}`)}
                                  className="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-all text-[10px] font-medium flex items-center gap-1 border border-white/5 cursor-pointer"
                                  title="Copy hook text"
                                >
                                  {isCopied ? (
                                    <>
                                      <Check className="w-3 h-3 text-emerald-400" />
                                      <span className="text-emerald-400">Copied</span>
                                    </>
                                  ) : (
                                    <>
                                      <Copy className="w-3 h-3" />
                                      <span>Copy</span>
                                    </>
                                  )}
                                </button>

                                {/* Voice Preview Button */}
                                <button
                                  onClick={() => handlePreviewHookTTS(hook.text, hook.hook_id || `hook-${hIdx}`)}
                                  className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-all cursor-pointer border ${
                                    isPreviewing
                                      ? 'bg-purple-600 text-white border-purple-400 animate-pulse'
                                      : 'bg-[#1e2130] hover:bg-[#272b3e] text-zinc-300 hover:text-white border-white/5'
                                  }`}
                                  title={isPreviewing ? 'Stop voice sample' : 'Listen to AI voice audition'}
                                >
                                  {isPreviewing ? (
                                    <>
                                      <Pause className="w-3 h-3 text-yellow-300" />
                                      <span>Playing</span>
                                    </>
                                  ) : (
                                    <>
                                      <Play className="w-3 h-3 text-pink-400 fill-pink-400" />
                                      <span>Audition</span>
                                    </>
                                  )}
                                </button>
                              </div>
                            </div>

                            {/* Hook Text Display */}
                            <div className="text-xs sm:text-sm font-bold text-white font-khmer leading-relaxed select-text bg-black/30 p-2.5 rounded-lg border border-white/5">
                              "{hook.text}"
                            </div>

                            {/* Action Buttons */}
                            <div className="pt-1 flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => handleInsertHookSegment(hook, false)}
                                disabled={isInserting}
                                className="px-3 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white border border-white/5 text-[11px] font-medium flex items-center gap-1 transition-all cursor-pointer"
                              >
                                <Target className="w-3 h-3 text-pink-400" />
                                <span>Insert at 0:00</span>
                              </button>

                              <button
                                onClick={() => handleInsertHookSegment(hook, true)}
                                disabled={isInserting}
                                className="px-3.5 py-1 rounded-lg bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500 text-white text-[11px] font-bold shadow-sm flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer disabled:opacity-50"
                              >
                                {isInserting ? (
                                  <>
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    <span>Inserting...</span>
                                  </>
                                ) : (
                                  <>
                                    <Zap className="w-3 h-3 text-yellow-300 fill-yellow-300" />
                                    <span>Insert & Dub Now</span>
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="px-4 py-2.5 border-t border-white/10 bg-[#0e1017] flex items-center justify-between gap-2 shrink-0">
                <span className="text-[10px] text-zinc-500">
                  Adds hook at 0:00 as <span className="text-pink-300">"Intro Hook"</span>
                </span>
                <button
                  onClick={() => setShowHookModal(false)}
                  className="px-3 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white text-xs font-medium transition-colors cursor-pointer border border-white/5"
                >
                  Close
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
