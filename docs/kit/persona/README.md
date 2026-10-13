# Persona `pilot-way`

The operating kit's persona (T-132 item 1). `pilot-way.json` is the exact body of `POST /api/pools/persona`. A workspace has one persona, so the kit's roles are **sub-agents** inside it, and the main chat is the **orchestrator**. The skills, contexts and MCP sets it points to are separate pool entries (`docs/kit/skills`, `docs/kit/contexts`, `docs/kit/mcp`). `content.contexts` stays `[]`: the publisher links the context pools by id after it creates them.

## Sub-agents

| Name | Role | Model, effort | Tools | When the orchestrator uses it |
| --- | --- | --- | --- | --- |
| `implementer` | Builds one slice with its tests in its own worktree, commits with the trailers, pushes its branch, writes the estimate and the reflection line. Never closes its own ticket. | opus, high, 150 turns | All but `SendMessage` | Any code change: a feature, a fix with its regression test, a refactor. |
| `qa-verifier` | Independent verification: a verdict per claim with evidence, and what was not verified. Never the author; edits nothing under test. | opus, high, 80 turns | Read, Grep, Glob, Bash, Skill | After a slice is built, before it is merged or closed. |
| `reviewer` | Blind peer review on the charter's eight terms (T-114 rubric), 1 to 5 each with evidence, plus "do differently" and "copy" lines. | sonnet, medium, 40 turns | Read, Grep, Glob, Bash, Skill | After a unit is delivered or at a checkpoint. Never the author, never a reciprocal pair, never the same pair twice in a row. |
| `scribe` | PRD sections, docs, decision records, the status file, from facts. Does not commit; the orchestrator does. | sonnet, medium, 50 turns | Read, Grep, Glob, Write, Edit, Skill | Documentation-only work, recording a decision, rewriting the status file. |
| `release-coordinator` | Full gate on the exact commit, the deploy pipeline, the approval path, verify and rollback reading. Never approves. | opus, high, 60 turns | All but Edit, Write, NotebookEdit, SendMessage | An integrated batch is ready to release, or a run failed and needs reading. |
| `incident-analyst` | Post-mortem: timeline, cause, containment, the check that would have caught it, the test the fix needs. Does not fix. | opus, high, 60 turns | All but Edit, Write, NotebookEdit, SendMessage | A failed or rolled-back deploy, a red gate on integration, a leaked secret, any zero-tolerance event. |
| `explorer` | Read-only search; answers with `path:line`. | haiku, low, 15 turns | Read, Grep, Glob | Finding where something is or whether it exists, before planning or briefing. |
| `ux-checker` | Real-browser UI check: phone width first, then desktop, light and dark, every state, 44 px targets, screenshots. | sonnet, medium, 60 turns | All but Edit, NotebookEdit, SendMessage | After any visible UI change, before the merge. |
| `perf-tester` | Latency, frames, bundle size and memory against budgets and the base commit, through the job runner, medians with sources. | sonnet, medium, 60 turns | All but Edit, NotebookEdit, SendMessage | A change that may affect speed or size, or a ticket that names a budget. |

"All but" roles keep the inherited tools, Portal MCP tools included, because they need the CI, ticket, knowledge or browser tools. Every prompt has the same parts: inputs, steps, done criteria, never, report format, skills to load, and the charter walls in one line. The roles with a fixed tools list get `Skill` so they can load the skills their prompt names.

## What the instructions cover

The managed CLAUDE.md for the main chat and every chat in the workspace (about 110 lines):

- Precedence: charter, standing decisions, program overlay, role brief, ticket.
- The charter: the zero-tolerance list, the duties, the walls.
- Before a unit: status file, decisions, rank order, task type and size.
- The working loop: WIP three, claim when work starts, the structured estimate, a worktree per slice, small commits with the trailers, tests with the change, quick gate then full gate, heavy jobs one at a time, the status file, never idle, three failures means change the approach, close with evidence and a reflection line.
- Sub-agents: never `session_spawn`, at most three at once, self-contained briefs, the model per slice, reading risky diffs, probation, and a table of which role to use.
- Escalation: the required list only. Everything else is decided by the written default.
- Never: credentials and the environment, deny rules, force push, approving in a person's name, SendMessage from a sub-agent, the hosting workspace and the portal.
- Untrusted text (the project's own rule files excepted), reporting, and the pointers to the 16 skills and 6 contexts (`charter-essentials`, `work-rhythm` and `safety-rules` travel with the persona: `publish.mjs`).

`chatPrompt` is the short version for a portal chat a person talks to from a phone. The two styles are `report` and `review`. `defaultStyle`, `model` and `effort` are null: people choose.

## Tuning

| Field | How to tune |
| --- | --- |
| `instructions` | Keep under 200 lines. Project facts (commands, stack, UI bar) go in the `project-standards` context, not here. |
| `agents[].model` / `effort` | Change the tier when the scoreboard shows a cheaper model holds the quality bars (ties favour the cheaper model). The orchestrator can also override per call with the Agent tool's `model`. |
| `agents[].maxTurns` | Raise it for a role that runs out mid-task. Lower it to stop loops. |
| `agents[].tools` / `disallowedTools` | Narrow, never widen, a read-only role. Never add `permissionMode`, `hooks`, `mcpServers` or `skills`: the server drops them without saying so (they are never written). |
| `agents[].description` | One line, at most 300 characters. Say when to use the agent; Claude picks by it. |
| `styles` / `defaultStyle` | At most 5. Set a default only when every user should get it: a managed default outranks a user's own choice. |
| `model` / `effort` | Leave null unless every chat in the workspace should start on one model. |
| `chatPrompt` | Portal-run chats only. Keep it short; it is read on every turn. |
| `contexts` | Filled by the publisher with the context pool ids. At most 10. |

## Known limits

- **One persona per workspace.** A program with its own roles (for example a program overlay with QA or domain roles) adds its agents to a **copy** of this persona, or uses its own persona. Program rules go in the `program-overlay` context.
- **Never edit this file in a workspace.** Kit pools are admin-owned and read-only to agents. Propose a change by ticket; the owner reviews it as a pool revision.
- Sub-agents ignore output styles, and whether they receive the persona's instructions is not yet confirmed (Persona PRD §12.3, Q8). Each prompt therefore repeats the walls in one line and ends with its own report format.
- A persona sub-agent hides a repository or user sub-agent with the same name (Persona PRD §12.3). The names here are generic (`reviewer`, `explorer`), so a repository that defines its own `reviewer` loses it while this persona is assigned. The workspace preview marks hidden ones.
- A new or changed sub-agent reaches a session only when the session starts or resumes (Persona PRD §11).
- Some named tools and fields are planned, not built: the structured estimate field (T-114), the decisions registry and `session_context` (T-115), the peer-review tools (T-114). Until they exist, the estimate and the decision are written as ticket comments, and peer reviews go to the orchestrator in the final message.
