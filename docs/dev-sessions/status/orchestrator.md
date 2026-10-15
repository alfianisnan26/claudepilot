# Orchestrator status (chat a8393f6b, continues 75f044fb), 2026-10-15 00:15 UTC

Older log: `orchestrator-log-2026-10-14.md` (same folder).

## STATE
- LIVE: portal 2026.10.14-10 (run 30). DEPLOYING: run 31 (rmv8s72zu862989) on integration 0831ba7 = batches 3-5: factory --start fixes (T-338, T-342; --start off), T-333 job-run --against, T-336 session_start parent (portalmcp: the release may wait for a person), T-343 live turn cost, T-312 spikes/lab by root, the coordinator's crew hand-over (9dfb193). Gate-job 0be97b8 green; run 31 gates 0831ba7 again.
- integration = 0831ba7 on origin and pilot. No unmerged branch of value except those IN FLIGHT.

## IN FLIGHT (max 5; new slices only as session_spawn workers, D-49 / coordinator 23:15)
- sub-agent implementer T-321 (opus, high): empty crew list at 390-light, dev/t-321-2.
- sub-agent implementer T-348 (opus, high, security): declared tool policies enforced, dev/t-348-1.
- worker d9a3cdd8 qa-verifier T-334 (sonnet, dontAsk): follows the dontAsk text, counts refusals.
- worker 9f670a04 implementer T-330/T-331/T-272 (opus, dontAsk): dev/t-330-2 (line of record, comment 1995). Orphan worker c378d9e7 (old lead) also on T-330: not mine, asked on the ticket to stop.
- worker 4d903086 implementer T-315 slice 1 (sonnet, dontAsk): GitHub Actions heartbeat, dev/t-315-2.

## NEXT (ranked)
1. Run 31: read gate, build, release, verify, chats; `git pull`; list live tickets under DONE.
2. Each return: verifier worker (sonnet), merge, typecheck or gate-job BEFORE every integration push, close on PASS with a follow-up per gap.
3. T-293 per D-50: wire --start through session_start with parent; T-352 minors first.
4. T-354 (T-312 chips, UI + ux-checker), T-349, T-347, T-350, T-351, T-341, T-344, T-345, T-332, T-335, T-313, T-314, T-306 item 3, T-149 leftovers.
CUT LINE: Konfersi and Event stay paused (D-45).

## DONE tonight (this chat)
- Closed: T-333 (gap T-347), T-336 (gaps T-348, T-349), T-343 (gaps T-350, T-351), T-342 (minors T-352), T-312 (UI rest T-354), T-353 (incident, below).
- Filed: T-347..T-354.

## FAILURES
- INCIDENT T-353 (mine): integration red on typecheck 23:05-00:09 (T-342 merge pushed after tsx tests only). Found by gate-job 49af31a, fixed, gate-job 0be97b8 green, nothing deployed red.
- T-330 first fix FAIL (comment 1984: 18/20 under hogs; parent 7/20).

## NEEDS A HUMAN (required items only, D-51)
- T-93 production cutover (Konfersi, paused).
- T-306 item 4 and T-340: installing the rtk hook is a permission change.
- Run 31's release may wait for an approval in the portal (T-336 touches portalmcp tools).

## DECISIONS (this chat)
- Deploy cap: runs 28-30 were three on 2026-10-14, so batches 3-5 waited for 00:00 UTC.
- T-330: dev/t-330-2 over dev/t-330-1 (ahead, built on the verifier's data).
- T-312 lab widening accepted: the chain reaches only the session's own continued_from ancestors (verifier confirmed).
- D-51 blocked check: only T-63 blocked (upstream release); nothing else to unblock.

## LESSONS
- typecheck (or a gate-job) before EVERY integration push: tsx test runs do not check types.
- a local web typecheck can fail on missing node_modules (@codemirror): trust the clean-copy gate for web.
- a hand-over moved tickets, not live workers: check the old lead's workers on the tickets (fixed by 9dfb193 from the next start).
- workers cannot read files outside the repo (~/work/briefs): put the brief inline.
