# Flow watchdog

Status: v0.1 · T-1966 · server and Home card built, not yet deployed.

## Why

A program's work flow is run by lead sessions (merge gate, QA dispatch, next ticket). A session only acts when it gets a message. The
session that used to wake them was the coordinator's own session plus scripts on the Mac. When those stopped, nothing moved: on the night
of 2026-10-20/21, 4 tickets were done in 24 h while the tickets in review went from 50 to 92. The flow watchdog is a deterministic loop
inside the portal server, with no model. It keeps the leads moving whoever is online.

## What it does

`apps/server/src/flow` is a platform module (one line in `platform/index.ts`). Every 5 minutes it looks at each configured program. It
skips the round while it is switched off, or while the portal cannot write (frozen, locked). It counts eight conditions:

| | Condition | Action |
| --- | --- | --- |
| a | In review, a QA PASS on the head (with a recorded PR: its `pr_head`, plus a review PASS there when the ticket has any review verdict), not merged for `flow.mergeAfterMin` (20) | Message the merge-gate lead with the exact list: stable id, bucket key, and either "<repo>#<pr> QA PASS on the PR head <sha> (<state>)" or, with no PR recorded, "QA PASS on <sha> (newest seen, no PR status)" with the ask to check it is the PR head and record the PR |
| b | In review, no verdict on the head, nobody working on it for `flow.qaAfterMin` (60), and not in a live batch | Message a peer lead a `QA-ASK batch` with the tickets, round robin, never the author's lead or lineage: at most 8 per peer per message (D-93, T-1987) |
| c | A lead idle for `flow.idleAfterMin` (30) while its unit (itself and its workers) holds open or in-progress tickets, and it runs fewer live workers than its cap | Message that lead its next tickets: priority first, then oldest, at most 5 |
| d | A lead that was in Bypass is now on the default mode or has ended | Reported only (audit and card). See Bypass |
| e | No ticket done in `flow.stallHours` (3) while tickets wait in review | Notify the owner once per stall, when it has lasted `flow.notifyAfterHours` (3) after the first nudge. If no lead could be told, the time counts from when the stall began |
| conflict | In review, the merge gate's newest open record is `conflict` (T-2014). Told at once, the round it is seen (T-2018; it used to wait `flow.mergeAfterMin`) | Message the ticket's unit lead: send it back to its builder for a rebase; QA then verifies the new head |
| no_pr | In review, the merge gate's newest open record is `no_pr`, told at once too (T-2014, T-2018) | Message the ticket's unit lead: open the PR (or have its builder open it), or say on the ticket why not |
| idle_lanes | A lead that may be told (live, not stopped by a person, Keep going not paused for it) has one or more builder workers idle for `flow.laneIdleMin` (10) while its unit has a `conflict` or `no_pr` record, or open or in-progress tickets (T-2018) | Message that lead the idle lane ids (longest idle first) and the next items: conflicts first (ticket, repo#pr), then no_pr, then the open tickets, priority first then oldest (at most 5) |

**Idle lanes** (T-2018). On 2026-10-22 at 03:35 UTC, 4 sessions were working and 19 idle, every Claude had fresh quota, and 15 PRs
were in conflict with nobody rebasing them: condition c only fires when the LEAD itself is idle under its cap, and a lead that is busy (or
at its cap) while its own builders sit idle was never told. A **builder lane** is a worker the lead started directly (its `parentId` is the
lead's live head or any id the lead went by) whose agent name is a whole builder role word: `implementer`, `builder`, `lane-backend`,
`lane-frontend`, `lane-fullstack`, with at most one prefix part (`konfersi-implementer`), the same rule as the peer verifier names. QA and
review lanes are not counted (they take QA-ASK batches), nor `builder-qa`, a worker of a worker, or a worker without an agent. It is idle
when it has not ended, its process is not gone, its state is idle with nothing waiting, no busy turn and no running sub-agents, and its
last activity is `flow.laneIdleMin` old or more. The unit's work is the same as elsewhere: tickets whose holder's crew root is the lead.
The card counts the idle lanes of units that have work.

**The merge gate's record** (T-2014, tickets PRD FR36e). The merge gate (the program's merge-gate lead, or a worker it started) records what
it knows of a ticket's pull request per repo with `ticket_merge_status`: the PR number, its current head and a state (`ready`, `merged`,
`conflict`, `waiting`, `no_pr`, `failed`). When a ticket has a record, the watchdog uses it and not the heuristic below: a ticket whose every
recorded repo is `merged` is skipped; otherwise the newest record that is not `merged` stands. `conflict` and `no_pr` go to the ticket's unit
lead (the lead whose unit holds it; a ticket no unit lead holds is recorded `skipped` once per window); the rest are judged on that record's
`pr_head`, the same rule the merge gate applies: a QA PASS on exactly that commit, and a review PASS on it too when the ticket has any review
verdict. A ticket that is done or won't do is never looked at (only open, in-progress, blocked and in-review tickets are read). On
2026-10-22 about 25 of 58 tickets the heuristic counted were not mergeable: verdicts on a batch head, already merged or closed, no PR.

