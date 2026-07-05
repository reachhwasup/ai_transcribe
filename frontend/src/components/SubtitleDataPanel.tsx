import { useState, useEffect, useRef, RefObject } from 'react';
import { useProjectStore } from '../stores/projectStore';
import type { Segment } from '../types';
import {
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  Volume2,
  ChevronDown,
  Loader2,
  RefreshCw,
} from 'lucide-react';

import { buildClipLayout, timelineToSource } from '../utils/clipTimemap';

const VOICE_OPTIONS = [
  { id: '', label: 'Auto (ស្វ័យ)', gender: '' },
  { id: 'km-KH-SreymomNeural', label: '🎀 ស្រីមុំ (ស្រី)', gender: 'F' },
  { id: 'km-KH-PisethNeural', label: '👔 ពិសិដ្ឋ (ប្រុស)', gender: 'M' },
  { id: 'zh-CN-XiaoxiaoNeural', label: '🎀 晓晓 (女)', gender: 'F' },
  { id: 'zh-CN-XiaoyiNeural', label: '🎀 晓依 (女)', gender: 'F' },
  { id: 'zh-CN-YunxiNeural', label: '👔 云希 (男)', gender: 'M' },
  { id: 'zh-CN-YunjianNeural', label: '👔 云健 (男)', gender: 'M' },
  { id: 'en-US-AvaMultilingualNeural', label: '🎀 Ava (ស្រី)', gender: 'F' },
  { id: 'en-US-EmmaMultilingualNeural', label: '🎀 Emma (ស្រី)', gender: 'F' },
  { id: 'en-US-AndrewMultilingualNeural', label: '👔 Andrew (ប្រុស)', gender: 'M' },
  { id: 'en-US-BrianMultilingualNeural', label: '👔 Brian (ប្រុស)', gender: 'M' },
  { id: 'fr-FR-VivienneMultilingualNeural', label: '🎀 Vivienne (ស្រី)', gender: 'F' },
  { id: 'fr-FR-RemyMultilingualNeural', label: '👔 Rémy (ប្រុស)', gender: 'M' },
  { id: 'de-DE-SeraphinaMultilingualNeural', label: '🎀 Seraphina (ស្រី)', gender: 'F' },
  { id: 'de-DE-FlorianMultilingualNeural', label: '👔 Florian (ប្រុស)', gender: 'M' },
];

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
}

