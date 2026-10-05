import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, Eraser, ImagePlus, Languages, Loader2, Sparkles, Trash2 } from 'lucide-react';
import { deletePoster, fetchPoster, paintPosterTitle, readPosterTitle, removePosterTitle, uploadPoster, type PosterEngine, type PosterState } from '../api/client';

export interface ThumbnailText {
  angle: string;
  label: string;
  /** The punch: one to three words, drawn huge */
  main: string;
  /** A smaller second line that gives it meaning; may be empty */
  sub: string;
  /** The word inside the big line that is drawn in the second colour */
  highlight?: string;
}

/** 'poster' keeps the uploaded poster's own size, so nothing of it is cropped */
type Shape = '16:9' | '9:16' | 'poster';
const PLACES: [string, number][] = [['top', 0], ['middle', 0.5], ['bottom', 1]];

const SIZES: Record<'16:9' | '9:16', [number, number]> = { '16:9': [1280, 720], '9:16': [1080, 1920] };

interface Look {
  id: string;
  name: string;
  mainFill: string;
  mainStroke: string;
  /** Colour of a box drawn behind the main line; '' for none */
  box: string;
  subFill: string;
  /** Colour of the highlighted word */
  accent: string;
}
const LOOKS: Look[] = [
  { id: 'impact', name: 'Yellow impact', mainFill: '#FFE600', mainStroke: '#000000', box: '', subFill: '#FFFFFF', accent: '#FFFFFF' },
  { id: 'clean', name: 'White on dark', mainFill: '#FFFFFF', mainStroke: '#000000', box: '', subFill: '#FFE600', accent: '#FF3B30' },
  { id: 'red', name: 'Red bar', mainFill: '#FFFFFF', mainStroke: '', box: '#E11D48', subFill: '#FFFFFF', accent: '#FFE600' },
  { id: 'yellow', name: 'Black on yellow', mainFill: '#111111', mainStroke: '', box: '#FFE600', subFill: '#FFFFFF', accent: '#E11D48' },
];
const FONTS: [string, string][] = [
  ["'Kantumruy Pro'", 'Kantumruy'],
  ["'Koulen'", 'Koulen'],
  ["'Moul'", 'Moul'],
  ["'Battambang'", 'Battambang'],
];

