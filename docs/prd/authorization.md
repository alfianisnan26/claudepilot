# PRD: Authorization (one default-deny layer)

| | |
| --- | --- |
| Status | **Draft v0.1** (2026-10-12). Design only: `packages/contracts/src/authz.ts` and `apps/server/src/authz/seam.ts` (a single-owner seam with the final signatures, 11 tests, plus 9 contract checks in `authz/contracts.test.ts`) have landed and nothing else is built (**Not built**). Written from the code (audit in `COORD/p5-audit.md`, summarised in §2), OWASP's Authorization, IDOR and Session cheat sheets read on 2026-10-12, and scripts run here. ✅ = checked here (code read, script or test run), 📄 = documented (source linked), 🔬 = unverified: needs a running multi-user portal. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [Identity and onboarding](identity-onboarding.md) (who the actor is), [Pools foundation](foundation-pools.md) F1 (the store), [Portal MCP](portal-mcp.md) (tokens, the tool registry), [Chat sessions](chat-sessions.md) (sessions, sockets) |
| Related | [Multi-user overview](multi-user.md) (decisions, impact on every other plan, phases), [Sharing](sharing.md), [Teams](teams.md), [Settings & policies](settings-policies.md) |

## 1. Summary

Every right in the portal is decided in one place by one function: `can(actor, verb, object)`, where the verb is `view`, `operate` or `manage`, the object is named by a type and an id, and the actor is a person, a token bound to a person, an agent session, a job acting for a person, or the portal itself. Everything is **denied unless a rule allows it**: an object nobody owns, a type with no resolver, a route with no declaration, a tool with no declaration, an actor that is disabled. A route table, a tool table and a socket table declare what each door needs; one middleware, one tool wrapper and one socket check enforce the declarations; a test lists the real route table and fails for anything undeclared.

The model is deliberately small: an **owner** (a user, a team, or the platform) holds `manage`; **grants** (made by a share, see [Sharing](sharing.md)) give a user or a team a level; a **team** gives its owners `manage` and its members `operate` on what it owns; a few object types hang under a parent and either take its level or need it as a guard. Platform admins administer the PLATFORM and hold no right on anyone's objects by being admins. Existing data belongs to the founding account `u_owner`, so a one-person portal keeps working exactly as it does today.

## 2. Background and what exists

Checked on 2026-10-12 (✅); the symbol names are the evidence, line numbers move.

