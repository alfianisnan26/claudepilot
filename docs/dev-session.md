# Development session in the cluster

ClaudePilot is developed from a workspace that runs **inside the isnan k3s cluster**: `kubernetes/kohi-event`, folder
`~/work/claudepilot`, branch `integration`. It has what a session needs to build, test, look at, release and watch the portal by itself.
Read `docs/dev-context.md` first.

## What is connected

| Connection                                             | How                                                                                                                                                                                     | Where the credential lives                                                                         | Limits                                                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub (this repository, GitHub Packages)              | `gh` is logged in; git over https uses `gh` as its credential helper; `NODE_AUTH_TOKEN` is set from `gh auth token` in `~/.bashrc` and `~/.profile` (the private `@isnanme/ui` package) | `~/.config/gh/hosts.yml` (the owner's token: scopes gist, read:org, read:packages, repo, workflow) | the owner's rights on GitHub                                                                                                                           |
| GitLab (the isnan-infra repository that Argo CD reads) | git credential store for `https://gitlab.com`                                                                                                                                           | `~/.git-credentials` (the PAT Argo CD uses, `isnan-argocd`)                                        | **read only** (`read_repository`, `read_api`): it clones and reads, it cannot push; to push, replace the line with a token that has `write_repository` |
| k3s (deploy and monitor)                               | `kubectl` v1.35.5 (`~/.local/bin`, and `/usr/local/bin` in the dev image); `~/.kube/config` talks to `https://kubernetes.default.svc` as the service account `claudepilot-dev-admin`    | `~/.kube/config` (a long-lived token)                                                              | **cluster-admin**: everything, everywhere                                                                                                              |
| The portal's own tools                                 | Portal MCP is on and agent access is on for this workspace: a session started now gets the portal's tools (tickets, knowledge, sessions, CI)                                            | the session's own scoped token (minted per session)                                                | rate limited, labelled, never destructive                                                                                                              |

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
scripts/worktree-deps.sh <worktree>               # links a worktree's node_modules to this checkout's install (no npm ci); refuses, exit 2, when a package file differs (cluster npm ci needed) or the worktree is outside ~/work/claudepilot.worktrees; --main/--root are test-only (WORKTREE_TEST_MODE=1)
scripts/worktree-new.sh T-<n> <slug>              # branch ticket/T-<n>-<slug> from origin/integration under ~/work/claudepilot.worktrees, deps linked; refuses an existing branch or folder, a bad slug (leading dash, glob characters); no path flags outside tests
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

| Job      | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gate     | `scripts/gate-job.sh` on the commit: the release gate as a Job in the cluster (next section); fails on any red step or failing test (input `gate: false` skips it; `DEPLOY_GATE_IN_CLUSTER=false` in the workspace's `~/.profile` runs `scripts/gate.sh` here instead)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| build    | `scripts/k3s-build.sh` per image of input `images` (`portal`, `workspace`, `workspace-dev`, or `none`) with the next date tag (`2026.10.13-2`, `2.1.296-2026.10.13-1`, `2.1.296-dev-2026.10.13-1`); the commit must be on GitHub's `integration`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| release  | **waits for a person's approval** (environment `production`); then bumps the two tags in `deploy/k3s/portal.yaml` on top of the commit and pushes it to `main` (fast-forward only: that push is the deploy) and then brings `integration` up to date as its own step (a merge of `main` into the current `integration`, never a force; a conflict only warns). Input `deploy: false` leaves it out (build only) (when `integration` moved on while the release waited for its approval, the release is merged into its new tip; `main` still gets exactly the approved commit plus the tags; run #4 of 2026-10-13 was refused before this)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| verify   | Argo CD Synced and Healthy at the pushed commit, rollout status, the new image, `/healthz` and `/login` through the in-cluster service, no fatal line and no restart in the portal's log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| chats    | (T-277 layer 4) the chats the release step recorded as attached to a live process (its log: `chats: N attached ...`, one line per chat with short id, Claude, mode, open control requests, workspace; `.pilot/out/chats.env`) are watched in the new portal's log until 10 minutes after the new pod started (`DEPLOY_CHATS_WINDOW_S`). One that **ended for integrity** fails the run: `ENDED: <id8> ended for integrity at <time>: <why>` and the error line name it (recover it in place: Resume). Survivors are listed with their `cp-session tail` follower count (counted for the chats of this workspace; 1 is right, 2 is the double read behind "a second control response"). Its own job, not part of verify, so it never starts a rollback (a second restart) of a healthy release. Before its push the release step also waits, at most 2 minutes (`DEPLOY_CHATS_WAIT_S`), while an attached chat has a control request the portal asked and Claude Code has not answered. A portal that does not say (one from before this change) leaves the record `unavailable`, and chats passes with a warning |
| rollback | only when release or verify failed: the previous tags on top of `main` (a new commit, never a force), pushed, then Argo CD, rollout and `/healthz` again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Input `dry_run: true` prints every action and changes nothing (no push, no cluster change; it still reads the cluster and waits for the
approval).

**The release proves the new pod can start (T-961).** The portal is `Recreate` on one volume, so the push to `main` stops the old pod before the new one
exists. On 2026-10-17 node2 was full of Jobs, the new pod stayed Pending, then hit ImagePullBackOff, with nothing serving. So `release.sh` runs
`precheck_schedule` (`.pilot/scripts/lib.sh`) BEFORE the push: (1) the new pod's requests (`DEPLOY_PORTAL_CPU_M` 100, `DEPLOY_PORTAL_MEM_MI` 384, a test
holds them equal to `portal.yaml`) must fit on the portal's node with the old pod gone, or fit once pods of the class `claudepilot-jobs` are preempted
(`sched_fit`, `scripts/sched-lib.sh`; other pods never count as room); (2) a short-lived pod `pilot-prepull-*` pinned to that node runs the new portal
image (up to `DEPLOY_PREPULL_S`, 180) and is deleted. Either failing ends the release with `PUSHED=0`, `main` unmoved and the old portal up. Nodes or pods
the pipeline can not read give a warning (the fit is "NOT verified"; the pre-pull still decides). The pipeline's kubectl needs `get` on nodes and pods
(all namespaces) and `create`/`delete` of pods in `isnan-claudepilot`.

**Priority classes.** `deploy/k3s/priorityclasses.yaml` (cluster-scoped): `claudepilot-portal` (1000000, may preempt) on the portal Deployment;
`claudepilot-jobs` (-100, `preemptionPolicy: Never`) on every Job template in `deploy/k3s-build` (job-run, the gate, image builds). On a full node the portal
takes a Job's room instead of staying Pending. If Argo CD may not create cluster-scoped objects, apply the file once by hand before the next sync
(`kubectl apply -f deploy/k3s/priorityclasses.yaml`), or a pod naming a missing class is rejected.

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

**Upstream sync** (optional, local-git-ci PRD FR8a, T-486): a remote can follow its GitHub repository, so a push there reaches `pilot`
without a hand push. The owner sets it on the remote (URL, a read token by Secrets & env name for a private one). For a sync at once on
each push instead of every 30 s: add a Secrets & env _secret_ (a random string) assigned to this workspace, name it as the remote's hook
secret, and in GitHub add a webhook to `https://<portal>/hooks/ci/<remote id>` (content type JSON, that string as the secret, the push
event). A wrong signature gets the same 404 as an unknown remote; a failing sync shows in Needs you. Settings → CI → Upstream hosts limits
the hosts (empty: any public host).

## Gates in the cluster

The workspace pod has 4 CPUs shared with the agents, their scratch portals and Chromium; the full gate took 15 to 40 minutes there and hung
twice. `scripts/gate-job.sh <commit> [steps]` (T-37) runs `scripts/gate.sh` as a Job in `isnan-claudepilot` instead, on whichever node has CPU:

- **The Job** (`deploy/k3s-build/gate-job.yaml`): the newest development workspace image (or `GATE_IMAGE`), a shallow clone of the commit from
  GitHub, `GATE_CONCURRENCY=3`; 1 CPU requested and 4 the limit, 8 GiB of memory requested = limited (T-524; not yet lowered: the gate's
  own peak is unmeasured, the Job prints `memory peak=… limit=…` for that), `/tmp` an emptyDir in memory (3 GiB: the clean copy,
  `node_modules` and the tests' databases; on the overlay the suite was IO-bound, 31+ min), placement as job-run's (preferred: not the
  control-plane node, not the portal's node, no workspace pod), no service account token, gone an hour after it ends. A name per call
  (`claudepilot-gate-<sha>-<4 hex>`), so gates for different commits run side by side.
- **The token** for `npm ci` (the private `@isnanme` packages) is a Secret named like the Job, made from `gh auth token` on stdin, deleted on
  exit; the log is searched for it and masked if it is there. Only the init container `fetch` gets it (T-401): it clones the commit and
  fills npm's cache with `npm ci --ignore-scripts` in a throwaway copy, then checks that the token is in no file under `/tmp`. The `gate`
  container has no token; `gate.sh`'s `npm ci` installs from that cache (`npm_config_prefer_offline`), so no install script, test or build
  can read it.
- **Steps:** `typecheck,web-build,server-suite` by default; fewer for a heavy check without the suite, e.g. `typecheck,web-build`.
- **The verdict:** the Job ends with one `GATE-VERDICT: green` or `GATE-VERDICT: red: <why>` line from `scripts/gate-verdict.sh` (the same
  reading the local gate uses: every step at rc=0, the last suite summary at 0 failing and 0 timed out). The script prints the summary and
  that line, keeps the whole log in `GATE_JOB_LOG` (default `/tmp/gate-job-<sha>.log`), exits 0 green, 1 red. The summary always ends with
  one `memory peak=… limit=… oom_kills=…` line (the Job's own cgroup), or `memory peak=unavailable` when the Job printed none.
- **Pending (T-524):** 8Gi requested fits only k3s-node2, and the gate is not counted in job-run's caps, so it can wait for room. Its pod
  Pending for that says so once, `gate job <name> is Pending: <the scheduler's reason>; it waits for a node with room (a Job that ends frees
memory), up to <GATE_JOB_WAIT_S>s`, and `gate job <name>: scheduled after Ns Pending` when it gets a node. A gate never scheduled in
  `GATE_JOB_WAIT_S` (5400) ends `GATE-VERDICT: red: not scheduled in Ns: <reason>` (exit 1: nothing of the commit was checked); one that
  started and did not end keeps `GATE-VERDICT: red: the job did not finish in Ns`.
- **The commit must be on GitHub** (any branch: a sub-agent's pushed branch, `integration`, or `wip/orchestrator-local-backup` for an
  unpushed merge). The deploy pipeline's gate job uses it by default.

## Heavy agent work in the cluster

In the workspace pod, call it as `/home/node/work/claudepilot/scripts/job-run.sh` (the main checkout's copy): the allow list names only that path (T-631), so a dontAsk lane's relative `scripts/job-run.sh` from its worktree is refused. The examples below use the short form.

A Job the portal preempted (T-961: its class `claudepilot-jobs` is below the portal's) is not a failure of your command: `job-run.sh` prints `preempted,
rerun` with a non-zero rc (1 when the log has none), `gate-job.sh` prints it and `GATE-VERDICT: red: preempted, rerun`; run it again (D-75). And a Job is let
out of the queue only while the portal's node keeps 500m of CPU requests free after the Job's own 500m (`JOB_RUN_PORTAL_CPU_FREE_M`, 0 turns it off), or
while no Job of ours runs (waiting would free nothing); it says `waits: the portal's node has Nm of CPU requests free ...`.

`scripts/job-run.sh` (T-107) runs any heavy command of an agent as a Job like the gate's (`deploy/k3s-build/job-run.yaml`: the development
image, a node without a workspace pod preferred, 1 CPU requested and 4 the limit, memory requested = limited (4Gi, `--big` 8Gi), `/tmp` and
`/dev/shm` in memory, a deadline, gone 30 minutes
after it ends), so the pod's flock queue is only for what must run in the pod:

```sh
git push origin HEAD:wip/<name>                                              # the Job clones what is on the remote, nothing local
scripts/job-run.sh -- 'cd apps/server && node --import tsx --test src/ci/jobRun.test.ts'
scripts/job-run.sh --repo konfersi:platform/konfersi-backend --ref <branch> --also platform/konfersi-shared -- 'npx vitest run'   # platform/, not the manifest's stale shared/
scripts/job-run.sh --artifacts test-results --out /tmp/cp-shots -- 'npx playwright test'   # files back, at most 4 MiB compressed
# Scripts that rewrite the checkout (tools/qa/rtk-history.sh, rtk-classes.sh, rtk-measure.sh, and the mutant runner rtk-guard-mutants.sh; T-736) refuse unless the Job's own env var JR_REPO_URL is set and the tree is clean.
scripts/job-run.sh --list ; scripts/job-run.sh --stop --chat <session id>
# A test stage the workspace image lacks (Python, pytest): build it once, then run the command in it (T-379)
scripts/image-build.sh --repo konfersi:<org>/<repo> --ref <branch> --dockerfile containers/compute/Dockerfile --destination registry.int.isnan.me/konfersi/<name>:<tag>
scripts/job-run.sh --repo konfersi:<org>/<repo> --ref <branch> --image registry.int.isnan.me/konfersi/<name>:<tag> -- 'python -m pytest -q tests/'
```

- **`--image <ref>` (T-379):** the image of the command container only. Allowed: `registry.int.isnan.me/claudepilot/<path>` or
  `registry.int.isnan.me/konfersi/<path>` or `registry.int.isnan.me/event/<path>` (the paths `scripts/image-build.sh` pushes to), pinned by
  `:<tag>` (never `:latest`) or `@sha256:<digest>`; any other
  registry, path or odd character is refused (rc 2) before any kubectl call. The `fetch` container, the only one with the credentials, keeps the
  workspace image, and the checkout reaches the command container on the shared `/tmp`, as without the option. The registry host is the fixed
  `registry.int.isnan.me` (`DEPLOY_REGISTRY` does not change it). The image needs bash and coreutils (base64, tar, stat, date, sed), and no node,
  npm or git: the checkout and its short sha come from `fetch` (the workspace image), so a Debian-based image such as `python:3.11-slim` plus pytest
  runs as is; alpine or distroless images do not work (no bash) (T-379 live proof: `python -m pytest -q` rc 0). The npm steps are skipped with a note (`--steps npm-ci` is refused) and `--against` is refused. Without `--image` nothing changes.

- **The code:** `--repo` and `--ref` default to the current folder's origin and HEAD (it must be on the remote). ClaudePilot comes from GitHub
  (the npm token for `@isnanme` in the Job's Secret), Konfersi from Gitea (git's credential helper gives the token; in the Job a credential helper
  reads it from the environment, never a URL). The Secret belongs to the Job and is deleted on exit; the streamed log is masked for the token.
- **Credentials (T-401):** only the init container `fetch` has them. It clones (`--also` and `--against` too) and runs
  `npm ci --ignore-scripts`; its HOME (git's credential helper, the user `.npmrc`) is a volume the command's container never mounts. Then it
  checks no credential value is in `/tmp` (file names only; `EXIT 3` when one is). The `run` container has no Secret and a fresh HOME: it
  prints the fetch's log, runs `npm rebuild` and the package's own install scripts (`preinstall` to `postprepare`), then your command. So
  your command, the tests and every install script see no token, no helper and no user `.npmrc`. A command that itself needs a credential
  (a push, a private fetch) does not work in a Job: do that in the workspace. `--against` with another lockfile installs offline from the
  cache the fetch filled. The log line `credentials: used for the fetch only` says the check passed.
  - **The npm token reaches npm only through a trusted userconfig** (`--userconfig`, in the fetch HOME, for `npm.pkg.github.com` alone). The
    fetch unsets `NODE_AUTH_TOKEN` and puts the commit's own `.npmrc` aside while `npm ci` runs (it is back for the `run` container), so a `.npmrc`
    of the commit under test (another registry, an auth line with `${NODE_AUTH_TOKEN}`) never sees the token. The `run` and `gate` containers
    set `NODE_AUTH_TOKEN` defined and empty, because ClaudePilot's own `.npmrc` has that auth line and npm refuses an unset variable there.
  - **The check fails closed** and runs after the fetch, over everything in `/tmp` including `fetch.log`: grep exit 0 = found (red), 1 = clean,
    2 or more = the scan failed (red, code 3). On red the tree is deleted and the log holds only the file names, grep's own messages and the
    verdict, never a matched line (the cluster log is raw, so nothing prints a log that matched). It also reads inside `.gz` and `.tgz` files;
    one holding a value is deleted and the Job is red. **Limits:** other encodings are not found: zip, bz2, xz, zstd, base64, URL-encoding,
    JSON escapes, and a compressed file without a `.gz`/`.tgz` name. The token is not printed by npm normally; this is a net, not a mask.
  - **What changed in how the Job runs (scope of T-401, beyond the split):** npm's cache lives on `/tmp` and the fetch container fills it
    (`npm ci --ignore-scripts` in a throwaway copy for the gate, in the checkout for job-run, and for `--against` when its lockfile differs); the
    `run` and `gate` containers install from it (`prefer-offline`) with no credential. A **cache miss** (a package the fetch did not cache)
    therefore makes that `npm ci` fail, and the result is red with a message (`... is red, never skipped`), never green. `job-run.sh` has a
    second clock, `tw`: the start wait counts from when the fetch container stops running, because the clone and the install
    (several minutes) now happen before the `run` container starts and are no longer part of "the Job did not start"; the Job's own deadline still
    ends everything. It also reads an OOMKill of the init container, so a fetch killed at the memory limit says so.
- **Test credentials for the command (`--pool-env NAME`, T-426):** repeatable, for a command that needs a scoped test credential from the
  workspace's Secrets pool, today Konfersi's stg e2e and Lighthouse behind Cloudflare Access:
  `scripts/job-run.sh --pool-env E2E_CF_ACCESS_CLIENT_ID --pool-env E2E_CF_ACCESS_CLIENT_SECRET -- 'scripts/e2e-stg.sh'`. Only
  `E2E_CF_ACCESS_*` names are accepted, and the variable must be set in the workspace; anything else is refused (exit 2) before a Job is made.
  An unknown option now gets a quieter message than before (T-426: it names the argument only when it is a plain `--option`, otherwise it says
  an option is not known and shows nothing of it). The unknown-option branch and the `--pool-env` name check never show what they refuse (it may be a pasted value; an argument is named only
  when it is a plain `--option`), but other options' messages still show their own value (`--ref ... (got X)`): never paste a value into any
  option. A value under 8 characters is refused (the log mask skips those), and so is a command that holds a value: write the variable in single
  quotes (`'$E2E_CF_ACCESS_CLIENT_SECRET'`) so the Job expands it, not your shell. The value goes on stdin into the Job's Secret. The Job is applied
  (suspended) first, then the Secret is created (`kubectl create -f -`, not `apply`, so no last-applied annotation holds the data a second time) in one call that
  already carries the label and the ownerReference to the Job, so there is no moment with an unowned Secret; it goes when the Job goes (its
  TTL, `--stop`, the reap, a person). Not guaranteed: when the script is killed outright (SIGKILL) while its Job is still queued, the Job is
  suspended, so it never finishes: its TTL (`ttlSecondsAfterFinished`) and its `activeDeadlineSeconds` never run. Only the reap removes it,
  and the reap only removes Jobs whose owner is the same host, on the next `job-run.sh` run there. If none runs (the workspace pod was
  replaced), the Job and its Secret stay until a person runs `--stop` or deletes them. A Job that was released and is running does end by its
  deadline and TTL. (Widening the reap to suspended Jobs of any host is a separate ticket.) A value that is not printable ASCII is refused
  (kubectl's env-file parser may print such a line), and kubectl's error text for the Secret is never shown. The `run` container gets it by `secretKeyRef` as `JR_POOL_<name>` and the `fetch` container does
  not; this is the reverse of the git and npm tokens, on purpose. It is never on a command line or in the manifest, and the streamed log is masked
  for it. The run script moves each value out of the environment into a shell array at start, and exports `<name>` only for the command (after
  `npm rebuild` and the lifecycle scripts, T-426 S1f), so the install steps do not inherit it. Limits: (1) the shell's own start-up environment
  (`/proc/1/environ`) still holds the value, so code that reads it still can (only scoped `E2E_CF_ACCESS_*` test credentials may be passed;
  `--steps none` when the dependencies are already installed); (2) the
  raw Job log in the cluster is unmasked until the Job is cleaned up (TTL), only the streamed copy is masked; the mask is a plain text match of
  the value, so it does NOT cover a line shorter than 8 characters inside a multi-line secret, nor an encoded form of a secret (base64, URL or
  JSON escapes, split across lines; review 8157 on T-426); (3) after unpacking `--out`, the
  script scans the files for each value, deletes a file that holds one, names it (never the value) and exits 3 when the command had passed; the
  scan finds plain text only, so with `--pool-env` every compressed file of a known format is deleted the same way, rc 3, never read: by extension (`.zip .gz .tgz .bz2
.xz .zst .br .7z .jar`) or by magic bytes (zip, gzip, bzip2, xz, zstd; a renamed file too), such as a Playwright `trace.zip` or the report's
  `data/*.zip`. The `--out` scan fails closed: when grep itself fails (exit 2 or more) every unpacked file is deleted and the run ends 3. This is
  a different scan from the credential check of T-401: that one runs in the `fetch` container, reads `.gz` and `.tgz` files and covers the tree
  the command gets; the `--out` scan (T-426, in `job-run.sh`) covers the artifacts coming back and deletes compressed files unread. Not seen: other formats (a renamed 7z or lz4, a `.Z`, deflate streams inside a PDF or PNG), and an encoded value, such as base64
  in a HAR or inside the Playwright HTML report's `index.html` (it can embed the report as a base64 zip). Switch the trace off or leave zips and
  the HTML report out of `--artifacts`; `job-out/` is git-ignored (an `--out` elsewhere is not); (4) the script refuses to run under
  `bash -x` / xtrace, which would print the values.
- **Caps:** `JOB_RUN_MAX` (3) Jobs at once cluster-wide, `JOB_RUN_MAX_PER_CHAT` (2) per chat (`PILOT_SESSION_ID`) and `JOB_RUN_MAX_PER_PROGRAM`
  (2) per program (claudepilot, event, konfersi; T-524). A Job over a cap is created suspended and waits in creation order ("queued behind K").
  Jobs carry the labels `job-run/chat`, `job-run/role` (`PILOT_AGENT`), `job-run/repo`, `job-run/program`.
- **Placement (T-611):** the scheduler counts memory requests, but the control-plane node's own pods use far more for real. Before it creates a
  Job, `job-run.sh` reads that node's real memory (`kubectl top nodes`). The test is on the node's use PLUS the Job's expected peak (use x pct /
  used gives allocatable, no new verb): `JOB_RUN_EXPECTED_PEAK_MI` (default 2300 Mi, the measured p99 of Job peaks, 2270 Mi in the T-731 note;
  no run in the 878 logs of 2026-10-16 reached 3000 Mi; at most 6 digits) and 8192 Mi for `--big` (a rerun after an OOM kill, so unknown: its
  whole limit). Over `JOB_RUN_MASTER_MAX_PCT` (85 since 2026-10-17, was 75: T-731; at most 3 digits) the Job gets a REQUIRED rule away from the control plane and waits for
  k3s-node2 or for room ("placement:" line, and a Pending line that says so; a Job that never starts says "run it again"). The decision is made
  when the Job is created and AGAIN just before it leaves the queue (a Job can wait suspended for minutes): if the answer changed, the suspended
  Job's required rule is patched in or out first (a merge patch of that rule alone; scheduling directives of a suspended Job are mutable from
  Kubernetes 1.27, this cluster runs 1.35). A reading that fails then changes nothing and the Job's log says so:
  `=== JOB-RUN PLACEMENT node=control-plane at=release reading=failed kept=<required-away|preferred> pct=<create-time pct> (the create-time reading)`
  (the last placement line then keeps that percentage, never "unknown"); a required rule that cannot be added stops the run (rc 2,
  "run it again"). `JOB_RUN_AVOID_NODES` (T-611 S2, default empty) is a comma list of node names (letters, digits, `.` and `-`, at most 20; anything
  else stops the run, rc 2: a newline, a non-ASCII byte (checked under `LC_ALL=C`), a name over 253 characters, an empty name) that no Job may run
  on: a REQUIRED `kubernetes.io/hostname NotIn` rule, in the same term as the control-plane rule when
  the memory decision adds it, and kept by the release patch. The raw value is never echoed; the Pending line, the log and the last placement
  line (`... queued=Ns avoid=<list>`) carry the validated, joined list. It is off by default on purpose: an always-on required rule left every Job
  Pending when the other node was full (T-365, T-524). With no avoid list, the default manifest is semantically equal to the one before S2 (same rules), not byte-identical,
  when the memory rule is on. A rule that cannot be dropped at the release is kept and the log
  says so (`at=release outcome=drop-failed`): the Job runs on its create-time rule. Known limits: the projected percentage is rounded, and `top` itself is a sample, so the line is good to about 0.5 points; the
  peak counted is the typical 2300 Mi, not the 4 Gi limit, so a rare larger Job can still land on a master that fit the typical one. A master at 74% therefore takes no 4 GiB Job (74% + 4 GiB is about 100%). The line is exact: use plus peak
  AT the line stays, the projection printed is rounded up. An odd bytes column falls back to the percentage alone; under the line, or when the
  metrics fail, only the preferred rules apply. Numbers are read in base 10 (`08` is eight). The decision, the Pending wait, the node it ran on,
  and a Job that never started are also lines in the Job's log (`/tmp/job-run-<job>.log`; the `job-run:` lines go to the caller only):
  `=== JOB-RUN PLACEMENT node=control-plane pct=... projected=... decision=required-away|preferred|preferred-metrics-unavailable [reason=over|headroom]`,
  `... pending=affinity|memory|other ...`, and a last one with the node (`node=none ... outcome=did-not-start` when it never started).
  A Secret that cannot be created ends the run (rc 2) with `kubectl exit N, category: <fixed>` and a `=== JOB-RUN SECRET-FAILED` line; kubectl's
  own text is never shown or logged.
  `gate-job.sh` has its own manifest with preferred rules only (the gate's checks and placement are unchanged here).
- **Reuse (T-731), opt-in with `--reuse`:** without the flag every run is a Job. With it, a Job that passed (same repo, full commit, exact command, steps,
  `--also`/`--against`, `--keep-tests`, `--big`, runner image, on the same `job-run.sh` and YAML) returns its saved masked log and exit 0 at once, with no Job:
  "job-run: reused a passed result … from Job <name>". The store is one workspace home: any session there can write an entry, and a hit prints the
  saved log as it is (the current mask is not applied to it: a planted or stale entry is shown as found; accepted limit). A branch name as `--ref`,
  `--artifacts` and failures are never saved, and a run whose log held a masked value (the leak check) is not saved. `--reuse` together with
  `--pool-env` is refused (rc 2, after the `--pool-env` checks and before any kubectl call): a pass without the credential must never stand for a
  run with it, and nothing made with a credential is saved. A hit makes no kubectl call (no placement, no avoid rule, no Secret, no Job), so the
  reused log shows the node of the run that passed, not a new one: the "last line names the node" statement above is true for a Job, not for a reused run.
  Key and store: `docs/prd/local-git-ci.md` section 24. `gate-job.sh` is not reused (T-578).
- **Memory (T-524):** requested = limited, so the scheduler places a Job only where all of it fits (2Gi requested with 8Gi allowed let a
  4.1 GB Event Job take k3s-master, the 15 GB control-plane node that also runs the API server, to 92%, and the portal answered 503).
  4Gi by default (T-731: 518 peaks, p99 2270Mi, max 2536Mi, would fit 3Gi, but CPU requests bind at 3 Jobs; a lower default waits on a CPU-request measurement) with `/tmp` at most 2Gi; `--big` gives 8Gi with `/tmp` 4Gi (only k3s-node2 has that much free). The whole server suite peaked
  at 1480Mi (claudepilot-job-4c34ebf9, 2026-10-15), a test folder at 1365Mi; the Event Job above reached 4.1 GB and needs `--big`.
  Every Job ends with `=== JOB-RUN MEMORY peak=… limit=… oom_kills=…` (its own cgroup). An OOMKilled Job says so with its limit and the hint
  `--big`; a Job Pending because no node has the memory free says so once, instead of a silent wait. `/tmp` and `/dev/shm` (1Gi) are both
  in memory and count against the same limit: with `/tmp` and `/dev/shm` full, a 4Gi Job has 1Gi left for its processes. A full `/tmp` is a
  full tmpfs, so the command gets `No space left on device` (no eviction); a failed Job with that text in its log gets the `--big` hint too.
- **Placement (T-365, T-524):** preferred, never required (a required rule left every Job Pending): away from the control-plane node, the
  portal's node and workspace pods. The scheduler scales each rule to 0..100 before adding them, so with two nodes the control-plane and the
  portal rules cancel and the node with the most free memory and CPU after the request wins; the honest request is what keeps the master
  safe. The comment in `deploy/k3s-build/job-run.yaml` has the details.
- **Cleanup:** Ctrl-C or a kill deletes the Job; so does the end of the chat (the Claude process, `CLAUDE_PID`, exits); a Job whose script was
  killed outright is removed by the next run on this host.
- **npm cache:** none shared. A cold `npm ci` in a Job is 15 to 20 s (job-run and gate logs); a shared cache would be a node-bound `local-path`
  PVC (the only storage class) for a few seconds.
- **The workspace pod's own memory (T-416, D-61):** the portal refuses a session start or wake in a workspace when anon + active_file
  (cgroup v2 `memory.stat`, not `memory.current`) + 350 MB per session and per running sub-agent + 1.5 GiB headroom is over `memory.max`
  (409 `MEMORY_BUDGET`, audited `memory.refused`; chat PRD FR39b). Past 85% a Needs you item and a push name the largest processes. If an
  agent's spawn or wake is refused for memory: end or sleep a session there, or move the heavy job into the cluster; never raise the limit.

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
