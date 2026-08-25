import { useEffect, useRef, useState, useMemo } from 'react';
import { useProjectStore } from '../stores/projectStore';
import {
  importSrtFile,
  translateSegments,
  translateSegmentsStream,
  fillMissingCaptions,
  shiftProjectTimestamps,
  getExportUrl,
  type TranslateProgressEvent,
} from '../api/client';
import type { Segment } from '../types';
import { buildClipLayout, timelineToSource } from '../utils/clipTimemap';
import CaptionPropertiesPanel from './CaptionPropertiesPanel';
import {
  UploadCloud,
  ChevronDown,
  Play,
  Pencil,
  Trash2,
  Loader2,
  Sparkles,
  Plus,
  Languages,
  FileText,
  Palette,
  Search,
  X,
  Download,
  Check,
  User,
  RotateCcw,
} from 'lucide-react';

const SUPPORTED_LANGUAGES = [
  { id: 'km', name: 'Khmer (ខ្មែរ)', flag: '🇰🇭' },
  { id: 'auto', name: 'Auto (Original Audio)', flag: '🌐' },
  { id: 'en', name: 'English', flag: '🇺🇸' },
  { id: 'zh', name: 'Chinese (中文)', flag: '🇨🇳' },
  { id: 'ja', name: 'Japanese (日本語)', flag: '🇯🇵' },
  { id: 'ko', name: 'Korean (한국어)', flag: '🇰🇷' },
  { id: 'th', name: 'Thai (ไทย)', flag: '🇹🇭' },
  { id: 'vi', name: 'Vietnamese', flag: '🇻🇳' },
  { id: 'fr', name: 'French', flag: '🇫🇷' },
  { id: 'es', name: 'Spanish', flag: '🇪🇸' },
];

const EXPORT_FORMATS = [
  { fmt: 'srt', label: 'SubRip Subtitle (.SRT)', desc: 'Standard video subtitles' },
  { fmt: 'vtt', label: 'WebVTT File (.VTT)', desc: 'Web video subtitle format' },
  { fmt: 'txt', label: 'Plain Text (.TXT)', desc: 'Full text dialogue script' },
  { fmt: 'json', label: 'JSON Dataset (.JSON)', desc: 'Timed subtitle objects' },
];

interface Props {
  videoRef?: React.RefObject<HTMLVideoElement | null>;
}

