/**
 * Colour filters for the video: the looks, how they are adjusted, and how they are saved.
 *
 * A filter is a list of steps — the CSS filter functions, in order. The editor shows them with
 * CSS; the export applies the same steps with ffmpeg (backend/services/video_filters.py), so
 * what is previewed is what is rendered. The choice is saved with the project.
 */
import { useCallback, useEffect, useState } from 'react';
import { saveProjectSetting, PROJECT_SETTINGS_SYNCED } from './projectSettings';

export type FilterStepName = 'brightness' | 'contrast' | 'saturate' | 'grayscale' | 'sepia' | 'hue-rotate';
export type FilterStep = [FilterStepName, number];

export interface FilterPreset {
  id: string;
  name: string;
  hint: string;
  steps: FilterStep[];
}

export const FILTER_PRESETS: FilterPreset[] = [
  { id: 'none', name: 'Original', hint: 'No filter', steps: [] },
  { id: 'vivid', name: 'Vivid', hint: 'Richer colour, a little more punch', steps: [['saturate', 1.4], ['contrast', 1.15], ['brightness', 1.05]] },
  { id: 'bright', name: 'Bright & Clean', hint: 'Lifts a dull or dark source', steps: [['brightness', 1.12], ['contrast', 1.06], ['saturate', 1.12]] },
  { id: 'drama', name: 'Drama', hint: 'Deep contrast, restrained colour', steps: [['contrast', 1.28], ['saturate', 0.9], ['brightness', 0.96]] },
  { id: 'cinematic', name: 'Cinematic Teal', hint: 'Cool, contrasty film look', steps: [['contrast', 1.2], ['saturate', 1.1], ['hue-rotate', -10], ['brightness', 0.95]] },
  { id: 'warm', name: 'Warm', hint: 'Soft golden skin tones', steps: [['sepia', 0.2], ['saturate', 1.2], ['contrast', 1.04]] },
  { id: 'sunset', name: 'Golden Sunset', hint: 'Strong amber glow', steps: [['sepia', 0.35], ['saturate', 1.4], ['hue-rotate', -15], ['contrast', 1.1]] },
  { id: 'cool_blue', name: 'Cool Crisp', hint: 'Slightly blue and clear', steps: [['saturate', 1.2], ['hue-rotate', 15], ['contrast', 1.05]] },
  { id: 'faded', name: 'Faded', hint: 'Low contrast, washed pastel', steps: [['contrast', 0.88], ['brightness', 1.06], ['saturate', 0.85]] },
  { id: 'vintage', name: '70s Vintage', hint: 'Aged, slightly brown', steps: [['sepia', 0.4], ['contrast', 0.95], ['brightness', 1.05], ['saturate', 0.85]] },
  { id: 'noir', name: 'Noir B&W', hint: 'Black and white, hard contrast', steps: [['grayscale', 1], ['contrast', 1.3], ['brightness', 0.9]] },
  { id: 'cyberpunk', name: 'Cyberpunk Neon', hint: 'Shifted, saturated colour', steps: [['contrast', 1.25], ['saturate', 1.6], ['hue-rotate', 45]] },
];

/** What is saved with the project. */
export interface VideoFilterSetting {
  preset: string;
  /** How much of the look is applied: 0 = none, 1 = as designed */
  intensity: number;
  brightness: number;
  contrast: number;
  saturation: number;
  /** The resolved steps, kept alongside so an export run by the server can use them */
  steps?: FilterStep[];
}

export const DEFAULT_VIDEO_FILTER: VideoFilterSetting = { preset: 'none', intensity: 1, brightness: 1, contrast: 1, saturation: 1 };

const NEUTRAL: Record<FilterStepName, number> = { brightness: 1, contrast: 1, saturate: 1, grayscale: 0, sepia: 0, 'hue-rotate': 0 };

/** The steps a setting comes to: the look at its intensity, then the manual adjustments. */
export function resolveSteps(setting: VideoFilterSetting): FilterStep[] {
  const preset = FILTER_PRESETS.find((p) => p.id === setting.preset) || FILTER_PRESETS[0];
  const k = Math.max(0, Math.min(1, setting.intensity));
  const steps: FilterStep[] = preset.steps.map(([name, value]) => [name, +(NEUTRAL[name] + (value - NEUTRAL[name]) * k).toFixed(4)]);
  steps.push(['brightness', setting.brightness], ['contrast', setting.contrast], ['saturate', setting.saturation]);
  return steps.filter(([name, value]) => Math.abs(value - NEUTRAL[name]) > 1e-4);
}

/** The CSS `filter` value that shows these steps. */
export function cssFilter(steps: FilterStep[]): string {
  if (!steps.length) return 'none';
  return steps.map(([name, value]) => (name === 'hue-rotate' ? `hue-rotate(${value}deg)` : `${name}(${value})`)).join(' ');
}

export const isFiltered = (setting: VideoFilterSetting) => resolveSteps(setting).length > 0;

const localKey = (projectId: string) => `video-filter-${projectId}`;
const CHANGED = 'video-filter-changed';

function read(projectId?: string): VideoFilterSetting {
  if (!projectId) return DEFAULT_VIDEO_FILTER;
  try {
    const raw = JSON.parse(localStorage.getItem(localKey(projectId)) || 'null');
    return raw && typeof raw === 'object' ? { ...DEFAULT_VIDEO_FILTER, ...raw } : DEFAULT_VIDEO_FILTER;
  } catch {
    return DEFAULT_VIDEO_FILTER;
  }
}

/** The project's colour filter, shared by the player and the export window. */
export function useVideoFilter(projectId?: string): [VideoFilterSetting, (change: Partial<VideoFilterSetting>) => void] {
  const [setting, setSetting] = useState<VideoFilterSetting>(() => read(projectId));

  useEffect(() => {
    setSetting(read(projectId));
    const refresh = () => setSetting(read(projectId));
    window.addEventListener(CHANGED, refresh);
    window.addEventListener(PROJECT_SETTINGS_SYNCED, refresh);
    return () => {
      window.removeEventListener(CHANGED, refresh);
      window.removeEventListener(PROJECT_SETTINGS_SYNCED, refresh);
    };
  }, [projectId]);

  const update = useCallback((change: Partial<VideoFilterSetting>) => {
    if (!projectId) return;
    const next = { ...read(projectId), ...change };
    const saved = { ...next, steps: resolveSteps(next) };
    try { localStorage.setItem(localKey(projectId), JSON.stringify(saved)); } catch { /* the server copy still holds it */ }
    saveProjectSetting(projectId, 'video_filter', saved);
    window.dispatchEvent(new CustomEvent(CHANGED));
  }, [projectId]);

  return [setting, update];
}