| Fact | Evidence | Consequence |
| --- | --- | --- |
| The guard is "signed in or not": `requireSession` is mounted on 24 groups; four socket files each re-implement Origin and cookie checks | `app.ts`, `live.ts`, `chat/socket.ts`, `workspaces/shell.ts`, `browser/socket.ts` | no object-level check anywhere; the policy middleware replaces the 24 mounts with one |
| The route table is enumerable: 267 method routes (261 from `createApp`, 6 from the browser module) plus `ALL /mcp` | `pu/dump-routes.mts` over the real app; `qa/auth.test.ts` already enumerates it | a declaration per route is practical, and the test that enforces it exists in spirit |
| Hono hands a middleware the composed pattern of the matched route (`c.req.matchedRoutes`: `ALL /api/*`, `ALL /api/chat/sessions/*`, `GET /api/chat/sessions/:id`); routing is strict (`/api/x/` is not `/api/x`) | Hono 4.13.13, script `pu/hono-routes.mjs` | one middleware can look up `METHOD pattern`; an undeclared or unmatched path is refused by default |
| 87 Portal MCP tools are gated by scope (`read`/`operate`/`admin`/`agent`) and rate, not by object | `portalmcp/registry.ts`, `server.ts`, tool files | tools declare the objects they touch; scope becomes a cap on the owner's rights |
| Services take no actor: `ChatController` (about 50 public methods), `Workspaces.list()`, `PoolService`, `AccountsService.overview`, `KnowledgeService.vaults`, `CiService` | the files named | list and read paths must be filtered by the actor BEFORE paging, counting and searching |
| `Tickets` has a `Caller` union (`ui`, `system`, `token`, `agent`) with `#visible` and `#assertCanModify`; `usagespend` has a `Visibility` hook; `glance` sources take `actorId`; 38 files already say `u_owner` | `tickets/service.ts`, `usagespend/actor.ts`, `glance/build.ts` | the actor concept is half there: the seam maps these onto `Actor` and `can` |
| The portal's identity of a workspace is `<target>/<name>` and the runtime is the record: a workspace has no database row | `workspaces/runtime.ts`, `manager.ts` | ownership needs its own table (`workspace_owners`) and a delete hook (`forgetWorkspace` already exists in four services) |
| A session can be addressed by an alias (a folded session's old id) | `chat/store.ts` `resolveId`, `chat_session_aliases`, `controller.resolve` | the session resolver must follow aliases before deciding, or an old id bypasses a check |
| Secrets, API keys and each Claude's sign-in are files in the workspace volume; anyone with a terminal reads them | foundation §10, secrets-env T4 | `operate` on a workspace is full trust inside it; the sharing rules (credentials default off) are the only honest answer |
| `@isnanme/core` has no authentication or authorization code; it gives `AppError` and its code registry, the envelope, ids | `node_modules/@isnanme/core` | nothing to wrap; new codes go through `defineErrorCodes` |

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **One layer, default deny.** `can()` is the only decision point; a route, tool, socket or job with no declaration is refused. |
| G2 | **Object-level, not page-level.** Every read and write of an object is checked against that object; lists, counts, searches, exports, graphs and subscriptions contain only what the actor may view. |
| G3 | **Tokens never exceed their owner.** Checked when the token is USED, not when it was made; a disabled owner kills them. |
| G4 | **No existence leaks.** What a person may not view is answered like what does not exist. |
| G5 | **Privacy by default.** A session is its creator's; a platform admin administers the platform, not people's work. |
| G6 | **Revocation is immediate and reaches everything downstream** (sockets, terminals, running sessions, assignments, notifications). |
| G7 | **Provable.** The declarations are data; a test enumerates the real route table; the cross-user abuse matrix is an executable suite generated from the declarations plus an independent hand-written oracle. |
| G8 | **A one-person install keeps working untouched**, and every plan in flight can adopt the seam now. |

## 4. Non-goals

- **A policy language** (Cedar, OPA/Rego, Casbin) or a relationship engine (Zanzibar: SpiceDB, OpenFGA). See D9: the object count, the verbs and the relations are few and fixed; a general engine is a dependency, a second language and a second thing to test.
- **Roles beyond `admin` and `member`.** Per-object levels carry everything else. A custom role editor is not built.
- **Field-level permissions.** A right is on an object; what a person may see inside it follows the verb (§9) and the existing redaction.
- **Isolation inside a workspace.** `operate` is a shell: the files, the delivered values and every Claude's sign-in in that workspace are reachable. The portal enforces rights at its own doors and says so on the sharing screen; it does not pretend to be a sandbox between two operators of one workspace.
- **SSO, passkeys, MFA** (a later round; the model leaves room: the `Actor` is how a person was authenticated, not what they may do).
- **A "view as" or impersonation mode** for admins (no break-glass in v1; see Q1).

## 5. Users and stories

| ID | Story |
| --- | --- |
| US1 | As a person, I see only what I own or was given, and a link to someone else's workspace looks like a link to nothing. |
| US2 | As a workspace owner, I give a colleague `operate` and know they can start, stop and open terminals but cannot read my sessions. |
| US3 | As an admin, I add and disable people and set how new ones join, without being able to read their sessions or secrets. |
| US4 | As the owner of a Portal MCP token, I know it can never do more than I can, and stops the moment I lose the right. |
| US5 | As an agent's owner, I know the agent in my session can only touch my session's tree and workspace, with my rights. |
| US6 | As a security reviewer, I read one table of routes and one of tools and see who may do what, and a test proves no route is missing. |
| US7 | As the single owner of a one-person install, nothing changes. |

## 6. Scope boundary

This PRD owns the model, the decision, the declarations and their enforcement at every door, and the test matrix. [Identity and onboarding](identity-onboarding.md) owns who the actor is. [Sharing](sharing.md) and [Teams](teams.md) own how grants and memberships are made. Each module's PRD keeps what its objects ARE; this PRD says who may do what to them, in the amendments listed in the [overview](multi-user.md) §17.

## 7. Solution overview

```
 request ─► authenticate ─► authorize ─► handler ─► service (takes the actor) ─► store
              │ cookie → Actor     │ route policy lookup (METHOD pattern, default deny)
              │ (user, active)     │ resolve objects (path/query/body) ─► resolver per type
              │                    │ can(actor, verb, object) ─► 401 / 404 / 403
 socket ──► handshake actor ───────┤ each message naming an object ─► can(...)
 MCP tool ► principal → Actor ─────┤ declared access ─► can(...); handlers use ctx.can
 job ─────► asUser(owner, job) ────┘ checked when it RUNS
```

- **Actor** (`authz.ts`): `user | token | agent | job | system | anonymous`. Rights are always a user's; the actor says how they act and what caps them.
- **Object** (`ObjectRef { type, id, poolType? }`): the types and their parents are `OBJECT_TYPES` (§9).
- **Level**: `none < view < operate < manage`. Held = max of ownership, grants, team membership, `public`, inheritance; then capped by the way of acting (token scope, agent `operate`).
- **404 or 403**: if the actor cannot even `view` the object the answer is `404 NOT_FOUND`, identical to a missing object; if they can view it but lack the verb it is `403 FORBIDDEN` with `details: { verb, have }`.

## 8. Functional requirements

### Model

- **FR1 (owners)** Every root object has exactly one owner: a user, a team or the platform (`OBJECT_TYPES[type].owners` says which). The owner holds `manage`. A team owner's members hold `operate` and its owners `manage` (`TEAM_MEMBER_LEVEL`, `TEAM_OWNER_LEVEL`).
- **FR2 (grants)** A grant gives a user or a team a level on one object. Grants come only from shares ([Sharing](sharing.md)); each carries the share that made it and an optional expiry, and is checked for expiry when used. A share to a team reaches its members while they are members.
- **FR3 (levels)** `view < operate < manage`, each including the ones before. The meaning per type is the matrix in §9. A grant never exceeds what the granter holds, and only an owner (or an owner of the owning team) grants `manage`.
- **FR4 (default deny)** No resolver for the type, no owner row, no matching grant or a resolver that throws: no right (`not_found` or `unowned`, logged). A route, tool or socket without a declaration is refused (`403 NO_POLICY`, logged loudly).
- **FR5 (no existence leak)** The refusal for an object the actor may not view is `404`, with the body of a missing object. Lists, counts, totals, search hits, tag lists, graph nodes and edges, export contents, usage rollups and live topics contain only what the actor may view; there is no "N hidden" anywhere. Error text never names another person's object.
- **FR6 (platform admins)** `role = admin` gives `manage` on `platform` areas ([`PLATFORM_AREAS`](../../packages/contracts/src/authz.ts)) and on `user` objects other than reading their content. It gives **no right on another user's workspaces, sessions, tickets, sets, vaults or accounts**. An admin gets in only by (a) a share like anyone, (b) **claiming** an unowned object, (c) **reassigning the objects of a disabled user** (audited per object, `object.reassigned`). There is no break-glass in v1 (Q1).
- **FR7 (public level)** An object type may give every active user a level without a grant (`OBJECT_TYPES[type].public`: the reviewed library at `operate`); a target an admin opened to everyone is `operate` through its own flag. A draft or proposal is not public: it is its author's until reviewed.
- **FR8 (inheritance)** `inherit: 'same'` types (repository, CI remote and run, browser) have their workspace's level; `inherit: 'guard'` types (session, Claude, terminal) have their own rights AND need `guard` (operate) on the workspace to be OPERATED, so a session never outlives the right to run in its workspace. `view` and `manage` of one's own session do not need the workspace: a person may always read, end, archive and delete their own transcript. Depth is at most two.
- **FR9 (private objects)** A session is visible to its owner and to those a share names. Nothing else grants it: not workspace `manage`, not a team, not `admin`. The deny reason is `private` and the answer is `404`.
- **FR10 (metadata and content)** On a workspace, `view` is metadata: name, state, owner, shares count, Claudes' names and sign-in state, repository tree and status. **File contents, diffs, terminals, `preflight`, the names of delivered secrets and anything that executes in the workspace need `operate`.** A session share includes the files and diff of that session's folder (the sharer sees this in the consent screen).
- **FR10a (a reused name is a new workspace)** A workspace id is `<target>/<name>`, and names get reused (a delete outside the portal, a re-create). Every `workspace_owners` row carries a random `uid`, made at creation; a grant on a workspace records that `uid`, and a grant whose `uid` differs from the current one is ignored (✅ asserted in `p5-schema-check.mts`). Creating a workspace over a stale row (the runtime no longer has it) replaces the row with a fresh `uid` and deletes the old uid's grants, shares and terminal rows; sessions keep their owner and lose any right they held through the old workspace.

### Actors

- **FR11 (user)** The actor of a signed-in request is read from the session cookie by `authenticate`; the user's state and role are read when `can` runs. A disabled or pending user gets `401` and the sign-in ends.
- **FR12 (token)** A Portal MCP admin token (`cpat_`) is bound to its creator (`pmcp_tokens.owner_id`, a `token_epoch`). Its scope caps the creator's rights (`read` = view, `operate` = operate, `admin` = manage). It stops working when the creator is disabled (the user's `token_epoch` moves past the token's) and loses any right the creator loses, at the next call. A token never grants anything the creator lacks, and a member may mint any scope: the effective right is the minimum.
- **FR13 (agent)** A per-session token (`cpst_`) is bound to its session. Its user is the session's OWNER, read at each call. It holds at most `operate`, only on its own session tree (the session and the sessions it started) and its own workspace, never on `platform`, `user`, `team`, `target` or `personal` objects, and dies with the session, the owner's right to operate the workspace, or the owner.
- **FR14 (job)** A scheduler that acts for a person (a trigger, an auto transfer, a notification answer, a CI message) runs as `asUser(ownerId, job)` and calls `can` when it RUNS. A disabled owner or a lost right skips the run, pauses the job and tells the owner.
- **FR15 (system)** The portal's own work (reconciler, probes, retention, migrations) runs as `system:<job>`. It returns nothing to a person without a filter and writes audit rows under its own actor string.

### Enforcement points

- **FR16 (routes)** The policy table is the union of each module's `authz.ts` (`declarePolicies`), keyed `METHOD /full/pattern`. One middleware, `authorize`, runs after `authenticate` for every request: it takes the last matched non-wildcard route from `c.req.matchedRoutes`, looks the key up, resolves the declared objects and calls `can`. A test lists `app.routes` and fails for a route with no declaration, a declaration with no route (drift), and a declaration whose `object` type has no resolver. A route may declare `bearer: true` so a first-party client token (`via: 'client'`, [Identity](identity-onboarding.md) FR51) can call it; the default is the cookie only, and `reauth`, `platform` and sharing routes can never be bearer. The initial table is Appendix A.
- **FR17 (object sources)** A check names its object by path, query or body field. A body is read by cloning the request (as `hostileWorkspaceField` already does, inside the size limits). When a route has several checks they are ANDed; a body field that disagrees with the path is checked on its own, never trusted instead of it.
- **FR18 (lists)** Services take the actor (or an already-resolved visible set) and filter BEFORE paging, counting, searching and aggregating. A list route declares `filter: <type>`; the matrix proves it.
- **FR19 (tools)** Every Portal MCP tool declares its access (Appendix B). The registry refuses to start with an undeclared tool. The wrapper checks declared object arguments before the handler; handlers get `ctx.can(verb, ref)` and `ctx.visible(...)`; the scope check stays, as a cap.
- **FR20 (sockets)** Each upgrade handler declares a `SocketPolicy` and gets its actor at the handshake. Every message that names an object is checked again (`subscribe` needs `view`; `send`, `respond`, `control` need `operate`). `onAccessChange` cuts what a user no longer holds, within one second, and sign-out and disabling cut everything (§9 of [Identity](identity-onboarding.md)). `/api/live` filters its `workspaces` and `usage` data per client.
- **FR21 (services)** A module API that reads or changes an object takes an `Actor` or an object the resolver already returned through `requireCan`. Resolvers are the only readers of ownership; no handler reads an owner column.
- **FR22 (re-auth)** A route marked `reauth` needs a password check within 10 minutes (`403 REAUTH_REQUIRED`, then the page asks for the password and retries): sharing at `manage`, ticking a credential, tokens, Bypass, role changes, deleting a workspace that holds secrets, the secret key, the emergency routes.

### Revocation and audit

- **FR23 (immediate)** A change of right (a share ended, a membership ended, a role changed, a user disabled, an owner changed) is effective on the next call, and `emitAccessChange` cuts the user's live sockets, terminals and running sessions they may no longer hold within one second.
- **FR24 (downstream)** Ending a share or a membership runs the assignment validity sweep ([Sharing](sharing.md) FR13): an assignment of a set or an account pool to a workspace stays only while some manager of the workspace holds `operate` on it. Agent tokens, pending answers and jobs follow the same rule.
- **FR25 (audit)** Denied decisions are counted per actor, route and type, and one row per actor, type and minute is written to the platform audit (`platform_audit`, [Identity](identity-onboarding.md) FR42: `kind` `authz.denied`) so a probe is visible without a flood. Sensitive allowed acts carry an `audit` action in their declaration and are written with the actor's `actorString`.
- **FR26 (shadow mode)** `PORTAL_AUTHZ=shadow` evaluates every declaration and records would-deny decisions without refusing; `enforce` is the default once the policy has run clean in shadow for a full test cycle. The mode is logged at start and shown to admins.
- **FR27 (fail closed)** A resolver that throws, a store that is Locked or Frozen for a write, a policy that cannot be parsed: deny and log. Reads on a read-only store follow the same rules.
- **FR28 (cost)** `can` is synchronous, answers from the database without network calls, memoises a user's team memberships for the request, and `visible()` filters a list in one query. A decision stays under a millisecond for the sizes here (§17).

## 9. Object types and the authorization matrix

The types are `OBJECT_TYPES` in [`authz.ts`](../../packages/contracts/src/authz.ts). The meaning of each verb:

| Object | Owners | view | operate | manage |
| --- | --- | --- | --- | --- |
| `platform` (an area) | platform | settings, trust state (any user, redacted) | | admins: change settings, registration, targets, library review, emergency, version pin, system (key, backups) |
| `user` | platform | the exact-username lookup (name, avatar) | | self: profile, password; admin: state, role, reset, reassign |
| `team` | platform | a member or invitee sees it | | its owners |
| `target` | platform | see it listed | place a workspace there | admins |
| `workspace` | user, team | state, Claudes' names, repo tree and status | start, stop, terminals, file contents and diffs, sessions of one's own, assign a set one may operate | change it, assign credentials, share, delete, agent access to portal tools, trust a folder |
| `claude` | user | name and sign-in state | start a session on it, use it for a Move | rename, sign in and out, remove |
| `session` | user | read the transcript, files and diff | send, answer approvals, interrupt, set model and effort | end, archive, delete, rename, Bypass |
| `repo`, `ci_repo`, `ci_run`, `browser` | of the workspace | tree, state, run list and logs, browser status | scan, worktrees, sync, start and cancel runs, merge, drive the browser | repo settings, CI remote setup |
| `terminal` | user | | attach, type | close (its creator, or a manager of the workspace) |
| `ticket` | user, team | read | comment, move, close, claim | assign, delete |
| `pool` (a set) | user, team | read its content (never a value) | assign it to a workspace the person manages (a secrets set: the values are delivered there) | edit, approve a revision, share, delete |
| `account`, `endpoint`, `account_pool` | user, team | name and state (never a key) | check it, put it in a pool, assign the pool to a workspace | edit, remove |
| `vault` | user, team | read notes, search, graph, export | write notes, daily notes, rescan | settings, agent policy, delete |
| `mcp_entry`, `skill_source`, `skill_version` | platform, user (drafts) | approved ones: everyone | everyone may use approved | author: edit drafts; admin: approve, revoke |
| `proposal` | the subject's owner | | | decide (approve or reject) |
| `trigger` | user | | | edit, enable, delete |
| `budget` | user, platform | | | per workspace: its managers; per Claude and global: admins |
| `template` | user, team, platform | see it | create a workspace from it (also needs `operate` on every set it names) | edit, share |
| `personal` | user | | | its owner only: tokens, sign-ins on devices, notification destinations, preferences |

**Role caps.** `member` and `admin` differ only on `platform` and `user`. An `admin` holds `manage` on nothing else by role.

**Host-level targets.** A workspace on a host-level target (`local` "This machine", `docker-host`, and a Connect single host that runs natively on the machine) can only be owned and operated by a platform admin; a share of it to a non-admin is refused (`SHARE_SUBJECT_INVALID`), and demoting an admin removes their access to such workspaces. Reason: `operate` there is a shell as the portal's OS user (audit finding F10).

## 10. The decision function

```
can(actor, verb, ref):
  anonymous                      → deny unauthenticated (401)
  system                         → allow
  user := users[actor.userId]    → none or state ≠ active → deny actor_disabled (401)
  token/agent: user.token_epoch > token.epoch → deny owner_disabled (401)
  object := resolver(ref.type).resolve(ref.id, ref.poolType)
  none                           → deny not_found (404)
  object.owner = null            → deny unowned (404; admins may claim)
  held  := max( owner(user)=manage                           // user-owned; or platform-owned and the user is an admin (never for a team)
              , teamRole(owner team)  → owner:manage, member:operate
              , grants to user, grants to user's teams       // not expired
              , object.publicLevel )
  parent rule (OBJECT_TYPES):  same  → held := max(held, level(parent))
                               guard → if verb = operate: need level(parent) ≥ guard, else deny guard (403)
  private (session)              → only owner and grants count; workspace rights ignored; none → deny private (404)
  user object                    → the account itself holds manage (its profile and password); a platform admin holds manage by role (state, role, reset)
  team object                    → owner is `platform` but an admin gets nothing from it: the levels come only from team_members (owner: manage, member: view)
  host-level workspace           → held := none unless user.role = admin
  cap   := actor.kind: user manage | token scope (read view, operate operate, admin manage)
                       | agent operate, and only in its own session tree and workspace (else deny agent_box)
  level := min(held, cap)
  level ≥ verb → allow(level)
  held ≥ verb  → deny scope | agent_box (403)
  level > none → deny no_right (403, details {verb, have})
  else         → deny not_found (404)
```

The level of one user on one object from ownership, grants and teams is one query (✅ run in `node:sqlite` against the real schema plus the new tables, with owner, team owner, team member, direct grant, team grant, expiry, leaving a team and revoking a share all asserted; `COORD/p5-schema-check.mts`):

```sql
SELECT max(rank) AS rank FROM (
  SELECT 3 AS rank WHERE ?5 = 'user' AND ?6 = ?1                                   -- owner
  UNION ALL
  SELECT CASE m.role WHEN 'owner' THEN 3 ELSE 2 END FROM team_members m            -- team-owned: owners manage, members operate
    WHERE ?5 = 'team' AND m.team_id = ?6 AND m.user_id = ?1
  UNION ALL
  SELECT CASE g.level WHEN 'manage' THEN 3 WHEN 'operate' THEN 2 ELSE 1 END FROM grants g
    WHERE g.object_type = ?2 AND g.object_id = ?3 AND g.subject_kind = 'user' AND g.subject_id = ?1
      AND (g.expires_at IS NULL OR g.expires_at > ?4) AND (g.object_uid IS NULL OR g.object_uid = ?7)
  UNION ALL
  SELECT CASE g.level WHEN 'manage' THEN 3 WHEN 'operate' THEN 2 ELSE 1 END FROM grants g
    JOIN team_members m ON g.subject_kind = 'team' AND g.subject_id = m.team_id AND m.user_id = ?1
    WHERE g.object_type = ?2 AND g.object_id = ?3 AND (g.expires_at IS NULL OR g.expires_at > ?4) AND (g.object_uid IS NULL OR g.object_uid = ?7)
)  -- ?1 user, ?2 type, ?3 id, ?4 now (ISO), ?5 owner kind, ?6 owner id, ?7 the object's uid (a workspace's; NULL for the rest): all from the resolver
```

## 11. Resolvers, owners in the schema, and the retrofit

One resolver per object type, written by the module that owns the type, in `<module>/authz.ts`, registered at start-up (`registerResolver`); `resolve(id)` returns `{ ref, owner, parent?, publicLevel?, attrs? }` or `null`, cheaply and with no secret. Aliases are followed inside `resolve`.

Where each owner is stored (the retrofit migration, block 400-459; ✅ the `ALTER`s run on the real schema, existing rows take `u_owner`):

| Type | Storage |
| --- | --- |
| workspace | new `workspace_owners (workspace_id, uid, owner_kind, owner_id, created_by, created_at, origin)`; pending creates carry the owner; `forgetWorkspace` deletes the row; a workspace found in a runtime with no row is *unclaimed* |
| session | `chat_sessions.owner_id` (access), `created_by_user` (attribution, NULL before users), `root_id` (the top of the `parent_id` chain) |
| claude | `workspace_claudes.owner_id` |
| ticket, pool (incl. `account` pools), account, endpoint, vault | `owner_kind`, `owner_id` on `tickets`, `pools`, `accounts`, `endpoints`, `kg_vaults` |
| token | `pmcp_tokens.owner_id`, `token_epoch`; `pmcp_agent_tokens.token_epoch`; an agent's user is read from its session |
| terminal | new `terminal_owners (workspace_id, workspace_uid, term_id, owner_id, created_at)` |
| mcp_entry, skill_*, template | `owner_kind` default `platform`; a draft's author is its owner |
| repo, ci_repo, ci_run, browser, budget | by their workspace (children) or their scope |

`multi_user_since` (an ISO time) is written to `portal_meta` by the migration: rows older than it were made before accounts existed ([overview](multi-user.md) §13 explains what the usage track does with it).

## 12. Threat model and the executable test matrix

Principle (OWASP IDOR cheat sheet 📄): an unguessable id is defence in depth, never the control; the check is per object on every request, covering read, create, update, delete, export and admin actions, with at least two accounts that own objects of each type. Here the matrix is **generated from the declarations** (so a new route is tested the moment it is declared) and **checked against an independent hand-written oracle** (so a wrong declaration is caught).

### 12.1 The harness

`apps/server/src/qa/crossuser/` builds the real `createApp` with real in-memory services (not stubs) and these accounts: `alice` (member, owns everything in the fixture), `bob` (member, no rights), `carol` (member, holds `view` through a share and `operate` through another), `dave` (member of alice's team), `root` (platform admin, owns nothing), `anon`. A fixture factory makes one object of each type per owner (and a child where the type has one). Every request goes through `app.request` with the real cookie, so authenticate, authorize, handlers and services all run.

### 12.2 Generated probes (from `RoutePolicies`)

For every route whose policy names an object: request it as `bob` with alice's object in each place the declaration says (path, query, body). Expected: `404`, a body equal to the body of a missing object, and no byte of alice's data. As `carol` (view only): allowed iff the declared verb is `view`, else `403` with `details.verb`. As `root` (admin, not a grantee): `404` for every user-owned object. As `anon`: `401`. For every `in:list(T)` route: alice makes two, bob one: bob's list, total, `nextCursor` pages, search, tags, export and counts hold only bob's.

### 12.3 The abuse cases (hand-written oracle; each has an ID the test names)

| ID | Case | Expected |
| --- | --- | --- |
| X1 | B reads, lists, counts, searches, exports or subscribes to A's object of every type (workspace, session, ticket, set, account, vault, CI run, repo, Claude, budget, proposal, token, trigger) | 404 / empty; the same body as a missing object |
| X2 | B mutates A's object: PATCH, PUT, DELETE, POST actions (end, archive, rename, assign, share, approve, close, rotate, revoke) | 404; nothing changes (checked by reading as A afterwards) |
| X3 | B creates inside A's container: a session in A's workspace, a ticket linked to it, a note in A's vault, a worktree, a CI run, an assignment of A's set | 404 (not 403: B may not know the container exists) |
| X4 | Mass assignment: `ownerId`, `owner_id`, `ownerKind`, `createdBy`, `userId`, `role`, `state`, `level`, `shareId`, `teamId` in any create or update body | ignored; the owner is the actor; role and state unchanged |
| X5 | Path/body/query disagreement: `PUT /api/pools/secrets/<A's>` with a body naming B's id; `POST /api/chat/sessions {workspaceId: A's}` while the path or query names B's | each named object is checked on its own: 404 |
| X6 | Alias and spelling variants: a folded session's old id, mixed case, trailing slash, `//`, `%2f`, `..`, `HEAD` for `GET`, `X-HTTP-Method-Override` | the same decision as the canonical spelling; the strict router answers 404 for the rest |
| X7 | Child ids under another parent: `GET /api/chat/sessions/<B's>/blobs/<A's blob sha>`, `.../files?path=`, a CI run id under another repo, a version id under another pool | 404: a child is served only through its own parent's link |
| X8 | Sockets: B subscribes to A's session on the chat socket; sends, responds, controls; opens A's shell; attaches `?term=claude-1` of A's; opens A's browser view | refused, no event delivered, the same close/ack as a missing session |
| X9 | Live: B's `/api/live` snapshot and `usage` frames | contain only B's visible workspaces; a share to B adds, revoking removes within one update |
| X10 | Revocation: A shares to C, C opens a session, a socket and a shell, A revokes | C's next call is 404; C's sockets close within 1 s; C's running session in A's workspace ends; C's assignments of A's set are removed |
| X11 | Tokens: C's `read` token calls a write tool; A's token after A is disabled; C's token for A's session id; an agent of S1 reaching S2, the workspace's other sessions, `platform`, `user` | scope refusal; 401; 404; `agent_box` |
| X12 | Jobs: a trigger whose owner lost `operate`; an auto transfer to a Claude its owner cannot operate; a notification answer token presented by another user | skipped and paused; refused; refused |
| X13 | Private sessions: workspace owner A (manager) reads C's session in A's workspace | 404 (`private`) |
| X14 | Admin: `root` reads A's session, secrets set, ticket, vault; `root` lists all users | 404 for objects; the user list works (platform) |
| X15 | Credentials: share a workspace with a secrets set assigned, unticked | the set is removed from the workspace; ticked: warning acknowledged, audit `credential.exposed` |
| X16 | Host-level target: share a `local` workspace to a member; demote an admin who owns one | refused; their access ends |
| X17 | Side channels: tag lists, graph edges, usage palette keys, persona identities, audit rows, setting audit, error text naming another person's object, `409 name taken` | only visible items; names taken are the one accepted residual (R3) |
| X18 | Ids: sequential ticket numbers and sequential CI run numbers enumerated by B | 404 for every id B may not view; no timing difference beyond noise (🔬) |
| X19 | Policy hygiene: an undeclared route; a declared route that does not exist; a tool without access; a resolver-less type used in a declaration | the enumeration test fails |
| X20 | Shadow vs enforce: the same suite in both modes | shadow records the same would-deny set the enforce mode refuses |
| X21 | A shared workspace is removed outside the portal and a new one is created with the same name by another user | the old grants and shares do nothing for the new workspace (uid mismatch); the old sharee's sessions lose their workspace right |

### 12.4 Residual risks (accepted, stated)

| ID | Risk | Why accepted |
| --- | --- | --- |
| R1 | `operate` on a workspace is a shell: files, delivered values and every Claude's sign-in in it are readable | the model says so; the sharing screen says so; credentials default off |
| R2 | The `/api/live` nudge topics (`tickets`, `ci`, `repos`, `claudeusage`, `glance`, `pools`, `accounts`) say "something changed" to every subscriber | no data; the page refetches through authorized routes; per-topic relevance is an improvement, not a requirement |
| R3 | Unique names (a workspace `<target>/<name>`, a team name, a username) answer "taken" to a person who cannot see the holder | inherent to unique names; throttled; never the holder's identity |
| R4 | A platform host operator reads the database and the volumes | out of scope: the portal is a self-hosted tool; the audit is about people, not the host |

### 12.5 Coverage: object type by door

Counts come from the policy tables of Appendix A and B (rows whose access names the type; 2026-10-12). A type with no route today (users, teams, triggers, templates) gets its rows from the package that adds its routes; the suite fails if a declared route or tool names a type that has no fixture.

| Object type | Routes | Tools | Socket messages | Jobs that act on it |
| --- | --- | --- | --- | --- |
| `platform` | 16 | 4 | | backup, retention, reconciler, probes (`system`) |
| `target` | 2 | 1 | | Connect hub (`system`) |
| `workspace` | 59 | 14 | shell and browser handshakes, live snapshot | trigger runs, maintenance, repo scans, version canary |
| `claude` | 24 | 3 | | auto transfer, Claude usage probes |
| `session` | 27 | 7 | `subscribe`, `send`, `respond`, `control`, `btw_ask`, `btw_cancel`, `btw_pin` | trigger sessions, auto transfer, CI messages, notification answers |
| `terminal` | 2 | 0 | shell attach (`?term=`) | |
| `repo`, `ci_repo`, `ci_run` | 8, 8, 5 | 5, 2, 5 | | CI runner, repo scans |
| `ticket` | 12 | 8 | | trigger tickets, CI checks |
| `pool`, `account`, `endpoint`, `account_pool` | 25, 10, 4, 5 | 7, 2, 0, 2 | | delivery and the assignment sweep, account health probes |
| `vault` | 34 | 11 | | the indexer (`system`), agent notes |
| `mcp_entry`, `skill_source`, `skill_version`, `proposal` | 8, 2, 3, 2 | 4, 0, 0, 0 | | library verification (`system`) |
| `budget` | 3 | 2 | | budget and spike alerts to their owner |
| `user`, `team`, `trigger`, `template`, `personal` | 0, 0, 0, 0, 1 | 0 | | trigger scheduler, notification delivery |

## 13. Data model

New tables (block 400-459; ✅ run in `node:sqlite` on the real schema, `COORD/p5-schema-check.mts`):

```sql
CREATE TABLE workspace_owners (
  workspace_id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,                    -- fresh at every creation: a name reused later is a different workspace
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user', 'team')),
  owner_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('created', 'claimed', 'migrated'))
) STRICT;
CREATE INDEX workspace_owners_owner ON workspace_owners (owner_kind, owner_id);

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL, object_id TEXT NOT NULL,
  object_uid TEXT,                      -- a workspace's uid when the grant was made; a grant with another uid is ignored
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user', 'team')),
  subject_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('view', 'operate', 'manage')),
  share_id TEXT NOT NULL, granted_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT
) STRICT;
CREATE UNIQUE INDEX grants_unique ON grants (object_type, object_id, subject_kind, subject_id, share_id);
CREATE INDEX grants_object ON grants (object_type, object_id);
CREATE INDEX grants_subject ON grants (subject_kind, subject_id);
CREATE INDEX grants_share ON grants (share_id);

CREATE TABLE terminal_owners (          -- tmux sessions have no row of their own
  workspace_id TEXT NOT NULL, workspace_uid TEXT NOT NULL, term_id TEXT NOT NULL,
  owner_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, term_id)
) STRICT;
```

`shares` is in [Sharing](sharing.md) §13, `users`, `login_sessions` and the platform audit's added columns in [Identity](identity-onboarding.md) §13, `teams`, `team_members`, `team_invites` in [Teams](teams.md) §13. The retrofit `ALTER`s (✅ run on the real 52-migration schema; existing rows take `u_owner`; sessions get their `root_id` by a recursive query):

```sql
ALTER TABLE chat_sessions ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'u_owner';
ALTER TABLE chat_sessions ADD COLUMN created_by_user TEXT;     -- NULL: made before users existed
ALTER TABLE chat_sessions ADD COLUMN root_id TEXT;
ALTER TABLE chat_usage ADD COLUMN user_id TEXT;                -- stamped when a turn is recorded; NULL before users
ALTER TABLE chat_requests ADD COLUMN decided_by_user TEXT;
ALTER TABLE chat_requests ADD COLUMN decided_via TEXT;         -- ui | mcp | rule | notification
ALTER TABLE workspace_claudes ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'u_owner';
ALTER TABLE tickets ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'user';
ALTER TABLE tickets ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'u_owner';
-- the same pair on pools, accounts, endpoints, kg_vaults
ALTER TABLE pmcp_tokens ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'u_owner';
ALTER TABLE pmcp_tokens ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pmcp_agent_tokens ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pmcp_audit ADD COLUMN actor_user TEXT;
INSERT INTO portal_meta (key, value) VALUES ('multi_user_since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT (key) DO NOTHING;
```

## 14. API

Authorization adds few routes of its own; the rest is declarations on existing ones.

| Route | Access | What |
| --- | --- | --- |
| `GET /api/access?type=&id=` | object manage | who holds what on one object (`AccessList`) |
| `GET /api/admin/unclaimed` | platform(users) | objects found with no owner (a workspace in a runtime, a restored row) |
| `POST /api/admin/unclaimed/claim` | platform(users) +reauth | `{ ref, to: user\|team }`: gives an unowned object an owner; audit `object.claimed` |
| `POST /api/users/:id/reassign` | platform(users) +reauth | moves every object of a DISABLED user to another user; audit `object.reassigned` per object |

Errors: `401 UNAUTHORIZED`, `404 NOT_FOUND` (not viewable or missing), `403 FORBIDDEN` with `details: ForbiddenDetails`, `403 REAUTH_REQUIRED`, `403 NO_POLICY`. The page shows, for a 403, "You can view this; operating needs Operate" from `details`; for a 404 it shows what it shows for any missing thing.

## 15. What the person sees

Within the text diet. A list row carries one small mark when something is shared (a people icon with an accessible name) and the person's level where it differs from `manage` ("View", "Operate" as a quiet chip in the row's detail, not a badge on every row). An action the person cannot do is disabled with a title from `ForbiddenDetails`. A 404 on a deep link shows the page's normal "not found". The sharing and access screens are in [Sharing](sharing.md) §15. Admin screens (People, Registration, Unclaimed) are in [Identity](identity-onboarding.md) §15.

