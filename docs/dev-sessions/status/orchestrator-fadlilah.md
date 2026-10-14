# Orchestrator status (2026-10-14, chat 5802dfa4, moved from two.claude to fadlilah ~18:10 UTC)

Older log: `orchestrator.md`; the hand-off before the move is on branch `wip/orch-status-two`.

## Now (19:15 UTC)
- LIVE: portal 2026.10.14-6 (run 25) and 2026.10.14-7 (coordinator). RUNNING: deploy run 28 on 7591f31 (T-318 merged, worktree-rules fix, allow-list additions).
- T-318 (stopped-task integrity line): built dev/t318 f35e509 + review fixes 0b7c715 (producer key absent, timed-out stop kept); reviewed clean by opus; merged into integration, goes live with run 28. T-318 stays open until seen live.
- Crew (D-47, D-49): V1/V2 verifiers ended with reports (comments 1767-1773). I1 (T-296) ended: already done in 85870f7 (case-clash test 3/3 run by me). I2 `7530ae9e-7352-4025-88de-de5fa33507fb` (T-324, T-297, dev/t-324-1) and I3 `08cf748d-3bef-47b5-9219-28d1217e8230` (T-302, T-309, dev/t-302-1) are idle, WAITING for run 28 then a Restart (they launched without the project rules).

## Verdicts of the second verifier pass (none closable)
- T-109 PASS WITH GAPS; T-136 PASS WITH GAPS (E, F: T-312, T-313, T-314); T-259 FAIL against the full text (T-315, T-316, T-317).
- T-280, T-282, T-285, T-287 PASS WITH GAPS (T-287 much unbuilt, T-305; T-285 MAX_MCP_OUTPUT_TOKENS still 25000, human step).

## Next
1. After run 28 is live: Restart I2 and I3, check one edits, tests, commits and pushes its branch; merge their branches, gate, push integration, deploy batched.
2. T-293 current slice, T-306 (RTK step 2, safe subset), T-319, T-149 leftovers, T-302/T-304/T-305 triage (T-304, T-305 hold verifier reports: wont_do with a pointer; needs the ticket assigned or adopted).
3. Not mine (VS Code crew holds): T-294, T-149, T-158.

## Lessons
- A coordinator message can name a commit that is not on origin yet: `git ls-remote origin integration` before triggering a deploy (run 27 deployed the wrong head and was cancelled).
- Workers cannot comment on unassigned tickets (T-294, T-323, T-296): give them tickets assigned to the lead.
- The pod sets ENABLE_PROMPT_CACHING_1H, which fails host.test.ts "start --env" here (passes with `env -u`); gate-quick in the pod is flaky under load.
