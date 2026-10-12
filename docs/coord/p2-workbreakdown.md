# P2 work breakdown: platform track, phase 1 and item 6 (2026-10-12)

Read first: `docs/prd/platform-roadmap.md` (phases, decisions O1-O12, checklist), `docs/prd/web-app-pwa.md` section 11 (notifications), `docs/prd/triggers.md`, `docs/prd/auto-transfer.md`, `COORD/p2-audit.md` (evidence), the contracts `packages/contracts/src/{notify,triggers,autotransfer}.ts` (landed, typecheck clean). Rules that apply to every package: PLAN.md sections 4-7, PLAN-2 section A (git read-only; the owner's dev portal and `.data` are off limits; no real credentials; DinD only, never `--context host`; economy; /tmp hygiene), PLAN-5 R2-R6, the UI text diet (PLAN.md rule 12), and the multi-user rules of section 3 below (PLAN-10 reverses PLAN-5's "one user").

## 0. Standing rules for EVERY package (copy into your status file)

1. **KUBERNETES SAFETY (coordinator, 2026-10-12).** This sandbox's `KUBECONFIG` points at the owner's REAL cluster `home-isnan-cluster` and the portal enables its Kubernetes target whenever `KUBECONFIG` is set. Every scratch portal starts with `unset KUBECONFIG KUBERNETES_SERVICE_HOST` and `PORTAL_K8S_ENABLED=false` (PLAN.md section 5 has both); every test or `tsx` command runs as `env -u KUBECONFIG -u KUBERNETES_SERVICE_HOST PORTAL_K8S_ENABLED=false ...`; never run `kubectl` or `helm` without `--kubeconfig <your own throwaway file>`; never create a Kubernetes workspace from a scratch portal. The phase 2 backup and egress packages touch runtimes: their Kubernetes tests run only against a throwaway k3s-in-Docker with its own kubeconfig file.
2. **No third party is contacted.** No real push service (FCM, Mozilla, Apple), no real Discord, Slack or Git host, no real accounts. Stand-ins only (a local script that holds the subscription's private key and decrypts; a local HTTP receiver). The outbound guard takes an injected `allowPrivate` for tests only and is impossible to enable from a request.
3. **Ports and names.** Own prefix, tmux session, containers and `/tmp/<prefix>*` files; scratch portal and CDP ports from the table in section 2; stop your portal and Chromium when idle; one portal, one Chromium, at most one workspace container at a time.
4. **Migrations only in your block** (section 2), append-only, never edit another block; every column that holds a sealed value goes in `ENCRYPTED_COLUMNS`; delete your scratch data dir to re-run.
5. **Shared files are edited surgically** (re-read immediately before editing, never reformat, a change of a few lines, listed in your report). The hot files are `apps/server/src/index.ts`, `app.ts`, `live.ts`, `chat/controller.ts`, `apps/web/src/app/{App.tsx,nav.ts}`, `SessionPage.tsx`, `SettingsPage.tsx`: if `git diff` shows another agent's uncommitted lines in the region you need, wait a minute and retry; never fix what you do not own. **Nothing in this track edits `chat/controller.ts`.**
6. **Tests and honesty.** Server tests with `node --import tsx --disable-warning=ExperimentalWarning --test '<glob>'` from `apps/server` (web tests are `node --test` over pure TypeScript: there is no React test runner), the full suite once at the end, typecheck from the root, `npm run build -w @portal/web`. Expected values in tests are worked out by hand and written in the test. Never claim a pass you did not observe; real devices are the roadmap checklist (section 9 there), not your result.
7. **UI:** titles of one or two words, explanations in `InfoTip`, no card in a card, 390 and 1280 px, light and dark, keyboard and touch; look at the screenshots before reporting.
8. **PRD status notes** in the same change: the milestone tables of the PRDs you built say Built, Partly built or Not built with what you observed.
9. **Status file** (`COORD/status-<id>.md`, at most 40 lines, with RESUME HERE) at every milestone; outbox lines for requests; on a 429 or usage-limit error write RESUME HERE and stop, no retry loops.

## 1. The shape of the code (so that four agents do not collide)

```
apps/server/src/platform/        N1 owns the skeleton; N3 and N4 add ONE registration line each inside registry
  index.ts   createPlatform(deps): Platform       the only wiring index.ts and app.ts see
  owner.ts   PlatformOwner adapter                actorOf(c), ownersOf(subject), can(...), userEnabled(...): the single owner today
  audit.ts   PlatformAudit                        record(entry), list(filter, actor); table platform_audit
  routes.ts  GET /api/platform/audit
apps/server/src/notify/          N1                bus, adapters, pipeline, destinations, Web Push sender, channels, answers
apps/server/src/triggers/        N3
apps/server/src/autotransfer/    N4
apps/web/src/features/{notify,triggers,autotransfer}/    N2, N3, N4
```

```ts
// platform/index.ts (N1 lands it first, announces it in outbox-n1.md)
export interface Platform {
  bus: NotifyBus;                          // emit/on: the one event bus
  audit: PlatformAudit;
  owner: PlatformOwner;
  hooks: Hono;                             // mounted at /hooks, outside /api and the session guard; N3 registers its receiver here
  register(m: PlatformModule): void;       // { name, routes?: {path, app}[], start?(), stop?() }
  start(): void; stop(): void;
}
export interface NotifyBus {
  emit(e: Omit<NotifyEvent, 'id' | 'at'> & { at?: string }): NotifyEvent | null;  // validates (facts: short strings, numbers, booleans; detail clipped), assigns id and time, fans out, never throws; null when dropped
  on(kind: NotifyKind | '*', fn: (e: NotifyEvent) => void): () => void;           // a listener that throws is logged and skipped
}
export interface PlatformOwner {
  actorOf(c: Context): { userId: string; admin: boolean };      // today { userId: 'u_owner', admin: true }
  ownersOf(subject: NotifySubject): string[];                    // today ['u_owner']
  can(userId: string, verb: 'view' | 'operate' | 'manage', subject: NotifySubject): boolean;   // today true
  userEnabled(userId: string): boolean;                          // today true
}
```

When P5's `authz/seam.ts` (the Actor type, `can(actor, verb, object)`, `actorOf(c)`) lands, `platform/owner.ts` becomes a thin wrapper around it: that one file is the whole retrofit for this track. Until then it is the default above, and NOTHING else in the track contains the literal `u_owner` (the migrations' column defaults excepted).

