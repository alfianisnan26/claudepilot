# P2 audit: platform features (round 5), 2026-10-12

Method tags: **V** verified here by reading the code or running a command (file and symbol; line numbers move because other agents are editing: look the symbol up); **T** verified here by running something (the spike under scratchpad/pn-spike); **D** documented (source URL, fetched 2026-10-12); **U** unverified: needs a real device or account (listed in the manual checklist, platform-roadmap.md section 9). Status: **Exists** (works for what the ask needs), **Partly** (a seam or half exists), **Missing**.
The working tree is busy (git status shows edits by B1-B3, G1, P1, U1a, U1b, U3, U4 in app.ts, index.ts, live.ts, chat/controller.ts, chat/protocol.ts, App.tsx, SessionPage.tsx, SettingsPage.tsx, manifest.webmanifest); every sequencing rule below is written against that.

## 0. Result at a glance

| Item | Exists | Partly | Missing |
| --- | --- | --- | --- |
| 1 Notifications | in-app toasts framework; the seams that events come from | six events (data exists, nobody collects it); in-app history | Web Push (worker, keys, subscriptions, sender), webhook, Discord, Slack, per-event preferences, quiet hours, devices, answering from a notification |
| 2 Triggers | session and ticket creation APIs; CI hook | failed CI as a source; per-session budget and global caps | cron, webhook receivers, templates, per-trigger limits, approval rules, run history, trigger caller identity |
| 3 Delivery flow | ticket to worktree to session to CI to ticket check; statuses; local merge | ticket status connected to CI only; PR through the MCP catalogue (running track) | merge requests with required checks (CI M3), CI schedules, PR/MR state back on the ticket, Epic type and levels |
| 4 Safety net | token revoke, end sessions, Bypass switch, DB backups and offline restore | each piece separately | the emergency action, egress allowlist, volume backup, scheduled restore test |
| 5 Scale and comfort | knowledge search (FTS5), ticket search, client-side session filter | | paged transcript and session list, archive, size limits, global search, transcript export, real-device checklist |
| 6 Auto transfer | the Move flow with handoff and skip; headroom and the recommendation (U1a, landing) | recommendation routes (U1a ORDER step 4) | the policy engine, the card, undo, trail; and a PRD that now forbids it |

## 1. Item 1: notifications

