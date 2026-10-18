# The General Manager

Draft v0.1 (T-968 S0, 2026-10-17). Source: the owner's request on T-968 and decision D-80 (`docs/dev-sessions/DECISIONS.md`).
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
  revoked on disable, on remove and when the person signs out of every device **(default)**.
- **Principal:**

  ```ts
  { kind: 'manager', userId, sessionId, workspaceId: null }
  ```

  - `ctx.actor` is `manager:<sessionId>` and `actorLabel` is "General Manager".
  - Audit rows carry the person and `agent=manager`.
- **Authorization is the person's, resolved at use time.**
  - Every call goes through the same `can(actor, verb, object)` with the actor being the person. The manager never sees or
    does more than the person could in the browser right now. If the person loses a grant, the manager loses it on the next
    call.
  - A denial is the same not-found.
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

These stay the person's decision. The manager asks in the same chat, and the person answers there with a tap, never by typing
"yes":

1. Production, and uat. uat happens only on the owner's request (D-79), and then the request is the person's own message.
2. A deploy **release approval**. The manager may start a deploy, but the release waits for the person's approval in the
   portal, as today. No Portal MCP tool can approve a release, whatever the token.
3. Deleting data: a workspace, a pool, a vault, a note, a ticket's attachment, the manager itself.
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
  characters at most; the tool returns it as untrusted text, source `loop`) and next run. Kept in memory: a restart starts the loops
  again.
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
| `deploy_start` | Starts `.pilot/deploy.yml` on a commit. | operate | yes (it leads to production). The release itself still waits for the portal approval. |
| `crew_limits_set` | Changes a cap. | admin | always |
| `autotransfer_answer` | Move or Later on an auto-move card. | operate | no |
| `note_write`, `note_edit`, `note_append` (exist) | Vault writes as the person. | operate | delete only |
| `session_end`, `session_stop_worker` (exist) | End sessions. | operate | over the mass limit (§8) |

No tool approves a release or a proposal (MCP server, skill, persona): that remains a click in the portal (`registry.ts` rule).

## 10. Audit and observability

- Every manager call writes the usual Portal MCP audit row, with the person, `agent=manager`, the tool, the target, the
  outcome and, when there was one, the card id.
- Cards have their own rows: issued, approved, declined, expired, mismatched.
- Usage is attributed to the person and to `agent=manager` (Usage spend §21).

## 11. Security points for the S5 blind review

1. **Token confinement.** `cpmt_` exists only in the runtime process's environment: never in a file, a log, the transcript,
   a response or an audit row. It is hashed at rest, revoked on disable, remove and sign-out, and expires after at most 7 days.
2. **Identity at use time.** Each call resolves the person's rights through `can()` at that moment. There is no cached grant.
   A person who loses access to an object has a manager that loses it too, and it gets the same not-found.
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
| S2 | §9.1 reads, §9.2 schedules (with T-965), then §9.3 writes | Backend | S0; §9.3 waits on S5's card |
| S3 | Home first, Dashboard / Manager switch, Manager mode | Frontend | S1 |
| S4 | First-run card and Enable | Frontend + Backend | S1, S3 |
| S5 | Confirmation cards, server limits, untrusted framing check, audit, blind security review (D-60) | Backend + reviewer | S1, S2 |
| S6 | The coordinator's routine as the manager's skills | Orchestrator | S2, S5 |

## 13. Done when (from T-968)

- On a clean portal, Home shows the dashboard and the enable card.
- After a Claude sign-in and Enable, Manager mode opens a chat that:
  - answers "what are my crews doing and what is blocked" from live data;
  - opens a ticket and messages a lead;
  - starts a deploy that waits for the person's release approval.
- It cannot read a workspace file or run a shell command: tests, and a live refusal.
- QA screenshots at 390 and 1280 px, light and dark. The blind security review passes.

## 14. Open questions, each with its default

1. **Runtime volume and resources:** 1 Gi home; 100m and 256 Mi requested, 1 CPU and 1 Gi limit **(default)**.
2. **Persona editable by the person?** No in v1. Only the built-in `general-manager` persona and the S6 skills **(default)**.
3. **Token revoked on sign-out of every device?** Yes **(default)**. The manager stops; Home shows Resume at the next sign-in.
4. **Does the manager run while nobody is signed in?** Yes, like any session, until idle sleep. S6 (monitoring) needs it
   awake on a schedule, through T-965's loops **(default)**.
5. **Admin-tier reads** (audit, settings): allowed when the person is an admin; no card **(default)**.
6. **Operate-tier writes without a card**: allowed within the §8 limits **(default)**. The owner may ask for a card on every
   write.
7. **Mass-action threshold:** 5 objects in 10 minutes **(default)**.
8. **Docker target:** the runtime is built for k3s first, and Docker follows when someone asks **(default)**.
9. **Multi-user:** one manager per account (`owner_id`). Today there is one owner (`u_owner`), so there is one manager
   **(default)**.
10. **Coordinator overlap (D-80 (6)):** both run until S6 lands. The manager does not take the coordinator's jobs before then
    **(default)**.
