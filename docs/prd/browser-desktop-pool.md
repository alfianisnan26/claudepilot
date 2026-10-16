# PRD: Browser & desktop pool

| | |
| --- | --- |
| Status | **Draft v0.4.** Built on Docker and verified (2026-10-12): the pool type and editor, the browser container, the gate with Playwright MCP, the VNC live view with control, Private and handoff, and the proxy view (§22). Built on Kubernetes and verified on a rig namespace of the k3s cluster (2026-10-13, B3): the browser as a second container in the workspace's pod, a Playwright MCP call from a chat session, the live view, a handoff with take-over pausing the tools; see §18 for each milestone's state and §23 for what the build changed. Request headers from named secrets (§24, T-623) are built and unit-tested; not yet run against a real Chromium or the Kubernetes API (§24 "Not verified"). Not built: the desktop tier and its MCP server, Monitoring and chat panels, Downloads and Send a file. Revised after the security and UX reviews (v0.2). ✅ = observed in our experiments: Docker 29.9 DinD on arm64; Chromium 154 headful under Xvfb at 1280×800 and chrome-headless-shell 156 at 800×600; Playwright MCP 0.0.83 and chrome-devtools-mcp 1.10.1 driven by an MCP probe client; Claude Code 2.1.296 (`claude mcp list`); read-only checks and one server-side dry run on the k3s cluster. 🗂 = seen in the operator's isnan setup (its live configuration, read-only, or its own notes), not tested by us. 📄 = vendor documentation. 🔬 = unverified, listed in §21. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-15 |
| Depends on | [Pools foundation](foundation-pools.md) (storage, delivery, structure manager, plugin marketplace), [MCP set](mcpset-pool.md) (plugin and install conventions), [Web app & PWA](web-app-pwa.md) (immersive routes, devices, HTTPS, push) |
| Related | [Settings & policies](settings-policies.md) (tool rules, allow group, network isolation values), [Chat sessions](chat-sessions.md) (handoff card, Browser panel), [Monitoring dashboard](monitoring-dashboard.md), [Portal MCP server](portal-mcp.md) |

## 1. Summary

Browser & desktop pool gives the agent in each workspace its own browser, and optionally a Linux
desktop, as tools it drives over MCP. People watch it live in the portal on a phone or a desktop, and
take control when the agent needs a human: to sign in, pass 2FA or a CAPTCHA, or fix something. Each
workspace gets one browser container in its network namespace: a companion container on Docker, a
second container in the pod on Kubernetes. CDP stays on `127.0.0.1` ✅, and Playwright MCP runs over stdio
in the workspace against it ✅, delivered as a portal plugin behind a small gate; the portal is never in
the tool path. The live view is noVNC, bridged through runtime `exec` streams to a VNC unix socket, with
view-only enforced in the bridge. Control is a lease held by one person's device: while it lasts, the
agent's browser tools wait, and during a sign-in other viewers see nothing.

## 2. Background and problem

- Agents can't test what they built, read a JavaScript page or finish a task behind a login. Chrome
  installed by hand shares Claude Code's memory and can't be watched.
- Claude in Chrome needs a claude.ai login and stays off under API keys 📄; Claude Code's computer use
  runs on macOS only 📄. Account Pool workspaces are Linux with API keys, so the pool ships its own servers.
- CDP and VNC have no authentication; whoever reaches CDP reads every cookie 📄. Docker's default bridge
  lets workspaces reach each other ✅, and k3s runs with `--disable-network-policy` ✅. isnan's agent
  computer proves the pattern 🗂, but its central MCP proxy would put the portal in the tool path, and its
  Xvnc listens on `0.0.0.0:5920` with no authentication ✅ (checked in its pod; any pod can likely reach it).

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Tools for the agent.** A browser per workspace, and a desktop where needed, driven over MCP with no setup, on DinD, host Docker and Kubernetes. |
| G2 | **Isolated by construction.** CDP, VNC and every helper stay on loopback or a unix socket in the workspace's namespace, hardened against web pages. No Service, published port or CDP proxy: the portal reaches the browser only through the bridge (§12) and the proxy view's helper (§22), which speaks a small fixed message set. |
| G3 | **Watch and help.** A live view on phone and desktop, view-only by default; control leased to one device; a sign-in handoff that pauses the agent's browser tools, hides the screen from other viewers and takes no screenshots. |
| G4 | **Cheap when idle, never in the way.** Explicit requests and limits; Chrome starts on first use and stops when idle; a browser fault never stops Claude Code or marks the workspace Error. |
| G5 | **Native and push-only.** Claude Code's own MCP support through files; portal-initiated runtime calls only. |
| G6 | **Honest.** Every screen says what is enforced and what isn't: the agent and workspace users can read the browser's cookies and send anything they can read to any site it reaches. |
| G7 | **A browser preview that is a web page.** The owner's request: besides the VNC screen, a proxy view the portal draws itself (frames, an address bar, tabs), usable on a phone, with the agent and the person driving the same Chromium (§22). |

## 4. Non-goals

- **Anti-bot evasion, CAPTCHA solving, fingerprint or user-agent spoofing, stealth plugins, rotating
  proxies, mass account automation.** People handle logins, 2FA, QR codes and CAPTCHAs in the live view.
- **Claude in Chrome, computer use,** an MCP proxy in the portal, a raw CDP proxy (the proxy view of §22 forwards a fixed, validated message set, never CDP), and any browser or desktop shared
  between workspaces, external agent desktops such as isnan's Coder computer included (Q18).
- **Website credentials** in the portal, or typed for the agent (Q19). **Protecting the browser from its
  own workspace,** which can reach CDP ✅ and read the profile, as it reads delivered secrets (foundation
  §11). Session recording, stored screenshots or thumbnails (Q16), audio, GPU, Windows or macOS desktops.

## 5. Users and stories

**Admin**: manages pools and workspaces. **Workspace user**: works with the agent, often from a phone.
**Agent**: Claude Code, which may follow instructions injected by web content.

| ID | Story |
| --- | --- |
| US1 | As an admin, I pick a tier (Headless, Browser, Desktop) for a browser pool and assign it when I create a workspace, or later. |
| US2 | As a workspace user, I ask Claude to check the sign-up flow of the dev server it just started at `localhost:5173`; it uses the browser with no setup and no approval per click. |
| US3 | My phone shows "Sign-in needed · api-dev". Two taps later I'm typing my password. I switch to my authenticator for the code, come back still in control, and hand back. Nobody else saw the screen, and the agent took no screenshot. |
| US4 | I paste my password from my password manager into the live view, on my phone or my laptop. |
| US5 | I watch the agent from my phone, and a stray tap can't click anything. |
| US6 | On my laptop I watch the browser in a panel beside the chat. |
| US7 | I take control mid-task to fix something; the agent's browser calls wait until I hand back. |
| US8 | Claude downloads a CSV. It lands in `~/Downloads`, Claude reads it, and I download it from the portal. |
| US9 | As an admin, I assign a Desktop pool, and Claude uses a GUI app through screenshot and click tools. |
| US10 | As an admin, I see which browsers run and what they use; idle ones stop, and a browser crash leaves the workspace running. |
| US11 | As an admin, I reset a workspace's browser data to sign it out everywhere; the data goes when the browser is unassigned. |

## 6. Scope boundary

| Allowed | Not allowed |
| --- | --- |
| Browsing with accounts a person signs in to through the live view, and a person solving a CAPTCHA, 2FA or QR prompt there. | The portal collecting, storing or typing website passwords, 2FA codes or session cookies; automated CAPTCHA solving, evasion flags, spoofed fingerprints or user agents, rotating proxies. |
| Reviewed, pinned MCP servers delivered as a portal plugin, through Claude's own MCP support with API-key credentials. | `npx …@latest` at runtime; Claude in Chrome, computer use, or any claude.ai credential. |
| Viewing a workspace's browser from the signed-in portal, and controlling it over HTTPS or localhost. | Relaying raw CDP or VNC to the user's browser, or publishing either port. |
| What sites' terms allow; the operator answers for that. | Any feature whose purpose is to hide automation. |

## 7. Solution overview

```
 Portal                               Workspace network namespace (127.0.0.1 shared)
 ┌────────────────────────────┐       ┌───────────────────────────┐ ┌──────────────────────────────┐
 │ Browser pools (revisions)  │ push  │ workspace container       │ │ browser container            │
 │ Compiler: plugin, drop-in, │──────▶│ claude ─stdio─▶ gate ─▶   │ │ supervisor :9220 (uid 1001)  │
 │  Chrome policy, spec       │       │  Playwright MCP ── CDP ───┼─┼▶ Chromium :9222 (uid 1000)   │
 │ Structure manager          │create │ ~/Downloads ◀─────────────┼─┼─ same folder, mounted        │
 │ Live-view bridge: roles,   │──────▶│                           │ │ Xvfb, x11vnc on vnc.sock     │
 │  lease, Private            │       └───────────────────────────┘ │ desktop MCP :8930 (Desktop)  │
 │                            ├──── exec (uid 1001) + socat ───────▶┤                              │
 └────────────────────────────┘                                     └──────────────────────────────┘
```

Pools are templates (§8); the structure manager adds the browser container (§10); the plugin and gate
deliver MCP (§11); the bridge serves the live view under a lease (§12); Chrome sleeps when idle (§14).

## 8. Functional requirements

| ID | Requirement |
| --- | --- |
| | **Pools** |
| FR1 | Tiers. **Headless**: Chromium with no display. **Browser** (default): headful Chromium with openbox on a virtual display, with a live view. **Desktop**: the same plus a panel, terminal, file manager and a desktop MCP server (Q14). One image (§14.1). |
| FR2 | Resources: CPU and memory requests and limits (§14.1), `/dev/shm`, a PIDs limit, and the display (1280×800 default; 1024×768, 1366×768, 1920×1080), with each size's screenshot cost: about 1.3k image tokens at 1280×800, 2.6k at 1920×1080 📄. |
| FR3 | Engine: Chromium (amd64 and arm64), or Google Chrome on amd64 targets only (🔬 Q10). A Chrome pool is refused on arm64 targets with the reason, never swapped. |
| FR4 | Profile: **Persistent** (in the home volume) or **Fresh** (wiped at each browser start). Agent sessions: **Shared logins** (one default context; the gate gives each Claude session its own tab) or **Isolated** (`--isolated`: a context per Claude session, lost when it ends ✅ or when a chat session sleeps, Chat FR38). Browser and Desktop default to Persistent and Shared, Headless to Fresh and Isolated. |
| FR5 | Downloads land in `~/Downloads`, mounted at the same path in both containers; how Playwright's downloads get there is 🔬 Q3. "Block all downloads" is a switch (`DownloadRestrictions: 3`). Blocking dangerous types (`1`) relies on Safe Browsing data that Debian Chromium may lack, so it's labeled best effort (🔬 Q3). |
| FR6 | Chrome policies: blocked sites, an allowlist mode (block all but listed sites), extensions (none, or reviewed IDs), and the baseline in §13, in a root-owned managed policy file, never as flags. |
| FR7 | MCP servers: Playwright MCP (always), chrome-devtools-mcp (optional), the desktop server (Desktop). Tool rules per tool, as MCP set FR12: Default · Ask every call · Block. Defaults: Ask for `browser_file_upload` and devtools' network tools, Block for `browser_run_code_unsafe`. Settings' Browser allow group covers navigation, snapshot and input tools (A8); `browser_handoff` and `browser_status` never ask. |
| FR8 | Start **On first use** (default: the first tool call or viewer) or **With the workspace**. Idle stop after 30 minutes without a call, viewer or control (Desktop 120, or never). |
| FR9 | Switches: Live view, Take-over, and Private for every take-over (handoffs are private by default, A8). Headless gets a view-only screencast and no handoff (§12.1). |
| | **Assignment and runtime** |
| FR10 | Assign at create (Add-ons), from the workspace page, or in bulk: one pool per workspace, following current or pinned (foundation §5). |
| FR11 | Before a change that restarts anything, the dialog says what: Docker recreates the browser container once it's idle and the workspace keeps running; Kubernetes restarts the pod ("Restart now / When it next stops", live sessions counted) after a fit check, and rolls back if the pod stays Pending 5 minutes (§14.1). |
| FR12 | Unassigning removes the plugin and drop-in, then the browser container, and deletes the profile and downloads per §13 unless "Keep browser data" is ticked (Q13). |
| FR13 | The structure manager keeps the browser container in step with the workspace by rule (§10). The browser has its own state (§15.5); a browser fault never sets the workspace to Error or keeps it from starting. |
| FR14 | Self-healing start: stale `Singleton*` locks removed when no Chrome runs 🗂; X and VNC supervised; health read passively from the processes' own sockets, never by connect-and-drop (Xvnc blacklists loopback after 5 failed handshakes 🗂). |
| FR15 | Chrome starts with its sandbox when the target probe says it can. Otherwise it runs with `--no-sandbox` and a "Sandbox off" chip, only where the admin allowed that for the target (A8); Desktop pools and "Require sandbox" pools never do (§13). |
| FR16 | Memory guard: at 80% and 88% of `memory.max`, counting anonymous and shared memory, the supervisor sends `Memory.simulatePressureNotification` (moderate, critical). isnan does the same with anonymous memory 🗂. |
| FR17 | Restart browser, Stop browser, and Reset browser data ("This signs the browser out of every site"), per §13 Profile. |
| FR18 | Security updates: images rebuilt weekly and on each Chrome security release; those revisions skip rollout pacing and apply at the next idle stop (§13 Updates). |
| | **MCP, handoff and live view** |
| FR19 | The `cpb-browser` plugin and `70-claudepilot-browser.json` drop-in on all targets, through the foundation's marketplace, with pinned packages installed from a lockfile (§11). |
| FR20 | The gate answers MCP startup without waking Chrome, wakes it on the first call, refuses calls while a person has control, and redacts credential headers (§11.3). |
| FR21 | `browser_handoff(reason)` reaches the portal within 10 s while the agent is active, and blocks until hand back, decline, 10 minutes of waiting (paused while someone has control), or the person leaving (§12.4). |
| FR22 | An immersive live view per workspace, view-only unless the viewer holds control, enforced in the bridge (§12.2). |
| FR23 | Control is a lease held by one device and kept through app switches and reconnects for 5 minutes (§12.3). Caps: 3 viewers per browser, 20 in total. |
| FR24 | Take control, the text bar and handoff answers need HTTPS or localhost; elsewhere the live view is view-only (§12.1). |

