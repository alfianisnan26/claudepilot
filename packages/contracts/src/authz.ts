// Authorization (docs/prd/authorization.md, docs/prd/multi-user.md): ONE default-deny layer that decides every right in the portal.
// `can(actor, verb, object)` is the only place a right is decided; routes, sockets, Portal MCP tools and jobs call it, and a resolver per
// object type is the only way a handler reads an object on someone's behalf. This file is the SHARED VOCABULARY (types, constants, the
// route-policy declaration, error codes): the server's layer is `apps/server/src/authz/` and, until it lands, `seam.ts` there (a default-allow
// for the one owner `u_owner`, with exactly these signatures). Code written against this file today keeps working when the layer lands.
//
// The model in one paragraph. Every object has an OWNER (a user, a team, or the platform) and optional GRANTS (a user or a team holds a LEVEL on
// it). A level is `view` < `operate` < `manage`, each including the ones before: view = see it and read what it holds; operate = use it
// (a workspace: start, stop, terminals, own sessions; a set: assign it; a ticket: comment and move it; a session: send, approve);
// manage = change it, share it, delete it. The owner holds `manage`. A platform admin administers the PLATFORM (users, registration,
// targets, settings, the library, backups) and holds NO right on another user's objects by being an admin: privacy is the default and the
// only ways in are a share or an audited reassignment. Tokens, agents and jobs are bound to a user and never exceed that user's rights
// AT USE TIME. No row means no right: an object the layer cannot resolve, or that nobody owns, is denied (and answered like a missing one).

import type { PortalScope } from './portalmcp.js';
import type { MultiPoolType } from './pools.js';

/* ---------- Users, owners, levels ---------- */

/**
 * A user's id. `u_owner` is the FOUNDING user (the id the single-owner install has always used, so the data that already says `u_owner` needs
 * no rewriting): the server code's sign-in, and the one email account marked as the founder (`users.founder`, migration 460). Every other id is
 * an email account's own: `u_` plus 12 base64url characters (identity/users.ts), so the pattern takes letters of both cases, digits, `-` and
 * `_` (organizations slice 0: the narrower hex-only pattern refused every real account id). An id is public, unguessable and never relied on:
 * access never follows from knowing one.
 */
export type UserId = string;
export const FOUNDING_USER_ID: UserId = 'u_owner';
export const USER_ID_PATTERN = /^u_[A-Za-z0-9_-]{1,40}$/;
export const isUserId = (v: unknown): v is UserId => typeof v === 'string' && USER_ID_PATTERN.test(v);

export type TeamId = string;
export const TEAM_ID_PATTERN = /^tm_[a-z0-9]{6,40}$/;

/** What a person may do with an object. Each level includes the ones before it. */
export const VERBS = ['view', 'operate', 'manage'] as const;
export type Verb = (typeof VERBS)[number];
export type Level = 'none' | Verb;
export const LEVEL_RANK: Record<Level, number> = { none: 0, view: 1, operate: 2, manage: 3 };
/** Whether `have` reaches `need`. */
export const levelAtLeast = (have: Level, need: Verb): boolean => LEVEL_RANK[have] >= LEVEL_RANK[need];
export const maxLevel = (...levels: Level[]): Level => levels.reduce<Level>((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a), 'none');
export const minLevel = (a: Level, b: Level): Level => (LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b);

export type OwnerKind = 'user' | 'team' | 'platform';
export type Owner = { kind: 'user'; id: UserId } | { kind: 'team'; id: TeamId } | { kind: 'platform' };

/** A user's role on the platform. `admin` administers the platform; it grants no right on other users' objects (see the header). */
export type UserRole = 'admin' | 'member';

/* ---------- Objects ---------- */

/**
 * What a right can be about. The table says, for each type, who may own it, whether it can be shared (`grants`), and how it relates to a
 * parent: `same` = it has its parent's level (a CI run is its workspace's), `guard` = its own rights apply but the actor must also hold
 * `guard` on the parent to OPERATE it (a session is its creator's, yet nobody operates it in a workspace they lost; reading, ending and deleting
 * their own transcript never needs the workspace), `none`.
 * `public` is the level every ACTIVE user holds without a grant (the reviewed library, a target an admin opened to everyone).
 */
export interface ObjectTypeInfo {
  label: string;
  owners: readonly OwnerKind[];
  /** Whether a share may give someone else a level on it. False: only the owner (and, for `platform`, admins) hold rights. */
  grants: boolean;
  parent?: ObjectType;
  inherit: 'same' | 'guard' | 'none';
  guard?: Verb;
  public?: Level;
  /** The id's shape, for the resolver and for tests. */
  id: string;
}

