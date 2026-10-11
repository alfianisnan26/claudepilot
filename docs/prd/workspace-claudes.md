# PRD: Workspace Claudes

| | |
| --- | --- |
| Status | **Draft v0.3.** v0.3 follows what was built: the portal can start each Claude's own sign-in and shows whether it's signed in (status and method only, FR4, FR21); terminals run as a Claude (FR22); removing a Claude waits for its terminals and frees its name (FR3); the Claudes list sits on the workspace (§11). Q1 answered, Q2 half answered. v0.2 stated who writes the context file, that a new directory is unsigned-in, and that the Claude list is portal sessions only. 🔬 = unverified, listed in §16. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-11 |
| Depends on | [Chat sessions](chat-sessions.md) (session controller, event store, one writer, eligibility), [Account Pool](account-pool.md) (the only credentials a portal session runs on), [Pools foundation](foundation-pools.md) (the workspace home volume) |
| Related | [Web app & PWA](web-app-pwa.md) (session screen), [Monitoring dashboard](monitoring-dashboard.md) (session list) |

## 1. Summary

A workspace is one VM and one volume. On that volume a person can keep several Claudes. Each Claude has its own directory, so its chats and its local login stay apart from the others. Portal chat sessions still belong to the workspace. Opening one includes choosing which Claude it runs in.

Moving work is a context transfer, asked for by the person. The portal writes a context file from its own event store onto that same volume, the source stops being the live thread, and a new session starts in the other Claude. The open portal thread follows the new session and marks the join. Other chats, other workspaces, and every login stay where they are. Creating a Claude does not sign it in.

Each Claude also has its own Claude Code login for the terminal. The workspace lists its Claudes with whether each is signed in, and from there a person signs one in, switches its account, signs it out, or opens terminals that run as it. Claude Code does the sign-in in that Claude's directory. The portal shows the link and passes on the code, and keeps neither the code nor the login. Portal chat never runs on such a login: it stays on the account pool.

## 2. Background and problem

- A portal chat session is one Claude Code process in one workspace. The workspace has one home, so it has one Claude: one transcript store and one local login.
- People want more than one Claude on that machine without a second VM or a second volume. Two terminals in the same home are not two Claudes. They share the login and the chats.
- A long thread sometimes should continue under another Claude on the same machine. Carrying it by hand means copying a summary and starting over, and the portal thread stays on the session that was left.
- After a move, the source session is easy to lose. It is no longer the thread on screen, but it is still a session in that Claude, and someone may still want to open it or move it.

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **One volume per workspace.** Several Claudes live on the workspace home volume. No extra volume is assigned, and nothing is shared with another workspace. |
| G2 | **Real isolation.** Each Claude has its own directory. Its process is started with that directory. Logins and chats do not cross directories. |
| G3 | **Portal sessions stay on the workspace.** A session row names the workspace and the Claude it runs in. The workspace list and the eligibility rules do not change. |
| G4 | **Choose the Claude.** New chat on a workspace asks which Claude to start. A session already open can be switched only by a confirmed transfer. |
| G5 | **Context move, on request.** The person confirms. The source stops being the live thread. A new session in the destination Claude starts from a context file. The open view follows it. |
| G6 | **Nothing stale is hidden.** Each Claude lists the sessions in it, including ones left behind by a transfer. A left-behind session can be opened or transferred. |
| G7 | **One writer.** The live portal thread is the only writer of a Claude session. Opening it does not start a second writer. |

## 4. Non-goals

- **A quota switch.** Nothing watches a plan window or an API-key headroom and moves a session. Account Pool failover stays [Account Pool](account-pool.md). This PRD does not choose another login when usage runs low.
- **Rotating or pooling Claude plan logins.** The portal does not store, copy, inject, rotate, or select SSO or other subscription credentials, and never runs a portal chat on one. It may start Claude Code's own sign-in in a Claude's directory (FR4). Claude Code writes that login there. The portal never reads it.
- **A second workspace as the destination.** A transfer stays inside one workspace. Three workspaces are three volumes. Their disks are not mounted into each other.
- **tmux as isolation.** tmux keeps a terminal running without a browser. It does not separate Claudes. A terminal is a Claude by the directory it was started with (FR22). Two shells with one directory are one Claude.
- **Hot-swapping a running process.** The open process keeps the directory it started with until that session stops. The continuation is a new session id.
- **Parsing Claude Code's own transcript files.** The context file is built from the portal's event store, which [Chat sessions](chat-sessions.md) already keeps. The portal does not open `~/.claude/projects`, `~/.claude/sessions/*.key`, or `.credentials.json`.
- **Merging two live threads.** A transfer does not splice two running sessions into one process.

