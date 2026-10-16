# PRD: Claude usage

| | |
| --- | --- |
| Status | **Draft v0.2.** K0, M1, M2 and M3 are built and were tried (§17). ✅ = observed on Claude Code 2.1.296, on this machine, against a local stand-in for `api.anthropic.com` and a scratch directory holding a clearly fake credentials file (no sign-in, no real token, nothing leaves the machine). 📄 = read from the CLI's own schema and strings, not observed. 🔬 = unverified, listed in §19. **A real claude.ai subscription could not be signed in here, so no real plan reply has been seen**: the parser is built against the observed shapes and the CLI's schema, and §19 says exactly what that leaves open. **Round 4 (2026-10-12):** §20 adds speed, pace and projection, the comparison with the previous period, the cache split, palette slots, a summary strip, a Move recommendation and export: **built on the server** and checked on hand-computed fixtures and a seeded scratch portal, never against a real plan; the pages that show it are not part of it. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [Workspace Claudes](workspace-claudes.md) (the Claudes, their directories and sign-ins), [Chat sessions](chat-sessions.md) (the reader of live sessions, `get_usage` already used there), [Account Pool](account-pool.md) (a pool means API keys, so no plan limits) |
| Related | [Portal MCP server](portal-mcp.md) (a read tool), [Web app & PWA](web-app-pwa.md) (toasts now, push later), [Settings & policies](settings-policies.md) (thresholds, later) |

## 1. Summary

Each Claude on a workspace is signed in to its own claude.ai plan (Pro, Max, Team, Enterprise), or runs on the workspace's account pool, or on an API key. A plan has usage limits: a session window of about five hours, a weekly limit for all models, weekly limits for some models, and sometimes extra usage on top. Claude Code shows them in its own `/usage` panel. This PRD puts the same numbers in the portal, per Claude: how much of each window is used, when each resets, a short history, a warning before a Claude runs dry, and a one-line answer for the Move-chat flow ("this Claude has 59 % of its session left").

The portal reads them only from Claude Code itself, never from a login. Two sources: a short-lived `claude` process run as that Claude, asked once for its usage with no model call (the **probe**), and the rate-limit events that live chat sessions already stream (the **passive** source). A Claude on a pool or an API key says "No plan limits" in one line.

## 2. Background and problem

- Work stops when a plan window runs out, and the Claude Code terminal is the only place that shows it. With several Claudes on several workspaces nobody can see which one has room.
- The portal already shows what requests cost ([Chat sessions](chat-sessions.md) FR49) and the health and quota of API-key accounts ([Account Pool](account-pool.md) §11). Neither says anything about a plan's windows, and a plan has no cost to count.
- Moving a chat to another Claude is the usual reaction to a limit ([Workspace Claudes](workspace-claudes.md) FR9). The person chooses blind.
- Claude Code's `/usage` numbers cannot be had by asking Anthropic's usage endpoint ourselves: that takes the Claude's token, which the portal never holds ([Workspace Claudes](workspace-claudes.md) FR4).

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Per Claude, the plan's windows.** Session, week, per-model weeks and extra usage, each as percent used and the time it resets. |
| G2 | **Only Claude Code's own answers.** No login, token or credentials file is read, copied, stored or logged. No account email, organization or id is kept or returned. |
| G3 | **No cost.** No model request. A probe never wakes a stopped workspace and never runs faster than its limits. |
| G4 | **Honest numbers.** A reading says when it was taken and by which source. A number that may be old is shown dimmed. Unknown is shown as unknown, never as zero. |
| G5 | **History.** A reading is kept with its time, so a trend and the resets over the last day, week or month can be seen. |
| G6 | **Warn before it stops.** In-app alerts at 80 %, 95 % and exhausted, once per window period, with a snooze. |
| G7 | **Available to other flows.** `headroom(claudeId)` for the switch dialog and the Claude rows; a read tool over the Portal MCP. |
| G8 | **A light page.** Phone first, few words; explanations in InfoTips. |

## 4. Non-goals

