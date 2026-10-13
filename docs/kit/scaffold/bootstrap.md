# Bootstrap a new project with the operating kit

The ordered procedure for the person or the tool that creates a project. Every step says what it needs from the
owner. After step 9 the target is **zero human touches** except the required escalations and the approvals of
protected deploys.

Before you start: the kit is published to the portal (`docs/kit/README.md`, "Publishing") and you know its
version (`docs/kit/VERSION`). Fill in `PLACEHOLDERS.md`'s values for this project first; you need them in step 2.

## The steps

| # | Step | Needs from the owner | Required escalation |
| --- | --- | --- | --- |
| 1 | Create the repository | The name, and the git host if it is not local only | Secrets (host credential), if a remote host |
| 2 | Apply the template | The placeholder values (the brief, the stack, the commands) | No |
| 3 | First commit and the branches | Nothing | No |
| 4 | Create the workspace with the kit's pools | Approval of each third-party MCP set (review); a Claude sign-in for the workspace | Permissions |
| 5 | Secrets pool entries, by name | The credential values, pasted into the portal by the owner only | Secrets |
| 6 | The CI remote and the environments | Switching stg protection off (once) | Permissions |
| 7 | The first tickets | Nothing | No |
| 8 | The orchestrator chat: Bypass and Keep going | The Bypass acknowledgement; the Keep going lease | Permissions |
| 9 | The first prompt | Nothing | No |

### 1. Create the repository

First open a ticket "Bootstrap {{PROJECT}}" (Tickets page): its id goes in the first commit's `Ticket:` trailer,
and the measurements below go on it. Note the time: it starts the clock.

- **In the portal** (when the New project flow is available): Source "Create a new repository", name
  `{{PROJECT}}`, default branch `{{DEFAULT_BRANCH}}`, folder `{{PROJECT_DIR}}`, the CI remote on. Or "From a
  template" with `pilot-way`, which does steps 1 to 3.
- **By hand** in a workspace terminal: `git init -b {{DEFAULT_BRANCH}} {{PROJECT_DIR}}`.
- A remote host (GitHub, Gitea, GitLab): create the empty repository there, add it as `origin`, and protect
  `{{DEFAULT_BRANCH}}` on the host if it can (no force push, no deletion). The credential for it is a Secrets pool
  entry (step 5), never a URL with a token in it.

### 2. Apply the template

1. Copy `docs/kit/scaffold/` into the repository, except `bootstrap.md`, `PLACEHOLDERS.md` and
   `first-tickets.json` (they stay in the kit).
2. Drop the `.tmpl` suffix: `CLAUDE.md`, `docs/README.md`, `docs/dev-sessions/{README,orchestrator,DECISIONS}.md`,
   `docs/design/README.md`, `.pilot/gate.yml`, `.pilot/deploy.yml`.
3. Replace every placeholder in every copied file with its value (`PLACEHOLDERS.md` lists them). Replace only
   `{{` + an upper-case name + `}}`: `${{ ... }}` in `.pilot/*.yml` is a pipeline expression and stays.
4. Check: `grep -rnE '\{\{[A-Z_]+\}\}' .` prints nothing; `node -e 'JSON.parse(require("fs").readFileSync(".claude/settings.json","utf8"))'`
   succeeds; the portal's CI validator accepts `.pilot/*.yml` (Remotes, or the Portal MCP `ci_validate`) once the
   remote exists.

### 3. First commit and the branches

```sh
cd {{PROJECT_DIR}}
git add -A && git commit -m "Scaffold from the operating kit <version>" -m "Ticket: T-<bootstrap ticket>
Pilot-Agent: bootstrap"
git branch {{INTEGRATION_BRANCH}}
git push -u origin {{DEFAULT_BRANCH}} {{INTEGRATION_BRANCH}}
```

This first push of `{{DEFAULT_BRANCH}}` is a person's (or the portal's New project flow). The scaffold's deny rules
stop an agent from pushing it, on purpose: from here on, `{{DEFAULT_BRANCH}}` moves only through the deploy
pipeline.

### 4. Create the workspace with the kit's pools

Create (or pick) the workspace that holds `{{PROJECT_DIR}}`, then assign:

- **Persona** `pilot-way`.
- **Contexts**: `charter-essentials`, `work-rhythm`, `safety-rules` (delivered with the persona), plus the kit's
  other contexts that apply (the index in `docs/kit/contexts/`): the project's standards, filled for this project,
  and a program overlay only when a program has its own rules.