## 9. Data model

Stored in the portal database (foundation §4). A browser pool holds no secrets (its `headers` setting
holds the *names* of Secrets & env entries, never a value, §24), and the portal never
stores frames, keystrokes, clipboard text or cookies. Pools use the foundation's tables with type `browser`:

```json
{ "tier": "browser", "engine": "chromium", "display": "1280x800", "profile": "persistent", "sessions": "shared",
  "resources": { "cpu": [0.5, 2], "memoryMiB": [1536, 3072], "shmMiB": 1024, "pids": 1024 }, "start": "first_use", "idleMinutes": 30,
  "downloads": { "enabled": true, "restrictions": 1 }, "policy": { "blocked": ["metadata.google.internal"], "allowlistMode": false, "allowed": [], "extensions": [] },
  "mcp": { "devtools": false, "desktop": false, "tools": { "browser_file_upload": "ask", "browser_run_code_unsafe": "block" } },
  "liveView": true, "takeOver": true, "privateTakeOvers": false, "requireSandbox": false,
  "headers": [{ "hosts": ["app.stg.example.com", "*.stg.example.com"], "name": "CF-Access-Client-Id", "secret": "CF_ACCESS_CLIENT_ID" }] }
```

| Table | Key fields |
| --- | --- |
| `browser_instances` | workspace_id, pool_id, revision, runtime_ref (container ID, or pod and container), image_digest, chromium_version, state (§15.5), chrome (`asleep` \| `starting` \| `up` \| `closed` \| `crashed`), chrome_boot_id, sandbox (`on` \| `off` \| `unknown`), controller_device, controller_session, control_since, control_lease_until, away_since, front_tab_host, last_activity_at, last_tool, profile_bytes, downloads_bytes, restarts, oom_kills, last_error |
| `browser_handoffs` | id, workspace_id, session_id, chat_request_id, reason (200 characters, redacted, untrusted), origin (scheme and host, read from the tab), state (`waiting`, `in_control`, `handed_back`, `declined`, `expired`, `left`, `cancelled`), requested_at, waited_ms, resolved_at, note (200 characters), device, web_session |

## 10. Topology per target

### 10.1 Docker (DinD and host)

