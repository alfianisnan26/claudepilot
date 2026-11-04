# cp-bridge: the Connect kube agent as the in-cluster bridge (gap analysis)

Epic PILOT-1131 (T-3680), phase 1, decision D4: the core moves to Cloudflare, the workspaces stay in k3s, and a stateless in-cluster
`cp-bridge` dials out to the Worker over the Connect protocol. The bridge is the existing Connect agent in kube mode
(`apps/server/src/connect/agent/*`, `services/kube/*`), run as a Deployment. This page says, for every way the portal reaches a workspace
today, whether that path already works through a Connect kube target, with file:line evidence, and what is missing. Written 2026-11-04
from `cf/integration` 6150655e5 (T-3698). Every gap is a ticket on the epic (the list at the end).

## How a kube target over Connect works today

- Portal side: `ConnectKubeRuntime` (`apps/server/src/workspaces/connect/kube.ts:77`) wraps the same `KubernetesRuntime` the in-cluster
  portal uses (`workspaces/kubernetes.ts:148`), pointed at a loopback HTTP listener on `127.0.0.1:0` (`connect/kube.ts:20-63`) whose every
  connection is a `kube` stream on the tunnel, with a per-connection bearer (`connect/hub.ts:405`, sent to the agent in `config`, `hub.ts:521-525`).
- Agent side: `KubeProxy` (`connect/agent/services/kube/proxy.ts:56`) checks that bearer, drops it, matches method and path against the
  allowlist (`rules.ts:42-70`), rebuilds the query (`rules.ts:114-152`), scans write bodies (`schema.ts:95`), and forwards with the
  service account's token. Plain bodies are capped at 1 MiB (`proxy.ts:275-276`); a `pods/exec` WebSocket upgrade is piped raw both ways
  with no size cap (`proxy.ts:409-426`), and a connection with a request in flight is never closed for idleness (`proxy.ts:159-178`).
- The agent serves exactly ONE namespace: `PILOT_KUBE_NAMESPACE` or the file's `namespace` (`agent/config.ts:113`), checked once
  (`services/kube/index.ts:45`) and baked into every path rule (`rules.ts:43`).

## Inventory

