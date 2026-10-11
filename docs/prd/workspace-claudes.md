# PRD: Workspace Claudes

| | |
| --- | --- |
| Status | **Draft v0.1.** No lab marks yet. 🔬 = unverified, listed in §16. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-11 |
| Depends on | [Chat sessions](chat-sessions.md) (session controller, event store, one writer, eligibility), [Account Pool](account-pool.md) (the only credentials a portal session runs on), [Pools foundation](foundation-pools.md) (the workspace home volume) |
| Related | [Web app & PWA](web-app-pwa.md) (session screen), [Monitoring dashboard](monitoring-dashboard.md) (session list) |

## 1. Summary

A workspace is one VM and one volume. On that volume a person can keep several Claudes. Each Claude has its own directory, so its chats and its local login stay apart from the others. Portal chat sessions still belong to the workspace. Opening one includes choosing which Claude it runs in.

Moving work is a context transfer, asked for by the person. The source session writes a context file on that same volume, stops being the live thread, and a new session starts in the other Claude. The open portal thread follows the new session and marks the join. Other chats, other workspaces, and every login stay where they are.

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
- **Rotating or pooling Claude plan logins.** The portal does not collect, store, copy, inject, or select SSO or other subscription credentials. A directory may hold a login Claude wrote there. The portal never reads it.
- **A second workspace as the destination.** A transfer stays inside one workspace. Three workspaces are three volumes. Their disks are not mounted into each other.
- **tmux as isolation.** A terminal multiplexer can show a shell. It does not separate Claudes. Two shells in one directory are one Claude.
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

## 6. Scope boundary

| Allowed | Not allowed |
| --- | --- |
| Several named Claudes on one workspace volume, each a directory the portal created and starts processes with. | Copying a directory in order to move a login. Reading a directory to discover which account or plan is signed in. |
| A portal session on a Claude while the workspace's Account Pool assignment is active and Synced, with the same `apiKeyHelper` checks as [Chat sessions](chat-sessions.md) §6. | A portal session whose credential is a plan login, including one stored in a Claude directory. |
| A person using the workspace terminal in a Claude directory, including a sign-in Claude performed there. | The portal starting that sign-in, storing the result, or switching the terminal from one login to another. |
| A context file of redacted portal events, written on the same volume, then read as the opening context of a new portal session. | Putting a key, a token, or a credential file into the context file. |
| Listing portal sessions by the Claude they ran in, including sessions ended by a transfer. | Treating a left-behind session as still the live writer, or resuming its process inside the destination directory. |

Managed settings for the workspace stay workspace-wide (`/etc/claude-code/managed-settings.d`). Every portal session in every Claude of that workspace uses the workspace's account-pool helper. Separate directories do not create a second billed account for portal chat. They separate chats, local settings, and whatever login a person has in that directory for the terminal.

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

## 8. Functional requirements

### Claudes

- **FR1** A workspace has one or more Claudes. Creating one asks for a name, unique among that workspace's Claudes (409 on a duplicate). The portal creates an empty directory on the home volume and stores the name, directory id, and creation time. It does not copy another Claude's directory.
- **FR2** The first Claude on a workspace that already has sessions is Default, bound to the directory those sessions already use (🔬 Q1). New Claudes get a new directory under `/home/node/.claudepilot/claudes/<id>`.
- **FR3** Renaming a Claude changes the label only. Removing a Claude is refused while it has a session that is not ended. Removing one with only ended sessions keeps those rows and marks the Claude removed. The directory is left on the volume. The portal does not delete a directory that may hold a login.
- **FR4** A Claude has no credential fields. The API never returns, accepts, or logs the contents of its directory.

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

- **FR17** The workspace's session list can group by Claude. Each Claude shows running sessions and left-behind ones (ended by transfer). Left-behind rows show the time and the successor, and offer Open and Transfer.
- **FR18** Open on a live session is FR8. Open on a left-behind session shows its transcript and the marker of where it was transferred, and does not resume the process unless the person explicitly resumes that same session in the same Claude. Resume stays in the source directory.

## 9. Data model

Columns added to the chat session row, and one new table. Secrets are not among them.

