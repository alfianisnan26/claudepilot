# PRD: Platform roadmap (notifications, triggers, delivery flow, safety net, scale, auto transfer)

| | |
| --- | --- |
| Status | **Draft v0.1** (2026-10-12). The plan for the owner's six platform items: what already exists, what is missing, the order, what depends on the tracks that are running, the owner's decisions, and the manual test list. Phase 1 and item 6 are designed in full in [Web app & PWA](web-app-pwa.md) §11, [Triggers](triggers.md) and [Auto transfer](auto-transfer.md) (contracts landed: `notify.ts`, `triggers.ts`, `autotransfer.ts`); phases 2 and 3 are outlines, to be detailed just in time. Nothing in phases 1 to 3 is built. ✅ = checked here on 2026-10-12, 📄 = documented (source linked), 🔬 = unverified: needs a device or an account. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | The tracks in flight (§5): the MCP catalogue, workspace git, Connect, usage and glance, evidence and annotations, the version pin, operations (scanner, approval rules, maintenance, templates, onboarding), side questions, and multi-user |
| Related | [Triggers](triggers.md), [Auto transfer](auto-transfer.md), [Web app & PWA](web-app-pwa.md), [Tickets](tickets.md), [Local git and CI/CD](local-git-ci.md), [Workspace Claudes](workspace-claudes.md), [Claude usage](claude-usage.md), [Settings & policies](settings-policies.md) |

## 1. Summary

The owner asked for six things: notifications (Web Push, a webhook, Discord, Slack; six events; preferences; quiet hours; approve and deny from the notification); triggers and schedules (cron, Git webhooks, failed CI; cost, parallel and approval limits; a history); a delivery flow (ticket to merge, with status on the ticket and the session); a safety net (an emergency button, an egress allowlist, backups with a restore test); scale and comfort (paging, archive, search, export, a device checklist); and auto transfer when a quota is low. They are built in three phases, with item 6 alongside phase 1. Almost every one extends something that exists; the audit (§4) says which. The first thing to build is the **event bus**: five of the six items need "something happened" and "tell the right person", and the bus is the seam none of them has.

## 2. Background

The portal today is one admin, one shared sign-in, workspaces as containers, chat sessions run by Claude Code, tickets, a local git remote and CI per workspace, pools of accounts, secrets, MCP sets, skills and personas, usage of the plan limits, and a PWA that is only an offline page. Tracks running now add: the built-in MCP catalogue, workspace git, Connect (clusters and single hosts enrolled from the web), usage insight and glance widgets, evidence and annotations, the Claude Code version pin, an operations set, side questions, and multi-user accounts (PLAN-10). This roadmap must not collide with them: where a seam exists it is used through an adapter in its own module, and where one does not it is added as a one-line hook after the owner of the file is done.

## 3. Principles

R1. **Extend, do not rebuild.** The live socket, the settings store, the Portal MCP registry, the ticket-started session path, the CI hooks, the Move flow, the audit and the redactor are reused.
R2. **No collisions.** A package edits only files nobody running owns; every hook into another area is a line listed in the package's report.
R3. **Security first.** No secret in a log, a response or a transcript; webhook URLs, push endpoints and keys and signing secrets are sealed at rest; every answer from a notification is authenticated; inbound webhooks verify signatures; outbound channels go through a guard that closes DNS rebinding; text from outside is untrusted input to an agent; abuse is tested, and a package is not done without it.
R4. **Numbers and claims are never invented.** Every figure has a source or says it is unavailable; every claim in these PRDs says how it was checked; real devices cannot be tested here, so §9 is a checklist, not a result.
R5. **Every automatic action has a limit checked before acting, an audit row, and a visible trail.**
R6. **Text diet, phone first**, the InfoTip for explanations, 390 and 1280 px, light and dark, keyboard and touch.
R7. **Multi-user is coming (PLAN-10).** Everything per person belongs to a user (`user_id TEXT NOT NULL DEFAULT 'u_owner'`), events route to the owner of what they are about, automatic acts run with their owner's rights, and acts on the whole platform (the emergency stop, backups, maintenance, egress policy) are an admin's. Today there is one user and nothing about the single-owner behaviour changes (§10).

## 4. Audit result

Evidence for every row is in `COORD/p2-audit.md` (file and symbol, how checked). **E** exists, **P** partly, **M** missing.

