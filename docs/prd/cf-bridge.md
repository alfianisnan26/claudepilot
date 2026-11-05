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

| Path the portal uses today                                                 | Code                                                                                            | Through a Connect kube target                                                                                                             | Evidence / gap                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace list (Deployments + pods, managed selector)                      | `kubernetes.ts:336-364`                                                                         | Works                                                                                                                                     | `rules.ts:46,54` (GET lists), selector forced `rules.ts:137-140`                                                                                                                                                                                                        |
| Start / stop (scale 1/0)                                                   | `kubernetes.ts:504-513,646-678`                                                                 | Works                                                                                                                                     | `rules.ts:56` (`deployments/scale` PUT)                                                                                                                                                                                                                                 |
| Create (PVC + Deployment, seed-home init as uid 1000)                      | `kubernetes.ts:391-502`                                                                         | Works                                                                                                                                     | `rules.ts:49,54`; body scan allows it `schema.ts:1-6`; namespace not created (`connect/kube.ts:165`)                                                                                                                                                                    |
| Remove (Deployment + PVC)                                                  | `kubernetes.ts:680-686`                                                                         | Works                                                                                                                                     | `rules.ts:50,55` (DELETE)                                                                                                                                                                                                                                               |
| Re-apply image on start (`reapplyImage`)                                   | `kubernetes.ts:652-677`                                                                         | Not used (option off for enrolled)                                                                                                        | PUT allowed `rules.ts:55`; image allow list `proxy.ts:306`                                                                                                                                                                                                              |
| CPU/memory figures (metrics API)                                           | `kubernetes.ts:688-711`                                                                         | Works                                                                                                                                     | `rules.ts:57`                                                                                                                                                                                                                                                           |
| Resize, stopped workspace (Deployment replace)                             | `kubernetes.ts:551-553`                                                                         | Works                                                                                                                                     | `rules.ts:55`                                                                                                                                                                                                                                                           |
| Resize, running workspace in place (`pods/resize` + ReplicaSet)            | `kubernetes.ts:594-644`                                                                         | **Gap G2**                                                                                                                                | no `pods/resize` nor `replicasets` rule in `rules.ts:44-58`: refused, falls back to a restart (`kubernetes.ts:556-558`)                                                                                                                                                 |
| Fit check before create / resize (nodes, all pods)                         | `kubernetes.ts:433-438,533-544`                                                                 | **Gap G3** (unavailable)                                                                                                                  | off for enrolled `kubernetes.ts:170,534`; needs ClusterRole `claudepilot-portal-fit-check` (`deploy/k3s/rbac.yaml:95-118`)                                                                                                                                              |
| Delivery (pools, secrets, chat host install): `pods/exec` with stdin       | `kubernetesDelivery.ts`, `kubernetes.ts:275-329`                                                | Works                                                                                                                                     | `connect/kube.ts:112-121`; proven through the real agent in `connect/agent/kubeDelivery.e2e.test.ts`                                                                                                                                                                    |
| Start detection for delivery (`startKeys` poll)                            | `kubernetes.ts:258-268`, `connect/kube.ts:119`                                                  | Works                                                                                                                                     | pod list `rules.ts:46`                                                                                                                                                                                                                                                  |
| Chat: cp-session start/send/tail (long-lived exec, stdin)                  | `chat/host.ts:185-215,547-580`                                                                  | Works (G7 proven, PILOT-1160: `connect/agent/kubeExec.e2e.test.ts`, 25 MB stdin and an exec past the idle timeout through the real agent) | exec upgrade has no cap (`proxy.ts:409-426`); uploads go as base64 on stdin, up to `CHAT_MAX_UPLOAD_BYTES` 25 MB (`packages/contracts/src/artifacts.ts:51`); the big-stdin test covers the `host` service only (`workspaces/connect/host.bigstdin.test.ts`), not `kube` |
| Tail survives a tunnel drop                                                | `chat/controller.ts:6764-6775`                                                                  | Works                                                                                                                                     | readers resume from stored byte offsets when the target comes back                                                                                                                                                                                                      |
| Shell / terminals (TTY exec, resize)                                       | `kubernetes.ts:754-801`, `manager.ts:927`                                                       | Works                                                                                                                                     | `connect/kube.ts:208`; resize is channel 4 on the same WebSocket                                                                                                                                                                                                        |
| CI runner (`cp-ci` via exec)                                               | `ci/host.ts:128`                                                                                | Works                                                                                                                                     | generic `workspaces.exec` → `connect/kube.ts:207`                                                                                                                                                                                                                       |
| Workspace git (repos host via exec)                                        | `repos/host.ts:26`                                                                              | Works                                                                                                                                     | same                                                                                                                                                                                                                                                                    |
| App ports (TCP bridge over exec)                                           | `appports/dial.ts:114-129`                                                                      | Works (G5, PILOT-1158)                                                                                                                    | enrolled `kubernetes` gets the bridge (`BRIDGED_ENROLLED`); other enrolled kinds still 501; proven in `connect/agent/kubeExec.e2e.test.ts`                                                                                                                              |
| Browser pool / VNC (browser container, ConfigMap, NetworkPolicy)           | `browser/kube.ts:385-620`, `browser/index.ts:35`                                                | **Gap G4**                                                                                                                                | `browserAccess()` is null for enrolled (`kubernetes.ts:207-210`); exec only into `workspace` (`rules.ts:103,132`); no `configmaps`/`networkpolicies` rule; root init refused (`schema.ts:66-67`)                                                                        |
| Namespace create                                                           | `kubernetes.ts:408-414`                                                                         | Not needed                                                                                                                                | namespaces come from git (`deploy/k3s/workspace-orgs.yaml:1-7`); enrolled runtime never creates one (`connect/kube.ts:165`)                                                                                                                                             |
| Several namespaces (`kubernetes`, `isnan`, `konfersi`, `kohilabs` targets) | `deploy/k3s/portal.yaml:107,119`, `kubeTargets.ts`                                              | **Gap G1**                                                                                                                                | one namespace per agent (`agent/config.ts:113`, `rules.ts:43`)                                                                                                                                                                                                          |
| Keeping workspace ids (`<target>/<name>`) across the move                  | `workspaces/manager.ts:225-226`                                                                 | **Gap G8**                                                                                                                                | `kubernetes` is a reserved Connect target id (`packages/contracts/src/connect.ts:1111,1124`): the workspaces of `isnan-claudepilot-workspaces` can't keep `kubernetes/<name>`                                                                                           |
| The portal's half running in a Cloudflare Worker / DO                      | `connect/hub.ts:9-12`, `tunnel/stream.ts:15`, `connect/kube.ts:7-9,20-75`, `kubernetes.ts:4-15` | **Gap G6**                                                                                                                                | hub is a `ws` `WebSocketServer` on `node:http`; streams are `node:stream` Duplex; the kube client is `@kubernetes/client-node` (incl. `Exec`) over a `node:net` loopback listener: none of these run in workerd                                                         |

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
  passes the proxy), with a test through the agent. Built: `dial.ts` `BRIDGED_ENROLLED`. `connect/agent/kubeExec.e2e.test.ts` runs the real
  bridge through the real agent. Enrolled docker and the other kinds still answer 501.
