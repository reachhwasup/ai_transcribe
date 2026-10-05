/**
 * Going straight to one line of one episode — from the review list, which names lines in
 * episodes that are not open. The line is remembered across the page change and the editor
 * goes to it once that episode has loaded.
 */
export const JUMP_TO_LINE = 'jump-to-line';
const KEY = 'jump_to_line';

export interface LineTarget { projectId: string; segmentId: string; time: number }

export function jumpToLine(target: LineTarget, navigate: (path: string) => void, currentProjectId?: string): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(target)); } catch { /* still works for the open episode */ }
  if (target.projectId !== currentProjectId) navigate(`/project/${target.projectId}`);
  window.dispatchEvent(new CustomEvent(JUMP_TO_LINE, { detail: target }));
}

/** The line waiting to be shown in this project, if any; it is taken, so it is shown once */
export function takePendingLine(projectId: string): LineTarget | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const target = JSON.parse(raw) as LineTarget;
    if (target.projectId !== projectId) return null;
    sessionStorage.removeItem(KEY);
    return target;
  } catch {
    return null;
  }
}
