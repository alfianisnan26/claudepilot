# Example status file (ClaudePilot orchestrator, 2026-10-13, abridged)

A real status file after a restart, shortened. Note what it does: it says why the session started, what is live, what each sub-agent holds and what is left, the queue in rank order with a cut line, only required items under NEEDS A HUMAN, and the binding decisions with their times. This one adds a LIVE section, which is fine: the five required sections are all there.

```
# Orchestrator status (2026-10-13, session 5c9fcb5f, started 15:4x after an integrity ending of the previous session)

Queue lives in NEXT; tickets are claimed only when work starts.
Models: opus for implementation, sonnet for checks, fable for diagnosis.

## LIVE
- Portal 2026.10.13-6 (run 18, e327e6d, gate 470 s green; released by the owner, verified by the coordinator).

## IN FLIGHT (five sub-agents at most, opus, restarted from the pushed branches)
- t105 (opus): worktree dev-automove-model, branch dev/t105-automove-proven. Items 1, 2, 5 and the PRD done.
  T-109 WIP saved as 8cc8265. Left: make it compile, T-109 a-h, the area tests, the merge of integration.
- t100 (opus): branch dev/t100-sessions-list (2c69a31). Left: the clipped card, harness checks, the browser look, the PRD.
- t102 (opus): branch dev/t102-session-screen (4817c7f). Items 1-2 checked (940/940). Left: item 3, two checks, the PRD, the merge.

## NEXT (WIP limit FIVE slices, thin first slices, each merged AND deployed before the next starts)
1. T-105 + T-109 (running).
2. T-136 (rank-02a): takes the FIRST free slot.
2b. T-110 slice 1 ONLY (rank-03c): dry mode first; slice 2 waits until the owner has read five dry lines.
3. ... -> deploy (gate Job, deploy pipeline; approval by a person).
---- CUT LINE: nothing below starts before 7 is merged and deployed ----

## FOR THE COORDINATOR (permissions, rules, infra)
- (none)

## NEEDS A HUMAN (production and uat only)
- Reassign four tickets from the ended session to this one: the portal refuses a takeover, so this session cannot comment on or close them.
  (An earlier version also asked the owner to check the live release on a phone. That was dropped: optional checks are the agents' work, and "not verified on a real device" goes on each ticket instead.)

## DECISIONS
- 16:1x The three running slices are NOT preempted for the urgent T-136: they are mid-slice with WIP pushed, and a restart
  costs more than the wait. The next two free slots go to T-136, then T-110 (rank order).
- 15:5x The restart left no unmerged work behind: all three branches were pushed; uncommitted work saved as WIP commits.
- Binding, kept from earlier entries (the full log is in git history of this file):
  - Before a merge, run the touched AREAS' tests, not only the slice's own files.
  - An unpushed merge for a gate Job goes to a fresh wip/orch-<sha>, never a force push.
  - Claim a ticket only when work starts. WIP limit five.
  - Never print the environment in any form; every sub-agent brief says so.
  - Keep turns short (background waits) so auto move sees turn boundaries.
```
