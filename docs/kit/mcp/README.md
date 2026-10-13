# Kit: MCP sets

The MCP part of the operating kit (T-132 item 4, D-26): draft catalog entries and set definitions, ready for the owner's
review. **Nothing here is published.** Third-party MCP servers run with the workspace user's rights or receive what the agent
sends, so every entry waits for a person to approve it in the portal ([MCP set pool](../../prd/mcpset-pool.md) FR3, FR5a).

| File | What it is |
| --- | --- |
| `REVIEW.md` | The dossier: the hosts as probed, one section per entry, the risks, what to check, a recommendation. **Start here.** |
| `entries/<key>.json` | The exact body of `POST /api/mcp/catalog` (`McpEntryRequest`), or of a proposal (`McpProposalRequest`, plus the `reason` from `manifest.json`). |
| `sets/<slug>.json` | The content of an MCP set (`McpSetContent`), with placeholders for catalog ids and versions. |
| `tool-rules.json` | The recommended ask and deny rules for every set, as full Claude Code tool names. |
| `manifest.json` | What a publisher does: prerequisites, which entries to propose (`publish`) and why, which sets use which entries and secret names, the hosts. |

## The hosts

| Program | Gitea | Outline |
| --- | --- | --- |
| Isnan | `git.isnan.me` | `docs.isnan.me` |
| Konfersi | `git.konfersi.com` | `outline.int.konfersi.com` (internal) |
| Kohilabs | `git.kohi-labs.com` | `outline.int.kohi-labs.com` (internal) |

**One Gitea entry, three Outline entries.** gitea-mcp runs in the workspace over stdio, and a stdio entry takes the host as an
environment slot (`GITEA_HOST`), so one reviewed entry serves all three with a different host and token file per server. A
remote entry's URL is part of the reviewed version and can't be config, so Outline (whose MCP endpoint is inside each instance)
needs one entry per host. `REVIEW.md`, "Read this first", item 2, has the reasoning and the code it rests on.

## Which set for which project

**Least privilege: a project gets the single-host sets of the hosts it uses, and nothing else.** The Konfersi program gets
`gitea-konf` and `docs-konf` and never sees the Isnan or Kohilabs hosts: their servers aren't in its sets, and their token names
aren't in its Secrets & env sets.

