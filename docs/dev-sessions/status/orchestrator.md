# Orchestrator status (2026-10-13, session 5c9fcb5f, started 15:4x after the integrity ending of fdb140be: a sub-agent's SendMessage to main, origin peer, T-136)

Knowledge: vault "ClaudePilot dev" (6cd11f710cc3), folder Dev loop/. The queue lives in NEXT; tickets are claimed only when work starts.
Models: opus for implementation, sonnet for checks, fable for diagnosis.

## LIVE
- Portal 2026.10.13-5 (deploy run 17, released 13:4x; gate green in 282 s at dca2a99 with /tmp in memory, was 31+ min). Live: T-24, T-28, T-32 part 2,
  T-42 slices 1-2 (the workspace is labelled isnan-pod, stable id ws_7fea17373588, runtime ws-kohi-event kept), T-95 items 1-3, plus everything of -4.

## DONE (earlier sessions; details in git log and the tickets)
- On integration: T-32 part 2, T-42 slices 1-2, T-95 items 1-3, T-97, T-98, T-99, T-107 (5b3cdda), T-105 merge df69d9c, deny rules (eeee2c5).

## IN FLIGHT (three sub-agents, opus, restarted 15:5x by 5c9fcb5f from the pushed branches; ticket comments may fail: T-131)
- t105 (opus): dev-automove-model, dev/t105-automove-proven. T-105 items 1, 2, 5 and the PRD are done. T-109 WIP is saved as 8cc8265
  (model catalogue, migration 761 original_model). Left: make it compile, T-109 a-h, the area tests, the merge of integration.
- t100 (opus): dev-automove-web, dev/t100-sessions-list (2c69a31). Left: the clipped card and the attention order, harness checks,
  the browser look, the PRD.
- t102 (opus): dev-track-a-connect, dev/t102-session-screen (4817c7f, which drops the SS_DEBUG line). Items 1-2 are checked (940/940).
  Left: item 3 (header band and badge), the headerBand check, scroll-lock, mobile-drag, the PRD, the merge.
- T-107: merged as 5b3cdda (in review). T-118: stopped, WIP 7b02a4e on dev/t118-login (after T-104). T-99: on integration, live with the next deploy.
- T-97 fitOf and T-98 fit.ts are still not unified (a small follow-up slice).

## NEXT (coordinator gap review 15:0x: WIP limit THREE slices, thin first slices, each merged AND deployed before the next starts)
Read before planning: docs/dev-sessions/CHARTER.md and docs/dev-sessions/DECISIONS.md (D-1..D-22; never act against a row, say so on a ticket).
1. T-105 + T-109 (running, one slice): auto move waits, resumes, fits the model (D-12).
2. T-136 (rank-02a): recover an integrity ending in place; first free slot after the running three.
3. T-99 (on integration), T-102 (running), T-100 (WIP pushed; next free slot).
   T-125 (rank-05d, same screen as T-102: the stack above the composer shows only THIS chat; Show more in place; shortcuts that say where)
   follows T-102 in its worktree; ship the compact contextual row first, the pace line after T-122.
   T-127 (portal WIP limit, rank-05e) and T-128 (CI read scope, rank-05f) after T-125.
   -> deploy (gate Job, /deploy pipeline; the coordinator approves as delegate, D-2).
4. T-115 slice 1: the decisions registry (imports DECISIONS.md) and session_context.
5. T-104 Keep going with T-108's watchdog sweep (then the path allow-list and the lease).
5b. T-118 multi-user MU1-min (rank-06b; WIP 7b02a4e).
6. T-110 deploy rule, dry mode first.
6b. T-119 slice 1 (rank-09a): the pure `ticketFlow` module (status events to spans and markers), GET /api/tickets/timeline, the MCP tool
   ticket_timeline, AND the performance bars (owner, end of the ticket): a derived `ticket_spans` table kept incrementally (node:sqlite is
   synchronous: a slow read stalls every chat stream), a window-by-scale guard, p95/p99 budgets as gate-failing tests, EXPLAIN QUERY PLAN
   tests, an event-loop-lag probe, a load test with chats streaming, parameter fuzz, a scratch-only seed (5,000 tickets, 150,000 events).
   No chart code before the API, table and budgets pass. Then the canvas chart (virtualised rows, tools/qa/gantt-perf.mjs at 4x CPU throttle,
   numbers on the ticket), then the metrics strip.
