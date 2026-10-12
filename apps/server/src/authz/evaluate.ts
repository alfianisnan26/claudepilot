// The decision function of the one authorization layer (docs/prd/authorization.md §10, FR1 to FR15): `decide(actor, verb, object)`, the
// only place a right is decided. It reads facts and never a secret: who the actor is (the user directory: state, role, token epoch, teams),
// what the object is (the module's resolver: owner, parent, public level, small attrs), and what grants give (the store's level query).
// Default deny: no resolver, no object, no owner, a resolver that throws, a user that is not active, all end in a refusal, and the refusal
// for what the actor may not even view is `not_found` (the wire says 404, the same as a missing object).
//
// The order, as the PRD writes it: anonymous → 401; system → allow; the user must be active; a dead token → 401; the object must resolve
// and have an owner; HELD = the most the user holds from ownership, the owning team, grants (direct and through teams), the type's public
// level, then the parent rule (`same` lifts the level to the parent's, `guard` demands operate on the parent to OPERATE), the private
// rule (a session: only its owner and its grantees, never its workspace's managers), the host-level rule (admins only); CAP = what the
// way of acting allows (a token's scope, an agent's operate inside its box); LEVEL = min(HELD, CAP).

import {
  FOUNDING_USER_ID,
  LEVEL_RANK,
  OBJECT_TYPES,
  PLATFORM_AREAS,
  isUserId,
  levelAtLeast,
  maxLevel,
  minLevel,
  type Actor,
  type Decision,
  type DenyReason,
  type Level,
  type ObjectRef,
  type PortalScope,
  type TeamId,
  type UserId,
  type UserRole,
  type Verb,
} from '@portal/contracts';
import { resolverFor, type ResolvedObject } from './seam.js';

/* ---------- What the evaluator reads ---------- */

export type UserState = 'active' | 'pending' | 'disabled';
export type TeamRole = 'owner' | 'member';

export interface UserFacts {
  id: UserId;
  role: UserRole;
  state: UserState;
  /** Moves past every token minted before (a disable, a reset): a token with an older epoch is dead (FR12). */
  tokenEpoch: number;
}

/** Who exists and what they are: the identity module's reader once it lands, a stub before (legacy: `u_owner`, an active admin). */
export interface UserDirectory {
  user(id: UserId): UserFacts | null;
  /** The user's current team memberships (team id → role). Empty until teams exist. */
  teamsOf(id: UserId): ReadonlyMap<TeamId, TeamRole>;
}

/** The level grants give one user on one object: the store's one query (store.ts). */
export interface LevelReader {
  granted(userId: UserId, ref: ObjectRef, objectUid: string | null, teams: ReadonlyMap<TeamId, TeamRole>, opts: { teamGrants: boolean }): Level;
}

export interface EvaluateDeps {
  users: UserDirectory;
  levels: LevelReader;
  /** `legacy`: the portal has one person, `u_owner`, who owns every object of a type that has no resolver yet (the seam's rule). `accounts`: no resolver, no right. */
  identity: 'legacy' | 'accounts';
  /** The epoch a token (`cpat_`) or agent token (`cpst_`) was minted at; null when unknown (before the Portal MCP retrofit records it). */
  tokenEpochOf?: (tokenId: string) => number | null;
  /** A target whose workspaces are a shell as the portal's OS user (`local`, `docker-host`, a native Connect host): admins only (D15). */
  hostLevelTarget?: (targetId: string) => boolean;
  log?: (line: string) => void;
}

/* ---------- Constants of the model ---------- */

const SCOPE_CAP: Record<PortalScope, Level> = { read: 'view', operate: 'operate', admin: 'manage' };
/** Platform areas every active user may `view` (the Claude Code pin and canary are facts every workspace runs on). The rest is admins' only. */
export const OPEN_PLATFORM_VIEW: ReadonlySet<string> = new Set(['version']);
/** Object types an agent's token never reaches, whatever its owner holds (FR13). */
const AGENT_NEVER: ReadonlySet<string> = new Set(['platform', 'user', 'team', 'personal', 'target']);
/** How far the parent chain is followed (a CI run → its workspace; a skill version → its source): two at most (FR8). */
const PARENT_DEPTH = 2;
/** How far an agent's descendants are followed when a session names its parent. */
const TREE_DEPTH = 8;

const deny = (reason: DenyReason, level: Level = 'none'): Decision => ({ allow: false, reason, level });

/* ---------- The held level ---------- */

type Held = { level: Level; found: ResolvedObject } | { level: 'none'; found: null; reason: 'not_found' | 'unowned' };

const loggedTypes = new Set<string>();

