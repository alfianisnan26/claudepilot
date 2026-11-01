# PRD: Fine-grained org access

| | |
| --- | --- |
| Status | **Built** 2026-11-01, branch `feat/org-fine-grained-access` (server, web, browser check). Not deployed by this branch. |
| Owner | Alfian Isnan |
| Asked | Owner, 2026-11-01: "refine access management on the org level and delegation, ensure we can do properly fine grained access level. also make a good UI/UX for permissioning process flow". |
| Builds on | [Organizations](organizations.md) §6.2-§6.5 (roles, org shares, the seam's org arm), [Authorization](authorization.md) §10 and §13 (levels, the `grants` table), [Sharing](sharing.md) (credentials consent). D-82, D-108. |
| Code | `packages/contracts/src/access.ts`; `apps/server/src/orgs/{sharing,access,routes,authz}.ts`, `apps/server/src/authz/grants.ts`; migration 477; `apps/web/src/features/orgs/{AccessSection,AccessSheet,accessUi,accessRules}.tsx`; `tools/qa/org-access.mjs` |

## 1. Summary

One model, no second system. A **grant** is still a `grants` row made by an **org share** (`org_shares`). A share now goes to the whole org,
a team **or one person**, at **view, operate or manage**, may **end by itself**, and carries a **note**. Who may grant is spelled out and
enforced (the **ceiling**). Members **ask** for access and the people who may grant it **decide** in an inbox. Every object answers **who can
reach it and why**, every person **what they reach and why**, and anything shared can be ended with one tap. Org settings' Sharing section
became **Access**, and each object has an **Access sheet** with a three-step grant flow.

## 2. Objects and levels

| Object | View | Operate | Manage |
| --- | --- | --- | --- |
| Workspace (its CI remotes, runs and terminals follow it) | See it and its status; read sessions and transcripts read-only; see CI runs | View, plus start, send to and stop sessions; open terminals; run CI; **read the credential sets delivered into it** | Operate, plus change settings and sets, grant and revoke access, move or delete it |
| Ticket bucket | See the bucket, its tickets, comments and history | View, plus create, edit, move and comment on tickets | Operate, plus change the bucket, grant and revoke, move or delete |
| Vault | Read notes, links and the graph | View, plus create, edit and delete notes | Operate, plus change the vault, grant and revoke, move or delete |

The words live in `ACCESS_LEVEL_INFO` (contracts) so the cards, the InfoTips and this table say the same thing. **Sessions** keep their own
per-session share (read, send, approve, stop; chat `ShareSessionDialog`): a session belongs to its creator (D14) and is not a grant target here.

## 3. Subjects

| Subject | Who receives it | Levels |
| --- | --- | --- |
| Everyone (`org`) | The org's active members and admins and owners, **never guests** | view, operate (manage to a whole org is refused) |
| Team | The team's members while they are active members of the team's org (a guest in the team too) | view, operate, manage |
| Person (`user`, new) | One active member of the org (a guest too); never yourself | view, operate, manage |

A person share counts only while that person is an active member of the share's active org: a join in the grant query (`authz/grants.ts`),
and the membership triggers end it (`member_left`) when they leave or are removed. Coming back does not bring it back.

## 4. Who may grant (the ceiling)

`OrgSharing.ceiling` decides, read on every grant:

1. A **person** (not a token, not an agent), **member or up** (a guest never grants), holding **manage** on the object through the seam (so a
   suspended org, requireSso and a capped session count). Holding operate is not enough: there is no re-share below manage.
2. **Never above their own level** and **never past their own end**: when their manage comes only from grants (a manage share to them or a
   team they are in, a creator grant), the latest end among those grants is the latest end they may give (`maxUntil`); "No end" is then
   refused (403 `ACCESS_ABOVE_OWN`, with `max` and `maxUntil`).
3. On an **org-owned** object: its org's **owners** always; its **admins** while the owners' policy **`adminsMayShare`** is on (default on;
   Org settings > Policies > Admins share; off: 403 `ACCESS_SHARING_OWNERS_ONLY`, admins still manage the object and see who has access);
   anyone holding manage on it **through a grant** (delegation). An org object is shared only inside its org.
4. On a **personal** object: its owner, or someone who manages it through a grant (same end rule).

This replaces slice 7's "only its owner gives manage to a team": anyone who may grant may give up to manage, to a team or a person.

## 5. Ends and notes

`expiresAt` is optional: at least a minute ahead, at most 365 days. It is written on the share and on its grant; every decision reads the
grant's `expires_at`, so access stops **at that instant** with no job. The minute sweep (`OrgSharing.sweepExpired`, app.ts) then deletes the
grant, ends the share as `expired` (`ended_by = system:access-expiry`), writes `org.share_expired` and tells the receivers' sockets and running
sessions (`share_ended`). A note (at most 200 characters, control characters folded) is shown to managers and kept in the audit. Sharing
again to the same subject changes the level, the end and the note; a lower level or an earlier end tells the receivers at once.

## 6. Access requests

- **Ask:** a member (not a guest) asks for a level on an **org-owned** object of that org that they hold less on, with a note. One open
  request per person and object (409 `ACCESS_REQUEST_OPEN`); asking for what you hold is 409 `ACCESS_ALREADY_HELD`. A person's own object is
  not asked for here (its owner shares it).
- **Told:** the org's owners, its admins while `adminsMayShare`, and whoever manages the object through a grant get an `attention`
  notification (fixed words and the org's name; the object's name is the untrusted detail) that opens Org settings at Access
  (`/admin/orgs/<id>?tab=access`).
- **Decide:** whoever may grant it (the ceiling) approves with a level (default what was asked) and an end, or denies with a note. Approval
  makes a person share through the same code as any grant, so the ceiling, the credentials consent and the audit apply. The requester is told.
- **Cancel:** the requester, while it is open.
- **Lists:** deciders see every open request they may decide and the last 50 decided; anyone else sees their own.

## 7. Who reaches what, and why

- **An object** (`GET /api/orgs/:id/access/object?type=&id=`, needs view on it, else the same 404): its owner (or "Owners and admins" for an
  org object), creator grants, every open share in this org with its end, note and whether the caller may end it; the caller's own reasons;
  what the caller may grant (`mayGrant`, `maxUntil`); a workspace's credential sets (for someone who may grant); the caller's open request.
  The full list is for someone who may grant or an org owner or admin; anyone else sees only their own reasons.
- **A person** (`GET /api/orgs/:id/access/people/:uid`, org owners and admins, or anyone for themselves): every org object and every
  personal object shared into the org that they reach, each with the **seam's** level (`levelOf`: a suspended org, a guest's exclusion from
  org shares, requireSso all count) and the reasons, from the **same grant query** the decision reads (`Grants.sourcesFor` and `levelFor`
  share one SQL), so the explanation and the decision cannot drift.
