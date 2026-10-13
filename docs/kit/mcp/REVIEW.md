# MCP sets of the kit: review dossier

For the owner, before approving anything in the portal's MCP catalog. Draft, 2026-10-13, reorganised the same day into three program sets (`isnan`, `konfersi`, `kohi-labs`). Nothing here was
approved and no credential was used (the publisher only makes drafts, and only when the owner runs it): the facts come from the npm registry, the public GitHub and Gitea
APIs, the projects' own READMEs and sources (read, not run), this repository's PRDs, and unauthenticated probes of the six
hosts from this dev container and from the workspace pod (no token or key was sent anywhere).

Marks: ✅ checked today, from the source named. 📄 documented by the project or in our PRDs, not re-checked today.
🔬 unverified: needs a real account, a token or a run. **UNVERIFIED** is used where a version or date could not be confirmed.

## Read this first

1. **Three Gitea and three Outline instances.** Gitea: `git.isnan.me`, `git.konfersi.com`, `git.kohi-labs.com`. Outline:
   `docs.isnan.me`, `outline.int.konfersi.com`, `outline.int.kohi-labs.com`. Each program has **one set** (`isnan`,
   `konfersi`, `kohi-labs`) with two servers, `gitea` and `docs`, and one token name each, so **a project gets only its own
   program's set** (the Konfersi program never sees Isnan or Kohi Labs). There is no all-hosts set: the earlier drafts had
   nine sets (three Gitea, three Outline, an all-hosts `gitea` and `outline`, and `github`) and were reduced to three, plus the
   optional `github` draft that the publisher does not touch (D-8: Gitea is the git host, GitHub only a mirror).
2. **One entry or three: the catalog decides.**
   - **Gitea: one entry.** A remote entry's URL is fixed in its version spec, and a remote server's slots can only be headers
     (`parseSlots`: "Remote servers take headers"), so a remote entry can't take a host as config. gitea-mcp also serves one
     Gitea per process (`-H` / `GITEA_HOST`, `cmd/cmd.go` ✅), and only Konfersi runs one (`gitea-mcp.konfersi.com`; no
     `gitea-mcp.isnan.me` or `gitea-mcp.kohi-labs.com` exists ✅). So the remote route would need three entries **and** two new
     deployments. A **stdio** (`command`) entry takes environment slots, so one entry with `GITEA_HOST` as config serves all three,
     each server in a set with its own host and its own token file. Cost: the gitea-mcp binary must be in the workspace image
     (it is not yet: `manifest.json` → `prerequisites`).
   - **Outline: three entries.** The MCP server is part of each Outline instance, so the URL differs per host, and a remote URL
     can't be config. The two `.int.` hosts also need "Allow private network" (below), which is a per-entry flag.
3. **Token mode for agents, not OAuth.** An OAuth sign-in is stored per Claude in each workspace ([mcpset-pool](../../prd/mcpset-pool.md)
   §13.3). Auto move (D-12) switches a chat to another Claude with no sign-in, and the server drops out of an autonomous chat. A
   token file from a Secrets & env set reaches every Claude. The Built-in catalogue's OAuth Gitea and Outline stay for your own
   interactive workspaces; a workspace must not get a built-in and a kit set for the same URL (the compiler delivers one, FR11).
4. **The browser servers are already delivered by the Browser pool**, at the same pinned versions, through its gate. A separate
   browser MCP set is not needed (§4, §5).
5. **Tool rules are not part of a set yet** (MCP set FR12 is milestone M5, not built; `McpSetContent` has no rules field). The
   recommended rules are in `tool-rules.json`, as ask and deny lists to put into Settings & policies' custom rules for the
   workspaces that get each set. **Conflict to decide:** D-3 removes ask rules for autonomous chats, so there only the deny
   list holds and write tools run unasked. Options: (a) accept that (default: destructive and out-of-flow tools are denied
   everywhere, writes are allowed in Bypass chats); (b) deny the write tools too in autonomous workspaces; (c) read-only tokens
   and `GITEA_READONLY=true` wherever a project only reads. I recommend (a) for a program's own hosts, which is what the three program sets do: they do **not** set `GITEA_READONLY`,
   so the program's agents can file issues and comment on their own Gitea, writes ask where ask rules exist, and the
   destructive tools are denied. A project that only reads sets `GITEA_READONLY` to `true` in its own revision of the set and
   gets read-only tokens (c). The token's scopes, not the set, are the real limit (§1, §2).