export type ObjectType =
  | 'platform'
  | 'user'
  | 'team'
  | 'target'
  | 'workspace'
  | 'claude'
  | 'session'
  | 'repo'
  | 'ci_repo'
  | 'ci_run'
  | 'terminal'
  | 'browser'
  | 'ticket'
  | 'ticket_bucket'
  | 'pool'
  | 'account'
  | 'endpoint'
  | 'account_pool'
  | 'vault'
  | 'mcp_entry'
  | 'skill_source'
  | 'skill_version'
  | 'proposal'
  | 'trigger'
  | 'budget'
  | 'template'
  | 'personal';

export const OBJECT_TYPES: Record<ObjectType, ObjectTypeInfo> = {
  /** The portal itself: areas named in `PLATFORM_AREAS`. Managed by platform admins; `view` by every active user only where an area says so. */
  platform: { label: 'Portal', owners: ['platform'], grants: false, inherit: 'none', id: 'an area of PLATFORM_AREAS' },
  /** An account. A user manages their own; an admin manages any account's state and role (never its objects). */
  user: { label: 'User', owners: ['platform'], grants: false, inherit: 'none', id: 'a user id' },
  /** A team. Its OWNERS manage it, its members view it; membership is in `team_members`, not in grants. */
  team: { label: 'Team', owners: ['platform'], grants: false, inherit: 'none', id: 'tm_…' },
  /** A place workspaces can run (Connect, Docker, This machine). Platform-owned; `operate` = place a workspace there. */
  target: { label: 'Target', owners: ['platform'], grants: true, inherit: 'none', id: 'the target id (docker, docker-host, local, …)' },

  workspace: { label: 'Workspace', owners: ['user', 'team'], grants: true, inherit: 'none', id: '<target>/<name>' },
  /** A Claude on a workspace: its Claude Code sign-in belongs to whoever signed it in. Using it needs `operate` on the workspace too. */
  claude: { label: 'Claude', owners: ['user'], grants: true, parent: 'workspace', inherit: 'guard', guard: 'operate', id: 'the workspace Claude id' },
  /** A chat session: private to its creator unless shared. Starting one needs `operate` on its workspace; the guard keeps it from outliving that right. */
  session: { label: 'Session', owners: ['user'], grants: true, parent: 'workspace', inherit: 'guard', guard: 'operate', id: 'the portal session id (an alias of a folded session resolves to it first)' },
  /** What lives in a workspace and is read through it (repositories, worktrees, CI runs and logs, the browser, terminals): the workspace's level. */
  repo: { label: 'Repository', owners: ['user', 'team'], grants: false, parent: 'workspace', inherit: 'same', id: 'a repository id of the workspace' },
  ci_repo: { label: 'CI remote', owners: ['user', 'team'], grants: false, parent: 'workspace', inherit: 'same', id: 'a CI repo id of the workspace' },
  ci_run: { label: 'CI run', owners: ['user', 'team'], grants: false, parent: 'workspace', inherit: 'same', id: 'a CI run id of the workspace' },
  terminal: { label: 'Terminal', owners: ['user'], grants: false, parent: 'workspace', inherit: 'guard', guard: 'operate', id: '<target>/<name>/<term>' },
  browser: { label: 'Browser', owners: ['user', 'team'], grants: false, parent: 'workspace', inherit: 'same', id: '<target>/<name>' },

  ticket: { label: 'Ticket', owners: ['user', 'team'], grants: true, inherit: 'none', id: 'T-<number>' },
  /** A bucket of tickets (T-1098): a project with its own id prefix. view = see it and its tickets; operate = file tickets in it; manage = change it. */
  ticket_bucket: { label: 'Ticket bucket', owners: ['user', 'team'], grants: true, inherit: 'none', id: 'the bucket key (KONF)' },
  /** A set of any pool type (secrets, skillset, mcpset, persona, context, browser): `poolType` on the ref. `operate` = assign it to a workspace you manage. */
  pool: { label: 'Set', owners: ['user', 'team'], grants: true, inherit: 'none', id: 'the pool id' },
  /** A Claude API key or a custom endpoint, and the account pools that group keys (Account Pool PRD). Using one delivers its key into workspaces. */
  account: { label: 'Account', owners: ['user', 'team'], grants: true, inherit: 'none', id: 'the account id' },
  endpoint: { label: 'Endpoint', owners: ['user', 'team'], grants: true, inherit: 'none', id: 'the endpoint id' },
  account_pool: { label: 'Account pool', owners: ['user', 'team'], grants: true, inherit: 'none', id: 'the account pool id' },
  /** A knowledge vault. Its notes, history, graph and files take its level. */
  vault: { label: 'Vault', owners: ['user', 'team'], grants: true, inherit: 'none', id: 'the vault id' },

  /** The reviewed library: MCP catalog entries and skills. Platform-owned and reviewed by admins; every active user may use what is approved. */
  mcp_entry: { label: 'MCP entry', owners: ['platform', 'user'], grants: false, inherit: 'none', public: 'operate', id: 'the catalog entry id' },
  skill_source: { label: 'Skill source', owners: ['platform', 'user'], grants: false, inherit: 'none', public: 'operate', id: 'the skill source id' },
  skill_version: { label: 'Skill version', owners: ['platform', 'user'], grants: false, parent: 'skill_source', inherit: 'same', public: 'operate', id: 'the skill version id' },
  /** A change an agent or a person proposed to a persona, a skill or a catalog entry, waiting for a person: its subject's level, `manage` to decide. */
  proposal: { label: 'Proposal', owners: ['user'], grants: false, inherit: 'none', id: 'the proposal id' },

  /** A scheduled or webhook-started job: its owner's, run with the owner's rights (triggers PRD). */
  trigger: { label: 'Trigger', owners: ['user'], grants: false, inherit: 'none', id: 'the trigger id' },
  /** A usage budget: its workspace's managers manage a workspace budget; admins manage the rest. */
  budget: { label: 'Budget', owners: ['user', 'platform'], grants: false, inherit: 'none', id: 'the budget id' },
  /** A workspace template (workspace-templates PRD): image tag, persona, sets, repos, settings, limits. Created from by anyone who holds `operate` on it AND on every set it names. */
  template: { label: 'Template', owners: ['user', 'team', 'platform'], grants: true, inherit: 'none', id: 'the template id' },
  /** One person's own: a Portal MCP token, a sign-in on a device, a notification destination, preferences, an answer token. Owner only, never shared. */
  personal: { label: 'Personal', owners: ['user'], grants: false, inherit: 'none', id: '<kind>:<id>' },
};

