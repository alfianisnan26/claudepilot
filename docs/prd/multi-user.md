# PRD: Multi-user (overview)

| | |
| --- | --- |
| Status | **Draft v0.1** (2026-10-12). Design: the contracts `packages/contracts/src/{authz,identity,sharing,teams}.ts` and the authorization seam `apps/server/src/authz/seam.ts` (20 tests with the contract checks) have landed; everything else is **Not built**. Written from the code, the plans in flight and the status files of the running tracks (audit in `COORD/p5-audit.md`; impact map also in `COORD/p5-impact.md`; work packages in `COORD/p5-workbreakdown.md`). ✅ = checked here, 📄 = documented (source linked), 🔬 = unverified. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [Pools foundation](foundation-pools.md), [Portal MCP](portal-mcp.md), [Chat sessions](chat-sessions.md) |
| Related | [Identity and onboarding](identity-onboarding.md), [Authorization](authorization.md), [Sharing](sharing.md), [Teams](teams.md), [Organizations](organizations.md) (2026-10-31: orgs, org SSO, and a review of this PRD against the code in its §14), [Web app & PWA](web-app-pwa.md) §12, [Platform roadmap](platform-roadmap.md), [Claude usage](claude-usage.md) |

## 1. Summary

The portal was built for ONE person behind ONE shared server code. The owner now wants several people on one portal, with a security focus, in three phases: **(1)** accounts and onboarding, and one default-deny access model for every object, route, socket, MCP token and job; **(2)** sharing one workspace with another person, with a consent screen where secrets default off; **(3)** teams.

This document is the overview. It states the principles and decisions in one list, what exists today and how much of the ask is already there (little), how a one-person install becomes a multi-user one without losing a thing, the dev/test recipe that keeps working, the **impact on every plan in flight**, the interfaces the **usage-per-user follow-on** needs, the work packages and when each may start, and the decisions the owner must make (MO1 to MO15). The four detailed PRDs are [Identity and onboarding](identity-onboarding.md), [Authorization](authorization.md), [Sharing](sharing.md) and [Teams](teams.md).

## 2. Background and what exists

