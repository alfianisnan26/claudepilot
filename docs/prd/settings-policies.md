# PRD: Settings & policies

| | |
| --- | --- |
| Status | **Draft v0.6.** v0.6 records what was built: the shared settings store and the owner's two MCP switches, "Account MCP off" and "Pool MCP only" (§22). The rest of this PRD (policies, budgets, limits, the sandbox) is **not built**. ✅ = observed in our labs on Claude Code 2.1.296 (the foundation's, Account Pool's sandbox runs E1–X8, the cross-pool lab, and the Secrets & env and Chat sessions runs), in print mode unless stated. Documented facts link to Anthropic's docs. 🔬 = unverified, listed in §21. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [Pools foundation](foundation-pools.md) (storage, assignment, delivery engine, outbox), [Account Pool](account-pool.md) (rotation, pausing and per-key spend act through it), [Monitoring dashboard](monitoring-dashboard.md) (telemetry spend, policy signals) |
| Related | [Chat sessions](chat-sessions.md) (session limits), [MCP set](mcpset-pool.md), [Skillset](skillset-pool.md), [Secrets & env](secrets-env-pool.md) and [Browser & desktop](browser-desktop-pool.md) (planned) pools (policy requirements), [Persona pool](persona-pool.md) (model defaults), [Portal MCP server](portal-mcp.md) (relaxing changes stay UI-only), [Web app & PWA](web-app-pwa.md) (navigation, re-auth) |

## 1. Summary

Settings & policies is where admins decide how Claude Code may behave in workspaces and how much it
may spend: allowed permission modes (Bypass permissions included), managed deny, ask and allow rules,
the shell sandbox, MCP server, skill and workflow restrictions, allowed models and effort, rotation
thresholds, budgets, concurrency caps, resource defaults and retention. Values are set globally, in
reusable policies and per workspace, and every screen shows the effective value and where it comes
from.

Permission controls reach Claude Code natively, in the managed-settings drop-in
`10-claudepilot-policy.json` that the foundation delivers. Limits Claude Code can't enforce itself
act through levers the portal already holds: Account Pool's drop-in and key file, and the flags the
portal passes to the chat sessions it starts. The portal is never in the request path. Each workspace
shows what its policy actually guarantees. Today's workspaces give users `sudo`, so a policy there is
precedence and guidance. The optional hardened image, plus a sandbox that a probe shows can start,
makes it binding.

## 2. Background and problem

