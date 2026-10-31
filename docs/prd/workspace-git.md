# PRD: Workspace git

| | |
| --- | --- |
| Status | **Draft v0.1.** Server side **built** and tried (§17): discovery, tree, state, tracking over time with an audit, worktrees, fast-forward sync, summary and Portal MCP tools. The web UI (the Repos tab, the repo sheet and the chip on the workspace list) is **built** by the web area from this contract (§16) and tried in a real browser (§17). **Observed** = seen in a run on this machine: git 2.56 (this dev container) and 2.39.5 (the workspace image), the generated session host script, a real portal and a real Docker workspace, and, read-only, the owner's real pool of repositories (counts only); no real remote and no sign-in. **Unverified** = listed in §20. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [Chat sessions](chat-sessions.md) (the hardened session host, worktrees FR50, the redactor, portal actors FR14), [Pools foundation](foundation-pools.md) (the runtime's exec; the host is installed like the chat's), [Portal MCP](portal-mcp.md) (tool registry, untrusted text, agent scope) |
| Related | [Local git and CI/CD](local-git-ci.md) (a repository's `pilot` remote is linked), [Workspace Claudes](workspace-claudes.md), [Tickets](tickets.md) (an actor in the audit), [Monitoring dashboard](monitoring-dashboard.md) (attention counts) |

## 1. Summary

Inside a workspace the agent's work lives in git repositories: one, or a pool of them (a parent with many clones or submodules), plus the worktrees chats and people make. The portal finds them by looking, without registration, and tracks each on its own: where it is, what it is to the others (submodule of a superproject, worktree of a repository, a clone nested in a parent that doesn't declare it, a submodule declared but never cloned), its branch, HEAD, upstream, uncommitted changes, stashes, remotes and drift from what a superproject records. The result is a tree for each workspace, kept over time: what changed since the last look is an event (commits arrived, branch switched, became dirty or clean, diverged, a worktree appeared or went, a submodule drifted), attributed to the chat that was in the repository when it can be, and kept ninety days as the audit.

The portal can also act on request: make a worktree of any tracked repository, keep a worktree synced with its upstream (a fetch and a fast-forward when that is all it takes and nothing is lost), and read the whole picture as a per-workspace and global summary with an "attention" order. Every such action is an event with who asked: a person, a chat, a ticket or a token. People see it in the Repos tab; agents and claude.ai see it through Portal MCP tools.

Everything runs through the chat's hardened session host in the workspace (`chat/host.ts`): no hook, filter or fsmonitor of a repository ever runs, a scan never fetches, nothing it prints is trusted, and a Kubernetes workspace is never touched.

## 2. The request, and how this PRD reads it

The owner (2026-10-12, translated): *"git in a workspace can be scanned automatically: say the agent inside turns out to be a pool of repos like konfersi-universe; since there are submodules that all have git trees, each can be tracked on its own, and working trees can be created directly and kept synced, so we can audit and monitor."*

| The owner said | This PRD reads it as |
| --- | --- |
| "scanned automatically" | Repositories are found by a bounded walk of the workspace's home folder (or the folders a workspace names), at a workspace's start, on a timer while it runs, around chats and on request (§6, §8). Nothing is registered. |
| "a pool of repos like konfersi-universe" | The shape of the owner's real pool (read-only, §17): a repository that holds 17 clones in folders of its own and declares none of them as submodules, so they are **nested** repositories as often as submodules. Both are first-class (§5). |
| "each can be tracked on its own" | Every repository has an id, a state, a history of events and its own worktrees, whatever its parent is (§5, §7, §8). |
| "working trees can be created directly" | A worktree of any tracked repository, made through the same hardened `wt-add` as a chat's (§9). |
| "and kept synced" | Opt-in per worktree: fetch the upstream branch and fast-forward when the worktree is clean; otherwise show ahead, behind, diverged and dirty and do nothing (§9). |
| "so we can audit and monitor" | An event log with actors and a summary with an attention order, in the UI, over the API and over MCP (§8, §10, §11). |

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Find them without being told.** A pool of repositories in a workspace appears in the portal with no setup, bounded so a huge tree can't hang the scan. |
| G2 | **Each repository on its own.** A stable id, a state and an event log per repository; relations (superproject, main repository, enclosing repository) form a tree. |
| G3 | **Read-only by construction.** A scan changes nothing, runs nothing a repository defines, never fetches and never leaves a credential anywhere. |
| G4 | **An audit.** What changed, when, in which repository, and which chat, person, ticket or token did it, kept 90 days. |
| G5 | **Worktrees on demand, kept fresh on request.** Make one for any tracked repository; keep it synced only when told to, and only by fast-forward. |
| G6 | **Monitoring.** One count and one order of what needs a look, per workspace and overall, in the UI and over MCP. |

## 4. Non-goals

