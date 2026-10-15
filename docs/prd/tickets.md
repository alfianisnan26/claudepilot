# PRD: Tickets

| | |
| --- | --- |
| Status | **v0.2, built** (2026-10-12). One queue of work that people and agents share, with agent sessions, priorities, summaries, tags and types, where anything a person asks for, and anything an agent needs from a person, is an open ticket. Tables, rules, REST, the tools, the Tickets page (list, board, detail, dialogs), starting a session for a ticket and the CI checks are built; the agent path was checked with Claude Code 2.1.296 inside a Docker workspace. Agents authenticate with the per-session token of [Portal MCP](portal-mcp.md) §12.6. A session started from a ticket in the UI was checked end to end with a real Claude Code in a Docker workspace. Not yet: the nav count, push (worktrees are there: `startSession` passes them and the Start dialog has "Own git worktree", checked 2026-10-12). Status per milestone: §14. 🔬 = unverified, listed in §17. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-13 |
| Depends on | [Chat sessions](chat-sessions.md) (starting a session for a ticket, the actor on a portal message, session state), [Portal MCP](portal-mcp.md) (the tools agents and scripts use, tokens, audit, the sanitizer) |
| Related | [Workspace Claudes](workspace-claudes.md) (which Claude runs the session), [MCP set pool](mcpset-pool.md) (how an agent gets the ticket tools in a workspace), [Monitoring dashboard](monitoring-dashboard.md) (attention counts), [Web app & PWA](web-app-pwa.md) (push) |

## 1. Summary

The portal gets one queue for work. A ticket says what needs doing: a type, a priority, a one-line summary, a Markdown description, tags, a status, who reported it and who it is assigned to. The assignee is either an agent session or a person. A person's request is an open ticket, and so is whatever an agent needs from a person (an approval, an answer, a decision), assigned to that person.

People work the queue in the portal's Tickets page: a list and a board with filters, a detail page with a timeline, and an action that starts a session for a ticket, optionally in a git worktree of its own, sending the ticket as the session's opening message labelled `ticket:<id>`. Agents work it through the Portal MCP: list and search, read, create, comment, update, claim the next ticket by priority and tags, and close with a summary. An agent changes only tickets assigned to it, and it can always create one.

Ticket text is untrusted input. It is stored with secrets removed and invisible characters stripped, rendered as Markdown without raw HTML, and handed to a model only labelled as untrusted text. A ticket never carries a credential and never grants an agent anything: it is a request, and the portal's guards decide what happens next.

## 2. Background and problem

- Work reaches agents by someone typing into a chat. The request lives in one transcript, nobody sees what is queued, and a second agent can't pick up what the first left.
- An agent that needs a person's decision can only stop and wait in its session. Nothing says what it needs or who should answer, and the answer isn't kept anywhere but the transcript.
- Several agents on several workspaces have no shared list of what is being done, by which session, in which worktree, and what came of it.
- Closing the loop is manual: after an agent finishes, a person has to remember to read the result and say it is done.

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **One queue.** Every request, from a person or an agent, is a ticket with a type, priority, summary, description, tags and a status, in one list. |
| G2 | **Agents and people both assign and work.** The assignee is an agent session or a person. An unassigned ticket is open to the agents; one assigned to a person waits for that person. |
| G3 | **Human requests are tickets.** What a person asks for, and what an agent needs from a person, is an open ticket. The page shows "Needs you" at a glance. |
| G4 | **A session per ticket.** A person starts a session for a ticket from its page, optionally in its own worktree. The opening message is the ticket, labelled with its actor. The session page links back. |
| G5 | **Agents over MCP, tightly scoped.** Tools to list, read, create, comment, update, claim and close. An agent changes only tickets assigned to it (or created by it), and sees only its own workspace's tickets and the unassigned queue. |
| G6 | **A timeline that can be trusted.** Every change is an entry: who (a person, a session, a token, the portal), what and when. Nothing is edited in place without leaving one. |
| G7 | **Untrusted text stays inert.** Ticket text can't carry a secret in, can't hide characters, and reaches a model only labelled. |

## 4. Non-goals

- **A project-management suite.** No sprints, estimates, boards per project, SLAs, custom fields or workflows. Status, priority, type and tags are the model.
- **Per-user identity and permissions.** The portal has one shared sign-in. A person assignee is a label until per-user identity exists ([Portal MCP](portal-mcp.md) §12.5).
- **Automation that acts on a ticket by itself.** Nothing starts a session, assigns, or closes a ticket without a person's click or an agent's own tool call. A ticket in the agents' queue waits until an agent claims it. **Amended 2026-10-12** ([Triggers](triggers.md), owner decision O3): a trigger that a person created is the one exception. Its owner, limits and approval rules stand in for the click: it creates tickets (in the queue, or assigned to its owner) and may start a session on one, and does nothing else (it never reassigns, edits or closes).
- **An external tracker.** No sync with GitHub Issues, Linear or Jira. Links to them are text in a description.
- **Notifications outside the portal.** Push and email for "needs you" follow the Web app PRD's notification work (Q3). Answered 2026-10-12: [Web app & PWA](web-app-pwa.md) §11 sends the kind `human_request` (a ticket assigned to a person by an agent, a trigger or the portal) over Web Push, a signed webhook, Discord and Slack; email is not planned.
- **Files and images on tickets.** Text only in v1.

## 5. Users and stories

**Admin**: signs in to the portal; also the person tickets are assigned to. **Agent**: a Claude Code session in a workspace, with the portal's ticket tools through its own session token. **Script**: an admin's token over MCP.

