import { useEffect, useState } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { Loader2, CheckCircle2, XCircle, X, Volume2 } from 'lucide-react';

export default function AudioGenerateToast() {
  const { isGeneratingAudio, audioGenProgress, audioGenTotal, error } = useProjectStore();
  const [visible, setVisible] = useState(false);
  const [show, setShow] = useState(false);
  const [doneMsg, setDoneMsg] = useState('');

  // Show toast when audio generation starts
  useEffect(() => {
    if (isGeneratingAudio) {
      setVisible(true);
      setDoneMsg('');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setShow(true));
      });
    }
  }, [isGeneratingAudio]);

  // When generation finishes
  useEffect(() => {
    if (!isGeneratingAudio && visible && !error) {
      if (audioGenTotal > 0) {
        setDoneMsg(`Audio generated — ${audioGenTotal} segments`);
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
  }, [isGeneratingAudio, visible, error, audioGenTotal]);

  // When error occurs
  useEffect(() => {
    if (error && visible && !isGeneratingAudio) {
      const timer = setTimeout(() => {
        setShow(false);
        setTimeout(() => setVisible(false), 300);
      }, 6000);
      return () => clearTimeout(timer);
    }
  }, [error, visible, isGeneratingAudio]);

  const handleClose = () => {
    setShow(false);
    setTimeout(() => setVisible(false), 300);
  };

  if (!visible) return null;

  const pct = audioGenTotal > 0 ? Math.round((audioGenProgress / audioGenTotal) * 100) : 0;

  return (
    <div className="fixed top-4 right-4 z-[9999] pointer-events-none" style={{ top: '4.5rem' }}>
      <div
        className={`pointer-events-auto w-80 rounded-xl shadow-2xl border transition-all duration-300 ease-out ${
          show ? 'translate-x-0 opacity-100' : 'translate-x-[120%] opacity-0'
        } ${
          error && !isGeneratingAudio
            ? 'bg-red-950/95 border-red-800/60'
            : doneMsg
            ? 'bg-emerald-950/95 border-emerald-800/60'
            : 'bg-zinc-900/95 border-violet-700/60'
        } backdrop-blur-xl`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-3 pb-1">
          <div className="flex items-center gap-2">
            {error && !isGeneratingAudio ? (
              <XCircle className="w-4 h-4 text-red-400" />
            ) : doneMsg ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            ) : (
              <Volume2 className="w-4 h-4 text-violet-400" />
            )}
            <span className={`text-xs font-semibold ${
              error && !isGeneratingAudio ? 'text-red-300' : doneMsg ? 'text-emerald-300' : 'text-zinc-200'
            }`}>
              {error && !isGeneratingAudio ? 'Voice Generation Error' : doneMsg ? 'Done!' : 'Generating AI Voice'}
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
          {error && !isGeneratingAudio ? (
            <p className="text-[11px] text-red-400/90 leading-relaxed line-clamp-3">{error}</p>
          ) : doneMsg ? (
            <p className="text-[11px] text-emerald-400/90 leading-relaxed">{doneMsg}</p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 text-violet-400 animate-spin shrink-0" />
                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  {audioGenProgress > 0
                    ? `Processing segment ${audioGenProgress} of ${audioGenTotal}...`
                    : 'Starting voice generation...'}
                </p>
              </div>
              {audioGenTotal > 0 && (
                <div className="flex items-center gap-2 pl-5.5">
                  <div className="h-1 flex-1 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-violet-500 rounded-full transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-zinc-500 tabular-nums">{pct}%</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
