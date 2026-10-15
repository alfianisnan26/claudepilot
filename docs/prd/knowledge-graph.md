# PRD: Knowledge graph and second brain

| | |
| --- | --- |
| Status | **v0.3: K0 to K2 built** (vault core, UI, the three graphs, the MCP tools); K3 (git sync, snapshots into workspaces, external systems) not built. Built from the owner's one-line brief ("agentic graph, docs and context graph, second brain docs integrations like Obsidian"); the reading of it and the rulings that shaped it (per-session agent tokens I8, no file inbox, default policy `write-own`, agent notes out of snapshots until promoted) are in §1, §7 and §23. Compatibility with Obsidian was checked against its documented conventions, not against the Obsidian app. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [Portal MCP server](portal-mcp.md) (tool registry, scopes, audit, sanitizer), [Pools foundation](foundation-pools.md) (the data directory, backups, delivery into workspaces), [Chat sessions](chat-sessions.md) (session identity and transcript, for the context graph) |
| Related | [Workspace Claudes](workspace-claudes.md), [Secrets & env pool](secrets-env-pool.md) (git credentials by name), [MCP set pool](mcpset-pool.md), [Skillset pool](skillset-pool.md), [Persona pool](persona-pool.md), [Web app & PWA](web-app-pwa.md), a Tickets PRD (planned) |

## 1. Summary

The portal gets a **second brain**: *vaults* of plain Markdown notes that the admin and the agents both read and write. A vault is an ordinary folder of `.md` files in Obsidian's own conventions (`[[wikilinks]]`, aliases, heading and block links, embeds, YAML frontmatter, `#tags`, attachments, daily notes, callouts), so a vault opens in the real Obsidian app and an existing Obsidian vault imports cleanly. There is no proprietary format.

Over the same data the portal draws **three graphs**:

- The **docs graph**: notes linked by wikilinks, with backlinks, tags and unresolved links.
- The **context graph**: which context an agent used and produced, as edges from sessions and tickets to the notes they read or wrote.
- The **agentic graph**: the portal's own entities and how they relate (workspaces, Claudes, sessions, tickets, personas, skills, MCP servers, worktrees: spawned by, assigned to, depends on, mentions).

Agents reach vaults through the Portal MCP: search, read, write, append, backlinks, daily notes, tags and graph queries. A write carries its actor and an optimistic version check, so an agent never silently overwrites a person's edit, and every write is versioned and recoverable. Integrations follow the Obsidian approach: zip import and export first, then a two-way sync with a git remote (the standard route between Obsidian and a server), then a read-only snapshot delivered into workspaces so agents can `grep` it with their own file tools, the repository's own `docs/` folder as a read-only source, and external doc systems last.

## 2. Background and problem

- Agents forget. Each portal session starts from a persona, a repository's `CLAUDE.md` and whatever the person types. What one session learned (a decision, a how-to, a link between two projects) lives in that session's transcript and nowhere else. The people who run agents already keep a second brain for themselves, very often an Obsidian vault, and the agents never see it.
- The agent world has converged on the same shape: a folder of Markdown that a person curates and an agent reads and appends to. It works because it is plain text, greppable, diffable and tool-neutral.
- The portal knows a lot about how work is wired (which session ran where, which ticket belongs to which session, which persona and skills a workspace has) but shows it only as lists. Nothing answers "what did that session actually read before it decided this?" or "how are these workspaces, tickets and sessions related?".
- The portal's own PRDs link to each other in Markdown. They are a ready-made small knowledge base with real edges, and a good test of the feature.

**The owner's brief, read three ways** (the first is the reading I built; the others are listed so the coordinator can redirect):

| Reading | What it means | Decision |
| --- | --- | --- |
| A. A second brain in the Obsidian style, with three graph views and agent access | This PRD | **Taken.** It fits every word of the brief ("agentic graph, docs and context graph, second brain docs integrations like obsidian approach") |
| B. Only a graph of the portal's entities | No notes | Contained in A as the agentic lens (§12) |
| C. Retrieval over documents with embeddings (RAG) | Vector search over docs | A non-goal for v1 (§4); full-text search and the link graph are the retrieval. Embeddings are a later question (Q7) |

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Obsidian-native.** A vault is a folder of plain files. Import and export lose nothing except the app folders Obsidian owns (§9). Nothing in the portal needs a file the portal's own format added. |
| G2 | **One store, two kinds of writers.** People and agents write the same notes. A write never silently replaces someone else's edit; every change is attributed, versioned and recoverable (§8, FR7 to FR10). |
| G3 | **Three graphs, one model.** Docs, context and agentic views share one node and edge model and one renderer that works with a thumb as well as a mouse, with a plain list as the accessible equivalent (§12). |
| G4 | **Agents get tools, with guard rails.** Notes tools in the Portal MCP, a per-vault policy for what agents may write, secrets kept out of notes, note text treated as untrusted when it goes back to a model (§14). |
| G5 | **Safe files.** No path escapes, no script from a note or an attachment reaches a browser, size and count caps, atomic writes (§17). |
| G6 | **Fast and honest at scale.** A vault of 10,000 notes searches in tens of milliseconds and draws a graph that stays smooth by capping and clustering, saying so on screen (§12, §21). |
| G7 | **Included in the backup and export story.** Everything a vault holds can be exported, and the history, audit and context edges ride in the portal's database backups (§10). |

## 4. Non-goals

- **Replacing Obsidian.** No plugins, themes, Canvas editor, Dataview, Sync or Publish, no Obsidian mobile app. The portal is a place agents and the admin share notes; people who live in Obsidian keep living there (§9).
- **Live collaborative editing.** No CRDT. Two writers are detected by a version check and surfaced as a conflict; the person decides (FR7). Git sync merges text and keeps both sides when it can't (§15.2).
- **Embeddings and semantic search in v1.** Full-text search (SQLite FTS5), titles, aliases, tags and the link graph. Q7.
- **A graph database.** The graphs are derived from SQLite tables on request. There is no query language beyond the tool inputs in §14.
- **Per-user identity and permissions.** One shared admin, as everywhere in the portal today. Actors are labels (`ui`, `session:<id>`, `portal-mcp:<token id>`), not accounts.
- **An admin token inside a workspace.** `cpat_`, `cpoa_` and `cpor_` never reach one. A workspace's agent reaches the notes tools with the per-session token the Portal MCP mints for it (I8: `cpst_`, bound to that workspace and session, scope `agent`, alive as long as the session), and only where the workspace opted in. Its reach is the vault policy (FR24), never more.
- **Rendering plugin syntax.** Dataview queries, Mermaid, math, Canvas and Excalidraw files are kept verbatim and shown as code or as files, never executed (§9).
- **Claude Code's own memory.** `CLAUDE.md`, auto-memory and the Persona pool stay as they are. A vault is reference material and working notes, not an instruction layer.
- **Hosting a public site.** No publishing.

## 5. Users and stories

**Admin** holds the server code and uses the portal from a phone or a desktop. **Admin's Claude** is claude.ai, Claude Desktop or Claude Code on the admin's machine, connected to the Portal MCP. **Workspace agent** is Claude Code in a portal session inside a workspace.

| ID | Story |
| --- | --- |
| US1 | On my phone I open Knowledge, create a vault, write a note with `[[links]]` and `#tags`, and find it again by searching a word from its body. |
| US2 | I zip my Obsidian vault and import it. Links, aliases, tags, embeds and daily notes work; `.obsidian` is not imported; I'm told what was skipped and why. |
| US3 | I export the vault as a zip, unzip it, and open it in Obsidian. It looks the way it did in the portal. |
| US4 | My agent appended to today's daily note. I see who wrote it and when, open the history, and restore the earlier text. |
| US5 | An agent tries to rewrite a note I edited a minute ago. It is refused with the current version, and my text is untouched. |
| US6 | I open a note and see its backlinks, its outline, its properties and a small graph of what it connects to. On the phone the graph pans and zooms with my fingers and a tap on a node opens it. |
| US7 | I open the context graph for a session and see every note it read and wrote. From a note I see which sessions and tickets used it. |
| US8 | I open the agentic graph and see how my workspaces, Claudes, sessions, tickets, personas, skills and MCP servers connect, and tap any node to open that entity. |
| US9 | I ask Claude in claude.ai "what do my notes say about the Redis outage?". It searches my vault over MCP, reads two notes and answers, and the notes it used show up in the context graph. |
| US10 | I point Knowledge at the portal's own `docs/` folder, read-only, and see the PRDs as a graph. |
| US11 | I connect a vault to a git remote that Obsidian (with the obsidian-git plugin) also syncs. An edit on either side reaches the other, and a clash produces a conflict note instead of lost text. |
| US12 | I give a workspace a read-only snapshot of a vault. The agent greps it with its normal tools and its reads show in the context graph. |