Without a record, the **head** of a ticket is the newest commit the portal has heard of for it: a CI check's commit or a verdict's commit. A verdict wins a
tie. The portal does not know a branch's head. A short check sha is widened to the verdict commit it begins; otherwise it stays short and
no verdict matches it. A branch that moved after a PASS is therefore not passing (FR36: `evaluateVerdicts`). A branch that moved with no
newer CI check and no newer verdict can still look passing; that is why the merge message labels such a row "(newest seen, no PR status)"
and asks the merge lead to check it is the PR head and record the PR. Resolving the real head would need a git read in the workspace on every round, which the watchdog
does not do. "Nobody working on it" means
no session started on the ticket (`ticketId`) is live and was active within the QA threshold. The ticket itself must also have had no
update for that long.

A **lead** is a configured session id. It stands for its live head: the session itself while it runs, else its successor (a Move) or its
newest continuation (`continuedFrom`), followed until one has not ended. A lead with no live head gets no message. The skip is recorded
once per window. A ticket belongs to a lead's unit when its holder's crew root (the top of the `parentId` chain) is any id the lead has gone
by, its predecessors and continuations included.

**QA in batches** (D-93, T-1987). A QA-ASK is a batch: it starts `QA-ASK batch: take these as one qa/batch branch, one job run, a verdict
per ticket (D-93)` and asks the peer to record each verdict with `ticket_verdict_batch` (tickets PRD FR36d). One message to one peer holds at
most 8 tickets (`FLOW_LIMITS.qaBatchPerPeer`); tickets no peer has room for this round are still counted and wait for the next window (no
`skipped` row: a peer may verify them, it is only full). A ticket **in a live batch** is not asked again: a comment or CI entry after its
newest verdict names a batch branch as a whole token (`qa/batch-<date>-<n>` or `batch/<date>-<n>`, the date `YYYY-MM-DD` or `YYYYMMDD`; a path like `src/batch/foo.ts` is not one; `liveBatchOf` in the tickets service, the newest 20 entries)
within `FLOW_LIMITS.batchLiveMin` (180 min). Its verdict ends the batch for it; an older mention is a batch that stopped, and the ticket is
asked again.

## Messages

- They are sent through the chat controller's send path as actor `portal:flow` (label "Flow watchdog"), priority `later`. A message
  waits behind a running turn and is never put in the middle of a tool call.
- Each starts with `FLOW WATCHDOG:`. They hold fixed words, ids, keys, commits, priorities and statuses only. They never include a
  ticket summary or a session title (both are agent text).
- They go only to a live session the owner may `operate` (checked each time through the authorization seam).
- They are rate limited to one message per lead per condition per `flow.repeatMin` (30). A limit that is reached, and a send that is
  refused, both wait for the next window.
- Every action (`told`, `reported`, `notified`, `skipped`, `failed`) writes a platform audit row `flow.<kind>`, with the program,
  condition, session and ticket ids. The last 50 actions are kept in the state.

## Bypass

