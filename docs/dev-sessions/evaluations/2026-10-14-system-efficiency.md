# System efficiency and effectiveness, first 22 hours (coordinator, 2026-10-14 02:20 UTC)

Window: 2026-10-13 05:00 to 2026-10-14 02:20 UTC. Written by the coordinator alone, from the portal's own numbers. Sources: `/api/claude-usage/requests?range=1d|7d`, `/api/chat/sessions`, `/api/tickets`, `/api/ci/runs`, `git log origin/integration`. The coordinator's own session (VS Code, outside pilot) is NOT in the cost numbers and cannot be measured from pilot.

## Money and tokens (source: usage report, measured unless marked estimate)
- Spend $753 (estimate, list prices) in 22 h: $34 per hour on average, $44 per active hour, peak $67. Output 6.58 M tokens, cache read 1.35 B, cache write 57 M, uncached input 38 k. Cache hit rate 95.9 percent (measured).
- Model mix by cost: opus $615 (82 percent, 214 requests, $2.87 per request), fable $128 (17 percent, 77 requests, $1.66), sonnet $10.6 (1.4 percent, 46 requests, $0.23). Agent runs: opus 86, fable 22, sonnet 9 of 117: sonnet is 8 percent although orchestrator.md says sonnet for narrow, well-specified slices.
- Per program (sessions, main process only): ClaudePilot orchestrators $539 in 4 sessions, Konfersi $128 in 3, Event $45 in 1.

## Availability (source: hourly spend buckets, session endings)
- No spend at all from 18:30 to 00:00 UTC (about 5.5 h of 22, 25 percent): the ClaudePilot orchestrator ended at 17:58 (integrity) and was not restarted (supervisor cap, owner's Mac off the private network), the Konfersi chat sat on a limit message of an exhausted Claude from 18:36, the Event chat sat in `default` mode with a pending approval.
- Five integrity endings in 13 h (three causes); the largest session lost was $311.
- Causes of the lost hours, all ticketed: T-259 (watchdog inside the portal), T-255 (unknown usage chosen as a destination), T-256 (Bypass lost after a move), T-257 (supervisor gave up silently), T-270 (tickets assigned to dead sessions), T-136 slice 2 (recover in place).

## Output (source: git, tickets, CI)
- ClaudePilot: 405 commits on integration (+46,342 and -3,849 lines, 87 merges); 32 tickets done, 14 live and in_review, 5 in progress. Konfersi: 13 tickets done, 12 of 13 stg deploys green. Event: bootstrap merged to stg, 83 issues imported as tickets, Builder MCP design reviewed independently, dispatcher proven; first stg deploy in flight (run 5). Event tickets done: 0.
- ClaudePilot deploy runs: 19, green 7, failed 4, cancelled 8 (about 178 pipeline minutes in non-green runs, almost all before 13:20 while the pipeline was being fixed; since then 3 of 4 green and no failure after #16).
- Rough unit costs (estimate, tickets differ in size): $17 per done ticket, $13 counting live in_review ones; $1.9 per commit.

## Human touch
- Owner requests that should not have reached him: T-139 (optional device checks, D-34), T-215 (a reassignment, a mechanical step). Required and done by him: the package grants. Dropped by him: R2 key (D-42).

## Findings and improvements, by value
1. Availability first (about 25 percent lost): T-259, T-255, T-256, T-257, T-270. Until they land the coordinator loop, the SSH jump tunnel and the orphan sweep stand in.
2. Model routing is prose, not a rule: sonnet is 8 percent of agent runs. Per request sonnet is about 12 times cheaper than opus (not like for like: sonnet slices are shorter). Moving 20 to 30 percent of opus requests (verification, sweeps, scribe, formatting, harness runs) to sonnet would save roughly 10 to 20 percent of spend (rough estimate). Fix: role to model table in the brief, the model written next to every slice, the coordinator audits the share each pass.
3. Context size drives cost: cache reads are 1.35 B tokens (about 200 per output token). Orchestrators run at 220 to 300 k context. Fix: orchestrators hand off at about 200 k (status file, fresh continuation), sub-agents get narrow briefs, T-111 measures cost per request against context size per session.
4. Verification lag: 14 live tickets wait for an independent check (D-34). Fix: a standing sonnet verifier role per orchestrator, daily.
5. Shared pod contention: heavy.lock waits of 12 minutes, a lock deadlock (T-159), Event and Konfersi share it. Fix: everything heavy through job-run, one scratch portal per agent.
6. Shared GitHub token: 5,000 calls an hour exhausted twice while three programs ran; backoff was added by instruction only (no ticket, owner's call).
7. Event: first deploy then E2E (T-152) and the MCP slices; measure cost per slice from now.

## Addendum, 04:25 UTC: resolved tickets against effort and severity (coordinator)
- Burn: last 12 h $362 ($30 per hour), opus 85 percent, sonnet 2 percent with zero sonnet requests after the 02:25 routing order; the first full hour on five sub-agents peaked at $82 with 29 agents (the highest of the run). Cache hit 94.7 percent. Orchestrator contexts are lower after fresh continuations (60 to 110 k), one was 412 k.
- 57 tickets resolved since 2026-10-13 (43 ClaudePilot, 14 Konfersi, Event 0). Recorded estimate, severity or effort: 0 of 57 (the fields exist in the ticket payload but the API has no way to write them yet). Konfersi tickets closed without ever being claimed: 14 of 14 (no in_progress, no cycle time). ClaudePilot done tickets with a commit that carries the Ticket trailer: 10 of 43; mentioned in any commit message: 30 of 43; with no commit trace at all: 13 (untraceable under the charter).
- Cycle time (in_progress to done) ClaudePilot: urgent 6.5 h average (18 tickets), high 6.8 h (19), normal 2.6 h (5); one reopened. Elapsed time overstates effort: six tickets (T-24, T-32, T-97, T-98, T-42, T-99) sat in WIP for 13 to 16 h because they waited for a deploy and for verification while the orchestrator was down.
- Allocated cost (program session cost spread over resolved tickets by in-progress hours, estimate only): urgent about $17, high $15, normal $3, low $1 per ClaudePilot ticket; Konfersi about $12 each (no timestamps, equal shares). About $768 of the $850 in sessions lands on resolved tickets by this rule; the rest is unfinished work, overhead and downtime. Severity order is sane, but without estimates the predictability term of the charter cannot be scored.
- Rules added 2026-10-14: claim then `ESTIMATE:` comment (size, hours, severity 1 to 4, risks); close with an `ACTUAL:` comment (hours, sub-agent runs, commits, rework, defects after delivery, cost estimate) and the three commit trailers; sub-agents by role through `.claude/agents` with fixed models (sonnet for verification roles). The coordinator computes estimate against actual from these comments, the usage report and git every pass until the portal's structured estimate field and scoreboard (T-111, T-114) exist.