- **Cloning or initialising.** A submodule declared and not cloned is shown, not cloned (§20, Q4). The portal never clones, pulls, merges, rebases, stashes, resets or cleans on its own.
- **Fetching on a timer for everyone.** A scan reads what is already on disk. Only a sync someone asked for, or a worktree that opted in to "keep synced", reaches a network.
- **File-level detail.** Counts of changed files, never their names; the diff of a chat's folder stays in the chat's Files and Diff.
- **Kubernetes workspaces.** Their repositories are not scanned (the portal never execs into pods on a timer); the image carries the host script for the day they are.
- **Judging the code.** No review, no CI result (those are [Local git and CI/CD](local-git-ci.md)), no remote forge.

## 5. Concepts

**Kinds.** `repo`: a repository of its own. `submodule`: git itself says a superproject records it (`git rev-parse --show-superproject-working-tree`). `worktree`: a linked worktree (its git dir is not the common one), the chats' own session worktrees included. `nested`: a repository inside another one's folder that the outer one does not record (a pool of clones under a parent). `missing`: a submodule a `.gitmodules` and the index declare whose folder holds no repository.

**Identity.** `r_` and 12 hex characters of the sha256 of the workspace id and the folder's real path. It is stable while the repository stays where it is and survives a removal and a return (the row is kept 90 days). A repository moved to another folder is a removal and a discovery (§20, Q3). A not-cloned submodule has the id its folder will have once it is cloned, so the id carries over.

**The tree.** A node's parent is its superproject, the repository around it (nested), or the main repository of a worktree; a node whose parent is not among the scanned folders sits at the top (a worktree still names its main repository in `mainId`). The API returns the nodes flat, parents first, siblings by folder with worktrees after the others, each with its `depth`.

## 6. Discovery

- **FR1 The walk.** `repo-find <root> <depth> <max>` (session host) lists `.git` entries under a root with `find`, at most `depth` folders down (default 6) and `max` repositories (default 300), in at most 25 s. It never follows a link, and does not walk into hidden folders, `node_modules`, `vendor`, `__pycache__`, `venv`, `site-packages`, `bower_components` or a folder whose name holds a newline. A limit reached says so (`truncated`), and the scan reports it instead of pretending to be complete.
- **FR2 Roots.** Default `~` (the home folder; `PORTAL_REPOS_ROOTS`). A workspace names its own (at most 8, relative to the home folder or absolute inside it, no `..`); a folder that isn't there is reported and the others are still scanned. The host refuses any path outside the home folder or inside the portal's own files.
- **FR3 Known repositories are read again every scan.** That is how "gone" is told from "a limit stopped the walk": a repository is removed only when its folder was read again and holds no repository. What a repository points at is read too (its superproject, the main repository of a worktree, the worktrees `git worktree list` names, the folders of its recorded submodules), up to the limit plus 100.
- **FR4 Cadence of the walk.** A request, a workspace's start and the first scan after the portal starts walk; the timer walks every third interval (twice as seldom when the last walk hit a limit), because known repositories are read every round and the walk only finds new ones.

## 7. Reading a repository

- **FR5 Read-only and hardened.** `repo-state <path> <prev>…` (at most 20 pairs a call; the portal sends 8) runs git as Diff's `hardened()` does: no hook, `core.fsmonitor`, pager, external diff, textconv or filter (clean, smudge, process) of the repository runs, no prompt, `GIT_OPTIONAL_LOCKS=0` (it never takes the index lock, so it can't get in the way of a person's git), 20 s per git call. It reaches no network. A path outside the files root, a folder that isn't a repository's top (an empty submodule folder inside a repository must not be mistaken for it) and a repository git refuses (ownership) read as `refused`, `notrepo` and `ownership`.
- **FR6 What is read.** Branch or detached or no commit yet; HEAD (commit, date in UTC, author name, subject); upstream, ahead and behind (or gone); counts of staged, unstaged, untracked and conflicted files (never names); stashes; commits on no remote branch (up to 1000; none counted for a repository without a remote); remotes with their URLs; an operation in progress (merge, rebase, cherry-pick, revert, bisect); how many filters it configures; when FETCH_HEAD was last written; worktrees (`git worktree list`, with locked and prunable); what `.gitmodules` declares and what the index records for each submodule.
- **FR7 Counts that mean something.** A superproject's own status ignores its submodules (each is its own repository); an untracked folder that holds repositories the portal tracks on their own (a pool of clones in a parent, a worktree kept in a folder of it) is not a change of the repository around it; a submodule is normally detached, so detached says nothing about a submodule. **Drift** is a cloned submodule checked out at a commit other than the one the index records; the superproject carries the count and the submodule the flag.
- **FR8 Remotes without credentials.** The host strips `user:password@`, the query and the fragment from every URL, and the portal strips them again. A remote that points at `~/.claudepilot/git/<name>.git` is linked to the workspace-local remote of that name ([Local git and CI/CD](local-git-ci.md) FR1).
- **FR9 Filters.** The portal never runs a repository's filters, so files they rewrite (Git LFS smudging, `eol` filters) can read as changed. The state says how many filters the repository configures, and a page can note it.
- **FR10 Failure is a state.** A read that fails keeps what was known of the repository and says why in one fixed code (`timeout`, `unsafe`, `unreadable`, `not_a_repository`). A repository that timed out rests for 2ⁿ intervals (at most an hour) unless somebody asks.

