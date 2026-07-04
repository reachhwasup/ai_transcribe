import { useState, useEffect, useCallback } from 'react';
import { fetchSettings, updateSettings, addApiKey, toggleApiKey, deleteApiKey } from '../api/client';
import type { AppSettings, ApiKeyInfo } from '../api/client';
import {
  X,
  Key,
  Check,
  Loader2,
  Eye,
  EyeOff,
  AlertCircle,
  ExternalLink,
  Plus,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Settings,
  Palette,
  Keyboard,
  Info,
  RotateCcw,
  Moon,
  Sun,
} from 'lucide-react';
import { useThemeStore } from '../stores/themeStore';

type Tab = 'general' | 'theme' | 'apikeys' | 'shortcuts' | 'about';

interface ThemeColors {
  bgBase: string;
  bgPanel: string;
  bgHover: string;
  borderColor: string;
  borderLight: string;
  textBright: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accentPrimary: string;
  accentText: string;
}

const DEFAULT_THEME: ThemeColors = {
  bgBase: '#0f1117',
  bgPanel: '#18181b',
  bgHover: '#27272a',
  borderColor: '#3f3f46',
  borderLight: '#52525b',
  textBright: '#ffffff',
  textPrimary: '#e4e4e7',
  textSecondary: '#a1a1aa',
  textMuted: '#71717a',
  accentPrimary: '#1a6dff',
  accentText: '#7ab3ff',
};

const THEME_STORAGE_KEY = 'dai-dubber-theme';

function loadTheme(): ThemeColors {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw) return { ...DEFAULT_THEME, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_THEME };
}

function saveTheme(theme: ThemeColors) {
  localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
  applyTheme(theme);
}

function applyTheme(theme: ThemeColors) {
  // Only apply custom inline CSS vars in dark mode; light mode relies on [data-theme="light"] stylesheet
  const mode = document.documentElement.getAttribute('data-theme') || 'dark';
  if (mode === 'light') return;

  const root = document.documentElement;
  root.style.setProperty('--bg-base', theme.bgBase);
  root.style.setProperty('--bg-panel', theme.bgPanel);
  root.style.setProperty('--bg-hover', theme.bgHover);
  root.style.setProperty('--border-color', theme.borderColor);
  root.style.setProperty('--border-light', theme.borderLight);
  root.style.setProperty('--text-bright', theme.textBright);
  root.style.setProperty('--text-primary', theme.textPrimary);
  root.style.setProperty('--text-secondary', theme.textSecondary);
  root.style.setProperty('--text-muted', theme.textMuted);
  root.style.setProperty('--accent-primary', theme.accentPrimary);
  root.style.setProperty('--accent-text', theme.accentText);
}

// Re-apply custom theme when switching back to dark mode
window.addEventListener('theme-mode-changed', ((e: CustomEvent) => {
  if (e.detail === 'dark') {
    applyTheme(loadTheme());
  }
}) as EventListener);

// Apply theme on module load
applyTheme(loadTheme());

