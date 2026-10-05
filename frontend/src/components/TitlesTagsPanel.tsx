import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, Copy, Download, FileSignature, Hash, Image as ImageIcon, Layers, Loader2, MessageSquareText, Plus, Send, Sparkles, TriangleAlert,
} from 'lucide-react';
import {
  fetchPublishKit, fetchPublishSeries, generatePublishKit, savePublishKit, savePublishSeries, type PublishKit, type PublishSeries,
} from '../api/client';
import ThumbnailMaker, { type ThumbnailText } from './ThumbnailMaker';

const TONES: [string, string][] = [
  ['viral', 'Curiosity'], ['suspense', 'Suspense'], ['comedy', 'Comedy'], ['action', 'Action'], ['emotional', 'Emotional'],
];
const FOCUS: [string, string][] = [['all', 'All platforms'], ['youtube', 'YouTube'], ['tiktok', 'TikTok / Shorts'], ['facebook', 'Facebook']];

type Platform = 'youtube' | 'tiktok' | 'facebook';
// What each platform accepts, so a title or caption that will be cut off is caught here
const PLATFORMS: Record<Platform, { name: string; titleLimit: number; bodyLimit: number; tags: number; tagNote: string }> = {
  youtube: { name: 'YouTube', titleLimit: 100, bodyLimit: 5000, tags: 15, tagNote: 'the first three show above the title' },
  tiktok: { name: 'TikTok / Shorts', titleLimit: 0, bodyLimit: 2200, tags: 5, tagNote: 'a few specific tags work better than many' },
  facebook: { name: 'Facebook', titleLimit: 0, bodyLimit: 2000, tags: 8, tagNote: 'keep it short' },
};

type Section = 'post' | 'tags' | 'thumbnail' | 'extras';
const SECTIONS: [Section, string, typeof Send][] = [
  ['post', 'Title & text', Send], ['tags', 'Tags', Hash], ['thumbnail', 'Thumbnail', ImageIcon], ['extras', 'Extras', MessageSquareText],
];
const SECTION_KEY = 'titlesTags.section';