| # | Ask | Status | Evidence | Contradiction or note |
| --- | --- | --- | --- | --- |
| 1.1 | Web Push in the PWA | **Missing** | V: `grep -rIi 'vapid\|pushManager\|showNotification\|push_subscriptions'` over apps and packages finds only `docs/prd/web-app-pwa.md` (and an unrelated pinned tool JSON). `apps/web/public/sw.js` is an offline page for navigations only. `apps/web/src/main.tsx` registers it only when `import.meta.env.PROD`: the dev server never has a worker. No `devices` table: `web_sessions` holds `token_hash, created_at, expires_at` (migration 5). The manifest gets `shortcuts` from U3 (in progress). | PWA PRD 10.3 designs a vite-plugin-pwa worker nobody built; this track keeps `public/sw.js` plain JS (no new build dependency). |
| 1.2 | Webhook channel | **Missing** | V: no outbound HTTP client for notifications exists. The only SSRF guards are admission-time: `assertPublicUrl` (mcp/spec.ts) and `assertReachableHost`/`isPrivateAddress` (accounts/check.ts), whose comments accept the DNS-rebinding window ("acceptable for an admin-only portal"). | Outbound channels need a CONNECT-time guard (resolve, check, pin) and no redirects (R3). Reuse `isPrivateAddress` and `embeddedIPv4`. |
| 1.3 | Discord channel | **Missing** | D: Execute Webhook takes `content` (2000 chars) and up to 10 `embeds`; `components` on a webhook that is not application-owned are ignored unless `with_components`, and then only non-interactive ones (docs.discord.com/developers/resources/webhook). | Buttons that call back need an Interactions endpoint (Ed25519 signature, PING/PONG) and a Discord application: rejected for v1 (PRD 11.5). Plain embed with a link. |
| 1.4 | Slack channel | **Missing** | D: incoming webhook = POST JSON `text`/`blocks`, answers 200 `ok`; "your webhook URL contains a secret"; the channel cannot be overridden (docs.slack.dev). Interactivity needs a Slack app and the signing secret (v0 HMAC over `v0:timestamp:body`, 5 minute window). | Link buttons only in v1. |
| 1.5a | Event: approval waiting | **Partly** | V: every approval is a stored `request` event: `ChatController.onEvent(cb)` delivers `{type:'events', items}` with `kind:'request'` and `request:{requestId, kind, toolName, title, detail, agentLabel}`; `ChatSession.waiting/waitingFor`. All current requests are `kind:'tool'` (protocol.ts `parseControlRequest` only maps `can_use_tool`); ExitPlanMode and AskUserQuestion arrive as tool requests. | No notifier. U4's glance aggregator counts them for the widget. |
| 1.5b | Event: human request | **Partly** | V: a human request is a ticket assigned to a person (`assignee_kind='user'`), "Needs you" (tickets PRD FR25). `Tickets.onChange` fires with no payload; `#addEvent` is private. | A one-line hook after commit (tickets/ is untouched by every running agent) or a diff on `onChange`. Hook preferred: precise (`created`, `assigned` with actor). |
| 1.5c | Event: session finished or failed | **Partly** | V: `result` events (turn end, duration, cost), `error` events, `ChatSession.state/endedReason` (`credential: `, `integrity: ` prefixes). No notion of "finished" for a session: define it (PRD 11.1). | |
| 1.5d | Event: CI failed | **Partly** | V: `CiService.hooks.changed(run, previous)` (interface `CiHooks`, one slot, unassigned in index.ts); `ci.onChange` for the live topic; CI already messages the owning session (`ChatSessionsAdapter.send`, actor `ci:<run>`). | The slot is single: the bus adapter owns it and triggers consume the bus (no second consumer of the slot). |
| 1.5e | Event: quota about to run out | **Partly** | V: `ClaudeUsageMonitor.onAlert(fn)` ("the seam where push notifications plug in later") emits one alert per window, level and period (`near` 80, `high` 95, `exhausted`); the page's AlertWatcher shows them in-app only. U1a is adding `kind:'projection'` alerts (contracts landed: `ClaudeUsageAlert.kind?`, `etaAt`, `projectedPct`). | Sink consumers must tolerate new fields. `near` is history-only; `high`, `exhausted` and `projection` push. |
| 1.5f | Event: cost spike | **Missing today** | V: no spike detection exists. U1b (running) builds spikes and budgets with "an onAlert-style sink" (outbox-u1b). | Ask requested (outbox-p2): `onAlert` on U1b's service. Depends on U1b. |
| 1.6 | Per-event preferences | **Missing** | V: no table or route (`notification_prefs` exists only in PWA PRD 12.4). | Model: per destination `kinds` set (the matrix is a view over it). |
| 1.7 | Quiet hours | **Missing** | V: designed in PWA PRD 11.2 (per device, IANA zone, break-through kinds, one summary). | Evaluate in the destination's zone with `Intl`, DST-safe; tests with hand-computed cases. |
| 1.8 | Action buttons: approve or deny | **Missing** and **contradicts the PRD** | V: PWA PRD 11.3: "with no action buttons: Safari has none, and a decision needs the whole request on screen (Chat FR22)". V: approvals are answered ONLY over the chat socket (`socket.ts` `case 'respond'` calls `controller.respond(session, requestId, decision, {note, actor:'ui'})`); there is no REST route. D/V: Declarative Web Push `actions` are navigations (each needs `navigate`; W3C Push API draft); `ServiceWorkerRegistration.showNotification` `actions` are supported in Chrome 48+, Edge 18+, Opera, Samsung (mirror), Firefox 152+, **not in Safari or iOS** (MDN browser-compat-data main, fetched 2026-10-12, T: parsed). V: the Portal MCP already answers approvals with admin scope plus a confirmation and a switch that is off by default (chat PRD FR25), the precedent for a non-UI answer. | RESOLVED in PWA PRD 11.7 (owner decision O1): Deny and Review always; Allow only per tool class the owner switched on, only when the whole request is in the notification; authenticated by session AND single-use bound token; never `allow_session`, plans, questions, MCP tools or sub-agents; never for sessions started by a webhook trigger. |
| 1.9 | In-app history and toasts | **Partly** | V: `ToastProvider` (`@isnanme/ui`) exists; no store. PWA PRD A6: notification history 30 days. | `notify_history` table; live topic `notify`. |
| 1.10 | Devices and presence | **Missing** | V: `LiveHub` handles only `subscribe` (`live.ts` `#join`); `maxPayload` 16 KiB. PWA PRD A5 adds `presence {visible, session}` to the live socket: not built. | Add `LivePresence` to the socket (a 12 line edit in live.ts by N1, after G1 and U4 are done with it). |
| 1.11 | Secrets: webhook URLs, push endpoint and keys, signing secrets | **Conflict** | V: PWA PRD 11.4 keeps the VAPID pair and subscriptions UNSEALED "so a Locked portal can still send its Portal alert". PLAN-5 R3 says sealed. V: `Store.secrets` is null while Locked; `ENCRYPTED_COLUMNS` (store/migrations.ts) is the registry of sealed columns (key rotation re-seals them). | RESOLVED (owner decision O4): everything sealed; while Locked or Frozen nothing is delivered; the Locked alert is dropped (watch `/healthz` from outside). |