| Set | Servers (key: host) | Secret names | For |
| --- | --- | --- | --- |
| `gitea-konf` | `konfersi`: git.konfersi.com | `GITEA_KONFERSI_TOKEN` | the Konfersi program |
| `gitea-isnan` | `isnan`: git.isnan.me | `GITEA_ISNAN_TOKEN` | projects hosted on git.isnan.me |
| `gitea-kohi` | `kohilabs`: git.kohi-labs.com | `GITEA_KOHILABS_TOKEN` | projects hosted on git.kohi-labs.com |
| `docs-konf` | `konfersi`: outline.int.konfersi.com | `OUTLINE_KONFERSI_KEY` | the Konfersi program |
| `docs-isnan` | `isnan`: docs.isnan.me | `OUTLINE_ISNAN_KEY` | projects documented on docs.isnan.me |
| `docs-kohi` | `kohilabs`: outline.int.kohi-labs.com | `OUTLINE_KOHILABS_KEY` | projects documented on outline.int.kohi-labs.com |
| `gitea` | all three Gitea servers, **read-only** (`GITEA_READONLY=true`) | all three Gitea names | only a workspace that works across programs (the coordinator's) |
| `outline` | all three Outline servers | all three Outline names | only a workspace that works across programs |
| `github` | `github`: api.githubcopilot.com, read-only, lockdown on | `GITHUB_MCP_TOKEN` | projects hosted on GitHub or mirrored there; a project that works on GitHub sets `X-MCP-Readonly` to `false` in its own revision |
| none | Browser pool | none | UI testing: the Browser pool delivers Playwright MCP and chrome-devtools-mcp through its gate |
| none | Portal MCP | none | issues are pilot tickets |

Slugs are at most 12 characters, which is why the single-host Outline sets are `docs-*` (`outline-isnan` would be 13). A
server's key is its host's key in every set, so tool names read `mcp__plugin_cpm-gitea-konf_konfersi__issue_read`. One entry in
two sets on one workspace only warns (MCP set FR11), so a project on two hosts gets two single-host sets.

## How it maps to the portal

1. **Entry → draft.** By a person (`POST /api/mcp/catalog`, "Add manually") or by an agent (`mcp_propose_entry` over the Portal
   MCP, with `reason`). Either way a draft: no set accepts it and nothing is delivered.
2. **A person reviews and approves** on the entry's page: the exact URL or command, the risk flags, the slots, the box "I
   reviewed the command and its source". `REVIEW.md` is the reading for that box.
3. **The set is created** (a pool of type `mcpset`) from `sets/<slug>.json`, with `@<entry key>` replaced by the approved entry's
   id and `@approved` by its approved version. A set refuses a draft, so this follows approval.
4. **Secrets & env provides the names**, one Secrets & env set per host (a "For MCP servers" secret file each), assigned only to
   the workspaces of the projects on that host. A missing name leaves out only its server ("Needs NAME").
5. **Assign** the sets to the project's workspaces (the `pilot-way` template does this, T-132 item 5), add the project's hosts to
   the onboarding host allow-list (T-133) and to the egress exceptions where network isolation is on (`manifest.json` → `hosts`),
   and put the sets' lines from `tool-rules.json` into Settings & policies' custom ask and deny rules for those workspaces until
   MCP set tool rules (M5) exist.

## What the publisher script must do

Run by a person's portal session, or by an agent that can only propose. It never approves, never takes or prints a secret
value, and never assigns a set on its own.

1. Validate every file: JSON parses; keys `[a-z0-9-]` at most 16, slugs at most 12; no value in any `secrets` map other than
   `{{secret-file:NAME}}`; nothing credential-shaped anywhere (the portal refuses it too).
2. Report `manifest.json` → `prerequisites` that aren't met (today: the gitea-mcp binary in the workspace image).
3. For each entry with `"publish": true`: look the key up in the catalog. If an approved version with the same spec and slots
   exists, reuse it. If a draft with the same spec waits, report its review path. Otherwise create the draft (person) or propose
   it with the manifest's `reason` (agent), and print the review path.
4. Create a set only when every entry it needs is approved, with the placeholders replaced. If the slug is taken by another set
   (a Built-in catalogue instance can own `gitea` or `github`), **stop and report**: never pick another slug silently, since tool
   names and rules depend on it.
5. Report the secret names each set needs and whether a Secrets & env entry of that name exists (names only), and print the
   custom rules from `tool-rules.json` per set. Applying them is a Settings change by a person.

## Not in the kit, on purpose

- **The Portal MCP itself.** T-132 lists a `pilot` set, but the Portal MCP is not a catalog entry: every chat session gets it
  with its own short-lived agent token, bound to that workspace and session ([Portal MCP](../../prd/portal-mcp.md)). The catalog
  refuses URLs under the portal's own address (MCP set §6), and the base drop-in denies it as a configured server. Its
  instructions, resources and prompts are T-115's work.
- **A remote Gitea entry.** Only Konfersi runs a remote gitea-mcp; until the stdio entry can run, Konfersi can use the Built-in
  catalogue's Gitea in token mode with the name `GITEA_KONFERSI_TOKEN`. Not on the same workspace as `gitea-konf`.
- **Browser servers as a set.** `entries/playwright.json` and `entries/chrome-devtools.json` are references with
  `"publish": false`: the Browser pool already delivers both at these exact versions, gated (`REVIEW.md` §4, §5).
- **Plane.** Not drafted: Python only (PyPI waits for `uv`), and one tool per resource mixes reads with deletes (`REVIEW.md` §6).
- **Look-alike npm packages.** `gitea-mcp` (npm, by another author), `github-mcp-server` (npm, unrelated), the deprecated
  `@modelcontextprotocol/server-github` and the community Outline servers.
- **Any secret value.** Only names, one per host, never shared between hosts.

## Open for the owner

1. **The image change** that puts gitea-mcp (an exact release, checksum-checked) at `/usr/local/bin/gitea-mcp`: a ticket of its
   own, with an image rollout (D-5: one workspace pod).
2. **D-3 and ask rules:** autonomous chats run with ask rules removed, so "write tools ask" holds only in interactive
   workspaces; deny rules hold everywhere (`REVIEW.md`, "Read this first", item 5).
3. **Bot accounts and keys**, one per instance, with the scopes in `REVIEW.md` §1 and §2, stored in Secrets & env under the
   names above, each Secrets & env set assigned only where its host is used.
