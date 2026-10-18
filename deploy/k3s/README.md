# ClaudePilot on the isnan k3s cluster

The portal runs in the cluster as one pod and its workspaces run as pods too, at https://pilot.ai.isnan.me (internal only:
`*.ai.isnan.me` resolves privately). Argo CD follows this directory (`deploy/argocd/claudepilot.yaml`, project `isnan`).

| File             | What                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `namespace.yaml` | `isnan-claudepilot-workspaces` (where workspaces are created), a memory default for pods in it and a quota                    |
| `rbac.yaml`      | the portal's service account, a Role in the workspaces namespace and the one cluster-wide right it needs (create a namespace) |
| `portal.yaml`    | volume, Deployment, Service and the Traefik IngressRoute                                                                      |

## Before the first sync (by hand, not in git)

```sh
kubectl create namespace isnan-claudepilot
kubectl -n isnan-claudepilot create secret generic claudepilot-server --from-literal=code=<8 letters or digits>
# the key that seals secrets stored in the portal: 32 random bytes, base64url. Keep a copy: without it stored secrets are lost.
kubectl -n isnan-claudepilot create secret generic claudepilot-secret-key \
  --from-literal=portal_secret_key="$(python3 -c 'import os,base64;print(base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("="))')"
kubectl apply -f deploy/argocd/claudepilot.yaml
```

The sign-in code is exactly 8 letters or digits. To change it: apply the Secret again with the new value and restart the portal
(`kubectl -n isnan-claudepilot rollout restart deploy/claudepilot-portal`).

## Images (linux/amd64, built in the cluster)

The nodes are amd64 and the registry is `registry.int.isnan.me` (internal, no auth). Images are built **inside the cluster** with
kaniko (`deploy/k3s-build/`): from outside, the uplink is slow and the registry's ingress cuts a request at 60 s (and the public
path has Cloudflare's 100 MB request cap, "Client Closed Request"), so large layers never arrive. Each Job takes the source from this
repository at a commit and pushes to the registry service address.

```sh
# portal: needs the GitHub Packages token for the private @isnanme/ui package, as a Secret that lives for the build only
kubectl -n isnan-claudepilot create secret generic claudepilot-build --from-literal=node-auth-token="$(gh auth token)"
sed -e 's/#COMMIT/#<full commit sha>/' -e 's/:TAG/:<tag>/' deploy/k3s-build/portal-job.yaml | kubectl apply -f -
kubectl -n isnan-claudepilot logs -f job/claudepilot-build-portal
kubectl -n isnan-claudepilot delete secret claudepilot-build
# workspace
sed -e 's/#COMMIT/#<full commit sha>/' -e 's/:TAG/:<claude-version>-<tag>/' deploy/k3s-build/workspace-job.yaml | kubectl apply -f -
```

The commit must be on `main` of the repository. To update: build, change the two tags in `portal.yaml` (the image and
`PORTAL_K8S_IMAGE`), commit and push; Argo CD rolls the portal.

## What is configured

- State is one 10 Gi `local-path` volume (database, backups, knowledge) on `k3s-node2`; the key that seals stored secrets is the Secret `claudepilot-secret-key`; it is never pruned or deleted by Argo CD.
- Nightly off-site backup (T-565): `backup/portal-backup.yaml`, **not applied yet** (Argo CD does not recurse into `backup/`); see `backup/README.md`.
- Workspaces are Deployments in `isnan-claudepilot-workspaces` made with the portal's service account (`PORTAL_K8S_*`); `PORTAL_K8S_NODE_SELECTOR` keeps them on `k3s-node2`.
- `PORTAL_INTERNAL_URL` is the in-cluster address workspaces use for the Portal MCP tools; Connect is on (`PORTAL_CONNECT_URL`).
- Not enabled: the "This machine" target (`PORTAL_LOCAL_ENABLED`): it would give a shell inside the portal pod, which holds the cluster credentials; and Docker targets (there is no Docker socket in k3s).

## Security notes

- The portal's only protection is the sign-in code; anyone who reaches the address and has it can open shells in workspaces and use the Claude accounts signed in there. The address is private (no public DNS or tunnel route); keep the code long and random on anything that is not a lab.
- The Role is limited to the workspaces namespace; the portal can create namespaces (cluster-wide) and nothing else outside it.
