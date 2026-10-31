# orchestrator status (2026-10-31 09:30 UTC, session cce0f6be; older entries: git history)
## DONE
- T-2997 (PILOT-1025) and T-3225 (PILOT-1117) released: deploy #613 (rmvw1zfv0e2e698) passed on fc7b77eb, portal 2026.10.31-3 (not started by this chat).
- T-3114 released in #606 (a8c7384e), live-checked; ready to close (blocked by T-3220).

## IN FLIGHT (all wait on a blind review from another unit)
- T-3206 (PILOT-1109) refusal fold follow-ups: dfa82cb9, self-test claudepilot-job-f1e83470 pass 40; REVIEW-ASK c50404.
- T-3233 (PILOT-1119) pass ignores a Bash description: 0d1bbd66 (on T-3206), self-test claudepilot-job-d9b2054d pass 111; REVIEW-ASK c50432; merge also held for the coordinator's wall answer.
- T-3215 (PILOT-1112, owner top item) spawn stuck starting: 60 s wait at 490f66e3 (red claudepilot-job-42632e48, self-test claudepilot-job-1e16aa78 pass 11, REVIEW-ASK c50601). Never-default (folds PILOT-1025) built in this chat (main, Opus) on ticket/T-3215-spawn-stuck-starting: test 79395d77, fix da1240e2; first red Job never scheduled (cluster full 900 s), red + self-test + typecheck re-queued 09:30; status c50641.
- T-3222 + T-3207 (PILOT-1116/1110) queued worker shows planned mode, stale-row test, PRD: b95ea140 (on T-3215), self-test claudepilot-job-ce549d7b + claudepilot-job-605a1c00; REVIEW-ASK c50520.
- T-3220 (PILOT-1115) keep-going heir for tickets: 180cc150; REVIEW-ASK c50398.

## DECISIONS
- 06:05 the predecessor 4ee04b70's tickets fell back by title to b3fead22; adopt refused (live). Filed T-3220; progress goes on T-3220.
- 06:22 no deploy started by this chat: releases go to production with approval auto (T-2893, T-3004); deploys are the coordinator's.
- 06:45 T-3206 prunes repeats in the sweep (15 min after the card ends), not at decision (c50385).
- 07:07 T-3233 touches the guard's pass hash (ruleGuard.ts): merge waits for review AND the coordinator's wall confirmation (c50432).
- 07:38 T-3222 option (A), display only; planned mode never read by a permission check (c50492).
- Model: all builders Opus sub-agents (T-3206 CP-B3206, T-3233 CP-B3233, T-3222/3207 CP-B3222); T-3225 sonnet.

## FOR THE COORDINATOR
- Relay REVIEW-ASKs to T-84: T-3206, T-3233, T-3215, T-3222/3207, T-3220, and the predecessor's T-3173, T-2966/2967 (own lineage, I may not review them).
- T-3233: confirm ruleGuard.ts passOfCall is crew-changeable, or needs a person.
- T-3225: run publish.mjs --only=skills,persona --apply from fc7b77eb or later.
- Move b3fead22's tickets from 4ee04b70 to cce0f6be (adopt CONFLICT again 08:45), or end b3fead22; close T-2997 on deploy #613.
- kohi-event running-agents cap (18/18 at 06:01): free idle sessions so Konfersi Business workers can start (c50593).
- T-3244: PILOT-HEALTH nudge names epics with no open slice.

## NEEDS A HUMAN
- none

## NEXT
- Merge order on review passes: T-3215 (490f66e3) -> T-3222/3207 (merge up onto it); T-3206 -> T-3233; T-3220. Then the open PILOT queue (rest is walls or watchdog).