/** What a user holds on an object from ownership, teams, grants, the public level, the parent rule and the host-level rule. */
function held(d: EvaluateDeps, user: UserFacts, ref: ObjectRef, depth: number): Held {
  const resolver = resolverFor(ref.type);
  if (!resolver) {
    if (d.identity === 'legacy' && user.id === FOUNDING_USER_ID) return { level: 'manage', found: { ref, owner: { kind: 'user', id: FOUNDING_USER_ID } } };
    if (!loggedTypes.has(ref.type)) {
      loggedTypes.add(ref.type);
      d.log?.(`[authz] no resolver for object type "${ref.type}": every right on it is refused`);
    }
    return { level: 'none', found: null, reason: 'not_found' };
  }
  let found: ResolvedObject | null;
  try {
    found = resolver.resolve(ref.id, ref.poolType);
  } catch (e) {
    d.log?.(`[authz] the ${ref.type} resolver threw (${(e as Error).message}): refused`);
    return { level: 'none', found: null, reason: 'not_found' };
  }
  if (!found) return { level: 'none', found: null, reason: 'not_found' };
  if (found.owner === null) return { level: 'none', found: null, reason: 'unowned' };
  if (ref.type === 'platform' && !(PLATFORM_AREAS as readonly string[]).includes(ref.id)) return { level: 'none', found: null, reason: 'not_found' };

  const admin = user.role === 'admin';
  const teams = d.users.teamsOf(user.id);
  let level: Level = 'none';
  switch (ref.type) {
    case 'platform':
      level = admin ? 'manage' : OPEN_PLATFORM_VIEW.has(ref.id) ? 'view' : 'none';
      break;
    case 'user':
      // The account itself and a platform admin manage it (the handler keeps an admin out of its content); any active user may look a name up.
      level = found.ref.id === user.id || admin ? 'manage' : 'view';
      break;
    case 'team': {
      // Platform-owned, yet an admin gets nothing from it: the levels come only from membership (owners manage, members view).
      const role = teams.get(found.ref.id);
      level = role === 'owner' ? 'manage' : role === 'member' ? 'view' : 'none';
      break;
    }
    default: {
      const owner = found.owner;
      if (owner.kind === 'user' && owner.id === user.id) level = 'manage';
      else if (owner.kind === 'platform' && admin) level = 'manage';
      else if (owner.kind === 'team') {
        const role = teams.get(owner.id);
        level = role === 'owner' ? 'manage' : role === 'member' ? 'operate' : 'none';
      }
      // A session is private: workspace rights and team grants never reach it (FR9); its owner and the people a share names do.
      const uid = typeof found.attrs?.uid === 'string' ? found.attrs.uid : null;
      level = maxLevel(level, d.levels.granted(user.id, found.ref, uid, teams, { teamGrants: ref.type !== 'session' }), found.publicLevel ?? 'none');
    }
  }

  // The parent rule (FR8): a child of `same` inheritance has its parent's level too; `guard` is applied by `decide` (it depends on the verb).
  const info = OBJECT_TYPES[ref.type];
  if (info.inherit === 'same' && info.parent && found.parent && depth < PARENT_DEPTH) {
    const parent = held(d, user, found.parent, depth + 1);
    level = maxLevel(level, parent.level);
  }

  // Host-level (FR9 table, D15): a workspace that is a shell on the portal's host, or the target it runs on, is an admin's or nobody's.
  const hostLevel = found.attrs?.hostLevel === true || (ref.type === 'target' && d.hostLevelTarget?.(ref.id) === true);
  if (hostLevel && !admin) level = 'none';

  return { level, found };
}

/* ---------- The agent's box ---------- */

/** Whether a session is the agent's own or one it started (its parent chain reaches the agent's session). */
function inTree(d: EvaluateDeps, sessionId: string, agentSessionId: string): boolean {
  if (sessionId === agentSessionId) return true;
  const resolver = resolverFor('session');
  let id = sessionId;
  for (let i = 0; i < TREE_DEPTH; i++) {
    const parent = resolver?.resolve(id)?.attrs?.parentId;
    if (typeof parent !== 'string' || !parent) return false;
    if (parent === agentSessionId) return true;
    id = parent;
  }
  return false;
}

function inBox(d: EvaluateDeps, actor: Extract<Actor, { kind: 'agent' }>, ref: ObjectRef): boolean {
  if (AGENT_NEVER.has(ref.type)) return false;
  if (ref.type === 'session') return inTree(d, ref.id, actor.sessionId);
  if (ref.type === 'workspace') return ref.id === actor.workspaceId;
  return true; // the rest follows the owner's rights, capped at operate; the tools add their own limits
}

/* ---------- The decision ---------- */

