# PRD: Claude usage

| | |
| --- | --- |
| Status | **Draft v0.2.** K0, M1, M2 and M3 are built and were tried (§17). ✅ = observed on Claude Code 2.1.296, on this machine, against a local stand-in for `api.anthropic.com` and a scratch directory holding a clearly fake credentials file (no sign-in, no real token, nothing leaves the machine). 📄 = read from the CLI's own schema and strings, not observed. 🔬 = unverified, listed in §19. **A real claude.ai subscription could not be signed in here, so no real plan reply has been seen**: the parser is built against the observed shapes and the CLI's schema, and §19 says exactly what that leaves open. |
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
- **Forecasting.** No "you will run out at 16:40". The history is shown; the guess is not made.
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
| Running Claude Code's own `claude -p` in the workspace, as that Claude (its directory), to ask `get_usage {skip_behaviors: true}` and read the numbers, timestamps and plan type of the reply. | Reading, copying, storing, logging or returning a login, a token, `.credentials.json` or `.claude.json`. Calling Anthropic with one. |
| Running `claude auth status --json` as that Claude to tell "signed out" from "no plan limits", keeping `loggedIn` and `authMethod` only. | Keeping its email, organization name or id, or showing them anywhere. |
| Keeping a coarse plan label (`pro`, `max`, `team`, `enterprise`) from the reply's `subscription_type`, the word Claude Code's own `/usage` shows. | Keeping the account or the organization behind it. |
| Using the `rate_limit_info` of a live session's `rate_limit_event`, handed over by the chat reader. | Storing the event line, the session's text or anything else from the stream. |
| Probing only Claudes whose workspace is running. | Waking, starting or installing into a stopped workspace. Installing Claude Code (the sign-in flow does that). |

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
2. **Probe.** One short `claude -p` process per Claude, in a clean environment, one control request, read the reply, end (§11).
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
| Not usable | `--bare` skips OAuth, so a subscription would read as signed out. `skip_behaviors: false` scans transcripts. |

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

## 11. Probe mechanics and limits

**Command**, run in the workspace by the runtime's exec as the workspace user:

```
env -i HOME PATH LANG=C.UTF-8 [CLAUDE_CONFIG_DIR=$HOME/.claudepilot/claudes/<16 hex>]
       DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 DISABLE_AUTOUPDATER=1
       [HTTPS_PROXY HTTP_PROXY NO_PROXY NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR, only when set]
  timeout 25 claude -p --input-format stream-json --output-format stream-json --verbose
       --strict-mcp-config --no-session-persistence --disable-slash-commands
```

- **Directory.** The Claude's directory is checked against `claudes/<16 hex>` and passed as an argument, never through shell parsing (the pattern of [Workspace Claudes](workspace-claudes.md) §12). Default has no `CLAUDE_CONFIG_DIR`, as everywhere else.
- **Clean environment.** An API key, an auth token or a base URL in the workspace's environment would turn the probe into an API-key session and answer "no plan limits" for a Claude that has a plan. So nothing is inherited except the network plumbing a workspace may need to reach Anthropic. ✅ Observed: with `ANTHROPIC_API_KEY` in the environment the same fake plan login read `rate_limits_available: false`; the probe's wrapper drops it, and so a token and a base URL.
- **One line in, one line out.** The request line carries a random id; only the `control_response` with that id counts. Other lines (init, logs, merged stderr) are ignored. The reply is parsed in memory and dropped; only the parsed numbers are kept.
- **Limits.** One probe at a time per workspace, two in the portal, 30 seconds hard stop, one check-now per Claude per 30 seconds, an interval of 10 minutes (2 while watched), backoff on trouble up to one hour. A Claude's cadence is a fraction of what the CLI itself does (it fetches usage on every `/usage` and status refresh), and the CLI's own 60-second copy absorbs bursts.
- **Where it runs.** Docker and the local machine through the runtime's `exec`. Kubernetes uses the same exec ([Workspace Claudes](workspace-claudes.md) W3) 🔬.
- **Failure map.** Claude Code missing (exit 127): `unknown`, problem `not_installed`; no reply in time: `unknown`, `timeout`; a refusal or an unreadable reply: `unknown`, `unreadable`; workspace stopped: nothing is run. The text shown for a problem is fixed; Claude Code's output is never shown or logged.
- **Hooks and servers.** The probe starts no MCP server and writes no session. It sends no user message, so no turn hook (`StopFailure`) can fire. ✅ In a Docker workspace the stand-in saw only the profile, bootstrap, feature-flag and usage calls: no telemetry, no model request. A pool workspace is not probed (U8).

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

## 13. What the person sees