export default function SubtitleDataPanel({ videoRef }: Props) {
  const {
    currentProject,
    activeSegmentId,
    currentTime,
    setCurrentTime,
    isPlaying,
    videoClips,
    updateSegment,
    deleteSegment,
    deleteAllSegments,
    addSegment,
    setActiveSegment,
    isTranscribing,
    transcribeProgress,
    transcribePercent,
    transcribeChunkInfo,
    generateTranscript,
    loadProject,
  } = useProjectStore();

  const clipLayout = useMemo(() => buildClipLayout(videoClips), [videoClips]);

  const seekToSegment = (seg: Segment) => {
    setActiveSegment(seg.id);
    setCurrentTime(seg.start_time);
    if (videoRef?.current) {
      if (clipLayout.length > 0) {
        const res = timelineToSource(clipLayout, seg.start_time);
        videoRef.current.currentTime = res ? res.sourceTime : seg.start_time;
      } else {
        videoRef.current.currentTime = seg.start_time;
      }
    }
  };

  const segments = currentProject?.segments || [];

  // Active top tab: 'captions' or 'style'
  const [panelTab, setPanelTab] = useState<'captions' | 'style'>('captions');
  const [selectedLanguage, setSelectedLanguage] = useState(SUPPORTED_LANGUAGES[0]);
  const [showLangDropdown, setShowLangDropdown] = useState(false);
  const [showExportDropdown, setShowExportDropdown] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');

  // Import, Translate & Gap Filling states
  const [isImporting, setIsImporting] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [isFillingGaps, setIsFillingGaps] = useState(false);
  const [fillGapsStatus, setFillGapsStatus] = useState<string | null>(null);
  const [singleTranslatingId, setSingleTranslatingId] = useState<string | null>(null);
  const [translationProgress, setTranslationProgress] = useState<TranslateProgressEvent | null>(null);
  const translateAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Inline editing
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const activeRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to active playing subtitle only when paused/clicked (prevents list jumping during playback)
  useEffect(() => {
    if (activeSegmentId && activeRef.current && !isPlaying) {
      activeRef.current.scrollIntoView({ behavior: 'auto', block: 'nearest' });
    }
  }, [activeSegmentId, isPlaying]);

  // Auto-scroll to newly generated segments
  const prevCountRef = useRef(segments.length);
  useEffect(() => {
    if (isTranscribing && segments.length > prevCountRef.current) {
      const last = segments[segments.length - 1];
      if (last) {
        const el = document.getElementById(`seg-${last.id}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
    prevCountRef.current = segments.length;
  }, [segments.length, isTranscribing]);

  // Auto-scroll to currently translating segment
  useEffect(() => {
    if (isTranslating && translationProgress?.segmentId) {
      const el = document.getElementById(`seg-${translationProgress.segmentId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [isTranslating, translationProgress?.segmentId]);

  useEffect(() => {
    return () => {
      if (translateAbortRef.current) {
        translateAbortRef.current.abort();
      }
    };
  }, []);

  const handleImportSrt = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProject?.id) return;
    setIsImporting(true);
    try {
      await importSrtFile(currentProject.id, file);
      await loadProject(currentProject.id);
    } catch (err) {
      console.error('Import failed:', err);
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleExport = (format: string) => {
    if (!currentProject?.id) return;
    const url = getExportUrl(currentProject.id, format, selectedLanguage.id);
    window.open(url, '_blank');
    setShowExportDropdown(false);
  };

  const handleTranslateAll = () => {
    if (!currentProject?.id || segments.length === 0) return;
    if (isTranslating && translateAbortRef.current) {
      translateAbortRef.current.abort();
      setIsTranslating(false);
      setTranslationProgress(null);
      return;
    }

    const targetLang = (selectedLanguage.id && selectedLanguage.id !== 'auto') ? selectedLanguage.id : (currentProject.language || 'km');
    setIsTranslating(true);
    setTranslationProgress({ current: 0, total: segments.length, percent: 0 });

    const controller = translateSegmentsStream(
      currentProject.id,
      targetLang,
      undefined,
      (progress) => setTranslationProgress(progress),
      (updatedSeg) => {
        useProjectStore.setState((state) => ({
          currentProject: state.currentProject
            ? {
                ...state.currentProject,
                segments: state.currentProject.segments.map((s) =>
                  s.id === updatedSeg.id ? { ...s, text: updatedSeg.text, speaker: updatedSeg.speaker || s.speaker } : s
                ),
              }
            : null,
        }));
      },
      async () => {
        setIsTranslating(false);
        setTranslationProgress(null);
        translateAbortRef.current = null;
        await loadProject(currentProject.id);
      },
      async () => {
        setIsTranslating(false);
        setTranslationProgress(null);
        translateAbortRef.current = null;
        await loadProject(currentProject.id);
      }
    );

    translateAbortRef.current = controller;
  };

  const handleTranslateSingleLine = async (segId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentProject?.id || !segId) return;
    const targetLang = (selectedLanguage.id && selectedLanguage.id !== 'auto') ? selectedLanguage.id : (currentProject.language || 'km');
    setSingleTranslatingId(segId);
    try {
      await translateSegments(currentProject.id, targetLang, [segId]);
      await loadProject(currentProject.id);
    } catch (err) {
      console.error('Failed to translate line:', err);
    } finally {
      setSingleTranslatingId(null);
    }
  };

  const handleFillMissingGaps = async () => {
    if (!currentProject?.id || isFillingGaps) return;
    setIsFillingGaps(true);
    setFillGapsStatus('Scanning video for blank gaps...');
    try {
      const res = await fillMissingCaptions(currentProject.id, 1.5);
      setFillGapsStatus(res.message);
      await loadProject(currentProject.id);
      setTimeout(() => setFillGapsStatus(null), 4000);
    } catch (err: any) {
      console.error('Failed to fill missing captions:', err);
      setFillGapsStatus(err?.response?.data?.detail || 'Failed to scan gaps');
      setTimeout(() => setFillGapsStatus(null), 4000);
    } finally {
      setIsFillingGaps(false);
    }
  };

  const handleStartEdit = (seg: Segment) => {
    setEditingId(seg.id);
    setEditText(seg.text);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !currentProject?.id) return;
    await updateSegment(editingId, { text: editText });
    setEditingId(null);
  };

  const handleShiftTimestamps = async (offsetSec: number) => {
    if (!currentProject?.id) return;
    try {
      await shiftProjectTimestamps(currentProject.id, offsetSec);
      await loadProject(currentProject.id);
    } catch (err) {
      console.error('Failed to shift timestamps:', err);
    }
  };

  const handleAddNewSegment = async () => {
    if (!currentProject) return;
    const start = currentTime;
    const end = Math.min(currentProject.duration || 60, start + 3.0);
    await addSegment({
      start_time: start,
      end_time: end,
      text: 'Subtitle line',
      speaker: 'Speaker 1',
      voice_profile: 'female',
    });
    if (currentProject.id) await loadProject(currentProject.id);
  };

  const handlePlayFromSegment = (seg: Segment, e: React.MouseEvent) => {
    e.stopPropagation();
    seekToSegment(seg);
    if (videoRef?.current) {
      videoRef.current.play().catch(() => {});
    }
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  // Filtered segments
  const displayedSegments = useMemo(() => {
    const base = segments.filter(
      (s) => s.speaker !== 'Freeze' && s.voice_profile !== 'freeze' && !s.text.includes('Freeze Frame')
    );
    if (!searchQuery.trim()) return base;
    const q = searchQuery.toLowerCase();
    return base.filter(
      (s) => s.text.toLowerCase().includes(q) || (s.speaker || '').toLowerCase().includes(q)
    );
  }, [segments, searchQuery]);

  return (
    <div className="flex flex-col h-full bg-[#111216] text-[#e1e4ea] select-none font-sans overflow-hidden">
      {/* 1. Header: Tabs & Quick Action Buttons */}
      <div className="px-4 py-2.5 border-b border-[#1f222a] bg-[#14161c] flex items-center justify-between gap-2 shrink-0">
        {/* Captions vs Style Tabs */}
        <div className="flex items-center gap-1 bg-[#1a1c24] p-1 rounded-xl border border-[#272b36]">
          <button
            onClick={() => setPanelTab('captions')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              panelTab === 'captions'
                ? 'bg-pink-600 text-white shadow-md'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Captions</span>
            {segments.length > 0 && (
              <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-black/30 font-mono">
                {segments.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setPanelTab('style')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              panelTab === 'style'
                ? 'bg-pink-600 text-white shadow-md'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Palette className="w-3.5 h-3.5" />
            <span>Style</span>
          </button>
        </div>

        {/* Right Tools: Import, Export, Add Line */}
        <div className="flex items-center gap-1.5">
          <input
            type="file"
            ref={fileInputRef}
            accept=".srt,.vtt,.txt,.ass"
            onChange={handleImportSrt}
            className="hidden"
          />

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isImporting}
            className="p-1.5 rounded-lg bg-[#1a1c24] hover:bg-[#232732] border border-[#272b36] text-zinc-300 hover:text-white transition-colors"
            title="Import Subtitle (.SRT, .VTT)"
          >
            {isImporting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-pink-400" />
            ) : (
              <UploadCloud className="w-3.5 h-3.5 text-pink-400" />
            )}
          </button>

          {/* Export Dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowExportDropdown(!showExportDropdown)}
              disabled={segments.length === 0}
              className="p-1.5 rounded-lg bg-[#1a1c24] hover:bg-[#232732] border border-[#272b36] text-zinc-300 hover:text-white transition-colors disabled:opacity-40"
              title="Export Subtitles"
            >
              <Download className="w-3.5 h-3.5 text-purple-400" />
            </button>

            {showExportDropdown && (
              <div className="absolute right-0 top-full mt-1.5 w-48 bg-[#1a1c24] border border-[#2d313d] rounded-xl shadow-2xl py-1 z-50 animate-in fade-in">
                {EXPORT_FORMATS.map((item) => (
                  <button
                    key={item.fmt}
                    onClick={() => handleExport(item.fmt)}
                    className="w-full px-3 py-2 text-left hover:bg-[#252834] transition-colors flex flex-col"
                  >
                    <span className="text-xs font-semibold text-zinc-200">{item.label}</span>
                    <span className="text-[10px] text-zinc-500">{item.desc}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Add Line */}
          <button
            onClick={handleAddNewSegment}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-pink-500/20 hover:bg-pink-500/30 text-pink-300 hover:text-white text-xs font-semibold border border-pink-500/40 transition-colors"
            title="Add new subtitle line"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add</span>
          </button>
        </div>
      </div>

      {/* 2. Main Content Area */}
      {panelTab === 'style' ? (
        <div className="flex-1 overflow-y-auto">
          <CaptionPropertiesPanel />
        </div>
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Simple Search Bar */}
          {segments.length > 0 && (
            <div className="px-4 py-2 border-b border-[#1b1d24] bg-[#14151a] flex items-center justify-between gap-2 shrink-0">
              <div className="relative flex-1 flex items-center">
                <Search className="w-3.5 h-3.5 absolute left-2.5 text-zinc-500 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search dialogue..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-7 py-1 rounded-lg bg-[#181a20] border border-[#242730] text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-pink-500/60 transition-all"
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

              <div className="flex items-center gap-1 bg-[#181a20] px-2 py-1 rounded-lg border border-[#242730] shrink-0 text-[11px]">
                <span className="text-[10px] text-zinc-500 font-mono">Sync:</span>
                <button
                  onClick={() => handleShiftTimestamps(-0.5)}
                  className="px-1.5 py-0.5 rounded bg-zinc-800/60 hover:bg-zinc-700 text-zinc-300 hover:text-white font-mono transition-colors"
                  title="Shift all captions 0.5s earlier (-0.5s)"
                >
                  -0.5s
                </button>
                <button
                  onClick={() => handleShiftTimestamps(0.5)}
                  className="px-1.5 py-0.5 rounded bg-zinc-800/60 hover:bg-zinc-700 text-zinc-300 hover:text-white font-mono transition-colors"
                  title="Shift all captions 0.5s later (+0.5s)"
                >
                  +0.5s
                </button>
                <button
                  onClick={() => handleShiftTimestamps(1.0)}
                  className="px-1.5 py-0.5 rounded bg-zinc-800/60 hover:bg-zinc-700 text-zinc-300 hover:text-white font-mono transition-colors"
                  title="Shift all captions 1.0s later (+1.0s)"
                >
                  +1.0s
                </button>
              </div>

              <button
                onClick={() => deleteAllSegments()}
                className="p-1 text-zinc-500 hover:text-red-400 transition-colors shrink-0"
                title="Clear all captions"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Clean Subtitle Scroll Area */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {/* Live Progress Banner during Gap Filling */}
            {fillGapsStatus && (
              <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-500/40 flex items-center justify-between text-xs animate-in fade-in">
                <div className="flex items-center gap-2 text-amber-200 font-semibold">
                  {isFillingGaps ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />
                  ) : (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  )}
                  <span>{fillGapsStatus}</span>
                </div>
              </div>
            )}

            {/* Live Progress Banner during Generation */}
            {isTranscribing && (
              <div className="p-3 rounded-xl bg-purple-950/40 border border-purple-500/40 flex flex-col gap-1.5 animate-in fade-in">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 text-purple-200 font-semibold">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-400" />
                    <span>Transcribing Speech...</span>
                  </div>
                  <span className="font-mono text-pink-300 font-bold">
                    {transcribeChunkInfo ? `Part ${transcribeChunkInfo.current}/${transcribeChunkInfo.total} · ` : ''}
                    {transcribePercent || 0}%
                  </span>
                </div>
                <div className="w-full bg-black/40 h-1.5 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-purple-500 to-pink-500 rounded-full transition-all duration-300"
                    style={{ width: `${Math.max(5, transcribePercent || 0)}%` }}
                  />
                </div>
              </div>
            )}

            {/* Live Translation Progress */}
            {isTranslating && translationProgress && (
              <div className="p-3.5 rounded-xl bg-gradient-to-r from-blue-950/80 to-indigo-950/80 border border-blue-500/50 flex flex-col gap-2 shadow-lg animate-in fade-in">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 text-blue-200 font-bold">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />
                    <span>Translating Segment {translationProgress.current} of {translationProgress.total}</span>
                  </div>
                  <span className="font-mono text-blue-300 font-bold">
                    {translationProgress.percent}%
                  </span>
                </div>
                <div className="w-full bg-black/50 h-2 rounded-full overflow-hidden border border-blue-500/30">
                  <div
                    className="h-full bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${Math.max(5, translationProgress.percent)}%` }}
                  />
                </div>
              </div>
            )}

            {/* Empty State */}
            {displayedSegments.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-2 text-zinc-500">
                <Sparkles className="w-8 h-8 text-pink-400/80 mb-1" />
                <h4 className="text-sm font-semibold text-zinc-300">No Captions</h4>
                <p className="text-xs max-w-xs leading-relaxed text-zinc-400">
                  Click <strong className="text-pink-400">"Generate Captions"</strong> below to create AI subtitles with voice timing.
                </p>
              </div>
            ) : (
              /* Clean Minimal Cards */
              displayedSegments.map((seg, idx) => {
                const isActive = activeSegmentId === seg.id;
                const isEditing = editingId === seg.id;
                const isThisTranslating =
                  (isTranslating && translationProgress?.segmentId === seg.id) ||
                  singleTranslatingId === seg.id;

                return (
                  <div
                    key={seg.id}
                    id={`seg-${seg.id}`}
                    ref={isActive ? activeRef : undefined}
                    onClick={() => seekToSegment(seg)}
                    className={`p-3 rounded-xl border transition-all cursor-pointer group relative ${
                      isThisTranslating
                        ? 'bg-[#151928] border-blue-500/80 shadow-lg ring-1 ring-blue-500/50 animate-pulse'
                        : isActive
                        ? 'bg-[#1a1c26] border-pink-500/60 shadow-md ring-1 ring-pink-500/30'
                        : 'bg-[#14161c] border-[#1e212a] hover:border-zinc-700 hover:bg-[#161820]'
                    }`}
                  >
                    {/* Active Left Indicator Bar */}
                    {isActive && (
                      <div className="absolute left-0 top-2 bottom-2 w-1 bg-pink-500 rounded-r" />
                    )}

                    {/* Top Row: Line Index (#1), Exact Time Range, Speaker Name + Action Buttons */}
                    <div className="flex items-center justify-between text-[11px] font-mono mb-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        {/* Line Index (#1) */}
                        <span className="text-pink-400 font-bold text-xs">#{idx + 1}</span>

                        {/* Exact Time Range (00:04 - 00:07) */}
                        <span className="text-zinc-200 font-medium px-2 py-0.5 rounded bg-black/40 border border-zinc-800 text-[11px]">
                          {formatTime(seg.start_time)} - {formatTime(seg.end_time)}
                        </span>

                        {/* Speaker Name */}
                        <span className="px-2 py-0.5 rounded-full bg-purple-950/60 text-purple-300 border border-purple-800/40 text-[10px] font-semibold flex items-center gap-1">
                          <User className="w-2.5 h-2.5 text-purple-400" />
                          <span>{seg.speaker || 'Speaker 1'}</span>
                        </span>

                        {isThisTranslating && (
                          <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/40 font-semibold animate-pulse">
                            <Loader2 className="w-2.5 h-2.5 animate-spin" /> Translating...
                          </span>
                        )}
                      </div>

                      {/* Action Buttons: Re-translate, Edit, Delete */}
                      <div className="flex items-center gap-1 opacity-70 group-hover:opacity-100 transition-opacity bg-black/30 p-0.5 rounded-lg border border-zinc-800">
                        {/* Re-translate this line */}
                        <button
                          onClick={(e) => handleTranslateSingleLine(seg.id, e)}
                          disabled={isThisTranslating}
                          className="p-1 rounded text-zinc-400 hover:text-blue-400 hover:bg-zinc-800 transition-colors disabled:opacity-40"
                          title={`Re-translate this line into ${selectedLanguage.name}`}
                        >
                          <RotateCcw className="w-3 h-3" />
                        </button>

                        {/* Edit text */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStartEdit(seg);
                          }}
                          className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                          title="Edit text"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>

                        {/* Delete line */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteSegment(seg.id);
                          }}
                          className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                          title="Delete line"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>

                    {/* Dialogue Text / Inline Edit */}
                    {isEditing ? (
                      <div className="space-y-1.5 mt-1" onClick={(e) => e.stopPropagation()}>
                        <textarea
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSaveEdit();
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          rows={2}
                          className="w-full bg-[#1b1e28] border border-pink-500 rounded-lg p-2 text-xs text-white font-khmer focus:outline-none"
                          autoFocus
                        />
                        <div className="flex justify-end gap-1.5">
                          <button
                            onClick={() => setEditingId(null)}
                            className="px-2 py-0.5 rounded bg-zinc-800 text-[11px] text-zinc-300"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleSaveEdit}
                            className="px-2.5 py-0.5 rounded bg-pink-600 text-[11px] font-bold text-white"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {seg.original_text && seg.original_text.trim() !== seg.text.trim() && (
                          <p className="text-[11px] text-zinc-400 font-sans select-text line-clamp-2 opacity-80">
                            {seg.original_text}
                          </p>
                        )}
                        <p
                          onDoubleClick={() => handleStartEdit(seg)}
                          className="text-xs text-zinc-100 font-khmer leading-relaxed select-text"
                        >
                          {seg.text}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* 3. Pinned Bottom Action Dock: Clean & Direct */}
          <div className="p-3 border-t border-[#1f222a] bg-[#14161c] flex items-center justify-between gap-2 shrink-0">
            {/* Language Selector */}
            <div className="relative">
              <button
                onClick={() => setShowLangDropdown(!showLangDropdown)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#1a1c24] border border-[#272b36] hover:border-zinc-600 text-xs font-semibold text-white transition-colors"
              >
                <span>{selectedLanguage.flag}</span>
                <span>{selectedLanguage.name}</span>
                <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
              </button>

              {showLangDropdown && (
                <div className="absolute bottom-full left-0 mb-1.5 w-48 bg-[#1a1c24] border border-[#2d313d] rounded-xl shadow-2xl py-1 z-50">
                  {SUPPORTED_LANGUAGES.map((lang) => (
                    <button
                      key={lang.id}
                      onClick={() => {
                        setSelectedLanguage(lang);
                        setShowLangDropdown(false);
                      }}
                      className={`w-full px-3 py-1.5 text-left text-xs flex items-center justify-between hover:bg-[#252834] transition-colors ${
                        selectedLanguage.id === lang.id ? 'text-pink-400 font-bold bg-[#222530]' : 'text-zinc-300'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span>{lang.flag}</span>
                        <span>{lang.name}</span>
                      </div>
                      {selectedLanguage.id === lang.id && <Check className="w-3.5 h-3.5 text-pink-400" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Primary Action Button */}
            <div className="flex items-center gap-2">
              {segments.length > 0 && selectedLanguage.id !== 'auto' && (
                <button
                  onClick={handleTranslateAll}
                  disabled={isTranslating}
                  className={`relative overflow-hidden flex items-center gap-1.5 px-4 py-2 rounded-xl text-white text-xs font-bold shadow-md transition-all ${
                    isTranslating
                      ? 'bg-[#151928] border border-blue-500/60 ring-1 ring-blue-500/40 min-w-[200px]'
                      : 'bg-blue-600 hover:bg-blue-500'
                  }`}
                  title="Translate all captions"
                >
                  {isTranslating && (
                    <div
                      className="absolute inset-0 bg-gradient-to-r from-blue-600 to-indigo-600 transition-all duration-300 ease-out opacity-85"
                      style={{ width: `${Math.max(6, translationProgress?.percent || 0)}%` }}
                    />
                  )}
                  <div className="relative z-10 flex items-center gap-1.5 w-full justify-center">
                    {isTranslating ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Translating {translationProgress?.current || 0}/{translationProgress?.total || segments.length} ({translationProgress?.percent || 0}%)</span>
                      </>
                    ) : (
                      <>
                        <Languages className="w-3.5 h-3.5" />
                        <span>Translate to {selectedLanguage.name.split(' ')[0]}</span>
                      </>
                    )}
                  </div>
                </button>
              )}

              {segments.length > 0 && (
                <button
                  onClick={handleFillMissingGaps}
                  disabled={isFillingGaps || isTranscribing}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 hover:text-white border border-amber-500/40 text-xs font-bold shadow-md transition-all disabled:opacity-50"
                  title="Scan and generate captions only for blank/missed gaps in video"
                >
                  {isFillingGaps ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Filling Gaps...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                      <span>Fill Gaps</span>
                    </>
                  )}
                </button>
              )}

              <button
                onClick={() => {
                  if (currentProject?.id) generateTranscript(selectedLanguage.id);
                }}
                disabled={isTranscribing}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500 text-white text-xs font-bold shadow-md transition-all disabled:opacity-50"
              >
                {isTranscribing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Transcribing ({transcribePercent || 0}%)</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Generate Captions</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