6. **Secret names are dedicated, one per host:** `GITEA_ISNAN_TOKEN`, `GITEA_KONFERSI_TOKEN`, `GITEA_KOHILABS_TOKEN`,
   `OUTLINE_ISNAN_KEY`, `OUTLINE_KONFERSI_KEY`, `OUTLINE_KOHILABS_KEY`, `GITHUB_MCP_TOKEN`. Never a shared token, and never the
   conventional `GITHUB_TOKEN`, which may be the broad mirror token (D-21).

### Hosts, as checked on 2026-10-13 (no token or key sent)

Probes: `HEAD /` and the public `GET /api/v1/version` (Gitea), `GET /_health` and an unauthenticated MCP `initialize` (Outline),
from this dev container (Docker on the Mac) and from the workspace pod `ws-kohi-event` (`kubectl exec … curl`, read-only), plus
public DNS (Cloudflare DNS over HTTPS) and the catalog's own SSRF guard (`assertPublicUrl`, run here).

| Host | Version | Workspace pod | Dev container | Public DNS | SSRF guard |
| --- | --- | --- | --- | --- | --- |
| `git.isnan.me` | Gitea **1.27.3** ✅ | 200, resolves to `10.43.63.226` (in cluster) ✅ | 200, `10.26.0.10` ✅ | Cloudflare ✅ | not applied (stdio: the host is config, see §1) |
| `git.konfersi.com` | Gitea **1.27.2** ✅ | 200, `10.43.63.226` ✅ | 200, `10.26.0.10` ✅ | Cloudflare ✅ | not applied |
| `git.kohi-labs.com` | Gitea **1.27.2** ✅ | 200, `10.43.63.226` ✅ | 200, `10.26.0.10` ✅ | **none** (NXDOMAIN) ✅ | not applied |
| `docs.isnan.me` | **UNVERIFIED** (not public); 1.9.0 or later inferred ✅ | `_health` 200, MCP 401 with challenge ✅ | same ✅ | Cloudflare ✅ | passes, public ✅ |
| `outline.int.konfersi.com` | **UNVERIFIED**; 1.9.0 or later inferred ✅ | `_health` 200, MCP 401 with challenge, `10.43.63.226` ✅ | same, `10.26.0.10` ✅ | **none** ✅ | **refused as private** unless "Allow private network" ✅ |
| `outline.int.kohi-labs.com` | **UNVERIFIED**; 1.9.0 or later inferred ✅ | same as above ✅ | same ✅ | **none** ✅ | **refused as private** unless allowed ✅ |

- Outline shows no version without signing in. Every one answers `/mcp` with a `WWW-Authenticate` challenge naming its
  protected-resource document (scopes `read`, `write`), which Outline added in 1.9.0 📄 (providers PRD §5.4): hence "1.9.0 or later".
  My earlier note on `docs.isnan.me` stays: its exact version is unknown.
- **Inside the cluster every Gitea and the `.int.` Outlines resolve to `10.43.63.226`** (a cluster service address), so a workspace
  pod reaches them without leaving the cluster; `docs.isnan.me` goes out through Cloudflare. The portal's SSRF guard runs in the
  portal pod; I did not exec into the production portal, so "refused as private there" is inferred from the same cluster DNS and
  from the guard's result here (`10.26.0.10` is private too).
- **Egress and allow-lists.** All six hosts belong in the project-onboarding host allow-list ([T-133](../_specs/T-133.md) item 1,
  whose default lists only "the Gitea host") for the hosts a project uses, and in the workspace egress policy (network isolation
  exceptions, Browser PRD A8) wherever isolation is on: the stdio gitea-mcp connects from the workspace itself.
  `manifest.json` → `hosts` lists them.

---

## 1. git-host-gitea: gitea-mcp over stdio, one entry for three Gitea instances

