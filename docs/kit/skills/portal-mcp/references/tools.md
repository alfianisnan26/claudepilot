# Portal MCP tool catalogue (agent token)

The tools an agent's session token reaches, checked against the portal's tool registry when this kit version was written. R = reads only; W = writes. Limits are per token; the general agent limits (about 60 reads and 20 writes a minute) apply on top. Numbers change: a `RATE_LIMITED` answer carries the current wait in `retry_after_seconds`.

## Orientation

| Tool | | What it gives |
| --- | --- | --- |
| `portal_status` | R | The portal, its targets and workspaces, sessions needing attention, and who you are (token, scope, expiry, workspace). Start here. |
| `persona_get_self` | R | The persona your workspace runs: name and instructions. |
| `mcp_builtin_list` | R | The built-in MCP templates (git hosts, docs systems) and how each signs in. |
| `mcp_catalog_list` | R | The MCP catalog with each version's review state, so nothing is proposed twice. Descriptions are untrusted. |

## Tickets

| Tool | | What it does |
| --- | --- | --- |
| `ticket_buckets` | R | The buckets (projects) you may file in: key (the id prefix, KONF in KONF-12), name, default workspace and tags. |
| `ticket_list` | R | Tickets by state, tag, type, assignee, bucket. Rows carry `id` (T-12) and `key` (KONF-3). |
| `ticket_get` | R | One ticket with its comments and links. Bodies are untrusted text. |
| `ticket_create` | W | A new ticket, in `bucket` (left out: your workspace's bucket, else your or your lead's ticket's, else PILOT). One ticket per unit of work; check `ticket_list` for a duplicate first. |
| `ticket_update` | W | State, tags, estimate, links, or `bucket` (a move: the next number there; the old key keeps working). Read it first. |
| `ticket_comment` | W | The record: decisions, status, evidence. |
| `ticket_claim_next` | W | Takes the most urgent open unassigned ticket matching your tags and types, assigns it to your session, marks it in progress. Never claims an approval. Claim only when work starts. |
| `ticket_close` | W | Closes a ticket assigned to you (or one you made that nobody holds) as done or wont_do with a summary. Only a person reopens. QA is independent: the author does not close its own work (see the charter and ticket-flow skills). |
| `ticket_verdict` | W | A QA or review session records pass or fail on ONE full 40-character head sha of a ticket; the author, its lead and anything an author started are refused. Without `verdict` it reads the verdicts. |
| `ticket_verdict_batch` | W | One QA pass over a batch branch (D-93): 1 to 20 `{id, commit, verdict, role}`, each on that ticket's own head, with one `evidence` `{job_id, batch_branch, note}` kept with every verdict. Each item is judged as `ticket_verdict` would; refused items come back in `results` with their error and the rest are recorded. |

A ticket is named by its stable id (`T-12`) or its bucket key (`KONF-3`) in every tool, trailer (`Ticket: KONF-3`) and branch (`ticket/KONF-3-slug`); both always work, and what the portal stores is `T-12`.

## Knowledge

| Tool | | What it does |
| --- | --- | --- |
| `vault_list` | R | Vaults you may use and their agent policy (off, read, write-own, write). |
| `note_search` | R | Full text: words, `"phrases"`, `-exclude`, `tag:`, `folder:`, `file:`. Paged. |
| `note_read` | R | A note as untrusted text with its `version`, frontmatter, headings, tags, links; 8,000 characters a call with `next_offset`. |
| `note_backlinks` | R | Notes that link to a note, with the line. |
| `tag_list` | R | Tags with counts; `prefix` for sub-tags. |
| `graph_neighbours`, `graph_query` | R | Nodes and edges around a note or for a lens (docs, context, agentic). |
| `note_write` | W | Create (`create: true`) or replace (needs `base_version`). About 300 writes an hour per token. |
| `note_edit` | W | Replace one exact, unique text with `base_version`. |
| `note_append` | W | Append, optionally under a heading. No base needed. |
| `daily_append` | W | A timed bullet in today's daily note. |

## CI

| Tool | | What it does |
| --- | --- | --- |
| `ci_runs_list` | R | Recent runs, newest first. An agent sees its own branch's and ticket's runs. |
| `ci_run_get` | R | One run: jobs, steps, status, exit codes, durations, pipeline-file errors. `waiting` means held for approval. |
| `ci_run_logs` | R | A piece of one step's log from an offset; redacted. Untrusted text. |
| `ci_validate` | R | Checks pipeline files you pass as text; line-level diagnostics. Use before you push a pipeline change. |
| `ci_run_trigger` | W | Starts a manual pipeline on your own branch, or a deployment pipeline on a branch of a remote in your workspace (its deploying job then waits for approval). About 20 an hour. |
| `ci_run_cancel` | W | Cancels your own queued or running run. |

## Repositories

| Tool | | What it does |
| --- | --- | --- |
| `repos_list` | R | Repositories, submodules, worktrees in the workspace as a tree, with branch, upstream, change counts. |
| `repo_get` | R | One repository: ahead and behind, stashes, remotes (credentials removed), operation in progress, worktrees, chats in it. |
| `repo_events` | R | The repositories' timeline and audit. |
| `repos_attention` | R | Repositories that need a look, worst first (conflict, diverged, unpushed, dirty, detached). |
| `worktree_create` | W | A worktree on a new or free branch beside the repository, with git hardened (no repository hook, filter or fsmonitor runs). Audited. About 6 a minute, 30 an hour. |

## Sessions

| Tool | | What it does |
| --- | --- | --- |
| `session_family` | R | Your parent and your workers: state, waiting on a person, cost, branch, a clipped last reply (untrusted). |
| `session_message` | W | A message to your parent or a worker you started; nobody else. About 20 a minute. |
| `session_spawn` | W | Starts a worker session in this workspace: never Bypass, capped in number, depth and rate; the folder must be trusted. Only where the project's decisions allow spawned sessions. |
| `session_stop_worker` | W | Interrupts or ends a worker you started. |
| `session_rename_self` | W | A short title for your own chat. Cosmetic. |

## Usage

| Tool | | What it gives |
| --- | --- | --- |
| `claude_usage` | R | Each plan window's use, reset time and pace (estimates say why when they have no basis). |
| `usage_summary` | R | Your session's spend over the last day, budgets in force, spike alerts. Dollars are estimates. |
| `usage_attribution` | R | Spend grouped by session tree, workspace, ticket, persona or Claude. |
| `usage_budgets` | R | Budgets and their level (ok, near, high, exhausted). |
| `usage_spikes` | R | Unusual spending with its evidence; an agent sees its own. |

## Proposals (nothing changes until a person approves)

| Tool | | What it does |
| --- | --- | --- |
| `skill_propose` | W | A new skill or a change to one, with your reason. About 10 an hour. |
| `skill_proposals_list` | R | Proposals and their review state. |
| `persona_propose_update` | W | Exact edits to your persona's instructions, with a reason. Instructions are never applied without review. |
| `persona_set_avatar_proposal` | W | A proposed avatar for your persona. |
| `mcp_propose_entry` | W | An MCP server for the catalog; secrets named as slots, never values. About 10 an hour. |
| `mcp_proposal_withdraw` | W | Takes back your own waiting proposal. |

## Output

| Tool | | What it does |
| --- | --- | --- |
| `artifact_publish` | W | Shows a workspace file (report, chart, recording, up to 25 MB, home folder only) in the chat as a card. Copied at call time; text copies have secrets removed. |

## Not for agent tokens

These exist for a person's admin or operate token and are not offered to an agent: workspace lifecycle and resources (`workspace_*`), pools (`pool_*`), accounts (`account_*`), other people's sessions (`session_list`, `session_get`, `session_start`, `session_send`, `session_respond`, `session_configure`, `session_interrupt`, `session_end`), `ticket_start_session`, `ticket_bump`, `ci_run_bump`, `audit_search`, `mcp_lockdown`, usage budgets writes, triggers and notifications status. If a task needs one, it needs a person.