Under the text diet: words of one or two, numbers and bars, explanations in InfoTips. Phone first.

| Place | What it shows |
| --- | --- |
| Usage → Claudes | The Usage page has two tabs, Requests and Claudes (`?tab=claudes`); the tab carries a count of Claudes that are near a limit or out and not snoozed. One row per Claude, the neediest first: a status icon (within limits, near, out, not known, not signed in, no plan limits), the name, the plan as a small chip, the workspace, a sparkline of the week on wider screens, a chevron and a check icon button. Under it a bar per window: label, bar (accent, gold from 80 %, red from 95 %), percent, and the reset as a countdown ("2 h 10 m"; tap it for the time on this device's clock). Per-model weeks sit under the week; extra usage is one short line. |
| A Claude with no plan limits | One short line: "No plan limits". Signed out: "Not signed in". Not read: "Not read yet", or "Couldn't read usage" with an ⓘ that says why. |
| A stale row | Dimmed meters and the age ("3 h ago") beside the workspace; a stopped workspace says "stopped" and its check button is off. Unknown shows "—", never 0. |
| A Claude that is out | A line under its windows: "Room on Kresna · 65 % left" when another Claude on the same workspace has room. It says; it never switches. |
| The chevron | The history: a 1 d, 7 d, 30 d switch and a small line per window (the 80 % and 95 % marks faint behind it), and the snooze menu (1 hour, 4 hours, until it resets, alert me again). |
| Workspace sheet, Claude rows | A tiny two-bar meter (session over week) before the terminal button; tap opens Usage on that Claude. `ClaudeMeter`. |
| Switch dialog | One line under the destination: "Session 41 % · resets 14:20", "Out until 14:20", "No plan limits", "Not signed in". `ClaudeHeadroom` and `useHeadroom`, exported from `features/usage/claude` for A2's dialog. |
| Toasts | Anywhere in the app, once per alert on this device: "Satria: week 95 %", "Default: out until 14:20", with a way to the tab. |
| Info | An ⓘ on the tab says what the numbers are, where they come from, and that a dash is not zero. |

## 14. Security

- **No credentials.** The probe never opens a credentials file, never sets a token, and its environment is cleaned (§11). The only things read from the workspace are Claude Code's reply to one control request and `loggedIn` and `authMethod` from `auth status`; the rest of that output is dropped in memory.
- **No identity.** Neither table, the API, the logs nor the live socket carries an email, an organization name or an id of an account. The Claude's own label (its name) is enough. A canary test (§16) checks it.
- **Untrusted input.** Everything in a reply is untrusted: numbers are clamped (0 to 1000), times must parse, labels are cut to 40 characters, stripped of control characters and escaped by the page, the number of windows is capped. A reply that does not match drops the reading, not the portal.
- **Rate limits.** The limits of §11 hold for every caller: the scheduler, check-now, and the MCP tool (which never probes).
- **Guard.** Every route sits behind the session guard; mutating requests need the origin check. The MCP tool follows the registry's scopes.
- **Failing closed.** If the portal's store is locked or frozen, nothing probes.
- The workspace is not trusted either: a workspace can lie about its own usage. The numbers inform a person; no decision of the portal's depends on them.

## 15. Observability

One line per probe outcome in the portal log (`[claude-usage] <claude id> <what it runs on, or failed (problem)> in 515 ms`): never a number from the reading and never Claude Code's output. A background failure (a listing, a pass, a sink) is logged once per kind. The snapshot says when each Claude was last read and from which source. Alerts go to the live feed and to the sinks of §12; they are not written to the audit trail. Counters for the Monitoring dashboard are not built.

## 16. Testing

| Case | Covered by | Expected |
| --- | --- | --- |
| Parser: the observed plan replies (named windows, `limits[]` rows, extra usage), other shapes, malformed input, clamping, labels, plan names | `parse.test.ts` (12) | Windows, percents, reset times, tier and extra as in §10.1; every bad input drops a reading, never throws. |
| Passive parser: the observed events | `parse.test.ts` | Fractions become percents, Unix seconds become times; `rejected` makes the window exhausted; extra usage refused; nothing worth keeping gives null. |
| Probe: the shell wrapper on a real `sh` | `probe.test.ts` (8) | Only HOME, PATH, LANG, the three quiet switches, the pass-through names when set, and the Claude's own directory; a key, a token, a base URL and a stray `CLAUDE_CONFIG_DIR` are dropped; a value with a space stays whole; an invalid directory throws. |
| Probe: the protocol, with a scripted exec | `probe.test.ts` | One control line and no user message; a reply to another id is ignored; hang, 124, 127, a refusal and a failing exec each read as their problem; sign-in state tells signed out, key and a login without the profile scope apart; the canary never comes back. |
| Store | `store.test.ts` (5) | Rows only on change or after 30 minutes; history; retention (two days, hourly to thirty, nothing after, Claudes that are gone, never on an empty list); an unusable store reads as nothing. |
| Scheduler, check now, backoff, watch, the off switch, a store the portal does not trust | `service.test.ts` (17) | Only due Claudes of running, non-pool workspaces; one probe per workspace, two in all; backoff to an hour and back; settled states hourly; faster while watched; cooldown; nothing at all on a frozen store. |
| Passive hook | `service.test.ts` | Updates the windows it carries and leaves the probe's others; a Claude with no reading gets one; a refusal is exhausted at once; a pool, a stranger and rubbish do nothing. |
| Alerts | `service.test.ts` | Once per window, level and period; reset starts a period; rounding of a reset time is one period; a snooze is quiet and stays quiet; a restart repeats none; a throwing sink harms nothing. |
| Report, headroom, history, trend | `service.test.ts` | States of each kind, stale, pool hides an old reading; headroom as FR15; ranges, thinning to 200 points, the row's 28-point sparkline. |
| API | `routes.test.ts` (4) | Shapes, thresholds, alerts; no field names an account or a login; 422, 404, 409, 429 as FR18. |
| Portal MCP tool | `portalTools.test.ts` (2) | Through the real MCP endpoint: an admin token reads all or one, an agent only its own Claude. |
| Boot | `qa/boot.test.ts` (4) | Green with the module in. |
| Real Claude Code against the stand-in | `claude.integration.test.ts` (8) | A fake Max login reads as a plan with its windows and nothing is asked but the usage endpoint; `limits[]` rows, a model and extra usage; a 429 reads unknown; signed out and an `apiKeyHelper` read `none` and `key`; an API key in the environment makes the same login read "no plan limits" (why the environment is cleaned); the passive events of a real stream, including a refused turn. Skipped without `claude` and `openssl`. |
| Real Docker workspace | by hand, 2026-10-12 | A portal on a scratch database, one workspace `cu-a`: the scheduler's own probe found Default signed out in 515 ms; with a fake `apiKeyHelper`, `POST …/check` answered `key`, "No plan limits"; the probe command run by `docker exec` in the container (dash, user `node`, its own `claude`) against the stand-in with a fake Max login read the windows in 316 ms, an `ANTHROPIC_API_KEY` given to the exec was dropped, and the stand-in saw no telemetry and no model request. Other agents' running workspaces were left alone (`PORTAL_CLAUDE_USAGE_ONLY`). |
| UI | by hand, 2026-10-12 | Looked at in a real browser at 390 and 1280 px, light and dark, seeded for within limits, near, high, out, not known, stale, no limits and signed out: rows, sorting, the tab count, countdowns, history, the workspace sheet's tiny meter, the toast, check now (a real probe changed a row and the count), snooze (the row, the bell, the count). |

## 17. Milestones

| Milestone | Scope |
| --- | --- |
| K0 | This PRD and the research behind it. **Built.** |
| M1 | Server: probe runner, parser, store, scheduler, passive hook, `headroom`, routes, live topic, tests. **Built** and tried against the real CLI and a real Docker workspace (§16). Not yet called by the chat reader: the hook `onRateLimit` is assigned on the controller (`index.ts`) and waits for A2 to call it. |
| M2 | The Claudes tab, history, check now, the workspace sheet's meter, `ClaudeHeadroom` for the switch dialog. **Built** and looked at. `ClaudeHeadroom` waits for A2's switch dialog to show it. |
| M3 | Alerts (80 %, 95 %, out), toasts, snooze, the push seam (`onAlert`), the `claude_usage` Portal MCP tool, the "room elsewhere" hint. **Built.** Web Push **not built**: it does not exist in the code yet (§12). |

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

| ID | Question |
| --- | --- |
| Q1 | The plan's tier name (§6): approved provisionally by the coordinator for the owner, who has yet to confirm. |
| Q2 | Should an exhausted Claude's row offer a button that opens the switch dialog (with the Claude with the most headroom picked), or only say there is room (built)? |
| Q3 | Should thresholds (80 and 95) be a setting in [Settings & policies](settings-policies.md)? Draft: constants, `USAGE_THRESHOLDS` in the contracts. |
| Q4 | Should a probe run for a Claude whose only chat is asleep (no process)? Built: yes, the probe is independent of sessions. |
| Q5 | Should the Usage nav item show a dot while a Claude is near a limit? Built: only the tab's count and the toasts. |