The audit is `COORD/p5-audit.md` (every item and sub-bullet of the owner's ask with its evidence, the object inventory, the 267 routes, 87 tools, 5 sockets, and 18 security findings). The short version:

| Item of the ask | Exists today | Missing |
| --- | --- | --- |
| Sign-in | one shared server code, a cookie, a per-address limiter, Origin and CSRF checks, `SocketGuard`, re-auth by code | accounts, setup, registration, invitations, profile, devices, per-name limits, password hashing, seed |
| Ownership | the `u_owner` convention in 38 files; `created_by` on three new tables | an owner on workspaces, sessions, tickets, sets, accounts, vaults; resolvers; grants; teams |
| One layer | `requireSession` on 24 groups; scope checks in Portal MCP; an enumerable route table and a test that already enumerates it for "401 signed out" | `can()`, declarations, enforcement at routes, tools, sockets, jobs |
| Tokens | hash at rest, scopes, revoke, per-session agent tokens with liveness checks | an owner on every token, use-time binding, an epoch to kill them |
| Audit | per-module audit tables with free-text actors | per-user actors, one platform audit, sharing audit |
| Sharing, teams | nothing | everything |

`@isnanme/core` has no authentication or authorization code; it gives `AppError` and its code registry, the envelope and ids. Nothing is wrapped or replaced inside node_modules.

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **A real front door.** Accounts, one-time setup, invitations, hardened passwords and sessions; no shared secret. |
| G2 | **One layer decides every right**, default deny, at routes, sockets, MCP tokens and jobs, proven by tests that list the real route table. |
| G3 | **Privacy by default across users**; sharing is explicit, consented, visible and revocable at once. |
| G4 | **Teams** own and receive, always with an owner. |
| G5 | **No rework for the plans in flight**: they adopt a seam now and are retrofitted once, in a window. |
| G6 | **A one-person install and the dev/test recipe survive** unchanged for their users. |
| G7 | **Security is tested across users**: every object type against every route, socket message, tool and job. |

## 4. Non-goals

SSO, passkeys, MFA (later); email; a policy language or relationship engine ([Authorization](authorization.md) D9); isolation between two operators of one workspace; admin break-glass in v1 (open question); billing, quotas per user; cross-portal federation.

## 5. Users and stories

| ID | Story |
| --- | --- |
| US1 | As the owner of the portal, I upgrade, create my account once, and everything I had is mine. |
| US2 | As the owner, I invite two colleagues and they sign in with their own passwords. |
| US3 | As a colleague, I see only my own workspaces and sessions, and what was shared with me. |
| US4 | As the owner, I share a workspace with one colleague at Operate, untick my secrets, and later end it. |
| US5 | As a colleague, I create a team with a friend and we own a workspace together. |
| US6 | As a security reviewer, I run one suite that tries every object, route, socket, tool and job across users, and it is green. |
| US7 | As an agent author, I add a route or a tool and the build tells me I forgot to declare who may call it. |

## 6. Scope boundary: where each part of the ask lives

| Owner's item | Document | Phase |
| --- | --- | --- |
| 1 Onboarding and users (setup, registration modes, profile, devices, passwords, limits, cookies, reset, seed, migration) | [Identity and onboarding](identity-onboarding.md) | 1 |
| 2 Access model (owner and rights on every object, one default-deny layer, tokens bound to owners, audit per actor) | [Authorization](authorization.md) | 1 |
| 3 Sharing one workspace (username, consent screen, secrets default off, private sessions, revocation, the list) | [Sharing](sharing.md) | 2 |
| 4 Teams (menu, invitations, many teams, owners, share to a team) | [Teams](teams.md) | 3 |
| The impact on plans 2 to 9 and 11 and 12 | this document §12, §13 | all |

## 7. Solution overview

```
                         ┌────────────── identity-onboarding ──────────────┐
 browser / CLI / seed ─► │ setup · login · register · invitation · devices │ ─► Actor (user, token, agent, job, system)
                         └─────────────────────────────────────────────────┘                  │
                                                                                               ▼
        routes ──┐                                                              ┌────────── authorization ──────────┐
        sockets ─┼─► authenticate ─► authorize (policy table, default deny) ─► │ can(actor, verb, object)          │
        tools ───┤                                                              │ resolver per type · owner · grants │
        jobs ────┘                                                              │ teams · public · parent rules      │
                                                                                └──────┬─────────────────┬──────────┘
                                                              sharing ◄───────────────┘                 └───────────► teams
                                                  (consented bundles of grants,                   (membership, owners,
                                                   revocation, sweep)                              team-owned objects)
```

One rule above all: **every right is decided by `can()`, and `can()` denies unless a rule allows**. Everything else (accounts, shares, teams) only feeds it facts: who the actor is, who owns the object, what was granted, who belongs to which team.

## 8. Principles and decisions (one list; each detailed PRD argues its own)

PLAN-10's principles M1 to M8, and where each is met:

| Principle | Met by |
| --- | --- |
| M1 default deny, one layer, a test enumerates the routes | Authorization FR1 to FR4, FR16, FR19, FR20; the policy tables are Appendix A and B of Authorization |
| M2 tokens never exceed their owner, at USE time | Authorization FR12, FR13; `token_epoch` |
| M3 a share carries no secret unless ticked; revoking is immediate and honest | Sharing FR5 to FR7, §10 |
| M4 auth hardening | Identity §8: scrypt N=2^17 with parameters stored, constant time, per-name and per-address limits, uniform answers, safe cookies, sessions revoked on a password change, Origin and CSRF unchanged; the setup token expires, is single use, hashed and masked in the log (D6); open registration needs approval; invitations are single use, expiring and rate limited |
| M5 no silent owner loss | existing data to `u_owner` (D1); two triggers keep a team's owner and the last admin ✅; every state change audited with the actor |
| M6 single-user continuity; the seed is impossible in production | Identity §11: explicit, noisy, refused at start in production, tested by spawning |
| M7 abuse tested across users | Authorization §12 (X1 to X20), Sharing §12 (H1 to H14), Teams §12 (M1 to M11), Identity §12 (I1 to I24) |
| M8 no collisions | §14: new files first, shadow mode, one invasive window; §15: light-touch rules until then |

The decisions, numbered once:

| ID | Decision | Where argued |
| --- | --- | --- |
| D1 | The first account takes the id `u_owner`; nothing existing is rewritten | Identity D1 |
| D2 | scrypt from `node:crypto`, N=2^17 r=8 p=1, parameters stored; no dependency | Identity D2 |
| D3 | Password minimum 15 characters, no composition rules, a local block list | Identity D3 |
| D4 | Sessions are database rows, looked up per request; 12 h or 30/90 days kept; renewed on sign-in and password change | Identity D4 |
| D5 | Persistent per-name and per-address limits, uniform answers, a dummy hash | Identity D5 |
| D6 | The setup token is masked in the log; the CLI prints it in full; the old server code is accepted once | Identity D6 |
| D7 | Registration closed / invitation (default) / open with approval; invitation links keep the code in the fragment | Identity D7 |
| D8 | A dev seed that is explicit, noisy and refused in production | Identity D8 |
| D9 | Owner + grants + teams + one `can()` with a resolver per type; not a relationship engine or policy language | Authorization D9 |
| D10 | One central policy table, one middleware, default deny | Authorization D10 |
| D11 | 404 for what you may not view, 403 for what you may view but not do | Authorization D11 |
| D12 | Platform admins hold no right on users' objects | Authorization D12 |
| D13 | Tokens and agents: the owner's rights at use time, capped by scope; an epoch kills them | Authorization D13 |
| D14 | Sessions are private; workspace rights never reach them | Authorization D14 |
| D15 | Host-level targets and their workspaces are admin-only | Authorization D15 |
| D16 | Shadow mode before enforce | Authorization D16 |
| D17 | Environment hygiene for the server process | Identity D17 |
| D18 | Teams: owner and member roles, owners invite, invariants in service and triggers | Teams D18 |
| D19 | A share is a consented bundle of grants; narrowing is immediate, widening is a new share; unticked credentials are removed; acceptance for operate and above; only owners grant manage; a consent hash | Sharing D19 |
| D20 | Per-person usage attributes to the session's CREATOR; `created_by_user` is history and never rewritten; a cutover record marks what came before | §13 |
| D21 | `/api/live` is filtered per client; sockets are tied to a user and cut when a right ends | Authorization FR20, FR23 |
| D22 | Actor strings gain `user:<id>`; the legacy `ui` and `Admin` read as the founding user; module audits keep their tables; **one platform audit** (`platform_audit`, the platform track's table, extended) for identity, sharing, teams and denials, security rows append-only for a year | Authorization FR25, Identity FR42 |
| D23 | Ownership lives with each module (a column or a table) and is read only through its resolver; a workspace's owner is a table of its own; unowned objects are claimed by an admin | Authorization §11 |

## 9. Phases

| Phase | Items | Contents | Gate |
| --- | --- | --- | --- |
| 1 | 1 and 2 | identity (I1 to I3), the layer (A1 to A5), ownership retrofit, the code login removed, the abuse suite | the quiescent window for the invasive part |
| 2 | 3 | sharing (S1 to S4), revocation effects, the assignment sweep | phase 1 enforcing |
| 3 | 4 | teams (T1 to T3), team-owned objects, shares to teams | phase 2 |

## 10. The first-run and the upgrade, end to end

1. A fresh install and an upgraded one start the same: the migrations (block 400-459) run after the automatic pre-migrate backup; the portal finds no account and enters setup mode.
2. The log says the setup token (masked) and where to get it; the owner runs `portal setup-token` (or the log line with `PORTAL_SETUP_TOKEN_LOG=full`); an install with `PORTAL_SERVER_CODE` can use that code once.
3. The owner opens the portal: the Set up screen. They enter the credential, a username, a name and a password. One transaction creates `u_owner` as the admin, deletes the token, claims every workspace the runtimes list, signs them in.
4. Everything that said `u_owner` is theirs. Running chat sessions in workspaces were never interrupted; their agent tokens work again as soon as the account exists.
5. The owner opens **People** → Invite, or switches Registration. Others sign in with their own accounts and see nothing of the owner's until it is shared with them.
6. Browser tabs open before the upgrade are signed out (their cookies belong to a session without a user): unavoidable, and said on the Set up screen.

## 11. The dev and test recipe (what keeps working, what changes)

| Today | After the retrofit |
| --- | --- |
| `tmux new-session ... "cd apps/server && env -i PATH=$PATH HOME=/tmp/<prefix>home LANG=C.UTF-8 PORTAL_K8S_ENABLED=false PORTAL_PORT=<port> PORTAL_DATA_DIR=/tmp/<prefix>data PORTAL_SERVER_CODE=<8 digits> PORTAL_SECRET_KEY=... NODE_OPTIONS=... npx tsx ... src/index.ts"` (PLAN.md §5 with the clean-environment rule of PLAN-2 A.11) | the same line plus `PORTAL_DEV_SEED=1`; `NODE_ENV` stays unset |
| `curl -c JAR -H 'Origin: http://localhost:<port>' -d '{"code":"<code>"}' localhost:<port>/api/login` -> cookie `portal_session` | **unchanged**; `{"code":"<code>","as":"alice"}` signs in as another seeded account (created as a member; `"role":"admin"` for an admin) |
| `tools/qa/lib.mjs` `login(code)`, `drive.mjs <cookie value>` | `login(code, as)`; `drive.mjs` is unchanged (it takes the cookie value) |
| tests that spawn a production-mode portal with the code (`qa/boot.test.ts` and its neighbours) | run development mode with the seed, or create the account through the identity module's test kit (`authz/testkit.ts`, work package A9) |
| `PORTAL_SERVER_CODE` in compose and `.env.example` | documented as dev-seed only; production ignores it with one warning (`PORTAL_ENV_STRICT=1` refuses) |

The clean-environment rule (PLAN-2 A.11) is part of the contract: the seed needs no inherited variable, and a production server ignores or refuses credential-bearing variables it does not need ([Identity](identity-onboarding.md) FR39 to FR41).

## 12. The impact map: every plan in flight

Each row says what multi-user changes for the plan, what its agent should do NOW to avoid rework (the light-touch rules of §15 apply to every row: `actorOf` and `canUser` from the seam, `owner_id`/`created_by` defaulting to `u_owner`, resolvers in `<module>/authz.ts`, `declarePolicies` for every route and tool, `actorString` in audit rows), and what the retrofit does later (the package ids are in §14). State as of 2026-10-12 about 06:00 UTC, from `COORD/ROSTER.md` and the status files; "landed" means in the working tree.

### PLAN-2: MCP catalogue (B1 to B4) and workspace git (G1, G2)

| Track | State | What changes | Do now | Retrofit later |
| --- | --- | --- | --- | --- |
| B1 catalogue core | done | The catalogue is the platform **library** (`mcp_entry`: platform-owned, approved entries usable by everyone, drafts and proposals owned by their author). Approving, deprecating, revoking and **Add/Update of a built-in** are `platform(library, manage)` (the B4 PRD already says admin-level). `mcp_builtin_instances.added_by` becomes `user:<id>` | nothing to change; `reviewed_by`/`added_by` accept `actorString`; keep one resolver per object (`catalog.findByKey` is it) | MU5: `owner_kind` (default `platform`) on `mcp_catalog`, resolver `mcp_entry`, list filter (drafts: author and admins), routes declared, `mcp_builtin_list` declared `list(mcp_entry)` |
| B2 providers, testkit | done | none (code-defined, platform) | none | none |
| B3 OAuth and sign-in | built | A sign-in belongs to the person who starts it: it is for one workspace Claude (its directory); `complete` and `cancel` are bound to the starter; the stored token lives in the Claude's directory (that Claude's owner's) | the actor param exists (`u_owner`); keep `code` and `state` out of logs | MU5: routes need `workspace operate` + `claude operate`; `signInId` bound to `actorUserId`; audit actor `user:<id>` |
| B4 catalogue UI | done | 403 handling exists (`WithReason`); Add/Update/Approve visible only to admins (from `GET` capabilities or a 403) | none | MU10: read the person's level from the list rows |
| G1 workspace git | done | repos, worktrees and events are **children of the workspace** (same level): `view` = tree and status, `operate` = scan, worktree, sync, file contents; `repo_events.actor` becomes the person; agents act only in their own workspace | replace `const ACTOR = 'ui'` in `repos/routes.ts` by `actorString(actorOf(c))`; the `forgetWorkspace` hook also removes ownership (MU4 adds the call) | MU6: resolver `repo` (parent workspace), declarations, `visible` on `/api/repos` and `/events`, `repo_get`/`worktree_create` tools declared |
| G2 repos UI | done | a 403 on scan/worktree/sync already disables the action with the server's reason | none | MU10: hide the chip for repos the person may not view |

### PLAN-3: Connect (P1 done; T1, T2 running; T3 to T6 queued)

| Part | What changes | Do now | Retrofit later |
| --- | --- | --- | --- |
| Targets registry, nodes, enrollment tokens | **Platform resources**: `target` objects owned by the platform; adding, enrolling, rotating and removing are `platform(targets, manage)` (admins); `operate` on a target = placing a workspace there, granted by an admin to users or opened to everyone. Enrollment tokens are shown once, to the admin | T1 already does: `created_by`/`actor` default `u_owner`, **one resolver per object** (`registry.target(id)`, `enrollments.resolve(...)`); audit actor `u_owner` for the person, `agent:<node id>` for a node, `system` | MU4: resolver `target` with `public` by a per-target flag; `GET /api/connect/targets` filtered by `operate` (a member sees names only, no node detail); `local` and `docker-host` are host-level (admin-only, authorization §9) |
| Tunnel endpoint and `/connect/*` public routes | their own door (node keys, enrollment tokens), never a user's cookie: declared `bearer` / `handler` | declare them as such in `connect/authz.ts`; no cookie is ever read on them | MU2: the enumeration test accepts them as declared doors |
| Single hosts as workspaces | when a single host is assigned it becomes a workspace: its owner is the person who enrolled it (an admin) | record the enrolling user as `created_by` | MU4: `workspace_owners` row at assignment |
| Remote runtimes (T3) | workspaces on remote targets are owned like any; delivery and watchers act as `system` | T3 adds a `targetState` hook in `chat/controller.ts` (surgical): keep it free of actor logic | MU3 after T3 is done |
| Security | the tunnel gives the portal Docker or Kubernetes access on remote hosts: a platform-admin concern only; no user-facing route reaches a node | none | the abuse suite adds: a member cannot list nodes, mint or read an enrollment token, or reach `/connect` admin routes |

### PLAN-4: usage and glance (U1a, U1b, U2, U3, U4)

| Track | State | What changes | Do now | Retrofit later |
| --- | --- | --- | --- | --- |
| U1a Claude usage | server done | A Claude is a **workspace Claude**; its plan windows belong to the account, not to a user. Visible to those who may use that Claude (`claude view`/`operate`); `recommend` only among Claudes the person may `operate`; alert **snoozes** become the person's own preference; the palette gains kind `user` (§13); export CSV respects `memberScope` | `UsageOptions.canUseClaude` and the `allow` of `recommend` are the hooks: wire them to `canUser(actorId, 'operate', claudeRef)` | MU6: resolvers `claude`, per-user snooze table; declarations; `claude_usage*` tools declared; routes use `actorOf(c)` instead of `OWNER_ACTOR` |
| U1b spend | server done | attribution rows follow the **session's creator** (§13); budgets per workspace are managed by that workspace's managers, per Claude and global by admins; spikes and alerts go to the budget's owner; `Visibility` hook | keep `Visibility` as the only rule; `creatorOf(session)` will return `string \| null` (NULL = before users): code for null | MU6: `Visibility = canUser`; budgets get resolver `budget`; `creatorOf` reads `created_by_user` |
| U2 usage UI | running | the third grouping "User" is PLAN-12 (U6); nothing else | none | MU10 |
| U3 glance framework | final pass | per-user device preferences are keyed `claudepilot.glance.<userId>`; the founding user is `u_owner`, so their stored settings survive | none; the key already carries the id | MU9: `OWNER_ID` constants become `useMe().user.id` |
| U4 widgets and aggregator | verifying | every source takes `actorId` ✓; "requests = those the actor may decide" = `can(user, 'operate', session)`; approvals go through the chat socket, the one door | none; keep the aggregator's sources behind `actorId` | MU6: `actorId` from `actorOf(c)`; items filtered by `visible`; `usersWith` drives who is told |

### PLAN-5: notifications, triggers, auto transfer, delivery flow, safety net, scale

| Part | State | What changes | Do now | Retrofit later |
| --- | --- | --- | --- | --- |
| Notifications (N1, N2) | N1 landed (the platform skeleton, the notify pipeline, the platform audit); N2 queued | everything per person is a **user's** (`user_id` default `u_owner` ✓); a push device sits under a user; VAPID keys, base URL, contact and the ceiling on answers are `platform(notifications)`; recipients come from `ownersOf(subject)` / `usersWith`; an answer token is bound to (user, device, request) and `can(user, 'operate', session)` is checked when it arrives; `LivePresence` per user device | call `ownersOf`, `usersWith` and `canUser` from the seam (already named so in PWA §11.10); never take a user id from a request body | MU6/MU8: real resolution incl. teams; `share_received`/`share_ended` kinds; the socket carries the actor |
| Triggers (N3) | contracts landed, queued | a trigger has an **owner** and runs as `asUser(owner, 'trigger:<id>')`; `can(owner, 'operate', workspace)` at every run; the public receiver `/hooks/<token>` is its own door (`handler`); caps per owner and total are platform settings | follow triggers.md §19: `owner_id` default `u_owner`, `asUser`, `owner_denied`/`owner_disabled` skips | MU6: resolver `trigger`; declarations; admins list all, members their own |
| Auto transfer (N4) | contracts landed, queued | acts for the chat's **owner** among Claudes that owner may `operate`; a Claude's sign-in belongs to whoever signed it in (auto-transfer.md §17 already asks the layer) | `canUser(owner, 'operate', claudeRef)` for `allow`; audit actor the owner | MU3/MU6 |
| Delivery flow, CI M3 (phase 2 of P2) | queued | merges and PR flows act on **CI remotes** (`ci_repo operate`); a PR opened through the MCP catalogue uses credentials of the sets assigned to the workspace (exposure rules apply); ticket checks show to ticket viewers but their links need view on the run's workspace | when designed: object-level checks via the resolvers of ticket and ci | MU6 |
| Safety net (phase 2) | queued | the **kill switch** (`platform(emergency)`) and "stop everything" are admin acts; a person may stop only their own sessions; **egress allowlists** are workspace `manage` with an admin floor; **backups** of the database contain every person's data: admin-only with a password check and a restore test; volume backups are the workspace owner's | design as platform vs workspace-manage from the start | MU4/MU12 |
| Scale and search (phase 3 of P2) | queued | paging, counts and totals are computed AFTER the visibility filter; a global search is built per actor (post-filter every hit by `can` before returning a snippet; never one shared index returned unfiltered); a transcript export is `view` on the session; archive is `manage` | build the index with the owner id on each document; filter before paging | MU6 |

### PLAN-6: evidence, annotations, code viewer (P3 queued)

| Part | What changes | Do now | Retrofit later |
| --- | --- | --- | --- |
| Annotations | authored by a user (`author_id`), anchored to an object: visible to whoever can `view` the target; the author edits their own; `operate` on the target resolves and replies; "Send review" goes to the related session and needs `operate` on THAT session; text is untrusted; stored in the database, never in files | `author_id` default `u_owner`; targets by ref (`ObjectRef`) so `can` applies | MU6: resolvers; declarations |
| Evidence on tickets | an agent's upload is the **agent's owner's** (append-only; needs `operate` on the ticket); a human's needs `operate`; the blob store stays content-addressed and is served only through a link row (never "upload by hash") | `uploaded_by` as `actorString`; no hash-first upload protocol | MU6 |
| Capture and annotate in the browser pool | capturing and sending need `operate` on the workspace (the lease binds user and device); a screenshot may hold secrets (blur) | record the actor on evidence | MU6/MU8 |
| Code viewer | file **contents and diffs** need `operate` on the workspace (a repository tree is `view`); a session's files need `view` on the session; the viewer opens no new road to a denied file | route through the existing file paths and rules | MU3/MU6 |

### PLAN-7: Claude Code version pin (V1 running; V2 queued)

| Part | What changes | Do now | Retrofit later |
| --- | --- | --- | --- |
| Pin, registry, canary | the default pin, the canary and its schedule are `platform(version)`; image tags are platform resources | `actor` fields already carry `u_owner` | MU5 declarations |
| Upgrade and rollback of a workspace | recreating the container disturbs everyone operating it: `manage` on the workspace (+ a password check); the history is per workspace; the canary runs on a throwaway container (platform cost) | name the right: `workspace manage` | MU4 |

### PLAN-8: scanner, approval rules, maintenance, templates, onboarding (P4 queued)

| Part | What changes | Do now | Retrofit later |
| --- | --- | --- | --- |
| Secret scanner | findings belong to the session or workspace where they were found: visible as that object's content (`operate` on the workspace, `view` on the session); the exceptions list is per workspace (`manage`) with an admin floor for "block"; a finding stores a fingerprint and a masked excerpt, never a value | findings carry `workspace_id`/`session_id` | MU6 |
| **Approval rules** (auto-approve) | **the cross-user risk of the whole plan:** a rule created by A for a shared workspace must apply ONLY to sessions A owns, never to B's sessions in it, nor to a persona-level rule's other users. A rule has an `owner_id`, matches only sessions whose owner is the rule's owner, never reaches Bypass or high-risk actions, and every automatic approval is audited with the rule id and its owner | **a rule row carries `owner_id` and the matcher checks `session.owner_id = rule.owner_id`** from the first line of code; `decided_via = 'rule'` | MU3 wires `chat_requests.decided_by_user` |
| Maintenance | per-workspace disk and orphans are visible to the workspace's managers; platform-wide orphan lists, scheduled cleanup, restart backoff are `system` jobs with admin settings; a one-tap clean lists first and acts only on what the actor manages | split platform vs workspace views in the contract | MU4/MU12 |
| Templates | `template` is an object type (user, team or platform owner; grants allowed): creating a workspace from one needs `operate` on the template AND on every set it names; export carries secret NAMES only; a template by itself carries no credential | owner columns on the template tables | MU5 |
| Onboarding checklist | per **person**: Claude sign-in, a workspace, a session, install and notifications, from that person's real state; plus an admin checklist (registration mode, key backup, a target) | state from the user's own objects through the resolvers | MU9 |

### PLAN-9: btw side questions (S1, S2 queued)

| Part | What changes | Do now | Retrofit later |
| --- | --- | --- | --- |
| Engine and socket messages | S1's migration 380 landed `chat_btw` per asker (`user_id`, `actor user:<id>`): a question and its answer are **private to the person who asked**, also in a shared session (the owner cannot read a sharee's side questions); asking needs `operate` on the session (it spends the creator's Claude through the workspace's exec and reads the transcript); the new socket messages (`btw_ask`, `btw_cancel`, `btw_pin`) join the chat socket's per-message checks; usage is attributed to the session's creator and marked a side question; the per-session rate limit stays per session | pass the actor to the engine; no user id from the message body | MU3 |
| Pin | appends one portal card to the main transcript: needs `operate`; the card is the pinning person's, attributed | `actorString` on the card event | MU3 |

### PLAN-11: delegation policy (D1, D2 queued)

| Part | What changes | Do now | Retrofit later |
| --- | --- | --- | --- |
| Policy, spawn tool, escalation | the policy (tiers, rubric, limits) is a platform setting (admin); the spawn tool's `model`, `effort`, `reason` are clamped by it; a child session is owned by its **root's creator**; the escalation budget cap per tree uses that creator's usage; a person's override of a running child needs `operate` on it; the `reason` is untrusted text | policy edits through `defineSetting` (admin only once enforced); `actor` on every delegation row | MU5 (settings), MU3 (spawn owner), MU7 (tool declarations) |

### PLAN-12: usage per user (U5, U6 queued; preconditions in its plan)

See §13: the interfaces phase 1 provides so U5 and U6 start without rework.

### PLAN-13 to PLAN-21 (plans added while this was written)

| Plan | What changes | Do now | Retrofit later |
| --- | --- | --- | --- |
| 13 QA standards and performance gates (Q2a, Q2b, Q2c) | Q2c's security pass "coordinate with the multi-user abuse matrix": it reuses the suite of [Authorization](authorization.md) §12 as its base and does not rebuild it; QA and performance runs happen in a quiet window after the retrofit; the `can` benchmark joins the gates; the new identity, sharing and teams screens are in the A-list | nothing | MU11 hands the suite over; MU9, MU15, MU19 meet the UI bar |
| 14 Developer tools (px) | A new platform area `devtools` (added to `PLATFORM_AREAS`): admin only, a fresh password check per window, every access audited with the actor. The capture middleware runs AFTER `authenticate`, records the actor id, route, status, duration and size, **never bodies**. **Content views are checked per object, not admin-wide**: raw stream-json events, commands run in workspaces, container logs and session timelines need `view`/`operate` on that session or workspace (an admin does not read other people's transcripts through the inspector, authorization FR6); metadata (jobs, DB sizes, event-loop lag, route timings) is the admin's. The diagnostics bundle holds names and versions, no user content. Environment variables by name share the list of identity FR41 | take the actor from the seam; keep content capture behind `requireCan`; ring buffers hold metadata | MU2 (the area), MU3 (hooks in the chat path) |
| 15 Data placement (ps) | The rule "the server is for identity, permissions, policy, audit, secrets and an index": **ownership and rights live in the server database and are never inferred from files in a workspace** (a forged file must not claim a workspace). Workspace-resident data (annotations, evidence) carries its owner in the index; per-person private annotations stay in the portal. "Detach" keeps a tombstone (`workspace_owners.detached_at`) so only the former owner or an admin can attach the same workspace again; "Delete" removes it. Every new table of this work declares its storage: server database, small; retention: sign-ins 90 days after expiry, throttle rows 1 day, invitations 90 days after use or expiry, the platform audit one year for security kinds, ended shares one year | state storage and retention in each package's PRD note | MU4 (detach/attach), MU1/MU13 (retention jobs) |
| 16 Codespaces target (gc, gd, gu2) | A connection is its maker's (`ownerId`); the token sits in a secrets set (a credential: the set's `operate` is the use); **persons only** (agents and Portal MCP tokens get 403) as the PRD already says. A workspace on a codespace is billed to the token's owner: sharing it adds the note `billed_to_owner`; start and stop are `operate`, delete and detach `manage`; the token is never delivered into the workspace. The device flow's client id is platform configuration | `codespaces/authz.ts` already registers a resolver and declarations (checked: it imports the seam) | MU5 (pool resolver), MU4 (target use) |
| 17 Agent map (am1, am2) | Nodes and edges only among sessions the person may `view` (`visible`); a hidden node is omitted with its edges, no "N hidden"; counts and cost labels from visible rows only; stop, send message and change model need `operate` on that node; sub-agents and tasks take their session's rights | the aggregator takes the actor; filter before laying out | MU3, MU6c |
| 18 VS Code integration (vx) | **Client sign-ins**: an extension gets a user-bound, revocable, minimally scoped token by a device flow ([Identity](identity-onboarding.md) FR51 to FR53: `login_sessions.client`, `cppt_`, `via: 'client'`, capped at `operate`, only on routes declared `bearer: true`, never `reauth`/`platform`/sharing routes). A remote workspace through code-server or SSH is terminal-equivalent: `operate` on the workspace, re-checked on every connection by the authenticated proxy. Approvals in the extension show the full text under the same rules; tokens live in SecretStorage | design the flow on `login_sessions.client`; no cookie assumptions in new APIs | MU1 (the column and the bearer hook), the VS Code packages (the flow) |
| 19 Onboarding and guidance (ga, gb) | **Subsumes PLAN-8 item 6.** `guide_seen` and tour progress are per user on the server (`user_id` default `u_owner`), endpoints are `self`; the admin switch is a `platform(settings)` setting; the checklist reads the person's own state through the resolvers (their Claude sign-in, their workspaces, their sessions); an admin checklist (registration mode, key backup, a target) is an `audience: admin` entry. Account creation (Set up, Join, Profile) is [Identity](identity-onboarding.md), separate: guidance starts after sign-in and never shows on signed-out screens; each new screen of this work registers its tips | `user_id` default `u_owner`; use `actorOf(c)` | MU9, MU15, MU19 register tips; MU6 |
| 20 MCP in both directions and the pool gateway (mx) | A session token's rights are the minimum of its scope and its owner's, at use time, revoked on disable (authorization FR12, FR13; MU7). **Tools declare through `declareToolPolicies`** (the tool table; `declarePolicies` is for routes: announced in the outbox). The admin MCP's token page is per person (own tokens; admins revoke others through the emergency route). **If the portal becomes an OAuth authorization server for clients**: the consent page is an ordinary signed-in page, the token is bound to the approving person (`cpoa_` with `owner_id` and the epoch), client registration is a `platform(settings)` act, and the consent shows the client and the scope cap. **The gateway** injects secrets server-side: an upstream call is authorized as the session owner's `operate` on a set assigned to that workspace (the assignment validity rule), logged per user, and stops at once when a share or membership ends (sharing FR13) | declare tools through the seam; never read a user id from tool arguments | MU7; the gateway package calls `can` on every upstream use |
| 21 UI resilience (ur, us) | None for rights. The new lists (People, Devices, Access, Teams, shares) use the shared dynamic-list and dynamic-text components; no component keeps per-user state in the client | | MU9, MU15, MU19 |

### The earlier tracks (the retrofit targets)

Chat (A2, A2b, A7), pools (A3a), personas (A3c), Portal MCP and tickets (A3b), browser (A4), knowledge (A4b), CI (A5), Claude usage (A6) are covered by the work packages of §14; their files are what the retrofit edits, in the window.

## 13. Interfaces for the usage follow-on (PLAN-12) and other cross-track hooks

PLAN-12 asks for usage per person for shared and team workspaces. These are the facts and hooks multi-user phase 1 provides (each is also in the retrofit migration, authorization §11, and the packages MU3, MU6, MU2).

1. **A creator on every session.** `chat_sessions.owner_id` (who may use it: access), `created_by_user` (who made it: attribution; **NULL for a session that existed before accounts**), `root_id` (the top of the `parent_id` chain; ✅ backfilled by a recursive query on the real schema). A new session: `owner_id = created_by_user` = the acting user (a trigger, a ticket start or a CI message acts as the job's owner). **A child session** (agent spawn) copies its parent's `owner_id`, `created_by_user` and sets `root_id = parent.root_id`, so a person is charged for the helpers their session started. **A session made by Move is the same row** (one portal session id spans the switch), so its owner never changes. An admin's reassignment of a disabled user's objects changes `owner_id` only; **`created_by_user` is history and is never rewritten.**
2. **A user on every usage row.** `chat_usage.user_id` is stamped when a turn is recorded (`#recordTurn`) from the session's `created_by_user`; NULL stays NULL. Rows are never rewritten. `usage_sessions` (U1b's snapshot, which survives a session delete) gains `created_by_user` and `root_id` at the points where it already snapshots title, parent and ticket (U5's migration block 480-499); `creatorOf(session)` in `usagespend/actor.ts` then returns `string | null`.
3. **The cutover.** `portal_meta.multi_user_since` (an ISO time) is written by the retrofit migration. A usage row belongs to **"Before users"** (reason `pre_multiuser`) when its `user_id` is NULL, that is, when its session's creator is unknown: those rows count in workspace, Claude and platform totals and are **never attributed to a person**, even though the migration gave the objects to `u_owner` for access. Rows not tied to a session (an approval decided) are before the cutover when their time is earlier than `multi_user_since`.
4. **Approvals decided and Bypass use, per actor, countable.** `chat_requests.decided_by_user` and `decided_via` (`ui | mcp | rule | notification`) are written when a request is answered: the person who decided, not the session's creator (an operator sharee who approves counts for themselves; an auto-approval counts for the rule's owner with `decided_via = 'rule'`); NULL before accounts. Bypass: `chat_audit` rows `bypass.capable` (the creator's opt-in), `bypass.entered`, `bypass.left` carry `actor = user:<id>`; minutes in Bypass are the sum of the intervals between `entered` and `left` (open ones end with the session). These are **counts and durations with their basis (measured)**; "turns run under Bypass" needs a per-turn mode, which U5 may add as `chat_usage.mode` in its own block.
5. **Who may see whose figures.** `memberScope(actor, subject)` (seam, contracts `MemberScope`): for `{ kind: 'platform' }` an admin gets everyone; for `{ kind: 'workspace', id }` the workspace's managers get every user with a session or a right on it, anyone else gets themselves; for `{ kind: 'team', id }` the team's owners get every member, members get themselves. A user outside the set is **left out, never shown as "others"**; for an ordinary member the workspace total is their own rows. Nobody sees session content through usage. Routes and tools of U5 declare `in + memberScope`.
6. **Quota is not a user's cost.** The plan windows (session, week) belong to the Claude account and live in their own view; a person's figures are tokens, requests and estimated cost, never "their share of the quota".
7. **Palette for users.** U1a's slot mechanism (`usage_palette`, 8 slots per kind, a slot kept until the key is unseen for 45 days) extends to `kind = 'user'`. What U5 needs from U1a's table: its `kind` column has `CHECK (kind IN ('claude','model'))`, which SQLite cannot alter, so U5's migration either rebuilds the table (create, copy, drop, rename) or adds `usage_palette_user`; the key is the user id; slots are returned only for users in the actor's `memberScope`; beyond 8 users the rest are "Others".
8. **Active time** is defined by the usage track (for example the sum of finished-turn durations, labelled an estimate), never from presence.
9. **Declarations for U5's routes and tools**: `GET /api/claude-usage/users...` `in + memberScope`; the export honours `memberScope`; the Portal MCP tool `usage_user_report` (admin scope: platform; otherwise the actor's own rows).

Other hooks the plans in flight can rely on, all in the seam: `ownersOf(ref)`, `usersWith(ref, verb)`, `canUser(userId, verb, ref)`, `onAccessChange`, `actorString`/`parseActorString`.

## 14. Work packages, order and when each may start (summary of `COORD/p5-workbreakdown.md`)

Migration block 400-459 (identity 400-409, authz and sharing 410-419, teams 420-429, ownership retrofits 430-449, cutover and cleanup 450-459). Scratch ports 3282-3289, CDP 9412-9419, prefixes `mu1-` to `mu20-`.

| Pkg | Phase | What | Starts when | Size |
| --- | --- | --- | --- | --- |
| A0 | 1 | contracts and the seam | **done** | S |
| MU1 | 1 | identity core: users, sessions, setup, sign-in, throttling, hashing, audit log, the CLI, the seed, `authenticate` | now (new files; surgical lines in `app.ts`, `index.ts`, `config.ts`, `cli.ts`) | L |
| MU2 | 1 | the real layer: `can`, the policy table v0, the middleware in shadow mode, the enumeration test, the test kit | now (new files; two surgical lines) | L |
| MU9 | 1 | web identity: Set up, Sign in, Join, Register, Profile, Devices, People, account menu | after MU1's contracts routes answer; new files | L |
| MU3 | 1 | chat retrofit: owners, creator, decider, sockets, terminals, Claudes, reauth by password | window: chat tracks quiet | XL |
| MU4 | 1 | workspaces and targets: `workspace_owners`, create flow, claim, host-level rule, lists | window | L |
| MU5 | 1 | pools, accounts, secrets, library, settings, personas | window | XL |
| MU6 | 1 | work objects: tickets, knowledge, CI, repos, browser, usage, glance | window | XL |
| MU7 | 1 | Portal MCP: owner-bound tokens, agent binding, 87 tool declarations, audit | window | L |
| MU8 | 1 | live hub, socket guard, shell and browser sockets | window | M |
| MU10 | 1 | web retrofit: level chips, disabled actions, per-user keys | window | M |
| MU11 | 1 | the cross-user abuse suite, recipe and script migration | harness with MU2; full with the retrofits | L |
| MU12 | 1 | flip to enforce, remove the code login, drop `web_sessions`, docs | after the matrix is green | M |
| MU13 to MU16 | 2 | sharing: server, revocation effects and the sweep, web, matrix | phase 1 enforcing | L, L, M, M |
| MU17 to MU20 | 3 | teams: server, team-owned objects and shares to teams, web, matrix | phase 2 | L, M, M, S |

Order: **MU1 and MU2 first, together** (additive, in their own files); then MU9 and the suite harness; shadow mode runs on real traffic; then **one announced window** for MU3 to MU8 and MU10 (they edit files other tracks own: each starts only when the owning tracks have reported done and no agent has the file open); then MU11 completes, MU12 flips. Phases 2 and 3 follow.

## 15. The light-touch rules for agents in flight (short)

1. Read who is asking once: `const actor = actorOf(c)` (`authz/seam.ts`); pass it down. Never write `'u_owner'` or `'ui'` inline in new code.
2. Before reading an object by id: `requireCan(actor, verb, ref)`; a list returns `visible(actor, type, rows, idOf)`. Write the resolver for your object in `<module>/authz.ts`; register it in `index.ts` (one line).
3. Audit rows and `actor` columns: `actorString(actor)`. Keep reading `ui` as the owner (`parseActorString`).
4. New tables: `owner_id TEXT NOT NULL DEFAULT 'u_owner'` and `created_by TEXT NOT NULL DEFAULT 'u_owner'`.
5. Declare every new route and tool (`declarePolicies`); an undeclared one will be refused when the layer lands.
6. A job that acts for a person runs as `asUser(ownerId, '<job>')` and checks `can` when it RUNS.
7. Never trust a user id from a body, a query or a header.
8. A share, a team or a role is not yours to model: ask the seam. A credential is a credential: assigning one to a workspace someone else operates is the sharing rules' business, not yours.

## 16. Decisions that need the owner

Numbered MO1 to MO15 so they do not clash with the platform roadmap's O1 to O12. Each has a recommended default; the plans proceed on the defaults until answered.

| ID | Decision | Recommended |
| --- | --- | --- |
| MO1 | Password minimum: 15 characters (NIST for a password used alone) or 12 | 15 |
| MO2 | Setup token in the log: masked, full from the CLI (this design), or full in the log (Jenkins-style) | masked + CLI; `PORTAL_SETUP_TOKEN_LOG=full` as an option |
| MO3 | Who may invite: admins only, or members too (`membersMayInvite`) | admins only |
| MO4 | Admins and privacy: no right on users' objects, no break-glass (this design), or a loud break-glass | no right, no break-glass |
| MO5 | Library approval (MCP entries, skills): admins only, or members for their own sets | admins only |
| MO6 | Credentials in a share: default off and removed when unticked (this design), or the share blocked until the owner removes them by hand | removed when unticked |
| MO7 | Acceptance for shares to a person: at operate and above (default), always, or never | operate and above |
| MO8 | Host-level targets (`This machine`, `docker-host`): admin-only | yes |
| MO9 | `view` on a workspace shows the repository tree and status (no contents) | yes |
| MO10 | Team-owned objects: members operate, owners manage; no per-object member level | yes |
| MO11 | The founding account takes the id `u_owner` | yes |
| MO12 | Idle timeout for browser sessions (2 hours) in addition to 12 hours absolute | no |
| MO13 | Production: `PORTAL_ENV_STRICT=1` as the documented default (the deploy files are not ours to change) | yes |
| MO14 | Browser tabs open at the upgrade are signed out | unavoidable; informational |
| MO15 | Cloudflare Access email as an account or an outer gate only | outer gate only |

## 17. Amendments to other PRDs

Made now, as short notes (re-read first, nothing rewritten): Web app & PWA §12, Portal MCP §9, §12.5 and §12.6, Settings & policies §12, Pools foundation §4 and §11 and Q10, and the README index. The rest are made at the retrofit window, so as not to collide with the tracks that edit those files today; each is one note that points here.

| PRD | Section | Change |
| --- | --- | --- |
| [Web app & PWA](web-app-pwa.md) | §12 | the server-code sign-in is replaced by accounts: a "Multi-user (PLAN-10)" note at the top of §12 and in §12.4/§12.5 (sessions are database rows with devices; re-auth is the password); §12.2/§12.3 (Access in front, app listener, cookies) stay the outer layer |
| [Portal MCP](portal-mcp.md) | §9, §12.5, §12.6 | tokens carry `owner_id` and `token_epoch`; agent tokens use their session's owner at use time; §12.5 "one shared server code" is superseded; `audit_search` and the audit are the person's own unless platform admin |
| [Settings & policies](settings-policies.md) | scope and roles | settings are platform-wide and admin-only to change (`platform(settings)`); workspace policies need `manage`; "one admin role in v1" becomes `admin` and `member` |
| [Pools foundation](foundation-pools.md) | §4, §10, Q10 | pools have an owner (user, team or platform) and are shared by grants; "every delivered secret is readable by its users" is the sharing rule; the audit can now name a person (Q10 answered) |
| [Chat sessions](chat-sessions.md) | §15 (shared visibility) | superseded: a session is private to its creator unless shared |
| [Account Pool](account-pool.md), [Tickets](tickets.md), [Knowledge graph](knowledge-graph.md), [Monitoring](monitoring-dashboard.md), [Secrets & env](secrets-env-pool.md) | Q10/Q13, Q2, non-goals, Q12, T4 | each "one shared sign-in" note points here |
| README | index | rows for the five PRDs |

## 18. Testing and verification

Done here (✅): the seam's 11 tests and the 9 contract checks (`authz/contracts.test.ts`: levels, ids, object types, refusal statuses, usernames, passwords, lock arithmetic, `levelFor`, audit actions); the schema script (all new tables, triggers and the retrofit on the real migrations, the level query, the invariants); the route and tool enumerations (267 and 87, every one covered once by the generated tables); `matchedRoutes` behaviour; the scrypt benchmark and the `maxmem` limit; the two-connection race on the owner invariant; Node's missing `crypto.argon2`. Not done (🔬 until the packages exist): everything that needs a running multi-user portal: the suites of Authorization §12, Sharing §12, Teams §12 and Identity §12, browser verification at 390 and 1280 px, and the `can` benchmark.

## 19. Milestones and open questions

| Milestone | Scope | Status |
| --- | --- | --- |
| A0 | contracts and seam | **Built** |
| Phase 1 | MU1 to MU12 | **Not built** |
| Phase 2 | MU13 to MU16 | **Not built** |
| Phase 3 | MU17 to MU20 | **Not built** |

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | The owner decisions MO1 to MO15 of §16 | Owner |
| Q2 | Should an admin see all workspaces (names and owners only) in a platform view, without content? v1: only Unclaimed objects and counts | Owner |
| Q3 | Per-topic relevance on `/api/live` nudges | Product |
| Q4 | A quota per person (workspaces, sessions, spend)? Out of scope here | Product |


## 20. Organizations slice 0: the real person on every request (2026-10-31)

Organizations PRD §13 (branch `docs/orgs-design`), prerequisites P1 and P2, plus the minimal P6 linking rule. ✅ code, tests in `apps/server/src/{authz,identity,qa,reporter}/orgsSlice0.test.ts`.

- **Actor.** `requireSession` sets `actor` once per request: the server code is `u_owner`; an admin account is its OWN user id. `actorOf` reads only that (a request with a session token and no actor is anonymous: fail closed). Sockets read the same person from the same cookie (`useSocketActor`); the live hub keeps it per tab (per-person filtering is P5, slice 2). Audit rows written through `actorString(actorOf(c))` and the account audit in `app.ts` name the person who acted.
- **Founder account.** One email account may be the founding user (`users.founder`, migration 460): the earliest admin made in the portal (`created_by = 'ui'`, only the server code's holder could make the first), so the owner signing in by email stays `u_owner` (their sessions, buckets, notifications). It counts only while that account is an active admin; nothing sets it at sign-in or from a provider. 🔬 The owner should confirm which account it is (`SELECT email FROM users WHERE founder = 1`).
- **D-82 holds.** An active admin account also holds what the founding user holds (`useAccountRoles`, the role read on every use), so a second admin loses nothing but is itself in audit rows and tokens. A member, a disabled or a removed account holds only its own; a disabled account's token or job acts for nobody. Slice 1 (P3) narrows this when owners and resolvers land.
- **User ids** are `u_` plus base64url (`identity/users.ts`); `USER_ID_PATTERN` now takes both cases, `-` and `_` (the hex-only pattern refused every real account id).
- **Tokens.** `pmcp_tokens.owner_id` (migration 461, backfilled `u_owner`): a Portal MCP or VS Code token acts as its minter, capped by its scope; no owner is nobody. A reporter token is its approver (`actor_user`; a value that is not a user id acts for nobody, the old ones were backfilled). Agent tokens stay their session's owner (the founding user until sessions record a creator).
- **SSO.** A provider that makes admins makes each as its own user (never the founder). An email match never links an account that has a password of its own (`users.password_set`), is an admin or the founder, or is held by any other SSO identity.
