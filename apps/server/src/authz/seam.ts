// THE AUTHORIZATION SEAM (docs/prd/authorization.md, docs/prd/multi-user.md). Read this header before using it.
//
// WHAT THIS IS TODAY. A seam: the final signatures of the portal's one authorization layer, with a SINGLE-OWNER implementation behind them.
// The portal still has one person, `u_owner`, so today:
//   - `actorOf(c)` answers the owner for a signed-in request and `anonymous` otherwise (the old session cookie is the only sign-in);
//   - `can()` allows the owner (`u_owner`), `system` and `job` actors acting for the owner, everything on every object, and refuses `anonymous`;
//   - a token is capped by its scope (read = view, operate = operate, admin = manage), an agent by `operate` and by its own session and workspace;
//   - for an object type that has a RESOLVER registered (`registerResolver`), `can()` already decides by ownership: the owner or nothing (and
//     what the resolver calls `public`). That is how a module adopts default-deny early and tests it with two fake users (`u_a`, `u_b`).
// There are no grants, teams, roles or per-user sign-in here: the real layer (apps/server/src/authz/index.ts, work package A1) replaces the
// implementation with `useAuthz()` and every call site keeps working, because it only ever calls what is exported below.
//
// HOW AN AGENT ADOPTS IT NOW (the light-touch rules, PRD multi-user §14):
//   1. In a route, read who is asking ONCE: `const actor = actorOf(c)`; pass `actor` (or `actorUserId(actor)`) down; never `'u_owner'` or `'ui'` inline.
//   2. Where a handler takes an object id, ask `requireCan(actor, 'view' | 'operate' | 'manage', ref)` before reading it; a list returns
//      `visible(actor, type, rows, (r) => r.id)`. Write a resolver for your object type in `<module>/authz.ts` and register it.
//   3. Write `actorString(actor)` where you wrote `'ui'` (audit rows, `actor` columns, notes); keep `'ui'` readable (parseActorString maps it to the owner).
//   4. New tables get `owner_id TEXT NOT NULL DEFAULT 'u_owner'` (a user id; teams later add `owner_kind`) and `created_by TEXT NOT NULL DEFAULT 'u_owner'`.
//   5. Declare each route in `<module>/authz.ts` with `declarePolicies` (default deny is enforced once the layer lands; declaring now costs nothing).
//   6. Jobs that act for a person run as `asUser(ownerId, '<job>')`, and re-check `can(owner, ...)` when they RUN, not when they were set up.

import type { IncomingMessage } from 'node:http';
import { AppError } from '@isnanme/core';
import {
  FOUNDING_USER_ID,
  LEVEL_RANK,
  actorUserId,
  isUserId,
  levelAtLeast,
  maxLevel,
  minLevel,
  objectRef,
  statusForDeny,
  type Actor,
  type CanFn,
  type Decision,
  type DenyReason,
  type ForbiddenDetails,
  type Level,
  type MemberScope,
  type MemberScopeSubject,
  type ObjectRef,
  type ObjectType,
  type Owner,
  type RoutePolicies,
  type RoutePolicy,
  type ToolPolicies,
  type ToolPolicy,
  type UserId,
  type Verb,
} from '@portal/contracts';

export { FOUNDING_USER_ID as OWNER_ID, actorString, actorUserId, parseActorString } from '@portal/contracts';

/* ---------- Resolvers ---------- */

/** What authorization needs to know about one object. Cheap, synchronous, and never a secret. */
export interface ResolvedObject {
  ref: ObjectRef;
  /** null: nobody owns it (default deny: only the platform's admins may claim it). */
  owner: Owner | null;
  /** For a child type (`repo`, `ci_run`, `terminal`, `session`, `claude`): the parent it hangs under (see OBJECT_TYPES). */
  parent?: ObjectRef | null;
  /** The level every active user holds on it with no grant (the reviewed library). */
  publicLevel?: Level;
  /** Small facts a policy needs: a session's `workspaceId`, a ticket's, whether it is `private`. */
  attrs?: Record<string, string | number | boolean | null>;
}

/** One per object type, written by the module that owns it (`<module>/authz.ts`) and registered at start-up. No handler reads an object without one. */
export interface ObjectResolver {
  type: ObjectType;
  /** null when there is no such object (or it is gone). Aliases (a folded session's old id) are followed here, before anything is decided. */
  resolve(id: string, poolType?: ObjectRef['poolType']): ResolvedObject | null;
  /** The ids of this type a user owns: for off-boarding, counts and "nothing left unowned" checks. */
  ownedBy?(userId: UserId): string[];
}

const resolvers = new Map<ObjectType, ObjectResolver>();
export const registerResolver = (r: ObjectResolver): void => void resolvers.set(r.type, r);
export const resolverFor = (type: ObjectType): ObjectResolver | undefined => resolvers.get(type);
/** For tests. */
export const clearResolvers = (): void => resolvers.clear();

