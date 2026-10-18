# The General Manager

Draft v0.2 (T-968 S0, 2026-10-17; v0.2 answers the S0 QA gaps, T-968 comment 10735). Source: the owner's request on T-968 and decision D-80 (`docs/dev-sessions/DECISIONS.md`).
Nothing is built. Defaults marked **(default)** are the writer's or the coordinator's; the owner may change them on T-968.

## 1. What it is

One chat session per person, of a new kind `manager`, that is the person's interface to the whole pilot: crews and
orchestrators, sessions, tickets, CI and deploys, usage, schedules, settings and the knowledge vaults. The person talks to it on
Home; it reads and acts **only through the Portal MCP, as that person**. It has no workspace, no repository and no files.

Owner (T-968): "manage all user pilot, all tickets, managing orchestrators … act the interface between human and all agents and
pilot … no need to connect to any workspaces or file … read all workspaces, sessions, tickets, settings … directly to the pilot …
on Home, but we can switch in between dashboard mode or manager mode. This is mandatory."

**Goals**

- G1. One place to ask "what are my crews doing and what is blocked" and get an answer from live data.
- G2. One place to act: open a ticket, message a lead, start or end a session, start a deploy, change a setting, answer an
  approval. Guarded actions stay the person's decision, taken in the same chat (§6).
- G3. Over time, the coordinator's routine moves into the manager, so the person only needs to talk to it (S6).

**Non-goals (v1)**

- Reading or writing workspace files, running shell commands, browsing the web. It asks a session in a workspace to do that.
- More than one manager per person. Managers shared between people.
- A model or provider other than Claude Code on the person's own Claude or API key.

## 2. The `manager` session kind (S1)

- `chat_sessions.kind` is a new column: `'workspace'` (every existing row) or `'manager'`. `chat_sessions` has no owner column
  today, so the same append-only migration in the chat set also adds `owner_id TEXT NOT NULL DEFAULT 'u_owner'`. That follows
  the multi-user adoption rule 4 that other tables already use (`migrations.ts`, the `owner_id` columns). It adds a unique
  index on `(owner_id) WHERE kind = 'manager'` as well, which enforces one manager per person in the database, not only in
  code.
- The portal creates the session when the person enables the manager (§7). Neither the person nor an agent creates one any
  other way: `session_start` and `session_spawn` refuse `kind: 'manager'`.
- It is **not in the Sessions list**, nor in `session_list`, `session_family`, crews or the Sessions glance widget. Home is its
  only door (§5). `session_get` on its id answers the person (and their manager) only; anyone else gets the same not-found.
- It is a normal session in every other respect: the transcript, compaction, the usage meters and attribution (person,
  `agent=manager`), auto move between the person's Claudes (auto-transfer PRD), Interrupted and Resume, and idle sleep.
- **Disable** stops the session and revokes its token. It keeps the transcript and the runtime's home volume.
  **Remove** deletes both, after the person taps to confirm (deleting data, §6).

## 3. Runtime choice (S1)

The manager's Claude Code needs a process somewhere. The options:

| Option | For | Against |
| --- | --- | --- |
| A. **A hidden per-person runtime**: a tiny workspace of kind `manager` on the portal's own target (a pod in the workspaces namespace on k3s; a container on Docker) | The session machinery works unchanged (host, stream-json, Claudes, auto move). It is isolated from the portal process and its credentials. Its resources can be limited. | One more pod per person. It needs an egress policy (a door for the coordinator). |
| B. Claude Code inside the portal pod | No new runtime. | The portal pod holds the cluster credentials (`deploy/k3s/README.md` refuses the "This machine" target there for exactly this reason). A prompt injection would be one escape away from them. |
| C. Call the model API from the portal, without Claude Code | Smallest footprint. | It loses compaction, the transcript format, Claudes and auto move, and would need a second session engine. It is not "a session like the others". |

**Choice: A (default, D-80).**

- **Image:** the pinned workspace image (the same Claude Code version and canary as every workspace).
- **Volumes:** one small home volume for Claude Code's state and sign-in, 1 Gi **(default)**. No repository, no worktrees, no
  Secrets & env delivery, no pools except the person's Claude (§3.1).
