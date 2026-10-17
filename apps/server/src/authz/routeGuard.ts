// THE ROUTE GUARD (T-1043 S0a, D-82): one middleware in front of every HTTP route that runs the route's DECLARED policy (`declarePolicies` in
// each module's `authz.ts`) through the one `can()`, for the request's real actor, before any route middleware or handler runs.
//
//   - The route is the first endpoint Hono matched (`METHOD /full/path`, as `app.routes` lists it). A path no route answers goes on.
//   - `public`, `bearer` and `handler` routes are their own door (sign-in, the bearer `/mcp`, signed webhooks, connector keys): they go on.
//   - Not signed in: 401, as the session guard answers it.
//   - The founding owner in single-owner mode goes on untouched: today's behaviour, so nothing in production changes; each route's own checks
//     stay (the same fast path as `visible()`).
//   - Anyone else (a member account, a test actor, a later per-user actor): a route with NO declaration is refused; `signed-in` and `self` go
//     on (the handler filters and scopes); `platform` asks `can()` on the area; `objects` asks `can()` for every declared check, in order.
//     `reauth` and `audit` stay the handler's.
//   - Every refusal is the same 404 an API path nobody serves answers (`notFound()`, the lead's decision on T-1043): it never tells that a
//     route or an object is there. Only an object the actor can see but not change keeps the seam's 403.
//   - A request every matched route handed on is refused too: it never reaches a handler unchecked.
// It only ever refuses: the handlers' own checks stay.

import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import { AppError } from '@isnanme/core';
import { FOUNDING_USER_ID, objectRef, type Actor, type ObjectCheck, type ObjectRef, type PolicyKey, type RoutePolicy } from '@portal/contracts';
import { anonymous, authzMode, can, ownerActor, policyFor, refusal } from './seam.js';

/** Who the request's cookie signs in: a full session (the server code or an admin account), a member account, or nobody. */
export type SignedIn = { full: true } | { full: false; userId: string } | null;

export interface RouteGuardDeps {
  signedIn(c: Context): SignedIn;
  /**
   * The id the seam decides on for a value a check names. `undefined`: the value itself. `null`: it names no such object here and the route
   * hands the request on (a `/:ref…` route given something that is not a stable id): the next matched route's policy is asked instead.
   */
  idOf?(check: ObjectCheck, value: string): string | null | undefined;
}

/** `/api/x/` and `/api/x` are one route; the root stays `/`. */
const normal = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/**
 * Whether a route Hono lists is an endpoint (it answers) rather than middleware (it hands on). Hono lists `use()` and `all()` alike (method
 * ALL), so an ALL route is told apart the way Hono's own route inspector does it: a handler that takes `next` is middleware (QA 10597 A2).
 */
export function isEndpoint(r: { method: string; handler: { length: number } }): boolean {
  return r.method !== 'ALL' || r.handler.length < 2;
}

/** A route's policy key, as `app.routes` and `matchedRoutes` list it. Hono answers a HEAD request with the GET route, so a HEAD route is its GET. */
export const keyOf = (r: { method: string; path: string }): PolicyKey => `${(r.method === 'HEAD' ? 'GET' : r.method) as 'GET'} ${normal(r.path)}`;

/**
 * The keys of the endpoints Hono matched for this request, in the order it runs them, each once. Middleware is left out unless declared
 * (`ALL /api/chat/live`); an `app.all(…)` endpoint is always in, so an undeclared one is refused like any other route.
 */
export function routeKeysOf(c: Context): PolicyKey[] {
  return routeMatchesOf(c).map((m) => m.key);
}

/** One matched endpoint: its key and its place in Hono's match (where its own path params are). */
interface RouteMatch {
  key: PolicyKey;
  index: number;
}

function routeMatchesOf(c: Context): RouteMatch[] {
  const out: RouteMatch[] = [];
  const add = (key: PolicyKey, index: number) => void (out.some((m) => m.key === key) || out.push({ key, index }));
  const all = matchedRoutes(c);
  all.forEach((r, i) => r.method !== 'ALL' && add(keyOf(r), i));
  all.forEach((r, i) => r.method === 'ALL' && (isEndpoint(r) || policyFor(keyOf(r))) && add(keyOf(r), i));
  return out;
}

/**
 * A path param of one matched route. In middleware `c.req.param()` reads the middleware's own route (`*`, no params), so the guard points
 * Hono's request at the route it checks (`routeIndex`, the index `matchedRoutes` lists it at) for the read, and puts it back.
 */
function paramOf(c: Context, index: number, name: string): string | undefined {
  const req = c.req as unknown as { routeIndex: number };
  const was = req.routeIndex;
  req.routeIndex = index;
  try {
    return c.req.param(name);
  } finally {
    req.routeIndex = was;
  }
}

/**
 * The guard's one refusal (D-82, lead's decision on T-1043): exactly what an API path nobody serves answers (app.ts's `app.all('/api/*')`),
 * so a refusal never tells that a route, or an object, is there.
 */
export const notFound = (): AppError => new AppError('NOT_FOUND');

