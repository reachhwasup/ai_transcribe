/**
 * Editor settings kept with the project on the server: caption style, aspect ratio, blur boxes
 * and the logo. The code that uses them reads the browser's copy (localStorage), so this keeps
 * that copy in step: on opening a project the server wins, anything that only ever lived in
 * this browser is uploaded once, and every change is saved back.
 */
import { api } from '../api/client';

export type ProjectSettingKey = 'caption_style' | 'aspect_ratio' | 'blur_shapes' | 'logo' | 'video_filter' | 'track_mutes';

const LOCAL_KEY: Record<ProjectSettingKey, (id: string) => string> = {
  caption_style: (id) => `subtitle-style-${id}`,
  aspect_ratio: (id) => `aspect-ratio-${id}`,
  blur_shapes: (id) => `meatika_blur_shapes_${id}`,
  logo: (id) => `meatika_logo_settings_${id}`,
  video_filter: (id) => `video-filter-${id}`,
  // which timeline tracks are muted, the original voices among them
  track_mutes: (id) => `timeline-mutes-${id}`,
};
const KEYS = Object.keys(LOCAL_KEY) as ProjectSettingKey[];

/** Fired once a project's settings have been pulled from the server into the browser copy. */
export const PROJECT_SETTINGS_SYNCED = 'project-settings-synced';

const readLocal = (key: ProjectSettingKey, id: string): unknown => {
  try {
    const raw = localStorage.getItem(LOCAL_KEY[key](id));
    if (raw == null) return undefined;
    return key === 'aspect_ratio' ? raw : JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const writeLocal = (key: ProjectSettingKey, id: string, value: unknown) => {
  try {
    if (value == null) localStorage.removeItem(LOCAL_KEY[key](id));
    else localStorage.setItem(LOCAL_KEY[key](id), key === 'aspect_ratio' ? String(value) : JSON.stringify(value));
  } catch {
    /* storage unavailable: the server copy still holds it */
  }
};

/**
 * Pull the project's settings into the browser. `serverWins` also drops browser-only values
 * (after restoring a version, where "not set" is part of what was restored); otherwise values
 * that exist only in this browser are uploaded, so nothing set up before this existed is lost.
 */
export async function syncProjectSettings(projectId: string, serverWins = false): Promise<void> {
  let server: Partial<Record<ProjectSettingKey, unknown>> = {};
  try {
    server = (await api.get(`/projects/${projectId}/editor-settings`)).data || {};
  } catch {
    return; // offline or old backend: keep working from the browser copy
  }
  const upload: Partial<Record<ProjectSettingKey, unknown>> = {};
  for (const key of KEYS) {
    if (server[key] !== undefined) writeLocal(key, projectId, server[key]);
    else if (serverWins) writeLocal(key, projectId, null);
    else {
      const local = readLocal(key, projectId);
      if (local !== undefined) upload[key] = local;
    }
  }
  if (Object.keys(upload).length) {
    api.patch(`/projects/${projectId}/editor-settings`, upload).catch(() => {});
  }
  window.dispatchEvent(new CustomEvent(PROJECT_SETTINGS_SYNCED, { detail: { projectId } }));
}

// Saves are batched per project, so dragging a blur box does not send a request per frame
const pending = new Map<string, Partial<Record<ProjectSettingKey, unknown>>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function saveProjectSetting(projectId: string, key: ProjectSettingKey, value: unknown): void {
  if (!projectId) return;
  pending.set(projectId, { ...(pending.get(projectId) || {}), [key]: value });
  clearTimeout(timers.get(projectId));
  timers.set(
    projectId,
    setTimeout(() => {
      const body = pending.get(projectId);
      pending.delete(projectId);
      if (body) api.patch(`/projects/${projectId}/editor-settings`, body).catch(() => {});
    }, 600),
  );
}

export interface OtherPart {
  id: string;
  name: string;
  part_index: number;
  has_stems: boolean;
}

export async function listOtherParts(projectId: string): Promise<OtherPart[]> {
  return (await api.get(`/projects/${projectId}/other-parts`)).data;
}

export type ApplyItem = ProjectSettingKey | 'bgm';

export async function applyToParts(
  projectId: string,
  items: ApplyItem[],
  partIds?: string[],
): Promise<{ parts: { id: string; name: string; applied: string[]; skipped: string[] }[] }> {
  // make sure the server has this part's latest before copying it
  const body = pending.get(projectId);
  if (body) {
    clearTimeout(timers.get(projectId));
    pending.delete(projectId);
    await api.patch(`/projects/${projectId}/editor-settings`, body);
  }
  return (await api.post(`/projects/${projectId}/apply-to-parts`, { items, part_ids: partIds ?? null }, { timeout: 0 })).data;
}
