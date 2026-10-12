# PRD: MCP set pool

| | |
| --- | --- |
| Status | **Draft v0.8.** v0.8 adds the owner's "pool MCP only" request: reading (a), the pool as the only MCP source, is **built** in [Settings & policies](settings-policies.md) §22 and verified here (FR19a); reading (b), one pool MCP gateway, is **designed, not built** (§23). v0.7 records what was built: M1 is **built** and was run end to end in a Docker workspace through the portal's own delivery (§19); M2 to M5 are not built yet. v0.6 (consistency pass: version folders, one secret reference form, the browser's reserved prefix and the Web app's routes). Written from research on Claude Code 2.1.296 and the MCP Registry. ✅ = observed in throwaway containers from the workspace image (Claude Code 2.1.296, `claude -p` and CLI commands), with fake secrets, local dummy MCP servers and the layout in §10.2. 📄 = documented by Anthropic or the MCP project, not observed by us. 🔬 = unverified, listed in §22. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [Pools foundation](foundation-pools.md) (storage, delivery engine, plugin marketplace, outbox), [Secrets & env](secrets-env-pool.md) (the secrets that servers reference), [Settings & policies](settings-policies.md) (clean environment, MCP allowlists, allow rules), [Monitoring dashboard](monitoring-dashboard.md) (connection status and usage) |
| Related | [Skillset pool](skillset-pool.md) (shared marketplace, reviewable revisions), [Chat sessions](chat-sessions.md), [Portal MCP server](portal-mcp.md), [Persona pool](persona-pool.md) (tool lists that name MCP tools) |

## 1. Summary

MCP set pool lets admins keep a catalog of reviewed MCP servers, group them into sets, and assign
sets to workspaces, so agents get those tools without anyone running `claude mcp add`. A server is a
local stdio command (an npm package today, PyPI once `uv` is in the image) or a remote HTTP server.
Its credentials are references to [Secrets & env](secrets-env-pool.md) entries, never values. The
catalog can import entries from the official MCP Registry.

Each set reaches Claude Code as a plugin in the portal's marketplace, whose `.mcp.json` Claude Code
reads itself. A launcher (stdio) and a headers helper (remote) read each server's secrets from the
files Secrets & env delivers, so values stay out of settings, `.mcp.json`, process arguments and
Claude Code's environment. The portal never proxies MCP traffic, and never holds the OAuth tokens of
servers that users sign in to inside their workspace.

## 2. Background and problem

- Users add servers by hand and paste tokens into `~/.claude.json` in each container. Nobody sees
  which servers run where, at which version, with which credential, and rotating a token means
  visiting every workspace. Those hand-added copies also hide or duplicate what a set delivers (§10.6).
- A stdio server is code with the user's privileges, outside Claude Code's sandbox. A remote server
  receives whatever the agent sends. READMEs often show `npx -y pkg@latest`, so reviewed code can
  change silently, and `npx` resolves packages and config from the directory it runs in.
- Delivery must work on all three targets, running or stopped, without workspaces calling the portal.

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Catalog.** Reviewed server definitions with exact versions, secret and config slots, and an approval record, from the MCP Registry or added by hand. |
| G2 | **Sets.** Named, versioned groups of catalog servers. A workspace can have several, and they change without recreating it. |
| G3 | **Native delivery.** Servers load in interactive and `-p` sessions with no prompt, on all three targets. A stopped workspace catches up when it starts. |
| G4 | **Secrets by reference.** A server names the Secrets & env entries it needs. This pool never puts a value in a revision, settings file, `.mcp.json`, process arguments, URL or log. Inside the workspace, the workspace user and the agent's commands can still read values (the secret file and `/proc/<pid>/environ`); Secrets & env's deny rules narrow this but don't prevent it. |
| G5 | **Health.** Remote servers: reachable, credential accepted, tool list, checked from the portal. stdio servers: starts and lists tools, from a probe in a workspace; credential problems show as call failures (Monitoring FR16). Connection status from inside workspaces for both. "Needs sign-in" is shown as such, not as a failure. |
| G6 | **Usage per set.** Calls, errors and latency per set, server and tool, from the Monitoring dashboard's MCP data, without arguments or results. |
| G7 | **Fast revocation.** A compromised server version leaves every workspace within minutes, pinned ones included. |

## 4. Non-goals

- **An MCP gateway or proxy** in the tool-call path (Coder AI Gateway's model). Ground rule.
- **Holding OAuth tokens or OAuth client secrets.** Users sign in inside their workspace. Claude Code
  keeps both in its own store, on Linux most likely `~/.claude/.credentials.json`, which also holds a
  personal `/login` 🔬. The portal never reads or writes it.
- **Storing or delivering secret values** ([Secrets & env](secrets-env-pool.md)), **allow and deny
  policy** ([Settings & policies](settings-policies.md); this PRD supplies matchers, FR19), and
  **collecting MCP usage** ([Monitoring](monitoring-dashboard.md), §14).
- **OCI, NuGet, cargo and MCPB servers** (no Docker, .NET or Rust in workspaces). **Private package
  registries:** v1 installs from `registry.npmjs.org` and `pypi.org` only; later through a Secrets &
  env npm entry used only at install time. **Offline installs:** later, and only if the cluster has
  no egress (Q7).
- **Hardening against the workspace user** (foundation §2), and **claude.ai connectors**, which sync
  only for claude.ai subscription logins and belong to that user.

## 5. Users and stories

**Admin**: runs the portal and decides which servers agents get. **Workspace user**: uses `claude`
in a workspace, from a terminal or a chat session.

| ID | Story |
| --- | --- |
| US1 | As an admin, I add a server from an MCP Registry search, which fills in its exact version, transport and secret slots, or by hand (an npm or PyPI package at an exact version, a remote URL, a command in the image). |
| US2 | As an admin, I approve an entry only after seeing the exact command or URL untruncated, risky patterns flagged, and every secret it needs. |
| US3 | As an admin, I build a set from approved servers, pick a Secrets & env entry for each secret slot, and assign the set. The portal shows which names each workspace still lacks. |
| US4 | As a workspace user, I run `claude` and the set's tools are there. I never paste a token. |
| US5 | As an admin, I rotate a secret in Secrets & env without editing any set. Remote servers use the new value at their next connect or 401; stdio servers when their session restarts or reconnects them. |
| US6 | As a workspace user, when a server needs OAuth, the portal shows "Needs sign-in" and the exact command. I sign in from my workspace terminal, and the portal never sees the token. |
| US7 | As an admin, I see which servers are down or rejecting their credential, and which workspaces have a failing or hidden server, before users report it. |
| US8 | As an admin, I see per set which servers and tools agents use, how often calls fail and how slow they are. |
| US9 | As an admin, I make a server's tools ask before each call, or block some (for example, GitHub's write tools), even when it has dozens of tools. |
| US10 | As an admin, I approve a new version of a server, try it on a few workspaces, then roll it out or back. |
| US11 | As an admin, I revoke a compromised server version, and it stops in every workspace within minutes. |

## 6. Scope boundary

| Allowed | Not allowed |
| --- | --- |
| Referencing Secrets & env entries by name and pointing servers at the files Secrets & env delivers. | Storing, injecting, copying or refreshing OAuth tokens or client secrets. Writing `~/.claude/.credentials.json` or plugin `userConfig` sensitive values. |
| Checking servers with the referenced credential: from the portal (remote, §13.1) or inside an assigned workspace (stdio, §13.2). | Relaying, recording or inspecting tool calls, their arguments or their results. |
| A user adding their own servers in their workspace, unless Settings & policies restricts it. The duplicate check (§10.6) reports only the name of a user's server that matches a set's endpoint. | Editing the user's own servers in `~/.claude.json` or a repository's `.mcp.json`, or reporting their URLs, commands or headers to the portal. |
| Delivering third-party servers that an admin reviewed and pinned. | Putting the portal's own admin MCP endpoint ([Portal MCP server](portal-mcp.md)) in a set. The catalog refuses URLs under `PORTAL_PUBLIC_URL`. |

## 7. Solution overview

