# orchestrator status (2026-10-15 02:16 UTC, session 83842ba6, continuation of a8393f6b; process restarted ~02:10)

Older log: `orchestrator-log-2026-10-14.md` (same folder). Previous hand-over: commit ab99b45.

## DONE
- 02:16 integration c1aa862 PUSHED (origin + pilot): T-349 and T-352 (full gate claudepilot-gate-06e7564-e0ed GREEN: typecheck 39 s, web build 24 s, server suite 379 s); both CLOSED with evidence. T-400 verified (PASS WITH GAPS, gaps T-409), merged locally 3f0ab24.
- LIVE portal 2026.10.15-1 (run 31 PASSED on 0831ba7; Argo c685eea): T-338, T-342, T-333, T-336, T-343, T-312, crew hand-over.
- integration ab99b45 (origin + pilot), NOT deployed: T-348, T-315 s1, T-330/T-331/T-272, job anti-affinity 96f47b8, D-55/D-56 docs. Full gate: gate-job 3278277 GREEN 02:1x (typecheck 48s, web build 27s, server suite 369s; /tmp/gate-job-3278277.log), includes the coordinator's T-365 WAL fix 3438d9b.
- 01:24 adopted T-366, T-369, T-321, T-349, T-352 (claimed by id; the ended lead's tickets had gone back to the queue).
- Ended workers: 7be4aeac (T-366 reviewer, verdict copied below), 2005bc7f (old T-321/T-312 verifier; T-312 already closed, UI part is T-354).

## IN FLIGHT (5 of 5 workers; none on alfian.isnan: quota)
- T-366 (urgent): worker 4c9d913d (opus, fadlilah) review-2 fixes in dev-t-366-1. NOT MERGED until owner answers T-403.
- T-369 (urgent): worker 977ecdf4 (opus, rossi) finishing the fix in dev-t-369-1 (4f87a16, ff0088d pushed).
- T-378 (high): S1 worker f5c700fe (opus, regitha) in dev-t-333-1 on dev/t-378-1.
- T-404 (high, D-60 guard hook): worker 87a9f89b (opus, rossi) in dev-t-352-1 on dev/t-404-1 (estimate comment 2512).
- T-376 (high): S1 merged locally; S2 web worker 284eb4b8 (opus, regitha) in dev-t-336-1 on dev/t-376-2 from 4671915.
- WAITING: T-375 (a5fc68a) rebases on T-369, then a ux-checker.
- MERGE QUEUE: 6166d2e (T-321 + T-376 S1 + pack) full gate Job running (wip/orch-6166d2e; log /home/node/work/gate-6166d2e.log), push it when green; then 3f0ab24 (T-400 merge) needs its own gate.
- Spare trusted worktrees: none free now (dev-t-349-1 is free: its verifier ended). Update a spare to integration before spawning a verifier there (old job-run.sh lacked --against: T-400 verifier).

## DECISIONS
- 02:24 OOM (coordinator): the workspace pod was OOMKilled at 02:11 (8 GiB); that was this chat's 'restart'. Rules from now: live cap 10 sessions in the workspace for ALL programs (~310 MB each); NO Agent-tool sub-agents of my own; heavy work only through scripts/job-run.sh (never npm ci, tests or builds in the pod, not even under flock). My briefs had allowed in-pod npm ci and local tests under the heavy lock: incident T-413 filed with my share; post-mortem by an incident-analyst worker at the next free slot.
- 02:14 D-60 (owner): no agent writes .claude/settings*.json, .mcp.json or a repository's allow-list checker; allow-list changes are proposed as text on a ticket. Read: T-366's portal trust classifier is product code and only tightens: continues (comment 2506); every brief now says never touch those files.
- 02:05 QUOTA (D-43): alfian.isnan session 27 %, projected 163.6 % at the 06:10 reset (claude_usage 02:04, runs out ~04:15). No NEW Agent-tool sub-agents on it; running ones finish; every new slice is a session_spawn worker on claude auto. Workers start only in an ALREADY-TRUSTED folder (new worktrees are FOLDER_UNTRUSTED until T-366 is live): the lead switches a free trusted worktree (dev-t-349-1, dev-t-352-1: their branches are merged) to the new branch, then spawns. Coordinator cited D-49 for 'one sub-agent'; D-49 does not say that; the action stands on D-43.
- 01:44 coordinator: 2026.10.15-2 LIVE (main d4a0adc), hold lifted. Earlier HOLD (T-365): Checked: none of dev/t-366-1, t-369-1, t-349-1, t-352-1, t-321-2 contains 96f47b8 (cut before it), so no merge needed; main folder pulled to c88e593 (Jobs prefer, not require, a node away from the portal).
- 01:50 Portal stalled 01:26-01:52 (readiness/liveness timeouts, T-365; coordinator pushed 3438d9b WAL fix to integration, not deployed). This chat's portal MCP did not reconnect: options (a) wait, (b) Agent-tool sub-agents (allowed by the org rules; D-49 does not forbid them). Took (b). Ticket comments and closes are queued here until the MCP is back; sub-agents report in their final message.
- 01:25 T-366: fix the review's B1/M1/M2/m1 BEFORE merge (a gate change; merging would ship weaker than D-55). M2 only in the stricter direction, so no owner decision. Reason on T-366 (comment pending, portal down).
- New slices only as session_spawn workers (D-49); at most five in flight (D-43). Quota 01:23: alfian.isnan session 1 %, projection 18 % (claude_usage).
- Deploy cap three a day; run 31 was the first of 2026-10-15. Next deploy needs images=portal,workspace once T-366 is in.

## NEEDS A HUMAN
- T-403 (urgent, permissions): answer a, b or c on T-403. (a) trust a new folder only as a worktree/clone of a repository you already trusted (recommended), (b) keep the content scan and accept that in-folder Edit + a build/test rule = any command, (c) no first-time auto-trust. T-366 waits. After its deploy, every ClaudePilot folder needs your trust once (hash now includes skills/agents/commands; this repo's settings count as broad).
- T-397 (permissions): let crew workers comment on their lead's tickets (authz) and give the verifier, reviewer and ux-checker roles ticket_get/ticket_comment (persona). Steps: decide (a) and (b) on T-397; until then the lead copies every report.
- T-93 production cutover (Konfersi, paused).
- T-306 item 4 / T-340: installing the rtk hook is a permission change.

## NEXT (in order)
00. T-413 post-mortem: incident-analyst worker (sonnet) at the next free slot.
0. T-404 (high, coordinator 02:1x, D-60): managed PreToolUse guard hook refusing rule-file writes for every session in the pod (Bypass included); implementer worker, blind reviewer worker, QA real job. NEXT FREE SLOT (a trusted spare folder: dev-t-352-1).
1. T-366 fix + re-review, merge, real-job QA; T-369 ux-check, merge after T-321.
2. Deploy (images=portal,workspace) once T-366 is merged and gated (second portal deploy of the day after the coordinator's -2).
3. T-378, T-376 in parallel; T-375 (same worker as T-369); T-382 (lists epic S1); T-377, T-386.
4. T-370 HOLD (claudepilot-b7 runs the spike), then T-371..T-374 and T-363 (coordinator added D-59 and PRD 8b criteria on T-363, T-371, T-372, T-373: read them before briefing).
5. T-365 rest, T-354, T-347, T-350, T-351, T-355, T-356, T-388, T-341, T-344, T-345, T-332, T-335, T-313, T-314, T-306 item 3, T-149. Konfersi and Event stay paused for this track (D-45).

LESSONS: never npm ci, tests or builds in the pod (OOM 02:11, T-413): job-run only, and every brief says so; no Agent-tool sub-agents (they share the lead's process); a dontAsk worker cannot move to a new worktree, and a new worktree is untrusted until T-366 is live: spawn workers only in already-trusted folders (or sub-agents); typecheck before every integration push; report=end hides a worker's finished turn (use idle); ticket_claim_next takes an id now (claim by id); the portal can stall: copy verdicts to the ticket and re-dispatch after it is back.
