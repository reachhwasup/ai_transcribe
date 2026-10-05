import { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchSettings,
  updateSettings,
  addApiKey,
  toggleApiKey,
  deleteApiKey,
  fetchVoiceProfiles,
  createVoiceProfile,
  updateVoiceProfile,
  deleteVoiceProfile,
  generateVoiceSample,
  uploadVoiceSampleAudio,
} from '../api/client';
import type { AppSettings, ApiKeyInfo, VoiceProfileItem } from '../api/client';
import AppUpdate from './AppUpdate';
import { fetchPronunciations, savePronunciations, fetchStalePronunciations, redubStalePronunciations, listenToPronunciation, type Pronunciation } from '../api/client';
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
  Palette,
  Keyboard,
  Info,
  RotateCcw,
  Moon,
  Sun,
  Sparkles,
  Zap,
  Sliders,
  ShieldCheck,
  Volume2,
  Mic,
  Layers,
  Play,
  Square,
  Edit2,
  UploadCloud,
  CheckCircle2,
  Wand2,
} from 'lucide-react';
import { useThemeStore } from '../stores/themeStore';

type Tab = 'general' | 'voices' | 'pronunciation' | 'theme' | 'apikeys' | 'shortcuts' | 'about';

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
  bgBase: 'var(--s1)',
  bgPanel: 'var(--s2)',
  bgHover: 'var(--s4)',
  borderColor: 'var(--s8)',
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

window.addEventListener('theme-mode-changed', ((e: CustomEvent) => {
  if (e.detail === 'dark') {
    applyTheme(loadTheme());
  }
}) as EventListener);

applyTheme(loadTheme());

function ThemeModeToggle() {
  const { mode, toggle } = useThemeStore();
  return (
    <div className="inline-flex p-1 rounded-xl bg-[var(--s3)] border border-[var(--s5)] gap-1 shadow-inner">
      <button
        onClick={() => mode !== 'dark' && toggle()}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
          mode === 'dark'
            ? 'bg-blue-600 text-white shadow-md shadow-blue-900/30'
            : 'text-zinc-400 hover:text-zinc-200 hover:bg-[var(--s4)]'
        }`}
      >
        <Moon className="w-3.5 h-3.5" />
        Dark Mode
      </button>
      <button
        onClick={() => mode !== 'light' && toggle()}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
          mode === 'light'
            ? 'bg-blue-600 text-white shadow-md shadow-blue-900/30'
            : 'text-zinc-400 hover:text-zinc-200 hover:bg-[var(--s4)]'
        }`}
      >
        <Sun className="w-3.5 h-3.5" />
        Light Mode
      </button>
    </div>
  );
}

// Khmer only: Edge TTS ships two Khmer neural voices and the backend refuses anything
// else, so offering other languages here would just be ignored.
const EDGE_NEURAL_VOICES = [
  { id: 'km-KH-PisethNeural', name: 'Piseth (Khmer Male · ពិសិដ្ឋ)', lang: 'km', gender: 'male', engine: 'edge-tts' as const },
  { id: 'km-KH-SreymomNeural', name: 'Sreymom (Khmer Female · ស្រីមុំ)', lang: 'km', gender: 'female', engine: 'edge-tts' as const },
];

const VOXCPM_NEURAL_VOICES = [
  { id: 'voxcpm-piseth', name: 'VoxCPM2 Heroic Male (2B Khmer ពិសិដ្ឋ)', lang: 'km', gender: 'male', engine: 'voxcpm' as const },
  { id: 'voxcpm-sreymom', name: 'VoxCPM2 Gentle Female (2B Khmer ស្រីមុំ)', lang: 'km', gender: 'female', engine: 'voxcpm' as const },
  { id: 'voxcpm-lokta', name: 'VoxCPM2 Elder Master (2B Khmer លោកតា គ្រូធំ)', lang: 'km', gender: 'grandpa', engine: 'voxcpm' as const },
  { id: 'voxcpm-lokyeay', name: 'VoxCPM2 Wise Matriarch (2B Khmer លោកយាយ ចាស់ទុំ)', lang: 'km', gender: 'grandma', engine: 'voxcpm' as const },
  { id: 'voxcpm-boy', name: 'VoxCPM2 Child Boy (2B Khmer កុមារា)', lang: 'km', gender: 'child_boy', engine: 'voxcpm' as const },
  { id: 'voxcpm-girl', name: 'VoxCPM2 Child Girl (2B Khmer កុមារី)', lang: 'km', gender: 'child_girl', engine: 'voxcpm' as const },
  { id: 'voxcpm-clone', name: 'VoxCPM2 Zero-Shot Custom Cloned Audio', lang: 'km', gender: 'custom', engine: 'voxcpm' as const },
];

