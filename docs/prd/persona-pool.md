# PRD: Persona pool

| | |
| --- | --- |
| Status | **Draft v0.6** (consistency pass: session-start record, hooks, model variables, MCP tool names and Chat sessions references aligned). Written from research on the Claude Code 2.1.296 and Agent SDK docs. ✅ marks come from the cross-pool lab (print mode); no persona delivery is sandbox-verified yet. Items marked 🔬 need a sandbox check before anything is built on them. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-10 |
| Depends on | [Pools foundation](foundation-pools.md) (storage, revisions, delivery engine, outbox); [Chat sessions](chat-sessions.md) (session runner, for the chat prompt and test prompts only) |
| Related | [Settings & policies](settings-policies.md) (permissions, allowed models, effort cap), [Account Pool](account-pool.md) (model names per endpoint), [Monitoring dashboard](monitoring-dashboard.md) (session-start hook), [Portal MCP server](portal-mcp.md), [Skillset pool](skillset-pool.md), [MCP set pool](mcpset-pool.md), [Secrets & env](secrets-env-pool.md) |

## 1. Summary

A persona is a reusable bundle of what Claude is told and how a session starts: instructions,
output styles, subagents, a default model and effort, and a prompt for portal-run chat sessions.
Admins write and version personas in the portal and assign one to each workspace.

Every part reaches Claude Code through files it reads itself: the managed CLAUDE.md, managed style
and subagent files, managed settings keys and, for portal chat sessions, a prompt file the runner
appends to the system prompt. A persona adds to the repository's and the user's CLAUDE.md and never
replaces them. It changes what Claude is told, never what Claude may do. Most parts apply when a
session starts, so the portal shows when each applies and which sessions run an older revision.

## 2. Background and problem

- Giving Claude a role in a workspace (reviewer, on-call engineer, docs writer) means pasting text
  into its `~/.claude/CLAUDE.md` or a repository by hand. Copies drift, and there's no history.
- Claude Code has five levers with different positions and timing: CLAUDE.md text (context after
  the system prompt, loaded at launch), output styles (system prompt, read at startup), subagents
  (own prompts), `model` and `effortLevel` (read at session start), and system prompt flags
  (recorded per conversation). Getting them right by hand, per workspace, is error-prone.
- Repositories bring their own CLAUDE.md, rules, AGENTS.md and subagents, and a persona must work
  with them. Portal chat sessions need the same persona, plus a layer only the runner can set.

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Reusable personas.** Create, edit, duplicate and archive personas. One persona per workspace, assigned at creation or later, without recreating the workspace. |
| G2 | **Native delivery.** Every part reaches Claude Code through its own files and settings keys, on DinD, host Docker and Kubernetes, including stopped workspaces. |
| G3 | **Additive.** Persona text is added to the user's and the repository's instructions. They keep loading unless an admin picks "persona only" (§12.2). |
| G4 | **Honest timing.** For each part, the portal shows when it applies (next message, next session, new or resumed conversation) and which sessions started on an older revision. |
| G5 | **Preview.** Show what Claude will be told in a given workspace, in load order, before assigning or publishing, without reading the secrets the workspace holds. |
| G6 | **Safe change.** Drafts, a test on one workspace, publish, diff, one-step rollback, per-workspace pinning. |
| G7 | **Clear boundary.** A persona shapes what Claude is told and starts with. Settings & policies decides what Claude may do. |

## 4. Non-goals

- **Replacing Claude Code's system prompt** (`--system-prompt`, the `agent` setting): it drops
  Claude Code's own engineering and tool-use instructions (Q12). `CLAUDE_CODE_SIMPLE` also turns
  off CLAUDE.md discovery and hooks.
- **The chat prompt in terminals.** No documented settings key appends to the system prompt, and
  wrapping the `claude` binary to add flags is fragile and invisible.
- **What Claude may do, and enforcing instructions** (§6). Skills, MCP servers, env and secrets
  belong to their pools.
- **Writing into the user's home or a repository**, restarting sessions, and fetching personas
  from URLs or marketplaces.
- **Several personas per workspace,** and per-workspace or per-conversation overrides. Managed files
  apply to every session in a workspace; roles within one are subagents.

## 5. Users and stories

**Admin**: manages personas and workspaces. **Workspace user**: runs `claude` in a terminal or chat.

| ID | Story |
| --- | --- |
| US1 | As an admin, I write a persona with instructions, a default model and effort, and assign it to several workspaces. |
| US2 | As an admin, I add an output style for tone and format, and decide whether it's the workspace default or one users can pick. |
| US3 | As an admin, I add subagents (for example `security-reviewer`, `test-writer`), each with its own prompt, tools, model and effort. |
| US4 | As an admin, I see what Claude will be told in a workspace, including the repository's CLAUDE.md, before I assign or publish. |
| US5 | As an admin, I save a draft, try it on one workspace, publish it, and roll it back in one step if it goes wrong. |
| US6 | As a workspace user, my repository's CLAUDE.md and my own `~/.claude/CLAUDE.md` still load. The persona adds to them. |
| US7 | As a workspace user, I can still switch model and effort in my session. The persona only sets where sessions start. |
| US8 | As a chat user, new conversations get the persona's chat prompt. A conversation I resume keeps the prompt it started with until it's compacted. |
| US9 | As an admin, after publishing I see which sessions started on an older revision, and know they pick up the change when restarted. |
| US10 | As a workspace user, I can see which persona and revision my workspace runs, read-only. |

## 6. Scope boundary: persona vs Settings & policies

