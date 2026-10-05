import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Play, Square } from 'lucide-react';
import type { Segment } from '../types';
import VoiceEQPanel, { DEFAULT_VOICE_EQ } from './VoiceEQPanel';
import VoiceGroups from './VoiceGroups';
import VoiceWaveform from './VoiceWaveform';
import { captureMovieVoice, previewCapturedVoice } from '../api/client';
import { useProjectStore } from '../stores/projectStore';

export default function VoiceCapturePanel({ initialTime = 0 }: { initialTime?: number }) {
  const project = useProjectStore(s => s.currentProject);
  return project ? <CaptureForm key={project.id} initialTime={initialTime} /> : <p className="p-4">Open a project to capture a voice.</p>;
}

/** A stretch of one character speaking, built from their captions. */
interface Take { start: number; end: number; text: string; clean: boolean }

const clock = (t: number) => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`;

/** The best moments to sample a character from: runs of their own lines with nobody else
 *  talking, closest to eight seconds first. Hunting for these on a waveform is the slow part
 *  of capturing a voice, and the captions already say where they are. */
function takesFor(segments: Segment[], speaker: string, duration: number): Take[] {
  const ordered = [...segments].sort((a, b) => a.start_time - b.start_time);
  const takes: Take[] = [];
  let run: Take | null = null;
  for (const seg of ordered) {
    if (seg.speaker !== speaker || !(seg.text || '').trim()) {
      if (run) takes.push(run);
      run = null;
      continue;
    }
    if (run && seg.start_time - run.end <= 0.8 && seg.end_time - run.start <= 14) {
      run.end = Math.max(run.end, seg.end_time);
      run.text += ` ${seg.text}`;
    } else {
      if (run) takes.push(run);
      run = { start: seg.start_time, end: seg.end_time, text: seg.text, clean: true };
    }
  }
  if (run) takes.push(run);
  for (const take of takes) {
    // a sample needs 3–30 seconds; a short line is padded, which may pull in what follows it
    if (take.end - take.start < 3) take.end = Math.min(duration, take.start + 3);
    if (take.end - take.start > 30) take.end = take.start + 30;
    take.clean = !ordered.some((o) => o.speaker !== speaker && o.start_time < take.end - 0.05 && o.end_time > take.start + 0.05);
  }
  return takes
    .filter((t) => t.end - t.start >= 3)
    .sort((a, b) => Number(b.clean) - Number(a.clean) || Math.abs(a.end - a.start - 8) - Math.abs(b.end - b.start - 8))
    .slice(0, 12);
}

function CaptureForm({ initialTime }: { initialTime: number }) {
  const project = useProjectStore(s => s.currentProject)!;
  const loadProject = useProjectStore(s => s.loadProject);
  const movie = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(initialTime);
  const previewing = useRef(false);
  const eqAudio = useRef<HTMLAudioElement>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const previewUrl = useRef('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [eq, setEq] = useState(DEFAULT_VOICE_EQ);
  const [start, setStart] = useState(Math.max(0, Math.min(initialTime, project.duration - 3)));
  const [end, setEnd] = useState(Math.min(start + 10, project.duration));
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState('');
  const [groupsRefresh, setGroupsRefresh] = useState(0);
  const [speaker, setSpeaker] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sample, setSample] = useState('');
  const [message, setMessage] = useState('');
  const characters = [...new Set(project.segments.map(s => s.speaker).filter(Boolean))];
  const valid = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= project.duration && end - start >= 3 && end - start <= 30;
  // On the app's surface ramp, and with a hierarchy: one primary action, a highlighted
  // listen button, and quiet buttons for the marks — they used to be four identical greys.
  const inputClass =
    'w-full bg-[var(--s4)] border border-[var(--s6)] rounded-lg px-3 py-2 text-sm text-zinc-100 ' +
    'placeholder:text-zinc-500 focus:border-[var(--accent-primary)] focus:outline-none transition-colors';
  const buttonClass =
    'rounded-lg bg-[var(--s4)] hover:bg-[var(--s5)] border border-[var(--s6)] px-3 py-2 text-[11px] ' +
    'font-medium text-zinc-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors';
  const listenClass =
    'rounded-lg bg-[var(--accent-primary)]/15 hover:bg-[var(--accent-primary)]/25 border border-[var(--accent-primary)]/40 ' +
    'px-3 py-2 text-[11px] font-semibold text-[var(--accent-text)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors';
  const seconds = end - start;
  const takes = useMemo(
    () => (speaker ? takesFor(project.segments, speaker, project.duration) : []),
    [project.segments, speaker, project.duration],
  );
  // The waveform is the only way to find a voice when there are no captions to pick from;
  // with captions it is fine-tuning, and stays folded away until asked for.
  const [showWaveform, setShowWaveform] = useState(characters.length === 0);
  const [showEq, setShowEq] = useState(false);
  const playAfterSelect = useRef(false);

  // The EQ preview is a separate processed clip, so the movie plays muted beside it to keep
  // the picture on screen.
  const followingEq = useRef(false);
  function stopPicture() {
    if (!followingEq.current) return;
    followingEq.current = false;
    if (movie.current) { movie.current.pause(); movie.current.muted = false; }
  }
  function stopEQPreview() {
    previewRequest.current?.abort();
    eqAudio.current?.pause();
    stopPicture();
    if (previewUrl.current) { URL.revokeObjectURL(previewUrl.current); previewUrl.current = ''; }
  }
  useEffect(() => {
    stopEQPreview();
    setPreviewBusy(false);
    movie.current?.pause();
    previewing.current = false;
    return stopEQPreview;
  }, [eq, start, end]);

  // Choosing a take selects it and plays it. This runs after the effect above, which stops
  // whatever was playing when the selection changed.
  useEffect(() => {
    if (!playAfterSelect.current) return;
    playAfterSelect.current = false;
    void previewSelection();
  }, [start, end]);

  function chooseTake(take: Take) {
    playAfterSelect.current = true;
    if (take.start === start && take.end === end) {
      playAfterSelect.current = false;
      void previewSelection();
      return;
    }
    setStart(Number(take.start.toFixed(2)));
    setEnd(Number(take.end.toFixed(2)));
  }

  function stopPreview() {
    stopEQPreview();
    setPreviewBusy(false);
    movie.current?.pause();
    previewing.current = false;
  }

  async function previewSelection() {
    if (!movie.current || !valid || busy) return;
    stopEQPreview();
    movie.current.pause();
    setPreviewBusy(false);
    setError('');
    if (!eq.enabled) {
      movie.current.currentTime = start;
      setCurrentTime(start);
      previewing.current = true;
      void movie.current.play().catch(() => {
        previewing.current = false;
        setError('Unable to play the audio preview.');
      });
      return;
    }
    previewing.current = false;
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreviewBusy(true);
    try {
      const blob = await previewCapturedVoice(project.id, start, end, eq, controller.signal);
      if (controller.signal.aborted || !eqAudio.current) return;
      previewUrl.current = URL.createObjectURL(blob);
      eqAudio.current.src = previewUrl.current;
      await eqAudio.current.play();
      if (movie.current) {
        followingEq.current = true;
        movie.current.muted = true;
        movie.current.currentTime = start;
        void movie.current.play().catch(() => stopPicture());
      }
    } catch {
      if (!controller.signal.aborted) setError('Unable to prepare the EQ preview. Try again.');
    } finally { if (!controller.signal.aborted) setPreviewBusy(false); }
  }

  async function capture() {
    stopEQPreview(); setPreviewBusy(false);
    setBusy(true); setError(''); setMessage(''); setSample('');
    movie.current?.pause();
    try {
      const result = await captureMovieVoice(project.id, { name, start_time: start, end_time: end, speaker: speaker || undefined, group_id: groupId, eq });
      setSample(result.profile.sample_audio_url || '');
      setGroupsRefresh(n => n + 1);
      setMessage(`Saved “${result.profile.name}” to voice profiles.${result.assigned_segments ? ` Assigned to ${result.assigned_segments} character lines; generate their dubbing to hear the cloned voice.` : ''}`);
      if (useProjectStore.getState().currentProject?.id === project.id) await loadProject(project.id);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Voice capture failed');
    } finally { setBusy(false); }
  }

  if (!project.video_path) return <p className="p-4 text-sm text-zinc-400">Upload a movie to capture a character’s voice.</p>;

  const stepClass = 'flex items-center gap-2 text-xs font-semibold tracking-wide uppercase text-zinc-300';
  const stepNumber = 'flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent-primary)]/20 text-[10px] font-bold text-[var(--accent-text)]';
  const selectionBadge = (
    <span
      className={`rounded-lg px-2.5 py-1.5 text-[11px] font-semibold tabular-nums border ${
        valid
          ? 'bg-emerald-500/10 border-emerald-400/30 text-emerald-300'
          : 'bg-amber-500/10 border-amber-400/30 text-amber-300'
      }`}
      title="A usable sample is 3 to 30 seconds of one character speaking"
    >
      {Number.isFinite(seconds) ? `${clock(start)} · ${seconds.toFixed(1)}s selected` : 'no selection'}
      {!valid && ' · needs 3–30s'}
    </span>
  );

  return <div className="overflow-y-auto p-5 grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)] gap-6 text-zinc-200">
    <section className="min-w-0 space-y-5">
      {/* ── 1. Find the voice ─────────────────────────────────────────────── */}
      <div className="space-y-3">
        <h2 className={stepClass}><span className={stepNumber}>1</span>Find the voice</h2>
        <p className="text-xs text-zinc-400">
          Pick 3–30 seconds of one character speaking clearly, without music or anyone talking over them.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
          <div className="space-y-2">
            <video ref={movie} controls playsInline preload="metadata" className="w-full max-h-64 rounded-lg bg-black" aria-label="Original movie" src={`/uploads/${project.id}/${encodeURIComponent(project.video_path.split('/').pop() || '')}`}
              onLoadedMetadata={() => { if (movie.current) { movie.current.currentTime = start; setCurrentTime(start); } }}
              onPlay={() => { if (!followingEq.current) { stopEQPreview(); setPreviewBusy(false); } }}
              onError={() => setError('Unable to play the movie.')}
              onTimeUpdate={() => {
                if (!movie.current) return;
                if (followingEq.current) { if (movie.current.currentTime >= end) stopPicture(); return; }
                setCurrentTime(movie.current.currentTime);
                if (previewing.current && movie.current.currentTime >= end) { movie.current.pause(); previewing.current = false; }
              }} />
            <audio ref={eqAudio} onEnded={stopPicture} onTimeUpdate={() => { if (eqAudio.current) setCurrentTime(start + eqAudio.current.currentTime); }} />
            <div className="flex flex-wrap items-center gap-2">
              <button className={`${listenClass} flex items-center gap-1.5`} disabled={busy || !valid || previewBusy} onClick={() => void previewSelection()}>
                <Play className="w-3 h-3" />
                {previewBusy ? 'Preparing…' : eq.enabled ? 'Play with clean-up' : 'Play selection'}
              </button>
              <button className={`${buttonClass} flex items-center gap-1.5`} disabled={busy} onClick={stopPreview}>
                <Square className="w-3 h-3" />Stop
              </button>
              <span className="ml-auto">{selectionBadge}</span>
            </div>
          </div>

          <div className="min-w-0 flex flex-col gap-2">
            <label className="block text-xs space-y-1.5">
              <span className="text-zinc-300">Whose voice?</span>
              <select className={inputClass} value={speaker} disabled={busy || !characters.length}
                onChange={e => { setSpeaker(e.target.value); if (!name || characters.includes(name)) setName(e.target.value); }}>
                <option value="">{characters.length ? 'Choose a character…' : 'No characters yet'}</option>
                {characters.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            {!characters.length ? (
              <p className="text-[11px] text-zinc-500">
                Once the video has captions, each character’s clearest lines are listed here to pick from.
                Until then, find the moment on the waveform below.
              </p>
            ) : !speaker ? (
              <p className="text-[11px] text-zinc-500">Choose a character to see their clearest lines. Click one to select and hear it.</p>
            ) : !takes.length ? (
              <p className="text-[11px] text-amber-300/90">No line of this character is long enough on its own. Find a moment on the waveform below.</p>
            ) : (
              <ul className="max-h-56 overflow-y-auto rounded-lg border border-[var(--s6)] divide-y divide-[var(--s4)] bg-[var(--s3)]">
                {takes.map((take, i) => {
                  const chosen = Math.abs(take.start - start) < 0.02 && Math.abs(take.end - end) < 0.02;
                  return (
                    <li key={`${take.start}-${take.end}`}>
                      <button
                        disabled={busy}
                        onClick={() => chooseTake(take)}
                        aria-pressed={chosen}
                        className={`w-full text-left px-2.5 py-2 flex items-start gap-2 transition-colors disabled:opacity-50 ${
                          chosen ? 'bg-[var(--accent-primary)]/15' : 'hover:bg-[var(--s4)]'
                        }`}
                      >
                        <Play className={`w-3 h-3 mt-0.5 shrink-0 ${chosen ? 'text-[var(--accent-text)]' : 'text-zinc-500'}`} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs text-zinc-100 font-khmer line-clamp-2">{take.text}</span>
                          <span className="flex flex-wrap items-center gap-x-2 text-[10px] text-zinc-500 tabular-nums mt-0.5">
                            <span>{clock(take.start)} · {(take.end - take.start).toFixed(1)}s</span>
                            {i === 0 && take.clean && <span className="text-emerald-300">Best match</span>}
                            {!take.clean && <span className="text-amber-300/90">someone else speaks here too</span>}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-[var(--s6)]">
          <button
            onClick={() => setShowWaveform(v => !v)}
            aria-expanded={showWaveform}
            className="w-full flex items-center justify-between px-3 py-2 text-xs text-zinc-300 hover:text-white"
          >
            <span>Adjust the selection by hand</span>
            <ChevronDown className={`w-4 h-4 transition-transform ${showWaveform ? 'rotate-180' : ''}`} />
          </button>
          {showWaveform && (
            <div className="px-3 pb-3 space-y-3">
              <VoiceWaveform projectId={project.id} duration={project.duration} currentTime={currentTime} start={start} end={end} disabled={busy}
                onPreview={previewSelection}
                onRangeChange={(nextStart, nextEnd) => {
                  movie.current?.pause();
                  previewing.current = false;
                  setStart(nextStart); setEnd(nextEnd);
                }}
                onSeek={time => { stopEQPreview(); setPreviewBusy(false); if (movie.current) { previewing.current = false; movie.current.currentTime = time; setCurrentTime(time); } }} />
              <fieldset disabled={busy} className="grid grid-cols-2 gap-3">
                <label className="text-xs space-y-1.5 block">Start (seconds)
                  <span className="flex gap-2">
                    <input className={inputClass} type="number" min={0} max={project.duration} step="0.1" value={start} onChange={e => setStart(e.target.valueAsNumber)} />
                    <button className={`${buttonClass} shrink-0`} title="Use the video’s current position as the start" onClick={() => setStart(Number((movie.current?.currentTime || 0).toFixed(2)))}>Set here</button>
                  </span>
                </label>
                <label className="text-xs space-y-1.5 block">End (seconds)
                  <span className="flex gap-2">
                    <input className={inputClass} type="number" min={0} max={project.duration} step="0.1" value={end} onChange={e => setEnd(e.target.valueAsNumber)} />
                    <button className={`${buttonClass} shrink-0`} title="Use the video’s current position as the end" onClick={() => setEnd(Number((movie.current?.currentTime || 0).toFixed(2)))}>Set here</button>
                  </span>
                </label>
              </fieldset>
            </div>
          )}
        </div>
      </div>

      {/* ── 2. Clean it up (optional) ─────────────────────────────────────── */}
      <div className="space-y-3">
        <button onClick={() => setShowEq(v => !v)} aria-expanded={showEq} className="w-full flex items-center justify-between text-left">
          <h2 className={stepClass}>
            <span className={stepNumber}>2</span>Clean it up
            <span className="normal-case tracking-normal font-normal text-zinc-500">
              optional{eq.enabled ? ' · on' : ''}
            </span>
          </h2>
          <ChevronDown className={`w-4 h-4 text-zinc-400 transition-transform ${showEq ? 'rotate-180' : ''}`} />
        </button>
        {showEq && <VoiceEQPanel value={eq} onChange={setEq} disabled={busy} />}
      </div>
    </section>

    {/* ── 3. Save the voice ───────────────────────────────────────────────── */}
    <aside className="space-y-4 lg:border-l lg:border-[var(--s5)] lg:pl-5">
      <h2 className={stepClass}><span className={stepNumber}>3</span>Save the voice</h2>
      <fieldset disabled={busy} className="space-y-4">
        <label className="block text-xs space-y-1.5">Voice name<input className={inputClass} value={name} maxLength={100} placeholder="Character voice" onChange={e => setName(e.target.value)} /></label>
        <label className="block text-xs space-y-1.5">Use it for
          <select className={inputClass} value={speaker} onChange={e => { setSpeaker(e.target.value); if (!name || characters.includes(name)) setName(e.target.value); }}>
            <option value="">Nobody yet — just save the voice</option>{characters.map(c => <option key={c} value={c}>{c}’s lines</option>)}
          </select>
        </label>
        {speaker && <p className="text-[11px] text-zinc-400">This character’s existing dubbed audio is cleared so it can be regenerated in the new voice.</p>}
      </fieldset>
      <VoiceGroups selected={groupId} onSelect={setGroupId} refresh={groupsRefresh} disabled={busy} />
      <div className="space-y-2">
        <div className="flex justify-end">{selectionBadge}</div>
        <button
          className="w-full rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-900/30 disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none transition-colors"
          disabled={busy || !valid || !name.trim()}
          title={!valid ? 'Select 3–30 seconds first' : !name.trim() ? 'Give the voice a name first' : 'Save this as a reusable voice'}
          onClick={() => void capture()}
        >{busy ? 'Capturing…' : 'Capture & save voice'}</button>
        {!busy && (!valid || !name.trim()) && (
          <p className="text-[11px] text-zinc-500">
            {!valid ? 'Select 3–30 seconds of one character speaking.' : 'Give the voice a name to save it.'}
          </p>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {message && <p role="status" className="text-sm text-green-400">{message}</p>}
      {sample && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-zinc-400">The saved sample:</p>
          <audio controls src={sample} className="w-full" />
        </div>
      )}
    </aside>
  </div>;
}
