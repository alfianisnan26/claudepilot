# Autonomous development in the cluster

ClaudePilot is developed by **one orchestrator session** in the cluster's dev workspace (`kubernetes/kohi-event`, folder `~/work/claudepilot`), in Bypass
mode, with **sub-agents** (Claude Code's own Agent tool) doing the work in git worktrees, without a person in the loop. The owner approves deploys only.
Read `CLAUDE.md`, `docs/dev-context.md` and `docs/dev-session.md` first. `orchestrator.md` is the brief of the orchestrator; `track-a-connect.md`,
`track-b-notify-triggers.md` and `track-c-ui.md` are the work packages it hands out. Everything below binds the orchestrator AND every sub-agent.

## Ground rules

1. **No questions.** Nobody answers in real time. Take the PRD's recommended default, write the decision in the status file, go on. Do not use
   AskUserQuestion. A thing that needs a real device, a credential or an owner decision goes under NEEDS A HUMAN in the status file; skip to the next item.
2. **Worktrees.** Sub-agents work in a git worktree each, never in the main folder `~/work/claudepilot`, and never in another agent's worktree. Prepared
   ones (with `node_modules`) are in `~/work/claudepilot.worktrees/`; a new one is `git worktree add ~/work/claudepilot.worktrees/<name> -b dev/<name> origin/integration`
   and then `flock /tmp/heavy.lock npm ci` (`NODE_AUTH_TOKEN` is set in the shell; the private `@isnanme/ui` package needs it). The Agent tool's
   `isolation: "worktree"` also works, for a short task that needs no `node_modules`.
3. **Safety, whatever Bypass lets you do.**
   - Never print, log, commit or paste a credential. No token-shaped literal anywhere in the repo (build fixtures at runtime). Do not read
     `~/.config/gh`, `~/.git-credentials` or `~/.kube/config`, and do not dump Secrets.
   - `kubectl`: read freely. Change things only in a namespace you create for a rig, with `scripts/dev-rig.sh create dev-rig-<name>` and `scripts/dev-rig.sh delete dev-rig-<name>`
     (the only door: `kubectl delete namespace` is denied, the script refuses any other name); delete it when you are done.
     Never touch `isnan-claudepilot`, `isnan-claudepilot-workspaces` (this workspace hosts the session: stopping, deleting or restarting it, or
     restarting the portal, kills it), Argo CD, the nodes or any other namespace. A workspace's CPU and memory are changed in the portal (T-98 replaced
     `scripts/ws-resources.sh`: the workspace sheet's Resources row, or the admin MCP tool `workspace_resources`), by a person: Apply now restarts the pod and ends every session in it.
   - Never push `main`. Never approve a deploy or work around its approval. For anything that needs a portal, run a scratch one:
     `scripts/scratch-portal.sh` (clean environment). Never change the real portal's settings, tokens or Secrets.
   - Never force-push, rewrite pushed history, use `--no-verify` or amend a pushed commit.
   - `.claude/settings.json` denies pushing `main` and changing the portal, workspace and Argo CD namespaces with `kubectl`, even in Bypass. That is
     deliberate: do not look for another way to do those things (a script, `sh -c`, another tool); write it under NEEDS A HUMAN instead.
4. **Heavy jobs one at a time** (the pod has 4 CPUs and 8 GiB): typecheck, the server suite, a production build, `scripts/gate.sh` and Chromium runs go
   through `flock /tmp/heavy.lock nice -n 10 <command>`. Targeted tests (one file) run directly. At most one scratch portal and one Chromium per
   sub-agent; stop them when done. Keep `/tmp` clean (`/tmp/gate-*`, `/tmp/cp-*`): a full `/tmp` makes CI tests fail. **At most three sub-agents run at once.**
5. **Do not loop.** The same command failing three times means change the approach or move to the next item and write down why.
6. **Quota.** The portal moves the chat to another Claude by itself when one runs out. If a turn fails with a limit error, wait a few minutes and go on.
7. **Do not start other Bypass sessions** (`session_spawn` workers are never Bypass anyway): sub-agents of the Agent tool are the way.

## Who integrates

Sub-agents commit on their own branch (unsigned: `git -c commit.gpgsign=false`; the message says what and why and ends with
`Co-Authored-By: Claude <noreply@anthropic.com>`) and push that branch (`git push -u origin <branch>`). **Trailers (owner, 2026-10-13, T-27):**
until the prepare-commit-msg hook of T-27 writes them, every commit by the orchestrator or a sub-agent also ends with two hand-typed
trailer lines, `Pilot-Session: <the orchestrator's chat session id>` and `Pilot-Agent: main` (the orchestrator) or `Pilot-Agent: <the slice's
label, e.g. track-a-t6>` (a sub-agent); with `git commit -m "<subject and body>" -m "Co-Authored-By: … \nPilot-Session: …\nPilot-Agent: …"`
the trailers are their own paragraph at the end. Once the hook exists, a sub-agent exports `PILOT_AGENT="<label>"` instead. **Only the orchestrator pushes `integration`**:

```sh
cd ~/work/claudepilot && git fetch origin && git merge --no-ff origin/<branch>     # or rebase the branch first; never discard somebody's lines
flock /tmp/heavy.lock nice -n 10 scripts/gate-quick.sh                              # FAST LANE: typecheck, web build+tests if web, the touched areas' tests
git push origin HEAD:integration && git push pilot HEAD:integration                 # fast-forward only; if refused: fetch, merge, check again
```

**Two lanes (T-36, owner 2026-10-13).** INTEGRATION is the fast lane: `scripts/gate-quick.sh` (minutes; it maps the changed paths to the server
areas that test them, and runs the whole server suite when contracts, migrations, authz, the platform, settings or the app's own files changed),
then push: after every slice, and at least every 8 commits or every 2 hours (nothing piles up on the pod disk). RELEASE is the full gate:
`scripts/gate.sh` on the exact commit before any deploy (the deploy pipeline's `gate` input stays true; `gate=false` only with a green full gate
on that very commit), and once every two hours on integration's head in the background. A red full gate on integration is fixed first, before
any new slice is merged: integration stays shippable. **Heavy work leaves the pod (T-37):** a full gate, and a typecheck plus web build when
the pod is loaded, run as a Job in the cluster: `scripts/gate-job.sh <commit> [typecheck,web-build,server-suite]` (the commit on GitHub; push an
unpushed merge to `wip/orchestrator-local-backup` first); the deploy pipeline's gate does too. Sub-agents run only their package's typecheck and
their test files, never a build or a gate.
Then the sub-agent on that branch runs `git fetch origin && git rebase origin/integration`. Remove `/tmp/gate-<sha>*` afterwards.

## Migrations

Append only, by version number. Package A 710-719, package B 720-729, package C 730-739. Never edit a released migration (everything up to 610 is
released). Parked on the WIP branch and NOT to be merged: 400-401 (multi-user identity).

## Status and final report

`docs/dev-sessions/status/orchestrator.md`, at most 80 lines, overwritten, committed with the work: DONE (item and commit), IN FLIGHT (sub-agent, branch,
worktree), DECISIONS, NEEDS A HUMAN, NEXT. The orchestrator after a restart, and the supervisor's continuation prompt, read it first. When the whole
backlog is done: make `TRACK COMPLETE` the first line of that file, commit and push it, and end with a final report of at most 25 lines.

## The supervisor

A small process, `docs/dev-sessions/supervisor.mjs`, runs inside the dev workspace (started by the coordinator with the owner's sign-in code in its
environment; the code is never in a file) and keeps the orchestrator going when nobody else is there: a session idle for a few minutes is told to
continue, an interrupted one is woken, one that ended is started again in the main folder and told to continue from its status file (at most 6
starts per day, 3 after integrity endings). It leaves the work alone when the status file starts with `TRACK COMPLETE` or when a person closed the
session. Log: `~/.claudepilot/dev-sessions/supervisor.log`; state: `state.json` next to it.
**Stop it:** `touch ~/.claudepilot/dev-sessions/STOP` (checked every two minutes) or kill the process by PID. **Start it again** (needs `PORTAL_SERVER_CODE`):
`cd ~/work/claudepilot && PORTAL_SERVER_CODE=... setsid nohup node docs/dev-sessions/supervisor.mjs >> ~/.claudepilot/dev-sessions/supervisor.log 2>&1 < /dev/null &`.
`DRY_RUN=1` reads the portal and says what it would do. It approves nothing unless `DEPLOY_RUN=<run id>` is given, and then only that run.
