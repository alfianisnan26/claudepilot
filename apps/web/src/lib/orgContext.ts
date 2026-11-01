// The context the app works in (docs/prd/organizations.md §7, slice 9): Personal, or one organization the person is in. It is kept per device
// (`claudepilot.context.<userId>` in local storage, every access in try/catch: a private window or blocked storage just means Personal) and
// every LIST call goes through `scopedList`, the one place that adds `?org=`.
//
// Until the server scopes lists by org (slices 5 and 6: org-owned objects and the migration), `ORG_SCOPED_LISTS_LIVE` is false: in an org
// context a list answers empty without asking, so an org context never shows personal objects as if they were the org's. Turning it on is
// one line here; the server must then read `?org=` and never widen a list by it (its API test, slice 5).

/** Personal, or an org by id (`org_…`). */
export type AppContext = { kind: 'personal' } | { kind: 'org'; id: string };

export const PERSONAL: AppContext = { kind: 'personal' };

/** Flip when the server reads `?org=` on its lists (slice 5/6). While off, an org context's lists are empty. */
export const ORG_SCOPED_LISTS_LIVE = false;

export const contextKey = (userId: string) => `claudepilot.context.${userId}`;

/** The minimal storage this needs (window.localStorage, or a fake in tests). */
export interface ContextStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const ORG_ID = /^org_[A-Za-z0-9_-]{1,64}$/;

/** Parses what was stored; anything else (garbage, an old shape, a non-org id) is Personal. */
export function parseContext(raw: string | null): AppContext {
  if (!raw || raw === 'personal') return PERSONAL;
  const id = raw.startsWith('org:') ? raw.slice(4) : '';
  return ORG_ID.test(id) ? { kind: 'org', id } : PERSONAL;
}

export const serializeContext = (ctx: AppContext) => (ctx.kind === 'org' ? `org:${ctx.id}` : 'personal');

export function readContext(storage: ContextStorage | null, userId: string): AppContext {
  try {
    return parseContext(storage?.getItem(contextKey(userId)) ?? null);
  } catch {
    return PERSONAL;
  }
}

export function writeContext(storage: ContextStorage | null, userId: string, ctx: AppContext): void {
  try {
    if (ctx.kind === 'personal') storage?.removeItem(contextKey(userId));
    else storage?.setItem(contextKey(userId), serializeContext(ctx));
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

/** A stored org the person is no longer in (left, removed, or a forged value) falls back to Personal. */
export function resolveContext(ctx: AppContext, myOrgIds: readonly string[]): AppContext {
  return ctx.kind === 'org' && myOrgIds.includes(ctx.id) ? ctx : PERSONAL;
}

/** `path` with `org=<id>` added (after an existing query or as the first). */
export function withOrg(path: string, orgId: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}org=${encodeURIComponent(orgId)}`;
}

/* ---------- the current context (one per page load) ---------- */

let current: AppContext = PERSONAL;
const listeners = new Set<() => void>();

export const currentContext = (): AppContext => current;

export function setCurrentContext(ctx: AppContext): void {
  if (serializeContext(ctx) === serializeContext(current)) return;
  current = ctx;
  listeners.forEach((fn) => fn());
}

export function subscribeContext(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/**
 * THE helper every list call goes through. Personal: the path as it is. An org: `?org=<id>` added, or, while the server does not scope lists
 * yet (`live` false), the list's empty value without a request.
 */
export function scopedList<T>(path: string, run: (path: string) => Promise<T>, empty: () => T, ctx: AppContext = current, live = ORG_SCOPED_LISTS_LIVE): Promise<T> {
  if (ctx.kind === 'personal') return run(path);
  if (!live) return Promise.resolve(empty());
  return run(withOrg(path, ctx.id));
}

/** The browser's local storage, or null where it cannot be reached. */
export function browserStorage(): ContextStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
