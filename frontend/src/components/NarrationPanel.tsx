import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useProjectStore } from '../stores/projectStore';
import {
  generateNarration,
  applyNarration,
  generateTtsPreview,
  generateSocialMediaScript,
  type NarrationSegment,
  type SocialMediaScriptResult,
  type ScriptBlockItem,
} from '../api/client';
import {
  Mic,
  Loader2,
  Play,
  Pause,
  Check,
  AlertCircle,
  RefreshCw,
  Trash2,
  CheckCircle2,
  XCircle,
  X,
  Sparkles,
  Volume2,
  Film,
  Zap,
  BookOpen,
  Clapperboard,
  Flame,
  Smartphone,
  MessageSquare,
  ChevronRight,
  Sliders,
  Copy,
  Hash,
  Share2,
  Tag,
  PenTool,
  BookmarkPlus,
  Eye,
  Music,
  Clock,
  Layers,
  ArrowRight,
} from 'lucide-react';

type NarrationToastState = { kind: 'busy' | 'done' | 'error'; msg: string } | null;

function NarrationToast({ toast, onClose }: { toast: NarrationToastState; onClose: () => void }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (toast) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setShow(true));
      });
    } else {
      setShow(false);
    }
  }, [toast]);

  if (!toast) return null;

  return createPortal(
    <div className="fixed top-4 right-4 z-[9999] pointer-events-none">
      <div
        className={`pointer-events-auto w-84 rounded-2xl shadow-2xl border transition-all duration-300 ease-out ${
          show ? 'translate-x-0 opacity-100 scale-100' : 'translate-x-[120%] opacity-0 scale-95'
        } ${
          toast.kind === 'error'
            ? 'bg-red-950/95 border-red-800/60 text-red-200'
            : toast.kind === 'done'
            ? 'bg-emerald-950/95 border-emerald-800/60 text-emerald-200'
            : 'bg-[#151821]/95 border-blue-500/40 text-blue-200 shadow-blue-950/40'
        } backdrop-blur-xl p-4`}
      >
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-2">
            {toast.kind === 'busy' && <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />}
            {toast.kind === 'done' && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
            {toast.kind === 'error' && <XCircle className="w-4 h-4 text-red-400" />}
            <span className="text-xs font-bold uppercase tracking-wider text-white">
              {toast.kind === 'busy' ? 'Processing' : toast.kind === 'done' ? 'Completed' : 'Notice'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white transition-colors p-1 -mr-1 -mt-1 rounded-lg hover:bg-white/10"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <p className="text-xs leading-relaxed opacity-90">{toast.msg}</p>
      </div>
    </div>,
    document.body
  );
}

const RECAP_STYLES = [
  {
    id: 'recap_tiktok',
    label: '📱 TikTok & Reels Fast Recap (សម្រាយរឿងបែប TikTok & Reels)',
    tag: 'TikTok Viral Hook',
    desc: 'High energy, rapid 2.5s scene pacing, Cambodian character nicknames & high-retention suspense hooks',
    icon: <Smartphone className="w-4 h-4 text-pink-400" />,
    color: 'from-pink-900/40 via-purple-900/30 to-zinc-900/50 border-pink-500/40',
  },
  {
    id: 'recap_viral',
    label: '🔥 Viral Movie Recap (សម្រាយរឿងបែប Viral / ហ្វេសប៊ុក & យូធូប)',
    tag: 'Top Trending',
    desc: 'Suspenseful opening hook, fast-moving scene commentary, and viral climax suited for Cambodian viewers',
    icon: <Flame className="w-4 h-4 text-amber-400" />,
    color: 'from-amber-900/40 via-orange-900/30 to-zinc-900/50 border-amber-500/40',
  },
  {
    id: 'recap_comedy',
    label: '😂 Comedy & Funny Commentary (សម្រាយរឿងបែបកំប្លែង & សើចសប្បាយ)',
    tag: 'Humorous',
    desc: 'Hilarious nicknames, funny slang, teasing characters and comedic sarcasm throughout scenes',
    icon: <Sparkles className="w-4 h-4 text-yellow-400" />,
    color: 'from-yellow-900/40 via-amber-900/30 to-zinc-900/50 border-yellow-500/40',
  },
  {
    id: 'recap_action',
    label: '⚔️ Action & Martial Arts Battle (សម្រាយរឿងបែបវាយប្រហារ & ក្បាច់គុន)',
    tag: 'High Stakes',
    desc: 'Rapid-fire, punchy verbs, high stakes martial arts & battles',
    icon: <Zap className="w-4 h-4 text-emerald-400" />,
    color: 'from-emerald-900/40 via-teal-900/30 to-zinc-900/50 border-emerald-500/40',
  },
  {
    id: 'recap_cinema',
    label: '🎭 Cinematic Drama (សម្រាយរឿងបែបភាពយន្ត & មនោសញ្ចេតនា)',
    tag: 'Emotional',
    desc: 'Deep emotional gravity, rich narrative arc, captivating atmosphere and character drama',
    icon: <Film className="w-4 h-4 text-blue-400" />,
    color: 'from-blue-900/40 via-indigo-900/30 to-zinc-900/50 border-blue-500/40',
  },
  {
    id: 'recap_suspense',
    label: '🕵️ Mystery & Suspense (សម្រាយរឿងបែបអាថ៌កំបាំង & ស៊ើបអង្កេត)',
    tag: 'Thriller',
    desc: 'Dark secrets, cliffhangers, psychological tension and shocking plot twist revelations',
    icon: <Clapperboard className="w-4 h-4 text-purple-400" />,
    color: 'from-purple-900/40 via-pink-900/30 to-zinc-900/50 border-purple-500/40',
  },
  {
    id: 'documentary',
    label: '🎙️ Formal Documentary Voiceover (ការអត្ថាធិប្បាយបែបផ្លូវការ)',
    tag: 'Educational',
    desc: 'Refined, polished, articulate narration for documentaries and professional presentations',
    icon: <BookOpen className="w-4 h-4 text-teal-400" />,
    color: 'from-teal-900/40 via-cyan-900/30 to-zinc-900/50 border-teal-500/40',
  },
  {
    id: 'summary',
    label: '⚡ Quick Story Summary (សង្ខេបសាច់រឿងខ្លីខ្លឹម)',
    tag: 'Brief Recap',
    desc: 'Ultra-concise highlight reel hitting only the major narrative beats and ending',
    icon: <Zap className="w-4 h-4 text-zinc-400" />,
    color: 'from-zinc-800/40 via-zinc-900/30 to-zinc-900/50 border-zinc-600/40',
  },
];

const LANGUAGES = [
  { id: 'km', label: '🇰🇭 ភាសាខ្មែរ (Khmer)' },
  { id: 'en', label: '🇺🇸 English' },
  { id: 'zh', label: '🇨🇳 中文 (Chinese)' },
  { id: 'th', label: '🇹🇭 ภาษาไทย (Thai)' },
  { id: 'vi', label: '🇻🇳 Tiếng Việt (Vietnamese)' },
  { id: 'ja', label: '🇯🇵 日本語 (Japanese)' },
  { id: 'ko', label: '🇰🇷 한국어 (Korean)' },
];

const KHMER_VOICES = [
  {
    id: 'km-KH-PisethNeural',
    name: 'Piseth (បុរស)',
    gender: 'male',
    avatar: '👨‍💼',
    desc: 'Energetic, deep, and viral male voiceover suited for movie recaps',
  },
  {
    id: 'km-KH-SreymomNeural',
    name: 'Sreymom (នារី)',
    gender: 'female',
    avatar: '👩‍💼',
    desc: 'Sweet, emotional, and captivating female narration',
  },
];

const GLOBAL_VOICES = [
  { id: 'female', name: 'Female Voice', gender: 'female', avatar: '👩', desc: 'Standard Female Voiceover' },
  { id: 'male', name: 'Male Voice', gender: 'male', avatar: '👨', desc: 'Standard Male Voiceover' },
];

interface NarrationPanelProps {
  initialTab?: 'narration' | 'social';
  hideInnerTabs?: boolean;
}

export function NarrationPanel({ initialTab = 'narration', hideInnerTabs = true }: NarrationPanelProps = {}) {
  const { currentProject, loadProject, updateProjectName } = useProjectStore();

  // Top sub-tab state: 'narration' | 'social'
  const [activeTab, setActiveTab] = useState<'narration' | 'social'>(initialTab);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  // Narration Form State
  const [style, setStyle] = useState('recap_tiktok');
  const [language, setLanguage] = useState('km');
  const [voice, setVoice] = useState('km-KH-PisethNeural');
  const [promptHint, setPromptHint] = useState('');

  // Execution States
  const [isGenerating, setIsGenerating] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [narrationSegments, setNarrationSegments] = useState<NarrationSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<NarrationToastState>(null);
  const [showPreview, setShowPreview] = useState(false);

  // Script in-place editor
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState('');

  // Audio Preview states
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  const [audioLoadingIdx, setAudioLoadingIdx] = useState<number | null>(null);
  const [auditioningVoiceId, setAuditioningVoiceId] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // Social Media Script State
  const [topicInput, setTopicInput] = useState(currentProject?.name || '');
  const [socialPlatform, setSocialPlatform] = useState<'tiktok' | 'youtube_shorts' | 'facebook_reels' | 'instagram_reels'>('tiktok');
  const [socialTone, setSocialTone] = useState<'suspense' | 'fast_action' | 'dramatic' | 'humor' | 'twist'>('suspense');
  const [socialDuration, setSocialDuration] = useState<'15-30s' | '30-60s' | '60-90s'>('30-60s');
  const [socialCustomNotes, setSocialCustomNotes] = useState('');
  const [showSocialNotes, setShowSocialNotes] = useState(false);
  const [isGeneratingSocial, setIsGeneratingSocial] = useState(false);
  const [isApplyingSocialBlocks, setIsApplyingSocialBlocks] = useState(false);
  const [socialScript, setSocialScript] = useState<SocialMediaScriptResult | null>(null);
  const [copiedFullPost, setCopiedFullPost] = useState(false);
  const [copiedHook, setCopiedHook] = useState(false);
  const [copiedHashtags, setCopiedHashtags] = useState(false);
  const [copiedPinnedComment, setCopiedPinnedComment] = useState(false);
  const [copiedCueSheet, setCopiedCueSheet] = useState(false);
  const [copiedChip, setCopiedChip] = useState<string | null>(null);
  const [playingBlockIdx, setPlayingBlockIdx] = useState<number | null>(null);
  const [blockAudioLoadingIdx, setBlockAudioLoadingIdx] = useState<number | null>(null);
  const socialResultRef = useRef<HTMLDivElement | null>(null);

  const hasVideo = !!currentProject?.video_path || !!currentProject?.video_filename || !!(currentProject?.segments && currentProject.segments.length > 0) || !!currentProject?.id;

  // Restore cached social script from localStorage on project switch
  useEffect(() => {
    if (currentProject?.id) {
      try {
        const cached = localStorage.getItem(`social_script_${currentProject.id}`);
        if (cached) {
          setSocialScript(JSON.parse(cached));
        }
      } catch (e) {
        console.error('Failed to load cached social script:', e);
      }
    }
  }, [currentProject?.id]);

  // Sync topic input with project
  useEffect(() => {
    if (currentProject?.name) {
      setTopicInput(currentProject.name);
    }
  }, [currentProject?.name]);

  // Auto-clean audio on unmount
  useEffect(() => {
    return () => {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current = null;
      }
    };
  }, []);

  // Auto-hide done/error toasts
  useEffect(() => {
    if (!toast || toast.kind === 'busy') return;
    const timer = setTimeout(() => setToast(null), toast.kind === 'error' ? 6000 : 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const handleGenerate = async () => {
    if (!currentProject) return;
    setIsGenerating(true);
    setError(null);
    setNarrationSegments([]);
    setToast({ kind: 'busy', msg: 'Analyzing video scenes & composing viral movie recap...' });
    try {
      const result = await generateNarration(currentProject.id, language, style, promptHint);
      setNarrationSegments(result.segments);
      setToast(null);
      setShowPreview(true);
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e.message || 'Failed to generate movie recap narration';
      setError(msg);
      setToast({ kind: 'error', msg });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleApply = async () => {
    if (!currentProject || narrationSegments.length === 0) return;
    const existing = currentProject.segments?.length || 0;
    if (existing > 0) {
      if (!confirm(`This will replace ${existing} existing subtitle line(s) with your movie recap narration. Proceed?`))
        return;
    }
    setIsApplying(true);
    setError(null);
    setToast({ kind: 'busy', msg: 'Injecting narration script and synthesizing character speech...' });
    try {
      await applyNarration(currentProject.id, narrationSegments, voice);
      await loadProject(currentProject.id);
      setNarrationSegments([]);
      setShowPreview(false);
      setToast({ kind: 'done', msg: 'Movie recap narration applied to timeline successfully!' });
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e.message || 'Failed to apply narration';
      setError(msg);
      setToast({ kind: 'error', msg });
    } finally {
      setIsApplying(false);
    }
  };

  const handleApplySocialBlocksToTimeline = async () => {
    if (!currentProject || !socialScript?.blocks || socialScript.blocks.length === 0) return;
    const existing = currentProject.segments?.length || 0;
    if (existing > 0) {
      if (!confirm(`This will replace ${existing} existing subtitle line(s) with the ${socialScript.blocks.length} production voiceover lines. Proceed?`))
        return;
    }

    setIsApplyingSocialBlocks(true);
    setError(null);
    setToast({ kind: 'busy', msg: 'Injecting voiceover script into timeline & synthesizing speech...' });

    try {
      const segmentsToApply: NarrationSegment[] = socialScript.blocks.map((b, idx) => ({
        index: idx,
        start_time: Number(b.start_time) || idx * 8,
        end_time: Number(b.end_time) || (idx + 1) * 8,
        text: b.voiceover || b.text_on_screen || '',
        type: 'narration',
        speaker: 'Narrator',
        gender: voice.includes('Piseth') || voice === 'male' ? 'male' : 'female',
        emotion: 'excited',
      }));

      await applyNarration(currentProject.id, segmentsToApply, voice);
      await loadProject(currentProject.id);
      setToast({ kind: 'done', msg: 'Short-form voiceover script applied to timeline successfully!' });
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e.message || 'Failed to apply script to timeline';
      setError(msg);
      setToast({ kind: 'error', msg });
    } finally {
      setIsApplyingSocialBlocks(false);
    }
  };

  const handleOpenSocialInEditor = () => {
    if (!socialScript?.blocks || socialScript.blocks.length === 0) return;
    const segments: NarrationSegment[] = socialScript.blocks.map((b, idx) => ({
      index: idx,
      start_time: Number(b.start_time) || idx * 8,
      end_time: Number(b.end_time) || (idx + 1) * 8,
      text: b.voiceover || b.text_on_screen || '',
      type: 'narration',
      speaker: 'Narrator',
      gender: voice.includes('Piseth') || voice === 'male' ? 'male' : 'female',
      emotion: 'excited',
    }));
    setNarrationSegments(segments);
    setShowPreview(true);
  };

  const handlePlayLineSample = async (seg: NarrationSegment, idx: number) => {
    if (playingIdx === idx) {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current = null;
      }
      setPlayingIdx(null);
      return;
    }

    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
    }

    setAudioLoadingIdx(idx);
    try {
      if (!currentProject?.id) return;
      const res = await generateTtsPreview(currentProject.id, {
        text: seg.text,
        voice_profile: seg.gender === 'male' ? 'male' : 'female',
        emotion: seg.emotion || 'neutral',
        speed: 1.0,
      });

      if (res.audio_url) {
        const audio = new Audio(res.audio_url);
        previewAudioRef.current = audio;
        audio.onended = () => setPlayingIdx(null);
        audio.onerror = () => setPlayingIdx(null);
        await audio.play();
        setPlayingIdx(idx);
      }
    } catch (e) {
      console.error('Audio preview error:', e);
    } finally {
      setAudioLoadingIdx(null);
    }
  };

  const handleAuditionVoice = async (voiceId: string) => {
    if (!currentProject) return;
    if (auditioningVoiceId === voiceId) {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current = null;
      }
      setAuditioningVoiceId(null);
      return;
    }

    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
    }

    const sampleText = voiceId.includes('Sreymom')
      ? 'ជម្រាបសួរ! ខ្ញុំជាស្រីមុំ អ្នកអត្ថាធិប្បាយរឿងភាពយន្តរបស់អ្នក។'
      : 'ជម្រាបសួរ! ខ្ញុំជាពិសិដ្ឋ អ្នកសម្រាយសាច់រឿងភាពយន្តលំដាប់កំពូល។';
    const profile = voiceId.includes('Sreymom') ? 'female' : 'male';
    try {
      setAuditioningVoiceId(voiceId);
      const res = await generateTtsPreview(currentProject.id, {
        text: sampleText,
        voice_name: voiceId,
        voice_profile: profile,
        emotion: 'excited',
        speed: 1.0,
      });
      const audio_url = res.audio_url || (res as any)?.data?.audio_url;
      if (audio_url) {
        const audio = new Audio(audio_url);
        previewAudioRef.current = audio;
        audio.onended = () => setAuditioningVoiceId(null);
        audio.onerror = () => setAuditioningVoiceId(null);
        await audio.play();
      }
    } catch {
      setAuditioningVoiceId(null);
    }
  };

  const handleEditStart = (idx: number) => {
    setEditingIdx(idx);
    setEditText(narrationSegments[idx].text);
  };

  const handleEditSave = () => {
    if (editingIdx === null) return;
    setNarrationSegments((prev) =>
      prev.map((s, i) => (i === editingIdx ? { ...s, text: editText } : s))
    );
    setEditingIdx(null);
  };

  const handleDelete = (idx: number) => {
    setNarrationSegments((prev) => prev.filter((_, i) => i !== idx));
  };

  // Social Media Script Handler
  const handleGenerateSocial = async () => {
    if (!currentProject) return;
    setIsGeneratingSocial(true);
    setError(null);
    setToast({ kind: 'busy', msg: `Composing ${socialPlatform} short-form script & package...` });
    try {
      const data = await generateSocialMediaScript(currentProject.id, {
        originalTitle: topicInput,
        language,
        platform: socialPlatform,
        tone: socialTone,
        durationTarget: socialDuration,
        customNotes: socialCustomNotes,
      });
      setSocialScript(data);
      try {
        localStorage.setItem(`social_script_${currentProject.id}`, JSON.stringify(data));
      } catch (e) {}

      // Convert blocks to narration segments so the interactive preview player & timeline mapper has full data
      if (data.blocks && data.blocks.length > 0) {
        const segments: NarrationSegment[] = data.blocks.map((b, idx) => ({
          index: idx,
          start_time: Number(b.start_time) || idx * 8,
          end_time: Number(b.end_time) || (idx + 1) * 8,
          text: b.voiceover || b.text_on_screen || '',
          type: 'narration',
          speaker: 'Narrator',
          gender: voice.includes('Piseth') || voice === 'male' ? 'male' : 'female',
          emotion: 'excited',
        }));
        setNarrationSegments(segments);
      }

      setToast(null);
      // Automatically open the full interactive script editor & audio preview modal!
      setShowPreview(true);
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e.message || 'Failed to generate social media script';
      setError(msg);
      setToast({ kind: 'error', msg });
    } finally {
      setIsGeneratingSocial(false);
    }
  };

  const handleCopyFullPost = () => {
    if (!socialScript) return;
    navigator.clipboard.writeText(socialScript.full_post);
    setCopiedFullPost(true);
    setTimeout(() => setCopiedFullPost(false), 2500);
  };

  const handleCopyHook = () => {
    if (!socialScript) return;
    navigator.clipboard.writeText(socialScript.hook);
    setCopiedHook(true);
    setTimeout(() => setCopiedHook(false), 2500);
  };

  const handleCopyHashtags = () => {
    if (!socialScript) return;
    navigator.clipboard.writeText(socialScript.hashtags.join(' '));
    setCopiedHashtags(true);
    setTimeout(() => setCopiedHashtags(false), 2500);
  };

  const handleCopyPinnedComment = () => {
    if (!socialScript?.pinned_comment) return;
    navigator.clipboard.writeText(socialScript.pinned_comment);
    setCopiedPinnedComment(true);
    setTimeout(() => setCopiedPinnedComment(false), 2500);
  };

  const handleCopyCueSheet = () => {
    if (!socialScript) return;
    let cueSheet = socialScript.full_script_markdown || '';
    if (!cueSheet && socialScript.blocks) {
      cueSheet = `# ${socialScript.title || 'Short-Form Video Production Cue Sheet'}\n\n`;
      cueSheet += `**Platform**: ${socialScript.platform || socialPlatform} | **Duration**: ${socialScript.total_duration || socialDuration} | **Tone**: ${socialScript.tone || socialTone}\n\n`;
      cueSheet += `| Time Range | Scene / Shot | On-Screen Text | Voiceover Line | SFX |\n`;
      cueSheet += `|---|---|---|---|---|\n`;
      for (const b of socialScript.blocks) {
        cueSheet += `| ${b.time_range} | ${b.visual || '-'} | ${b.text_on_screen || '-'} | ${b.voiceover || '-'} | ${b.sound_effect || '-'} |\n`;
      }
    }
    navigator.clipboard.writeText(cueSheet);
    setCopiedCueSheet(true);
    setTimeout(() => setCopiedCueSheet(false), 2500);
  };

  const handlePlayBlockVoiceover = async (text: string, idx: number) => {
    if (playingBlockIdx === idx) {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current = null;
      }
      setPlayingBlockIdx(null);
      return;
    }

    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
    }

    if (!currentProject?.id) return;
    setBlockAudioLoadingIdx(idx);
    try {
      const { audio_url } = await generateTtsPreview(currentProject.id, {
        text,
        voice_name: voice,
        voice_profile: voice.includes('Piseth') || voice === 'male' ? 'male' : 'female',
        emotion: 'excited',
      });
      if (audio_url) {
        const audio = new Audio(audio_url);
        previewAudioRef.current = audio;
        audio.onended = () => setPlayingBlockIdx(null);
        audio.onerror = () => setPlayingBlockIdx(null);
        await audio.play();
        setPlayingBlockIdx(idx);
      }
    } catch (e: any) {
      setToast({ kind: 'error', msg: 'Failed to generate voice preview' });
    } finally {
      setBlockAudioLoadingIdx(null);
    }
  };

  const handleCopyChip = (tag: string) => {
    navigator.clipboard.writeText(tag);
    setCopiedChip(tag);
    setTimeout(() => setCopiedChip(null), 2000);
  };

  const formatTime = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (!hasVideo) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center bg-[#121316] text-[#e1e3e6]">
        <div className="w-16 h-16 rounded-2xl bg-[#1c1f28] border border-[#2c3140] flex items-center justify-center text-zinc-500 mb-4 shadow-inner">
          <Clapperboard className="w-8 h-8 text-indigo-400" />
        </div>
        <h3 className="text-sm font-bold text-white mb-1">Movie Recap Narration Studio</h3>
        <p className="text-xs text-zinc-400 max-w-xs leading-relaxed">
          Upload or import a movie/video clip first to generate viral commentary, titles, and social scripts.
        </p>
      </div>
    );
  }

  const voiceList = language === 'km' ? KHMER_VOICES : GLOBAL_VOICES;

  return (
    <div className="flex flex-col h-full overflow-y-auto overflow-x-hidden scroll-smooth scrollbar-thin scrollbar-thumb-zinc-700/50 hover:scrollbar-thumb-zinc-600/70 scrollbar-track-transparent p-4 space-y-4 bg-[#121316] text-[#e1e3e6] select-none font-sans [contain:content]">
      <NarrationToast toast={toast} onClose={() => setToast(null)} />

      {/* Top Main Navigation Tabs (Only shown if hideInnerTabs is false) */}
      {!hideInnerTabs && (
        <div className="flex items-center p-1 bg-[#181a24] rounded-2xl border border-[#272b3a] shadow-md shadow-black/40">
          <button
            onClick={() => setActiveTab('narration')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-bold transition-all ${
              activeTab === 'narration'
                ? 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-md shadow-purple-950/40'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Mic className="w-3.5 h-3.5" />
            <span>AI Recap Narration</span>
          </button>

          <button
            onClick={() => setActiveTab('social')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-bold transition-all ${
              activeTab === 'social'
                ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-md shadow-pink-950/40'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Share2 className="w-3.5 h-3.5" />
            <span>Shorts & Social Script</span>
          </button>
        </div>
      )}

      {/* TAB 1: AI RECAP NARRATION */}
      {activeTab === 'narration' && (
        <div className="space-y-4 animate-in fade-in duration-200">
          {/* Header Banner */}
          <div className="p-4 rounded-2xl bg-gradient-to-br from-[#161a29] via-[#1b172a] to-[#12141c] border border-[#2b3145] shadow-xl shadow-black/30 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-500 via-purple-600 to-pink-500 flex items-center justify-center text-white shadow-lg shadow-purple-950/50 shrink-0">
                  <Mic className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-white tracking-wide">AI Movie Recap Studio</h3>
                    <span className="text-[9px] px-2 py-0.5 rounded-full bg-gradient-to-r from-indigo-500/20 to-purple-500/20 text-indigo-300 border border-indigo-500/30 font-bold uppercase tracking-wider">
                      PRO RECAPPERS
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Generate viral Khmer narrative commentary with synchronized voiceover
                  </p>
                </div>
              </div>

              {currentProject?.duration ? (
                <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-black/40 border border-zinc-800 text-[11px] font-mono text-zinc-400">
                  <Clock className="w-3 h-3 text-indigo-400" />
                  <span>{formatTime(currentProject.duration)}</span>
                </div>
              ) : null}
            </div>
          </div>

          {/* Recap Style Selector */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-bold text-zinc-300 uppercase tracking-wider flex items-center gap-1.5">
                <Clapperboard className="w-3.5 h-3.5 text-amber-400" />
                Presentation Style
              </label>
              <span className="text-[10px] text-zinc-500">Choose storytelling tone</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {RECAP_STYLES.map((s) => {
                const isSel = style === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setStyle(s.id)}
                    className={`p-3 rounded-2xl border text-left transition-all cursor-pointer relative overflow-hidden group ${
                      isSel
                        ? `bg-gradient-to-br ${s.color} text-white shadow-lg shadow-black/40 ring-1 ring-white/20`
                        : 'bg-[#151722] border-[#242838] hover:border-[#3a415a] hover:bg-[#1a1d2c] text-zinc-300'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-6 h-6 rounded-lg flex items-center justify-center ${
                            isSel ? 'bg-white/20 text-white' : 'bg-[#1e2230] text-zinc-400'
                          }`}
                        >
                          {s.icon}
                        </div>
                        <span className="font-bold text-xs text-white">{s.label.split('(')[0]}</span>
                      </div>
                      <span className="text-[9px] px-2 py-0.5 rounded-full bg-black/40 text-zinc-300 font-semibold border border-white/5">
                        {s.tag}
                      </span>
                    </div>
                    <p className="text-[10px] text-zinc-400 leading-relaxed line-clamp-2">{s.desc}</p>

                    {isSel && (
                      <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-pink-500 shadow-[0_0_8px_rgba(236,72,153,0.8)]" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Lead Narrator Voice Selection with Live Audition */}
          <div className="space-y-2 pt-1 border-t border-[#1e212f]">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-bold text-zinc-300 uppercase tracking-wider flex items-center gap-1.5">
                <Volume2 className="w-3.5 h-3.5 text-purple-400" />
                Lead Narrator Voice
              </label>
              <span className="text-[10px] text-zinc-500">Audition voice before generating</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {voiceList.map((v) => {
                const isSel = voice === v.id;
                const isAuditioning = auditioningVoiceId === v.id;
                return (
                  <div
                    key={v.id}
                    onClick={() => setVoice(v.id)}
                    className={`p-3 rounded-2xl border transition-all cursor-pointer flex flex-col justify-between gap-2.5 ${
                      isSel
                        ? 'bg-gradient-to-br from-[#201d36] to-[#161825] border-purple-500/60 shadow-lg shadow-purple-950/30 ring-1 ring-purple-500/40'
                        : 'bg-[#151722] border-[#242838] hover:border-zinc-700 hover:bg-[#1a1d2c]'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-600/30 to-pink-600/30 border border-purple-500/30 flex items-center justify-center text-lg shadow-inner">
                          {v.avatar}
                        </div>
                        <div>
                          <div className="text-xs font-bold text-white flex items-center gap-1.5">
                            <span>{v.name}</span>
                            {isSel && (
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
                            )}
                          </div>
                          <span className="text-[10px] text-zinc-400 font-medium">
                            {v.gender === 'male' ? 'Deep & Cinematic Male' : 'Expressive Female'}
                          </span>
                        </div>
                      </div>

                      {/* Live Audition Button */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleAuditionVoice(v.id);
                        }}
                        className={`px-2.5 py-1 rounded-xl text-[10px] font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                          isAuditioning
                            ? 'bg-pink-600 text-white shadow-md shadow-pink-950/50 animate-pulse'
                            : 'bg-[#222638] hover:bg-[#2e344c] text-purple-300 hover:text-white border border-purple-500/20'
                        }`}
                        title="Audition Sample"
                      >
                        {isAuditioning ? (
                          <>
                            <Pause className="w-3 h-3" />
                            <span>Playing</span>
                          </>
                        ) : (
                          <>
                            <Play className="w-3 h-3" />
                            <span>Sample</span>
                          </>
                        )}
                      </button>
                    </div>

                    <p className="text-[10px] text-zinc-400 leading-relaxed line-clamp-1">{v.desc}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Language Selection */}
          <div className="space-y-1.5 pt-1">
            <label className="text-[11px] font-bold text-zinc-300 uppercase tracking-wider block">
              Language Output
            </label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full bg-[#151722] border border-[#262b3d] rounded-xl px-3.5 py-2 text-xs text-white focus:border-purple-500 focus:outline-none cursor-pointer"
            >
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          {/* Creative Director Prompt & Quick Idea Chips */}
          <div className="space-y-2 pt-1 border-t border-[#1e212f]">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-bold text-zinc-300 uppercase tracking-wider flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-purple-400" />
                Director Prompt & Tone Customization
              </label>
              {promptHint && (
                <button
                  type="button"
                  onClick={() => setPromptHint('')}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300"
                >
                  Clear
                </button>
              )}
            </div>

            {/* Quick Prompt Chips */}
            <div className="flex flex-wrap gap-1.5">
              {[
                { label: '⚔️ Hype Martial Arts Battles', text: 'Highlight intense martial arts fights, special sword skills, and weapon clashes.' },
                { label: '🕵️ Dark Villain Master Plan', text: 'Build suspense around the main villain secret plan, betrayal, and hidden identity.' },
                { label: '🎭 Emotional Character Revenge', text: 'Emphasize deep character sorrow, family sacrifice, romantic tragedy, and revenge.' },
                { label: '🔥 Fast-Paced Viral Pacing', text: 'Fast-paced storytelling with punchy comedic reactions and shocking cliffhangers.' },
              ].map((chip, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setPromptHint((prev) => (prev ? `${prev} ${chip.text}` : chip.text))}
                  className="text-[10px] px-2.5 py-1 rounded-xl bg-[#171926] hover:bg-[#23273c] border border-[#272c40] hover:border-purple-500/40 text-zinc-300 hover:text-white transition-all cursor-pointer"
                >
                  {chip.label}
                </button>
              ))}
            </div>

            <textarea
              value={promptHint}
              onChange={(e) => setPromptHint(e.target.value)}
              placeholder="e.g. Focus heavily on the main villain's secret plan, make the battle climax intense, highlight character revenge..."
              rows={2}
              className="w-full bg-[#13151f] border border-[#262b3d] rounded-2xl p-3 text-xs text-white placeholder-zinc-500 focus:border-purple-500 focus:outline-none resize-none leading-relaxed shadow-inner"
            />
          </div>

          {/* Generate Action Button */}
          <button
            onClick={handleGenerate}
            disabled={isGenerating || !hasVideo}
            className="w-full flex items-center justify-center gap-2.5 py-3.5 rounded-2xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white text-xs font-bold transition-all shadow-xl shadow-indigo-950/50 active:scale-98 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Analyzing Video & Composing Script...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                <span>Generate Full Movie Recap Script</span>
              </>
            )}
          </button>

          {/* Error Message */}
          {error && (
            <div className="flex items-start gap-2 p-3.5 rounded-2xl bg-red-950/40 border border-red-800/60 text-red-300 text-xs animate-in fade-in">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Generated Script Master Station */}
          {narrationSegments.length > 0 && (
            <div className="p-4 rounded-2xl bg-[#151722] border border-[#2a2f42] space-y-3.5 animate-in fade-in duration-200 shadow-xl">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold">
                    <CheckCircle2 className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-white">Recap Production Script Ready</h4>
                    <p className="text-[10px] text-zinc-400">
                      {narrationSegments.length} timeline scenes · Lead Voice: {voiceList.find((v) => v.id === voice)?.name || 'Piseth'}
                    </p>
                  </div>
                </div>

                <button
                  onClick={() => setShowPreview(true)}
                  className="px-3 py-1.5 rounded-xl bg-[#22273a] hover:bg-[#2d344e] text-purple-300 hover:text-white text-[11px] font-bold transition-all flex items-center gap-1.5 cursor-pointer border border-purple-500/20"
                >
                  <Play className="w-3 h-3" />
                  <span>Full Editor</span>
                </button>
              </div>

              {/* Action Buttons: Apply to Timeline */}
              <div className="flex gap-2">
                <button
                  onClick={handleApply}
                  disabled={isApplying}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-50 text-white text-xs font-bold shadow-lg shadow-emerald-950/40 transition-all cursor-pointer active:scale-95"
                >
                  {isApplying ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Synthesizing Voice & Injecting Timeline...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Apply Narration to Timeline</span>
                    </>
                  )}
                </button>
              </div>

              {/* Quick Segments Preview List */}
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1 custom-scrollbar">
                {narrationSegments.map((seg, idx) => (
                  <div
                    key={idx}
                    className="p-2.5 rounded-xl bg-[#10121a] border border-[#232738] hover:border-purple-500/30 transition-all space-y-1.5"
                  >
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="font-mono font-bold text-indigo-400 bg-[#171a26] px-1.5 py-0.5 rounded border border-[#252a3d]">
                        Scene #{idx + 1} ({formatTime(seg.start_time)} - {formatTime(seg.end_time)})
                      </span>
                      <button
                        type="button"
                        onClick={() => handlePlayLineSample(seg, idx)}
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1 cursor-pointer transition-all ${
                          playingIdx === idx
                            ? 'bg-pink-600 text-white'
                            : 'bg-[#1b1f2e] text-purple-300 hover:bg-[#252b40]'
                        }`}
                      >
                        {audioLoadingIdx === idx ? (
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                        ) : playingIdx === idx ? (
                          <Pause className="w-2.5 h-2.5" />
                        ) : (
                          <Play className="w-2.5 h-2.5" />
                        )}
                        <span>{playingIdx === idx ? 'Playing' : 'Listen'}</span>
                      </button>
                    </div>
                    <p className="text-xs text-zinc-200 font-khmer leading-relaxed select-text">
                      "{seg.text}"
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: SHORTS & SOCIAL MEDIA PRODUCTION SCRIPT STUDIO */}
      {activeTab === 'social' && (
        <div className="space-y-4 animate-in fade-in duration-200">
          {/* Main Controls Card */}
          <div className="p-3.5 rounded-2xl bg-gradient-to-r from-[#24172f] to-[#171524] border border-[#3b284e] shadow-lg shadow-black/20 space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-500 to-pink-600 flex items-center justify-center text-white shadow-md shadow-pink-950/40 shrink-0">
                <Share2 className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-white tracking-wide">Short-Form Script & Social Studio</h3>
                <p className="text-[10px] text-zinc-400">Director cues, visual shots, on-screen text, voiceovers & viral SEO metadata</p>
              </div>
            </div>

            {/* Topic Input */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">
                Movie Title / Topic
              </label>
              <input
                type="text"
                value={topicInput}
                onChange={(e) => setTopicInput(e.target.value)}
                placeholder="e.g. Blade of the Guardians / យុទ្ធសិល្ប៍ដាវទេព..."
                className="w-full bg-[#12141c] border border-[#282d3e] rounded-xl px-3 py-2 text-xs text-white placeholder-zinc-500 focus:border-pink-500 focus:outline-none"
              />
            </div>

            {/* Target Platform Selector */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">
                Target Platform
              </label>
              <div className="grid grid-cols-4 gap-1.5">
                {[
                  { id: 'tiktok', label: 'TikTok', icon: '🎵' },
                  { id: 'youtube_shorts', label: 'Shorts', icon: '🔴' },
                  { id: 'facebook_reels', label: 'FB Reels', icon: '🔵' },
                  { id: 'instagram_reels', label: 'IG Reels', icon: '📸' },
                ].map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSocialPlatform(p.id as any)}
                    className={`py-1.5 px-2 rounded-xl text-[11px] font-semibold flex items-center justify-center gap-1 transition-all border ${
                      socialPlatform === p.id
                        ? 'bg-pink-600 text-white border-pink-400 shadow-md shadow-pink-950/40'
                        : 'bg-[#141622] text-zinc-400 border-[#262a3d] hover:text-white hover:border-zinc-600'
                    }`}
                  >
                    <span>{p.icon}</span>
                    <span>{p.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Tone Selector */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">
                Narrative Tone & Vibe
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { id: 'suspense', label: '🔥 Suspense' },
                  { id: 'fast_action', label: '⚡ Fast Action' },
                  { id: 'dramatic', label: '🎭 Dramatic' },
                  { id: 'humor', label: '😂 Witty Humor' },
                  { id: 'twist', label: '🧠 Plot Twist' },
                ].map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSocialTone(t.id as any)}
                    className={`py-1.5 px-2 rounded-xl text-[10px] font-semibold text-center transition-all border ${
                      socialTone === t.id
                        ? 'bg-purple-600 text-white border-purple-400 shadow-md shadow-purple-950/40'
                        : 'bg-[#141622] text-zinc-400 border-[#262a3d] hover:text-white hover:border-zinc-600'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Target Duration Selector */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">
                Target Video Duration
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { id: '15-30s', label: '⚡ 15-30s (Ultra-Punchy)' },
                  { id: '30-60s', label: '⏱️ 30-60s (Standard)' },
                  { id: '60-90s', label: '🎬 60-90s (Extended)' },
                ].map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setSocialDuration(d.id as any)}
                    className={`py-1.5 px-2 rounded-xl text-[10px] font-semibold text-center transition-all border ${
                      socialDuration === d.id
                        ? 'bg-indigo-600 text-white border-indigo-400 shadow-md shadow-indigo-950/40'
                        : 'bg-[#141622] text-zinc-400 border-[#262a3d] hover:text-white hover:border-zinc-600'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Optional Custom Notes */}
            <div>
              <button
                type="button"
                onClick={() => setShowSocialNotes(!showSocialNotes)}
                className="text-[10px] text-pink-400 hover:text-pink-300 font-semibold flex items-center gap-1 transition-colors"
              >
                <span>{showSocialNotes ? '− Hide Custom Instructions' : '+ Add Custom Director Instructions (Optional)'}</span>
              </button>
              {showSocialNotes && (
                <div className="mt-2">
                  <textarea
                    rows={2}
                    value={socialCustomNotes}
                    onChange={(e) => setSocialCustomNotes(e.target.value)}
                    placeholder="e.g. Focus on the betrayal scene, make the ending leave a big question..."
                    className="w-full bg-[#12141c] border border-[#282d3e] rounded-xl px-3 py-2 text-xs text-white placeholder-zinc-500 focus:border-pink-500 focus:outline-none"
                  />
                </div>
              )}
            </div>

            {/* Generate Button */}
            <button
              onClick={handleGenerateSocial}
              disabled={isGeneratingSocial}
              className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-purple-600 via-pink-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white text-xs font-bold transition-all shadow-md shadow-pink-950/40 disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer active:scale-98"
            >
              {isGeneratingSocial ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
              <span>{isGeneratingSocial ? 'Composing Script & Package...' : 'Generate Shorts & Social Package'}</span>
            </button>
          </div>

          {/* Social Script Output */}
          {socialScript && (
            <div ref={socialResultRef} className="space-y-3 pt-1">
              {/* Quick Actions Bar */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={handleCopyFullPost}
                  className="py-2 px-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-bold shadow-lg shadow-emerald-950/40 transition-all flex items-center justify-center gap-1.5 active:scale-98 cursor-pointer"
                >
                  {copiedFullPost ? <Check className="w-3.5 h-3.5 text-white" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedFullPost ? 'Copied Full Post!' : 'Copy Social Caption'}</span>
                </button>

                <button
                  onClick={handleCopyCueSheet}
                  className="py-2 px-3 rounded-xl bg-[#232736] hover:bg-[#2d3346] text-zinc-200 hover:text-white border border-[#353d54] text-xs font-bold transition-all flex items-center justify-center gap-1.5 active:scale-98 cursor-pointer"
                >
                  {copiedCueSheet ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <BookOpen className="w-3.5 h-3.5 text-indigo-400" />}
                  <span>{copiedCueSheet ? 'Copied Cue Sheet!' : 'Copy Cue Sheet'}</span>
                </button>
              </div>

              {socialScript.blocks && socialScript.blocks.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    onClick={handleApplySocialBlocksToTimeline}
                    disabled={isApplyingSocialBlocks}
                    className="py-2.5 px-3 rounded-xl bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 hover:from-indigo-500 hover:to-pink-500 text-white text-xs font-bold shadow-lg shadow-purple-950/40 transition-all flex items-center justify-center gap-1.5 active:scale-98 disabled:opacity-50 cursor-pointer"
                  >
                    {isApplyingSocialBlocks ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Play className="w-3.5 h-3.5 fill-white" />
                    )}
                    <span>{isApplyingSocialBlocks ? 'Applying to Timeline...' : 'Apply to Timeline'}</span>
                  </button>

                  <button
                    onClick={handleOpenSocialInEditor}
                    className="py-2.5 px-3 rounded-xl bg-[#202534] hover:bg-[#2c3246] text-indigo-200 hover:text-white border border-indigo-500/30 text-xs font-bold transition-all flex items-center justify-center gap-1.5 active:scale-98 cursor-pointer"
                  >
                    <BookOpen className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Preview in Full Editor</span>
                  </button>
                </div>
              )}

              {/* Overview Stats Badges */}
              {(socialScript.total_duration || socialScript.tone || socialScript.bgm_suggestion) && (
                <div className="p-3 rounded-xl bg-[#171924] border border-[#272b3c] grid grid-cols-1 gap-2 text-xs">
                  {socialScript.total_duration && (
                    <div className="flex items-center gap-2 text-zinc-300">
                      <Clock className="w-3.5 h-3.5 text-indigo-400" />
                      <span className="text-zinc-500 text-[10px]">Duration:</span>
                      <span className="font-semibold text-white">{socialScript.total_duration}</span>
                    </div>
                  )}
                  {socialScript.tone && (
                    <div className="flex items-center gap-2 text-zinc-300">
                      <Flame className="w-3.5 h-3.5 text-pink-400" />
                      <span className="text-zinc-500 text-[10px]">Tone:</span>
                      <span className="font-semibold text-white">{socialScript.tone}</span>
                    </div>
                  )}
                  {socialScript.bgm_suggestion && (
                    <div className="flex items-center gap-2 text-zinc-300">
                      <Music className="w-3.5 h-3.5 text-amber-400" />
                      <span className="text-zinc-500 text-[10px]">BGM:</span>
                      <span className="font-semibold text-white">{socialScript.bgm_suggestion}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Pinned Comment Box */}
              {socialScript.pinned_comment && (
                <div className="p-3 rounded-xl bg-[#171e29] border border-[#27384e] space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-1">
                      <MessageSquare className="w-3 h-3" /> Pinned Comment (Debate Starter)
                    </span>
                    <button
                      onClick={handleCopyPinnedComment}
                      className="text-[10px] text-cyan-300 hover:text-white flex items-center gap-1 bg-[#1e2a3b] hover:bg-[#27374d] px-2 py-0.5 rounded cursor-pointer transition-colors"
                    >
                      {copiedPinnedComment ? <Check className="w-2.5 h-2.5 text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
                      <span>{copiedPinnedComment ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <p className="text-xs font-bold text-cyan-100 font-khmer leading-relaxed select-text">
                    "{socialScript.pinned_comment}"
                  </p>
                </div>
              )}

              {/* Director Video Editing Tips */}
              {socialScript.editing_tips && socialScript.editing_tips.length > 0 && (
                <div className="p-3 rounded-xl bg-[#1d1726] border border-[#3b274c] space-y-1.5">
                  <span className="text-[10px] font-bold text-pink-400 uppercase tracking-wider flex items-center gap-1">
                    <Sparkles className="w-3 h-3" /> Pro Video Editing Tips
                  </span>
                  <ul className="space-y-1 text-[11px] text-zinc-300">
                    {socialScript.editing_tips.map((tip, idx) => (
                      <li key={idx} className="flex items-start gap-1.5">
                        <span className="text-pink-400 mt-0.5">•</span>
                        <span>{tip}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Script Blocks Breakdown (Director Scene Cues) */}
              {socialScript.blocks && socialScript.blocks.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
                      <Layers className="w-3.5 h-3.5 text-indigo-400" />
                      Director Scene Blocks ({socialScript.blocks.length})
                    </span>
                  </div>

                  <div className="space-y-2.5">
                    {socialScript.blocks.map((block, idx) => (
                      <div
                        key={idx}
                        className="p-3 rounded-xl bg-[#161823] border border-[#262b3d] hover:border-purple-500/40 transition-all space-y-2 group"
                      >
                        {/* Header */}
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono font-bold bg-[#212638] text-indigo-300 px-2 py-0.5 rounded border border-[#2f3750]">
                              {block.time_range || `${block.start_time}s - ${block.end_time}s`}
                            </span>
                            <span className="text-xs font-bold text-white">
                              {block.block_name}
                            </span>
                          </div>
                          {block.voiceover_tone && (
                            <span className="text-[9px] px-2 py-0.5 rounded-full bg-pink-500/20 text-pink-300 font-semibold border border-pink-500/30">
                              {block.voiceover_tone}
                            </span>
                          )}
                        </div>

                        {/* Visual & Sound Effect */}
                        {block.visual && (
                          <div className="flex items-start gap-1.5 text-[11px] text-zinc-300 bg-[#12141c] p-2 rounded-lg border border-[#212534]">
                            <Eye className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
                            <div>
                              <span className="text-zinc-500 text-[10px] block font-semibold uppercase">Visual Shot:</span>
                              <span>{block.visual}</span>
                            </div>
                          </div>
                        )}

                        {block.sound_effect && (
                          <div className="flex items-center gap-1.5 text-[10px] text-indigo-300 bg-[#151928] px-2 py-1 rounded border border-indigo-500/20">
                            <Zap className="w-3 h-3 text-indigo-400 shrink-0" />
                            <span className="font-semibold">SFX:</span>
                            <span>{block.sound_effect}</span>
                          </div>
                        )}

                        {block.text_on_screen && (
                          <div className="flex items-start gap-1.5 text-[11px] text-amber-300 bg-[#1a1714] p-2 rounded-lg border border-amber-500/20">
                            <Tag className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                            <div>
                              <span className="text-amber-500/80 text-[10px] block font-semibold uppercase">On-Screen Text / Sticker:</span>
                              <span className="font-bold">{block.text_on_screen}</span>
                            </div>
                          </div>
                        )}

                        {/* Spoken Voiceover Line with Preview Audio */}
                        {block.voiceover && (
                          <div className="text-xs text-white bg-[#1a1424] p-2.5 rounded-lg border border-purple-500/30 space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="text-purple-400 text-[10px] font-semibold uppercase flex items-center gap-1">
                                <Mic className="w-3 h-3" /> Voiceover Line
                              </span>
                              <button
                                type="button"
                                onClick={() => handlePlayBlockVoiceover(block.voiceover, idx)}
                                disabled={blockAudioLoadingIdx === idx}
                                className={`px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1 transition-all cursor-pointer ${
                                  playingBlockIdx === idx
                                    ? 'bg-pink-600 text-white'
                                    : 'bg-[#291e3b] hover:bg-[#382a52] text-purple-200'
                                }`}
                              >
                                {blockAudioLoadingIdx === idx ? (
                                  <Loader2 className="w-2.5 h-2.5 animate-spin" />
                                ) : playingBlockIdx === idx ? (
                                  <Pause className="w-2.5 h-2.5" />
                                ) : (
                                  <Play className="w-2.5 h-2.5" />
                                )}
                                <span>{playingBlockIdx === idx ? 'Playing' : 'Listen Voice'}</span>
                              </button>
                            </div>
                            <p className="leading-relaxed font-khmer font-medium italic select-text">
                              "{block.voiceover}"
                            </p>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Hook Box */}
              <div className="p-3 rounded-xl bg-[#171924] border border-[#272b3c] space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-pink-400 uppercase tracking-wider flex items-center gap-1">
                    <Flame className="w-3 h-3" /> Catchy Hook
                  </span>
                  <button
                    onClick={handleCopyHook}
                    className="text-[10px] text-zinc-400 hover:text-white flex items-center gap-1 bg-[#222634] px-2 py-0.5 rounded cursor-pointer"
                  >
                    {copiedHook ? <Check className="w-2.5 h-2.5 text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
                    <span>{copiedHook ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <p className="text-xs font-bold text-white font-khmer leading-relaxed select-text">
                  {socialScript.hook}
                </p>
              </div>

              {/* Synopsis Box */}
              <div className="p-3 rounded-xl bg-[#171924] border border-[#272b3c] space-y-1.5">
                <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider flex items-center gap-1">
                  <Film className="w-3 h-3" /> Story Synopsis
                </span>
                <p className="text-xs text-zinc-300 font-khmer leading-relaxed whitespace-pre-line select-text">
                  {socialScript.synopsis}
                </p>
              </div>

              {/* Call to Action Box */}
              <div className="p-3 rounded-xl bg-[#171924] border border-[#272b3c] space-y-1.5">
                <span className="text-[10px] font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1">
                  <Zap className="w-3 h-3" /> Call to Action (CTA)
                </span>
                <p className="text-xs text-zinc-300 font-khmer leading-relaxed whitespace-pre-line select-text">
                  {socialScript.call_to_action}
                </p>
              </div>

              {/* Hashtags Box */}
              <div className="p-3 rounded-xl bg-[#171924] border border-[#272b3c] space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-teal-400 uppercase tracking-wider flex items-center gap-1">
                    <Hash className="w-3 h-3" /> Viral Hashtags & SEO Tags
                  </span>
                  <button
                    onClick={handleCopyHashtags}
                    className="text-[10px] text-zinc-400 hover:text-white flex items-center gap-1 bg-[#222634] px-2 py-0.5 rounded cursor-pointer"
                  >
                    {copiedHashtags ? <Check className="w-2.5 h-2.5 text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
                    <span>{copiedHashtags ? 'Copied' : 'Copy All'}</span>
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(socialScript.hashtags || []).map((tag, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleCopyChip(tag)}
                      className={`text-[10px] px-2 py-1 rounded-lg border transition-all cursor-pointer ${
                        copiedChip === tag
                          ? 'bg-emerald-600/30 border-emerald-500/50 text-emerald-200'
                          : 'bg-[#1e2230] border-[#2e354a] text-zinc-300 hover:text-white hover:border-teal-500/50'
                      }`}
                      title="Click to copy hashtag"
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Comprehensive Script Editor & Audio Preview Modal */}
      {showPreview &&
        narrationSegments.length > 0 &&
        createPortal(
          <div
            className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50 p-4 animate-in fade-in duration-200"
            onClick={() => setShowPreview(false)}
          >
            <div
              className="bg-[#13151c] border border-[#272b38] rounded-2xl w-full max-w-3xl shadow-2xl shadow-black/80 max-h-[88vh] flex flex-col overflow-hidden text-[#e2e4e9]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-[#20242f] bg-[#161822] shrink-0">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center text-white shadow-md shadow-indigo-950/40">
                    <Clapperboard className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-white">
                      {activeTab === 'social' ? 'Shorts & Social Production Script' : 'Movie Recap Narration Script'}
                    </h2>
                    <p className="text-[11px] text-zinc-400">
                      {narrationSegments.length} timeline segments · Click text to edit · Audition single lines
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowPreview(false)}
                  className="p-1.5 hover:bg-[#232734] rounded-xl text-zinc-400 hover:text-white transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Segment List Feed */}
              <div className="flex-1 overflow-y-auto p-5 space-y-2.5 bg-[#101217]">
                {narrationSegments.map((seg, idx) => {
                  const isAudioLoading = audioLoadingIdx === idx;
                  const isAudioPlaying = playingIdx === idx;
                  const isDialogue = seg.type === 'dialogue';

                  return (
                    <div
                      key={idx}
                      className={`p-3 rounded-xl border transition-all group ${
                        isDialogue
                          ? 'bg-[#161c29] border-blue-500/30 hover:border-blue-500/50'
                          : 'bg-[#151720] border-[#252834] hover:border-[#383d4e]'
                      }`}
                    >
                      {/* Top Meta Bar */}
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono text-zinc-400 font-semibold bg-[#1c1f2a] px-2 py-0.5 rounded-md border border-[#2b3040]">
                            {formatTime(seg.start_time)} → {formatTime(seg.end_time)}
                          </span>

                          {isDialogue ? (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30 flex items-center gap-1">
                              <MessageSquare className="w-2.5 h-2.5" />
                              <span>{seg.speaker || 'In-Scene Dialogue'}</span>
                              {seg.gender === 'male' ? ' 👔' : ' 🎀'}
                            </span>
                          ) : (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 flex items-center gap-1">
                              <Mic className="w-2.5 h-2.5" />
                              <span>Narrator Voiceover</span>
                            </span>
                          )}

                          {seg.emotion && (
                            <span className="text-[9px] px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-400 font-mono">
                              {seg.emotion}
                            </span>
                          )}
                        </div>

                        {/* Action buttons */}
                        <div className="flex items-center gap-1">
                          {/* Audition Button */}
                          <button
                            onClick={() => handlePlayLineSample(seg, idx)}
                            disabled={isAudioLoading}
                            className={`p-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all ${
                              isAudioPlaying
                                ? 'bg-purple-600 text-white'
                                : 'bg-[#212530] hover:bg-[#2b303f] text-zinc-300 hover:text-white'
                            }`}
                            title="Audition Audio"
                          >
                            {isAudioLoading ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-400" />
                            ) : isAudioPlaying ? (
                              <Pause className="w-3.5 h-3.5" />
                            ) : (
                              <Play className="w-3.5 h-3.5" />
                            )}
                          </button>

                          {/* Delete Button */}
                          <button
                            onClick={() => handleDelete(idx)}
                            className="p-1.5 hover:bg-red-500/20 rounded-lg text-zinc-500 hover:text-red-400 transition-colors"
                            title="Remove Line"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Text Content / In-place Editor */}
                      {editingIdx === idx ? (
                        <div className="flex gap-2">
                          <textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            className="flex-1 bg-[#101218] border border-blue-500/80 rounded-xl p-2.5 text-xs text-white font-khmer focus:outline-none leading-relaxed resize-none"
                            rows={2}
                            autoFocus
                          />
                          <button
                            onClick={handleEditSave}
                            className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold flex items-center justify-center shrink-0"
                          >
                            <Check className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <p
                          className="text-xs text-zinc-200 leading-relaxed font-khmer cursor-pointer hover:text-white transition-colors"
                          onClick={() => handleEditStart(idx)}
                          title="Click to edit script line"
                        >
                          {seg.text}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Modal Footer */}
              <div className="flex items-center justify-between px-6 py-4 border-t border-[#20242f] bg-[#161822] shrink-0">
                <button
                  onClick={handleGenerate}
                  disabled={isGenerating}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-zinc-300 border border-[#2f3545] hover:bg-[#232734] transition-all disabled:opacity-50"
                  title="Regenerate Narration"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Regenerate</span>
                </button>

                <div className="flex items-center gap-2.5">
                  <button
                    onClick={() => setShowPreview(false)}
                    className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>

                  <button
                    onClick={handleApply}
                    disabled={isApplying || narrationSegments.length === 0}
                    className="flex items-center gap-2 px-5 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-bold shadow-lg shadow-emerald-950/40 transition-all active:scale-95 disabled:opacity-50"
                  >
                    {isApplying ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Applying & Generating Audio...</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5" />
                        <span>Apply as Subtitles & Generate Audio</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

export default NarrationPanel;
