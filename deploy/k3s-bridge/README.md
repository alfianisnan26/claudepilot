# cp-bridge

The in-cluster half of the Cloudflare move (epic PILOT-1131, decision D4). The portal's core moves to Cloudflare, and the workspaces stay in
k3s. `cp-bridge` is the existing Connect agent in kube mode (`apps/server/src/connect/agent`). It runs as one stateless Deployment that dials
**out** to the cp-next Worker, so it needs no Service and no Ingress. The gap analysis lives in `docs/prd/cf-bridge.md` (PILOT-1140); this
folder is PILOT-1141 (T-3699).

| File | What |
| --- | --- |
| `namespace.yaml` | `isnan-cp-bridge`, PSA `restricted`. Cluster-scoped: the coordinator applies it. |
| `rbac.yaml` | ServiceAccount `cp-bridge`; in each of the four workspace namespaces, `cp-bridge-workspaces` = a copy of the portal's `claudepilot-workspaces`; in the served namespace, `cp-bridge-identity` (the identity Secret by name: get, update; no create). No ClusterRole. |
| `bridge.yaml` | The Deployment: 1 replica, Recreate, uid 65534, read-only root, no escalation, drop ALL, emptyDirs; enrollment token from Secret `cp-bridge-enroll` by name. |
| `extract-agent.mjs` | Takes `agent.mjs` out of the committed `agent.generated.ts` and checks its SHA-256 (used by `deploy/k3s-build/bridge.Dockerfile`). |

The image is `registry.int.isnan.me/cp-bridge:<commit>`, built in the cluster by `scripts/k3s-build.sh bridge <sha> <sha>`
(`deploy/k3s-build/bridge-job.yaml`, kaniko). `apps/server/src/workspaces/bridgeManifests.test.ts` fails when the RBAC here becomes wider
than the portal's, or when the pod loses a guard.

## Limits today

- **Several namespaces, one connection** (PILOT-1162, G1). The bridge serves `PILOT_KUBE_NAMESPACE` (`isnan-pilot-ws-isnan`, its own)
  and `PILOT_KUBE_NAMESPACES` (the other three), which are exactly the namespaces with a `cp-bridge-workspaces` Role.
  - Each `kube` stream names its namespace in the open request, and the agent refuses one it does not serve (`denied`). Because it
    serves several, it also refuses an open that names none (PILOT-1172). Its denied counts are tagged with the namespace.
  - The stream's proxy forwards only that namespace's paths, so a stream for one namespace never reaches another.
  - On the portal, one kube target (a `ConnectKubeRuntime`, its `settings.namespace`) per namespace. Several targets on one enrolled
    node is the follow-up on PILOT-1162 (with G6).
- The identity Secret lives in the served namespace, not in `isnan-cp-bridge`, because the agent stores it in `PILOT_KUBE_NAMESPACE`
  (`agent/client.ts:371-374`). That is the one right beyond the portal's.
- Resize in place, the fit check, the browser pool and app ports go through the bridge only after G2-G5 (see the PRD).

## Applying (coordinator)

1. `namespace.yaml` (cluster-scoped).
2. Build the image, then set its tag and `PILOT_URL` (the cp-next Worker origin) in `bridge.yaml`.
3. Create the Secret `cp-bridge-enroll` (key `token`) in `isnan-cp-bridge` from an enrollment on the cp-next core. Never commit it.
4. Create an empty Opaque Secret `claudepilot-agent-identity` in each served namespace (today `isnan-pilot-ws-isnan`, the
   `PILOT_KUBE_NAMESPACE` of `bridge.yaml`) before the first apply. The bridge may only get and update it by name; it can't create a Secret.
5. `rbac.yaml`, then `bridge.yaml`. After the first connect, delete `cp-bridge-enroll`.

Rehearse in a rig first: render with every `isnan-*` namespace replaced by `dev-rig-<name>`, then `kubectl apply --dry-run=server`
against the rig only. Never dry-run against the live namespaces: a client dry run still reads them.
