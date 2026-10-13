---
description: Release to the cluster by hand: gate, build images in the cluster, bump tags, push main (asks), verify
argument-hint: [commit, default HEAD of integration]
---
Release `$ARGUMENTS` (default: the head of `integration`) to the isnan cluster. Stop and tell the owner at any failure.
1. The commit is pushed to `origin/integration` and `scripts/gate.sh <commit>` is green.
2. Build the images in the cluster with a date-based tag: `scripts/k3s-build.sh portal <tag> <commit>`, then `workspace` / `workspace-dev` only if `images/workspace` changed.
3. In `deploy/k3s/portal.yaml` change the image tag of the portal (and `PORTAL_K8S_IMAGE` if the workspace image changed). Commit on `integration`.
4. **Ask the owner** before pushing `main` (it deploys: Argo CD follows it). Then fast-forward `main` to that commit and push it.
5. Verify: `kubectl -n isnan-argocd annotate application isnan-claudepilot argocd.argoproj.io/refresh=hard --overwrite`, wait until the app is Synced and Healthy on the new revision,
   `kubectl -n isnan-claudepilot rollout status deploy/claudepilot-portal`, then `curl -s http://claudepilot-portal.isnan-claudepilot.svc.cluster.local:3000/healthz` and read the portal log for errors.
6. Roll back by putting the previous tag back and pushing, if verification fails. Record what you did in `docs/open-items.md` when it matters.
Prefer the deploy pipeline (`/deploy`) once `.pilot/deploy.yml` exists: it does these steps with an approval.