/** `resolve` for code that needs the object itself (not a decision): same lookup, same null. */
export const resolve = (r: ObjectRef): ResolvedObject | null => resolvers.get(r.type)?.resolve(r.id, r.poolType) ?? null;

/* ---------- Route declarations ---------- */

const policies = new Map<string, RoutePolicy>();
/**
 * Declares the access of routes: `{ 'GET /api/tickets/:id': { kind: 'objects', checks: [...] }, ... }`, keyed `METHOD /full/path` as the router
 * lists it. Once the layer lands a route with no declaration is refused and a test fails on it. A key declared twice with another policy throws.
 */
export function declarePolicies(module: string, table: RoutePolicies): void {
  for (const [key, policy] of Object.entries(table) as [string, RoutePolicy][]) {
    const known = policies.get(key);
    if (known && JSON.stringify(known) !== JSON.stringify(policy)) throw new Error(`route ${key} is declared twice, differently (${module})`);
    policies.set(key, policy);
  }
}
export const policyFor = (key: string): RoutePolicy | undefined => policies.get(key);
export const declaredPolicies = (): ReadonlyMap<string, RoutePolicy> => policies;

const toolPolicies = new Map<string, ToolPolicy>();
/** The same for Portal MCP tools, keyed by tool name: `{ ticket_get: { kind: 'objects', checks: [{ type: 'ticket', verb: 'view', arg: 'id' }] } }`. */
export function declareToolPolicies(module: string, table: ToolPolicies): void {
  for (const [name, policy] of Object.entries(table)) {
    const known = toolPolicies.get(name);
    if (known && JSON.stringify(known) !== JSON.stringify(policy)) throw new Error(`tool ${name} is declared twice, differently (${module})`);
    toolPolicies.set(name, policy);
  }
}
export const toolPolicyFor = (name: string): ToolPolicy | undefined => toolPolicies.get(name);
export const declaredToolPolicies = (): ReadonlyMap<string, ToolPolicy> => toolPolicies;

/**
 * T-348: what a tool declared, enforced at dispatch through the one `can()` before its handler runs (portalmcp/server.ts). `objects`: every
 * check whose argument is given (an optional one left out or empty is skipped; a required one missing is refused); `platform`: the area.
 * Every refusal is NOT_FOUND with the check's `notFound` text, the tool's own answer for a missing object, so a call can't tell an object
 * it may not reach from one that does not exist. It only ever refuses: the handler's own checks stay. `signed-in`, `self` and `agent`
 * (reach from the token) are the handler's. A tool with no declaration is left to its handler.
 */
export function requireToolPolicy(actor: Actor, name: string, args: Record<string, unknown>): void {
  const policy = toolPolicies.get(name);
  if (!policy) return;
  const notFound = (text?: string) => new AppError('NOT_FOUND', text ?? 'Not found.');
  if (actor.kind === 'anonymous') throw notFound();
  if (policy.kind === 'platform') {
    if (!current.can(actor, policy.verb, objectRef('platform', policy.area)).allow) throw notFound();
    return;
  }
  if (policy.kind !== 'objects') return;
  for (const check of policy.checks) {
    const raw = args[check.arg];
    const absent = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0);
    if (absent) {
      if (check.optional) continue;
      throw notFound(check.notFound);
    }
    const ids = check.many && Array.isArray(raw) ? raw : [raw];
    const poolType = check.poolTypeArg ? args[check.poolTypeArg] : undefined;
    for (const id of ids) {
      if (typeof id !== 'string' || !id) throw notFound(check.notFound);
      const ref = objectRef(check.type, id, typeof poolType === 'string' && poolType ? (poolType as ObjectRef['poolType']) : undefined);
      if (!current.can(actor, check.verb, ref).allow) throw notFound(check.notFound);
    }
  }
}

/* ---------- Access changes ---------- */

/**
 * Something that can take a right away happened (a share ended, a member left or was removed, a user was disabled or signed out, an object changed
 * owner). Sockets, running sessions and terminals subscribe and drop what the user may no longer hold. `ref` is null for "everything of this user".
 */
export interface AccessChange {
  userId: UserId;
  ref: ObjectRef | null;
  why: 'share_ended' | 'membership_ended' | 'user_disabled' | 'signed_out' | 'owner_changed';
}
const listeners = new Set<(c: AccessChange) => void>();
export const onAccessChange = (cb: (c: AccessChange) => void): (() => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};
export const emitAccessChange = (c: AccessChange): void => {
  for (const cb of [...listeners]) {
    try {
      cb(c);
    } catch (e) {
      console.error(`[authz] an access-change listener failed: ${(e as Error).message}`);
    }
  }
};