- Workspaces run Claude Code with built-in defaults. Since v2.1.283 interactive sessions start in
  Auto mode unless a setting says otherwise ([permission modes](https://code.claude.com/docs/en/permission-modes)),
  and in our labs print mode started in Auto in some runs and Manual in others ✅. Nothing stops
  anyone from starting in Bypass permissions in a container with internet access and delivered
  credentials, a setup Claude Code's docs advise against.
- Account Pool fails over after an account reports a problem. A rate limit or spend cap costs one
  failed turn, and a spend cap also takes that organization's accounts out until 00:00 UTC on the
  1st ([Account Pool §12.5](account-pool.md)). Admins want workspaces to move earlier, at a
  threshold they choose.
- Nobody can cap spend per workspace or session. Console spend limits have no documented write API,
  and the Spend Limits API is Enterprise-only ([Spend Limits API](https://platform.claude.com/docs/en/manage-claude/spend-limits-api)).
- Today's workspaces can't enforce much. Users have passwordless `sudo`, Claude's sandbox can't start
  under Docker's default seccomp profile ✅ ([Secrets & env §10.4](secrets-env-pool.md)), and on
  Kubernetes the delivery folders are writable without `sudo` ([foundation §6.2](foundation-pools.md)).
- Defaults are scattered: CPU and memory in the create dialog (2 CPUs and 4 GB, at most 4 CPUs and
  8 GB, "No limit" on every target), bounds in server validation (up to 64 CPUs, no memory ceiling),
  retention periods in each PRD.

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Permission policy.** Per scope: whether Bypass and Auto are allowed, the starting mode, which actions are denied, asked or allowed, and which MCP servers, marketplaces and workflows may run. Delivered natively on all three targets. |
| G2 | **Rotate before exhaustion.** Headroom and spend thresholds move workspaces to another account before a rate limit or spend cap stops them. |
| G3 | **Budgets and caps.** Monthly budgets per organization, account, account pool and workspace, each matched to the Anthropic limit it protects; budget and turn caps per chat session; concurrency caps per workspace and in total. |
| G4 | **Clear inheritance.** Global, then policy, then workspace (accounts: Global, then account pool, then account). Every value shows its source. |
| G5 | **Simple by default.** Presets and sensible defaults; most admins never open Advanced. A common change takes three taps or fewer from the Settings page, not counting a confirmation. |
| G6 | **Honest enforcement.** Each workspace shows whether its policy is enforced, guidance only or not applied, and which controls can't run there. Each spend figure shows its source and age. |

## 4. Non-goals

- **A security boundary in the standard image.** Users have `sudo`; the hardened image (§14) is the
  option for enforcement.
- **Controls a workspace can't run.** The portal never writes the sandbox or the env scrub where the
  probe hasn't passed (FR21), and a pool requirement never fails a delivery (FR8).
- **Hard real-time spend caps** or writing Anthropic Console limits. Budgets act on figures that
  arrive seconds to minutes late (§13.1) and sit under the limits admins set at Anthropic.
- **Turn or dollar caps for terminal sessions.** Claude Code offers them only in print mode and the
  SDK ([CLI reference](https://code.claude.com/docs/en/cli-reference)). Terminals are counted, not
  capped (🔬 Q9).
- **Subscription limits.** The portal never reads plan usage (status line `rate_limits`, the SDK's
  `RateLimitEvent`), which describes claude.ai subscriptions, not API keys.
- Network control for the whole container, admin roles, admin-authored hooks, daily or weekly budget
  periods (v1 uses calendar months in UTC), and editing users' own settings files.

## 5. Users and stories

**Admin**: runs the portal and sets policy. **Workspace user**: uses `claude` in a terminal or a chat
session. Often the same person today.

| ID | Story |
| --- | --- |
| US1 | As an admin, I see each setting's effective value and source, and change a common one in three taps or fewer from the Settings page. |
| US2 | As an admin, I block Bypass permissions everywhere, then allow it, even as the starting mode, for workspaces in my "Autonomous" policy. |
| US3 | As an admin, I start from a preset (Strict, Standard, Autonomous) and adjust a few fields without writing JSON. |
| US4 | As an admin, I add a deny rule such as `Bash(git push *)` that holds in every mode, Bypass included, and reaches every running workspace within 2 minutes. |
| US5 | As an admin, I set "rotate below 15% headroom" and "rotate at 90% of a $200 monthly organization budget", so workspaces move before Anthropic stops them. |
| US6 | As an admin, I give a workspace a monthly budget and choose whether reaching it alerts me or pauses it. |
| US7 | As a workspace user, I start a chat session with a mode, model, effort, budget and turn limit within the limits, and see why an option is missing. |
| US8 | As an admin, I cap chat sessions per workspace and in total, so one workspace can't drain an account's rate limit. |
| US9 | As an admin, I set default and highest CPU and memory per target, and how long records and transcripts are kept. |
| US10 | As an admin, I see which workspaces treat the policy as guidance only and which controls can't run there, switch one to the hardened image, and see who changed which setting. |

## 6. Scope boundary: what a policy guarantees

| Control | Enforced by | Holds against | Doesn't hold against |
| --- | --- | --- | --- |
| Deny and ask rules; Bypass and Auto locks | Claude Code, from managed settings ([permissions](https://code.claude.com/docs/en/permissions)) | The model; user, project, local and `--settings` values; CLI flags | Whoever can write the policy file (row 3). Shell rules match command text: a deny on `curl` doesn't stop `sh -c 'curl …'`. Read and Edit denies miss scripts: without the sandbox, the cross-pool lab read the account key with `python`, `grep -r` and a command substitution ✅. |
| Allowlists (MCP servers, network hosts); restricting hooks | Claude Code, only with each one's managed-only lock | With the lock: entries and hooks that user and project settings add | Without the lock: anything a lower scope adds. List settings combine across scopes and reload live ([settings](https://code.claude.com/docs/en/settings)), and user hooks run outside the sandbox. |
| The policy file itself | File ownership and mounts | Docker: users without `sudo` (hardened image). Kubernetes with the sync sidecar or the projected fallback: everyone, since a read-only mount can't be written or remounted even by root (✅ on Docker in the Secrets & env tests; 🔬 foundation Q5 on k3s) | Docker standard image: `sudo`. Kubernetes primary path without the sidecar: the workspace user, with no `sudo` and no prompt, so Ask before sudo doesn't protect it ([foundation §6.2](foundation-pools.md)). A change there applies live until the next 60 s drift check. |
| Hardened image (§14) | Container runtime: no `sudo`, no capabilities | Users changing the policy or the CLI | Reading delivered secrets, which the helper and tools need. A nested `claude --bare` if that mode skips managed settings (🔬 Q22). |
| Sandbox | bubblewrap, where the probe passed (FR21) ([sandboxing](https://code.claude.com/docs/en/sandboxing)) | File and network access by shell commands | Claude's file tools, MCP servers and hooks, which run outside it. Workspaces where it can't start: today, every Docker workspace ✅. |
| Session budget, turn caps | Chat launch flags and the portal's own total (FR12) | Runaway chat sessions | Terminal sessions; requests in flight at the stop |
| Organization, account, pool and workspace budgets | Portal, from spend figures (§13) | Sustained overspend | Bursts inside the reporting lag; spend it can't see |
| Concurrency caps | Portal, for sessions it starts | Too many chat sessions | Terminal sessions (counted only) |

- **Enforced** needs all of: the hardened image; a policy path the workspace user can't write; the
  managed-only lock for each allowlist the policy uses, plus the hooks lock where the sandbox runs;
  and Q22 answered. Anything less is **Guidance**, and the UI says so (FR17).
- Deny rules apply in every mode, Bypass included; allow rules have no effect in Bypass. Claude Code
  recommends Bypass only in containers without internet access. Ours have it, and the UI says so.
- Budgets and pausing cover pool-billed spend only. Own-login workspaces are never paused or counted.
- An own-login workspace signed in to an organization with server-managed settings gets that policy
  instead of the file policy, because Claude Code uses only the highest-ranked managed source
  ([managed settings](https://code.claude.com/docs/en/managed-settings#how-claude-code-combines-managed-sources)).
  Pool workspaces aren't affected: `apiKeyHelper` keys don't trigger that fetch. Detecting it is Q14.

## 7. Solution overview

```
 Portal                                            Workspace (any target)
 ┌──────────────────────────────────┐   push via   ┌─────────────────────────────────────────┐
 │ Registry: every setting, once    │  foundation  │ /etc/claude-code/managed-settings.d/    │
 │ Resolver: Global → Policy → WS   │ ───────────▶ │   10-claudepilot-policy.json            │
 │   Global → Account pool → Account│   delivery   │   permissions, sandbox, MCP, models     │
 │ Checks: probe, version, loading  │◀─── exec ────│ policy-probe, claude doctor             │
 │ Limits: thresholds, budgets      │─▶ Account ──▶│ account drop-in and key file (pause)    │
 │ Chat sessions: flags, caps       │─── exec ────▶│ claude (unmodified CLI)                 │
 │ Enforcement state, audit log     │ ◀ Monitoring │ outbox: modes, Bypass, spend, tamper    │
 └──────────────────────────────────┘              └─────────────────────────────────────────┘
```

1. **Registry:** each setting is declared once (§11), with its managed key, the Claude Code version
   that added that key, and which direction is stricter.
2. **Scopes:** Global, policies (a new pool type), workspace overrides; organizations, account pools
   and accounts (§12).
3. **Native delivery:** the compiler writes the policy drop-in through the foundation's engine (§10).
   Changes that only tighten skip rollout pacing (FR20).
4. **Checks in the workspace:** a sandbox probe, the version gate and a loading check decide what is
   written and what the workspace shows (FR21, FR22).
5. **Portal-enforced limits:** through Account Pool (move, or pause) and chat session flags.
6. **Signals:** [Monitoring](monitoring-dashboard.md)'s hooks and telemetry report modes, Bypass use,
   tampering and spend.

## 8. Functional requirements

### Settings model

- **FR1** One registry declares every setting once (§11): type, bounds, default, scopes, managed key,
  the Claude Code version that added the key, and its stricter direction (FR19). It drives API
  validation (422 with a field error), forms, the resolver and the compiler. The rule editor refuses
  lines matching credential prefixes (`sk-ant-`, `ghp_`, `github_pat_`, `AKIA`, `npm_`), because rules
  travel in plain files and the audit log keeps old and new values.
- **FR2** Policies are a foundation pool type (`policy`): revisions, preview files, pinning, rollout
  pacing, bulk assignment. At most one per workspace; none means Global. New ones start from a preset
  (§11.5) or a copy. Workspace overrides are sparse, audited and removable. Delete is refused while a
  policy is in use: the dialog offers "Move N workspaces to <policy or Global defaults>", lists the
  settings that get looser, and counts as relaxing (FR19).
- **FR3** Validation: bounds; rule syntax (`Tool`, `Tool(specifier)`, `mcp__<server>__<tool>`); path
  rules anchored with `//` or `~/` (a single leading `/` is anchored to the settings file's folder,
  so it's refused); cross-field checks (the start mode must be allowed; the persona's model and the
  account pool's model names should be allowed; Auto on a custom host needs FR6's confirmation).
  Errors block delivery, warnings don't.
- **FR4** Saving a Global or policy change that reaches running sessions first shows its reach:
  workspaces and sessions affected, what applies now or at the next session (§10.2), and whether it
  skips pacing (FR20). Changes that reach no running session save directly.
- **FR5** Settings ships **unapplied**. No workspace gets a policy file until the admin reviews Global
  and selects Apply, since the first delivery changes how Claude Code starts everywhere. Until then,
  pool requirements such as MCP set's clean environment show as unmet, and the Apply review lists
  them.

### Permissions, sandbox, models

- **FR6** The start mode is always written, since Claude Code's own default varies (§2). Bypass and
  Auto are each Allowed or Blocked; allowing Bypass where running workspaces are affected needs a
  confirmation naming the count. On custom-host pools Auto stays Blocked until an admin confirms the
  endpoint serves Claude Code's classifier: Auto sends conversation excerpts there ✅
  ([Chat sessions §6](chat-sessions.md)), and a failed classifier call blocked Bash ✅. "Modes offered
  in chat" narrows the chat picker; in terminals only Bypass and Auto can be locked, and the UI says so.
- **FR7** Rules: deny, ask and allow lists plus named groups (§11.1), each rule with its source. Rules
  other pools add for their own tools or paths (Skillset revocations, MCP set tool rules, Secrets &
  env path rules) show read-only. MCP tool rules are picked from delivered servers and written with
  plugin names (`mcp__plugin_cpm-<set>_<server>__<tool>` ✅). Each managed-only lock warns what stops
  working: users' rules, `--allowedTools` and chat "Always allow"; users' hooks; MCP servers outside
  the allowlist; network hosts users add.
- **FR8** Pools may declare policy requirements, such as Secrets & env's sandbox needs
  ([Secrets & env](secrets-env-pool.md) FR27) or MCP set's clean environment (warning level). A
  requirement never turns a control on or fails a delivery: an unmet one shows on both pools' rows,
  and the requesting pool degrades as it specifies (Secrets & env FR26). An allowlist the policy turns
  on admits what the portal delivers: the `serverUrl` or `serverCommand` matchers of every fragment
  with an MCP server ([MCP set](mcpset-pool.md) FR19, Browser & desktop) and the portal marketplace.
  Hosts Secrets & env declares (its FR28) are proposals the admin approves, since a host widens every
  sandboxed command's reach. Claude Code doesn't report a server an allowlist drops ✅, so the portal
  shows "Blocked by policy" itself.
- **FR9** When a policy change reaches a workspace, its portal chat sessions follow at once: a session
  in a mode that's no longer allowed is switched to the start mode with `set_permission_mode` and gets
  a transcript note; a newly disallowed model switches at the next turn
  ([Chat sessions](chat-sessions.md) §8, Controls).

### Limits

- **FR10** Headroom: Account Pool moves a workspace when its account's headroom for the main model
  group falls below the threshold ([Account Pool §12.2](account-pool.md)). After its reset time, an
  account takes workspaces again only when a probe shows headroom at least 10 points above the
  threshold. A workspace stays on an account at least 10 minutes between proactive moves, since each
  move discards the prompt cache. Unknown headroom (custom hosts, probes off) shows "Unknown: rotates
  on errors only".
- **FR11** Budgets follow §13: each mirrors an Anthropic limit or is a portal control, acts at its
  rotate point or at 100%, and moves through the states in §13.3. At an organization or account
  budget's rotate point, Account Pool moves those accounts' workspaces and gives them none until the
  state clears. When every account in a pool is past its rotate point, the pool's action applies:
  Alert keeps workspaces on their current account until Anthropic's limit (Account Pool FR18), and
  Pause stops them (§13.2).
- **FR12** Session budget and turn limits are pre-filled and capped in the new-session sheet and
  passed at every launch, resume and wake (§10.3). The portal keeps each chat session's own total from
  every result: the change since the previous one, or the whole value when the reported total went
  down, because `/clear` and a relaunch reset Claude Code's counters
  ([cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)). The total never resets,
  so `/clear` counts against the same budget, and the portal stops the session at its budget and at
  its per-session turn cap. On custom hosts the total is tokens × the endpoint's price; without a
  price, only turn limits apply (§13.1).
- **FR13** Concurrency caps refuse new chat sessions with the reason and source. Portal-run one-shot
  runs (persona test prompts) count toward both caps. Lowering a cap never stops a running session.
  Terminal sessions, `-p` runs started from a terminal included, are counted with
  `claude agents --json` (🔬 Q10), not capped.
- **FR14** Resource defaults and caps drive the create dialog and API. Two changes from today: the
  dialog offers values up to the highest (default 8 CPUs and 16 GB, a new memory ceiling), and "No
  limit" is offered per target (default: Docker yes, Kubernetes no); existing unlimited Kubernetes
  workspaces show "No limit (legacy)". Docker limits are read from `HostConfig.NanoCpus` and `Memory`,
  not creation labels, so "Apply to existing" (Docker in place, 🔬 Q12; Kubernetes restart after
  confirmation) shows the new values. The image variant applies at create; existing workspaces offer
  "Switch image" (§14).
- **FR15** One daily job at 03:00 UTC, shared with Monitoring, deletes rows past retention in batches
  of 1,000 and logs the counts.

### Audit and enforcement

- **FR16** Every settings change is logged: actor, scope, key, old and new value, revision, and
  whether it relaxed or tightened security. Settings writes no hooks: session modes, Bypass use, Auto
  denials and settings-file changes come from [Monitoring](monitoring-dashboard.md)'s hooks, and
  Settings shows them per workspace.
- **FR17** Enforcement state per workspace, from its image, delivery path and checks: **Enforced**
  (§6's conditions met, synced, loading confirmed); **Guidance** (standard image, or a policy file the
  user can change with `sudo`); **Guidance (writable)** (Kubernetes primary path without the sidecar);
  **Not applied** (FR5, or Kubernetes needing "Enable pools"). Any state can list controls **not met**,
  each with its reason: "Sandbox unavailable: <error>", "Left out: needs Claude Code 2.1.271",
  "Dropped by Claude Code: <key>", or an unmet pool requirement. The foundation's Pending, Drifted,
  Failed, Locked, Frozen, Unsupported and Needs restart show beside it.

### Change control

- **FR18** The API and UI give every effective value with its source (scope, name, revision) for a
  workspace, account, organization or chat session (§12), including keys other pools set (read-only)
  and keys left out for the workspace's Claude Code version.
- **FR19** **Relaxing changes.** The server marks a change relaxing when any affected workspace's
  effective value moves the looser way: a later mode in the order Plan, Manual or Don't ask, Accept
  edits, Auto, Bypass; a lock, group or the sandbox turned off; a deny or ask rule removed; an allow
  rule, allowlist entry or host added, or an allowlist removed; a higher budget, cap or turn limit;
  Pause changed to Alert; Resume; a lower monitoring mode; a shorter audit or event retention, or a
  longer transcript retention. Assignments, unassignments, policy deletion and switching to the
  standard image count by their effect. Relaxing changes are UI-only, so the
  [Portal MCP](portal-mcp.md) server returns `UI_ONLY` (its FR13), and the UI asks for a fresh
  re-auth ([Web app & PWA](web-app-pwa.md) §12.5).
- **FR20** **Tightening changes skip pacing.** A change that only tightens (blocks a mode; adds a deny
  or ask rule; turns on a lock, group, the sandbox or an allowlist; narrows an allowlist; lowers a cap
  or budget) skips the foundation's rollout pacing, like revocations. A workspace pinned to an older
  policy revision takes, per key, the stricter of its pinned value and the current one. Other changes
  follow pacing and pins.

### Checks in the workspace

- **FR21** **Sandbox probe.** Where the effective policy wants the sandbox or the env scrub, the portal
  runs `/etc/claudepilot/bin/policy-probe` through `exec` as the workspace user, at the first
  reconcile, after every start and after an image or Claude Code update. It runs `bwrap` with Claude
  Code's flags (🔬 Q6) in full, then weaker nested mode, checks `socat`, and stores `full`,
  `weaker_nested` or `unavailable` with the error. `sandbox.*` is written only where the probe passed
  (weaker nested mode only if an admin turned it on), and the scrub only after a full-mode pass.
  Elsewhere the workspace shows "Sandbox unavailable: <error>" and the control is not met. Once
  delivered, sandbox keys stay through a later failing probe, so `failIfUnavailable` fails closed, and
  the portal raises "Sandbox stopped working".
- **FR22** **Version gate and loading check.** The compiler leaves out keys the workspace's Claude Code
  version lacks ([foundation §9](foundation-pools.md)); a left-out security key is a not-met control
  with "Update Claude Code". Policy changes still reach Unsupported workspaces, like other existing
  deliveries. After a new revision reaches a running workspace, the portal confirms that Claude Code
  loaded it: Monitoring's `managed_settings_resolved` lists the file source (✅ E7), and `claude doctor`
  through `exec` lists dropped entries (🔬 Q23). A policy-file change the portal didn't make is a
  security event, and reconcile rewrites the file.
- **FR23** Removing a workspace deletes its `setting_overrides`, `workspace_policy` and
  `budget_status` rows in the same transaction, and the reconciler's cleanup of vanished workspaces
  covers them ([foundation §5](foundation-pools.md), on a "not found" answer only). A reused name
  never inherits an override or a pause. `setting_changes` stay for audit.

## 9. Data model

Stored in the portal database ([Pools foundation](foundation-pools.md) §4–5). No secret columns.

| Table | Key fields |
| --- | --- |
| `pools`, `pool_revisions` (foundation) | type `policy`; content is a sparse map of setting keys to values. The built-in row `global` holds Global: edited on Settings → Defaults, compiled into every workspace after Apply (amendment 1), never assigned or deleted. |
| `setting_overrides` | scope_type (`workspace`, `account_pool`, `account`, `organization`, `target`), scope_id, key, value (json), updated_at, actor |
| `setting_changes` | id, at, actor, scope_type, scope_id, key, old_value, new_value, revision, direction (`relaxing`, `tightening`, `neutral`) (kept 365 days) |
| `budget_status` | scope_type (`organization`, `account`, `account_pool`, `workspace`), scope_id, period_start (UTC month), limit_usd, spent_usd, coverage (`full` \| `partial`), sources (json: amount and as-of each), state (§13.3), resumed_at, resumed_spent_usd, updated_at |
| `workspace_policy` | workspace_id, effective_hash, image_variant, delivery_path (`docker`, `k8s_primary`, `k8s_sidecar`, `k8s_projected`), enforcement, not_met (json), sandbox_probe (`full`, `weaker_nested`, `unavailable`, `not_checked`), sandbox_error, sandbox_delivered, probed_at, loaded_revision, loaded_at, paused_reason, paused_until |

Effective values are resolved on demand and feed the desired hash (foundation §6.1). `budget_status`
is recomputed at most once a minute: the month's closed hourly `usage_rollups` (Account Pool), plus
Monitoring's `usage_minutes` for the open hour, plus chat results not yet rolled up, one source per
session ([Monitoring](monitoring-dashboard.md) FR11). Organization and account rows also read the
Admin usage report per key.

## 10. Delivery into Claude Code

### 10.1 What gets written

One file, `/etc/claude-code/managed-settings.d/10-claudepilot-policy.json` (`root:root 0644` on
Docker; on Kubernetes, as the foundation's `sync` writes it), plus `/etc/claudepilot/bin/policy-probe`
in the foundation bundle.

| Key | Setting | Written when |
| --- | --- | --- |
| `permissions.defaultMode` | Starts in | Always (FR6) |
| `permissions.disableBypassPermissionsMode`, `permissions.disableAutoMode` (`"disable"`) | Bypass, Auto | Blocked |
| `permissions.deny`, `ask`, `allow` | Rule groups, custom rules | Non-empty |
| `allowManagedPermissionRulesOnly`, `allowManagedHooksOnly`, `allowManagedMcpServersOnly` | Managed-only locks | On |
| `sandbox.enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`, `enableWeakerNestedSandbox`, `network.allowedDomains`, `network.tlsTerminate`, the hosts lock `allowManagedDomainsOnly` (🔬 Q7: exact path) | Sandbox rows | Only where the probe passed (FR21) |
| `allowedMcpServers`, `deniedMcpServers` | MCP servers | Restricted; non-empty |
| `strictKnownMarketplaces` | Plugin marketplaces | Portal only (never `[]`, which blocks every source) |
| `disableSkillShellExecution` | Skills may run shell commands | No |
| `availableModels`, `maxEffortLevel` | Allowed models, highest effort | Restricted |
| `disableWorkflows` | Workflows and ultracode | Blocked (🔬 Q20) |
| `modelPricing` | Price multiplier | Not 1.0, Anthropic endpoint only (2.1.242+; multiplier markup 2.1.271+) |
| `cleanupPeriodDays` | Transcripts kept | Not the default 30 |
| `env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, `env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | Subagent caps | Always: an `env` value is overwritten, never removed, because a removed variable only takes effect at the next launch |
| `env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, `env.BASH_MAX_OUTPUT_LENGTH`, `env.MAX_MCP_OUTPUT_TOKENS` | Sub-agent cache, output caps (§22.5, built) | Always, as the subagent caps |
| `env.CLAUDE_CODE_MCP_ALLOWLIST_ENV` | Clean environment for stdio MCP servers | Always: `1`, or `0` when turned off |
| `env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | Require the env scrub | `1` where required and the probe passed in full mode; never written elsewhere, not even empty |

Other keys at their permissive default are left out. The Standard preset as delivered:

```json
{
  "permissions": {
    "defaultMode": "default",
    "disableBypassPermissionsMode": "disable",
    "deny": ["Edit(//etc/claude-code/**)", "Edit(//etc/claudepilot/**)", "Edit(~/.claudepilot/**)",
             "Read(//etc/claudepilot/account/**)",
             "Read(~/.ssh/**)", "Edit(~/.ssh/**)", "Read(~/.aws/**)", "Edit(~/.aws/**)",
             "Read(~/.kube/**)", "Edit(~/.kube/**)", "Read(~/.config/gh/**)", "Edit(~/.config/gh/**)",
             "Read(~/.config/gcloud/**)", "Edit(~/.config/gcloud/**)",
             "Read(~/.docker/config.json)", "Edit(~/.docker/config.json)", "Read(~/.npmrc)", "Edit(~/.npmrc)",
             "Read(~/.git-credentials)", "Edit(~/.git-credentials)", "Read(~/.netrc)", "Edit(~/.netrc)"],
    "ask": ["Bash(sudo *)"]
  },
  "env": { "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "20", "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "3",
           "CLAUDE_CODE_MCP_ALLOWLIST_ENV": "1" }
}
```

- Managed drop-ins outrank user, project and local settings and `--settings`. Lists such as
  `permissions.deny` combine across files, and nested blocks such as `sandbox` merge key by key
  ([managed settings](https://code.claude.com/docs/en/managed-settings)). Project settings can't
  start sessions in `auto` or `bypassPermissions`; the managed file can.
- MCP matchers use `serverUrl` or `serverCommand`, never `serverName`, which isn't a security control
  ([managed MCP](https://code.claude.com/docs/en/managed-mcp)); a `serverName` deny didn't block a
  plugin server ✅. Nobody writes `managed-mcp.json`: it would block every plugin server.
- `CLAUDE_CODE_MAX_RETRIES` belongs to [Account Pool](account-pool.md) (Fail over faster, §11.3), and
  Settings shows it read-only. Secrets & env writes its own path deny rules, so Protect portal files
  leaves `/etc/claudepilot/secrets/**` to it.
- The compiler rejects credentials, `ANTHROPIC_*`, `apiKeyHelper`, `hooks`, and `forceLoginMethod` /
  `forceLoginOrgUUID` (they block helper credentials at startup). Targets and write order follow
  foundation §6.2 and §6.4; the hardened image adds §14.

### 10.2 When a change applies

Changes that only tighten skip rollout pacing (FR20); others reach workspaces at the foundation's pace
(20 a minute). While the portal is Locked or Frozen, no policy change reaches any workspace
([foundation §6.5](foundation-pools.md)), and Settings shows the foundation banner.

| Change | Running sessions | New sessions |
| --- | --- | --- |
| Rules | Next tool call: Claude Code reloads managed settings, permission edits included ([settings](https://code.claude.com/docs/en/settings#when-edits-take-effect)); 🔬 Q2 on the pinned version | Yes |
| Bypass or Auto blocked | Entering it is refused; a terminal session already in it may stay until restart (🔬 Q1). Chat sessions switch when the change reaches the workspace (FR9). | Yes |
| Managed-only locks, sandbox, MCP, skill and workflow restrictions, allowed models, highest effort, price multiplier | 🔬 Q2. The model is read at session start, so a session keeps a now-disallowed model until `/model` or a restart. | Yes |
| `env` values (subagent caps, scrub, clean MCP environment) | Value reapplied live ✅; whether each feature re-reads it is 🔬 Q2. Stdio MCP servers get the clean environment when they next start. | Yes |
| Start mode, session budget, turn limits | No: read at launch. Chat sessions get them at their next launch, resume or wake. | Yes |
| Concurrency caps | New sessions only; running ones are never stopped | Yes |
| Transcripts kept | At Claude Code's next cleanup (🔬 Q2) | Yes |
| Thresholds, budgets; pause and resume | Next reconcile (within 60 s). Account Pool rewrites its drop-in, which clears the helper cache ✅, so the next API request uses the new key or fails as paused. | — |
| Resources; image variant | Docker in place (🔬 Q12) or recreate on the same home volume; Kubernetes restart | New workspaces |

The UI states which kind each change is (FR4) and lists sessions that keep old values ("3 sessions
started before this change can stay in Bypass until they restart").

### 10.3 Portal-run sessions

[Chat sessions](chat-sessions.md) run the CLI in print mode with stream-json and recompute their flags
at every launch, resume and wake (Chat sessions §10.2):

| Effective setting | At launch | During the session |
| --- | --- | --- |
| Start mode | `--permission-mode <mode>`, always explicit. Never Bypass: where the policy starts in Bypass, chat starts in Manual and offers Bypass through Chat sessions' three-step confirmation. | `set_permission_mode`, after the server checks the allowed set |
| Bypass allowed | `--allow-dangerously-skip-permissions`, only then; without it the switch fails with `bypass_not_launched` ✅ | A session launched earlier offers "Restart to allow Bypass" |
| Session budget | `--max-budget-usd <remaining>`, because Claude Code doesn't count totals restored by `--resume` ✅ | The portal stops the session at its own total (FR12) |
| Turn limits | `--max-turns <per-prompt cap>`: it limits each prompt, not the session | The portal counts turns per session and stops at the cap |
| Model, effort, ultracode | `--model`, `--effort`, only when the user picked them | `set_model`, `apply_flag_settings {effortLevel, ultracode}`, each checked against policy. Clamps are silent, so chat shows `get_settings.applied` ✅. |
| Scheduled tools | `--disallowedTools CronCreate,CronDelete,ScheduleWakeup` unless allowed | — |
| Prompts nobody can answer | `--permission-prompt-tool stdio`; persona test prompts deny every request | Chat approval dock |

Costs are client-side estimates at list price (contracted rates with `modelPricing`), and spend can
pass `--max-budget-usd` ([CLI reference](https://code.claude.com/docs/en/cli-reference)), so the UI
labels them "est." and promises a stop, not an exact amount.

## 11. Settings catalog

Scopes: **G** Global, **T** target, **P** policy, **O** organization, **AP** account pool, **A**
account, **W** workspace, **S** chat session (within caps).

### 11.1 Permissions

| Setting | Default | Scopes | Written as / enforced by |
| --- | --- | --- | --- |
| Starts in | Manual | G P W S | `permissions.defaultMode`: `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` |
| Bypass permissions | Blocked | G P W | Blocked: `disableBypassPermissionsMode: "disable"`. Chat gets `--allow-dangerously-skip-permissions` only when Allowed. |
| Auto mode | Allowed | G P W | Blocked: `disableAutoMode: "disable"`. Custom-host pools: Blocked until the next row is confirmed. |
| Auto on this custom host | Not confirmed (hidden) | AP | The admin confirms the endpoint serves Claude Code's classifier (FR6) |
| Modes offered in chat | All allowed | G P W | Chat mode picker only |
| Protect portal files | On | G P W | Deny `Edit(//etc/claude-code/**)`, `Edit(//etc/claudepilot/**)`, `Edit(~/.claudepilot/**)` (outbox and chat files; hooks still append, since rules govern Claude's tools), `Read(//etc/claudepilot/account/**)` (🔬 Q4) |
| Protect home credential files | On | G P W | Read and Edit deny for `~/.ssh/**`, `~/.aws/**`, `~/.kube/**`, `~/.config/gh/**`, `~/.config/gcloud/**`, `~/.docker/config.json`, `~/.npmrc`, `~/.git-credentials`, `~/.netrc` |
| Protect user settings | Off | G P W | Edit deny for `~/.claude/settings.json` and `~/.claude/settings.local.json`, so the agent can't widen lists there |
| Ask before sudo | On | G P W | `ask`: `Bash(sudo *)`. Still prompts in Bypass (documented for the SDK flow, 🔬 Q3 for terminals). |
| Custom deny, ask, allow rules | None | G P W; S (allow) | `permissions.deny`, `ask`, `allow` |
| Managed-only locks (Advanced): rules, hooks, MCP servers | Off | G P W | `allowManagedPermissionRulesOnly`, `allowManagedHooksOnly`, `allowManagedMcpServersOnly` |

### 11.2 Sandbox, MCP, skills, models

| Setting | Default | Scopes | Written as |
| --- | --- | --- | --- |
| Sandbox shell commands | Off | G P W | `sandbox.enabled`, only where the probe passed (FR21). Sandboxed commands then run without prompts (`autoAllowBashIfSandboxed` defaults to true). |
| Fail if it can't start / unsandboxed retry | On / Off | G P W | `sandbox.failIfUnavailable`, `sandbox.allowUnsandboxedCommands` |
| Allowed network hosts | None (no extra hosts) | G P W | `sandbox.network.allowedDomains`, plus approved Secrets & env proposals (FR8). What sandboxed commands do with an unlisted host is 🔬 Q7. |
| Only managed hosts (Advanced) | Off | G P W | The sandbox's `allowManagedDomainsOnly`: hosts lower scopes add don't count, and unlisted hosts are refused in every mode |
| TLS inspection (Advanced) | Off | G P W | `sandbox.network.tlsTerminate` (experimental). Needed for Secrets & env's Masked entries; tools must trust its CA (Secrets & env Q1). |
| Weaker nested sandbox (Advanced) | Off | G | `sandbox.enableWeakerNestedSandbox`. The probe suggests it where only weaker mode works; the docs say it considerably weakens security. |
| Require the env scrub | Off | G P W | `env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, only where the probe passed in full mode: without bubblewrap every `claude` exited, and under default seccomp every Bash command failed ✅. It may strip Secrets & env's pointer variables (its Q2). |
| MCP servers | Any | G P W | Pool-delivered only: `allowedMcpServers` with the matchers pools report (FR8; ✅ for a stdio and for a remote plugin server). **Built as the global switch "Pool MCP only", with "Account MCP off" beside it (§22); per-workspace and per-policy scopes are not built.** Denied servers: `deniedMcpServers`, beside the foundation's portal entry. |
| Clean environment for stdio MCP servers | On | G P W | `env.CLAUDE_CODE_MCP_ALLOWLIST_ENV`: stdio servers get only `PATH`, `HOME`, `TERM`, a few Claude Code variables and their own `env` ✅ ([MCP set](mcpset-pool.md) §10). Off: MCP sets show "stdio servers inherit the full environment". |
| Plugin marketplaces | Any | G P W | Portal only: `strictKnownMarketplaces` with the portal marketplace (FR8) |
| Skills may run shell commands | Yes | G P W | No: `disableSkillShellExecution`, which covers plugin skills. The row shows how many delivered skills it affects ([Skillset](skillset-pool.md) FR18). Block one skill with a `Skill(...)` deny rule. |
| Allowed models | All | G P W | `availableModels`, which Claude Code takes from managed settings as-is |
| Highest effort | No cap | G P W | `maxEffortLevel`. The lowest cap from any scope wins, and the clamp is silent, so chat shows the applied level. |
| Workflows and ultracode | Allowed | G P W | Blocked: `disableWorkflows: true`, documented to make ultracode unavailable (🔬 Q20), in terminals and chat alike. Ultracode is exempt from the subagent cap, and an effort cap doesn't turn it off. |
| Price multiplier (Advanced) | 1.0 (list price) | G AP | `modelPricing` multiplier, also used by the portal's estimator. Hidden for custom-host pools, which use the endpoint's price (§13.1). |

### 11.3 Limits and resources

| Setting | Default | Scopes | Enforced by |
| --- | --- | --- | --- |
| Rotate below headroom | 15% (5–50) | G AP | Account Pool §12.2 (FR10) |
| Organization budget per month / rotate at | None / 90% | G O | Account Pool (FR11, §13) |
| Account budget per month / rotate at | None / 90% | G AP A | Account Pool. Warns unless each account is its own organization or Anthropic workspace. |
| Pool budget per month | None | AP | Portal (FR11) |
| Workspace budget per month | None | G P W | Portal, pool-billed spend |
| Warn at / when a budget runs out | 80% / Alert | G O AP P W | Alert, or Pause (§13.2) |
| Fail over faster | Off | G AP | Account Pool always writes `env.CLAUDE_CODE_MAX_RETRIES` in its drop-in: `4` while the pool has another healthy account in a different organization, else `10`. A rate-limited turn then gives up after 5 attempts (about 10 s, by the gaps observed with `retry-after: 2`) instead of 11 (about 3 minutes ✅), and the next request uses the new account. It also cuts the 401 window to 7 attempts ([Account Pool](account-pool.md) Q15) and how long a chat turn retries a 429. |
| Session budget | $10, highest $50 | G P W S | `--max-budget-usd` and the portal's total (FR12) |
| Turns per prompt / per session | None / none | G P W S | `--max-turns` / the portal |
| Chat sessions per workspace / in total | 4 / 20 | G P W / G | Portal (FR13) |
| Scheduled tools in chat | Off | G P W | `--disallowedTools` ([Chat sessions](chat-sessions.md) §10.2) |
| Idle chat sessions sleep after | 30 min | G | Chat sessions' idle sleep |
| Lead rules (`sessions.leadRules`) | Off | G | A crew lead's file edits refused outside its status, notes and scratch folders, in Bypass too, by a PreToolUse hook in the one merged `--settings` value (a session that ever had a worker counts as a lead) ([Chat sessions](chat-sessions.md) FR79, T-561, D-63). Protective: turning it off asks first. |
| Subagents per session, depth (Advanced) | 20, 3 | G P W | `env`: `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` |
| Default / highest CPU, memory | 2 / 8 CPUs, 4 / 16 GB | G T | Create dialog and API. A change (FR14): today the dialog stops at 4 CPUs and 8 GB, and the server allows 64 CPUs with no memory ceiling. |
| Offer "No limit"; home volume size | Docker yes, Kubernetes no; 10 Gi | T | Create dialog and API (today every target offers it); PVC size (`PORTAL_K8S_STORAGE` today) |
| Workspace image; requires hardened | Standard; No | G P; W at create | Image tag (§14) |

### 11.4 Retention and monitoring

Global unless noted. Event log, foundation and Account Pool events included: 90 days (7–730). Quota
snapshots: 7 days (1–30). Usage rollups: 13 months (1–36). Setting changes: 365 days (90–1,095).
Backups kept: 3 (1–20). Chat session data: 90 days (Chat sessions §8, Limits). Persona session
reports: 30 days; persona test runs: 14 days. Devices: 90 days after last seen; notification
history: 30 days (Web app & PWA). Monitoring's tables keep the defaults in
[Monitoring §13](monitoring-dashboard.md) and are edited here too.

| Setting | Default | Scopes | Written as |
| --- | --- | --- | --- |
| Transcripts kept | 30 days (Claude Code's default); 7 recommended where secrets are delivered | G P W | `cleanupPeriodDays`. Chat sessions older than this become read-only. |
| Monitoring | Auto: Full with an account pool, Activity for own login | G P W | Monitoring compiles its drop-in from the effective value ([Monitoring](monitoring-dashboard.md) FR5) |
| Detailed security events | Off | G W | Monitoring FR23 |

### 11.5 Presets

Presets fill these fields at the scope being edited; changing one afterwards shows "Custom".

| | Strict | Standard (Global default) | Autonomous |
| --- | --- | --- | --- |
| Starts in | Manual | Manual | Bypass permissions |
| Bypass / Auto | Blocked / Blocked | Blocked / Allowed | Allowed / Allowed |
| Protect portal files, home credential files; Ask before sudo | On | On | On |
| Protect user settings; managed-only locks; only managed hosts | On | Off | Off |
| MCP servers, plugin marketplaces | Pool-delivered only, portal only | Any | Any |
| Sandbox (S6); requires hardened image | On where the probe passes; Yes | Off; No | Off; No |

Autonomous: terminals show Claude Code's one-time Bypass acceptance, and background (`--bg`) sessions
are refused until it's accepted. Claude Code refuses Bypass as root, and every session runs as the
workspace user. Chat sessions still confirm Bypass per session.

## 12. Scopes and inheritance

```
Workspace settings:  Built-in → Global → Policy → Workspace → Session (chat, within caps)
Account settings:    Built-in → Global → Account pool → Account
Organization budget: Built-in → Global → Organization
Resources:           Built-in → Global → Target → Workspace (chosen at create)
```

Permissions and session limits describe how a workspace is used, so they live in policies. Rotation
thresholds and budgets describe credentials and billing, so they live with organizations, account
pools and accounts.

1. **Scalars:** the most specific scope that sets a key wins. Allowlists (models, MCP servers,
   marketplaces, network hosts) count as scalars: a policy's list replaces Global's.
2. **Rule lists and denied servers** combine down the chain, the way Claude Code combines lists and
   treats deny.
3. **Named groups** (Protect portal files, Ask before sudo, …) are on/off scalars.
4. **Session choices are clamped** to the allowed modes and models, the highest effort, budget and
   turns. A session may add allow rules for itself, except with the rules lock on.
5. **Scalars may loosen or tighten; inherited rules can't be removed** (one admin role in v1; with several users the roles are `admin` and `member`, see the note below). Looser
   values say "Looser than Global" and are UI-only (FR19).
6. **Pinned workspaces** take, per key, the stricter of their pinned and current revision (FR20).

> **Multi-user (PLAN-10, 2026-10-12).** With accounts ([Multi-user](multi-user.md)), a **Global** setting is a platform setting: every signed-in person reads the effective values (a person should see why something is refused), only a platform admin changes one (`platform(settings)`, [Authorization](authorization.md)), the setting audit's actor is the person (`user:<id>`, not the literal `Admin`), and relaxing a protective setting still needs the confirmation and, now, a recent password check. A **Policy**, **Workspace** or **Session** value is set by someone who holds `manage` on that workspace (a session's own choices by its owner) and may only tighten what the platform set: an admin's Global value is a floor for `member`s ("Looser than Global" is refused for them, not only flagged). The default persona and the delegation policy are platform choices. Per-person settings (notification preferences, glance layout) are the person's own and are not in this store.

Each row carries a source Badge: `Default`, `Global`, `Policy · Autonomous r4`, `Account pool ·
team-a`, `Organization · acme`, `Account · key-3`, `Target · Kubernetes`, `Workspace` or `Session`,
like the Access page's code-source badge. Keys other pools set show `MCP set`, `Secrets & env` or
`Foundation`, read-only. Values set at the scope being edited say "Set here".

## 13. Budgets and spend

Two kinds of API quota run out: **rate limits**, a token bucket per model group that refills
continuously, and **monthly spend limits** ([rate limits](https://platform.claude.com/docs/en/api/rate-limits)).
The headroom threshold handles the first. A budget handles the second only if it has the same scope
as the limit it mirrors. Anthropic applies spend limits per organization or Anthropic workspace,
never per key:

| Anthropic limit | Applies to | Mirror it with | Billed figure |
| --- | --- | --- | --- |
| Tier spend cap (Start $500, Build $1,000, Scale $200,000 a month): 429 `enforced_spend_limit_reached` | Organization | Organization budget, over the accounts Account Pool groups by `organization_id` (its FR5) | Cost report, daily |
| A spend limit set on the organization: 400 "You have reached your specified API usage limits" | Organization | Organization budget | Cost report, daily |
| A spend limit set on an Anthropic workspace: the same 400, naming workspace limits | Anthropic workspace | Pool budget, when the pool's keys share that Anthropic workspace (Account Pool §14 recommends one per pool; its FR5 discovers it) | Cost report grouped by `workspace_id`, daily |
| None per key | — | Account budget, only when each account is its own organization or Anthropic workspace | — |

Set each mirror a little under its Anthropic limit, and workspaces move before Anthropic stops them.
Workspace budgets mirror nothing at Anthropic; they're a portal control.

### 13.1 Where spend comes from

| Source | Covers | Freshness | Accuracy |
| --- | --- | --- | --- |
| Admin usage report per key (Account Pool FR6) | Every request by an account's key | About 5 min behind, polled once a minute ([Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)) | Exact tokens; USD = tokens × price, since the cost report can't group by key |
| Workspace telemetry ([Monitoring](monitoring-dashboard.md) Full mode) | Terminal and chat sessions | Under 2 minutes: closed hours from `usage_rollups`, the open hour from `usage_minutes` | Client-side estimate, within Monitoring's sanity caps (its §6) |
| Portal chat session results | Portal-run sessions | Seconds | Client-side estimate |
| Cost report per organization or Anthropic workspace | Organization and pool budgets | Daily | Billed USD |

- Organization and account budgets use the Admin report when an organization monitor exists, else
  their workspaces' tracked spend, labeled "Partial (est.)". Outside Monitoring's Full mode, workspace
  meters say "Partial: terminal sessions not counted" (Q18). Every figure shows its source and age
  ("Admin API · 4 min ago").
- **Custom hosts:** spend is tokens × the endpoint's price ([Account Pool](account-pool.md) FR1),
  never Claude Code's cost fields, which price unknown model names with `costBasis` "unknown" ✅ (X3).
  Without a price, budget rows show "Unavailable: no price for <model>" and never rotate or pause, and
  chat sessions get turn limits only (🔬 Q24 could make Claude Code's own estimates usable).
- Periods are calendar months in UTC, like Anthropic's tier spend caps. Spend arrives late, so the
  rotate point should leave room for about 5 minutes of peak spend; the editor shows that amount.

### 13.2 Pause and resume

1. The portal ends the workspace's chat sessions with a note and refuses new ones ("Paused: workspace
   budget reached · resumes 1 Nov 00:00 UTC"), so no session can fall back to a stored login
   ([Chat sessions §6](chat-sessions.md)).
2. Account Pool empties the workspace's key file and rewrites its drop-in with
   `CLAUDEPILOT_ACCOUNT=paused:<id>` ([Account Pool](account-pool.md) FR19). The write clears the
   helper cache ✅, so the next API request runs `account-key`, which finds the file empty, exits 1 and
   prints "pilot: paused (workspace budget) · resumes 1 Nov 00:00 UTC" on stderr. Claude Code
   shows that on each attempt and fails the turn in about 2 s ✅ (X6). The portal ignores hook and
   telemetry lines marked `paused:`, so a paused workspace never probes or flags its shared account.
3. The base URL keeps its helper, so [Account Pool §10.4](account-pool.md) holds (🔬 Q5: no fallback
   to a saved login). If Q5 finds a fallback, the helper prints a non-secret sentinel
   (`claudepilot-paused`) instead, which every host rejects.
4. An empty helper still sent the request, with a bare `Authorization: Bearer` header ✅ (X6; a helper
   that exits 1 is Q5), so a custom host that accepts keyless requests could keep serving. Pause is
   offered only where the endpoint's keyless check returned 401 or 403. Elsewhere the row says "Pause
   unavailable on <host>" and the action is Alert.
5. Resume comes at the next period, when an admin raises the budget, or with "Resume" (audited,
   UI-only). Account Pool restores the key the same way.

### 13.3 Budget states

| State | Entered when | What happens | Leaves when |
| --- | --- | --- | --- |
| OK | Spend under the warning share | Nothing | — |
| Warning | At the warning share (80%) | Event and attention item | Next period; budget raised |
| Rotated | An organization or account budget at its rotate point | Account Pool moves workspaces off and gives the accounts none | Next period; budget raised; "Use again" |
| Reached | 100%, action Alert | Alert; workspaces keep working. With every pool account rotated, they wait on their current account until Anthropic's limit (Account Pool FR18). | Next period; budget raised |
| Paused | 100%, action Pause | §13.2 | Next period; budget raised; Resume |
| Resumed | Resume or "Use again" while over budget | Runs for the rest of the period. Warns again at +10% of the budget, and acts again if the budget changes. | Next period |
| Stale | Every source for the scope is older than 15 minutes (an expired Admin key, Monitoring's receiver down) | No automatic rotate, pause or resume; an alert | A fresh figure |
| Unavailable | Custom host without a price | Nothing automatic | A price is set |

## 14. Hardened workspace image

- **What changes:** an image tag `:hardened`, built from the same Dockerfile without the `sudoers`
  entry. Docker runs it with `no-new-privileges` and all capabilities dropped. Kubernetes pods get
  `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `runAsNonRoot`, the `RuntimeDefault`
  seccomp profile and the sync sidecar (amendment 6).
- **Delivery:** on Docker the archive API writes through the daemon, outside the container's
  capabilities, and `exec -u root` renames the files into place (🔬 Q11: with no capabilities). On
  Kubernetes the `claudepilot-sync` sidecar owns the delivery `emptyDir`s and receives delivery
  `exec`s, and the workspace container mounts them read-only. Outbox pulls, snapshots, the probe and
  run-in-workspace steps still `exec` into the workspace container.
- **Guarantee:** Claude Code there follows the policy, and the user can't change it short of a
  container escape (🔬 Q11) or a nested `claude --bare` that skips managed settings (🔬 Q22).
  Delivered secrets stay readable: the helper and tools run as the user.
- **Costs:** no `apt install`, so tools must be in the image. The sandbox needs user namespaces, which
  the hardened profile may block (🔬 Q6).
- **Switching:** Docker recreates the container on the same home volume; Kubernetes updates the
  Deployment (one restart). Delivery runs before the workspace starts. The confirmation shows running
  `claude` processes and says "Packages installed outside /home/node are lost."

## 15. User experience

All screens use existing components (Section, Card, Badge, Segmented, Select, ChipGroup, SwitchRow,
TextField, TextArea, Menu, Dialog, ConfirmDialog, PageTabs, StatGrid) and the app's Meter, on phones
and desktops.

**Settings page** (`/admin/settings?tab=`, policies at `…/policies/:id`). On phones it sits under Menu
with Access, so the tab bar gains no column ([Web app & PWA](web-app-pwa.md) §8). PageTabs:

- **Defaults** (Global): a filter field, a "Show advanced" SwitchRow, then Sections: Permissions
  (preset Segmented, Starts in, Bypass, Auto, Modes in chat, the rule groups, "Custom rules: 3 deny ·
  1 ask"), Sandbox, MCP and skills, Models and effort, Limits, Resources and image, Retention and
  monitoring. Each row has a label with a one-line hint, the control and the source Badge. Resources
  show one row per target, Global first. The Sandbox Section says where it can run ("Available in 3
  of 12 workspaces · Docker: blocked by seccomp").
- **Policies:** here rather than under Pools, because they're edited alongside Defaults. The
  foundation's pool page pattern: cards say what a policy changes ("Starts in Bypass · Sandbox on ·
  $25 sessions"), with revision, "Used by N workspaces", Edit, Duplicate and Delete. The editor is a
  page with the Defaults layout, since it has the same 50 or so fields. Unset fields show the inherited
  value muted with its source; changing one creates an override, and its Menu offers "Reset to
  inherited". Presets appear as "Start from".
- **Data:** retention fields, a StatGrid (database size, rows per table, last prune), "Prune now".

**Rule editor** (Dialog): Segmented Deny / Ask / Allow, one rule per line, errors per line, inherited
and pool-added rules read-only with their source, examples (`Bash(git push *)`, `Read(./.env)`,
`WebFetch(domain:example.com)`, `mcp__plugin_cpm-team_github__create_issue`), and the note "Bash rules
match command text; use the sandbox to enforce". **Bypass confirmation** (ConfirmDialog, confirm not
focused): "Allow Bypass permissions in 12 workspaces? Claude runs tools without asking. Deny rules
still apply. These workspaces have internet access and delivered credentials."

**Elsewhere:**

- **Account Pool:** the pool editor gets a Limits section with the same rows, and the Organizations
  section gets organization budgets. Each account and organization row gets a spend meter with a tick
  at the rotate point (amendment 8).
- **Workspaces:** the create dialog gets a "Policy" select next to "Account pool" ("Global defaults"
  first); CPU and memory start at the effective defaults, with no options above the highest. The
  Configuration panel gets a Policy row: policy and revision, enforcement badge, not-met controls,
  "2 overrides", the month's spend meter, and "Effective settings" (a Dialog, a sheet on phones) with
  every value, its source and an Override action. Under a policy that requires the hardened image,
  standard workspaces show "Guidance: standard image" with "Switch image".
- **[Chat](chat-sessions.md):** Bypass shows disabled with "Blocked by policy Standard". At a cap,
  "New session" is disabled with "4 of 4 sessions running · Global". A paused workspace says why and
  until when.

**Phones:** label and badge sit above the control, Sections stay stacked with the filter field as
navigation, targets are at least 44 px, and Defaults loads in one request (registry and values).

## 16. Security requirements

- Only signed-in admins read or change settings, and every change is audited (FR16).
- Every policy file is validated before delivery: a JSON object with only the keys this PRD owns,
  valid rules, and only keys the workspace's Claude Code version supports (FR22). A malformed
  managed-settings file stops every Claude Code session in the workspace.
- The policy never writes what breaks sessions where a check failed: no sandbox keys where the probe
  never passed, and no scrub without a full-mode pass (FR21).
- Rules never carry credentials (FR1). Bash rules are guidance, not a boundary
  ([permissions](https://code.claude.com/docs/en/permissions)); the UI points to the sandbox. Bypass
  needs confirmation, and every preset protects portal files and home credential files.
- Relaxing changes are UI-only (FR19); changes that only tighten skip pacing (FR20).
- The probe and checks are fixed scripts run as the workspace user. Their output is capped, treated
  as untrusted, and never holds values.
- Pausing never edits files Claude Code owns (`~/.claude.json`, `~/.claude/settings.json`) or a user's
  own login.

## 17. Observability and audit

- Audit log: settings changes with their direction, policy assignments, Bypass allowed or blocked per
  scope, pauses and resumes, with actor and time. Budget events (warn, rotate, reached, paused,
  resumed, stale) carry the figure, its source and age.
- Enforcement events: probe results, "Sandbox stopped working", keys left out or dropped, and policy
  files changed outside the portal.
- Policy signals come from the [Monitoring dashboard](monitoring-dashboard.md): sessions per mode,
  Bypass use, Auto denials, settings-file changes and tampering. With Monitoring off for a workspace,
  its Bypass use isn't reported.
- Settings gives Monitoring: workspaces by enforcement state and not-met controls, the delivered
  policy revision (its policy posture), budgets by state, cap refusals per hour, sessions stopped by
  budget or turns.

## 18. Rollout and milestones

| Milestone | Scope | Gate |
| --- | --- | --- |
| S1 | Registry (with versions and directions), resolver, Global store, Settings page with Defaults (Resources first) and Data, create dialog on effective defaults, Docker limits from `HostConfig`, retention job | Foundation F1 |
| S2 | Policy compile and Docker delivery, presets without the sandbox, rule editor, first-run Apply, effective values, relaxing flag, Monitoring's rows, Configuration row, enforcement states, loading check, audit log | Foundation F2; Q1–Q4 and Q23 on the pinned version |
| S3 | Policies as a pool type, overrides, bulk assignment, tightening without pacing, Kubernetes delivery with the sidecar, MCP and skill restrictions with the matchers pools report | Foundation F3, F5, F6; amendments 6 and 9; Q21 before "Pool-delivered only" |
| S4 | Chat limits: allowed modes, session budget and turns, caps, scheduled tools, workflows switch, FR9 | Chat sessions C2; Q8, Q10, Q20 |
| S5 | Headroom threshold from Settings; organization, account, pool and workspace budgets and their states; pause and resume; Fail over faster | Delivered with Account Pool M6, after M5's live-key check; Q5, Q24 |
| S6 | Sandbox probe and sandbox rows, pool sandbox requirements (Secrets & env masking), the env scrub, hardened image (Docker, then Kubernetes) | Q6, Q7, Q11, Q22 |

## 19. Success metrics

| Metric | Target |
| --- | --- |
| A change that only tightens reaches every running workspace | Within 2 minutes |
| Other Global or policy changes reach running workspaces | Within the rollout pacing window |
| Policy file differs from desired for over 5 minutes (running workspaces) | Zero |
| Workspaces where the policy stops Claude Code from starting or breaks Bash | Zero |
| New entries into a blocked mode, hardened image | Zero; sessions already in one are listed until they restart |
| Sessions entering a blocked mode, standard image with Monitoring on | Reported within 1 minute |
| Accounts moved before Anthropic's spend limit, with a mirroring budget under it | At least 95% |
| Chat sessions passing their budget by more than the requests in flight at the stop | Under 1% |
| Estimated against billed spend, where a cost report exists | Within 5% |
| Pauses or rotations later found wrong | Zero |
| Change start mode, Bypass or a budget from the Settings page | Three taps or fewer, not counting a confirmation; Settings loads in under 1 s at p95 on a phone |
| Invalid policy files delivered | Zero |

## 20. Amendments to Pools foundation

| # | Section | Proposed change |
| --- | --- | --- |
| 1 | §3, §5, §6.1, §6.5 | Add the pool type `policy`: one per workspace, none meaning Global. Global is a built-in `policy` row, never assigned or deleted. After the first Apply (FR5) the compiler builds it into every workspace's policy fragment as a system fragment (as [Monitoring](monitoring-dashboard.md) A2 proposes) and records it in the manifest as `global@<revision>`; the "Assignments missing" check treats it as assigned. An assigned policy and workspace overrides layer on top in the same fragment. Unassigning a policy writes a removal record and falls back to Global. |
| 2 | §7 ownership row | Settings & policies: files `managed-settings.d/10-claudepilot-policy.json` and `/etc/claudepilot/bin/policy-*`. Keys `permissions.defaultMode`, `disableBypassPermissionsMode`, `disableAutoMode` and `allow`; `deny` and `ask` entries; `allowManagedPermissionRulesOnly`, `allowManagedHooksOnly`, `allowManagedMcpServersOnly`; `sandbox.*` except `sandbox.credentials`; `allowedMcpServers` and `deniedMcpServers` entries; `strictKnownMarketplaces`, `disableSkillShellExecution`, `availableModels`, `maxEffortLevel`, `disableWorkflows`, `modelPricing`, `cleanupPeriodDays`; four `env` names (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, `CLAUDE_CODE_MCP_ALLOWLIST_ENV`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`), plus the TLS variables in Secrets & env FR4, reserved for TLS inspection. `allowedMcpServers` and `allowManagedMcpServersOnly` leave the MCP set row ([MCP set](mcpset-pool.md) A2). **Built differently (§22): they are written by a separate delivery owner, `settings` (drop-in `05-claudepilot-settings.json`), together with `disableClaudeAiConnectors`, so the global MCP switches work before the policy pool type exists; the `policy` owner keeps `deniedMcpServers`.** No hooks (built since: one, the rule-file guard of D-60, §22.6); budgets, caps and thresholds are portal-side. `CLAUDE_CODE_MAX_RETRIES` joins the Account Pool row. |
| 3 | §7 merge rules | `permissions.deny` and `ask` are list keys: other owners add entries for their own tools or delivered paths (Skillset revocations, MCP set tool rules, Secrets & env path rules). `deniedMcpServers` is a list key (Settings, and the foundation per [Portal MCP](portal-mcp.md) A1). Settings alone owns `permissions.allow` and `permissions.defaultMode`, which Claude Code reads from the highest-ranked managed source only. Hook arrays from two drop-ins both ran in the cross-pool lab ✅, which supports Monitoring A3. |
| 4 | §6.1 compile | The policy fragment reads the workspace's account pool (price multiplier, endpoint price, the custom-host Auto confirmation) and what other fragments report (MCP matchers, pool requirements), and recompiles when they change (compile inputs, as Secrets & env A10 proposes). A pool requirement never turns a control on or fails a delivery; an unmet one is reported on both pools (FR8). No fragment may write `forceLoginMethod`, `forceLoginOrgUUID` or `/etc/claude-code/managed-mcp.json`. |
| 5 | §9 image and capabilities | Install `bubblewrap` and `socat`; publish `:hardened` without the `sudoers` entry; label each workspace's variant (`claudepilot.io/image-variant`). `policy-probe` runs at each start and when a policy needs the sandbox (FR21); its result is a workspace capability that Secrets & env reads for masking. Each policy key declares the Claude Code version that added it, for per-feature gating. |
| 6 | §6.2 write, per target | Every Kubernetes workspace gets a `claudepilot-sync` sidecar that owns the delivery `emptyDir`s and runs `sync`, and the workspace container mounts them read-only, so its user can't change delivered files, with or without `sudo`. "Enable pools" adds it in its one restart. Delivery `exec` targets the sidecar; outbox pulls, snapshots, probes and run-in-workspace steps ([MCP set](mcpset-pool.md) A4) still target the workspace container. Required for the hardened image, proposed for all (Q17). |
| 7 | §2 goals and non-goals | Keep "Hardening the workspace against its own user" as a non-goal for the standard image, and add that the optional hardened image makes managed settings binding for Claude Code without protecting delivered secrets. |
| 8 | §10 shared UI | A Policy select in the create dialog and a Policy row with the enforcement state in the Configuration panel; the policy editor is a page (§15); editors use one "Show advanced" SwitchRow; the shared Meter ([Monitoring](monitoring-dashboard.md) A8) gains a tick for a rotate point, also used by Account Pool's headroom bar. |
| 9 | §6.3, §5 rollout | A change that only tightens, by the Settings registry's direction, skips rollout pacing like revocations, and a workspace pinned to an older policy revision takes, per key, the stricter of its pinned value and the current one (FR20). Secrets & env A14 asks the same for urgent rotations. |
| 10 | §5 cleanup | Removing a workspace, or cleaning up a vanished one, also deletes its Settings rows (FR23). |
| 11 | §6.6 preflight | Also report, by name only, hook events, MCP server names and sandbox network hosts found in user and project settings, since those lists combine with the policy's (§6). |

**Related changes in other PRDs.**

| PRD | Change |
| --- | --- |
| [Account Pool](account-pool.md) | Already in v0.8: the rotate point and 10-point recovery (§12.2), a pause that rewrites the drop-in (FR19), empty-key helper runs ignored (§11.5), Anthropic workspace discovery (FR5). Still needed: `pools.threshold_pct` becomes an `account_pool` override that FR7's field renders; FR10's probe and dwell rules; a "Paused until T" state in its FR10; `CLAUDE_CODE_MAX_RETRIES` among its always-written `env` names (its Q15 re-checks the 401 target at 4); pause sets `CLAUDEPILOT_ACCOUNT=paused:<id>`, and `account-key` exits 1 with the reason on an empty key file; organization budgets rotate every account in the organization; per custom endpoint, a keyless-request check and the Auto confirmation. |
| [Secrets & env](secrets-env-pool.md) | Settings owns the env scrub and gates it on the probe (§11.2), owns `tlsTerminate`, adds "Protect home credential files" with its list (§11.1), shows FR27's requirements instead of adding them, takes FR28's hosts as proposals, reserves FR4's TLS variables, stays the only writer of `CLAUDE_CODE_MCP_ALLOWLIST_ENV`, and leaves `/etc/claudepilot/secrets/**` rules to its A1. Its "locked image" is §14's hardened image. |
| [MCP set](mcpset-pool.md) | Its requests are adopted: Settings writes `CLAUDE_CODE_MCP_ALLOWLIST_ENV`, on by default; its clean-environment requirement is warning level (FR8) and shows unmet until Apply (FR5); its FR19 evidence narrows Q21. |
| [Persona](persona-pool.md) | Ultracode is §11.2's "Workflows and ultracode" switch (its Q13). Subagents follow the session's mode, so v1 has no subagent mode setting. §11.4 holds its retention, and its A7 compile inputs are accepted. §10.3 is in CLI terms now, so its §10.3 follows Chat sessions' A8. |
| [Monitoring](monitoring-dashboard.md) | Its two rows are in §11.4, and §10.1 uses `Edit(~/.claudepilot/**)` as it asked. FR21 also flags nested `claude --bare` processes as High if Q22 is negative, and FR22 lists not-met controls. |
| [Skillset](skillset-pool.md) | Policy keys are here (§10.1, FR8). `skillOverrides` is left out because plugin skills ignore it. The shell-execution row shows how many skills it affects (its FR18). |
| [Portal MCP](portal-mcp.md) | FR19 is the flag its FR13 follows. Raising or removing a budget, cap or turn limit, switching Pause to Alert, Resume, a shorter audit or event retention and a longer transcript retention all count as relaxing. |
| [Chat sessions](chat-sessions.md) | Its A5 and A6 are adopted: §10.3 in CLI terms, the new rows in §11, and the pause order in §13.2. `CLAUDE_CODE_MAX_RETRIES` goes to Account Pool. A `/clear` counts against the session's budget (FR12). |
| [Web app & PWA](web-app-pwa.md) | Its A6 is adopted: Settings under Menu on phones, re-auth for relaxing changes (FR19), device and notification retention (§11.4). |
| All | "Locked image" becomes "hardened image" (tag `:hardened`) in the foundation, Secrets & env, Monitoring, Portal MCP and Skillset. The README row for this PRD becomes "Draft v0.5". |

## 21. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | 🔬 Does blocking Bypass or Auto in a reloaded drop-in move a running terminal session out of that mode, or only stop new entries? Does the managed lock beat `--allow-dangerously-skip-permissions` in a `-p` session ([Chat sessions](chat-sessions.md) Q5)? | Sandbox test |
| Q2 | 🔬 Which policy keys apply to running sessions on the pinned version: rules (documented as live), managed-only locks, `sandbox.*`, MCP and marketplace restrictions, `availableModels`, `maxEffortLevel`, `disableWorkflows`, `modelPricing`, `cleanupPeriodDays`? Do features re-read the `env` values? | Sandbox test |
| Q3 | 🔬 Do ask rules still prompt in terminal sessions running in Bypass? | Sandbox test |
| Q4 | 🔬 Does `Read(//etc/claudepilot/account/**)` leave the helper working (`/etc/claudepilot/bin/account-key <id>`, which Claude Code runs itself, not through a tool)? | Sandbox test |
| Q5 | 🔬 With the key file empty and the helper exiting 1, does a running session fail closed and never fall back to a saved login (Chat sessions Q4)? Does a helper that exits 1 still send a keyless request, as an empty one did? Answered: helper stderr is shown on every attempt (Account Pool sandbox X6). | Sandbox test |
| Q6 | 🔬 Which seccomp or AppArmor change, if any, lets `bwrap` start on DinD, Docker Desktop and the k3s nodes (Proxmox LXC, Ubuntu 24.04's `restrict_unprivileged_userns`), in the standard and hardened images, and is that change acceptable? Known on DinD ✅: Docker's default profile blocks it, and with seccomp relaxed only weaker nested mode works. Which `bwrap` flags does Claude Code use, so the probe matches? | Sandbox test, then Operator |
| Q7 | Narrowed: the docs say `sandbox` merges key by key across drop-ins and `allowedDomains` lists combine. 🔬 Left: which sandbox lists a user scope can extend (excluded commands, filesystem paths) and which have a managed-only lock; the exact path of `allowManagedDomainsOnly`; what sandboxed commands do with an unlisted host in each mode. | Sandbox test |
| Q8 | 🔬 Does `--max-budget-usd` in a long-lived stream-json session count the whole session or each prompt, and does it use `modelPricing` rates? Documented: the SDK's budget starts over after `/clear` in streaming input, and cost totals reset on `/clear`, hence FR12's own total. | Sandbox test |
| Q9 | 🔬 Does `CLAUDE_CODE_MAX_TURNS` limit interactive sessions? If so, terminals could get a turn cap. | Sandbox test |
| Q10 | Narrowed: `claude agents --json` documents kind `interactive`, and Chat sessions saw its sessions listed that way ✅. 🔬 Left: does it list interactive terminal sessions when run through `exec` without a TTY (Monitoring Q3)? | Sandbox test |
| Q11 | 🔬 Can the hardened image be escaped without `sudo` (user namespaces, setuid binaries)? Do archive writes and `exec -u root` renames work with all capabilities dropped and `no-new-privileges`? Does Claude Code reload on renames the sidecar makes in a shared `emptyDir`? | Security test |
| Q12 | 🔬 Does Docker's container update API change CPU and memory of a running workspace on both daemons? | Sandbox test |
| Q13 | Narrowed: on custom hosts Auto sends excerpts to the base URL and a failed classifier call blocked Bash ✅, so FR6 keeps it off there; the notice is Account Pool §10.4 and its Q17. 🔬 Left: is Auto available with Anthropic API keys on the pinned version, so Standard's "Auto allowed" means something? | Live-key test |
| Q14 | How can the portal tell that an organization's server-managed settings replaced the file policy in an own-login workspace? Same as foundation Q9 and Account Pool Q18. Monitoring reads it from `managed_settings_resolved` sources (`remote` before `file`) or missing hook signals, without login state; confirm with a real Team or Enterprise login. | Engineering |
| Q15 | Should Global start in Manual (proposed) or Accept edits? | Product |
| Q16 | Should reaching a workspace budget pause by default instead of alerting? | Product |
| Q17 | Should every Kubernetes workspace get the sync sidecar and read-only delivery mounts (proposed, amendment 6), so the policy file isn't writable without `sudo`? Should workspaces used by people other than the operator default to the hardened image? | Operator |
| Q18 | Terminal-session spend is counted only in Monitoring's Full mode. Should setting a workspace budget require Full mode? | Product |
| Q19 | Do the defaults ($10 sessions, highest $50; 4 sessions per workspace, 20 in total) fit your accounts' rate limits? | Operator |
| Q20 | 🔬 `disableWorkflows` is documented to make ultracode unavailable. Does the managed key turn ultracode off on 2.1.296 in terminals, chat and running sessions? | Sandbox test |
| Q21 | Answered ✅ (2.1.296, a throwaway Docker workspace, `settings/claude.integration.test.ts`): the allowlist checks every server a plugin adds. An exact `serverCommand` admitted a plugin's stdio server and a near miss blocked it ([MCP set](mcpset-pool.md) FR19), and `serverUrl` admitted a plugin's remote (HTTP) server while another URL passed with `--mcp-config` was blocked ("MCP server blocked by enterprise policy"). 🔬 Left: a remote server with OAuth or a `headersHelper` under the allowlist (the first needs a test OAuth server, MCP set Q2). | Sandbox test |
| Q22 | 🔬 Do `claude --bare` and `CLAUDE_CODE_SIMPLE` still apply `/etc/claude-code` managed settings on the pinned version (Monitoring Q4 asks the same for hooks)? Until confirmed, no workspace shows Enforced. If they don't, Monitoring flags nested `--bare` runs as High. | Sandbox test |
| Q23 | 🔬 Does `claude doctor` run through `exec` without a TTY and list dropped managed entries? If not, FR22 relies on `managed_settings_resolved` alone. | Sandbox test |
| Q24 | 🔬 Does `modelPricing` accept per-model rates for model names Claude Code doesn't know? If so, a custom endpoint's price goes there, and Claude Code's estimates and `--max-budget-usd` work on custom hosts. | Sandbox test |

## 22. Built: the shared settings store and the MCP lockdown

The owner asked for two switches: cut off every account (SSO) MCP connector so only the pool's servers can
connect, and an enforce switch so Claude cannot add a connection itself and must go through the pool. They
are built, together with the small store every global setting lives in. Everything else in this PRD is not.

**Status: Built** (server, delivery, page, workspace status line; verified on Claude Code 2.1.296 in Docker,
`apps/server/src/settings/`). Not built: per-workspace overrides, scopes G/P/W beyond Global (§12), the
relaxing flag and re-authentication (FR19), the settings registry's versions and directions, policies as a
pool type, everything in §11.1 and §11.3–11.5.

### 22.1 The store

| | |
| --- | --- |
| Registry | `defineSetting({ key, type, default, scope: 'global', group, label, help, confirmText, protective, order, min, max, integer, choices })` at import time. Areas define their own (A2's Bypass setting appeared in the list the day the store did). Keys look like `mcp.poolOnly`; a type is `boolean`, `number` or `string`. |
| Values | `portal_meta` under `setting:<key>` (JSON with who and when); a setting never set reads as its default, and reads never fail (a Frozen portal answers with defaults). |
| API | `GET /api/settings` (groups and settings), `PUT /api/settings/:key` (`{ value, confirm? }`), `GET /api/settings/audit`, `GET /api/settings/lockdown/:target/:name`, `GET /api/settings/agent-env/:target/:name` (§22.5). Behind the session guard and the Origin check, and every route asks the authz seam (declared in `settings/authz.ts`, T-309, T-329): the list is for every signed-in person; the lockdown and agent-env routes ask `view` on the workspace; the audit trail asks `view` and a change `manage` on the platform area `settings` (admins). What the asker may not see answers the same 404 as what does not exist. |
| Audit | Every change: key, old and new value, actor, time (`setting_changes`). The page's History button lists them. A repeat of the current value is not a change. |
| Confirmation | A setting with `protective: <value>` is a security switch. Moving away from that value (switching a protection off, or an agent permission on) is refused with `409 CONFIRMATION_REQUIRED` unless the request says `confirm: true`; the page asks first, in one line (`confirmText`). Turning a protection on never asks. |
| Page | Settings, in the admin group of the navigation (phones: the More sheet). Sections by group (MCP, Agents, Sessions); a row is a label, an ⓘ with what it does, and a switch, a number field, or a segmented choice for a setting with `choices`. Nothing else is on the page. |

### 22.2 The two MCP switches

| Switch | Delivered as | Observed on 2.1.296 ✅ |
| --- | --- | --- |
| Account MCP off (`mcp.accountOff`) | `disableClaudeAiConnectors: true` | Signed in as a claude.ai subscription account (fake credentials, a TLS stand-in for `api.anthropic.com` that lists one connector and serves it over the claude.ai proxy), a session asks `/v1/mcp_servers`, connects the connector and offers its tool. With the key on, the log says "Disabled via disableClaudeAiConnectors setting", the list is never asked for, and only the pool's tool remains. `ENABLE_CLAUDEAI_MCP_SERVERS=false` in a process's environment does the same ("Disabled via env var"). |
| Pool MCP only (`mcp.poolOnly`) | `allowManagedMcpServersOnly: true` and `allowedMcpServers`: exactly the matchers the pools report for that workspace (MCP set FR19: MCP sets register theirs; the portal MCP endpoint and the browser pool are asked to, with `McpLockdown.addMatcherSource`) | `claude mcp list` shows the pool's servers only; a server in `~/.claude.json`, in a repository's `.mcp.json` (even pre-approved), in `--mcp-config` (the portal's own chat endpoint included, unless a source admits it) or from a claude.ai connector is blocked ("MCP server blocked by enterprise policy"); `claude mcp add` is refused for stdio and HTTP ("not allowed by enterprise policy"); a user-level `allowedMcpServers` does not widen it; an empty allowlist blocks every server; a plugin's remote server is admitted by its `serverUrl`. |

Pool MCP only alone already shuts the claude.ai connectors out (they are blocked after being listed); Account
MCP off additionally stops them being fetched at all, and works without the allowlist. Both are written for
every workspace: own-login Claudes and pool workspaces, running ones too.

- **FR-L1** The fragment is owned by `settings` (`delivery/ownership.ts`): `disableClaudeAiConnectors`,
  `allowManagedMcpServersOnly` and `allowedMcpServers` only, `true` only, and an allowlist entry is only
  `{ serverUrl }` or `{ serverCommand }` (never a server name: names are not a control). The compiler's
  guard still rejects `cpat_`, `cpoa_`, `cpor_` anywhere and `cpst_` in files. Claude Code older than 2.1.273
  does not get it, and the workspace's status says so.
- **FR-L2** A change is delivered at once to every known workspace (no rollout pacing: a protection never
  waits, foundation §6.3). Switching a switch off removes the drop-in after the delivery engine's 30 s grace,
  or at the next session start, never before.
- **FR-L3** A source that fails to report its matchers is skipped and logged: its servers are not admitted
  and delivery goes on. An allowlist is never widened by a failure.
- **FR-L4 Status per workspace** (the Configuration sheet, one line, only while a switch is on):
  **Locked** (delivered and no running session predates it), **Pending** ("Not delivered yet", "A change is on its way", or "N running
  sessions started before the change: restart them"), **Not protected** with the reason (delivery failed,
  frozen, Locked portal, Claude Code too old, unsupported target). ✅ A running session keeps the MCP
  servers it connected when it started, even when the managed folder already existed: held open across the
  change, one session's next request still offered the repository's server (Pool MCP only) and another's the
  claude.ai connector (Account MCP off). (Before the folder exists a session never sees later managed
  settings at all: A3c's finding.) So the portal reads each running `claude` process's age and counts the
  sessions older than the change. Locked is a security claim, so the count is conservative: the change counts
  from when its write finished; the pass that wrote it read the ages before writing and says "Checking the
  running sessions" until a second pass, a few seconds later, reads them again; and a process counts as older
  when it could be (ages are whole seconds). The ages are read before a workspace's first manifest too.
- **FR-L5** Not a boundary against someone with `sudo` in a standard workspace (foundation §2): managed
  settings are precedence there, and the reconciler puts the file back. It does stop Claude's own routes to a
  new connection. On the hardened image it binds (§14).
- **FR-L6** When Pool MCP only is on, the sanctioned way for an agent to get a new MCP is the portal MCP's
  proposal tool through its agent token ([Portal MCP](portal-mcp.md) I3, I8), which lands as a draft for a
  person to approve; with agent access off the admin adds the entry in the UI. The switch's ⓘ says so.

### 22.3 Verification

`settings/settings.test.ts` (store, confirmation, audit, ownership, matchers, status, routes, removal) and
`settings/claude.integration.test.ts` (Docker, `CLAUDEPILOT_DOCKER_TESTS=1`): a real Claude Code against a
throwaway workspace: pool-only (list, add, `--mcp-config`, the repository's server, an older running session
Pending then Locked, an empty pool, switching off), the same for a remote pool server by URL (Q21), and the
subscription-account run for Account MCP off with the connector appearing and disappearing.

### 22.4 Open

- 🔬 A claude.ai connector from a **real** account (the stand-in lists one fake connector).
- Answered ✅: a running session does not apply the lockdown (above), so Pending until restarted is right.
  🔬 Left: whether an interactive session re-reads it on `/reload-plugins`.
- The single "pool MCP" gateway reading is designed, not built: [MCP set](mcpset-pool.md) §23.

### 22.5 The agent policy (T-285)

**Status: Built** (server, delivery, page, workspace status line; tests in `settings/agentEnv.test.ts`). Not yet
observed in a running Claude Code: see Open below.

Five global settings in the Agents section reach every Claude process (and its sub-agents) as managed `env`
in the policy owner's drop-in `10-claudepilot-policy.json` (`settings/agentEnv.ts`, fragment owner `policy`).
Each is always written, its default included: a value is overwritten, never removed (§10.1). When a change takes
effect differs (T-302, T-309), and each ⓘ and the Configuration sheet's line say which is which (`applies` on
each value): the three sub-agent values apply at once to new sub-agents (ones already running keep theirs); the
two output caps are read when the Claude process starts, so a running Claude takes them in a new chat or a Restart.

| Setting | Variable | Default | Source of the default |
| --- | --- | --- | --- |
| Sub-agent cache (`agents.subagentCacheTtl`, `5m` or `1h`) | `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` | `1h` | T-285: sub-agents re-wrote 47 M tokens of context after waits on the 5 minute cache. The variable and its `5m`/`1h` values are in Claude Code 2.1.296, which ignores `1h` while a subscription is in overage |
| Sub-agents (`agents.maxSubagents`, 1 to 50) | `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | 5 | D-43 |
| Spawn depth (`agents.spawnDepth`, 1 to 10) | `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | 3 | The Standard preset (§10.1) |
| Bash output (`agents.bashOutputMax`, 1000 to 200000) | `BASH_MAX_OUTPUT_LENGTH` | 8000 | The token-economy design, lever 4 |
| MCP output (`agents.mcpOutputMax`, 1000 to 200000) | `MAX_MCP_OUTPUT_TOKENS` | 25000 | Claude Code's own default |

- The names are the policy owner's by exact name (`delivery/ownership.ts`), so no pool can override one
  (`mayUseEnv`): a new Secrets & env entry with one is refused when the set is saved (422). An entry saved
  before is tolerated: the policy wins, the entry is skipped at delivery (never a failed delivery), the
  reconciler logs one warning line per workspace, and the Configuration sheet says "N overridden by policy"
  with the variable and the set behind its ⓘ. `ENABLE_PROMPT_CACHING_1H` stays a pool name.
- A change asks every known workspace to deliver again. What landed is recorded per workspace
  (`policy_env_state`, migration 840: names and values, none secret).
- Secrets & env FR4 (a name another owner claimed after the set was saved fails delivery) has this one
  exception: names the agent policy sets.
- The Configuration sheet shows one line: Applied, Pending (a change on its way), or Unavailable (nothing
  landed yet: never the setting's value as a guess); the values in effect are behind its ⓘ.

**Browser check (2026-10-14):** `tools/qa/agent-policy.mjs` against a scratch portal with This machine in a Job
(`claudepilot-job-54126d8a`, commit c03c461): 101/101 checks at 390 px (touch, safe areas) and 1280 px, light and dark: the
five rows, labels of one or two words, every control 44 px tall and each 5m/1h segment 44 x 44, the InfoTips inside the screen,
the choice saved on the server, no sideways scroll; the sheet's line Unavailable on the real server and, with a fixture answer,
"1 overridden by policy" with the variable and the set behind its ⓘ.

Open: 🔬 a real Claude Code reading each variable from the drop-in (the Docker integration suite can show it);
a per-workspace override waits for scopes (§12).

### 22.6 The rule-file guard (T-404, D-60)

**Status: Built** (server, delivery, audit; tests in `settings/ruleGuard.test.ts`, which run the delivered script against
scratch folders). Not yet observed in a running Claude Code in a pod: see Open below.

**The rule (D-60).** No agent session in a workspace writes a rule file. Rule files change only from outside the pod: a
lead proposes the change as text on a ticket; the coordinator (outside the pod) lands it when it only tightens (adds a
deny, removes or narrows an allow, removes a runner); anything that loosens, or adds a hook, an MCP server, `env` or a
plugin, is the owner's. Why: a lead denied itself Edit and Write of `.claude/**` and changed the file with a node script
anyway (T-391); a pattern deny cannot stop a Bash write.

**Rule files**, in any folder: `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, a repository's
allow-list checker (`check-allowlist.*`), and Claude Code's own `.claude.json`; `settings.json` and `settings.local.json`
also count in `~/.claude` and in each Claude's config folder (`CLAUDE_CONFIG_DIR`, `~/.claudepilot/claudes/<id>`).
Every file under `/etc/claude-code/` (managed settings and their drop-ins) and `/etc/claudepilot/` (the guard's own
files and the other delivered scripts) is a rule file too, and so are those folders themselves. (`sudo` in the workspace is
a separate tightening, T-422.)

**How it is delivered.** The policy owner's fragment (`settings/agentEnv.ts`), which every workspace gets, carries two
root-owned files outside every workspace folder and one hook in `10-claudepilot-policy.json`:

- `/etc/claudepilot/bin/policy-rule-guard` (root, 0755): a POSIX sh wrapper that runs the Node half with a fixed node
  (`/usr/local/bin/node`, else `/usr/bin/node`) through `/usr/bin/env -i` (only `HOME`, a fixed `PATH` and
  `CLAUDE_CONFIG_DIR` pass), so nothing a session sets loads first (`NODE_OPTIONS`, `NODE_PATH`, a `PATH` with its own
  `env`); with no node it refuses.
- `/etc/claudepilot/bin/policy-rule-guard.cjs` (root, 0644): the Node half, no dependencies (`settings/ruleGuard.ts`).
  It checks in a worker thread and keeps its own deadline of 20 s: a check still running then is refused by the guard
  itself (exit 2), as is a worker that crashes or gives no answer.
- `hooks.PreToolUse`: matcher `Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*`, command
  `/etc/claudepilot/bin/policy-rule-guard || exit 2` with a 30 s hook timeout, so a guard that is missing or crashes
  refuses instead of letting the call through. A hook that Claude Code kills at its timeout is not a refusal (the call may
  go through), which is why the guard's own deadline sits well inside it. The policy owner may set only `PreToolUse` hooks
  that run its own `policy-*` scripts (`delivery/ownership.ts`); no pool can write `policy-*` files.

Managed settings rank above every project, local and user file, and Claude Code runs hooks in every permission mode, so
the guard binds every Claude Code session in the workspace: the portal's chats, crew workers, sub-agents (their tool calls
fire the hook too) and **Bypass sessions** (`bypassPermissions` skips prompts, not hooks; exit 2 stops the tool call). The
coordinator runs outside the pod and is not affected. The portal's folder trust only reads project settings through the
runtime's exec, and Claude Code's own writes (an "always allow" answer to a prompt) are not tool calls, so both keep
working. A session takes the hook when it starts: one started before the guard landed needs a Restart (the chat's
"Tools changed" hint names Policy).

**What it refuses** (exit 2, message `rule files change only through the coordinator (D-60)` with the form and path):

- Edit, Write, MultiEdit and NotebookEdit of a rule file, resolved against the session's folder, through symlinked
  folders and files, and a hard link to a rule file made earlier.
- An MCP tool whose name is not only a read with a path-like argument (`path`, `file`, `destination`, `source`, `to`,
  `from`, `name`, ...) that is a rule file. A name with a write verb is a write, whatever read verb it also has
  (`search_and_replace`, `searchAndReplace`, `get_or_create_file`). Free text (a ticket comment naming a file) is not a
  path.
- A Bash command with a write form that names or could name a rule file: a redirect (`>`, `>>`, `>|`, `<>`, `&>`,
  `exec 3>`), `tee`, `sponge`, `sed -i`, `perl -i`, `cp`, `mv`, `install`, `rsync`, `dd of=`, `truncate`, `touch`,
  `chmod`, `ln`, `rm`, editors, `curl -o`, `tar -C .claude`, `patch` and `git apply` of a patch touching one,
  `git checkout`/`restore`/`rm`/`mv`/`reset` of one, a `git checkout <commit> -- .` (a folder from another commit),
  `find ... -delete`/`-exec` that could reach one, `xargs` with a write command fed from a pipe, the write forms of
  readers and of git reads (`uniq IN OUT`, `tree -o`, `yq -i`, `git config --file`, `git archive -o`, `git bundle
  create`), and any command that is not a known reader (`cat`, `grep`, `jq`, `git diff`, ...) with a rule file among its
  words (`npx prettier --write`).
- Commands hidden in another place (second review): a `git -c` or `--config-env` value, and `git config` of a key, that
  names a rule file, or that is not a known harmless key (`color.*`, `user.*`, `core.quotepath`, ...) while the command
  shows a piece of one (`git -c alias.x='!...' x`, `git -c core.pager='tee .mcp.json' log`); `git --work-tree`/`--git-dir`
  (paths then count as from an unknown folder); an assignment set for a command whose value names a rule file
  (`GIT_INDEX_FILE=.claude/settings.json git add`), and a variable that runs code or moves writes (`GIT_*`, `LESSOPEN`,
  `PAGER`, `EDITOR`, `NODE_OPTIONS`, `BASH_ENV`, ...), set for a command, by `env` or by `export`, while the command
  shows a piece of one (`LESSOPEN='|rm %s' less .claude/settings.json`); `env -S 'cmd ...'` (the string is checked as the
  command), `env -C DIR` and `sudo -D DIR` (the command is checked in that folder); `sed`'s `e` command and `s///e` flag;
  `rg --pre PROG` unless PROG only prints (`cat`, `zcat`, ...), `less +!cmd` and `less -o FILE`, and a `--pager` while a
  piece of a rule file's name is shown.
- A nested Claude Code (`claude`, `npx @anthropic-ai/claude-code`) whose `--settings` switch hooks off or set hooks
  (`disableAllHooks`, `allowManagedHooksOnly`, `hooks`; the JSON is parsed, so an escape does not hide a key), whose
  settings are not JSON, or that the guard cannot read (a variable, a missing file); and `claude config`, `claude mcp`
  and `claude plugin` with a verb that writes (`set`, `add`, `install`, ...).
- An MCP tool that runs a command (`run_command`, `execute`, `shell`, camelCase names split first): its command-like
  arguments (`command`, `cmd`, `args`, `script`, ...) are refused when they name a rule file and are checked like a Bash
  command otherwise.
- Code the guard cannot see: `sh -c`, `eval` or inline interpreter code (`node -e`) from a command substitution or made
  only of variables (`sh -c "$(curl ...)"`, `eval "$CMD"`), and `source <(...)`. A lone `$(cat FILE)` or `$(< FILE)` is
  read and checked like the code it holds. `eval "$(ssh-agent -s)"` is refused too.
  Interpreters (`node`, `python`, `perl`, `ruby`, `awk`, `claude`, ...) are refused when their words name a rule file,
  when the command names one anywhere (data on stdin), when they read code from stdin while one is named, and when inline
  code writes a file and carries a piece of a rule file's name (`'.cla' + 'ude'`), a decoding call (base64, char codes,
  hex escapes) or the words claude, settings, mcp or allowlist. Running the allow-list checker itself is a read.
- The forms that hide a name, where the text shows them: quotes and escapes (`.cl""aude`, `$'\x2eclaude'`), `./` and `..`
  in the path, globs and braces that could match (`.claude/set*`, `.c*/settings.json`, `{settings,x}.json`, and `*.json`
  after `shopt -s dotglob`), a variable or command substitution as the target when the command carries a piece of a rule
  file's name or decodes anything, `cd .claude && ... > settings.json` (and `cd` to a folder it cannot know), subshells,
  `bash -c`, `sh` reading a heredoc, `eval`, `env`, `sudo`, `timeout`, decoded text piped into a shell or `eval`, a copy or
  move of a folder that would land a file on a rule file (`cp -r x/. .claude/`, `mv x .claude`), and a script file run
  directly (`bash fix.sh`, `./fix.sh`, `node fix.mjs`) whose code (comments left out) names a rule file and writes.
- **`git -C <path>` outside the lane worktrees (T-860).** The lane allow rules are text (`git -C /home/node/work/agentic-worktrees/*
  ...`), and the shell builds `..` from forms with no two dots in a row (`.''.`, `.""."`, `.'.'`, `.\.`), so a text deny cannot hold the
  path (a write to the main folder checkout through the `commit` and merge allows). The guard reads the `-C` path as the shell does (the
  same lexer: quotes, backslashes, ANSI-C quoting), resolves it against the command's folder (a `cd` before it counts), takes its real
  path (symlinks followed) and allows it only strictly below a lane root: `/home/node/work/agentic-worktrees`, or a folder listed in the
  root-owned `/etc/claudepilot/git-c-roots` (one absolute path a line, `#` comments). Refused: a path with a variable, a command
  substitution or a backtick (`$X`, `$(...)`), a glob or brace pattern (`.?`, `.[.]`), a path that does not exist, a `-C` with no folder,
  a relative path when the folder is unknown, a symlink that points out, the root itself and a sibling that only starts with its name.
  Every `-C` of a command is checked (`git -C a -C b`), in a pipe, after `cd x &&`, in `bash -c`. The refusal's audit line carries the
  form and no path (`path` is empty), never the command. The check is on only in a workspace that has the lane folder or a roots file;
  elsewhere (no lane allow rule to guard) `git -C` is tracked as before, so it does not refuse a lead's `git -C` in its own repository.
  **S2: the allow's `*` takes everything after the folder**, so in a lane workspace the rest of the command is read too:
  `--git-dir` and `--work-tree` (both `=` and two-word forms) are read like `-C` and must stay below a lane root; before the subcommand
  only `--no-pager`, `-P`, `-p`, `--paginate`, `--no-optional-locks`, `--no-lazy-fetch`, the pathspec switches, `--no-advice`,
  `--no-replace-objects` and `--version` pass, so every `-c`, `--config-env`, `--exec-path`, `--namespace`, `--bare`, a glued `-Cpath`,
  a `--` and a variable or pattern there are refused (after the subcommand `-c` and `-C` are git's own and pass). A `GIT_*` variable that
  moves a folder or runs a program (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_CONFIG_*`, `GIT_EXEC_PATH`, `GIT_SSH_COMMAND`, ...) is
  refused as a prefix, after `env`, `export` or `declare`; author, committer, trace and prompt variables pass. `env -C` and `sudo -D`
  before git are read like `-C`; `find -exec git ...` is read as a git command; `alias` is refused; an unclosed quote or a trailing
  backslash next to `git` is refused; `git config` of `core.worktree`, `core.bare`, `core.hooksPath`, `core.fsmonitor`, `core.sshCommand`,
  `alias.*`, `include.*` and the like is refused; and a line that holds a `git -C` and, in another command, `ln`, `mv`, `cp`, `rm`, `mkdir`,
  `tar`, `unzip` or a `git config` or `git worktree` is refused (the path is read before the line runs, so a link swapped in the same line
  would point elsewhere). **S2b (blind review, T-860 comment 8740):** a relative `--git-dir` or `--work-tree` is refused (git applies
  every `-C` first, so it reads the value after the last `-C`; an absolute value is still checked like `-C`); the name of a refused
  `GIT_*` variable with no value (`export GIT_DIR`, `declare -x`), `read` into it and `printf -v` into it are refused; `GIT_TRACE*` passes
  only as a switch or a number (it appends to any file it names); and `git config --file`, `-f`, `--global`, `--system` and `--blob` are
  refused. **Residual (item 22):** the swap guard is a name list (`ln`, `mv`, ...); `python3 -c`, `node -e`, `perl -e`, `link`, `dd`, a
  redirect or `git checkout` of a tracked link swap a link the same way and are not on it. The real fix is permissions (the lane user
  cannot write where the links resolve), not more names. Out of scope, named so they are not a surprise: a race between the check and the run (permissions close it);
  a `.git` file planted in a lane folder that points at the main repository; repository hooks; `cd M && git commit` (the cwd moves, not
  `-C`: a sibling rule); writes from inside the lane folder to other places (`worktree add /abs`, `archive -o`, `checkout-index --prefix`,
  `push M`), reads outside it, and `git -C <other-lane>` (a lane may reach a sibling lane: the ticket allows everything under the root).
  Tests: `settings/ruleGuard.test.ts` (T-860), which build a scratch lane root and give it to the guard by `CLAUDEPILOT_GUARD_GITC_ROOTS_FILE`
  (read only by the Node half, which the wrapper starts with an emptied environment, so a session cannot set it). Not yet observed in a
  running Claude Code in a lane pod; the coordinator's deny lines (T-860 stopgap) stay as the first layer.

Reads go through (`cat`, `jq`, `git diff`, `git show HEAD:.claude/settings.json > /tmp/x`), and so does every write of
another file, `.claude/agents/*` and a `.vscode/settings.json` included.

**What a hook cannot see** (stated plainly; these are covered by D-60's rule and review, not by the guard):

- A program that builds the path at run time from pieces the command does not show: a script file whose code does not
  name the file (reads it from a file, an environment variable set elsewhere, the network), a compiled binary, a
  package script (`npm run x`, `make`), a test runner, a git hook, or a long-lived process started earlier.
- Inline code that builds the path without any of the pieces, decoding calls or words above.
- Data that names the path from a file instead of the command (`node fix.js < paths.txt`).
- What an archive holds (`tar -x`, `unzip` into the repository), what a branch switch, merge, pull, rebase, `reset --hard`,
  `stash pop` or `git clean -x` changes, and the delete of a whole folder above the rule files (`rm -rf repo`,
  `find . -delete`).
- Anything that does not go through a Claude Code tool call: a person's shell, the portal's own exec, a desktop session
  over SSH that runs another agent, and Claude Code's own writes.
- Its own audit line: the outbox is the workspace user's folder, so an agent can remove the line after the refusal (the
  refusal itself does not depend on it).

It errs on the side of refusing: some reads in an interpreter (`python -c` that only reads `.claude/settings.json`) and
some unrelated commands that also name a rule file are refused, and so is an MCP tool that runs a command naming one
(`cat .mcp.json` through `run_command`) and `git -c` of a key outside the harmless list in a command that names one. A test file that writes rule files into a temp folder is
refused when run directly in a workspace; run it through `scripts/job-run.sh`. Copying a whole repository with `cp -r`
is refused when it would land rule files; use `git clone` or `git worktree add`.

**Audit.** Each refusal appends one line to `~/.claudepilot/outbox/guard.jsonl` (foundation PRD §8): the Claude Code
session id, the tool, the form, the path, the agent type and the permission mode; never the command's or the file's
content. The path is the resolved rule file (or `.claude` folder), else the fixed label `unresolved`: never a word of the
command; the portal keeps only an absolute path or that label from a line. The portal pulls the `guard` channel of the
workspaces the policy drop-in landed in and that are not removed (every 10 s while running, and before a stop; at most 4
pulls at once, and a workspace left waiting by one tick goes first in the next) and writes one audit row `guard.refused` (severity high) with the workspace and, when the portal ran the
session, the chat it belongs to (`settings/ruleGuardAudit.ts`).

Open: 🔬 the QA real job: a `dontAsk` worker and a Bypass lead in `~/work/konfersi-universe` both refused writing
`.claude/settings.json` by Edit and by `node -e`, while editing a source file still works; 🔬 whether `disableAllHooks`
set by a session can switch off a managed hook in the pinned Claude Code at all (the guard refuses a nested `claude`
whose `--settings` change hooks either way).

