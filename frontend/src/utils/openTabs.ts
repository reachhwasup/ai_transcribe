/** The open project tabs, shared between the tab bar and anything that opens tabs for you.
 *
 * The tab bar holds these in React state; this module is the one place that touches
 * localStorage, and it fires an event so the bar re-reads after someone else changes them.
 */
export interface TabItem {
  id: string;
  name: string;
}

const STORAGE_KEY = 'meatika_open_tabs';
export const TABS_CHANGED_EVENT = 'meatika:tabs-changed';

export function readTabs(): TabItem[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeTabs(tabs: TabItem[], notify = true): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
  } catch {
    /* private browsing or full storage — tabs just won't persist */
  }
  if (notify) window.dispatchEvent(new CustomEvent(TABS_CHANGED_EVENT));
}

/** Append tabs that aren't open yet, keeping the existing order. */
export function openTabs(items: TabItem[]): TabItem[] {
  const current = readTabs();
  const known = new Set(current.map((t) => t.id));
  const merged = [...current, ...items.filter((t) => !known.has(t.id))];
  writeTabs(merged);
  return merged;
}

/** Close one tab. Returns the tabs that remain. */
export function closeTab(id: string): TabItem[] {
  const remaining = readTabs().filter((t) => t.id !== id);
  writeTabs(remaining);
  return remaining;
}