| | |
| --- | --- |
| What it is | The official Gitea MCP server. Repositories, files, branches, tags, releases, issues, pull requests, reviews, wikis, labels, milestones, projects, Actions, packages, notifications. |
| Source and licence | `https://gitea.com/gitea/gitea-mcp`, **MIT** ✅. Not on GitHub: `github.com/gitea/gitea-mcp` answers 404 ✅. Releases every few weeks (1.7.0 2026-08-27, 1.8.0 2026-09-30, 1.8.1 2026-10-09 ✅); binaries for Linux amd64 and arm64 with a checksums file per release ✅. |
| Version | Catalog version `v1` (a `command` entry is numbered by the portal). The catalog flags it "Not version-pinned: runs whatever the image has" ✅ (`riskFlags`): **the pin is the image's**, so the image change must name an exact release (1.8.1) and check its SHA-256. The binary is **not in the image yet**. Compatibility with the three Gitea versions (1.27.2, 1.27.3 ✅): gitea-mcp documents no minimum Gitea version (**UNVERIFIED**); Konfersi's gitea-mcp 1.8.0 📄 already runs against `git.konfersi.com` 1.27.2. |
| What runs where | In the workspace, one process per server in the set, started per session: `/etc/claudepilot/bin/mcp-launch cpm-<set>/<key> -- cmd:/usr/local/bin/gitea-mcp -t stdio` (the review shows `/usr/local/bin/gitea-mcp -t stdio` ✅). Its environment: `GITEA_HOST` from the set's config, `GITEA_ACCESS_TOKEN_FILE` = the path of the host's Secrets & env file (a **path** slot: gitea-mcp reads the file itself, trims the line end, and the token is in no variable, ✅ `cmd/cmd.go`), and `GITEA_READONLY=true` where the set says so (compared with exactly `true` ✅). It writes a log to `$HOME/.gitea-mcp/gitea-mcp.log` 📄. A program set starts one gitea-mcp process per session (its Outline server is remote: no process). A workspace of two programs would start two (MCP set FR11 warns above 8). |
| Network | Workspace → each Gitea it is configured for (table above): inside the cluster, `10.43.63.226`; no MCP server in between, no public exposure. |
| Secrets | One path slot per server: `GITEA_ISNAN_TOKEN`, `GITEA_KONFERSI_TOKEN`, `GITEA_KOHILABS_TOKEN`, each `{{secret-file:NAME}}` in its set. |

**Per host: the token that suffices.** Gitea tokens are scoped by category, not by repository, so **the account is the
boundary**: one bot user per instance, collaborator on the project's repositories only, never an organisation owner or site
admin. No `admin`, `organization`, `package`, `activitypub` or `misc` scope.

| Host | Who uses it | Token scopes | Server setting (default) |
| --- | --- | --- | --- |
| `git.konfersi.com` | the Konfersi program (its own host) | `read:repository`, `write:issue`, `read:user` (+ `write:repository` only if agents open pull requests through MCP; 🔬 which scope Gitea checks for that) | writable in set `konfersi` (server `gitea`); `GITEA_READONLY=true` in a read-only project's own revision |
| `git.isnan.me` | the Isnan program's projects | the same; read-only (`read:repository`, `read:issue`, `read:user`) unless the project files issues there | writable in set `isnan` (server `gitea`); `GITEA_READONLY=true` in a read-only project's own revision |
| `git.kohi-labs.com` | the Kohi Labs program's projects | the same; read-only unless the project files issues there | writable in set `kohi-labs` (server `gitea`); `GITEA_READONLY=true` in a read-only project's own revision |

`read:user` lets `get_me` answer. Agents push with git and their own credential, never with this token.

**Least privilege, two layers.** A program's workspace gets its own program set only (`konfersi` for Konfersi), so the other
programs' servers and token names are not even delivered. Why three sets rather than one set with the secrets deciding: a
server whose name is missing is left out (Secrets & env FR22), so one set would also work, but every workspace would then show
four servers as "Needs NAME" for good, and one wrong Secrets & env assignment would hand over a host. Separate sets keep it
explicit.

**The default is writable, on purpose.** The program sets leave `GITEA_READONLY` unset (the earlier single-host drafts did the
same; only the dropped all-hosts `gitea` set was read-only). A program's agents work on their own Gitea: they file and comment
on issues and pull requests there, and the rules below ask before every write tool and deny the destructive ones. A project
that only reads sets `GITEA_READONLY` to `true` in its own revision of the set (every write tool then disappears on the
server side) and gets a read-only bot token; the token stays the limit if a revision ever goes wrong.

