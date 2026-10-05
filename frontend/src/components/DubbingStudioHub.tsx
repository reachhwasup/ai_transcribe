import DubbingStudioPanel from './DubbingStudioPanel';

/** The dubbing side of the editor. Recaps are written from Movie Recap in the top bar. */
export default function DubbingStudioHub({ hookPanelTarget, onCloseHookPanel }: {
  hookPanelTarget?: HTMLElement | null;
  onCloseHookPanel?: () => void;
}) {
  return (
    <div className="flex flex-col h-full bg-[var(--s2)] text-[#e1e3e6] select-none font-sans overflow-hidden [contain:strict]">
      <DubbingStudioPanel hookPanelTarget={hookPanelTarget} onCloseHookPanel={onCloseHookPanel} />
    </div>
  );
}
