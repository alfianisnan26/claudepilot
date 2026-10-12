// The policy table of the one authorization layer (docs/prd/authorization.md FR16, FR17, Appendix A and C). Two layers of declarations:
//   1. what each module declares itself in `<module>/authz.ts` through the seam's `declarePolicies` (a key declared twice, differently, throws there);
//   2. the FALLBACK rows of Appendix A (`policy.routes.v0.ts`), consulted only for a key no module declared. A module's declaration always
//      stands, there is no ordering problem between the two, and the fallback shrinks as modules take their rows.
// `routeKeyOf` turns one request into the key the tables use (`METHOD /full/pattern`, as `app.routes` lists it); `objectsOf` turns a
// policy's checks into the objects the request names (path, query or a cloned JSON body); `enumerate` walks a real route table so a test
// (and the start-up log) can say which routes nobody declared and which declarations name a route that is gone.

import type { Context } from 'hono';
import { isObjectType, type ObjectCheck, type ObjectRef, type RoutePolicies, type RoutePolicy, type Verb } from '@portal/contracts';
import { declaredPolicies, policyFor } from './seam.js';

/* ---------- The fallback table ---------- */

const fallback = new Map<string, RoutePolicy>();

/** Declares Appendix A rows: used only where no module declared the key. Declaring a key twice here, differently, throws like the seam does. */
export function declareFallbackPolicies(module: string, table: RoutePolicies): void {
  for (const [key, policy] of Object.entries(table) as [string, RoutePolicy][]) {
    const known = fallback.get(key);
    if (known && JSON.stringify(known) !== JSON.stringify(policy)) throw new Error(`fallback route ${key} is declared twice, differently (${module})`);
    fallback.set(key, policy);
  }
}
export const fallbackPolicyFor = (key: string): RoutePolicy | undefined => fallback.get(key);
export const fallbackPolicies = (): ReadonlyMap<string, RoutePolicy> => fallback;
/** For tests. */
export const clearFallbackPolicies = (): void => fallback.clear();

/** The policy in force for a key: the module's, else the fallback's, else nothing (refused in enforce mode, listed in shadow). */
export function effectivePolicyFor(key: string): { policy: RoutePolicy; source: 'module' | 'fallback' } | null {
  const own = policyFor(key);
  if (own) return { policy: own, source: 'module' };
  const fb = fallback.get(key);
  return fb ? { policy: fb, source: 'fallback' } : null;
}

/* ---------- The key of a request ---------- */

interface MatchedRoute {
  method: string;
  path: string;
}

/**
 * The key a request is judged by. Hono matches middleware (`ALL /api/*`, the mounts `ALL /api/x` + `ALL /api/x/*`) and handlers alike;
 * the handler is the LAST matched route without a wildcard, preferring one with the request's own method. An `ALL` entry without a
 * wildcard is a mount's middleware (then its `/*` twin is matched too, or a method route sits at the same path) unless it is declared
 * (`ALL /mcp`, the sockets) or stands alone (`app.all(path, handler)`): the first is skipped, the two others are the key.
 * Nothing matched: the request falls through to the router's own 404 (the catch-all), which is the uniform answer for an unknown path.
 */
export function routeKeyOf(matched: readonly MatchedRoute[], isDeclared: (key: string) => boolean = (k) => !!effectivePolicyFor(k)): string | null {
  const exact = matched.filter((r) => !r.path.includes('*'));
  const own = exact.filter((r) => r.method !== 'ALL');
  if (own.length) {
    const r = own[own.length - 1]!;
    return `${r.method} ${r.path}`;
  }
  const alls = exact.filter((r) => r.method === 'ALL');
  for (let i = alls.length - 1; i >= 0; i--) {
    const r = alls[i]!;
    const key = `ALL ${r.path}`;
    if (isDeclared(key)) return key;
    const mount = matched.some((m) => m.path === `${r.path}/*`);
    if (!mount) return key; // a lone `app.all` handler nobody declared: refused by name, not waved through
  }
  return null;
}

/* ---------- The objects a request names ---------- */

export interface NamedObject {
  ref: ObjectRef;
  verb: Verb;
  check: ObjectCheck;
}

export type ObjectsResult = { ok: true; objects: NamedObject[] } | { ok: false; why: 'bad_value'; check: ObjectCheck };

const ID_MAX = 512;
const okId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= ID_MAX && !v.includes('\0');

/** Reads `a.b.c` from a JSON body; an array on the way maps over its items. Returns the values found (flattened). */
function pick(value: unknown, path: string[]): unknown[] {
  if (path.length === 0) return [value];
  if (Array.isArray(value)) return value.flatMap((v) => pick(v, path));
  if (!value || typeof value !== 'object') return [];
  return pick((value as Record<string, unknown>)[path[0]!], path.slice(1));
}

export interface RequestFacts {
  param(name: string): string | undefined;
  query(name: string): string | undefined;
  queries(name: string): string[] | undefined;
  /** The parsed JSON body, `undefined` when there is none (or it is not JSON). */
  body: unknown;
}

