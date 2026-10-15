# orchestrator status (2026-10-15 01:25 UTC, session a8393f6b, HAND-OVER to the continuation)

Older log: `orchestrator-log-2026-10-14.md` (same folder).

## DONE
- LIVE portal 2026.10.15-1 (run 31 rmv8s72zu862989 PASSED on 0831ba7; Argo Synced/Healthy c685eea): T-338, T-342, T-333, T-336, T-343, T-312, crew hand-over.
- integration 79ef74f (origin + pilot), NOT deployed: T-348 (tool policy at dispatch), T-315 slice 1 (heartbeat workflow, runs only once on main), T-330/T-331/T-272 (cpbview), coordinator's job anti-affinity 96f47b8, D-55/D-56 docs, byoa-ssh PoC tools. Last full gate: gate-job 781cb3d GREEN (before T-330 + coordinator merges); server tsc rc 0 and jobRun 15/15 on 3ea503d.
- Closed in this chat: T-333, T-336, T-343, T-342, T-312, T-353 (my incident: integration red on tsc 23:05-00:09, fixed), T-334, T-348, T-315, T-330, T-331, T-272. Filed: T-347..T-352, T-354..T-356, T-388.

## IN FLIGHT (live workers move to the continuation; do not end them)
- T-366 (urgent, D-55 folder trust): implementer done, branch dev/t-366-1 head d647d14 (report copied to T-366 comment 2236). WAIT FOR: blind reviewer worker 7be4aeac (opus) verdict on T-366. SAFE -> merge, typecheck, then the real-job QA (a dontAsk worker in a brand-new rules-only worktree starts without a person; one with `Bash(flock /tmp/heavy.lock:*)` is refused with the reason). Deploy needs images=portal,workspace (broadAllow is computed by the workspace's cp-session host copy; an old host scans broad = fail closed).
- T-369 (urgent, owner phone bug: crew tree under a lead header): implementer worker 151ab26d (opus, dontAsk), branch dev/t-369-1 from origin/dev/t-321-2. WAIT FOR: its ACTUAL on T-369; then a ux-checker worker (390 then 1280, light/dark); then send T-375 to the SAME worker (same component).
- T-349 (session_start TOCTOU): implementer worker a893d274 (opus), dev/t-349-1 from wip/batch-6; proof job 07f615ed passed (3 new tests fail on 781cb3d). WAIT FOR: its typecheck + chat/portalmcp job result, then a verifier worker.
- T-352 (factory minors m1-m3 + live cost estimate): implementer worker 0571ff1c (opus), dev/t-352-1 aa8b815 pushed; idle on its own job monitor. WAIT FOR: its ACTUAL on T-352 (message it if it stays silent), then a verifier worker.
- T-321 (empty crew list flake): an Agent-tool SUB-AGENT of this chat: it ENDS with this chat. Its pushed work: dev/t-321-2 (361fdab --diag, c0cec96/ccb280a chip stays picked, 74bbb76 session-crew waits for the page). Read T-321's comments for its ACTUAL; if none, a worker finishes it (30+ runs with --hogs, base vs fix). T-369 is built on this branch: merge T-321 first.

## DECISIONS
- New slices only as session_spawn workers (D-49); at most five in flight (D-43), the Konfersi and Event crews share the workspace.
- D-50/D-51/D-55/D-56 applied; only T-63 blocked (upstream).
- T-366 builds exactly D-55 (owner's decision, DECISIONS.md:61); every implementer choice was stricter.
- Deploy cap three a day; run 31 was the first of 2026-10-15.

## NEEDS A HUMAN
- T-93 production cutover (Konfersi, paused).
- T-306 item 4 / T-340: installing the rtk hook is a permission change.

## NEXT (in order)
1. T-366 (review verdict, merge, real-job QA) and T-369 (+ ux-checker).
2. A full gate-job on the integration head before the next deploy (none running now); deploy with images=portal,workspace once T-366 is in.
3. T-378 (QA at scale: one QA worker owns the shared fixture and gate, FAIL first then PASS), T-376 (transcript paging from newest + compression) in parallel.
4. T-375 (two-line rows, same implementer as T-369).
5. T-382 (lists epic: S1 cursor standard + JSON compression first; shares T-378's fixture and gate; covers T-376's paging).
6. T-377 (nested lists fold), T-386.
7. T-370: HOLD the spike (session claudepilot-b7 runs it locally; evidence lands as docs/prd/evidence/t370-*.md); then its k8s part, then T-371..T-374 (PRD workspace-ssh.md v0.2).
8. T-365 rest, T-354, T-347, T-350, T-351, T-355, T-356, T-388, T-341, T-344, T-345, T-332, T-335, T-313, T-314, T-306 item 3, T-149. Konfersi and Event stay paused for this track (D-45).

LESSONS: typecheck before every integration push; report=end hides a worker's finished turn (use idle); job-run --help exits 2 (briefs point at the header); worker ticket tools can be missing or the portal can stall: copy verdicts to the ticket; a 20x test-repeat Job on the portal's node stalled the portal (anti-affinity now on integration).