## 5. Users and stories

**Workspace user** chats in a workspace and sometimes keeps more than one Claude there. **Admin** is often the same person.

| ID | Story |
| --- | --- |
| US1 | I add a second Claude to a workspace. It gets its own directory on that workspace's volume. The first Claude's chats are unchanged. |
| US2 | I start a portal chat and pick Claude A or Claude B. The session runs in the one I picked. |
| US3 | I keep chatting in Claude A and, separately, in Claude B. Neither thread appears in the other Claude. |
| US4 | On an open chat I choose Switch, pick the other Claude, and confirm. I am told this session will stop being the live thread and a new one will start. After I confirm, the view follows the new session and shows that it came from a transfer. |
| US5 | I open the Claude I left. The session I moved is listed there as left behind. I can open it, or transfer it again. |
| US6 | I open the real session the thread is tailing. It is that same session, not a second one writing beside it. |
| US7 | I have three workspaces. A move in one of them does not appear in the other two, and their Claudes keep running. |
| US8 | I create a Claude, including a second one on this workspace or the same account on another workspace. Its directory is empty. I sign it in from its row on the workspace, or in a terminal running as it. Opening a portal chat does not ask. |
| US9 | The list on a Claude shows the portal sessions that ran there, including ones left behind. A shell I started myself in the terminal is not on that list. |
| US10 | On a workspace I see each Claude: signed in or not, and whether with a Claude account or a Console key, and how many terminals run as it. From its row I sign it in, switch its account, sign it out, rename it, or remove it. |
| US11 | I open several terminals on one workspace, each as a Claude I pick. Claude Code in each one uses that Claude's login, and keeps running after I close the browser. |

## 6. Scope boundary

| Allowed | Not allowed |
| --- | --- |
| Several named Claudes on one workspace volume, each a directory the portal created and starts processes with. | Copying a directory in order to move a login. Reading a directory to discover which account or plan is signed in. |
| A portal session on a Claude while the workspace's Account Pool assignment is active and Synced, with the same `apiKeyHelper` checks as [Chat sessions](chat-sessions.md) §6. | A portal session whose credential is a plan login, including one stored in a Claude directory. |
| A person using the workspace terminal in a Claude directory, including a sign-in Claude performed there. | Starting a terminal with a directory other than the Claude picked for it. |
| The portal starting Claude Code's own `claude auth login` or `claude auth logout` with a Claude's directory, showing the sign-in link it prints, and writing the code the person pastes to that process. | Storing or logging that code or the login it produces, reading the directory's files, or running a portal chat session on that login. |
| Showing whether a Claude is signed in and by which method, from `claude auth status` run with its directory. | Showing or keeping the account, email, organization, or plan behind it. |
| A context file of redacted portal events, written on the same volume, then read as the opening context of a new portal session. | Putting a key, a token, or a credential file into the context file. |
| Listing portal sessions by the Claude they ran in, including sessions ended by a transfer. | Treating a left-behind session as still the live writer, or resuming its process inside the destination directory. |

Managed settings for the workspace stay workspace-wide (`/etc/claude-code/managed-settings.d`). Every portal session in every Claude of that workspace uses the workspace's account-pool helper. Separate directories do not create a second billed account for portal chat. They separate chats, local settings, and whatever login a person has in that directory for the terminal. While a pool is assigned its keys replace own sign-ins, so sign-in, switch, and sign-out are refused until it is unassigned.

## 7. Solution overview

```
 Workspace volume (/home/node)                         Portal
 ┌──────────────────────────────────────────────┐     ┌──────────────────────────────┐
 │ claudes/a/   login and chats of Claude A     │     │ session row                  │
 │ claudes/b/   login and chats of Claude B     │◀────│   workspace_id               │
 │ transfer/<id>.md   context file, no login    │     │   claude_id                  │
 │                                              │     │   predecessor_id, successor  │
 │ cp-session started with that Claude's        │     │ event store → context file   │
 │ directory. One writer per live session.      │     │ confirm → stop → new session │
 └──────────────────────────────────────────────┘     └──────────────────────────────┘

 Workspace 1 volume  │  Workspace 2 volume  │  Workspace 3 volume
 no path between them. A transfer never crosses the bar.
```

