# PRD: Local git and CI/CD

| | |
| --- | --- |
| Status | **Draft v0.2.** K0 approved by the coordinator (format decision included). **M1 built** and checked in a real Docker workspace; **M2 partly built** (§19). **[observed]** = seen in our own runs (Docker 29.9, git 2.39.5 and Node 22 in the workspace image), **[documented]** = from the tool's documentation, **[unverified]** = a guess to check, listed in §22. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-13 |
| Depends on | [Pools foundation](foundation-pools.md) (the runtime's delivery access: run, put, read), [Chat sessions](chat-sessions.md) (portal actors FR14, worktrees, session state), [Tickets](tickets.md) (timeline, branch and session links), [Portal MCP](portal-mcp.md) (tool registry, sanitizer, agent scope), [Secrets & env pool](secrets-env-pool.md) (secret names, the value redactor) |
| Related | [Workspace Claudes](workspace-claudes.md) (which Claude pushes), [Settings & policies](settings-policies.md) (limits), [Monitoring dashboard](monitoring-dashboard.md) (attention counts), [Web app & PWA](web-app-pwa.md) (push for failures) |

## 1. Summary

Every workspace can host its own git remote: a bare repository on the workspace's volume that the workspace's repositories and worktrees push to. A push to it, or a merge into one of its protected branches, is an event. The event starts a pipeline defined in the repository's own `.pilot/` folder, and the pipeline runs inside the same workspace, as the workspace user, from a clean checkout of the pushed commit in a temporary folder outside every project. The workspace is the runner: no cloud forge, no external runner, no marketplace.

The portal watches and drives it. It sees each event, reads and checks the pipeline files, queues the run under a per-workspace cap, starts it, and follows its state and logs through files the runner writes, so a portal restart loses nothing and the run finishes by itself. Runs show in the portal as jobs and steps with state and logs, and they are attached to the ticket and the chat session that own the branch. A failed run can be sent to the owning session as a portal message, with caps that make a CI-to-agent-to-push-to-CI loop impossible. People and agents can also trigger and cancel runs by hand, in the portal and through the Portal MCP.

The pipeline format is a small native YAML shaped like GitHub Actions (the shape agents write best) with the pieces GitLab CI gets right for a self-hosted machine (first-class artifacts, `needs`, local `extends` and `include`), and none of what needs a cloud (§9).

## 2. The request, and how this PRD reads it

| The owner said | This PRD reads it as |
| --- | --- |
| "Local git (workspace)" | Each workspace hosts one or more **bare repositories** (`~/.claudepilot/git/<name>.git`) on its own volume. A working repository gets a second remote, `pilot`, pointing at it (or is cloned from it). Nothing listens on a network port: the remote is a path, so pushing it needs a shell in the workspace, the same access the agent already has. |
| "integrated with local cicd ... if i push merge on that will execute ci/cd runner inside its workspace self hosted" | A **push**, or an update of a **protected branch** (a merge, by push or by the portal), is an event; the event starts a run **inside the workspace**. The runner is `cp-ci`, a root-owned script in the workspace like the chat host, started by the portal through the runtime's exec and detached, so it outlives the exec and the portal. |
| "the status can be attached to assigned task/issues of it" | Each run is linked to its **ticket** (branch `ticket/<id>-slug`, a `Ticket: <id>` commit trailer, or the session that owns the branch) and its **session**, shown as status chips and timeline entries, with the failure optionally sent to the session (§10 FR33 to FR38). |
| "local cicd folder called .pilot/{}" | Pipelines are files in the repository under **`.pilot/`** (§9.3). Policy that must not be editable from a branch (protected branches, required checks) lives in the portal, not in those files. |
| "similar with github/gitlab, pick the best for this approach" | A **native hybrid**, chosen with a comparison against both (§9.1): GitHub's shape for triggers, jobs, steps, conditions and matrices, GitLab's `artifacts`, `needs` and local reuse, no remote code. |

Where this PRD differs from the coordinator's first lean (GitLab's `script`/`rules` core with GitHub's triggers), and why, is in §9.2.

## 3. Background and problem

- Agents already work in git: A2's portal-managed worktrees give each session a branch. But nothing checks what a branch does. A person reads the transcript, or runs the tests by hand, to find out whether an agent's change works.
- Using a hosted forge for this needs an account, a token in the workspace, network access, and sending the code and its failures out. A workspace can't be both private and checked by someone else's runners.
- A hand-made shell script run by the agent is not evidence: the agent that wrote the change also decides what "passing" means and reports its own result.
- Tickets (T-<n>) say what should be done, but nothing on them says whether the work built and passed its checks.

## 4. Goals

| ID | Goal |
| --- | --- |
| G1 | **Workspace-local git.** A workspace can host bare remotes that its repositories and worktrees push to, created and wired from the portal. |
| G2 | **Events start runs.** A push, or a merge into a protected branch, starts the matching pipelines in that workspace without anyone clicking. A person or an agent can also start one by hand. |
| G3 | **The workspace is the runner.** Pipelines run in the workspace's container as the workspace user, from a clean checkout in a temporary folder, with caps (concurrency, timeouts, log and artifact sizes) and cleanup. |
| G4 | **Pipelines in the repository.** `.pilot/` holds the pipelines; agents write and edit them; a validator says exactly what is wrong. |
| G5 | **Status where the work is.** Runs, jobs and steps with state, duration and logs in the portal; a chip on the ticket and the session that own the branch. |
| G6 | **Close the loop safely.** A run's result is told to the session it belongs to as a portal message (a failure always; a pass, a cancel and a deploy held for approval when the session started the run itself), with caps that stop loops, on whichever Claude the chat runs now. *Amended 2026-10-13 (T-32): an agent that starts a deploy over the Portal MCP is not watching the run page, so it must hear how it went, and a chat that moved to another Claude must still hear it.* |
| G7 | **Survives the portal.** A run is started detached and keeps going when the portal restarts; the portal catches up from the runner's files. |
| G8 | **Controls over MCP.** Agents and scripts list, read, start and cancel runs through the Portal MCP, an agent only for its own branch. |
| G9 | **Gate and ship (M3).** Merge requests with required checks, a portal-performed merge, then deployments: environments, deploy steps, artifacts, schedules. |

## 5. Non-goals

- **A hosted forge.** No network git server, no web UI for browsing code, no pull request discussion, no users and permissions beyond the portal's single sign-in. The remote is a bare repository on a path.
- **Marketplace actions or any remote pipeline code.** No `uses: owner/action@ref`, no remote `include`, no downloading templates. A pipeline can only use files that are in its own repository.
- **Containers as job environments.** No `image:`, `container:` or `services:`. Jobs run in the workspace, whose image has the tools; a step installs more.
- **Hosted or multi-machine runners, autoscaling, a runner fleet.** One workspace is one runner with a concurrency cap.
- **Running pipelines for repositories outside a workspace.** Remotes live in workspaces.
- **Agents as pipeline steps.** A step may run any command, including `claude`, but the portal gives CI no session and no model integration.
- **Changing tickets by itself.** A run adds a check and a timeline entry to a ticket. It never changes a ticket's status, assignee or closes it (Tickets non-goal: no automation that acts on a ticket by itself).
- **Enforcing policy against the workspace user.** The agent and every pipeline are the same user as the one who can edit the bare repository, so protected branches and required checks are guard rails against mistakes and loops, not a security boundary (§16).

## 6. Users and stories

**Admin**: the person signed in to the portal. **Agent**: a Claude Code session in a workspace. **Script**: a Portal MCP token.

| ID | Story |
| --- | --- |
| US1 | As an admin, I create a local remote on a workspace from a repository that is already there. It gets a `pilot` remote, and its branches are on the portal's list. |
| US2 | An agent pushes its worktree branch with `git push pilot`. A run appears in the portal within seconds, goes green or red with each step's log, and the ticket the branch belongs to shows the result. |
| US3 | The run fails at a step. The agent's session gets one message with the failing step and the last lines of its log, fixes the code, pushes again, and the next run passes. After three failures in a row on a branch the messages stop and the ticket says so. |
| US4 | I merge a green branch into `main` from the portal, or an agent pushes `main`. A second pipeline (build and deploy to staging) runs on the merge. |
| US5 | I restart the portal in the middle of a run. The run finishes on its own and the portal shows its final state and logs when it is back. |
| US6 | A step hangs. It is killed at its timeout and the run says which step and how long. |
| US7 | An agent writes `.pilot/ci.yml` with a mistake. The run fails at once as invalid, with the line, the key and a suggestion in its log, and the agent fixes it. |
| US8 | I start a pipeline by hand on any branch, with inputs I choose, from the portal. An agent over MCP starts one for its own branch only. |
| US9 | I open a ticket and see the runs of its branch as chips (passed, failed, running) that link to the run. A session's page shows the same. |
| US10 | A deploy job needs an npm token. The pipeline names it; the value comes from the workspace's Secrets & env, and it never shows in a log. |
| US11 | I cancel a run that is going nowhere. Its processes stop and its checkout is deleted. |
| US12 (M3) | I open a merge request from a ticket branch into `main` with `ci` required; the portal merges it when the check passes. |

## 7. Scope boundary

| Allowed | Not allowed |
| --- | --- |
| Bare repositories under `~/.claudepilot/git` that the portal creates, with hooks the portal writes in the bare repository's own `hooks/` folder. | Touching a project's `.git/hooks`, its config or its remotes other than adding or updating the one named `pilot` on request. |
| Running `.pilot/` pipelines as the workspace user in the workspace, in a checkout under `~/.claudepilot/ci/runs/<run>/work/`. | Running anything as root; running pipelines in the portal's own process or container; running one in a project folder. |
| Reading `.pilot/**` at a given commit through the runner to parse and validate it in the portal. | Executing, `eval`-ing or otherwise running any text from a pipeline file in the portal. |
| Secrets by **name** from Secrets & env, resolved in the workspace. | A secret value in a pipeline file, in a plan, in the portal's database, in a log, or in a message to an agent. |
| Linking runs to tickets and sessions; telling a session about a failure inside caps; adding timeline entries. | Changing a ticket's status or assignee, closing it, or starting sessions from CI. |
| The portal performing a merge on the bare repository (M1: no gating; M3: after required checks). | Deleting, force-updating or rewriting a branch the user did not ask to merge; any push to a remote outside the workspace. |

## 8. Solution overview

```
 workspace (container, user node)                                        portal
 ┌─────────────────────────────────────────────────────────────┐        ┌───────────────────────────────────┐
 │ ~/work/app (repo, worktrees)                                 │        │ CiService (ci/service.ts)         │
 │     │ git push pilot <branch>                                │        │   poll ──────────────────────┐    │
 │     ▼                                                        │        │   (every few s, per running  │    │
 │ ~/.claudepilot/git/app.git      (bare, hooks/post-receive)   │        │    workspace with a remote)  │    │
 │     │ hook: one JSON file per ref update, atomic             │ exec   │   1 events → compile .pilot  │    │
 │     ▼                                                        │◀───────│   2 queue → cp-ci start      │    │
 │ ~/.claudepilot/ci/events/<id>.json                           │        │   3 state + logs → DB, UI    │    │
 │                                                              │        │   4 ticket check, session msg│    │
 │ /etc/claudepilot/bin/cp-ci   (root-owned, Node, no deps)     │        │                              │    │
 │   start <run>  ── detached supervisor (setsid) ──┐           │        │ routes /api/ci, live topic   │    │
 │   poll / log / cancel / gc / merge / repo ...    │           │        │ Portal MCP tools (ci_*)      │    │
 │                                                  ▼           │        └───────────────────────────────────┘
 │ ~/.claudepilot/ci/runs/<run>/ plan.json state.json           │
 │     logs/  artifacts/  work/<job>/ (clean checkout, deleted) │
 └─────────────────────────────────────────────────────────────┘
```

Three decisions shape everything:

1. **The portal plans, the workspace runs.** The portal reads `.pilot/` at the pushed commit, validates and compiles it to a plan (JSON), and hands the plan to `cp-ci`. The runner never parses YAML. So the validator, the expression language and the matrix live once, in TypeScript with tests; the root-owned script stays small and dependency-free.
2. **Files are the protocol.** Hooks write event files; the runner writes `state.json` and log files; the portal reads them through short `exec` calls and acknowledges events by name. No socket from the workspace to the portal, no state in a long-lived connection. A portal restart, a lost connection or a stopped workspace leaves the files where they are.
3. **Policy in the portal, pipelines in the repository.** Which branches are protected, which checks are required and who may deploy are settings in the portal's database. A branch can't change them by editing a file.

## 9. The pipeline format

### 9.1 Comparison

Judged for THIS use: a local, self-hosted, agent-driven workflow, where the runner is the workspace itself and there is no marketplace. Scores are 3 (best fit) to 1.

| Criterion | GitHub Actions | GitLab CI | Native hybrid (chosen) |
| --- | --- | --- | --- |
| Agents already know it | **3**. Most training data; agents write it unprompted. | **2**. Well known, less of it; shell-first. | **2.5**. The same keys as GitHub's (`on`, `jobs`, `needs`, `steps`, `run`, `env`, `if`, `matrix`); a wrong guess gets an exact error and a suggestion. |
| Simple and deterministic to implement and verify | **1**. Full fidelity means emulating a platform: ~20 expression functions, contexts, `uses:` actions, reusable and composite workflows. | **1**. `rules:changes/exists`, four `include` kinds, `extends` deep merge, `!reference`, `needs:` and stage semantics, `workflow:rules`. | **3**. A closed spec. Every key has one meaning; anything else is an error with a hint. |
| Security: no remote code | **1**. `uses: owner/action@ref` runs third-party code (the main supply-chain risk); `${{ }}` pasted into `run` is injectable. | **2**. No step marketplace, but `include: remote/project/template`, `image:` and `services:` pull from outside. | **3**. Nothing remote exists in the format; `${{ }}` is refused inside `run`, values reach scripts as environment variables. |
| Reuse of existing workflows | **3**. They are the source. | **2**. | **2**. A simple GitHub workflow converts nearly 1:1 (drop `uses:` setup steps, rename `timeout-minutes`); GitLab files need restructuring. Importers are a later convenience (M3), not the format. |
| Triggers and manual runs | **3**. `on:` is declarative: push, `workflow_dispatch` with typed `inputs`, `schedule`. | **2**. Implicit: pipelines run on everything and `rules:` filters by `$CI_PIPELINE_SOURCE`; manual jobs are `when: manual`. | **3**. `on:` with `push`, `merge` (a protected branch moved: local remotes have no pull requests), `manual` with inputs, `schedule` (M3). |
| Matrix and conditions | **3**. `strategy.matrix` with `include`/`exclude`; `if:` expressions. | **2**. `parallel:matrix`; `rules:if` with its own expression syntax. | **3**. `strategy.matrix`; `if:` over a closed subset (§9.5), evaluated before the run starts. |
| Artifacts and caches | **1**. Both are actions (`upload-artifact`, `cache`), which don't exist here. | **3**. First-class `artifacts:` and `cache:`. | **3**. First-class `artifacts` (GitLab's shape), passed to the jobs that `needs` it. No `cache:`: the workspace's home persists, so `~/.npm` and friends already are one. |
| Secrets | **2**. `${{ secrets.X }}` repository secrets. | **2**. Masked and protected variables. | **3**. `secrets: [NAME]` by Secrets & env name; never interpolated, redacted in every log. |
| Jobs and steps on a clear UI | **3**. Jobs, then named steps with their own log section. | **2**. Stages and jobs; a job is one log. | **3**. Jobs then named steps like GitHub's; a job's depth in the `needs` graph gives GitLab's stage columns. |
| Containers, services, hosted runners | **1**. `runs-on`, `container`, `services` assume somewhere to run. | **1**. `image`, `services`. | **3**. None: the workspace is the executor (GitLab's "shell executor" model). |

### 9.2 Decision

**A small native YAML, shaped like GitHub Actions, borrowing GitLab where GitHub has nothing for a local machine.** It is not a subset of either format that can be pasted into the real thing; it is a closed spec that looks the same to someone who knows either.

Taken from **GitHub Actions**: the `on:` trigger block; `jobs`, `needs`, `steps` with `name`, `run`, `env`, `if`, `working-directory`, `continue-on-error`; `strategy.matrix`; `${{ }}` for the few places values are substituted; `timeout-minutes` accepted as an alias of `timeout`; `concurrency` with `cancel-in-progress`.

Taken from **GitLab CI**: first-class `artifacts` on a job, handed to the jobs that need it; hidden jobs (names starting with `.`) with `extends` and local `include` for reuse; `allow_failure` semantics as `continue-on-error`; the idea that policy (protected branches, environments, required checks) belongs to the project's settings, not the YAML.

Left out on purpose: `uses:` of anything but a local step; `runs-on` values that need another machine; `container`, `services`, `image`; remote `include`; `${{ }}` inside `run`; `cache`; regex and arbitrary functions in expressions; `needs.<job>.outputs` (runtime values crossing jobs); reusable workflows.

**Where this overturns the first lean** (GitLab's `script` and `rules` for the job model): GitHub's `steps` give named, separately timed and logged units, which is what the run page needs to say *which* step failed and for how long, and which a person reading a failing run wants first. `if:` is one mechanism where GitLab has `rules` and `when` and `only/except`. The `matrix` and `on:` keys are the ones agents reproduce without looking anything up. What the GitLab lean got right (artifacts as part of a job, `needs`, local reuse, policy outside the file) is kept.

### 9.3 Layout

```
.pilot/
  ci.yml          a pipeline: every *.yml or *.yaml directly in .pilot/ is one pipeline, named by its file (or `name:`)
  deploy.yml
  steps/          local reusable steps, used as `uses: ./steps/<name>`           (M2)
  templates/      fragments for `include:` and hidden `.jobs` for `extends:`      (M2)
  scripts/        anything the pipelines run; not interpreted by pilot
```

One file is one pipeline with its own triggers, so "add a pipeline" is "add a file" and the portal's list of pipelines is the folder. Two files that normalise to the same pipeline name (`ci.yml` and `ci.yaml`) are an error. Settings the portal enforces are not in the repository (§9.2).

### 9.4 The spec

Unknown keys are errors, never ignored. Durations are `90s`, `15m`, `2h`; a bare number under `timeout-minutes` is minutes.

| Key | Meaning |
| --- | --- |
| `name` | Display name; default the file's name. |
| `on` | When it runs; at least one of the following. `push: { branches, tags }` globs (`*` within a segment, `**` across; default every branch, no tags). `merge: { branches }`: a protected branch moved forward (default every protected branch). `manual: { inputs }`: started from the portal or MCP; inputs `{ name: { type: string\|boolean\|choice, default, options, required } }`. `schedule: [{ cron }]` (M3). A pipeline runs at most once per event, however many triggers match it. |
| `env` | Variables for every job: `NAME: value`; values are strings or `${{ }}` over the static contexts of §9.5. Names `[A-Za-z_][A-Za-z0-9_]*`, not starting with `PILOT_`. |
| `timeout` | Whole-run cap; default 60 minutes, at most 6 hours. |
| `concurrency` | `{ group, cancel-in-progress }`: at most one run of a group is active; a new one waits, or cancels the old with `cancel-in-progress: true`. `group` is a string with `${{ }}`; default none. |
| `jobs.<id>` | `id` is `[a-z0-9][a-z0-9_-]*` (a leading `.` makes it hidden, for `extends`). At most 50 per pipeline. |
| `jobs.<id>.name` | Display name. |
| `jobs.<id>.needs` | Job ids that must finish first; the job gets their `artifacts`. Cycles and unknown ids are errors. |
| `jobs.<id>.if` | A condition (§9.5). Static: false means the job is skipped. A status function (`always()`, `failure()`, `success()`) may be one `&&` term, which sets when it runs. |
| `jobs.<id>.timeout` | Default 30 minutes. |
| `jobs.<id>.env`, `.secrets` | Variables; `secrets` is a list of Secrets & env names the job relies on. A name can be used only when the workspace has it as a file (a secret, or a tool login's token): the portal checks that before the run and fails it with `secret-missing` when it does not (a name that reaches Claude Code only as a variable is refused with that reason); the runner reads the value from `<etc>/secrets/files/<NAME>` for that job's steps only, sets it as the variable `NAME`, and masks it in the job's logs as they are written. Values are never in the file, the plan or the database. **Built.** |
| `jobs.<id>.continue-on-error` | The run doesn't fail when this job does. |
| `jobs.<id>.strategy` | `matrix: { key: [values], include: [...], exclude: [...] }` (GitHub's rules: a product, minus what `exclude` names, with each `include` added to the combinations it fits or as one of its own), `fail-fast` (default true: when one combination fails, those that have not started are skipped) and `max-parallel` (1 to 8). At most 25 combinations, checked when the file is read. Each combination is a job named `<name> (<values>)`; a job that `needs` the matrix job waits for all of them; `matrix.<key>` is known in the job's `if`, `name`, `env` and steps. **Built.** |
| `jobs.<id>.steps` | At most 100. Each: `name`, `run` (a shell script), `env`, `if`, `working-directory` (relative, inside the checkout), `timeout`, `continue-on-error`; or `uses: ./steps/<name>` with `with:` (M2). |
| `jobs.<id>.artifacts` | `{ paths: [globs], expire: 14d, when: success\|always }`; paths are relative to the checkout and stay inside it; links leading out are skipped. |
| `jobs.<id>.environment` | `name` or `{ name, url }` (M3): marks a deployment (FR41). The portal decides from its own record of that environment whether a person must approve the job first; nothing in the file can. `url` is accepted and not used yet. **Built.** |
| `jobs.<id>.extends`, `include` | Merge from a hidden job or a fragment in `.pilot/templates/` (M2): maps merge, lists replace. |

Accepted with a **warning and no effect**: `runs-on: self-hosted | ubuntu-* | linux`, and the step `uses: actions/checkout@*` (the checkout is implicit). Refused with a **specific hint**: other `runs-on` values, `container`, `services`, `image`, `cache`, any other `uses:` (including `actions/setup-node`, `actions/cache`, `actions/upload-artifact`: "Node is in the image; install tools with `run`", "use the job's `artifacts`"), `${{ }}` inside `run`, `allow_failure` ("use `continue-on-error`"), `script:` ("use `steps` with `run`"), `stages` and `rules` ("use `needs` and `if`").

### 9.5 Expressions and variables

`if:` and `${{ }}` use one closed language, evaluated in the portal **before** the run starts, over values the portal already knows:

- Literals: `'text'` (`''` for a quote), numbers, `true`, `false`, `null`. Operators: `== != < <= > >= && || !` and parentheses.
- Contexts: `ci.event` (`push`, `merge`, `manual`, `schedule`), `ci.ref`, `ci.branch`, `ci.tag`, `ci.sha`, `ci.base` (the commit the ref moved from), `ci.actor` (`ui`, `portal-mcp:<id>`, `session:<id>`, `push`), `ci.repo`, `ci.pipeline`, `ci.ticket` (`T-12` or empty), `inputs.<name>`, `matrix.<key>`, `env.<NAME>` (the pipeline's and job's own declared values).
- Functions: `contains(a, b)`, `startsWith(a, b)`, `endsWith(a, b)`, `toLower(a)`, `toUpper(a)`, `format('..{0}..', x)`. Status functions `always()`, `failure()`, `success()` as top-level `&&` terms of a job or step `if`; they become the runner's only runtime decision (`when`). Anything else (a status function under `||` or `!`, a regex, an unknown name) is an error that says what is allowed.
- No expression runs in the workspace and none can reach a file, the network or the environment.

Scripts get values as **environment variables**, never as pasted text, so a branch or an input can't inject shell: `CI=true`, `PILOT_CI=true`, `PILOT_RUN_ID`, `PILOT_RUN_NUMBER`, `PILOT_PIPELINE`, `PILOT_JOB`, `PILOT_EVENT`, `PILOT_REPO`, `PILOT_REF`, `PILOT_BRANCH`, `PILOT_TAG`, `PILOT_SHA`, `PILOT_SHA_SHORT`, `PILOT_BASE_SHA`, `PILOT_ACTOR`, `PILOT_TICKET`, `PILOT_WORKSPACE`, `PILOT_WORKDIR`, `PILOT_INPUT_<NAME>`. Names starting `PILOT_` are reserved.

### 9.6 Example

```yaml
# .pilot/ci.yml
name: CI
on:
  push: { branches: ['**'] }
  merge: { branches: [main] }
  manual:
    inputs:
      target: { type: choice, options: [staging, production], default: staging }
env:
  NODE_ENV: test
jobs:
  test:
    timeout: 15m
    steps:
      - run: npm ci
      - name: Unit tests
        run: npm test
      - name: Build
        run: npm run build
    artifacts:
      paths: [dist/**]
  deploy:
    needs: [test]
    if: ci.event == 'merge' && ci.branch == 'main'
    secrets: [DEPLOY_TOKEN]
    steps:
      - name: Deploy
        run: ./.pilot/scripts/deploy.sh "$PILOT_BRANCH"
```

### 9.7 Validation and messages

An agent will get it wrong sometimes, so the validator is part of the product. It runs when events arrive, in the Remotes view (per branch), through `POST /api/ci/validate`, and as the Portal MCP tool `ci_validate` (M2). A diagnostic is `{ file, line, column, path, severity, code, message, hint }`; for example:

```
.pilot/ci.yml:14:7  error  jobs.test.steps[1]  unknown key "script"  Use "run". (steps run a shell script)
.pilot/ci.yml:9:5   error  jobs.test.timeout   "15" is not a duration  Write 15m, or use timeout-minutes: 15
.pilot/ci.yml:21:7  error  jobs.deploy.steps[0] uses "actions/setup-node@v4" is not available  Jobs run in the workspace; node is in the image. Install tools with "run".
```

Line and column come from the YAML parser's source offsets; for a value that came from an alias or merge the position is the nearest literal ancestor. A file that fails to parse, or has any error, makes its pipeline `invalid`: a run is created in state `failed` with reason `invalid_pipeline` and the diagnostics as its log, so the push shows a result and the agent that wrote it can read what to fix. Warnings don't stop a run. Limits (§11.5) are checked before anything is expanded: a pipeline file over 128 KiB, more than 20 files, aliases beyond a count, nesting beyond a depth.

## 10. Functional requirements

### Local remotes

- **FR1** A remote is a bare repository `~/.claudepilot/git/<name>.git`; `<name>` is `[a-z0-9][a-z0-9._-]{0,63}`, unique per workspace. It is created by `cp-ci repo create` run through the runtime's exec, never by the browser, and recorded in the portal (`ci_repos`).
- **FR2** Creating takes the workspace, the name, optionally a **source**: an absolute path of a repository in the workspace (under the files root, not under `~/.claudepilot`). With a source the bare repository is a clone of it, hooks are installed after the clone so the history doesn't fire events, and with "connect" the source gets a remote `pilot` (`git remote add pilot <path>`, or `set-url` when `pilot` exists and points elsewhere; never any other remote touched). Without a source it starts empty with its default branch (`main`).
- **FR3** The portal can connect further working repositories (`cp-ci repo connect <name> <path>`) and delete a remote (the bare repository and its record; refused while a run of it is active; a confirmation names what is deleted and that the connected repositories keep their `pilot` remote).
- **FR4** Hooks live in the bare repository's own `hooks/` folder (portal-owned, rewritten by every `repo ensure`, which the portal runs when a workspace starts and when a remote is opened). `post-receive` is the only hook in M1. A hook is a three-line stub that runs `cp-ci hook post-receive` by absolute path and ignores its failure, so a missing or broken runner never blocks a push.
- **FR5** The hook writes **one event file per ref update**: `~/.claudepilot/ci/events/<id>.json`, mode 0600, staged under a temporary name and renamed, built with a JSON encoder from the hook's stdin (never by shell interpolation of ref names, authors or messages). `<id>` is `<epoch ms>-<8 hex>`. A push of more than 50 refs writes the first 50 and a note. A ref outside `refs/heads/` and `refs/tags/`, or whose name fails FR6, is dropped with a count.
- **FR6** Ref names are checked wherever they are used: `[A-Za-z0-9][A-Za-z0-9._/-]{0,199}` after `refs/heads/` or `refs/tags/`, no `..`, no `//`, no trailing `/` or `.lock`, no `@{`. A name that fails is recorded as ignored and shown so, never passed to a command unquoted (commands take argument arrays, never a shell string).
- **FR7** The portal keeps **protected branches** per remote (default: the default branch). Protection classifies events as `merge` in M1 and enforces in M3 (§16).
- **FR8** A **merge** can be performed by the portal on the bare repository (`cp-ci merge <repo> <source> <target> --strategy ff|merge [--expect <sha>]`): fast-forward when the target is an ancestor of the source, otherwise a merge commit made with `git merge-tree --write-tree`, `commit-tree` and a compare-and-swap `update-ref`. It needs no working tree, runs no hooks, refuses on conflicts (naming the files) and when the target moved since `--expect`, and writes the same event a push would. A merge by plain push to a protected branch is also an event.

### Events and triggers

- **FR9** The portal polls each running workspace that has a remote (every 5 s while events or runs are pending there, every 15 s otherwise; once when the workspace starts): one `cp-ci poll` returns pending events and the state of the runs the portal is following. It acknowledges events by id in the next poll, after storing them, so an event is processed once and none is lost if the portal stops in between (a duplicate is dropped by the unique key).
- **FR10** For each event the portal stores it (`ci_events`), classifies it (`push`, or `merge` when the ref is a protected branch; a ref deletion starts nothing), reads `.pilot/` at the new commit, and for each pipeline that matches creates a run. A tip commit whose message contains `[skip ci]` or `[ci skip]` starts nothing; the event records why. A push with no `.pilot/` folder, or no matching pipeline, records `no pipeline` and starts nothing.
- **FR11** A run is created `queued` with its plan. It starts when its workspace has a free slot (default 2 runs at once per workspace; config). Runs queue in arrival order; with more than 20 queued the newest event is dropped and recorded as `queue full`.
- **FR12** `concurrency.group` applies at start: a run of a group waits for the group's active run, or cancels it with `cancel-in-progress`.
- **FR13** **Manual runs** (`POST /api/ci/runs`, the MCP tool): pipeline, ref (a branch or a tag, resolved by the runner to a commit), and inputs checked against the pipeline's `on.manual.inputs`. A pipeline with no `manual` trigger can't be started by hand. The actor is recorded (`ui`, `portal-mcp:<id>`, `session:<id>`).
- **FR14** **Rerun** starts a new run of the same pipeline at the same commit with the same inputs (`rerun_of` set); it never reuses a finished run.
- **FR15** **Cancel** works on queued and running runs. A queued run is cancelled in the portal; a running one through `cp-ci cancel`: the supervisor stops every process group of the run, marks what didn't finish `cancelled`, and deletes the checkouts.
- **FR16** Schedules (M3): `on.schedule` of a pipeline on the remote's default branch creates runs at the cron time against that branch's head; missed times while the portal or workspace was off run once at the next start, never as a burst.

### The runner

- **FR17** `cp-ci` is one Node script with no dependencies, root-owned at `/etc/claudepilot/bin/cp-ci` (mode 0755), generated from TypeScript (§11.1), installed by the portal on Docker and This machine the way the chat host is (staged, renamed as root, compared by content), and baked into the workspace image later for Kubernetes. A workspace on Kubernetes without it can't have remotes yet and says why. The portal remembers an install for ten minutes; a pod restart loses the file (the container's filesystem, not the home volume), so a `cp-ci` run that gives no reply or exit 126/127 while the file is missing or stale installs it again and tries once more, and a workspace seen stopped forgets the mark (T-99, 2026-10-13: CI was dead for ten minutes after every restart before).
- **FR18** `cp-ci start <run>` takes the plan on stdin, claims `runs/<run>/` with `mkdir` (a second `start` for the same run is a no-op), refuses when the home volume has less than 512 MiB free, and starts a **detached supervisor** (its own session, no stdio shared with the exec). The exec returns at once.
- **FR19** The supervisor makes a **clean checkout** per job under `~/.claudepilot/ci/runs/<run>/work/<job>/` from the bare repository (`git clone --local --no-checkout`, then `checkout --detach <sha>`), with git hooks off. It never uses a project folder, and deletes the checkout when the job ends.
- **FR20** Steps run as the workspace user in a **login shell** (`bash -lc`), so they see the same tools and Secrets & env variables a terminal does, with a clean base environment (PATH, HOME, USER, LANG, `TERM=dumb`) plus the `PILOT_*` variables, the pipeline's and job's `env`, and nothing inherited from the runner's own environment. Each step is its own process group at a lowered priority. Steps of a job run in order; a failing step fails the job unless `continue-on-error`; later steps run only when their `when` allows.
- **FR21** Jobs run when their `needs` are done and their condition allows, at most 2 at once per run (config). A job whose `needs` failed or were skipped is `skipped` unless its `when` is `always` or `failure`.
- **FR22** **Timeouts**: per step, per job, per run. On expiry the process group gets SIGTERM, then SIGKILL after 5 s; the step is `failed` with reason `timeout` and a runner line in its log. **Cancel** does the same.
- **FR23** **Logs**: each step's stdout and stderr, merged, go to `logs/<job>/<n>.log`, capped at 16 MiB per step and 64 MiB per run (after the cap output is dropped and a single marker line says so). Runner notices in a log start with `[pilot]`.
- **FR24** **Artifacts**: after a job, its `artifacts.paths` are copied (regular files only, resolved paths inside the checkout) to `artifacts/<job>/`, at most 100 files, 32 MiB per file and 128 MiB per run; what was skipped and why is in the job's record. A job that `needs` it gets them copied into its checkout before its steps.
- **FR25** `state.json` is rewritten atomically at every change; it is the record. `supervisor.pid` and the process's start time let `poll` tell a live supervisor from a stale pid (a container restart reuses pids).
- **FR26** `cp-ci gc` deletes run folders older than 14 days and event files older than 7, and any work folder whose supervisor is gone; the portal calls it when a workspace starts and after each finished run.
- **FR27** **Survival**: the supervisor doesn't depend on the portal or on the exec that started it. When a workspace stops, its supervisors stop with it; on the next poll a run still `running` whose supervisor is gone is marked `failed` with reason `runner_lost`, and can be rerun.

### Observing

- **FR28** The portal mirrors each followed run's `state.json` into `ci_runs.state` on every poll (jobs, steps, state, times, durations, exit codes, log sizes) and notifies the live socket (topic `ci`) when it changes.
- **FR29** A **live log** is read on demand: `GET /api/ci/runs/:id/log?job&step&offset` returns the next chunk (at most 64 KiB) from the workspace through `cp-ci log`, redacted and with control sequences stripped; the page asks again from the returned offset while the step runs.
- **FR30** When a run ends the portal **archives** its logs: for each step the first 64 KiB and the last 192 KiB (with a marker between), redacted, at most 2 MiB per run, in `ci_logs`. A finished run's logs are served from the portal, so they outlive the workspace's own files and a stopped workspace. Run records are kept 30 days and the latest 300 per workspace.
- **FR31** Redaction on anything that came from a workspace: the pattern redactor (`chat/redact.ts`) always, and the value redactor for the workspace's exposed secrets when it exists (chat QA-006). Logs are served as `text/plain` data and rendered as text, never as HTML.
- **FR32** Run states are `queued`, `running`, `passed`, `failed`, `cancelled`; jobs and steps also `skipped` and `pending`. A failed run carries a reason (`step_failed`, `timeout`, `invalid_pipeline`, `runner_lost`, `no_space`, `superseded`). A step that fails with `continue-on-error` shows as failed and ignored; its job passes.

### Tickets and sessions (M2)

- **FR33** A run is linked at creation to a **ticket**, found in this order: the session whose worktree branch is the run's branch (its `ticketId`), a `Ticket: T-<n>` trailer in the tip commit, then a branch named `ticket/<n>-...` or `ticket/T-<n>-...`. The id must exist; CI never creates a ticket. It is also linked to the **session** found by branch. Both links and how they were found (`ticket_source`) are stored.
- **FR34** All access to tickets goes through one adapter, `ci/tickets.ts`, against the ticket service: attach or update a **check** (pipeline name, state, run id, commit, link) on state changes, and add **timeline entries** at the run's start and its end (terse: "CI #14 failed · test > Unit tests"). Entries are made by the portal (`system`, labelled "CI"), never as a person or an agent. Until the ticket service takes checks, an entry is a system comment.
- **FR35** The ticket page and the session page show **run chips**: the latest run per pipeline on the branch, with a status icon and a link; a session's chip follows its branch.
- **FR36** A **failure message** goes to the owning session as a portal message with the actor `ci:<run id>`, once per failed run, only when the session is not ended and the run is on its branch. It names the pipeline, the first failing job and step, its exit code, and the last 40 lines (at most 3 KiB) of that step's log after redaction and A3b's sanitizer, framed as untrusted output. It is never sent for a `passed`, `cancelled` or `invalid` run (an invalid pipeline is sent: it is the agent's own file), nor for runs started by hand, unless asked. **Amended 2026-10-13 (T-32), why:** the owner asked that CI "bump to the triggering session" and that this survive a move to another Claude; a session that started a deploy over the Portal MCP is not watching the page, and the old rule ("by hand: someone is watching") skipped it. **Now:** a run reports to its session (the one that started it, `run.session_id`, else the one whose worktree owns the branch) these states, each **once per run and state** (`ci_messages.state`, migration 730): `failed` always, except for a run **a person** started by hand (`manual` from the UI or an admin token, or a rerun: still never reported); `passed`, `cancelled` and `waiting` (a deployment held for approval, FR41) when **the session started the run itself** (actor `session:<id>`, a manual run over the Portal MCP) or when the pipeline lists that state in **`on.notify`** (e.g. `on: { push: {}, notify: [passed, waiting] }`; read from the commit's file and carried in the plan; the runner ignores it). A non-failure message is short: the pipeline, the run number, the branch, the commit, the result and the run's link (`Run: /admin/ci/runs/<id>`); a failure keeps the step, exit code and log tail above and adds the link. Every message goes in with priority `later` (behind the turn in progress). **Moves followed:** the session is resolved **at send time** through the chat controller: an id folded by a Move (an alias) or a legacy successor chain reaches the chat as it is now, on whichever Claude it runs; an ended chat is not woken. The run carries where each report went or why not (`CiRun.reports`: `sent`, `ended`, `refused`, `capped`, `paused`), and the run page says it in one line ("Pass reported to the session", linking the chat; "Failure not reported, the session has ended").
- **FR37** Loop protection: at most 3 messages per ticket per hour and 10 per ticket per day (a session without a ticket: the same per session); after 3 failed runs of one branch within 30 minutes no more messages go to it until a run passes or a person resumes them, and the ticket's timeline says so once. A message is a normal send inside A2's caps; a refused send is recorded on the run, not retried. **Amended 2026-10-13 (T-32):** the caps count every message sent (any state); the failure-streak pause holds back failure reports only (a pass ends the streak; a cancel or a held deploy is no loop), and each run it holds back is recorded as `paused` so its page can say why.
- **FR37a** **Bump** (added 2026-10-13, T-32 item 3; why: the owner wants to push a run into a session by hand, not only wait for the automatic report, e.g. a failure of a run a person started, or a question about a pass). On the run page (an icon button) and in a run row's ⋯: pick a live session (the shared picker of the ticket Bump, tickets PRD FR28 and FR32): the run's own session first (`run.session_id` or the branch's owner, resolved as it is now, so a moved chat is offered under its current id), then the live sessions of the run's workspace, then the sessions of its ticket (which may work in another workspace); an ended session, one waiting on an approval or an unrelated one is not offered or is greyed with why. Two ways, one ⓘ: **Fix** (CI's report of the run, with the failing step's tail for a failure, goes in with priority `next`: the session acts on it now) and **Ask** (a question, priority `later`; the session answers in its chat). An optional note of one line. The message comes from the run (actor `ci:<run id>`, label `#<n>`, so the transcript says "From CI #12") in the shared bump style (who and how, the facts and link, the note, CI's report fenced as untrusted, what to do). Recorded on the run (`CiRun.bumps`, a `ci_messages` row with the state `bump:<mode>`, never counted by FR37's caps; a session that would not take it is recorded as not taken), shown as one line on the run page ("Bumped to a session (Fix)", linking the chat), and, when the run has a ticket, as a note on its timeline ("Admin bumped CI #12 (ci, failed) into “Worker” (Fix): …"). Limits: 10 bumps of a run and 20 into one session an hour (`RATE_LIMITED`). Through the seam (operate on the run and on the session; the picker lists only sessions the person may operate), audited (`ci.run_bumped`), and over the Portal MCP as `ci_run_bump` (§14).
- **FR38** The adapters are the only places CI touches tickets or chat: `ci/tickets.ts` and `ci/sessions.ts`, each with a fake for tests.
- **FR38a** **A flaky test becomes a ticket** (added 2026-10-14, T-95 item 4; why: a gate that failed on one test that passes alone cost a whole deploy run, and the rerun rule that fixed that hid the flake: the summary said "flaky, passed on rerun" and nobody followed it up). `scripts/gate.sh` reruns the files with a failing test alone; when the rerun passes the gate is green and writes one summary line per test that failed in the full run, `server-suite-flaky: <file>;<test name>` (the file from the test's TAP location, `scripts/gate-verdict.sh flaky`), which the verdict prints as `note: flaky, passed on rerun: <file>;<test name>` (the in-cluster Job) or the pipeline's own gate as `gate: flaky, passed on rerun: …`. **The portal, not the scripts, opens the ticket:** when a run is over and its logs are kept in the portal (FR30, cleaned and redacted), CI reads every **passed** step's kept log for those lines (a failed step's are ignored; a line without a test file is not one; at most 10 per log) and keeps **one ticket per test** (by remote, file and test name, across runs; `ci_flaky`, migration 732, one row per run and test, so a run read twice counts once, and not pruned with the runs). The first sighting opens a ticket as the portal (`source: system`): type `bug`, priority `normal`, tags `flaky`, `area-qa` and the remote's name (`claudepilot` for the portal's own), title `Flaky in the gate: <file> <test name>` (at most 140 characters), the run's workspace, and a description with the run's link and job, the commit, the test's own failure report from the log (its first 40 lines, redacted once more, at most 2 KiB, indented as a block and labelled untrusted output) and the instruction to run the file 20 times in a Job and write the count on the ticket. A later sighting adds a comment from `ci:<run id>` with the run's link, the job, the commit and the number of runs that saw it, never a second ticket; a **closed** ticket is reopened by it (the one ticket CI changes the status of: its own, PRD §5). The run carries `CiRun.flaky` (per job: the number of flaky tests and their tickets) and the run page shows `flaky: N, tickets T-x, T-y` under the job, each ticket a link. Why in the CI service: the log is already in the portal and redacted there, the portal has the ticket service and its system actor, and the scripts run in a workspace or a Job with no ticket rights (and must not get any). The ticket appears when the run ends (after the release or a rejection), not when the gate job ends: the logs are kept at the run's end. **Observed (2026-10-14, in the tests, not yet on a real deploy run):** `ci/flaky.test.ts` on the real runner and git with a fake ticket port: a run whose passed `gate` step prints two distinct tests (one of them twice) and a failed step printing a third opens exactly two tickets with the title, tags, workspace, run link, commit, the indented failure report and no canary; a second run comments on both ("Runs that saw it: 2"), opens none; after one is closed, a third run reopens it with a comment; the run's `flaky` is `[{ job: 'gate', tests: 2, tickets: [...] }]`; the parse (one line, several, none, the old names-only format and other malformed lines) and the excerpt's redaction and 2 KiB bound; `qa/gateVerdict.test.ts` for `gate-verdict.sh flaky` on TAP with nested tests, a failing file and a test without a location. Not observed: a real gate Job with a flaky test, the run page in a browser.

### Portal MCP (M2)

- **FR39** Tools register through the registry (§14). `ci_runs_list`, `ci_run_get`, `ci_run_logs` and `ci_validate` read; `ci_run_trigger` and `ci_run_cancel` operate. Over an agent token (`agent` scope) they act only on runs whose branch is the caller's session's own worktree branch or whose ticket is the caller's. Text from logs and diagnostics passes `ctx.untrusted` and the redactor.

### Merge requests and CD (M3)

- **FR40** A **merge request** (source branch into a protected target, optional ticket) has required checks (pipeline names, set per remote). The portal merges it (FR8) when the latest run of each required pipeline **at the source's current head** has passed, immediately or on a click ("merge when green"). A new push to the source resets the checks. `pre-receive` rejects direct pushes to protected branches when the remote is set to merge-requests-only (FR7; a guard rail, §16).
- **FR41** **Environments** (`staging`, `production`, ...) are portal records with an optional protection: a job with `environment: production` waits (`waiting`) for the approval of a person, or of the environment's rule that a person turned on (FR41a), in the portal. **Amended 2026-10-13 (T-110), why:** the owner decided (DECISIONS D-2) that ClaudePilot's own deploys are approved by the PORTAL by a rule, never by an agent; on deploy #18 the gate went green on e327e6d, the build passed, and the owner approved by hand 8 seconds later: the person added a wait and no judgement the rule's conditions did not already hold. Since slice 2 (2026-10-14) the portal itself approves a deploy of an environment whose rule a person set to `on`, when every condition of FR41a holds; no agent and no token ever approves. A deployment is a run's job tied to an environment; each environment shows its latest deployment and its history. **Built (2026-10-13, the minimal part):** an environment is a record per remote (`ci_environments`), made **protected** the first time a pipeline names it; a person switches protection off or on (CI → Remotes → a remote's environments; turning it off is asked once more; audit `ci.environment_protection`), and a run planned before the change keeps its gates. When a run is planned, each job that deploys to a protected environment gets a **gate** in the plan: the SHA-256 of a fresh random key that only the portal holds (`ci_deployments.gate_key`). The runner holds that job as `waiting` (the run stays `running`; its own timeout starts after the approval; the wait counts against the run's) until `cp-ci approve` hands it the key, which the portal does only when a **person** approves on the run page (`POST /api/ci/runs/:id/approve`); a decision file without the right key is thrown away. **Reject** ends the run as `cancelled`, reason `rejected`, and cancels what waited on the job (a rollback that runs on failure does not start). Both are in the platform audit (`ci.deploy_approved`, `ci.deploy_rejected`). An undecided approval `expired` with its run; the key is dropped as soon as the job is decided or the run is over. A rerun gets fresh gates. No Portal MCP tool approves, rejects or changes protection. **A notification when a job starts waiting** (2026-10-13): the hook `CiService.hooks.waiting` is heard by the notify module's CI adapter (`notify/adapters/ci.ts`) and becomes the kind `ci_waiting`, "Deploy waits · production · claudepilot · #21", linking to `/admin/ci/runs/<id>`, on by default for every device and channel, Web Push urgency `high` (it wakes a phone), honouring quiet hours (held, then in the summary) and the per-event switch in the Events matrix; no button approves from the notification (the run page does). Facts are the environment, the repository, the run number and the job; the subject line, the inputs and the gate key never travel (tested with canaries in `notify/adapters.test.ts` and `notify/pipeline.test.ts`). A destination keeps an explicit list of kinds, so migration 720 adds `ci_waiting` to every destination made before the kind existed that hears `ci_failed` (one that opted out of CI stays out; `store/store.test.ts`). Not built: required reviewers other than "a person with manage", environment URLs and variables.
- **FR41a** **Auto-approve (T-110).** An environment has a rule, `autoApprove`: `off` (the default for every environment, old and new), `dry`, and `on` (slice 2; only on a protected environment). It is set only by a **person** with `manage` on the remote (`PUT /api/ci/repos/:id/environments/:name/auto-approve`, `UpdateCiAutoApproveRequest`; the handler refuses a Portal MCP token, an agent and a job with 403 as for protection, another user gets the same 404 as for a missing remote; no Portal MCP tool reaches it), and every change is in the platform audit (`ci.environment_auto_approve`, with the mode before and after). Migration 780 adds `ci_environments.auto_approve`, `auto_window` (`HH:MM-HH:MM` UTC, null: always) and `auto_paths` (the 'needs a person' list, null: the defaults), and the verdict on each deployment (`ci_deployments.auto_verdict`, `auto_line`, `auto_at`). The rule's conditions, ALL of which must hold, checked in this order and reported by the first that fails:
  1. the full gate is green on this exact commit: the job `gate` passed in this run and the last `gate: ` line of its log is `gate: green at <sha>` for the run's commit (a gate skipped by `gate=false`, a dry run's "would run", a red verdict or no verdict line is not green): the job's verdict, never an input;
  2. the job `build` passed;
  3. the jobs `verify` and `rollback` are in the pipeline, not left out, and both follow the deploying job; and an earlier release of the environment is recorded (a deployment approved, its job and its run passed), which is what the rollback goes back to;
  3b. (slice 2, the strictest reading: the owner's ticket leaves the ref open) the run is on the same ref as that release, the branch the environment is released from: a run on another branch waits for a person even when it descends from the release;
  4. the diff from that release's commit to this one (`cp-ci changes`, read in the workspace with git plumbing) touches no path on the environment's 'needs a person' list (`CI_AUTO_APPROVE_DEFAULT_PATHS`: `apps/server/src/authz/**`, every `apps/server/src/**/authz.ts`, `apps/server/src/secrets/**`, the Bypass code `apps/server/src/chat/bypass*.ts` and `apps/web/src/features/chat/Bypass*`, `.claude/settings.json`, `.pilot/**` and `scripts/gate*.sh` (the gate's own verdict comes from them), and the rule itself `apps/server/src/ci/autoApprove*.ts`), and changes or removes no migration that was present at that release (`apps/server/src/store/migrations.ts` is compared migration by migration; new numbers anywhere are fine, as on deploy #18 with 714 and 716); the commit must descend from the release;
  5. at most 6 rule approvals (dry: WOULD approve verdicts) of the environment in the last 24 hours ("today"), and none of them still running;
  6. inside the allowed window (default always);
  7. the previous deployment the rule approved (dry: would have) that actually went out is not failed and was not rolled back (a held deploy a person rejected did not go out and does not count).
  Where a fact can not be read reliably (a log, the diff, a commit missing in the remote, an old runner, a run record pruned) the answer is WOULD NOT with that reason: unavailable is a state, never a guess.
  **Built (2026-10-13, slice 1, DRY MODE only):** when a job of a protected environment whose rule is `dry` starts waiting (the same moment as the `waiting` hook), the portal evaluates the rule once and writes ONE line on the deployment (`CiDeployment.autoApprove`, shown on the run page above the jobs) and one audit row (`ci.deploy_auto_approve`, actor `rule:<environment>`, no user): `auto-approve (dry): WOULD approve: gate green at <sha>, build ok, verify and rollback present, no authz/secrets/Bypass/deny-rule/released-migration change in the diff, <n> of 6 today`, or `auto-approve (dry): WOULD NOT: <the first condition that failed>`. It approves NOTHING: it never reads the gate key, never calls `cp-ci approve` and never reaches the approve path; the job waits for a person exactly as before. `off` writes nothing. The API knows `off` and `dry` only and refuses `on`; a database row that says `on` (none can today) is treated as `dry`. CI → Remotes → a remote's environments has a one-word control, **Dry**, next to the approval switch of a protected environment (an InfoTip says what it does). Observed in the tests (`ci/autoApprove.test.ts`, a fake runner and clock for each condition, the real runner and git for the service): each condition refused with its own reason, the WOULD approve line with its count, a gate skipped by its input, a diff into `apps/server/src/authz` and an edit of released migration 610 refused through the real `cp-ci changes`, and after a WOULD approve the job still `waiting`, its key still in the portal, no `cp-ci approve` call, and one audit row. **Not built (slice 2):** the real approval as the actor `rule:<environment>`, notifying the owner once when the rule says no, the pause switch on Home and the environment, the automatic pause after a rollback or a failed verify, the Home Autonomy widget and the feed of auto-approved deploys, and editing the window and the 'needs a person' list in the UI (the API takes both today). (Slice 2 below built the real approval and the UI.)
  **Built (2026-10-14, slice 2, mode `on`):** a person sets `on` (`PUT .../auto-approve` `{ mode: 'on' }`, refused with 422 unless the environment is protected; audited `ci.environment_auto_approve` with severity high). When a held deploy of that environment starts waiting, the rule is evaluated once, exactly as in dry mode; then the environment is read AGAIN (the facts take seconds to read): only if its mode is still `on` AND its protection is still on does the rule act; otherwise it writes the dry line and approves nothing. The verdict is claimed once on the deployment (`auto_verdict IS NULL`; migration 781 adds `ci_deployments.auto_mode`, `dry` or `on`), so another poll or a second look never approves twice. When every condition holds, the portal approves through the very path a person's approval takes (`cp-ci approve` with the key only the portal holds, one decision per run at a time, the deployment re-read inside that lock and still `waiting`), recorded as decided by `rule:<environment>` with no user, audited `ci.deploy_approved` (actor `rule:<environment>`, `by: rule`). The line on the run is `auto-approve: approved: gate green at <sha>, build ok, verify and rollback present, no authz/secrets/Bypass/deny-rule/released-migration change in the diff, <n> of 6 today`. When a condition fails: `auto-approve: not approved: <the first that failed>; a person decides`, the job keeps waiting with its key, and a person approves or rejects as before. When every condition held but the approval did not go through (a person decided first, the run ended, the runner refused): `auto-approve: not approved: every condition held, but the approval did not go through (...)`. Every rule decision is one audit row `ci.deploy_auto_approve` (actor `rule:<environment>`, no user) with ids and fixed codes only: `mode` (`dry`/`on`), `verdict` (`would`, `would_not`, `approved`, `refused`, `failed`) and `condition` (`ok`, `state`, `gate`, `build`, `pipeline`, `release`, `ref`, `diff`, `busy`, `cap`, `window`, `previous`, `read`, `approve`); the free line is on the deployment, not in the audit. `decide` (the person's path) refuses an actor that says `rule:` or has no user, so no route can pass as the rule; the rule is reached from nowhere but the poll. The run page says who decided a held deploy (`Approved by <person>` or `Approved by the rule`, with when) above the rule's line. CI → Remotes → a remote's environments: a protected environment has a one-word button with the mode (`Off`, `Dry`, `Auto`, 44 px) that opens **Auto-approve**: the mode (Off / Dry / Auto), the hours (UTC, empty: always) and the 'needs a person' list (one per line, empty: the defaults), with InfoTips; the route keeps its person guard. Observed (2026-10-14, gate Job `claudepilot-gate-0385e12-a0ac`: typecheck, web build and `ci/autoApprove.test.ts`, `ci/routes.test.ts`, `ci/deployPipeline.test.ts`, `qa/migrations.test.ts`, 31 of 31): on the real runner the rule approves a harmless deploy as `rule:production` with one `cp-ci approve`, the key leaves the portal and the run passes through verify; another look, and a person afterwards, approve nothing more; a gate skipped by its input is refused with the job still waiting and its key kept; `decide` refuses `rule:production` and `session:s1` as deciders; protection or the mode switched off while the rule reads gives the dry line only; a person approving while the rule reads wins and the rule's line says its approval did not go through; on the real `.pilot/deploy.yml` (fake cluster) the rule refuses the first deploy (no earlier release) and approves the second; a run on another branch is refused (3b); an agent or a token setting `on` gets 403, another user 404. Browser Job `claudepilot-job-4a744e49` (`tools/qa/ci-autoapprove.mjs`, 97 of 97 at 390 and 1280 px, light and dark): the mode button 44 px, the choices 44 px, off -> dry -> on with hours -> off through the dialog, the dry line with Approve and Reject on a waiting run, 'Approved by the rule' with its line on a run the rule approved, no horizontal scroll, no page errors. Not observed live: production protection is off since run 19, and turning it on and the mode to `on` is a person's switch.
  **Still not built:** the pause switch on Home, a person's resume after the automatic pause (condition 7 already refuses every later deploy once a deploy the rule approved failed or was rolled back, and with no resume that refusal stays: it fails closed and a person approves by hand until the pause switch and its resume are built), the Home Autonomy widget, the feed of auto-approved deploys and the one 'Needs you' notify on a refusal (a refused deploy is still listed on Needs you as any waiting deploy is, T-146).
- **FR42** Artifacts are downloadable from the portal (`cp-ci artifact`, streamed, size-capped, `Content-Disposition: attachment`, `nosniff`).
- **FR43** An **importer** converts a simple `.github/workflows/*.yml` or `.gitlab-ci.yml` into a draft `.pilot/` file with the diagnostics for everything it could not carry over. It writes nothing; it returns text.

## 11. Hooks and the runner

### 11.1 The script

`cp-ci` is TypeScript in `apps/server/src/ci/runner/`, bundled by esbuild into one ESM file with a Node shebang and no dependency (no YAML in it). `npm run gen:ci-runner -w @portal/server` writes it to `images/workspace/cp-ci` and the same text to `apps/server/src/ci/runner.generated.ts`, from which the portal installs it; a test fails when either is out of date, as it does for `cp-session`. Node 22 is in the workspace image and on any machine that runs the portal.

Every command prints exactly one line to stdout, `@cpci ` followed by a JSON object, and nothing to stderr; the portal reads the last line with that prefix, so a stray warning in the merged exec output can't corrupt a result. Arguments are an `argv` array (no shell). Exit 0 with `{"ok":true,...}`; otherwise a non-zero code and `{"ok":false,"error":"<code>","message":"..."}`.

| Command | Does |
| --- | --- |
| `version` | The script's content hash, node and git versions. |
| `repo create/list/info/ensure/connect/delete/branches/rev` | FR1 to FR3, FR8; `branches` lists heads with their tip's subject and time; `rev` resolves a validated ref to a commit. |
| `hook post-receive` | FR5 (stdin: `<old> <new> <ref>` lines). |
| `poll [--ack ids] [--runs ids]` | Pending events (at most 100, oldest first), the state and liveness of the named runs, the repositories and their hook state, free disk. |
| `snapshot <repo> <sha>` | The commit's subject, author and parents and the text of `.pilot/*.yml`, `.pilot/*.yaml` and (M2) `.pilot/steps/*`, `.pilot/templates/*` (limits of §9.7), through `git cat-file`, with no repository code running. Also `contextPack`: `docs/context-pack.md` when the commit has it (at most 20 KB, else `too_large`; a link or binary set aside), which the portal keeps as the repository's context pack on a push to the default branch (persona-pool §12.4, T-292). |
| `changes <repo> <base> <head> [--show <path>]` | The paths that differ between two commits (at most 5,000, else `truncated`), whether `base` is an ancestor of `head`, and optionally one file's text at both (at most 1 MiB a side): what the auto-approve rule reads (FR41a). Plumbing only, no repository code runs. |
| `start <run>` | FR18 (plan on stdin). |
| `exec <run>` | The supervisor. Internal. |
| `log <run> <job> <n> <offset>` | A chunk of a step's log, with the next offset and whether the step is done. |
| `cancel <run>` | FR15. |
| `approve <run> <job> --bytes 64` (key on stdin) or `--reject` | FR41: leaves the decision where the run's supervisor looks for it; the supervisor checks the key against the gate in the plan. |
| `gc` | FR26. |
| `merge ...` | FR8. |
| `artifact ...` | FR42 (M3). |
| `validate` | The pipeline validator for an agent's shell (M2; adds the YAML parser to the script, Q5). |

All git calls pass `-c core.fsmonitor= -c core.hooksPath=/dev/null -c core.pager=cat -c diff.external=` and `GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0`, the hygiene `cp-session`'s diff uses, since a repository's configuration is the agent's.

### 11.2 Files

```
~/.claudepilot/git/<name>.git/hooks/post-receive
~/.claudepilot/ci/events/<id>.json                      pending (acknowledged ones move to events/done/)
~/.claudepilot/ci/runs/<run>/plan.json                  written once by start
~/.claudepilot/ci/runs/<run>/state.json                 rewritten atomically by the supervisor
~/.claudepilot/ci/runs/<run>/supervisor.pid, cancel     liveness (pid + start time), the cancel flag
~/.claudepilot/ci/runs/<run>/logs/<job>/<n>.log
~/.claudepilot/ci/runs/<run>/artifacts/<job>/...
~/.claudepilot/ci/runs/<run>/work/<job>/                clean checkout; deleted when the job ends
```

The Files browser and the chat's file tools already refuse `~/.claudepilot`; the agent's shell can still read it, which is the point of §16.

### 11.3 The plan and the state

The **plan** is what the portal asks `start` to run, and the only contract between portal and runner: `{ v, runId, repo, sha, ref, pipeline, env, timeoutMs, maxParallel, jobs: [{ id, name, needs, when, timeoutMs, continueOnError, env, steps: [{ name, run, env, workingDirectory, timeoutMs, continueOnError, when }], artifacts }] }`. Everything dynamic (matrix, `if:`, interpolation, `extends`) is resolved before it exists; the runner decides only `when` (success, failure, always) from job and step results. The **state** mirrors it with `status`, `reason`, `startedAt`, `finishedAt`, `durationMs` (measured by the runner's own clock, so skew between workspace and portal doesn't distort it), exit codes, log sizes and the artifact list per job.

### 11.4 What happens when things go wrong

| Case | Result |
| --- | --- |
| The portal is down at push time | The event file waits; the run starts after the portal is back. |
| The portal restarts mid-run | The supervisor continues; the next poll reads `state.json`, finishes the record, archives the logs. |
| The workspace stops mid-run | The run becomes `failed (runner_lost)` at the next poll after it starts; the logs written so far are kept. |
| A hook fails or `cp-ci` is missing | The push succeeds; no event; the Remotes view shows the hook as out of date and `ensure` repairs it. |
| Two portals or two polls see one event | The event id's unique key (and the acknowledgement) make it one run. |
| A step forks a daemon | It is in the step's process group and is killed with it at the end of the step. A process that daemonises out of the group is the workspace's own problem (§16). |
| The disk is nearly full | `start` refuses (`no_space`); the run fails with that reason. |
| An event for a deleted branch or an odd name | Recorded and ignored. |

### 11.5 Limits

One place for every number in this PRD. Those marked config are environment variables (`PORTAL_CI_*`); the rest are constants in `ci/limits.ts`, changed with the code.

| Limit | Value |
| --- | --- |
| Remotes per workspace | 20 |
| Pipeline files per commit, bytes per file | 20, 128 KiB; YAML depth 40; aliases 20 |
| Jobs per pipeline, steps per job, matrix combinations | 50, 100, 25 |
| Events per push, pending events per poll | 50, 100 |
| Concurrent runs per workspace (config), queued runs | 2, 20 |
| Parallel jobs per run (config) | 2 |
| Timeouts: step (none by default), job, run; the most any may be | 30 m for a job, 60 m for a run, 6 h |
| Free disk needed to start a run | 512 MiB |
| Logs in the workspace: per step, per run | 16 MiB, 64 MiB |
| Logs in the portal: per step (64 KiB head and 192 KiB tail), per run; a live chunk | 256 KiB, 2 MiB, 64 KiB |
| Artifacts: files per job, bytes per file, bytes per run; expiry | 100, 32 MiB, 128 MiB; 14 days |
| Kept: run folders in the workspace, events, run records in the portal | 14 days, 7 days, 30 days and the latest 300 per workspace |
| Polling: pending work, idle | 5 s, 15 s |
| Failure messages per ticket (or session): per hour, per day; failed runs in 30 min that pause them | 3, 10, 3 |

## 12. Data model

Stored in the portal's database, migrations 80 to 89. Nothing here is encrypted: no secret value is ever stored (a pipeline's secret names are not secrets). Text that came from a workspace is redacted before it is stored.

| Table | Key fields |
| --- | --- |
| `ci_workspaces` | `workspace_id` (pk), `max_runs`, `runner_hash` (the installed `cp-ci`), `updated_at`. |
| `ci_repos` | `id` (pk), `workspace_id`, `name`, `path`, `default_branch`, `protected` (JSON list of globs), `required_checks` (JSON list; M3), `merge_only` (M3), `source_path`, `connected_paths` (JSON), `created_at`, `removed_at`; unique (`workspace_id`, `name`). |
| `ci_events` | `workspace_id`, `id` (the event id; pk together), `repo_id`, `kind`, `ref`, `old`, `new`, `at`, `outcome` (`runs`, `no_pipeline`, `skipped`, `ignored`, `queue_full`, `invalid`), `note`. Kept 14 days. |
| `ci_runs` | `id` (pk), `number` (per remote), `workspace_id`, `repo_id`, `pipeline`, `trigger` (`push`, `merge`, `manual`, `schedule`, `rerun`), `event_id`, `ref`, `branch`, `tag`, `sha`, `base_sha`, `status`, `reason`, `actor`, `inputs` (JSON), `ticket_id`, `ticket_source`, `session_id`, `rerun_of`, `plan` (JSON), `state` (JSON: jobs and steps), `created_at`, `started_at`, `finished_at`, `duration_ms`, `archived` (0/1). Index (`repo_id`, `created_at`), (`ticket_id`), (`session_id`), (`status`). Unique (`workspace_id`, `event_id`, `pipeline`) for event-made runs. |
| `ci_logs` | `run_id`, `job`, `step` (pk together), `bytes`, `truncated`, `text` (redacted). |
| `ci_merges` (M1, minimal) | `id`, `repo_id`, `source`, `target`, `strategy`, `result_sha`, `actor`, `at`, `outcome`, `note`. |
| `ci_messages` (migration 81) | `id`, `run_id`, `session_id`, `ticket_id`, `at`, `outcome` (`sent`, `refused`, `capped`, `paused`), `note`: what the per-ticket caps and the pause after repeated failures count. Kept 7 days. |
| `ci_flaky` (migration 732) | `run_id`, `repo` (the remote's name), `job`, `file`, `test`, `ticket_id`, `at`; primary key (`run_id`, `repo`, `file`, `test`), index (`repo`, `file`, `test`, `at`). A test's ticket is the one its latest sighting names; the count is its rows. Not pruned with the runs (FR38a). |
| `ci_environments` (migration 610) | `id`, `repo_id`, `name` (unique per remote), `protected` (0/1, default 1), `owner_id`, `created_by`, `created_at`, `updated_at`, `updated_by`. |
| `ci_deployments` (migration 610) | `id`, `run_id`, `run_number`, `job` (unique per run), `repo_id`, `environment`, `pipeline`, `sha`, `ref`, `actor` (who started the run), `approval` (`pending`, `waiting`, `approved`, `rejected`, `auto`, `expired`, `skipped`), `gate_key` (the runner's one-time key for that job: random, never shown, logged or audited, cleared once decided or the run is over; not sealed, since it is useless outside its run and the workspace never reads the database), `decided_by`, `decided_at`, `outcome` (how the job ended), `created_at`. Kept a year, past their runs (the environment's history). |
| `ci_merge_requests`, `ci_schedules` (M3) | Described when built. |

Reads of other modules' tables go through adapters (§10 FR38); nothing here is read by another module except through the API.

## 13. API

Behind the session guard like every route, with the Origin check on mutations. `workspaceId` is `<target>/<name>`.

| Route | Does |
| --- | --- |
| `GET /api/ci/runs` | List: `workspace`, `repo`, `pipeline`, `branch`, `status`, `ticket`, `session`, `before`, `limit`; each row with its jobs' states as a short list. |
| `GET /api/ci/runs/:id` | The run with jobs, steps, reasons, the plan's pipeline name, links to ticket and session. |
| `GET /api/ci/runs/:id/log` | `job`, `step`, `offset`: `{ text, next, done, truncated }`. |
| `POST /api/ci/runs` | Start by hand (FR13): `{ repoId, pipeline, ref, inputs }`. |
| `POST /api/ci/runs/:id/cancel`, `/rerun` | FR15, FR14. |
| `GET /api/ci/runs/:id/bump`, `POST …/bump` | The sessions it can be bumped into; bump it: `{ sessionId, mode: prioritise (Fix) \| ask, note? }` (FR37a). |
| `GET /api/ci/repos` | Remotes (`workspace` filter) with their default branch, protection, hook state and the workspace's state. |
| `POST /api/ci/repos` | Create (FR1, FR2): `{ workspaceId, name, source?, connect? }`. |
| `PATCH /api/ci/repos/:id` | Default branch, protected branches (required checks and merge-only in M3). |
| `POST /api/ci/repos/:id/connect` | Connect a working repository (FR3). `DELETE /api/ci/repos/:id` deletes (FR3). |
| `GET /api/ci/repos/:id/branches` | Branches with tip, time and the latest run's status per pipeline. |
| `GET /api/ci/repos/:id/pipelines` | `.pilot/` at `ref` as the portal sees it: pipelines, their triggers and inputs, diagnostics. |
| `POST /api/ci/repos/:id/merge` | FR8: `{ source, target, strategy }`. |
| `POST /api/ci/validate` | `{ files: { path: text } }` to diagnostics (text in the body only, nothing read from a workspace). |
| `POST /api/ci/runs/:id/approve`, `/reject` | FR41: `{ job }`. A **person** only (a signed-in user with `manage` on the run; a token or an agent with every right gets 403); recorded in the platform audit. The environment's rule (FR41a, mode `on`) approves inside the portal through the same decision path, never through this route. |
| `GET /api/ci/repos/:id/environments` | The remote's environments with their protection and latest deployments. |
| `PUT /api/ci/repos/:id/environments/:name` | `{ protected }`: a person with `manage` on the remote; made when it does not exist yet; audited. |
| `PUT /api/ci/repos/:id/environments/:name/auto-approve` | FR41a: `{ mode: off \| dry \| on, window?, needsPerson? }`: a person with `manage` on the remote (a token or an agent gets 403, another user 404); `on` only for a protected environment; audited. |

Every route is declared in `ci/authz.ts` (resolvers for `ci_run` and `ci_repo`: a run or remote has its workspace's level; another user's answers 404 like a missing one).

## 14. MCP tools

Registered through A3b's registry (interface I2) from `ci/portalTools.ts`. Scopes: `read` reads, `operate` writes; `agent` is offered on the tools marked.

| Tool | Scope | Agent | Inputs | Output |
| --- | --- | --- | --- | --- |
| `ci_runs_list` | read | own branch or ticket | `workspace_id`, `branch`, `ticket`, `status`, `limit` | Runs: id, pipeline, branch, sha, status, reason, times. Log-derived text labelled untrusted. |
| `ci_run_get` | read | own | `id` | The run with jobs and steps; failing step and exit code; its deployments and what waits for an approval, with the run page's `link`. |
| `ci_run_logs` | read | own | `id`, `job`, `step`, `offset` | A bounded, redacted chunk labelled untrusted. |
| `ci_validate` | read | yes | `files` (path to text) | Diagnostics. |
| `ci_run_trigger` | operate | own branch, or a deployment pipeline on any branch of its own workspace | `repo`, `pipeline`, `ref`, `inputs` | The run and its `link`. Refused for a pipeline without a `manual` trigger. An agent may start a pipeline in which a job names an `environment` on a branch that is not its own: the portal holds that job for a person (FR41). The run is linked to the agent's session, so it can read and cancel it. |
| `ci_run_cancel` | operate | own | `id` | The run. |
| `ci_run_bump` | operate | no | `id`, `session_id` (left out: the sessions that can take it), `mode` (`fix`, `ask`), `note`, `confirm_token` | First `confirmation_required` with a preview (the run, the session and its state, the mode, the queue priority, the note), then the bump (FR37a). Listed only while session control is on. |

## 15. User experience

Under the UI text diet (PLAN rule 12): one-or-two-word labels, no paragraphs under titles, long text in `InfoTip`, icon buttons with accessible names, nothing decorative. Phones first; looked at at 390 and 1280 px.

- **Navigation.** One item, **CI**, with two views as tabs: **Runs** and **Remotes**.
- **Runs.** Filter chips (status as icons; workspace and branch menus). A row: a **status icon** (clock queued, spinner running, check passed, cross failed, slash cancelled; shape and colour), the branch in monospace, the short commit, the pipeline, the duration (live while running), the age, and a ticket chip when linked. A tap opens the run. Empty: "No runs yet" and the New remote action.
- **Run.** Header: icon, `#14`, branch at short commit, duration; icon buttons for Bump (FR37a), cancel (while active) and rerun; a row's ⋯ has Bump… too. Below, **jobs** as rows ordered by `needs` depth (a job under the ones it needs, indented one step on a phone, columns on a laptop), each with its icon and duration; a job opens its **steps**; a step opens its **log**: a monospace text block that follows the end while the step runs, with "load earlier" for a truncated one. Reasons ("timeout", "invalid pipeline", "runner lost") are one line on the failed step or the header; diagnostics of an invalid pipeline are the log. Artifacts, once any, are a small list under the job. A job held for an approval (FR41) shows a raised hand; above the jobs, a bar names the environment and the commit (who started it in an InfoTip) with **Reject** and **Approve** (on a phone the two buttons take their own row). A remote lists its environments under its pipelines: a shield, the name, the latest deployment's icon and run number, and a switch for the approval (turning it off asks once more).
- **Remotes.** A row per remote: name, workspace, default branch, protected branches as chips, hook state as an icon (ok or out of date). The create dialog: workspace, name, source folder (optional), connect (a checkbox). A remote opens to its **branches** (tip subject, age, the latest run's icon per pipeline) with Run and Merge as icon buttons, and its **pipelines** (the `.pilot/` files with a warning or error count, diagnostics in a sheet).
- **Chips elsewhere.** `RunChip` (an icon, `#14`, a link) is exported for the ticket page and the session page; it is a link to the run, nothing more.
- **Copy** is written to be short: titles `Runs`, `Remotes`, `Jobs`, `Log`; actions `Run`, `Merge`, `Cancel`, `Rerun`, `New remote`; states from the five words above; errors are one line.

## 16. Security requirements

- **Trust model, stated plainly.** A pipeline is repository code executed in the workspace as the workspace user: the same trust and the same blast radius as the agent itself. Whoever can push to the remote can already run commands as that user; a remote is a path, with no network service. CI adds no privilege, and its blast radius is the workspace container: its mounts, its network and its Docker limits.
- **Not a boundary.** The agent is the same user as the bare repository's owner and can edit its hooks or config, and with `sudo` can edit anything root-owned. Protected branches and required checks guard against mistakes and loops. A hard boundary would need the bare repository owned by another user behind a receive-only wrapper (Q4).
- **The portal never runs repository code** and never evaluates text from a pipeline. It parses YAML with the safe schema and limits on size, depth, aliases and merge keys, validates it, and passes a plan made only of resolved strings and numbers.
- **Hooks and events.** Hooks live in the bare repository's own `hooks/`, rewritten by the portal; the stub only calls the root-owned script by absolute path. Event files are written by a JSON encoder, never by interpolating ref names, authors or messages into shell or into JSON text. Every ref name and path is validated where it is read, and every command takes an argument array. A forged or edited event file can at most start a run of a commit that exists in that remote, which the agent could do with a push.
- **Paths.** A source or connect path must be absolute, under the files root, not under `~/.claudepilot` or `/etc/claudepilot`, and resolved (symlinks followed) before use. Artifact paths are globs relative to the checkout, resolved inside it; links leading out are skipped. `working-directory` can't leave the checkout.
- **Secrets.** Names only, from Secrets & env: a job's `secrets` are read by the runner from the files that pool delivered, for that job only, masked in its logs as they are written, and checked by name in the portal before the run. Values reach the workspace's terminals (and so a login shell's steps) as that pool delivers them (§10 FR20). Nothing carries a value through the portal. Logs pass the pattern redactor and the value redactor before they are stored or served. A secret name a pipeline lists but the workspace doesn't have is a warning before the run.
- **Environment.** Steps start from a clean environment: the runner's own variables, any session's token (`PILOT_MCP_TOKEN` of a chat session, and the admin classes that are never delivered) and the portal's keys are not passed on.
- **Logs and text.** Logs are plain text with control and escape sequences stripped, served as `text/plain` JSON data and rendered as a text node. Text that reaches a model (the failure message, MCP results) is sanitized, redacted, labelled untrusted and capped; the message frame tells the agent not to follow instructions in it.
- **Resource caps** (FR11, FR18, FR22 to FR24). Concurrency per workspace, a disk check, timeouts, log and artifact caps, and a lowered priority so a run doesn't starve the chats on the same container. A runaway job can still use the container's memory: the Docker limit of the workspace is the cap (Q2).
- **Loops.** FR36 and FR37.
- **Routes** are behind the session guard with the Origin check; MCP tools through the registry's scopes and audit; an `agent` token reaches only its own branch and ticket (and may START a deployment pipeline in its own workspace).
- **Deployments** (FR41). A job for a protected environment runs only after a person approves it in the portal, or the environment's rule that a person turned on (FR41a); the runner checks a key only the portal holds, so a file written in the workspace approves nothing, and no tool or token approves. This is a guard rail against a deploy on an agent's (or an injected prompt's) say-so through CI, and an audit trail; it is not a boundary against a shell in the workspace that runs the pipeline (same user: it can stop the supervisor, and the workspace holds whatever credentials the deploy uses). The jobs before the held one run unattended, like any manual run.
- **Start-up and background work** is wrapped in `try/catch` and skipped unless `store.deliveryAllowed`; the QA boot test stays green with this module present.

## 17. Observability

- Console: one terse line per run start and end and per failed poll (`[ci] r8k2 started ci on app@3fa91c2`), no log content.
- Every run is a record; `ci_events` records what each push did, including "no pipeline", "skipped" and "ignored", so "why did nothing run" has an answer in the Remotes view.
- The live socket topic `ci` tells open pages to reload; no page polls on its own while the socket is up.
- The Remotes view shows per workspace whether the runner is installed and current, the hooks are current, and how much disk the CI folder uses.
- Counts by status feed the Monitoring dashboard later (failed runs on protected branches); not in M1.

## 18. Testing

| Area | Tests |
| --- | --- |
| Spec | Every key, valid and invalid; each diagnostic's code, position and hint; the warning and refusal tables of §9.4; limits (size, depth, aliases); `extends` and `include` merges (M2); matrix expansion and `exclude` (M2). |
| Expressions | Parser and evaluator on a table of cases; injection attempts (`${{ }}` in `run`, odd branch names in `if`); status functions only as top-level terms. |
| Compile | Plans for the examples; `when` from `if`; skipped jobs; `needs` cycles; environment names; no secret value can appear. |
| Runner (real) | The generated script run with `node` against real `git` in temporary repositories with `HOME` set to a temporary folder: create a remote, push and read the event file; `start` a plan and watch `state.json` pass; a failing step; a timeout; cancel; a detached supervisor surviving the end of the process that started it; artifacts and `needs`; log caps; `gc`; the same `start` twice. |
| Hooks | Ref names with newlines, quotes, `$()`, spaces and unicode become one valid event or are dropped, never a command. |
| Merge | Fast-forward, merge commit, conflict (files named), moved target, the event written. |
| Service | A fake runtime that runs `cp-ci` locally: events to runs, dedupe after a restart between store and acknowledgement, concurrency cap and queue order, `concurrency.group`, runner lost, rerun, cancel of queued and running, archive and redaction, linking (branch, trailer, session) and the loop caps, with fake ticket and session adapters. |
| Routes | The session guard on every route; validation errors; the Origin check. |
| Boot | `qa/boot.test.ts` on a frozen database: no start-up work, no crash. |
| Real (manual) | One Docker workspace: install, create, push, pass, fail, merge, cancel, restart the portal mid-run, timeout, the log tail and chips in a browser at 390 and 1280 px; recorded in §19. |

## 19. Rollout and milestones

| Milestone | Scope | Gate | Status |
| --- | --- | --- | --- |
| K0 | This PRD, reviewed by the coordinator | Read and redirected | **Written** |
| M1 | Remotes and hooks, `.pilot/` spec and validator (core keys, no `matrix`/`extends`/`uses`/`secrets`), `cp-ci` and run records, triggers push, merge (by push or portal merge) and manual, the observation loop, list, detail and live log, rerun and cancel, status chips on the Runs list, tests | Real Docker workspace, §18 "Real"; browser at 390 and 1280 px | **Built.** Server `apps/server/src/ci` (spec, runner, service, routes), migration 80, web `apps/web/src/features/ci`, nav item "CI". 55 tests on real git and a real shell, plus the QA boot test. **[observed]** in a Docker workspace (`ci-a`, runner installed by exec as root-owned `/etc/claudepilot/bin/cp-ci`): remote created from a repository and connected as `pilot`; a push shows a run within about 8 s; an invalid pipeline fails at once with `file:line:column`, a hint and its path; a passing run with a job's artifacts handed to the job that `needs` it; a failing step (exit 7) skipping the rest, with the job after it skipped; a merge into `main` made by the portal (fast-forward) starting the run whose `deploy` job runs only on a merge; a manual run with inputs; a cancel that left no process behind (the supervisor and the step were each their own process group); a step timeout (4 s) that stopped the whole group, ran the `always()` step after it and left no stray process; **the portal killed in the middle of a run: the run finished by itself, a push made while the portal was down waited as an event file, and after the restart the portal recorded the finished run (36 s, logs kept) and made the run for the waiting push**; the runner updated itself in the workspace on the first poll after a code change. UI at 390 and 1280 px: Runs list, run page with a live log following a running step, Remotes with branches and a run and a merge dialog, New remote dialog. Not observed: Kubernetes (no `delivery` access; unsupported by design in M1), a Docker workspace stopped and started with a run open (covered by a test against a killed supervisor, not on Docker). |
| M2 | Ticket and session attachment (adapter, timeline entries, chips), the failure message with its caps, Portal MCP tools, `matrix`, `secrets`, local `uses` steps, `extends` and `include`, path filters, `cp-ci validate`, artifact download | Fake adapter, then A3b's ticket service; an agent token | **Partly built.** Built: the two adapters (`ci/tickets.ts` over A3b's `find`, `attachCheck`, `note`; `ci/sessions.ts` over the chat controller, each with a fake), run linking (session, then trailer, then branch), the ticket's check set when a run starts and ends, the failure message with its caps (3 an hour and 10 a day per ticket, a pause after the third failure in a row that says so once on the ticket, a pass starting it over), the six Portal MCP tools through A3b's registry with the agent scope limited to the caller's own branch and ticket, `RunChip` on the session page, **`secrets` by name** (portal check against Secrets & env's names-only read, runner reads the delivered file, masks the value in logs, portal redacts every other exposed secret by value, live and kept) and **`strategy.matrix`** (with `fail-fast` and `max-parallel`). 8 link tests, the message builder tested for quoting and caps, 1 end-to-end test of the tools through A3b's real endpoint harness with an admin token and an agent token. **[observed]** on a real portal: a push to `ticket/1-greeting` with a `Ticket: T-1` trailer gave ticket T-1 a `ci` check (running, then passed, linking to `/admin/ci/runs/<id>`) and two timeline entries of kind `ci` with the actor `ci:<run id>`; the ticket page showed the chip. Not observed: a failure message reaching a real chat session (the chat adapter is typed against the controller and tested only against its fake; the chat now accepts the actor `ci:<run id>` and shows a "From CI" card (A2), and the adapter uses it), the tools over a real Claude Code, `RunChip` on a live session page (needs a worktree session). **[observed]** in the Docker workspace after the portal restarted (the runner updated itself): a 2x2 matrix with an `exclude` ran as three jobs named `Test (20, linux)`, `Test (22, linux)`, `Test (22, mac)` and a `report` job that needed all three; a job naming an unassigned secret failed at once with `secret-missing`; the portal's QA fuzz found 0 findings (112 mutating routes, 3326 requests); the boot test is green with the module present. Not built: local `uses` steps, `extends` and `include` (each is refused with a message saying so), path filters, `cp-ci validate`, artifact download. |
| M3 | Merge requests with required checks and protected-branch enforcement, environments and deployments, schedules, importers | | **Partly built.** Built (2026-10-13): environments and deployments with a person's approval (FR41, migration 610, `cp-ci approve`, the approval bar on the run page, environments with their protection switch under a remote, audit rows), the agent rule for starting deployment pipelines, and this repository's own deploy pipeline `.pilot/deploy.yml` (gate, build in the cluster, release by pushing `main`, verify, chats, rollback; docs/dev-session.md). T-277 layer 4 (2026-10-14): the release records the chats attached to a live process and waits (at most 2 minutes) while one has an unanswered control request; a `chats` job after verify fails the run, naming the chat and the reason, when one of them ended for integrity within 10 minutes of the restart, and lists the survivors with their follower count; it is not a need of rollback, so it rolls nothing back. The portal tells the steps through one fixed-format `[deploy-chats]` log line from the CI service (steps hold no portal credential, FR20); no route, tool or migration. Tests: the line and its sanitising, the watch, the read-only count of open control requests over the real chat store, the scripts against the fakes (recorded, answered, the wait at its bound, unavailable, an ended chat fails, survivors pass with followers, forged lines ignored) and the CI service's line reaching the release step through the real runner end to end. Not observed yet: a real deploy (batched with the next one). Tests: the runner holding a job (a wrong or forged key approves nothing, a reject ends the run, cancel), the service (approve, reject, protection off and on, a held job kept held, rerun gates, expiry, the key never in an answer, the plan or the audit), the routes with two users (B gets 404 everywhere, a token and an agent get 403 on approve and protection), the tools (an agent starts a deployment on another branch, sees it wait, has no tool to approve), and the deploy scripts against a fake kubectl, gh, curl and GitHub (dry run, release, refused release, rollback, the token masked) and through the real runner end to end. **[observed]** in a Docker workspace on a scratch portal: a run held at `release` (a raised hand in the list and on the run page), approved from the browser at 390 px (it ran to `passed`; one `ci.deploy_approved` audit row), a second run rejected (cancelled, `rejected` once on the job); the environment row with its switch and the confirmation, at 390 and 1280 px, light and dark. Not observed: the real cluster (the coordinator runs the pipeline), a Kubernetes workspace. Not built: merge requests, required checks, schedules, importers. |

## 20. Success metrics

| Metric | Target |
| --- | --- |
| A push to the remote shows a run in the portal | Within 10 s while the portal is up |
| A run lost or duplicated across a portal restart | Zero (restart test) |
| A step or run over its timeout still running | Zero |
| A secret value in a stored log, a plan, a message or an API response | Zero (canary test) |
| CI-to-agent loops | Zero beyond the caps (loop test) |
| A pipeline error an agent can't fix from the message alone | Tracked from real use |

## 21. Amendments to other PRDs, and requests

| To | Change |
| --- | --- |
| [Chat sessions](chat-sessions.md) (A2) | The portal actor `ci:<run id>` (FR14): add `ci` to the actor pattern and "From CI" to the transcript card. **Done** (A2): `ci` is in the pattern and the transcript has a "From CI" card; the adapter falls back to `portal:ci-<run id>` only if the pattern refuses `ci:`. After a worktree branch is made in a repository that has a `pilot` remote, `branch.<b>.pushRemote=pilot` would let a plain `git push` reach CI (optional). |
| [Tickets](tickets.md) (A3b) | **Done** (A3b): `find`, `checks`, `attachCheck` (one row per ticket and pipeline, a timeline entry of kind `ci` per state change) and `note`; the ticket page shows the checks as chips, so it does not import `RunChip`. |
| [Portal MCP](portal-mcp.md) (A3b) | The tools of §14 in the registry; the `agent` scope rule for "own branch". |
| [Secrets & env pool](secrets-env-pool.md) (A3a) | An API that says whether a name is assigned and exposed in a workspace (for the pre-run warning). |
| [Pools foundation](foundation-pools.md) | None: CI installs its own script the way the chat host does; it isn't a pool. |
| Shared files | Live topic `ci`; the `ci` page in navigation; config keys `PORTAL_CI_*`; migrations 80 to 89. |

## 22. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | Should the hook also start the run, so a push runs while the portal is down? (v0.1: no. The portal is the scheduler, and events wait.) | Product |
| Q2 | A run shares the workspace's CPU and memory with its chats. A dedicated runner container beside the workspace (like the browser pool's) is the alternative; default caps are 2 runs and 2 jobs. | Product, Engineering |
| Q3 | Kubernetes workspaces need `cp-ci` in the image and a path to exec without delivery access. Until then they can't have remotes. | Engineering |
| Q4 | Is a hard boundary for protected branches worth a second user and a receive-only wrapper in the container? | Product |
| Q5 | Should `cp-ci validate` ship in the script (adding the YAML parser, about 100 KiB) so agents can check a file from their shell, or stay a portal API and MCP tool? | Engineering |
| Q6 | Importers: which workflows to support first, and is "draft with diagnostics" enough? | Product |
| Q7 | `cache:` is left out because the home volume persists. Does a clean-cache run need a switch? | Product |
| Q8 | The numbers: 2 runs, 2 jobs, 3 messages an hour, 14 and 30 days. Tune from use. | Operator |
| Q9 | Run starts on `[skip ci]` are recorded as skipped. Should an agent be able to skip with a push option instead? | Engineering |
| Q10 | Should a green run on a ticket's branch be able to move the ticket to review? (v0.1: never; a person or the agent does.) | Product |

**Needs you (T-146):** a deployment waiting for a person's approval (FR41) is listed on Needs you ([attention.md](attention.md) §2, `ci/attention.ts`) with the environment, the gate's verdict and the commit, for a person only.
