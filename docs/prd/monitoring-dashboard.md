# PRD: Monitoring dashboard

| | |
| --- | --- |
| Status | **Draft v0.6**, a consistency pass: the Web app's navigation and workspace page (its A4), Chat A7, Browser & desktop A9, and requests from MCP set, Portal MCP and Settings & policies. ✅ = observed in our sandbox runs on Claude Code 2.1.296 (print mode, mock API). 📄 = documented by Anthropic or Kubernetes, not observed by us. 🔬 = needs a test before it becomes an acceptance criterion (§20). Runtime metrics exist today. OTLP export configured from managed `env` to a loopback receiver, per-record account tagging and managed hooks writing to the outbox were verified for Account Pool (sandbox E7). |
| Owner | Alfian Isnan |
| Last updated | 2026-10-10 |
| Depends on | [Pools foundation](foundation-pools.md) (storage, delivery engine, outbox, event log, shared UI) |
| Related | [Account Pool](account-pool.md) (health, quota, usage rollups, billed cost), [Chat sessions](chat-sessions.md) (chat state and results), [Settings & policies](settings-policies.md) (monitoring settings, posture, limits, retention), [MCP set pool](mcpset-pool.md), [Skillset pool](skillset-pool.md), [Secrets & env pool](secrets-env-pool.md), [Persona pool](persona-pool.md), [Browser & desktop pool](browser-desktop-pool.md), [Portal MCP server](portal-mcp.md) |

## 1. Summary

Monitoring adds one **Monitor** page that answers, on a phone or a desktop: what is running, what is
it using, and is anything failing or waiting on me? It covers workspaces (status, CPU, memory,
restarts, OOM kills, disk, processes), agents (every Claude Code session, from a terminal, the
background or a chat, with its state, model, mode and subagents), tokens and estimated cost, MCP
use, security events and account health.

The portal reads all data through the runtime APIs it already holds; nothing in a workspace calls
the portal. Managed hooks, and OpenTelemetry sent to a receiver bound to `127.0.0.1` inside the
workspace, append to the foundation's outbox, which the portal collects with short `exec` calls
along with process and agent snapshots. The portal is never in the API path, and no prompt,
response, tool output or secret is collected. Every number shows its source and age, and estimates
say so.

## 2. Background and problem

- The Workspaces page shows status, CPU and memory, polled every 5 s while open. Nothing is kept, and
  nothing shows what Claude Code is doing: which sessions work, wait on a prompt or fail, what they
  cost, which process eats memory, which MCP servers run, or who bypassed permissions.
