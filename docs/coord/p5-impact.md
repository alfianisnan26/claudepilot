# P5 impact map: what multi-user changes for every other plan (2026-10-12)

Author: P5. The same tables as `docs/prd/multi-user.md` §12 (kept in step; that file is the one in the repository), plus what has ALREADY LANDED of each plan's contracts and migrations, the hot files several tracks edit, and the adoption evidence found in the tree. Read PLAN-10 section 2 (M1 to M8) and `COORD/outbox-p5.md` (the adoption rules) first.

## A. What has landed (contracts, migrations, seam adoption) and how it fits

| Plan | Landed in the tree | Multi-user facts in it | Fits? |
| --- | --- | --- | --- |
| 2 catalogue, git | contracts `mcp.ts`, `repos.ts`; migrations 100 (`mcp_builtin_instances`), 120 (repos) | `added_by`, `reviewed_by`, `proposed_by`, `repo_events.actor` are text; no owner | yes: strings take `actorString`; owners come with the retrofit |
| 3 Connect | contracts `connect.ts`; migrations 130, 131 (targets, nodes, enrollments, audit events, settings) | `created_by` default `u_owner`; one resolver per object (T1 status) | yes: `target` is a platform object |
| 4 usage, glance | contracts `claudeusage.ts`, `usage.ts`, `usagebudget.ts`, `glance.ts`; migrations 170, 171, 180 to 183 | `created_by`, `owner`, `actor` default `u_owner`; `actorId` on every glance source; `Visibility` hook; `creatorOf(session)` | yes; `creatorOf` must return `string \| null` |
| 5 platform | contracts `notify.ts`, `triggers.ts`, `autotransfer.ts`; migration 200 (notifications and the **platform audit**: `platform_audit`); code `platform/{audit,owner,index}.ts`, `notify/authz.ts` | `owner_id`/`user_id` default `u_owner`; `platform/owner.ts` is ONE adapter over the seam (**checked: it imports `actorOf`, `can`, `canUser`, `isPlatformAdmin`, `ownersOf`, `usersWith`, `actorOfSocket` from `authz/seam.ts`**); `PlatformAudit` | yes; identity extends `platform_audit` instead of making a second audit (identity PRD FR42) |
| 7 version pin | contracts `claudeversion.ts`; migrations 300, 301 (history, canary runs, events with `actor` default `u_owner`; "owner and creator columns") | upgrade and rollback rows carry an actor | yes |
| 9 btw | migration 380 (`chat_btw`: `user_id`, `created_by`, `actor user:<id>`, per asker, private) | already per asker | yes; a sharee's side questions stay private to them |
| 16 Codespaces | `codespaces/**` (service, routes, device flow, standin), `codespaces/authz.ts` | `ownerId` per connection; imports `clearResolvers`/`registerResolver` from the seam; persons only (agents and tokens get 403); tested with `u_a`, `u_b` | yes |
| 10 (this) | contracts `authz.ts`, `identity.ts`, `sharing.ts`, `teams.ts`; `authz/seam.ts` (+ `seam.test.ts`, 11 tests) | | |

Adoption evidence (V: read in the tree 2026-10-12 ~06:20): `platform/owner.ts`, `platform/index.ts`, `notify/authz.ts` and `codespaces/*` already use the seam; `glance`, `usagespend` and `claudeusage` still use their own `OWNER_ACTOR = 'u_owner'` (fine until the retrofit).

## B. Files several tracks edit (the collision map)

| File | Edited by | Rule |
| --- | --- | --- |
| `apps/server/src/app.ts` | every module mount (24 groups), T1, N1, MU1/MU2 | surgical; MU1/MU2 add `authenticate` and `authorize` once each |
| `apps/server/src/index.ts` | every module's wiring | one line each; re-read before editing |
| `apps/server/src/live.ts`, `contracts/src/live.ts` | G1 (`repos`), U4 (`glance`), N1 (presence, topics), T1 | MU8 only after those report done |
| `apps/server/src/chat/controller.ts` | A2 (owner), U1b hooks, B3 hook, T3 hook, N4, S1, D1 | MU3 only when none of them is open |
| `apps/server/src/store/migrations.ts` | every track, one block each | append only, own block (MU: 400-459) |
| `apps/server/src/platform/audit.ts` | N1 | MU1's additive extension after N1 is done |
| `apps/web/src/app/{App.tsx,nav.ts}`, `features/admin/AccessPage.tsx` | U3, B4, T5, MU9, MU19 | surgical |

## C. The impact tables


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