/* ---------- The layer ---------- */

/** What every call site uses. `useAuthz` swaps the implementation; the exported functions below always call the current one. */
export interface Authz {
  readonly mode: 'single-owner' | 'multi-user';
  can: CanFn;
  /** The level the actor holds on an object, `none` when none or unknown. */
  levelOf(actor: Actor, object: ObjectRef): Level;
  isPlatformAdmin(userId: UserId): boolean;
  /** Everyone who owns the object (a team's owners for a team-owned one): who a notification about it goes to. */
  ownersOf(object: ObjectRef): UserId[];
  /** Everyone who holds at least `verb` on it: who may decide an approval, who is told. Checked again by `can` when they act. */
  usersWith(object: ObjectRef, verb: Verb): UserId[];
  /** Whose per-person figures (usage, approvals, Bypass) the actor may see in a scope. */
  memberScope(actor: Actor, subject: MemberScopeSubject): MemberScope;
}

const ANONYMOUS: Actor = { kind: 'anonymous' };
const owner = (): Actor => ({ kind: 'user', userId: FOUNDING_USER_ID, loginSessionId: 'legacy', via: 'ui' });

const deny = (reason: DenyReason, level: Level = 'none'): Decision => ({ allow: false, reason, level });
const SCOPE_CAP: Record<'read' | 'operate' | 'admin', Level> = { read: 'view', operate: 'operate', admin: 'manage' };

/** The single-owner implementation: see the header for exactly what it does. */
export const singleOwner: Authz = {
  mode: 'single-owner',

  can(actor, verb, object) {
    if (actor.kind === 'anonymous') return deny('unauthenticated');
    if (actor.kind === 'system') return { allow: true, level: 'manage' };
    const userId = actor.userId;
    if (!isUserId(userId)) return deny('actor_disabled');

    // What the way of acting allows at most.
    let cap: Level = 'manage';
    if (actor.kind === 'token') cap = SCOPE_CAP[actor.scope];
    if (actor.kind === 'agent') {
      cap = 'operate';
      if (object.type === 'session' && object.id !== actor.sessionId) return deny('agent_box');
      if (object.type === 'workspace' && object.id !== actor.workspaceId) return deny('agent_box');
      if (['platform', 'user', 'team', 'personal', 'target'].includes(object.type)) return deny('agent_box');
    }

    // What the user holds: by ownership where the type has a resolver, else everything for the one owner.
    let held: Level;
    const resolver = resolvers.get(object.type);
    if (!resolver) held = userId === FOUNDING_USER_ID ? 'manage' : 'none';
    else {
      const found = resolver.resolve(object.id, object.poolType);
      if (!found) return deny('not_found');
      if (found.owner === null) return deny('unowned');
      const own = found.owner.kind === 'user' && found.owner.id === userId;
      const platform = found.owner.kind === 'platform' && userId === FOUNDING_USER_ID;
      held = maxLevel(own || platform ? 'manage' : 'none', found.publicLevel ?? 'none');
    }

    const level = minLevel(held, cap);
    if (levelAtLeast(level, verb)) return { allow: true, level };
    if (LEVEL_RANK[held] >= LEVEL_RANK[verb]) return deny(actor.kind === 'agent' ? 'agent_box' : 'scope', level);
    return deny(LEVEL_RANK[level] > 0 ? 'no_right' : 'not_found', level);
  },

  levelOf(actor, object) {
    if (!can(actor, 'view', object).allow) return 'none';
    return can(actor, 'manage', object).allow ? 'manage' : can(actor, 'operate', object).allow ? 'operate' : 'view';
  },

  isPlatformAdmin: (userId) => userId === FOUNDING_USER_ID,

  ownersOf(object) {
    const found = resolvers.get(object.type)?.resolve(object.id, object.poolType);
    if (found?.owner?.kind === 'user') return [found.owner.id];
    return found?.owner ? [] : [FOUNDING_USER_ID];
  },

  usersWith(object, verb) {
    return this.can(owner(), verb, object).allow ? [FOUNDING_USER_ID] : [];
  },

  memberScope(actor, subject) {
    void subject;
    if (actor.kind === 'system') return { all: true, userIds: [] };
    const userId = actorUserId(actor);
    if (userId === FOUNDING_USER_ID) return { all: true, userIds: [] };
    return { all: false, userIds: userId ? [userId] : [] };
  },
};

let current: Authz = singleOwner;
/** The real layer calls this once at start-up. Tests may swap and restore. */
export const useAuthz = (impl: Authz): Authz => {
  const was = current;
  current = impl;
  return was;
};
export const authzMode = (): Authz['mode'] => current.mode;

/* ---------- What call sites use ---------- */