## 6. Scope boundary

| Allowed | Never |
| --- | --- |
| Reading and writing plain files inside a vault's own folder, atomically, with every change journaled | Writing anywhere else on the portal machine; following a symlink out of the vault; writing `.obsidian`, `.trash` or any dot-folder |
| Importing a zip or a folder (caps, safe paths, skips reported); exporting a vault as a zip | Importing executable or script-capable files; unpacking without caps |
| Agents reading notes and, per the vault's policy, creating and appending notes | An agent deleting or renaming notes, changing a vault's settings or policy, or writing a secret into a note (§14) |
| Returning note text to a model labeled as untrusted, sanitized and capped | Treating note text as instructions, putting it in tool descriptions or in server instructions |
| Reading the portal's own tables (sessions, tickets, workspaces, pools) through thin read-only adapters to draw graphs | Writing to another area's tables; storing session transcripts in a vault |
| Pointing a read-only source at an operator-allowed folder on the portal machine | A browser or an agent choosing an arbitrary server path |
| Notes tools for a workspace's agent through its own session token (I8); an optional read-only snapshot delivered through the pool framework | An admin token in a workspace; a session token used for anything but the tools it was minted for |
| Credentials for a git remote by Secrets & env name | A token or key in a vault, in a note, in the knowledge tables or in a log |

## 7. Solution overview

```
 Admin (phone, desktop)        Admin's Claude                     Agents in workspaces
   │ /api/knowledge/*            │ /mcp  note_*, vault_*, graph_*     │ read-only snapshot (files)   (K3)
   │ cookie session              │ PAT or OAuth, read or operate      │ /mcp with its session token
   ▼                             ▼                                    │ (scope agent); a snapshot (K3)
 ┌──────────────────────────── Portal: one Node process ───────────────────────────────────────────┐
 │ routes ─▶ KnowledgeService ─▶ VaultStore ─▶ atomic write ─▶ <data>/knowledge/vaults/<id>/       │
 │             │      │              │                          plain files, an Obsidian vault        │
 │             │      │              └─▶ Index (SQLite, per vault, rebuildable)                      │
 │             │      │                  <data>/knowledge/index/<id>.db: files, links, tags, FTS5     │
 │             │      └─▶ portal.db (kg_*): versions, audit, context edges, vault settings, sync      │
 │             └─▶ Graph builders: docs ◀ index; context ◀ kg_edges; agentic ◀ read-only adapters    │
 │                  (workspaces, chat_sessions, pools, tickets when present)                         │
 └───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Decisions** (the reasons are in §10):

1. **Files are the truth.** A vault is a directory under the portal's data directory. The current content of every note is the file. Nothing about the current text lives only in a database.
2. **The index is rebuildable.** One SQLite file per vault holds files, links, tags, headings and an FTS5 index. Deleting it loses nothing; the next start scans the folder. It is not part of database backups.
3. **History, audit and context edges are durable.** They live in `portal.db` (migrations 50 to 59), so they ride in the portal's backups, its Locked and Frozen rules and its restore.
4. **One writer path.** Every change, from the UI, from MCP, from an import or from sync, goes through the same service: check the version, write the file atomically, journal it, update the index. Edits made on disk by other tools are found by a scan and journaled as `external`.
5. **Graphs are lenses on one model.** Nodes and edges with kinds; the docs, context and agentic views differ in which kinds they show and where they start (§12).
6. **Agents are policy-bound.** Each vault says what agents may do (`off`, `read`, `write-own`, `write`), enforced in the service whatever the token's scope (FR24).

## 8. Functional requirements

### Vaults and files

- **FR1** A **vault** is a folder under `<PORTAL_DATA_DIR>/knowledge/vaults/<id>`, created by the portal, with a display name, an agent policy (FR24), a daily-notes folder and a time zone. A **folder source** is an existing directory on the portal machine that the operator allowed (`PORTAL_KNOWLEDGE_ROOTS`, §15.4), read-only unless the operator also allowed writes. Both are indexed and browsed the same way. Deleting a vault moves its folder to `knowledge/trash/` for 14 days and needs its name typed.
- **FR2** A note is a UTF-8 `.md` file. A leading byte-order mark is read past and kept; CRLF line endings are kept when a note already uses them; new notes use LF. A file that is not valid UTF-8 is listed as an attachment, never decoded.
- **FR3** Attachments are the other files, from the allow-list in §17.2. Images, audio, video and PDF are served inline; other allowed types download. A file whose type isn't on the list is skipped on import and refused on upload, with the reason shown.
- **FR4** Dot-entries (`.obsidian`, `.trash`, `.git`, anything starting with a dot), `__MACOSX` and the usual junk (`.DS_Store`, `Thumbs.db`, `desktop.ini`) are ignored: not indexed, not exported, never written. Two Obsidian hints are read once at import from `.obsidian/daily-notes.json` (`folder`, and `format` only when it is `YYYY-MM-DD`) and nothing else from `.obsidian`.
- **FR5** Paths are NFC-normalized and `/`-separated, at most 1,024 characters, 32 levels deep and 255 bytes per segment. New names may not contain `\ / : * ? " < > |` (Obsidian refuses these), `# ^ [ ]` (Obsidian warns they break links), control characters, leading or trailing spaces or dots, or a Windows reserved name (`CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to `LPT9`, with or without an extension). Two paths that differ only by case or normalization can't both exist, so a vault stays portable to macOS and Windows. A path that resolves outside the vault, through `..`, an absolute path or a symlink, is refused (§17.1).
- **FR6** Every write is atomic: the new bytes go to a temporary file in the same directory (a dot-name, so scans and Obsidian ignore it), are flushed, then renamed over the target, then the directory is flushed. A crash leaves the old file or the new one, never half of either. Leftover temporary files are removed at start. Writes to one vault are serialized; the index and journal are updated in the same operation.

### Versions, history and recovery

- **FR7** A note's **version** is the SHA-256 (first 16 hex characters) of its bytes. Reading returns it. Replacing or editing an existing note needs `base_version`; if the file has since changed, the write is refused with `CONFLICT` and the current version and text, and nothing is written. Creating a note that exists is also a `CONFLICT`. Appending needs no base: it is done under the vault's lock against the current bytes.
- **FR8** Every change is journaled in `kg_versions` with its operation, actor, the version it was based on, the version it produced and the full text of the result, compressed. A note's first journal row is the text it had before the first change, so history starts where the portal first touched it, and unchanged imported notes cost no journal space. Changes by the same actor on the same note within five minutes of each other update the newest row instead of adding one, so autosave doesn't flood history. At most 200 versions per note and 256 MB per vault are kept, oldest first, never the newest or a delete marker younger than 30 days.
- **FR9** **Restore** writes an old version as a new change (operation `restore`); history is never rewritten. A deleted note is restorable from history for 30 days.
- **FR10** **Rename and move** keep the note's history and context edges, and by default rewrite the links that pointed at it in other notes, in each link's own style (wikilink or Markdown link, heading, block and alias parts kept), the way Obsidian does. Each rewritten note is an ordinary journaled change by the same actor. A crash part-way leaves some links unresolved, which the link-health list shows (FR16); no text is lost.

### Reading, search and structure