**Tools** (58, from the README's Access column ✅; several are consolidated tools with a `method` parameter, so one rule covers
all of a tool's operations; `GITEA_READONLY=true` hides every Write tool on the server side ✅ README):

| Risk | Tools | Rule |
| --- | --- | --- |
| Read | the 33 tools the README marks Read, except `actions_config_read` (all `get_*`, `list_*`, `search_*` and `*_read` tools; full list in `tool-rules.json`) | none (allowed) |
| Read, sensitive | `actions_config_read` (Actions variables and secret names) | ask |
| Write | `issue_write`, `pull_request_write` (includes merge), `pull_request_review_write`, `label_write`, `milestone_write`, `wiki_write`, `project_write`, `timetracking_write`, `notification_write`, `create_branch`, `rename_branch` | ask |
| Destructive or out of flow | `create_or_update_file` and `delete_file` (commits without the trailers: untraceable work), `delete_branch`, `create_tag`, `delete_tag`, `create_release`, `delete_release` (releases go through pilot CI), `actions_run_write` (dispatch can deploy), `actions_config_write`, `package_write` (irreversible), `create_repo`, `fork_repo`, `create_organization` | deny |

**What could go wrong.** Issue, PR, wiki and commit text and attachments (`attachment_read` downloads them) are untrusted data
that can carry instructions. A write tool publishes what the agent wrote, so workspace content can leave through a comment.
`pull_request_write` merges, and a rule cannot separate merge from create. The token file is readable by the workspace user and
the agent's commands (mcpset §11), and a stdio server runs with the workspace user's rights outside Claude Code's sandbox.
**The host is config, not reviewed URL:** the catalog's SSRF guard checks remote URLs only, so `GITEA_HOST` is whatever the set
says; review each set revision's hosts, and the token stays the real limit. A set revision that changes a host is an ordinary
edit, so watch set revisions as closely as entries.

**Check before approving.** (1) The image change: gitea-mcp at `/usr/local/bin/gitea-mcp`, an exact release, its SHA-256 from
`gitea-mcp_<version>_checksums.txt`, both architectures. (2) In `pkg/log`, that requests are not logged with the
`Authorization` header (the log is in the workspace home). (3) One run per host with its bot token: `get_me` answers (🔬, needs
the tokens). (4) In `operation/`, which methods each consolidated `*_write` tool carries.

**RECOMMENDATION: approve with the tool rules above, after the image carries the binary** and checks (2) and (3) pass. Until
then, Konfersi can use the Built-in catalogue's Gitea in token mode against `gitea-mcp.konfersi.com` with the secret name
`GITEA_KONFERSI_TOKEN` (the template lets Add pick the name); Isnan and Kohilabs have no remote gitea-mcp, so they wait for this
entry.

---

## 2. outline-isnan, outline-konfersi, outline-kohilabs: Outline's own MCP endpoint

| | |
| --- | --- |
| What it is | The MCP endpoint built into Outline (`server/routes/mcp`, tools in `server/mcp/tools/`) ✅. Search, read, create, move and delete documents, collections and comments. Three entries, one per instance (§"Read this first", item 2). |
| Best maintained option | **This one.** Outline ships and tests it itself (latest Outline **v1.11.0, 2026-10-12** ✅). The community alternatives are weaker: `outline-mcp-server` on npm (one maintainer, last publish 5.8.5 on 2026-02-03, requires Node ≥ 24 while the image has Node 22 ✅); `mcp-outline` was unpublished from npm ✅; `outline-mcp` 1.0.7 lists no licence or repository ✅. |
| Source and licence | `https://github.com/outline/outline`, **Business Source License 1.1** ✅ (GitHub shows NOASSERTION; the LICENSE file says BSL 1.1: self-hosted use is allowed, offering Outline as a commercial document service is not). |
| Version | Catalog `v1` each. Instance versions: **UNVERIFIED** for all three (not shown without signing in); each answers the MCP challenge Outline added in 1.9.0, so 1.9.0 or later ✅ (inferred). |
| What runs where | Only the headers helper in the workspace: `{"type": "http", "url": "https://<host>/mcp", "headersHelper": "/etc/claudepilot/bin/mcp-headers cpm-<set>/<key>"}`. |
| Network | Workspace → `docs.isnan.me:443` (through Cloudflare), `outline.int.konfersi.com:443` and `outline.int.kohi-labs.com:443` (inside the cluster, `10.43.63.226`), all reached from the workspace pod ✅. |
| Private network | `outline-konfersi` and `outline-kohilabs` carry `allowPrivateNetwork: true`: the SSRF guard refuses their names as private otherwise ✅, and the review shows the flag "Private network allowed" ✅. It is the right setting for internal hosts; it also means a later version of these entries could point at any internal address, so read the URL of each new version. |
| Secrets | Slot `Authorization` (`Bearer {value}`) per entry: `OUTLINE_ISNAN_KEY`, `OUTLINE_KONFERSI_KEY`, `OUTLINE_KOHILABS_KEY`. |

**Per host: the key that suffices.** An API key of a dedicated user per instance, a member of the project's collections only,
never an admin. **Read-only unless the project writes documents.** Outline registers each MCP tool only if the token's scopes
allow the matching API method (`AuthenticationHelper.canAccess` in every tool file ✅), so a read-scoped key hides every write
tool on the server side; whether the key form on these instances offers scopes is 🔬. All three advertise exactly `read` and
`write` ✅ (protected-resource documents).

| Host | Who uses it | Key |
| --- | --- | --- |
| `outline.int.konfersi.com` | the Konfersi program (its design standard lives there, D-25) | read; write only if Konfersi agents are to edit documents |
| `docs.isnan.me` | projects documented there | read; write if the project keeps its docs there |
| `outline.int.kohi-labs.com` | projects documented there | read; write if the project keeps its docs there |

**Tools** (19, with `readOnlyHint` from the source ✅; the instances may be older and have fewer):

| Risk | Tools | Rule |
| --- | --- | --- |
| Read | `list_documents` (search), `list_collection_documents`, `list_collections`, `list_comments`, `list_templates`, `list_users`, `fetch` | none |
| Write | `create_document`, `update_document`, `move_document`, `restore_document`, `create_comment`, `update_comment`, `create_attachment`, `create_collection`, `update_collection` | ask |
| Destructive | `delete_document`, `delete_collection`, `delete_comment` | deny |

**What could go wrong.** Any document an agent reads is untrusted text. Edits are live on a shared wiki (history allows undo; a
deleted collection is worse). Workspace content can be copied into a document others read. `list_users` shows names and emails.

**Check before approving.** (1) Each instance's version in its admin settings (1.9 or later is the tested shape). (2) MCP is on
per instance (Settings, Workspace, AI; when off, `/mcp` answers 404; all three answer 401 today ✅, so it is on). (3) How an API
key's scope maps through `AuthenticationHelper.canAccess`, for read-only keys.

**RECOMMENDATION: approve `outline-konfersi` and `outline-isnan` with the tool rules above** once their keys exist; then
`outline-kohilabs` when a project needs it.

---

## 3. git-host-github: GitHub's remote MCP server (OPTIONAL draft, not published by default)

Kept in the folder (`entries/git-host-github.json`, `sets/github.json`) for a project that lives on GitHub. `manifest.json` marks
the entry and the set `publish: false, optional: true`, so `publish.mjs` does not put it in the catalog; the owner decides, and
then sets `publish` to `true` in a reviewed commit. D-8: Gitea is the git host, GitHub only a mirror.

| | |
| --- | --- |
| What it is | GitHub's official MCP server, the copy GitHub hosts at `https://api.githubcopilot.com/mcp` (the same URL as the built-in template). |
| Source and licence | `https://github.com/github/github-mcp-server`, **MIT** ✅, very active (latest push 2026-10-13 ✅). |
| Version | Catalog `v1`. **Not pinnable:** GitHub runs and updates the hosted server. The open-source release is **v2.0.2, 2026-10-08** ✅ (v2.0.0 on 2026-10-06 added typed output schemas, shown only to clients on MCP 2026-07-28 ✅). The local form (Go binary or `ghcr.io/github/github-mcp-server`) cannot run here (no Go binary in the image, no Docker in workspaces). The npm name `github-mcp-server` belongs to an unrelated person (`jungchihoon`, ISC, ships extra `gcommit`, `gpush` commands ✅), and `@modelcontextprotocol/server-github` is deprecated on npm ✅: neither is acceptable. |
| What runs where | Only the headers helper: `{"type": "http", "url": "https://api.githubcopilot.com/mcp", "headersHelper": "/etc/claudepilot/bin/mcp-headers cpm-github/github"}`. The helper sends `Authorization`, `X-MCP-Toolsets: context,repos,issues,pull_requests`, `X-MCP-Lockdown: true` and, in the kit set, `X-MCP-Readonly: true` (header semantics from `docs/remote-server.md` ✅). |
| Network | Workspace → `api.githubcopilot.com:443`. |
| Secrets | Slot `Authorization` (`Bearer {value}`), from `{{secret-file:GITHUB_MCP_TOKEN}}`. Never the mirror's classic token (D-21). |
| Narrowest token | A fine-grained personal access token, resource owner the project's account or organisation, **only selected repositories**, permissions Metadata, Contents, Issues and Pull requests, **read**. Add Issues and Pull requests **write** only for a project that works on GitHub and turns read-only off. Whether the hosted server accepts every tool with a fine-grained token is 🔬 (providers §9; the README's own advice lists classic scopes `repo`, `read:org`). |

