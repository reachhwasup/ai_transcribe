/**
 * The server's work queue as the editor sees it: one poll shared by everything that follows a
 * project's progress — the badges on the project tabs, the dubbing panel, the editor's reloads —
 * so they say the same thing as the progress panel without each piece asking the server.
 */
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { fetchPipeline, type PipelineJob } from '../api/client';
import { useProjectStore } from '../stores/projectStore';

const POLL_MS = 4000;

interface WatchState {
  jobs: PipelineJob[];
}

export const usePipelineStore = create<WatchState>(() => ({ jobs: [] }));

let watchers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;

async function poll() {
  if (polling || document.hidden) return;
  polling = true;
  try {
    usePipelineStore.setState({ jobs: await fetchPipeline() });
  } catch {
    /* a failed poll leaves the last view in place */
  } finally {
    polling = false;
  }
}

/** Keep the queue fresh while the calling component is on screen. */
export function usePipelineWatch() {
  useEffect(() => {
    watchers += 1;
    if (!timer) {
      void poll();
      timer = setInterval(() => void poll(), POLL_MS);
    }
    return () => {
      watchers -= 1;
      if (!watchers && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
}

/** The newest job for a project, or undefined. */
export function latestJob(jobs: PipelineJob[], projectId?: string): PipelineJob | undefined {
  if (!projectId) return undefined;
  let found: PipelineJob | undefined;
  for (const j of jobs) {
    if (j.project_id === projectId && (!found || j.queued_at > found.queued_at)) found = j;
  }
  return found;
}

export const STEP_SHORT: Record<string, string> = {
  music: 'Music', captions: 'Captions', speakers: 'Speakers', dubbing: 'Dub', export: 'Export',
};

/**
 * While the server works on the open project, reload it as each step finishes and as dubbing
 * goes along, so captions and voices appear in the editor without a refresh.
 */
export function useReloadWhileServerWorks(projectId?: string) {
  usePipelineWatch();
  const job = latestJob(usePipelineStore((s) => s.jobs), projectId);
  const loadProject = useProjectStore((s) => s.loadProject);
  const seen = useRef<{ id: string; step: string; status: string; percent: number } | null>(null);
  useEffect(() => {
    if (!job || !projectId) { seen.current = null; return; }
    const last = seen.current;
    const now = { id: job.id, step: job.step, status: job.status, percent: job.percent };
    if (!last || last.id !== job.id) { seen.current = now; return; }
    const stepEnded = last.step !== job.step && last.step !== '';
    const jobEnded = last.status !== job.status && (job.status === 'done' || job.status === 'review' || job.status === 'error');
    const grew = (job.step === 'dubbing' || job.step === 'captions') && job.percent - last.percent >= 10;
    if (stepEnded || jobEnded || grew) {
      seen.current = now;
      void loadProject(projectId);
    } else {
      // the percentage is only moved on when the editor was reloaded for it
      seen.current = { ...now, percent: last.step === job.step ? last.percent : job.percent };
    }
  }, [job, projectId, loadProject]);
}
