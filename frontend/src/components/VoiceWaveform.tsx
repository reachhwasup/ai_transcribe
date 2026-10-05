import { useEffect, useRef, useState } from 'react';
import { fetchVoiceWaveform } from '../api/client';

export default function VoiceWaveform({ projectId, duration, currentTime, start, end, onSeek, onRangeChange, onPreview, disabled }: {
  projectId: string; duration: number; currentTime: number; start: number; end: number;
  onSeek: (time: number) => void; onRangeChange: (start: number, end: number) => void;
  onPreview: () => void; disabled: boolean;
}) {
  const drag = useRef<{ x: number; start: number; end: number; secondsPerPixel: number; moved: boolean; mode: 'move' | 'start' | 'end' } | null>(null);
  const overviewElement = useRef<HTMLDivElement>(null);
  const overviewDrag = useRef<{ x: number; start: number; secondsPerPixel: number } | null>(null);
  const navigationTime = useRef(start);
  const movable = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= duration;
  function moveRange(originalStart: number, originalEnd: number, delta: number) {
    const length = originalEnd - originalStart;
    const nextStart = Math.max(0, Math.min(duration - length, Math.round((originalStart + delta) * 100) / 100));
    onRangeChange(nextStart, nextStart + length);
  }
  const [windowStart, setWindowStart] = useState(Math.max(0, start - 5));
  const [retry, setRetry] = useState(0);
  const [overview, setOverview] = useState<number[]>([]);
  const [overviewError, setOverviewError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setOverviewError('');
    fetchVoiceWaveform(projectId, 0, controller.signal, true).then(result => {
      if (!controller.signal.aborted) setOverview(result.peaks);
    }).catch(() => { if (!controller.signal.aborted) setOverviewError('Full waveform unavailable. Retry to reload.'); });
    return () => controller.abort();
  }, [projectId, retry]);
  function jumpTo(time: number) {
    const length = movable ? end - start : Math.min(10, duration);
    const nextStart = Math.max(0, Math.min(duration - length, time));
    navigationTime.current = nextStart;
    onRangeChange(nextStart, nextStart + length);
    onSeek(nextStart);
    setWindowStart(Math.max(0, Math.min(duration - 60, nextStart - 15)));
  }
  useEffect(() => { navigationTime.current = Number.isFinite(start) ? start : 0; }, [start]);
  useEffect(() => {
    const element = overviewElement.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      if (disabled || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const pixels = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1);
      // A viewport-width swipe moves one minute, for controlled navigation.
      jumpTo(navigationTime.current + pixels * 60 / Math.max(1, element.clientWidth));
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [disabled, duration, start, end, onRangeChange, onSeek]);
  const [data, setData] = useState<{ duration: number; peaks: number[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError('');
    const timer = window.setTimeout(() => {
      fetchVoiceWaveform(projectId, windowStart, controller.signal).then(result => {
        if (!controller.signal.aborted) setData(result);
      }).catch(() => {
        if (!controller.signal.aborted) setError('Waveform unavailable. You can still listen and mark the audio range.');
      });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [projectId, windowStart, retry]);
  const span = data?.duration || Math.min(60, duration - windowStart);
  const percent = (time: number) => Math.max(0, Math.min(100, (time - windowStart) / span * 100));
  const left = Number.isFinite(start) ? percent(start) : 0;
  const right = Number.isFinite(end) ? percent(end) : 0;
  const scale = Math.max(0.01, ...(data?.peaks || []));
  const stamp = (t: number) => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`;
  const overviewScale = Math.max(0.01, ...overview);
  return <div className="rounded-lg border border-[var(--s6)] bg-zinc-950 p-3 space-y-2">
    <div className="flex justify-between text-xs text-zinc-400"><span>Full movie · drag, swipe or scroll to navigate</span><span>{stamp(duration)}</span></div>
    <div ref={overviewElement} role="slider" tabIndex={disabled ? -1 : 0} aria-label="Full movie position" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={Number.isFinite(start) ? start : 0} aria-disabled={disabled}
      onKeyDown={e => { if (!disabled && ['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); jumpTo((Number.isFinite(start) ? start : 0) + (e.key === 'ArrowLeft' ? -30 : 30)); } }}
      onPointerDown={e => {
        if (disabled || e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        const rect = e.currentTarget.getBoundingClientRect();
        const time = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * duration;
        // Preserve the grab position when dragging the highlighted window.
        if (time < windowStart || time > windowStart + span) jumpTo(time);
        overviewDrag.current = { x: e.clientX, start: navigationTime.current, secondsPerPixel: duration / Math.max(1, rect.width) };
      }}
      onPointerMove={e => {
        const state = overviewDrag.current;
        if (disabled || !state || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
        jumpTo(state.start + (e.clientX - state.x) * state.secondsPerPixel);
      }}
      onPointerUp={e => {
        overviewDrag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => { overviewDrag.current = null; }}
      onLostPointerCapture={() => { overviewDrag.current = null; }}
      className="relative h-20 rounded-lg bg-[var(--s3)] overflow-hidden cursor-grab active:cursor-grabbing touch-none select-none focus:outline focus:outline-purple-400">
      <svg viewBox="0 0 1200 80" preserveAspectRatio="none" className="w-full h-full" aria-hidden="true">
        {overview.map((p, i) => <line key={i} x1={i} x2={i} y1={40 - Math.max(0.5, p / overviewScale * 34)} y2={40 + Math.max(0.5, p / overviewScale * 34)} stroke="#71717a" strokeWidth="0.8" />)}
      </svg>
      <div className="absolute inset-y-0 border border-purple-400 bg-purple-400/15 pointer-events-none" style={{ left: `${windowStart / duration * 100}%`, width: `${span / duration * 100}%` }} />
      {movable && <div className="absolute inset-y-0 bg-emerald-400/80 min-w-[2px] pointer-events-none" style={{ left: `${start / duration * 100}%`, width: `${(end - start) / duration * 100}%` }} />}
      {!overview.length && <p role="status" className="absolute inset-0 flex items-center justify-center text-xs text-zinc-400 pointer-events-none">{overviewError || 'Building full movie waveform… You can already click to navigate.'}</p>}
    </div>
    <div className="flex justify-between text-[10px] text-zinc-500">{[0, 0.25, 0.5, 0.75, 1].map(f => <span key={f}>{stamp(duration * f)}</span>)}</div>
    <div className="flex items-center justify-between text-xs text-zinc-400"><span>Zoomed audio · {stamp(windowStart)}–{stamp(windowStart + span)}</span><span>{Number.isFinite(end - start) ? (end - start).toFixed(1) : '0'}s selected</span></div>
    <div role="slider" aria-label="Audio waveform playhead" aria-valuemin={windowStart} aria-valuemax={windowStart + span} aria-valuenow={Math.max(windowStart, Math.min(windowStart + span, currentTime))} aria-disabled={disabled} tabIndex={disabled ? -1 : 0}
      onKeyDown={e => { if (!disabled && ['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); onSeek(Math.max(windowStart, Math.min(windowStart + span, currentTime + (e.key === 'ArrowLeft' ? -0.1 : 0.1)))); } }}
      onPointerDown={e => { if (!disabled) { e.currentTarget.setPointerCapture(e.pointerId); const rect = e.currentTarget.getBoundingClientRect(); onSeek(windowStart + Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * span); } }}
      onPointerMove={e => { if (!disabled && e.currentTarget.hasPointerCapture(e.pointerId)) { const rect = e.currentTarget.getBoundingClientRect(); onSeek(windowStart + Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * span); } }}
      className="relative h-44 cursor-crosshair touch-none overflow-hidden rounded bg-[var(--s3)] focus:outline focus:outline-purple-400">
      <div className="absolute inset-y-0 bg-purple-500/20 border-x border-purple-400" style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }} />
      {data ? <svg className="absolute inset-0 w-full h-full" viewBox="0 0 600 100" preserveAspectRatio="none" aria-hidden="true">
        {data.peaks.map((peak, i) => <line key={i} x1={i} x2={i} y1={50 - Math.max(0.5, peak / scale * 43)} y2={50 + Math.max(0.5, peak / scale * 43)} stroke={windowStart + i / 600 * span >= start && windowStart + i / 600 * span <= end ? '#c084fc' : '#71717a'} strokeWidth="0.7" />)}
      </svg> : <p className="absolute inset-0 flex items-center justify-center p-3 text-xs text-zinc-400" role="status">{error || 'Loading audio waveform…'}</p>}
      {movable && right > left && <button
        type="button" disabled={disabled} aria-label="Capture range: drag left or right to move, click to preview"
        title="Drag to move selection · Click to listen · Arrow keys to shift"
        className="absolute inset-y-0 z-10 cursor-grab active:cursor-grabbing touch-none border-x-2 border-purple-300 hover:bg-purple-400/10 focus:outline focus:outline-purple-300 disabled:cursor-not-allowed"
        style={{ left: `${left}%`, width: `${right - left}%` }}
        onPointerDown={e => {
          e.stopPropagation();
          if (disabled || e.button !== 0) return;
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          const width = e.currentTarget.parentElement!.getBoundingClientRect().width;
          const rect = e.currentTarget.getBoundingClientRect();
          const mode = e.clientX - rect.left < 8 && start >= windowStart ? 'start' : rect.right - e.clientX < 8 && end <= windowStart + span ? 'end' : 'move';
          drag.current = { x: e.clientX, start, end, secondsPerPixel: span / width, moved: false, mode };
        }}
        onPointerMove={e => {
          e.stopPropagation();
          const state = drag.current;
          if (disabled || !state || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
          const delta = e.clientX - state.x;
          if (Math.abs(delta) >= 4) state.moved = true;
          if (state.moved) {
            const seconds = delta * state.secondsPerPixel;
            if (state.mode === 'start') onRangeChange(Math.max(0, state.end - 30, Math.min(state.end - 3, state.start + seconds)), state.end);
            else if (state.mode === 'end') onRangeChange(state.start, Math.min(duration, state.start + 30, Math.max(state.start + 3, state.end + seconds)));
            else moveRange(state.start, state.end, seconds);
          }
        }}
        onPointerUp={e => {
          e.stopPropagation();
          const state = drag.current;
          drag.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          if (!disabled && state && !state.moved) onPreview();
        }}
        onPointerCancel={() => { drag.current = null; }}
        onLostPointerCapture={() => { drag.current = null; }}
        onClick={e => { e.stopPropagation(); if (e.detail === 0 && !disabled) onPreview(); }}
        onKeyDown={e => {
          e.stopPropagation();
          if (!disabled && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            moveRange(start, end, (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 0.1));
          }
        }}
      ><span className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-purple-400/20" /><span className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-purple-400/20" /><span className="absolute top-1 left-1/2 -translate-x-1/2 text-[10px] text-purple-200 bg-zinc-950/70 rounded px-1 pointer-events-none">↔</span></button>}
      {currentTime >= windowStart && currentTime <= windowStart + span && <div className="absolute inset-y-0 w-px bg-white pointer-events-none z-20" style={{ left: `${percent(currentTime)}%` }} />}
    </div>
    <div className="flex justify-between text-[10px] font-mono text-zinc-500"><span>{stamp(windowStart)}</span><span>{stamp(windowStart + span)}</span></div>
    <p className="text-[11px] text-zinc-400">Drag the purple range to move; drag its edges to resize. Click it to listen. Use arrow keys for fine adjustment.</p>
    <div className="flex gap-2 text-xs">
      <button disabled={disabled || windowStart <= 0} className="disabled:opacity-40" onClick={() => setWindowStart(Math.max(0, windowStart - 45))}>← Earlier</button>
      <button disabled={disabled} className="mx-auto text-purple-300" onClick={() => setWindowStart(Math.max(0, Math.min(duration - 1, currentTime - 5)))}>Show playhead</button>
      <button disabled={disabled || windowStart + span >= duration} className="disabled:opacity-40" onClick={() => setWindowStart(Math.min(duration - 1, windowStart + 45))}>Later →</button>
      <button disabled={disabled || !movable} className="text-purple-300 disabled:opacity-40" onClick={() => setWindowStart(Math.max(0, start - 5))}>Show selection</button>
      {(error || overviewError) && <button onClick={() => setRetry(retry + 1)}>Retry</button>}
    </div>
  </div>;
}
