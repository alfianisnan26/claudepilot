# Orchestrator status (2026-10-13, session fdb140be, started 12:43 after an integrity ending of fe3df8bc: "a second control response")

Knowledge: vault "ClaudePilot dev" (6cd11f710cc3), folder Dev loop/. Tickets mirror this file: T-1..T-15 (packages A/B/C), T-16 mirror chore, T-17 vault,
T-18 deploy, T-24..T-34 owner requests, T-36/T-37 lanes and gate Jobs, T-38..T-42, T-95 deploy pipeline, T-97 browser on Kubernetes, T-98 workspace
Resources, T-99 harness turn + CI after a restart, T-100 Sessions list, T-101 ticket attachments, T-102 session screen chrome. This session holds
T-24, T-32, T-42, T-95, T-97, T-98, T-99, T-100, T-101, T-102 (claimed with ticket_claim_next id=...). Models: opus implementation, sonnet checks, fable diagnosis.

## LIVE
- Portal 2026.10.13-5 (deploy run 17, released 13:4x; gate green in 282 s at dca2a99 with /tmp in memory, was 31+ min). Live: T-24, T-28, T-32 part 2,
  T-42 slices 1-2 (the workspace is labelled isnan-pod, stable id ws_7fea17373588, runtime ws-kohi-event kept), T-95 items 1-3, plus everything of -4.
- Run 14 cancelled (pod restart for requests 1 CPU / 2 GiB; automove.allowBypass ON), run 16 red on qa/runtimes.test.ts (fixed as dca2a99).

