# `.pilot/`: the project's pipelines

Pipelines of the portal's own CI. Every `*.yml` directly in this folder is one pipeline. They run inside the
workspace, as the workspace user, from a clean checkout of the commit, started by a push to the workspace's CI
remote (the git remote `pilot`) or by hand. The format is a small closed YAML shaped like GitHub Actions: `on`,
`jobs`, `needs`, `steps` with `run`, `if`, `timeout`, `artifacts`, `environment`, `secrets`. Unknown keys are
errors. Values reach scripts as environment variables (`PILOT_SHA`, `PILOT_BRANCH`, `PILOT_BASE_SHA`,
`PILOT_INPUT_<NAME>`, ...); `${{ }}` is refused inside `run`. Policy (protected environments, approvals) lives in
the portal, never in these files.

## The files

| File | What it does |
| --- | --- |
| `gate.yml` | **Quick gate** on every push of `{{INTEGRATION_BRANCH}}` and of `ticket/**` branches: install and `{{TEST_QUICK}}`. **Full gate** by hand with input `full: true`: install, `{{TEST_FULL}}` and `{{BUILD_CHECK}}`. Both as a cluster Job through `{{JOB_RUN}}` (below). A new push to the same branch cancels the older push run; a manual run has its own group, so pushes never cancel a full gate. |
| `deploy.yml` | **Deploy**, by hand only: `gate` (the full gate on the commit; input `gate: false` skips it, used only on the owner's explicit word for that run), `build` (leaves what it made in `.pilot/out/build.env`), `release` (waits for a person when its environment is protected, then deploys; leaves `.pilot/out/release.env`, even on failure), `verify` (the release is live and well), `rollback` (only when `release` or `verify` failed: back to what was approved before). Inputs: `images`, `gate`, `deploy`, `dry_run`. |
| `scripts/` | What the jobs run, when a command grows past one line. Not read by the portal. |

Both files come from the operating kit's templates, which were checked with the portal's own pipeline validator
and compiler after substitution with sample values (valid, every job planned as expected). The commands they run
are the project's to write and test.

## The approval path

1. A person or an agent starts `deploy` (the portal: CI > Remotes > the remote > Run; an agent: the Portal MCP
   `ci_run_trigger`). Push the commit to the `pilot` remote first.
2. `gate` and `build` run unattended.
3. `release` names an `environment`. The first run that names one creates it in the portal, **protected**.
   A protected environment holds the job as `waiting` (a raised hand on the run, a notification to the owner).
   Only a **person** pressing Approve on the run page releases it; Reject cancels the run. No tool, token or file
   in the workspace approves. An agent never tries.
4. `verify` and, on failure, `rollback` run unattended: a rollback returns to the state a person approved before.

## Environments

| Environment | Protection | Who deploys |
| --- | --- | --- |
| `stg` (or any stg-like, internal one) | **Unprotected**: a person switches protection off once, in CI > Remotes > the remote > environments (the portal asks to confirm: agents can then deploy on their own). | The orchestrator, grouped, never on every merge. |
| `uat` | **Protected.** | Started by a person, or by the orchestrator only where a standing decision allows it; released only after a person approves. An agent never acts on the environment itself. |
| `production` | **Protected.** | The same. A production question is one line on the owner's checklist. |

One file deploys to one environment (`environment:` is a fixed name). For several, keep one file per
environment: `deploy-stg.yml` naming `stg`, `deploy.yml` naming `production`, each with its own concurrency group.

## What to adapt

- **The build, release, verify and rollback commands.** Usually `bash .pilot/scripts/<job>.sh`. Each must:
  honour `PILOT_INPUT_DRY_RUN=true` (print every action, change nothing); never `set -x` and never echo a
  credential; push the release branch fast-forward only, never forced; let the release branch move first and the
  working branch catch up as a separate step (a working branch that moved while the release waited must not fail
  the deploy); write what the next job needs to `.pilot/out/*.env`; and have tests against fakes (a fake remote,
  a fake cluster) before the first real run.
- **Both gates run as cluster Jobs** (T-491). Each lane is one `{{JOB_RUN}} --ref "$PILOT_SHA" -- '<command>'`:
  the Job clones the commit, runs `npm ci` (job-run's default step, in each folder with a `package-lock.json`),
  then the command; the quick lane runs `{{TEST_QUICK}}`, the full lane `{{TEST_FULL}} && {{BUILD_CHECK}}`. The
  workspace only streams the log, so the pipeline needs no `flock /tmp/heavy.lock`: do not add one. The commit
  must be on the repository job-run clones from (GitHub or Gitea), not only on `pilot`: push it to both. A red
  install, check or build is the step's exit code. Without a cluster, replace the line with the bare command.
  Each step's `timeout` is job-run's own `--timeout` plus 10 minutes for the Job queue (3 Jobs at once cluster-wide):
  keep that margin when you change either. `--repo event` takes no `--also`, and its token goes to that one URL only.
- **The quick gate's base.** In CI the commit the branch moved from is `$PILOT_BASE_SHA` (empty for a new branch or
  a manual run). The Job does not see `PILOT_*` variables and its clone is one commit deep: pass the base as an
  argument (`{{JOB_RUN}} --ref "$PILOT_SHA" -- {{TEST_QUICK}} "$PILOT_BASE_SHA"`, the several-words form) and
  fetch it in the command.
- **Secrets.** A job that needs one lists it by Secrets pool name (`secrets: [NAME]`); the value never appears in a
  file, a plan or a log. The run fails with `secret-missing` when the workspace does not have it.
- **The every-two-hours full gate.** Schedules are not in the format yet; the orchestrator starts it by hand.

Distilled from the platform repository's own `.pilot/deploy.yml` and its scripts (the project-specific parts,
image names, registry, manifest and cluster names, are left to `.pilot/scripts/`).
