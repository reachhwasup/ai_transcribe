import { useState, RefObject } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { cutVideo } from '../api/client';
import {
  X,
  Scissors,
  Loader2,
  Check,
  Play,
  Download,
  AlertCircle,
} from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  videoRef: RefObject<HTMLVideoElement | null>;
}

export default function VideoCutModal({ open, onClose, videoRef }: Props) {
  const { currentProject } = useProjectStore();

  const duration = currentProject?.duration || 0;
  const [startTime, setStartTime] = useState('0');
  const [endTime, setEndTime] = useState(String(Math.min(60, Math.floor(duration))));
  const [processing, setProcessing] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const startSec = parseFloat(startTime) || 0;
  const endSec = parseFloat(endTime) || 0;
  const clipDuration = Math.max(0, endSec - startSec);

  const handlePreview = (time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      videoRef.current.play();
    }
  };

  const setFromCurrentTime = (field: 'start' | 'end') => {
    const t = videoRef.current?.currentTime || 0;
    if (field === 'start') setStartTime(t.toFixed(2));
    else setEndTime(t.toFixed(2));
  };

  const handleCut = async () => {
    if (!currentProject) return;
    if (endSec <= startSec) {
      setError('End time must be greater than start time');
      return;
    }

    setProcessing(true);
    setError('');
    setDone(false);

    try {
      await cutVideo(currentProject.id, startSec, endSec);
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Cut failed');
    }
    setProcessing(false);
  };

  if (!open) return null;

  const hasVideo = !!currentProject?.video_path;

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-lg mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <Scissors className="w-5 h-5 text-orange-400" />
            <h2 className="text-lg font-semibold text-white">Cut Video</h2>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-zinc-800 rounded-lg transition-colors">
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
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

              {/* Visual range */}
              <div className="space-y-2">
                <div className="relative h-8 bg-zinc-800 rounded-lg overflow-hidden">
                  {/* Full range */}
                  <div className="absolute inset-0 bg-zinc-800" />
                  {/* Selected range */}
                  {duration > 0 && (
                    <div
                      className="absolute top-0 bottom-0 bg-orange-600/30 border-l-2 border-r-2 border-orange-500"
                      style={{
                        left: `${(startSec / duration) * 100}%`,
                        width: `${(clipDuration / duration) * 100}%`,
                      }}
                    />
                  )}
                </div>
                <div className="flex justify-between text-[10px] text-zinc-600 font-mono">
                  <span>0:00</span>
                  <span>{formatTime(duration)}</span>
                </div>
              </div>

              {/* Time inputs */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-zinc-400 block mb-1.5">Start Time (seconds)</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min={0}
                      max={duration}
                      step={0.1}
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-khmer-500"
                    />
                    <button
                      onClick={() => setFromCurrentTime('start')}
                      className="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded-lg text-[10px] text-zinc-400 hover:text-white hover:border-zinc-500 transition-colors"
                      title="Use current playhead position"
                    >
                      Set
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-zinc-400 block mb-1.5">End Time (seconds)</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min={0}
                      max={duration}
                      step={0.1}
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white font-mono focus:outline-none focus:border-khmer-500"
                    />
                    <button
                      onClick={() => setFromCurrentTime('end')}
                      className="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded-lg text-[10px] text-zinc-400 hover:text-white hover:border-zinc-500 transition-colors"
                      title="Use current playhead position"
                    >
                      Set
                    </button>
                  </div>
                </div>
              </div>

              {/* Clip info */}
              <div className="flex items-center justify-between px-3 py-2 bg-zinc-800/40 rounded-lg border border-zinc-700/50">
                <span className="text-xs text-zinc-500">Clip Duration</span>
                <span className={`text-sm font-mono font-medium ${clipDuration > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {clipDuration.toFixed(1)}s ({formatTime(clipDuration)})
                </span>
              </div>

              {/* Quick presets */}
              <div>
                <span className="text-xs text-zinc-500 block mb-2">Quick Presets</span>
                <div className="flex gap-2 flex-wrap">
                  {[15, 30, 60, 90, 180].filter((d) => d <= duration).map((d) => (
                    <button
                      key={d}
                      onClick={() => {
                        setStartTime('0');
                        setEndTime(String(d));
                      }}
                      className="px-3 py-1.5 rounded-md text-xs bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 transition-colors"
                    >
                      First {d < 60 ? `${d}s` : `${d / 60}m`}
                    </button>
                  ))}
                  <button
                    onClick={() => {
                      setStartTime(String(Math.max(0, duration - 60)));
                      setEndTime(String(Math.floor(duration)));
                    }}
                    className="px-3 py-1.5 rounded-md text-xs bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 transition-colors"
                  >
                    Last 60s
                  </button>
                </div>
              </div>

              {/* Preview button */}
              <button
                onClick={() => handlePreview(startSec)}
                className="flex items-center gap-2 text-xs text-khmer-400 hover:text-khmer-300 transition-colors"
              >
                <Play className="w-3.5 h-3.5" />
                Preview from start point
              </button>

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
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          {hasVideo && (
            <button
              onClick={handleCut}
              disabled={processing || clipDuration <= 0}
              className="flex items-center gap-2 px-4 py-2 bg-orange-700 hover:bg-orange-600 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
            >
              {processing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : done ? (
                <Check className="w-4 h-4" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              {done ? 'Downloaded!' : processing ? 'Cutting...' : 'Cut & Download'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
