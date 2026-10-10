# PRD: Browser & desktop pool

| | |
| --- | --- |
| Status | **Draft v0.1.** ✅ = observed in our experiments: Docker 29.9 DinD on arm64, Chromium 154 and headless-shell 156, Playwright MCP 0.0.83, chrome-devtools-mcp 1.10.1, Claude Code 2.1.296, and read-only checks on the k3s cluster. 📄 = documented by the vendor, not observed by us. 🔬 = unverified, listed in §21. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-10 |
| Depends on | [Pools foundation](foundation-pools.md) (storage, delivery, pod template and companion containers, plugin marketplace), [MCP set](mcpset-pool.md) (plugin and launcher conventions) |
| Related | [Settings & policies](settings-policies.md) (tool rules, MCP allowlist, network posture), [Chat sessions](chat-sessions.md) (handoff card), [Monitoring dashboard](monitoring-dashboard.md), [Web app & PWA](web-app-pwa.md) (immersive routes, push), [Portal MCP server](portal-mcp.md) |

## 1. Summary

Browser & desktop pool gives the agent in each workspace its own browser, and optionally a full
Linux desktop, as tools it drives over MCP. People watch it live in the portal, on a phone or a
desktop, and take control when the agent needs a human: to sign in, pass a 2FA prompt or a CAPTCHA,
or fix something by hand.

Each workspace gets one browser container in the workspace's network namespace: a companion
container on Docker, a native sidecar on Kubernetes. Chrome's DevTools port (CDP) stays on
`127.0.0.1` there ✅, so only that workspace reaches it. Claude Code runs Playwright MCP over stdio
in the workspace against that port ✅, delivered as a portal plugin; the portal is never in the
tool-call path. The live view is noVNC in the portal, bridged to the browser's VNC server through
`exec` streams the portal opens. The bridge enforces view-only, and a take-over pauses the agent's
browser tools until the person hands back.

## 2. Background and problem

- Agents can't see web pages: they can't test what they just built, read a JavaScript page or
  finish a task behind a login. A browser installed by hand shares Claude Code's memory and can't
  be watched.
- Claude in Chrome needs a claude.ai login and is off under API keys 📄; computer use runs on macOS
  only 📄. Account Pool workspaces are Linux with API keys, so the pool ships its own MCP servers.
- CDP and VNC have no authentication: whoever reaches CDP reads every cookie 📄. Docker's default
  bridge lets workspaces reach each other ✅, and k3s runs with `--disable-network-policy` ✅.
- The operator's isnan agent computer proves the pattern (CDP on loopback, logins through a live
  view), but its central MCP proxy would put the portal in the request path, and its desktop
  serves unauthenticated VNC on `0.0.0.0:5920` to the whole cluster ✅.

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Tools for the agent.** A browser per workspace, and a desktop where needed, driven over MCP with no setup in the workspace, on DinD, host Docker and Kubernetes. |
| G2 | **Isolated by construction.** CDP, VNC and every helper port stay inside the workspace's own network namespace or the browser container. No Service, published port or proxy. |
| G3 | **Watch and help.** A live view on phone and desktop, view-only by default, with an explicit take-over and a human-login handoff that pauses the agent and takes no screenshots. |
| G4 | **Cheap when idle.** Explicit requests and limits per tier, Chrome stopped when idle, one browser crash never affects Claude Code or the workspace status. |
| G5 | **Native and push-only.** Claude Code's own MCP support through files; portal-initiated runtime calls only. |
| G6 | **Honest.** Every screen says what is enforced (loopback, view-only, pause for portal tools) and what isn't (the agent and workspace users can read the browser's cookies). |

## 4. Non-goals

- **Anti-bot evasion, CAPTCHA solving, fingerprint or user-agent spoofing, stealth plugins, proxies,
  mass account automation.** People handle logins, 2FA, QR codes and CAPTCHAs in the live view.
- **Claude in Chrome, computer use,** a CDP or MCP proxy in the portal, or a browser shared by
  workspaces.
- **Website credentials** in the portal, or typed for the agent.
- **Protecting the browser from its own workspace,** which can reach CDP ✅ and read the profile, as
  it reads delivered secrets (foundation §11).
- Session recording, stored screenshots or thumbnails (Q16), audio, GPU, Windows or macOS desktops.

## 5. Users and stories

**Admin**: manages pools and workspaces. **Workspace user**: works with the agent, often from a
phone. **Agent**: Claude Code, which may follow instructions injected by web content.

| ID | Story |
| --- | --- |
| US1 | As an admin, I create a browser pool from a tier (Headless, Browser, Desktop) and assign it when I create a workspace, or later. |
| US2 | As a workspace user, I ask Claude to check the staging sign-up flow, and it uses the browser with no setup. |
| US3 | As a workspace user, Claude opens the dev server it just started at `localhost:5173` in its browser. |
| US4 | On my phone, I see "Needs you: sign in to github.com". I open the live view, take control, type my password and 2FA code, and hand back. The agent continues and never captured a screenshot of it. |
| US5 | I watch the agent work in the browser from my phone, and a stray tap can't click anything. |
| US6 | I take control mid-task to fix something. The agent's browser calls wait until I hand back. |
| US7 | Claude downloads a CSV. It lands in `~/Downloads`, Claude reads it, and I download it from the portal. |
| US8 | As an admin, I assign a Desktop pool, and Claude uses a GUI app through screenshot and click tools. |
| US9 | As an admin, I see which browsers run and what they use. Idle ones stop on their own, and a browser crash leaves the workspace running. |
| US10 | As an admin, I reset a workspace's browser data to sign it out everywhere, and the data goes when the browser is unassigned. |

## 6. Scope boundary

| Allowed | Not allowed |
| --- | --- |
| Browsing with accounts a person signs in to through the live view. | The portal collecting, storing or typing website passwords, 2FA codes or session cookies. |
| A person solving a CAPTCHA, 2FA or QR prompt during a handoff. | Automated CAPTCHA solving, evasion flags, spoofed fingerprints or user agents, rotating proxies. |
| Reviewed, pinned MCP servers delivered as a portal plugin. | `npx …@latest` at runtime, or servers that fetch code on first use. |
| Viewing and controlling a workspace's browser from the signed-in portal. | Relaying raw CDP or VNC to the user's browser, or publishing either port. |
| Claude's own MCP support with API-key credentials. | Claude in Chrome, computer use, or any claude.ai credential. |
| What sites' terms allow; the operator answers for that. | Any feature whose purpose is to hide automation. |