| Path the portal uses today | Code | Through a Connect kube target | Evidence / gap |
| --- | --- | --- | --- |
| Workspace list (Deployments + pods, managed selector) | `kubernetes.ts:336-364` | Works | `rules.ts:46,54` (GET lists), selector forced `rules.ts:137-140` |
| Start / stop (scale 1/0) | `kubernetes.ts:504-513,646-678` | Works | `rules.ts:56` (`deployments/scale` PUT) |
| Create (PVC + Deployment, seed-home init as uid 1000) | `kubernetes.ts:391-502` | Works | `rules.ts:49,54`; body scan allows it `schema.ts:1-6`; namespace not created (`connect/kube.ts:165`) |
| Remove (Deployment + PVC) | `kubernetes.ts:680-686` | Works | `rules.ts:50,55` (DELETE) |
| Re-apply image on start (`reapplyImage`) | `kubernetes.ts:652-677` | Not used (option off for enrolled) | PUT allowed `rules.ts:55`; image allow list `proxy.ts:306` |
| CPU/memory figures (metrics API) | `kubernetes.ts:688-711` | Works | `rules.ts:57` |
| Resize, stopped workspace (Deployment replace) | `kubernetes.ts:551-553` | Works | `rules.ts:55` |
| Resize, running workspace in place (`pods/resize` + ReplicaSet) | `kubernetes.ts:594-644` | **Gap G2** | no `pods/resize` nor `replicasets` rule in `rules.ts:44-58`: refused, falls back to a restart (`kubernetes.ts:556-558`) |
| Fit check before create / resize (nodes, all pods) | `kubernetes.ts:433-438,533-544` | **Gap G3** (unavailable) | off for enrolled `kubernetes.ts:170,534`; needs ClusterRole `claudepilot-portal-fit-check` (`deploy/k3s/rbac.yaml:95-118`) |
| Delivery (pools, secrets, chat host install): `pods/exec` with stdin | `kubernetesDelivery.ts`, `kubernetes.ts:275-329` | Works | `connect/kube.ts:112-121`; proven through the real agent in `connect/agent/kubeDelivery.e2e.test.ts` |
| Start detection for delivery (`startKeys` poll) | `kubernetes.ts:258-268`, `connect/kube.ts:119` | Works | pod list `rules.ts:46` |
| Chat: cp-session start/send/tail (long-lived exec, stdin) | `chat/host.ts:185-215,547-580` | Works by the code; **Gap G7** (not proven at the upload cap) | exec upgrade has no cap (`proxy.ts:409-426`); uploads go as base64 on stdin, up to `CHAT_MAX_UPLOAD_BYTES` 25 MB (`packages/contracts/src/artifacts.ts:51`); the big-stdin test covers the `host` service only (`workspaces/connect/host.bigstdin.test.ts`), not `kube` |
| Tail survives a tunnel drop | `chat/controller.ts:6764-6775` | Works | readers resume from stored byte offsets when the target comes back |
| Shell / terminals (TTY exec, resize) | `kubernetes.ts:754-801`, `manager.ts:927` | Works | `connect/kube.ts:208`; resize is channel 4 on the same WebSocket |
| CI runner (`cp-ci` via exec) | `ci/host.ts:128` | Works | generic `workspaces.exec` → `connect/kube.ts:207` |
| Workspace git (repos host via exec) | `repos/host.ts:26` | Works | same |
| App ports (TCP bridge over exec) | `appports/dial.ts:114-129` | **Gap G5** | refused for every enrolled target (`dial.ts:127`, 501), though the exec it needs passes |
| Browser pool / VNC (browser container, ConfigMap, NetworkPolicy) | `browser/kube.ts:385-620`, `browser/index.ts:35` | **Gap G4** | `browserAccess()` is null for enrolled (`kubernetes.ts:207-210`); exec only into `workspace` (`rules.ts:103,132`); no `configmaps`/`networkpolicies` rule; root init refused (`schema.ts:66-67`) |
| Namespace create | `kubernetes.ts:408-414` | Not needed | namespaces come from git (`deploy/k3s/workspace-orgs.yaml:1-7`); enrolled runtime never creates one (`connect/kube.ts:165`) |
| Several namespaces (`kubernetes`, `isnan`, `konfersi` targets) | `deploy/k3s/portal.yaml:107,119`, `kubeTargets.ts` | **Gap G1** | one namespace per agent (`agent/config.ts:113`, `rules.ts:43`) |
| Keeping workspace ids (`<target>/<name>`) across the move | `workspaces/manager.ts:225-226` | **Gap G8** | `kubernetes` is a reserved Connect target id (`packages/contracts/src/connect.ts:1111,1124`): the workspaces of `isnan-claudepilot-workspaces` can't keep `kubernetes/<name>` |
| The portal's half running in a Cloudflare Worker / DO | `connect/hub.ts:9-12`, `tunnel/stream.ts:15`, `connect/kube.ts:7-9,20-75`, `kubernetes.ts:4-15` | **Gap G6** | hub is a `ws` `WebSocketServer` on `node:http`; streams are `node:stream` Duplex; the kube client is `@kubernetes/client-node` (incl. `Exec`) over a `node:net` loopback listener: none of these run in workerd |

## Gaps (one ticket each, phase-1, 1-4 h)

