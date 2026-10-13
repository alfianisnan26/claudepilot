# Orchestrator status (2026-10-13, session 5c9fcb5f, started 15:4x after the integrity ending of fdb140be: a sub-agent's SendMessage to main, origin peer, T-136)

Knowledge: vault "ClaudePilot dev" (6cd11f710cc3), folder Dev loop/. The queue lives in NEXT; tickets are claimed only when work starts.
Models: opus for implementation, sonnet for checks, fable for diagnosis.

## LIVE
- Portal 2026.10.13-6 (run 18, e327e6d, gate 470 s green; released by the owner, verified by the coordinator).
  Live: T-24, T-28, T-32, T-42 slices 1-2, T-95 items 1-3, T-97, T-98, T-99, T-107, the env deny rules (eeee2c5).

## IN FLIGHT (17:3x: three slices, t105, t102 (running again), t110)
- t105 (opus): dev-automove-model, dev/t105-automove-proven. T-105 is done apart from the area tests. T-109 WIP is 8cc8265 (catalogue, migration 761).
- t102 (opus): dev-track-a-connect, be65ceb. Left: the session-states matrix (5714/5716) and mobile-drag again, web PRD 10.5. Then deploy.
- t110 (opus): dev-gate-job, dev/t110-autoapprove-dry. T-110 slice 1: PRD FR41/FR41a, autoApprove off|dry (manage only, audited,
  migrations 780-784), dry lines on held releases; it approves nothing.
- DEPLOY RUN 19 (17:30, 5234892, gate=true), waiting for approval. It carries:
  - T-143: c3575d8, independently reviewed; auth.test 10/10, and tests 8 and 10 fail on the old app.ts.
  - T-141: c3431fa; the proof build is in comment 809. The dev account is cluster-admin, already accepted.
  - T-136 slice 1: 62f5d5e. Migration 772 relinks today's chains and moves their tickets to 5c9fcb5f.
- T-159 (mine): scratch-portal.sh leaked the heavy lock (t105's portal held it for 50 min). The fix sits uncommitted until its test runs.
- PAUSED: t100 at cf86a26. Both items are built and checked (session-list 290/0, scroll-lock 26/26, mobile-drag 11/11, web 422/422;
  shots in ~/.claudepilot/dev-sessions/shots/t100-*). Left: a clean session-swipe run and a merge of integration. Resumes after T-110.

## NEXT (coordinator gap review 15:0x: WIP limit THREE slices, thin first slices, each merged AND deployed before the next starts)
Read CHARTER.md and DECISIONS.md (D-1..D-33) before planning; never act against a row.
1. T-105 + T-109 (running, one slice): auto move waits, resumes, fits the model (D-12).
2. T-143 (running; T-141 merged), T-136 slice 1 (running). T-102 is now urgent rank-02c: it resumes in the FIRST slot
   T-143 or T-141 frees (be65ceb; left: the session-states matrix, mobile-drag, web PRD 10.5), then it deploys with T-143. Then T-136 slice 2 (recover in place, plus the supervisor), after slice 1 is merged.
2b. T-110 slice 1 ONLY (urgent, rank-03c, D-2): the PRD FR41 amendment, the environment option `autoApprove` (off, set only by a person with
   manage), and DRY MODE: on every held release it writes 'WOULD approve: ...' or 'WOULD NOT: <condition>' to the run page and the audit, and
   approves nothing. The NEXT free slot. Slice 2 (real approval, pause, rollback pause) waits until the owner has read five dry lines.
3. T-100 (paused; WIP pushed).
   T-125 (rank-05d) follows T-102 in its worktree: the compact contextual row first, the pace line after T-122.
   T-127 (portal WIP limit, rank-05e) and T-128 (CI read scope, rank-05f) after T-125.
   -> deploy (/deploy pipeline with gate=true, D-7; the coordinator approves as delegate, D-2).
3c. A post-deploy check (sonnet, D-34) of what is live in 2026.10.13-6, in the pilot browser and the harnesses at 390 px, light and dark:
   T-1, T-2, T-3, T-5, T-24, T-25, T-28, T-32, T-34, T-42, T-99. Limits are stated on each ticket, never turned into an owner task.
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
T-26/T-27 (folded into T-134), T-30, T-33, T-123, T-118 (WIP 7b02a4e, after T-104), T-132..T-135 with T-140 (rank-07e, Claude accounts as pool entries, D-33: the spike first, one login per workspace by default, no login tool for
agents, credentials never read), T-137, then T-138 (rank-10a, Settings v2, D-32: audit first, agents read and propose only) (wave 3, motion), wave 4, T-130, T-131, and the fitOf/fit.ts unification (small; fills an idle slot).
T-117: owner step (rotate the sign-in code). Agents never read /proc/*/environ, never use that code, and tell the coordinator if they see it.

## NEEDS A HUMAN (required escalations only, D-10 and D-34)
- None open. If t141 finds that the image-build door needs a wider Role, the exact diff goes here and on T-141 (permissions).

## DECISIONS
- 16:5x D-34 adopted: the iPhone checklist leaves NEEDS A HUMAN and becomes item 3c (agents verify with evidence). T-131's reassignment is
  not a required escalation: T-136 slice 1's repair moves the chain's tickets to the head.
- 16:1x Run 18 released, so the held status commits are pushed. The three running slices are NOT preempted for T-136 or T-110: they are
  mid-slice with WIP pushed, and a restart costs more than the wait. The next two free slots go to T-136, then T-110 (rank order).
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