## 7. Solution overview

```
 Portal                              Workspace network namespace (127.0.0.1 shared)
 ┌───────────────────────────┐       ┌──────────────────────────┐ ┌─────────────────────────────┐
 │ Browser pools (revisions) │ push  │ workspace container      │ │ browser container           │
 │ Compiler: plugin, drop-in,│──────▶│ claude ─stdio─▶ gate ─▶  │ │ cpb-supervisor :9220 status │
 │  Chrome policy, spec      │       │   Playwright MCP ──CDP───┼─▶ Chromium CDP :9222          │
 │ Structure manager:        │create │ ~/Downloads ◀────────────┼─┤ Xvfb, openbox (desktop)     │
 │  companion or sidecar     │──────▶│ ~/.claudepilot/browser/  │ │ x11vnc on /run/cpb/vnc.sock │
 │ Live-view bridge ◀── WS ──│◀─exec─┼──────────────────────────┼─┤ desktop MCP :8930           │
 │  view-only filter, control│ socat └──────────────────────────┘ └─────────────────────────────┘
 └───────────────────────────┘
```

1. **Pool:** a template (tier, engine, resources, profile, policies, MCP servers, live-view rules),
   one per workspace (foundation §3).
2. **Topology:** the foundation's structure manager adds the browser container (§10).
3. **MCP:** the `cpb-browser` plugin and a drop-in. A gate wraps each stdio server: it wakes Chrome,
   refuses calls while a person has control, and adds a handoff tool (§11).
4. **Live view:** noVNC bridged over `exec`, input filtered by role, take-overs audited (§12).
5. **Lifecycle:** the container follows the workspace; Chrome starts on use, stops when idle (§14).

## 8. Functional requirements

| ID | Pools |
| --- | --- |
| FR1 | Tiers. **Headless**: Chromium with no display, for automation and tests. **Browser** (default): headful Chromium on a virtual display with a live view. **Desktop**: the same plus a window manager, panel, terminal and file manager, and a desktop MCP server (Q14). One image serves all three (§14.1). |
| FR2 | Resources: CPU and memory requests and limits (tier defaults in §14.1), `/dev/shm`, a PIDs limit, and the display (1280×800 default; 1024×768, 1366×768, 1920×1080). The editor shows each size's screenshot cost: about 1.3k image tokens at 1280×800, 2.6k at 1920×1080 📄. |
| FR3 | Engine: Chromium (amd64 and arm64), or Google Chrome on amd64 targets only (🔬 Q10). A Chrome pool is refused on arm64 targets with the reason, never silently swapped. |
| FR4 | Profile: **Persistent** (in the home volume) or **Fresh** (wiped at each browser start). Agent sessions: **Shared logins** (Playwright MCP drives the default context) or **Isolated** (`--isolated`: a context per Claude session, lost when it ends ✅). Browser and Desktop default to Persistent and Shared, Headless to Fresh and Isolated. |
| FR5 | Downloads go to `~/Downloads`, mounted at the same path in the browser container, through the `DownloadDirectory` policy with no prompt (🔬 Q3). Dangerous types are blocked (`DownloadRestrictions: 1`); "Block all downloads" is a switch. |
| FR6 | Chrome policies: blocked and allowed sites, extensions (none by default, or reviewed IDs), and the baseline in §13.4, written as a managed policy file, never as flags. |
| FR7 | MCP servers: Playwright MCP (always), chrome-devtools-mcp (optional), the desktop server (Desktop). Tool rules: allow, ask or block per tool; by default ask before `browser_file_upload` and block `browser_run_code_unsafe`. |
| FR8 | Start **On first use** (default: the first tool call or viewer starts Chrome) or **With the workspace**. Idle stop after 30 minutes without a call, viewer or control (Desktop 120, or never). |
| FR9 | Live view and take-over switches. Headless gets a view-only screencast and no handoff (§12.5). |

| ID | Assignment and runtime |
| --- | --- |
| FR10 | Assign at create (Add-ons), from the workspace row, or in bulk: one pool per workspace, following current or pinned (foundation §5). |
| FR11 | Before a change that restarts anything, the dialog says what: Docker recreates the browser container and the workspace keeps running; Kubernetes restarts the pod, with "Restart now / When it next stops" and the count of live sessions (§10.3). |
| FR12 | Unassigning removes the plugin and drop-in, then the browser container, and deletes the profile unless "Keep browser data" is ticked (Q13). |
| FR13 | The structure manager creates, starts, stops and removes the browser container with the workspace (§10). The workspace row shows the browser's own state (§15); a browser failure never sets the workspace to Error. |
| FR14 | Self-healing start: stale `Singleton*` locks removed when no Chrome runs, X and VNC supervised, health checked passively (`ss -ltnx`), never by connect-and-drop. |
| FR15 | Chrome starts with its sandbox when it can, else with `--no-sandbox` and a "Sandbox off" badge, or not at all if the pool requires the sandbox (§13.3). |
| FR16 | Memory guard: at 80% and 88% of the memory limit the supervisor sends `Memory.simulatePressureNotification` (moderate, critical), as isnan does 📄. |
| FR17 | Restart browser, Stop browser, and Reset browser data ("This signs the browser out of every site": deletes the profile and downloads). |

| ID | MCP, handoff and live view |
| --- | --- |
| FR18 | The `cpb-browser` plugin and `70-claudepilot-browser.json` drop-in on all targets, through the foundation's marketplace, with pinned, pre-installed packages (§11). |
| FR19 | The gate starts Chrome on demand and refuses every browser call while a person has control (§11.3). |
| FR20 | `browser_handoff(reason)` reaches the portal within 10 s and blocks until the person hands back, declines, or 10 minutes pass (§12.4). |
| FR21 | An immersive live view per workspace, view-only unless the viewer has control, enforced in the bridge (§12). |
| FR22 | One controller at a time, audited, released when the controller leaves. Caps: 3 viewers per browser, 20 in total; hidden tabs disconnect after 60 s. |

