import { useShallow } from 'zustand/react/shallow';
import { speakerColorMap } from '../utils/speakerColors';
import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useProjectStore } from '../stores/projectStore';
import {
  SUBTITLE_ACCEPT,
  translateSegments,
  translateSegmentsStream,
  fillMissingCaptionsStream,
  fetchCaptionCoverage,
  getExportUrl,
  type TranslateProgressEvent,
  type CaptionCoverage,
} from '../api/client';
import type { Segment } from '../types';
import { buildClipLayout, timelineToSource } from '../utils/clipTimemap';
import { needsKhmerTranslation } from '../utils/translation';
import FillGapsModal from './FillGapsModal';
import CaptionPropertiesPanel from './CaptionPropertiesPanel';
import SeriesTranslationPanel from './SeriesTranslationPanel';
import SubtitleImportDialog from './SubtitleImportDialog';
import {
  AlertCircle,
  Square,
  UploadCloud,
  ChevronDown,
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
  Mic,
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
  } = useProjectStore(useShallow(state => ({ currentProject: state.currentProject, activeSegmentId: state.activeSegmentId, currentTime: state.currentTime, setCurrentTime: state.setCurrentTime, isPlaying: state.isPlaying, videoClips: state.videoClips, updateSegment: state.updateSegment, deleteSegment: state.deleteSegment, deleteAllSegments: state.deleteAllSegments, addSegment: state.addSegment, setActiveSegment: state.setActiveSegment, isTranscribing: state.isTranscribing, transcribeProgress: state.transcribeProgress, transcribePercent: state.transcribePercent, transcribeChunkInfo: state.transcribeChunkInfo, generateTranscript: state.generateTranscript, loadProject: state.loadProject })));

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
  const [seriesTab, setSeriesTab] = useState<'series' | 'review' | null>(null);
  const [panelTab, setPanelTab] = useState<'captions' | 'style'>('captions');
  // The source-language line is a reference only; Khmer is what gets exported and dubbed
  const [showOriginal, setShowOriginal] = useState(() => localStorage.getItem('captions-show-original') === 'true');
  useEffect(() => {
    localStorage.setItem('captions-show-original', String(showOriginal));
  }, [showOriginal]);
  const [selectedLanguage, setSelectedLanguage] = useState(SUPPORTED_LANGUAGES[0]);
  const translationCandidates = useMemo(
    () => selectedLanguage.id === 'km'
      ? segments.filter((segment) => needsKhmerTranslation(segment.text))
      : segments,
    [segments, selectedLanguage.id],
  );
  const noKhmerTranslationNeeded = selectedLanguage.id === 'km' && translationCandidates.length === 0;
  const [showLangDropdown, setShowLangDropdown] = useState(false);
  const [showExportDropdown, setShowExportDropdown] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');

  // Import, Translate & Gap Filling states
  const [isTranslating, setIsTranslating] = useState(false);
  const [isFillingGaps, setIsFillingGaps] = useState(false);
  const [showGapPlan, setShowGapPlan] = useState(false);
  const [fillGapsStatus, setFillGapsStatus] = useState<string | null>(null);
  const [fillGapsFailed, setFillGapsFailed] = useState(false);
  const [fillGapsInfo, setFillGapsInfo] = useState<{
    message: string;
    percent: number;
    currentGap: number;
    totalGaps: number;
    gapStart?: number;
    gapEnd?: number;
    filledCount: number;
    failedCount?: number;
  } | null>(null);
  // Gaps whose request failed even after a retry, kept so they can be tried again on their own
  const [failedGapSpans, setFailedGapSpans] = useState<{ start: number; end: number }[]>([]);
  const stopFillGapsRef = useRef<(() => void) | null>(null);
  const filledSoFarRef = useRef(0);
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

  // Picking a file opens the import dialog, which reads it and says what importing will do
  const [importFile, setImportFile] = useState<File | null>(null);
  const handleImportSrt = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (file && currentProject?.id) setImportFile(file);
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
    if (translationCandidates.length === 0) return;
    setIsTranslating(true);
    setTranslationProgress({ current: 0, total: translationCandidates.length, percent: 0 });

    const controller = translateSegmentsStream(
      currentProject.id,
      targetLang,
      translationCandidates.map((segment) => segment.id),
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
      async (total, failed) => {
        setIsTranslating(false);
        setTranslationProgress(null);
        translateAbortRef.current = null;
        await loadProject(currentProject.id);
        if (failed > 0) alert(`${failed} of ${total} lines could not be translated and were left unchanged. Run Translate again to retry them.`);
      },
      async (message) => {
        setIsTranslating(false);
        setTranslationProgress(null);
        translateAbortRef.current = null;
        await loadProject(currentProject.id);
        alert(message);
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
    } catch (err: any) {
      alert(err?.response?.data?.detail || err?.message || 'Could not translate this line');
    } finally {
      setSingleTranslatingId(null);
    }
  };

  // How much speech has no caption — checked after transcription and after filling gaps
  const [coverage, setCoverage] = useState<CaptionCoverage | null>(null);

  const checkCoverage = useCallback(async () => {
    if (!currentProject?.id) return;
    try {
      setCoverage(await fetchCaptionCoverage(currentProject.id));
    } catch {
      setCoverage(null);
    }
  }, [currentProject?.id]);

  useEffect(() => {
    if (!currentProject?.id || isTranscribing || segments.length === 0) return;
    checkCoverage();
  }, [currentProject?.id, isTranscribing, segments.length, checkCoverage]);

  /** Short totals stay in seconds; only real minutes are shown as minutes. */
  const fmtGapTotal = (seconds: number) =>
    seconds < 90 ? `${Math.round(seconds)}s total` : `${(seconds / 60).toFixed(1)} min total`;

  const handleFillMissingGaps = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (!currentProject?.id || isFillingGaps) return;
    // Show what was found first — which gaps, and how long — instead of silently
    // transcribing everything the scan turned up.
    setShowGapPlan(true);
  };

  const runFillGaps = (chosenGaps: { start: number; end: number }[]) => {
    if (!currentProject?.id || isFillingGaps) return;
    setShowGapPlan(false);
    const targetProjectId = currentProject.id;
    setIsFillingGaps(true);
    setFillGapsStatus(null);
    setFillGapsFailed(false);
    setFailedGapSpans([]);
    filledSoFarRef.current = 0;
    setFillGapsInfo({
      message: 'Preparing selected audio for transcription...',
      percent: 5,
      currentGap: 0,
      totalGaps: 0,
      filledCount: 0,
    });

    stopFillGapsRef.current = fillMissingCaptionsStream(
      targetProjectId,
      1.5,
      (progress) => {
        filledSoFarRef.current = progress.filledCount;
        setFillGapsInfo(progress);
      },
      (newSeg) => {
        // In-place segment append to store without page reload
        const cur = useProjectStore.getState().currentProject;
        if (cur && cur.id === targetProjectId) {
          const existing = cur.segments || [];
          if (!existing.some((s) => s.id === newSeg.id)) {
            const updated = [...existing, newSeg].sort((a, b) => a.start_time - b.start_time);
            useProjectStore.setState({
              currentProject: { ...cur, segments: updated },
            });
          }
        }
      },
      async (res) => {
        stopFillGapsRef.current = null;
        setIsFillingGaps(false);
        setFillGapsInfo(null);
        setFillGapsStatus(res.message);
        const failed = res.failed_spans || [];
        setFailedGapSpans(failed.map((f) => ({ start: f.start, end: f.end })));
        // Leave the banner up while there is something to retry
        if (!failed.length) setTimeout(() => setFillGapsStatus(null), 5000);
      },
      (err) => {
        stopFillGapsRef.current = null;
        setIsFillingGaps(false);
        setFillGapsInfo(null);
        setFillGapsFailed(true);
        setFillGapsStatus(typeof err === 'string' ? err : 'Failed to scan gaps');
        setTimeout(() => setFillGapsStatus(null), 4000);
      },
      chosenGaps
    );
  };

  /** Stop a run part-way. Each gap is saved as it finishes, so captions already found stay. */
  const stopFillGaps = () => {
    stopFillGapsRef.current?.();
    stopFillGapsRef.current = null;
    setIsFillingGaps(false);
    setFillGapsInfo(null);
    const kept = filledSoFarRef.current;
    setFillGapsStatus(`Stopped · ${kept} ${kept === 1 ? 'caption' : 'captions'} kept`);
    setTimeout(() => setFillGapsStatus(null), 4000);
  };

  useEffect(() => () => stopFillGapsRef.current?.(), []);

  const handleStartEdit = (seg: Segment) => {
    setEditingId(seg.id);
    setEditText(seg.text);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !currentProject?.id) return;
    await updateSegment(editingId, { text: editText });
    setEditingId(null);
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

  const speakerColors = useMemo(() => speakerColorMap(currentProject?.segments || []), [currentProject?.segments]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  // Filtered segments
  // Row windowing: a long project has thousands of captions, and rendering them all costs
  // ~20 DOM nodes each. Only the rows near the scroll position are mounted; the rest are
  // represented by spacer divs so the scrollbar still behaves normally.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [listScrollTop, setListScrollTop] = useState(0);
  const [listHeight, setListHeight] = useState(600);
  const ROW_ESTIMATE = 74;
  const ROW_OVERSCAN = 8;

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setListHeight(el.clientHeight || 600);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  const windowedSegments = useMemo(() => {
    const first = Math.max(0, Math.floor(listScrollTop / ROW_ESTIMATE) - ROW_OVERSCAN);
    const visible = Math.ceil(listHeight / ROW_ESTIMATE) + ROW_OVERSCAN * 2;
    return displayedSegments.slice(first, first + visible).map((seg, i) => ({ seg, idx: first + i }));
  }, [displayedSegments, listScrollTop, listHeight]);

  const padTop = windowedSegments.length ? windowedSegments[0].idx * ROW_ESTIMATE : 0;
  const lastIdx = windowedSegments.length ? windowedSegments[windowedSegments.length - 1].idx + 1 : 0;
  const padBottom = Math.max(0, (displayedSegments.length - lastIdx) * ROW_ESTIMATE);

  return (
    <div className="flex flex-col h-full bg-[var(--s2)] text-[#e1e4ea] select-none font-sans overflow-hidden">
      {seriesTab && currentProject && <SeriesTranslationPanel key={currentProject.id} project={currentProject} clips={videoClips} initialTab={seriesTab}
        onClose={() => setSeriesTab(null)} onChanged={() => loadProject(currentProject.id)} />}
      <div className="flex gap-2 border-b border-[var(--s4)] px-3 py-2">
        <button className="rounded-lg bg-white/5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/10" onClick={() => setSeriesTab('series')}>Series glossary & cast</button>
        <button className="rounded-lg bg-blue-500/10 px-3 py-1.5 text-xs text-blue-300 hover:bg-blue-500/20" onClick={() => setSeriesTab('review')}>Review translations</button>
      </div>
      {/* 1. Header: Tabs & Quick Action Buttons */}
      <div className="px-3 py-2 border-b border-[var(--s4)] flex items-center justify-between gap-2 shrink-0">
        {/* Captions vs Style Tabs */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPanelTab('captions')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              panelTab === 'captions'
                ? 'bg-white/10 text-white'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Captions</span>
            {/* Progress stays visible from the Style tab too */}
            {isFillingGaps && fillGapsInfo && (
              <span className="flex items-center gap-1 ml-1 px-1.5 rounded-full text-[10px] bg-amber-500/20 text-amber-300 font-mono">
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                {fillGapsInfo.totalGaps ? `${fillGapsInfo.currentGap}/${fillGapsInfo.totalGaps}` : '…'}
              </span>
            )}
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
                ? 'bg-white/10 text-white'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Palette className="w-3.5 h-3.5" />
            <span>Style</span>
          </button>
        </div>

        {/* Right Tools: original-text toggle, Import, Export, Add Line — for the list, so hidden on Style */}
        <div className={`items-center gap-1.5 ${panelTab === 'style' ? 'hidden' : 'flex'}`}>
          <button
            onClick={() => setShowOriginal(!showOriginal)}
            className={`flex items-center gap-1 px-2 py-1.5 rounded-md text-xs transition-colors cursor-pointer ${
              showOriginal ? 'bg-white/10 text-white' : 'text-zinc-400 hover:text-white hover:bg-white/10'
            }`}
            title={showOriginal ? 'Hide the original dialogue line' : 'Show the original dialogue line under each caption'}
          >
            <Languages className="w-3.5 h-3.5" />
            <span className="hidden lg:inline">Original</span>
          </button>
          <input
            type="file"
            ref={fileInputRef}
            accept={SUBTITLE_ACCEPT}
            onChange={handleImportSrt}
            className="hidden"
          />
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

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={!!importFile}
            className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
            title="Import subtitles (SRT, VTT, ASS or JSON)"
          >
            {importFile ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}
            <span className="hidden xl:inline">Import</span>
          </button>

          {/* Export Dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowExportDropdown(!showExportDropdown)}
              disabled={segments.length === 0}
              aria-expanded={showExportDropdown}
              className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-zinc-400 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40"
              title="Save the captions as a subtitle file"
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden xl:inline">Export</span>
            </button>

            {showExportDropdown && (
              <div className="absolute right-0 top-full mt-1.5 w-48 bg-[var(--s3)] border border-[var(--s6)] rounded-xl shadow-2xl py-1 z-50 animate-in fade-in">
                {EXPORT_FORMATS.map((item) => (
                  <button
                    key={item.fmt}
                    onClick={() => handleExport(item.fmt)}
                    className="w-full px-3 py-2 text-left hover:bg-[var(--s5)] transition-colors flex flex-col"
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
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors"
            title="Add a caption at the playhead"
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
            <div className="px-3 py-2 border-b border-[var(--s3)] flex items-center justify-between gap-2 shrink-0">
              <div className="relative flex-1 flex items-center">
                <Search className="w-3.5 h-3.5 absolute left-2.5 text-zinc-500 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search words or a speaker…"
                  aria-label="Search the captions"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-7 py-1 rounded-lg bg-[var(--s3)] border border-[var(--s4)] text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-white/10 transition-all"
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

              {searchQuery && (
                <span className="text-[11px] text-zinc-500 shrink-0 tabular-nums">{displayedSegments.length} of {segments.length}</span>
              )}
              <button
                onClick={() => {
                  if (confirm(`Delete all ${segments.length} captions and their voices? A version is saved first, so this can be undone from Versions.`)) deleteAllSegments();
                }}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-zinc-500 hover:text-red-300 hover:bg-white/5 transition-colors shrink-0"
                title="Delete every caption"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span className="hidden xl:inline">Clear all</span>
              </button>
            </div>
          )}

          {/* who speaks: click a name to find their lines */}
          {Object.keys(speakerColors).length > 1 && (
            <div className="px-3 py-1.5 border-b border-[var(--s3)] flex items-center gap-1.5 overflow-x-auto scrollbar-none shrink-0">
              {Object.entries(speakerColors).map(([name, color]) => {
                const on = searchQuery === name;
                const count = segments.filter((x) => x.speaker === name).length;
                return (
                  <button
                    key={name}
                    onClick={() => setSearchQuery(on ? '' : name)}
                    aria-pressed={on}
                    title={on ? 'Show every line' : `Show only ${name}’s lines`}
                    className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] whitespace-nowrap border transition-colors ${
                      on ? 'text-white border-transparent' : 'text-zinc-300 border-[var(--s5)] hover:border-zinc-600'
                    }`}
                    style={on ? { background: `${color}55` } : undefined}
                  >
                    <span className="w-2 h-2 rounded-full" style={{ background: color }} />
                    {name}
                    <span className="text-zinc-500 tabular-nums">{count}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Live Progress Card during Gap Scanning & Filling */}
          {isFillingGaps && fillGapsInfo && (
            <div className="mx-3 mt-3 p-3.5 rounded-xl bg-gradient-to-r from-amber-950/80 via-orange-950/80 to-amber-950/80 border border-amber-500/50 flex flex-col gap-2 shadow-lg animate-in fade-in">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 text-amber-200 font-bold">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400 shrink-0" />
                  <span>
                    {fillGapsInfo.totalGaps > 0
                      ? `Filling gaps · ${fillGapsInfo.currentGap}/${fillGapsInfo.totalGaps} done`
                      : 'Analyzing Timeline Gaps...'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {fillGapsInfo.filledCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono text-[10px] font-bold border border-emerald-500/30">
                      +{fillGapsInfo.filledCount} found
                    </span>
                  )}
                  {(fillGapsInfo.failedCount ?? 0) > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 font-mono text-[10px] font-bold border border-red-500/30">
                      {fillGapsInfo.failedCount} failed
                    </span>
                  )}
                  <span className="font-mono text-amber-300 font-bold">
                    {fillGapsInfo.percent}%
                  </span>
                  <button
                    type="button"
                    onClick={stopFillGaps}
                    className="p-1 rounded text-amber-300 hover:text-white hover:bg-white/10 transition-colors"
                    title="Stop — captions found so far are kept"
                  >
                    <Square className="w-3 h-3 fill-current" />
                  </button>
                </div>
              </div>

              <div className="w-full bg-black/40 h-2 rounded-full overflow-hidden border border-amber-900/40">
                <div
                  className="h-full bg-gradient-to-r from-amber-500 via-orange-400 to-amber-300 rounded-full transition-all duration-300 shadow-[0_0_10px_rgba(245,158,11,0.5)]"
                  style={{ width: `${Math.max(5, fillGapsInfo.percent)}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-[11px] text-amber-300/80 font-mono">
                <span className="truncate max-w-[240px]">{fillGapsInfo.message}</span>
                {fillGapsInfo.gapStart !== undefined && fillGapsInfo.gapEnd !== undefined && (
                  <span className="shrink-0 text-amber-400 font-semibold">
                    [{fillGapsInfo.gapStart.toFixed(1)}s - {fillGapsInfo.gapEnd.toFixed(1)}s]
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Success / Status Banner after Gap Filling */}
          {!isFillingGaps && fillGapsStatus && (
            <div
              className={`mx-3 mt-3 p-3 rounded-xl border flex items-center justify-between text-xs animate-in fade-in ${
                fillGapsFailed ? 'bg-red-950/40 border-red-500/40' : 'bg-emerald-950/40 border-emerald-500/40'
              }`}
            >
              <div className={`flex items-center gap-2 font-semibold ${fillGapsFailed ? 'text-red-200' : 'text-emerald-200'}`}>
                {fillGapsFailed ? (
                  <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                ) : (
                  <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                )}
                <span>{fillGapsStatus}</span>
              </div>
              {failedGapSpans.length > 0 ? (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => runFillGaps(failedGapSpans)}
                    className="flex items-center gap-1 px-2 py-1 rounded-md bg-red-500/15 hover:bg-red-500/25 text-red-200 border border-red-500/30 transition-colors"
                    title={failedGapSpans.map((g) => `${g.start.toFixed(1)}s – ${g.end.toFixed(1)}s`).join('\n')}
                  >
                    <RotateCcw className="w-3 h-3" />
                    Retry {failedGapSpans.length} failed
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setFailedGapSpans([]);
                      setFillGapsStatus(null);
                    }}
                    className="p-1 rounded text-emerald-300/70 hover:text-white hover:bg-white/10 transition-colors"
                    title="Dismiss"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : null}
            </div>
          )}

          {/* Clean Subtitle Scroll Area */}
          <div
            ref={listRef}
            onScroll={(e) => setListScrollTop(e.currentTarget.scrollTop)}
            className="flex-1 overflow-y-auto p-2.5 space-y-1.5"
          >
            {/* Live Progress Banner during Generation */}
            {isTranscribing && (
              <div className="p-3 rounded-xl bg-white/5 border border-white/10 flex flex-col gap-1.5 animate-in fade-in">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 text-zinc-100 font-semibold">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
                    <span>{transcribeProgress || 'Preparing transcription...'}</span>
                  </div>
                  <span className="font-mono text-zinc-200 font-bold">
                    {transcribeChunkInfo ? `${transcribeChunkInfo.current}/${transcribeChunkInfo.total} parts processed · ` : ''}
                    {transcribePercent || 0}%
                  </span>
                </div>
                <div role="progressbar" aria-label="Transcription progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={transcribePercent} aria-valuetext={transcribeProgress} className="w-full bg-black/40 h-1.5 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all duration-300"
                    style={{ width: `${transcribePercent || 0}%` }}
                  />
                </div>
              </div>
            )}

            {/* Live Translation Progress */}
            {isTranslating && translationProgress && (
              <div className="p-3.5 rounded-xl bg-gradient-to-r from-blue-950/80 border border-blue-500/50 flex flex-col gap-2 shadow-lg animate-in fade-in">
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
                    className="h-full bg-gradient-to-r from-blue-500 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${Math.max(5, translationProgress.percent)}%` }}
                  />
                </div>
              </div>
            )}

            {/* Empty State */}
            {displayedSegments.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-2 text-zinc-500">
                <Sparkles className="w-8 h-8 text-zinc-400 mb-1" />
                <h4 className="text-sm font-semibold text-zinc-300">{searchQuery ? 'No caption matches' : 'No captions yet'}</h4>
                <p className="text-xs max-w-xs leading-relaxed text-zinc-400">
                  {searchQuery
                    ? 'Try another word, or clear the search.'
                    : <>Press <strong className="text-zinc-200">Generate captions</strong> below to write them from the audio, or <strong className="text-zinc-200">Import</strong> a subtitle file above.</>}
                </p>
              </div>
            ) : (
              /* Clean Minimal Cards — only the rows near the viewport are mounted */
              <>
                <div style={{ height: padTop }} aria-hidden="true" />
                {windowedSegments.map(({ seg, idx }) => {
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
                    className={`pl-4 pr-2.5 py-2 rounded-xl border transition-colors cursor-pointer group relative overflow-hidden [content-visibility:auto] [contain-intrinsic-size:auto_68px] ${
                      isThisTranslating
                        ? 'bg-[var(--s3)] border-blue-500/70'
                        : isActive
                        ? 'bg-blue-600/10 border-blue-500/60'
                        : 'bg-[var(--s3)]/60 border-[var(--s4)] hover:border-zinc-600 hover:bg-[var(--s3)]'
                    }`}
                  >
                    {/* the speaker's colour, as on the timeline */}
                    <span
                      aria-hidden
                      className="absolute left-0 top-0 bottom-0 w-1"
                      style={{ background: speakerColors[seg.speaker] || 'var(--s6)' }}
                    />

                    {/* who, when, and what can be done */}
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="flex items-center gap-2 min-w-0 text-[11px]">
                        <span
                          className="font-semibold truncate"
                          style={{ color: speakerColors[seg.speaker] || undefined }}
                        >
                          {seg.speaker || <span className="text-zinc-500 font-normal">No speaker</span>}
                        </span>
                        <span className="font-mono text-zinc-500 shrink-0">
                          {formatTime(seg.start_time)} – {formatTime(seg.end_time)}
                        </span>
                        {seg.audio_url ? (
                          <span className="flex items-center gap-0.5 text-[10px] text-emerald-400/90 shrink-0" title="This line has a voice">
                            <Mic className="w-2.5 h-2.5" /> voiced
                          </span>
                        ) : null}
                        {isThisTranslating && (
                          <span className="flex items-center gap-1 text-[10px] text-blue-300 font-semibold shrink-0">
                            <Loader2 className="w-2.5 h-2.5 animate-spin" /> Translating…
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-0.5 shrink-0">
                        <span className="text-[10px] text-zinc-600 font-mono mr-1">#{idx + 1}</span>
                        <div className={`flex items-center gap-0.5 transition-opacity ${isActive ? 'opacity-100' : 'opacity-40 group-hover:opacity-100 focus-within:opacity-100'}`}>
                          <button
                            onClick={(e) => handleTranslateSingleLine(seg.id, e)}
                            disabled={isThisTranslating}
                            className="p-1 rounded text-zinc-300 hover:text-blue-300 hover:bg-white/10 transition-colors disabled:opacity-40"
                            title={`Translate this line into ${selectedLanguage.name} again`}
                            aria-label="Translate this line again"
                          >
                            <RotateCcw className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleStartEdit(seg); }}
                            className="p-1 rounded text-zinc-300 hover:text-white hover:bg-white/10 transition-colors"
                            title="Edit the words"
                            aria-label="Edit this line"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteSegment(seg.id); }}
                            className="p-1 rounded text-zinc-300 hover:text-red-400 hover:bg-white/10 transition-colors"
                            title="Delete this line"
                            aria-label="Delete this line"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
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
                          className="w-full bg-[var(--s3)] border border-zinc-600 rounded-lg p-2 text-xs text-white font-khmer focus:outline-none"
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
                            className="px-2.5 py-0.5 rounded bg-blue-600 text-[11px] font-medium text-white"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {showOriginal && seg.original_text && seg.original_text.trim() !== seg.text.trim() && (
                          <p className="text-[11px] text-zinc-400 font-sans select-text line-clamp-2 opacity-80">
                            {seg.original_text}
                          </p>
                        )}
                        <p
                          onDoubleClick={() => handleStartEdit(seg)}
                          className="text-[13px] text-white font-khmer leading-relaxed select-text"
                          title="Double-click to edit"
                        >
                          {seg.text}
                        </p>
                      </div>
                    )}
                  </div>
                );
                })}
                <div style={{ height: padBottom }} aria-hidden="true" />
              </>
            )}
          </div>

          {/* 3. Pinned Bottom Action Dock: Clean & Direct */}
          {coverage?.available && (coverage.spans ?? 0) > 0 && !isFillingGaps && (
            <div
              className="px-3 py-1.5 border-t border-amber-500/20 bg-amber-500/5 flex items-center gap-2 text-[11px] text-amber-200 shrink-0"
              title={`${coverage.missed_bursts} spoken lines have no caption, across ${coverage.spans ?? 0} separate stretches`}
            >
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span className="flex-1 min-w-0 truncate">
                {coverage.spans ?? 0} {(coverage.spans ?? 0) === 1 ? 'stretch' : 'stretches'} of speech {(coverage.spans ?? 0) === 1 ? 'has' : 'have'} no caption ({fmtGapTotal(coverage.missed_seconds ?? 0)})
              </span>
              <button type="button" onClick={(e) => handleFillMissingGaps(e)} disabled={isTranscribing} className="font-semibold text-amber-100 underline hover:text-white shrink-0 disabled:opacity-50">
                Fill gaps
              </button>
            </div>
          )}
          <div className="px-3 py-2 border-t border-[var(--s4)] flex items-center justify-between gap-2 shrink-0">
            {/* Language Selector */}
            <div className="relative">
              <button
                onClick={() => setShowLangDropdown(!showLangDropdown)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[var(--s3)] border border-[var(--s5)] hover:border-zinc-600 text-xs font-semibold text-white whitespace-nowrap transition-colors"
                title="The language captions are written in and translated to"
              >
                <span>{selectedLanguage.flag}</span>
                <span>{selectedLanguage.name}</span>
                <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
              </button>

              {showLangDropdown && (
                <div className="absolute bottom-full left-0 mb-1.5 w-48 bg-[var(--s3)] border border-[var(--s6)] rounded-xl shadow-2xl py-1 z-50">
                  {SUPPORTED_LANGUAGES.map((lang) => (
                    <button
                      key={lang.id}
                      onClick={() => {
                        setSelectedLanguage(lang);
                        setShowLangDropdown(false);
                      }}
                      className={`w-full px-3 py-1.5 text-left text-xs flex items-center justify-between hover:bg-[var(--s5)] transition-colors ${
                        selectedLanguage.id === lang.id ? 'text-zinc-400 font-bold bg-[var(--s4)]' : 'text-zinc-300'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span>{lang.flag}</span>
                        <span>{lang.name}</span>
                      </div>
                      {selectedLanguage.id === lang.id && <Check className="w-3.5 h-3.5 text-zinc-400" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Primary Action Button */}
            <div className="flex items-center gap-1.5">
              {segments.length > 0 && selectedLanguage.id !== 'auto' && noKhmerTranslationNeeded && (
                <span className="flex items-center gap-1 text-[11px] text-emerald-300/90 whitespace-nowrap" title="No non-Khmer letters detected in the captions">
                  <Check className="w-3.5 h-3.5" /> All in Khmer
                </span>
              )}
              {segments.length > 0 && selectedLanguage.id !== 'auto' && !noKhmerTranslationNeeded && (
                <button
                  onClick={handleTranslateAll}
                  disabled={isTranslating || noKhmerTranslationNeeded || isTranscribing || singleTranslatingId !== null}
                  className={`relative overflow-hidden flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    isTranslating ? 'bg-white/5 text-zinc-200 min-w-[200px]' : 'bg-blue-600 text-white hover:bg-blue-500'
                  }`}
                  title={selectedLanguage.id === 'km'
                    ? noKhmerTranslationNeeded
                      ? 'No non-Khmer letters detected in the captions'
                      : `Translate ${translationCandidates.length} captions containing non-Khmer letters; Khmer-only captions are preserved`
                    : 'Translate all captions'}
                >
                  {isTranslating && (
                    <div
                      className="absolute inset-0 bg-white/10 transition-all duration-300 ease-out"
                      style={{ width: `${Math.max(6, translationProgress?.percent || 0)}%` }}
                    />
                  )}
                  <div className="relative z-10 flex items-center gap-1.5 w-full justify-center">
                    {isTranslating ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Translating {translationProgress?.current || 0}/{translationProgress?.total ?? translationCandidates.length} ({translationProgress?.percent || 0}%)</span>
                      </>
                    ) : (
                      <>
                        <Languages className="w-3.5 h-3.5" />
                        <span>{`Translate to ${selectedLanguage.name.split(' ')[0]}${selectedLanguage.id === 'km' ? ` (${translationCandidates.length})` : ''}`}</span>
                      </>
                    )}
                  </div>
                </button>
              )}

              {segments.length > 0 && (
                <button
                  type="button"
                  onClick={(e) => handleFillMissingGaps(e)}
                  disabled={isFillingGaps || isTranscribing}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white text-xs whitespace-nowrap transition-colors disabled:opacity-50 cursor-pointer"
                  title="Write captions only for speech that has none"
                >
                  {isFillingGaps ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>
                        {fillGapsInfo?.totalGaps
                          ? `Filling ${fillGapsInfo.currentGap}/${fillGapsInfo.totalGaps} · ${fillGapsInfo.percent}%`
                          : 'Filling Gaps...'}
                      </span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Fill gaps</span>
                    </>
                  )}
                </button>
              )}

              <button
                onClick={() => {
                  if (!currentProject?.id) return;
                  // writing them again throws away every caption, edit and voice there is
                  if (segments.length && !confirm(`Write the captions again from the audio? This replaces all ${segments.length} captions, including your edits and their voices.`)) return;
                  generateTranscript(selectedLanguage.id);
                }}
                disabled={isTranscribing}
                title={segments.length ? 'Throw these captions away and write them again from the audio' : 'Write captions from the audio'}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs whitespace-nowrap transition-colors disabled:opacity-50 ${
                  segments.length === 0 ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white'
                }`}
              >
                {isTranscribing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Transcribing ({transcribePercent || 0}%)</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>{segments.length ? 'Re-transcribe' : 'Generate captions'}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {showGapPlan && currentProject?.id && (
        <FillGapsModal
          projectId={currentProject.id}
          videoSeconds={currentProject.duration || 0}
          onClose={() => setShowGapPlan(false)}
          onConfirm={runFillGaps}
          onPreview={(seconds) => useProjectStore.getState().setCurrentTime(seconds)}
          onChanged={() => currentProject?.id && loadProject(currentProject.id)}
          mode="fill"
        />
      )}
    </div>
  );
}