| Persona decides | Settings & policies decides |
| --- | --- |
| What Claude is told: instructions, chat prompt | What Claude may do: permission rules, `permissions.defaultMode`, Bypass policy |
| How Claude writes: output styles | Sandbox and network rules |
| Which subagents exist: prompt, tool list, model, effort, turn limit | Whether a subagent may run: `Agent(name)` deny rules, added as custom deny rules. Subagents run in the session's permission mode; per-subagent modes are out of scope in v1. |
| Where sessions start: default model and effort | Allowed models (`availableModels`), effort cap (`maxEffortLevel`), ultracode, budgets, concurrency |

1. **Instructions are guidance, not controls.** CLAUDE.md text arrives as a user message after the
   system prompt ([memory](https://code.claude.com/docs/en/memory)). Whatever must not happen is a
   Settings & policies rule, and the editor says so next to the instructions field. Managed files
   aren't a lock either: users have `sudo`, and the reconciler repairs what they change.
2. **A persona can't widen access.** It writes no `permissions.*`, `sandbox.*`, MCP, skill, `env` or
   `agent` keys, and its subagents never carry `permissionMode`, `hooks`, `mcpServers` or `skills`.
   The foundation's ownership check ([§7](foundation-pools.md)) rejects anything else.
3. **Policy wins conflicts, visibly.** Outside the workspace's `availableModels`, the persona model
   is left out and a subagent `model` becomes `inherit`, each with a warning. Effort above
   `maxEffortLevel` runs at the cap (Claude Code clamps it), and the portal shows the effective
   level ("high, runs at medium"). These values are compile inputs (A7).

## 7. Solution overview

```
 Portal                                   Workspace (any target)
 ┌────────────────────────────┐ push via ┌───────────────────────────────────────────────┐
 │ Personas and revisions     │ runtime  │ /etc/claude-code/CLAUDE.md                    │
 │ Compiler: policy, models,  │ ───────▶ │ /etc/claude-code/managed-settings.d/          │
 │   Claude Code version      │   API    │   50-claudepilot-persona.json                 │
 │ Preview, tests, history    │          │ /etc/claude-code/.claude/output-styles/*.md   │
 │ Session reports            │ ◀─────── │ /etc/claude-code/.claude/agents/*.md          │
 └────────────────────────────┘ outbox,  │ /etc/claudepilot/persona/chat-prompt.md       │
                                exec     │ claude (terminal) · claude -p (chat sessions) │
                                         └───────────────────────────────────────────────┘
```

Each save is an immutable revision, a draft until published. The compiler turns a workspace's
revision into files, checked against policy, the endpoint and the Claude Code version (A7). The
foundation delivers them (§10), and hooks report each session's revision (§11).

## 8. Functional requirements

### Personas

- **FR1** A persona has a name (unique, up to 60 characters), a description, and optional parts:
  instructions, instruction sources, output styles with a default, subagents, default model and
  effort, chat prompt, test prompts. An empty persona is valid and changes nothing.
- **FR2** Instructions: Markdown, delivered as the managed CLAUDE.md (§10). Line and token counter;
  warn above 200 lines (Claude Code's guidance per file); refuse over 100 KB.
- **FR3** Output styles: up to 5, each with a name (letters, digits, hyphens; starts with a letter;
  up to 40 characters), description, "keep Claude Code's coding instructions" (on by default) and
  body. The default style is one of them, or none, in which case users keep choosing their own.
- **FR4** Subagents: up to 20, each with a name (lowercase letters, digits, hyphens), a required
  description, prompt, tools (empty inherits all), disallowed tools, model (`inherit`, alias or ID),
  effort and max turns; nothing else (§6 rule 2). Warn when descriptions pass 5,000 tokens together
  (Claude Code warns at 15,000). Publishing warns when a removed or renamed subagent is a skill's
  `agent` in an assigned workspace ([Skillset](skillset-pool.md) §12).
- **FR5** Defaults: model is "Claude Code default", an alias (per the workspace's Claude Code
  version; on custom hosts only `opus`, `sonnet` and `haiku`, the Account Pool slots, with other
  families such as Fable as IDs) or a model ID. Effort is "model default" (medium on Opus, Sonnet
  and Haiku 5.5, xhigh on Opus 4.7, high on most others;
  [model config](https://code.claude.com/docs/en/model-config)) or `low` to `xhigh`. No `max`
  (`effortLevel` refuses it); ultracode is a Settings & policies switch (its §11.2).
- **FR6** Chat prompt: appended to the system prompt of portal-run chat sessions only (§10.3). Warn
  above 2,000 tokens; refuse over 32 KB.
- **FR7** Instruction sources: default, also AGENTS.md, CLAUDE.md only, or persona only (§12.2).
- **FR8** Secret guard: saving, importing and restoring refuse known credential patterns
  (Anthropic, GitHub, AWS, Slack and Google keys, private key blocks).
- **FR9** Duplicate; archive and restore (§14); import from files or from a workspace (§10.4);
  export the generated files as a zip.

### Assignment and delivery

- **FR10** One persona per workspace, or none: chosen in the create dialog (the "default for new
  workspaces" persona preselected), later from the Configuration panel, or in bulk. Only personas
  with a published revision can be assigned.
- **FR11** Unassigning removes every persona file and key. Running sessions keep instructions, model
  and effort until restart; the default style may revert from the next message, and subagents
  disappear at once if Q3 holds. The confirmation says so.
- **FR12** The compiler writes only the paths and keys in §10, generates YAML frontmatter with a
  serializer, validates names and values, and applies §6 rule 3 and §10.2. The foundation handles
  delivery, drift and rollout on all targets.

### Preview, testing and versions

- **FR13** Preview in the editor and per workspace (§13.1). Test a draft on one workspace (§13.2).
- **FR14** Drafts with a note, publish, stop a rollout, diff, restore, and pinning a workspace to a
  revision (§14). Saving against an outdated base revision returns 409 with the diff.
- **FR15** Session reports: the revision each session started on and the instruction files it
  loaded (§11), shown per workspace as "Sessions (24 h): 3 on r4, 1 on r3 · 1 resumed on r3".

## 9. Data model

Stored with the foundation's `pools` (type `persona`), `pool_revisions` and `assignments`. Personas
hold no secrets, so they can be edited and previewed while the portal is Locked; nothing is
delivered until it unlocks (foundation §6.5). Content:

| Field | Type | Notes |
| --- | --- | --- |
| `instructions` | string or null | Markdown, at most 100 KB |
| `instruction_sources` | enum | `default`, `with_agents_md`, `claude_md_only`, `persona_only` |
| `styles` | list | `name`, `description`, `keep_coding_instructions`, `body` |
| `default_style` | string or null | A name from `styles` |
| `agents` | list | `name`, `description`, `prompt`, `tools[]`, `disallowed_tools[]`, `model`, `effort`, `max_turns` |
| `model`, `effort` | string or null | Alias or model ID; `low` to `xhigh` |
| `chat_prompt` | string or null | At most 32 KB |
| `test_prompts` | list | `id`, `prompt`, `note` (up to 10) |

| Table | Key fields |
| --- | --- |
| `persona_tests` | id, pool_id, revision, workspace_id, previous_assignment (json), started_by, started_at, ends_at (default +24 h), ended_at, end_reason (`ended`, `expired`, `assignment_changed`) |
| `persona_test_runs` | id, test_id, prompt_id, chat_session_id, with_chat_prompt, started_at, finished_at, status, model, input_tokens, output_tokens, cost_usd (null when unknown), files_loaded (json), error (redacted). The response lives in Chat sessions (its §9). Rows kept 14 days. |
| `persona_sessions` | workspace_id, session_id, pool_id, revision (from the start record only), source (`startup`, `resume`, …), started_at, last_compact_at, instruction_files (json: memory type, path, load reason). Rows kept 30 days. |

`pools.default_for_new` and `pools.archived_at` come from A5. Retention is edited in
[Settings & policies](settings-policies.md) §11.4 (§20).

## 10. Delivery into Claude Code

### 10.1 What gets written

| Path in the workspace | Content |
| --- | --- |
| `/etc/claude-code/CLAUDE.md` | The instructions. The documented managed CLAUDE.md: it loads first, and `claudeMdExcludes` can't exclude it ([memory](https://code.claude.com/docs/en/memory)). Absent when empty. |
| `/etc/claude-code/managed-settings.d/50-claudepilot-persona.json` | Only the keys the persona sets: `outputStyle` (default style), `model`, `effortLevel`, `pluginConfigs` for instruction sources (§12.2), and a `hooks.InstructionsLoaded` entry (plus a `hooks.SessionStart` entry until A6 lands, §11) running `/etc/claudepilot/bin/persona-event` with `async: true`, as Monitoring does for its hooks (its §10.1). |
| `/etc/claude-code/.claude/output-styles/<name>.md` | One per style. Frontmatter `name` (equal to the file name, so selection matches either way), `description`, `keep-coding-instructions`; then the body. |
| `/etc/claude-code/.claude/agents/<name>.md` | One per subagent. Frontmatter `name`, `description`, `model`, `effort`, `maxTurns`, and `tools` and `disallowedTools` only when non-empty (left out, a subagent inherits every tool); the prompt is the body. |
| `/etc/claudepilot/persona/chat-prompt.md` | The chat prompt, read by the session runner (§10.3). Absent when empty. |
| `/etc/claudepilot/bin/persona-event` | Persona's own script (each pool type owns its `bin/` prefix, foundation §7). Appends one line per event, with an `id`, to `~/.claudepilot/outbox/persona.jsonl` (foundation §8) and prints nothing, since hook output can reach Claude's context. |

Files are mode `0644`: root-owned on Docker, group-owned through `fsGroup` on Kubernetes
(foundation §6.2).

Why each choice:

- **The managed CLAUDE.md file, not the `claudeMd` key:** the file is the documented managed
  location; `claudeMd` is documented only for `managed-settings.json`, though it worked from a
  drop-in in the cross-pool lab ✅ (shown as organization-managed policy, and replaced from the next
  turn when edited). The foundation
  delivers `/etc/claude-code` on every target (its §6.2). The file keeps 100 KB of Markdown out of
  JSON, `InstructionsLoaded` can report it by path, and "persona only" loads it.
- **Managed folders, not a plugin:** no dependency on the portal marketplace (foundation Q1) or
  `/reload-plugins`, at the cost of shadowing (§12.3).
- **Settings keys, not variables:** a managed `model` is a default, not a lock
  ([managed settings](https://code.claude.com/docs/en/managed-settings)). The variable
  `CLAUDE_CODE_EFFORT_LEVEL` would be one, since it outranks `/effort`
  ([model config](https://code.claude.com/docs/en/model-config)).
- **Aliases over IDs:** on a custom host, `opus`, `sonnet` and `haiku` resolve through Account
  Pool's slot names (verified in its sandbox). An ID missing from an assigned workspace's endpoint
  model list (A7) blocks publishing; without a list, it warns. A workspace assigned later gets the
  persona without that model, plus an error, so the model never causes "Model unavailable".

### 10.2 Write order, limits and versions

1. Instructions, style and subagent files go before the drop-in that names the default style; when
   removing, the drop-in goes first (foundation §6.4).
2. The managed `agents` and `output-styles` folders always exist, even empty (A4): Claude Code
   watches an agents folder only if it existed at session start. `output-styles` is created for
   consistency; terminals read styles only at startup.
3. A compiled persona is capped at 256 KB, well under the 1 MiB Secret all pools share.
4. Every part is documented for 2.1.296, the foundation's minimum (its §9), so supported workspaces
   get all of it. The version stays a compile input: an update recompiles at the next reconcile.

| Part | First version | Below it |
| --- | --- | --- |
| Drop-ins (managed CLAUDE.md and `model` are older) | 2.1.83 | The workspace is Unsupported (foundation §9) |
| Managed styles and subagents, `effortLevel`, subagent `effort`, `InstructionsLoaded`, chat prompt flag | 2.1.296 or earlier (Q16) | Only if foundation Q8 lowers its minimum: left out, with "Needs Claude Code x · Update Claude Code" |
| Instruction sources | 2.1.277 as `agents-md@builtin`; `cc-plugin-agents-md@builtin` from 2.1.285 | The option is disabled, with the version |
| Audit (`/doctor prompt-audit`) | 2.1.283 | Hidden |

### 10.3 Portal-run sessions (contract with [Chat sessions](chat-sessions.md))

Chat sessions run the unmodified CLI as `claude -p` in stream-json mode, through its `cp-session`
host (Chat sessions §10.2 and its A8). Print mode loads Claude Code's own prompt and the user,
project and local settings by default, so the runner adds only:

| Persona part | At every launch, resume and wake |
| --- | --- |
| Chat prompt | `--append-system-prompt-file /etc/claudepilot/persona/chat-prompt.md` when the file exists, so only the path is in argv |
| Model and effort | `--model` and `--effort` only when the user picked them. The picker starts at the persona default and shows any policy clamp. |
| Revision | Recorded in the session's `meta.json` and `chat_sessions.launch` (Chat sessions §9) |

- Terminal sessions never get the chat prompt. The runner never passes `--bare` or
  `--system-prompt`, which would drop or replace persona parts.
- Sessions sleep after 30 idle minutes and resume on the next message (Chat sessions FR38), so most
  chat conversations follow §11's Resumed column. A resumed conversation keeps the system prompt
  recorded on its first request until compaction
  ([CLI reference](https://code.claude.com/docs/en/cli-reference)). The runner doesn't pass
  `--system-prompt-snapshot off` by default (Q11).
- 🔬 Q14: does a `-p` session load the same instruction files, styles and subagents as a terminal,
  also in a folder whose trust dialog was never accepted? P5 waits on it.

### 10.4 Existing workspaces

1. **Delivery** follows foundation §6.6 ("Enable pools" once on Kubernetes). The first delivery
   creates the managed folders (A4).
2. **Running sessions** never see a new assignment. The Persona row lists sessions that started
   before it, from session reports and [Monitoring](monitoring-dashboard.md) ("2 sessions started
   before this persona; restart them to apply it").
3. **Duplicate text.** Role text users pasted into `~/.claude/CLAUDE.md` (§2) loads twice once a
   persona carries it. The workspace preview flags paragraphs that appear in both.
4. **Import from workspace** seeds a draft from `~/.claude/CLAUDE.md`, `~/.claude/agents/*.md` and
   `~/.claude/output-styles/*.md`, read as in §16 and checked by FR8. User files never change (§4).

## 11. When changes take effect

| Part | Running session | New session or conversation | Resumed conversation |
| --- | --- | --- | --- |
| Instructions (managed CLAUDE.md) | Not applied: CLAUDE.md loads at launch ([memory](https://code.claude.com/docs/en/memory)). 🔬 Q2 | Applied | 🔬 Q15 |
| Instruction sources | Not applied: read at launch | Applied | 🔬 Q15 |
| Default style (`outputStyle`) | From the next message, if that style's file was loaded when the session started ([output styles](https://code.claude.com/docs/en/output-styles)). That request is uncached. | Applied | 🔬 Q15 |
| Style file content | Not applied: terminals read style files at startup | Applied | 🔬 Q15 |
| Subagents | 🔬 Within seconds if Claude Code watches the managed agents folder (Q3); otherwise not applied ([subagents](https://code.claude.com/docs/en/sub-agents)) | Applied | 🔬 Q15 |
| Default model and effort | Not applied: read once per session ([settings](https://code.claude.com/docs/en/settings)). Users switch with `/model` and `/effort`. | Applied | 🔬 Q15 |
| Chat prompt | Not applied: recorded per conversation | Applied | Kept until compaction ([CLI reference](https://code.claude.com/docs/en/cli-reference)) |

A resumed conversation is `claude --resume` in a terminal, or a chat session waking from its idle
sleep (§10.3). Sessions started with `--bare` or `CLAUDE_CODE_SIMPLE` skip CLAUDE.md discovery
and hooks, so they get little or none of the persona and report nothing (Unknown; 🔬 Monitoring Q4).

**Session reports.** 🔬 Field names, load reasons and `source` values to confirm (Q7). Each session
gets one start record with the manifest's persona revision, from A6's shared `session-event` or,
until A6 lands, a persona `SessionStart` entry (hook arrays merge across drop-ins ✅, cross-pool
lab; Monitoring A3). Its `source`
marks resumed sessions. `persona-event` also handles `InstructionsLoaded`, which no other owner
claims, and records memory type, load reason and path, never content. A session's revision comes
only from its start record. A `compact` record changes it only if Q2 confirms the managed CLAUDE.md
is re-read and the event lists it; otherwise it only sets `last_compact_at`. Reports give sessions
in the last 24 hours by revision, a "Loaded" status next to "Synced", and the preview check.

## 12. Coexisting with repository and user instructions

### 12.1 Load order

Claude Code concatenates every instruction file; nothing replaces anything
([memory](https://code.claude.com/docs/en/memory)):

1. **Managed:** the persona's text. `claudeMdExcludes` can't exclude it.
2. **User:** `~/.claude/CLAUDE.md`, then `~/.claude/rules/*.md`.
3. **Project:** `CLAUDE.md`, `.claude/CLAUDE.md` and `.claude/rules/*.md` without `paths`
   frontmatter, in the launch folder and its parents. Rules with `paths`, and files in subfolders,
   load when Claude reads files there.
4. **Local:** `CLAUDE.local.md`.

Files closer to the launch folder are read last, and when two conflict, Claude may pick either. So
the persona carries role, communication and process ("review security first", "answer in
Indonesian"). Build commands, code style and layout stay in the repository's CLAUDE.md. Tone and
format go in an output style, which changes the system prompt itself.

### 12.2 Instruction sources (v2.1.277+)

Written to `pluginConfigs["cc-plugin-agents-md@builtin"].options.instructionFiles`:

| Option | `instructionFiles` | What loads |
| --- | --- | --- |
| Default | Not written (`claude-md-or-agents-md`) | Persona, user and project files; AGENTS.md in folders with no CLAUDE.md |
| Also AGENTS.md | `claude-md-and-agents-md` | Both files in every folder |
| CLAUDE.md only | `claude-md` | AGENTS.md is ignored |
| Persona only | `managed-only` | The managed CLAUDE.md and auto memory. User, project and local CLAUDE.md, rules and AGENTS.md are skipped. |

"Persona only" stops a repository's build and test instructions from loading. It asks for
confirmation, and the workspace row shows a warning badge while it's on.

### 12.3 Subagents and styles from other sources

- Subagent precedence: managed, `--agents`, project, user, plugins. A persona subagent hides a
  same-named repository or user subagent. The workspace preview marks hidden ones, and the editor
  suggests specific names (`security-reviewer`, not `reviewer`).
- A subagent gets its own prompt instead of Claude Code's, and ignores output styles. 🔬 It still
  receives the persona's instructions unless `omitClaudeMd` is set (Q8), which v1 doesn't expose.
- A managed `outputStyle` outranks the `/output-style` choice kept in `.claude/settings.local.json`
  🔬 (Q4). Where users should choose, leave the default style empty.

## 13. Preview and testing

### 13.1 Preview: "What Claude will be told"

- **Where:** in the editor, the persona's layers with placeholders. In a running workspace, also
  `~/.claude/CLAUDE.md` and `~/.claude/rules/*.md`; for a chosen project folder (under `~/work`, up
  to three levels deep), its CLAUDE.md chain, `.claude/rules/`, `CLAUDE.local.md`, `AGENTS.md` and
  subagent names; and only `outputStyle`, `model`, `effortLevel` and `modelSettings` from
  `~/.claude/settings.json` and the project's `.claude/settings*.json`. Reads follow §16.
- **Layers in order,** with a Terminal / Chat switch:
  1. System prompt: Claude Code's own (not shown; marked when the style drops its coding
     instructions), the style body (or the user's `/output-style` choice if the persona sets none),
     and the chat prompt (Chat only).
  2. Instructions in load order (§12.1), with source, lines and tokens. Layers skipped by "persona
     only" are greyed out, paragraphs that repeat the persona's text are flagged (§10.4), and
     `@path` imports and auto memory are listed, not expanded.
  3. Subagents with name, description and source; hidden ones struck through.
  4. Starting model and effort after policy, model support and `modelSettings`, which outranks
     `effortLevel` ("xhigh, runs at high on Opus 4.6"; "high → low: modelSettings in
     ~/.claude/settings.json").
- "Preview files" shows the exact files; session reports show what the last session loaded.

### 13.2 Testing

- **Try a draft.** "Test" pins a chosen workspace to the draft, waits for "Synced", and offers "Open
  terminal" and "Open chat". It confirms first: "All users of api-dev get draft r5 in new sessions
  until the test ends; running sessions may switch style at their next message." "End test", or 24
  hours, restores the previous assignment; any other assignment change ends the test without
  restoring. The workspace Select offers "Start" for stopped ones and "Enable pools" where needed.
- **Test prompts.** Up to 10, each a one-shot `cp-session run` in the test workspace (§10.3, Chat
  sessions A8), with or without the chat prompt:
  - `--permission-mode plan` blocks Claude's edits and non-read-only tool calls. Hooks, skills'
    injected commands and MCP servers still run.
  - The controller denies every permission request and question (`--permission-prompt-tool stdio`,
    Chat sessions FR21), so a run never waits for an answer.
  - Limits: `--max-turns 4`; `--max-budget-usd 0.50`, shown as "est., may pass by one response", or
    "cost unknown" on custom hosts without a price; 120 s, then the run is ended. `cp-session run` gives
    the run a file as stdin, so it drains and exits (✅ for a plain pipe; the host path is a Chat
    sessions contract test). Runs count against the chat caps (Chat sessions FR39).
  - Results: model, tokens, cost, duration, loaded files and errors, and the response (Chat sessions
    §9). Later:
    side by side with the published revision.
- **Who pays.** Run is enabled only while the workspace's Account Pool assignment is active (not
  paused, not waiting for quota, delivery Synced), and otherwise says why. Chat sessions' credential
  guard runs first (its §6, 🔬 its Q3), so a user's own login is never used.
- 🔬 **Audit.** If `/doctor prompt-audit` (v2.1.283+) runs non-interactively (Q9), "Audit" runs it
  to flag conflicting or outdated instructions.

## 14. Versions, rollback and archiving

- **Revisions.** Every save is an immutable revision with a note, a draft until published (A3).
  Publishing moves the current revision; following workspaces update at the rollout limit (default
  20 per minute), and "Stop rollout" holds the rest. **Pinning** holds a workspace on any revision.
- **History** lists revision, note, author, time, state, workspaces and sessions. **Diff** compares
  per part (instructions, each style and subagent, defaults, chat prompt).
- **Rollback.** "Restore r3" publishes a new revision identical to r3 after one confirmation,
  skipping the rollout limit like revocations (A3). Pinned workspaces stay pinned. History is never
  rewritten. Revisions referenced by assignments, tests, session reports or chat conversations are
  kept; others beyond the latest 50 are pruned, and the event log keeps their notes.
- **Archiving** replaces delete (A8). It's disabled while the persona is assigned: "Used by N" opens
  "Move workspaces…" (another persona or None, through the normal rollout), then archives. The
  default-for-new persona can't be archived until another is the default. Archived personas leave
  every select, keep referenced revisions and can be restored; unreferenced ones can be deleted.
- **Over [Portal MCP](portal-mcp.md).** Persona text reaches the model context of every following
  workspace, and a model can complete a confirmation step alone (Portal MCP §14.1). So `pool_create`
  and `pool_update` with `content` only save a draft and return a link; publishing is UI-only
  (`UI_ONLY`). `restore_revision` accepts only revisions published before and always needs server
  confirmation (C), with the §11 timing summary. `pool_delete` archives (with `unassign`, after
  moving workspaces to None). Test prompts aren't exposed in v1. Changes carry the MCP actor (Portal
  MCP A3). Until these rules ship, Portal MCP doesn't list the persona type.

## 15. User experience

Screens use existing components (Card, Section, PageTabs, Badge, Menu, FormDialog, DiscardDialog,
ConfirmDialog, Dialog, Select, ChipGroup, Segmented, Switch, TextArea, EmptyState) on phones and
desktops. New: a DiffView (side by side on desktop, unified on phones, shared with Skillset's), and
`mono` and `autoGrow` props on `@isnanme/ui`'s TextArea, shipped upstream ([Web app](web-app-pwa.md)
§14).

**Personas tab** (Pools hub, `/admin/pools?tab=personas`, [Skillset](skillset-pool.md) A8, Web app §8): a
card per persona with name, description, revision, a "Draft r5" badge, a parts line ("48 lines ·
style Reviewer · 3 subagents · opus, high · chat prompt"), "Used by N workspaces", a "Default"
badge, and a menu (Edit, Duplicate, Test, History, Export, Archive). "Show archived" lists archived
ones with Restore. The EmptyState offers "New persona" and "Import files".

**Persona editor** (`/admin/pools/personas/<id>`, a `task` route on phones, Web app §9.2), four
groups (Sections on desktop, PageTabs on phones):

- *Text:* instructions in a monospace, growing TextArea with line and token counts, the §12.1
  guidance, the §6 rule 1 note and the Instruction sources Select; then the chat prompt ("Chat
  sessions only").
- *Styles & subagents:* rows edited in a FormDialog. Subagent tools are a ChipGroup: built-in tools,
  then MCP tools from the delivered catalogs under their plugin names
  (`mcp__plugin_cpm-<set>_<server>__<tool>`, `mcp__plugin_cpb-browser_<server>__<tool>`), plus free
  text; a name that no assigned set or browser pool delivers warns at compile time. MCP set slugs
  and server keys never change once delivered ([MCP set](mcpset-pool.md) FR5), so these names stay
  valid. Model is a Select, effort a Segmented.
- *Defaults:* model Select (aliases, then IDs from Account Pool endpoints), effort Segmented, and
  "Starting point. Users can change both in a session. Policy caps apply."
- *Test & history:* test prompts, a workspace Select, Run, result cards; revisions, a diff Dialog,
  Restore, Pin.
- Sticky footer: Preview, Save draft (asks for a note), and Publish, which confirms with the §11
  timing summary and rollout ("7 workspaces, about 1 minute"). A DiscardDialog guards edits.

**Workspaces:** the create dialog gets a Persona select (default preselected, "None" first). Rows
show a persona chip, with a warning Badge while "persona only" is on. The Configuration panel's
Persona row shows persona · rN · delivery status · "Loaded", a change control and Preview; policy
adjustments and sessions by revision open in a Dialog (a sheet on phones).

**Chat** ([Chat sessions](chat-sessions.md) §12.3): the persona part of the session line ("Persona
Reviewer r4 · applies to new conversations") opens a read-only sheet with the persona's parts. It's
how workspace users see what applies to them (US10).

## 16. Security requirements

- **No secrets in personas.** FR8 blocks credential patterns: persona text sits in world-readable
  managed files and goes to the model provider with every request.
- **No new access** (§6 rule 2), checked by the ownership check. **Not a boundary** (§6 rule 1).
- **Workspace reads** (preview, "Import from workspace") run one fixed script, passed on stdin to
  `exec` as the workspace user, like the foundation's preflight (its §6.6). Repositories are
  untrusted, and that user can read the account key, secret files and
  `~/.claude/.credentials.json`. So the script:
  - never follows a symlink, for files or folders (it uses lstat; a link shows only its target
    path, marked "not shown"), and skips files with more than one hard link;
  - reads only regular files whose real path is inside `$HOME`, up to 256 KB each, and lists
    anything else, such as `/etc/claudepilot/**`, by path only;
  - refuses `~/.claude/.credentials.json`, `~/.claude.json`, `~/.claudepilot/**`, `~/.ssh/**` and
    `~/.aws/**`, and returns only the four §13.1 keys from settings files.

  Before a response leaves the portal, each file is checked against FR8's patterns and the secret
  values delivered to that workspace (matched in memory, as in Monitoring §15; patterns only while
  Locked). A match withholds the file. The persona's own layers come from the portal, never from the
  workspace. Nothing read is stored or logged.
- **Hook records** hold IDs, paths, revisions and load reasons; never content or prompts.
- **Test runs** use plan mode and the §13.2 limits, run only on active Account Pool credentials, and
  are admin-only. Their transcripts are Chat sessions records (origin `persona_test`), redacted
  before storage under its rules (its §13), and deleted when the test ends or after 24 hours. The
  persona keeps metadata only, and Monitoring's no-content rule (its §6) holds.
- **Imports** are text only, shown in full, never fetched by URL; unsupported fields are dropped.
  **Publishing** is UI-only (§14).

## 17. Observability and audit

- Event log ([foundation](foundation-pools.md)), each entry with its actor (Portal MCP A3): persona
  created, revision saved (who, note), published, rollout stopped, restored, archived; assignments
  and pins; tests and test runs (workspace, prompt, cost); "persona only" switched; policy
  adjustments; delivery results and drift.
- [Monitoring](monitoring-dashboard.md) metrics: workspaces per persona, recent sessions on an older
  revision, synced but not loaded, delivery failures, test-run spend per day.

## 18. Rollout and milestones

| Milestone | Scope | Gate |
| --- | --- | --- |
| P1 | Instructions, model and effort; drafts and publish; drop-in delivery to Docker targets; assignment at create, later and in bulk; editor preview | Foundation F2, F5 and A3. 🔬 Q5, Q6 |
| P2 | Output styles and subagents; Kubernetes delivery; policy and endpoint checks (A7) | Foundation F3; Settings & policies S2. 🔬 Q3, Q4 |
| P3 | History and diff, restore, stop rollout, pins, archiving; testing a draft in the terminal; Portal MCP rules (§14) | |
| P4 | Session reports; workspace preview with user and repository files; "Loaded" status; import from workspace | Foundation F4; A6 or the persona `SessionStart` entry. 🔬 Q7 |
| P5 | Chat prompt; test prompts | Chat sessions C5; Settings & policies Q5. 🔬 Q14 |
| P6 | Instruction sources; import and export; side-by-side test comparison | |

## 19. Success metrics

| Metric | Target |
| --- | --- |
| Publish to "Synced" on every assigned workspace | Under 2 minutes for 20 workspaces |
| New sessions starting on the current revision once synced | 100%, from session reports; resumed sessions reported separately ("resumed on r3") |
| Deliveries that stop Claude Code from starting | Zero (validated before writing) |
| Credentials in persona content, revisions, exports or logs | Zero, checked by automated tests |
| Symlinks and hard links planted to the account key, a secret file and `.credentials.json` | Nothing shown in preview or import: zero leaks, automated test |
| Restore click to "Synced" | Under 2 minutes for 100 workspaces |
| Workspace preview matches the files the next session loads | 95% of sampled sessions |
| Test prompts still running after 120 s | Zero |

## 20. Amendments to Pools foundation

**A1. §7, Persona row.** Replace it with:

| Files | Managed settings keys (in its own drop-in) |
| --- | --- |
| `managed-settings.d/50-claudepilot-persona.json`, `/etc/claude-code/CLAUDE.md`, `/etc/claude-code/.claude/agents/**`, `/etc/claude-code/.claude/output-styles/**`, `/etc/claudepilot/persona/**`, `/etc/claudepilot/bin/persona-*` | `outputStyle`, `model`, `effortLevel`, `pluginConfigs["cc-plugin-agents-md@builtin"]` (`agents-md@builtin` before 2.1.285), `hooks.InstructionsLoaded` entries, and a `hooks.SessionStart` entry until A6 lands |

Remove `enabledPlugins`, and drop personas from §7's marketplace paragraph and from F6: there's no
persona plugin in v1. `claudeMd` and `agent` are reserved for Persona; no fragment writes them in
v1. Other pools ship always-on guidance as skills in their own plugins
([Browser & desktop](browser-desktop-pool.md) A12).

| ID | Section | Proposed change |
| --- | --- | --- |
| A2 | §7, a third rule | Default model and effort come only from the persona's `model` and `effortLevel`. No pool sets `ANTHROPIC_MODEL` or `CLAUDE_CODE_EFFORT_LEVEL` in `env`, not even empty: the first overrides the persona's model ✅ (cross-pool lab, Q6), the second outranks `/effort`. Account Pool's M3 build writes `ANTHROPIC_MODEL` from a custom host's default slot; its Q21 decides when that stops. |
| A3 | §5, §6.3 | Adopt [Skillset](skillset-pool.md) A3 (`pool_revisions.status`, `rollout_paused_at`). Personas use `draft` and `deliverable` only, and a persona test (§13.2) may pin a `draft` without it becoming current. "Stop rollout" sets `rollout_paused_at`. A persona restore skips the rollout limit, like revocation, but not pins. |
| A4 | §9 | Create `/etc/claude-code/.claude/agents` and `/etc/claude-code/.claude/output-styles`, empty, in the image, at the first delivery to existing Docker workspaces, and in `sync` on Kubernetes, whose `emptyDir` hides the image's folders. |
| A5 | §5 | `pools.default_for_new` (at most one per type) and `pools.archived_at` (§14). |
| A6 | §7, §8 | One session-start record for every pool. The foundation base drop-in `00-claudepilot-base.json` ([Portal MCP](portal-mcp.md) A1) carries a `hooks.SessionStart` entry running the foundation's `session-event`, which prints nothing and appends `{id, at, session_id, source, revisions, model, permission_mode, session_title}` to `outbox/sessions.jsonl` in every monitoring mode. Hook arrays from two drop-ins both ran ✅ (cross-pool lab; Monitoring A3), so each owner keeps its own entries in its own drop-in: Monitoring its `SessionStart` entry (its §10.1), Persona its `InstructionsLoaded` entry. Persona's own `SessionStart` entry goes once this lands. The outbox types `sessions` and `persona` are capped at 256 KB each. |
| A7 | §6.1 | Cross-pool compile inputs: the persona fragment receives the workspace's effective `availableModels` and `maxEffortLevel`, its Account Pool endpoint's model slots and model list, and its Claude Code version. A change to any of them recompiles it and changes the desired hash. |
| A8 | §10 | The persona editor is a page (Sections on desktop, PageTabs on phones), as in Settings & policies amendment 8. Pool pages may offer Archive instead of Delete. A Configuration row may add a "Loaded" status and a Preview action, with details in a Dialog (a sheet on phones). |

**Related changes in other PRDs:**

| PRD | Change |
| --- | --- |
| [Account Pool](account-pool.md) | §10.1 names its model variables. For custom hosts it always writes `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, with empty slots taking FR1's default slot, so Claude Code's default alias resolves to a model the host serves. It never writes `ANTHROPIC_MODEL`; with no persona, nobody writes `model`. It keeps each endpoint's latest `GET /v1/models` IDs for A7. Until this lands, workspaces whose drop-in sets `ANTHROPIC_MODEL` show "Persona model ignored here: Account Pool sets ANTHROPIC_MODEL". Open as Account Pool Q21, since its M3 build writes it. |
| [Portal MCP](portal-mcp.md) | On pool types with drafts, `pool_create` and `pool_update` return `{revision, status: "draft", publish_url}`. Publishing a persona joins its §13.4 list (UI-only), and `pool_delete` archives a persona (§14). |
| [Settings & policies](settings-policies.md) | §11.4 gains persona retention: session reports 30 days, test runs 14 days. Per-subagent permission modes, if wanted later, are a Settings & policies setting, not a persona field. |
| [Monitoring](monitoring-dashboard.md) | Shows the §17 persona metrics. Its A3 (hooks are list keys) is adopted: A6 no longer asks for one `SessionStart` owner. |
| [Chat sessions](chat-sessions.md) | Its A8 is adopted in §10.3 and §13.2. Also: never pass `--bare` or `--system-prompt`; delete `persona_test` sessions when their test ends or after 24 hours, and leave them out of the Sessions list. |

## 21. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | Closed: instructions go to the documented `/etc/claude-code/CLAUDE.md`, which the foundation delivers on every target, so `claudeMd` in a drop-in isn't needed. | — |
| Q2 | 🔬 Does a changed managed CLAUDE.md reach a running session before `/compact`, at `/compact`, or only at the next launch? | Sandbox test |
| Q3 | 🔬 Does Claude Code watch `/etc/claude-code/.claude/agents/` live? The docs list only the user and project folders. | Sandbox test |
| Q4 | 🔬 Does a managed `outputStyle` override a user's `/output-style` choice, in running and new sessions? | Sandbox test |
| Q5 | 🔬 Do managed `model` and `effortLevel` act as per-session defaults that `/model` and `/effort` override, with each new session starting on them again? | Sandbox test |
| Q6 | Partly answered ✅ (cross-pool lab): `ANTHROPIC_MODEL` in managed `env` outranks the managed `model` (`claude-haiku-4-5` won over `sonnet`), and `ANTHROPIC_DEFAULT_SONNET_MODEL` resolved the `sonnet` alias to the custom name. 🔬 Does an empty value count as unset? Decides A2 and Account Pool Q21. | Sandbox test |
| Q7 | 🔬 What do `InstructionsLoaded` and `SessionStart` receive on 2.1.296 (fields, load reasons, `source` values), and does `InstructionsLoaded` list the managed CLAUDE.md file? In print mode it fired for `~/.claude/CLAUDE.md` and the project CLAUDE.md but never for an inline managed `claudeMd` ✅ (cross-pool lab); if it skips the file too, "Loaded" comes from A6's start record. | Sandbox test |
| Q8 | 🔬 Do subagents receive the managed CLAUDE.md unless `omitClaudeMd: true`? | Sandbox test |
| Q9 | 🔬 Does `/doctor prompt-audit` run non-interactively? | Sandbox test |
| Q10 | Answered for DinD: `cp-session` over `docker exec` carries stream-json, and one-shot runs drain and exit ✅ (Chat sessions A8). The Kubernetes transport is Chat sessions Q1. | Chat sessions spike |
| Q11 | Should resumed chat conversations pick up a new chat prompt (`--system-prompt-snapshot off`), at the cost of one uncached request and a mid-conversation change? | Product |
| Q12 | Should a later version allow full system-prompt replacement (the `agent` setting) for non-coding personas? | Product |
| Q13 | Closed: ultracode is a Settings & policies switch (its §11.2 and Q20), not a persona default. | — |
| Q14 | 🔬 Does a `claude -p` stream-json session load the managed CLAUDE.md, managed styles and agents, user and project CLAUDE.md and the user's style choice exactly as a terminal does, also in a folder whose trust dialog was never accepted? | Sandbox test |
| Q15 | 🔬 In a resumed conversation (`--resume`, or a chat session's wake), which parts reload: instructions, instruction sources, default style and style body, subagents, model and effort? Overlaps Chat sessions Q8. | Sandbox test |
| Q16 | Which version first supports each part in §10.2's second row? It matters only if foundation Q8 lowers the minimum below 2.1.296. | Engineering (changelog) |
