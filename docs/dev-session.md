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
scripts/scratch-portal.sh start 3403              # a clean-environment portal; tools/qa/*.mjs drive a real browser against it
scripts/k3s-status.sh                             # Argo CD, pods, node load, warnings, the portal log
kubectl -n isnan-claudepilot logs deploy/claudepilot-portal --tail=50
```

## Releasing to the cluster

1. Work and commit on `integration`; push it. `scripts/gate.sh <commit>` must be green.
2. **Build the images in the cluster** with `scripts/k3s-build.sh portal|workspace|workspace-dev <tag> [commit]` (the nodes are amd64, the registry is `registry.int.isnan.me`, pushing from outside fails). The portal build uses a temporary Secret with the GitHub token, deleted on exit; the script searches the log for the token.
3. Change the image tags in `deploy/k3s/portal.yaml` (the portal image and `PORTAL_K8S_IMAGE`), commit, and push **`main`**: Argo CD follows `main`, so pushing it deploys. Do that only when the owner has said go, or through the deploy pipeline. Then refresh Argo CD (`kubectl -n isnan-argocd annotate application isnan-claudepilot argocd.argoproj.io/refresh=hard --overwrite`) and `kubectl -n isnan-claudepilot rollout status deploy/claudepilot-portal`.
4. Roll back by putting the previous tags back and pushing, or `kubectl -n isnan-claudepilot rollout undo deploy/claudepilot-portal` (Argo CD undoes it again until git agrees).

## Rules that hold

- Never print, log or commit a token. No token-shaped literal anywhere in the repository (GitHub push protection): build fixtures at runtime.
- Migrations are append only; never edit a released one.
- UI text is short: titles of one or two words, explanations in an InfoTip, phone width (390 px) first.
- Commits are unsigned on this workspace; end them with the `Co-Authored-By` trailer your Claude adds.
- The owner's other deployment (Docker on the Mac, `pilot.dev.isnan.me`) is not reachable from here.
