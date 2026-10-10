# PRD: Account Pool

| | |
| --- | --- |
| Status | **Draft v0.8.** ✅ = observed in our experiments on Claude Code 2.1.296 with fake keys and a local mock API, in print mode unless stated. 📄 = documented by Anthropic, not observed by us. 🔬 = unverified, listed in §19. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-10 |
| Depends on | [Pools foundation](foundation-pools.md) (storage, encryption, delivery engine, outbox) |
| Related | [Settings & policies](settings-policies.md) (thresholds, budgets, pause), [Monitoring dashboard](monitoring-dashboard.md), [Chat sessions](chat-sessions.md) |

## 1. Summary

Account Pool lets portal admins register Claude API credentials (Anthropic API keys, and keys for
custom Anthropic-compatible hosts), group them into pools, and assign a pool to any number of
workspaces. The portal shows each account's health and quota. When an account is limited or
rejected, the workspaces using it move to the next healthy account in their pool.

Credentials reach Claude Code natively, through its own managed settings and an `apiKeyHelper`
that reads the active account's key file, which the portal keeps current. The portal is not a
proxy. It never sits in the request path and never sees prompts or responses.

## 2. Background and problem

- Each workspace's Claude Code must be signed in by hand from its shell. Nothing is managed
  centrally, keys get pasted into individual containers, and nobody can see who uses which key.
- There is no view of quota. When a key hits a rate limit or spend cap, work in that workspace
  stops until someone notices and swaps the key by hand.
- The portal already manages workspaces on three targets: Docker in the devcontainer (DinD),
  Docker Desktop on the host, and a Kubernetes namespace. Whatever delivers credentials has to
  work on all three, including workspaces that are stopped when a change happens.

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Central accounts.** Add, edit, disable and remove accounts: an Anthropic API key, or a key for a custom Anthropic-compatible host. |
| G2 | **Pools.** Group accounts in priority order. One pool serves many workspaces. Assigning or changing a workspace's pool never requires recreating the workspace. |
| G3 | **Native delivery.** In an assigned workspace, `claude` is authenticated on first launch with no login prompt, on DinD, host Docker and Kubernetes, and catches up when a stopped workspace starts. |
| G4 | **Quota visibility.** Per account: health, headroom and reset times where the provider exposes them, recent errors, recent usage. Unknown is shown as unknown, never as zero. |
| G5 | **Automatic failover.** When an account is limited, exhausted or rejected, its workspaces switch to the next healthy account without a restart, and only then. |
| G6 | **Secrets stay secret.** Encrypted at rest, never returned to the browser, never logged. |

## 4. Non-goals