- **G6 The portal’s half on workerd** (PILOT-1159, T-3717). A spike: the hub's auth + mux in a Durable Object (WebSocket accept, `ws` replaced), a stream
  abstraction without `node:stream`, and a kube HTTP + exec (v4/v5 channel) client that writes straight onto a `kube` stream instead of
  `@kubernetes/client-node` over a loopback port. Output: a design note and a working DO that lists pods through a rig bridge.
  Spike done: see "G6 finding" below; the build is in G6a-G6c (PILOT-1169..1171).
- **G7 Large stdin and long execs through the real kube proxy** (PILOT-1160, T-3718). A test like `host.bigstdin.test.ts` for the `kube` service: a 25 MB
  (CHAT_MAX_UPLOAD_BYTES) base64 stdin and an exec held past the proxy's idle timeout (60 s, `proxy.ts:164`), both through the real agent.
  Test: `connect/agent/kubeExec.e2e.test.ts`. It uses the real agent and the portal's `ConnectKubeRuntime`, with `idleMs` 150 ms
  injected through `serviceDeps.kube`.
- **G8 Target id continuity** (PILOT-1161, T-3719). Workspaces of the built-in `kubernetes` target (namespace `isnan-claudepilot-workspaces`) need either a
  data migration of their ids to a new enrolled id or an allowance for an enrolled target to take a reserved id when the portal has no
  static target of that name (the CF portal has none). Decide on the ticket. Stable workspace ids (`ws_` + 12 hex, targets-connect §24,
  T-42) keep `<target>/<name>` only as an alias, so the ticket first lists which stored references still key on the alias.