export default function SubtitleDataPanel({ videoRef }: Props) {
  const {
    currentProject,
    currentTime,
    activeSegmentId,
    updateSegment,
    deleteSegment,
    addSegment,
    setActiveSegment,
    bulkSetVoice,
    isGeneratingAudio,
    isTranscribing,
    retranscribeSelected,
    videoClips,
    setSelectedSegmentIds,
  } = useProjectStore();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editStart, setEditStart] = useState('');
  const [editEnd, setEditEnd] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [newStart, setNewStart] = useState('');
  const [newEnd, setNewEnd] = useState('');
  const [newText, setNewText] = useState('');
  const activeRef = useRef<HTMLTableRowElement>(null);

  const segments = currentProject?.segments || [];

  useEffect(() => {
    if (activeSegmentId && activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeSegmentId]);

  // Sync local selectedIds to store whenever it changes
  useEffect(() => {
    setSelectedSegmentIds(selectedIds);
  }, [selectedIds, setSelectedSegmentIds]);

  // Delete selected segments with Delete/Backspace key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (selectedIds.size === 0) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      handleDeleteSelected();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === segments.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(segments.map((s) => s.id)));
    }
  };

  const startEdit = (seg: Segment) => {
    setEditingId(seg.id);
    setEditText(seg.text);
    setEditStart(formatTimeInput(seg.start_time));
    setEditEnd(formatTimeInput(seg.end_time));
  };

  const saveEdit = async () => {
    if (!editingId) return;
    await updateSegment(editingId, {
      text: editText,
      start_time: parseTimeInput(editStart),
      end_time: parseTimeInput(editEnd),
      audio_url: '',
    });
    setEditingId(null);
  };

  const cancelEdit = () => setEditingId(null);

  const handleAddText = () => {
    // currentTime is in timeline space; convert to source time for segment placement
    let sourceTime = 0;
    if (videoClips.length > 0) {
      const layout = buildClipLayout(videoClips);
      const result = timelineToSource(layout, currentTime);
      sourceTime = result ? result.sourceTime : layout[0]?.clip.source_start ?? 0;
    } else {
      sourceTime = currentTime;
    }
    setNewStart(formatTimeInput(sourceTime));
    setNewEnd(formatTimeInput(sourceTime + 3));
    setNewText('អត្ថបទថ្មី');
    setShowAddForm(true);
  };

  const confirmAdd = async () => {
    await addSegment({
      start_time: parseTimeInput(newStart),
      end_time: parseTimeInput(newEnd),
      text: newText,
      speaker: '',
      voice_profile: 'female',
    });
    setShowAddForm(false);
  };

  const cancelAdd = () => setShowAddForm(false);

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Delete ${selectedIds.size} segment(s)?`)) return;
    for (const id of selectedIds) {
      await deleteSegment(id);
    }
    setSelectedIds(new Set());
  };

  const handleBulkVoice = async (voice: string) => {
    const ids = selectedIds.size > 0 ? Array.from(selectedIds) : undefined;
    await bulkSetVoice(voice, ids);
  };

  const handleVoiceChange = async (segId: string, voice: string) => {
    await updateSegment(segId, { voice_profile: voice, voice_name: '', audio_url: '', audio_speed: 1.0 });
  };

  const handleSpeedChange = async (segId: string, speed: number) => {
    await updateSegment(segId, { audio_speed: speed, audio_url: '' });
  };

  const handleVoiceNameChange = async (segId: string, voiceName: string) => {
    await updateSegment(segId, { voice_name: voiceName, audio_url: '' });
  };


  const seekTo = (time: number) => {
    if (videoRef.current) videoRef.current.currentTime = time;
  };

  const formatTime = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 100);
    return `${mins.toString().padStart(2, '0')}:${secs
      .toString()
      .padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  const formatTimeInput = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = (s % 60).toFixed(2);
    return `${mins.toString().padStart(2, '0')}:${parseFloat(secs) < 10 ? '0' : ''}${secs}`;
  };

  const parseTimeInput = (t: string) => {
    const parts = t.split(':');
    if (parts.length === 2) {
      return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return parseFloat(t) || 0;
  };

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: 'var(--bg-base)' }}>
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-zinc-800 shrink-0 bg-zinc-900/60">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-300 mr-2">
          <span className="text-base">📝</span> Subtitles
          {segments.length > 0 && (
            <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-zinc-800 text-zinc-400">
              {segments.length}
            </span>
          )}
        </div>

        <div className="h-4 w-px bg-zinc-700 mx-1" />

        <button
          onClick={handleAddText}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors"
          title="Add a new text segment at the current time"
        >
          <Plus className="w-3.5 h-3.5" /> Add
        </button>

        <button
          onClick={() => {
            const seg = segments.find((s) => s.id === activeSegmentId);
            if (seg) startEdit(seg);
          }}
          disabled={!activeSegmentId || editingId !== null}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-amber-400 hover:bg-amber-900/30 hover:text-amber-300 transition-colors disabled:opacity-30"
          title={activeSegmentId ? 'Edit active segment' : 'Select a segment to edit'}
        >
          <Pencil className="w-3.5 h-3.5" /> Edit
        </button>

        <button
          onClick={handleDeleteSelected}
          disabled={selectedIds.size === 0}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-red-400 hover:bg-red-900/30 hover:text-red-300 transition-colors disabled:opacity-30"
          title={selectedIds.size > 0 ? `Delete ${selectedIds.size} selected` : 'Select segments to delete'}
        >
          <Trash2 className="w-3.5 h-3.5" />
          {selectedIds.size > 0 && <span>{selectedIds.size}</span>}
        </button>

        <button
          onClick={async () => {
            const ids = Array.from(selectedIds);
            if (ids.length === 0) return;
            if (!confirm(`Re-transcribe ${ids.length} selected segment(s)?`)) return;
            await retranscribeSelected(ids);
          }}
          disabled={selectedIds.size === 0 || isTranscribing}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-cyan-400 hover:bg-cyan-900/30 hover:text-cyan-300 transition-colors disabled:opacity-30"
          title={selectedIds.size > 0 ? `Re-transcribe ${selectedIds.size} selected` : 'Select segments to re-transcribe'}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {selectedIds.size > 0 && <span>{selectedIds.size}</span>}
        </button>

        <div className="flex-1" />

        {/* Bulk voice — compact dropdown style */}
        {segments.length > 0 && (
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-zinc-500">Voice:</span>
            <button
              onClick={() => handleBulkVoice('male')}
              className="px-2 py-1 rounded text-[10px] font-medium bg-blue-900/30 text-blue-400 hover:bg-blue-900/50 transition-colors"
              title={selectedIds.size > 0 ? `Set ${selectedIds.size} selected to Male` : 'Set all to Male'}
            >
              M
            </button>
            <button
              onClick={() => handleBulkVoice('female')}
              className="px-2 py-1 rounded text-[10px] font-medium bg-pink-900/30 text-pink-400 hover:bg-pink-900/50 transition-colors"
              title={selectedIds.size > 0 ? `Set ${selectedIds.size} selected to Female` : 'Set all to Female'}
            >
              F
            </button>
            <button
              onClick={() => handleBulkVoice('young')}
              className="px-2 py-1 rounded text-[10px] font-medium bg-green-900/30 text-green-400 hover:bg-green-900/50 transition-colors"
              title={selectedIds.size > 0 ? `Set ${selectedIds.size} selected to Young` : 'Set all to Young'}
            >
              Y
            </button>
            <button
              onClick={() => handleBulkVoice('old')}
              className="px-2 py-1 rounded text-[10px] font-medium bg-amber-900/30 text-amber-400 hover:bg-amber-900/50 transition-colors"
              title={selectedIds.size > 0 ? `Set ${selectedIds.size} selected to Old` : 'Set all to Old'}
            >
              O
            </button>
          </div>
        )}
      </div>

      {/* Add Segment Modal */}
      {showAddForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={cancelAdd}>
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-md p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Add New Segment</h3>
              <button onClick={cancelAdd} className="p-1 rounded hover:bg-zinc-700 transition-colors">
                <X className="w-4 h-4 text-zinc-400" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] text-zinc-400 uppercase tracking-wide block mb-1">Start</label>
                <input
                  type="text"
                  value={newStart}
                  onChange={(e) => setNewStart(e.target.value)}
                  placeholder="00:00.00"
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
                />
              </div>
              <div>
                <label className="text-[11px] text-zinc-400 uppercase tracking-wide block mb-1">End</label>
                <input
                  type="text"
                  value={newEnd}
                  onChange={(e) => setNewEnd(e.target.value)}
                  placeholder="00:03.00"
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
                />
              </div>
            </div>

            <div>
              <label className="text-[11px] text-zinc-400 uppercase tracking-wide block mb-1">Text</label>
              <textarea
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmAdd(); } if (e.key === 'Escape') cancelAdd(); }}
                rows={3}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-sm text-white font-khmer focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 resize-none"
                autoFocus
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={cancelAdd}
                className="px-4 py-2 rounded-lg text-xs font-medium text-zinc-300 bg-zinc-700 hover:bg-zinc-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmAdd}
                className="px-4 py-2 rounded-lg text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 transition-colors"
              >
                Add Segment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {segments.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-500 px-6 py-8">
            <div className="text-3xl mb-3 opacity-30">📝</div>
            <p className="text-sm font-medium text-zinc-400 mb-1">No subtitles yet</p>
            <p className="text-xs text-center text-zinc-600 max-w-[260px] leading-relaxed">
              {!currentProject?.video_filename 
                ? 'Upload a video first, then click Transcribe in the timeline toolbar to generate subtitles automatically.'
                : 'Click the Transcribe button in the timeline toolbar below, or use Add to create subtitles manually.'}
            </p>
            {!currentProject?.video_filename ? null : (
              <button
                onClick={handleAddText}
                className="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Add manually
              </button>
            )}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-zinc-900/95 z-10">
              <tr className="border-b border-zinc-800">
                <th className="w-10 px-2 py-2.5">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === segments.length && segments.length > 0}
                    onChange={toggleSelectAll}
                    className="accent-khmer-500 w-3.5 h-3.5 cursor-pointer"
                  />
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                  Start
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                  End
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                  Khmer Text (Editable)
                </th>
                <th className="px-3 py-2.5 text-center text-[11px] font-semibold text-zinc-400 uppercase tracking-wider w-[120px]">
                  Voice Profile
                </th>
                <th className="px-3 py-2.5 text-center text-[11px] font-semibold text-zinc-400 uppercase tracking-wider w-[150px]">
                  AI Voice
                </th>
                <th className="px-3 py-2.5 text-center text-[11px] font-semibold text-zinc-400 uppercase tracking-wider w-[90px]">
                  Speed
                </th>
                <th className="px-3 py-2.5 text-center text-[11px] font-semibold text-zinc-400 uppercase tracking-wider w-[80px]">
                  Audio Status
                </th>
              </tr>
            </thead>
            <tbody>
              {segments.map((seg) => {
                const isActive = seg.id === activeSegmentId;
                const isEditing = seg.id === editingId;
                const isSelected = selectedIds.has(seg.id);

                return (
                  <tr
                    key={seg.id}
                    ref={isActive ? activeRef : undefined}
                    className={`border-b border-zinc-800/50 cursor-pointer transition-colors ${
                      isActive
                        ? 'bg-indigo-900/20 border-l-2 border-l-indigo-500'
                        : isSelected
                        ? 'bg-zinc-800/40'
                        : 'hover:bg-zinc-800/30'
                    }`}
                    onClick={() => {
                      if (!isEditing) {
                        setActiveSegment(seg.id);
                        seekTo(seg.start_time);
                      }
                    }}
                  >
                    {/* Checkbox */}
                    <td className="px-2 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(seg.id)}
                        className="accent-khmer-500 w-3.5 h-3.5 cursor-pointer"
                      />
                    </td>

                    {/* Start Time */}
                    <td className="px-3 py-2">
                      {isEditing ? (
                        <input
                          type="text"
                          value={editStart}
                          onChange={(e) => setEditStart(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-20 px-1.5 py-1 bg-zinc-800 border border-zinc-600 rounded text-xs text-white font-mono focus:outline-none focus:border-khmer-500"
                        />
                      ) : (
                        <span className="text-xs font-mono text-khmer-400">
                          {formatTime(seg.start_time)}
                        </span>
                      )}
                    </td>

                    {/* End Time */}
                    <td className="px-3 py-2">
                      {isEditing ? (
                        <input
                          type="text"
                          value={editEnd}
                          onChange={(e) => setEditEnd(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-20 px-1.5 py-1 bg-zinc-800 border border-zinc-600 rounded text-xs text-white font-mono focus:outline-none focus:border-khmer-500"
                        />
                      ) : (
                        <span className="text-xs font-mono text-zinc-400">
                          {formatTime(seg.end_time)}
                        </span>
                      )}
                    </td>

                    {/* Khmer Text */}
                    <td className="px-3 py-2">
                      {isEditing ? (
                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="text"
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveEdit();
                              if (e.key === 'Escape') cancelEdit();
                            }}
                            className="flex-1 px-2 py-1 bg-zinc-800 border border-zinc-600 rounded text-sm text-white font-khmer focus:outline-none focus:border-khmer-500"
                            autoFocus
                          />
                          <button
                            onClick={saveEdit}
                            className="p-1 bg-green-800/50 hover:bg-green-700/50 rounded"
                          >
                            <Check className="w-3.5 h-3.5 text-green-400" />
                          </button>
                          <button
                            onClick={cancelEdit}
                            className="p-1 bg-zinc-700 hover:bg-zinc-600 rounded"
                          >
                            <X className="w-3.5 h-3.5 text-zinc-400" />
                          </button>
                        </div>
                      ) : (
                        <span
                          className="text-sm text-zinc-200 font-khmer leading-relaxed block"
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            startEdit(seg);
                          }}
                        >
                          {seg.text}
                        </span>
                      )}
                    </td>

                    {/* Voice Profile */}
                    <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                      <select
                        value={seg.voice_profile || 'female'}
                        onChange={(e) => handleVoiceChange(seg.id, e.target.value)}
                        className={`px-2 py-1 rounded-md text-xs font-medium border cursor-pointer appearance-none text-center ${
                          (seg.voice_profile || 'female') === 'female'
                            ? 'bg-pink-900/30 text-pink-300 border-pink-800/50'
                            : 'bg-blue-900/30 text-blue-300 border-blue-800/50'
                        }`}
                        style={{ minWidth: '80px' }}
                      >
                        <option value="female">Female</option>
                        <option value="male">Male</option>
                      </select>
                    </td>

                    {/* AI Voice */}
                    <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                      <select
                        value={seg.voice_name || ''}
                        onChange={(e) => handleVoiceNameChange(seg.id, e.target.value)}
                        className="px-1.5 py-1 rounded-md text-xs font-medium border cursor-pointer appearance-none text-center bg-violet-900/20 text-violet-300 border-violet-800/40"
                        style={{ minWidth: '130px' }}
                      >
                        {VOICE_OPTIONS
                          .filter((v) => !v.gender || v.gender === ((seg.voice_profile || 'female') === 'female' ? 'F' : 'M'))
                          .map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    </td>

                    {/* Speed */}
                    <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                      <select
                        value={seg.audio_speed || 1.0}
                        onChange={(e) => handleSpeedChange(seg.id, parseFloat(e.target.value))}
                        className="px-1.5 py-1 rounded-md text-xs font-medium border cursor-pointer appearance-none text-center bg-zinc-800/60 text-zinc-300 border-zinc-700/60"
                        style={{ minWidth: '65px' }}
                      >
                        <option value={0.5}>0.5x</option>
                        <option value={0.75}>0.75x</option>
                        <option value={1.0}>1.0x</option>
                        <option value={1.25}>1.25x</option>
                        <option value={1.5}>1.5x</option>
                        <option value={1.75}>1.75x</option>
                        <option value={2.0}>2.0x</option>
                      </select>
                    </td>

                    {/* Audio Status */}
                    <td className="px-3 py-2 text-center">
                      <button
                        className={`p-1.5 rounded-md transition-colors mx-auto ${
                          seg.audio_url
                            ? 'hover:bg-emerald-900/30 bg-emerald-900/10'
                            : 'hover:bg-zinc-700'
                        }`}
                        title={seg.audio_url ? 'AI audio generated - click to play' : 'No AI audio - click to play original'}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveSegment(seg.id);
                          seekTo(seg.start_time);
                          videoRef.current?.play();
                        }}
                      >
                        <Volume2 className={`w-4 h-4 ${seg.audio_url ? 'text-emerald-400' : 'text-zinc-500'}`} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
