import { useState, useRef, useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { generateBGM, updateBGMSettings, removeBGM } from '../api/client';
import {
  Music,
  Loader2,
  Play,
  Pause,
  Trash2,
  Volume2,
  VolumeX,
  Sparkles,
  RefreshCw,
} from 'lucide-react';

const MOODS = [
  { id: 'calm', label: '🧘 Calm', desc: 'Soft, relaxing ambient' },
  { id: 'happy', label: '😊 Happy', desc: 'Upbeat, cheerful vibes' },
  { id: 'energetic', label: '⚡ Energetic', desc: 'Fast, driving beats' },
  { id: 'dramatic', label: '🎭 Dramatic', desc: 'Cinematic, intense' },
  { id: 'sad', label: '😢 Sad', desc: 'Melancholic, emotional' },
  { id: 'mysterious', label: '🔮 Mysterious', desc: 'Dark, suspenseful' },
];

export default function BGMPanel() {
  const { currentProject, loadProject } = useProjectStore();
  const [mood, setMood] = useState('calm');
  const [customPrompt, setCustomPrompt] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(currentProject?.bgm_volume ?? 0.3);
  const audioRef = useRef<HTMLAudioElement>(null);

  const bgmUrl = currentProject?.bgm_url;

  // Sync volume to audio element
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  useEffect(() => {
    if (currentProject?.bgm_volume !== undefined) {
      setVolume(currentProject.bgm_volume);
    }
  }, [currentProject?.bgm_volume]);

  const handleGenerate = async () => {
    if (!currentProject) return;
    setIsGenerating(true);
    setError(null);
    try {
      const result = await generateBGM(
        currentProject.id,
        useCustom ? customPrompt : undefined,
        useCustom ? undefined : mood,
      );
      await loadProject(currentProject.id);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e.message || 'Failed to generate BGM');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRemove = async () => {
    if (!currentProject) return;
    if (!confirm('Remove background music?')) return;
    try {
      await removeBGM(currentProject.id);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }
      setIsPlaying(false);
      // Immediately clear bgm_url in the store so UI updates right away
      useProjectStore.setState({
        currentProject: { ...currentProject, bgm_url: '' },
      });
      await loadProject(currentProject.id);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Failed to remove BGM');
    }
  };

  const handleVolumeChange = async (newVol: number) => {
    setVolume(newVol);
    if (audioRef.current) {
      audioRef.current.volume = newVol;
    }
    // Update store immediately so the main player picks up volume changes
    if (currentProject) {
      useProjectStore.setState({
        currentProject: { ...currentProject, bgm_volume: newVol },
      });
    }
  };

  // Debounced save to backend
  const volumeSaveTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveVolumeToBackend = (newVol: number) => {
    clearTimeout(volumeSaveTimeout.current);
    volumeSaveTimeout.current = setTimeout(async () => {
      if (currentProject) {
        try {
          await updateBGMSettings(currentProject.id, undefined, newVol);
        } catch { /* silent */ }
      }
    }, 500);
  };

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio || !bgmUrl) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.src = bgmUrl;
      audio.volume = volume;
      audio.play().catch(() => {});
      setIsPlaying(true);
    }
  };

  return (
    <div className="p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
          <Music className="w-3.5 h-3.5 text-white" />
        </div>
        <div>
          <h3 className="text-xs font-bold" style={{ color: 'var(--text-bright)' }}>Background Music</h3>
          <p className="text-[10px] text-zinc-500">AI-generated BGM to fit your video</p>
        </div>
      </div>

      {/* Current BGM Player */}
      {bgmUrl && (
        <div className="rounded-lg p-2.5 space-y-2" style={{ backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={togglePlayback}
                className="w-7 h-7 rounded-full bg-emerald-600 hover:bg-emerald-500 flex items-center justify-center transition-colors"
              >
                {isPlaying ? (
                  <Pause className="w-3.5 h-3.5 text-white" />
                ) : (
                  <Play className="w-3.5 h-3.5 text-white ml-0.5" />
                )}
              </button>
              <div>
                <p className="text-[11px] font-medium" style={{ color: 'var(--text-bright)' }}>BGM Track</p>
                <p className="text-[10px] text-zinc-500">AI Generated</p>
              </div>
            </div>
            <button
              onClick={handleRemove}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-900/20 transition-colors"
              title="Remove BGM"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Volume Control */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const v = volume > 0 ? 0 : 0.3;
                handleVolumeChange(v);
                saveVolumeToBackend(v);
              }}
              className="text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              {volume === 0 ? (
                <VolumeX className="w-3.5 h-3.5" />
              ) : (
                <Volume2 className="w-3.5 h-3.5" />
              )}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={volume}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                handleVolumeChange(v);
                saveVolumeToBackend(v);
              }}
              className="flex-1 h-1 rounded-lg appearance-none cursor-pointer"
              style={{
                background: `linear-gradient(to right, #10b981 0%, #10b981 ${volume * 100}%, var(--bg-base) ${volume * 100}%, var(--bg-base) 100%)`,
              }}
            />
            <span className="text-[10px] text-zinc-500 w-8 text-right">{Math.round(volume * 100)}%</span>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg px-3 py-2">
          <p className="text-[11px] text-red-300">{error}</p>
        </div>
      )}

      {/* Mode Toggle */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setUseCustom(false)}
          className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors ${
            !useCustom
              ? 'bg-emerald-600/30 text-emerald-300 border border-emerald-500/40'
              : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
          }`}
        >
          <Sparkles className="w-3 h-3 inline mr-1" />
          AI Auto
        </button>
        <button
          onClick={() => setUseCustom(true)}
          className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors ${
            useCustom
              ? 'bg-emerald-600/30 text-emerald-300 border border-emerald-500/40'
              : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
          }`}
        >
          ✏️ Custom Prompt
        </button>
      </div>

      {/* Mood Grid or Custom Prompt */}
      {useCustom ? (
        <div>
          <label className="text-[10px] text-zinc-400 mb-1 block">Describe the music you want:</label>
          <textarea
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder="e.g. upbeat lo-fi hip hop with soft piano, gentle drums, warm cozy atmosphere..."
            className="w-full rounded-lg px-2.5 py-2 text-[11px] resize-none h-20"
            style={{
              backgroundColor: 'var(--bg-base)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-color)',
            }}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          {MOODS.map((m) => (
            <button
              key={m.id}
              onClick={() => setMood(m.id)}
              className={`p-2 rounded-lg text-left transition-all ${
                mood === m.id
                  ? 'bg-emerald-600/20 border-emerald-500/50 ring-1 ring-emerald-500/30'
                  : 'hover:bg-zinc-800/50 border-transparent'
              }`}
              style={{ border: mood === m.id ? undefined : '1px solid var(--border-color)' }}
            >
              <p className="text-[11px] font-medium" style={{ color: 'var(--text-bright)' }}>{m.label}</p>
              <p className="text-[9px] text-zinc-500">{m.desc}</p>
            </button>
          ))}
        </div>
      )}

      {/* Generate Button */}
      <button
        onClick={handleGenerate}
        disabled={isGenerating || (useCustom && !customPrompt.trim())}
        className="w-full py-2 px-3 rounded-lg text-[11px] font-bold text-white transition-all flex items-center justify-center gap-2 disabled:opacity-50"
        style={{
          background: isGenerating
            ? 'linear-gradient(135deg, #065f46, #064e3b)'
            : 'linear-gradient(135deg, #059669, #0d9488)',
        }}
      >
        {isGenerating ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Generating BGM...
          </>
        ) : bgmUrl ? (
          <>
            <RefreshCw className="w-3.5 h-3.5" />
            Regenerate BGM
          </>
        ) : (
          <>
            <Music className="w-3.5 h-3.5" />
            Generate Background Music
          </>
        )}
      </button>

      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        onEnded={() => setIsPlaying(false)}
        onPause={() => setIsPlaying(false)}
        style={{ display: 'none' }}
      />
    </div>
  );
}
