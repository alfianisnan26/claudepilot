# Autonomous development in the cluster

ClaudePilot is developed by **one orchestrator session** in the cluster's dev workspace (`kubernetes/kohi-event`, folder `~/work/claudepilot`), in Bypass
mode, with **sub-agents** (Claude Code's own Agent tool) doing the work in git worktrees, without a person in the loop. The owner approves deploys only.
Read `CLAUDE.md`, `docs/dev-context.md` and `docs/dev-session.md` first, `DECISIONS.md` (the owner's standing decisions: never act against a row), and `CHARTER.md` (the owner's autonomy charter: zero tolerance, duties, scoring; it binds every agent, here and in the Konfersi program). `orchestrator.md` is the brief of the orchestrator; `track-a-connect.md`,
`track-b-notify-triggers.md` and `track-c-ui.md` are the work packages it hands out. Everything below binds the orchestrator AND every sub-agent.

## Ground rules

1. **No questions.** Nobody answers in real time. Take the PRD's recommended default, write the decision in the status file, go on. Do not use
   AskUserQuestion. A thing that needs a real device, a credential or an owner decision goes under NEEDS A HUMAN in the status file; skip to the next item.
   An agent never files a needs-a-person ticket for a platform step it can do with a tool (taking over an ended chat's tickets with `ticket_adopt`,
   a continuation with `continuedFrom`, a restart, a move): it does the step and says so in one line on its status ticket instead (T-270, D-34).
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
     the workspace sheet's Resources row, or the admin MCP tool `workspace_resources`), by a person: Apply now restarts the pod and ends every session in it.
   - Never push `main`. Never approve a deploy or work around its approval. For anything that needs a portal, run a scratch one:
     `scripts/scratch-portal.sh` (clean environment). Never change the real portal's settings, tokens or Secrets.
   - Never force-push, rewrite pushed history, use `--no-verify` or amend a pushed commit.
   - `.claude/settings.json` denies pushing `main` and changing the portal, workspace and Argo CD namespaces with `kubectl`, even in Bypass. That is
     deliberate: do not look for another way to do those things (a script, `sh -c`, another tool); write it under NEEDS A HUMAN instead.
4. **Heavy jobs leave the pod** (T-107; the pod has 4 CPUs and 8 GiB): typecheck, the server suite, vitest, playwright, lighthouse, production
   builds and wrangler dry runs go through `scripts/job-run.sh [--repo claudepilot|konfersi[:<org>/<repo>]] [--ref <pushed branch or commit>] -- <command>`,
   a Job on another node (push the WIP branch first: `git push origin HEAD:wip/<name>`; at most 3 Jobs at once and 2 per chat, the rest wait
   "queued behind K"; `--list`, `--stop --chat <id>`). An image (no Docker here, D-5) is built by `scripts/image-build.sh --repo .. --ref .. --dockerfile ..
   --destination <registry/path:tag>` (T-141: kaniko, one at a time, the registry credential as one JSON line on stdin with `--credential-stdin`;
   `--check` first, 0 exists, 3 not). Lighthouse and timing measurements run there too (a quiet node). **flock only for what must
   run in the pod** (a scratch portal, a browser check against it, `npm ci` of a worktree): `flock /tmp/heavy.lock nice -n 10 <command>`; a command that leaves a process running (a scratch
   portal) takes `flock -o`, so the lock ends with the command (T-159: a portal held it for 50 minutes). A
   targeted test (one file) may run directly. At most one scratch portal and one Chromium per sub-agent; stop them when done. Keep `/tmp` clean (`/tmp/gate-*`, `/tmp/cp-*`): a full `/tmp` makes CI tests fail. **At most five sub-agents run at once** (D-43).
5. **Do not loop.** The same command failing three times means change the approach or move to the next item and write down why.
6. **Quota.** The portal moves the chat to another Claude by itself when one runs out. If a turn fails with a limit error, wait a few minutes and go on.
7. **No SendMessage** (coordinator, T-136, until the portal accepts the case): a sub-agent NEVER calls SendMessage to the main conversation
   (a sub-agent's queued message ended the orchestrator fdb140be for integrity, origin peer); it reports in its final message, files, commits
   and tickets only, and every brief says so. Chat to chat goes through the Portal MCP `session_message`, never SendMessage to another session.
8. **Do not start other Bypass sessions** (`session_spawn` workers are never Bypass anyway): sub-agents of the Agent tool are the way.

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
Then the sub-agent on that branch brings it up to date: rebase ONLY commits that were never pushed; once a branch is pushed, merge `origin/integration` into it instead (`git merge origin/integration`), because a rebased pushed branch could only be pushed back with a force push, which is denied. Remove `/tmp/gate-<sha>*` afterwards.

## Migrations

Append only, by version number. Package A 710-719, package B 720-729, package C 730-739. Never edit a released migration (everything up to 610 is
released). Parked on the WIP branch and NOT to be merged: 400-401 (multi-user identity).

## Status and final report

`docs/dev-sessions/status/orchestrator.md`, at most 80 lines, overwritten, committed with the work: DONE (item and commit), IN FLIGHT (sub-agent, branch,
worktree), DECISIONS, NEEDS A HUMAN, NEXT. The orchestrator after a restart, and the supervisor's continuation prompt, read it first. When the whole
backlog is done: make `TRACK COMPLETE` the first line of that file, commit and push it, and end with a final report of at most 25 lines.

## The supervisor

A small process, `docs/dev-sessions/supervisor.mjs`, runs OUTSIDE the dev pod, on the coordinator's machine, with the owner's sign-in code in its environment (inside the pod every agent runs as the same user and could read that environment, so the code must never live there; T-104's lease replaces the code), and keeps the orchestrator going when nobody else is there: a session idle for a few minutes is told to
continue, an interrupted one is woken, one that ended is started again in the main folder and told to continue from its status file (at most 6
starts per day, 3 after integrity endings). It leaves the work alone when the status file starts with `TRACK COMPLETE` or when a person closed the
session. On every round it reads each track chat's `mode`: one that is not in Bypass (a wake from sleep or a Resume starts on the start
mode, FR20) gets it back through the person's gates, the server code again and the acknowledgement, and a tool approval asked before that
is denied with "run it again" (T-256; one log line each). It restarts only the orchestrator: any other chat that ends (an integrity ending, say) is started again by a person; the harness-turn
ending that hit the Konfersi chat on 2026-10-13 is fixed (T-99), so that should no longer be needed. Log: `~/.claudepilot/dev-sessions/supervisor.log`; state: `state.json` next to it.
**Stop it:** `touch ~/.claudepilot/dev-sessions/STOP` (checked every two minutes) or kill the process by PID. **Start it again** (needs `PORTAL_SERVER_CODE`):
`cd ~/work/claudepilot && PORTAL_SERVER_CODE=... setsid nohup node docs/dev-sessions/supervisor.mjs >> ~/.claudepilot/dev-sessions/supervisor.log 2>&1 < /dev/null &`.
`DRY_RUN=1` reads the portal and says what it would do. It approves nothing unless `DEPLOY_RUN=<run id>` is given, and then only that run.