## G6 finding: the portal's half in a Durable Object (spike, PILOT-1159)

Proof: `apps/core-worker/test/spike/muxOnWorkerd.test.ts` (helpers in `test/spike/wire.ts`), 4 tests, run in workerd (the vitest pool,
`nodejs_compat`, compatibility date 2026-10-01) inside `BridgeDO` through `runInDurableObject`. Two `MuxSession`s, one per end of a
Cloudflare `WebSocketPair`: the portal end opens `kube` streams; the agent end stands in for the kube proxy (bearer, namespace, answers).

**Runs as is (no change).**

- `tunnel/frame.ts`, `mux.ts`, `stream.ts`, `lines.ts`, `open.ts`, unchanged. `nodejs_compat` gives them `Buffer`, the `node:stream`
  Duplex, `process.nextTick` and timers with `unref` (test 1). `openService`/`acceptService` work; a service the agent doesn't run is
  the typed refusal `service_unavailable`. So no "stream abstraction without `node:stream`" is needed.
- HTTP/1.1 written straight onto a `kube` stream: a pods list with a chunked body, a second request on the same stream (keep-alive),
  the bearer refused (401) and another namespace refused (403) (test 2). About 100 lines (`wire.ts`): no client-node, no loopback.
- Exec rides the same stream (test 3): the `v5.channel.k8s.io` upgrade (101, `Sec-WebSocket-Accept` checked), then RFC 6455 frames,
  masked from the portal, whose first byte is the channel (0 stdin, 1 stdout, 2 stderr, 3 status, 4 resize; v5 adds 255 = close a
  channel, so stdin can end without closing). v4 is the same without 255. The agent pipes the upgrade raw (`proxy.ts:409-426`): no
  change on the agent.
- Limits: the mux sends one frame per WebSocket message, at most 64 KiB + the 12-byte header (test 4: 2 MiB in at least 32 messages,
  with window updates), far under the agent's `ws` maxPayload (1 MiB) and Cloudflare's message limit (32 MiB in Cloudflare's docs; not
  measured). Both ends ping every 15 s, so the link never idles.

**Needs a port.**

