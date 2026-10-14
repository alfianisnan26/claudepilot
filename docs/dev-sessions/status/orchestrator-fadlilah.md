# Orchestrator hand-off (2026-10-14 ~20:40 UTC, chat 5802dfa4 on fadlilah; read this first, the older log is in `orchestrator.md`)

## State
- LIVE: portal 2026.10.14-8 (run 28). DEPLOYING: run 29 (rmv8lom00c8d8fd) on bb31963 = the whole batch incl. T-309 can() fix (gate-job bb31963 green). Follow it with ci_run_get; read the build tag and the chats job; then `git pull`.
- Everything below is on integration (bb31963, origin and pilot) EXCEPT nothing: no unmerged worker branch is left.
- Merged in the batch (branch, commit, ticket, what): dev/t-302-1 af3e442 T-302/T-309 policy help text (T-309 still open: the can() check on GET /api/settings/agent-env/:target/:name); dev/t-319-1 7885c28 T-319 PRD sentence (band is by design; the owner decides if it goes); dev/t-317-1 baa2e31 T-317 relay doc (the live Keep going run is NOT done); dev/t-322-1 40dd842 T-322 crew-e2e fails fast with its cause (cause only likely: a Pool-MCP-only drop-in blocks --mcp-config; a person runs crew-e2e.mjs --only 1 in the pod); dev/t-324-1 161688a T-324/T-297 flaky tests deterministic + scripts/test-repeat.sh (mode set +x by me; the worker's perf "after" job was never seen); dev/t-321-1 be2e4e2 T-321 session-crew seeds a live process (its 12-run proof was never seen); dev/t-312-1 d0656ff/05e3e10 T-312 server grouping by continued_from root (chips NOT built; the old-code failing run was never seen); dev/t-320-1 abc6839 T-320 PRD status of T-294 (built / not built table); dev/t-315-1 be1ed0d T-315 external heartbeat DESIGN (§23.3, questions for the owner).
- Also on integration earlier today: T-318 (stopped-task integrity line; stays open until seen live).
- Verifier 42383843 (sekar) ENDED: T-324 and T-297 PASS WITH GAPS (fixed tests stable: 20/20 plain and with hogs, job cd250d55; NOT shown that either fix matters: the old mutes test did not fail in 40 runs, the old perf test was never run; a proof needs a forced same-millisecond clock for mutes and the old 80 MB/s test rebuilt; the perf budget tests skip under load). Tickets stay open. Verifier 2005bc7f (satria) has T-321 and T-312 (running). Verifier f2809cf9 done (T-302 T-309 T-322 T-317 T-320 PASS WITH GAPS, T-315 PASS). Implementer 8d822b81 done: T-309 can() merged (8876b6f). T-328, T-329 filed.

## Next
1. After run 29 passes: verify the live tag; a fresh qa-verifier for T-321 and T-312; end 42383843. T-318 stays open until seen live.
2. T-296 is DONE (85870f7, case-clash test 3/3); no re-spawn needed.
3. Owner decisions waiting: T-315 questions (service, alert channel, probe B host, secret vs Settings); T-319 band; T-294 item 7 (stored channel vs session_message to: crew) and Bypass by lease (T-316); T-286.
4. Backlog: T-313, T-314, T-316 (needs the lease decision), T-293 current slice, T-306, T-149 leftovers, supervisor.mjs line 3 contradicts D-14 (file a ticket), T-302..T-305 triage (T-304/T-305 wont_do with a pointer), T-320.
5. Not mine: T-294, T-149, T-158 (VS Code crew).

## Lessons
- Name a commit only after `git ls-remote origin integration` shows it (run 27 deployed a stale head and was cancelled).
- Gate ONLY with scripts/gate-job.sh in the background on a pushed commit (a wip branch is fine); gate-quick in the pod is killed at its time limit.
- Workers cannot comment on unassigned tickets (T-294, T-323, T-296, T-319); a new worktree has no node_modules (tests via job-run.sh --ref <branch>); a worker that sits "idle" waiting on a job has not finished: its report says "waiting".
- host.test.ts "start --env" fails in the pod only (ENABLE_PROMPT_CACHING_1H is set there; passes with `env -u`).
