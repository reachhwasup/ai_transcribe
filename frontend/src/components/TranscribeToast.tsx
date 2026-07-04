import { useEffect, useState } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { Loader2, CheckCircle2, XCircle, X, Sparkles } from 'lucide-react';

export default function TranscribeToast() {
  const { isTranscribing, transcribeProgress, error, currentProject } = useProjectStore();
  const [visible, setVisible] = useState(false);
  const [show, setShow] = useState(false);
  const [doneMsg, setDoneMsg] = useState('');

  // Show toast when transcription starts
  useEffect(() => {
    if (isTranscribing) {
      setVisible(true);
      setDoneMsg('');
      // Trigger slide-in animation
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setShow(true));
      });
    }
  }, [isTranscribing]);

  // When transcription finishes
  useEffect(() => {
    if (!isTranscribing && visible && !error) {
      const count = currentProject?.segments?.length || 0;
      if (count > 0) {
        setDoneMsg(`Transcription complete — ${count} segments`);
        // Auto-hide after 4 seconds
        const timer = setTimeout(() => {
          setShow(false);
          setTimeout(() => setVisible(false), 300);
        }, 4000);
        return () => clearTimeout(timer);
      } else {
        setShow(false);
        setTimeout(() => setVisible(false), 300);
      }
    }
  }, [isTranscribing, visible, error, currentProject?.segments?.length]);

  // When error occurs
  useEffect(() => {
    if (error && visible) {
      // Auto-hide error after 6 seconds
      const timer = setTimeout(() => {
        setShow(false);
        setTimeout(() => setVisible(false), 300);
      }, 6000);
      return () => clearTimeout(timer);
    }
  }, [error, visible]);

  const handleClose = () => {
    setShow(false);
    setTimeout(() => setVisible(false), 300);
  };

  if (!visible) return null;

  const segmentCount = currentProject?.segments?.length || 0;

  return (
    <div className="fixed top-4 right-4 z-[9999] pointer-events-none">
      <div
        className={`pointer-events-auto w-80 rounded-xl shadow-2xl border transition-all duration-300 ease-out ${
          show ? 'translate-x-0 opacity-100' : 'translate-x-[120%] opacity-0'
        } ${
          error
            ? 'bg-red-950/95 border-red-800/60'
            : doneMsg
            ? 'bg-emerald-950/95 border-emerald-800/60'
            : 'bg-zinc-900/95 border-zinc-700/60'
        } backdrop-blur-xl`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-3 pb-1">
          <div className="flex items-center gap-2">
            {error ? (
              <XCircle className="w-4 h-4 text-red-400" />
            ) : doneMsg ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            ) : (
              <Sparkles className="w-4 h-4 text-blue-400" />
            )}
            <span className={`text-xs font-semibold ${
              error ? 'text-red-300' : doneMsg ? 'text-emerald-300' : 'text-zinc-200'
            }`}>
              {error ? 'Transcription Error' : doneMsg ? 'Done!' : 'Transcribing'}
            </span>
          </div>
          <button
            onClick={handleClose}
            className="p-0.5 rounded hover:bg-white/10 transition-colors"
          >
            <X className="w-3.5 h-3.5 text-zinc-500" />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 pb-3 pt-1">
          {error ? (
            <p className="text-[11px] text-red-400/90 leading-relaxed line-clamp-3">{error}</p>
          ) : doneMsg ? (
            <p className="text-[11px] text-emerald-400/90 leading-relaxed">{doneMsg}</p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  {transcribeProgress || 'Starting...'}
                </p>
              </div>
              {segmentCount > 0 && (
                <div className="flex items-center gap-2 pl-5.5">
                  <div className="h-1 flex-1 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all duration-500"
                      style={{ width: `${Math.min(100, segmentCount * 2)}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-zinc-500 tabular-nums">{segmentCount} segs</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
