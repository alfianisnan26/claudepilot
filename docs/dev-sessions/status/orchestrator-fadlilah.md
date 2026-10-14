# Orchestrator hand-off (2026-10-14 ~20:40 UTC, chat 5802dfa4 on fadlilah; read this first, the older log is in `orchestrator.md`)

## State
- LIVE: portal 2026.10.14-8 (run 28, 7591f31: T-318, worktree rules for workers, allow-list additions).
- BATCH is ON integration now (gate-job 0a37182 green; pushed to origin and pilot at 18fca4e, then merges up to f92ff79). NOT DEPLOYED: deploy (`/deploy`, images portal, gate true) after verifier 42383843 reports. Check `git ls-remote origin integration` first.
- Merged in the batch (branch, commit, ticket, what): dev/t-302-1 af3e442 T-302/T-309 policy help text (T-309 still open: the can() check on GET /api/settings/agent-env/:target/:name); dev/t-319-1 7885c28 T-319 PRD sentence (band is by design; the owner decides if it goes); dev/t-317-1 baa2e31 T-317 relay doc (the live Keep going run is NOT done); dev/t-322-1 40dd842 T-322 crew-e2e fails fast with its cause (cause only likely: a Pool-MCP-only drop-in blocks --mcp-config; a person runs crew-e2e.mjs --only 1 in the pod); dev/t-324-1 161688a T-324/T-297 flaky tests deterministic + scripts/test-repeat.sh (mode set +x by me; the worker's perf "after" job was never seen); dev/t-321-1 be2e4e2 T-321 session-crew seeds a live process (its 12-run proof was never seen); dev/t-312-1 d0656ff/05e3e10 T-312 server grouping by continued_from root (chips NOT built; the old-code failing run was never seen); dev/t-320-1 abc6839 T-320 PRD status of T-294 (built / not built table); dev/t-315-1 be1ed0d T-315 external heartbeat DESIGN (§23.3, questions for the owner).
- Also on integration earlier today: T-318 (stopped-task integrity line; stays open until seen live).
- Workers in flight (20:47): verifier 42383843 (T-324/T-297, T-321, T-312, waiting on its job), implementer 8d822b81 on satria (T-309 can() check, dev/t-309-2). Verifier f2809cf9 done: T-302 T-309 T-322 T-317 T-320 PASS WITH GAPS, T-315 PASS (T-309 can() gap real; T-317 D-14 claim fixed by me in 18fca4e). T-328 filed (supervisor.mjs line 3).

## Next
1. Verifier 42383843 reports -> read its whole reply (session_family reply_of) -> end it -> deploy. Then verify the live version and read the chats job.
2. T-296 is DONE (85870f7, case-clash test 3/3); no re-spawn needed.
3. Owner decisions waiting: T-315 questions (service, alert channel, probe B host, secret vs Settings); T-319 band; T-294 item 7 (stored channel vs session_message to: crew) and Bypass by lease (T-316); T-286.
4. Backlog: T-313, T-314, T-316 (needs the lease decision), T-293 current slice, T-306, T-149 leftovers, T-309 can() check, supervisor.mjs line 3 contradicts D-14 (file a ticket), T-302..T-305 triage (T-304/T-305 wont_do with a pointer), T-320.
5. Not mine: T-294, T-149, T-158 (VS Code crew).

## Lessons
- Name a commit only after `git ls-remote origin integration` shows it (run 27 deployed a stale head and was cancelled).
- Gate ONLY with scripts/gate-job.sh in the background on a pushed commit (a wip branch is fine); gate-quick in the pod is killed at its time limit.
- Workers cannot comment on unassigned tickets (T-294, T-323, T-296, T-319); a new worktree has no node_modules (tests via job-run.sh --ref <branch>); a worker that sits "idle" waiting on a job has not finished: its report says "waiting".
- host.test.ts "start --env" fails in the pod only (ENABLE_PROMPT_CACHING_1H is set there; passes with `env -u`).
