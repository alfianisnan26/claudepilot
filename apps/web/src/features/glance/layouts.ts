// The Home and Glance layouts follow the PERSON (owner decision D-111 D6, 2026-11-01; docs/prd/glance-widgets.md §7, §18): they are saved on
// the server per signed-in user and per org context (`/api/layouts?org=`), not per device. Local storage stays as this device's cache, keyed
// by the user (and the org), so a page draws at once and two people on one browser never read each other's layout.
//
// First load: when the server has no layout for this person and context yet, the device's layout is copied up ONCE per person (the cache of
// this context, else the key from before people were told apart, `claudepilot.<kind>.u_owner`, which is then removed for anyone but the
// founding user so a second person never inherits it). After that, a context with nothing saved starts from the defaults.
//
// The settings stores (glance/settings.ts, home/settings.ts) register here; this module never imports them (no cycle).

import { FOUNDING_USER_ID, LAYOUT_KINDS, type LayoutKind, type Layouts } from '@portal/contracts';

export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** This device's cache of one person's layout in one context ('personal' keeps the key used before contexts: no reset on update). */
export const layoutCacheKey = (kind: LayoutKind, userId: string, context: string): string =>
  context === 'personal' ? `claudepilot.${kind}.${userId}` : `claudepilot.${kind}.${userId}.${context}`;
/** The key every layout had before people were told apart (one constant user). */
export const legacyLayoutKey = (kind: LayoutKind): string => `claudepilot.${kind}.${FOUNDING_USER_ID}`;
/** Set once the device's layouts were copied up for this person. */
export const migratedKey = (userId: string): string => `claudepilot.layouts.migrated.${userId}`;

const parse = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export interface LayoutPlan {
  /** What the store shows (null: its defaults). */
  value: Record<string, unknown> | null;
  /** Copy `value` up to the server (the one-time migration). */
  upload: boolean;
}

/**
 * What to show for one kind, given the server's answer and this device. Pure: the server wins. With nothing there: in Personal, the device's
 * layout (what every layout was before contexts) goes up once per person (`migrated` false), else the defaults; in an org, this device's cache
 * of it, never copied up (an org's layout starts from the defaults until the person arranges it there).
 */
export function planLayout(
  server: Record<string, unknown> | null,
  local: { cache: Record<string, unknown> | null; legacy: Record<string, unknown> | null },
  migrated: boolean,
  personal: boolean,
): LayoutPlan {
  if (server) return { value: server, upload: false };
  if (!personal) return { value: local.cache, upload: false };
  if (migrated) return { value: null, upload: false };
  const value = local.cache ?? local.legacy;
  return { value, upload: !!value };
}

/** One settings store's hooks: show a layout (null: defaults), and say whose and where it is now. */
export interface LayoutTarget {
  apply(value: Record<string, unknown> | null): void;
}
const targets = new Map<LayoutKind, LayoutTarget>();
export function registerLayout(kind: LayoutKind, target: LayoutTarget): void {
  targets.set(kind, target);
}

/* ---------- whose and where (set by OrgsProvider) ---------- */

let who = { userId: FOUNDING_USER_ID, context: 'personal' };
/** The signed-in person and the org context the layouts are read and saved for now. */
export const layoutOwner = () => who;

export interface LayoutApi {
  get(scope: string): Promise<Layouts>;
  save(scope: string, kind: LayoutKind, layout: Record<string, unknown>): Promise<unknown>;
}
let api: LayoutApi | null = null;
let storage: () => LayoutStorage | null = () => safe(() => (typeof window === 'undefined' ? null : window.localStorage), null);
let generation = 0;

/** Wires the portal's API and (in tests) a storage. */
export function setLayoutApi(a: LayoutApi | null, s?: () => LayoutStorage | null): void {
  api = a;
  if (s) storage = s;
}

/** The cached layout of `kind` for the current person and context (what a store reads first). */
export function readCachedLayout(kind: LayoutKind): Record<string, unknown> | null {
  const st = storage();
  return safe(() => parse(st?.getItem(layoutCacheKey(kind, who.userId, who.context)) ?? null), null);
}

const pending = new Map<LayoutKind, ReturnType<typeof setTimeout>>();
/** A store changed: cache it on this device now, save it to the server shortly after (the last change of a burst). */
export function saveLayout(kind: LayoutKind, value: Record<string, unknown>, delayMs = 400): void {
  const { userId, context } = who;
  const st = storage();
  safe(() => st?.setItem(layoutCacheKey(kind, userId, context), JSON.stringify(value)), undefined);
  if (!api) return;
  const a = api;
  clearTimeout(pending.get(kind));
  pending.set(
    kind,
    setTimeout(() => {
      pending.delete(kind);
      void a.save(context, kind, value).catch(() => undefined);
    }, delayMs),
  );
}

/**
 * The person or the context changed (and on first load): read the cache at once, then the server; copy the device's layout up once per person.
 * A newer call wins over a slower earlier one.
 */
export async function syncLayouts(userId: string, context: string): Promise<void> {
  who = { userId, context };
  const mine = ++generation;
  for (const kind of LAYOUT_KINDS) targets.get(kind)?.apply(readCachedLayout(kind));
  if (!api) return;
  let server: Layouts;
  try {
    server = await api.get(context);
  } catch {
    return; // offline or refused: the cache stands
  }
  if (mine !== generation) return;
  const st = storage();
  const migrated = safe(() => st?.getItem(migratedKey(userId)) === '1', true);
  let uploaded = false;
  for (const kind of LAYOUT_KINDS) {
    const cache = safe(() => parse(st?.getItem(layoutCacheKey(kind, userId, context)) ?? null), null);
    const legacy = safe(() => parse(st?.getItem(legacyLayoutKey(kind)) ?? null), null);
    const plan = planLayout(server[kind], { cache, legacy }, migrated, context === 'personal');
    targets.get(kind)?.apply(plan.value);
    safe(() => (plan.value ? st?.setItem(layoutCacheKey(kind, userId, context), JSON.stringify(plan.value)) : st?.removeItem(layoutCacheKey(kind, userId, context))), undefined);
    if (plan.upload && plan.value) {
      uploaded = true;
      await api.save(context, kind, plan.value).catch(() => undefined);
    }
    // The pre-people key goes once Personal was settled (copied, or the server already had this person's): nobody else inherits it.
    if (context === 'personal' && userId !== FOUNDING_USER_ID && legacy) safe(() => st?.removeItem(legacyLayoutKey(kind)), undefined);
  }
  if (context === 'personal' && (!migrated || uploaded)) safe(() => st?.setItem(migratedKey(userId), '1'), undefined);
}