## 16. Migration of existing data

1. The migration (block 400-459) creates the tables above, adds the owner columns (existing rows take `u_owner`) and writes `multi_user_since`. The pre-migrate backup of the store is automatic (existing behaviour, `Store.backup('pre-migrate')`).
2. The portal starts with **zero users** and goes to setup mode ([Identity](identity-onboarding.md) §6). While it waits, `/api/*` except setup and the status route answers `409 SETUP_REQUIRED`; sessions already running in workspaces and every background job continue; agent tokens of running sessions fail with 401 until the account exists (their owner is `u_owner`).
3. Creating the first account gives it the id `u_owner`, role `admin`, and **claims every workspace the runtimes list at that moment** (`workspace_owners.origin = 'migrated'`) in the same step. A workspace the runtimes could not list (a target down) appears in Unclaimed and is claimed later.
4. Everything else already says `u_owner`. Nothing is rewritten.
5. Down-migration is not supported: an older portal opening the new schema freezes (the existing newer-schema guard).

## 17. Testing and verification

Done here (✅): the seam's 11 tests (single-owner behaviour, scope caps, agent box, resolver-driven default deny, `requireCan` statuses, `actorOf`, actor strings, declarations, access-change events, `useAuthz` swap); the schema script (owner/team/audit/invite invariants, the level query, the `ALTER`s on the real schema); the route and tool enumerations (267 and 87, each covered once by the generated tables).