| Item | Ask | | What exists or is missing | Contradicts the new ask |
| --- | --- | --- | --- | --- |
| 1 | Web Push in the PWA | M | `sw.js` is an offline page registered in production only; no keys, subscriptions, sender or devices | [Web app & PWA](web-app-pwa.md) 10.3 designs a Workbox worker nobody built |
| 1 | Webhook, Discord, Slack | M | no outbound client; the only SSRF guards are admission-time | their DNS-rebinding window is accepted in the code; channels need a connect-time guard |
| 1 | Events: approval, human request, session done or failed, CI failed, quota, cost spike | P | each has a seam (`ChatController.onEvent`, a payload-less `Tickets.onChange`, `ci.hooks.changed`, `ClaudeUsage.onAlert`; spikes come with U1b); nobody collects them | |
| 1 | Preferences, quiet hours, history, devices | M | designed in the PWA PRD, no table or route | |
| 1 | Approve or deny from the notification | M | approvals are answered only over the chat socket; `controller.respond` is the seam | **The PWA PRD 11.3 says "no action buttons"**: resolved in §11.7 (decision O1) |
| 2 | Cron | M | none; CI's `on.schedule` is M3 | |
| 2 | Webhooks (Gitea, GitHub, GitLab) | M | no inbound route except `/mcp` | |
| 2 | Failed CI as a source | P | `ci.hooks.changed` | |
| 2 | Start a session or a ticket | E/P | `ChatController.create`, `Tickets.create`; `Tickets.startSession` is people-only | **Tickets' non-goal "automation that acts by itself"** (decision O3) |
| 2 | Cost limit, parallel limit, approval rules, history | P/M | per-session budget only for pool sessions; global caps; the rest missing | |
| 3 | Ticket to worktree to CI, status on ticket | E | `startSession` with a worktree; CI links by session, trailer, branch; `ticket_checks` | stale PRD status line |
| 3 | Local merge requests, CI schedules | M | a portal-performed `merge` exists; no merge-request object, no schedules (M3) | |
| 3 | PR or MR on GitHub, GitLab, Gitea | P | agents use the catalogue's tools; GitHub is token-only, Gitea needs the owner's client id; nothing reads the PR's state back | |
| 3 | Ticket status, levels (Epic, Task, Bug) | P | statuses exist and are settable; types lack `epic`; no parent | |
| 4 | Emergency button | M | pieces: end sessions, revoke tokens, the Bypass switch | |
| 4 | Egress allowlist | M | designed in the Browser PRD and Settings, not built; Docker default network | |
| 4 | Backups, restore test | P/M | the portal DB has daily, manual and pre-migrate backups and an offline restore; no volume backup, no restore test | |
| 5 | Paging, archive | M | QA-017 (500 MB at 25,000 events) and QA-018 (406 KB at 506 sessions) | |
| 5 | Global search, export | P/M | knowledge FTS5, ticket `LIKE`, a client-side session filter; no export | |
| 5 | Device checklist | M | the QA report lists devices as not verified | |
| 6 | Move through the existing flow | E | `switchClaude`, `switchOptions` | **a move stays in one workspace** |
| 6 | Quota trigger, recommendation | P | `headroom`, U1a's contracts and `recommendMove` (in progress) | |
| 6 | Modes, Ask card, undo, trail | M | none | **Workspace Claudes' non-goal "a quota switch" and FR10 "no always switch"** (decision O2) |

## 5. Phases, order and dependencies

