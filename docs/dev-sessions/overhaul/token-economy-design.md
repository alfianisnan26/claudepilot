# Token economy and the "pilot factory": design for review

Status: DRAFT for the owner, 2026-10-14. Author: coordinator. Source of every number: the portal's usage report, the session tapes in the pod (11,575 deduplicated assistant messages, 12,582 tool results), ticket data and git of the first 22 hours (docs/dev-sessions/evaluations/2026-10-14-system-efficiency.md, token-discipline.md). Savings are ESTIMATES until measured against the baseline below.

## 1. The problem in one equation

Cost of a session is approximately sum over requests of (context size x cache-read price) plus every new token written once to the cache (twice the input price on the 1 hour cache) plus output. Measured: cache read about 55 percent, cache write about 32 percent, output about 13 percent. Requests: 89 percent of sub-agent requests are Bash round trips at a p50 context of 105 k tokens; the orchestrator chats run at 156 k (p90 430 k). A long tool output is paid for again on every later request. So only three things move the bill: FEWER REQUESTS per unit of work, SMALLER CONTEXT per request, a CHEAPER MODEL per request. Everything below pulls one of those levers, or removes work that should not exist (idle, failed, repeated).

Baseline (22 h): $753; opus 82 percent, fable 17 percent, sonnet 1.4 percent; 57 tickets resolved (about $13 to $17 each); 25 percent of the time nothing ran; 12 of 19 ClaudePilot deploys not green.

## 2. Where the money goes (and what is waste)

| Bucket | Share | Reading |
| --- | --- | --- |
| Sub-agent requests | 79 percent of cost | the real work, but 40 percent of their Bash calls are inspection, git reads, api checks and waiting |
| Orchestrator chats | 21 percent | 49 percent of that is hands-on Bash at a 156 to 430 k context: work that belongs to a sub-agent or a script |
| Test, build, run | 26 percent of sub-agent Bash | legitimate; the lever is output size and no repeats |
| Inspection (cat, ls, grep, head) | 23 percent | replace by a generated context pack and batching |
| Idle and failed (outside the bill, inside the time) | 25 percent of wall time | availability tickets T-259, T-277, T-255, T-256, T-257, T-270 |
| Rework (integrity endings, red deploys, reopened) | unmeasured | each ending rebuilds a 100 to 300 k context |

## 3. Target architecture: orchestration as code, judgment as agents

Today an LLM chat (the orchestrator) does the plumbing: picks the ticket, writes briefs, polls, merges, posts status. That plumbing is deterministic, so it should be CODE, and the model should be used only where judgment is needed. The "pilot factory" is a per-ticket pipeline run by a small deterministic engine (the portal's scheduler; as a first step Claude Code's Workflow scripts or a node script driven by the supervisor):

1. INTAKE (code): take the next ranked ticket within the WIP and budget limits; read its size from the ESTIMATE comment; create the worktree and branch; generate the brief from a template.
2. PLAN (explorer, haiku or sonnet, 30 lines out): reads the context pack plus the ticket and returns the files and line ranges to touch and the tests to run. Skipped for small tickets.
3. IMPLEMENT (opus, scoped, token budget from the estimate): starts from the plan, not from a blank repo. One request budget, one context budget; when exceeded it stops and reports (the engine escalates, never silently continues).
4. CHECK (code): `scripts/slice-check.sh` runs typecheck and the touched areas' tests and prints at most 20 lines. No model.
5. REVIEW (sonnet on the DIFF only, opus for security, auth, migrations): input is the diff and the ticket, a context of a few thousand tokens, not the repo.
6. VERIFY (sonnet, harness on the deployed result, evidence as files): independent role, never the author.
7. INTEGRATE (code): merge, quick gate, push; the full gate as a cluster Job; deploy by the pipeline in batches (at most three portal deploys a day).
8. LEARN (sonnet, once a day): reads ESTIMATE against ACTUAL comments, the scoreboard and the incident list; proposes changes to briefs, skills and templates as a pull request; adopted only after an experiment (charter).

The orchestrator chat shrinks to an exception handler: conflicts, decisions with no written default, escalations. Its context stays small because it no longer carries the plumbing. Expected effect: the orchestrator share of the bill falls from 21 percent to about 8 percent, and integrity endings of the main chat stop dominating because nothing long-lived depends on it.

## 4. The levers, ranked by estimated saving per unit of effort