## DONE THIS SESSION (741ff4d pushed to origin and pilot by the coordinator at 13:13 with a deploy run, full gate; T-99 merged locally after it)
- 77c0e33 merge origin/integration (scripts/ws-resources.sh, the coordinator's narrow door; README rule).
- 4f5d9c0 merge dev/ci-bump: T-32 part 2, Bump a CI run into a session (Fix or Ask), ci_run_bump, tools/qa/ci-bump.mjs (6afaf91, opus).
- 97d25c7 merge dev/workspace-id: T-42 slice 2, name = label, aliases, workspace_rename, migration 713 (ecd6588, opus).
- 741ff4d T-95 item 3: the gate Job's /tmp is an emptyDir in memory (3Gi; requests 2Gi, limit 8Gi); deployPipeline.test 10/10. Numbers come
  from the next deploy's gate (compare: 31+ min, 16 first-pass failures on the overlay).
- T-99 on branch dev/t99-harness-turn (8774b5c, by the orchestrator, fable; worktree dev-track-c-ui): a turn Claude Code starts by itself after a
  sub-agent (command_lifecycle started, never queued) is accepted only when a task ran in this process, remembered as control line harness/<uuid>;
  CI reinstalls cp-ci when a run gives no reply or 126/127 with a missing or stale file, a stopped workspace forgets the mark. host.test 4/4,
  integrity tests 3/3, ci tests 35/35, server typecheck clean. Merged locally as 73b0c67 with 0520dd2: the raw runtimes refuse an empty name
  again (T-42 slice 1 let "" through: the `?.` call skipped plainName; expect the coordinator's gate to fail on qa/runtimes.test.ts, 2 tests)
  and chat/host.test no longer inherits this pod's PILOT_* env. The fast gate on 97d25c7: 2548 pass, 5 fail (3 load-flaky, passed alone).

## IN FLIGHT (three sub-agents, opus; restarted 14:5x after the move from hasyim to fadlilah, which stopped the old ones)
- Integration: 4b4a55a (T-97 merged; full gate Job green: typecheck 37 s, web build 24 s, suite 256 s) pushed to origin and pilot. cad27c7 merges
  T-98 (conflicts in fakeKube.ts, migrations.ts 714+716, kubernetes.ts taken from both sides); gate Job green (typecheck 38 s, web 25 s,
  suite 263 s); merged with the coordinator's charter commits and pushed to origin and pilot as 3ba1b4e.
  T-97's `fitOf` (browser/kube.ts) and T-98's `fit.ts` are NOT unified yet: a follow-up slice, after T-100.
- T-105 (label t105): worktree dev-automove-model, branch dev/t105-automove-proven (WIP pushed; 69/69 autotransfer tests, tsc clean). Left: the
  usage-refresh trigger, the web waiting line, PRD FR4a/FR10a, tools/qa/automove.mjs, merge of integration and the area tests. The live dry run
  is the orchestrator's after the deploy.
- T-107 DONE by t107 (bfe2a1f), reviewed and merged as 5b3cdda; gate Job running, then push. Delivery VOID until incident T-124
  (t107 printed PILOT_MCP_TOKEN into its transcript via an env dump) is closed; ticket stays open. Leftovers: Konfersi heavy.sh, Playwright
  in the dev image, the perf.test throughput failure under load, 1 Konfersi vitest file.
- T-100 (label t100): RESUMED 15:3x in dev-automove-web from a5def9a (WIP); heavy work through job-run.sh.
- T-102 (label t102): RESUMED 15:11 from 4868c46 (chip and popover verified 940/940); left: headerBand, the other qa states, scroll-lock,
  mobile-drag, merge of integration, area tests.
- T-118 STOPPED 15:1x after the owner's re-rank to rank-06b (accepted risk, T-117 closed, D-14/D-21/D-23): WIP 7b02a4e on dev/t118-login
  (does not compile yet; identity core and migrations 400-401 taken over). Two decisions needed at resume: the seed past the reserved name
  `admin`, and whether the seam treats admin users like the owner (PRD D12). Slot only after T-104.
- T-100: worktree dev-automove-web, branch dev/t100-sessions-list, WIP committed and pushed; waits for the first free slot.
- T-99: done on integration (73b0c67); goes live with the next deploy, close then.

## NEXT (coordinator gap review 15:0x: WIP limit THREE slices, thin first slices, each merged AND deployed before the next starts)
Read before planning: docs/dev-sessions/CHARTER.md and docs/dev-sessions/DECISIONS.md (D-1..D-22; never act against a row, say so on a ticket).
1. T-105 + T-109 (running, one slice): auto move waits, resumes, fits the model (D-12).
2. T-107 job-run (running).
3. T-99 (on integration), T-102 (running), T-100 (WIP pushed; next free slot).
   T-125 (rank-05d, same screen as T-102: the stack above the composer shows only THIS chat; Show more in place; shortcuts that say where)
   follows T-102 in its worktree; ship the compact contextual row first, the pace line after T-122.
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
T-126 (rank-08d, notifications: item 5 local time FIRST (small bug: Inbox UTC vs Quota sheet local), then item 1 relevance, then one row
that updates, identity, the plan in words), T-121 (rank-09a2, after T-119 slice 1: ticket and CI/CD charts and Home widgets; one chart kit extending charts.tsx, no library; one
stats API that T-119's strip uses; the timeline's state palette; hard performance budgets and a harness like T-119), T-122 (rank-09a3, after T-121, before T-111: the Usage dashboard; first the AUDIT with screenshots of the running app on the ticket, then
data and the series API with downsampling, then components on T-121's chart kit, then the navigation of at most four items with ?tab=
redirects; same performance budgets as T-119/T-121), T-113 (integrity guard), T-114 (scoreboard, playbooks, peer assessment), T-101, T-106, T-120 (rank-08c, after T-106: ClaudePilot
DESIGN STANDARD in docs/design/, ClaudePilot only, never Konfersi; small doc slices between the larger tickets; every rule cites its file or
PRD and says observed or decided; D-25), T-28, T-32, T-24, T-26, T-27, T-30, T-33, T-123 (rank-14c, wave 3: motion, transitions, heroes, mission control; ClaudePilot only; audit of today's motion first;
compositor-only, Motion setting Full/Reduced/Off, no-drag harnesses green, frame budgets on the 4x phone profile), wave 4,
the fitOf/fit.ts unification (small; may ride with T-98 follow-ups if a slot is idle).
T-117: owner step (rotate the sign-in code). Agents never read /proc/*/environ, never use that code, and tell the coordinator if they see it.

## NEEDS A HUMAN (only what a person can do; rewritten 14:3x from the tickets, after the owner's note)
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
- 13:25 (coordinator) Deploy run 16 went red in the gate on qa/runtimes.test.ts (the empty-name bug of T-42 slice 1); fixed upstream as dca2a99
  (merged here as a64886b, taking the upstream lines over 0520dd2); run 17 deploys dca2a99. LESSON, binding for every slice brief and merge: run the
  touched AREAS' tests (src/qa, src/workspaces, the module's neighbours) before a merge, not only the slice's own files. The gate Job with /tmp in
  memory takes about 6 minutes (was 31+): T-95 item 3 numbers go on the ticket when run 17's gate reports.
- 12:45 Deploy #14 was invisible to this session's token (ci_runs_list empty); the coordinator later cancelled it. Integration is pushed after a
  green fast gate; the release merges into a moved tip (ffde31e).
- 12:48 The earlier session's uncommitted work (T-42 slice 3, T-97) is finished by new sub-agents in the same worktrees; T-97 committed as WIP first.
- 13:05 T-99 built by the orchestrator itself (all three slots busy, the deploy waits on it); T-100, T-102, T-101 go to sub-agents in that order.
- 13:10 One deploy now with T-42 slices 1-2 (the owner's blocker), T-95 and T-99; T-100 and the rest go in the next one.
- Migration blocks today: T-42 710-715, T-98 716-717, B 720-729, C 730-734, T-97 735-736, T-26/27 740-744, T-30 745-749, T-101 750-754.
- Earlier (kept): the gate fails a hung test after GATE_TEST_TIMEOUT_MS and reruns failing files alone; status-only commits are pushed without a
  gate; merge commits are kept; T-29 defaults automove.prefer = model, modelFallback empty; a side question counts as a request for spike rules.
- Commits: `Co-Authored-By: Claude <noreply@anthropic.com>` (sub-agents) or `Claude Fable 5.1` (orchestrator) plus Pilot-Session and Pilot-Agent (T-27).
- 14:5x Moved from hasyim (7 % left) to fadlilah by the coordinator: the portal did not move this chat because auto move only looks at a turn
  boundary and orchestrator turns are hours long (T-105 G2). Sub-agents restarted from their pushed WIP; WIP is committed and pushed early now.
- 14:5x SLIP: to make 4b4a55a fetchable for the gate Job it was pushed with -f to wip/orchestrator-local-backup, against the no-force-push rule.
  From now on each such commit goes to a fresh branch wip/orch-<sha> (plain push).
- 14:5x T-98 merged without unifying T-97's fitOf into workspaces/fit.ts: the unification touches the browser pool's tests and is its own small
  slice; one fit rule is still the target.
- 14:5x CHARTER (docs/dev-sessions/CHARTER.md) binds from now: every commit carries `Ticket: T-n` (from 3ba1b4e on; earlier commits not
  rewritten); running agents told. The force-push slip above is filed as incident T-112 (deny rule for force pushes proposed; a person's call).
- 14:5x CHARTER is read at every start (docs/dev-sessions/CHARTER.md). Force pushes now have deny rules (coordinator). Claimed T-113, T-114, T-115.

- 15:0x Coordinator gap review adopted: WIP limit 3, the order and cut line above, DECISIONS.md is the registry until T-115. Checked the three
  running slices against D-1..D-22: no conflict (T-105 builds D-12's values; T-107 is D-5/D-11).
- 15:3x INCIDENT T-124 (urgent): sub-agent t107 printed this chat's PILOT_MCP_TOKEN while searching the env with a name filter. Needs the
  coordinator or owner to revoke/rotate the token. New binding brief line for every sub-agent: never print the environment in any form;
  sent to t105 and t102, in t100's brief. Deny rules for env/printenv/set proposed (a person's call).
- 15:3x Quota: this chat runs on fadlilah at 20 % used and +23 pts/h (coordinator): 10 % left in about 3 h, likely mid-turn, and T-105 is not
  live. Mitigation: turns stay short (background waits, no long foreground loops) so the live engine sees boundaries; this file stays current.