- Claude Code emits raw signals only; dashboards and correlation are the backend's job
  ([monitoring docs](https://code.claude.com/docs/en/monitoring-usage)). The portal must be that
  backend, at small scale.
- OTLP push to a central collector can't work: the k3s cluster has no route to the portal, and
  Docker workspaces reach it only through host-gateway or a port forward.
- Every pool, Chat sessions, Settings & policies and the Portal MCP server produce or consume these
  signals. They need one read model and one place for "needs attention".

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Glanceable.** One screen tells an admin, on a phone or a desktop, whether anything is failing or waiting on them, and links straight to it. |
| G2 | **Every agent.** Every Claude Code session in every workspace (terminal, background, chat or headless) with its state, model, permission mode and subagents. |
| G3 | **Usage.** Tokens per workspace, session, model and account, with cost labelled estimated or billed, kept 13 months. |
| G4 | **Workers and processes.** CPU, memory, restarts, OOM kills and disk per workspace with history, plus a live process list. |
| G5 | **MCP.** Which MCP servers each workspace uses, how often they're called and fail, and which the portal doesn't manage. Portal MCP client activity too. |
| G6 | **Security.** Denials, bypass use, mode escalations, sandbox escapes, secret-path deny hits, settings tampering and the portal's own admin actions in one 90-day feed. |
| G7 | **Honest numbers.** Every value shows its source and age. Unknown is "—" with a reason, never zero. Estimates say "est.". |
| G8 | **No calls home, no content.** Works on all three targets with no workspace-to-portal call, and never collects prompts, responses, tool input or output, or secrets. |

## 4. Non-goals

- A general observability stack: custom dashboards, a query language, Grafana parity.
- Sending alerts itself. Attention items reach devices as push through the Web app (its §11); email,
  SMS and Slack are out of scope there too.
- Storing conversation content. Transcripts belong to [Chat sessions](chat-sessions.md).
- Forwarding telemetry to another collector. In Full mode Monitoring owns the OTLP endpoint.
- Billing. Billed amounts appear only where Anthropic's cost report covers an account (FR14).
- Tokens, cost and plan usage of own-login workspaces (claude.ai limits, `/usage`, `rate_limits`).
- Process control (kill, restart) and process history.
- Tamper-proof audit on the standard image, whose users have `sudo`.

## 5. Users and stories

**Admin**: runs the portal and watches the fleet, often from a phone. **Workspace user**: works in a
terminal or chat session. Today these are often the same person.

| ID | Story |
| --- | --- |
| US1 | As an admin on my phone, I open Monitor and one line tells me whether anything needs me ("2 sessions need input · 1 workspace error"). One tap takes me there. |
| US2 | As an admin, I see every live agent: its state and for how long, model, permission mode and subagents. |
| US3 | As an admin, I see tokens and estimated cost for the last hour, day, week or month, by workspace, model, session and account. |
| US4 | As an admin, I open a workspace and see what uses its CPU and memory right now, plus resource history, restarts, OOM kills and free disk. |
| US5 | As an admin, I see which MCP servers each workspace uses, call and failure counts, and servers the portal doesn't manage. |
| US6 | As an admin, I see denials, bypass use, mode escalations, sandbox escapes, secret-path deny hits and tampering next to the portal's own admin actions, and filter and export them. |
| US7 | As an admin, I see every account's health, headroom, monthly spend against budget and recent failovers, riskiest first. |
| US8 | As an admin, I can tell measured from estimated or unknown, how fresh each number is, and which sessions don't report and why. |
| US9 | As an admin, I set monitoring to Full, Activity or Off globally, per policy or per workspace, and see what applies now and what waits for new sessions. |
| US10 | As a workspace user with my own login, my claude.ai identity and plan usage are never collected. The portal shows "Own login" and no tokens or cost. |

## 6. Scope boundary: what is collected

This boundary is a requirement, enforced three times: by the hook script, by the receiver, and by
the portal's ingest schema, which drops unknown fields.

| Collected | Never collected |
| --- | --- |
| Event names and times, session IDs and custom titles, working directory, model, permission mode, effort, error category, HTTP status | Prompts, responses, thinking, transcripts, or anything read from `transcript_path` |
| Token and request counts, durations, Claude Code's cost estimate | Tool input and output, file contents, diffs, command output |
| Tool names, MCP server names and sources, success or failure, auto-mode denial categories | Secret values, keys, environment values, process environments |
| Process command lines, redacted, shown live and never stored | Claude.ai identity (`user.email`, account UUID, organization) and plan usage |
| Opt-in per workspace: the first 200 characters of a requested or denied command or path, redacted | Raw API request or response bodies |

Workspace-reported data is unauthenticated: on the standard image anyone with a shell can forge or
suppress it, or post to the receiver; the hardened image (Settings & policies §14) narrows that.
Features that act on these numbers (budgets, rotation thresholds) get them only within sanity caps:
a line's tokens at most the model's context window plus its maximum output, and a workspace's spend
per minute at most 10× its 7-day p99 (at least $5). Lines over a cap are quarantined, kept out of
rollups and listed under Data sources. Budgets fed only by telemetry read "Partial (est.)".

## 7. Solution overview

```
 Portal                                            Workspace (DinD, host Docker or Kubernetes)
 ┌───────────────────────────────┐                 ┌─────────────────────────────────────────────┐
 │ Delivery engine (foundation)  │ ──── push ────▶ │ managed-settings.d/80-claudepilot-monitor   │
 │ Resource sampler              │ ◀─── stats ──── │ claude (unmodified) ─────────▶ provider API │
 │ Pull exec (foundation)        │ ◀─── exec ───── │   hooks ─▶ monitor-event ──────────┐        │
 │   + monitor-snapshot step     │                 │   OTLP ──▶ monitor-otel 127.0.0.1 ─┤        │
 │ Ingest: validate, redact,     │                 │ ~/.claudepilot/outbox/ ◀───────────┘        │
 │   dedupe, cap, attribute      │                 │   monitor.jsonl · telemetry.jsonl           │
 │ SQLite rollups and retention  │                 │ /proc, df, cgroup, claude agents --json     │
 │ + Chat, Account Pool, pools   │                 └─────────────────────────────────────────────┘
 │ Monitor API ─▶ Monitor page   │
 └───────────────────────────────┘
```

Terms: a **workspace** is a worker (one container). A **session** is one agent, a Claude Code
conversation. A **subagent** is an agent a session starts. A **process** is an OS process.

1. **Runtime.** One sampler with history, restarts and OOM kills, plus a snapshot step (agents,
   processes, disk, OOM count) that rides the foundation's pull `exec`.
2. **Workspace producers.** A managed drop-in registers command hooks and, in Full mode, points
   OpenTelemetry at the local receiver. Both append allowlisted fields to the outbox.
3. **Portal inputs.** Chat sessions, Account Pool, Settings, pools and the Portal MCP audit (§11.2).
4. **Read model.** Ingest validates, redacts, caps and rolls up in SQLite. One `/api/monitor` API
   feeds Monitor, the workspace page, the Workspaces list and Portal MCP's `monitor_overview`.

## 8. Functional requirements

### Runtime

- **FR1** One sampler reads CPU and memory of running workspaces every 30 s, or 10 s while anyone
  watches, through the existing `usage()`, per container, so a browser container counts apart from
  the workspace's ([Browser & desktop](browser-desktop-pool.md) A5). `/api/workspaces/usage` serves
  its latest sample.
- **FR2** Restarts: Docker `RestartCount`, pod `restartCount`. OOM kills are stored as `resource`
  events with their time, from three sources. On every target, the cumulative `oom_kill` count in
  `/sys/fs/cgroup/memory.events`, read and diffed by every snapshot (FR27; a drop means a restart).
  On Docker, `oom` events from the daemon (🔬 Q14). On Kubernetes,
  `lastState.terminated.reason: OOMKilled`, since on cgroup v2 the kubelet kills the whole container
  📄 (🔬 Q14). The count catches the kernel killing `claude` or a dev server while PID 1
  (`bash -c '… sleep infinity & wait'`) keeps the container running and its state unchanged. A rise
  with no runtime event reads "2 kills between 14:02 and 14:10". A browser container's restarts and
  OOM kills are counted apart and never change the workspace's status.
- **FR3** While a Processes section is open, every 5 s, `monitor-snapshot --ps` (by `exec`, as the
  workspace user) reads `/proc`: PID, parent, user, state, RSS, start time, command line, and
  `utime` plus `stime` in clock ticks. CPU % is the tick change over the interval; `ps`'s
  `cputimes` counts whole seconds, so over 5 s it moves in steps of 20% of a core. Docker's top API
  returns host PIDs that don't match `claude agents` PIDs, so every target uses `exec`. Rows are
  tagged: Claude Code with its session, its children, stdio MCP servers by set (from the non-secret
  `CLAUDEPILOT_MCP_SERVER` marker the launcher exports, since `exec` replaces its arguments;
  [MCP set](mcpset-pool.md) §14), pilot components, leftovers of ended sessions. The snapshot
  reads only that marker from a process's environment and hides its own processes. Nothing is
  stored.
- **FR4** While the Agents tab or a workspace's Sessions tab is visible, every second pull (20 s), the snapshot
  adds `claude agents --json --all` where a `claude` process runs
  ([agent view](https://code.claude.com/docs/en/agent-view)): `id`, `sessionId`, `kind`, `state`
  (background only), `status`, `waitingFor`, `pid`, `startedAt`, `name`, `cwd`. `--all` keeps parked
  background sessions listed. `claude daemon status` adds the supervisor's state without starting
  one 📄. 🔬 Q3.
- **FR31** Rows are keyed by the workspace's instance ID (§19 A9), so a reused name starts empty.
  Remove pulls the outbox one last time (A5), ends live sessions with reason `removed` and closes
  attention items; usage rollups stay for their retention under "Removed workspaces".

### In the workspace

- **FR5** The mode is a [Settings & policies](settings-policies.md) row (scopes Global, policy,
  workspace; §19): **Full** (hooks and telemetry), **Activity** (hooks) or **Off** (empty drop-in).
  The default, **Auto**, is Full with an account pool and Activity without. Own-login workspaces
  never show tokens or cost: ingest drops their usage in every mode, and Q7 decides only whether one
  may run Full. Only Full writes telemetry `env`, so Activity and Off leave a user's own
  OpenTelemetry alone. Sessions started in Full export until they exit (exporter settings are read
  at launch 📄), and the portal drops their lines.
- **FR6** `monitor-event` appends §10.1's allowlisted fields to `outbox/monitor.jsonl` and prints
  nothing. It traps every error and exits 0, since a synchronous `Stop` hook that exits 2 keeps
  Claude working 📄 and `jq` exits 2 on bad input. It runs under `timeout 2` (async hooks have no
  enforced timeout 📄), parses at most the first 64 KB of stdin with `jq --stream` and discards the
  rest, marking the line `truncated` (a `PostToolUse` input carries the whole `tool_response`),
  finishes within 100 ms, and never opens `transcript_path`. In Full mode, `SessionStart` and
  `UserPromptSubmit` pass `--receiver`, which starts the receiver if its port is free. It exits 0 at
  once when `CLAUDEPILOT_VERIFY` is set ([Skillset](skillset-pool.md) A7). Tests: a failing `jq` on
  `Stop` never continues the turn; a 10 MB `tool_response` finishes within 100 ms.
- **FR7** `monitor-otel` accepts OTLP/HTTP JSON on `127.0.0.1:14318`; anything but `POST /v1/logs`
  gets 404. It keeps §10.1's allowlist and sums usage and tool calls per session per minute into
  `outbox/telemetry.jsonl`, writing a minute when it closes, or every 10 s while the `watching` flag
  that snapshots touch is under 30 s old. It starts detached (`setsid`, stdio closed) with a clean
  environment (`env -i PATH=… HOME=…`), so it outlives its session and holds no delivered secrets; a
  failed bind means one already runs. It exits after 15 minutes with no data and no `claude`
  process. It isn't a proxy.
- **FR8** Writers open with `O_APPEND`, write each line in one `write()` of at most 4 KB, and close
  (A4). Ingest validates each line against a strict schema (unknown fields dropped, strings capped,
  timestamps within 7 days), skips `id`s seen in 24 h, applies §6's caps, redacts (§15), and credits
  usage to `claudepilot.account` from each telemetry record's attributes, or to `acct`
  (`CLAUDEPILOT_ACCOUNT`) on hook lines.

### Agents and usage

- **FR9** One `agent_sessions` row per session ID, shared by hooks, telemetry (`session.id`), Chat
  sessions and `claude agents`. Kind: chat (in the Chat registry; `claude agents` lists it as
  `interactive` ✅), background, interactive, headless (`-p`, not chat) or unknown. A chat wake keeps
  the session ID and sets `CLAUDEPILOT_CHAT_WAKE=1`, so its `SessionStart` folds into the same row.
- **FR10** State follows §12. A turn is a `UserPromptSubmit` → `Stop` / `StopFailure` pair, or a chat
  result. RED metrics (rate, errors, duration): turns per minute, failed-turn rate, p50 and p95 turn
  duration, API errors.
- **FR11** Counts pick a source per metric. Tokens and cost: telemetry if the session sent any
  `api_request`, else the per-result deltas Chat hands over (never its cumulative totals). Turns and denials: hooks if the session sent
  any, else chat results. `agent_sessions` stores both choices (`usage_source`, `activity_source`);
  rollups and views read only those, so nothing counts twice.
- **FR12** Actions: Open chat or Open shell; Stop for background sessions (`claude stop <id>` by
  `exec`) and chat sessions (the chat service's `interrupt` or `end_session`), behind a
  ConfirmDialog. Interactive terminal sessions can't be stopped here.
- **FR13** Tokens come from telemetry `api_request` (uncached input, output, cache read, cache write,
  model), per minute and session, then hourly into Account Pool's `usage_rollups` from each
  session's `usage_source`. Session totals stay on `agent_sessions`.
- **FR14** Cost is Claude Code's `cost_usd_micros`, labelled "est." (list price unless Settings sets
  `modelPricing`; [costs](https://code.claude.com/docs/en/costs)). Custom hosts use the endpoint's
  price (Account Pool FR1), else "—: no price for this host". **Billed** appears only for accounts
  mapped one-to-one to an Anthropic workspace, as daily amounts, because the Admin
  [cost report](https://platform.claude.com/docs/en/api/beta/organization/cost_report/retrieve)
  groups by workspace, never by key. It needs an organization monitor and Account Pool's
  cost-report read (§19).
- **FR15** Usage views show coverage: the share of sessions that reported usage, and live sessions
  that don't (started before telemetry: "restart to include"; Activity mode).

### MCP

- **FR16** MCP calls per server and tool (calls, failures, p50 duration, last used) come from
  `PostToolUse` / `PostToolUseFailure` hooks on `mcp__.*`, which see real names; telemetry redacts
  them to `mcp_tool` 📄. Skill rows read the [Skillset pool](skillset-pool.md)'s records, read-only.
- **FR17** Connection status: chat sessions' `system/init`, and an on-demand "Check MCP servers"
  that runs `claude mcp list` by `exec` in each working directory of the workspace's live sessions
  (from hook lines, at most 5), else `/home/node`. It starts every stdio server, so it never runs on
  a timer, and the same run does MCP set's duplicate check: it takes the sets' URLs and package
  names on stdin, compares them inside the workspace with what `claude mcp list` prints, and returns
  only the names and scopes of matches ([MCP set](mcpset-pool.md) §10.6). Telemetry's `mcp_server_connection` adds unnamed failure counts, grouped by `is_plugin`
  and `plugin_id_hash`.
- **FR18** `managed_by` comes from the hook's `mcp_server.source` plus its name, never the name alone
  ([hooks](https://code.claude.com/docs/en/hooks)). Source `plugin` with a name delivered to that
  workspace (`plugin:cpm-<set>:<server>`), or source `managed` with a delivered `managedMcpServers`
  name (`cpm-<set>-<server>`, [MCP set](mcpset-pool.md) §10), maps to that set; `plugin:cpb-browser:*`
  maps to `managed_by: browser`. Anything else in use is **Unmanaged**: one
  security event per workspace and server per day. Names are untrusted text, escaped on display.
- **FR19** [Portal MCP](portal-mcp.md) clients: calls per tool per hour, errors, denials, p95
  duration and active connections, from its audit tables.

### Security

- **FR20** The Events tab lists §12 events and portal actions (deliveries, drift, assignments,
  failovers, setting changes, Monitor and Portal MCP actions, browser take-overs) with severity,
  actor, workspace and summary, under the saved filters All and Security. `monitor_events` holds only workspace-reported events and Monitoring's own actions; other
  owners' rows are read through one view (A7) and never copied, so each keeps its retention. Rows
  expand to redacted details, and the filtered range exports as CSV.
- **FR21** Bypass is detected three ways: `bypassPermissions` as a hook's `permission_mode`,
  `permission_mode_changed` to bypass, and Claude Code process args (`--dangerously-skip-permissions`,
  `--permission-mode bypassPermissions`). If Settings & policies Q22 finds that `--bare` skips
  managed settings, a nested `claude --bare` process is a High event too.
- **FR22** Posture per control (default mode, auto mode, bypass, sandbox, managed-only rules and
  hooks) with its enforcement state and the controls not met (Settings FR17), user or project hooks seen (`hook_registered`),
  and Settings' limit signals: budgets by state, cap refusals per hour, sessions stopped by budget or
  turns.
- **FR23** Detailed events (a Settings row, off by default, scopes Global and workspace) add the first
  200 characters of a requested or denied Bash command or file path, redacted. Off while Locked.
- **FR24** Secret-path deny hits: each delivered deny rule under `//etc/claudepilot/`,
  `//etc/claude-code/`, `//home/node/.claudepilot/` or `//proc/**/environ` gets an async
  `PreToolUse` handler with `if` set to the rule; `PreToolUse` runs before deny rules apply 📄
  ([permissions](https://code.claude.com/docs/en/permissions)). `monitor-event` re-checks before
  recording (`tool_input.file_path` under the prefix for Read, Edit and Write; the prefix inside a
  Bash command), because `if` runs the hook whenever Claude Code can't parse a command 📄. It records
  the rule's text, never the path. High for Read, Edit and Write; Medium for Bash until Q8. A hit on
  the outbox rule is Monitoring-data tampering.
- **FR30** Sandbox escapes: an async `PreToolUse` handler on Bash with
  `if: "Bash(dangerouslyDisableSandbox:true)"` records every unsandboxed retry. The form is
  documented for ask rules ([sandboxing](https://code.claude.com/docs/en/sandboxing)); for `if` it's
  🔬 Q8. A retry under a matching allow rule or in `bypassPermissions` runs with no prompt 📄, the
  riskiest case. A `PermissionRequest` in the same session with that input marks the retry prompted.

### Accounts and read model

- **FR25** Accounts tab: a read-only view of [Account Pool](account-pool.md) health, headroom per
  model group with "as of", UTC-month spend against budget, 24 h errors by category, failovers and
  workspaces waiting for quota, with the Settings rotation threshold as a tick on the Meter.
- **FR26** Every number in a Monitor API response is a `Metric`: `{ value: number | null, unit,
  quality: 'measured' | 'estimated' | 'billed' | 'unknown', source, asOf, reason? }`. `null` renders
  "—" with its reason, never 0.
- **FR27** `/api/monitor` serves `overview`, `workspaces`, `workspaces/:target/:name`,
  `…/processes`, `agents`, `agents/:id`, `events` (saved filter `all` or `security`), `events.csv`
  and `accounts` behind the
  session and CSRF guards; the browser polls every 10 s while visible. A Monitor request marks the
  portal "watching" for 30 s, which subscribes every running workspace to the foundation's 10 s
  pull. That pull is one `exec` that also runs `monitor-snapshot` (A5): it touches the `watching`
  flag, starts the receiver in Full mode if it's down, reads `oom_kill` and disk, and lists agents
  when FR4 asks.
  An open Processes section adds one `exec` every 5 s.
- **FR28** Attention items, on the Overview and as a dot on the Monitor nav item: needs input over 2
  minutes with no later signal from that session; a failed turn in 15 minutes; a workspace error, an
  OOM kill or 3 restarts in 15 minutes; memory over 90% of its limit for 5 minutes; disk under 5% free
  (a shared host disk raises one item per Docker target or Kubernetes node); bypass where policy
  disables it; an account invalid, billing, exhausted or under threshold; an MCP server failing in a
  live session; the receiver down for over 1 minute while a session is Working in Full mode; hooks
  erroring; lines dropped or quarantined. Pools and Settings add theirs through one interface
  (`severity`, `summary`, `workspace_id`, `since`, `link`): failed or drifted deliveries, secrets
  expiring within 14 days, servers needing sign-in, revoked skills still present, "Budget reached",
  "Cap refused 4×/h", a waiting browser handoff, a browser error. Every item also carries a
  notification kind ([Web app & PWA](web-app-pwa.md) §11.1) and a stable tag, and badges one
  destination: chat requests badge Sessions, health items Monitor only (its FR6).
- **FR29** Workspaces page rows gain an agents chip ("2 working · 1 needs input") and 24 h tokens,
  linking to the workspace's Sessions tab.

## 9. Data model

In the portal database ([foundation](foundation-pools.md) §4). Monitoring holds no secrets. While
the portal is Locked, pulls and snapshots continue (foundation §6.5), redaction drops free text
(§15), and FR23 is off.

| Table | Key fields |
| --- | --- |
| `workspace_monitor` | instance_id, workspace_id (`target/name`), receiver_state, receiver_error, last_hook_at, last_telemetry_at, dropped_lines, quarantined_lines, restarts, oom_kills, oom_count_seen, disk_free_bytes, disk_total_bytes, disk_scope (`workspace` \| `host`), removed_at |
| `resource_samples` | instance_id, bucket_start, resolution (`1m` \| `1h`), cpu_avg, cpu_max, mem_avg, mem_max, cpu_limit, mem_limit |
| `agent_sessions` | session_id, instance_id, agent_view_id, kind, state, state_since, waiting_for, title, cwd, model, permission_mode, bypass_seen, account_id, usage_source, activity_source, uncached_in, cache_read, cache_write, output, cost_est_micros, turns, failed_turns, started_at, ended_at, end_reason, last_signal_at |
| `agent_turns` | session_id, started_at, ended_at, outcome (`ok` \| `failed` \| `interrupted`), error_category |
| `usage_minutes` | minute, instance_id, session_id, model, account_id, requests, uncached_in, cache_read, cache_write, output, cost_est_micros, api_errors, source (`telemetry` \| `chat`; chat rows come from Chat sessions §9) |
| `usage_rollups` | Account Pool's table. Monitoring writes hourly rows from each session's `usage_source` (§19). |
| `tool_minutes`, `tool_daily` | bucket, instance_id, session_id (minutes only), tool, mcp_server, calls, failures, duration_hist (12 log-scale buckets, for p50 and p95) |
| `mcp_status` | instance_id, server, source, scope, transport, status, error_code, managed_by (MCP set, pool or null), observed_at, observed_by |
| `monitor_events` | id, at, instance_id, session_id, kind (`security` \| `agent` \| `mcp` \| `resource` \| `pipeline`), type, severity, actor, summary, details (json, redacted), source |

Monitoring's settings (mode, detailed events) are Settings & policies rows, resolved Global →
policy → workspace with source badges and audited there (its FR16).

## 10. Delivery into Claude Code

Monitoring is a portal feature, not a pool. The foundation compiles its system fragment per
workspace and delivers it on all three targets like any pool's (§19 A1, A2); its scripts ship in the
foundation bundle. The outbox is the foundation's, on the home volume (foundation §8), so lines not
yet pulled survive container restarts and pod deletion. Only Remove loses them, so Remove pulls
first (A5).

### 10.1 What gets written

| Path in the workspace | Content |
| --- | --- |
| `/etc/claude-code/managed-settings.d/80-claudepilot-monitor.json` | Full: `env` and `hooks` (below). Activity: the same `hooks` without `--receiver`, no `env`. Off: `{}`. |
| `/etc/claudepilot/bin/monitor-event`, `monitor-otel`, `monitor-snapshot` | Hook script (POSIX `sh` and `jq`, FR6); receiver (one Node file, no dependencies, FR7); the snapshot step of the pull `exec`, plus `--ps` (FR3, FR27). |
| `~/.claudepilot/outbox/monitor.jsonl`, `telemetry.jsonl` | Outbox files owned by the workspace user ([foundation](foundation-pools.md) §8). |
| `~/.claudepilot/monitor/` | Receiver pid, `status.json` (started, last data, dropped lines, last error), `watching` flag. |

The Full-mode drop-in, hooks abbreviated:

```json
{ "env": { "CLAUDE_CODE_ENABLE_TELEMETRY": "1", "OTEL_LOGS_EXPORTER": "otlp",
           "OTEL_METRICS_EXPORTER": "none", "OTEL_TRACES_EXPORTER": "none",
           "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json", "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:14318",
           "OTEL_LOGS_EXPORT_INTERVAL": "5000", "OTEL_RESOURCE_ATTRIBUTES": "claudepilot.account=<account-id>",
           "OTEL_LOG_USER_PROMPTS": "0", "OTEL_LOG_ASSISTANT_RESPONSES": "0", "OTEL_LOG_TOOL_DETAILS": "0",
           "OTEL_LOG_TOOL_CONTENT": "0", "OTEL_LOG_RAW_API_BODIES": "0" },
  "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "async": true,
                                            "command": "/etc/claudepilot/bin/monitor-event --receiver" }] }],
             "Stop": [{ "hooks": [{ "type": "command", "timeout": 5, "command": "/etc/claudepilot/bin/monitor-event" }] }] } }
```

A managed OTLP endpoint removes developer-set endpoints at startup 📄, and the content flags stay off
whatever the shell exports. Every hook is a `command` hook running `monitor-event`; async ones never
delay Claude. `Stop`, `StopFailure` and `SessionEnd` run synchronously after the turn, with
`"timeout": 5`, because `-p` runs kill async hooks still running at teardown 📄
([hooks](https://code.claude.com/docs/en/hooks)).

| Hook (matcher) | Copied besides the common fields | Used for |
| --- | --- | --- |
| `SessionStart`, `UserPromptSubmit` (async) | `source`, `model`, `session_title` (80 characters) on start; never `prompt` | Session and turn start; start the receiver |
| `Stop`, `StopFailure` (all categories), `SessionEnd` | `error`; `reason`; never `last_assistant_message` | Turn end (Idle or Failed); session end |
| `SubagentStart`, `SubagentStop` (async) | `agent_id`, `agent_type` | Running subagents |
| `PermissionRequest`; `Notification` (`permission_prompt\|elicitation_dialog\|elicitation_url_dialog`), async | `tool_name`, `mcp_server`, `sandbox_escape` when the input sets `dangerouslyDisableSandbox`; `notification_type` | Needs input. `Notification` also covers sandbox network prompts, which skip `PermissionRequest`, but only after about 6 s without typing 📄. Prompted escapes. |
| `PermissionDenied` (async) | `tool_name`; `reason` only when it's a bracketed category such as `[Data Exfiltration]` | Auto-mode denials |
| `PreToolUse` (`Bash`, `if: "Bash(dangerouslyDisableSandbox:true)"`, async) | `tool_name`, `sandbox_escape: true` | Every unsandboxed retry (FR30) |
| `PreToolUse` (`Read\|Edit\|Write\|Bash`, one handler per protected deny rule, `if` = the rule, async) | `tool_name`, `rule` (its text), after the re-check | Secret-path deny hits (FR24) |
| `PostToolUse`, `PostToolUseFailure` (`mcp__.*`, async) | `tool_name`, `mcp_server` (`name`, `source`), `duration_ms`, `is_interrupt` | MCP usage |
| `ConfigChange`, `PostModelSwitch` (async) | `source`, `file_path`, the file's SHA-256 for `policy_settings`; `to_model` | Tampering; current model |

Common fields on every line: `id` (nanosecond time and pid), `t`, `ev`, `session_id`, `prompt_id`,
`cwd` (200 characters), `permission_mode`, `effort.level`, `agent_id` and `agent_type` when present,
`acct` from `CLAUDEPILOT_ACCOUNT`, and `truncated`. Skill usage stays with the Skillset pool's hook.

| Telemetry event | Kept | Written as |
| --- | --- | --- |
| `api_request` | `model`, input, output, cache read and cache creation tokens, `cost_usd_micros`, `duration_ms` | Usage line per session, model and minute |
| `api_error`, `api_retries_exhausted` | `model`, `status_code`, `attempt` or `total_attempts`, `total_retry_duration_ms`, `error` (160 characters, redacted at ingest) | Event line |
| `tool_result` | `tool_name`, `success`, `duration_ms` | Tool line per minute |
| `tool_decision` | `tool_name`, `decision`, `source` | Accepts counted per minute; rejects as event lines |
| `permission_mode_changed` | `from_mode`, `to_mode`, `trigger` | Event line |
| `mcp_server_connection` | `status`, `transport_type`, `server_scope`, `error_code`, `is_plugin`, `plugin_id_hash` | Event line, without the server name (FR17) |
| `hook_registered`, `hook_execution_complete`, `managed_settings_resolved` | `hook_event`, `hook_source`, `num_blocking` and `num_non_blocking_error` when above 0; `trigger`, `sources` (sent without opt-in ✅) | Posture, pipeline, "settings loaded" and source checks |
| Everything else (`user_prompt`, `assistant_response`, `api_request_body`, `auth`, …) and attributes other than `session.id`, `service.version` and `claudepilot.*` | Nothing | Dropped |

The receiver reads `claudepilot.account` from each log record's attributes, never from the OTLP
resource: after a mid-session change the resource keeps its startup value while records carry the
new one ✅ (E7). The value is the account ID, percent-encoded, because the variable allows no
spaces, commas or quotes 📄 ([monitoring](https://code.claude.com/docs/en/monitoring-usage)).

### 10.2 What applies when

| Change | Running sessions | New sessions |
| --- | --- | --- |
| Hooks added, changed or removed | At once: settings files are watched and reloaded ([settings](https://code.claude.com/docs/en/settings#when-edits-take-effect)) | Yes |
| Telemetry turned on, endpoint or interval changed | No: exporter configuration is read at launch ([server-managed settings](https://code.claude.com/docs/en/server-managed-settings#fetch-and-caching-behavior)) | Yes |
| `claudepilot.account` changed by a failover | ✅ New records carry the new account (E7); the `80-` drop-in follows the `40-` one in the same reconcile (A2) | Yes |
| Telemetry turned off | Sessions that started with it keep exporting until they exit; the portal drops their lines | No telemetry |
| Scripts updated | Next run; the portal restarts the receiver when its hash changes (🔬 Q1: exports during the restart) | Yes |

After a mode change, the dialog says what waits: "Hooks apply now. Telemetry starts with new
sessions; 2 running sessions won't report usage until they're restarted." A drop-in created
mid-session loads only if its folder existed at session start, so the foundation creates
`managed-settings.d` up front (foundation §9).

### 10.3 Claude Code versions

Docker workspaces keep the image they were created from, while the weekly GHCR rebuild moves the
pinned version. The compiler leaves out hook entries a workspace's version lacks (foundation §9),
and panels read `workspace_delivery.claude_version` to show "Needs Claude Code ≥ X".

| Source | Needs | If older |
| --- | --- | --- |
| `claude agents --json` with `id`, `state` and `--all` | 2.1.169 📄 | Agents from hooks and processes only |
| Sandbox, MCP-input and managed-settings waits reported as Needs input by `claude agents` | 2.1.212 📄 | Those waits read Working |
| `permission_prompt` notification for sandbox network requests | 2.1.246 📄 | Those prompts don't set Needs input from hooks |
| `PostModelSwitch` | 2.1.251 📄 | The model updates at the next `api_request` (Full) or not at all |
| `mcp_server` object in tool hooks | 2.1.274 📄 | MCP calls recorded by name only and marked "Unverified", never Unmanaged |
| `managed_settings_resolved` | 2.1.274 📄 | No "settings loaded" or source check |
| `PermissionDenied`, `session_title`, hook `if` | Documented, minimum unknown 🔬 (`if` on file paths fixed in 2.1.176 📄) | Left out below 2.1.296, the only version tested |

## 11. Signals and inputs

### 11.1 Measured or estimated

| Shown | Source | Quality | Fresh within |
| --- | --- | --- | --- |
| Status, CPU, memory, restarts | Runtime list; Docker `stats`; `metrics.k8s.io` | Measured (Kubernetes: metrics-server's window) | 10 s while watching, else 30 s |
| OOM kills | Docker `oom` events; cgroup `oom_kill` count; pod `lastState` | Measured; a time range when only the count rose | Seconds; else the next snapshot |
| Processes, per-process CPU and memory | `/proc` through `exec` | Measured, live only; CPU in 10 ms ticks | 5 s on the Processes section |
| Disk free | `df` of the filesystem behind `/home/node` | Measured. Docker volumes and local-path PVCs report the shared host disk, labelled "Host disk (shared)"; per workspace only when `df`'s total is within 5% of the PVC's requested size | Each snapshot |
| Live sessions, state, turns, turn duration | Chat controller, `claude agents --json`, hooks, processes | Measured; Unknown when only a process is seen | 20 s while watching, else the 60 s pull |
| Tokens | `api_request`; chat `modelUsage` | Measured by Claude Code from each API response | Up to 1 minute plus the pull; 10 s while watched |
| Cost | Claude Code's estimate; Admin cost report via Account Pool | Estimated; Billed (daily, accounts with their own Anthropic workspace) | As tokens; daily |
| API errors | `api_error` after retries; `StopFailure` | Measured. Intermediate retries aren't reported; `attempt` undercounts 401 retries (2 for 4 requests), and a 529 has no `status_code` ✅ (E7) | The pull |
| Tool and MCP calls, durations | `tool_result` (MCP shows as `mcp_tool`); MCP hooks with real names | Measured; p50 and p95 from log-scale buckets; no duration on truncated lines | The pull |
| MCP connection status | Chat `system/init`, on-demand check, unnamed `mcp_server_connection` | Measured when checked or connected | On demand |
| Denials, mode changes, bypass | `tool_decision`, `permission_mode_changed`, hooks, process args, chat `permission_denials` | Measured | The pull, or snapshots |
| Headroom, health, spend against budget | Account Pool probes and classification; telemetry or Admin API spend | Measured at probe time (rounded to 1,000 tokens); spend Estimated or Billed | Probe interval |

### 11.2 Inputs from other features

| From | What Monitoring reads | Through |
| --- | --- | --- |
| [Chat sessions](chat-sessions.md) | Per session: `session_id`, workspace, state (its FR3: Starting, Working, Needs input, Failed, Idle, Interrupted, Ended), `waiting_for`, model, mode; MCP servers and status from each `system/init`; per-result usage deltas (never cumulative totals), `permission_denials` and `is_error`, as `usage_minutes` rows with source `chat`. Stop calls `interrupt` or `end_session`. | The chat controller, in process |
| [Account Pool](account-pool.md) | Health, headroom with "as of", error tags, failovers and switch times, workspaces waiting for quota, `usage_rollups`, daily billed cost per Anthropic workspace (§19) | Its service |
| [Settings & policies](settings-policies.md) | Effective monitoring rows with sources; posture and enforcement (its FR17); budgets by state, cap refusals per hour, sessions stopped by budget or turns (its §17) | Its service |
| [Skillset](skillset-pool.md), [MCP set](mcpset-pool.md), [Browser & desktop](browser-desktop-pool.md) | Skill-usage records; server names delivered to each workspace (FR18); browser state, handoffs, take-overs and security events (its §16) | Their services, the compiler |
| [Persona](persona-pool.md) | Its §17 metrics: workspaces per persona, recent sessions on an older revision (from the foundation's session reporter), synced but not loaded, delivery failures, test-run spend per day | Its service |
| [Portal MCP](portal-mcp.md) | `mcp_audit`, `mcp_auth_events` | The event view (A7) |
| Every pool | Attention items (FR28) | One interface |

Until Chat sessions ships its feed (its C3), chat sessions still appear through hooks and telemetry:
they run the unmodified CLI, which loads managed settings.

## 12. Session states and security events

| Session state | Entered on |
| --- | --- |
| Starting; Interrupted | Chat sessions only (Chat sessions FR3) |
| Working | `UserPromptSubmit`, `SubagentStart`; agents `status: busy` or `state: working`; chat Working |
| Needs input | `PermissionRequest`, `Notification`; agents `status: waiting` or `state: blocked`; chat Needs input. Clears on any later line from that session (a hook, a telemetry `tool_decision` or `tool_result`) or agents `busy`. In `dontAsk` mode and in headless sessions other than chat, a `PermissionRequest` is an auto-denial 📄 and counts as a denial instead. |
| Failed | `StopFailure`, until the next prompt; agents `state: failed`; chat Failed |
| Idle | `Stop`; agents `status: idle`, or `state: done` with its process gone (parked by the supervisor); chat Idle |
| Ended | `SessionEnd`; agents `state: stopped` (reason `stopped`); gone from agents and processes; Remove (reason `removed`); 6 h without any signal |
| Offline; Unknown | The workspace is stopped or unreachable; a Claude Code process with no other data |

For kind `chat`, the chat registry's state wins whatever its age: a chat process that has gone is
Interrupted, or Idle while asleep, never Ended. For other kinds the freshest signal wins; on a tie, agents beat
hooks.

| Security event | Signal | Severity |
| --- | --- | --- |
| Bypass active | FR21 | High where the workspace's policy disables bypass; otherwise Medium |
| Mode escalation | A transition: `permission_mode_changed`, or a session's first line in a mode above its start mode (plan, default or dontAsk, acceptEdits, auto, bypassPermissions). The start mode is the policy's "Starts in"; with no policy delivered, Claude Code's built-in one (auto for interactive sessions from 2.1.283 📄, default otherwise). Once per session and mode. | Medium |
| Denied by auto mode | `PermissionDenied`, with its category | Medium |
| Other denials | `tool_decision` rejects by source (`config`, `hook`, `user_reject`, `user_abort`); auto-denied `PermissionRequest`s; `hook_execution_complete` with `num_blocking`; chat `permission_denials` | Info, counted; Medium when a hook blocks |
| Secret-path deny hit | FR24. `@` file references are blocked by Read deny rules but never seen: they add content without a tool call 📄. | High; Medium for Bash until Q8 |
| Sandbox escape | FR30, with prompted yes or no | Medium; High when it ran without a prompt |
| Sandbox violation | 🔬 Reported only inside the Bash tool result; no hook or telemetry event (Q6) | Medium |
| Settings tampering | `ConfigChange` from `policy_settings` whose file hash matches none the portal wrote for that path in the last 24 h, or foundation drift: High. User or project settings changed: Info. One event per workspace, file and hash. | High or Info |
| Unmanaged MCP server | FR18, once per workspace and server per day | Medium |
| Portal MCP | Repeated wrong codes, refresh-token reuse, rejected origins, refused relaxations; a lockdown (Portal MCP audit, through the view) | Medium; High for a lockdown |
| Portal connector used in a workspace | A portal tool called through a claude.ai connector (`mcp__claude_ai_<name>__<portal tool>`) in FR16's tool names ([Portal MCP](portal-mcp.md) §10.1) | High |
| Browser | An exposed listener; a browser without its sandbox or network isolation; Chromium over 21 days behind; a take-over; loopback requests refused for their Origin or Host ([Browser & desktop](browser-desktop-pool.md) §16) | High for an exposed listener; Info for a take-over; else Medium |

## 13. Retention and aggregation

| Data | Resolution | Kept (defaults) |
| --- | --- | --- |
| CPU and memory | 1 min average and max / 1 h average and max | 48 h / 30 days |
| Tokens and cost | 1 min per session and model / 1 h per workspace, account and model (`usage_rollups`) / session totals | 48 h / 13 months / 90 days after the session ends |
| Tool and MCP calls | 1 min per session and tool / 1 day per workspace and tool | 48 h / 90 days |
| Sessions; turns | One row each | 90 days after they end; 30 days |
| Monitoring's events: security; other | One row each | 90 days; 30 days |
| Processes and snapshots | Live only | Not stored |

Other owners' events keep their own retention (FR20). Retention is edited with the rest in
[Settings & policies](settings-policies.md) §11.4, and the shared daily job at 03:00 UTC prunes.
Charts pick their resolution from the range: 1h → 1 min, 24h → 5 min, 7d → 1 h, 30d → 4 h. Buckets
are UTC and the browser shows local time. "This month" is the UTC month, like Anthropic's spend
caps. The tables stay under 250 MB for 20 workspaces over 13 months.

## 14. User experience

Screens use existing components (PageHeader, PageTabs, Section, Card, StatGrid and StatTile, Badge,
Menu, Segmented, ChipGroup, Select, Dialog, FormDialog, ConfirmDialog, EmptyState, LoadError,
RowsSkeleton, Spinner) and the app's Meter, moved to `components/`. Four shared additions, built once
in Web app W1 for Chat sessions and Monitor: **StatusDot**, **Sparkline** (inline SVG, about 80×20, labels its
last value), **TrendChart** (pay's LineChart generalized: one or two series, a limit line,
scrubbing, never stacked) and **FreshnessLabel**. No chart library.

**Layout.** Navigation is the Web app's (its §8): the phone tab bar is Sessions · Workspaces ·
**Monitor** · Pools · Menu, and Settings and Access are destinations of their own. Monitor
(`Activity` icon) lives at `/admin/monitor` with tabs **Overview · Workspaces · Agents · Events ·
Accounts** (PageTabs, `stack="never"`, `?tab=`), a `wide` route (Web app §9.2). One workspace's
monitoring lives on the shared workspace page, `/admin/workspaces/:target/:name?tab=`, in its
**Overview**, **Sessions** and **Activity** tabs beside **Configuration** (A8). Every tab opens with
a **health line** (the highest-attention StatusDot and one sentence: "2 sessions need input · 1
workspace error", or "All quiet") and a FreshnessLabel ("Updated 8 s ago"). A range Segmented (1h ·
24h · 7d · 30d) appears only on Overview, Events and the workspace page's charts; Workspaces shows
live values and Accounts the UTC month. The ⋯
Menu opens **Monitoring settings**: the Settings rows with source badges, line counts (ingested,
rejected, quarantined, dropped) and database size.

**Density.** Rows follow the theme density (`comfortable` or `compact` in `@isnanme/ui`), and
AccountMenu gains the choice. Phone targets stay 44 px; numbers use tabular figures; no view has
more than six blocks. Phones get one column, two-line rows, 140 px charts, tiles 2×2 and no
horizontal scroll. Nothing hides behind hover: tapping a tile opens a sheet with breakdown and source.

| Look (design tokens only, always with a text label) | Sessions | Workspaces, delivery, MCP, accounts | Security |
| --- | --- | --- | --- |
| Accent dot, soft pulse while working (static with reduced motion) | Working | Running, Synced, Connected, Healthy | |
| Spinner | Starting | Creating, Starting, Stopping | |
| Gold ring with "!"; `warning` Badge | Needs input | Pending, Drifted, Cooling, Needs attention, Model unavailable, near a threshold | Medium |
| Gold pause glyph; `warning` Badge | Interrupted (resumable) | | |
| Hand icon on the accent ring | | In control (a person holds a browser) | |
| Danger ✕; `danger` Badge | Failed | Error, Failed, Invalid, Billing, Exhausted | High |
| Muted hollow dot; `neutral` Badge | Idle, Ended | Stopped, Disconnected | Info |
| Muted dashed ring; muted "—" with the reason | Offline; Unknown | Locked, Frozen, target unavailable; Unknown | |

Gold and flame appear only in icons, badges and large text (about 3:1 contrast in light mode). The
shared **Meter** shows the share used: accent below 75%, gold from 75% to 90%, danger above 90%, with
an optional threshold tick such as the rotation point. Headroom renders as used = 1 − headroom, so
the Accounts page and Monitor agree; the Workspaces page meters gain the gold band. Lists sort by
attention (Needs input, Failed and Interrupted, Working, Idle, Ended). Bypass shows a danger Badge "Bypass".

**Overview**, top to bottom, the same order on phones:
1. StatGrid of four: **Running agents** (Working plus Needs input; "+5 subagents · 3 idle"),
   **Workspaces** ("7 of 9 running"; "1 error"), **Tokens** (Sparkline; the hint splits input, output
   and cache) and **Cost** ("est. $12.40" with Sparkline; "of $50 budget" when one is set).
2. **Needs attention**: up to 8 FR28 items (what, where, for how long) linking to the fix.
3. **Usage trend**: TrendChart with a Tokens | Cost Segmented and the budget line.
4. **Agents**: Sparkline rows for turns per minute, failed turns, turn duration p50 and p95, errors.
5. **Top consumers**: Workspace | Model | Session | Account; top 5 by tokens, share and est. cost
   (sessions ranked by their session totals).

**Workspaces.** One row per workspace: StatusDot and name, target, CPU Meter (% of limit, or cores
when unlimited) with a 1 h Sparkline, memory Meter, agents, tokens, MCP ("4 ok · 1 failed"), last
activity; sorted by attention, then CPU; filter All · Running · Attention · Stopped. Phone rows:
name, status and agents, then "CPU 34% · 1.2/4 GB · 120k tokens". Rows open the workspace page.

**Workspace page.** The header (name, status, target, Shell, Chat; ⋯ Menu with Check MCP servers
and Monitoring for this workspace) is shared by all four tabs (Web app §8). Monitoring fills three:

1. **Overview:** first a **Data sources** line ("Hooks ✓ · Telemetry: 2 sessions to restart") that
   opens a sheet with hooks, receiver, last data, coverage, sessions to restart, snapshot, drops,
   quarantined lines and Claude Code version. It names why data is missing: "Needs Enable pools",
   "Delivery failed", "Delivery locked", "No exec on this target", "Needs Claude Code ≥ X".
   Telemetry without hooks, or `managed_settings_resolved` listing `remote` before `file`, reads
   "Overridden by organization policy: this login's organization delivers its own managed settings"
   (Settings & policies FR17), worked out without reading login state. A `claude` process with no
   hook line for 10 minutes reads "No hook signals: an organization's managed settings, or a
   `--bare` session (Q4)". Then **Resources:** CPU and memory charts with the limit line, restarts,
   OOM kills with their times, disk ("Host disk (shared)" where it applies), and the browser
   container's own row.
2. **Sessions:** this workspace's sessions, chat and terminal, with tokens by model, est. cost and
   turns; supervisor state.
3. **Activity:** **Processes** (every 5 s, with Pause: a tree of PID, CPU %, memory, running for,
   redacted command; Claude Code rows show their session, MCP servers their set; no kill; phone rows
   put the command, truncated in the middle, over "CPU 12% · 340 MB · 2h", indent capped at 3
   levels), **MCP & tools** (servers with owner, status, calls, failures and p50; tools; skills) and
   **Events** (this workspace's feed).

Desktop uses two columns from 1280 px. Phones stack each tab's blocks as collapsible Sections with a
one-line summary each ("CPU 34% · 1.2/4 GB · 0 OOM"), the first open.

**Agents.** Groups in attention order, folding past 10 rows into "… N more"; filter Needs input ·
Working · Failed · Bypass · All. Row: StatusDot, title, kind icon, workspace chip, model, mode Badge,
time in state ("Needs input · Bash · 4m"), subagents, tokens, est. cost. Phones show a two-line Card
whose subagents expand as indented rows. Chat sessions open in Sessions; others open a detail (a
pushed screen on phones, Web app §9.4) with a recent timeline, tokens by model, MCP calls, denials,
and Open shell or Stop.

**Events.** The event log (A7) with saved filters **All** and **Security** (Web app §8). Security
puts a StatGrid (Bypass active, danger above 0; Denials; Mode escalations; Tamper signals) and a
Policy card (one line per FR22 control with its enforcement state, a limits line such as "Budgets: 1
reached · 2 warn · Cap refused 4×/h", "Edit in Settings") above the feed, and a Portal MCP card
(calls per hour, errors, active connections) below it. The feed: severity icon, time, workspace,
actor (the device name for UI actions), summary; filter chips Permissions · Modes · Sandbox ·
Secrets · MCP · Settings · Portal · Browser; 50 rows per page; Export CSV; phone rows put icon and
summary over "workspace · actor · 14:02".

**Accounts.** The Accounts page's account row, read-only, riskiest first: headroom per model group on
the shared Meter with the threshold tick and "as of HH:MM", month spend against budget, 24 h error
tags (429 ×3, AUTH ×1); then the last 20 failovers. Without accounts: EmptyState, "Add an account".

**States.** Loading: StatTile skeletons for undefined values, RowsSkeleton, skeleton bands for
charts. Empty: EmptyState with the meaning and next step ("Telemetry is off here", Turn on). First
load fails: LoadError with Retry. A refresh fails: keep the data, show "Couldn't refresh · Retry".
Stale (over twice the interval): values dim, "Stale · 3 min". Unknown: "—" with a reason. Workspace
stopped: last known values, "Stopped · as of 14:02".

**Performance.** The route is code-split. Overview is one request under 50 KB, answered from rollups
in under 150 ms at p95 for 20 workspaces. Polling stops in hidden tabs. Every tap answers in 100 ms.

## 15. Security requirements

- **No content** (§6), enforced by the hook script, the receiver and the ingest schema. A canary
  test runs sessions with marker strings in prompts, tool input, tool output and environment
  variables, and checks that none reach outbox files, the database, API responses or logs.
- **Redaction at ingest**, with the shared value redactor (Secrets & env A9): free text (errors,
  detailed events, process args) is scrubbed of the secret values delivered to that workspace (decrypted in memory only to match, skipping values
  under 8 characters) and of credential shapes (`sk-ant-…`, `ghp_…`, `github_pat_…`, `AKIA…`,
  `xox?-…`, `Bearer …`, `password=…`, `token=…`). While Locked, free text is dropped and only
  categories are stored.
- **Processes**: command lines are redacted, cut to 300 characters, never stored or logged; process
  environments never leave the workspace: the snapshot reads only the non-secret
  `CLAUDEPILOT_MCP_SERVER` marker from them (FR3).
- **Receiver**: binds `127.0.0.1`, accepts bodies up to 1 MB, answers 404 to anything but
  `POST /v1/logs`, runs as the workspace user with a clean environment, writes only its outbox and
  status.
- **Hashes**: `ConfigChange` file hashes are compared at ingest and dropped; events keep the verdict.
- **Untrusted input**: strict schema, capped lengths, enums, clamped timestamps and §6's caps; text
  renders through React only, with server and session names escaped; CSV cells starting with `=`,
  `+`, `-`, `@`, tab or CR get a leading quote.
- **Identity**: Monitoring never reads `~/.claude`, login state, the status line or `/usage`.
- **Access**: the existing session cookie and CSRF checks. With one shared code, everyone signed in
  sees everything here, which is no more than a workspace shell shows. Logs carry counts, not lines.

## 16. Observability and audit

- Pipeline health per workspace (Data sources) and in the attention list: receiver down while a
  session works, hooks erroring (`num_non_blocking_error`), outbox drops, failing snapshots, ingest
  rejects and quarantines, with totals and database size in Monitoring settings.
- Settings audits changes to the monitoring rows (its FR16). Stops, MCP checks and CSV exports go to
  the event log with actor and time.
- Monitoring serves usage to Settings budgets and Account Pool, MCP data to MCP sets, the overview
  to Portal MCP, and mode, bypass and tampering signals to Settings.

## 17. Rollout and milestones

| Milestone | Scope | Gate |
| --- | --- | --- |
| D1 | Monitor page and tabs, health line, Meter bands, Monitoring's blocks in the workspace page's Overview, Sessions and Activity tabs (frames and shared components from Web app W1); sampler with history, restarts and Docker `oom` events; Workspaces tab and Resources | Foundation F1; Web app W1 |
| D2 | Snapshots as inline `exec` commands, with no delivered script: `/proc` processes, `df`, `oom_kill`, `claude agents --json --all`; Agents tab from snapshots | Q3 |
| D3 | Drop-in with hooks, `monitor-event`, `monitor-snapshot` (replacing D2's inline commands), ingest; sessions, turns, RED, MCP calls, Events tab with its Security filter, attention items, Workspaces page chips | Foundation F2 and F4; Settings S2 (monitoring rows, Policy card); Q2; Q8 for FR30 |
| D4 | Receiver and telemetry `env`: tokens and cost, tool stats, denials and mode changes, coverage, hourly `usage_rollups` | Q1; Account Pool M5, or D4 creates `usage_rollups` in the amended shape (§19) |
| D5 | Chat-session state and usage; Accounts tab; billed spend; Portal MCP card | Chat sessions C3; Account Pool M5 with the cost-report read; Q13; Portal MCP MCP5 |
| D6 | Kubernetes delivery of the drop-in; Kubernetes OOM signals | Foundation F3; Q14 |
| Later | Metrics exporter (lines changed, commits, PRs, active time), latency (`ttft_ms`), process actions. Push for attention items ships in Web app W5. | Q10 |

**Existing workspaces.** Monitoring turns on at upgrade in each workspace's effective mode (FR5),
paced by the foundation's rollout control. Unlike Settings' first policy (its FR5), it changes
nothing a user or Claude sees: hooks print nothing and never block, and telemetry goes to a loopback
receiver. Workspaces without delivery (Kubernetes before "Enable pools", delivery Failed, Locked or
Frozen, the Kubernetes fallback without `exec`) show runtime data, plus snapshots where `exec`
works, and Data sources names the reason. While Locked or Frozen, drop-in changes wait like every
other file (foundation §6.5).

## 18. Success metrics

| Metric | Target |
| --- | --- |
| Overview first data, mid-range phone over Wi-Fi | p75 under 1.5 s |
| Age of live session state while Monitor is open | p95 under 20 s |
| Sessions started with telemetry on that report usage | ≥ 95% |
| Daily telemetry tokens against the Admin usage report on pool keys, excluding probe traffic and sessions that predate telemetry | Within ±3% |
| Canary prompt, tool-output and secret strings anywhere the portal stores or serves | Zero, by automated test |
| Lines lost with `monitor-otel` under load and 10 s pulls for 10 minutes | Zero missing ids |
| Turn-end latency added by synchronous hooks | At most 50 ms at p95 |
| Receiver footprint | Under 64 MB RSS and 1% of a core |
| Tamper or Unmanaged events caused by the portal's own writes or delivered servers | Zero in the integration suite |
| Monitoring tables, 20 workspaces over 13 months | Under 250 MB |

## 19. Amendments to Pools foundation

Foundation v0.6 already keeps the outbox on the home volume, seals files by rename and pulls before
every stop. Monitoring still needs:

- **A1 Ownership row (§7).** Add Monitoring, a system fragment:
  `managed-settings.d/80-claudepilot-monitor.json` with `hooks.*` entries running `monitor-event`
  and, in Full mode only, the `env` keys `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_LOGS_EXPORTER`,
  `OTEL_METRICS_EXPORTER`, `OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL`,
  `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_LOGS_EXPORT_INTERVAL`, `OTEL_RESOURCE_ATTRIBUTES` and
  `OTEL_LOG_*`; `~/.claudepilot/monitor/**`; the outbox types `monitor` and `telemetry`.
  `monitor-event`, `monitor-otel` and `monitor-snapshot` ship in the foundation bundle under
  `/etc/claudepilot/bin`; Monitoring owns their content and hash.
- **A2 System fragments (§6.1).** The compiler also builds fragments no assignment drives, with the
  same checks, manifest and hash. Monitoring's inputs: the effective monitoring setting, the active
  account ID, the deny rules other fragments compile (FR24) and the Claude Code version (§10.3). A
  failover writes the `40-` and `80-` drop-ins in the same reconcile, `40-` first, exempt from
  rollout pacing, so no tokens are credited to the old account.
- **A3 Hooks are list keys (§7 rule 2).** `hooks.<Event>` arrays may come from several owners
  (Account Pool, Skillset, Persona, Monitoring). The docs say so: "Hooks merge across files rather
  than replacing each other" ([settings reference](https://code.claude.com/docs/en/settings-reference)),
  and `ConfigChange` runs when any file in `managed-settings.d` changes
  ([hooks](https://code.claude.com/docs/en/hooks)). ✅ In the cross-pool lab, `SessionStart` hooks
  from two drop-ins both ran, and a hook in a newly added drop-in fired on the next prompt. So each
  owner adds its own matcher group in its own drop-in, and every portal hook prints nothing, because
  `SessionStart` and `UserPromptSubmit` output becomes model context. This supersedes Persona A6's
  one-owner premise: the foundation's session reporter in `00-claudepilot-base.json` records
  revisions beside Monitoring's own entry. Q2 keeps the interactive check and `ConfigChange`.
- **A4 Outbox writers and pulls (§8).** Writers open with `O_APPEND`, write each line in one
  `write()` of at most 4 KB, and close; none keeps a descriptor between lines. Otherwise a
  long-running writer such as `monitor-otel` keeps appending to the sealed file after the portal
  deletes it, losing every later line. Step 3 waits 2 s instead of 1 s. A `.pulling` file whose last
  line has no newline is kept and printed again at the next pull; ids remove duplicates. Each type
  declares a cap up to 4 MB (`telemetry` 4 MB, `monitor` 1 MB). §12's outbox tests add `monitor-otel`
  under load with 10 s pulls for 10 minutes: zero missing ids.
- **A5 Pull exec, Remove and the locked image (§8).** The pull `exec` also runs registered snapshot
  steps and returns their output in the same document (Monitoring: `monitor-snapshot`), so a watched
  workspace costs one `exec` per tick; an open Monitor view counts as a subscriber. Pull once more
  before Remove, which deletes the home volume and its outbox. On the locked image, pulls and
  snapshots `exec` into the workspace container as the user, while delivery `exec`s target the
  sidecar (Settings & policies amendment 6).
- **A6 Image (§9).** Keep `jq`, `procps`, coreutils `timeout`, util-linux `setsid` and Node, all
  present today.
- **A7 Event log (§10).** One view (`at`, `kind`, `severity`, `actor`, `workspace`, `summary`,
  `link`) over every owner's event table, read at query time. The Event log and Monitor's Security
  tab are two filters over it. Adopt Portal MCP A3 (an `actor` on every event) with a `workspace`
  actor kind. Pools publish attention items through one interface (FR28).
- **A8 Workspace page and shared components (§10).** One workspace page,
  `/admin/workspaces/:target/:name`, with PageTabs Activity (Monitoring) and Configuration; its
  header holds Shell, Chat and the ⋯ Menu. Built once, before Chat sessions or Monitor ships UI
  (Chat sessions A2): StatusDot, Sparkline, TrendChart, FreshnessLabel, and Meter with §14's bands.
- **A9 Workspace instance ID (§5).** Set a `claudepilot.id` label (UUIDv7) at create and carry it
  over when the portal recreates a container; workspaces created before it use
  `target/name@<creation time>`. Tables that keep history key by it, so a reused name starts empty.

**Related changes in other PRDs.**

- [Settings & policies](settings-policies.md) §11: rows **Monitoring** (Auto, Full, Activity or Off;
  default Auto; scopes G P W) and **Detailed security events** (Off; scopes G W). §10.1's
  `Edit(//var/lib/claudepilot/**)` follows the outbox to `Edit(//home/node/.claudepilot/**)`. §13.1:
  budgets fed only by telemetry read "Partial (est.)" and use §6's caps.
- [Account Pool](account-pool.md): FR6 also reads `/v1/organizations/cost_report` daily, grouped by
  `workspace_id`. `usage_rollups` gains `cache_write` (one total: telemetry doesn't split 5-minute
  and 1-hour writes), `requests`, `instance_id`, the sources `telemetry` and `chat`, and cost in
  micros. §13's headroom bar uses the shared Meter (used = 1 − headroom, design tokens). FR21 and Q2:
  telemetry no longer needs to reach the portal, so per-workspace usage works on Kubernetes.
- [Portal MCP](portal-mcp.md): `monitor_overview.window` adds `30d`. [Persona](persona-pool.md): A6's
  one-owner premise is superseded by A3. [Chat sessions](chat-sessions.md): its A9 is adopted (§12,
  FR9, FR12). [README](README.md): Monitoring is Draft v0.5; record the five-tab navigation.

## 20. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | 🔬 In interactive sessions, does OTLP export behave as in print mode (✅ E7, with a 1 s interval: batches, per-record account updates)? What happens to exports while the receiver is down: dropped, retried or buffered? | Sandbox test |
| Q2 | 🔬 Confirm on 2.1.296 what the docs state: hook arrays from several managed drop-ins combine, and `ConfigChange` fires in each running session for every drop-in write. | Sandbox test |
| Q3 | 🔬 `claude agents --json --all` through `exec` without a TTY on the pinned version: wall time, peak RSS, and whether it starts a supervisor. The docs say it lists every live session; chat sessions show as `interactive` ✅. (Also Settings & policies Q10.) | Sandbox test |
| Q4 | 🔬 Do sessions started with `--bare` still load managed hooks and telemetry `env`? If not, they show as Unknown. | Sandbox test |
| Q5 | ✅ OTLP export continued with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (E7). 🔬 Does `DISABLE_TELEMETRY` also leave it on? If not, the compiler refuses it in Full mode. | Sandbox test |
| Q6 | 🔬 Is there a sandbox-violation signal beyond text in the Bash tool result? If not, may a Bash `PostToolUse` hook flag a violation marker as a boolean, without copying output? | Sandbox test, then Product |
| Q7 | May an admin set an own-login workspace to Full (tool stats, API errors and mode changes; tokens and cost still dropped), or is Activity the most it gets? | Operator |
| Q8 | 🔬 Bash coverage: does a `PreToolUse` `if` holding a Read or Edit rule fire for Bash commands that touch that path, and does `if` accept `Bash(dangerouslyDisableSandbox:true)`? (`PreToolUse` firing before a deny rule blocks a call is documented.) | Sandbox test |
| Q9 | Are detailed security events (command or path text) wanted at all, given that redaction can't catch everything? | Operator |
| Q10 | Should a later version add process kill and Stop for interactive sessions? | Product |
| Q11 | Alerts outside the page (push, email, Slack) once the portal is served over HTTPS? | Product |
| Q12 | With one shared server code, should actions record a per-device name so the feed shows who? (Also Chat sessions Q18.) | Product |
| Q13 | Will an Admin API key be provided per organization (Account Pool Q3), with an Anthropic workspace per account, so spend can show as billed? | Operator |
| Q14 | 🔬 OOM signals: does Docker emit an `oom` event when the kernel kills a process other than PID 1, on both daemons? Does our k3s run cgroup v2 with whole-container OOM kills? | Sandbox test; cluster check |
