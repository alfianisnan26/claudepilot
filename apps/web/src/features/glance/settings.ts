import { USAGE_THRESHOLDS } from '@portal/contracts';
import { useSyncExternalStore } from 'react';
import { GLANCE_PLACEMENTS, type GlancePlacement } from './types';
import { currentUserId, glanceKey } from './user';

// Glance settings (PRD glance-widgets §7): which widgets show and in what order, which places draw them, Quota's mode and its
// colour thresholds. They are preferences of one person on one device (a phone and a laptop each keep their own) and nothing is
// sent to the portal. Stored in localStorage under the user's id (see user.ts), which can be unavailable: then they simply are
// not remembered.

export interface GlanceSettings {
  /** Widget ids in the person's order. Ids not listed follow in registry order, so a new widget shows up without a reset. */
  order: string[];
  /** Widgets the person switched off. */
  hidden: string[];
  /** The places that draw widgets. */
  places: Record<GlancePlacement, boolean>;
  /** Quota: the active Claude only, or every Claude (the chip then shows the one with the least left). */
  quotaMode: 'active' | 'all';
  /** Percent of a plan window used at and above which Quota reads warn and critical (default: the portal's alert levels). */
  thresholds: { warn: number; critical: number };
  /** The dock shows every widget's full form in a panel, instead of a rail of chips. */
  dockOpen: boolean;
  /** The installed app's icon shows the needs-attention count (where the platform has badges). */
  appBadge: boolean;
}

export const DEFAULT_SETTINGS: GlanceSettings = {
  order: [],
  hidden: [],
  // The dock takes the right edge of every page, so it is a choice; the others are quiet by nature.
  places: { header: true, dock: false, list: true, composer: true },
  quotaMode: 'active',
  thresholds: { warn: USAGE_THRESHOLDS.warn, critical: USAGE_THRESHOLDS.critical },
  dockOpen: false,
  appBadge: true,
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ids = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 40))].slice(0, 40) : []);

/** The thresholds as whole percents with 1 <= warn < critical <= 100; anything else is the default pair. */
export function cleanThresholds(v: unknown): GlanceSettings['thresholds'] {
  const t = isRecord(v) ? v : {};
  const warn = Number(t.warn);
  const critical = Number(t.critical);
  const whole = (n: number) => Number.isInteger(n) && n >= 1 && n <= 100;
  return whole(warn) && whole(critical) && warn < critical ? { warn, critical } : { ...DEFAULT_SETTINGS.thresholds };
}

/** Whatever was stored, made into settings: unknown or malformed fields fall back to their default, never throw. */
export function cleanSettings(raw: unknown): GlanceSettings {
  const r = isRecord(raw) ? raw : {};
  const places = isRecord(r.places) ? r.places : {};
  return {
    order: ids(r.order),
    hidden: ids(r.hidden),
    places: Object.fromEntries(GLANCE_PLACEMENTS.map((p) => [p, typeof places[p] === 'boolean' ? places[p] : DEFAULT_SETTINGS.places[p]])) as Record<GlancePlacement, boolean>,
    quotaMode: r.quotaMode === 'all' ? 'all' : 'active',
    thresholds: cleanThresholds(r.thresholds),
    dockOpen: r.dockOpen === true,
    appBadge: r.appBadge !== false,
  };
}

/** The widgets in the person's order (registry order for any they have not placed), without the ones they switched off unless asked. */
export function orderWidgets<T extends { id: string }>(widgets: readonly T[], s: Pick<GlanceSettings, 'order' | 'hidden'>, includeHidden = false): T[] {
  const byId = new Map(widgets.map((w) => [w.id, w]));
  const placed = s.order.map((id) => byId.get(id)).filter((w): w is T => !!w);
  const rest = widgets.filter((w) => !s.order.includes(w.id));
  return [...placed, ...rest].filter((w) => includeHidden || !s.hidden.includes(w.id));
}

/** The order after moving `id` one place up (-1) or down (+1) among `allIds` as they show now; the same order at either end. */
export function moveInOrder(allIds: readonly string[], id: string, dir: -1 | 1): string[] {
  const at = allIds.indexOf(id);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= allIds.length) return [...allIds];
  const next = [...allIds];
  [next[at], next[to]] = [next[to]!, next[at]!];
  return next;
}

// The store: one copy for every strip, dock and Settings row, kept in step across tabs by the `storage` event.

let state: GlanceSettings | null = null;
const listeners = new Set<() => void>();
let watching = false;

function read(): GlanceSettings {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(glanceKey(currentUserId()));
    return cleanSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return cleanSettings(null);
  }
}

export function getGlanceSettings(): GlanceSettings {
  return (state ??= read());
}

/** Changes some settings (and remembers them on this device when the browser lets it). */
export function updateGlanceSettings(patch: Partial<GlanceSettings>): void {
  state = cleanSettings({ ...getGlanceSettings(), ...patch });
  try {
    localStorage.setItem(glanceKey(currentUserId()), JSON.stringify(state));
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
      if (e.key !== glanceKey(currentUserId()) && e.key !== null) return;
      state = read();
      listeners.forEach((l) => l());
    });
  }
  return () => void listeners.delete(fn);
}

export function useGlanceSettings(): GlanceSettings {
  return useSyncExternalStore(subscribe, getGlanceSettings, () => DEFAULT_SETTINGS);
}

/** Back to the defaults (Settings: Reset). */
export const resetGlanceSettings = () => updateGlanceSettings(DEFAULT_SETTINGS);
