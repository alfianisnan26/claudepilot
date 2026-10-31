# orchestrator status (2026-10-31 06:47 UTC, session cce0f6be; older entries: git history)
## DONE
- T-2997 (PILOT-1025) batch merged: integration 1fda7407, full gate green (claudepilot-gate-1fda740-a568). NOT deployed.
- T-3225 (PILOT-1117) kit rule "adjust first" merged: integration 2e384c86, light gate green (claudepilot-gate-2e384c8-7ab3).
- T-3114 released in #606 (a8c7384e), live-checked; ready to close (blocked by T-3220).

## IN FLIGHT (all wait on a blind review from another unit)
- T-3206 (PILOT-1109) refusal fold follow-ups: dfa82cb9, self-test claudepilot-job-f1e83470 pass 40, typecheck claudepilot-job-7b4c8898; REVIEW-ASK c50404. Built by CP-B3206 (Opus sub-agent).
- T-3220 (PILOT-1115) keep-going heir for tickets: 180cc150; REVIEW-ASK c50398.
- T-3215 (PILOT-1112) spawn stuck starting: 591fcd34, self-test claudepilot-job-6b856e90 pass 48.

## DECISIONS
- 06:05 the predecessor 4ee04b70's 37 tickets fell back by title to b3fead22; adopt refused (live). Filed T-3220; progress goes on T-3220.
- 06:22 no deploy started by this chat: releases go to production with approval auto (T-2893, T-3004); deploy 2 is for the coordinator.
- 06:18 kit text is drafted here; landing and publish.mjs are the coordinator's (persona wall, credential).
- 06:45 T-3206 prunes repeats in the sweep (15 min after the card ends), not at decision, so the decision's repeat id stays readable (c50385).
- Model: T-3225 sonnet sub-agent; T-3215 and T-3220 Opus worker; T-3206 Opus sub-agent.

## FOR THE COORDINATOR
- T-3220: move b3fead22's tickets from 4ee04b70 to cce0f6be; relay REVIEW-ASK (T-3206, T-3220, T-3215, T-3173, T-2966/2967) to T-84; copy the PILOT-1025 evidence (c50329, c50334).
- T-3225: run publish.mjs --only=skills,persona --apply from 2e384c86.
- Deploy 2 (integration 12e8a6ce: T-2997 + T-3225), then a live spawn check.

## NEEDS A HUMAN
- none

## NEXT
- Reviews pass -> merge with gate: T-3206, T-3215, T-3220. Then T-3233 (PILOT-1119, pass ignores description, risk-high), T-3222 (normal).
