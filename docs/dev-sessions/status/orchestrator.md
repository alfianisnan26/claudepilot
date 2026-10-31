# orchestrator status (2026-10-31 12:30 UTC, session cce0f6be; older entries: git history)
## DONE
- T-2997 (PILOT-1025) and T-3225 (PILOT-1117) released: deploy #613 (rmvw1zfv0e2e698) passed on fc7b77eb, portal 2026.10.31-3 (not started by this chat).
- 12:00 T-1261 merged at 719df382 (merge-up by CP-B1261m, opus; Self-test: claudepilot-job-5cc4010e on 719df3821ce15df3758fc47fdaa1fb7da14f837e pass 12; resolved authz hunk read by me: integration lines kept, only parent added).
- 11:45 merged batch 2 (c50943): T-965, T-2950, T-2167+2421, T-3004, T-2989, T-3173, T-3192, T-3198 (mig 797) -> fe879723.
- 11:42 merged on blind PASS (relay 11:41): T-3215 6d4dfe85 (1f5cddb6), T-3206+T-3233 dfa82cb9+0d1bbd66 (a9d88eaa), T-3220 180cc150 (b052a836); c50941. Not deployed yet.
- T-3114 released in #606 (a8c7384e), live-checked; ready to close (blocked by T-3220).

## IN FLIGHT
- INCIDENT (open the ticket, tag incident, when the pilot MCP is back): full gate RED on integration fe879723 (claudepilot-gate-fe87972-da4f, server-suite 4803/4833 pass, 1 fail; typecheck, web-build, web-tests rc 0). qa/workspacepaths.test.ts:107: the new POST /api/schedules/heartbeat (T-965, merged by me in batch 2) answers 400, not the shared 422 hostile-workspace-id check, for hostile ids in the body. Cause: T-965's self-test ran its own tests, not the cross-route qa/workspacepaths suite, and batch 2 merged 9 branches with no merged-head suite before the push. Fix: CP-FIX965 (opus), branch ticket/T-965-gate-fix, mounts refuseHostileIds on the heartbeat path. NO MERGE until the gate on the fix is green. Check that would have caught it: run qa/workspacepaths.test.ts in the self-test of any change that adds a route.
- T-2882 bundle 76dbbee8 and T-2945/3070 f4bb9119: PRD-only merge-ups (CP-MU-PRD, sonnet) on the reviewed tips. Merge after one self-test Job each, after the gate (the bundle auto-merged worker-mode code with T-3215: the clash T-3222 hit).
- T-3222 + T-3207: merged up onto T-3215 by CP-B3222m (opus) at 1361ba10. First merged self-test claudepilot-job-ecf33d95 failed 45/46 (real clash: the test expected default after a refused Auto; T-3215 ends the worker); test fixed. Self-test: claudepilot-job-456326d4 on 1361ba10c17d06c83b3f2d2265761565bc52f2fc pass 46. Delta REVIEW-ASK c50981.
- T-3115 REVIEW-ASK (pilot MCP down since about 12:05; post on the ticket when back): finding answered as (a), the base already hashes job-run.sh into the reuse key (integration scripts/job-run.sh:421 hashes "$0", since 17873351; jobRun.test.ts:3460-3464 asserts a changed job-run.sh is a miss); no code change. Head 3cf6b2834c7f7dd125494c78eafe2f3e95c79df3 = merge of integration (jobRun.test.ts: both test blocks kept). Self-test: claudepilot-job-5382e9e8 on 3cf6b2834c7f7dd125494c78eafe2f3e95c79df3 pass 134, typecheck rc 0. Builder CP-B3115 (opus).
- T-294: PASS on 71fe212c is stale (tip d5e8b10b, 3 web commits): delta review needed on d5e8b10b.

## DECISIONS
- 06:05 the predecessor 4ee04b70's tickets fell back by title to b3fead22; adopt refused (live). Filed T-3220; progress goes on T-3220.
- 06:22 no deploy started by this chat: releases go to production with approval auto (T-2893, T-3004); deploys are the coordinator's.
- 12:00 a merge-up of integration into a reviewed head keeps its PASS when the hand-resolved part is docs only or takes integration's lines verbatim (read by me); a changed test or behaviour gets a delta review (T-3222).
- 11:31 T-3222 PASS held for T-3215 first (option A, c50904): keep the re-review off the owner item.
- 11:00 T-3233 ruleGuard.ts pass hash: operator confirmed not a wall; merged on the blind review.
- Model: builders Opus sub-agents (CP-B3222m, CP-B1261m, CP-B3115); PRD merge-ups and surveys Sonnet.

## FOR THE COORDINATOR
- Pilot MCP disconnected (ECONNREFUSED) at about 12:05: ticket posts are held in this file until it is back.
- Guard refuses git worktree add/remove on the main checkout: remove the leftover worktrees wip-cp-mu-prd-a, wip-cp-mu-prd-b (and branches wip/cp-mu-prd-A, -B) and ticket-t-1261-worktree-parent; briefs should name MCP worktree_create.
- Deploy: start it on the gated final head (or say "this chat deploys"); I post the run number and the live check.
- T-3225: run publish.mjs --only=skills,persona --apply from fc7b77eb or later (already on main).
- Move b3fead22's tickets from 4ee04b70 to cce0f6be, or end b3fead22; close T-2997 on deploy #613.
- T-3244: PILOT-HEALTH nudge names epics with no open slice.

## NEEDS A HUMAN
- none

## NEXT
- Gate result -> self-test Jobs for 76dbbee8 then f4bb9119 -> merge both -> gate on the final head -> deploy handover.
- On delta PASS: T-3222 (1361ba10), T-3115 (3cf6b283), T-294 (d5e8b10b).
