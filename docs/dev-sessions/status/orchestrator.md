# orchestrator status (2026-10-15 01:40 UTC, session 83842ba6, continuation of a8393f6b)

Older log: `orchestrator-log-2026-10-14.md` (same folder). Previous hand-over: commit ab99b45.

## DONE
- LIVE portal 2026.10.15-1 (run 31 PASSED on 0831ba7; Argo c685eea): T-338, T-342, T-333, T-336, T-343, T-312, crew hand-over.
- integration ab99b45 (origin + pilot), NOT deployed: T-348, T-315 s1, T-330/T-331/T-272, job anti-affinity 96f47b8, D-55/D-56 docs. Full gate: gate-job 3278277 GREEN 02:1x (typecheck 48s, web build 27s, server suite 369s; /tmp/gate-job-3278277.log), includes the coordinator's T-365 WAL fix 3438d9b.
- 01:24 adopted T-366, T-369, T-321, T-349, T-352 (claimed by id; the ended lead's tickets had gone back to the queue).
- Ended workers: 7be4aeac (T-366 reviewer, verdict copied below), 2005bc7f (old T-321/T-312 verifier; T-312 already closed, UI part is T-354).

## IN FLIGHT
- T-366 (urgent): reviewer 7be4aeac = SAFE AFTER FIXES on d647d14. B1 runner deny-list -> vetted allow list; M1 any outside path broad; M2 skills/commands/agents frontmatter (stricter only); m1 help text. 01:55 Agent-tool SUB-AGENT implementer (opus) on dev/t-366-1 (ends with this chat; branch pushed is the resume point). Then a fresh reviewer.
- T-369 (urgent): implementer 151ab26d done at 731fa28 (web 575/575 job a4d4c68e, typecheck 8a1fd102). 01:55 Agent-tool SUB-AGENT ux-checker (sonnet) on 731fa28. Then T-375 to 151ab26d (needs the portal MCP to message it).
- T-349: implementer a893d274 on dev/t-349-1 b58d4b7, proof job 07f615ed (3 new tests fail on base). Lead read controller diff: live check repeated with no await before insert, OK. WAIT FOR: its typecheck + chat/portalmcp job (messaged 01:24), then a verifier worker.
- T-352: implementer 0571ff1c on dev/t-352-1 aa8b815. WAIT FOR: its ACTUAL (messaged 01:24), then a verifier.
- T-321: dev/t-321-2 74bbb76 (set A 15/15 on the fix, job 59b3c5d7). Left: set B (base under the same load) by a qa-verifier worker when a slot frees. T-369 sits on it: merge T-321 first.

## DECISIONS
- 01:50 Portal stalled 01:26-01:52 (readiness/liveness timeouts, T-365; coordinator pushed 3438d9b WAL fix to integration, not deployed). This chat's portal MCP did not reconnect: options (a) wait, (b) Agent-tool sub-agents (allowed by the org rules; D-49 does not forbid them). Took (b). Ticket comments and closes are queued here until the MCP is back; sub-agents report in their final message.
- 01:25 T-366: fix the review's B1/M1/M2/m1 BEFORE merge (a gate change; merging would ship weaker than D-55). M2 only in the stricter direction, so no owner decision. Reason on T-366 (comment pending, portal down).
- New slices only as session_spawn workers (D-49); at most five in flight (D-43). Quota 01:23: alfian.isnan session 1 %, projection 18 % (claude_usage).
- Deploy cap three a day; run 31 was the first of 2026-10-15. Next deploy needs images=portal,workspace once T-366 is in.

## NEEDS A HUMAN
- T-93 production cutover (Konfersi, paused).
- T-306 item 4 / T-340: installing the rtk hook is a permission change.

## NEXT (in order)
1. T-366 fix + re-review, merge, real-job QA; T-369 ux-check, merge after T-321.
2. Deploy (images=portal,workspace) once T-366 is merged and gated; needs the portal MCP (ci_run_trigger).
3. T-378, T-376 in parallel; T-375 (same worker as T-369); T-382 (lists epic S1); T-377, T-386.
4. T-370 HOLD (claudepilot-b7 runs the spike), then T-371..T-374.
5. T-365 rest, T-354, T-347, T-350, T-351, T-355, T-356, T-388, T-341, T-344, T-345, T-332, T-335, T-313, T-314, T-306 item 3, T-149. Konfersi and Event stay paused for this track (D-45).

LESSONS: typecheck before every integration push; report=end hides a worker's finished turn (use idle); ticket_claim_next takes an id now (claim by id); the portal can stall: copy verdicts to the ticket and re-dispatch after it is back.
