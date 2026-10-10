# PRD: Chat sessions

| | |
| --- | --- |
| Status | **Draft v0.6**, revised after the technical and UX reviews; v0.6 is a consistency pass (Web app A5, Browser & desktop A10, the credential guard against the no-login-reading rule). ✅ = observed in one sandbox run of Claude Code 2.1.296 (stream-json, DinD, mock Messages API, feature flags off), and only for the mechanism named: a raw `docker exec` pipe (S1–S7, S9, X1–X5) or the detached FIFO host (S8). Nothing ran through the Agent SDK, a real portal, Docker Desktop or Kubernetes. 🔬 = unverified, listed in §19. FR, Q and A IDs are frozen from v0.5; new ones are appended. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-10 |
| Depends on | [Pools foundation](foundation-pools.md) (storage, bundle scripts, version gate, drift checks, event log), [Account Pool](account-pool.md) (the only credentials sessions run on in v1), [Web app & PWA](web-app-pwa.md) W1 (shell, component kit) and the app's one live socket (its A5) |
| Related | [Settings & policies](settings-policies.md) (modes, models, effort, ultracode, budgets, caps, locks), [Monitoring dashboard](monitoring-dashboard.md) (states, usage), [Persona pool](persona-pool.md) (chat prompt, test prompts), [Skillset](skillset-pool.md) and [MCP set](mcpset-pool.md) pools (reload, MCP status), [Secrets & env pool](secrets-env-pool.md) (redactor), [Browser & desktop pool](browser-desktop-pool.md) (handoffs), [Portal MCP server](portal-mcp.md) (session tools) |

## 1. Summary

Sessions lets people work with the agents in their workspaces from a phone or a desktop. Each
session runs Claude Code in one workspace folder. On one screen a person sends messages, steers the
agent mid-task, stops it, answers approvals and questions, switches model, effort, ultracode and
permission mode, follows subagents and workflows, and attaches or downloads images and files. One
list across all workspaces puts the sessions that need input first. The interaction patterns come
from Claude's mobile Remote Control; the look is the portal's own.

