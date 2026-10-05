import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import VoiceCapturePanel from '../VoiceCapturePanel';

export default function VoiceCaptureModal({ initialTime, onClose }: {
  initialTime: number;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return createPortal(
    <dialog ref={dialog} onCancel={onClose} aria-labelledby="capture-voice-title"
      onKeyDown={event => event.stopPropagation()}
      className="m-auto p-0 w-[min(1100px,calc(100vw-32px))] max-h-[90vh] rounded-2xl border border-[var(--s6)] bg-[var(--s2)] text-zinc-200 shadow-2xl backdrop:bg-black/70">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--s5)]">
        <div>
          <h2 id="capture-voice-title" className="text-sm font-semibold text-white">Capture Voice</h2>
          <p className="text-[11px] text-zinc-400 mt-0.5">
            Clone a character from the movie itself — a real recording is what makes the dub say
            the right words.
          </p>
        </div>
        <button autoFocus onClick={onClose} aria-label="Close voice capture" className="p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-[var(--s4)] transition-colors"><X className="w-4 h-4" /></button>
      </div>
      <VoiceCapturePanel initialTime={initialTime} />
    </dialog>, document.body,
  );
}
