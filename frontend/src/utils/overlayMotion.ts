/**
 * Where a text overlay is drawn at a moment in time.
 *
 * This is the same arithmetic the export writes as ffmpeg expressions
 * (backend/services/video_service.py, _overlay_position_exprs), in frame pixels, so the
 * player and the editor preview show exactly what gets rendered. Change one, change both.
 */

export type OverlayEntrance =
  | 'fade' | 'slide_left' | 'slide_right' | 'slide_up' | 'slide_down' | 'zoom' | 'pop'
  | 'marquee_left' | 'marquee_right' | 'drift' | 'bounce' | 'corners';

export type OverlayExit = 'none' | 'slide_left' | 'slide_right' | 'slide_up' | 'slide_down' | 'zoom';

export interface MotionFields {
  start_time: number;
  end_time: number;
  x_pct: number;
  y_pct: number;
  anchor: 'center' | 'left' | 'right';
  opacity?: number;
  fade_seconds: number;
  animation?: OverlayEntrance;
  animation_seconds?: number;
  exit_animation?: OverlayExit;
  exit_seconds?: number;
}

export interface OverlayFrame {
  /** top-left of the text box, in frame pixels, before scaling */
  x: number;
  y: number;
  /** scale about the box centre */
  scale: number;
  opacity: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
// overshoots a little and settles — what makes a "pop"
const easeOutBack = (p: number) => 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2);

/** Resting top-left position: the anchor point, kept inside the frame. */
export function restPosition(o: MotionFields, W: number, H: number, w: number, h: number) {
  const cx = (W * Math.max(0, Math.min(100, o.x_pct))) / 100;
  const px = o.anchor === 'left' ? cx : o.anchor === 'right' ? cx - w : cx - w / 2;
  const py = (H * Math.max(0, Math.min(100, o.y_pct))) / 100 - h / 2;
  return {
    x: Math.max(0, Math.min(W - w, px)),
    y: Math.max(0, Math.min(H - h, py)),
  };
}

/** Overlay scale at time t (1 = full size). */
export function overlayScale(o: MotionFields, t: number): number {
  const anim = o.animation || 'fade';
  const sec = o.animation_seconds || 0;
  let scale = 1;
  if ((anim === 'zoom' || anim === 'pop') && sec > 0.01) {
    const p = clamp01((t - o.start_time) / sec);
    scale = anim === 'zoom' ? 0.6 + 0.4 * easeOut(p) : 0.3 + 0.7 * easeOutBack(p);
  }
  const exit = o.exit_animation || 'none';
  const xs = o.exit_seconds || 0;
  if (exit === 'zoom' && xs > 0.01) {
    const k = clamp01((t - (o.end_time - xs)) / xs);
    scale *= 1 - 0.7 * k * k * k;
  }
  return scale;
}

export function overlayFrame(o: MotionFields, t: number, W: number, H: number, w: number, h: number): OverlayFrame {
  const rest = restPosition(o, W, H, w, h);
  const X = rest.x;
  const Y = rest.y;
  const e = t - o.start_time;
  const sec = o.animation_seconds || 0;
  const anim = o.animation || 'fade';
  let x = X;
  let y = Y;

  if (sec > 0.01) {
    const travel = 1 - easeOut(clamp01(e / sec));
    const mod = (a: number, b: number) => ((a % b) + b) % b;
    switch (anim) {
      case 'slide_left': x = X + (W - X) * travel; break;          // in from the right edge
      case 'slide_right': x = X - (X + w) * travel; break;         // from the left edge
      case 'slide_up': y = Y + (H - Y) * travel; break;            // from the bottom
      case 'slide_down': y = Y - (Y + h) * travel; break;          // from the top
      case 'marquee_left': x = W - mod((e * (W + w)) / sec, W + w); break;
      case 'marquee_right': x = -w + mod((e * (W + w)) / sec, W + w); break;
      case 'drift': {
        const period = Math.max(4, sec * 8);
        x = X + W * 0.02 * Math.sin((2 * Math.PI * e) / period);
        y = Y + H * 0.02 * Math.sin((2 * Math.PI * e) / (period * 1.37));
        break;
      }
      case 'bounce': {
        const px = Math.max(1, sec * 6);
        const py = px * 1.31;
        const fx = W - w;
        const fy = H - h;
        x = fx > 0 ? Math.abs(mod((e * fx) / px, 2 * fx) - fx) : 0;
        y = fy > 0 ? Math.abs(mod((e * fy) / py, 2 * fy) - fy) : 0;
        break;
      }
      case 'corners': {
        const hold = Math.max(1, sec * 4);
        const step = Math.floor(e / hold) % 4;
        const padX = W * 0.06;
        const padY = H * 0.06;
        x = step === 0 || step === 3 ? padX : W - w - padX;
        y = step <= 1 ? padY : H - h - padY;
        break;
      }
    }
  }

  // Leaving: the last exit_seconds, accelerating away (ease-in)
  const exit = o.exit_animation || 'none';
  const xs = o.exit_seconds || 0;
  if (exit !== 'none' && exit !== 'zoom' && xs > 0.01) {
    const k = clamp01((t - (o.end_time - xs)) / xs);
    const kk = k * k * k;
    if (exit === 'slide_left') x -= (x + w) * kk;
    else if (exit === 'slide_right') x += (W - x) * kk;
    else if (exit === 'slide_up') y -= (y + h) * kk;
    else if (exit === 'slide_down') y += (H - y) * kk;
  }

  const fade = o.fade_seconds || 0;
  const into = t - o.start_time;
  const left = o.end_time - t;
  const span = Math.max(0.05, o.end_time - o.start_time);
  const f = Math.min(fade, span / 2);
  const alpha = f > 0.01 ? clamp01(Math.min(into, left) / f) : 1;

  return { x, y, scale: overlayScale(o, t), opacity: alpha * (o.opacity ?? 1) };
}
