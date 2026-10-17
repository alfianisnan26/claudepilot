import type { AppTarget } from './appAddress';

/**
 * The App mode's tabs (T-948). A frame on another origin can't be read, so each tab keeps its own history of what was typed (`entries`,
 * `index`): back and forward use it when the frame's own history can't be reached. `src` is the one-time URL the frame loads; `nonce`
 * changes to remount the frame (a reload re-opens through the route, because the code is single use).
 */
export interface AppTab {
  id: number;
  entries: AppTarget[];
  index: number;
  src: string | null;
  nonce: number;
  /** Which request to the open route may still answer (see `beginLoad`). */
  seq: number;
  state: 'loading' | 'ready' | 'error';
  error: string | null;
}

export interface AppTabs {
  tabs: AppTab[];
  active: number | null;
  nextId: number;
}

export const emptyTabs = (): AppTabs => ({ tabs: [], active: null, nextId: 1 });

export const currentTarget = (t: AppTab): AppTarget => t.entries[t.index]!;

const patch = (s: AppTabs, id: number, f: (t: AppTab) => AppTab): AppTabs => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? f(t) : t)) });

export function openTab(s: AppTabs, target: AppTarget): AppTabs {
  const tab: AppTab = { id: s.nextId, entries: [target], index: 0, src: null, nonce: 0, seq: 0, state: 'loading', error: null };
  return { tabs: [...s.tabs, tab], active: tab.id, nextId: s.nextId + 1 };
}

export function closeTab(s: AppTabs, id: number): AppTabs {
  const i = s.tabs.findIndex((t) => t.id === id);
  if (i < 0) return s;
  const tabs = s.tabs.filter((t) => t.id !== id);
  // The one that closes was in front: the neighbour on its right takes over, else the one on its left.
  const active = s.active !== id ? s.active : (tabs[i] ?? tabs[i - 1])?.id ?? null;
  return { ...s, tabs, active };
}

export function switchTab(s: AppTabs, id: number): AppTabs {
  return s.tabs.some((t) => t.id === id) ? { ...s, active: id } : s;
}

/** A new address typed in a tab: forward entries are dropped, the same address twice in a row is one entry. */
export function navigate(s: AppTabs, id: number, target: AppTarget): AppTabs {
  return patch(s, id, (t) => {
    const cur = currentTarget(t);
    const same = cur.port === target.port && cur.path === target.path;
    const entries = same ? t.entries : [...t.entries.slice(0, t.index + 1), target];
    return { ...t, entries, index: entries.length - 1, state: 'loading', error: null };
  });
}

export const canGoBack = (t: AppTab): boolean => t.index > 0;
export const canGoForward = (t: AppTab): boolean => t.index < t.entries.length - 1;

/** The own-history step (the fallback): moves the index; the caller re-opens the tab through the route. */
export function step(s: AppTabs, id: number, dir: 'back' | 'forward'): AppTabs {
  return patch(s, id, (t) => {
    const index = dir === 'back' ? t.index - 1 : t.index + 1;
    return index < 0 || index >= t.entries.length ? t : { ...t, index, state: 'loading', error: null };
  });
}

/**
 * A request to the open route starts (a reload, a retry, a new address): the tab's sequence moves on and the caller keeps the number.
 * Only the answer that carries the latest number is applied, so two quick opens can't race: the last wins, the stale result is dropped.
 */
export const beginLoad = (s: AppTabs, id: number): AppTabs => patch(s, id, (t) => ({ ...t, seq: t.seq + 1, state: 'loading', error: null }));

export const seqOf = (s: AppTabs, id: number): number | null => s.tabs.find((t) => t.id === id)?.seq ?? null;

/** The route answered: the frame loads `src` (a new mount, so the same URL twice still loads). A stale answer changes nothing. */
export const setSrc = (s: AppTabs, id: number, seq: number, src: string): AppTabs => patch(s, id, (t) => (t.seq !== seq ? t : { ...t, src, nonce: t.nonce + 1, state: 'ready', error: null }));

export const setError = (s: AppTabs, id: number, seq: number, error: string): AppTabs => patch(s, id, (t) => (t.seq !== seq ? t : { ...t, state: 'error', error }));

/** Where the frame's own history is tried first. A cross-origin frame throws on `history`: false, and the caller steps its own entries. */
export function nativeHistory(win: { history: { back(): void; forward(): void } } | null | undefined, dir: 'back' | 'forward'): boolean {
  try {
    if (!win) return false;
    if (dir === 'back') win.history.back();
    else win.history.forward();
    return true;
  } catch {
    return false;
  }
}