## 9. Data model

Stored in the portal database (foundation §4). A browser pool holds no secrets, and the portal never
stores frames, keystrokes or cookies. Pools use the foundation's tables with type `browser`:

```json
{ "tier": "browser", "engine": "chromium", "display": "1280x800", "profile": "persistent", "sessions": "shared",
  "resources": { "cpu": [0.5, 2], "memoryMiB": [1024, 3072], "shmMiB": 1024, "pids": 512 },
  "start": "first_use", "idleMinutes": 30, "downloads": { "enabled": true, "restrictions": 1 },
  "policy": { "blocked": ["metadata.google.internal"], "allowed": [], "extensions": [] },
  "mcp": { "devtools": false, "desktop": false, "tools": { "browser_file_upload": "ask", "browser_run_code_unsafe": "block" } },
  "liveView": true, "takeOver": true, "requireSandbox": false }
```

| Table | Key fields |
| --- | --- |
| `browser_instances` | workspace_id, pool_id, revision, runtime_ref (container ID, or pod and container), image_digest, state (§15), chrome (`asleep` \| `starting` \| `up` \| `crashed`), sandbox (`on` \| `off` \| `unknown`), controller (viewer socket or null), control_since, last_activity_at, last_tool, profile_bytes, downloads_bytes, restarts, oom_kills, last_error |
| `browser_handoffs` | id, workspace_id, session_id, reason (200 characters, redacted), site (host only), state (`waiting`, `in_control`, `handed_back`, `declined`, `expired`), requested_at, resolved_at, note (200 characters), actor |

Starts, stops, crashes, OOM kills, idle stops, wakes, sandbox state, viewers, take-overs, handbacks
and resets go to the foundation's event log, kept 90 days.

## 10. Topology per target

### 10.1 Docker (DinD and host)

| Setting | Value and reason |
| --- | --- |
| Identity | `claudepilot-<name>-browser`, labels `claudepilot.managed`, `claudepilot.workspace`, `claudepilot.role=browser`, pool and revision. The runtime stays the record. |
| Network | `NetworkMode: container:claudepilot-<name>`. Shares the workspace's loopback and hostname ✅: CDP on `127.0.0.1:9222` answered from the workspace and refused another workspace ✅. Docker allows no published ports, hostname, DNS or extra hosts in this mode 📄. |
| Process | User `1000:1000` (owns the home volume's files), `Init: true` (reaps Chrome's children), `RestartPolicy: no` (the portal restarts it, below). |
| Limits | `NanoCpus`, `Memory`, `PidsLimit`, `ShmSize` 1 GiB. Its own cgroup, so a runaway tab can't OOM Claude Code. Docker's default `/dev/shm` is 64 MiB ✅. |
| Hardening | `CapDrop: [ALL]`, `no-new-privileges`, and seccomp per §13.3. |
| Mounts | Two subpaths of the workspace's home volume ✅ (Docker 29): `.claudepilot/browser/profile` at `/data/profile`, `Downloads` at `/home/node/Downloads`. Never the whole home (§13.5). |
| Config | Chrome policy and supervisor config written by the archive API before each start. Each revision recreates the container, so nothing drifts. |

**Restart coupling.** After a workspace `docker restart`, the companion still showed Up but CDP was
unreachable, and a companion can't start while its workspace is stopped ✅. So the portal's Docker
event watch (foundation §6.3) restarts the companion on every workspace `start`, stops it on `die`
or `stop` (a portal stop stops it first, so Chrome flushes cookies), and removes it on `destroy`,
then checks `127.0.0.1:9220/status` from the workspace. A restart while the portal is down waits
for the portal (🔬 Q8).

### 10.2 Kubernetes

A native sidecar: an init container named `browser` with `restartPolicy: Always`, after `seed-home`
and the foundation's sync init. A Deployment with this sidecar, a memory-backed `/dev/shm` and an
`exec` startup probe passed a server-side dry run on the cluster (k3s v1.35.5) ✅. Running it is 🔬 Q1.

| Setting | Value and reason |
| --- | --- |
| Order | Starts before the workspace container, gated on its startup probe, and stops after it 📄. Scaling to 0 stops both. |
| Probes | `exec` only (`cpb-ctl ready` every 2 s up to 60 s; `cpb-ctl alive` every 30 s). Kubelet TCP and HTTP probes target the pod IP and never see loopback listeners. |
| Resources | Explicit requests and limits, which add to the pod's totals 📄 (today's driver sets only limits, so requests equal them). |
| `/dev/shm` | `emptyDir` with `medium: Memory` and the pool's `sizeLimit`. It counts against the browser container's memory limit 📄. |
| Mounts | Home PVC `subPath` mounts for `.claudepilot/browser/profile` and `Downloads`, which `seed-home` creates first. ConfigMap `ws-<name>-browser` (ownerReference to the Deployment, no secrets) mounted read-only at the Chrome policy folder and `/etc/cpb`. |
| Security | uid 1000, `runAsNonRoot`, `allowPrivilegeEscalation: false`, drop ALL, `readOnlyRootFilesystem` with `emptyDir` for `/tmp` and `/run/cpb`, seccomp per §13.3. Pod: `automountServiceAccountToken: false`. |

The Deployment uses `Recreate`, so adding, removing or resizing the sidecar restarts the pod; the
foundation's template manager batches it with other template changes (A2). Today the runtime marks
the workspace Error when any init container is stuck and sums usage across containers (A5).

### 10.3 What a change costs

| Change | Docker | Kubernetes |
| --- | --- | --- |
| Assign, unassign, tier, engine, resources | Companion recreated; workspace keeps running | Pod restart, confirmed and batched (FR11) |
| Policies, idle, profile mode | Companion recreated | ConfigMap update; Chrome restarts at its next idle moment or on "Restart browser" (🔬 Q11) |
| Plugin, servers, tool rules | Workspace files only (§11.4) | Same |
| Workspace restart | Portal restarts the companion | The sidecar restarts with the pod |