export const OBJECT_TYPE_IDS = Object.keys(OBJECT_TYPES) as ObjectType[];
export const isObjectType = (v: unknown): v is ObjectType => typeof v === 'string' && Object.hasOwn(OBJECT_TYPES, v);

/** Areas of the `platform` object: who may view and change what is not any one user's. Add one here, never a new free-form id. */
export const PLATFORM_AREAS = [
  'users', // accounts, roles, disabling, password resets, reassigning a disabled user's objects
  'registration', // the mode, invitations, pending sign-ups
  'settings', // the shared settings store (Bypass policy, caps, lockdown, retention, ...)
  'system', // the database, backups, the secret key, delivery pause (Access → Storage)
  'targets', // adding, enrolling and removing places for workspaces (Connect)
  'library', // approving and revoking MCP entries and skills; the built-in catalogue
  'audit', // the platform audit
  'emergency', // stop everything, revoke every token, lock Bypass (safety net)
  'version', // the Claude Code pin, the canary
  'usage', // Claude accounts' plan usage and the all-users views
  'notifications', // VAPID, the base URL, the ceiling on answers
  'devtools', // the developer inspector, logs and diagnostics bundle (metadata only: content views are checked per object)
] as const;
export type PlatformArea = (typeof PLATFORM_AREAS)[number];

/** Names one object. `poolType` is set for a `pool` (the URL's type must match the object's, or it is not found). */
export interface ObjectRef {
  type: ObjectType;
  id: string;
  poolType?: MultiPoolType;
}

export const objectRef = (type: ObjectType, id: string, poolType?: MultiPoolType): ObjectRef => (poolType ? { type, id, poolType } : { type, id });
export const objectKey = (r: ObjectRef): string => `${r.type}:${r.id}`;
export const workspaceRef = (id: string): ObjectRef => objectRef('workspace', id);
export const sessionRef = (id: string): ObjectRef => objectRef('session', id);
export const ticketRef = (id: string): ObjectRef => objectRef('ticket', id);
export const ticketBucketRef = (key: string): ObjectRef => objectRef('ticket_bucket', key);
export const poolRef = (id: string, poolType?: MultiPoolType): ObjectRef => objectRef('pool', id, poolType);
export const vaultRef = (id: string): ObjectRef => objectRef('vault', id);
export const platformRef = (area: PlatformArea): ObjectRef => objectRef('platform', area);
export const userRef = (id: UserId): ObjectRef => objectRef('user', id);
export const teamRef = (id: TeamId): ObjectRef => objectRef('team', id);