## 2. Item 2: triggers and schedules

| # | Ask | Status | Evidence | Contradiction or note |
| --- | --- | --- | --- | --- |
| 2.1 | Cron | **Missing** | V: no scheduler for portal work. CI's `on.schedule` (local-git-ci FR16) is M3, not built; `CiTrigger` has `'schedule'` as a type only. | One cron library serves triggers now and CI M3 later. |
| 2.2 | Webhooks: push, PR, issue from Gitea, GitHub, GitLab | **Missing** | V: no inbound endpoint except `/mcp`. `/api/*` has `csrf()`, the Origin check and `requireSession` (app.ts); `app.all('/api/*')` is a 404 catch-all after the mounts. D: signature schemes: GitHub `X-Hub-Signature-256` (HMAC-SHA256 hex, `sha256=`); Gitea `X-Gitea-Signature` (bare hex) and `X-Hub-Signature-256`, EMPTY digests when no secret is set; GitLab signing token (19.0+: `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>` over `id.timestamp.body`, key = base64 of the secret after `whsec_`) or the older plain `X-Gitlab-Token`. T: HMAC vector computed with openssl and node (identical). D: payload names from GitHub docs, GitLab docs and Gitea `modules/structs/hook.go` (Gitea says `synchronized`, GitHub `synchronize`; GitLab MR `open/update/merge`, issue `open/close/reopen/update`, `object_kind` `push`, `tag_push`, `merge_request`, `issue`, `note`). | Public path `/hooks/<token>` outside `/api` (needs a one-line addition to the dev router in index.ts and, behind Cloudflare Access, a bypass for `/hooks/*`). |
| 2.3 | Failed CI as a source | **Partly** | V: `ci.hooks.changed(run, previous)`; `RunRow` has workspace, repo, pipeline, branch, sha, status, reason, ticket, session, actor. | Loop guard needed (a fix session pushes, CI fails again). |
| 2.4 | Start a session | **Exists** | V: `ChatController.create(req, {actor, parentId, bypassOptIn})`; actors must match `CHAT_ACTOR_PATTERN` (`portal:<...>` is allowed, so `portal:trigger-<id>`); `send(..., {actor, actorLabel})`. | Permission mode is not a create option: set afterwards with `control(id,'mode',{mode})`; Bypass can never be reached this way. |
| 2.5 | Start a ticket | **Partly** | V: `Tickets.create({kind:'system'}, ...)` works (source `system`). `Tickets.startSession` refuses anything but `ui` or an admin token ("Only a person starts a session for a ticket"). | Needs a `trigger` caller kind (surgical edit in tickets/service.ts: `Caller`, `#writer`, `startSession`). Tickets PRD non-goal "automation that acts on a ticket by itself" must be amended (owner decision O3). |
| 2.6 | Cost limit | **Partly** | V: `--max-budget-usd` is passed only for sessions on a pool's keys (`controller.ts` launch args `#viaPool`); a plan Claude "has its plan's limits instead". U1b budgets (running) are per Claude or workspace, alert-only by default. | Per-trigger limit is the module's own: Claude Code's reported `costUsd` per `result`, summed over the session tree, checked before start and after each turn; always an estimate. |
| 2.7 | Parallel limit | **Partly** | V: `sessions.maxLivePerWorkspace` (4) and `sessions.maxLiveTotal` (10) with sleep-to-make-room (`caps.ts`), agent caps. | Per-trigger and total-trigger caps are the module's own. |
| 2.8 | Approval rules | **Missing** | V: nothing. | Two layers: the RUN waits for a person (rule), and the session runs in `default` mode so its tool requests still wait (existing). |
| 2.9 | Run history | **Missing** | V: no table. | `trigger_runs`, 90 days, facts not payloads. |
| 2.10 | Untrusted payload text | **Missing** | V: tickets frame free text as untrusted (`openingMessage`, `{"untrusted_text": ...}` in MCP). | Same discipline for triggers (PRD triggers.md section 8). |