## 8. Tracking over time

- **FR11 When it scans.** On request (the Repos tab, a person, MCP); at a workspace's start and on a timer while it runs, every `PORTAL_REPOS_INTERVAL_S` (default 300) seconds, each time jittered by ±20 %, backed off ×2 up to ×8 after a failure, switchable per workspace and by `PORTAL_REPOS_AUTO=off`, never while it is stopped; and around chats: when a chat begins, ends or finishes a turn, the repository it is in is read again (debounced two seconds, at most one such look per workspace every 30 s). Budgeted: one scan reads for at most 90 s and keeps what it has, two scans run at once portal-wide, one workspace at a time, and a request for what is already being scanned joins that scan.
- **FR12 What is kept.** The current state of each repository (§14) and the last scan of each workspace (time, duration, truncated, error). A scan that changed nothing says nothing to open pages.
- **FR13 Events.** One event per change, none for a quiet scan:

| Kind | When |
| --- | --- |
| `discovered`, `removed` | A repository appears (`initial` for the first scan of a workspace) or is confirmed gone; a submodule cloned or deinitialised is a discovery and a removal. |
| `branch_changed` | The branch, or detached against attached. A branch switch is not also a `head_moved`. |
| `head_moved` | The same branch (or detached) at another commit: how many commits, up to 5 authors and 5 clipped subjects when the new HEAD descends from the old one; a rewritten history or an unknown old commit says so. |
| `dirty`, `clean`, `conflicted` | The repository got changes, lost them all, or got conflicts. More changes while dirty is not news. |
| `diverged` | Ahead and behind at once, newly. |
| `worktree_added`, `worktree_removed` | A worktree appeared or went, on its main repository. |
| `drift`, `aligned` | A submodule's checked-out commit stopped or started matching the record; on the superproject. |
| `scan_failed` | A repository started failing to read, or the whole scan failed (told once while it keeps failing). |

- **FR14 Who.** What the portal did on request carries its actor (§10). What a scan notices is put down to the one chat that was in that repository since the last look (`session:<id>`); with several chats it is the workspace's own (`workspace`, the ids in `data.sessions`); with none it is `workspace` too. This is attribution, not proof: a terminal in the same folder is indistinguishable from the chat.
- **FR15 Retention and text.** Events are kept 90 days and at most 10,000 per workspace; repositories gone for 90 days and the repositories and settings of a removed workspace are deleted. Subjects are clipped to 200 characters, authors to 80, summaries are one line; everything passes the chat's value redactor (the workspace's secret values, credential shapes).

## 9. Worktrees and sync