const AVAILABLE_NEURAL_VOICES = [...EDGE_NEURAL_VOICES, ...VOXCPM_NEURAL_VOICES];

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
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [addingKey, setAddingKey] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // Voice Profiles state
  const [voiceProfiles, setVoiceProfiles] = useState<VoiceProfileItem[]>([]);
  const [pronunciations, setPronunciations] = useState<Pronunciation[]>([]);
  const [savingPronunciations, setSavingPronunciations] = useState(false);
  // dubbed lines that still say a word the way it was said before it was changed here
  const [stale, setStale] = useState<{ lines: number; projects: number } | null>(null);
  const [redubbing, setRedubbing] = useState(false);
  const [listening, setListening] = useState<number | null>(null);
  const checkStale = () => fetchStalePronunciations().then(setStale).catch(() => setStale(null));
  const listen = async (idx: number, word: string) => {
    if (!word.trim() || listening !== null) return;
    setListening(idx);
    try {
      await persistPronunciations(pronunciations);      // heard as it is written now
      const url = await listenToPronunciation(word);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch {
      setRedubNote('The voice could not be played. Check the voice engine and try again.');
    } finally { setListening(null); }
  };
  const redub = async () => {
    setRedubbing(true);
    try {
      const done = await redubStalePronunciations();
      setRedubNote(`${done.lines} line${done.lines === 1 ? '' : 's'} in ${done.projects} video${done.projects === 1 ? '' : 's'} queued for dubbing again.${done.busy ? ` ${done.busy} being dubbed right now were left alone.` : ''}`);
    } catch {
      setRedubNote('Could not queue the lines. Try again.');
    } finally { setRedubbing(false); void checkStale(); }
  };
  const [redubNote, setRedubNote] = useState('');

  useEffect(() => {
    if (!open) return;
    fetchPronunciations()
      .then(setPronunciations)
      .catch(() => setPronunciations([]));
    setRedubNote('');
    void checkStale();
  }, [open]);

  const persistPronunciations = async (next: Pronunciation[]) => {
    setPronunciations(next);
    setSavingPronunciations(true);
    try {
      await savePronunciations(next.filter((p) => p.word.trim() && p.say_as.trim()));
    } catch {
      /* keep the edits on screen; the next save will retry */
    } finally {
      setSavingPronunciations(false);
      void checkStale();
    }
  };
  const [voiceFilter, setVoiceFilter] = useState<
    'all' | 'voxcpm' | 'edge' | 'male' | 'female' | 'child_boy' | 'child_girl' | 'grandpa' | 'grandma' | 'custom'
  >('all');
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [loadingVoiceId, setLoadingVoiceId] = useState<string | null>(null);
  const sampleAudioCache = useRef<Record<string, string>>({});
  const [testingSample, setTestingSample] = useState(false);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [uploadingSample, setUploadingSample] = useState(false);

  // Form state for creating / editing custom profile
  const [profileForm, setProfileForm] = useState<{
    name: string;
    gender: 'female' | 'male' | 'child_boy' | 'child_girl' | 'grandpa' | 'grandma' | 'child' | 'elderly' | string;
    voice_name: string;
    engine: 'edge-tts' | 'voxcpm';
    language: string;
    pitch: number; // numeric in Hz for slider (-15 to 15)
    rate: number; // numeric in % for slider (-30 to 40)
    emotion: string;
    description: string;
    sample_audio_url: string;
    test_text: string;
  }>({
    name: '',
    gender: 'male',
    voice_name: 'km-KH-PisethNeural',
    engine: 'edge-tts',
    language: 'km',
    pitch: 0,
    rate: 0,
    emotion: 'neutral',
    description: '',
    sample_audio_url: '',
    test_text: 'សួស្តីបងប្អូនទាំងអស់គ្នា! នេះជាសំឡេងគំរូសម្រាប់ស្ទូឌីយោរបស់អ្នក។',
  });

  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Theme state
  const [theme, setTheme] = useState<ThemeColors>(loadTheme);

  const loadSettings = async () => {
    try {
      const s = await fetchSettings();
      setSettings(s);
      setSelectedModel(s.gemini_model);
      setTtsEngine(s.tts_engine || 'edge-tts');
    } catch {
      setError('Failed to load settings');
    }
    setLoading(false);
  };

  const loadVoiceProfiles = async () => {
    try {
      const list = await fetchVoiceProfiles();
      setVoiceProfiles(list);
    } catch (e) {
      console.error('Failed to load voice profiles', e);
    }
  };

  useEffect(() => {
    if (open) {
      setLoading(true);
      setError('');
      setSaved(false);
      setNewKey('');
      setNewLabel('');
      setIsEditingProfile(false);
      setTheme(loadTheme());
      loadSettings();
      loadVoiceProfiles();
    } else {
      if (audioPlayerRef.current) {
        audioPlayerRef.current.pause();
        setPlayingVoiceId(null);
      }
    }
  }, [open]);

  // Each choice is saved as it is made — there is no Save button to forget.
  const saveNow = async (updates: { gemini_model?: string; tts_engine?: string; voxcpm_inference_steps?: number; separation_pace?: 'fast' | 'balanced' | 'cool' }) => {
    setSaving(true);
    setError('');
    try {
      setSettings(await updateSettings(updates));
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'That setting could not be saved');
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

  // --- Voice Profile Handlers ---
  const handlePlayVoiceSample = async (profile: VoiceProfileItem) => {
    if (playingVoiceId === profile.id) {
      if (audioPlayerRef.current) {
        audioPlayerRef.current.pause();
      }
      setPlayingVoiceId(null);
      return;
    }

    // Stop previous audio if playing
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
    }

    try {
      const cachedUrl = sampleAudioCache.current[profile.id];
      if (cachedUrl) {
        setPlayingVoiceId(profile.id);
        const audio = new Audio(cachedUrl);
        audioPlayerRef.current = audio;
        audio.onended = () => setPlayingVoiceId(null);
        audio.onerror = () => setPlayingVoiceId(null);
        await audio.play();
        return;
      }

      setLoadingVoiceId(profile.id);

      // Generate real spoken speech sample using profile's voice, pitch, and reference cloned audio!
      const res = await generateVoiceSample({
        voice_name: profile.voice_name,
        voice_profile: profile.gender,
        engine: profile.engine,
        language: profile.language,
        pitch: profile.pitch,
        rate: profile.rate,
        emotion: profile.emotion,
        sample_audio_url: profile.sample_audio_url,
      });

      const audioUrl = res?.audio_url || profile.sample_audio_url;
      if (audioUrl) {
        sampleAudioCache.current[profile.id] = audioUrl;
      }

      setLoadingVoiceId(null);
      setPlayingVoiceId(profile.id);

      const audio = new Audio(audioUrl);
      audioPlayerRef.current = audio;
      audio.onended = () => setPlayingVoiceId(null);
      audio.onerror = () => setPlayingVoiceId(null);
      await audio.play();
    } catch (err: any) {
      console.error('Failed to play sample audio:', err);
      setLoadingVoiceId(null);
      setPlayingVoiceId(null);
    }
  };

  const handleTestFormAudio = async () => {
    setTestingSample(true);
    try {
      const pitchStr = profileForm.pitch >= 0 ? `+${profileForm.pitch}Hz` : `${profileForm.pitch}Hz`;
      const rateStr = profileForm.rate >= 0 ? `+${profileForm.rate}%` : `${profileForm.rate}%`;

      const res = await generateVoiceSample({
        text: profileForm.test_text,
        voice_name: profileForm.voice_name,
        voice_profile: profileForm.gender,
        engine: profileForm.engine,
        language: profileForm.language,
        pitch: pitchStr,
        rate: rateStr,
        emotion: profileForm.emotion,
        sample_audio_url: profileForm.sample_audio_url,
      });

      if (res.audio_url) {
        if (audioPlayerRef.current) {
          audioPlayerRef.current.pause();
        }
        const audio = new Audio(res.audio_url);
        audioPlayerRef.current = audio;
        await audio.play();
      }
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Failed to generate voice preview');
    }
    setTestingSample(false);
  };

  const handleUploadReferenceFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingSample(true);
    try {
      const res = await uploadVoiceSampleAudio(file);
      if (res.audio_url) {
        setProfileForm((prev) => ({
          ...prev,
          sample_audio_url: res.audio_url,
          engine: 'voxcpm',
          voice_name: 'voxcpm-clone',
        }));
      }
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'Failed to upload audio file');
    }
    setUploadingSample(false);
  };

  const handleOpenCreateProfile = () => {
    setEditingProfileId(null);
    setProfileForm({
      name: '',
      gender: 'female',
      voice_name: 'km-KH-SreymomNeural',
      engine: 'edge-tts',
      language: 'km',
      pitch: 0,
      rate: 0,
      emotion: 'neutral',
      description: '',
      sample_audio_url: '',
      test_text: 'សួស្តីបងប្អូនទាំងអស់គ្នា! នេះជាសំឡេងគំរូសម្រាប់ស្ទូឌីយោរបស់អ្នក។',
    });
    setIsEditingProfile(true);
  };

  const handleOpenEditProfile = (profile: VoiceProfileItem) => {
    setEditingProfileId(profile.id);
    const parsedPitch = parseInt(profile.pitch.replace(/[^0-9-]/g, ''), 10) || 0;
    const parsedRate = parseInt(profile.rate.replace(/[^0-9-]/g, ''), 10) || 0;

    setProfileForm({
      name: profile.name,
      gender: profile.gender,
      voice_name: profile.voice_name,
      engine: profile.engine,
      language: profile.language,
      pitch: parsedPitch,
      rate: parsedRate,
      emotion: profile.emotion,
      description: profile.description,
      sample_audio_url: profile.sample_audio_url || '',
      test_text:
        profile.language === 'km'
          ? 'សួស្តីបងប្អូនទាំងអស់គ្នា! នេះជាសំឡេងគំរូសម្រាប់ស្ទូឌីយោរបស់អ្នក។'
          : 'Hello! This is a voice sample preview for your custom studio profile.',
    });
    setIsEditingProfile(true);
  };

  const handleSaveProfileForm = async () => {
    if (!profileForm.name.trim()) {
      setError('Please provide a profile name');
      return;
    }

    try {
      const pitchStr = profileForm.pitch >= 0 ? `+${profileForm.pitch}Hz` : `${profileForm.pitch}Hz`;
      const rateStr = profileForm.rate >= 0 ? `+${profileForm.rate}%` : `${profileForm.rate}%`;

      if (editingProfileId) {
        await updateVoiceProfile(editingProfileId, {
          name: profileForm.name.trim(),
          gender: profileForm.gender,
          voice_name: profileForm.voice_name,
          engine: profileForm.engine,
          language: profileForm.language,
          pitch: pitchStr,
          rate: rateStr,
          emotion: profileForm.emotion,
          description: profileForm.description.trim(),
          sample_audio_url: profileForm.sample_audio_url,
        });
      } else {
        await createVoiceProfile({
          name: profileForm.name.trim(),
          gender: profileForm.gender,
          voice_name: profileForm.voice_name,
          engine: profileForm.engine,
          language: profileForm.language,
          pitch: pitchStr,
          rate: rateStr,
          emotion: profileForm.emotion,
          description: profileForm.description.trim(),
          sample_audio_url: profileForm.sample_audio_url,
        });
      }

      setIsEditingProfile(false);
      await loadVoiceProfiles();
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Failed to save voice profile');
    }
  };

  const handleDeleteProfileItem = async (profileId: string) => {
    if (!confirm('Are you sure you want to delete this custom voice profile?')) return;
    try {
      await deleteVoiceProfile(profileId);
      await loadVoiceProfiles();
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Failed to delete voice profile');
    }
  };

  const handleThemeColor = useCallback((key: keyof ThemeColors, value: string) => {
    setTheme((prev) => {
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

  const activeCount = settings?.api_keys.filter((k) => k.is_active && k.usable !== false).length ?? 0;
  const unusableCount = settings?.api_keys.filter((k) => k.usable === false).length ?? 0;
  const customVoiceCount = voiceProfiles.filter((p) => !p.is_built_in).length;

  const tabs: { id: Tab; label: string; hint: string; icon: React.ReactNode; badge?: string; warn?: boolean }[] = [
    { id: 'general', label: 'General', hint: 'AI model, voice engine, music isolation', icon: <Sliders className="w-4 h-4" /> },
    { id: 'voices', label: 'Voices', hint: 'Built-in voices and your own', icon: <Volume2 className="w-4 h-4" />, badge: `${voiceProfiles.length}` },
    { id: 'pronunciation', label: 'Pronunciation', hint: 'How names and words are said', icon: <Mic className="w-4 h-4" />, badge: pronunciations.length > 0 ? `${pronunciations.length}` : undefined },
    { id: 'apikeys', label: 'API keys', hint: 'Gemini keys for captions and translation', icon: <Key className="w-4 h-4" />, badge: activeCount > 0 ? `${activeCount}` : 'none', warn: activeCount === 0 },
    { id: 'theme', label: 'Appearance', hint: 'Colours', icon: <Palette className="w-4 h-4" /> },
    { id: 'shortcuts', label: 'Shortcuts', hint: 'Keyboard shortcuts', icon: <Keyboard className="w-4 h-4" /> },
    { id: 'about', label: 'About', hint: 'Version and what it is built on', icon: <Info className="w-4 h-4" /> },
  ];

  const themeFields: { key: keyof ThemeColors; label: string; desc: string }[] = [
    { key: 'bgBase', label: 'Workspace Base', desc: 'Main canvas and window background' },
    { key: 'bgPanel', label: 'Panels & Sidebar', desc: 'Toolbars, inspector and dialogs' },
    { key: 'bgHover', label: 'Hover States', desc: 'Buttons, rows and clip selection' },
    { key: 'borderColor', label: 'Borders & Dividers', desc: 'Dividers between timeline tracks' },
    { key: 'borderLight', label: 'Light Accent Borders', desc: 'Cards and focused input rings' },
    { key: 'textBright', label: 'Bright Headers', desc: 'High-contrast text and titles' },
    { key: 'textPrimary', label: 'Body Text', desc: 'Standard readable text' },
    { key: 'textSecondary', label: 'Secondary Labels', desc: 'Descriptions & subtitles' },
    { key: 'textMuted', label: 'Muted Text', desc: 'Timestamps & hints' },
    { key: 'accentPrimary', label: 'Accent Brand', desc: 'Primary highlight color' },
    { key: 'accentText', label: 'Accent Glow', desc: 'Text highlight contrast' },
  ];

  const filteredVoices = voiceProfiles.filter((p) => {
    if (voiceFilter === 'voxcpm') return p.engine === 'voxcpm' || p.voice_name?.toLowerCase().includes('voxcpm');
    if (voiceFilter === 'edge') return p.engine === 'edge-tts' && !p.voice_name?.toLowerCase().includes('voxcpm');
    if (voiceFilter === 'male') return p.gender === 'male';
    if (voiceFilter === 'female') return p.gender === 'female';
    if (voiceFilter === 'child_boy') return p.gender === 'child_boy' || p.gender === 'boy';
    if (voiceFilter === 'child_girl') return p.gender === 'child_girl' || p.gender === 'girl' || p.gender === 'child';
    if (voiceFilter === 'grandpa') return p.gender === 'grandpa' || p.gender === 'elderly_male';
    if (voiceFilter === 'grandma') return p.gender === 'grandma' || p.gender === 'elderly_female' || p.gender === 'elderly';
    if (voiceFilter === 'custom') return !p.is_built_in;
    return true;
  });

  return (
    <div
      className="fixed inset-0 bg-black/80 backdrop-blur-lg flex items-center justify-center z-50 p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-[var(--s2)] border border-[var(--s5)] rounded-3xl w-full max-w-5xl shadow-2xl shadow-black/90 flex flex-col overflow-hidden text-[#e2e4e9]"
        style={{ height: 'min(820px, 92vh)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--s4)] shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-lg">
              <Sliders className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Settings</h2>
              <p className="text-[11px] text-zinc-400">These apply to every project</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-[var(--s5)] rounded-xl text-zinc-400 hover:text-white transition-colors"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs + Content */}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar Tabs */}
          <div role="tablist" aria-label="Settings sections" className="w-48 shrink-0 border-r border-[var(--s4)] p-3 space-y-1">
            {tabs.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => {
                    setActiveTab(tab.id);
                    setError('');
                    setIsEditingProfile(false);
                  }}
                  role="tab"
                  aria-selected={isActive}
                  title={tab.hint}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-xs text-left transition-colors ${
                    isActive ? 'bg-blue-600 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-100 hover:bg-[var(--s4)]'
                  }`}
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <span className="shrink-0">{tab.icon}</span>
                    <span className="truncate">{tab.label}</span>
                  </span>
                  {tab.badge && (
                    <span className={`text-[10px] px-1.5 rounded-full font-mono ${
                      tab.warn ? 'bg-amber-500/20 text-amber-300' : isActive ? 'bg-white/20 text-white' : 'bg-white/10 text-zinc-300'
                    }`}>
                      {tab.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Content Area */}
          <div className="flex-1 flex flex-col overflow-hidden bg-[var(--s2)]">
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {loading ? (
                <div className="flex flex-col items-center justify-center py-16 text-zinc-400 gap-3">
                  <Loader2 className="w-7 h-7 text-blue-500 animate-spin" />
                  <p className="text-xs font-medium">Loading preferences...</p>
                </div>
              ) : (
                <>
                  {/* General Tab */}
                  {activeTab === 'general' && (
                    <div className="space-y-6">
                      {/* Gemini Model Selector */}
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="text-xs font-bold text-white uppercase tracking-wider">AI model</h3>
                            <p className="text-[11px] text-zinc-400 mt-0.5">
                              The Gemini model that writes captions, translates and finds speakers. If it is busy or out of quota, the others are tried.
                            </p>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 gap-2">
                          {settings?.available_models.map((model) => {
                            const isSel = selectedModel === model.id;
                            return (
                              <label
                                key={model.id}
                                className={`flex items-center gap-3 px-3 py-2 rounded-xl border cursor-pointer transition-colors ${
                                  isSel ? 'bg-blue-600/10 border-blue-500/60' : 'bg-[var(--s3)] border-[var(--s5)] hover:border-[var(--s8)]'
                                }`}
                              >
                                <input
                                  type="radio"
                                  name="model"
                                  value={model.id}
                                  checked={isSel}
                                  onChange={() => { setSelectedModel(model.id); void saveNow({ gemini_model: model.id }); }}
                                  className="sr-only"
                                />
                                <div
                                  className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                                    isSel ? 'border-blue-400 bg-blue-500' : 'border-zinc-600'
                                  }`}
                                >
                                  {isSel && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                                </div>
                                <span className="text-xs font-semibold text-white shrink-0">{model.name}</span>
                                <span className="text-[11px] text-zinc-400 truncate">{model.description}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>

                      {/* TTS Engine */}
                      <div className="space-y-2.5 pt-2 border-t border-[var(--s4)]">
                        <div>
                          <h3 className="text-xs font-bold text-white uppercase tracking-wider">Voice engine</h3>
                          <p className="text-[11px] text-zinc-400 mt-0.5">
                            What makes the voices when a line has no voice of its own chosen. Your cloned voices always use VoxCPM.
                          </p>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          {/* Edge TTS */}
                          <label
                            className={`flex flex-col justify-between p-3.5 rounded-xl border cursor-pointer transition-all ${
                              ttsEngine === 'edge-tts'
                                ? 'bg-[var(--s3)] border-blue-500/60 shadow-md shadow-blue-950/30 ring-1 ring-blue-500/30'
                                : 'bg-[var(--s3)] border-[var(--s5)] hover:border-[var(--s8)]'
                            }`}
                          >
                            <div>
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                  <div className="w-6 h-6 rounded-lg bg-blue-600/20 text-blue-400 flex items-center justify-center font-bold text-xs">
                                    <Zap className="w-3.5 h-3.5" />
                                  </div>
                                  <span className="text-xs font-bold text-white">Edge voices</span>
                                </div>
                                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold">
                                  Fast
                                </span>
                              </div>
                              <p className="text-[11px] text-zinc-400 leading-relaxed">
                                Microsoft’s Khmer voices, made online. A line takes about a second. Free.
                              </p>
                            </div>
                            <input
                              type="radio"
                              name="tts_engine"
                              value="edge-tts"
                              checked={ttsEngine === 'edge-tts'}
                              onChange={() => { setTtsEngine('edge-tts'); void saveNow({ tts_engine: 'edge-tts' }); }}
                              className="sr-only"
                            />
                          </label>

                          {/* VoxCPM2 */}
                          <label
                            className={`flex flex-col justify-between p-3.5 rounded-xl border cursor-pointer transition-all ${
                              ttsEngine === 'voxcpm'
                                ? 'bg-blue-600/10 border-blue-500/70 shadow-md ring-1 ring-blue-500/30'
                                : 'bg-[var(--s3)] border-[var(--s5)] hover:border-[var(--s8)]'
                            }`}
                          >
                            <div>
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                  <div className="w-6 h-6 rounded-lg bg-white/10 text-zinc-400 flex items-center justify-center font-bold text-xs">
                                    <Sparkles className="w-3.5 h-3.5" />
                                  </div>
                                  <span className="text-xs font-bold text-white">VoxCPM</span>
                                </div>
                                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/10 text-zinc-400 border border-white/10 font-bold">
                                  On this Mac
                                </span>
                              </div>
                              <p className="text-[11px] text-zinc-400 leading-relaxed">
                                Runs on this computer, so it is slower, and can copy a voice from a sample.
                              </p>
                            </div>
                            <input
                              type="radio"
                              name="tts_engine"
                              value="voxcpm"
                              checked={ttsEngine === 'voxcpm'}
                              onChange={() => { setTtsEngine('voxcpm'); void saveNow({ tts_engine: 'voxcpm' }); }}
                              className="sr-only"
                            />
                          </label>
                        </div>
                      </div>

                      {/* How hard cloned voices work the Mac */}
                      <div className="space-y-2.5">
                        <div>
                          <h3 className="text-xs font-bold text-white uppercase tracking-wider">Cloned voice effort</h3>
                          <p className="text-[11px] text-zinc-400 mt-0.5">
                            Cloned voices (VoxCPM) are made on this Mac, which works it hard. A lighter setting finishes
                            sooner and runs cooler; the voice is a little less polished. The built-in voices are not affected.
                          </p>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {([
                            [10, 'Light', 'Fastest · one retake at most'],
                            [15, 'Balanced', 'About 1.2× the time'],
                            [30, 'Best', 'About 1.6× the time · most polished'],
                          ] as const).map(([steps, label, hint]) => {
                            const current = settings?.voxcpm_inference_steps || 30;
                            // a value set by hand lights the nearest choice
                            const active = steps === ([10, 15, 30] as const).reduce((a, b) => (Math.abs(b - current) < Math.abs(a - current) ? b : a));
                            return (
                              <button
                                key={steps}
                                onClick={() => void saveNow({ voxcpm_inference_steps: steps })}
                                className={`rounded-xl border p-2.5 text-left transition-colors ${
                                  active ? 'border-blue-500 bg-blue-600/15' : 'border-[var(--s5)] bg-[var(--s3)] hover:border-[var(--s7)]'
                                }`}
                              >
                                <span className="block text-xs font-semibold text-white">{label}</span>
                                <span className="block text-[10px] text-zinc-400 mt-0.5">{hint}</span>
                              </button>
                            );
                          })}
                        </div>
                        <p className="text-[10px] text-zinc-500">The voice model's memory (about 7 GB) is released by itself after ten minutes without use.</p>
                      </div>

                      {/* Vocal / BGM isolation pace */}
                      <div className="space-y-2.5">
                        <div>
                          <h3 className="text-xs font-bold text-white uppercase tracking-wider">Music isolation speed</h3>
                          <p className="text-[11px] text-zinc-400 mt-0.5">
                            Isolating the music works the Mac hard and warms it on long videos. The slower settings
                            rest between bursts — the result sounds the same.
                          </p>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {([
                            ['fast', 'Fast', 'Quickest · runs hottest'],
                            ['balanced', 'Balanced', 'About 1.4× the time · cooler'],
                            ['cool', 'Cool & quiet', 'About 2× the time · coolest'],
                          ] as const).map(([id, label, hint]) => {
                            const active = (settings?.separation_pace || 'balanced') === id;
                            return (
                              <button
                                key={id}
                                onClick={() => void saveNow({ separation_pace: id })}
                                className={`rounded-xl border p-2.5 text-left transition-colors ${
                                  active ? 'border-blue-500 bg-blue-600/15' : 'border-[var(--s5)] bg-[var(--s3)] hover:border-[var(--s7)]'
                                }`}
                              >
                                <span className="block text-xs font-semibold text-white">{label}</span>
                                <span className="block text-[10px] text-zinc-400 mt-0.5">{hint}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Voice Profiles Tab */}
                  {activeTab === 'voices' && (
                    <div className="space-y-5">
                      {!isEditingProfile ? (
                        <>
                          {/* Top Header with Add Button */}
                          <div className="flex items-center justify-between pb-2 border-b border-[var(--s4)]">
                            <div>
                              <h3 className="text-xs font-bold text-white uppercase tracking-wider">Voices</h3>
                              <p className="text-[11px] text-zinc-400 mt-0.5">
                                Listen to the built-in voices, and make your own for the characters you dub.
                              </p>
                            </div>
                            <button
                              onClick={handleOpenCreateProfile}
                              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shrink-0 active:scale-95"
                            >
                              <Plus className="w-3.5 h-3.5" />
                              <span className="whitespace-nowrap">New voice</span>
                            </button>
                          </div>

                          {/* Filter Tabs */}
                          <div className="flex flex-wrap items-center gap-1.5">
                            {[
                              { id: 'all', label: `All (${voiceProfiles.length})` },
                              { id: 'custom', label: `Mine (${customVoiceCount})` },
                              { id: 'edge', label: 'Edge' },
                              { id: 'voxcpm', label: 'Cloned' },
                              { id: 'male', label: 'Male' },
                              { id: 'female', label: 'Female' },
                              { id: 'child_boy', label: 'Boy' },
                              { id: 'child_girl', label: 'Girl' },
                              { id: 'grandpa', label: 'Grandpa' },
                              { id: 'grandma', label: 'Grandma' },
                            ].map((f) => (
                              <button
                                key={f.id}
                                onClick={() => setVoiceFilter(f.id as any)}
                                aria-pressed={voiceFilter === f.id}
                                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold whitespace-nowrap transition-colors ${
                                  voiceFilter === f.id ? 'bg-blue-600 text-white' : 'bg-[var(--s3)] text-zinc-400 hover:text-zinc-100'
                                }`}
                              >
                                {f.label}
                              </button>
                            ))}
                          </div>

                          {/* Voice Profiles Grid */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {filteredVoices.map((p) => {
                              const isPlaying = playingVoiceId === p.id;
                              const isLoading = loadingVoiceId === p.id;
                              return (
                                <div
                                  key={p.id}
                                  className={`p-3.5 rounded-2xl border transition-all flex flex-col justify-between ${
                                    isPlaying
                                      ? 'bg-blue-600/10 border-blue-500/70 shadow-lg ring-1 ring-blue-500/30'
                                      : isLoading
                                      ? 'bg-[var(--s3)] border-white/10'
                                      : 'bg-[var(--s3)] border-[var(--s5)] hover:border-[var(--s8)]'
                                  }`}
                                >
                                  <div>
                                    <div className="flex items-start justify-between gap-3 mb-2">
                                      <div className="flex items-center gap-3 min-w-0">
                                        <div
                                          className={`w-10 h-10 rounded-2xl flex items-center justify-center text-lg shrink-0 border ${
                                            p.gender === 'male'
                                              ? 'bg-blue-600/20 text-blue-400 border-blue-500/30'
                                              : p.gender === 'child_boy' || p.gender === 'boy'
                                              ? 'bg-blue-600/20 text-blue-400 border-blue-500/30'
                                              : p.gender === 'child_girl' || p.gender === 'girl' || p.gender === 'child'
                                              ? 'bg-amber-600/20 text-amber-400 border-amber-500/30'
                                              : p.gender === 'grandpa' || p.gender === 'elderly_male'
                                              ? 'bg-emerald-600/20 text-emerald-400 border-emerald-500/30'
                                              : p.gender === 'grandma' || p.gender === 'elderly_female' || p.gender === 'elderly'
                                              ? 'bg-white/10 text-zinc-400 border-white/10'
                                              : 'bg-white/10 text-zinc-400 border-white/10'
                                          }`}
                                        >
                                          {p.gender === 'male'
                                            ? '👨'
                                            : p.gender === 'child_boy' || p.gender === 'boy'
                                            ? '👦'
                                            : p.gender === 'child_girl' || p.gender === 'girl' || p.gender === 'child'
                                            ? '👧'
                                            : p.gender === 'grandpa' || p.gender === 'elderly_male'
                                            ? '👴'
                                            : p.gender === 'grandma' || p.gender === 'elderly_female' || p.gender === 'elderly'
                                            ? '👵'
                                            : '👩'}
                                        </div>
                                        <div className="min-w-0">
                                          <div className="flex items-center gap-1.5 flex-wrap">
                                            <h4 className="text-xs font-bold text-white truncate">{p.name}</h4>
                                            {!p.is_built_in && (
                                              <span className="text-[9px] px-1.5 py-0.2 rounded bg-white/10 text-zinc-200 border border-white/10 font-bold">
                                                Custom
                                              </span>
                                            )}
                                          </div>
                                          <p className="text-[10px] text-zinc-400 font-mono truncate">{p.voice_name}</p>
                                        </div>
                                      </div>

                                      {/* Play Sample Button */}
                                      <button
                                        onClick={() => handlePlayVoiceSample(p)}
                                        disabled={isLoading}
                                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl font-bold text-[11px] transition-all shadow-sm shrink-0 ${
                                          isPlaying
                                            ? 'bg-white/10 text-white animate-pulse'
                                            : isLoading
                                            ? 'bg-white/5 text-zinc-200 border border-white/10'
                                            : 'bg-[var(--s5)] hover:bg-[var(--s6)] text-zinc-200 border border-[var(--s7)]'
                                        }`}
                                        title={isPlaying ? 'Stop Voice Sample' : isLoading ? 'Generating preview...' : 'Play Sample Voice'}
                                      >
                                        {isLoading ? (
                                          <>
                                            <Loader2 className="w-3 h-3 animate-spin text-zinc-400" />
                                            <span>Loading...</span>
                                          </>
                                        ) : isPlaying ? (
                                          <>
                                            <Square className="w-3 h-3 fill-current" />
                                            <span>Playing...</span>
                                          </>
                                        ) : (
                                          <>
                                            <Play className="w-3 h-3 fill-current" />
                                            <span>Sample</span>
                                          </>
                                        )}
                                      </button>
                                    </div>

                                    {/* Description */}
                                    <p className="text-[11px] text-zinc-400 leading-relaxed mb-3 line-clamp-2">
                                      {p.description || 'Natural neural voice tailored for video character dubbing.'}
                                    </p>
                                  </div>

                                  {/* Footer tags and Actions */}
                                  <div className="pt-2 border-t border-[var(--s4)] flex items-center justify-between text-[10px]">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span className={`px-1.5 py-0.5 rounded border font-mono font-bold ${
                                        p.engine === 'voxcpm' || p.voice_name?.includes('voxcpm')
                                          ? 'bg-white/10 text-zinc-200 border-white/10'
                                          : 'bg-blue-500/20 text-blue-300 border-blue-500/30'
                                      }`}>
                                        {p.engine === 'voxcpm' || p.voice_name?.includes('voxcpm') ? '🎙️ VoxCPM2' : '⚡ Edge-TTS'}
                                      </span>
                                      <span className="px-1.5 py-0.5 rounded bg-[var(--s4)] text-zinc-300 border border-[var(--s6)] font-mono uppercase">
                                        {p.language}
                                      </span>
                                      {p.pitch !== '+0Hz' && (
                                        <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 font-mono">
                                          {p.pitch}
                                        </span>
                                      )}
                                      {p.rate !== '+0%' && (
                                        <span className="px-1.5 py-0.5 rounded bg-white/10 text-zinc-200 border border-white/10 font-mono">
                                          {p.rate}
                                        </span>
                                      )}
                                    </div>

                                    {!p.is_built_in && (
                                      <div className="flex items-center gap-1">
                                        <button
                                          onClick={() => handleOpenEditProfile(p)}
                                          className="p-1 text-zinc-400 hover:text-blue-400 hover:bg-[var(--s4)] rounded-lg transition-colors"
                                          title="Edit Custom Profile"
                                        >
                                          <Edit2 className="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                          onClick={() => handleDeleteProfileItem(p.id)}
                                          className="p-1 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                                          title="Delete Custom Profile"
                                        >
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      ) : (
                        /* Profile Create / Edit Form */
                        <div className="space-y-4 animate-in fade-in">
                          <div className="flex items-center justify-between pb-2 border-b border-[var(--s4)]">
                            <div className="flex items-center gap-2">
                              <div className="w-7 h-7 rounded-xl bg-white/10 text-zinc-400 flex items-center justify-center font-bold text-xs">
                                <Volume2 className="w-4 h-4" />
                              </div>
                              <span className="text-xs font-bold text-white uppercase tracking-wider">
                                {editingProfileId ? 'Edit Custom Voice Profile' : 'Create New Voice Profile'}
                              </span>
                            </div>
                          </div>

                          {/* Speech Engine Selection */}
                          <div className="space-y-1.5">
                            <label className="text-[11px] font-bold text-zinc-300">Speech Synthesis Engine *</label>
                            <div className="grid grid-cols-2 gap-2.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setProfileForm({
                                    ...profileForm,
                                    engine: 'edge-tts',
                                    voice_name: 'km-KH-PisethNeural',
                                  });
                                }}
                                className={`p-3 rounded-2xl border flex items-center gap-2.5 text-left transition-all ${
                                  profileForm.engine === 'edge-tts'
                                    ? 'bg-blue-600/20 border-blue-500 text-white ring-1 ring-blue-500/40 shadow-sm'
                                    : 'bg-[var(--s3)] border-[var(--s6)] text-zinc-400 hover:text-white'
                                }`}
                              >
                                <div className="w-8 h-8 rounded-xl bg-blue-600/20 text-blue-400 flex items-center justify-center font-bold text-xs shrink-0">
                                  <Zap className="w-4 h-4" />
                                </div>
                                <div>
                                  <p className="text-xs font-bold text-white">Edge Neural TTS</p>
                                  <p className="text-[10px] text-zinc-400">Fast cloud streaming</p>
                                </div>
                              </button>

                              <button
                                type="button"
                                onClick={() => {
                                  setProfileForm({
                                    ...profileForm,
                                    engine: 'voxcpm',
                                    voice_name: 'voxcpm-piseth',
                                  });
                                }}
                                className={`p-3 rounded-2xl border flex items-center gap-2.5 text-left transition-all ${
                                  profileForm.engine === 'voxcpm'
                                    ? 'bg-blue-600/20 border-blue-500 text-white ring-1 ring-blue-500/40 shadow-sm'
                                    : 'bg-[var(--s3)] border-[var(--s6)] text-zinc-400 hover:text-white'
                                }`}
                              >
                                <div className="w-8 h-8 rounded-xl bg-white/10 text-zinc-400 flex items-center justify-center font-bold text-xs shrink-0">
                                  <Sparkles className="w-4 h-4" />
                                </div>
                                <div>
                                  <p className="text-xs font-bold text-white">VoxCPM2 AI (Cloning)</p>
                                  <p className="text-[10px] text-zinc-400">2B Voice Cloning & Acting</p>
                                </div>
                              </button>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {/* Profile Name */}
                            <div className="space-y-1">
                              <label className="text-[11px] font-bold text-zinc-300">Voice Profile Name *</label>
                              <input
                                type="text"
                                value={profileForm.name}
                                onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })}
                                placeholder="e.g. Heroic Narrator, Soft Storyteller"
                                className="w-full px-3 py-2 bg-[var(--s3)] border border-[var(--s6)] rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500"
                              />
                            </div>

                            {/* Gender / Role */}
                            <div className="space-y-1">
                              <label className="text-[11px] font-bold text-zinc-300">Character Role / Gender</label>
                              <select
                                value={profileForm.gender}
                                onChange={(e) => setProfileForm({ ...profileForm, gender: e.target.value as any })}
                                className="w-full px-3 py-2 bg-[var(--s3)] border border-[var(--s6)] rounded-xl text-xs text-white focus:outline-none focus:border-blue-500"
                              >
                                <option value="male">👨 Male / Man (បុរស)</option>
                                <option value="female">👩 Female / Woman (ស្ត្រី)</option>
                                <option value="child_boy">👦 Child Boy (កុមារា)</option>
                                <option value="child_girl">👧 Child Girl (កុមារី)</option>
                                <option value="grandpa">👴 Grandpa / Lok Ta (លោកតា)</option>
                                <option value="grandma">👵 Grandma / Lok Yeay (លោកយាយ)</option>
                              </select>
                            </div>

                            {/* Base Neural Voice */}
                            <div className="space-y-1">
                              <label className="text-[11px] font-bold text-zinc-300">
                                Base Neural Voice ({profileForm.engine === 'voxcpm' ? 'VoxCPM2 AI' : 'Edge-TTS'})
                              </label>
                              <select
                                value={profileForm.voice_name}
                                onChange={(e) => {
                                  const selected = AVAILABLE_NEURAL_VOICES.find((v) => v.id === e.target.value);
                                  setProfileForm({
                                    ...profileForm,
                                    voice_name: e.target.value,
                                    language: selected?.lang || profileForm.language,
                                    engine: selected?.engine || profileForm.engine,
                                  });
                                }}
                                className="w-full px-3 py-2 bg-[var(--s3)] border border-[var(--s6)] rounded-xl text-xs text-white focus:outline-none focus:border-blue-500"
                              >
                                {(profileForm.engine === 'voxcpm' ? VOXCPM_NEURAL_VOICES : EDGE_NEURAL_VOICES).map((v) => (
                                  <option key={v.id} value={v.id}>
                                    {v.name}
                                  </option>
                                ))}
                              </select>
                            </div>

                            {/* Emotion Preset */}
                            <div className="space-y-1">
                              <label className="text-[11px] font-bold text-zinc-300">Default Acting Tone / Emotion</label>
                              <select
                                value={profileForm.emotion}
                                onChange={(e) => setProfileForm({ ...profileForm, emotion: e.target.value })}
                                className="w-full px-3 py-2 bg-[var(--s3)] border border-[var(--s6)] rounded-xl text-xs text-white focus:outline-none focus:border-blue-500"
                              >
                                <option value="neutral">Neutral / Standard (ធម្មតា)</option>
                                <option value="cheerful">Cheerful / Bright (រីករាយ)</option>
                                <option value="calm">Calm / Gentle (ទន់ភ្លន់)</option>
                                <option value="serious">Serious / Authoritative (ម៉ឺងម៉ាត់)</option>
                                <option value="whisper">Soft Whisper (ខ្សឹប)</option>
                                <option value="excited">Excited / Dramatic (រំភើប)</option>
                                <option value="sad">Melancholy / Sad (កំសត់)</option>
                                <option value="angry">Fierce / Angry (ខឹង)</option>
                              </select>
                            </div>

                            {/* Pitch Slider */}
                            <div className="space-y-1">
                              <div className="flex items-center justify-between">
                                <label className="text-[11px] font-bold text-zinc-300">Pitch Shift Modulation</label>
                                <span className="text-[10px] font-mono font-bold text-blue-400">
                                  {profileForm.pitch >= 0 ? `+${profileForm.pitch}Hz` : `${profileForm.pitch}Hz`}
                                </span>
                              </div>
                              <input
                                type="range"
                                min={-12}
                                max={12}
                                step={1}
                                value={profileForm.pitch}
                                onChange={(e) => setProfileForm({ ...profileForm, pitch: Number(e.target.value) })}
                                className="w-full accent-blue-500"
                              />
                              <div className="flex justify-between text-[9px] text-zinc-500">
                                <span>Deeper (-12Hz)</span>
                                <span>Default</span>
                                <span>Higher (+12Hz)</span>
                              </div>
                            </div>

                            {/* Rate / Speed Slider */}
                            <div className="space-y-1">
                              <div className="flex items-center justify-between">
                                <label className="text-[11px] font-bold text-zinc-300">Speed / Cadence Adjustment</label>
                                <span className="text-[10px] font-mono font-bold text-zinc-400">
                                  {profileForm.rate >= 0 ? `+${profileForm.rate}%` : `${profileForm.rate}%`}
                                </span>
                              </div>
                              <input
                                type="range"
                                min={-20}
                                max={30}
                                step={2}
                                value={profileForm.rate}
                                onChange={(e) => setProfileForm({ ...profileForm, rate: Number(e.target.value) })}
                                className="w-full accent-blue-500"
                              />
                              <div className="flex justify-between text-[9px] text-zinc-500">
                                <span>Slower (-20%)</span>
                                <span>Natural (0%)</span>
                                <span>Faster (+30%)</span>
                              </div>
                            </div>
                          </div>

                          {/* Description */}
                          <div className="space-y-1">
                            <label className="text-[11px] font-bold text-zinc-300">Description & Notes</label>
                            <input
                              type="text"
                              value={profileForm.description}
                              onChange={(e) => setProfileForm({ ...profileForm, description: e.target.value })}
                              placeholder="e.g. Warm documentary narration voice for historical clips"
                              className="w-full px-3 py-2 bg-[var(--s3)] border border-[var(--s6)] rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500"
                            />
                          </div>

                          {/* Test Voice Audition Box */}
                          <div className="p-4 rounded-2xl bg-[var(--s3)] border border-[var(--s6)] space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-bold text-white flex items-center gap-1.5">
                                <Wand2 className="w-3.5 h-3.5 text-zinc-400" />
                                Test & Audition Voice Profile
                              </span>
                              {profileForm.sample_audio_url && (
                                <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-semibold">
                                  <CheckCircle2 className="w-3 h-3" />
                                  Sample Audio Ready
                                </span>
                              )}
                            </div>

                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={profileForm.test_text}
                                onChange={(e) => setProfileForm({ ...profileForm, test_text: e.target.value })}
                                placeholder="Type a test phrase to listen..."
                                className="flex-1 px-3 py-2 bg-[var(--s2)] border border-[var(--s7)] rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500"
                              />
                              <button
                                onClick={handleTestFormAudio}
                                disabled={testingSample}
                                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-bold text-xs shadow-md transition-all shrink-0"
                              >
                                {testingSample ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                                <span>Test Audio</span>
                              </button>
                            </div>

                            {/* Reference File Upload & Studio Link */}
                            <div className="flex items-center justify-between pt-1 text-[11px] text-zinc-400 gap-2 flex-wrap">
                              <div className="flex items-center gap-2">
                                <span>Reference audio (.wav, .mp3):</span>
                                <a
                                  href="http://localhost:7860"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/10 text-zinc-200 border border-white/10 hover:bg-white/10 transition-colors text-[10px] font-semibold"
                                  title="Open VoxCPM2 Voice Cloning Web UI"
                                >
                                  <span>🎙️ VoxCPM Web UI</span>
                                  <ExternalLink className="w-2.5 h-2.5" />
                                </a>
                              </div>

                              <input
                                type="file"
                                ref={fileInputRef}
                                onChange={handleUploadReferenceFile}
                                accept="audio/*"
                                className="hidden"
                              />
                              <button
                                onClick={() => fileInputRef.current?.click()}
                                disabled={uploadingSample}
                                className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-[var(--s5)] hover:bg-[var(--s6)] text-zinc-200 hover:text-white border border-[var(--s8)] transition-colors text-[11px] font-semibold shadow-sm"
                              >
                                {uploadingSample ? <Loader2 className="w-3 h-3 animate-spin" /> : <UploadCloud className="w-3 h-3 text-zinc-400" />}
                                <span>Upload Audio File</span>
                              </button>
                            </div>
                          </div>

                          {/* Action Buttons */}
                          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--s4)]">
                            <button
                              onClick={() => setIsEditingProfile(false)}
                              className="px-4 py-2 text-xs font-semibold text-zinc-300 hover:text-white hover:bg-[var(--s5)] rounded-xl transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={handleSaveProfileForm}
                              className="flex items-center gap-1.5 px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-lg transition-all active:scale-95"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>{editingProfileId ? 'Update Profile' : 'Save Voice Profile'}</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Theme Tab */}
                  {activeTab === 'pronunciation' && (
                    <div className="space-y-4">
                      <div>
                        <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                          <Mic className="w-3.5 h-3.5 text-zinc-400" />
                          Pronunciation
                        </h3>
                        <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed">
                          Teach the voice how to say names and terms it gets wrong. Write how it should sound —
                          usually in Khmer letters. Only the spoken audio changes; your caption text stays exactly as written.
                          Press the speaker to hear a word as the dub will say it.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 px-1">
                          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Written as</span>
                          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Say it as</span>
                          <span className="w-7" />
                          <span className="w-7" />
                        </div>
                        {pronunciations.map((entry, idx) => (
                          <div key={idx} className="grid grid-cols-[1fr_1fr_auto_auto] gap-2">
                            <input
                              value={entry.word}
                              onChange={(e) => {
                                const next = [...pronunciations];
                                next[idx] = { ...entry, word: e.target.value };
                                setPronunciations(next);
                              }}
                              onBlur={() => persistPronunciations(pronunciations)}
                              placeholder="Tang Bohu"
                              className="bg-[var(--s3)] border border-[var(--s6)] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
                            />
                            <input
                              value={entry.say_as}
                              onChange={(e) => {
                                const next = [...pronunciations];
                                next[idx] = { ...entry, say_as: e.target.value };
                                setPronunciations(next);
                              }}
                              onBlur={() => persistPronunciations(pronunciations)}
                              placeholder="តាំង ប៉ូហ៊ូ"
                              className="bg-[var(--s3)] border border-[var(--s6)] rounded-lg px-2.5 py-1.5 text-xs text-white font-khmer focus:outline-none focus:border-blue-500"
                            />
                            <button
                              onClick={() => void listen(idx, entry.word)}
                              disabled={!entry.word.trim() || !entry.say_as.trim() || listening !== null}
                              className="w-7 h-7 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 flex items-center justify-center transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
                              title="Hear it as the dub will say it"
                              aria-label={`Hear ${entry.word}`}
                            >
                              {listening === idx ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Volume2 className="w-3.5 h-3.5" />}
                            </button>
                            <button
                              onClick={() => persistPronunciations(pronunciations.filter((_, i) => i !== idx))}
                              className="w-7 h-7 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-900/30 flex items-center justify-center transition-colors cursor-pointer"
                              title="Remove"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setPronunciations([...pronunciations, { word: '', say_as: '' }])}
                          className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-zinc-200 transition-colors cursor-pointer"
                        >
                          + Add word
                        </button>
                        {savingPronunciations && <span className="text-[11px] text-zinc-500">Saving…</span>}
                        {pronunciations.length === 0 && (
                          <span className="text-[11px] text-zinc-500">No words yet — add one to fix a mispronunciation.</span>
                        )}
                      </div>

                      {!!stale?.lines && (
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
                          <span>{stale.lines} dubbed line{stale.lines === 1 ? '' : 's'} in {stale.projects} video{stale.projects === 1 ? '' : 's'} still say{stale.lines === 1 ? 's' : ''} a word the old way.</span>
                          <button onClick={() => void redub()} disabled={redubbing}
                            className="px-2.5 py-1 rounded-md bg-amber-500/20 hover:bg-amber-500/30 font-semibold text-amber-50 cursor-pointer disabled:opacity-40">
                            {redubbing ? 'Queueing…' : 'Dub those lines again'}
                          </button>
                        </div>
                      )}
                      {redubNote && <p role="status" className="text-[11px] text-zinc-300">{redubNote}</p>}
                    </div>
                  )}

                  {activeTab === 'theme' && (
                    <div className="space-y-6">
                      <div>
                        <h3 className="text-xs font-bold text-white uppercase tracking-wider mb-2">Color Mode</h3>
                        <ThemeModeToggle />
                      </div>

                      <div className="space-y-3 pt-2 border-t border-[var(--s4)]">
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="text-xs font-bold text-white uppercase tracking-wider">Custom UI Palette</h3>
                            <p className="text-[11px] text-zinc-400">Tune individual interface tokens and contrast levels</p>
                          </div>
                          <button
                            onClick={handleResetTheme}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-300 hover:text-white bg-[var(--s3)] hover:bg-[var(--s5)] border border-[var(--s6)] rounded-xl transition-all font-medium"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            Reset Defaults
                          </button>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          {themeFields.map(({ key, label, desc }) => (
                            <div key={key} className="p-2.5 rounded-xl bg-[var(--s3)] border border-[var(--s5)] flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <span className="text-xs font-bold text-white block truncate">{label}</span>
                                <span className="text-[10px] text-zinc-500 block truncate">{desc}</span>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <input
                                  type="color"
                                  value={theme[key]}
                                  onChange={(e) => handleThemeColor(key, e.target.value)}
                                  className="w-7 h-7 rounded-lg border border-[var(--s7)] cursor-pointer bg-transparent p-0"
                                />
                                <span className="text-[10px] font-mono text-zinc-400 uppercase w-14">
                                  {theme[key]}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* API Keys Tab */}
                  {activeTab === 'apikeys' && (
                    <div className="space-y-5">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                            Gemini API Keys
                          </h3>
                          <p className="text-[11px] text-zinc-400">
                            Captions, translation and titles use these. With several keys, the next one takes over when one runs out of its daily quota.
                          </p>
                          {unusableCount > 0 && (
                            <p className="text-[11px] text-amber-300/90 mt-1">
                              {unusableCount} saved {unusableCount === 1 ? 'entry is' : 'entries are'} empty and {unusableCount === 1 ? 'is' : 'are'} never used.
                            </p>
                          )}
                        </div>
                        {activeCount > 0 && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-mono font-bold">
                            {activeCount} Active
                          </span>
                        )}
                      </div>

                      {/* Add New Key */}
                      <div className="p-4 rounded-xl bg-[var(--s3)] border border-[var(--s5)] space-y-3">
                        <span className="text-[11px] font-bold text-white uppercase tracking-wider block">Add a key</span>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={newLabel}
                            onChange={(e) => setNewLabel(e.target.value)}
                            placeholder="Label (e.g. Work, Personal)"
                            className="w-44 px-3 py-2 bg-[var(--s2)] border border-[var(--s6)] rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500"
                          />
                          <div className="flex-1 relative">
                            <input
                              type={showNewKey ? 'text' : 'password'}
                              value={newKey}
                              onChange={(e) => setNewKey(e.target.value)}
                              placeholder="AIzaSy… or AQ.…"
                              className="w-full px-3 py-2 pr-9 bg-[var(--s2)] border border-[var(--s6)] rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500 font-mono"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleAddKey();
                              }}
                            />
                            <button
                              onClick={() => setShowNewKey(!showNewKey)}
                              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                            >
                              {showNewKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                          <button
                            onClick={handleAddKey}
                            disabled={!newKey.trim() || addingKey}
                            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-blue-900/30 flex items-center gap-1.5 shrink-0"
                          >
                            {addingKey ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                            Add Key
                          </button>
                        </div>

                        <div className="flex items-center justify-between text-[11px] text-zinc-500 pt-1">
                          <a
                            href="https://aistudio.google.com/apikey"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors font-medium"
                          >
                            Get a free key from Google AI Studio
                            <ExternalLink className="w-3 h-3" />
                          </a>
                          <span>Keys are kept on this computer</span>
                        </div>
                      </div>

                      {/* Keys List */}
                      {settings?.api_keys && settings.api_keys.length > 0 ? (
                        <div className="space-y-1.5">
                          {settings.api_keys.map((k) => (
                            <div
                              key={k.id}
                              className={`flex items-center justify-between px-3 py-1.5 rounded-xl border transition-all ${
                                k.is_active
                                  ? 'bg-[var(--s3)] border-[var(--s6)]'
                                  : 'bg-[var(--s2)] border-[var(--s4)] opacity-60'
                              }`}
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <div
                                  className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold ${
                                    k.is_active ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-zinc-800 text-zinc-500'
                                  }`}
                                >
                                  <Key className="w-3.5 h-3.5" />
                                </div>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-mono font-semibold text-white">{k.preview}</span>
                                    {k.usable === false && (
                                      <span
                                        className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30"
                                        title="This entry is blank, so it is never used."
                                      >
                                        empty key
                                      </span>
                                    )}
                                    {k.label && (
                                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-[var(--s5)] text-zinc-300 border border-[var(--s7)]">
                                        {k.label}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-1.5">
                                <button
                                  onClick={() => handleToggleKey(k)}
                                  className="p-1.5 hover:bg-[var(--s5)] rounded-lg transition-colors text-zinc-400 hover:text-white"
                                  title={k.is_active ? 'Disable Key' : 'Enable Key'}
                                >
                                  {k.is_active ? (
                                    <ToggleRight className="w-5 h-5 text-emerald-400" />
                                  ) : (
                                    <ToggleLeft className="w-5 h-5 text-zinc-500" />
                                  )}
                                </button>
                                <button
                                  onClick={() => handleDeleteKey(k)}
                                  className="p-1.5 hover:bg-red-500/20 rounded-lg transition-colors text-zinc-500 hover:text-red-400"
                                  title="Delete Key"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs">
                          No working Gemini key yet. Add one above — captions, translation and titles need it.
                        </div>
                      )}

                    </div>
                  )}

                  {/* Shortcuts Tab */}
                  {activeTab === 'shortcuts' && (
                    <div className="space-y-4">
                      <div>
                        <h3 className="text-xs font-bold text-white uppercase tracking-wider mb-1">Timeline & Playback Shortcuts</h3>
                        <p className="text-[11px] text-zinc-400">Streamline editing speed with quick keyboard combinations</p>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { keys: 'Space', action: 'Play / Pause Video' },
                          { keys: '← / →', action: 'Seek ±5 Seconds' },
                          { keys: 'Shift + ← / →', action: 'Frame Step ±1s' },
                          { keys: 'S', action: 'Split Segment at Playhead' },
                          { keys: 'Delete / Backspace', action: 'Delete Selected Segment' },
                          { keys: 'M', action: 'Mute / Unmute Stem Audio' },
                          { keys: 'Ctrl / ⌘ + Wheel', action: 'Smooth Timeline Zoom' },
                          { keys: 'Shift + Wheel', action: 'Horizontal Scroll' },
                          { keys: 'Home / End', action: 'Jump to Start / Finish' },
                          { keys: 'Ctrl / ⌘ + Z', action: 'Undo Action' },
                        ].map((s) => (
                          <div
                            key={s.keys}
                            className="flex items-center justify-between p-2.5 rounded-xl bg-[var(--s3)] border border-[var(--s5)]"
                          >
                            <span className="text-xs text-zinc-300 font-medium">{s.action}</span>
                            <kbd className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-lg bg-[var(--s2)] border border-[var(--s6)] text-zinc-300 shadow-inner">
                              {s.keys}
                            </kbd>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* About Tab */}
                  {activeTab === 'about' && (
                    <div className="space-y-6">
                      <div className="text-center p-6 rounded-2xl bg-gradient-to-b from-[var(--s3)] to-[var(--s2)] border border-[var(--s6)] shadow-lg">
                        <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-gradient-to-br from-blue-500 flex items-center justify-center text-white shadow-lg">
                          <Layers className="w-7 h-7" />
                        </div>
                        <h3 className="text-base font-bold text-white">Dubbing Studio</h3>
                        <p className="text-xs text-blue-400 font-semibold mt-0.5">Khmer AI video dubbing & captions</p>
                        <p className="text-[10px] text-zinc-500 mt-1 font-mono">v2.4.0 (Build 2026.08)</p>
                      </div>

                      <AppUpdate />

                      <div className="grid grid-cols-2 gap-2.5 text-xs">
                        <div className="p-3 rounded-xl bg-[var(--s3)] border border-[var(--s5)] flex items-center justify-between">
                          <span className="text-zinc-400">Music isolation</span>
                          <span className="text-white font-semibold">Demucs</span>
                        </div>
                        <div className="p-3 rounded-xl bg-[var(--s3)] border border-[var(--s5)] flex items-center justify-between">
                          <span className="text-zinc-400">Voices</span>
                          <span className="text-white font-semibold">Edge + VoxCPM</span>
                        </div>
                        <div className="p-3 rounded-xl bg-[var(--s3)] border border-[var(--s5)] flex items-center justify-between">
                          <span className="text-zinc-400">Captions & translation</span>
                          <span className="text-white font-semibold">{settings?.available_models.find((m) => m.id === settings.gemini_model)?.name || 'Google Gemini'}</span>
                        </div>
                        <div className="p-3 rounded-xl bg-[var(--s3)] border border-[var(--s5)] flex items-center justify-between">
                          <span className="text-zinc-400">Built on</span>
                          <span className="text-white font-semibold">FFmpeg + FastAPI + React</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Error display */}
                  {error && (
                    <div className="flex items-center gap-2.5 p-3 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs animate-in fade-in">
                      <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                      <span>{error}</span>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--s4)] shrink-0">
              <span role="status" className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                {saving ? (
                  <><Loader2 className="w-3 h-3 animate-spin" /> Saving…</>
                ) : saved ? (
                  <><Check className="w-3 h-3 text-emerald-400" /> <span className="text-emerald-300">Saved</span></>
                ) : (
                  'Changes are saved as you make them'
                )}
              </span>
              <button
                onClick={onClose}
                className="px-4 py-2 text-xs font-semibold text-zinc-200 bg-white/5 hover:bg-white/10 rounded-xl transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
