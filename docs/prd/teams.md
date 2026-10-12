# PRD: Teams

| | |
| --- | --- |
| Status | **Draft v0.1** (2026-10-12). Design only: `packages/contracts/src/teams.ts` has landed and nothing else is built (**Not built**). The DDL and its invariants were run in `node:sqlite` (✅). 📄 = documented, 🔬 = unverified. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [Authorization](authorization.md), [Identity](identity-onboarding.md), [Sharing](sharing.md) |
| Related | [Multi-user overview](multi-user.md), [Tickets](tickets.md), [Pools foundation](foundation-pools.md), [Claude usage](claude-usage.md) (per-member figures for a team's owners) |

## 1. Summary

A **team** is a group of users that can own things and receive shares. A person creates teams, belongs to as many as they like, and is invited by username; the invited person must accept. A team has one or more **owners**, who alone decide who may join and who leaves, and it can never be without an owner. Members can share what they manage **to** the team (a workspace with the sets inside it, or a set on its own) and can create things **owned by** the team. A team is private: someone who is neither a member nor an invitee cannot tell that it exists.

The rights through a team are two numbers: on what a team **owns**, its owners hold `manage` and its members `operate`; on what is **shared to** it at a level, every member holds that level for as long as they are a member.

## 2. Background and what exists

Checked on 2026-10-12 (✅).

| Fact | Evidence | Consequence |
| --- | --- | --- |
| There are no groups of any kind: the nav has nine items and no Teams page; no table holds a membership | `app/nav.ts`, schema dump | new tables and a nav item |
| Objects are owned by one user (after this work) and shared by grants; `OBJECT_TYPES` already allows `team` as an owner kind for workspace, ticket, set, account, endpoint, vault, template | `authz.ts` | a team owner needs no new model: the level query has the team-owner term (checked) |
| Invitations by username need a rate-limited door; throttling rows are persistent | identity §8, `auth_throttle` | scopes `team_invite` and `lookup` |
| `u_owner` is the founding account and platform admin; a platform admin holds no right inside a team | authorization FR6 | an admin repairs a team with no owner through reassignment, not through membership |
| Usage per person for team and shared workspaces is a follow-on (PLAN-12) that needs "which members may this actor see" | `COORD/PLAN-12.md`, `MemberScope` in `authz.ts` | a team owner sees the members' figures of the team's workspaces |

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Create and belong to many teams.** |
| G2 | **Join by invitation and acceptance only**, rate-limited, decided by owners. |
| G3 | **A team always has an owner**, enforced in the service and in the database. |
| G4 | **Teams own and receive.** Team-owned objects and shares to a team follow the same consent and revocation rules as everything else. |
| G5 | **Leaving ends access at once**, with the same downstream effects as ending a share. |
| G6 | **Private by default.** A team is invisible to outsiders; its member list is visible to its members. |

## 4. Non-goals

- **Nested teams, groups of teams, org charts.**
- **Open teams** (anyone may join) and **join requests**. Owners invite.
- **Per-member levels on team-owned objects** (owners manage, members operate; Q2).
- **Team chat, mentions, team-level notifications settings.** A notification that concerns a team-owned object goes to each member who can see it, as for any object.
- **A directory of teams.** A team is found only through an invitation or by being in it.

## 5. Users and stories

| ID | Story |
| --- | --- |
| US1 | As a person, I create "Backend" and invite Ben and Chen by username; they accept; we share a workspace. |
| US2 | As Ben, I see an invitation from Alfian to "Backend", what the team owns, and accept or decline. |
| US3 | As a team owner, I promote Chen to owner so I can leave without leaving the team stranded. |
| US4 | As a member, I create a workspace owned by "Backend" so the whole team can operate it. |
| US5 | As a member of two teams, I share a set to one of them and not the other. |
| US6 | As a member who leaves, I lose the team's workspaces at once, and my running sessions in them end. |
| US7 | As a team owner, I see each member's usage of the team's workspaces (PLAN-12). |

## 6. Scope boundary

Owned here: the team, its members and roles, invitations, the invariants, team-owned objects, deletion. Owned elsewhere: what a share carries ([Sharing](sharing.md)), what a level means ([Authorization](authorization.md)), usage figures (the usage track).

## 7. Solution overview

```
 owner ─ invite @ben ─► pending invite ─(Ben accepts)─► member ──┐
                                                                 ├─► rights on team-owned objects: owners manage, members operate
 owner ─ remove / demote ─► (never the last owner)               └─► rights on objects shared to the team: the shared level
 member ─ leave ─► gone at once: rights end, live things cut, the assignment sweep runs
```

## 8. Functional requirements

- **FR1 (create)** Any active user creates a team (`name` 1 to 40 characters, optional description up to 200); the creator is its first owner. A person belongs to at most 50 teams (a guard, not a product limit). Names are not unique; the screen shows the creator's name beside it.
- **FR2 (roles)** `owner` and `member`. Owners invite, remove members, change roles, rename, delete, and hold `manage` on team-owned objects. Members leave, see the members, create team-owned objects, share what they manage to the team, and hold `operate` on team-owned objects.
- **FR3 (invite)** An owner invites an ACTIVE user by exact username, as a `member` or a co-`owner`. The invitee sees the invitation in their account (`GET /api/teams/invites`) with the team's name, who invited, the member count, and what the team owns by type and count ("3 workspaces, 2 sets"), and **accepts or declines**. Nothing happens to them until they accept. A pending invitation expires in 14 days.
- **FR4 (limits)** An owner sends at most 20 invitations a day across teams; one person holds at most 10 pending invitations from all teams; one pending invitation per (team, person) (a partial unique index ✅); a team has at most 200 members. Counters are `auth_throttle` rows (`team_invite`). A decline is not held against the invitee. Inviting oneself, a member, a disabled or pending account, or an unknown name gets one answer (`SHARE_SUBJECT_INVALID`-style: `422`).
- **FR5 (always an owner)** A team can never be without an owner. Refused in the service (`409 TEAM_NEEDS_OWNER`) and by two database triggers (delete and role change of the last owner ✅). An owner may leave only when another owner exists; the last owner of a team that owns nothing may delete it instead.
- **FR6 (remove, leave, demote)** Owners remove members and demote other owners (never the last); any member leaves. Each ends the person's rights from the team at once ([Authorization](authorization.md) FR23, FR24): their live sockets, terminals and sessions in team workspaces are cut and ended, the assignment sweep runs, and the team's owners are told through the notification bus when it exists.
- **FR7 (team-owned objects)** A member creating an object chooses its owner: themselves or one of their teams (`ownerTeamId` on the create request of workspace, ticket, set, account, endpoint, vault, template). The creator keeps no special right on it beyond their team role. An owner of an object may transfer it to a team they belong to ([Sharing](sharing.md) FR16).
- **FR8 (shares to a team)** A member who holds `manage` on an object shares it to a team they belong to through the ordinary consent screen; it is active at once; each current and future member holds the level. The screen says "everyone in the team, now and later". A team's owners see every share to the team and may end any of them.
- **FR9 (delete)** Owners delete a team only when it owns nothing (`409 TEAM_OWNS_OBJECTS` with counts: move them first). Deleting ends every grant to the team (each sharer is told) and every pending invitation, and writes `team.deleted`. The order in SQL is the `teams` row first, then its members, which the triggers allow ✅.
- **FR10 (disabling the last owner's account)** Disabling a user who is the only owner of a team is refused (`409 TEAM_NEEDS_OWNER`, listing the teams). A platform admin passes `reassign` ([Identity](identity-onboarding.md) FR35), which also makes the chosen user an owner of those teams.
- **FR11 (visibility)** A member sees the team and its members (name, avatar, role, joined). An invitee sees the invitation. Everyone else gets `404` for the team id, for its invitations and for its member list; no list, count or search reveals it.
- **FR12 (member scope for usage)** For a team and for a workspace the team owns, `memberScope` returns every member to the team's owners and only themselves to a member ([Authorization](authorization.md) `MemberScope`); for a workspace shared to the team, the workspace's managers decide, not the team's roles.
- **FR13 (audit)** `team.created`, `team.renamed`, `team.deleted`, `team.invited`, `team.invite_accepted`, `team.invite_declined`, `team.invite_revoked`, `team.member_removed`, `team.left`, `team.role_changed`, each with the actor and the person concerned.

## 9. Rules in one table

| Action | Who | Needs |
| --- | --- | --- |
| Create a team | any active user | |
| Invite | owner | the invitee is active, not a member |
| Accept or decline | the invitee | signed in as them |
| Revoke an invitation | owner, or the inviter | |
| Remove a member | owner | not the last owner |
| Change a role | owner | not demoting the last owner |
| Leave | member | not the last owner |
| Rename | owner | |
| Delete | owner | the team owns nothing |
| Share to the team | a member who manages the object | consent screen |
| Create a team-owned object | a member | |

## 10. Teams and rights (the three places a team appears in `can`)

1. **Owner of an object** (`owner_kind = 'team'`): owners `manage`, members `operate` (`TEAM_OWNER_LEVEL`, `TEAM_MEMBER_LEVEL`). ✅ term 2 of the level query.
2. **Grantee** (`subject_kind = 'team'`): the grant's level, for each member. ✅ term 4.
3. **Notification recipients**: `ownersOf(ref)` returns a team's owners for a team-owned object; `usersWith(ref, verb)` returns everyone who holds the verb.

## 11. Security and threat model

| ID | Abuse | Control |
| --- | --- | --- |
| T1 | Invitation spam to a person | 20/day per owner, 10 pending per invitee, one per (team, person), decline, 14-day expiry |
| T2 | Phishing with a look-alike team name | the invitation shows who invited (name, username, avatar), the member count and what the team owns; names are not unique and not trusted |
| T3 | Joining someone to gain access to their things | an invitee gets access to the TEAM's objects only, and only after accepting; their own objects are untouched |
| T4 | Taking over a team by removing owners | at least one owner at all times (service and triggers); only owners change roles; a race between two owners removing each other is serialised by the database (`BEGIN IMMEDIATE`, triggers) |
| T5 | A member escalates to owner | only an owner changes a role |
| T6 | A member who left keeps access through a live socket, terminal, running session or assignment | FR6: cut at once, sessions ended, sweep run (tested X10 for teams) |
| T7 | Enumeration of teams | `404` for non-members; no directory; invitations only to the invitee |
| T8 | A team owner reads members' private work | a team holds no right on a member's private objects (sessions, personal things); owners see members' usage figures only, never content |
| T9 | A deleted team's objects orphaned | refused while it owns anything; shares to it end with notice |
| T10 | Disabled owner locks the team | refused unless reassigned (FR10) |
| T11 | Invite a disabled or pending account to learn it exists | the same `422` for unknown, disabled, pending and self |
| T12 | IDOR on team, invitation and member ids | every route resolves the team through the membership; a non-member gets 404 |

## 12. Test matrix (executable; extends Authorization §12)

| ID | Case | Expected |
| --- | --- | --- |
| M1 | B (not a member) reads A's team, its members, its invitations, its shares | 404 |
| M2 | A invites B, B accepts; a second invite while pending; a decline then a new invite | 409 on the second; allowed after the decline |
| M3 | The last owner leaves, is demoted, is removed, or the team is deleted with objects | `409 TEAM_NEEDS_OWNER` / `TEAM_OWNS_OBJECTS`; the database triggers also abort a raw `DELETE` |
| M4 | Two owners demote each other at once | exactly one succeeds; an owner remains |
| M5 | A member promotes themselves or invites | 403 |
| M6 | B leaves a team that owns a workspace B has a session and a shell in | B's sockets close within 1 s, the session ends, B's next call is 404 |
| M7 | B joins: instantly sees the team workspace at operate and the team shares at their levels | |
| M8 | 21 invitations in a day; 11 pending for one person | the 21st and the 11th are refused |
| M9 | Disable a sole owner | `409`; with `reassign` it succeeds and the new owner is an owner |
| M10 | A shares a workspace to a team; B joins later; A revokes | B had access while a member; none after |
| M11 | Usage scope | a team owner's `memberScope` lists the members; a member's lists themselves only |

## 13. Data model

Checked in `node:sqlite` (`COORD/p5-schema-check.mts`: the triggers abort the last owner's delete and demotion, the team can be deleted team-row-first, one pending invitation per team and person). Block 420-429.

```sql
CREATE TABLE teams (
  id TEXT PRIMARY KEY CHECK (id GLOB 'tm_*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  description TEXT,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL
) STRICT;
CREATE TABLE team_members (
  team_id TEXT NOT NULL, user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
) STRICT;
CREATE INDEX team_members_user ON team_members (user_id);
CREATE TRIGGER team_members_keep_owner_delete BEFORE DELETE ON team_members
WHEN OLD.role = 'owner' AND EXISTS (SELECT 1 FROM teams WHERE id = OLD.team_id)
  AND (SELECT count(*) FROM team_members WHERE team_id = OLD.team_id AND role = 'owner' AND user_id <> OLD.user_id) = 0
BEGIN SELECT RAISE(ABORT, 'TEAM_NEEDS_OWNER'); END;
CREATE TRIGGER team_members_keep_owner_update BEFORE UPDATE OF role ON team_members
WHEN OLD.role = 'owner' AND NEW.role <> 'owner'
  AND (SELECT count(*) FROM team_members WHERE team_id = OLD.team_id AND role = 'owner' AND user_id <> OLD.user_id) = 0
BEGIN SELECT RAISE(ABORT, 'TEAM_NEEDS_OWNER'); END;
CREATE TABLE team_invites (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL, invited_user TEXT NOT NULL, invited_by TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT
) STRICT;
CREATE UNIQUE INDEX team_invites_one_pending ON team_invites (team_id, invited_user) WHERE state = 'pending';
CREATE INDEX team_invites_user ON team_invites (invited_user, state);
```

## 14. API

`TEAMS_API` in [`teams.ts`](../../packages/contracts/src/teams.ts).

| Route | Access | What |
| --- | --- | --- |
| `GET /api/teams`, `POST /api/teams` | signed in | my teams; create |
| `GET/PATCH/DELETE /api/teams/:id` | member / owner / owner | read; rename; delete |
| `GET /api/teams/:id/members`, `PATCH`/`DELETE /api/teams/:id/members/:userId` | member / owner | list; role; remove |
| `POST /api/teams/:id/leave` | member | leave |
| `GET/POST /api/teams/:id/invites`, `DELETE /api/teams/:id/invites/:inviteId` | owner | pending; invite; revoke |
| `GET /api/teams/invites`, `POST .../:inviteId/accept`, `.../decline` | the invitee | |

Errors: `TEAM_NEEDS_OWNER` 409, `TEAM_OWNS_OBJECTS` 409 (`details.owns`), `TEAM_INVITE_EXISTS` 409, `TEAM_FULL` 409.

## 15. What the person sees

Within the text diet. **Teams** is a nav item in the work group (icon `Users`), with a number badge for waiting invitations.

- **List**: team rows (name, member count, my role as a quiet chip), "New team" (one field), and an **Invitations** section only when there are some: each row shows the team, who invited, "owns 3 workspaces, 2 sets", Accept and Decline.
- **Team sheet**: **Members** (avatar, name, role chip; a row menu for owners: Make owner, Remove; "Leave" for everyone), **Invite** (a username field with the exact lookup showing name and avatar; Member or Owner), **Pending** (revoke). A header menu: Rename, Delete (disabled with an ⓘ while the team owns things: "Move its objects first").
- **Owned by**: the create dialogs of workspace, set, vault, ticket gain one row "Owner: Me | <team>" (a segmented control only when the person is in a team).
- **Share to a team** is the ordinary Share sheet ([Sharing](sharing.md) §15) with Person | Team.

390 px: lists and sheets as bottom sheets; the member list scrolls; Invite stays reachable.

## 16. Testing and verification

Done here (✅): the triggers and the partial unique index (`COORD/p5-schema-check.mts`), the level query for team owners, members and team grants, leaving a team removing access.

To build (packages T1 to T3): the matrix of §12; a concurrency test for T4 (two transactions removing each other's ownership); the invitation limits by hand-computed counts; the screens at 390 and 1280 px.

## 17. Milestones

| Milestone | Scope | Gate | Status |
| --- | --- | --- | --- |
| T0 | contracts (`teams.ts`) | none | **Built** |
| T1 | tables, invariants, create/invite/accept/leave/remove/roles/delete, limits, audit | Sharing S1 | **Not built** |
| T2 | team-owned objects, shares to a team, `memberScope` for teams, revocation effects for leaving | T1, Sharing S2 | **Not built** |
| T3 | the Teams page, invitations, "Owner" rows in create dialogs | T1 | **Not built** |

## 18. Decisions

| ID | Decision | Rejected, and why |
| --- | --- | --- |
| D18 | Two roles, owner and member; owners invite and decide; members operate what the team owns; invariants in the service and in triggers | **Per-object member levels** (a second dimension to explain and test; Q2). **Join requests and open teams** (spam and no owner decision). **Members may invite** (the owner's text says owners decide who may join). **Only a service check for "never without an owner"** (a bug, a CLI, or a race could break it; two triggers cost nothing) |

## 19. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | May members propose invitations that an owner approves (a "suggest" step)? v1: no | Owner |
| Q2 | A per-team setting for the member level on team-owned objects (view, operate)? v1: operate | Owner |
| Q3 | Should a person be able to decline and block a team's future invitations? v1: no | Product |
| Q4 | Moving an object into a team: should the team's owners have to accept? v1: no, the person is a member | Owner |