To build (work packages A2, A9): the enumeration test (FR16, X19), the generated probe suite and the oracle (§12), the socket and live suites (X8-X10), the token/agent/job suites (X11-X12), shadow-vs-enforce parity (X20), and a micro-benchmark that asserts `can` stays under a millisecond with 1,000 grants and 50 teams and `visible()` filters 5,000 rows under 20 ms (🔬 until run).

## 18. Milestones

| Milestone | Scope | Gate | Status |
| --- | --- | --- | --- |
| A0 | contracts, the seam, tests, the adoption rules | none | **Built** (2026-10-12) |
| A1 | identity core ([Identity](identity-onboarding.md)) | A0 | **Not built** |
| A2 | the real layer: `can`, resolvers' registry, the policy middleware in shadow mode, `authz.denied` audit, the enumeration test | A0 | **Not built** |
| A3 | ownership retrofit and the declarations of every module, list filtering | A1, A2; the module's owner reports done | **Not built** |
| A4 | sockets, live hub, Portal MCP binding, jobs | A2 | **Not built** |
| A5 | flip to `enforce`, remove the server-code login | A3, A4, the matrix green | **Not built** |

(The full package list, with files, interfaces and quiescence conditions, is `COORD/p5-workbreakdown.md`, summarised in [the overview](multi-user.md) §14.)

## 19. Decisions