- **FR16 Make a worktree.** `POST /api/repos/:id/worktrees` (also `worktree_create` over MCP). The repository may be any cloned one, a worktree included. It goes through chat/worktrees.ts and its hardened `wt-add`, so the branch name and the base are validated the same way and no hook, filter or fsmonitor of the repository runs while it checks out. The folder is `<repository>.worktrees/<branch with / as ->` beside the repository. The branch defaults to `wt/<6 hex>`. When the base is a remote-tracking branch the new branch follows it (`repo-track`; `wt-add` is given a commit id, which git doesn't set up tracking for). The worktree is in the tree at once and announced once, as the portal's own doing (`worktree_created`), not again as discovered.
- **FR17 Remove a worktree.** `DELETE /api/repos/:id/worktree?mode=safe|force`: refused (409 `WORKTREE_DIRTY`) when it has changes or untracked files unless forced, refused while a chat that hasn't ended uses it (one asleep wakes up in its folder); the branch is deleted only when merged, so commits are never lost with the folder. Chats' own session worktrees are removed with their chat (Chat sessions FR50); this route does not touch the chat's records.
- **FR18 Sync now.** `POST /api/repos/:id/sync`: the host's `repo-sync` fetches the upstream branch (the only thing in this PRD that reaches a network) and runs `merge --ff-only`. It never merges, rebases, stashes, resets or cleans. It leaves alone, and says why: a branch with changes to tracked files (untracked files don't stop it; git itself refuses to overwrite one), an operation in progress, a detached HEAD, no upstream, a branch that has diverged, a URL that isn't https, http, ssh, git, file or a path, and a repository **whose own configuration runs a program or changes where a fetch goes** (includes, credential helpers, `core.sshCommand`, `core.gitProxy`, `core.askPass`, `remote.*.uploadpack|receivepack|proxy|vcs`, URL rewrites, `protocol.*`, `http.*`): none of that is overridden, so nothing of the repository's runs. The merge runs with hooks, filters, signature checks and submodule recursion off.
- **FR19 Keep synced.** `PUT /api/repos/:id/sync {enabled}`, worktrees only, off by default. The timer's scan runs a sync for each opted-in worktree whose turn it is (at most every 15 minutes each, three per scan) and nothing else. Only an update or a changed failure is an event; a no-op or a repeated refusal is not. A worktree that did not opt in is never touched. Any repository can be synced by hand.
- **FR20 What a sync changed** is read right after and put down to who asked (the commits' `head_moved` carries the same actor as the `sync` event), not to a chat that happened to be there.

## 10. Audit

- **FR21 Every portal-initiated git action is an event with its actor.** `scan_requested` (a person's or a token's request to scan), `worktree_created`, `worktree_deleted` (forced or not, branch deleted or kept), `sync` (outcome, commits, why it was refused), `sync_setting` (keep synced on or off), `settings` (scan folders, automatic scans). Actors are `ui`, `session:<id>` (an agent's token), `ticket:<id>`, `portal-mcp:<token id>`, `portal:timer`, `portal:session`, `portal:sync` for what the portal did on its own timer. `?group=audit` (and `repo_events` with `audit`) lists only these.

## 11. Monitor and Portal MCP

- **FR22 Attention.** Each repository has `attention: { score, reasons }`, worst first: unreadable, conflicts, an operation in progress, diverged, behind (and nothing ahead), commits on no remote, changes, detached (not for a submodule), a submodule off its record, a submodule not cloned. A worktree's chats, a repository's workspace and a summary are all derived from these.
- **FR23 Summary.** Per workspace and overall: repositories, worktrees, with changes, ahead, behind, diverged, detached, unpushed, in conflict, not cloned, submodules drifted, unreadable, needing attention. `GET /api/repos` returns every workspace's summary (for the chip on the workspace list) and the 30 repositories that need a look first.
- **FR24 Portal MCP tools** (registered through the registry, interface I2): `repos_list`, `repo_get`, `repo_events` and `repos_attention` read (scope `agent`, read tier: an admin token reaches every workspace, an agent's token only its own, forbidden otherwise); `worktree_create` makes a worktree (an operate tier for an admin token, an agent only in its own workspace; rate limited to 6 a minute and 30 an hour per token, 2 KB of arguments). Folder names, branches, subjects, authors, URLs and error text come from the workspace and are labelled untrusted; the one line a model reads first carries none of it; no result carries a credential. **Finding a repository (T-980):** `repos_list` takes `name`, a case-insensitive substring of the folder name or path (it needs a workspace; agents search their own, an admin without `workspace_id` is refused rather than the filter ignored), with the total and the cursor counting the matches. `worktree_create` takes the repository as `repo_id` or as `path` (an absolute folder, with `workspace_id` for an admin; agents: their own), and one of the two exactly. A path is the same repository as its id (the id is `repoId(workspace, path)`), so it goes through the same lookup and the same workspace check; a path in a workspace the caller may not reach is the same `NOT_FOUND` as a path nobody has. The id form answers the same way: in `repo_get`, `repo_events` and `worktree_create`, a real `repo_id` of a workspace the caller may not reach gets, word for word, the `NOT_FOUND` of an unknown id, so a probe cannot tell that an id exists. A `workspace_id` given beside a `repo_id` must be that repository's own workspace; a mismatch is that same `NOT_FOUND`, never ignored. The parent-folder setting (comment 10096 on T-980) is a later slice, T-1261.
- **FR25 Live.** The `repos` live topic ("load them again") after a scan that found something, a request that asked for a scan, and any worktree, sync or settings change.

## 12. Safety

1. **Everything from a workspace is untrusted text.** Branch names, subjects, authors, paths, submodule names and URLs are parsed by whitelist (a line that doesn't match its shape is dropped), stripped of controls, bidirectional overrides and invisible characters, clipped, redacted, and shown by a page as plain text. A path is absolute and normalised or dropped; a path inside a repository is relative with no `..`.
2. **No repository code runs.** The host disables hooks, fsmonitor, filters, pager and external diff for every call; a sync additionally refuses a repository whose own configuration would run a program (FR18). Observed with a repository that sets `core.fsmonitor`, `core.hooksPath` and clean and smudge filters, each writing a marker if it ran: the control (plain git) wrote the fsmonitor marker, every portal command left all four unwritten (§19).
3. **No fetch unless asked, no credentials.** A scan never reaches a network. A sync is a request or an opt-in. Credentials in a remote URL are stripped before anything is stored, shown or returned; `GIT_TERMINAL_PROMPT=0` and ssh's `BatchMode` keep a fetch from asking anything. A sync uses the workspace user's own git configuration and credentials (the same as that user running `git fetch` in that repository): a repository whose remote URL points at an internal host makes the portal's sync contact it. Keep synced is therefore opt-in, per worktree.
4. **Bounded.** Depth, count, time per walk, per git call and per scan; a few events per scan; at most one scan at a time per workspace and two overall; a repository that times out rests; nothing is read from a stopped workspace; a read-only store scans nothing.
5. **Kubernetes** workspaces are never scanned, synced or given worktrees by this module (`WorkspaceRepos.running` is false for them).
6. **Existing workspaces.** The host script is installed by the portal into Docker and This machine workspaces whenever it differs from the current one (`chat/install.ts`), and every scan, worktree action and sync does that first: an existing workspace needs nothing (observed: a workspace whose image had no host script at all got the current one at its first scan). The image (`images/workspace/cp-session`) is regenerated for new workspaces.

## 13. Functional requirements

FR1 to FR25 above. Settings and what they are: `PORTAL_REPOS_AUTO` (on), `PORTAL_REPOS_INTERVAL_S` (300, clamped 30 to 86,400), `PORTAL_REPOS_ROOTS` (`~`), `PORTAL_REPOS_DEPTH` (6), `PORTAL_REPOS_MAX` (300); per workspace: scan folders and automatic scans (`PUT …/repos/settings`).

## 14. Data model (migration 120)

| Table | Holds |
| --- | --- |
| `repo_workspaces` | `workspace_id` (pk), `roots` (JSON array, null: the defaults), `auto`, the last scan's `scan_at`, `scan_ms`, `scan_error`, `scan_truncated`, `updated_at`. |
| `repos` | `id` (pk), `workspace_id`, `path` (unique with the workspace), `name`, `kind`, `parent_id`, `main_id`, `state` (JSON `RepoState`, null when unread), `error`, `extra` (JSON: worktree flags, submodule record, drifted count), `sync_enabled`, `sync_at`, `sync_outcome`, `sync_note`, `first_seen_at`, `scanned_at`, `removed_at`. A removed row stays 90 days so the repository returns under the same id with its sync setting. |
| `repo_events` | `id` (autoincrement, also the cursor), `at`, `workspace_id`, `repo_id`, `repo` (its name then), `kind`, `actor`, `session_id`, `summary` (one line), `data` (JSON). |

Nothing is a secret and nothing is sealed: URLs carry no credentials and text is redacted before it is stored.

## 15. API

Behind the session guard, with the Origin check on mutations. `workspaceId` is `<target>/<name>`. Types are in `packages/contracts/src/repos.ts` (`REPOS_API`).

| Route | Does |
| --- | --- |
| `GET /api/repos` | `ReposOverview`: every workspace's summary and the repositories that need a look first. |
| `GET /api/repos/events` | `workspaceId`, `repoId`, `kind` (comma separated), `group=audit`, `before`, `limit`: `RepoEventPage`, newest first. |
| `GET /api/repos/:id` | `RepoDetail`: the node, its children and its latest 20 events. |
| `POST /api/repos/:id/scan` | Read it and what hangs off it again; answers with the node (after a short wait; the rest follows by the live topic). |
| `POST /api/repos/:id/worktrees` | `{ branch?, base?, sync? }`: 201 `CreateRepoWorktreeResult`. |
| `DELETE /api/repos/:id/worktree?mode=` | Remove a worktree (`safe`, or `force`). |
| `PUT /api/repos/:id/sync` | `{ enabled }`: keep a worktree synced. `POST`: sync now, `RepoSyncResult`. |
| `GET /api/workspaces/:target/:name/repos` | `WorkspaceRepos`: the tree, its summary, the last scan, the settings. |
| `POST …/repos/scan` | `{ repoId? }`: scan now. 409 when the workspace isn't running (or is Kubernetes). |
| `GET\|PUT …/repos/settings` | `RepoSettings`: scan folders, automatic scans. |

## 16. User experience

Built by the web area (`apps/web/src/features/repos/`) from `REPOS_API` and the `repos` live topic, under the UI text diet: one-or-two-word labels, explanations in the shared `InfoTip`, nothing decorative, the design system's tokens only, phone first (390 px), touch targets of 44 px on phones.

- **Where.** The workspace's sheet (the bottom sheet or dialog its list row opens) has a `Details | Repos` switch (the tab's code loads when it is first opened, so it is not part of the page's first load); a Kubernetes workspace has no Repos. The repo sheet opens over it, a child repo opens in place with a way back, and Escape closes only the top layer (a menu, a dialog, the repo sheet, then the workspace's sheet).
- **Repos tab, toolbar.** One line: `23 repos · 2m` (the age of the last scan; `Scanning` while one runs, in the same place so nothing moves), `Attention 10` (a toggle that filters the tree to what needs a look, keeping the parents above it, quieter), `Partial` with an ⓘ when a limit cut the scan short, and two icon buttons: Scan now, Scanning settings. A pool of more than 12 repos also has `Find a repo` (by name, folder or branch). A scan that failed, or a copy of the tree that could not be refreshed, says so in one red line with Retry.
- **Repos tab, tree.** One row per repo, always 56 px tall whatever it holds, indented by `depth` with a guide line per level; a parent with children has a chevron beside the ⋯ that folds them. A row is the name over the branch (the commit when detached), each cut to one line with an ellipsis, the marks (sessions running there, green while one is alive; a worktree kept synced, red when its last sync failed), and at the right its chips: the first one on a phone, two on a wider screen, worst first, then `+N`, which opens the rest with what each means (a count is compact: `54k`). The chips: `Changes 3`, `Ahead 2`, `Behind 3`, `Diverged`, `Unpushed 4`, `Conflicts 1`, `Merging` (or `Rebasing`…), `Detached`, `Drift` (a superproject: `Drift 2`), `Unreadable`, `Not cloned` (a muted row); nothing for a clean repo. Tapping the row opens its sheet; ⋯ has Scan, New worktree…, Sync and, for a worktree, Keep synced (a check) and Remove…. A name or branch that is cut shows whole in a tooltip on hover and on keyboard focus (Escape dismisses it); on a touch the sheet shows it. Names, branches, paths, URLs, subjects and event lines are user text: they break anywhere rather than widen a sheet, read right to left when they are, and never decide a width. Rows keep their keys, so a live update never moves a row that is already in view (a chip appearing changes no height; a repo inserted above is absorbed by the browser's scroll anchoring).
- **Repo sheet.** Scan, Sync, New worktree (a worktree adds ⋯ with Keep synced and Remove). Then the values, each told once (a value out of the ordinary is amber or red and no chip repeats it): Branch with its upstream and how far ahead or behind, Operation, HEAD (subject, commit, author, age), Changes, Unpushed, Stash, Recorded (a submodule; drift shows under it), Fetched, Filters, Keep synced with its last outcome, Folder. Then Remotes (the workspace-local one links to the CI remotes), Sessions (live first, each a link), Worktrees, Submodules and Nested (a row opens that repo), and the Timeline.
- **Timeline.** `All | Commits | Audit` (server filters: no filter; `head_moved` and `branch_changed`; `group=audit`), newest first, 20 a page with `More`. A line is the event's one-line summary without the repo's name, the actor (`Person`, `Session` and `Ticket` are links, `Agent token`, `Keep synced`, `Timer`, `Workspace`) and its age; a line with more to say opens (the commits' subjects and the move, the reason, the counts). Everything from the workspace is plain text.
- **Dialogs.** `New worktree` (Branch, From, Keep synced: as in the chat's New session), `Remove` (one question; a refusal for changes says how many files, and only a second, explicit yes discards them), `Scanning` (Folders, one per line; Automatic; a changed folder list scans at once). Answers are toasts of a few words (`Not synced: it has diverged`).
- **List row.** A pill beside the workspace's name: the branch glyph and the number needing attention, in the colour of the worst of them; nothing when none does or the workspace was never scanned; a stopped workspace shows its last scan; tapping it opens the Repos tab. Its tooltip says what the count is made of.
- **States.** Loading is a skeleton of rows; empty is one line (`Start the workspace to scan for repos.`, `Not scanned yet.`, `No repos found.`, `No repo matches.`, `Nothing needs attention.`); an error is the portal's message with `Try again`; denied is the portal's reason; offline keeps the last copy with its message and Retry.
- **Multi-user (light touch, for the access model to come).** What a person may do on a workspace is the portal's to say: a 403 on a scan, a worktree or a sync turns that action off for the sheet, disabled with the portal's own reason (under the menu item, in the button's title), and a 403 on the tree shows the reason instead of it. Nothing is assumed to work. The UI stores nothing per person locally (filters and folds live in the page); a preference that were stored would be keyed by the user id.

## 17. Verification

What was observed and how (all with the generated host script and real git, none with a real remote or account):

- **Host script** (`repos/host.test.ts`, 15 tests): discovery on a pool built by the test (plain repository, worktree, bare remote with clones ahead and behind, superproject with three submodules, a nested repository, a clone with a not-cloned submodule, detached, unborn, stash, credentials in a remote URL), pruned and hidden folders, the limits and refusals, the commits since the last look, and every sync outcome including the refusals (diverged, dirty, untracked-only, detached, no upstream, an operation in progress, a repository with `core.sshCommand`, a credential helper and a URL rewrite, an `ext::` URL, an unreachable remote).
- **Hostile repository:** `core.fsmonitor`, `core.hooksPath` and clean and smudge filters each write a marker; plain git wrote the fsmonitor marker (the control); `repo-find`, `repo-state` and `repo-sync` wrote none. The `core.sshCommand` and credential helper of the hostile sync repository did not run either.
- **Parsing, tree, events, store** (`parse`, `tree`, `store` tests): hostile and truncated output, kinds and parents, orphans, drift, attention and counts, every event transition, retention and the cap.
- **Host adapter** (`hostAdapter.test.ts`, 2 tests): reading runs niced, acting doesn't, the workspace id is split, a command that doesn't end in time reads as failed.
- **Service** (`service.test.ts`, `actions.test.ts`, 19 tests): a scan of the pool, quiet rescans, changes noticed once with the right events, attribution to one chat, to the workspace when several, worktrees made and removed through the host, syncs and keep synced, settings, the timer's rounds and the walk cadence, the rest of a repository that times out, a Kubernetes target left alone, a parked chat not blamed, chats' turns.
- **Routes and MCP** (`routes.test.ts`, `portalTools.test.ts`, 10 tests): shapes and refusals; the five tools over the real MCP server with read, operate and agent tokens; untrusted labelling; no credential in any answer.
- **Live:** a scratch portal (Kubernetes target off), one real Docker workspace (image git 2.39.5; no host script in its image): the first scan installed the current host script (root-owned) and read 20 repositories in 1.2 s; the timer's next round noticed a commit made inside the workspace (`head_moved`, by name) and the `clean` transition the new counting produced; a worktree was made through the API and through MCP (`portal-mcp:<token id>` in the audit); a clean clone behind its remote was fast-forwarded by a request and a diverged one was refused with its reason; the Portal MCP tools answered over `/mcp` with an operate token.
- **The owner's real pool, read-only** (`COORD/ro-mount.sh`, no network, read-only mount, a throwaway container whose image has git and jq, `safe.directory` through the environment, counts only; the whole scan pipeline, not just the script): the root is a repository with no `.gitmodules` and 17 of its 21 top-level folders hold their own `.git` folder, so the tree is the root and **17 nested repositories**, 18 in all, none failing to read. A scan took 2.8 to 4.5 s in 4 host calls (discovery 0.7 s). All 18 are on a branch (none detached), 16 follow an upstream, 17 have two remotes and one has one (three distinct hosts), none configures a filter, 2 have a stash, all were last fetched 5 days ago; 1 has changes, 4 are behind their upstream, none is ahead, diverged, in conflict or mid-operation: 5 need attention. Nothing was written (the mount is read-only and git ran with `GIT_OPTIONAL_LOCKS=0`).

- **Web UI** (a real Chromium over CDP against a scratch portal with Kubernetes off and a clean environment, one Docker workspace holding a pool of 30 repos: a superproject with three submodules (one off its record), a nested repo, a clone with a not-cloned submodule, a linked worktree, and clones ahead, behind, diverged, detached, unborn, stashed, with changes and mid-merge with a conflict; also 281 repos): the tab and the repo sheet at 390, 844x390 (phone landscape), 768, 1024, 1280 and 1920 px, light and dark, and the three dialogs at 390, 844x390, 768 and 1280 px, with no horizontal overflow or clipped element at any of them (measured). Run through the real portal: make a worktree, keep it synced, remove it (refused for an untracked file, then discarded on a second yes, the branch removed with it), sync a repo behind its remote (fast-forwarded), a diverged one and one without upstream (refused with their reasons), the scanning settings (a `..` folder refused with the portal's message, valid folders saved and scanned), the attention filter, folding, the find field, in-sheet navigation and back, the timeline filters and an opened event (a subject with markup shows as plain text). A change made in the workspace and scanned from outside appeared in the open tab with no interaction (the live topic). Keyboard only: the order of focus, a menu opened and moved with arrows, Escape closing one layer at a time (a tooltip, a menu, a dialog, the repo sheet, then the workspace's sheet) and returning focus. Extreme data (a 200-character folder name and a 200-character branch name with no spaces, emoji, Arabic and Hebrew names, a repo with four chips, a 150-character author, a 190-character subject, a 200-character remote path): every row stayed 56 px, nothing overflowed at 390 px, every cut text had its tooltip on keyboard focus, the sheet wrapped the same text in full. Live changes through a fetch stub: chips added, removed and changed on three repos moved no row; a repo inserted in the middle moved only the rows below it by one row, and the rows in view stayed where they were (Chromium's scroll anchoring; Safari not measured). 281 repos rendered in 2.2 s on a machine with a load average above 20 (0.3 s for 174 repos on a quiet one) and filtered in about 200 ms. Touch targets measured at 390 px: every control of this feature is 44 px (the `Attention` pill looks 32 px and hits 44) except the kit's own Dialog close and Segmented (40 px); at 640 px and wider the kit's small buttons (Scan, Sync, New worktree, the toolbar's icons: 32 px tall) keep its pointer-device sizes, while this feature's own ⋯, chevrons and menu items stay 44 px. Simulated, not observed with the real thing: a 403 (a fetch stub), sessions in a repo (a stub: no chat could run without a sign-in), a partial scan, an unreachable portal and a failing timeline (stubs). Web tests: `features/repos/labels.test.ts` (13 tests: chips and tones for every state, compact numbers and clipping, the tree and its filters, event details, wording).

## 18. Milestones

| ID | Scope | Status |
| --- | --- | --- |
| G1 | Contract, migration, host commands (`repo-find`, `repo-state`, `repo-track`, `repo-sync`), discovery, tree, state, scans (request, start, chats, timer), events, retention, summary | **Built** and tried (§17) |
| G2 | Worktrees (make, remove), sync now, keep synced, audit of every action, settings | **Built** and tried |
| G3 | Portal MCP tools (`repos_list`, `repo_get`, `repo_events`, `repos_attention`, `worktree_create`) | **Built** and tried over `/mcp`. `worktree_create` takes an optional `parent` (T-1261, below) |
| G4 | The Repos tab, the repository sheet and the list chip | **Built** and tried in a real browser (§17). Not built: a deep link from a chat's worktree chip to its repo, a clone action for a not-cloned submodule (§4), changed-file lists (§4), virtual scrolling (the list is not windowed: 173 repos were fine, the server caps a scan at 300) |
| G5 | Kubernetes workspaces, cloning not-cloned submodules, changed-file lists, deep links to the CI remote | **Not built** |

**A worktree's parent folder (T-1261).** A worktree is made in `<repository>.worktrees/<leaf>` beside its repository unless the
request names `parent` (the `worktree_create` tool and `POST REPOS_API.worktrees`), an existing folder to make it in. The portal
takes it written like a path the host prints (`absPath`: absolute, no `.` or `..` part, no control character, at most 400
characters), else 400 `VALIDATION_FAILED`. The host's `wt-add` then checks its real path with the Files policy (`allowed`: under the
files root, not the portal's own files) and that it is a folder: anything else (missing, outside the workspace, the portal's own
files, a link out of the root, a file) is one `NOT_FOUND`, "No such folder.", so a caller can't tell a folder it may not see from
one that isn't there. A parent inside the repository or in a `.git` folder is refused (400). An agent's token reaches its own
workspace only, as before. Note: the lane rule guard lets `git -C` reach only worktrees under a `.worktrees` or `agentic-worktrees`
folder (settings-policies, T-860), so a lane's worktree belongs in one of those.

## 19. Decisions made on the owner's behalf (provisional)

- D1 The default folder to scan is the home folder, bounded, not only `work` and `projects`: pools live anywhere, and the walk's limits and a workspace's own folders answer the cost.
- D2 Ids are path based; a moved repository is a removal and a discovery.
- D3 A scan re-reads every known repository; removal needs the folder read again and found empty.
- D4 Sync refuses a repository whose own configuration runs programs rather than overriding it; the user's own (global) configuration is honoured.
- D5 Attribution is by presence (the chats in the repository since the last look); ambiguity is the workspace's own.
- D6 (the coordinator's) read-only scanning always; sync fast-forward only, on a clean worktree, when asked or opted in per worktree; worktrees through the existing hardened host.
- D7 Kubernetes workspaces are not scanned.

## 20. Unverified, and open questions

| ID | What |
| --- | --- |
| U1 | A fetch over https or ssh with real credentials, a credential helper (`gh auth git-credential`) and a private remote: only a local bare remote, an unreachable URL and refusals were run. |
| U2 | Timing of a repository with hundreds of thousands of files is untried (the real pool's repositories read in well under a second each); the 20 s per call limit and the rest of a slow repository exist for that. |
| U3 | A real chat session in a repository: attribution was tested with fake chats; a live chat run was not tried. |
| U4 | The ownership path (a repository owned by another user: `E ownership`, `unsafe`) was not exercised (no second user in the workspace). |
| U5 | Git LFS and other filters: counted, never run; behaviour of the changed-file counts on LFS content was not observed. |
| U6 | The host script's GNU tool assumptions on This machine when the portal runs on macOS (the chat host has the same). |

| ID | Question |
| --- | --- |
| Q1 | Should a scan ever fetch, so "behind" is current? Today no: it shows what the last fetch left. A per-workspace opt-in is the natural place. |
| Q2 | Default roots: the home folder (today) or only the usual project folders? |
| Q3 | Keep an id across a move by matching the root commit and the remote? |
| Q4 | Offer "clone" for a not-cloned submodule (a network action: an explicit request, hardened, with the same refusals as sync)? |
| Q5 | Tighten attribution with the reflog's times, so a change is put down to a chat only if it happened while it ran? |
| Q6 | A staleness threshold for FETCH_HEAD (a chip "not fetched for 12 days")? |