**Tools** (default toolsets minus `users`, from the README ✅; with `X-MCP-Readonly: true` only the read row loads, the rules are
a second layer for sets that turn it off):

| Risk | Tools | Rule |
| --- | --- | --- |
| Read | `get_me`, `get_teams`, `get_team_members`, `ui_get`, `get_commit`, `get_file_contents`, `get_latest_release`, `get_release_by_tag`, `get_tag`, `list_branches`, `list_commits`, `list_releases`, `list_tags`, `list_repository_collaborators`, `search_code`, `search_commits`, `search_repositories`, `get_label`, `issue_read`, `list_issues`, `list_issue_fields`, `list_issue_types`, `search_issues`, `list_pull_requests`, `pull_request_read`, `search_pull_requests` | none |
| Write | `create_branch`, `issue_write`, `add_issue_comment`, `update_issue_comment`, `sub_issue_write`, `create_pull_request`, `update_pull_request`, `update_pull_request_branch`, `pull_request_review_write`, `add_comment_to_pending_review`, `add_reply_to_pull_request_comment` | ask |
| Destructive or out of flow | `delete_repository`, `delete_file`, `create_or_update_file`, `push_files`, `create_repository`, `fork_repository`, `merge_pull_request` | deny |

**What could go wrong.** The hosted server changes its tools without a version; the portal's tool snapshots that would notice
(M2) are not built, so re-read the tool list now and then. Public issues and code (`search_code` searches all of GitHub) are
untrusted text; lockdown hides public issue content from users without push access, but GitHub calls it "a best-effort content
filter, not a security boundary" ✅. Writes publish agent text on GitHub, which may be public.

