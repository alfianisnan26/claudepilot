# Multi-agent plan (coordinator: the main Claude Code session)

COORD = /tmp/claude-1000/-workspaces-claudepilot/cad07383-74ea-4f0a-88e5-fc51c5b7a125/scratchpad/coord
The coordinator may edit this file. Re-read it before each new work item.

## 1. Situation (2026-10-11, ~23:45 UTC)

Repo: /workspaces/claudepilot, "pilot": an admin portal for Claude Code workspaces.
- apps/server: Node 22, Hono, node:sqlite. apps/web: React + Vite + Tailwind. packages/contracts: shared types.
- UI kit `@isnanme/ui` lives in node_modules and is read-only. Icons: lucide-react.
- PRDs are the spec: docs/prd/ (README.md is the index). Each has a status line and a milestones table; keep them honest.

Git: branch `workspace-claudes`. A merge from local `main` (pools foundation, Secrets & env, Skillset, MCP sets) is staged but NOT
committed, plus uncommitted work from earlier agents and the coordinator. `git diff` therefore shows other people's work too.
Schema is at migration 15.

Built and checked so far:
- Workspaces on the Docker target; several Claudes per workspace with terminals and sign-in; chat sessions (create, send, approvals,
  files, diff, usage, archive) and, new this session: rename, delete (purges the session's files in the workspace) and transfer
  between Claudes with a framed opening shown as a "Context from <Claude>" card (apps/server/src/chat/transfer.ts,
  apps/web/src/features/chat/{Transcript,SessionDialogs}.tsx). The card has not yet been looked at in a browser.
- Usage page; Pools hub with Accounts, Secrets & env (S1) and MCP sets (M1). The last two were checked against real Claude Code 2.1.296.
- Skillset pool: server side only (apps/server/src/skills, registered, routes mounted); no web tab.
- PRD only, nothing built: Personas, Portal MCP, Browser & desktop. Tickets: nothing, not even a PRD.
- Baseline: `npm run typecheck` clean; server tests green (about 425, a few Docker-only ones skipped); web build passes.

NOT YOURS, never touch or "fix": root `Dockerfile`, `.dockerignore`, `deploy/`, the README "Deploy" section, config.ts `trustProxy`,
app.ts `clientKey`. That is someone's separate deployment effort in the same checkout.

## 2. Roster, areas, ports

| Id | Role | Edit rights (new files here are yours) | Portal port | CDP port | Name prefix | Migrations |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | QA: functions, non-functions, UI/UX | docs/qa/**, apps/server/src/qa/**, tools/qa/** (new). Fixes only in code nobody else owns: apps/web/src/{app,components,lib}/**, apps/web/src/features/{auth,admin,accounts}/**, apps/server/src/{accounts,store}/** and core files | 3101 | 9231 | qa- | none (ask) |
| A2 | Workspaces, sessions, usage; multi-session management; git worktrees; multi-agent integration; transfer flow when switching Claudes | apps/server/src/{workspaces,chat}/**, apps/web/src/features/{workspaces,chat,usage}/**, contracts workspace.ts + chat.ts, images/workspace/cp-session (generated from chat/host.ts) | 3102 | 9232 | ws- | 16-19 |
| A2b | Chat content: artifacts, media and files, uploaded and downloaded in the chat itself | apps/server/src/chat/{blobs,files,fileRoutes}.ts and new apps/server/src/chat/artifacts/**, apps/web/src/features/chat/{Composer,ImageViewer,FilesPanel}.tsx and new apps/web/src/features/chat/artifacts/**, the attachments/downloads parts of docs/prd/chat-sessions.md (FR30-FR33, FR47) | 3107 | 9237 | ct- | 60-69 |
| A5 | Local git and CI/CD: a workspace-local git remote, a self-hosted runner inside the workspace, pipeline status attached to tickets and sessions | apps/server/src/ci/** (new), apps/web/src/features/ci/** (new), contracts ci.ts (new), a NEW docs/prd/local-git-ci.md, a generated images/workspace/cp-ci | 3109 | 9239 | ci- | 80-89 |
| A6 | Claude account (SSO) usage monitoring: plan limits per Claude, per-model limits, reset times | apps/server/src/claudeusage/** (new), apps/web/src/features/usage/claude/** (new; one tab line in A2's UsagePage.tsx), contracts claudeusage.ts (new), a NEW docs/prd/claude-usage.md | 3110 | 9240 | cu- | 90-99 |
| A7 | Chat motion and polish: smooth text reveal, smooth scroll-follow, polished transitions | new apps/web/src/features/chat/motion/**; surgical integration edits in features/chat/{Transcript,Markdown,Activity,ToolRows}.tsx (A2's files) | 3111 | 9241 | mo- | none |
| A3a | Pools: MCP sets and Secrets & env enhancements; the Skillset pool; the MCP lockdown settings and the shared settings store | apps/server/src/{pools,secrets,mcp,skills,delivery,settings}/**, apps/web/src/features/{pools,secrets,mcp,skills,settings}/**, contracts {pools,secrets,mcp,skills,settings}.ts, images/workspace/Dockerfile, docs/prd/{foundation-pools,secrets-env-pool,mcpset-pool,skillset-pool,settings-policies}.md | 3103 | 9233 | pl- | 20-29 |
| A3c | Personas and instruction contexts | apps/server/src/personas/**, apps/web/src/features/personas/**, contracts personas.ts, docs/prd/persona-pool.md | 3108 | 9238 | pe- | 70-79 |
| A3b | Platform: Portal MCP (internal and external), global "add MCP" flow, ticketing system | apps/server/src/{portalmcp,tickets}/** (new), apps/web/src/features/{tickets,portalmcp}/** (new), contracts {tickets,portalmcp}.ts (new), docs/prd/portal-mcp.md, new docs/prd/tickets.md | 3105 | 9235 | pm- | 40-49 (full; overflow 785+: 785-787, 794-796 used) |
| A4 (a) | Browser & desktop (VNC) and the proxy browser, agent-driven over MCP | apps/server/src/browser/** (new), apps/web/src/features/browser/** (new), contracts browser.ts (new), images/browser/** (new), docs/prd/browser-desktop-pool.md | 3104 | 9234 | br- | 30-39 |
| A4b | Knowledge: docs graph, context graph, agentic graph, second-brain vaults with an Obsidian approach | apps/server/src/knowledge/** (new), apps/web/src/features/knowledge/** (new), contracts knowledge.ts (new), a NEW docs/prd/knowledge-graph.md | 3106 | 9236 | kg- | 50-59 |

(A2 and A2b share the chat code: A2 keeps controller.ts, store.ts, host.ts, Controls, the session pages and lists, Transcript.tsx and ToolRows.tsx; A2b owns the files listed in its row and
touches controller.ts, host.ts, store.ts, Transcript.tsx, ToolRows.tsx and contracts chat.ts only surgically, through the seams in I9.)
(A3a/A3b/A3c and A4a/A4b are the halves of the "agent 3" and "agent 4" workstreams: each scope was too wide for one agent. The agent files are
status-a4.md etc. for A4a and status-a4b.md etc. for A4b.)

Registration files: a pool-kind owner (A3c, A4, A4b) may add ITS OWN entry surgically to apps/server/src/pools/kinds.ts, packages/contracts/src/pools.ts (the MultiPoolType union and MULTI_POOL_TYPES: your own token only)
and apps/server/src/delivery/ownership.ts (your own owner entry only), re-reading right before the edit, and tells A3a in its status file. Anything beyond your own token or entry is a request to A3a.
Shared files: edit surgically, re-read the file right before every edit, never reformat or rewrite them:
apps/server/src/{index.ts,app.ts,config.ts (new keys only),live.ts}, apps/server/src/store/migrations.ts (append in your block only),
packages/contracts/src/index.ts (export lines), apps/web/src/app/{App.tsx,nav.ts}, apps/web/src/features/pools/{registry.tsx,types.ts,PoolList.tsx},
apps/server/package.json, package-lock.json, docs/prd/README.md.

Need a change in someone else's area? Do not make it. Append a request to COORD/outbox-<id>.md (section 6); the coordinator routes it.

## 3. Interfaces agreed between agents (change only through the coordinator)

I1 Tickets, sessions and worktrees (A3b with A2).
- A2 delivers early (within its first work items; announce it in status-a2.md): `ChatSession.ticketId: string | null`;
  `CreateChatSessionRequest.ticketId?: string`; `CreateChatSessionRequest.worktree?: { repo?: string; branch?: string; base?: string }`
  (the session gets its own git worktree and its cwd is that worktree); `ChatSession.worktree: { path: string; branch: string; repo: string } | null`;
  `ChatSession.parentId` for sessions started by another session; ChatController methods other server modules call: `create(req)`,
  `send(id, uuid, text, { actor })`, `list()`, `get(id)`, `end(id)`, and a way to subscribe to session changes (`onEvent`).
  Portal-originated messages carry an `actor` string (`ticket:<id>`, `session:<id>`, `portal-mcp:<token id>`), recorded on the input row
  and shown in the transcript as coming from that actor, never as something the person typed.
- OWNER'S CORRECTION (2026-10-12): moving a chat to another Claude NEVER creates a second session row. The portal session id is stable for the life of the chat (URLs, API, MCP tools, tickets, graph, worktree,
  agent token all keep using it). Only the Claude Code session underneath changes: `chat_sessions.id` is the portal id, a new `claude_session_id` is the current Claude Code session, and a `chat_segments` table
  records the runs (Claude, Claude Code session id, started, ended, reason, cost, turns). `predecessor_id`/`successor_id` are legacy and must not be relied on. See inbox-a2.md for the full spec.
- A3b owns tickets (tables, service, REST, MCP tools, UI). A ticket points at a session with `assigneeSessionId` (agent) or `assigneeUser` (human).
  A3b codes against the interface above through one thin adapter, apps/server/src/tickets/sessions.ts, with a fake for tests until A2's pieces land.

I10 CI with tickets, sessions and worktrees (A5 with A3b and A2). A5 owns the workspace-local git remotes, the triggers (push, merge into a protected branch, manual, MCP), the runner and the runs, jobs, steps, logs and artifacts.
- Tickets (A3b): A5 reaches the ticket service through ONE adapter, apps/server/src/ci/tickets.ts, typed against A3b's service, with a fake for tests until it exists: attach a check to a ticket (name, state, run id, commit, link) and add timeline entries.
  A ticket is found from the branch name (`ticket/<id>-...`), a commit trailer (`Ticket: <id>`), or the session link (A2's `ChatSession.ticketId` and its worktree branch).
- Sessions (A2): a run is associated with the session whose worktree or branch it came from. A result may be sent to that session as a portal-originated message with actor `ci:<run id>`, inside A2's caps plus a per-ticket cap, so
  CI -> agent -> push -> CI can never loop.
- Portal MCP (A3b's registry, I2): runs list/get/logs, trigger and cancel; scope `agent` only for the caller's own branch; logs pass the sanitizer and the redactor.

I12 Claude account usage (A6 with A2, A3b). A6 owns the probe, the store and the Usage-page tab. Sources: PASSIVE (rate-limit information in the stream of live sessions: A2's reader hands each Claude Code rate-limit event to A6 through one hook, `onRateLimit(sessionId, claudeId, info)`),
and ACTIVE (a short-lived Claude Code probe in the workspace as that Claude, asking for its usage with no model call). The portal NEVER reads, copies or stores a Claude's login or token: only Claude Code's own replies (percentages, windows, reset times, plan type). A2 uses `headroom(claudeId)` in the switch dialog and the Claude rows; A3b exposes a read tool (scope `read`).

I2 Portal MCP tool registry (A3b provides it in its first milestone): `registerPortalTool({ name, title, description, scope: 'read' | 'operate' | 'admin' | 'agent',
input, handler(ctx, args) })` (`ctx` carries `actor`, `scope`, and for agent tokens the verified `workspaceId` and `sessionId`, plus a sanitizer helper for untrusted text and an optional per-token vault allow-list) in apps/server/src/portalmcp/registry.ts. Any area adds tools from its own `portalTools.ts`, registered in index.ts.
Tools never return secret values (portal-mcp.md section 14).

I3 Global "add MCP" flow (A3b with A3a). An agent or a token can only PROPOSE an MCP server: a catalog entry in draft or waiting review.
A human reviews it in the portal (mcpset-pool.md review gate) before it can be delivered anywhere. A3a exposes `proposeEntry(...)` (or equivalent) from
apps/server/src/mcp within its first work items; A3b's tool calls it. Nothing bypasses review.

I4 Browser delivery (A4 with A3a). A4 delivers its MCP servers through the existing plugin marketplace and delivery APIs (apps/server/src/delivery, mcp).
If A4 needs an extension point there, it asks A3a through the outbox.

I5 Personas and instruction contexts (A3a) can later be attached to sessions and tickets. A3a exposes a small read API; nobody else edits persona code.

I6 Knowledge tools and graph sources (A4b with A3b, A2, A3a).
- A4b registers its MCP tools (notes search/read/write, backlinks, graph queries) through A3b's registry (I2). Until the registry lands it codes against the
  signature above with a local shim.
- A4b may READ other areas' tables for the graph (sessions, tickets, workspaces) through thin read-only adapters in apps/server/src/knowledge/, tolerant of a
  missing table; if you rename or drop columns it reads, tell the coordinator. The adapters never write there.
- If A4b wants vaults delivered into workspaces, it registers its own pool kind through A3a's pool framework (new files in apps/server/src/knowledge/, a line in
  index.ts); changes inside pools/** or delivery/** are requests to A3a through the outbox.
- Knowledge links from tickets (A3b) and sessions (A2) are agreed through the coordinator, not by editing each other's code.

I8 Per-session agent tokens: the coordinator's ruling for the owner's "internal MCP access" (the owner's request overrides portal-mcp.md section 10.1, "never in workspaces", for THIS token
class only; section 10.1 and section 12 get amended by A3b).
- The admin token classes (`cpat_`, `cpoa_`, `cpor_`) stay never-delivered into any workspace: the compiler guard stays as it is.
- New class `cpst_`: minted by the portal for ONE chat session at its launch (A2 calls A3b's mint function with { workspaceId, sessionId }), passed ONLY in the environment of that session's Claude Code
  process (`PILOT_MCP_TOKEN`, with `PILOT_SESSION_ID`, `PILOT_WORKSPACE_ID`, `PILOT_MCP_URL`) and referenced from the MCP config the portal passes at launch (`--mcp-config`, header
  `Authorization: Bearer ${PILOT_MCP_TOKEN}`). Never written to a file by the portal, hashed at rest, never in transcripts or logs (a redactor pattern in chat/redact.ts).
- Bound to (workspace, session). Its life is the session's: revoked on end, archive and delete. At a Claude switch (the same session continues on another Claude Code process) the old token is revoked and a new one is minted for the new process. Scope `agent`: only tools that opt in with `scope: 'agent'` (tickets: own, claim, create,
  comment; knowledge notes inside the vault policy; `mcp_catalog_propose`, draft only; session messaging inside A2's caps). Never admin or operate tools.
- Opt-in per workspace ("Agent access to portal tools", default off), audited, rate-limited per token. The verified (workspace, session) identity comes from the token, never from tool arguments or headers.
- A3b owns minting, verification, revocation, the container-reachable URL and the PRD amendments. A2 owns launch wiring, env, revocation on lifecycle events and the redactor pattern. Tools (A3b's, A4b's, others')
  read `ctx.sessionId`, `ctx.workspaceId` and `ctx.actor` from the registry context.
- Sessions the portal starts through MCP, tickets, personas' tests or multi-agent spawn get an agent token like any other session of an opted-in workspace, but are never bypass-capable (A2, Bypass).

I9 Chat content (A2b) with chat core (A2). Seams, all surgical: (1) `controller.send` hands attachments of any type to A2b's code in chat/artifacts/ (decode, validate, stage, record) through one call;
(2) when a tool result arrives, the controller calls an A2b hook so produced files and images become artifact records; (3) the transcript renders artifact and attachment cards through components A2b adds, selected
by one `case` in Transcript.tsx; (4) the value redactor (QA-006: a secret the agent was allowed to print must not reach storage) is A2's, in chat/redact.ts and the controller's event path; A2b calls the same
API for text previews and text artifacts; (5) new host commands for staging and copy-out go into CP_SESSION (chat/host.ts) as separate `case` branches, then `npm run gen:workspace-host -w @portal/server`.
Production Content-Security-Policy (A1, apps/server/src/csp.ts) only applies to the BUILT app, so check any iframe, blob: media or sandboxed preview in a production build (`npm run build -w @portal/web`, then your
portal with NODE_ENV=production) and extend csp.ts surgically.

I11 Agent self-adjustment. The owner's words (2026-10-12): "for personas, skills, on platform level, the claude inside (via session), can also adjust itselfs, including names, even if model support image generations should also put their avatar there."
- Through the Portal MCP with the per-session agent token (I8, scope `agent`) an agent can read and PROPOSE changes to ITS OWN persona (name, avatar, instructions) and skills (a new or changed skill), and rename its own session. "Own" = the persona
  assigned to the calling session's workspace, and the calling session; never another persona, workspace or session.
- A proposal is a draft with provenance (actor `session:<id>`, a reason, the diff). It is never live by itself: a human approves it in the portal (a review queue). Low-risk fields (name, avatar) MAY be auto-approved by an explicit per-persona
  switch; instructions and skills NEVER are (a prompt-injected agent must not be able to persist instructions or code). The switch that lets agents propose at all is OFF by default (settings store, A3a), audited, rate- and size-limited, secret-scanned.
- Avatar: any image the session has (an image-generation tool's output, an artifact, an upload) can be offered as a proposal; the portal validates and RE-ENCODES it (PNG, JPEG or WebP only; no SVG, no animation; metadata stripped; square-cropped; at most
  512 px; content-addressed in the blob store). No avatar is a valid state (generated initials). Image generation itself is whatever tool the session already has: the portal does not generate images.
- Display: the persona's name and avatar show in chat (session header and rows, transcript attribution), the Claude lists and ticket assignee chips, through ONE shared component from A3c (`PersonaAvatar`). Text-diet rule applies.
- Owners: A3c the data model, proposals, review UI, avatar pipeline and the persona tools; A3a skill proposals and the settings switch; A3b the registry, token scope, audit and rate limits; A2 the chat display and `session_rename_self`; A1 the security review.
- What an agent LEARNS (notes, how-tos) belongs in the knowledge vault (A4b), not in persona instructions.

## 4. Non-negotiables

1. Git is READ-ONLY for you: status, diff, log, show. Never add, commit, stash, reset, checkout, restore, clean, rebase, merge, cherry-pick, push, and never
   run `git worktree add` on this checkout (A2's git-worktree FEATURE runs inside workspace containers or scratch repos under /tmp, never here).
2. The user's data is off limits: /workspaces/claudepilot/.data (their dev database), /workspaces/claudepilot/.env, deploy/.env, ~/.gnupg, ~/.claude*
   credentials. Never read, print, copy or modify them. Their own dev portal on port 3000 is stopped on purpose: do not start one. Use yours (section 5).
3. No real credentials: no signing in, no real API keys, no real third-party accounts. Test Claude Code against the scripted stand-in Anthropic API
   (see apps/server/src/secrets/claude.integration.test.ts and its helpers) or with fakes.
4. Own your area. Surgical edits in shared files. Re-read before editing. Never reformat.
5. Migrations: append only, in your block, never edit migrations 1-15 or another block. They run once per database: while iterating, use a scratch data
   dir and delete it to re-run. Anything that adds a column holding sealed values must be listed in ENCRYPTED_COLUMNS.
   The tickets block (A3b, 40-49) is full since T-1974 took 49 (2026-10-21); tickets migrations overflow to 785+ (785-787, 794, 795 and 796 used; 788 is
   T-975's on its branch): take the next free number there after checking integration and the open branches.
   The UI reporter (docs/prd/ui-reporter-server.md) has its own block, 900-909 (900-902 used, 2026-10-31: 902 is reporter_ip).
6. Dependencies: run `npm install` only under `flock COORD/npm.lock npm install ...`, then re-run the typecheck. Prefer no new dependencies; say in your
   report which you added and why. Never edit `@isnanme/*` packages in node_modules.
7. Docker is ONE shared daemon. Give everything your prefix. A portal lists every `claudepilot-*` managed container, so other agents' workspaces show up in
   yours: never touch what isn't yours. Never `docker system prune`, never remove containers or images by wildcard. Build images under your own tag.
   Clean up your containers, volumes, images, tmux sessions and /tmp files at the end.
8. There is nobody to ask. Decide, write the decision down (status file and report), and carry on. Genuine blockers go to the outbox.
9. Be honest: say exactly what you verified and how; never claim a pass you did not observe; list what you could not check.
10. Security posture of this portal (keep it): every route behind the session guard (except login and health); Origin check on mutating requests and on
    sockets; secrets never in logs, responses or transcripts; redaction (apps/server/src/chat/redact.ts) on anything stored that came from a workspace;
    workspace text is untrusted input.
11. Match the surrounding code: comment density, naming, PRD section references in comments. Tests for server behaviour.
12. UI TEXT DIET (the owner's directive, 2026-10-12, verbatim: "The new UIs, UX was too much text, i dont like this design approach, please make sure we got less text, less unnecessary components (of design), focus of
    functionalities, too much text can be collapsed into tooltip instead."). It applies to everything you build or touch, and it overrides the long copy tables in the PRDs: shorten that copy, and update the PRD's copy rows when you do.
    - Words: titles and labels of one or two words. No paragraph under a page title, a section heading, a dialog title or a field unless a decision depends on it. An empty state is one short line plus its action.
    - Long explanations, hints, limits and "what this does" go into the shared `InfoTip` (apps/web/src/components/InfoTip.tsx: an ⓘ that opens on tap; native `title` never shows on touch screens) or, where a hover note is
      enough, a native `title`. A warning that guards an irreversible or security-relevant act stays visible, as ONE terse line.
    - Components: no card inside a card, no badge that repeats what the row already says, no section header over a single item, no divider or frame that adds nothing, no decorative icon beside every label. Prefer an icon
      button with an accessible name and a tooltip to a labelled button when the meaning is obvious. Secondary detail behind a chevron or a sheet (progressive disclosure).
    - Focus on the function: the primary action and the data first, the rest on demand. Dialogs: title, fields, buttons.
    - Phone first: fewer words, fewer wraps; look at 390 px. Accessibility stays: tooltip text reachable by keyboard and touch, icon-only controls keep an accessible name.
    - A1 audits the existing UI against this rule and fixes or reports it; owners slim their own areas as they touch them.

## 5. Recipes

Your own portal. It runs WITHOUT file watching, so other agents' edits don't restart it; restart it yourself after changing server code. Web code is served
live (Vite middleware).

    tmux new-session -d -s <prefix>portal "cd /workspaces/claudepilot/apps/server && mkdir -p /tmp/<prefix>home && env -i PATH=$PATH HOME=/tmp/<prefix>home LANG=C.UTF-8 PORTAL_K8S_ENABLED=false PORTAL_PORT=<port> PORTAL_DATA_DIR=/tmp/<prefix>data PORTAL_SERVER_CODE=<8 digits> PORTAL_SECRET_KEY=$(node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\") NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx --env-file-if-exists=../../.env src/index.ts 2>&1 | tee /tmp/<prefix>portal.log"

CLEAN ENVIRONMENT (2026-10-12, after an incident): every agent's shell INHERITS the owner's Claude profile and sockets (CLAUDE_CONFIG_DIR, CLAUDE_CODE_MESSAGING_TOKEN and _SOCKET, CLAUDECODE, SSH_AUTH_SOCK, KUBECONFIG ...). A scratch portal that runs `claude` on the host (the local target, or the usage probe) would use YOUR profile and rewrite its files, so scratch portals are started with `env -i` and a private HOME exactly as in the recipe above, and the local target (PORTAL_LOCAL_ENABLED) is enabled only with a private HOME and CLAUDE_CONFIG_DIR under /tmp/<prefix>home. Never use SSH_AUTH_SOCK, ~/.ssh*, ~/.ssh-host or ~/.host-secrets; throwaway keys only.

KUBERNETES SAFETY (2026-10-12): this sandbox's environment has KUBECONFIG set to the owner's REAL cluster (`home-isnan-cluster`) and the server enables its Kubernetes target whenever KUBECONFIG is set, so a scratch portal started without the `unset` and `PORTAL_K8S_ENABLED=false` above would point at the real cluster. Never run kubectl or helm without `--kubeconfig <your own throwaway file>`; never create a Kubernetes workspace from a scratch portal.

The repo's `.env` is the user's: your explicit variables win over it (checked); never print it. Stop yours with `tmux kill-session -t <prefix>portal`.
Never `pkill -f <pattern>` with a pattern that appears in your own command line (it kills your own shell); kill by tmux session or PID.

Sign in: `curl -s -c JAR -H 'Origin: http://localhost:<port>' -H 'Content-Type: application/json' -d '{"code":"<code>"}' localhost:<port>/api/login`
(cookie `portal_session`; mutating requests need the Origin header).

Workspaces for tests: through the UI, or `POST /api/workspaces {"name":"<prefix>x","target":"docker","cpus":2,"memoryMb":2048}`. The image
`claudepilot-workspace:latest` exists. If you change images/workspace, build under your own tag and start your portal with
`PORTAL_WORKSPACE_IMAGE=claudepilot-workspace:<prefix>`.

UI checks: COORD/drive.mjs drives headless Chromium over CDP. Copy it to /tmp, don't edit it in place:
`STEPS='[["js expression", waitMs, "shot"]]' CDP_PORT=<cdp> node drive.mjs <cookie value> <outPrefix> <url> <width>`, then Read the PNGs.
Look at 390 px (phone) and 1280 px, light and dark, whenever you change layout. Do not report UI work done until you have looked at it.

Tests (from apps/server): `node --import tsx --disable-warning=ExperimentalWarning --test '<glob>'`. Docker-only tests need `CLAUDEPILOT_DOCKER_TESTS=1`.
Typecheck from the repo root: `npm run typecheck`. Errors in files you don't own are probably another agent mid-edit: wait a minute and retry,
never fix them. Web build: `npm run build -w @portal/web`. Run the full server suite once before your final report.

Scratch files go in /tmp/<prefix>* or the scratchpad, never in the repo.

MEMORY IS TIGHT (12 GB machine, about 3.5 GB free with six agents running): stop your portal (`tmux kill-session`) and any Chromium when you are not actively testing and start them again when you need
them; at most ONE workspace container and ONE Chromium of yours at a time; build images only when you must; never leave watchers, `tail -f` loops or idle dev servers running. If you see "Killed", an OOM, or the machine
crawling, say so in your status file and the outbox. Never delete temp files by wildcard that other agents also use (for example /tmp/drive-profile-*): delete only what you made.

## 6. Coordination protocol

- COORD/status-<id>.md: you keep it current (overwrite it, at most 40 lines): focus now, done, next, blockers, decisions. Update at every milestone and at
  least every ~30 minutes of work.
- COORD/outbox-<id>.md: append requests for other agents or the coordinator, one per line: `[to A2] need X because Y`.
- COORD/inbox-<id>.md: the coordinator's messages to you. Read it before starting each new work item and before your final report.
- A1 also appends findings to docs/qa/qa-report.md as it goes, each tagged with severity and owner: [A2] [A3a] [A3b] [A4] [core].
  The coordinator reads that file and the status files and routes findings.

## 7. Priorities and definition of done

Work in priority order. Prefer a verified smaller increment over a sprawling unfinished one. Each item = implementation + tests + real verification
(API and/or UI in a browser; real Docker and real Claude Code where the PRD says so) + the PRD status note updated in the house style (see the
milestones tables in docs/prd/workspace-claudes.md, secrets-env-pool.md, mcpset-pool.md: **Built** / **Partly built** / **Not built**, with what was
observed).

Final report (your last message): what you built or fixed (files), what you verified and how (actual output), what is not done and why, requests for
other areas, PRD updates, decisions you made, test/typecheck/build results, and the cleanup you did. Keep it concise.