| Store | Fields |
| --- | --- |
| `workspace_claudes` | id, workspace_id, name, directory (`claudes/<id>` or the adopted default), removed_at, created_at |
| `chat_sessions` | existing columns, plus `claude_id`, `predecessor_id` null, `successor_id` null, `ended_reason` including `transferred` |
| `claude_handoffs` | id, workspace_id, source_session_id, successor_session_id null until created, source_claude_id, dest_claude_id, path of the context file, created_at, actor |

`claude_id` is required for sessions created after this ships. Sessions from before it are read as the workspace's Default Claude (FR2).

The context file is not a database blob. The row stores its path. The file lives on the workspace volume so a stopped workspace still has it when it starts.

## 10. Isolation

| Boundary | Separates | Does not separate |
| --- | --- | --- |
| Workspace volume | This VM from every other workspace. The home volume is the one the runtime already mounts at `/home/node`. | Claudes inside the VM. |
| Claude directory | That Claude's chats, local settings, and any login Claude has written there. The process environment names this directory and no other. | The workspace's managed settings, account-pool helper, persona, skills, and MCP sets. Those stay workspace-wide. |
| tmux or a second shell | Nothing, unless the shell's process was started with a different Claude directory. | — |

A path in one Claude's directory is not a cwd the portal will start another Claude's session in. File tools in a session stay subject to [Chat sessions](chat-sessions.md) path rules. The transfer directory is not a chat cwd.

🔬 Q2: the pinned Claude Code honors the directory for transcripts, memory, and `~/.claude.json` of that process, and still loads `/etc/claude-code/managed-settings.d`.

## 11. What the person sees

Phone and desktop use the existing session screen.

| Place | What it shows |
| --- | --- |
| New chat | Workspace, then Claude. Default is the last Claude this person used in that workspace, else Default. |
| Session header | Claude name. Switch opens the confirm dialog (FR10). One other Claude is a single confirm. More than one asks which, then confirm. |
| After confirm | The thread shows "Moving to Claude B" until the successor exists, then tails. Failure stays on the source and says the move did not finish. |
| Marker | First row of the successor: "New session on Claude B · transferred from Claude A · 14:02". |
| Claude list | Reached from the workspace's sessions. One group per Claude. Running rows and left-behind rows. Open and Transfer on a left-behind row. |
| Real session | The session screen for that id. When it is the live successor, it is the same screen the tail already opened. |

Switch is disabled while a transfer of this session is in progress, while the workspace is in a credential-transition lock, and while the session has already ended for a reason other than `transferred`. A `transferred` session offers Transfer only from the Claude list (FR15), not a second Switch on a dead composer.

## 12. Security

- Directories may contain a Claude login the person created in the terminal. The portal never lists, reads, copies, or serves those files. FR4. Preflight and persona import keep refusing `.credentials.json` and `.claude.json`.
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

🔬 Q2 and Q3 are manual on the pinned Claude Code before the first milestone is called done.

## 14. Milestones

| Milestone | Scope |
| --- | --- |
| W1 | Claude registry, Default adoption, directory create, session `claude_id` on create and launch. No switch yet. |
| W2 | Confirm, context file, successor, tail, marker, left-behind list, transfer again. |
| W3 | Kubernetes, the same paths on the home volume. |

## 15. Success

| | |
| --- | --- |
| A new Claude is usable for a portal session | Without a new workspace or a new volume |
| A's chats visible in B | Never, except the context the person confirmed |
| A running process changes directory | Never |
| A login file read by the portal | Never, covered by the canary |
| A transfer that crosses workspaces | Never, rejected before a file is written |
| The open thread after a successful confirm | On the successor, with the marker |

## 16. Open questions

| ID | Question |
| --- | --- |
| Q1 | 🔬 Where do this workspace's existing sessions store their files today, and is that path safe to bind as Default without moving it? |
| Q2 | 🔬 On the pinned Claude Code, does the per-process directory isolate transcripts and memory while managed settings, including `apiKeyHelper`, still apply? |
| Q3 | 🔬 Is the portal event store enough to rebuild a useful opening context for a long session, or does the source session need one explicit summarize turn before it is stopped? The summarize turn would be portal-sent input, not a read of Claude's transcript. |
| Q4 | Should a removed Claude's directory ever be deleted, and only when the person types the Claude's name? Default in this draft is no. |