- **One-tap revoke:** each share row the caller may end (who made it, an org owner or admin, a manager of the object) has an X; ending is
  the existing `DELETE /api/orgs/:id/shares/:shareId`.

## 8. UI (Org settings > Access, and the Access sheet)

- **Access** replaces Sharing. Owners and admins: **Objects** (each opens its sheet, with your level), **People** (what each reaches and why,
  with the X), **Requests** (the count of what waits for you; Decide). Members: Objects (your level; ask for more), **Mine**, Requests (yours,
  Cancel). Guests: not shown. Objects rows in the Objects section also open the sheet (the key icon).
- **The sheet:** You (level and why), who has access (highest first), then **Give access** in three steps: **Who** (Person, Team or Everyone,
  with search) -> **Level** (three cards with an icon, one line and an InfoTip listing exactly what it allows; a level above yours, or manage
  to everyone, is shown disabled; operate on a workspace with credential sets shows the warning and a tick) -> **Until** (No end, 7 days, 30
  days, Date; choices past your own end are left out) and a note -> **Review** -> **Grant**. Without the right to grant: **Request access**
  (level cards above yours, a note).
- Phone first (390 px), 44 px targets, focus rings (no outline-none), light and dark, the app's Dialog (a sheet on phones; the header is not a
  drag handle), text diet (one or two word titles, explanations in InfoTips).