| # | Lever | Mechanism | Est. saving of total | Effort |
| --- | --- | --- | --- | --- |
| 1 | Availability (no idle, no re-built contexts) | T-259 watchdog in the portal, T-277 integrity fix, T-255, T-256, T-257, T-270 | output per dollar +25 percent | in progress |
| 2 | Context pack | a generated file (architecture map, routes, commands, conventions, where things live), at most 6 k tokens, rebuilt by CI at each merge; agents read it first instead of exploring | 8 to 12 percent (inspection is 23 percent of sub-agent Bash) | small |
| 3 | Task scripts and macro tools | `slice-check.sh`, `commit.sh` (adds the trailers), `integrate.sh`, `status.sh`; Portal MCP `ticket_start`, `ticket_finish`, `ci_wait` (blocks, no polling); each replaces 3 to 10 round trips | 8 to 12 percent | small to medium |
| 4 | Output budgets | `quiet.sh`, `BASH_MAX_OUTPUT_LENGTH=8000`, compact MCP results (T-282); a 5 k character cap trims 34 percent of result characters | 5 to 10 percent | done in part |
| 5 | Model by role | agent definitions with fixed models; explorer on haiku, review and verification on sonnet; opus for implementation and security | 10 to 15 percent | done, to be enforced |
| 6 | Diff-only review and verification | the reviewer never loads the repo; the verifier runs a harness and reads its summary | 3 to 5 percent | small |
| 7 | Stable cache prefix | the system prompt, CLAUDE.md and the primer identical across agents of a program, volatile facts only in the user message: the first agent writes the cache, the rest read it at a tenth of the price; never edit CLAUDE.md in the middle of a busy hour | 3 to 6 percent | small |
| 8 | Quota-aware concurrency | agents allowed by the projection at reset (under 60 percent five, 60 to 90 three, above one or two); deploy batching | avoids stalls and re-builds | done as a rule |
| 9 | Per-ticket token budget | size S, M, L, XL from the ESTIMATE comment maps to a request and context budget; the engine stops at 150 percent, writes why, and the overrun feeds the scoreboard | caps the tail (the worst tickets) | medium |
| 10 | Orchestrator as exception handler | the factory engine above | 8 to 12 percent | large (phase 2) |

Sum of 2 to 7 with overlap: about 30 to 40 percent of spend for the same output; with 1 and 10 the output per dollar roughly doubles. These are estimates; the experiment in section 6 settles them.

## 5. Rules that stay (from the charter)

Quality bars first: independent verification with evidence, no weakening of gates, the walls (safety rules, deny rules, authz, Bypass gates, gates, scoring) are never touched by the learning loop. Cheaper is adopted only when the quality terms do not fall. Human questions stay rare: only required escalations (D-10, D-34).

## 6. Rollout and measurement

Phase 0, done 2026-10-14: token discipline, quiet.sh, output limits, model by role, quota-aware concurrency, deploy batching, estimate and actual comments.
Phase 1, this week: context pack generator and CI hook (ClaudePilot first, then Konfersi, Event); the four task scripts; Portal MCP macro tools and compact results (T-282); token budget from the size; the scoreboard v0 computed by the coordinator from tapes and usage (requests per slice, p50 context, inspection share, cost per ticket against estimate).
Phase 2, next: the factory engine on ONE program (Event, which is new and has no legacy): tickets run as pipelines, the orchestrator chat only for exceptions; compare cost per ticket, time per ticket and defects against the same program's phase 1 numbers and against ClaudePilot's chat-driven numbers.
Phase 3: if phase 2 wins on cost AND quality, move the engine into the portal (the watchdog and scheduler of T-259) for all programs; the chat orchestrator becomes optional.

Success metrics (weekly, from the same sources as the baseline): cost per resolved ticket (target minus 35 percent), requests per slice (minus 40), p50 context per request (under 80 k), inspection share of Bash calls (under 10 percent), sonnet share of cost (over 25 percent), idle hours (under 5 percent), red deploy share (under 15 percent), predictability (ESTIMATE against ACTUAL within a factor of 1.5 for 70 percent of tickets), escaped defects (not up).

## 7. Risks

A smaller context can drop a fact the agent needed: the context pack is generated, and the plan step names the files, so omissions show up as failing checks, not silent errors. A token budget that stops work too early: the engine stops and asks, never discards. A deterministic engine is code to maintain: keep it small, test it with negative twins, review it independently because it dispatches agents. The cache prefix rule fails if CLAUDE.md changes often: change it in batches. Quota is the binding limit, not dollars: the plan accounts have windows (session and weekly per model); the scheduler reads the projection, as D-39 does for moves.

## 8. Decisions the owner may want to make

(a) Phase 2 on Event first: default yes. (b) The program budget split (ClaudePilot, Konfersi, Event): default 40, 25, 35 percent of the day's spend. (c) Whether the engine lives in the portal (phase 3) or stays a script run by the supervisor: default decided by the phase 2 numbers. Nothing here needs a secret or a permission.