## 3. Item 3: delivery flow

| # | Ask | Status | Evidence | Note |
| --- | --- | --- | --- | --- |
| 3.1 | Ticket to worktree to session | **Exists** | V: `Tickets.startSession` passes `worktree` to `sessions.create`; `TicketDialogs.tsx` has "Own git worktree"; `chat/worktrees.ts`. | Tickets PRD status line still says "worktrees not yet": stale (drift). |
| 3.2 | CI, status on ticket and session | **Exists** (M1, M2) | V: runs link to tickets by session, `Ticket:` trailer or `ticket/T-n-` branch (`parseTicketBranch`); `ticket_checks`; CI messages the owning session on failure. | |
| 3.3 | Local merge requests | **Missing** | V: `CiService.merge(id, {source,target,strategy})` and `ci_merges` exist (a portal-performed merge); no merge-request object, no required checks (local-git-ci FR40, M3 "Not built"). | CI is quiet (no running agent). After N3 for shared cron. |
| 3.4 | CI schedules | **Missing** | V: FR16, M3. | Reuses N3's cron library. |
| 3.5 | Open a PR on GitHub, GitLab, Gitea through the MCP catalogue | **Partly** | V: B1 server built (templates, preview, Add, `mcp_builtin_list`); B2 found GitHub token-only, GitLab DCR, Gitea needs a pre-registered public client id (owner's call); B3 sign-in and B4 UI in progress. The portal does not open PRs; agents do, with the tools of the assigned set. | Depends on B1-B4 finishing and the owner's Gitea client id. |
| 3.6 | PR or MR state back on the ticket | **Missing** | V: nothing reads a forge's state. | Phase 2, on top of N3's receivers (webhook action `ticket_link`), not polling (polling needs forge credentials in the portal). |
| 3.7 | Ticket status | **Exists** | V: statuses `open, in_progress, blocked, in_review, done, wont_do`, settable (PATCH `status`, close, reopen). | |
| 3.8 | Ticket types and levels (Epic, Task, Bug) | **Partly** | V: types `task, bug, feature, question, request, incident, approval, chore`, settable; NO `epic`, and no parent/child column (migration 42). | Phase 2: add `epic` and `parent_number`; CHECK on `type` needs a table rebuild (SQLite), a migration in the delivery block. |

## 4. Item 4: safety net

| # | Ask | Status | Evidence | Note |
| --- | --- | --- | --- | --- |
| 4.1 | Emergency button | **Missing** (pieces exist) | V: `ChatController.end(id)`, `interrupt`, `endWorkspaceSessions(ws, reason)`; `AgentAccess.revokeAll(reason)`, `revokeWorkspace`, `setEnabled(ws,false)`; `PortalTokens.revokeAll(reason)`; setting `sessions.allowBypass` and `bypassPolicyChanged()` (ends sessions in Bypass). | Phase 2 package; needs N1's audit and notification. |
| 4.2 | Egress allowlist per workspace, above all Bypass | **Missing** | V: no code (only `NetworkMode: container:<netns>` for the browser companion). `bypassFacts` in index.ts hard-codes `internet: true`. Designed in browser-desktop-pool.md (Network row, A8) and settings FR19 (relaxing changes), not built. D: Docker has no native hostname egress filter; `DOCKER-USER` chain rules match post-DNAT container addresses; `--internal` networks have no external route (docs.docker.com). | Phase 2 outline: internal network plus allowlist proxy sidecar; per runtime target including Connect's remote ones (P1/T3). |
| 4.3 | Scheduled backup of the portal DB | **Partly** | V: `Store.backupIfDue()` (hourly check, one `daily` kept 7, `pre-migrate` 3), `portal backup` CLI, `restoreBackup` (portal stopped, needs the key). | No scheduled restore test. |
| 4.4 | Backup of workspace volumes | **Missing** | V: nothing. | Through `Runtime` (Docker volume archive, Kubernetes PVC, Connect tunnel): after T3. |
| 4.5 | Restore test | **Missing** | V: `store.test.ts` covers restore functions only. | Restore into a scratch copy, `PRAGMA integrity_check`, migration dry run, notify the result. |

## 5. Item 5: scale and comfort

| # | Ask | Status | Evidence | Note |
| --- | --- | --- | --- | --- |
| 5.1 | Transcript paging, archive, size limits | **Missing** | V: `GET /api/chat/sessions/:id/events?after=` has no `limit` or `before`; QA-017 measured 500 MB and 79,360 DOM nodes at 25,000 events (docs/qa/qa-report.md). | |
| 5.2 | Paged session list | **Missing** | V: `GET /api/chat/sessions` filters only by `parentId`; QA-018: 406 KB at 506 sessions, re-fetched every 3-5 s. | U3/U4 put widgets at the top of this list: coordinate. |
| 5.3 | Global search | **Partly** | V: knowledge has FTS5 per vault (`knowledge/indexdb.ts`); tickets use `LIKE` over summary, description, tags; sessions filter client-side (SessionsToolbar). T: `node:sqlite` here is SQLite 3.51.3 with FTS5 and the trigram tokenizer. U4's Ctrl/Cmd+K palette is client-side. | The palette becomes the front for a server search later. |
| 5.4 | Transcript export | **Missing** | V: usage export is U1a's; nothing for transcripts. | Redacted already at storage; stream from stored events. |
| 5.5 | Real-device checklist | **Missing** | V: qa-report "Not verified at all: real devices ... push notifications". | Skeleton in platform-roadmap.md section 9. |

## 6. Item 6: auto transfer

| # | Ask | Status | Evidence | Contradiction or note |
| --- | --- | --- | --- | --- |
| 6.1 | Move through the existing flow, at a turn boundary, handoff or skip | **Exists** | V: `switchClaude(id, destClaudeId, {handoff:'ask'|'skip'})`, `switchOptions(id)` (per destination `ok`, `reason`, and what is dropped); undo is a normal Move back. | **Destination must be on the same workspace** (`dest.workspaceId !== source.workspaceId` is refused). |
| 6.2 | Trigger by remaining quota or projection | **Partly** | V: `headroom(claudeId)` (`limiting.leftPct`, `exhausted`, `availableAt`, `blockedModels`); U1a contracts: `LimitOutlook`, `WindowPace`, `MoveRecommendation`; `claudeusage/recommend.ts` exports `recommendMove(claudes, {workspaceId, from, nowMs})` (pure); routes pending (ORDER step 4). | |
| 6.3 | Mode per session and global default; Ask card; undo; trail | **Missing** | V: nothing. | **workspace-claudes.md contradicts**: non-goal "A quota switch. Nothing watches a plan window ... and moves a session"; FR10 "Confirm is required every time. There is no 'always switch' setting"; section 4 non-goal "Rotating or pooling Claude plan logins" ("the portal never picks another"). Owner decision O2 (opt-in, off by default). |
| 6.4 | "Paid API-key pool" destination | **Reframed** | V: with an account pool all Claudes of a workspace share the pool's keys (`headroom.kind` `no_limits`): there is nothing to move between. A destination that "bills per use" is a Claude signed in with a Console key (`runsOn:'key'`). | Setting `automove.allowApiKey`, off. |
| 6.5 | Same model only | **Partly** | V: `ChatSession.model`; `Headroom.blockedModels` (labels of exhausted per-model windows). | Model availability per plan is not visible to the portal: rule is "family not blocked"; U for the rest. |
| 6.6 | Notification, audit, card | **Missing** | V: depends on N1's bus and audit. | |

## 7. Corrections to the seed (PLAN-5 section 1)

1. "The Move chat flow ... the usage track builds the destination recommendation": the flow only moves within a workspace; U1a's `MoveRecommendation` already takes `workspaceId` and `from` for that reason.
2. "MCP built-in catalogue gives agents GitHub, GitLab and Gitea tools, which is how an agent opens a PR": only when a set is assigned and credentials exist (GitHub token-only; Gitea needs the owner's public client id); the portal itself never opens a PR.
3. "human requests as open tickets": right, but there is no event for them (payload-less `onChange`).
4. "Approve or deny ... Safari has no action buttons": confirmed for notification `actions` (MDN BCD). The declarative form's actions are navigations, which is what makes the deep-link fallback free.
5. The seed missed: approvals are socket-only (no REST), all requests are `kind:'tool'`, `ci.hooks` has one slot, `LiveHub` has no presence, the session TTL is 12 hours, the SSRF guard has an acknowledged DNS-rebinding window, `defineSetting` has no enum type, `Caller` in tickets has no trigger identity, the PWA PRD keeps push keys unsealed against R3, workspace-claudes and tickets PRDs forbid what items 2 and 6 ask.

## 8. Conflicts with the running tracks, and the sequencing rule for each

| Track and file | What N-packages need | Rule |
| --- | --- | --- |
| U3: `public/manifest.webmanifest`, page-side Badging, `features/glance/**`, `SettingsPage.tsx` (imports `GlanceSettingsSection`), `App.tsx`, `AppShell.tsx` | the worker `public/sw.js`, push registration in the page, nav items `Alerts` and `Triggers`, a settings section | `sw.js` is N2's alone (U3 was told). N2 does not touch the manifest. `App.tsx`, `nav.ts` and `SettingsPage.tsx`: one-line edits AFTER re-reading, and after U3 reports done if a conflict shows. |
| U4: `server/glance/**`, live topic `glance`, widgets, palette | attention count for `app_badge`; the "approve right in the widget" path | N1 does not duplicate the aggregator: `app_badge` stays unset until `glance` exposes an in-process count. U4's widget answers approvals over the existing socket call, not through N1's tokens. |
| U1a: `claudeusage/**` | `onAlert` sink (exists), `recommendMove`, snapshot | Consume only; tolerate new alert fields. N4's engine calls `recommendMove` on the snapshot; no edits in `claudeusage/`. |
| U1b: `usagespend/**`, controller seams `onUsage`, `onLaunched`, `sendGate` | `onAlert` for spikes and budgets | Needs the ask in outbox-p2; N1's cost adapter waits for it (the other adapters do not). |
| B3: `chat/protocol.ts` and a controller hook (`mcp_servers`); B1/B2/B4: mcp/** | none | No overlap. The notification and trigger code never edits `chat/controller.ts`. |
| G1: `live.ts` topic `repos`, `chat/host.ts`, `repos/**` | a new live topic `notify` and a presence message in `live.ts` + contracts `live.ts` | N1 edits `live.ts` after re-reading, after G1 and U4 report done (three small spots). |
| P1/T1-T6: `workspaces/runtime.ts` and runtimes, `app.ts` mounts (`/connect/*`, `/install/*`), `connect.ts` | phase 2 only (egress, volume backup through `Runtime`) | Nothing in phase 1. Phase 2 egress and backup packages wait for T3. `/hooks/*` is a different prefix from `/connect/*`. |
| `index.ts` and `app.ts` (composition root; every track adds lines) | `createPlatform(deps)` and one mount | N1 lands the platform skeleton first (one block in index.ts, one mount in app.ts). N3 and N4 add one line each INSIDE `platform/`, never in index.ts or app.ts again. |

## 9. Documentation drift found (not blockers)

- tickets.md status line: "worktrees ... not yet": the server and the Start dialog have them.
- web-app-pwa.md A2 says foundation 4.1 notes unencrypted push keys: foundation-pools.md does not say so (the claim lives only in the PWA PRD, now replaced).
- local-git-ci.md section 9 lists `ci_merge_requests` for M3 while `ci_merges` (the portal-performed merge record) and `ci_messages` already exist in migrations 80 and 81.

## 10. Addendum: multi-user (PLAN-10, after this audit was written)

What the seams above lack for several users (V: code): `Portal` sessions are `{createdAt, expiresAt}` with no user (portal.ts), so a cookie names no one; `ChatSession` has `startedBy` (an actor string) but no owner column, so "the session's creator" is not stored; `Tickets` assignees are a label (`assignee_kind='user'`, `TICKET_DEFAULT_USER` `admin`); settings are global only (`SettingDef.scope: 'global'`); admin tokens (`cpat_`) belong to nobody; `Reauth` is per web session. The platform track therefore reads ownership through ONE adapter (`platform/owner.ts`: `actorOf`, `ownersOf`, `can`, `userEnabled`), writes `user_id TEXT NOT NULL DEFAULT 'u_owner'` on every per-person table from the start, and keeps platform-wide state (VAPID keys, the settings, the audit's table) explicit. U1a already added the matching seams on its side: `recommendMove(..., allow)` and `report({actorId})` (read in the tree, not yet committed). Per item see `docs/prd/platform-roadmap.md` section 10.
