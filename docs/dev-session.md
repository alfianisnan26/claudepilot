# Development session in the cluster

ClaudePilot is developed from a workspace that runs **inside the isnan k3s cluster**: `kubernetes/kohi-event`, folder
`~/work/claudepilot`, branch `integration`. It has what a session needs to build, test, release and watch the portal by itself.

## What is connected

| Connection | How | Where the credential lives | Limits |
| --- | --- | --- | --- |
| GitHub (this repository, GitHub Packages) | `gh` is logged in; git over https uses `gh` as its credential helper; `NODE_AUTH_TOKEN` is set from `gh auth token` in `~/.bashrc` and `~/.profile` (the private `@isnanme/ui` package) | `~/.config/gh/hosts.yml` (the owner's token: scopes gist, read:org, read:packages, repo, workflow) | the owner's rights on GitHub |
| GitLab (the isnan-infra repository that Argo CD reads) | git credential store for `https://gitlab.com` | `~/.git-credentials` (the PAT Argo CD uses, named `isnan-argocd`) | **read only** (`read_repository`, `read_api`): it can clone and read, not push. To push, replace the line with a token that has `write_repository` |
| k3s (deploy and monitor) | `kubectl` v1.35.5 in `~/.local/bin`; `~/.kube/config` talks to `https://kubernetes.default.svc` as the service account `claudepilot-dev-admin` | `~/.kube/config` (a long-lived token) | **cluster-admin**: everything, everywhere |

Revoke the cluster access at any time (from anywhere with kubectl):

```sh
kubectl delete clusterrolebinding claudepilot-dev-admin
kubectl -n isnan-claudepilot delete secret claudepilot-dev-admin-token   # the token stops working at once
```

The credentials sit on the workspace's volume, so anyone who can open a shell in this workspace has them. The portal's only
protection is its sign-in code: keep it long and random (see `deploy/k3s/README.md`).

## Everyday commands

```sh
cd ~/work/claudepilot
git pull                                   # branch integration
npm run typecheck                          # all three packages
npm run build -w @portal/web
(cd apps/server && npm test)               # about 2,400 tests, a few minutes: one heavy job at a time (2 CPU, 4 GiB)
kubectl get pods -A                        # the cluster
kubectl -n isnan-claudepilot logs deploy/claudepilot-portal --tail=50
kubectl -n isnan-argocd get applications.argoproj.io
```

## Releasing to the cluster

1. Work and commit on `integration`. Keep the typecheck, the web build and the server suite green on a clean copy:
   `git archive HEAD | tar -x -C /tmp/rel && cd /tmp/rel && npm ci && npm run typecheck && npm run build -w @portal/web && (cd apps/server && npm test)`.
2. **Build the images in the cluster** (the nodes are amd64, the registry is `registry.int.isnan.me`, and pushing from outside fails): follow
   `deploy/k3s/README.md` and use the kaniko Jobs in `deploy/k3s-build/`. The GitHub token for the private npm package goes in a temporary Secret
   (`kubectl -n isnan-claudepilot create secret generic claudepilot-build --from-literal=node-auth-token="$(gh auth token)"`), deleted right after the build.
3. Change the two image tags in `deploy/k3s/portal.yaml`, commit, and push **`main`**: Argo CD follows `main`, so pushing it deploys.
   Do that only when the owner has said go. Then
   `kubectl -n isnan-argocd annotate application isnan-claudepilot argocd.argoproj.io/refresh=hard --overwrite` and
   `kubectl -n isnan-claudepilot rollout status deploy/claudepilot-portal`.
4. Roll back by putting the previous tags back and pushing, or `kubectl -n isnan-claudepilot rollout undo deploy/claudepilot-portal` (Argo CD will undo it again until git agrees).

## Rules that hold

- Never print, log or commit a token. No token-shaped literal anywhere in the repository (GitHub push protection): build fixtures at runtime.
- Migrations are append only; never edit a released one.
- UI text is short: titles of one or two words, explanations in an InfoTip, phone width (390 px) first.
- Commits are unsigned on this workspace; end them with the `Co-Authored-By` trailer your Claude adds.
- The owner's other deployment (Docker on the Mac, `pilot.dev.isnan.me`) is not reachable from here.
