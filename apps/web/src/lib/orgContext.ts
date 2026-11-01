// The context the app works in (docs/prd/organizations.md §7, slice 9): Personal, or one organization the person is in. It is kept per device
// (`claudepilot.context.<userId>` in local storage, every access in try/catch: a private window or blocked storage just means Personal) and
// every LIST call goes through `scopedList`, the one place that adds `?org=`: `org=personal` in Personal (what no org owns), `org=<id>` in
// an org (what that org owns). The server (apps/server/src/authz/orgScope.ts) only narrows what the caller may already see; an org the caller
// is not in answers an empty list. With `ORG_SCOPED_LISTS_LIVE` off (a server that does not read `?org=`), Personal asks as before and an org
// context answers empty without a request, so it never shows personal objects as the org's.

import { isOrgId } from '@portal/contracts';

/** Personal, or an org by id (`org_…`). */
export type AppContext = { kind: 'personal' } | { kind: 'org'; id: string };

export const PERSONAL: AppContext = { kind: 'personal' };

/** The server reads `?org=` on its lists (owner request 2026-11-01). Off: Personal sends nothing and an org context's lists are empty. */
export const ORG_SCOPED_LISTS_LIVE = true;

/** The `?org=` value Personal sends: only what no org owns. */
export const PERSONAL_ORG_PARAM = 'personal';

export const contextKey = (userId: string) => `claudepilot.context.${userId}`;

/** The minimal storage this needs (window.localStorage, or a fake in tests). */
export interface ContextStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}


/** Parses what was stored; anything else (garbage, an old shape, a non-org id) is Personal. */
export function parseContext(raw: string | null): AppContext {
  if (!raw || raw === 'personal') return PERSONAL;
  const id = raw.startsWith('org:') ? raw.slice(4) : '';
  return isOrgId(id) ? { kind: 'org', id } : PERSONAL;
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
 * THE helper every list call goes through. Personal: `?org=personal` added; an org: `?org=<id>` added. With `live` false (a server that does
 * not scope lists): Personal the path as it is, an org the list's empty value without a request.
 */
export function scopedList<T>(path: string, run: (path: string) => Promise<T>, empty: () => T, ctx: AppContext = current, live = ORG_SCOPED_LISTS_LIVE): Promise<T> {
  if (!live) return ctx.kind === 'personal' ? run(path) : Promise.resolve(empty());
  return run(scopedPath(path, ctx));
}

/**
 * A summary's path in the context (owner request 2026-11-01, metrics per org): the same `?org=` a list gets, for the Home cards and the glance
 * rail (glance, Needs you, quota, spend, Keep going). Their stores load again when the context changes (`subscribeContext`).
 */
export const scopedPath = (path: string, ctx: AppContext = current): string => withOrg(path, ctx.kind === 'org' ? ctx.id : PERSONAL_ORG_PARAM);

/**
 * A live push of a whole list (the `workspaces` topic) in the context (owner request 2026-11-01: an org's Home showed another org's workspace
 * from it). The push carries every row the person may see, whatever the context, so it never adds one: while the pushed set of ids is the one
 * pushed last time, the held (context) list takes the pushed rows of its own ids, in the pushed order (a state changes without a request);
 * when a row came or went, or nothing is held yet, `next` is null: load the list again in the context. `ids` is what to pass as `lastIds` next.
 */
export function scopedPush<T extends { id: string }>(pushed: readonly T[], held: readonly T[] | null, lastIds: string): { next: T[] | null; ids: string } {
  const ids = pushed
    .map((r) => r.id)
    .sort()
    .join('\n');
  if (ids !== lastIds || !held) return { next: null, ids };
  const mine = new Set(held.map((r) => r.id));
  return { next: pushed.filter((r) => mine.has(r.id)), ids };
}

/** The browser's local storage, or null where it cannot be reached. */
export function browserStorage(): ContextStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
