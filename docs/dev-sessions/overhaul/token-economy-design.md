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

## 4. The levers, ranked by MEASURED saving (evidence in section 9)

| # | Lever | Evidence | Saving of the bill | Effort | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | One hour prompt cache for sub-agents | Sub-agent cache writes are 100 percent 5 minute TTL (66.7 M tokens) while main chats are 100 percent 1 hour; 47.1 M tokens (65 percent of all cache writes, 46.1 M of them in sub-agents) re-write context after a 5 to 60 minute gap (median 10 min). Claude Code 2.1.296 itself: sub-agent TTL is 5 minutes unless ENABLE_PROMPT_CACHING_1H=1 or CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h. | about 15 percent (computed: writes 66.7 M x 1.25 = 83 M units today against 19.6 M new x 2.0 = 39 M units with 1 h; rewrites vanish) | one variable | SET in pool agent-limits 2026-10-14 (ENABLE_PROMPT_CACHING_1H=1); applies when a Claude process starts; verify by experiment (section 6) |
| 2 | Cap tool results | counterfactual replay of all 184 threads: a cap of 5,000 characters saves 8.9 percent of input-side cost, 8,000 saves 5.7, 15,000 saves 2.3 | about 5 percent at 8,000 | one variable | SET (BASH_MAX_OUTPUT_LENGTH=8000, MAX_MCP_OUTPUT_TOKENS=5000) |
| 3 | Batch consecutive inspection, git-read and api calls | counterfactual: only the re-read of the removed requests' context counts: 3.1 percent (more with their writes and output) | 3 to 5 percent | discipline and task scripts | rules sent; scripts in phase 1 |
| 4 | Model by role | request cost ratio opus to sonnet about 12 to 1 (not like for like), sonnet share went from 1.4 percent to about 10 percent in the first hour after the order | to be measured; 10 to 15 percent is an estimate | agent definitions | done, being measured |
| 5 | Orchestrator chat as exception handler | main chats are 21 percent of cost, 49 percent of that hands-on Bash at 156 to 430 k context | 3 to 8 percent (estimate) | phase 2 | designed |
| 6 | Availability (no idle, no re-built contexts) | 25 percent of wall time idle; 6 endings | output per dollar, not dollars | in progress | T-259, T-277, T-255, T-256, T-257, T-270 |

Evidence-based total of 1 to 3: about 23 to 25 percent. With 4 and 5 (estimates): 30 to 40 percent. Earlier claims in this document that were NOT supported by the replay were withdrawn: a rule against short sub-agent runs (runs of 8 requests or fewer are 3 percent of runs and 0.1 percent of cost) and the 10 to 12 percent expected from a context pack (not measured; the inspection share of Bash calls is 23 percent of read cost, but replay shows batching returns about 3 percent).

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

## 9. Evidence (reproducible, read only)

All numbers come from the portal's raw session tapes and usage report. Scripts: `docs/dev-sessions/overhaul/evidence/`. Run them inside the workspace pod: `kubectl -n isnan-claudepilot-workspaces exec -i <pod> -c workspace -- python3 - < <script>`.

- `tape_counterfactual.py` (11,869 assistant messages, 184 threads: 29 sessions plus their sub-agents): savings of capping tool results at 5,000 / 8,000 / 15,000 characters (8.9 / 5.7 / 2.3 percent of input-side cost), of batching consecutive inspection calls (3.1 percent), and sub-agent size: 155 sub-agent runs, median 49 requests, runs with 8 requests or fewer are 3 percent of runs and 0.1 percent of cost, the first request of a sub-agent is a median 12 k units.
- `tape_cache_breaks.py`: cache writes 72.3 M tokens; 47.1 M (65 percent) re-write context after a cache miss; 46.1 M in sub-agents, 1.0 M in main chats; the gap before the miss is 5 to 60 minutes (46.5 M tokens), under 5 minutes 0.4 M, over 60 minutes 0.2 M, median 10 minutes.
- TTL split (inline in this document's author's session, same method): main chats write 5.7 M tokens, 100 percent 1 hour TTL; sub-agents write 66.7 M tokens, 100 percent 5 minute TTL.
- Cost shape (calibrated to the usage report): cache read about 55 percent, cache write about 32 percent, output about 13 percent; main chats 21 percent of cost, sub-agents 79 percent; sub-agent Bash calls 8,458: test and build 26 percent, inspection 23, other 17, edit by script 10, git read 6, api 6, waiting 6, git write 6 (percent of read cost); main chats 1,287 Bash calls: git write 28, test 23, inspection 18.5, git read 14.
- Tool results: 12,582 results, p50 786 characters, p90 6.5 k, p99 22 k; Bash is 80 percent of result characters, Read 8.8, ticket_get 5.5.
- Claude Code behaviour: the installed 2.1.296 settings schema states: sub-agent, workflow, background and helper requests use a 5 minute cache unless ENABLE_PROMPT_CACHING_1H=1, and CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL ("5m" or "1h") takes precedence; the main conversation is automatic: 1 hour on a subscription within its limits.
- Limits of this evidence: the output share is calibrated, not read from the tapes (the stream snapshot undercounts output); cost weights are the standard cache price ratios (read 0.1, write 1.25 or 2.0, output 5); the replay does not change what the agents would have done; the coordinator's own VS Code session is not in the tapes; quota (windows per account), not dollars, is the binding limit.
- Experiment to confirm lever 1 (owner can ask for the numbers at any time): after the Claude processes restart with ENABLE_PROMPT_CACHING_1H=1, rerun `tape_cache_breaks.py` and the TTL split on tapes written after the restart; expected: sub-agent writes mostly 1 hour TTL, re-written tokens under 10 percent of writes. If the variable has no effect, the alternative is the managed setting or CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL through the policy owner (the secrets pool refuses CLAUDE_* names).
