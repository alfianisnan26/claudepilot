# P5 audit: multi-user with a security focus (2026-10-12)

Author: P5 (auditor and architect). Scope: the owner's ask in COORD/PLAN-10.md section 0 (items 1 to 4) plus the cross-cutting rules, audited against the code of this checkout and the PRDs. Nothing here is runtime code. How things were checked is stated per row: **V** = verified here (code read, a script run, a test run), **D** = documented (a source linked), **U** = unverified.

## 0. Method and what was run

| What | How | Result |
| --- | --- | --- |
| The schema as it is | Ran every migration of `apps/server/src/store/migrations.ts` (sorted by version) in `node:sqlite` in memory and dumped `PRAGMA table_info` (script: scratchpad `pu/dump-schema.mts`) | 51 migrations, 106 tables at the time of writing (other tracks keep adding). No table has a `user`, `owner` or `created_by` column except `usage_budgets.created_by`, `usage_spikes.owner`, `usage_audit.actor` (all `DEFAULT 'u_owner'`, the round-4 light-touch rule), `mcp_builtin_instances.added_by`, `mcp_catalog_versions.reviewed_by/proposed_by`, `persona_proposals.decided_by`, `chat_sessions.started_by` (an actor string) |
| The route table as it is | Built the REAL app with `createApp` and stub services (the technique of `qa/auth.test.ts`) and listed `app.routes` (script: `pu/dump-routes.mts`) | 261 method routes from the app plus 6 browser routes (the browser module was stubbed) = **267 routes**, plus `ALL /mcp`, `ALL /api/*` (the 404 catch-all) and the SPA catch-alls |
| How a central policy can find the route | Hono 4.13.13: `c.req.matchedRoutes` inside a middleware lists the composed patterns in order (`ALL /api/*`, `ALL /api/chat/sessions/*`, `GET /api/chat/sessions/:id`); `app.routes` has the same composed paths; routing is strict (`/api/x/` does not match `/api/x`) (script: `pu/hono-routes.mjs`) | A single middleware can look up `METHOD pattern` and refuse a route that has no declaration; a test can enumerate `app.routes` |
| The tools as they are | Scanned `registerPortalTool` sites (script `pu/tools-gen.mjs` over `tools.tsv`) | **87 Portal MCP tools**: 50 declare scope `agent`, 15 `read`, 8 `operate`, 14 `admin` (table in Appendix B) |
| Password hashing | `node:crypto` scrypt benchmark on this machine (8 cores): N=2^15 ≈ 70 ms, 2^16 ≈ 130 ms, 2^17 (OWASP's minimum) ≈ 250 ms and 128 MiB; 8 parallel hashes at 2^15 stall the event loop 3 ms; `N=2^17` needs `maxmem` (default limit 32 MiB: `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`, checked); Node here is 22.23.3 and has **no `crypto.argon2`** (added in 24.7), the Docker image is `node:22-bookworm-slim` | scrypt via `node:crypto`, no dependency (D2 in the PRD) |
| The data model | The DDL of the PRDs run in `node:sqlite` on top of the real migrations, with the invariants exercised: last active admin, a team's last owner, append-only audit, one pending invitation, the level query, the retrofit `ALTER`s and the `root_id` backfill (`COORD/p5-schema-check.mts`) | all assertions held |
| Standards | OWASP Password Storage, Session Management, Authentication, Authorization and IDOR cheat sheets fetched 2026-10-12 (**D**); NIST SP 800-63B-4 as cited by OWASP | numbers used in the PRDs are quoted from them |

## 1. The audit table (every numbered item and sub-bullet of PLAN-10 section 0)

Status: **Exists**, **Partly**, **Missing**. "Constrains" is what in the current code or PRDs limits or contradicts the new ask.

### 1. Onboarding and users

| # | Item | Status | Evidence (V) | Constrains / contradicts |
| --- | --- | --- | --- | --- |
| 1.1 | Remove the server-code login; the flow always starts from onboarding | **Missing** | `portal.ts` `Portal.signIn(code)`, `app.ts` `POST /api/login`, `features/auth/LoginPage.tsx` + `ServerCodeInput.tsx`; `index.ts` prints `server code: XXXX-XXXX` at start; `config.serverCode` = `PORTAL_SERVER_CODE` | web-app-pwa §12.4 ("the code and the sign-in switch persist"), portal-mcp §12.5 ("enabling MCP needs a stable server code", a consent page that puts the code on a public page) assume it; 12 test files and 5 scripts sign in with it (section 8) |
| 1.2 | First user becomes platform admin with a one-time setup token (log or CLI); an existing install uses the old code once, then it is deleted | **Missing** | no `users` table (schema dump); no setup route; `cli.ts` knows `status backup restore rotate-key forget-secrets generate-key` only | an existing install only has the env code (`PORTAL_SERVER_CODE`) or a code printed in a log; "deleted" can only mean "never accepted again" (an env var cannot be removed by the portal) |
| 1.3 | Registration with username + password; modes closed / invitation (default) / open with approval, set by the admin | **Missing** | nothing registers | the `settings` store (`defineSetting`) has no enum type (boolean, number, string) so the mode lives in its own small table, readable before sign-in |
| 1.4 | Profile: display name, avatar, change password, sessions and devices that can be revoked | **Partly** | `AccessPage.tsx` "Sessions" row = a count (`AdminState.sessions`) and Sign out for THIS session; `web_sessions` holds `token_hash, created_at, expires_at` only (migration 5), so there is nothing to list; the avatar pipeline exists for personas (`persona_avatars`, the re-encode rules of persona-pool §16) | web-app-pwa §12.4 designed `devices` and `web_sessions` with device names, kept flag, Access email (**Not built**); reuse the avatar pipeline rather than a second one |
| 1.5 | No email: reset by an admin or by the CLI on the host | **Missing** (designed as one-time reset codes, never temporary passwords; the honest limit of admin resets is stated in identity §12 I20) | no reset path; `cli.ts` commands above; the CLI works on the database directly while the portal runs for `status` and `backup` (read-only safe), but write commands need the portal stopped today (`acquireLock`) | a reset while the portal runs must not leave a stale session in memory: `Portal` caches sessions in a `Map` (`#sessions`), so sessions become database-authoritative (D4) |
| 1.6a | argon2id or scrypt hashing with stored parameters | **Missing** | the only secret compare is `Portal.matches`: SHA-256 of an 8-character code, `timingSafeEqual` | scrypt at N=2^17 (checked above); the hash string carries its parameters so they can be raised and a login rehashes |
| 1.6b | Attempt limits and lockout | **Partly** | `rateLimit.ts` `RateLimiter` (fixed window, in memory, 10 failures per address per 10 minutes: `config.loginLimit`); a second limiter for re-auth keyed by the session hash (`chat/routes.ts`), one for the key unlock (`app.ts`) | per ADDRESS only (no per-account counter), memory only (a restart resets it), and `clientKey` (not ours) depends on `PORTAL_TRUST_PROXY`: behind a proxy without it everyone shares one address |
| 1.6c | Safe cookies | **Partly** | `app.ts` `setCookie(... httpOnly, sameSite: 'Strict', path: '/', maxAge: 12h)`, name `portal_session`; no `Secure`, no `__Host-` prefix, no `Domain` (good) | PRD §12.3 designs `__Host-cp_session` with `Secure` on a TLS listener and the plain name on the LAN listener (the app listener is **Not built**); OWASP recommends `__Host-`; a `Secure` cookie is refused over plain HTTP off localhost, so the name and flag follow the request scheme |
| 1.6d | Every session revoked on a password change | **Missing** (a pattern exists) | `Portal.rotate(keep)` signs out every other session when the code changes and calls `onRevoked`, which makes `SocketGuard.sweep()` destroy their sockets | reuse: revoke rows, bump `users.token_epoch` (kills tokens and agents too), sweep sockets; OWASP asks the session id to be renewed after a privilege change |
| 1.6e | Origin and CSRF checks stay | **Exists** | `app.ts`: `csrf()` plus an Origin / `Sec-Fetch-Site` check on every non-GET `/api/*`; each of the five socket upgrade handlers has its own `sameOrigin()` (live, chat, shell, browser x2) | the public routes (login, setup, register) sit under `/api/*`, so they get the same checks for free; `/mcp`, `/hooks/*` and `/connect/*` are outside and use tokens |
| 1.7 | Dev/test seed (CLI or env), OFF in production | **Missing** | the equivalent today is `PORTAL_SERVER_CODE` + `POST /api/login {"code"}` and the cookie `portal_session` (PLAN.md §5; `tools/qa/lib.mjs` `login()`; `qa/*.test.ts` and `portalmcp.test.ts`, `live.test.ts`, `repos/live.test.ts`; `mcp/oauth/*`; `COORD/drive.mjs` takes the cookie value) | `boot.test.ts` boots with `NODE_ENV=production` and the code, so a production-mode test needs the setup flow or a different recipe (work package A1 lists the edits); PLAN.md §5 now requires `env -i` scratch portals (PLAN-2 A.11): the seed must work from a clean environment |
| 1.8 | Existing data becomes the first user's (a migration) | **Missing** (the id convention exists) | `u_owner` appears in 38 files (and growing): `claudeusage/actor.ts`, `usagespend/actor.ts`, `glance/build.ts`, `mcp/oauth/service.ts`, web `glance/user.ts`, `lib/usage/palette.ts`, `contracts/{notify,triggers,autotransfer,claudeversion,usagebudget}.ts`, migrations 181-183 | the first account takes the id `u_owner` (D1), so nothing that says `u_owner` is rewritten; workspaces are the exception (the runtime is the record) and get ownership rows at setup |

### 2. Access model

| # | Item | Status | Evidence (V) | Constrains / contradicts |
| --- | --- | --- | --- | --- |
| 2.1 | Every object (workspace, set, ticket, document or note, session) has an owner (user or team) and per-user and per-team rights view, operate, manage | **Missing** | owner data: none (schema dump). Workspaces: labels `claudepilot.managed/workspace/portal` on the container, no user (`workspaces/runtime.ts` `LABEL`), the runtime is the record; sessions: `chat_sessions` has no creator (only `started_by`, an actor string like `ui`); tickets: `reporter_*`, `assignee_*` are labels; pools: `pools` has no owner; vaults: `kg_vaults` none; accounts, endpoints, CI repos, repos: none | `tickets/service.ts` `Caller` (ui, system, token, agent) with `#visible` is the only precursor; `knowledge/journal.ts` has an `Actor` of its own |
| 2.2 | ONE authorization layer, default deny, used by every route, socket, MCP token and job | **Missing** | the guard is `requireSession` mounted per group (24 `use(requireSession)` in `app.ts`) and `portal.session(cookie)` in four socket files; Portal MCP checks scope in `portalmcp/server.ts`; services take no actor (`ChatController` has ~50 public methods, only `send/respond/rename/create` take an `actor` string) | positive: the route table is enumerable and a test already does it for "401 when signed out" (`qa/auth.test.ts`); verified `matchedRoutes` gives the pattern (section 0) |
| 2.3 | Agent and admin tokens are bound to an owner, never exceed the owner's rights, revoked when the user is disabled | **Missing** | `pmcp_tokens` (id, label, token_hash, scope, workspace_id, session_id, purpose, ...) and `pmcp_agent_tokens` (id, token_hash, workspace_id, session_id, vaults, ...) have no owner; `PortalPrincipal` has no user; every `cpat_` token acts as "the admin" (portal-mcp §12.5) | revocation machinery exists: `PortalTokens.revoke/revokeAll`, `AgentAccess.revokeSession/revokeWorkspace/revokeAll`, `PortalMcpModule.lockdown`, and `agents.verify` already checks liveness of the session on every call |
| 2.4 | Audit per actor: approvals, Bypass, secret access, sharing, setting changes | **Partly** (and a platform audit now exists: migration 200's `platform_audit`, written by `platform/audit.ts`, readable at `GET /api/platform/audit`; identity rows go there) | approvals: `chat_requests.actor` + `outcome`; Bypass: `chat_audit` kinds `bypass.capable/refused/entered/left` with `actor`; secrets: `secret_events`, `exposures` (which workspaces a secret reached); settings: `setting_changes.actor` is the literal `Admin` (`settings/index.ts`); Portal MCP: `pmcp_audit` with token id and ip; 17 more per-module audit tables | every actor is a free-text label (`ui`, `Admin`, `session:<id>`, `portal-mcp:<token id>`, `ci:<run>`, `system`), validators pin the shapes (`isChatActor`, tickets' `^[a-z][a-z0-9-]{1,24}:[A-Za-z0-9._~:-]{1,80}$`, knowledge `parseActor`); there is no sharing audit and no one place to read "what did person X do" |

### 3. Sharing one workspace

| # | Item | Status | Evidence (V) | Constrains / contradicts |
| --- | --- | --- | --- | --- |
| 3.1 | Share with another user by username | **Missing** | no users, no grants | workspace identity is `<target>/<name>` and the portal keeps no row per workspace; ownership needs a table of its own (`workspace_owners`) |
| 3.2 | A consent screen of what comes along (MCP, skill and persona sets, tickets, docs), each item checkable | **Missing** | the data exists: `assignments` (`GET /api/workspaces/:t/:n/pools`), tickets by `workspace_id`, vaults | sets are pool objects with their own owners; a share must grant rights on each ticked item, not copy it |
| 3.3 | Secrets default OFF with a warning that anyone who can operate can read the values | **Missing** (the warning exists) | foundation §10 "inside a workspace, every delivered secret is readable by its users (they have `sudo`)"; secrets-env-pool T4 and FR10 "assigning is sharing", `exposures` records every workspace a secret reached | the truth is physical: delivered values sit in the container's filesystem. "Off" therefore has to mean the secret is NOT in the workspace while it is shared (removed by the safe unassign), not "hidden from the other person" |
| 3.4 | Sessions in a shared workspace private to their creator unless shared | **Missing** | chat-sessions §15 "Shared visibility: with one shared server code, everyone signed in can read every session, and workspace users can read its files in the workspace" | a session is read through `view`; the Files panel and diff read the session's folder, so a session share includes that folder (stated in the consent) |
| 3.5 | A share can be revoked and the list is visible | **Missing** (precedents exist) | `SocketGuard` cuts sockets on sign-out; `AgentAccess.revokeWorkspace`; the safe unassign flow (`removals`, `PoolService.deleteWithUnassign`) | revocation must also reach what is DOWNSTREAM: assignments made by the revoked person, running sessions and terminals, open sockets, notifications |

### 4. Teams

| # | Item | Status | Evidence (V) | Notes |
| --- | --- | --- | --- | --- |
| 4.1 | A Teams menu; create a team | **Missing** | `app/nav.ts` has 9 items, none for groups | one nav item, group `work` |
| 4.2 | Invite users by username, they must accept, rate-limited | **Missing** | no users | `auth_throttle` scope `team_invite`; one pending invitation per (team, person) by a partial unique index (checked) |
| 4.3 | One user creates and joins many teams | **Missing** | | `team_members (team_id, user_id)` many to many |
| 4.4 | One or more owners decide who may join; a team is never without an owner | **Missing** | | enforced twice: in the service and by two triggers on `team_members` (checked in node:sqlite) |
| 4.5 | Members share a workspace to a team with the sets inside; a set can be shared to a team alone | **Missing** | | a team grant reaches members while they are members; leaving ends it at once (checked in the level query) |
| 4.6 | Sharing covers the related features (documents, tickets, ...) with the same rules; what comes along is always visible and checkable | **Missing** | | one consent model for every object type (`OBJECT_TYPES` has `grants: true` for workspace, session, claude, ticket, pool, account, endpoint, account pool, vault, target, template) |

### Cross-cutting rules of the ask

| Rule | Status | Evidence / note |
| --- | --- | --- |
| No secret in a log | **Partly** | redaction exists (`chat/redact.ts`, `portalmcp/sanitize.ts`, `ci/values.ts`); BUT the server code is printed in full at start when generated (`index.ts` `server code: ${formatCode(portal.code)}`) and returned in clear by `GET /api/admin/state` (`AdminState.code`) to every signed-in session. Both disappear with the code. New: the setup token is masked in the log (full only from the CLI), passwords and invitation codes never reach a log or an audit row |
| Abuse tests across users | **Missing** | single user, so none; precedents: `qa/auth.test.ts` (every route refuses a signed-out caller; made-up and expired cookies), `qa/sockets.test.ts`, `qa/idcheck.test.ts`, `tools/qa/fuzz-api.mts`. The matrix is written in authorization.md §12 and becomes an executable suite (package A9) |
| Open registration, brute force, invitations | **Missing** | threat model rows in identity-onboarding.md §12 |
| The plans in flight assume ONE user | **Partly handled** | the coordinator's light-touch rules (a constant `u_owner`, `owner_id`/`created_by` columns, resolvers) are in place in ~27 files; the impact map (multi-user.md §12, p5-impact.md) says what each plan does now and what the retrofit does |
| UI text diet, 390 and 1280 px, tests, PRD updates, browser verification | **Required of the implementers** | UX sections are within the diet; browser verification is part of each work package's acceptance |

## 2. What the current sign-in really is (facts, all V)

- **Sessions.** `Portal` keeps a `Map` of sessions keyed by the SHA-256 of a 256-bit token and mirrors it into `web_sessions` (token hash, created, expires), loaded at start. Lifetime 12 h (`config.session.ttlMs`), no idle timeout, no device data, no user. The cookie is `portal_session` (`HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`).
- **The code.** Eight characters of a 31-letter alphabet (about 40 bits), compared by SHA-256 + `timingSafeEqual`; env-supplied (`PORTAL_SERVER_CODE`) or generated at start and printed in the log; rotation signs everyone else out.
- **Limits.** Login: 10 failures per client address per 10 minutes (memory). Re-auth: 10 per session per 10 minutes. Key unlock: 10 per address.
- **Re-auth.** `chat/reauth.ts`: a fresh server-code check within 10 minutes, marked on the `Session` object (a `WeakMap`), guards Bypass only today (web-app-pwa §12.5 lists more: not built).
- **Sockets.** `SocketGuard` (sockets.ts) tracks open sockets by token and destroys them when the session ends (sweep every 15 s and on sign-out and code rotation). Each of the five upgrade handlers (live, chat, shell, browser view and preview) checks Origin and the session cookie at the handshake and then trusts the connection.
- **Headers.** `secureHeaders` with a CSP on the built app (`csp.ts`); `Cache-Control: no-store` on `/api/*`; body limits (4 KB for login, 4 MB JSON, 256 MB uploads).
- **Public surface.** `GET /healthz`, `GET /api/session`, `POST /api/login`, `POST /api/logout`, `ALL /mcp` (bearer), the SPA and its assets.

## 3. What `@isnanme/core` provides, and what it cannot be asked for

`node_modules/@isnanme/core` (version 0.1.0, read-only; "runtime-agnostic primitives: Result, AppError + error-code registry, API envelope, cursor, ids, time"). V: read `README.md`, `src/errors.ts`, `src/id.ts`, `src/guards.ts`, `src/envelope.ts`, `src/encoding.ts` and the export table.

| Module | Used here | Relevance to this work |
| --- | --- | --- |
| `errors` (`AppError`, `defineErrorCodes`, `codeForStatus`) | everywhere (63 imports) | the way to add the new codes (`NO_POLICY`, `LAST_ADMIN`, `TEAM_NEEDS_OWNER`, ...): `defineErrorCodes` + the `ErrorCodeRegistry` augmentation, as `chat/bypass.ts` does. 5xx hide their message. `NOT_FOUND` 404, `FORBIDDEN` 403, `UNAUTHORIZED` 401, `RATE_LIMITED` 429, `CONFLICT` 409, `VALIDATION_FAILED` 422 exist |
| `envelope` (`success`, `isApiErrorBody`) | everywhere | wire shape `{ data }` / `{ error: { code, message, details? } }`; a 403 for a missing level carries `ForbiddenDetails` in `details` |
| `id` (`newId` UUIDv7, `randomToken`) | tickets, chat | UUIDv7 carries a timestamp in its first 48 bits: fine for sortable internal ids, but user ids, share ids and invitation codes use plain random bytes (no creation time leaks) |
| `cursor`, `time`, `money`, `case`, `guards`, `result` | partly | nothing to do with identity |

**It contains no authentication, session, password, guard or permission code at all.** The "guard" is entirely in this repo (`portal.ts`, `sockets.ts`, `app.ts`, `rateLimit.ts`). Nothing needs to be wrapped or replaced inside node_modules; everything new is added here, and the new error codes use core's registry as it is. The UI kit `@isnanme/ui` is untouched (it has `CodeInput`, which the login no longer uses).

## 4. Security findings in today's code (what the design removes or fixes)

| # | Finding | Severity (today / in a multi-user portal) | Fixed by |
| --- | --- | --- | --- |
| F1 | `GET /api/admin/state` returns the shared server code in clear to any signed-in session (`AdminState.code`); the Access page reveals it | Low (one person) / **Critical** (every user would hold the admin credential) | the code is gone (identity PRD) |
| F2 | The generated code is printed in full in the log at start | Low / High | no code; the setup token is masked in the log |
| F3 | Login limiter per address only and in memory; `clientKey` collapses clients behind a proxy that is not trusted | Medium / High | persistent per-username and per-address counters (identity §8) |
| F4 | Re-auth is the shared code | n/a / High (one password for everyone) | re-auth is the person's password |
| F5 | `LiveHub` computes ONE JSON snapshot of ALL workspaces (and usage rows) and sends it to every live socket (`#snapshot`, `#deliverWorkspaces`) | none / **High**: cross-user leak by design | per-client filtering (authorization §9) |
| F6 | The chat socket subscribes any signed-in tab to any session id and returns its stored events (`controller.history`) with no check | none / **Critical** | `subscribe` needs `view`, every message re-checks, revocation drops subscriptions |
| F7 | The shell socket opens a shell in any workspace for any signed-in session; terminal ids are `claude-1`..`shell-99` and a tab may attach to any (`TERMINAL_ID`); a `claude` terminal runs as one Claude with that Claude's login | none / **Critical** | `operate` on the workspace, terminals owned by their creator, a Claude's terminals need `operate` on that Claude |
| F8 | The browser live-view lease is keyed by a client-chosen `device` string (`browser/control.ts`, `socket.ts`): presenting another person's device id continues their lease | none / High | the lease binds (user, device) |
| F9 | Portal MCP: every `cpat_` token is "the admin" and a `read` token lists every workspace, session, account and the whole audit (`audit_search`, `GET /api/portal-mcp/audit`) | none / **High** | tokens bound to an owner; tools declare access; audit filtered |
| F10 | "This machine" (`PORTAL_LOCAL_ENABLED`) gives a shell as the portal's OS user to anyone who can operate that workspace | Accepted (the owner enabled it) / **Critical** | host-level targets and their workspaces are admin-only; sharing them to a non-admin is refused |
| F11 | Delivered secrets, API keys and each Claude's sign-in are plain files in the workspace volume, readable by anyone with a shell | Known (secrets-env T4) / **High** | sharing rules: credentials default off and removed when unticked; the consent says what `operate` means |
| F12 | Most services take no actor: `Workspaces.list()`, `ChatController.list/get/history`, `PoolService`, `AccountsService.overview`, `KnowledgeService.vaults`, `CiService` queries return everything | none / **Critical** | actor parameters or façades with `visible()`; list filters before paging and counting |
| F13 | Audit actors are labels; the setting audit writes `Admin` | Low / High (cannot say who) | `actorString` with `user:<id>`; the platform audit |
| F14 | `blobs` is a global content-addressed store (`putBlob` returns the sha256) | none / Low | safe as long as a blob is only served through a link row of the requesting session (`blobFile(id, blobId)`) and uploads never take "a hash instead of bytes". Written as a rule |
| F15 | Cookie has no `Secure` / `__Host-` | Low (LAN) / Medium (a TLS front) | name and flag follow the request scheme |
| F16 | `chat_sessions` has no owner, so "who ran this" for usage is unknowable for existing rows | n/a | `created_by_user` stays NULL for sessions that exist at the cutover; the usage track shows them as "Before users" (PLAN-12) |
| F17 | `GET /api/session` is public and tiny; it must stay tiny when it gains `setup` and `registration` | n/a | `AuthStatus` carries only what a signed-out visitor needs |
| F18 | The inherited environment of the portal process can carry the operator's credentials (`CLAUDE_CONFIG_DIR`, `SSH_AUTH_SOCK`, `KUBECONFIG`, tokens): the 2026-10-12 incident (PLAN-2 A.11) | Medium / High | environment hygiene (FR in identity §10): children get an explicit allow-list, the server warns by name, `PORTAL_ENV_STRICT=1` refuses |

## 5. The object inventory: every table and who owns it today

"Today" = what the schema and code say (V: schema dump, `grep` of the services). "Becomes" = the owner column or resolver the retrofit adds (authorization.md §6). Tables of tracks still in flight (Connect 130-169, notifications 200-259, triggers, evidence 260-299, version pin 300-319, PLAN-8 320-379, btw 380-389, delegation 460-479, usage per user 480-499) are listed as they appear in their PRDs; none landed in `migrations.ts` yet.

| Area (module) | Tables | Owner today | Becomes (object type, owner) |
| --- | --- | --- | --- |
| Sign-in (portal, store) | `web_sessions` | none (token hash) | replaced by `login_sessions` (user) |
| Workspaces (runtime) | none: the container/Deployment with labels; `pending-creates.json`, `local-workspace.json` files | none | `workspace_owners` (workspace, user or team); pending creates carry the owner |
| Chat (A2) | `chat_sessions`, `chat_events`, `chat_inputs`, `chat_requests`, `chat_tasks`, `chat_files`, `chat_uploads`, `chat_folder_trust`, `chat_segments`, `chat_session_aliases`, `chat_audit`, `chat_worktrees`, `chat_usage`, `claude_handoffs`, `blobs` | `started_by` (actor string) only | session: `owner_id` + `created_by_user` + `root_id`; children by `session_id`; `chat_requests.decided_by_user`; `chat_usage.user_id`; `blobs` stay global, reached by link |
| Claudes | `workspace_claudes` | none | claude: `owner_id` (who signed in / made it); guard operate on the workspace |
| Pools foundation (A3a) | `pools` (all types incl. `account`), `pool_revisions`, `assignments`, `removals`, `workspace_delivery`, `delivery_events`, `exposures`, `outbox_seen` | none | pool / account_pool: `owner_kind`, `owner_id`; assignment validity swept on revocation |
| Accounts | `accounts` (keys, sealed), `endpoints`, `account_events`, `account_assignments` | none | account, endpoint: `owner_kind`, `owner_id` |
| Secrets & env | `secret_values`, `secret_rotations`, `secret_events` | by pool | pool (type secrets) |
| MCP sets | `mcp_catalog`, `mcp_catalog_versions`, `mcp_delivery`, `mcp_installs`, `mcp_verify`, `mcp_plugin_folders`, `mcp_events`, `mcp_builtin_instances` | `reviewed_by`, `proposed_by`, `added_by` text | mcp_entry (platform library; drafts owned by their author); sets are pools |
| Skills | `skill_sources`, `skill_versions`, `skill_files`, `skill_reviews`, `skill_inventory`, `skill_plugin_folders`, `skill_proposals` | none | skill_source / skill_version (platform library) |
| Personas | `persona_meta`, `persona_avatars`, `persona_proposals` | `decided_by` text | pool (persona) + proposal (decided by the pool's owner) |
| Settings | `portal_meta` keys, `setting_changes`, `lockdown_state` | `actor` text (`Admin`) | platform (`settings`); `lockdown_state` per workspace |
| Portal MCP | `pmcp_settings`, `pmcp_tokens`, `pmcp_agent_access`, `pmcp_agent_tokens`, `pmcp_audit`, `pmcp_auth_events`, `pmcp_workspace_access` | none | token: `owner_id` + `token_epoch`; agent access per workspace (manage); audit `actor_user` |
| Tickets | `tickets`, `ticket_tags`, `ticket_events`, `ticket_checks` | `reporter_*`, `assignee_*` labels | ticket: `owner_kind`, `owner_id`; assignee a user id that must be able to view |
| Knowledge | `kg_vaults`, `kg_versions`, `kg_edges`, `kg_audit` (+ files under the data dir) | none | vault: `owner_kind`, `owner_id`; notes inherit |
| CI | `ci_workspaces`, `ci_repos`, `ci_events`, `ci_runs`, `ci_logs`, `ci_merges`, `ci_messages` | `actor` text | ci_repo / ci_run: children of the workspace (same level) |
| Repos | `repo_workspaces`, `repos`, `repo_events` | `actor` text | repo: child of the workspace |
| Browser | `browser_instances`, `browser_installs`, `browser_events` | none | browser: child of the workspace; lease binds (user, device) |
| Usage | `claude_usage_samples`, `claude_usage_latest`, `usage_sessions`, `usage_persona`, `usage_budgets`, `usage_spikes`, `usage_spike_snoozes`, `usage_audit`, `usage_palette` | `created_by`/`owner`/`actor` default `u_owner` (light touch) | Claude usage by Claude; budgets by scope; `memberScope` for per-person figures; palette kind `user` (needs a rebuild: its `kind` has a CHECK of claude and model) |
| Terminals | tmux sessions in the workspace (no table) | none | new `terminal_owners (workspace_id, term_id, owner_id)` |
| In flight, from the PRDs | connect (targets, nodes, enrollments) | `created_by` default `u_owner` | target (platform; `operate` to place a workspace) |
| | notify (destinations, prefs, history, answer tokens) | `user_id` default `u_owner` | personal (owner only) |
| | triggers, trigger_runs | `owner_id` default `u_owner` | trigger (owner) |
| | autotransfer_* | `user_id` default `u_owner` | personal |
| | claude version history / canary | `actor` text | platform (`version`) and workspace manage for an upgrade |

## 6. Sockets, tools and background actors

**Sockets (5 upgrade handlers + the guard)**: `/api/live` (live.ts: topics `workspaces usage accounts system pools tickets ci claudeusage repos glance`; `workspaces` and `usage` carry data), `/api/chat/live` (chat/socket.ts: `subscribe unsubscribe send respond control`), `/api/workspaces/:t/:n/shell` (workspaces/shell.ts, `?term=` to attach), `/api/workspaces/:t/:n/browser/view|preview` (browser/socket.ts), and `SocketGuard` (sockets.ts) tracking them by cookie token. Connect adds a tunnel endpoint for agents (its own node-key authentication, not a user). Decisions: authorization.md §9.

**Portal MCP tools**: 87 (Appendix B), registered through `registerPortalTool` in 18 files; scope-gated today, none object-gated. Scope `agent` (callable by an agent's session token): 50. The endpoint checks Origin and a bearer token and audits; the per-tool wrapper checks scope, rate and argument secrets.

**Background actors (all become `system`)**: store backups (hourly check), reconciler, outbox pull, account health, secret rotations purge, skills verify, knowledge index, Claude usage probes (a `claude` run in a workspace as each Claude), repo scans, CI runner polling, tickets watchers, browser supervisor, glance aggregator, chat readers and idle sleep, Portal MCP prune. None returns data to a person without a filter; none acts for a person except those the plans add (triggers, auto transfer, notification answers), which run as `job` actors with an owner.

## 7. Web surfaces touched

`lib/auth.tsx` (`AuthProvider`: `login(code)`), `features/auth/*` (the login page), `features/admin/AccessPage.tsx` (server code, sign-in switch, storage, sessions; tab MCP), `CustomCodeDialog.tsx`, `components/AccountMenu.tsx` (a shield icon and Sign out), `app/App.tsx` (`SignedInOnly`/`SignedOutOnly`), `app/nav.ts` (a Teams item), every list page (they show whatever the API returns), the glance and usage code that keys preferences by `u_owner` (`features/glance/user.ts`, `lib/usage/palette.ts`), and 403 handling (G2 and B4 already disable an action with the server's reason).

## 8. What signs in with the server code today (the dev/test recipe to migrate)

Scripts: `tools/qa/lib.mjs` (`login`), `tools/qa/browser.mjs`, `chat-once.mjs`, `fuzz-api.mts`, `sweep.mjs`; `COORD/drive.mjs` (takes the cookie value). Tests: `qa/{auth,boot,system,static,sockets,workspacepaths,idcheck,bodylimit}.test.ts`, `portal.test.ts`, `live.test.ts`, `repos/live.test.ts`, `portalmcp/portalmcp.test.ts`, `mcp/oauth/{service,oauth.integration}.test.ts`, `mcp/builtin/testkit/provider.test.ts`. Docs: README, `deploy/compose.yaml` (`PORTAL_SERVER_CODE`), `.env.example`, PLAN.md section 5. The decided recipe (identity PRD §11): `env -i PATH=$PATH HOME=/tmp/<prefix>home LANG=C.UTF-8 PORTAL_DEV_SEED=1 PORTAL_SERVER_CODE=<8 digits> ...` keeps `POST /api/login {"code"}` and the cookie `portal_session` working unchanged; `{"code":..., "as":"alice"}` signs in as another seeded account for cross-user tests.

## 9. Collisions and sequencing (summary; the rule per package is in p5-workbreakdown.md)

The retrofit edits almost every route file, `app.ts`, `index.ts`, `live.ts`, `sockets.ts`, the chat controller and socket, the Portal MCP module, and the web shell. Nothing of it starts in a file an agent has open. What can start without colliding: new files (identity, authz core, the policy table, resolvers in each module's own `authz.ts`) and surgical lines in the hot files after re-reading. The invasive step (changing service signatures, flipping enforcement, removing the code login) is one window, announced by the coordinator, with enforcement first run in shadow mode (decisions logged, nothing refused) so the policy tables are proven on real traffic before they bite.


## Appendix A. Route policy v0: every route of the real route table (267), one declaration each

Generated by `pu/policy-gen.mjs` from the real route dump and checked for coverage (267 routes, 267 covered, none matched twice, no unused rule). Notation: `public`; `in` = any active user (the handler returns the person's own data or a filtered one); `in:list(T)` = signed in and the list holds only objects of type T the person may view; `in:create(T)` = signed in, the new object is owned by the creator; `obj(T verb from param)` = a right on one object named in the path, query or body (the object checks are ANDed); `platform(area,verb)` = platform admins; `self` = the caller's own account or tokens; `+reauth` = a recent password check; `REMOVED` = the route goes away. It is the starting declaration of work package A2: the enumeration test fails on any route not in it.

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

Generated by `pu/tools-gen.mjs`; scope letters: R = read-only, D = destructive. `agent:` rows say what an agent token may reach on top of its owner's rights (its own session, session tree, workspace). Every tool declares its access at registration once the layer lands (a tool with no declaration is refused at start-up).

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
| `session_start` | admin D | workspace operate workspace_id; claude operate claude_id | the session is owned by the token's user; never bypass-capable |
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