| Setting | Value and reason |
| --- | --- |
| Identity | `claudepilot-<name>-browser`, labels `claudepilot.managed`, `claudepilot.workspace`, `claudepilot.role=browser`, pool and revision. The runtime stays the record. |
| Network | `NetworkMode: container:claudepilot-<name>`: the workspace's loopback and hostname ✅. CDP on `127.0.0.1:9222` answered from the workspace and was refused from another workspace ✅. Docker allows no published ports, hostname, DNS or extra hosts in this mode 📄. The workspace's own network follows §13 Network. |
| Process | A root init holding only `SETUID` and `SETGID` starts the supervisor, Xvfb and x11vnc as uid 1001, and a Chrome launcher as uid 1000, which owns the home volume's files (🔬 Q2). `Init: true`; `RestartPolicy: no`. |
| Limits | `NanoCpus`, `Memory`, `PidsLimit`, `ShmSize` 1 GiB (Docker's default is 64 MiB ✅). Its own cgroup, so a runaway tab can't OOM Claude Code. |
| Hardening | `CapDrop: [ALL]` plus the two above, `no-new-privileges`, seccomp per §13. Policy and supervisor config are `root:root 0644` in root-owned directories, written by the archive API before the first start (A3). |
| Mounts | Two subpaths of the home volume (one subpath tested ✅, Docker 29): `.claudepilot/browser/profile` at `/data/profile` and `Downloads` at `/home/node/Downloads`, created first over `exec` with explicit modes (`0700`), since DinD's exec umask is `0000`. Never the whole home. |
| Convergence | After a workspace `docker restart`, a companion still showed Up in a dead network namespace, and it can't start while the workspace is stopped ✅. So at every reconcile, and whenever the portal or its Docker event stream (re)connects (resuming with `since`), the portal restarts or recreates a companion whose `State.StartedAt` is older than the workspace's or whose NetworkMode names another container ID, and stops it while the workspace is stopped; a portal stop stops it first, so Chrome flushes cookies. Anything that recreates the workspace (Switch image, `SecurityOpt`, tmpfs, `ShmSize`, the network move) recreates the companion after it (A2). Removal goes companion, workspace, then volume. A workspace restarted while the portal is down has no working browser until the portal returns, and the row says so. |

### 10.2 Kubernetes

| Setting | Value and reason |
| --- | --- |
| Placement | A regular container named `browser` in `containers`, after `workspace`. Not a native sidecar: one gated on its startup probe holds back the workspace container while the 1.6 GB image can't be pulled or the browser crash-loops 📄, and nothing needs that order, since Chrome starts lazily. A dry run of a native-sidecar Deployment with a memory-backed `/dev/shm` and an `exec` probe passed on the cluster (k3s v1.35.5) ✅; this layout is 🔬 Q1. **Built (B3) ✅:** on the rig the pod ran `workspace` and `browser` side by side on k3s-master; the workspace container started at 13:21:16 and ran while the browser's first image pull took 3 min 14 s (486 MiB compressed), and a pull that failed (`ErrImagePull`) left the pod in phase Pending with the workspace Running and a chat session answering ✅. |
| Probes | Liveness `exec cpb-ctl alive` every 30 s restarts only this container. No readiness probe, so pod readiness follows `workspace`. Kubelet TCP and HTTP probes target the pod IP and never see loopback listeners 📄. |
| Resources | Explicit requests and limits for both containers (A2). **Decided (B3):** the browser requests 100m CPU and 512 MiB and is limited by the pool (2 CPU, 3 GiB by default), see §14.1 Kubernetes fit; observed on the rig: 121 MB with Chrome asleep, 601 MiB and 164m CPU with three tabs of example.com ✅, so light use already sits above the memory request: the pod is an eviction candidate only under node memory pressure, and memory is not what is short on k3s-node2. A browser above its memory request makes the whole pod an eviction candidate, Claude Code included 📄, so the request sits near heavy use (§14.1). `/dev/shm` is an `emptyDir` with `medium: Memory` and the pool's `sizeLimit`, counted against the browser's memory 📄. |
| Mounts | Home PVC `subPath` mounts for the profile (`/data/profile`) and `Downloads`, nested in an `emptyDir` at `/home/node` so Chrome has a writable home (`~/.pki`, `~/.cache`). `seed-home` creates both subpaths with mode `0700` at every start (A2). ConfigMap `ws-<name>-browser` (ownerReference, no secrets) as two read-only volumes: the policy folder and `/etc/cpb`. |
| Security | Observed (B3) ✅: Chromium's sandbox does not start under the container runtime's `RuntimeDefault` seccomp profile ("No usable sandbox"), so the pool's config says `sandbox: auto`: the init tries it once before Chrome's first start (3.5 s on the rig) and runs Chrome without it unless the pool requires it, and the row shows "No sandbox". A `Localhost` profile needs files on the nodes (Q2). The same users as Docker: `runAsUser: 0` with every capability dropped but `SETUID` and `SETGID`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem` with `emptyDir`s for `/tmp`, `/run/cpb` and `/home/node`, and `seccompProfile` set explicitly (§13), since the kubelet's default is Unconfined. Pod: `automountServiceAccountToken: false`. On SIGTERM the supervisor closes Chrome with CDP `Browser.close` within 3 s (grace 5 s). |
| Restarts and status | Adding or removing the container restarts the pod (strategy `Recreate`), batched by the template manager (A2). **The restart rule (B3):** the portal changes the template only while no workspace container runs: stopped, the moment before a start (the runtime's `start` is wrapped), or still coming up (a new workspace, a pod waiting for an image or a node), so nothing is ever lost. A running workspace waits for its next start: one without a browser yet shows Restart needed; one whose browser changed keeps it working, live view and all, and says "The browser changed: restart the workspace to apply it." ✅ (on the rig a new workspace got its browser during its first start, and a pool change was applied by a stop and start, both containers Ready 11 s after the start with the image cached). Workspace status follows the `workspace` container's own readiness, never pod phase ✅; usage is per container: the workspace's row counts only its own container ✅. |

### 10.3 What a change costs

| Change | Docker | Kubernetes |
| --- | --- | --- |
| Assign, unassign, tier, engine, resources | Companion created, removed, or recreated once the browser is idle; the workspace keeps running | Pod restart, confirmed and batched (FR11) |
| Policies, idle, profile mode | Config rewritten; Chrome restarts at its next idle stop or on Restart browser, never during control or a waiting handoff ("Applies when the browser is idle") | ConfigMap update, same rule (🔬 Q11) |
| Security image update | Companion recreated at the next idle stop, skipping pacing | The running pod's `browser` image patched in place, the template at the next stop (🔬 Q1) |
| Plugin, servers, tool rules | Workspace files only. Terminals pick up plugin changes after `/reload-plugins` 📄 (🔬 Q5: are stdio servers restarted?); chat and `-p` sessions at the next session (MCP set §10.3), so chat shows "Start a new session to use the browser"; tool rules at the next tool call 📄 (🔬 Settings Q2) | Same |
| Take-over; Chrome asleep, awake or restarted | Next tool call, through the gate | Same |
| Workspace restart or recreate | Converged by rule (§10.1) | The browser restarts with the pod |

## 11. MCP wiring and delivery

### 11.1 What gets written

| Path | Content |
| --- | --- |
| `/etc/claude-code/managed-settings.d/70-claudepilot-browser.json` | `enabledPlugins`: `"cpb-browser@claudepilot": true`. `permissions.ask` and `permissions.deny` for tool rules, as `mcp__plugin_cpb-browser_<server>__<tool>`, plus Read and Edit deny for `~/.claudepilot/browser/profile/**` (A6). `permissions.additionalDirectories`: `/home/node/Downloads`, so Claude reads downloads and Playwright output without prompts (🔬 Q3). `env`: `CLAUDEPILOT_BROWSER_CDP` and `CLAUDEPILOT_BROWSER_DOWNLOADS`, written empty when unassigned (foundation §6.4). |
| `/etc/claudepilot/marketplace/plugins/cpb-browser/<hash12>/` | `plugin.json`, `.mcp.json` (below), and `skills/browser/SKILL.md`: snapshots before screenshots, one tab per task, `browser_handoff` for logins, 2FA and CAPTCHAs, no screenshots while a person types, never run a download, files in `~/Downloads`. Versioned folders with a repointed entry, as Skillset does. |
| `/etc/claudepilot/bin/browser-mcp` | The gate (§11.3), under the type's `browser-*` prefix (foundation §7). |
| `~/.cache/claudepilot/browser/npm/` | `@playwright/mcp@0.0.83` and `chrome-devtools-mcp@1.10.1`, installed with `npm ci` from a lockfile committed per pool version (integrity hashes), through the run-in-workspace step (MCP set A4). Never `npx` at runtime, and never MCP set's folder. |
| Not used | `managed-mcp.json`: Claude Code loaded Playwright MCP from it ✅, but it takes exclusive control (`claude mcp add` then failed ✅) and would block every plugin server 📄. `managedMcpServers` takes only remote HTTPS servers 📄 (A1). Allowlist matchers follow MCP set FR19: `serverCommand` with the gate's exact argv, `serverUrl` for `desktop`. |

Isolated pools add `--isolated` to the `browser` entry:

```json
{ "mcpServers": {
    "browser":  { "command": "/etc/claudepilot/bin/browser-mcp", "args": ["playwright", "--",
                  "--cdp-endpoint", "http://127.0.0.1:9222", "--output-dir", "/home/node/Downloads/.playwright"] },
    "devtools": { "command": "/etc/claudepilot/bin/browser-mcp", "args": ["devtools", "--",
                  "--browser-url", "http://127.0.0.1:9222", "--no-usage-statistics", "--no-performance-crux"],
                  "env": { "CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS": "1", "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS": "1" } },
    "desktop":  { "type": "http", "url": "http://127.0.0.1:8930/mcp", "headers": { "X-CPB": "1" } } } }
```

### 11.2 Servers

| Server | Notes |
| --- | --- |
| `browser`: Playwright MCP, stdio in the workspace through the gate | Drove the browser container's Chrome over CDP from an MCP probe client ✅, and Claude Code listed it Connected when loaded from `managed-mcp.json` ✅. 25 tools; text snapshots keep context small; uploads stream files from the workspace ✅; a download click saved nothing ✅ (Q3). Tool schemas change between releases ✅ (`browser_click` now takes `target`): pinned, with contract tests. Names look like `mcp__plugin_cpb-browser_browser__browser_navigate`; the longest known is 61 characters, inside MCP set FR18's limits (names over 64 work ✅; past 128 are flagged). |
| `devtools`: chrome-devtools-mcp (optional), stdio through the gate | 30 tools ✅: traces, Lighthouse, console, network bodies. Uploads need the file at the same path in the browser container (a workspace-only path sent 0 bytes ✅) and inside the client's MCP roots (others were refused ✅), so the skill uploads from `~/Downloads` (🔬 Q3). Network tools return headers and bodies: the gate redacts credentials, and they ask by default. Telemetry off by flag and variable. |
| `desktop` (Desktop tier): first party, Streamable HTTP on `127.0.0.1:8930` in the browser container | Computer-use vocabulary: `screenshot`, `click`, `double_click`, `right_click`, `move`, `drag`, `scroll`, `type`, `key`, `open_url`, `launch` (desktop entries from an allowlist, never commands), `wait`. Screenshots only when asked. `xdotool` and `scrot` drove a 1280×800 display ✅. Hardened per §13 Loopback services; Playwright's HTTP mode showed why: by default it bound only `::1`, and its host check made Claude Code show "Needs authentication" ✅. Loading it from a plugin is 🔬 Q5. |

### 11.3 The gate

`browser-mcp <server> -- <args>`, a dependency-free Node script. It pauses cooperative agents; it isn't a
boundary, since anything in the workspace can open CDP.

| Step | Behavior |
| --- | --- |
| Startup | Answers `initialize` and `tools/list` itself, from the pinned server's schema cached at image build plus `browser_handoff(reason)` and `browser_status()`, so a session start never wakes Chrome. |
| First call | Wakes Chrome (`POST 127.0.0.1:9220/wake`, up to 30 s), starts the pinned server and replays `initialize`. With shared logins it first opens a tab for this session. When `/status` shows a new Chrome boot ID (idle wake, new revision), it restarts the server and replays (🔬 Q6, Q7). |
| Control | Each `tools/call` reads the control state (cached 1 s). While a lease is held it returns a tool error instead of forwarding: "A person has control of the browser since 14:02. Wait, then call browser_snapshot." It reports activity (time, tool, session, tab) to the supervisor. |
| Redaction | Replaces the values of `cookie`, `set-cookie`, `authorization`, `proxy-authorization` and `x-api-key` headers in every result, so live sessions stay out of transcripts and Chat's stored events. |

## 12. Live view and take-over

### 12.1 Path

| Part | Requirement |
| --- | --- |
| Socket | `GET /api/workspaces/:target/:name/browser/view`, checked like the shell socket (Origin equals Host, session cookie). It pings every 25 s and re-checks the session every 60 s and on sign-out, device sign-out or code rotation; on failure it closes and releases control. |
| Secure context | Input is allowed only on the app listener behind HTTPS (Web app §12.2) or from a loopback peer (localhost, the VS Code forward), as the server sees it. Elsewhere the socket is view-only: over plain HTTP, keystrokes, website passwords included, would cross the network in the clear, and the session cookie lacks `Secure`. |
| Bridge | An `exec` in the browser container as uid 1001 (Docker's exec user; on Kubernetes, `setpriv` first) running `socat -t 5 STDIO UNIX-CONNECT:/run/cpb/vnc.sock`. An exec stream read `RFB 003.008` from a loopback x11vnc ✅ (over TCP; the unix socket is 🔬 Q4), and socat's default 0.5 s half-close cut the first try ✅. Kubernetes uses the same `exec`; `pods/portforward` reached a loopback-only listener ✅ and stays the fallback. |
| x11vnc | `-forever -shared -alwaysshared -dontdisconnect -rfbport 0 -unixsock /run/cpb/vnc.sock -nosel -passwdfile`, with a full and a view-only password made at each start and readable only by uid 1001; the socket is `0600`. No websockify, web server or port in the workspace. |
| Handshake | Mediated by the bridge: the browser gets RFB 3.8 with security type None, and upstream the bridge authenticates with the password for the viewer's role, so a filter bug can't grant input. It forces ClientInit to shared, so no client can disconnect another. A role change reopens only the upstream connection. |
| Headless tier | No display, so no VNC. The portal opens CDP over the same tunnel (an IP `Host` and no `Origin` pass Chrome's checks ✅) and relays `Page.startScreencast` (JPEG, quality 60) of the active tab, view-only; raw CDP never reaches the user's browser. On headless-shell at 800×600 it sent 1 frame in 2 s idle and about 11 a second at about 52 KB while scrolling ✅; Chromium `--headless` at 1280×800 is 🔬 Q10. |

### 12.2 What the bridge enforces

noVNC's `viewOnly` only stops a cooperative client 📄, so the bridge filters by role; frames pass untouched.

| Client message | Viewer | Controller |
| --- | --- | --- |
| SetPixelFormat (0); SetEncodings (2), at most 64 entries, minus pseudo-encodings that unlock other messages (QEMU keys, fences, continuous updates, resize); FramebufferUpdateRequest (3) | Forward; update requests dropped while Private | Forward |
| KeyEvent (4), PointerEvent (5) | Drop | Forward |
| ClientCutText (6) | Drop | Drop: the clipboard goes through `xclip` (§15.3) |
| Any other type, or an oversized message | Close the socket | Close the socket |

### 12.3 Control and Private

| Rule | Requirement |
| --- | --- |
| Lease | Held in the supervisor: `cpb-ctl control on --holder <device> --ttl 90`, run by the portal as uid 1001 and renewed every 30 s while the holder's device is connected or within its away grace (5 minutes, a Settings row). A portal that dies stops renewing, so control ends within 90 s. After a portal restart a lease survives only if its device reconnects within the grace. |
| Holder | A device and web session (Web app §12.4), never a socket. Switching apps for a password or 2FA code keeps control; on return the view reconnects and says so (§15.6). |
| End | Hand back or Decline, the grace running out, 15 minutes without input after a prompt, a confirmed take-over from another device, sign-out, or the workspace stopping. The supervisor then releases held keys and clears Caps Lock; Hand back also clears the remote clipboard. |
| While held | The gate refuses browser calls; the desktop server refuses screenshots and input; a call already running may finish. The workspace can read the state (`/status`) but not change it. |
| Private | While someone holds control during a handoff (and in every take-over if the pool says so), the bridge drops other viewers' update requests, so x11vnc sends them nothing, and their canvas shows a cover (§15.5). At hand back it sends one full update request per viewer. |
| Load | A tab hidden for 60 s disconnects, while control stays under its lease. Chat's mini view is paced to about 2 frames a second by spacing its update requests. |

### 12.4 Human-login handoff

| Step | What happens |
| --- | --- |
| Call | The agent meets a login, 2FA, QR code or CAPTCHA and calls `browser_handoff("Sign in to github.com")`. The supervisor reads the origin (scheme and host) of the agent's tab over CDP and brings that tab forward. Chrome is a normal window with its address bar visible, never kiosk or app mode. |
| Notice | Immediate when a portal chat session streams the call; otherwise the portal reads status every 10 s after a tool call in the last 2 minutes, else at the 60 s reconcile. Surfaces: §15.4. |
| In control | Private is on, nothing captures the screen, and the 10-minute wait pauses. |
| Result | `Handed back: <note>. Check with browser_snapshot, not a screenshot.`; `Declined: <note>`; "No response" after 10 minutes of waiting; "The person left before finishing" when the lease runs out, never "Handed back". Headless and take-over-off answer "No live view for sign-in here". A waiting handoff ends when the workspace stops or the gate exits. |
| Trust | The reason is untrusted: shown as the agent's quote under the checked origin, capped at 200 characters, never in push text, and wrapped in `untrusted_text` over Portal MCP (A11). With shared logins, a sign-in done here works for every later agent session in the workspace, and the card says so. |

## 13. Security requirements

| Area | Requirement |
| --- | --- |
| Enforced | No other workspace or pod reaches CDP, the supervisor or the desktop server; web pages can't drive them; nothing but the bridge reaches VNC; viewers can't send input, or see the screen while Private; input needs a secure context; raw CDP and VNC never reach a browser tab. |
| Not enforced | Workspace users and the agent can drive the browser and read its cookies, through CDP ✅ or the profile. The agent can send anything it can read (files, delivered secrets, cookies) to any site the browser reaches, and act as anyone signed in there. Policies and Playwright's origin flags are guardrails; Playwright MCP says it isn't a security boundary 📄. Every assign dialog says so. A header the pool adds from a secret (§24) is kept out of the agent's files, context, tool results and transcripts, but an agent that drives raw CDP could read it back from the browser's own network events. **Accepted residual** (the coordinator's decision on T-623, 2026-10-15): the token is already in the workspace through the staging setup, so this adds no reach; treat a header's secret as readable by any agent that has the pool, scope it to staging only, and rotate it if a session goes rogue. |
| Loopback services | Every listener the pool adds (supervisor `9220`, desktop `8930`) binds `127.0.0.1` explicitly (Node's default is `::`), refuses any request with an `Origin` header, accepts only `Host: 127.0.0.1:<port>`, and needs `X-CPB: 1` on every request and `Content-Type: application/json` on every POST; `8930` also needs `Mcp-Session-Id` after `initialize`. A page can't add that header without a preflight, so cross-origin `no-cors` requests and DNS rebinding fail, as isnan's `X-Kb` header does 🗂. Chrome's Local Network Access policies keep public sites off loopback as a second layer (🔬 Q21). Pages the agent opens still reach the workspace's own dev servers (US2). |
| CDP | Bound to `127.0.0.1`; full Chromium ignored `--remote-debugging-address=0.0.0.0` ✅. Never headless-shell's stock entrypoint (socat on `0.0.0.0` ✅), `--remote-allow-origins=*`, a Service or a published port. Chrome's checks stay on: on headless-shell, a name in `Host` got 500 and a foreign `Origin` 403 ✅. |
| Display and VNC | (Built with TigerVNC's `Xvnc` instead of Xvfb plus x11vnc, §23 F1.) Xvfb with `-nolisten tcp -nolisten local` and an auth cookie, because a second container in the namespace drove the display through its abstract socket ✅ (🔬 Q9). VNC only on the `0600` socket (§12.1). |
| Proxy view | Never raw CDP: a viewer's page sends the fixed messages of §22 over a socket checked like the shell's (session, Origin, device id), the portal validates each one and a helper in the container validates it again and is the only CDP client. Only the holder of control, over HTTPS or localhost, gets past `ping` and `quality`; others watch, and see nothing while Private. Input is rate-limited, frames are never stored or logged, and the portal fetches no page itself, so it is not an open proxy. |
| Users | Chrome runs as uid 1000. Xvfb, x11vnc, the supervisor, `cpb-ctl` and the desktop server run as uid 1001, whose control socket, VNC socket and passwords Chrome can't open. Config is root-owned. |
| Chrome sandbox | Non-root Chromium under Docker's default seccomp failed with "No usable sandbox" ✅ and worked with seccomp unconfined or `SYS_ADMIN` ✅; neither is used. Docker gets a profile built from moby's default for that daemon's version plus user-namespace creation; Kubernetes a `Localhost` profile installed on the nodes, else `RuntimeDefault` set explicitly (🔬 Q2). Where the probe fails (A4), Chrome starts only if the admin allowed "Chrome without its sandbox" for that target (relaxing, A8). **Sandbox off means:** a page that exploits the renderer runs as Chrome's user. It drives every tab, reads every cookie (effectively plain text under `--password-store=basic`), and can log keys through X, so it sees passwords typed in a take-over for any site. It can't reach the VNC socket, change control or rewrite policy. The "Sandbox off" chip and the handoff card say so. |
| Updates | Images rebuild weekly in the GHCR workflow and on each Chrome security release, on `node:22-trixie-slim`: bookworm is oldstable, and Debian LTS hasn't promised Chromium (🔬 Q10). Security-only revisions skip rollout pacing like revocations (foundation §6.3) and apply at the next idle stop (§10.3). The pool row shows "Chromium N days behind stable" (Google's version feed, read daily); past 21 days Chrome won't start with its sandbox off. CI fails a build whose Chromium trails the stable major. Built for amd64 and arm64, pinned by digest. |
| Exposed listeners | isnan's desktop serves VNC on `0.0.0.0:5920` with no authentication ✅. The supervisor and the Chrome launcher match listening sockets to their own processes (`/proc/<pid>/fd`), so the workspace's dev servers never count. Any TCP listener or bound UDP socket of theirs off loopback stops the browser with "Exposed listener" (High). CI scans the pool's ports (9220, 9222, 8930, 5900–5999, 6000–6063) from another workspace or pod. |
| Chrome baseline | isnan's flags 🗂: `--user-data-dir` (Chrome 136 ignores the debugging port on the default profile 📄), `--remote-debugging-port=9222 --no-first-run --no-default-browser-check --password-store=basic --disable-background-networking --disable-component-update --disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider`. Policy: `BrowserSignin: 0`, `SyncDisabled`, `PasswordManagerEnabled: false`, autofill off, no metrics or background mode, `HighEfficiencyModeEnabled`, `ExtensionInstallBlocklist: ["*"]`, the download keys (FR5), `RestoreOnStartup: 1` so sign-ins that last only for the browser session survive an idle stop (the supervisor then closes restored tabs but one, 🔬 Q7), and a `URLBlocklist` with the portal host, metadata hosts and `cluster.local`. |
| Network | Isolation is a workspace property the foundation applies (A2), with per-target values in Settings (A8); the browser requires it. **Kubernetes:** default-deny ingress in the namespace, and a per-pod egress policy denying private, link-local and cluster ranges except DNS, with exceptions compiled from the workspace's account endpoint, MCP set remotes and admin-listed hosts or CIDRs; it covers Claude Code and the shell too. Browsers start only where a canary shows enforcement (A4), or after an admin opts the target out, audited and shown on every live view (Q12). **Docker:** one `claudepilot-ws` bridge with `com.docker.network.bridge.enable_icc=false` (one network, so Docker's address pools never run out); running workspaces move with network connect and disconnect, and their IPs change. The portal is off-limits (the DinD gateway answered a workspace on port 3000 ✅): it binds to loopback behind a front (Web app §12.3), or a host rule drops workspace traffic to it. Internet egress, DNS and, on Docker, cloud metadata stay open, and the UI says so. |
| Exfiltration | URL lists can't express IP ranges and may cover navigations only (🔬 Q21), so they don't replace egress control. Allowlist mode (`URLBlocklist: ["*"]` plus `URLAllowlist`) narrows the browser, not the shell. When Settings' "Only managed hosts" is on, the browser runs in allowlist mode with those hosts; otherwise both rows say "The browser isn't limited by the sandbox's allowed hosts". |
| Profile | `~/.claudepilot/browser/profile` (`0700`) holds live sessions: Read and Edit denied to Claude, refused by Chat's preview and download, never synced or exported. Home-volume backups and snapshots contain live sign-ins. Reset and unassign close Chrome, then delete the contents, not the mount points, from inside the browser container as uid 1000 without following links. On a stopped workspace a removal record (foundation §6.5) does it at the next start ("Clears at next start"). |
| Mounts | Only the profile and `~/Downloads`, so a renderer exploit can't write `~/.bashrc`, `~/.claude` or `~/.ssh`. |
| Files | `~/Downloads` and Playwright output are attacker-controlled. The portal serves them with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, previews images only re-encoded in an `<img>`, never navigates to them, and reads them as the workspace user without following links, refusing any real path outside `~/Downloads` (A10). The skill says never to run a download; uploads ask first; the gate deletes Playwright output older than 7 days. |
| Portal | Take-over, handoff answers and Reset are UI-only, and relaxing browser changes return `UI_ONLY` over Portal MCP (A8, A11). Typed and pasted text travels as key events or `exec` stdin and is never logged; audit records device, web session and times, never keystrokes, clipboard text or frames. |

## 14. Capacity and lifecycle

### 14.1 Image and capacity

| Tier | CPU request → limit | Memory request → limit | `/dev/shm` | PIDs | Measured |
| --- | --- | --- | --- | --- | --- |
| Headless | 0.25 → 2 | 0.5 → 2 GiB | 512 MiB | 512 | headless-shell: 64 MiB idle, 0.38–0.46 GiB with three heavy tabs, 80–142 PIDs ✅. Chromium `--headless` is 🔬 Q10. |
| Browser | 0.5 → 2 | 1.5 → 3 GiB | 1 GiB | 1024 | Chromium, Xvfb, openbox, x11vnc: 0.29 GiB idle, 0.71–0.75 GiB with the same tabs, up to 374 PIDs ✅ (cgroup PIDs count threads) |
| Desktop | 0.5 → 2 | 2 → 4 GiB | 1 GiB | 2048 | Browser plus apps; isnan's desktop idles at 0.1 GiB 🗂, and isnan requests half the limit 🗂 |

| Item | Value |
| --- | --- |
| Image | One image, `claudepilot-browser`: Debian Chromium, Xvfb, openbox, x11vnc, xdotool, scrot, xclip, socat, fonts, the supervisor and the desktop server, plus a panel, terminal and file manager for Desktop. The tested equivalent on bookworm was 1.6 GB ✅. A `-chrome` variant is built for amd64. |
| Viewers | Scrolling took 31% of a core alone and 59% with one viewer: x11vnc 20%, and websockify, which this design drops, 13% ✅. Budget about 0.2 of a core per viewer while the screen changes, plus socat and the portal's bridge (🔬 Q4). |
| Per session | Each Claude session starts its own gate and Playwright MCP in the workspace container, plus chrome-devtools-mcp when on: an estimated 100–250 MB per session (🔬 Q22), counted in MCP set FR11's estimate and against Chat's 4 sessions per workspace (A7). |
| Kubernetes fit | Requests are reserved while Chrome sleeps, so "cheap when idle" holds for usage, not scheduling. **Decided with the cluster's numbers (2026-10-13) ✅:** both nodes have 8 CPU allocatable (k3s-master 15000 Mi, k3s-node2 29500 Mi); k3s-node2, where workspaces are pinned, held 7810m and 24572 Mi by requests at 12:5x, so 0.19 CPU free, and kohi-event's pod itself requests 1 CPU and 2 GiB (`PORTAL_K8S_CPU_REQUEST`). The rule: the pod with its browser must fit a node it may run on (its node selector), by allocatable minus the requests of every pod there that hasn't ended, not counting the workspace's own pod (Recreate replaces it); limits count where a container has no request. With the PRD's first browser request (0.5 CPU, 1.5 GiB) kohi-event would need 1.5 CPU on k3s-node2 and not fit (1.19 free); at **100m CPU and 512 MiB** it needs 1.1 CPU and 2.5 GiB and fits (1.19 CPU and 6.8 GiB free then; 1.69 CPU and 10.1 GiB at 13:31; the coordinator counted about 0.6 CPU free with kohi-event's own request included, so about 1.6 without it). CPU is compressible, so a sleeping supervisor reserves little and a busy Chrome is only slowed when the node is contended. Memory is not, but CPU is what is short on k3s-node2, so the request is 512 MiB (light use measured 0.6 GiB, heavy 0.75 GiB) and the limit 3 GiB; the workspace pod's own requests are never raised for the browser. A second workspace with a browser would not fit k3s-node2 (0.19 CPU free): moving it to k3s-master, which had 4 CPU free, is the node selector's job. Before a template change the portal checks the fit and, when nothing has room, starts the workspace without its browser and says why with the numbers ("Doesn't fit: k3s-node2 has 0.19 CPU and 4.8 GiB free by requests; the workspace with its browser asks 1.1 CPU and 2.5 GiB …"), trying again at the next start; a portal that may not read nodes (a namespaced Role, as on the rig) skips the check, and a pod still unschedulable 5 minutes after the change loses its browser again (unit-tested on the fake API server; not provoked on the cluster). |
| Caps (A8) | 4 running browsers per Docker target; 2 assigned browsers per Kubernetes target, since assigned ones hold requests. Past a cap, starts or assignments are refused with the reason ("2 of 2 browsers are assigned on this Kubernetes target. Unassign one first."; a change of pool on a workspace that has one is not a new one). Kubernetes browsers are offered only where the portal has `PORTAL_K8S_BROWSER_IMAGE` (a registry image the nodes pull) and not on enrolled clusters (Connect), whose agent refuses a container that starts as root. |

### 14.2 Lifecycle

| Event | Browser container | Chrome |
| --- | --- | --- |
| Workspace starts | Docker: converged by rule (§10.1). Kubernetes: starts with the pod, in no order | Asleep until the first tool call or viewer, or started at once ("With the workspace") |
| First tool call or viewer | | Woken by the gate or the bridge (🔬 Q7 times it) |
| Idle for the pool's time | Keeps running (only the supervisor) | Closed through CDP `Browser.close`; reopens on the next call |
| Workspace stops or is removed | Docker: stopped first, and removed before the workspace and its volume. Kubernetes: stops with the pod | Closed cleanly within 3 s |
| Crash or OOM kill | Restarted with backoff, by the portal (Docker) or the kubelet | Error after 3 crashes in 10 minutes; the workspace is unaffected |

## 15. User experience

### 15.1 Where it lives

| Surface | Design |
| --- | --- |
| Route | `/admin/workspaces/:target/:name/browser`, immersive at every width (Web app §9.2), titled "api-dev · browser" with the Needs input count first. Back returns to the previous page in the app, else to the workspace page. |
| Workspace list | On phones a row keeps one visible action, Chat; Shell and Live view move into ⋯. The browser chip shows only for Working, Needs input, In control, Starting and Error, and opens the live view. From 640 px a Live view button shows while the browser is up. Past 75% of its memory limit the chip adds "· 2.4 / 3 GB" in the Meter's gold band; the row's Meter stays the workspace's. |
| Workspace page | Overview gets a Browser card (state, memory Meter, viewers, "Sleeps in 12 min", tokens per screenshot, Live view). Resources gets the browser container's own row (CPU, memory, restarts, OOM kills). Configuration keeps pool, revision, delivery, sandbox and network isolation. |
| Chat | Browser joins Agents, Files and Diff as a PushedScreen: the 360 px side panel from 1280 px, else a panel or dialog, with a view-only mini view that connects only while visible, Open full view and Take control. On phones the activity strip reads "Working · browser · github.com · Watch". Consecutive browser calls group into one row, "Browser · 12 steps · github.com", with one Watch link. |
| Monitor | Waiting handoffs are attention items; the browser is its own row in the workspace drill-down. |
| Pools → Browser | A tab (Skillset A8). Cards read "Idle ~0.3 GB · up to 3 GB · Live view", with tier, profile mode, "Used by 4 · 2 running" and ⋯. The editor is a page (`task` flag): Tier first, as three choice cards with idle and maximum memory and whether there's a live view; then Profile and sessions, Display ("Best on phones: 1280×800", tokens per screenshot) and Idle stop. "Show advanced" holds Engine, Resources, MCP servers and tool rules (MCP set's Disclosure row and "Add rule"), Downloads, sites and allowlist mode, Extensions, Require sandbox, Live view, Take-over and Private. A switch a policy overrides is read-only: "Off by policy Standard". The create dialog's Add-ons get a Browser select, "None" first. |

### 15.2 Layout

| Part | Design |
| --- | --- |
| Frame | ImmersiveLayout (Web app W1), always dark like the terminal, through scoped dark tokens (`data-theme="dark"` on the route) and a dark `theme-color`, never raw colors. The 48 px header: back, the workspace name over the front tab's host, StatusDot with its text label (tap for Details), "Not isolated" and "Sandbox off" warning chips that open a sheet saying what's exposed, and ⋯. `--tabbar-h` is the dock's height, so toasts sit above the dock. |
| Phone portrait | The canvas at fit-width under the header (a 1280×800 display is about 240 px tall), then the dock: a caption ("Agent · click Sign up · 3 s ago", built from the tool and Playwright's element description, never typed text), the handoff card or the in-control line, and the primary button. In control, the keys row and text bar replace the caption. "Turn your phone for a bigger view" shows once. |
| Phone landscape | The canvas fits the height inside the left and right safe areas. The header hides after 3 s and returns on a tap at the top edge; the dock is one row, and only the text bar shows while the keyboard is open. |
| Desktop | The canvas fills the frame (Fit or 100%), the dock is a bar below it, and a header button enters full screen. The remote display never resizes to fit the device. |
| Details | From the StatusDot: connection, viewers by device, tabs (title, host, session, and an Agent marker on the last call's tab) each with Show (CDP `Target.activateTarget`), memory, idle stop, Reconnect. "Follow the agent", on by default, brings the agent's tab forward after each call; how the gate maps calls to tabs is 🔬 Q7. |
| ⋯ (flat Menu) | Full screen (Android and iPad; not iPhone); View options… (a sheet with Fit · 100% and Auto · Low data Segmented controls, and "⌘ as Ctrl" and "Follow the agent" SwitchRows); Send keys… (the KeyBar plus Ctrl+W, Ctrl+T, Ctrl+Shift+T); Downloads (a PushedScreen reusing Chat's Files list and preview rules for `~/Downloads`); Send a file to the browser (uploads into `~/Downloads`); Open chat; Open shell; Restart browser. |
| Banners | Needs input and In control live in the dock, not the banner slot. "This browser isn't network-isolated" shows once per device per week. Holding control counts as unsaved input, so the "New version ready" prompt waits (Web app §10.4). |
| Components | New: the canvas with its gesture layer, the dock, and a KeyBar shared with the terminal. The rest is `@isnanme/ui` and Web app W1 (ImmersiveLayout, PushedScreen, StatusDot, Meter). The route's code, noVNC's core (MPL-2.0 📄) included, loads only here and stays within the 100 KB lazy-route budget (Web app §13.1). |

### 15.3 Input

| Gesture | Watching | In control (Touch mode) |
| --- | --- | --- |
| Tap | Shows or hides the controls; the first time, "View only · Take control to click" | Left click, with a ripple where it lands |
| Double tap | Zoom to 2× and back | Double click |
| Two-finger tap; long press (500 ms), then drag | Nothing | Right click; left drag |
| One-finger drag | Pans when zoomed | Pans when zoomed |
| Two-finger drag; pinch | Pan; zoom the view | Scroll; zoom the view |

| Input | Design |
| --- | --- |
| Gestures | Two fingers lock to zoom if their spread changes 10% before they travel 10 px, else to scroll. Pointer mode (isnan's joystick 🗂, or a trackpad) shows a remote cursor and clicks at it. The live view replaces noVNC's own touch mapping (🔬 Q20). The canvas sets `touch-action: none` and `-webkit-touch-callout: none`; the rest of the page keeps pinch zoom. Take control adds a history entry, so Back asks "Hand back and leave?". |
| Phone typing | A canvas can't take the phone keyboard 🗂, so a text bar sends text. Nothing goes while typing: Return (`enterkeyhint="go"`) sends the text then Enter, Send sends the text alone, and the bar clears with "Sent 12 characters", never echoing it. It sets `autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"`. Its hidden mode (the eye toggle, the default during a handoff) is a password input, so keyboards don't learn it and password managers can fill it, with no `<form>`, so no save-password prompt (iOS 🔬 Q20). It's never focused for the user (`mayFocusField`), rises above the keyboard with `visualViewport`, clears when control ends, and is never stored. A Caps Lock chip shows while the remote Caps Lock is on; tap it to turn it off. Text from the bar turns it off first. |
| Keys row | Scrolls within itself: ↵ ⌫ Tab Esc ← ↑ ↓ → Ctrl Alt Ctrl+L. Ctrl and Alt are sticky (tap for the next key, double-tap to lock); ⌫ and the arrows repeat while held. Non-US layouts and characters beyond ASCII are 🔬 Q20. |
| Keyboards | The input follows the device, not the width (`isTouchFirst`): the text bar when touch comes first, key capture with a fine pointer, both on an iPad with a keyboard. While keys are captured a chip says "Keys go to the browser · Ctrl+Alt+Shift to release", and the chord moves focus to the header, so the canvas never traps the keyboard. In full screen on Chromium, `navigator.keyboard.lock()` sends Ctrl+W, Ctrl+T, Ctrl+N and Esc to the remote; holding Esc exits. On macOS ⌘ acts as Ctrl by default. |
| Clipboard | Ctrl/⌘+V is caught as a paste event; the portal sets the remote clipboard with `exec xclip` (stdin, uid 1001) and sends Ctrl+V, auditing only the length. When the remote clipboard changes, "Copied in the browser · Copy here" shows the text in a sheet before `copyText`, so nothing reaches the device's clipboard unseen. |

### 15.4 Handoff, tap by tap

| Step | What happens |
| --- | --- |
| Notice | The row, the chat card and Monitor show Needs input (§12.4), and a Needs input push (§15.6, tag `browser:<workspace>`) opens `…/browser?handoff=<id>`; a device in use gets a toast with Open instead. The notification closes when the handoff ends. |
| Tap 1: Open | The dock shows the handoff card: the checked origin, the agent's quote, the wait and time left, any warnings, Take control, and ⋯ (Decline, Decline with a note). Several waiting read "1 of 2". |
| Tap 2: Take control | The handoff's tab comes forward, zoomed to the focused field where the supervisor can read its box; the text bar starts hidden; Private covers other viewers. The person types or pastes, switching apps freely within the grace. |
| Hand back | One tap, with an optional note in an inline field. The card collapses to "Handed back 14:05". |
| Chat card | Laid out like Chat FR22: "Browser", the origin question, the quote, Decline and Take control, which opens the live view already in control. It's never focused, and Enter never triggers it. After expiry it reads "The agent stopped waiting at 14:12", with Take control anyway and Open chat. |
| Accidental take-over | One tap in Needs input or while the agent is idle. While the agent is Working, Take control is a secondary button behind a ConfirmDialog; taking over from another device also confirms (§15.6). |

### 15.5 States

| State | StatusDot (Monitoring's looks; the row chip only for §15.1's five states) | Canvas | Action |
| --- | --- | --- | --- |
| No pool | None | EmptyState "No browser in api-dev" | Assign |
| Workspace stopped | None | "api-dev is stopped" | Start; connects once it runs |
| Asleep; starting; restarting | Hollow muted dot; spinner; spinner | Opening wakes it: "Starting the browser… about 5 s" on a canvas-sized skeleton; after a crash, "The browser crashed · restarting (2 of 3)" | — |
| Ready | Static accent dot | Live, view-only | Take control |
| Working (a call in the last 90 s) | Pulsing accent dot | Live, with the caption | Take control (confirmed) |
| Needs input | Gold "!" · "Sign-in needed" | Live, with the handoff card in the dock | Take control |
| In control | Hand icon on the accent ring · "Alfian's iPhone has control · 2 min" | A 2 px accent frame around the canvas | Hand back |
| Private, another device in control | Same | Cover: "Private · Alfian's iPhone is signing in" | — |
| Reconnecting | — | The last frame, dimmed, over a bottom reason bar: "Reconnecting… · Retry now" | Retry now |
| Viewer cap; target cap | — | "3 devices are watching. Close one to watch here."; "2 of 2 browsers run on k3s" | —; Stop one |
| Error | Danger ✕ with the reason | The reason and its fix | Edit pool (OOM), Settings (isolation, sandbox), Restart browser (crash loop) |
| Take-over off; not secure | — | "View only · take-over is off (policy Standard)"; "View only · signing in needs HTTPS" | — |
| Headless; window closed | — | "Screencast · view only"; "Chrome closed" (a person closed the last window) | —; Reopen |
| Accessibility | Status always pairs color, shape and text | Labelled; state changes announced politely, handoffs assertively | 44 px targets |

### 15.6 Copy

| Where | Text |
| --- | --- |
| Handoff card | "Sign-in needed on github.com" (origin read from the tab); muted: Agent: "Sign in to github.com"; "Waiting 3 min · 7 min left". Warnings: "The agent named a different site than the one open"; "This sign-in also works for later agent sessions here"; with the sandbox off, "Sandbox off: other sites in this browser could see what you type". Always: "The portal never asks for its code in the browser." |
| In control | "You have control. The agent's browser tools wait until you hand back." · "What's protected?" opens §13's Enforced and Not enforced rows. While Private: "Private: other viewers can't see the screen, and nothing is recorded." |
| Push (kind Needs input) | Title "Sign-in needed · api-dev"; body "The agent is waiting in its browser" (no host, Web app §11.1) |
| Confirmations | Take control while Working: "Take control of api-dev's browser? The agent's browser calls wait until you hand back." Another device in control: "Alfian's iPhone has control. Take over?", after which the first device sees "Control moved to MacBook". |
| Toasts | Back after an app switch: "You still have control"; after the grace, "Control ended: you were away over 5 minutes". File sent: "Saved to ~/Downloads/id.pdf · choose it in the browser's file dialog". |
| Chat | "Waited: Alfian's iPhone had the browser 14:02–14:05"; system rows "Alfian's iPhone took control" and "Handed back"; after an assignment, "Start a new session to use the browser" |

## 16. Observability and audit

| Kind | Contents |
| --- | --- |
| Event log (foundation, 90 days) | Starts, stops, crashes, OOM kills, idle stops, wakes, sandbox state, viewers, take-overs, hand backs and handoff answers (each naming the device and web session, Web app §12.4), pastes (length only), resets. |
| Security events | An exposed listener (High); a browser running without its sandbox or network isolation; Chromium over 21 days behind; loopback requests refused for their Origin or Host. |
| Metrics for [Monitoring](monitoring-dashboard.md) | Browsers by tier and target, memory against limit, OOM kills and restarts apart from the workspace's, viewers, take-overs, handoff wait and outcome, wake time, Chromium age. MCP calls come from Monitoring's own hooks, tagged `managed_by: browser`. |

## 17. Testing and verification

| Suite | What it covers | Where |
| --- | --- | --- |
| Topology and exposure | The pool's ports from the workspace (open) and from another workspace or pod (refused); only loopback and unix sockets owned by the browser container; a workspace dev server on `0.0.0.0` raises no alarm; the X abstract socket closed (Q9); the portal unreachable from Docker workspaces | CI on DinD and k3d; by hand on Docker Desktop and k3s |
| Loopback services | A hostile page in the agent's browser tries `no-cors` fetches, form posts, DNS rebinding and missing headers against 9220 and 8930: all refused | CI |
| Restart coupling | `docker restart`, stop and start outside the portal, a daemon restart, a portal restart that misses events, a workspace recreate, removal order, a killed or OOM-killed browser: back within 15 s, workspace status untouched | CI |
| MCP end to end | Plugin loads in `-p` and interactive sessions (Q5); a session start doesn't wake Chrome; navigate, snapshot, upload, download (Q3); isolated sessions; refusal while in control; every handoff result, "left" included; header redaction; schemas per pinned version | CI, on every version bump |
| Bridge and control | Crafted KeyEvent, PointerEvent and ClientCutText from a viewer dropped; ClientInit forced shared; SetEncodings over 64 and oversized messages close; no frames to a viewer while Private; a non-secure origin can't take control; sign-out closes the socket; a lease expires 90 s after the portal dies; held keys released | CI |
| Sandbox and users | Default seccomp, moby's profile plus user namespaces, a k3s `Localhost` profile and `RuntimeDefault`; the fallback chip; Chrome's uid can't open the VNC or control sockets (Q2) | By hand, per target |
| Kubernetes | An unpullable browser image leaves the workspace running; `/dev/shm` accounting; batched restarts; status and usage split; fit check and rollback; exec against port-forward latency (Q1, Q4) | k3d in CI; k3s before B3 |
| Capacity | Three heavy tabs per tier, memory guard, PIDs, viewer and bridge CPU, per-session MCP memory, idle stop and wake (Q7, Q22) | By hand, before each image bump |
| Phone UI | Playwright at 360×780, 390×844, 844×390 and desktop: gestures, text bar, keys, take control, hand back, reconnect, no PointerEvent sent while watching, the release chord; axe | CI |
| Devices | Installed iPhone app, iPhone Safari, Android Chrome, iPad with a keyboard: the keyboard over the canvas, password-manager fill and paste, Gboard composition, accented characters, a 90 s app switch mid-handoff, rotation and Back while in control | By hand, before B1 and B2 |
| Leaks and files | Typed and pasted text and handoff notes never reach logs or events; no frames stored; downloads served as attachments; a planted symlink in `~/Downloads` refused | CI |

## 18. Rollout and milestones

| Milestone | Scope | Gate | State (2026-10-12) |
| --- | --- | --- | --- |
| B0 | Spikes for Q1–Q7, Q9, Q20, Q21; the trixie image for amd64 and arm64 with its update pipeline; target probes (A4) | Foundation F2 | **Partly built.** Q2, Q3, Q5, Q6, Q7, Q9 answered on Docker (§21); the image is built for arm64 only; no update pipeline, no probes beyond the sandbox check; Q1, Q4 (throughput), Q10, Q11, Q20, Q21 open. |
| B1 | Docker, Browser tier: pool type and editor page, companion with rule-based convergence, network isolation (A2), users and seccomp profile, loopback hardening, plugin and gate, Playwright MCP, live view and bridge, control lease, Private, handoff, the secure-context rule, row chip, chat card and Browser panel | Foundation F2, F5, F6; MCP set A4; Web app W1 (W3 for take-over away from localhost); Chat C1; exposure, loopback and bridge suites pass | **Built** except the chat card and Browser panel (chat PRD, not built) and network isolation between workspaces (A2, not part of this build). 21 real-Docker tests pass, and real Claude Code 2.1.296 lists and calls the browser. |
| B2 | Idle stop and wake, memory guard, Restart and Reset, Downloads and Send a file, Monitoring, caps, handoff push | Monitoring D3; Settings S2; Web app W5 | **Partly built:** idle stop and wake, memory guard, Restart and sleep, viewer caps, crash accounting. Not built: Reset as its own action, Downloads and Send a file, Monitoring, handoff push. |
| B3 | Kubernetes: browser container, ConfigMap, bridge, status and usage split, explicit requests and fit check, egress policy | Foundation F3; A2's requests; Q1, Q4; Q12 decided | **Built (2026-10-13) and verified on a rig** (namespace `dev-rig-browser`, a scratch portal with a namespaced service account, image `registry.int.isnan.me/claudepilot/browser:t97-2026.10.13-1` built in the cluster): the pod had the `browser` container (requests 100m and 1 GiB on the rig, since lowered to 512 MiB, limits 2 and 3 GiB; on k3s-master, as k3s-node2 had 0.19 CPU free for a second pod); a chat session's `browser_navigate` to example.com answered 20.8 s after it was allowed, Chrome cold (3.5 s sandbox probe, 13.5 s to Chrome up, the rest the page), and the next call in 1.0 s; the live view showed the page at 1280 px (VNC, first frame 2.5 s) and 390 px (proxy view, 3.1 s); a `browser_handoff` waited, Take control paused a second session's `browser_navigate` ("A person has control of the browser since 13:27 UTC (Rig laptop)…"), and hand back returned "Handed back: Signed in." to the first. CDP and the supervisor listen on 127.0.0.1 only and refused a connection to the pod IP from another pod ✅. The egress policy is applied but **not enforced on this cluster** (Q12, §23 F7). Not built: patching a running pod's browser image in place, batching restarts, Monitoring's per-container view, the canary that gates browsers on enforcement. |
| B4 | Desktop tier and desktop server | Q9, Q14 | **Not built** (the pool refuses the Desktop tier). |
| B5 | Headless tier with screencast, chrome-devtools-mcp, extensions, Google Chrome on amd64 | Q10 | **Partly built:** the headless tier (code and unit tests only, not yet run in a container; watched through the proxy view, §22) and chrome-devtools-mcp (verified through the gate). Not built: extensions, Google Chrome. |
| B6 | The proxy view (§22): helper, preview socket, preview page, phone input | Owner's request; B1 | **Built and verified** in a real browser against a real browser container (1280 and 390 px): frames arrive, a person's clicks and typing change the remote page, the agent and the person share one Chromium, the lease pauses the agent's tools, a second viewer only watches. Not built: the upstream proxy setting. |

## 19. Success metrics

| Metric | Target |
| --- | --- |
| Assigning a pool to a working browser tool call in a new session | Under 1 minute on Docker (image cached); under 3 minutes on Kubernetes, restart included |
| Browser ports reachable from another workspace or pod; loopback requests from web pages accepted | Zero; zero (CI) |
| Agent browser calls run while a person has control; screenshots by portal-delivered servers during a handoff; frames sent to other viewers while Private; input from viewers without control | Zero each |
| Workspaces set to Error, or kept from starting, by a browser fault | Zero |
| Handoff: visible in the portal after the call, agent active; notification to typing; ending "The person left before finishing" | p95 under 10 s; two taps; under 2% |
| Live view first frame; input to screen in control | p75 under 2 s on Docker, 4 s on Kubernetes; p95 under 150 ms on Docker, 300 ms on Kubernetes (🔬 Q4) |
| Browser back after a workspace restart, portal running; idle Chrome stopped | Within 15 s; within the idle time plus 1 minute |
| Running browsers more than 21 days behind Chromium stable | Zero with the sandbox off; under 5% overall |

## 20. Amendments to other PRDs

| ID | PRD and section | Change |
| --- | --- | --- |
| A1 | Foundation §7 | Browser & desktop row: files `managed-settings.d/70-claudepilot-browser.json`, `/etc/claudepilot/marketplace/plugins/cpb-browser/**`, `/etc/claudepilot/bin/browser-*` and `~/.cache/claudepilot/browser/**` (through the run-in-workspace step only); keys: the `enabledPlugins` entry `cpb-browser@claudepilot`, `permissions.ask` and `permissions.deny` entries starting `mcp__plugin_cpb-browser_`, Read and Edit deny entries for `~/.claudepilot/browser/profile/**` (until A6), the `permissions.additionalDirectories` entry `/home/node/Downloads` (a list key), and `env` `CLAUDEPILOT_BROWSER_*`. Drop "its MCP server entry": `managedMcpServers` takes only remote HTTPS servers, and no owner writes `managed-mcp.json`. |
| A2 | Foundation §6.2, §6.6 | One structure manager. **Docker:** companion containers converged by rule at every reconcile and event-stream reconnect (with `since`), recreated after every workspace recreate, and removed before the workspace and its volume. **Kubernetes:** one compiled pod template that lists every container once, in order: init `seed-home` (which also creates pool subpaths, such as the browser's, with explicit modes at every start, outside its seeded check), the foundation's `sync` init, `claudepilot-sync` (Settings amendment 6, if adopted), then `workspace` and `browser`; explicit requests for each container (Settings owns the workspace's); `automountServiceAccountToken: false`; a fit check before a change and rollback after 5 minutes Pending; batched restarts. **Network isolation** becomes a workspace property this manager applies: on Docker, one `claudepilot-ws` bridge with inter-container traffic off, existing workspaces moved with connect and disconnect, and the portal's port closed to workspaces; on Kubernetes, namespace default-deny ingress and a per-pod egress policy with compiled exceptions. |
| A3 | Foundation §6.2, §6.5 | Companion files: non-secret config written `root:root 0644` into root-owned directories by the archive API (Docker), or a ConfigMap `ws-<name>-browser` with an ownerReference, mounted read-only (Kubernetes). Never secrets. A removal record can also carry a browser-data reset for a stopped workspace, applied at its next start. |
| A4 | Foundation §9 | Target capability probes, stored per target and shared with Settings Q6: CPU architecture; Docker API version (volume subpaths need 1.45); exec umask; whether Chrome's sandbox starts under the daemon's default seccomp profile and under the user-namespace profile; AppArmor's `restrict_unprivileged_userns`; NetworkPolicy enforcement by canary (apply a deny policy, then a connection must fail); node allocatable and requests. |
| A5 | Foundation F3, Kubernetes runtime | Workspace status follows the `workspace` container's own state, never pod phase or another container's (phase stays Pending while any image pulls). Other containers report their own state; usage is per container. |
| A6 | Foundation (secret-path registry, when added) | Register `~/.claudepilot/browser/profile/**`: generated Read and Edit deny rules, refused by every preview and download path. Until the registry exists, the browser's drop-in writes these rules itself (A1). |
| A7 | MCP set FR3, FR5, FR11, §12 | Reserve the plugin prefix `cpb-`. The browser uses the run-in-workspace step with its own `~/.cache/claudepilot/browser/` folder, installed from a lockfile, never MCP set's folder, and reports allowlist matchers (FR19). Review warns about servers that target `127.0.0.1` ports `9220`, `9222` or `8930`. FR11's process estimate includes the browser's per-session processes. This PRD proposes no external-desktop preset (Q18). |
| A8 | Settings §4, §11, FR8, FR19 | Narrow the non-goal "Network control for the whole container": Settings holds per-target values for workspace network isolation (on, or an audited opt-out; exception hosts and CIDRs), which the foundation applies (A2). New rows: Network isolation required for browsers (per target, on); Allow Chrome without its sandbox (per target, off); Take-over in live view (on); Private handoffs (on); Control grace (5 minutes); Running browsers per target (Docker 4 running, Kubernetes 2 assigned); default idle stop. A built-in **Browser** allow group (Playwright's navigation, snapshot and input tools, `browser_status`, `browser_handoff`), on in the default policy and shown read-only with its source. `permissions.additionalDirectories` becomes a list key. Every browser pool field and these rows get a direction: unblocking `browser_run_code_unsafe` or removing an Ask rule, turning off Require sandbox, allowlist mode or Private, allowing extensions or devtools, removing blocked sites or download limits, and either opt-out are relaxing, so they need re-auth and return `UI_ONLY` over Portal MCP. With "Only managed hosts" on, the browser runs in allowlist mode with those hosts. The MCP allowlist includes `cpb-browser` matchers (FR8). |
| A9 | Monitoring FR18, FR28, §14 | `managed_by: browser` for `plugin:cpb-browser:*`; the browser container's resources, restarts and OOM kills apart from the workspace's; attention items for waiting handoffs and browser errors; exposed listeners, take-overs, browsers without sandbox or isolation, and stale Chromium in the Security feed; the look table gains In control (a hand icon on the accent ring). |
| A10 | Chat sessions FR3, FR7, FR22–FR25, FR33, §9, §12 | `handoff` joins `chat_requests.kind`: the portal creates it when a session streams `browser_handoff`; it sets Needs input, shows §15.4's card (Decline, Take control), expires after 10 minutes of waiting, and is cancelled by Stop. Browser joins Agents, Files and Diff as a PushedScreen with a mini view. FR7 strips `plugin_<plugin>_` and the `browser_` prefix ("browser · navigate") and groups consecutive browser calls; gate refusals show as one muted "Waited" row, and take-overs as system rows; an approval for `browser_navigate` previews the host ("Open github.com/login?"). FR33 also refuses `~/.claudepilot/browser/profile/**`, and serves `~/Downloads` and Playwright output per §13 Files. After a browser assignment, chat shows "Start a new session to use the browser", not Reload. |
| A11 | Portal MCP §6, §14.4; Web app §8, §10.4, §11.1, §12.4, §14, Q1 | Browser pools can be created and assigned over MCP, except relaxing changes (A8); live view, take-over, handoff answers and Reset are UI-only; handoff reasons come back in `untrusted_text`. Web app: Q1 is answered (the pool stays, Docker first); add the route `/admin/workspaces/:target/:name/browser`, immersive at every width; the Needs input push `Sign-in needed · <workspace>` / "The agent is waiting in its browser", tag `browser:<workspace>`; device names in take-over and handoff audit rows; a KeyBar shared with the terminal; holding control counts as unsaved input for the update prompt. |
| A12 | Persona, Skillset | Browser guidance ships as a skill inside `cpb-browser`, never as a `claudeMd` section. Subagent tool lists use the `mcp__plugin_cpb-browser_*` names. |
| A13 | README | Browser & desktop pool: Draft v0.2 (reviewed). It answers Web app Q1: the pool stays. |

## 21. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | 🔬 The Kubernetes layout on k3s: the browser as a regular container beside `workspace` (an unpullable image leaves the workspace running), `exec` liveness, memory-backed `/dev/shm` against the limit, restart time, status and usage split, and patching the running pod's `browser` image in place. Only a native-sidecar dry run passed ✅. | Kubernetes spike |
| Q2 | 🔬 Sandbox and users per target, together with Settings Q6 (bwrap needs the same user namespaces): Chrome's sandbox under moby's default profile plus user namespaces on DinD and Docker Desktop; a `Localhost` profile or `RuntimeDefault` on the k3s nodes (Proxmox LXC, `KubeletInUserNamespace`, Ubuntu's AppArmor `restrict_unprivileged_userns`); a root init holding only `SETUID` and `SETGID` under `no-new-privileges`; Pod Security admission. | Sandbox spike, operator |
| Q3 | 🔬 Downloads through Playwright over CDP. A click saved nothing ✅; CDP `setDownloadBehavior` worked ✅. Candidates: (1) Playwright MCP with `TMPDIR=/home/node/Downloads/.cpb-tmp`, so its artifacts folder exists at the same path in both containers, then `saveAs` into `~/Downloads` (with `acceptDownloads` for isolated contexts); (2) the gate calls `Browser.setDownloadBehavior` (allow, `~/Downloads`) after Playwright attaches. Also: does `additionalDirectories` stop Read prompts, do chrome-devtools-mcp's MCP roots include `~/Downloads`, and what does `DownloadRestrictions` block in Debian Chromium? | Lab test |
| Q4 | 🔬 Live-view bridge: x11vnc on a unix socket with §12.1's flags and `-passwdfile`; throughput, input latency and CPU (x11vnc, socat, the portal's bridge) over `docker exec` (DinD, Docker Desktop) and Kubernetes `exec` against `pods/portforward` through the remote API server. | Spike |
| Q5 | 🔬 From a plugin `.mcp.json`: the stdio gate, and the loopback HTTP desktop server with its header, in `-p` and interactive sessions. Does `/reload-plugins` restart stdio servers? Plugin delivery was verified only with dummy servers ✅. | Lab test |
| Q6 | 🔬 The gate: does Claude Code accept a cached `tools/list` before the real server starts? Are notifications, progress and cancellation passed intact? How is a refused call shown? Does a long `browser_handoff` call hold in terminals and chat sessions? | Lab test |
| Q7 | 🔬 After Chrome restarts, does restarting Playwright MCP and replaying `initialize` recover cleanly? How long does a wake take? Do per-session tabs keep shared-login sessions apart, and how does the gate tell which tab a call used? Does `RestoreOnStartup: 1` keep session cookies after the supervisor closes restored tabs? | Lab test |
| Q9 | 🔬 Does `Xvfb -nolisten tcp -nolisten local` remove the abstract socket that let a second container drive the display ✅? | Lab test |
| Q10 | 🔬 Google Chrome for linux/arm64; Google sign-in in Debian Chromium; trixie's Chromium security support on amd64 and arm64; Chromium `--headless` memory and screencast at 1280×800 against headless-shell. | Spike |
| Q11 | 🔬 Does Chromium reload managed policy files when they change, or only at start? The design restarts Chrome at idle when the policy hash changes. | Lab test |
| Q12 | Will the operator turn on NetworkPolicy enforcement on k3s (remove `--disable-network-policy`, or a policy-enforcing CNI)? Observed 2026-10-13 ✅: the nodes run with `--disable-network-policy`; from a rig pod under its egress policy the API server (10.43.0.1, 401), another pod's port and the internet all answered. B3 applies the policy anyway, with `PORTAL_K8S_BROWSER_EGRESS_ALLOW` exceptions and `PORTAL_K8S_BROWSER_EGRESS=off` as the audited opt-out; no canary gates browsers yet. Which hosts and CIDRs must the exceptions carry? A workspace that runs kubectl or pushes to the LAN registry (kohi-event) needs the API server and the registry listed, or the opt-out, before enforcement is turned on. | Operator |
| Q13 | Are these the right defaults: the Browser tier, a persistent profile with shared logins, a 5-minute control grace, Private handoffs, Chrome without its sandbox not allowed until an admin says so per target, and the profile wiped on unassign unless kept? | Product |
| Q14 | Desktop tier contents (openbox, panel, terminal, file manager proposed; office apps?) and base: Debian packages (tested ✅) or portabledesktop (v0.0.x). | Product |
| Q16 | Session recording or thumbnails: none in v1. Wanted later, and kept how long? | Product |
| Q18 | Should the isnan desktop's open VNC be fixed now (`portabledesktop up --xvnc-arg=-localhost`), separately from this PRD? An external-desktop preset in MCP set would wait for that fix and MCP set Q2, and warn that one cookie jar serves every workspace and agent of that person. | Operator |
| Q19 | Should Secrets & env ever fill website logins for the agent? Proposed: no; people sign in through the live view. | Product |
| Q20 | 🔬 Phone input: replacing noVNC's touch mapping (a wrapper or a patch); iOS autofill and paste into a password input outside a form, with no save prompt; non-US layouts and non-ASCII characters as key events. | Device test |
| Q21 | 🔬 On the pinned Chromium: the Local Network Access policies that keep public sites off loopback, and whether `URLBlocklist` and `URLAllowlist` cover subresource requests or only navigations. | Lab test |
| Q22 | 🔬 Memory per Claude session of the gate, Playwright MCP and chrome-devtools-mcp, for §14.1 and MCP set FR11. | Lab test |

Closed since v0.1: Q8 (companions converge by rule, §10.1), Q15 (device names), Q17 (yes, in B2).

## 22. Proxy view

**Why.** The owner asked for a browser preview that is not VNC: a page the portal draws itself, so it works like any
web page on a phone (no RFB client, no display, so also the headless tier), with an address bar and tabs, and the
agent and the person driving the same Chromium. It overturns the old non-goal "a CDP proxy in the portal" in one
narrow way: the portal never forwards CDP. A helper inside the browser container is the only CDP client, and the
portal passes it a fixed set of validated messages.

**Parts.** `cpb-view` (images/browser/cpb) runs in the browser container as uid 1001, one process per viewer, started by
the portal's runtime `exec`; it talks to Chrome on loopback and to the portal on stdio. `PreviewSession`
(apps/server/src/browser/preview.ts) bridges the socket `GET /api/workspaces/:target/:name/browser/preview?device=<id>`
to it. `PreviewView` (apps/web/src/features/browser) draws the frames on a canvas and sends the person's input.

**Messages** (`PreviewClientMessage` and `PreviewServerEvent`, packages/contracts/src/browser.ts). Page to portal, JSON
text frames of at most 16 KB: `mouse` (move, down, up, wheel; positions as fractions of the frame), `key`, `text`,
`go`, `back`, `forward`, `reload`, `stop`, `tab`, `newTab`, `closeTab`, `viewport` (size, pixel ratio, mobile, or
reset), `quality` (JPEG quality, width, frames per second), `dialog` (answer an alert, confirm or prompt), `ping`.
Portal to page: JSON events (`ready` with the socket's role, `tabs`, `url`, `loading`, `dialog`, `dialog-closed`,
`error`, `pong`) and binary frames `[u16 header length][header JSON {dw, dh, tab, emu}][JPEG]`. Nothing else is
accepted in either direction.

**Rules.**

| Area | Rule |
| --- | --- |
| Socket | Same checks as the shell and live-view sockets: the session cookie, an `Origin` equal to the host, and a device id; the central socket guard closes it when the session ends. No separate per-view token: it would add nothing against the cross-site attacks `Origin` already stops (decision, §23 D3). |
| Vocabulary | The portal validates every message (types, ranges, lengths, control characters) and drops the rest; the helper validates again, because it is not the only writer of its pipe. `go` accepts `http:`, `https:` and `about:blank` (a bare host gets `http` for loopback, IPs and `.local`, else `https`); `javascript:`, `file:`, `chrome:` and `data:` are refused. Events and frames from the helper are shaped the same way: known events with bounded text, ids checked, a frame must be a JPEG. |
| Roles | The holder of control, over HTTPS or localhost, is the controller; every other socket is a viewer and can send only `ping` and `quality`. A viewer follows the browser's front tab. When who holds control changes, the socket closes with 4001 and the page reconnects with its new role, which also ends the holder's viewport emulation. |
| Viewport | A viewport change (a phone size, or back to the window's own) is answered with a frame of the new size even on a still page: the helper restarts the screencast once Chrome has taken the change (T-331). A frame is marked emulated only when it is of the emulated size: one painted before the change keeps the old size and is not (T-330). |
| Private | While control is Private a viewer's socket is closed with 4002 and the helper is never started for it: no frames, no events. |
| Shared browser | The agent and the person use one Chromium. The lease pauses the agent's browser tools (the gate's refusal, §11.3) while a person holds control; a tab the agent opens or brings forward becomes the viewers' tab, and a tab the controller picks is brought forward for the agent too. |
| Limits | Per socket per second: 400 input messages, 8 navigation, 6 viewport, 3 quality, 6 dialog. A frame is at most 8 MB. A viewer too slow for the stream gets the newest frame, never a backlog. Viewer caps are shared with the VNC view (§14.1). |
| Not an open proxy | The portal fetches nothing for the person: a navigation is the browser's own, under the pool's blocked sites and allowlist mode like the agent's. |
| Nothing kept | Frames, keys, typed text and addresses are neither stored nor logged; the helper writes no file (tested); audit rows are those of the live view. |
| Not built | An upstream proxy setting for the browser; recording; the person's clipboard out of the page (paste in works). |

**Page.** Canvas, address bar, back, forward, reload or stop, a tab menu, and "Fit to screen" (the page is laid out at
the person's screen size and pixel ratio, as a mobile page on a phone). Touch: a tap is a click, a second tap a double
click, a long press a right click, a drag scrolls. A keyboard types into the page and a paste is sent as text; on a
phone the text bar and key row of the live view do the same. The Screen and Preview views switch in the header, the
preview first on a touch screen.

**Verified** (2026-10-12; Docker 29.9 DinD arm64, Chromium 154): `preview.test.ts` (13 tests: validation, framing,
roles, Private, caps, rate limit, newest-frame-wins, cleanup) and `cpbview.test.ts` (12 tests against a real
Chromium); then in a real browser at 1280 and 390 px against a real browser container: frames arrive; a viewer's
clicks and typing do nothing; taking control; the address bar navigates; a click and typing change the remote page;
the wheel and a finger drag scroll it; back, forward, tabs, a JavaScript dialog; hand back; the agent's navigation and
new tab show in the preview; while the person holds control the agent's call is refused, and after hand-back the agent
reads the title the person's click set; a second device is a viewer and its input changes nothing.

## 23. What the build changed

| | Finding or decision |
| --- | --- |
| F1 | `x11vnc -unixsock` still listened on TCP 5900 ✅, so the display is TigerVNC's `Xvnc` on a `0600` unix socket only (`-rfbport -1`), with a full and a view-only password and server-enforced view-only. Xvfb, x11vnc and socat are not in the image. |
| F2 | Q2: Chromium's sandbox starts under moby's default seccomp profile plus `unshare`, `setns`, `clone` and `chroot` with every capability dropped but `SETUID`/`SETGID` ✅ (`chroot` is needed because dropping all capabilities removes `SYS_CHROOT`). |
| F3 | Q3: downloads land in `~/Downloads` with the policy `DownloadDirectory` ✅. Q5, Q6: the stdio gate starts from a plugin `.mcp.json`, answers `initialize` and `tools/list` from pinned lists without waking Chrome, and Claude Code 2.1.296 lists it connected and calls its tools ✅. |
| F4 | Q7: restored tabs made Playwright drive a hidden tab ✅, so there is no `RestoreOnStartup`; the gate opens its own tab (or brings it forward) and the supervisor reports the tab count. Q9: `-nolisten local` removes the abstract socket ✅. Q4: the bridge works over `exec` with a helper (`cpb-vnc`) in place of socat ✅; throughput and latency are not measured. |
| F5 | Other portals on the same Docker daemon reaped this portal's browser containers, so every container carries the creating portal's id and a portal only touches its own, and none when it does not trust its database. |
| F6 | The MCP lockdown matches a plugin server by its command line with `${CLAUDE_PLUGIN_ROOT}` already replaced by the plugin's version folder ✅ (the unexpanded text is blocked). The browser reports that exact line (`BrowserService.matchers`), so "Pool MCP only" keeps the browser's tools. **T-881 (incident 2026-10-16):** Claude Code is never told to update a plugin (the marketplace has `autoUpdate` off), so a session keeps launching the version it installed after a revision moves the plugin to a new folder; a list of only the current command blocked every new session for 15 minutes. `matchers` therefore also reports the exact commands of the pool's earlier deliverable revisions (at most five, newest first) for as long as the reconciler still holds their version folder (`pluginFolders`, kept per workspace by `BrowserKind`; every one of the five before the first delivery report after a restart). Never a pattern, never a folder the pool did not compile; when the reconciler retires a folder its command leaves the list. Residual: a session older than five revisions, or older than the retention, is blocked until it restarts. Real-Claude test: `browser.integration.test.ts` (Docker only). |
| D1 | noVNC 1.4.0, pinned exactly: later releases ship CommonJS with top-level await, which the web build can't bundle. It loads only when the Screen view is shown. |
| D2 | The Desktop tier is not built (no panel, terminal or desktop MCP server): the editor doesn't offer it and the pool refuses it until B4. |
| D3 | Decision for the owner: no per-view token on the preview socket. It uses the shell socket's checks (§22). Say if a one-time token is wanted anyway. |
| F7 | B3, Kubernetes (2026-10-13): NetworkPolicy is not enforced on the k3s cluster (`--disable-network-policy`), so the per-pod egress policy is a record until Q12 is answered; the browser container mounts no service account token (`automountServiceAccountToken: false` on the pod) and Chrome's policy blocks the metadata hosts, `cluster.local` and the portal's internal URL. Chromium's sandbox is unavailable under `RuntimeDefault` (no user namespaces): `sandbox: auto` falls back, and a pool that requires the sandbox doesn't start Chrome there. |
| F8 | B3: kubelet `emptyDir`s are root-owned and world-writable, so the root init sets `/tmp` sticky and makes `/run/cpb` as uid 1001 inside a `/run` it closes again; `tini` is PID 1 (no `Init: true` on Kubernetes). Pod phase is not workspace state: it stayed Pending while the browser image could not be pulled with the workspace Ready, so status, delivery and exec now read the workspace container's own state. A namespaced Role (a rig) can't create the namespace: a 403 there now means "use the one that exists". |
| F9 | B3, small: one line of example.com showed as boxes (no CJK font in the image: add `fonts-noto-cjk` if wanted, about 50 MB); the supervisor reports "sandbox on" until Chrome's first start settles `auto`. |
| D4 | B3 decisions: browser requests 100m CPU and 512 MiB (§14.1); 2 assigned browsers per Kubernetes target; the template changes only while no workspace container runs (§10.2); the egress policy stays on by default with admin exceptions and an audited opt-out, though this cluster does not enforce it; the image is built in the cluster (`scripts/k3s-build.sh browser <tag>`, `BUILD_NAMESPACE=dev-rig-<name>` for a dev branch). |

## 24. Request headers from named secrets

**Why.** A staging site behind Cloudflare Access wants two headers on every request (`CF-Access-Client-Id`, `CF-Access-Client-Secret`).
The agent must browse the site without ever seeing the values: not in its context, files, tool results, transcript, a log or an audit row.
The owner's brief is T-623; the design is on that ticket.

**Setting.** `headers` on the pool, a list of `{ hosts: [pattern], name, secret, key? }` (`key`: T-623 S2, below the table):

| Field | Rule |
| --- | --- |
| `name` | A header name (letters, digits, hyphens). The ones the browser owns (`Host`, `Cookie`, `Content-Length`, `Content-Type`, `Origin`, `Referer`, `User-Agent`, `Connection` and the like; `FORBIDDEN_HEADERS` in `headers.ts`) are refused. |
| `secret` | The NAME of one Secrets & env entry (kind secret). Never a value: a `value` field is dropped at save. The name must belong to exactly one secret in the current revisions of all Secrets & env sets; the set need not be assigned to the workspace. |
| `hosts` | `app.example.com`, `app.example.com:8443` or `*.example.com` (up to 20). Each must be covered by an entry of `allowedSites`; saving is refused otherwise, and so is removing an allowed site that a header still uses. At most 10 rules. |

**A key inside an env-file entry (T-623 S2).** A credential that is one env-file entry (`KEY=VALUE` lines, both values inside) is not split into two entries
(that would copy it and double its rotation). A rule may add `key: "<VAR>"` (`HEADER_SECRET_KEY`: letters, digits, underscores, up to 128, not starting with a
digit): `secret` names the env-file entry and the header's value is that variable's value. The portal parses the entry at delivery (`envFileValue` in
`headers.ts`: `export ` allowed, blank lines and `#` comments skipped, one pair of matching quotes stripped, the last line for a key wins), in memory only; only the
key's value goes to `headers.json`, never the other variables. A missing or empty key leaves the header out, and the audited reason is `the entry has no <KEY>`: the
key's name, never a value. The audit, the spec hash input and the pool hold the entry's name, the key's name and the entry's value id, never a value. The gate masks
the value by the key's own variable name (`--redact-env <KEY>`), since the workspace has an env file's variables, not a variable called after the entry. Without
`key` a rule behaves as before (the whole value).

**How it works** (no proxy: HTTPS would need a CA the browser trusts):

| Step | What happens |
| --- | --- |
| Resolve | At each delivery the portal looks the secret up by name (`SecretsKind.secretByName`) and holds the value in memory only. A secret that is missing, in two sets, without a value or unreadable leaves its header out; the reason is audited. |
| Deliver | **Docker:** the archive API writes `/etc/cpb-secrets/headers.json`, root `0400` in a `0700` folder, next to (not inside) the world-readable config. **Kubernetes:** no Secret object and no RBAC on Secrets. The browser container mounts a memory-backed `emptyDir` `cpb-secrets` (1Mi) at `/etc/cpb-secrets` (the workspace container never mounts it), and the portal writes the file into it through the `pods/exec` it already has, as root: the folder `chmod 0700`, the file `0400` (`umask 277`), written to a temp name and renamed, only when the content differs. The value goes on stdin, cut at its byte count (an exec's stdin never ends), so it is never in an argv, the script, a log or etcd; the error of a failed delivery is a fixed message, never the container's stderr. It is delivered when the pod or the content changed (a new pod has an empty folder), and with no headers the file is removed. |
| Build | At each Chrome start the root init reads the file and hands the entries on stdin to a uid 1000 child (`cpb/headers-ext.mjs write`), which writes a managed extension to `/dev/shm/cpb-ext` (folder `0700`, files `0400`; memory, never on a volume). Its static `declarativeNetRequest` rules use `modifyHeaders` with `set`, two rules per host pattern carrying that host's headers (top-level navigations, which have no initiator, and every other request type only when started by that host's own pages: `initiatorDomains` is the host or the wildcard's domain, so a page on another site can't make the browser send the header to the stg hosts; a navigation started by a link elsewhere still carries it, and the page can't read the answer; 🔬 `initiatorDomains` matching not run in a real Chromium), each matched by a `regexFilter` built from the pattern (`https://` only, so a header never goes out in clear text; host and port are anchored, so `example.com.evil.net` doesn't match). Names, values and hosts that could inject (line breaks, forbidden names, bad patterns) are dropped; the init logs only the count and the dropped names. |
| Load | Chromium runs with `--load-extension` and `--disable-extensions-except` for that folder; `DisableLoadExtensionCommandLineSwitch` is added to the one `--disable-features` flag. Policy then allows exactly that extension id (`ExtensionInstallAllowlist`, the id derived from the fixed path, the same function in the portal and the image, tested equal) beside `ExtensionInstallBlocklist ["*"]`, and `URLBlocklist` gains `chrome-extension://*` so pages can't open it. Only when the pool has headers. |
| Follow | **Docker:** the container's spec hash includes each header's name, hosts, secret NAME and the value's version id, never the value; a rotated or removed secret changes it, and the container is recreated at the next idle recreate. **Kubernetes:** the headers are not in the pod's spec hash, so a change never restarts the pod: the portal delivers again on the next pass (the pool or Secrets change triggers one) and, when the file changed, stops Chrome as soon as nothing is using it (no control, handoff, viewer or tool call for a minute; otherwise on a later pass); the next call wakes Chrome, which rebuilds its extension from the new file. A removed secret deletes the file, so its header stops without a workspace restart. A delivery that fails is audited (`headers_failed`, a fixed message) and tried again. A pool without headers hashes as before. |

**Who can read the value.**

| Reader | Can read it? |
| --- | --- |
| The agent, through files, tool results, transcripts, plugin files, `config.json`, the policy file, the pool view, the audit, logs | No. The value exists only in the portal's memory, the headers file or Secret, and the extension folder. A test searches the compiled pool, plugin, config, policy, spec, template and audit for it. |
| The gate's tool results | Masked by name (`cf-access-client-id` and `cf-access-client-secret` always, and every header name in the pool: `--redact a,b`; a `Name: value` line, a JSON `"Name": "value"`, a `| Name | value |` table row and a `{"name":…,"value":…}` pair in either order) and by value: the gate gets the secret's NAME (`--redact-env`) and the plugin's `.mcp.json` passes the variable through by reference (`"NAME": "${NAME:-}"`, no value in the file or on a command line); the value, JSON-escaped or URL-encoded, is replaced wherever it appears. Values under 8 characters are not masked. If the workspace doesn't have the secret as a variable of that name, only the structural masks apply (a residual). |
| Chrome's own process (uid 1000) | Yes: it has to send it, and the extension files in `/dev/shm` are Chrome-readable. The headers file itself is root's `0400` in a `0700` folder, which Chrome can't read. |
| The pool view and the audit | Names only: the header name, secret name, hosts and skip reasons. The audit row (`headers`, in `browser_events`) is written when the set changes, not at every delivery. |

**Not enforced** (stated in §13): an agent that drives raw CDP (`Network` events, `Fetch`, or the extension's own page) can read a header from the browser: the browser shares the workspace's network namespace, so one script on `127.0.0.1:9222` sees it. The gate never offers that, the gate masks the name and the value, and the extension's pages are blocked; but this is a guardrail like the rest of §13's Not enforced row, not a boundary. **Accepted by the coordinator (T-623, 2026-10-15)** instead of a proxy with its own CA: the staging token is already in the workspace. Treat it as readable by any agent that has the pool, scope it to staging, and rotate it if a session goes rogue.

**Needs a person.** Setting the real secret values (Secrets & env) and the pool's `headers` setting is the owner's or coordinator's step. No RBAC change: delivery on Kubernetes uses the `pods/exec` the portal already has (the earlier design's `secrets` rule in `deploy/k3s/rbac.yaml` was dropped).

**Verified** (unit tests, `apps/server/src/browser/headers.test.ts`, `gate.test.ts`, the cluster Job runs on the ticket): a matching host gets the header and a non-matching one doesn't; the value is in no place but the headers file; a removed secret leaves the header out and recreates the container without it; the file modes (`0400` file in a `0700` folder, config world-readable); the extension id the policy allows equals the id the path gives; header redaction by name and by value. The Kubernetes delivery runs against the fake API server (`kube.headers.test.ts`): the value only on stdin and in no argv, template, audit or Secret request; rotation writes again and stops Chrome once idle; removal deletes the file; no pod restart; a failure is audited without the value; a new pod gets the file again. Each of the key tests fails without its fix (mutations run, listed on the ticket).

**Not verified** (not testable in the pod): Chromium actually loading the extension under the managed policy and sending the header, and its `initiatorDomains` matching (needs the browser image and a real Chromium: the id, `--load-extension` and the newer-Chrome switch are from vendor behaviour 📄, not observed here 🔬); the two delivery scripts run by a real shell in a real browser container (the fake API server answers as they do; the scripts themselves are not executed in a test of this change); the memory `emptyDir` mount on the cluster. Check them in a rig namespace with a scratch portal and a header-echo site before relying on a real staging site.
