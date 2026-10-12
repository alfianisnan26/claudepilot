# PRD: Sharing

| | |
| --- | --- |
| Status | **Draft v0.1** (2026-10-12). Design only: `packages/contracts/src/sharing.ts` has landed and nothing else is built (**Not built**). Written from the code (audit in `COORD/p5-audit.md`), the secrets and workspace PRDs, and the DDL run in `node:sqlite`. ✅ = checked here, 📄 = documented, 🔬 = unverified. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [Authorization](authorization.md) (grants, levels, `can`), [Identity](identity-onboarding.md) (usernames, re-auth), [Pools foundation](foundation-pools.md) (assignments, safe unassign), [Secrets & env](secrets-env-pool.md) (exposures, rotation) |
| Related | [Multi-user overview](multi-user.md), [Teams](teams.md) (sharing to a team), [Workspace Claudes](workspace-claudes.md) (a Claude's sign-in belongs to a person), [Tickets](tickets.md), [Knowledge graph](knowledge-graph.md), [Chat sessions](chat-sessions.md) |

## 1. Summary

A person shares something they own or manage with another user, by exact username, or with a team. The **consent screen** lists everything that comes along (the workspace, the MCP, skill and persona sets assigned to it, its tickets, vaults the person adds) with a check box on each; **credentials default off** and a warning says what `operate` really means. A share is a bundle of ordinary grants made in one consented act, so revoking it removes exactly what it gave, at once: open sockets, running sessions, terminals and the assignments made under it included. The list of who has what is always visible, and a share to another person waits for their acceptance.

Two facts shape the design. Inside a workspace there is no isolation: anyone who can **operate** it has a terminal, and a terminal reads the delivered secrets, the API keys and every Claude's sign-in (secrets-env T4, foundation §10). So the honest controls are the level (`view` has no terminal), what is *in* the workspace while it is shared, and saying it plainly. And a share must carry no more than what the person saw: what comes along is exactly the list on the screen.

## 2. Background and what exists

Checked on 2026-10-12 (✅).

| Fact | Evidence | Consequence |
| --- | --- | --- |
| A workspace is a container with labels; its sets are `assignments` rows; the sets are pool objects with their own owners | `workspaces/runtime.ts`, `pools/service.ts`, schema dump | a share grants rights on each ticked item; it never copies a set |
| Delivered values are files in the container; `exposures (secret_ref, workspace_id, first/last_delivered_at, removed_at)` records every workspace a secret reached; FR10 of secrets-env says "assigning is sharing" and asks for consent | secrets-env-pool FR10, T4; migration `exposures` | the consent screen extends that warning to people; `credential.exposed` is audited |
| An account pool delivers API keys into a workspace; a Claude's login lives in its directory on the volume | account-pool, workspace-claudes FR2 | both are credentials for sharing |
| There is a safe unassign flow (`removals`, `PoolService.deleteWithUnassign`) that removes delivered files and handles deletes | `pools/service.ts`, foundation §6 | "unticked credentials are removed" reuses it |
| `SocketGuard` cuts sockets when a session ends; `AgentAccess.revokeWorkspace` kills tokens | `sockets.ts`, `portalmcp/agents.ts` | revocation extends the same idea per user and per object (`emitAccessChange`) |
| Tickets carry `workspace_id` and are one global queue; vaults are separate from workspaces; sessions have no owner | schema, `tickets/service.ts` | what "comes along" with a workspace is found by `workspace_id` for tickets; a vault is added by a picker (nothing links a vault to a workspace) |
| `chat-sessions.md` §15: "everyone signed in can read every session, and workspace users can read its files" | the PRD | replaced: a session is private to its creator unless shared |
| The `u_owner` convention and `created_by`/`owner_id` columns are in place on new tables | 38 files | grants refer to user ids that already exist |

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Share one thing with one person**, by exact username, with a level: `view`, `operate` or `manage`. |
| G2 | **Consent that is true.** The screen lists what comes along, each item checkable; what is shared is exactly what was shown (a consent hash proves it). |
| G3 | **Credentials default off**, with one warning, and unticked ones are not left in the workspace while it is shared. |
| G4 | **Sessions stay private** to their creator until the creator shares them. |
| G5 | **Revocation is complete**: access ends at once, live things are cut, downstream assignments go, and the screen says what revoking cannot undo. |
| G6 | **Always visible**: who holds what on an object, what I shared, what was shared with me. |
| G7 | **One model for every object type** (workspace, session, ticket, set, account, vault, template, target) and for users and teams. |

## 4. Non-goals

- **Link sharing** (anyone with the link). Every share names a person or a team.
- **Per-note sharing.** The vault is the unit (Q3 of Authorization).
- **Sharing as a copy.** A share gives rights on the same object; there is one workspace, one set.
- **Isolation between operators of a workspace** (Authorization §4).
- **Public or cross-portal sharing.**
- **A request-access flow** ("ask the owner"). Not in v1.

## 5. Users and stories

| ID | Story |
| --- | --- |
| US1 | As a workspace owner, I share it with Ben at Operate, untick the secrets, and Ben can start it and open terminals; my GitHub token is not in it while he can. |
| US2 | As Ben, I see "Alfian shared a workspace with you", read what comes along, and accept or decline. |
| US3 | As an owner, I open Share on a workspace and see every person and team who holds access, what level, and since when, and end any of them. |
| US4 | As a person, I share one session so a colleague can read how I solved something. |
| US5 | As an owner who ends a share, I am told that values already read cannot be taken back, and offered to rotate the secrets they could read. |
| US6 | As a team member, I share a set to my team; everyone in it can assign it. |
| US7 | As a security reviewer, I see that nothing came along that was not on the screen. |

## 6. Scope boundary

Owned here: the preview, the bundle rules, creating, accepting, narrowing and ending a share, the revocation effects and the assignment sweep, the access list, ownership transfer, the screens. Owned elsewhere: what a level means ([Authorization](authorization.md) §9), the membership rules of teams ([Teams](teams.md)), the safe unassign ([Pools foundation](foundation-pools.md)), rotation of secrets ([Secrets & env](secrets-env-pool.md) FR16 to FR18).

## 7. Solution overview

```
 Share ⋯ on an object ─► pick who (username → exact lookup, or a team) and a level
        │
        ▼  POST /api/shares/preview   (writes nothing)
   SharePreview { items[] each ticked/credential/locked, notes[], needsAcceptance, needsReauth, consent }
        │  the person ticks and unticks; confirms (password check when manage or a credential is ticked)
        ▼  POST /api/shares { target, subject, level, items[], consent, acknowledgeExposure? }
   verify rights ─ verify consent hash ─ verify credential acknowledgement ─ create the share
        │                                                    ┌── team: active now
        ▼                                                    │
   state pending ──(the person accepts)──► active ───────────┘   activation: grants made; unticked credentials removed
        │                                      │
        └─(declines / 14 days)─► ended         └─(revoke / leave / expiry)─► ended: grants removed, live things cut, sweep run
```

A grant is `(object, subject, level, share)`; evaluation is in [Authorization](authorization.md) §10. A share lists the ticked items in its `items` column (JSON) and makes one grant per item at `levelFor(type, shareLevel)` when it activates.

## 8. Functional requirements

- **FR1 (who)** A subject is a user named by an exact username (the lookup returns the person's name and avatar so the sharer confirms who it is) or a team the sharer belongs to. Sharing with oneself, with the object's owner, with a disabled or pending account, or with a team the sharer is not in is refused (`SHARE_SUBJECT_INVALID`).
- **FR2 (rights needed)** `manage` on the target; a level no higher than the sharer holds; **only an owner (or an owner of the owning team) grants `manage`**. Each ticked item needs `manage` on it too; an item the sharer cannot grant is listed locked, unticked, with "not yours to share" and does not come along.
- **FR3 (preview)** `POST /api/shares/preview` returns the bundle (§9), the notes, whether acceptance and a password check are needed, and `consent`: the SHA-256 of the target, subject, level and every candidate item's ref and credential mark. It writes nothing.
- **FR4 (consent hash)** `POST /api/shares` carries the `consent` of the screen the person confirmed. The server recomputes it from the current candidates; a difference (a set assigned, a ticket added, a credential delivered in between) answers `409 SHARE_CHANGED` and the screen previews again. What is shared is therefore what was shown.
- **FR5 (credentials)** Items that carry a value or a login are credentials: secrets sets, account pools, accounts and endpoints, and Claudes (`isCredential`). They start unticked. **They matter only when the level is `operate` or higher on a workspace** (a terminal reads them); a `view` share exposes none of them and the group is not shown. When the workspace holds credentials and the level is `operate` or higher, the request needs `acknowledgeExposure: true` (else `409 SHARE_EXPOSES_CREDENTIALS` with the list) and a password check.
- **FR6 (unticked credentials are removed)** At activation, a secrets set or an account pool that is assigned to the workspace and unticked is **unassigned** through the safe unassign (files removed, audit `secret.assigned` reversed), and the share records it in `removed`. The screen says so in the same line as the warning. A Claude's sign-in cannot be removed from the volume: an unticked Claude is not usable by the person through the portal (no grant) and a fixed line says it stays readable in a terminal.
- **FR7 (ticked credentials)** The share is made, the grants are made, and `credential.exposed` is audited per credential with the sharer, the subject and the level. A rotation link is shown when the share is later revoked (§10).
- **FR8 (acceptance)** A share to another user at `operate` or `manage` is `pending` until that person accepts; a share at `view` is active at once unless the platform setting `sharing.acceptance` is `always` (default `operate`; it is `IdentitySettings.sharingAcceptance`). A share to a team is active at once: joining the team was the consent. Accepting, declining and revoking a pending share are atomic (`UPDATE ... WHERE state = 'pending'`). A pending share ends after 14 days.
- **FR9 (narrow at once, widen by a new share)** The sharer may lower the level, untick items or set an expiry on an active share immediately (the grants change in one transaction, with the effects of §10 for what was removed). Raising the level or adding an item is a new share with a new consent and acceptance.
- **FR10 (the list)** `GET /api/shares?direction=by-me|with-me` and `?object=<type>:<id>` (for a manager), and `GET /api/access?type=&id=` (`AccessList`: the owner, then everyone who holds a level and through what: the owner, a share, or a team). A person sees the shares they made, the shares made to them, and, as a manager, those on objects they manage. Nobody else sees a share, and an id that is not theirs is 404.
- **FR11 (private sessions)** A session is shared like any object, one at a time, with the same screen: the session (locked, ticked) and its files and diff are included, and the screen says so. Sharing a workspace never shares a session. A sharee's `operate` on a session also needs `operate` on its workspace (the guard); they send messages that spend the creator's Claude, and Bypass is never available to a sharee (only the creator's own opt-in).
- **FR12 (who may revoke)** The share's creator and the object's owner (or an owner of the owning team) end a share; any other manager sees it. The subject may leave (`DELETE` by the subject ends it as `left`). Revoking a team share affects every member; a member who leaves the team loses what the team held.
- **FR13 (the assignment validity sweep)** An assignment of a set or an account pool to a workspace is valid while SOME user holding `manage` on the workspace holds `operate` on the set. After any share ends, a membership ends, an ownership changes or a user is disabled, the sweep checks the affected assignments and removes the invalid ones through the safe unassign, audits each, and tells the workspace's owner. (This is how "I revoke Ben's use of my set" also removes the set from Ben's workspaces.)
- **FR14 (live effects)** Ending a share emits `emitAccessChange` for each affected user: their sockets for the object close within a second, their terminals and shells in the workspace close, their running chat sessions in it end (`endUserSessionsIn`), their browser lease is released, and their pending answers are void.
- **FR15 (limits)** `SHARE_LIMITS`: 30 shares created per person per hour, 20 pending per recipient, 14 days pending; 50 active shares per object; a throttle row per person (`auth_throttle` scope `share`).
- **FR16 (transfer)** The owner may transfer ownership to another user (who must accept) or to a team they belong to (at once); `POST /api/objects/transfer`; needs a password check; audit `object.reassigned`. Existing grants stay; the new owner can end them.
- **FR17 (target gone)** Deleting an object removes its shares and grants (`forgetObject`, next to the `forgetWorkspace` calls that already exist), audited. A workspace removed outside the portal leaves stale grants behind: they are harmless, because a grant records the workspace's `uid` and a workspace made later under the same name has a fresh one ([Authorization](authorization.md) FR10a); the next sweep deletes them.
- **FR18 (host-level workspaces)** A workspace on a host-level target (`local`, `docker-host`) cannot be shared with a non-admin (`SHARE_SUBJECT_INVALID`).
- **FR19 (audit)** `share.created`, `share.accepted`, `share.declined`, `share.updated`, `share.revoked`, `share.left`, `share.expired`, `credential.exposed`, `object.reassigned`, each with the actor, the subject, the level and the item list (names and types, never values).
- **FR20 (notifications)** The subject is told of a share and of its end through the notification bus when it exists (kinds `share_received`, `share_ended`); until then the "Shared with me" list and a badge on the account menu.

## 9. What comes along (the bundle per target)

The server offers candidates; the person ticks. All start ticked except credentials.

| Target | Items offered | Group | Level given | Default |
| --- | --- | --- | --- | --- |
| workspace | the workspace itself | workspace | the share's level | locked on |
| | MCP sets, skill sets, persona and contexts assigned to it | sets | `view` (see what is configured; using a set elsewhere is a separate share of the set) | ticked |
| | open tickets linked to it that the sharer owns or manages | work | the share's level capped at `operate` | ticked |
| | a vault the person adds from a picker (nothing links vaults to workspaces) | knowledge | the share's level capped at `operate` | not offered until picked |
| | secrets sets assigned to it | credentials | `view` (names, never values) | unticked; **removed if left unticked** at `operate`+ |
| | the account pool assigned to it | credentials | `operate` | unticked; **removed if left unticked** at `operate`+ |
| | its Claudes (each with its sign-in state) | credentials | `operate` | unticked; stays readable in a terminal |
| session | the session; its files and diff | | `view`, `operate` or `manage`, per the share | locked on |
| ticket | the ticket with its comments and checks | | the share's level | locked on |
| pool (a set) | the set | | the share's level | locked on; a secrets set shows the credential warning at `operate` (the person can assign it, so its values reach their workspaces) |
| account, account pool, endpoint | the item | credentials | `operate` = use | locked on; credential warning |
| vault | the vault (notes, graph, files) | | the share's level | locked on |
| template | the template | | the share's level | locked on; the sets it names are separate shares, listed as "also needs" |
| target | (admins) the place | | `operate` = place a workspace | locked on |

## 10. Revocation, step by step

All inside one transaction where the store allows, then the live effects. Order matters: rights first, effects after.

1. The share becomes `revoked` (`ended_at`, `ended_by`, `ended_note`); its grants are deleted (✅ the level query shows the right is gone at once). `can()` now answers 404 for the person.
2. `emitAccessChange` for the person (or every member of the team): sockets subscribed to the object close; `SocketGuard` tracks them by user.
3. The person's terminals, shells and browser lease in the workspace close; their running chat sessions in it end with the reason `share ended`; their agent tokens die with those sessions.
4. The assignment sweep (FR13) removes assignments that lost their basis and tells the owner.
5. Audit rows; the person's "Shared with me" shows the share ended.
6. The screen says: **"Access ends now. Values already read can't be taken back."** If credentials were ticked it adds a link, "Rotate the secrets they could read" (the existing rotation flow, [Secrets & env](secrets-env-pool.md) FR16).

What revoking cannot undo, stated honestly: anything already read or copied, commits already pushed, and the person's own sessions' transcripts (theirs; kept as theirs).

## 11. Security and threat model

| ID | Abuse | Control |
| --- | --- | --- |
| S1 | Share spam (unwanted shares to a person) | acceptance for operate and manage; 30/h per sharer; 20 pending per recipient; decline; the pending list is only the recipient's |
| S2 | A sharee grants onward (manage sprawl) | only owners grant `manage`; managers grant up to `operate`; nobody grants more than they hold |
| S3 | The consent shown differs from what is shared (a set assigned between preview and create) | the consent hash (FR4) |
| S4 | Credentials leak through a share the person did not think carried them | credentials default off; unticked ones removed; the warning and acknowledgement; reauth |
| S5 | Item smuggling (an `items` entry that was not offered, or one the sharer does not manage) | items must be a subset of the candidates; each needs `manage` by the sharer |
| S6 | IDOR on share ids | a share is visible only to its creator, its subject, the object's owner and managers; others 404 |
| S7 | Revoke vs accept race | atomic state updates; a revoked share cannot be accepted |
| S8 | Sharing a host-level workspace to a member | refused (FR18); demoting an admin ends their access |
| S9 | The sharee keeps working after revocation (socket, terminal, session, assignment) | FR14 and FR13; tested (X10) |
| S10 | A member shares a team object with outsiders | only owners of the owning team (or its manage-holders) share it; a share needs `manage` |
| S11 | Share expiry never runs | `can()` checks `expires_at` on every use; a job also ends and audits expired shares |
| S12 | A team share reaches people who join later | said on the screen: "Everyone in the team, now and later"; credentials in a team share need the same acknowledgement |
| S13 | Enumeration by the share dialog | the lookup is the only oracle (exact, throttled); errors for unknown, disabled and self are the same |
| S14 | A session shared at `operate` used to run commands in the creator's workspace | the guard needs `operate` on the workspace; sharing a workspace is a separate, consented act |
| S15 | Ownership transfer to take over | needs the receiver's acceptance (a user) or membership (a team); a password check; audited |
| S16 | A shared workspace on a billed target (a GitHub codespace: [Codespaces](codespaces-poc.md) §10) starts and runs on the OWNER's account | the screen adds the note `billed_to_owner`; starting and stopping need `operate`, deleting or detaching `manage`; the owner's connection token is never delivered (it stays in the portal) and stays the owner's: a sharee cannot use it elsewhere |

## 12. Test matrix (executable; extends Authorization §12)

| ID | Case | Expected |
| --- | --- | --- |
| H1 | A shares a workspace with B at view: B lists it, sees name and state, cannot open a terminal or read a file | 403 on `operate` routes with `details.verb` |
| H2 | A shares at operate with secrets unticked | the secrets set is unassigned from the workspace; B opens a terminal and finds no value; the audit has no `credential.exposed` |
| H3 | The same with the set ticked and no acknowledgement | `409 SHARE_EXPOSES_CREDENTIALS`; with it, the share is made and `credential.exposed` is written |
| H4 | A assigns a set to the workspace between preview and create | `409 SHARE_CHANGED` |
| H5 | B accepts, uses it, A revokes | B's next call 404; B's socket closes within 1 s; B's running session ends; B's assignment of A's set is gone |
| H6 | Two parallel accepts, or accept versus revoke | one outcome; no grants left after a revoke |
| H7 | B, an operator, tries to share the workspace onward; a manager of it tries to give `manage` | refused: needs `manage`; `SHARE_LEVEL_TOO_HIGH` |
| H8 | The sessions of a shared workspace | A cannot read B's session, B cannot read A's; a session share makes exactly one visible |
| H9 | A share to a team; a member leaves; a person joins | the leaver loses access at once; the joiner gains it |
| H10 | A shares a `local` workspace with a member | `SHARE_SUBJECT_INVALID` |
| H11 | A sharee lists shares, access lists, shares of others | only their own; 404 for others' ids |
| H12 | A deletes the workspace | shares and grants are gone; B's list no longer shows it |
| H13 | 31 shares in an hour | the 31st is `429` |
| H14 | Expiry | at the expiry time `can()` refuses without any job having run; the job then marks it `expired` |

## 13. Data model

Checked in `node:sqlite` with the invariants in `COORD/p5-schema-check.mts`. Block 410-419. `grants` is in [Authorization](authorization.md) §13.

```sql
CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL, target_id TEXT NOT NULL, target_pool_type TEXT,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user', 'team')),
  subject_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('view', 'operate', 'manage')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'declined', 'revoked', 'expired')),
  items TEXT NOT NULL,                 -- JSON: [{ type, id, poolType?, level, credential }] the ticked items; plus `removed`: credentials unassigned at activation
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  accepted_at TEXT, expires_at TEXT,
  ended_at TEXT, ended_by TEXT, ended_note TEXT
) STRICT;
CREATE INDEX shares_subject ON shares (subject_kind, subject_id, state);
CREATE INDEX shares_target ON shares (target_type, target_id, state);
```

Grants are rows made at activation (one per ticked item at `levelFor`), carrying `share_id`; revoking deletes `WHERE share_id = ?`.

## 14. API

`SHARING_API` in [`sharing.ts`](../../packages/contracts/src/sharing.ts).

| Route | Access | What |
| --- | --- | --- |
| `POST /api/shares/preview` | object manage (the target) | `SharePreview` |
| `POST /api/shares` | object manage (+ reauth for manage or credentials) | `CreateShareRequest` -> `Share` |
| `GET /api/shares?direction=\|object=` | signed in; managers for `object` | `Share[]` |
| `GET /api/shares/:id`, `PATCH /api/shares/:id`, `DELETE /api/shares/:id` | the creator, the subject, owners | read, narrow, end or leave |
| `POST /api/shares/:id/accept`, `.../decline` | the subject | |
| `GET /api/access?type=&id=` | object manage | `AccessList` |
| `POST /api/objects/transfer` | object manage and owner (+ reauth) | `TransferRequest` |

Errors: `SHARE_EXPOSES_CREDENTIALS` 409, `SHARE_CHANGED` 409, `SHARE_EXISTS` 409, `SHARE_LEVEL_TOO_HIGH` 403, `SHARE_SUBJECT_INVALID` 422.

## 15. What the person sees

Within the text diet. A **Share** entry sits in the ⋯ menu of a workspace, session, ticket, set, vault and account. One sheet, three steps on one screen:

1. **Who**: a field "Username" (exact; shows the person's name and avatar to confirm) or a segmented control Person | Team (a list of the person's teams). **Level**: View | Operate | Manage (Manage only when the person owns it).
2. **What comes along**: a checklist grouped by Workspace, Sets, Work, Knowledge ("Add a vault"), and, for Operate and above, **Credentials** at the bottom. Each row: the name and a short detail; the credentials rows start unticked. ONE terse line sits above Credentials: **"Anyone who can operate can read these. Unticked ones are removed from the workspace."** An ⓘ on it carries the rest: that a terminal reads delivered values and every Claude's sign-in, that Claude sign-ins stay readable, and that revoking cannot take back what was read.
3. **Share**: primary button; "Needs <name>'s OK" appears when acceptance is required; a password prompt appears when the server asks.

The object's sheet gets **Access**: the owner, then each person or team with their level, "since", an expiry if any, and End; a "Pending" subsection for shares waiting. **Shared with me** lives in the account menu and the Workspaces list header filter (shared ones carry one small people icon with an accessible name): each pending share shows who, what, and the same checklist read-only, with Accept and Decline. Ending shows the one-line note of §10 and, for credentials, a link "Rotate".

390 px: the sheet is a bottom sheet; the checklist scrolls; the button stays visible. Keyboard and touch reach every ⓘ.

## 16. Testing and verification

Done here (✅): the level query with grants, team grants, expiry, leaving a team and revoking a share (assertions in `COORD/p5-schema-check.mts`); the unique grant per share; `levelFor` and `isCredential` are pure and compile in contracts.

To build (packages S1 to S4): the matrix of §12, the consent hash property test (any change of the candidate set changes the hash), the sweep with a fake runtime (assignments removed through the safe unassign), the live-effects test with real sockets, the acceptance race test, the screens at 390 and 1280 px.

## 17. Milestones

| Milestone | Scope | Gate | Status |
| --- | --- | --- | --- |
| S0 | contracts (`sharing.ts`) | none | **Built** |
| S1 | `shares` and `grants`, preview/create/accept/narrow/end, the access list | Authorization A2 and A3 for the types shared | **Not built** |
| S2 | revocation effects: sockets, terminals, sessions, the assignment sweep, transfer | S1, Authorization A4 | **Not built** |
| S3 | the sheets: Share, Access, Shared with me | S1 | **Not built** |
| S4 | team sharing | [Teams](teams.md) T1 | **Not built** |

## 18. Decisions

| ID | Decision | Rejected, and why |
| --- | --- | --- |
| D19 | A share is a consented bundle of grants with its own record; narrowing is immediate, widening is a new share; unticked credentials are removed while it is shared; user shares at operate+ need acceptance | **Implicit inheritance** (a workspace share reaching its tickets and sets by relation): it defeats "each item checkable". **Hiding secrets from an operator** (impossible: a terminal reads them). **Blocking the share until the owner removes the secrets by hand** (the same outcome with more clicks and no record). **No acceptance** (spam, and running someone else's configuration under your own login without asking) |
| D19a | The consent hash | trusting the client's list (a set assigned in between is shared unseen) |
| D19b | Only owners grant `manage` | any manager re-sharing at manage (sprawl; an owner loses track of who can delete) |

## 19. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | Acceptance for `view` shares: automatic (default) or always? | Owner |
| Q2 | An unticked Claude: is "not usable through the portal, still readable in a terminal" enough, or should sharing at operate require the person to remove it (a Claude cannot be removed from a volume without deleting its login)? | Owner |
| Q3 | Should a share of a vault (or a ticket) to a person who cannot view the workspace it links to be refused, or fine? v1: fine | Product |
| Q4 | Expiry as a default (for example 30 days)? v1: none | Owner |

