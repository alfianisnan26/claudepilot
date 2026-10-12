# P5 work breakdown: multi-user (identity, one authorization layer, sharing, teams)

Author: P5. Read first: `docs/prd/multi-user.md` (overview, impact map, interfaces for the usage follow-on, owner decisions), then the PRD of your package: `identity-onboarding.md`, `authorization.md` (its Appendix A is the route policy, B the tool policy), `sharing.md`, `teams.md`. The contracts are landed: `packages/contracts/src/{authz,identity,sharing,teams}.ts`; the seam is `apps/server/src/authz/seam.ts` (its header says exactly what it does today). The audit is `COORD/p5-audit.md`; the SQL is checked in `COORD/p5-schema-check.mts` (run it from `apps/server` with `npx tsx`).

## 0. Rules for every package (they add to PLAN.md sections 4 to 7 and PLAN-2 section A)

1. **Standing rules**: git is read-only for agents (status, diff, log, show); the owner's dev portal and `.data` are off limits; no real credentials; DinD only and never `--context host`; KUBERNETES SAFETY (A.10); economy rules (grep/sed ranges, no polling loops, a short status file with RESUME HERE); UI TEXT DIET; 390 and 1280 px, light and dark, looked at.
2. **CLEAN ENVIRONMENT (PLAN-2 A.11)**: every scratch portal starts with `env -i PATH=$PATH HOME=/tmp/<prefix>home LANG=C.UTF-8 ...` (the PLAN.md section 5 line). Until MU1 lands, sign in as today (`PORTAL_SERVER_CODE` and `POST /api/login {"code"}`); after MU1, add `PORTAL_DEV_SEED=1` and nothing else changes; `{"code":..., "as":"alice"}` gives a second account for cross-user checks. Tests that spawn `claude` or `ssh` set their own `HOME`/`CLAUDE_CONFIG_DIR`.
3. **Two flags make the rollout safe** (read once in `config.ts`; new keys only): `PORTAL_IDENTITY=legacy|accounts` (default `legacy` until MU12: the old server-code door keeps working so agents in flight are not broken; `accounts` turns the new door on for scratch portals and tests) and `PORTAL_AUTHZ=off|shadow|enforce` (default `off`, then `shadow` once MU2 is verified, then `enforce` in MU12). With `legacy` identity every request is `u_owner`, so enforcement can be exercised before accounts exist. Both flags are logged at start.
4. **Seam first, never around it.** New code calls `actorOf`, `requireCan`, `visible`, `canUser`, `ownersOf`, `usersWith`, `asUser`, `actorString`; it never reads an owner column outside its resolver and never trusts a user id from a body, a query or a header.
5. **Declarations are part of done**: every route you touch or add is in your module's `authz.ts` (`declarePolicies`), every tool in `declareToolPolicies`, every object type has a resolver. Appendix A and B of `authorization.md` give the starting rows.
6. **Each package adds its objects' rows to the cross-user fixtures** of the suite (MU11 owns the harness; MU2 ships its skeleton). A package is not done until its object types pass X1 to X7 of `authorization.md` section 12.
7. **Migrations**: your block only, append only, never edit a released migration (PLAN.md rule 5). Block 400-459: 400-409 identity (MU1), 410-419 authorization and sharing (MU2, MU13), 420-429 teams (MU17), 430-449 ownership retrofits (430 chat, 431 pools and accounts, 432 tickets, 433 vaults, 434 Portal MCP, 435 CI and repos, 436 usage, 437 triggers, notify and later tracks' tables, 438-449 spare), 450-459 cutover and cleanup (450 drop `web_sessions`). `multi_user_since` is written by 430.
8. **Ports and prefixes**: scratch portals 3282 to 3289 and CDP 9412 to 9419, one portal and one Chromium at a time per agent, stopped when idle; prefixes `mu1-` to `mu20-` (`mu<N>-` for package MU<N>) on names, tmux sessions, containers, `/tmp` dirs. Suggested: MU1 3282/9412, MU2 3283/9413, MU3 3284/9414, MU5 3285/9415, MU6 3286/9416, MU9 3287/9417, MU11 3288/9418, MU13 3289/9419; the rest reuse a free pair.
9. **Collisions (M8)**: a package that edits files another track owns starts only when that track has reported done and no agent has the file open (`git status` shows no uncommitted change of yours to the same file from another agent; the status files say done). Edits to hot files (`app.ts`, `index.ts`, `config.ts`, `live.ts`, `store/migrations.ts`, `packages/contracts/src/index.ts`, `apps/web/src/app/{App.tsx,nav.ts}`) are surgical: re-read right before editing, never reformat. List every cross-area edit in your report.
10. **Security rules**: no secret in a log, an audit row, an error or a response; passwords, hashes, session tokens, setup tokens, invitation codes appear only where the PRD says (once, to the person); text from outside is untrusted; every denial is uniform (404 for what you may not view).
11. **Reporting**: `COORD/status-mu<N>.md` (at most 40 lines, RESUME HERE), requests in `COORD/outbox-mu<N>.md`, the final report as PLAN.md section 7: files, what was verified and how, the decisions, the cross-area edits, the tests run.

## 1. Order and waves

```
W0 (done)  A0 contracts + seam
W1 (additive: new files, surgical lines in hot files; can run NOW, together)
           MU1 identity core ─┐
           MU2 authz core ────┼─ shadow mode on real traffic, the harness skeleton, the policy tables proven
           MU9 web identity (after MU1's routes answer; new files)
W2 (the window: one announced window, packages in parallel where files differ)
           MU3 chat · MU4 workspaces/targets · MU5 pools/accounts/library/settings · MU6 work objects (6a tickets+knowledge, 6b ci+repos+browser, 6c usage+glance)
           MU7 Portal MCP · MU8 sockets and live · MU10 web retrofit
W3         MU11 completes the matrix (full run) → MU12 flip to enforce + remove the code login
Phase 2    MU13 shares → MU14 revocation effects and sweep → MU15 web → MU16 matrix
Phase 3    MU17 teams → MU18 team-owned + shares to teams + memberScope → MU19 web → MU20 matrix
```

Concurrency stays at 8. W1 needs two free slots (MU1, MU2) plus one for MU9 later. W2 needs the coordinator's window: it is decided from the status files; the per-package conditions below are the checklist.

## 2. Phase 1: identity and the one authorization layer

### MU1. Identity core (server, CLI, seed) — size L — starts NOW

- **Builds**: `docs/prd/identity-onboarding.md` (Identity) §6 to §11: users, login sessions, setup (token, old server code once, claiming workspaces), sign-in with throttling and hashing, registration modes, invitations, profile and avatar, devices, admin user management, the identity rows of the platform audit (through `PlatformAudit.record`; migration columns and triggers), the CLI commands, the dev seed with its refusals, environment hygiene, `AuthStatus`.
- **Files owned (new)**: `apps/server/src/identity/**`: `users.ts`, `passwords.ts` (scrypt, the block list, the semaphore), `sessions.ts`, `throttle.ts`, `setup.ts`, `invitations.ts`, `registration.ts`, `audit.ts` (a thin `recordSecurity()` over the platform track's `PlatformAudit`, setting `protected`), `avatar.ts` (reuses the persona re-encode function: export it from `personas/` with one surgical line, tell A3c's owner), `devices.ts` (User-Agent table), `devSeed.ts`, `env.ts`, `routes.ts`, `cli.ts` (the commands, called from `src/cli.ts`), `index.ts`, `testkit.ts`, tests; `apps/server/src/identity/authz.ts` (resolvers for `user` and `personal`). Migrations **400-409** (the DDL of identity §13: the new tables, `identity_settings` seeded with one row, and the `ALTER`s and two triggers on the platform track's `platform_audit`). `platform/audit.ts` is the platform track's file: extend `AuditInput` additively (`outcome`, `ip`, `protected`) only when that track has reported done.
- **Surgical edits** (re-read first): `app.ts` (mount the identity routes before the guard; add `authenticate`, which sets `c.var.actor` from a valid login session in `accounts` mode and keeps the legacy `token` in `legacy` mode); `index.ts` (create the module, wire `SocketGuard` by login session id and the sweep, call setup-mode logic at start); `config.ts` (new keys: `identity`, `devSeed`, `cookieSecure`, `setupTokenLog`, `envStrict`, `passwordCost`); `src/cli.ts` (route `setup-token` and `user ...` to the module); `sockets.ts` (track by login session id and user, expose `cut(userId)`); `packages/contracts/src/index.ts` is already done.
- **Interfaces provided**: `Identity { users, sessions, authenticate(reqOrCtx): Actor, createUser, disable, reset, ... }`; `emitAccessChange` on sign-out, disable, password change, revoke; `GET /api/session` as `AuthStatus`; `IDENTITY_API` routes; the `Authenticator` MU2 and the sockets use. **Consumed**: `Store`, the seam, `identity.ts`.
- **Tests**: unit (hash format, parameters, rehash, `maxmem`, the policy and `passwordProblems`, the block list, throttle arithmetic by hand: failures 5 to 10 lock 30, 60, 120, 240, 480, 900 s, setup state machine and its race, invitation single use under parallel redemptions, cookie flags for HTTP and HTTPS, device labels); integration for every row I1 to I24 of identity §12; spawned-process tests for the seed refusals (production, proxy, real account, password cost) and for strict environment mode; audit invariants; a grep that no password, token or code is in the log or the audit; the existing `qa/auth.test.ts` still passes in `legacy` mode.
- **Acceptance**: a scratch portal with `PORTAL_IDENTITY=accounts` and no seed: setup with the CLI token creates `u_owner`; sign-in, devices, password change (other sessions die), invitation and open registration work by `curl`; a CLI reset works while the portal runs; with `PORTAL_DEV_SEED=1` from `env -i`, `POST /api/login {"code"}` works and `as` creates `alice`; production + seed exits non-zero.
- **Quiescence**: none (new files and five surgical lines). **Depends**: A0. **Order**: first.

### MU2. The real authorization layer — size L — starts NOW (with MU1)

- **Builds**: `docs/prd/authorization.md` (Authorization) §8 to §11: the real `Authz` (SQL level query, owner, team owner, grants, public level, parent rules, private objects, host-level rule, caps), the policy table from Appendix A as data, the tool table from Appendix B, the `authorize` middleware with the three modes, the enumeration tests, `authz.denied` audit sampling, `ownersOf`, `usersWith`, `memberScope`, the claim/unclaimed admin routes, the test kit and the harness skeleton.
- **Files owned (new)**: `apps/server/src/authz/{index,evaluate,store,policy,policy.routes.v0,policy.tools.v0,enforce,tools,audit,shadow,admin,testkit}.ts`, `apps/server/src/qa/crossuser/{harness,fixtures}.ts` (skeleton), tests. Migrations **410-419**: `workspace_owners`, `grants`, `terminal_owners` (the DDL of authorization §13; `shares` is MU13's).
- **Surgical edits**: `app.ts` (one `app.use('*', authorize)` after `authenticate`; nothing else), `index.ts` (register resolvers; `useAuthz(real)`; log the mode), `config.ts` (`authz` mode key).
- **Interfaces provided**: everything the seam exports, final; `UserDirectory` (reads `users`; a stub until MU1); the enumeration helpers; `crossUserApp()` and `makeUsers()` for every package's tests. **Consumed**: the identity module (user state, role, epoch, teams when they exist).
- **Merging declarations**: modules already declare their own routes (`connect/authz.ts`, `notify/authz.ts`, `claudeversion/authz.ts`, `chat/authz.ts`, `glance/authz.ts`, `codespaces/authz.ts`; checked in the tree 2026-10-12). Appendix A is the declaration of the routes that no module declares; where a module declares a route its declaration stands (a conflict throws in `declarePolicies`, so settle it in the module's file). Sockets are declared as `ALL <path>` (Appendix C). **Tests**: every deny reason, the level query table (the assertions of `p5-schema-check.mts` as unit tests), inheritance and guards, `private`, host-level, caps, expiry; the enumeration test over the real `createApp` (267 routes, 87 tools: all declared, none stale); shadow-vs-enforce parity on the generated probes; the micro-benchmark (`can` under 1 ms with 1,000 grants and 50 teams; `visible` of 5,000 rows under 20 ms).
- **Acceptance**: with `PORTAL_IDENTITY=legacy PORTAL_AUTHZ=enforce`, the whole existing server test suite still passes (the single owner owns everything: nothing changes), and with `shadow` a normal browser session records zero would-deny decisions for the owner.
- **Quiescence**: none. **Depends**: A0 (MU1 for the real user reader; a stub is enough to start).

### MU9. Web identity and shell — size L — after MU1's routes answer

- **Builds**: identity §15: `Set up`, `Sign in`, `Join`, `Reset` (redeem a reset code), `Register`, Profile (name, avatar, password, Devices), People (admins: list, Invite, Reset password with its one-time link, Registration control, Pending, Unclaimed), the account menu, the dev-seed bar, `REAUTH_REQUIRED` handling (a ReauthSheet), removal of the server-code UI behind `PORTAL_IDENTITY`.
- **Files owned (new)**: `apps/web/src/features/identity/**`; **replaced**: `lib/auth.tsx`, `features/auth/*`; **reworked** (surgical until MU12): `features/admin/AccessPage.tsx` (tabs Sign-in/MCP become Devices/People/MCP), `components/AccountMenu.tsx`; `app/App.tsx` (routes `/setup`, `/invite`, `/reset`, `/register`, `/profile`).
- **Interfaces consumed**: `IDENTITY_API`, `AuthStatus`, `Me`. **Provided**: `useMe()` (user, level helpers), `useReauth()`.
- **Tests**: web unit tests for the forms and the status state machine; browser checks at 390 and 1280 px, light and dark, looked at; the uniform error copy.
- **Quiescence**: `AccessPage.tsx`, `AccountMenu.tsx`, `App.tsx` free of other agents' edits at the moment of the surgical edits (re-read).

### MU3. Chat retrofit — size XL — in the window

- **Builds**: ownership and attribution for sessions and everything under them, the decider and Bypass actors, sockets, terminals, Claudes, re-auth by password, file and diff routes, and **the usage follow-on interface list** (multi-user §13 items 1 to 4).
- **Files owned (edits, in the window)**: `apps/server/src/chat/{controller,store,routes,socket,fileRoutes,trustRoutes,reauth,bypass,agents,portalTools,files,worktrees,usage}.ts`, `workspaces/{terminals,shell}.ts` (the terminal ownership part), `packages/contracts/src/chat.ts` (additive fields `ownerId`, `level` on `ChatSession`; `Access` fragment). Migrations **430** (`chat_sessions.owner_id/created_by_user/root_id`, `chat_usage.user_id`, `chat_requests.decided_by_user/decided_via`, `workspace_claudes.owner_id`, `multi_user_since`) and a data step that fills `root_id`.
- **Does**: `create` stamps the owner (a child copies its root's `owner_id`, `created_by_user`, `root_id`; a Move changes nothing); `#recordTurn` stamps `chat_usage.user_id`; `respond` records `decided_by_user` and `decided_via`; Bypass and approvals write `actorString`; `isChatActor` accepts `user:<id>`; the controller methods that read or change a session take the actor or a resolved session (`requireCan` at the route; the socket checks per message); `list` is filtered; `endUserSessions(userId)` and `endUserSessionsIn(workspaceId, userId)`; the chat socket takes its actor at the handshake and re-checks `view` on `subscribe` and `operate` on `send`, `respond`, `control`; `onAccessChange` drops subscriptions; terminals get `terminal_owners` (own only in the list; a Claude's terminals need `operate` on the Claude); a Claude has an owner and creating one needs `operate` on the workspace; `POST /api/chat/reauth` becomes an alias of the password check; resolvers `session` (aliases followed), `claude`, `terminal`.
- **Tests**: the rows X1 to X3, X5 to X8, X10, X13 for sessions, Claudes, terminals; the usage fields written correctly for a child, a Move, a ticket start and a job (hand-checked); the existing chat tests unchanged.
- **Quiescence**: A2, A2b, A7 done; S1 and S2 (btw) done; N4 (auto transfer hooks) done; D1 and D2 (delegation: `agents.ts`, the controller) done; the evidence track's chat cards done; T3 (the `targetState` hook) done; V1 (host) done; no agent has `chat/**` or `contracts/chat.ts` open. **Depends**: MU2.

### MU4. Workspaces and targets — size L — in the window

- **Builds**: workspace ownership and the rules around it: authorization §11, §16; identity FR6 (claiming).
- **Files (edits)**: `apps/server/src/workspaces/{manager,view,local,runtime}.ts` (owner on pending creates; the host-level flag), the workspace routes of `app.ts`, the targets listing (+ Connect's registry once landed: resolver `target`), `index.ts`; `authz/workspaces.ts` (resolver `workspace`, `unclaimed` listing, `claim`).
- **Does**: `POST /api/workspaces` writes the `workspace_owners` row (creator or a team) before the runtime create; `forgetWorkspace` also deletes it; the list and `/usage` are `visible`; start/stop/delete/adopt declared; `local` and `docker-host` workspaces are admin-only; the setup step claims what the runtimes list; version-pin upgrade and rollback need `manage`.
- **Tests**: X1 to X3 and X16 for workspaces and targets; claim; unclaimed; a pending create resumes with its owner.
- **Quiescence**: Connect T1, T3 and T5 done (they edit `manager`, `runtime`, `docker`, `kubernetes`, `local`, the workspace dialogs); G2 done; V1 done. **Depends**: MU2.

### MU5. Pools, accounts, secrets, library, settings, personas — size XL — in the window

- **Files (edits)**: `pools/**`, `accounts/**`, `secrets/**`, `mcp/**` (catalog, builtin, oauth), `skills/**`, `personas/**`, `settings/**`, `delivery/**` (actor on events), their routes in `app.ts`, `contracts/{pools,accounts,secrets,mcp,skills,personas,settings}.ts` (additive `Access` fields). Migrations **431** (`owner_kind`, `owner_id` on `pools`, `accounts`, `endpoints`; `owner_kind` default `platform` on `mcp_catalog` and `skill_sources`; per-user snooze tables are MU6's).
- **Does**: resolvers `pool` (with `poolType`), `account`, `endpoint`, `account_pool`, `mcp_entry`, `skill_source`, `skill_version`, `proposal`; create routes own by the creator (or a team, phase 3); lists filtered; **assignment needs `operate` on the set and `manage` on the workspace** and, for a credential assigned to a workspace others operate, the exposure consent hook that Sharing uses; library approval, revocation and built-in Add/Update are `platform(library)`; settings PUT is `platform(settings)` with the person as the audit actor; avatar and proposal decisions by the set's owner; the secret rotate/revoke routes need `manage`.
- **Tests**: X1 to X7, X15 for sets, accounts, library entries, proposals; a secrets set assigned by someone without `operate` is refused; an API key never leaves the server for a viewer.
- **Quiescence**: B1 to B4 done (they are); A3a and A3c done; P4's implementers for templates/approval rules not editing pools; D1 not editing settings in the same hour. **Depends**: MU2.

### MU6. Work objects — size XL (three sub-packages, parallel) — in the window

- **MU6a tickets and knowledge**: `tickets/**`, `knowledge/**`, their routes, migrations **432** (`tickets.owner_kind/owner_id`) and **433** (`kg_vaults.owner_kind/owner_id`). The `Caller` union becomes `Actor`; `#visible` becomes `visible`; assignee is a user id that must be able to view (`ASSIGNEE_CANNOT_VIEW`); tags, the graph, search, export and the recent/deleted views filter by vault visibility; agent tools keep the vault's own agent policy on top of the owner's rights. Quiescence: A3b (tickets), A4b (knowledge) done; the evidence track's ticket/knowledge links done.
- **MU6b CI, repos, browser**: `ci/**`, `repos/**`, `browser/**`; migration **435**; resolvers `repo`, `ci_repo`, `ci_run` (children of the workspace), `browser`; the browser lease binds (user, device); `actor` columns written as `actorString`. Quiescence: A5, A4, G1, G2 done.
- **MU6c usage and glance**: `claudeusage/**`, `usagespend/**`, `glance/**`; migration **436** (per-user snooze preference tables); `Visibility = canUser`, `canUseClaude`, `allow` of `recommend`, `creatorOf` returns `string | null`, budgets get resolver `budget`; the glance routes take `actorOf(c)`. Quiescence: U1a, U1b, U2, U3, U4 done.
- **Tests (each)**: X1 to X7, X9, X17 for its types; lists, counts, searches, graph edges, exports and tags only of what the person may view.
- **Depends**: MU2.

### MU7. Portal MCP — size L — in the window

- **Files (edits)**: `portalmcp/**`, the tool files of every module (declarations only, one `declareToolPolicies` per module file), `contracts/portalmcp.ts` (additive). Migration **434** (`pmcp_tokens.owner_id/token_epoch`, `pmcp_agent_tokens.token_epoch`, `pmcp_audit.actor_user`).
- **Does**: `PortalPrincipal` gains the user; `verify` checks the owner is active and the epoch matches (a dead owner is 401); the tool wrapper builds the `Actor` (`actorOfPrincipal` real) and checks the declared object arguments before the handler; handlers get `ctx.can`/`ctx.visible`; **the registry refuses to start with an undeclared tool**; an agent's user is its session's owner read at each call; `lockdown`/`mcp_lockdown` revokes the caller's own tokens, and everyone's only for `platform(emergency)`; token creation needs a password check; the token list, `audit_search` and `/api/portal-mcp/audit` return the person's own rows (admins all); the agent opt-in per workspace is `manage`.
- **Tests**: X11 in full (scope caps, a token after its owner is disabled, an agent reaching a sibling session, the workspace, `platform`), every one of the 87 tools with another user's object ids (refused or filtered), the enumeration test for tools.
- **Quiescence**: A3b done; no agent adds a tool during the window (new tools declare through the seam). **Depends**: MU2, MU3 (session owner for agents).

### MU8. Sockets and live — size M — in the window

- **Files (edits)**: `live.ts`, `sockets.ts`, `workspaces/shell.ts`, `browser/socket.ts`, `index.ts` wiring; `contracts/live.ts` (additive).
- **Does**: the live hub keeps the full snapshot once and builds each client's view by `visible` (cached by the visible-set key; republished when `onAccessChange` fires); `usage` the same; nudge topics unchanged (R2); every upgrade handler takes `actorOfSocket` and checks its declared access (`shell`: `operate` on the workspace and ownership of the terminal; `browser view/preview`: `operate`; `live`: signed in); `SocketGuard` tracks (user, login session, workspace) and cuts on sign-out, disable and `onAccessChange`.
- **Tests**: X8, X9, X10 with real sockets; the cut is observed within 1 s.
- **Quiescence**: G1, G2, U3, U4 done (`live.ts` topics), N1 done if it adds `LivePresence`, T1/T3 done. **Depends**: MU2, MU3.

### MU10. Web retrofit — size M — in the window

- **Files (edits)**: `features/glance/user.ts`, `lib/usage/palette.ts` (`OWNER_ID` becomes `useMe().user.id`), list pages (level chip, disabled actions from `ForbiddenDetails`, one "shared" mark), `features/admin/AccessPage.tsx` final shape, per-feature 404/403 handling. **Tests**: the existing web tests; screenshots at 390 and 1280. **Quiescence**: the feature owners done. **Depends**: MU9, the `Access` fragments of MU3 to MU6.

### MU11. The cross-user abuse suite — size L — harness with MU2, complete after MU3 to MU8

- **Builds**: authorization §12 as code: `apps/server/src/qa/crossuser/**` (the harness with the real app and real services, the accounts `alice bob carol dave root anon`, a fixture factory per object type, the **generated probes** from `RoutePolicies` and `ToolPolicies`, the **hand-written oracle** rows X1 to X20, socket and live probes, token/agent/job probes), `tools/qa/lib.mjs` (`login(code, as)`), the recipe notes in `docs/qa/`, the migration of `qa/boot.test.ts` and its neighbours from the code login to the seed or the test kit.
- **Acceptance**: the suite is green in `shadow` and `enforce`; every object type has a fixture; a deliberately removed declaration or resolver makes it fail (a mutation check, run once and recorded).
- **Depends**: MU2 (harness), then each package's rows as it lands.

### MU12. Flip and cleanup — size M — after the matrix is green

- **Does**: `PORTAL_IDENTITY` default `accounts`, `PORTAL_AUTHZ` default `enforce`; remove the code login (`Portal.signIn`, `AdminState`, `POST /api/admin/code`, the Access code card, `CustomCodeDialog`, `ServerCodeInput`), keep the dev seed; migration **450** drops `web_sessions`; README, `.env.example`, PLAN.md section 5 (`PORTAL_DEV_SEED=1`) and the deploy notes (the deploy files are not ours: list the edits for the owner); every test and script that used the code runs through the seed or the kit.
- **Quiescence**: a window; no scratch portal of another agent running with the old door (they restart with the flag).

## 3. Phase 2: sharing one workspace

### MU13. Shares (server) — size L

- `apps/server/src/sharing/**` (new): preview with the consent hash, create, accept, decline, narrow, end, leave, the access list, transfer, limits, the candidate providers (`registerShareCandidates(type, provider)`; small adapters in `workspaces/`, `pools/`, `tickets/`, `knowledge/`, `chat/` return their candidates and levels), credential removal through the pools service's safe unassign, audit. Migration **411** (`shares`). Routes from `SHARING_API`.
- **Tests**: Sharing §12 H1 to H4, H6, H7, H11, H13, H14; the consent hash property test.
- **Quiescence**: phase 1 enforcing. **Depends**: MU12.

### MU14. Revocation effects and the sweep — size L

- `emitAccessChange` consumers wired: chat socket, shell, browser, live; `endUserSessionsIn`; agent tokens; the assignment validity sweep in `pools/` (the safe unassign per invalid assignment, audit, tell the owner); jobs paused (`owner_denied`); notifications routing; `forgetObject` on delete.
- **Tests**: H5, H8, H9 (after teams), H12; X10 end to end.
- **Depends**: MU13.

### MU15. Sharing UI — size M

- `apps/web/src/features/sharing/**` (new): the Share sheet (three steps on one screen), Access on each object's sheet, Shared with me, acceptance, the badge; surgical entries in the ⋯ menus of workspace, session, ticket, set, vault, account. Screenshots at 390 and 1280. **Depends**: MU13.

### MU16. Sharing matrix — size M

- H1 to H14 in the suite; browser verification of the consent flow with real credentials-free fixtures. **Depends**: MU13, MU14.

## 4. Phase 3: teams

### MU17. Teams (server) — size L

- `apps/server/src/teams/**`: tables and triggers (migration **420**), create, invite, accept, decline, revoke, remove, role, leave, delete, limits, audit, `ownersOf`/`usersWith` for teams, the level query's team terms (already in MU2), the invitation job. **Tests**: Teams §12 M1 to M5, M8, M9, and the concurrency test for M4 (two connections). **Depends**: MU12.

### MU18. Team-owned objects, shares to teams, member scope — size M

- `ownerTeamId` on the create requests of workspace, ticket, set, account, endpoint, vault, template (a surgical edit per module); shares to a team (active at once); `memberScope` for workspace and team; the revocation effects on leaving (MU14). **Tests**: M6, M7, M10, M11, H9. **Depends**: MU17, MU14.

### MU19. Teams UI — size M

- `features/teams/**`, the nav item (`app/nav.ts`, one line), the Invitations section and badge, the "Owner" rows in the create dialogs (surgical). **Depends**: MU17.

### MU20. Teams matrix — size S

- M1 to M11 in the suite; screenshots. **Depends**: MU17, MU18.

## 5. The usage follow-on (PLAN-12) as an interface list

The preconditions of `COORD/PLAN-12.md` are met by: MU3 (session `created_by_user`, `root_id`, `chat_usage.user_id`, `chat_requests.decided_by_user/decided_via`, Bypass and approval actors as `user:<id>`), MU6c (`creatorOf` returns `string | null`, `Visibility = canUser`), MU2 (`memberScope`, `multi_user_since` written by migration 430, read through `authz`), MU17/MU18 (team rollups). Checklist U5 can verify before it starts: (1) `SELECT count(*) FROM chat_sessions WHERE created_by_user IS NOT NULL` grows for new sessions only; (2) a child's `root_id` is its root's id and its `created_by_user` its root's; (3) a Move keeps the owner; (4) `chat_usage.user_id` is NULL exactly for sessions with a NULL creator; (5) an approval decided by a sharee carries the sharee's id; (6) `memberScope` answers per scope as in multi-user §13 item 5. U5's own needs: the palette kind `user` (a table rebuild or `usage_palette_user`, U5's block 480-499), `usage_sessions` snapshot columns, `chat_usage.mode` if it counts turns under Bypass.

## 6. Quiescence conditions at a glance (the coordinator's checklist for the window)

| Package | Tracks that must have reported done | Files that must be free |
| --- | --- | --- |
| MU1, MU2 | none | the five hot files only for the surgical lines |
| MU9 | MU1 routes live | `AccessPage.tsx`, `AccountMenu.tsx`, `App.tsx` at edit time |
| MU3 | A2, A2b, A7, S1, S2, N4, D1, D2, evidence cards, T3, V1 | `chat/**`, `contracts/chat.ts` |
| MU4 | Connect T1, T3, T5, G2, V1 | `workspaces/**`, the workspace dialogs |
| MU5 | B1 to B4, A3a, A3c, P4's pool-touching implementers, D1's settings | `pools/**`, `accounts/**`, `secrets/**`, `mcp/**`, `skills/**`, `personas/**`, `settings/**` |
| MU6a | A3b, A4b, evidence links | `tickets/**`, `knowledge/**` |
| MU6b | A5, A4, G1, G2 | `ci/**`, `repos/**`, `browser/**` |
| MU6c | U1a, U1b, U2, U3, U4 | `claudeusage/**`, `usagespend/**`, `glance/**` |
| MU7 | A3b | `portalmcp/**` and the tool files |
| MU8 | G1, G2, U3, U4, N1, T1, T3 | `live.ts`, `sockets.ts`, the socket files |
| MU10 | the web feature owners | the feature folders touched |
| MU12 | MU11 green | the whole tree, announced |

Window checklist: (1) the status files of the listed tracks say done and `git status` shows no modification of the package's files by a running agent; (2) `npm run typecheck` is clean and the full server suite is recorded as the baseline; (3) the coordinator announces the window in the outboxes; (4) agents restart scratch portals with the new flags afterwards.

## 7. Sizes and effort

S about half a session, M one, L two, XL three to four (a session = one agent working to its limits). Phase 1 total: MU1 L, MU2 L, MU9 L, MU3 XL, MU4 L, MU5 XL, MU6 XL (3 x L), MU7 L, MU8 M, MU10 M, MU11 L, MU12 M = about 26 sessions, 8 in parallel at most; phase 2 about 7; phase 3 about 6. Model and effort follow DELEGATION.md: the security-sensitive packages (MU1, MU2, MU3, MU5, MU7, MU8, MU11, MU13, MU14, MU17) are Tier S/A (the strongest model, high effort); web and docs packages (MU9, MU10, MU15, MU19) and the matrix runs (MU16, MU20) are Tier B.

## 8. Owner decisions that gate or shape packages

MO1 (password minimum) and MO2 (setup token in the log) shape MU1; MO4 (admin privacy), MO5 (library approval) and MO8 (host-level targets) shape MU2, MU4 and MU5; MO6 and MO7 shape MU13; MO10 shapes MU17 and MU18; MO13 shapes MU1's environment check and the deploy notes. The packages proceed on the recommended defaults in `docs/prd/multi-user.md` §16 until the owner answers.
