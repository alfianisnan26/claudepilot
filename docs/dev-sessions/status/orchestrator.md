# orchestrator status (2026-10-15 01:40 UTC, session 83842ba6, continuation of a8393f6b)

Older log: `orchestrator-log-2026-10-14.md` (same folder). Previous hand-over: commit ab99b45.

## DONE
- LIVE portal 2026.10.15-1 (run 31 PASSED on 0831ba7; Argo c685eea): T-338, T-342, T-333, T-336, T-343, T-312, crew hand-over.
- integration ab99b45 (origin + pilot), NOT deployed: T-348, T-315 s1, T-330/T-331/T-272, job anti-affinity 96f47b8, D-55/D-56 docs. Full gate: gate-job 3278277 GREEN 02:1x (typecheck 48s, web build 27s, server suite 369s; /tmp/gate-job-3278277.log), includes the coordinator's T-365 WAL fix 3438d9b.
- 01:24 adopted T-366, T-369, T-321, T-349, T-352 (claimed by id; the ended lead's tickets had gone back to the queue).
- Ended workers: 7be4aeac (T-366 reviewer, verdict copied below), 2005bc7f (old T-321/T-312 verifier; T-312 already closed, UI part is T-354).

## IN FLIGHT (5 of 5; sub-agents end with this chat: their pushed branches are the resume point)
- T-366 (urgent): SUB-AGENT implementer (opus) on dev/t-366-1: review fixes B1/M1/M2/m1 (comment 2322); running its jobs. Then a fresh reviewer, merge, real-job QA.
- T-369 (urgent): ux-check FAIL on item 4 (50 px shift on lead flip) + harness seed (comment 2351). SUB-AGENT implementer (opus) fixing on dev/t-369-1.
- T-375 (high): SUB-AGENT implementer (opus) in dev-t-369-1.worktrees/dev-t-375-1 (dev/t-375-1 from 731fa28; rebases on the T-369 fix).
- T-376 (high, L, 3 slices; estimate comment 2358): S1 server paging + gzip, SUB-AGENT implementer (opus, high) on dev/t-376-1 from 0c467b9. Plan step done (manifest /home/node/work/plan-t376-manifest.txt, head plan-t376-head.md). No E2 experiment running (lab_arm_draw: none).
- T-321: qa-verifier worker dceae388 (sonnet) runs set B from dev-t-349-1 (dev-t-321-2 untrusted).
- MERGE QUEUE: T-349 merged locally 886d04e, quick gate running (/home/node/work/gate-quick-886d04e.log); then T-352 (456464f, proof job e6c3961e, comment 2354).

## DECISIONS
- 01:44 coordinator: 2026.10.15-2 LIVE (main d4a0adc), hold lifted. Earlier HOLD (T-365): Checked: none of dev/t-366-1, t-369-1, t-349-1, t-352-1, t-321-2 contains 96f47b8 (cut before it), so no merge needed; main folder pulled to c88e593 (Jobs prefer, not require, a node away from the portal).
- 01:50 Portal stalled 01:26-01:52 (readiness/liveness timeouts, T-365; coordinator pushed 3438d9b WAL fix to integration, not deployed). This chat's portal MCP did not reconnect: options (a) wait, (b) Agent-tool sub-agents (allowed by the org rules; D-49 does not forbid them). Took (b). Ticket comments and closes are queued here until the MCP is back; sub-agents report in their final message.
- 01:25 T-366: fix the review's B1/M1/M2/m1 BEFORE merge (a gate change; merging would ship weaker than D-55). M2 only in the stricter direction, so no owner decision. Reason on T-366 (comment pending, portal down).
- New slices only as session_spawn workers (D-49); at most five in flight (D-43). Quota 01:23: alfian.isnan session 1 %, projection 18 % (claude_usage).
- Deploy cap three a day; run 31 was the first of 2026-10-15. Next deploy needs images=portal,workspace once T-366 is in.

## NEEDS A HUMAN
- T-397 (permissions): let crew workers comment on their lead's tickets (authz) and give the verifier, reviewer and ux-checker roles ticket_get/ticket_comment (persona). Steps: decide (a) and (b) on T-397; until then the lead copies every report.
- T-93 production cutover (Konfersi, paused).
- T-306 item 4 / T-340: installing the rtk hook is a permission change.

## NEXT (in order)
0. T-400 (high, coordinator 01:53: supervisor started duplicate leads during the outage): NEXT FREE SLOT, one implementer (docs/dev-sessions/supervisor.mjs + apps/server/src/keepgoing/supervisor.test.ts); a worker only in an already-trusted folder (dev-t-352-1 after T-352 merges), else a sub-agent.
1. T-366 fix + re-review, merge, real-job QA; T-369 ux-check, merge after T-321.
2. Deploy (images=portal,workspace) once T-366 is merged and gated (second portal deploy of the day after the coordinator's -2).
3. T-378, T-376 in parallel; T-375 (same worker as T-369); T-382 (lists epic S1); T-377, T-386.
4. T-370 HOLD (claudepilot-b7 runs the spike), then T-371..T-374 and T-363 (coordinator added D-59 and PRD 8b criteria on T-363, T-371, T-372, T-373: read them before briefing).
5. T-365 rest, T-354, T-347, T-350, T-351, T-355, T-356, T-388, T-341, T-344, T-345, T-332, T-335, T-313, T-314, T-306 item 3, T-149. Konfersi and Event stay paused for this track (D-45).

LESSONS: a dontAsk worker cannot move to a new worktree, and a new worktree is untrusted until T-366 is live: spawn workers only in already-trusted folders (or sub-agents); typecheck before every integration push; report=end hides a worker's finished turn (use idle); ticket_claim_next takes an id now (claim by id); the portal can stall: copy verdicts to the ticket and re-dispatch after it is back.
