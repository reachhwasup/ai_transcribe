import { useProjectStore } from '../stores/projectStore';
import { CheckCircle2, AlertCircle, Loader2, HardDrive } from 'lucide-react';

export default function StatusBar() {
  const { currentProject, isTranscribing, error } = useProjectStore();

  const segments = currentProject?.segments?.length ?? 0;

  return (
    <div className="h-6 flex items-center justify-between px-3 bg-zinc-900/80 border-t border-zinc-800 shrink-0 text-[11px]">
      <div className="flex items-center gap-3">
        {/* Status indicator */}
        {error ? (
          <span className="flex items-center gap-1 text-red-400">
            <AlertCircle className="w-3 h-3" />
            Error
          </span>
        ) : isTranscribing ? (
          <span className="flex items-center gap-1 text-yellow-400">
            <Loader2 className="w-3 h-3 animate-spin" />
            Transcribing...
          </span>
        ) : (
          <span className="flex items-center gap-1 text-green-400">
            <CheckCircle2 className="w-3 h-3" />
            System Ready
          </span>
        )}

        <span className="text-zinc-600">|</span>
        <span className="text-zinc-500">
          Project: {currentProject?.name || 'Untitled'}
        </span>

        {segments > 0 && (
          <>
            <span className="text-zinc-600">|</span>
            <span className="text-zinc-500">{segments} segments</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-1 text-zinc-500">
        <HardDrive className="w-3 h-3" />
        Memory Usage: Normal
      </div>
    </div>
  );
}