| ID | Decision | Rejected, and why |
| --- | --- | --- |
| D9 | **Owner + grants + teams + one `can()`, with a resolver per type.** About 25 object types, three verbs, one relation (membership), one inheritance rule | **A Zanzibar-style relation-tuple engine** (SpiceDB, OpenFGA): right for millions of objects and arbitrary userset rewrites; here it is a service or a library to deploy, a schema language, and a second place to read to know who may do what. **ABAC or a policy language** (Cedar, OPA): flexible, but a language to learn, a dependency, and policies detached from the code that owns the objects. **Global RBAC only**: cannot say "operate on this workspace". The OWASP guidance to prefer ABAC/ReBAC over RBAC 📄 is met by object-level relations (owner, grant, membership) without an engine |
| D10 | **One central policy table + one middleware**, default deny (`NO_POLICY`), the table merged from per-module `authz.ts` files | **A guard call inside each handler**: 267 places to forget, nothing to enumerate. **A route wrapper `r.get(path, policy, handler)`**: enforceable by types but touches every registration line (the same churn as the retrofit) and cannot fail closed for a route added without it |
| D11 | **404 for what the actor may not view, 403 for what they may view but not do** | 403 everywhere: leaks existence |
| D12 | **Platform admins hold no right on users' objects** | admins reading everything: it makes a multi-user portal a one-user portal with extra steps and makes every admin account a breach of every person |
| D13 | **Tokens and agents: the owner's rights at use time, capped by scope; an epoch kills them** | storing a snapshot of rights at mint time (stale after any change); deleting rows on disable (misses tokens minted in a race; the epoch is one comparison) |
| D14 | **Sessions are private; workspace rights never reach them** | workspace managers reading transcripts: a transcript holds what a person typed |
| D15 | **Host-level targets are admin-only, enforced by the resolver** | relying on the owner to remember not to share "This machine" |
| D16 | **Shadow mode before enforce** | flipping on a policy never run against real traffic |

## 20. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | Break-glass for admins: should an admin be able to read a person's objects after a typed reason, loudly audited and notified to the owner? The model leaves room (an `admin` cap with a time-boxed elevation); v1 has none | Owner |
| Q2 | May a member approve their own MCP catalog entries and skills for their own sets, with admins approving only what is shared platform-wide? v1: admins approve everything (the library is platform-owned) | Owner |
| Q3 | Should a note have its own owner and share (a Notion-like page share)? v1: the vault is the unit | Product |
| Q4 | Per-topic relevance on `/api/live` nudges (R2)? | Product |
| Q5 | Should `view` on a workspace show its repository tree, or nothing but its name and state? v1 shows the tree and status, no contents | Owner |


## Appendix A. Route policy v0: every route of the real route table