## 11. MCP wiring and delivery

### 11.1 What gets written

| Path | Content |
| --- | --- |
| `/etc/claude-code/managed-settings.d/70-claudepilot-browser.json` | `enabledPlugins`: `"cpb-browser@claudepilot": true`. `permissions.ask` and `permissions.deny` for the pool's tool rules, as `mcp__plugin_cpb-browser_<server>__<tool>`. `env`: `CLAUDEPILOT_BROWSER_CDP` (`http://127.0.0.1:9222`) and `CLAUDEPILOT_BROWSER_DOWNLOADS`, written empty when unassigned (foundation §6.4). |
| `/etc/claudepilot/marketplace/plugins/cpb-browser/<hash12>/` | `plugin.json`, `.mcp.json` (below), and `skills/browser/SKILL.md`: snapshots before screenshots, one tab per task, `browser_handoff` for logins, 2FA and CAPTCHAs, no screenshots while a person types, files in `~/Downloads`. Versioned folders with a repointed entry, as Skillset does. |
| `/etc/claudepilot/bin/browser-mcp` | The gate (§11.3), in the foundation's script bundle, so existing workspaces get updates. |
| `~/.cache/claudepilot/mcp/npm/` | `@playwright/mcp@0.0.83` and `chrome-devtools-mcp@1.10.1`, pre-installed through the run-in-workspace step (MCP set A4). Never `npx -y` at runtime. |

```json
{ "mcpServers": {
    "browser":  { "command": "/etc/claudepilot/bin/browser-mcp", "args": ["playwright", "--",
                  "--cdp-endpoint", "http://127.0.0.1:9222", "--output-dir", "/home/node/.claudepilot/browser/output"] },
    "devtools": { "command": "/etc/claudepilot/bin/browser-mcp", "args": ["devtools", "--",
                  "--browser-url", "http://127.0.0.1:9222", "--no-usage-statistics", "--no-performance-crux"],
                  "env": { "CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS": "1", "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS": "1" } },
    "desktop":  { "type": "http", "url": "http://127.0.0.1:8930/mcp" } } }
```

Isolated pools add `--isolated`. Nobody writes `managed-mcp.json`: Claude Code loaded Playwright MCP
from it ✅, but it takes exclusive control (`claude mcp add` then failed ✅) and would block every
plugin server, and `managedMcpServers` takes only remote HTTPS servers 📄 (A1).

### 11.2 Servers

| Server | Where and how | Notes |
| --- | --- | --- |
| `browser`: Playwright MCP | stdio in the workspace, through the gate | Drove the browser container's Chrome over CDP ✅. 25 tools; text snapshots keep context small; uploads stream files from the workspace ✅. A download click saved nothing ✅, so downloads rely on the browser's own policy (🔬 Q3). Tool schemas change between releases ✅ (`browser_click` now takes `target`): pinned, with contract tests. |
| `devtools`: chrome-devtools-mcp (optional) | stdio in the workspace, through the gate | 30 tools ✅: traces, Lighthouse, network bodies, console. A workspace-only upload path reported success but sent 0 bytes ✅, so the skill limits uploads to `~/Downloads`, which has the same path on both sides. Its telemetry is off by flag and variable. |
| `desktop` (Desktop tier) | First-party, Streamable HTTP on `127.0.0.1:8930` in the browser container, with a host allowlist | Computer-use vocabulary: `screenshot`, `click`, `double_click`, `right_click`, `move`, `drag`, `scroll`, `type`, `key`, `open_url`, `launch`, `wait`. Screenshots only when asked, at display size. Built on `xdotool` and `scrot`, which drove a 1280×800 display in the test ✅. Playwright's HTTP mode taught us to bind `127.0.0.1` and set allowed hosts, or Claude Code shows "Needs authentication" ✅. Loading it from a plugin is 🔬 Q5. |

Tool names look like `mcp__plugin_cpb-browser_browser__browser_navigate`; the longest known is 61
characters (MCP set Q6 covers names over 64).

### 11.3 The gate

`browser-mcp <server> -- <args>`, a dependency-free Node script (the image has Node 22):

1. Wakes Chrome (`POST 127.0.0.1:9220/wake`), waits up to 30 s for CDP, starts the pinned server and
   relays newline-delimited JSON-RPC (🔬 Q6).
2. On each `tools/call`, reads the control state (cached 1 s). While a person has control it answers
   with a tool error instead of forwarding: "A person has control of the browser since 14:02. Wait
   for the handback, then call browser_snapshot." It reports activity (time, tool, session).
3. Adds `browser_handoff(reason)` (§12.4) and `browser_status()` to the `browser` server.
4. With shared logins, two sessions drive the same tab ✅, so when another session's gate is active
   the first result adds "Another session uses this browser: open your own tab" (🔬 Q7).

The gate pauses cooperative agents. It isn't a boundary: anything in the workspace can open CDP.

### 11.4 When changes apply

| Change | Running sessions | New sessions |
| --- | --- | --- |
| Plugin added or removed, server options | After `/reload-plugins` 📄 (🔬 Q5: does it restart stdio servers?) | Yes |
| Tool rules | Next tool call (managed settings reload) | Yes |
| Take-over, Chrome asleep or awake | Next tool call (gate) | Yes |
| Chrome restarted (revision, idle wake) | 🔬 Q7: next call, or a new session | Yes |

Chat sessions offer Reload. Under an MCP allowlist, this fragment reports its matchers as MCP sets
do (MCP FR19): `serverCommand` with the gate's exact argv, and `serverUrl` for `desktop`.

## 12. Live view and take-over

### 12.1 Path

- Route `/admin/workspaces/:target/:name/browser`. Socket `GET /api/workspaces/:target/:name/browser/view`,
  checked like the shell socket (Origin equals Host, session cookie).
