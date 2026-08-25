import { useState, useRef, useEffect, useMemo } from 'react';
import { useProjectStore } from '../stores/projectStore';
import {
  generateTtsPreview,
  generateTtsDirect,
  fetchSettings,
  updateSettings,
  fetchVoiceProfiles,
  type AppSettings,
  type VoiceProfileItem,
} from '../api/client';
import {
  Play,
  Pause,
  Trash2,
  Loader2,
  ChevronDown,
  Check,
  Plus,
  RotateCcw,
  Sparkles,
  Download,
  Copy,
  Mic,
  Zap,
  Sliders,
  Search,
  X,
  Clock,
  Layers,
  Volume2,
} from 'lucide-react';

interface VoiceOption {
  id: string;
  name: string;
  gender: 'Female' | 'Male';
  avatar: string;
  greeting: string;
  lang: string;
  accent: string;
  tag: string;
  profile?: 'female' | 'male' | 'child';
  engine: 'edge-tts' | 'voxcpm';
  badge: string;
  isCustom?: boolean;
  sample_audio_url?: string;
}

const EDGE_VOICES: VoiceOption[] = [
  {
    id: 'km-KH-PisethNeural',
    name: 'Piseth (ពិសិដ្ឋ)',
    gender: 'Male',
    avatar: '👨‍💼',
    greeting: '“សួស្តីបងប្អូនទាំងអស់គ្នា...”',
    lang: 'Khmer',
    accent: 'from-blue-500 to-indigo-600',
    tag: 'Warm & Confident · Male',
    profile: 'male',
    engine: 'edge-tts',
    badge: 'Standard Male',
  },
  {
    id: 'km-KH-SreymomNeural',
    name: 'Sreymom (ស្រីមុំ)',
    gender: 'Female',
    avatar: '👩‍💼',
    greeting: '“សូមស្វាគមន៍មកកាន់...”',
    lang: 'Khmer',
    accent: 'from-pink-500 to-rose-600',
    tag: 'Clear & Melodious · Female',
    profile: 'female',
    engine: 'edge-tts',
    badge: 'Standard Female',
  },
  {
    id: 'km-KH-SreymomNeural',
    name: 'Little Ana (កុមារី)',
    gender: 'Female',
    avatar: '👶',
    greeting: '“សួស្តីលោកពុកអ្នកម្តាយ...”',
    lang: 'Khmer',
    accent: 'from-purple-500 to-pink-500',
    tag: 'Playful & Cute · Child',
    profile: 'child',
    engine: 'edge-tts',
    badge: 'Child Voice',
  },
  {
    id: 'en-US-AndrewMultilingualNeural',
    name: 'Andrew (Multi)',
    gender: 'Male',
    avatar: '🎙️',
    greeting: '“Quick and sharp narration...”',
    lang: 'English / Multi',
    accent: 'from-amber-500 to-orange-600',
    tag: 'High Energy Host · Male',
    profile: 'male',
    engine: 'edge-tts',
    badge: 'Multilingual',
  },
  {
    id: 'en-US-AvaMultilingualNeural',
    name: 'Ava (Multi)',
    gender: 'Female',
    avatar: '✨',
    greeting: '“Smooth and melodious...”',
    lang: 'English / Multi',
    accent: 'from-teal-500 to-emerald-600',
    tag: 'Cinematic & Expressive · Female',
    profile: 'female',
    engine: 'edge-tts',
    badge: 'Multilingual',
  },
  {
    id: 'en-US-BrianMultilingualNeural',
    name: 'Brian (Multi)',
    gender: 'Male',
    avatar: '👔',
    greeting: '“Deep and calm documentary tone...”',
    lang: 'English / Multi',
    accent: 'from-indigo-500 to-sky-600',
    tag: 'Authoritative & Calm · Male',
    profile: 'male',
    engine: 'edge-tts',
    badge: 'Documentary',
  },
];

const VOXCPM_VOICES: VoiceOption[] = [
  {
    id: 'voxcpm-male',
    name: 'VoxCPM2 - Piseth (បុរស)',
    gender: 'Male',
    avatar: '🎬',
    greeting: '“ខ្ញុំរីករាយណាស់ដែលបានជួបអ្នកនៅថ្ងៃនេះ...”',
    lang: 'Khmer 2B Model',
    accent: 'from-purple-600 to-indigo-600',
    tag: 'Cinematic Acting · Male 2B',
    profile: 'male',
    engine: 'voxcpm',
    badge: '2B Generative',
  },
  {
    id: 'voxcpm-female',
    name: 'VoxCPM2 - Sreymom (នារី)',
    gender: 'Female',
    avatar: '👑',
    greeting: '“ខ្ញុំរីករាយណាស់ដែលបានជួបអ្នកនៅថ្ងៃនេះ...”',
    lang: 'Khmer 2B Model',
    accent: 'from-pink-600 to-rose-600',
    tag: 'Emotional Acting · Female 2B',
    profile: 'female',
    engine: 'voxcpm',
    badge: '2B Generative',
  },
  {
    id: 'voxcpm-young',
    name: 'VoxCPM2 - Young Hero (យុវជន)',
    gender: 'Male',
    avatar: '⚔️',
    greeting: '“ខ្ញុំរីករាយណាស់ដែលបានជួបអ្នកនៅថ្ងៃនេះ...”',
    lang: 'Khmer 2B Model',
    accent: 'from-cyan-500 to-blue-600',
    tag: 'Hero & Action Drama 2B',
    profile: 'male',
    engine: 'voxcpm',
    badge: '2B Generative',
  },
  {
    id: 'voxcpm-elder',
    name: 'VoxCPM2 - Master Elder (លោកតា)',
    gender: 'Male',
    avatar: '🧙‍♂️',
    greeting: '“ខ្ញុំរីករាយណាស់ដែលបានជួបអ្នកនៅថ្ងៃនេះ...”',
    lang: 'Khmer 2B Model',
    accent: 'from-amber-500 to-yellow-600',
    tag: 'Solemn Elder & Legend 2B',
    profile: 'male',
    engine: 'voxcpm',
    badge: '2B Generative',
  },
];