7. T-111 slices 1-2 (measuring; quality and human touch before tokens), then slice 2b: a structured estimate (effort class, severity, hours,
   risk flags, expected blockers) required to claim a ticket; 'predictability' is a scored term (charter now has eight terms, D-24).
---- CUT LINE: nothing below starts before 7 is merged and deployed ----
In rank order (details on each ticket): T-126 (item 5 local time first), T-129 (with T-122, before T-111), T-121 (after T-119 slice 1),
T-122 (after T-121: audit with screenshots first), T-113, T-114, T-101, T-106, T-120 (after T-106; ClaudePilot only, D-25), T-28, T-32, T-24,
T-26/T-27 (folded into T-134), T-30, T-33, T-123, T-132..T-135, T-137 by their rank tags (wave 3, motion), wave 4, T-130, T-131, and the fitOf/fit.ts unification (small; fills an idle slot).
T-117: owner step (rotate the sign-in code). Agents never read /proc/*/environ, never use that code, and tell the coordinator if they see it.

## NEEDS A HUMAN (only what a person can do; rewritten 14:3x from the tickets, after the owner's note)
- T-131: reassign T-100, T-102, T-105, T-109 (and the in_review T-24, T-32, T-42, T-95, T-97, T-98, T-99, T-107) from the ended fdb140be
  to 5c9fcb5f. The portal refuses a takeover (FORBIDDEN), so this session cannot comment on or close them.
- Deploy run 18 (e327e6d, full gate, includes 23384af) waits for release: integration is NOT pushed until it is released (coordinator).
- On the iPhone (installed PWA, 390 px, light and dark), check what is live in 2026.10.13-5: T-1 Pinned and swipe (right = Pin, left = Archive);
  T-2 no sideways scroll on any page; T-3 an image attaches and uploads in this Kubernetes workspace; T-5 sub-agents in their own rows, "Working ·
  N agents", "Session finished" only at real idle; T-24 tool rows open to Input and Output blocks with real line breaks and shell colouring, the
  approval card the same; T-25 Mute similar on a notification; T-28 Bump on a ticket pushes it into a running session (priority or question);
  T-32 Bump on a CI run (Fix or Ask) and the auto-report of a finished run to the session that started it; T-34 the Home page as the first page;
  T-42 the workspace sheet shows the label isnan-pod with the id next to it, every old link and MCP call by kubernetes/kohi-event still works;
  T-99 this chat survives a finished sub-agent (no "Ended for integrity"), and CI works within a minute of a pod restart.
- Open questions parked on tickets: T-97 (NetworkPolicy not enforced on the cluster; the browser image tag and the pool assignment after the
  next deploy), T-95 item 4 (close if the run summary already reports flaky-passed-alone), T-42 slice 4 (needs its own ticket number).

## DECISIONS
- 15:5x (5c9fcb5f) The restart left no unmerged work behind: all three branches were pushed. The uncommitted T-109 work (330 lines) and
  the T-102 one-line edit are saved as WIP commits. Same three slices resumed with the same models. Filed T-130 (peer ending) and T-131 (takeover).
  Coordinator 16:0x: the cause was a sub-agent's SendMessage to main (T-136, urgent rank-02a). No sub-agent calls SendMessage (README 7); the
  three running ones were told; T-130 corrected. New owner tickets T-132..T-137 queue behind the earlier ranks (WIP three stands).
- Binding, kept from earlier entries (the full log is in git history of this file):
  - Before a merge, run the touched AREAS' tests (src/qa, src/workspaces, the module's neighbours), not only the slice's own files (13:25).
  - The gate fails a hung test after GATE_TEST_TIMEOUT_MS and reruns failing files alone. Status-only commits are pushed without a gate.
    Merge commits are kept.
  - Commits carry Ticket, Pilot-Session and Pilot-Agent (CHARTER). An unpushed merge for a gate Job goes to a fresh wip/orch-<sha>, never -f.
  - Claim a ticket only when work starts; the queue lives in this file (15:4x loop audit). WIP limit three.
  - Never print the environment in any form (T-124); every sub-agent brief says so.
  - Migration blocks: T-42 710-715, T-98 716-717, B 720-729, C 730-734, T-97 735-736, T-26/27 740-744, T-30 745-749, T-101 750-754,
    T-105 760, T-109 761.
  - Quota: keep turns short (background waits) so auto move sees turn boundaries (T-105 G2).
