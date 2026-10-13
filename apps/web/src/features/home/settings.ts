import { useSyncExternalStore } from 'react';
import { currentUserId } from '../glance/user';

// The Home page's arrangement (docs/prd/glance-widgets.md §18): which cards show and in what order. A preference of one person on one
// device, like the glance settings (§7): localStorage under the user's id, kept in step across tabs, nothing sent to the portal.

export interface HomeSettings {
  /** Card ids in the person's order. Ids not listed follow in the default order, so a new card shows up without a reset. */
  order: string[];
  /** Cards the person hid. */
  hidden: string[];
}

/** What the page opens with: what needs a person first, then what runs, what is left, and the rest. */
export const HOME_DEFAULT_ORDER: readonly string[] = ['attention', 'sessions', 'quota', 'workspaces', 'tickets', 'ci', 'usage'];

export const DEFAULT_HOME: HomeSettings = { order: [], hidden: [] };

export const homeKey = (userId: string): string => `claudepilot.home.${userId}`;

const ids = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 40))].slice(0, 40) : []);

/** Whatever was stored, made into settings; never throws. */
export function cleanHome(raw: unknown): HomeSettings {
  const r = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { order: ids(r.order), hidden: ids(r.hidden) };
}

/**
 * The cards in the person's order: the ones they placed, then the rest in the default order (a card the default order does not know
 * goes last, in the order given); hidden ones left out unless asked (the Arrange list shows them, switched off).
 */
export function orderCards<T extends { id: string }>(cards: readonly T[], s: HomeSettings, includeHidden = false): T[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const rank = (id: string) => {
    const i = HOME_DEFAULT_ORDER.indexOf(id);
    return i < 0 ? HOME_DEFAULT_ORDER.length : i;
  };
  const placed = s.order.map((id) => byId.get(id)).filter((c): c is T => !!c);
  const rest = cards.filter((c) => !s.order.includes(c.id)).map((c, i) => ({ c, i })).sort((a, b) => rank(a.c.id) - rank(b.c.id) || a.i - b.i).map((x) => x.c);
  return [...placed, ...rest].filter((c) => includeHidden || !s.hidden.includes(c.id));
}

let state: HomeSettings | null = null;
const listeners = new Set<() => void>();
let watching = false;

function read(): HomeSettings {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(homeKey(currentUserId()));
    return cleanHome(raw ? JSON.parse(raw) : null);
  } catch {
    return cleanHome(null);
  }
}

export const getHomeSettings = (): HomeSettings => (state ??= read());

export function updateHomeSettings(patch: Partial<HomeSettings>): void {
  state = cleanHome({ ...getHomeSettings(), ...patch });
  try {
    localStorage.setItem(homeKey(currentUserId()), JSON.stringify(state));
  } catch {
    // private window or storage blocked: it holds until the tab closes
  }
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  if (!watching && typeof window !== 'undefined') {
    watching = true;
    window.addEventListener('storage', (e) => {
      if (e.key !== homeKey(currentUserId()) && e.key !== null) return;
      state = read();
      listeners.forEach((l) => l());
    });
  }
  return () => void listeners.delete(fn);
}

export function useHomeSettings(): HomeSettings {
  return useSyncExternalStore(subscribe, getHomeSettings, () => DEFAULT_HOME);
}

export const resetHomeSettings = () => updateHomeSettings(DEFAULT_HOME);