Generated from the REAL app (`createApp` with stub services, `app.routes`: 261 routes, plus the 6 browser routes whose module was stubbed = **267**) and checked for coverage: every route is declared exactly once and no rule is unused. It is the starting declaration of work package MU2; the enumeration test (FR16) fails on any route not in it. Notation: `public`; `in` = any active user (the handler returns the person's own data or a filtered one); `in:list(T)` = signed in and the list holds only objects of type T the person may view; `in:create(T)` = signed in, the new object is owned by the creator; `obj(T verb from param)` = a right on one object named in the path, query or body (several are ANDed); `platform(area,verb)` = platform admins; `self` = the caller's own account or tokens; `+reauth` = a recent password check; `REMOVED` = the route goes away with the server code.

| Route | Access | Note |
| --- | --- | --- |
| `GET /healthz` | public | liveness |
| `GET /api/session` | public | AuthStatus: who is signed in, setup, registration mode, devSeed |
| `POST /api/login` | public | dev seed only: 404 unless PORTAL_DEV_SEED (never in production) |
| `POST /api/logout` | public | clears the cookie; works with or without a session |
| `GET /api/admin/state` | REMOVED | returns the server code in clear to every signed-in tab: replaced by Me and the devices list |
| `POST /api/admin/code` | REMOVED | rotating the shared code: gone with it |
| `PUT /api/admin/enabled` | platform(registration,manage) | sign-in switch moves to IdentitySettings.signInEnabled; reauth |
| `POST /api/admin/system/key/reset` | platform(system,manage) +reauth | the secret key and delivery pause are the platform's |
| `GET /api/admin/system` | in | any user sees the trust state; secret key and backups only for admins (handler redacts) |
| `POST /api/admin/system/key/setup` | platform(system,manage) +reauth | the secret key and delivery pause are the platform's |
| `POST /api/admin/system/key/unlock` | platform(system,manage) +reauth | the secret key and delivery pause are the platform's |
| `POST /api/admin/system/resume` | platform(system,manage) +reauth | the secret key and delivery pause are the platform's |
| `GET /api/workspaces/targets` | in:list(target) | only targets the person may use; admins also see problems |
| `GET /api/workspaces/usage` | in:list(workspace) | cpu and memory of the workspaces the person may view |
| `GET /api/workspaces/:target/:name/claude-login` | obj(workspace view path target+name) | status of a Claude's sign-in |
| `POST /api/workspaces/:target/:name/claude-login` | obj(workspace operate path target+name; claude manage query claude (default Claude when absent)) | signing in is for the Claude's own person; a Claude a person signed in is theirs |
| `POST /api/workspaces/:target/:name/claude-login/code` | obj(workspace operate path target+name; claude manage query claude (default Claude when absent)) | signing in is for the Claude's own person; a Claude a person signed in is theirs |
| `DELETE /api/workspaces/:target/:name/claude-login` | obj(workspace operate path target+name; claude manage query claude (default Claude when absent)) | signing in is for the Claude's own person; a Claude a person signed in is theirs |
| `POST /api/workspaces/:target/:name/claude-logout` | obj(workspace operate path target+name; claude manage query claude) |  |
| `GET /api/workspaces/:target/:name/terminals` | obj(workspace operate path target+name) filter terminal (own only) | terminals are private to their creator in the UI (not a boundary: operate is a shell) |
| `POST /api/workspaces/:target/:name/terminals` | obj(workspace operate path target+name) | audit terminal.opened |
| `DELETE /api/workspaces/:target/:name/terminals/:term` | obj(terminal manage path target+name+term) | the creator, or a manager of the workspace |
| `GET /api/workspaces/:target/:name/claudes` | obj(workspace view path target+name) filter claude | names and sign-in state; each row carries the person's level on that Claude |
| `PATCH /api/workspaces/:target/:name/claudes/:claude` | obj(claude manage path claude) |  |
| `DELETE /api/workspaces/:target/:name/claudes/:claude` | obj(claude manage path claude) |  |
| `GET /api/workspaces` | in:list(workspace) |  |
| `POST /api/workspaces` | obj(target operate body target; team member of body ownerTeamId when set) in:create(workspace) | a new workspace is owned by the creator (or the team); `local` and host-level targets are admins only |
| `PUT /api/workspaces/:target/:name/account` | obj(workspace manage path target+name; account_pool operate body poolId optional) consent: credential | an account pool delivers API keys into the workspace: readable by its operators (sharing rules) |
| `GET /api/workspaces/:target/:name/preflight` | obj(workspace operate path target+name) | runs checks inside the workspace |
| `POST /api/workspaces/:target/:name/adopt` | obj(workspace manage path target+name) |  |
| `POST /api/workspaces/:target/:name/start` | obj(workspace operate path target+name) | ending running sessions of others: the system acts, it is audited |
| `POST /api/workspaces/:target/:name/stop` | obj(workspace operate path target+name) | ending running sessions of others: the system acts, it is audited |
| `DELETE /api/workspaces/:target/:name` | obj(workspace manage path target+name) +reauth when it holds secrets | removes ownership, shares, pool assignments; ends sessions |
| `GET /api/workspaces/:target/:name/pools` | obj(workspace view path target+name) |  |
| `PUT /api/workspaces/:target/:name/pools/:type` | obj(workspace manage path target+name; pool operate body (each id), poolType from path) consent: credential | assigning a set needs operate on the set; a secrets set asks the exposure consent when others operate the workspace |
| `GET /api/workspaces/:target/:name/secrets` | obj(workspace operate path target+name) | names of what is delivered (never values) |
| `POST /api/workspaces/:target/:name/secrets/check` | obj(workspace operate path target+name) |  |
| `GET /api/workspaces/:target/:name/repos` | obj(workspace view path target+name) |  |
| `POST /api/workspaces/:target/:name/repos/scan` | obj(workspace operate path target+name) |  |
| `GET /api/workspaces/:target/:name/repos/settings` | obj(workspace view path target+name) |  |
| `PUT /api/workspaces/:target/:name/repos/settings` | obj(workspace manage path target+name) |  |
| `GET /api/accounts` | in:list(account) + account pools | the overview holds only what the person may view; an API key is never returned |
| `POST /api/accounts` | in:create(account) | owned by the creator (or a team they belong to) |
| `POST /api/accounts/bulk` | in:create(account) | owned by the creator (or a team they belong to) |
| `PATCH /api/accounts/:id` | obj(account manage path id) |  |
| `POST /api/accounts/:id/check` | obj(account operate path id) | a check spends the key: operate |
| `POST /api/accounts/:id/clear` | obj(account operate path id) | a check spends the key: operate |
| `DELETE /api/accounts/:id` | obj(account manage path id) +reauth |  |
| `POST /api/endpoints` | in:create(endpoint) |  |
| `PATCH /api/endpoints/:id` | obj(endpoint manage path id) |  |
| `GET /api/endpoints/:id/models` | obj(endpoint operate path id) |  |
| `DELETE /api/endpoints/:id` | obj(endpoint manage path id) |  |
| `GET /api/account-pools` | in:list(account_pool) |  |
| `POST /api/account-pools` | in:create(account_pool); account operate body (each account) | a pool of someone else's keys needs their operate (use) |
| `PATCH /api/account-pools/:id` | obj(account_pool manage path id; account operate body (each added)) |  |
| `DELETE /api/account-pools/:id` | obj(account_pool manage path id; account operate body (each added)) |  |
| `GET /api/pools` | in | the registered types |
| `GET /api/pools/:type` | in:list(pool, poolType from path) |  |
| `POST /api/pools/:type` | in:create(pool, poolType from path) | owned by the creator (or a team) |
| `POST /api/pools/:type/preview` | in | no object: previews unsaved content |
| `GET /api/pools/:type/:id` | obj(pool view path id, poolType from path) |  |
| `PUT /api/pools/:type/:id` | obj(pool manage path id) |  |
| `DELETE /api/pools/:type/:id` | obj(pool manage path id) +reauth for secrets | `?unassign=1` also needs manage on each workspace it leaves |
| `POST /api/pools/:type/:id/duplicate` | obj(pool view path id) in:create(pool) |  |
| `POST /api/pools/:type/:id/revisions/:rev/approve` | obj(pool manage path id) | approving a revision for delivery is the set owner's; the library review of skills/MCP entries stays an admin's |
| `POST /api/pools/:type/:id/revisions/:rev/current` | obj(pool manage path id) | approving a revision for delivery is the set owner's; the library review of skills/MCP entries stays an admin's |
| `POST /api/pools/:type/:id/rollout` | obj(pool manage path id) |  |
| `POST /api/pools/:type/:id/assign` | obj(pool operate path id; workspace manage body workspaceIds (each)) | consent: credential when the set holds secrets |
| `POST /api/pools/:type/:id/preview` | obj(pool view path id) |  |
| `GET /api/mcp/catalog` | in:list(mcp_entry) | approved entries for everyone; drafts and proposals for their owner and admins |
| `POST /api/mcp/catalog` | in:create(mcp_entry) | a draft owned by the creator |
| `GET /api/mcp/catalog/:id` | obj(mcp_entry view path id) |  |
| `PATCH /api/mcp/catalog/:id` | obj(mcp_entry manage path id) |  |
| `DELETE /api/mcp/catalog/:id` | obj(mcp_entry manage path id) |  |
| `POST /api/mcp/catalog/:id/versions` | obj(mcp_entry manage path id) |  |
| `PUT /api/mcp/catalog/:id/versions/:vid` | obj(mcp_entry manage path id) | drafts only |
| `DELETE /api/mcp/catalog/:id/versions/:vid` | obj(mcp_entry manage path id) | drafts only |
| `POST /api/mcp/catalog/:id/versions/:vid/approve` | platform(library,manage) | approval is a platform admin's: it decides what can run in every user's workspaces |
| `POST /api/mcp/catalog/:id/versions/:vid/deprecate` | platform(library,manage) | approval is a platform admin's: it decides what can run in every user's workspaces |
| `POST /api/mcp/catalog/:id/versions/:vid/revoke` | platform(library,manage) | approval is a platform admin's: it decides what can run in every user's workspaces |
| `GET /api/mcp/builtin` | in |  |
| `POST /api/mcp/builtin/:id/preview` | in | preview writes nothing |
| `POST /api/mcp/builtin/:id/add` | platform(library,manage) | Add and Update are admin-level acts (PRD mcp-builtin-catalogue) |
| `POST /api/mcp/sets/:poolId/try` | obj(pool operate path poolId, poolType mcpset; workspace operate body) |  |
| `GET /api/mcp/workspaces/:target/:name/auth` | obj(workspace view path target+name) |  |
| `POST /api/mcp/workspaces/:target/:name/auth` | obj(workspace operate path target+name; claude operate query claude) | OAuth sign-in of a Claude: its person |
| `POST /api/mcp/workspaces/:target/:name/signin` | obj(workspace operate path target+name; claude operate query claude) | OAuth sign-in of a Claude: its person |
| `POST /api/mcp/workspaces/:target/:name/signin/:signInId/complete` | obj(workspace operate path target+name; claude operate query claude) | bound to the person who started it |
| `DELETE /api/mcp/workspaces/:target/:name/signin/:signInId` | obj(workspace operate path target+name) | bound to the person who started it |
| `POST /api/mcp/workspaces/:target/:name/signout` | obj(workspace operate path target+name; claude operate query claude) | OAuth sign-in of a Claude: its person |
| `GET /api/mcp/workspaces/:target/:name` | obj(workspace view path target+name) |  |
| `GET /api/mcp/workspaces/:target/:name/matchers` | obj(workspace view path target+name) |  |
| `POST /api/mcp/workspaces/:target/:name/installs/retry` | obj(workspace operate path target+name) |  |
| `POST /api/mcp/workspaces/:target/:name/verify` | obj(workspace operate path target+name) |  |
| `GET /api/skills/library` | in:list(skill_version) | reviewed skills for everyone; waiting-review ones for their importer and admins |
| `POST /api/skills/import` | in:create(skill_source) | URL and zip imports keep the SSRF and archive guards; the result waits for review |
| `GET /api/skills/versions/:id` | obj(skill_version view path id) |  |
| `GET /api/skills/versions/:id/file` | obj(skill_version view path id) |  |
| `POST /api/skills/versions/:id/review` | platform(library,manage) |  |
| `POST /api/skills/versions/:id/revoke` | platform(library,manage) |  |
| `DELETE /api/skills/sources/:id` | obj(skill_source manage path id) |  |
| `GET /api/skills/workspaces/:target/:name` | obj(workspace view path target+name) |  |
| `POST /api/skills/workspaces/:target/:name/verify` | obj(workspace operate path target+name) |  |
| `POST /api/secrets/:poolId/entries/:entryId/rotate` | obj(pool manage path poolId, poolType secrets) | audit secret.rotated |
| `GET /api/secrets/:poolId/rotations` | obj(pool view path poolId, poolType secrets) | metadata only |
| `GET /api/secrets/:poolId/entries/:entryId/versions` | obj(pool view path poolId, poolType secrets) | metadata only |
| `POST /api/secrets/:poolId/values/:valueId/revoke` | obj(pool manage path poolId, poolType secrets) | audit secret.revoked |
| `GET /api/settings` | in | effective values: a person should see why something is refused |
| `GET /api/settings/audit` | platform(settings,view) | admins |
| `GET /api/settings/lockdown/:target/:name` | obj(workspace view path target+name) |  |
| `PUT /api/settings/:key` | platform(settings,manage) | actor in setting_changes is the user |
| `GET /api/personas/workspaces/:target/:name` | obj(workspace view path target+name) |  |
| `GET /api/personas/identities` | in:list(pool, poolType persona\|context) |  |
| `GET /api/personas/pools` | in:list(pool, poolType persona\|context) |  |
| `GET /api/personas/default` | in |  |
| `PUT /api/personas/default` | platform(settings,manage) | the default persona of new workspaces is a platform choice |
| `GET /api/personas/pools/:id/policy` | obj(pool view\|manage path id, poolType persona) | GET view, PUT manage |
| `PUT /api/personas/pools/:id/policy` | obj(pool view\|manage path id, poolType persona) | GET view, PUT manage |
| `POST /api/personas/pools/:id/avatar` | obj(pool manage path id, poolType persona) |  |
| `DELETE /api/personas/pools/:id/avatar` | obj(pool manage path id, poolType persona) |  |
| `GET /api/personas/avatars/:sha` | in | content-addressed: the 256-bit hash is the reference |
| `GET /api/personas/proposals` | in:list(proposal) |  |
| `POST /api/personas/proposals/:id/:verb` | obj(proposal manage path id) | the persona's owner decides, not the proposing agent |
| `GET /api/personas/pools/:id/revisions` | obj(pool view path id, poolType persona) |  |
| `GET /api/personas/pools/:id/revisions/:rev` | obj(pool view path id, poolType persona) |  |
| `GET /api/knowledge/graph` | in:list(vault) | only visible vaults enter a graph |
| `GET /api/knowledge/sources` | in:list(vault) | only visible vaults enter a graph |
| `GET /api/knowledge/vaults` | in:list(vault) |  |
| `POST /api/knowledge/vaults` | in:create(vault) |  |
| `POST /api/knowledge/vaults/import` | in:create(vault) |  |
| `GET /api/knowledge/vaults/:id` | obj(vault view path id) | export is a bulk read of what the person may view |
| `PATCH /api/knowledge/vaults/:id` | obj(vault manage path id) |  |
| `DELETE /api/knowledge/vaults/:id` | obj(vault manage path id) +reauth |  |
| `GET /api/knowledge/vaults/:id/export` | obj(vault view path id) | export is a bulk read of what the person may view |
| `GET /api/knowledge/vaults/:id/tree` | obj(vault view path id) | export is a bulk read of what the person may view |
| `GET /api/knowledge/vaults/:id/note` | obj(vault view path id) | export is a bulk read of what the person may view |
| `PUT /api/knowledge/vaults/:id/note` | obj(vault operate path id) | an agent also needs the vault's own agent policy |
| `DELETE /api/knowledge/vaults/:id/note` | obj(vault operate path id) | an agent also needs the vault's own agent policy |
| `POST /api/knowledge/vaults/:id/note/append` | obj(vault operate path id) | an agent also needs the vault's own agent policy |
| `POST /api/knowledge/vaults/:id/note/rename` | obj(vault operate path id) | an agent also needs the vault's own agent policy |
| `POST /api/knowledge/vaults/:id/note/restore` | obj(vault operate path id) | an agent also needs the vault's own agent policy |
| `GET /api/knowledge/vaults/:id/note/history` | obj(vault view path id) | export is a bulk read of what the person may view |
| `GET /api/knowledge/vaults/:id/note/version` | obj(vault view path id) | export is a bulk read of what the person may view |
| `GET /api/knowledge/vaults/:id/note/backlinks` | obj(vault view path id) | export is a bulk read of what the person may view |
| `GET /api/knowledge/vaults/:id/note/mentions` | obj(vault view path id) | export is a bulk read of what the person may view |
| `GET /api/knowledge/vaults/:id/embed` | obj(vault view path id) | export is a bulk read of what the person may view |
| `GET /api/knowledge/vaults/:id/file` | obj(vault view path id) | export is a bulk read of what the person may view |
| `PUT /api/knowledge/vaults/:id/file` | obj(vault operate path id) | an agent also needs the vault's own agent policy |
| `POST /api/knowledge/vaults/:id/folder` | obj(vault operate path id) | an agent also needs the vault's own agent policy |
| `GET /api/knowledge/vaults/:id/search` | obj(vault view path id) | export is a bulk read of what the person may view |
| `GET /api/knowledge/vaults/:id/quick` | obj(vault view path id) | export is a bulk read of what the person may view |
| `GET /api/knowledge/vaults/:id/tags` | obj(vault view path id) | export is a bulk read of what the person may view |
| `GET /api/knowledge/vaults/:id/health` | obj(vault view path id) | export is a bulk read of what the person may view |
| `GET /api/knowledge/vaults/:id/recent` | obj(vault view path id) | export is a bulk read of what the person may view |
| `GET /api/knowledge/vaults/:id/deleted` | obj(vault view path id) | export is a bulk read of what the person may view |
| `GET /api/knowledge/vaults/:id/daily` | obj(vault view path id) | export is a bulk read of what the person may view |
| `POST /api/knowledge/vaults/:id/daily` | obj(vault operate path id) | an agent also needs the vault's own agent policy |
| `GET /api/knowledge/vaults/:id/activity` | obj(vault view path id) | export is a bulk read of what the person may view |
| `POST /api/knowledge/vaults/:id/rescan` | obj(vault operate path id) | an agent also needs the vault's own agent policy |
| `GET /api/portal-mcp` | in | own tokens and own activity; tool list; admins see the portal switches |
| `PUT /api/portal-mcp/settings` | platform(settings,manage) +reauth | MCP on/off, session control |
| `POST /api/portal-mcp/tokens` | self +reauth | a token is bound to its creator; scope is a cap, never a grant |
| `DELETE /api/portal-mcp/tokens/:id` | obj(personal manage path id) | own tokens; platform admins revoke through the emergency route |
| `POST /api/portal-mcp/revoke-all` | self | own tokens; everyone's: platform(emergency) |
| `GET /api/portal-mcp/agents` | in:list(workspace) managed | the workspaces the person manages |
| `PUT /api/portal-mcp/agents/:target/:name` | obj(workspace manage path target+name) +reauth | agent access to portal tools is the workspace manager's switch |
| `GET /api/portal-mcp/audit` | in | own rows; admins all |
| `GET /api/tickets` | in:list(ticket) |  |
| `POST /api/tickets` | in:create(ticket); workspace view body workspaceId optional (a linked ticket needs the link target to be visible) |  |
| `GET /api/tickets/tags` | in | tags of visible tickets only |
| `GET /api/tickets/:id` | obj(ticket view path id) |  |
| `GET /api/tickets/:id/brief` | obj(ticket view path id) |  |
| `GET /api/tickets/:id/opening` | obj(ticket view path id) |  |
| `PATCH /api/tickets/:id` | obj(ticket operate path id) | moving it to another workspace also needs workspace operate |
| `DELETE /api/tickets/:id` | obj(ticket manage path id) |  |
| `POST /api/tickets/:id/comments` | obj(ticket operate path id) |  |
| `POST /api/tickets/:id/close` | obj(ticket operate path id) |  |
| `DELETE /api/tickets/:id/close` | obj(ticket operate path id) |  |
| `POST /api/tickets/:id/session` | obj(ticket operate path id; workspace operate body/ticket; claude operate body) | the session belongs to the person starting it |
| `GET /api/ci/runs` | in:list(ci_run) |  |
| `POST /api/ci/runs` | obj(ci_repo operate body repoId) | the repo resolves to its workspace |
| `GET /api/ci/runs/:id` | obj(ci_run view path id) | logs pass the redactor |
| `GET /api/ci/runs/:id/log` | obj(ci_run view path id) | logs pass the redactor |
| `POST /api/ci/runs/:id/cancel` | obj(ci_run operate path id) |  |
| `POST /api/ci/runs/:id/rerun` | obj(ci_run operate path id) |  |
| `GET /api/ci/repos` | in:list(ci_repo) |  |
| `POST /api/ci/repos` | obj(workspace manage body workspaceId) |  |
| `PATCH /api/ci/repos/:id` | obj(ci_repo manage path id) |  |
| `DELETE /api/ci/repos/:id` | obj(ci_repo manage path id) |  |
| `POST /api/ci/repos/:id/connect` | obj(ci_repo manage path id) |  |
| `GET /api/ci/repos/:id/branches` | obj(ci_repo view path id) |  |
| `GET /api/ci/repos/:id/pipelines` | obj(ci_repo view path id) |  |
| `POST /api/ci/repos/:id/merge` | obj(ci_repo operate path id) |  |
| `POST /api/ci/validate` | in | validates a spec in the body; reads no object |
| `GET /api/repos` | in:list(repo) |  |
| `GET /api/repos/events` | in:list(repo) | events of visible repos only |
| `GET /api/repos/:id` | obj(repo view path id) |  |
| `POST /api/repos/:id/scan` | obj(repo operate path id) |  |
| `POST /api/repos/:id/worktrees` | obj(repo operate path id) |  |
| `DELETE /api/repos/:id/worktree` | obj(repo operate path id) |  |
| `PUT /api/repos/:id/sync` | obj(repo operate path id) |  |
| `POST /api/repos/:id/sync` | obj(repo operate path id) |  |
| `GET /api/glance` | in | the person's own snapshot: sources take the actor |
| `GET /api/claude-usage/summary` | in:list(claude) + memberScope | only Claudes the person may use; per-person figures by memberScope |
| `GET /api/claude-usage/requests` | in:list(claude) + memberScope | only Claudes the person may use; per-person figures by memberScope |
| `GET /api/claude-usage/recommend` | in:list(claude) + memberScope | only Claudes the person may use; per-person figures by memberScope |
| `GET /api/claude-usage/palette` | in:list(claude) + memberScope | only Claudes the person may use; per-person figures by memberScope |
| `GET /api/claude-usage/export` | in:list(claude) + memberScope | only Claudes the person may use; per-person figures by memberScope |
| `GET /api/claude-usage` | in:list(claude) + memberScope | only Claudes the person may use; per-person figures by memberScope |
| `GET /api/claude-usage/:claudeId/history` | obj(claude view path claudeId) |  |
| `POST /api/claude-usage/:claudeId/check` | obj(claude operate path claudeId) |  |
| `PUT /api/claude-usage/:claudeId/snooze` | self | a snooze is the person's own preference (today global: the retrofit makes it per user) |
| `DELETE /api/claude-usage/:claudeId/snooze` | self | a snooze is the person's own preference (today global: the retrofit makes it per user) |
| `GET /api/usage-spend` | in + memberScope | visibility per object through Visibility -> canUser |
| `GET /api/usage-spend/alerts` | in + memberScope | visibility per object through Visibility -> canUser |
| `GET /api/usage-spend/audit` | in | own rows; admins all |
| `GET /api/usage-spend/attribution` | in + memberScope | visibility per object through Visibility -> canUser |
| `GET /api/usage-spend/budgets` | in + memberScope | visibility per object through Visibility -> canUser |
| `POST /api/usage-spend/budgets` | in:create(budget); workspace manage body when scope=workspace \| platform(usage,manage) otherwise |  |
| `PUT /api/usage-spend/budgets/:id` | obj(budget manage path id) |  |
| `DELETE /api/usage-spend/budgets/:id` | obj(budget manage path id) |  |
| `PUT /api/usage-spend/budgets/:id/snooze` | self |  |
| `DELETE /api/usage-spend/budgets/:id/snooze` | self |  |
| `GET /api/usage-spend/spikes` | in + memberScope | visibility per object through Visibility -> canUser |
| `PUT /api/usage-spend/spikes/snooze` | self |  |
| `DELETE /api/usage-spend/spikes/snooze` | self |  |
| `GET /api/chat/sessions` | in:list(session) | private to their creator unless shared |
| `POST /api/chat/sessions` | obj(workspace operate body workspaceId; claude operate body claudeId (default Claude when absent); ticket operate body ticketId optional) in:create(session) | the session is owned by its creator; created_by_user stamped; a child takes its root's |
| `GET /api/chat/sessions/:id` | obj(session view path id) |  |
| `POST /api/chat/sessions/:id/switch` | obj(session operate path id; claude operate body claudeId) | Move chat: the destination Claude must be usable by the person |
| `GET /api/chat/sessions/:id/switch-options` | obj(session operate path id) | asks Claude Code |
| `GET /api/chat/sessions/:id/bypass` | obj(session view path id) |  |
| `POST /api/chat/sessions/:id/bypass` | obj(session manage path id) +reauth | only the creator's opt-in; never via MCP; audit bypass.* |
| `POST /api/chat/sessions/:id/bypass/allow` | obj(session manage path id) +reauth | only the creator's opt-in; never via MCP; audit bypass.* |
| `GET /api/chat/sessions/:id/segments` | obj(session view path id) | files: the session's folder only, by the existing deny rules |
| `PATCH /api/chat/sessions/:id` | obj(session manage path id) | DELETE with ?worktree=force also needs workspace operate |
| `DELETE /api/chat/sessions/:id` | obj(session manage path id) | DELETE with ?worktree=force also needs workspace operate |
| `POST /api/chat/sessions/:id/end` | obj(session operate path id) |  |
| `POST /api/chat/sessions/:id/archive` | obj(session manage path id) |  |
| `GET /api/chat/sessions/:id/worktree` | obj(session manage path id) |  |
| `DELETE /api/chat/sessions/:id/archive` | obj(session manage path id) |  |
| `GET /api/chat/sessions/:id/events` | obj(session view path id) | files: the session's folder only, by the existing deny rules |
| `GET /api/chat/sessions/:id/models` | obj(session operate path id) | asks Claude Code |
| `GET /api/chat/sessions/:id/tasks` | obj(session view path id) | files: the session's folder only, by the existing deny rules |
| `GET /api/chat/sessions/:id/blobs/:blobId` | obj(session view path id) | files: the session's folder only, by the existing deny rules |
| `GET /api/chat/sessions/:id/files` | obj(session view path id) | files: the session's folder only, by the existing deny rules |
| `GET /api/chat/sessions/:id/files/download` | obj(session view path id) | files: the session's folder only, by the existing deny rules |
| `GET /api/chat/sessions/:id/diff` | obj(session view path id) | files: the session's folder only, by the existing deny rules |
| `POST /api/chat/sessions/:id/uploads` | obj(session operate path id) | staged for this session only |
| `DELETE /api/chat/sessions/:id/uploads/:uploadId` | obj(session operate path id) | staged for this session only |
| `GET /api/chat/sessions/:id/blobs/:blobId/preview` | obj(session view path id) | files: the session's folder only, by the existing deny rules |
| `GET /api/chat/sessions/:id/artifacts.zip` | obj(session view path id) | files: the session's folder only, by the existing deny rules |
| `GET /api/chat/usage` | in + memberScope | usage of the sessions the person may view |
| `GET /api/chat/claudes` | obj(workspace view query workspaceId) filter claude |  |
| `POST /api/chat/claudes` | obj(workspace operate body workspaceId) in:create(claude) | a new Claude is owned by the person who adds it |
| `GET /api/chat/trust/scan` | obj(workspace operate query workspaceId) |  |
| `POST /api/chat/trust` | obj(workspace manage body workspaceId) | trusting a folder lets Claude Code run there for everyone who uses it |
| `POST /api/chat/reauth` | self | replaced by POST /api/auth/reauth (kept as an alias) |
| `GET /api/chat/worktrees` | obj(workspace view query workspaceId) |  |
| `GET /api/chat/policy` | in |  |
| `GET /api/chat/audit` | in:list(session audit rows) | rows about sessions the person may view; admins: platform rows too |
| `GET /api/workspaces/:target/:name/browser` | obj(workspace view path target+name) | status only |
| `PUT /api/workspaces/:target/:name/browser/control` | obj(workspace operate path target+name) | the lease binds (user, device), never a device id alone |
| `POST /api/workspaces/:target/:name/browser/handoffs/:handoff` | obj(workspace operate path target+name) |  |
| `POST /api/workspaces/:target/:name/browser/install/retry` | obj(workspace manage path target+name) |  |
| `GET /api/workspaces/:target/:name/browser/configuration` | obj(workspace view path target+name) | status only |
| `POST /api/workspaces/:target/:name/browser/:action` | obj(workspace operate path target+name) |  |

## Appendix B. Portal MCP tool policy v0: all 87 registered tools

Generated from the registered tool list (18 files) and checked for coverage. Scope letters: R = read-only, D = destructive. `agent:` rows say what an agent token may reach on top of its owner's rights (its own session, session tree, workspace). Once the layer lands every tool declares its access at registration and the registry refuses to start with one that does not (FR19).

| Tool | Scope | Access | Note |
| --- | --- | --- | --- |
| `ticket_list` | agent R | list(ticket); agent: its workspace and the owner's shared queue |  |
| `ticket_get` | agent R | ticket view id |  |
| `ticket_create` | agent | create(ticket) owned by the token/agent owner |  |
| `ticket_update` | agent | ticket operate id; agent: assigned to its session |  |
| `ticket_comment` | agent | ticket operate id; agent: assigned to its session |  |
| `ticket_claim_next` | agent | list(ticket) operate; agent only |  |
| `ticket_close` | agent | ticket operate id; agent: assigned to its session |  |
| `ticket_start_session` | admin D | ticket operate id; workspace operate; claude operate |  |
| `repos_list` | agent R | list(repo) |  |
| `repo_get` | agent R | repo view id |  |
| `repo_events` | agent R | repo view id |  |
| `repos_attention` | agent R | list(repo) |  |
| `worktree_create` | agent | repo operate id; agent: own workspace |  |
| `workspace_list` | read | list(workspace) |  |
| `workspace_get` | read | workspace view workspace_id |  |
| `workspace_create` | admin | create(workspace); target operate | owned by the token's user; host-level targets need an admin owner |
| `workspace_start` | operate | workspace operate workspace_id |  |
| `workspace_stop` | operate D | workspace operate workspace_id |  |
| `workspace_sync` | operate | workspace operate workspace_id |  |
| `workspace_delete` | admin D | workspace manage workspace_id +confirm |  |
| `mcp_builtin_list` | agent R | list(mcp_entry) / signed-in |  |
| `pool_types` | read | signed-in |  |
| `pool_list` | read | list(pool) |  |
| `pool_get` | read | pool view pool_id |  |
| `pool_create` | admin | create(pool) |  |
| `pool_update` | admin D | pool manage pool_id | delete +confirm |
| `pool_delete` | admin D | pool manage pool_id | delete +confirm |
| `pool_assign` | admin D | workspace manage workspace_id; pool operate pool_id |  |
| `pool_unassign` | admin D | workspace manage workspace_id; pool operate pool_id |  |
| `account_pool_list` | read | list(account_pool) |  |
| `account_list` | read | list(account) | never a key |
| `account_check` | operate | account operate account_id |  |
| `account_pool_assign` | admin D | workspace manage workspace_id; account_pool operate pool_id | credential exposure rules |
| `portal_status` | agent R | signed-in | agent-callable: no platform detail |
| `audit_search` | read | own rows; platform(audit,view) for all |  |
| `mcp_lockdown` | operate D | self (own tokens); platform(emergency,manage) for all users and agents |  |
| `monitor_overview` | read | signed-in; counts only what is visible |  |
| `usage_report` | read | signed-in + memberScope |  |
| `session_list` | read | list(session) |  |
| `session_get` | read | session view session_id |  |
| `session_interrupt` | operate D | session operate session_id |  |
| `session_end` | operate D | session operate session_id |  |
| `session_start` | admin D | workspace operate workspace_id; claude operate claude_id; session operate parent (optional, T-336) | the session is owned by the token's user; never bypass-capable; a parent that is missing, ended, in another workspace or refused is the same not found |
| `session_send` | admin D | session operate session_id | scope admin today: stays |
| `session_respond` | operate D | session operate session_id | allow needs scope admin; never Bypass |
| `session_configure` | admin D | session operate session_id | model, effort, mode; never enters Bypass |
| `mcp_propose_entry` | agent | create(mcp_entry draft) owned by the owner; withdraw own | never approves |
| `mcp_proposal_withdraw` | agent R | create(mcp_entry draft) owned by the owner; withdraw own | never approves |
| `mcp_catalog_list` | agent R | list(mcp_entry) / signed-in |  |
| `artifact_publish` | agent | agent: own session only |  |
| `session_rename_self` | agent | agent: own session only |  |
| `session_spawn` | agent | agent: own session; creates a child owned by the root creator | caps and policy stay |
| `session_message` | agent | agent: own session tree only |  |
| `session_family` | agent R | agent: own session tree only |  |
| `session_stop_worker` | agent | agent: own session tree only |  |
| `session_request_clear` | agent | agent: a chat of its own workspace; admin: session operate session_id | never a request of the live process (409); T-284 |
| `ci_runs_list` | agent R | list(ci_run) |  |
| `ci_run_get` | agent R | ci_run view id |  |
| `ci_run_logs` | agent R | ci_run view id |  |
| `ci_validate` | agent R | signed-in |  |
| `ci_run_trigger` | agent | ci_repo operate / ci_run operate; agent: its own branch |  |
| `ci_run_cancel` | agent | ci_repo operate / ci_run operate; agent: its own branch |  |
| `usage_summary` | agent R | signed-in + memberScope / Visibility | agent: own tree |
| `usage_attribution` | agent R | signed-in + memberScope / Visibility | agent: own tree |
| `usage_budgets` | agent R | signed-in + memberScope / Visibility | agent: own tree |
| `usage_spikes` | agent R | signed-in + memberScope / Visibility | agent: own tree |
| `usage_budget_set` | admin | budget manage / workspace manage / platform(usage,manage) | +confirm |
| `usage_budget_delete` | admin D | budget manage / workspace manage / platform(usage,manage) | +confirm |
| `claude_usage` | agent R | claude view; agent: its own Claude |  |
| `claude_usage_summary` | read R | signed-in + Claudes the user may use |  |
| `claude_usage_report` | read R | signed-in + Claudes the user may use |  |
| `claude_move_advice` | read R | signed-in + Claudes the user may use |  |
| `persona_get_self` | agent R | agent: own workspace's persona; proposal for its owner | never approves |
| `persona_propose_update` | agent | agent: own workspace's persona; proposal for its owner | never approves |
| `persona_set_avatar_proposal` | agent | agent: own workspace's persona; proposal for its owner | never approves |
| `vault_list` | agent R | list(vault) ∩ token vault allow-list |  |
| `note_search` | agent R | vault view vault | agent: also the vault's agent policy |
| `note_read` | agent R | vault view vault | agent: also the vault's agent policy |
| `note_backlinks` | agent R | vault view vault | agent: also the vault's agent policy |
| `tag_list` | agent R | vault view vault | agent: also the vault's agent policy |
| `graph_neighbours` | agent R | vault view vault | agent: also the vault's agent policy |
| `graph_query` | agent R | vault view vault | agent: also the vault's agent policy |
| `note_write` | agent | vault operate vault | agent: also the vault's agent policy; agent notes stay out of snapshots until promoted |
| `note_edit` | agent | vault operate vault | agent: also the vault's agent policy; agent notes stay out of snapshots until promoted |
| `note_append` | agent | vault operate vault | agent: also the vault's agent policy; agent notes stay out of snapshots until promoted |
| `daily_append` | agent | vault operate vault | agent: also the vault's agent policy; agent notes stay out of snapshots until promoted |
| `skill_propose` | agent | own workspace's persona/skills; proposal owned by the owner of the target set | never approves |
| `skill_proposals_list` | agent R | own workspace's persona/skills; proposal owned by the owner of the target set | never approves |

## Appendix C. Sockets and other doors outside the route table

Declared in the same table under `ALL <path>` (the chat socket already is: `chat/authz.ts` declares `ALL /api/chat/live`), because an upgrade request is not in `app.routes`. The enumeration test also checks that every upgrade handler path found by `server.on('upgrade')` has a declaration.

| Door | Declared key | Handshake | What each message needs |
| --- | --- | --- | --- |
| Live (`/api/live`) | `ALL /api/live` | signed in | `subscribe` to topics; `workspaces` and `usage` frames are built per client by `visible` and sent again when `onAccessChange` fires; the other topics are nudges (R2) |
| Chat (`/api/chat/live`) | `ALL /api/chat/live` | signed in | `subscribe`: `view` on the session; `send`, `respond`, `control` and the side-question messages (`btw_ask`, `btw_cancel`, `btw_pin`): `operate`; a mode change to Bypass is refused here (REST with a password check); a right that ends drops the subscription and the next message gets the same `ack` as for a missing session |
| Shell (`/api/workspaces/:target/:name/shell`) | `ALL /api/workspaces/:target/:name/shell` | `operate` on the workspace; `?term=` also needs the terminal's owner (a `claude` terminal also `operate` on its Claude) | terminal bytes and `resize`; closed when the right ends |
| Browser live view and preview (`.../browser/view`, `.../browser/preview`) | `ALL .../browser/view`, `ALL .../browser/preview` | `operate` on the workspace | the lease binds (user, device); viewers cannot take control |
| Portal MCP (`/mcp`) | `ALL /mcp` | `bearer` (`cpat_`, `cpst_`; `cpoa_` if the portal becomes an authorization server) | each tool declares its access (Appendix B) |
| Connect (`/connect/*`) | declared by `connect/authz.ts` | the node's signed challenge or an enrollment token: not a user | no user route is reachable through it |
| Trigger receivers (`/hooks/<token>`) | `handler` | token and signature of the Git host | the trigger's owner is the actor; `can(owner, 'operate', workspace)` at run time |
| Static app and `/healthz` | `public` | none | none |