/**
 * The objects a policy's checks name in this request, each with the verb it needs. A `path` parameter is always there; a `query` or `body`
 * field that is ABSENT is not checked (the handler validates what it needs); one that is PRESENT with the wrong shape (an object where an
 * id goes, an empty string, a huge string) fails closed. `target+name` joins path parameters with `/`; `items.poolId` walks a body.
 */
export function objectsOf(policy: RoutePolicy, req: RequestFacts): ObjectsResult {
  if (policy.kind !== 'objects') return { ok: true, objects: [] };
  const objects: NamedObject[] = [];
  for (const check of policy.checks) {
    let values: unknown[];
    if (check.from === 'path') {
      const parts = check.param.split('+').map((p) => req.param(p));
      if (parts.some((p) => p === undefined)) return { ok: false, why: 'bad_value', check };
      values = [parts.join('/')];
    } else if (check.from === 'query') {
      const all = check.many ? (req.queries(check.param) ?? []) : [req.query(check.param)].filter((v) => v !== undefined);
      values = all;
    } else {
      values = req.body === undefined ? [] : pick(req.body, check.param.split('.'));
    }
    if (values.length === 0) continue; // absent: nothing named; the handler's validation answers
    if (!check.many && values.length > 1) return { ok: false, why: 'bad_value', check };
    let poolType: ObjectRef['poolType'];
    if (check.poolTypeParam) {
      const pt = req.param(check.poolTypeParam);
      if (!okId(pt)) return { ok: false, why: 'bad_value', check };
      poolType = pt as ObjectRef['poolType'];
    }
    for (const v of values) {
      if (!okId(v)) return { ok: false, why: 'bad_value', check };
      const ref: ObjectRef = poolType ? { type: check.type, id: v, poolType } : { type: check.type, id: v };
      objects.push({ ref, verb: check.verb, check });
    }
  }
  return { ok: true, objects };
}

/** Facts of a Hono request for `objectsOf`; the body is read from a clone so the handler still gets the stream. */
export async function requestFacts(c: Context, wantsBody: boolean): Promise<RequestFacts> {
  let body: unknown;
  if (wantsBody && /^(POST|PUT|PATCH|DELETE)$/.test(c.req.method) && /^application\/json/i.test(c.req.header('content-type') ?? '')) {
    body = await c.req.raw
      .clone()
      .json()
      .catch(() => undefined);
  }
  return {
    param: (n) => c.req.param(n as never) as string | undefined,
    query: (n) => c.req.query(n),
    queries: (n) => c.req.queries(n),
    body,
  };
}

export const policyReadsBody = (policy: RoutePolicy): boolean => policy.kind === 'objects' && policy.checks.some((ch) => ch.from === 'body');

/* ---------- Enumeration (FR16, X19) ---------- */

export const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export interface RouteRow {
  key: string;
  declared: 'module' | 'fallback' | null;
}

/**
 * Every judged route of a route table (`app.routes`): the method routes without a wildcard, plus the lone `ALL` handlers (an `ALL path`
 * with neither a `path/*` twin nor a method route at `path`: `/mcp`). Each with where its declaration comes from, or null.
 */
export function enumerateRoutes(routes: readonly MatchedRoute[]): RouteRow[] {
  const seen = new Set<string>();
  const rows: RouteRow[] = [];
  const paths = new Set(routes.map((r) => r.path));
  const methodPaths = new Set(routes.filter((r) => METHODS.has(r.method)).map((r) => r.path));
  for (const r of routes) {
    if (r.path.includes('*')) continue;
    const lone = r.method === 'ALL' && !paths.has(`${r.path}/*`) && !methodPaths.has(r.path);
    if (!METHODS.has(r.method) && !lone) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, declared: effectivePolicyFor(key)?.source ?? null });
  }
  return rows;
}

/** Declared keys (module or fallback) that name no route of the table and no known socket path: drift. */
export function staleDeclarations(routes: readonly MatchedRoute[], socketPaths: readonly string[]): string[] {
  const live = new Set(enumerateRoutes(routes).map((r) => r.key));
  for (const p of socketPaths) live.add(`ALL ${p}`);
  const wildcard = new Set(routes.filter((r) => r.path.includes('*')).map((r) => `${r.method} ${r.path}`));
  const stale: string[] = [];
  for (const key of [...declaredPolicies().keys(), ...fallback.keys()]) if (!live.has(key) && !wildcard.has(key)) stale.push(key);
  return [...new Set(stale)].sort();
}

/** Fallback rows a module has since declared itself (informational: the row can leave the fallback table). */
export function supersededFallbacks(): string[] {
  return [...fallback.keys()].filter((k) => policyFor(k)).sort();
}

/** Declarations naming an object type with no resolver registered (checked at start-up against the live registry). */
export function typesDeclared(): Set<string> {
  const types = new Set<string>();
  const add = (p: RoutePolicy) => {
    if (p.kind === 'objects') for (const ch of p.checks) types.add(ch.type);
    if ((p.kind === 'objects' || p.kind === 'signed-in') && p.filter) types.add(p.filter);
  };
  for (const p of declaredPolicies().values()) add(p);
  for (const p of fallback.values()) add(p);
  for (const t of types) if (!isObjectType(t)) throw new Error(`a policy names an unknown object type "${t}"`);
  return types;
}
