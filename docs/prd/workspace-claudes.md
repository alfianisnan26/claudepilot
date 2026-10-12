# PRD: Workspace Claudes

| | |
| --- | --- |
| Status | **Draft v0.5.** v0.5 (owner's correction, 2026-10-12): moving a chat to another Claude never makes a second session. The chat is one portal session for its whole life (same row, same URL, one continuous transcript); only the Claude Code session underneath changes, and a handoff turn on the Claude it runs on comes first (Q3 answered: the default). Replaces the transfer-into-a-successor design of v0.1 to v0.4 (G4 to G6, US4, US5, §7, FR9 to FR18, §9, §11, §14). v0.4 (owner's decision, with [Chat sessions](chat-sessions.md) v0.7): a portal chat on a workspace without a pool runs on its Claude's own sign-in (§6, FR4, FR7). v0.3 followed what was built: the portal can start each Claude's own sign-in and shows whether it's signed in (status and method only, FR4, FR21); terminals run as a Claude (FR22); removing a Claude waits for its terminals and frees its name (FR3); the Claudes list sits on the workspace (§11). Q1 answered, Q2 half answered. v0.2 stated who writes the context file, that a new directory is unsigned-in, and that the Claude list is portal sessions only. 🔬 = unverified, listed in §16. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [Chat sessions](chat-sessions.md) (session controller, event store, one writer, eligibility), [Account Pool](account-pool.md) (the only credentials a portal session runs on), [Pools foundation](foundation-pools.md) (the workspace home volume) |
| Related | [Web app & PWA](web-app-pwa.md) (session screen), [Monitoring dashboard](monitoring-dashboard.md) (session list) |

## 1. Summary

A workspace is one VM and one volume. On that volume a person can keep several Claudes. Each Claude has its own directory, so its chats and its local login stay apart from the others. Portal chat sessions still belong to the workspace. Opening one includes choosing which Claude it runs in.

Moving a chat to another Claude is a switch of the Claude Code session underneath, asked for by the person. The chat does not change: it keeps its id, its row in Sessions, its URL and one continuous transcript. The portal asks the Claude the chat runs on to write a handoff, writes a context file from that and from its own event store onto the same volume, starts a new Claude Code session in the other Claude, in the same folder or worktree, sends it the context, and only then stops the old process. A divider in the transcript marks the move. Other chats, other workspaces, and every login stay where they are. Creating a Claude does not sign it in.

Each Claude also has its own Claude Code login for the terminal. The workspace lists its Claudes with whether each is signed in, and from there a person signs one in, switches its account, signs it out, or opens terminals that run as it. Claude Code does the sign-in in that Claude's directory. The portal shows the link and passes on the code, and keeps neither the code nor the login. Portal chat on a workspace without a pool runs on that sign-in, so two Claudes can chat as two accounts. With a pool, chat runs on its keys.

## 2. Background and problem

- A portal chat session is one Claude Code process in one workspace. The workspace has one home, so it has one Claude: one transcript store and one local login.
- People want more than one Claude on that machine without a second VM or a second volume. Two terminals in the same home are not two Claudes. They share the login and the chats.
- A long thread sometimes should continue under another Claude on the same machine, most often because the first is out of quota or signed out. Carrying it by hand means copying a summary and starting over.
- A move that made a second session (v0.1 to v0.4) split one conversation into two rows and left the first one behind. The owner's correction: the chat is one thing, the Claude session under it is another.

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **One volume per workspace.** Several Claudes live on the workspace home volume. No extra volume is assigned, and nothing is shared with another workspace. |
| G2 | **Real isolation.** Each Claude has its own directory. Its process is started with that directory. Logins and chats do not cross directories. |
| G3 | **Portal sessions stay on the workspace.** A session row names the workspace and the Claude it runs in. The workspace list and the eligibility rules do not change. |
| G4 | **Choose the Claude.** New chat on a workspace asks which Claude to start. A chat already open can move to another Claude only by a confirmed switch. |
| G5 | **One chat, seamless.** A move keeps the session id, the row, the URL, the open socket and one transcript. The Claude label updates. There is no successor, no second row and no left-behind row. |
| G6 | **A handoff, then a clean cut.** The Claude the chat runs on writes a handoff for one that has seen none of it; the new Claude starts from it. The new Claude must answer before the old process stops, and any failure before that leaves the chat running on its Claude. |
| G7 | **One writer.** The live portal thread is the only writer of a Claude session. At most one Claude Code process per chat is the current one; the old one stops last. |

