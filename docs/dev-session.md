# Development session in the cluster

ClaudePilot is developed from a workspace that runs **inside the isnan k3s cluster**: `kubernetes/kohi-event`, folder
`~/work/claudepilot`, branch `integration`. It has what a session needs to build, test, look at, release and watch the portal by itself.
Read `docs/dev-context.md` first.

## What is connected

| Connection | How | Where the credential lives | Limits |
| --- | --- | --- | --- |
| GitHub (this repository, GitHub Packages) | `gh` is logged in; git over https uses `gh` as its credential helper; `NODE_AUTH_TOKEN` is set from `gh auth token` in `~/.bashrc` and `~/.profile` (the private `@isnanme/ui` package) | `~/.config/gh/hosts.yml` (the owner's token: scopes gist, read:org, read:packages, repo, workflow) | the owner's rights on GitHub |
| GitLab (the isnan-infra repository that Argo CD reads) | git credential store for `https://gitlab.com` | `~/.git-credentials` (the PAT Argo CD uses, `isnan-argocd`) | **read only** (`read_repository`, `read_api`): it clones and reads, it cannot push; to push, replace the line with a token that has `write_repository` |
| k3s (deploy and monitor) | `kubectl` v1.35.5 (`~/.local/bin`, and `/usr/local/bin` in the dev image); `~/.kube/config` talks to `https://kubernetes.default.svc` as the service account `claudepilot-dev-admin` | `~/.kube/config` (a long-lived token) | **cluster-admin**: everything, everywhere |
| The portal's own tools | Portal MCP is on and agent access is on for this workspace: a session started now gets the portal's tools (tickets, knowledge, sessions, CI) | the session's own scoped token (minted per session) | rate limited, labelled, never destructive |

The project's Claude settings (`.claude/settings.json`) allow the read-only and routine commands, ask before anything that changes the cluster or pushes, and deny reading the credential files and dumping Secrets. The slash commands in `.claude/commands/` do the common jobs.

Revoke the cluster access at any time (from anywhere with kubectl):

```sh
kubectl delete clusterrolebinding claudepilot-dev-admin
kubectl -n isnan-claudepilot delete secret claudepilot-dev-admin-token   # the token stops working at once
```

The credentials sit on the workspace's volume, so anyone who can open a shell in this workspace has them. The portal's only protection is its sign-in code: keep it long and random (`deploy/k3s/README.md`).

## Tools, and what is missing

- In the image: node 22, npm, git, gh, curl, jq, ripgrep, tmux, sudo (passwordless), python3. Added to the home folder: `kubectl`.
- **The dev image** (`images/workspace/Dockerfile.dev`: Chromium, fonts, shellcheck, kubectl on top of the workspace image) is what the UI checks need (`tools/qa/*.mjs` start `chromium`). Build it with `scripts/k3s-build.sh workspace-dev <tag>` and put it on this workspace (`kubectl -n isnan-claudepilot-workspaces set image deploy/ws-kohi-event workspace=registry.int.isnan.me/claudepilot/workspace:<tag>`; the pod restarts, the home volume stays).
- **No Docker daemon** in a pod: images are built by kaniko Jobs (`scripts/k3s-build.sh`), and the 23 Docker-only tests skip.
- **No SSH to the nodes** from here: the jump host needs a Cloudflare Access login in a browser. Use `kubectl debug node/<name> -it --image=busybox` (a pod with the node's filesystem under `/host`) for node-level work.
- Resources: this workspace is limited to 4 CPUs and 8 GiB (it reserves only 250m and 1 GiB). Run heavy jobs (typecheck, the suite, a production build) one at a time; `scripts/gate.sh` keeps test concurrency at 2 (`GATE_CONCURRENCY`).

## Everyday commands

```sh
cd ~/work/claudepilot && git pull                 # branch integration
npm run typecheck                                 # all three packages
npm run build -w @portal/web
(cd apps/server && npm test)                      # about 2,400 tests, a few minutes
scripts/gate.sh                                   # the same on a clean copy of HEAD: the release gate
scripts/gate-job.sh <commit> [steps]              # the release gate as a Job in the cluster (other CPUs); the commit must be on GitHub
scripts/scratch-portal.sh start 3403              # a clean-environment portal; tools/qa/*.mjs drive a real browser against it
scripts/k3s-status.sh                             # Argo CD, pods, node load, warnings, the portal log
kubectl -n isnan-claudepilot logs deploy/claudepilot-portal --tail=50
```

## Releasing to the cluster

The deploy pipeline (next section) does these steps for you, with a person's approval before the release; this is the manual way.

1. Work and commit on `integration`; push it. `scripts/gate.sh <commit>` must be green.
2. **Build the images in the cluster** with `scripts/k3s-build.sh portal|workspace|workspace-dev <tag> [commit]` (the nodes are amd64, the registry is `registry.int.isnan.me`, pushing from outside fails). The portal build uses a temporary Secret with the GitHub token, deleted on exit; the script searches the log for the token.
3. Change the image tags in `deploy/k3s/portal.yaml` (the portal image and `PORTAL_K8S_IMAGE`), commit, and push **`main`**: Argo CD follows `main`, so pushing it deploys. Do that only when the owner has said go, or through the deploy pipeline. Then refresh Argo CD (`kubectl -n isnan-argocd annotate application isnan-claudepilot argocd.argoproj.io/refresh=hard --overwrite`) and `kubectl -n isnan-claudepilot rollout status deploy/claudepilot-portal`.
4. Roll back by putting the previous tags back and pushing, or `kubectl -n isnan-claudepilot rollout undo deploy/claudepilot-portal` (Argo CD undoes it again until git agrees).

## Deploying with pilot CI

`.pilot/deploy.yml` is a pipeline of the portal's own CI (docs/prd/local-git-ci.md) that runs **in this workspace**, with its `kubectl` and `gh`.
It is started by hand only: in the portal, or by a session over the Portal MCP (`/deploy`). The commit is the head of the branch the run is on
(default `integration`; a tag works too). Jobs, each a script in `.pilot/scripts/`:

| Job | Does |
| --- | --- |
| gate | `scripts/gate-job.sh` on the commit: the release gate as a Job in the cluster (next section); fails on any red step or failing test (input `gate: false` skips it; `DEPLOY_GATE_IN_CLUSTER=false` in the workspace's `~/.profile` runs `scripts/gate.sh` here instead) |
| build | `scripts/k3s-build.sh` per image of input `images` (`portal`, `workspace`, `workspace-dev`, or `none`) with the next date tag (`2026.10.13-2`, `2.1.296-2026.10.13-1`, `2.1.296-dev-2026.10.13-1`); the commit must be on GitHub's `integration` |
| release | **waits for a person's approval** (environment `production`); then bumps the two tags in `deploy/k3s/portal.yaml` on top of the commit and pushes it to `main` (fast-forward only: that push is the deploy) and then brings `integration` up to date as its own step (a merge of `main` into the current `integration`, never a force; a conflict only warns). Input `deploy: false` leaves it out (build only) (when `integration` moved on while the release waited for its approval, the release is merged into its new tip; `main` still gets exactly the approved commit plus the tags; run #4 of 2026-10-13 was refused before this) |
| verify | Argo CD Synced and Healthy at the pushed commit, rollout status, the new image, `/healthz` and `/login` through the in-cluster service, no fatal line and no restart in the portal's log |
| chats | (T-277 layer 4) the chats the release step recorded as attached to a live process (its log: `chats: N attached ...`, one line per chat with short id, Claude, mode, open control requests, workspace; `.pilot/out/chats.env`) are watched in the new portal's log until 10 minutes after the new pod started (`DEPLOY_CHATS_WINDOW_S`). One that **ended for integrity** fails the run: `ENDED: <id8> ended for integrity at <time>: <why>` and the error line name it (recover it in place: Resume). Survivors are listed with their `cp-session tail` follower count (counted for the chats of this workspace; 1 is right, 2 is the double read behind "a second control response"). Its own job, not part of verify, so it never starts a rollback (a second restart) of a healthy release. Before its push the release step also waits, at most 2 minutes (`DEPLOY_CHATS_WAIT_S`), while an attached chat has a control request the portal asked and Claude Code has not answered. A portal that does not say (one from before this change) leaves the record `unavailable`, and chats passes with a warning |
| rollback | only when release or verify failed: the previous tags on top of `main` (a new commit, never a force), pushed, then Argo CD, rollout and `/healthz` again |

Input `dry_run: true` prints every action and changes nothing (no push, no cluster change; it still reads the cluster and waits for the
approval).

**How the steps learn about chats.** Steps hold no portal credential (local-git-ci PRD FR20), so the portal says it in its own log, which verify
already reads with `kubectl logs`: while a job that deploys to an environment runs, the CI service writes `[deploy-chats] run=<id> job=<job>
attached=<n> pending=<n|?> chats=<id8>:<claude>:<mode>:<tail8>:<open>:<workspace>,...` (again when the open count changes; ids and facts only,
every field cut to `[A-Za-z0-9._/-]`), and the controller writes `[chat] <id>: ended for integrity: <why>` when it ends one. The scripts only
take lines that START with those tags, so a chat's own words echoed in a log line can not forge one. By hand: `kubectl -n isnan-claudepilot logs
deploy/claudepilot-portal | grep -E '^\[(deploy-chats|chat)\]'`. Logs pass the portal's redactor, and the build step masks the GitHub token by value.

**The approval.** The portal holds the release job (`waiting`, a raised hand on the run) until a person presses **Approve** on the run page; **Reject**
ends the run as cancelled. The runner gets the key to start that job only from the portal, when a person approves; every approval and rejection is
in the platform audit (Access). Agents can start the pipeline (`ci_run_trigger`) but no tool approves. Turn the prompt off per environment in
CI → Remotes → claudepilot → production (asked once more: agents could then deploy on their own). What it does NOT stop: a session in this
workspace has cluster-admin `kubectl` and the owner's GitHub token in its shell, so it could deploy without the pipeline at all; the approval
guards the sanctioned path (and every caller that only has MCP or the API), not a shell here.

**One-time setup** (in the portal UI, by the owner):

1. CI → **New remote**: workspace `kubernetes/kohi-event`, name `claudepilot`, folder `/home/node/work/claudepilot`, **Connect** on. The portal
   creates the bare remote `~/.claudepilot/git/claudepilot.git` in this workspace and adds it as the remote `pilot` of the working copy.
2. Access → MCP: Portal MCP on, and under **Agents** switch on `kohi-event`, so this workspace's sessions get the CI tools (`mcp__pilot__ci_*`).
3. Optional: run `deploy` once with `dry_run` on (CI → Remotes → claudepilot → Run on `integration`); the first run creates the environment
   `production`, protected.

**Every deploy:** push `integration` to GitHub and to `pilot` (`git push origin integration && git push pilot integration`), then run `/deploy`
(or Run in the portal), approve when the hand shows, and `git pull` afterwards (the release commit is on `integration`).

## Gates in the cluster

The workspace pod has 4 CPUs shared with the agents, their scratch portals and Chromium; the full gate took 15 to 40 minutes there and hung
twice. `scripts/gate-job.sh <commit> [steps]` (T-37) runs `scripts/gate.sh` as a Job in `isnan-claudepilot` instead, on whichever node has CPU:

- **The Job** (`deploy/k3s-build/gate-job.yaml`): the newest development workspace image (or `GATE_IMAGE`), a shallow clone of the commit from
  GitHub, `GATE_CONCURRENCY=3`; requests 1 CPU and 2 GiB, limits 4 CPUs and 8 GiB, `/tmp` an emptyDir in memory (3 GiB: the clean copy, `node_modules` and the tests' databases; on the overlay the suite was IO-bound, 31+ min), no node selector (k3s-node2's requests are nearly all
  allocated: the master may take it), no service account token, gone an hour after it ends. A name per call
  (`claudepilot-gate-<sha>-<4 hex>`), so gates for different commits run side by side.
- **The token** for `npm ci` (the private `@isnanme` packages) is a Secret named like the Job, made from `gh auth token` on stdin, deleted on
  exit; the log is searched for it and masked if it is there.
- **Steps:** `typecheck,web-build,server-suite` by default; fewer for a heavy check without the suite, e.g. `typecheck,web-build`.
- **The verdict:** the Job ends with one `GATE-VERDICT: green` or `GATE-VERDICT: red: <why>` line from `scripts/gate-verdict.sh` (the same
  reading the local gate uses: every step at rc=0, the last suite summary at 0 failing and 0 timed out). The script prints the summary and
  that line, keeps the whole log in `GATE_JOB_LOG` (default `/tmp/gate-job-<sha>.log`), exits 0 green, 1 red.
- **The commit must be on GitHub** (any branch: a sub-agent's pushed branch, `integration`, or `wip/orchestrator-local-backup` for an
  unpushed merge). The deploy pipeline's gate job uses it by default.

## Heavy agent work in the cluster

`scripts/job-run.sh` (T-107) runs any heavy command of an agent as a Job like the gate's (`deploy/k3s-build/job-run.yaml`: the development
image, a node without a workspace pod preferred, 1 CPU requested and 4 the limit, memory requested = limited (4Gi, `--big` 8Gi), `/tmp` and
`/dev/shm` in memory, a deadline, gone 30 minutes
after it ends), so the pod's flock queue is only for what must run in the pod:

```sh
git push origin HEAD:wip/<name>                                              # the Job clones what is on the remote, nothing local
scripts/job-run.sh -- 'cd apps/server && node --import tsx --test src/ci/jobRun.test.ts'
scripts/job-run.sh --repo konfersi:platform/konfersi-backend --ref <branch> --also platform/konfersi-shared -- 'npx vitest run'   # platform/, not the manifest's stale shared/
scripts/job-run.sh --artifacts test-results --out /tmp/cp-shots -- 'npx playwright test'   # files back, at most 4 MiB compressed
scripts/job-run.sh --list ; scripts/job-run.sh --stop --chat <session id>
```

- **The code:** `--repo` and `--ref` default to the current folder's origin and HEAD (it must be on the remote). ClaudePilot comes from GitHub
  (the npm token for `@isnanme` in the Job's Secret), Konfersi from Gitea (git's credential helper gives the token; in the Job a credential helper
  reads it from the environment, never a URL). The Secret belongs to the Job and is deleted on exit; the streamed log is masked for the token.
- **Caps:** `JOB_RUN_MAX` (3) Jobs at once cluster-wide, `JOB_RUN_MAX_PER_CHAT` (2) per chat (`PILOT_SESSION_ID`) and `JOB_RUN_MAX_PER_PROGRAM`
  (2) per program (claudepilot, event, konfersi; T-524). A Job over a cap is created suspended and waits in creation order ("queued behind K").
  Jobs carry the labels `job-run/chat`, `job-run/role` (`PILOT_AGENT`), `job-run/repo`, `job-run/program`.
- **Memory (T-524):** requested = limited, so the scheduler places a Job only where all of it fits (2Gi requested with 8Gi allowed let a
  4.1 GB Event Job take k3s-master, the 15 GB control-plane node that also runs the API server, to 92%, and the portal answered 503).
  MEMORY_SIZES_LINE
  Every Job ends with `=== JOB-RUN MEMORY peak=… limit=… oom_kills=…` (its own cgroup). An OOMKilled Job says so with its limit and the hint
  `--big`; a Job Pending because no node has the memory free says so once, instead of a silent wait.
- **Placement (T-365, T-524):** preferred, never required (a required rule left every Job Pending): away from the control-plane node, the
  portal's node and workspace pods. The scheduler scales each rule to 0..100 before adding them, so with two nodes the control-plane and the
  portal rules cancel and the node with the most free memory and CPU after the request wins; the honest request is what keeps the master
  safe. The comment in `deploy/k3s-build/job-run.yaml` has the details.
- **Cleanup:** Ctrl-C or a kill deletes the Job; so does the end of the chat (the Claude process, `CLAUDE_PID`, exits); a Job whose script was
  killed outright is removed by the next run on this host.
- **npm cache:** none shared. A cold `npm ci` in a Job is 15 to 20 s (job-run and gate logs); a shared cache would be a node-bound `local-path`
  PVC (the only storage class) for a few seconds.

## Building an image in the cluster

There is no Docker daemon in the workspace pod and there will not be one (D-5: one pod, no daemon, no privileged containers). `scripts/image-build.sh`
(T-141) builds any repository's Dockerfile as a kaniko Job (`deploy/k3s-build/image-build-job.yaml`) and pushes it:

```sh
git push origin HEAD:wip/<name>                                              # the Job clones what is on the remote
scripts/image-build.sh --check --destination registry.int.isnan.me/<path>:<tag>   # 0: the tag exists (skip the build), 3: it does not
scripts/image-build.sh --repo claudepilot --ref wip/<name> --dockerfile deploy/k3s-build/image-build-proof/Dockerfile \
  --context deploy/k3s-build/image-build-proof --destination registry.int.isnan.me/claudepilot/image-build-proof:<short sha>
printf '%s\n' "$CRED_JSON" | scripts/image-build.sh --repo konfersi:<org>/<repo> --ref <branch> --dockerfile Dockerfile \
  --destination <registry>/<path>:<tag> --credential-stdin                 # {"username":"..","password":".."} on ONE line
scripts/image-build.sh --list ; scripts/image-build.sh --stop [--chat <session id>]
```

- **The source:** `--repo claudepilot` or `<org>/<repo>` from GitHub (public only, no credential), `konfersi:<org>/<repo>` from Gitea (the
  token from git's credential helper, as job-run). `--ref` must be on the remote (a branch or tag is looked up there; a commit is the full sha).
  An init container clones it into an emptyDir; kaniko builds `--context` (default the root) with `--dockerfile` for linux/amd64.
- **The destination's credential** only as one JSON line on stdin with `--credential-stdin` (without the flag stdin is not read). It becomes a
  docker config.json in a Secret owned by the Job, deleted on exit, never on a command line; the streamed log is masked for it and the whole log
  searched for it before the script prints `credential in the build log: none`. `registry.int.isnan.me` needs none: it is pushed through the
  in-cluster service (the ingress cuts a request at 60 s).
- **Build args are not secrets:** they are in the Job's spec; letters, digits and `_.,:/@+=-` only.
- **Caps:** one build at a time cluster-wide (`IMAGE_BUILD_MAX`, 1; the rest wait "queued behind K"), a deadline of at most 60 minutes
  (`--timeout`), 1 CPU and 2 GiB requested, 4 and 8 GiB the limit, a node without a workspace pod preferred. Ctrl-C, a kill or the end of the
  chat deletes the Job and its Secret.
- **The result:** exit 0 only when the tag reads back from the registry, and then the last line is `DIGEST=sha256:<hex>`; 1 the build failed,
  2 a usage error, 124 past the deadline. The whole log: `IMAGE_BUILD_LOG` (default `/tmp/image-build-<job>.log`; remove it when done).
- **The door:** the dev account `claudepilot-dev-admin` through this script, as job-run and gate-job; no Role was added or widened.

## When the coordinator cannot reach the portal (the relay)

The supervisor (`docs/dev-sessions/supervisor.mjs`) and the coordinator's helpers (`tools/coordinator/`) run on the coordinator's machine,
outside this pod (D-14: the owner's sign-in code must never be where agents can read it). They call `https://pilot.ai.isnan.me`, a name that
only resolves on the cluster's private network. From outside they get there through two local helpers. `tools/coordinator/up.sh` starts them:
an SSH jump SOCKS tunnel on `127.0.0.1:1080` (`jump-tunnel.sh`, needs a valid Cloudflare Access login) and, for Node, an HTTP proxy shim on
`127.0.0.1:3128` (`socks-http-proxy.mjs`). `ph.sh METHOD PATH [json]` makes one owner call: `POST /api/login` with `PORTAL_SERVER_CODE`, then
the call with the cookie and an `Origin` header. `sess.py` (the chat list) and `reassign.py` (moves tickets off ended chats) read its JSON. On
2026-10-14 (T-259) the name did not resolve from the owner's dev container and the k3s API timed out. For about 3.5 hours nothing nudged,
answered or restarted a chat. The coordinator got through only by running the API calls from the **Coder workstation** (agent-desktop, the
owner's remote Linux computer, reached through the coder-desktop MCP), which sits inside the cluster network.

Until the portal has an external heartbeat, that is the relay:

1. Check the usual path first: `tools/coordinator/up.sh` prints `tunnel 1080 up` / `DOWN`. Use the relay only when it stays down, or the
   name does not resolve from the coordinator's machine.
2. On the workstation, work in a new scratch directory. Make the same calls `ph.sh` makes (log in, then one API call). You may copy in a
   helper script for this, such as `sess.py` or `reassign.py`.
3. **Leave nothing of the owner's there.** What you leave there may be read by agents and jobs, and D-14 says the owner's sign-in code must never be where agents can read it. Do
   not write the sign-in code to a file, a shell history or a lasting environment, and do not leave a cookie jar, a copy of the repository or
   a helper script. Delete the scratch directory when you are done.
4. Write on the ticket what you ran there (calls and chat ids, never the code or a cookie). Use T-259 or the ticket of the outage.

What the relay is not:

- **Not needed for chats with Keep going on.** The portal runs that watchdog itself, inside the cluster: `apps/server/src/keepgoing`, a
  60-second sweep, the kill switch `keepgoing.enabled`, the per-chat policy on `PUT /api/chat/sessions/:id/keep-going` or the Portal MCP tool
  `session_keepgoing_set`. Such a chat is nudged, woken, recovered and continued while the coordinator is cut off. The supervisor leaves that
  track alone.
- **Still the only way** to keep a chat in Bypass and to move one on low quota (D-12, D-39). Keep going reports a chat that lost Bypass and
  never re-enters it, and it does not move chats (T-316). The supervisor does both, and it is cut off with the coordinator. The same goes
  for tracks that do not have Keep going on.
- **Not built:** an external heartbeat that notices the portal itself is down (T-315; only Connect's hub heartbeats exist; the design waiting for the owner's choices is in
  `docs/prd/chat-sessions.md` §23.3), and a relay
  script: the steps above are by hand. T-104's lease will replace the sign-in code the helpers use.

## Rules that hold

- Never print, log or commit a token. No token-shaped literal anywhere in the repository (GitHub push protection): build fixtures at runtime.
- Migrations are append only; never edit a released one.
- UI text is short: titles of one or two words, explanations in an InfoTip, phone width (390 px) first.
- Commits are unsigned on this workspace; end them with the `Co-Authored-By` trailer your Claude adds.
- The owner's other deployment (Docker on the Mac, `pilot.dev.isnan.me`) is not reachable from here.