## 9. API (declared in `orgs/authz.ts`, `org` view; the service decides the rest)

| Route | What |
| --- | --- |
| `POST /api/orgs/:id/shares` | Grant: `subject` `{kind:'org'}`, `{kind:'team',teamId}` or `{kind:'user',userId}`; `level`; `expiresAt?`; `note?`; `acknowledgeExposure?` |
| `DELETE /api/orgs/:id/shares/:shareId` | Revoke (unchanged) |
| `GET /api/orgs/:id/access/catalog` | The org's objects with your level and open request (members and up) |
| `GET /api/orgs/:id/access/object?type=&id=` | `ObjectAccess` |
| `GET /api/orgs/:id/access/people/:uid` | `PersonAccess` |
| `GET, POST /api/orgs/:id/access/requests` | List; ask |
| `POST /api/orgs/:id/access/requests/:requestId/approve`, `/deny` | Decide |
| `DELETE /api/orgs/:id/access/requests/:requestId` | Cancel (the requester) |

An outsider gets the org's 404 on every one of them; an object the caller may not see answers like a missing one.

## 10. Data (migration 477, organizations block)

`org_shares` rebuilt (SQLite cannot change a CHECK): `subject_kind` gains `user` (`subject_id GLOB 'u_?*'`), `expires_at`, `note` (<= 200),
`end_reason` gains `expired`, index on open ends; its triggers made again, and the membership triggers also end shares **to** a person who
stops being an active member. `access_requests` (`arq_…`; org, object, requester, level, note, state open/approved/denied/cancelled, the
decision, the share it made; one open per person and object). Numbered after 476 on purpose: a fresh database runs migrations in order.
Policy `adminsMayShare` (JSON on the org, default on; `ORG_SETTABLE_POLICIES`).

## 11. Audit (the org's audit lists them; filter Sharing or Requests)

`org.share_created` (with `expiresAt`, `note`, and `requestId` when an approval made it), `org.share_ended`, `org.share_expired`,
`org.access_requested`, `org.access_request_approved`, `org.access_request_denied`, `org.access_request_cancelled`, `org.updated`
(the policy).

## 12. Tests

- Server `orgs/orgsAccess.test.ts`: a person share with a note; no grant without manage; delegation up to manage but never past the granter's
  end; who may receive; `adminsMayShare`; an end stops access at its instant on a fake clock, the sweep closes the record, audits and tells
  the receiver; a person share counts only while a member (the join, with the trigger dropped) and leaving ends it; requests (ask, guests
  refused, the deciders told, lists, approve with less than asked and an end, deny, cancel, audit); effective access (each item's level is the
  seam's and its reasons' top level; a guest gets no org-wide share; members see only their own); the notification's link; the routes
  (declared, the same 404 for an outsider and for a hidden object). Slice 7, settings and seam files run unchanged.
- Web `features/orgs/accessRules.test.ts` (tabs by role, the ceiling on the cards, manage never to everyone, the credentials warning, ends
  and the granter's end, words, request order) and `settingsRules.test.ts` (Access replaces Sharing).
- Browser `tools/qa/org-access.mjs` (390 and 1280, light and dark): `?tab=access`, the tabs and the waiting count, the sheet, the whole grant
  flow, one-tap end, Decide; 44 px at 390, no sideways scroll, a focus ring. `tools/qa/org-settings.mjs` lists Access.

## 13. Not in this slice

- Access sheets on the workspace, bucket and vault pages themselves (the sheet is a component; Org settings' Objects and Access open it).
- Requests for a personal object, or by a guest; requests expiring on their own.
- `externalShares` (no share leaves its org); shares to another org's people.
- Sessions in the grant model (they keep the per-session share).
- Reminders before a share ends (the `expiring` notification kind is not emitted).
