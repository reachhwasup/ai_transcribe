import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useProjectStore } from '../stores/projectStore';
import { generateNarration, applyNarration, type NarrationSegment } from '../api/client';
import {
  Mic,
  Loader2,
  Play,
  Check,
  AlertCircle,
  RefreshCw,
  Trash2,
  CheckCircle2,
  XCircle,
  X,
} from 'lucide-react';

type NarrationToastState = { kind: 'busy' | 'done' | 'error'; msg: string } | null;

// Floating progress toast — same look and placement as TranscribeToast
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
        className={`pointer-events-auto w-80 rounded-xl shadow-2xl border transition-all duration-300 ease-out ${
          show ? 'translate-x-0 opacity-100' : 'translate-x-[120%] opacity-0'
        } ${
          toast.kind === 'error'
            ? 'bg-red-950/95 border-red-800/60'
            : toast.kind === 'done'
            ? 'bg-emerald-950/95 border-emerald-800/60'
            : 'bg-zinc-900/95 border-zinc-700/60'
        } backdrop-blur-xl`}
      >
        <div className="flex items-center justify-between px-4 pt-3 pb-1">
          <div className="flex items-center gap-2">
            {toast.kind === 'error' ? (
              <XCircle className="w-4 h-4 text-red-400" />
            ) : toast.kind === 'done' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            ) : (
              <Mic className="w-4 h-4 text-indigo-400" />
            )}
            <span className={`text-xs font-semibold ${
              toast.kind === 'error' ? 'text-red-300' : toast.kind === 'done' ? 'text-emerald-300' : 'text-zinc-200'
            }`}>
              {toast.kind === 'error' ? 'Narration Error' : toast.kind === 'done' ? 'Done!' : 'AI Narration'}
            </span>
          </div>
          <button onClick={onClose} className="p-0.5 rounded hover:bg-white/10 transition-colors">
            <X className="w-3.5 h-3.5 text-zinc-500" />
          </button>
        </div>
        <div className="px-4 pb-3 pt-1">
          {toast.kind === 'busy' ? (
            <div className="flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin shrink-0" />
              <p className="text-[11px] text-zinc-400 leading-relaxed">{toast.msg}</p>
            </div>
          ) : (
            <p className={`text-[11px] leading-relaxed line-clamp-3 ${
              toast.kind === 'error' ? 'text-red-400/90' : 'text-emerald-400/90'
            }`}>{toast.msg}</p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

const STYLES = [
  { id: 'summary', label: '📋 Summary', desc: 'Concise recap of what happens' },
  { id: 'commentary', label: '🎤 Commentary', desc: 'Entertaining TikTok-style narration' },
  { id: 'commentary2', label: '🔥 Commentary V2', desc: 'Hook-first viral recap with cliffhanger' },
  { id: 'educational', label: '📚 Educational', desc: 'Explain and teach like a documentary' },
  { id: 'story', label: '📖 Story', desc: 'Turn the video into a compelling story' },
];

const LANGUAGES = [
  { id: 'km', label: '🇰🇭 ខ្មែរ (Khmer)' },
  { id: 'en', label: '🇺🇸 English' },
  { id: 'zh', label: '🇨🇳 中文 (Chinese)' },
  { id: 'ja', label: '🇯🇵 日本語 (Japanese)' },
  { id: 'ko', label: '🇰🇷 한국어 (Korean)' },
  { id: 'th', label: '🇹🇭 ไทย (Thai)' },
  { id: 'vi', label: '🇻🇳 Tiếng Việt' },
  { id: 'fr', label: '🇫🇷 Français' },
  { id: 'es', label: '🇪🇸 Español' },
  { id: 'de', label: '🇩🇪 Deutsch' },
];

const VOICES = [
  { id: 'female', label: '🎀 Female' },
  { id: 'male', label: '👔 Male' },
  { id: 'young', label: '🧒 Young' },
  { id: 'old', label: '👴 Old' },
];

// Microsoft's Khmer neural voices — shown by name when narrating in Khmer
const KHMER_VOICES = [
  { id: 'female', label: '🎀 ស្រីមុំ (Sreymom)' },
  { id: 'male', label: '👔 ពិសិដ្ឋ (Piseth)' },
];

export default function NarrationPanel() {
  const { currentProject, loadProject } = useProjectStore();
  const [style, setStyle] = useState('summary');
  const [language, setLanguage] = useState(currentProject?.language || 'km');
  const [voice, setVoice] = useState('female');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [narrationSegments, setNarrationSegments] = useState<NarrationSegment[]>([]);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [toast, setToast] = useState<NarrationToastState>(null);
  const [showPreview, setShowPreview] = useState(false);

  const hasVideo = !!currentProject?.video_path;

  // Khmer has two named voices — snap young/old to the matching one
  useEffect(() => {
    if (language === 'km' && (voice === 'young' || voice === 'old')) {
      setVoice(voice === 'young' ? 'female' : 'male');
    }
  }, [language, voice]);

  // Auto-hide done/error toasts (like TranscribeToast)
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
    setToast({ kind: 'busy', msg: 'Analyzing video & writing narration script...' });
    try {
      const result = await generateNarration(currentProject.id, language, style);
      setNarrationSegments(result.segments);
      setToast(null);
      setShowPreview(true);
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e.message || 'Failed to generate narration';
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
      if (!confirm(`This will replace ${existing} existing subtitle segment(s) with the narration. Continue?`)) return;
    }
    setIsApplying(true);
    setError(null);
    setToast({ kind: 'busy', msg: 'Applying narration as subtitles...' });
    try {
      await applyNarration(currentProject.id, narrationSegments, voice);
      await loadProject(currentProject.id);
      setNarrationSegments([]);
      setShowPreview(false);
      setToast({ kind: 'done', msg: 'Narration applied — subtitles replaced.' });
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e.message || 'Failed to apply narration';
      setError(msg);
      setToast({ kind: 'error', msg });
    } finally {
      setIsApplying(false);
    }
  };

  const handleEditStart = (idx: number) => {
    setEditingIdx(idx);
    setEditText(narrationSegments[idx].text);
  };

  const handleEditSave = () => {
    if (editingIdx === null) return;
    setNarrationSegments(prev =>
      prev.map((s, i) => i === editingIdx ? { ...s, text: editText } : s)
    );
    setEditingIdx(null);
  };

  const handleDelete = (idx: number) => {
    setNarrationSegments(prev => prev.filter((_, i) => i !== idx));
  };

  const formatTime = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (!hasVideo) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <Mic className="w-10 h-10 text-zinc-600 mb-3" />
        <p className="text-sm text-zinc-400">Upload a video first to generate AI narration</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-auto p-3 gap-3">
      <NarrationToast toast={toast} onClose={() => setToast(null)} />
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
          <Mic className="w-4 h-4 text-white" />
        </div>
        <div>
          <h3 className="text-sm font-bold" style={{ color: 'var(--text-bright)' }}>AI Narration</h3>
          <p className="text-[10px] text-zinc-500">Generate voiceover script from video</p>
        </div>
      </div>

      {/* Style Selection */}
      <div>
        <label className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide mb-1.5 block">
          Narration Style
        </label>
        <div className="grid grid-cols-2 gap-1.5">
          {STYLES.map(s => (
            <button
              key={s.id}
              onClick={() => setStyle(s.id)}
              className={`text-left px-2.5 py-2 rounded-lg border transition-all text-xs ${
                style === s.id
                  ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                  : 'border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-600'
              }`}
            >
              <div className="font-medium">{s.label}</div>
              <div className="text-[9px] mt-0.5 opacity-70">{s.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Language */}
      <div>
        <label className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide mb-1.5 block">
          Language
        </label>
        <select
          value={language}
          onChange={e => setLanguage(e.target.value)}
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
        >
          {LANGUAGES.map(l => (
            <option key={l.id} value={l.id}>{l.label}</option>
          ))}
        </select>
      </div>

      {/* Voice */}
      <div>
        <label className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide mb-1.5 block">
          Voice for TTS
        </label>
        <div className="flex gap-2">
          {(language === 'km' ? KHMER_VOICES : VOICES).map(v => (
            <button
              key={v.id}
              onClick={() => setVoice(v.id)}
              className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                voice === v.id
                  ? v.id === 'female'
                    ? 'border-pink-500 bg-pink-500/10 text-pink-300'
                    : v.id === 'young'
                    ? 'border-green-500 bg-green-500/10 text-green-300'
                    : v.id === 'old'
                    ? 'border-amber-500 bg-amber-500/10 text-amber-300'
                    : 'border-blue-500 bg-blue-500/10 text-blue-300'
                  : 'border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-600'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        {language === 'km' && (
          <p className="text-[9px] text-zinc-600 mt-1.5">
            Microsoft Khmer neural voices (km-KH) — dialogue lines automatically use the matching male/female voice.
          </p>
        )}
      </div>

      {/* Generate Button */}
      <button
        onClick={handleGenerate}
        disabled={isGenerating || !hasVideo}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-indigo-500/20"
      >
        <Mic className="w-4 h-4" />
        Generate Narration
      </button>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-900/30 border border-red-800 text-red-300 text-xs">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Reopen preview if it was closed without applying */}
      {narrationSegments.length > 0 && !showPreview && (
        <button
          onClick={() => setShowPreview(true)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-indigo-700/60 bg-indigo-900/20 text-indigo-300 text-xs font-medium hover:bg-indigo-900/40 transition-colors"
        >
          <Play className="w-3.5 h-3.5" />
          Open Preview ({narrationSegments.length} segments)
        </button>
      )}

      {/* Preview Modal */}
      {showPreview && narrationSegments.length > 0 && createPortal(
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowPreview(false)}>
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-2xl mx-4 shadow-2xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
              <div className="flex items-center gap-2">
                <Mic className="w-5 h-5 text-indigo-400" />
                <h2 className="text-lg font-semibold text-white">Narration Preview</h2>
                <span className="text-xs text-zinc-500">{narrationSegments.length} segments</span>
              </div>
              <button onClick={() => setShowPreview(false)} className="p-1.5 hover:bg-zinc-800 rounded-lg transition-colors">
                <X className="w-4 h-4 text-zinc-400" />
              </button>
            </div>

            {/* Segment list */}
            <div className="flex-1 overflow-auto px-5 py-3">
              <div className="rounded-lg border border-zinc-700 divide-y divide-zinc-800">
                {narrationSegments.map((seg, idx) => (
                  <div key={idx} className="px-3 py-2.5 hover:bg-zinc-800/50 group">
                    <div className="flex items-center justify-between mb-1">
                      <span className="flex items-center gap-2 text-[10px] text-zinc-600 font-mono">
                        {formatTime(seg.start_time)} → {formatTime(seg.end_time)}
                        {seg.type === 'dialogue' && (
                          <span className="px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300 font-sans">
                            💬 {seg.speaker || 'Actor'}{seg.gender === 'male' ? ' 👔' : seg.gender === 'female' ? ' 🎀' : ''}
                          </span>
                        )}
                      </span>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => handleDelete(idx)}
                          className="p-0.5 text-red-500 hover:text-red-400"
                          title="Remove segment"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    {editingIdx === idx ? (
                      <div className="flex gap-1">
                        <textarea
                          value={editText}
                          onChange={e => setEditText(e.target.value)}
                          className="flex-1 bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none resize-none"
                          rows={2}
                          autoFocus
                        />
                        <button
                          onClick={handleEditSave}
                          className="px-2 py-1 bg-indigo-600 text-white rounded text-[10px]"
                        >
                          <Check className="w-3 h-3" />
                        </button>
                      </div>
                    ) : (
                      <p
                        className="text-xs text-zinc-300 leading-relaxed cursor-pointer hover:text-zinc-100"
                        onClick={() => handleEditStart(idx)}
                        title="Click to edit"
                      >
                        {seg.text}
                      </p>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-zinc-600 text-center mt-2">
                Click any text to edit it. Applying replaces your existing subtitles.
              </p>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-zinc-800 shrink-0">
              <button
                onClick={handleGenerate}
                disabled={isGenerating}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs text-indigo-300 border border-indigo-800/60 hover:bg-indigo-900/30 transition-colors disabled:opacity-50"
                title="Regenerate"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Redo
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowPreview(false)}
                  className="px-4 py-2 rounded-lg text-xs text-zinc-400 border border-zinc-700 hover:bg-zinc-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleApply}
                  disabled={isApplying || narrationSegments.length === 0}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 text-white text-xs font-semibold transition-all disabled:opacity-50 shadow-lg shadow-green-500/20"
                >
                  <Play className="w-3.5 h-3.5" />
                  Apply as Subtitles & Generate Audio
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