/** `can`, the real one (§10). Synchronous; a handful of prepared statements at most; no network. */
export function decide(d: EvaluateDeps, actor: Actor, verb: Verb, ref: ObjectRef): Decision {
  if (actor.kind === 'anonymous') return deny('unauthenticated');
  if (actor.kind === 'system') return { allow: true, level: 'manage' };
  if (!isUserId(actor.userId)) return deny('actor_disabled');
  const user = d.users.user(actor.userId);
  if (!user || user.state !== 'active') return deny('actor_disabled');
  if (actor.kind === 'token' || actor.kind === 'agent') {
    const epoch = d.tokenEpochOf?.(actor.tokenId) ?? null;
    if (epoch !== null && user.tokenEpoch > epoch) return deny('owner_disabled');
  }

  const cap: Level = actor.kind === 'token' ? SCOPE_CAP[actor.scope] : actor.kind === 'agent' ? 'operate' : 'manage';

  const h = held(d, user, ref, 0);
  if (!h.found) return deny(h.reason);
  const found = h.found;
  let have = h.level;

  if (actor.kind === 'agent' && !inBox(d, actor, ref)) return deny(have === 'none' ? 'not_found' : 'agent_box', 'none');

  // The guard (FR8): operating a session, a Claude or a terminal also needs `operate` (the type's guard) on its workspace.
  const info = OBJECT_TYPES[ref.type];
  if (have !== 'none' && verb === 'operate' && info.inherit === 'guard' && info.guard && info.parent) {
    const parentLevel = found.parent ? held(d, user, found.parent, 1).level : 'none';
    if (!levelAtLeast(parentLevel, info.guard)) return deny('guard', minLevel(have, cap));
  }

  const level = minLevel(have, cap);
  if (levelAtLeast(level, verb)) return { allow: true, level };
  if (LEVEL_RANK[have] >= LEVEL_RANK[verb]) return deny(actor.kind === 'agent' ? 'agent_box' : 'scope', level);
  if (LEVEL_RANK[level] > 0) return deny('no_right', level);
  // Nothing at all: a session the actor cannot see inside a workspace they can is `private`; the wire says 404 either way.
  if (ref.type === 'session' && found.parent && held(d, user, found.parent, 1).level !== 'none') return deny('private');
  have = 'none';
  return deny('not_found', have);
}

/** The level an actor holds (`none` when nothing): three decisions at most, the cheap way round. */
export function levelHeld(d: EvaluateDeps, actor: Actor, ref: ObjectRef): Level {
  if (!decide(d, actor, 'view', ref).allow) return 'none';
  if (decide(d, actor, 'manage', ref).allow) return 'manage';
  return decide(d, actor, 'operate', ref).allow ? 'operate' : 'view';
}

/* ---------- Directories ---------- */

/** The legacy portal: one person, `u_owner`, an active admin; nobody else exists. */
export const legacyDirectory = (): UserDirectory => ({
  user: (id) => (id === FOUNDING_USER_ID ? { id, role: 'admin', state: 'active', tokenEpoch: 0 } : null),
  teamsOf: () => new Map(),
});

/** An in-memory directory for tests and the harness: add users and memberships, flip states and roles. */
export class MemoryUserDirectory implements UserDirectory {
  readonly #users = new Map<UserId, UserFacts>();
  readonly #teams = new Map<UserId, Map<TeamId, TeamRole>>();

  add(id: UserId, o: Partial<Omit<UserFacts, 'id'>> = {}): UserFacts {
    const u: UserFacts = { id, role: o.role ?? 'member', state: o.state ?? 'active', tokenEpoch: o.tokenEpoch ?? 0 };
    this.#users.set(id, u);
    return u;
  }
  set(id: UserId, o: Partial<Omit<UserFacts, 'id'>>): void {
    const u = this.#users.get(id);
    if (!u) throw new Error(`no user ${id}`);
    Object.assign(u, o);
  }
  join(userId: UserId, teamId: TeamId, role: TeamRole = 'member'): void {
    let m = this.#teams.get(userId);
    if (!m) this.#teams.set(userId, (m = new Map()));
    m.set(teamId, role);
  }
  leave(userId: UserId, teamId: TeamId): void {
    this.#teams.get(userId)?.delete(teamId);
  }
  user(id: UserId): UserFacts | null {
    return this.#users.get(id) ?? null;
  }
  teamsOf(id: UserId): ReadonlyMap<TeamId, TeamRole> {
    return this.#teams.get(id) ?? new Map();
  }
  /** Members of a team (for `usersWith` and the tests). */
  membersOf(teamId: TeamId): { userId: UserId; role: TeamRole }[] {
    const out: { userId: UserId; role: TeamRole }[] = [];
    for (const [userId, m] of this.#teams) {
      const role = m.get(teamId);
      if (role) out.push({ userId, role });
    }
    return out;
  }
  ids(): UserId[] {
    return [...this.#users.keys()];
  }
}