- **FR11** The portal reads each note's structure: frontmatter, wikilinks, embeds, Markdown links to notes, `#tags`, headings, block ids and aliases (§9), ignoring fenced code, inline code, `%% comments %%` and HTML comments. Links resolve case-insensitively, by path from the vault root, by path relative to the linking note, by unique name, and, when several notes share a name, by the closest folder, then the shortest path, then alphabetically (our own rule; Obsidian's isn't documented). Links that resolve ambiguously are flagged.
- **FR12** **Search** is full text over title, path, tags, aliases and body: words with prefix matching on the last word, `"phrases"`, `-exclusions`, `tag:`, `folder:` and `file:` filters, ranked with the title and tags weighing more. A vault of 10,000 notes answers in tens of milliseconds (§21). Results show a snippet around the match, the path, the tags and who last changed the note.
- **FR13** **Backlinks** list the notes that link to or embed a note, with the line. **Unlinked mentions** list notes whose text mentions the note's title or an alias without linking it.
- **FR14** A note view shows a Properties panel (frontmatter), an outline (headings), tags and, for notes an agent wrote, a badge naming the actor and time.
- **FR15** **Daily notes** are `YYYY-MM-DD.md` in the vault's daily folder, created on first write, never on read. "Today" uses the vault's time zone on the server and the browser's in the UI.
- **FR16** **Link health** lists unresolved links (with their sources and "did you mean" from titles and aliases), ambiguous links, links to a heading or block that doesn't exist, broken embeds and orphan notes.
- **FR17** A **rescan** (on start, on demand, and when a listing is more than five seconds stale) compares each file's size and modification time with the index, re-reads what changed, and journals edits the portal didn't make as `external`. A rename made outside the portal is recognized by identical content.

### Graph

- **FR18** The Graph page has three lenses (docs, context, agentic) over one node and edge model (§12), each with filters, a local mode around one node, a node cap with clustering, and deep links from every node to its page.
- **FR19** The graph works with touch (drag to pan, pinch to zoom, tap a node to open it), with mouse and keyboard, and has a plain list view with the same nodes and links for screen readers and small screens.

### Agents and tools

- **FR24** **Agent policy** per vault: `off` (tools say the vault isn't available), `read`, `write-own` (the default), `write`. `write-own` lets an agent create notes, edit and append to notes that only agents have written, and append to daily notes; it can't change a note a person ever wrote or edited. `write` adds editing and appending to any note, still with the version check. No policy lets an agent delete, rename, change settings or write to a read-only source.
- **FR25** The Portal MCP gets the tools in §14 through its registry. Read tools need `pilot:read`; write tools need `pilot:operate`. The notes tools never take a secret.
- **FR26** Every agent write carries its actor (`portal-mcp:<token id>`, plus `session:<id>` or `ticket:<id>` when the channel supplies it), is checked against `base_version` where FR7 requires, and is journaled and audited.
- **FR27** Agent writes are scanned with the chat redactor's secret patterns. A write that matches is refused with `SECRET_IN_CONTENT`, naming the kind of match and never the text, and the audit row says `[redacted]`. A person's write that matches is saved and flagged with a warning; the portal never edits a person's text.
- **FR27a** **Release reports (T-591, D-69).** The portal itself is a writer: when a remote's release passes, CI (not an agent) writes `<folder>/<date> portal <tag> workspace <tag>.md` and `<folder>/README.md` (the folder is the setting's, e.g. `Releases`) into the vault the remote's own setting names (see [Local git CI](local-git-ci.md) FR41b), through `putNote` as actor `system`. A system write is journaled like any other (FR8); an existing note is replaced with its own current version as `baseVersion`, a missing one is created. No agent route or tool takes a vault or a folder for this: the target is the repository's setting, which only a person changes, and only for a vault that person may write (checked when it is saved).
- **FR28** Note text and frontmatter returned over MCP are `untrusted_text` with a `source` (`note:<vault>/<path>`) and the author's kind, through the Portal MCP sanitizer ([Portal MCP](portal-mcp.md) §14.4), and are capped at 8,000 characters per field (the sanitizer's limit for a document-sized field) with an offset to read on.
- **FR29** **Edges are recorded** for every note an agent reads or writes through a tool: who (a session, a ticket, a token or the UI), what (read, created, edited, appended, deleted), which note, how many times, first and last time. Renames carry them along. Session identity comes only from the authenticated channel, never from tool arguments (§14.3).
- **FR30** Per-token scopes are the Portal MCP's (read, operate); a token may also be limited to a list of vaults ([Portal MCP](portal-mcp.md) amendment A1 in §22).

### Integrations

- **FR31** **Zip import and export** (§15.1), the first integration.
- **FR32** **Git sync** (§15.2): two-way, per vault, conflicts never lose text.
- **FR33** **Snapshot into workspaces** (§15.3): read-only files, delivered through the pool framework, an optional convenience for `grep`; agent-written notes are left out until a person promotes them.
- **FR34** **Folder sources**, including the repository's `docs/` (§15.4).
- **FR35** **External doc systems** (§15.5), last.
- **FR36** (K4, owner 2026-10-13, T-106) **Agents attach and read files.** An agent puts an image or a file into a vault and reads one back, through the Portal MCP, under the same rules as a person's upload (FR3, §17.2): the allow-list, the size cap per attachment, content sniffing (the type is judged from the bytes, never from the name or the declared type), the vault's agent policy (FR24: `write-own` and `write` may put; `read` may only read), the vault's file and size caps, and the secret scan does not apply to bytes but a text file is scanned like a note (FR27). SVG and HTML are never served inline to a browser, from an agent or anyone.
- **FR37** (K4) **What the agent sees.** `note_read` lists a note's embeds and links to attachments (`![[img.png]]`, `![[file.pdf]]`) with name, type and size, so the agent knows they exist. `attachment_get` returns an image as an MCP image content block (so a model that takes images looks at it), a text file as `untrusted_text` (FR28), and any other allowed type as a short description with a download link that needs the portal's own sign-in. Text found inside an image or a document is untrusted input to the agent, and the tool result says so.
- **FR38** (K4) **Attribution and limits.** Every put is journaled and audited with the actor (FR26), counted in the edge record (FR29) as `attached`, and rate limited like note writes. An agent never overwrites an attachment it did not create without `base_version` (the content hash); two files with one name get a numbered name, never a silent replace.
- **FR39** (K4) **A built-in skill.** A `knowledge` skill ships in the Skillset pool and is assigned to every workspace by default (editable, removable): it teaches an agent the vault conventions of this PRD (folders, `[[links]]`, frontmatter, tags, the daily note), when to write (decisions, lessons, runbooks, status; never secrets or transcripts), to search before writing, to cite tickets and sessions, to attach screenshots for evidence, and that note and attachment text from outside is untrusted. It is plain text, reviewed like any skill (Skillset pool §review).

## 9. Obsidian compatibility

Checked against Obsidian's documentation and the conventions its vaults use. **Not checked against the Obsidian app**, which isn't available here; the first real check is opening an exported vault in it (Q1).

**Supported** means read, written and kept verbatim. **Partly** says what isn't. **Not** means the syntax or file is preserved byte for byte but not rendered, edited or acted on.

| Feature | Support | How |
| --- | --- | --- |
| A vault is a folder of `.md` files in subfolders | Supported | Any depth to 32; case-insensitive uniqueness for new files (FR5) |
| `.obsidian/`, `.trash/`, every dot-entry | Supported by ignoring | Not imported, not exported, never written. Two hints read at import (FR4) |
| `[[Note]]`, `[[Note\|alias]]` | Supported | Case-insensitive, `.md` optional, spaces and Unicode in names |
| `[[Note#Heading]]`, `[[Note#Heading#Sub]]`, `[[#Heading]]`, `[[Note#^block-id]]` | Supported | A missing heading or block still links to the note and shows in link health |
| `![[Note]]`, `![[Note#Heading]]`, `![[Note#^id]]` embeds | Supported in the preview | Depth 3, cycles cut, text of the target section inline |
| `![[img.png]]`, `![[img.png\|300]]`, `![[img.png\|300x200]]` | Supported | From the vault's attachments, never from a remote URL |
| `![[file.pdf#page=3]]`, audio and video embeds | Partly | Shown as an attachment chip that opens the file; no inline PDF viewer in v1 |
| Markdown links to notes: `[x](Folder/Note.md)`, `[x](<Note with spaces.md>)`, `%20` | Supported | Resolved and counted as links, so the repository's PRDs form a graph |
| Link resolution: shortest path, relative, absolute | Supported | By path, relative path, unique name |
| Duplicate note names | Partly | Our deterministic tie-break (FR11); Obsidian's own isn't documented |
| Aliases (`aliases:` in frontmatter) | Partly | Used in search, the quick switcher, mention suggestions and graph labels. A raw `[[Alias]]` stays unresolved, as it does in Obsidian |
| YAML frontmatter | Supported | Kept verbatim. Invalid YAML is kept and flagged. `tags`, `aliases`, `cssclasses` understood; other keys shown in Properties. Properties are edited as text in v1 |
| `#tag`, `#nested/tag`, frontmatter `tags` (list or comma string) | Supported | Not inside code or comments; a number alone isn't a tag; case-insensitive; a tag pane with counts |
| Callouts `> [!note]`, foldable `+` and `-`, custom titles | Supported | Built-in types styled; an unknown type renders as a generic callout |
| Task lists `- [ ]`, `- [x]` | Supported | Checkboxes in the preview. Toggling from the preview is a later item |
| Highlights `==x==`, comments `%%x%%`, strikethrough, tables, footnotes `[^1]` | Supported | Comments hidden in the preview, kept in the file |
| Inline footnotes `^[text]`, block ids shown, `^id` | Partly | Block ids are indexed and linkable, shown muted; inline footnotes render as text |
| Math `$x$`, `$$x$$`, Mermaid, syntax highlighting | Partly | Kept; shown as plain text or a code block |
| Attachments: images, audio, video, PDF | Supported | Allow-list (§17.2); upload to a configurable folder |
| Canvas `.canvas`, Bases `.base`, Excalidraw `.excalidraw.md` | Not | Kept, listed, exported; not rendered or edited |
| Daily notes core plugin | Partly | `YYYY-MM-DD.md` in a folder; other date formats are Not |
| Templates, Periodic Notes | Not | Template files are ordinary notes |
| Community plugin syntax (Dataview, Tasks, Kanban, Templater) | Not | Preserved verbatim |
| Themes, CSS snippets, hotkeys, workspace layout | Not | Part of `.obsidian`, ignored |
| Obsidian Sync, Publish | Not | Use git sync or zip |
| Rename updates links | Supported | On by default, both link styles (FR10) |
| Opening a vault in Obsidian | Supported | Export a zip, or sync through git. Direct folder open only where the operator exposes the data directory |
| `obsidian://open?vault=...&file=...` | Partly | An "Open in Obsidian" action; it works only where that vault is already open in the person's app |

