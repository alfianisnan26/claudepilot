# PRD: Persona pool

| | |
| --- | --- |
| Status | **Draft v0.8.** v0.8 records what was built and run. **P1 and P2 are built on Docker**, with **instruction contexts** (A9), the history and diff part of **P3**, and **persona identity and agent self-edit** (A10, interface I11: a name, an avatar, and proposals from the agent that a person reviews). ✅ = observed on Claude Code 2.1.296 in a workspace container against a scripted stand-in for the Anthropic API, through the delivery engine and, for A10, the portal's own MCP endpoint (`apps/server/src/personas/*.integration.test.ts`, `CLAUDEPILOT_DOCKER_TESTS=1`): print mode, a long-lived stream-json session (what a chat session is), `--resume` and a terminal (§11). Not built: P4, most of P5, P6, Kubernetes delivery, the policy and endpoint checks (A7), archiving, session reports. Items marked 🔬 still need a sandbox check. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [Pools foundation](foundation-pools.md) (storage, revisions, delivery engine, outbox); [Chat sessions](chat-sessions.md) (session runner, for the chat prompt and test prompts only) |
| Related | [Settings & policies](settings-policies.md) (permissions, allowed models, effort cap), [Account Pool](account-pool.md) (model names per endpoint), [Monitoring dashboard](monitoring-dashboard.md) (session-start hook), [Portal MCP server](portal-mcp.md), [Skillset pool](skillset-pool.md), [MCP set pool](mcpset-pool.md), [Secrets & env](secrets-env-pool.md) |

## 1. Summary

A persona is a reusable bundle of what Claude is told and how a session starts: instructions,
output styles, subagents, a default model and effort, and a prompt for portal-run chat sessions.
Admins write and version personas in the portal and assign one to each workspace. A persona also has a
name and an avatar, and the Claude in a workspace may propose changes to its own persona, which a person
approves (§22). Reusable pieces of instructions, **contexts**, can be assigned on their own or held by
personas (§12.4).

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
| US11 | As an admin, I keep our coding standard in one context and put it in every workspace and in several personas, and an edit reaches them all, running sessions included. |
| US12 | As an admin, I give a persona a name and an avatar, and see them wherever a session of that persona shows. |
| US13 | As an admin, I let the Claude in a workspace propose a new name, an avatar or a change to its instructions, and approve or reject each with one tap; instructions never apply by themselves. |

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
2. **A persona can't widen access.** It writes no `permissions.*`, `sandbox.*`, MCP, skill or `agent` keys and
   no `env` but its own change stamp, `CLAUDEPILOT_PERSONA` (§10.1), and its subagents never carry `permissionMode`, `hooks`, `mcpServers` or `skills`.
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

### Contexts and identity

- **FR16** Instruction contexts (§12.4): a named, versioned Markdown piece (up to 20 KB), delivered as a managed
  rule file; several per workspace, held by personas (up to 10), saved as drafts, published like a persona.