- **Switching Claude by itself.** The portal shows, warns and suggests. It never moves a session or a terminal because a limit is near ([Workspace Claudes](workspace-claudes.md) §4 stays true).
- **Asking Anthropic directly.** No call to `api.anthropic.com` or claude.ai from the portal with any credential. Claude Code makes that call, inside the workspace, as the Claude.
- **Plan limits of a pool or an API key.** They have none ([Chat sessions](chat-sessions.md) §6 rule 3). Account Pool shows their quota.
- **What a request cost.** [Chat sessions](chat-sessions.md) FR49 and the Usage page keep that.
- **Reading transcripts.** `get_usage` is always asked with `skip_behaviors: true`: without it Claude Code scans every transcript touched in the last seven days.
- **Forecasting by guess.** Superseded in part by [§20](#20-usage-insight-round-4-engine-a) at the owner's request (2026-10-12): the portal now estimates when a window will run out, from the percentages Claude Code reported and never from tokens, labels every such figure an estimate with its formula, says why when it cannot, and alerts only on a confident basis. It still makes no forecast from the clock alone.
- **Web Push.** It does not exist in the code yet. §12 writes down where it plugs in.

## 5. Users and stories

**Admin** and **workspace user** are often the same person.

| ID | Story |
| --- | --- |
| US1 | I open Usage → Claudes and see each Claude with its plan, a meter per window and when each resets. |
| US2 | I see the per-model weekly limits the plan has (for example Opus and Sonnet) next to the all-models week. |
| US3 | I am told once when a window passes 80 %, again at 95 %, again when it is exhausted, and not again until that window resets. I can snooze a Claude. |
| US4 | Before I move a chat I see the destination Claude's headroom in the switch dialog. |
| US5 | A Claude on a pool or an API key says "No plan limits". A signed-out one says so. |
| US6 | I see how a window moved over the last day, week or month. |
| US7 | I press check on one Claude and see fresh numbers within seconds. |
| US8 | A stopped workspace is not woken. Its last numbers show dimmed with their age. |
| US9 | A tool or an agent over the Portal MCP can read the same snapshot. |

## 6. Scope boundary

| Allowed | Not allowed |
| --- | --- |
| Running Claude Code's own `claude -p --safe-mode` in the workspace, as that Claude (its directory), to ask `get_usage {skip_behaviors: true}` and read the numbers, timestamps and plan type of the reply. | Reading, copying, storing, logging or returning a login, a token, `.credentials.json` or `.claude.json`. Calling Anthropic with one. |
| Running `claude auth status --json` as that Claude to tell "signed out" from "no plan limits", keeping `loggedIn` and `authMethod` only. | Keeping its email, organization name or id, or showing them anywhere. |
| Keeping a coarse plan label (`pro`, `max`, `team`, `enterprise`) from the reply's `subscription_type`, the word Claude Code's own `/usage` shows. | Keeping the account or the organization behind it. |
| Using the `rate_limit_info` of a live session's `rate_limit_event`, handed over by the chat reader. | Storing the event line, the session's text or anything else from the stream. |
| Probing only Claudes whose workspace is running. | Waking, starting or installing into a stopped workspace. Installing Claude Code (the sign-in flow does that). Running the workspace's hooks, plugins or skills: a probe is in safe mode (§11). |

**Amendment to two PRDs (Q1).** [Chat sessions](chat-sessions.md) §6 and [Workspace Claudes](workspace-claudes.md) §6 said the portal never records "account, organization, plan". The point of those lines is that the portal does not learn who someone is. A plan limit cannot be shown without saying which plan, so this PRD keeps the plan's tier name only. The coordinator approved the change on the owner's behalf (provisional, for the owner to confirm) and both lines now read "account, organization or email" with a pointer here.

## 7. Solution overview

```
 Workspace (running)                                   Portal
 ┌─────────────────────────────────────────────┐      ┌────────────────────────────────────────┐
 │ claude -p (stream-json), as the Claude,     │      │ scheduler: due Claudes, one probe at   │
 │   CLAUDE_CONFIG_DIR = its directory         │◀─────│   a time per workspace, backoff        │
 │   control_request get_usage                 │ exec │ parser: numbers, times, plan only      │
 │   {skip_behaviors: true}   no model call    │─────▶│ store: samples + latest + alert state  │
 │ exits after the reply (~0.7 s, ~210 MB)     │      │ headroom(claudeId)  ◀── switch dialog  │
 │                                             │      │ routes /api/claude-usage  → Usage tab  │
 │ live chat session ──rate_limit_event──▶ reader ───▶│ onRateLimit(sessionId, claudeId, info) │
 └─────────────────────────────────────────────┘      └────────────────────────────────────────┘
```

1. **Scheduler.** Every few seconds it picks the Claudes that are due: workspace running, not on a pool, last probe older than the interval, not backing off.
2. **Probe.** One short `claude -p --safe-mode` process per Claude, in a clean environment (so no hook, plugin or skill runs), one control request, read the reply, end (§11).
3. **Parser.** The reply becomes windows (key, label, percent, reset time), an optional extra-usage record and a plan label. Anything else is dropped.
4. **Store.** A reading is a few rows in `claude_usage_samples` and an update of `claude_usage_latest`. The live socket tells open pages to reload.
5. **Passive.** The chat reader hands each rate-limit event to `onRateLimit`; the same store takes it, as source `live`.
6. **Readers.** The Usage tab, the Claude rows, the switch dialog (`headroom`) and the Portal MCP tool all read the same snapshot.

Anything that needs the real CLI to behave as a plan in a test uses the testkit (`apps/server/src/claudeusage/testkit/`, with its README): a fake login in a scratch directory and a scripted stand-in for `api.anthropic.com` (its own throwaway CA, handed to the child process only). Every credential in it is obviously fake and lives for the test.

## 8. Functional requirements

### Sources

- **FR1** The probe asks one thing: `get_usage {skip_behaviors: true}` over Claude Code's stream-json control protocol. It sends no user message, so no model request is made and nothing is billed (✅ the reply came with no `system/init` and no API call).
- **FR2** A Claude on a workspace with an account pool is not probed: its state is `pool`, shown as "No plan limits" (the pool's keys replace sign-ins, [Workspace Claudes](workspace-claudes.md) §6).
- **FR3** A reply with `rate_limits_available: false` is not a plan. `claude auth status --json` then tells signed out (`loggedIn: false`, state `signed_out`) from signed in with a key (state `no_limits`). Only `loggedIn` and `authMethod` are read.
- **FR4** A reply with `rate_limits_available: true` and `rate_limits: null` means Claude Code could not reach its usage endpoint (✅ with a 429 and no cached copy). The state is `unknown` and the probe backs off (§11).
- **FR5** The passive source takes a live session's `rate_limit_info` (§10.2). It updates the windows it carries and leaves the others as the last probe left them. It never ends, delays or changes a session.

### Readings

- **FR6** A window has a key, a label, percent used (0 to 100, above 100 once over) and the time it resets, either of which may be null. Keys: `session`, `week`, `week_opus`, `week_sonnet`, `week_apps`, `week_models` (the model bucket a live event carries), `model:<name>` for any other model the plan names, `other:<kind>`. Extra usage is not a window: it is its own record (amounts in minor units). At most 12 windows per reading.
- **FR7** A window's level is computed when it is read, from its percent and the clock: `ok` below 80, `near` from 80, `high` from 95, `exhausted` from 100 or when Claude Code said `rejected`, `reset` when its reset time has passed (the number is old), `unknown` without a number. A Claude's state is the worst of its windows that is not `reset`.
- **FR8** A reading is kept with its time and source. When the numbers are the same as the last row of that window and that row is under 30 minutes old, no row is added; the Claude's `checkedAt` still moves.
- **FR9** A snapshot older than three intervals, or of a stopped workspace, is `stale`. It stays on screen, dimmed, with its age.

### Probing

- **FR10** Interval: 10 minutes for a Claude whose workspace runs; 2 minutes while a page asks for the snapshot (it counts as watching for 2 minutes); one hour for a Claude found signed out or without plan limits. Settings: `PORTAL_CLAUDE_USAGE_INTERVAL_S` (600), `PORTAL_CLAUDE_USAGE_FAST_S` (120); `PORTAL_CLAUDE_USAGE_PROBES=off` turns probing off; `PORTAL_CLAUDE_USAGE_ONLY=cu-,ws-` probes only workspaces whose name starts with one of those (for a portal that shares its container runtime with others).
- **FR11** One probe at a time per workspace, at most two in the portal. A failed or unknown probe doubles that Claude's wait up to one hour; a good one resets it.
- **FR12** Check now: one Claude, refused with a cooldown of 30 seconds (the CLI also answers from its own copy under 60 seconds old, ✅). Refused for a pool Claude and for a stopped workspace.
- **FR13** A probe has a hard limit of 25 seconds inside the workspace (`timeout`) and 30 seconds in the portal, and is killed by that, never left running.
- **FR14** Start-up and every background pass are wrapped in try/catch and skipped unless the store is writable and `deliveryAllowed`. A missing table or a failed exec is logged once and never stops the portal.

### Headroom

- **FR15** `headroom(claudeId)` returns: kind (`plan`, `no_limits`, `signed_out`, `unknown`), the fullest window (key, label, percent used, percent left, reset time), whether an all-models window is exhausted and when it is usable again, the exhausted per-model windows, `checkedAt` and `stale`. It never throws and never starts a probe.

### Alerts

- **FR16** Per Claude and window, an alert fires when its level first reaches `near`, `high` or `exhausted` in the current period (the window's reset time). A reset starts a new period. A level that falls and rises again in the same period does not repeat. §12.
- **FR17** Snooze: one hour, four hours, or until the Claude's next reset. A snooze stops toasts and the row's attention colour, never the readings.

### API and live

- **FR18** `GET /api/claude-usage` (the snapshot), `GET /api/claude-usage/:claudeId/history?range=`, `POST /api/claude-usage/:claudeId/check`, `PUT` and `DELETE /api/claude-usage/:claudeId/snooze`. Behind the session guard like every `/api` route; mutating requests are checked for origin.
- **FR19** The live topic `claudeusage` tells open pages to load the snapshot again. Reads never trigger a probe.
- **FR20** A Portal MCP read tool, `claude_usage`, returns each Claude's windows (percent used and left, reset time, level), state, plan tier and when it was read. An admin's token reads every Claude or one; an agent's per-session token reads only the Claude its own session runs in and is refused another (interface I8). A model's name, which comes from Claude Code, is labelled untrusted. Nothing in it names an account.

## 9. Data model

| Store | Fields |
| --- | --- |
| `claude_usage_samples` | id, at_ms, claude_id, workspace_id, win (the key), used_pct (real, null when the window had no number), resets_at_ms (null), level, source (`probe` or `live`). Indexes on (claude_id, win, at_ms) and (at_ms). |
| `claude_usage_latest` | claude_id (primary key), workspace_id, checked_at_ms, last_probe_at_ms, runs_on (`plan`, `key`, `pool`, `none`, `unknown`), plan, windows (JSON: the last reading as FR6 describes it), extra (JSON or null), source, problem (a fixed short code or null), fails (consecutive), snoozed_until_ms, alerted (JSON: per window, the highest level told, the reset time of that period, when, and whether it was quiet). |

Neither table has a column for a login, an email, an organization or an id of an account, and the API names what a Claude runs on `runsOn`, never a credential. `claude_id` and `workspace_id` are the portal's own ids ([Workspace Claudes](workspace-claudes.md) §9); rows of a Claude that no longer exists are deleted by the next prune. Migration 90.

Retention: every sample for 2 days; then one per window per hour (the last of the hour) up to 30 days; then deleted. Pruned at start and every six hours.

## 10. What Claude Code gives us (the research)

### 10.1 Active: `get_usage`

The reply (✅ observed with a fake claude.ai login and a stand-in endpoint; field meanings 📄 from the CLI's schema):

```
{ session: { total_cost_usd, total_api_duration_ms, total_duration_ms, total_lines_added, total_lines_removed, model_usage },
  subscription_type: "max" | "pro" | "team" | "enterprise" | null,
  rate_limits_available: boolean,
  rate_limits: { five_hour, seven_day, seven_day_oauth_apps, seven_day_opus, seven_day_sonnet: {utilization, resets_at} | null,
                 model_scoped?: [{display_name, utilization, resets_at}],
                 extra_usage?: {is_enabled, monthly_limit, used_credits, utilization, currency},
                 limits?: [{kind, group, percent, resets_at, scope, severity, is_active}] } | null,
  behaviors: null }
```

| Observed | |
| --- | --- |
| No login, API key | `subscription_type: null`, `rate_limits_available: false`, `rate_limits: null` ✅ (and in the chat tests, [Chat sessions](chat-sessions.md) §6 rule 3) |
| Plan login | `subscription_type` as stored with the login; `rate_limits` is the body of Claude Code's own usage fetch as it was sent: the five named windows (`utilization` 0 to 100, `resets_at` ISO 8601, null when the plan has no such window) and `extra_usage` ✅. The server's own `limits[]` rows come through untouched when present ✅ (`kind` `session`, `weekly_all`, `weekly_scoped` with `scope.model.display_name`, `spend`; the server's `severity`). `model_scoped` carries per-model weeks only for models Claude Code's own allowlist lists; the stand-in's did not trigger it, so the parser takes per-model windows from either place 🔬. |
| Endpoint unreachable, no copy | `rate_limits_available: true`, `rate_limits: null` ✅ (429) |
| Timing | A reply in 0.35 to 0.7 s from a warm start, 2 to 3 s when it had to reach the endpoint; peak memory about 210 MB; the process exits 0.1 s after its stdin ends; it still answers a request it had already read ✅ |
| Its own copy | Claude Code keeps the last usage body in the Claude's `.claude.json` (`cachedUsageUtilization`). Younger than 60 s: answered without asking the endpoint ✅. After a failed fetch it answers from that copy when it is under an hour old, and does not say so 📄. So a reading can be up to an hour old without a flag (§11, Q3). |
| What stops it | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` stops the fetch and yields `rate_limits: null` ✅. The probe never sets it, and a workspace that sets it reads as unknown. `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` and `DISABLE_AUTOUPDATER` do not stop it, and with them the process sends no telemetry ✅. |
| `claude auth status --json` | `loggedIn`, `authMethod` (`claude.ai`, `none`; other values for keys and providers 🔬), `subscriptionType`, and also the email, organization name and id ✅. The portal parses the first two and drops the output. |
| Not usable | `--bare` skips OAuth, so a subscription would read as signed out. `skip_behaviors: false` scans transcripts. `CLAUDE_CODE_SAFE_MODE=1` alone does not stop hooks: the flag `--safe-mode` is what the probe uses (§11). |

### 10.2 Passive: `rate_limit_event`

Claude Code emits `{type: "rate_limit_event", rate_limit_info: {...}}` before a turn's `result` when a response carried `anthropic-ratelimit-unified-*` headers and a window's rounded percent or reset moved ✅. Observed (stand-in headers, real Claude Code):

```
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1791772512,"rateLimitType":"five_hour",
  "utilization":0.82,"overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false,"surpassedThreshold":0.75,
  "unifiedWindows":{"five_hour":{"utilization":0.82,"resetsAt":1791772512},"seven_day":{"utilization":0.63,"resetsAt":1791965312}}},
 "uuid":"…","session_id":"…"}
```

- `utilization` here is a fraction (0.82 means 82 %), and `resetsAt` is Unix seconds, unlike `get_usage` (percent, ISO) ✅. The parser converts both.
- `unifiedWindows` has `five_hour`, `seven_day` and, only for plans that report it, `seven_day_overage_included` (the per-model bucket) 📄. There is no per-model number for Opus or Sonnet here: those come from the probe.
- A refused turn (a 429 with `anthropic-ratelimit-unified-status: rejected`) streams the event with `status: "rejected"`, then an `assistant` line (`model: "<synthetic>"`, `api_error: "usage_limit_reached"`, the same info under `api_error_params.rate_limit_info`), then a `result` with `is_error: true`, `api_error_status: 429`. No `api_retry` event ✅. A plain 429 without those headers streams `api_retry` instead ([Chat sessions](chat-sessions.md) §10.3), which carries no limit numbers.
- The hook gets the `rate_limit_info` object exactly as emitted, as unknown data. The parser takes only numbers, a status and a window type from it. It is not stored as received.

### 10.3 The limit message (T-255)

When the plan is out of quota Claude Code answers the turn itself: an `assistant` line with `message.model: "<synthetic>"`, `error: "rate_limit"`, `is_api_error_message: true` and one text block ✅ (seen on this pod's streams, Claude Code 2.x):

- "You've hit your session limit · resets 11pm (UTC)", "You've hit your session limit, resets 10:20pm (UTC)" ✅; a weekly or model limit and a date ("resets Oct 20, 5am (Asia/Jakarta)") and the older "Claude usage limit reached. Your limit will reset at 5pm (America/New_York)." 📄 are parsed the same way.
- Often there is no `rate_limit_event` before it (at a session's first turn there is none) ✅, and the probe may still read 0 % with no reset time for that account (2026-10-13).

The chat reader turns it into a refusal of that window with the stated reset (`claudeusage/limitMessage.ts`; the reset is the next such time after the line's own timestamp, in the zone it names, UTC without one; nothing readable: the next 5-hour boundary, `guessed`). The usage module keeps it as the Claude's **limit report** (`claude_usage_latest.limit_report`, migration 810: window, when, until, guessed, the chat) and lays it over every reading until the reset: the window is 100 % used, the Claude `exhausted`, `headroom` exhausted. A guessed reset adds no sample. A line read again after its reset records nothing. The snapshot carries it as `limitReport`; the Claudes tab shows "Limit hit · until 23:00" with an ⓘ: "Limit reported by a chat at 18:36, until 23:00 …" and its source.

### 10.4 Unavailable is a state, never 0 % (T-255)

`ClaudeUsage.unavailable` (and `UsageSummaryClaude.unavailable`) says why a plan Claude's usage is not known (`usageUnavailable` in contracts): `signed_out`, `no_usage_endpoint` (Claude Code's usage call failed or the sign-in has no scope for it), `no_reading`, `no_window`, `no_number`, `no_reset_time` (the session window has no reset time: 0 % so is not a reading), `period_reset`. Such a Claude is `unknown`, not `ok`; its row says "Unavailable: no reset time" with the detail in an ⓘ, and a window at 0 % with no reset time shows a dash. Auto move never prefers it to a measured Claude ([auto transfer](auto-transfer.md) FR10d).

## 11. Probe mechanics and limits

**Command**, run in the workspace by the runtime's exec as the workspace user:

```
env -i HOME PATH LANG=C.UTF-8 [CLAUDE_CONFIG_DIR=$HOME/.claudepilot/claudes/<16 hex>]
       DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 DISABLE_AUTOUPDATER=1
       [HTTPS_PROXY HTTP_PROXY NO_PROXY NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR, only when set]
  timeout 25 claude -p --input-format stream-json --output-format stream-json --verbose
       --strict-mcp-config --no-session-persistence --disable-slash-commands --safe-mode
```

- **Directory.** The Claude's directory is checked against `claudes/<16 hex>` and passed as an argument, never through shell parsing (the pattern of [Workspace Claudes](workspace-claudes.md) §12). Default has no `CLAUDE_CONFIG_DIR`, as everywhere else.
- **Clean environment.** An API key, an auth token or a base URL in the workspace's environment would turn the probe into an API-key session and answer "no plan limits" for a Claude that has a plan. So nothing is inherited except the network plumbing a workspace may need to reach Anthropic. ✅ Observed: with `ANTHROPIC_API_KEY` in the environment the same fake plan login read `rate_limits_available: false`; the probe's wrapper drops it, and so a token and a base URL.
- **One line in, one line out.** The request line carries a random id; only the `control_response` with that id counts. Other lines (init, logs, merged stderr) are ignored. The reply is parsed in memory and dropped; only the parsed numbers are kept.
- **Limits.** One probe at a time per workspace, two in the portal, 30 seconds hard stop, one check-now per Claude per 30 seconds, an interval of 10 minutes (2 while watched), backoff on trouble up to one hour. A Claude's cadence is a fraction of what the CLI itself does (it fetches usage on every `/usage` and status refresh), and the CLI's own 60-second copy absorbs bursts.
- **Where it runs.** Docker and the local machine through the runtime's `exec`. Kubernetes uses the same exec ([Workspace Claudes](workspace-claudes.md) W3) 🔬.
- **Failure map.** Claude Code missing (exit 127): `unknown`, problem `not_installed`; no reply in time: `unknown`, `timeout`; a refusal or an unreadable reply: `unknown`, `unreadable`; workspace stopped: nothing is run. The text shown for a problem is fixed; Claude Code's output is never shown or logged.
- **Servers and the session.** The probe starts no MCP server and writes no session, and it sends no user message, so no model request is made. ✅ In a Docker workspace the stand-in saw only the profile, bootstrap, feature-flag and usage calls: no telemetry, no model request. A pool workspace is not probed (U8). This bullet used to say that no hook can fire; that was wrong, see the next subsection.

### Hooks never run (safe mode)

**Finding (2026-10-12, S1, on the real CLI).** The first version of the probe ran Claude Code without safe mode. A probe starts a session (no message is sent), and Claude Code runs the `SessionStart` and `SessionEnd` hooks of that session: those of the Claude's own `settings.json` (`$CLAUDE_CONFIG_DIR`, or `~/.claude` for Default) **and those of the project's `.claude/settings.json` in the exec's working directory**, on every poll (every 10 minutes per Claude, every 2 while the page is open, and on each check now). Those files are the workspace user's and the agent's to write. A hook is automation written for a person's interactive session (a notification, a git command, a log line): run by a poll it fires unseen and repeatedly, and it can push the probe past its limit. An agent in a workspace can already run commands there, so this is not an escalation of what it can do; it is the portal running them, on a timer, for a session nobody started.

**Fix.** `--safe-mode` (`SAFE_MODE_FLAG` in `probe.ts`) is part of the probe's command. Claude Code's safe mode starts with every customization off (hooks, CLAUDE.md, skills, plugins, MCP servers, commands, agents, output styles); auth, model selection, built-ins and permissions work normally and admin-managed (policy) settings still apply. Observed on Claude Code 2.1.296: the real CLI, a private HOME with a clearly fake login, the scripted stand-in, and, for policy settings, a private mount namespace in which `/etc/claude-code/managed-settings.json` was a real root-owned policy file that only that process tree could see.

| Observed | Result |
| --- | --- |
| The probe command without the flag, hooks in the Claude's settings and in the project's | `SessionStart` and `SessionEnd` ran, user and project hooks alike; the reply was still the plan ✅ |
| The same with `--safe-mode`, a named Claude and Default | no hook ran, in either place; the same reply (plan `max`, its windows) ✅ |
| The same in a throwaway container of the workspace image (dash, user `node`, its own `claude` 2.1.296) | with the flag: no hook and a reply; without it: the hook ran ✅ |
| A managed (policy) `SessionStart` hook beside a user hook, with `--safe-mode` | the managed hook ran and the user hook did not: policy applies, the workspace's own hooks do not ✅ |
| A managed `apiKeyHelper` | `rate_limits_available: false` with and without the flag: managed auth applies ✅ |
| A user-level `apiKeyHelper` in the Claude's settings | still read as an API key (`auth status` says `api_key_helper`; the integration test passes with the flag) ✅ |
| `CLAUDE_CODE_SAFE_MODE=1` in the environment instead of the flag | **no hook was stopped.** The variable is only what the flag sets; it is not a substitute, and an older Claude Code would ignore it and run the hooks ✅ |
| `--settings '{"disableAllHooks":true}'` instead of the flag | stopped the hooks on 2.1.296 and on 2.1.168; not used, see below ✅ |
| `claude auth status --json` (the probe's second call) | ran no hook and did not run the `apiKeyHelper`; `auth status --safe-mode` is an unknown option (the flag goes before the subcommand), so that call is left as it was ✅ |

**Older Claude Code.** `--safe-mode` came in 2.1.169. An older one answers `error: unknown option '--safe-mode'` and exits before it starts anything (observed on 2.1.168), so the probe **fails closed**: it reads nothing, runs nothing and does not retry without the flag. That costs nothing: 2.1.168 does not answer `get_usage` either (it replies with an error), so no version that can answer it lacks the flag. There is therefore no fallback: `--settings '{"disableAllHooks":true}'` would have worked on 2.1.168, but only where usage could not be read anyway, and it could not be verified on any older version that could. The portal recognises the refusal (it looks for the parser's `unknown option … --safe-mode` and keeps nothing else of the output) and says once per workspace in its log: "Claude Code there has no --safe-mode … Update Claude Code in that workspace". To the page it is the contract's `unreadable` problem, with the usual back-off up to an hour. A problem code and a line of its own ("Claude Code is too old to read usage safely") need a contract and a web change: asked for in the outbox, not made here.

**Policy hooks.** Under safe mode an administrator's managed hooks still run: they are root-owned and meant to. A workspace that has managed hooks runs them on each poll.

## 12. Alerts

| Level | When | Shown as |
| --- | --- | --- |
| `near` | a window reaches 80 % | amber meter; one toast per window per period |
| `high` | a window reaches 95 % | red meter; one toast |
| `exhausted` | 100 %, or Claude Code said `rejected` | red, "Out until 14:20"; one toast, with the Claude to switch to when another has room |

- Level changes are detected on the server when a reading is stored, and kept in `alerted` so a restart does not repeat them. A small component in the app shell loads the snapshot on the `claudeusage` topic and shows a toast for each alert it has not shown on this device (remembered per Claude, window and period in `localStorage`).
- A snoozed Claude shows no toast and no attention colour until the snooze ends or its window resets.
- **Seam for push.** Alerts are plain objects (`claudeId`, `claudeName`, `window`, `level`, `usedPct`, `resetsAt`, `at`) handed to a list of sinks in `claudeusage/alerts.ts`. The only sink today feeds the live topic. When [Web app & PWA](web-app-pwa.md) FR13 push lands, it adds a sink that sends the same object under the notification kind `limit`, with the throttle that PRD gives.
- Optional: when a Claude is exhausted and another Claude on the same workspace has room, the row offers "Switch" and opens the switch dialog. Never automatic.
- **Projection (§20.4).** A fourth kind of alert, "will run out before reset", from the window's pace: once per window and period, only on a confident estimate, with its own snooze, through the same sink (`kind: 'projection'`, `etaAt`, `projectedPct`).

## 13. What the person sees

Under the text diet: words of one or two, numbers and bars, explanations in InfoTips. Phone first.

| Place | What it shows |
| --- | --- |
| Usage → Claudes | The Usage page has five tabs (§27): Requests, Claudes (`?tab=claudes`), Attribution, Budgets and Spikes, under a strip of four figures. The Claudes tab carries a count of Claudes that are near a limit, out, or estimated to run out before they reset (a confident estimate only), not snoozed. One row per Claude, the neediest first: a status icon (within limits, near, out, not known, not signed in, no plan limits), the name, the plan as a small chip, the workspace, a sparkline of the week on wider screens, a chevron and a check icon button. Under it a bar per window: label, bar (accent, gold from 80 %, red from 95 %), percent, and the reset as a countdown ("2 h 10 m"; tap it for the time on this device's clock). Per-model weeks sit under the week; extra usage is one short line. |
| A Claude with no plan limits | One short line: "No plan limits". Signed out: "Not signed in". Not read: "Not read yet", or "Couldn't read usage" with an ⓘ that says why. |
| A stale row | Dimmed meters and the age ("3 h ago") beside the workspace; a stopped workspace says "stopped" and its check button is off. Unknown shows "—", never 0. |
| A Claude that is out | A line under its windows: "Room on Kresna · 65 % left" when another Claude on the same workspace has room. It says; it never switches. |
| The chevron | The history: a 1 d, 7 d, 30 d switch and a small line per window (the 80 % and 95 % marks faint behind it), and the snooze menu (1 hour, 4 hours, until it resets, alert me again). |
| Workspace sheet, Claude rows | A tiny two-bar meter (session over week) before the terminal button; tap opens Usage on that Claude. `ClaudeMeter`. |
| Switch dialog | One line under the destination: "Session 41 % · resets 14:20", "Out until 14:20", "No plan limits", "Not signed in". `ClaudeHeadroom` and `useHeadroom`, exported from `features/usage/claude` for A2's dialog. |
| Toasts | Anywhere in the app, once per alert on this device: "Satria: week 95 %", "Default: out until 14:20", with a way to the tab. |
| Info | An ⓘ on the tab says what the numbers are, where they come from, and that a dash is not zero. |
| Round 4 | The strip, the stacked charts, pace marks on the bars, the run-out line, attribution, budgets, spikes, export and the Move recommendation are §27, with their copy. **Multi-user:** a browser preference is keyed with the user's id (`u_owner` today), and a view the portal refuses to show reads "Not available to you." rather than empty. |

## 14. Security

- **No credentials.** The probe never opens a credentials file, never sets a token, and its environment is cleaned (§11). The only things read from the workspace are Claude Code's reply to one control request and `loggedIn` and `authMethod` from `auth status`; the rest of that output is dropped in memory.
- **No hooks.** A probe never runs the workspace's hooks, CLAUDE.md, skills or plugins: its command carries `--safe-mode` (§11, "Hooks never run"). Admin-managed (policy) settings still apply. The flag is guarded by the unit test of the command line and by a real-CLI test in which a `SessionStart` hook writes a marker file (§16).
- **No identity.** Neither table, the API, the logs nor the live socket carries an email, an organization name or an id of an account. The Claude's own label (its name) is enough. A canary test (§16) checks it.
- **Untrusted input.** Everything in a reply is untrusted: numbers are clamped (0 to 1000), times must parse, labels are cut to 40 characters, stripped of control characters and escaped by the page, the number of windows is capped. A reply that does not match drops the reading, not the portal.
- **Rate limits.** The limits of §11 hold for every caller: the scheduler, check-now, and the MCP tool (which never probes).
- **Guard.** Every route sits behind the session guard; mutating requests need the origin check. The MCP tool follows the registry's scopes.
- **Failing closed.** If the portal's store is locked or frozen, nothing probes. A Claude Code that does not know `--safe-mode` is not probed either (§11).
- The workspace is not trusted either: a workspace can lie about its own usage. The numbers inform a person; no decision of the portal's depends on them.

## 15. Observability

One line per probe outcome in the portal log (`[claude-usage] <claude id> <what it runs on, or failed (problem)> in 515 ms`; a Claude Code without `--safe-mode` reads `failed (unreadable, no --safe-mode)` and its workspace is told once, in words): never a number from the reading and never Claude Code's output. A background failure (a listing, a pass, a sink) is logged once per kind. The snapshot says when each Claude was last read and from which source. Alerts go to the live feed and to the sinks of §12; they are not written to the audit trail. Counters for the Monitoring dashboard are not built.

## 16. Testing

| Case | Covered by | Expected |
| --- | --- | --- |
| Parser: the observed plan replies (named windows, `limits[]` rows, extra usage), other shapes, malformed input, clamping, labels, plan names | `parse.test.ts` (12) | Windows, percents, reset times, tier and extra as in §10.1; every bad input drops a reading, never throws. |
| Passive parser: the observed events | `parse.test.ts` | Fractions become percents, Unix seconds become times; `rejected` makes the window exhausted; extra usage refused; nothing worth keeping gives null. |
| Probe: the shell wrapper on a real `sh` | `probe.test.ts` (8) | Only HOME, PATH, LANG, the three quiet switches, the pass-through names when set, and the Claude's own directory; a key, a token, a base URL and a stray `CLAUDE_CONFIG_DIR` are dropped; a value with a space stays whole; an invalid directory throws. |
| Probe: the protocol, with a scripted exec | `probe.test.ts` | One control line and no user message; a reply to another id is ignored; hang, 124, 127, a refusal and a failing exec each read as their problem; sign-in state tells signed out, key and a login without the profile scope apart; the canary never comes back. |
| Probe: safe mode (§11) | `probe.test.ts` (3 added) | The command carries `--safe-mode` once and never `--bare`; `auth status` does not; a process that rejects the flag (even across chunks) is `unsupported`, fails closed with no second question, and another failure is not mistaken for it; through the real shell wrapper a stand-in `claude` is given the flag, and one that rejects it is told apart. |
| Hooks never run (§11) | `claude.integration.test.ts` (1 added), `service.safemode.test.ts` | With the real CLI: `SessionStart` and `SessionEnd` hooks in the Claude's settings and in the project's leave no marker file for a named Claude and for Default, and the plan is still read; the control (the same command with only the flag taken out) leaves the markers, so the test can fail. A workspace whose Claude Code lacks the flag is told once and reads as `unreadable`. |
| Store | `store.test.ts` (5) | Rows only on change or after 30 minutes; history; retention (two days, hourly to thirty, nothing after, Claudes that are gone, never on an empty list); an unusable store reads as nothing. |
| Scheduler, check now, backoff, watch, the off switch, a store the portal does not trust | `service.test.ts` (17) | Only due Claudes of running, non-pool workspaces; one probe per workspace, two in all; backoff to an hour and back; settled states hourly; faster while watched; cooldown; nothing at all on a frozen store. |
| Passive hook | `service.test.ts` | Updates the windows it carries and leaves the probe's others; a Claude with no reading gets one; a refusal is exhausted at once; a pool, a stranger and rubbish do nothing. |
| Alerts | `service.test.ts` | Once per window, level and period; reset starts a period; rounding of a reset time is one period; a snooze is quiet and stays quiet; a restart repeats none; a throwing sink harms nothing. |
| Report, headroom, history, trend | `service.test.ts` | States of each kind, stale, pool hides an old reading; headroom as FR15; ranges, thinning to 200 points, the row's 28-point sparkline. |
| API | `routes.test.ts` (4) | Shapes, thresholds, alerts; no field names an account or a login; 422, 404, 409, 429 as FR18. |
| Portal MCP tool | `portalTools.test.ts` (2) | Through the real MCP endpoint: an admin token reads all or one, an agent only its own Claude. |
| Boot | `qa/boot.test.ts` (4) | Green with the module in. |
| Real Claude Code against the stand-in | `claude.integration.test.ts` (9) | A fake Max login reads as a plan with its windows and nothing is asked but the usage endpoint; `limits[]` rows, a model and extra usage; a 429 reads unknown; signed out and an `apiKeyHelper` read `none` and `key`; an API key in the environment makes the same login read "no plan limits" (why the environment is cleaned); the passive events of a real stream, including a refused turn. Skipped without `claude` and `openssl`. |
| Real Docker workspace | by hand, 2026-10-12 | A portal on a scratch database, one workspace `cu-a`: the scheduler's own probe found Default signed out in 515 ms; with a fake `apiKeyHelper`, `POST …/check` answered `key`, "No plan limits"; the probe command run by `docker exec` in the container (dash, user `node`, its own `claude`) against the stand-in with a fake Max login read the windows in 316 ms, an `ANTHROPIC_API_KEY` given to the exec was dropped, and the stand-in saw no telemetry and no model request. Other agents' running workspaces were left alone (`PORTAL_CLAUDE_USAGE_ONLY`). |
| UI | by hand, 2026-10-12 | Looked at in a real browser at 390 and 1280 px, light and dark, seeded for within limits, near, high, out, not known, stale, no limits and signed out: rows, sorting, the tab count, countdowns, history, the workspace sheet's tiny meter, the toast, check now (a real probe changed a row and the count), snooze (the row, the bell, the count). |
| Usage insight (§20) | `pace`, `spend`, `palette`, `requests`, `recommend`, `exporter`, `service.insight`, `service.summary`, `service.actor`, `routes.insight`, `portalTools.insight` tests (77), and a real portal with a seeded database (38 checks) | Pace, rates, comparison, cache, palette, strip, recommendation, export and tools against numbers computed by hand: the table in §20.12. |

## 17. Milestones

| Milestone | Scope |
| --- | --- |
| K0 | This PRD and the research behind it. **Built.** |
| M1 | Server: probe runner, parser, store, scheduler, passive hook, `headroom`, routes, live topic, tests. **Built** and tried against the real CLI and a real Docker workspace (§16). Not yet called by the chat reader: the hook `onRateLimit` is assigned on the controller (`index.ts`) and waits for A2 to call it. |
| M2 | The Claudes tab, history, check now, the workspace sheet's meter, `ClaudeHeadroom` for the switch dialog. **Built** and looked at. `ClaudeHeadroom` waits for A2's switch dialog to show it. |
| M3 | Alerts (80 %, 95 %, out), toasts, snooze, the push seam (`onAlert`), the `claude_usage` Portal MCP tool, the "room elsewhere" hint. **Built.** Web Push **not built**: it does not exist in the code yet (§12). |
| M4 to M8 | Usage insight, round 4 (§20.13): contracts, quota speed and pace and the projection alert, spend speed, palette, the Requests report with comparison and cache split, the summary strip, the Move recommendation, export and tools: **Built** on the server. The pages and widgets that show it: **not built here**. |

## 18. Success

| | |
| --- | --- |
| A login, token or credentials file read, stored or logged | Never, covered by the canary |
| An email, organization or account id in a table, response, log or socket | Never |
| A model request made by the feature | Never |
| A stopped workspace woken by a probe | Never |
| Probes per Claude | At most one per interval, one per 30 s on request |
| A number shown without its age on hover or tap | Never |

## 19. Unverified, and open questions

**Unverified** (no real subscription could be signed in here, and some wiring waits on other areas):

| ID | What |
| --- | --- |
| U1 | The reply of a real plan: that the stand-in's shape (the endpoint's body passed through) matches what Anthropic sends today, including `limits[]`, per-model windows (`model_scoped` did not trigger with the stand-in, since it needs Claude Code's own allowlist) and `extra_usage`. The parser accepts the named fields, `model_scoped` and `limits[]`, so any of them works. |
| U2 | How hard Anthropic's usage endpoint rate-limits under a ten-minute poll per Claude. Claude Code treats a 429 from it as a case (📄); we back off. |
| U3 | The age of a copy Claude Code serves after a failed fetch (up to one hour, 📄): the portal cannot tell. A window whose reset time has passed is shown as reset. |
| U4 | Team and Enterprise windows (no five-hour window? seat limits?), and `authMethod` values for cloud providers (Console keys read `api_key`, a managed `apiKeyHelper` reads `api_key_helper`, env tokens `oauth_token`: ✅). |
| U5 | `seven_day_overage_included` and the passive event for a model bucket, on a real response. |
| U6 | Exec on Kubernetes and on This machine (the Docker path and a local exec are checked). |
| U7 | The chat reader calling `onRateLimit`: the hook is assigned in `index.ts` and the parser is tested on real lines, but A2's reader does not call it yet, so no live chat has fed it. |
| U8 | That the probe causes no outbox or hook event on a workspace with an account pool: a pool workspace is not probed at all (its state is `pool`), so this was not exercised; on a workspace without one, the probe wrote no session and sent no telemetry (✅, Docker). |
| U9 | `ClaudeHeadroom` inside A2's switch dialog: the component works on the snapshot (looked at in each row once), the dialog is A2's. |
| U10 | Claude Code newer than 2.1.296 keeping `--safe-mode` and its meaning: the real-CLI marker test fails the day it does not (a probe then reads nothing rather than run a hook). Managed (policy) hooks run on every poll by design (§11). |

| ID | Question |
| --- | --- |
| Q1 | The plan's tier name (§6): approved provisionally by the coordinator for the owner, who has yet to confirm. |
| Q2 | Should an exhausted Claude's row offer a button that opens the switch dialog (with the Claude with the most headroom picked), or only say there is room (built)? |
| Q3 | Should thresholds (80 and 95) be a setting in [Settings & policies](settings-policies.md)? Draft: constants, `USAGE_THRESHOLDS` in the contracts. |
| Q4 | Should a probe run for a Claude whose only chat is asleep (no process)? Built: yes, the probe is independent of sessions. |
| Q5 | Should the Usage nav item show a dot while a Claude is near a limit? Built: only the tab's count and the toasts. |
| Q6 | Round 4 (§20.14): the unverified items of the pace (UI1 to UI6), above all that it has never met a real plan. |

## 20. Usage insight (round 4, engine A)

Added 2026-10-12 at the owner's request (speed, pace, comparison, cache, colours, a summary strip, a Move recommendation, export). This section is the server half; the Usage page, the glance widgets and the Quota widget read it. Attribution, budgets and spikes are §21 to §26. It **supersedes the non-goal "Forecasting" of §4**: the portal now estimates, labels every estimate, and gates alerts on confidence. **Multi-user** (PLAN-10, not built): see §20.14.

| Part | Status |
| --- | --- |
| Contracts (`packages/contracts/src/usage.ts`, additions in `claudeusage.ts`) | **Built** |
| Quota speed, pace, outlook, next reset (§20.2) | **Built.** Checked against hand-computed fixtures and against a real portal with seeded readings (§20.12); never against a real plan (§20.14). |
| Projection alert and its own snooze (§20.4) | **Built**, through the existing sink and snapshot; tested with a clock. Not yet seen as a toast: the page is not part of this section. |
| Spend speed and spend today (§20.1) | **Built** (every rate is an estimate). |
| Cache split, previous period, stacked series, the Requests report (§20.3, §20.8) | **Built** as `GET /api/claude-usage/requests`; `GET /api/chat/usage` is unchanged. |
| Palette slots (§20.6) | **Built.** The colours and the cue that is not colour are the web's: not built here. |
| Summary strip data (§20.7) | **Built** (server). The strip is the page's. |
| Move recommendation (§20.5) | **Built**, over HTTP, as a Portal MCP tool and in-process. The switch dialog and the auto-transfer do not call it yet. |
| Export (§20.9), Portal MCP tools (§20.10) | **Built** |
| The strip live on every finished request | **Not built**: it needs a hook in the chat controller (§20.14). |
| Multi-user filter | **Seam built** (default allow); nothing filters yet. |

### 20.0 Numbers are never invented

Every derived figure is a `Figure`: `{ value, basis, reason? }`. `measured`: a stored value, or exact arithmetic on stored values (a sum, a ratio, a difference): tokens, requests, a percent a probe read, a reset time, the cache hit rate, the change in tokens between two periods. `estimate`: rests on an assumption: any rate (a request counts when it finishes), any projection, and dollars (Claude Code prices tokens at API list prices: for a plan that is what the use would cost, not a bill). `unavailable`: no number, with a fixed reason code (`no_samples`, `single_sample`, `short_span`, `period_reset`, `decreasing`, `no_growth`, `clock_skew`, `stale`, `signed_out`, `no_limits`, `no_reading`, `no_window`, `no_number`, `no_reset_time`, `window_length_unknown`, `no_requests`, `no_baseline`, `no_history`, `not_recorded`, `session_deleted`) and one short line for each (`UNAVAILABLE_TEXT`, `reasonText`). The page labels an estimate "est." with the formula in an InfoTip and shows "-" with the reason in an InfoTip. A zero is never shown for "not known": an idle quarter hour is a real zero, "no request today" is unavailable.

### 20.1 Spend speed (from the requests the portal recorded)

Source: `chat_usage`, one row per model per finished request. Tokens are input + output + cache writes; cache reads are given apart. A request is booked when it **finishes**, so a long one reads as a burst: every rate is an estimate. Terminal use of Claude Code inside a workspace is not recorded and is not counted. Dollars are Claude Code's cost figure (an estimate, §20.0).

| Figure | Formula |
| --- | --- |
| Trailing rate (`15m`) | the sum over requests that finished in (now - 15 min, now], divided by 15 minutes. Zero requests is a real zero (idle). |
| Today (`today`) | the sum since this device's midnight, divided by the minutes from the first request's start to now. A request's start is its finish minus its own recorded duration, never before midnight; the first to start decides. Unavailable: `no_requests` (none today), `short_span` (under 5 minutes). |
| Spend today | tokens, cache reads and requests measured; dollars an estimate. |

Rates are rounded to a tenth of a token and to $0.0001 a minute; sums of dollars to a hundred-millionth (no floating-point dust).

### 20.2 Quota speed, pace and projection (from the percentages Claude Code reported, never from tokens)

Per Claude and window, from `claude_usage_samples` of the **current period only** (samples whose reset time is within a minute of the latest reading's) plus the latest reading itself (an unchanged reading is not stored again for 30 minutes, so the latest reading is added at its own time). `U` = percent used at the latest reading, `t` = its time, `R` = the reset time, `L` = the window length (`session` 5 h; `week`, `week_opus`, `week_sonnet`, `week_apps`, `week_models` and `model:<name>` 7 days, by the names Claude Code gives them; `other:*` unknown). The projection stands on the reading's time, not on the clock, so it does not drift between probes. Times of an estimate are rounded to the second, percentages to a tenth.

| Figure | Formula | Unavailable when |
| --- | --- | --- |
| `speed` (points per hour) | slope of the least-squares line through the period's readings (3 or more), first to last (2) | one reading (`single_sample`), under 10 minutes between first and last (`short_span`), the percent fell (`decreasing`), reading times in the future (`clock_skew`), the reading is old (`stale`), the window reset and no reading of the new period yet (`period_reset`), no percent (`no_number`), never read (`no_reading`), no reset time (`no_reset_time`) |
| `projectedPct` | `U + speed x (R - t)`; can pass 100 | as `speed` |
| `etaAt` | `t + (100 - U) / speed` | as `speed`; `no_growth` at speed 0 |
| `status` | `exhausted` if `U >= 100` (measured); `over` if `projectedPct > 100`; else `under` (estimates) | as `speed` |
| `evenPct` | `100 x (t - (R - L)) / L`, clamped 0 to 100 | `window_length_unknown`; the same guards as `speed` except the rate ones |
| `aheadPts` | `U - evenPct` | as `evenPct` |
| `lowConfidence` | fewer than 3 readings, or a span under `max(10 min, L / 10)` | a flag, never unavailable |

Hand-checked example (a test): 10 % at 00:00 and 20 % at 01:00, now 01:00, the session resets at 04:00 (so it began at 23:00): speed 10 points/h; projected 20 + 10 x 3 = 50 %; ETA 01:00 + 8 h = 09:00, after the reset: `under`; even pace 100 x 2 h / 5 h = 40 %, so 20 points behind an even spend. Another: readings of 10, 25 and 40 % at 0 h, 1 h and 3 h: least squares gives 135/14 = 9.6 points/h where first to last would give 10.

`outlook` of a Claude looks only at the windows that stop it altogether (`session`, `week`; a model's own week stops only that model): `exhausted` if one is used up; else `over` with the one that runs out first (the earliest ETA); else `under` (the fullest); unavailable, with the reason, for a pool or key (`no_limits`), signed out, not read (`no_reading`), no such window (`no_window`) or no usable pace. `nextReset` is the soonest future reset of any window (measured).

### 20.3 Cache split

`hitRate = cache reads / (cache reads + uncached input + cache writes)`: the share of input tokens the prompt cache served (what the Requests tab already calls "from cache"). Exact arithmetic on stored counts: measured; unavailable (`no_requests`) with no input. The report gives uncached, written, read and the rate for the totals and for every Claude and model row; `cacheSplit` in the contracts is the one rule for the server and the page.

### 20.4 Projection alert ("will run out before reset")

A new alert kind beside the threshold alerts, through the same machinery (the `onAlert` sink, the `claudeusage` live topic, the snapshot's `alerts`). It fires **once per Claude, window and period** (the period ends at the window's reset), only for `session` and `week`, only when `status` is `over`, `lowConfidence` is false (three readings over at least a tenth of the window) and the window is not exhausted yet; a projection that falls back and rises again in the same period does not repeat, and one that crosses while the Claude is snoozed stays quiet for the period. Its id is `<claudeId>|<window>|projection|<reset ms>`; it carries `kind: 'projection'`, `etaAt` and `projectedPct`. The snapshot lists it only while it still holds, with the estimate as it stands now. Its **own snooze** (`PUT .../snooze {until, kind: 'projection'}`, `DELETE ...?kind=projection`) silences only projections; the Claude's ordinary snooze silences both. The notification package subscribes to the sink for "quota about to run out".

### 20.5 Move recommendation

`GET /api/claude-usage/recommend?workspaceId=&from=`: the other Claudes of the workspace (a chat stays in its workspace), ranked, each with a reason code and its basis. Order: Claudes with at least 20 % of their fullest window left (`room`, or `over_pace` when their outlook says they run out before they reset, which subtracts 20 points) by percent left, the sooner reset on a tie; then Claudes with no plan limits (a pool or key: nothing to run out of, billed per use); then `tight` ones (under 20 % left). Exhausted (by when they return), unknown and signed-out Claudes follow with `rank: null`. Only the best of `room`, `over_pace` or `no_limits` is `recommended`; a signed-out, exhausted, unknown or `tight` Claude never is, and `none` says why nothing is (`no_other_claude`, `none_ready`, `all_tight`). The percent left is measured; `over_pace` is an estimate and says so in `basis`. The two constants (20 %, 20 points) are this section's choices. A recommendation is advice: the portal never moves a chat by itself. Only Claudes the asking user may use are listed (§20.14).

### 20.6 Palette (one colour per Claude and per model, everywhere)

The server gives each Claude and each model a stable slot, 0 to 7, on first sight, and keeps it (table `usage_palette`, migration 170). A Claude is keyed by its id, a model by its id; slots are per kind. The lowest free slot, in order of first request. When all eight of a kind are taken, the slot of the key not seen for 45 days is reused (older than any report window, so no page can show both); with none that old the newcomer gets `null` (not kept): the neutral grey, "Others". The values (an Okabe-Ito based set checked against deuteranopia, protanopia and tritanopia) and the cue that is not colour (legend order, direct labels, a pattern) belong to the web (`apps/web/src/lib/usage`). On a store that cannot be written the slots are worked out and not kept. Slot 0 to 7 is also on every Claude of the snapshot, every row of the Requests report and every Move candidate; `GET /api/claude-usage/palette` lists them all.

### 20.7 Summary strip

`GET /api/claude-usage/summary?claudeId=&tz=`: spend today (est.), speed (trailing and today), time until the limit (`limit.etaAt`, the page counts it down; the soonest `over` among the Claudes in scope, else the fullest), next reset (the soonest of any window), and the same per Claude, the most spent first. `tz` is the viewer's `getTimezoneOffset()`. The overall spend counts every request, even of a Claude that is gone; with a Claude picked, its requests only.

### 20.8 Comparison with the previous period

`GET /api/claude-usage/requests?range=&claudeId=&tz=` is `GET /api/chat/usage` and more: the same bucket rule (`usageWindow` in `chat/usage.ts`) and a `previous` period of the same length, bucket for bucket, with the percent change of cost (est.), tokens (input + output + cache writes) and requests. `coverage` says whether the portal's recorded history reaches back to the period's start (`full`), began inside it (`partial`) or after it (`none`); the change is unavailable (`not_recorded`) unless `full`, and a zero base is `no_baseline`. The report also carries, per Claude and per model, the totals, the cache split, the palette slot and the per-bucket series (for stacked charts; `null` where nothing ran). A request recorded without a Claude (before Claudes existed) is counted under its workspace's Default Claude here, so Default's earlier and later requests are one row; `GET /api/chat/usage` still lists them apart.

### 20.9 Export

`GET /api/claude-usage/export?what=requests|quota&format=csv|json&range=&claudeId=&tz=`, a download (`Content-Disposition: attachment`, `nosniff`, no cache). Requests: JSON is the whole report; CSV is one row per bucket, Claude and model with tokens measured and the column `cost_usd_estimate`. Quota: the plan readings of 1d, 7d or 30d, every stored reading (not thinned): CSV `at, claude, workspace, window, used_pct`. A cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return is made plain text with a leading `'` (spreadsheet formula injection); a number is never defused.

### 20.10 API and Portal MCP

Routes under `/api/claude-usage` (behind the session guard): `summary`, `requests`, `recommend`, `palette`, `export` (GET) and the existing ones; `PUT`/`DELETE` `/:claudeId/snooze` take `kind: 'projection'`. Portal MCP, all read-only: `claude_usage` (now with each window's pace and the Claude's outlook; an agent still reads only its own Claude), and for admin tokens only `claude_usage_summary`, `claude_usage_report` (with the previous period and the cache split; a model's name is labelled untrusted) and `claude_move_advice` (it names other Claudes). Every figure in a tool answer is `{ value, basis, reason?, why? }`. In-process, on the object `createClaudeUsage` returns: `recommend(workspaceId, fromClaudeId?, actorId?)`, `recommendFrom(fromClaudeId, actorId?)`, `outlook(claudeId): { headroom, limit }` (never throws, never probes), `headroom(claudeId)` and `onAlert(fn)`.

### 20.11 Data model

Migration 170: `usage_palette (kind, key, slot, first_seen_ms, last_seen_ms)`, primary key (kind, key), one key per slot and kind. Migration 171: `claude_usage_latest` gains `proj_alerted` (JSON: per window, the period a projection was told for, when, the estimate, whether quiet) and `proj_snoozed_until_ms`. No other new store: the rates read `chat_usage`, the pace reads `claude_usage_samples`. No new dependency.

### 20.12 Testing

Every expected value is computed by hand and written in the test next to its fixture; no test asserts a number only because the code produced it.

| Case | Covered by | Expected (by hand) |
| --- | --- | --- |
| Pace: the owner's example; three linear readings (30 points/h, 130 %, out at 03:00, over); exactly 100 % at the reset is under; least squares 9.6 against first to last 10; the period that ended is left out; a reset time a few seconds off is one period; the latest unstored reading counts; one reading, under ten minutes, zero speed, a falling percent, each missing piece (no number, reading, reset time, reset passed, old, clock in the future); a flat fractional percent is zero speed; a used-up window (measured); a week (even pace 28.6, 1.4 ahead); confidence by window length; a window of unknown length | `pace.test.ts` (24) | The values in §20.2 and in the test comments. |
| Outlook and next reset: over with the earliest ETA, under with the fullest, exhausted, every reason, several Claudes as one | `pace.test.ts` | as above |
| The service over scripted probes: pace and outlook in the snapshot; pool, signed out and unread each say why; the projection alert once on three readings (not on two) with its estimate (130 %, ETA 04:00), again in a new period (150 %, ETA 08:20), its own snooze and the Claude's, a weekly burst of an hour never alerts; `noteSpend` | `service.insight.test.ts` (8) | |
| Spend speed: trailing 113.3 tokens/min, $0.02/min; today 49.7 over 155 min; idle zero; none today; under five minutes; a request that began before midnight; the viewer's midnight; Default's requests; the reader | `spend.test.ts` (10) | |
| Palette: first sight, stable, nine keys, recycling after 45 days, a store that cannot be written | `palette.test.ts` (3) | |
| The Requests report: totals, hit rate 8/15, by Claude and model, series, previous period (+275.0 % est., +133.3 %, +100.0 %), partial, none and full coverage, a zero base, one Claude, the viewer's clock | `requests.test.ts` (6) | |
| The strip, the recommendation and the palette through the service | `service.summary.test.ts` (4) | |
| Move ranking: scores, the over-pace penalty, ties, no limits, tight, exhausted, unknown, signed out, none, the old reading | `recommend.test.ts` (9) | |
| Export: escaping, formula injection, both files | `exporter.test.ts` (4) | |
| Routes: shapes, refusals, download headers, the snooze kind | `routes.insight.test.ts` (3) | |
| Portal MCP: pace in `claude_usage`, the three admin tools, an agent cannot call them | `portalTools.insight.test.ts` (3) | |
| Multi-user seam: a user sees only the Claudes they may use, a throwing seam hides | `service.actor.test.ts` (3) | |
| A real portal on a scratch data directory, probes off, K8s off, a real Docker workspace, a seeded database (2026-10-12) | by hand, 38 checks of the real HTTP answers against numbers worked out from the seed | Default's session read 10, 25, 40 % over an hour: speed 30/h, projected 130 %, out two hours after the last reading, outlook over; Satria 70 % once: no speed (`single_sample`), 50 points ahead of an even pace, 30 % left; today $2.62 (est.), 7000 tokens, 22000 read, 5 requests; trailing 180 tokens/min and $0.0667/min; the Requests report for a day: 6 requests, $3.22, hit rate 22000/27700, +222.0 % cost, +190.7 % tokens, +200.0 % requests against the day before; slots kept; both recommendations; both exports; the snooze kind; 422, 404 and 401. All passed. The portal's own `GET /api/chat/usage` gave the same totals. |

### 20.13 Milestones

| Milestone | Scope | Status |
| --- | --- | --- |
| M4 | Contracts (`usage.ts`, additions in `claudeusage.ts`) | **Built** |
| M5 | Quota speed, pace, outlook, projection alert and its snooze | **Built** (§20.2, §20.4) |
| M6 | Spend speed, palette, the Requests report with comparison, cache split and series, the summary strip | **Built** (§20.1, §20.3, §20.6 to §20.8) |
| M7 | Move recommendation, export, Portal MCP tools, the in-process API | **Built** (§20.5, §20.9, §20.10) |
| M8 | The pages and widgets that show all of this | **Built** for the Usage page and the Move dialog (§27); the glance widgets are their own PRD |

### 20.14 Multi-user, unverified, and open

**Multi-user** (PLAN-10; not built, one seam in place). A Claude is a shared platform resource: its usage is visible to the users who may use it; per-session and per-request usage to the session's owner and to admins. The snapshot, the Requests report, the summary, the export and the Move recommendation take an `actorId` (today `u_owner`, `OWNER_ACTOR`) and filter through the optional `canUseClaude(actorId, claudeId)` of the monitor's options (absent: everyone may; a seam that throws hides). The Move recommendation therefore lists only the Claudes the asking user may use. Today's single-owner behaviour is unchanged.

| ID | Unverified or open |
| --- | --- |
| UI1 | **Never run against a real plan.** The pace stands on fixtures, scripted probes and a seeded database. Not known: the resolution of the percentages a real plan reports (assumed one point or finer), how a probe's reading and a live event's round against each other, and whether a weekly window's period really begins at its reset time minus seven days (the even pace and the status inherit that). |
| UI2 | The confidence rule (three readings, ten minutes, a tenth of the window) and the 45-day palette rule, 20 % and 20 points of the recommendation are this section's choices, not measured ones. They want a week of real use. |
| UI3 | A request counts when it finishes, so a long request is a burst; rates leave out terminal use and anything the portal did not record. |
| UI4 | The strip is not pushed when a request finishes: the chat controller would call a hook after it records a turn (`onUsageRecorded`), and the portal would notify `claudeusage`. Until then the page refreshes on the existing pushes and on its own timer. |
| UI5 | The projection alert has not been seen as a toast, and nothing calls the recommendation yet (the switch dialog, the auto-transfer). |
| UI6 | ~~The colours are not defined yet.~~ Defined and validated in §27.1 (`apps/web/src/lib/usage`). |

## 21. Usage spend (round 4, engine B)

Added 2026-10-12 at the owner's request: usage attributed per session, workspace, ticket and persona with child sessions rolled up into their parent, a daily or monthly budget per Claude or workspace with alerts, and spike detection (an agent that is looping). This is the server half (module `apps/server/src/usagespend/`, contracts `packages/contracts/src/usagebudget.ts`); the Usage page reads it. The speed, pace, comparison and palette are §20. **Multi-user** (PLAN-10, not built): §26.4.

| Part | Status |
| --- | --- |
| Contracts, routes' paths (§26.1) | **Built** |
| Attribution by session (a tree), workspace, ticket, persona, Claude; CSV (§22) | **Built** (server). Checked against hand-computed fixtures and a real portal with a seeded database (§25). |
| Persona per session (§22.3) | **Partly built.** It is not recorded anywhere today (a persona is a pool assigned to the workspace). It is recorded from now on, at each process start; requests before that are `unknown` with `not_recorded`, never guessed. |
| Budgets: alerts at 80, 95 and 100 %, snooze, owner, audit (§23) | **Built** |
| Budgets that pause new messages (§23.5) | **Built**, opt-in, through one seam in the chat controller (`sendGate`). |
| Spike detection: rate, loop, single request (§24) | **Built** as heuristics with their evidence. A runaway inside one turn is seen only when the turn ends. |
| Portal MCP: four read tools, two admin tools (§26.2) | **Built**, checked over the real endpoint. |
| The pages: attribution tables, budgets, spikes, toasts, export buttons | **Not built here** (the Usage page, round 4 wave 2). |
| A ticket claimed by a session that was not started for it (`tickets.assignee`) as an attribution link | **Not built** (§22.2). |
| Multi-user: the owner, the audit, the visibility filter | **Seam built** (default allow); nothing filters yet (§26.4). `by=user` is **not built** and has one place to plug in (§22.1). |

### 21.1 What the numbers rest on

The source is `chat_usage`: one row per model per finished turn, the turn's sub-agents included; the first row of a turn carries its request, its sub-agent count and its time. A **request** is a finished turn, so the sum of `requests` is the number of turns, and a request's sub-agents run inside it and are counted once, in it. A **child session** is another session (`chat_sessions.parent_id`), with rows of its own: that is what rolls up. Everything here follows §20.0: tokens and counts are `measured`, **every dollar figure is an `estimate`** (Claude Code prices tokens at API list prices; for a plan it is what the same use would cost, not a bill), and a figure that cannot be given is `unavailable` with a reason (`no_samples`, `no_cost` for requests that reported no dollars, `no_history`, `not_recorded`, `session_deleted`). **Tokens** for a budget are input + output + cache writes; cache reads are shown beside them, not added.

A request recorded without a Claude (before Claudes existed) counts under its workspace's Default Claude (the `workspace_claudes` row with an empty directory), else under `default:<workspace id>`, the same key the palette uses.

### 21.2 Data model

| Table (migration) | Holds |
| --- | --- |
| `usage_sessions` (180) | One row per session that has requests: workspace, Claude, parent, ticket, title and first and last request time, refreshed at each recorded turn and filled for the sessions that exist when the migration runs. It exists because `chat_usage` outlives its session: after a delete the title and the parent link are still here, so a child's cost still rolls up. |
| `usage_persona` (180) | `(session, time, persona pool id or NULL, name, revision)`: the persona a session's workspace had assigned when its process started, **one row per change** (a launch with the same persona adds nothing). NULL means none was assigned. |
| `usage_budgets` (181, 183) | `id, name, scope_kind (all, claude, workspace), scope_id, period (day, month), limit_usd, limit_tokens, mode (alert, pause), enabled, snoozed_until_ms, alerted (JSON: the highest level told in a period), created_by, created_at, updated_at`. At least one limit; `scope_id` is NULL exactly for `all`. |
| `usage_spikes` (182, 183) and `usage_spike_snoozes` (182) | An event: time, kind, subject (what a snooze and the cool-down key on), session, workspace, Claude, the evidence (JSON), whether it alerted, owner. Kept 90 days. A snooze is a subject and a time. |
| `usage_audit` (183) | Who (`actor`), how (`via`: `ui` or `portal-mcp:<token id>`), what (`budget.create`, `.update`, `.delete`, `.snooze`, `.unsnooze`, `spike.snooze`, `.unsnooze`) and one terse line. Ids and what was set, never usage amounts or workspace text. Kept 90 days. |

## 22. Attribution

`GET /api/usage-spend/attribution?by=session|workspace|ticket|persona|claude&range=30m|1h|12h|1d|7d|30d&claudeId=&workspaceId=&limit=&format=json|csv`: the requests of a rolling window ending now, grouped by one dimension. Every request is in exactly one row, so the rows add up to the window's total (by session, the roots do). A side question's row (`chat_usage.kind = 'side'`, [chat](chat-sessions.md) §20) is a request like any other, inside its session's row and the total; the report also gives those rows apart as `side` (the same `SpendTotals` shape; 0 when the window has none), so a page can say "of which side questions". Built 2026-10-13 (server; the page does not show it yet); `attribution.test.ts` and `service.test.ts` check it. A side question's row also reaches budgets and spike detection the moment it is written (`chatController.onSideUsage`, wired to the same `onTurn` as a turn's row in `index.ts`), not at the next turn.

### 22.1 The dimensions

| By | A row is | Notes |
| --- | --- | --- |
| `session` | a session, in a tree: the session, then the sessions it started | `own` is the session's own requests; `total` adds every session below it. Rows come in tree order with `session.depth`; siblings by dollars. A parent with no request of its own is a row so its children hang from it. A chat **continued as a new row** (`continued_from`, T-136 lineage) is one unit (T-312): each later row sits one level under the chain's **first** row, however long the chain, so that row's `total` is the chain's and every segment stays visible (`session.continuedFrom` names the row it continues; the first row is a row even with no request in the window). A session's own view (`sessionId`) does not climb into the chat it continues. `limit` caps the **root** rows (default 25, at most 200); the roots past it sum into `others`, with their children. |
| `workspace` | where the request ran | |
| `claude` | the Claude the request ran on | A chat that moved to another Claude counts each turn where it ran. |
| `ticket` | the session's ticket (`chat_sessions.ticket_id`) | A child with no ticket of its own counts under its parent's, all the way up, and a continuation under the ticket of the row it continues (the chain first, then the parent) (a helper's cost belongs to the work that started it). No ticket anywhere is `none` ("No ticket"); a session whose links were never kept is `unknown` (`session_deleted`). |
| `persona` | the persona recorded at or before the request (§22.3) | `none` is recorded as having no persona; before a session's first record the request is `unknown` (`not_recorded`). A persona never passes down to children (a child may run in another workspace). |
| `user` | **Not built** (PLAN-12, after multi-user) | It plugs in here, and only here: one entry in `GROUPERS` (`attribution.ts`), a function of the request and its session, whose key is `creatorOf(root session)` (`actor.ts`: `u_owner` today), so a child rolls up to the creator of the root through the one `lineage` / `rootOf` helper that the ticket and the tree already use. Requests from before users existed would be an unattributed group with a later reason (`pre_multiuser`), never a 0. The figure is an **estimate** of API-equivalent dollars and tokens per user; a plan's quota (§20.2) belongs to the **Claude account** and is shared by whoever uses it, so no per-user share of the quota can be measured or claimed. A test plugs a `user` grouper in without touching the module (§25). |

### 22.2 What is and is not a link

`ticket_id`, `parent_id` and `continued_from` are columns of `chat_sessions`, set when a session is made (a ticket starting one, an agent starting a helper, a new chat continuing an ended one). `continued_from` is not kept in `usage_sessions`: once a row of a chain is deleted, the rows after it no longer roll up through it (a continuation whose predecessor is not known falls back to its parent). The `tickets.assignee` link (an agent that **claims** a ticket for a session started for something else) is not used: it would need the ticket's assignment timeline to attribute only the requests made while it was assigned, and two claims at once are ambiguous, so it is **not built** and a claim-driven session shows as "No ticket". A session deleted before this module kept its links (a request whose session is gone and was not in `usage_sessions`) is still a row, named by its id and marked `exists: false`, a root, with `session_deleted` for its ticket.

### 22.3 Persona: not recorded per session

A persona is a pool assigned to a workspace and delivered as a file Claude Code reads when a process starts; nothing stored which persona a session ran with. So the chat controller calls `onLaunch` whenever a process starts (a new session, a wake, a resume, a move) and the module records `personaFor(workspace)` when it differs from the last record of that session. A request is attributed to the newest record at or before its time. This is the persona the portal had assigned at the start, which is what the process was told unless the delivery lagged; a persona assigned later is seen at the next start. Sessions that were already running when this was added have no record until their next start: their earlier requests are `not_recorded`, and the report's `coverage` says how much of the window's dollars that leaves. A persona lookup that fails records nothing (never "none"). The persona's name shown is its name now, else the one recorded.

### 22.4 The figures

`share` = a row's `total` dollars / the window's dollars x 100, to two decimals, an estimate; unavailable with `no_samples` when the window has no request and `no_cost` when its requests reported no dollars (never 0 % or NaN). `coverage` = the dollars of rows that are `known` or `none` / the window's dollars x 100 (100 for every dimension but `persona` and `ticket`). The `none` and `unknown` rows are never folded into `others`, so the reason stays visible. An **unattributed** group (`state: unknown`) is a concept of its own (`unattributed(reason)` in `attribution.ts`): its totals are the real sums of the requests whose attribution is not known, and the row carries the reason (`not_recorded` for a persona, `session_deleted` for a ticket; `pre_multiuser` will be one more line), so the page shows the reason and the numbers and never a 0 for an unknown person, ticket or persona.

### 22.5 CSV

`format=csv` answers the rows as a file (`Content-Disposition: attachment; filename="usage-by-<by>-<range>.csv"`), one line per row: `by, key, label, state, reason, cost_usd_estimate, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, requests, agents, own_cost_usd_estimate, own_requests, share_pct_estimate, sessions, first_at, last_at`, then for sessions `depth, parent_id, workspace, claude, ticket, session_exists`. A session title comes from people and agents, so a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'` (the rule of §20.9); cells with a comma, a quote or a line break are quoted.

## 23. Budgets

### 23.1 What a budget is

A **daily or monthly** limit for **everything**, **one Claude** or **one workspace**, in **estimated dollars**, in **tokens**, or both (at least one; each above 0; at most 50 budgets). It **alerts and does nothing else** unless a person sets its mode to `pause` (§23.5). It can be switched off without losing it. A budget on a Claude counts the requests recorded without one when that Claude is the workspace's Default (§21.1). A budget is made with `POST /api/usage-spend/budgets` (the scope is checked: a workspace that does not exist, or a Claude the portal has no record of, is refused with the field) and changed with `PUT` (only what is sent; `null` clears a limit so long as the other stays).

### 23.2 The clock

Days and months need one clock for the whole portal, whoever has a page open: the Settings key `usage.timezone` (an IANA name; **UTC** when empty or not a name the runtime knows). A day runs from the zone's midnight to the next; a month from the 1st. The boundaries are found on the wall clock and converted back to an instant, so a day with a clock change is 23 or 25 hours long. Hand-checked: Jakarta (UTC+7) at 20:00 UTC on the 12th is 03:00 on the 13th, so its day is 17:00 UTC to 17:00 UTC; New York on 8 March 2026 has a day of 23 hours (05:00 UTC to 04:00 UTC the next day) and on 1 November 2026 one of 25 (04:00 to 05:00 UTC); a request at the first instant of a period belongs to it. Changing the setting moves every budget's boundaries.

### 23.3 What it measures

`used` = the sum of the requests of the scope from the period's start to now: dollars (`estimate`) and tokens (input + output + cache writes, `measured`). `usedPct` = the larger of `used dollars x 100 / limit dollars` and `used tokens x 100 / limit tokens` (dollars when they tie; the `limiting` field says which), so it can pass 100. **Levels** reuse the plan windows' thresholds: `near` from 80 %, `high` from 95 %, `exhausted` at 100 %; exactly on the line counts. The state is read from the requests each time, never from a counter that could drift.

### 23.4 Alerts

After every recorded request, each enabled budget that counts it is looked at. Per budget and period the **highest level told** is kept (`alerted`: level, period start, time, the percent then): a level is told once, a higher one when it is crossed, and a new period starts over. While the budget is snoozed a crossing is kept **quiet**: never shown, and not told late when the snooze ends (a higher level still is). Changing a budget's scope, period or limits starts its alerts over so they follow the new numbers; changing its name, mode or switch does not. A budget made when its period is already past a threshold says so at once. The alert (`SpendAlert`, kind `budget`) has a stable id `budget|<budget id>|<level>|<period start ms>`, the level, the scope, the owner and the workspace it concerns, and one terse line ("api daily: 95 %", "Everything monthly: used up", "Satria guard: used up · paused"). The list of alerts holds those of the last day for budgets that are not snoozed whose period is not over.

### 23.5 Pausing (opt-in)

A budget in mode `pause` refuses **new messages** once it is used up. The chat controller asks `sendGate` at the top of `send`, before anything is stored or sent, and throws `409 USAGE_BUDGET` naming the budget, what it used ("$5.00 of $5.00, estimated"), when it resets (on the portal's clock) and what to do ("raise it or set it to alerts only in Usage › Budgets"). Everything that sends goes through it (a person, a ticket, CI, an agent messaging its parent, the Portal MCP). It does **not** stop a running turn, does not touch approvals, Stop or a move's own messages (the handoff request, the opening), and does not remove what was already queued. Raising the limit, setting the budget to alerts only, switching it off, deleting it or the period ending lets messages through at once. A budget that pauses **cannot be snoozed** (409; its alerts are the warning), and setting a budget to pause clears a snooze it had. A budget that cannot be read, or a gate that throws, never blocks a message. Never a surprise: the mode is a person's choice, shown on the budget, and the alert says "paused" when it happens.

## 24. Spike detection

Three rules of thumb, each a comparison of one number with a baseline the portal can show. They are **heuristics**: an event says "this looks unusual, here is the evidence", never "this is wrong", and the only thing one does is raise an alert (an in-app one; nothing is stopped). Each runs after a recorded request, can be switched off as a whole and has its sensitivity in Settings (§24.3).

### 24.1 The rules

| Rule | Fires when | Needs | Subject, cool-down |
| --- | --- | --- | --- |
| **rate** | a Claude's spend in the trailing 15 minutes is at least `rateFactor` (default 3) x P90, the 90th percentile (nearest rank: the value at rank ceil(0.9 x n)) of that Claude's **active** 15-minute periods (spend above 0) over the 7 days before, and at least `minUsd` | 8 active periods (else no baseline: `no_history`, and nothing is said) | the Claude, 30 min. The chat is named when one spent at least half of the window (a continued chat's rows summed, named by its first row). Looked at most once a minute per Claude. |
| **burst** (loop) | one session (with the rows of its continued chat before it) finished at least `burstRequests` (default 20) requests inside 10 minutes, whatever they cost: a loop **between** turns (a ticket, CI or another session answering each other) | nothing | the chat's first row, 60 min |
| **outlier** | one request cost at least `outlierFactor` (default 10) x the median request of its Claude over the 7 days before (the mean of the two middle values when even), and at least `minUsd` | 20 earlier requests that cost something (else `no_history`) | the chat's first row, 5 min |

Why P90 and not the mean or the median for `rate`: the spend of an active period is right-skewed, so "5 x the median" is exceeded by roughly one active period in twenty on an ordinary day; "3 x the 90th percentile" by roughly one in a hundred. By hand (the test): periods of $1 to $10 have P90 = $9, so the line is $27: $26.50 is quiet, $30 is a spike at 3.33 x; eight periods of $1 put the line at $3.

### 24.2 Events and alerts

An event keeps its evidence, every number with its basis (dollars and ratios `estimate`, counts `measured`): `rate` has the spend, the P90 baseline, the factor, the number of periods and the top session; `burst` the requests, the window, the threshold and the spend; `outlier` the cost, the median, the factor and the number of requests it is the median of. `summary` is one terse line ("20 requests in 10 min (limit 20)", "$30 in 15 min, 3.3x the usual", "A $11 request, 10x the median"), and every event says `heuristic: true`. An alert carries a stable id `spike|<event id>`, level `near` (a heads-up, not a quota level), its scope (a Claude for `rate`, a session for the other two) and no session text. A **snooze** (`PUT /spikes/snooze`, subject = the session or the Claude, 1 h, 4 h or a day) records further events without alerting and hides the earlier alerts of that subject while it lasts. Events are kept 90 days.

**A continued chat is one subject (T-312).** A chat continued as a new row (`continued_from`) is one unit, as in attribution (§22): the
subject of a burst or an outlier, and so its cool-down and its snooze, is the **first** row of the chain (`chainRootOf` in
`usagespend/attribution.ts`, the one grouping); the burst counts the requests of the session and of the rows it continues
(`chainOf`); a rate spike sums each chat's rows in the window and names the first row. The event still names the row it happened in
(`sessionId`), so every segment stays visible; the alert carries `rootSessionId`, and its notification (`cost_spike`) keeps the row it
happened in as its subject (the link, the "already looking at it" check) with `root` in its facts and the tag `cost:<root>`, so a
chain's notifications replace each other instead of piling up. Events recorded before this keep the row as their subject. As tested
(`usagespend/service.test.ts`, the 2026-10-13 orchestrator chain fe3df8bc → fdb140be → 5c9fcb5f): 10 requests in the second row and 10 in
the third inside 9.5 minutes is one burst under the first row (each row alone is under the limit of 20, and without the chain nothing is
said); a snooze of the first row mutes a later loop in the third; $3 + $3 of the chain against $4 of another chat is a rate spike that
names the chain at 60 % (no row alone has half). Events of a parent and the sessions it started are not merged: a child is its own chat.

### 24.3 Settings

Under Settings › Usage: `usage.spikes.enabled` (on), `usage.spikes.rateFactor` (3, from 1.5 to 100), `usage.spikes.burstRequests` (20, from 3 to 1000), `usage.spikes.outlierFactor` (10, from 2 to 1000), `usage.spikes.minUsd` (0.5, in estimated dollars: rate and single-request spikes below it are ignored) and `usage.timezone` (§23.2). A value out of range falls back to its default rather than disabling a rule; a change applies from the next request.

### 24.4 What it cannot see

A request is recorded when it **ends**, so a runaway **inside one turn** (a tool call repeating for an hour) is seen only when that turn finishes, as an outlier; the per-session spend cap (`--max-budget-usd`, pool keys only) is what bounds it in flight. Use of Claude Code in a terminal is not recorded. A thin history says nothing rather than guessing (`no_history`). The thresholds are this section's choices, not measured ones (§26.6).

## 25. Testing and verification

Every expected value is computed by hand and written in the test next to its fixture; no test asserts a number only because the code produced it. 63 tests in `apps/server/src/usagespend/`.

| Case | Covered by | Expected (by hand) |
| --- | --- | --- |
| Time zones: UTC; Jakarta (UTC+7); New York's 23-hour and 25-hour days (8 March and 1 November 2026); the first instant of a period belongs to it; December into January; the offset | `periods.test.ts` (5) | 20:00 UTC on the 12th is the 13th in Jakarta, day 17:00 to 17:00 UTC, month 17:00 UTC on the 31st to 17:00 UTC on 30 November; 05:00 to 04:00 UTC is 23 hours, 04:00 to 05:00 UTC is 25. |
| Attribution, pure: six sessions, $11.50 and 7 requests. The tree (roots add up: 6.75 + 4.00 + 0.75), own against total, shares 58.70 / 26.09 / 19.57 / 2.17 / 34.78 / 6.52 %; the limit and Others; ticket (T-1 3.75 with its helpers, T-2 3.00, none 4.00, unknown 0.75, coverage 93.48 %); persona (Dev 5.00, Ops 0.50 under its current name, none 2.00, not recorded 4.00, coverage 65.22 %); workspace and Claude; nothing recorded; requests that cost nothing (`no_cost`); a parent that is gone, a cycle of parent links, a parent with no requests; the lineage and root helper; an unattributed group; **a `user` grouper plugged in** (alice 3.50 with her helpers, bob 4.00, not known 1.00 of 8.50) | `attribution.test.ts` (15) | as written in the test |
| Spike rules, pure: P90 of ten values is the 9th (line $27: $26.99 quiet, $27 a spike at exactly 3 x; seven periods say `no_history`, eight are enough), the median of an even count, the 19th request of a loop is quiet and the 20th is not, a median of $1.05 (line $10.50: $11 is a spike at 10.48 x, $10.40 is not, 19 requests say `no_history`), the evidence and its one-line summaries | `spikes.test.ts` (5) | |
| Budgets, pure: the levels at 79.99, 80, 94.99, 95, 99.99 and 100 %; the fuller of dollars and tokens (80 %, 90 % tokens, a tie to dollars, 150 %); validation with the field named; an update names only what changes; what restarts a budget's alerts | `budgets.test.ts` (5) | |
| The service on a real store and the real migrations: a daily budget of $10 on one workspace from $7.50 (75 %) to $8.10 (near), $9.50 (high), $10.00 (used up), $11.00 with nothing told twice and yesterday's and another workspace's requests left out, then the next day from 20 %; tokens (600 of 1,000, cache reads not counted, 90 % near); a snooze keeps a crossing quiet and a higher level is told after it; the pause gate (the message, the 409, another Claude, raising, alerts only, off, the next day, no snooze for a pausing budget); Jakarta's clock and an unknown zone; made, changed, removed, 50 at most; a loop of 20 in 10 minutes (one event, the hour's cool-down, a snooze records without alerting); a $11 request against a $1.05 median and a quarter hour against a $1.80 P90 (10.48 x and 6.11 x, both found); just under the lines, too little history, switched off; the report's ranges and out-of-range settings; persona recorded once per change; attribution from the database with a deleted child still rolled up, a request without a Claude under the Default one, one session's tree, a window of an hour; a session kept at its latest request; a failure logged once; the Default Claude's budget; migration 180 on existing data; the alert sinks; owners, the audit trail (who, how, what) and the visibility seam | `service.test.ts` (20) | as written in the test |
| HTTP: the contract's paths answer; the JSON; the CSV byte for byte (a title `=1+1, "quoted"` becomes `"'=1+1, ""quoted"""`); the budgets' lifecycle with 201, 400, 404, 409, 422; spikes and their snooze; the audit trail | `routes.test.ts` (5) | |
| Portal MCP through the real endpoint: an admin's token reads the portal (today $7.00, three requests, shares 57.14 / 42.86 / 28.57 %), an agent only its own tree and the budgets that count it, only an admin's token changes a budget and says what it did, pausing and removing ask first, spikes with their evidence | `portalTools.test.ts` (5) | |
| The three seams with a real controller on a fake host: a launch records the persona, a finished turn is told with the very time it was stored under, a pausing budget refuses a message before anything is stored or sent, alerts only or a failing gate let it through | `controllerHooks.test.ts` (3) | |
| Regression | chat, qa, settings, store and portalmcp suites (416); the whole server suite after the last change but the Connect track's unfinished tests (1521 tests: 1505 pass, 15 skipped, one timing flake in `browser/gate.test.ts` that passes alone, 16 of 16) | Connect's tunnel and host-service tests (`src/connect/**`, another area, in progress) fail; none of my areas does. The full suite before those files existed: 1512 tests, 1497 pass, 15 skipped, 0 fail. |
| A real portal on a scratch data directory (2026-10-12; Kubernetes off, a seeded database, schema 183 migrated from nothing) | by hand, the real HTTP and MCP answers against numbers worked out from the seed | Three sessions (P with its child K, and W), $1.00, $2.00 and $4.00: today $7.00, 700 input tokens, 3 requests. By session W $4.00 (57.14 %), P $3.00 with $1.00 of its own (42.86 %), K $2.00 (28.57 %). By ticket T-1 $3.00 (the helper counts under it) and none $4.00. By persona Reviewer $1.00 and not recorded $6.00 (`not_recorded`), coverage 14.29 %. A budget of $2.50 on one Claude read 120 % and used up; raised to $10 it read 30 %; a pausing budget of $4 read 100 % and paused, and its snooze answered 409; delete 200, again 404; the audit trail listed all seven changes with who and how; a foreign Origin 403, no sign-in 401; the Settings page listed the Usage group; `tools/list` over `/mcp` listed the six tools, a pause asked for confirmation first, an alert-only budget was made at once and audited as `portal-mcp:<token>`. All passed. |

## 26. Interfaces, multi-user, milestones, and open

### 26.1 HTTP API

`USAGE_SPEND_API` in `packages/contracts/src/usagebudget.ts`; every route behind the session guard; a foreign Origin is refused like everywhere else. The live topic is the existing `claudeusage` (no new socket type): its push also means "a budget or spike alert fired, or a budget changed: load these again".

| Route | Does |
| --- | --- |
| `GET /api/usage-spend` | today and this month, the budgets' levels, spikes of the last day, the alerts |
| `GET /api/usage-spend/alerts` | the last day's alerts that are not snoozed |
| `GET /api/usage-spend/attribution` | §22; `by`, `range`, `claudeId`, `workspaceId`, `limit`, `format=json\|csv` |
| `GET`, `POST /api/usage-spend/budgets`; `PUT`, `DELETE /budgets/:id`; `PUT`, `DELETE /budgets/:id/snooze` | §23 |
| `GET /api/usage-spend/spikes?range=1d\|7d\|30d`; `PUT`, `DELETE /spikes/snooze` | §24 |
| `GET /api/usage-spend/audit?limit=` | what people changed here, and who, newest first |

Refusals: 400 for a body that is not JSON, 422 with the field, 404, 409 (a pausing budget's snooze, more than 50 budgets), 503 when the portal cannot save. A message refused by a pausing budget answers the tab's send over the chat socket as `{ type: 'ack', ok: false, code: 'USAGE_BUDGET', error: <the sentence> }`, and a REST or MCP caller gets a 409 with the same message.

### 26.2 Portal MCP

Registered from `usagespend/portalTools.ts`. Dollars say they are estimates once under `basis` and in each figure; a session's title and a persona's name are labelled untrusted; nothing returns a login, an email or an account id.

| Tool | Scope | Does |
| --- | --- | --- |
| `usage_summary` | agent | An admin's token: today and this month for the portal, the budgets, spikes and alerts. An agent's token: the last day for its own session and the sessions it started, with the budgets that count it. |
| `usage_attribution` | agent | §22. An agent's token is kept to its own tree (a session id outside it, another workspace or another Claude is refused). |
| `usage_budgets`, `usage_spikes` | agent | The budgets and spike events; an agent sees the budgets that count it and the events of its own tree. |
| `usage_budget_set` | admin | Makes a budget, or changes one by id, and says what it did. A budget that pauses needs the confirmation round trip. Audited with the token as `via`. |
| `usage_budget_delete` | admin | Removes one, after the confirmation round trip. |

An agent can never change a budget or a limit, and never sees the two tools that do.

### 26.3 In the process

- Hooks on the chat controller, installed in `index.ts` like `liveCaps` and `sessionBudgetUsd`: `onUsage(turn, rows)` (called right after `recordUsage`, with the same turn), `onLaunch({ sessionId, workspaceId })` (a process started: a new session, a wake, a resume, a move) and `sendGate(...)` (the refusal or null). Each is wrapped so a throw never reaches the chat; a failing gate lets the message through. `sendGate` is a new seam beside the caps rather than a use of `chat/caps.ts`: that spend limit is Claude Code's own `--max-budget-usd` at launch (pool keys only) and cannot refuse a message.
- `UsageSpend.onAlert(fn)` (returns the unsubscribe): called once per alert at the moment it is raised, which is where notifications plug in. An alert has a stable id (`budget|<id>|<level>|<period start ms>`, `spike|<event id>`), a level, a scope (`all`, `workspace`, `claude`, `session` with its id), its owner, the workspace and, for a spike, the Claude and the session; no secret and no session text. A throwing listener is logged once.
- The module reads the portal's own tables (`chat_usage`, `chat_sessions`, `workspace_claudes`) and runs nothing in a workspace. Every background step is wrapped: a failure is logged once and never touches the transcript.

### 26.4 Multi-user (PLAN-10 and PLAN-12; not built, the seams are)

Today the portal has one owner, `u_owner`, who sees and changes everything. For several users: every read takes the `actorId` it is for, and the optional `visible(actorId, { kind, id })` option of the module filters the requests an attribution, the summary, a spike or an alert is built from (by workspace, then by session), and the budgets listed or changed; a rule that throws hides. Default: allow all. A budget and a spike have an owner (`usage_budgets.created_by`, `usage_spikes.owner`, default `u_owner`), carried on every alert so notifications reach the right person, and what a person changes is audited with who and how (`usage_audit`). **Budgets per Claude are admin-managed; budgets per workspace belong to the workspace's managers**: a rule for the authz module's `can`, not enforced here. A spike alert goes to the manager of what it is about once there are several users; today that is the owner. Who may change a budget is not checked beyond seeing it (an actor who cannot see a budget gets "no such budget").

**Usage per user** (PLAN-12, `by=user`) plugs into attribution as one grouper (§22.1): the key is `creatorOf` the root session, so children roll up to the creator of the root by the same `lineage` helper the tree and the ticket use; requests from before users existed would be an unattributed group (`pre_multiuser`), never a 0. The figure is an **estimate** of API-equivalent dollars and tokens: a plan's quota is the Claude account's and is shared by its users, so a user's use of it cannot be measured, and nothing here claims it.

### 26.5 Milestones

| Milestone | Scope | Status |
| --- | --- | --- |
| M9 | Contracts, migrations 180 to 183, the module, routes | **Built** |
| M10 | Attribution by session, workspace, ticket, persona and Claude; CSV | **Built** (§22); persona from now on |
| M11 | Budgets with alerts, snooze, owner and audit; the opt-in pause | **Built** (§23) |
| M12 | Spike detection and its settings | **Built** (§24) |
| M13 | Portal MCP tools | **Built** (§26.2) |
| M14 | The pages: attribution tables, budgets, spikes, toasts, export buttons | **Built** (§27) |

### 26.6 Unverified, and open

| ID | Unverified or open |
| --- | --- |
| SB1 | The spike thresholds (3 x P90, 20 requests in 10 minutes, 10 x the median, a $0.50 floor), the cool-downs (30, 60 and 5 minutes), the minimums (8 periods, 20 requests) and the 7-day baseline are this section's choices, never measured on real traffic. They want a week of real use; the sensitivity settings are there for that. |
| SB2 | Persona attribution starts when this ships: coverage is partial until sessions restart, and what is recorded is the persona the portal had assigned at the start, not proof of what the process read (a delivery that lagged shows at the next start). |
| SB3 | A runaway inside one turn is seen only when the turn ends (§24.4). |
| SB4 | A ticket claimed by a session started for something else is not a link (§22.2): that session shows no ticket. |
| SB5 | Budgets count what the portal recorded: use of Claude Code in a terminal is not recorded, so a budget can read lower than a plan's real use, and dollars are API-equivalent estimates (§21.1). A request stamped after the portal's clock (a clock that moved back) is not counted until the clock passes it. |
| SB6 | The pause is checked when a message is sent. A message already queued and a running turn finish, so a budget can overshoot by one turn. |
| SB7 | ~~No page shows any of this yet~~ The pages and the toast for budget and spike alerts are built (§27). `onUsage` is also the hook §20.14 UI4 wants for pushing the strip on every finished request. |
| SB8 | Never run against a real Claude Code session that spends: the hooks are checked with a real controller on a fake workspace host, the rest with seeded rows. A real workspace chat was not started for this section. |

## 27. The Usage page (round 4, the UI)

Added 2026-10-12. Web only: this is what the Usage page, the Move dialog and the shared colours do with the numbers of §20 to §26. No figure here is computed by the web: each one keeps the basis the portal gave it (`measured`; `estimate`, labelled "est." with its formula behind a tap; `unavailable`, shown as "-" with the reason behind a tap, §20.0). Under the text diet: titles of one or two words, long text in an ⓘ.

| Part | Status |
| --- | --- |
| Shared helper `apps/web/src/lib/usage`: the palette as CSS variables (light and dark), hatch patterns, the swatch, slot hooks, top N plus Others, amount formats, the usage API client | **Built** |
| The summary strip above the tabs: Today, Speed, Limit, Reset | **Built** |
| Requests: stacked chart by Claude or model, legend, Others, previous period, tiles with the change, tokens by kind with the cache apart, export | **Built** |
| Claudes: pace marks on the bars, the run-out line, pace details, pace snooze, tab badge, projection toast wording | **Built** |
| Attribution: session tree, workspace, ticket, persona; CSV | **Built** |
| Budgets: list, create, edit, snooze, turn off, delete, the pause sentence | **Built** |
| Spikes: list, evidence, snooze | **Built** |
| Toasts for budget and spike alerts, with the plan alerts, once per device | **Built** (the existing watcher) |
| The recommended Claude in the Move dialog | **Built** (a surgical edit of `SwitchDialog.tsx`, which is the chat feature's file) |
| The strip refreshing on every finished request | **Not built** (§20.14 UI4: the portal's hook, then one line) |
| Web push, a real phone, iOS Safari | **Not built, not measured** |

### 27.1 The colours (round 4 P3)

One colour per Claude and per model, everywhere: the portal gives each a slot (0 to 7, or none: the neutral grey, §20.6) and `slotColor(slot)` draws it (`var(--usage-slot-N)`; the values sit in `palette.css`, with the theme switching of the chart colour in `index.css`). Eight hue families after the Okabe-Ito set (reddish purple, bluish green, vermillion, blue, sky blue, the yellow stepped down to olive, plus violet and red), ordered by a search that maximised the colour-blind separation of neighbouring slots, then checked with the data-viz validator (colour vision simulated with the Machado-Oliveira-Fernandes 2009 matrices at severity 1; Delta E is OKLab x 100), against the card surface (#ffffff, #141415).

| Slot | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | Others |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hue | magenta | bluish green | violet | vermillion | indigo | red | sky blue | olive | grey |
| Light | #a0429f | #009e73 | #9d78ed | #b14d00 | #4e62d0 | #e8605b | #0096c3 | #928e00 | #8a8a86 |
| Dark | #a73f95 | #00a97b | #a07bf0 | #b95100 | #5468d6 | #eb635e | #0093bf | #8f8b00 | #8b8b92 |

| Check (validator) | Light | Dark |
| --- | --- | --- |
| Neighbouring slots, worst colour-blind separation, protan and deutan (target 8) | 13.2 | 13.9 |
| Neighbouring slots, worst tritan separation | 12.1 | 12.4 |
| Neighbouring slots, worst normal-vision separation (floor 15) | 22.5 | 22.1 |
| The first four slots, every pair: worst colour-blind, worst normal | 11.2, 15.3 | 12.2, 17.2 |
| Every colour: lightness band (L 0.43 to 0.77 light, 0.48 to 0.67 dark), chroma at least 0.10, 3:1 on its surface | pass | pass |

All eight in every pair cannot pass at these floors (no order of eight can), so the other cues carry the rest and colour is never the only signal: a stack runs in slot order with "Others" on top and the legend lists the same order; a tooltip names every band; each slot has a hatch pattern (the Patterns switch beside the legend; on by default under `forced-colors` and `prefers-contrast: more`); bands are 2 px apart. `palette.test.ts` recomputes the numbers above from the hex values. Looked at in a browser under simulated deuteranopia, protanopia, tritanopia and achromatopsia: neighbouring bands stay apart; the weak pairs are the two the validator names (olive and red, slots 7 and 5), which the legend, the tooltip and the patterns separate.

### 27.2 What each part shows

**The strip** (all Claudes; the Claude picked in the Requests filter scopes it while that tab shows):

| Tile | Shows | Basis |
| --- | --- | --- |
| Today | dollars since this device's midnight, the request count beneath; tokens in the tip | dollars estimate, counts measured |
| Speed | dollars per minute over the last 15 minutes, tokens per minute beneath, today's average in the tip; idle is a real zero | estimate (a request counts when it finishes) |
| Limit | the time until the window that runs out first is estimated to reach 100 %; "OK" with the estimated percent at the reset when none will; "Out" until the reset; "-" with the reason for a pool, a key, a signed-out or an unread Claude | estimate; "Out" measured |
| Reset | the soonest reset of any window, with the Claude and window | measured |

**Requests.** Tokens are input + output + cache writes everywhere (§20.1); cache reads are counted apart. The chart stacks one band per Claude or per model: the top 6 by the measure keep their colour, the rest (and any series the portal could give no slot) fold into "Others", and one series is never folded alone; the tooltip of a column lists every band, top first, and names what is inside "Others" in that bucket. A legend entry switches its band off (an outline and muted words) and back; folding is decided before, so no band changes colour. "Previous" is the previous period as a dashed line, off while a band is hidden (it covers everyone) and unavailable with the reason when nothing was recorded then. The tiles show the change against the previous period as the portal computed it ("+321 % vs $1"), "no earlier data" or "none before" when it could not; Cache is the hit rate with its formula; Tokens lists uncached input, cache writes, cache reads and output. Export is CSV or JSON of the window and the Claude (§20.9).

**Claudes.** Under a window's bar: the paler stretch is where the window is estimated to stand at its reset, a thin wall at the end of the bar means it is estimated to run out first (dimmer while the estimate is low confidence), and the tick is where an even spend would be. A Claude estimated to run out before it resets gets one line ("Session runs out ~06:56 · resets 07:26", "may run out" while low confidence) with the numbers behind it. The open row lists each window's speed in points an hour, the percent at the reset, when it runs out ("after reset" when it will not), and how far ahead of an even spend it is, all estimates behind one "est."; the snooze menu mutes only the pace warnings. The tab's count includes a confident run-out that is not snoozed. Export: the plan readings of the last 7 days.

**Attribution** (§22): by session as a tree (a child is indented, the total includes it and the row says `own` beside it), workspace, ticket or persona; each row has its dollars (est.) and its share of the window's dollars. What was never recorded is "Not recorded" with its reason, never 0, and "n % recorded" shows beside the list when the coverage is under 100 %. A deleted session is marked; its requests stay.

**Budgets** (§23): one card per budget, the neediest first: name (or scope and period), percent, a bar in the level's colour, "$1 of $1.04 · resets in 18 h". A budget that pauses says "New messages are paused." with the portal's own sentence behind the ⓘ, the one a refused message carries. New and Edit are one dialog (scope, period, dollars, tokens, pause, name) with the portal's field errors; the row menu edits, snoozes (not for a budget that pauses), turns off and deletes after a confirm.

**Spikes** (§24): newest first, one line each as the portal words it, the kind, the session it names (a link), the Claude and when; the evidence is behind the ⓘ and the list is labelled "heuristic" with the sensitivity in force behind its ⓘ; the bell snoozes the session or the Claude.

**Toasts.** The watcher adds the budget and spike alerts to the plan alerts: one toast for what this device has not shown, in the portal's own words, with a way to the right tab; a projection alert is worded from its estimate ("Satria: session out ~06:56 · resets 07:26"), never as a threshold. **Move dialog.** "Recommended" beside the Claude the portal ranks best (§20.5), chosen by default until the person picks, with why behind its ⓘ; one line when every option is under 20 % left.

### 27.3 Copy

| Place | Words |
| --- | --- |
| Tabs | Requests, Claudes, Attribution, Budgets, Spikes |
| Strip | Today, Speed, Limit, Reset; "est." on an estimate; "-" |
| Run-out | "Session runs out ~06:56 · resets 07:26" |
| Empty | "No budgets yet.", "No spikes in this window.", "No requests in this window." |
| Refused | "Not available to you." |
| Failed | "Could not load. Check your connection and try again." and "Try again" |

### 27.4 Multi-user (PLAN-10)

Today's single-owner behaviour is unchanged. For several users: a browser preference is keyed with the user's id (`u_owner` now: `userKey` in `lib/usage`): the window, the Patterns switch, which alerts were shown; the views never assume they show everyone's data, and a read the portal refuses (403) shows "Not available to you." in the attribution, budgets and spikes views (the portal's seam filters the rows themselves, §20.14, §26.4, so a row a user may not see is simply absent).

### 27.5 Testing and verification

78 web tests in 12 files (the palette recomputed from its hex values, folding, formats, the strip tiles, the chart columns and tooltip rows, pace and the run-out words, alert wording, the Move words, attribution rows, budget words and the form, spike evidence, a stable list order); the web suite is 315 passing and the web build passes. Expected values are worked out by hand in the test next to their fixture.

A real portal on a scratch data directory (clean environment, probes off, Kubernetes off, one real Docker workspace container, a seeded database; 2026-10-12): the fixture is 16 request rows over three days, three plan Claudes with readings, nine sessions with a parent, tickets and a persona, four budgets and three spike events. Checked by a script against numbers worked out from the fixture on paper: 30 of 30 matched (the day: $4.21, 12 requests, 46000 in, 15700 out, 463000 read, 19000 written, hit rate 463/528; by Claude and by model; the day before: $1.00, 3 requests, so +321.0 %, +434.4 % in spent tokens, +300.0 %; today $2.77, 52700 tokens, 8 requests; the last 15 minutes 360 tokens a minute, $0.0333 a minute; Satria's session read 30, 50, 70 % an hour apart: 20 points an hour, 110 % at the reset, out in 90 minutes, 60 % at even pace, 10 ahead; Kresna's week 85 % at 3 points a day: 91 % at the reset; the outlook of an exhausted, a keyed, a signed-out and an unread Claude). Attribution matched by hand too (by session $1.00 for the parent: its own $0.50 and the child's $0.50; ticket T-12 $1.00, T-7 $0.30, none $2.91; persona Reviewer $0.50, none $0.90, not recorded $2.81, coverage 33.25 %), and so did the budgets (55.4 %, 96.2 %, 3.5 %, 117.5 %) and the spike lines.

In a real browser at 390, 844 x 390, 768, 1024, 1280 and 1920 px, light and dark: no horizontal scroll on any tab. With stress data (QA standard A9: 20 more Claudes, a 200-character name with no spaces, emoji, Arabic, a session tree nine deep, a hundred small sessions, a $1,234,567.89 request and 9.9 trillion tokens) nothing overflowed at 390 or 1280 px after two fixes (a grid card needed `min-w-0`, a sentence naming a Claude needed `overflow-wrap`): long names end in an ellipsis with the full text in a `title` and the accessible name, text reads in its own direction (`dir=auto`), amounts stay short (`$1.2M`, `10T`, `+123M %`, `62M %`), the legend is bounded (top 6, then Others with its members in a popover a keyboard reaches), and a list that refreshes while open keeps its order (budgets) or does not refresh by itself (attribution). Flows done by hand in the browser: a column's tooltip (Others named), a legend switch, the Patterns switch, the Claude and Model stack, a new budget (an empty save shows the field error, a valid one lists at $0.050 of $0.20 = 25 %), snooze and "Alert me again", delete after a confirm, the Move dialog with a recommendation, the refused (403) and failed states, the combined toast.

### 27.6 Unverified, and open

| ID | Unverified or open |
| --- | --- |
| UU1 | Never seen with a real plan's data (§20.14 UI1): every figure above rests on fixtures and a seeded database. |
| UU2 | Top 6 of 8 slots, the paler stretch and the wall on a bar, and a phone's five tabs scrolling sideways are this section's design choices, not measured ones. |
| UU3 | Controls of the UI kit are below 44 px on a phone (the segmented control is 40 px, the ⋯ menu button 36 px): not changed here, the kit is read-only. The ⓘ is 44 px on a phone through negative margins. |
| UU4 | Hatch patterns are hard to see on a phone's thin columns; the legend, the tooltip and the order carry identity there. |
| UU5 | The strip does not move when a request finishes, only on a reading, a push or its minute timer (§20.14 UI4). |
| UU6 | The Move recommendation and its default could not be exercised with a signed-in Claude here (no sign-in is allowed): the dialog was checked with the portal's real recommendation and a stand-in for the switch options. |
| UU7 | Keyboard focus inside the chart is the column's tooltip and the dimming of the others, not a ring. |
| UU8 | A name cut to an ellipsis shows its full text in a native `title` (not on touch or for a keyboard) and in the accessible name; the shared clamp-with-popover component of QA standard A9 is not used yet (it was not there to use). |
| UU9 | The Usage page is its own chunk, loaded on first use (App.tsx: `lazy` and a skeleton). |

## 28. Efficiency lab (T-287, slices 1 to 3 built: the data layer; outcomes, the read API, the MCP tools and the Lab tab; result tokens and stratum keys)

Why: the first evaluation of the agents' economy (docs/dev-sessions/overhaul/token-economy-design.md) was computed by hand from the session
tapes with `docs/dev-sessions/overhaul/evidence/slice_metrics.py`. The lab keeps the same numbers inside the portal as the stream is read,
so the coordinator's measurement every pass is a query, and a change (RTK, the 1 hour cache, a model per role) is judged by an experiment
with arms, not by an impression. Slice 1 is the data layer only: no route, no Portal MCP tool and no page yet (§28.6).

### 28.1 What a slice is

- **Sub-agent slice** (`kind = agent`): one sub-agent thread, keyed by the `tool_use` id of the Agent (or Task) call that started it (the
  stream's `parent_tool_use_id`). Its **ticket** is the first `T-<n>` in that call's prompt (first 2,500 characters) or description, its
  **role** the call's `subagent_type`, its **model** the model its requests reported last. This is the script's definition.
- **Turn slice** (`kind = turn`, `turn:<n>`): the main thread's requests between two `result` lines. After a portal restart the count goes
  on from the highest stored turn (a turn cut by the restart continues in the same row).

### 28.2 What is stored (migration 850), and what never is

Per request (one assistant message, deduplicated by its message id; when a message is reported on several lines the last report wins):
time, model, input, cache read, cache write 5 minute and 1 hour (the legacy shape without the split counts as 5 minute), the total cache
write, output. Per tool call (keyed by its `tool_use` id): the tool name, its class, whether a Bash command ran through RTK, the number of
results and their size in characters. Per slice: kind, ticket, role, model, start. A line of Claude Code's own (`<synthetic>` model) or
without a model is not a request. A replayed line changes nothing.

Never stored: prompts, commands, results, file paths, assistant text. A command is classified and dropped; a result is measured and
dropped; a value is kept only when it looks like an id or a plain name (`lab/classify.ts`), otherwise the call or the line is not kept.
The test `lab.test.ts` puts a marker into every text field of a tape and proves no lab row holds it.

Tool classes: `inspect` is exactly the script's regex (cat, ls, head, tail, grep, rg, find, wc, sed -n, awk, stat, du, diff, echo, pwd at the
start of the command) so the lab and the baseline agree; the other Bash classes go by the first word after `cd <dir> &&`, `NAME=value` and
`rtk`: `wait`, `git_read`, `git_write`, `test` (test, build and run), `api` (curl, kubectl, gh, docker, and similar), `edit`, `other`. Other
tools: Read, Grep, Glob are `inspect`; Edit, Write are `edit`; MCP and web tools `api`; Agent `agent`.

### 28.3 The numbers per slice

Requests; context per request = cache read + cache write (plain input is not in it, as in the script) as the truncated median and the
value at index floor(0.9 n) of the sorted list; token totals; units in input-price terms (cache read 0.1, write 1.25 for 5 minutes or 2.0 for
1 hour, output 5, plain input 1: the design's weights); **cost** = units x the model's input price (`lab/prices.ts`, Anthropic's list as of
2026-10-06; a model not in the list has no cost, shown as unavailable); **re-written tokens** after a cache miss (the previous context was over
20,000 tokens, this request read less than half of it, and the context did not shrink below 70 percent: the smaller of the lost read and
this request's write); results and their characters; Bash, RTK and inspection calls; calls per class; start, end and minutes (one
decimal, half to even). The read weight 0.1 over-estimates a model whose cache read is cheaper (Opus 5.5: 0.05 of input).

Proof that the lab equals the script (source: `lab/lab.test.ts`): on the synthetic tape of `lab/testkit.ts` the script printed, with
Python 3.11.2 on 2026-10-14, for the implementer slice 6 requests, context p50 33,750 and p90 34,800, units read 13,580, write 80,250,
output 4,150, 8 results of 4,132 characters, 28,500 re-written tokens, 6 Bash calls of which 2 RTK and 1 inspection, 33.1 minutes; for the
qa slice 3 requests, 12,900 and 13,000, 2,490, 26,000, 2,950, 2 results of 323 characters, no re-write, 2 Bash calls of which 1 inspection,
0.2 minutes. The lab gives the same values exactly (the test also runs the script live when python3 is present).

### 28.4 Experiments (migration 851)

An experiment has a name, a hypothesis, a design, its arms, a primary metric, guardrails, thresholds and a minimum n written before the
start, a status (running, stopped, decided), a start and a stop, and at the end a decision (adopt, reject, iterate) with its verdict.

- **Randomized**: when a sub-agent slice starts (its Agent call is read), every running randomized experiment gives it an arm. The stratum
  is the role and the requested model (or the experiment's own stratum keys, §28.12); within a stratum the arms come in blocks of one each, in an order drawn from a hash of the
  experiment, the stratum and the block, so the arms stay balanced within one slice per stratum and the draw can be recomputed. A slice
  asked again keeps its arm. Telling the sub-agent its arm in its brief needs the read tool of a later slice.
- **Before and after** (a change that cannot be randomized, such as the 1 hour cache): the sub-agent slices that start in the window are
  split at the moment of the change.
- **Excluded**: a slice taken out with a reason (an outage) is in no arm and counted apart.
- **Report**: per arm n, the medians of requests, context p50, cost (unavailable when any slice has no price), result characters and
  minutes, and the shares that are sums over sums: re-written tokens over cache writes, inspection over Bash calls, RTK over Bash calls (the
  compliance of an RTK arm). Intention to treat: the assigned arm counts.

### 28.5 Seam

`ChatController.onStreamLine(sessionId, raw)` is called at the very end of the controller's line handling, after every integrity check, so a
line the chat refused is never measured (`lab/hook.test.ts`); a throw is caught and never touches the chat. The lab writes only when the store
is writable.

### 28.6 Not built yet (later slices of T-287)

Gate first try, human touches and ESTIMATE against ACTUAL hours per slice; delivered units per hour and per dollar; per-protocol
analysis; result tokens, effort and idle gaps on the Lab tab (they are in the API and `lab_summary`, §28.12); `efficiency_me` and `experiment_get` as their own tools (`lab_summary`
covers the coordinator's pass); the Home widget, the weekly digest and the regression alerts.

### 28.7 Outcomes (slice 2, as built)

A slice's outcome comes from its ticket's timeline (status, close and reopen events, read from the portal's own ticket tables), never a
guess: after the slice's last request the ticket's next decision is **done** (`accepted`) or **in review back to open, in progress or
blocked** (`rework`); an accepted ticket reopened within 7 days of done makes it a `defect`. No ticket, no decision yet, a ticket the lab
can not read: `unknown`. A rule of thumb, said so in the source line. The ticket's last comment that starts with ESTIMATE gives its size
(S, M, L, XL), nothing else of a comment is read. Source: `lab/outcomes.ts`; checked on a scratch portal's real ticket tables
(2026-10-14: 27 implementer slices, 24 accepted, 3 rework, first-pass yield 0.889).

### 28.8 Derived measures and the summary

Per period (UTC day, or the week from Monday) and per role (`main` for a main-thread turn) and model: n; median and p90 (index
floor(0.9 n)) of requests, context p50, result characters, result tokens (§28.12; the API and `lab_summary` only), minutes and cost; the share of
Bash calls by class; re-written cache tokens and their share of all cache writes; outcomes; **first-pass yield** = accepted over accepted +
rework + defect; **cost per accepted slice** = the median LOADED cost of an accepted slice (its own cost plus the cost of the rework and
defect slices on the same ticket that ended before it: rejected work counts against it; a slice without a price makes it unavailable), with
a **bootstrap 90 percent interval** (2,000 resamples, a seed fixed per group, 5th and 95th percentile) from 20 accepted slices up, else
"n too small". **Cost** now uses the model's own cache-read weight (Opus 5.5 0.05, Fable 5.1 0.025 of input, from the price list of §28.3;
others the design's 0.1); `units.read` stays at 0.1 so the lab still equals the reference script. Experiments show, per arm, n, accepted
slices and the primary with its interval. Proof on the tape (`lab/slice2.test.ts`): the implementer slice costs (13 + 135,800 x 0.05 +
80,250 + 4,150) x 4e-6 = 0.364812 dollars; Bash shares inspect 1/6, git read 2/6, test 2/6, wait 1/6; re-write share 28,500 / 63,300.

### 28.9 Retention (migration 852)

Request and tool rows are kept 14 days. Once a day (and a minute after start) a slice whose last request is older is **frozen**: its
numbers (counts only) are written as JSON on its `lab_slices` row (`frozen`, `frozen_ms`), then its request and tool rows go. Slices,
summaries and experiments are kept; a frozen slice reads the same as before (test). Source: `lab/retention.ts`, `Lab.start`.

### 28.10 Read API and Portal MCP (authz: `lab/authz.ts`)

`GET /api/lab/slices` (filters session, ticket, role, model, experiment, arm, since, limit; newest first), `GET /api/lab/experiments`,
`GET /api/lab/summary?period=day|week&since=`. Each needs `view` on the platform area `usage` (the owner, an admin); an agent actor reads
its own session only and no experiments; every denial is the same 404 as a route that is not there. Portal MCP: `lab_summary` (agent
reach `session`: an agent's token reads its own session; an admin's token the portal) answers short rows by default (period, role, model,
n, median requests, context, minutes, cost, inspection share, re-write share, first-pass yield, cost per accepted) and everything with
`full: true` (p90s, outcomes, Bash classes, the experiments with intervals, the source of each figure); `lab_experiment_set` (admin
tokens, confirmation round trip) starts a randomized or before-and-after experiment or stops one; `lab_arm_draw` (agent reach
`session`, §28.13) draws a slice's arms before its brief. Counts and ids only.

**A session is its chat (T-312).** Where the lab reads one session (an agent's own read on a route or through `lab_summary`, and
`?session=` on `GET /api/lab/slices`), it reads the session and the rows of its `continued_from` chain before it (`chainOf` over usage
spend's session loader: the same grouping as §22 and §24), so a chat continued as a new row (a Move, an auto-move on quota) still scores
its earlier turns and sub-agents as its own. A chain's first row reads only itself (nothing came before it); another chat, a parent or
a child is never in it. The scoring over every session (the summary rows, the experiments) had no session dimension to split: its
units are slices (a main-thread turn, a sub-agent thread) keyed by session and slice, grouped by period, role, model and ticket, so a
chain is not one slice and nothing there changed. A draw still binds only in the session that drew it (§28.13): a draw made before a
continuation and named after it is unbound, as before; changing that is a decision on the draw rule, not part of this. As tested
(`lab/lab.test.ts`, the same 2026-10-13 ids): the third row reads three turns, the first row one, Konfersi its own one.

### 28.11 Usage → Lab

A tab of Usage. Day or Week; the summary as one card per row on a phone (the figures in a three-column grid, median / p90) and as a
table from 1,024 px (p90 under the median); "unavailable" is shown as a muted state, never 0; one InfoTip holds the source of every
figure. Experiments below: each arm's n, accepted slices, cost per accepted slice and its interval. Checked at 390 px (touch, light and
dark) and 1,280 px (light and dark) on a seeded scratch portal: no horizontal scroll, 9 rows, 2 experiments; the Day and Week control is
the shared `Segmented` at 40 px high (as on the Spikes tab).

### 28.12 Result tokens, effort, idle gaps and stratum keys (slice 3, migration 853)

- **Result tokens** per slice, an estimate from the usage the stream reports (the stream carries no token count per result): for each
  request after the first, in time order, its context (input + cache read + cache write) less the previous request's context and output,
  at least 0, is what came in between; when the previous request made tool calls it is laid on their results, split by result characters
  (evenly when all are empty), and so also given per tool class. Growth after a request without a tool call (a person's message) is not
  a result. To link a result to its request, a tool row keeps the id of the assistant message that made the call (`lab_tools.message_id`).
  Unavailable (null, never 0) for a slice whose calls cannot be linked: rows from before migration 853 and slices frozen before slice 3.
  The stream under-reports output tokens, so a large call input (an Edit's text) shows as result tokens: an upper bound. The reference
  script names `result_tokens_est` but does not compute it, so there is no script number to match; on the tape (`lab/slice3.test.ts`)
  the implementer slice has 1,899 + 1,250 + 450 + 780 = 4,379 result tokens (inspect 2,286, git read 107, test 1,206, wait 780).
- **Effort** per sub-agent slice: the Agent call's `effort` when it is a plain name (`lab_slices.effort`), else null.
- **Idle gaps**: the minutes between consecutive requests over 5 minutes (the short cache's life), summed, and the longest gap, one decimal.
- **Stratum keys**: a randomized experiment may name its stratum keys, any of `size` (the ticket's ESTIMATE size when the slice starts),
  `role`, `model` (requested) and `effort`, in order (`lab_experiments.strata`; the stratum reads `size=M|role=implementer`, a missing
  value is `-`). Without keys the stratum stays slice 1's role and requested model, so a running experiment keeps its blocks. The arm is
  still `blockOrder(experiment, stratum, floor(k / arms))[k mod arms]` for the k-th slice of the stratum: the same slices in the same order
  get the same arms, and the arms are balanced within one slice per stratum (tested on four sizes, interleaved). `lab_experiment_set`
  takes `strata` (admin, confirmation; the preview shows them); `lab_summary` shows `result_tok_p50` and, in full, each experiment's keys.

### 28.13 Draws: the arm before the brief (T-292 slice 3, migrations 854 and 855)

An experiment whose treatment is the brief itself (E2, the context compiler: the pack line, the plan step's file manifest and the
preloaded files, against today's brief) needs the arm before the brief is written; a slice gets its arm only when its Agent call starts.
- **`lab_arm_draw`** (Portal MCP, agent reach `session`, audited `lab.arm.draw`, 120 calls per hour per token; input the ticket
  (required; a ticket that does not exist in the portal is refused, nothing recorded), role, model, effort as the slice will be
  dispatched): per running **draws-only** randomized experiment (no other: a peek must not show a block arm) the **drawn arm** of that ticket
  (`drawnArm`: a hash of the experiment's secret seed and the ticket number; `T-12`, `T-012` and `T-0012` are one ticket), held as an
  assignment under `draw:<key>` in the caller's own session (`lab_assignments.draw` names the draw, migration 855), with what it was drawn
  for (`lab_draws`: the ticket in one spelling, role, model, effort, the ESTIMATE size then, status open, bound, refused or expired),
  answered as the key (`d-` and 12 hex) and the arm per experiment. No draws-only experiment running: no key, no arm, nothing recorded,
  and the brief is the ordinary one. An admin token has no session: refused. An experiment without a secret seed gets no draw (migration
  855 gave every older one a seed).
- **Binding**: read only from a top-level Agent call (not one made inside a sub-agent) and only on the FIRST line of its prompt
  (`Lab-Draw: <key>`). The draw binds when the call is in the session that drew it, the draw is not bound or expired, and the call's
  ticket (any spelling), role, requested model and effort, and the ticket's ESTIMATE size now, are the ones it was drawn for; then its rows
  move to the slice and the slice keeps the drawn arms (a replayed line of the same call changes nothing). Otherwise (another session, a
  key used already, an unknown or expired key, a mismatch) nothing binds, a mismatch marks the draw `refused` (still bindable by a
  matching call, counted as unbound meanwhile), and the calling slice is EXCLUDED from every running randomized experiment (`draw not
  bound`): its brief was written for an arm it was not given. An honest mismatch (drawn for `opus`, dispatched with the model left out)
  therefore loses that slice from the experiment, never biases it. Any first line with a well-formed `Lab-Draw: d-<12 hex>` counts, also
  one copied from untrusted text into a brief: that slice is then excluded (lost, not biased); accepted.
- **Draws only** (`lab_experiments.draws_only`, migration 855; `lab_experiment_set` `draws_only: true`, which `plan-step.mjs e2` sets):
  only a bound draw gives an arm; a slice that starts without one is excluded (`no draw`), never given a block arm. So a session cannot
  look at a ticket's arm and then dispatch the ticket without the draw (or with a made-up key) to get a block arm instead. Without the
  flag a slice without a draw gets its block arm as before (§28.12).
- **Nothing to pick**: the drawn arm is fixed per experiment and ticket, so drawing again (a redraw, after a throwaway call bound the
  first draw, or with another role, model or effort) gives the same arm. A draw does show that ticket's own arm, also when it is drawn
  only to look (a peek); in a draws-only experiment the ticket's slice then has the arm or is out, and either way it is counted. The seed
  is random per experiment, kept in `lab_experiments.seed` and never shown; migration 855 gave every experiment made before 854 (seeded by
  its id, which is shown) a random seed, so the next block of each running one is reordered (still balanced from there; the arms already
  given stay). Drawn arms are not block places: the blocks (§28.12) are the slices that got their arm at the start, so a draw, used or
  not, moves no other slice's arm. `lab_summary` full shows per experiment `draws_only` and `draws`: per session, every draw (`draws`),
  `bound`, `unbound` (abandoned: open, refused or expired), `redraw` (a draw for a ticket the session drew for before, whatever the role;
  a later slice of the same ticket counts too) and `opted_out`: slices of the session kept out that should have carried a draw, namely
  any slice whose draw line did not bind (`draw not bound`, whatever its role) and a slice of a drawing role that started without one
  (`no draw`; the drawing roles are `implementer`, per `docs/dev-sessions/orchestrator.md`, and any role this experiment drew for, so a
  reviewer, QA, scribe or explorer slice, the plan step's explorer included, is out of the experiment but no opt-out). Such a slice
  counts when its ticket has a draw of THIS experiment (`lab_assignments.experiment_id`; any session, bound or not) made before the
  slice started (a peek in one session and the work in another, a throwaway bound first and the real work without a draw, a follow-up
  slice without one), or, when it names no ticket or a ticket the portal's tickets table does not have, when its own session drew for
  this experiment before it started; per experiment also the total `opted_out`. A slice naming another real ticket that nobody drew
  for is no opt-out. A draw is never deleted.
- **Retention**: an unbound draw older than 14 days expires (`prune().draws`): it can no longer bind, its row and held arms stay, so it is
  still counted. `lab_draws` therefore only grows, one short row per draw, at most 120 per hour per token (the tool's rate limit).
- **Known limits.** The unit of the drawn arm is the ticket: a ticket's slices share one arm, so they are not independent (an interval
  over slices is narrower than it should be when one ticket has many slices), and a draws-only experiment's arms are simple
  randomization per ticket, not blocked (the n per arm can differ). Migration 855 backfills `lab_assignments.draw` only for draws still
  held under `draw:<key>` at 854; a draw bound under 854 is counted as a block place (none were released). A bound throwaway call of a
  different kind (another role, matching the draw's role only by name) is still a slice of that arm. The orchestrator knows a ticket's arm once drawn and could delay that ticket or
  drop it; that shows as an abandoned draw (and, if the slice runs without the draw, as `opted_out`). A throwaway call that matches a draw
  binds it and is a slice of that arm with its own cost and outcome (intention to treat), visible as an extra slice on the ticket.
- The brief heads per arm come from `scripts/plan-step.mjs` (`head --arm control|treatment --draw <key>`; the explorer's manifest is
  labelled untrusted in the brief; its `run:` lines are one of a fixed list word for word: `npm run typecheck` (optionally
  `-w @portal/server|web|contracts`), `cd apps/server|apps/web && node --import tsx --test <files>`, `scripts/slice-check.sh [<files>]`,
  where each file is one of the manifest's own `test:` lines, and no quote, metacharacter, other flag, `.` or `..` passes; preloaded paths
  are checked on their real path (a link is followed) against the repository and a case-insensitive credential deny list: `.env*`,
  `*.env`, `.dev.vars`, `*.tfvars`, `credentials.json`, `.npmrc`, `.yarnrc*`, `.netrc`, `.pypirc`, keys, `.git`, `node_modules`,
  `.kube/`, `.config/gh/`, `.aws/`, `.ssh/`, `.docker/config.json`; a `new:` path where anything is, a dangling link too, is refused), the E2 experiment's
  arguments from `plan-step.mjs e2` (randomized, arms `control` and `treatment`, strata size, role and model, draws only, minimum 30 per
  arm, primary the median loaded cost per accepted slice; adopt at −15 percent with yield not down). Procedure: `docs/dev-sessions/orchestrator.md`.
- Source: `lab/experiments.ts` (`drawnArm`, `drawArms`, `bindDraw`, `drawStats`), `lab/classify.ts` (`drawOf`), `lab/retention.ts`; tests
  `lab/draw.test.ts` (the drawn arm kept; probe A, a draw taken by another role; the honest mismatch; probe B, a redraw behind a throwaway
  call; the second review's throwaway that matches, the peek, the changed size and retention keeping the evidence; the third review's
  ticket spelling and role, draws only and the opt-out count, the upgrade from 854; another session, a nested call, the second line;
  draws outside the blocks and the seed; the fifth review's opt-outs only for drawing roles, only after the draw, only the experiment's
  own draws, a made-up ticket as no ticket on the real tickets table; the tool) and `qa/planStep.test.ts`.

### 28.14 Crew scorecard (T-450 slices S1a, S1b and S2: the read API, `crew_scorecard` and the Usage → Crew tab; no migration)

How well a crew works and what it costs, per PROGRAM and per WINDOW, with the standing decisions it is held to. Read only, over the
tables the portal already keeps; nothing new is stored.

- **Program.** The top of a session's lineage (usage spend's `rootOf`: the session it continues, else its parent, up to the first row
  of the top chat) names it; the **lead chain** is that row and its continuations (`chainRootOf` is the program), oldest first; every
  other session under it, at any depth, live or kept after a delete, is a **worker**. A top with no worker is a chat, not a program. A
  program is listed when one of its sessions made a request since the start of the previous window, or is still live. The lead chain is
  ordered by its links (each row continues the one before). A delete clears the successor's `continued_from` and the children's
  `parent_id` (chat/store.ts); the loader puts them back from what outlives it: the `session.continued` audit row (the successor and the
  row it continued; its time is a deleted continuation's creation) and the parent `usage_sessions` kept from the child's requests. So a
  deleted continuation stays in the lead chain and its workers stay in the program.
- **Windows.** `1h`, `6h`, `day` (default) or `week`, ending now; with `compare` (default on) the window before it, the same length.
- **The program's tickets**: held by one of its sessions (`ticket_id`), assigned to one, or with a timeline event written by one
  (`session:<id>`). A ticket two programs touched counts in both.
- **Headline** (T-600; `CrewScorecard.headline`, filled by `lab/headline.ts`; no new route, the authz seam unchanged; named `headline`
  because the `crew_scorecard` tool already puts a text `summary` beside the scorecard). Over the programs the response keeps (an
  agent: its own only), each figure with its basis and source, unavailable with a reason, never a division by zero:
  - **Pace** (ESTIMATE, global, a snapshot of now): sum of `usedPct` over sum of `evenPct` of the 5-hour `session` window of every Claude
    on its own plan that is signed in and has a pace (claudeusage `WindowPace`, read through `Lab`'s optional `paceSource`, which is
    `claudeUsage.report()`). Left out: signed out (`runsOn` none or state `signed_out`), pooled, key, a Claude without a pace. Under 10
    points of even pace in all: `windows_just_reset`; none left: `no_claude`; no source (none wired, it failed, or an agent's read, since
    the quota is not one program's): `no_source`. Per Claude `usedPct / evenPct` (`no_samples` when `evenPct` is 0). Under 0.9 the
    unused part at reset: 100 minus the mean `projectedPct` of those Claudes (null when none says). Weekly: the same on the `week` window.
  - **Per window** (current, and the window before with `compare`): requests and estimated dollars per hour; tickets resolved (done,
    `closed_at` in the window) and won't-do, global and per program; dollars over resolved (`no_samples` with none); tickets created over
    tickets closed (done plus won't-do), global and per program (`no_samples` with none closed). A ticket two programs touched counts
    once globally and once in each program row, so the rows equal the program rows of the same response.
  - **Server**: `Lab.scorecard` fills it (paces passed in, none by default); `Lab.scorecardWithPace` awaits the source first and is what the
    route and the tool call. The full tool form drops each figure's `source` here too (`basis` names it once).
- **Effectiveness** (all MEASURED): done (status done, `closed_at` in the window) by type and per hour; reopened (a `reopened` event, or a
  change from done or wont_do back to work, in the window); wont_do (closed as wont_do in the window); lead time from the first change to
  in_progress to `closed_at`, p50 and p90 by nearest rank per type (a done ticket with no start recorded is counted as `noStart`, not
  timed); the review backlog: tickets in review at the window's end (the status timeline replayed), age since they entered review, and
  what each waits for: a `waits-<what>` tag first (`waitsBasis: tag`); else, for the window that ends now only (`derived`), a deploy of
  one of its runs waiting for approval (`deploy`), a live QA, verifier, reviewer or ux-check session holding it (`qa`), or a person it
  is assigned to (`owner`); else null. An earlier window shows the tag only: the portal keeps no history of those states. CI runs of the program's sessions or tickets that finished
  in the window, passed, failed and cancelled per pipeline; the deploys (`ci_deployments`) of those runs, with approval and outcome.
- **Cost** (ESTIMATE, Claude Code's price): the dollars of the program's requests in the window; lead = the lead chain's own requests,
  workers = the rest; the lead's share in percent; per done ticket all-in (total over done) and workers only (workers over done). Per
  type: usage spend's per-ticket dollars of the done tickets (`ticketReport`, T-449, the same function as Usage → Attribution by
  ticket: own plus the lead's part split over its workers' tickets), over the tickets' LIFE: the program's requests from the oldest such
  ticket's creation (at most 30 days back) to the window's end, so a ticket worked in an earlier window shows its whole cost; all-in is
  the ticket's total, workers only its own. The window's per done ticket figure stays the window's dollars over done (a throughput rate).
- **Efficiency** (over the program's requests in the window): the dollars' split by token class, input, output, cache read and cache
  write in percent at list price (`lab/prices.ts`: output x5, cache write x1.25, cache read x0.1 or the model's own weight; ESTIMATE;
  unavailable `no_samples` without a priced token); requests and requests per session; context (`chat_sessions.context_used`, the last
  turn's) p50 and p90 per role (the worker's agent, `lead`, `unrecorded`) and per lead session (its direct workers, with the lead's own
  as `leadTokens`), over sessions with a request in the window; the five sessions that cost most; the model mix per role; sessions per
  role with how many started in the window (churn); live sessions per Claude now (T-427 spread; the window that ends now only); lead
  hand-overs (continuations created in the window, T-423) and per hour; the usage spikes (`usage_spikes`, T-418) of its sessions, or a
  rate spike whose top session is one of them. **T-490 (D-63):** `qaReviewOpus`: of the QA, verifier, ux-check and review workers (their
  role) with a request in the window, how many had a request on opus or fable, the share in percent (MEASURED; unavailable `no_samples`
  with none), and how many of those were started with a reason (`session_spawn` `why`, `chat_sessions.spawn_why`). Each program also
  names its workspace (`workspaceId`, the lead's); `crew_scorecard`'s short result has `workspace`, `qa_review_opus_pct`,
  `qa_review_sessions` and `qa_review_opus_with_why`, and the page's Details show the share as one line.
- **Health**: `agent.refused` audit rows of its sessions in the window, by scope; sessions ended by an integrity or credential check
  (`ended_reason` prefixes) or interrupted by an error, in the window. Pod memory and OOM restarts are unavailable (`no_source`): the
  portal does not record them.
- **Targets** (now for live workers, over the window for the rest), each `ok`, `warn`, `breach` or `unavailable`, with the offenders:
  D-61 `live_workers` (live workers at most the live lead's `max_workers`, else 3); D-61 `lead_subagents` (Agent-tool sub-agents in the
  lead chain's requests, `chat_usage.agents`: any is a breach; none while a live lead may still start them, `subagents` on, is a
  warn); D-62 `owner_queue` (the program's tickets assigned to a person and not closed, other than T-93: any is a breach); D-63
  `qa_review_model` (a worker whose role, `chat_sessions.agent`, is QA, verifier, ux-checker or reviewer with a request on a model that
  is not sonnet is a breach, unless its lead started it with a reason, `spawn_why`, T-490; workers with requests but no role recorded at
  all: unavailable, `not_recorded`).
- **D-65 targets** (T-549; the same `targets` list, `decision: "D-65"`, ids in `CREW_D65_TARGETS`), over the window, each with its figure,
  source and offenders. Warn from 80 % of a ceiling (this page's margin, not the decision's); breach at it. (1) `cost_per_done`: all-in
  dollars over done tickets under 8 USD (offenders: done tickets whose all-in cost over their life is 8 or more). (2) `lead_share`:
  the lead chain's part of the dollars under 30 % (offenders: the lead chain). (3) `qa_opus_share`: QA and review workers with a request
  on opus or fable under 10 % of them (a `spawn_why` does not exempt here; offenders: those sessions; none: unavailable, `no_samples`).
  (4) `done_rate`: feature and task tickets done in the window, scaled to a day, against the 2026-10-15 baseline of 48 / 47 a day
  (ClaudePilot / Konfersi, which counted all ticket types, so the comparison is hard), matched by the lead's exact workspace id (`kubernetes/kohi-event` 48, `kubernetes/konfersi` 47; the Event program left pilot, D-67; never a pattern on the name, which gave ClaudePilot's own workspace the Event 12):
  at or above is ok, under it warn, under half breach; no baseline for the workspace: unavailable, `not_recorded`. (5) `quota_unused`:
  the worst quota left unused at a reset inside the window (T-547, `claude_usage_samples`) over 30 % is a breach; whole portal, so the
  row repeats on every program and an agent's own read gets unavailable (`no_source`); offenders are Claude ids; "while a crew had work
  queued" is not measured. (6) `wasted_tool_calls`: tool results of the program's sessions (`chat_events`, kind `tool_result`) that are
  an error (a permission denial, an error of a portal `mcp__pilot__*` tool, or a failed command; baseline 2026-10-15 about 2,000 of
  26,781) over all of them, under 3 % (offenders: the sessions with the most). The error text read is cut to 400 characters in SQL.
- **Unavailable is a state.** Every figure carries `value`, `basis` (`measured`, `estimate`, `unavailable`) and `source`; unavailable
  is `null` with a reason: `no_source` (the table cannot be read), `no_samples` (nothing to divide by), `not_recorded`. A measured
  nothing is 0.
- **Read.** `GET /api/lab/scorecard?window=&compare=0|1&program=` (`view` on the platform area `usage`; an agent actor reads only its
  own program, the top of its session's lineage; another program, or one that does not exist, is the same 404) and the Portal MCP tool
  `crew_scorecard` (agent, reach session, read only; the same scoping, `NOT_FOUND`; an admin's token reads every program; short by
  default; `full: true` for every figure with its basis, the sources named once in `basis` so the result stays under the MCP size limit;
  the route keeps a source on each figure; the full form is paged by size: programs are carried in order while the result is at or under
  19,000 characters, the rest are named in `omitted` and asked for with `program`). Wire types: `packages/contracts/src/scorecard.ts`.
- **The page (S2): Usage → Crew** (`?tab=crew`; `features/lab/ScorecardTab.tsx`, pure wording in `scorecardModel.ts`). A window picker (1h, 6h,
  Day, Week) and Alone / Compare (Compare asks `compare=1` and shows each number's earlier value as "was"); the sources of every figure
  in one InfoTip. One card per program with five numbers: done per hour, dollars per done ticket (all-in), the lead's share, tickets in
  review, and breaches (the count of D-61, D-62, D-63 and D-65 targets in breach). Under the numbers, always visible, a **D-65** list of the six rows above (label of one
  or two words, value, state, offenders under it, rule and source in an InfoTip; rows at least 44 px tall, ids wrap). Each number shows its state (`ok`, `warn`, `breach`, or
  `unavailable`) and MEASURED, ESTIMATE or UNAVAILABLE, with its source (and the reason when unavailable) in an InfoTip: unavailable reads
  as the word, never 0. Only breaches take their state from the targets (breach when any is, warn when any warns, unavailable when none could
  be checked); the review backlog warns when a ticket has waited more than 24 hours (a default of this page, not a decision); the other three
  have no target, so their state is `ok` when measured. "Details" opens the tables the API returns as lists (done by type, in review with
  what each waits for, CI by pipeline, deploys, the targets with their offenders), so nothing scrolls sideways. Layout: two numbers a row on a
  phone, 44 px controls, light and dark. S3: on a phone the Details button is a chevron only (labelled "Show details" / "Hide details"); the
  Sources InfoTip sits beside the window picker it explains; when targets warn and none breaches, the Breaches tile reads "2 warn" (the
  warn count) instead of "0" beside WARN. Check: `tools/qa/crew-scorecard.mjs`; tests `scorecardModel.test.ts`.
- **Attribution export (T-450 S2 fix).** Usage → Attribution's CSV followed `by` and `range` but not the Done filter, so a done-only view
  exported every ticket; the download now carries `done=1` like the rows (`attributionUrl`, test `attributionUrl.test.ts`).
- **Known limits.** A done ticket's life cost looks back at most 30 days; waits-for is derived for the current window only; context per
  hour (T-423) is not computed, only hand-overs; the session list is bounded at 5,000 per load.
- Source: `lab/scorecard.ts` (pure), `lab/scorecardData.ts` (the loader), `Lab.scorecard` (`lab/index.ts`), `lab/routes.ts`,
  `lab/portalTools.ts`; tests `lab/scorecard.test.ts` (a seeded crew: two programs, a continuation, workers on two Claudes, tickets of
  each kind, CI runs and deploys, usage rows; the numbers in each window, the targets, the previous window, unavailable, life cost,
  derived waits, a deleted continuation, efficiency, health, the route and the tool's scoping).
