import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useProjectStore } from '../stores/projectStore';
import {
  generateNarration,
  applyNarration,
  generateTtsPreview,
  suggestMovieTitles,
  generateSocialMediaScript,
  type NarrationSegment,
  type ViralTitleItem,
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

export function NarrationPanel() {
  const { currentProject, loadProject, updateProjectName } = useProjectStore();

  // Top sub-tab state: 'narration' | 'titles' | 'social'
  const [activeTab, setActiveTab] = useState<'narration' | 'titles' | 'social'>('narration');

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
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // Viral Titles State
  const [movieTitleInput, setMovieTitleInput] = useState(currentProject?.name || '');
  const [isGeneratingTitles, setIsGeneratingTitles] = useState(false);
  const [suggestedTitles, setSuggestedTitles] = useState<ViralTitleItem[]>([]);
  const [copiedTitleIdx, setCopiedTitleIdx] = useState<number | null>(null);
  const [appliedTitleIdx, setAppliedTitleIdx] = useState<number | null>(null);

  // Social Media Script State
  const [isGeneratingSocial, setIsGeneratingSocial] = useState(false);
  const [isApplyingSocialBlocks, setIsApplyingSocialBlocks] = useState(false);
  const [socialScript, setSocialScript] = useState<SocialMediaScriptResult | null>(null);
  const [copiedFullPost, setCopiedFullPost] = useState(false);
  const [copiedHook, setCopiedHook] = useState(false);
  const [copiedHashtags, setCopiedHashtags] = useState(false);
  const [copiedChip, setCopiedChip] = useState<string | null>(null);

  const hasVideo = !!currentProject?.video_path;

  // Sync title input with project
  useEffect(() => {
    if (currentProject?.name) {
      setMovieTitleInput(currentProject.name);
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

  // Title Generator Handler
  const handleSuggestTitles = async () => {
    if (!currentProject) return;
    setIsGeneratingTitles(true);
    setError(null);
    setToast({ kind: 'busy', msg: 'Generating viral movie recap titles...' });
    try {
      const data = await suggestMovieTitles(currentProject.id, movieTitleInput, language);
      setSuggestedTitles(data.titles || []);
      setToast({ kind: 'done', msg: `Generated ${data.titles?.length || 0} viral title suggestions!` });
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e.message || 'Failed to generate title suggestions';
      setError(msg);
      setToast({ kind: 'error', msg });
    } finally {
      setIsGeneratingTitles(false);
    }
  };

  const handleCopyTitle = (text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedTitleIdx(idx);
    setTimeout(() => setCopiedTitleIdx(null), 2500);
  };

  const handleApplyTitleAsProjectName = async (title: string, idx: number) => {
    if (!currentProject) return;
    try {
      if (updateProjectName) {
        await updateProjectName(title);
      }
      setAppliedTitleIdx(idx);
      setToast({ kind: 'done', msg: 'Project name updated!' });
      setTimeout(() => setAppliedTitleIdx(null), 2500);
    } catch (e) {
      console.error(e);
    }
  };

  // Social Media Script Handler
  const handleGenerateSocial = async () => {
    if (!currentProject) return;
    setIsGeneratingSocial(true);
    setError(null);
    setToast({ kind: 'busy', msg: 'Composing short-form video production script & viral package...' });
    try {
      const data = await generateSocialMediaScript(currentProject.id, movieTitleInput, language);
      setSocialScript(data);
      setToast({ kind: 'done', msg: 'Short-form production script & social package ready!' });
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
    <div className="flex flex-col h-full overflow-y-auto p-4 space-y-4 bg-[#121316] text-[#e1e3e6] select-none font-sans">
      <NarrationToast toast={toast} onClose={() => setToast(null)} />

      {/* Top Main Navigation Tabs (Inspired by Dai-Recap AI) */}
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
          onClick={() => setActiveTab('titles')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-bold transition-all ${
            activeTab === 'titles'
              ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-950/40'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>Viral Titles</span>
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

      {/* TAB 1: AI RECAP NARRATION */}
      {activeTab === 'narration' && (
        <div className="space-y-4 animate-in fade-in duration-200">
          {/* Header Banner */}
          <div className="p-3.5 rounded-2xl bg-gradient-to-r from-[#181d2c] to-[#161720] border border-[#272f42] flex items-center justify-between shadow-lg shadow-black/20">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 via-purple-600 to-pink-500 flex items-center justify-center text-white shadow-md shadow-purple-950/40">
                <Mic className="w-4 h-4" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-bold text-white tracking-wide">Movie Recap Narration Studio</h3>
                  <span className="text-[9px] px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-bold uppercase">
                    AI Scriptwriter
                  </span>
                </div>
                <p className="text-[10px] text-zinc-400">Generate viral Khmer movie recap commentary with synchronized audio</p>
              </div>
            </div>
          </div>

          {/* Recap Style Selector */}
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
              <Clapperboard className="w-3.5 h-3.5 text-amber-400" />
              Recap Presentation Style
            </label>
            <div className="grid grid-cols-1 gap-2">
              {RECAP_STYLES.map((s) => {
                const isSel = style === s.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => setStyle(s.id)}
                    className={`p-3 rounded-xl border text-left transition-all ${
                      isSel
                        ? `bg-gradient-to-r ${s.color} text-white shadow-md shadow-black/30 ring-1 ring-white/10`
                        : 'bg-[#171922] border-[#262a35] hover:border-[#3a4050] text-zinc-300'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        {s.icon}
                        <span className="font-bold text-xs text-white">{s.label}</span>
                      </div>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-black/40 text-zinc-300 font-khmer border border-white/5">
                        {s.tag}
                      </span>
                    </div>
                    <p className="text-[10px] text-zinc-400 leading-relaxed pl-6">{s.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Target Language & Voice Selection */}
          <div className="grid grid-cols-2 gap-3 pt-1 border-t border-[#1e212b]">
            {/* Language */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">Language</label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="w-full bg-[#181a22] border border-[#282d3b] rounded-xl px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Narrator Voice */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">Lead Narrator</label>
              <div className="flex gap-1.5">
                {voiceList.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => setVoice(v.id)}
                    className={`flex-1 py-1.5 px-2 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                      voice === v.id
                        ? 'bg-blue-600 border-blue-400 text-white shadow-md shadow-blue-900/30'
                        : 'bg-[#181a22] border-[#282d3b] text-zinc-400 hover:text-zinc-200'
                    }`}
                    title={v.desc}
                  >
                    <span>{v.avatar}</span>
                    <span className="truncate">{v.name.split(' ')[0]}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Custom Director's Hint (Optional) */}
          <div className="space-y-1.5 pt-1">
            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
              <Sliders className="w-3 h-3 text-purple-400" />
              Creative Director Prompt (Optional)
            </label>
            <textarea
              value={promptHint}
              onChange={(e) => setPromptHint(e.target.value)}
              placeholder="e.g. Focus heavily on the main villain's secret plan, make the battle climax intense, highlight character revenge..."
              rows={2}
              className="w-full bg-[#181a22] border border-[#282d3b] rounded-xl p-2.5 text-xs text-white placeholder-zinc-500 focus:border-purple-500 focus:outline-none resize-none leading-relaxed"
            />
          </div>

          {/* Generate Action Button */}
          <button
            onClick={handleGenerate}
            disabled={isGenerating || !hasVideo}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white text-xs font-bold transition-all shadow-lg shadow-indigo-950/40 active:scale-98 disabled:opacity-50 disabled:cursor-not-allowed"
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
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-950/40 border border-red-800/60 text-red-300 text-xs animate-in fade-in">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Preview Trigger Button (When segments are available) */}
          {narrationSegments.length > 0 && !showPreview && (
            <button
              onClick={() => setShowPreview(true)}
              className="w-full flex items-center justify-between p-3 rounded-xl border border-indigo-500/40 bg-indigo-950/30 hover:bg-indigo-900/40 text-indigo-200 text-xs font-bold transition-all"
            >
              <div className="flex items-center gap-2">
                <Play className="w-3.5 h-3.5 text-indigo-400" />
                <span>Open Script Editor ({narrationSegments.length} segments ready)</span>
              </div>
              <ChevronRight className="w-4 h-4 text-indigo-400" />
            </button>
          )}
        </div>
      )}

      {/* TAB 2: VIRAL TITLE SUGGESTIONS */}
      {activeTab === 'titles' && (
        <div className="space-y-4 animate-in fade-in duration-200">
          <div className="p-3.5 rounded-2xl bg-gradient-to-r from-[#172033] to-[#151724] border border-[#2b354e] shadow-lg shadow-black/20">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white shadow-md shadow-blue-950/40">
                <Sparkles className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-white tracking-wide">Viral Movie Title Generator</h3>
                <p className="text-[10px] text-zinc-400">Generate high-CTR, click-worthy titles for Facebook Reels, TikTok & YouTube</p>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">
                Original Movie Title / Topic
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={movieTitleInput}
                  onChange={(e) => setMovieTitleInput(e.target.value)}
                  placeholder="e.g. The Legend of Swordsman / អាថ៌កំបាំងដាវពិឃាត..."
                  className="flex-1 bg-[#12141c] border border-[#282d3e] rounded-xl px-3 py-2.5 text-xs text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
                />
                <button
                  onClick={handleSuggestTitles}
                  disabled={isGeneratingTitles}
                  className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs font-bold transition-all shadow-md shadow-blue-950/40 disabled:opacity-50 flex items-center gap-1.5 shrink-0"
                >
                  {isGeneratingTitles ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5" />
                  )}
                  <span>Suggest Titles</span>
                </button>
              </div>
            </div>
          </div>

          {/* Titles List */}
          {suggestedTitles.length > 0 && (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                  Generated Title Ideas ({suggestedTitles.length})
                </span>
              </div>

              <div className="space-y-2">
                {suggestedTitles.map((t, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-xl bg-[#171924] border border-[#272b3c] hover:border-blue-500/40 transition-all flex flex-col gap-2 group"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30 font-bold">
                        {t.category_label || t.category}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleApplyTitleAsProjectName(t.title, idx)}
                          className="px-2 py-1 bg-[#222736] hover:bg-[#2e3549] text-zinc-300 hover:text-white rounded-lg text-[10px] font-semibold flex items-center gap-1 transition-colors"
                          title="Use as Project Name"
                        >
                          {appliedTitleIdx === idx ? <Check className="w-3 h-3 text-emerald-400" /> : <PenTool className="w-3 h-3" />}
                          <span>{appliedTitleIdx === idx ? 'Applied' : 'Use Title'}</span>
                        </button>
                        <button
                          onClick={() => handleCopyTitle(t.title, idx)}
                          className="px-2 py-1 bg-blue-600/30 hover:bg-blue-600/50 text-blue-200 rounded-lg text-[10px] font-semibold flex items-center gap-1 transition-colors border border-blue-500/30"
                          title="Copy Title"
                        >
                          {copiedTitleIdx === idx ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                          <span>{copiedTitleIdx === idx ? 'Copied' : 'Copy'}</span>
                        </button>
                      </div>
                    </div>
                    <p className="text-xs font-bold text-white font-khmer leading-relaxed select-text">
                      {t.title}
                    </p>
                    {t.description && (
                      <p className="text-[10px] text-zinc-400">{t.description}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: SHORTS & SOCIAL MEDIA PRODUCTION SCRIPT */}
      {activeTab === 'social' && (
        <div className="space-y-4 animate-in fade-in duration-200">
          <div className="p-3.5 rounded-2xl bg-gradient-to-r from-[#24172f] to-[#171524] border border-[#3b284e] shadow-lg shadow-black/20">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-500 to-pink-600 flex items-center justify-center text-white shadow-md shadow-pink-950/40">
                <Share2 className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-white tracking-wide">Short-Form Script & Social Package</h3>
                <p className="text-[10px] text-zinc-400">Director cues, visual shots, on-screen text, voiceovers & viral SEO metadata</p>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block">
                Original Movie Title / Topic
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={movieTitleInput}
                  onChange={(e) => setMovieTitleInput(e.target.value)}
                  placeholder="e.g. Blade of the Guardians / យុទ្ធសិល្ប៍ដាវទេព..."
                  className="flex-1 bg-[#12141c] border border-[#282d3e] rounded-xl px-3 py-2.5 text-xs text-white placeholder-zinc-500 focus:border-pink-500 focus:outline-none"
                />
                <button
                  onClick={handleGenerateSocial}
                  disabled={isGeneratingSocial}
                  className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white text-xs font-bold transition-all shadow-md shadow-pink-950/40 disabled:opacity-50 flex items-center gap-1.5 shrink-0"
                >
                  {isGeneratingSocial ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Share2 className="w-3.5 h-3.5" />
                  )}
                  <span>Generate Script</span>
                </button>
              </div>
            </div>
          </div>

          {/* Social Script Output */}
          {socialScript && (
            <div className="space-y-3">
              {/* Quick Actions Bar */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={handleCopyFullPost}
                  className="py-2.5 px-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-bold shadow-lg shadow-emerald-950/40 transition-all flex items-center justify-center gap-1.5 active:scale-98"
                >
                  {copiedFullPost ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedFullPost ? 'Copied Full Post!' : 'Copy Social Post'}</span>
                </button>

                {socialScript.blocks && socialScript.blocks.length > 0 && (
                  <button
                    onClick={handleApplySocialBlocksToTimeline}
                    disabled={isApplyingSocialBlocks}
                    className="py-2.5 px-3 rounded-xl bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 hover:from-indigo-500 hover:to-pink-500 text-white text-xs font-bold shadow-lg shadow-purple-950/40 transition-all flex items-center justify-center gap-1.5 active:scale-98 disabled:opacity-50"
                  >
                    {isApplyingSocialBlocks ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Play className="w-3.5 h-3.5" />
                    )}
                    <span>{isApplyingSocialBlocks ? 'Applying...' : 'Apply to Timeline'}</span>
                  </button>
                )}
              </div>

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

                        {/* Visual & Text on screen */}
                        {block.visual && (
                          <div className="flex items-start gap-1.5 text-[11px] text-zinc-300 bg-[#12141c] p-2 rounded-lg border border-[#212534]">
                            <Eye className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
                            <div>
                              <span className="text-zinc-500 text-[10px] block font-semibold uppercase">Visual Shot:</span>
                              <span>{block.visual}</span>
                            </div>
                          </div>
                        )}

                        {block.text_on_screen && (
                          <div className="flex items-start gap-1.5 text-[11px] text-amber-300 bg-[#1a1714] p-2 rounded-lg border border-amber-500/20">
                            <Tag className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                            <div>
                              <span className="text-amber-500/80 text-[10px] block font-semibold uppercase">On-Screen Text:</span>
                              <span className="font-bold">{block.text_on_screen}</span>
                            </div>
                          </div>
                        )}

                        {/* Spoken Voiceover */}
                        {block.voiceover && (
                          <div className="flex items-start gap-1.5 text-xs text-white bg-[#1a1424] p-2.5 rounded-lg border border-purple-500/30">
                            <Mic className="w-3.5 h-3.5 text-purple-400 shrink-0 mt-0.5" />
                            <div className="flex-1">
                              <span className="text-purple-400 text-[10px] block font-semibold uppercase">Voiceover:</span>
                              <p className="leading-relaxed font-khmer font-medium italic">"{block.voiceover}"</p>
                            </div>
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
                    className="text-[10px] text-zinc-400 hover:text-white flex items-center gap-1 bg-[#222634] px-2 py-0.5 rounded"
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
                    <Hash className="w-3 h-3" /> Viral Hashtags
                  </span>
                  <button
                    onClick={handleCopyHashtags}
                    className="text-[10px] text-zinc-400 hover:text-white flex items-center gap-1 bg-[#222634] px-2 py-0.5 rounded"
                  >
                    {copiedHashtags ? <Check className="w-2.5 h-2.5 text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
                    <span>{copiedHashtags ? 'Copied' : 'Copy All'}</span>
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {socialScript.hashtags.map((tag, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleCopyChip(tag)}
                      className={`text-[10px] px-2 py-1 rounded-lg border transition-all ${
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
                    <h2 className="text-sm font-bold text-white">Movie Recap Narration Script</h2>
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