- **FR17** A persona has an avatar (a PNG, JPEG or WebP, re-encoded; none is valid) and a name (the pool's),
  shown by one component wherever a session, a list or a ticket shows its persona (§22). One persona can be the
  default for new workspaces.
- **FR18** Agents' proposals (§22): the Claude in a workspace may propose a name, an avatar and edits to the
  instructions of its own persona, only while the portal's `agents.selfEdit` setting and the persona's own switch
  are on. A person approves or rejects each. A name or an avatar may auto-approve on the persona's switch;
  instructions never do.

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

What belongs to a persona as a whole and not to one revision (A10, migration 70; none of it is delivered):

| Table | Key fields |
| --- | --- |
| `persona_meta` | pool_id, avatar (sha256), agents_may_propose, auto_approve_cosmetic, is_default (at most one), updated_at. Gone with the pool. |
| `persona_avatars` | sha256, png, size, created_at. The PNG the portal re-encoded, at most 256 KB; collected once no persona and no recent proposal refers to it. |
| `persona_proposals` | id, pool_id, kind (`name`, `avatar`, `instructions`), status (`pending`, `approved`, `rejected`, `stale`), actor (`session:<id>`), workspace_id, session_id, reason, payload (json), fingerprint, base_revision, created_at, decided_at, decided_by (`Admin` or `auto`). |

`is_default` is A5's `default_for_new`, kept here; `pools.archived_at` is not built. Retention is edited in
[Settings & policies](settings-policies.md) §11.4 (§20).

## 10. Delivery into Claude Code

### 10.1 What gets written

| Path in the workspace | Content |
| --- | --- |
| `/etc/claude-code/CLAUDE.md` | The instructions. The documented managed CLAUDE.md: it loads first, and `claudeMdExcludes` can't exclude it ([memory](https://code.claude.com/docs/en/memory)). Absent when empty. |
| `/etc/claude-code/managed-settings.d/50-claudepilot-persona.json` | Only the keys the persona sets: `outputStyle` (default style), `model`, `effortLevel`, `pluginConfigs` for instruction sources (§12.2), and a `hooks.InstructionsLoaded` entry (plus a `hooks.SessionStart` entry until A6 lands, §11) running `/etc/claudepilot/bin/persona-event` with `async: true`, as Monitoring does for its hooks (its §10.1). Whenever the persona delivers anything it also carries `env.CLAUDEPILOT_PERSONA`, a hash of everything it writes (the stamp, below). An empty persona writes no drop-in. |
| `/etc/claude-code/.claude/rules/cpx-<name>.md` and `managed-settings.d/55-claudepilot-context.json` | The instruction contexts a workspace gets (§12.4), written by the `context` owner: one rule file each, and a drop-in that holds only `env.CLAUDEPILOT_CONTEXT`, the same kind of stamp. Absent without contexts. |
| `/etc/claude-code/.claude/output-styles/<name>.md` | One per style. Frontmatter `name` (equal to the file name, so selection matches either way), `description`, `keep-coding-instructions`; then the body. |
| `/etc/claude-code/.claude/agents/<name>.md` | One per subagent. Frontmatter `name`, `description`, `model`, `effort`, `maxTurns`, and `tools` and `disallowedTools` only when non-empty (left out, a subagent inherits every tool); the prompt is the body. |
| `/etc/claudepilot/persona/chat-prompt.md` | The chat prompt, read by the session runner (§10.3). Absent when empty. |
| `/etc/claudepilot/bin/persona-event` | Persona's own script (each pool type owns its `bin/` prefix, foundation §7). Appends one line per event, with an `id`, to `~/.claudepilot/outbox/persona.jsonl` (foundation §8) and prints nothing, since hook output can reach Claude's context. |

Files are mode `0644`: root-owned on Docker, group-owned through `fsGroup` on Kubernetes
(foundation §6.2).

**The stamp.** ✅ A running Claude Code session re-reads the managed instruction files (the managed
CLAUDE.md and the managed rules) when a drop-in in `managed-settings.d` changes, and only then: a file
edited on its own is never seen until the next session. A drop-in that delivers instructions therefore
also carries a stamp, so it changes whenever the text does (§11). The stamp hashes the delivered paths and
contents, never the time, so equal content gives an equal desired hash and nothing is written twice.

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
2. The managed folders exist before any session starts (A4): `managed-settings.d`, `agents`,
   `output-styles` and `rules`, even empty. ✅ A session that started when `/etc/claude-code` didn't
   exist never saw the persona delivered afterwards (two messages checked), while one that started with
   an empty `managed-settings.d` picked it up 2 to 4 s after delivery (§11). The image creates the
   folders, and the foundation creates them with the first delivery to an older workspace.
3. A stopped workspace is left with empty files in place of removed ones until its next start
   (foundation §6.2). ✅ Claude Code 2.1.296 starts normally, and tells nothing, with empty drop-ins, an
   empty managed CLAUDE.md and empty rule, subagent and output-style files.
4. A compiled persona is capped at 256 KB, well under the 1 MiB Secret all pools share.
5. Every part is documented for 2.1.296, the foundation's minimum (its §9), so supported workspaces
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

- ✅ `--append-system-prompt-file <file>` appends the file's text at the end of the system prompt in a `-p` run
  (2.1.296), next to a persona's managed files. Chat sessions' host (`cp-session`) adds the flag at every start,
  resume, wake and move when the file exists (✅ checked by that area with a real Claude Code: the text was in the
  system prompt). The editor has a "Chat prompt" field.
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
2. **Running sessions** that started with the managed folders in place get the persona's instructions
   at their next message (§11); the style, subagents, model and effort wait for a new session. The
   Persona row lists sessions that started before it, from session reports and
   [Monitoring](monitoring-dashboard.md) ("2 sessions started before this persona; restart them to
   apply it"; not built).
3. **Duplicate text.** Role text users pasted into `~/.claude/CLAUDE.md` (§2) loads twice once a
   persona carries it. The workspace preview flags paragraphs that appear in both.
4. **Import from workspace** seeds a draft from `~/.claude/CLAUDE.md`, `~/.claude/agents/*.md` and
   `~/.claude/output-styles/*.md`, read as in §16 and checked by FR8. User files never change (§4).

## 11. When changes take effect

✅ Observed on Claude Code 2.1.296 in a workspace container, with the delivery engine writing the files and
a scripted stand-in for the Anthropic API recording each request (`personas/claude.integration.test.ts`).
"Running session" is a long-lived `claude -p --input-format stream-json` process, which is what a portal
chat session is. A terminal (`claude` in tmux) was run for the instruction rows: it re-reads managed instruction
files in the same way, and also notes "/etc/claude-code/CLAUDE.md changed on disk since you last read it".

| Part | Running session | New session or conversation | Resumed conversation |
| --- | --- | --- | --- |
| Instructions (managed CLAUDE.md) and contexts (managed rules) | ✅ From the session's next message, 2 to 4 s after delivery: a changed drop-in makes Claude Code re-read them, and the message carries them as "Instruction files were re-read after the organization's managed settings changed; … each replaces its earlier copy". The stamp (§10.1) is what changes the drop-in. A file edited alone is never seen. | ✅ Applied | ✅ Applied: the resumed message carries the current files |
| Removing them (unassign) | ✅ From the next message: "Instructions no longer present: /etc/claude-code/CLAUDE.md" and "The output style was reset to the default" | ✅ Gone | ✅ Gone |
| Instruction sources | Not applied: read at launch (not built) | Applied | 🔬 |
| Default style (`outputStyle`) | ✅ From the next message, if that style's file was there when the session started ("# Output Style: <name>" reminder). A style delivered later isn't. | ✅ Applied | ✅ Applied |
| Style file content | ✅ Not applied | ✅ Applied | ✅ The resumed message carries the current style's text (checked with a changed default style) |
| Subagents | ✅ Not applied: a new or an edited subagent file wasn't seen in the 6 to 8 s checked, in a folder that existed at start (answers Q3) | ✅ Applied | ✅ Applied |
| Default model and effort | ✅ Not applied: read once per session. Users switch with `/model` and `/effort`. | ✅ Applied | ✅ A resumed process starts on the persona's current default, unless flags say otherwise |
| Chat prompt (`--append-system-prompt-file`) | Not applied | ✅ Applied: the file's text ends the system prompt | 🔬 Q11: kept until compaction, per the docs |

A resumed conversation is `claude --resume` in a terminal, or a chat session waking from its idle
sleep (§10.3). ✅ A session that started when `/etc/claude-code/managed-settings.d` did not exist never
sees later deliveries (§10.2). Sessions started with `--bare` or `CLAUDE_CODE_SIMPLE` skip CLAUDE.md
discovery and hooks, so they get little or none of the persona and report nothing (Unknown; 🔬 Monitoring Q4).
The style body arrives as a system reminder at the start of the first message, and the system prompt's
opening line then names the Output Style.

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

### 12.4 Instruction contexts (A9)

A workspace has one persona, so a team that wants "our coding standard" in every workspace, and a persona on
top of it, would paste the standard into every persona. A **context** is the missing piece: a named, versioned
piece of Markdown instructions, up to 20 KB, in its own pool type (`context`, the Contexts tab). A workspace can
have several, assigned on their own (create dialog Add-ons, the Configuration row, bulk assignment), and a
persona can **hold** some (up to 10), which are delivered wherever it is.

- **Delivery.** Each context is one managed rule file, `/etc/claude-code/.claude/rules/cpx-<name>.md`, written
  by its own `context` owner, plus a drop-in `55-claudepilot-context.json` that holds only a stamp (§10.1).
  ✅ Claude Code 2.1.296 loads it as "organization-managed policy instructions", right after the managed
  CLAUDE.md and before the user's and the repository's own, so a context adds to them and never replaces them.
  ✅ A leading HTML comment names the context and revision, and is stripped before Claude reads the file.
  ✅ A running session re-reads a changed context at its next message, like the persona's own text (§11).
- **Composition.** A workspace gets the contexts assigned to it plus those its persona holds, each once. Names
  that make the same file name get a number. A context only the persona holds belongs to the persona's
  lifecycle: it isn't named in the manifest as a pool of its own, and leaves with the persona. A change to
  such a context is delivered at once to the workspaces whose persona holds it, though nothing is assigned to
  them. Together the files stay under the 256 KB a compiled persona may write.
- **Rules.** Same as a persona's (FR8): nothing credential-shaped, no control or invisible characters. Deleting
  a context is refused while a persona's current or newest revision holds it; older revisions that name a
  deleted context are skipped at delivery. Like a persona it saves as a draft and publishes.
- **A repository's context pack** (T-292). A push to a CI remote's default branch (local-git-ci §11.1, `snapshot`)
  whose commit has `docs/context-pack.md` keeps the context `<repo>-context-pack` in step with that file
  (`personas/contextPack.ts`): created on the first push and assigned to the workspace that hosts the remote, a new
  revision (noting the commit) when the text changed, nothing when it is equal. Refused, keeping what the pool had:
  over 20 KB, anything credential-shaped, a pool of that name assigned only to other workspaces. It is never
  deleted, and never assigned again once a person took it off the workspace. Each change or refusal is one
  platform audit row `pools.context_pack` (fixed codes, never the text). No route or tool: the portal acts on a
  push the CI remote already accepted. **Path-scoped (T-472):** the pool holds the pack as a path-scoped rule. Its
  frontmatter `paths` lists the folders the pack's own `## Map` names (`apps/server/src/chat/**` and so on). A
  one-level folder such as `scripts/` is left out, because other repositories have one too. Claude Code then loads
  the pack only in a session that works on files of this repository (a worktree included), not in the sessions of
  other repositories that share the workspace. A pack that brings its own frontmatter, or whose Map names nothing
  usable, is kept as it is. A context with frontmatter keeps it at the top of its rule file, with the portal's
  comment after it. A pack delivery restarts no session (chat-sessions FR53b, T-472).
- **Editor and preview.** The persona editor lists the contexts it can hold; "What Claude is told" shows each
  held context as its own managed layer, after the persona's text.

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
  MCP A3). Until these rules ship, Portal MCP doesn't list the persona type. What an agent itself may do is §22: three tools, for its own persona only, none of which approves anything.

## 15. User experience

Screens use existing components (Card, Section, PageTabs, Badge, Menu, FormDialog, DiscardDialog,
ConfirmDialog, Dialog, Select, ChipGroup, Segmented, Switch, TextArea, EmptyState) on phones and
desktops. New: a DiffView (side by side on desktop, unified on phones, shared with Skillset's), and
`mono` and `autoGrow` props on `@isnanme/ui`'s TextArea, shipped upstream ([Web app](web-app-pwa.md)
§14).

**Personas tab** (Pools hub, `/admin/pools?tab=personas`, [Skillset](skillset-pool.md) A8, Web app §8): a card per
persona with its avatar (or initials), name, description, revision, a "r5 draft" badge, a parts line ("48 lines ·
Terse · 3 subagents · opus, high · 2 contexts"), a star when it is the default for new workspaces, "N proposals"
when agents asked for changes, "Used by N workspaces", and the shared menu (Edit, Duplicate, Assign, Revisions,
Delete). A "Proposals" button with a count sits beside "New persona" only while something waits. Not built:
Test, Export, Archive and "Show archived", "Import files".

**Contexts tab** (`/admin/pools?tab=contexts`, A9, next to Personas): a card per context with its line count and
"Used by N workspaces", and the same menu. Its editor is a page with the Markdown and its history.

**Persona editor** (`/admin/pools/personas/<id>/edit`, a page, full screen on phones). Text diet: labels of one or
two words, the long notes behind an ⓘ. Top to bottom: name and description (shared); the avatar with an
"Avatar" button and the three switches ("Default for new workspaces", "Agents may propose changes",
"Auto-approve name and avatar"), which act at once; *Instructions* in a monospace, growing text area with line and
token counts (amber past 200 lines); *Chat prompt*; *Contexts* as chips; *Starts on* (model Select: Claude Code default, Opus,
Sonnet, Haiku or a model ID; effort Segmented: Default, Low, Medium, High, XHigh); *Styles* and *Subagents* as
rows that open (a star marks the default style); **What Claude is told** (the layers in load order: the persona,
its contexts, then `~/.claude/CLAUDE.md`, the repository's and `CLAUDE.local.md` marked as the workspace's;
style, subagents and the starting model); **History** (revisions, a line diff and the other changes against the
editor, and a restore into the editor). The sticky footer has Preview files, Cancel, Save draft and Publish,
which confirms with the §11 timing when workspaces follow it. Not built: instruction sources, test prompts,
per-workspace Preview with the user's and repository's real files.

**Review queue** (A10): a dialog from "Proposals" (all personas) or from a card (one persona). Each proposal is a
row with its kind, the proposed name, the avatar or a line diff of the instructions against what is current, the
agent's reason as plain text, who and when, and two icon buttons: reject and approve. A proposal that can't be
applied any more says why and can only be rejected.

**Workspaces:** the create dialog has one compact Persona select in its main form, after the account pool, with
the default persona selected ("None" first); contexts and the other pools stay under Add-ons. The Configuration
panel's Persona row shows persona · rN · delivery status, what it sets and the contexts it brings, with a change
control (a Select). Not built: the persona chip in rows, the "Loaded" status and Preview.

**Chat** ([Chat sessions](chat-sessions.md) §12.3): the persona's name and avatar show in the session header, the
Sessions rows and the transcript attribution, through the shared `PersonaAvatar` (§22); the persona part of the
session line ("Persona Reviewer r4 · applies to new conversations") opens a read-only sheet with the persona's
parts. It's how workspace users see what applies to them (US10). The name and avatar are built by Chat sessions
(session header, Sessions rows, the reply in the transcript) through `usePersonaIdentities` and `PersonaAvatar`; the
read-only parts sheet is not.

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
- **Avatars and agent proposals** (A10, §22). An image is hostile input from a person, a workspace file or an
  agent: it is identified by its bytes (PNG, JPEG, WebP; SVG, GIF, HEIC and the rest are refused whatever they
  are called), decoded by libvips with a pixel limit and re-encoded as a plain square PNG, so the stored file
  carries no metadata, no animation, and nothing but pixels. An agent can only propose for the persona of its
  own workspace, named by its token, never by an argument; a proposal is a record that nothing reads until a
  person approves it, and instructions never auto-approve. What an agent writes is shown as plain text and
  labelled as untrusted wherever a model reads it back.

## 17. Observability and audit

- Event log ([foundation](foundation-pools.md)), each entry with its actor (Portal MCP A3): persona
  created, revision saved (who, note), published, rollout stopped, restored, archived; assignments
  and pins; tests and test runs (workspace, prompt, cost); "persona only" switched; policy
  adjustments; delivery results and drift.
- Proposals (A10) are their own audit trail: who asked (`session:<id>`, workspace), what, why, who decided
  (`Admin` or `auto`) and when, kept with the persona. A revision an approval publishes names the proposer in its
  note; every tool call is also audited by Portal MCP with its actor.
- [Monitoring](monitoring-dashboard.md) metrics: workspaces per persona, recent sessions on an older
  revision, synced but not loaded, delivery failures, test-run spend per day.

## 18. Rollout and milestones

| Milestone | Scope | Gate |
| --- | --- | --- |
| P1 | Instructions, model and effort; drafts and publish; drop-in delivery to Docker targets; assignment at create, later and in bulk; editor preview. **Built.** Server (`apps/server/src/personas`): the `persona` pool kind (one per workspace: the shared pool service's `single` flag swaps it with a removal record), validation that names the field to fix (FR1 to FR5; FR8: credential-shaped text, control and invisible characters are refused in every field), drafts and publishing (only a published persona can be assigned, FR10), root-owned `0644` files Claude Code reads itself: `/etc/claude-code/CLAUDE.md` and `50-claudepilot-persona.json` (`outputStyle`, `model`, `effortLevel` and the stamp, §10.1), written only for what the persona sets; the read API (I5: `Personas#personaFor`, `#chatPrompt`, `GET /api/personas/workspaces/<target>/<name>`). Web (`apps/web/src/features/personas`): the Personas tab, the editor page, "What Claude is told", Preview files, the Persona select in the create dialog (default preselected), the Configuration picker and row, bulk assignment. ✅ **Run on a real Claude Code 2.1.296:** the managed CLAUDE.md, the user's and the repository's own each reach the request once, in that order; a flag overrides the default model and effort; unassigning removes every file (§11, §12.1). Checked in a browser at 390 and 1280 px. | Foundation F2, F5 and A3. Q5, Q6 |
| P2 | Output styles and subagents; Kubernetes delivery; policy and endpoint checks (A7). **Built for Docker.** Styles (up to 5, a default, "keep coding instructions") and subagents (up to 20: description, prompt, tools, disallowed tools, model, effort, max turns, nothing else, §6 rule 2) are generated from validated fields by a serializer; the managed folders exist before any session (§10.2). ✅ In a real session the default style arrives as a "# Output Style: <name>" reminder at the start of the first message, the subagent in the agent list with its tools, the model in the request, and the effort as `output_config.effort` on effort-capable models. Editor rows for both, with the default style starred. Not built: Kubernetes delivery, and the policy and endpoint checks (A7: models outside `availableModels`, effort above `maxEffortLevel`, endpoint model lists). | Foundation F3; Settings & policies S2. Q3 answered, Q4 open |
| P3 | History and diff, restore, stop rollout, pins, archiving; testing a draft in the terminal; Portal MCP rules (§14). **Partly built.** In the editor: the history of revisions, a line diff of the instructions and a list of the other changes against what the editor holds, and a restore that puts a revision in the editor to be saved or published (so history is never rewritten). Through the shared pool pages: Publish, make current and roll back, pause and resume a rollout, pinning a workspace to a revision (the API), a refused delete while assigned. Not built: archiving, a 409 with the diff when a save is based on an outdated revision (two people editing, or an approved proposal under an open editor, can overwrite each other), pins in the UI, testing a draft on a workspace (§13.2), Portal MCP's persona rules. | |
| P4 | Session reports; workspace preview with user and repository files; "Loaded" status; import from workspace. **Not built.** | Foundation F4; A6 or the persona `SessionStart` entry. Q7 |
| P5 | Chat prompt; test prompts. **Partly built.** The chat prompt is a persona field (an editor field, FR6's limits) delivered to `/etc/claudepilot/persona/chat-prompt.md`; the host passes `--append-system-prompt-file` for it at every start, resume, wake and move (§10.3, ✅ checked). Test prompts are not built. | Chat sessions C5; Settings & policies Q5 |
| P6 | Instruction sources; import and export; side-by-side test comparison. **Not built.** | |
| P7 | Identity and agent self-edit (A10, §22). **Built.** Name (the pool's), avatar and the per-persona switches; the avatar pipeline; proposals with a review queue; the three agent tools; `PersonaAvatar` and the read API; the default persona for new workspaces. ✅ **Run on a real Claude Code 2.1.296 through the portal's MCP endpoint:** a session read its persona, proposed a new name, an edit to its instructions and an avatar; an SVG named `.png`, a truncated PNG, a 4 MB file and `/etc/passwd` were refused; naming another persona or workspace in the arguments changed nothing; nothing was live until a person approved; the approved text reached the workspace and the next real session. | Portal MCP registry (I2), agent tokens (I8); the `agents.selfEdit` setting |

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
| A9 | §3, §7 | **Instruction contexts** (§12.4): a pool type `context` (several per workspace) whose files are `/etc/claude-code/.claude/rules/cpx-*.md`, a new owner `context` in the ownership registry (the rules folder, and a drop-in `55-claudepilot-context.json` that holds only an `env` stamp), and `contexts` in a persona's content (up to 10 pool IDs). The persona owner gains `env.CLAUDEPILOT_PERSONA`, the same kind of stamp (§10.1). The persona owner's declaration also names `/etc/claude-code/CLAUDE.md`, `/etc/claudepilot/persona/` and `/etc/claudepilot/bin/persona-`, and its keys become `outputStyle`, `model`, `effortLevel`, `pluginConfigs` and `hooks` (A1; `claudeMd` and `agent` stay reserved). The shared pool service gains a `single` flag for one-per-workspace types (this one, and Browser & desktop): the picker and bulk assignment swap the pool, with a removal record for the old one. |

| A10 | §3, §9, §22 | **Identity and agent self-edit** (interface I11): tables `persona_meta`, `persona_avatars`, `persona_proposals` (migration 70); the avatar pipeline (§16); the portal-wide setting `agents.selfEdit` (Settings & policies, default off, turning it on asks for confirmation) and the persona's own two switches; three agent-scope tools in Portal MCP; one shared display component and a read API. |

**Related changes in other PRDs:**

| PRD | Change |
| --- | --- |
| [Account Pool](account-pool.md) | §10.1 names its model variables. For custom hosts it always writes `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, with empty slots taking FR1's default slot, so Claude Code's default alias resolves to a model the host serves. It never writes `ANTHROPIC_MODEL`; with no persona, nobody writes `model`. It keeps each endpoint's latest `GET /v1/models` IDs for A7. Until this lands, workspaces whose drop-in sets `ANTHROPIC_MODEL` show "Persona model ignored here: Account Pool sets ANTHROPIC_MODEL". Open as Account Pool Q21, since its M3 build writes it. |
| [Portal MCP](portal-mcp.md) | On pool types with drafts, `pool_create` and `pool_update` return `{revision, status: "draft", publish_url}`. Publishing a persona joins its §13.4 list (UI-only), and `pool_delete` archives a persona (§14). |
| [Portal MCP](portal-mcp.md) (A10) | Gains `persona_get_self`, `persona_propose_update` and `persona_set_avatar_proposal`, each with `scope: 'agent'` (never destructive, a rate and a size limit; they approve nothing). |
| [Settings & policies](settings-policies.md) | §11.4 gains persona retention: session reports 30 days, test runs 14 days. Per-subagent permission modes, if wanted later, are a Settings & policies setting, not a persona field. |
| [Monitoring](monitoring-dashboard.md) | Shows the §17 persona metrics. Its A3 (hooks are list keys) is adopted: A6 no longer asks for one `SessionStart` owner. |
| [Chat sessions](chat-sessions.md) | Its A8 is adopted in §10.3 and §13.2. Also: never pass `--bare` or `--system-prompt`; delete `persona_test` sessions when their test ends or after 24 hours, and leave them out of the Sessions list. |

## 21. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | Closed: instructions go to the documented `/etc/claude-code/CLAUDE.md`, which the foundation delivers on every target, so `claudeMd` in a drop-in isn't needed. | — |
| Q2 | Answered ✅ (2.1.296, stream-json and a terminal): a changed managed CLAUDE.md or rule file reaches a running session only when a drop-in in `managed-settings.d` changes too (even an `env`-only change, written by rename); the session then re-reads them and the next message, 2 to 4 s later, carries the changed files (and "Instructions no longer present" for removed ones). Hence the stamp (§10.1). `/compact` was not tried. | — |
| Q3 | Answered ✅: a new or an edited subagent file in a managed `agents` folder that existed when the session started was not seen by the running session (6 to 8 s checked); a new session, and a resumed one, see it. | — |
| Q4 | 🔬 Does a managed `outputStyle` override a user's `/output-style` choice, in running and new sessions? | Sandbox test |
| Q5 | Answered ✅ except the interactive switch (2.1.296): a managed `model` and `effortLevel` set where a session starts (the request carried `model: claude-sonnet-4-6` and `output_config.effort: low` with no flags), `--model` and `--effort` override them (`claude-opus-4-6`, `high`), a running session keeps the model it started with, and a new or resumed one starts on the current default. The effort reaches the request only for effort-capable models. 🔬 `/model` and `/effort` in an interactive session. | Sandbox test |
| Q6 | Partly answered ✅ (cross-pool lab): `ANTHROPIC_MODEL` in managed `env` outranks the managed `model` (`claude-haiku-4-5` won over `sonnet`), and `ANTHROPIC_DEFAULT_SONNET_MODEL` resolved the `sonnet` alias to the custom name. 🔬 Does an empty value count as unset? Decides A2 and Account Pool Q21. | Sandbox test |
| Q7 | 🔬 What do `InstructionsLoaded` and `SessionStart` receive on 2.1.296 (fields, load reasons, `source` values), and does `InstructionsLoaded` list the managed CLAUDE.md file? In print mode it fired for `~/.claude/CLAUDE.md` and the project CLAUDE.md but never for an inline managed `claudeMd` ✅ (cross-pool lab); if it skips the file too, "Loaded" comes from A6's start record. | Sandbox test |
| Q8 | 🔬 Do subagents receive the managed CLAUDE.md unless `omitClaudeMd: true`? | Sandbox test |
| Q9 | 🔬 Does `/doctor prompt-audit` run non-interactively? | Sandbox test |
| Q10 | Answered for DinD: `cp-session` over `docker exec` carries stream-json, and one-shot runs drain and exit ✅ (Chat sessions A8). The Kubernetes transport is Chat sessions Q1. | Chat sessions spike |
| Q11 | Should resumed chat conversations pick up a new chat prompt (`--system-prompt-snapshot off`), at the cost of one uncached request and a mid-conversation change? | Product |
| Q12 | Should a later version allow full system-prompt replacement (the `agent` setting) for non-coding personas? | Product |
| Q13 | Closed: ultracode is a Settings & policies switch (its §11.2 and Q20), not a persona default. | — |
| Q14 | Answered ✅ (2.1.296): `claude -p` and a stream-json session, in a repository folder never visited and without a trust prompt, load the managed CLAUDE.md, the managed rules, the managed output style and the managed subagents, then the user's and the project's CLAUDE.md, each once and in that order; a terminal in a folder whose trust was accepted does the same. 🔬 A terminal in a folder whose trust dialog was never accepted, and the user's own style choice. | Sandbox test |
| Q15 | Answered ✅ for `claude -p --resume` (2.1.296), which is what a chat session's wake does: the resumed process starts on the persona's current model and effort; the resume message carries the current managed instructions, the current default style and the current subagents; the old messages keep what they said. 🔬 `claude --resume` in a terminal, and compaction (Chat sessions Q8). | Sandbox test |
| Q16 | Which version first supports each part in §10.2's second row? It matters only if foundation Q8 lowers the minimum below 2.1.296. | Engineering (changelog) |

## 22. Identity and agent self-edit (A10, interface I11)

The owner's words: the Claude inside a session "can also adjust itself, including names, and if the model supports
image generation, put its avatar there". A persona has a **name** (the pool's, shown everywhere), an **avatar**
(none is valid: initials on a colour made from the name) and **two switches**; the agent in a workspace can
**propose** changes to its own persona; a person decides.

- **Who and what.** An agent's per-session token (Portal MCP I8) is bound to one workspace and one session. "Its
  own persona" is the one that workspace has. There is no argument to name another persona, workspace or session:
  the tools read all three from the token, and unknown arguments are dropped (✅ checked on a real session).
- **Switches.** The portal-wide setting `agents.selfEdit` ("Agents may propose changes", default off, turning it
  on asks for confirmation) decides whether any proposal is accepted. Per persona: "Agents may propose changes"
  (default off, only offered while the portal switch is on) and "Auto-approve name and avatar" (default off): a
  name or an avatar then applies at once and is recorded as decided by `auto`. Instructions never auto-approve,
  whatever the switches say. Turning proposals off turns auto-approval off.
- **Tools** (Portal MCP, scope `agent`, never destructive, a rate limit and a size cap each):
  `persona_get_self` (the persona's name, instructions, styles, subagents, defaults, whether proposals are
  allowed, and the session's own waiting proposals; its text is labelled untrusted),
  `persona_propose_update` (`name`, `instructions_patch` with `append` and `replace` pieces that each name text
  occurring once, and a `reason`; everything is checked before anything is recorded, and each part is its own
  proposal) and `persona_set_avatar_proposal` (an image as `workspace_path` in the home folder, `blob_id` of a
  file the session has, or `image_base64` up to 192 KB). Ten proposals an hour per session, ten waiting per
  persona, 8 KB of edits, FR8's checks on every text.
- **Proposals are records, not revisions.** A proposal is stored with its reason, actor and what it would do. It
  is never live. Approving one applies it: a name renames the pool, an avatar is set, instructions publish a new
  revision built from the text that is **current then**, with the proposer and the reason in its note. So a
  rejected or stale proposal never reaches the history, and an edit is always checked against what it changes:
  if the text it names is gone, or the name is taken, the proposal is **stale** and can only be rejected.
- **Avatar pipeline.** §16. A person uploads in the editor (the file's bytes go to `POST /api/personas/pools/<id>/avatar`);
  an agent offers a file. Either way the stored image is the portal's own PNG: square, at most 512 px, at most
  256 KB, no metadata, content-addressed by its own hash, served as an immutable image with `nosniff` and a
  policy that allows nothing else.
- **Display.** One component, `PersonaAvatar` (`apps/web/src/features/personas/PersonaAvatar.tsx`): the image, or
  initials, and the name when asked; with `usePersonaOf(workspaceId)` and `GET /api/personas/identities` so lists
  show it without a request per row. Chat shows it in the session header, the Sessions rows and the transcript's
  attribution; tickets on assignee chips (their owners' work).
- **Review.** §15. One tap approves or rejects; the diff is against the current text.
- **Not built:** proposals for skills (Skillset's), image generation (the portal generates nothing: it only takes
  an image the session already has), a persona-wide notification when a proposal arrives.
