/**
 * Short messages in the corner when work starts and when it ends. Each slides in from the
 * right, stays five seconds, and can be swiped back out to the right sooner.
 */
import { create } from 'zustand';

export type ToastTone = 'success' | 'warning' | 'error' | 'info' | 'working';

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  detail?: string;
  /** set while it slides out, so it can animate before it is removed */
  leaving?: boolean;
}

export const TOAST_SECONDS = 5;
/** More than this at once and the oldest make way — a folder of 80 videos would bury the screen */
const MAX_SHOWN = 4;
const SLIDE_MS = 250;

interface ToastState {
  toasts: Toast[];
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), SLIDE_MS);
  },
}));

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function toast(t: Omit<Toast, 'id' | 'leaving'>): string {
  const id = newId();
  useToastStore.setState((s) => {
    const shown = [...s.toasts.filter((x) => !x.leaving), { ...t, id }];
    return { toasts: shown.slice(-MAX_SHOWN) };
  });
  setTimeout(() => useToastStore.getState().dismiss(id), TOAST_SECONDS * 1000);
  return id;
}
