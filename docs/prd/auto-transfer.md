# PRD: Auto transfer

| | |
| --- | --- |
| Status | **v0.2** (2026-10-13). **Server built** (`apps/server/src/autotransfer`: decision, engine, routes, `automove.*` settings, migration 220, Undo's server side, notification). **Web built** (`apps/web/src/features/autotransfer`: the card, the divider mark and Undo, the session ⋯ item, the per-Claude dialog; the platform rows come from the settings registry), checked in a real browser at 390 and 1280 px, light and dark, against a scripted session (§14). **T-105 (2026-10-13): auto move proven on the fake clock** (`src/autotransfer/t105.test.ts`: R1 to R4, a restart while waiting, dry run, a usage reading; migration 760): the tick, the wait for quota, the steer, the continuation, the dry run (FR4a, FR10a). Not yet seen: a real move on real plan readings, and the dry run against the live portal (🔬, after the release). It extends the Move flow of [Workspace Claudes](workspace-claudes.md) and the recommendation of [Claude usage](claude-usage.md) §20, and it reverses two of Workspace Claudes' decisions (owner decision O2, §4). ✅ = checked here, 📄 = documented, 🔬 = unverified. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-13 (T-105) |
| Depends on | [Workspace Claudes](workspace-claudes.md) (`switchOptions`, `switchClaude`, handoff and skip), [Claude usage](claude-usage.md) (headroom, pace, `recommendMove`; U1a), [Web app & PWA](web-app-pwa.md) §11 (the bus, notifications), [Settings & policies](settings-policies.md) |
| Related | [Platform roadmap](platform-roadmap.md), [Triggers](triggers.md), [Chat sessions](chat-sessions.md) |

## 1. Summary

When the Claude a chat runs on is nearly out of plan quota, the chat can move to another Claude on the same workspace, by the same Move flow a person uses, so the work goes on without anyone watching a meter. It is **off by default** and has three modes: `off`; `ask` (a card above the composer says what is low and where it could go, with Move, Later and Always automatic); and `auto` (it moves by itself). It acts only at a turn boundary, only when a set of safeguards all hold (every one is checked before it acts), and every automatic move leaves an audit row, a card in the chat with an Undo, and a notification. When no Claude can take the chat it only warns.

## 2. Background and what exists

Checked in the code on 2026-10-12 (✅; symbols, not line numbers).

| Fact | Evidence | Consequence |
| --- | --- | --- |
| A move stays inside one workspace: `switchClaude` refuses a destination whose `workspaceId` differs ("Pick a Claude on this workspace") | `chat/controller.ts` `switchClaude`; workspace-claudes FR9 | The destinations are the other Claudes of the chat's workspace; "another workspace" is out of scope |
| `switchOptions(id)` tells for each other Claude whether a session could start there now (`ok`, a reason and the fix), whether the handoff can be asked, and what a move drops (`approvals`, `queued`, `agents`) | `chat/controller.ts`, contracts `ChatSwitchOptions` | The engine asks it before acting, and waits for `dropped` to be all zero |
| `switchClaude(id, claudeId, {handoff})` (`handoff` is `ask` or `skip`) writes the handoff, starts the new run, repoints the chat, and undoes itself on failure; an unanswered handoff falls back to the stored conversation | workspace-claudes FR11, FR12 | The automatic move is this call; the "source exhausted" case is `handoff: 'skip'` |
| Bypass across a move: kept while the policy allows it (chat-sessions §21 FR20a) | workspace-claudes FR16 | A session in Bypass is moved by itself only when `automove.allowBypass` is on (§8 FR9; the owner's decision of 2026-10-13: their own Bypass chats ran out and only ever got a card) |
| With an account pool all Claudes of a workspace share the pool's keys (`Headroom.kind: 'no_limits'`) | `claudeusage/derive.ts`, `chat/controller.ts` `pooled` | On a pooled workspace the feature is inert: there is no per-Claude quota to run out |
| `ClaudeUsageMonitor.headroom(claudeId)` never throws and never probes; `report()` returns every Claude's windows (`usedPct`, `resetsAt`, `level`, and, with U1a, `pace` and `outlook`) | `claudeusage/service.ts` | The engine reads the snapshot; it never starts a probe |
| U1a's contract has `MoveRecommendation` (candidates with `reason` `room`, `over_pace`, `tight`, `no_limits`, `exhausted`, `signed_out`, `unknown`; "room" is at least 20 % left) and `recommendMove(claudes, {workspaceId, from, nowMs, allow})` is a pure function with an `allow` hook for "Claudes the asking user may use" | `packages/contracts/src/usage.ts`, `claudeusage/recommend.ts` (untracked, in progress) | The engine composes `recommendMove` with the Move flow's own check |
| The chat controller emits every stored event and every session change to `onEvent` dispatchers; a turn's end is a stored `result` event and the session's `state` goes back to `idle` | `chat/controller.ts` | The turn boundary needs no new seam; the engine needs no edit in the controller |
| The Settings page lists `defineSetting` entries and takes custom sections (`GlanceSettingsSection` is one) | `settings/registry.ts`, `SettingsPage.tsx` | The `automove.*` settings appear there; the per-Claude and per-chat parts have their own small UI |

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **No stalled chat.** When a Claude is nearly out, the chat can carry on elsewhere, with no one watching a meter. |
| G2 | **Opt-in and visible.** Off by default; `ask` shows what and why; `auto` is an explicit choice (global, or per chat from the card). |
| G3 | **Only at a boundary, only when safe.** After a turn ends, with nothing waiting that the move would drop, and every safeguard checked before acting. |
| G4 | **Honest numbers.** A percent left is measured; a projection is an estimate and says so; a reading that is old is not used to move a chat by itself. |
| G5 | **A trail and an undo.** An audit row, a card with an Undo, a notification, an event history. |
| G6 | **Extend, do not rebuild.** The Move flow, the usage snapshot and the recommendation, the bus and the settings store are reused; the controller is not edited. |

## 4. Non-goals

- **Moving to another workspace.** A move stays in one workspace (workspace-claudes §4).
- **Choosing credentials.** The engine never copies, injects or signs in a login; it picks among Claudes that are already signed in on the workspace.
- **A paid API-key pool as a destination by default.** A Claude on a Console key bills per use; it is a destination only after a person turns that on (`automove.allowApiKey`, off). On a pooled workspace nothing moves (§2).
- **Predicting from tokens.** Quota speed comes only from the percentages Claude Code reported ([claude-usage](claude-usage.md) §20.2), never from token counts.
- **Moving an idle or a working chat for no reason, or a chat that is not on a plan Claude.**
- **Learning from past moves.**

**Amendments this PRD makes to Workspace Claudes (owner decision O2).** Its non-goal "**A quota switch.** Nothing watches a plan window or an API-key headroom and moves a session" and FR10 "Confirm is required every time. There is no 'always switch' setting" are the opposite of this feature. Both stay true **by default**: with `automove.enabled` off nothing watches and nothing moves. When a person turns it on, in `ask` mode the card is the confirmation of each move (FR10 holds), and in `auto` mode the person's setting is the standing confirmation, bounded by §8's safeguards. "The portal never picks another [credential]" (workspace-claudes §4) now reads "never copies or injects a credential; with the person's opt-in it may choose which already signed-in Claude of the same workspace takes the chat".

## 5. Users and stories

| ID | Story |
| --- | --- |
| US1 | My chat is on "Work". Its session window is at 92 %: 8 % left, under my 10 %. A card says "Work is at 8 % · move to Home (40 % left)?". I tap **Move**; the chat goes on there. |
| US2 | I tap **Always automatic** on that card: this chat moves by itself from now on. Later it does, and I get "Moved to Home · api-dev · 8 % left" and a card in the chat with **Undo**. |
| US3 | Work is already at 100 %: the move carries the stored conversation instead of asking Work for a handoff, and the card says so. |
| US4 | Every Claude I could move to is also nearly out: nothing moves, and I get one warning, not a retry storm. |
| US5 | I undo an automatic move: the chat goes back (through the normal Move dialog), and it does not move by itself again for two hours. |
| US6 | I set Work's threshold to 15 % and its destinations to Home, then Spare, in that order. Nothing else is ever chosen for Work's chats. |

## 6. Scope boundary

| Allowed | Not allowed |
| --- | --- |
| Moving a chat to another Claude of the same workspace, signed in, that the Move flow says can take it, and that the chat's owner may use | A move to another workspace; a move to a signed-out Claude; a move to a Claude the owner may not use |
| `auto` only for a chat on a plan Claude whose reading is fresh and measured | `auto` on a pooled workspace, on an API-key Claude, on an old reading, or on a chat in Bypass |
| Using `headroom` and the `recommendMove` ranking | Starting a probe, reading a Claude's directory, or showing an account, an organisation or an email |
| One move attempt per pause window, and a cap per chat and per day | Retrying in a loop, or piling many chats on one destination |

## 7. Solution overview

```
 chat event "result" (a turn ended) ─▸ mode? ─▸ applicable? ─▸ reading fresh? ─▸ low / exhausted / projection?
        (onEvent, no controller edit)    off: stop  pooled, key,    ≤ 15 min,       ≤ threshold, used up, or
                                                    signed out: stop measured       runs out within 2 h (est.)
        ─▸ safeguards (pause, per-chat cap, day cap) ─▸ destination (Move flow ok ∩ owner may use ∩ ranking ∩ allowlist
           ∩ same model ∩ not piled ∩ not just left) ─▸ none: WARN once ─▸ quiet boundary? (nothing dropped) ─▸
        ask:  banner above the composer: Move · Later · Always automatic        auto: switchClaude(handoff ask|skip)
        ─▸ audit row ─▸ notification ─▸ "Moved" divider marked auto, with Undo
```

## 8. Functional requirements

### Modes

- **FR1** Three modes: `off`, `ask`, `auto`. The platform's two settings decide the default: `automove.enabled` (off) and `automove.automatic` (off): `off`, then `ask`, then `auto` (`autoModeOf`). A user's own choice (`AutoUserPrefs.mode`, null follows the platform) and a chat's own override (`AutoSessionState.mode`, set in the session's ⋯ menu or by "Always automatic") come on top; the effective mode of a chat is its override, else the user's choice, else the platform's, **never above the platform ceiling** (`enabled` off means `off` for everyone; `automatic` off means `auto` is treated as `ask`).
- **FR2** Turning `automove.enabled` or `automove.automatic` on asks for a confirmation (the settings store's `CONFIRMATION_REQUIRED`), with one line: "Chats can move to another Claude when a quota is low" and "Chats move to another Claude by themselves when a quota is low".
- **FR3** The feature acts only on a chat whose workspace has no account pool and whose Claude is on a plan with a measured reading. Otherwise the chat's state says why (`pooled`, `no_plan_reading`) and nothing happens.

### When

- **FR4** The engine evaluates a chat at its **turn boundary**: when its `result` event is stored and its state returns to `idle` (through `ChatController.onEvent`), and again after a pause ends or a deferral (FR12) expires, and on the tick of FR4a. It never moves a chat mid-turn (FR10a). The dispatcher only queues the chat; the evaluation runs off the event path, one at a time per chat (a burst of boundaries is one evaluation), because `switchOptions` runs checks in the workspace.
- **FR4a (the tick, and the wait for quota; T-105, 2026-10-13)** A turn boundary is not enough: a long turn (an orchestrator with sub-agents) crosses the threshold without one, and a chat stopped by its limit has no next boundary at all. So every `AUTO_CONSTANTS.waitRecheckMin` (2) minutes, jittered by up to 20 seconds, and soon after every new usage reading (a probe, a chat's live `rate_limit_info`; a burst of readings is one look, at most one every 30 seconds), the engine looks again at every live chat whose source is at or under the threshold and every chat that waits; one usage snapshot per owner, never a probe. When such a chat cannot move (`no_destination`, `destination_busy`, `session_cap`, `day_cap`, `paused`) it **waits for quota**: one `waiting` row (and the FR10 warning, once), the state kept on the chat (`autotransfer_sessions.waiting_since`, `waiting_code`: a portal restart picks it up), and the tick looks again until a destination passes (then `resumed` and the move), the source recovers above the threshold (`resumed`, nothing moves), the chat ends or the mode is turned off. No person and no new turn are needed. The chat shows "Waiting for quota: next Claude free at 15:00" (the soonest reset among the Claudes it may move to; "Waiting for quota" alone when none is known, never a guessed time).
- **FR5 (the source's limit)** The windows that stop the chat are `session` and `week` (the all-model windows) and the window of the chat's model when it has one (`week_opus`, `week_sonnet`, `model:<name>`, matched to `ChatSession.model` by family). `leftPct` is the smallest `100 − usedPct` over the live ones (a window that has reset or has no number is left out), a measured figure. A per-model window of another model does not count: a chat on Sonnet is not moved because Opus is nearly used.
- **FR6 (the reasons)** `exhausted`: an all-model window is at 100 % or the chat's model window is. `low`: `leftPct` is at most the threshold (the Claude's own, else the user's, else the platform's; default 10). `projection`: `automove.useProjection` is on, U1a's `LimitOutlook.status` is `over`, the deciding window's `WindowPace.lowConfidence` is false, the estimated run-out (`etaAt`) is within 120 minutes, and `leftPct` is at most 30 (a blip on a nearly full window never moves a chat). The reading must be `checkedAt` within 15 minutes and not `stale`; otherwise the chat's state says `stale_reading` and nothing moves (`auto` never moves on an old number; `ask` shows no card on one either).
- **FR6a (which limit, and its kind; T-29, 2026-10-13)** The reading also says which window binds and its kind: `shared` (`session`, `week`: every model on the Claude stops) or `model` (the chat's own model window: only that model stops), and the least left over the shared windows alone. A plan may have several windows of each kind; each is read with its own reset and pace. The card says it in words: "Work: Opus limit has 5 % left".

### Where to

- **FR7 (candidates)** The candidates are the other Claudes of the chat's workspace that: the Move flow says can take the chat (`switchOptions(id).options[].ok`, so signed in and eligible); the chat's owner may use (`can(owner, 'operate', claude)`, passed to `recommendMove` as `allow`); have a fresh reading; and are not excluded by FR8 to FR10.
- **FR8 (ranking and policy)** Ranked with U1a's `recommendMove` (percent left, minus 20 points when its pace is `over_pace`, the sooner reset first, then `no_limits`, then `tight`). `auto` takes only `room` (at least 20 % left) and, only with `allowApiKey`, `no_limits`; `ask` offers `room`, `over_pace` and `no_limits`, with `tight` ones listed as alternatives and never recommended. If the source Claude has a destination list it is an **allowlist**: only those Claudes are eligible, in that order among the eligible, ties broken by the ranking; an empty list means any eligible Claude. With `sameModelOnly` a destination whose per-model window for the chat's model family is exhausted (`Headroom.blockedModels`) or whose model availability is unknown is excluded; what a plan includes is not visible to the portal beyond that (🔬).
- **FR9 (guards on the choice)** A destination already carrying `maxPerDestination` live sessions (counting a move on its way) is skipped; a Claude the chat left within the last 240 minutes is skipped unless it has recovered (its reading is now `room`); a chat in Bypass is **never** moved by itself (a move ends Bypass, and an unattended session would stall): at most an `ask` card.
- **FR9a (the chat's model decides what a destination has left; T-29)** A destination is judged by what it has left FOR THIS CHAT: the least left over its shared windows and the chat's model windows (`leftFor`), not its fullest window of all. A destination whose model window for the chat is at or under the threshold is not chosen, not even listed as an alternative (it would stop again at once). Within the ranking's shape (room, then Claudes without plan limits, then tight) destinations are ordered by that figure; the ranking's own order breaks ties.
- **FR9b (the options; T-29)** (a) stay; (b) change the model on the same Claude: only when the binding limit is the model's own and the shared windows have more than the threshold left, to the first model of `automove.modelFallback` (an ordered list of families, e.g. `sonnet, haiku`; empty: never) that has more than the threshold left there; no handoff, the conversation and the permission mode (Bypass included) stay, Undo switches the model back; (c) move to another Claude keeping the model; (d) when no Claude has room on the chat's model, move to the first Claude with room on the first fallback model, with its handoff. `automove.keepModelFirst` (on by default) orders (c) before (b); off, (b) before (c). (d) only when neither is possible. Bypass holds back a move (unless `allowBypass`) but never a model change in place.
- **FR10 (nothing viable)** When the candidates are empty the engine warns: one `warned` event and one `auto_move` notification ("No Claude to move to") per chat and source window period, and a line on the card state (`no_destination`, or `destination_busy` when every candidate is full). It does not retry in a loop: the chat waits for quota (FR4a) and the tick looks again every 2 minutes.
- **FR10a (while the chat works, and after the move; T-105)** A chat at or under the threshold whose turn is running is never moved mid-turn and a running sub-agent is never interrupted. Once per source window period (`steered_period`) the engine sends the chat ONE message, priority `next`, as `portal:autotransfer`: "Your Claude (Work) is at 8% left: finish the current step, commit and push your work, then stop. The portal moves this chat to Home and you continue there." (a `steered` row), and the chat shows "Moving at the end of this turn". At the boundary the move runs (immediately when the limit was hit meanwhile, R2). After an automatic move that followed an exhausted source or a steer, the engine sends the continuation on the new Claude, priority `next`: "Moved to Home by the portal (…). Continue where you stopped." (a `continued` row; fixed text over names, never anyone's words). This is the one owner of "continue after a move": the Keep going policy (T-104, not built yet) must not nudge for it. A quiet move (idle chat, nothing interrupted) sends nothing.
- **FR10b (an exhausted source; T-105 R2)** When the source is `exhausted` the pause and the caps do not apply (the chat is stopped anyway) and such a move is not counted against `maxPerSessionPerDay` or `maxPerDay`; the ping-pong guard (FR9: the Claude it left in the last 240 minutes, unless that one recovered) still does.
- **FR10c (dry run; T-105)** With `automove.dryRun` on, the engine does everything up to acting and records a `dry_run` row for what it would do (the actor says which: `…:move` or `…:steer`; with no move there is no continuation); nothing moves and nothing is said to a chat. For checking a portal before trusting it with real chats. `GET /api/autotransfer/state` lists, per live chat of the caller, its Claude, what is left, the last decision, the wait and a pending move.

### Safeguards (all checked before acting)

- **FR11** `minPauseMin` (default 5; 30 before T-105) since the chat's last move or answered suggestion; `maxPerSessionPerDay` (8; was 2) and `maxPerDay` (30, across all chats; was 6) moves in the last 24 hours (rolling); each is a refusal with its code (`min_pause`, `session_cap`, `day_cap`) recorded once per pause window. None of them holds back an exhausted source (FR10b).
- **FR12 (the quiet boundary)** An automatic move starts only when the chat is `idle`, not already moving, and `dropped` (approvals open, messages queued, agents running) is all zero. Otherwise it waits (`busy`), re-evaluating at the next boundary and every 60 seconds, up to 30 minutes, then becomes an `ask` card that says what a move would drop. An approval is never answered or denied by the engine.
- **FR13 (handoff)** `ask` (the chat's Claude writes a handoff first) unless the reason is `exhausted` or `switchOptions(id).handoff.ok` is false, then `skip` (the stored conversation carries). The handoff is a turn on the Claude that is nearly out: the default threshold leaves room for it, and the Move flow itself falls back to `skip` when that Claude cannot answer.
- **FR14 (failure)** If `switchClaude` refuses or fails, the chat stays where it was (the Move flow undoes itself), a `failed` event records the code, and the chat is paused for `minPauseMin`; a second failure for the chat in a day ends automatic moves for it that day (an `ask` card remains possible).

### The card (ask mode)

- **FR15** One open suggestion per chat, shown as a card above the composer (the place of the approval card): "Work is at 8 % · Home has 40 % left", **Move**, **Later**, **Always automatic**, an "Other…" choice among the alternatives, and one line when a move would drop something ("Drops 1 agent"). Numbers carry their basis (measured, or "est." with the formula in an InfoTip). **Move** is the confirmation and calls the Move flow now (safeguards other than the pause apply; the flow itself waits for a running turn and says so); **Later** holds the suggestion back 20 minutes; **Always automatic** sets this chat's override to `auto` (shown only when the platform allows `auto`), records a `mode_set` event, and moves now. A suggestion closes when the chat ends or moves, when the source recovers above the threshold, or after 24 hours.
- **FR16** In `ask` mode a notification (`auto_move`, "Move suggested") goes to the chat's owner; its action is a link to the chat, never a button.

### The move and its trail

- **FR17** An automatic move calls `ChatController.switchClaude(id, dest, {handoff})` for the chat's owner. The call has no actor parameter (✅ read in the code: `switchClaude(rawId, destClaudeId, opts: {handoff})`), so the Move flow records the move as it records any move; the actor `portal:autotransfer`, the owner and the reason live in the engine's own rows and the platform audit. On success: an `autotransfer_events` row (`moved`, with the move's `handoffId` read from the new "Moved to" row), a platform audit row, an `auto_move` notification ("Moved to Home · api-dev · 8 % left"), and the chat is paused for `minPauseMin`.
- **FR18** The Move flow's divider ("Moved to Home") carries an **auto** mark and **Undo** when the move was automatic and is less than a day old: the page finds it by `handoffId` from `GET /api/autotransfer/events`. No change to the controller or to the stored events.
- **FR19 (Undo)** Undo opens the normal Move dialog with the Claude the chat left already chosen, so the confirmation, the handoff choice and the dropped line are the ones every move has. It is disabled, with the reason, when that Claude cannot take the chat now (still out until a time, signed out). When the engine sees the chat go back to the Claude it left within a day (a `session` change), it records `undone` and pauses automatic moves for that chat for 120 minutes. Undo is never silent and never automatic.

### Settings, audit, tools

- **FR20 (settings)** Platform (an admin's; group "Auto move"): `automove.enabled`, `automove.automatic`, `automove.thresholdPct` (10), `automove.useProjection` (on), `automove.minPauseMin` (5), `automove.maxPerSessionPerDay` (8), `automove.maxPerDay` (30), `automove.maxPerDestination` (3) (the T-105 defaults, 2026-10-13; the owner had set them live), `automove.sameModelOnly` (off), `automove.allowApiKey` (off; turning it on asks for a confirmation), `automove.dryRun` (off, FR10c). The ⓘ of "Auto move" says R1 to R3 in one place: the move at the threshold, at once when out, the wait and the resume. Per user (`AutoUserPrefs`): mode, threshold, projection, same-model, API keys (each null follows the platform; the caps cannot be raised). Per Claude and user (`AutoClaudeConfig`): its threshold and its ordered destinations. Per chat: the override in the session menu. Constants, not settings: 20 minutes for Later, 120 for the pause after Undo, 15 for a fresh reading, 120 for the projection horizon, 30 for the projection's left-percent bound, 30 for the deferral, 240 for ping-pong, 2 for the tick (FR4a).
- **FR21 (audit)** Every suggestion, move, refusal that matters (a cap, a failure), warning, mode change and undo is a platform audit row and an `autotransfer_events` row (names, ids, the facts with their basis; never message text); kept 90 days.
- **FR22 (Portal MCP)** A read tool `autotransfer_status` (the chat's state and recent events). Nothing changes a mode or moves a chat over MCP.

## 9. The decision, in order

For a chat S at its turn boundary (each line stops the evaluation with its code):

| # | Check | Code |
| --- | --- | --- |
| 1 | Effective mode (FR1) is not `off` | `mode_off` |
| 2 | The workspace has no pool; the chat's Claude is on a plan with a measured reading (FR3) | `pooled`, `no_plan_reading` |
| 3 | The reading is at most 15 minutes old and not stale (FR6) | `stale_reading` |
| 4 | A reason holds: `exhausted`, `low` or `projection` (FR5, FR6) | `above_threshold` |
| 5 | The chat's owner is an enabled user who may operate the chat (§17) | `owner_denied` |
| 6 | Not paused, minimum pause over, chat and day caps not reached (FR11); skipped for an exhausted source (FR10b) | `paused`, `min_pause`, `session_cap`, `day_cap` (then wait, FR4a) |
| 7 | A candidate exists after FR7 to FR9 | `no_destination`, `destination_busy` (warn once, then wait, FR4a) |
| 8 | `ask`: make or keep the suggestion, notify | |
| 9 | `auto`: not in Bypass unless `automove.allowBypass`; a turn running: steer once and move at its end (FR10a); the quiet boundary holds (FR12), else wait or become a card | `not_idle`, `busy` |
| 10 | `switchClaude` with the handoff of FR13; record, notify, pause | `move_failed`; `folder_untrusted` when the folder's settings changed since it was trusted (T-38: notified as "Move blocked") |

## 10. Data model

Migrations 220 to 229 are N4's (shapes, not SQL). Every per-person table carries `user_id TEXT NOT NULL DEFAULT 'u_owner'`. No secret is stored.

| Table | Columns |
| --- | --- |
| `autotransfer_user` | **user_id** (primary key), mode (null follows the platform), threshold_pct, use_projection, same_model_only, allow_api_key (each nullable) |
| `autotransfer_claudes` | **user_id**, claude_id, threshold_pct (nullable), destinations (JSON list of Claude ids, in order); primary key (user_id, claude_id) |
| `autotransfer_sessions` | session_id (primary key), **user_id** (the chat's owner), mode (an override, nullable), last_claude_id (to notice a move made by a person), paused_until, defer_since, last_eval_at, warned_period; waiting_since, waiting_code, steered_period (migration 760, T-105) |
| `autotransfer_suggestions` | id, **user_id**, session_id, at, reason, from_claude, to_claude, alternatives (JSON), facts (JSON), handoff, dropped (JSON), state, resolved_at |
| `autotransfer_events` | id, at, **user_id**, session_id, workspace_id, kind (T-105 adds `waiting`, `resumed`, `steered`, `continued`, `dry_run`; migration 760 rebuilds the table for its CHECK), mode, reason, from_claude, to_claude, facts (JSON), handoff, handoff_id, code, actor; indexes (session_id, at), (user_id, at) |

Hooks into other areas (the whole list): **none in the server's chat code** (the engine uses `onEvent`, `switchOptions`, `switchClaude`, `headroom`, `report` and the settings store); the web gets one-line mounts: the card in `SessionPage`/`Composer` area, the divider mark in `Transcript`, an "Auto move" item in the session ⋯ menu, a section in `SettingsPage`, and the per-Claude choice on the Claudes list. Those files are shared with U3 and the btw work: mount after they report done.

## 11. API

The table is `AUTOTRANSFER_API` (behind the session guard and the Origin check; a user sees and changes only their own):

| Route | Purpose |
| --- | --- |
| `GET /api/autotransfer` | The platform values, the caller's choices, the effective values, and the caller's per-Claude settings |
| `PUT /api/autotransfer/prefs`, `PUT /api/autotransfer/claudes/:claudeId` | The caller's own choices; a Claude's threshold and destination list |
| `GET`, `PUT /api/autotransfer/sessions/:id` | A chat's state (mode, applicability, the open suggestion, pause, moves today, the last move and whether it can be undone); its override |
| `POST /api/autotransfer/suggestions/:id/move`, `/later`, `/always` | The card's three buttons |
| `GET /api/autotransfer/events` | The trail (`?session=&limit=&before=`) |
| `GET /api/autotransfer/state` | What the engine waits for, per live chat of the caller (`AutoEngineState`: dry run on or off, each chat's Claude, left, last decision, wait, pending move; T-105) |

## 12. Security and threat model

| Threat | Control | Test |
| --- | --- | --- |
| A move storm, or ping-pong between two nearly empty Claudes | Minimum pause, caps per chat and per day, per-destination cap, 240 minute ping-pong guard, one failure retry rule, "no destination" warns once | S10 to S12, S17 |
| A looping agent burns one Claude and then the next | The same caps bound the moves; the usage track's spike and budget alerts tell the owner; the cost is each Claude's own | S12 |
| Moving on a wrong or old number | Fresh readings only (15 minutes), measured percent for `low`, a projection needs confidence and a 2 hour horizon, both ends of the move must be fresh | S5 to S7, S9 |
| Dropping work | Automatic only at a quiet boundary; otherwise a card that says what it drops; an approval is never answered | S14 |
| Silent change of who pays | API-key destinations off by default and behind a confirmation; pooled workspaces inert; the card names the Claude and its kind | S8, S18 |
| A move into a Claude the owner may not use | `allow` in `recommendMove` and the owner's `can` before the call; a refusal is `owner_denied` | S19 |
| Bypass ended unseen | A chat in Bypass is moved by itself only with `automove.allowBypass`, and the move keeps Bypass (FR20a) | S13, S13b |
| A handoff leaking a secret | The Move flow's own redaction of the context file; nothing here adds text | (workspace-claudes §13) |
| Notification text carrying session titles or message text | Fixed templates over names and numbers ([web-app-pwa](web-app-pwa.md) §11.1) | canary |
| Another user acting on a chat | Every route filters by the owner and `can`; a suggestion id of another user answers like an unknown id | S20 |

## 13. What the person sees

| Place | Content |
| --- | --- |
| The card (above the composer) | "Work is at 8 %" · "Move to Home (40 % left)", **Move**, **Later**, **Always automatic**, ⓘ (the reason, the basis of each number, the formula of a projection, what is dropped), and a small "Other…" |
| Above the composer, when held (T-105) | "Waiting for quota: next Claude free at 15:00" or "Moving at the end of this turn", read only, ⓘ (why, and what happens next) |
| The divider | "Moved to Home · 14:02" with an **auto** chip and **Undo** (a day); the existing "Context from Work" card below it |
| Session ⋯ | "Auto move": Off, Ask, Automatic, Default |
| Settings, section "Auto move" | The platform rows (labels of a word or two: Auto move, Without asking, Threshold, Projection, Pause, Per chat, Per day, Per Claude, Same model, API keys), each with ⓘ |
| Claudes list, a Claude's ⋯ | "Auto move…": its threshold and its destinations, ordered |
| Notification | "Moved to Home · api-dev · 8 % left"; "Move suggested · api-dev"; "No Claude to move to · api-dev" |

## 14. Testing and verification

Scenario tests with expected results worked out by hand and written in the test (a number is never asserted only because the code produced it). Each uses the usage fixtures with fixed clocks; the controller is the real one with the scripted stand-in Anthropic API where a move runs, and a fake where it only decides.

| # | Scenario | Expected |
| --- | --- | --- |
| S1 | `auto`, Work `session` at 92 % used (8 % left), threshold 10, Home at 60 % used (40 % left, `room`), no destination list, chat idle, nothing waiting | Moves to Home with `handoff: ask`; one `moved` row; one notification; paused 30 minutes |
| S2 | The same in `ask` | One suggestion; no move; one notification |
| S3 | Work at 85 % used (15 % left) | Nothing (`above_threshold`) |
| S4 | Work at 100 % | `exhausted`; `handoff: skip` |
| S5 | Work 85 % used, pace `over` (projected 130 % at reset), not low confidence, run-out in 90 minutes | `projection`: moves (15 left is at most 30; 90 is at most 120) |
| S6 | The same with the run-out in 4 hours | Nothing |
| S7 | The same with `lowConfidence` true | Nothing |
| S8 | A pooled workspace | Inert (`pooled`) |
| S9 | Home's reading is 20 minutes old | Excluded; with no other candidate: `no_destination` warning |
| S10 | Two candidates, `maxPerDestination` 2, Home already carries 2 sessions | The other is chosen; with both full: `destination_busy` warning, once |
| S11 | A move 10 minutes ago | `min_pause`, nothing moves |
| S12 | Two moves for the chat in the last 24 hours | `session_cap` |
| S13 | A chat in Bypass, mode `auto` | Only an `ask` card; no move |
| S13b | A chat in Bypass, mode `auto`, `automove.allowBypass` on (2026-10-13) | Moved like any other; the chat is still in Bypass on the destination |
| S14 | An approval is open | `busy`; re-evaluated; after 30 minutes a card that says "drops 1 approval" |
| S15 | A chat on Opus; `session` 40 % used, `week` 40 %, `week_opus` 95 % used | `low` (5 % left on its model's window); the same state for a chat on Sonnet: nothing |
| S16 | `sameModelOnly`; Home's `blockedModels` includes "Opus"; the chat is on Opus | Home excluded |
| S17 | The owner moves the chat back to Work 10 minutes after an auto move | `undone` recorded; no automatic move for 120 minutes |
| S18 | The only candidate is on a Console key | Excluded unless `allowApiKey`; with it, chosen last |
| S19 | The owner may not use Home (two fake users) | Home excluded; with no other: `owner_denied` or `no_destination` |
| S20 | A second user posts to the first user's suggestion id | 404, nothing changes |
| S21 (T-105 R1) | `auto`, idle chat, Work at 10 % left, Home 50 %, no turn boundary | Moved at the next tick; at 11 % left nothing |
| S22 (R2) | Work at 100 %, the per-chat cap used and a pause running, the chat came from Spare 2 minutes ago | Moved to Home at once (`skip`), never back to Spare; a forced move does not count toward the caps; then `continued` |
| S23 (R3) | Work and Home at 95 % | `waiting` and `warned` once; nothing in later ticks; Home drops to 60 %: `resumed`, moved, no boundary in between. Or Work resets: `resumed`, nothing moves |
| S24 (R3) | The portal restarts while the chat waits | The new engine picks the wait up and moves when a Claude frees up |
| S25 (R4) | A Bypass chat (`allowBypass`) working with a sub-agent running, Work at 8 % | One steer over three ticks, "Moving at the end of this turn", no move mid-turn; at the boundary moved with Bypass kept, then `continued` |
| S26 | `automove.dryRun` on | `dry_run` rows for the steer and the move; nothing moves, nothing said |
| S27 | Five usage readings in a burst | One look within seconds (the steer), the next at least 30 seconds later; none after the engine stopped |

| Area | What | Status |
| --- | --- | --- |
| Decision function | S1 to S20 as pure tests over fixtures | Built (`decide.test.ts`, `engine.test.ts`) |
| The engine on the fake clock | S21 to S27 | **Built** 2026-10-13 (`t105.test.ts`) |
| The move | A real `switchClaude` against the stand-in API in a scratch Docker workspace (Kubernetes off, `KUBECONFIG` unset): one chat id across the move, the divider mark, the audit row, the undo | Not built |
| Web | The card, the divider mark and the Undo at 390 and 1280 px, light and dark, keyboard and touch | **Checked** 2026-10-13 (`tools/qa/automove.mjs`, see §14.1); keyboard order not walked by hand |
| Real accounts | A real plan reading and a real move on the owner's Claudes | 🔬 manual, owner |

### 14.1 The web half, as observed (2026-10-13)

`tools/qa/automove.mjs` runs the real session page in headless Chromium over CDP against a scripted session (`btw-fake.js`) and a stand-in for `/api/autotransfer` (a chat moved by itself from Work to Home an hour ago, and a card offering Spare), and the real Settings page and Claudes list of a scratch portal (a local workspace with three Claudes; the per-Claude route was called for real: a threshold of 15 and two destinations saved, 0 refused with 422). Sizes: 390 x 844 with touch and the iPhone's safe areas (59 top, 34 bottom), and 1280 x 800; light and dark; four cases (platform `auto`; long names with no spaces, an Undo that can't run and a used-up source; platform `ask`; platform `off`). Result: **520 of 520 checks** on the full matrix; then a check that no text spills out of the card or the divider was added (with the old alternative button it fails, 35 of 37 at 390 px; fixed, the long-name case passes 148 of 148 at both sizes, light and dark).

| What | Observed |
| --- | --- |
| The card | "Home has 8 % left" (or "… is used up"), "Move to Spare (40 % left)", "Drops 1 agent"; Move, Later, Always automatic (only when the platform is `auto`), Other (the alternatives inline, each a full button). ⓘ: the reason, each number's basis, the handoff or the stored conversation, and, in Bypass, that the move keeps it (chat-sessions §21 FR20a). Every button 44 px tall on touch; the card stays clear of the composer; no horizontal scroll with names of 60+ characters without spaces (found and fixed: an alternative's button didn't wrap its name; the harness now checks that no text spills out of its box). Later and Move call their routes and the card goes. No card when the platform is off. |
| The divider | "Moved to Home · 07:20" with an **auto** chip, an ⓘ and **Undo**; on a phone the chip and Undo wrap under the words. Undo is 44 px on touch and opens the Move dialog with Work (the Claude the chat left) chosen; when it can't run it is disabled and the ⓘ says why ("Out of quota until it resets."). The row is a named group, not a separator, so its button is announced. |
| Session ⋯ | "Auto move: Ask" (or Automatic); a dialog with Default, Off, Ask and, only when the platform allows it, Automatic, as 44 px rows (the 40 px segmented control was replaced); "Now: …" with the reason it does nothing (pooled, no plan reading, an old reading, …) and a pause. No item when the platform is off. Choosing sets the chat's override (`PUT …/sessions/:id`). |
| Settings | The "Auto move" group's rows from the server's registry: Auto move, Without asking, Threshold, Projection, Pause, Per chat, Per day, Per Claude, Same model, API keys, each with its ⓘ; no horizontal scroll at 390. |
| A Claude's ⋯ "Auto move…" | Its threshold (empty follows the default) and its destinations in order (up, down, remove, add); a line "Auto move is off. Settings" while the platform is off; 44 px buttons on touch. |

Decided here (PRD defaults, no owner question): the user's own choices (`AutoUserPrefs`) have no screen yet: with one owner who is also the admin, the platform rows are the choices; the route exists for multi-user. The session ⋯ item is hidden while the platform is off (a chat's choice can't raise the ceiling, FR1). Not done: the keyboard order walked by hand, phone landscape, 768, 1024 and 1920 (the harness runs 390 and 1280), and a real move on real readings (🔬).

## 15. Milestones

| Milestone | Scope | Status |
| --- | --- | --- |
| Contracts | `packages/contracts/src/autotransfer.ts` | **Built** 2026-10-12 |
| N4a | Server: the decision function, safeguards, the engine on `onEvent`, tables, routes, settings, audit, notification, tests; migrations 220 to 229 | **Built** (on integration) |
| N4b | Web: the card, the divider mark and Undo, the session menu item, the settings section, the per-Claude choice | **Built** 2026-10-13 (branch `dev/automove-web`); §14.1 |

## 16. Decisions and open questions

Decided here (owner decisions in the [roadmap](platform-roadmap.md) §11): opt-in, off, `ask` and `auto` (O2); the destination stays in the same workspace and a paid API-key Claude is off by default (O9); "same model" means the family is not blocked, not a promise about plans (O9); "Always automatic" is per chat, never global. Open: 🔬 does a plan that lacks a model show it in any reading the portal gets; should a long idle chat on a low Claude be moved at its next message instead of at a turn's end (the PRD says no: a turn boundary is the only moment); whether the handoff turn of a Claude at 8 % is acceptable (it costs a turn of that Claude's last quota). **Open since 2026-10-13:** [chat-sessions](chat-sessions.md) §21 FR20a (decision SR) says an automatic move keeps Bypass, while FR9 here still says a chat in Bypass is never moved by itself and the engine follows FR9 (`decide.ts`: Bypass only gets a card). The web says "Bypass stays on after the move" in the card's ⓘ, which is true of the Move the card starts; whether `auto` may now move a Bypass chat by itself is the owner's call.

**2026-10-13, owner:** a chat in Bypass is moved by itself too, when the platform setting `automove.allowBypass` (group Auto move, a confirmation to turn on, off by default, the platform's only) is on; the move keeps Bypass on the destination while the policy allows it (chat-sessions §21 FR20a, the Move flow's `#keepBypass`). Why: the owner's own chats run in Bypass, and until now a Bypass chat that ran out only ever got a card (events `suggested` at 06:08, 06:18 and 06:35 on 2026-10-13, never `moved`), which defeats automatic moves for the way the portal is used. Seeded on in `deploy/k3s/seed-features.sh`.

**2026-10-13, owner (T-29):** decide per limit and per model. Why: a Claude can have several limits, some for every model and some for one model only; until now the fullest of them decided and the only answer was a move to another Claude, so an Opus chat whose Opus week ran out moved away (with a handoff) even when the same Claude had plenty of room on Sonnet, and a Claude with a full Opus week could be offered to an Opus chat. Defaults: keep the model first (a person picked the model on purpose), and no fallback list until the owner sets one, so nothing changes model by itself before that.

## 17. Multi-user (PLAN-10)

The engine acts for the chat's **owner**, and only among Claudes that owner may use: `recommendMove`'s `allow` and the owner's `can(owner, 'operate', claude)` both apply, and the owner must still be an enabled user who may operate the chat (`owner_denied` otherwise). The platform values (`automove.*`) are the defaults and the caps (an admin's); a user's own choices override the defaults and are never looser than a cap. The card, the notification, the audit row and the events belong to the owner. `autotransfer_user`, `autotransfer_claudes`, `autotransfer_sessions`, `autotransfer_suggestions` and `autotransfer_events` carry `user_id TEXT NOT NULL DEFAULT 'u_owner'`. A Claude's sign-in belongs to its workspace: whether a user other than the one who signed it in may use it is the authorization layer's decision, which this feature only asks (`allow`). The cross-user cases (S19, S20) are written now with two fake users. Today there is one user and none of this shows.