const fileSafe = (text: string) =>
  text.replace(/[\\/:*?"<>|#]/g, '').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80);

/**
 * Titles, descriptions and tags for posting the finished video. Written from the captions,
 * kept with the project, editable, and copied out one platform at a time — which is how they
 * are used: one paste into YouTube, one into TikTok, one into Facebook.
 *
 * The page is split by what is being done — pick the title and text, trim the tags, make the
 * thumbnail — so each job fits on one screen instead of one long scroll.
 */
export default function TitlesTagsPanel({ projectId, hasCaptions, videoSrc, onUseAsFileName }: {
  projectId: string;
  hasCaptions: boolean;
  /** The project's video, for putting thumbnail text on a real frame */
  videoSrc?: string;
  onUseAsFileName?: (title: string) => void;
}) {
  const [kit, setKit] = useState<PublishKit | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tone, setTone] = useState('viral');
  const [focus, setFocus] = useState('all');
  const [platform, setPlatform] = useState<Platform>('youtube');
  const [copied, setCopied] = useState('');
  const [notice, setNotice] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState<'' | 'saving' | 'saved'>('');
  const [newTag, setNewTag] = useState('');
  // the series this video is one part of; without it a part is written up as a whole film
  const [series, setSeries] = useState<PublishSeries>({ series_name: '', part: 0, total_parts: 0, premise: '', suggested: false });
  const [section, setSection] = useState<Section>(() => {
    try {
      const kept = localStorage.getItem(SECTION_KEY) as Section | null;
      return kept && SECTIONS.some(([id]) => id === kept) ? kept : 'post';
    } catch {
      return 'post';
    }
  });
  const go = (next: Section) => {
    setSection(next);
    try { localStorage.setItem(SECTION_KEY, next); } catch { /* private mode: not remembered */ }
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchPublishKit(projectId)
      .then((saved) => {
        if (!active || !saved) return;
        setKit(saved);
        setTone(saved.tone || 'viral');
        setFocus(saved.platform || 'all');
        if (saved.platform === 'youtube' || saved.platform === 'tiktok' || saved.platform === 'facebook') setPlatform(saved.platform);
      })
      .catch(() => {})
      .finally(() => active && setLoading(false));
    fetchPublishSeries(projectId).then((found) => active && setSeries(found)).catch(() => {});
    return () => { active = false; };
  }, [projectId]);

  // Series details are kept a moment after typing stops. Saving is also what confirms a
  // suggestion carried over from the last project.
  const seriesTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seriesToSave = useRef<PublishSeries | null>(null);
  const flushSeries = () => {
    const next = seriesToSave.current;
    seriesToSave.current = null;
    return next
      ? savePublishSeries(projectId, next).then(() => undefined).catch(() => setError('The series details could not be saved.'))
      : Promise.resolve();
  };
  const keepSeries = (change: Partial<PublishSeries>, now = false) => {
    const next = { ...series, ...change, suggested: false };
    setSeries(next);
    seriesToSave.current = next;
    clearTimeout(seriesTimer.current);
    if (now) void flushSeries(); else seriesTimer.current = setTimeout(() => void flushSeries(), 700);
  };
  useEffect(() => () => { clearTimeout(seriesTimer.current); void flushSeries(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const inSeries = !!(series.series_name || series.part || series.premise);
  const seriesKey = (s?: Partial<PublishSeries> | null) => (s ? `${s.series_name || ''}|${s.part || 0}|${s.total_parts || 0}|${s.premise || ''}` : '|0|0|');

  // Edits are kept: saved a moment after typing stops, not on every key. Changes made while
  // waiting are gathered, so a quick edit to one field cannot drop the edit before it.
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const unsaved = useRef<Partial<PublishKit>>({});
  const flush = () => {
    const change = unsaved.current;
    unsaved.current = {};
    if (!Object.keys(change).length) return;
    void savePublishKit(projectId, change)
      .then(() => { setSaving('saved'); setTimeout(() => setSaving((s) => (s === 'saved' ? '' : s)), 2000); })
      .catch(() => { setSaving(''); setError('Your edit could not be saved.'); });
  };
  const edit = (change: Partial<PublishKit>) => {
    setKit((current) => (current ? { ...current, ...change } : current));
    unsaved.current = { ...unsaved.current, ...change };
    setSaving('saving');
    clearTimeout(pending.current);
    pending.current = setTimeout(flush, 700);
  };
  // leaving the tab must not lose the last edit
  useEffect(() => () => { clearTimeout(pending.current); flush(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async () => {
    if (busy) return;
    setConfirming(false);
    setBusy(true); setError('');
    clearTimeout(seriesTimer.current);
    try {
      await flushSeries();            // the writer reads the saved series details
      setKit(await generatePublishKit(projectId, tone, focus));
      go('post');
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setError((typeof detail === 'string' && detail) || err?.message || 'Could not write the titles and tags.');
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string, key: string) => {
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? '' : c)), 2000);
    }).catch(() => setError('Could not copy. Select the text and copy it by hand.'));
  };

  const thumbnails = useMemo<ThumbnailText[]>(
    () => (kit?.thumbnail_texts || []).map((t) => (typeof t === 'string' ? { angle: '', label: '', main: t, sub: '' } : t)),
    [kit],
  );

  const spec = PLATFORMS[platform];
  const offTags = useMemo(() => new Set(kit?.hashtags_off || []), [kit]);
  const tags = useMemo(() => (kit?.hashtags || []).filter((t) => !offTags.has(t)), [kit, offTags]);
  const body = !kit ? '' : platform === 'youtube' ? kit.description : platform === 'tiktok' ? kit.short_caption : kit.facebook_caption;
  const bodyKey = platform === 'youtube' ? 'description' : platform === 'tiktok' ? 'short_caption' : 'facebook_caption';
  const platformTags = tags.slice(0, spec.tags);
  // exactly what gets pasted into that platform's box
  const paste = !kit ? '' : platform === 'youtube'
    ? `${kit.chosen_title}\n\n${body}\n\n${platformTags.join(' ')}`
    : `${platform === 'facebook' ? `${kit.chosen_title}\n\n` : ''}${body}\n\n${platformTags.join(' ')}`;
  const keywords = kit?.seo_keywords.join(', ') || '';

  const everything = !kit ? '' : [
    `TITLE\n${kit.chosen_title}`,
    `OTHER TITLES\n${kit.titles.filter((t) => t.text !== kit.chosen_title).map((t) => `- ${t.text}`).join('\n')}`,
    `FIRST 3 SECONDS\n${kit.hook}`,
    `YOUTUBE DESCRIPTION\n${kit.description}`,
    `TIKTOK / SHORTS CAPTION\n${kit.short_caption}`,
    `FACEBOOK CAPTION\n${kit.facebook_caption}`,
    `HASHTAGS\n${tags.join(' ')}`,
    `SEARCH KEYWORDS\n${keywords}`,
    `PINNED COMMENT\n${kit.pinned_comment}`,
    `THUMBNAIL TEXT\n${thumbnails.map((t) => `- ${t.main}${t.sub ? ` / ${t.sub}` : ''}`).join('\n')}`,
  ].join('\n\n');
  const saveAll = () => {
    if (!kit) return;
    const url = URL.createObjectURL(new Blob([everything], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileSafe(kit.chosen_title) || 'titles-and-tags'}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const toggleTag = (tag: string) => {
    const next = new Set(offTags);
    if (next.has(tag)) next.delete(tag); else next.add(tag);
    edit({ hashtags_off: [...next] });
  };
  const addTag = () => {
    if (!kit) return;
    const tag = `#${newTag.replace(/[#\s]/g, '')}`;
    setNewTag('');
    if (tag.length < 2 || kit.hashtags.includes(tag)) return;
    edit({ hashtags: [tag, ...kit.hashtags] });      // a tag added by hand is the most specific, so it goes first
  };

  const chip = (active: boolean) =>
    `px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors cursor-pointer ${
      active ? 'bg-blue-600 text-white' : 'bg-[var(--s4)] text-zinc-400 hover:text-zinc-200 border border-white/5'
    }`;
  const heading = 'text-[11px] font-bold uppercase tracking-wider text-zinc-300';
  const card = 'rounded-2xl bg-[var(--s3)] border border-[var(--s5)] p-4 space-y-3';
  const input = 'w-full rounded-lg border border-[var(--s6)] bg-[var(--s2)] px-3 py-2 font-khmer focus:outline-none focus:border-blue-500';
  const quiet = 'flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[var(--s6)] text-xs font-semibold text-zinc-200 hover:bg-white/10';
  const count = (n: number, limit: number) => (
    <span className={`font-mono tabular-nums text-[10px] ${limit && n > limit ? 'text-red-300 font-bold' : 'text-zinc-500'}`}>
      {n}{limit ? ` / ${limit}` : ''}
    </span>
  );
  const step = (n: number, text: string) => (
    <span className="flex items-center gap-2">
      <span className="w-5 h-5 rounded-full bg-blue-600/20 text-blue-300 text-[10px] font-bold flex items-center justify-center">{n}</span>
      <span className={heading}>{text}</span>
    </span>
  );
  const CopyButton = ({ text, id, label = 'Copy' }: { text: string; id: string; label?: string }) => (
    <button onClick={() => copy(text, id)} className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold text-zinc-300 hover:text-white hover:bg-white/10 shrink-0">
      {copied === id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
      {copied === id ? 'Copied' : label}
    </button>
  );

  return (
    <div className="space-y-4 max-w-4xl mx-auto py-2 text-zinc-200">
      {/* What to write */}
      <div className={card}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center text-white shrink-0"><Sparkles className="w-4 h-4" /></div>
            <div className="min-w-0">
              <h4 className="text-xs font-bold text-white">Titles & tags</h4>
              <p className="text-[11px] text-zinc-400">
                {kit ? `Written ${new Date(kit.generated_at).toLocaleString()} from ${kit.source_segments} caption lines.` : 'Written from this video’s captions, and kept with the project.'}
                {saving && <span role="status" className="ml-2 text-zinc-500">{saving === 'saving' ? 'Saving…' : 'Saved'}</span>}
              </p>
            </div>
          </div>
          <button
            onClick={() => (kit ? setConfirming(true) : void generate())}
            disabled={busy || !hasCaptions}
            title={hasCaptions ? undefined : 'Add captions first — the titles are written from what is said'}
            className="justify-center px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold flex items-center gap-2 shrink-0"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {busy ? 'Writing…' : kit ? 'Write a new set' : 'Write titles & tags'}
          </button>
        </div>
        <div className="flex flex-col sm:flex-row gap-x-6 gap-y-3 pt-3 border-t border-white/5">
          <div className="space-y-1.5">
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Angle</span>
            <div className="flex flex-wrap gap-1.5">{TONES.map(([id, label]) => <button key={id} onClick={() => setTone(id)} aria-pressed={tone === id} className={chip(tone === id)}>{label}</button>)}</div>
          </div>
          <div className="space-y-1.5">
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Written for</span>
            <div className="flex flex-wrap gap-1.5">{FOCUS.map(([id, label]) => <button key={id} onClick={() => setFocus(id)} aria-pressed={focus === id} className={chip(focus === id)}>{label}</button>)}</div>
          </div>
        </div>
        {/* One part of a series */}
        <div className="rounded-xl border border-[var(--s5)] bg-[var(--s2)]/60 p-3 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[10px] font-bold text-zinc-400 uppercase tracking-wider"><Layers className="w-3.5 h-3.5" /> Part of a series</span>
            <span className="text-[10px] text-zinc-500">Leave empty for a film that is complete in one video</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-2.5">
            <label className="block space-y-1">
              <span className="text-[10px] text-zinc-400">Series name</span>
              <input value={series.series_name} onChange={(e) => keepSeries({ series_name: e.target.value })} placeholder="The name viewers know it by"
                className={`${input} text-xs text-white py-1.5`} />
            </label>
            <div className="flex items-end gap-1.5">
              <label className="block space-y-1">
                <span className="text-[10px] text-zinc-400">This is part</span>
                <input type="number" min={0} max={9999} value={series.part || ''} onChange={(e) => keepSeries({ part: parseInt(e.target.value, 10) || 0 })} placeholder="12"
                  className={`${input} text-xs text-white py-1.5 w-20 font-mono`} />
              </label>
              <span className="pb-2 text-[11px] text-zinc-500">of</span>
              <label className="block space-y-1">
                <span className="text-[10px] text-zinc-400">Parts in all</span>
                <input type="number" min={0} max={9999} value={series.total_parts || ''} onChange={(e) => keepSeries({ total_parts: parseInt(e.target.value, 10) || 0 })} placeholder="87"
                  className={`${input} text-xs text-white py-1.5 w-20 font-mono`} />
              </label>
            </div>
          </div>
          <label className="block space-y-1">
            <span className="text-[10px] text-zinc-400">What the whole series is about (optional, one or two sentences, any language)</span>
            <textarea value={series.premise} onChange={(e) => keepSeries({ premise: e.target.value })} rows={2}
              placeholder="Who the hero is, what he wants, who stands in his way"
              className={`${input} text-xs text-zinc-100 leading-relaxed resize-y`} />
          </label>
          {series.suggested && inSeries && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-blue-500/40 bg-blue-600/10 px-2.5 py-2">
              <span className="text-[11px] text-blue-100 flex-1 min-w-[180px]">
                Filled in from your last project{series.part ? ' and this project’s name' : ''}. It is not used until you confirm it.
              </span>
              <button onClick={() => keepSeries({}, true)} className="px-3 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold">Yes, use it</button>
              <button onClick={() => keepSeries({ series_name: '', part: 0, total_parts: 0, premise: '' }, true)} className="px-3 py-1 rounded-lg border border-white/15 text-[11px] font-semibold text-zinc-200 hover:bg-white/10">Not a series</button>
            </div>
          )}
          {!series.suggested && inSeries && (
            <p className="text-[10px] text-zinc-500">
              Titles are written for {series.part ? `part ${series.part}` : 'this part'} alone — what happens in it, with the part number in the title — and do not promise an ending{series.part && series.total_parts && series.part >= series.total_parts ? ' (this is the last part, so they may)' : ''}.
            </p>
          )}
        </div>
        {kit && !busy && !series.suggested && seriesKey(series) !== seriesKey(kit.series) && (
          <p className="text-[11px] text-amber-200">The set below was written {kit.series ? 'with different series details' : 'as if this video were a whole film'}. Press “Write a new set” to use these.</p>
        )}
        {confirming && (
          <div role="alertdialog" aria-label="Replace this set" className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2">
            <span className="text-[11px] text-amber-100 flex-1 min-w-[200px]">A new set replaces the titles, text and tags here, including your edits. Posters you made are kept.</span>
            <button onClick={() => void generate()} className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-[11px] font-bold">Replace</button>
            <button onClick={() => setConfirming(false)} className="px-3 py-1.5 rounded-lg border border-white/15 text-[11px] font-semibold text-zinc-200 hover:bg-white/10">Keep this set</button>
          </div>
        )}
        {busy && <p role="status" className="text-[11px] text-zinc-400">Reading the captions and writing — this usually takes under a minute.</p>}
        {kit && !busy && !confirming && (tone !== kit.tone || focus !== kit.platform) && (
          <p className="text-[11px] text-zinc-500">The set below was written with different choices. Press “Write a new set” to use these.</p>
        )}
        {error && <p role="alert" className="flex items-start gap-1.5 text-xs text-red-300"><TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-px" />{error}</p>}
        {!hasCaptions && <p className="text-xs text-amber-300">This project has no captions yet. Generate or import them first.</p>}
      </div>

      {loading && <p className="flex items-center justify-center gap-2 py-8 text-xs text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>}

      {!loading && !kit && !busy && hasCaptions && (
        <div className="rounded-2xl border border-dashed border-[var(--s6)] p-8 text-center space-y-3">
          <p className="text-sm font-semibold text-white">Nothing written yet</p>
          <p className="text-xs text-zinc-400">Pick an angle above and press <span className="text-white font-semibold">Write titles & tags</span>. You get:</p>
          <ul className="flex flex-wrap justify-center gap-1.5 text-[11px] text-zinc-300">
            {['Titles to choose from', 'A description for YouTube', 'Captions for TikTok and Facebook', 'Hashtags and search keywords', 'Thumbnail wording', 'A pinned comment'].map((item) => (
              <li key={item} className="rounded-lg bg-[var(--s3)] border border-[var(--s5)] px-2.5 py-1">{item}</li>
            ))}
          </ul>
        </div>
      )}

      {kit && (
        <>
          {kit.stale && (
            <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
              The captions have changed since this was written. Write a new set if the story changed.
            </p>
          )}

          {/* One job at a time */}
          <div role="tablist" aria-label="Sections" className="sticky top-0 z-10 flex gap-1 rounded-xl border border-[var(--s5)] bg-[var(--s3)] p-1 shadow-lg shadow-black/30">
            {SECTIONS.map(([id, label, Icon]) => (
              <button key={id} role="tab" aria-selected={section === id} onClick={() => go(id)}
                className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-[11px] font-semibold transition-colors ${
                  section === id ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-white hover:bg-white/5'
                }`}>
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{label}</span>
                {id === 'tags' && <span className={`font-mono text-[10px] ${section === id ? 'text-blue-100' : 'text-zinc-500'}`}>{tags.length}</span>}
              </button>
            ))}
          </div>

          {section === 'post' && (
            <>
              {/* Titles to choose from */}
              <div className={card}>
                <div className="flex items-center justify-between gap-2">
                  {step(1, 'Choose a title')}
                  <span className="text-[10px] text-zinc-500">Phones show about the first 50 characters</span>
                </div>
                <ul className="space-y-1.5" role="radiogroup" aria-label="Titles">
                  {kit.titles.map((t, i) => {
                    const chosen = t.text === kit.chosen_title;
                    return (
                      <li key={i} className={`flex items-center gap-2 rounded-xl border px-3 py-2 transition-colors ${chosen ? 'border-blue-500/70 bg-blue-600/10' : 'border-[var(--s5)] bg-[var(--s2)] hover:border-[var(--s8)]'}`}>
                        <button role="radio" aria-checked={chosen} onClick={() => edit({ chosen_title: t.text })} className="min-w-0 flex-1 flex items-start gap-2.5 text-left">
                          <span className={`mt-1 w-3.5 h-3.5 rounded-full border-2 shrink-0 ${chosen ? 'border-blue-400 bg-blue-500 shadow-[inset_0_0_0_2px_var(--s2)]' : 'border-zinc-600'}`} />
                          <span className="min-w-0">
                            <span className="block text-sm text-white font-khmer leading-snug">
                              {t.text.slice(0, 50)}<span className="text-zinc-400">{t.text.slice(50)}</span>
                            </span>
                            <span className="flex items-center gap-2 mt-0.5 text-[10px] text-zinc-500"><span>{t.label}</span>{count(t.text.length, 100)}</span>
                          </span>
                        </button>
                        <CopyButton text={t.text} id={`title-${i}`} />
                      </li>
                    );
                  })}
                </ul>
                <label className="block space-y-1">
                  <span className="flex items-center justify-between text-[10px] text-zinc-400">
                    <span>The title in use — edit it freely</span>{count(kit.chosen_title.length, 100)}
                  </span>
                  <input value={kit.chosen_title} onChange={(e) => edit({ chosen_title: e.target.value })} className={`${input} text-sm text-white`} />
                </label>
                {kit.chosen_title.length > 100 && <p className="text-[11px] text-red-300">YouTube cuts a title off after 100 characters.</p>}
                {onUseAsFileName && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => { onUseAsFileName(fileSafe(kit.chosen_title)); setNotice('The export will be named after this title.'); setTimeout(() => setNotice(''), 3000); }}
                      className={quiet}
                      title="Name the exported video file after this title"
                    >
                      <FileSignature className="w-3.5 h-3.5" /> Use title as file name
                    </button>
                    {notice && <span role="status" className="text-[11px] text-emerald-300">{notice}</span>}
                  </div>
                )}
              </div>

              {/* Ready to post: one platform at a time */}
              <div className={card}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  {step(2, 'Copy the text for each platform')}
                  <div className="flex rounded-lg border border-[var(--s6)] overflow-hidden" role="tablist" aria-label="Platform">
                    {(Object.keys(PLATFORMS) as Platform[]).map((id) => (
                      <button key={id} role="tab" aria-selected={platform === id} onClick={() => setPlatform(id)}
                        className={`px-3 py-1.5 text-[11px] font-semibold ${platform === id ? 'bg-blue-600 text-white' : 'bg-[var(--s2)] text-zinc-400 hover:text-white'}`}>
                        {PLATFORMS[id].name}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="block space-y-1">
                  <span className="flex items-center justify-between text-[10px] text-zinc-400">
                    <span>{platform === 'youtube' ? 'Description' : 'Caption'}</span>
                    <span className="flex items-center gap-1">{count(body.length, spec.bodyLimit)}<CopyButton text={body} id={`body-${platform}`} /></span>
                  </span>
                  <textarea
                    value={body}
                    onChange={(e) => edit({ [bodyKey]: e.target.value })}
                    rows={platform === 'youtube' ? 9 : 4}
                    className={`${input} text-xs leading-relaxed text-zinc-100 resize-y`}
                  />
                </label>
                {body.length > spec.bodyLimit && <p className="text-[11px] text-red-300">{spec.name} accepts {spec.bodyLimit} characters here.</p>}

                <div className="space-y-1">
                  <span className="flex items-center justify-between text-[10px] text-zinc-400">
                    <span>Hashtags used here — {spec.tagNote}</span>
                    <button onClick={() => go('tags')} className="text-blue-400 hover:text-blue-300">{platformTags.length} of {tags.length} · change</button>
                  </span>
                  <p className="text-[11px] text-blue-200 font-khmer break-words">{platformTags.join(' ') || '—'}</p>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button onClick={() => copy(paste, `paste-${platform}`)} className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold">
                    {copied === `paste-${platform}` ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied === `paste-${platform}` ? 'Copied' : `Copy everything for ${spec.name}`}
                  </button>
                  <span className="text-[10px] text-zinc-500">
                    {platform === 'tiktok' ? 'Caption and hashtags' : 'Title, text and hashtags'} in one paste
                  </span>
                </div>
                <details className="group">
                  <summary className="cursor-pointer text-[11px] text-zinc-400 hover:text-zinc-200 select-none">See exactly what is copied</summary>
                  <pre className="mt-2 max-h-56 overflow-auto rounded-lg border border-[var(--s5)] bg-[var(--s2)] p-3 text-[11px] leading-relaxed text-zinc-200 font-khmer whitespace-pre-wrap break-words">{paste}</pre>
                </details>
              </div>
            </>
          )}

          {section === 'tags' && (
            <>
              <div className={card}>
                <div className="flex items-center justify-between">
                  <span className={heading}>Hashtags · {tags.length} of {kit.hashtags.length} on</span>
                  <CopyButton text={tags.join(' ')} id="tags" label="Copy all" />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {kit.hashtags.map((tag) => {
                    const off = offTags.has(tag);
                    return (
                      <button
                        key={tag}
                        aria-pressed={!off}
                        onClick={() => toggleTag(tag)}
                        className={`px-2 py-1 rounded-lg text-[11px] font-khmer border transition-colors ${off ? 'border-[var(--s5)] text-zinc-600 line-through' : 'border-blue-500/40 bg-blue-600/10 text-blue-100 hover:border-blue-400'}`}
                      >
                        {tag}
                      </button>
                    );
                  })}
                </div>
                <form onSubmit={(e) => { e.preventDefault(); addTag(); }} className="flex items-center gap-2">
                  <input value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="Add your own tag" aria-label="Add your own tag"
                    className={`${input} text-xs text-white max-w-[220px] py-1.5`} />
                  <button type="submit" disabled={!newTag.replace(/[#\s]/g, '')} className={`${quiet} py-1.5 disabled:opacity-40`}><Plus className="w-3.5 h-3.5" /> Add</button>
                </form>
                <p className="text-[10px] text-zinc-500">
                  Click a tag to leave it out. They are used in this order, most specific first:
                  {' '}{(Object.keys(PLATFORMS) as Platform[]).map((id) => `${PLATFORMS[id].name} takes the first ${PLATFORMS[id].tags}`).join(', ')}.
                </p>
              </div>

              <div className={card}>
                <div className="flex items-center justify-between">
                  <span className={heading}>Search keywords</span>
                  <CopyButton text={keywords} id="seo" label="Copy, comma separated" />
                </div>
                <textarea
                  defaultValue={keywords}
                  key={kit.generated_at}
                  onBlur={(e) => edit({ seo_keywords: e.target.value.split(/[,\n]/).map((k) => k.trim()).filter(Boolean) })}
                  rows={3}
                  className={`${input} text-xs leading-relaxed text-zinc-100 resize-y`}
                />
                <p className="text-[10px] text-zinc-500">For the Tags box in YouTube Studio, separated by commas. {count(keywords.length, 500)}</p>
              </div>
            </>
          )}

          {section === 'thumbnail' && (
            thumbnails.length > 0 && videoSrc ? (
              <ThumbnailMaker
                projectId={projectId}
                title={kit.chosen_title}
                videoSrc={videoSrc}
                options={thumbnails}
                onChange={(next) => edit({ thumbnail_texts: next })}
                fileName={fileSafe(kit.chosen_title)}
              />
            ) : (
              <div className={card}>
                <span className={heading}>Thumbnail text</span>
                {thumbnails.length > 0 ? (
                  <>
                    <ul className="space-y-1 text-xs font-khmer">
                      {thumbnails.map((t, i) => <li key={i}><span className="font-bold text-white">{t.main}</span>{t.sub && <span className="text-zinc-400"> — {t.sub}</span>}</li>)}
                    </ul>
                    <p className="text-[10px] text-zinc-500">Add the video to the timeline to try these on a frame.</p>
                  </>
                ) : (
                  <p className="text-xs text-zinc-400">This set has no thumbnail wording. Write a new set to get some.</p>
                )}
              </div>
            )
          )}

          {section === 'extras' && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className={card}>
                  <div className="flex items-center justify-between"><span className={heading}>First 3 seconds</span><CopyButton text={kit.hook} id="hook" /></div>
                  <textarea value={kit.hook} onChange={(e) => edit({ hook: e.target.value })} rows={3} className={`${input} text-sm text-white resize-y`} />
                  <p className="text-[10px] text-zinc-500">Text to put on screen as the video opens. {count(kit.hook.length, 60)}</p>
                </div>
                <div className={card}>
                  <div className="flex items-center justify-between"><span className={heading}>Pinned comment</span><CopyButton text={kit.pinned_comment} id="comment" /></div>
                  <textarea value={kit.pinned_comment} onChange={(e) => edit({ pinned_comment: e.target.value })} rows={3} className={`${input} text-xs text-zinc-100 resize-y`} />
                  <p className="text-[10px] text-zinc-500">A question to pin under the video to start the comments.</p>
                </div>
              </div>
              <div className={`${card} sm:flex sm:items-center sm:justify-between sm:space-y-0 gap-3`}>
                <div>
                  <span className={heading}>Everything in one file</span>
                  <p className="text-[11px] text-zinc-400 mt-1">The title, the other titles, every caption, the tags and the thumbnail wording as a text file.</p>
                </div>
                <button onClick={saveAll} className={`${quiet} shrink-0`}><Download className="w-3.5 h-3.5" /> Save as .txt</button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
