# orchestrator status (2026-10-31 06:25 UTC, session cce0f6be; older entries: git history)
## DONE
- T-2997 (PILOT-1025) batch merged: integration 1fda7407, full gate green (claudepilot-gate-1fda740-a568). NOT deployed.
- T-3225 (PILOT-1117) kit rule "adjust first" merged: integration 2e384c86, light gate green (claudepilot-gate-2e384c8-7ab3).
- T-3114 released in #606 (a8c7384e), live-checked; ready to close (blocked by T-3220).

## IN FLIGHT
- T-3220 (PILOT-1115) keep-going heir for tickets: builder CP-B3215 (7424976b, Opus), branch ticket/T-3220-keepgoing-heir.
- T-3215 (PILOT-1112) spawn stuck starting: 591fcd34 self-test claudepilot-job-6b856e90 pass 48; waits for a blind review from another unit.

## DECISIONS
- 06:05 the predecessor 4ee04b70's 37 tickets fell back by title to b3fead22; adopt refused (live). Filed T-3220; progress goes on T-3220.
- 06:22 no deploy started by this chat: releases go to production with approval auto (T-2893, T-3004); deploy 2 is for the coordinator.
- 06:18 kit text is drafted here; landing and publish.mjs are the coordinator's (persona wall, credential).
- Model: T-3225 sonnet sub-agent; T-3215 and T-3220 Opus worker.

## FOR THE COORDINATOR
- T-3220: move b3fead22's tickets from 4ee04b70 to cce0f6be; relay REVIEW-ASK (T-3173, T-2966/2967, T-3215) to T-84; copy the PILOT-1025 evidence (c50329, c50334).
- T-3225: run publish.mjs --only=skills,persona --apply from 2e384c86.
- Deploy 2 (integration 2e384c86: T-2997 + T-3225), then a live spawn check.

## NEEDS A HUMAN
- none

## NEXT
- T-3215 review -> merge -> close; T-3220 self-test -> blind review -> merge; T-3173 review; T-3222 (normal).
