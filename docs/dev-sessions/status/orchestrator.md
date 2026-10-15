# orchestrator status (2026-10-15 00:45 UTC, session a8393f6b, continues 75f044fb)

Older log: `orchestrator-log-2026-10-14.md` (same folder).

## DONE
- LIVE portal 2026.10.15-1 (run 31 rmv8s72zu862989 PASSED on 0831ba7: gate, build, release auto, verify, chats; Argo Synced/Healthy c685eea). Carries T-338, T-342 (factory, --start off), T-333, T-336, T-343, T-312, crew hand-over 9dfb193.
- integration abcb31b (origin + pilot) = live + batch 6: T-348 (tool policy at dispatch), T-315 slice 1 (heartbeat workflow; runs only once on main). gate-job 781cb3d GREEN; server+contracts tsc rc 0 after the last merges (docs only).
- Closed tonight: T-333, T-336, T-343, T-342, T-312, T-353 (incident), T-334, T-348, T-315. Follow-ups filed: T-347..T-352, T-354..T-356.
- FAILURE: INCIDENT T-353 (mine): integration red on typecheck 23:05-00:09 (pushed after tsx tests only); fixed, gated, nothing deployed red.

## IN FLIGHT (5; workers only for new slices, D-49)
- T-366 urgent (D-55 folder trust): worker b48936e7 implementer, opus high, dev/t-366-1. Then a blind reviewer worker (opus) before merge, then the real-job QA.
- T-330/T-331/T-272 cpbview: dev/t-330-2 ecb0ea5 (20/20 by the author, job 164d48de); verifier worker e2a7357f (sonnet).
- T-349 session_start TOCTOU: worker a893d274 implementer, opus, dev/t-349-1 (proof job 07f615ed passed; typecheck pending).
- T-352 factory minors: worker 0571ff1c implementer, opus, dev/t-352-1 (idle on its own job monitor).
- T-321 empty crew list: sub-agent implementer (opus), dev/t-321-2 (started before the workers-only rule).

## DECISIONS
- 23:15 coordinator: new slices only as session_spawn workers (D-49); at most five in flight.
- 00:00 D-50 / D-51 applied: only T-63 blocked (upstream); T-93, rtk hook (T-306 item 4, T-340) stay the owner's.
- T-330: dev/t-330-2 is the line of record (ahead); orphan c378d9e7 ended.
- T-366 builds exactly D-55 (owner's own decision, DECISIONS.md:61) although gates are a person's: the decision is the person's.
- Deploy cap: three portal deploys a day; run 31 is the first of 2026-10-15.

## NEEDS A HUMAN
- T-93 production cutover (Konfersi, paused).
- T-306 item 4 / T-340: installing the rtk hook is a permission change.

## NEXT (ranked)
0. T-369 (urgent, owner's phone bug: crew tree under a lead header in every chip): implementer worker (opus) from origin/dev/t-321-2 (same files: session-crew.mjs, SessionsPage chips; T-321 merges first) + a ux-checker worker; the SAME implementer then does T-375 (high: two-line rows with model and quota bar, same component); takes the next free slot (D-43 cap held at five, coordinator asked "in parallel").
1. T-366 review + merge + real-job QA; deploy batch 6+7 with T-366 (second deploy of the day).
1b. T-370 (high, D-56 workspace SSH S0 spike, PRD docs/prd/workspace-ssh.md v0.2 at 3cc2dfe: one Unix user per person, never another's agent sign-in; brief from the v0.2 checks on T-370) as one worker; then T-371..T-374 in order (T-362 epic).
2. T-365 (high): keep job-run Jobs off the portal's node (fsync stall after run 31).
3. Merge returns: T-330, T-349, T-352, T-321 (verifier worker each, typecheck before every push).
4. T-293 per D-50: wire --start through session_start with parent (after T-352).
5. T-354 (chips UI + ux-checker), T-347, T-350, T-351, T-355, T-356, T-341, T-344, T-345, T-332, T-335, T-313, T-314, T-306 item 3, T-149.
CUT LINE: Konfersi and Event stay paused (D-45).

LESSONS: typecheck before EVERY integration push (tsx does not check types); report=end hides a worker's finished turn: use idle; scripts/job-run.sh --help exits 2: point briefs at the header; worker ticket tools may be missing: copy its verdict to the ticket.