## 4. Non-goals

- **A quota switch.** Nothing watches a plan window or an API-key headroom and moves a session. Account Pool failover stays [Account Pool](account-pool.md). This PRD does not choose another login when usage runs low. **Amended 2026-10-12** ([Auto transfer](auto-transfer.md), owner decision O2): that is now the job of an opt-in feature that is off by default. With it on, a chat can move to another already signed-in Claude of the same workspace when a quota is low, in `ask` mode with a card that is the confirmation of each move, or in `auto` mode under the person's standing setting and its safeguards. The Move flow below is the mechanism and does not change.
- **Rotating or pooling Claude plan logins.** The portal does not store, copy, inject, rotate, or select SSO or other subscription credentials. A session on a Claude without a pool uses the sign-in that Claude already has; the portal never picks another (except as the auto-transfer amendment above says: it never copies or injects a credential, and with the person's opt-in it may choose which signed-in Claude of the workspace takes the chat). It may start Claude Code's own sign-in in a Claude's directory (FR4). Claude Code writes that login there. The portal never reads it.
- **A second workspace as the destination.** A move stays inside one workspace. Three workspaces are three volumes. Their disks are not mounted into each other.
- **tmux as isolation.** tmux keeps a terminal running without a browser. It does not separate Claudes. A terminal is a Claude by the directory it was started with (FR22). Two shells with one directory are one Claude.
- **Hot-swapping a running process.** The open process keeps the directory it started with until that session stops. The continuation is a new session id.
- **Parsing Claude Code's own transcript files.** The context file is built from the portal's event store, which [Chat sessions](chat-sessions.md) already keeps. The portal does not open `~/.claude/projects`, `~/.claude/sessions/*.key`, or `.credentials.json`.
- **Merging two live threads.** A move does not splice two running sessions into one process: at most one process is the chat's current run, and the old one stops last.

## 5. Users and stories

**Workspace user** chats in a workspace and sometimes keeps more than one Claude there. **Admin** is often the same person.

| ID | Story |
| --- | --- |
| US1 | I add a second Claude to a workspace. It gets its own directory on that workspace's volume. The first Claude's chats are unchanged. |
| US2 | I start a portal chat and pick Claude A or Claude B. The session runs in the one I picked. |
| US3 | I keep chatting in Claude A and, separately, in Claude B. Neither thread appears in the other Claude. |
| US4 | On an open chat I choose Move, pick the other Claude (each says before I confirm whether it can take the chat), and confirm. The chat stays open and connected. A divider reads "Moved to satria" with a card for the context that was carried. |
| US5 | Grouped by Claude, Sessions lists the chat under its current Claude and, lighter, under each Claude it ran on earlier ("now on satria"). Both open the same chat. |
| US6 | I open the real session the thread is tailing. It is that same session, not a second one writing beside it. |
| US7 | I have three workspaces. A move in one of them does not appear in the other two, and their Claudes keep running. |
| US8 | I create a Claude, including a second one on this workspace or the same account on another workspace. Its directory is empty. I sign it in from its row on the workspace, or in a terminal running as it. On a workspace without a pool, a portal chat on it then runs on that sign-in. |
| US9 | The list on a Claude shows the portal chats that ran there, including ones that have since moved on ("now on satria"). A shell I started myself in the terminal is not on that list. |
| US10 | On a workspace I see each Claude: signed in or not, and whether with a Claude account or a Console key, and how many terminals run as it. From its row I sign it in, switch its account, sign it out, rename it, or remove it. |
| US11 | I open several terminals on one workspace, each as a Claude I pick. Claude Code in each one uses that Claude's login, and keeps running after I close the browser. |

## 6. Scope boundary

| Allowed | Not allowed |
| --- | --- |
| Several named Claudes on one workspace volume, each a directory the portal created and starts processes with. | Copying a directory in order to move a login. Reading a directory to discover which account or plan is signed in. |
| A portal session on a Claude: on the workspace's Account Pool when it has one (active and Synced, with the `apiKeyHelper` checks of [Chat sessions](chat-sessions.md) §6), otherwise on that Claude's own sign-in. | A session on another Claude's sign-in, on a credential the portal copied or injected, or one that changes credential mid-run. |
| A person using the workspace terminal in a Claude directory, including a sign-in Claude performed there. | Starting a terminal with a directory other than the Claude picked for it. |
| The portal starting Claude Code's own `claude auth login` or `claude auth logout` with a Claude's directory, showing the sign-in link it prints, and writing the code the person pastes to that process. | Storing or logging that code or the login it produces, or reading the directory's files. |
| Showing whether a Claude is signed in and by which method, from `claude auth status` run with its directory. | Showing or keeping the account, organization or email behind it (the plan's tier name only as [Claude usage](claude-usage.md) §6 says). |
| A context file of redacted portal events, written on the same volume, then read as the opening context of a new portal session. | Putting a key, a token, or a credential file into the context file. |
| Listing portal chats by the Claudes they ran on, including ones that moved. | Resuming an earlier run's Claude Code session after the chat moved on, or resuming a run inside another Claude's directory. |

Managed settings for the workspace stay workspace-wide (`/etc/claude-code/managed-settings.d`). With a pool, every portal session in every Claude of that workspace uses the workspace's account-pool helper. Without one, each session runs on its own Claude's sign-in, so separate directories can be separate accounts for chat as well as for the terminal. While a pool is assigned its keys replace own sign-ins, so sign-in, switch, and sign-out are refused until it is unassigned.

## 7. Solution overview

```
 Workspace volume (/home/node)                         Portal
 ┌──────────────────────────────────────────────┐     ┌──────────────────────────────┐
 │ claudes/a/   login and chats of Claude A     │     │ session row                  │
 │ claudes/b/   login and chats of Claude B     │◀────│   workspace_id               │
 │ transfer/<id>.md   context file, no login    │     │   claude_id (current run)    │
 │                                              │     │   claude_session_id, segments│
 │ cp-session started with that Claude's        │     │ event store → context file   │
 │ directory. One writer per live session.      │     │ confirm → new run → stop old │
 └──────────────────────────────────────────────┘     └──────────────────────────────┘

 Workspace 1 volume  │  Workspace 2 volume  │  Workspace 3 volume
 no path between them. A move never crosses the bar.
```

1. **Registry.** The portal stores the Claude's name and directory id. The directory is created on the workspace volume. The existing home Claude is adopted as the first one, named Default, so sessions that already exist keep their place (🔬 Q1).
2. **Launch.** A portal session records `claude_id`. The host starts `claude` with that directory. Chat sessions' eligibility, auth check, and usage check run unchanged.
3. **Switch.** On confirm the controller, in order: checks that the destination can host a session and the folder is trusted; waits for a turn boundary; asks the Claude the chat runs on for a handoff (the default); writes the context file; starts a Claude Code process in the destination Claude under a new Claude Code session id; repoints the chat at it and sends the framed opening; waits for the new Claude's acknowledgement; then stops the old process and closes its segment. The chat's id never changes.
4. **One stream.** The open client keeps its subscription. The transcript shows the earlier messages, then a divider "Moved to satria" and one expandable card ("Context from Default") holding the handoff, the conversation carried and the acknowledgement.
5. **Audit.** A chat has one segment per run on a Claude (`chat_segments`: the Claude, its Claude Code session id, when, why it ended, cost and turns). Session info and Usage show them; Sessions grouped by Claude lists a chat under each Claude it ran on.
6. **Sign-in and terminals.** The workspace lists its Claudes with their sign-in state. A sign-in runs Claude Code's own `claude auth login` with that Claude's directory. A terminal is a tmux session started with that directory, running `claude` or a shell.

## 8. Functional requirements

### Claudes

- **FR1** A workspace has one or more Claudes. Creating one asks for a name, unique among that workspace's Claudes that are not removed (409 on a duplicate). The portal creates an empty directory on the home volume and stores the name, directory id, and creation time. It does not copy another Claude's directory.
- **FR2** The first Claude on a workspace is Default, bound to where Claude Code keeps its files with no directory set (`~/.claude` and `~/.claude.json`), so existing sessions and an existing login stay put (Q1). New Claudes get a new directory, `~/.claudepilot/claudes/<16 hex>` in the workspace home (`/home/node` in a container, the person's home on This machine).
- **FR3** Renaming a Claude changes the label only, with the same uniqueness as FR1. Removing a Claude is refused for Default, while it has a session that is not ended, and while a terminal runs as it. Removing one with only ended sessions keeps those rows and marks the Claude removed. Its name is free again for a new Claude. The directory is left on the volume. The portal does not delete a directory that may hold a login.
- **FR4** A Claude has no credential fields. The API never returns, accepts, or logs the contents of its directory. Creating one does not sign it in and does not copy a login from another Claude or another workspace. The directory starts empty. Each Claude signs in on its own, including when that same account is already signed in elsewhere, in one of two ways: in a terminal running as it (FR22), or from its row on the workspace. From the row, the portal runs `claude auth login` with that directory, shows the link Claude Code prints (only an https link on claude.com, claude.ai, or anthropic.com), and writes the code the person pastes to that process. The code is held only until it is written, never stored or logged. Claude Code writes the login into the directory. Switch account is the same sign-in over the existing one. Sign out runs `claude auth logout` with that directory. These three are refused while the workspace has an account pool (§6). Without a pool a portal chat runs on its Claude's sign-in, so starting a chat on, or moving one to, a signed-out Claude is refused with a pointer to sign it in (FR7).

### Sign-in state and terminals

- **FR21** The workspace lists its Claudes that are not removed, each with its sign-in state from `claude auth status --json` run with its directory. Only `loggedIn` and `authMethod` are kept. When the command fails the state shows as unknown, not as signed out.
- **FR22** A terminal is a tmux session on the workspace, started as one Claude (`CLAUDE_CONFIG_DIR` set to its directory, unset for Default) in a folder the person picks, running `claude` or a shell. A workspace has at most 8. Terminals keep running without a browser. Closing one ends what runs in it. The terminal list names the Claude each runs as. tmux and Claude Code are installed on first use when missing.
- **FR23** A terminal is not a portal session. It is not on a Claude's session list (FR20), it is not one of the writers FR8 counts, and the portal does not read what runs in it.

### Portal sessions

- **FR5** Creating a portal session requires a `claude_id` on that workspace. Omitted, the workspace's Default is used. The session row stores it. The host process is started with that directory and no other Claude's directory.
- **FR6** A run keeps its `claude_id` for its whole life. Resume, wake, and steer use the current run's directory. No control points a running process at another directory: a chat changes Claude only by a move (FR11), which starts a new process there.
- **FR7** Eligibility follows [Chat sessions](chat-sessions.md) §6 v0.7. With a pool: an active, Synced account pool, `authcheck` pass, and `apiKeySource: "apiKeyHelper"` each turn. Without one: the session's Claude signed in, from `claude auth status` with its directory before every start (only `loggedIn` counts), and no pool checks. A failure ends or refuses the session the way Chat sessions §6 does. The portal reads nothing else of the Claude directory to explain it.
- **FR8** One writer per Claude Code session, the existing `run.lock` (one lock per Claude Code session id). Opening the chat from the list opens that chat; it does not launch a second process for the same run.

### Switch

- **FR9** Move is available on a chat whose workspace has at least one other Claude that is not removed, and that has not ended. The control lists those Claudes by name and, before the person confirms, whether each can take the chat now (signed in, or the workspace's pool usable): a Claude that can't is listed with its reason and the way out (sign in, the pool, start the workspace) and can't be picked. It does not list other workspaces.
- **FR10** The confirm says only what is decided: the Claude, the handoff choice (on by default, off when the Claude the chat runs on can't be asked, with the reason), and one terse line for what the move drops (a running turn, approvals waiting, queued messages, running agents). Confirm is required every time. There is no "always switch" setting. **Amended 2026-10-12** ([Auto transfer](auto-transfer.md), O2): this holds for every move a person starts. The opt-in `automove` feature (off by default) is the one exception: in `ask` mode its card is the confirmation of that move, and in `auto` mode the person's setting is the standing confirmation, bounded by that PRD's safeguards; Undo always goes through this dialog.
- **FR11** On confirm the controller, in order, and any failure before the new run is up leaves the chat on its Claude, running and usable: refuses if a move of this chat is already running (409); refuses, before touching anything, when the destination can't host a session (409 `CHAT_INELIGIBLE`) or the folder needs trust (409 `FOLDER_UNTRUSTED`); waits for a turn boundary (a running turn is interrupted only after the confirm, which said so); asks the Claude the chat runs on for a handoff (FR12); writes the context file; starts a Claude Code process in the destination Claude's directory, in the same folder or worktree, under a new Claude Code session id; repoints the chat at it (its Claude, session id, log, segment) and sends the framed opening; waits up to 60 s for the new Claude to acknowledge it; stops the old process and closes its segment (`switched`). While it runs the chat takes no message, control, end or delete (409): nothing is queued, the composer reads "Moving to <Claude>…" and the transcript shows progress rows. A failure after the repoint undoes it: the chat points at its old run again, which was never stopped, and the transcript says the move did not finish and why.
- **FR12** The handoff turn: a message the portal sends to the Claude the chat runs on (actor `portal:handoff`, never shown as typed by the person) asking it to compact what it knows into a context-transfer document for a different Claude and to stop there: the goal and the person's stated preferences and constraints, the current state, decisions with their reasons, what was done, what is open or blocked, the next step, the paths, URLs and identifiers that matter, and what not to redo; no secrets; at most 900 words; no tools. Bounded: about 90 s, a tool request during it is denied, and the turn is interrupted when time runs out. When the Claude can't answer (signed out, over quota, error, timeout, an approval waiting) the move says why and goes ahead with the conversation as the portal stored it; the person can also choose to skip the handoff in the confirm. The context file (`~/.claudepilot/transfer/<handoff id>.md`, redacted, written only there) holds the document, what the portal knows itself (folder or worktree and branch, agents that were running, approvals that were waiting, messages that were queued) and the conversation. It holds no credential, `apiKeyHelper` path or environment value.
- **FR13** The new Claude's first message is the opening: framed as prior context from the named Claude, not as something the person typed, embedding the handoff and the latest messages of the conversation within the stored-event cap (16,000 characters), naming the context file to re-read later, and asking for one short acknowledgement line and no tools. The Claude Code session id is new; `--resume` is not used for it.
- **FR14** The open client stays on the same chat: no navigation, no resubscribe. Everything a move wrote (progress rows, the handoff request and document, the opening, the acknowledgement) carries the move's id; the transcript folds it into the divider "Moved to <Claude> · 14:02" and one card, "Context from <Claude>", that opens to the handoff, the conversation carried and what the new Claude answered. A move that didn't finish shows one line saying why. The earlier transcript stays above the divider exactly as it was.
- **FR15** Moving back to a Claude the chat ran on before starts a fresh Claude Code session there under another new id. The old one is never resumed or revived by the portal.
- **FR16** A move does not move, end or retarget any other chat. A chat's ticket, parent, worktree and children keep following its id. Bypass permissions never carry over: a move ends it.

### Audit

- **FR17** Sessions grouped by Claude lists a chat under its current Claude and, lighter, under each Claude it ran on earlier ("now on <Claude>"). Both rows open the same chat. The list has exactly one row per chat, before and after a move.
- **FR20** That list is portal sessions only. A process the person started in the terminal is not a row. It stays in the Claude directory, and the portal does not read Claude's own session index to find it.
- **FR18** Session info (Usage) shows the chat's runs: each Claude with its turns and cost. Resume, wake and steer use the current run's Claude Code session and directory. An old session id, from before moves were folded into one chat, still opens the chat (an alias).

## 9. Data model

Columns added to the chat session row, and new tables. Secrets are not among them.

| Store | Fields |
| --- | --- |
| `workspace_claudes` | id, workspace_id, name (unique per workspace among rows with no removed_at), directory (`claudes/<id>`, empty for the adopted Default), removed_at, created_at |
| `chat_sessions` | existing columns, plus `claude_id` (the Claude of the current run), `claude_session_id` (the Claude Code session of the current run; null means the portal id, as for every session before moves), `cost_base_usd` (what the closed runs cost), `segment_seq` (the last event seq when the current run began). `predecessor_id` and `successor_id` are legacy: a move never sets them |
| `chat_segments` | session_id, n, claude_id, claude_session_id, cwd, started_at, ended_at, ended_reason (`switched`, `closed`, …), cost_usd, turns: one row per run of the chat on a Claude |
| `chat_session_aliases` | alias_id, session_id: the id of a session that was folded into a chat, so old links and references still find it |
| `claude_handoffs` | id, workspace_id, source_session_id, successor_session_id, source_claude_id, dest_claude_id, path of the context file, created_at, actor: one per move, both session ids are the chat's |

Events, inputs, requests, tasks, files and usage stay keyed by the portal id; each usage row keeps the Claude of its turn, so usage by Claude stays right. A chat's cost is the closed runs' cost plus the running process's total (Claude Code reports a running total per process). The host keeps a run's files under `~/.claudepilot/sessions/<claude session id>/`; deleting a chat purges every run's folder.

Migration 17 folded every pair an older move had left (a session ended as transferred and its successor) into one chat: the events follow each other in one transcript, inputs, requests, tasks, files and usage point at the first session's id, the cost adds up, each run is a segment, each folded id is an alias, and the successor row is gone.

The context file is not a database blob. The row stores its path. The file lives on the workspace volume so a stopped workspace still has it when it starts.

Terminals and sign-ins have no table. tmux is the record of terminals: sessions named `cp-claude-<n>` or `cp-shell-<n>`, each with the Claude it runs as in a tmux option. A sign-in that is waiting lives in the portal's memory. Its `claude auth login` process ends after 15 minutes at most.

## 10. Isolation

| Boundary | Separates | Does not separate |
| --- | --- | --- |
| Workspace volume | This VM from every other workspace. The home volume is the one the runtime already mounts at `/home/node`. | Claudes inside the VM. |
| Claude directory | That Claude's chats, local settings, and any login Claude has written there. The process environment names this directory and no other. | The workspace's managed settings, account-pool helper, persona, skills, and MCP sets. Those stay workspace-wide. |
| tmux or a second shell | Nothing, unless the shell's process was started with a different Claude directory. FR22 terminals are. | — |

A path in one Claude's directory is not a cwd the portal will start another Claude's session in. File tools in a session stay subject to [Chat sessions](chat-sessions.md) path rules. The transfer directory is not a chat cwd.

Q2, half answered: on Claude Code 2.1.296 (This machine) the directory holds that process's `.claude.json`, sessions, and caches, and `~/.claude.json` is untouched. 🔬 Still open: that managed settings, including `apiKeyHelper`, load the same with a directory set, on the pinned workspace image.

## 11. What the person sees

Phone and desktop use the existing session screen.

| Place | What it shows |
| --- | --- |
| Claudes (workspace sheet) | One row per Claude: name, a badge (Signed in, Signed in · key for a Console login, Signed out, or Unknown), and how many terminals run as it. A terminal button opens a new terminal as it. ⋯ has Sign in… or Switch account… (off while the state is Unknown), Sign out, Rename…, and Remove (off while terminals run, absent on Default). New adds one. With a pool assigned, a line says the pool's keys are in use and the sign-in items are off. |
| New Claude | A name only. The directory is empty and the row shows Signed out. Sign in from the row or in its terminal, including for an account already used elsewhere. Without a pool, chat on it waits for that sign-in. |
| Sign in | One dialog, one way: it opens Claude's sign-in page in a new tab, where the page itself offers a Claude account or SSO. The person pastes the code the page shows. On success the row's badge changes. |
| Terminal | New terminal asks which Claude (or + New Claude…), Claude Code or Shell, and the folder. The terminal page has a tab per terminal, showing which Claude each runs as, and a key row on phones ([Web app & PWA](web-app-pwa.md) §9.3). |
| New chat | Workspace, then Claude. Default is the last Claude this person used in that workspace, else Default. Without a pool, signed-out Claudes are listed but can't be picked; the hint says the session runs on the Claude's own sign-in, or links to sign one in when none is. With a pool, it says the session runs on the pool. |
| Session header | The current Claude's name. ⋯ → Move to another Claude… opens the dialog (FR9, FR10): each other Claude as a radio row ("Ready", or "Signed out", "Not ready", "Unreachable" with an ⓘ saying why and the way out), a switch "Ask <Claude> for a handoff" (on; off and explained when that Claude can't answer), and one line for what the move drops. Long explanations sit behind ⓘ. |
| After confirm | The dialog closes; the chat stays where it is. The composer reads "Default is writing the handoff…", then "Starting Work…"; nothing can be sent or queued. The list row shows "Moving". |
| Divider and card | One row "Moved to satria · 07:02" with the card "Context from Default · Handoff · 12 messages" under it. The card opens to the handoff, the conversation carried and the new Claude's acknowledgement. A move that didn't finish leaves one red line saying why. |
| Sessions list | One row per chat. Grouped by Claude, the chat is listed under its current Claude and, lighter, as "now on satria" under each earlier one; both open the same chat. |
| Usage | A chat that moved lists each run: the Claude, its turns and cost. |

Move is disabled while a move of this chat is in progress, for a chat that has ended, and for a chat whose workspace was removed.

## 12. Security

- Directories may contain a Claude login, written by Claude Code when the person signed in, in the terminal or from the portal. The portal never lists, reads, copies, or serves those files. FR4. Preflight and persona import keep refusing `.credentials.json` and `.claude.json`.
- A sign-in code passes through the portal once, to the stdin of that Claude's `claude auth login`. It is not stored or logged, and an error that quotes Claude Code's output shows `[code]` in its place. The sign-in link is shown only when it is https on an Anthropic host, so the portal never relays a lookalike.
- Status keeps `loggedIn` and `authMethod` only (FR21). Every `claude` command gets the directory as an argument checked against `claudes/<16 hex>`, never through shell parsing.
- The context file is redacted with the chat redactor before it is written. A handoff row stores the path and ids, not the summary body. The summary is not written to the portal log.
- Removing a Claude does not delete its directory (FR3), so a login on disk is not wiped by a portal action the person did not take in the terminal.
- A move cannot target another workspace id. The destination `claude_id` is checked to belong to the chat's workspace.
- The new run is a normal Claude Code session: its credential checks apply before anything changes (the pool's, or the destination Claude's sign-in). A move that fails them is refused and the chat is untouched. The handoff request is a portal-originated message (`portal:handoff`): it is recorded as the portal's, framed for Claude, and never shown as something the person typed. A tool request during the handoff turn is denied.
- The portal expects Claude Code's session id to change at a move and at no other time: the integrity check "a session id that changes ends the chat" reads the id of the current run, which the portal repoints before it reads the new run's log.

## 13. Testing

| Case | Expected |
| --- | --- |
| Two Claudes, two portal sessions | Each process environment names only its directory. A's transcript is not in B's directory. |
| Switch confirm cancel | No context file, no new process, the chat still live on its Claude. |
| Switch confirm | One session id before and after; a new Claude Code session id; two segments (the first `switched`); marker present; the earlier transcript intact; the opening sent to the new run; the old process stopped last. |
| Destination can't host a session | Refused before anything changes (409), the chat untouched, no process started or stopped. Shown in the dialog before the confirm. |
| The new Claude doesn't answer | The move is undone: the chat is on its old run again, never stopped, one segment, a row saying the move did not finish. |
| Handoff | The portal's request is `portal:handoff`; a tool request during it is denied; the document is in the file and the opening; a Claude that can't answer makes the move go ahead with the stored conversation and says why. |
| During a move | Send, control, end and delete are refused (409), a second move is refused, nothing is queued. |
| Switching back | A fresh Claude Code session on the earlier Claude, never a resume of the old one. |
| Cost | The chat's cost is the sum of its runs; usage rows keep the Claude of each turn. |
| Legacy pair | A database built the way the old code built a pair (two rows, linked) becomes one chat on upgrade: one transcript, summed cost, segments, aliases, the old id still opens it. |
| Other session in either Claude | Unchanged process and row. |
| Second writer | Open real session does not launch another `claude` for that id. |
| Destination workspace id | Rejected. |
| Context file and logs | A canary string that must be redacted is absent from the file, the API, and logs. A canary login file in the directory is never read. |
| Three workspaces | A move in one leaves the other two's session rows and processes alone. |
| New Claude | The directory is empty. No credential file is copied from another Claude or workspace. Create-session does not start a sign-in. |
| Claude list | Rows are portal sessions for that Claude. A process started only in the terminal is absent. |
| Sign in from the row | The link shown is the one Claude Code printed, on an Anthropic host. The code reaches the process and appears in no log, error, or API response. The badge turns signed in. Another Claude's status is unchanged. |
| Status | The API returns `loggedIn` and method only. No email, organization, or plan. |
| Pool assigned | Sign in, switch account, and sign out are refused (409). |
| Remove | Refused for Default, with a session not ended, or with a terminal running as it. After a remove, a new Claude can take the same name. The directory is still on disk. |
| Terminal as Claude B | `CLAUDE_CONFIG_DIR` in its process is B's directory. `claude auth status` there is B's, not Default's. |
| Chat without a pool | A session on a signed-in Claude starts with no `authcheck`, runs without the spending cap, and isn't ended by plan limits. Its transcript is in that Claude's directory. A signed-out Claude is refused (409) before anything runs. |
| Chat after a pool is assigned | Sessions on a sign-in end before the pool's keys take over; new ones run on the pool. |

🔬 Q2 is manual on the pinned Claude Code before the first milestone is called done.

## 14. Milestones

| Milestone | Scope |
| --- | --- |
| W1 | Claude registry, Default adoption, directory create, session `claude_id` on create and launch. No switch yet. **Built.** |
| W2 | Move a chat to another Claude as a switch of its Claude Code session (FR9 to FR18, v0.5). **Built** and run against real Claude Code 2.1.296 with the scripted stand-in API, in a Docker workspace on a pool: one chat id across the move; the handoff turn answered by the old Claude and carried in the opening (the stored opening's sha256 equals what the stand-in received, 13.1 and 13.5 KB); the new Claude acknowledged; the old process stopped last; a second move back started a fresh session; a move whose new Claude could not answer aborted after 60 s and the chat stayed usable on its old run; a chat resumed after a kill with its history; a database built by the earlier transfer code (four linked pairs) folded into one chat each on upgrade and resumed. Eligibility is asked before the confirm (switch options). Not tried: Kubernetes; a real model's handoff quality (the stand-in only shows what reaches the new Claude); a move with a running sub-agent (they stop with the old process and the dialog says so). |
| W1b | Claudes list with sign-in state, sign in, switch, sign out, rename, remove; terminals as a Claude. **Built**, tried on This machine. A second real account and tmux on Docker and Kubernetes not yet tried. |
| W3 | Kubernetes, the same paths on the home volume. |

## 15. Success

| | |
| --- | --- |
| A new Claude is usable for a portal session | Without a new workspace or a new volume |
| A's chats visible in B | Never, except the context the person confirmed |
| A running process changes directory | Never |
| A login file read or copied by the portal | Never, covered by the canary. A new directory starts empty, including for an account already signed in elsewhere. |
| A move that crosses workspaces | Never, rejected before a file is written |
| The open chat after a successful confirm | The same chat, still connected, one transcript, with the divider |

## 16. Open questions

| ID | Question |
| --- | --- |
| Q1 | Answered: in `~/.claude` and `~/.claude.json`, where Claude Code keeps them with no directory set. Default binds there without moving anything (FR2). |
| Q2 | Half answered (§10). 🔬 Open: managed settings, including `apiKeyHelper`, with a directory set, on the pinned workspace image. |
| Q3 | Answered by the owner (2026-10-12): yes, the Claude the chat runs on writes a handoff first, and it is the default (FR12), with a skip in the confirm and a fallback to the stored conversation when it can't answer. Checked with the stand-in API: events alone lose what only a tool result said and anything older than the 16,000-character opening; a handoff written with the whole conversation in view keeps both. What a real model writes was not judged. |
| Q4 | Should a removed Claude's directory ever be deleted, and only when the person types the Claude's name? Default in this draft is no. |
| Q5 | 🔬 Should tmux be in the workspace image? Installing it on first use needs root in the workspace, which Docker and Kubernetes images may not give. |
