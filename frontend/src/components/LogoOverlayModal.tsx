import { useState, useRef, RefObject } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { uploadProjectLogo, applyVideoLogo } from '../api/client';
import {
  X,
  Loader2,
  Check,
  Upload,
  AlertCircle,
  Image as ImageIcon,
  Sparkles,
  RefreshCw,
} from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  videoRef: RefObject<HTMLVideoElement | null>;
}

export default function LogoOverlayModal({ open, onClose, videoRef }: Props) {
  const { currentProject, loadProject } = useProjectStore();
  const [logoUrl, setLogoUrl] = useState('');
  const [logoPosition, setLogoPosition] = useState('top_right');
  const [logoScalePct, setLogoScalePct] = useState(15);
  const [logoOpacity, setLogoOpacity] = useState(1.0);
  const [logoXPct, setLogoXPct] = useState(85);
  const [logoYPct, setLogoYPct] = useState(5);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const logoInputRef = useRef<HTMLInputElement>(null);

  const hasVideo = !!currentProject?.video_path;

  const handleUploadLogo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProject) return;
    setUploadingLogo(true);
    setError('');
    try {
      const res = await uploadProjectLogo(currentProject.id, file);
      setLogoUrl(res.url);
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || 'Failed to upload logo image');
    }
    setUploadingLogo(false);
  };

  const handleApplyLogo = async () => {
    if (!currentProject) return;
    if (!logoUrl) {
      setError('Please upload a logo or image watermark first');
      return;
    }
    setProcessing(true);
    setError('');
    try {
      await applyVideoLogo(currentProject.id, {
        logo_url: logoUrl,
        position: logoPosition,
        scale_pct: logoScalePct,
        opacity: logoOpacity,
        x_pct: logoPosition === 'custom' ? logoXPct : undefined,
        y_pct: logoPosition === 'custom' ? logoYPct : undefined,
      });
      await loadProject(currentProject.id);
      if (videoRef.current) videoRef.current.load();
      setDone(true);
      setTimeout(() => {
        setDone(false);
        onClose();
      }, 1500);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Failed to burn logo overlay');
    }
    setProcessing(false);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-[#14161d] border border-[#262933] rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#20232c] shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <ImageIcon className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white tracking-wide">Add Logo & Image Watermark</h2>
              <p className="text-[11px] text-zinc-400">Overlay brand logo, sticker, or watermark permanently onto your video</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4 overflow-y-auto max-h-[75vh]">
          {!hasVideo ? (
            <div className="py-8 text-center text-zinc-500 text-xs">
              No video uploaded in this project yet.
            </div>
          ) : (
            <>
              {/* Notice */}
              <div className="flex items-center gap-2 px-3 py-2 bg-indigo-950/30 border border-indigo-500/20 rounded-xl">
                <Sparkles className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <p className="text-[11px] text-indigo-200">
                  This will burn the watermark into your project video. The video player updates automatically.
                </p>
              </div>

              {/* Upload Image Section */}
              <div className="border border-dashed border-[#2d3240] hover:border-indigo-500/60 bg-[#181a22] rounded-xl p-3.5 transition-colors">
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="hidden"
                  onChange={handleUploadLogo}
                />

                {logoUrl ? (
                  <div className="flex items-center justify-between gap-3 bg-black/30 p-2 rounded-lg border border-white/5">
                    <div className="flex items-center gap-3">
                      <div className="w-11 h-11 rounded-lg bg-black/60 border border-white/10 flex items-center justify-center overflow-hidden p-1">
                        <img src={logoUrl} alt="Logo" className="max-w-full max-h-full object-contain" />
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-white">Logo Ready</p>
                        <p className="text-[10px] text-zinc-400 truncate max-w-[180px] font-mono">{logoUrl.split('/').pop()}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => logoInputRef.current?.click()}
                      disabled={uploadingLogo}
                      className="px-3 py-1.5 bg-[#222530] hover:bg-[#2d3140] text-zinc-200 hover:text-white rounded-lg text-xs font-medium transition-colors cursor-pointer border border-white/5"
                    >
                      Change Image
                    </button>
                  </div>
                ) : (
                  <div
                    onClick={() => logoInputRef.current?.click()}
                    className="flex flex-col items-center justify-center py-5 cursor-pointer text-center group"
                  >
                    <div className="w-10 h-10 rounded-full bg-indigo-500/10 group-hover:bg-indigo-500/20 flex items-center justify-center text-indigo-400 mb-2 transition-colors">
                      {uploadingLogo ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
                    </div>
                    <p className="text-xs font-semibold text-zinc-200 group-hover:text-white">
                      {uploadingLogo ? 'Uploading logo...' : 'Click to Upload Logo / Image'}
                    </p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">Supports transparent PNG, JPG, SVG, WebP</p>
                  </div>
                )}
              </div>

              {/* Position Presets */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wider block">Position on Screen</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {[
                    { id: 'top_left', label: 'Top-Left ↖' },
                    { id: 'top_right', label: 'Top-Right ↗' },
                    { id: 'bottom_left', label: 'Bottom-Left ↙' },
                    { id: 'bottom_right', label: 'Bottom-Right ↘' },
                    { id: 'center', label: 'Center 🎯' },
                    { id: 'custom', label: 'Custom XY 🎛️' },
                  ].map((pos) => (
                    <button
                      key={pos.id}
                      type="button"
                      onClick={() => setLogoPosition(pos.id)}
                      className={`px-2.5 py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                        logoPosition === pos.id
                          ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30 ring-1 ring-indigo-400'
                          : 'bg-[#181a22] text-zinc-400 hover:text-white hover:bg-[#20232d] border border-[#242732]'
                      }`}
                    >
                      {pos.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Custom Coordinates Slider */}
              {logoPosition === 'custom' && (
                <div className="grid grid-cols-2 gap-3 bg-[#181a22] p-3 rounded-xl border border-[#262933]">
                  <div>
                    <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                      <span>Horizontal X</span>
                      <span className="font-mono text-indigo-400 font-bold">{logoXPct}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={logoXPct}
                      onChange={(e) => setLogoXPct(Number(e.target.value))}
                      className="w-full h-1.5 bg-zinc-800 accent-indigo-500 rounded-lg cursor-pointer"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                      <span>Vertical Y</span>
                      <span className="font-mono text-indigo-400 font-bold">{logoYPct}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={logoYPct}
                      onChange={(e) => setLogoYPct(Number(e.target.value))}
                      className="w-full h-1.5 bg-zinc-800 accent-indigo-500 rounded-lg cursor-pointer"
                    />
                  </div>
                </div>
              )}

              {/* Scale & Opacity */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-[#181a22] p-3 rounded-xl border border-[#242732] space-y-1.5">
                  <div className="flex justify-between text-xs text-zinc-300 font-medium">
                    <span>Logo Size</span>
                    <span className="font-mono text-indigo-400 font-bold">{logoScalePct}% width</span>
                  </div>
                  <input
                    type="range"
                    min={5}
                    max={50}
                    value={logoScalePct}
                    onChange={(e) => setLogoScalePct(Number(e.target.value))}
                    className="w-full h-1.5 bg-zinc-800 accent-indigo-500 rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                    <span>5% (Small)</span>
                    <span>50% (Large)</span>
                  </div>
                </div>

                <div className="bg-[#181a22] p-3 rounded-xl border border-[#242732] space-y-1.5">
                  <div className="flex justify-between text-xs text-zinc-300 font-medium">
                    <span>Opacity</span>
                    <span className="font-mono text-indigo-400 font-bold">{Math.round(logoOpacity * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0.1}
                    max={1.0}
                    step={0.05}
                    value={logoOpacity}
                    onChange={(e) => setLogoOpacity(Number(e.target.value))}
                    className="w-full h-1.5 bg-zinc-800 accent-indigo-500 rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                    <span>10% (Faint)</span>
                    <span>100% (Solid)</span>
                  </div>
                </div>
              </div>

              {/* Interactive Visual Preview Box */}
              {logoUrl && (
                <div className="border border-[#262933] rounded-xl p-2.5 bg-black/40 space-y-1.5">
                  <span className="text-[10px] text-zinc-400 uppercase tracking-wider font-semibold block">Live Placement Preview:</span>
                  <div className="relative aspect-video w-full bg-[#101217] rounded-lg overflow-hidden border border-white/5 flex items-center justify-center">
                    <span className="text-[11px] text-zinc-600 select-none font-mono">Video Canvas</span>
                    <div
                      className="absolute pointer-events-none transition-all duration-150"
                      style={{
                        width: `${logoScalePct}%`,
                        opacity: logoOpacity,
                        ...(logoPosition === 'top_left' ? { top: '6%', left: '4%' } :
                            logoPosition === 'top_right' ? { top: '6%', right: '4%' } :
                            logoPosition === 'bottom_left' ? { bottom: '8%', left: '4%' } :
                            logoPosition === 'bottom_right' ? { bottom: '8%', right: '4%' } :
                            logoPosition === 'center' ? { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' } :
                            { top: `${logoYPct}%`, left: `${logoXPct}%`, transform: 'translate(-50%, -50%)' })
                      }}
                    >
                      <img src={logoUrl} alt="Watermark" className="w-full h-auto object-contain drop-shadow-md" />
                    </div>
                  </div>
                </div>
              )}

              {/* Error Message */}
              {error && (
                <div className="flex items-center gap-2 p-3 bg-red-950/40 border border-red-800/40 rounded-xl text-xs text-red-300">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  <p className="leading-tight">{error}</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {hasVideo && (
          <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-[#20232c] bg-[#101216] shrink-0">
            <button
              type="button"
              onClick={onClose}
              disabled={processing}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApplyLogo}
              disabled={processing || !logoUrl}
              className="px-5 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white disabled:opacity-40 flex items-center gap-2 shadow-lg shadow-indigo-950/50 active:scale-95 transition-all cursor-pointer"
            >
              {processing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Burning Logo...</span>
                </>
              ) : done ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-300" />
                  <span>Logo Applied!</span>
                </>
              ) : (
                <>
                  <ImageIcon className="w-3.5 h-3.5" />
                  <span>Burn Logo to Video</span>
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
