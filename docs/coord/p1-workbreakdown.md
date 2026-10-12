# Connect: work breakdown (P1, 2026-10-12)

COORD = /tmp/claude-1000/-workspaces-claudepilot/cad07383-74ea-4f0a-88e5-fc51c5b7a125/scratchpad/coord
Read first: docs/prd/targets-connect.md (the PRD: every FR, §9 the protocol, §11 the agent, §12 the server seams, §13 the installers, §19 the tests, appendices A to E) and packages/contracts/src/connect.ts (the contract: types, `CONNECT_API`, `CONNECT_PUBLIC`, the protocol, limits, test vectors). Then PLAN.md sections 4 to 7 and PLAN-2.md section A (rules), PLAN-3.md (the owner's ask). The PRD is the spec; this file says who builds what, in which order, and how it is proven.

## 0. Rules for every package

1. PLAN.md section 4 and PLAN-2.md section A all apply: git is READ-ONLY; the owner's dev portal (:3000, `.data`, `.env`, `deploy/.env`, `~/.claude*`, `~/.gnupg`, `~/.host-secrets`) is off limits; no real credentials, no sign-in, no real third-party accounts; `references/` is not yours; shared files are edited surgically after re-reading them; never reformat. UI TEXT DIET (PLAN.md rule 12) applies to anything with a screen.
2. **KUBERNETES SAFETY RULE (the coordinator's, verbatim; it is also in PRD §19.2).** Scratch portals must run `unset KUBECONFIG KUBERNETES_SERVICE_HOST` and `PORTAL_K8S_ENABLED=false` explicitly (KUBECONFIG is already set in this sandbox's environment and is what enables the Kubernetes target; `kubectl`'s default context here is the owner's real cluster, `home-isnan-cluster`). A throwaway kubeconfig is for a throwaway local test cluster only; pass `--kubeconfig <file>` on every `kubectl` call; never create or remove a Kubernetes workspace from a scratch portal. The owner's own dev portal intentionally uses the real cluster; scratch portals never do. The tests need no cluster (an in-process fake API server). **COORDINATOR'S DECISION on the heavy tests (2026-10-12): no agent runs a real-cluster or a swarm test.** Not the tunnel against a throwaway k3s, not a nested privileged `docker:dind` swarm. The proof is the in-process fake Kubernetes API server, the `kubectl` and `docker service` stubs and `kubeconform`; real clusters, swarm, macOS and Windows are the owner's manual checklist (PRD appendix D). T6 may WRITE the two tests if it finds that cheap, as opt-in tests that are skipped unless `CLAUDEPILOT_K8S_TESTS=1` or `CLAUDEPILOT_SWARM_TESTS=1`, each with its own throwaway kubeconfig or daemon and never the default context, one at a time; nobody runs them without the coordinator's explicit go. Never read `~/.host-secrets` or print `$KUBECONFIG`'s content.
3. Docker is ONE shared daemon (the dev container's DinD; never `--context host`). Put your prefix in the NAME of everything you create (containers, volumes, images, networks, tmux sessions, /tmp files): `cx<N>-`. Docker's `--filter name=cx<N>-` matches substrings, so it also finds `claudepilot-agent-cx<N>-…` and `claudepilot-cx<N>-…`: clean up with that filter, never with a wildcard that could match someone else's. Never `docker system prune`. Memory is tight (about 4 GB free): ONE scratch portal, ONE rig host, ONE workspace container and ONE Chromium of yours at a time; stop them when idle; never leave watchers or polling loops.
4. A scratch portal for Connect work (PLAN.md section 5 recipe plus these explicit variables): `PORTAL_PORT=<yours> PORTAL_DATA_DIR=/tmp/cx<N>data PORTAL_SERVER_CODE=<8 digits> PORTAL_SECRET_KEY=<random> PORTAL_K8S_ENABLED=false PORTAL_DOCKER_SOCKET=/nonexistent.sock PORTAL_DOCKER_HOST_SOCKET=/nonexistent2.sock PORTAL_CONNECT_ALLOW_HTTP=true PORTAL_CONNECT_WORKSPACE_IMAGE=claudepilot-workspace:latest PORTAL_CONNECT_BASE_IMAGE=node:22-trixie-slim` (the last two are local images: nothing to pull), after `unset KUBECONFIG KUBERNETES_SERVICE_HOST`. The scanned Docker sockets are pointed at nothing so the enrolled target is the only one managing the containers (otherwise they would show under two targets). Rig hosts reach the portal at the bridge gateway, `172.18.0.1` in this sandbox (`docker network inspect bridge`), on your port.
5. **No new npm workspace packages** (the root `Dockerfile` copies each workspace's `package.json` by hand and is not ours). Shared tunnel and agent code live under `apps/server/src/connect/`; the agent bundle is generated into `apps/server/src/connect/agent.generated.ts` (the `cp-ci` pattern: `scripts/gen-*.ts`, a sync test). Dependencies: prefer none; `ws` and `tar-stream` are already in the server; anything else under `flock COORD/npm.lock npm install …` and say so in the report.
6. **The contract** `packages/contracts/src/connect.ts` is P1's file and is landed. A package owner who needs an ADDITIVE change (a new optional field, a new constant, a new union member that nothing exhaustive depends on) may make it, announcing it in their outbox the same hour, after re-reading the file and with `npm run typecheck -w @portal/contracts` green. A rename, a removal, or a change of meaning goes through the coordinator. The additions to the existing contract files (`workspace.ts`, `live.ts`) are in PRD §12.2 and are applied atomically with the code that needs them (the web's exhaustive `STATUS` map breaks when `WorkspaceStatus` grows; whoever adds `'unreachable'` fixes `WorkspacesPage.tsx` in the same change and leaves `npm run typecheck` green).
7. Each package ends with the PLAN.md section 7 report, a short status file (`COORD/status-cx<N>.md`, at most 40 lines, RESUME HERE block), an outbox (`COORD/outbox-cx<N>.md`), the PRD's milestone note for its milestone updated in the house style (Built / Partly built / Not built, what was observed, what is still 🔬), and a cleanup of everything it made.
8. On a usage-limit or 429 error: no retry loops; write RESUME HERE and stop with a short report.
9. Reference scripts from P1's spikes (docker over a custom `http.Agent`, the Kubernetes client over a loopback, `http.Server` over a duplex, `ws` through a CONNECT proxy, how the contract's vectors were made): `COORD/p1-spikes/` (see its README). They are scratch, not repo code.

## 1. Roster

| Package | Prefix | Scratch portal | CDP | Migrations | Wave | Size |
| --- | --- | --- | --- | --- | --- | --- |
| T1 Control plane and registry | cx1- | 3211 | 9341 | 130 to 149 | W1, then W2 | L (about 4 to 5k lines with tests) |
| T2 The agent (core, host service, proxies, packaging) | cx2- | 3212 | 9342 | none | W1, then W2 | XL (about 6k lines with tests); split option below |
| T2b (optional split) policy proxies: Docker and Kubernetes | cx2b- | 3217 | 9347 | none | W1 | L |
| T3 Remote runtime integration | cx3- | 3213 | 9343 | 150 to 159 | spikes W1, integration W2 | L (about 3 to 4k lines with tests) |
| T4 Installers and their endpoints | cx4- | 3214 | 9344 | 160 to 169 (unlikely) | W1, finish W2 | M to L (about 3k lines with scripts and tests) |
| T5 Web: Targets and the wizard | cx5- | 3215 | 9345 | none | skeleton W1, real API W2 | M (about 2 to 3k lines) |
| T6 QA, security, the rig | cx6- | 3216 | 9346 | none | rig W1 to W2, acceptance W3 | M to L |

**Split option for T2.** If a seventh agent is available, T2b takes `agent/services/docker/**` and `agent/services/kube/**` (the policy engines and proxies, their fakes and corpora, PRD §11.4, §11.5, appendices A and B); T2 keeps everything else. The boundary is the `services/<name>/index.ts` export `createService(deps): { handle(stream: TunnelStream, trace: string): void; status(): ConnectServiceStatus }`. Without a seventh agent T2 does the proxies after the core.

## 2. Order and hand-offs

```
W0  P1: PRD, contract, this file                                                        (done when you read this)
W1  T1 M1.0  tunnel library + seams.ts + conformance suite ──▶ announces in outbox-cx1 (T2, T3 wait for it only where they must)
    T2 policy engine, host executor, identity, CLI, spikes Q4 and Q5      T4 scripts, plan, manifest, generators
    T3 spikes against fakes (Docker agent seam, kube loopback)             T5 skeleton against fixtures
    T6 rig images, scratch-portal launcher, fakes list
W2  T1 registry, enrollment, hub, REST complete    T2 agent connects to the real hub (runAgent exported)
    T3 runtimes on the real tunnel                 T4 routes mounted by T1, T-INST in rig hosts
    T5 on the real API                             T6 rig + A1 first
W3  T6 A1 to A14, T-SEC, T-PERF, T-FAIL; everyone fixes what QA finds; PRD notes; final reports
```

First landings others wait for (each is announced in the owner's outbox, one line):

| Landing | Owner | Needed by |
| --- | --- | --- |
| `connect/seams.ts` (PRD appendix E, verbatim) | T1, first hour | T2, T3, T4 |
| `connect/tunnel/` (frames, mux, stream, lines, records, auth, `ws` adapter) and `conformance.ts` | T1, M1.0 | T2 client and services, T3 `TunnelAgent`, T6 |
| `runAgent(opts)` exported from `connect/agent/client.ts` (runs the real agent in-process against any portal URL and fake upstreams) | T2 | T1 and T3 integration tests, T6 |
| `agent.generated.ts` with `PILOT_AGENT`, `PILOT_AGENT_BUILD`, `PILOT_AGENT_SHA256` | T2 | T1 (`latest`), T4 (plan, routes) |
| `createInstallRoutes(deps)`, `buildPlan`, `buildManifest`, `buildCommands`, `previewSteps` | T4 | T1 mounts and uses them (admin create and plan preview) |
| `createTunnelRuntime` (the `RuntimeFactory`) | T3 | T1 wiring in `index.ts` |
| The `WorkspaceStatus 'unreachable'`, `Workspace.node`, `CreateWorkspaceRequest.node`, `WorkspaceTarget` fields and the web map fix | T3 or T5 (whoever first), atomically | T5, T3 |
| REST of `CONNECT_API` answering | T1 | T5, T6 |
| `LiveTopic 'connect'` (contract, `live.ts`, the hub's `notify`) | T1 | T5 |

---

## T1. Control plane and registry (server)

**Goal.** Everything on the portal side that is not a Runtime: the tunnel library, authentication, enrollment, the registry and its migrations, the hub, the admin and the agent-facing routes, the audit trail, the kill switch. PRD §8 (FR1 to FR25, FR55 to FR63 server parts), §9, §10, §12.1, §14, §15, appendix E.

**Owns (new).** `apps/server/src/connect/{index,seams,store,registry,enrollment,hub,events,settings,routes,publicRoutes}.ts`, `connect/tunnel/**` (`frame.ts`, `mux.ts`, `stream.ts`, `lines.ts`, `records.ts`, `auth.ts`, `ws.ts`, `conformance.ts`, tests), `connect/qa/stubAgent.ts` (a minimal agent for server tests; once T2's `runAgent` lands, tests prefer that), all `connect/*.test.ts` of its files.

**Surgical edits.** `store/migrations.ts` (append 130 to 149: PRD §14), `config.ts` (`config.connect` only: `PORTAL_CONNECT_ENABLED`, `_URL`, `_ALLOW_HTTP`, `_CA_FILE`, `_BASE_IMAGE`, `_WORKSPACE_IMAGE`, `_TOKEN_TTL_MIN`), `app.ts` (`createApp` option `connect`; mount `connect.routes()` under `/api/connect` behind `requireSession` and `connect.publicRoutes()` at `/connect` with no guard; `/api/workspaces/targets` additions are T3's), `index.ts` (create the module, `attach(server, portal)` before `attachShell`, the dev dispatcher sends `/connect/` to Hono; T3 adds the factory and `bind`), `live.ts` and `packages/contracts/src/live.ts` (the `connect` topic), `chat/redact.ts` and `portalmcp/sanitize.ts` (a `cpen_` pattern each, one line, with a test), `sockets.ts` only if the guard needs a hook (it should not: agent sockets carry no cookie).

**Provides.** `NodeLink`, `RuntimeDeps`, `RuntimeFactory`, `EnrollmentLookup`, `InstallDeps`, `ConnectModuleApi` (appendix E); the tunnel library for T2 and T3; the REST of `CONNECT_API`; the public routes `health`, `enroll`, `enroll/status`, `tunnel`; `connect.settled(ms)`, `canCreate`, `onReturned`; `RuntimeDeps`.
**Consumes.** The contract; T4's `createInstallRoutes`, `buildCommands`, `previewSteps` (until it lands, a stub that returns fixed text); T2's bundle constants (a stub until then); T3's `RuntimeFactory` (`useRuntimeFactory`).

**Work items, in order.**
1. `seams.ts` verbatim from appendix E. Announce.
2. **M1.0 the tunnel library**: frame codec against the contract's vectors; the mux session (open and accept, odd and even ids, per-stream windows, the fair scheduler with the 128 KiB and 32 KiB watermarks, ping and dead detection, GO_AWAY, protocol errors, stream cap); `TunnelStream` (a `Duplex` with the `net.Socket` stubs); the JSON-line reader and writer with the size caps; the host record codec; `auth.ts` (signed message, verify, fingerprint, the vectors); the `ws` adapter; `conformance.ts` exporting a suite that takes a `makeSessionPair()` so the agent runs it too. Announce.
3. Migrations, `store.ts`, `registry.ts` (targets, nodes, enrollments, events, settings; the in-memory live state; snapshots; the scanned-targets merge needs `workspaces.targets()`, passed in).
4. `enrollment.ts` (tokens: create, verify without using, use in a transaction, revoke, status grace, rate limits via `RateLimiter`), then the admin routes for targets and enrollments (create calls T4's builders; until then the stub).
5. `hub.ts`: the upgrade handler at `/connect/v1/tunnel` (subprotocol, no Origin, pre-auth bounds, challenge, auth, welcome or reject, duplicate rule, `control` stream and `config`, status ingestion, ping and RTT, close on revoke), `NodeLink` implementations, events, `last_seen` throttle, read-only store behaviour.
6. Nodes: PATCH, revoke, rotate (two-phase), drain; target PATCH/DELETE with the workspace choices (`ConnectRemoveBlocked`); settings; hide scanned; pending purge; retention.
7. Kill switch; `connect` live topic; the `cpen_` redactor patterns; wiring in `index.ts`.
8. Hardening pass against PRD §17; PRD milestone note for C1.

**Tests (PRD §19.3).** T-MUX (with the conformance suite and fuzz), T-AUTH, T-ENR (including the race for the last use), T-REG (migrations on a new and on a current database), parts of T-SEC (canaries: a token, a key and an env value injected through every writer must be absent from responses, logs, audit rows), T-FAIL for the hub (kill the socket mid-stream), T-PERF for the mux (the budgets of §19.6 that need no Docker).

**Acceptance.** With T2's real agent (or the stub) enrolled through the real routes: the node shows connected within 2 s of its connect; Revoke closes the socket within 2 s and the key never authenticates again; Rotate swaps keys with a crash injected at each step; a second connection for a healthy node is refused; 11 wrong tokens from one address give a 429; a Locked store refuses enrollment and still lets enrolled nodes connect; a portal restart returns every agent within 20 s; the kill switch makes `/connect/*` 404.

**Depends on.** The contract. T4 and T2 for the stubs' replacements. **Wave** W1 start, W2 finish. **Safety.** **KUBERNETES SAFETY RULE (verbatim):** scratch portals must run `unset KUBECONFIG KUBERNETES_SERVICE_HOST` and `PORTAL_K8S_ENABLED=false` explicitly; a throwaway kubeconfig is for a throwaway local test cluster only; `--kubeconfig <file>` on every `kubectl` call; never create or remove a Kubernetes workspace from a scratch portal. The owner's own dev portal intentionally uses the real cluster; scratch portals never do. Here, in particular: Rule 2 applies to the scratch-portal environment even though T1 touches no cluster.

---

## T2. The agent

**Goal.** The `pilot-agent` program: one TypeScript bundle that enrolls, connects, serves `control`, `docker`, `kube` and `host`, and diagnoses itself. PRD §8 (FR13, FR18, FR20 to FR31, FR35 agent side, FR48 to FR51 agent side), §9, §10.3, §10.4, §11, appendices A to C.

**Owns (new).** `apps/server/src/connect/agent/**`: `main.ts` (CLI), `identity.ts`, `client.ts` (tunnel client, reconnect, `runAgent`), `control.ts`, `config.ts`, `log.ts`, `doctor.ts`, `build.ts` (esbuild), `services/host/{index,exec,put,read,usage,paths}.ts`, `services/docker/{index,proxy,policy,rules,execIds,schema}.ts`, `services/kube/{index,proxy,rules}.ts`, `testkit/` (`fakeDocker.ts`: a recording fake Docker daemon on a unix socket; `fakeKube.ts`: an in-process fake API server with exec upgrade), `apps/server/scripts/gen-connect-agent.ts`, `apps/server/src/connect/agent.generated.ts` (generated, committed), `apps/server/src/workspaces/hostexec.ts` (new: `hostPath`, `userEnv`, `sample`, `writeEntry`, the pty loader moved out of `local.ts`).

**Surgical edits.** `workspaces/local.ts` (import from `hostexec.ts`; `local.test.ts` stays green), `apps/server/package.json` (script `gen:connect-agent`; no dependency changes expected).

**Provides.** The bundle and its constants; `runAgent(opts)` (in-process, for tests); `createService` per service; `policyDecision` and the schema as importable modules; `testkit/` for T3 and T6; the doctor JSON shape.
**Consumes.** T1's tunnel library and `seams.ts` (types), the contract.

**Work items, in order.**
1. **Spikes are answered (P1 ran them, PRD Q4 and Q5, ✅); turn them into tests first.** Q4: a Node `http.Server` fed one side of a `duplexPair` with `server.emit('connection', duplex)` handled keep-alive, a 3 MB chunked POST, a 20 MB streamed response with backpressure and `Upgrade` (the test belongs in `agent/services/docker/`). Q5: `ws` ignores `NODE_USE_ENV_PROXY=1` (global `fetch` and `WebSocket` honour it), so build the agent's own CONNECT `https.Agent` (`HTTPS_PROXY`, `NO_PROXY`, proxy credentials) and test it with a local CONNECT proxy and a self-signed `wss://` server. Re-run both on the Node 22 line the agent supports; if a later 22.x breaks Q4 the carrier becomes a unix-socket `net.Server` per agent.
2. `hostexec.ts` extraction (mechanical; `local.test.ts` green), then `services/host/**` (PRD §11.6), run against the real executor in tests.
3. `identity.ts`, enrollment client, `client.ts` (handshake, `welcome`, `control`, reconnect with jitter, fatal rejections, portal id pin, rekey two-phase with a crash point at each step), `control.ts` (status, config, log, bye), `config.ts` (env and `agent.json`), `log.ts` (redaction rules, canary test), `doctor.ts`. Export `runAgent`. Announce.
4. `build.ts` and `gen-connect-agent.ts`: esbuild to one ES module, hygiene test (imports only `node:*`, `ws`, `tar-stream`, `@portal/contracts`), the sync test, the three constants. Announce.
5. `services/docker/**`: the proxy (parse, decide, re-issue, hijack), the rule table of appendix A, the strict create schema, exec-id tracking, container resolution with the 2 s cache, label forcing, denial counters. **T2b if split.**
6. `services/kube/**`: the proxy (token injection and re-read, header stripping, the local bearer, the allowlist of appendix B, selector injection, upgrade passthrough, streaming). **T2b if split.**
7. Proxy support (`HTTPS_PROXY`), private CA (`PILOT_CA`), `PILOT_HEADERS`; resource limits; the 100 MB `put` and the slow-consumer tests.
8. PRD milestone note for C2.

**Tests (PRD §19.3).** T-POL (including the **recorded requests of `DockerRuntime`**: run the real `DockerRuntime` against the policy proxy in front of `fakeDocker` and assert every operation it makes is allowed; the adversarial corpus; fuzz; then the same against real DinD behind `CLAUDEPILOT_DOCKER_TESTS=1`), T-KUBE (proxy against `fakeKube`), T-HOST, T-AGENT, T-MUX (runs the conformance suite against the agent's use of the library), T-SEC (the log canary run; the loopback bearer), T-PERF (the host `put` and idle memory).

**Acceptance.** The agent, started in a rig container with the real DinD socket, enrolls against a portal (T1's, or an in-test hub), connects, and a raw HTTP client over a `docker` stream can list containers, while every request of the A10 list is refused with its rule id and counted in `status.denied`; a `host` stream runs `echo`, a pty with a resize, a `put` that sets owner and mode, a `read`; `doctor --json` reports every check; the generated bundle equals a fresh build.

**Depends on.** T1 M1.0 for the mux (T2 starts on policy, executor and CLI while it lands). **Wave** W1 to W2. **Safety.** **KUBERNETES SAFETY RULE (verbatim):** scratch portals must run `unset KUBECONFIG KUBERNETES_SERVICE_HOST` and `PORTAL_K8S_ENABLED=false` explicitly; a throwaway kubeconfig is for a throwaway local test cluster only; `--kubeconfig <file>` on every `kubectl` call; never create or remove a Kubernetes workspace from a scratch portal. The owner's own dev portal intentionally uses the real cluster; scratch portals never do. Here, in particular: Rule 2: `fakeKube` is in-process; no real cluster; no kubeconfig; the kube proxy's service-account paths are injectable.

---

## T3. Remote runtime integration

**Goal.** Make the tunnel look like the runtimes the portal already has, and make the portal calm when a tunnel drops. PRD §8 (FR32 to FR44), §12.3 to §12.10.

**Owns (new).** `apps/server/src/workspaces/connect/**`: `factory.ts` (`createTunnelRuntime`: the `RuntimeFactory`), `tunnelAgent.ts` (`TunnelAgent extends http.Agent`), `dockerCluster.ts` (`ConnectDockerRuntime`: the composite over nodes), `kubeLoopback.ts` and `kube.ts` (the loopback listener, the `KubeConfig`, the wrapper), `host.ts` (`HostRuntime`), `testkit.ts`, tests.

**Surgical edits.** `workspaces/docker.ts` (an injected `reach()` for `check()`, `pullOnly` for tunnelled targets, `where`), `workspaces/kubernetes.ts` (an optional ready `KubeConfig`, `manageNamespace: false`), `workspaces/runtime.ts` (`portalUrl?`, `listLastKnown?`, `CreateSpec.node?`, `TargetUnreachableError`), `workspaces/manager.ts` (`addRuntime`, `replaceRuntime`, `removeRuntime`, check-cache coherence, serving `listLastKnown()` for unavailable runtimes, `resume()` waiting on `settled(20_000)`, `hooks.beforeCreate`, `node` through create and the pending entry), `chat/controller.ts` (`targetState?` and `targetReturned()` consulted in `#scheduleRetail` and the reattach; nothing else), `delivery/reconciler.ts` (a `TargetUnreachableError` becomes `pending` with a reason; `request` on return), `portalmcp/internalUrl.ts` (`runtime.portalUrl`), `packages/contracts/src/workspace.ts` (PRD §12.2, atomically with the web map fix), `index.ts` (the factory and `bind`; with T1), outbox, CI and Claude-usage code only where the outage audit finds noise (one log per outage).

**Provides.** `createTunnelRuntime`; the dynamic `Workspaces` API; the unreachable semantic and `Workspace.lastSeenAt`; the chat and delivery hooks.
**Consumes.** `seams.ts` and the tunnel library (T1); the agent (T2) through `runAgent`; `fakeDocker`/`fakeKube` (T2's testkit); the contract.

**Work items, in order.**
1. **Spike to a test (W1, against a passthrough):** a `TunnelAgent` over an in-process `NodeLink` whose `docker` stream is a plain connection to the DinD socket; the whole of `DockerRuntime` through it (create from the local `claudepilot-workspace:latest`, list, exec with stdin, shell with a resize, put and read, usage, events, remove). The scratch spike behind the PRD (a custom `http.Agent` returning a `Duplex` with the `net.Socket` stubs) already worked for ping, version, create, exec, archive and events ✅. Likewise `KubernetesRuntime` against a loopback that fronts `fakeKube`.
2. `HostRuntime` (PRD §12.7 table) with `LocalRuntime`'s state machine; the delivery methods over the `host` ops.
3. `ConnectDockerRuntime` (composite, placement, names across nodes, the name→node map), `maxWorkspaces`, drain, `portalUrl`, the pull-only image step.
4. `ConnectKubeRuntime` over the loopback listener (per connection port and token; closed with the connection).
5. Manager: dynamic runtimes, snapshot and `unreachable`, resume grace, `beforeCreate`, `node`; the contract additions and the web map fix.
6. The outage rule: chat hooks, reconciler, the audit of outbox, CI, usage and terminals, each with a test where a runtime throws `TargetUnreachableError`.
7. `internalUrl`, wiring in `index.ts`.
8. Integration on the real tunnel (W2) with T2's `runAgent` and then the real agent in a rig container; PRD notes for C3.

**Tests (PRD §19.3).** T-RT (the one contract suite against `DockerRuntime`, the tunnelled Docker runtime on DinD, the Host runtime, the Kubernetes runtime over the tunnel against `fakeKube`; plus a chat session on the Docker and Host ones with the stand-in Anthropic API), T-MGR, T-OUT (including the real run that drops the tunnel mid-turn), T-PERF (terminal echo overhead, `list()` of 20).

**Acceptance.** A workspace created on a tunnelled Docker target is an ordinary container with the portal's labels; every feature of the runtime contract passes through the tunnel; killing the tunnel for 3 minutes mid-turn marks nothing Interrupted, `failed` or `frozen`, the list says Unreachable then Running, and the turn finishes; a portal restart resumes a pending create after the agents return; the Kubernetes runtime creates, scales, execs and removes in the fake without ever creating a namespace.

**Depends on.** T1 (seams and tunnel; the registry for W2), T2 (`runAgent`, W2). **Wave** spikes W1, integration W2. **Safety.** **KUBERNETES SAFETY RULE (verbatim):** scratch portals must run `unset KUBECONFIG KUBERNETES_SERVICE_HOST` and `PORTAL_K8S_ENABLED=false` explicitly; a throwaway kubeconfig is for a throwaway local test cluster only; `--kubeconfig <file>` on every `kubectl` call; never create or remove a Kubernetes workspace from a scratch portal. The owner's own dev portal intentionally uses the real cluster; scratch portals never do. Here, in particular: Rule 2, strictly: `KubernetesRuntime` is only ever pointed at `fakeKube` in the default suite; the injected-`KubeConfig` path never calls `loadFromDefault()`, and a test that still constructs a `KubernetesRuntime` the old way points `KUBECONFIG` at a temp file it writes itself (an unroutable `http://127.0.0.1:1`, as `qa/runtimes.test.ts` does) and restores the variable afterwards; never create or remove a Kubernetes workspace from a scratch portal.

---

## T4. Installers and their endpoints

**Goal.** The two static installers, the plan, the manifest, the downloads, and everything that proves them. PRD §8 (FR41, FR45 to FR54), §13, §19.3 T-STATIC, T-INST, T-PS.

**Owns (new).** `apps/server/src/connect/install/**`: `routes.ts` (`createInstallRoutes(deps)`), `plan.ts` (`buildPlan`), `manifest.ts` (`buildManifest`), `commands.ts` (`buildCommands`, `previewSteps`), `fetcher.ts` (the 15-line `node -e` fetcher with its own tests), `scripts/install.sh`, `scripts/install.ps1`, `installers.generated.ts` (generated, with `apps/server/scripts/gen-connect-installers.ts` and a sync test), `node-manifest.json` (with `scripts/gen-connect-node.ts` and a shape test), tests, `apps/server/src/connect/qa/` fixtures for the scripts if needed.

**Surgical edits.** `apps/server/package.json` scripts (`gen:connect-installers`, `gen:connect-node`).

**Provides.** `createInstallRoutes`, `buildPlan`, `buildManifest`, `buildCommands`, `previewSteps`, the two scripts and their sha256s.
**Consumes.** T1's `EnrollmentLookup` (in `seams.ts`: look a token up without using it), T2's bundle constants, the contract (`CONNECT_PLAN_KEYS`, `CONNECT_INSTALL_*`, `CONNECT_PUBLIC`).

**Work items, in order.**
1. The plan text and its allowlist parser (shared by both scripts' logic, tested in both), the manifest generator with golden files.
2. `install.sh`: preflight, plan fetch (`curl --config -` for the header), pinned download, then per kind: Docker (§13.3), Container, Host (Node detection or download, pty package with the integrity check, the systemd user unit or the start script, the consent), Kubernetes (context shown and confirmed, `kubectl auth can-i`, apply, rollout wait), Swarm; wait for connected; `upgrade`, `uninstall`, `doctor`, `status`; `PILOT_DRY_RUN`; exit codes and the `PILOT_RESULT=` line; never prints the token.
3. `install.ps1` with the same flows except Host.
4. The routes (scripts with `ETag`, plan, manifest, `latest.json`, the bundle, the workspace image context tarball) and their tests; `buildCommands` (all four commands per platform, the `sudo env` and private-CA variants, the sha256).
5. Rig tests (T-INST) with T6's rig images (or its own throwaway ones) and T-PS in the PowerShell image; shellcheck via `koalaman/shellcheck`.
6. PRD notes for C4.

**Tests (PRD §19.3).** T-STATIC, T-INST, T-PS; token canaries across dry-run, `PILOT_DEBUG=1` and `set -x`.

**Acceptance.** A rig host with the DinD socket runs the pasted Docker command against a scratch portal and the install ends `PILOT_RESULT=connected`; the same for Container and Host (non-root user, `PILOT_SERVICE=none`); a re-run is a no-op that still reports connected; a wrong token exits 12, an unreachable portal 11, a bad checksum 13; `uninstall` leaves workspaces; the manifest passes its structure test and `kubeconform` (`kubectl apply --dry-run=client` can't run without an API server: observed), and the Kubernetes flow of `install.sh` runs against a stub `kubectl` on `PATH` that records its calls; dash, `bash --posix` and shellcheck pass; `install.ps1` parses and dry-runs in the PowerShell container.

**Depends on.** T1 (lookup seam, mounting), T2 (the bundle). **Wave** W1 (scripts, generators, golden files), W2 (against a live portal). **Safety.** **KUBERNETES SAFETY RULE (verbatim):** scratch portals must run `unset KUBECONFIG KUBERNETES_SERVICE_HOST` and `PORTAL_K8S_ENABLED=false` explicitly; a throwaway kubeconfig is for a throwaway local test cluster only; `--kubeconfig <file>` on every `kubectl` call; never create or remove a Kubernetes workspace from a scratch portal. The owner's own dev portal intentionally uses the real cluster; scratch portals never do. Here, in particular: Rule 2: tests never run a real `kubectl`: the installer's Kubernetes flow runs against a stub `kubectl` (and a stub `docker service`) on `PATH` that records its arguments; the manifest is checked by a structure test and `kubeconform`; any `kubectl` a person runs by hand carries `--kubeconfig <file>`.

---

## T5. Web: Targets and the wizard

**Goal.** The Targets page, the Add wizard, the registry detail, and the changes to the Workspaces page, within the text diet. PRD §8 (FR55 to FR59), §16.

**Owns (new).** `apps/web/src/features/targets/**` (`TargetsPage.tsx`, `TargetRow.tsx`, `TargetSheet.tsx`, `AddTargetDialog.tsx` with its step state machine in a testable `wizard.ts`, `CommandBlock.tsx`, `ScriptSheet.tsx`, `SettingsSheet.tsx`, `api.ts`, `types.ts`, tests).

**Surgical edits.** `app/nav.ts` (an admin entry `Targets`, icon `Server`), `app/App.tsx` (the route `targets`), `lib/api.ts` (or the feature's own `api.ts` like the MCP feature), `lib/live.tsx` (the `connect` topic), `features/workspaces/WorkspacesPage.tsx` (the Targets card becomes one line linking to Targets; the new `unreachable` entry in the `STATUS` map and a disabled-actions rule), `NewWorkspaceDialog.tsx` (target grouping, the Node select for clusters with several nodes, the default target), `WorkspaceSheet.tsx` (last seen). The contract additions of PRD §12.2 (`WorkspaceStatus 'unreachable'` and the rest) if T3 has not made them, **atomically with the map fix**. G2's agent edits the workspace row (a repo chip): re-read before every edit.

**Provides.** The UI. **Consumes.** The contract; T1's REST (fixtures before it exists: a local fixture module typed against the contract).

**Work items.** 1. Types, `api.ts`, fixtures. 2. The list (statuses, rows, scanned rows with Hide, empty state). 3. The wizard (step 1 with the matrix and the Host acknowledgement, step 2 with the command block, copy, "View script", "What it does", the live line from the `connect` topic and the enrollment status, expiry and "New command", "Add node"). 4. The detail sheet (nodes, drain, rotate, revoke, settings, events, Remove with the workspace choice). 5. The Workspaces page changes. 6. Settings sheet. 7. Look at it: every state of PRD §16.4 at 390 and 1280 px, light and dark, with a real rig host connecting while the wizard is open (T6's rig); fix; PRD notes for C5.

**Tests (PRD §19.3 T-UI).** node:test for the wizard state machine and the command-builder helpers (no UI library needed); `npm run build -w @portal/web`; screenshots read with `COORD/drive.mjs` (copy it to /tmp); an API-driven flow against the real routes.

**Acceptance.** The wizard from Add to "Connected" works against a rig host; the registry shows every state; the Workspaces page shows Unreachable workspaces and a single as an ordinary workspace; the whole of it is within the text diet (no paragraph under a title, explanations in `InfoTip`, one terse line for irreversible acts), reachable by keyboard, named controls, no horizontal scroll at 390 px.

**Depends on.** The contract; T1's REST (W2); T3 or itself for the status addition. **Wave** skeleton W1, real API W2. **Safety.** **KUBERNETES SAFETY RULE (verbatim):** scratch portals must run `unset KUBECONFIG KUBERNETES_SERVICE_HOST` and `PORTAL_K8S_ENABLED=false` explicitly; a throwaway kubeconfig is for a throwaway local test cluster only; `--kubeconfig <file>` on every `kubectl` call; never create or remove a Kubernetes workspace from a scratch portal. The owner's own dev portal intentionally uses the real cluster; scratch portals never do. Here, in particular: Rule 2 for any scratch portal; the wizard can create a `kubernetes` target in the registry but nothing in the UI work applies a manifest.

---

## T6. QA, security, the rig

**Goal.** The rig, the acceptance scenarios, the security review and tests, performance and failure injection, and the honest PRD notes. PRD §19, appendix D.

**Owns (new).** `tools/connect/**` (the rig: `rig-host` and `rig-pwsh` images, the scratch-portal launcher, an admin helper, one runner per scenario, a cleanup script by prefix), `apps/server/src/connect/qa/**` (the cross-package tests: A-scenarios that can run as node:test, T-SEC, T-PERF, T-FAIL), `docs/qa/connect-qa.md` (findings tagged with severity and owner: `[T1]` to `[T5]`; new file, Q2's area is not edited), the PRD's appendix D results.

**Surgical edits.** None to product code: findings go to the owners' outboxes and the coordinator.

**Work items.** 1. (W1) Build the rig images once (`cx6-rig-host`: `node:22-trixie-slim` with `docker-cli` copied from `docker:cli`, tmux, git, jq, curl, sudo and a non-root user `pilot`; `cx6-rig-pwsh`: `mcr.microsoft.com/powershell`), the launcher with PRD §19.2's environment, the admin helper, the cleanup script. 2. (W2) A1 first, as soon as T1, T2, T3 and T4 can connect one target; then the rest. 3. (W3) A1 to A14, T-SEC (canaries everywhere, replay and brute force, the raw-HTTP attacks through the tunnel, SSRF, the loopback listener, a read of the diff against PRD §17), T-PERF (§19.6), T-FAIL (§19.7), the manual checklists D1 to D7 prepared as a printable file for the owner (they are where real clusters, swarm, macOS and Windows get checked: no agent runs those). 4. Report every finding with severity, owner and a repro; re-test fixes; update the PRD's milestone notes with what was observed and what stays 🔬.

**Acceptance.** PRD §19.4 A1 to A14 pass in their default form (A6 and A7 with the fake API server and the stubs) or are listed with their blocking finding; no real-cluster or swarm test was run; every 🔬 item is listed with its checklist; the full server suite, the typecheck and the web build are green; everything the rig made is gone.

**Depends on.** Everything. **Wave** rig W1 to W2, scenarios W3. **Safety.** **KUBERNETES SAFETY RULE (verbatim):** scratch portals must run `unset KUBECONFIG KUBERNETES_SERVICE_HOST` and `PORTAL_K8S_ENABLED=false` explicitly; a throwaway kubeconfig is for a throwaway local test cluster only; `--kubeconfig <file>` on every `kubectl` call; never create or remove a Kubernetes workspace from a scratch portal. The owner's own dev portal intentionally uses the real cluster; scratch portals never do. Here, in particular: Rule 2 in full. **COORDINATOR'S DECISION on the heavy tests (2026-10-12): no agent runs a real-cluster or a swarm test.** Not the tunnel against a throwaway k3s, not a nested privileged `docker:dind` swarm. The proof is the in-process fake Kubernetes API server, the `kubectl` and `docker service` stubs and `kubeconform`; real clusters, swarm, macOS and Windows are the owner's manual checklist (PRD appendix D). T6 may WRITE the two tests if it finds that cheap, as opt-in tests that are skipped unless `CLAUDEPILOT_K8S_TESTS=1` or `CLAUDEPILOT_SWARM_TESTS=1`, each with its own throwaway kubeconfig or daemon and never the default context, one at a time; nobody runs them without the coordinator's explicit go. Writing them is optional and only if cheap; a skipped test that nobody runs is a deliverable, not a duty.

---

## 3. The end-to-end scenarios (PRD §19.4; T6 runs them, owners run the one they unblock)

Commands are sketches; T6 turns them into scripts under `tools/connect/`. `PORTAL=3216`, `JAR=/tmp/cx6jar`, the gateway is `172.18.0.1`.

**A1 Docker cluster end to end.**
1. Start the scratch portal (rule 4). Sign in: `curl -s -c $JAR -H 'Origin: http://localhost:3216' -H 'Content-Type: application/json' -d '{"code":"<code>"}' localhost:3216/api/login`.
2. `curl -s -b $JAR -H 'Origin: http://localhost:3216' -H 'Content-Type: application/json' -d '{"kind":"docker","platform":"linux","id":"cx6-dock","portalUrl":"http://172.18.0.1:3216"}' localhost:3216/api/connect/targets` → keep `data.commands.install` (and look at the same flow in the wizard in the browser).
3. `docker run -d --name cx6-rig1 -v /var/run/docker.sock:/var/run/docker.sock cx6-rig-host sleep 3600`; `docker exec cx6-rig1 sh -c '<install command>'`. Expect `PILOT_RESULT=connected` and exit 0 in under 60 s.
4. `GET /api/connect/targets` shows `cx6-dock` connected with one node, `GET /api/workspaces/targets` lists it available. `docker ps` shows `claudepilot-agent-cx6-dock` (label `claudepilot.connect=agent`, no `claudepilot.managed`).
5. `POST /api/workspaces {"name":"cx6-w1","target":"cx6-dock","cpus":1,"memoryMb":1024}` (or the dialog): a container `claudepilot-cx6-w1` with `claudepilot.managed=true` and `claudepilot.portal=<id>` appears and the list says Running.
6. Open the shell WebSocket (or the page), run `echo $((6*7))` → 42. Start a chat session against the stand-in Anthropic API (the helpers of `secrets/claude.integration.test.ts`), get a reply. Assign a Secrets & env pool with a file secret: it appears in the workspace with its mode. `GET /api/workspaces/usage` shows numbers.
**A2 Survive a revoke.** `DELETE /api/connect/nodes/<id>`: within 2 s the target is offline, `cx6-w1` is `unreachable` with `lastSeenAt`, `docker ps` still lists it, open terminals closed. Make a new enrollment for the target, run its command in the rig host: the node returns, the workspace is Running, the chat session reattached. **A3 Remove keeping workspaces.** `DELETE /api/connect/targets/cx6-dock` answers 428 with `ConnectRemoveBlocked`; with `?workspaces=keep` it forgets the target and the container is still there; repeated with a connected node and `?workspaces=remove`, the container and its volume are gone.
**A4 Single container.** Wizard or API with `{"kind":"container",…,"id":"cx6-box"}`; run in a rig host; the list shows one workspace `cx6-box/cx6-box`; Stop and Start switch it; terminal and chat work; `docker inspect claudepilot-cx6-box` shows no Docker socket mount and no token in its environment or arguments.
**A5 Single host.** `{"kind":"host","options":{"hostAccess":true},…,"id":"cx6-metal"}`; in the rig host as user `pilot` with `PILOT_SERVICE=none` run the command interactively (the consent is asked on the tty); terminal and chat work; drop the tunnel (kill the agent's socket): the tmux session survives and reattaches; `uninstall` removes `~/.claudepilot/agent` and nothing else.
**A6 Kubernetes.** Default: the manifest generator's golden test, the structure test, `kubeconform`; `runAgent` in kubernetes mode against `fakeKube` enrolls with the Secret token, writes its identity Secret and the runtime lists, creates, execs and removes in the fake. The same on a throwaway k3s is NOT run (rule 2, the coordinator's decision); the owner's checklist D3 covers a real cluster.
**A7 Swarm.** The generated `docker service create` string is checked (global, the template node name, `--env-rm` afterwards, the socket mount, the label). A nested swarm is NOT run (rule 2, the coordinator's decision); the owner's checklist D4 covers two real nodes and placement; the stub `docker service` checks the command.
**A8 Portal restart.** With A1 live and a create in flight: `tmux kill-session`, start the portal again. Agents return within 20 s; the pending create resumes (not "Could not resume after restart"); the chat session reattaches without a duplicate line; no delivery row says `failed` or `frozen`.
**A9 Token abuse.** A used token, an expired one (set a 1-minute TTL), a revoked one, a wrong one 11 times, two hosts at once with one token: each refusal has its reason and the 11th is 429; exactly one enrollment exists; `grep` of the portal log, the agent logs, the audit table and the chat transcripts for the token finds nothing; the live line named the address that used it.
**A10 The filter holds.** Through `NodeLink.open('docker')` (a test hook) send raw requests: a privileged create; `HostConfig.Binds: ["/:/host"]`; a volume with `DriverOpts {o: bind}`; `DELETE` of the agent's own container; exec in a container that is not managed; two requests smuggled in one; an absolute-form target; `//containers/json`. Each is 403 with its rule id, the recording daemon saw none, and `status.denied` counts them.
**A11 Scripts on other systems.** `install.sh` under dash and `bash --posix` with shellcheck; `install.ps1` parse, PSScriptAnalyzer and dry run in the PowerShell container; the macOS and Windows checklists (PRD D1, D2) printed for the owner.
**A12 Upgrade and compatibility.** Build a second bundle; the node shows Outdated; `… | sh -s -- upgrade` swaps it and the node reconnects with the new build; an agent claiming protocol 0 gets `upgrade_required` and waits an hour (fake the clock).
**A13 Private CA and proxy.** A scratch portal behind a self-signed certificate (a tiny TLS terminator in the test): the private-CA command connects; the same through a local CONNECT proxy with `HTTPS_PROXY`; assert the agent's TLS options never disable verification.
**A14 The UI, looked at.** PRD §16.4 at 390 and 1280 px, light and dark, with a real rig host connecting while the wizard is open; read the screenshots; the text diet holds.

## 4. Definition of done for the whole track

All six milestones C1 to C6 are Built or Partly built with the unproven parts listed 🔬; `npm run typecheck`, the full server suite (once, at the end), the web build and the new tests are green; A1 to A14 pass or each failure is a filed finding; the PRD's milestone notes say what was observed; the README row for the PRD is current; every container, volume, image, network, tmux session and /tmp file a package made is gone; nothing of the owner's was touched; the owner's decisions of PRD §23.1 are listed for them.
