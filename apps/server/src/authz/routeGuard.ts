// THE ROUTE GUARD (T-1043 S0a, D-82): one middleware in front of every HTTP route that runs the route's DECLARED policy (`declarePolicies` in
// each module's `authz.ts`) through the one `can()`, for the request's real actor, before any route middleware or handler runs.
//
//   - The route is the first endpoint Hono matched (`METHOD /full/path`, as `app.routes` lists it). A path no route answers goes on.
//   - `public`, `bearer` and `handler` routes are their own door (sign-in, the bearer `/mcp`, signed webhooks, connector keys): they go on.
//   - Not signed in: 401, as the session guard answers it.
//   - The founding owner in single-owner mode goes on untouched: today's behaviour, so nothing in production changes; each route's own checks
//     stay (the same fast path as `visible()`).
//   - Anyone else (a member account, a test actor, a later per-user actor): a route with NO declaration is refused (403); `signed-in` and
//     `self` go on (the handler filters and scopes); `platform` asks `can()` on the area (refused: 403 "Only an admin can do this."); `objects`
//     asks `can()` for every declared check, in order (refused: the seam's answer, so an object the actor may not see is the same 404 as a
//     missing one). `reauth` and `audit` stay the handler's.
// It only ever refuses: the handlers' own checks stay.

import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import { AppError } from '@isnanme/core';
import { FOUNDING_USER_ID, isUserId, objectRef, type Actor, type ObjectCheck, type ObjectRef, type PolicyKey, type RoutePolicy } from '@portal/contracts';
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

/** The keys of the endpoints Hono matched for this request, in the order it runs them, each once. Middleware (`use`, method ALL) is left out unless declared. */
export function routeKeysOf(c: Context): PolicyKey[] {
  const keys: PolicyKey[] = [];
  const add = (k: PolicyKey) => void (keys.includes(k) || keys.push(k));
  const all = matchedRoutes(c);
  for (const r of all) if (r.method !== 'ALL') add(`${r.method as 'GET'} ${normal(r.path)}`);
  // A catch-all written `app.all(…)` (`ALL /api/*`) is an endpoint only when declared; `use()` is listed the same way and never is.
  for (const r of all) if (r.method === 'ALL' && policyFor(`ALL ${normal(r.path)}`)) add(`ALL ${normal(r.path)}`);
  return keys;
}

const OPEN_KINDS = new Set<RoutePolicy['kind']>(['public', 'bearer', 'handler']);

/** The actor the guard decides for: one set on the context (the real layer, a test), else the cookie's. A member is set on the context. */
function actorFor(c: Context, deps: RouteGuardDeps): Actor {
  const set = (c as unknown as { get(k: string): unknown }).get('actor');
  if (set && typeof set === 'object' && 'kind' in set) return set as Actor;
  const s = deps.signedIn(c);
  if (!s) return anonymous();
  // D-82: an admin account and the server code keep full access: they act as the founding owner, as `actorOf` answers today.
  if (s.full) return ownerActor();
  if (!isUserId(s.userId)) return anonymous();
  const member: Actor = { kind: 'user', userId: s.userId, loginSessionId: 'cookie', via: 'ui' };
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

async function checkObjects(c: Context, actor: Actor, checks: ObjectCheck[], deps: RouteGuardDeps): Promise<Outcome> {
  let body: Record<string, unknown> | null = null;
  for (const check of checks) {
    let raw: unknown;
    if (check.from === 'path') {
      const parts = check.param.split('+').map((k) => c.req.param(k) ?? '');
      raw = parts.some((p) => !p) ? undefined : parts.join('/');
    } else if (check.from === 'query') raw = check.many ? c.req.queries(check.param) : c.req.query(check.param);
    else raw = (body ??= await jsonBody(c))[check.param];
    const values = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw];
    if (values.length === 0) {
      if (check.optional) continue;
      throw new AppError('NOT_FOUND', 'Not found.');
    }
    const poolType = check.poolTypeParam ? c.req.param(check.poolTypeParam) : undefined;
    for (const v of values) {
      if (typeof v !== 'string' || !v) throw new AppError('NOT_FOUND', 'Not found.');
      const id = deps.idOf?.(check, v);
      if (id === null) return 'pass-on';
      const ref: ObjectRef = objectRef(check.type, id ?? v, poolType ? (poolType as ObjectRef['poolType']) : undefined);
      const d = can(actor, check.verb, ref);
      if (!d.allow) throw refusal(d, check.verb, ref);
    }
  }
  return 'allow';
}

/** What one declared policy says for a non-owner actor who is signed in: go on, hand on to the next matched route, or a refusal (thrown). */
async function decide(c: Context, actor: Actor, policy: RoutePolicy, deps: RouteGuardDeps): Promise<Outcome> {
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
      if (d.reason === 'unauthenticated' || d.reason === 'actor_disabled') throw refusal(d, policy.verb, object);
      // The portal's areas are no secret: an admin route answers a member "only an admin", as MU2 S1a does (D-82).
      throw refusal({ allow: false, reason: 'platform_only', level: d.level }, policy.verb, object);
    }
    case 'objects':
      return checkObjects(c, actor, policy.checks, deps);
  }
}

/** The refusal of a route nobody declared, for anyone but the founding owner. */
export const NO_POLICY_MESSAGE = 'This route has no access rule yet.';

export function createRouteGuard(deps: RouteGuardDeps): MiddlewareHandler {
  return async (c, next) => {
    const keys = routeKeysOf(c);
    if (keys.length === 0) return next();
    const first = policyFor(keys[0]!);
    if (first && OPEN_KINDS.has(first.kind)) return next();
    const actor = actorFor(c, deps);
    if (actor.kind === 'anonymous') throw new AppError('UNAUTHORIZED', 'Sign in again.');
    if (isFoundingOwner(actor)) return next();
    for (const key of keys) {
      const policy = policyFor(key);
      if (!policy) throw new AppError('FORBIDDEN', NO_POLICY_MESSAGE, { details: { route: key } });
      if ((await decide(c, actor, policy, deps)) === 'allow') return next();
    }
    // Every matched route handed the request on: the last one answers it (its handler's own 404).
    return next();
  };
}