1. Socket: the hub is already `BridgeDO` for the handshake (PILOT-1144). After the welcome the DO feeds a `MuxSession` from
   `webSocketMessage`/`webSocketClose` (the Hibernation API calls those, not `addEventListener` as the spike's `cfMuxSocket` does).
2. Hibernation: the mux's streams, ids and windows live in memory and are lost when the object is evicted, and its 15 s `setInterval`
   is a pending event, which in Cloudflare's docs keeps an object from hibernating (not measured). Drive the mux timer from the alarm;
   with no stream open keep the ids in the socket attachment so a woken object rebuilds the session; one woken with streams lost closes
   1011 and the agent reconnects.
3. Backpressure: a Cloudflare WebSocket has no `bufferedAmount` and `send` has no completion, so the mux's high/low water marks never
   hold the sender back. What waits toward the agent is bounded only by the stream windows: 256 KiB x 256 streams = 64 MiB against a
   128 MB isolate. Cap the portal's streams per link lower, or count bytes in the adapter.
4. Kube client: `KubernetesRuntime` uses `@kubernetes/client-node` (AppsV1Api, CoreV1Api, CustomObjectsApi, Exec: about a dozen REST
   calls, `kubernetes.ts:4-15`) over the loopback listener (`connect/kube.ts:20-75`). Replace it with a REST + exec client on `kube`
   streams (the spike's `wire.ts`, grown: bodies, Status errors, watch). A stream can't leave the DO, so the client runs in `BridgeDO`,
   other objects call it by RPC, and an interactive exec (terminal, chat tail) is relayed by `BridgeDO` to the caller's WebSocket.
5. Types: the tunnel modules need `@types/node`; the Worker's tsconfig has only workers-types, so the spike's two files are kept out
   of the Worker typecheck (`apps/core-worker/tsconfig.json`).

**Recommendation.** Keep the mux and stream code; share it as a package typechecked with node types (G6a, PILOT-1169). Port only
the edges: the DO socket adapter with alarm-driven liveness, a bound on queued bytes, and the real-agent proof (G6b, PILOT-1170); a
Worker kube client on streams in place of client-node (G6c, PILOT-1171). Do not port `hub.ts` or the `ws` server: `BridgeDO` is the hub.

**G6b built (PILOT-1170).** `BridgeDO` (`apps/core-worker/src/do/bridge.ts`) runs a server `MuxSession` on the live `/bridge` link:

- Hibernation: `webSocketMessage`/`webSocketClose`/`webSocketError` feed a push socket (`src/bridge/link.ts`). The session's stream
  ids and its open-stream count live in the socket attachment. A session lost to hibernation is rebuilt from the ids (`MuxOptions.resume`);
  if streams were open, they are gone, so the link closes 1011 (audit `bridge.lost`) and the agent redials.
- Liveness: the mux's ping is driven by the alarm (`MuxOptions.timer`), not a timer that would keep the object awake; the dead check stays
  the alarm's own, from the attachment's `lastReceived`.
- Queued bytes: a Cloudflare WebSocket has no `bufferedAmount` and no send completion, so the mux's water marks cannot hold back. The
  bound is the per-stream window times the stream cap: 32 streams per link × 256 KiB = 8 MiB (`BRIDGE_LINK`); a response body read into
  memory is capped at 4 MiB.
- `kube` RPC: `BridgeDO.kube({path, namespace?, bearer})` does one GET over a `kube` stream (HTTP/1.1, `src/bridge/http1.ts`, 30 s).
  The bearer is passed by the caller for now; the per-link bearer the agent should expect arrives with the control stream (next slice).
  A stream the agent opens toward the Worker is refused (RST) until then.
- Proof: `apps/server/src/connect/tunnel/bridgeWorker.test.ts` (`CLAUDEPILOT_WORKER_TESTS=1`) lists pods through `/bridge` with the
  real `dialTunnel` agent and the real `KubeProxy` in front of a fake API server, and checks the proxy's walls (403, 401, `denied`).

**G6c slice 1 built (PILOT-1171).** The REST client the Cloudflare portal needs, in `BridgeDO` by RPC; requests are built and answers
read in `apps/core-worker/src/bridge/kubeApi.ts` (no I/O), one `kube` stream per call:

- `kubeList({namespace, bearer, kind: pods|deployments|claims, workspace?})` and `kubeMetrics({..., workspace?})`: GET with the managed
  selector (`claudepilot.managed=true`, plus `claudepilot.workspace=<label>` when given). The answer is `{ok, items}`.
- `kubeCreate({..., kind: deployment|claim, object})`: the name must be a workspace's (`ws-*`, a claim `ws-*-home`), the object labelled
  managed, in no other namespace; apiVersion, kind and namespace are set by the Worker; at most 1 MiB. The answer is `{ok, object}`.
- `kubeScale({..., name, replicas: 0|1})`: PUT of an `autoscaling/v1` Scale; `{ok, replicas}`.
- `kubeDelete({..., kind, name})`: a Deployment in the foreground; a missing object is `{ok: true, deleted: false}`.
- A non-2xx answer is `{ok: false, code: 'kube_status', status, reason, message}` from the Status (409 `AlreadyExists`, the proxy's 403).
- The first wall is now the Worker's (review of PILOT-1170): `kube()` and every call refuse a path with a `.` or `..` segment, any `%`
  (so `%2e%2e`, `%2f`), a query string or fragment, `//` or anything but plain segments, before a stream is opened. The agent's proxy
  and its schema scan stay the second wall, RBAC the third.
- Proof: `apps/core-worker/test/kubeApi.test.ts`, `test/bridge.test.ts` (the RPCs over a live link with a stand-in API server; refused
  calls never reach the agent), and `bridgeWorker.test.ts` (a workspace's claim and Deployment created, listed, scaled, measured and
  deleted through the real agent and `KubeProxy`; a `hostNetwork` Deployment refused by the proxy's scan).

**G6c slice 2 built (PILOT-1171): exec.** Worker code asks the cluster's `BridgeDO` with `bridgeExecRequest({namespace, bearer, pod,
command, tty?, stdin?, stdout?, stderr?})` (`apps/core-worker/src/bridge/kubeExec.ts`) on its stub. The path (`/__exec`) is reachable from
Worker code only: the public `/bridge` route always forwards `/bridge` with fresh headers.

- Checked before a stream opens: the pod is a workspace's (`ws-*`), the container is always `workspace`, 1..1000 arguments without NUL,
  a request target of at most 8 KiB (large input goes on stdin), stream flags boolean, `tty` with `stderr` refused. At most 16 execs per
  link at once (the link has 32 streams).
- The upgrade offers `v5.channel.k8s.io` then `v4.channel.k8s.io` and checks `Sec-WebSocket-Accept`. A refusal (the proxy's or the API
  server's) is JSON, not an upgrade: 400 `bad_request`, 429 `busy`, 503 `agent_offline`, 502 `kube_status` with the Status reason or
  `bad_response`.
- The answer is a 101 with a WebSocket and `x-cp-exec-protocol`. Each message is one channel message. In: 0 stdin, 4 resize (checked
  and rewritten as `{"Width":w,"Height":h}`), `[255, 0]` closes stdin (v5 only; dropped on v4). Out: 1 stdout, 2 stderr, 3 the exit
  Status. A text message, an output channel or a bad resize from the caller closes it (1003/1008); the pod's close closes the caller with
  its code. Messages are at most 1 MiB, and stdin is cut off (1009) past 1 MiB waiting for the stream's window.
- The caller's socket is accepted, not hibernatable: the object stays awake while an exec runs, so its stream is not lost. The audit row
  `bridge.exec` names the pod, the argument count and the protocol, never the command or the bearer.
- Proof: `test/kubeExec.test.ts` (the check, the codec, the relay), `test/bridge.test.ts` (v5 and the v4 fallback over a live link with a
  stand-in API server; refusals never reach the agent), and `bridgeWorker.test.ts` (an exec through the real agent and `KubeProxy` to
  the fake API server, which speaks v4 only: stdin, a resize and a non-zero exit status).

## RBAC the bridge needs, and nothing wider

- In each workspace namespace (`isnan-claudepilot-workspaces`, `isnan-pilot-ws-isnan`, `isnan-pilot-ws-konfersi`, `isnan-pilot-ws-kohilabs`):
  exactly the rules the portal's SA has there today, the Role `claudepilot-workspaces` (`deploy/k3s/rbac.yaml:11-52`, the same rules in
  `deploy/k3s/workspace-orgs.yaml`), bound to the bridge's SA. The proxy's allowlist is stricter than that Role (first wall); RBAC is
  the second. Not in it: `secrets` (the generic Connect manifest grants secrets in the workspace namespace, `connect/install/testdata/manifest-kubernetes.yaml:41-42`; the portal has no such right today, so the bridge does not get it).
- In the namespace the bridge serves (`PILOT_KUBE_NAMESPACE`), NOT its own: the agent keeps its identity Secret there
  (`agent/client.ts:371-374`, `agent/identity.kube.ts:26`), so `secrets` get/update on `claudepilot-agent-identity` by `resourceNames`
  only. No `create` (it can't be limited by name): the coordinator creates the empty Secret before the first apply, and the agent's
  first write is an update (T-3699 review). This is the one right beyond the portal's. The enrollment-token Secret is
  read by the kubelet for the pod's env and needs no Role. Built in `deploy/k3s-bridge/rbac.yaml` (T-3699).
- Not needed: `deploy/k3s/workspace-jobs-rbac.yaml` (the workspaces' own Job accounts for job-run and gate-job; the portal never uses them),
  the namespace-create ClusterRole (`rbac.yaml:68-89`; namespaces come from git).
- Cluster-scoped and optional: `claudepilot-portal-fit-check` (G3) only if the fit check moves to the bridge; that binding is the
  coordinator's.

## Not verified

- Nothing here was run against a cluster: the "Works" rows rest on the code paths and the existing unit and e2e tests named, not on a rig.
  The bridge rehearsal in `dev-rig-cp-bridge` (T-3699) is where they are first exercised together.
- G6 ran in workerd's local test runtime, inside one DO, with both mux ends in the same object and a stand-in for the agent's
  `KubeProxy`: not on the Cloudflare edge, not over a real `/bridge` link with the real agent, not across hibernation, and not against
  Cloudflare's own message-size limit or idle close (the 32 MiB figure is from Cloudflare's docs).
- G6b ran in local workerd (wrangler `unstable_startWorker`) with the real agent client: hibernation itself is simulated in the tests
  (the in-memory session dropped), not observed on the Cloudflare edge.
- G6c slice 1 ran against the fake API server only. The agent's proxy does not forward `labelSelector` on the metrics path (not in its
  listed routes), so a metrics list is the namespace's pods' metrics, not only the managed ones; the Worker sends the selector anyway.
- G6c slice 2 (exec): v5 was exercised only against the stand-in in workerd; the real agent path ran against the fake API server, which
  speaks v4 only. No route reaches the exec yet: a caller (terminal, chat tail) is a later slice.