function ThemeModeToggle() {
  const { mode, toggle } = useThemeStore();
  return (
    <div className="flex gap-2">
      <button
        onClick={() => mode !== 'dark' && toggle()}
        className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-all ${
          mode === 'dark'
            ? 'border-khmer-500 bg-khmer-900/20 text-white'
            : 'border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-600'
        }`}
      >
        <Moon className="w-4 h-4" />
        Dark
      </button>
      <button
        onClick={() => mode !== 'light' && toggle()}
        className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-all ${
          mode === 'light'
            ? 'border-khmer-500 bg-khmer-900/20 text-white'
            : 'border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-600'
        }`}
      >
        <Sun className="w-4 h-4" />
        Light
      </button>
    </div>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsModal({ open, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('general');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [showNewKey, setShowNewKey] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [ttsEngine, setTtsEngine] = useState('edge-tts');
  const [voxcpmPath, setVoxcpmPath] = useState('openbmb/VoxCPM2');
  const [voxcpmSteps, setVoxcpmSteps] = useState(3);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [addingKey, setAddingKey] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // Theme state
  const [theme, setTheme] = useState<ThemeColors>(loadTheme);

  const loadSettings = async () => {
    try {
      const s = await fetchSettings();
      setSettings(s);
      setSelectedModel(s.gemini_model);
      setTtsEngine(s.tts_engine || 'edge-tts');
      setVoxcpmPath(s.voxcpm_model_path || 'openbmb/VoxCPM2');
      setVoxcpmSteps(s.voxcpm_inference_steps ?? 3);
    } catch {
      setError('Failed to load settings');
    }
    setLoading(false);
  };

  useEffect(() => {
    if (open) {
      setLoading(true);
      setError('');
      setSaved(false);
      setNewKey('');
      setNewLabel('');
      setTheme(loadTheme());
      loadSettings();
    }
  }, [open]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const updates: { gemini_model?: string; tts_engine?: string; voxcpm_model_path?: string; voxcpm_inference_steps?: number } = {};
      if (selectedModel && selectedModel !== settings?.gemini_model) {
        updates.gemini_model = selectedModel;
      }
      if (ttsEngine !== settings?.tts_engine) {
        updates.tts_engine = ttsEngine;
      }
      if (ttsEngine === 'voxcpm' && voxcpmPath !== settings?.voxcpm_model_path) {
        updates.voxcpm_model_path = voxcpmPath;
      }
      if (ttsEngine === 'voxcpm' && voxcpmSteps !== (settings?.voxcpm_inference_steps ?? 3)) {
        updates.voxcpm_inference_steps = voxcpmSteps;
      }
      if (Object.keys(updates).length > 0) {
        const updated = await updateSettings(updates);
        setSettings(updated);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Failed to save settings');
    }
    setSaving(false);
  };

  const handleAddKey = async () => {
    if (!newKey.trim()) return;
    setAddingKey(true);
    setError('');
    try {
      await addApiKey(newKey.trim(), newLabel.trim());
      setNewKey('');
      setNewLabel('');
      await loadSettings();
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Failed to add API key');
    }
    setAddingKey(false);
  };

  const handleToggleKey = async (k: ApiKeyInfo) => {
    try {
      await toggleApiKey(k.id, !k.is_active);
      await loadSettings();
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Failed to update key');
    }
  };

  const handleDeleteKey = async (k: ApiKeyInfo) => {
    try {
      await deleteApiKey(k.id);
      await loadSettings();
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Failed to delete key');
    }
  };

  const handleThemeColor = useCallback((key: keyof ThemeColors, value: string) => {
    setTheme(prev => {
      const next = { ...prev, [key]: value };
      saveTheme(next);
      return next;
    });
  }, []);

  const handleResetTheme = useCallback(() => {
    setTheme({ ...DEFAULT_THEME });
    saveTheme({ ...DEFAULT_THEME });
  }, []);

  if (!open) return null;

  const activeCount = settings?.api_keys.filter((k) => k.is_active).length ?? 0;

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'general', label: 'General', icon: <Settings className="w-4 h-4" /> },
    { id: 'theme', label: 'Theme', icon: <Palette className="w-4 h-4" /> },
    { id: 'apikeys', label: 'API Keys', icon: <Key className="w-4 h-4" /> },
    { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard className="w-4 h-4" /> },
    { id: 'about', label: 'About', icon: <Info className="w-4 h-4" /> },
  ];

  const themeFields: { key: keyof ThemeColors; label: string }[] = [
    { key: 'bgBase', label: 'BG BASE' },
    { key: 'bgPanel', label: 'BG PANEL' },
    { key: 'bgHover', label: 'BG HOVER' },
    { key: 'borderColor', label: 'BORDER COLOR' },
    { key: 'borderLight', label: 'BORDER LIGHT' },
    { key: 'textBright', label: 'TEXT BRIGHT' },
    { key: 'textPrimary', label: 'TEXT PRIMARY' },
    { key: 'textSecondary', label: 'TEXT SECONDARY' },
    { key: 'textMuted', label: 'TEXT MUTED' },
    { key: 'accentPrimary', label: 'ACCENT PRIMARY' },
    { key: 'accentText', label: 'ACCENT TEXT' },
  ];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-2xl mx-4 shadow-2xl flex flex-col"
        style={{ height: 'min(580px, 90vh)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-zinc-400" />
            <h2 className="text-lg font-semibold text-white">Preferences</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>

        {/* Tabs + Content */}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar Tabs */}
          <div className="w-40 shrink-0 border-r border-zinc-800 py-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => { setActiveTab(tab.id); setError(''); }}
                className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors text-left ${
                  activeTab === tab.id
                    ? 'bg-khmer-900/30 text-khmer-400 border-r-2 border-khmer-500'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          {/* Content Area */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 text-khmer-500 animate-spin" />
                </div>
              ) : (
                <>
                  {/* General Tab */}
                  {activeTab === 'general' && (
                    <div className="space-y-6">
                      <div>
                        <h3 className="text-sm font-semibold text-white mb-1">AI Model</h3>
                        <p className="text-xs text-zinc-500 mb-3">Select the Gemini model used for transcription.</p>
                        <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                          {settings?.available_models.map((model) => (
                            <label
                              key={model.id}
                              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-all ${
                                selectedModel === model.id
                                  ? 'border-khmer-500 bg-khmer-900/20'
                                  : 'border-zinc-800 hover:border-zinc-600 bg-zinc-800/50'
                              }`}
                            >
                              <input
                                type="radio"
                                name="model"
                                value={model.id}
                                checked={selectedModel === model.id}
                                onChange={() => setSelectedModel(model.id)}
                                className="sr-only"
                              />
                              <div
                                className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                                  selectedModel === model.id ? 'border-khmer-500' : 'border-zinc-600'
                                }`}
                              >
                                {selectedModel === model.id && <div className="w-2 h-2 rounded-full bg-khmer-500" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm text-white">{model.name}</p>
                                <p className="text-xs text-zinc-500">{model.description}</p>
                              </div>
                            </label>
                          ))}
                        </div>
                      </div>

                      {/* TTS Engine */}
                      <div>
                        <h3 className="text-sm font-semibold text-white mb-1">TTS Engine</h3>
                        <p className="text-xs text-zinc-500 mb-3">Choose the voice synthesis engine for audio generation.</p>
                        <div className="space-y-2">
                          <label
                            className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-all ${
                              ttsEngine === 'edge-tts'
                                ? 'border-blue-500 bg-blue-900/20'
                                : 'border-zinc-800 hover:border-zinc-600 bg-zinc-800/50'
                            }`}
                          >
                            <input type="radio" name="tts_engine" value="edge-tts" checked={ttsEngine === 'edge-tts'} onChange={() => setTtsEngine('edge-tts')} className="sr-only" />
                            <div className={`w-4 h-4 mt-0.5 rounded-full border-2 flex items-center justify-center shrink-0 ${ttsEngine === 'edge-tts' ? 'border-blue-500' : 'border-zinc-600'}`}>
                              {ttsEngine === 'edge-tts' && <div className="w-2 h-2 rounded-full bg-blue-500" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-white">Edge TTS <span className="text-[10px] ml-1 px-1.5 py-0.5 rounded-full bg-green-900/40 text-green-400">Recommended</span></p>
                              <p className="text-xs text-zinc-500">Microsoft Edge neural voices. No GPU needed, fast, works offline.</p>
                            </div>
                          </label>
                          <label
                            className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-all ${
                              ttsEngine === 'voxcpm'
                                ? 'border-purple-500 bg-purple-900/20'
                                : 'border-zinc-800 hover:border-zinc-600 bg-zinc-800/50'
                            }`}
                          >
                            <input type="radio" name="tts_engine" value="voxcpm" checked={ttsEngine === 'voxcpm'} onChange={() => setTtsEngine('voxcpm')} className="sr-only" />
                            <div className={`w-4 h-4 mt-0.5 rounded-full border-2 flex items-center justify-center shrink-0 ${ttsEngine === 'voxcpm' ? 'border-purple-500' : 'border-zinc-600'}`}>
                              {ttsEngine === 'voxcpm' && <div className="w-2 h-2 rounded-full bg-purple-500" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-white">VoxCPM2 <span className="text-[10px] ml-1 px-1.5 py-0.5 rounded-full bg-purple-900/40 text-purple-400">AI · GPU</span></p>
                              <p className="text-xs text-zinc-500">2B model, 30 languages incl. Khmer, voice design, emotion — requires ~8GB VRAM.</p>
                            </div>
                          </label>
                        </div>
                        {ttsEngine === 'voxcpm' && (
                          <div className="mt-3 space-y-3">
                            <div>
                              <label className="text-xs text-zinc-400 mb-1 block">Model path / HuggingFace ID</label>
                              <input
                                type="text"
                                value={voxcpmPath}
                                onChange={(e) => setVoxcpmPath(e.target.value)}
                                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-purple-500 font-mono"
                                placeholder="openbmb/VoxCPM2"
                              />
                              <p className="text-[10px] text-zinc-600 mt-1">Use a HuggingFace ID or a local path to the downloaded model weights.</p>
                            </div>
                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <label className="text-xs text-zinc-400">Speed / Quality</label>
                                <span className="text-[10px] font-mono text-purple-400">
                                  {voxcpmSteps === 2 ? 'Fast (2 steps)' : voxcpmSteps === 3 ? 'Balanced (3 steps)' : voxcpmSteps <= 5 ? 'Quality (5 steps)' : `Custom (${voxcpmSteps} steps)`}
                                </span>
                              </div>
                              <input
                                type="range"
                                min={2}
                                max={10}
                                step={1}
                                value={voxcpmSteps}
                                onChange={(e) => setVoxcpmSteps(Number(e.target.value))}
                                className="w-full accent-purple-500"
                              />
                              <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
                                <span>Faster</span>
                                <span>Higher quality</span>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Theme Tab */}
                  {activeTab === 'theme' && (
                    <div>
                      {/* Dark / Light mode toggle */}
                      <div className="mb-5">
                        <h3 className="text-sm font-semibold text-white mb-2">Appearance</h3>
                        <ThemeModeToggle />
                      </div>

                      <div className="flex items-center justify-between mb-1">
                        <h3 className="text-sm font-semibold text-white">Theme Customization</h3>
                        <button
                          onClick={handleResetTheme}
                          className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                        >
                          <RotateCcw className="w-3 h-3" />
                          Reset Defaults
                        </button>
                      </div>
                      <p className="text-xs text-zinc-500 mb-4">Customize your workspace colors.</p>

                      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                        {themeFields.map(({ key, label }) => (
                          <div key={key}>
                            <label className="text-[10px] font-semibold text-zinc-500 tracking-wider uppercase mb-1.5 block">
                              {label}
                            </label>
                            <div className="flex items-center gap-2 px-2.5 py-1.5 bg-zinc-800/60 border border-zinc-700 rounded-lg">
                              <input
                                type="color"
                                value={theme[key]}
                                onChange={(e) => handleThemeColor(key, e.target.value)}
                                className="w-6 h-6 rounded border border-zinc-600 cursor-pointer bg-transparent p-0 shrink-0"
                                style={{ appearance: 'none', WebkitAppearance: 'none' }}
                              />
                              <input
                                type="text"
                                value={theme[key].toUpperCase()}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  if (/^#[0-9A-Fa-f]{0,6}$/.test(v)) handleThemeColor(key, v);
                                }}
                                className="flex-1 bg-transparent text-xs font-mono text-zinc-300 focus:outline-none uppercase"
                                maxLength={7}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* API Keys Tab */}
                  {activeTab === 'apikeys' && (
                    <div className="space-y-4">
                      <div>
                        <div className="flex items-center gap-2 mb-3">
                          <h3 className="text-sm font-semibold text-white">Gemini API Keys</h3>
                          {activeCount > 0 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-900/40 text-green-400 font-mono">
                              {activeCount} active
                            </span>
                          )}
                        </div>

                        {/* Existing keys list */}
                        {settings?.api_keys && settings.api_keys.length > 0 ? (
                          <div className="space-y-2 mb-3">
                            {settings.api_keys.map((k) => (
                              <div
                                key={k.id}
                                className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
                                  k.is_active
                                    ? 'bg-zinc-800/60 border-zinc-700'
                                    : 'bg-zinc-800/30 border-zinc-800 opacity-60'
                                }`}
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-mono text-zinc-300">{k.preview}</span>
                                    {k.label && (
                                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400">
                                        {k.label}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <button
                                  onClick={() => handleToggleKey(k)}
                                  className="p-1 hover:bg-zinc-700 rounded transition-colors"
                                  title={k.is_active ? 'Disable key' : 'Enable key'}
                                >
                                  {k.is_active ? (
                                    <ToggleRight className="w-5 h-5 text-green-400" />
                                  ) : (
                                    <ToggleLeft className="w-5 h-5 text-zinc-500" />
                                  )}
                                </button>
                                <button
                                  onClick={() => handleDeleteKey(k)}
                                  className="p-1 hover:bg-red-900/30 rounded transition-colors"
                                  title="Delete key"
                                >
                                  <Trash2 className="w-3.5 h-3.5 text-zinc-500 hover:text-red-400" />
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="px-3 py-3 mb-3 bg-yellow-900/10 border border-yellow-800/20 rounded-lg">
                            <p className="text-xs text-yellow-300/70">No API keys configured. Add one below to start transcribing.</p>
                          </div>
                        )}

                        {/* Add new key */}
                        <div className="space-y-2">
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={newLabel}
                              onChange={(e) => setNewLabel(e.target.value)}
                              placeholder="Label (optional)"
                              className="w-28 px-2.5 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-khmer-500"
                            />
                            <div className="flex-1 relative">
                              <input
                                type={showNewKey ? 'text' : 'password'}
                                value={newKey}
                                onChange={(e) => setNewKey(e.target.value)}
                                placeholder="Paste your Gemini API key..."
                                className="w-full px-3 py-2 pr-8 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-khmer-500 font-mono"
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleAddKey();
                                }}
                              />
                              <button
                                onClick={() => setShowNewKey(!showNewKey)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-zinc-700 rounded transition-colors"
                              >
                                {showNewKey ? (
                                  <EyeOff className="w-3.5 h-3.5 text-zinc-500" />
                                ) : (
                                  <Eye className="w-3.5 h-3.5 text-zinc-500" />
                                )}
                              </button>
                            </div>
                            <button
                              onClick={handleAddKey}
                              disabled={!newKey.trim() || addingKey}
                              className="px-3 py-2 bg-khmer-600 hover:bg-khmer-700 disabled:opacity-40 text-white rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
                            >
                              {addingKey ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                              Add
                            </button>
                          </div>
                          <div className="flex items-center gap-2">
                            <a
                              href="https://aistudio.google.com/apikey"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-khmer-400 hover:text-khmer-300 transition-colors"
                            >
                              Get a free API key
                              <ExternalLink className="w-3 h-3" />
                            </a>
                            <span className="text-[10px] text-zinc-600">|</span>
                            <span className="text-[10px] text-zinc-600">Multiple keys rotate automatically</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Shortcuts Tab */}
                  {activeTab === 'shortcuts' && (
                    <div>
                      <h3 className="text-sm font-semibold text-white mb-1">Keyboard Shortcuts</h3>
                      <p className="text-xs text-zinc-500 mb-4">Quick reference for keyboard shortcuts.</p>

                      <div className="space-y-1">
                        {[
                          { keys: 'Space', action: 'Play / Pause video' },
                          { keys: '←  →', action: 'Seek backward / forward 5s' },
                          { keys: 'Shift + ←  →', action: 'Seek backward / forward 1s' },
                          { keys: 'S', action: 'Split clip at playhead' },
                          { keys: 'Delete', action: 'Delete selected clip' },
                          { keys: 'M', action: 'Mute / Unmute video' },
                          { keys: 'Ctrl + S', action: 'Save settings' },
                          { keys: 'Ctrl + Z', action: 'Undo last action' },
                          { keys: 'Ctrl + Shift + Z', action: 'Redo last action' },
                          { keys: 'Ctrl + Y', action: 'Redo last action (alt)' },
                          { keys: 'Ctrl + +  −', action: 'Zoom timeline in / out' },
                          { keys: 'Home', action: 'Go to beginning' },
                          { keys: 'End', action: 'Go to end' },
                        ].map((s) => (
                          <div key={s.keys} className="flex items-center justify-between py-2 px-3 rounded hover:bg-zinc-800/50">
                            <span className="text-xs text-zinc-300">{s.action}</span>
                            <kbd className="text-[10px] font-mono px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-400">
                              {s.keys}
                            </kbd>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* About Tab */}
                  {activeTab === 'about' && (
                    <div className="space-y-4">
                      <div className="text-center py-4">
                        <div className="w-16 h-16 mx-auto mb-3 rounded-2xl bg-gradient-to-br from-khmer-500 to-purple-600 flex items-center justify-center shadow-lg shadow-khmer-500/20">
                          <span className="text-3xl">🎬</span>
                        </div>
                        <h3 className="text-lg font-bold text-white">DAI Dubber Pro</h3>
                        <p className="text-xs text-khmer-400 font-medium">Khmer Edition</p>
                        <p className="text-[11px] text-zinc-500 mt-1">Version 1.0.0</p>
                      </div>

                      <div className="space-y-2 text-xs text-zinc-400">
                        <div className="flex justify-between py-1.5 px-3 bg-zinc-800/40 rounded">
                          <span>Engine</span>
                          <span className="text-zinc-300">Google Gemini AI</span>
                        </div>
                        <div className="flex justify-between py-1.5 px-3 bg-zinc-800/40 rounded">
                          <span>TTS</span>
                          <span className="text-zinc-300">Microsoft Edge TTS</span>
                        </div>
                        <div className="flex justify-between py-1.5 px-3 bg-zinc-800/40 rounded">
                          <span>Video Processing</span>
                          <span className="text-zinc-300">FFmpeg</span>
                        </div>
                        <div className="flex justify-between py-1.5 px-3 bg-zinc-800/40 rounded">
                          <span>Framework</span>
                          <span className="text-zinc-300">React + FastAPI</span>
                        </div>
                      </div>

                      <p className="text-[10px] text-zinc-600 text-center mt-4">
                        Built for Khmer video translation and dubbing workflows.
                      </p>
                    </div>
                  )}

                  {/* Error */}
                  {error && (
                    <div className="flex items-center gap-2 px-3 py-2 mt-4 bg-red-900/20 border border-red-800/30 rounded-lg">
                      <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                      <p className="text-xs text-red-300">{error}</p>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-3 border-t border-zinc-800 shrink-0">
              {activeTab === 'general' ? (
                <>
                  <button
                    onClick={onClose}
                    className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving || loading}
                    className="flex items-center gap-2 px-4 py-2 bg-khmer-600 hover:bg-khmer-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
                  >
                    {saving ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : saved ? (
                      <Check className="w-4 h-4" />
                    ) : null}
                    {saved ? 'Saved!' : 'Save Settings'}
                  </button>
                </>
              ) : (
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-zinc-400 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
                >
                  Close
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