**Check before approving.** (1) The fine-grained token answers `get_me` and `list_issues` on one repository (🔬). (2)
`docs/remote-server.md` still lists `X-MCP-Toolsets`, `X-MCP-Lockdown` and `X-MCP-Readonly` with the same meaning. (3) No set on
the same workspaces uses `https://api.githubcopilot.com/mcp` (the built-in GitHub).

**RECOMMENDATION: approve with the tool rules above**, used through the read-only `github` set, **only if** a project needs it. Lowest priority:
the current programs work on Gitea (D-8), and ClaudePilot's own work runs on pilot tickets and git, not GitHub issues.

---

## 4. playwright: @playwright/mcp, standalone

| | |
| --- | --- |
| What it is | Microsoft's Playwright MCP: an agent drives a browser through accessibility snapshots. |
| Source and licence | `https://github.com/microsoft/playwright-mcp`, **Apache-2.0** ✅; npm publishers are the Playwright team and Microsoft's release accounts ✅. |
| Version | **0.0.83, published 2026-09-28** ✅ (npm and the GitHub release). Still 0.0.x. Its two dependencies are pinned exactly to an **alpha** Playwright build, `playwright` and `playwright-core` `1.64.0-alpha-1790635538000` ✅. No install scripts ✅. |
| What would run | `/etc/claudepilot/bin/mcp-launch cpm-<set>/playwright -- npm:@playwright/mcp@0.0.83 --headless --isolated`, first use `npm_config_ignore_scripts=true npx --yes --registry https://registry.npmjs.org/ --userconfig /dev/null @playwright/mcp@0.0.83 --headless --isolated`. |
| Network | `registry.npmjs.org` at install; then every site the agent opens. |
| Secrets | None. |
| Tools | 25 core tools (README ✅): read-only `browser_snapshot`, `browser_take_screenshot`, `browser_console_messages`, `browser_network_request(s)`, `browser_find`; the rest act on pages. Rules if ever used: as Browser PRD FR7 (ask `browser_file_upload`, deny `browser_run_code_unsafe`, also deny `browser_evaluate`). |

