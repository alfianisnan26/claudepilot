# orchestrator status (2026-10-31 11:32 UTC, session cce0f6be; older entries: git history)
## DONE
- T-2997 (PILOT-1025) and T-3225 (PILOT-1117) released: deploy #613 (rmvw1zfv0e2e698) passed on fc7b77eb, portal 2026.10.31-3 (not started by this chat).
- T-3114 released in #606 (a8c7384e), live-checked; ready to close (blocked by T-3220).

## IN FLIGHT (blind reviews routed by the operator: Metocean T-3215, T-3222; General T-3206, T-3233, T-3220)
- T-3206 (PILOT-1109) refusal fold follow-ups: dfa82cb9, self-test claudepilot-job-f1e83470 pass 40; REVIEW-ASK c50404.
- T-3233 (PILOT-1119) pass ignores a Bash description: 0d1bbd66 (on T-3206), self-test claudepilot-job-d9b2054d pass 111; REVIEW-ASK c50432; operator: not a wall, merge on the blind review (General).
- T-3215 (PILOT-1112, owner top item) on ticket/T-3215-spawn-stuck-starting 6d4dfe85 (main, Opus): 60 s wait + mode order Bypass > Auto > end (no dontAsk fallback, operator owner-rule check). Red claudepilot-job-19529830 on c418e6f4; Self-test: claudepilot-job-70d4d6c9 on 6d4dfe85 pass 44 + typecheck; REVIEW-ASK c50783 on T-3222 (operator routes).
- T-3222 + T-3207 (PILOT-1116/1110) queued worker shows planned mode, stale-row test, PRD: b95ea140 (on T-3215), self-test claudepilot-job-ce549d7b + claudepilot-job-605a1c00; REVIEW-ASK c50520; review PASS on b95ea140 (c50848), merge held: conflicts with T-3215 6d4dfe85 in portalTools.ts, merge-up after T-3215 + delta re-review (c50904).
- T-3220 (PILOT-1115) keep-going heir for tickets: 180cc150; REVIEW-ASK c50398.

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