/* ---------- Actors ---------- */

/**
 * Who is acting. The rights are always those of a USER; the actor says how that user is acting and what caps them. A user's state and role are
 * read when the decision is made, never trusted from this object: disabling a user, or demoting an admin, takes effect on the next call.
 *
 * - `user`: a person in the web app (the session cookie), on the host through the CLI, or in a first-party client such as an editor extension
 *   (`via: 'client'`: a bearer token from the device flow, bound to the person and listed under their devices). `via: 'dev-seed'` only where the dev seed is on.
 * - `token`: a Portal MCP admin token (`cpat_`), bound to its creator. Its scope caps the creator's rights: read = view, operate = operate, admin = manage.
 * - `agent`: a per-session token (`cpst_`): the session's creator, capped at `operate`, and only inside its own session tree and workspace.
 * - `job`: the portal acting for an owner (a trigger, an auto transfer, a CI message, a notification answer): the owner's rights, checked when it runs.
 * - `system`: the portal itself (reconciler, probes, retention, migrations). Never a person's request: nothing it does is returned without a user filter.
 * - `anonymous`: no sign-in. Only `public` routes are open to it.
 */
export type Actor =
  | { kind: 'user'; userId: UserId; loginSessionId: string; via: 'ui' | 'cli' | 'dev-seed' | 'client'; ip?: string }
  | { kind: 'token'; userId: UserId; tokenId: string; scope: PortalScope }
  | { kind: 'agent'; userId: UserId; tokenId: string; sessionId: string; workspaceId: string }
  | { kind: 'job'; userId: UserId; job: string }
  | { kind: 'system'; job: string }
  | { kind: 'anonymous' };

export type ActorKind = Actor['kind'];

/** The user whose rights apply, or null for `system` and `anonymous`. */
export const actorUserId = (a: Actor): UserId | null => (a.kind === 'system' || a.kind === 'anonymous' ? null : a.userId);

/**
 * How an actor is written into an `actor` column or an audit row (the strings the portal already uses, plus `user:`). `user:<id>` replaces the
 * literal `ui`; a token and an agent keep `portal-mcp:<token id>` and `session:<id>` and are resolved to their user by `ownerOfActor`.
 * A string that is none of these (`ui`, `Admin`, `ticket:<id>`, `ci:<run>`) is read as it is: `ui` and `Admin` mean the founding user.
 */
export type ActorString = string;
export function actorString(a: Actor): ActorString {
  switch (a.kind) {
    case 'user':
      return `user:${a.userId}`;
    case 'token':
      return `portal-mcp:${a.tokenId}`;
    case 'agent':
      return `session:${a.sessionId}`;
    case 'job':
      return a.job;
    case 'system':
      return a.job.startsWith('system:') ? a.job : `system:${a.job}`;
    case 'anonymous':
      return 'anonymous';
  }
}

/** What an actor string names: `user:<id>` (and the legacy `ui` / `Admin`, the founding user), a token, an agent session, or a named job. */
export type ParsedActor =
  | { kind: 'user'; id: UserId; legacy: boolean }
  | { kind: 'token'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'job'; id: string; prefix: string }
  | { kind: 'system'; id: string }
  | { kind: 'unknown'; id: string };

export function parseActorString(s: string | null | undefined): ParsedActor {
  const v = (s ?? '').trim();
  if (v === 'ui' || v === 'Admin') return { kind: 'user', id: FOUNDING_USER_ID, legacy: true };
  const i = v.indexOf(':');
  const prefix = i < 0 ? v : v.slice(0, i);
  const rest = i < 0 ? '' : v.slice(i + 1);
  if (prefix === 'user' && isUserId(rest)) return { kind: 'user', id: rest, legacy: false };
  if (prefix === 'portal-mcp') return { kind: 'token', id: rest };
  if (prefix === 'session') return { kind: 'agent', id: rest };
  if (prefix === 'system') return { kind: 'system', id: rest };
  if (['ticket', 'ci', 'trigger', 'automove', 'notify', 'rule'].includes(prefix)) return { kind: 'job', id: rest, prefix };
  return { kind: 'unknown', id: v };
}

/* ---------- Decisions ---------- */