**Why not in the kit.** The Browser pool already delivers this exact version (`apps/server/src/browser/pinned/package.json`:
`@playwright/mcp` 0.0.83, `chrome-devtools-mcp` 1.10.1, installed with `npm ci` from a lockfile with integrity hashes ✅) as the
`cpb-browser` plugin, through the gate that wakes Chrome, refuses calls while a person has control, offers `browser_handoff`
and redacts cookie and authorization headers (Browser PRD §11). A standalone copy would bypass all of that, and it cannot start
anyway: the workspace image installs no Chrome or Chromium (`images/workspace/Dockerfile` ✅), install scripts are off, and pointing
it at the browser container's `127.0.0.1:9222` is the pattern the catalog flags (FR3, `browser_port`) because it skips the gate.

**RECOMMENDATION: do not approve.** Give a project the Browser pool instead. The entry file stays as a reference.

---

## 5. chrome-devtools: chrome-devtools-mcp, standalone

| | |
| --- | --- |
| What it is | The Chrome DevTools team's MCP server: performance traces, Lighthouse, console, network, memory snapshots, input. |
| Source and licence | `https://github.com/ChromeDevTools/chrome-devtools-mcp`, **Apache-2.0** ✅; npm publishers include Google's release bot ✅. |
| Version | **1.10.1, published 2026-09-23** ✅. No dependencies declared and 14 MB unpacked: everything is **bundled**, so the npm lockfile shows nothing to audit ✅. No install scripts ✅. Officially supports Google Chrome and Chrome for Testing only ✅. |
| What would run | `/etc/claudepilot/bin/mcp-launch cpm-<set>/chrome-devtools -- npm:chrome-devtools-mcp@1.10.1 --headless --isolated --no-usage-statistics --no-performance-crux --redact-network-headers`, first use `npm_config_ignore_scripts=true npx --yes --registry https://registry.npmjs.org/ --userconfig /dev/null --package chrome-devtools-mcp@1.10.1 chrome-devtools-mcp --headless …`, with `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1` and `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1`. The flags are option names from `build/src/config/*.js` and the README ✅ (read, not run; the Browser pool's gate passes the first two telemetry flags 📄, Browser PRD §11.1). |
| Network | **Telemetry is on by default** ✅: Google usage statistics, trace URLs sent to the CrUX API, npm update checks. All three are off in this entry. Then every site the agent opens. |
| Tools | 58 in the tool reference at the 1.10.1 tag ✅, `readOnlyHint` set per tool. Risky: `evaluate_script`, `upload_file`, `install_extension`, `get_network_request` (bodies and headers), `execute_3p_developer_tool`. |

**Why not in the kit.** As for Playwright: the Browser pool delivers it (optional, `mcp.devtools`) through the gate, with its
network tools on Ask by default. Standalone it would need Chrome in the workspace image, which is not there.

**RECOMMENDATION: do not approve.** Use the Browser pool with devtools turned on.

---

## 6. issues-plane: not drafted

A maintained Plane MCP exists (`github.com/makeplane/plane-mcp-server`, MIT, v0.3.4 on 2026-10-08 ✅), but not in a form
this catalog takes, and not in a shape the tool rules can hold:

- It is now a **Python** package (`uvx plane-mcp-server stdio`, PyPI 0.3.4 uploaded 2026-10-09 ✅): refused until `uv`
  is in the image (mcpset M4). The npm package `@makeplane/plane-mcp-server` is stuck at **0.1.5 from 2025-10-30** ✅ and pulls
  `@scarf/scarf` ✅ (an install-time analytics package 📄).
- The hosted remote form (`https://mcp.plane.so/http/api-key/mcp`, README ✅) serves Plane Cloud only.
- It now has 30 tools, **one per resource with an `action` parameter** ✅ (`workitem(action="list" | "create" | …)`): read and
  delete are the same tool name, so "reads allowed, writes ask, deletes denied" cannot be expressed.
- The kit's issues are pilot tickets through the Portal MCP; no program uses Plane today.

**RECOMMENDATION: none to review.** Revisit only if a project adopts Plane, and after `uv` lands.

---

## Summary

| Entry | Kind | Version (date) | Secret names | Recommendation |
| --- | --- | --- | --- | --- |
| `git-host-gitea` | command (stdio) | v1; the image's gitea-mcp, to pin at 1.8.1 (2026-10-09) ✅; Gitea 1.27.2 / 1.27.3 ✅ | `GITEA_ISNAN_TOKEN`, `GITEA_KONFERSI_TOKEN`, `GITEA_KOHILABS_TOKEN` | Approve with tool rules **after** the binary is in the image |
| `outline-konfersi` | remote, private network | v1; instance **UNVERIFIED** (1.9+ inferred) | `OUTLINE_KONFERSI_KEY` | Approve with tool rules |
| `outline-isnan` | remote | v1; instance **UNVERIFIED** (1.9+ inferred) | `OUTLINE_ISNAN_KEY` | Approve with tool rules |
| `outline-kohilabs` | remote, private network | v1; instance **UNVERIFIED** (1.9+ inferred) | `OUTLINE_KOHILABS_KEY` | Approve when a project needs it |
| `git-host-github` | remote | v1; hosted, not pinnable; OSS v2.0.2 (2026-10-08) ✅ | `GITHUB_MCP_TOKEN` | OPTIONAL, not published by default; if a project needs it, approve with tool rules, read-only set |
| `playwright` | npm | 0.0.83 (2026-09-28) ✅ | none | Do not approve: Browser pool |
| `chrome-devtools` | npm | 1.10.1 (2026-09-23) ✅ | none | Do not approve: Browser pool |
| `issues-plane` | | not drafted | | Nothing to review |

**Checked against the portal's own rules** (2026-10-13: the server's `parseSpec`, `parseSlots`, `commandOf`, `riskFlags`, key and
slug rules, `configValue`, the `{{secret-file:NAME}}` form and `redact()` run on every file; the SSRF guard `assertPublicUrl` on
every remote URL and Gitea host): all entries and sets pass. After the reorganisation into program sets the files were run through a scratch portal (a throwaway instance, never the real one): `publish.mjs --only=mcp --apply` made the four entries and the optional `git-host-github` as drafts, and after a test approval there the three program sets were accepted by the set kind and compiled to the plugins `cpm-isnan`, `cpm-konfersi` and `cpm-kohi-labs` with servers `gitea` and `docs`. Flags the review will show: `git-host-gitea` "Not version-pinned",
`outline-konfersi` and `outline-kohilabs` "Private network allowed"; no others. The commands above are what `commandOf` printed.

