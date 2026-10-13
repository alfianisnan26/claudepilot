# Kit: MCP sets

The MCP part of the operating kit (T-132 item 4, D-26): draft catalog entries and set definitions, ready for the owner's
review. Three program sets (`isnan`, `konfersi`, `kohi-labs`), each with that program's Gitea and Outline. **Nothing here is
approved or delivered.** `publish.mjs --only=mcp` puts the entries into the portal's catalog as **drafts** and creates a set only
after a person approved its entries. Third-party MCP servers run with the workspace user's rights or receive what the agent sends,
so every entry waits for a person to approve it in the portal ([MCP set pool](../../prd/mcpset-pool.md) FR3, FR5a).

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
| Kohi Labs | `git.kohi-labs.com` | `outline.int.kohi-labs.com` (internal) |

**One Gitea entry, three Outline entries, three program sets.** gitea-mcp runs in the workspace over stdio, and a stdio entry
takes the host as an environment slot (`GITEA_HOST`), so one reviewed entry serves all three with a different host and token
file per program set. A remote entry's URL is part of the reviewed version and can't be config, so Outline (whose MCP endpoint
is inside each instance) needs one entry per host. `REVIEW.md`, "Read this first", item 2, has the reasoning and the code it
rests on.

## Which set for which project

**Least privilege: a project gets the set of its own program, and nothing else.** Three sets, one per program, each holding
that program's Gitea (server `gitea`) and Outline (server `docs`). A workspace of the Konfersi program gets `konfersi` and never
sees the Isnan or Kohi Labs hosts: their servers aren't in its set, and their token names aren't in its Secrets & env sets.
There is no all-hosts set, not even a read-only one: a workspace that works across programs gets the sets of those programs, by
a person's choice, one by one.

| Set (name) | Servers (key: host) | Secret names | For |
| --- | --- | --- | --- |
| `isnan` (Isnan) | `gitea`: git.isnan.me; `docs`: docs.isnan.me | `GITEA_ISNAN_TOKEN`, `OUTLINE_ISNAN_KEY` | the Isnan program's projects |
| `konfersi` (Konfersi) | `gitea`: git.konfersi.com; `docs`: outline.int.konfersi.com | `GITEA_KONFERSI_TOKEN`, `OUTLINE_KONFERSI_KEY` | the Konfersi program |
| `kohi-labs` (Kohi Labs) | `gitea`: git.kohi-labs.com; `docs`: outline.int.kohi-labs.com | `GITEA_KOHILABS_TOKEN`, `OUTLINE_KOHILABS_KEY` | the Kohi Labs program's projects |
| `github` (GitHub), **optional draft, not published by default** | `github`: api.githubcopilot.com, read-only, lockdown on | `GITHUB_MCP_TOKEN` | a project hosted on GitHub or mirrored there; set `X-MCP-Readonly` to `false` in its own revision to write. D-8: Gitea is the git host, GitHub a mirror, so the publisher leaves it alone (`manifest.json`: `publish: false`, `optional: true`) |
| none | Browser pool | none | UI testing: the Browser pool delivers Playwright MCP and chrome-devtools-mcp through its gate (reference entries only) |
| none | Portal MCP | none | issues are pilot tickets |

Slugs are at most 12 characters (`kohi-labs` is 9), server keys at most 16. Tool names read
`mcp__plugin_cpm-<set>_<key>__<tool>`, for example `mcp__plugin_cpm-konfersi_gitea__issue_read` and
`mcp__plugin_cpm-konfersi_docs__fetch`. The slug is fixed once a workspace has the set (its tool names depend on it).
Each program set uses `git-host-gitea` once and one Outline entry once, and a workspace gets one program set, so the "entry in
two sets" warning (MCP set FR11) does not come up.

**Writes by default, because it is the program's own host.** The program sets do not set `GITEA_READONLY`: the program's agents
file issues, comment and review on their own Gitea, and the write tools ask (interactive workspaces) while the destructive
ones are denied everywhere (`tool-rules.json`). A project that only reads sets `GITEA_READONLY` to `true` in its own revision of
the set (server side, every write tool disappears), and gives the bot a read-only token and a read-only Outline key. The token's
scopes stay the real limit (`REVIEW.md` §1, §2).

## How it maps to the portal

1. **Entry → draft.** By a person (`POST /api/mcp/catalog`, "Add manually") or by an agent (`mcp_propose_entry` over the Portal
   MCP, with `reason`). Either way a draft: no set accepts it and nothing is delivered.
2. **A person reviews and approves** on the entry's page: the exact URL or command, the risk flags, the slots, the box "I
   reviewed the command and its source". `REVIEW.md` is the reading for that box.
3. **The set is created** (a pool of type `mcpset`, named by `manifest.json`) from `sets/<slug>.json`, with `@<entry key>` replaced by
   the approved entry's id and `@approved` by its newest approved version. A set refuses a draft, so this follows approval: a
   set waits until **both** of its entries (Gitea and Outline) are approved.
4. **Secrets & env provides the names**, one Secrets & env set per program (two "For MCP servers" secret files each: the Gitea token
   and the Outline key), assigned only to the workspaces of that program's projects. A missing name leaves out only its server ("Needs NAME").