const EMOTIONS = [
  { id: 'neutral', name: 'Neutral', emoji: '😐', desc: 'Natural & Balanced' },
  { id: 'happy', name: 'Happy', emoji: '😊', desc: 'Bright & Cheerful' },
  { id: 'excited', name: 'Excited', emoji: '⚡', desc: 'Fast & High Energy' },
  { id: 'angry', name: 'Angry', emoji: '😡', desc: 'Furious & Intense' },
  { id: 'whisper', name: 'Whisper', emoji: '🤫', desc: 'Soft & Breathy' },
  { id: 'serious', name: 'Serious', emoji: '🧐', desc: 'Deep Authoritative' },
  { id: 'fearful', name: 'Fearful', emoji: '😰', desc: 'Trembling & Tense' },
  { id: 'calm', name: 'Calm', emoji: '😌', desc: 'Soft & Soothing' },
  { id: 'scream', name: 'Shout', emoji: '📢', desc: 'Battle Cry & Climax' },
];

const PROMPT_SUGGESTIONS = [
  { label: '🎬 Movie Recap Hook', text: 'រឿងរ៉ាវដ៏រន្ធត់មួយបានកើតឡើង នៅពេលដែលបុរសម្នាក់នេះ...' },
  { label: '📢 Battle Action', text: 'កាប់សម្លាប់ពួកវាឱ្យអស់! កុំទុកឱ្យវារួចខ្លួនឱ្យសោះ!' },
  { label: '🔥 Dramatic Climax', text: 'ឈប់ភ្លាម! ឯងគ្មានសិទ្ធិមកបញ្ជាយើងបែបនេះទេ!' },
  { label: '✨ Fairy Tale Story', text: 'កាលពីព្រេងនាយ មានក្មេងស្រីដ៏ស្រស់ស្អាតម្នាក់...' },
  { label: '🎙️ Modern Intro', text: 'សូមស្វាគមន៍មកកាន់វីដេអូថ្មី! ថ្ងៃនេះយើងនឹងបង្ហាញអំពី...' },
  { label: '🤫 Mystery Whisper', text: '(whisper) ស្ងាត់ៗណា កុំឱ្យគេដឹងពីរឿងនេះឱ្យសោះ...' },
];

interface GeneratedSpeechMessage {
  id: string;
  text: string;
  voiceName: string;
  voiceAvatar: string;
  voiceProfile: 'female' | 'male' | 'child';
  voiceId: string;
  voiceEngine?: 'edge-tts' | 'voxcpm';
  sampleAudioUrl?: string;
  emotion?: string;
  emotionEmoji?: string;
  audioUrl?: string;
  duration: number;
  wordCount: number;
  timestamp: string;
  inTimeline: boolean;
  segmentId?: string;
}

interface PendingSpeechMessage {
  text: string;
  voice: VoiceOption;
  emotion: { id: string; name: string; emoji: string };
  progress: number;
  startTime: number;
}

