# PRD: Targets and Connect

| | |
| --- | --- |
| Status | **Draft v0.1, nothing built** (2026-10-12). The shared contract is written: [`packages/contracts/src/connect.ts`](../../packages/contracts/src/connect.ts) (its handshake signature and frame vectors were reproduced with Node's crypto). Written from the portal's code and from research on Portainer's Edge Agent, Teleport, GitLab's agent for Kubernetes, Coder's external provisioners, the k3s, Tailscale and cloudflared installers, GitHub's runner registration, Docker socket proxies, yamux and Node single executables (§22). ✅ = observed here, 📄 = read from documentation or a spec and not observed, 🔬 = only a real macOS, Windows, Kubernetes or Cloudflare setup can confirm it (the manual checklists are in appendix D). Two seams were tried in a scratch script and work: dockerode over a custom `http.Agent` whose connection is a plain `Duplex` (ping, version, create, exec with stdin, archive put and get, events; it needs the `net.Socket` methods `setKeepAlive`, `setNoDelay`, `setTimeout`, `ref`, `unref` stubbed ✅), and `@kubernetes/client-node` 2.0 against a plain-HTTP loopback endpoint including `Exec` over `ws://` (it sends a bearer token, so the agent must replace it ✅). |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [Workspace Claudes](workspace-claudes.md) (the "This machine" target this generalises), [Pools foundation](foundation-pools.md) (delivery access, §6.2; Kubernetes delivery F3), [Chat sessions](chat-sessions.md) (readers that must survive a dropped tunnel), [Web app & PWA](web-app-pwa.md) (HTTPS, the Cloudflare tunnel) |
| Related | [Settings & policies](settings-policies.md), [Monitoring dashboard](monitoring-dashboard.md), [Portal MCP](portal-mcp.md) (the public listener and its tunnel guide; Connect's paths join it), [Local git and CI/CD](local-git-ci.md) (runs reach workspaces through the same runtimes) |

## 1. Summary

Today a workspace runs on a Docker daemon, a Kubernetes namespace or the portal's own machine, and those places are fixed in the portal's environment (`PORTAL_DOCKER_SOCKET`, the kubeconfig, `PORTAL_LOCAL_ENABLED`). Connect lets a person add places from the web.

In **Targets** they press **Add**, choose what they are adding, and paste one command on the machine that will run workspaces. The command installs a small program, the **agent**, and the agent dials **out** to the portal over one WebSocket. The portal needs no way in. When the agent connects, the target shows up as connected, live, in the wizard and in the registry. From then on the portal reaches that machine's Docker API, Kubernetes API or shell through streams carried on the agent's connection, and everything the portal already does with a workspace works on it: create, start, stop, remove, terminals, chat sessions, files, usage, delivery of pools and secrets.

Two roles, five kinds (§6):

| Role | Kinds | What it means |
| --- | --- | --- |
| **Cluster** | Docker, Swarm, Kubernetes | New workspaces can be placed on it. It has one or more nodes. |
| **Single** | Container, Host | It is one workspace, from the moment it connects. A Container is the workspace image with the agent inside (the portal gets no access to the host's Docker). A Host is the machine itself. |

Targets the portal finds by itself (the Docker sockets, the kubeconfig, This machine) stay, shown beside the enrolled ones and marked "scanned". Nothing is migrated.

## 2. Background and problem

- The Targets card on the Workspaces page lists whatever the environment configured: "Docker /var/run/docker.sock" and "Docker (host) /var/run/docker.sock not found" (red) in the owner's screenshot. Adding a machine means editing the server's environment and restarting it, and the portal must be able to reach that machine: a Docker socket on its own host, a kubeconfig that works from there.
- Most machines a person wants to use are not reachable from the portal: a laptop, a home server behind NAT, a cluster whose API is private, a VM at another provider. The portal, behind Caddy and a Cloudflare tunnel, is reachable from them, not the other way round.
- "This machine" shows that a host can be a workspace, but only the machine the portal runs on.
- The owner's brief (2026-10-12): add a cluster (Docker at socket level, Docker Swarm, Kubernetes) or a single workspace host (a Docker container, or the host itself) from the web; an install wizard; a script downloaded from the portal and run at once, for Windows, Linux and macOS; copy and paste until the workspace is visible as connected; for a cluster a control plane that opens traffic to the server; a plan that is complete, built by several agents and testable.

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Add a target from the web and watch it arrive.** Wizard, one pasted command, a live "Connected" in the same dialog. No server restart, no environment edit. |
| G2 | **Outbound only.** The portal never dials a target. NAT, firewalls, Caddy, Cloudflare tunnels and Access need nothing the portal's own page doesn't. |
| G3 | **Every workspace feature works remotely.** One `Runtime` per target kind behind the interfaces the portal already has (§12), so create, exec, shell, put, read, usage, watch, delivery and chat need no per-feature remote code. |
| G4 | **Least privilege by construction.** The host operator, not the portal, owns what the portal may do on the host: a Docker request filter in the agent, a namespaced Role in Kubernetes, a container as the only thing a Single container exposes. A stolen portal is not a stolen host. |
| G5 | **A credential that can't leak from the portal.** A short-lived single-use token buys a node key the agent made itself; the portal stores only the public half. Revocable and rotatable, with the key's fingerprint visible on both sides. |
| G6 | **A trustworthy `curl \| sh`.** Static installers anyone can read and hash, a plan fetched with the token, every download pinned by sha256, a dry run, an uninstall and an upgrade, exit codes a wrapper can read. |
| G7 | **Survive the network.** A dropped tunnel never deletes or "fails" anything: workspaces keep running, show as unreachable with their last known state, and chat sessions and terminals recover when the node is back. |
| G8 | **Honest and testable here.** Everything that can run in this sandbox (Linux, DinD, a fake Kubernetes API server, stub `kubectl` and `docker service` programs, PowerShell and shellcheck in containers) has a test; everything that can't (real clusters, swarm, macOS, Windows) is marked 🔬 with a manual checklist for the owner. |

## 4. Non-goals

- **Inbound access.** The portal never connects to a Docker TCP port, an SSH server or a Kubernetes API of its own accord. (Rejected: §22.)
- **A fleet manager.** No scheduling by free memory, no live migration of workspaces between nodes, no rebalancing. Placement is the least loaded node by workspace count, or the node the person picks (§12.8).
- **Swarm services as workspaces.** Workspaces are interactive and stateful; they are plain containers on a node.
- **Browser & desktop pool and web previews on enrolled targets** in v1. The pool's companion containers need Docker features outside the managed profile (a shared network namespace, added capabilities); the tunnel has a reserved place for a TCP service (§9.5) that a later version can use.
- **Auto-upgrading the agent from the portal.** A portal that can push code to every host would make the Docker filter pointless (§17). Upgrades are a command a person runs, from a badge in the UI.
- **Windows as a native host in v1.** Windows machines use Docker Desktop (Linux containers) for every Docker and Single container variant; "directly on the host" on Windows is WSL2 (open a Linux shell, pick Linux). macOS "Host" is a labelled preview.
- **A Go or single-executable agent in v1.** The agent is one TypeScript bundle run by Node 22 (§22, D1). The protocol is yamux over WebSocket plus JSON so a Go agent can replace it without touching the portal.
- **Per-user permissions.** The portal has one admin identity; audit rows say `admin`.
- **Managing the target host.** No package installs, no updates of Docker or Kubernetes, no firewall changes. The installer checks and reports.

## 5. Users and stories

**Admin** (the person who runs the portal and owns the machines). **Host owner** is usually the same person, sometimes not.

| ID | Story |
| --- | --- |
| US1 | I add my home server. I open Targets, press Add, pick Cluster, Docker, Linux, name it `homelab`, copy one line, paste it over SSH. Before I look back, the dialog says Connected. I create a workspace on it from the usual dialog. |
| US2 | I pick Single, Host, Linux for my old laptop. The wizard asks me to confirm "shell as you, no isolation", and the script asks again on the laptop. The laptop appears in Workspaces as one workspace I can start, stop, open a terminal on and chat in. |
| US3 | I pick Single, Container for a VPS. It becomes one workspace in a container; the portal can't touch the VPS's other containers. |
| US4 | I add my Kubernetes cluster. The command shows me which cluster my kubectl points at and asks before it applies a namespaced manifest; the connector appears; I create workspaces in the namespace. |
| US5 | I add a three-node swarm: one command on a manager, and three nodes appear. I choose a node when creating a workspace, or let the portal pick the least loaded. |
| US6 | I'm on Windows. The same wizard gives me a PowerShell command for Docker Desktop. |
| US7 | The tunnel drops for ten minutes (Wi-Fi, a portal restart). My workspaces show "Unreachable" with what they were; a chat that was mid-turn is not marked Interrupted; when the node returns, the terminal reattaches and the chat continues. |
| US8 | I lose a laptop. I revoke its node: its tunnel closes at once and its key is dead. Its workspace shows unreachable. I remove the target and choose to keep its workspaces (there is no way to reach them anyway). |
| US9 | A token showed up in a screenshot. I revoke it; the pasted command now says "token revoked". If someone used it first, my own host's install says "token already used" and the audit shows the address that used it. |
| US10 | An agent is out of date. Targets shows "Update", and gives me the one command to run on that host; nothing changes on my hosts until I run it. |
| US11 | The portal URL changed (new domain). I run the upgrade command with the new address on each host. |
| US12 | I hide the red "Docker (host)" row I never use. |

## 6. Scope boundary: the matrix

Kind × where the command is pasted. "Sandbox" says what can be proven in this repo's sandbox (Linux, DinD, 4 GB of free memory); everything else is script logic and static checks plus a manual checklist 🔬.

| Kind | Linux | macOS | Windows (PowerShell) |
| --- | --- | --- | --- |
| **Docker** cluster (agent container + Docker socket behind the policy proxy) | v1 · sandbox: full | v1 · Docker Desktop 🔬 | v1 · Docker Desktop, Linux containers 🔬 |
| **Swarm** cluster (the same agent as a global service) | v1 · sandbox: unit tests of the generated service and a stub `docker service`; a real swarm is the owner's checklist 🔬 (D4) | v1 🔬 | v1 🔬 |
| **Kubernetes** cluster (Deployment + namespaced Role) | v1 · sandbox: fake API server, manifest checks (structure test, kubeconform), a stub `kubectl`; a real cluster is the owner's checklist 🔬 (D3) | v1 🔬 | v1 🔬 |
| **Container** single (workspace image + agent, no socket) | v1 · sandbox: full | v1 🔬 | v1 🔬 |
| **Host** single (the agent on the machine) | v1 · sandbox: in a rig container | **preview** 🔬 | later: WSL2 |

"Windows 🔬" means the PowerShell script is parsed and its logic run on Linux in a PowerShell container, and a person runs the checklist on a real Windows machine. The matrix as code is `CONNECT_MATRIX` in the contract; the wizard disables a cell that is `later` and explains it in an InfoTip.

Out of v1 and why: §4 (non-goals) and §21 (gap analysis).

## 7. Solution overview

```
 Browser ──HTTPS──▶ Portal (Hono, SQLite)                                   target side: outbound connections only
                     │ /api/connect/*   admin routes (cookie)               ┌───────────────────────────────────────────────┐
                     │ /connect/*       agent-facing routes (token, key)    │ agent: one JS file, run by Node 22            │
                     │ tunnel hub ◀═══ one WebSocket per node, yamux ═══════│  control stream: hello, status, rekey         │
                     │   │  NodeLink.open('docker' | 'kube' | 'host')       │  docker ─▶ policy proxy ─▶ /var/run/docker.sock│
                     │   ▼                                                  │  kube   ─▶ proxy (injects SA token) ─▶ API    │
                     │ Runtime adapters: the Runtime / DeliveryAccess       │  host   ─▶ exec, pty, put, read (as the user) │
                     │ interfaces the portal already has                    └───────────────────────────────────────────────┘
                     └ registry (SQLite): targets, nodes, enrollments, events
```

How one target comes to life:

1. **Wizard.** The admin picks kind, system and a name. `POST /api/connect/targets` makes a *pending* target and an enrollment token (`cpen_…`, 15 minutes, once) and returns the commands. The token is shown once.
2. **Command.** On the machine: `curl -fsSL <portal>/connect/install.sh | PILOT_URL=<portal> PILOT_TOKEN=cpen_… sh`. The installer is the same static script for everyone. It asks the portal for a **plan** (`GET /connect/v1/plan`, token in the `Authorization` header), checks the machine, downloads the agent bundle and checks its sha256 against the plan, and installs it the way the kind needs (§13).
3. **Enroll.** The agent makes an Ed25519 key pair, sends the public key with the token to `POST /connect/v1/enroll`, and keeps the private key (mode 0600). The token is used up. The portal stores the public key.
4. **Connect.** The agent opens the WebSocket. The portal sends a nonce; the agent signs it; the portal checks the signature against the stored public key and answers `welcome`. The agent opens the `control` stream and sends its status every 30 seconds.
5. **Use.** The registry registers a `Runtime` for the target with the workspace manager. The Targets page and the wizard turn to Connected through the live socket. Creating a workspace on the target now makes the portal open a `docker` (or `kube`, or `host`) stream to the agent for each request.
6. **Lose.** If the tunnel drops, the node is offline, the target is unavailable, its workspaces read "Unreachable" with the last known state, nothing is deleted, and everything reconnects on its own (§12.5).

### 7.1 The coordinator's hypotheses, and what this PRD decided

| | Hypothesis | Decision |
| --- | --- | --- |
| H1 | Reverse connect, one WebSocket | **Agreed**, with yamux framing, one fair-scheduled connection per node, and the rule that the agent starts no stream but `control` (§9). |
| H2 | One multiplexed connection, named streams exposed to the existing runtimes with the least invasive seam | **Agreed and refined**: Docker through a custom `http.Agent` (no listener at all), Kubernetes through a loopback listener whose bearer only the portal knows, Host as records with exactly "This machine"'s behaviour (§12). The seam was tried (✅). |
| H3 | Short-lived single-use token for a key the agent made | **Agreed**, with: token in a header or environment variable, never a URL or argument; multi-use up to 50 for clusters; a status grace; a two-phase key rotation; no takeover of a live connection; the portal id pinned in the agent (§10). |
| H4 | Generated scripts served by the portal | **Changed**: two static installers (`install.sh`, `install.ps1`) that read a per-token plan. Static means one script to review, hash and test; the command stays short; no secret in a URL. Uninstall, upgrade and doctor are subcommands (§13). |
| H5 | The kinds matrix | **Agreed and sharpened**: a cluster is a target with 1..N nodes and Swarm is the same agent as a global service; a Container single injects the agent through a volume so the workspace image doesn't change; Linux host v1, macOS preview, Windows host later (§6, §13). |
| H6 | One registry | **Agreed**: scanned rows are never persisted (they come and go with the environment), a Single reuses runtime kind `local`, a scanned row can be hidden (§8). |
| H7 | Least privilege | **Agreed and strengthened**: the policy is owned by the host operator and can't be widened by the portal; a strict allowlist schema for container creation (unknown fields denied); the portal's id is a required label; no `full` profile in v1; no silent agent upgrade (§11, §17). |

## 8. Functional requirements

"Verified by" names the test group in §19. A row that says 🔬 also needs the manual checklist in appendix D.

### Registry and targets

| ID | Requirement | Verified by |
| --- | --- | --- |
| FR1 | **One registry, two sources.** `GET /api/connect/targets` returns `ConnectTargetRow[]`: *scanned* rows (the Docker sockets, the kubeconfig target, This machine; read only, `source: 'scanned'`) and *enrolled* rows. Scanned targets are never stored; they appear and disappear with the environment. `GET /api/workspaces/targets` keeps its shape (`WorkspaceTarget[]`) and now includes enrolled targets, with the additive fields in §12.2. | T-REG |
| FR2 | **Ids.** An enrolled target's id is a plain lowercase name (`connectTargetIdProblem`), unique, never changes, not one of the reserved or scanned ids. It is the first part of every workspace id on it (`<id>/<name>`). The label is free text, 1 to 40 characters, editable. | T-REG |
| FR3 | **Cluster and single.** A cluster has one or more nodes and can host many workspaces. A single has exactly one active node and exactly one workspace, `<id>/<id>`, which exists from the moment the node connects and can't be created or removed (its runtime kind is `local`, so the existing UI already treats it that way). | T-REG, T-RT |
| FR4 | **Link.** A target's link is `pending` (nothing ever enrolled), `connected` (every non-revoked node connected), `partial`, or `offline`. The workspace manager sees the target as available when at least one node is connected and its needed service (`docker`, `kube` or `host`) reports ok. | T-REG, T-AUTH |
| FR5 | **Hide a scanned target.** A scanned target that is not available can be hidden from the list; the choice is stored (`connect_settings`); it reappears when it becomes reachable. | T-REG, T-UI |
| FR6 | **Pending targets.** The wizard creates the target before anything is enrolled. A pending target nobody enrolled is removed 24 hours after its last enrollment expired (`CONNECT_LIMITS.pendingTargetHours`); "Cancel" in the wizard removes it at once. | T-REG |
| FR7 | **Settings.** Label, `maxWorkspaces`, `workspaceImage` and `delivery` can change at any time. The Kubernetes `namespace` is fixed at install (changing it answers 409 and says to enroll again); `storageClass` and `storage` apply to workspaces made afterwards. | T-REG |
| FR8 | **Default target.** One target (scanned or enrolled) can be marked default; the New workspace dialog preselects it. | T-REG, T-UI |
| FR9 | **Remove.** Removing a target revokes its nodes, closes its tunnels and forgets it. With workspaces on it the call answers 428 `CONFIRM_REQUIRED` with `ConnectRemoveBlocked` until the request says `onWorkspaces=keep` (they stay on the host; the portal forgets them) or `remove` (the portal removes them first; the target must be connected). Nothing is deleted on a host unless the person chose `remove`. | T-REG, T-E2E |
| FR10 | **Capacity and quota.** A node shows cores, memory and workspace count (from its status). `maxWorkspaces` on a cluster is enforced at create (409 `LIMIT_REACHED`). A drained node gets no new workspaces. | T-MGR |

### Enrollment and credentials (detail in §10)

| ID | Requirement | Verified by |
| --- | --- | --- |
| FR11 | **Enrollment token.** `cpen_` plus 256 random bits, only its SHA-256 stored, shown once. Lifetime 15 minutes (60 for clusters), at most 24 hours; 1 use (clusters up to 50). Revocable. It travels only in the `Authorization` header or the `PILOT_TOKEN` variable, never in a URL, a command argument, a log line, an audit row or an error. | T-ENR, T-SEC |
| FR12 | **What a token can do.** `GET plan` and `GET manifest` don't use it up. `POST enroll` uses one use. A used-up token still answers `GET enroll/status` for 30 minutes so the installer can wait for "connected", and nothing else. Wrong tokens count against the client address (10 per 10 minutes, then 429). | T-ENR |
| FR13 | **Node key.** The agent makes an Ed25519 key pair and never sends the private half. The portal stores the public key and its fingerprint (first 32 hex of SHA-256). `pilot-agent doctor` prints the same fingerprint. | T-ENR, T-AUTH |
| FR14 | **Tunnel authentication.** Challenge and signature in the first messages of the WebSocket (§9.2). No clock is involved. Unauthenticated sockets are bounded (5 per address, 100 in all, 10 seconds, 8 KiB). | T-AUTH |
| FR15 | **One live connection per node.** A second connection for a node that is connected and healthy is refused (`already_connected`, close 4409) and audited; it takes over only once the first has been silent for 45 seconds. | T-AUTH |
| FR16 | **Revoke, rotate, re-enroll.** Revoking a node closes its tunnel at once and its key never authenticates again. Rotation is two-phase and admin-started: the agent makes a new key, proves it with the old one, saves it only after the portal acknowledged; the old key still authenticates for 10 minutes. A lost agent is replaced by a new enrollment on the same target. | T-ENR, T-AUTH |
| FR17 | **A single has one node.** A second enrollment on a single is refused (409 `target_enrolled`) until its node is revoked. A cluster takes as many as the token allows. | T-ENR |
| FR18 | **Portal id pinning.** The first `welcome` gives the agent the portal's id; it keeps it and refuses a connection whose `welcome` carries another (`portal_mismatch`), so a restored database with the same id keeps working and a different portal at the same address does not. | T-AGENT, T-AUTH |
| FR19 | **Store state.** While the store is Locked or Frozen (read only) enrolling and registry changes answer 503 `store_locked`; nodes already enrolled may still connect (the writes of `last_seen` are skipped). | T-REG, T-AUTH |

### Tunnel (detail in §9)

| ID | Requirement | Verified by |
| --- | --- | --- |
| FR20 | **One WebSocket, yamux frames.** Subprotocol `pilot.tunnel.v1`, compression off, frames as in yamux (§9.3), per-stream windows of 256 KiB, DATA frames of at most 64 KiB. | T-MUX |
| FR21 | **Fair and bounded.** The sender drains streams round-robin one frame at a time, control frames first, and hands frames to the socket only while its buffer is under 128 KiB, so a keystroke is never behind more than that. | T-MUX, T-PERF |
| FR22 | **Open request and answer.** Every stream starts with one JSON line from the opener and one from the acceptor (`ConnectOpenRequest`, `ConnectOpenResponse`) with typed errors; per-service caps (docker 64, kube 64, host 32) answer `busy`. | T-MUX, T-AGENT |
| FR23 | **Only the portal opens work.** The agent opens exactly one stream, `control`, and the portal answers `bad_open` to any other. The portal never dials an address an agent names. | T-SEC |
| FR24 | **Liveness and reconnect.** Both sides ping every 15 seconds and end the connection after 45 seconds of silence. The agent reconnects with full-jitter backoff from 1 s to 60 s, reset after 30 s of a good connection. Streams do not survive a reconnect and nothing is replayed. | T-MUX, T-AGENT, T-FAIL |
| FR25 | **Compatibility.** The portal accepts agent protocols `CONNECT_PROTOCOL_MIN`..`CONNECT_PROTOCOL`. An older agent gets `upgrade_required` (close 4426) and waits an hour between tries; a build that differs from the portal's is "outdated" in the UI and still works. | T-AUTH, T-AGENT |

### The agent's services (detail in §11)

| ID | Requirement | Verified by |
| --- | --- | --- |
| FR26 | **`docker`.** Raw Docker Engine API through the agent's policy proxy, profile `managed` (appendix A): only containers labelled `claudepilot.managed=true` and with this portal's id; creation validated against a strict allowlist; no privileged, host namespaces, devices, added capabilities, host binds, published ports, networks or builds. The host operator can widen it locally; the portal can't. | T-POL, T-RT |
| FR27 | **`kube`.** The Kubernetes API through the agent's proxy: the service-account token is injected (the portal's own Authorization and impersonation headers are dropped), paths are confined to the connector's namespace and an allowlist of resources (appendix B), and every request must carry the per-connection bearer the portal's loopback listener uses. | T-KUBE |
| FR28 | **`host`.** Commands, terminals, file writes and reads as the workspace user, with exactly the behaviour of `LocalRuntime` (path mapping for a Host, none for a Container). | T-HOST, T-RT |
| FR29 | **Status.** Every 30 seconds and on change: each service's health and version, host usage, Docker info, swarm role, denied-request counts by rule, open streams. | T-AGENT |
| FR30 | **No secrets in logs.** The agent never logs a command line, an environment, a file's content, a token or a key; a canary test fails the build if one appears. | T-SEC |
| FR31 | **Doctor.** `pilot-agent doctor [--json]` runs the checks of `CONNECT_DOCTOR_CHECKS` and says what to do; the installer runs the same checks before and after installing. | T-AGENT, T-INST |

### Runtime integration (detail in §12)

| ID | Requirement | Verified by |
| --- | --- | --- |
| FR32 | **Docker over the tunnel** with no change to what `DockerRuntime` does: a `Docker` client whose `http.Agent` opens a `docker` stream per connection. `check()` asks the agent; the image is pulled by reference and never built through the tunnel. | T-RT |
| FR33 | **Docker clusters.** One composite runtime per Docker or Swarm target over its nodes: names unique across nodes, a name→node map refreshed on a miss, `list()` the union, create placed on a chosen or the least loaded eligible node. | T-RT, T-MGR |
| FR34 | **Kubernetes over the tunnel** with no change to what `KubernetesRuntime` does except that it takes a ready `KubeConfig` (a loopback endpoint) and does not create the namespace (the manifest did). | T-RT, T-KUBE |
| FR35 | **Host runtime** for Singles: `LocalRuntime`'s state machine (switched on or off in the portal), usage from the agent's status, `watchStarts` on every (re)connect. | T-RT, T-HOST |
| FR36 | **Dynamic runtimes.** `Workspaces` can add, replace and remove a runtime while running; every cache (check, snapshot, watch) follows. | T-MGR |
| FR37 | **Unreachable, not gone.** The last good `list()` of each enrolled target is stored; while its node is offline the manager serves it with status `unreachable` and says since when. Workspaces are never removed because a tunnel is down. | T-MGR, T-OUT |
| FR38 | **After a portal restart** the manager waits up to 20 seconds for enrolled targets' first connection before it decides a pending create can't resume. | T-MGR, T-FAIL |
| FR39 | **Dependants stay calm.** A tunnel outage never marks a chat session Interrupted, never turns delivery into `failed` or `frozen`, never fails a CI run, and every one of them recovers when the node returns (§12.5). | T-OUT |
| FR40 | **A workspace reaches the portal** (Portal MCP, per-session agent tokens) at the target's own portal address, not the Docker gateway. | T-RT |
| FR41 | **Image provisioning.** The installer makes the workspace image exist on the host (pull, or build from the portal's context with `PILOT_BUILD_IMAGE=1`). The tunnel may pull the allowlisted reference again (updates) and never builds. | T-INST, T-POL |
| FR42 | **Browser pool** is not offered on enrolled targets (its `supports` says no, with the existing wording). | T-REG |
| FR43 | **Delivery switch.** `settings.delivery=false` makes the runtime expose no `delivery`, so pools, secrets and the chat host read "unsupported" there. Default on. | T-RT |
| FR44 | **Kubernetes delivery** works through the tunnel as soon as foundation F3 exists; until then Kubernetes workspaces read "unsupported" as they do today. | T-MGR |

### Install and packaging (detail in §13)

| ID | Requirement | Verified by |
| --- | --- | --- |
| FR45 | **Static installers** `GET /connect/install.sh` and `install.ps1`: the same bytes for everyone, `ETag` = sha256, viewable, with `PILOT_DRY_RUN`, exit codes `CONNECT_INSTALL_EXIT` and a last line `PILOT_RESULT=…`. POSIX `sh` only (dash and bash `--posix` both run it). | T-STATIC, T-INST |
| FR46 | **Plan.** `GET /connect/v1/plan` (bearer) returns `KEY=value` lines (`CONNECT_PLAN_KEYS`); the scripts read a fixed allowlist of keys with a strict value pattern and never `eval`. `GET /connect/v1/manifest` returns the Kubernetes YAML. | T-INST, T-STATIC |
| FR47 | **Integrity.** Every download is pinned: the agent bundle's sha256 and url come from the plan; the official Node tarball's sha256 is pinned in the portal's build; the pty package is checked against the lockfile's integrity. Nothing runs before its check passes. | T-INST |
| FR48 | **Container kinds** run the agent in the public `node` image from a verified bundle in a volume: no registry for the agent, a restart policy, a read-only root, dropped capabilities for the Docker agent, labels that keep the agent container out of the workspace list. | T-INST |
| FR49 | **Host kind** (Linux) uses the machine's Node 22 or downloads the official one into the user's home, installs the pty package, writes a systemd user unit (or a start script without systemd), needs no root, and asks for the host-access confirmation on the host. | T-INST |
| FR50 | **Kubernetes** installs one manifest: namespace, service account, Role and RoleBinding (namespaced only), enrollment Secret, Deployment (restricted pod security, init container that fetches and verifies the bundle). The installer shows the cluster it would apply to and asks first. | T-INST, T-STATIC |
| FR51 | **Swarm** installs one global service, enrolling each node with a reusable token (20 uses and 60 minutes by default), then removes the token from the service. | T-STATIC, T-MAN |
| FR52 | **Uninstall, upgrade, doctor, status** are subcommands of the same installer (`… \| sh -s -- uninstall`); uninstall asks, never deletes workspaces or volumes with user data unless `--purge`; upgrade needs no token. | T-INST |
| FR53 | **TLS.** `https` only, except loopback and `PORTAL_CONNECT_ALLOW_HTTP`. A private CA is supported with `PILOT_CA` (a PEM file); a proxy with `HTTPS_PROXY`; extra headers with `PILOT_HEADERS`. | T-INST, T-AGENT, T-MAN |
| FR54 | **See it connected.** The installer polls `GET enroll/status` until the node shows as connected (or 120 s) and prints the result; the wizard shows the same live. | T-INST, T-UI |

### Web (detail in §16)

| ID | Requirement | Verified by |
| --- | --- | --- |
| FR55 | **Targets page** (`/admin/targets`): one list, scanned and enrolled, link dots, actions per row, a detail sheet with nodes, settings, events and the commands. | T-UI |
| FR56 | **Add wizard**: kind, system, name, advanced; a command block with Copy and "View script"; live status; expiry and "New command"; "Add node" for Docker and Swarm. | T-UI |
| FR57 | **Workspaces page**: the Targets card becomes one line linking to Targets; New workspace groups targets and offers a node when a cluster has several; `unreachable` is a status with a tone; Singles show as ordinary workspaces. | T-UI |
| FR58 | **Live.** A `connect` live topic refreshes the registry and the wizard without polling. | T-UI |
| FR59 | **Text diet.** No paragraph under a title; explanations in `InfoTip`; one terse visible warning per irreversible act; checked at 390 px and 1280 px, light and dark. | T-UI |

### Operations and safety

| ID | Requirement | Verified by |
| --- | --- | --- |
| FR60 | **Audit.** `connect_events` records lifecycle and admin actions (`CONNECT_EVENT_TYPES`), with the client address, never a secret; 5,000 rows per target; shown in the target's detail. | T-REG, T-SEC |
| FR61 | **Kill switch.** `PORTAL_CONNECT_ENABLED=false` turns the agent-facing routes into 404, refuses tunnels and registers no enrolled runtime; the registry stays readable. | T-REG |
| FR62 | **No silent upgrade.** The portal never asks an agent to replace its code. It says an update exists; a person runs the upgrade command. | T-SEC |
| FR63 | **Backups.** The registry holds hashes and public keys only: a backup or restore needs no key handling, and restoring an old database makes newer nodes `unknown_node` (they re-enroll). `portal rotate-key` and `forget-secrets` don't touch it. | T-REG |

## 9. The tunnel protocol

The wire contract is in the shared file: [`connect.ts`](../../packages/contracts/src/connect.ts) (§7 of that file: handshake messages, `CONNECT_MUX`, `CONNECT_LIMITS`, open request and answer, control messages, close codes, test vectors). This section is the behaviour around it. Both ends are written against the same library, `apps/server/src/connect/tunnel/` (§12.1), with one conformance suite that each end runs.

### 9.1 Connection

| | |
| --- | --- |
| URL | `wss://<portal>/connect/v1/tunnel` (`ws://` only on loopback or with `PORTAL_CONNECT_ALLOW_HTTP`). `connectTunnelUrl(origin)`. |
| Subprotocol | `Sec-WebSocket-Protocol: pilot.tunnel.v1`. A client that doesn't offer it gets 400 at the upgrade. |
| Browsers | An upgrade that carries an `Origin` header is refused (403): agents are not browsers, and no page may act as one. |
| Compression | `permessage-deflate` off on both sides (latency, CPU, and secrets in the stream). `maxPayload` 1 MiB. |
| Messages | TEXT messages only before `welcome` (the handshake); BINARY messages after, one mux frame each. A receiver parses a byte stream and must also accept several frames in one message (an adapter may coalesce). A TEXT message after `welcome`, or a BINARY one before it, is a protocol error. |
| Behind a proxy | Caddy's `reverse_proxy` and Cloudflare tunnels pass WebSockets. The 15-second pings keep idle timeouts (Cloudflare's 100 s) away. nginx needs the `Upgrade` headers and `proxy_read_timeout` above 60 s 📄. Corporate proxies that block WebSockets are not supported in v1 (`doctor` says so). |
| Client address | The last `X-Forwarded-For` entry when `PORTAL_TRUST_PROXY=true` (the same rule as sign-in), else the socket's. |

### 9.2 Handshake

```
Agent                                              Portal
  │ GET /connect/v1/tunnel (Upgrade, subprotocol)    │
  │ ◀──────────────────────────────────── 101 ──────│
  │ ◀── text: challenge {connId, nonce, serverTime, protocol:{min,max}}
  │ ── text: auth {node, sig, hello} ──────────────▶│  sig = Ed25519(connectSignedMessage(connId, nonce, node))
  │ ◀── text: welcome {node, target, portalId, …}   │  or reject {code, message, retryAfterS} + close(CONNECT_CLOSE_OF[code])
  │ ═══════════ binary mux frames ═══════════════════│
  │ opens stream 1: service control ───────────────▶│  portal answers, then sends `config`
```

- The nonce is 32 random bytes, good for this connection and `handshakeMs` (10 s) only. The signed bytes are exactly `claudepilot-connect-v1\n<connId>\n<nonce>\n<node id>`; the test vector in the contract fixes them.
- The portal checks, in this order and with the same cost whichever fails: the first message is `auth` and fits 8 KiB; the node exists and is not revoked (`unknown_node`, `revoked`); its target still exists (`target_removed`); the agent's protocol is accepted (`upgrade_required`); the signature verifies against the node's current key, or the previous key inside the 10-minute rotation grace (`bad_signature`); no healthy connection exists for the node (`already_connected`); the store allows the write of `last_seen` or is read only, in which case the connection is allowed without it. Then `welcome`.
- Before `auth` a socket counts against 5 per client address and 100 in all, and is closed after 10 s of silence. Upgrades are limited to 30 per address per minute. `rate_limited` carries `retryAfterS`.
- The agent compares `welcome.portalId` with the one it pinned at its first welcome (FR18) and refuses a different one.
- The portal's clock is not used for authentication; both clocks are reported (`serverTime`, `hello.clock`) and a difference over two minutes is shown on the node ("clock").

### 9.3 Frames and flow control

The wire format is yamux's (📄 hashicorp/yamux `spec.md`, read for this PRD): a 12-byte big-endian header, version 0, type (DATA 0, WINDOW_UPDATE 1, PING 2, GO_AWAY 3), flags (SYN 1, ACK 2, FIN 4, RST 8), stream id (0 is the session), length (payload bytes, a window delta, a ping value, or a GO_AWAY code). The agent opens odd stream ids and the portal even ones. A Go agent can use the hashicorp/yamux library unchanged. Our parameters are in `CONNECT_LIMITS`; frame headers are fixed by the vectors in the contract.

| Topic | Rule |
| --- | --- |
| Open | The opener sends DATA with SYN and the open-request line; the acceptor answers DATA with ACK and the answer line (`ok`, or `ok:false` with a typed code, then FIN). The opener sends nothing else until the answer arrives. A SYN beyond 256 open streams is answered with RST. |
| Flow control | Each stream's receive window starts at 262,144 bytes. Only DATA counts. A receiver sends a WINDOW_UPDATE for what it has delivered to the application once that reaches 131,072. A sender never exceeds the peer's window; a frame that does is a protocol error. |
| Frame size | Senders write DATA in frames of at most 65,536 bytes; a receiver treats a larger length as a protocol error (so a sender bug shows in the suite, not in production). |
| Half-close | FIN ends one direction. A stream is closed when both sides sent FIN. Data after FIN is answered with RST. RST ends the stream now and discards what is queued. |
| Scheduling | Control frames (WINDOW_UPDATE, PING, FIN, RST, GO_AWAY) go first. DATA is drained round-robin over the streams that have some, one frame each. Frames are handed to the socket only while the bytes already given to `ws.send` and not yet written out (`bufferedAmount`, or the bytes of `send` calls whose callback hasn't fired) are under 131,072, and resume under 32,768. This keeps the queue a keystroke waits in to about 128 KiB; the kernel's own send buffer adds to it on a saturated uplink, which the budget in §19.6 measures (Q7). |
| Ping | Both sides send a PING with SYN and an opaque value every 15 seconds; the peer answers a PING with ACK and the same value; the round trip is the node's `rttMs`. Nothing received for 45 seconds ends the connection (WebSocket close 1011, then the usual reconnect). |
| GO_AWAY | Sent before a graceful close: the sender opens no more streams, existing ones finish. Code 0 normal, 1 protocol error, 2 internal error. The agent also sends `bye` on `control` first. |
| Protocol errors | A wrong version byte, unknown type, id of the wrong parity or reused, window overflow, oversize length, data on a closed stream: GO_AWAY(1), close 1002, a log line without payload. |
| Idle | `docker` and `kube` streams with no request in flight are closed after 60 seconds by the agent (the portal's HTTP agent keeps sockets 30 s); `host` streams live as long as their process; `control` lives with the connection. |

### 9.4 Stream open

`ConnectOpenRequest` is one JSON line (`\n`-terminated, at most 16 KiB): `{ "v":1, "service":"docker", "trace":"a1b2c3d4" }`. The answer is one line: `{ "v":1, "ok":true }` or `{ "v":1, "ok":false, "code":"denied", "message":"…" }`. After `ok` the stream's meaning depends on the service (§9.5).

| Code | Meaning |
| --- | --- |
| `bad_open` | Not JSON, wrong `v`, unknown or unexpected service (the agent opening anything but `control`; the portal opening `control`). |
| `service_unavailable` | The agent doesn't offer it, or it is down (`docker` with no socket access, `host` with no pty for a terminal). |
| `busy` | The service's stream cap (docker 64, kube 64, host 32) is reached. |
| `denied` | Refused by policy (a `host` op the agent's mode doesn't allow). Docker and kube policy denials are HTTP 403 answers inside the stream instead (they need a normal HTTP error for the client library). |
| `upstream_unreachable` | The agent can't reach the Docker socket or API server. |
| `timeout`, `internal` | What they say. |

### 9.5 Services

| Service | Opened by | After `ok` |
| --- | --- | --- |
| `control` | the agent, once, right after `welcome` (stream 1) | JSON lines both ways: agent → portal `status`, `log`, `rekey`, `bye`; portal → agent `config`, `rekey-answer`, `notice`, `revoked`. At most one line per 2 s of `status`, 20 `log` a minute; a line over 256 KiB or malformed JSON closes the stream and the connection. Unknown message types are ignored once logged. |
| `docker` | the portal, one stream per HTTP connection | Raw HTTP/1.1 to the Docker Engine API, exactly as to a socket, including `Upgrade: tcp` for exec and attach. The agent's policy proxy is the server end. |
| `kube` | the portal's loopback listener, one stream per accepted connection | Raw HTTP/1.1 to the Kubernetes API (and WebSocket upgrades for exec). The agent's kube proxy is the server end. |
| `host` | the portal, one stream per operation | Records (`CONNECT_HOST_RECORD`): `[kind u8][length u32 BE][payload]`. Ops `exec`, `put`, `read` (`ConnectHostOpen`). `RESULT` is always the last record. A reset stream kills the process (SIGHUP to a terminal's process group, SIGTERM then SIGKILL after 5 s otherwise). |
| `tcp` | reserved, not accepted in v1 | A later service for web previews and the browser pool. |

### 9.6 Reconnect and what a drop means

The agent reconnects forever: full-jitter exponential backoff from 1 s to 60 s, reset after a connection held for 30 s, `retryAfterS` honoured. After a fatal rejection (`unknown_node`, `revoked`, `target_removed`, `upgrade_required`, `portal_mismatch`) it logs loudly and waits an hour between tries, and never exits (a restart policy would loop). A drop closes every stream with RST on both sides; nothing is replayed. The portal marks the node offline, audits it, and every runtime call in flight fails with a `ConnectError('agent_offline')`, which the adapters turn into the errors in §12.5. A restarting portal sees every agent return within about a minute (jitter spreads them).

### 9.7 Versioning

`CONNECT_PROTOCOL` is bumped for a wire change an old peer can't ignore. New JSON fields and new control message types are additive and ignored by older peers; a new host record kind or a new frame type is a protocol bump. The portal accepts `CONNECT_PROTOCOL_MIN` to `CONNECT_PROTOCOL`; v1 has both at 1. The agent speaks one version. When a protocol bump ships, the portal keeps accepting the previous one for at least one release and shows "update" on those nodes. The agent build (`agentBuild`, first 12 hex of the bundle's sha256) is informational: a different build is "outdated", nothing more.

## 10. Enrollment and credential lifecycle

### 10.1 The token

| | |
| --- | --- |
| Form | `cpen_` + 43 base64url characters (256 bits). `isConnectToken`. |
| At rest | Only SHA-256, a 4-character tail for lists. Unique index on the hash. |
| Lifetime | Default 15 minutes, clusters 60, maximum 24 hours, set in the wizard (Advanced) or `connect.tokenTtlMinutes`. |
| Uses | 1; clusters up to 50 (Swarm defaults to 20 uses and 60 minutes, because every node of the swarm enrolls with the one token). |
| States | `waiting` → `used` (uses reached) → (`expired` by time); `revoked` by the admin at any time. A used or expired token can't enroll. |
| Where it travels | The `Authorization: Bearer` header of `plan`, `manifest`, `enroll` and `enroll/status`; the `PILOT_TOKEN` variable of the command; on a host, passed to the agent on stdin, never an argument; in Kubernetes inside a Secret. Never in a URL, an argument, a log, an audit row, an error body, the process list or `docker inspect` (the installer passes it to containers on stdin; Swarm's service environment is the one exception, for the hour the token lives, and the installer removes it afterwards). |
| Seen again | Never. The wizard keeps the command only in the browser while the dialog is open; "Show command" later makes a new token (the old stays valid until it expires or is revoked). |

### 10.2 Enrollment, step by step

1. `POST /api/connect/targets` (admin): validates (`kind`, `platform`, `id`, options, `portalUrl` with `connectOriginProblem`, `hostAccess` for `host`), inserts a *pending* target and an enrollment, audits `target.created` and `enrollment.created`, returns `ConnectEnrollmentCreated`.
2. `GET /connect/v1/plan` (bearer): finds the token by hash; refuses an unknown, expired or revoked one (a used-up one too: it is for `enroll/status` only). Returns the plan, uses nothing.
3. `POST /connect/v1/enroll` (bearer, `ConnectEnrollRequest`): in one transaction, checks the token again, the key (32 bytes that form a valid Ed25519 public key), the hello (its `mode` equals the target's kind), that a single has no active node, makes a unique node name, inserts the node, adds a use, turns the target `active`, audits `node.enrolled` and `enrollment.used` with the client address. Returns `ConnectEnrollResult`.
4. The agent writes `identity.json` (mode 0600) and `agent.json`, then connects (§9.2). The first `welcome` pins the portal id.
5. `GET /connect/v1/enroll/status` (bearer) answers `waiting`, `enrolled` (a node exists, not connected), `connected`, `expired` or `revoked`, for 30 minutes after the last use.

Refusals are normal API errors with `error.details.reason` from `CONNECT_ENROLL_REASONS`: 401 `token_invalid` | `token_expired` | `token_used` | `token_revoked`; 409 `target_enrolled` | `name_taken`; 422 `bad_key`; 422 `insecure_url`; 503 `store_locked`; 429 after ten wrong tokens in ten minutes from one address (the sign-in `RateLimiter`).

### 10.3 What the agent keeps

| File (Host: `~/.claudepilot/agent/`, containers: the state volume at `/var/lib/claudepilot-agent/`) | Content |
| --- | --- |
| `identity.json`, mode 0600 | `{ node, target, portalUrl, portalId, privateKey (PKCS8 DER, base64url), publicKey, enrolledAt }`. |
| `agent.json` | `{ url, mode, images[], namespace?, dockerSocket?, nodeName?, services?, home?, docker?: { allowImages?, allowBinds? } }`: configuration with no secret, written by the installer; `docker.*` is the host operator's local widening of the policy (appendix A). |
| `bundle/<build>/agent.mjs` | Verified bundles; the newest verified one runs; the previous stays for a manual rollback. |

A Single *container* keeps its identity in a volume the workspace doesn't mount, but the workspace user can read it (`sudo` is passwordless in the image); the threat model says so (§17).

### 10.4 Rotation

An admin presses "Rotate key" on a connected node (`POST /api/connect/nodes/:id/rotate`, 202; 409 when offline). The portal sends `notice{action:'rotate'}`. The agent writes `identity.next.json` with a new key pair, sends `rekey{publicKey, sig}` signed with the OLD key (`connectRekeyMessage`), and waits for `rekey-answer{ok:true}`; the portal verified the signature, stored the new key, kept the old one as `prev_public_key` for 10 minutes and audited `node.rotated`. The agent then moves `identity.next.json` over `identity.json`. A crash anywhere leaves a state in which either key authenticates for ten minutes; a successful authentication with the new key drops the old. A failed rotation audits `node.rotation_failed` and changes nothing. The fingerprint changes and shows on both sides.

### 10.5 Revocation, removal, loss

- **Revoke a node:** `revoked_at` is set, a `revoked` control message is sent, the tunnel closes with 4401, running streams are reset. The agent's next tries get `revoked` and it waits an hour between them. Its host still has the workspaces (a Single's workspace shows unreachable).
- **Revoke a token:** it stops working at once; a node already enrolled with it is unaffected.
- **Remove a target:** FR9. Nodes are revoked; agents get `target_removed`.
- **A lost or wiped agent:** make a new enrollment on the same target ("Command" in its detail); a Single needs its old node revoked first.
- **Uninstall on the host:** the installer's `uninstall` stops the agent (it sends `bye` with `uninstall`); the target shows offline until an admin removes it. Uninstall does not talk to the portal with any credential.

### 10.6 Docker and Swarm "Add node"

A Docker cluster grows by another enrollment: Targets → the target → Add node makes a token for the same target (`maxUses` 1) and the same command; the second host enrolls as a second node. Swarm enrolls every node with one reusable token. Node names are unique within a target (`-2` is appended). Placement (§12.8) considers every connected node that is not drained.

## 11. The agent

### 11.1 What it is

`pilot-agent` is one ES module, `agent.mjs`, built by esbuild from `apps/server/src/connect/agent/` and `apps/server/src/connect/tunnel/` (the same tunnel library the portal uses), generated into `apps/server/src/connect/agent.generated.ts` (a string constant, like `cp-ci`; a test keeps it equal to the source) so it rides inside the server's own bundle: no Dockerfile change, no new npm workspace (§22). Node 22.13 or newer runs it. Bundled: `ws` (its optional native add-ons are not) and `tar-stream`. Not bundled: `@lydell/node-pty`, loaded at run time from `<dir>/node_modules` when present (a Host and a Container need it for terminals; a Docker or Kubernetes agent doesn't). A test builds the bundle and fails if it imports anything outside `node:*`, `ws`, `tar-stream` and `@portal/contracts` (types and constants only).

**Multi-user.** The agent is a platform component, not a user feature: its identity (the Ed25519 key) and the enrollment token are not users, and nothing in its logs or messages names a person (they say a node id, a rule id or an address). Who may use a target is the portal's concern and is bound to users there later; no assumption of "one person" lives in the agent.

### 11.2 Modes and what each offers

| `PILOT_MODE` | Services | Runs as | Notes |
| --- | --- | --- | --- |
| `docker`, `swarm` | `docker` | root in a hardened container (read-only root, `--cap-drop ALL`, no new privileges) with the Docker socket | Never offers `host`. |
| `kubernetes` | `kube` | uid 65534 in a pod with a restricted security context | Reaches the API server with its service account. |
| `container` | `host` | root in the workspace container, spawning commands as `node` | No Docker socket. HOME is the workspace home volume. |
| `host` | `host` | the installing user | HOME is that user's home; paths are mapped like This machine (§11.6). |

### 11.3 CLI

`pilot-agent run` (default) · `enroll [--token-stdin]` · `doctor [--json]` · `identity` (prints node id and fingerprint) · `version`. Configuration comes from `agent.json` and the environment (`CONNECT_AGENT_ENV` in the contract: `PILOT_URL`, `PILOT_MODE`, `PILOT_DATA_DIR`, `PILOT_DOCKER_SOCKET`, `PILOT_IMAGES`, `PILOT_KUBE_NAMESPACE`, `PILOT_NODE_NAME`, `PILOT_CA`, `PILOT_HEADERS`, `PILOT_LOG_LEVEL`, `PILOT_HOME`, and for Kubernetes and Swarm `PILOT_ENROLL_TOKEN`, `PILOT_IDENTITY_SECRET`, `PILOT_BUNDLE_URL`, `PILOT_BUNDLE_SHA256`; plus `HTTPS_PROXY` and `NO_PROXY`). Proxies: observed on this sandbox's Node 22.23.3 ✅ that `NODE_USE_ENV_PROXY=1` makes global `fetch` and the global `WebSocket` honour `HTTPS_PROXY`, but `ws` (which uses the `https` module) ignores it and connects directly. So the agent gives `ws` an `https.Agent` that performs the CONNECT itself (about 30 lines: `HTTPS_PROXY`, `NO_PROXY`, credentials in the proxy's URL) and uses the same agent for its enrollment request. A test with a local CONNECT proxy proves it (T-AGENT).

### 11.4 The Docker service: a policy proxy

Each `docker` stream is the server side of an HTTP connection: the agent feeds the stream to a Node `http.Server` (`server.emit('connection', socket)` with the same `net.Socket` stubs the portal's side needs; tried on a `duplexPair` ✅: keep-alive over one connection, a 3 MB chunked POST, a 20 MB streamed response with backpressure, and an `Upgrade` answered with 101 and then raw bytes all worked), and for each request it **parses, decides, and re-issues a fresh request** to the Docker socket. Nothing is passed through as raw bytes, so there is one parser (Node's) and no smuggling between two (a conflicting `Content-Length`/`Transfer-Encoding`, an absolute-form target, a second request hidden in a body). Hijacked exchanges (`Upgrade: tcp` on `exec/{id}/start`) are allowed only on that path: the proxy forwards the upgrade, writes the 101, and then pipes both ways.

- **Decision per request** (appendix A): method and normalized path (an optional `/vN.NN` prefix removed, `//` and `..` and percent-encodings that change the path are denied) matched against a table; for containers the proxy resolves the reference once (`GET /containers/{ref}/json`, cached for 2 s), requires the labels `claudepilot.managed=true` and, when the agent knows the portal's id, `claudepilot.portal=<id>`, and forwards the **full container id** so the checked container is the one acted on; `list` and `events` get the label filters forced in; `create` is validated against a strict allowlist schema (a field the schema doesn't know is a denial: new Docker features are denied until someone reviews them); exec ids are tracked from the creating call; volumes and images by name pattern or allowlisted reference.
- **Denial**: HTTP 403 with a Docker-shaped body `{"message":"denied by claudepilot policy (create.privileged)"}`, a counter per rule in `status.denied`, and at most one `policy.denied` audit event per rule per ten minutes.
- **Owner of the policy**: the host operator. The allowlisted images (`PILOT_IMAGES`, from the plan at install time, in `agent.json`) and any widening (`docker.allowBinds`, a path list, empty by default) are local. The portal's `config` message can only lower caps. There is no `full` profile in v1; it is reserved as a flag a person would set on the host.
- **Limits**: JSON bodies up to 1 MiB are read and checked; archives (`PUT /containers/{id}/archive`) are streamed and never buffered; at most 64 streams; a request header block over 16 KiB is refused.
- **Not offered**: builds, networks, swarm and service APIs, plugins, system prune, image listing, container logs of other containers, anything on a container the policy can't prove managed.

### 11.5 The Kubernetes service

Each `kube` stream is the server side of an HTTP connection to a proxy that forwards to `https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT` with the pod's CA (`/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`) and verification on. The proxy:

- requires `Authorization: Bearer <kubeLocalToken>`, the per-connection value from `config` (so another process on the portal's machine that finds the loopback port can't use the connector), then **drops** that header, every `Impersonate-*` and `X-Remote-*` header, and sets the service account's token, re-read from its file at most every 60 seconds (bound tokens rotate);
- allows only the paths and verbs of appendix B (the connector's namespace, a fixed list of resources; no cluster-scoped paths, no other namespace; secrets only by the names foundation F3 uses, `ws-*-claudepilot`); adds `labelSelector=claudepilot.managed=true` to list and watch calls on pods, deployments and claims; passes WebSocket upgrades for `pods/exec` with their channel subprotocols;
- streams bodies and responses (watches, exec) without buffering, with the same 16 KiB header and 1 MiB JSON-body limits.

RBAC is the second wall: the Role grants only those resources in that namespace (§13.5). The proxy is defence in depth for a portal or loopback process that asks for more.

### 11.6 The host service

The agent embeds the logic `LocalRuntime` has today, moved into a shared module (§12.7), behind the `host` ops:

| Op | Behaviour |
| --- | --- |
| `exec` | Spawns `argv` as the workspace user (a Container: uid and gid of `node` looked up at start; a Host: the agent's user; `user: 'root'` is root in a Container and ignored on a Host) with the environment `LocalRuntime.userEnv()` builds plus `env`. Pipes, or a pty (node-pty; `tty` gives the size; `RESIZE` records resize it). stdout and stderr are `DATA`/`STDERR` records of at most 64 KiB, written only while the stream accepts data (the child's output is paused otherwise: the window is the backpressure). Ends with one `RESULT`. Kill: see §9.5. |
| `put` | The portal streams a tar archive; the agent extracts each file and directory with its owner and mode (owner only when it is root), under the path mapping, refusing anything that would leave the mapped root (`..`, absolute links, symlinks and hard links are skipped and reported). `RESULT` says what failed. |
| `read` | One regular file, at most `maxBytes` (default 8 MiB): `DATA` records, `EOF`, `RESULT`; `ENOENT` answers `RESULT.error`, never an exception. |

**Path mapping (Host):** `/home/node` → the user's home, `/etc/claudepilot` → `~/.claudepilot/host`, anything else as it is: the same as This machine. A Container maps nothing.

**Usage:** a Host samples CPU like `LocalRuntime`; a Container reads its cgroup (`cpu.stat`, `memory.current`, `memory.max`) and falls back to `os`.

### 11.7 Status, logs, limits

`status` carries each service's health, host usage, Docker info, the swarm role, denied counts and open streams (`ConnectStatusMessage`). The agent logs plain lines to stdout (containers) or `~/.claudepilot/agent/logs/agent.log` (host, five files of 5 MB): connects, disconnects, enrollment, policy denials by rule, errors with the portal's message. It never logs an argv, an environment, a file name from a `put`, any content, a token or a key; a canary test runs every service with canary values and fails on a match anywhere in its output. Warnings and errors also go to the portal as `log` messages (at most 20 a minute). Memory target: under 100 MB resident when idle. An uncaught error logs and exits 1 (the restart policy restarts it), except a fatal rejection, which sleeps.

### 11.8 Doctor

`pilot-agent doctor` and the installer run the checks of `CONNECT_DOCTOR_CHECKS` in the same vocabulary: DNS, TCP and TLS to the portal (with the CA given), `GET /connect/v1/health`, a WebSocket upgrade, whether a proxy is in use, the clock against the portal's `Date`, the identity file's mode and fingerprint, the Docker socket's access and API version, a policy self-test (a denied create must be denied), Kubernetes access and the RBAC verbs (`SelfSubjectAccessReview`), the host's tools (`tmux`, `git`, `bash`; macOS `jq`, `flock`, `setsid`), a pty, and free disk. Each failed check names what to do in one line.

## 12. Server integration

### 12.1 Modules and files

```
apps/server/src/connect/
  index.ts          createConnect(deps): ConnectModule            T1   attach(server, portal), routes(), publicRoutes(), runtimes, hooks
  seams.ts          NodeLink, RuntimeFactory, EnrollmentLookup, … (§12.1.1)  T1 writes it first, verbatim from appendix E
  tunnel/           frame.ts mux.ts stream.ts lines.ts records.ts auth.ts conformance.ts   T1 (shared with the agent)
  store.ts registry.ts enrollment.ts hub.ts events.ts settings.ts        T1
  routes.ts         admin routes (/api/connect)                      T1
  publicRoutes.ts   /connect/v1/health, enroll, enroll/status, tunnel; mounts T4's install routes   T1
  install/          routes.ts plan.ts manifest.ts scripts/ (install.sh, install.ps1) installers.generated.ts node-manifest.json   T4
  agent/            main.ts identity.ts client.ts control.ts services/{docker,kube,host}/ doctor.ts build.ts   T2
  agent.generated.ts                                                T2 (generated)
apps/server/src/workspaces/connect/                                 T3   factory.ts tunnelAgent.ts dockerCluster.ts kube.ts kubeLoopback.ts host.ts
apps/web/src/features/targets/                                      T5
tools/connect/   (rig, host images, acceptance runner) and apps/server/src/connect/qa/   T6
```

As built (T1), beside the files above: `admin.ts` (one method per admin route, each taking the Actor; `routes.ts` is thin), `runtimes.ts` (the enrolled targets' runtimes follow the registry; `bind`, `settled`, `canCreate`, `onReturned`), `authz.ts` (the `target` resolver for enrolled and scanned ids, `declarePolicies` for every route), `validate.ts`, `tokens.ts`, `agentText.ts` (everything an agent says is cleaned here), `config.ts`, `bundle.ts` (T2's generated constants), `installPort.ts` (T4's package behind one interface), `testkit.ts` and `qa/stubAgent.ts` (test support); in `tunnel/` also `open.ts` (the stream open handshake, both ends), `ws.ts` (the adapter and `dialTunnel`), `memory.ts` (a memory pair for tests) and `index.ts` (a barrel). The agent-facing routes have full `/connect/...` paths and are mounted at the root by `app.ts`, not at `/connect`.

Wiring in `index.ts` (surgical, T1 and T3 together): the static runtimes are built as today; then `const connect = createConnect({ store, config: config.connect, log })`, `connect.useRuntimeFactory(createTunnelRuntime)` (T3's), `connect.bind(workspaces)` (adds, replaces and removes runtimes as the registry changes; each new runtime's `watch` is wired by the manager itself, not by `index.ts`), `connect.attach(server, portal)` before `attachShell`, `createApp(…, { connect })` mounting `connect.routes()` under `/api/connect` behind the session guard and `connect.publicRoutes()` at `/connect` with none. In dev, `index.ts`'s request dispatcher must send `/connect/` to Hono (it sends `/api/`, `/healthz`, `/mcp` today; anything else goes to Vite).

#### 12.1.1 Seams (the interfaces the packages build against; text in appendix E)

`NodeLink` (one per node: `connected()`, `open(service, args?)` returning a stream shaped like a socket, `info()`, `onChange`, `kubeToken()`), `RuntimeDeps` (what a runtime needs from the registry: the portal id, the image, snapshots, a single's switch), `RuntimeFactory` and `ConnectModuleApi.useRuntimeFactory` so T1 never imports T3's code, `ConnectModuleApi` (`bind`, `settled`, `canCreate`, `onReturned`), and for T4 `EnrollmentLookup` and `InstallDeps`.

### 12.2 Contract additions to the existing files

Applied atomically by the package that needs them, in the same change as the code that uses them (an exhaustive map in `WorkspacesPage.tsx` breaks the web build the moment `WorkspaceStatus` grows):

```ts
// packages/contracts/src/workspace.ts
export type WorkspaceStatus = 'creating' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error' | 'unreachable';
// WorkspaceTarget: source?: 'scanned' | 'enrolled'; role?: 'cluster' | 'single';
//   nodes?: { id: string; name: string; connected: boolean; drained: boolean }[];   // enrolled clusters
// Workspace: node?: string;  lastSeenAt?: string;      // lastSeenAt on an unreachable one
// CreateWorkspaceRequest: node?: string;
// packages/contracts/src/live.ts: LiveTopic and LIVE_TOPICS gain 'connect'; LiveMessage gains { type: 'connect' } ("load again").
```

`Runtime` (server, `workspaces/runtime.ts`) gains optional members: `portalUrl?: string` (where a workspace here reaches the portal), `listLastKnown?(): Workspace[]` (the stored snapshot), and `CreateSpec.node?: string`.

### 12.3 Docker over the tunnel (T3)

`DockerRuntime` already takes a `Docker` client. A tunnel runtime hands it one built as `new Docker({ protocol: 'http', host: 'tunnel.invalid', port: 2375, agent: new TunnelAgent(link) })`, where `TunnelAgent extends http.Agent` and its `createConnection(options, cb)` opens a `docker` stream and calls `cb(null, socket)`. The socket is a `Duplex` with the `net.Socket` methods the HTTP stack calls on a pooled connection (`setKeepAlive`, `setNoDelay`, `setTimeout`, `ref`, `unref`) ✅. docker-modem's own SSH transport does the same thing with an SSH channel. Changes inside `docker.ts` (surgical): `check()` asks an injected `reach()` instead of `existsSync(socket)`; the image step pulls by reference and never builds when the runtime is tunnelled; `where` is `lab-box (docker 28.1)`. Everything else is untouched: `exec` and `shell` hijack over a stream (✅ exec with stdin), `putArchive`/`getArchive` stream, `getEvents` is one long stream that reconnects itself.

### 12.4 Clusters, Swarm and placement (T3)

`ConnectDockerRuntime` wraps one `DockerRuntime` per connected node (all over the same factory). `list()` is the union with `node` set on each workspace; a workspace's name→node map is rebuilt on every list and on a miss; `create` takes `spec.node` or picks the connected, undrained node with the fewest workspaces (ties: most cores); a name already used on any node, or on an offline node's snapshot, is refused (409); `start`, `stop`, `remove`, `exec`, `shell`, `usage` and delivery go to the node that has it. `maxWorkspaces` is enforced at create across all nodes (409 `LIMIT_REACHED`). Workspaces never move between nodes; a node that is gone takes its workspaces' state with it (the volume is local): the node's detail says so.

### 12.5 When the tunnel drops

The rule (FR37, FR39): **an outage is not a state change.** Every dependant below keeps its state and recovers on its own.

| Dependant | Today | Required for an enrolled target |
| --- | --- | --- |
| The workspace list | Targets that aren't available are skipped | The runtime's `listLastKnown()` is served, each workspace `status: 'unreachable'`, `detail: 'Last seen 4 min ago'`, `lastSeenAt` set. A single shows its one workspace. |
| Chat readers (`#checkAndRetail`, `#scheduleRetail`) | After a few failed retries a session is marked gone ("Lost touch") and Interrupted, resumable by a second Claude process | While the target is down the retry counter does not advance and nothing is marked gone. When the node returns the reader re-follows from its stored byte offset. `ChatController` gets `targetState?: (workspaceId) => 'up' \| 'down'` and `targetReturned(targetId)`, wired from the hub's `onChange` (T3, surgical edit in `chat/controller.ts`). Claude Code keeps running inside the workspace meanwhile. |
| Delivery (`Reconciler`) | An error becomes `failed` with backoff | A `TargetUnreachableError` (new, `workspaces/runtime.ts`) becomes `pending` with reason "Target unreachable"; the hub's return calls `reconciler.request(workspace, 'target returned')`. Never `failed`, never `frozen`. |
| Outbox pull, CI polling, Claude usage probes, terminals list | Errors are caught and logged | Same, but logged once per outage, not per poll; probes skip `unreachable` workspaces. T3 audits each and adds a test with a runtime that throws. |
| Starting a workspace, creating, exec, shell, put | 503 with the runtime's text | 503 "Target unreachable (since 14:02)". |
| `Workspaces.resume()` after a portal restart | Decides at once | Waits up to 20 s for enrolled targets' first connection (`connect.settled(20_000)`) before judging a pending create (FR38). |

### 12.6 Kubernetes over the tunnel (T3)

`KubernetesRuntime` builds its `KubeConfig` with `loadFromDefault()` today. It gets an optional constructor argument, a ready `KubeConfig`, and `manageNamespace: false` (the manifest created the namespace, and a namespaced Role can't create one: authorization precedes existence, so the current `createNamespace(...).catch(ignore(409))` would fail with 403). For a tunnelled target the portal listens on `127.0.0.1:0` (never `0.0.0.0`), one listener per connected connector; each accepted connection opens a `kube` stream; the `KubeConfig` is `loadFromOptions({ clusters: [{ server: 'http://127.0.0.1:<port>', skipTLSVerify: true }], users: [{ token: <kubeLocalToken> }] })` ✅. The listener closes with the connection and a new port and token come with the next. `metrics.k8s.io` and `exec` work as they do against a real API server.

### 12.7 The Host runtime (T3), and sharing `LocalRuntime`'s logic (T2)

`HostRuntime implements Runtime` with `LocalRuntime`'s state machine (a switch the portal keeps: stopping refuses shells and commands, starting accepts them; `create` and `remove` refuse as This machine does) and the tunnel as its executor:

| `Runtime` / `DeliveryAccess` | Over the tunnel |
| --- | --- |
| `check()` | The node is connected and its `host` service reports ok (a `ping` stream is not needed: the status says). |
| `list()` | One workspace `<id>/<id>`: image `<hostname> (host)` or the container image, `running`/`stopped` from the switch, `unreachable` when the node is offline. |
| `start`/`stop` | The switch (`settings.running`), then the manager's usual hooks (a stop ends the workspace's chat sessions first). |
| `exec(name, argv)` | `host` stream, op `exec`, no tty; `ExecSession` over the records. |
| `shell(name, size, command)` | op `exec` with `tty`; `resize` sends `RESIZE`. |
| `delivery.run(script, {user, stdin, timeoutMs})` | op `exec` of `sh -c script`, stdin from the option; the timeout is the portal's. |
| `delivery.put(entries)` | op `put`, the tar the Docker adapter builds (`tarOf`, which T3 moves from `docker.ts` to a shared helper). |
| `delivery.read(path)` | op `read`. |
| `delivery.watchStarts` | Fires on every (re)connect of the node and on `start`. |
| `usage(names)` | The last `status.usage`. |

To avoid two copies of the same spawning, pty, path-mapping and file-writing code, T2 first moves `LocalRuntime`'s private helpers (`hostPath`, `userEnv`, `sample`, `writeEntry`, the pty loader) into `apps/server/src/workspaces/hostexec.ts`, which `local.ts` imports and the agent bundles; `local.test.ts` must stay green. `local.ts` otherwise does not change.

### 12.8 Names, placement, quotas

A single's workspace is `<id>/<id>`. A cluster's `CreateWorkspaceRequest.node` is optional; the New workspace dialog shows a Node select only for a cluster with more than one node. `maxWorkspaces` and `drained` are enforced in `Workspaces.create` through `hooks.beforeCreate` (T1 provides `connect.canCreate(target, node?)`; T3 wires it).

### 12.9 How a workspace reaches the portal

`portalmcp/internalUrl.ts` works the portal's address out from the target's kind: `local` is `127.0.0.1`, `docker` is the container's default gateway. Both are wrong for a remote target. A tunnelled runtime sets `portalUrl` (the target's portal address) and `derive` returns `<portalUrl>/mcp` when it is set (T3, surgical). The workspace is on the same host or network as the agent, so it reaches the same address. Agent tokens for Portal MCP are an opt-in that already calls back (portal-mcp PRD §11 and §12.6); nothing else calls back.

### 12.10 Image provisioning

The installer makes the workspace image exist on the host: `docker pull <PORTAL_CONNECT_WORKSPACE_IMAGE>` (default `ghcr.io/alfianisnan26/claudepilot-workspace:latest`, the image the Kubernetes target already pulls), or with `PILOT_BUILD_IMAGE=1` a build from the portal's context (`GET /connect/v1/image/workspace/context.tgz`: the Dockerfile and `cp-session`, as `DockerRuntime` builds locally). The runtime on a tunnelled target never builds: if the image is missing it pulls the allowlisted reference through the proxy (that is also how "Update Claude Code" works there). A private registry is a host-side `docker login` (the agent has no registry credentials).

**Multi-user (runtime side).** Creating a workspace on any target calls `requireCan(actor, 'operate', target)` (single-owner today: the owner may); the actor comes from the route (`actorOf(c)`). The runtimes themselves hold no user: who may use a target or a node is decided before the call, by the `target` resolver Connect owns. Jobs that touch remote workspaces (delivery, outbox, chat readers) act as they do on local targets.

## 13. Packaging and the install scripts

### 13.1 Principles

1. **Static installers, a per-token plan.** `install.sh` (POSIX `sh`: dash, bash `--posix` and macOS's `/bin/sh` all run it) and `install.ps1` are the same bytes for every enrollment. Everything that varies comes from the plan (`GET /connect/v1/plan`, bearer): `KEY=value` lines, read through a fixed allowlist with a strict value pattern, never `eval`ed. A reviewer reads two files once; a test suite covers them; the wizard shows their sha256.
2. **The agent comes from the portal, pinned.** Download, check the sha256 from the plan, only then run. The official Node tarball (Host kind only) and the pty package are pinned too (§13.4). No registry is needed for the agent, only the public `node` image for containers.
3. **User space where possible; no surprise `sudo`.** The Host kind never needs root. Docker kinds need access to the Docker socket; when it is denied the installer says so and prints the same command with `sudo env`. It never runs `sudo` itself.
4. **Say before doing.** The installer prints each command it runs (token masked), supports `PILOT_DRY_RUN=1` (prints the plan and the commands, changes nothing), asks for confirmation where something is irreversible or broad (Host access, applying to a Kubernetes context) from `/dev/tty`, and takes `PILOT_YES=1` for automation.
5. **Idempotent.** Running it again repairs or refreshes: an agent already installed at the same build is left alone and the installer waits for it to connect; a different build is upgraded. A used token on an already enrolled machine says so and continues with the identity it has.
6. **Readable results.** Exit codes `CONNECT_INSTALL_EXIT` (10 preflight, 11 portal unreachable, 12 token rejected, 13 download or checksum, 14 install, 15 installed but not connected in time, 20 declined) and a last line `PILOT_RESULT=connected|installed|failed|dry-run` (and `removed` after `uninstall`, `ok` after `doctor` or `status`).
7. **Never leaks the token.** It is read from `PILOT_TOKEN`, sent as an `Authorization` header through `curl --config -` (not an argument) or `Invoke-RestMethod -Headers`, handed to containers and the agent on stdin, and never printed, even with `PILOT_DEBUG=1` or `set -x` (the script turns tracing off around it).

### 13.2 The commands the wizard shows

```
# Linux, macOS
curl -fsSL https://pilot.example.com/connect/install.sh | PILOT_URL=https://pilot.example.com PILOT_TOKEN=cpen_… sh

# Linux Docker kinds when the Docker socket needs root ("Run with sudo")
curl -fsSL https://pilot.example.com/connect/install.sh | sudo env PILOT_URL=https://pilot.example.com PILOT_TOKEN=cpen_… sh

# Windows PowerShell
$env:PILOT_URL='https://pilot.example.com'; $env:PILOT_TOKEN='cpen_…'; irm https://pilot.example.com/connect/install.ps1 | iex

# "Verify first": download, compare the sha256 the wizard shows, run
curl -fsSL https://pilot.example.com/connect/install.sh -o pilot-install.sh && echo "<sha256>  pilot-install.sh" | sha256sum -c - && PILOT_URL=… PILOT_TOKEN=… sh pilot-install.sh
```

`upgrade`, `uninstall`, `doctor` and `status` use the same script without a token: `… | sh -s -- uninstall` (PowerShell: `& ([scriptblock]::Create((irm …/install.ps1))) uninstall`). A private CA adds a first line that writes the portal's CA certificate (public) to a file and points `curl --cacert` and `PILOT_CA` at it.

### 13.3 What each kind installs

| Kind | Installs | Where state lives | Kept running by | Uninstall removes |
| --- | --- | --- | --- | --- |
| **Docker** | Container `claudepilot-agent-<id>` from the public `node` image (`PILOT_NODE_IMAGE`, default `node:22-bookworm-slim`), running the verified bundle from its state volume. A one-shot container with the same volume first fetches and verifies the bundle and enrolls (the token goes in on stdin). Flags: `--restart unless-stopped --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --memory 256m --pids-limit 256`, the Docker socket bind-mounted, label `claudepilot.connect=agent` (never `claudepilot.managed`, so it is not a workspace and the policy hides it from the portal). `--security-opt label=disable` when SELinux enforces. | Volume `claudepilot-agent-<id>` (identity, bundle cache) | Docker's restart policy | The container; the volume only with `--purge`. Workspaces stay. |
| **Swarm** | The same agent as `docker service create --mode global` named `claudepilot-agent-<id>`, the socket and a state volume mounted, `PILOT_NODE_NAME={{.Node.Hostname}}`, the reusable token as an environment variable until the installer removes it (`docker service update --env-rm`), run on a manager. Each node pulls the public image and enrolls itself. | A volume per node | Swarm | The service; volumes with `--purge`. |
| **Kubernetes** | One manifest, §13.5. Objects carry `app.kubernetes.io/part-of=claudepilot-connect` and `claudepilot.connect/target=<id>`. | A Secret `claudepilot-agent-identity` written by the agent | The Deployment | The Deployment, service account, Role, RoleBinding and the two Secrets by label. Never the namespace, the workspaces or their claims. |
| **Container** | The workspace image (pulled, or built from the portal's context) as container `claudepilot-<id>`, started as root with `--init`, the home volume `claudepilot-<id>-home` at `/home/node`, a read-only agent volume `claudepilot-<id>-agent` (bundle and pty package, filled by a helper container that fetches, verifies and `npm install --ignore-scripts`es them) and a state volume `claudepilot-<id>-state` (a one-shot run of `enroll` on it first, the token on stdin); the agent is PID 1's child, commands run as `node`. No socket. Label `claudepilot.connect=single`. | The state volume (not mounted in the workspace, but readable with `sudo`) | `--restart unless-stopped` | The container; volumes with `--purge`. The home volume is never removed without `--purge`. |
| **Host** (Linux) | `~/.claudepilot/agent/`: the machine's Node 22 or the official tarball unpacked to `node/`; `versions/<build>/agent.mjs` and `node_modules` (pty); `current` pointing at the running build; `identity.json`, `agent.json`, `logs/`. A systemd user unit (§13.6). | `~/.claudepilot/agent/` | systemd user unit; `loginctl enable-linger` so it survives logout (asks, or prints the `sudo` line); without systemd a start script and the exact command to run | The unit and `~/.claudepilot/agent/`. Workspace data (`~/.claudepilot/host`, Claudes, `~/work`) is not touched. |
| **Host** (macOS, preview) | The same under `~/.claudepilot/agent/`, a launchd agent `com.claudepilot.agent` in `~/Library/LaunchAgents/`. `doctor` lists missing tools (`tmux`, `jq`, `flock`, `setsid`) and the Homebrew line. | same | launchd (`KeepAlive`) | The launchd agent and `agent/`. |

**Windows (PowerShell)** has the Docker, Swarm, Kubernetes and Container flows: `docker` and `kubectl` are the same CLIs; the differences are `Invoke-RestMethod`/`Invoke-WebRequest`, `Get-FileHash`, `$env:` variables, CRLF-safe stdin to containers (the token line is trimmed on the other side), the socket mounted as `/var/run/docker.sock` (Docker Desktop's Linux VM provides it), and named volumes only. Windows containers and named pipes are not supported: `doctor` says "switch Docker Desktop to Linux containers". A Windows Host is WSL2 (§6).

### 13.4 Pinned downloads

| What | Pinned by |
| --- | --- |
| The agent bundle | `PILOT_AGENT_URL` and `PILOT_AGENT_SHA256` in the plan, from the bundle this portal serves now (`/connect/v1/agent/<build>/agent.mjs`). |
| The official Node (Host kind, when the machine has no Node 22.13+) | `PILOT_NODE_VERSION` and the `PILOT_NODE_SHA256_<OS>_<ARCH>` keys, from `apps/server/src/connect/node-manifest.json`, which `npm run gen:connect-node -w @portal/server` fills from nodejs.org's `SHASUMS256.txt` and a test checks for shape; the download comes from `PILOT_NODE_MIRROR` (default `https://nodejs.org/dist`) as `.tar.gz`. |
| The pty package (Host, Container) | The exact version in the portal's lockfile; the installer downloads the package's and its platform package's tarballs from the npm registry (or `npm_config_registry`) with the fetcher, which checks each one's integrity (`sha512`, the plan's `PILOT_PTY_INTEGRITY*` keys) before writing it, then unpacks the two into `node_modules/@lydell/` (built: no `npm` is needed and no install script can run). |
| The workspace image | The reference in the plan; pulled by tag (a registry's own trust). With `PILOT_BUILD_IMAGE=1`, built from the portal's context. |
| The base image | `PILOT_NODE_IMAGE`, a public tag. Pinning it by digest is the operator's choice in `PORTAL_CONNECT_BASE_IMAGE`. |

The fetcher inside containers is `node -e` (the public `node` image has no `curl`): a 15-line script that downloads, checks the sha256 and writes the file; the same text is used by the Docker, Swarm, Container and Kubernetes installers and has its own tests.

### 13.5 The Kubernetes manifest

`GET /connect/v1/manifest` (bearer) returns, for namespace `<ns>` (default `claudepilot-workspaces`):

- `Namespace` `<ns>` labelled `claudepilot.managed=true` (what `KubernetesRuntime` makes today) **if it doesn't exist** (the installer's own `kubectl` creates it with the person's rights; the Role can't).
- `ServiceAccount` `claudepilot-agent`; `Role` and `RoleBinding` of the same name, **namespaced only**:

| apiGroup | resources | verbs |
| --- | --- | --- |
| `""` | `pods` | get, list, watch |
| `""` | `pods/exec` | create, get |
| `""` | `persistentvolumeclaims` | get, list, create, delete |
| `""` | `secrets` | get, list, create, update, patch, delete (foundation F3's delivery Secrets; the proxy only lets the portal name `ws-*` ones; the agent's own two Secrets are outside that list) |
| `apps` | `deployments` | get, list, create, update, patch, delete |
| `apps` | `deployments/scale` | get, update, patch |
| `metrics.k8s.io` | `pods` | get, list |

- `Secret` `claudepilot-agent-enroll` (the token; a leftover used token is inert).
- `Deployment` `claudepilot-agent`: one replica, `strategy: Recreate` (two pods would meet `already_connected`), an init container that fetches and verifies the bundle into an `emptyDir`, the container `node /agent/agent.mjs run`, restricted pod security (`runAsNonRoot`, uid 65534, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, capabilities dropped, `RuntimeDefault` seccomp), requests 50m and 128Mi, limits 500m and 256Mi, environment from the plan, the namespace from the downward API. Its labels never include `claudepilot.managed`, so `KubernetesRuntime.list()` doesn't see it as a workspace.

The installer prints `kubectl config current-context` and the API server, asks "Apply to this cluster?" from `/dev/tty` (`PILOT_YES=1` to skip), runs `kubectl auth can-i` for what it needs, applies with the context from `PILOT_KUBE_CONTEXT` if given, waits for `rollout status` (120 s), then waits for the portal to see the node. After a restart the agent finds its identity Secret and does not enroll again. The manifest is checked without a cluster by a structure test (kinds, API versions, the Role's verbs, the pod security context, the labels) and by `kubeconform` (✅ `kubectl apply --dry-run=client` can't do it: it needs an API server for discovery, observed here with an empty kubeconfig); a server-side dry run is part of the opt-in throwaway-k3s run (§19.2).

### 13.6 The Host unit and the consent

```
[Unit]   Description=ClaudePilot agent (<id>) · After=network-online.target · Wants=network-online.target
[Service] ExecStart=%h/.claudepilot/agent/node/bin/node %h/.claudepilot/agent/current/agent.mjs run
          Environment=PILOT_DATA_DIR=%h/.claudepilot/agent · Restart=always · RestartSec=5
[Install] WantedBy=default.target
```

No hardening options (`NoNewPrivileges` and friends): the agent starts the user's shells and `sudo` must keep working in them. The consent text printed on the host: "This gives the portal at <url> a shell as <user> on this machine, and read and write access to <user>'s files. There is no isolation. Type yes to continue." The wizard asked the admin the same (`hostAccess`); the host's own person answers on the host (`/dev/tty`), or `PILOT_YES=1` is set deliberately.

### 13.7 TLS, proxies, Cloudflare Access

- `https` is required for the portal address except loopback, or with `PORTAL_CONNECT_ALLOW_HTTP=true` (lab use, set by the operator, not a wizard checkbox). The installer and the agent refuse any other `http` address.
- **Public CA** (Caddy with a Let's Encrypt certificate, Cloudflare): nothing to do. **A private CA** (Caddy's internal CA, the default of `deploy/compose.yaml`): `PORTAL_CONNECT_CA_FILE` points at the root certificate; the wizard's "Private CA" option adds the commands; the installer copies the file to the agent's data dir, `curl --cacert` uses it, containers get it mounted and `NODE_EXTRA_CA_CERTS` set. Certificate verification is never turned off.
- **Proxies:** `HTTPS_PROXY`, `NO_PROXY` are honoured by `curl`, `docker`'s own pulls (the host's daemon settings), and the agent (§11.3).
- **Behind Cloudflare Access** (the web PRD's plan for the UI's hostname): the agent-facing paths must be reachable without the browser sign-in. One prefix, `/connect/`, is the whole surface (`CONNECT_PUBLIC.prefix`), so a bypass policy for it, or a second hostname on a tunnel that publishes only it (the way the Portal MCP's public listener works), is one rule. For an Access service token, `PILOT_HEADERS` carries the two headers; they are never logged. The same applies to the Portal MCP's tunnel guide: its path list gets `/connect/`.
- **The address the host uses** can differ from the one the admin's browser shows (`localhost:3000` in the browser; `https://pilot.example.com` for hosts). The wizard prefills the browser's origin and lets the admin change it (Advanced); the operator can set `PORTAL_CONNECT_URL` or the setting, which wins over the browser's.

### 13.8 Upgrade, uninstall, status

- **Upgrade** (`… | sh -s -- upgrade`, no token): reads `latest.json` (`CONNECT_PUBLIC.latest`), downloads and verifies the new bundle into the state volume or `versions/<build>/`, and restarts the agent (a container: `docker restart`; Host: the `current` link moves and the unit restarts; Kubernetes: `kubectl set env` of the init container's bundle url and sha256, which rolls the pod; Swarm: `docker service update --force`). The previous build stays on disk. `PILOT_URL=<new>` rewrites the portal address in `agent.json` (the portal moved).
- **Uninstall** (`… | sh -s -- uninstall`): shows what it will remove, asks, removes it, never touches workspaces, workspace volumes or user data unless `--purge`, and says to remove the target in the portal.
- **Status**/**doctor:** local state and the doctor checks of §11.8.

### 13.9 Plan example

```
PILOT_PLAN=1
PILOT_KIND=docker
PILOT_ROLE=cluster
PILOT_TARGET=homelab
PILOT_NAME=homelab-1
PILOT_PLATFORM=linux
PILOT_PORTAL=https://pilot.example.com
PILOT_TUNNEL=wss://pilot.example.com/connect/v1/tunnel
PILOT_PROTOCOL=1
PILOT_AGENT_BUILD=3f9a1c07be52
PILOT_AGENT_URL=https://pilot.example.com/connect/v1/agent/3f9a1c07be52/agent.mjs
PILOT_AGENT_SHA256=3f9a1c07be52…(64 hex)
PILOT_NODE_IMAGE=node:22-bookworm-slim
PILOT_WORKSPACE_IMAGE=ghcr.io/alfianisnan26/claudepilot-workspace:latest
PILOT_IMAGES=ghcr.io/alfianisnan26/claudepilot-workspace:latest
PILOT_MAX_USES=1
PILOT_EXPIRES=2026-10-12T09:15:00Z
```

## 14. Data model

Migrations 130 to 149 (T1; T3 may use 150 to 159, T4 160 to 169). All `STRICT`. No sealed columns: the registry holds hashes and public keys, so nothing is added to `ENCRYPTED_COLUMNS`.

```sql
CREATE TABLE connect_targets (
  id TEXT PRIMARY KEY,                                   -- plain name, immutable
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('docker','swarm','kubernetes','container','host')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active')),
  portal_url TEXT NOT NULL,                              -- the origin its agents use
  settings TEXT NOT NULL DEFAULT '{}',                   -- ConnectTargetSettings (JSON)
  snapshot TEXT, snapshot_at TEXT,                       -- last list() of its workspaces, for the unreachable view
  owner_id TEXT NOT NULL DEFAULT 'u_owner',              -- a user id (multi-user, light touch: targets are platform-owned, the owner manages them)
  created_at TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT 'u_owner', updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX connect_targets_label ON connect_targets (label COLLATE NOCASE);

CREATE TABLE connect_nodes (
  id TEXT PRIMARY KEY,                                   -- 'nd_' + 12 hex
  target_id TEXT NOT NULL REFERENCES connect_targets (id) ON DELETE CASCADE,
  enrollment_id TEXT,                                    -- the token it came from (enroll/status follows the node)
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,                              -- Ed25519, 32 raw bytes, base64url
  key_fingerprint TEXT NOT NULL,                         -- first 32 hex of SHA-256(public key)
  prev_public_key TEXT, rotated_at TEXT,                 -- valid for CONNECT_LIMITS.rekeyGraceMs after a rotation
  drained INTEGER NOT NULL DEFAULT 0,
  info TEXT NOT NULL DEFAULT '{}',                       -- last hello and status summary (agent text: sanitised, short)
  agent_version TEXT, agent_build TEXT, protocol INTEGER, os TEXT, arch TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT, last_ip TEXT,
  revoked_at TEXT, revoked_reason TEXT,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT 'u_owner'   -- who authorized it: the creator of the token
) STRICT;
CREATE UNIQUE INDEX connect_nodes_name ON connect_nodes (target_id, name COLLATE NOCASE) WHERE revoked_at IS NULL;

CREATE TABLE connect_enrollments (
  id TEXT PRIMARY KEY,                                   -- 'en_' + 12 hex
  target_id TEXT NOT NULL REFERENCES connect_targets (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,                       -- SHA-256 hex
  last4 TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('linux','macos','windows')),
  params TEXT NOT NULL DEFAULT '{}',                     -- ConnectInstallOptions
  max_uses INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT 'u_owner',
  first_used_at TEXT, last_used_at TEXT, revoked_at TEXT
) STRICT;

CREATE TABLE connect_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, type TEXT NOT NULL,
  target_id TEXT, node_id TEXT, enrollment_id TEXT,
  actor TEXT NOT NULL, ip TEXT,                          -- the audit string of whoever acted: `user:<id>`, `agent:<node id>`, `system`
  detail TEXT NOT NULL DEFAULT '{}'                      -- small, flat, no secrets
) STRICT;
CREATE INDEX connect_events_target ON connect_events (target_id, at);

CREATE TABLE connect_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
-- keys: public_url, token_ttl_minutes, default_target (the one default, enrolled or scanned), hidden_scanned (JSON array of ids),
--       removed_nodes (JSON: nodes of removed targets, 14 days, so an agent that comes back hears `target_removed`, not `unknown_node`)
```

Live state (connected or not, RTT, last status, streams) is in memory in the hub, not in the database; `last_seen_at` is written at most once a minute per node and not at all while the store is read only. Retention: 5,000 events per target, pending targets after 24 hours. A target's `snapshot` is replaced after a successful `list()` at most every 10 seconds.

## 15. API

Admin routes use the session cookie and the Origin check, like every `/api` route; bodies and replies are the shapes in the contract; errors are the usual `{ error: { code, message, details } }`.

| Method and path | Request → reply | Notable errors |
| --- | --- | --- |
| `GET /api/connect/targets` | → `ConnectTargetRow[]` | |
| `POST /api/connect/targets` | `CreateConnectTargetRequest` → 201 `ConnectEnrollmentCreated` | 409 id or label taken; 422 `id`, `portalUrl`, `hostAccess`, or a matrix cell that is `later`/`no`; 503 `store_locked` |
| `GET /api/connect/targets/:id` | → `ConnectTargetView` | 404 |
| `PATCH /api/connect/targets/:id` | `UpdateConnectTargetRequest` → view | 409 namespace is fixed; 422 |
| `DELETE /api/connect/targets/:id?onWorkspaces=keep\|remove` (`CONNECT_API.removeTarget`; not `workspaces`: the session guard refuses that name unless it holds a workspace id) | → `{ ok: true }` | 428 `CONFIRM_REQUIRED` with `ConnectRemoveBlocked`; 409 `remove` needs the target connected |
| `POST /api/connect/targets/:id/check` | → view (a fresh check) | |
| `GET /api/connect/targets/:id/enrollments` | → `ConnectEnrollment[]` | |
| `POST /api/connect/targets/:id/enrollments` | `CreateConnectEnrollmentRequest` → 201 `ConnectEnrollmentCreated` | 409 `target_enrolled` (a single with a live node) |
| `DELETE /api/connect/targets/:id/enrollments/:eid` | revoke → `{ ok: true }` | |
| `GET /api/connect/targets/:id/enrollments/:eid/plan` | → `ConnectPlanPreview` (no secrets) | |
| `GET /api/connect/targets/:id/events?limit&before` | → `ConnectEvent[]` | |
| `PATCH /api/connect/nodes/:nid` | `UpdateConnectNodeRequest` → `ConnectNodeView` | |
| `DELETE /api/connect/nodes/:nid` | revoke → `{ ok: true }` | |
| `POST /api/connect/nodes/:nid/rotate` | → 202 | 409 offline |
| `PATCH /api/connect/scanned/:id` | `{ hidden }` → `ConnectScannedView` | 404 |
| `GET`/`PUT /api/connect/settings` | `ConnectSettings` / `UpdateConnectSettingsRequest` → `ConnectSettings` | 422 `publicUrl` (`connectOriginProblem`) |

Agent-facing routes (under `/connect/`, no cookie):

| Method and path | Authorization | Reply |
| --- | --- | --- |
| `GET /connect/v1/health` | none | `{ ok, protocol, version }` |
| `GET /connect/install.sh`, `/connect/install.ps1` | none | the script, `text/plain`, `ETag` = sha256, `Cache-Control: no-cache` |
| `GET /connect/v1/plan` | bearer token | plan text; uses nothing |
| `GET /connect/v1/manifest` | bearer token (a `kubernetes` enrollment) | YAML |
| `POST /connect/v1/enroll` | bearer token | `{ data: ConnectEnrollResult }`; uses one use |
| `GET /connect/v1/enroll/status` | bearer token | `{ data: ConnectEnrollStatus }` |
| `GET /connect/v1/tunnel` | the signed challenge | WebSocket (§9) |
| `GET /connect/v1/agent/latest.json` | none | `{ build, sha256, version, protocol, url }` |
| `GET /connect/v1/agent/<build>/agent.mjs` | none | the bundle (only the current build; others 404) |
| `GET /connect/v1/image/workspace/context.tgz` | none | the workspace image's build context |

Public routes have their own limits (a 16 KiB body, a per-address rate limit, 404 when Connect is disabled) and no cookies, CORS or `Origin` handling; a request with an `Origin` header to `enroll` or `tunnel` is refused.

Configuration (new `config.connect`, new keys only): `PORTAL_CONNECT_ENABLED` (default true), `PORTAL_CONNECT_URL`, `PORTAL_CONNECT_ALLOW_HTTP` (false), `PORTAL_CONNECT_CA_FILE`, `PORTAL_CONNECT_BASE_IMAGE` (`node:22-bookworm-slim`), `PORTAL_CONNECT_WORKSPACE_IMAGE` (default the same as `PORTAL_K8S_IMAGE`'s default), `PORTAL_CONNECT_TOKEN_TTL_MIN` (15).

## 16. What the person sees

The UI text diet applies (PLAN.md rule 12): titles and labels of one or two words; no paragraph under a title, a section or a field; explanations in `InfoTip`; one terse visible line only for something irreversible or security-relevant; no card inside a card; icon buttons with names; progressive disclosure behind a chevron or a sheet; phone first, looked at at 390 px and 1280 px, light and dark. The copy below is the whole of it.

### 16.1 Targets (`/admin/targets`, admin group in the sidebar, "More" on phones)

One list, no header over it. A row: a status dot (green connected, amber partial, red offline, grey pending), a kind icon, the label, one muted line, a chevron.

| Row | Muted line |
| --- | --- |
| Connected cluster | `Docker · 2 nodes · 5 workspaces` |
| Offline | `Offline · 3 min` (hover and InfoTip: the reason) |
| Pending | `Waiting for the connector` |
| Single | `Host · 1 workspace` |
| Scanned | `Scanned · /var/run/docker.sock`; unreachable ones show a muted Hide action |

Header: title "Targets", button "Add" (icon only with the name `Add target` on phones), a gear that opens Settings (portal address, default target, token lifetime). Empty: "No targets" and Add.

**Detail sheet** (side sheet on desktop, full screen on phone), top to bottom, each item only when it applies: Nodes (name, dot, version, RTT; a menu per node: Drain, Rotate key, Revoke; an "Outdated" chip with the upgrade command behind it), Settings (label, max workspaces, namespace and storage for Kubernetes, delivery switch), "Add node" (Docker, Swarm), "Command" (makes a new command), Events (collapsed), Remove (red, last). Remove asks one question when the target has workspaces: radio "Keep them on the host" (default) or "Remove them too", and one visible line "Nothing on the host is deleted unless you choose it."

### 16.2 Add target (dialog; a full-screen sheet on phones)

| Step | Content |
| --- | --- |
| 1 | Segmented **Cluster / Single** (InfoTip: "Cluster: new workspaces can be placed here. Single: the machine or container becomes one workspace."). A select for the type: Docker, Swarm, Kubernetes, or Container, Host. A segmented **Linux / macOS / Windows**, preselected from the browser, a cell that isn't `v1` is disabled or labelled "Preview" with its note in an InfoTip. A name field (`my-server`). For Host one checkbox line: "Shell as you, no isolation." Advanced (collapsed): portal address (warns in one line when it isn't https), namespace and storage class (Kubernetes), node name, token lifetime, "Run with sudo" (Linux Docker kinds), "Private CA". Button: Continue. |
| 2 | The target's name as the title. The command in a monospace block with a Copy button (and "Verify first" and "View script" as quiet links; the second opens the script text and its sha256 in a sheet; "What it does" opens the plan's steps). Below it one live line: a spinner and "Waiting…" → "Connected · homelab-1 · v0.1" (a check mark; a second line offers "Add node" for Docker and Swarm) → or "Expired" with "New command". Done. |

Closing the dialog before it connects leaves a pending row; Cancel removes the target.

### 16.3 Elsewhere

- **Workspaces page:** the Targets card becomes one line, `Targets · 3 of 4 reachable`, linking to Targets (the dot stays). A workspace on a down target shows the new status "Unreachable" (muted tone) with "Last seen 4 min ago" in its detail; its actions that need the target are disabled with the reason.
- **New workspace:** "Runs on" lists scanned and enrolled targets (Singles are not creatable, as This machine isn't); a "Node" select appears only for a cluster with more than one node ("Auto" first); the default target is preselected.
- **Live:** the `connect` topic refreshes Targets and the wizard.

### 16.4 States to look at

Empty, one pending, connected, partial (one of three nodes), offline, revoked, the wizard at each step on 390 px and 1280 px, the expired token, a failed install (the live line stays "Waiting…" and the command stays copyable), the Remove question with and without workspaces, dark and light.

## 17. Security and threat model

### 17.1 Defaults

HTTPS only (loopback excepted); outbound connections only; one prefix of public routes; a token that is short, single-use, hashed and never in a URL; a key the portal never holds; a Docker filter the portal can't widen; a namespaced Role; no root on the host unless the person chose Host and typed yes; no silent upgrade; every refusal audited with the address.

### 17.2 Threats

| # | Threat | What stops or limits it | What remains (accepted, and shown to the owner) |
| --- | --- | --- | --- |
| 1 | A network attacker reads or alters the tunnel or the installer | TLS is required for the address; the installer and agent verify the certificate (a private CA is a file, never "skip verify"); every download is hash-pinned from the plan | A TLS-terminating proxy (Cloudflare) sees the tunnel's plaintext, as it sees the UI's. The owner chose it. |
| 2 | An enrollment token is stolen before it is used | 15 minutes, once, hashed, rate-limited; the host that was meant to use it gets `token_used` at once and the audit shows the address that did | Within the window an attacker can enroll their own machine into a *cluster* target and then receive its workspaces and their secrets. Detectable at once (the live "Connected" line shows an address the admin doesn't know); the response is Revoke. A "node approval" step is a later option (§23). |
| 3 | A node key is stolen (a compromised host; for a Single *container*, anyone with a shell in the workspace, who can `sudo` to the key) | The key authenticates one node; a second connection is refused while the first is healthy (no takeover); a new address is audited; Rotate and Revoke work from the portal | The holder can answer for that node once its real agent is offline, and would receive what the portal sends it. For a Single container this is the workspace's own shell users: treat them as trusted as the portal's operator for that target. |
| 4 | A rogue agent (an attacker's machine, enrolled) | It can only answer portal requests; it can't call the portal, open any stream but `control`, or reach other nodes | What the portal sends it (workspace creates and their secrets) is exposed: keep tokens private, mind threat 2, use the per-target delivery switch for hosts that are not yours. |
| 5 | The portal is compromised | On Docker, the agent's policy: only containers with the portal's labels, from allowlisted images, with no privileged mode, host namespaces, devices, binds, published ports or networks, no builds; on Kubernetes, a namespaced Role and a proxy confined to it | It can run workspaces from the allowlisted image and exec into the ones it made. For a **Host** kind it has a shell as that user: that is what the kind is, and the person confirmed it. A kernel or container escape is out of scope. |
| 6 | The portal (or whoever controls it) pushes new agent code to every host | The portal never asks an agent to replace its code; installs and upgrades are pinned commands a person runs from the UI | A compromised portal that also tricks an admin into running a new command. |
| 7 | A request that slips past the Docker filter (smuggling, a parser difference, a path trick, a new Docker field) | One parser: requests are re-issued, never forwarded as bytes; strict allowlist schema, unknown fields denied; path normalisation; container ids resolved and checked; a corpus and fuzz tests run against the real daemon | The filter is a request filter, not a sandbox (the wollomatic proxy's own docs say the same of theirs): it narrows the API, it does not contain a container escape. |
| 8 | Using the agent to reach internal networks (SSRF), or the portal as a pivot | The portal never connects to an address an agent gives; agents can open no stream but `control`; `tcp` doesn't exist in v1 | None known. |
| 9 | A local process on the portal's machine uses the Kubernetes loopback listener | 127.0.0.1 only, a random port, and the agent refuses requests without the per-connection bearer | A process that can read the portal's memory. |
| 10 | The token leaks through logs, history, `ps`, `docker inspect`, transcripts, screenshots | Header or environment only; stdin to containers and the agent; the installer turns tracing off around it; never in URLs (so not in Caddy or Cloudflare logs); `cpen_` is added to the chat redactor's patterns and the Portal MCP sanitiser's; audit rows have no secret fields | Shell history on the machine that ran the command (it is single-use and expires). |
| 11 | `curl \| sh` is run without reading it | Static, hash shown, "View script", "Verify first", dry run, prints what it runs, asks before Host access or applying to a cluster | A person who pastes anything pastes anything. |
| 12 | Flooding: sockets, token guesses, big frames, many streams | Pre-auth bounds, per-address and global limits, 256-bit tokens, size and rate caps, stream caps, timeouts, a kill switch | A volumetric attack on the portal's host is the proxy's job. |
| 13 | Clock manipulation | No authentication depends on a clock; skew is shown | None. |
| 14 | A different portal or a different database at the same address | The agent pins the portal id; a restored database keeps it; a new database makes agents refuse (`portal_mismatch`) | Re-enroll after a deliberate new database. |
| 15 | Two portals manage one Docker host | Every container carries `claudepilot.portal=<id>`; the policy requires it; an unlabelled or foreign container is `unmanaged` | The portal treats unlabelled legacy containers as adoptable on scanned targets only. |
| 16 | A workspace (a prompt-injected Claude) attacks its host | Docker: no socket, no host mounts, default capabilities, the agent in another container; Kubernetes: the agent's token is not mounted in workspace pods; Container: that container only | Host kind: none, by design. |
| 17 | Secrets at rest | The registry holds hashes and public keys; the agent's key is 0600 | A stolen identity file is threat 3. |
| 18 | The supply chain | Bundle from this repository's build with a pinned hash; Node from nodejs.org with a hash pinned in the build; the pty package checked against the lockfile; base images by tag (digest if the operator sets it) | A compromise of nodejs.org's checksum file at the time the manifest is generated, caught by the review of that file's diff. |

### 17.3 Rules the code follows

Agent-supplied text (hostnames, versions, log lines, Docker's error messages) is trimmed, stored as text, shown as text. The portal never logs a token, a key, an argv or a file's content. A `host` stream's `env` and stdin are not logged on either side. The same value redactors the chat uses run on anything an agent says that is stored. `put` secrets travel inside the tunnel's TLS only. The audit `detail` is flat and small by construction (a type check, and a test that fuzzes the writers with canaries).

## 18. Observability and operations

**What an operator sees.** Per node: link, connected since, last seen, address, agent version and build ("outdated"), protocol, OS and arch, RTT, clock skew, services and their errors, host usage, Docker engine, swarm role, key fingerprint, drained. Per target: link, nodes connected of total, workspaces, problem text, recent events (`CONNECT_EVENT_TYPES`), including denials by rule. The portal logs `[connect] node nd_… connected (docker, build 3f9a…)` style lines with ids only.

**Troubleshooting** (also the wording of `doctor`'s hints):

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| "Waiting…" never ends, installer says token rejected | Expired, used or revoked token | New command (the audit says which). |
| Installer: portal unreachable | DNS, firewall, proxy, wrong address | `doctor`; check `PILOT_URL`; set `HTTPS_PROXY`. |
| TLS error on `curl` or in the agent | A private CA | Use the wizard's "Private CA" option. |
| Connects, then drops every minute | A proxy that cuts WebSockets or idles them under 15 s | Raise its idle timeout; Cloudflare Access: bypass `/connect/`. |
| `already_connected` | Two agents with one identity (a copied volume or key) | Revoke the node and enroll again. |
| Docker: permission denied | The user can't use the socket | Run the printed `sudo env …` command. |
| Docker Desktop on Windows: "no matching manifest" or a Windows-container error | Windows containers mode | Switch to Linux containers. |
| Kubernetes: Forbidden on apply | The person's kubectl lacks rights to create the Namespace or Role | Use an admin context (`PILOT_KUBE_CONTEXT`). |
| Node shows "outdated" | A newer agent build ships with the portal | Run the upgrade command on that host. |
| Workspaces "Unreachable" | The node is offline | Check the host and its network; nothing is lost. |

**Operating notes.** Caddy needs nothing extra. Cloudflare's tunnel and Access: see §13.7. nginx: WebSocket upgrade headers and `proxy_read_timeout` over 60 s. One node's connection costs a socket and about 1 MB; hundreds are fine on the portal's single process. After a restore from an older backup, newer nodes are `unknown_node`: enroll them again. The kill switch is `PORTAL_CONNECT_ENABLED=false`.

## 19. Testing and verification

### 19.1 What this sandbox can and can't prove

| Can | How |
| --- | --- |
| The whole protocol, auth, enrollment, registry, policy proxy, host service, runtimes and manager on Linux | node:test, real WebSockets on loopback, real DinD (`CLAUDEPILOT_DOCKER_TESTS=1`, ✅ Docker 29.9 here) |
| The installers' logic for `sh` | Rig containers acting as hosts; `koalaman/shellcheck`, `dash`, `bash --posix` (reachable ✅ Docker Hub) |
| The PowerShell installer's logic | `mcr.microsoft.com/powershell` on Linux (its manifest is reachable ✅): parse, PSScriptAnalyzer, dry run, the Docker flow |
| Kubernetes behaviour | An in-process fake API server, a stub `kubectl` and `kubeconform`. A real cluster is not run by any agent (§19.2); the owner's checklist D3 covers it 🔬 |
| Swarm | Unit tests of the generated service and a stub `docker service`. A real swarm is not run by any agent (§19.2); the owner's checklist D4 covers it 🔬 |
| The UI | `npm run build -w @portal/web`, component logic tests, a browser over CDP at 390 and 1280 px, light and dark |

| Can't | Why | So |
| --- | --- | --- |
| macOS: Docker Desktop's socket, launchd, Homebrew tools, bash 3.2's `/bin/sh` | no macOS here | script logic and static checks; checklist D1 🔬 |
| Windows: PowerShell 5.1 against Docker Desktop, `Get-FileHash`, CRLF through pipes | no Windows here | pwsh on Linux for logic; checklist D2 🔬 |
| Real clusters (k3s, EKS, GKE, PSS variants), a real swarm, Cloudflare Tunnel and Access behaviour, corporate TLS-inspecting proxies, ARM hosts | not available | checklists D3 to D7 🔬 |

### 19.2 Safety rules for every test (they apply to every package)

- **Kubernetes safety rule (the coordinator's, verbatim):** scratch portals must run `unset KUBECONFIG KUBERNETES_SERVICE_HOST` and `PORTAL_K8S_ENABLED=false` explicitly (KUBECONFIG is already set in this sandbox's environment and is what enables the Kubernetes target; `kubectl`'s default context here is the owner's real cluster). A throwaway kubeconfig is for a throwaway local test cluster only; pass `--kubeconfig <file>` on every `kubectl` call; never create or remove a Kubernetes workspace from a scratch portal. The owner's own dev portal intentionally uses the real cluster; scratch portals never do. The suite needs no cluster: the in-process fake API server, the `kubectl` stub and `kubeconform` are the proof.
- **The coordinator's decision on the heavy tests (2026-10-12): no agent runs a real-cluster or a swarm test.** Not the tunnel against a throwaway k3s, not a nested privileged `docker:dind` swarm. They are left to the owner's manual checklist (appendix D3 for Kubernetes, D4 for Swarm, D1 and D2 for macOS and Windows). T6 may still WRITE the two tests if it finds that cheap, as opt-in tests that are skipped unless `CLAUDEPILOT_K8S_TESTS=1` or `CLAUDEPILOT_SWARM_TESTS=1`, each with its own throwaway kubeconfig or daemon and never the default context, one at a time; nobody runs them without the coordinator's explicit go.
- **Docker:** the default daemon is the dev container's DinD; never `--context host`. Everything carries a prefix, nothing is removed by wildcard, nothing of another agent is touched. A scratch portal for Connect tests sets `PORTAL_DOCKER_SOCKET=/nonexistent.sock PORTAL_DOCKER_HOST_SOCKET=/nonexistent2.sock` so only the enrolled target manages the workspaces (otherwise the same containers would show under two targets).
- **Memory:** one scratch portal, one rig host, one workspace container, one Chromium at a time; stop them when idle.
- **No real credentials**, no sign-in, no registration anywhere; Claude Code runs against the scripted stand-in Anthropic API.
- Ports and prefixes: the work breakdown assigns them.

### 19.3 Test groups

| Group | Covers | Harness |
| --- | --- | --- |
| **T-MUX** | The tunnel library: the contract's frame vectors; random-delay in-memory transport; fuzz of frame sequences (never a crash; a protocol error ends in GO_AWAY); flow control (a sender stops at the window, bidirectional bulk doesn't deadlock); fairness (a 1-byte echo stream under a 100 MB transfer); half-close and RST; ping and dead detection on fake timers; the same suite over a real `ws` pair on loopback. The suite is exported (`tunnel/conformance.ts`) and the agent's tests run it too. | node:test |
| **T-AUTH** | The handshake: the contract's signature vector; unknown, revoked and removed nodes; a bad or replayed signature; an expired nonce; text after `welcome`; `Origin` present; pre-auth limits; duplicate connection; rotation grace; protocol bounds; read-only store. | node:test, real WebSocket |
| **T-ENR** | Tokens: TTL, uses, two enrolls racing for the last use (exactly one wins), status grace, revocation, per-address rate limit, the reasons in `CONNECT_ENROLL_REASONS`, a single's second enrollment, name collisions, key validation, canaries absent from every response, log and audit row. | node:test on a temp store |
| **T-REG** | Migrations on a new database and on one at the current version; CRUD; id rules; scanned plus enrolled listing; hide; settings; remove with each workspace choice; pending purge; event retention; the kill switch; backup and restore. | node:test |
| **T-POL** | The Docker policy: a table of allowed and denied requests (appendix A); **the recorded requests of `DockerRuntime`** for every operation it performs must be allowed (the contract between `docker.ts` and the policy: a change to either fails this test); the adversarial corpus (privileged, host namespaces, devices, capabilities, binds, `o=bind` volumes, volumes-from, networks, ports, unknown fields, forged or missing labels, another portal's label, path tricks, absolute-form targets, duplicate and conflicting headers, pipelining, oversize bodies and headers, `Upgrade` on the wrong path, the agent's own container, exec on an unmanaged container); fuzzed create bodies never reach the daemon unless valid. Against a recording fake daemon on a unix socket, then against real DinD. | node:test, DinD |
| **T-KUBE** | The Kubernetes proxy against an in-process fake API server: path and namespace confinement, label-selector injection, secrets by name, Authorization and `Impersonate-*` dropped, the local bearer, token re-read, exec upgrade with channel subprotocols, watch streaming, limits; `KubernetesRuntime` over the loopback against it (list, create, scale, exec, remove). A real-cluster test may exist but is skipped by default and not run (§19.2). | node:test |
| **T-HOST** | The host executor: pipes and pty, resize, exit codes and signals, process-group kill on a reset stream, environment, working directory, user switching (in the Container rig), `put` (owner, mode, traversal, links, 100 MB streamed), `read` (missing file, limit), path mapping, usage, backpressure (a slow consumer pauses the child), no secret in logs. | node:test, rig container |
| **T-AGENT** | Identity (generate, persist 0600, load); enrollment errors and their messages; connect, reconnect (backoff bounds, jitter, healthy reset), fatal rejections wait and don't exit, portal id pin, rekey with a crash at every step, status, bundle hygiene (only allowed imports), `HTTPS_PROXY` through a local CONNECT proxy, a private CA (a self-signed portal), clock skew, `doctor --json`, the log canary run. | node:test |
| **T-RT** | **One runtime contract suite**, run against (a) `DockerRuntime` on the local socket, (b) the tunnelled Docker runtime through a real agent on DinD, (c) the Host runtime through a real agent in a rig container, (d) `KubernetesRuntime` over the tunnel against the fake API: create, list, start and stop, usage, exec with stdin and exit codes, shell with a pty and resize, delivery `run`/`put`/`read`, watch events, remove; and a chat session on (b) and (c) with the stand-in Anthropic API: send, reply, an approval, a file. | node:test, DinD, rig |
| **T-MGR** | The manager: add, replace and remove runtimes while running; check-cache coherence; the unreachable list and its `lastSeenAt`; resume grace; quotas; drain; placement; names across nodes; pending creates carrying `node`. | node:test with fake runtimes |
| **T-OUT** | The outage rule (§12.5) with a runtime that throws `TargetUnreachableError`: chat readers (no `markGone`, reattach at the stored offset, no duplicated output), the reconciler (`pending`, requested on return), outbox, CI and usage (one log per outage), terminals 503; plus one real run: drop the tunnel mid-turn on the stand-in API and see the turn finish after the reconnect. | node:test, DinD |
| **T-INST** | The `sh` installer in rig containers: dry run (no changes, no token printed), a full install per Docker, Container and Host kind, a re-run, a wrong and an expired token, an unreachable portal, no Docker, permission denied (the `sudo env` hint), upgrade, uninstall (workspaces survive), `--purge`; the Kubernetes and Swarm flows run against stub `kubectl` and `docker service` programs on `PATH` that record their arguments and answer canned output (the test asserts what was piped to `kubectl apply -f -` and which context was shown), so no real cluster is ever contacted. | node:test driving `docker run` |
| **T-PS** | `install.ps1` in a PowerShell container: parse, PSScriptAnalyzer, dry run, token handling, plan parsing, the Docker flow with the same rig; the Windows-only branches by review and D2. | node:test driving `docker run` |
| **T-STATIC** | `shellcheck -s sh`, `dash -n`, `bash --posix -n`, forbidden constructs, golden files for the plan text and the manifest YAML, the plan key allowlist, the manifest's structure test and `kubeconform` (the `ghcr.io/yannh/kubeconform` image, whose manifest is reachable ✅); no `kubectl` against any cluster. | CI-style script |
| **T-UI** | The wizard's state machine and command builders (node:test); the web build; looked at in a browser at 390 and 1280 px, light and dark: every state in §16.4; the API-driven wizard flow with a rig host. | drive.mjs over CDP |
| **T-SEC** | Canaries (a token, a key, an env value, a file's content) injected everywhere and absent from every log, response, audit row and agent output; token replay and brute-force limits; Origin and text-after-welcome; the raw-HTTP attacks of T-POL sent through the tunnel; SSRF (an agent that tries to open streams); the loopback listener without the bearer; a security read of the diff. | node:test and review |
| **T-PERF** | Budgets, §19.6. | node:test with timings |
| **T-FAIL** | Failure injection, §19.7. | node:test and rig |
| **T-E2E** | The acceptance scenarios of §19.4, run by QA with the rig. | tools/connect |
| **T-MAN** | The manual checklists of appendix D 🔬. | people |

### 19.4 Acceptance scenarios (QA runs these end to end; the work breakdown has the commands)

| ID | Scenario | Passes when |
| --- | --- | --- |
| A1 | **Docker cluster.** In the wizard (or by API) make `pcx-dock` (Docker, Linux); run the command in a rig host with the DinD socket; watch it connect; create `pcx-w1` on it from the New workspace dialog; open a terminal and run `echo $((6*7))`; start a chat session against the stand-in API and get a reply; assign a Secrets & env pool and see the file in the workspace; look at usage. | The target is Connected within 60 s of the paste; the workspace is a container with the portal's labels; the terminal prints 42; the chat answers; the secret file has its mode; usage shows numbers. |
| A2 | **Survive a revoke.** Continue A1: revoke the node. | The tunnel closes within 2 s; the target is offline; `pcx-w1` lists as Unreachable with its last state; `docker ps` still shows its container; terminals closed; a new command re-enrolls and the workspace is Running again with its chat reattached. |
| A3 | **Remove keeping workspaces.** Remove the target, choose Keep. | The workspace disappears from the portal; the container is still there; nothing was deleted. With `remove` and a connected node, the container and its volume are removed. |
| A4 | **Single container.** `pcx-box` (Container): command in a rig host; the workspace appears as one workspace; Stop and Start switch it; terminal and chat work; `docker ps` shows one container; the agent has no Docker socket. | As described, and `docker inspect` shows no socket mount and no token. |
| A5 | **Single host.** `pcx-metal` (Host, Linux) in a rig host (non-root user, tmux and git, no systemd: `PILOT_SERVICE=none`): the consent is asked on the host (`PILOT_YES` unset in the interactive case); terminal, chat, a file `put` and `read`. | The agent runs as that user; terminals persist across a tunnel drop (tmux); uninstall removes `~/.claudepilot/agent` and nothing else. |
| A6 | **Kubernetes (default: the fake API).** `pcx-kube` against the in-process fake: the manifest validates; the agent (run as a process with the fake's address) enrolls with the Secret token, creates its identity Secret, and the runtime over the tunnel lists, creates, execs and removes in the fake. The same on a throwaway k3s is not run by any agent (§19.2); the owner's checklist D3 covers a real cluster. | As described, in the fake and stub form. |
| A7 | **Swarm.** The generated service command is checked (global mode, template node name, token env, `--env-rm` afterwards). A nested swarm is not run by any agent (§19.2); the owner's checklist D4 covers two real nodes and placement. | As described, in the stub form. |
| A8 | **Portal restart.** Restart the scratch portal with A1 live and a create in flight. | Agents reconnect within 20 s; the pending create resumes (not "could not resume"); the chat session reattaches without a duplicate line; nothing is marked failed. |
| A9 | **Token abuse.** Use a token twice, after it expired, after revoking it, with a wrong one 11 times, from two addresses. | Each is refused with its reason; the eleventh is 429; the first successful use is the only enrollment; no log, response, audit row or transcript contains a token; the live line shows the address that used it. |
| A10 | **The filter holds.** Through the tunnel, send raw requests: create a privileged container, one with `-v /:/host`, one with `o=bind` volume options, delete the agent's own container, exec in an unmanaged container, a smuggled second request. | Every one is 403 with its rule id; the daemon never saw them (its request log); the agent's `status.denied` counts them. |
| A11 | **Scripts on other systems.** `install.ps1` passes T-PS; `install.sh` runs under dash and bash `--posix`; the macOS and Windows checklists D1 and D2 are run by a person and the results written in the PRD's milestone note. | As described. |
| A12 | **Upgrade and compatibility.** A second agent bundle build: the node shows Outdated; `upgrade` swaps it and the node reconnects with the new build; an agent that claims protocol 0 gets `upgrade_required`. | As described. |
| A13 | **Private CA and proxy.** A portal behind a self-signed certificate: the wizard's private-CA command works; the same with `HTTPS_PROXY` through a local CONNECT proxy. | Connected; certificate verification was never disabled (the agent's TLS options are asserted). |
| A14 | **The UI, looked at.** The whole of §16.4 at 390 and 1280 px, light and dark, with a real rig host connecting while the wizard is open. | Screenshots read and found within the text diet; no overflow; every control reachable by keyboard and named. |

### 19.5 Rig

`tools/connect/` (T6) holds: `rig-host` (image from `node:22-trixie-slim` with `docker-cli` copied from `docker:cli`, `tmux`, `git`, `jq`, `curl`, `sudo` and a non-root user `pilot`), `rig-pwsh` (the PowerShell image), the scratch-portal launcher with the environment of §19.2 plus `PORTAL_CONNECT_ALLOW_HTTP=true`, `PORTAL_CONNECT_WORKSPACE_IMAGE=claudepilot-workspace:latest`, `PORTAL_CONNECT_BASE_IMAGE=node:22-trixie-slim` (both local: nothing to pull), an admin helper (sign in, `pcurl`), fake Docker and Kubernetes servers (in `apps/server/src/connect/qa/`), and one command per scenario. Rig hosts reach the scratch portal at the bridge gateway (`docker network inspect bridge`: `172.18.0.1` here ✅, the address `internalUrl` derives for a Docker workspace) on the scratch port.

### 19.6 Performance budgets

On loopback and DinD: mux throughput of one stream at least 80 MB/s; the round trip of a 1-byte stream under a concurrent 50 MB transfer, 95th percentile at most 50 ms; opening a stream at most 5 ms; a terminal's echo through portal, agent and `docker exec` at most 15 ms more than `docker exec` directly (median); `list()` of 20 workspaces at most 300 ms; the agent's idle memory at most 100 MB; `put` of 100 MB streamed with less than 50 MB of growth in either process; 20 agents back within 10 s of a portal restart.

### 19.7 Failure injection

Kill the WebSocket mid-exec, mid-`put`, mid-create; stop the portal and start it; stop and start the agent container; revoke during an exec; a clock one hour off on the agent; a full disk on the host; the Docker daemon restarting under the agent; a slow consumer; a malformed frame; an agent that never answers a stream open; the pending enrollment expiring while the installer waits; two hosts using one token at once.

### 19.8 What is done and checked before a milestone is called Built

The milestone's test groups pass in the sandbox; the typecheck, the web build and the full server suite are green; the UI was looked at; the PRD's milestone note says what was observed and what remains 🔬, in the house style.

## 20. Milestones and gates

Status words are the house ones: **Built** / **Partly built** / **Not built**, each with what was observed when it changes.

| Milestone | Scope | Gate | Status |
| --- | --- | --- | --- |
| C0 | This PRD, the contract (`connect.ts`), the work breakdown | Reviewed by the owner | The contract and PRD are written; the breakdown is in the coordinator's folder. The contract's vectors were reproduced with Node's crypto ✅. |
| C1 | **Tunnel library and control plane.** `connect/tunnel/` with its conformance suite; migrations 130+; registry, enrollment, hub, admin and public routes (no installers yet); `seams.ts` | T-MUX, T-AUTH, T-ENR, T-REG green; a stub agent connects and is seen | **Built** (2026-10-12, T1). Built, in `apps/server/src/connect/`: `tunnel/` (the frame codec against the contract's vectors; `MuxSession`/`MuxStream` with 256 KiB windows granted as the application reads, round-robin scheduling under the 128 and 32 KiB socket marks, pings and dead detection, GO_AWAY, the protocol errors; JSON lines, host records, Ed25519 helpers with a curve check on keys, `openService`/`acceptService`, the `ws` adapter and `dialTunnel`, the exported conformance suite and a memory pair), `seams.ts` (appendix E), migrations 130 and 131, `store`, `registry`, `enrollment`, `hub`, `admin` and the two route files (`/api/connect` behind the session, `/connect/` with full paths and T4's installer routes inside), `runtimes` (`useRuntimeFactory`, `bind`, `settled`, `canCreate`, `onReturned`), `authz` (the `target` resolver for enrolled and scanned ids, `declarePolicies` for every route), `config.connect`, the `connect` live topic, the `cpen_` patterns in the chat redactor and the MCP sanitiser, the stub agent (`qa/stubAgent.ts`). Observed ✅: 224 tests in 17 files, all passing (the full server suite, 2,142 tests, had two failures outside Connect: a hung `limits.test.ts` of the agent that passes alone, and the platform module's registration test) (T-MUX incl. the conformance suite over a memory pair and a real `ws` pair, fuzz and fake-timer liveness; T-AUTH incl. replay, rotation grace, pre-auth bounds, Origin, the 8 KiB cut in the receiver; T-ENR incl. the race for the last use and the shared 429; T-REG incl. migrations on an older database and a restore; T-SEC canaries through every writer; T-FAIL for the hub; T-PERF; the route table against its declarations). With T2's REAL agent over real HTTP and WebSockets in one process: enrolled through the real routes and connected in 0.4 s; revoke closes the tunnel in 0.15 s and the key is dead; a rotation with a crash at each of its four steps ends with one working key; a portal restart brings the agent back in about 2 s and 20 stub agents behind one address in 2.5 s; a second connection for a healthy node is refused; 11 wrong tokens give a 429 (shared across plan, enroll and status); a frozen store refuses enrollment with 503 `store_locked` and lets enrolled nodes connect; the kill switch makes every `/connect/` path 404. On a real scratch portal (clean environment, port 3211) the served bundle's sha256 equalled `latest.json`'s, a Host agent enrolled with its token on stdin, connected, showed in `/api/connect/targets`, `/api/workspaces/targets` and `/api/workspaces` (T3), rotated (the fingerprint was the same on both sides), saw a revoke 159 ms after the DELETE (close 4401) and the workspace turned Unreachable with `lastSeenAt`, came back 4 s after the portal did, connected to a portal with a Locked store (reads worked, writes were 503), and with `PORTAL_CONNECT_ENABLED=false` every `/connect/` path was 404, the registry readable and no enrolled runtime registered. Budgets (§19.6, over a real `ws` pair, on a loaded machine): 218 MB/s on one stream (80), a stream opens in 0.03 ms (5), the 1-byte round trip under a bulk transfer is 0.6 ms at the 95th percentile (50), 57 KiB per idle session pair. Still 🔬: behind Caddy, Cloudflare Tunnel with Access and nginx (the `X-Forwarded-For` rule with `PORTAL_TRUST_PROXY`, WebSocket idle limits over days), checklist D5. Not built: node approval (O8, later). Multi-user (PLAN-10): targets, nodes and tokens are platform-level resources an admin manages (`platform` area `targets`); `owner_id` and `created_by` are `u_owner`, every audit actor is an `actorString`, and who may place a workspace on a target is `operate` on the `target` object, granted per user later. The tunnel and agent credentials are not users. |
| C2 | **The agent.** Identity, enrollment client, tunnel client, control, `host`, the Docker policy proxy, the Kubernetes proxy, doctor, the bundle generator and its sync test | T-AGENT, T-POL, T-KUBE, T-HOST; agent and hub in one process | **Not built** |
| C3 | **Runtime integration.** The tunnel `Agent`, Docker cluster, Kubernetes and Host runtimes; the manager's dynamic runtimes, snapshot and unreachable; the outage rule; `internalUrl`; placement and quotas | T-RT, T-MGR, T-OUT | **Partly built** (2026-10-12, T3). Built in `apps/server/src/workspaces/connect/`: `TunnelAgent`, `ConnectDockerRuntime` (placement by load then cores, a chosen node, drain, names across nodes, `maxWorkspaces`), `ConnectKubeRuntime` with its 127.0.0.1 loopback (a new port and bearer per connection, no namespace created), `HostRuntime`, `createTunnelRuntime`, `wireConnect`; the manager's add/replace/remove, `unreachable` with `lastSeenAt`, the 20 s resume grace, `beforeCreate`, `node`; the outage rule in chat readers, the reconciler and the outbox; `internalUrl` from the target's portal address. Observed ✅: all of `DockerRuntime` through a mux tunnel on DinD (create with the portal's labels, exec with stdin, a shell resize, put, a 160 KB read, usage, start events, stop, start, remove); a Host single through T1's real hub over a WebSocket (exec, put, read, a killed socket gives `Target unreachable`, a redial works); Kubernetes against an in-process fake API (create, scale, exec, remove, never a namespace); a chat reader parked through 6.5 s of outage then re-following from its byte offset with no line twice; delivery `pending`, never `failed`. Not yet: T2's real agent (`runAgent`) and its policy proxy under these runtimes, `wireConnect` called from `index.ts` (waits for T1's `createConnect`), the real run that drops the tunnel mid-turn on the stand-in API (T-OUT), T-PERF. Decisions: a tunnelled Docker target exposes no image versions, canary or recreate (no version pinning there in v1); the browser pool stays local. 🔬 a real cluster and swarm (D3, D4). |
| C4 | **Installers.** `install.sh`, `install.ps1`, plan, manifest, bundle and context routes, node manifest, uninstall, upgrade, doctor | T-STATIC, T-INST, T-PS | **Partly built** (2026-10-12, T4). Built in `apps/server/src/connect/install/`: `routes.ts` (`createInstallRoutes`: the two scripts with `ETag`, plan and manifest behind the token without using it, wrong tokens limited per address, `Origin` refused, `latest.json`, the bundle of the current build, the build context; declared to the authorization layer as public or bearer), `plan.ts`, `manifest.ts`, `commands.ts` (`buildCommands`, `previewSteps`), `fetcher.ts`, `scripts/install.sh` and `install.ps1` (generated into `installers.generated.ts` by `npm run gen:connect-installers`), `node-manifest.json` (`gen:connect-node`: Node 22.23.3 from nodejs.org's SHASUMS256, the pty integrities from the lockfile). Observed ✅: 48 tests green with `CLAUDEPILOT_DOCKER_TESTS=1`: golden plans for the five kinds and the manifest; the plan reader gives the same answers in TypeScript, dash, bash `--posix` and PowerShell 7.5 on 18 cases (CRLF, `$(id)`, backticks, spaces, duplicates); `shellcheck -s sh` clean; `kubeconform -strict` Valid 7; `install.sh` under dash against a fake portal with stub `docker` and `kubectl` and a private HOME: bad address 10, plain http 10, unreachable 11, unknown, expired and revoked tokens 12, a bundle with the wrong sha256 13, no terminal for a question 20; a dry run with `PILOT_DEBUG=1` and `sh -x` printed no token and no header value; the token reached Docker only on the enroll run's stdin and Kubernetes only inside the manifest on `kubectl apply`'s stdin, `--context` on every cluster call; Swarm: one global service, the token through `--env-file`, then `--env-rm`; Host (nohup, Node of the machine, pty from a fake registry): consent asked, connected, a re-run with the used token reports connected, uninstall removes `~/.claudepilot/agent` and nothing else. On real Docker (DinD, this container as the host, a stand-in agent bundle that enrolls and dials the fake portal at 172.18.0.1): the Docker kind ended `PILOT_RESULT=connected` in about 7 s, `docker inspect` showed a read-only root, `CapDrop [ALL]`, `unless-stopped`, the socket bind, label `claudepilot.connect=agent` and no token; a re-run stayed connected; `upgrade` said "Already at"; `uninstall` kept the volume. The Container kind ran the agent in `claudepilot-workspace:latest` with no socket and no token and `uninstall --purge` removed its three volumes. `install.ps1` in `mcr.microsoft.com/powershell` (7.5): parses, dry-runs the Docker flow without printing the token, and a refused token leaves `$LASTEXITCODE=12` without closing the session; PSScriptAnalyzer: no errors (style warnings only: `Write-Host` and noun plurals, kept). Not yet: the real agent (T2's `agent.generated.ts` and its `enroll --token-stdin`) and T1's mounting, `health` and `enroll/status`; T-INST against a scratch portal (A1, A4, A5 with T6's rig); upgrade to a different build observed end to end (A12). 🔬 macOS `/bin/sh` 3.2 and launchd (D1), Windows PowerShell 5.1 and Docker Desktop (D2: 5.1's native argument quoting is why the fetcher travels in an environment variable there), real clusters and swarms (D3, D4), SELinux and rootless refusals (D7). **Multi-user:** installers and tokens are admin-created; the scripts and routes name no person (the token, a target id or an address), and the routes are declared to the authorization layer (`declareInstallPolicies`). |
| C5 | **Web.** Targets page, wizard, detail sheet, Workspaces page and New workspace changes, the `unreachable` status, the `connect` live topic | T-UI, looked at | **Partly built** (2026-10-12, T5): the Targets page, the wizard (cluster/single, system picker with Preview and disabled cells, Host acknowledgement, Advanced, command block with Verify first, View script, What it does, live line), the detail sheet (nodes with Drain, Rotate, Revoke, Outdated, settings, events, Remove with the workspace choice), portal settings, and the Workspaces page and New workspace changes are in `apps/web/src/features/targets/`. Observed: against a scratch portal and a real agent the wizard went from Add to "Connected · host · v0.1.0" live; 390 and 1280 px light looked at. 🔬 not yet looked at: dark mode, Kubernetes/Host steps, partial/offline/revoked rows, the 428 Remove question (blocked by the `?workspaces=` guard conflict, rename pending), Windows/macOS cells. |
| C6 | **QA and security.** The rig, A1 to A14, T-SEC, T-PERF, T-FAIL; the manual checklists run where a person is available; this PRD's milestone notes updated | All green (A6 and A7 in their fake and stub form; no agent runs a real cluster or swarm, §19.2); the unproven 🔬 items listed | **Not built** |
| After v1 (not scheduled) | macOS Host out of preview; a Windows host helper over WSL2; opt-in auto-upgrade; node approval; the `tcp` service (web previews, the browser pool on remote Docker); a Go agent; `full` Docker profile as a host-side flag; digest-pinned base images | | **Not built** |

Waves (the work breakdown has the detail): **W0** P1 (this). **W1** C1 starts with the tunnel library (everyone waits for its first landing), C2 starts with the policy engine, the host executor and the CLI, C4 starts with the scripts and generators, C3 starts with spikes against fakes, C5 starts with the skeleton against fixtures. **W2** integration: C1's REST complete, C3 on the real tunnel, C2's agent integrated, C5 on the real API. **W3** C6 and fixes.

## 21. Gap analysis: improvements beyond the owner's text

Each row is a decision, or an explicit owner's call (§23).

| ID | Gap | Decision |
| --- | --- | --- |
| GA1 | **The portal's TLS is private** by default (`deploy/compose.yaml` uses Caddy's internal CA), so `curl` and the agent would fail verification | The wizard's "Private CA" option (a PEM from `PORTAL_CONNECT_CA_FILE`) adds a file write and `--cacert`/`PILOT_CA`; verification is never turned off (§13.7). Public CA needs nothing. |
| GA2 | **The address a host uses isn't the one the admin's browser shows** (`localhost` vs the public name) | The wizard prefills the browser's origin and lets the admin edit it; `PORTAL_CONNECT_URL` or the setting wins; https is enforced, loopback and an explicit operator flag excepted. |
| GA3 | **Cloudflare Access in front of the UI** (the web PRD's plan) blocks agents | One public prefix, `/connect/`; a bypass rule or a second tunnel hostname publishing only it; `PILOT_HEADERS` for a service token (§13.7). Owner's call: which of the two. |
| GA4 | **Token in the command line, URL, history, logs** | Header or `PILOT_TOKEN` only; stdin to containers and the agent; never a URL (Caddy and Cloudflare log URLs); short TTL, single use, hashed; used-by address audited; `cpen_` joins the chat redactor and the MCP sanitiser. |
| GA5 | **`curl \| sh` trust** | Two static, hash-shown, viewable installers; a plan instead of generated code; every download pinned; dry run; prints each command; asks before Host access and before applying to a cluster. |
| GA6 | **Auto-upgrade would let a compromised portal push code** past the Docker filter | No silent upgrade: a badge and a command. Opt-in later, with the caveat in the UI. |
| GA7 | **The agent's image and a registry** | None needed: the public `node` image plus a verified bundle in a volume (or an init container). A registry image is an operator option later. |
| GA8 | **The workspace image on a remote host** (built locally today) | Provisioned by the installer (pull, or build from the portal's context); the tunnel pulls only the allowlisted reference and never builds; a private registry is the host's `docker login`. |
| GA9 | **Where volumes live** | Docker: named volumes on the node (`claudepilot-<name>-home`), local to it; a node's loss is its workspaces' loss, said in its detail. Kubernetes: PVCs with the target's `storageClass` and `storage`. No migration between nodes. |
| GA10 | **Placement, default, quotas, capacity** | Chosen node or least loaded by count; a default target; `maxWorkspaces`; drain; capacity shown from the agent's status. No memory-aware scheduling in v1. |
| GA11 | **Web previews and the browser pool through the tunnel** | Not v1 (the pool's companions need namespace sharing and capabilities outside the managed profile). `tcp` is reserved so a later version adds it without a protocol bump. The pool's `supports` says no on enrolled targets. |
| GA12 | **Terminal latency and head-of-line blocking** | Fair round-robin scheduling, 64 KiB frames, a 128 KiB socket high-water mark, per-stream windows; budgets in §19.6. |
| GA13 | **Large transfers** | `put`, `read` and archives are streamed with flow control and never buffered whole; a 100 MB `put` is a test. |
| GA14 | **Protocol and version skew** | `protocol` integer with a min/max window; additive JSON; an agent build that differs is "outdated", never a failure; `upgrade_required` only below the minimum. |
| GA15 | **Offline or proxied hosts** | `HTTPS_PROXY`/`NO_PROXY` through the agent's own CONNECT dialer for `ws` (Node's env-proxy flag doesn't reach `ws` ✅ observed); hosts that block WebSockets are unsupported and `doctor` says so. |
| GA16 | **Clock skew** | No authentication depends on a clock (nonce); skew over two minutes is shown. |
| GA17 | **What revocation does to running workspaces** | They keep running; the portal shows Unreachable with the last state; Remove asks and defaults to Keep. |
| GA18 | **Reconnect storms** | Full-jitter backoff, per-address limits on upgrades, `retryAfterS`, a pre-auth bound; 20 agents back in 10 s is a test. |
| GA19 | **Audit** | `connect_events` for every lifecycle and admin action, with addresses and no secrets. |
| GA20 | **Diagnostics** | `pilot-agent doctor`, run by the installer too, in one vocabulary. |
| GA21 | **Observability and Usage** | Status carries health, usage, Docker info, denials, streams; usage rides the existing `usage()`; the monitoring PRD can read the registry later. |
| GA22 | **Windows specifics** | Docker Desktop with Linux containers for every Docker kind; named pipes and Windows containers unsupported; WSL2 for a host; PowerShell parity; checklist D2. |
| GA23 | **macOS specifics** | Docker Desktop; the socket is bind-mounted as `/var/run/docker.sock`; Host is a preview needing Homebrew's `tmux jq util-linux`; checklist D1. |
| GA24 | **What Swarm really needs** | An agent per node (a global service from a manager), plain containers placed by the portal, node-local volumes, no overlay networks or services; the token must be reusable and is removed from the service afterwards. |
| GA25 | **Two portals, one host** | The policy requires `claudepilot.portal=<id>`; the agent pins its portal's id. |
| GA26 | **Today's static targets** | Not migrated: shown as "scanned", read only, hideable. |
| GA27 | **How a remote workspace reaches the portal** (Portal MCP agent tokens): `internalUrl` returns a gateway address that is the *remote* host | `Runtime.portalUrl`; `derive` returns it (§12.9). |
| GA28 | **Chat readers mark a session gone** after a few failed retries, which a tunnel outage would trigger while Claude Code is still running | The outage rule: no retries counted and no `markGone` while the target is down; re-follow on return (§12.5). Found in `chat/controller.ts` (`#scheduleRetail`). |
| GA29 | **Delivery turns an outage into `failed`** | `TargetUnreachableError` → `pending`, requested on return. |
| GA30 | **`Workspaces.resume()` judges a pending create before agents have reconnected** | A 20-second wait for enrolled targets. |
| GA31 | **`KubernetesRuntime.create` creates the namespace**, which a namespaced Role can't do (authorization precedes existence: 403, not 409) | `manageNamespace: false` for tunnelled targets; the manifest creates the namespace. |
| GA32 | **The agent's own container must not be a workspace, nor be manageable by the portal** | Label `claudepilot.connect=agent`, never `claudepilot.managed`; the policy denies containers without the managed label; the Kubernetes agent's Deployment has no `claudepilot.managed`. |
| GA33 | **A Single container's workspace user can read the node key** | Accepted and shown (§17.2, row 3); no takeover of a live connection, address audit, Rotate and Revoke. |
| GA34 | **Restoring an older database** | Newer nodes are `unknown_node` and re-enroll; the agent waits an hour between tries and says why. |
| GA35 | **Locked or Frozen store** | Enrollment and registry writes refused (503); enrolled nodes still connect, without `last_seen` writes. |
| GA36 | **SELinux, rootless Docker, Podman** | SELinux: `label=disable` added when enforcing; rootless Docker and Podman are not supported in v1 (`doctor` says so); 🔬. |
| GA37 | **Docker API drift** (a new field in `docker.ts`) | The policy is a strict allowlist; the recorded-request contract test fails the build when `docker.ts` sends something the policy doesn't know. |
| GA38 | **Pools and secrets flowing to a host that isn't yours** | A per-target delivery switch, default on; Owner's call whether the default should be off for Host and Container kinds. |
| GA39 | **Double listing** when the portal scans a Docker socket and also has an enrolled agent on the same daemon | Documented; the rig turns the scanned sockets off. Optional later: compare engine ids. |
| GA40 | **Moving the portal to a new address** | `upgrade` with `PILOT_URL=<new>` rewrites the agent's address; the portal id and node keys carry over with the database. |
| GA41 | **Hosts that can't reach npm or nodejs.org** | `PILOT_NODE_MIRROR`, `npm_config_registry`; the Docker kinds need neither except the Container kind's pty package (a mirror, or a build of the image with it later). |
| GA42 | **An unused enrollment lingering** | Pending targets are removed 24 hours after their last token expired; tokens are listed and revocable. |
| GA43 | **Same name on two targets** | Workspace ids are `<target>/<name>`; names are unique per target; across a cluster's nodes too. |
| GA44 | **Identity of a node vs a person who moves a disk** | The fingerprint is shown on both sides; a copied identity is `already_connected` while the original lives. |

## 22. Decisions, rejected alternatives and research

### 22.1 Decisions

| ID | Decision | Why |
| --- | --- | --- |
| D1 | The agent is a TypeScript bundle on Node 22 | The repo is TypeScript; no Go toolchain exists here to build or test (`which go` ✅ empty); the protocol is language-neutral so a Go agent can replace it. |
| D2 | One WebSocket, yamux framing, our own implementation | One authenticated connection works behind every proxy; yamux's format is small, specified (✅ read for this PRD), in production use elsewhere (📄 hashicorp's tools, frp and libp2p; not re-verified here) and gives a Go agent a library for free; fairness and the socket watermark are ours. |
| D3 | Per-node Ed25519 keys, the portal stores the public half | A token can't be both short-lived and the credential; a stolen database yields nothing usable. |
| D4 | Static installers plus a per-token plan | Auditability, testability, short commands, no secret in a URL. |
| D5 | No new npm workspaces; the bundle is generated into a string constant | The root `Dockerfile` copies each workspace's `package.json` by hand and isn't ours; `cp-ci` already proves the generated-bundle pattern with a sync test. |
| D6 | The Docker policy lives in the agent and the host operator owns it | The portal is the party the filter protects the host from. |
| D7 | The Kubernetes proxy injects the service-account token | The portal never holds a cluster credential. |
| D8 | A Single reuses runtime kind `local` | The UI and server already treat `local` as one workspace you start and stop. |
| D9 | A cluster is a target with 1..N nodes; Swarm is the same agent | One data model and one composite runtime for Docker, Swarm and "Add node". |
| D10 | Container singles get the agent through a volume | The workspace image and its pipeline stay untouched. |
| D11 | No silent agent upgrade | GA6. |
| D12 | Scanned targets aren't persisted | They follow the environment. |
| D13 | Linux Host in v1, macOS preview, Windows via WSL2 | `cp-session` and the terminals need tmux, flock and setsid; macOS needs Homebrew tools; Windows has neither. |
| D14 | `unreachable` is a workspace status backed by a stored snapshot | Dependants must see "blind", not "gone". |
| D15 | Public routes under one prefix, outside `/api` | One proxy or Access rule; no cookie, CSRF or Origin machinery applies to a CLI. |
| D16 | Only one Docker profile, `managed`, in v1 | `full` has no consumer in v1. |
| D17 | The agent opens only `control` | The portal must never be a pivot. |
| D18 | The portal id is pinned in the agent | Cross-portal safety and restore semantics. |
| D19 | The default target lives in `connect_settings` only (no `is_default` column) | A scanned target can be the default too, and it has no row. |
| D20 | A removed target's nodes are remembered for 14 days (`removed_nodes`) | The agent should read `target_removed`, but the cascade deletes the node rows. |
| D21 | A runtime outlives its tunnel and its revoked nodes: it is only taken away with its target; when no live node is left the revoked ones are handed over as drained | So a target's workspaces keep showing as Unreachable (FR37) and nothing is placed on a dead node. |
| D22 | Before a good `auth` a peer may send 8 KiB at most, cut in the WebSocket receiver (`_maxPayload`, restored after `auth`); the pre-auth socket bounds answer HTTP 429 with `Retry-After`, the per-minute upgrade limit answers a typed `rate_limited` reject | `ws` reads a whole message before handing it over, so the check on the first message alone would still let 1 MiB in. |
| D23 | Targets, nodes and tokens are platform-level resources an admin manages (`platform` area `targets`); who may place a workspace on a target is `operate` on the `target` object, granted per user later (PLAN-10). `created_by`/`owner_id` are `u_owner` today and every audit actor is an `actorString` | The authorization seam (`authz/seam.ts`) is adopted now so the retrofit changes no call site; the tunnel and agent credentials are not users. |

### 22.2 Rejected alternatives

| Alternative | Why not |
| --- | --- |
| A WebSocket per stream (the agent opens one on request) | Costs a TLS handshake and an upgrade per terminal and per Docker call, needs a ticket protocol, and multiplies proxy connections. It would win only where proxies forbid long-lived multiplexed connections. |
| HTTP/2 over the WebSocket (Node's `http2` on a duplex) | Relies on Node internals with non-socket transports, is harder to test deterministically, and gives a Go agent no advantage over yamux. |
| SSH tunnels, Docker over `ssh://`, an exposed Docker TCP port with mTLS | Need inbound reach to the host, key and certificate management, and give the portal the whole API. |
| A polling agent (Portainer's async edge) | Terminals and chat need a live stream. A poll model adds seconds of latency and still needs a tunnel for the live parts. |
| A long-lived shared token in the command (cloudflared's token, Coder's global PSK) | A leaked command is a permanent credential. Teleport, GitHub and Tailscale use short-lived or one-off tokens for the same reason. |
| Generated per-choice scripts | Many scripts to review and test; a secret in the generated text. |
| Node single executables, or Go, for v1 | SEA embeds one CommonJS script, can't hold the pty add-on, needs the same Node version per platform and a macOS signature step (📄 Node docs, stability 1.1); Go can't be built or tested here. |
| An agent image on a registry | A second pipeline and a second trust root for something 300 KB. |
| Swarm services as workspaces | Interactive and stateful. |
| Letting the portal widen the Docker policy | Defeats the point. |
| Mounting the Docker socket into Single containers | Gives the workspace the host. |
| A registry of scanned targets in SQLite | They come and go with the environment and would need reconciling with it. |
| mTLS client certificates for node auth | Needs TLS terminated at the portal and a CA; the signed challenge works behind any proxy. |
| Approving each new node before use | Right for automation-free setups, wrong for scripted ones; detection and revocation are in v1, approval is a later switch. |

### 22.3 What was taken from comparable systems

| System | Taken | Left |
| --- | --- | --- |
| Portainer Edge Agent 📄 | Outbound-only, a generated `docker run`, a join token; its "allow self-signed certs" flag is what we replace with a CA file | Polling, tunnel port 8000, `EDGE_INSECURE_POLL` |
| Coder external provisioners 📄 | Outbound connection, scoped keys instead of one global PSK | PSK |
| Teleport 📄 | Join tokens with a default TTL of 30 minutes, reusable until expiry (our cluster tokens), certificates after joining (our key) | Its CA and certificate machinery |
| GitLab agent for Kubernetes 📄 | An in-cluster agent that dials out, up to 500 streams per agent; our stream caps follow; a maximum connection lifetime (not adopted) | gRPC, KAS |
| GitHub Actions runners 📄 | A one-hour registration token, `config` then run | Its auto-update |
| k3s installer ✅ (its script read) | Hash check before install, env file mode 0600, generated uninstall, skip flags; it has no dry run, ours does; its hash comes from the same host as the binary, ours is pinned in the plan | Root-only install |
| Tailscale 📄 | One-off keys revoked on use, reusable keys called dangerous, Kubernetes state in a Secret with RBAC (our identity Secret) | |
| cloudflared 📄 | A token-based service install | Its token is the credential |
| Docker socket proxies (Tecnativa, wollomatic) ✅ (their pages read) | Default-deny, per-method allowlists, bind restrictions. Tecnativa filters by API section and method; wollomatic says its bind filter is "a request filter, not a sandbox" and does not restrict privileged containers, host namespaces, added capabilities or devices, which ours does with a strict create-body schema | HAProxy, regex-only matching |
| yamux ✅ (spec read) | Wire format and flow control | Its (unspecified) ping interval and window-update threshold: ours are in the contract |
| Node SEA ✅ (docs read) | Understood and set aside (above) | |
| docker-modem's SSH transport ✅ (code read) | The proof that a plain `Duplex` from `createConnection` carries the Docker API | |

## 23. Decisions that need the owner, and open questions

### 23.1 For the owner

| ID | Decision | Recommendation (the plan proceeds on it) |
| --- | --- | --- |
| O1 | **Agent runtime**: TypeScript on Node 22 now, a Go single binary later? | TypeScript now (D1). Go later if you want a no-Node install and native Windows and macOS hosts. |
| O2 | **Images**: is `ghcr.io/alfianisnan26/claudepilot-workspace` public, so remote hosts can pull it? Should a registry copy of the agent exist? | Confirm the first (or provide a pull-secret story); no agent image (D5, GA7). |
| O3 | **Windows Host** in v1? **macOS Host**? | Not Windows (WSL2 route); macOS as a labelled preview. |
| O4 | **Public exposure of `/connect/`**: a bypass rule in Cloudflare Access, or a second hostname on the tunnel that publishes only that prefix? Plain `http` on a LAN: allowed only by `PORTAL_CONNECT_ALLOW_HTTP`? | The second hostname (the same shape as the Portal MCP's public listener); http only by the env flag. |
| O5 | **Delivery default**: may pools and secrets flow to every enrolled target by default (the per-target switch exists)? | On for Docker and Kubernetes clusters, **off for Host and Container singles until the admin turns it on**? The plan ships "on" everywhere with the switch; say if you want the stricter default. |
| O6 | **Root-capable agent**: the Docker agent container runs as root with the socket (cap-drop ALL, read-only root). Acceptable, or require a non-root user in the `docker` group (more fragile across hosts)? | Root, hardened. |
| O7 | **Browser pool on remote Docker targets** | Not in v1. |
| O8 | **Node approval** before a new node is used, as an opt-in later? | Later. |
| O9 | **Which owner paths change**: the Dockerfile and `deploy/` need nothing (D5). `deploy/Caddyfile` needs nothing. `images/workspace` needs nothing. The workflow `.github/workflows` needs nothing. | None needed. |

### 23.2 Open questions

| ID | Question |
| --- | --- |
| Q1 | 🔬 Does Cloudflare's tunnel (and Access with a bypass) keep a 15-second-ping WebSocket open for days, and does it change `Origin` or `Host`? |
| Q2 | 🔬 Docker Desktop on macOS and Windows: does bind-mounting `/var/run/docker.sock` give the agent the VM's socket on every supported version, with SELinux-free defaults? |
| Q3 | 🔬 A real k3s and a managed cluster (EKS or GKE): do `pods/exec` with `create` and `get` and the listed verbs suffice, and does restricted pod security admit the Deployment? |
| Q4 | **Answered ✅ (P1's spike, Node 22.23.3):** `http.Server` fed a `duplexPair` side with `server.emit('connection', duplex)` handles keep-alive, a chunked 3 MB body, a 20 MB streamed response with backpressure and `Upgrade`. T2 turns the spike into a regression test and re-runs it on the Node 22 line the agent supports; the fallback, if a later 22.x breaks it, is a `net.Server` on a unix socket per agent as the carrier. |
| Q5 | **Answered ✅ (P1's spike):** `ws` does **not** honour `NODE_USE_ENV_PROXY=1` (global `fetch` and the global `WebSocket` do); the agent uses its own CONNECT `https.Agent` for `ws` (§11.3). T2 writes the test with a local CONNECT proxy. |
| Q6 | 🔬 `loginctl enable-linger` as an ordinary user: allowed by polkit on the distributions the owner uses? |
| Q7 | Is a 128 KiB socket high-water mark enough throughput on a high-latency link (the bandwidth-delay product)? The budget test measures it with a delay proxy; the mark may become adaptive. |
| Q8 | Should enrolled targets feed the Monitoring dashboard (when it exists) from `status`? Nothing blocks it. |

## Appendix A: the Docker policy (profile `managed`)

Normalisation first: remove an optional `/v<digits>.<digits>` prefix; deny a path with `//`, `/./`, `/../`, a NUL, a backslash, or a percent-encoding that changes the path's meaning; deny a request whose target is not origin-form; deny a request with both `Content-Length` and `Transfer-Encoding` or duplicate `Content-Length`; a header block over 16 KiB; a JSON body over 1 MiB. Then:

| Method | Path | Rule | Denial |
| --- | --- | --- | --- |
| GET, HEAD | `/_ping` | allow | |
| GET | `/version`, `/info` | allow | |
| GET | `/events` | allow; `filters` is replaced by one that includes `type=container`, `label=claudepilot.managed=true` and the portal label, whatever the client sent | `events.filter` |
| GET | `/containers/json` | allow; the same labels are added to `filters`; `all`, `limit`, `size` pass | |
| POST | `/containers/create` | `name` matches `^claudepilot-[a-z0-9][a-z0-9._-]{0,62}$` and is the only query key besides `platform`; the body is checked by A.1 | `create.*` |
| GET | `/containers/{ref}/json` | the container is managed (labels `claudepilot.managed=true` and the portal's) | `unmanaged` |
| POST | `/containers/{ref}/(start\|stop\|restart\|pause\|unpause\|wait)` | managed; `t` an integer | `unmanaged` |
| POST | `/containers/{ref}/kill` | managed; `signal` one of SIGTERM, SIGKILL, SIGINT, SIGHUP or 15, 9, 2, 1 | `unmanaged` |
| DELETE | `/containers/{ref}` | managed; `force` and `v` only | `unmanaged` |
| POST | `/containers/{ref}/exec` | managed; body fields `Cmd`, `Env`, `User`, `WorkingDir`, `Tty`, `AttachStdin`, `AttachStdout`, `AttachStderr`, `DetachKeys`; `Privileged` absent or false | `exec.privileged`, `body` |
| POST | `/exec/{id}/start`, `/exec/{id}/resize`; GET `/exec/{id}/json` | the exec id was created through this agent for a managed container within 24 hours; `start` may upgrade, nothing else may | `unmanaged`, `upgrade` |
| GET | `/containers/{ref}/stats`, `/containers/{ref}/logs` | managed | `unmanaged` |
| PUT, GET, HEAD | `/containers/{ref}/archive` | managed; `path` present; a PUT body is streamed | `unmanaged` |
| POST | `/volumes/create` | body `{Name, Labels}` only; `Name` matches `^claudepilot-[a-z0-9][a-z0-9._-]*-home$`; `Driver` absent or `local`; no `DriverOpts` (`o=bind` is a host mount) | `volume.name`, `volume.options` |
| GET, DELETE | `/volumes/{name}` | the same name pattern | `volume.name` |
| GET | `/images/{ref}/json` | `ref` is an allowlisted image | `image.ref` |
| POST | `/images/create` | `fromImage` (and `tag`) is an allowlisted image; no `fromSrc`, `changes`, `message` | `image.ref` |
| any | everything else: `/build`, `/networks*`, `/swarm*`, `/services*`, `/nodes*`, `/tasks*`, `/secrets*`, `/configs*`, `/plugins*`, `/system/*`, `/commit`, `/auth`, `/session`, `/grpc`, `/distribution/*`, `/containers/prune`, other `/images/*`, other `/containers/*`, other methods on the paths above | deny | `path`, `method`, `build` |

**A.1 The create body** is checked against an allowlist; anything not listed is `create.field`.

- Top level: `Image` (an allowlisted reference: exact match after expanding `docker.io/library/` and `:latest`; `create.image`), `Hostname`, `User`, `WorkingDir`, `Labels`, `Env` (strings `KEY=value`, 64 KiB in all), `Cmd`, `Entrypoint`, `Tty`, `OpenStdin`, `StopSignal`, `StopTimeout`, `HostConfig`.
- `Labels` must contain `claudepilot.managed=true`, `claudepilot.workspace=<the name after claudepilot->` and, when the agent knows the portal's id, `claudepilot.portal=<id>`; and must not contain a `claudepilot.connect` key (`create.label`).
- `HostConfig` allowed: `RestartPolicy` (`no`, `on-failure`, `always`, `unless-stopped`), `Mounts` (each `Type: "volume"`, `Source` matching `^claudepilot-[a-z0-9][a-z0-9._-]*-home$`, `Target` an absolute path not under `/proc`, `/sys`, `/dev`, `/var/run`, `ReadOnly` optional, no `VolumeOptions`, `BindOptions` or `TmpfsOptions`), `NanoCpus`, `Memory`, `MemorySwap`, `CpuShares`, `PidsLimit`, `ShmSize` (at most 1 GiB), `AutoRemove`, `Init`, `CapDrop`, `NetworkMode` (empty, `default` or `bridge`).
- Denied with a rule id: `Privileged: true` (`create.privileged`); `PidMode`, `IpcMode`, `UTSMode`, `UsernsMode`, `CgroupnsMode`, `Cgroup` other than empty or `private` (`create.namespace`); `Binds`, `VolumesFrom`, `Tmpfs`, a mount of another type or source (`create.bind`, `create.volume`); `Devices`, `DeviceCgroupRules`, `DeviceRequests` (`create.device`); `CapAdd`, `SecurityOpt` other than `no-new-privileges`, `Sysctls`, `Runtime`, `StorageOpt`, `MaskedPaths`, `ReadonlyPaths` (`create.capability`); `PortBindings`, `PublishAllPorts`, `Links`, another `NetworkMode`, top-level `ExposedPorts` and `NetworkingConfig` (`create.network`, `create.port`).
- The host operator can widen two things locally in `agent.json`: `docker.allowImages` (more references) and `docker.allowBinds` (host path prefixes allowed as `Binds` sources). The portal can't.

## Appendix B: the Kubernetes allowlist

All under the connector's namespace `<ns>`; every list and watch on pods, deployments and claims gets `labelSelector=claudepilot.managed=true` added. A name constraint is on the object's name.

| Methods | Path | Names |
| --- | --- | --- |
| GET | `/version` | |
| GET (list, watch) | `/api/v1/namespaces/<ns>/pods` | |
| GET | `/api/v1/namespaces/<ns>/pods/<name>` | `ws-*` |
| GET, POST (WebSocket upgrade) | `/api/v1/namespaces/<ns>/pods/<name>/exec` | `ws-*`; `container=workspace` |
| GET, POST, DELETE | `/api/v1/namespaces/<ns>/persistentvolumeclaims[/<name>]` | `ws-*-home` |
| GET, POST, PUT, PATCH, DELETE | `/api/v1/namespaces/<ns>/secrets[/<name>]` (no list) | `ws-*-claudepilot` |
| GET, POST, PUT, PATCH, DELETE | `/apis/apps/v1/namespaces/<ns>/deployments[/<name>]` and `/scale` | `ws-*` |
| GET | `/apis/metrics.k8s.io/v1beta1/namespaces/<ns>/pods` | |
| other | deny: a Kubernetes `Status` 403 body | |

## Appendix C: messages by example

```json
// portal → agent, text, right after the upgrade
{"t":"challenge","v":1,"connId":"c0ffee00-0000-4000-8000-000000000001","nonce":"__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA","serverTime":"2026-10-12T09:00:00.000Z","protocol":{"min":1,"max":1}}
// agent → portal
{"t":"auth","node":"nd_0123456789ab","sig":"BOeHtbSS4XZD…","hello":{"agentVersion":"0.1.0","agentBuild":"3f9a1c07be52","protocol":1,"os":"linux","arch":"x64","hostname":"homelab","mode":"docker","runtime":"container","services":[{"name":"docker","ok":true,"version":"29.9.0"}],"clock":"2026-10-12T09:00:00.100Z","startedAt":"2026-10-12T08:59:58.000Z","portalId":"a1b2c3d4-…"}}
// portal → agent
{"t":"welcome","v":1,"node":"nd_0123456789ab","target":"homelab","portalId":"a1b2c3d4-…","portalVersion":"0.0.0","agentBuild":"3f9a1c07be52","protocol":1,"heartbeat":{"pingEveryMs":15000,"deadAfterMs":45000}}
// then binary frames. Stream 1 (agent opens), first line each way:
{"v":1,"service":"control"}
{"v":1,"ok":true}
// portal → agent on control
{"t":"config","portalId":"a1b2c3d4-…","statusEveryS":30,"limits":{"docker":64,"kube":64,"host":32},"agentBuild":"3f9a1c07be52"}
// agent → portal on control
{"t":"status","at":"2026-10-12T09:00:01.000Z","services":[{"name":"docker","ok":true,"version":"29.9.0"}],"docker":{"engine":"29.9.0","apiVersion":"1.56","os":"linux","arch":"x86_64","ncpu":8,"memTotal":12529770496,"containers":3,"running":2,"desktop":false,"images":["ghcr.io/alfianisnan26/claudepilot-workspace:latest"]},"denied":[],"streams":{"docker":1,"kube":0,"host":0}}
// portal opens a docker stream (stream 2): first line each way, then raw HTTP
{"v":1,"service":"docker","trace":"a1b2c3d4"}
{"v":1,"ok":true}
// a refusal
{"v":1,"ok":false,"code":"busy","message":"64 docker streams are open"}
```

## Appendix D: manual checklists 🔬

Each is run by a person on the real thing; the result (date, version, what was seen) is written into §20's milestone note. A step that fails is a bug in the PRD or the code, not a footnote.

**D1 macOS (Docker Desktop, then Host preview).** 1. Docker Desktop with Linux containers running; wizard: Cluster, Docker, macOS; paste in Terminal (zsh; `/bin/sh` is bash 3.2) → Connected; create a workspace; terminal and chat work; quit and restart Docker Desktop → the agent returns and the workspace is Running. 2. Single, Container: connected; Docker Desktop's file sharing isn't involved. 3. Single, Host (preview): install the tools the doctor names (`brew install tmux jq util-linux`); consent prompt; launchd agent keeps it after logout and reboot; uninstall removes it. 4. `shasum` and `base64` differences: the "Verify first" command works.

**D2 Windows (PowerShell 7 and Windows PowerShell 5.1, Docker Desktop, WSL2 backend).** 1. Docker cluster and Single container commands connect. 2. The token never appears in `docker inspect` of the agent or in the PowerShell history beyond the pasted line. 3. Windows-containers mode → the installer says to switch. 4. Uninstall leaves workspaces. 5. Host on Windows: the wizard disables it and says WSL2; inside a WSL2 shell the Linux Host command works.

**D3 Kubernetes (k3s on real nodes, then a managed cluster).** `kubectl auth can-i` rows in the installer all pass with the Role of §13.5; restricted pod security admits the Deployment; the agent survives a pod deletion without enrolling again; workspaces are created, exec'd and removed; `kubectl get all,pvc,secret -n <ns>` shows only labelled objects; uninstall leaves the namespace and the claims; (foundation F3, when built) a Secret delivery lands.

**D4 Swarm (two or more nodes).** One command on the manager; every node enrolls; a workspace on a chosen worker; the token is gone from `docker service inspect` afterwards; a node drained in swarm and in the portal.

**D5 Cloudflare.** The tunnel carries the agent for a day: reconnects, pings, an Access policy bypassing `/connect/` (or the second hostname), `Origin` and `Host` intact, nothing cut at 100 s.

**D6 Private CA and proxies.** Caddy's internal CA: the wizard's private-CA command works on a fresh host; a corporate proxy with `HTTPS_PROXY` works; one that strips WebSocket upgrades fails with `doctor`'s explanation.

**D7 Odd hosts.** SELinux enforcing (RHEL family) with the socket mount; rootless Docker and Podman (expected: refused with a clear message); an ARM host (Apple silicon Docker Desktop, a Raspberry Pi): the images and the pty package have arm64 builds.

## Appendix E: seams (the text of `apps/server/src/connect/seams.ts`)

T1 creates this file verbatim before anything else, announces it, and T2, T3 and T4 import from it. Additions are allowed; changes to a signature go through the coordinator.

```ts
import type { Duplex } from 'node:stream';
import type {
  ConnectAgentHello, ConnectEnrollment, ConnectEnrollStatus, ConnectHostOpen, ConnectInstallOptions, ConnectKind, ConnectNodeView,
  ConnectStatusMessage, ConnectStreamError, ConnectTargetSettings, Workspace,
} from '@portal/contracts';
import type { Runtime } from '../workspaces/runtime.js';

/** What a call over the tunnel fails with when there is no tunnel or the agent refused. */
export class ConnectError extends Error {
  constructor(readonly code: 'agent_offline' | 'target_removed' | ConnectStreamError, message: string) { super(message); }
}

/** A stream to a service on the agent, shaped like a connected socket (the net.Socket methods an http.Agent calls are no-ops). */
export type TunnelStream = Duplex & {
  setKeepAlive(enable?: boolean, ms?: number): TunnelStream; setNoDelay(on?: boolean): TunnelStream;
  setTimeout(ms: number, cb?: () => void): TunnelStream; ref(): TunnelStream; unref(): TunnelStream;
};

export interface NodeInfo { hello: ConnectAgentHello; status: ConnectStatusMessage | null; connectedAt: string; rttMs: number | null; ip: string | null }

/** One per node. Always exists for an enrolled node; `connected()` says whether the tunnel is up. */
export interface NodeLink {
  readonly nodeId: string;
  readonly targetId: string;
  connected(): boolean;
  /** Resolves when the agent accepted the stream; rejects with ConnectError. `args` is for `host` only. */
  open(service: 'docker' | 'kube' | 'host', args?: ConnectHostOpen, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<TunnelStream>;
  info(): NodeInfo | null;
  /** Fires on connect (true) and on disconnect (false). Returns an unsubscribe. */
  onChange(fn: (connected: boolean) => void): () => void;
  /** The per-connection bearer for the Kubernetes loopback listener; null when not connected. */
  kubeToken(): string | null;
}

export interface ConnectTargetRecord {
  id: string; label: string; kind: ConnectKind; portalUrl: string; settings: ConnectTargetSettings; active: boolean; isDefault: boolean;
}
export interface ConnectNodeRecord { id: string; targetId: string; name: string; drained: boolean; keyFingerprint: string }

/** What a runtime needs from the registry (T1 implements; T3 consumes). */
export interface RuntimeDeps {
  portalId(): string | null;
  /** The workspace image for this target (settings, else the portal's PORTAL_CONNECT_WORKSPACE_IMAGE). */
  image(target: ConnectTargetRecord): string;
  snapshots: { save(targetId: string, list: Workspace[]): void; last(targetId: string): { at: string; workspaces: Workspace[] } | null };
  /** A single's "switched on" flag. */
  switch: { get(targetId: string): boolean; set(targetId: string, on: boolean): void };
  log(line: string): void;
}

/** T3 implements it; T1 calls it when a target becomes usable or changes. One Runtime per target. */
export type RuntimeFactory = (target: ConnectTargetRecord, nodes: { record: ConnectNodeRecord; link: NodeLink }[], deps: RuntimeDeps) => Runtime;

/** What T4's routes need from T1: look a token up without using it. */
export interface EnrollmentLookup {
  /** The enrollment behind a token, or null when no such token exists. `usable` is false once expired, revoked or used up. */
  lookup(token: string): { enrollment: ConnectEnrollment; target: ConnectTargetRecord; options: ConnectInstallOptions; usable: boolean } | null;
  /** `enroll/status` for a token still inside its grace: waiting, enrolled, connected, expired or revoked. */
  status(token: string): ConnectEnrollStatus | null;
}

/** What `createInstallRoutes(deps)` (T4) is given. The bundle comes from T2's generated file. */
export interface InstallDeps {
  enrollments: EnrollmentLookup;
  bundle: { build: string; sha256: string; version: string; source: string };
  config: { baseImage: string; workspaceImage: string; caPem: string | null; allowHttp: boolean };
  /** The workspace image's build context (Dockerfile and cp-session) as a tar.gz stream, for PILOT_BUILD_IMAGE=1. */
  workspaceContext(): NodeJS.ReadableStream;
  log(line: string): void;
}

export interface ConnectModuleApi {
  useRuntimeFactory(f: RuntimeFactory): void;
  /** Adds, replaces and removes the enrolled targets' runtimes on the manager as the registry changes. */
  bind(workspaces: {
    addRuntime(r: Runtime): void; replaceRuntime(r: Runtime): void; removeRuntime(targetId: string): void;
    hooks: { beforeCreate?: (target: string, node?: string) => void };
  }): void;
  /** Resolves when every enrolled target has had a first connection, or after `ms`. */
  settled(ms: number): Promise<void>;
  /** For the manager's create: throws LIMIT_REACHED / CONFLICT when the quota or a drain says no. */
  canCreate(targetId: string, node?: string): void;
  /** Called with a target id when any of its nodes connects. */
  onReturned(fn: (targetId: string) => void): () => void;
  nodeViews(targetId: string): ConnectNodeView[];
}
```