| Phase | Items | Packages (work breakdown: `COORD/p2-workbreakdown.md`) | Starts when |
| --- | --- | --- | --- |
| 1 | 1 notifications | **N1** server (bus, adapters, destinations, pipeline, Web Push sender, channels, answer tokens, audit), **N2** web (worker, subscription, Notifications page, presence, toasts) | N1 and N2 can start now: they need the contracts only. N1's cost adapter waits for U1b's alert sink. |
| 1 | 2 triggers | **N3** (cron, receivers and providers, templates, limits, history, tickets caller; then the Triggers page) | The pure parts (cron, providers, templates, limits) can start now. Wiring waits for N1's bus and the `platform/` skeleton. The page waits for N3's routes and for the nav owners (U3, U4, B4, G2) to be done. |
| 1 | 6 auto transfer | **N4** (decision function and engine, tables, routes; then the card, the divider mark and the settings) | The engine needs U1a's `recommendMove` and `report()` (both exist in the tree) and the bus for notifications. The web half waits for U3 and the btw work (S2) to be done with the composer area. |
| 1 | tests | **N5** (the abuse suite, the manual checklist, the review) | After N1 to N4. |
| 2 | 4 safety net | emergency button; DB restore test; volume backups; egress allowlist | The emergency button after N1 (audit, notification) and N3, N4 (their pause switches); backups and egress after Connect's T3 (the `Runtime` interface) and the operations track's maintenance plan (one place for cleanup and backup logic). |
| 2 | 3 delivery flow | ticket levels and parent; PR/MR status on the ticket through webhooks; CI M3 (merge requests, schedules) | After N3 (receivers and the cron library); CI M3 when nothing running edits `ci/`. |
| 3 | 5 scale and comfort | paged lists, transcript windowing and archive, export, global search | After the tracks that edit the Sessions page and the chat store are done (U3, U4, the btw work); search last. |

Recommended order inside phases: **1** N1 with N2, then N3 and N4 in parallel, then N5. **2** the emergency button (small, high value), the DB restore test, ticket levels and the delivery view, CI M3, volume backups, the egress allowlist (the largest and riskiest). **3** paging (the two QA findings), export, search.

Concurrency: `COORD/ROSTER.md` lists thirteen agents running when this was written (its own cap is about eight with the memory the machine has); N1 and N2 are the first two to spawn when slots free, N3 and N4 next. Packages are sized so that none needs more than one agent at a time.

## 6. Phase 1 in short

| Item | What it is | Where it is designed |
| --- | --- | --- |
| Notifications | One in-process bus of events with facts and no free text; a pipeline (kind on, quiet hours, presence, collapse, throttle, retries); destinations: Web Push devices, a signed webhook, Discord, Slack; per-destination kinds and quiet hours; an in-app history; Deny and, per tool class, Allow from a notification with a single-use token and the session | [Web app & PWA](web-app-pwa.md) §11 |
| Triggers | Cron, Git webhooks and failed CI start a session or a ticket, within limits checked first, with approval rules, an owner and a run history; event text is untrusted and never reaches an instruction | [Triggers](triggers.md) |
| Auto transfer | A chat moves to another Claude of its workspace when a quota is low or projected to run out: off, ask or automatic; safeguards; a card, an audit row, a notification and an undo | [Auto transfer](auto-transfer.md) |

## 7. Phase 2 in outline

### 7.1 Safety net (item 4)

**Emergency button.** *Exists:* `ChatController.end` and `interrupt`, `endWorkspaceSessions`; `AgentAccess.revokeAll`, `revokeWorkspace`; `PortalTokens.revokeAll`; the setting `sessions.allowBypass` with `bypassPolicyChanged()` (✅ code). *Direction:* one `POST /api/safety/emergency` with a list of actions (stop all sessions, revoke agent tokens, optionally revoke admin tokens, lock Bypass, pause triggers, pause auto transfer, turn off answers from notifications), the server code checked again (`REAUTH_REQUIRED`), an itemised result, an audit row, an urgent notification that breaks quiet hours, and a state kept in the database that survives a restart ("Emergency stop active · Resume", resumed item by item, never automatically). A CLI `portal emergency` for when the page cannot be used. An admin's act; a user gets "Stop mine" (their own sessions and tokens) when accounts exist. *Dependencies:* N1 (audit, notification), N3 and N4 (their switches). *Risks:* a half-applied stop (report per item); locking the owner out of their own connector (admin-token revocation is off by default).

