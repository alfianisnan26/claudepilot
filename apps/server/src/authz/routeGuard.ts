// THE central route check (organizations slice 1, P4; D-82 S0; Authorization FR16). Every route signed in with a cookie passes through the
// session middleware (app.ts `requireSession`), which calls `enforceRoutePolicy` once it has set the actor: the route that will answer is
// looked up by its key (`METHOD /full/pattern`, as the router lists it), its declared policy is read from the one table (`declarePolicies`)
// and enforced through the one `can()` BEFORE any handler runs:
//   - no declaration: refused, 403 NO_POLICY (and the whole-app enumeration test fails on it first, authz/routeTable.test.ts);
//   - `objects`: every check whose parameter is present (an optional one left out is skipped; a required one missing is not found), each id
//     of a `many` list; a refusal is the seam's (`refusal`): the same 404 as a missing object, 401, or 403 with what was needed;
//   - `platform`: the area at the verb;
//   - `signed-in`, `self`: the actor is a signed-in person (the middleware made sure); lists filter in their handler (`filter`);
//   - `public`, `bearer`, `handler`: their own door (they are not behind the session middleware; one that is passes through).
// It only ever refuses: every handler's own checks stay.

import { AppError } from '@isnanme/core';
import type { Context } from 'hono';
import { matchedRoutes } from 'hono/route';
import { isStableWorkspaceId, objectRef, platformRef, workspaceRef, type ObjectCheck, type ObjectRef, type RoutePolicy } from '@portal/contracts';
import { actorOf, can, policyFor, refusal } from './seam.js';


/** The route that will answer this request: the first matched entry for its method that is not a middleware (`use`, method ALL). */
export function answeringRoute(c: Context): { method: string; path: string } | null {
  const method = c.req.method === 'HEAD' ? 'GET' : c.req.method;
  for (const r of matchedRoutes(c)) {
    if (r.method === 'ALL') continue;
    if (r.method === method || (c.req.method === 'HEAD' && r.method === 'HEAD')) return { method: r.method, path: r.path };
  }
  return null;
}

/** The path parameters of `pattern` (`/a/:id/b`, `:id{regex}`, a trailing `*`) in `path`, decoded; null when they do not line up. */
export function routeParams(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/');
  const have = path.split('/');
  const out: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    if (w === '*') return out;
    const h = have[i];
    if (h === undefined) return w.endsWith('?') ? out : null;
    if (w.startsWith(':')) {
      const name = w.slice(1).replace(/\{.*\}$/, '').replace(/\?$/, '');
      try {
        out[name] = decodeURIComponent(h);
      } catch {
        return null;
      }
    } else if (w !== h) return null;
  }
  return have.length === want.length ? out : null;
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  if (!/^application\/json/i.test(c.req.header('content-type') ?? '')) return null;
  // A clone, so the handler still gets the stream untouched.
  const json: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined);
  return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
}

/** The ids one declared check names in this request (none when an optional one is absent); `missing` when a required one is. */
async function idsOf(c: Context, check: ObjectCheck, params: Record<string, string>, body: () => Promise<Record<string, unknown> | null>): Promise<string[] | 'missing'> {
  let raw: unknown;
  if (check.from === 'path') {
    // `target+name` (a workspace written `/:target/:name`), `target+name+term` (a terminal): the parameters joined with `/`.
    const parts = check.param.split('+').map((p) => params[p]);
    raw = parts.every((p) => typeof p === 'string' && p !== '') ? parts.join('/') : undefined;
  }
  else if (check.from === 'query') raw = check.many ? c.req.queries(check.param) : c.req.query(check.param);
  else raw = (await body())?.[check.param];
  const absent = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0);
  // A path parameter is always there when the route matched. A body or query field left out names no object: the handler's own validation
  // answers it (422), as it did before this check existed; there is nothing to read without an id.
  if (absent) return check.optional || check.from !== 'path' ? [] : 'missing';
  const list = Array.isArray(raw) ? raw : [raw];
  if (!check.many && list.length > 1) return 'missing';
  return list.map((v) => (typeof v === 'string' ? v : ''));
}

/**
 * How a workspace named by its stable id (`ws_…`, a `/:ref` route) becomes the key the seam decides on: the manager's one resolver, installed
 * by app.ts. A stable id it does not know goes on to the handler, which lists once and answers 404 (as `workspaceRefGuard` does).
 */
let workspaceAlias: (ref: string) => string | null | undefined = () => undefined;
export const useWorkspaceAlias = (fn: (ref: string) => string | null | undefined): void => {
  workspaceAlias = fn;
};

/** Enforces the declared policy of the route that will answer `c`. Throws the refusal, or returns. */
export async function enforceRoutePolicy(c: Context): Promise<void> {
  const route = answeringRoute(c);
  // Nothing answers this method and path (the /api 404, a 405): the router's own answer, nothing to guard.
  if (!route) return;
  const key = `${route.method} ${route.path}`;
  const policy: RoutePolicy | undefined = policyFor(key);
  if (!policy) {
    console.error(`[authz] refused ${key}: the route has no declared policy`);
    throw new AppError('NO_POLICY', 'This route has no access policy.');
  }
  const actor = actorOf(c);
  if (actor.kind === 'anonymous') throw new AppError('UNAUTHORIZED', 'Sign in again.');
  if (policy.kind === 'platform') {
    const ref = platformRef(policy.area);
    const d = can(actor, policy.verb, ref);
    if (!d.allow) throw refusal(d, policy.verb, ref);
    return;
  }
  if (policy.kind !== 'objects') return;
  const params = routeParams(route.path, c.req.path) ?? {};
  let bodyRead: Promise<Record<string, unknown> | null> | null = null;
  const body = () => (bodyRead ??= jsonBody(c));
  for (const check of policy.checks) {
    const ids = await idsOf(c, check, params, body);
    const poolType = check.poolTypeParam ? params[check.poolTypeParam] : undefined;
    if (ids === 'missing') throw new AppError('NOT_FOUND', 'Not found.');
    for (const given of ids) {
      if (!given) throw new AppError('NOT_FOUND', 'Not found.');
      let id = given;
      if (check.type === 'workspace' && isStableWorkspaceId(given)) {
        const known = workspaceAlias(given);
        if (!known) continue;
        id = known;
      }
      const ref: ObjectRef = check.type === 'workspace' ? workspaceRef(id) : objectRef(check.type, id, poolType as ObjectRef['poolType']);
      const d = can(actor, check.verb, ref);
      if (!d.allow) throw refusal(d, check.verb, ref);
    }
  }
}