- **G1 Several namespaces in one bridge** (PILOT-1162, T-3720). The agent takes `PILOT_KUBE_NAMESPACES` (a list); each namespace is its own kube target on the
  one connection (the stream open names the namespace, the proxy picks that namespace's rule table). Alternative rejected for now: one
  bridge Deployment and one enrollment per namespace (three identities and three tunnels for one cluster; D4 says one stateless bridge).
- **G2 In-place resize through the proxy** (PILOT-1163, T-3721). Add `pods/{name}/resize` (GET, PATCH; JSON patch of `/spec/containers/N/resources` only) and
  `replicasets/{name}` (GET, PUT; name `ws-*`, body scanned like a Deployment) to `rules.ts`/`schema.ts`, with tests.
- **G3 Fit check on the bridge** (PILOT-1157, T-3715). Either a read-only summarised `nodes` + pod-requests answer from the agent (needs the existing ClusterRole
  `claudepilot-portal-fit-check` bound to the bridge's SA: FOR THE COORDINATOR) or keep "unavailable" (create unchecked, resize refused as
  unchecked, `kubernetes.ts:534`). Default: keep unavailable in phase 1, decide on the ticket.
- **G4 Browser pool over the bridge** (PILOT-1164, T-3722). Allow exec into the `browser` container, `configmaps` and `networkpolicies` named `ws-*-browser`,
  and the browser container's root init (setuid/setgid only) under a narrow schema rule; then `browserAccess()` for enrolled targets.
  Probably splits in two (agent rules; portal side) once started.
- **G5 App ports on enrolled kube targets** (PILOT-1158, T-3716). Lift the `enrolled` refusal in `appports/dial.ts:127` for kind `kubernetes` (the exec path
  passes the proxy), with a test through the agent.
- **G6 The portal’s half on workerd** (PILOT-1159, T-3717). A spike: the hub's auth + mux in a Durable Object (WebSocket accept, `ws` replaced), a stream
  abstraction without `node:stream`, and a kube HTTP + exec (v4/v5 channel) client that writes straight onto a `kube` stream instead of
  `@kubernetes/client-node` over a loopback port. Output: a design note and a working DO that lists pods through a rig bridge.
- **G7 Large stdin and long execs through the real kube proxy** (PILOT-1160, T-3718). A test like `host.bigstdin.test.ts` for the `kube` service: a 25 MB
  (CHAT_MAX_UPLOAD_BYTES) base64 stdin and an exec held past the proxy's idle timeout (60 s, `proxy.ts:164`), both through the real agent.
- **G8 Target id continuity** (PILOT-1161, T-3719). Workspaces of the built-in `kubernetes` target (namespace `isnan-claudepilot-workspaces`) need either a
  data migration of their ids to a new enrolled id or an allowance for an enrolled target to take a reserved id when the portal has no
  static target of that name (the CF portal has none). Decide on the ticket. Stable workspace ids (`ws_` + 12 hex, targets-connect §24,
  T-42) keep `<target>/<name>` only as an alias, so the ticket first lists which stored references still key on the alias.

## RBAC the bridge needs, and nothing wider

- In each workspace namespace (`isnan-claudepilot-workspaces`, `isnan-pilot-ws-isnan`, `isnan-pilot-ws-konfersi`): exactly the rules the
  portal's SA has there today, the Role `claudepilot-workspaces` (`deploy/k3s/rbac.yaml:11-52`, the same rules in
  `deploy/k3s/workspace-orgs.yaml:51-93`), bound to the bridge's SA. The proxy's allowlist is stricter than that Role (first wall); RBAC is
  the second. Not in it: `secrets` (the generic Connect manifest grants secrets in the workspace namespace, `connect/install/testdata/manifest-kubernetes.yaml:41-42`; the portal has no such right today, so the bridge does not get it).
- In the bridge's own namespace: `secrets` get/update on the identity Secret `claudepilot-agent-identity` (`agent/identity.kube.ts:17-26`)
  by `resourceNames`, plus `create` on secrets (create can't be limited by name), and get on the enrollment-token Secret by name.
- Not needed: `deploy/k3s/workspace-jobs-rbac.yaml` (the workspaces' own Job accounts for job-run and gate-job; the portal never uses them),
  the namespace-create ClusterRole (`rbac.yaml:68-89`; namespaces come from git).
- Cluster-scoped and optional: `claudepilot-portal-fit-check` (G3) only if the fit check moves to the bridge; that binding is the
  coordinator's.

## Not verified

- Nothing here was run against a cluster: the "Works" rows rest on the code paths and the existing unit and e2e tests named, not on a rig.
  The bridge rehearsal in `dev-rig-cp-bridge` (T-3699) is where they are first exercised together.
- Cloudflare's WebSocket limits (message size, idle close) against the mux (`CONNECT_LIMITS.wsMaxPayload` 1 MiB, pings every 15 s,
  `packages/contracts/src/connect.ts:126-160`) are part of G6.