- Bridge: an `exec` in the browser container running `socat -t 5 STDIO UNIX-CONNECT:/run/cpb/vnc.sock`.
  An exec stream read `RFB 003.008` from a loopback x11vnc ✅; socat's default 0.5 s half-close cut
  the first try ✅, hence `-t 5`. Kubernetes uses the same `exec`, with `pods/portforward` to a
  loopback port as the fallback, which reached a loopback-only listener ✅ (🔬 Q4 for both).
- x11vnc serves the Xvfb display on that unix socket only (🔬 Q4), so neither the workspace nor
  anything else but the bridge reaches it. noVNC's core (MPL-2.0 📄) loads on this route only. No
  websockify, web server or port in the workspace.

### 12.2 View-only, enforced in the bridge

noVNC's `viewOnly` only stops a cooperative client 📄. After the handshake, the bridge frames the
client's RFB messages and forwards them by role. ServerCutText (the remote clipboard) goes to the
controller only. Frames pass through untouched and are never stored, logged or thumbnailed.

| Client message | Viewer | Controller |
| --- | --- | --- |
| SetPixelFormat (0), SetEncodings (2), FramebufferUpdateRequest (3) | Forward | Forward |
| KeyEvent (4), PointerEvent (5), ClientCutText (6) | Drop | Forward |
| Any other type | Close the socket | Close the socket |

### 12.3 Take-over

| State | Entered by | Agent's browser tools | Viewers |
| --- | --- | --- | --- |
| Watching | Default | Run | View-only |
| Needs you | `browser_handoff` | The handoff call waits | Banner with the agent's reason and the site |
| You have control | Take control (one tap, audited) | Refused by the gate and the desktop server | The controller's input passes; others see "Another viewer has control" |
| Handed back | Hand back; the controller gone for 60 s; 15 minutes without input, after a prompt | Run; a waiting handoff returns | View-only |

The portal sets the state with `exec cpb-ctl control on|off` in the browser container. The workspace
can read it (`GET 127.0.0.1:9220/status`) but not change it. A call already running may finish.

### 12.4 Human-login handoff

1. The agent meets a login, 2FA, QR code or CAPTCHA and calls `browser_handoff("Sign in to github.com")`.
2. The portal reads browser status every 10 s while the agent is active, so within 10 s "Needs you"
   shows on the workspace row, in the chat session's approvals dock, in Monitor, and as a push
   notification where the web app can send one.
3. The person opens the live view and takes control. Agent calls are refused, the desktop server
   refuses screenshots and input, and nothing captures the screen.
4. The person types, then taps Hand back with an optional note. The call returns "Handed back: 2FA
   done. Check the result with browser_snapshot, not a screenshot." Decline returns "Declined" and
   the note; after 10 minutes the call returns "No response".

This keeps a cooperative or confused agent from capturing what the person types through the
portal's tools. A hostile one still reaches CDP and the new session's cookies (§13.1).

### 12.5 Headless tier