| ID | Story |
| --- | --- |
| US1 | As an admin, I write down what I want done (a bug, a feature, a question) with a priority and tags. It joins the queue as an open ticket. |
| US2 | I open the Tickets page and see what is open, in progress, blocked and waiting for me, as a list or a board, filtered by status, priority, type, tag or assignee. |
| US3 | I open a ticket, read its description and timeline, and start a session for it on a workspace, in a worktree of its own. The session opens with the ticket as its first message and I see "From ticket T-12" on it. The ticket shows the session, and the session shows the ticket. |
| US4 | An agent working a ticket comments its progress, marks it blocked when it needs something, and closes it with a summary. I see each step on the timeline. |
| US5 | An agent needs my approval to delete a branch. It creates a ticket of type approval assigned to me, with what it will do and why. I find it under "Needs you", answer in a comment, and close it. The agent reads the answer. |
| US6 | I leave several tickets unassigned with the tag `frontend`. An agent calls `ticket_claim_next` with that tag and gets the most urgent one, which is now assigned to its session and in progress. Two agents never get the same ticket. |
| US7 | An agent in one workspace can't read or change another workspace's tickets, and can't change a ticket assigned to someone else. |
| US8 | A session ends without closing its ticket. The ticket still says in progress and shows that its session ended, so I can restart it or reassign it. |
| US9 | I paste a ticket's text from an agent into nothing: whatever the ticket says, it can't make an agent run a command, because it is shown to the model as untrusted text and starting a session is my click. |

## 6. Scope boundary