export const can: CanFn = (actor, verb, object) => current.can(actor, verb, object);
export const levelOf = (actor: Actor, object: ObjectRef): Level => current.levelOf(actor, object);
export const isPlatformAdmin = (userId: UserId): boolean => current.isPlatformAdmin(userId);
export const ownersOf = (object: ObjectRef): UserId[] => current.ownersOf(object);
export const usersWith = (object: ObjectRef, verb: Verb): UserId[] => current.usersWith(object, verb);
export const memberScope = (actor: Actor, subject: MemberScopeSubject): MemberScope => current.memberScope(actor, subject);

/** For code that holds a user id and not an actor (a usage `Visibility`, a notification routing): the same decision as `can`, for the user acting as a job. */
export const canUser = (userId: UserId, verb: Verb, object: ObjectRef): boolean => current.can(asUser(userId, 'check'), verb, object).allow;

/** The refusal as the portal answers it: 401, 404 (the same as a missing one: no existence leak) or 403 with what was needed. */
export function refusal(d: Extract<Decision, { allow: false }>, verb: Verb, object: ObjectRef): AppError {
  const status = statusForDeny(d.reason);
  if (status === 401) return new AppError('UNAUTHORIZED', 'Sign in again.');
  if (status === 404) return new AppError('NOT_FOUND', 'Not found.');
  if (d.reason === 'reauth') return new AppError('REAUTH_REQUIRED', 'Enter your password again.', { status: 403 });
  const details: ForbiddenDetails = { verb, have: d.level, object };
  return new AppError('FORBIDDEN', d.reason === 'platform_only' ? 'Only an admin can do this.' : 'You can’t do that here.', { details });
}

/** Throws the refusal, or returns. A handler calls this before it reads or changes anything the object holds. */
export function requireCan(actor: Actor, verb: Verb, object: ObjectRef): void {
  const d = current.can(actor, verb, object);
  if (!d.allow) throw refusal(d, verb, object);
}

/** Keeps the rows the actor may view: what every list returns. The owner's single-owner fast path returns the rows as they are. */
export function visible<T>(actor: Actor, type: ObjectType, rows: readonly T[], idOf: (row: T) => string, poolType?: ObjectRef['poolType']): T[] {
  if (actor.kind === 'system') return [...rows];
  if (current.mode === 'single-owner' && !resolvers.has(type) && actor.kind !== 'agent' && actorUserId(actor) === FOUNDING_USER_ID) return [...rows];
  return rows.filter((row) => current.can(actor, 'view', poolType ? { type, id: idOf(row), poolType } : { type, id: idOf(row) }).allow);
}

/* ---------- Actors ---------- */

/** The portal itself, for a named job (`system:reconciler`). */
export const systemActor = (job: string): Actor => ({ kind: 'system', job });
/** A job acting for a user: their rights, checked when it runs. */
export const asUser = (userId: UserId, job: string): Actor => ({ kind: 'job', userId, job });
/** The founding user as a signed-in person, for tests and scripts. */
export const ownerActor = (): Actor => owner();
export const anonymous = (): Actor => ANONYMOUS;

type Ctx = { get(key: string): unknown };

/**
 * Who is asking an HTTP request. The real layer's authenticate middleware sets `actor` on the context; until then a request that passed
 * `requireSession` (which sets `token`) is the owner. Call it in a handler, once.
 */
export function actorOf(c: unknown): Actor {
  const ctx = c as Ctx;
  const set = ctx.get('actor');
  if (set && typeof set === 'object' && 'kind' in set) return set as Actor;
  const token = ctx.get('token');
  return typeof token === 'string' && token ? owner() : ANONYMOUS;
}

/** Who opened a socket: the connection's `authorized` check (the module's own `portal.session(cookie)` call) decides signed in or not, until the real layer reads the user. */
export function actorOfSocket(req: IncomingMessage, authorized: (req: IncomingMessage) => boolean): Actor {
  return authorized(req) ? owner() : ANONYMOUS;
}

/** Who a Portal MCP principal is: an admin's token (`cpat_`) or an agent's per-session token (`cpst_`). The real layer reads the user from the token's owner. */
export function actorOfPrincipal(p: { kind: 'user' | 'agent'; tokenId: string; scope: string; workspaceId: string | null; sessionId: string | null }): Actor {
  if (p.kind === 'agent' && p.workspaceId && p.sessionId) return { kind: 'agent', userId: FOUNDING_USER_ID, tokenId: p.tokenId, sessionId: p.sessionId, workspaceId: p.workspaceId };
  const scope = p.scope === 'admin' || p.scope === 'operate' ? p.scope : 'read';
  return { kind: 'token', userId: FOUNDING_USER_ID, tokenId: p.tokenId, scope };
}