Each session is the unmodified `claude` CLI in print mode with stream-json in and out, started
detached in the workspace by a host script from the foundation bundle, and driven only by short,
portal-initiated runtime `exec` calls: start, send a line, read from a byte offset. Workspaces never
call the portal, and the portal is never in the API path. Sessions survive closed tabs and lost
readers; after a container restart, one tap or the next message resumes them. As Agent SDK use,
they run only on credentials the portal delivered (Account Pool's helper), never on a personal
Claude login, which the portal never reads, and a session whose stream shows input the portal
didn't send is ended.

## 2. Background and problem

- Today Claude Code in a workspace is reachable only through the browser terminal. On a phone a
  full-screen TUI is cramped, approvals need a keyboard, and nothing says an agent is waiting.
- Remote Control and cloud sessions need a claude.ai subscription, refuse API keys, `apiKeyHelper`
  and custom base URLs (what Account Pool delivers), and keep transcripts at Anthropic
  ([Remote Control](https://code.claude.com/docs/en/remote-control)).
- Seven features need one session engine: Settings (modes, budgets, caps), Monitoring (state,
  usage), Persona (prompts), Skillset and MCP set (reload, status), Account Pool (retries), Browser
  & desktop (handoffs), Portal MCP.
- A controller that stays attached loses the agent's work: when a raw `docker exec` client died,
  Claude Code finished the turn headless and that output reached no client ✅ (S7b). An Agent SDK
  `query()` in the portal would fail the same way (inferred) and can't reattach.

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Simple everywhere.** One screen per session (transcript, composer, pickers); New session is the same screen, with no wizard. One layout from a 320 px phone to a wide desktop. |
| G2 | **Steer, don't block.** The composer stays live while the agent works: Send steers, ✕ withdraws a queued message, Stop interrupts, and every message shows whether Claude has read it. |
| G3 | **Session controls.** Model, effort, ultracode and permission mode per session, within policy, showing the values that actually apply. |
| G4 | **Multi-agent monitoring.** Each session's subagents, workflows and background tasks, live beside the conversation, and one list of every session across workspaces, sorted by attention. |
| G5 | **Images and files both ways.** Photos, screenshots and files in; files, images and diffs out, inline and within two taps. |
| G6 | **Durable.** No lost or duplicated events across closed tabs, network drops and lost readers. Container restarts end in a resumable Interrupted state. |
| G7 | **Native, push-only, compliant, tamper-evident.** Unmodified CLI, portal-initiated `exec` only, all three targets, portal-delivered credentials only; input the portal didn't send ends the session. |
| G8 | **Fast.** First token on screen within 250 ms of Claude Code writing it (p95, Docker targets, not counting characters held back for redaction). Smooth scrolling through 5,000 blocks on the reference phone (§12.7). |

## 4. Non-goals

- **Remote Control, cloud sessions or self-hosted environments as the transport,** or launching
  `claude remote-control` for anyone. **A proxy:** the portal never sees API traffic or keys.
- **Workspaces without an account pool,** including API keys or cloud credentials a user set up
  (Q17). The terminal and Claude's own apps serve them.
- **Driving terminal sessions** (Monitoring shows them; handover is Q15) and **parsing Claude
  Code's transcripts**, whose format is internal.
- **An in-app split view** (v2; ⌘- or Ctrl-click opens a session in its own tab). **Fast mode**
  until Settings prices it. Push and HTTPS (Web app & PWA), per-user identity, shared editing, diff
  comments, rewinding files, agent teams, and any Anthropic look (§6).

## 5. Users and stories

**Workspace user** chats with agents, often from a phone. **Admin** sets policy. Often one person.

| ID | Story |
| --- | --- |
| US1 | On my phone, Sessions shows "2 need input". I tap one, read the request and allow it, or type what Claude should do instead, on one screen. |
| US2 | I type a task and send. The session starts in my last workspace and folder, with its persona defaults and policy; I can change both first. |
| US3 | While the agent works, I send a correction and see it queued, then read. I can pull it back before it's read, or stop the turn, everything, or one subagent. |
| US4 | I switch model, effort, ultracode or permission mode, see the value that applies, and see why an option is missing. |
| US5 | I watch subagents, workflows and background tasks (activity, tokens, time) without leaving the conversation, and open one to read its messages. |
| US6 | I attach a phone photo or a pasted screenshot, see the images and files the agent produced inline, and download them and the diff. |
| US7 | I close my laptop, open the session on my phone and carry on. A portal restart loses nothing. |
| US8 | In a workspace without an account pool, Sessions tells me why it can't run there and offers to assign one or open the terminal. |
| US9 | As an admin, I see each session's estimated cost against its budget, and why a new session is refused at a cap. |
| US10 | As an admin who allows Bypass permissions in one workspace, I can turn it on only in a session I allowed it for at the start, after an explicit confirmation and re-auth, and the session shows it until it's off. |
| US11 | Before the first session in a freshly cloned repository, I see which MCP servers and hooks it would run, and trust it or not. |

## 6. Scope boundary and compliance

| Allowed | Not allowed |
| --- | --- |
| Running the unmodified CLI in the organization's own workspaces on credentials the portal delivered (Account Pool's `apiKeyHelper`: Anthropic API keys or custom hosts), billed to the key owner. Nothing else in v1; cloud-provider credentials only once Account Pool delivers them (Q17). | Running a portal session on a claude.ai login (Free, Pro, Max, Team, Enterprise), `CLAUDE_CODE_OAUTH_TOKEN`, any other subscription credential, or credentials the portal can't verify. |
| Borrowing Remote Control's interaction patterns. Calling the feature "Sessions" or "Chat". Saying "runs Claude Code" in plain text. | Imitating Claude Code's or Anthropic's look, logos or names. Using Remote Control, cloud sessions or self-hosted environments as the transport. |
| Pointing users of workspaces without a pool to the terminal and Claude's own apps. | Reading or recording a workspace's own login (account, organization, plan), Claude Code's credential files, `~/.claude/sessions/*.key` files or transcripts. |

This boundary is a requirement. Stream-json runs are SDK use (the billing header says
`cc_entrypoint=sdk-cli` ✅). The
[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) bars offering "claude.ai
login or rate limits for their products, including agents built on the Claude Agent SDK" without
approval; the [legal page](https://code.claude.com/docs/en/legal-and-compliance) bars routing
"requests through Free, Pro, or Max plan credentials on behalf of their users". Branding rules bar
"Claude Code" in product names and look-alike visuals. The Commercial Terms apply (Q13).

| # | Rule |
| --- | --- |
| 1 | **Eligibility from portal state; a guard that reads no login.** A workspace hosts sessions only while it has an active, Synced Account Pool assignment (not paused, not waiting for quota). Before every launch, resume and wake, `cp-session authcheck` confirms one thing, that the pool's helper is the credential in use 🔬 (Q3), and answers `pass` or `fail`; on `fail` nothing starts. Each turn's `system/init` must carry `apiKeySource: "apiKeyHelper"` (✅ for a `--settings` helper; 🔬 Q3 for the managed one), or the session ends. Both checks only confirm the helper: they never open `~/.claude.json` or `~/.claude/.credentials.json`, never report which other credential, account or plan is present, and the portal stores only pass or fail. That keeps the rule that the portal never reads a workspace's own login ([README](README.md) ground rules, [Settings & policies](settings-policies.md) §16). Copy: "Sessions need an account pool in this workspace." Login commands are refused (FR13). |
| 2 | **No fallback to a stored login.** A per-workspace **credential-transition lock** is taken by an Account Pool unassign or move to own login (its §10.4 step 1 sends the next request with the workspace's own credential), a Settings pause (empty key file) and `portal decommission`. Taking it ends the workspace's sessions; while it's held, starts, resumes, wakes and persona runs are refused ("Pool change in progress"). Account Pool releases it after its step 2 or the pause write. When the foundation's drift check finds the account drop-in or a key file changed outside the portal in a workspace with live sessions, chat ends them at once, with a High event, before the repair. Unassign needs nothing from Q4 for chat: sessions end before step 1 removes the helper, and the workspace is ineligible after. If Q4 finds a fallback, pause keeps Settings §13.2's sentinel plan. |
| 3 | **Subscription alarm, failing closed.** After each `result` the controller sends `get_usage {skip_behaviors: true}`; API-key sessions report `rate_limits_available: false` ✅ (custom host, mock). Non-null `rate_limits`, a `rate_limit_event`, an error, or a reply without `rate_limits_available` ends the session with a High event. The field is contract-tested per CLI version; its positive signal was never observed (Q3). A task of type `remote_agent` or a Workflow with status `remote_launched` (cloud paths 🔬) ends it too. |
| 4 | **Branding.** "Sessions" in navigation and titles; "Runs Claude Code in api-dev" as plain text; no Anthropic or Claude Code logos, colors, glyphs or terminal look; mode names as plain labels. |
| 5 | **Bypass permissions** is blocked by default; FR20 is its one full description. It's never one tap, never in a session that didn't opt in at its start, and never over MCP. Claude's apps never offer it on phones ([mobile](https://code.claude.com/docs/en/mobile)). |
| 6 | **Auto on custom hosts** sends conversation excerpts to that host for classifier checks, outside the cost estimate (✅ 10 classifier requests in one run, S9). Auto stays hidden there until an admin confirms it per endpoint (Settings FR6). |
| 7 | **Built-in sign-in.** Refusing login commands, like Account Pool's hidden `/login`, restricts an authentication method built into Claude Code, which the legal page says hosted products "may not remove, disable, or restrict". That's defensible only for the operator's own organization, billed to the key owner; written sign-off comes before anyone outside it uses Sessions (Q13). |

## 7. Solution overview

```
 Browser                       Portal (one Node process)             Workspace (DinD, host Docker or k8s)
 ┌──────────────────────┐     ┌───────────────────────────────┐     ┌───────────────────────────────────┐
 │ Sessions UI          │ WS  │ Session controller            │ exec│ cp-session (foundation bundle)    │
 │ /api/live, one per   │◀───▶│  policy → flags, first lines  │────▶│  send: stage, check, copy to FIFO │
 │ tab, resumes by seq  │     │  staged sends, answers        │     │  setsid claude -p (unmodified)    │
 └──────────────────────┘     │  one reader per live session  │◀────│   stdin  ◀── sessions/<id>/in     │
 ┌──────────────────────┐     │  integrity check → redact →   │bytes│   stdout ──▶ out.<n>.jsonl        │
 │ MCP clients via      │◀───▶│  SQLite, blob store           │     │  meta.json · exit.json · lock     │
 │ Portal MCP session_* │     │  guards: credential, trust,   │     │ claude ──▶ Anthropic API or host  │
 └──────────────────────┘     │  budget, caps, Bypass         │     │                                   │
                              └───────────────────────────────┘     └───────────────────────────────────┘
```

1. **Session host** (`/etc/claudepilot/bin/cp-session`) starts `claude -p` detached under `setsid`.
   Stdin is a FIFO in `~/.claudepilot/sessions/<id>/` that Claude Code opens read-write, so writers
   come and go; stdout appends to a JSONL segment on the home volume. Each send is staged and
   checked before one local copy into the FIFO. Readers replay from a byte offset and exit when
   their own stdin closes ✅ (S8). A lock enforces one writer.
2. **Portal controller**, the only client of each process. It turns policy into flags and first
   lines, keeps one reader per live session even when nobody watches, checks every line against
   what it sent (§10.4), redacts and numbers each line into SQLite (images into the blob store),
   answers requests, and enforces guards, budgets and caps.
3. **Browser protocol.** The Web app's one live socket per tab (`/api/live`). Tabs resume from
   their last sequence number; actions carry a client UUID, so a retry never sends twice.

Rejected: the Agent SDK in the portal (would lose output when the exec stream drops, inferred from
S7b; can't reattach; ships its own CLI); a long-running workspace daemon (a v2 option); an attached
`exec` (S7b ✅); tmux (send-keys into a pty fails with `-p` ✅, and hosting the FIFO in tmux only
adds a way to kill the session).

## 8. Functional requirements

### Sessions

| ID | Requirement |
| --- | --- |
| FR1 | **New session** (`/admin/sessions/new`) is the session screen, empty, in the last-used workspace and folder, the only eligible one, or the one a workspace's **Chat** button passes. A chip above the composer ("api-dev · ~/work/api ▾") opens a two-step sheet: workspace, then folder (`~/work` and git repositories two levels below). Ineligible workspaces stay tappable, with the reason and the way out: "Stopped · Start", "No account pool · Assign", "Pool change in progress", "4 of 4 running · Settings", "Update Claude Code". Mode and Model · Effort picks become launch flags. The first Send runs the trust step if needed (FR43), then starts the session with persona defaults and policy. |
| FR2 | The **session list** spans workspaces in attention order: Needs input; Failed and Interrupted; Working (with Starting); Idle; Ended. Ended folds ("… 12 ended"), as does any group past 10 rows. Chips filter by state, one search field matches title, workspace and folder, and MCP-started sessions carry "via MCP". Titles come from the first message, renamable. Persona test sessions never appear (FR42). |
| FR3 | One state vocabulary, shared with Monitoring, Portal MCP and StatusDot: Starting; Working; Needs input; Failed (until the next message); Idle (asleep included); Interrupted (the process vanished; resumable; its own glyph); Ended. A user's Stop isn't a failure. |
| FR4 | Rename (tap the title), archive, end, resume, delete. End confirms only while Working or Needs input. Delete also purges the session's files in the workspace and says "Claude Code's own transcript stays until its cleanup in N days" (Settings recommends 7 days where secrets are delivered). Two live sessions in one folder both say "Shares ~/work/api with 1 other session" (Q12). |
| FR43 | **Folder trust.** Print mode skips Claude Code's trust dialog and starts a project's `.mcp.json` servers unasked (Secrets & env T3). Before the first session in a folder, and whenever the scanned files' hash changes, the person sees by name its `.mcp.json` servers, the hooks, allow rules and plugins in `.claude/settings*.json`, and `env` names, and confirms "Trust this folder", stored per workspace and folder. Untrusted folders run only where Settings' `allowManagedHooksOnly` and `allowManagedMcpServersOnly` locks are on. MCP clients can't grant trust. |
| FR44 | **Integrity.** Anything running as the workspace user can write a session's FIFO. Input the controller didn't send (§10.4) ends the session at once, with a High event and "Ended for safety · input this portal didn't send reached the session". Resume starts a fresh process. |

### Transcript

| ID | Requirement |
| --- | --- |
| FR5 | User messages are bubbles with image thumbnails; replies are full-width markdown, with Copy always visible on code blocks and each reply; thinking is a collapsed "Thought for 12 s" row; each tool call is one expandable row (read-only runs group, errors open); system rows cover retries, interruptions, control changes, stops and peer messages. ⋯ → "Show all details" reveals every row; "Show less" goes back. |
| FR6 | Text streams token by token ✅ (S3, raw exec), after redaction (§13). Subagent text streams too ✅ (S9). |
| FR7 | Tool rows come from each turn's tool list: `Task` and `Agent` both mean a subagent ✅; `mcp__plugin_<plugin>_<server>__<tool>` and `mcp__<server>__<tool>` read "server · tool", browser tools without their `browser_` prefix ("browser · navigate"). Consecutive browser calls group into one row ("Browser · 12 steps · github.com", with Watch); calls refused while a person has control show as one muted "Waited" row, and take-overs as system rows ([Browser & desktop](browser-desktop-pool.md) §15.6). Bash output is dark mono, first and last 40 lines. Agent rows are live (spinner, last tool, elapsed, tokens) and open that agent. A turn footer shows duration, model, and tokens and est. cost from the turn's `modelUsage` delta (§9), which includes subagents; a turn that changed something ends with "Changed 3 files · +42 −18 ›" and "2 images ›". |
| FR8 | Unknown event types render as a muted row. Turns Claude Code starts itself after background work ✅ (S9) read "Started automatically: background task finished". |
| FR48 | **Search this session** (⋯) searches stored events and scrolls to each hit, since virtualization takes old blocks out of the page. |

### Composer and steering

| ID | Requirement |
| --- | --- |
| FR9 | The composer stays live while the session runs. Offline, one pending message is held in memory only, shown as "Sends when back online · Cancel", lost on reload and never stored; approvals are disabled. Each session's draft survives rotation, resizing and navigation. |
| FR10 | Send while working **steers**: Claude reads it at its next model request, usually right after the running tool, or as the next turn if this one ends first ✅ (S3); once read, it moves to where Claude read it, labelled "Steered mid-task". "Send when Claude finishes" (a queued message's ⋯; Alt+Enter) makes it its own turn ✅. "Send now" isn't offered: it waited for the running tool anyway ✅ (S3, flags off). |
| FR11 | Three message states: "Queued · Claude reads this after the current step", with ✕, which withdraws it ✅ (X5) and returns the text to the box; "Read", a brief tick; "Not sent · Retry · Edit" (failed, refused or discarded). "Sending" shows only after 300 ms. |
| FR12 | **Stop** ends the turn: queued messages are cancelled with their text back in the box, running tools are killed, the session stays usable (plain interrupt ✅, S4), and background agents keep running. **Stop all** also stops every agent and background task. ⋯ → "Stop turn, keep queued" says "Queued messages run next". Stop while a request waits denies it and stops the turn. **End session** ends the process ✅ (S8). Stop never sends a signal. |
| FR13 | "/" lists only allowed commands, the same for UI and MCP text: `/compact`, `/context`, `/reload-plugins`, and skills from `system/init` minus a block list (`update-config`, `fewer-permission-prompts`, `loop`, `schedule`, and names Settings adds). `/model` and `/effort` open the pickers; over MCP they're refused, since `session_configure` does that. Anything else answers "Use the terminal for /<cmd>"; until Q6, `/clear` offers "New session in this folder". |
| FR14 | UI messages carry `origin: {kind: "human"}`; Portal MCP text doesn't. A message from another local session shows as "From another session"; if it reaches Claude, FR44 applies. `SendMessage` and `ListAgents` are off unless Settings allows them. |

### Controls: model, effort, ultracode, permission mode

| ID | Requirement |
| --- | --- |
| FR15 | Models come from the session's model list ✅, narrowed to Settings' allowed models and the endpoint's names (Account Pool FR1), and are validated first, since unknown IDs pass verbatim ✅ (S5). Rows show a friendly name and a hint; unknown IDs show as is, marked "custom host". A switch applies from the next request ✅ and warns: "Next reply re-reads 82k tokens · about $0.40 once". After an Account Pool move, a model the new endpoint lacks resets to the default with a system row, and the next turn reads "Account changed · context re-read uncached"; rejected earlier thinking offers "Continue in a new session" (Account Pool Q20). |
| FR16 | Effort offers the model's supported levels ✅ plus "Default (medium)"; unsupported levels are disabled, with one reason line. Ultracode is a switch below it (on ✅, off 🔬), disabled with the reason when unavailable ✅, blocked by policy, on in another session of the workspace, or with under half the session budget left. It multiplies tokens and skips the subagent cap, so it shows what's left. |
| FR46 | Typing "ultracode" shows "Ultracode for this task ×" above the text box; the keyword applies to that task only, and only with a human origin 🔬 (Q7). |
| FR17 | Modes (Manual, Accept edits, Plan, Auto, Don't ask) switch live within Settings' "Modes offered in chat" (✅ Accept edits, Plan, Don't ask; 🔬 Manual, Auto, leaving Bypass), described as in §12.4; blocked ones say "Blocked by policy Standard". |
| FR18 | Chips show applied values ✅, never requested ones, because clamps are silent: "Opus · Medium"; a gold dot when clamped, with the reason in the sheet ("High · runs at medium, policy cap"); "Ultracode" in gold when on. Each change adds a system row. A policy change applies at once: a newly blocked mode switches to the start mode (Settings FR9). |
| FR19 | Context use ✅ is a ring beside Send on desktop and a line in the Model · Effort sheet on phones, where the chip gets a gold dot from 80%. It opens categories and Compact. |
| FR20 | **Bypass permissions**, the one full description. It needs all of: (1) policy allows it; (2) the session is bypass-capable: the person ticked "Allow Bypass later in this session" before the first Send, or chose "Restart to allow Bypass" (a resume at the next turn boundary). Only these pass `--allow-dangerously-skip-permissions`, without which the switch fails with `bypass_not_launched` ✅; MCP-started sessions and persona tests never get it. (3) a confirmation with Cancel focused and Confirm enabled only after ticking "Claude will run every tool without asking in api-dev, which has internet access and delivered credentials". (4) Re-auth (Web app §12.5). That's at least three deliberate taps plus re-auth. While on, the header is danger-tinted and rows say "Bypass"; leaving is one tap 🔬. Wakes and resumes never restore it ("Bypass turned off after sleep"). |

### Approvals and questions

| ID | Requirement |
| --- | --- |
| FR21 | Every request reaches the portal: sessions always launch with the stdio prompt host, without which Claude Code silently denies prompts and drops AskUserQuestion and the plan tools ✅ (S5b). |
| FR22 | A permission request ✅ becomes a card in the dock (§12.3): tool, plain question ("Run this command?"), preview (command, diff, URL, MCP arguments; `browser_navigate` shows the address, "Open github.com/login?"), reason, the asking subagent, Deny and Allow. While it's docked the composer answers it: the placeholder reads "Or tell Claude what to do instead", and Send becomes "Deny & send" (deny, with the text as the note). ⋯ adds "Always allow in this session", hidden under Settings' managed-rules lock. Answers follow §10.3. Answered cards collapse to "Allowed once · npm test", "Allowed from Alfian's laptop · 14:02" or "No longer needed · the task was stopped". |
| FR23 | Allow is never focused, Enter never approves, nothing approves on swipe, offline disables the buttons, and the first answer per request wins. A card that appears or is stepped to ignores input for 500 ms while it fades in; after an answer, the outcome shows for about 600 ms before the next card; Allow never lands where Send or ✕ was. |
| FR24 | AskUserQuestion becomes a question card (2–4 options, single or multiple) whose own answer is the composer ("Type your own answer"; Send reads "Answer"); ExitPlanMode a plan card ("Approve, accept edits", "Approve, ask before edits", "Keep planning"); a Workflow call a card with a token caution 🔬. Simple MCP elicitation forms become question cards; others are declined 🔬. |
| FR25 | Requests never expire in the portal 🔬 (Q2), handoffs aside (FR45). A waiting one sets Needs input and feeds the Web app's attention service, as failed turns do: list order, nav and app badges, the tab title ("(2) Sessions · <name>"), push (Web app §11: Needs input; Failed for a failed turn), and inside a session the back button's count ("‹ 2"). A session gets no toast for its own requests while on screen. `?request=<id>` opens the dock on that request, never focusing Allow. Portal MCP answers only with its session-control switch on; allows need admin scope and a confirmation (its §13.3). |
| FR45 | **Handoffs.** A Browser & desktop `browser_handoff` call (a long-running MCP call, not a permission request) becomes a `handoff` request and a dock card laid out like FR22 ([Browser & desktop](browser-desktop-pool.md) §15.4): "Browser", the checked origin's question, the agent's quote as untrusted text, Decline, and Take control, which opens the live view already in control. It sets Needs input and keeps the session awake; it clears when the call returns, Stop cancels it, and after 10 minutes of waiting (paused while someone has control) it expires: "The agent stopped waiting at 14:12", with Take control anyway and Open chat. |

### Multi-agent monitoring

| ID | Requirement |
| --- | --- |
| FR26 | Agents come from the `task_*` events ✅, with `background_tasks_changed` as the live set ✅ (S9): status, type, description, last tool, tokens and elapsed, nested by parent. Workflows group their agents, with phases where the stream reports them 🔬 (Q7); shell tasks get a section; finished rows fold ("… 4 done"); a subagent waiting on a request shows the gold Needs input dot and jumps to the dock. |
| FR27 | While anything runs, the **activity strip** above the composer reads "● Working · npm test · 1:12 · 3 agents ▴ · Stop", or "Working · browser · github.com · Watch" while the agent uses its browser. It expands in place, up to 40% of the visible viewport: "3 running · 1 done · 1 failed · Stop all", then one row per agent. "All agents ›" opens the full view; a row opens that agent's messages (`parent_tool_use_id` ✅), with its own Stop in that view's header 🔬. |
| FR28 | The session list is the cross-workspace monitor: each row shows the live summary, agent count and the waiting request. Terminal sessions stay in Monitoring's Agents tab, linked as "2 more in terminals". |
| FR29 | Self-started turns count toward budgets and attention. `CronCreate`, `CronDelete` and `ScheduleWakeup` are off unless Settings allows them: they fire unwatched and survive resume 🔬. |

### Attachments and downloads

| ID | Requirement |
| --- | --- |
| FR30 | **+** opens the OS picker directly (photos, camera and files, several at once); desktops also paste, or drop anywhere on the transcript ("Drop to attach"). Android shares images in through `/admin/sessions/share` (§12.2). The browser downscales to 2,000 px on the long edge and re-encodes as JPEG (the CLI caps there too ✅, S6): JPEG, PNG, GIF, WebP, up to 20 images and 20 MB per message, with progress and per-image retry. An image the browser can't decode goes as is if it's one of those types under 5 MB, else "Can't read this photo format". |
| FR31 | Claude Code keeps its copy under `/tmp` ✅, which a restart loses, so the portal keeps originals in its blob store and writes them, and other files up to 25 MB, to `~/.claudepilot/uploads/<id>/`, adding the path to the message (`@path` for files). |
| FR32 | **Files** lists Changed (git status), Attached and Produced (Write and Edit paths, new files) with size or +N −M, Preview (images; redacted text up to 1 MB) and Download ("Download all" up to 100 MB). Paths in replies open the same preview. Reads follow §13. |
| FR33 | Path policy, checked on the opened file: real paths under `/home/node` only; never anything in the foundation's secret-path registry (the browser profile, `~/.claudepilot/browser/profile/**`, included), `~/.claude/**`, `~/.claudepilot/**` except the session's own uploads, `/etc/claudepilot/**`, `/etc/claude-code/**` or `/proc/**`. `~/Downloads`, Playwright's output included, is attacker-controlled: files there download as attachments with `nosniff` and `Content-Security-Policy: sandbox`, and images preview only re-encoded ([Browser & desktop](browser-desktop-pool.md) §13 Files). |
| FR34 | "+42 −18" opens the **Diff**, in the cwd the latest `system/init` reports: against the merge base with the default branch when HEAD has its own commits, else the working tree against HEAD (5 s, 50 files, 1 MB each). |
| FR47 | Images render inline in boxes sized in advance: thumbnails in user bubbles, 240 px tall for tool images and produced images. A tap opens a full-screen viewer (pinch zoom, swipe through the turn's images, Download); on phones, Download opens the share sheet ("Save Image") over HTTPS, otherwise the file. |

### Durability and recovery

| ID | Requirement |
| --- | --- |
| FR35 | Closed tabs and network drops never touch a session; tabs replay from their sequence number. Losing a reader loses nothing: replay from the stored offset is gapless and duplicate-free ✅ (S8, one reader killed at one offset). After a portal restart (untested), the portal lists sessions, checks liveness (§10.1) and reattaches from stored offsets; pending requests reappear 🔬 (Q2). |
| FR36 | Container, pod and daemon restarts, "Update Claude Code" and "Enable pools" leave no `exit.json`: the session is **Interrupted**, and a half-written last line is dropped. Resume, or the next message, relaunches it with `--resume` and fresh flags; history and cost return ✅ (S7c), background agents don't. An OOM kill (signal 9 in `exit.json`, or the runtime's OOM event) reads "Ended · out of memory", with Resume. Portal actions that end sessions warn first ("3 live sessions will end") and end them cleanly. |
| FR37 | One writer per session, enforced by `run.lock`, because two writers fork the history ✅ (S7d). A terminal `claude --resume` of a portal session shows as two processes for one ID ("Also open in a terminal"). A dropped send delivers a whole line or nothing, and a retry first looks for the line's UUID in the stream: the CLI echoes UUIDs ✅, but deduplication is the controller's job. |
| FR38 | A session **sleeps** (its process ends; it reads Idle) after Settings' idle time (30 minutes) with no running turn, pending request, queued input, background task or scheduled task, so Needs input and background work never sleep. Sleep happens under the send lock, so messages sent meanwhile go after the wake, which restores model, effort, ultracode and mode, never Bypass. Past 64 MB of output (images echo in base64 ✅) the segment rotates at the next idle point; until then the ingested prefix is freed in place (`fallocate --punch-hole`), so offsets don't move. |

### Limits

| ID | Requirement |
| --- | --- |
| FR39 | Caps count live processes and persona test runs (Settings FR13): 2 per workspace and 10 in total in C1, then Settings' values. A launch or wake also needs free memory (limit − (usage − inactive file)) for the workspace's measured average session RSS, MCP servers included, or 600 MB before any measurement. An ultracode session counts as two. A wake at a cap first sleeps the longest-idle eligible session, else waits ("Waiting for a slot · 4 of 4 running"). Refusals name the cap and its source. |
| FR40 | Budgets: $10 per session in C1, then Settings'. Each result's cost delta adds to the session's total, and from streamed usage (`message_start` and `message_delta` ✅, S3; subagents' `task_progress`) the portal stops a turn mid-way at the budget ("Budget reached · est. $10.02 of $10"), with `--max-budget-usd` as the backstop (§10.2). Costs say "est.": interrupted streams count 0 ✅ (S4), and classifier calls and probes aren't counted. Without a price (custom hosts), budgets are off ("Budget unavailable: no price") and turn caps apply. |
| FR41 | `--max-turns` caps each prompt, so the portal counts Settings' per-session turn cap ("Stopped at 40 turns · Continue"). Messages hold up to 200 KB of UTF-8 text; each stdin line stays under 32 MB. |
| FR42 | Events, requests and files are kept 90 days after last activity; persona test sessions are hidden and deleted when their test ends or after 24 hours. Resume needs Claude Code's transcript (`cleanupPeriodDays`, 30 days by default); after that a session is read-only. |

## 9. Data model

In the portal database ([Pools foundation](foundation-pools.md) §4); redacted (§13), no secrets.

| Table | Key fields |
| --- | --- |
| `chat_sessions` | id (Claude Code's session ID), workspace_id, cwd, title, origin (`ui` \| `mcp` \| `persona_test`), state, state_since, process (`live` \| `asleep` \| `gone`), parent_pid, process_started_at, segment, byte_offset, last_seq, bypass_capable, applied (json: model, effort, ultracode, mode), launch (json: flags, `initialize` declarations, policy and account revisions, persona revision in effect, CLI version), usage_baseline (json: last cumulative totals per model), cost_est_usd, budget_usd, turns, created_at, last_activity_at, ended_reason, archived_at |
| `chat_events` | session_id, seq, at, type, subtype, uuid (unique per session), parent_tool_use_id, task_id, request_id, payload (json: allowlisted fields only; base64 moved to blobs; over 256 KB to the blob store with a preview and `truncated: true`) |
| `chat_inputs` | Every line the controller sends: uuid or request_id, session_id, actor (device or MCP token), kind (`message` \| `control`), priority, state (`sending`, `queued`, `started`, `completed`, `cancelled`, `discarded`, `refused`, `failed`), attachments (blob refs), created_at |
| `chat_requests` | session_id, request_id, tool_use_id, kind (`tool`, `question`, `plan`, `workflow`, `elicitation`, `handoff`), tool_name, agent_label, created_at, answered_at, decision (json), outcome (`allowed_once`, `allowed_session`, `denied`, `withdrawn`, `expired`), actor |
| `chat_tasks` | session_id, task_id, parent_task_id, tool_use_id, type, label, background, status, tokens, tool_uses, last_tool, started_at, ended_at |
| `chat_files` | session_id, kind (`upload` \| `tool_image` \| `download`), blob_sha256, name, workspace_path, size, media_type, width, height, at |
| `chat_folder_trust` | workspace_id, folder, scan_hash, scan (json, names only), trusted_at, actor |

- Token deltas reach browsers live (§13) and stay in memory for the open block only; the store keeps
  whole, redacted blocks. `chat_inputs` is also the record §10.4 checks the stream against.
- When a process exits (`exit.json`) or vanishes (Interrupted), the controller marks inputs that
  never reached a final state `discarded`, since it knows what it sent; the CLI's own `discarded`
  and `refused` states are kept as reported.
- `total_cost_usd` and `modelUsage` are cumulative per session ✅ (S2) and carry on after a resume ✅
  (S7c); `result.usage` covers the main thread only ✅ (S9). For each result the controller diffs
  per-model tokens and cost against `usage_baseline` (after a resume, against the restored totals; a
  decrease counts as a reset) and hands only deltas to Monitoring's `usage_minutes` (source `chat`)
  and Settings' session total.
- The persona revision in effect is the first launch's until a `compact_boundary`, because a resume
  keeps the recorded system prompt ([Persona](persona-pool.md) §10.3).

## 10. Session host and protocol details

### 10.1 Files and commands

| Path in the workspace | Content |
| --- | --- |
| `/etc/claudepilot/bin/cp-session` | The host: POSIX `sh` with `flock`, `setsid`, `timeout`, `head` and `jq`, all in today's image (S8, Monitoring A6). In the foundation bundle, so existing workspaces get updates. |
| `~/.claudepilot/sessions/<id>/` | `meta.json` (flags without secrets, `initialize` declarations, revisions, CLI version per process), `in` (the FIFO, recreated at start), `in.d/` (staged sends), `out.<n>.jsonl` (stdout, one segment per process), `err.log` (1 MB cap), `exit.json` (code, signal, time), `run.lock`. On the home volume, so the portal can finish reading after a restart, and inside Settings' "Protect portal files" rules (A6). |
| `~/.claudepilot/uploads/<id>/` | Attachments (FR31) |

| Command | What it does |
| --- | --- |
| `start <id> <n> -- <flags>` | Recreates the FIFO, clears `in.d/`, and `setsid`s a parent shell that runs `flock -n -o run.lock claude …` with stdin `<>` the FIFO, stdout `>>` segment `n`, stderr to `err.log` and §10.2's environment. With `-o`, children never inherit the lock, so a dev server the agent left running can't hold it. When `claude` exits, the shell writes `exit.json`. Prints the parent's PID and start time. |
| `send <id> <uuid> <bytes>` | Reads exactly that many bytes (`head -c`, so Kubernetes needs no stdin half-close) into `in.d/<uuid>.jsonl`, checks it's one JSON line ending in a newline, then a detached copier writes it into the FIFO under `send.lock` and deletes it. A dropped exec leaves a whole line or nothing. The controller writes the `chat_inputs` row first and, before a retry, looks for the UUID in `command_lifecycle` or the replay. Unstaged sends took 37–270 ms ✅ (S8). |
| `run <id> -- <flags>` | One-shot runs (persona tests): stdin is a regular file holding the prompt line, so EOF arrives and Claude Code drains and exits (✅ on a plain pipe, S7a). A FIFO opened `<>` never sees EOF. |
| `tail <id> <n> <offset>` | Replays segment `n` from a byte offset and follows it for at most 10 minutes (`timeout 600`); exits when its own stdin closes, so a dropped client leaves nothing behind ✅ (S8). |
| `read`, `pack`, `git` | Files and Diff (§13): open, then check the opened descriptor; archives that never follow symlinks; git with command-bearing config neutralized. |
| `trustscan <folder>`, `authcheck` | FR43's names and hash; `pass` or `fail` for §6 item 1, nothing else. |
| `list`, `status`, `stop [--all]`, `purge`, `gc` | Liveness is the parent shell alive, or a process whose `/proc/<pid>/cmdline` holds this session ID and that started after the container, never a bare PID; `end_session`, then SIGTERM after 10 s; delete segments, uploads and staged inputs; delete closed, ingested segments. |

### 10.2 Launch flags, environment and first lines

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --forward-subagent-text --replay-user-messages \
  --permission-prompt-tool stdio --permission-mode <start mode> --name <title> \
  --session-id <uuid> | --resume <uuid> \
  [--max-budget-usd <per Q8>] [--max-turns <cap>] [--model <m>] [--effort <level>] \
  [--append-system-prompt-file /etc/claudepilot/persona/chat-prompt.md] \
  [--allow-dangerously-skip-permissions]                (only after FR20's opt-in) \
  --disallowedTools CronCreate,CronDelete,ScheduleWakeup,SendMessage,ListAgents
                                                        (minus what Settings allows)
```

| Item | Rule |
| --- | --- |
| Environment | `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, the lab's environment, so the CLI can't change under a session and fetched feature flags can't make production differ from the contract tests (the suite also runs once with flags fetched and records differences). `CLAUDEPILOT_CHAT=<id>`, plus `CLAUDEPILOT_CHAT_WAKE=1` on wakes, so hooks fold a wake into its session. Never a secret. |
| First lines | At every launch, resume and wake, before any user line: `initialize` declaring `perTaskStopAffordance: true` and never `rapidFollowupPreempt`; `apply_flag_settings {crossSessionInbound: "refuse"}` if the CLI accepts it 🔬 (Q8); on a wake, `apply_flag_settings {ultracode}`; then `set_permission_mode <start mode>`, whose reply must match or the session ends. That also covers a managed `defaultMode: bypassPermissions` (Settings' Autonomous preset) that might outrank `--permission-mode` 🔬 (Q5). |
| Budget flag | A C2 gate on Q8: about 90% of the remaining budget if restored totals don't count, or of the whole session budget if they do, leaving room for one response plus subagents. Never passed without a price. |
| Model, effort | Passed only when picked; a wake passes the applied values. `--effort` is never `ultracode`, which also forces xhigh. |
| Never | `--no-session-persistence`, `--bg`, `--dangerously-skip-permissions`; `--settings`, `--mcp-config`, `--add-dir` (pools replace them, and resume wouldn't restore them); `--bare`, `--system-prompt` (they drop or replace persona parts); `set_max_thinking_tokens`. Never a key or `env` value in a flag or control request: `get_settings` echoes `env` values, API keys included, in plain text ✅ (X2). |
| Gating | Before every launch, resume and wake, the workspace's `claude --version` (foundation §9) must be in the capability matrix the contract suite produces per version, so a wake onto a changed CLI is gated again. Below the minimum: "Update Claude Code to use Sessions"; newer than tested: "Claude Code <version> isn't tested with Sessions yet", until CI passes it. The first `system/init` must list `msg_lifecycle_v1`, `interrupt_receipt_v1` and `interrupt_cancel_queued_v1` (all present ✅, S1), or the session ends and the workspace is flagged; the `initialize` reply may list them sooner 🔬. An "Unsupported control request subtype" error (S5) turns that feature off for the session. |

### 10.3 What the controller sends and reads

Status comes from the 2.1.296 schema text the lab extracted: **internal** (marked `@internal`),
**experimental**, **plain** (present, unmarked) or **—** (outside the extract). The flag column
names a capability where one exists; every row is also contract-tested per version (§10.2).

| UI action | Line sent | Status · flag | Verified |
| --- | --- | --- | --- |
| Send, steer; send when Claude finishes | `user` with `uuid`, `origin`, `priority` (`next`, `later`); states from `command_lifecycle` (internal) | plain · `msg_lifecycle_v1` | ✅ S3 |
| ✕ on a queued message | `cancel_async_message {message_uuid}` | plain | ✅ X5 |
| Stop; Stop all; stop one agent | `interrupt {cancel_queued: true}`; the same plus `stop_task` per live task; `stop_task` | plain, `stop_task` — · `interrupt_cancel_queued_v1` | ✅ plain interrupt (S4, S8); 🔬 the rest |
| Model | `set_model`, after validation | plain | ✅ S5 |
| Effort; ultracode | `apply_flag_settings`, built only from `effortLevel`, `ultracode` and `crossSessionInbound`; no caller, MCP included, passes raw settings | — | ✅; ultracode off 🔬 |
| Mode | `set_permission_mode` | plain | ✅ acceptEdits, plan, dontAsk, the Bypass refusal; 🔬 default, auto, leaving Bypass |
| Allow; always allow; deny; deny & send | `control_response` to `can_use_tool`: for a tool, `{behavior: "allow"}` with no `updatedInput` (optional), so the CLI runs the input it holds, never the redacted copy; "always allow" adds `updatedPermissions` the portal builds (`addRules` only, `destination: "session"`, checked against Settings); `{behavior: "deny", message}`, with `interrupt: true` for Stop. `decisionClassification` says once, always or reject. `addDirectories` is never sent; a `setMode` suggestion becomes an FR17 change. | plain | ✅ allow, deny (S5b); 🔬 the rest |
| Answer a question or plan | `control_response` to that `can_use_tool` request, carrying only the answer the portal builds | plain | 🔬 shape (Q8) |
| Header, pickers, context, MCP sheet | `get_settings`, `list_models`, `get_context_usage` (`summary` for the ring; `full`, which calls the token-count API, only when categories open), `mcp_status`, `mcp_toggle`; never `get_status` | plain; `get_settings`, `mcp_toggle` — | ✅ S5, X4 |
| Subscription check after each result | `get_usage {skip_behaviors: true}` (without it, the CLI reads every transcript of the last seven days) | experimental | ✅ null rate limits, custom host |
| Rename; end | `rename_session`; `end_session` | plain; — | 🔬; ✅ S8 |

Events read: `system/init` each turn (model, mode, `apiKeySource`, tools, skills, MCP servers,
capabilities, version, cwd) ✅, `command_lifecycle` (internal) ✅, messages with
`parent_tool_use_id` ✅, `stream_event` deltas ✅ (S3), `task_*` and `background_tasks_changed` ✅,
`api_retry` for 429, 529 and failing 401s ✅ (none when the helper fixes a 401 ✅),
`permission_denied` ✅ and `result` ✅; and, when present, `agents_killed` (internal; a system row),
peer-message frames, `session_state_changed`, `compact_boundary` and `tool_progress` 🔬. Unknown CLI
requests get an error response.

### 10.4 Integrity checks

The controller records every UUID and `request_id` it sends and ends the session at once
(`end_session`, then SIGTERM after 10 s), with a High event, when it reads:

- a `control_response` for a `request_id` it never issued, or a second one for one it did;
- a replayed user line, or a `command_lifecycle` `queued` state, for a UUID it never sent (peer
  messages included; commands the CLI queues itself emit no `queued`);
- a `tool_result` or `permission_denied` for a tool whose request is still unanswered, other than
  after the portal's own Stop or `stop_task`;
- a turn with nothing behind it: no input from the controller, no finished background task and no
  scheduled task Settings allowed;
- a permission mode, in a `set_permission_mode` reply or `system/init`, other than the expected one,
  or a `session_id` that changes.

Contract tests inject each kind of line through the FIFO and from a stdio MCP server and expect the
session to end.

### 10.5 Browser protocol

| Direction | Messages |
| --- | --- |
| Tab → portal | `subscribe {session, after_seq}`, `unsubscribe`, `watch_list {filters}`; `send {session, uuid, text, attachments, priority}`; `respond {session, request_id, decision or answer, note}`; `control {session, uuid, op, args}` (stop, stop_keep_queued, stop_all, stop_task, model, effort, ultracode, mode, end, resume, rename, trust); `presence {visible, session}` |
| Portal → tab | `events {session, from_seq, items}` (batched, at most 30 a second per session); `session {id, state, summary, applied, counts}`; `ack {uuid, ok, error, applied}`; `attention {count}` |

Sessions ride the Web app's live socket (`/api/live`), checked like the shell socket (Origin
against `PORTAL_APP_URL`, the session cookie), with pings every 25 s and 1 MB frames. HTTP serves
older pages, uploads, downloads and blobs under the existing guards.

## 11. Per-target notes

| | DinD | Host Docker Desktop | Kubernetes (k3s) |
| --- | --- | --- | --- |
| Start | `docker exec -d` runs `cp-session start` ✅ (S8) | Same API 🔬 | No detached exec: `start` redirects every descriptor under `setsid`, or the exec never returns 🔬 |
| Send | Short `docker exec -i`, length-prefixed (unstaged ✅, S8) | 🔬 | `exec` with stdin; the length prefix avoids stdin half-close, which `@kubernetes/client-node` 2.0.0 sends only on `v5.channel.k8s.io` 🔬 |
| Read | One `tail` per live session, renewed every 10 minutes (unbounded ✅, S8) | 🔬; the socket proxy may drop long streams | One reader per workspace following all its segments, through the API server, renewed every 10 minutes and after drops 🔬 |
| Restart | Writable layer kept; process gone: Interrupted | Same | New pod, home PVC kept |
| Graceful stop | New images' CMD trap runs `cp-session stop --all` before exiting; existing containers keep a PID 1 that exits at once | Same | `preStop` runs `cp-session stop --all` (up to 20 s); `terminationGracePeriodSeconds` 30, up from 5 |

- Everything is portal-initiated; the cluster never calls back. Every `exec` names the workspace
  container (Settings amendment 6 adds a sidecar), and Files and Diff use `cp-session` on every
  target. Sessions need `exec`, so they're unavailable on the foundation's Kubernetes fallback (its
  §6.2). DinD workspaces can reach the portal over the bridge gateway; Sessions never rely on that
  and treat bridges as untrusted.

## 12. User experience

Screens use `@isnanme/ui` and the Web app W1 kit (ImmersiveLayout, PushedScreen, StatusDot,
ConnectionBanner, CodeBlock, DiffView, Meter, and a new PickerSheet, A2): tokens only, no new visual
language. **Sessions** is the first phone tab, with a Needs input badge; workspace rows and pages
get **Chat**. Routes: `/admin/sessions`, `…/new`, `…/:id` (`?request=`) and `…/share`.

### 12.1 Layout by width

| Width | Layout |
| --- | --- |
| Under 640 px, or under 500 px tall on touch | List and session are separate screens; the session is immersive (48 px header, no tab bar). Agents, Files, Diff, Browser and Session info are pushed screens or sheets. |
| 640–1023 px | Rail; list or session, one at a time; the same pushed screens. |
| 1024–1279 px | Rail; list (320 px) beside the session. The "Agents 3" and "+42 −18" chips open the panel as an overlay drawer that doesn't reflow the transcript. |
| 1280 px and up | Rail, list, transcript (up to 760 px) and a 360 px panel that's always there (480 px above 1680 px). Its Segmented "Agents · Files · Diff", plus "Browser" where one is assigned (a view-only mini view that connects only while visible, with Open full view and Take control, [Browser & desktop](browser-desktop-pool.md) §15.1), starts on Agents, which begins with session info: model, mode, persona, est. cost on a Meter against the budget, context. New background work pulses the Agents chip once and never opens anything. |

The `panes` route is one 100dvh column whose list, transcript and panel scroll on their own, with
the composer docked. The page transition is keyed by `/admin/sessions`, so switching sessions never
remounts the list; rotating or resizing never remounts the composer. ⌘- or Ctrl-click (or
middle-click) on a row opens the session in its own tab, the v1 split view.

```
 Phone · working, keyboard closed         Phone · request docked, keyboard open
 ┌──────────────────────────────────┐     ┌──────────────────────────────────┐
 │ ‹ 2  Fix login tests           ⋯ │     │ ‹ 2  Fix login tests           ⋯ │
 │      Working · api-dev · ~/work  │     │      Needs input · api-dev       │
 ├──────────────────────────────────┤     ├──────────────────────────────────┤
 │          ┌─────────────────────┐ │     │ ▸ Bash · npm test ✓         1:12 │
 │          │ fix the login tests │ │     │ All 42 tests pass. Pushing now.  │
 │          └─────────────────────┘ │     ├──────────────────────────────────┤
 │ I'll run the suite first.        │     │ ! Approval needed · git push   ▴ │
 │ ▸ Bash · npm test         1:12 ● │     ├──────────────────────────────────┤
 │ ▸ Agent · reviewer · 3 tools   ● │     │ open a PR instead▏               │
 ├──────────────────────────────────┤     │ [+] [◇] [Opus·Med] [Deny & send] │
 │ ● Working · npm test · 1:12      │     ├──────────────────────────────────┤
 │   3 agents ▴              [Stop] │     │ ░░░░░░░░░░░ keyboard ░░░░░░░░░░░ │
 ├──────────────────────────────────┤     └──────────────────────────────────┘
 │ Steer Claude…                    │
 │ [+] [Manual] [Opus · Medium] [■] │
 └──────────────────────────────────┘

 Desktop · 1280 px
 ┌─────┬─────────────────────┬────────────────────────────────────┬──────────────────────────┐
 │ ⌂   │ Sessions      [New] │ Fix login tests · api-dev  ●     ⋯ │ Agents · Files · Diff    │
 │ ▤   │ Needs input 1 · All │                                    │ Opus 5.5 · Medium        │
 │ ◔   │ ● Fix login…     2m │ transcript, up to 760 px           │ Manual · Reviewer r4     │
 │ ▦   │   api-dev · Allow:  │                                    │ est. $1.20 ▓░░░░░ of $10 │
 │     │   git push?         │                                    │ Context 41%              │
 │     │ ● Docs pass      5m │                                    │ 2 running · 1 done       │
 │     │   web · Working     │ ● Working · npm test · 1:12   Stop │ ● reviewer   Read   0:42 │
 │     │                     │ Steer Claude…                      │ ● tests      Bash   1:12 │
 │     │                     │ + Manual  Opus·Medium  ◔ Stop Send │ … 1 done                 │
 └─────┴─────────────────────┴────────────────────────────────────┴──────────────────────────┘
   rail        list 320               transcript 520                    panel 360
```

### 12.2 Session list (`/admin/sessions`)

| Part | Design |
| --- | --- |
| Header | "Sessions" with **New session**; chips "Needs input 2 · Working · All"; one search field (desktop adds a workspace Select). Empty: "No sessions yet" or "Start a workspace first". Loading: RowsSkeleton. |
| Rows | Phone: "● Fix login tests … 2m" over "api-dev · Allow: Run npm test?" (the waiting request, the activity or the last reply's first line). Desktop rows (64 px) add "+42 −18", "3 agents", "via MCP" and "Bypass". Interrupted rows carry **Resume**; a ⋯ Menu holds Rename, Open shell, Archive and End. No swipe actions; a row's summary updates at most once a second. |
| Share (`…/share`) | The shared thumbnails on top, then New session and the Needs input and Working sessions; picking one opens it with the images in the composer. |

### 12.3 Session screen and approvals dock (`/admin/sessions/:id`)

| Part | Design |
| --- | --- |
| Phone header | 48 px plus the safe area: back with the number of other sessions waiting ("‹ 2", read as "Back to sessions, 2 need input"), the title (tap to rename), a subtitle with the state in words ("Working · api-dev · ~/work/api") that opens **Session info** (persona, pool and account, budget with Raise up to the policy's highest, context, Claude Code version), and ⋯. |
| Desktop header | 56 px: title, StatusDot, workspace, diff and Agents chips, and ⋯. |
| ⋯ menu | While working, Stop all and "Stop turn, keep queued" come first; then Files, Diff, Browser (where assigned), Search, Show all details, Session info, MCP servers, Reload plugins, "Notify when done" (Web app §11.1), Open shell, Keyboard shortcuts (desktop); after a divider, Archive and End session (danger). |
| Above the composer | Bottom up: queued messages ("2 queued ▾" past the first), then the activity strip, or the dock while a request waits. |
| Dock | A labelled region ("Waiting for you") with "‹ 1 of 3 ›" in its header and 44 px Deny, Allow and ⋯ on every touch screen. The transcript keeps at least 25% of the visible viewport and the dock takes at most 45%, its preview scrolling inside with Deny and Allow pinned at its bottom. With the keyboard open it collapses to a 56 px bar ("Approval needed · Run npm test · Review") that expands on tap and closes the keyboard. |
| Transcript | Sticks to the bottom while streaming unless scrolled up; streaming text never animates. "Jump to latest" (44 px, bottom right above the composer, "12 new") appears when scrolled up; loading older blocks keeps the viewport anchored. The always-dark Bash block gets a hairline border in dark mode. |
| Notices | Toasts for other sessions sit above the dock and composer, in the attention tone (gold "!") with Open. Pushed screens pin "Approval needed · Review", which returns to the dock. Skill changes show "Skills changed · Reload" (`/reload-plugins` at a turn boundary); MCP set changes show "Start a new session to apply MCP changes", and a browser assignment "Start a new session to use the browser". |

### 12.4 Composer and pickers

| Part | Design |
| --- | --- |
| Card | Attachments, a text box ("Message Claude", or "Steer Claude" while working; 1–10 lines on desktop, up to 40% of the visible viewport on phones), then the footer. |
| Phone footer | **+** pinned left and one 44 px trailing button pinned right; the Mode and Model · Effort chips share the space between, truncating the model name first and then the mode to its icon, never wrapping or scrolling. The trailing button follows the state: with text or attachments, Send (it steers while working, and reads "Deny & send" or "Answer" while a card is docked); empty while working, Stop; idle and empty, Send disabled. The strip keeps its own Stop. |
| Desktop footer | **+** and Mode on the left; Model · Effort, the context ring, Stop (secondary, at least 8 px from Send) and Send on the right. |
| Pickers | One level, in PickerSheet: an anchored popover from 640 px and a bottom sheet with × below it, with focus trap, Esc and Back. |
| Mode | Manual "Asks before edits and commands"; Accept edits "Edits files without asking; asks before commands"; Plan "Reads and plans; changes nothing until you approve"; Auto "A safety check reviews each action before it runs"; Don't ask "Runs only pre-approved actions and denies the rest without asking"; Bypass, in the danger color and only in bypass-capable sessions, "Runs everything without asking. Isolated workspaces only". Blocked rows say why. Before the first Send, where policy allows, a SwitchRow "Allow Bypass later in this session". |
| Model · Effort | Context use (phones); model rows with name and hint; effort as a ChipGroup (wraps, 44 px, disabled options) with one reason line ("xhigh isn't supported by Sonnet 4.6"); the Ultracode switch ("Plans multi-agent workflows. Uses many more tokens. $6.20 left"). |
| New session | "Runs Claude Code in api-dev · Persona Reviewer r4 · pool team-a" under the composer; the persona part opens Persona's read-only sheet (its §15). |

### 12.5 States

| State | Strip, banner or dot | Transcript | Composer | Action |
| --- | --- | --- | --- | --- |
| Connecting | Header from list data | Cached blocks, or a 3-row skeleton | Enabled; Send shows "Waiting for connection" | — |
| Starting; waking | "Starting in api-dev · checking credentials", then "launching"; "Waking session…" | — | Enabled; messages show Queued | Stop |
| Reconnecting | ConnectionBanner "Reconnecting… · Retry now"; dock buttons disabled | — | Text waits | Retry now |
| New folder | — | — | The first Send opens the trust sheet (FR43) | Trust and start |
| Near budget | Gold "est. $8.10 of $10" from 80% | — | Enabled | Raise budget |
| Budget reached; turn cap | — | "Budget reached · est. $10.02 of $10"; "Stopped at 40 turns" | Disabled with the reason; enabled | New session, Raise budget; Continue |
| Failed | Failed dot | The category: "Rate limit", "Invalid key · prod-2" | Enabled | Try again; auth and billing link to the account |
| Not sent | — | On the bubble: "Not sent · Retry · Edit" | Enabled | Retry |
| Interrupted | Interrupted glyph | "Interrupted · the workspace restarted at 14:02 · background agents were lost" | Enabled; sending resumes | Resume |
| No pool; pool change | — | "Sessions need an account pool in this workspace"; "Paused while the account pool changes" | Disabled | Assign pool, Open shell |
| Ended for safety | Danger dot | "Ended for safety:" "Claude Code stopped using the pool's key", "plan limits appeared on this credential" or "input this portal didn't send reached the session" | Disabled | Open security events (Monitor → Events, Security) |
| Out of memory | — | "Ended · out of memory" | Enabled; sending resumes | Resume |
| Workspace stopped | Offline dot | Read-only | Disabled | Start workspace |
| History expired | — | "This conversation can't continue: its history was cleaned up after 30 days" | Disabled | New session in this folder |

### 12.6 Interaction details

- Every tap answers within 100 ms; sends render at once and reconcile by UUID. Reduced motion stops
  the Working pulse. Nothing autofocuses on touch, Shift+Tab stays with the browser, inputs are
  16 px, and Enter adds a line while an on-screen keyboard is in use.
- **Keys:** Enter sends whenever a hardware keyboard is in use, whatever the width (Web app §9.4),
  Shift+Enter adds a line, Alt+Enter sends when Claude finishes, and ⌘/Ctrl+Enter sends on every
  device. In an empty composer
  while Claude works, the first Esc shows "Press Esc again to stop" for 1.5 s and the second stops;
  an Esc that closes a picker, menu or the slash list doesn't count. ⌘/Ctrl+. stops at once. ⌘K
  opens the global palette scoped to sessions (Web app FR7), with "Go to waiting request" first
  when one waits. With the list focused, ↑
  and ↓ move and Enter opens. ⌘/ lists shortcuts. No browser-reserved combinations, and no
  single-key shortcuts outside a focused widget.

| On a phone | Where | Taps |
| --- | --- | --- |
| Answer a waiting approval | List row → Allow | 2 |
| Steer; withdraw a queued message | Send; ✕ | 1; 1 |
| Send when Claude finishes | Queued row ⋯ → item | 2 |
| Stop the turn; stop everything; stop one agent | Stop; strip ▴ → Stop all; strip ▴ → agent → Stop | 1; 2; 3 |
| Model, effort, ultracode or mode | Chip → row or switch | 2 |
| Bypass | Mode chip → Bypass → tick → Confirm, then re-auth | 4 and re-auth |
| Open the diff or the turn's images | Turn summary row | 1 |
| Download an image | Thumbnail → Download → Save Image | 3 |

### 12.7 Speed targets

The reference device is a Moto G Power-class phone, or Chrome with 4× CPU throttling; every phone
target here and in §15 uses it.

| Measure | Target |
| --- | --- |
| First token on screen after Claude Code writes it | p95 ≤ 250 ms on Docker targets, ≤ 750 ms on Kubernetes 🔬; characters held back for redaction don't count |
| Keystroke to paint while a session streams at full speed | p95 ≤ 50 ms; no main-thread task over 50 ms while streaming |
| Sent message visible; shown as Queued | Under 50 ms (optimistic); within 500 ms |
| Approval tap to Claude Code's acknowledgement | p95 ≤ 500 ms on Docker (one send, 37–270 ms ✅); ≤ 1 s on Kubernetes 🔬 |
| Open a cached session; cold open over Wi-Fi | Under 150 ms; p75 ≤ 1 s (one request ≤ 100 KB, the last 200 blocks) |
| Streaming render; scrolling 5,000 blocks | At most one React commit per animation frame per session; 60 fps; CLS ≤ 0.1 |
| Chat code | Its own route chunk, ≤ 150 KB gzip without the highlighter |

How: deltas flushed once per animation frame into a per-session store, so a token re-renders one
block; transcript updates in `startTransition`; markdown memoized per block (Streamdown);
highlighting in idle time; `content-visibility: auto` up to 150 blocks, then end-anchored
virtualization (TanStack Virtual); image boxes sized from upload metadata; hidden tabs pause all
but attention.

### 12.8 Accessibility

- The transcript is `role="feed"`, one article per message (`aria-busy` while streaming;
  `aria-setsize` and `aria-posinset` under virtualization). A visually hidden `role="status"` says
  "Claude replied" or the state change, never reply text; requests use `role="alert"` ("Approval
  needed: Run npm test"). The strip's timer is `aria-hidden`.
- Labels: the composer ("Message Claude", "Steer Claude"), the ring ("Context 64% used"), images
  ("Photo you attached, 1 of 3", "Screenshot from playwright"). StatusDot pairs color, shape and
  text. Everything works by keyboard (focus order: header, transcript, dock, composer; pickers trap
  focus and close on Esc and Back). On coarse pointers Send, Stop, Allow, Deny and the dock's arrows
  are 44 px at every width. Reflow at 320 px and 200% zoom.

## 13. Security requirements

| Area | Requirement |
| --- | --- |
| Threat model | Code running as the workspace user can already do whatever an approval would allow, so approvals don't contain it; they keep the model from acting unasked. Such code can also write a session's FIFO and read its segment, so a forged line could approve a request, switch the mode or pose as the person. Chat detects that and ends the session (§10.4), and Settings' rules keep Claude's own file tools out of `~/.claudepilot/**` (A6). |
| Credentials and trust | Eligibility and the transition lock per §6; folder trust per FR43. No keys in flags, control requests or input lines; `apply_flag_settings` only from its allowlist. |
| Redaction | Control responses and `system/init` are stored as allowlisted fields only: from `get_settings`, only `applied` (model, effort, advisor, ultracode, ultracodeRequested, ultracodeAvailable), never `effective` or `sources`; from `mcp_status`, name, status, scope, server name and version and tool names, never `config`; from `get_usage`, session totals and `rate_limits_available`, never rate-limit values (any reported limit only ends the session, §6 item 3); from `system/init`, `apiKeySource` only as match or mismatch. The shared value redactor (Secrets & env A9: delivered values, their encodings, credential shapes) then runs as a backstop before SQLite, a browser or Portal MCP sees anything. |
| Streamed text | Never forwarded raw. Each open block (text, thinking, tool input) accumulates per session and is redacted whole; browsers get only the prefix that can no longer become a match. Trailing characters are held while they're a prefix of a redaction value, one of its encodings or a credential shape (a trie), and flushed at block end, where only the final block is stored. |
| Approvals | Allow never echoes input, "always allow" adds only session rules the portal builds, and no directory is ever added (§10.3). Answers name their actor (device or MCP token), are idempotent per request, and are audited. |
| Files and Diff | Reads open the file, check the opened descriptor's real path (`/proc/self/fd/N`) against FR33, then stream from it, so a swapped symlink can't redirect them; archives never follow symlinks. git runs as `git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c diff.external= --no-pager diff --no-ext-diff --no-textconv`, status with the same `-c` flags, an empty override for each `filter.<name>` in the repository's config, and a 5 s timeout. |
| Rendering | Sanitized markdown, no raw HTML; remote images in replies render as links (an image URL can carry data out); files get a sniffed type and `nosniff`, non-images download; no SVG. |
| Transport and storage | Origin and cookie checks on the socket, CSRF on HTTP, 1 MB frames, FR30–FR31 sizes. Raw segments stay in the workspace until ingested and purged. |
| Shared visibility | With one shared server code, everyone signed in can read every session, and workspace users can read its files in the workspace. |

## 14. Observability and audit

- Event log (actor per row): session starts, resumes, sleeps, interruptions and ends with reasons;
  integrity ends, subscription alarms, credential refusals and drift ends (High); folder trust
  granted; transition-lock refusals; mode changes (entering Bypass is High); model, effort and
  ultracode changes; approvals (tool, decision, rules added, never input); budget, cap and memory
  stops; file transfers.
- Metrics for Monitoring: sessions by state, oldest Needs input, failed turns, first token on
  screen, send latency, reader lag, reattaches, interruptions, sleeps and wake time, characters held
  for redaction; per session, reader errors.

## 15. Testing and verification

| Suite | What it covers | When |
| --- | --- | --- |
| Sandbox ✅ | DinD, mock API, flags off. Raw exec: multi-turn stream-json, streamed deltas, steering and withdrawal, plain interrupt, model, effort, ultracode on, three mode switches, `bypass_not_launched`, stdio approvals, images, resume, subagent and retry events. FIFO host: reattach after one killed reader, a send with no reader, a 5.7 MB line, interrupt, `end_session`. Its mock API seeds the suites. | Done |
| Contract | Per CLI version, producing the capability matrix: every flag in §10.2 and row of §10.3; the first lines (start mode against a managed `defaultMode: bypassPermissions`, Bypass → default, default ⇄ auto); Stop with a non-empty queue and with background agents, with and without `perTaskStopAffordance`; §10.4's injections through the FIFO and from a stdio MCP server; a malformed line and an exec killed mid-send; `cp-session run`; the parent shell and `exit.json`; Q8's budget cases; `get_usage` fields with `behaviors` null; a command whose stored copy was redacted runs unchanged when allowed, and no file under `.claude/` changes after "Always allow"; a planted `.mcp.json` and hook (FR43). | CI, before the pinned version moves |
| Durability | All three targets: a reader killed mid-turn, a send with no reader, a portal restart mid-turn and with a pending approval, a container restart and resume, resuming twice, an OOM kill. | CI (DinD, k3d); by hand on Docker Desktop and k3s |
| Guards and canaries | A workspace without a pool is refused; the transition lock refuses launches; drift on account files ends sessions; a user-level helper with an inline fake key, a managed MCP header and an exposed Secrets & env value never reach stored events, frames or MCP results; a key streamed one to three characters per delta never reaches a frame; symlink swaps and git config commands fail (§13). | CI |
| UI and load | Playwright at 320×568, 360×780, 390×844 and desktop sizes; keyboard open at 375×667 and 390×844 on iOS Safari, an installed iOS app and Android Chrome (dock budget, Send never moves); Enter never approves; a double tap on Allow approves exactly one request; Bypass takes three deliberate taps plus re-auth; offline; 5,000 blocks at 60 fps on the reference device; axe clean; 20 streaming sessions within one portal core and 300 MB RSS. | CI; devices by hand |

## 16. Rollout and milestones

| Milestone | Scope | Gate |
| --- | --- | --- |
| C0 | Spikes: Kubernetes and Docker Desktop transport; pending-approval durability; `authcheck` and `apiKeySource` values; managed Bypass lock and managed `defaultMode` against the flags; empty-helper fallback; slash commands as text; Stop semantics; `crossSessionInbound`; what runs in untrusted folders; FIFOs on the home volume; reaping and real-session memory | In parallel with Foundation F1 |
| C1 | DinD: host, controller, event store, list, transcript, send, steer, Stop, approvals and questions, integrity checks, folder trust, eligibility and the transition lock, redaction with projections and streaming hold-back; fixed caps (2 and 10), a $10 budget, Manual, Bypass blocked | Foundation F1–F2; Account Pool M3; Web app W1; C0 on DinD |
| C2 | Model, effort, ultracode and mode pickers, context; Settings limits (modes, budgets, caps, Settings FR9) | Settings S1–S2, alongside S4; Q8's budget cases |
| C3 | Activity strip and Agents view, attachments, image viewer, Files, Diff; state and usage deltas for Monitoring D5 | Blob store (Skillset A5) |
| C4 | Kubernetes and Docker Desktop; idle sleep; segment rotation; Interrupted and Resume hardening | Foundation F3; C0 spikes; Q10 |
| C5 | Bypass opt-in and flow; Portal MCP session tools (MCP6); Persona chat prompt and test prompts; Reload; handoff cards | Settings S3–S4; Portal MCP MCP5; Browser & desktop B1 |

## 17. Success metrics

| Metric | Target |
| --- | --- |
| First token on screen after Claude Code writes it | p95 ≤ 250 ms (Docker), ≤ 750 ms (Kubernetes) |
| Events lost or duplicated across tab drops, portal restarts and reattaches | Zero, by automated test |
| Sessions on credentials the portal didn't deliver; Bypass entered without policy, opt-in, confirmation and re-auth | Zero; zero |
| Injected inputs in the integrity suite that don't end the session | Zero |
| Secrets in stored events, socket frames, MCP results or logs | Zero (canary tests, split deltas included) |
| Phone: answer a waiting approval from the list; start a session | Two taps (row, Allow); one screen (New session, type, Send) |
| Interrupted sessions that resume with their history | 100% while Claude Code's transcript exists |
| Cold open of a session on the reference phone | p75 ≤ 1 s |

## 18. Amendments to other PRDs

| ID | PRD and section | Change |
| --- | --- | --- |
| A1 | Foundation §6.3, §7, §9, §12; Skillset A5 | Add `cp-session` to the bundle, and `~/.claudepilot/sessions/**` and `~/.claudepilot/uploads/**` as Chat-owned paths. Chat relies on §9's pinned CLI and adds its contract tests and per-version capability matrix to §12's suite. The drift check tells chat when the account drop-in or a key file changed outside the portal in a workspace with live sessions (§6 item 2). The secret-path registry (Browser & desktop A6) feeds FR33. The env registry records `CLAUDEPILOT_CHAT` and `CLAUDEPILOT_CHAT_WAKE` as Chat's, set only in a session's launch environment, never in managed `env`. New images get a CMD trap that runs `cp-session stop --all`, and Kubernetes workspaces a `preStop` hook and a 30 s grace period (Q10 may add an init). The blob store also holds chat images and attachments. |
| A2 | Web app & PWA §8, §9, §14 | Chat adopts the route table, `?request=`, the share route, `panes`, and immersive under 640 px wide or 500 px tall on touch; `/admin/sessions/new` takes the session screen's flags, not `task`. The `panes` route is a 100dvh column whose panes scroll on their own, and the page transition is keyed by destination. The kit adds PickerSheet; Toast gains an attention tone and an action; ImmersiveLayout sets `--tabbar-h` to the dock and composer height; StatusDot gets Interrupted's glyph (gold pause); CodeBlock's always-dark variant gets a hairline border in dark mode. |
| A3 | Account Pool §7, §11.1, §11.5 | Unchanged: chat sessions report `api_retry` for 429, 529 and 401s that keep failing ✅; a 401 the helper fixes by itself emits nothing ✅. |
| A4 | Account Pool §10.4, §10.5, §12, FR2, FR3, US8 | Unassign, a move to own login and pause take chat's credential-transition lock, which ends the workspace's sessions before step 1 and is released after step 2. FR2 and FR3 refuse `sk-ant-oat*`, `sk-ant-ort*` and other OAuth shapes in any encoding, as Secrets & env FR5 does. Notify chat of every move; schedule proactive moves at chat turn boundaries, and until its Q20 is answered hold cross-organization moves of workspaces with Working sessions until the turn ends (urgent moves excepted). §10.5: chat stores only `get_settings.applied`. US8: Sessions need an account pool. |
| A5 | Settings §10.3, FR12, US7 | §10.3: `--allow-dangerously-skip-permissions` only after the per-session opt-in (Chat FR20); chat sends `set_permission_mode` before the first line; the budget flag's value waits on Q8, so drop the ✅ on "doesn't count totals restored by `--resume`" (never tested). FR12 and US7: no new-session sheet; budget and turns use policy defaults, shown in Session info with Raise up to the highest. Chat hands per-result deltas; FR12's reset claim is tested separately for `total_cost_usd`, which carried on after a resume ✅ (S7c), and `modelUsage`. Chat's caps are fixed (2, 10, $10) until S4. |
| A6 | Settings §10.1, §11, §13.2 | New row: Peer messages in chat (`SendMessage`, `ListAgents`; off; G P W). Protect portal files adds `Read(~/.claudepilot/sessions/**)`; its `Edit(~/.claudepilot/**)` now also covers the FIFO, and where the sandbox runs, `~/.claudepilot/**` stays out of its writable paths. `CLAUDE_CODE_MAX_RETRIES` stays with Account Pool, which always writes it (Settings §11.3). Pause takes the transition lock (§13.2 step 1). |
| A7 | Monitoring §11.2, §12, FR9, FR12, Q12 | For kind `chat`, the chat registry's state wins regardless of freshness: a process that has gone isn't Ended. Interrupted gets its own glyph. Chat hands per-result usage deltas, never cumulative totals. Wakes keep the session ID and set `CLAUDEPILOT_CHAT_WAKE=1`, so hooks fold them into one session. References: "Chat sessions FR4" becomes FR3, and "Q18" becomes Q14. |
| A8 | Persona §10.3, §13.2, Q10 | Test prompts use `cp-session run`, whose stdin is a file, so runs drain and exit (a FIFO never sees EOF; plain-pipe drain is ✅, the host path is a contract test); `perTaskStopAffordance` doesn't apply to closed-input runs. The revision in effect is the first launch's until compaction. References: idle sleep is FR38 (not FR40), the stdio prompt host FR21 (not FR22), caps FR39 (not FR41), stored responses §9 (not §16). Its asks are adopted: never `--bare` or `--system-prompt` (§10.2); persona test sessions hidden and deleted (FR2, FR42). |
| A9 | Skillset FR24, §10.4 | Reload sends `/reload-plugins` at a turn boundary (Q6) and reads plugins and skills from the next `system/init`; a sleeping session reloads when it wakes. |
| A10 | Portal MCP §13.3 | `session_send.priority` is `next` or `later`; stopping is `session_interrupt`. MCP text has no human origin and passes FR13's allowlist; `session_start` runs the eligibility check, works only in trusted folders (FR43) and never makes a session bypass-capable; `session_respond` follows §10.3's answer rules; `session_configure` uses the `apply_flag_settings` allowlist. `session_get` returns events only when asked, since agent text lands in claude.ai conversations under that plan's terms. |
| A11 | README | Chat sessions: Draft v0.6 (reviewed). |
| A12 | Browser & desktop §12.4, §15, A10 | A handoff is a `handoff` request in chat (FR45). Its A10 references become FR45 (handoff card), FR25 (attention) and FR33 (path policy, through the secret-path registry). |
| A13 | Secrets & env A9 | The shared redactor also answers, for a buffer, the longest suffix that is a prefix of a value, one of its encodings or a credential shape, for §13's streaming hold-back. |

## 19. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | 🔬 Kubernetes transport: detached start with every descriptor redirected; length-prefixed sends; reader lifetime through the API server and orphaned `tail` after a drop; FIFOs on the home PVC; `preStop`. Repeat starts, sends and readers on host Docker Desktop. | Chat spike (C0) |
| Q2 | 🔬 Does a `can_use_tool` request stay pending for 30 minutes or more with no reader, and across a portal restart? Does re-sending `initialize` return pending requests? Remote Control's docs mention a five-minute expiry for some dialogs. | Durability spike |
| Q3 | 🔬 Observed: `apiKeySource` is `ANTHROPIC_API_KEY` for an env key and `apiKeyHelper` for a `--settings` helper, on every turn ✅. Open, in the lab only: the managed helper's value; `setup-token`, claude.ai and cloud-provider values; whether it changes mid-session when the source changes; how `authcheck` confirms the helper without reading a login (preferred: `get_settings`' effective `apiKeyHelper` plus a launch environment with no credential variables; else the single source field of `claude auth status`, read inside the workspace and discarded); whether `get_usage` ever reports plan limits, the alarm's positive signal. | Sandbox test |
| Q4 | 🔬 Does an empty or failing `apiKeyHelper` fall back to a stored `/login` (Settings Q5)? | Sandbox test |
| Q5 | 🔬 Does a managed `disableBypassPermissionsMode: "disable"` beat `--allow-dangerously-skip-permissions`? Does a managed `defaultMode: bypassPermissions` beat `--permission-mode` in `-p`, and does the first-line `set_permission_mode` correct it? Do permissions, `availableModels` and `maxEffortLevel` hot-reload into a long-lived `-p` session (Settings Q1, Q2)? | Settings and Chat spike |
| Q6 | 🔬 Do slash commands sent as stream-json text run (`/compact`, `/context`, `/reload-plugins`)? Does `/clear` start a new session ID? Can `/login` be blocked inside the CLI? | Sandbox test |
| Q7 | 🔬 Does the ultracode keyword work with a human origin? Does `apply_flag_settings {ultracode: false}` turn it off? What does a Workflow approval request contain, and does the stream report workflow phases? | Sandbox test |
| Q8 | 🔬 Not yet exercised: `--session-id`; `--max-budget-usd` scope (session or prompt), restored totals after `--resume`, `/clear` and `modelPricing` (a C2 gate); `--append-system-prompt-file` across resume (Persona Q11); `--disallowedTools`; `initialize` (shape, its `capabilities`), `perTaskStopAffordance`, `stop_task`, `rename_session`, `cancel_queued` with a non-empty queue, an interrupt with background agents; the AskUserQuestion and plan answer shapes; MCP `elicitation`; `session_state_changed`, `compact_boundary`, `tool_progress`, `agents_killed`; `crossSessionInbound` through `apply_flag_settings`, and peer delivery on each lane; whether a user line without a UUID is replayed; whether `background_tasks_changed` lists shell tasks; a malformed stdin line; whether `CronCreate` and `ScheduleWakeup` fire in a long-lived `-p` session. | Contract tests (C1) |
| Q9 | 🔬 Does the stdio prompt tool turn approvals of MCP tools that require user interaction into denials, as the CLI reference says of prompt tools? | Sandbox test |
| Q10 | 🔬 Are detached sessions reaped with `bash -c` as PID 1? How much memory do real sessions use with MCP servers and a 200k-token context (≈223 MB RSS was one sample during a busy turn against the mock, X3), and how long does a wake take? Gate for C4. | Sandbox test |
| Q11 | Answered by Web app & PWA: push for Needs input once HTTPS exists (its W5); until then, badges, the tab title and toasts. | — |
| Q12 | One shared folder with warnings (v1), or a git worktree per session? | Product |
| Q13 | Before anyone outside the operator's organization uses Sessions: written sign-off on the refused login commands and hidden `/login`, on key pooling (Account Pool Q1, Q12) and on the name "claudepilot" against Anthropic's trademark guidelines, plus the claude.ai data flow through Portal MCP (A10). | Operator |
| Q14 | Answered by Web app & PWA: approvals record the device name ("Allowed by Alfian's iPhone", its §12.4). | — |
| Q15 | Should terminal sessions appear read-only in Sessions, with a later "Continue here" that forks them, never a second `--resume`? | Product |
| Q16 | Are 30 minutes of idle sleep, 64 MB segments, 90 days of session data, C1's caps of 2 and 10, and the 600 MB admission estimate right? | Operator |
| Q17 | Should a later version run sessions on API keys or cloud credentials a user set up, with an audited admin attestation per workspace, or wait until Account Pool delivers cloud-provider endpoints? | Product, Operator |
| Q18 | 🔬 What runs in an untrusted folder under `-p`: project `.mcp.json` servers (documented), project hooks and project-enabled plugins (Secrets & env Q11, Persona Q14)? | Sandbox test (C0) |
