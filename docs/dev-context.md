# What a new development session must know

Written 2026-10-13 from the coordinating session that built most of ClaudePilot's current state. Read this before you change anything; it is short on purpose.
The long records are in `docs/open-items.md` (state and open work), `docs/prd/` (what each area must do) and `docs/coord/` (how the multi-agent rounds ran: plans, prompts, ledgers).

## Two deployments

| | Docker on the owner's Mac | isnan k3s cluster |
| --- | --- | --- |
| Address | https://pilot.dev.isnan.me (Caddy, internal CA) | https://pilot.ai.isnan.me (Traefik, private DNS only) |
| How it deploys | `deploy/compose.yaml`, `docker --context host` from the owner's dev container | Argo CD app `isnan-claudepilot` follows `main`, directory `deploy/k3s`; images built in the cluster |
| Workspaces | Docker containers | Kubernetes pods in `isnan-claudepilot-workspaces` (this workspace is one) |
| Reach from here | no | yes (`kubectl`, cluster-admin) |
| Sign-in | the owner's server code | `00000000` (a lab; the owner knows; rotate with the Secret `claudepilot-server`) |

Branches: `integration` is where work happens; `main` is what Argo CD deploys (pushing it deploys); `wip/stopped-by-quota-*` holds parked unfinished work (multi-user identity and authorization, the auto-transfer web half; its migrations 400-401 are NOT released); tags `release-*` mark gated releases.

## Decisions that shape the code

- **One owner today, multi-user designed.** Every route and tool goes through the authz seam (`apps/server/src/authz/seam.ts`: `actorOf`, `can`, `requireCan`, `visible`; declared in each module's `authz.ts`). `u_owner` owns everything. The multi-user design (identity, one authorization layer, sharing, teams: `docs/prd/multi-user.md`, `authorization.md`, `identity-onboarding.md`) waits for the owner's decisions MO1-MO15. The first multi-user release changes sign-in: never deploy it without the owner holding the setup token.
- **Bypass is gated** (policy switch `sessions.allowBypass`, a bypass-capable session, an acknowledgement, a fresh server code) and a relaunch used to drop it (FR20, FR38). The owner wants a deliberate restart or a Move to keep it: see `docs/prd/chat-sessions.md`.
- **Pools are delivered through `runtime.delivery`** (state, run, put, read, watchStarts). Docker, local and Connect had it; Kubernetes got it on 2026-10-13 (`workspaces/kubernetesDelivery.ts`): exec into the pod, root only through `sudo -n`, the pod spec never runs as root (the Connect kube agent's policy refuses it: `connect/agent/services/kube/schema.ts`).
- **Kubernetes runtime settings** (env, `apps/server/src/config.ts`): `PORTAL_K8S_NAMESPACE`, `_IMAGE`, `_STORAGE_CLASS`, `_NODE_SELECTOR` (keep pods off the control-plane node), `_CPU_REQUEST` and `_MEMORY_REQUEST` (what a pod reserves; with only limits Kubernetes reserves the whole limit and a 2-CPU workspace stayed Pending while the node was 40% busy).
- **Images are built in the cluster** (kaniko Jobs, `deploy/k3s-build/`, `scripts/k3s-build.sh`) and pushed to `registry.int.isnan.me`. The nodes are amd64; the sandbox where most work was done is arm64. The workspace image pins Claude Code (`images/workspace/Dockerfile`, `claudeversion` module); `Dockerfile.dev` adds Chromium, shellcheck and kubectl.
- **Connect** (agents that dial out) is on in both deployments; its full acceptance and abuse suite (A1-A14) has not run. Treat its endpoints as exposed.
- **Secrets**: the portal seals stored secrets with a key (`PORTAL_SECRET_KEY_FILE`); without it the store starts LOCKED. On the cluster it is the Secret `claudepilot-secret-key`. Keep a copy somewhere else.
- **Features that are settings** (off by default, on for the cluster by `deploy/k3s/seed-features.sh`): triggers, auto move (ask and automatic), agents self-edit. Left off on purpose: bypass sessions, auto move to an API key, the MCP lockdown switches, the "This machine" target.

## Pitfalls that already cost time

1. **Tests with a fixed date** fail the next day (the auto-transfer route test did). A test on the real clock uses times relative to now.
2. **Run the gate on a clean copy** (`scripts/gate.sh`): code that needed columns from an unreleased migration passed on the working tree and failed on the copy.
3. **local-path volumes are root-owned**: `cp -a` as uid 1000 fails to set the folder's times; use `cp -a --no-preserve=all`. Never fix it by running a container as root.
4. **A pod with limits and no requests reserves its whole limit.** A LimitRange `defaultRequest` does not help (defaulting copies limits first).
5. **Pushing images from outside the cluster fails** (slow uplink, a 60 s request cut at the ingress, Cloudflare's 100 MB request cap). Build in the cluster.
6. **kaniko has no BuildKit secrets**: `deploy/k3s-build/portal.Dockerfile` takes the npm token as a build argument of the discarded first stage.
7. **Two overlapping body scroll locks leave a page unscrollable**: the kit's Dialog and the palette both save and restore `body.style.overflow`. `lib/scrollGuard.ts` heals it; the real fix belongs in the kit (`@isnanme/ui`, the owner's package, read-only in `node_modules`).
8. **The server code is exactly 8 letters or digits**; anything else stops the portal at start.
9. **Token-shaped literals** (GitHub tokens, `sk-ant-`, PEM blocks, webhook URLs, even long key=value strings) in a test or a doc block the push. Build them at runtime; `docs/coord/scan-show.mts` shows what the scanner flags.
10. **`pkill -f <pattern>` kills your own shell** when the pattern is in your command line. Kill by PID or by tmux session.
11. **Too many agents at once exhaust the account's limit** (13 did, twice): at most four to six, one or two planners at a time, fable only when credits allow.
12. **A scratch portal inherits your environment** unless started from `env -i`: here that means a cluster-admin kubeconfig and the GitHub token. `scripts/scratch-portal.sh` does it right.
13. **Docker-only tests** (23 of them, `CLAUDEPILOT_DOCKER_TESTS=1`) cannot run in a pod; they run on a machine with a Docker daemon.

## How the owner works

Casual Indonesian or English, short messages, often several requests in a row from a phone while looking at the app. Pictures of the screen are common: look at them. They want it simple, symmetric and quiet (text diet, glass bars, one clear action). They test on an iPhone PWA (Safari, standalone): safe areas, the status bar, rubber-banding and keyboard behaviour matter. They accept risk in a lab (weak sign-in code, cluster-admin in a workspace) but want to be told. They want sessions (agents) to deploy and monitor by themselves: scripts and pipelines beat manual steps.

## Where things stand (2026-10-13)

Built and live on the cluster: the portal, Kubernetes workspaces, the three signed-in Claudes, the Portal MCP with agent access for this workspace, notifications, usage, glance, triggers, auto move, Connect. In flight: Kubernetes delivery in the cluster (code committed, not yet deployed), session restart without losing context and Bypass kept across a Move and a restart and the Auto permission mode (agent SR), the phone look of the session page and tab bar (agent UX1), a pilot CI pipeline that deploys to the cluster (agent CD1). Deploying any of it needs a new image and a push of `main`: ask the owner or use the pipeline.