The watchdog never enters Bypass and changes no gate. The one safe way back into Bypass is the chat controller's own wake of a lead whose
sleep kept it (`#keepBypass('wake' | 'lost')`, which checks the policy, the capability, the lead rule and the person's own entry again).
That wake runs on any message. So a head that is asleep or gone, and whose own newest record says its sleep kept Bypass, does not count
as lost. In every other case the watchdog only reports: a person turned it off (actor `ui`, not counted), the policy turned it off, or
the lead was continued as a new chat (never bypass-capable, FR20).

## Settings (group Flow, owner only)

| Key | Default | Meaning |
| --- | --- | --- |
| `flow.enabled` | on | The kill switch |
| `flow.paused` | empty | Programs on hold (names, comma separated, `*` for all): counted, not acted on |
| `flow.programs` | `konfersi\|konfersi-migration\|\|` | Programs split by `;`, each `name\|tag\|group\|merge gate\|on`. `group` is a 1-based index into `tickets.leadPeerGroups`; empty means the first group whose leads hold the program's tickets (else the first group). `merge gate` is a lead id; empty means the first lead of the group. Add `\|off` to stop one program. Checked on save: every program must read, and a merge gate must be a lead of its group (any group when the group is empty). If the groups change later, a gate that is no longer a lead falls back to the first lead. |
| `flow.mergeAfterMin`, `flow.qaAfterMin`, `flow.idleAfterMin`, `flow.laneIdleMin`, `flow.repeatMin` | 20, 60, 30, 10, 30 | Minutes. `flow.mergeAfterMin` no longer delays conflict and no_pr (T-2018) |
| `flow.stallHours`, `flow.notifyAfterHours` | 3, 3 | Hours |

The settings route needs `settings` `manage`. No agent tool writes settings.

## State, route, notification, card

- **State:** one JSON value in `portal_meta` (`flow:state`): rate limits, the round robin, stalls, the last actions and the last
  round's view. No migration. A restart keeps the rate limits.
- **Route:** `GET /api/flow` (`FLOW_API.snapshot`) returns `FlowSnapshot`. It answers a platform admin, as a person or through an admin
  token. Anyone else, an agent included, gets the same 404 as an unknown route.
- **Notification:** the stall uses the existing `keepgoing_attention` kind (`what: flow_stalled`, title "Flow stalled", body
  `program · N in review · none done in 3 h`). Every destination that already hears Keep going hears it too, Web Push included. A new
  kind would have needed a migration for destinations that keep an explicit list of kinds.
- **Card:** Home card and glance widget `flow`, hidden in the strips by default. It shows Merge, No QA, Idle and Bypass in one row (a stall is a status line above them, "Stalled · program"; idle builder lanes too, "Idle lanes · N", since a fifth figure does not fit the row at 390 px), plus
  the last 5 actions; the explanation is in its InfoTip. It reloads after each round (see Live refresh). A program the round could
  not read shows `-` and "Unavailable · program" (why in its InfoTip), never "Nothing needed a nudge.", which shows only when every program
  was read.

## Who is never told, and holds

- **A lead whose process is gone, or that is interrupted.** A send to it would relaunch it, and the watchdog never relaunches a session
  (Keep going or a person brings it back). Crew reports and the crew wake skip the same leads. An asleep lead is only woken by the
  message, as crew reports do.
- **A lead a person stopped.** A Stop by a person, or through the session tools, is put on record in the chat audit trail
  (`crewhold.set`), so it survives a portal restart. Only a person lifts it (`crewhold.lifted`): their own message or their own Resume. The
  portal's messages and resumes (Keep going, tickets, the watchdog) do not lift it. A row is written only when the state changes. The
  controller answers through `stoppedByPerson`; a controller without it counts as held (fail closed).
- **A lead a person closed** (End: "Closed by operator"). It is followed only into a continuation a person started (`startedBy` `ui` or
  `account:`), never one the portal made. The skip says "A person closed the lead".
- **A lead whose own Keep going policy program is paused**, or any lead while Keep going is paused for all. Keep going's rows are read;
  nothing is written to them.
- Each of these skips is recorded (`flow.skipped`, the card), once per lead and condition per window. As a QA-ASK target, such a lead is
  passed over for the next peer.
- **Program holds.** The setting `flow.paused` (program names, comma separated, or `*`), Keep going paused for all, or Keep going paused
  for a program with the same name, holds the program. It is still counted (the card shows "Paused · name") but nothing is sent, reported
  or notified. Turning a program off (`|off`) stops even the counting.

## Live refresh

After every round the watchdog publishes the live topic `keepgoing` (the same watchdog family; no new topic). The card reloads on
`keepgoing` and `tickets`.

## Known gaps

- "Merged" is read as "no longer in review". The portal does not read the integration branch.