**Live topics:** N1 adds three topics in ONE edit of `packages/contracts/src/live.ts` and `apps/server/src/live.ts` (`LiveTopic`, `LIVE_TOPICS`, `LiveMessage`, the `publish` else-if, and the `presence` message handled in `#join` with an `onPresence` hook): `notify`, `triggers`, `autotransfer` ("changed, load it again"). N3 and N4 then only call `live.publish(...)`.

**Extension points for other tracks** (announce in `outbox-n1.md`): `platform.bus.emit` (evidence annotations, version canary, maintenance results, the btw track); a new notification kind is one entry in `notify.ts` plus a template in `notify/templates.ts`; `platform.audit.record` for any module that wants a row in the shared audit; `GET /api/notify` (the onboarding checklist reads "this device has a push destination").

## 2. Allocation

| Package | Prefix | Portal | CDP | Migrations | Size | Wave |
| --- | --- | --- | --- | --- | --- | --- |
| N1 notify core (server) | `n1-` | 3232 | 9362 | 200-209 | L | 1 |
| N2 notify web | `n2-` | 3233 | 9363 | none | L | 1 (contract first) |
| N3 triggers (server, then web) | `n3-` | 3234 | 9364 | 210-219 | XL (may be split N3 server and N3W web) | 1 pure parts, 2 wiring and web |
| N4 auto transfer (server, then web) | `n4-` | 3235 | 9365 | 220-229 | L | 1 pure decision, 2 engine and web |
| N5 QA and abuse | `n5-` | 3236 | 9366 | none | M | 3 |
| spare | | 3237-3239 | 9367-9369 | | | |
| reserved, later (phase 2 and 3) | | | | 230-239 safety, 240-249 delivery, 250-259 scale | | |

## 3. Multi-user adoption rules (PLAN-10; apply to every package)

