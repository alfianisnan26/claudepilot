# orchestrator status (2026-10-31 11:50 UTC, session cce0f6be; older entries: git history)
## DONE
- T-2997 (PILOT-1025) and T-3225 (PILOT-1117) released: deploy #613 (rmvw1zfv0e2e698) passed on fc7b77eb, portal 2026.10.31-3 (not started by this chat).
- 11:45 merged batch 2 (c50943): T-965, T-2950, T-2167+2421, T-3004, T-2989, T-3173, T-3192, T-3198 (mig 797) -> fe879723.
- 11:42 merged to integration on blind PASS (relay 11:41): T-3215 6d4dfe85 (merge-up 1f5cddb6), T-3206+T-3233 dfa82cb9+0d1bbd66 (a9d88eaa), T-3220 180cc150 (b052a836); c50941. Not deployed yet.
- T-3114 released in #606 (a8c7384e), live-checked; ready to close (blocked by T-3220).

## IN FLIGHT
- Gate: gate-job.sh fe879723 (background, before any deploy).
- Merge-ups after integration moved: CP-MU-PRD (sonnet) T-2882 bundle + T-2945/3070 (PRD-only conflicts); CP-B1261m (opus) T-1261 (repos/portalTools.ts); CP-B3115 (opus) T-3115 FAIL fix (job-run.sh reuse key). Each new head: delta re-review.
- T-294: PASS on 71fe212c is stale (tip d5e8b10b, 3 web commits): delta review needed on d5e8b10b.
- T-3222 + T-3207 (PILOT-1116/1110) queued worker shows planned mode, stale-row test, PRD: b95ea140 (on T-3215), self-test claudepilot-job-ce549d7b + claudepilot-job-605a1c00; REVIEW-ASK c50520; review PASS on b95ea140 (c50848), merge held: conflicts with T-3215 6d4dfe85 in portalTools.ts, builder CP-B3222m (Opus, sub-agent) resolving the merge-up now; then self-test + delta re-review (c50904).

## DECISIONS
- 06:05 the predecessor 4ee04b70's tickets fell back by title to b3fead22; adopt refused (live). Filed T-3220; progress goes on T-3220.
- 06:22 no deploy started by this chat: releases go to production with approval auto (T-2893, T-3004); deploys are the coordinator's.
- 06:45 T-3206 prunes repeats in the sweep (15 min after the card ends), not at decision (c50385).
- 11:31 T-3222 PASS held for T-3215 first (option A, c50904): either order forces one re-review, keep it off the owner item.
- 11:00 T-3233 ruleGuard.ts pass hash: operator confirmed not a wall; merge on the blind review alone.
- 07:38 T-3222 option (A), display only; planned mode never read by a permission check (c50492).
- Model: all builders Opus sub-agents (T-3206 CP-B3206, T-3233 CP-B3233, T-3222/3207 CP-B3222); T-3225 sonnet.

## FOR THE COORDINATOR
- Relay REVIEW-ASKs to T-84: T-3206, T-3233, T-3215, T-3222/3207, T-3220, and the predecessor's T-3173, T-2966/2967 (own lineage, I may not review them).
- T-3225: already merged and on main (fc7b77eb, deploy #613); run publish.mjs --only=skills,persona --apply from fc7b77eb or later now.
- Move b3fead22's tickets from 4ee04b70 to cce0f6be (adopt CONFLICT again 08:45), or end b3fead22; close T-2997 on deploy #613.
- kohi-event running-agents cap (18/18 at 06:01): free idle sessions so Konfersi Business workers can start (c50593).
- T-3244: PILOT-HEALTH nudge names epics with no open slice.

## NEEDS A HUMAN
- none

## NEXT
- Merge order on review passes: T-3215 (6d4dfe85) -> T-3222/3207 (merge up onto it); T-3206 -> T-3233; T-3220. Then the open PILOT queue (rest is walls or watchdog).