1. **Registry.** The portal stores the Claude's name and directory id. The directory is created on the workspace volume. The existing home Claude is adopted as the first one, named Default, so sessions that already exist keep their place (🔬 Q1).
2. **Launch.** A portal session records `claude_id`. The host starts `claude` with that directory. Chat sessions' eligibility, auth check, and usage check run unchanged.
3. **Transfer.** On confirm, the controller builds a context file from the portal event store, ends the source as transferred, starts a new session in the destination Claude whose first message is that context, and points the source at the successor.
4. **Tail.** The open client, on the successor id, loads the new session and keeps streaming. The first row is the transfer marker.
5. **Audit.** Sessions for a workspace group by Claude. A transferred source stays listed on its Claude as left behind.
6. **Sign-in and terminals.** The workspace lists its Claudes with their sign-in state. A sign-in runs Claude Code's own `claude auth login` with that Claude's directory. A terminal is a tmux session started with that directory, running `claude` or a shell.

## 8. Functional requirements

### Claudes

- **FR1** A workspace has one or more Claudes. Creating one asks for a name, unique among that workspace's Claudes that are not removed (409 on a duplicate). The portal creates an empty directory on the home volume and stores the name, directory id, and creation time. It does not copy another Claude's directory.
- **FR2** The first Claude on a workspace is Default, bound to where Claude Code keeps its files with no directory set (`~/.claude` and `~/.claude.json`), so existing sessions and an existing login stay put (Q1). New Claudes get a new directory, `~/.claudepilot/claudes/<16 hex>` in the workspace home (`/home/node` in a container, the person's home on This machine).
- **FR3** Renaming a Claude changes the label only, with the same uniqueness as FR1. Removing a Claude is refused for Default, while it has a session that is not ended, and while a terminal runs as it. Removing one with only ended sessions keeps those rows and marks the Claude removed. Its name is free again for a new Claude. The directory is left on the volume. The portal does not delete a directory that may hold a login.
- **FR4** A Claude has no credential fields. The API never returns, accepts, or logs the contents of its directory. Creating one does not sign it in and does not copy a login from another Claude or another workspace. The directory starts empty. Each Claude signs in on its own, including when that same account is already signed in elsewhere, in one of two ways: in a terminal running as it (FR22), or from its row on the workspace. From the row, the portal runs `claude auth login` with that directory, shows the link Claude Code prints (only an https link on claude.com, claude.ai, or anthropic.com), and writes the code the person pastes to that process. The code is held only until it is written, never stored or logged. Claude Code writes the login into the directory. Switch account is the same sign-in over the existing one. Sign out runs `claude auth logout` with that directory. These three are refused while the workspace has an account pool (§6). Opening or transferring a portal chat does not ask for a sign-in: portal chat uses the workspace account pool.

### Sign-in state and terminals

- **FR21** The workspace lists its Claudes that are not removed, each with its sign-in state from `claude auth status --json` run with its directory. Only `loggedIn` and `authMethod` are kept. When the command fails the state shows as unknown, not as signed out.
- **FR22** A terminal is a tmux session on the workspace, started as one Claude (`CLAUDE_CONFIG_DIR` set to its directory, unset for Default) in a folder the person picks, running `claude` or a shell. A workspace has at most 8. Terminals keep running without a browser. Closing one ends what runs in it. The terminal list names the Claude each runs as. tmux and Claude Code are installed on first use when missing.
- **FR23** A terminal is not a portal session. It is not on a Claude's session list (FR20), it is not one of the writers FR8 counts, and the portal does not read what runs in it.

### Portal sessions

- **FR5** Creating a portal session requires a `claude_id` on that workspace. Omitted, the workspace's Default is used. The session row stores it. The host process is started with that directory and no other Claude's directory.
- **FR6** A session keeps its `claude_id` for its whole life. Resume, wake, and steer use the same directory. There is no control that points the running process at another directory.
- **FR7** Eligibility is unchanged and still per workspace: an active, Synced account pool, `authcheck` pass, and `apiKeySource: "apiKeyHelper"` each turn. A failure ends or refuses the session the way [Chat sessions](chat-sessions.md) §6 already does. The portal does not inspect the Claude directory to explain the failure.
- **FR8** One writer per session, the existing `run.lock`. Opening the real session from the Claude list opens this session. It does not launch a second process for the same id.

### Transfer

- **FR9** Switch is available on a portal session whose workspace has at least one other Claude that is not removed. The control lists those Claudes by name. It does not list other workspaces.
- **FR10** Confirm copy states that this session will stop being the live thread, a new session will start on the named Claude, and the view will follow. Cancel leaves the session untouched. Confirm is required every time. There is no "always switch" setting.
- **FR11** On confirm the controller, in order: refuses if a transfer for this session is already running; stops the source at a turn boundary when it is working, or immediately when it is idle, interrupted, or left behind; writes the context file; creates the successor session in the destination Claude; stores predecessor and successor ids; marks the source `transferred`. If creating the successor fails, the source stays ended as transferred and the error names the context file so a later transfer of that left-behind session can retry. The source process is not started again in the destination directory.
- **FR12** The context file contains the handoff id, time, workspace id, source session id, source and destination Claude names, and a summary built from the portal's stored events after redaction. It contains no credential, no `apiKeyHelper` path, and no environment values. It is written only under `/home/node/.claudepilot/transfer/`.
- **FR13** The successor's first message is the context file, presented as prior context from the named Claude, not as a user message the person just typed. The session id is new. `--resume` is not used for the successor.
- **FR14** The open client follows `successor_id` and subscribes to that session. The first visible row is a marker: new session, destination Claude name, transferred at that time. The source transcript remains readable on the source session.
- **FR15** A session already transferred can be transferred again from the Claude list. That creates another successor from the same context rules. It does not revive the process that was stopped.
- **FR16** A transfer does not move, end, or retarget any other session in either Claude.

### Audit

- **FR17** The workspace's session list can group by Claude. Each Claude shows portal sessions: running ones, and left-behind ones (ended by transfer). Left-behind rows show the time and the successor, and offer Open and Transfer.
- **FR20** That list is portal sessions only. A process the person started in the terminal is not a row. It stays in the Claude directory, and the portal does not read Claude's own session index to find it.
- **FR18** Open on a live session is FR8. Open on a left-behind session shows its transcript and the marker of where it was transferred, and does not resume the process unless the person explicitly resumes that same session in the same Claude. Resume stays in the source directory.

## 9. Data model

Columns added to the chat session row, and one new table. Secrets are not among them.

| Store | Fields |
| --- | --- |
| `workspace_claudes` | id, workspace_id, name (unique per workspace among rows with no removed_at), directory (`claudes/<id>`, empty for the adopted Default), removed_at, created_at |
| `chat_sessions` | existing columns, plus `claude_id`, `predecessor_id` null, `successor_id` null, `ended_reason` including `transferred` |
| `claude_handoffs` | id, workspace_id, source_session_id, successor_session_id null until created, source_claude_id, dest_claude_id, path of the context file, created_at, actor |

`claude_id` is required for sessions created after this ships. Sessions from before it are read as the workspace's Default Claude (FR2).

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
| New Claude | A name only. The directory is empty and the row shows Signed out. Sign in from the row or in its terminal, including for an account already used elsewhere. Portal chat does not ask. |
| Sign in | One dialog, one way: it opens Claude's sign-in page in a new tab, where the page itself offers a Claude account or SSO. The person pastes the code the page shows. On success the row's badge changes. |
| Terminal | New terminal asks which Claude (or + New Claude…), Claude Code or Shell, and the folder. The terminal page has a tab per terminal, showing which Claude each runs as, and a key row on phones ([Web app & PWA](web-app-pwa.md) §9.3). |
| New chat | Workspace, then Claude. Default is the last Claude this person used in that workspace, else Default. |
| Session header | Claude name. Switch opens the confirm dialog (FR10). One other Claude is a single confirm. More than one asks which, then confirm. |
| After confirm | The thread shows "Moving to Claude B" until the successor exists, then tails. Failure stays on the source and says the move did not finish. |
| Marker | First row of the successor: "New session on Claude B · transferred from Claude A · 14:02". |
| Claude list | Reached from the workspace's sessions. One group per Claude. Running rows and left-behind rows. Open and Transfer on a left-behind row. |
| Real session | The session screen for that id. When it is the live successor, it is the same screen the tail already opened. |

Switch is disabled while a transfer of this session is in progress, while the workspace is in a credential-transition lock, and while the session has already ended for a reason other than `transferred`. A `transferred` session offers Transfer only from the Claude list (FR15), not a second Switch on a dead composer.

## 12. Security

- Directories may contain a Claude login, written by Claude Code when the person signed in, in the terminal or from the portal. The portal never lists, reads, copies, or serves those files. FR4. Preflight and persona import keep refusing `.credentials.json` and `.claude.json`.
- A sign-in code passes through the portal once, to the stdin of that Claude's `claude auth login`. It is not stored or logged, and an error that quotes Claude Code's output shows `[code]` in its place. The sign-in link is shown only when it is https on an Anthropic host, so the portal never relays a lookalike.
- Status keeps `loggedIn` and `authMethod` only (FR21). Every `claude` command gets the directory as an argument checked against `claudes/<16 hex>`, never through shell parsing.
- The context file is redacted with the chat redactor before it is written. A handoff row stores the path and ids, not the summary body. The summary is not written to the portal log.
- Removing a Claude does not delete its directory (FR3), so a login on disk is not wiped by a portal action the person did not take in the terminal.
- A transfer cannot target another workspace id. The destination `claude_id` is checked to belong to the source session's workspace.
- The successor is a normal portal session: account-pool checks apply before it starts. A transfer into a workspace that has lost its pool fails the create, and the source remains the left-behind session with the context file in place.

## 13. Testing

| Case | Expected |
| --- | --- |
| Two Claudes, two portal sessions | Each process environment names only its directory. A's transcript is not in B's directory. |
| Switch confirm cancel | No context file, no successor, source still live. |
| Switch confirm | Source ended `transferred`, successor id set both ways, client subscribed to the successor, marker present, first message is the context. |
| Successor fails eligibility | Source ended `transferred`, no successor id, error returned, context file present, Transfer offered on the left-behind row. |
| Other session in either Claude | Unchanged process and row. |
| Second writer | Open real session does not launch another `claude` for that id. |
| Destination workspace id | Rejected. |
| Context file and logs | A canary string that must be redacted is absent from the file, the API, and logs. A canary login file in the directory is never read. |
| Three workspaces | A transfer in one leaves the other two's session rows and processes alone. |
| New Claude | The directory is empty. No credential file is copied from another Claude or workspace. Create-session does not start a sign-in. |
| Claude list | Rows are portal sessions for that Claude. A process started only in the terminal is absent. |
| Sign in from the row | The link shown is the one Claude Code printed, on an Anthropic host. The code reaches the process and appears in no log, error, or API response. The badge turns signed in. Another Claude's status is unchanged. |
| Status | The API returns `loggedIn` and method only. No email, organization, or plan. |
| Pool assigned | Sign in, switch, and sign out are refused (409). |
| Remove | Refused for Default, with a session not ended, or with a terminal running as it. After a remove, a new Claude can take the same name. The directory is still on disk. |
| Terminal as Claude B | `CLAUDE_CONFIG_DIR` in its process is B's directory. `claude auth status` there is B's, not Default's. |

🔬 Q2 and Q3 are manual on the pinned Claude Code before the first milestone is called done.

## 14. Milestones

| Milestone | Scope |
| --- | --- |
| W1 | Claude registry, Default adoption, directory create, session `claude_id` on create and launch. No switch yet. **Built.** |
| W2 | Confirm, context file, successor, tail, marker, left-behind list, transfer again. **Built**, not yet run end to end on a workspace. |
| W1b | Claudes list with sign-in state, sign in, switch, sign out, rename, remove; terminals as a Claude. **Built**, tried on This machine. A second real account and tmux on Docker and Kubernetes not yet tried. |
| W3 | Kubernetes, the same paths on the home volume. |

## 15. Success

| | |
| --- | --- |
| A new Claude is usable for a portal session | Without a new workspace or a new volume |
| A's chats visible in B | Never, except the context the person confirmed |
| A running process changes directory | Never |
| A login file read or copied by the portal | Never, covered by the canary. A new directory starts empty, including for an account already signed in elsewhere. |
| A transfer that crosses workspaces | Never, rejected before a file is written |
| The open thread after a successful confirm | On the successor, with the marker |

## 16. Open questions

| ID | Question |
| --- | --- |
| Q1 | Answered: in `~/.claude` and `~/.claude.json`, where Claude Code keeps them with no directory set. Default binds there without moving anything (FR2). |
| Q2 | Half answered (§10). 🔬 Open: managed settings, including `apiKeyHelper`, with a directory set, on the pinned workspace image. |
| Q3 | 🔬 Is the portal event store enough to rebuild a useful opening context for a long session, or does the source session need one explicit summarize turn before it is stopped? The summarize turn would be portal-sent input, not a read of Claude's transcript. |
| Q4 | Should a removed Claude's directory ever be deleted, and only when the person types the Claude's name? Default in this draft is no. |
| Q5 | 🔬 Should tmux be in the workspace image? Installing it on first use needs root in the workspace, which Docker and Kubernetes images may not give. |