**Egress allowlist per workspace.** *Exists:* nothing built; the Browser PRD (Network row, A8) and Settings FR19 describe it; Docker workspaces use the default bridge and `bypassFacts` reports `internet: true` unconditionally (✅ code). *What Docker offers (📄, [Docker docs](https://docs.docker.com/engine/network/firewall-iptables/) and [network create](https://docs.docker.com/reference/cli/docker/network/create/)):* the `DOCKER-USER` chain runs before Docker's rules and matches post-DNAT container addresses; an `--internal` network has no default route and drops traffic to and from other networks; there is no native filter by host name. *Direction:* an internal network per workspace plus an allowlist forward proxy (a sidecar attached to both the internal and the default network) that admits CONNECT by host and port from a per-workspace list with presets (Anthropic, npm, PyPI, GitHub, GitLab, Docker Hub); the workspace gets the proxy in its environment and has no other route, so a program that ignores the proxy fails closed. Entering Bypass requires an active allowlist or an explicit acknowledgement that names "internet: open". *Limits, stated up front:* an allowlisted host can still be used to move data out (a gist, a package upload); non-HTTP traffic such as ssh needs explicit host and port rules; DNS inside an internal network may not resolve external names (🔬 verify in DinD); QUIC and UDP are blocked, which may break some tools; the default list needs upkeep. *Per target:* Docker as above; Kubernetes with a NetworkPolicy that admits only the proxy and DNS (FQDN rules need a CNI that supports them, 🔬 on the owner's cluster; k3s needs its policy controller on, Browser PRD Q12); Connect's remote targets apply the same policy through their agent, which needs a `network` capability in the protocol and a `Runtime` method. *Dependencies:* Connect T3 (the `Runtime` interface), the Browser pool's network decisions; relaxing the list is a relaxing change (re-auth, `UI_ONLY` over MCP). An admin's act. *Risk:* the largest and the one that can break the most; it ships last.

**Backups and a restore test.** *Exists:* `Store.backupIfDue` (an hourly check, one `daily` kept for 7 days, 3 `pre-migrate`), `portal backup`, `restoreBackup` (the portal stopped, the key needed) (✅ code). *Direction:* (1) a weekly **restore test** of the DB: copy the latest backup to a temporary directory, open it with the key, `PRAGMA integrity_check` and `foreign_key_check`, run the migrations on the copy, compare table counts to the backup's manifest, record the result and notify on failure; never touches the live database. (2) **Volume backups** through the `Runtime` interface (a Docker volume archived by a short-lived read-only container, a Kubernetes volume by a Job, a remote target through its tunnel), streamed, gzip, **encrypted** with a key derived from the portal's secret key (a home volume holds Claude logins and delivered secrets), with retention and a free-space check; opt-in per workspace; crash-consistent for a running workspace (stated). (3) Restore into a **new** volume, never in place; the restore test extracts the latest archive into a scratch volume, checks the manifest and a sample, deletes it, and notifies. *Dependencies:* T3 for remote targets; the operations track's maintenance plan, so that cleanup and backup logic live in one place (decision O12). An admin's act; the archives hold every user's data.

### 7.2 Delivery flow (item 3)

*Exists:* ticket to session to worktree, CI links by session, trailer and branch, `ticket_checks`, statuses (`in_review` included), a portal-performed merge (✅ code). *Missing:* levels, a merge-request object with required checks (CI M3 FR40), CI schedules (FR16), PR or MR state on the ticket. *Direction:* (1) **Levels:** add the type `epic` and a nullable `parent_number` (one level: an epic holds tasks, bugs, features; an epic has no parent; closing an epic with open children asks to confirm). SQLite cannot change a `CHECK`, so the type list needs a table rebuild inside the migration runner (🔬 verify that the runner's transaction allows the 12-step procedure with the tickets' foreign keys). (2) **PR/MR status on the ticket** through a `ticket_link` table (forge, url, number, state, checks summary) filled by a webhook trigger action (a pull request event whose branch names the ticket) and by a Portal MCP tool an agent calls after opening a PR (text untrusted, host checked); a PR event posts a card to the session like "From CI"; a merged PR suggests closing the ticket and never closes it. Webhooks, not polling: polling needs the forge's credentials in the portal. (3) **CI M3:** merge requests with required checks and "merge when green", schedules with the cron library N3 writes; the CI module's owner is no running agent, so it can start once N3 has landed. (4) A **delivery strip** per ticket: ticket, worktree, CI, PR/MR, review, merge, each stage from its real source. *Dependencies:* N3 (receivers, cron), B1 to B4 for agents opening PRs (GitHub token-only; Gitea needs the owner's client id), G1 for branch data. *Risks:* mis-linking by branch name (the `ticket/T-n-` convention and the `Ticket:` trailer exist), webhooks that cannot reach the portal, stale states.

## 8. Phase 3 in outline (item 5)

| Part | Exists | Direction | Dependencies and risks |
| --- | --- | --- | --- |
| Paged session list | `GET /api/chat/sessions` filters only by `parentId`; QA-018 | `limit` and a stable cursor on (last activity, id), `ETag`, a window in the page, group-by-Claude computed on the server, live changes over the chat socket | U3 and U4 put widgets at its top; U4's aggregator reads `controller.list` |
| Transcript windowing and archive | `GET …/events?after=` only; QA-017 | `before` and `limit` for a newest-first window, a virtualised transcript with "Show earlier", per-session size warnings and caps, older events compacted into archive segments the Move flow's `history()` can still read | The Move flow builds its context from stored events: the archive must keep the last window intact; the chat store is shared with S1 and U1b |
| Global search | Knowledge FTS5 per vault; ticket `LIKE`; a client-side session filter. ✅ `node:sqlite` here is SQLite 3.51.3 with FTS5 and the trigram tokenizer | A search index (FTS5) over message text (already redacted), ticket text, session titles and workspace names, federated with the vaults' own indexes; every result filtered by `can(view)` and owner; snippets escaped | Size (index message text only, cap each event), rebuild command; U4's palette becomes its front |
| Transcript export | None (usage export is U1a's) | A streamed Markdown or JSON export of one session from stored (redacted) events, attachments as links, a size cap with a marker, an audit row | Owner only (`can(view)`) |
| Device checklist | None | §9 | Needs people with devices |

Order: paging (the two measured findings), export (cheap), search (largest).

## 9. Manual test checklist (real devices; nothing here is a result)

Each row is run by a person on the named device and filled in: result (Pass, Fail, Not run), device and OS and browser version, date, tester, notes. This list is a skeleton: rows are added when a feature lands. "Multi-user" says what changes once accounts exist.

| ID | Device and browser | Steps | Expected | Multi-user |
| --- | --- | --- | --- | --- |
| D1 | iPhone or iPad, Safari, Home Screen app (iOS 16.4 or later) | Add to Home Screen, open from the icon, sign in | Standalone window, no Safari bar, signed in | The sign-in is the person's own |
| D2 | iOS Home Screen app | Notifications page, "Turn on" (the prompt must appear only after the tap), allow, "Send test" | State On; the test arrives within seconds (note the delay) | The device registers under the signed-in user |
| D3 | iOS, app closed, screen locked | An approval request in a session | A push arrives; tapping it opens the request in the app, not Safari; **no action buttons on the notification** | Only the session's owner's device gets it |
| D4 | iOS | Two pushes for one request (tag) | One notification, replaced in place | |
| D5 | iOS | Quiet hours for the next 2 minutes, fire events, wait | Held; one summary when the window ends | Per user and device |
| D6 | iOS | An attention count | The icon badge shows it (iOS 16.4+) 🔬 | The count is the user's own |
| D7 | iOS | Revoke the permission or delete the app, then push | The destination shows Off or removed after the push service's answer | |
| D8 | iOS 18.4 or later | App killed, push with the declarative shape | Shown without the worker; tap opens the path 🔬 | |
| D9 | iOS | A Focus mode on; a high-urgency push | Behaviour noted (delay, summary) 🔬 | |
| D10 | One phone, two people | A signs out; B signs in and turns notifications on; an event for A | A's device registration is gone; nothing for A appears on B's phone | **Multi-user only** |
| A1 | Android, Chrome, installed app | Install, sign in, Turn on, Send test | Arrives | As D2 |
| A2 | Android Chrome | An approval | Buttons **Deny** and **Review** (and **Allow** only for an enabled, eligible request) | Switches are the user's own |
| A3 | Android Chrome | Tap Deny; tap Allow on an eligible request; tap twice; wait 11 minutes then tap; switch the class off then tap | Denied; allowed once; the second tap says already answered; expired opens the app; refused opens the app | |
| A4 | Android | Lock screen with sensitive notifications hidden | Behaviour noted (what shows) | |
| A5 | Android, screen off 30 minutes | A high-urgency push | Arrives within a time noted 🔬 | |
| A6 | Android | Battery saver on | Behaviour noted | |
| P1 | Desktop Chrome, Edge, Firefox 152 or later | Permission from the button; a push with the tab closed; with the browser closed | Notes per browser; action buttons present | |
| P2 | Desktop Safari (macOS) | The same | No action buttons; the tap opens the path | |
| P3 | Desktop, any | Click the body while a window is open | The existing window is focused, no new window | |
| P4 | Desktop Chrome, Edge, Safari | The badge | The count shows | |
| C1 | Discord | A webhook channel; an event whose text contains `@everyone` | An embed with a link; nobody is pinged | A team channel is a later destination owner |
| C2 | Slack | A channel; an event | A message with a link | |
| C3 | A webhook receiver (a small script) | Verify `X-Pilot-Signature` | The signature checks; a tampered body fails | |
| T1 | The owner's Gitea | Add the webhook, "Test delivery" | A pending run appears | The trigger has an owner |
| T2 | GitHub, GitLab | The same with their test buttons | A run per accepted event; a `ping` is not a run | |
| S1 | VoiceOver, iOS Safari and the Home Screen app | Sign in; the Sessions list; open a session; the approval card (Allow is never focused); the Notifications page toggles; the Triggers dialog; the auto-move card | Names, states and changes are announced; focus is not stolen; toasts are announced politely | Another user's names never appear |
| S2 | TalkBack, Chrome | The same | The same | |
| S3 | NVDA with Firefox and Chrome (Windows) | The same, keyboard only | Every control reachable and named; Escape closes dialogs; focus visible | |
| S4 | VoiceOver, macOS Safari | The same | The same | |
| S5 | Any | 200 % zoom; reflow at 320 px; reduced motion; touch targets at least 44 px | No horizontal scroll; no motion that ignores the setting | |

## 10. Other tracks and multi-user

**Tracks that touch this one (PLAN-6 to PLAN-10).**

| Track | Interaction | Rule |
| --- | --- | --- |
| Evidence and annotations (PLAN-6) | An annotation reply must raise a notification through the bus | The bus has a public `emit(event)`; a new kind is one entry in `notify.ts` (additive) plus a template; that track asks through the outbox |
| Operations (PLAN-8): approval rules, scanner, maintenance, templates, onboarding | Auto-approval rules answer requests before a person does; maintenance shares backup logic; onboarding reads "notifications on" from the real state | An `approval` notification is announced 3 seconds late and only if the request is still open, so a rule that answers sends nothing; Allow from a notification for a command uses the strict matcher of the approval-rules PRD when it lands; backups and cleanup live in one place (O12); onboarding reads `GET /api/notify` |
| Side questions (PLAN-9) | A side question's answer is not a turn of the main thread | The `session_done` adapter fires only on a main-thread `result`; the btw track says how its calls are marked; the auto-move card and the btw card both sit above the composer: the order is approval, auto move, side question |
| Version pin (PLAN-7) | A canary result may want a notification | A kind may be added later |
| Multi-user (PLAN-10) | Ownership, rights, tokens | The rest of this section |

**Multi-user: where it changes each item** (the design is in each PRD's multi-user note; the platform adopts the Actor type, `can(actor, verb, object)` and `actorOf(c)` from the authorization layer when they land, behind one adapter file, `apps/server/src/platform/owner.ts`, that today returns the single owner):

| Item | What becomes per user | What stays an admin's |
| --- | --- | --- |
| 1 Notifications | destinations (a push device is a device under a user), kinds, quiet hours, history, "Notify when done", answer switches, answer tokens; events route to the owner of the session, ticket, trigger or workspace; a shared session notifies a sharer only if they opted in; sign-out ends the browser's push registration | VAPID keys, base URL and contact, the ceiling on answers, the emergency stop |
| 2 Triggers | owner, limits and approval rules; runs with the owner's rights, re-checked at every run | master switch, the total and per-owner caps |
| 3 Delivery flow | ticket links and statuses follow the ticket's owner; merging needs the right on the repository | |
| 4 Safety net | "Stop mine" | the emergency stop for everything, backups and restore, maintenance, egress policy |
| 5 Scale | every query, search result and export is filtered by `can(view)` and owner; the search index stores the owner | |
| 6 Auto transfer | the chat's owner decides and is notified; only among Claudes that owner may use; per-user defaults under the platform's caps | the platform defaults and caps |

Every per-person table in these PRDs carries `user_id TEXT NOT NULL DEFAULT 'u_owner'` (or `owner_id`); the platform-wide ones are named. The abuse suites include a cross-user matrix written now with two fake users.

## 11. Owner decisions

Each has a default taken for the design; the work does not wait for the answer, and a changed answer is cheap while nothing is built.

| ID | Decision | Default taken | If you disagree |
| --- | --- | --- | --- |
| O1 | Answer from a notification: Deny and Review always; Allow only per tool class the owner turns on, only when the whole request is in the notification, authenticated by the session and a single-use token; never for `allow_session`, plans, questions, MCP tools, sub-agents, or a session a webhook or CI trigger started; Allow switches start off. ([PWA PRD](web-app-pwa.md) §11.7 states the rejected alternatives.) | As stated | Keep every Allow off for ever (Deny and Review remain), or accept Allow for more classes |
| O2 | Auto transfer reverses Workspace Claudes' non-goal "a quota switch" and FR10 "no always switch". It is opt-in and off; `ask` keeps the confirmation per move; `auto` is your standing consent with caps | Opt-in, off | Drop `auto` and keep `ask` only |
| O3 | Triggers reverse Tickets' non-goal "automation that acts by itself". Webhook triggers wait for approval by default; the master switch is off until you turn it on | As stated | Allow `never` as the webhook default (not recommended) |
| O4 | Push keys, subscriptions and channel URLs are sealed, so a Locked or Frozen portal sends nothing and the old "Locked alert" is dropped (watch `/healthz` from outside) | Sealed | Keep one plain-text emergency channel (a leak then lets someone push fake alerts) |
| O5 | Webhooks need `/hooks/*` reachable from your Git hosts: behind Cloudflare Access that is a Bypass for that path or a second hostname; the receiver is authenticated by signature, not by Access | A path bypass | A separate hostname for `/hooks/*` and `/connect/*` together |
| O6 | Discord and Slack get a link, not interactive buttons (those need a public interactions endpoint and an app in each) | Links only | Build the interactive endpoints later |
| O7 | Trigger limit defaults: 1 parallel, 4 an hour, 12 a day, $2 a run, $10 a day, 45 minutes; every limit mandatory; costs are estimates | As stated | Different defaults |
| O8 | A new `trigger` caller in the tickets service (a surgical edit) and sessions started with the actor `portal:trigger-<id>` | As stated | |
| O9 | Auto transfer stays inside one workspace; a Console-key Claude is a destination only when you turn that on; "same model" means the family is not blocked | As stated | A cross-workspace move would need a different mechanism |
| O10 | Quiet hours off by default, with one summary when the window ends | Off | On at 22:00 to 07:00 |
| O11 | Multi-user routing: an approval goes to the session's creator; a user who was given operate rights on a shared session hears of it only if their destination opted in | As stated | Notify every user who can operate it |
| O12 | One place for cleanup and backups: the operations track's maintenance module; the emergency button and egress stay here | As stated | Keep backups in the safety net's own module |

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| Many agents edit `index.ts`, `app.ts`, `live.ts`, `chat/controller.ts`, `SessionPage.tsx` | The platform skeleton is the only wiring (`platform/`), every hook is one line listed in the package's report, nothing here edits the controller |
| Real devices differ from the documents (Safari's declarative push, `data` on `showNotification`; the cookie in a worker `fetch` was checked in Chromium only) | Every behaviour that depends on them has a safe fallback (a tap opens the deep link) and a row in §9 |
| An unattended session with injected text | Untrusted blocks, `default` mode, approval of runs, no Allow from notifications, limits |
| Cost or loops | Limits before acting, the loop guard, caps, the emergency stop |
| Webhook exposure | Signature, size, time and rate limits, no existence leaks; O5 |
| Single process scheduler | Missed times are recorded, never a burst |
| The Locked state | O4 |

## 13. Status

| Item | Status |
| --- | --- |
| Contracts `notify.ts`, `triggers.ts`, `autotransfer.ts` | **Built** 2026-10-12 |
| N1 notify core (server) | **Built** 2026-10-12: bus, adapters (chat, CI, plan usage, spend, tickets), destinations, pipeline, Web Push sender, webhook, Discord and Slack, answer tokens, history, the platform audit and skeleton; stand-ins only ([Web app & PWA](web-app-pwa.md) §11.9) |
| N2 to N5 | See their own rows and PRDs |
| Phases 2 and 3 | **Not built**; outlines above |
| PRDs | This one, [Web app & PWA](web-app-pwa.md) §11, [Triggers](triggers.md), [Auto transfer](auto-transfer.md): drafts |
