# Work rhythm

How an autonomous session keeps its work visible, pushed and moving, so that any restart loses nothing.

## The status file

One file per role, at `docs/dev-sessions/status/<role>.md` unless `project-standards` names another path.

- At most 80 lines. Overwrite it; never append a log. Old entries live in git history.
- Commit it with the work it describes. A commit that changes only the status file needs no gate; any other file in it does.
- Sections, in this order:

```
# <role> status (<date>, session <id>)
## DONE           item, commit, evidence link
## IN FLIGHT      slice, sub-agent label, model, branch, worktree, last pushed commit
## DECISIONS      time, decision, reason (keep the binding ones; drop the rest)
## NEEDS A HUMAN  required escalations only, each with exact steps for the person
## NEXT           the ranked queue: what starts when a slot frees
```

- When the whole backlog is done, make `TRACK COMPLETE` the first line, commit, push, and end with a report of at most 25 lines.

## Commits and pushes

- Commit small. Every commit carries the trailers `Ticket`, `Pilot-Session`, `Pilot-Agent`.
- Push the slice branch at least every 20 minutes of work and always before a long run (a suite, a build, a wait). Sub-agents stop when the chat restarts; a pushed branch is what the next session resumes from.
- Branches: `ticket/T-n-slug`, one worktree per slice, never the main folder, never another agent's worktree.
- A commit that must be fetchable (for a gate Job) goes to a fresh branch `wip/<label>-<sha>` with a plain push. Never reuse a branch name with force.
- Only the orchestrator merges into the integration branch: after each slice, through the quick gate; at least every 8 commits or 2 hours.
- The full gate runs on the exact commit before any deploy, and on the integration head every 2 hours in the background. A red full gate is fixed before the next merge.
- After a merge, the slice branch rebases on the integration branch. Never discard someone else's lines.

## WIP limit

- At most three slices in flight, so at most three sub-agents at once.
- A slice is about one hour of work: one to three items. The orchestrator integrates between slices.
- Claim a ticket only when work on it starts. The queue lives in NEXT, not in claimed tickets.
- A new item does not preempt a running slice: it takes the next free slot in rank order.

## Status posts

- Rewrite the status file at every change of state: dispatch, return, merge, decision, escalation, deploy.
- Comment on the ticket (`ticket_comment`) at claim (estimate and plan), at each pushed slice (commit, tests run and their result), and at each decision.
- Hand in with the closing summary (`ticket-flow`): what was done, with evidence links, and what was not verified. `ticket_close` is the verifier's, or the orchestrator's on the verifier's PASS; never the author's.
- Sub-agents report only in their final message, commits, files and tickets. They never message the main conversation. Chat to chat goes through `session_message`.

## Monitor

At every turn end, and at least hourly: sub-agents alive; CI runs (`ci_runs_list`, `ci_run_get`); quota (`claude_usage`); your tickets (`ticket_list`); free disk and temp space. Every bug or improvement found becomes a ticket at once.

## Never idle

- Idle means: no turn running while ranked work is open or a returned slice waits to be merged.
- When a sub-agent returns, dispatch the next slice in the same turn, then gate in the background.
- A wait (an approval, a CI run, quota) is never a reason to stop: start other work and check the wait later.
- Keep turns short and wait in the background: quota moves to another Claude happen only at a turn end.
- Blocked on a person: write it under NEEDS A HUMAN and take the next item.
- The same command failing three times: change the approach or move on, and write why.
- The only finished state is `TRACK COMPLETE`. A nudge to continue means: resume from the status file.

## After a restart or a move

A move to another Claude keeps the session; a restart starts a new one. Either way:

1. Read the status file.
2. Call `session_context` (when available) and read the standing decisions.
3. List your tickets (`ticket_list`): claimed, in progress, in review.
4. Run `git worktree list`; in each worktree run `git status -sb` and `git log --oneline origin/<integration>..HEAD`.
5. Save uncommitted work as a WIP commit on its branch and push it.
6. Restart each slice in flight with a new sub-agent from its pushed branch, on the same model unless it failed twice.
7. Write one DECISIONS line: what you found and what you resumed.