5. **Assign** the program's set to the project's workspaces (the `pilot-way` template does this, T-132 item 5), add the project's hosts to
   the onboarding host allow-list (T-133) and to the egress exceptions where network isolation is on (`manifest.json` → `hosts`),
   and put the sets' lines from `tool-rules.json` into Settings & policies' custom ask and deny rules for those workspaces until
   MCP set tool rules (M5) exist.

## What the publisher does (`node docs/kit/publish.mjs --only=mcp`)

Run by the owner's portal session (it signs in with the server code, like the other parts). Dry by default, `--apply` writes. It
never approves, never takes or prints a secret value, never assigns a set to a workspace, and never creates a Secrets & env entry.

1. **Validates every file:** JSON parses; entry keys and server keys `[a-z0-9-]` at most 16, slugs at most 12; no value in any
   `secrets` map other than `{{secret-file:NAME}}`; every `@<entry key>` names a manifest entry; nothing credential-shaped
   (the portal refuses it too).
2. **Reports `manifest.json` → `prerequisites`** (today: the gitea-mcp binary in the workspace image).
3. **Entries.** For each entry with `"publish": true` (the three Outline entries and `git-host-gitea`; `git-host-github` is
   `optional` and `publish: false`, so it is not touched): look the key up in the catalog. Absent: `POST /api/mcp/catalog` with
   the entry file as the body, which makes a **draft** and nothing else. Present with a version of the same spec and slots (any
   state): nothing to do, it prints that version's state. Present with a different spec: it adds a new draft version
   (`POST /api/mcp/catalog/<id>/versions`, the server's own rule for a change), unless an older draft still waits, in which case
   it reports and stops for that entry. The entry file's `reason` (manifest) is printed, since a manual entry has no reason field.
4. **Sets.** For each set with `"publish": true`: `@<entry key>` becomes the entry's catalog id and `@approved` the entry's newest
   approved version. If every entry of the set has an approved version, the pool `mcpset` named in the manifest is created, or
   gets a revision when its content differs (`unchanged` when it does not). Otherwise it prints
   `set <slug>: waiting for the owner's approval of <entry keys>` and creates nothing. If the pool name or the slug is taken by
   another set, the portal refuses and the script stops with its message: never another slug silently, since tool names and
   rules depend on it.
5. **Prints the secret names** each set needs (names only) and tells that `tool-rules.json` holds the rules per set; applying them
   is a Settings change by a person.
6. `published.json` gets `mcp.entries` (key to entry id) and `mcp.sets` (slug to pool id).

## Not in the kit, on purpose

- **The Portal MCP itself.** T-132 lists a `pilot` set, but the Portal MCP is not a catalog entry: every chat session gets it
  with its own short-lived agent token, bound to that workspace and session ([Portal MCP](../../prd/portal-mcp.md)). The catalog
  refuses URLs under the portal's own address (MCP set §6), and the base drop-in denies it as a configured server. Its
  instructions, resources and prompts are T-115's work.
- **A remote Gitea entry.** Only Konfersi runs a remote gitea-mcp; until the stdio entry can run, Konfersi can use the Built-in
  catalogue's Gitea in token mode with the name `GITEA_KONFERSI_TOKEN`. Not on the same workspace as the `konfersi` set.
- **Browser servers as a set.** `entries/playwright.json` and `entries/chrome-devtools.json` are references with
  `"publish": false`: the Browser pool already delivers both at these exact versions, gated (`REVIEW.md` §4, §5).
- **Plane.** Not drafted: Python only (PyPI waits for `uv`), and one tool per resource mixes reads with deletes (`REVIEW.md` §6).
- **Look-alike npm packages.** `gitea-mcp` (npm, by another author), `github-mcp-server` (npm, unrelated), the deprecated
  `@modelcontextprotocol/server-github` and the community Outline servers.
- **An all-hosts set**, read-only or not. The old `gitea` and `outline` sets that held all three hosts are gone: a program gets its own set.
- **Any secret value.** Only names, one per host, never shared between hosts.

## Open for the owner

1. **The image change** that puts gitea-mcp (an exact release, checksum-checked) at `/usr/local/bin/gitea-mcp`: a ticket of its
   own, with an image rollout (D-5: one workspace pod).
2. **D-3 and ask rules:** autonomous chats run with ask rules removed, so "write tools ask" holds only in interactive
   workspaces; deny rules hold everywhere (`REVIEW.md`, "Read this first", item 5). The program sets leave `GITEA_READONLY`
   off by default; a read-only project turns it on in its own revision.
3. **Bot accounts and keys**, one per instance, with the scopes in `REVIEW.md` §1 and §2, stored in Secrets & env under the
   names above (six names), each Secrets & env set assigned only to its program's workspaces.
4. **Approve the four entries** in the portal (`git-host-gitea`, `outline-isnan`, `outline-konfersi`, `outline-kohilabs`), then
   run `publish.mjs --only=mcp --apply` again: the three sets appear. `git-host-github` stays a draft file until a project needs it.
