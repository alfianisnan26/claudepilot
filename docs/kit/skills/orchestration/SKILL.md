---
name: orchestration
description: Use when you are the orchestrator chat of a program - planning a backlog into ranked tickets, dispatching sub-agents (the Agent tool) in git worktrees, choosing their model, integrating what they return, starting releases, keeping the status file - and after every restart of that chat. Gives the dispatch rules, the brief template, model tiers, integrate-fast and release-safe, the status file format, and the never-idle loop.
---

# Orchestration

One orchestrator chat per program runs the work as sub-agents of the Agent tool, each in its own git worktree. You plan, dispatch, check, integrate, release and keep the record. Nobody answers questions in real time: decide by the default, write it down, go on (`escalation`, `decisions`).

## 1. At start and after every restart

1. Read the status file first (it is the memory that survives a restart), then the charter, the standing decisions, the project's CLAUDE.md and the ticket queue (`ticket_list`).
2. Look at what is in flight: each worktree's `git status -sb` and its commits not yet on the integration branch. Keep what is good; save uncommitted work as a WIP commit and push it before anything else.
3. Fix stale ticket states: tickets assigned to an ended session, `in_progress` with nobody working (`ticket-flow`).

## 2. Plan in ranked tickets

- Every unit is a ticket with done criteria, a `rank-NN` tag and an estimate (`ticket-flow`). The queue lives in the status file's NEXT; tickets are claimed only when a slice starts.
- Cut work into slices a sub-agent finishes in about an hour (one to three items), each useful alone, the first one thin. You integrate between slices.
- Rank order is the order of work. Write a cut line in NEXT when the backlog is longer than the day: nothing below it starts first.
- Check the integration branch before dispatching an item: it may be done.

## 3. Dispatch

- **At most five sub-agents at once** (WIP limit five). Send the Agent calls in one message so they run in parallel.
- Each sub-agent works in its own worktree on its own branch (`ticket/T-n-slug`), never in the main folder or another agent's worktree. Use a prepared worktree, or the Agent tool's worktree isolation for a short task.
- The brief is **self-contained**: the sub-agent has not seen this chat. Use `references/brief-template.md`: goal, ticket, worktree and branch, files to read, the exact items, done criteria, the rules, what to report.
- **Pick the model per slice**, by what the slice needs, and write the choice in the status file next to it:
  - `sonnet`: narrow, well-specified, mechanical work (a sweep, a screenshot run, a PRD update, one test).
  - `opus`: ordinary implementation (a feature, a fix with its test, UI work).
  - `fable`: only diagnosis nobody else cracked (a hang's root cause, a security finding), or a slice that failed twice on a smaller model.
  - `haiku`: read-only search (the `explorer` role).
  Ties favour the cheaper model. Never one tier for everything.
- Every brief says, in these words or stronger:
  - Never print the environment in any form, never read credential files, never put a secret or a token-shaped literal anywhere.
  - Do not call SendMessage to the main conversation (until the portal accepts it: a queued peer message has ended an orchestrator for integrity). Report only in your final message, commits, files and ticket comments.
  - Commit small and often with the trailers; push your branch early (WIP included); never push the integration or main branch; never force push.
  - Run only your own tests and typecheck; no full gate, no production build. Heavy work goes through the project's job runner or the heavy lock.
  - The same command failing three times means change the approach or stop and report.
- **No `session_spawn` workers**: spawned sessions are never Bypass and are capped per workspace. Roles are sub-agents. Chat to chat goes through `session_message`, never SendMessage to another session.

## 4. Check and integrate fast

When a sub-agent returns:
1. Read its report critically: claims need evidence (`qa-verification`). An unusable result: write why in the status file and re-dispatch with a better brief rather than doing its job by hand.
2. Look at the diff. Read the risky parts yourself: authz, secrets, migrations, anything touching Bypass, the gates or integrity checks.
3. Merge into the integration branch (merge commits are kept; never discard somebody's lines), run the **quick gate** under the heavy lock (typecheck, the web build if the web changed, the touched areas' tests, not only the slice's own files), push. Fast-forward only; if refused: fetch, merge, check again.
4. Integrate at least every 8 commits or every 2 hours, so nothing piles up unpushed.
5. A slice that fails the quick gate goes back to its sub-agent with the failing output.
6. Independent verification of the delivered ticket is a different role's (`qa-verification`): route it to a verifier. Integrating is not verifying; do not close a ticket on the strength of a sub-agent's report. Close it (`ticket_close`) only on the verifier's PASS, quoting it; a sub-agent never closes the ticket of its own slice.

## 5. Release safe

- The **full gate** runs on the exact commit before every deploy, and in the background on the integration head about every two hours. A red full gate is fixed before the next merge: the integration branch stays shippable.
- Start the deploy pipeline (`ci_run_trigger`) only when a batch of user-visible work is integrated and the full gate is green on that commit, at the cadence the project allows, with the pipeline's gate input on. It is turned off only on the owner's own explicit word for that run, never because a deploy is urgent or a red test is "only flaky". Before pushing, check that no run waits for an approval (`ci_runs_list`) when the pipeline cannot survive a moved branch.
- The release waits for a person's approval (or a portal rule a person turned on). Never approve it, never work around it, never wait for it: carry on and look at the run later (`ci_run_get`, `ci_run_logs`).
- After a deploy goes live, list the tickets that went live in DONE, each with what was verified on the live target and what was not. Do not put device checks under NEEDS A HUMAN: optional checks are the agents' work, and a limit is stated on the ticket.

## 6. The status file

The format, the 80-line limit, the push cadence and `TRACK COMPLETE` are in the `work-rhythm` context (the one home for them). The orchestrator adds: the model and what is left per slice in IN FLIGHT, the cut line in NEXT, the program's checklist ticket linked in NEEDS A HUMAN (required items only). A real example is in `references/example-status.md`.

## 7. Commit and push WIP early

Sub-agents stop when the chat restarts, moves to another account or ends; anything not pushed is lost. Push the status file and every sub-agent branch at each checkpoint (`work-rhythm`).

## 8. Never idle

- When a sub-agent returns, dispatch the next slice at once; gate in the background.
- A blocked ticket, a waiting approval or an unanswered question is never a reason to stop: take the next ranked ticket.
- When nothing is dispatchable, say exactly why in the status file (every remaining ticket blocked, and on what).

## Self-check (each round)

- At most five sub-agents run; each brief was self-contained and named the model and the rules.
- The integration branch is green on the quick gate; the full gate ran within two hours or before the last deploy.
- The status file is current, under 80 lines, pushed; NEEDS A HUMAN holds required items only.
- No agent waits idle; no ticket is `in_progress` without a live worker.