/** Why a right was refused. The wire never says more than the status: 401 for the first two, 404 for `not_found`, `unowned` and `private`, 403 for the rest. */
export type DenyReason =
  | 'unauthenticated' // no valid sign-in: 401
  | 'actor_disabled' // the user is disabled, still pending or gone: 401, and the sign-in ends
  | 'not_found' // no such object, or the actor may not view it: 404, the same answer as a missing one (no existence leak)
  | 'unowned' // the object has no owner row (default deny): 404 for everyone but a platform admin, who can claim it
  | 'private' // another user's private object (a session): 404, even to the workspace's managers
  | 'no_right' // the actor may view it but lacks the verb: 403
  | 'scope' // a token's scope is below the verb: 403
  | 'agent_box' // an agent outside its own session tree or workspace, or above `operate`: 403
  | 'platform_only' // needs a platform admin: 403
  | 'owner_disabled' // a token, an agent or a job whose user is disabled: 401 (the token is dead)
  | 'guard' // lacks the right on the parent the object needs (operating a session needs operate on its workspace): 403
  | 'reauth'; // needs a recent password check: 403 REAUTH_REQUIRED

export type Decision = { allow: true; level: Level } | { allow: false; reason: DenyReason; level: Level };

/** The signature of the decision. The server's `Authz.can` has exactly this shape; a handler never decides anything by another means. */
export type CanFn = (actor: Actor, verb: Verb, object: ObjectRef) => Decision;

/** HTTP status for a refusal (the wire never says more: PRD authorization §7). */
export function statusForDeny(reason: DenyReason): 401 | 403 | 404 {
  switch (reason) {
    case 'unauthenticated':
    case 'actor_disabled':
    case 'owner_disabled':
      return 401;
    case 'not_found':
    case 'unowned':
    case 'private':
      return 404;
    default:
      return 403;
  }
}

/* ---------- Route declarations (default deny) ---------- */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL';
/** `METHOD /full/path/with/:params`, exactly as the router lists it (`app.routes`). */
export type PolicyKey = `${HttpMethod} ${string}`;

/** One object a route needs a right on, named by a path parameter, a query parameter or a field of the JSON body. */
export interface ObjectCheck {
  type: ObjectType;
  verb: Verb;
  from: 'path' | 'query' | 'body';
  /** The parameter or field name (`id`, `workspaceId`). For `workspace` in a path written `/:target/:name`, `target+name`. */
  param: string;
  /** For a `pool`: the path parameter that carries the pool type, which the object must match. */
  poolTypeParam?: string;
  /** The parameter may be absent (a filter on a list): checked only when present. */
  optional?: boolean;
  /** The body field is a list of ids: every one is checked. */
  many?: boolean;
}

/**
 * What a route declares. A route with no declaration is refused (403 `NO_POLICY`) and a test fails on it, so there is no such thing as an
 * unreviewed route. `filter` names what a list route returns: the handler (or its service) takes the actor and returns only what it may view.
 */
export type RouteAccess =
  | { kind: 'public'; why: string }
  | { kind: 'signed-in'; filter?: ObjectType; creates?: ObjectType }
  | { kind: 'self' }
  | { kind: 'platform'; area: PlatformArea; verb: Verb }
  | { kind: 'objects'; checks: ObjectCheck[]; filter?: ObjectType; creates?: ObjectType }
  | { kind: 'bearer'; why: string }
  /** The route is its own door (a webhook with a signed secret, a connector with its node key); it never carries a user's cookie. */
  | { kind: 'handler'; checks: string[] };

export type RoutePolicy = RouteAccess & {
  /** A first-party client token (a device-flow sign-in, `via: 'client'`) may call this route. Default false: the cookie only. Never set on a route that needs `reauth`, `platform` or sharing. */
  bearer?: boolean;
  /** A recent password check is required (`403 REAUTH_REQUIRED`): sharing at manage, Bypass, tokens, role changes, deleting. */
  reauth?: boolean;
  /** An audit action written on success, with the actor. */
  audit?: string;
};

export type RoutePolicies = Partial<Record<PolicyKey, RoutePolicy>>;

/** One object a Portal MCP tool needs a right on, named by one of its arguments. */
export interface ToolObjectCheck {
  type: ObjectType;
  verb: Verb;
  /** The argument that carries the id (`workspace_id`, `session_id`, `id`). */
  arg: string;
  /** For a `pool`: the argument that carries the pool type. */
  poolTypeArg?: string;
  /** The argument may be left out (or empty): then nothing is checked for it. It must match the tool's input (a test walks every tool). */
  optional?: boolean;
  many?: boolean;
  /**
   * T-348: the text the tool itself answers NOT_FOUND with for a missing object of this argument ("No such run."), so a refusal at dispatch
   * reads byte for byte like a missing one. Default "Not found." (what `requireCan` says).
   */
  notFound?: string;
}

