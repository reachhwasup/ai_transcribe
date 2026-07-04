import { create } from 'zustand';

type ThemeMode = 'dark' | 'light';

interface ThemeStore {
  mode: ThemeMode;
  toggle: () => void;
}

const STORAGE_KEY = 'dai-dubber-theme-mode';

function getInitialMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {}
  return 'dark';
}

const CSS_VARS = [
  '--bg-base', '--bg-panel', '--bg-hover',
  '--border-color', '--border-light',
  '--text-bright', '--text-primary', '--text-secondary', '--text-muted',
  '--accent-primary', '--accent-text',
];

function applyMode(mode: ThemeMode) {
  document.documentElement.setAttribute('data-theme', mode);
  localStorage.setItem(STORAGE_KEY, mode);

  // Clear inline CSS variable overrides so [data-theme] stylesheet rules take effect
  CSS_VARS.forEach(v => document.documentElement.style.removeProperty(v));
  document.body.style.removeProperty('background-color');
  document.body.style.removeProperty('color');

  // Notify custom-theme handler to re-apply (only matters for dark mode)
  window.dispatchEvent(new CustomEvent('theme-mode-changed', { detail: mode }));
}

// Apply on module load
applyMode(getInitialMode());

export const useThemeStore = create<ThemeStore>((set) => ({
  mode: getInitialMode(),
  toggle: () => set((state) => {
    const next = state.mode === 'dark' ? 'light' : 'dark';
    applyMode(next);
    return { mode: next };
  }),
}));