const clock = (t: number) => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`;

/** Break text over at most two lines at a space, as evenly as it goes. */
function twoLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (ctx.measureText(text).width <= maxWidth || !text.includes(' ')) return [text];
  const words = text.split(' ');
  let best = [text];
  let bestWidth = Infinity;
  for (let i = 1; i < words.length; i++) {
    const lines = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width));
    if (width < bestWidth) { best = lines; bestWidth = width; }
  }
  return best;
}

/**
 * Thumbnail text on its own is hard to judge: whether it works depends on how it reads over
 * the picture, at thumbnail size. This shows each option on a frame from the video and saves
 * the result as an image.
 */
export default function ThumbnailMaker({ projectId, videoSrc, options, onChange, fileName, title }: {
  projectId: string;
  videoSrc: string;
  options: ThumbnailText[];
  /** Called with the edited list, so changes are kept with the project */
  onChange: (options: ThumbnailText[]) => void;
  fileName: string;
  /** The title chosen for the video, offered as the words for a poster */
  title?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [picked, setPicked] = useState(0);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [shape, setShape] = useState<Shape>('16:9');
  const [look, setLook] = useState(LOOKS[0]);
  const [font, setFont] = useState(FONTS[0][0]);
  /** How far down the words sit: 0 at the top, 1 at the bottom */
  const [at, setAt] = useState(1);
  const [shade, setShade] = useState(true);
  // the film's own poster as the picture, in place of a frame
  const [poster, setPoster] = useState<PosterState>({ original_url: null, clean_url: null });
  const [onPoster, setOnPoster] = useState(false);
  /** Which version of the poster is shown: the AI's lettered one, the title-free one, or as uploaded */
  const [view, setView] = useState<'titled' | 'clean' | 'original'>('clean');
  const [busy, setBusy] = useState<'' | 'upload' | 'erase' | 'paint' | 'read'>('');
  const [engine, setEngine] = useState<PosterEngine>('auto');
  const posterImage = useRef<HTMLImageElement | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const posterUrl = (view === 'titled' && poster.titled_url) || (view !== 'original' && poster.clean_url) || poster.original_url;
  const usingPoster = onPoster && !!posterUrl;
  /** The title is already lettered into the picture, so none is drawn over it */
  const painted = usingPoster && view === 'titled' && !!poster.titled_url;
  const [scale, setScale] = useState(1);
  const [frameReady, setFrameReady] = useState(0);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const option = options[Math.min(picked, options.length - 1)];

  const draw = useCallback(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx || !option) return;
    const art = usingPoster ? posterImage.current : null;
    const [w, h] = shape === 'poster' ? (art ? [art.naturalWidth, art.naturalHeight] : SIZES['9:16']) : SIZES[shape];
    el.width = w;
    el.height = h;

    // the frame, scaled to cover the thumbnail and centred
    ctx.fillStyle = '#0b0b0f';
    ctx.fillRect(0, 0, w, h);
    const v = video.current;
    if (art) {
      const k = Math.max(w / art.naturalWidth, h / art.naturalHeight);
      ctx.drawImage(art, (w - art.naturalWidth * k) / 2, (h - art.naturalHeight * k) / 2, art.naturalWidth * k, art.naturalHeight * k);
    } else if (v && v.videoWidth) {
      const k = Math.max(w / v.videoWidth, h / v.videoHeight);
      const dw = v.videoWidth * k;
      const dh = v.videoHeight * k;
      try { ctx.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh); } catch { /* frame not decodable yet */ }
    }

    if (painted) return;

    const unit = Math.min(w, h * 1.4);
    const maxWidth = w * 0.9;
    let mainSize = unit * 0.19 * scale;
    const family = `${font}, 'Kantumruy Pro', sans-serif`;
    let lines: string[] = [];
    // shrink until the widest line fits: a thumbnail must never crop its own words
    for (let i = 0; i < 40; i++) {
      ctx.font = `900 ${mainSize}px ${family}`;
      lines = twoLines(ctx, option.main, maxWidth);
      if (Math.max(...lines.map((l) => ctx.measureText(l).width)) <= maxWidth) break;
      mainSize *= 0.94;
    }
    const lineHeight = mainSize * 1.22;
    const subSize = mainSize * 0.4;
    const block = lines.length * lineHeight + (option.sub ? subSize * 1.7 : 0);
    const margin = h * 0.07;
    const top = margin + Math.max(0, h - 2 * margin - block) * at;

    // darken the picture behind the words so they read on any frame
    if (shade) {
      const band = ctx.createLinearGradient(0, Math.max(0, top - h * 0.12), 0, Math.min(h, top + block + h * 0.12));
      band.addColorStop(0, 'rgba(0,0,0,0)');
      band.addColorStop(0.3, 'rgba(0,0,0,0.55)');
      band.addColorStop(0.7, 'rgba(0,0,0,0.55)');
      band.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = band;
      ctx.fillRect(0, Math.max(0, top - h * 0.12), w, block + h * 0.24);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    lines.forEach((line, i) => {
      const y = top + lineHeight * (i + 0.5);
      ctx.font = `900 ${mainSize}px ${family}`;
      if (look.box) {
        const width = ctx.measureText(line).width + mainSize * 0.5;
        ctx.fillStyle = look.box;
        ctx.beginPath();
        ctx.roundRect((w - width) / 2, y - lineHeight * 0.46, width, lineHeight * 0.92, mainSize * 0.12);
        ctx.fill();
      }
      // the line is drawn in pieces so the highlighted word can take the second colour
      const mark = option.highlight && option.highlight !== option.main ? line.indexOf(option.highlight) : -1;
      const pieces: [string, string][] = mark < 0 || !option.highlight
        ? [[line, look.mainFill]]
        : [
            [line.slice(0, mark), look.mainFill],
            [option.highlight, look.accent],
            [line.slice(mark + option.highlight.length), look.mainFill],
          ];
      // each piece is placed by where the whole line puts it, so Khmer shaping is not shifted
      const left = (w - ctx.measureText(line).width) / 2;
      ctx.textAlign = 'left';
      if (look.mainStroke) {
        ctx.strokeStyle = look.mainStroke;
        ctx.lineWidth = mainSize * 0.16;
        ctx.strokeText(line, left, y);
      }
      let before = '';
      for (const [text, colour] of pieces) {
        if (text) {
          ctx.fillStyle = colour;
          ctx.fillText(text, left + ctx.measureText(before).width, y);
        }
        before += text;
      }
      ctx.textAlign = 'center';
    });
    if (option.sub) {
      let size = subSize;
      ctx.font = `700 ${size}px ${family}`;
      while (ctx.measureText(option.sub).width > maxWidth && size > 12) { size *= 0.94; ctx.font = `700 ${size}px ${family}`; }
      const y = top + lines.length * lineHeight + subSize * 0.95;
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = size * 0.22;
      ctx.strokeText(option.sub, w / 2, y);
      ctx.fillStyle = look.subFill;
      ctx.fillText(option.sub, w / 2, y);
    }
  }, [option, shape, look, font, at, shade, scale, usingPoster, painted]);

  // redraw on any change, and once the font it needs has actually loaded
  useEffect(() => {
    draw();
    let active = true;
    document.fonts?.load(`900 64px ${font}`, option?.main || 'ក').then(() => active && draw()).catch(() => {});
    return () => { active = false; };
  }, [draw, frameReady, font, option?.main]);

  useEffect(() => {
    const v = video.current;
    if (v && Number.isFinite(time) && Math.abs(v.currentTime - time) > 0.05) v.currentTime = time;
  }, [time]);

  useEffect(() => {
    let active = true;
    fetchPoster(projectId).then((state) => active && setPoster(state)).catch(() => {});
    return () => { active = false; };
  }, [projectId]);

  // load whichever version of the poster is being shown, then draw on it
  useEffect(() => {
    posterImage.current = null;
    if (!posterUrl) { setFrameReady((n) => n + 1); return; }
    const image = new Image();
    image.onload = () => { posterImage.current = image; setFrameReady((n) => n + 1); };
    image.onerror = () => setError('The poster could not be loaded.');
    image.src = posterUrl;
    return () => { image.onload = null; image.onerror = null; };
  }, [posterUrl]);

  const failure = (err: any, fallback: string) => {
    const detail = err?.response?.data?.detail;
    setError((typeof detail === 'string' && detail) || err?.message || fallback);
  };
  const choosePoster = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setBusy('upload');
    try {
      setPoster(await uploadPoster(projectId, file));
      setOnPoster(true);
      setShape('poster');
      setShade(false);          // a poster is already composed; a dark band would spoil it
      setAt(0.82);              // roughly where a poster carries its title
    } catch (err) {
      failure(err, 'The poster could not be uploaded.');
    } finally {
      setBusy('');
    }
  };
  const eraseTitle = async () => {
    setError('');
    setBusy('erase');
    try {
      setPoster(await removePosterTitle(projectId, engine));
      setView('clean');
    } catch (err) {
      failure(err, 'The title could not be removed.');
    } finally {
      setBusy('');
    }
  };
  /** Read what the poster's own title says and put its translation in as the words */
  const translateTitle = async () => {
    setError('');
    setBusy('read');
    try {
      const state = await readPosterTitle(projectId);
      setPoster(state);
      if (state.reading?.title) edit({ main: state.reading.title, sub: state.reading.subtitle || '', highlight: '' });
    } catch (err) {
      failure(err, 'The poster could not be read.');
    } finally {
      setBusy('');
    }
  };
  const paintTitle = async () => {
    setError('');
    setBusy('paint');
    try {
      setPoster(await paintPosterTitle(projectId, option.main, option.sub, engine));
      setView('titled');
    } catch (err) {
      failure(err, 'The poster could not be made.');
    } finally {
      setBusy('');
    }
  };
  const dropPoster = async () => {
    setError('');
    try {
      setPoster(await deletePoster(projectId));
      setOnPoster(false);
      if (shape === 'poster') setShape('16:9');
    } catch (err) {
      failure(err, 'The poster could not be removed.');
    }
  };
  const size: [number, number] = shape === 'poster'
    ? (usingPoster && posterImage.current ? [posterImage.current.naturalWidth, posterImage.current.naturalHeight] : SIZES['9:16'])
    : SIZES[shape];

  const edit = (change: Partial<ThumbnailText>) =>
    onChange(options.map((o, i) => (i === Math.min(picked, options.length - 1) ? { ...o, ...change } : o)));

  const download = () => {
    setError('');
    try {
      canvas.current?.toBlob((blob) => {
        if (!blob) { setError('Could not make the image.'); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${fileName || 'thumbnail'}-${shape === '16:9' ? 'wide' : shape === '9:16' ? 'tall' : 'poster'}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, 'image/png');
    } catch {
      setError('This browser would not let the frame be saved as an image.');
    }
  };

  if (!option) return null;
  const seg = (active: boolean) =>
    `flex-1 px-2 py-1.5 text-[11px] font-semibold transition-colors ${active ? 'bg-blue-600 text-white' : 'bg-[var(--s2)] text-zinc-400 hover:text-white'}`;
  const field = 'w-full rounded-lg border border-[var(--s6)] bg-[var(--s2)] px-3 py-2 text-white font-khmer focus:outline-none focus:border-blue-500';
  const label = 'text-[10px] text-zinc-400';
  const group = 'rounded-xl border border-[var(--s5)] bg-[var(--s2)]/60 p-3 space-y-2.5';
  const step = (n: number, text: string, note?: string) => (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-2">
        <span className="w-5 h-5 rounded-full bg-blue-600/20 text-blue-300 text-[10px] font-bold flex items-center justify-center">{n}</span>
        <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">{text}</span>
      </span>
      {note && <span className="text-[10px] text-zinc-500 text-right">{note}</span>}
    </div>
  );
  const action = 'w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold disabled:opacity-50';
  const engineName = (name?: string | null) => (name === 'codex' ? 'Codex' : name === 'gemini' ? 'Gemini' : '');

  return (
    <div className="rounded-2xl bg-[var(--s3)] border border-[var(--s5)] p-4">
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-4">
        {/* The result, kept in view while the settings beside it scroll */}
        <div className="space-y-2 md:sticky md:top-14 md:self-start">
          <div className="relative rounded-xl bg-black/60 border border-[var(--s5)] flex items-center justify-center p-2" style={{ minHeight: 200 }}>
            <canvas
              ref={canvas}
              aria-label="Thumbnail preview"
              className="rounded-md"
              style={shape === '16:9' ? { width: '100%', maxWidth: 460 } : { maxHeight: shape === 'poster' ? 440 : 320, maxWidth: '100%' }}
            />
            {(busy === 'erase' || busy === 'paint') && (
              <div role="status" className="absolute inset-0 rounded-xl bg-black/70 flex flex-col items-center justify-center gap-2 text-center px-4">
                <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
                <p className="text-xs font-semibold text-white">{busy === 'paint' ? 'Lettering the title into the poster…' : 'Painting the old title out…'}</p>
                <p className="text-[10px] text-zinc-400">Two to three minutes. You can keep editing the words meanwhile.</p>
              </div>
            )}
          </div>

          {usingPoster && (poster.clean_url || poster.titled_url) && (
            <div className="flex rounded-lg border border-[var(--s6)] overflow-hidden" role="tablist" aria-label="Poster version">
              {poster.titled_url && <button role="tab" aria-selected={view === 'titled'} onClick={() => setView('titled')} className={seg(view === 'titled')}>AI title</button>}
              {poster.clean_url && <button role="tab" aria-selected={view === 'clean'} onClick={() => setView('clean')} className={seg(view === 'clean')}>Title removed</button>}
              <button role="tab" aria-selected={!painted && posterUrl === poster.original_url} onClick={() => setView('original')} className={seg(!painted && posterUrl === poster.original_url)}>Original</button>
            </div>
          )}

          <video
            ref={video}
            src={videoSrc}
            muted
            playsInline
            preload="auto"
            className="hidden"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              setDuration(v.duration || 0);
              setShape((now) => (now === 'poster' ? now : v.videoHeight > v.videoWidth ? '9:16' : '16:9'));
              setTime(Math.min(v.duration * 0.2, 8) || 0);
            }}
            onSeeked={() => setFrameReady((n) => n + 1)}
            onLoadedData={() => setFrameReady((n) => n + 1)}
          />
          <label className={usingPoster ? 'hidden' : 'block'}>
            <span className={`flex items-center justify-between ${label}`}><span>Frame from the video</span><span className="font-mono">{clock(time)}</span></span>
            <input type="range" min={0} max={Math.max(0.1, duration - 0.1)} step={0.1} value={time} disabled={!duration}
              onChange={(e) => setTime(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-zinc-800 rounded-lg accent-blue-500 cursor-pointer" />
          </label>

          {/* how it reads small, which is how it is actually seen */}
          <div className="flex items-center gap-2 text-[10px] text-zinc-500">
            <span className="inline-block overflow-hidden rounded border border-[var(--s6)] shrink-0" style={shape === '16:9' ? { width: 120 } : { width: 56 }}>
              <SmallCopy source={canvas} tick={`${frameReady}-${option.main}-${option.highlight}-${option.sub}-${look.id}-${font}-${at}-${shade}-${scale}-${shape}-${usingPoster}-${painted}`} />
            </span>
            <span>The size it is seen at in a feed. If the words cannot be read here, shorten them.</span>
          </div>

          <div className="flex flex-wrap gap-2">
            <button onClick={download} className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold">
              <Download className="w-3.5 h-3.5" /> Save image ({size.join('×')})
            </button>
            <button
              onClick={() => void navigator.clipboard.writeText(option.sub ? `${option.main}\n${option.sub}` : option.main).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[var(--s6)] text-xs font-semibold text-zinc-200 hover:bg-white/10"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied' : 'Copy the words'}
            </button>
          </div>
          {error && <p role="alert" className="text-[11px] text-red-300">{error}</p>}
        </div>

        <div className="space-y-3">
          {/* 1. The words */}
          <div className={group}>
            {step(1, 'Words', 'Each option does a different job')}
            <div className="flex flex-wrap gap-1.5">
              {options.map((o, i) => (
                <button
                  key={i}
                  onClick={() => setPicked(i)}
                  aria-pressed={i === picked}
                  title={o.sub || undefined}
                  className={`rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                    i === picked ? 'border-blue-500 bg-blue-600/15' : 'border-[var(--s5)] bg-[var(--s2)] hover:border-[var(--s8)]'
                  }`}
                >
                  <span className="block text-xs font-bold text-white font-khmer">{o.main || '—'}</span>
                  {o.label && <span className="block text-[9px] uppercase tracking-wide text-zinc-500">{o.label}</span>}
                </button>
              ))}
            </div>
            <label className="block space-y-1">
              <span className={`flex justify-between ${label}`}>
                <span>
                  Big line
                  {!!title && title !== option.main && (
                    <button type="button" onClick={() => edit({ main: title, highlight: '' })} className="ml-2 text-blue-400 hover:text-blue-300 underline">use the video’s title</button>
                  )}
                </span>
                <span className={`font-mono ${option.main.length > 22 ? 'text-amber-300' : 'text-zinc-500'}`}>{option.main.length} / 22</span>
              </span>
              <input value={option.main} onChange={(e) => edit({ main: e.target.value })} className={`${field} text-sm font-bold`} />
            </label>
            <label className="block space-y-1">
              <span className={`flex justify-between ${label}`}><span>Small line (optional)</span><span className={`font-mono ${option.sub.length > 34 ? 'text-amber-300' : 'text-zinc-500'}`}>{option.sub.length} / 34</span></span>
              <input value={option.sub} onChange={(e) => edit({ sub: e.target.value })} className={`${field} text-xs`} />
            </label>
            {option.main.length > 22 && !usingPoster && <p className="text-[10px] text-amber-300">Over 22 characters is hard to read at thumbnail size. It is shrunk to fit.</p>}
          </div>

          {/* 2. The picture behind them */}
          <div className={group}>
            {step(2, 'Picture')}
            <div className="flex rounded-lg border border-[var(--s6)] overflow-hidden">
              <button onClick={() => { setOnPoster(false); if (shape === 'poster') setShape('16:9'); }} aria-pressed={!onPoster} className={seg(!onPoster)}>A frame from the video</button>
              <button onClick={() => { setOnPoster(true); if (poster.original_url) setShape('poster'); }} aria-pressed={onPoster} className={seg(onPoster)}>The movie’s poster</button>
            </div>
            {onPoster && (
              <>
                <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
                  onChange={(e) => { void choosePoster(e.target.files?.[0]); e.target.value = ''; }} />
                {!poster.original_url ? (
                  <button onClick={() => picker.current?.click()} disabled={!!busy}
                    className="w-full rounded-xl border border-dashed border-[var(--s8)] hover:border-blue-500 hover:bg-blue-600/5 px-4 py-5 text-center disabled:opacity-50">
                    {busy === 'upload' ? <Loader2 className="w-5 h-5 animate-spin mx-auto text-blue-400" /> : <ImagePlus className="w-5 h-5 mx-auto text-zinc-400" />}
                    <span className="block mt-1.5 text-xs font-semibold text-white">Upload the original poster</span>
                    <span className="block text-[10px] text-zinc-500">JPG, PNG or WebP. Its title is replaced with yours.</span>
                  </button>
                ) : (
                  <>
                    <div className="rounded-lg border border-[var(--s5)] bg-[var(--s2)] p-2.5 space-y-1.5">
                      {poster.reading ? (
                        <>
                          <p className="text-[10px] text-zinc-500">The poster says</p>
                          <p className="text-xs text-white break-words">{poster.reading.original}</p>
                          {poster.reading.meaning && <p className="text-[11px] text-zinc-400 leading-snug">{poster.reading.meaning}</p>}
                          <p className="text-xs font-khmer text-blue-200 break-words">
                            {poster.reading.title}{poster.reading.subtitle && <span className="text-blue-200/70"> — {poster.reading.subtitle}</span>}
                          </p>
                          <div className="flex flex-wrap gap-2 pt-0.5">
                            {(option.main !== poster.reading.title || option.sub !== (poster.reading.subtitle || '')) && (
                              <button onClick={() => edit({ main: poster.reading!.title, sub: poster.reading!.subtitle || '', highlight: '' })}
                                className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold">Use this translation as the words</button>
                            )}
                            <button onClick={() => void translateTitle()} disabled={!!busy}
                              className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--s6)] text-[10px] font-semibold text-zinc-300 hover:bg-white/10 disabled:opacity-50">
                              {busy === 'read' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Languages className="w-3 h-3" />} Translate again
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-[10px] text-zinc-400 flex-1 min-w-[160px]">Want the poster’s own title in your language? It is read off the poster and put in as the words.</p>
                          <button onClick={() => void translateTitle()} disabled={!!busy}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-500/50 text-[11px] font-bold text-blue-200 hover:bg-blue-600/15 disabled:opacity-50">
                            {busy === 'read' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Languages className="w-3.5 h-3.5" />}
                            {busy === 'read' ? 'Reading the poster…' : 'Translate the poster’s title'}
                          </button>
                        </div>
                      )}
                    </div>
                    <p className={label}>Then replace the poster’s title in one of two ways:</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div className="rounded-lg border border-[var(--s5)] bg-[var(--s2)] p-2.5 space-y-2 flex flex-col">
                        <div className="flex-1">
                          <p className="text-[11px] font-bold text-white">Draw it here</p>
                          <p className="text-[10px] text-zinc-400 leading-snug">The AI only erases the old title. Your words are drawn with real fonts — always spelled right.</p>
                        </div>
                        <button onClick={() => void eraseTitle()} disabled={!!busy} className={action}>
                          {busy === 'erase' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eraser className="w-3.5 h-3.5" />}
                          {busy === 'erase' ? 'Removing…' : poster.clean_url ? 'Remove title again' : 'Remove original title'}
                        </button>
                        {poster.clean_url && <p className="text-[10px] text-emerald-300/90 flex items-center gap-1"><Check className="w-3 h-3" /> Done{engineName(poster.clean_engine) && ` with ${engineName(poster.clean_engine)}`}</p>}
                      </div>
                      <div className="rounded-lg border border-[var(--s5)] bg-[var(--s2)] p-2.5 space-y-2 flex flex-col">
                        <div className="flex-1">
                          <p className="text-[11px] font-bold text-white">Let the AI letter it</p>
                          <p className="text-[10px] text-zinc-400 leading-snug">Your words in the original title’s style. It can misspell Khmer — read it letter by letter.</p>
                        </div>
                        <button onClick={() => void paintTitle()} disabled={!!busy || !option.main.trim()} className={action}>
                          {busy === 'paint' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                          {busy === 'paint' ? 'Making…' : poster.titled_url ? 'Make poster again' : 'Make poster with these words'}
                        </button>
                        {poster.titled_url && (
                          <p className="text-[10px] text-emerald-300/90 flex items-start gap-1">
                            <Check className="w-3 h-3 shrink-0 mt-px" />
                            <span className="font-khmer break-words">Made with “{poster.titled_title}”{engineName(poster.titled_engine) && ` · ${engineName(poster.titled_engine)}`}</span>
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className={`flex items-center gap-1.5 ${label}`}>
                        AI used
                        <select value={engine} onChange={(e) => setEngine(e.target.value as PosterEngine)} disabled={!!busy}
                          className="rounded-lg border border-[var(--s6)] bg-[var(--s3)] px-2 py-1 text-[11px] text-white">
                          <option value="auto">{poster.codex_ready ? 'Automatic (Codex first)' : 'Automatic (Gemini)'}</option>
                          <option value="codex" disabled={!poster.codex_ready}>Codex · ChatGPT{poster.codex_ready ? '' : ' — not signed in'}</option>
                          <option value="gemini">Gemini</option>
                        </select>
                      </label>
                      <span className="flex-1" />
                      <button onClick={() => picker.current?.click()} disabled={!!busy} className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold text-zinc-300 hover:text-white hover:bg-white/10 disabled:opacity-50">
                        {busy === 'upload' ? <Loader2 className="w-3 h-3 animate-spin" /> : <ImagePlus className="w-3 h-3" />} Replace poster
                      </button>
                      <button onClick={() => void dropPoster()} disabled={!!busy} className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold text-zinc-400 hover:text-red-300 hover:bg-white/10 disabled:opacity-50">
                        <Trash2 className="w-3 h-3" /> Delete
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {/* 3. How the drawn words look */}
          <div className={group}>
            {step(3, 'Style')}
            {painted ? (
              <p className="text-[11px] text-zinc-400">
                The AI lettered this version, so there is nothing to style. Switch to <button onClick={() => setView(poster.clean_url ? 'clean' : 'original')} className="text-blue-400 hover:text-blue-300 underline">{poster.clean_url ? 'Title removed' : 'Original'}</button> to draw the words yourself.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                  {LOOKS.map((l) => (
                    <button key={l.id} onClick={() => setLook(l)} aria-pressed={look.id === l.id}
                      className={`rounded-lg border px-2 py-1.5 text-[11px] font-bold ${look.id === l.id ? 'border-blue-500 ring-1 ring-blue-500/40' : 'border-[var(--s6)]'}`}
                      style={{ background: l.box || '#1f2937', color: l.mainFill, WebkitTextStroke: l.mainStroke ? `0.6px ${l.mainStroke}` : undefined }}>
                      {l.name}
                    </button>
                  ))}
                </div>
                <label className="block space-y-1">
                  <span className={`flex justify-between ${label}`}>
                    <span>Word in the second colour</span>
                    {!!option.highlight && !option.main.includes(option.highlight) && <span className="text-amber-300">not in the big line</span>}
                  </span>
                  <input value={option.highlight || ''} onChange={(e) => edit({ highlight: e.target.value })} placeholder="none" className={`${field} text-xs py-1.5`} />
                </label>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                  <label className="space-y-1 block">
                    <span className={label}>Font</span>
                    <select value={font} onChange={(e) => setFont(e.target.value)} className="w-full rounded-lg border border-[var(--s6)] bg-[var(--s2)] px-2 py-1.5 text-[11px] text-white">
                      {FONTS.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
                    </select>
                  </label>
                  <div className="space-y-1">
                    <span className={label}>Shape</span>
                    <div className="flex rounded-lg border border-[var(--s6)] overflow-hidden">
                      {((usingPoster ? ['poster', '16:9', '9:16'] : ['16:9', '9:16']) as Shape[]).map((s) => (
                        <button key={s} onClick={() => setShape(s)} aria-pressed={shape === s} className={seg(shape === s)}>{s === '16:9' ? 'Wide' : s === '9:16' ? 'Tall' : 'Poster'}</button>
                      ))}
                    </div>
                  </div>
                  <label className="space-y-1 block">
                    <span className={`flex justify-between ${label}`}><span>Size</span><span className="font-mono">{Math.round(scale * 100)}%</span></span>
                    <input type="range" min={0.5} max={1.5} step={0.05} value={scale} onChange={(e) => setScale(parseFloat(e.target.value))}
                      className="w-full h-1.5 bg-zinc-800 rounded-lg accent-blue-500 cursor-pointer" />
                  </label>
                  <label className="space-y-1 block">
                    <span className={`flex justify-between ${label}`}><span>Height on the picture</span><span className="font-mono">{Math.round(at * 100)}%</span></span>
                    <input type="range" min={0} max={1} step={0.01} value={at} onChange={(e) => setAt(parseFloat(e.target.value))}
                      className="w-full h-1.5 bg-zinc-800 rounded-lg accent-blue-500 cursor-pointer" />
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="flex rounded-lg border border-[var(--s6)] overflow-hidden w-48">
                    {PLACES.map(([name, value]) => <button key={name} onClick={() => setAt(value)} aria-pressed={at === value} className={`${seg(at === value)} capitalize`}>{name}</button>)}
                  </div>
                  <label className="flex items-center gap-2 text-[11px] text-zinc-300 cursor-pointer">
                    <input type="checkbox" checked={shade} onChange={(e) => setShade(e.target.checked)} className="accent-blue-500" />
                    Darken behind the words
                  </label>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A small live copy of the preview, to show how the thumbnail reads at feed size. */
function SmallCopy({ source, tick }: { source: React.RefObject<HTMLCanvasElement | null>; tick: string }) {
  const small = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    // after the main canvas has drawn this change
    const id = requestAnimationFrame(() => {
      const from = source.current;
      const to = small.current;
      const ctx = to?.getContext('2d');
      if (!from || !to || !ctx || !from.width) return;
      to.width = 240;
      to.height = Math.round((240 * from.height) / from.width);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(from, 0, 0, to.width, to.height);
    });
    return () => cancelAnimationFrame(id);
  }, [source, tick]);
  return <canvas ref={small} className="block w-full" />;
}