- **Claude.ai subscription accounts in pools.** See §6.
- **A proxy or gateway in the data path** (9router's model). This is a user requirement. It also keeps
  the portal out of the availability path, and Claude Code's gateway guide warns that proxies that
  buffer or rewrite requests break streaming, prompt caching and thinking signatures.
- **More capacity than the accounts are entitled to.** Anthropic enforces rate limits and spend caps
  **per organization**, so several keys from one organization share one ceiling. Failover only helps
  across organizations or hosts, or when a key is revoked or broken.
- **Per-request load balancing.** Moving a workspace between keys from different workspaces or
  organizations discards its prompt cache, which costs money and rate limit. Workspaces stay on one
  account until it has a problem.
- Billing, chargeback, reselling usage. Multiple users with roles. Other agent CLIs.

## 5. Users and stories

**Admin**: runs the portal, manages workspaces and credentials. **Workspace user**: opens a shell
or a chat session and uses `claude`. Today these are often the same person.

| ID | Story |
| --- | --- |
| US1 | As an admin, I add an Anthropic API key with a name. The portal checks it and shows its status. |
| US2 | As an admin, I add a custom host (base URL, how it expects the key, optional model names), then add keys for it. |
| US3 | As an admin, I create a pool, order its accounts, and assign it to workspaces, either when creating them or later. |
| US4 | As a workspace user, I run `claude` and it works with no login prompt. |
| US5 | As an admin, I see each account's health, headroom, reset times, recent errors and recent usage. |
| US6 | When an account is limited or exhausted, the workspaces using it switch to another account within the bound in §12.5, and I can see each switch in the event log. |
| US7 | As an admin, I disable or remove an account, and its workspaces move off it straight away. |
| US8 | As a workspace user with my own Claude subscription, I keep my workspace without a pool and run `/login` in it. The portal shows "own login" and never touches it. |
| US9 | As an admin, I unassign a pool. The workspace stops using pool credentials safely (§10.4) and falls back to whatever login it has. |
| US10 | When every account in a pool is exhausted, I see "waiting for quota until T" instead of silent failures. |

## 6. Scope boundary and compliance

This boundary is a requirement. It comes from Anthropic's published terms.

| Allowed | Not allowed |
| --- | --- |
| Storing the organization's own Anthropic API keys and using them in its own workspaces, for its own authorized users, billed to the key owner. | Collecting, storing or relaying Claude.ai subscription credentials or session tokens. Sign-in to a Claude account must go through Anthropic's own flow. |
| Failing over between API keys or hosts the operator is entitled to use. | Rotating subscription accounts to get past usage limits, or sharing one account's login across people or machines. |
| A user signing in to the unmodified Claude Code CLI with their own subscription, inside their own workspace. | The portal reading, copying or managing that personal login. |

Sources:
[Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
[Consumer Terms](https://www.anthropic.com/legal/consumer-terms),
[Usage Policy](https://www.anthropic.com/legal/aup),
[API rate limits](https://platform.claude.com/docs/en/api/rate-limits).

What this means for the product:

- The add-account form offers only "Anthropic API key" and "Custom host key". There is no
  "Sign in with Claude".
- Adding an account asks the admin to confirm that it belongs to them or their organization and
  that they're entitled to use it this way. Failover is presented as resilience, not a way around
  limits. The UI warns when a pool's accounts all belong to one organization (§11.4), because
  failover between them achieves nothing.
- Workspaces without a pool get no credential files. The portal never reads `~/.claude` login
  state, so it can't know whether a workspace has its own sign-in. Assigning a pool to an existing
  workspace therefore always asks for confirmation (FR9): the pool's key outranks that sign-in 📄
  and changes who pays.
- Automatic failover across API keys from several organizations the operator owns is the only case
  where failover adds capacity. Whether the Commercial Terms allow it is asked in writing (Q12), and
  the answer is recorded here.
- If people other than the operator use these workspaces, running Claude Code on hosted
  infrastructure falls under Anthropic's Commercial Terms. Confirming coverage is Q1 (§19).

## 7. Solution overview

```
 Portal                                           Workspace (any target)
 ┌──────────────────────────────┐   push via      ┌───────────────────────────────────────────┐
 │ Accounts, endpoints, pools   │   runtime API   │ /etc/claude-code/managed-settings.d/      │
 │ (encrypted store)            │ ──────────────▶ │   40-claudepilot-account.json             │
 │ Assigner: workspace → account│                 │     apiKeyHelper → account-key <id>       │
 │ Health engine (classify)     │                 │     env: base URL, model names, IDs       │
 │ Probes ─────────▶ Anthropic  │                 │     hooks: StopFailure → account-event    │
 │ Admin API (optional)         │                 │ /etc/claudepilot/account/<id>.key         │
 │ Event log, exposure ledger   │ ◀────────────── │ ~/.claudepilot/outbox/account.jsonl       │
 └──────────────────────────────┘  pull (archive  │ claude (unmodified CLI) ──▶ Anthropic     │
                                   API or exec)   └───────────────────────────────────────────┘
```

1. **Registry.** Endpoints (the Anthropic API, or a custom host) with accounts (keys) under them.
   Optional organization monitors hold an Anthropic Admin key per organization. Admin keys never
   enter a workspace.
2. **Pools and assignment.** A pool is an ordered list of accounts on one endpoint. A workspace is
   assigned a pool, and the assigner gives it one active account (§12).
3. **Delivery.** The portal writes a managed-settings drop-in, the active account's key file and two
   small scripts into the workspace through the runtime APIs it already holds (§10). Every rotation
   rewrites the drop-in, so Claude Code uses the new key from its next request ✅, without a restart.
4. **Signals.** The delivered helper logs each of its runs, and a managed `StopFailure` hook logs
   each failed turn, to an outbox file the portal pulls. Portal-side checks and probes read each
   key's status and rate-limit headers. Chat sessions run by the portal report retries live.
   Anthropic's Admin API (optional) reports key status and per-key usage.
5. **Health and failover.** A failure signal triggers a confirmatory probe, and its structured
   response is classified into an account state (§11). An unhealthy active account triggers
   reassignment, which rewrites the drop-in.

## 8. Functional requirements

### Accounts and endpoints

- **FR1** Endpoints: the built-in Anthropic API, or a custom host with name, base URL (stored without
  a trailing `/`, `/v1` or `/v1/messages`), and optional model names for the Opus, Sonnet, Haiku and
  default slots. Keys always reach Claude Code through the helper, which sends them as both
  `x-api-key` and `Authorization: Bearer` ✅. There is no bearer-only option, because the drop-in
  empties `ANTHROPIC_AUTH_TOKEN` (FR14). A host that rejects a request carrying both headers fails
  its first check (FR3) and is a compatibility gap (🔬 Q11). Custom hosts also have two settings
  that must be verified per host (🔬 Q11):
  - Context window and maximum output for its model names, delivered as
    `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 📄. For unknown names Claude
    Code otherwise assumes 200k and 32k, and marks its cost estimate's basis unknown ✅. An optional
    price per million tokens feeds the portal's estimates.
  - "Rejects Claude Code's beta flags", which sets `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` 📄.
- **FR2** Accounts: name, endpoint, secret (write-only), enabled flag, notes. The portal stores a
  fingerprint (SHA-256) and the last four characters so admins can recognize a key without
  decrypting it. Duplicate names are refused (409).
- **FR3** Check: on save and on demand, the portal validates the key (§11.2) and records the
  result. Checks send the key in both headers, as Claude Code does. A failed check still saves the
  account as "unknown", so keys can be staged before a host is reachable.
- **FR4** Bulk add: paste `name|key` lines. Each is checked one at a time, one second apart.
- **FR5** Discovering an account's organization and Anthropic workspace: from the
  `anthropic-organization-id` and `anthropic-workspace-id` response headers 📄. If the free
  `GET /v1/models` check doesn't carry them (🔬 Q4), the first probe does. Used to warn about pools
  that share one organization, and to share headroom probes (§11.2).
- **FR6** Organization monitors (optional): an Admin key per organization, used for read-only Admin
  API calls (key status and expiry, usage report per key, configured rate limits) and for one
  write: deactivating a compromised key when an admin asks (§14).

### Pools and assignment

- **FR7** Pools: name, endpoint, ordered members (up and down controls), strategy (§12.1),
  per-account workspace cap, proactive threshold (§12.2), probe models (§11.2), "hide `/login` in
  assigned workspaces" (on by default).
- **FR8** An account belongs to at most one pool in v1, so that each account's health, caps and
  workspaces have one owner.
- **FR9** Assign a pool when creating a workspace, or later from the workspace row or in bulk.
  "None (own login)" is always available. Assigning to an existing workspace needs an explicit
  confirmation (§13): the pool's key will outrank any sign-in the workspace has 📄, usage will be
  billed to the pool's account, and the features listed in §10.4 stop working.
- **FR10** The workspace row shows "Pool X · account Y", "Own login", or a problem ("Delivery
  failed", "Drifted", "Waiting for quota until T").
- **FR11** Removing an account or pool that is in use asks for confirmation and moves (or
  unassigns) the affected workspaces first. Removing an account also purges its key file from every
  workspace it was ever delivered to (§14).

### Delivery

- **FR12** Assigning, rotating or unassigning updates running and stopped workspaces on all three
  targets (§10). Rotations, disables, removals and revocations write straight through to stopped
  workspaces (§10.3). A workspace that starts while the portal is down still has its last good
  configuration.
- **FR13** Drift: the foundation's reconcile re-checks every delivered file by hash and rewrites any
  that changed or went missing ([Pools foundation](foundation-pools.md) §6.3).
- **FR14** Precedence guard: the drop-in sets `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and the
  `CLAUDE_CODE_USE_*` variables to empty values. ✅ Without that, an `ANTHROPIC_API_KEY` exported in
  the user's shell or user settings replaces the `x-api-key` header (and an `ANTHROPIC_AUTH_TOKEN`
  replaces `Authorization`) while the helper's key stays in the other, so requests carry two
  different credentials. A non-managed `ANTHROPIC_API_KEY` also makes Claude Code contact
  api.anthropic.com for remote settings at startup, which took 18 s when egress was blocked (only
  the TLS connection was seen, not whether the key is sent). Empty managed values neutralize both.
  The foundation's preflight ([Pools foundation](foundation-pools.md) §6.6) reports such settings
  by name, including the container's own environment. The assign confirmation (FR9) lists them and
  says which the drop-in overrides. The portal never edits the user's files.

### Health, quota and failover

- **FR15** Classify structured responses (checks, probes, chat-session retry events) with the rule
  table in §11.3 into an account state and an expiry. Signals from inside a workspace start a
  confirmatory probe (§11.5) instead of changing state themselves.
- **FR16** Probes (§11.2): key checks every 15 minutes; headroom probes on each pool's probe models,
  once a minute per organization and model group with active workspaces, configurable, and off for
  custom hosts unless enabled; confirmatory probes on failure signals, at most one per account per
  minute, on every endpoint (§11.5).
- **FR17** Failover per §12, with jitter and batching so many workspaces don't move onto one account
  at once.
- **FR18** Pool exhausted: keep the last key in place, mark the workspaces "waiting for quota until
  T" (the earliest recovery in the pool), and re-check at T. A helper that prints nothing fails the
  turn after 3 attempts in about 2 s ✅, while the last key keeps sessions in Claude Code's longer
  retry window.
- **FR19** Admin overrides: clear an account's cooldown, re-check now, take an account out of
  rotation, and pin a workspace to a specific account. Pause and resume follow
  [Settings & policies](settings-policies.md) §13.2: the workspace's key file is emptied and the
  drop-in rewritten so the next request sees it (§10.3), never removed. Resume restores the key the
  same way.

### Observability

- **FR20** Event log: account changes (never secrets), check and probe results, state changes,
  assignments, failovers (from, to, reason), delivery results, drift. Kept 90 days. The exposure
  ledger (which workspaces each account was delivered to, and when its key was purged there) is
  kept separately for the portal's lifetime, like the foundation's `exposures`
  ([Pools foundation](foundation-pools.md) §5).
- **FR21** Usage rollups per account, workspace and model, in UTC buckets, each with a source (Admin
  report, workspace telemetry, estimate) and an "estimated" label on cost. Per-workspace figures
  come from workspace telemetry, which [Monitoring](monitoring-dashboard.md) collects with a
  receiver inside the workspace and pulls through the outbox. Without it (telemetry off, or the
  Kubernetes fallback, which has no outbox), usage is per key from the Admin report.

## 9. Data model

Stored in the portal's database ([Pools foundation](foundation-pools.md)). Secrets are encrypted
columns.

| Table | Key fields |
| --- | --- |
| `endpoints` | id, kind (`anthropic` \| `custom`), name, base_url, model_names (json), context_tokens, max_output_tokens, price (json), disable_betas, created_at |
| `accounts` | id, endpoint_id, name, secret (encrypted), fingerprint, last4, organization_id and anthropic_workspace_id (discovered), enabled, notes, created_at |
| `org_monitors` | id, organization_id, admin_key (encrypted), last_ok_at |
| `pools` | id, name, endpoint_id, strategy, workspace_cap, threshold_pct, probe_models (json), hide_login, created_at |
| `pool_members` | pool_id, account_id, position, enabled |
| `assignments` | workspace_id (`target/name`), pool_id, active_account_id, pinned, assigned_at, state, waiting_until |
| `account_health` | account_id, scope (`*` or model group), state, reason, until, backoff_level, source, observed_at |
| `quota_snapshots` | organization_id, anthropic_workspace_id, account_id (probed), model_group, metric, limit, remaining, reset_at, source, observed_at (kept 7 days) |
| `account_events` | id, at, type, account_id, workspace_id, details (json, redacted) (kept 90 days) |
| `account_exposure` | account_id, workspace_id, first_delivered_at, last_delivered_at, purged_at. Extends the foundation's `exposures` and keeps its retention: the portal's lifetime |
| `usage_rollups` | bucket_start_utc, account_id, workspace_id, model, uncached_in, cache_read, cache_write_5m, cache_write_1h, output, cost_estimate, source (kept 13 months) |

`pools` and `assignments` extend the foundation's tables of the same name. Delivery status and file
hashes live in the foundation's `workspace_delivery` table and manifest. `enabled` (the admin's
intent) and health (what the portal observed) are separate. A failed check never flips `enabled`.

## 10. Delivery to Claude Code

### 10.1 What gets written

| Path in the workspace | Content |
| --- | --- |
| `/etc/claude-code/managed-settings.d/40-claudepilot-account.json` | `apiKeyHelper: "/etc/claudepilot/bin/account-key <account-id>"`. `env`: `ANTHROPIC_BASE_URL` (always; `https://api.anthropic.com` for the Anthropic endpoint), `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` (default `60000`: a safety net, and the window in §11.5), model names and custom-host settings (FR1), `CLAUDEPILOT_WORKSPACE`, `CLAUDEPILOT_ACCOUNT`, `DISABLE_LOGIN_COMMAND=1` (FR7), and empty `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` (FR14). Every variable Account Pool may set is always present, empty when unused (🔬 Q6), because a removed value lingers until relaunch ✅. `hooks.StopFailure` matching every category (`*`) runs `/etc/claudepilot/bin/account-event`; the portal does the classifying. |
| `/etc/claudepilot/account/<account-id>.key` | That account's key with no trailing newline, nothing else. `root:node 0440` ✅. The previous account's file is deleted at the next reconcile (§10.3). |
| `/etc/claudepilot/bin/account-key` | The helper. Reads the key file for its argument, appends one line to the outbox (event ID, time, account ID, the calling `claude` process, whether the file was empty), and prints only the key: from 2.1.227 any other output fails the helper 📄. An outbox write error never stops it printing the key. |
| `/etc/claudepilot/bin/account-event` | The `StopFailure` hook. Appends only an event ID, the time, error category, session ID and `CLAUDEPILOT_ACCOUNT`. Never copies `last_assistant_message`, `error_details` or the transcript path. |
| `/home/node/.claudepilot/outbox/account.jsonl` | Where both scripts append. On the home volume, so lines written just before a stop survive it. Owned by the workspace user. Collected by the portal ([Pools foundation](foundation-pools.md) §8). |

Both scripts are delivered with the bundle, not baked into the image, because existing Docker
workspaces keep the image they were created from.

Why each choice:

- **Managed settings** outrank user and project settings, `--settings` and shell exports ✅, and
  reload when a file is renamed into place ✅. Each pool type owns one numbered drop-in, merged with
  the others 📄. They're not a security boundary, because workspace users have `sudo`, but they keep
  a user's own settings from overriding the pool by accident. Server-managed settings from the
  organization of a user's own sign-in might outrank them (🔬 Q18).
- **`apiKeyHelper` is the only credential channel.** It sends the key as both `x-api-key` and
  `Authorization: Bearer` ✅. Claude Code re-runs it before every retry after a 401 ✅ (after a 403
  too 📄) and on the next request after any managed-settings write ✅. It outranks a `/login`
  session 📄, and unlike `ANTHROPIC_API_KEY` it has no documented approval prompt (🔬 Q9 for the
  interactive UI).
- **`ANTHROPIC_BASE_URL` is always written**, never removed: a removed `env` value lingers until the
  next launch ✅, while a changed value applies to the next request ✅.
- **`CLAUDEPILOT_ACCOUNT` in `env`** lets the hook record which account failed, because hook input
  carries no credential identity.
- Never use `ANTHROPIC_API_KEY` or a key in `env` (plain text, reaches every subprocess, needs approval),
  `forceLoginMethod` (blocks helper credentials at startup), or `CLAUDE_CODE_RETRY_WATCHDOG` (retries
  429s forever, so failover would never trigger).

### 10.2 Per target

| Target | Running workspace | Stopped workspace | Survives a restart without the portal |
| --- | --- | --- | --- |
| Docker (DinD, host) | Archive API writes each file under a hidden temporary name with owner and mode from the tar header (the key file's `root:node 0440` was kept on both daemons ✅), then `exec` as root renames it in place (🔬 Q16: not yet run on either daemon). An in-place archive overwrite was picked up without a restart ✅, but whether it is atomic is unknown (🔬 Q16). | Archive API writes into the container's filesystem: ✅ for a created, never-started container; 🔬 for one that has run and stopped (Q16). | Yes: files live in the container's filesystem until it's removed. |
| Kubernetes | The portal updates the workspace's Secret, then `exec`s `sync.sh` with the bundle on stdin, which writes the files into regular folders with a plain rename (🔬 Q19). | The Secret alone. An init container copies it into place when the pod starts. | Yes: the Secret is the source. |

Never mount the Secret at `managed-settings.d`: a kubelet-style symlink swap there was ignored, for
the helper and for `env` alike, while a plain rename was picked up ✅ (simulated kubelet swap). The
mechanism is shared by every pool and specified in [Pools foundation](foundation-pools.md) §6.2.
On the foundation's projected-volume fallback, for clusters where the portal may not `exec`, a
change waits for the kubelet (about a minute) and no outbox signals arrive, so the §12.5 targets
don't hold there.

### 10.3 Write order, key paths and rotation

1. Write the new account's key file at its own path, `/etc/claudepilot/account/<account-id>.key`.
2. Write the drop-in that names it. Key path, base URL and `CLAUDEPILOT_ACCOUNT` change together, in
   that one file. On Kubernetes both files change in one Secret update.
3. At the next reconcile, delete key files of accounts the workspace no longer uses, and record the
   purge in the exposure ledger (FR20).

Every file is validated before it's written, because a malformed managed-settings file stops every
Claude Code session in the workspace 📄 ([Pools foundation](foundation-pools.md) §6.1).

**Per-account paths keep keys and hosts paired.** During a 401 loop Claude Code re-runs the helper
before every retry ✅. If a move to another endpoint first wrote the new host's key into a path the
old drop-in still reads, the next retry would send that key to the old host. With one path per
account, the drop-in in effect can only ever read its own account's key. Old files are removed one
reconcile later, never in the same write.

**Rotation always rewrites the drop-in**, because the key path changes. ✅ Any write to a managed
settings file clears Claude Code's cached helper output, so the next request runs the helper and
uses the new key. Changing only a key file would wait for the cache lifetime, and the first request
after expiry would still go out with the old key while the helper refreshes in the background ✅.
The cache lifetime is a safety net, not the rotation path.

**Stopped workspaces get changes at once.** Rotations, disables, removals and revocations write
straight through to stopped workspaces instead of waiting for the foundation's 10-minute
stopped-workspace reconcile, because a stopped Docker container can be started outside the portal
(`docker start`). Writes into a container that has run and stopped are 🔬 (Q16).

### 10.4 Unassigning safely

A removed helper takes effect at once ✅, but a removed `env` value lingers until the next launch ✅.
When a lab session's drop-in was simply deleted, its custom base URL stayed in effect and the
session sent its fallback credential, a user-level helper's key, to that host ✅. A user's own
sign-in would leak the same way. So unassigning takes two steps:

1. Overwrite the drop-in with `ANTHROPIC_BASE_URL=https://api.anthropic.com`, every other Account
   Pool variable empty, and no helper or hook. The next request goes to that URL with the
   workspace's own credential ✅ (tested with a user-level helper). The empty
   `DISABLE_LOGIN_COMMAND` shows `/login` again in running sessions, which removing it would not
   (🔬 Q6, Q9).
2. After one reload interval, remove the drop-in and the key files (deletion per
   [Pools foundation](foundation-pools.md) §6.2). A stopped workspace skips step 1.

Moving to a pool on another endpoint needs no extra step: one drop-in write switches helper, key
path and base URL together (§10.3), and its empty values clear the old host's settings (🔬 Q6).

What users see:

- Running sessions with no credential of their own stop with "Not logged in · Please run /login" ✅
  until the user signs in or restarts. The workspace detail says so.
- While a pool is assigned, Remote Control and voice dictation are off because a helper is active 📄.
  With a custom base URL, Claude Code also prints an auto-mode notice saying classifier requests stay
  billed as before ✅; whether writing the default URL does the same is 🔬 (Q17). These come back
  after unassigning and restarting.

### 10.5 Portal-run chat sessions

- They rotate through the same drop-in. Managed settings outrank `--settings` ✅, so a chat session
  can't carry its own key or switch accounts in-band.
- Control-channel responses such as `get_settings` echo `env` values in plain text ✅ (stream-json),
  so chat-session logs redact every `env` value ([Chat sessions](chat-sessions.md)).

## 11. Quota monitoring and health

### 11.1 Signal sources

| Source | What it gives | Latency | Cost |
| --- | --- | --- | --- |
| Helper runs (all sessions) | One outbox line per run. Repeated runs by one process mean the key is being rejected (§11.5). | The second run comes about 1 s after the first 401 ✅, plus the pull interval (default 10 s for running assigned workspaces) | None |
| `StopFailure` hook (all sessions) | Error category, account, session. ✅ Fired with `error: "rate_limit"`; other categories 🔬 (Q14). | When a turn ends on an API error, after Claude Code's own retries: a rate-limited turn retried 11 times over about 3 minutes first ✅. Plus the pull interval. | None |
| Chat-session retry events (portal-run sessions) | `system/api_retry` per retry: HTTP status, category, retry delay ✅ (stream-json). A 401 that the helper's refreshed key fixed on the first retry emitted none ✅. | Live, before the error is shown | None |
| Confirmatory probe (§11.5) | The account's structured response: status, `error.type`, `error.details.error_code`, `retry-after`, rate-limit headers | Seconds after a signal; at most one per account per minute | One request: about 10 input tokens and 1 output token on the probe model |
| Key check: `GET /v1/models` | Valid or invalid key; organization and Anthropic workspace IDs (🔬 Q4) | On save, on demand, every 15 minutes | Free (no inference) |
| Headroom probe (§11.2) | `anthropic-ratelimit-*` remaining, limit and reset per model group (🔬 Q4: on successful responses) | Default 60 s, only where workspaces are active | Same as the confirmatory probe |
| Admin API (optional) | Key status and expiry; tokens per key per minute (about 5 minutes behind 📄); configured rate limits | Key status every 5 minutes | Free, needs an Admin key per organization |
| Workspace telemetry (optional, see [Monitoring](monitoring-dashboard.md)) | ✅ Per-request tokens, cost, model and upstream `request_id`, configured entirely from managed `env`. Events carry the current account even after a mid-session rotation. Errors appear only after retries run out, and no rate-limit data is included. Monitoring's receiver inside the workspace writes it to the outbox, so no route to the portal is needed. | The export interval (5 s) plus the pull interval | None |

### 11.2 Checks and probes

- A check or probe reports exactly one result: OK, invalid key (401), no permission (403), billing
  problem (402), spend limit reached, rate limited, wrong path (404), host unreachable, or other
  error. Only OK and rate limited count as a working key. A 404 is a failure, unlike in 9router.
- **Probe model.** Limits apply per model group 📄, so a probe measures only its own group. Each pool
  sets its probe models. The default is the group workspaces actually use: Claude Code's default
  model, `claude-opus-5-5` on 2.1.296 ✅, which has its own bucket 📄. A pool can add the Haiku
  group, which Claude Code uses for background work 📄. A custom-host pool probes the host's name
  for that slot.
- **Cost.** A probe is one `/v1/messages` request with about 10 input tokens and `max_tokens: 1`,
  billed at the probe model's price and counted against the bucket it measures. At one a minute, a
  probed group costs 1,440 requests and about 16,000 tokens a day.
- **Scope.** Limits are per organization (or a lower Anthropic-workspace limit) and model group 📄.
  The portal probes one key per organization, Anthropic workspace and group, and every account
  sharing them shows that figure.
- **Roll-up.** A group's headroom is its lowest remaining share across requests, input tokens and
  output tokens. The account row shows the pool's main group (its first probe model); other probed
  groups appear in the account detail. The proactive threshold (§12.2) uses the main group. A group
  with no data is unknown, never zero, and never triggers a move.
- Remaining tokens are rounded to the nearest thousand, and buckets refill continuously 📄. The UI
  shows "headroom as of HH:MM", not an exact countdown to zero.
- Custom hosts usually send no quota headers, so their headroom is unknown and their health comes
  from errors and confirmatory probes.

### 11.3 Classification

The rules apply to structured responses: checks, probes and chat-session retry events. Signals from
inside a workspace carry only a category, so they start a confirmatory probe instead (§11.5).
Fields are read in order: status, `error.type`, `error.details.error_code`, whether `retry-after` is
present, then message text. The rows follow Anthropic's documented errors 📄; the live-key smoke
test (§16) captures real responses before the table is frozen.

| Signal | State | Scope | Until |
| --- | --- | --- | --- |
| 429 with `enforced_spend_limit_reached` (no `retry-after`) | Exhausted | Whole organization | 00:00 UTC on the 1st, or the date in the message |
| 400 "You have reached your specified … usage limits" | Exhausted | Organization or workspace | The time stated in the message |
| 429 with `retry-after` | Cooling | Account and model group | now + `retry-after` |
| 429 without `retry-after` | Cooling | Account and model group | Probe's reset time if known, else backoff 2 s doubling to 5 min |
| 402 `billing_error` | Billing | Organization | Until a check succeeds |
| 401 `authentication_error` | Invalid | Account, all models | Until an admin edits or re-checks it |
| 403 `permission_error` | Needs attention | Account (or model, if model-specific) | Until re-checked |
| 404 `model: <id>` | Model unavailable | Account and model | Until re-checked |
| 529 `overloaded_error`, 500, 504, network | No change | (Anthropic-wide or transient) | |
| Other 400 / 409 / 413 / 422 | No change | (caused by the request, not the key) | |

Further rules:

- Never shorten an existing cooldown unless newer evidence is authoritative (`until = max(old, new)`).
- Escalate backoff at most once per cooldown window. Ignore failures from requests that started
  before the cooldown was written.
- An account recovers when its expiry passes and a check or probe succeeds, or when an admin
  clears it.
- The rule table is data with fixture tests, separate per endpoint.

### 11.4 Organizations

Accounts are grouped by their discovered organization. A pool whose accounts all share one
organization gets a warning: "These accounts share one Anthropic organization's limits; failover
between them won't help with rate limits or spend caps."

### 11.5 Detection and confirmation

Claude Code reports an API error only when the turn fails, after its retries, and the hook then
gives only a category ✅. Two in-workspace signals start detection, and the helper's log catches a
rejected key while the retries are still running. A portal probe decides.

1. **Helper runs.** Claude Code re-runs the helper before every retry after a 401 ✅ (13 runs in
   about 254 s at defaults; after a 403 too 📄). Otherwise a process runs it at most once per cache
   lifetime ✅, plus once after any managed-settings write ✅. So two or more runs by the same
   `claude` process less than one cache lifetime (60 s) apart, with no delivery to that workspace in
   between, mean its key is being rejected. Each line names the calling process (🔬 Q15). Runs that
   found an empty key file (a paused workspace) don't count.
2. **`StopFailure`.** Every category starts a probe. The category is only a hint: the hook script
   doesn't copy `error_details`, and the portal never relies on it.
3. **Confirmatory probe.** On either signal, and on chat-session retry events for 401, 403 and 429,
   the portal probes that account on the pool's main probe model and classifies the response with
   §11.3. At most one probe per account per minute; signals that arrive in the meantime share the
   next one.
4. **On disagreement, the probe wins.** A failed probe's classification applies, whatever category
   the hook reported. If the probe succeeds, the account stays healthy, the signal is logged as
   unconfirmed, and the workspace is reconciled in case its files drifted. Three unconfirmed signals
   for one account within 10 minutes flag it for review; they never move workspaces on their own.

## 12. Assignment and failover

### 12.1 Strategy

- **Sticky fill-first** (default): a workspace gets the highest-priority healthy account that is
  under its workspace cap and has headroom for the workspace's main model. It keeps that account
  until the account becomes unhealthy.
- **Sticky spread**: same, but new assignments pick the healthy account with the fewest workspaces
  (ties by priority), spreading load across organizations.

### 12.2 When a workspace moves

- A probe classifies its active account as Invalid, Billing, Exhausted or Needs attention, or the
  account is disabled or removed: move now.
- Its active account is Cooling for its main model group for longer than 2 minutes: move. Shorter
  cooldowns are left to Claude Code's own retries.
- Proactive threshold: headroom for the main model group below N% (default 15%), or tracked spend
  past a budget's rotate point: move at the next reconcile. The account takes no new workspaces
  until it is 10 points above the threshold or past its reset time. Values and budgets come from
  [Settings & policies](settings-policies.md) (FR10, FR11).

A move to another organization mid-conversation discards the prompt cache 📄; whether earlier
thinking blocks survive it is 🔬 (Q20).

### 12.3 Moving many workspaces at once

- Defaults: at most 5 moves onto any one account per minute, 0–10 s of random jitter, and the pool's
  per-account workspace cap. They are starting points with no measurements behind them, tunable per
  pool. With an organization monitor, the portal reads each organization's configured limits from
  the Admin Rate Limits API 📄 and suggests caps from them.
- Moves off an account that can't serve at all (Invalid, Billing, Exhausted, disabled, removed) skip
  the per-minute limit, because those workspaces can't work until they move. They keep the jitter
  and the caps.
- Prefer accounts in a different organization when the cause was a rate limit or spend cap. A
  sudden jump in one organization's usage can draw 429s from acceleration limits even under its
  configured limits 📄 (Q12), so batching and jitter ramp it up gradually.
- If no account is healthy: FR18 (keep the last key, "waiting for quota until T").

### 12.4 Concurrency

Assignment changes run in one database transaction (read health, pick, write the assignment). One
reconciler loop owns delivery. Nothing that matters lives only in memory.

### 12.5 How fast a failover lands

When Claude Code picks up a new key depends on the error. Detection follows §11.5. Delivery is one
archive upload and one `exec` on Docker, and a Secret update plus an `exec` on Kubernetes (🔬 Q19).

| Error | Detected by | What Claude Code does | Target after the portal rotates (§10.3) |
| --- | --- | --- | --- |
| 401 / 403 (revoked, invalid) | Helper runs, confirmed by a probe | Re-runs the helper before every retry ✅. Gives up after 13 attempts, about 4 minutes ✅. | The session continues on the new key **within 40 s of the first 401**. The turn survives. |
| 429 rate limit | Headroom probe before the limit; otherwise the portal's own probe, or `StopFailure` after Claude Code's retries, confirmed by a probe | Retries with the **same** key ✅: `retry-after` is a floor, then exponential backoff. 11 attempts, about 3 minutes. | **The next API request** uses the new key: the next tool step or the next turn ✅. The request already retrying keeps the old key. |
| Spend cap (429 without `retry-after`), 402, user-set limit (400) | `StopFailure` (category 🔬 Q14), confirmed by a probe | Fails without the long retry loop 📄. Only a mocked 400 credit-balance error was observed, failing at once ✅ (stream-json). | Workspace moved **within 30 s** of the event; the next request uses the new key. |
| 529 overloaded, 500, 504 | Not a failover signal | 529: at most 3 attempts in about 2 s ✅. With a fallback model (`--fallback-model` ✅, or the `fallbackModel` setting 📄), switches model natively. | No rotation (not the account's fault) |
| No key at all (helper prints nothing) | Never caused by failover | Fails after 3 attempts in about 2 s, showing the helper's error ✅ | Never on exhaustion: the pool keeps its last key (FR18) |

The 401 target in numbers: the second helper run comes about 1 s after the first 401 ✅, the next
pull within 10 s, then the probe, up to 10 s of jitter (§12.3) and delivery. Claude Code's retries
came about 17 s and 37 s after the first 401 in our run ✅, so the new key lands on one of those
(🔬 Q15 measures it end to end).

So a rate limit costs the user one failed turn unless the portal moves the workspace first. Two
levers reduce that:

1. **Proactive threshold** (§12.2): move before the limit, so no request ever sees the 429. This is
   the main tool.
2. **Fail over faster** (optional, in [Settings & policies](settings-policies.md)): when the pool has
   another healthy account in a different organization, set `CLAUDE_CODE_MAX_RETRIES` lower (for
   example 4) in managed `env`. ✅ The value is honored from managed settings. The turn then fails
   sooner, `StopFailure` fires, and the next request already uses the new account. It also shortens
   the 401 window, which is `CLAUDE_CODE_MAX_RETRIES` + 3 attempts ✅, so the 401 target must be
   re-checked at the chosen value (🔬 Q15).

## 13. User experience

All screens use the existing components (Card, Section, Badge, Menu, FormDialog, ConfirmDialog,
Select, StatTile) and work on phones and desktops.

**Accounts page** (new navigation item "Accounts"):

- **Pools** section: one card per pool. Name, endpoint, health counts ("3 healthy · 1 cooling ·
  1 invalid"), member list in order, "Used by N workspaces", and actions (edit, add account, delete).
- **Accounts** section: one row per account. Name, masked key (`sk-ant-…a1b2`), endpoint, status chip
  with a live cooldown countdown ("Cooling · 2m 30s"), an error tag (AUTH, 429, CAP, BILL, NET),
  a headroom bar for the main model group (green above 70%, amber 30–70%, red below 30%) with
  "headroom as of HH:MM" and the reset time, a flag for unconfirmed signals, workspaces using it,
  and a menu (Check, Edit, Disable, Clear cooldown, Deactivate at Anthropic when a monitor exists,
  Remove). Filter by pool, status or endpoint; sort by lowest headroom or soonest reset. The account
  detail lists every probed group.
- **Endpoints** section: the Anthropic API and custom hosts. A custom host shows its model names,
  context window, maximum output and beta-flags toggle, each marked "unverified" until checked
  against that host, plus "Import models" from the host's `/v1/models`.
- **Organizations** section (optional): Admin keys per organization, and their last successful
  report.
- **Event log**: a filterable timeline of failovers, state changes and checks.

**Add account dialog**: type (Anthropic API key or Custom host key), name, key (password field, never
shown again), Check button, ownership confirmation. Saving runs the check and shows the result
inline.

**Pool editor**: name, endpoint, ordered members (up and down buttons), strategy, workspace cap,
probe models, proactive threshold, "hide /login".

**Workspaces**: the create dialog gets an "Account pool" select ("None (own login)" first). Each row
shows a pool chip. Assigning a pool to an existing workspace, alone or in bulk, opens a
confirmation: "This workspace may have its own sign-in. From its next request, Claude Code will use
the pool's key instead, usage will be billed to the pool's account, and Remote Control and voice
dictation will be off." It also lists the preflight findings (FR14). The admin confirms with
"Assign and override sign-in". The workspace detail shows the active account, the last switch and
why, delivery status, and a preview of the injected files with the key redacted. Inside the
workspace, v1 adds nothing, because a managed status line would replace the user's own: users see
Claude Code's own errors, and the portal shows the state on the workspace row and in its chat
sessions.

## 14. Security requirements

- **At rest:** secrets are encrypted with AES-256-GCM under a key from `PORTAL_SECRET_KEY`. The portal
  won't enable Account Pool without it and never stores it beside the data. Backups and exports
  never contain plaintext secrets.
- **In the browser:** secrets are write-only. A blank field on edit keeps the stored value. Lists use
  the masked form and the fingerprint.
- **Logs and errors** never contain secrets, chat-session control logs included (§10.5). Provider
  error text is redacted before it's stored.
- **Admin keys** are used only by the portal, for read-only Admin API calls and the deactivate action
  below, and are never written into a workspace.
- **Inside workspaces:** whatever Claude Code reads, a workspace user can read too, and users have
  `sudo`. The product treats every key in a pool as shared with every user of the workspaces
  assigned to it. It recommends a dedicated Anthropic workspace per pool with a spend limit, and
  records every workspace an account was delivered to in the exposure ledger (FR20).
- **Copies outside the portal:**
  - Docker: the key file sits in the container's writable layer, on the DinD daemon's storage or
    inside the Docker Desktop VM's disk. `docker commit`, `export` and `cp` copy it, and deleting it
    doesn't erase the disk blocks.
  - Kubernetes: the workspace's Secret sits in etcd (encryption at rest on k3s is foundation Q3),
    readable by anything allowed to read Secrets in the namespace, including the portal's
    cluster-admin kubeconfig, and `sync.sh` copies it into the pod.
  - A stopped workspace keeps its last key until it's purged. Claude Code itself wrote no key to
    disk ✅.
  - On Docker, v1 keeps keys on disk, not tmpfs, because a tmpfs copy wouldn't survive a restart
    without the portal (G3) and would need containers recreated. On Kubernetes the pod's copy is in
    a memory-backed `emptyDir`, and the Secret is the durable copy.
- **Purge:** after a rotation, the old account's key file goes at the next reconcile (§10.3).
  Removing an account deletes its key file from every workspace in its exposure ledger, running or
  stopped (Docker: `exec rm`, or an empty file while stopped, 🔬 Q16; Kubernetes: the Secret entry).
  Workspaces that can't be reached stay "purge pending" and are retried at each reconcile.
- **Compromised key:**
  1. Revoke it at Anthropic; removing it from the portal doesn't. Use the Console, or "Deactivate at
     Anthropic" when its organization has a monitor (Admin API `POST /v1/organizations/api_keys/{id}`
     with status `inactive` 📄; matching the stored key to its Admin API ID is 🔬 Q3).
  2. Remove the account in the portal: its workspaces move off and its key file is purged everywhere
     (FR11).
  3. Check the exposure ledger for who could read it and, with a monitor, the key's usage since its
     first delivery.
- **If the portal is gone for good**, workspaces keep their last key and nothing rotates or purges:
  revoke the keys at Anthropic. To retire a portal on purpose, `portal decommission` first
  unassigns every workspace in the safe order and deletes its files and Secret. A portal that
  starts with a locked secret key or an empty database must freeze delivery, never reconcile "no
  assignments" into unassigning every workspace. Both are [Pools foundation](foundation-pools.md)
  §6.5 requirements.
- **Leak prevention:** a base URL is never in effect without its own account's key (§10.3, §10.4).
- **Probes to custom hosts** go through an SSRF guard (no private address ranges unless the admin
  allows them), a 10 s timeout, and readable errors.

## 15. Observability and audit

- Every portal action on accounts, pools and assignments goes into the event log with who, what and
  when, without secrets. "Who" is only a session ID: everyone signs in with one shared code, so
  entries are anonymous unless named admins are added (Q13).
- Delivery results per workspace, and drift found and repaired.
- The exposure ledger (FR20) answers "which workspaces ever had this key".
- Metrics for the [Monitoring dashboard](monitoring-dashboard.md): failovers per hour, accounts by
  state, workspaces waiting for quota, probe failures and probe tokens, unconfirmed signals,
  delivery failures.

## 16. Testing and verification

Every ✅ in this PRD comes from single runs on one Claude Code version. These suites keep them true.

| Suite | What it covers | When |
| --- | --- | --- |
| Lab regression | The mock-API scenarios behind the ✅ marks (sandbox E1–E7 and X1–X8, critic cells A–L), the error-class matrix (Q14), helper-run detection (Q15), and an endpoint change during a 401 loop. Fake keys, `--network none`, print mode and stream-json; the interactive UI under tmux once Q9 is done. Produces the §11.3 fixtures and §12.5 timings. | CI, on each Claude Code version before the pinned version moves; a failure blocks the bump |
| Docker end to end | DinD: create, assign with consent, rotate, unassign, remove and purge, on running, never-started and stopped-after-start containers; write atomicity with inotify and a tight `cat` loop (Q16). Repeated on Docker Desktop before release. | CI |
| Kubernetes end to end | k3d or kind: Secret update, `sync.sh`, init copy, scale to 0 and back. Then the real k3s cluster (Q19). | CI; M4 gate |
| Live-key smoke test | An API key from a low-tier Console organization with a small spend limit, supplied by the operator; never a subscription credential. Same key in both headers; two different values; all response headers of one 1-token `/v1/messages`, one `count_tokens` and one `GET /v1/models`; an invalid key; optionally the real spend-limit 400; with an Admin key, the `partial_key_hint` match. Answers Q3, Q4, Q5 and Q10. | Manual, gated |
| Secret-leak checks | A canary key runs through every flow, then API responses, logs, the event log, exports, backups, the web bundle and chat-session logs are searched for it. | CI |
| Fault injection | Portal killed mid-write; a malformed drop-in; concurrent reconciles; a restart with a locked secret key or an empty database (delivery must freeze); a stopped container started outside the portal; an outbox at its size cap. | CI |

## 17. Rollout and milestones

| Milestone | Scope | Gate |
| --- | --- | --- |
| M1 | Foundation pieces this PRD needs: F1, F2 and F4 (database, encryption, Docker delivery with drop-ins and reconcile, outbox, exposure records). Kubernetes delivery in M4 also needs F3. | Foundation PRD approved |
| M2 | Endpoints and accounts: CRUD, checks, bulk add, organization discovery, Accounts page | |
| M3 | Pools and assignment with consent; Docker delivery with per-account key paths; workspace create and row integration; safe unassign; exposure ledger and purge | Docker suite and write test (Q16); interactive test (Q9) |
| M4 | Helper-run and hook signals, confirmatory probes, classification, failover, event log; Kubernetes delivery | Error-class matrix (Q14), helper-run detection (Q15), Kubernetes end to end (Q19) |
| M5 | Headroom probes, quota UI, optional organization monitors (usage, key status, deactivation) and usage rollups | Live-key smoke test (Q3, Q4, Q5, Q10) |
| M6 | Proactive threshold failover, herding controls, budgets (with Settings & policies) | |

## 18. Success metrics

| Metric | Target |
| --- | --- |
| Time from assigning a pool to `claude` working in that workspace | Under 1 minute on every target |
| 401/403: session continues on a new key | Within 40 s of the first 401 |
| Rate limit or spend cap: workspace moved | The next request uses the new key; spend caps moved within 30 s of the event |
| Moves that happen before the limit, with headroom probes on | At least 90% |
| Secrets in API responses, logs (chat-session logs included), exports or the browser | Zero, checked by the leak suite (§16) |
| Workspaces left on an invalid, billing or exhausted account | Zero after one reconcile cycle |
| Failovers caused by 529 or request errors | Zero |

## 19. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | Will people other than the operator use these workspaces? If yes, confirm Commercial Terms coverage with Anthropic. | Operator |
| Q2 | Where does the portal run in production? Nothing in this PRD needs workspaces to reach it: delivery is pushed and signals are pulled. Whether k3s pods could reach it (inferred: no, untested) therefore changes nothing. | Operator |
| Q3 | Will Admin keys be provided per organization? The Admin API isn't available to individual accounts 📄. 🔬 Can its `partial_key_hint` be matched to our stored last four characters, for per-key usage and deactivation, and how far behind does per-key usage run in practice? | Operator; live-key test |
| Q4 | 🔬 Do successful `/v1/messages` and `count_tokens` responses carry `anthropic-ratelimit-*` headers, and does `GET /v1/models` carry `anthropic-organization-id` and `anthropic-workspace-id`? If `count_tokens` reports the model group's limits, it replaces the paid headroom probe. | Live-key test |
| Q5 | 🔬 Does a zero-credit account return 402 `billing_error` (documented) or 400 (third-party reports)? | Live-key test |
| Q6 | Empty `env` values: ✅ an empty managed `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` cancels the same variable exported in the shell. 🔬 Do empty model-name, context, beta-flag and `DISABLE_LOGIN_COMMAND` values also behave as unset? | Lab test |
| Q7 | Should pools mix endpoints in a later version? A base URL change reaches a running session's next request ✅, so Claude Code doesn't block it. v1 keeps one endpoint per pool because model names, per-host compatibility (key headers, context window, beta flags), the error rule table and probes are per endpoint, and every change of host needs the safe switch in §10.3–10.4. | Product |
| Q8 | Can Account Pool support Claude Code older than the foundation's minimum, 2.1.296 ([Pools foundation](foundation-pools.md) §9)? Helper refresh, retry counts, drop-in watching and hook fields vary between releases; the lab suite (§16) runs per version. | Engineering |
| Q9 | 🔬 Confirm in an interactive session: no onboarding, trust or approval screen on a fresh home folder with the managed helper and hook; the retry UI; whether the user's next prompt is the next request; `StopFailure` firing; an empty `DISABLE_LOGIN_COMMAND` showing `/login` again; the auth-conflict warning beside a saved login. | Implementation test |
| Q10 | 🔬 Does the real API accept the same key in both `x-api-key` and `Authorization: Bearer` (what the helper sends)? What does it do with two different values (what a stray `ANTHROPIC_API_KEY` causes)? The mock accepted both. | Live-key test |
| Q11 | 🔬 Which custom hosts will be used? For each: does it accept both headers, forward Claude Code's beta flags (or need `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`), and serve `/v1/models`; what does it return for an invalid key, an exhausted budget and a throttle; do the context and output settings take effect? | Operator; per-host test |
| Q12 | Ask Anthropic in writing: is automatic failover across API keys from several organizations the operator owns acceptable under the Commercial Terms, and with what limits? Also ask what acceleration-limit 429s look like, and whether any API reads a Console organization's spend cap. Record the answers in §6. | Operator |
| Q13 | Everyone signs in with one shared code, so the audit log can't name who added a key or moved a workspace. Accept anonymous audit, or add named admins before the portal stores third-party keys? | Product |
| Q14 | 🔬 Error-class matrix on the pinned version: 429 with `enforced_spend_limit_reached` and no `retry-after`, 429 with `x-should-retry: false`, `retry-after` above 60, the user-set limit 400, 402, 403, model 404, an error after a 200. For each: attempts and their timing, helper re-runs, `StopFailure` category, and chat-session `api_retry` events. | Lab test |
| Q15 | 🔬 Helper-run detection: run cadence under a persistent 401; time from the first 401 to the session continuing on a new key, with a 10 s pull; whether the 40 s target holds with a lower `CLAUDE_CODE_MAX_RETRIES`; how the helper reliably names its `claude` process (its parent is a shell). | Lab test |
| Q16 | 🔬 Docker writes on DinD and Docker Desktop: hidden temporary name plus `exec` rename versus an in-place archive overwrite (atomic for the file watcher and a concurrent `cat`?), and writes into containers that have run and stopped. | Lab test |
| Q17 | 🔬 Does writing `ANTHROPIC_BASE_URL=https://api.anthropic.com` behave differently from leaving it unset: the auto-mode notice, Remote Control, the server-managed settings fetch, model discovery? If so, write it only for custom hosts and when leaving one. | Live key or TLS-intercepting mock |
| Q18 | 🔬 Can server-managed settings from the organization of a workspace's own sign-in outrank the drop-in (the first managed source wins 📄)? The portal never looks; a person can check `/status` with their own sign-in. | Manual test |
| Q19 | 🔬 Kubernetes end to end on k3s: Secret propagation, `sync.sh` through `exec` as uid 1000 into the `fsGroup` `emptyDir`s (also under `allowPrivilegeEscalation: false`), the init copy, and delivery time ([Pools foundation](foundation-pools.md)). | Implementation test (M4) |
| Q20 | 🔬 After a move to another organization mid-conversation, does the API accept, strip or reject earlier thinking blocks? If it rejects them, cross-organization moves must wait for a new session. | Live-key test with two organizations |