**The three program sets** (what the publisher makes once the entries are approved; each holds `git-host-gitea` and its program's
Outline):

| Set | Server `gitea` (host, secret name) | Server `docs` (entry, secret name) | Tool names look like |
| --- | --- | --- | --- |
| `isnan` | `https://git.isnan.me`, `GITEA_ISNAN_TOKEN` | `outline-isnan`, `OUTLINE_ISNAN_KEY` | `mcp__plugin_cpm-isnan_gitea__issue_read`, `mcp__plugin_cpm-isnan_docs__fetch` |
| `konfersi` | `https://git.konfersi.com`, `GITEA_KONFERSI_TOKEN` | `outline-konfersi`, `OUTLINE_KONFERSI_KEY` | `mcp__plugin_cpm-konfersi_gitea__issue_read`, `mcp__plugin_cpm-konfersi_docs__fetch` |
| `kohi-labs` | `https://git.kohi-labs.com`, `GITEA_KOHILABS_TOKEN` | `outline-kohilabs`, `OUTLINE_KOHILABS_KEY` | `mcp__plugin_cpm-kohi-labs_gitea__issue_read`, `mcp__plugin_cpm-kohi-labs_docs__fetch` |

A set is created only when both its entries are approved. Approving `git-host-gitea` is not enough for any set, and
`outline-kohilabs` approved alone gives only `kohi-labs` half of its entries: that set still waits. **Which set for which project:**
a project of a program gets that program's set and no other (a workspace never gets two programs' sets by default).

**Review order:** 1. `outline-konfersi` (Konfersi's docs, usable today), 2. `git-host-gitea` (once the image change is
ticketed: approving early is harmless, it only fails to start; every set needs it), 3. `outline-isnan`, 4. `outline-kohilabs`.
Skip `playwright` and `chrome-devtools`; `git-host-github` only when a project needs it. Before the first approval, decide item 5
of "Read this first" (D-3 and ask rules): under D-3 the autonomous chats of a program run in Bypass with the ask rules removed, so
the program sets' write tools run unasked there and only the deny list holds; the answer decides whether a program's set is
accepted as it is (option a, the default) or with `GITEA_READONLY=true` in its revision.