- **Skillset** `pilot-way`.
- **The Portal MCP**: not a set. Switch agent access on for this workspace (Access > MCP > Agents); every session
  then gets its own token and the portal's tools (tickets, CI, knowledge, sessions).
- **MCP sets**, only after the owner reviewed their entries (`docs/kit/mcp/REVIEW.md`): the git host (`github`
  or `gitea`) and `docs`, each with its token by Secrets pool name.
- **Settings**: Bypass allowed for the orchestrator chat by policy; session caps; auto-approve OFF; budgets and
  spike alerts; the watchdog and the scoring enrolment where the portal offers them.
- A Claude sign-in for the workspace (a login is per workspace).

### 5. Secrets pool entries, by name

Create the entries the project needs, named, with the values pasted by the owner into the portal only, never into
a chat, a ticket, a file or a command line. Typical: the git host credential (for pushes and the gate Jobs), a
package registry token (private dependencies), the deploy target's credential (stg only at first). Agents and
pipelines refer to them by name (`secrets: [NAME]` in a pipeline, `{{secret-file:NAME}}` in an MCP set).

### 6. The CI remote and the environments

1. CI > New remote: the workspace, name `{{CI_REMOTE}}`, folder `{{PROJECT_DIR}}`, Connect on. The portal creates
   the bare remote and adds it as the git remote `pilot`.
2. `git push pilot {{INTEGRATION_BRANCH}}`: the `Gate` pipeline runs (it may be red until the CI ticket is done).
3. The first `deploy` run (the dry run of the deploy-pipeline ticket) creates the environment it names,
   **protected**. The owner then switches protection off for stg only; uat and production stay protected.

### 7. The first tickets

Create the tickets of `first-tickets.json` (Tickets page, or the Portal MCP `ticket_create`), after replacing its
placeholders, in a bucket for the project. Keep their `rank-NN` tags. The first-slice ticket's summary comes from
`{{FIRST_SLICE}}`. Assign the owner's checklist ticket to the owner. Where the ticket form has no structured
estimate yet, put the estimate as the first line of the description (`Estimate: M, severity 2, 2 h, risks: ...`).

### 8. The orchestrator chat: Bypass and Keep going

- Start a chat in `{{PROJECT_DIR}}` on the workspace. **Bypass** is the owner's act: the policy switch, a capable
  session, the owner's acknowledgement and the fresh server code. No tool or agent turns it on.
- **Keep going** (when the portal offers it): on, with the continuation prompt "Continue from
  docs/dev-sessions/status/orchestrator.md." and the done marker `TRACK COMPLETE` in that file. Bypass across
  restarts needs the owner's time-boxed lease. Where Keep going is not available, a monitor outside the workspace
  checks the chat; nothing that can steer chats runs inside it.

### 9. The first prompt

```text
You are the orchestrator of {{PROJECT}}, in {{PROJECT_DIR}}. Read CLAUDE.md, then docs/dev-sessions/README.md,
CHARTER.md, DECISIONS.md and orchestrator.md, and follow them; they bind you and every sub-agent. If the pilot MCP
offers session_context, call it now and at every resume. Work the project's tickets in rank order, starting with
rank-01. Nobody will answer questions: take the written default, record it, go on; put only required escalations
on the owner's checklist ticket and under NEEDS A HUMAN in docs/dev-sessions/status/orchestrator.md. Keep that file current and committed. Continue
until the backlog is empty, then write TRACK COMPLETE as its first line and end with a report of at most 25 lines.
```

## Measurements to record

Write them on the project's bootstrap ticket (or the kit's proof ticket), with the kit version.

| Measure | How | Source |
| --- | --- | --- |
| Minutes to the first green gate | From step 1's start to the first passed `Gate` run | The run's finish time in CI |
| Tokens and cost to the first green gate, and to the end of the first slice | The workspace's and the chat's usage | Usage, attribution per session and workspace |
| Human touches after the first prompt | Count the owner's messages, approvals and edits; list each with its reason | The chat, the audit, the tickets |
| What the agent still asked | Every NEEDS A HUMAN line, marked required or avoidable | The status file |
| Incidents | Every incident ticket opened, with its cause | Tickets tagged `incident` |