```
 Portal                                          Workspace (any target)
 ┌────────────────────────────────┐   push via   ┌──────────────────────────────────────────────┐
 │ Catalog (reviewed, pinned)     │   runtime    │ /etc/claude-code/managed-settings.d/         │
 │   ◀── MCP Registry mirror      │   API        │   30-claudepilot-mcp.json: plugins, rules    │
 │ Sets (revisions)               │ ───────────▶ │ /etc/claudepilot/marketplace/plugins/cpm-*/  │
 │ Secret names ──▶ Secrets & env │              │   .mcp.json ──▶ mcp-launch / mcp-headers ─┐  │
 │ MCP fragment (compiler)        │              │ /etc/claudepilot/secrets/files/* ◀────────┘  │
 │ Checks ─────────▶ remote MCP   │ portal runs  │ ~/.cache/claudepilot/mcp/ (packages)         │
 │ Per-set usage ◀── Monitoring   │ ───────────▶ │ claude ──▶ stdio servers, remote servers     │
 └────────────────────────────────┘ checks (exec)└──────────────────────────────────────────────┘
```

The **catalog** holds reviewed, pinned definitions; the Registry is for discovery only. **Sets** add
secret references, config and tool rules, stored as foundation pool revisions. **Delivery** writes
one plugin per set and a drop-in on every target, while values come from Secrets & env (§10, §11).
Pinned packages are **pre-installed** from a fixed directory (§12). **Health** comes from portal
checks, a stdio probe and Monitoring (§13, §14).

## 8. Functional requirements

### Catalog

