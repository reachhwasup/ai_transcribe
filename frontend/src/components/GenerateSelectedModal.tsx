import { useState, RefObject } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { generateSelectedVideo } from '../api/client';
import {
  X,
  Loader2,
  Check,
  Download,
  AlertCircle,
  Film,
} from 'lucide-react';

const FONT_COLORS = [
  { label: 'White', value: 'white' },
  { label: 'Yellow', value: 'yellow' },
  { label: 'Red', value: 'red' },
  { label: 'Green', value: 'green' },
  { label: 'Cyan', value: 'cyan' },
  { label: 'Black', value: 'black' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  videoRef: RefObject<HTMLVideoElement | null>;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function GenerateSelectedModal({ open, onClose, videoRef }: Props) {
  const { currentProject } = useProjectStore();
  const duration = currentProject?.duration || 0;
  const segments = currentProject?.segments || [];

  const [processing, setProcessing] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const [startTime, setStartTime] = useState('0');
  const [endTime, setEndTime] = useState(String(Math.min(60, Math.floor(duration))));
  const [text, setText] = useState('');
  const [fontSize, setFontSize] = useState('48');
  const [fontColor, setFontColor] = useState('white');
  const [position, setPosition] = useState('bottom');

  const projectName = currentProject?.name?.replace(/\s+/g, '_') || 'video';
  const hasVideo = !!currentProject?.video_path;

  const setFromPlayhead = (setter: (v: string) => void) => {
    const t = videoRef.current?.currentTime;
    if (t !== undefined) setter(t.toFixed(2));
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  // Get segments within the selected range
  const st = parseFloat(startTime) || 0;
  const et = parseFloat(endTime) || 0;
  const clipDuration = Math.max(0, et - st);
  const selectedSegments = segments.filter(
    (seg) => seg.end_time > st && seg.start_time < et
  );

  const handleGenerate = async () => {
    if (!currentProject) return;
    if (et <= st) { setError('End time must be greater than start time'); return; }
    setProcessing(true);
    setDone(false);
    setError('');
    try {
      await generateSelectedVideo(
        currentProject.id, st, et,
        text || undefined, parseInt(fontSize) || 48,
        fontColor, position, 0.5,
      );
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Generate failed');
    }
    setProcessing(false);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-lg mx-4 shadow-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-2">
            <Film className="w-5 h-5 text-blue-400" />
            <h2 className="text-lg font-semibold text-white">Generate Selected Video</h2>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-zinc-800 rounded-lg transition-colors">
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4 overflow-y-auto flex-1">
          {!hasVideo ? (
            <p className="text-center text-zinc-500 py-4">No video uploaded.</p>
          ) : (
            <>
              {/* Duration info */}
              <div className="flex items-center justify-between px-3 py-2 bg-zinc-800/60 rounded-lg">
                <span className="text-xs text-zinc-500">Video Duration</span>
                <span className="text-sm font-mono text-zinc-300">
                  {formatTime(duration)} ({duration.toFixed(1)}s)
                </span>
              </div>

              {/* Timeline visual */}
              <div className="space-y-1">
                <div className="relative h-8 bg-zinc-800 rounded-lg overflow-hidden">
                  {/* Selected range */}
                  {duration > 0 && (
                    <div
                      className="absolute top-0 bottom-0 bg-blue-600/30 border-l-2 border-r-2 border-blue-500"
                      style={{
                        left: `${(st / duration) * 100}%`,
                        width: `${(clipDuration / duration) * 100}%`,
                      }}
                    />
                  )}
                  {/* Segment markers */}
                  {segments.map((seg, i) => (
                    <div
                      key={seg.id || i}
                      className={`absolute top-1 bottom-1 rounded-sm ${
                        seg.end_time > st && seg.start_time < et
                          ? 'bg-blue-500/40'
                          : 'bg-zinc-700/40'
                      }`}
                      style={{
                        left: `${(seg.start_time / duration) * 100}%`,
                        width: `${Math.max(0.3, ((seg.end_time - seg.start_time) / duration) * 100)}%`,
                      }}
                    />
                  ))}
                </div>
                <div className="flex justify-between text-[10px] text-zinc-600 font-mono">
                  <span>0:00</span>
                  <span>{formatTime(duration)}</span>
                </div>
              </div>

              {/* Start / End Time */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Start Time (s)</label>
                  <div className="flex gap-1.5">
                    <input
                      type="number" min={0} max={duration} step={0.1} value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      className="flex-1 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={() => setFromPlayhead(setStartTime)}
                      className="px-2.5 py-1 bg-zinc-800 border border-zinc-700 rounded-lg text-[10px] text-zinc-400 hover:text-white hover:border-blue-500 transition-colors"
                      title="Set from current playhead"
                    >
                      Set
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">End Time (s)</label>
                  <div className="flex gap-1.5">
                    <input
                      type="number" min={0} max={duration} step={0.1} value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      className="flex-1 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={() => setFromPlayhead(setEndTime)}
                      className="px-2.5 py-1 bg-zinc-800 border border-zinc-700 rounded-lg text-[10px] text-zinc-400 hover:text-white hover:border-blue-500 transition-colors"
                      title="Set from current playhead"
                    >
                      Set
                    </button>
                  </div>
                </div>
              </div>

              {/* Clip info */}
              <div className="flex items-center justify-between px-3 py-2 bg-zinc-800/40 rounded-lg border border-zinc-700/50">
                <div>
                  <span className="text-xs text-zinc-500">Clip Duration: </span>
                  <span className="text-sm font-mono text-blue-400">{clipDuration.toFixed(1)}s</span>
                </div>
                {selectedSegments.length > 0 && (
                  <div>
                    <span className="text-xs text-zinc-500">Subtitles: </span>
                    <span className="text-sm font-mono text-blue-400">{selectedSegments.length} segments</span>
                  </div>
                )}
              </div>

              {/* Quick presets */}
              <div className="flex gap-2 flex-wrap">
                {[15, 30, 60, 90].filter((d) => d <= duration).map((d) => (
                  <button
                    key={d}
                    onClick={() => { setStartTime('0'); setEndTime(String(d)); }}
                    className="px-2.5 py-1 rounded-md text-xs bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-white hover:border-blue-500 transition-colors"
                  >
                    First {d < 60 ? `${d}s` : `${d / 60}m`}
                  </button>
                ))}
                <button
                  onClick={() => { setStartTime('0'); setEndTime(String(Math.floor(duration))); }}
                  className="px-2.5 py-1 rounded-md text-xs bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-white hover:border-blue-500 transition-colors"
                >
                  Full video
                </button>
              </div>

              {/* Subtitle segments in range */}
              {selectedSegments.length > 0 && (
                <div className="border-t border-zinc-800 pt-3">
                  <p className="text-xs text-zinc-500 mb-2">Subtitles in selected range:</p>
                  <div className="max-h-[100px] overflow-y-auto space-y-1 border border-zinc-800 rounded-lg p-2">
                    {selectedSegments.slice(0, 15).map((seg, i) => (
                      <div key={seg.id || i} className="flex items-start gap-2 text-[11px]">
                        <span className="text-zinc-600 font-mono shrink-0 w-[80px]">
                          {formatTime(seg.start_time)}-{formatTime(seg.end_time)}
                        </span>
                        <span className="text-zinc-300 truncate">{seg.text}</span>
                      </div>
                    ))}
                    {selectedSegments.length > 15 && (
                      <p className="text-[10px] text-zinc-600 text-center">...and {selectedSegments.length - 15} more</p>
                    )}
                  </div>
                </div>
              )}

              {/* Optional text overlay */}
              <div className="border-t border-zinc-800 pt-3">
                <label className="text-xs text-zinc-400 block mb-1">Text Overlay <span className="text-zinc-600">(optional)</span></label>
                <input
                  type="text" value={text} onChange={(e) => setText(e.target.value)}
                  placeholder="Add text to the clip..."
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500"
                />
              </div>
              {text && (
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs text-zinc-400 block mb-1">Size</label>
                    <input type="number" min={12} max={200} value={fontSize} onChange={(e) => setFontSize(e.target.value)}
                      className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-blue-500" />
                  </div>
                  <div>
                    <label className="text-xs text-zinc-400 block mb-1">Color</label>
                    <select value={fontColor} onChange={(e) => setFontColor(e.target.value)}
                      className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500">
                      {FONT_COLORS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-zinc-400 block mb-1">Position</label>
                    <select value={position} onChange={(e) => setPosition(e.target.value)}
                      className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500">
                      <option value="top">Top</option>
                      <option value="center">Center</option>
                      <option value="bottom">Bottom</option>
                    </select>
                  </div>
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="flex items-center gap-2 px-3 py-2 bg-red-900/20 border border-red-800/30 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  <p className="text-xs text-red-300">{error}</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-zinc-800 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors">
            Cancel
          </button>
          {hasVideo && (
            <button
              onClick={handleGenerate}
              disabled={processing || clipDuration <= 0}
              className="flex items-center gap-2 px-4 py-2 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 bg-blue-700 hover:bg-blue-600"
            >
              {processing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : done ? (
                <Check className="w-4 h-4" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              {done ? 'Downloaded!' : processing ? 'Generating...' : 'Generate & Download'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