| Allowed | Not allowed |
| --- | --- |
| People create, edit, assign, comment on, start sessions for, close, reopen and delete tickets in the portal. | A ticket granting access: no token, credential, approval or permission is created or implied by one. An "approval" ticket records a person's answer; it does not itself approve anything. |
| Agents (a session's own token) create tickets, read the unassigned queue and their workspace's tickets, claim, comment on, update and close the ones assigned to them (or that they created and nobody else holds). | An agent changing a ticket assigned to another session or a person, reading another workspace's tickets, deleting a ticket, or reopening a closed one. |
| A script with an operate-scope token does everything an agent may, without a workspace limit. | Starting a session from a ticket over MCP unless session control is on and the token is admin ([Portal MCP](portal-mcp.md) §13.3). |
| Ticket text of any length up to the caps (§11), as Markdown. | Raw HTML, images, scripts or secrets in ticket text. A message that looks like a secret is refused. |

## 7. Solution overview

```
  People (portal UI)                       Agents (Claude Code in workspaces) / scripts
  Tickets page: list, board, detail        Portal MCP: ticket_list, _get, _create, _comment,
  create, comment, assign, start session   _update, _claim_next, _close           (bearer token)
        │  /api/tickets                           │  /mcp   per-session agent token: own workspace + unassigned queue
        ▼                                         ▼
 ┌─────────────────────────────────────────────────────────────────────────────────────────┐
 │ Tickets service   one SQLite transaction per change; every change = a timeline entry     │
 │ rules: who may change what (§9) · text cleaned and redacted on the way in (§11)          │
 └───────┬───────────────────────────────────────────────┬─────────────────────────────────┘
         │ start session for a ticket                    │ session events (ended, state)
         ▼                                               ▼
   sessions adapter ──▶ ChatController: create(ticketId, worktree), send(actor "ticket:T-12")
```

The tickets module owns its tables, rules, REST routes and MCP tools. It reaches chat sessions through one adapter, so the rest of the module never imports the chat controller. A session carries the ticket's id (`ChatSession.ticketId`), and the ticket carries the session it is assigned to; neither is a foreign key across modules.

## 8. Functional requirements

### Tickets

- **FR1** A ticket has: an `id` (`T-<n>`, counting up from 1), a `type` (`task`, `bug`, `feature`, `question`, `request`, `incident`, `approval`, `chore`), a `priority` (`urgent`, `high`, `normal`, `low`), a `status` (`open`, `in_progress`, `blocked`, `in_review`, `done`, `wont_do`), a one-line `summary` (at most 140 characters), a Markdown `description` (at most 20,000), up to 10 `tags`, a `source` (`human`, `agent`, `system`), a reporter, an assignee, an optional workspace, and timestamps. Defaults: type `task`, priority `normal`, status `open`.
- **FR2** Tags are lowercase `[a-z0-9][a-z0-9._-]*`, at most 30 characters. Entering `Front End` stores nothing and says why; the UI offers the existing tags.
- **FR3** The reporter is who made it: a person in the portal (`ui`), an agent (`session:<id>`, with the workspace and session its token is bound to), a script through an admin's token (`portal-mcp:<token id>`), or the portal itself (`system`). `source` follows: `human`, `agent`, `system`. It never changes.
- **FR4** The assignee is nobody, an agent session (`session`: a chat session id), or a person (`user`: a label, `admin` by default). Nobody means the ticket is in the agents' queue. A person assignee means it waits for a person. Assigning moves nothing else: status is changed on its own, with its own entry.
- **FR5** A ticket may name a workspace (`workspaceId`): where the work happens. A ticket made by an agent gets its token's workspace. A ticket with no workspace belongs to the shared queue. When a session works the ticket in a worktree, the ticket shows the worktree's branch and folder, read from the session.
- **FR6** Closing is a status of `done` or `wont_do` with a closing summary (at most 2,000 characters), recorded as a timeline entry and on the ticket. A closed ticket is read-only for agents. A person may reopen it to `open`; the entry says so.
- **FR7** Every change is a timeline entry in the same transaction: `created`, `comment`, `status`, `assigned`, `priority`, `type`, `summary`, `description`, `tags`, `workspace`, `session_started`, `session_ended`, `ci`, `closed`, `reopened`. An entry names its actor (`ui`, `session:<id>`, `portal-mcp:<token id>`, `ci:<run id>`, `ticket:<id>` for a session the ticket started, `system`) and holds the from and to of what changed, or the comment's text. Entries are never edited or deleted, short of deleting the ticket.
- **FR8** A person can delete a ticket (with its timeline) after a confirmation. Agents can't.

### What agents may change

- **FR9** An agent (a per-session token) may: list and read tickets in its workspace or with no workspace; create a ticket (its workspace is forced to the token's); and change, comment on or close a ticket only when it is **assigned to its own session**, or **it made the ticket and nobody holds it** (unassigned, or assigned to a person). Anything else is `FORBIDDEN` naming the rule (a ticket in another workspace is `NOT_FOUND`). It can't delete, can't reopen, and can't change `source` or the reporter.
- **FR9a** (T-270, 2026-10-14) A ticket held by **another session that has ended** is not stuck. An agent may comment on, change and close it when that session is in the **same workspace** and either is in the agent's **lineage** (its `continued_from` chain back) or has **no live successor** (nothing continuing it is live: an orphan). The rule is one function, `canActForEnded` in `tickets/authz.ts`; the service gathers the facts. Each such write leaves an audit row `ticket.acted_for_ended` naming the acting session, the ended one and why (`lineage` or `orphan`). Never for a ticket a live (or interrupted) session holds, a person holds, or of another workspace: those keep the FR9 refusal, whose text now points at `ticket_adopt`. A session missing from the database does not count as ended.
- **FR9b** (T-294, T-397, 2026-10-15) A **crew worker** (a live session with a lead, `parentId`, started by `session_spawn`) may **comment** on a ticket it does not hold in two cases: (1) a session holds it that is its **lead**, or a session continuing its lead (`continued_from` back from the holder reaches the lead, so a restarted lead's tickets still take its workers' reports; the lead's own lead is not followed); (2) it is the ticket its **spawn named** (the session's `ticketId`, `session_spawn` `ticket`) and **nobody holds it** (the lead started the worker before claiming). A comment only: never a change, a close, a claim or an adoption. The spawn's ticket held by a person or by another session is refused, so a lead cannot open another's ticket by naming it. The rule is one function, `canWorkerComment` in `tickets/authz.ts`. The timeline entry is the worker's (`session:<worker>`), and each such comment leaves an audit row `ticket.worker_commented` naming the worker, its lead, the holder and why (`lead_ticket` or `spawn_ticket`). An ended worker, a closed ticket and every other case keep the FR9 refusal with its text. Reading needs nothing new: a worker runs in its lead's workspace, so FR9 already lets it read these tickets. External MCP tokens are unchanged (FR10).
- **FR9c** (D-62, T-483, 2026-10-15) **An agent does not put a ticket on a person.** An agent's own token (a chat session or a crew worker) is refused with `FORBIDDEN` and the D-62 text ("D-62: agents do not assign tickets to a person. Decide by the written default …") when its `ticket_create` or `ticket_update` leaves the ticket on a person (`user`, `user:<name>`) without a tag listed in `tickets.agentAssignUserTags` (Settings > Tickets, comma separated, default `production`; empty: never), and its change is what puts it there: a new ticket, a move to a person or to another person, or removing the last allowed tag from a ticket a person holds. A ticket already on a person that the change leaves so is not judged again. A person, the page, an admin's token and a trigger a person made are never refused. The rule is one function, `canAgentAssignUser` in `tickets/authz.ts`; each refusal leaves an audit row `ticket.agent_assign_refused` (session, lead, tags, the allowed tags). The setting is changed only by the owner (the settings route; moving it off `production` asks to confirm); no agent tool writes it. No other agent path assigns a person (claim, adopt, bump, the orphan sweep and continuations assign sessions only).
- **FR10** An admin's token with `operate` scope may do what a person may in the UI except delete and start a session. `read` scope only reads.
- **FR11** Which session is calling: an agent's token carries it, verified by the portal and never taken from arguments (a `session_id` that names another session is `FORBIDDEN`); the audit row and the timeline say `session:<id>`. An admin's token that acts as a session passes `session_id`, which must be a live session; a call that needs "me" (claiming, assigning to me) with none named is `SESSION_REQUIRED`.
- **FR12** An agent creating a ticket for a person (an approval, a question) assigns it to `user`. It may later comment on it and close it (FR9), and read the person's comments.

### Claiming

- **FR13** `ticket_claim_next` picks, among tickets that are `open`, unassigned and visible to the caller (FR9), those that have every tag asked for and one of the types asked for, orders them by priority (urgent first) then by age (oldest first), and in one transaction assigns the first to the calling session and moves it to `in_progress`. Two callers never receive the same ticket. With none left it returns nothing, not an error.
- **FR14** Claiming is the only way an agent acquires a ticket it did not create. A person can assign any ticket to any session or person.

### Sessions

- **FR15** **Start a session** (people only, from the ticket's page): pick a running workspace, optionally a Claude on it, and whether to use a worktree of its own. The portal creates the session with `ticketId` (and the worktree when asked), assigns the ticket to it and sets it `in_progress`, then sends the opening message with the actor `ticket:<id>`. The dialog shows the exact opening message first. A ticket that came from an agent shows who wrote it and from which workspace.
- **FR16** The opening message is the ticket: its id, type, priority, summary, tags, description, who reported it, the id of the session now assigned, and a closing line saying that if the portal's ticket tools are available the agent should report with `ticket_comment` and finish with `ticket_close`. It is plain text built by the portal; the ticket's own words are inside it, labelled as the ticket's. The transcript shows it as a portal message from the ticket, never as something the person typed ([Chat sessions](chat-sessions.md) FR14).
- **FR17** A ticket shows the sessions that worked it (those whose `ticketId` is its id), each with its state. The session page shows its ticket as a chip linking to it.
- **FR18** When a session assigned to a ticket ends while the ticket is `open`, `in_progress` or `blocked`, the ticket keeps its status and gains a `session_ended` entry with the reason. The page flags it ("Its session ended") so a person can restart it or reassign it. Nothing is closed or reassigned by the portal at that moment.
- **FR18a** (T-270) Tickets follow the track. A session created with `continuedFrom` (chat sessions §10.4) takes, in the transaction that creates it, every unfinished ticket (`open`, `in_progress`, `blocked`, `in_review`) held by the ended predecessor and its ended predecessors: an `assigned` entry each with actor `system` and `continued: true`, as migration 772 wrote them; the status stays. Closed tickets keep their assignee (who did the work). `ticket_adopt` does the same on request for an ended session of the FR9a rule: the entries carry the caller, `adopted: true` and why, and one `ticket.adopted` audit row lists the ids. What a continuation or an adoption missed, the orphan sweep (FR18b) moves by itself.
- **FR18b** (T-270 layers 2 and 3) **Orphans fall back by themselves.** An **orphan** is an unfinished ticket held by a session that is dead: `ended`, archived, or no longer in the portal (`interrupted` is live: it can be woken). It is derived when read, not stored: `Ticket.orphan` is `{since, sessionId, why}` (`why` `ended`, `archived` or `missing`; `since` the time the portal saw it dead, null until the sweep has looked), the list filter `orphan` and the count `counts.orphans`. The **orphan sweep** (`tickets/orphans.ts`, the rules in the service) runs once a minute with jitter, one pass at a time, at most 200 moves a pass; its last pass and the time each dead session was first seen dead are in `portal_meta` (`tickets:orphans`), so a restart neither resets nor skips the delay. When a session has been dead for `tickets.orphanAfterMin` (Settings > Tickets, default 3 minutes), each of its unfinished tickets moves, in its own transaction, checked again inside it, in this order: **(a)** the live session whose `continued_from` chain reaches the dead one (the nearest, then the latest active), else a live session of the **same workspace** whose title has the same prefix up to its first ":" ("Orchestrator: ClaudePilot dev"; a title without ":" matches nothing); only when the ticket is in that workspace or the shared queue; **(b)** otherwise back to the agents' queue, unassigned, with one system comment "Its session ended: back in the queue."; the status stays (`in_review` stays `in_review` for a verifier, `blocked` stays) except `in_progress`, which becomes `open`; description and comments stay; **(c)** a ticket a person holds is never touched, and the sweep never assigns to a person. Each move is one `assigned` entry (actor `system`, `fallback: true`, `reason` `lineage`, `title` or `queue`, `holder` the why) and one `ticket.fallback` audit row (`from`, `to`, `reason`). A session back to live within the delay (in-place recovery, T-136 keeps its id) keeps its tickets; a later end starts the delay again. The sweep creates no ticket (no needs-a-person request) and sends no notification. The page shows an orphan with a red "Session ended" (or "archived", "gone") badge, a line on the ticket "Its session ended · 2m ago" with an ⓘ, and an "Orphans" chip with its count, first in the chip row (seen on a phone without scrolling sideways), while there are any; the timeline reads a move as "Portal moved it to the session that continues it" (or "to the live session of its track", or "put it back in the queue"). Not built: the "Needs you" entry for an orphan the fallback could not resolve (T-146 does not exist yet; today the queue path always resolves one). Known gap: `ticket_claim_next` takes only `open` tickets, so an `in_review` or `blocked` ticket back in the queue is picked up by someone assigning it, not by a claim. A session missing from the database is dead for the sweep, though not for the FR9a rule (which stays narrow).

### Bump (T-28, owner 2026-10-13)

- **FR28** **Bump** (a person on the ticket's page or its row ⋯; a script with `ticket_bump`): push an open ticket into a session that is already running. The picker offers the ticket's assigned session first, then the live sessions of its workspace (every workspace's for the shared queue), each with its title and state; a session that ended, waits on an approval, or works in another workspace is not offered, or shown greyed with why. Two ways, explained in one ⓘ: **Prioritise** (the ticket is assigned to that session and set `in_progress`; the message goes in with the chat queue priority `next`, so it steers the running turn) and **Ask** (a question: nothing about the ticket changes; the message goes in as `later` and asks for an answer in the ticket). An optional note of one line (at most 200 characters, cleaned like any ticket text, never a credential). Start session stays as it is.
- **FR29** The session gets a portal message from the ticket (actor `ticket:<id>`, label `T-<n>`, so the transcript says "From ticket T-12") in the opening message's style: who bumped it and how, the ticket's type, priority, tags, summary and link, the note, the description fenced as the ticket's words (cut at 4,000 characters, pointing to `ticket_get`), and what to do (Prioritise: work on it and report with the ticket tools; Ask: answer with `ticket_comment`, do not take it on). A session asked about a ticket may comment on it for a day even when FR9 alone would refuse (another session or a person holds it); it may not change or close it.
- **FR30** Every bump is a `bumped` entry on the timeline (who, which session and its title, how, the note as its text), after the `assigned` and `status` entries of a Prioritise, and before the message is sent; a send that fails leaves a note from the portal and says so. Limits: 10 bumps of a ticket and 20 bumps into one session an hour (`RATE_LIMITED`). A bump is written to the platform audit (`ticket.bumped`: ticket, session, mode, whether there was a note; never the note's words); over MCP the call is in the Portal MCP audit too. Who may: a person, or an admin's token of operate scope or more; never an agent's token, a read token or a trigger. The route and the tool check the seam first: operate on the ticket and on the session (`tickets/authz.ts`); another person's session is the same 404 as a missing one, and the picker lists only sessions the person may operate.
- **FR31** The session page's info shows the tickets bumped into it beside its own ticket, each as a chip with how ("T-12 · Ask"), linking to the ticket.
- **FR32** The picker, the two ways and the message's shape are shared (`apps/web/src/components/BumpDialog.tsx`, `apps/server/src/chat/bump.ts`, `packages/contracts/src/bump.ts`), so a CI run's Bump (T-32 part 2) offers the same sessions, ways and text.

### MCP tools

- **FR19** Tools (§12) register through the Portal MCP registry with scope `agent`: agents' tokens reach them, and admin tokens too (read for list and get, operate for the rest). `ticket_start_session` is admin-only and listed only while session control is on. Ticket text in every result is labelled untrusted with its source (§11).
- **FR20** Creating more than 50 tickets in an hour from one session fails with `RATE_LIMITED`; so does a workspace with more than 200 open tickets made by agents. The limits protect the queue from a looping agent, not from a person.

### The page

- **FR21** The Tickets page lists tickets as a list or a board (the choice is remembered). Filters: status (with counts), priority, type, tag, assignee (anyone, unassigned, a person, a session, "Needs you"), workspace, and a text search over summary, description and tags. Default: not closed, newest priority first.
- **FR22** The board has a column per status except closed ones, which share a "Closed" column limited to the latest. Moving a card changes its status, with an entry.
- **FR23** The ticket's page shows its fields (each editable in place by a person), the description as Markdown, the sessions that worked it, and the timeline with a comment box. Agent-written text is marked as such.
- **FR24** The page updates as tickets change (the live socket), so an agent's comment shows up without a reload.
- **FR25** "Needs you" is every ticket assigned to a person and not closed. The Tickets nav item shows its count while there are any. (Not built: the page has the chip and its count; the nav item has none.)

### CI checks (interface I10)

- **FR26** CI ([Local git and CI/CD](local-git-ci.md)) attaches the state of a pipeline to a ticket: one **check** per pipeline name holding its latest state (`queued`, `running`, `passed`, `failed`, `cancelled`), the run id, the commit and a link (an http(s) address, or a portal page such as `/admin/ci/runs/<id>`). A change of state adds a timeline entry of kind `ci`, actor `ci:<run id>`; a new run of the same pipeline replaces the row and the timeline keeps the history. The ticket page shows the checks as chips that open the run.
- **FR27** Tickets are found from a git branch (`ticket/<n>-slug` or `ticket/T-<n>-slug`) and from a commit trailer (`Ticket: T-<n>`). The service offers `find`, `checks`, `attachCheck` and `note` (a comment from the run, marked as not human); an unknown ticket is a null, never an error. Check names and notes are cleaned like any ticket text and credential-shaped values are refused.

## 9. Data model

Stored in the portal's database. Tickets are not secrets: nothing here is encrypted. Text is cleaned before it is stored (§11).

| Table | Key fields |
| --- | --- |
| `tickets` | number (pk), type, priority (rank 0-3), status, summary, description, source (`human`, `agent`, `system`), reporter_kind (`ui`, `token`, `system`), reporter_ref (`session:<id>` for an agent, the token id for an admin's token), reporter_label, reporter_workspace, assignee_kind (`session`, `user`, null), assignee_ref (session id, or the person's label), workspace_id, worktree_branch, worktree_path, closing_summary, created_at, updated_at, closed_at |
| `ticket_tags` | ticket_number, tag (primary key together; index on tag) |
| `ticket_events` | id, ticket_number, at, kind, actor, actor_label, body (comment or closing text), data (json: from, to) |
| `ticket_checks` | ticket_number, name (primary key together), state, run_id, commit_sha, link, actor, updated_at |

Migrations 42 (tickets), 44 and 45 (checks). Indexes: `(status, priority, created_at)` for the queue, `(assignee_kind, assignee_ref)`, `(workspace_id)`, `(tag)`. The id shown everywhere is `T-<number>`. Tickets that other modules read (the knowledge graph, [Persona pool](persona-pool.md)) are read through these tables; renaming a column is announced first.

## 10. API

`/api/tickets`, behind the session guard like every other route, with the Origin check on mutations.

| Route | Does |
| --- | --- |
| `GET /api/tickets` | The list: filters above; `limit`, `before`; with `counts` per status and "needs you". |
| `POST /api/tickets` | Create (reporter: the person). |
| `GET /api/tickets/:id` | The ticket, its timeline, the sessions that worked it with their state. |
| `PATCH /api/tickets/:id` | Change summary, description, type, priority, status, tags, assignee, workspace. Each changed field is an entry. |
| `POST /api/tickets/:id/comments` | Add a comment. |
| `POST /api/tickets/:id/close` | Close with a summary; `DELETE …/close` reopens. |
| `POST /api/tickets/:id/session` | Start a session for it (FR15). |
| `DELETE /api/tickets/:id` | Delete (FR8). |
| `GET /api/tickets/tags` | Tags in use with counts, for the filter and the tag field. |
| `GET /api/tickets/:id/opening` | The opening message a session would get (shown before Start). |
| `GET /api/tickets/:id/brief` | The summary line for the session page's chip. |
| `GET /api/tickets/:id/bump` | The sessions it can be bumped into, the assigned one first, each with state and why not (FR28). |
| `POST /api/tickets/:id/bump` | Bump it: `{ sessionId, mode: prioritise \| ask, note? }` (FR28 to FR30). |
| `GET /api/tickets/bumped?session=<id>` | The tickets bumped into a session, for its page (FR31). |

## 11. Security requirements

- **Ticket text is untrusted.** On the way in, every text field has escape sequences, control characters, bidirectional and zero-width characters and Unicode tag characters stripped, and credential-shaped text refused: a ticket or comment that contains a key is a 422 naming the field, and nothing is stored (the same shapes as [Portal MCP](portal-mcp.md) §14.3). Over MCP the same refusal is `SECRET_IN_ARGUMENT`.
- **On the way out to a model** every ticket text (summary, description, comments, closing summary, labels) is returned as `{"untrusted_text": …, "source": "ticket:human" | "ticket:agent" | "ticket:system"}`, capped, never inside a tool description or the server's instructions. The opening message of a session (FR16) frames the ticket's words the same way in prose.
- **Rendering.** Markdown without raw HTML, images shown as links, links open in a new tab with `noopener noreferrer nofollow`; the same renderer the chat uses.
- **A ticket grants nothing.** No path from ticket text to a permission: sessions started from a ticket follow the session rules (eligibility, folder trust, no bypass over MCP); an approval ticket's answer is a comment a person wrote.
- **The agent rules are enforced by the server** (FR9), on every call, from the token's workspace and the ticket's assignee, never from what the caller says about itself. Claiming is one transaction.
- **Audit.** Over MCP every call is in the audit trail with its token and actor; ticket changes carry the actor in the timeline entry (`session:<id>` for an agent).
- **Limits.** Text caps (FR1), the creation limits (FR20), the MCP rate limits ([Portal MCP](portal-mcp.md) §14.5).
- Tests: injection text in every field of a ticket comes back stripped and labelled; a secret in any field is refused; the authorization matrix (no token, read scope, an agent token of another workspace or session, one after its session ended, another session's ticket, a closed ticket) for every tool; two concurrent claims never return the same ticket.

## 12. MCP tools

All register through the Portal MCP registry with scope `agent` (FR19), except the last two. An admin's token needs `read` for `ticket_list` and `ticket_get` and `operate` for the others; an agent's token reaches all but `ticket_start_session`.

| Tool | Scope | Agents | Inputs | Output |
| --- | --- | --- | --- | --- |
| `ticket_list` | agent (read) | yes | `status[]`, `priority[]`, `type[]`, `tag`, `assignee` (`me`, `unassigned`, `user`, `session:<id>`, `any`), `workspace_id`, `query`, `include_closed`, `cursor`, `limit` | Tickets, most urgent first: id, type, priority, status, summary, tags, assignee, workspace, updated. Text labelled. |
| `ticket_get` | agent (read) | yes | `id`, `events`, `section` (`description`, `comments`), `from`, `comment_id`, `full` | Short by default (§12.1): the ticket's fields, the description's first 1,500 characters, the last 3 comments cut at 500, counts and `cut` lines. `section description` pages the whole description (8,000 a page, `from`); `section comments` the latest comments whole; `comment_id` one entry whole; `events` the latest N entries, short; `full` the whole view (its sessions, checks and the latest timeline entries). |
| `ticket_create` | agent | yes | `summary`, `description`, `type`, `priority`, `tags[]`, `assignee` (`me`, `user`, `session:<id>`, none), `workspace_id` | The new ticket. Rate limited (FR20). An agent assigns a person only with an allowed tag (FR9c). |
| `ticket_update` | agent | yes | `id`, any of `summary`, `description`, `type`, `priority`, `status`, `tags`, `assignee`, plus `session_id` | The ticket. FR9 and FR9c apply. |
| `ticket_comment` | agent | yes | `id`, `text`, `session_id` | The entry's id and time. FR9, FR9a, FR9b (a crew worker) and FR29 apply. |
| `ticket_claim_next` | agent | yes | `tags[]` (all of them), `types[]`, `session_id` | The ticket claimed in the short form of `ticket_get` (no comments), or none. |
| `ticket_close` | agent | yes | `id`, `summary`, `outcome` (`done`, `wont_do`), `session_id` | The id, the status and the closing summary. |
| `ticket_adopt` | agent | yes | `from_session`, `session_id`, `confirm_token` | First `confirmation_required` with the tickets that would move and why; then the ids moved (FR18a). Refused: a live session (`CONFLICT`), one a live session continues (`FORBIDDEN`), another workspace's or none (`NOT_FOUND`). Declared `agent` reach `workspace`, confirmed, audited `ticket.adopted`. |
| `ticket_start_session` | admin | no | `id`, `workspace_id`, `claude_id`, `worktree` | The session. Listed only while session control is on. |
| `ticket_bump` | operate | no | `id`, `session_id` (left out: the sessions that can take it), `mode` (`prioritise`, `ask`), `note`, `confirm_token` | First `confirmation_required` with a preview (the session, its state, the mode, the queue priority, what changes, the note), then the bump (FR28 to FR30). Listed only while session control is on. |

### 12.1 Short results (T-282)

A tool result is written into the agent's context once and read again on every later request of that session, so a
long one is paid for many times. Measured on 2026-10-14 from the session tapes: `ticket_get` was 5.5 percent of all
tool result characters; 92 `ticket_get` calls in one orchestrator's tapes averaged 6,680 characters (p90 14,669),
and T-277 read with `events: 40` was 16,401 characters.

- `ticket_get` answers short unless asked: the description's first 1,500 characters, the last 3 comments cut at 500
  (not 600: 1,500 + 3 x 600 of text left too little room under the 4,000 character bound), counts, and a `cut` line
  for every shortened field that says how much was shown and which call returns the rest. Never a silent cut.
- `ticket_list` rows are id, type, priority, status, summary (140), tags and the assignee without its title; 20 a
  page with `next_cursor`; `full: true` for the whole row.
- `ticket_update` answers id, status, priority and assignee; `ticket_comment` the entry's id and time;
  `ticket_create` the ticket's fields without its text; `ticket_close` id, status and closing summary.
- The `pilot://tickets/{id}` resource stays the whole view (`full`).

As observed (the T-277 result taken from the tape, replayed into a test portal; the method and the numbers are on
T-282): before 16,401 characters, after 4,052 by default (75 percent less). A ticket with a 20,000
character description and 40 comments of 1,000 characters: 3,958 characters by default (the test in
`tickets/portalTools.test.ts`).

## 13. User experience

Existing components only, on phones and desktops. A new navigation item, **Tickets**, between Sessions and Knowledge (in the phone bar).

**As built (v0.2), text diet.** Rule 12 (the owner: less text, fewer components) trims the copy below: no page description, labels of a word or two, the explanations in ⓘ notes or tooltips, one terse line for a safety warning, and nothing that says what the data already shows. "Agents' queue" reads **Unassigned** everywhere; the filters are chips and three selects (Priority, Type, Tag) in one row that scrolls on a phone; an empty list says "No tickets" with the New button.

- **Page.** Header "Tickets" with "New ticket". Under it: status chips with counts (Open 4 · In progress 2 · Blocked 1 · In review 0), "Needs you" and "Unassigned" chips, filter menus for priority, type and tag, a search field, and a List | Board toggle. Phones: chips scroll sideways; the board scrolls sideways one column at a time.
- **Large screens (T-158 slice 1, 2026-10-14).** The page is a Workbench of two panels (Web app PRD §9.2a): the queue and the open ticket. It uses the frame's whole width. On a phone, and on a tablet where both do not fit, a ticket opens in the queue's place with Back, as before; from an HD desktop (1024 px) it opens **beside** the queue (380 to 520 px, the queue takes the rest) with a Close panel button, the queue keeping its place, filters and live updates, the open ticket's card or row outlined. The address says which ticket is open (`/admin/tickets/T-12`) and keeps the queue's view and filters, so Back and Close return to the same queue. On a desktop the header and filters stay put; the **board** fills the window's height, each column scrolls down on its own, and its columns share the width between 256 and 640 px, so every column shows at 1920 px and wider (at 3840 the board spans 92 % of the screen) and the board scrolls sideways only inside itself when they do not fit, never the page. The **list** shows as many columns of rows as fit (28rem each; one on a phone). On a phone the board's columns snap to the 16 px gutter; the chips, filters, view switch, ⋯ menus, clear-search and Back are 44 px.
- **List row.** A priority mark (colour and shape, not colour alone), `T-12`, the summary, type and tags as quiet badges, the assignee (a session's title or "You"), and its age. A row with an ended session shows "Session ended"; one assigned to a person shows "Needs you".
- **Ticket page.** Summary as the title; its status and type badges and the **check chips** (one per pipeline, with its state; a tap opens the run); fields (status, priority, type, assigned to, tags, workspace, reported by; two columns on a phone); the description; the sessions that worked it, each a link; the timeline (comments in bubbles, changes as quiet lines: "Admin set the priority to high", "CI: build passed"), an ⓘ on its title ("Agents working this ticket read your comments") and a comment box. Actions: Start session, Close, ⋯ (Edit…, Delete…; Reopen when closed).
- **Start session dialog.** Workspace (running ones), Claude (when the workspace has several), "Own git worktree" with an ⓘ, and the opening message in a collapsed block. For an agent-written ticket one line: "Written by an agent: check the opening message."
- **Create dialog.** Summary, description (Markdown; one line: "No keys or passwords."), type, priority, tags with suggestions, Assign to (Unassigned or Me), workspace (Any).
- **Session page.** A chip "T-12 · Fix login redirect" under the title, linking to the ticket. The transcript's first message reads "From ticket T-12". Tickets bumped into it show as "T-12 · Ask" chips in its info (FR31).
- **Bump dialog** (FR28; the ticket page's Bump button, a row's ⋯ → Bump…, a board card's ⋯). Title "Bump", the ticket under it; Session (a radio list: title, then state or why not; "Assigned" on the ticket's session), How (Prioritise | Ask, one ⓘ for both), Note (optional, one line). The timeline reads "Admin bumped it into “Worker” (Ask)" with the note under it.
- **Empty states** are one line and offer "New ticket". Loading and errors use the shared states.

## 14. Rollout and milestones

| Milestone | Scope | Gate |
| --- | --- | --- |
| T1 | Tables, service and rules, REST, the MCP tools, the Tickets page (list, detail, create, comment, assign, close) | Rules and injection tests; the in-workspace agent scenario against a real Claude Code; looked at at 390 and 1280 px |
| T2 | Start a session for a ticket (opening message with its actor, the ticket on the session page, session ended on the timeline), live updates | Chat sessions' ticket interface; a session started from a ticket in a Docker workspace |
| T3 | Board view, "Needs you" count in the nav, tag suggestions | |
| T4 | Worktree per session on start (follows Chat sessions' worktree work) | A2's worktree support |
| Later | Notifications for "needs you", links to the knowledge graph, blocked-by relations, retention | Q3 to Q6 |

**Status (2026-10-12).**

- **T1** built. Rules, injection and authorization tests (`tickets.test.ts`, `portalTools.test.ts`); the agent scenario ran against a real Claude Code 2.1.296 inside a Docker workspace (a scratch portal with a fake chat side): claim the most urgent claimable ticket, read it (its hostile text came back labelled, tag characters stripped), comment, propose an MCP server, close; a person's ticket, another workspace's ticket and another session's id were refused; after its session ended the token was refused. Looked at at 390 and 1280 px.
- **T2** built and checked end to end (2026-10-12; a scratch portal, one Docker workspace on an account pool with a stand-in API, Claude Code 2.1.296). Start session on the ticket page (390 px) created the session, assigned the ticket and sent the opening message as `ticket:T-1` (the transcript says "From ticket"); the agent, with its own token, listed its ticket, read it, commented, closed it with a summary and claimed the next one (T-2, not the approval ticket). The timeline shows each step by `session:<id>`, the session page shows the ticket chip, and the audit trail names the session. Looked at at 390 and 1280 px. Also built: a `session_ended` entry and live updates on the `tickets` topic. **Open:** in Manual mode the first call of each portal tool asks for an approval; allowing the agent tools for a session that has a grant is a chat-launch decision ([Portal MCP](portal-mcp.md) §12.6).
- **T3** partly: the board and the tag picks are built; the nav count is not.
- **T4** the start request carries the worktree option and the ticket keeps the branch and folder the session reports; it follows the chat side's worktree work.
- **I10** (CI checks, FR26 and FR27) built; Local git and CI/CD calls it.
- **Bump** (FR28 to FR32, T-28, 2026-10-13) built: the service, the routes behind the seam, `ticket_bump` with its confirmation, the shared dialog on the ticket page, rows and board cards, and the chips on the session page; tests in `tickets/bump.test.ts`, `chat/bump.test.ts` and `components/bump.test.ts`.
- **Tickets follow the track** (FR9a, FR18a, `ticket_adopt`, T-270, 2026-10-14) built in the server: tests in `tickets/follow.test.ts`, `chat/continuation.test.ts` and `tickets/portalTools.test.ts`. Observed in tests only; no UI change (the "Its session ended" flag stays until a continuation or an adoption moves the ticket).
- **Orphans fall back by themselves** (FR18b, T-270 layers 2 and 3, 2026-10-14): tests in `tickets/orphans.test.ts` (fake clock: lineage, title prefix, queue, live and person tickets untouched, in-place recovery, archived and missing, the delay setting, bounded and restart safe, no notification or ticket, the loop's timing). Observed in a scratch portal with `tools/qa/ticket-orphans.mjs` (61 of 61 checks): the orphan line with its time and ⓘ, the red badge and the Orphans chip at 390 px (touch) and 1280 px, light and dark, no horizontal scroll; with the delay at 1 minute the sweep moved a track's in_progress and in_review tickets to the live session "Worker: QA again" (title prefix, statuses kept) and the lone session's ticket back to the queue as open with its comment, within about two minutes. The chips are 36 px high like every chip on the page (not the 44 px bar; unchanged here).

## 15. Success metrics

| Metric | Target |
| --- | --- |
| Tickets whose timeline misses a change | Zero (tests per field) |
| Secrets or hidden characters stored in a ticket | Zero (injection and canary tests) |
| An agent changing a ticket it may not | Zero (authorization matrix) |
| A ticket handed to two sessions by `ticket_claim_next` | Zero (concurrency test) |
| Time from "I need this" to a ticket created, in the UI | Under 20 seconds |

## 16. Amendments to other PRDs

| ID | PRD | Change |
| --- | --- | --- |
| A1 | [Chat sessions](chat-sessions.md) | A session may carry a ticket id; a portal message may carry the actor `ticket:<id>`. Already specified for the controller; the session page shows the ticket (FR17). |
| A2 | [Portal MCP](portal-mcp.md) | Adds the ticket tools (§12 here) and the inside audience: per-session agent tokens and the scope `agent` (its §12.6). |
| A3 | [Local git and CI/CD](local-git-ci.md) | Attaches pipeline checks to tickets through `Tickets.attachCheck` and finds tickets from a branch or trailer (FR26, FR27). |

## 17. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | Should an agent be able to reopen a ticket it closed, or only a person? (v0.1: only a person.) | Product |
| Q2 | A person assignee is a label. When per-user identity exists, do tickets assigned to "admin" move to a real user, and who sees "Needs you"? | Product |
| Q3 | Push for "needs you" (an approval waiting): the Web app PRD's notification service, or a separate switch? Answered 2026-10-12: the notification service, kind `human_request`, per destination ([Web app & PWA](web-app-pwa.md) §11.1). | Product |
| Q4 | Relations between tickets (blocked by, parent): wanted, or is a tag enough? | Product |
| Q5 | Retention: do closed tickets age out, or stay as the project's memory? | Operator |
| Q6 | Links between tickets and the knowledge graph (notes, decisions) once that exists. | Engineering |
| Q7 | Should the agents' queue be per workspace by default instead of shared across workspaces? (v0.1: a ticket with no workspace is shared.) | Product |
| Q8 | ✅ A check keeps the latest state per pipeline name, not one row per run; the timeline keeps each change with its run id. Revisit if the ticket page should list runs. | |

**Needs you (T-146):** an open ticket of type `approval` assigned to a person is listed on Needs you ([attention.md](attention.md) §2, `tickets/attention.ts`, read only).