- **FR1** Kinds: `npm` (package, exact `x.y.z` version, bin, args); `pypi` (the same, needs `uv`);
  `remote` (HTTPS URL, streamable HTTP or deprecated SSE, auth `none`, `headers` or `oauth`);
  `command` (a path already in the image, flagged "not version-pinned"). Ranges, tags and `latest`
  are refused. `oauth` may carry `clientId`, `callbackPort`, `scopes` and `authServerMetadataUrl`,
  non-secret fields written to `.mcp.json` 📄. Servers that need an OAuth client secret, and
  Anthropic-hosted connector hosts, which "don't support local OAuth" 📄
  ([MCP](https://code.claude.com/docs/en/mcp)), are refused with the reason.
- **FR2** Slots: name, target (`env` for stdio, `header` for remote, or a credential file path),
  secret or not, required, description, doc URL, default (non-secret only), and for headers a
  template (`Bearer {secret}`). Secret values never go in arguments or URLs, which show in `ps` and
  logs.
- **FR3** Review states: draft, approved, deprecated, revoked. Approval shows the exact command or URL
  untruncated and flags `sudo`, `rm -rf`, pipes into a shell, `curl` or `wget` in arguments, plain
  `http://`, npm install scripts, PyPI source builds, and servers that target `127.0.0.1` ports
  `9220`, `9222` or `8930`, the browser pool's ([Browser & desktop](browser-desktop-pool.md) §13). The MCP spec requires this for one-click
  local servers ([security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)).
  Approval records who, when and a note (Q9).
- **FR4** Approved versions are immutable; a change makes a new draft. Sets point at an entry and a
  version. The catalog shows "Upgrade available" and "Registry has x.y.z". Approving changes no set:
  "Try in set" creates a set revision that isn't current (A7). Pin trial workspaces to it, then make
  it current or discard it.
- **FR5** Keys match `[a-z0-9-]`: set slugs at most 12 characters, server keys at most 16, so the tool
  prefix `mcp__plugin_cpm-<set>_<server>__` takes at most 47. Both are immutable once delivered:
  renaming creates a new set or server, and the dialog warns that rules and usage history start fresh
  and that persona and skill tool lists naming the old tools stop matching. Claude Code's reserved
  names (`workspace`, `claude-in-chrome`, `computer-use`, `Claude Preview`, `Claude Browser`) are
  refused. Plugin prefixes are reserved per owner: `cpm-` for MCP sets, `cpb-` for the browser pool.

- **FR5a** Proposals (the global "add MCP" flow, [Portal MCP](portal-mcp.md) I3): an agent or a token proposes an entry, or a new version of one, through `proposeEntry` (`apps/server/src/mcp`). The result is always a draft, with the proposer (`portal-mcp:<token id>`, `session:<id>` or `ticket:<id>`) and a reason recorded and shown to the reviewer as plain text. Secrets appear as slot names only: anything credential-shaped, or invisible and direction-changing characters, in any text is refused. A proposal is never edited once made, since a person may be reading it: the proposer withdraws it or proposes another version. At most 10 wait per proposer and 40 in all. It goes through the same catalog, validation and SSRF guard as "Add manually", and only a person approving it in the portal (FR3) makes it deliverable: no set accepts a draft, and approval is a route behind the portal's sign-in that a proposal never reaches. **Built** (server and tests; the catalog's "Proposed by" badge is in the web milestone).

### MCP Registry

- **FR6** Hourly incremental mirror of `https://registry.modelcontextprotocol.io/v0.1/servers`
  (`version=latest`, `updated_since`, `nextCursor`). The registry is in preview, may reset data and
  asks to be mirrored rather than called live ([about](https://modelcontextprotocol.io/registry/about),
  [aggregators](https://modelcontextprotocol.io/registry/registry-aggregators)). If it's down, the
  cache keeps working ("Registry synced HH:MM").
- **FR7** Search by name and description, with version, date, status (`active`, `deprecated`,
  `deleted`) and whether the server runs here: npm, remote and PyPI (with `uv`) yes; OCI, NuGet,
  cargo and MCPB no. A status change on an approved entry raises an alert; `deleted` offers Revoke
  (FR13b).
- **FR8** Import makes a draft. `packages[]` gives the package and exact version, `remotes[]` the URL
  and headers, and entries marked `isSecret` become secret slots
  ([package types](https://modelcontextprotocol.io/registry/package-types); ✅ checked against the
  live API). A secret passed in `runtimeArguments` imports as "Secret passed as an argument: not
  supported". The review shows "Registry verified package ownership" (`mcpName` matched at publish
  📄) apart from the description, which is unverified and never a trust signal: the registry doesn't
  scan servers.

### Sets and assignment

- **FR9** A set lists servers, each with a key, catalog entry and version, config values, a reference
  per secret slot, tool rules and an enabled flag. Revisions and pinning follow the foundation, with
  Skillset's reviewable revisions (A7).
- **FR10** Secret slots reference Secrets & env entries by name, as `{{secret-file:NAME}}`
  (Secrets & env FR21). For `env` and header slots the launcher or helper reads the file's content at
  start or connect; a path slot gets the path, `/etc/claudepilot/secrets/files/NAME`. A tool login
  such as GitHub is referenced by its entry name: its token-only file comes from the same value
  version, so one rotation reaches the server too. A GitHub login that mints 1-hour tokens
  (Secrets & env FR29) is refused for stdio servers, since a stdio server keeps the token it started
  with. The editor discourages `${NAME}`, a variable Claude Code expands: the value sits in Claude
  Code's environment, a credential-like one in a stdio `env` arrived empty under the scrub ✅, and
  remote headers read credential-like names as empty 📄 (Secrets & env FR24). Names resolve against
  the workspace's own Secrets & env sets, and an unresolved name leaves out only that server
  (Secrets & env FR22): "Needs NAME: assign a Secrets & env set that provides it".
- **FR11** Several sets per workspace (create dialog, Configuration panel, bulk assignment). The
  compiler refuses the same remote URL in two sets assigned to one workspace, since which plugin wins
  is undocumented, and warns when one entry is in two sets. Each session starts its own stdio
  processes, so it warns above 8 stdio servers per session (configurable) and shows "about N
  processes with M open sessions", from Monitoring's session count and each entry's measured memory
  (§13.2), counting the browser pool's per-session gate and servers too
  ([Browser & desktop](browser-desktop-pool.md) §14.1). Kubernetes workspaces created before pools need "Enable pools" (foundation §6.6) first;
  the assign dialog says so.
- **FR12** Tool rules per server: "Ask for every tool" (`mcp__plugin_cpm-<set>_<server>__*`), "Block
  tools not marked read-only" (from the snapshot's `readOnlyHint`, a hint the server sets; a new tool
  without it is blocked as soon as a check sees it), and per tool **Default** (Claude Code's normal
  prompt flow), **Ask every call** or **Block**, as `permissions.ask` and `permissions.deny`. Ask
  prompts in every mode, Bypass included 📄 ([permission modes](https://code.claude.com/docs/en/permission-modes));
  in chat it needs [Chat sessions](chat-sessions.md) to relay it, or in `-p` the call is denied.
  Auto-approval is an allow rule, which Settings & policies owns (its amendment 3).
- **FR13** Deleting a set or deprecating an entry that's in use lists the affected workspaces first.
  Deprecated versions keep working where they are but can't be added.
- **FR13b** Revoke version: removes the server from every delivery at once, bypassing pins and the
  rollout limit (A7). Running workspaces get `permissions.deny` `mcp__plugin_cpm-<set>_<server>__*`,
  which takes its tools out of running sessions 📄, for 14 days or until an approved version replaces
  it, and its processes stop (§10.4). Stopped Kubernetes workspaces lose the set's `enabledPlugins`
  entry at once and get the set back, without the server, after the start reconcile. Monitoring gets
  a security event. Revisions with a revoked version can't become current again.

### Delivery and status

- **FR14** The MCP fragment compiles one plugin per set and the drop-in (§10). A server missing a
  prerequisite (a secret name, `uv`, policy, the Claude Code version) is left out, with the reason as
  its delivery state. MCP sets need the foundation's minimum, Claude Code 2.1.296, where the ✅ claims
  were observed (`managedMcpServers` needs 2.1.259, Monitoring's per-server usage 2.1.274 📄). Below
  it, servers get `claude_too_old` and the workspace offers "Update Claude Code" (foundation §9).
- **FR15** Pinned packages are pre-installed (§12); the launcher installs on first use, from a fixed
  directory, if a session starts sooner. Rotating a referenced secret needs no MCP recompile (§11).
- **FR16** Verify: after delivering to a running workspace, `claude plugin details cpm-<set>@claudepilot`
  through `exec` confirms the plugin is loaded and lists the expected server keys, without starting
  them (✅ `MCP servers (6)  echo, expand, …`). It prints text only and takes no flags 📄, so parsing
  is gated on the pinned Claude Code version and falls back to "Not verified". It says nothing about
  policy blocks, duplicates or connections (§13.2).
- **FR17** Status per server combines the delivery state, portal checks (§13.1), the stdio probe and
  Monitoring's connection status (§13.2). OAuth servers show "Needs sign-in" with the command to run
  (§13.3). Every in-workspace status shows "as of HH:MM".
- **FR18** Tool snapshots: tool names per check, plus a hash of each tool's name, description and
  schema, from remote checks and the stdio probe (OAuth servers give names only). A change after
  approval raises "Tools changed" and can hold delivery until reviewed. A tool whose full name passes
  128 characters is flagged "Unavailable: name too long": Claude Code kept an 80-character name and
  dropped a 156-character one without an error ✅.

### Policy (owned by Settings & policies)

- **FR19** Nobody writes `managed-mcp.json`: it takes exclusive control and would block every plugin
  server, these included. The MCP fragment reports matchers for what it delivers (`serverUrl` for
  remote, `serverCommand` with the exact launcher argv for stdio), and any allowlist Settings &
  policies turns on includes them. Claude Code checks "every server a user, a plugin, or claude.ai
  adds", comparing the configured command and arguments 📄 ([How a server is evaluated](https://code.claude.com/docs/en/managed-mcp#how-a-server-is-evaluated)).
  ✅ The exact launcher argv admitted a plugin's stdio server, an entry missing one argument blocked
  it, and blocked servers vanished from `claude mcp list`. Server names aren't a security control and
  aren't used. The browser pool reports its matchers the same way (Browser & desktop §11.1). A server
  that policy still blocks shows "Blocked by policy", which the portal works out from the effective
  lists, since Claude Code drops the server silently.
- **FR19a** The allowlist is built (the owner's "Pool MCP only" switch, Settings & policies §22): the
  settings module asks `McpSets.matchers(workspace)` for every workspace it delivers to. ✅ 2.1.296:
  with it on, `claude mcp list` shows these servers and nothing else (a repository's `.mcp.json`, the user's
  `~/.claude.json`, `--mcp-config` and claude.ai connectors are blocked), `claude mcp add` is refused, an
  empty pool blocks every server, and a remote server is admitted by its `serverUrl`. Adding or removing
  a server changes the allowlist, so each such change delivers the settings drop-in too: both are
  computed in the same delivery pass, the drop-in by calling the MCP fragment's own compile, never from a second list.

## 9. Data model

Stored in the portal's database ([Pools foundation](foundation-pools.md) §4). Sets use the
foundation's `pools`, `pool_revisions` and `assignments` with type `mcpset`. A revision holds
references, never values; Secrets & env records them in its `secret_references` table:

```json
{ "servers": [ { "key": "context7", "entry": "<entry id>", "version": "4.3.0", "enabled": true,
    "config": {}, "secrets": { "CONTEXT7_API_KEY": "{{secret-file:CONTEXT7_API_KEY}}" },
    "tools": { "ask_all": false, "block_not_read_only": false, "rules": { "get-library-docs": "ask" } } } ] }
```

| Table | Key fields |
| --- | --- |
| `mcp_catalog` | id, key, display_name, description, kind (`npm` \| `pypi` \| `remote` \| `command`), registry_name, created_at |
| `mcp_catalog_versions` | entry_id, version, spec (json: package, version, bin, args, url, transport, auth mode, OAuth fields, scripts or source builds allowed), slots (json), review_state (`draft` \| `approved` \| `deprecated` \| `revoked`), reviewed_at, review_note, registry_status, tools (json, with annotations), tools_hash |
| `mcp_registry_cache` | name, version, status, is_latest, published_at, updated_at, server_json, synced_at |
| `mcp_checks` | id, at, entry_id, origin (`portal` or a workspace), kind (`remote` \| `stdio_probe`), credential (Secrets & env entry and value version, or none), result, http_status, latency_ms, protocol, tool_count, tools_hash, rss_kb, detail (redacted) (kept 7 days) |
| `mcp_delivery` | workspace_id, pool_id, server_key, state (`delivered`, `pending_start`, `missing_secret`, `uv_missing`, `blocked_by_policy`, `unsupported`, `claude_too_old`, `held_tools_changed`, `revoked`), reason, absent_cause (`hidden_by_user_server` \| `blocked_by_policy` \| `not_loaded`), matching_server (name only), observed_at, updated_at |
| `mcp_installs` | workspace_id, package_ref (`npm:@upstash/context7-mcp@4.3.0`), state (`installing`, `installed`, `failed`), installed_at, last_used_at, error |

Connection status and usage live in Monitoring's tables (`mcp_status` and its MCP usage), with
`managed_by` set to the MCP set ([Monitoring](monitoring-dashboard.md) FR18).

## 10. Delivery into Claude Code

### 10.1 Choosing the path

| Option | Server kinds | Where secrets end up | When changes apply | Effect on other servers | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Plugin `.mcp.json` in the portal marketplace** | stdio and remote | Secrets & env files (`0440`, readable by the workspace user), read by the launcher or helper ✅. Supports stdio, per-server scoping and rotation without a settings rewrite | Interactive: `/reload-plugins`. Chat and `-p`: next session 📄 | Namespaced tools `mcp__plugin_<plugin>_<server>__<tool>` ✅. With the clean environment on, every stdio server in the workspace starts with only the baseline plus its own env ✅ | **Use for every server** |
| `managedMcpServers` in a drop-in | Remote (HTTPS) only | Literal header values in a drop-in every process can read. No `${VAR}`, no `headersHelper` | Connects without a restart | Outranks a user's server at the same URL. Users can toggle it off, not remove it | Fallback only (§10.5) |
| `/etc/claude-code/managed-mcp.json` | stdio and remote | `env` blocks in a file every user can read | | Exclusive: blocks user, plugin and `--mcp-config` servers, MCP sets included | Never |
| User or local scope (`~/.claude.json`) | stdio and remote | Plain text in the CLI's own state file | | The CLI rewrites this file, so pushes would race it | Never |
| Project `.mcp.json` | stdio and remote | Plain text in the repository | Asks for approval interactively | | Never |

Sources: [MCP](https://code.claude.com/docs/en/mcp), [managed MCP](https://code.claude.com/docs/en/managed-mcp),
[plugin loading](https://code.claude.com/docs/en/plugins/loading). The plugin path covers both kinds
with one mechanism, shares the marketplace with skillsets, keeps secrets out of settings, and
namespaces each set's servers. Non-secret values are written literally, because the portal compiles
per workspace.

### 10.2 What gets written

| Path in the workspace | Content |
| --- | --- |
| `/etc/claude-code/managed-settings.d/30-claudepilot-mcp.json` | `enabledPlugins`: `"cpm-<set>@claudepilot": true` per assigned set. `permissions.ask` and `permissions.deny`: tool rules and revocations, as `mcp__plugin_cpm-<set>_<server>__<tool>` or `…__*`. `env`: `MCP_TIMEOUT=60000` (default 30000), so a first-use install can finish. It applies to every MCP server in the workspace and is harmless there, so it isn't tombstoned when the last set goes. |
| `/etc/claudepilot/marketplace/plugins/cpm-<set>/<hash12>/.claude-plugin/plugin.json` | `{"name": "cpm-<set>", "version": "<revision>.0.0+<hash8>", "description": "…"}` in a version folder named by the compiled tree hash, plus the set's entry in the foundation's `marketplace.json`, repointed once the folder is complete ([Skillset](skillset-pool.md) A2; A3). |
| `…/cpm-<set>/<hash12>/.mcp.json` | One entry per delivered server (example below). |
| `…/cpm-<set>/<hash12>/servers/<server>.json` | The server's map: its `target`, and its variables or headers as lists of parts. Never values. |
| `/etc/claudepilot/bin/mcp-launch`, `mcp-headers` (and `uv`, `uvx` where the image lacks them) | Items of the foundation's script bundle, not baked into the image (A6). |
| `~/.cache/claudepilot/mcp/` | The launcher's working directory: a `package.json` stub, so npm looks no further up, and the pre-installed packages (§12). Written through `exec` as the workspace user, owner-only (`0700`, files `0600`), since `docker exec` runs with umask `0000` ✅. |
| `~/.claudepilot/outbox/mcp.jsonl` | Launcher and helper events, never values (§13.2, foundation §8). |

```json
{ "mcpServers": {
    "context7": { "command": "/etc/claudepilot/bin/mcp-launch",
                  "args": ["cpm-team/context7", "--", "npm:@upstash/context7-mcp@4.3.0"] },
    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/",
                "headersHelper": "/etc/claudepilot/bin/mcp-headers cpm-team/github" },
    "sentry": { "type": "http", "url": "https://mcp.sentry.dev/mcp" } } }
```

`servers/context7.json` and `servers/github.json`:

```json
{ "target": "npm:@upstash/context7-mcp@4.3.0", "env": { "CONTEXT7_API_KEY": [ { "file": "CONTEXT7_API_KEY" } ] } }
{ "headers": { "Authorization": [ { "text": "Bearer " }, { "file": "github-main" } ] } }
```

A part is literal `text` or a secret `file` (under `/etc/claudepilot/secrets/files/`, one trailing
newline trimmed, at most 64 KB); a GitHub login is a `file` part naming its token-only file
(`github-main` above, Secrets & env FR21). A missing or unreadable source makes the server exit with
`secret NAME missing` on stderr, never the value.

- **`mcp-launch cpm-<set>/<server> -- <target> [args]`** (target `npm:<pkg>@<version>`,
  `pypi:<pkg>==<version>:<bin>` or `cmd:<path>`) reads the server's map from the version folder the
  current `marketplace.json` entry names, and exits with "server changed or removed; run
  /reload-plugins" if that map is gone or its `target` differs, so a session still on an older folder
  can't restart an old or revoked version. It sets `PATH` and `HOME`, masks group and world write in
  its umask (`docker exec` gives `0000` ✅, which left npx's cache world-writable), exports the variables and two
  non-secret markers (`CLAUDEPILOT_MCP_SERVER=cpm-<set>/<server>`, `CLAUDEPILOT_MCP_TARGET=<target>`),
  and changes to `~/.cache/claudepilot/mcp`; otherwise the server runs in the session's working
  directory, the user's repository ✅. Then it runs the pre-installed package by absolute path, or
  installs on first use: `npx --yes --registry https://registry.npmjs.org/ --userconfig /dev/null
  <pkg>@<version>` with `npm_config_ignore_scripts=true` unless the approved version allows scripts,
  or `uvx --no-config --no-build --default-index https://pypi.org/simple --from "<pkg>==<version>"
  <bin>`, with `uvx` from `/etc/claudepilot/bin` first (🔬 Q11). Each start and failure appends an
  outbox line (§13.2).
- **`mcp-headers cpm-<set>/<server>`** prints the server's headers, from the same current map, as one
  JSON object. Plugin helpers
  get no credential-named variables 📄 ([MCP](https://code.claude.com/docs/en/mcp)), so it reads files.

✅ With this layout, a dummy server got exactly the file's value, the launcher's `PATH` and `HOME`,
and the cache directory as working directory. The value survived `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`
and the clean environment, since the launcher sets it after Claude Code starts the process. The helper ran on each
connect, from the plugin's root, with `CLAUDE_CODE_MCP_SERVER_NAME=plugin:cpm-<set>:<server>`; the
header reached every request, `server/discover` first. Under the clean environment
(`CLAUDE_CODE_MCP_ALLOWLIST_ENV=1`, Settings & policies, on by default) a stdio server got only
`PATH`, `HOME`, `TERM`, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PLUGIN_ROOT`,
`CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR` and its own `env`. `${NAME}` expanded from managed `env`.
`claude -p` and `claude mcp list` connected the servers, source `plugin`, with no prompt on the first
session, and honored a managed `MCP_TIMEOUT` (a server that answered after 40 s connected).

### 10.3 What applies when

| Change | Interactive session | Chat or `-p` session | New session |
| --- | --- | --- | --- |
| A set assigned or removed; a server added, removed, reconfigured or upgraded | After `/reload-plugins`, or `/reload-plugins --force` when Claude Code says the change re-reads the conversation 📄 | Next session: a reload there doesn't connect or disconnect plugin MCP servers 📄 | Yes |
| A referenced secret rotated, remote server | At its next connect, or its next 401/403, when the helper re-runs 📄 | Same | Yes |
| A referenced secret rotated, stdio server | `/mcp`, then Reconnect 🔬 (Q3). `/reload-plugins` keeps servers whose configuration is unchanged 📄 | Next session | Yes |
| Tool rules, revocation deny rules | Live: managed settings are watched 📄 | Live 📄 | Yes |

Sources: [MCP](https://code.claude.com/docs/en/mcp), [plugin CLI reference](https://code.claude.com/docs/en/plugins/cli-reference).
The Configuration panel shows "Applies at the next session or after /reload-plugins". Portal chat
sessions show "Start a new session to apply MCP changes" instead of [Skillset](skillset-pool.md)'s
Reload action. Putting the secret's version in the launcher arguments would make a reload restart
the server, but every rotation would then change the FR19 matchers.

### 10.4 Write order and removal

1. Secrets & env's files, then the plugin's new version folder, complete before anything names it,
   then the repointed `marketplace.json` entry, then the `enabledPlugins` entry. Old version folders
   follow Skillset's retention (its §10.5); revocation deletes every folder holding the revoked
   version at once.
2. Docker uses the archive API. On Kubernetes the plugin goes on the marketplace volume
   ([Skillset](skillset-pool.md) A6), and a stopped workspace's drop-in doesn't enable `cpm-<set>`
   until the start reconcile has written the plugin ("Applies after start"). Packages never go in
   the workspace Secret.
3. Unassign: remove the `enabledPlugins` and marketplace entries in one reconcile, and the folders at
   the next. Running stdio servers keep their values until the session ends or reloads; the UI
   says so. Revoking a credential is a Secrets & env action, which takes effect for remote servers at
   their next connect or 401. A name that stops resolving takes its server out at the next reconcile.
4. Revoke (FR13b): plugin and deny rule first. Then one `exec` as the workspace user finds processes
   whose `/proc/<pid>/environ` holds `CLAUDEPILOT_MCP_TARGET=<target>` (the launcher's arguments are
   gone after `exec`), prints only PIDs, and sends `SIGTERM`, then `SIGKILL` after 5 s. Claude Code
   doesn't restart stdio servers by itself 📄, so they show as failed.

### 10.5 Fallback

`claude -p` and `claude mcp list` load the plugins with no prompt ✅. Interactive sessions are 🔬
(Q1). If they ask or skip the marketplace, the same sandbox run tests, in order: a skills-directory
plugin (`~/.claude/skills/cpm-<set>/`, enabled as `cpm-<set>@skills-dir`; personal-scope plugins have
no trust restrictions 📄); `CLAUDE_CODE_PLUGIN_DIRS` (2.1.280 or later, a variable the foundation
would own for every pool, blocked by a `disableSideloadFlags` policy); and
`CLAUDE_CODE_PLUGIN_SEED_DIR` set from managed `env`. M1 falls back to the skills-directory plugin if
it loads with no prompt; tool names stay the same. If nothing does, remote servers with auth `none`
or `oauth` move to `managedMcpServers` (named `cpm-<set>-<server>`), and the rest wait:
`managedMcpServers` can't expand `${VAR}` or run a helper, so it never carries a secret.

### 10.6 Duplicates and migration

Claude Code matches plugin servers to user, local and project servers "by endpoint", the same URL or
command, and connects only the user's 📄. ✅ A user-scope server at the same URL, spelled with a
trailing slash, hid a set's remote server, and one with the same command hid its stdio server. Both
vanished from `claude mcp list` and `system/init` without a message. A user's copy with a different
command ran alongside, duplicating tools and processes.

- **Detect.** Monitoring's "Check MCP servers" script (its FR17) also takes the set URLs and package
  names on stdin, compares them inside the workspace with what `claude mcp list` prints, and returns
  only the names and scopes of matching servers. Each absent set server gets a cause: hidden by a
  user's server, blocked by policy (FR19), or not loaded (FR16). The first assignment runs it too.
- **Show.** "Hidden by your own server "github" at the same URL. Remove it: `claude mcp remove github -s
  user`". OAuth sign-ins are stored per endpoint 📄, so the user's sign-in carries over. For stdio:
  "Your own context7 also runs; remove it to avoid duplicate tools."

## 11. Secrets

- **Names only.** A set stores Secrets & env references. Secrets & env stores the values, delivers
  them (secret files at `/etc/claudepilot/secrets/files/NAME`, `0440 root:node`, tool logins' token-only
  files among them; variables in its drop-in), and records which revisions use which names. The MCP
  fragment never sees or writes a value.
- **Who can read them.** The launcher and helper read the files as the workspace user, so the user
  and the agent's commands can too, and a running server's values sit in its `/proc/<pid>/environ`.
  Secrets & env's deny rules (`Read(//etc/claudepilot/secrets/**)`, `Read(//proc/**/environ)`) stop
  Claude's file tools and common Bash file commands, not scripts, and don't touch the launcher.
- **Per workspace.** Names resolve against the workspace's own Secrets & env sets (its FR22). A shared
  credential is one Secrets & env set on many workspaces; per-person tokens are one set per person
  under the same MCP set. The assign dialog shows which names each workspace has.
- **Recommended entry:** a secret file with no path variable, marked Hidden (the "For MCP servers"
  preset, Q8), so it's in no environment. Hidden takes effect only where Settings & policies runs the
  sandbox; elsewhere only the deny rules apply. GitHub servers reference the GitHub login by
  its entry name, whose token-only file comes from the same value version, so rotating the login
  covers them too (Secrets & env FR21).
- **Rotation** needs no MCP change; servers pick up the rewritten file per §10.3. Beside "Safe to
  revoke", Secrets & env shows "stdio MCP servers in running sessions may still use the old value"
  (its FR17).
- **Portal checks** (§13.1) read a value through a Secrets & env call reserved for them (its FR11),
  recorded as an exposure "portal check → <host>" and paused while the portal is Locked (its FR14). The value goes only to the server's URL.

## 12. Runtimes and installs

| Runtime | In the image ✅ | Servers it runs |
| --- | --- | --- |
| node 22.23.3, npm and npx 10.9.9 | Yes | npm packages |
| python3 3.11.2 | Yes, without pip | Nothing on its own |
| `uv`, `uvx` | No | PyPI packages. A pinned `uv` (amd64 and arm64) goes into `images/workspace/Dockerfile` (A6). It uses the system Python, or downloads a newer one when a server needs it (egress). |
| Docker | No | OCI packages: not supported |

Docker workspaces whose image lacks `uv` get `/etc/claudepilot/bin/uv` and `uvx` as an optional,
per-architecture, SHA-256-checked bundle item (A6). Kubernetes workspaces get `uv` from the image at
their next restart, since tens of MB can't travel in the 1 MiB workspace Secret; until then their
PyPI servers show "uv missing: restart to update the image".

| | First use (launcher, at server start) | Pre-install (during reconcile) |
| --- | --- | --- |
| Download happens | When a session starts the server | When the set is delivered |
| Failure mode | Races `MCP_TIMEOUT` (60 s): a longer install fails that session's connection | "Install failed" on the workspace, before anyone needs the server |
| Repeat cost | The npm and uv caches in the home volume make later starts fast | Once per package version per workspace |

**Decision:** pre-install by default, from M1, with first use as the launcher's fallback
([npx](https://docs.npmjs.com/cli/v11/commands/npx), [uv tools](https://docs.astral.sh/uv/guides/tools/)).

- npm, in `~/.cache/claudepilot/mcp`: `npm install --prefix npm/<pkg>@<version> --no-save
  --ignore-scripts --registry https://registry.npmjs.org/ --userconfig /dev/null <pkg>@<version>`, as
  the workspace user through the run-in-workspace step (A4), 5-minute timeout, scripts only if
  approved (Q10). PyPI: `uv venv` plus `uv pip install --no-config --no-build --default-index
  https://pypi.org/simple "<pkg>==<version>"` into `uv/<pkg>==<version>/`; source builds run code like
  install scripts, so they need the same approval.
- A version installs once per workspace, since the home volume persists; unused ones go after 14
  days. Both modes need egress to `registry.npmjs.org`, `pypi.org` and `files.pythonhosted.org` (Q7).
- The browser pool installs its servers from a lockfile into its own `~/.cache/claudepilot/browser/`
  through the same step, never into this folder ([Browser & desktop](browser-desktop-pool.md) §11.1).

## 13. Health and status

### 13.1 Portal checks (remote servers)

The portal connects with the official MCP TypeScript SDK client and the referenced headers, using
`server/discover` and falling back to `initialize` as Claude Code does ✅, then calls `tools/list`.

| Result | Meaning | Shown as |
| --- | --- | --- |
| OK | Handshake and `tools/list` succeeded | "OK · 12 tools · 180 ms" |
| Sign-in ready | An `oauth` server answered 401 with protected-resource metadata | "Users sign in from their workspace" |
| Rejected | 401 or 403 with headers supplied | "Credential rejected: check NAME" |
| Unreachable, timeout, not MCP | DNS, connection or TLS failure; no answer in 10 s; invalid MCP | The reason |

- Every 15 minutes while an assigned set uses the server, plus on save and on demand; hourly after 3
  failures in a row. "Check without credentials" is the default for metered APIs and for a secret
  whose Secrets & env set is assigned to one workspace (a personal token), unless the admin turns on
  "Check with this credential".
- Labeled "from portal": servers inside the cluster may be reachable only from workspaces (§13.2).
- Guards, as for Account Pool custom hosts: no private, loopback, link-local or metadata addresses
  unless allowed per entry; 10 s timeout; no credentials across redirects; 1 MB cap; redacted storage.

### 13.2 Inside the workspace

- **Connection status** comes from Monitoring (its FR17): chat sessions' `system/init` (✅ every
  server's status and tools) and "Check MCP servers", which runs `claude mcp list` through `exec` ✅
  (`plugin:cpm-<set>:<server>`: Connected, Needs authentication or Failed to connect). It starts every
  stdio server, so it never runs on a timer. The MCP page's "Check in workspace" triggers it with the
  duplicate check (§10.6). Expected servers missing from the list are Absent, with a cause.
- **stdio probe.** For stdio tool lists and snapshots (FR12, FR18), the portal runs the server's exact
  launcher command through `exec -i` in one running workspace that has it, speaks MCP over stdin and
  stdout with the SDK's stdio client (`server/discover`, else `initialize`, then `tools/list`; 60 s
  timeout), and stops it. It runs on demand and when a version first reaches a running workspace
  (usually a trial one, FR4), records memory, and is stored in `mcp_checks` with the workspace as
  origin. It proves the server starts; most servers check a credential only when a tool is called.
- **Launcher events.** A launcher that exits before the handshake shows only as "Failed to connect —
  CONNECTION_CLOSED" in `claude mcp list`, without its stderr ✅. So `mcp-launch` and `mcp-headers`
  append `{id, at, server, phase, source, reason_class}` to the outbox (foundation §8): phase `start`
  or `fail`; source `preinstalled`, `first_use` or `command`; classes such as `secret_missing`,
  `install_failed`, `uv_missing`, `server_changed`. Never values ✅. The workspace then shows
  "context7: secret CONTEXT7_API_KEY missing".
- A rejected helper-supplied credential shows as Failed to connect, not Needs authentication 📄; the
  portal labels it "Credential rejected" when its own check agrees (§13.1). `claude plugin list
  --json` returns `[]` until a session has registered the marketplace, then lists each plugin's
  `readFromFolder`, `folderVersion` and `errors` ✅ (cross-pool lab; an earlier run here saw only
  `[]`). It names no servers, so FR16 uses `plugin details`. ✅ `claude mcp list` connects the set's
  servers without registering the marketplace, and `plugin details` says "Marketplace 'claudepilot'
  not found" until a session has started, even a `claude -p` that stops at "Not logged in". The
  verify shows that as "Not verified yet" and runs again as soon as the outbox reports one of the
  set's servers starting there.

### 13.3 OAuth servers

- Delivered with the URL and FR1's OAuth fields, showing "Needs sign-in" until a workspace check
  reports Connected. The UI shows `claude mcp login --no-browser plugin:cpm-<set>:<server>` with a
  copy button, or `/mcp` in a session. `--no-browser` (✅ present on 2.1.296) prints the URL and takes
  the redirect URL back 📄; whether that works for plugin servers in the web terminal is 🔬 (Q2). On a
  phone: open the printed URL, sign in, copy the address of the page that then fails to load
  (`http://localhost/…`), and paste it into the terminal.
- Each workspace signs in separately (Q2). `-p` sessions can't complete OAuth 📄
  ([MCP](https://code.claude.com/docs/en/mcp)), so portal-run chat sessions point to the terminal.
  OAuth servers' tool names come from chat sessions' `system/init`.

## 14. Usage visibility

[Monitoring](monitoring-dashboard.md) records MCP calls with its own `PostToolUse` and
`PostToolUseFailure` hooks on `mcp__.*` (its FR16), and tags servers that no set provides as
Unmanaged (its FR18). This pool adds no hook. It contributes:

- **The mapping.** Tool names `mcp__plugin_cpm-<set>_<server>__<tool>` and server names
  `plugin:cpm-<set>:<server>` (both ✅) identify set and server; stdio processes carry the
  `CLAUDEPILOT_MCP_SERVER` marker, since `exec` replaces the launcher's arguments (§21).
- **A per-set view** on set cards and server rows: calls, error rate, p50 duration and last use per
  server and tool, from Monitoring's tables. **Events:** install and launcher failures, missing names,
  policy blocks, hidden servers, tool changes, revocations.

## 15. User experience

All screens use existing components (PageHeader, PageTabs, Section, Card, Badge, Menu, FormDialog,
ConfirmDialog, TextField, Select, Segmented, ChipGroup, SwitchRow, CopyButton, EmptyState, LoadError,
RowsSkeleton) and the foundation's pool page pattern. Two shared pieces are added to `components/`:
a Disclosure row (a row that expands) and a CodeBlock (wrapping monospace, never truncated, with a
CopyButton).

- **MCP sets tab** (`/admin/pools?tab=mcp`, [Skillset](skillset-pool.md) A8) lists the sets; the
  **Catalog** is its own route, `/admin/pools/mcp/catalog`, like Skillset's Library
  ([Web app](web-app-pwa.md) §8). A set card shows revision, server count, health ("5 OK · 1 needs sign-in · 1
  failing"), "Used by N workspaces", usage and a menu. A catalog row shows kind, version, review
  badge, auth mode, last check, "In N sets" and a menu (Check now, New version, Approve, Deprecate,
  Revoke). Catalog actions: "Add from registry", "Add manually".
- **Set editor** (a FormDialog on desktop, a `task` route on phones, Web app §9.2): a Disclosure row per server with its secret slots (a Select of Secrets &
  env entries, file entries first, plus "Create secret"), config slots, tool rules and an enabled
  switch. Tool rules show the two bulk switches and only the tools that have a rule; "Add rule" opens
  a filterable list of the snapshot's tool names, each with a Default · Ask · Block Segmented.
  "Preview files" shows exactly what each workspace gets.
- **Add from registry:** search over the mirror, with "Runs here" or why not on each result, then a
  prefilled form and the review step: the exact command or URL in a CodeBlock, risky patterns as
  danger badges, "Registry verified package ownership" when it applies, and "I reviewed the command
  and its source" before Approve.
- **Revoke** (ConfirmDialog, danger): "Revoke context7 4.3.0? It leaves 12 workspaces now, pinned ones
  included, and its running processes stop."
- **Workspaces:** an "MCP sets" ChipGroup in the create dialog's Add-ons, with missing secret names
  listed under it. The Configuration panel lists each server's status, "as of HH:MM", with its next
  step ("Sign in" with the command, "Needs NAME", "Install failed" with Retry, "Blocked by policy",
  "Hidden by your own server", "Applies after start"), plus "Check in workspace".
- **Phones:** rows stack, dialogs are full-screen, and CodeBlocks scroll inside their own box.

## 16. Security requirements

- **Secrets:** §11. Assigning a set shares its credentials with every user of the workspaces it
  reaches (they have `sudo`) and with the agent's commands; Secrets & env says so and records
  exposure. The launcher and helper never write values to stdout or stderr, apart from the helper's
  JSON object. Third-party servers' own logs are outside the portal's control.
- **Supply chain:** exact versions, approval before use, install scripts and source builds off by
  default, tool snapshots, Revoke (FR13b), and installs that a repository's `.npmrc`, `uv.toml`,
  `pyproject.toml` or `node_modules` can't redirect (§12, §18). Transitive dependencies still resolve
  at install time; a lockfile per approved version is a later improvement.
- **stdio servers** run as the workspace user, outside Claude Code's sandbox
  ([sandboxing](https://code.claude.com/docs/en/sandboxing)), with its files, network and `sudo`;
  plugins can run arbitrary code ([plugin security](https://code.claude.com/docs/en/plugins/security)).
  **Remote servers** receive what the agent sends, so the review shows the host.
- **Environment:** the clean environment keeps other pools' variables from stdio servers ✅. The
  scrub's PID namespace is 🔬 (Secrets & env Q2), and the scrub needs bubblewrap: ✅ without it, every
  `claude` command exits at start with "bubblewrap is required for subprocess env scrubbing" (§21).
- **OAuth tokens** are never read, stored or written by the portal (§6). **Portal checks** use the SSRF
  guard, never send credentials across a redirect, and never log headers. **Untrusted text** from the
  registry and tool descriptions shows as plain text, with control, bidirectional and zero-width
  characters stripped and length capped.

## 17. Observability and audit

- The shared event log records catalog changes, approvals and revocations, set revisions,
  assignments, deliveries, installs, probes, check state changes, hidden servers and tool changes,
  with who (session), what and when. Never secret values, arguments or results.
- Metrics for the Monitoring dashboard: servers by delivery state; check, probe, install and launcher
  failures by class; workspaces with servers needing sign-in, missing a secret name or hidden by a
  user's server; revoked versions still running.

## 18. Testing and verification

| Suite | What it covers | When |
| --- | --- | --- |
| Lab regression | The ✅ claims: plugin load, launcher and helper with maps, clean environment, scrub with bubblewrap, `MCP_TIMEOUT`, matchers, duplicates, tool-name length, `plugin details` parsing. Fake secrets, local dummy servers, no network. | CI, on each Claude Code version before the pinned version moves |
| Hostile repository | The session's directory holds an `.npmrc` pointing at another registry, a `uv.toml`, a `pyproject.toml` with `[tool.uv]`, and `node_modules/<pkg>` at the pinned version with an install script. Pass: the reviewed package starts, from the public registry, and no install script runs (Q11). Passed by hand for npm (Q11); not in CI yet. | CI; M1 gate |
| Interactive | Q1 with its fallbacks (§10.5), and Q3, in a `claude` session driven through tmux. | By hand; M1 gate |
| OAuth | Q2 with a test OAuth server: sign-in through the web terminal, token storage, restart survival. | By hand; M2 gate |
| Secret leaks | Canary secrets never appear in revisions, settings, `.mcp.json`, maps, arguments, URLs, logs, the outbox, API responses or probe output. | CI |
| Revoke | A revoked version's processes stop, its tools leave running sessions, a stale session can't restart it, and pinned and stopped workspaces lose it. | CI |

## 19. Rollout and milestones

| Milestone | Scope | Gate |
| --- | --- | --- |
| M1 | Catalog (manual npm and remote entries, review), sets, secret references, MCP fragment, Docker delivery, launcher with npm pre-install and hardened first use, helper, verify step, Preview files, FR19 matchers, Revoke. **Built.** Server: the catalog with its review (FR1–FR5; `command` entries too), sets with "Try in set" (FR4, FR9–FR11, FR13), the fragment (FR14, §10.2), the launcher and helper, the npm pre-install through the run-in-workspace step with removal after 14 days unused (§12), the verify (FR16), launcher events (§13.2), the FR19 matchers (`GET /api/mcp/workspaces/<target>/<name>/matchers`), Revoke (FR13b); migration 15. Web: the MCP sets tab, the Catalog and entry pages with the review, the set editor page with a picker of Secrets names and Preview files, the workspace Configuration row (each server's delivery state, install with Retry, the verify with "Verify again", missing names, FR11's warnings, "as of"), and Add-ons listing the names the picked sets need. ✅ Run end to end in a Docker workspace through the portal's own delivery (Claude Code 2.1.296, no login): `claude mcp list` showed `plugin:cpm-lab-tools:memory: /etc/claudepilot/bin/mcp-launch cpm-lab-tools/memory -- npm:@modelcontextprotocol/server-memory@1.0.0 - ✔ Connected` with no prompt; the pre-install took 28 s, so a `claude mcp list` started before it ended ran the server by first use and the next one from the pre-installed package (outbox `source`); `plugin details` found no marketplace until a session had started (§13.2), then listed `memory`, and the portal's verify recorded it as loaded; Revoke stopped the running server, took the plugin out of `enabledPlugins`, added the deny rule, and `claude mcp list` then listed nothing. ✅ In a throwaway container from the workspace image with the compiled files: an npm, a `command` and a remote server with a headers helper all connected; the stdio server got the secret file's value (trailing newline trimmed), both markers and the cache folder as its working directory; the remote server got `Bearer <value>`; canary values were in no delivered file, outbox line or Claude Code file. Not done: Q1 in an interactive session (it needs a signed-in TTY), and the lab and hostile-repository suites (§18), run by hand (Q11) but not in CI yet. | Foundation F2 and F6, A4; Secrets & env files and FR21; Q1, Q11 |
| M2 | Portal checks, stdio probe, tool snapshots, duplicate check, OAuth status and sign-in help. Not built: an `oauth` entry's FR1 fields already reach `.mcp.json`, but nothing shows "Needs sign-in" yet. | Q2 |
| M3 | MCP Registry mirror, search, import, status alerts. Not built. | |
| M4 | `uv` in the image and the bundle, PyPI servers, Kubernetes delivery. Not built: the catalog refuses PyPI entries, and Kubernetes workspaces wait for foundation F3. | Foundation F3; Skillset A6; Q7 |
| M5 | Tool rules with bulk rules, per-set usage from Monitoring. Not built. | Monitoring FR16–FR18 |

The FR19 matchers ship in M1 because Settings & policies' "Pool-delivered only" allowlist (its
milestone S3) would otherwise block every set.

## 20. Success metrics

| Metric | Target |
| --- | --- |
| Time from assigning a set to its servers connecting in a new session | Under 1 minute pre-installed. On first use, the first session may fail if the install takes over 60 s; the next session connects within 1 minute |
| Share of stdio starts from pre-installed packages (outbox `source`) | At least 95% |
| Secret values in revisions, settings, `.mcp.json`, server maps, arguments, URLs, logs, the outbox or API responses | Zero, checked by the leak suite (§18) |
| Time until a failing remote server shows in the portal | Under 15 minutes |
| Assigned servers that are absent, hidden or blocked, in `plugin details` or §13.2 status, without a delivery state or cause saying why | Zero |
| Tool changes reviewed | Within 24 hours |
| Revoked version still running in a reachable workspace | Zero after 2 minutes |

## 21. Amendments to Pools foundation

- **A1. §7, MCP set row.** Files: `managed-settings.d/30-claudepilot-mcp.json`,
  `/etc/claudepilot/marketplace/plugins/cpm-*/**`, `~/.cache/claudepilot/mcp/**` (only through A4),
  and `~/.claude/skills/cpm-*/**` (fallback only, §10.5). Keys: `enabledPlugins` entries
  `cpm-*@claudepilot` (fallback `cpm-*@skills-dir`); `permissions.ask` and `permissions.deny` entries
  whose tool names start with `mcp__plugin_cpm-`; `env.MCP_TIMEOUT`; `managedMcpServers` entries named
  `cpm-*` (fallback only). Outbox type `mcp` with fields `id`, `at`, `server`, `phase`, `source`,
  `reason_class` (§8). No hooks (Monitoring owns MCP usage), no secret paths (Secrets & env), and no
  `CLAUDE_CODE_MCP_ALLOWLIST_ENV` (Settings & policies).
- **A2. §7, MCP allow and deny lists.** Take `allowedMcpServers` and `deniedMcpServers` off the MCP set
  row. `deniedMcpServers` becomes a list key: the foundation adds the portal URL
  ([Portal MCP](portal-mcp.md) A1), and Settings & policies adds the admin's entries.
  `allowedMcpServers` and `allowManagedMcpServersOnly` go to Settings & policies. Rules: no owner
  writes `/etc/claude-code/managed-mcp.json`, and an allowlist always includes the matchers pools
  report (FR19).
- **A3. §7, shared marketplace.** Adopt [Skillset](skillset-pool.md) A2: the foundation registers
  `extraKnownMarketplaces.claudepilot` (directory source `/etc/claudepilot/marketplace`,
  `autoUpdate: false`) in `00-claudepilot-base.json` and compiles `marketplace.json` from owners'
  entries. Plugins use version folders and the `<revision>.0.0+<hash8>` version (Skillset A2). MCP sets
  verify with `claude plugin details` because an init-based run would start every stdio server;
  Skillset's FR21 adds `plugin list --json`.
- **A4. §6.2, run-in-workspace step.** A fragment may request commands run through `exec` as the
  workspace user in the workspace container (not a sync sidecar) after its files are written: at once
  if running, after the next start if stopped. Each gets a timeout, redacted output and a result in
  `delivery_events`. It serves MCP pre-installs and generalizes Skillset A7's verify step.
- **A5. §6.1, cross-pool references.** The compiler resolves names against the workspace's Secrets &
  env sets (Secrets & env FR22), writes the referenced files before the plugins that use them, and
  recompiles the MCP fragment when a referenced name starts or stops resolving.
- **A6. §9, image and script bundle.** Add a pinned `uv` (amd64 and arm64) to the image. The bundle
  carries `mcp-launch` and `mcp-headers` and, for Docker workspaces whose image lacks `uv`, an optional
  per-architecture, SHA-256-checked `/etc/claudepilot/bin/uv` and `uvx`. Kubernetes workspaces get
  `uv` only from the image.
- **A7. §5, reviewable revisions.** Adopt [Skillset](skillset-pool.md) A3 for MCP sets: revision
  statuses, a deliverable revision that isn't current, for pinned trial workspaces (FR4), and
  revocation that bypasses pins and the rollout limit (FR13b).

**Requests to related PRDs.**

- [Secrets & env](secrets-env-pool.md), settled in its v0.6: (1) per-server degradation on an
  unresolved name (its FR22); (2) not adopted: it keeps one form, `{{secret-file:NAME}}`, with
  token-only files for tool logins (its FR21), and FR10 follows it; (3) an internal call for the MCP
  check service only, never a compiler, returning a value by entry ID, recorded as an exposure
  "portal check → <host>" and unavailable while Locked (its FR11); (4) the "For MCP servers" preset
  (its FR2); (5) "stdio MCP servers in running sessions may still use the old value" beside "Safe to
  revoke" (its FR17); (6) `CLAUDE_CODE_MCP_ALLOWLIST_ENV` belongs to Settings & policies, which
  writes it. ✅ Findings for it:
  without bubblewrap the scrub stops every `claude` command, so the scrub option needs `bwrap` in the
  image; and its Q3 is answered (launcher-set values survive the scrub and the clean environment; a
  credential-like `${NAME}` in a stdio `env` arrives empty under the scrub).
- [Settings & policies](settings-policies.md): MCP sets declare `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1` as a
  warning-level policy requirement (its FR8): where a policy turns it off, delivery continues and
  sets show "stdio servers inherit the full environment". Its §11.2 can drop the 🔬, since the clean
  environment keeps `PATH` and `HOME` ✅ (its "Q6" was an earlier question here). The FR19 matchers
  ship in M1, before its "Pool-delivered only" (S3). Adopted in its §11.2 and FR8; the requirement
  shows unmet until its first Apply (FR5).
- [Monitoring](monitoring-dashboard.md): tag stdio servers by the `CLAUDEPILOT_MCP_SERVER` marker, not
  launcher arguments (its FR3), and run the §10.6 comparison inside "Check MCP servers" (its FR17),
  so stdio servers start once. [Portal MCP](portal-mcp.md): the base drop-in is settled as
  `00-claudepilot-base.json` (its A1). [Chat sessions](chat-sessions.md): show "Start a new session
  to apply MCP changes", and relay Ask prompts for MCP tools (FR12); adopted in its §12.3 and FR22.

## 22. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | 🔬 Do interactive sessions load the managed directory marketplace's plugin servers without a prompt? `claude -p` and `claude mcp list` do ✅. If not, which §10.5 fallback does? Same as foundation Q1. Not checked for M1: an interactive `claude` without a login stops at its onboarding before loading plugins, so this needs a signed-in test account. | Sandbox (TTY) |
| Q2 | 🔬 OAuth with a plugin-provided remote server: does `claude mcp login --no-browser plugin:<plugin>:<server>` work in the portal's web terminal, where is the token stored on Linux, and does it survive a workspace restart? | Sandbox with a test OAuth server |
| Q3 | 🔬 Does `/mcp` Reconnect restart a connected stdio server, so a rotated secret applies without a new session? `/reload-plugins` keeps unchanged servers 📄. | Sandbox (TTY) |
| Q7 | What egress does the k3s cluster allow: npm, PyPI, GitHub releases (for `uv` and managed Python), remote MCP hosts? Without it, offline vendoring moves into v1. | Operator |
| Q8 | Answered: Secrets & env accepts per-server degradation, the check-service call, the "For MCP servers" preset and the stdio rotation note, and keeps one reference form instead of the two new ones (§21, FR10). | Product, with [Secrets & env](secrets-env-pool.md) |
| Q9 | With one shared admin login, approval can't require a second person. Is a self-review checklist enough for v1? | Product |
| Q10 | Are npm `--ignore-scripts` and uv `--no-build` acceptable defaults, given that packages with native add-ons or only source distributions then need an override at review? | Engineering |
| Q11 | Answered for npm ✅ (by hand, M1): from a hostile repository (an `.npmrc` naming another registry, `ignore-scripts=false`, a `script-shell` and `node-options`; a user `~/.npmrc` likewise; `node_modules` holding the pinned version with install scripts and a fake bin; `uv.toml` and `[tool.uv]`), `claude mcp list` started the reviewed package through the launcher's first use from `registry.npmjs.org`, in the fixed directory, and the pre-install did the same; nothing planted ran. Controls: plain `npx` from that repository ran the fake bin and the `.npmrc` hooks, and an install with scripts allowed ran esbuild's postinstall, which the default skipped. 🔬 Still open for `uvx --no-build` and `--no-config` (M4). | Lab test (M1 gate) |

Closed since the previous draft, IDs kept: Q4 (allowlists apply to plugin servers: documented, and
✅, FR19), Q5 (`MCP_TIMEOUT`, `PATH` and `HOME`, `${NAME}` expansion: ✅, §10.2) and Q6 (tool names
over 64 characters: ✅, FR18).

## 23. Pool MCP only: the policy (built) and the single gateway (design)

The owner asked that "single MCP only" mean connections to the pool's MCP and nothing else, and that Claude
manage MCP only through the pool, never by creating a connection inside a session. Two readings.

**(a) The pool is the only MCP source: a policy. Built.** Two global switches in Settings
(Account MCP off, Pool MCP only) delivered to every workspace as managed settings (Settings & policies §22).
Claude can still propose a server (Portal MCP I3), which waits for a person's review in the catalog. What a
workspace loads is whatever the sets deliver, each server as its own connection.

**(b) One "pool MCP" gateway. Designed, not built.** A single stdio MCP server, `plugin:cpm-gateway:pool`,
delivered into every workspace that has a set, which fronts all assigned servers behind one connection.

| Aspect | Design |
| --- | --- |
| How it runs | `/etc/claudepilot/bin/pool-mcp`, started by Claude Code as the portal's own plugin server. It reads `/etc/claudepilot/mcp/gateway.json` (today's per-server parts: target, args, env and header slot references) and spawns children through `mcp-launch`; remote servers over HTTP. |
| Tool names | `mcp__plugin_cpm-gateway_pool__<server>__<tool>`: 31 characters of fixed prefix, so a long set slug no longer eats the 64-character budget (FR18), but rules written against `mcp__plugin_cpm-<set>_<server>__*` change shape (prefix rules still work). |
| Allowlist | One matcher, the gateway's launcher argv. It no longer changes when a set changes, which removes the allowlist churn (FR19a) and is the literal "single MCP". |
| Token cost | Tool descriptions cost the same per tool; one server's instructions instead of one per server. No saving worth the work on its own. |
| Applying changes | The gateway watches its manifest and sends `notifications/tools/list_changed`: a set change reaches **running** sessions without `/reload-plugins` or a new session (§10.3 today). The one clear gain. |
| Startup | It answers `initialize` and `tools/list` from the last tool snapshot (M2) and starts children on first use: faster session start (every stdio server starts at session start now) at the cost of a slower first call. |
| Failure isolation | Worse by construction: the gateway is one process in front of all of them. It must time out and restart each child on its own, return a per-tool error for a dead child, and keep `tools/list` stable. A crash drops every pool server at once, not one. |
| Secrets | One parent process would hold every server's secrets. It reads a secret file only when it spawns that child, passes it only to that child, keeps none, and its own environment holds none. A user with `sudo` can read process memory either way (foundation §2). |
| What it cannot front | Servers needing OAuth: the client flow (`claude mcp login`, token storage, refresh) is per server in Claude Code, and the gateway would have to implement an OAuth client. Sampling, elicitation, resources and prompts need forwarding per child. Per-server enable and disable in `/mcp` disappears (one entry). |
| Management tools | Read-only `pool_status` (what is delivered, state, last error, no values). Proposals stay in the Portal MCP, which holds the agent token (I8): the gateway holds no portal credential. |

**Recommendation.** Do not build (b) now. (a) already makes the pool the only source and is verified; (b)
mostly moves the same servers behind one process, and costs an MCP proxy (protocol surface, OAuth, failure
isolation) to gain live `list_changed` and a one-line allowlist. Revisit when sessions with many pool servers
start slowly, when allowlist churn causes delivery trouble, or when "applies without a restart" becomes a
requirement. If built: M2's tool snapshots first (the gateway needs them), remote servers without OAuth
first, OAuth servers stay separate connections.