export default function MeatikaTTSPanel() {
  const { currentProject, currentTime, loadProject, deleteSegment } = useProjectStore();
  const currentProjectId = currentProject?.id;

  // Active Engine: 'edge-tts' | 'voxcpm'
  const [ttsEngine, setTtsEngine] = useState<'edge-tts' | 'voxcpm'>('edge-tts');
  const [customVoices, setCustomVoices] = useState<VoiceOption[]>([]);
  const [voiceCategory, setVoiceCategory] = useState<'all' | 'custom' | 'voxcpm' | 'edge'>('all');

  const [selectedVoice, setSelectedVoice] = useState<VoiceOption>(EDGE_VOICES[0]);
  const [selectedEmotion, setSelectedEmotion] = useState(EMOTIONS[0]);
  const [promptText, setPromptText] = useState('');
  const [speed, setSpeed] = useState(1.0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [pendingMsg, setPendingMsg] = useState<PendingSpeechMessage | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showVoiceDropdown, setShowVoiceDropdown] = useState(false);
  const [voiceSearchQuery, setVoiceSearchQuery] = useState('');
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [auditionVoiceId, setAuditionVoiceId] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const voiceDropdownRef = useRef<HTMLDivElement | null>(null);
  const progressTimerRef = useRef<any>(null);

  // Audio playback
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const auditionAudioRef = useRef<HTMLAudioElement | null>(null);
  const [playingMsgId, setPlayingMsgId] = useState<string | null>(null);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [playbackCurrentTime, setPlaybackCurrentTime] = useState(0);

  // History messages per project
  const [messages, setMessages] = useState<GeneratedSpeechMessage[]>([]);
  const projectLoadedRef = useRef<string | null>(null);

  // Fetch custom voice profiles from DB/settings
  const loadCustomProfiles = async () => {
    try {
      const data = await fetchVoiceProfiles();
      const customList: VoiceOption[] = data
        .filter((p) => !p.is_built_in || p.id.startsWith('custom_') || (p.sample_audio_url && p.sample_audio_url.trim()))
        .map((p) => {
          const isFemale =
            (p.gender || '').toLowerCase().includes('female') ||
            (p.gender || '').toLowerCase().includes('girl') ||
            (p.gender || '').toLowerCase().includes('grandma') ||
            (p.gender || '').toLowerCase().includes('នារី') ||
            (p.gender || '').toLowerCase().includes('ស្រី');
          return {
            id: p.id,
            name: p.name,
            gender: (isFemale ? 'Female' : 'Male') as 'Female' | 'Male',
            avatar: isFemale ? '👩' : '👨',
            greeting: '“សួស្តី! នេះជាសំឡេងគំរូ...”',
            lang: p.language === 'km' ? 'Khmer' : (p.language || 'Khmer'),
            accent: isFemale ? 'from-pink-500 to-rose-600' : 'from-indigo-500 to-purple-600',
            tag: p.description || (p.sample_audio_url ? 'Zero-Shot Cloned Voice' : 'Custom Voice Profile'),
            profile: isFemale ? 'female' : 'male',
            engine: (p.engine === 'voxcpm' ? 'voxcpm' : 'edge-tts') as 'edge-tts' | 'voxcpm',
            badge: p.sample_audio_url ? '🌟 Cloned Voice' : '🌟 Custom',
            isCustom: true,
            sample_audio_url: p.sample_audio_url,
          };
        });
      setCustomVoices(customList);
    } catch (e) {
      console.error('Failed to load custom voice profiles:', e);
    }
  };

  // Fetch initial global settings & custom voices
  useEffect(() => {
    loadCustomProfiles();
    fetchSettings()
      .then((s: AppSettings) => {
        if (s.tts_engine === 'voxcpm') {
          setTtsEngine('voxcpm');
          setSelectedVoice(VOXCPM_VOICES[0]);
        } else {
          setTtsEngine('edge-tts');
          setSelectedVoice(EDGE_VOICES[0]);
        }
      })
      .catch(() => {});
  }, []);

  // Compute active voices with custom profiles
  const activeVoices = useMemo(() => {
    if (voiceCategory === 'custom') return customVoices;
    if (voiceCategory === 'voxcpm') return VOXCPM_VOICES;
    if (voiceCategory === 'edge') return EDGE_VOICES;

    const builtin = ttsEngine === 'voxcpm' ? VOXCPM_VOICES : EDGE_VOICES;
    const matchingCustom = customVoices.filter(
      (cv) => cv.engine === ttsEngine || (ttsEngine === 'voxcpm' && cv.sample_audio_url)
    );
    return [...matchingCustom, ...builtin];
  }, [ttsEngine, voiceCategory, customVoices]);

  // Close voice dropdown on outside click
  useEffect(() => {
    if (!showVoiceDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (voiceDropdownRef.current && !voiceDropdownRef.current.contains(e.target as Node)) {
        setShowVoiceDropdown(false);
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
    }, 10);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [showVoiceDropdown]);

  // Handle switching TTS Engine
  const handleSwitchEngine = async (engine: 'edge-tts' | 'voxcpm') => {
    setTtsEngine(engine);
    setSelectedVoice(engine === 'voxcpm' ? VOXCPM_VOICES[0] : EDGE_VOICES[0]);
    try {
      await updateSettings({ tts_engine: engine });
    } catch (e) {
      console.error('Failed to update engine setting:', e);
    }
  };

  // Robust project-switching synchronization
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (auditionAudioRef.current) {
      auditionAudioRef.current.pause();
      auditionAudioRef.current = null;
    }
    setPlayingMsgId(null);
    setPlaybackProgress(0);
    setPlaybackCurrentTime(0);
    setAuditionVoiceId(null);
    setPendingMsg(null);

    if (!currentProjectId) {
      setMessages([]);
      projectLoadedRef.current = null;
      return;
    }

    try {
      const raw = localStorage.getItem(`tts-msgs-${currentProjectId}`);
      const list: GeneratedSpeechMessage[] = raw ? JSON.parse(raw) : [];
      const segAudioUrls = new Set(
        (currentProject?.segments || []).map((s) => s.audio_url).filter(Boolean)
      );
      const synced = list.map((m) => ({
        ...m,
        inTimeline: !!(m.audioUrl && segAudioUrls.has(m.audioUrl)),
      }));
      setMessages(synced);
    } catch {
      setMessages([]);
    }

    projectLoadedRef.current = currentProjectId;
  }, [currentProjectId]);

  // Persist messages strictly for active project
  useEffect(() => {
    if (currentProjectId && projectLoadedRef.current === currentProjectId) {
      try {
        localStorage.setItem(`tts-msgs-${currentProjectId}`, JSON.stringify(messages));
      } catch {}
    }
  }, [messages, currentProjectId]);

  useEffect(() => {
    if (pendingMsg || messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [pendingMsg, messages.length]);

  // Clean up audio on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (auditionAudioRef.current) {
        auditionAudioRef.current.pause();
        auditionAudioRef.current = null;
      }
    };
  }, []);

  const handleAuditionVoice = async (voice: VoiceOption, e: React.MouseEvent) => {
    e.stopPropagation();
    if (auditionVoiceId === voice.id) {
      if (auditionAudioRef.current) auditionAudioRef.current.pause();
      setAuditionVoiceId(null);
      return;
    }
    if (auditionAudioRef.current) auditionAudioRef.current.pause();
    setAuditionVoiceId(voice.id);

    try {
      if (!currentProject?.id) return;
      const data = await generateTtsPreview(currentProject.id, {
        text: voice.greeting.replace(/“|”|\"/g, ''),
        voice_profile: voice.profile || 'female',
        voice_name: voice.id,
        engine: voice.engine,
        reference_audio: voice.sample_audio_url,
        sample_audio_url: voice.sample_audio_url,
        speed: 1.0,
        emotion: 'neutral',
      });
      if (data.audio_url) {
        const a = new Audio(data.audio_url);
        auditionAudioRef.current = a;
        a.onended = () => setAuditionVoiceId(null);
        a.onerror = () => setAuditionVoiceId(null);
        a.play().catch(() => setAuditionVoiceId(null));
      }
    } catch {
      setAuditionVoiceId(null);
    }
  };

  const handleTogglePlay = (msg: GeneratedSpeechMessage) => {
    if (playingMsgId === msg.id) {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      setPlayingMsgId(null);
      return;
    }

    if (audioRef.current) {
      audioRef.current.pause();
    }

    if (auditionAudioRef.current) {
      auditionAudioRef.current.pause();
      setAuditionVoiceId(null);
    }

    setPlayingMsgId(msg.id);
    setPlaybackProgress(0);
    setPlaybackCurrentTime(0);

    if (msg.audioUrl) {
      const srcUrl = msg.audioUrl.startsWith('http') ? msg.audioUrl : msg.audioUrl;
      const audio = new Audio(srcUrl);
      audio.volume = 1.0;
      audioRef.current = audio;

      audio.ontimeupdate = () => {
        if (audio.duration > 0) {
          setPlaybackProgress(audio.currentTime / audio.duration);
          setPlaybackCurrentTime(audio.currentTime);
        }
      };

      audio.onended = () => {
        setPlayingMsgId(null);
        setPlaybackProgress(0);
        setPlaybackCurrentTime(0);
      };

      audio.onerror = (e) => {
        console.error('Audio playback error:', e);
        setPlayingMsgId(null);
      };

      audio.play().catch((err) => {
        console.warn('Playback play failed:', err);
        setPlayingMsgId(null);
      });
    }
  };

  const handleGenerate = async () => {
    if (!currentProject?.id || !promptText.trim()) return;
    setIsGenerating(true);

    const rawText = promptText.trim();
    const cleanText = rawText.replace(/[\(\[\{][^\)\]\}]*[\)\]\}]/g, '').replace(/\s+/g, ' ').trim();
    const textToSay = cleanText || rawText;
    const words = textToSay.split(/\s+/).filter(Boolean).length;
    const chosenVoice = selectedVoice;
    const chosenEmotion = selectedEmotion;

    setPendingMsg({
      text: textToSay,
      voice: chosenVoice,
      emotion: chosenEmotion,
      progress: 15,
      startTime: Date.now(),
    });
    setPromptText('');

    if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    progressTimerRef.current = setInterval(() => {
      setPendingMsg((curr) => {
        if (!curr) return null;
        if (curr.progress >= 92) return curr;
        return { ...curr, progress: curr.progress + Math.random() * 12 + 6 };
      });
    }, 250);

    try {
      const resp = await generateTtsPreview(currentProject.id, {
        text: textToSay,
        voice_profile: chosenVoice.profile || 'female',
        voice_name: chosenVoice.id,
        engine: chosenVoice.engine,
        reference_audio: chosenVoice.sample_audio_url,
        sample_audio_url: chosenVoice.sample_audio_url,
        speed,
        emotion: chosenEmotion.id,
      });

      if (progressTimerRef.current) clearInterval(progressTimerRef.current);

      const newMsg: GeneratedSpeechMessage = {
        id: `tts-${Date.now()}`,
        text: textToSay,
        voiceName: chosenVoice.name,
        voiceAvatar: chosenVoice.avatar,
        voiceProfile: chosenVoice.profile || 'female',
        voiceId: chosenVoice.id,
        voiceEngine: chosenVoice.engine,
        sampleAudioUrl: chosenVoice.sample_audio_url,
        emotion: chosenEmotion.name,
        emotionEmoji: chosenEmotion.emoji,
        audioUrl: resp.audio_url,
        duration: resp.duration || Math.max(1.5, (words * 0.35) / speed),
        wordCount: words,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        inTimeline: false,
      };

      setMessages((prev) => [...prev, newMsg]);
      setPendingMsg(null);

      // Auto-play newly generated speech so user hears it immediately
      if (resp.audio_url) {
        setTimeout(() => {
          handleTogglePlay(newMsg);
        }, 100);
      }
    } catch (err: any) {
      console.error('Failed to generate speech:', err);
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
      setPendingMsg(null);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleToggleTimeline = async (msg: GeneratedSpeechMessage) => {
    if (!currentProject?.id) return;

    if (msg.inTimeline && msg.segmentId) {
      try {
        await deleteSegment(msg.segmentId);
        await loadProject(currentProject.id);
        setMessages((prev) =>
          prev.map((m) => (m.id === msg.id ? { ...m, inTimeline: false, segmentId: undefined } : m))
        );
      } catch (e: any) {
        console.error('Failed to remove from timeline:', e);
      }
    } else {
      try {
        const seg = await generateTtsDirect(currentProject.id, {
          text: msg.text,
          voice_profile: msg.voiceProfile,
          voice_name: msg.voiceId || msg.voiceName,
          engine: msg.voiceEngine,
          reference_audio: msg.sampleAudioUrl,
          sample_audio_url: msg.sampleAudioUrl,
          speed,
          start_time: currentTime || 0,
          speaker: msg.voiceName,
          audio_url: msg.audioUrl || '',
          duration: msg.duration,
          emotion: selectedEmotion.id,
        });
        await loadProject(currentProject.id);
        setMessages((prev) =>
          prev.map((m) => (m.id === msg.id ? { ...m, inTimeline: true, segmentId: seg.id } : m))
        );
      } catch (e: any) {
        console.error('Failed to add to timeline:', e);
      }
    }
  };

  const handleCopyText = (msg: GeneratedSpeechMessage) => {
    navigator.clipboard.writeText(msg.text);
    setCopiedMsgId(msg.id);
    setTimeout(() => setCopiedMsgId(null), 2000);
  };

  const handleDeleteMsg = (msgId: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== msgId));
    if (playingMsgId === msgId) {
      if (audioRef.current) audioRef.current.pause();
      setPlayingMsgId(null);
    }
  };

  const formatSecs = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const filteredVoices = useMemo(() => {
    if (!voiceSearchQuery.trim()) return activeVoices;
    const q = voiceSearchQuery.toLowerCase();
    return activeVoices.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        v.tag.toLowerCase().includes(q) ||
        v.gender.toLowerCase().includes(q) ||
        v.lang.toLowerCase().includes(q)
    );
  }, [activeVoices, voiceSearchQuery]);

  return (
    <div className="h-full flex flex-col bg-[#121316] text-[#e1e3e6] overflow-hidden select-none font-sans">
      {/* Top Header */}
      <div className="px-4 py-2.5 flex items-center justify-between shrink-0 border-b border-[#1c1e24] bg-[#121316] backdrop-blur-md">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-xl bg-gradient-to-tr from-purple-600 via-pink-600 to-indigo-600 flex items-center justify-center text-white shadow-md shadow-pink-950/40">
            <Mic className="w-3.5 h-3.5" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h2 className="text-xs font-bold text-white tracking-wide">AI Voiceover Studio</h2>
              <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-pink-500/15 text-pink-300 border border-pink-500/30 font-bold font-mono">
                {selectedVoice.isCustom
                  ? '🌟 Custom Voice'
                  : ttsEngine === 'voxcpm'
                  ? '🎬 VoxCPM2 2B'
                  : '⚡ Edge Neural'}
              </span>
            </div>
            <p className="text-[10px] text-zinc-400 font-medium truncate max-w-[200px] flex items-center gap-1 mt-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>{selectedVoice.name}</span>
              <span className="text-zinc-600">·</span>
              <span className="text-zinc-400">{selectedEmotion.name}</span>
              <span className="text-zinc-600">·</span>
              <span className="text-zinc-400 font-mono">{speed.toFixed(1)}x</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Engine Selector Segmented Control */}
          <div className="flex items-center bg-[#181a1f] p-0.5 rounded-lg border border-[#24272f]">
            <button
              onClick={() => handleSwitchEngine('edge-tts')}
              className={`px-2.5 py-1 rounded-md text-[10px] font-bold flex items-center gap-1 transition-all ${
                ttsEngine === 'edge-tts'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="Fast Microsoft Edge Neural Khmer voices"
            >
              <Zap className="w-3 h-3 text-yellow-300" />
              <span>Edge</span>
            </button>
            <button
              onClick={() => handleSwitchEngine('voxcpm')}
              className={`px-2.5 py-1 rounded-md text-[10px] font-bold flex items-center gap-1 transition-all ${
                ttsEngine === 'voxcpm'
                  ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="2B Parameter Generative Acting AI Voice"
            >
              <Sparkles className="w-3 h-3 text-pink-300" />
              <span>VoxCPM2</span>
            </button>
          </div>

          {messages.length > 0 && (
            <button
              onClick={() => setMessages([])}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-[#181a1f] transition-colors border border-transparent hover:border-red-500/20"
              title="Clear Session Takes"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`p-1.5 rounded-lg transition-all ${
              showSettings
                ? 'text-pink-300 bg-pink-500/20 border border-pink-500/40 shadow-sm'
                : 'text-zinc-400 hover:text-white hover:bg-[#181a1f] border border-transparent'
            }`}
            title="Speech Speed Tempo"
          >
            <Sliders className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Speed Slider Settings Drawer */}
      {showSettings && (
        <div className="px-4 py-2 bg-[#181a1f] border-b border-[#1c1e24] flex items-center justify-between gap-3 text-xs animate-in slide-in-from-top-2 duration-150 shrink-0">
          <div className="flex items-center gap-3 flex-1">
            <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 shrink-0">
              <Zap className="w-3.5 h-3.5 text-yellow-400" /> Speed Tempo:
            </span>
            <input
              type="range"
              min="0.75"
              max="1.5"
              step="0.05"
              value={speed}
              onChange={(e) => setSpeed(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-[#252830] rounded-lg appearance-none cursor-pointer accent-pink-500"
            />
            <span className="font-mono text-xs font-bold text-pink-300 min-w-[38px] text-right">
              {speed.toFixed(2)}×
            </span>
          </div>
          <button
            onClick={() => setSpeed(1.0)}
            className="text-[10px] text-zinc-400 hover:text-white flex items-center gap-1 bg-[#1e2128] px-2.5 py-1 rounded-lg border border-[#2c303a] hover:border-zinc-500 transition-colors shrink-0 font-medium"
          >
            <RotateCcw className="w-2.5 h-2.5" /> 1.0×
          </button>
        </div>
      )}

      {/* Main Feed: Generation History */}
      <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-2.5">
        {messages.length === 0 && !pendingMsg && (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-zinc-500 space-y-3">
            <div className="w-14 h-14 rounded-2xl bg-[#181a1f] border border-[#24272f] flex items-center justify-center text-pink-400 shadow-md">
              <Sparkles className="w-6 h-6 animate-pulse text-pink-400" />
            </div>
            <div>
              <h3 className="text-xs font-bold text-zinc-200">
                {selectedVoice.isCustom
                  ? `🌟 ${selectedVoice.name} (Custom Profile)`
                  : ttsEngine === 'voxcpm'
                  ? '🎬 VoxCPM2 Generative Voice Studio'
                  : '⚡ Studio Neural Voice Synthesis'}
              </h3>
              <p className="text-[11px] text-zinc-400 max-w-xs leading-relaxed mt-1">
                Enter Khmer or English text below to generate realistic voiceovers. Audition takes and place them directly onto your timeline.
              </p>
            </div>

            {/* Quick Prompts Suggestions */}
            <div className="grid grid-cols-2 gap-2 w-full max-w-sm pt-2">
              {PROMPT_SUGGESTIONS.slice(0, 4).map((s, idx) => (
                <button
                  key={idx}
                  onClick={() => setPromptText(s.text)}
                  className="p-2.5 text-left rounded-xl bg-[#181a1f] hover:bg-[#20232b] border border-[#24272f] hover:border-pink-500/40 text-[11px] text-zinc-300 hover:text-white transition-all group"
                >
                  <span className="font-bold block text-[10px] text-pink-400 mb-0.5 group-hover:text-pink-300">
                    {s.label}
                  </span>
                  <span className="line-clamp-1 font-khmer text-zinc-400 text-[10px]">{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Message Bubble Feed */}
        {messages.map((msg) => {
          const isPlaying = playingMsgId === msg.id;

          return (
            <div
              key={msg.id}
              className="p-3.5 rounded-xl bg-[#16181d] border border-[#22252c] hover:border-[#323640] transition-all shadow-sm group relative"
            >
              {/* Header Info */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-base leading-none">{msg.voiceAvatar}</span>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold text-white">{msg.voiceName}</span>
                      {msg.emotion && (
                        <span className="text-[9px] px-2 py-0.5 rounded-full bg-pink-500/15 text-pink-300 font-semibold border border-pink-500/30">
                          {msg.emotionEmoji} {msg.emotion}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-zinc-500 font-mono">{msg.timestamp}</span>
                  <button
                    onClick={() => handleDeleteMsg(msg.id)}
                    className="p-1 text-zinc-500 hover:text-red-400 rounded-lg hover:bg-[#242730] transition-colors ml-1"
                    title="Remove take"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>

              {/* Spoken Text */}
              <p className="text-xs text-zinc-200 font-khmer leading-relaxed mb-3 select-text whitespace-pre-wrap">
                {msg.text}
              </p>

              {/* Action Bar / Waveform Progress */}
              <div className="flex items-center justify-between pt-2.5 border-t border-[#20232a] gap-2.5">
                <div className="flex items-center gap-2 flex-1">
                  {/* Play / Pause Button */}
                  <button
                    onClick={() => handleTogglePlay(msg)}
                    className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold transition-all shadow-sm ${
                      isPlaying
                        ? 'bg-pink-600 text-white shadow-pink-950/60 ring-2 ring-pink-400 scale-105'
                        : 'bg-[#22252d] hover:bg-pink-600 text-zinc-200 hover:text-white border border-[#2d313c]'
                    }`}
                  >
                    {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 translate-x-0.5" />}
                  </button>

                  {/* Audio Progress Bar */}
                  <div className="flex-1 bg-[#101216] h-1.5 rounded-full overflow-hidden relative border border-[#252830]">
                    <div
                      className="bg-gradient-to-r from-pink-500 to-purple-500 h-full rounded-full transition-all duration-100"
                      style={{ width: `${isPlaying ? playbackProgress * 100 : 0}%` }}
                    />
                  </div>

                  <span className="text-[10px] text-zinc-400 font-mono min-w-[32px]">
                    {isPlaying ? formatSecs(playbackCurrentTime) : formatSecs(msg.duration)}
                  </span>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleCopyText(msg)}
                    className="p-1.5 text-zinc-400 hover:text-white rounded-lg hover:bg-[#22252d] transition-colors"
                    title="Copy Text"
                  >
                    {copiedMsgId === msg.id ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>

                  <button
                    onClick={() => handleToggleTimeline(msg)}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold flex items-center gap-1 transition-all ${
                      msg.inTimeline
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30'
                        : 'bg-[#242730] hover:bg-purple-600 text-zinc-200 hover:text-white border border-[#313540]'
                    }`}
                    title={msg.inTimeline ? 'Added to project timeline' : 'Add subtitle segment to timeline'}
                  >
                    {msg.inTimeline ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-400" />
                        <span>In Timeline</span>
                      </>
                    ) : (
                      <>
                        <Plus className="w-3 h-3" />
                        <span>To Timeline</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {/* Pending Generation Skeleton */}
        {pendingMsg && (
          <div className="p-3.5 rounded-xl bg-[#181a1f] border border-pink-500/40 animate-pulse space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-base">{pendingMsg.voice.avatar}</span>
                <span className="text-xs font-bold text-white">{pendingMsg.voice.name}</span>
                <span className="text-[9px] px-2 py-0.5 rounded-full bg-pink-500/20 text-pink-300 font-semibold border border-pink-500/30">
                  {pendingMsg.emotion.emoji} {pendingMsg.emotion.name}
                </span>
              </div>
              <span className="text-[10px] text-pink-400 font-mono flex items-center gap-1 font-bold">
                <Loader2 className="w-3 h-3 animate-spin" /> Synthesizing...
              </span>
            </div>

            <p className="text-xs text-zinc-300 font-khmer italic leading-relaxed select-text">
              "{pendingMsg.text}"
            </p>

            <div className="w-full bg-[#101216] h-1.5 rounded-full overflow-hidden border border-pink-500/20">
              <div
                className="bg-gradient-to-r from-pink-500 via-purple-500 to-indigo-500 h-full rounded-full transition-all duration-300"
                style={{ width: `${pendingMsg.progress}%` }}
              />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input / Control Bottom Studio */}
      <div className="p-3 border-t border-[#1c1e24] bg-[#121316] shrink-0 space-y-2">
        {/* Voice Selector Bar & Emotion Tray */}
        <div className="flex items-center gap-2">
          {/* Main Voice Selector Trigger */}
          <div className="relative flex-1" ref={voiceDropdownRef}>
            <button
              onClick={() => {
                setShowVoiceDropdown(!showVoiceDropdown);
                loadCustomProfiles();
              }}
              className="w-full flex items-center justify-between p-2 rounded-xl bg-[#181a1f] border border-[#24272f] hover:border-[#383c48] text-xs transition-all shadow-sm group"
            >
              <div className="flex items-center gap-2 truncate">
                <span className="text-base">{selectedVoice.avatar}</span>
                <div className="text-left truncate">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-white text-xs block truncate leading-tight">
                      {selectedVoice.name}
                    </span>
                    {selectedVoice.isCustom && (
                      <span className="text-[8px] px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-300 font-bold border border-purple-500/30">
                        Custom
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-zinc-400 block truncate">{selectedVoice.tag}</span>
                </div>
              </div>
              <ChevronDown className="w-3.5 h-3.5 text-zinc-400 group-hover:text-white shrink-0 ml-1" />
            </button>

            {/* Dropdown Menu */}
            {showVoiceDropdown && (
              <div className="absolute bottom-full left-0 mb-2 w-84 bg-[#1e2025] border border-[#31353e] rounded-2xl shadow-2xl p-2 z-50 max-h-88 overflow-hidden flex flex-col space-y-1.5 animate-in fade-in">
                <div className="px-2 py-1 text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center justify-between border-b border-zinc-800 pb-1.5">
                  <span>Voice Profiles</span>
                  <span className="font-mono text-pink-400 font-bold">{filteredVoices.length} voices</span>
                </div>

                {/* Category Filter Pills */}
                <div className="flex items-center gap-1 px-1 py-0.5 overflow-x-auto">
                  <button
                    onClick={() => setVoiceCategory('all')}
                    className={`px-2 py-0.5 rounded-lg text-[10px] font-bold transition-all ${
                      voiceCategory === 'all'
                        ? 'bg-pink-600 text-white'
                        : 'bg-[#14161a] text-zinc-400 hover:text-white'
                    }`}
                  >
                    All
                  </button>
                  {customVoices.length > 0 && (
                    <button
                      onClick={() => setVoiceCategory('custom')}
                      className={`px-2 py-0.5 rounded-lg text-[10px] font-bold transition-all ${
                        voiceCategory === 'custom'
                          ? 'bg-purple-600 text-white'
                          : 'bg-[#14161a] text-purple-300 hover:text-white border border-purple-500/30'
                      }`}
                    >
                      🌟 Custom ({customVoices.length})
                    </button>
                  )}
                  <button
                    onClick={() => setVoiceCategory('voxcpm')}
                    className={`px-2 py-0.5 rounded-lg text-[10px] font-bold transition-all ${
                      voiceCategory === 'voxcpm'
                        ? 'bg-indigo-600 text-white'
                        : 'bg-[#14161a] text-zinc-400 hover:text-white'
                    }`}
                  >
                    🎬 VoxCPM2
                  </button>
                  <button
                    onClick={() => setVoiceCategory('edge')}
                    className={`px-2 py-0.5 rounded-lg text-[10px] font-bold transition-all ${
                      voiceCategory === 'edge'
                        ? 'bg-blue-600 text-white'
                        : 'bg-[#14161a] text-zinc-400 hover:text-white'
                    }`}
                  >
                    ⚡ Edge-TTS
                  </button>
                </div>

                {/* Search Bar inside voice dropdown */}
                <div className="relative px-1">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-2 text-zinc-500" />
                  <input
                    type="text"
                    placeholder="Search voice name or language..."
                    value={voiceSearchQuery}
                    onChange={(e) => setVoiceSearchQuery(e.target.value)}
                    className="w-full pl-8 pr-7 py-1 bg-[#14161a] border border-[#2c303a] focus:border-pink-500 rounded-lg text-xs text-white placeholder-zinc-500 focus:outline-none"
                    autoFocus
                  />
                  {voiceSearchQuery && (
                    <button
                      onClick={() => setVoiceSearchQuery('')}
                      className="absolute right-3 top-2 text-zinc-400 hover:text-white"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto space-y-1 max-h-56 pr-0.5">
                  {filteredVoices.map((v) => (
                    <button
                      key={v.id + v.name}
                      onClick={() => {
                        setSelectedVoice(v);
                        if (v.engine) setTtsEngine(v.engine);
                        setShowVoiceDropdown(false);
                      }}
                      className={`w-full p-2 rounded-xl text-left flex items-center justify-between transition-all group ${
                        selectedVoice.id === v.id && selectedVoice.name === v.name
                          ? 'bg-pink-600/20 border border-pink-500/50 text-white shadow-sm'
                          : 'hover:bg-[#282c34] text-zinc-300 border border-transparent'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="text-base">{v.avatar}</span>
                        <div className="truncate">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-xs text-white truncate">{v.name}</span>
                            <span className={`text-[8px] px-1.5 py-0.2 rounded font-mono ${
                              v.isCustom ? 'bg-purple-500/25 text-purple-300 border border-purple-500/40' : 'bg-zinc-800 text-zinc-400'
                            }`}>
                              {v.badge}
                            </span>
                          </div>
                          <span className="text-[10px] text-zinc-400 block truncate">{v.tag}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0 ml-1.5">
                        <button
                          onClick={(e) => handleAuditionVoice(v, e)}
                          className={`p-1.5 rounded-lg text-xs transition-colors ${
                            auditionVoiceId === v.id
                              ? 'bg-pink-600 text-white ring-2 ring-pink-400'
                              : 'bg-[#242730] hover:bg-pink-600 text-zinc-300 hover:text-white'
                          }`}
                          title="Audition Sample"
                        >
                          {auditionVoiceId === v.id ? (
                            <Pause className="w-2.5 h-2.5" />
                          ) : (
                            <Play className="w-2.5 h-2.5" />
                          )}
                        </button>
                        {selectedVoice.id === v.id && selectedVoice.name === v.name && (
                          <Check className="w-3.5 h-3.5 text-pink-400 ml-0.5" />
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Emotion Pill Dropdown */}
          <div className="shrink-0">
            <select
              value={selectedEmotion.id}
              onChange={(e) => {
                const emo = EMOTIONS.find((em) => em.id === e.target.value);
                if (emo) setSelectedEmotion(emo);
              }}
              className="bg-[#181a1f] border border-[#24272f] hover:border-[#383c48] text-white text-xs font-bold rounded-xl px-3 py-2.5 focus:outline-none focus:border-pink-500 cursor-pointer shadow-sm"
            >
              {EMOTIONS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.emoji} {e.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Text Input Box Deck */}
        <div className="relative">
          <textarea
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleGenerate();
              }
            }}
            placeholder="Type or paste narration script in Khmer or English..."
            rows={2}
            className="w-full bg-[#181a1f] border border-[#24272f] rounded-xl p-3 pr-28 text-xs text-white placeholder-zinc-500 font-khmer focus:outline-none focus:border-pink-500/80 transition-colors resize-none leading-relaxed shadow-inner"
          />

          {/* Generate Button inside Input Box */}
          <div className="absolute right-2.5 bottom-3 flex items-center gap-1.5">
            <button
              onClick={handleGenerate}
              disabled={isGenerating || !promptText.trim()}
              className="px-3.5 py-1.5 rounded-lg bg-gradient-to-r from-pink-600 via-purple-600 to-indigo-600 hover:from-pink-500 hover:to-indigo-500 text-white text-xs font-bold shadow-md shadow-pink-950/40 flex items-center gap-1.5 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed uppercase tracking-wider font-mono"
            >
              {isGenerating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              <span>Say</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