No display, so no VNC. The portal opens CDP over the same `exec` tunnel (an IP `Host` and no `Origin`
pass Chrome's checks ✅), runs `Page.startScreencast` (JPEG, quality 60) on the active tab and relays
frames: 1 frame in 2 s idle, about 11 a second at about 52 KB while scrolling ✅. View-only; the
user's browser never receives raw CDP. `browser_handoff` answers "No live view for sign-in here."

## 13. Security requirements

**Enforced:** no other workspace or pod reaches CDP, the control port or the desktop server; nothing
but the bridge reaches VNC; viewers can't send input without control; raw CDP and VNC never reach a
browser tab; the live-view socket needs a portal session. **Not enforced:** workspace users and the
agent can drive the browser and read its cookies, through CDP ✅ or the profile on disk. Policies and
Playwright's origin flags are guardrails; Playwright MCP says it isn't a security boundary 📄. Every
assign dialog says so.

| Area | Requirement |
| --- | --- |
| Loopback | Chrome binds CDP to `127.0.0.1`, and full Chromium ignored `--remote-debugging-address=0.0.0.0` ✅. Never headless-shell's stock entrypoint (socat on `0.0.0.0` ✅), `--remote-allow-origins=*`, a Service or a published port. Chrome's checks stay on: a name in `Host` got 500, a foreign `Origin` 403 ✅. |
| Display | Xvfb runs with `-nolisten tcp -nolisten local`, because a second container in the namespace drove the display through its abstract socket ✅ (🔬 Q9). VNC is a unix socket (§12.1). |
| The isnan lesson | isnan's desktop serves VNC on `0.0.0.0:5920` with no authentication ✅. The supervisor stops the browser with "Exposed listener" if anything in its container listens on a non-loopback address, and CI scans every target from another container or pod. |
| Chrome sandbox | Non-root Chromium under Docker's default seccomp profile failed with "No usable sandbox" ✅ and worked with seccomp unconfined or `SYS_ADMIN` ✅; neither is used. Docker gets Playwright's profile (Docker's default plus user namespaces 📄) where the target probe shows it works (A4); Kubernetes a `Localhost` profile the operator installs on the nodes, which look like LXC containers (🔬 Q2). Otherwise `--no-sandbox`, with uid 1000, no capabilities, `no-new-privileges`, two mounts, no service account token, no secrets, its own cgroup, and a "Sandbox off" badge. |
| Chrome baseline | Flags proven on isnan's cluster 📄: `--user-data-dir` (Chrome 136 ignores the debugging port on the default profile 📄), `--remote-debugging-port=9222 --no-first-run --no-default-browser-check --password-store=basic --disable-background-networking --disable-component-update --disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider`. Policy: `BrowserSignin: 0`, `SyncDisabled`, `PasswordManagerEnabled: false`, autofill off, no metrics or background mode, `HighEfficiencyModeEnabled`, `ExtensionInstallBlocklist: ["*"]`, the download keys (FR5), `RestoreOnStartup: 5`, and a `URLBlocklist` with the portal host, metadata hosts and `cluster.local`. URL lists can't express IP ranges, so they don't replace egress control. |
| Profile | `~/.claudepilot/browser/profile` (`0700`) holds live sessions. The secret-path registry lists it (A6): Claude gets Read and Edit deny rules, and Chat refuses to preview or download it. Never synced or exported; deleted on unassign (default), Reset, and with the workspace. |
| Mounts | Only the profile and `~/Downloads`, so a renderer exploit under `--no-sandbox` can't write `~/.bashrc`, `~/.claude` or `~/.ssh`. |
| Files | Dangerous download types are blocked, and the skill says never to run a download. Uploads ask first, since injected instructions could send workspace files to a site. The gate deletes Playwright output older than 7 days. |
| Network | k3s enforces no NetworkPolicy ✅, so a page or a prompt-injected agent reaches every cluster service, isnan's open VNC included; Docker workspaces reach each other on the default bridge ✅. Kubernetes: browsers only where the target probe sees enforcement, with a policy denying ingress and egress to private, link-local and cluster ranges except DNS; otherwise only after an admin ticks "Run browsers without network isolation on this target", audited and shown on every live view (Q12). Docker: a network per workspace, so workspaces can't reach each other; the host and LAN stay reachable, and the UI says so (A8). |
| Portal | Take-over, handoff answers and Reset are UI-only, never over [Portal MCP](portal-mcp.md) (A11). Text typed in the live view travels as key events and is never logged; audit records who took control and when, never keystrokes or frames. Images are built in the GHCR workflow for amd64 and arm64 and pinned by digest. |

## 14. Capacity and lifecycle

### 14.1 Image and tier defaults

One image, `claudepilot-browser`, on `node:22-bookworm-slim`: Debian Chromium, Xvfb, openbox, x11vnc,
xdotool, scrot, socat, fonts, the supervisor and the desktop server, plus a panel, terminal and file
manager for Desktop. The tested equivalent was 1.6 GB ✅. A `-chrome` variant exists for amd64.

| Tier | CPU request → limit | Memory request → limit | `/dev/shm` | PIDs | Measured |
| --- | --- | --- | --- | --- | --- |
| Headless | 0.25 → 2 | 0.5 → 2 GiB | 512 MiB | 512 | headless-shell: 64 MiB idle, 0.38–0.46 GiB with three heavy tabs, 80–142 PIDs ✅. Chromium `--headless` is 🔬 Q10. |
| Browser | 0.5 → 2 | 1 → 3 GiB | 1 GiB | 512 | Chromium, Xvfb, openbox, x11vnc: 0.29 GiB idle, 0.71–0.75 GiB with the same tabs, up to 374 PIDs ✅ |
| Desktop | 0.5 → 2 | 1.5 → 4 GiB | 1 GiB | 1024 | Browser plus apps; isnan's desktop idles at 0.1 GiB 📄 |

A viewer costs about 0.25–0.3 of a core while the screen changes: scrolling took 31% of a core alone
and 59% with one viewer, 20% of it x11vnc ✅. On the cluster, k3s-node2 already runs at 85% CPU and
80% memory in requests, and pods are evicted below 500 Mi free ✅. Running browsers are capped per
target (Docker 4, Kubernetes 2, A8); past the cap, starts are refused with the reason.

### 14.2 Lifecycle

| Event | Browser container | Chrome |
| --- | --- | --- |
| Workspace starts | Docker: the portal starts it. Kubernetes: it starts first. | Asleep until the first tool call or viewer, or started at once ("With the workspace") |
| First tool call or viewer | | Woken by the gate or the bridge (🔬 Q7 times it) |
| Idle for the pool's time | Keeps running (only the supervisor) | Closed through CDP `Browser.close`; reopens on the next call |
| Workspace stops | Docker: stopped first. Kubernetes: stops after the workspace. | Closed cleanly |
| Crash or OOM kill | Restarted with backoff, by the portal (Docker) or the kubelet | Error after 3 crashes in 10 minutes; the workspace is unaffected |
| Workspace removed | Removed, with the home volume | |

## 15. User experience

Existing components only (PageHeader, Section, Card, Badge, Menu, FormDialog, Segmented, Select,
ChipGroup, SwitchRow, TextArea, ConfirmDialog, EmptyState, LoadError) plus Monitoring's StatusDot.

| Surface | Design |
| --- | --- |
| Pools → Browser | A tab under Pools (Skillset A8). One card per pool: name, tier badge, "2 CPU · 3 GB", profile mode, "Used by 4 · 2 running", menu. The editor (full screen on phones): Tier, Engine, Resources (tier defaults filled in), Display, Profile and Agent sessions, Start and Idle stop, MCP servers, tool rules (Allow / Ask / Block), Downloads, sites, Extensions, Live view, Take-over, Require sandbox, Preview files. |
| Workspaces | A "Browser" select in the create dialog's Add-ons ("None" first). Each row: a browser chip (StatusDot and state) and a **Live view** button beside Shell and Chat; the menu adds Browser…, Restart browser, Reset browser data. The Configuration row adds sandbox, memory against limit, profile and downloads size, and network isolation. |
| States | Off, Stopped, Sleeping, Starting, Ready, Agent active (a tool call in the last 90 s), Needs you (gold "!"), You have control (accent), Error (danger, with the reason). |
| Live view frame | An immersive route outside AppShell, like the shell page. A 48 px header plus the safe area: back, name over target, state chip, viewer count, one 44 px primary button (**Take control** or **Hand back**), and ⋯ (Fit or 100%, Quality: Auto or Low data, Keys, Restart browser, Downloads, Open shell). The canvas fills the rest, scaled to fit. |
| Banners | Needs you (gold): "The agent asks you to sign in to github.com · 3 min", with Decline and Take control. In control (accent): "You have control · the agent is paused", with Hand back. "This browser isn't network-isolated" where it applies. |
| Phone gestures | In control: tap clicks, two-finger tap right-clicks, long press then drag drags, two-finger drag scrolls, pinch zooms the view, one-finger drag pans when zoomed. Watching: gestures only zoom and pan, so a stray tap clicks nothing. |
| Phone typing | A canvas can't take the phone keyboard (isnan lesson), so a text bar sends what's typed as key events, with an eye toggle that hides it for passwords. Above it: a keys row (Esc, Tab, ⌫, ↵, arrows, Ctrl, Alt, Ctrl+L, hold to repeat) and a Caps Lock chip, cleared before typing. |
| Desktop keyboard | In control, keys go to the browser while the canvas has focus, Esc included; clicking outside or "Release keyboard" releases it. Keys the host browser keeps (Ctrl+W, Ctrl+T) are in ⋯ → Keys. Paste goes through the text bar; "Copy from browser" is the controller's only. |
| Connection | Reconnects with backoff ("Reconnecting…"). A stopped workspace shows "Browser stopped · Start workspace". A tab hidden for 60 s disconnects. The route's code, noVNC included, loads only here. |
| Accessibility | The canvas is labelled; state changes are announced politely, handoffs assertively; every control works from the keyboard; status pairs color, shape and text; targets are 44 px. |
| Chat and Monitor | Browser tool rows read "browser · navigate github.com" with a Live view link. A handoff is a card in the approvals dock (Decline, Open live view); the session list shows "Needs you · browser". Monitor lists handoffs as attention items and shows the browser as its own row in the workspace drill-down. |

## 16. Observability and audit

- Event log (§9) with the actor. Take-overs and handoffs name the viewer's session, anonymous while
  everyone shares one code (Q15).
- Metrics for [Monitoring](monitoring-dashboard.md): browsers by tier and target, memory against
  limit, OOM kills and restarts apart from the workspace's, viewers, take-overs, handoff wait, wake
  time. MCP calls come from Monitoring's own hooks, tagged `managed_by: browser`.
- Security events: an exposed listener (High), a browser without its sandbox or network isolation.

## 17. Testing and verification

| Suite | What it covers | Where |
| --- | --- | --- |
| Topology and exposure | Each port from the workspace (open) and from another workspace or pod (refused); `ss` shows loopback and unix sockets only; a workspace dev server at `localhost`; the X abstract socket closed (Q9) | CI on DinD and k3d; by hand on Docker Desktop and k3s |
| Restart coupling | `docker restart`, stop and start outside the portal, a daemon restart (Q8), a killed or OOM-killed browser: back within 15 s, workspace status untouched | CI |
| MCP end to end | Plugin loads in `-p` and interactive sessions (Q5); navigate, snapshot, upload, download by policy (Q3); isolated sessions; refusal while in control; handoff answers; schemas per pinned version | CI, on every version bump |
| View-only bridge | Crafted KeyEvent, PointerEvent and ClientCutText from a viewer are dropped; unknown types close the socket; ServerCutText reaches only the controller | CI |
| Sandbox matrix | Default seccomp, Playwright's profile, a k3s `Localhost` profile; the fallback badge; "Require sandbox" (Q2) | By hand, per target |
| Kubernetes | Sidecar order and probes, `/dev/shm` accounting, batched restarts, status and usage split, exec against port-forward latency (Q1, Q4) | k3d in CI; k3s before B3 |
| Capacity | Three heavy tabs per tier, memory guard at 80 and 88%, PIDs, viewer CPU, idle stop and wake (Q7) | By hand, before each image bump |
| Phone UI | Playwright at 360×780, 390×844 and desktop: gestures, text bar, keys, take control, hand back, reconnect; axe | CI |
| Leaks | Text typed in the text bar and handoff notes never reach logs or events; no frames stored | CI |

## 18. Rollout and milestones

| Milestone | Scope | Gate |
| --- | --- | --- |
| B0 | Spikes for Q1–Q7, Q9; the image for amd64 and arm64 | Foundation F2 |
| B1 | Docker, Browser tier: pool type and editor, companion and restart coupling, plugin and gate, Playwright MCP, live view, take-over and handoff, row chip, chat card | Foundation F2, F5, F6; MCP set A4 run step; exposure and view-only suites pass |
| B2 | Idle stop and wake, memory guard, sandbox probe, Restart and Reset, downloads in Files, Monitoring, per-target caps | Monitoring D3; Settings S2 |
| B3 | Kubernetes: sidecar, ConfigMap, bridge, status and usage split | Foundation F3; Q1, Q4; Q12 decided |
| B4 | Desktop tier and desktop server | Q9, Q14 |
| B5 | Headless tier with screencast, chrome-devtools-mcp, extensions, Google Chrome on amd64 | Q10 |

## 19. Success metrics

| Metric | Target |
| --- | --- |
| Assigning a pool to a working browser tool call in a new session | Under 1 minute on Docker (image cached); under 3 minutes on Kubernetes, restart included |
| Browser ports reachable from another workspace or pod | Zero (CI scan) |
| Agent browser calls run while a person has control; screenshots by portal-delivered servers during a handoff | Zero; zero |
| Workspaces set to Error by a browser failure | Zero |
| Handoff visible in the portal after the call | p95 under 10 s |
| Live view first frame; input to screen in control | p75 under 2 s on Docker, 4 s on Kubernetes; p95 under 150 ms on Docker, 300 ms on Kubernetes (🔬 Q4) |
| Browser back after a workspace restart, portal running | Within 15 s |
| Idle Chrome stopped | Within the idle time plus 1 minute |

## 20. Amendments to other PRDs

| ID | PRD and section | Change |
| --- | --- | --- |
| A1 | Foundation §7 | Browser & desktop row: files `managed-settings.d/70-claudepilot-browser.json`, `/etc/claudepilot/marketplace/plugins/cpb-browser/**`, `/etc/claudepilot/bin/browser-mcp`; keys `enabledPlugins` entry `cpb-browser@claudepilot`, `permissions.ask` and `permissions.deny` entries starting `mcp__plugin_cpb-browser_`, `env` `CLAUDEPILOT_BROWSER_*`. Drop "its MCP server entry": `managedMcpServers` takes only remote HTTPS servers, and no owner writes `managed-mcp.json`. |
| A2 | Foundation §6.2, §6.6 | One structure manager: Docker companion containers (create, restart on every workspace start from the event watch, stop, remove) and one compiled pod template per workspace with explicit requests and `automountServiceAccountToken: false`, so the browser sidecar, `/dev/shm` and other pools' changes share one confirmed restart. |
| A3 | Foundation §6.2 | Companion files: non-secret config written into the companion by the archive API before it starts (Docker), or a ConfigMap `ws-<name>-browser` with an ownerReference, mounted read-only in the sidecar (Kubernetes). Never secrets. |
| A4 | Foundation §9 | Target capability probes, stored per target: CPU architecture, Docker API version (volume subpaths need 1.45), whether Chrome's sandbox starts under Docker's default and Playwright's seccomp profiles, and NetworkPolicy enforcement (k3s node args, policy controller pods). |
| A5 | Foundation F3, Kubernetes runtime | Workspace status comes from the `workspace` container and the ordinary init containers only; sidecars report their own state; usage is per container. `seed-home` creates `~/.claudepilot/browser/profile` and `~/Downloads`. |
| A6 | Foundation (secret-path registry) | Register `~/.claudepilot/browser/**` as sensitive: generated Read and Edit deny rules, and refused by every preview and download path. |
| A7 | MCP set §8, §20 | Reserve the plugin prefix `cpb-`. The browser fragment reuses the run-in-workspace step and `~/.cache/claudepilot/mcp/` layout, and reports allowlist matchers (FR19). Optional catalog preset "External agent desktop" for isnan's Coder computer: URL only, OAuth inside the workspace, once MCP Q2 passes. |
| A8 | Settings & policies §11 | New rows: Network isolation required for browsers (per target, on), Allow Chrome without its sandbox (on, labeled), Take-over in live view (on), Running browsers per target (Docker 4, Kubernetes 2), default idle stop. Settings owns the values of workspace network isolation (the Kubernetes egress policy, Docker per-workspace networks); the foundation applies them. The MCP allowlist includes `cpb-browser` matchers (FR8). |
| A9 | Monitoring FR18, FR28 | `managed_by: browser` for `plugin:cpb-browser:*`; the browser container's resources, restarts and OOM kills apart from the workspace; attention items for waiting handoffs and browser errors; exposed listeners, take-overs and non-isolated browsers in the Security feed. |
| A10 | Chat sessions FR29, FR44, §12 | Handoff card in the approvals dock; a Live view link on browser tool rows; "Needs you · browser" in the list; FR44 also refuses `~/.claudepilot/browser/**`; offer Reload after a browser assignment. |
| A11 | Portal MCP §6, Web app & PWA | Browser pools can be created and assigned over MCP; live view, take-over, handoff answers and Reset are UI-only. The web app adds the immersive route `/admin/workspaces/:target/:name/browser` and a push notification "The agent needs you in the browser" once served over HTTPS. |
| A12 | Persona, Skillset | Browser guidance ships as a skill inside `cpb-browser`, never as a `claudeMd` section. Subagent tool lists use the `mcp__plugin_cpb-browser_*` names. |
| A13 | README | Browser & desktop pool: Draft v0.1. |

## 21. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | 🔬 Run the native sidecar on k3s: order after `seed-home`, `exec` probes, memory-backed `/dev/shm` against the limit, restart time, status and usage split. Only a server dry run passed ✅. | Kubernetes spike |
| Q2 | 🔬 Chrome's sandbox per target: Playwright's seccomp profile through Docker on DinD and Docker Desktop; a `Localhost` profile on the k3s nodes (LXC, `KubeletInUserNamespace`) and Pod Security admission. | Sandbox spike, operator |
| Q3 | 🔬 With the `DownloadDirectory` policy set, do downloads that Playwright MCP triggers over CDP land in `~/Downloads`? A click saved nothing ✅; CDP `setDownloadBehavior` worked ✅. | Lab test |
| Q4 | 🔬 Live-view bridge: x11vnc on a unix socket; throughput and input latency over `docker exec` (DinD, Docker Desktop) and over Kubernetes `exec` against `pods/portforward` through the remote API server. | Spike |
| Q5 | 🔬 From a plugin `.mcp.json`: the stdio gate with Playwright MCP, and the loopback HTTP desktop server, in `-p` and interactive sessions. Does `/reload-plugins` restart stdio servers? Plugin delivery was verified only with dummy servers ✅. | Lab test |
| Q6 | 🔬 The gate: are notifications, progress and cancellation passed through intact; how does Claude Code show a refused call to the agent; does a 10-minute `browser_handoff` call hold in terminals and chat sessions? | Lab test |
| Q7 | 🔬 After Chrome restarts (idle wake, new revision), does Playwright MCP reconnect at the next call? How long does a wake take? With shared logins, do separate tabs keep sessions from clobbering each other? | Lab test |
| Q8 | 🔬 After a Docker daemon restart, are companion containers on `container:` networking restarted in a working order? What do users see while the portal is down? | Lab test |
| Q9 | 🔬 Does `Xvfb -nolisten tcp -nolisten local` remove the abstract socket that let a second container drive the display ✅? | Lab test |
| Q10 | 🔬 Google Chrome for linux/arm64; Google sign-in in Debian Chromium; Chromium `--headless` memory against headless-shell. | Spike |
| Q11 | 🔬 Does Chromium reload managed policy files when they change, or only at start? The design restarts Chrome when the policy hash changes. | Lab test |
| Q12 | Will the operator turn on NetworkPolicy enforcement on k3s (remove `--disable-network-policy`, or a policy CNI)? Until then, browsers on Kubernetes need the explicit opt-out. | Operator |
| Q13 | Defaults: Browser tier; Persistent profile with shared logins; profile wiped on unassign unless kept. | Product |
| Q14 | Desktop tier contents (openbox, panel, terminal, file manager proposed; office apps?) and base: Debian packages (tested ✅) or portabledesktop (v0.0.x). | Product |
| Q15 | With one shared admin code, anyone signed in can watch and take control. Is an audit row per take-over enough, or should devices get names (Monitoring Q12)? | Product |
| Q16 | Session recording or thumbnails: none in v1. Wanted later, and kept how long? | Product |
| Q17 | File transfer in the live view (upload into `~/Downloads`), beyond Chat's Files panel? | Product |
| Q18 | Fix the isnan desktop's open VNC now (`portabledesktop up --xvnc-arg=-localhost`), separately from this PRD. | Operator |
| Q19 | Should a later version let Secrets & env fill website logins for the agent? Proposed: no; people sign in through the live view. | Product |