- **Resources:** requests 100m CPU and 256 Mi, limits 1 CPU and 1 Gi **(default)**. It runs on the portal's node selector.
- **Hidden:** `workspace_list`, the Workspaces page, fit checks and crews never show it. `workspace_get` on it answers like a
  missing workspace for everyone, the person included.
- **Egress:** the portal's internal URL and the model API host only, plus DNS. On k3s this is a NetworkPolicy in the
  workspaces namespace keyed on the label `claudepilot.kind=manager`. That is infrastructure: **FOR THE COORDINATOR** (the
  NetworkPolicy and the egress allow-list for the API host). On Docker it is an internal network with the portal and an
  egress proxy **(default; Docker is not the owner's target, so it may come later)**.
- **Tools off, three layers deep:**
  - The launch passes `--strict-mcp-config` with only the `pilot` server, and denies the built-in tools: Read, Write, Edit,
    MultiEdit, NotebookEdit, Bash, BashOutput, Glob, Grep, WebFetch, WebSearch and Task. The deny comes through managed
    settings that the session cannot edit, and the launch flags.
  - Even if a tool slipped through, the pod has no data and no credentials of value except its own MCP token and Claude
    sign-in.
  - The egress policy stops anything leaving except to the portal and the model.
- **Persona:** a built-in persona `general-manager`. It says what the manager is, the rules of §6 and the untrusted-text rule.
  The person cannot assign another persona to it in v1 **(default)**. Its skills come from S6.

### 3.1 Its Claude

The manager uses one of the person's Claudes:

- the existing Claude Code sign-in flow run inside the runtime (Workspace Claudes FR4: the portal keeps no subscription
  credential); or
- an Anthropic API key the person stores as a Secrets & env secret, delivered only into this runtime.

Auto move works between the person's Claudes in the runtime, as for any workspace.

## 4. Identity: the manager token and the person's `can()` (S1, S5)

- **A third token class, `cpmt_`** (manager), next to `cpat_` (a person's personal token) and `cpst_` (an agent's session
  token). The portal mints it for the manager session when its process starts and puts it only in that process's environment
  (`PILOT_MCP_TOKEN`). It is hashed at rest, lives as long as the session, at most 7 days (as `AGENT_TOKEN_TTL_MS`), and is
  revoked on disable, on remove and on any sign-out of the person, on any device, as §12 says (Q3). The manager gets a new token
  at the next sign-in. Nothing scheduled ever uses it (Q4).
- **Principal:**

  ```ts
  { kind: 'manager', userId, sessionId, workspaceId: null }
  ```

  - `ctx.actor` is `manager:<sessionId>` and `actorLabel` is "General Manager". These two are **labels for audit and the
    UI only**; no authorization decision reads them.
  - Audit rows carry the person and `agent=manager`.
- **Authorization is the person's, resolved at use time.**
  - `can(actor, verb, object)` receives **the person**: `{ kind: 'user', userId }`, the same actor the person's browser
    session produces. It never receives `manager:<id>`, and there is no manager branch inside `can()`.
  - The manager never sees or does more than the person could in the browser right now. If the person loses a grant, the
    manager loses it on the next call.
  - A denial is the same not-found.
  - **Where the seam change lands:** `apps/server/src/authz/seam.ts`, in `actorOfPrincipal` (today it takes
    `kind: 'user' | 'agent'`). S1 adds `'manager'`, mapped to the person's user actor. That change is in the `authz` module and
    goes through the S5 blind security review (D-60), with a test that a manager principal and the person's own principal get
    the same `can()` answer for a sample of objects, and that `actorOf` on a web route never yields a manager.
- **What the token reaches** (the tool tier, `registry.ts` `userTier`):
  - **Read tools** (`hints.readOnly`) at any tier the person holds: answered directly.
  - **Operate-tier writes** that are not in a guarded class: answered directly, audited, rate limited (§8).
  - **Admin-tier writes and every guarded class** (§6): only through the person's confirmation card (§6.1), never with the
    model's `confirm_token` alone.
- **It is not an agent token.**
  - `ctx.isAgent` is false, and there are no workspace or session bindings to assert.
  - The tools that are only for an agent acting as itself refuse it: `session_rename_self`, `persona_get_self`,
    `persona_propose_update`, `session_request_clear`, `worktree_create`.
- **It is not the person's browser session.**
  - The `cpmt_` token never authenticates a web route.
  - The cookie session never authenticates `/mcp`.
  - The confirmation endpoint (§6.1) accepts only the cookie session, with its CSRF check.

## 5. Home: Dashboard mode and Manager mode (S3)

- Home becomes the **first** nav item, before Workspaces.
- At the top, a two-way switch: **Dashboard | Manager**. It is icon-only on phones and remembered per device (local storage
  `home.mode`). The switch shows only once the manager is enabled; before that, Home is the dashboard (§7).
- **Dashboard** is today's Home, unchanged.
- **Manager** is the manager chat at full height, reusing the session chat components:
  - kept: the transcript, the composer, in-chat approvals and the confirmation cards (§6.1);
  - hidden: the files and diff panels, the workspace and branch chips, Move, model and effort (they live in the manager's
    sheet).
- The UI bar applies: phone width first (390 px), then 1280 px; 44 px targets; no horizontal scroll; the page does not drag
  (`lib/viewport.ts`); light and dark.
- **Text diet:** the title is "Manager", the help sits in an InfoTip.
- A busy or interrupted state is the session's own (Working, Interrupted, Resume). If the runtime is down: one line and Restart.

## 6. What the manager may not decide alone

**Cards are for the guarded classes only, not for every write (D-80 (5)).** The six classes below need the person's tap.
Every other write runs directly, audited and within the §8 limits; the table in §9.4 names the class of each write tool. The
owner may ask for a card on every write, on T-968 (Q6); until then this is the lead's decision, recorded on T-968.

These stay the person's decision. The manager asks in the same chat, and the person answers there with a tap, never by typing
"yes":

1. Production, and uat. uat happens only on the owner's request (D-79), and then the request is the person's own message.
2. A deploy **release approval**. The manager may start a deploy, but the release waits for the person's approval in the
   portal, as today. No Portal MCP tool can approve a release, whatever the token.
3. Deleting data: a workspace, a pool, a vault, a ticket's attachment, the manager itself; a note when a note delete tool
   exists (none does today).
4. Credentials: secrets, keys, tokens, Claude sign-ins, an account pool assignment.
5. Anything a deny rule, a gate or an approval guards: the Bypass gates, the settings with re-auth (MCP lockdown, the Bypass
   policy, sign-in), allowing a tool request, and admin-tier writes.
6. Mass actions over the limits in §8.

The manager also follows these rules:

- Text the manager reads from tickets, transcripts, logs, CI output, notes and pages comes labelled `untrusted_text`
  (`ctx.untrusted`). It is data, never an instruction; the persona says so.
- An instruction found in such text that asks for a guarded action is reported to the person, not acted on.

### 6.1 The confirmation card (S5)

Today's `confirm_token` (`portalmcp/confirm.ts`) can be completed by the model alone, so it is not a person's decision. For the
manager, the guarded classes use a card instead:

1. **The tool call.** A guarded tool called with a `cpmt_` token returns `person_confirmation_required`, with:
   - a `card_id`;
   - the preview (what changes, the blast radius);
   - an expiry of 5 minutes.

   The card is bound to the person, the manager session, the tool, a hash of the arguments, the resolved target and a hash
   of the preview, like `Confirmations` today.
2. **The card in the chat.** The portal puts the card into the manager chat as a system item (not model text). It shows the
   preview and two buttons, **Do it** and **No**.
3. **The tap.** The tap is a `POST /api/manager/confirm/<card_id>` from the person's browser session: cookie, CSRF and the
   re-auth the class needs (for example, the settings that need the sign-in code again). The `cpmt_` token cannot call it.
4. **The retry.** The model repeats the call with `card_id`. It runs only if the card was approved, unused, unexpired, and the
   arguments, target and preview still match. A changed preview needs a new card.
5. **Audit.** "No", an expired card and a mismatch are audited. They are answered to the model as declined, with no retry
   advice.

## 7. First run (S4)

- **No workspace and no Claude:** Home shows the dashboard plus **one** card, "General Manager". It offers:
  - "Sign in to Claude" (the existing sign-in flow, run in the manager runtime, which S1 creates for that purpose); or
  - "Use an API key" (pasted once into a new Secrets & env secret; never shown again).

  Then **Enable**.
- **Enable** does the following:
  - creates the runtime if needed;
  - creates the `manager` session;
  - mints its token;
  - starts it with a first message from the portal (not the person) asking for a short status;
  - switches Home to Manager.
- **The person already has a signed-in Claude in a workspace:** the card offers to sign the runtime in the same way. A Claude's
  sign-in lives in its own home directory, so it is not copied **(default)**.
- **Enable fails:** the card says why, with one retry (for example: the runtime cannot be scheduled, the sign-in failed, or
  the API key was refused).

## 8. Limits

- **Rate (default):** at most 30 operate-tier write calls a minute and 300 an hour per manager. On top of that, each tool's
  own `rate` applies.
- **Mass actions (default):** a call or a run of calls that would end, stop or message more than 5 sessions, or change more
  than 5 workspaces, in 10 minutes needs a card (§6.1). This is the same idea as `confirmAbove` for workspaces.
- **Results:** short by default, as every Portal MCP result is (`compact.ts`).

## 9. Portal MCP coverage the manager needs (S2)

The tools it already has through the person's rights include:

- tickets: `ticket_*`;
- sessions: `session_list`, `session_get`, `session_family`, `session_send`, `session_message`, `session_start`,
  `session_end`, `session_interrupt`, `session_respond`;
- CI: `ci_*`;
- usage: `claude_usage*`, `usage_*`, `autotransfer_status`;
- `attention_list`;
- knowledge: `vault_list`, `note_*`, `graph_*`;
- repositories: `repos_*`, `repo_*`;
- `workspace_*`, `pool_*`, `account_*`, `monitor_overview`, `portal_status`, `audit_search`;
- triggers: `trigger_list`, `trigger_runs`.

S2 adds the following, in this order. Every new tool:

- is declared in the module's `authz.ts` and goes through the seam;
- gives the same not-found on a denial;
- has a test of its denial and of an agent token being refused where the tool is not for agents;
- sends text from outside through `ctx.untrusted`.

### 9.1 Reads first

| Tool | What it returns | Tier |
| --- | --- | --- |
| `settings_get` | The settings the person may see: values, where each came from, which need re-auth. Secrets are shown as set or missing only. | read (admin settings: admin-read) |
| `approvals_list` | Every open tool approval across the person's sessions (session, tool, input summary as untrusted, age), not only the ones over 10 minutes that `attention_list` shows. | read |
| `autotransfer_events` | Recent auto moves and the cards waiting (session, from, to, reason, when, undo-able). | read |
| `crew_limits_get` | The person's worker and sub-agent caps (D-43, D-71), the slots in use, and the queue. | read |
| `deploy_status` | Deploy runs: the stage, the gate result, whether the release waits for the person's approval, and a link. | read |
| `manager_status` | The manager's own state: runtime up, Claude, token expiry, cards open. | read |

**Built (T-968 S2a).** The first five tools are on the Portal MCP. The wire types are in `packages/contracts/src/manager.ts`. Each tool
lives in the module that owns its data and is declared in that module's `authz.ts`:

- `settings_get`: `settings/portalTools.ts`.
- `approvals_list` and `crew_limits_get`: `chat/managerTools.ts`.
- `autotransfer_events`: `autotransfer/portalTools.ts`.
- `deploy_status`: `ci/portalTools.ts`.

All five are `read` scope, so an agent's token never reaches them. A session or settings area the caller may not view answers exactly
like a missing one (NOT_FOUND). List rows go through `can()` one by one, a lead's workers included, and `approvals_list` counts
`total` after that filter (no SQL limit before it). Text from outside comes back labelled untrusted: titles, summaries and agent
labels, an approval's kind and tool name, an auto move's reason, code, actor and Claude names, and a deploy's pipeline, branch and
stage. A credential-shaped setting value or default reads `[set]`, and an empty one reads `[missing]`.

How the build differs from the table above:

- "Needs re-auth" is `needs_confirmation`: a protective setting whose change asks for a person's confirmation.
- `crew_limits_get` reads one lead session, given by `session_id`.
- `queue` is `"unavailable"`: the portal keeps no queue of slices. A lead's queue is its status file.
- `manager_status` waits for S1: there is no manager session or `cpmt_` token to report on yet.

### 9.2 Then the schedules API (T-965)

| Tool | What it does | Tier |
| --- | --- | --- |
| `schedules_list` | One list from `GET /api/schedules`: triggers, scheduled pipelines, the portal's loops, external helpers' heartbeats, with "stale" when a helper is late by 2 intervals. | read |
| `schedule_get` | One schedule with its recent runs. | read |
| `schedule_set_enabled` | Enables or disables a trigger or a scheduled pipeline. | operate |
| `schedule_run_now` | Runs one now (the trigger's own limits apply). | operate |

`POST /api/schedules/heartbeat` is for helpers with their own token, not for the manager.

**Built (T-968 S2b).** `GET /api/schedules` and `schedules_list` read one list (`apps/server/src/schedules/`, wire type
`ScheduleRow` in `packages/contracts/src/schedules.ts`):

- **Loops.** Each portal loop defines itself in `schedules/registry.ts` (`defineLoop`) and calls its heartbeat: `started`, `stopped`,
  and `ok` or `fail` after each pass. Six beat today: `orphan-sweep`, `triggers-cron`, `usage-probe`, `delivery-reconcile`,
  `version-canary`, `notify-clock`. A row has the module, interval, last run, last result, last error (credentials cleaned, 200
  characters at most) and next run. Kept in memory: a restart starts the loops again.
- **States.** `ok`; `failing` (the last pass failed); `stale` (running, but no beat, or no start, for more than two intervals; stale
  wins over failing); `stopped`; `disabled` (a trigger that is off or paused).
- **Cron triggers.** Expression, last and next time, and how the last run ended. A trigger's name comes back to the tool as untrusted
  text.
- **Scheduled pipelines.** Not listed: CI refuses `on: schedule` as "not yet", so none exist.
- **Who.** `view` on the platform's `system` area (admins), for the route and the tool. T-965 asked for a `schedules.read`
  permission, but the platform areas are a closed list and `system` already covers how the portal runs. Anyone else gets NOT_FOUND
  before the list is read.

Next slices:

1. `POST /api/schedules/heartbeat` with a helper's own token. The supervisor and other outside helpers appear once it exists.
2. The Schedules page (S3).
3. `schedule_get`, `schedule_set_enabled` and `schedule_run_now`.
4. The T-971 refusal watcher calls `defineLoop` when it lands; it is not on `integration` yet.
5. Loops without a heartbeat yet: secrets rotation, the delivery outbox, the account health check, the CI and repos timers, and the
   nightly backup.

### 9.3 Writes, behind the S5 card design

| Tool | What it does | Tier | Card (§6.1) |
| --- | --- | --- | --- |
| `settings_set` | Changes one setting. | admin | always; plus re-auth for the guarded settings |
| `approval_answer` | Answers an open tool approval. | operate (deny) / admin (allow) | allow: always; deny: no |
| `deploy_start` | Starts the deploy pipeline on a commit. It is a thin wrapper over the existing `ci_run_trigger` path for `.pilot/deploy.yml` (same service call, same checks, same run row); there is **no second start path**. | operate | yes (it leads to production). The release itself still waits for the portal approval. |
| `crew_limits_set` | Changes a cap. | admin | always |
| `autotransfer_answer` | Move or Later on an auto-move card. | operate | no |
| `note_write`, `note_edit`, `note_append` (exist) | Vault writes as the person. | operate | no; a note delete gets a card when a note delete tool exists |
| `session_end`, `session_stop_worker` (exist) | End sessions. | operate | over the mass limit (§8) |

No tool approves a release or a proposal (MCP server, skill, persona): that remains a click in the portal (`registry.ts` rule).
`ci_run_trigger` on `.pilot/deploy.yml` with a `cpmt_` token gets the same card as `deploy_start`, so the wrapper is not a way
around it.

### 9.4 Every write tool, its class and its card

The classes are those of §6: **P** production or uat, **R** release approval, **D** deleting data, **C** credentials, **G** guarded
by a deny rule, gate, approval or admin tier, **M** mass (§8). **—** means an ordinary operate write: no card, audited, rate
limited. "Agent only" tools refuse a `cpmt_` token (§4). New tools are marked *(new)*.

| Tool | Class | Card |
| --- | --- | --- |
| `workspace_delete` | D | yes |
| `pool_delete` | D | yes |
| `ticket_attachment_remove` | D | yes |
| `usage_budget_delete` | D | yes |
| `account_pool_assign` | C | yes |
| `pool_create`, `pool_update` on a Secrets & env pool | C | yes |
| `pool_create`, `pool_update` on any other pool | G (admin) | yes |
| `pool_assign`, `pool_unassign` | G (admin; a Secrets pool is also C) | yes |
| `mcp_lockdown` | G (re-auth setting) | yes, plus re-auth |
| `settings_set` *(new)* | G (admin) | yes, plus re-auth for the guarded settings |
| `approval_answer` *(new)* | G | allow: yes; deny: no |
| `crew_limits_set` *(new)* | G (admin) | yes |
| `deploy_start` *(new)*, `ci_run_trigger` on the deploy pipeline | P | yes |
| `usage_budget_set` | G (admin) | yes |
| `workspace_create` | G (admin) | yes |
| `workspace_resources`, `workspace_rename` | G (admin) | yes |
| `workspace_stop`, `workspace_start`, `workspace_sync` | M when over §8, else — | over the mass limit |
| `session_start`, `session_spawn` | M when over §8, else — (also Q11) | over the mass limit or the Q11 caps |
| `session_end`, `session_stop_worker`, `session_interrupt` | M when over §8, else — | over the mass limit |
| `session_send`, `session_message` | M when over §8, else — | over the mass limit |
| `session_respond` | G when it allows a tool request, else — | allow: yes; deny or answer: no |
| `session_configure` | G when it sets Bypass or a permission mode; else — | Bypass or mode: yes; else no |
| `session_recover` | — | no |
| `ci_run_trigger` (other pipelines), `ci_run_cancel`, `ci_run_bump` | — | no |
| `ticket_create`, `ticket_update`, `ticket_comment`, `ticket_attach`, `ticket_claim_next`, `ticket_adopt`, `ticket_bump`, `ticket_start_session` | — | no |
| `ticket_close`, `ticket_verdict`, `ticket_update` to `done` or `wont_do` or out of a closed status | refused (#11136 b) | no: a manager is not a QA session, so `canRecordVerdict` refuses its verdict and the service refuses its close, and its update that would close or reopen a ticket (`FORBIDDEN`); other updates stay open to it; a ticket it cannot see stays the same `NOT_FOUND` |
| `note_write`, `note_edit`, `note_append`, `daily_append` | — | no |
| `session_keepgoing_set`, `keepgoing_pause_set` | — | no |
| `lab_experiment_set`, `lab_arm_draw` | — | no |
| `autotransfer_answer` *(new)* | — | no |
| `schedule_set_enabled`, `schedule_run_now` *(new)* | — | no |
| `skill_propose`, `mcp_propose_entry`, `mcp_proposal_withdraw` | — (a proposal; approving it stays a portal click) | no |
| `artifact_publish` | — | no |
| `session_rename_self`, `session_request_clear`, `persona_propose_update`, `persona_set_avatar_proposal`, `worktree_create` | agent only | refused |

**A test keeps this table true** (a done criterion, §13): S2 adds a test that walks every tool in the registry without
`hints.readOnly` and fails when one has no class here (in code: a `MANAGER_WRITE_CLASS` map next to the tool policies); S5
extends it to assert that each class P, R, D, C and G answers a `cpmt_` call with `person_confirmation_required`.

## 10. Audit and observability

- Every manager call writes the usual Portal MCP audit row, with the person, `agent=manager`, the tool, the target, the
  outcome and, when there was one, the card id.
- Cards have their own rows: issued, approved, declined, expired, mismatched.
- Usage is attributed to the person and to `agent=manager` (Usage spend §21).

## 11. Security points for the S5 blind review

1. **Token confinement.** `cpmt_` exists only in the runtime process's environment: never in a file, a log, the transcript,
   a response or an audit row. It is hashed at rest, revoked on disable, remove and sign-out, and expires after at most 7 days.
2. **Identity at use time.** Each call resolves the person's rights through `can()` at that moment, with the person's user
   actor (`manager:<id>` is an audit label only). There is no cached grant. A person who loses access to an object has a
   manager that loses it too, and it gets the same not-found. Review the `actorOfPrincipal` change in `authz/seam.ts` (§4).
3. **No browser authority.** `cpmt_` cannot reach a web route, and the cookie cannot reach `/mcp`. The confirm endpoint takes
   only the cookie session, with CSRF and the class's re-auth. Test: the manager posting its own approval is refused.
4. **The card cannot be forged by the model.**
   - The card is a system item, not model text. The model's own text that imitates a card has no buttons.
   - A card is single use and bound to the arguments, the target and the preview, and it expires.
   - Test: approve card A, then call with card A and other arguments; the call is refused.
5. **No release or proposal approval through MCP**, whatever the token. Test: every tool is enumerated, and none approves.
6. **Runtime escape surface.**
   - The built-in tools are denied by managed settings and launch flags (test: a live refusal of Read and Bash).
   - The pod has no service-account token (`automountServiceAccountToken: false`), drops all capabilities, runs as non-root
     and has no host mounts.
   - The egress policy allows only the portal's internal URL and the model API.
7. **Hidden, not just unlisted.**
   - The manager's workspace and session are absent from every list and give the same not-found to anyone else.
   - No workspace or agent tool can reach the manager runtime: no `session_send` to it from an agent, no `workspace_*` on it.
8. **Prompt injection from data.**
   - Every result carries text from outside as `untrusted_text`.
   - The persona forbids acting on instructions found in data.
   - Guarded classes need a card whatever the model believes.
   - Test: a ticket body that asks the manager to change a setting or deploy produces a card or a refusal, never the action.
9. **Mass actions and rates.** The limits of §8 are enforced on the server, not in the persona. Test: ending 6 sessions in a
   run asks for a card at the sixth.
10. **One per person.** This is enforced by the unique index. Enabling twice at the same time makes one session.
11. **Secrets.** The API-key path stores the key as a Secrets & env secret delivered only into this runtime. `settings_get`
    and `manager_status` never return a secret value.
12. **Audit completeness.** Every write and every card outcome has a row with the person and `agent=manager`, and the row
    never contains a secret.

## 12. Slices

| Slice | What | Who | Depends on |
| --- | --- | --- | --- |
| S0 | This PRD | scribe / implementer | D-80 |
| S1 | `kind` column and unique index (chat migration set), the hidden runtime, the `cpmt_` token and principal, Claude sign-in or key, auto move | BE Infra | S0; NetworkPolicy FOR THE COORDINATOR |
| S2 | §9.1 reads, §9.2 schedules (with T-965), then §9.3 writes; the §9.4 classification test | Backend | S0; §9.3 waits on S5's card |
| S3 | Home first, Dashboard / Manager switch, Manager mode | Frontend | S1 |
| S4 | First-run card and Enable | Frontend + Backend | S1, S3 |
| S5 | Confirmation cards, server limits, untrusted framing check, audit, blind security review (D-60) | Backend + reviewer | S1, S2 |
| S6 | The coordinator's routine as the manager's skills | Orchestrator | S2, S5 |

**Built (T-968 S1, identity part).**
- Migration 793 (chat set) adds `chat_sessions.kind` (`'workspace'` or `'manager'`, CHECK), `owner_id` (default `'u_owner'`), the unique
  index `chat_sessions_one_manager` on `(owner_id) WHERE kind = 'manager'`, and the `pmcp_manager_tokens` table.
- `cpmt_` tokens live in `portalmcp/managers.ts` (`ManagerTokens`): minted per manager session (a new mint revokes the older ones), sha256
  at rest, 7 days (`AGENT_TOKEN_TTL_MS`), refused once the session ended.
- They are revoked on session end, archive or delete (index.ts), on a lockdown, and by `Portal.onSignedOut` whenever a session of the person
  ends on any device (sign-out, `revokeUser`, `rotate`; Q3, #11136), even with another device still signed in.
- `/mcp` accepts them (`server.ts #verify`). The principal is `kind: 'manager'` with the person's `userId`; `actorOfPrincipal` gives can()
  the person's user actor. `ctx.actor` is `manager:<session id>` and the label "General Manager"; `isAgent` is false and `ctx.sessionId`
  and `ctx.workspaceId` are null.
- The five agent-self tools are not offered and are refused (`AGENT_SELF_TOOLS`).
- The tool tier is `operate` until S5's confirmation card, so an admin-tier tool is refused **(default)**.
- `cpmt_` is in the transcript redactor and the delivery token pattern. Web routes read only the session cookie, so they never accept it.
- Tests: `portalmcp/managers.test.ts` and `qa/managerWeb.test.ts`.
- Not in this part: the hidden runtime (§3), Claude sign-in, auto move, the hiding from lists, and `session_start`/`session_spawn`
  refusing `kind: 'manager'` (no tool takes a kind today).

## 13. Done when (from T-968)

- On a clean portal, Home shows the dashboard and the enable card.
- After a Claude sign-in and Enable, Manager mode opens a chat that:
  - answers "what are my crews doing and what is blocked" from live data;
  - opens a ticket and messages a lead;
  - starts a deploy that waits for the person's release approval.
- It cannot read a workspace file or run a shell command: tests, and a live refusal.
- Every write tool in the registry has a class in §9.4: a test fails on an unclassified one (S2), and each guarded class
  answers a `cpmt_` call with a card (S5).
- `can()` gets the person's actor for a manager call, and the session start caps of Q11 hold: tests (S1, S5).
- QA screenshots at 390 and 1280 px, light and dark. The blind security review passes.

## 14. Open questions, each with its default

1. **Runtime volume and resources:** 1 Gi home; 100m and 256 Mi requested, 1 CPU and 1 Gi limit **(default)**.
2. **Persona editable by the person?** No in v1. Only the built-in `general-manager` persona and the S6 skills **(default)**.
3. **Token revoked on sign-out?** Yes, on ANY sign-out of the person, on any device, not only the last one **(decided, v0.2;
   the safer reading, lead #11136 on T-968, settles §4 against §12)**. The manager stops; Home shows Resume at the next sign-in.
4. **Does the manager run while nobody is signed in?** No: after sign-out it has no token, so it cannot call the portal
   **(decided, v0.2; this replaces v0.1's answer, which contradicted Q3)**. S6's routine work that must run on a clock
   (monitoring sweeps, reminders) runs on a **separate scheduled path**: the triggers and the schedules registry (T-965,
   §9.2), each run under its own system actor with its own narrow grant and its own audit rows. It never borrows the
   manager's `cpmt_` token and never wakes the manager session to act. Its findings wait in tickets and attention items, and
   the manager reads them at the next sign-in.
5. **Admin-tier reads** (audit, settings): allowed when the person is an admin; no card **(default)**.
6. **Operate-tier writes without a card**: allowed within the §8 limits; cards for the guarded classes only, per D-80 (5)
   **(decided by the lead on T-968, v0.2)**. The owner may ask for a card on every write, on T-968.
7. **Mass-action threshold:** 5 objects in 10 minutes **(default)**.
8. **Docker target:** the runtime is built for k3s first, and Docker follows when someone asks **(default)**.
9. **Multi-user:** one manager per account (`owner_id`). Today there is one owner (`u_owner`), so there is one manager
   **(default)**.
10. **Coordinator overlap (D-80 (6)):** both run until S6 lands. The manager does not take the coordinator's jobs before then
    **(default)**.
11. **Session start or spawn by the manager** (`session_start`, `session_spawn`): each starts a Claude process that spends
    the person's quota. Default: at most **10 an hour and 50 a day** per manager, enforced on the server, on top of the §8
    mass limit (more than 5 in 10 minutes needs a card) and the crew caps (D-43). Over a cap the call answers
    `person_confirmation_required` **(default)**.