const OPEN_KINDS = new Set<RoutePolicy['kind']>(['public', 'bearer', 'handler']);

/** The actor the guard decides for: one set on the context (the real layer, a test), else the cookie's. A member is set on the context. */
function actorFor(c: Context, deps: RouteGuardDeps): Actor {
  const set = (c as unknown as { get(k: string): unknown }).get('actor');
  if (set && typeof set === 'object' && 'kind' in set) return set as Actor;
  const s = deps.signedIn(c);
  if (!s) return anonymous();
  // D-82: an admin account and the server code keep full access: they act as the founding owner, as `actorOf` answers today.
  if (s.full) return ownerActor();
  // A member stays a signed-in member even when its id is not one the seam knows (identity/users.ts makes base64url ids, USER_ID_PATTERN
  // takes lower case only): `can()` then grants it nothing, and the guard refuses with its 404, never the 401 of nobody signed in.
  const member = { kind: 'user', userId: s.userId, loginSessionId: 'cookie', via: 'ui' } as Actor;
  (c as unknown as { set(k: string, v: unknown): void }).set('actor', member);
  return member;
}

const isFoundingOwner = (a: Actor): boolean => a.kind === 'user' && a.userId === FOUNDING_USER_ID && authzMode() === 'single-owner';

/** The JSON body, read from a clone so the handler still gets the stream untouched (the avatar and file routes read it themselves). */
async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  if (!/^application\/json/i.test(c.req.header('content-type') ?? '')) return {};
  const v: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

type Outcome = 'allow' | 'pass-on';

async function checkObjects(c: Context, at: number, actor: Actor, checks: ObjectCheck[], deps: RouteGuardDeps): Promise<Outcome> {
  let body: Record<string, unknown> | null = null;
  for (const check of checks) {
    let raw: unknown;
    if (check.from === 'path') {
      const parts = check.param.split('+').map((k) => paramOf(c, at, k) ?? '');
      raw = parts.some((p) => !p) ? undefined : parts.join('/');
    } else if (check.from === 'query') raw = check.many ? c.req.queries(check.param) : c.req.query(check.param);
    else raw = (body ??= await jsonBody(c))[check.param];
    const values = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw];
    if (values.length === 0) {
      if (check.optional) continue;
      throw notFound();
    }
    const poolType = check.poolTypeParam ? paramOf(c, at, check.poolTypeParam) : undefined;
    for (const v of values) {
      if (typeof v !== 'string' || !v) throw notFound();
      const id = deps.idOf?.(check, v);
      if (id === null) return 'pass-on';
      const ref: ObjectRef = objectRef(check.type, id ?? v, poolType ? (poolType as ObjectRef['poolType']) : undefined);
      const d = can(actor, check.verb, ref);
      if (!d.allow) {
        const e = refusal(d, check.verb, ref);
        // An object the actor may not see reads like a path nobody serves; one it sees but may not change keeps the seam's 403 (or reauth).
        throw e.status === 403 ? e : notFound();
      }
    }
  }
  return 'allow';
}

/** What one declared policy says for a non-owner actor who is signed in: go on, hand on to the next matched route, or a refusal (thrown). */
async function decide(c: Context, at: number, actor: Actor, policy: RoutePolicy, deps: RouteGuardDeps): Promise<Outcome> {
  switch (policy.kind) {
    case 'public':
    case 'bearer':
    case 'handler':
    case 'signed-in':
    case 'self':
      return 'allow';
    case 'platform': {
      const object = objectRef('platform', policy.area);
      const d = can(actor, policy.verb, object);
      if (d.allow) return 'allow';
      // An admin route refused reads like a path nobody serves (lead's decision on T-1043).
      throw notFound();
    }
    case 'objects':
      return checkObjects(c, at, actor, policy.checks, deps);
  }
}

/** The guard's handler is named, so a test finds where it sits among the app's routes (nothing that answers may come before it). */
export const ROUTE_GUARD_NAME = 'routeGuard';

export function createRouteGuard(deps: RouteGuardDeps): MiddlewareHandler {
  const guard: MiddlewareHandler = async (c, next) => {
    const matches = routeMatchesOf(c);
    if (matches.length === 0) return next();
    const first = policyFor(matches[0]!.key);
    if (first && OPEN_KINDS.has(first.kind)) return next();
    const actor = actorFor(c, deps);
    if (actor.kind === 'anonymous') throw new AppError('UNAUTHORIZED', 'Sign in again.');
    if (isFoundingOwner(actor)) return next();
    for (const { key, index } of matches) {
      const policy = policyFor(key);
      // No declaration: refused for anyone but the founding owner, as a path nobody serves (the route stays out of the answer).
      if (!policy) throw notFound();
      if ((await decide(c, index, actor, policy, deps)) === 'allow') return next();
    }
    // Every matched route handed the request on (QA 10597 A1): nothing checked it, so it is refused, never let through unchecked.
    throw notFound();
  };
  Object.defineProperty(guard, 'name', { value: ROUTE_GUARD_NAME });
  return guard;
}
