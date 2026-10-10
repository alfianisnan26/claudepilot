# PRD: Skillset pool

| | |
| --- | --- |
| Status | **Draft v0.6** (consistency pass: base drop-in, hooks, verification and prefixes aligned with the foundation's ownership registry). Written from research on the Claude Code 2.1.296 docs and the codebase. Facts the research summaries didn't cover were checked in the doc pages linked next to them. Plugin-loading results marked ✅ come from the [MCP set](mcpset-pool.md) sandbox run and the cross-pool lab (print mode); nothing skill-specific has run in a sandbox yet. Items marked 🔬 need a check before the milestone that depends on them. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-10 |
| Depends on | [Pools foundation](foundation-pools.md) (storage, revisions, assignment, delivery engine, plugin marketplace, outbox) |
| Related | [Persona pool](persona-pool.md) (subagents, output styles), [MCP set pool](mcpset-pool.md) (shared marketplace), [Settings & policies](settings-policies.md) (skill policy keys, hardened image), [Monitoring dashboard](monitoring-dashboard.md), [Portal MCP server](portal-mcp.md), [Chat sessions](chat-sessions.md) (reload in chat) |

## 1. Summary

A skillset is a named, versioned set of Claude Code skills, assigned to any number of workspaces.
Admins import skills from an upload, a git repository pinned to a commit, Anthropic's public skills
repository or a plugin marketplace. Every skill version is reviewed in the portal before it can reach
a workspace, and a skill that carries scripts needs explicit approval of each one.

Each assigned skillset reaches Claude Code natively, as one generated plugin in the portal's local
marketplace, enabled by a managed settings drop-in. Plugin skills are namespaced (`/frontend:review`),
so a set never shadows a repository's skills, a user's own skills or another set. Workspaces never
fetch anything. The portal is the only fetcher, and it pushes pinned, reviewed files.

## 2. Background and problem

- A skill is a folder with a `SKILL.md` plus optional reference files and scripts. Claude loads it when
  it's relevant or when a user types `/name`. Today skills are copied into containers by hand, so they
  drift and nobody sees which workspace has which version.
- Skills run code: bundled scripts, shell commands that run while the skill renders (`` !`cmd` ``, no
  permission prompt), hooks and pre-approved tools. Anthropic says to use skills "only from trusted
  sources" ([overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)).
  Snyk found critical issues in 13.4% of 3,984 public registry skills, and 76 confirmed malicious
  payloads ([ToxicSkills](https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub)).
- Claude Code doesn't sync claude.ai skills where an API key or `apiKeyHelper` supplies the credential,
  as in Account Pool workspaces ([skills](https://code.claude.com/docs/en/skills#where-synced-skills-load)).
  Delivery must work on all three targets, running or stopped, without the cluster reaching the portal.

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Curated sets.** Build named skillsets from imported skills and assign several to a workspace. Changing a workspace's skills never requires recreating it. |
| G2 | **Pinned sources.** Import from an upload, a git repository, Anthropic's skills repository or a plugin marketplace. Every import is pinned to an immutable hash. Nothing updates by itself. |
| G3 | **Reviewed code only.** No skill version reaches a workspace without approval. Scripted skills need approval of each script. A revoked skill leaves every running workspace within minutes. |
| G4 | **Native delivery.** Skills load as one Claude Code plugin per set, on all three targets, running or stopped, with no fetching inside the workspace. |
| G5 | **Visibility.** Admins and workspace users see which skills a workspace has, at which version, whether Claude Code can load them, and why not. |
| G6 | **No collisions.** Sets never shadow repository, personal or other sets' skills. Name conflicts, an overfull skill listing and policy conflicts are flagged before delivery. |

## 4. Non-goals

- **Subagents, output styles, CLAUDE.md and rules** ([Persona](persona-pool.md)) and **MCP servers**
  ([MCP set](mcpset-pool.md)). See §6.
- **Other plugin components.** Import lists them as "Not imported" and drops them: `agents/` and
  output styles (Persona; re-create them there), `.mcp.json` (MCP set), hooks and mods, monitors and
  LSP servers (they run unprompted, outside the sandbox), `bin/` (commands Claude runs by name),
  workflows, `settings.json` and a root `CLAUDE.md` ([components](https://code.claude.com/docs/en/plugins/components)).
- **Native binaries and compiled bytecode.** They can't be reviewed, and workspaces run on amd64 (k3s)
  and arm64 (Docker Desktop on the Mac). v1 refuses them (FR5).
- **Installing what skills need at runtime** (Python packages, LibreOffice). Review lists declared
  requirements; the workspace image provides them.
- **Editing skills in the portal**, skill evals, and syncing with claude.ai or the Skills API.
- **Changing a user's own skills** (`~/.claude/skills/`, including `synced/`) or a repository's
  `.claude/skills/`. The portal points out hand-copied duplicates (FR19) but never deletes them.
- **Enforcement on the standard image,** whose users have `sudo`. Managed delivery is a default with
  drift repair; the hardened image ([Settings & policies](settings-policies.md) §14) makes it binding.
- **Public registries as trust.** Stars, installs and rankings don't replace review.

## 5. Users and stories

**Admin**: runs the portal, imports and reviews skills, builds sets. **Workspace user**: uses `claude`
in a terminal or a portal chat session. Today these are often the same person.

| ID | Story |
| --- | --- |
| US1 | As an admin, I upload a zip or folder of skills and see every file, script and finding before anything is delivered. |
| US2 | As an admin, I import skills from a git repository at a tag or commit, and the portal pins the exact commit. |
| US3 | As an admin, I browse Anthropic's skills repository or a plugin marketplace, pick skills, and see each one's license. |
| US4 | As an admin, I review a scripted skill file by file and approve it explicitly. A text-only skill needs one click. |
| US5 | As an admin, I build a skillset, set each skill to On, Manual or Off, and preview the generated plugin. |
| US6 | As an admin, I assign skillsets when creating a workspace, later, or in bulk, and turn single skills off for one workspace. |
| US7 | As a workspace user, I type `/frontend:review`, or `/review` while no other command uses that name ([skills](https://code.claude.com/docs/en/skills#how-a-skill-gets-its-command-name)). Claude also picks skills up when relevant. No setup. |
| US8 | As an admin, I check a source for updates, read the diff, and approve the new version before any workspace gets it. Pinned workspaces stay where they are. |
| US9 | As an admin, I revoke a skill version, and it disappears from every workspace, pinned ones included. |
| US10 | As an admin or workspace user, I see a workspace's skills, their versions, whether Claude Code can load them, copies installed by hand, and any conflict, budget or policy warning. |

## 6. Scope boundary

| A skillset delivers | Delivered by another pool, or not at all |
| --- | --- |
| Skills: folders with `SKILL.md`, reference files, templates and scripts | Subagents (`agents/`), output styles, CLAUDE.md, rules, `claudeMd`, `agent`, model defaults → Persona |
| Skill-style slash commands (`commands/**/*.md`), converted to skills | MCP servers (`.mcp.json`, MCPB bundles) and their secrets → MCP set |
| Skill frontmatter, including `allowed-tools`, `hooks`, `context: fork` and `agent`, reviewed as code | Skill policy (`disableSkillShellExecution`, `Skill(...)` rules, `strictKnownMarketplaces`) → Settings & policies. `skillOverrides` doesn't apply to plugin skills; per-skill control is FR13 or a `Skill(...)` deny rule. Hooks, monitors, LSP servers, `bin/` → nobody in v1 |

Why skills and commands live here, and subagents and output styles live in Persona:

1. **Loading.** A skill costs only its name and description until invoked. Most persona content is
   always on (system prompt, CLAUDE.md, output style), and subagents run in their own context.
2. **Cardinality.** A workspace has several skillsets and one persona. Skills add up; a persona replaces.
3. **Risk.** Skills ship code and get code review (§11). Persona items are instructions and defaults.
4. **Same shape.** Claude Code merged custom commands into skills: `.claude/commands/deploy.md` and
   `.claude/skills/deploy/SKILL.md` both create `/deploy` ([skills](https://code.claude.com/docs/en/skills)).
5. **Links by name only.** A forked skill can name a persona subagent as its `agent`; persona
   subagents never preload skills ([Persona](persona-pool.md) §6). The compiler warns on a missing agent.

## 7. Solution overview

```
 Portal                                             Workspace (any target)
 ┌──────────────────────────────────┐               ┌──────────────────────────────────────────┐
 │ Sources at pinned hashes         │               │ /etc/claudepilot/marketplace/            │
 │ Import: unpack, validate, scan   │   push via    │   .claude-plugin/marketplace.json        │
 │ Library: skill versions, blobs   │  runtime API  │   plugins/<prefix>/<hash12>/skills/…     │
 │ Review: approve, reject, revoke  │ ────────────▶ │ /etc/claude-code/managed-settings.d/     │
 │ Skillsets (foundation revisions) │               │   60-claudepilot-skills.json             │
 │ Compiler: one plugin per set     │               │     enabledPlugins: <prefix>@claudepilot │
 │ Verifier, drift check            │ ◀── exec ──── │ claude plugin details, tree-hash         │
 └──────────────────────────────────┘               │ claude (unmodified) → /<prefix>:<name>   │
                                                    └──────────────────────────────────────────┘
```

Flow: import at a pinned hash (§8), review per content hash (§11), skillset revision, delivery (§10),
verification inside the workspace (FR21).

## 8. Functional requirements

### Sources and import

- **FR1** Upload a `.zip`, or a folder on desktop browsers (30 MB uncompressed, 5,000 files, ratio
  100:1). The portal finds `SKILL.md` folders, plugins and marketplaces up to four levels deep. Command
  files become skills named after their path; the import summary shows each old and new command
  (`/frontend:component` → `/<prefix>:frontend-component`).
- **FR2** Git: HTTPS URL, ref (tag, branch or commit), optional subpath and read token. The ref
  resolves to the full commit SHA, and both are stored. Shallow fetches without submodules, LFS or
  hooks go to a temporary folder, deleted after import. The token reaches git only through a one-shot
  `GIT_ASKPASS` helper, never the URL, arguments, `.git/config` or logs. git runs with
  `http.followRedirects=false`, `https` only, and the SSRF-approved address pinned (`http.curloptResolve`).
- **FR3** Anthropic skills: a built-in source for `github.com/anthropics/skills`, read through its
  `marketplace.json` at a pinned commit, including `strict: false` entries that list skill paths.
- **FR4** Marketplaces: built-in `anthropics/claude-plugins-official` and `anthropics/claude-community`,
  or any git repository or `marketplace.json` URL. Plugin sources resolve to a relative path; `github`,
  `url` or `git-subdir` at the entry's `sha` or the resolved commit; `npm` at an exact version and
  integrity hash; or HTTPS `archive` with `sha256`. `command` sources are refused. Only skills and
  commands are imported, from the paths the manifest or entry declares (default `skills/`, `commands/`).
- **FR5** Refused: frontmatter that fails YAML 1.2 core-schema parsing (no custom tags, at most 100
  aliases and 64 KB); names with `:`, `/`, whitespace or control characters; `synced` and
  `anthropic-skills`, reserved by Claude Code for claude.ai skills ([skills](https://code.claude.com/docs/en/skills#where-skills-live));
  paths that leave the skill folder (`..`, absolute paths, outward symlinks, device files; inward
  symlinks become copies); native executables and compiled bytecode (`.pyc`, `.class`, `.jar`,
  `.wasm`). Warned: other [Agent Skills](https://agentskills.io/specification) name-rule breaks,
  `description` plus `when_to_use` over 1,536 characters (truncated), `SKILL.md` over 500 lines.
- **FR6** A skill version is immutable, identified by its tree hash: SHA-256 over one
  `<mode> <path>\0<sha256>\n` line per file, with paths NFC-normalized and sorted bytewise, and modes
  normalized to `0644` or `0755`. Identical content reuses the version and its review.
- **FR7** With a Docker target configured, a throwaway, network-less container checks each compiled
  revision with `claude plugin validate <dir> --json` (errors block) and
  `claude --plugin-dir <dir> plugin details <prefix>` (shown as text,
  [plugin CLI](https://code.claude.com/docs/en/plugins/cli-reference)), on the oldest Claude Code
  version among assigned workspaces ("Validated on 2.1.296"). Each version's image is built before any
  skill content is copied in.
- **FR8** Check for updates, on demand or daily: re-resolve the ref, import changed skills as versions
  waiting for review, and diff them against the versions in use. Nothing updates itself.

### Review, skillsets and revisions

- **FR9** Scan every version (§11.1); show each file's kind, size, mode and interpreter, the findings,
  declared requirements and license files. A skill without a recognized open-source license needs the
  reviewer's confirmation, stored with the review (anthropics/skills calls its skills "for demonstration
  and educational purposes", and its document skills are source-available, Q8).
- **FR10** Approve or reject per §11.2; revoke per §11.3. Only approved versions leave the portal.
- **FR11** Reviews belong to the tree hash, so an approved version joins any set without a new review.
- **FR12** A skillset has a name, description, command prefix and skill versions. The prefix is the
  plugin name: kebab-case, unique across portal plugins, not starting with `claude-`, `anthropic-`,
  `anthropics-`, `cc-plugin-` (refused by `claude plugin validate`), `cpm-` (MCP sets) or `cpb-`
  (Browser & desktop). Renaming it
  renames every command; the editor shows how many workspaces that affects. Skill names are unique in a
  set, and each skill is written to `skills/<name>/` with frontmatter `name` equal to the folder.
- **FR13** Per skill: **On** (as authored), **Manual** (`disable-model-invocation: true`, and
  `user-invocable: false` cleared: only a typed `/name` runs it, and its description leaves the
  listing) or **Off**. A skill with `allowed-tools` gets "Remove pre-approved tools", labelled
  "Removes pre-approval only. Injected commands still need review." Outside auto mode, an injected
  command that no rule allows then aborts the skill; in auto mode, Claude is told to run it under auto
  mode's checks ([skills](https://code.claude.com/docs/en/skills#permission-checks-on-injected-commands)).
  Bypass mode is 🔬 (Q12).
- **FR14** Saving creates a foundation revision with a note. It becomes current once every skill it
  turns on is approved; until then the set shows "r8 waiting for review" and workspaces keep r7.
  Turning a skill off never waits.
- **FR15** "Update to v…" moves a skill to a newer version from its source, with the diff. Duplicate
  asks for a new prefix. Delete is blocked while the set is assigned.

### Assignment, policy and conflicts

- **FR16** Assign any number of skillsets: in the create dialog's Add-ons, the Configuration panel or
  in bulk. Follow the current revision (default) or pin one. Per-assignment overrides set a skill Off
  or Manual for one workspace. Delivery follows §10 on all three targets, running and stopped.
- **FR17** Run the §12 checks when assignments change and at compile time. They warn; none blocks.
- **FR18** Apply the workspace's effective [Settings & policies](settings-policies.md). Under
  `disableSkillShellExecution`, injected commands become `[shell command execution disabled by policy]`,
  so the assign dialog and Skills row warn "Shell commands disabled by policy: 3 skills won't run as
  written". Under `allowManagedPermissionRulesOnly`, the compiler strips `allowed-tools` from every
  delivered skill (🔬 Q13), and the row says injected commands now need a managed allow rule.
- **FR19** Hand-copied skills: on assignment and at each verification, `exec` as the workspace user
  lists names and tree hashes (never content) in `~/.claude/skills/` (not `synced/`) and
  `/etc/claude-code/.claude/skills/`. Matches with a delivered skill show as "Also installed by hand:
  2 skills" with paths and a copyable `rm -r`. Only matches are stored; the portal never deletes them.
- **FR20** Skillsets need Claude Code at or above the version verified in the M1 sandbox (2.1.296
  today). Below it the fragment is left out, and the row shows "Claude Code 2.1.2xx is too old for
  skillsets · Update Claude Code" (foundation §9). Each FR13 transform and hook entry declares a
  minimum version, and a workspace below it doesn't get the set: Claude Code silently ignores
  frontmatter it doesn't know, so nothing may fall back quietly.

### Verification and inventory

- **FR21** Verify each delivery to a running workspace through `exec` as the workspace user, with two
  CLI subcommands that start no session and make no model request (🔬 Q3 for hooks):
  `claude plugin details <prefix>@claudepilot`, whose skills must equal the compiled ones (✅ lists a
  portal plugin's components, [MCP set](mcpset-pool.md) FR16), and `claude plugin list --json`,
  which reports each managed plugin's `readFromFolder`, `folderVersion` and `errors` ✅ (cross-pool
  lab). The folder must be the current version folder; `version` isn't compared, because it keeps its
  install-time value after a repoint ✅. The list also names enabled plugins from other marketplaces
  that use a prefix (§12). Claude Code's own plugin records in `~/.claude/plugins/` are read only
  through these commands, never opened or edited (foundation §2). Results: Verified, Mismatch, Load
  error (with Claude Code's message), or Not verified: stopped, or no session yet, since both
  commands report the marketplace as not configured until a session has registered it ✅.
- **FR22** A deeper `system/init` check turns on only after Q3 shows that `claude -p /reload-plugins`
  makes no API request, with or without credentials. It runs with `CLAUDE_CONFIG_DIR=$(mktemp -d)`,
  an empty temporary working folder, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and
  `CLAUDEPILOT_VERIFY=1` (§18 A7). Each set must be in `plugins` (source `<prefix>@claudepilot`,
  expected path) and not in `plugin_errors`, which is omitted when empty ([headless](https://code.claude.com/docs/en/headless));
  each skill in `skills`, or Manual ones in `slash_commands` (🔬 Q3). Only entries under assigned
  prefixes are stored. Portal chat sessions report the same fields from their own `system/init`.
- **FR23** When 2 workspaces, or 10% of those reached (whichever is more), report Load error for one
  set revision, its rollout pauses; the rest keep their revision, and the set and Monitoring show "r8
  paused: Load error on 2 workspaces · Resume · Roll back". One Load error offers "Pin this workspace
  to r7". Mismatch and timeouts (20 s) retry once at the next reconcile before they're reported; Not
  verified re-runs when the workspace starts.
- **FR24** Show each workspace's skills: set, revision, `/<prefix>:<name>`, mode, Scripted badge, short
  hash, verification result and time, §12, FR18 and FR19 warnings; also through [Portal MCP](portal-mcp.md)
  (read only, §14). After a change, say that open sessions need `/reload-plugins` or a restart (§10.4).

## 9. Data model

Stored in the portal's database ([Pools foundation](foundation-pools.md)). Skillsets are `pools` of
type `skillset`. File contents live in a content-addressed blob store (§18 A5).

| Table | Key fields |
| --- | --- |
| `skill_sources` | id, kind (`upload` \| `git` \| `anthropic` \| `marketplace`), label, url, ref (as entered), subpath, marketplace_name, plugin_name, token (encrypted, nullable), resolved (commit SHA, npm version or sha256), checked_at, latest_seen, removed_at |
| `skill_versions` | id, source_id, name, path_in_source, tree_hash, frontmatter (json), license, size_bytes, file_count, scripted, risk (`low` \| `medium` \| `high`), findings (json), listing_chars, imported_at |
| `skill_files` | version_id, path, blob_sha256, size, mode, kind (`skill_md` \| `markdown` \| `text` \| `script` \| `asset`), interpreter |
| `skill_reviews` | tree_hash, decision (`approved` \| `rejected` \| `revoked`), note, acknowledged (json: finding IDs and the license confirmation), session, at |
| `pool_revisions.content` | `{ prefix, description, skills: [{ version_id, tree_hash, mode (on \| manual \| off), strip_allowed_tools }] }` |
| `assignments.options` | `{ skills: { "<name>": "off" \| "manual" } }` (§18 A4) |
| `skill_inventory` | workspace_id, observed_at, method (`details` \| `init`), status (`verified` \| `mismatch` \| `error` \| `not_verified`), plugins (json: name, source, path, errors), skills (json: delivered names only), hand_copied (json: path, name, match) |
| `skill_usage` (M5) | bucket_start_utc, workspace_id, skill, via (`claude` \| `user`), count (kept 13 months) |

Reviews are never edited: a new decision is a new row, and the latest one for a tree hash decides.
The Claude Code version comes from the foundation's `workspace_delivery.claude_version`.

## 10. Delivery into Claude Code

### 10.1 Plugins, not the managed skills folder

Claude Code offers two native routes for shared skills, and this PRD uses plugins
([skills](https://code.claude.com/docs/en/skills), [plugin loading](https://code.claude.com/docs/en/plugins/loading),
[plugins for organizations](https://code.claude.com/docs/en/plugins/org)).

| | One plugin per set in the portal marketplace (chosen) | Managed skills folder `/etc/claude-code/.claude/skills/` |
| --- | --- | --- |
| Command | `/<prefix>:<name>`; bare `/<name>` also works while no other command uses it | `/<name>` |
| Same name elsewhere | Both load, because plugin skills are namespaced | Enterprise beats personal beats project, so a set would override the repository's and the user's own skill of that name |
| Two sets, same skill name | Both load | The portal has to pick one |
| Open sessions | Next session or `/reload-plugins` (documented) | 🔬 Not in the documented list of watched folders (Q14) |
| `disableSkillShellExecution` | Covers plugin skills | Doesn't cover managed skills |
| Machine-readable check | `claude plugin details`; `plugins`, `plugin_errors` and `skills` in `system/init` | `skills` in `system/init` only |

### 10.2 What gets written

| Path in the workspace | Content |
| --- | --- |
| `/etc/claudepilot/marketplace/plugins/<prefix>/<hash12>/` | The compiled plugin for one set: `.claude-plugin/plugin.json` (`name: <prefix>`, `version: <revision>.0.0+<hash8>`, description) and `skills/<name>/…` with the version's files and the FR13 and FR18 transforms. `<hash12>` is the compiled tree hash. `version` only labels the revision: it doesn't pin a plugin loaded in place ([manifest](https://code.claude.com/docs/en/plugins/manifest-reference#version)). |
| `/etc/claudepilot/marketplace/.claude-plugin/marketplace.json` | The foundation's catalog (`name: claudepilot`), registered by the foundation as a directory marketplace with `autoUpdate: false` and compiled from every owner's entries (§18 A2). The skillset fragment adds one entry per set: `{"name": "<prefix>", "source": "./plugins/<prefix>/<hash12>", "description": …}`. |
| `/etc/claude-code/managed-settings.d/60-claudepilot-skills.json` | `enabledPlugins`: `"<prefix>@claudepilot": true` per assigned set, and `false` for a set whose files may still be present after unassignment or revocation, until a reconcile confirms they're deleted. `permissions.deny`: `Skill(<prefix>:<name>)` and `Skill(<prefix>:<name> *)` for each revoked skill, kept 14 days (§11.3). From M5, the §15 hooks. |

- **Ownership.** The workspace user can't write delivered skill files: they're `root:root` on Docker
  and on the standard Kubernetes image, and the hardened image mounts them read-only (§10.3). Files are
  `0644`, files the review marked executable `0755`, folders `0755`; setuid, setgid and sticky bits
  are dropped. Otherwise a process running as that user could add `hooks/hooks.json` to a
  force-enabled plugin, and its hooks would run even under `allowManagedHooksOnly`
  ([settings](https://code.claude.com/docs/en/settings-reference#allowmanagedhooksonly)).
- **Precedence.** A managed `true` force-enables `<prefix>@claudepilot` over a user-scope value for
  that key, and a managed `false` blocks it at every scope. Another enabled plugin with the same
  manifest name doesn't load ([name conflicts](https://code.claude.com/docs/en/plugins/loading#name-conflicts)).

### 10.3 Per target

| | Docker (DinD and host) | Kubernetes |
| --- | --- | --- |
| Running | The archive API writes the version folder under a temporary name, `root:root`, and one `exec` as root renames it (foundation §6.2). The catalog and drop-in are then swapped by temp file and rename. | A streamed `exec sudo tar --no-same-owner -x` unpacks into a temp folder on the `ws-<name>-pools` volume, then renames it. In the hardened image the `claudepilot-sync` sidecar runs the same `tar` without `sudo`. Then the catalog on the volume (temp file and rename), then the drop-in through the Secret and `sync.sh`. |
| Stopped | The archive API writes the same files into the stopped container, folder first ✅ (foundation). The start reconcile confirms them with `tree-hash`. | Only the drop-in in the Secret changes, for unassignment and revocation (§11.3). New sets and revisions arrive at the start reconcile. |

Kubernetes needs the volume because a Secret holds at most 1 MiB ([Kubernetes](https://kubernetes.io/docs/concepts/configuration/secret/)),
which skills with scripts and reference files exceed. `sync.sh` never touches the volume (§18 A6).

### 10.4 When changes apply

| Change | Files in the workspace | New `claude` sessions | Open sessions |
| --- | --- | --- | --- |
| Assignment or per-workspace override | At once: the change triggers a reconcile | Load the new state at start | Keep what they loaded until `/reload-plugins` |
| New current revision | Next reconcile, at most 20 workspaces a minute (foundation §6.3) | Load the new state at start | Keep what they loaded until `/reload-plugins` |
| Revocation | Removed at once, ignoring pins and the rollout limit (§11.3) | Don't load it | The deny rule applies at once, since managed settings reload live (Q4 for a typed command); the listing entry stays until `/reload-plugins` |

- Plugin changes apply "at the next session start or `/reload-plugins`" ([plugin loading](https://code.claude.com/docs/en/plugins/loading)).
  Skillset plugins carry no MCP servers, so `/reload-plugins` applies them without `--force`
  ([plugin CLI](https://code.claude.com/docs/en/plugins/cli-reference#reload-plugins)). The portal can't
  type into terminals, so the workspace shows "Skills changed at 10:42. Run /reload-plugins in open
  sessions" for an hour. Open portal chat sessions show "Skills changed · Reload": Reload sends
  `/reload-plugins` at a turn boundary, never mid-turn, and reads plugins and skills from the next
  `system/init`; a sleeping session reloads when it wakes ([Chat sessions](chat-sessions.md) A9, 🔬 its Q6).
- `claude -p` loads a portal-marketplace plugin in its first session ✅ (MCP set A3); interactive
  sessions are 🔬 (Q1). Skill content already in a conversation stays there until a new conversation.

### 10.5 Write order, retention, drift and fallback

| Topic | Rule |
| --- | --- |
| Order | New version folders first, under new names so a loading session never sees a half-written tree; then the catalog; then the drop-in (temp file and rename); then verification (FR21). A drop-in adds a plugin entry only after the folder it references is complete; removing entries is always allowed. Unassigning reverses the order. |
| Retention | Keep the previous two versions of each plugin and any version younger than 14 days, at most 10 per set, for sessions that loaded them; Claude Code keeps its own old plugin versions 14 days too ([plugin loading](https://code.claude.com/docs/en/plugins/loading#cleanup-of-previous-versions)). Revocation still deletes at once. |
| Repointing | ✅ The next session loads the new version folder of a repointed `marketplace.json` entry (cross-pool lab, print mode). 🔬 Whether `/reload-plugins` does too is Q2. If it doesn't, each plugin keeps one stable path: write `plugins/<prefix>.<hash12>/`, then `ln -sfn` a temporary link and `mv -T` it over `plugins/<prefix>`; Q2 also confirms that loading follows the link. |
| Drift | The foundation's manifest check can't see changed or extra files in a tree of up to 5,000 files. The `tree-hash` helper computes each version folder's FR6 hash inside the workspace, through `exec`, every 10 minutes and at start. A mismatch or an unexpected file (such as a new `hooks/hooks.json`) is drift, and the folder is rewritten. |
| Fallback | If the directory marketplace doesn't load without prompts in a container (Q1), the compiler writes `/etc/claude-code/.claude/skills/<prefix>-<name>/` instead, with `name` rewritten to the folder name. The choice is portal-wide, never per workspace, and the Skills row shows each command as delivered (`/<prefix>-<name>`). These skills outrank same-named personal and project skills, aren't covered by `disableSkillShellExecution`, and are verified only by `skills` in `system/init`. 🔬 If a plugin folder there loads as `<prefix>@skills-dir` (Q14), that becomes the first fallback and keeps namespacing. On Kubernetes the folder is a second mount of the pools volume (`subPath: managed-skills`), which sees later writes, unlike a Secret `subPath`. |

## 11. Review and trust

### 11.1 Findings

The scanner is deterministic, runs in the portal and needs no network. Its categories follow
Anthropic's risk tiers ([Skills for enterprise](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/enterprise)).
Patterns err toward flagging: a false positive costs the reviewer one tick.

| Tier | Finding | Why it matters |
| --- | --- | --- |
| High | Executable file: exec bit, shebang, or `.sh .bash .zsh .fish .py .js .cjs .mjs .ts .tsx .rb .pl .php .lua .ps1 .bat .cmd` | Claude runs it with the workspace user's rights |
| High | Injected command: any `!` followed by a backtick, and any `` ```! `` fence, in any `.md` file of the skill | Runs while the skill renders, before Claude sees it, without a prompt ([skills](https://code.claude.com/docs/en/skills#inject-dynamic-context)) |
| High | Frontmatter `hooks` | Registered when the skill runs and kept for the rest of the session ([hooks](https://code.claude.com/docs/en/hooks#hooks-in-skills-and-agents)) |
| High | Broad `allowed-tools`: `Bash`, `PowerShell`, `Write`, `Edit`, `WebFetch`, `mcp__*`, unscoped patterns | Pre-approves those tools for the invoking turn, even in untrusted folders |
| High | MCP server or tool references in instructions: `mcp__…`, "use the … server" | Steers Claude to tools outside the skill |
| High | Network or remote code: `curl`, `wget`, `nc`, `ncat`, `socat`, `ssh`, `scp`, `rsync`, `\| sh`, `\| bash`, `pip install`, `npm install`, `npx`, `uvx`, `bunx`, `requests.`, `urllib`, `fetch(`, `axios`, `Invoke-WebRequest` | Downloads code or sends data. 21% of malicious samples used `curl \| bash` (Snyk) |
| High | Credential material: `BEGIN … PRIVATE KEY`, `sk-ant-`, `ghp_`, `github_pat_`, `AKIA`, `xox[abp]-`, `.env` files | Leaks a secret, or signals a hostile skill. Can't be acknowledged (§11.2) |
| High | Instruction manipulation: "ignore previous instructions", "ignore all prior", "disregard the above", "do not tell the user"; bidirectional, zero-width and tag characters; instructions in HTML comments | Prompt injection in text Claude follows |
| Medium | Paths outside the skill: `../`, `~/.ssh`, `~/.aws`, `~/.claude`, `/etc` | Reaches beyond the skill folder |
| Medium | Writes to `${CLAUDE_SKILL_DIR}` or to relative paths inside the skill | Delivered folders are read-only; the skill should use `${CLAUDE_PLUGIN_DATA}` |
| Medium | `context: fork` with `agent`, `model`, `effort` | Changes who runs it, the cost and prompt cache use |
| Medium | Vendored dependencies, archives, minified files, files over 1 MB | Too large or dense to read line by line |
| Low | Spec warnings from FR5 | Loads, but may be truncated or misbehave |

A version is **scripted** when it has an executable file, an injected command or `hooks`.

### 11.2 Approval

- Approval is always an explicit action; nothing is approved on import. No High findings: one Approve
  click. Any High finding: the reviewer opens and ticks every flagged item (each script in full, each
  injected command, hook, pre-approval and MCP reference) and writes a note; only then does Approve
  enable. A credential finding can't be acknowledged: reject the version, or re-import without the file.
- Reject requires a note. An update is a new version with its own review, shown first as a diff
  against the version it replaces ("treat every update as a new deployment", Anthropic).
- Import, approve, reject and revoke happen only in the portal UI (§14). With one shared admin
  sign-in, approvals are recorded by session, and nothing makes the reviewer differ from the importer (Q6).

### 11.3 Revocation

Revoking recompiles every workspace without the version, ignoring pins and the rollout limit.
Revisions that contain a revoked version can't become current again.

| Workspace | What happens |
| --- | --- |
| Running, any target | The new version folder, catalog and drop-in (with `Skill(...)` deny rules for 14 days) are written, then every folder that contains the revoked version, retained ones included, is deleted |
| Stopped, Docker | The archive API writes the recompiled version folder, catalog and drop-in, then empties the revoked files; the next start deletes them |
| Stopped, Kubernetes | The Secret's drop-in sets the set to `false` and adds the deny rules at once. After the pod starts, the start reconcile writes the new version, deletes the old folders and turns the set back on |

M2 ships recompiling and deleting; M5 adds the deny rules.

## 12. Conflicts and the skill listing

| Situation | What Claude Code does | What the portal does |
| --- | --- | --- |
| Same skill name in two assigned sets | Both load, as `/a:x` and `/b:x`. 🔬 Which one bare `/x` runs is undocumented (Q4) | Warns on the workspace and lists both full names |
| Same content (tree hash) in two assigned sets | Both load, and the listing pays twice | Warns and suggests keeping it in one set |
| A set's skill shares a name with a repository, personal or built-in skill or command | Both load. The other keeps the bare name, and the set's skill runs as `/<prefix>:<name>` ([skills](https://code.claude.com/docs/en/skills#how-a-skill-gets-its-command-name)) | Nothing to fix. The inventory always shows the full command |
| The same skill was also copied by hand | Both load, as `/<name>` and `/<prefix>:<name>`, and the listing pays twice | FR19 shows the copy and how to remove it |
| A forked skill names an `agent` that isn't built in (`Explore`, `Plan`, `general-purpose`) or in the workspace's persona | The named agent isn't available | Warns at compile time |
| Another enabled plugin uses a set's prefix as its name | The managed plugin loads; the other doesn't (§10.2) | FR21 names the plugin that didn't load |

**Listing budget.** The skill listing always holds every name, but descriptions share a budget that
"scales at 1% of the model's context window", "with a fallback of 8,000 characters". Over budget,
Claude Code drops descriptions "starting with the skills you invoke least", so Claude stops choosing
them ([skills](https://code.claude.com/docs/en/skills#skill-descriptions-are-cut-short),
[env vars](https://code.claude.com/docs/en/env-vars)). The portal estimates each workspace's share
(name, `description` and `when_to_use`, capped at 1,536 characters, for skills Claude can invoke) and
warns at 75% of the budget for the workspace's default model. 🔬 The docs don't say whether "1%"
counts characters or tokens (Q11); until checked, the estimate assumes 4 characters per token. The
warning suggests Manual for rarely used skills, which takes their descriptions out of the listing.
The browser pool's skill counts too ([Browser & desktop](browser-desktop-pool.md) §11.1); repository
and personal skills aren't counted.

## 13. User experience

All screens use existing components (PageHeader, PageTabs, Section, Card rows, Badge, Menu,
FormDialog, DiscardDialog, ConfirmDialog, Select, Segmented, ChipGroup, SwitchRow, CopyButton,
EmptyState, LoadError, RowsSkeleton) and work on phones and desktops. New: a read-only file viewer
(monospace, line numbers, highlighted findings, 500 lines at a time), a diff view, an upload drop zone,
and the Meter bar promoted from WorkspacesPage. Skill files show as plain text, never rendered HTML.
Routes sit under the Pools hub (§18 A8, adopted in [Web app](web-app-pwa.md) §8); the editor and the
review page are `task` routes on phones (its §9.2).

| Screen | What it shows |
| --- | --- |
| Skills tab (`/admin/pools?tab=skills`) | A card per set: name, `/prefix:`, revision chip, "r8 waiting for review" or "r8 paused", "12 skills · 3 scripted", "Used by N workspaces", the listing estimate, and a menu (Edit, Duplicate, Assign…, Delete). The header holds New skillset, Import and "Library · 3 to review". |
| Library (`/admin/pools/skills/library`) | A row per skill version: name, source chip, short hash, badges (Scripted, Network, Hooks), review state (Approved, Needs review, Rejected, Revoked) and "In N sets", with filters for Needs review and Scripted. Sources show ref → short SHA, last check and "Update available", with a menu: Check for updates, Edit, Remove (stops checks and keeps the source's immutable versions), and Remove with versions (blocked while any version is in a set). |
| Import dialog (FormDialog) | A Segmented source type (Upload, Git, Anthropic, Marketplace). Anthropic and Marketplace list plugins with search, then their skills in a multi-select ChipGroup with license tags. The last step lists detected skills, their findings, converted commands with old and new names, and what won't be imported. |
| Review page (`/admin/pools/skills/review/:versionId`) | A page, so code reads well on phones: name, source, hash, size and license; findings by tier, each linking to its line; the file list with a tick per flagged file; the file viewer; a frontmatter summary; a diff for updates; and a sticky bar with Reject and Approve. |
| Skillset editor (`/admin/pools/skills/sets/:id`) | A page, as in [Persona](persona-pool.md) §15: Sections on desktop, PageTabs on phones (Details, Skills, Preview). Details: name, prefix with a live `/prefix:name` preview, description. Skills: a row per skill with a Select (On · Manual (/name only) · Off), the "Remove pre-approved tools" SwitchRow, the listing Meter, and "Add skills" (approved versions only). Preview: the generated files. A sticky Save asks for the revision note; a DiscardDialog guards edits. |
| Workspaces | The create dialog's Add-ons get a Skillsets ChipGroup. Rows add "3 skillsets" and a problem badge on Load error, Mismatch or "too old". The Configuration panel's Skills row shows sets, revisions, delivery status, "Verified 10:42 · Claude Code 2.1.296", §12, FR18 and FR19 warnings, and Manage (set picker and per-skill overrides). |
| Inside the workspace | `/context` shows the listing's size after the budget; `/etc/claudepilot/state.json` lists sets, revisions and skill hashes. |

## 14. Security requirements

- **Import never runs content:** no scripts, git hooks, submodules, LFS smudge or npm lifecycle
  scripts. Archives get path, symlink, size, file-count and ratio checks; frontmatter parsing has
  FR5's limits.
- **Fetching** is HTTPS only, through the SSRF guard (no private ranges unless allowed), with a 60 s
  timeout. Source tokens are encrypted (foundation §4.1), write-only, handed to git only as in FR2, and
  redacted from git and HTTP errors. No source URL or credential reaches a workspace.
- **Only reviewed content is delivered.** The compiler refuses any skill without an approved review of
  its tree hash. Delivered files are read-only for the workspace user (§10.2); on the standard image
  `sudo` can still change them, and the `tree-hash` check (§10.5) undoes it.
- **Skill files are hostile in the portal UI:** plain text only, no HTML rendering, no links followed
  automatically, detected credentials masked in the findings list.
- **UI-only actions.** Import, approve, reject, revoke and "Update to v…" have no
  [Portal MCP](portal-mcp.md) tool (its §6 and §13.4): a model reviewing a hostile skill is exactly
  what prompt injection targets. Its `pool_create` and `pool_update` may reference only approved
  versions (its FR14); inventory and review state are readable.
- **Verification never uses a user's login.** FR21 starts no session (🔬 Q3), and FR22 runs only after
  Q3, with an empty config folder.
- **In the workspace,** skills run with the user's rights; hooks and injected commands run outside the
  sandbox. Assigning a set runs its code in every assigned workspace, and the confirmation says so.
- **Policy keys** (`disableSkillShellExecution`, `strictKnownMarketplaces`, custom `Skill(...)` rules)
  belong to [Settings & policies](settings-policies.md) §10.1, whose FR8 admits the portal marketplace
  to any marketplace allowlist. FR18 covers how policy and sets interact.

## 15. Observability and audit

- Event log (foundation): imports (source, resolved hash, skills, finding counts), review decisions
  (session, note, acknowledged items), revocations, set revisions and when they became current or
  paused, assignments and overrides, deliveries, verification results, drift.
- Metrics and attention items for the [Monitoring dashboard](monitoring-dashboard.md) (its FR28):
  versions waiting for review, workspaces with Load error or Mismatch, paused rollouts, revoked skills
  still present, workspaces over the listing estimate or too old for skillsets.
- Skill usage (M5): managed hooks run `/etc/claudepilot/bin/skill-event` on `UserPromptExpansion` (a
  user typed the command) and on `PostToolUse` with matcher `Skill` (Claude invoked it). A typed
  command skips the Skill tool's `PreToolUse` hooks, and `UserPromptExpansion` carries `command_name`
  apart from `command_args` ([hooks](https://code.claude.com/docs/en/hooks#userpromptexpansion)). The
  helper prints nothing, since `UserPromptExpansion` stdout reaches Claude's context, and appends only
  `id`, time, skill name, path (Claude or user) and session ID to outbox type `skills`, never
  `command_args`, `prompt` or tool input. 🔬 How plugin skills appear in `command_name`, whether
  `PostToolUse` also fires for a typed command, and which Skill tool input field holds the name (Q15).

## 16. Rollout and milestones

| Milestone | Scope | Gate |
| --- | --- | --- |
| M1 | Foundation pieces: database, reviewable revisions, blob store, plugin marketplace with version folders, Docker delivery engine (foundation F2, F6) | Foundation PRD approved; Q1 and Q2 checked in a container |
| M2 | Upload import, scanner, Library, review page, skillsets, skillset fragment on Docker (portal-side checks only until M4), revocation (recompile and delete, ignoring pins and the rollout limit), version gate, `tree-hash` drift check, verification with `claude plugin details` and `plugin list --json`, rollout pause, workspace Skills row | Q3 for the two commands |
| M3 | Git source with pinning, Anthropic source, updates with diffs, hand-copied skill check | |
| M4 | Marketplace sources and licenses, Kubernetes delivery on the pools volume, validation container | Foundation F3 with A6; Kubernetes exec and tar path verified in the cluster |
| M5 | Per-workspace overrides, conflict, budget and policy checks, revocation deny rules, usage events, the deeper check | Q4, Q11, Q13, Q15; Q3 for the deeper check |

## 17. Success metrics

| Metric | Target |
| --- | --- |
| Approved change to files present in a running workspace | Under 2 minutes on every target, within the rollout rate |
| Delivered files without an approved review | Zero, checked by the `tree-hash` drift check |
| Revoked skill files left in running workspaces | Zero after 2 minutes |
| Deliveries to running workspaces that verify with no load error | 99% or more |
| Skills from anthropics/skills and claude-plugins-official that import and validate | 100%, apart from those FR5 refuses |
| Workspaces over the listing estimate | Under 5% |
| Median time from import to review decision | Under 1 working day |
| Delivered skills not invoked in 30 days (M5 usage) | Reported per set |

## 18. Amendments to Pools foundation

| ID | Section | Proposed change |
| --- | --- | --- |
| A1 | §7 ownership | Skillset row. Files: `managed-settings.d/60-claudepilot-skills.json`, `/etc/claudepilot/marketplace/plugins/<prefix>/**` (`/etc/claude-code/.claude/skills/**` only in the §10.5 fallback), outbox type `skills` (1 MB cap, declared under [Monitoring](monitoring-dashboard.md) A4). The foundation bundle adds `/etc/claudepilot/bin/skill-event` and `tree-hash`. Keys: `enabledPlugins` entries `<prefix>@claudepilot` (`true` or `false`); `permissions.deny` entries `Skill(<prefix>:<name>)` and `Skill(<prefix>:<name> *)`; from M5, `hooks.PostToolUse` entries with matcher `Skill` and `hooks.UserPromptExpansion` entries in this drop-in: hook arrays are list keys (Monitoring A3), and hook arrays from two drop-ins both ran ✅ (cross-pool lab). Its hook prints nothing, as every portal hook must. Remove `extraKnownMarketplaces` (A2). |
| A2 | §7 shared marketplace | The foundation writes `extraKnownMarketplaces.claudepilot` (directory source `/etc/claudepilot/marketplace`, `autoUpdate: false`) in `managed-settings.d/00-claudepilot-base.json`. Every owner writes `plugins/<name>/<hash12>/` version folders; the foundation compiles `marketplace.json`, repoints an entry only after its new folder is complete, and prunes old folders per §10.5. If Q2 fails, every owner uses one stable path per plugin, swapped as in §10.5. Every portal plugin's `version` is `<revision>.0.0+<hash8>`. Plugin names are unique across portal plugins, kebab-case, without Claude Code's reserved prefixes; `cpm-` belongs to MCP sets and `cpb-` to the browser pool. `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` isn't set: `-p` loads these plugins in its first session without it (✅ MCP set A3, cross-pool lab), and only Q1 could show interactive sessions need it. The repointed entry is followed by the next session ✅ (cross-pool lab). |
| A3 | §5, §6.3 revisions | `pool_revisions` gains `status` (`draft`, `waiting_review`, `deliverable`) and `rollout_paused_at` with a reason. `pools.current_revision` moves only to deliverable revisions, and a paused revision reaches no more workspaces (FR23). Revocation bypasses pins (§5) and the rollout limit (§6.3). MCP sets and personas can reuse this. |
| A4 | §5 assignment | `assignments.options` (json) holds pool-specific settings for one workspace, such as per-skill overrides. |
| A5 | §4 storage | Blob store: content-addressed files at `<PORTAL_DATA_DIR>/blobs/sha256/`, mode `0600`, included in `portal backup` and `portal restore`, collected 30 days after nothing references them. |
| A6 | §6.2, F3 | Kubernetes pools volume: a per-workspace PVC `ws-<name>-pools` (1 Gi, ownerReference to the Deployment) at `/etc/claudepilot/marketplace`, added by "Enable pools" in the same restart. `sync.sh` never reads, writes or prunes that folder. `marketplace.json` lives on the volume and is written through `exec` (temp file, then rename) before the Secret's drop-in refers to it. The standard image writes as root (`sudo tar --no-same-owner`); in the hardened image the `claudepilot-sync` sidecar writes and the workspace container mounts the volume read-only ([Settings & policies](settings-policies.md) amendment 6). Limits: a compiled set at most 50 MB, a workspace's plugins at most 600 MB. The writer checks free space, prunes retained versions beyond the previous one if needed, and otherwise fails with "Pools volume full (X of 1 GiB)". |
| A7 | §6.3 verify step | Adopt [MCP set](mcpset-pool.md) A4's run-in-workspace step for FR21, FR22 and the `tree-hash` check, with results in `skill_inventory`. Such commands start no session and read no user credentials. Every hook helper in the foundation bundle (`account-event`, `monitor-event`, `persona-event`, `skill-event`, and the foundation's `session-event`, [Persona](persona-pool.md) A6) exits 0 at once when `CLAUDEPILOT_VERIFY` is set. |
| A8 | §10 navigation | "Pools" is one hub navigation item: PageTabs `stack="never"` with the tab in `?tab=`, and tabs Accounts, Skills, Personas, MCP sets, Secrets and Browser (ids `accounts`, `skills`, `personas`, `mcp`, `secrets`, `browser`; adopted in [Web app](web-app-pwa.md) §8, an index list on phones). A pool type's library or review pages are routes of their own, not nested tabs, because nested PageTabs stack inside a hub. Pool editors that hold lists are pages (Persona, Settings, Skillset). |

**Requests to related PRDs.** [MCP set](mcpset-pool.md): version folders and the A2 version format
(its §10.2 and §10.4), and its A4 in place of this PRD's earlier verify step. [Settings & policies](settings-policies.md):
show next to "Skills may run shell commands" how many delivered skills it affects (FR18); adopted in
its §11.2. [Account Pool](account-pool.md): its Accounts page becomes the first Pools tab (A8);
adopted in its §13.
[Chat sessions](chat-sessions.md) A9 is applied in §10.4; the reload notice it cites as FR20 is now FR24.

## 19. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | 🔬 In interactive sessions in a container, does the portal marketplace load with no prompt, and do its plugins appear in the first session after it's registered? `claude -p` does both ✅ (MCP set A3). Foundation Q1; decides the §10.5 fallback. | Sandbox test (TTY) |
| Q2 | Partly answered: ✅ the next session loads a repointed entry's new folder (cross-pool lab, print mode). 🔬 Does `/reload-plugins` re-read `marketplace.json` too? If not, does loading follow a symlinked plugin folder (§10.5)? | Sandbox test |
| Q3 | Partly answered ✅ (cross-pool lab): `plugin list --json` makes no API request, and before any session has registered the marketplace both commands say it isn't configured. 🔬 Do they run without credentials, network requests or hooks? Does `claude -p --no-session-persistence --output-format stream-json --verbose /reload-plugins` handle the command locally, with no model request, with and without credentials? How are marketplace plugin skills named in `skills` and `slash_commands`, and do Manual skills appear in `skills`? | Sandbox test |
| Q4 | 🔬 Which skill does bare `/x` run when two enabled plugins both have `x`? Does a `Skill(<prefix>:<name>)` deny rule also stop a user typing the command, bare or prefixed? | Sandbox test |
| Q5 | Should a later version import whole plugins (hooks, MCP servers, agents, `bin/`) as a pass-through, or stay with skills and commands? | Product |
| Q6 | With one shared admin sign-in, is recording approvals without separation of duties acceptable until user accounts exist? | Operator |
| Q7 | Run an external scanner such as `mcp-scan --skills` during import? 🔬 Check whether it runs offline or uploads skill content. | Operator |
| Q8 | May these workspaces use Anthropic's source-available document skills (docx, xlsx, pptx, pdf)? | Operator |
| Q9 | Private git sources in v1 (a read token held by the portal), or public repositories only? | Operator |
| Q10 | Does the portal host have outbound access to GitHub and npm in production? The portal is the only fetcher. | Operator |
| Q11 | 🔬 On the pinned version, does the listing budget's "1% of the model's context window" count characters or tokens? | Sandbox test |
| Q12 | 🔬 With `allowed-tools` removed and no allow rule, does an injected command run, prompt or abort in bypass mode? | Sandbox test |
| Q13 | 🔬 Under the Strict preset: do skill-frontmatter hooks of a force-enabled plugin run under `allowManagedHooksOnly`, and are marketplace plugin skills' `allowed-tools` ignored under `allowManagedPermissionRulesOnly`? FR18 strips them either way. | Sandbox test |
| Q14 | 🔬 Fallback: is the managed skills folder watched live, and does a plugin folder in it load as `<prefix>@skills-dir`? | Sandbox test |
| Q15 | 🔬 For a typed `/<prefix>:<name>`, what is `command_name` in `UserPromptExpansion`, does `PostToolUse` (matcher `Skill`) also fire, and which Skill tool input field holds the skill name apart from its arguments? | Sandbox test |