1. Every per-person table has `user_id TEXT NOT NULL DEFAULT 'u_owner'` (triggers: `owner_id`); the platform-wide tables are named in the PRDs (`notify_keys`, `platform_audit`'s nullable `user_id`, `trigger_deliveries`).
2. Routes get the user from `platform.owner.actorOf(c)`, never from the cookie; every list, count, history and export filters by that user (an admin may read all where the PRD says so).
3. Events route through `ownersOf(subject)` (or `event.audience`); `can(user, 'view', subject)` is checked again at delivery, and `can(user, 'operate', ...)` when an answer or an automatic act happens.
4. Admin acts (the master switches and caps, VAPID contact, the ceiling on answers, and in phase 2 the emergency stop, backups, maintenance, egress) check `actorOf(c).admin`.
5. Every suite has a **cross-user matrix with two fake users** (a second `PlatformOwner` implementation injected in tests): B cannot see, list, count, subscribe to, change, test, remove, answer or search A's objects through any route, socket message, token or job; an id of A answers B like an unknown id.
6. Single-owner behaviour is the acceptance baseline: nothing changes for the person who runs the portal today.

## 4. Hooks into other areas (the complete list; each is a few lines, after re-reading; report every one)

| # | File | Change | By | Condition |
| --- | --- | --- | --- | --- |
| H1 | `apps/server/src/index.ts` | import, `createPlatform({...})`, `platform.start()` after tickets, ci and claudeUsage exist; `platform.stop()` in the shutdown block; the dev router forwards `url.startsWith('/hooks/')` to the API like `/mcp` | N1 | Lands the skeleton first; re-read before editing (many agents edit this file) |
| H2 | `apps/server/src/app.ts` | `platform?: Platform` in the options type; before the `/api/*` catch-all: mount `/api/notify`, `/api/platform` behind `requireSession` (modules register theirs through the platform) and `app.route('/hooks', platform.hooks)` outside `/api` | N1 | with H1 |
| H3 | `packages/contracts/src/live.ts`, `apps/server/src/live.ts` | topics `notify`, `triggers`, `autotransfer`; the `presence` client message and `onPresence` hook in `LiveHub` | N1 | After U4 reports done (U4 edits the same spots for `glance`) |
| H4 | `apps/server/src/tickets/service.ts` | `onEvent?: (e: {ticketId, kind, actor, fromAgent, data}) => void`, called after the transaction commits (a microtask), in `create`, `update`, `close`, `claimNext`, `startSession`, `attachCheck`; no one edits `tickets/` now | N1 | none |
| H5 | `apps/server/src/tickets/service.ts` | `Caller` gains `{kind: 'trigger', triggerId, ownerId, label}`; `#writer` returns actor `trigger:<id>` (its text is untrusted); `startSession` accepts it | N3 | none (same file as H4: land H4 first or re-read) |
| H6 | `apps/server/src/chat/redact.ts` | the portal shape's prefixes gain `na`, `wh`, `ws`, `ns` (`cpna_`, `cpwh_`, `cpws_`, `cpns_`) in the shape and in the literal tails; two shapes for Discord and Slack webhook URLs | N1 | none |
| H7 | `apps/server/src/store/migrations.ts` | the migrations of the package's block and its `ENCRYPTED_COLUMNS` entries (`notify_destinations.config`, `notify_keys.value`, `triggers.secret`, `triggers.path_token`) | N1, N3, N4 | append only |
| H8 | `apps/server/src/portalmcp/tools/index.ts` | one line per package to register read-only tools (`notify_status`, `trigger_list`, `trigger_runs`, `autotransfer_status`) | N1, N3, N4 | none |
| H9 | `apps/server/src/config.ts` | `PORTAL_PUSH_CONTACT` (optional) | N1 | none |
| H10 | `apps/web/src/app/{nav.ts,App.tsx}` | Notifications (`Bell`, admin group, More sheet; route `/admin/notifications`), Triggers (`Zap`, work group, More sheet; routes `/admin/triggers`, `/admin/triggers/:id`) | N2, N3 | After U3, U4, B4, G2 report done (they edit nav and routes) |
| H11 | `apps/web/src/lib/live.tsx` | `sendPresence(...)` on the one socket; the three topics | N2 | After U3 and U4 |
| H12 | `apps/web/src/lib/auth.tsx` | sign-out first removes this browser's push registration (`DELETE /api/notify/destinations/:id`, then unsubscribe) | N2 | none |
| H13 | `apps/web/src/features/chat/SessionPage.tsx` and the ⋯ menu | "Notify when done" and "Auto move" items; the auto-move card above the composer (order above the composer: approval, auto move, side question) | N2, N4 | After U3 and the btw work (S2) report done with the composer area |
| H14 | `apps/web/src/features/chat/Transcript.tsx` | the auto mark and Undo on the "Moved to" divider (a hook `useAutoMoveMarks(sessionId)` and one prop) | N4 | with H13 |
| H15 | `apps/web/src/features/settings/SettingsPage.tsx` | import one `AutoMoveSettingsSection` (like `GlanceSettingsSection`) | N4 | After U3 |
| H16 | the Claudes list (workspace page or Usage > Claudes) | one ⋯ item "Auto move…" | N4 | After U2 and G2 report done |
| H17 | `apps/web/public/sw.js` | the push and click code | N2 | free: U3 was told not to edit it |

## 5. Packages

### N1: notify core (server). Size L, wave 1

**Goal.** The bus, the adapters over the existing seams, the pipeline, the destinations, the Web Push sender, the three channels, the answer tokens, the history and the audit, as designed in PWA PRD section 11.
**Files owned (new).** `apps/server/src/platform/**`; `apps/server/src/notify/{bus,templates,recipients,quiet,pipeline,destinations,history,log,vapid,webpush,push,egress,actions,routes,portalTools,settings,index}.ts`, `notify/adapters/{chat,ci,usage,spend,tickets}.ts`, `notify/channels/{webhook,discord,slack}.ts`, and the tests beside them. Edits: H1, H2, H3, H4, H6, H7, H8, H9.
**Provides.** `Platform` (section 1); the routes of `NOTIFY_API` and `GET /api/platform/audit`; the three live topics; `platform.owner` for N3 and N4; announcements in `outbox-n1.md`: (1) the contracts' final form, (2) "platform skeleton and bus answering" (N3 and N4 wait for this line), (3) the live topics, (4) the extension points.
**Consumes.** `ChatController.onEvent`, `get`, `openRequests`, `respond`; `CiService.hooks` (chain-wrap: keep any hook already set) and `onChange`; `ClaudeUsageMonitor.onAlert` (tolerate the new `kind`, `etaAt`, `projectedPct` fields; `near` goes to the history only); U1b's alert sink for `cost_spike` (waits for its announcement; the other adapters do not); the tickets hook H4; `Store.secrets` and `ENCRYPTED_COLUMNS`; `Settings` (`defineSetting`, `get`, `onChange`); `isPrivateAddress` and `embeddedIPv4` from `accounts/check.ts`; `Reauth.fresh` for the secret rotation; `PortalMcp` registry for read-only tools.
**Adapter rules.** A `request` event is announced 3 seconds later and only if still open (an auto-approval rule or the person may answer first); `session_done` only on a main-thread `result` (side-question calls are not turns); `session_failed` on an `error` event or an end that was not a person's; `ci_failed` on `status failed` with `previous` not failed; `human_request` on a ticket event `assigned` to a user by an actor that is not `ui`; all text through `templates.ts`; nothing from an agent, a workspace or a webhook in `facts`.
**Tests.** (1) Web Push: the RFC 8291 Appendix A known-answer test (the vector is in PWA PRD 11.4 and in `scratchpad/pn-spike/webpush-kat.mjs`), a decrypt round trip with a receiver written in the test, the 4,096-byte bound, the VAPID JWT (`aud` the push service origin, `exp` at most 12 h, `sub`), the topic header (at most 32 base64url characters). (2) Templates with a canary in every free-text source: it never appears in a payload, a history row, a log row or an audit row; `includeDetail` adds the clipped detail only where on. (3) Quiet hours by hand-computed cases: 22:00 to 07:00 in Asia/Jakarta at 23:30 and 06:59 local, at 07:00 exactly; a window across the clock changes of America/New_York 2026-03-08 and 2026-11-01 and Europe/London 2026-10-25; break-through kinds; the single summary. (4) Throttle, collapse, retries with a fake clock (now, 30 s, 5 min), `Retry-After`, the circuit breaker (3 failures `failing`, 20 `disabled`), 404 and 410 end a subscription, presence and the 60 s escalation. (5) Destinations: sealing proven by reading the database file (no endpoint, URL, key or secret in clear), Locked and Frozen send nothing and say so, validation limits. (6) The outbound client: private IPv4 and IPv6, mapped and NAT64 forms, metadata addresses, **IP literals in every spelling** (`127.0.0.1`, `2130706433`, `0x7f000001`, `[::1]`, `[::ffff:7f00:1]`, `169.254.169.254`: Node never calls `lookup` for a literal, so the guard has two parts, a literal pre-check after `new URL` and the connect-time `lookup`; see `scratchpad/pn-spike/guard-spike.mjs`), a name that resolves to a private address, a rebinding simulation (the first lookup public, the connect-time lookup private: refused), redirects refused, size and time limits. (7) Channels: the `X-Pilot-Signature` vector (secret `s3cret`, timestamp `1700000000`, body `{"v":1}`: `v1=bf81b0df9ab63212348caadf6ab8b1fc3d2c0c0cb838b2f767a6c1f11d1fa717`, computed here with openssl and node, identical), Discord's `allowed_mentions` and length, Slack's payload. (8) Answers: every row of the abuse table in PWA PRD 11.7, including path traversal, dotfiles, long and hostile commands, a token for another request, user or destination, replay, concurrency (exactly one wins), policy changed after the push, Locked, canary `cpna_` in logs. (9) Routes: session guard, Origin, size limits, a second fake user. (10) Retention sweeps.
**Acceptance (scratch portal 3232, stand-ins).** A fake browser (a P-256 key pair the test script holds) registers a subscription whose endpoint is a local stand-in; an approval produced by the existing chat test harness reaches the stand-in push service decrypted and is answered Deny with the token over `POST /api/notify/act` with the session cookie; the replay is refused; a stand-in webhook receiver verifies the signature; a private-address webhook is refused; the audit and the log show only codes. Paste the output in the report.
**May start.** Now. Step conditions: H3 after U4 is done; the `cost_spike` adapter after U1b announces its sink; H1 and H2 re-read first.

### N2: notify web. Size L, wave 1 (contract first)

**Goal.** The push worker, the subscription flow, the Notifications page, presence, toasts, and the session menu item, as designed in PWA PRD 11.3, 11.4, 11.6, 11.7.
**Files owned.** `apps/web/public/sw.js` (the push and click code added to the existing offline worker; one file, no build step; the pure functions are reachable in tests through a test hook on `self`), `apps/web/src/features/notify/**` (`NotificationsPage`, Inbox and Setup tabs, the destinations list, the events matrix, the quiet-hours editor, the channel dialog, the answer switches with the confirmation, `usePush`, `presence`, `api`), tests. Edits: H10 (Notifications), H11, H12, H13 (the "Notify when done" item).
**Worker behaviour.** `push`: parse, require `web_push` 8030 and a path matching `^/admin/`, always `showNotification` (title, body, tag, `renotify`, `data`), real `deny` and `allow` buttons only when `data.act` is present; `notificationclick`: body or `review` focuses an existing window or opens `data.path` (same origin, `/admin/` only, else `/admin/`); `deny` and `allow` call `POST /api/notify/act` with `credentials: 'same-origin'` and the token, close the notification, and on any refusal show "Couldn't answer · open" with the deep link; `pushsubscriptionchange` re-registers. The worker never handles `/api/*`, `/hooks/*` or sockets.
**Provides.** `notifyApi`, `useNotifyOverview` (the onboarding checklist reads it).
**Consumes.** `NOTIFY_API` (mock the server from the contract until N1's routes answer), the live socket (presence, topic `notify`), `ToastProvider`, `InfoTip`, `PageHeader`.
**Tests.** Worker functions under Node `vm` with a fake `self`: payload parsing and rejection (wrong magic, bad path, `//`, scheme tricks), always-show, tag and `renotify`, the click state machine, the act request shape (method, credentials, body, no token in the URL), every refusal mapped to one line, no token in any log or notification text; pure TypeScript for the matrix, quiet-hours editor and zone handling. **Browser (no real push service):** build the web (`npm run build -w @portal/web`), start a scratch portal with `NODE_ENV=production` (it serves `dist`; the worker registers in production builds only), then headless Chromium over CDP from a copy of `COORD/drive.mjs`: `INJECT` a stub for `PushManager.subscribe` that returns a fake subscription, grant the notification permission (`Browser.grantPermissions`), deliver a plaintext payload with `ServiceWorker.deliverPushMessage`, read `registration.getNotifications()`, drive the click through the test hook, and check against the portal that a same-origin worker `fetch` carries the `portal_session` cookie (P2's spike with a toy server already showed it in Chromium 154: `scratchpad/pn-spike/sw-cookie-spike.mjs`; repeat it for the real route). Screenshots at 390 and 1280 px, light and dark, keyboard path, text diet.
**Acceptance.** On the scratch portal: turn on notifications on this device (stubbed subscription), see it in the list, send a test, see the Inbox row and the toast, change the matrix and quiet hours and see them persist, add a channel (stand-in), see its last error code `blocked_address` after a test to a private address, sign out and see the registration removed.
**May start.** Now (contract first). Step conditions: H10 and H11 after U3, U4, B4 and G2 report done; H13 after U3 and S2 report done with the composer area; `sw.js` is free now.

### N3: triggers. Size XL, wave 1 (pure parts) and wave 2 (wiring, web)

**Goal.** Everything in `docs/prd/triggers.md`.
**Files owned.** `apps/server/src/triggers/**` (`cron`, `providers/{github,gitea,gitlab}`, `normalize`, `template`, `limits`, `runner`, `scheduler`, `receiver`, `store`, `service`, `routes`, `portalTools`, `settings`, `index`) and `apps/web/src/features/triggers/**` (`TriggersPage`, `TriggerPage`, the New dialog, the run list, `api`). Edits: H5, H7, H8, H10 (Triggers). The cron module is pure and exported for CI M3.
**Provides.** `TRIGGER_API`, the public receiver, the cron library.
**Consumes.** The platform skeleton and bus (`ci_failed` events, `platform.hooks`, `platform.audit`, `bus.emit` for `trigger_approval` and `trigger_failed`, `platform.owner`); `ChatController.create/send/control/interrupt/end/get/children`; `Tickets.create/startSession` with the new caller; `Settings`; `Store.secrets`; the redactor.
**Tests.** The abuse cases R1 to R22 (R22 is GitLab's provider-generated signing token: set by the owner with `PUT .../secret`, 401 until set) and the vectors, cron cases and fixtures in `docs/prd/triggers.md` sections 9, 10 and 16. The cron implementation must reproduce the table of section 10 line for line; the signature vectors (GitHub, Gitea, GitLab) are in section 9. End to end on scratch portal 3234 with the scripted stand-in Anthropic API (the existing helpers in `secrets/claude.integration.test.ts`): a signed delivery becomes a pending run, approving it starts a session in a worktree whose opening has the quoted block, a replay is a duplicate, a wrong signature is 401, a flood is bounded, a cost limit stops a run; cron on a fast-forwarded clock.
**Acceptance.** The scenarios E5 to E7 in section 6.
**May start.** Pure modules now (cron, providers, normalise, template, limits, store, their tests). Wiring (platform registration, the receiver mount, the runner, the CI source) after N1 announces "platform skeleton and bus answering". The tickets caller (H5) any time (after H4 is in, or re-read). The web page after the routes answer and after U3, U4, B4 and G2 report done (H10).

### N4: auto transfer. Size L, wave 1 (decision) and wave 2 (engine, web)

**Goal.** Everything in `docs/prd/auto-transfer.md`.
**Files owned.** `apps/server/src/autotransfer/**` (`decide` the pure decision, `engine`, `ports`, `store`, `routes`, `settings`, `portalTools`, `index`) and `apps/web/src/features/autotransfer/**` (`SuggestionCard`, `DividerMark`, `SessionMenuItem`, `AutoMoveSettingsSection`, `ClaudeConfigDialog`, `api`, `useAutoMoveMarks`). Edits: H7, H8, H13 (the card and the menu item), H14, H15, H16. **No edit in the server's chat code.**
**Ports** (the engine is written against these so it can be tested with fakes): `ChatPort` (`get`, `switchOptions`, `switchClaude`, `onEvent`, `children`, `list`), `UsagePort` (`report()` giving each Claude's windows, `pace` and `outlook`; `headroom(claudeId)`; U1a's pure `recommendMove(claudes, {workspaceId, from, nowMs, allow})`), `OwnerPort` (`platform.owner`), `ClockPort`.
**Tests.** S1 to S20 in `docs/prd/auto-transfer.md` section 14 as pure tests over fixtures with hand-computed percentages (92 % used is 8 % left, and so on); the engine with fakes (boundary handling, deferral to a card after 30 minutes, the pause after Undo, a manual move back is recorded as `undone`, a failed move pauses and a second failure stops automatic moves for the day); the web card, the divider mark and the Undo at 390 and 1280 px.
**Acceptance.** E8 in section 6, and one real `switchClaude` on a scratch Docker workspace with the stand-in API when memory allows (otherwise the W2 tests plus the fake: say which).
**May start.** The decision function now (it needs only the contracts and U1a's types). The engine after N1 announces the bus, and after U1a reports done (`report()` and `recommendMove` stable). The web half after U3 and S2 (composer area), U2 and G2 (Claudes list), and U3 (SettingsPage) report done.

### N5: QA and abuse. Size M, wave 3

**Goal.** Prove the track: run the cross-user matrix and every abuse table over the integrated tree, run the end-to-end scenarios, review the new surfaces for security and accessibility, and record findings.
**Files owned.** `apps/server/src/qa/platform/**` (an executable suite: the cross-user matrix with two fake users over every new route, the receiver abuse cases against a real scratch portal, the answer abuse table, SSRF cases, canaries across logs, responses, audit, history, notifications, transcripts), an addition to `docs/qa/qa-report.md` (findings with severity and owner), and the checklist rows in the roadmap marked "automated here" or "needs a device".
**Tests and acceptance.** Section 6 end to end; typecheck, full server suite, web build and the boot test (`apps/server/src/qa/boot.test.ts`) once; axe-style checks by script on the new pages at 390 and 1280 px; a text-diet audit; screenshots looked at.
**May start.** After N1 to N4 report done (and after the multi-user window is scheduled: the matrix is re-run with the real authorization layer by that track).

## 6. End-to-end scenarios (N5 runs; owners run the parts that need them)

| ID | Scenario | Checks |
| --- | --- | --- |
| E1 | A stand-in session asks to run `npm test`. A stand-in push service receives and decrypts the payload; the policy has only Deny; the test posts Deny with the token and the cookie | The session continues with a denial; `resolved` row; one audit row; a replay is 409; the token is absent from every log |
| E2 | The policy allows `read`; a `Read` request inside the folder arrives, then a hidden path, then `Bash` | Allow offered for the first only; the others carry Deny and Review; forced Allow for them is refused |
| E3 | Channels: a webhook with a signature, a Discord and a Slack stand-in, a private-address webhook, a redirecting one | Signatures verify; payload shapes match the PRD; the private and redirecting ones show `blocked_address` and `redirect` and nothing else |
| E4 | Quiet hours for the next 2 minutes; three events; wait | Held; one summary; break-through `cost_spike` delivered at once |
| E5 | Trigger webhook: a signed delivery, an unsigned one, a replay, a tampered body, a flood | Pending run, 401, duplicate, 401, bounded; approval starts a session with the quoted block; no notification or title carries payload text |
| E6 | Cron on a fast-forwarded clock including a clock change | The table in triggers.md section 10 |
| E7 | CI fails, a trigger starts a session that pushes a failing commit | One run; the second failure is `self_triggered`; cooldown and daily cap hold; a notification says so |
| E8 | Two Claudes on a workspace (stand-in logins); the first at 92 % used (8 % left) by a fixture; `ask` | A card; Move; one chat id across the move; the divider mark; the audit row; Undo through the normal dialog; 120 minute pause |
| E9 | Start the portal Locked | Nothing sent; `act` answers `locked`; the Notifications page says so |
| E10 | The cross-user matrix | Every row of the multi-user notes holds for two fake users |
| E11 | Sign out in the page | The browser's push registration is gone; no more pushes to it |

## 7. Waves and when each may start

| Wave | Package | May start | Which running agent must be done first |
| --- | --- | --- | --- |
| 1 | N1 | now | none for the core; H3 (live topics) after **U4**; the cost adapter after **U1b**'s sink is announced; owner adapter switches to **P5**'s seam when it lands |
| 1 | N2 | now, contract first | H10/H11 after **U3, U4, B4, G2**; H13 after **U3** and **S2** (btw) with the composer area; `sw.js` free now |
| 1 | N3 pure parts | now | none (new files; tickets edit H5 touches a file nobody edits) |
| 1 | N4 decision function | now | none |
| 2 | N3 wiring | N1 announces "skeleton and bus answering" | **N1** |
| 2 | N4 engine | N1 bus announced | **N1**, and **U1a** done (`report`, `recommendMove` stable) |
| 2 | N3 and N4 web | their routes answer | **U3, U4, B4, G2** (nav, routes), **S2** (composer), **U2** (Claudes list) |
| 3 | N5 | N1 to N4 done | **N1 to N4**; the multi-user retrofit window is separate (P5 decides) |

Order I recommend to spawn: N1 and N2 first (both can start now), then N3 and N4 as slots free (their pure parts can run in parallel with N1), then N5.

## 8. Phase 2 and 3 packages (outline only; detailed when asked)

| Package | What | Starts when | Size |
| --- | --- | --- | --- |
| S1 emergency | `POST /api/safety/emergency`, state kept across restarts, `portal emergency` CLI, banner and Resume; admin act, "Stop mine" for a user | N1, N3, N4 done | M |
| S2 DB restore test | Weekly restore test of the latest backup with integrity checks and migration dry run; notification | N1 done | S |
| S3 volume backups | Through `Runtime` (Docker, Kubernetes, Connect), encrypted, retention, restore into a new volume, restore test | **T3** done; the operations track's maintenance plan (one place, decision O12) | L |
| S4 egress | Internal network plus allowlist proxy per workspace, Bypass tie-in, per target | **T3** done; Browser pool decisions; S1 | XL |
| D1 levels | `epic` type and `parent_number` (table rebuild in the migration runner: verify first) | N3 done is not needed; tickets quiet | M |
| D2 PR/MR status | `ticket_link`, webhook action and an MCP tool, cards to the session | N3 done; B1 to B4 done | M |
| D3 CI M3 | merge requests with required checks, schedules (the N3 cron library) | N3 done; nobody editing `ci/` | L |
| P1 paging | session list and transcript windowing, archive, caps | U3, U4, S1, S2 done | L |
| P2 export | streamed transcript export | none | S |
| P3 search | FTS5 index, `GET /api/search`, palette front | P1 done | L |

## 9. Owner decisions (full text and what changes if you disagree: `docs/prd/platform-roadmap.md` section 11)

The packages are built on these defaults; none blocks a start.

| ID | Decision | Default taken |
| --- | --- | --- |
| O1 | Answers from a notification: Deny and Review always; Allow only per tool class, only when the whole request is shown, with the session and a single-use token; never `allow_session`, plans, questions, MCP tools, sub-agents or sessions started by a webhook or CI trigger; every Allow starts off | as stated |
| O2 | Auto transfer reverses Workspace Claudes' "no quota switch" and "no always switch"; opt-in, off by default | opt-in |
| O3 | Triggers reverse Tickets' "no automation"; webhook triggers wait for approval; master switch off | as stated |
| O4 | Push keys, endpoints and channel URLs sealed: a Locked portal sends nothing; the Locked alert is dropped | sealed |
| O5 | `/hooks/*` reachable from the Git hosts (an Access bypass for the path or a second hostname) | path bypass |
| O6 | Discord and Slack get links, not interactive buttons | links |
| O7 | Trigger limit defaults (1 parallel, 4 an hour, 12 a day, $2 a run, $10 a day, 45 minutes), all mandatory, all estimates | as stated |
| O8 | A `trigger` caller in the tickets service; actor `portal:trigger-<id>` | as stated |
| O9 | Auto transfer inside one workspace; Console-key destinations off; "same model" means the family is not blocked | as stated |
| O10 | Quiet hours off by default, one summary at the end | off |
| O11 | Multi-user routing: the session's creator hears of an approval; sharers only if they opted in | as stated |
| O12 | Cleanup and backups in the operations track's maintenance module; emergency stop and egress stay in the safety net | as stated |