/**
 * What a Portal MCP tool declares (the registry refuses to start with a tool that has none, once the layer lands). The tool's `scope`
 * stays, as a CAP on the owner's rights; this says which objects the call touches. An agent's identity (its own session, workspace) is
 * verified from its token, never from arguments.
 *
 * T-348: the dispatch (`requireToolPolicy`, portalmcp/server.ts) enforces `objects` (every check through `can()`) and `platform` before the
 * handler runs; a refusal is NOT_FOUND. `signed-in` and `self` hold for every token; `filter`, `creates` and `agent` (whose reach comes
 * from the token, with no argument to check) are the handler's: it must enforce them itself.
 */
export type ToolAccess =
  | { kind: 'signed-in'; filter?: ObjectType; creates?: ObjectType }
  | { kind: 'objects'; checks: ToolObjectCheck[]; filter?: ObjectType; creates?: ObjectType }
  | { kind: 'platform'; area: PlatformArea; verb: Verb }
  | { kind: 'self' }
  | { kind: 'agent'; reach: 'session' | 'tree' | 'workspace' };
export type ToolPolicy = ToolAccess & { confirm?: boolean; audit?: string };
export type ToolPolicies = Record<string, ToolPolicy>;

/** A WebSocket path declares the same way; each message that names an object is checked again (the connection's actor is fixed at the handshake). */
export interface SocketPolicy {
  path: string;
  /** The handshake needs this much; messages that name an object check it themselves. */
  access: RouteAccess;
  /** What cuts an open connection at once: `signout`, `disable`, `revoke:<ObjectType>` (a share or membership that gave the right ended). */
  cutOn: ('signout' | 'disable' | 'revoke')[];
}

/* ---------- Wire fragments for lists and details ---------- */

/** Who owns something, for a row (never a secret, never more than a name). */
export interface OwnerSummary {
  kind: OwnerKind;
  id: string | null;
  /** The display name (a user's, a team's); `Portal` for the platform. */
  name: string;
  avatar: string | null;
}

/**
 * Added to every wire type of an object a person can list or open (workspace, session, ticket, set, vault, ...): the actor's own level, so the
 * page disables what is not allowed without guessing. The server enforces every verb regardless of what the client shows.
 */
export interface Access {
  owner: OwnerSummary;
  /** The signed-in person's level on it. */
  level: Level;
  /** Someone besides the owner holds a level on it (the list shows one small mark; the sharing sheet says who). */
  shared: boolean;
  /** How the person holds it: owned, through a share, through a team, as a platform admin, or because it is public. */
  via: 'owner' | 'share' | 'team' | 'platform' | 'public';
}

/** The body of a 403 for a missing level, so a page can say what it needs ("You can view this; operating needs Operate"). */
export interface ForbiddenDetails {
  verb: Verb;
  /** The level the person holds, when they may view it at all. */
  have: Level;
  object?: ObjectRef;
}

/* ---------- Error codes ---------- */

export const AUTHZ_ERROR_CODES = {
  /** A route or a tool with no declaration: refused until it has one (403). */
  NO_POLICY: 'NO_POLICY',
  /** A password check is needed first (shared with Bypass; defined in chat.ts as REAUTH_REQUIRED). */
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  /** The sign-in is over because the user was disabled or removed (401). */
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
} as const;
export type AuthzErrorCode = (typeof AUTHZ_ERROR_CODES)[keyof typeof AUTHZ_ERROR_CODES];

/* ---------- Per-user figures (usage follow-on, PLAN-12) ---------- */

/**
 * The set of users whose per-person figures (usage, approvals, Bypass) an actor may see in a scope. A platform admin sees every user; a
 * manager of a workspace sees its members; a team owner sees the team's; anyone else sees only themselves. `all` means every user: the
 * caller must not enumerate `userIds` then. A user outside the set is never counted, listed, coloured or named for this actor: figures for
 * them are left out, not shown as "others" (the rollups of a scope the actor may not see in full are the actor's own rows only).
 */
export type MemberScopeSubject = { kind: 'platform' } | { kind: 'workspace'; id: string } | { kind: 'team'; id: TeamId };
export interface MemberScope {
  all: boolean;
  userIds: UserId[];
}
