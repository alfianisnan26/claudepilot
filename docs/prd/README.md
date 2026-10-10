# Product requirements

Planned features for claudepilot, one PRD each. Every PRD is reviewed and approved before
implementation starts.

| PRD | What it covers | Status |
| --- | --- | --- |
| [Pools foundation](foundation-pools.md) | What every pool shares: storage, encryption, assigning to workspaces, delivering files into Claude Code on all three targets, merging what several pools write. | Draft v0.6 · **F1 built** (storage, encryption, backups, Locked/Frozen) · **F2 built for Docker** (compiler, atomic delivery, reconcile, drift, fail-safe, adopt) · **F4 built for Docker** (outbox pull, event dedup) |
| [Account Pool](account-pool.md) | Anthropic API keys and custom Anthropic-compatible hosts, quota monitoring, failover between accounts. | Draft v0.8 · **M2 + M3 built on Docker** (keys, hosts, pools, assignment with consent, delivery, rotation, safe unassign) · **M4 built on Docker** (helper-run and StopFailure signals, confirmatory probes, classification, failover; Kubernetes and chat-aware timing not yet) |
| [Skillset pool](skillset-pool.md) | Curated Claude Code skills assigned to workspaces. | Draft v0.5 (reviewed) |
| [Persona pool](persona-pool.md) | Reusable personas and system instructions: CLAUDE.md content, output styles, subagents, defaults. | Draft v0.5 (reviewed) |
| [Browser & desktop pool](browser-desktop-pool.md) | Tools for the agent: an isolated browser and a Linux desktop per workspace that the agent drives over MCP, with a live view and take-over in the portal. | Draft v0.2 (reviewed) |
| [MCP set pool](mcpset-pool.md) | Sets of MCP servers assigned to workspaces, with their secrets. | Draft v0.5 (reviewed) |
| [Secrets & env pool](secrets-env-pool.md) | Environment variables and secret files (GitHub, registries, cloud, SSH) assigned to workspaces. | Draft v0.5 (reviewed) |
| [Portal MCP server](portal-mcp.md) | The portal's own MCP server, so people can manage everything from claude.ai, the Claude apps or Claude Code. | Draft v0.5 (reviewed) |
| [Chat sessions](chat-sessions.md) | Chatting with the Claude Code agents in workspaces: steering, model and effort, sub-agent monitoring, images and files; mobile and desktop. | Draft v0.6 (reviewed) · **C1–C3 built on Docker** (session host, controller, event store, transcript, send, Stop, approvals, resume across portal restarts; model, effort, ultracode and mode; steer and queue; agents panel; image attachments) |
| [Settings & policies](settings-policies.md) | Permission controls (including bypass-permissions policy) and limits such as rotating at a quota threshold, budgets and concurrency caps. | Draft v0.5 (reviewed) |
| [Monitoring dashboard](monitoring-dashboard.md) | Running agents and workspaces, tokens, processes, MCP use and security events, at a glance. | Draft v0.5 (reviewed) |
| [Web app & PWA](web-app-pwa.md) | The portal as one web frontend: app shell and navigation, phone and desktop layouts, installable PWA, push notifications (for example "agent needs your approval"), HTTPS, performance and accessibility budgets. | Draft v0.5 (reviewed) |

Build order and dependencies are added once the research is in.

## Ground rules shared by every PRD

- **Native delivery.** Configuration reaches Claude Code through files it reads itself. The portal
  is never a proxy in the request path.
- **Push, don't pull.** The portal writes into workspaces through the runtime APIs it already holds
  (Docker, Kubernetes). Workspaces never need to call back to the portal.
- **Secrets stay secret.** They're encrypted at rest and never returned to the browser in full.
- **No Claude.ai subscription credentials.** The portal never collects, stores, injects or rotates
  them. A user signs in with their own subscription inside their own workspace, and the portal
  leaves that alone.
- **One web app, phone and desktop.** The portal is a single web frontend, installable as a PWA. Every
  screen uses the existing components and is designed for both phone and desktop widths: concise,
  consistent and fast.