## 10. Storage decision

### 10.1 Options

| Option | For | Against |
| --- | --- | --- |
| **A. Files are the truth; a rebuildable SQLite index; history and audit in `portal.db`** (chosen) | The vault is an Obsidian vault at every moment, so there is no import or export step to trust. Greppable and diffable by agents and git. No lock-in: delete the portal and the notes are still there. A damaged index is a rescan. History survives in the database backups. | Two writers (the portal and anything else touching the folder), so a scan and a version check are needed. Backups split in two (below). Filesystem quirks need explicit rules (FR5). |
| B. Database is the truth; files only on export | One transaction for everything, backups complete, no path or symlink issues. | Not Obsidian-native: the vault exists only after an export. Agents can't grep it without a snapshot step. Git sync becomes a materialize-and-parse cycle. Binary attachments in SQLite or a blob store anyway. |
| C. A git repository is the truth | History and sync for free. | Needs the `git` binary on every portal host; one commit per write is slow and noisy; conflicts surface in the middle of ordinary writes; history is hard to query by actor. Git is better as an integration (§15.2) than as the store. |
| D. Files with no index (search by scanning) | Simplest. | Ten thousand notes is not "tens of milliseconds"; no backlinks or tags without parsing everything each time. |

### 10.2 Why A

The product is "a vault Obsidian can open". Only A makes that true at every moment, and only A lets an agent read the vault with `grep` and `Read` after a plain copy. The costs are real and each has a mitigation:

- **Two writers.** The version check (FR7) protects portal writers from each other and from the file. A scan (FR17) picks up outside edits and journals them, so history stays complete even when someone edits the folder with another tool. A crash between the file rename and its journal row is repaired by the next scan, which records the change as `external` (the actor is lost, the text isn't).
- **Backups split.** The vault folders sit in the data directory, next to `portal.db`, so a volume backup carries them. `portal.db` carries history, audit and context edges (and so the text of every note that has ever been changed through the portal). Every vault can be exported as a zip at any time (FR31), and the portal writes a daily vault zip next to the database backups, keeping the last three, only for vaults that changed (K1). Restoring `portal.db` without the folders loses only never-edited notes' text, which the folders hold. Index files are never backed up.
- **Filesystem quirks.** One path module (§17.1) owns normalization, reserved names, case collisions and containment; nothing else touches `fs` with a user-supplied path.
- **History in the database, not in git.** Rows are queryable by actor and path, compress well, and are small for a notes workload because only changed notes get rows (FR8).

### 10.3 Layout on disk

```
<PORTAL_DATA_DIR>/knowledge/            mode 0700
  vaults/<id>/...                       the vault: notes, attachments, folders (files 0600, folders 0700)
  index/<id>.db  (+ -wal, -shm)         the rebuildable index; schema version in user_version
  trash/<id>-<utc stamp>/               a deleted vault, kept 14 days
  tmp/                                  import and export staging, emptied at start
```

A vault's folder name is its id, never its display name, so renaming a vault touches no file.

## 11. Data model

Durable tables, in `portal.db` (migrations 50 to 59). None holds a secret, so none is in `ENCRYPTED_COLUMNS`.

| Table | Key fields |
| --- | --- |
| `kg_vaults` | id, name (unique among live), kind (`vault` or `folder`), root (the folder's name under `vaults/`, or the allowed root's key and a subpath), read_only, agents (`off` \| `read` \| `write-own` \| `write`), daily_folder, timezone, settings (JSON: attachments folder, link style, rename rewrites links), created_at, updated_at, deleted_at |
| `kg_versions` | id, vault_id, path, seq (per vault, increasing), op (`create` \| `edit` \| `append` \| `rename` \| `delete` \| `restore` \| `import` \| `sync` \| `external`), actor, actor_kind (`user` \| `agent` \| `system` \| `external`), base_hash, hash, size, content (deflated UTF-8), from_path, note, at, state (`pending` \| `ok`) |
| `kg_edges` | vault_id, path, source_kind (`session` \| `ticket` \| `token` \| `user`), source_id, kind (`read` \| `created` \| `edited` \| `appended` \| `deleted`), count, first_at, last_at. Primary key over all but the counters |
| `kg_audit` | id, at, vault_id, actor, op, path, outcome (`ok` \| `conflict` \| `denied` \| `refused` \| `error`), detail (never note text), bytes. Kept 90 days, capped |
| `kg_sync` (K3) | vault_id, remote (URL, no credentials), branch, credential_ref (a Secrets & env name), interval, last_sync_at, last_commit, state, last_error, base manifest (path to hash) |

Rename rewrites `path` on that note's `kg_versions` and `kg_edges` rows (a rename row records `from_path`), so history and context edges follow the note. A note identified by path that is deleted and later created again continues the same history, with the delete marker between.

**The index** (per vault, rebuildable; schema version in `user_version`, a mismatch deletes and rebuilds):

| Table | Holds |
| --- | --- |
| `files` | id, path, lowercased path, kind (`note` \| `attachment`), name, folder, size, mtime, content hash, title, frontmatter properties (JSON, at most 4 KB, depth 3), on-disk name when it isn't NFC |
| `links` | source file, kind (`link` \| `embed` \| `md`), target as written, heading, block, alias, line, resolved destination or null, ambiguous flag |
| `tags`, `aliases`, `headings`, `blocks` | per file |
| `fts` | FTS5, contentless with delete: title, path, tags, aliases, body. Snippets are cut from the file for the few results returned |

## 12. Graph model

One node and edge model; the three graphs are lenses on it.

**Nodes** have an id (`<kind>:<key>`), a kind, a label and the facts the card shows.

| Kind | Id key | From |
| --- | --- | --- |
| `note` | `<vault>:<path>` | the index |
| `tag` | `<vault>:<tag>` | the index |
| `attachment` | `<vault>:<path>` | the index |
| `unresolved` | `<vault>:<target>` | links that resolve to nothing |
| `vault` | `<vault>` | `kg_vaults` |
| `session` | session id | `chat_sessions` |
| `ticket` | ticket id | the tickets table, when it exists |
| `workspace` | `<target>/<name>` | the workspace registry and `chat_sessions` |
| `claude` | Claude id | `workspace_claudes` |
| `persona`, `skillset`, `mcpset` | pool id | `pools` and `assignments` |
| `mcp` | catalog entry id | `mcp_catalog` |
| `worktree` | path | session rows, when they carry one |
| `actor` | token id or `ui` | `kg_edges` |

**Edges** have a kind, a weight (how many) and a time range.

| Lens | Edge kinds |
| --- | --- |
| Docs | `links-to`, `embeds`, `tagged` |
| Context | `read`, `created`, `edited`, `appended`, `deleted` (from sessions, tickets, tokens and the UI to notes) |
| Agentic | `runs-in` (session to workspace), `runs-as` (session to Claude), `spawned-by` and `transferred-from` (session to session), `assigned-to` (ticket to session or person), `depends-on` (ticket to ticket), `uses` (workspace to persona, skillset or MCP set), `provides` (MCP set to server), `worktree-of`, `mentions` (note to entity, or ticket to note) |

**Mentions.** A note links to a portal entity with a wikilink of the form `[[ticket:T-12]]`, `[[session:<id>]]` or `[[workspace:docker/dev]]`. In Obsidian these show as unresolved links (a colon can't be in a file name), which is harmless; in the portal they resolve to the entity and draw a `mentions` edge.

**Lenses.**

| Lens | Starts from | Shows |
| --- | --- | --- |
| Docs | A vault, or one note ("local graph", depth 1 to 3) | Notes, with tags, unresolved links and attachments switchable. Filters: folder, tag, orphans only, unresolved only |
| Context | A session, a ticket, a note or a time window | The sessions and tickets that touched notes, and the notes. Filters: kind of access, actor, time, vault. From a note: who used it; from a session: what it read and produced |
| Agentic | The whole portal, or one entity | The portal's entities and relations. Filters: entity kinds, workspace |

**Adapters.** The agentic and context lenses read other areas' tables through small read-only adapters in `apps/server/src/knowledge/adapters/`. Each adapter checks that its table and columns exist and returns nothing when they don't, so a missing tickets table or a renamed column degrades one edge kind, never the page. Adapters never write.

**Caps and clustering.** A response carries at most 1,500 nodes and 6,000 edges (configurable up to 5,000 and 20,000). Over the cap, the server keeps the most connected nodes, folds the rest of each folder into one cluster node with a count, and says so ("Showing 1,500 of 10,214 notes: the most linked; 8,714 in 41 folders. Filter by folder or tag to see them"). A local graph around one note is never clustered.

**Layout and drawing.** A small force layout written for this page (Barnes-Hut approximation, link springs, gravity, deterministic seed) runs in the browser on a canvas; it settles in a fraction of a second for hundreds of nodes and stops when it settles. No graph library is added (reason: §20). Hit-testing uses a quadtree.

**On a phone.** One finger pans, two fingers pinch to zoom, a tap on a node opens it (a tap is under 10 px of movement and 300 ms), a long press shows its card. The view's position and zoom are kept while the person is away and returns. Controls (lens, filters, local mode, list) sit in a bottom sheet that doesn't cover the canvas. **List view:** the same nodes as a list sorted by connections, each with what it links to and is linked from, fully keyboard and screen-reader operable; the canvas itself is an image with a text summary.

**As built (K2).** The three lenses, the filters and the caps are in `apps/server/src/knowledge/graph.ts`; the read-only views of other areas' tables are in `directory.ts` (one file, not an `adapters/` folder). What differs from the plan above:

- *Nodes:* no `vault` or `mcp` nodes. A `context` node kind (instruction contexts) was added next to `persona`, `skillset` and `mcpset`. Secrets pools are never drawn.
- *Edges:* docs `links-to`, `embeds`, `tagged`. Context `read`, `created`, `edited`, `appended`, `deleted` (one edge per pair: the strongest kind, the counts added) plus `works-in` from a session to the ticket it serves. Agentic `runs-in`, `runs-as`, `spawned-by`, `assigned-to`, `works-in` (session or ticket to a worktree), `belongs-to`, `uses` and `mentions`. Not built: `transferred-from`, `depends-on`, `provides`, `worktree-of`.
- *Sessions* are one node per portal session (a chat that moved to another Claude keeps its node: the old ids are aliases that find it). A Claude is drawn only when a session runs as it or a note mentions it.
- *Filters:* docs: folder, tag, and toggles for tags, files, missing notes and "hide unlinked". Context: time (24 h, 7 d, 30 d), reads or changes, all vaults. Agents: kinds, time (7 d, 30 d, 90 d), all vaults. Not built: filtering by actor, "orphans only" (the Health list has it).
- *Caps:* 1,500 nodes and 6,000 edges by default, 800 nodes on a phone, at most 5,000 and 20,000. Over the cap the most linked nodes stay and the rest fold into at most one cluster node per folder (kind, outside notes), never more than a tenth of the cap, with the one-line message "752 of 1,504, most linked. Rest grouped."; tapping a folder's cluster zooms into the folder. Over the edge cap the strongest links stay, after one link per node.
- *A local graph* around a note is read from the index around it (1 to 3 steps), not from the whole vault, so it costs milliseconds at 10,000 notes; a level that would pass the cap keeps its most linked notes.
- *Layout:* a force layout in `packages/contracts/src/knowledgeLayout.ts`; springs are weighted by the smaller degree of their ends and no node moves more than 40 units in a tick, because the first version flew apart on graphs of hubs linked to hubs (a regression test keeps that fixed). The canvas draws only while something moves.
- *Who may see which lens:* an admin's token sees all three; a session's agent token gets the docs graph only (what other sessions did is for the admin).

## 13. API

Under `/api/knowledge`, all behind the session guard like every other route. A note's path is always a query parameter, never part of the URL path, so slashes, dots and encoded characters mean exactly what they say.

| Method and path | Purpose |
| --- | --- |
| `GET /vaults`, `POST /vaults` | List with counts; create an empty vault |
| `GET`, `PATCH`, `DELETE /vaults/:id` | Read; rename, policy, daily folder, time zone; delete (type the name) |
| `POST /vaults/import` | Zip upload into a new vault, or into an existing one with a conflict policy; returns what was imported and skipped |
| `GET /vaults/:id/export` | The vault as a zip, streamed |
| `GET /vaults/:id/tree?folder=` | One folder level: folders, notes, attachments, with counts |
| `GET /vaults/:id/note?path=` | A note: text, version, frontmatter, outline, tags, resolved links, backlink count, last actor |
| `PUT /vaults/:id/note?path=` | Create or replace: `{content, baseVersion}`; 409 on mismatch with the current version and text |
| `POST /vaults/:id/note/append`, `…/rename`, `…/restore` | Append; rename or move (optionally rewriting links); restore a version |
| `DELETE /vaults/:id/note?path=` | Delete (to history) |
| `GET /vaults/:id/note/history?path=`, `…/version?path=&id=` | Versions with actor, time and size; one version, optionally as a diff |
| `GET /vaults/:id/note/backlinks?path=`, `…/mentions?path=` | Backlinks; unlinked mentions |
| `GET`, `PUT /vaults/:id/file?path=` | An attachment: served by the allow-list (§17.2); uploaded with a size cap |
| `GET /vaults/:id/search?q=&tag=&folder=&limit=&offset=` | Full-text search |
| `GET /vaults/:id/quick?q=` | Title, alias and path matches for the quick switcher and link completion |
| `GET /vaults/:id/tags`, `…/health`, `…/recent` | Tag counts; link health; recently changed notes |
| `GET`, `POST /vaults/:id/daily?date=` | Today's note's path and text (not created); append |
| `POST /vaults/:id/rescan` | Rescan now |
| `GET /graph?lens=&vault=&around=&depth=&kinds=&folder=&tag=&since=&cap=` | Nodes and edges for a lens (§12) |
| `GET /sources` | The operator-allowed folders a folder source can use (K3) |

Errors use the portal's `AppError` codes: `VALIDATION_FAILED` for a refused path or size, `NOT_FOUND`, `CONFLICT` for a version mismatch (with `{currentVersion, content}`), `FORBIDDEN` for a read-only source or a policy refusal, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`.

## 14. MCP tools

Registered through the Portal MCP registry ([Portal MCP](portal-mcp.md) interface I2: `registerPortalTool`), in `apps/server/src/knowledge/portalTools.ts`. Names follow its `<noun>_<verb>` rule. Hints: **R** readOnly, **D** destructive, **I** idempotent, **O** openWorld; every tool sets all four. A `vault` argument is an id or an exact name; when there is only one vault it may be omitted.

| Tool | Scope | Hints | Inputs | Output |
| --- | --- | --- | --- | --- |
| `vault_list` | read | R I | none | Vaults the token may see: id, name, notes, agent policy, last change |
| `note_search` | read | R I | `vault`, `query`, `tag`, `folder`, `limit` (up to 50), `cursor` | Path, title, tags, snippet (untrusted), last change, rank |
| `note_read` | read | R I | `vault`, `path`, `section` (a heading), `offset`, `max_chars` | Text as `untrusted_text`, `version`, frontmatter (untrusted), headings, tags, outgoing links, backlink count, author kind, `truncated` |
| `note_backlinks` | read | R I | `vault`, `path` | Notes that link to it, with the line (untrusted) |
| `tag_list` | read | R I | `vault`, `prefix` | Tags with counts |
| `graph_neighbours` | read | R I | `node` (id from §12), `depth` (1 to 3), `kinds[]`, `limit` | Nodes and edges around it |
| `graph_query` | read | R I | `lens`, `vault`, `from`, `kinds[]`, `tag`, `folder`, `since`, `limit` | Nodes and edges for a lens, capped |
| `note_write` | operate | I | `vault`, `path`, `content`, `base_version` (required unless creating), `create` | New `version`, or `CONFLICT` with the current version |
| `note_edit` | operate | I | `vault`, `path`, `old_text`, `new_text`, `base_version` | Replaces one exact, unique occurrence; `CONFLICT` or `NOT_UNIQUE` otherwise. A small change doesn't rewrite the file the agent last saw |
| `note_append` | operate | – | `vault`, `path`, `text`, `heading` (append under it) | New `version`. No base needed |
| `daily_append` | operate | – | `vault`, `text`, `date` | Path, version. Adds a bullet with the time, creating the note on first use |
| `attachment_list` (K4) | read | R I | `vault`, `folder`, `limit`, `cursor` | Attachments with path, type, size, hash, last change |
| `attachment_get` (K4) | read | R I | `vault`, `path` | An image as an MCP image content block; a text file as `untrusted_text`; others a description and an authenticated download link |
| `attachment_put` (K4) | operate | I | `vault`, `path` or `folder` + `name`, `media_type`, `content_base64` or `from_workspace_path`, `base_version` (a content hash, to replace one) | Path, hash, size, the embed line to paste into a note (`![[name]]`), or the refusal (type, size, cap, policy) |

**Not over MCP:** deleting or renaming notes, changing vaults or their policy, restoring versions, import, export and sync. A person does these in the portal. (v1 also left out uploading attachments; K4 adds `attachment_put`, `attachment_get` and `attachment_list`, FR36 to FR38, and a person still deletes and renames them.)

**As built (K2).** All eleven tools are registered with `scope: 'agent'` (`apps/server/src/knowledge/portalTools.ts`, one registration line in `index.ts`): an admin's token needs `read` for the reading tools and `operate` for the writing ones (a read token that calls `note_write` gets `SCOPE_REQUIRED`); a session's agent token reaches all of them, within the vault's own agent policy. Differences from the table: `note_search` and the other lists use the Portal MCP's cursor paging; `note_read` takes `section`, `offset` and `max_chars` and returns at most 8,000 characters a time (the Portal MCP's cap on a labelled text field) with `next_offset`; `graph_neighbours` takes a note `path`, `depth` (1 to 3), `tags` and `limit`; `graph_query` takes `lens`, `vault`, `from` (a node id), `tag`, `folder`, `kinds`, `since`, `access` and `limit`, and answers as numbered nodes and links between them. Notes and paths travel as identifiers; titles, snippets, bodies and the labels of sessions and tickets are labelled `untrusted_text`. Writes are held to 20 a minute by the Portal MCP for an agent's token and 300 an hour per token by the tool. A write that loses a race returns `CONFLICT` with the current version and the current text (labelled), so the caller merges instead of guessing.

### 14.1 What every tool checks

Order: token scope, then the vault's agent policy (FR24), then the path rules (FR5), then size caps (256 KB per write), then FR27's secret scan, then the version check (FR7). Refusals are tool errors with a code (`SCOPE_REQUIRED`, `VAULT_UNAVAILABLE`, `NOT_ALLOWED_BY_POLICY`, `INVALID_PATH`, `TOO_LARGE`, `SECRET_IN_CONTENT`, `CONFLICT`, `NOT_FOUND`, `NOT_UNIQUE`) and a one-line next step, and each is audited.

### 14.2 Notes are untrusted text

An agent can write a note that a later model, perhaps the admin's Claude holding admin tools, reads. Every text field returned (note bodies, frontmatter values, snippets, backlink lines, titles) goes out as `{"untrusted_text": "…", "source": "note:<vault>/<path>"}` with the author's kind (`user`, `agent`, `external`), through the Portal MCP sanitizer (ANSI and control characters, bidi and zero-width characters, Unicode tag characters, secret patterns), capped, and never appears in tool descriptions or server instructions. The `write-own` default keeps agent writes away from a person's notes; the UI marks agent-written notes so a person can tell them apart.

### 14.3 Edges and session identity

The tool handler records an edge for each note it reads or writes (FR29). Who the edge belongs to is what the registry verified: the token's id and `ctx.actor` always; for an agent's per-session token, `ctx.sessionId` and `ctx.workspaceId`, which come from the token and **never from a tool argument or a header**. An admin token has no session, so its edges attach to the token. Edges follow the portal's own notion of a session: one node per portal session (a Claude switch keeps it), not the legacy predecessor and successor columns. Transcript-based edges for native file reads of a delivered snapshot (§15.3) are derived from the portal's own stored tool calls.

## 15. Integrations

### 15.1 Zip import and export (K1)

- **Import** reads a zip held in memory under caps (100 MB zip, 500 MB unpacked, 60,000 files (a classic zip holds at most 65,535 entries), 100:1 ratio, 25 MB per attachment; configurable), refuses unsafe paths, absolute paths, backslashes, control characters, symlinks, encrypted and zip64 archives and zip bombs, strips a single wrapper folder (one that holds `.obsidian`, or is named like the zip), skips dot-entries and disallowed file types, and reports every skip with its reason. Into an existing vault it takes a conflict policy: `skip`, `keep both` (the newer file gets a numbered name) or `overwrite` (journaled, so recoverable). Imported notes are journaled lazily (FR8).
- **Export** streams a standard zip (deflate, UTF-8 names, data descriptors), one top-level folder named for the vault, with the vault's files and nothing else.
- Notion and Outline exports are zips of Markdown with relative links; they import through the same path (Notion's name suffixes are kept; a "tidy names" option is a later question).

### 15.2 Git sync (K3)

Two-way sync with a remote that Obsidian (with obsidian-git) or any git client also uses. The portal never puts a `.git` folder inside a vault; it keeps a working clone under `knowledge/sync/<id>`.

1. **Pull.** Fetch, then merge per file between three trees: the base (the last synced tree, kept as a manifest of path to hash plus the journal's text), theirs (the remote tip) and ours (the vault). A file changed on one side only is taken from that side. Changed on both sides: a line merge of the two against the base (`git merge-file`); when that conflicts, the vault keeps its own text, and the remote's version is written beside it as `Note (conflict <date> <remote>).md`, journaled `sync`, flagged in the UI. Deleted on one side and edited on the other: the edit wins and a note says so. Nothing is ever dropped silently.
2. **Push.** Commit the vault's changes since the base as one commit ("pilot: N notes changed (actors)"), fast-forward push, and on a rejected push pull and retry once.
3. **Ignored:** dot-entries both ways. `.obsidian` in the remote is left exactly as it is.
4. **Credentials** are a Secrets & env secret name (HTTPS token, or an SSH deploy key), resolved when the job runs and handed to git through a temporary askpass or key file that is removed afterwards. They are never stored in a `kg_*` table, in the clone's config, in a command line or in a log.
5. **When:** on demand, and optionally on an interval. Needs the `git` binary; without it the page says so and nothing else is affected.

### 15.3 Snapshot into workspaces (K3)

An optional convenience: the way to reach notes is the tools in §14, and a snapshot only lets an agent `grep` them with its own file tools. A new pool kind (`vault`) registered through the pool framework ([Pools foundation](foundation-pools.md); the framework's type union is A3a's to extend, request in §22). A workspace assigned a vault gets a **read-only** copy under `/etc/claudepilot/knowledge/<vault name>/` (root-owned, mode 0644, so the agent can read and search it and can't edit it), plus a generated `_index.md` (titles, paths, tags) and `_links.tsv` (source, target, kind) so an agent can search the graph with `grep`. A short instruction file points the agent at it and at the notes tools. **Notes an agent wrote are not in a snapshot until a person promotes them** (editing one counts, and so does "Promote" in the note's menu), so what one agent wrote can't become the instructions of another unseen. Notes only by default, size-capped; Docker first, because Kubernetes' workspace Secret holds 1 MiB. A snapshot is rebuilt when the vault changes (rollout-paced like other pool changes). Writes never go through the snapshot.

### 15.4 Folder sources (K1 engine, K3 UI)

The operator names the folders a source may use in `PORTAL_KNOWLEDGE_ROOTS` (`name=/absolute/path`, comma separated); in development the repository's `docs/` is added as `docs` when it exists. An admin adds a source by choosing one of those names and an optional subfolder; the server resolves it to a real path, checks it stays inside the root and refuses symlinks that leave it. A source is read-only unless the root was allowed with `:rw`. It uses the same engine as a vault, so the PRDs show up as a graph with backlinks and search.

### 15.5 External doc systems (last)

Notion and Outline exports import as zips (§15.1). A live adapter (Outline's API, Notion's API) is not planned for v1; Q8.

## 16. User experience

Existing components only (Page header, Segmented, Select, TextField, TextArea, Button, Menu, Dialog, FormDialog, ConfirmDialog, Badge, EmptyState, LoadError, RowsSkeleton, Card, Section). One new sidebar and tab-bar item, **Knowledge**. Phone first, then desktop.

| Place | Phone (390 px) | Desktop (1280 px) |
| --- | --- | --- |
| **Knowledge** (in the app frame) | A card per vault: name, notes, last change, agent policy, "N written by agents this week". "New vault", "Import". Under them: the graph lenses as a shortcut, and recent notes across vaults | The same cards in a grid |
| **A vault** (full screen, like the chat) | A header (back, vault, search, menu). Tabs: **Notes** (folders as a drill-down list, recent first), **Search**, **Graph**, **Tags**, **Daily**. A note opens full screen | Three panes: files and search on the left (a tree), the note in the middle (reader and editor), a right panel with backlinks, outline, properties and a local graph. The graph is a tab in the middle pane |
| **A note** | Title, an Agent badge when an agent wrote it, Edit and Preview as a toggle, ⋯ menu (history, backlinks, properties, rename, move, delete, open in Obsidian). Backlinks, outline and properties open as a bottom sheet | Reader and editor side by side when wide enough |
| **Editor** | A plain textarea with a touch toolbar (heading, bold, italic, link, `[[`, tag, checkbox, indent). Typing `[[` opens suggestions from the vault. It saves a moment after the last keystroke and says Saving, Saved or Conflict | Same, with the usual shortcuts |
| **Conflict** | A banner: "Updated by <actor> at 14:02." Choices: Reload theirs, Keep mine as a copy, Show differences | Same |
| **History** | A sheet: versions with actor, time, size; tap one to see the differences against the one before or the current text; Restore | A dialog |
| **Graph** | Full-bleed canvas, a bottom sheet for lens, filters and the node cap notice; Graph and List as a switch | Canvas with a side panel for filters; the list is a second tab |
| **Import and export** | Import: choose a zip, a summary of what came in and what was skipped, and why. Export: a download | Same |
| **Settings** (vault ⋯) | Name, agent policy (with what each value allows), daily folder, time zone, attachments folder, link style; Delete (type the name) | Same |

**As built (graph).** The graph is the vault page's third view (the Graph tab on a phone) and a page of its own for the whole portal (Knowledge, ⋯, Graph). A switch picks Docs, Context or Agents; icons switch to the list and open the filters (a bottom sheet on a phone); an ⓘ explains the lens and lists its colours. One finger pans, two pinch, the wheel zooms, a tap opens the node (a note opens in the vault, a session or ticket opens its page, a folder's group zooms in), a hold picks it and shows a card with Around (a local graph, 1 to 3 steps) and Open; a mouse hovers to light up a node's neighbours and can drag nodes. The note's side panel has a Graph tab with the local graph. The words on screen are the lens names, the filters and one line when the graph was cut; everything else is in the ⓘ.

Copy is plain and concrete: "Imported 1,204 notes and 87 attachments. Skipped 41 files: 38 in .obsidian, 3 not allowed (.html)." Light and dark themes follow the app. The agent's authorship is always visible, never implied.

## 17. Security requirements

### 17.1 Paths and the filesystem

- One module resolves every path: NFC-normalize, split, reject empty, `.` and `..` segments, absolute paths, backslashes, control characters, reserved names, over-long names; then resolve against the vault root and check containment on the **real path** (the resolved parent must be inside the vault's real path). Symlinks inside a vault are never followed for reads, writes or listing; they are skipped and reported. Case and normalization collisions are refused.
- Temporary files are created exclusively (`wx`) in the target's directory with a random dot-name and removed on failure and at start.
- Folder sources resolve inside an allowed root the same way, and a root is never writable unless the operator said so.

### 17.2 Attachments and rendering

- **Allow-list by extension**, with the content type the server sends; the content type is never taken from the upload. Inline: `png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `bmp`, `pdf`, `mp3`, `m4a`, `wav`, `ogg`, `flac`, `mp4`, `webm`, `mov`. Download only: `svg` (it can carry script, so opening it directly never runs it; an image tag still draws it), `csv`, `txt`, `json`, `canvas`, `base`, `heic`, `zip`, `docx`, `xlsx`, `pptx`. Everything else (including `html`, `htm`, `xhtml`, `js`, `mjs`, `sh`, `exe`, `bat`, `jar`) is skipped or refused.
- Every file response sends `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`; types that aren't inline (SVG included) carry `Content-Disposition: attachment`. In the built app the portal's own CSP header (`csp.ts`, set by `secureHeaders` after the handler) replaces the per-response one, so the download disposition and `nosniff` are what hold; the page CSP allows no inline script either.
- **The preview never renders raw HTML** (it shows as text), never loads a remote image (shown as a link, like the chat), drops `javascript:` and other unsafe URL schemes, opens external links in a new tab with `noopener noreferrer nofollow`, and builds embeds and wikilinks from the parsed structure, not from strings. Titles, frontmatter values and tags are rendered as text by React, never as HTML.
- Notes can be opened in the preview at any time because nothing in a note is executed.

### 17.3 Caps

| What | Default |
| --- | --- |
| A note | 1 MiB (an agent write: 256 KiB) |
| An attachment | 25 MiB |
| Files in a vault | 60,000 |
| A vault's size | 2 GiB |
| Frontmatter | 32 KiB; properties kept in the index: 4 KiB, depth 3 |
| Links per note kept in the index | 5,000 |
| Import zip | 100 MB packed, 500 MB unpacked, 100:1 ratio, 60,000 files |
| Search query | 256 characters; 50 results per MCP call, 100 per API call |
| Graph response | 1,500 nodes, 6,000 edges (up to 5,000 and 20,000 when asked) |
| MCP text field | 8,000 characters |

Env keys (`PORTAL_KNOWLEDGE_*`) can lower or raise the size caps, never the path rules.

### 17.4 Secrets, logs and audit

- Agent writes are scanned (FR27). Imports are scanned and flagged, not blocked; a flagged note shows a warning chip.
- **No note body is ever logged**, put in an error message, in an audit row or in a metric label. Audit rows hold the path, operation, actor, outcome and byte counts.
- Every write, refusal and conflict is in `kg_versions` or `kg_audit` with its actor. Tool calls are also in the Portal MCP's audit.
- The Origin and session rules of the portal apply to every route. Uploads are streamed under a cap, not buffered unbounded.

### 17.5 Graph adapters

Read-only SQL, parameterized, limited rows, never selecting a secret column. A table or column that doesn't exist is skipped. Entity labels come from the owning area's names, rendered as text.

## 18. Observability and audit

- A log line per scan (`[knowledge] <vault> scanned 10,214 files in 412 ms, 3 changed`), per import, export and sync, never a body.
- **Knowledge → Activity** (a vault's ⋯): recent changes with actor and operation, refusals, conflicts, imports, exports, policy changes.
- Metrics for [Monitoring](monitoring-dashboard.md): reads and writes by actor kind, conflicts, refusals by code, scan duration and files, index size, search p95, notes written by agents per day.
- A security event when an agent write is refused for a secret pattern, and when a note's content is flagged by an import.

## 19. Testing and verification

| Case | Expected |
| --- | --- |
| Path fuzz: `..`, absolute, backslash, NUL, long names, reserved names, mixed case, NFC against NFD, symlink inside the vault, symlinked parent | Refused or skipped with a reason; nothing outside the vault is read or written |
| Atomic write under a killed process | The old file or the new one; no temporary file remains after start; the journal agrees after a scan |
| Version check matrix: UI against MCP, MCP against MCP, outside edit against MCP | Exactly one winner; the loser gets `CONFLICT` with the current text; no lost text |
| Obsidian fixtures: aliases, headings, block ids, embeds, spaces in names, nested folders, duplicate names, unresolved links, tags in code, frontmatter edge cases (empty, invalid, CRLF, BOM, tags as string, as list, nested), callouts, comments | Parsed and resolved as §9 says; the preview matches; export then import is byte-identical |
| Generated 10,000-note vault with realistic links | Cold index, unchanged rescan, search p95, graph response size and time recorded in §21 |
| Zip import: slip, symlink, bomb, overlapping entries, encrypted, zip64, `.obsidian`, `__MACOSX`, disallowed types, huge counts | Refused or skipped as §15.1 says, each with its reason |
| Zip export | Opens with `unzip -t`, round-trips through import with identical files |
| Rename with link rewrite, wikilinks and Markdown links, headings, aliases, embeds | Links follow; history and edges follow |
| Policies: each of `off`, `read`, `write-own`, `write` against each tool and each kind of note | As FR24 says, audited |
| Secrets: canary keys in agent writes, in imports, in the UI | Refused, flagged, warned; absent from logs, audit, errors and index metadata |
| Prompt injection planted in a note | Returned as labeled, sanitized text; never in a description |
| MCP end to end: real Claude Code 2.1.296 against the scripted stand-in Anthropic API calls the tools through the Portal MCP endpoint; the edges appear in the context graph | Passes once A3b's registry exists; before then, tool-level tests |
| UI at 390 and 1280 px, light and dark | Each screen looked at, including the graph with touch gestures, the list view and a conflict |
| Index rebuild | Delete the index file; the next start scans and every query answers the same |

## 20. Dependencies

No new dependency is planned. The Markdown reading is written for this feature (a scanner, not a parser, kept to the structure the index needs); YAML frontmatter uses `js-yaml`, already a server dependency; the zip reader is the one the Skillset importer already has (`skills/archive.ts`, read-only reuse) and the zip writer is small and local; the web app reuses `react-markdown` and `remark-gfm`. A graph library such as d3-force would work but would add a dependency, an ESM and types concern and a bundle cost for about 200 lines of layout, and the touch behavior is easier to own in a small canvas module. Any dependency added later goes through the repository's `flock` rule.

## 21. Milestones and success

| Milestone | Scope | Status |
| --- | --- | --- |
| K0 | This PRD | **Built.** |
| K1 | Vault core: paths, storage, scanner and index, versions and history, REST API, zip import and export, the UI (vault list, file tree, note view and editor, search, tags, backlinks, daily notes, history and restore), folder sources (engine), daily vault zip, tests | **Built.** Server tests green; the UI checked in headless Chromium at 390 and 1280 px, light and dark; numbers below. **Not verified:** a vault exported from here opened in the Obsidian app (Q1) |
| K2 | The graph (docs, context, agentic) and its UI with touch and a list view; the adapters; the MCP tools through the registry; edge recording | **Built.** Graphs, caps, local graph and adapters tested; the canvas checked at 390 and 1280 px (tap, hold, pan, pinch, list, filters, light and dark); the tools checked through the real `/mcp` endpoint with an admin token and, in tests, with per-session agent tokens through a real MCP client. **Not verified:** a real Claude Code process calling the tools, and the frame rate on a real phone |
| K3a | Git sync | **Not built** (out of scope for now) |
| K3b | Snapshot into workspaces (optional; agent notes left out until promoted) | **Not built** |
| K3c | Folder sources UI and the repository's docs | **Partly built:** the engine and a read-only source (the repository's `docs/` in development) work; the UI to add one is in the New vault dialog; no sync |
| K3d | External doc systems | **Not built** |

| Metric | Target | Measured |
| --- | --- | --- |
| Search over 10,000 notes, p95 | Under 50 ms | 9 to 26 ms in the index; 39 ms with snippets for 20 results (generated vault, 10,000 notes, 45,000 links) |
| Cold index build, 10,000 notes | Under 20 s | 3.6 s (24 MB index) |
| Rescan with nothing changed, 10,000 notes | Under 500 ms | 81 ms; reopening with the index kept: 47 ms |
| Graph of 1,500 nodes | Smooth (30 frames per second or better while it settles and when panned) | Layout 0.6 ms a tick at 760 nodes and about 2 ms at 1,500 nodes with 6,000 edges (Node). Server: 130 ms for the whole 10,000-note vault (then cached until it changes), 2 to 50 ms for a local graph, 115 ms for the context graph, 12 ms for the agentic one; 100 KB over the wire with gzip. Frame rate not measured in a real browser |
| Silent overwrites in the version-check matrix | Zero | Zero in the tests (stale, missing and concurrent versions, edits from outside during a write) |
| Note text in logs, audit rows or metric labels | Zero (canary tests) | Zero in the tests (a canary key and phrases in note text never appear in audit rows or log lines) |
| Files written outside a vault's folder | Zero (path fuzz) | Zero in the path tests; the QA API fuzz over every mutating route: 112 routes, 3,326 requests, 0 findings |
| Export then import | Identical files | Identical in the tests; `unzip -t` and Python's `zipfile` accept the export |

## 22. Requests to other PRDs and areas

| ID | To | Request |
| --- | --- | --- |
| A1 | [Portal MCP](portal-mcp.md) (A3b) | Add a knowledge group to §13 (the tools in §14 here) and "notes" to §14.4's untrusted sources. Let a PAT or connection carry an optional list of vaults it may touch. Tools opt in to the agent scope (I8) and read the verified `ctx.actor`, `ctx.sessionId` and `ctx.workspaceId` |
| A2 | [Chat sessions](chat-sessions.md) and [Workspace Claudes](workspace-claudes.md) (A2) | Say in the status file if `chat_sessions`, `chat_events` or `workspace_claudes` columns I read change (the Claude-switch rework: one session node, segments). Session identity needs nothing else from A2: the per-session token carries it (I8) |
| A3 | [Pools foundation](foundation-pools.md) (A3a) | Allow a `vault` pool type (the type union in `pools/kinds.ts` and the contracts) and a delivery path for a read-only directory tree; a way to resolve a Secrets & env secret by name for a server-side job (git sync) |
| A4 | Tickets (A3b) | A ticket's text may link notes with `[[...]]`; expose its table's column names to the adapter |
| A5 | [Web app & PWA](web-app-pwa.md) | One nav item, Knowledge; its full-screen vault route follows the chat's pattern |
| A6 | Backups | The portal's backup documentation lists the knowledge folder and the daily vault zip |

## 23. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | Unverified: does a vault exported from here open in the Obsidian app with links, tags, aliases and attachments as shown here? The first real check is a person opening an exported zip. | Live test, owner |
| Q2 | Default agent policy for a new vault: `write-own`, decided provisionally by the coordinator. | Owner to confirm |
| Q3 | Decided by the coordinator: workspace agents get the notes tools through their per-session token (I8, scope `agent`); the file inbox is cut; the snapshot stays an optional convenience. | Decided |
| Q4 | Should an agent be able to delete or rename notes over MCP in a later version, with the Portal MCP's confirmation step? | Owner |
| Q5 | Daily note formats other than `YYYY-MM-DD`: needed? | Owner |
| Q6 | Retention: 200 versions per note and 256 MB per vault, deleted notes recoverable for 30 days, deleted vaults for 14. Right? | Owner |
| Q7 | Embeddings and semantic search (a local model, or Anthropic's API through an account pool): wanted after v1? | Owner |
| Q8 | Live adapters for Outline and Notion, beyond zip import? | Owner |
| Q9 | Unverified: Obsidian's rule for duplicate note names in `[[Note]]`. Ours is deterministic and documented (FR11), and may differ. | Live test |
| Q10 | Decided provisionally: agent-written notes are not in snapshots delivered to other workspaces until a person promotes them. | Coordinator |
