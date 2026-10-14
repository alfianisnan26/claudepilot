---
name: efficiency
description: Use when a unit of work starts (to name its task type and size, read the adopted playbooks and estimate it), during long or expensive work (to avoid idle burn, retry storms, context bloat and running everything on every edit), and after finishing it (the one-line reflection). Gives the owner's objective in order of weight, the spikes to avoid, the checkpoint rule, and how cost is attributed - without ever trading verification for speed.
---

# Efficiency

The objective, in the owner's order: **many** things done, at **good quality**, to the **proper standards**, with **few questions** to a human and **few comments or bug reports** from the human afterwards. Tokens and money are the third term, never the first. A unit is ranked only after it passes the hard bars (gate green, independent QA with evidence, the standards check). A cheap unit that comes back reworked is not efficient.

**Never trade verification for speed.** Skipping a test, a screenshot, the gate or QA to save tokens voids the unit; the saving is counted as waste.

## 1. Before starting

1. **Name the task type and size** in your claim comment: bugfix, feature, UI/phone, refactor, test and QA sweep, performance, infra and CI, docs and PRD, deploy and release, research and diagnosis, data. Size S, M, L or XL.
2. **Read the adopted playbooks** for that type: `playbook_search` (when available); until then search the knowledge vault's playbooks folder (`note_search`). Use an adopted entry; ignore a proposal or a refuted one unless you are told you are in its experiment.
3. **Estimate** (the structured estimate in `ticket-flow`), and look at your own calibration for the type (`scoreboard_me`, when available).
4. **Pick the smallest tool and model that does it well**: a cheaper model for a narrow sweep, the stronger one for diagnosis; ties favour the cheaper model.

## 2. Avoid the spikes

| Spike | What it looks like | Do instead |
| --- | --- | --- |
| Idle burn | turns that produce no commit, comment, run or file change; polling a run in the foreground | wait in the background; take the next ticket; end the turn |
| Retry storm | the same tool call or test run failing three times unchanged | after the third failure change the approach, or stop and report why |
| Context bloat | a chat whose context keeps growing: whole files re-read, long logs pasted, many hours of turns | read the part you need; trim logs to the failing lines; checkpoint and restart from the status file |
| Whole suite per edit | the full test suite or a production build after every small change | run the touched files and the touched areas' tests; the full suite runs in the gate |
| Model mismatch | the top tier on a mechanical sweep | the tier that fits the slice (`orchestration`) |
| Fan-out | more sub-agents than the WIP limit, two agents on the same files | at most five at once, disjoint files |
| Duplicate work | building what is already on the integration branch or in another ticket | check the branch log and the queue first |
| Heavy work in the shared pod | builds and suites competing for the same CPUs | the project's job runner, or the heavy lock, one at a time |

The portal's usage tools show what you spent and on what: `usage_summary`, `usage_attribution`, `usage_spikes`; your own terms against the median of similar units with `my_efficiency` (when available). An in-flight steer from the portal (when available: "this turn has cost X: stop repeating, checkpoint, report") is obeyed at once.

## 3. Checkpoint long chats

- Keep turns short: long waits in the background, so the portal sees turn boundaries (quota moves and restarts happen there).
- At each natural break, and whenever the context is large: commit and push WIP, write the status file or a ticket comment with what is done and what is next, so a fresh chat can continue from it without re-reading everything.
- A chat asked to checkpoint (by the portal or the orchestrator) does it in the same turn.

## 4. After each unit: one reflection line

On the ticket, one line (the `peer-review` reflection holds the full form):

```
Reflection: did <technique>; cost <tokens or hours, and the biggest item>; next time <one change>.
```

It feeds the retro, which turns recurring lines into playbook proposals. Proposals are tested before they are adopted; you never adopt your own.

## 5. How cost is counted (the scoreboard's rules; the scoreboard is planned)

- Cost is attributed to the **delivered unit** (the ticket, through the chat and the commit trailers), not to the turn. Splitting a task into many small turns or tickets changes nothing; size weighting catches split-ups.
- Rework counts against the unit that caused it: a reopened ticket, a fix on the same files soon after, a failed verification.
- An unknown cost is "unavailable", never zero, in anything you report.
- An expected spike (the estimate said L or XL and the cost is within it) is not waste. Say so in your reflection when it happens; a wasteful spike you did not mention costs your honesty term.

## Self-check

- I named the task type and size and read the playbooks before starting.
- No command failed three times unchanged; no foreground polling; no whole-suite run per edit.
- My WIP is pushed and a fresh chat could continue from the status file or the ticket.
- Every check the done criteria require was run; nothing was skipped to save tokens.
- The reflection line is on the ticket.
