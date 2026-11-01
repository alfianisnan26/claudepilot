# PRD: Organizations and organization SSO

| | |
| --- | --- |
| Status | **Draft v0.1** (2026-10-31). Slices 0 and 3 built on branches (see §13.3); the rest **Not built**. Written from the code on `origin/main` at `e311a679` (portal 2026.10.31-5), the multi-user PRDs and the standing decisions. ✅ = checked in the code here (file:line), 📄 = documented elsewhere (linked), 🔬 = unverified. §14 is an honest review of the multi-user state today and lists what must change BEFORE organizations are safe. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-31 |
| Request | Owner, 2026-10-31: "enhance Pilot user management: Organization based — a user can create an organization and share a workspace/project to the organization level; an organization can integrate its own SSO; please double check the approach of multi-user management." Ticket: none (owner request). |
| Depends on | [Authorization](authorization.md) (the seam, `can`, grants), [Identity and onboarding](identity-onboarding.md), [Sharing](sharing.md), [Teams](teams.md), [Multi-user overview](multi-user.md) |
| Related | [Secrets & env](secrets-env-pool.md) (the sealed column for client secrets), [Portal MCP](portal-mcp.md) (tokens), [Targets & Connect](targets-connect.md), [UI reporter server](ui-reporter-server.md) (`cprt_` tokens), [General Manager](general-manager.md), DECISIONS D-23, D-33, D-53, D-56, D-82 |

## 1. Summary

An **organization** (`org_…`) is a group of people that owns things together: workspaces, ticket buckets (projects), vaults, sets, templates. A person keeps a **personal space** (what they own as a user, as today) and may belong to any number of organizations, each with a role: **owner**, **admin**, **member** or **guest**. Inside an organization people form **teams**. Anything a person or an organization owns can be **shared to the whole organization or to one of its teams** at a level (view or operate), through the same consented, revocable grants the [Sharing](sharing.md) PRD designs. An organization may bring its **own OpenID Connect provider**: once it has proved it holds an email domain (a DNS TXT record), people on that domain sign in through it, are created in the organization on first sign-in with a default role, get roles and teams from the provider's groups, and the organization may require it.

None of this adds a second authorization system. An organization is one more **owner kind** and one more **grant subject** in the one `can()` of the seam; the UI's "context" is a filter, never a source of rights.

The review in §14 is the important half: today every admin account, every Portal MCP token, every reporter token and every VS Code client token acts as the founding user `u_owner` inside `can()`, most object types have no owner column, and about a third of the route registrations have no declaration. Organizations would multiply those gaps across tenants, so §13 puts the prerequisites first.

## 2. Background and what exists

| Piece | State on `main` (✅ checked) |
| --- | --- |
| Accounts | Email + scrypt accounts, roles `admin` / `member`, state `active` / `disabled` (`store/migrations.ts:3480`, `identity/users.ts`). The 8-digit server code still works. |
| Sessions | An admin account's session is a FULL session, a member's is not (`portal.ts:145-152`); members reach only `/api/me…`, their teams and shared sessions (D-82 S1a). |
| Authorization | The seam's single-owner implementation (`authz/seam.ts:207-270`); resolvers for `session`, `ticket_bucket`, `trigger`, `ci_*`, `target`. No grants table, no workspace owner, no real layer (`useAuthz` is never called outside tests). |
| Sharing | Session shares only (one chat session to a user or a team, with caps read / send / respond / stop and an end; `session_shares`, `store/migrations.ts:3572`; `identity/grants.ts`). Workspace sharing is not built. |
| Teams | Global teams with owner / member roles (`store/migrations.ts:3549`, unique name across the whole portal at `:3557`); used as a share subject and as an SSO default team. |
| SSO | Instance-wide OIDC providers by email domain, PKCE, nonce, a browser-binding cookie, the SSRF guard, sealed client secret, JIT accounts with a default role and team (`identity/sso.ts`, `identity/oidc.ts`, `store/migrations.ts:3606`). No domain verification, no groups, no per-org provider. |

The PRDs still say "SSO: later" ([Identity](identity-onboarding.md) §4, [Authorization](authorization.md) §4) and "Not built" for teams and sharing, while code for all three exists in a different shape (email instead of username, session shares instead of share bundles). §14.2 lists the drift.

## 3. Goals

| ID | Goal |
| --- | --- |
| O-G1 | A person creates an organization, invites people, and the organization owns workspaces, projects (ticket buckets), vaults, sets and templates together. |
| O-G2 | Share a workspace or a project to a whole organization or a team in it, at view or operate, with the consent screen (credentials off by default) and instant revocation. |
| O-G3 | One `can()`: organizations are an owner kind and a grant subject, decided by the seam with the same 404 for what you may not see. |
| O-G4 | An organization brings its own OIDC provider, limited to the email domains it has proved it holds; JIT into the organization, groups to roles and teams, SSO required if it wants. |
| O-G5 | Upgrading loses nothing: the migration creates three organizations (isnan, konfersi, kohilabs), assigns today's resources to them by project (§11), and the owner stays owner of all three; the server code still gets the instance admin in. |
| O-G7 | A global **Admin console** on its own host (`admin.pilot.ai.isnan.me`, §6.11) lets instance admins manage users, abilities (create organizations), suspensions, sessions, SSO providers and audit; the main portal serves no admin page. |
| O-G6 | Leaving, removal, deletion and SSO de-provisioning have a defined, tested effect on every right and every running thing (sockets, sessions, terminals, tokens). |

## 4. Non-goals

SAML in v1 (§9.9); SCIM in v1 (§9.6); billing, quotas and plans per organization; cross-portal federation; an organization-level policy language; nested organizations or organizations owning organizations; making the portal public or commercial (D-53: internal only, Konfersi and Kohilabs); an org admin reading a transcript without an audit row, or an instance owner entering an org without a break-glass entry (§6.5, §6.7, decisions OD-3 and OD-4).

## 5. Users and stories

| ID | Story |
| --- | --- |
| OS1 | As the owner, I upgrade and see the same things; my existing accounts and teams are now in one organization I own. |
| OS2 | As the owner, I move the `konfersi` workspaces and the KONF bucket into the Konfersi organization, and share KONF to the "Konfersi" org at operate. |
| OS3 | As an org admin, I invite a colleague by email; they accept and see what was shared to the organization and to their teams, nothing else. |
| OS4 | As an org admin, I add our Google Workspace as the org's sign-in, prove `konfersi.com` with a TXT record, and turn on "Require SSO". |
| OS5 | As a new colleague, I type my work email, land on our IdP, come back already a member of Konfersi with the teams my groups say. |
| OS6 | As an org admin, I remove someone; their sessions in our workspaces stop, their sockets close, their tokens stop reaching our objects, at once. |
| OS7 | As a person in two organizations, I switch between Personal, Konfersi and Kohilabs; lists and "New" default to where I am. |
| OS8 | As the instance owner, I can recover an organization whose last owner is gone, without reading its content. |

## 6. The model

### 6.1 Entities

| Entity | What it is | Key rules |
| --- | --- | --- |
| Organization `org_…` | A name, a slug (unique, used in URLs and the switcher), a state (`active` / `suspended` / `deleting`), policies (§6.6) | Always has at least one active owner (service + trigger, like teams). Created by an account holding the ability `orgs.create` (granted by an instance admin in the Admin console, off by default; OD-2), or by an instance admin. |
| Membership | `(org, user, role, state, joined_at, via)`; `via` = `invite` / `sso_jit` / `domain_join` / `migration` / `created` | Roles: `owner` > `admin` > `member` > `guest`. One row per person per org. |
| Team `tm_…` | Belongs to exactly one organization (`teams.org_id`). Team roles stay `owner` / `member` ([Teams](teams.md) D18). | Only members of the org may be in its teams; leaving the org leaves its teams (trigger). Team names are unique per org, not per portal. |
| Personal space | What a person owns as `owner_kind = 'user'` (today's model, unchanged) | Never reachable through an org role (§6.5). |
| Org-owned object | Any type whose `OBJECT_TYPES[type].owners` includes `org` (§6.3) | Its creator gets an automatic `manage` grant (so a member who made it can run it); org owners and admins hold `manage`. |

### 6.2 Roles

| Role | On the org itself | On org-owned objects | Org-wide shares | Members, teams, SSO, domains, policies, audit |
| --- | --- | --- | --- | --- |
| owner | manage, delete, transfer ownership | manage | receives | all; the only role that changes owners, SSO enforcement and deletion |
| admin | manage (not delete) | manage | receives | invite, remove, change roles up to admin, teams, SSO config, domains, read the org audit |
| member | view (name, its teams, the member directory) | only what a grant gives (to the org, a team, or them) | receives | create teams (OD-2 policy `membersCreateTeams`, default on), invite only if `membersMayInvite` (default off, MO3) |
| guest | view (name only; no directory) | only grants to them or to teams they are in | **does not** receive org-wide grants | nothing |

Guests are for contractors and for a domain-unverified email in an SSO-required org. They make "share to the org" safe to use without vetting every account first.

### 6.3 What can be owned by whom

| Type | Owners after this PRD | Note |
| --- | --- | --- |
| workspace | user, team, **org** | Needs `workspace_owners` (Authorization §13) first; today no workspace has an owner (§14.3). |
| ticket_bucket (project) | user, team, **org** | `ticket_buckets.owner_id` exists ✅; gains `owner_kind`. A ticket follows its bucket. |
| vault | user, team, **org** | `kg_vaults` has no owner column today (§14.3). |
| pool (any set type), account, endpoint, account_pool, template | user, team, **org** | Secrets sets owned by an org are the org's credentials: assigning one still needs `manage` on the target workspace and the consent rules of Sharing. |
| ci_repo, ci_run, repo, browser, terminal | inherit from the workspace | No own owner. A CI remote's credentials come from the sets assigned to its workspace. |
| session | **user only, private** | A session belongs to its creator (D14) and no org role gives `send` or `operate`. Exception (OD-3): in an **org-owned workspace** org owners and admins may read the transcript, see the metadata and stop the session; every transcript view is audited and visible to the member (§6.5). |
| claude (a workspace Claude login) | **user only** | D-33, D-53, D-56: a login is the person's; an org can only receive it by the person's consented contribution, never own it. |
| trigger, personal (tokens, devices, notification destinations) | user only | A trigger in an org workspace still runs as its owner with `can` at run time. |
| target | platform, **org** (later slice) | An org admin may enrol a Connect host for the org only (`platform(targets)` stays for instance-wide ones); host-level targets stay instance-admin only (D15). |
| mcp_entry, skill_* | platform, user (library) | Unchanged; an org-private library is an open question (§12, Q3). |

### 6.4 Sharing at the org level

A share is the [Sharing](sharing.md) bundle of grants, with one more subject kind:

- **Subjects:** `user`, `team`, **`org`** (every active member, admin and owner; never guests). A team subject must belong to the same org as the sharer's context, or to an org the sharer is in.
- **Levels:** view or operate to an org; view, operate or manage to a team or a user. `manage` to a whole org is refused (it would let any member re-share and delete). Fine-grained access ([access.md](access.md), 2026-11-01) built the person subject, ends and notes, the ceiling (a granter gives at most their own level, never past their own end; admins share by role while the owners' `adminsMayShare` is on) and access requests.
- **What may be shared where:** a personal object may be shared to any org or team the owner belongs to. An org-owned object is shared inside its org freely (by its managers); to a user or team **outside** the org only when the org policy `externalShares` is on (default off), and never to an org.
- **Share vs transfer:** sharing keeps the owner; **Move to organization** changes `owner_kind/owner_id` (needs `manage` on the object and `member`+ in the org; audited `object.transferred`; credential assignments of the object are re-shown on a consent screen and unticked ones removed, as Sharing D19 already does). Moving back out of an org needs org `admin`.
- **Credentials:** off by default on every consent screen; an org-wide share never carries a secrets set the sharer does not own.
- **Acceptance:** shares to an org or a team need no acceptance (their admins already accepted being there); shares to a person keep MO7.

### 6.5 How it maps onto the seam

Contract changes (`packages/contracts/src/authz.ts`): `OwnerKind` gains `'org'`; `ObjectType` gains `'org'` (owned by `platform`, levels from membership); `OBJECT_TYPES[t].owners` gains `'org'` for the types of §6.3; `MemberScopeSubject` gains `{ kind: 'org', id }`; `AccessChange.why` gains `'org_membership_ended' | 'org_suspended'`. The `grants` table of Authorization §13 gains `subject_kind = 'org'`.

The decision (Authorization §10) gains three lines and keeps every other rule:

```
held := max( owner(user) = manage
           , teamRole(owner team) → owner: manage, member: operate
           , orgRole(owner org)   → owner|admin: manage, member|guest: none      -- NEW
           , grants to user, to the user's teams, to the user's orgs (role ≠ guest) -- org subject NEW
           , object.publicLevel )
org object        → owner|admin: manage, member: view, guest: view (name only), else none → 404   -- NEW
suspended org     → every level that comes from it (ownership, org grants, its teams) is none      -- NEW
```

Invariants (each one a test in §13):

1. **An org role never reaches a member's personal objects.** Org owners and admins hold nothing on what a member owns as a user (the parallel of D12 for admins).
2. **Sessions belong to their creator** (D14). In a personal workspace, or any workspace the org does not own, org roles give nothing on a session. In an org-owned workspace org owners and admins get **read-only** access to members' sessions (OD-3): transcript, title, creator, cost, and `stop`; never `send` or a terminal. Each transcript view writes an audit row `org.transcript_viewed` (viewer, session, member, time; no content), readable by the member under Settings > Access log and by org owners. The workspace shows a notice that org admins can read sessions there. Not applicable to a session in a team or user workspace shared to the org.
3. **Context is not authority.** The org the UI is "in" is sent as a list filter (`?org=`), may only NARROW results, and is never an input to `can()`. A header or body that names an org is never trusted to widen.
4. **The same 404.** An org you are not in, its teams, its members and its objects answer exactly like a missing one, in every route, tool, socket and search. Lists count after the filter. The SSO discovery answer names a provider only for a verified domain, and its display name is the org's chosen sign-in label (§9.7).
5. **Tokens and agents never exceed their user**, read at use time. A Portal MCP token may additionally carry `org_id` (narrow only: it then reaches only that org's objects and the user's personal ones are refused). An agent stays boxed to its session and workspace; its user is the session's creator.
6. **Membership is read on every decision** (no cache across requests), so removal applies on the next call; `emitAccessChange` closes sockets, terminals and stops sessions that relied on it.
7. **Teams cannot cross orgs.** A team grant only counts while the user is still an active member of the team's org (a SQL join, not only the trigger).

The level query of Authorization §10 grows two `UNION ALL` arms (org-owned by role, grants to the org joined through `org_members` with `role != 'guest' AND state = 'active'`) and a `NOT EXISTS` on suspended orgs. It stays one query; the `can` benchmark of MU11 is re-run with 3 orgs × 50 members × 20 teams.

### 6.6 Org policies

| Policy | Default | Who sets |
| --- | --- | --- |
| `membersMayInvite` | off | owner, admin |
| `membersCreateTeams` | on | owner, admin |
| `externalShares` (org objects to people outside) | off | owner |
| `requireSso` (§9.5) | off | owner |
| `ssoFreshnessDays` (tokens reach org objects only if their user signed in through the org's IdP in the last N days) | 30 when `requireSso`, else off | owner |
| `defaultJoinRole` (JIT and domain join) | member | owner, admin |
| `domainJoin` (anyone with a verified-domain email may join without an invite) | off | owner |

### 6.7 The instance owner (super-admin)

The founding user stays the **platform admin** (`role = admin`, `platform(*)` areas). With organizations the platform admin: creates, suspends and deletes organizations; sees the list of organizations with names, member counts and owners; approves a domain for an org when DNS is not practical (audited, noisy); **recovers ownership** of an org that has no active owner (a fresh re-auth, a reason, an audit row of severity `medium`, a notification to every org admin); grants and revokes the ability `orgs.create` to users. These actions are done in the Admin console (§6.11).

**Break-glass (OD-4).** The instance owner has full access to any org's content, but only through a recorded entry:

- `POST /admin-api/orgs/:id/break-glass {reason}` on the Admin console, fresh re-auth, `reason` required (min 10 characters). It creates `org_break_glass(id, org_id, admin_user_id, reason, started_at, expires_at, ended_at)`, **time-boxed to 1 hour** (renewable only by a new entry with a new reason; the owner may end it early).
- While the entry is open, `can()` gives that admin `manage` on the org's content (workspaces, buckets, vaults, sets, sessions and transcripts) in the normal portal UI, with a persistent banner. It never reaches **personal** spaces (D12, MO4 stand there) and never `send` into a member's running session without it being audited as such.
- Audit: `org.break_glass_started|ended|expired` rows, plus one `org.break_glass_access` row per transcript view and per mutation made under the entry. Org owners are notified at start and can read the rows (reason, who, when).
- Superseded by this decision: D12 and MO4 for **org content** only.

Today the platform admin is also every other admin account (§14.1, G1). Separating "instance admin" from "an account whose role is admin" is prerequisite P1.

### 6.8 Invitations

- By email to an org (and optionally straight into teams), with the role (never `owner`; ownership is transferred, not invited). Single use, 7 days, the code hashed at rest and kept in the link's fragment (Identity D7), `auth_throttle` scope `invitation` (exists ✅, `store/migrations.ts:3495`).
- Accepting needs a signed-in account **whose email equals the invitation's** (normalized), or creating one; for an org with `requireSso` the account must come through the org's IdP. An invitation to an email on a verified domain of ANOTHER org is refused (that org's IdP vouches for it).
- The invite lists show pending invitations to admins; revoke at once; an expired one says so without telling whether the account exists.

### 6.9 Leaving, removal, suspension, deletion

| Event | Effect |
| --- | --- |
| A member leaves or is removed | Membership row ends (`state = 'removed'`, kept for audit); their team memberships in the org end (trigger); every grant **they made** of their personal objects to that org or its teams ends; their sessions in org workspaces are **stopped** (turn finishes, no new turn) and their terminals closed; their Claude logins contributed to org crews are withdrawn (D-53 "takes it back at once" path) and the login's files removed from the workspace by the reconciler; sockets get `org_membership_ended`; org-owned objects they created **stay the org's** and their creator grant is deleted. The last owner cannot leave (service + trigger). |
| Role lowered | Applies on the next call; an admin demoted to member loses `manage` on org objects at once. |
| Org suspended (owner or platform admin) | Every right that comes from the org is none; org workspaces keep running only for system jobs; owners still see the settings page to resume or delete. |
| Org deleted | Allowed only when it owns nothing, or with an explicit transfer of every object to a member (personal) or another org; soft-deleted for 30 days (`deleting`), then purged: memberships, teams, grants, SSO provider, domains. |
| SSO de-provisioning (IdP removed the person) | Without SCIM the portal learns it at the next sign-in attempt (refused) and through `ssoFreshnessDays` (tokens stop reaching org objects); an org admin can remove at once. |

### 6.10 Audit

`platform_audit` (D22) gains a nullable `org_id`; org admins read their org's rows (`/api/orgs/:id/audit`), the platform admin reads all. Kinds: `org.created|updated|suspended|resumed|deleted|ownership_recovered`, `org.member_invited|joined|role_changed|removed|left`, `org.team_*`, `org.share_created|ended`, `object.transferred`, `org.domain_added|verified|lost|removed`, `org.sso_created|updated|enforced|removed`, `org.sso_signin|signin_failed|jit_created|groups_synced`. Every row carries `actorString(actor)`; no secret, no token, no claim value other than the email and the matched group names.

### 6.11 Admin console (OD-2)

A separate global console for **instance admins only**, on its own host `admin.pilot.ai.isnan.me` (covered by the cluster's `*.pilot.ai.isnan.me` certificate; a Traefik IngressRoute to the same portal service plus a private DNS record). It is not a menu of the main portal.

- **Host split.** The server reads `settings.adminHost`; unset means the console is off (fail closed). A first middleware compares the `Host` header with it: on the admin host only `/admin-api/*`, the admin UI bundle and `/healthz` answer; on every other host `/admin-api/*` and the admin UI answer the same 404 as an unknown route. The main portal never serves an admin page and the main UI has no Admin menu. `X-Forwarded-Host` is ignored unless the proxy is the configured trusted one.
- **Own session.** Sign-in on the admin host accepts only an active account with `role = admin`. Cookie `__Host-pilot_admin` (host-only, no `Domain`, `Secure`, `HttpOnly`, `SameSite=Strict`), its own table `admin_sessions`, idle timeout 15 minutes, absolute 2 hours; a main-portal cookie is not accepted there and the admin cookie is never sent to the main host. No bearer tokens, no Portal MCP, no reporter or VS Code token on this host. Writes check `Origin` (the admin host only).
- **Sign-in through git.isnan.me** (owner, 2026-11-01). Besides the password, the console signs in through ONE OpenID Connect provider set by env (the cluster: `https://git.isnan.me`, Gitea), and lets in ONLY the identities on an allow list (the owner's email for now) that map to an active admin account; anyone else who signs in there is refused and appears in the console's Audit (`admin.signin_refused`), so the owner can allow them later. Off unless configured; the password sign-in stays. Details in §13.4.
- **Step-up.** Re-auth (the existing fresh-auth check) within 5 minutes for: granting or revoking an ability, suspending or deleting a user, ending sessions or tokens, changing an SSO provider, recovering org ownership, break-glass, deleting an org. The console asks once and resumes the interrupted action
  by itself (owner, 2026-11-01): the password inline, or the console's OIDC provider in a popup (`/admin-api/session/oidc/start?for=step-up&popup=1`;
  the callback answers `/admin-ui/?oidc=stepped&popup=1`, or `refused`, and that page messages the console through window.opener and the
  `pilot-admin-step-up` BroadcastChannel, then closes). A sign-in ignores `popup`. Its UI: Users and Orgs are master-detail (the detail beside
  the list on a desktop), an org's detail has tabs Overview / Members / Objects / Invitations / Sign-in / Break-glass, Audit has tabs All /
  Refused / Org / Security.
- **Screens.** Users (list, role, state, last sign-in, abilities, suspend/resume, end all sessions, revoke tokens), Organizations (list, owners, member counts, state, suspend/resume, recover owner, break-glass), Abilities (`orgs.create` per user; off by default), Sessions and tokens per user, SSO providers (instance-wide and org), Audit (platform audit, break-glass rows, filters).
- **Routes** (all declared, policy `platform(users)` unless noted; enumeration test covers the admin table too): `GET /admin-api/users`, `GET /admin-api/users/:id`, `POST /admin-api/users/:id/suspend|resume`, `POST /admin-api/users/:id/sessions/end`, `DELETE /admin-api/users/:id/tokens/:tid`, `PUT|DELETE /admin-api/users/:id/abilities/:ability` (step-up), `GET /admin-api/orgs`, `POST /admin-api/orgs/:id/suspend|resume|recover-owner` (step-up), `POST /admin-api/orgs/:id/domains/:d/verify`, `POST /admin-api/orgs/:id/break-glass` (step-up), `GET /admin-api/sso`, `GET /admin-api/audit`. Every write writes a `platform_audit` row with the actor, the target and the reason when given.
- **Everything instance-wide** (owner, 2026-11-01): accounts, orgs, workspaces and targets, sign-in, settings and a filtered audit are controlled here too; see §13.7.
- **Abilities** are rows `user_abilities(user_id, ability, granted_by, granted_at)`; the ability `orgs.create` is checked by `POST /api/orgs` on the main portal (creation itself is a main-portal action; granting it is not). The creator becomes the first owner.
- **Authz.** One more module `apps/server/src/admin/authz.ts`; actor from the admin session's user (P1), never `u_owner` by default; a denial is a 404.

## 7. Personal and organization context in the UI

- A **switcher** at the top of the side bar (desktop) and in the account sheet (phone, icon only): Personal, then each org by name with its role as an InfoTip. 44 px rows, one-word labels.
- The context is kept per device (`claudepilot.context.<userId>` in local storage) and sent as `?org=` on list calls. Lists show only that context; a "Shared with me" view shows grants from anywhere.
- **New workspace / project / vault** defaults the owner to the current context and shows it as a chip the person can change (to contexts where they may create).
- The share dialog gains subjects **Organization** and **Team** (only those of orgs the person is in), with the consent screen of Sharing.
- **Org settings**: General, Members, Teams, Invitations, Objects, Sharing, Sign-in (domains and SSO), Policies, Audit, Danger zone. What each role sees is in §13.9: owners everything, admins all but Policies and Danger zone, members General, Members, Teams, Objects and Sharing, guests General, Teams and Objects.
- Phone first (390 px), then 1280 px, light and dark, per QA-STANDARDS A1-A9.

## 8. Data model (proposed, block 460-479)

The multi-user block is 400-459 (identity 400-409 used up to 406; 410-459 for authz, sharing, teams and the retrofit; multi-user §14) and 480-499 is reserved for usage per user (multi-user §13). Organizations take **460-479** (to be registered in `docs/coord/PLAN.md` by the first slice). Sketch, to be run in `node:sqlite` against the real schema before the slice is approved:

```sql
CREATE TABLE orgs (
  id TEXT PRIMARY KEY CHECK (id GLOB 'org_*'),
  slug TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9]*' AND length(slug) BETWEEN 2 AND 40),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended', 'deleting')),
  policies TEXT NOT NULL DEFAULT '{}',          -- §6.6, validated by the service
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT
) STRICT;
CREATE TABLE org_members (
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'removed')),
  via TEXT NOT NULL CHECK (via IN ('created', 'invite', 'sso_jit', 'domain_join', 'migration')),
  added_by TEXT NOT NULL, added_at TEXT NOT NULL, ended_at TEXT,
  PRIMARY KEY (org_id, user_id)
) STRICT;
CREATE INDEX org_members_user ON org_members (user_id) WHERE state = 'active';
-- + triggers: an active org keeps >= 1 active owner; removing a member ends their team_members rows of that org.
CREATE TABLE org_invitations (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  email_key TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest')), teams TEXT NOT NULL DEFAULT '[]',
  code_hash TEXT NOT NULL UNIQUE, invited_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  used_at TEXT, used_by TEXT, revoked_at TEXT
) STRICT;
CREATE TABLE org_domains (
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'verified', 'lost')),
  challenge TEXT NOT NULL,                      -- random, shown to org admins; not a secret
  verified_at TEXT, last_checked_at TEXT, failures INTEGER NOT NULL DEFAULT 0, verified_by TEXT,
  PRIMARY KEY (org_id, domain)
) STRICT;
CREATE UNIQUE INDEX org_domains_verified ON org_domains (domain) WHERE state = 'verified';   -- one org per verified domain
ALTER TABLE teams ADD COLUMN org_id TEXT;                     -- NOT NULL by service after the migration fills it; unique (org_id, name_key)
ALTER TABLE sso_providers ADD COLUMN org_id TEXT;             -- NULL: an instance-wide provider (today's)
ALTER TABLE sso_providers ADD COLUMN groups_claim TEXT;       -- e.g. 'groups'
ALTER TABLE sso_providers ADD COLUMN group_rules TEXT NOT NULL DEFAULT '[]';  -- [{ group, role?, team? }]
ALTER TABLE web_sessions ADD COLUMN auth_method TEXT;         -- 'password' | 'code' | 'sso:<provider id>'; plus a session_sso table for step-ups
ALTER TABLE pmcp_tokens ADD COLUMN owner_id TEXT;             -- prerequisite P2; and org_id (narrowing)
-- owner_kind 'org' on: ticket_buckets, kg_vaults, pools, accounts, endpoints, templates, workspace_owners (each module's own migration).
```

`teams_name_key` (`store/migrations.ts:3557`) is unique across the portal and must become unique per org: SQLite cannot drop a constraint inside a table, but this one is an index, so it is dropped and recreated on `(org_id, name_key)`.

## 9. Organization SSO

### 9.1 Configuration

An org owner or admin adds one OIDC provider for the org: display label, issuer URL, client id, client secret (optional with PKCE-only public clients), scopes (must include `openid`, `email`), the groups claim name and group rules, `autoCreate` (JIT), and the domains it serves (**only domains verified by this org**). Stored in `sso_providers` with `org_id`; today's instance-wide providers keep `org_id = NULL` and remain `platform(settings)`.

Refused for org providers (allowed only on instance providers, by the platform admin): `allowPrivateNetwork`, `trustUnverifiedEmail`, `defaultRole = admin` at the **instance** level (an org provider can never make an instance admin; it makes org roles only).

### 9.2 Domain verification (DNS TXT)

1. An org admin adds `example.com`; the portal stores a random challenge and shows: `TXT _claudepilot-challenge.example.com "cp-verify=<challenge>"`.
2. "Check now" (rate limited per org) and a daily job resolve the TXT record with `node:dns` `Resolver.resolveTxt` against the system resolvers (no HTTP, so no SSRF surface; timeouts and a cap of 20 records × 1 KiB).
3. Found → `verified`; the unique index refuses a domain already verified by another org, and a domain an **instance** provider already serves is refused unless the platform admin releases it.
4. Re-checked daily; 7 consecutive failures → `lost`: the domain stops routing sign-ins, JIT and enforcement for it (existing linked identities still sign in; org admins and the platform admin are notified).
5. Refused domains: a small built-in list of public mail and hosting suffixes (gmail.com, outlook.com, yahoo.com, icloud.com, proton.me, github.io, vercel.app, pages.dev, …) and anything that is a public suffix itself. A full Public Suffix List is a dependency decision left for later (§12, Q4).
6. The platform admin may mark a domain verified by hand (internal portal, D-53), audited as `org.domain_verified` with `by: platform`.

### 9.3 Sign-in routing and coexistence

Email first, as today (`SSO_API.discover`, `identity/routes.ts:241`): **verified org domain → that org's provider**; else an instance provider for the domain; else password. The server code always works and always gets the instance admin in (D-82: "the server code stays"); it is the recovery path if an IdP breaks. Sessions record how they were authenticated (`auth_method`), because org access with `requireSso` depends on it (§9.5). IdP-initiated sign-in is not supported (login CSRF).

### 9.4 JIT provisioning and account linking

On a successful callback from org O's provider, with a verified email on one of O's verified domains:

| Situation | Result |
| --- | --- |
| `(provider, sub)` already linked | That account. Its membership in O is created if missing (role from §9.6) unless it was explicitly removed by an admin (removal sticks until re-invited). |
| No link; an account with this email exists; it has **no password and no other link** (made by SSO earlier) | Link and sign in. |
| No link; an account with this email exists and **has a password, another SSO link, or is a platform admin** | **Not linked automatically.** The person signs in with their existing method and links from Profile ("Connect your Konfersi sign-in"), which runs the OIDC flow while signed in. The founding user is never auto-linked. |
| No account, `autoCreate` on | A new account, platform role **member**, membership in O with `defaultJoinRole` (or the mapped role), teams from rules, `via = 'sso_jit'`. |
| No account, `autoCreate` off | Refused: "Ask your organization's admin for an invitation." |

Why so strict: an org admin controls its IdP and can mint an ID token for **any** address in its domain. Today's code links by email to any existing account (`identity/sso.ts:335`), including an admin, which is safe only while one trusted person configures every provider. With org-run providers that becomes an account takeover of the account's personal objects and its other orgs. The domain proof limits WHICH emails an org can vouch for; the no-auto-link rule limits WHAT it can take over.

### 9.5 Requiring SSO

With `requireSso` on (owner only, and only after at least one owner has signed in through the provider successfully, so they cannot lock themselves out):

- Members whose email is on a verified domain of the org can **reach the org's objects** only from a session authenticated through the org's provider. A password session still reaches their personal space and other orgs; the org's objects answer 404 there, and the UI offers "Sign in with Konfersi" (a step-up that adds the provider to the same session).
- Their password sign-in is refused entirely if the instance policy says the email's domain belongs to the org (the existing `sso.forEmail` refusal at `app.ts:386` already does this for instance providers).
- Members outside verified domains (contractors) are allowed only as `guest` unless an owner lists them as exceptions.
- Turning it on revokes the org-reaching part of existing password sessions at once (an access change, not a sign-out).
- Tokens: a Portal MCP, reporter or VS Code token of such a member reaches org objects only while the member's last org-IdP sign-in is within `ssoFreshnessDays`. Agent tokens (`cpst_`) follow their session creator by the same rule, checked when used.
- The platform admin is never subject to an org's `requireSso` for platform areas (they hold no org content right anyway).

### 9.6 Groups to roles and teams

`group_rules` is an ordered list of `{ group, role?, team? }`. At every sign-in through the org's provider: the highest mapped role wins (`admin` > `member` > `guest`; **`owner` is never mapped**), teams listed by matching rules are joined and teams previously joined by a rule but no longer matched are left (only memberships with `added_by = 'sso:<provider>'` are touched; manual ones stay). No match keeps `defaultJoinRole`. Group values are compared exactly, at most 200 groups read from the claim, never stored except the matched names in the audit row. A demotion through groups applies at the next sign-in; with session length 12 h (D4) and `ssoFreshnessDays`, that bounds staleness. SCIM (push de-provisioning) is a later slice.

### 9.7 Discovery and existence

`discover` answers `{ method: 'sso', provider, name }` only for a verified domain, and `name` is the org's chosen sign-in label (it may differ from the org name). It tells an unauthenticated caller that a domain has SSO here, which today's instance providers already tell; accepted and stated.

### 9.8 Secrets and SSRF

- **Client secret:** sealed with the portal's `SecretBox` in the encrypted column, the slot bound to the row (as `identity/sso.ts:192` does ✅); never returned (`hasClientSecret` only), never logged, a changed issuer or client id needs it again (`identity/sso.ts:215` ✅). Org admins may replace it, never read it. A move to `private_key_jwt` (no shared secret) is an open question.
- **Issuer URL is untrusted input** from an org admin. Every fetch (discovery, JWKS, token) already goes through `assertPublicUrl` with `redirect: 'error'`, a timeout and a body cap (`identity/oidc.ts:89-90` ✅). Two changes are required: (1) the guard resolves a name once and fetches by name again, a DNS-rebinding window its own comment accepts "for an admin-only portal" (`mcp/spec.ts:155-158`): org providers need a fetch that **connects to the address that was checked** (a pinned `lookup` on the HTTP agent); (2) the discovery cache is keyed by issuer only (`identity/oidc.ts:111-122`), so a provider that may use a private network and one that may not could share a cached document: key it by `(issuer, allowPrivate)`. "Test" is rate limited per org.
- The pending sign-in state lives in memory (`identity/sso.ts:73`): fine for one replica; it is lost on a restart (the person starts again). Stated, not changed.

### 9.9 SAML

Not in v1. It needs XML signature validation (a dependency with a history of wrapping attacks) and every IdP the owner is likely to use (Google Workspace, Microsoft Entra, Okta, Keycloak) speaks OIDC. Revisit only on a concrete need.

### 9.10 Connect, agents and tokens

SSO is for people. Connect nodes (node keys, enrollment tokens), the reporter's `cprt_` widget tokens, Portal MCP `cpat_` / `cpst_` / `cpmt_` tokens and VS Code client tokens keep their own doors; what changes is that each token's **user** is real (P2) and that org rules (membership, suspension, `requireSso` freshness) apply through that user at use time. An org-scoped Connect target (later slice) is enrolled by an org admin and visible only to that org.

## 10. API and tools (contracts `packages/contracts/src/orgs.ts`; server `apps/server/src/orgs/` with its own `authz.ts`)

| Route | Policy |
| --- | --- |
| `GET /api/orgs` (mine), `POST /api/orgs` | signed-in (list filtered); create: ability `orgs.create` or instance admin |
| `GET/PATCH/DELETE /api/orgs/:id` | `org` view / manage / owner-only (a declared `handler` check for owner) |
| `GET/POST /api/orgs/:id/members`, `PATCH/DELETE /api/orgs/:id/members/:uid`, `POST /api/orgs/:id/leave` | view (members+, guests refused) / manage |
| `GET/POST/DELETE /api/orgs/:id/invitations…`, `POST /api/orgs/invitations/accept` (built in slice 8, §13.6) | manage / signed-in + code + email match |
| `GET/POST/DELETE /api/orgs/:id/teams…` | under `org` + `team` rules |
| `GET/POST/DELETE /api/orgs/:id/domains…`, `POST …/domains/:d/check` | manage; check rate limited |
| `GET/PUT/DELETE /api/orgs/:id/sso`, `POST …/sso/test` | manage; enforcement owner-only |
| `GET /api/orgs/:id/audit` | manage |
| `POST /api/objects/:type/:id/transfer` | `manage` on the object + membership in the target org |
| Platform (admin host only, §6.11): `GET /admin-api/orgs`, `POST /admin-api/orgs/:id/suspend|resume|recover-owner|break-glass`, `POST /admin-api/orgs/:id/domains/:d/verify` | `platform(users)` + admin session + step-up |

Portal MCP: `org_list` (signed-in, own orgs) and `org_members` (org view) for the General Manager; **no** tool creates orgs, changes roles, SSO or domains (people only, like bucket admin today). Every route and tool is declared; the module's enumeration test fails on an undeclared one.

## 11. Migration of existing data (OD-1)

Decision: no "personal" holdover and no single default org. One instance, **three organizations by project**, all on k3s pods for now (Docker and Connect targets come later):

| Org (slug) | Holds | From today's data (by name; the dry run confirms) |
| --- | --- | --- |
| **isnan** | ClaudePilot itself, tradingbot and the other personal and lab projects | buckets `PILOT`, `TB` and the other personal ones; their workspaces, vaults and CI remotes; the teams; the instance's own sets |
| **konfersi** | the Konfersi universe | bucket `KONF`; the Konfersi repos and leads in workspace `kubernetes/kohi-event`; their vaults; CI remotes `konfersi-universe` |
| **kohilabs** | memor.id | bucket `MEMOR`; workspace `kubernetes/memorid-project`; its vault and CI remote |

Steps:

1. A **dry run** (`POST /admin-api/migration/orgs/plan`, platform admin) reads a mapping setting `orgs.migrationMap` (bucket key, workspace id, vault id, CI remote, set -> org slug), lists every object and its target, and fails on any object with no target. The owner edits the map and confirms; only then the migration runs (once, recorded in `portal_meta.orgs_migrated`).
2. It creates the three orgs, owned by `u_owner` (`via = 'migration'`). Every existing account joins **isnan** as before (admin -> `admin`, member -> `member`); `konfersi` and `kohilabs` start with `u_owner` only and get people by invitation or SSO. Existing teams move into isnan.
3. It sets `owner_kind = 'org'` on every mapped object and writes an `object.transferred` audit row for each. What the map does not cover is not moved and is listed in the plan as a blocker, not silently left personal. Sessions and workspace Claude logins stay user-owned by nature (§6.3); sessions in org workspaces become readable by that org's admins under OD-3, with the notice of §6.5.
4. Existing instance SSO providers stay instance-wide (`org_id = NULL`); their JIT accounts join isnan with `member`. Session shares stay as they are.
5. Rollback: the migration is one transaction per org plus the audit rows; a reverse map (`owner_kind` back to `'user', 'u_owner'`) is a tested script, because nothing is rewritten besides the owner columns.

**Shared pod `kohi-event`** hosts several programs today. Recommendation (open follow-up, OD-6): v1 keeps the workspace **owned by isnan** (it is the infrastructure the owner runs) and **shares it to konfersi at `operate`** through an org grant, credentials off by default; the Konfersi repos, leads, vaults and CI remotes inside it are konfersi's. Split the programs into per-org pods later when a Konfersi member should not hold terminal access to the shared pod (operate on a pod is terminal-equivalent, §12). The migration map supports either: a workspace has exactly one owner org, so a split is a new pod plus a transfer.

## 12. Risks and open questions

| Risk | Mitigation |
| --- | --- |
| Building orgs on today's layer leaks across tenants (§14) | Prerequisites P1-P6 come first and are a gate, not a suggestion. |
| A member of two orgs moves data between them through a workspace they operate in both (copying files, a CI remote) | Accepted: operate on a workspace is terminal-equivalent (Authorization); org admins are told `externalShares` does not stop a person from copying what they can read. |
| Org admin IdP mints addresses to take over accounts | Domain proof + no auto-link of accounts with a password, another link or platform admin (§9.4). |
| Stale roles without SCIM | 12 h sessions, `ssoFreshnessDays`, sign-in sync, immediate manual removal. |
| The `can` query grows | One query, benchmarked in MU11 at 3 × 50 × 20; membership index on `user_id`. |
| The pod's memory (D-61) | No new process; DNS checks are a daily job of one small loop. |

| ID | Question | Who |
| --- | --- | --- |
| Q1 | Should a workspace Claude login contributed to an org crew (D-53) be listed on the org's page (who contributed what, limits), visible to org admins? Default: yes, names and limits, never the token. | Product |
| Q2 | Org-scoped Connect targets: in v1 or later? Default later (slice 11). | Product |
| Q3 | An org-private library (MCP entries, skills approved by org admins)? Default no: the platform library stays one. | Owner, later |
| Q4 | Public Suffix List as a dependency for domain checks? Default: a built-in short list now. | Product |
| Q5 | `private_key_jwt` client auth for org providers to avoid shared secrets? Default later. | Product |

## 13. Prerequisites and slices, in order

### 13.1 Prerequisites (from §14; each one blocks organizations)

| ID | What | Why |
| --- | --- | --- |
| P1 | **Real actor per request**: the authenticate middleware sets `actor` from the session's `userId` (`user:<id>`, the server code → `u_owner`); `actorOfSocket` the same; admin accounts stop being `u_owner` inside `can()`; "instance admin" is `role = admin`, read on every use. | G1, G2 |
| P2 | **Owner-bound tokens**: `pmcp_tokens.owner_id` + `token_epoch`, set at mint from the real actor; `actorOfPrincipal` uses it (no `FOUNDING_USER_ID` default); reporter `#actor` refuses a token whose user is not a user id instead of falling back to the founder; the VS Code bearer door passes its user. | G3, G4, G5 |
| P3 | **Owner columns and resolvers** for workspace (`workspace_owners`), vault, pool, account, endpoint, template, ci (via workspace), with `owner_kind`; each type in `RESOLVER_REQUIRED` once its resolver exists (fail closed). | G6 |
| P4 | **One enumeration test over the whole app's route table** (not per module) and the central route middleware enforcing declared policies (D-82 S0); declarations for identity, knowledge, accounts, personas, skills, mcp, claudeusage, usagespend, platform, appports, delivery. Tools: an undeclared tool is refused, not "left to its handler". | G7, G8 |
| P5 | **Per-actor filtering of every stream and search**: `/api/live` usage snapshot and nudges per user, chat socket per session `can`, knowledge search post-filtered by vault `view`, attention/glance aggregators by `visible`, triggers and notifications by `canUser` at delivery. | G9 |
| P6 | **SSO hardening**: no auto-link of an account with a password, another link or admin; JIT never makes an instance admin without the existing acknowledgement, and never for org providers; pinned-address fetch; discovery cache keyed by `(issuer, allowPrivate)`. | G10, G11 |

Status (2026-11-01, slice 1 on `feat/orgs-slice1-owners`, not merged): **P3** migration 410 (`workspace_owners` keyed by the workspace key with
`uid` = its stable id; `owner_kind`/`owner_id` on `kg_vaults`, `pools` (sets and account pools), `accounts`, `endpoints`; everything backfilled to
`u_owner`); resolvers in `apps/server/src/authz/owners.ts`, CI runs and remotes through their workspace (`ci/authz.ts`); registering them makes
those types and `template` (no table yet) required. A workspace found in a runtime with no row is unclaimed (owned by `platform`: the founding
user and admin accounts, nobody else); `owner_kind = 'org'` reads as unowned until slice 3. New workspaces record `created_by`; their owner stays
`u_owner` until D-82 S1b. **P4** `authz/routeGuard.ts` enforces the answering route's declared policy inside the session middleware (undeclared:
`403 NO_POLICY`); `createApp` declares the whole table (`authz/declarations.ts`); an undeclared tool is refused at dispatch. `authz/routeTable.test.ts`
enumerates all 578 routes and 138 tools, probes every `objects`/`platform` declaration with `u_a`/`u_b`, and checks unowned = the missing 404.
Not in slice 1: per-person filtering of lists (`filter` on vault, account, pool and repo lists is still the handler's: P5), object checks on the
pool tools (they accept a set's name), the member's creating and owning (S1b).

Built so far (not yet merged): P1, P2 and the P6 linking rule in slice 0; P5 and the rest of P6 in slice 2 (`docs/prd/multi-user.md` §20, §21; migration 420).

### 13.2 Slices (each with its tests and a blind security review, D-82 style)

| # | Slice | Tests (minimum) |
| --- | --- | --- |
| 0 | P1 + P2 (actor and tokens) | two admin accounts get different `actorString`; a token minted by `u_b` cannot reach `u_a`'s bucket; reporter token with a non-user id refused; cookie-less socket anonymous |
| 1 | P3 + P4 (owners, resolvers, enumeration, middleware) | whole-app enumeration: no undeclared route or tool; generated probes per declared policy with `u_a`/`u_b`; unowned → 404 |
| 2 | P5 + P6 | cross-user live/search/aggregator leaks (X-cases); SSO linking matrix of §9.4; DNS-rebinding guard with a fake resolver |
| 3 | Orgs core: tables, `org` object type, memberships, roles, invariants, abilities (`user_abilities`, `orgs.create`), the org list for the platform admin | last owner cannot leave (service and trigger, two connections); org 404 for non-members; `POST /api/orgs` refused without the ability |
| 4 | **Admin console host** (§6.11): host split middleware, `admin_sessions`, `__Host-` cookie, step-up, `/admin-api/*`, admin UI bundle, Traefik IngressRoute and private DNS in `deploy/k3s`, abilities, org recovery, SSO list, audit | admin routes 404 on the main host (and the main UI has no admin page); a main-portal cookie and every token refused on the admin host; non-admin account refused; idle 15 min and absolute 2 h expiry; step-up required (time-faked); `adminHost` unset disables the console; undeclared admin route fails enumeration |
| 5 | Org-owned objects + Move to organization (workspace, bucket, vault first), break-glass (§6.7) | org admin manages, member none without grant; creator grant; transfer re-consents credentials; break-glass needs reason and fresh re-auth, expires at 1 h, notifies org owners, writes access rows, never reaches personal objects |
| 6 | **Three-org migration** (§11): plan/dry run, `orgs.migrationMap`, create isnan, konfersi, kohilabs, transfer by map, reverse script | migration on a copy of the real schema keeps every owner and loses no object; an unmapped object blocks the plan; `kohi-event` owned by isnan + operate grant to konfersi; run twice is a no-op; rollback restores owners |
| 7 | Org-level and team sharing (grants with `subject_kind = 'org'`), teams scoped to orgs, org-admin read of transcripts (OD-3) with audit and the member's access log | guest excluded from org grants; leaving ends grants made; revoke closes sockets and stops sessions; a transcript view writes the audit row the member can read; no `send` for an org admin; nothing in a non-org workspace |
| 8 | Invitations, leaving/removal effects, suspension, deletion, audit | single use, expiry, email match, throttle; every §6.9 row as a test |
| 9 | Web: switcher, context filter, share dialog subjects, Org settings (Members, Teams, Invitations, Policies, Audit), break-glass banner, access log | `tools/qa` at 390 and 1280, light and dark, 44 px, no horizontal scroll; context never widens (API test with a forged `?org=`) |
| 10 | Org SSO (OIDC only): domains (TXT), org providers, JIT, groups at sign-in, `requireSso` (outside members become guests), step-up, token freshness | DNS fake; domain unique across orgs and instance providers; owner never mapped; enforcement lock-out guard; fake IdP (`identity/fakeIdp.ts` exists) for every §9.4 row |
| 11 | Later: org-scoped Connect and Docker targets, split of the shared pod, SAML, SCIM, org library | - |

Slices 0-2 stay the prerequisites: nothing from slice 3 on starts before them. Slice 4 needs only slices 0-3 and can ship before the migration, so the admin console exists when the orgs appear.

Abuse matrix: Authorization §12 gains O1-O15 (org object across tenants, org grant to guest, team cross-org, forged context, token narrowed by `org_id`, suspended org, removed member's agent token, JIT into another org's domain, IdP minting an admin's email, requireSso bypass with a password session, discovery for an unverified domain, invitation replay, invitation to another org's domain, transfer without membership, platform admin reading org content without a break-glass entry; admin route on the main host; main-portal cookie on the admin host; transcript read without an audit row).

### 13.3 Slice 3 as built (branch `feat/orgs-slice3-core`, on top of slice 0)

- **Tables** (migrations 463-464): `orgs` and `org_members` as §8, plus membership `via = 'recovered'` (owner recovery, §6.7); `user_abilities(user_id, ability, granted_by, granted_at)` with no CHECK on the ability's name (the service validates `ABILITIES`, so a new ability needs no table rebuild). Triggers `org_members_keep_owner_update|delete` refuse ending, demoting or moving the last ACTIVE owner of an `active` or `suspended` org (`RAISE(ABORT, 'ORG_NEEDS_OWNER: …')`); `orgs_keep_owner_state` refuses bringing a `deleting` org back without one. A `deleting` org, or a cascade from a deleted one, is not held to it.
- **Seam:** `ObjectType` gains `org` (owned by `platform`, no grants); a resolver may give `levelFor(found, userId)`, which alone decides the level (membership): owner and admin `manage`, member and guest `view`, else none (404). A suspended org leaves only its owners `view`. `org` is in `RESOLVER_REQUIRED` (fail closed) and in the agent box (an agent never reaches an org). A platform admin, and the founding user, hold nothing on an org they are not in. `OwnerKind 'org'` and org grants are slices 5 and 7.
- **Service** (`apps/server/src/orgs/`): `OrgsService` (`mine`, `get`, `create`, `update`, `members`, `setRole`, `removeMember`, `leave`, `admit` (unchecked, for invitations, migration and JIT later), `listAll` and `recoverOwner` for the Admin console) and `UserAbilities` (`holds`, `may`, `of`, `list`, `grant`, `revoke`). Every write that could end an owner runs the check and the write in one `BEGIN IMMEDIATE`; the trigger is the second line; both answer 409 `details.reason = ORG_NEEDS_OWNER`. Creating needs a person (no token or agent) who is an instance admin or holds `orgs.create`; otherwise 403 `ORG_CREATE_NOT_ALLOWED`. Ability and recovery calls need a person who is an instance admin (else the platform's 404). Audit kinds: `org.created|updated|member_role_changed|member_removed|member_left|ownership_recovered`, `ability.granted|revoked` (medium), subject `org:<id>` or `user:<id>`; `platform_audit.org_id` (§6.10) is not added yet.
- **Routes** (declared in `orgs/authz.ts`, cookie only): `GET|POST /api/orgs`, `GET|PATCH /api/orgs/:id`, `GET /api/orgs/:id/members`, `PATCH|DELETE /api/orgs/:id/members/:uid`, `POST /api/orgs/:id/leave`. No route adds a member directly (invitations, slice 8), deletes or suspends an org (slice 8), or changes policies (slice 9). Until slice 1 opens the app to members, `requireSession` still refuses a member account (D-82 S1a), so today only admin accounts reach these routes.
- **Not in this slice:** `teams.org_id` and the team triggers (slice 7), notifications to org admins on recovery and the step-up (slice 4), Portal MCP `org_list`/`org_members` tools.

### 13.4 Slice 4 as built (branch `feat/orgs-slice4-admin`, on top of slice 3)

- **Host split** (`apps/server/src/admin/host.ts`): `settings.adminHost` is the env `PORTAL_ADMIN_HOST` (`config.adminHost`, set in `deploy/k3s/portal.yaml` to `admin.pilot.ai.isnan.me`); unset or not a host name, the console is off. The FIRST middleware of `app.ts` hands every request for the admin host to the console's own Hono app (`admin/routes.ts`), so nothing of the main portal (`/api`, `/mcp`, `/reporter/v1`, `/connect`, `/hooks`, its pages and assets) runs there; on any other host `/admin-api/*` and `/admin-ui/*` throw the same `NOT_FOUND` as an unknown `/api` route. The host is `Host` (port dropped unless the configured host has one, case and a trailing dot ignored); `X-Forwarded-Host` (its last entry) counts only with `PORTAL_TRUST_PROXY=true`, the trusted-proxy rule of `clientAddress.ts`. WebSocket upgrades on the admin host are refused with 404 before any module sees them (`routeAdminHostUpgrades`, index.ts); dev mode sends the console's paths and host to Hono, not Vite.
- **Session** (`admin/sessions.ts`, migration **470** `admin_sessions`; 471-474 held): sign-in `POST /admin-api/session {email, password}` through `users.verify` (its throttle), then only an ACTIVE `role = admin` account; a member gets the wrong-password answer. Cookie `__Host-pilot_admin` (Secure, HttpOnly, SameSite=Strict, Path=/, no Domain, Max-Age 2 h); only its sha256 is stored. Idle 15 minutes from the last request, absolute 2 hours; a role change or a disable ends it on its next use. Any `Authorization` header is refused (401) and the main `portal_session` cookie is never read. Every write needs an `Origin` whose host is the admin host (sign-in too, so no login CSRF). An account with no password (SSO-only) cannot sign in to the console yet.
- **Step-up:** `POST /admin-api/session/step-up {password}` marks the session for 5 minutes. Required (403 `REAUTH_REQUIRED`) on every write route: abilities PUT/DELETE, suspend, **resume** (re-enabling restores access, so it is held to the same bar), end sessions, revoke a token, recover owner. The router enforces each declaration (`admin/authz.ts`: `public` sign-in, `self` session routes, `platform(users)` the rest, `reauth`), and `createAdminApp` refuses to start with an undeclared `/admin-api` route (`assertDeclared`).
- **Routes:** as §6.11 plus the session routes (`GET|POST|DELETE /admin-api/session`, `POST /admin-api/session/step-up`). `GET /admin-api/users/:id` adds live session counts (main portal from `web_sessions`, console) and the tokens the account minted (Portal MCP and reporter, by `token_accounts` or, for a non-founder account, the owner column). Suspend disables the account, ends its main and console sessions and revokes every token it minted (`revokeAccountTokens`); an admin cannot suspend themselves. Audit rows: `admin.signin|signin_failed|signout|step_up|step_up_failed`, `account.suspended|resumed|sessions_ended|token_revoked` (medium, `detail.via = 'admin-console'`), and the services' `ability.granted|revoked`, `org.ownership_recovered`. `GET /admin-api/audit` filters by kind prefix, severity, exact subject, `before`, `limit`.
- **UI:** `apps/web/admin.html` + `src/admin-console/`, built by `vite.admin.config.ts` into `apps/web/dist-admin` (base `/admin-ui/`, no public files, no inline script), served only by the console app (`/` redirects to `/admin-ui/`); both Dockerfiles copy it. Sign in, Users (role, state, last sign-in, the `orgs.create` toggle, suspend/resume, end sessions, tokens), Orgs (owners, member count, needs-owner, recover owner), SSO (read only), Audit (kind and severity filters). The main build and the main UI have no console entry or call (a web test checks it).
- **Deploy:** `deploy/k3s/portal.yaml` gains `PORTAL_ADMIN_HOST` and the IngressRoute `claudepilot-admin` (`Host(admin.pilot.ai.isnan.me)` to the portal Service, the `*.pilot.ai.isnan.me` certificate). Applied by Argo CD on release, not by hand.
- **Sign-in through git.isnan.me** (owner request 2026-11-01, branch `feat/admin-console-oidc`; `admin/oidc.ts`). Env (`deploy/k3s/portal.yaml`): `PORTAL_ADMIN_OIDC_ISSUER` (`https://git.isnan.me`), `PORTAL_ADMIN_OIDC_CLIENT_ID` and `PORTAL_ADMIN_OIDC_CLIENT_SECRET` from the OPTIONAL Secret `claudepilot-admin-oidc` (keys `client-id`, `client-secret`; `optional: true`, so the portal starts without it), `PORTAL_ADMIN_OIDC_ALLOW` (comma-separated, `alfian@isnan.me`), `PORTAL_ADMIN_OIDC_ALLOW_PRIVATE=true` (git.isnan.me resolves to a cluster address inside the cluster; the OIDC client's SSRF guard refuses a private address otherwise). Any of issuer, client id, secret or allow list missing: off (fail closed; the routes answer 404, the button is hidden). The redirect URI registered at the provider is `https://<adminHost>/admin-api/session/oidc/callback` (cluster: `https://admin.pilot.ai.isnan.me/admin-api/session/oidc/callback`), built from `adminHost`, never from a request.
  - **Routes** (declared `public` in `admin/authz.ts`, admin host only): `GET /admin-api/session/methods` (`{password: true, oidc: {name} | null}` for the Sign in page), `GET /admin-api/session/oidc/start` (state, nonce and PKCE verifier in a 10-minute `__Host-pilot_admin_oidc` cookie, HMAC-signed with a per-process key, `SameSite=Lax` so the provider's redirect back carries it; then a redirect to the provider), `GET /admin-api/session/oidc/callback` (the state against the cookie, once; the code exchange; the ID token's signature by JWKS, `iss`, `aud`/`azp`, `exp`/`iat`/`nbf`, `nonce`, all by the portal's OIDC client `identity/oidc.ts` with its pinned fetch and discovery and JWKS caches; `email_verified` must be true when the claim exists).
  - **Who gets in:** the verified `email` on the allow list, or `preferred_username` on it as a fallback; the account is always found by the verified email (a username never names one), and must be an active `role = admin` account. Then the same admin session as the password path (`__Host-pilot_admin`, idle 15 min, absolute 2 h), marked fresh for step-up for 5 minutes, an `admin.signin` row with `method: oidc`, and a redirect to `/admin-ui/`.
  - **Refused** (not on the list, no such admin account, a member, a disabled account, any verification failure, a provider error): the same redirect to `/admin-ui/?oidc=refused` (the Sign in page says "Sign-in refused."), and a platform audit row `admin.signin_refused` (medium, actor `anonymous`) with `method: oidc`, `purpose`, `reason`, the issuer, the subject and the email when known, never a code or a token. The Audit screen's kind filter suggests it and shows who tried on the row.
  - **Step-up:** the step-up dialog offers "Re-auth with git.isnan.me" (`start?for=step-up&next=<section>`, which needs the admin session and binds the step-up to it): the return marks only that session, and only when the identity maps to the same account; an SSO-only admin can step up this way. The pending action is not replayed (the page is left); the admin does it again within the 5 minutes.
- **Not in this slice:** org suspend/resume, domain verify and break-glass (slices 5 and 8: no service yet), user delete from the console, SSO changes (the list is read only), the notification to org admins on recovery, a browser check of the console at 390 and 1280 px (no scratch portal with this branch's build was run).

### 13.5 Slice 5 as built (branch `feat/orgs-slice5-owned`, on top of `release/orgs-decom`)

- **Tables** (migrations 465-467; 468-469 held): `ticket_buckets.owner_kind` (465, every existing bucket `user`); `grants` (466) as Authorization §13 with `subject_kind` `user | team | org` and a CHECK refusing `manage` to an org; `org_break_glass` (467) as §6.7 plus `ended_by` and `end_kind` (`ended | expired | replaced`).
- **Seam** (`authz/seam.ts`, `useOrgAuthority`, installed by `orgs/authority.ts`): an owner `{ kind: 'org' }` is real in every resolver (`authz/owners.ts`, the bucket resolver). On an org-owned object: org owner and admin `manage` (role read now, active org only), member and guest only grants, an admin account nothing by being one, a suspended org nothing (grants on its objects included). Grants (`authz/grants.ts`, one query: to the user, to the user's teams, to the user's orgs unless a guest) count on every resolved object; a creator grant (`share_id = 'creator'`) counts only while its holder is an active member of the owning org, so leaving ends it. `ownersOf` of an org object is the org's active owners; `seesEverything` is false once anything is org-owned. Without the orgs module an org object stays unowned (404).
- **Move to organization** (`orgs/transfer.ts`): `POST /api/workspaces/:ref/move-to-org`, `POST /api/tickets/buckets/:key/move-to-org`, `POST /api/knowledge/vaults/:id/move-to-org`, body `MoveToOrgRequest { orgId, keepCredentials? }`. A person with `manage` on the object (declared and asked again) and an active role of member or up in an active org (else the org's 404); an object that already belongs to another org needs owner or admin there by role. Workspaces: when Secrets & env sets are assigned, the first call answers 409 `CREDENTIALS_CONSENT_REQUIRED` with `details.credentials` (names); the second keeps the listed ones (each needs `manage` on the set) and unassigns the rest through the pools service BEFORE the owner changes. The owner columns and the creator grant (the previous personal owner, else the mover) are one transaction; audit `object.transferred` (medium); `owner_changed` access change.
- **Break-glass** (`orgs/breakGlass.ts`): `POST /admin-api/orgs/:id/break-glass {reason}` (step-up, instance admin as a person, reason 10-500 characters) opens one hour; a new entry by the same admin replaces the open one. While open the seam gives that admin, as a person (no token, no agent), `manage` on the org's objects; never on a personal object. Every decision that needed the entry for a verb above `view` writes `org.break_glass_access` (de-duplicated per entry, object and verb for a minute). The org's active owners get a `security` notification (audience) and read entries and access rows at `GET /api/orgs/:id/break-glass`; an owner ends one early (`POST /api/orgs/:id/break-glass/:entryId/end`), the admin ends theirs from the console (`DELETE /admin-api/orgs/:id/break-glass`, step-up like every console write). Decisions check `expires_at` against the clock; a one-minute sweep writes `org.break_glass_expired`. `GET /api/orgs/break-glass` is the banner (the caller's open entries); `GET /admin-api/break-glass` lists all. Audit: `org.break_glass_started` (high), `_ended`, `_expired`, `_access` (medium), subject `org:<id>`.
- **Not in this slice:** creating an object straight into an org (create personal, then move), moving out of an org back to a person, sets/accounts/endpoints transfer routes (their resolvers already read `org`), sessions and transcripts under break-glass or OD-3 (sessions stay their creator's: an admin under break-glass gets nothing on a session; slice 7), tickets themselves (no `ticket` resolver yet: the handlers check the bucket, the founding-user fallback still answers the ticket type), the notification reaching an org owner who is not an instance admin (the `portal` subject is checked as `platform(notifications)` at delivery: the audit rows and the org's break-glass page are the record until an `org` notification subject exists), `platform_audit.org_id` (§6.10), Portal MCP tools.

### 13.6 Slice 7 as built (branch `feat/orgs-slice7-sharing`, on top of `release/admin-oidc`)

- **Tables** (migrations 475-476; 477 held): `teams.org_id` (475; NULL for today's portal-wide teams until slice 6 moves them), `teams_name_key` recreated on `(coalesce(org_id, ''), name_key)`, triggers `team_members_org_only_insert|update` (`TEAM_NOT_ORG_MEMBER`: only an ACTIVE member of the team's org), `teams_org_fixed` (a team never changes org), `org_members_leave_teams[_delete]` (leaving, removal or a deleted row leaves the org's teams). `org_shares` (476): one row per share of a workspace, bucket or vault to an org or one of its teams, `personal` when it is the sharer's own object, kept when ended (`revoked | member_left | team_removed`); the grant is a `grants` row whose `share_id` is the share's id. Triggers end a member's PERSONAL shares (grants deleted) when they stop being an active member, and a deleted team's shares.
- **Seam:** the grants query counts a team grant only while the user is an active member of the team's ACTIVE org (a join, invariant 7; the trigger is the second line). OD-3 (`authz/seam.ts` `orgReadOfSession`): on a session the person does not own whose workspace is ORG-OWNED, the org's owners and admins hold `view` (transcript, metadata, files: every `view` route of the session) and are refused anything above it with a 403 (no send, no terminal, no stop yet); an instance admin with an open break-glass entry on that org gets the same `view`, recorded as `org.break_glass_access`. A person only (a token or an agent gets nothing this way). Nothing for a session in a personal or team workspace, or one shared to the org.
- **Audit of reads:** every `view` decision that needed the org role writes `org.transcript_viewed` (medium; viewer, session, member, workspace; no content), `user_id` = the member (the account that started the session, else the session's owner), subject `org:<id>`, de-duplicated per viewer and session for a minute. A list's filter (`visible()`) is not a read and writes nothing. The member reads the rows in their own platform audit (`GET /api/platform/audit?kind=org.transcript_viewed`, the Settings > Access log screen is slice 9); org owners read the org's at `GET /api/orgs/:id/transcript-views`.
- **Service** (`orgs/sharing.ts`, `OrgSharing`): teams (members and up list all, a guest the ones she is in; create: owner, admin, or a member while `membersCreateTeams`; members and deletion: org owner or admin, or a team owner; a team keeps an owner unless an org admin acts), shares (a person with `manage` on the object and member or up in the org; org: view or operate; team: up to manage, manage only by the object's owner or, for an org object, an org owner or admin; an org object only inside its org; an operate share of a workspace with credential sets assigned answers 409 `SHARE_EXPOSES_CREDENTIALS` until `acknowledgeExposure`; sharing again changes the level), revoke (the sharer, a manager of the object, or an org owner or admin). Revoking, lowering, deleting a team and removing a team member emit `share_ended` to every receiver: sockets re-check, and `chat/accessStop.ts` ends the receiver's running sessions in that workspace once `can()` says they lost `operate` there (only on `share_ended` for a workspace that still resolves). Audit: `org.share_created|ended`, `org.team_created|removed|member_set|member_removed`.
- **Routes** (declared in `orgs/authz.ts`, `org` view unless noted, the service checks the role on top): `GET|POST /api/orgs/:id/teams`, `DELETE /api/orgs/:id/teams/:teamId`, `GET /api/orgs/:id/teams/:teamId/members`, `PUT|DELETE /api/orgs/:id/teams/:teamId/members/:uid`, `GET|POST /api/orgs/:id/shares`, `DELETE /api/orgs/:id/shares/:shareId`, `GET /api/orgs/:id/transcript-views` (manage, owners only).
- **Tests:** `orgs/orgsSlice7.test.ts` (teams only for org members, names per org, a guest's view; guest excluded from org grants, manage to an org refused, team share; leaving leaves teams and ends the team grant; leaving ends the member's personal shares; revoke tells every receiver and stops their sessions; OD-3 read, no send, the member's audit row, owners' list; nothing in a personal workspace, a list writes no row; routes 404 for an outsider).
- **Not in this slice:** `stop` for an org admin (§6.5 invariant 2; the end route needs `operate`), the workspace notice that org admins can read sessions there, the web (the share dialog's Organization and Team subjects, Teams in Org settings, the access log screen: slice 9; the existing session share dialog already offers teams), `externalShares` (no share of an org object outside its org), the access change to other members when a sharer leaves (their rights end on the next call; their open sockets are not told), sessions owned by their creator (D14: `chat_sessions` has no owner yet, so a session's owner is still the founding user and the audit names the starting account), the portal-wide Teams admin page still lists org teams.

### 13.5 Slice 9 (web) as built, first part (branch `feat/orgs-slice9-web`, on top of slices 0-4)

- **Switcher** (`apps/web/src/features/orgs/ContextSwitcher.tsx`; owner, 2026-11-01, second pass): a compact row at the foot of the side bar, right above the account (the org's letter tile, or a person icon for Personal, the name and a chevron; the tile alone on the icon rail), opening the list upwards. pilot's own logo stays on top of the side bar and the phone's top bar. On phones the switcher is a row of the account menu that opens the same list in the kit's sheet (`ContextSheet`; header not a drag handle, `lib/sheetDrag.ts`). The list: Personal, each org (its role in an InfoTip), then Org settings (in an org) and New organization (when allowed). Pages no longer repeat the org's name above their title.
- **Context** (`apps/web/src/lib/orgContext.ts`): kept per device under `claudepilot.context.<userId>` (the founding user's id for a server-code sign-in), every storage access in try/catch; a stored org the person is no longer in falls back to Personal and is forgotten. Pages wait for the org list once, then remount on a change. Every list call (workspaces, agents, tickets and buckets, vaults, CI runs and repos) goes through `scopedList`, the one place that adds `?org=`. The server scopes those lists (§13.6; the `ORG_SCOPED_LISTS_LIVE` switch is gone, §16.3): Personal sends `org=personal`, an org its id, and in an org context a note above the page names the org (InfoTip: lists show only what the organization owns). Usage stays personal (a Claude login is the person's, §6.3). Live socket updates are not scoped yet.
- **New organization**: shown to an instance admin or a holder of `orgs.create`, read from **`GET /api/orgs/abilities`** (`MyAbilities`, policy `signed-in`, the person's own abilities only; a token or an agent gets none). The POST still decides.
- **Org settings** (`/admin/orgs/:id`): General (name for owners and admins; the slug is fixed) and Members (role pickers limited to what the service allows, remove, Leave; the last-owner refusal reads "An organization needs an owner. Make someone else an owner first."). Members read the list; a guest sees the name and Leave. Teams, Invitations, Domains, Sign-in, Policies, Audit, the share dialog subjects, the break-glass banner and the access log are left out until their slices (7, 8, 10, 5).
- **Tests:** `lib/orgContext.test.ts`, `features/orgs/rules.test.ts`, server `orgs.test.ts` (abilities route; a forged `?org=` on `GET /api/orgs` never widens it); browser check `tools/qa/orgs-switcher.mjs` (390 and 1280 px, light and dark, 44 px, no sideways scroll).

### 13.7 Slice 10 as built (branch `feat/orgs-slice10-sso`, merged with main after slices 7 and 8)

- **Tables** (migrations 471-474): `org_domains` (471, as §8 plus `added_by`/`added_at`; the partial unique index keeps a verified domain in one org); `sso_providers.org_id` (FK, cascade), `groups_claim`, `group_rules` and a unique index of one provider per org (472); `org_sso_sessions` (a web session, by the hash `web_sessions` keys it under, marked by the org's provider at sign-in or step-up) and `org_sso_signins` (each person's last sign-in through it) (473); `org_sso_exceptions` (474). `web_sessions.auth_method` of §8 is not added: the per-org session mark replaces it.
- **Domains** (`orgs/sso.ts`): add (manage), the TXT record `_claudepilot-challenge.<domain>` = `cp-verify=<challenge>`, "Check now" (10 per org per hour) and a daily job by `node:dns` `Resolver.resolveTxt` (5 s, 20 records of 1 KiB, joined strings). Refused: a built-in list of public mail domains, hosting suffixes (and every name under them) and two-label public suffixes (`DOMAIN_REFUSED`); a domain another org holds verified or an enabled instance provider serves (`DOMAIN_TAKEN`, also when found later: the unique index). An instance provider cannot take a domain an org verified. 7 failed checks in a row: `lost` (routing, linking and JIT stop; an identity linked before still signs in). The platform admin's manual verify (§9.2 step 6) is not built.
- **The org's provider** (`identity/sso.ts` `putOrgProvider`): one per org, serving every domain the org holds verified (its `domains` column stays empty). Always `allow_private_network = 0`, `trust_unverified_email = 0`, `default_role = member` whatever is sent. Not in the platform admin's list, get, change or remove (`/api/admin/sso`, the console's SSO page). Group rules: at most 50, a role of admin, member or guest (`owner` refused) and/or a team that belongs to the org (`teams.org_id`, slice 7; the web edits role rules only, team rules go through the API).
- **Routing:** `discover` and `start` send an org's verified domain to its provider first; `SignInMethod.passwordToo` while the org does not require SSO (told by the org's policy only), and the login page then offers both. A password is refused for an instance provider's domains, and for an org's domains only while it requires SSO.
- **§9.4 through an org provider:** the slice-0 linking rule holds (never a password account, an admin, the founder or one another identity holds); a verified email only; the email's domain verified by THAT org (another org's domain: `domain`); autoCreate off answers "Ask your organization's admin for an invitation." After the callback `orgs/sso.ts onSignIn` records the sign-in, marks the session, admits a person not in the org (`via = sso_jit`, mapped role or `defaultJoinRole`), never brings back a member an admin removed, never touches an owner, follows the role rules at every sign-in (no match: `defaultJoinRole`) and joins or leaves rule-made team memberships (`added_by = sso:<provider>`). The audit row names only the matched groups.
- **Step-up / connect** (`GET /api/auth/sso/start?org=<id>&for=step-up`, an account session): the org's provider for the signed-in account; the callback (a cross-site navigation, so the session hash is kept with the state at the start) signs nobody in: it links the identity when it is free and carries this account's own email, refuses one that is another account's, and marks the session. Returns to `/admin/orgs/<id>?tab=sign-in`. Audit `sso.step_up`.
- **requireSso** (`PUT /api/orgs/:id/sso/policy`, owners only): turning it on needs an enabled provider and an active owner who signed in through it (`SSO_LOCKOUT_GUARD`); while on, the provider cannot be disabled or removed. The seam's `OrgAuthority.ssoGate` (read on every decision, fail closed): for a member on a verified domain, an org-owned object is not found (no role, no grant) unless the web session carries the org's mark (the session actor's `loginSessionId` is now `ws:<hash>`), or, for a token, an agent or a job, the last sign-in is within `ssoFreshnessDays` (null: at least one ever). Members outside the verified domains count as guests (`OrgsService.effectiveRoleOf`, used by the org resolver and the seam) unless an owner lists them as exceptions; owners are never capped. Turning it on emits an access change for the members. The org itself stays visible, so Org settings can offer Connect.
- **Routes** (declared in `orgs/authz.ts` `ORG_SSO_POLICIES`, all `org` manage, cookie only): `GET /api/orgs/:id/sign-in`, `POST /api/orgs/:id/domains`, `DELETE /api/orgs/:id/domains/:domain`, `POST /api/orgs/:id/domains/:domain/check`, `PUT|DELETE /api/orgs/:id/sso`, `POST /api/orgs/:id/sso/test` (10 per org per hour), `PUT /api/orgs/:id/sso/policy`. Audit: `org.domain_added|removed|verified|lost`, `org.sso_provider_saved|removed`, `org.sso_policy_changed`, `org.sso_signin`, `sso.step_up`.
- **Web:** Org settings gains tabs (General, Sign-in) for owners and admins; Sign-in shows Domains (state, the TXT record, Check, Remove, Add), Provider (name, issuer, client ID, write-only secret, groups claim, role rules, Make accounts, On, the redirect URL, Test, Remove) and Require SSO (this session's state and Connect, the switch, token freshness, exceptions among members outside the verified domains).
- **Not in this slice:** the platform admin's manual verify and domain release in the Admin console, notifications to org admins when a domain is lost, team rules in the web form, a browser check of the Sign-in tab at 390 and 1280 px, Portal MCP tools.
### 13.6 Slice 8 as built (branch `feat/orgs-slice8-invites`, on top of `release/admin-oidc`)

- **Tables** (migrations 468-469; 478-479 held): `org_invitations` (468) as §8 (id `oinv_…`, `code_hash` = sha256 of the code, `teams` kept `[]` until slice 7); `orgs.suspended_by` (`owner` | `platform`) and `platform_audit.org_id` (469, filled for older rows from their `org:<id>` subject; `PlatformAudit.record` sets it from the subject by default).
- **Invitations** (`orgs/invitations.ts`): `POST /api/orgs/:id/invitations {email, role}` answers the code ONCE (`CreatedOrgInvitation`); the inviter copies `/admin/org-invite#<code>` (no mail; the fragment never reaches a request line). Owners and admins invite, members only with `membersMayInvite`, never a guest, a token or an agent, never into a suspended org, never `owner`, never above the inviter's role; an email already in the org is 409 `ALREADY_MEMBER`; one live invitation per email (a new one revokes the older); an email on a domain verified by ANOTHER org is 409 `INVITATION_OTHER_ORG_DOMAIN` (reads slice 10's `org_domains` when it exists). `GET` lists pending and expired ones (never the code), `DELETE …/invitations/:invitationId` revokes. **Accept** is `POST /api/orgs/invitations/accept {code}` (under `/api/orgs`, not the `/api/org-invitations/accept` of §10): a signed-in person, throttled 10 per 15 minutes per person (`auth_throttle` scope `invitation`, wrong codes count), the account email equal to the invitation's (403 `INVITATION_EMAIL_MISMATCH`), within 7 days (409 `INVITATION_EXPIRED`), into an active org, once (one conditional UPDATE claims it; a replay, a revoked one or a gone org is 404 `INVITATION_INVALID`); an existing member is refused, never re-roled. Joins with `via = 'invite'`.
- **Leaving and removal** (§6.9 row 1): in the same transaction as the membership, the grants the person made of their PERSONAL objects to the org and their creator grants on the org's objects are deleted (decided through the resolvers); others' grants stay; the access change is `org_membership_ended` (`org_suspended` for suspension; both added to the seam's `AccessChange`).
- **Suspension**: `POST /api/orgs/:id/suspend {reason?}` and `/resume` (owners, as a person); the Admin console's `POST /admin-api/orgs/:id/suspend|resume` (step-up, declared). An owner cannot resume a platform suspension (403 `ORG_SUSPENDED_BY_PLATFORM`). Every right from the org is none (resolver, org-owned objects, org grants already read the state); owners keep `view`. Audit `org.suspended|resumed` (medium, `by`).
- **Deletion**: `DELETE /api/orgs/:id` (owners): 409 `ORG_OWNS_OBJECTS` while it owns anything (move each object out first), else `deleting` at once (nobody sees it, pending invitations revoked, members told), purged after 30 days by the one-minute orgs sweep (`purgeDeleted`: grants to the org, invitations, break-glass entries, memberships, the org; `org.purged`).
- **Audit**: `GET /api/orgs/:id/audit?before&limit` (owners and admins) reads rows by `org_id`, newest first. New kinds: `org.member_invited|invitation_revoked|member_joined|suspended|resumed|deleted|purged`.
- **Web**: Org settings gains Invitations (owners and admins: email, role, Invite, the link shown once with Copy, pending and expired rows with Revoke); the accept page `/admin/org-invite` (takes the code off the address bar, Join); a sign-in redirect keeps the fragment.
- **Not in this slice:** stopping the leaver's sessions in org workspaces, closing terminals and withdrawing contributed Claude logins (the access change is emitted; acting on it is slice 7's "revoke closes sockets and stops sessions"), team memberships ending with the org (teams in orgs, slice 7), `requireSso` on accept and the SSO de-provisioning row (slice 10), deleting with a transfer in one call, the Admin console's buttons for suspend/resume (routes only; built in §13.7), the Org settings Suspend/Delete buttons, the Audit tab (slice 9). A member account still cannot reach the main portal (D-82 S1a), so today only admin accounts can accept.

### 13.7 The Admin console controls the instance (owner, 2026-11-01: "should all being controlled"; branch `feat/admin-console-control`)

The console becomes the one place where everything instance-wide is controlled. Every new route is declared in `admin/authz.ts` (policy `platform`; areas `users`, `targets`, `registration`, `settings`), is the same 404 as an unknown route on the main host, needs the step-up for every write, and writes a `platform_audit` row (`via: admin-console`) that never carries a password, a code or a client secret. The routes call the services the main portal uses, with the admin as the actor; nothing is decided twice.

- **Sections** (phone first, icon-only bottom bar below 1024 px): Users, Orgs, Workspaces, Sign-in, Settings, Audit. `#sso` opens Sign-in.
- **Users.** `POST /admin-api/users {email, displayName?, role?}` makes an account with a **one-time password made by the server and shown once** (24 characters, 144 bits; never stored in clear, never in a row). `PATCH /admin-api/users/:id {role?, displayName?}` (a demotion ends the account's portal and console sessions and its tokens; not your own role), `POST /admin-api/users/:id/password` (a new one-time password; every session of the account ends; not your own: change it in the portal), `DELETE /admin-api/users/:id` (not yourself, not the founder's account; the account leaves shares, teams and SSO identities and its tokens end; **what it owns stays where it is**). Suspend/resume, end sessions, token revoke and the `orgs.create` ability are slice 4's. The side effects live in `identity/accountAdmin.ts`, which the main portal's `/api/admin/users` now calls too.
- **Orgs.** `POST /admin-api/orgs {name, slug, ownerId?}` creates an org whose first owner is the account picked (the admin when absent; not counted against `createdPerUser`; `org.created` with `by: platform`). `GET /admin-api/orgs/:id`: the summary, members and roles, the objects it owns (kind, id, name: never content), pending invitations (never the code), open break-glass entries, and its SSO providers and domains where this portal has them (slice 10; `null` before). `DELETE /admin-api/orgs/:id {reason?}`: as an owner's delete (409 `ORG_OWNS_OBJECTS` while it owns anything, `deleting` at once, purged after 30 days). Buttons for suspend/resume, recover owner and break-glass start (reason, 10 characters) and end. These live in `orgs/platformOrgs.ts`, beside the org service.
- **Workspaces.** `GET /admin-api/workspaces`: every workspace on every target with its owner (account email, org or team name), status and image; never files, sessions or credentials. `GET /admin-api/targets`: every target with whether it answers (Connect ones marked). `POST /admin-api/workspaces/:target/:name/start|stop` asks the seam for `operate` exactly as the main portal's guard does: **D12 holds**, so another person's personal workspace is the same 404 as a missing one, and an org's needs a role in it or an open break-glass entry.
- **Sign-in.** `GET /admin-api/signin`: the server code's switch, source, age and session count (never the code), the console's OIDC issuer and allow list (read only: `PORTAL_ADMIN_OIDC_ALLOW` in the deployment), the admin host. `PUT /admin-api/signin/server-code {enabled}`; `POST /admin-api/signin/server-code/rotate` answers the new code ONCE and ends every main-portal session (accounts too). `POST /admin-api/sso` and `PATCH /admin-api/sso/:id` (edit, `enabled: false` to turn off) through `identity/sso.ts`; the secret is write-only and only "changed" is audited.
- **Settings.** `GET /admin-api/settings` and `PUT /admin-api/settings/:key {value, confirm?}`: the settings store (the same as the portal's Settings page). A protective switch moved off asks first; the store keeps its own trail and the console adds `setting.changed`.
- **Audit.** New filters: `actor` (exact, or a prefix ending in `:`), `org` (`platform_audit.org_id`), `from` and `to` (dates; a bare `to` counts that whole day). A "Refused" button shows `admin.signin_refused` rows.
- **Not built (needs a decision or a later slice):** moving objects between orgs or back to personal from the console (`orgs/transfer.ts` needs the mover to be a member of the target org and asks for credential consent; a platform transfer needs the owner's rule for who keeps the creator grant), so Workspaces has no "Move to organization"; reassigning a removed account's objects; listing each portal session of an account (counts only); the code itself stays in memory (a restart returns to the env code, as on the main portal); its sign-in switch is kept since §13.8.


### 13.8 The founder by SSO, and the server code off (owner request 2026-11-01: "replace current super admin user as alfian@isnan.me (i will log in via git.isnan.me sso), then let's shut down server code access"; branch `feat/founder-sso`)

- **Profile → Link.** P6 stands: an SSO sign-in never takes an admin or an account with a password by its email. The signed-in account links instead: `MyProfile.linkable` names the provider its own email signs in through (an org's verified domain first, else an instance provider) while it has no identity there; **Link** goes to `GET /api/auth/sso/start?for=link` (the query names no provider and no account: both come from the session; the server code cannot). The callback attaches the identity to THAT account only when the provider vouches for the account's own email, nobody holds the identity, and the account holds no other identity at that provider (`sso.ts #stepUp`); it opens no session, returns to `/profile?linked=1` (or `?link_error=<code>`), and writes `sso.linked` (or `sso.link_failed`). From then on the provider signs the account in by its subject.
- **Make founder.** `POST /admin-api/users/:id/founder {reason, serverCode?}` (step-up, `identity.founder_transferred`, severity high; the code is in no row). Only the current founder may, or whoever gives the server code (the only way while no account is marked; a wrong code is throttled per admin and writes `identity.founder_transfer_refused`). The target is an active admin. `u_owner` is a principal, not an account: moving the `users.founder` mark makes the account act as `u_owner`, so everything the founding user owns (the orgs, workspaces, buckets, vaults, sets, older tokens) follows with no row rewritten, and a transfer back undoes it. In the same transaction (`identity/founder.ts`) what the new founder owned under its own id (`owner_id`, user-owned rows) goes to `u_owner`, org memberships merge (the founding user's row stays where both exist), and every token and agent minted from either account is revoked (each would act as another user than it was minted as).
- **Server code off.** `PUT /admin-api/signin/server-code {enabled}` now switches sign-in with the server code ONLY (`Portal.setCodeSignIn`): off ends every server-code session at once and refuses the code at `/api/login`; accounts (password, SSO) keep signing in; the code still confirms a sensitive action for a signed-in admin (`chat/reauth.ts`). The switch is kept across restarts (`portal_meta.server_code_signin`). Turning it off is refused (409) while no active admin account can sign in to the main portal with a password (one whose domain is not SSO-only) or a linked identity at an enabled provider; `GET /admin-api/signin` lists every active admin with its ways in (`admins`). The main portal's own sign-in kill switch (`/api/admin/enabled`) is unchanged. `/api/session` answers `codeSignIn`, and the sign-in page then offers accounts only. This supersedes D-82's "the server code stays" for this instance at the owner's request (a decision row is due).
### 13.6 Org-scoped lists as built (owner request 2026-11-01, branch `feat/org-scoped-lists`)

- **Server** (`apps/server/src/authz/orgScope.ts`): `GET /api/workspaces`, `/api/chat/sessions`, `/api/tickets`, `/api/tickets/buckets`, `/api/knowledge/vaults`, `/api/ci/runs` and `/api/ci/repos` read `?org=`. The list's own visibility (`visible()` / `keep`) runs first; `?org=` only narrows, by the owner of the row's anchor: a workspace, bucket or vault itself; a session, CI run or CI remote through its workspace (the seam resolver's `parent`); a ticket through its bucket (no bucket: personal). `?org=<id>` keeps what that org owns, and only for a caller with an active role in that active org (`orgRoleIn`); an org they are not in, a suspended one or a forged id answers an empty list, never an error and never wider. An org's slug works as its id (`?org=konfersi`, audit 2026-11-01) under the same role check: a slug of an org the caller is not in, or of none, is the same empty list. The ticket list narrows in its query (`within`, the org's buckets), so its pages are full and its `total` and `counts` are the org's; its cursor is bound to those buckets. `?org=personal` keeps what no org owns. No `?org=` keeps today's list (everything visible). A CI runs cursor is bound to the scope.
- **Web:** `ORG_SCOPED_LISTS_LIVE` is true; `scopedList` sends `org=personal` or `org=<id>`.

- **Server** (`apps/server/src/authz/orgScope.ts`): `GET /api/workspaces`, `/api/chat/sessions`, `/api/tickets`, `/api/tickets/buckets`, `/api/knowledge/vaults`, `/api/ci/runs` and `/api/ci/repos` read `?org=`. The list's own visibility (`visible()` / `keep`) runs first; `?org=` only narrows, by the owner of the row's anchor: a workspace, bucket or vault itself; a session, CI run or CI remote through its workspace (the seam resolver's `parent`); a ticket through its bucket (no bucket: personal). `?org=<id>` keeps what that org owns, and only for a caller with an active role in that active org (`orgRoleIn`); an org they are not in, a suspended one or a forged id answers an empty list, never an error and never wider. `?org=personal` keeps what no org owns. No `?org=` keeps today's list (everything visible). A CI runs cursor is bound to the scope.
- **Web:** `scopedList` sends `org=personal` or `org=<id>`.
- **Tests:** server `orgs/orgScope.test.ts` (each list: an org's rows only, personal without org-owned rows, today's list without the parameter, a non-member org and a forged id empty, a member without a grant still sees nothing); web `lib/orgContext.test.ts`.
- **Not in this slice:** live socket updates (not scoped), Portal MCP list tools (they take no `org`).

### 13.6a Org-scoped metrics as built (owner request 2026-11-01, branch `feat/org-scoped-metrics`)

The Home dashboard and the glance rail showed instance-wide numbers in an org context (another org's workspace and agents, every ticket, every Claude, every dollar). Every summary they read now takes the same `?org=` and narrows the same way (`authz/orgScope.ts`: visibility first, then the anchor's owner; no `?org=` is today's numbers; an org the caller is not in, or a forged id, answers empty numbers).

- **Server.** `GET /api/glance` (Sessions, Agents, Needs attention: a session by its workspace, a ticket by its bucket, a failed run or a held deploy by its workspace; the snapshot cache is keyed by the scope, and `effectiveOrgScope` folds every org the caller is not in into one empty scope so made-up ids do not grow it). `GET /api/attention` (Needs you: each source sets an internal `anchor` on its items: a session's, run's or remote's workspace, a ticket's bucket, the MCP entry, skill version or persona pool it is about, an approval's workspace; the registry filters by it, counts follow, and strips it). `GET /api/claude-usage` (quota: a Claude through its workspace, `workspace_claudes.workspace_id`; alerts follow their Claude). `GET /api/usage-spend` (today, week, month: a recorded request through its session's workspace; budgets through the workspace they concern, a budget on everything is Personal; spikes and alerts likewise). `GET /api/keepgoing` (Autonomy: a chat through its workspace). `GET /api/tickets` page 1's `total` and `counts` now follow the scope too (the ticket service's `within`: the bucket keys the scope keeps), so the Tickets card's "open" is the context's.
- **Web.** `scopedPath` (lib/orgContext) adds the context's `?org=` to each summary read (glance, Needs you, quota, spend, Keep going); the CI, tickets and workspaces cards already read scoped lists. Each store loads again on a context switch, drops what it held (never shown as the new context's) and throws away a load that started before the switch (`createLiveStore({ scoped: true })`, the glance, Needs-you and quota stores). The live `workspaces` push carries every workspace the person may see, so it only updates the rows of the context's list (`scopedPush`); a workspace that came or went loads the list again in the context (the Home card and the Workspaces page). Empty cards say which context they counted in (InfoTip). Pace, Flow and Metrics are the portal's own pilot numbers across every program: in an org context their card and chip say "Personal only" and ask for nothing.
- **Tests.** Server `authz/orgScopeMetrics.test.ts` (each route: an org's numbers only, Personal without org-owned rows, today's numbers without the parameter, a non-member org and a forged id empty), `tickets/within.test.ts` (list, total and counts narrowed by `within`); web `features/glance/widgets/shared/orgScoped.test.ts` (the reads carry `?org=`, a switch drops a store's reading and a late answer, the push never adds a row).
- **Not in this slice:** the app icon badge and the nav's Needs-you count follow the context too (they read the same stores); the live socket's nudge topics are not scoped (each nudge only says "load again", and the load is scoped).

### 13.9 Org settings, complete (owner request 2026-11-01, branch `feat/org-settings-v2`)

- **Layout** (`apps/web/src/features/orgs/OrgSettingsPage.tsx`; docs/prd/ui-layout.md §2): a sticky bar of pill tabs, one section at a time, each its own path (`/admin/orgs/<id>/members`; General at `/admin/orgs/<id>`). The older `?tab=sign-in` (the SSO step-up's return) and `?tab=access` move to their tab's path.
- **Who sees what** (`rules.ts` `orgSections`, tested in `settingsRules.test.ts`): owners all ten sections: General, Members, Teams, Invitations, Objects, Access (was Sharing, [access.md](access.md)), Sign-in, Policies, Audit, Danger zone. Admins have no Policies or Danger zone. Members see General, Members, Teams, Objects and Access, plus Invitations (the form only) when `membersMayInvite` is on. Guests see General, Teams and Objects. A suspended org shows its owners General and Danger zone, and everyone else General. Inside a section, an action the server would refuse is not shown: role pickers as before; a team is managed by org owners and admins and by the team's owners; a share is revoked by org owners and admins or by who shared it; Move here is for members and up.
- **Sections:** General (name, the slug, created, your role, Leave). Members (roles, remove, Invite jumps to Invitations). Teams (create, delete, open a team to add or remove people and set team roles; anyone can leave a team). Invitations (as in slice 8). Objects (what the org owns, through the lists' `?org=<id>`; each opens in the org's context; Move here lists the person's personal objects (`?org=personal`), confirms, then shows the credentials consent step when a workspace has sets assigned). Sharing (the org's open shares, revoke). Sign-in (slice 10). Policies (owners: Members invite, Members create teams, Outside shares (saved, not in effect: no share leaves the org yet), Require SSO through its own route with the lockout guard). Audit (kind filter, 50 rows a page; owners also see session reads and break-glass entries, and can End an open one). Danger zone (owners: Suspend or Resume, and Delete once the slug is typed exactly).
- **Server:** `PATCH /api/orgs/:id` takes `policies` (owners only, as a person; only `membersMayInvite`, `membersCreateTeams` and `externalShares`, as booleans; merged into what is stored; the audit row `org.updated` names the keys). `Org.may` (`invite`, `createTeam`) tells the page what the services allow without exposing the policies to members. `GET /api/orgs/:id/audit?kind=` filters by kind or kind prefix (`_` matched literally; anything else is a 422). Fix: team, share and Move to organization audit rows now carry `org_id`. Before this, the org's audit never listed them.
- **Tests:** server `orgs/orgsSettings.test.ts` (policies: who may and which keys, merge, nothing written on refusal; `may` against the services; the kind filter; team and move rows in the org's audit, failing without the fix; the routes over HTTP); web `features/orgs/settingsRules.test.ts`; browser `tools/qa/org-settings.mjs` (390 and 1280, light and dark: every owner section, 44 px at 390, no sideways scroll, the picker and side list, the audit filter, Move here, Delete held until the slug matches).
- **Not in this slice:** making a share from Org settings (shares are made from the object's Share dialog), `externalShares` in effect, a share's revoke for a manager of the object who is not an org manager (the page does not offer it; the server allows it), team descriptions.

### 13.10 Member access (D-82 S1a, owner request 2026-11-01, branch `feat/member-access-s1a`)

Members (an org's people, signed in through its SSO) pass the session middleware; the route's declared policy and `can()` decide, so an org share or a team share at view or operate is exactly what they reach, and everything else is the same 404. Platform areas stay the admins'. The notes above that say a member account cannot reach the main portal no longer hold. Details: `docs/prd/multi-user.md` §22.

### 13.11 Fine-grained access as built (owner request 2026-11-01, branch `feat/org-fine-grained-access`)

See [access.md](access.md). Org shares also go to one person, end by themselves and carry a note (migration 477 rebuilds `org_shares`, adds
`access_requests`); who may grant is the ceiling of access.md §4 (manage on the object, never above your level or past your end; the owners'
policy `adminsMayShare`); members request and deciders approve or deny; `GET /api/orgs/:id/access/{catalog,object,people/:uid,requests}`
explain who reaches what and why. Org settings' Sharing became Access (Objects, People, Requests; members: Objects, Mine, Requests), with the
three-step Access sheet. Slice 7's "only its owner gives manage to a team" is replaced by the ceiling.

## 14. Double check: the multi-user approach and its state today

The direction of the existing PRDs is sound: one `can()`, resolvers per type, owners plus grants plus teams, no policy engine, the same 404, tokens capped at use time, shadow then enforce. The organization model above is a small extension of it. What is wrong is the distance between that design and the running code, and that several shortcuts taken "while there is one person" are now load-bearing for real second accounts.

### 14.1 Gaps (security), worst first

| ID | Gap | Evidence (✅) | Risk today | Fix |
| --- | --- | --- | --- | --- |
| G1 | **Every admin account is `u_owner` inside `can()`.** `requireSession` sets only `token` (`app.ts:593-604`); `actorOf` returns `owner()` for any request with a token and no `actor` (`authz/seam.ts:345-351`); nothing sets `actor` except the VS Code door. An admin session is a full session (`portal.ts:150-151`). | `grep "set('actor'"` finds only `vscode/routes.ts:335` | A second admin has the founder's rights everywhere; any audit row written through `actorString(actorOf(c))` names `user:u_owner` for them, so the audit cannot tell admins apart. | P1 |
| G2 | **SSO can mint full admins = the founder.** An instance provider with `default_role = admin` and `auto_create` makes every verified address of its domains an admin (`identity/sso.ts:163-172`, acknowledged), which by G1 is `u_owner`. | `identity/sso.ts:343`, `portal.ts:151` | Whoever controls the IdP controls the portal as the owner. Acceptable only while the owner configures every provider and controls the IdP. | P1, P6, §9.1 |
| G3 | **Portal MCP tokens have no owner.** `pmcp_tokens` has no `owner_id` (`store/migrations.ts:1011-1028`; later ALTERs add vaults, default workspace, client only); `actorOfPrincipal` gives every `cpat_` and `cpst_` the founder's id (`authz/seam.ts:366-371`). | as cited | A token minted by any admin acts as the founder; once members can mint tokens, a member's token escalates to owner. | P2 |
| G4 | **Reporter tokens fall back to the founder.** `#actor` uses `FOUNDING_USER_ID` when the stored user is not a user id (`reporter/service.ts:538-539`); the approver is the seam's actor, which by G1 is always `u_owner`. | as cited | Every `cprt_` token acts as the owner, whoever approved it; the bucket and origin scoping still hold. | P2 |
| G5 | **VS Code client tokens: the user is not passed.** `actorOfPrincipal({ kind: 'user', … })` with no `userId` (`vscode/routes.ts:335`) becomes a founder token (`authz/seam.ts:369-370`). | as cited | Same as G3 for editor clients. | P2 |
| G6 | **Most object types have no owner.** No owner column on `pools` (`store/migrations.ts:96`), `kg_vaults` (`:1080`), `ci_repos` (`:1456`), `workspace_claudes` (`:383`), and no `workspace_owners` table at all; `workspaces/authz.ts:11` says "There is no resolver of the `workspace` type yet". Without a resolver the seam gives the founder `manage` and everyone else nothing (`authz/seam.ts:230`), and `RESOLVER_REQUIRED` holds only `ticket_bucket` (`:85`). | as cited | Members cannot be given workspaces at all (D-82 S1b not built); a resolver registered late silently changes who sees what for every type except buckets. | P3 |
| G7 | **Route declarations are not enforced centrally.** `policyFor`/`declaredPolicies` are used only by tests (`grep` finds no middleware); the enumeration is per module (`workspaces/routeAuthz.test.ts:211`, `ci/routes.test.ts:208`, `reporter/hardening.test.ts:249`). Modules with routes and no `authz.ts`: accounts, appports, claudeusage, delivery, **identity**, knowledge, mcp, personas, platform, skills, usagespend. A rough count finds about 558 route registrations against about 372 declared keys (`grep` of `.get/.post/…(` and of declared `'METHOD /path'` keys; 🔬 approximate, the real number comes from the route table). | as cited | Safe today only because members are refused by `requireSession` before any handler (D-82 S1a). The day a member gets a full session, every undeclared route is open to them. | P4 |
| G8 | **Undeclared tools are allowed.** `requireToolPolicy` returns when a tool has no declaration ("left to its handler", `authz/seam.ts:128-132`). | as cited | A new tool is open to every token until someone declares it. | P4 |
| G9 | **Streams are not per user.** The live hub sends every topic nudge to every subscribed socket and the usage snapshot to every client (`live.ts:132`, `:164-165`); the socket admits any full session (`live.ts:65`, `sockets.ts:54`). | as cited | Fine with one person; with orgs, usage figures and activity nudges cross tenants. | P5 |
| G10 | **SSO links by email to any existing account**, including an admin with a password (`identity/sso.ts:335-347`); only an account already linked to another subject of the same provider is protected. `trust_unverified_email` exists as a switch (`:319`). | as cited | With org-run IdPs: account takeover. Today: as safe as the IdP the owner chose. | P6, §9.4 |
| G11 | **SSRF guard has a DNS-rebinding window** it accepts "for an admin-only portal" (`mcp/spec.ts:155-158`), and OIDC discovery is cached by issuer alone (`identity/oidc.ts:111-122`). | as cited | Org admins entering issuer URLs make it reachable by non-instance-admins. | P6, §9.8 |
| G12 | **Ticket buckets are open to every non-agent caller in the service** (`tickets/service.ts:2188-2191`: `#bucketOpenTo` is true for anyone but an agent); the bucket owner check depends on the route passing `actor` (`Caller.actor?`, `tickets/service.ts:127-136`). | as cited | A route or tool that builds a `Caller` without `actor` skips the owner check (T-1857 made it optional). | P3: make `actor` required on `Caller` for `ui` and `token` |
| G13 | **Audit actors are not people.** User creation records `created_by = 'ui'` (`app.ts:662`); identity routes write `account:<id>` (`identity/routes.ts:92-94`) while the seam writes `user:<id>`: two spellings of one person. | as cited | Org audit cannot be filtered per person reliably. | P1: one `actorString` everywhere |

### 14.2 Drift between the PRDs and the code

| PRD says | Code does | Resolution |
| --- | --- | --- |
| Usernames, setup token, invitations, devices (Identity, D1-D8) | Email accounts created by an admin, the server code as setup, no invitations, no devices table | Amend Identity to the email model; invitations arrive with orgs (§6.8). |
| SSO, passkeys, MFA "later" (Identity §4, Authorization §4) | Instance OIDC providers built (migration 406) | Amend both §4s; this PRD owns org SSO, Identity owns instance SSO. |
| Share bundles with consent, grants table (Sharing, Authorization §13) | Session shares only (`session_shares`); no `grants` table; no workspace sharing | Build `grants` once, for both workspace and org shares (slice 5); keep session shares as the session-only case or fold them into grants with caps. |
| Teams with invitations and acceptance, team-owned objects (Teams) | Global teams, admin-made, owners add members directly; teams own nothing | Teams become org-scoped (§6.1). |
| `multi-user.md` status "everything else is Not built" (2026-10-12) and open-items rows 11 and 35 (a WIP branch with unreleased 400-401) | 400-406 released; MU1-min, S1a, teams, shares, SSO on `main` | Refresh the status lines (a docs slice; not done here to keep this change to one new PRD and two pointers). |
| Platform admins hold no right on users' objects (D12, MO4) | The founder holds `manage` on every resolver-less type, and every admin account IS the founder (G1) | P1 then P3. |
| D-82: "~90 routes undeclared" | Still many (G7), and no central enforcement | P4. |

### 14.3 What is half built (and fine to build on)

The seam's signatures and the contracts (`ObjectType`, `Owner`, `Actor`, `RoutePolicies`, `ToolPolicies`, `statusForDeny`) are the right shape and only need `org` added. Session ownership (`chat_sessions.owner_id`, `store/migrations.ts:3454`) and the session resolver (`chat/authz.ts`) exist. Tool policies are enforced at dispatch (`portalmcp/server.ts:430`). The workspaces router is declared and guarded per route (`workspaces/authz.ts`, T-531). Bucket ownership fails closed (T-1993). The OIDC relying party is careful (PKCE, nonce, binding cookie, `redirect: 'error'`, body cap, issuer match, sealed secret) and has a fake IdP for tests. Members are default-deny (D-82 S1a), which is why G1-G9 are not exploitable by a member today; they become exploitable the moment a member is given more than the delegate door.

### 14.4 Verdict

Do not start organizations on top of the current layer. Finish D-82's S0 and S1b in the shape of P1-P6 first (they were planned; P1 and P2 are small and remove the worst problems), then add orgs as an owner kind and a grant subject. Doing orgs first would mean every org boundary is enforced by handlers that already treat every admin and every token as the founder.

## 15. Owner decisions (decided 2026-10-31)

| ID | Decision | Status |
| --- | --- | --- |
| OD-1 | Upgrade: **not** personal plus one default org. "Single instance needed per project": three orgs, isnan (pilot, tradingbot and the other personal and lab projects), konfersi (the Konfersi universe), kohilabs (memor.id); all on k3s pods for now. Today's resources are assigned by project (§11). | Decided (owner words: "need to rewrite some, single instance needed per project: isnan (pilot, tradingbot, etc), konfersi (konfersi universe), kohilabs (memor.id); all based on k3s pods for now"). Supersedes the earlier recommendation "personal + one default org". |
| OD-2 | Who creates orgs: the **instance admin grants a per-user ability** "can create organizations" (off by default). A new global **Admin console** on its own host `admin.pilot.ai.isnan.me` controls users globally (§6.11); the main portal serves no admin page. | Decided ("User-enabled access", "a new Admin menu ... even better as a new admin.pilot.ai.isnan.me"). Supersedes "instance admin only". |
| OD-3 | Org admins **can read members' session transcripts** in org workspaces, audited; every transcript view is an audit row visible to the member (§6.5). | Decided. Supersedes "never the transcript" (D14 amended for org workspaces only). |
| OD-4 | The instance owner has **full access (break-glass)** to any org's content, audited: reason required, an audit row, visible to the org's owners, time-boxed (§6.7). | Decided. Supersedes "none; ownership recovery only" (D12 and MO4 for org content only). |
| OD-5 | OIDC only in v1; `requireSso` turns members outside verified domains into guests; groups mapped at sign-in; no SCIM in v1. | Default taken, not asked; the owner may overrule. |
| OD-6 | The shared pod `kohi-event` (several programs): recommended owned by isnan and shared to konfersi at `operate`; split into per-org pods later. | **Open** follow-up decision (§11). |

## 16. What lives where (owner request 2026-11-01: "which area is only for org level, and which is per user level"; branch `fix/org-isolation`)

Three levels. **Instance** (the platform): run by instance admins in the Admin console (§6.11, §13.7), never shown per org. **Org**: owned by
an organization (`owner_kind = 'org'`), managed by its owners and admins, reached by members only through grants (§6.5); shown in the org's
context. **Personal**: owned by one person (`owner_kind = 'user'`), never reachable through an org role (§6.5 invariant 1); shown in Personal.
A child object (a session, a Claude, a repository, a CI run) has no level of its own: it is its workspace's (or its bucket's). The org switcher
only narrows (`?org=`, §13.6, §13.6a): Personal lists what no org owns, an org what it owns.

### 16.1 The matrix

✅ isolated as intended. ⚠️ a gap (named in 16.4). File references are to `apps/server/src` unless marked `web:` (`apps/web/src`).

| Area | Level | Who creates | Shared how | In the switcher | Today |
| --- | --- | --- | --- | --- | --- |
| Workspaces | personal or org (an unclaimed one: instance) | an admin (targets are the platform's, `connect/authz.ts:12-22`); a member cannot yet (D-82 S1b) | Move to organization (§13.5), org and team shares (§13.6) | the list by owner (`authz/orgScope.ts`) | ✅ resolver `authz/owners.ts:71`. ✅ D1 (D-111): the org of the creator's context when they may create there, else the creator (`orgs/creation.ts`) |
| Sessions, chats | child of the workspace; the creator's (D14) | anyone with `operate` on the workspace | session shares; OD-3 read for org admins | through the workspace | ✅ `sessionOwnerOf` (`app.ts:360`), `chat/authz.ts`, the list scoped (`chat/routes.ts`) |
| Claude logins (`workspace_claudes`) and quota | child of the workspace | `manage` on the workspace | the workspace's grants reach it (operate to use, manage to rename or remove) | through the workspace (`claudeusage/routes.ts`) | ✅ **fixed**: a resolver that follows the workspace (`authz/owners.ts:131`). Before: no resolver, so every admin account held `manage` on every org's Claudes, and a quota alert went to the founding user. ⚠️ §6.3 says "user only": D3 |
| Usage and spend, budgets | the workspace and Claude it counts; a budget on everything: instance | an admin (Usage is a platform area for members) | none | `?org=` on the summaries (§13.6a) | ✅ **fixed**: read as the signed-in person (routes) or the token's person (tools), through `seamVisibility` (`usagespend/actor.ts`) and `seamCanUseClaude` (`claudeusage/actor.ts:9`), installed in `index.ts`. Before: every read was the founding user's view, so an admin outside an org read that org's spend |
| Autonomy (Keep going) | personal (`keepgoing_policies.owner_id`), on a chat | `operate` on the session | none | by the chat's workspace (`keepgoing/routes.ts:34`) | ✅ |
| Auto-transfer (quota moves) | personal (`autotransfer_*.owner_id`) | the person (`self`) | none | n/a | ✅ (its per-Claude switch needs `operate` on the Claude, which now resolves) |
| Tickets and buckets | the bucket personal or org; a ticket is its bucket's | a person or an admin token, into Personal; then Move to organization | bucket shares to an org or a team | lists, totals and counts scoped (§13.6, §13.6a) | ✅ resolver `tickets/authz.ts`. ✅ **fixed**: a trigger files as its owner (`tickets/service.ts:588`). Before: a trigger filed in any bucket a tag route or a workspace default named |
| Reporter (config, sites, tokens) | the bucket's | `manage` on the bucket (an org bucket: its owners and admins) | follows the bucket | follows the bucket | ✅ `reporter/authz.ts:11-19` (not changed here: the reporter lane owns it) |
| Knowledge vaults | personal or org | a person (`POST /api/knowledge/vaults`) | Move to organization, shares | `?org=` on the list | ✅ **fixed**: a new or imported vault is its maker's (`knowledge/service.ts:451`). Before: the founding user's. ⚠️ `/api/knowledge/graph` keeps viewable vaults but ignores `?org=` |
| CI remotes, runs, environments, deployments | children of the workspace | `operate` on the workspace (a remote) or the remote (a run); an environment on first use | the workspace's grants (`ci/authz.ts:30-45`) | runs and remotes scoped (§13.6) | ✅. `ci_environments.owner_id` and `ci_deployments.owner_id` are written `u_owner` and never read (`ci/service.ts:1029-1030`): dead columns, left in place (migrations are append only) |
| Workspace git (repositories) | child of the workspace | the scan | the workspace's grants | `?org=` on the overview | ✅ **fixed**: a `repo` resolver (`authz/owners.ts:132`); the overview, the log and their tools keep the caller's workspaces (`repos/routes.ts:45`, `repos/portalTools.ts`). Before: any admin read every org's repositories |
| Pools: Secrets & env, Skillsets, MCP sets, Personas, Context, Browser | personal (an org owner is read by the resolver) | an admin (`POST /api/pools/:type`); the portal for its own sets | assignment to a workspace | n/a (platform pages) | ✅ **fixed**: a new set or a copy is its maker's (`pools/service.ts:472`); the list keeps the sets the caller may view; adding a set to a workspace needs `operate` on it (`pools/service.ts:596`, workspace create in `app.ts`, the `pool_*` tools, which now ask `can()` on the named set: `portalmcp/tools/pools.ts:102`); bulk assign needs `manage` on each workspace. ✅ D2 (D-111): Move to organization for sets; lists follow the org context (`pools/scope.ts`) |
| Delivery (the reconciler) | follows the assignments | n/a | n/a | n/a | ✅ through the assignment, which is now gated; delivery does not re-check owners, so existing assignments keep working |
| Accounts, endpoints, account pools | instance today (owner columns, `u_owner`) | an admin | an account pool's assignment | n/a | ✅ putting an account pool on a workspace needs `operate` on it (`app.ts`, the `account_pool_assign` tool, workspace create). ⚠️ the lists are not filtered (no org can own one yet): D5 |
| Schedules | instance (a view over triggers and helpers) | n/a | n/a | n/a | ✅ platform `system` (`schedules/authz.ts:10`) |
| Triggers | personal (`triggers.owner_id`) | `operate` on the workspace | none | n/a | ✅ runs as its owner, re-checked at run time (`triggers/runner.ts`); its tickets now too |
| Notifications and destinations | personal (`notify_*.owner_id`) | the person (destinations: admins only, multi-user §22) | none | n/a | ✅ delivery re-checks `can(view)` per recipient (`notify/pipeline.ts:154`, `:264`); a quota alert now reaches the Claude's workspace owners |
| Needs you (attention) | personal (snoozes keyed by the actor) | n/a | n/a | `?org=` by anchor | ✅ each source filters by `can()`; ✅ **fixed**: approvals list only what the person may decide |
| Approvals | the workspace's (else the asking session's; none: instance) | an agent asks | n/a | by workspace | ✅ **fixed**: the queue, one request, allow and deny need `operate` on the workspace or the session (`approvals/authz.ts:38`). Before: every person saw, and could deny, every request |
| Portal MCP tokens | personal (`pmcp_tokens.owner_id`, migration 461) | a person (admins; members not yet) | none | n/a | ✅ a token never exceeds its person. ⚠️ the `org_id` narrowing of §6.5 invariant 5 is not built: D4 |
| VS Code tokens | personal (a `pmcp_tokens` row) | the person, approved in the portal | none | n/a | ✅ its lists keep viewable rows (`vscode/routes.ts`). ⚠️ they take no `?org=` |
| App ports | personal, in memory (`appports/grants.ts`) | `operate` on the workspace | none | n/a | ✅ |
| Glance widgets, Home layout | personal (intended) | n/a | n/a | the numbers are scoped (§13.6a) | ✅ server. ✅ D6 (D-111): per person and org context on the server (`glance/layouts.ts`, migration 910) |
| Connect targets | instance, or an org's (D-111: a PORTAL_K8S_TARGETS entry's `org`) | an instance admin | none | `?org=` on the lists | ✅ resolver `connect/authz.ts` (`targetLevel`); enrolled targets stay the platform's; `connect_targets.owner_id` is written and never read |
| Templates | not built (no table) | n/a | n/a | n/a | ✅ fails closed (required, no resolver: `authz/owners.ts`) |
| Settings | instance (`portal_meta` `setting:*`); org (`orgs.policies`); personal (notification prefs; the org context, per device) | instance: admins; org: owners | n/a | n/a | ✅ `settings/authz.ts`; org policies owners only (§13.9) |
| Audit | instance (`platform_audit`); an org's rows by `org_id` (migration 469) | the services | an org's owners and admins read its rows; a person reads rows about themselves | n/a | ✅ the org audit (`orgs/service.ts`), `platform/audit.ts:81` |
| General Manager | personal (one `kind = 'manager'` session per account) | the person | none | n/a | ✅ `app.ts:732` (`managerOwner`) |
| MCP catalog, skill library | instance (the reviewed library) | admins; agents propose | public level | n/a | ✅ unchanged (§6.3, Q3) |

### 16.2 What changed in this branch (each with its test)

- `claude` and `repo` resolvers that follow the workspace, required (fail closed): `orgs/orgIsolation.test.ts` (rights; an admin outside the org gets the missing 404; a workspace grant reaches the Claude; `ownersOf` of a Claude is its workspace's org owners).
- Approvals scoped to what the person may operate: `orgs/orgIsolation.test.ts` (the queue, one request, deny, allow, Needs you; the portal itself lists all).
- Usage and spend read as the signed-in person through the seam: `orgs/orgIsolation.test.ts` (the rules), `claudeusage/service.actor.test.ts` (no actor is the portal itself), `usagespend/routes.test.ts` (the actor comes from the session).
- Repositories overview and log scoped: `orgs/orgIsolation.test.ts` (the founder, an org context, Personal, another org's owner, an admin outside; a log for another org's workspace or repository is the 404).
- Sets: the maker owns; `operate` to add one to a workspace: `pools/pools.test.ts` (the last test). Trigger tickets: `tickets/triggerOwner.test.ts`.

### 16.3 Removed (no behaviour change)

`ORG_SCOPED_LISTS_LIVE` and the unused `empty` argument of `scopedList` (`web:lib/orgContext.ts`: the server has scoped every list since §13.6); `usagespend/actor.ts` `creatorOf` (always the founding user, used by nothing but its own test); the stale "no workspace resolver yet" note in `workspaces/authz.ts`; the founding-user actor of the usage routes and tools.

### 16.4 Decisions (decided: D-111)

The owner approved every recommendation below on 2026-11-01 ("yes please can continue"; `docs/dev-sessions/DECISIONS.md` D-111). Built on
branch `feat/org-decisions-d111`:

- **D1, built.** `CreateWorkspaceRequest.owner` (`personal` or an org id or slug) decides the owner before anything is made
  (`orgs/creation.ts` `ownerFor`): the org's owners and admins create there; a member only while the new org policy
  `membersCreateWorkspaces` is on (off by default, Org settings, Policies); a member without it or a guest is refused with 403
  ORG_CREATE_WORKSPACE_NOT_ALLOWED (never silently made personal); an org the person is not in is the 404. An org-owned one gets the creator
  grant and an audit row `workspace.created_in_org` with the org's id. Personal (or no owner): the creator, no longer the founding user
  (`workspaces/identity.ts` `allocate`, `workspaces/manager.ts` `create`). The New workspace dialog has an Owner select (Personal and the orgs
  whose `Org.may.createWorkspace` is on), defaulting to the current context; its add-on sets follow the chosen owner. Tests:
  `orgs/orgDecisions.test.ts`, `orgs/orgsSettings.test.ts`, web `features/orgs/decisions.test.ts`.
- **D2, built.** `POST /api/pools/:type/:id/move-to-org` (`ORGS_API.movePool`): slice 5's transfer for a set of any multi-pool type
  (`orgs/transfer.ts`: `manage` on the set, member or up in the org, the creator grant, audit `object.transferred` with `poolType`). A Secrets
  & env set answers 409 SHARE_EXPOSES_CREDENTIALS until `acknowledgeExposure: true` (the org's owners and admins can read it once the org owns
  it). Assignments are not touched: the workspaces it is delivered to keep it. Offered on the Pools page (a set's menu, Move to
  organization) and in Org settings, Objects (sets are listed; Move here). `PoolSummary.orgId` says which org owns a set.
- **Pools and Schedules in the org context (owner 2026-11-01, "pool also still not per org").** `GET /api/pools/:type?org=` keeps that
  context's sets: an org's own and those shared to it (a grant to the org or one of its teams, `shared: true`), Personal what no org owns, an
  org the caller is not in nothing (`pools/scope.ts`). `?for=<workspace>` (assigning sets to a workspace) keeps the sets of that workspace's
  owner's context plus the ones it already has. `GET /api/account-pools?org=` narrows by owner the same way (none is org-owned yet, D5: an
  org's list is empty). `GET /api/schedules?org=`: a trigger follows its workspace's org; the portal's own loops and helpers are listed in
  Personal only. The Pools page and the Schedules page ask through `scopedList`; Targets are unchanged (instance-level, admins).
- **D3, kept.** A Claude login follows its workspace's org (rights, quota alerts, usage), as built in 16.2. A person owner per login comes
  when people bring their own logins into an org workspace.
- **D4, later (recorded).** Portal MCP tokens narrowed to one org (`org_id`, §6.5 invariant 5) come with member tokens.
- **D5, recorded.** Accounts, endpoints and account pools stay instance-wide (platform) until an org needs its own API keys.
- **Targets: org-ownable (owner 2026-11-01, "target should also be per org"; a change of D5 for targets).** A PORTAL_K8S_TARGETS entry
  names its org (`org`, an id or a slug; `workspaces/kubeTargets.ts`; set in `deploy/k3s/portal.yaml` for isnan, konfersi and kohilabs, so it
  survives redeploys). The `target` resolver (`connect/authz.ts` `targetLevel`) gives the org's owners and admins `manage`, a member `view`
  (`operate` while `membersCreateWorkspaces`), a guest or an outsider nothing; the instance's admins keep `manage` on every target (the
  Admin console runs them all, `/admin-api/targets` unchanged). An org that does not resolve leaves the target the platform's. Lists:
  `GET /api/workspaces/targets?org=` and `GET /api/connect/targets?org=` keep the context's targets (an org's own; Personal the instance's,
  which only admins see). The Targets page and the Workspaces page (New workspace) ask in the context. Tests: `orgs/orgDecisions.test.ts`,
  `workspaces/kubeTargets.test.ts`.
- **D6, built.** The Home and Glance layouts are saved per person and org context on the server (`/api/layouts`, migration 910,
  `glance/layouts.ts`); the device's layout is copied up once on first load (docs/prd/glance-widgets.md §7). The btw panel's width stays a
  device preference (per person).

The questions as they were put:


| ID | Question | Recommendation |
| --- | --- | --- |
| D1 | A workspace made in an org's context: straight into the org, or personal then Move? (Today it is always the founding user's, `workspaces/identity.ts:333`.) May members create workspaces (D-82 S1b)? | Owner = the creator; in an org context the org (member or up there), with the creator grant. |
| D2 | The founding user's Secrets & env sets, Skillsets and MCP sets assigned to the org workspaces (isnan, konfersi, kohilabs): keep them personal (the people who operate the workspace can read what is delivered into it), or move them to each org? | Add Move to organization for sets (§13.5's transfer with its credentials consent) and move them by the OD-1 map. Until then they keep working: delivery follows the existing assignments. |
| D3 | A Claude login: §6.3 says "user only" (D-33, D-53, D-56: a login is the person's). Built here: it follows its workspace (rights, quota alerts, usage). Keep, or record a person owner per login? | Keep following the workspace; add a person owner when people bring their own logins into an org workspace. |
| D4 | Portal MCP token `org_id` (a token narrowed to one org, §6.5 invariant 5)? | Build it with member tokens. |
| D5 | Accounts, endpoints and account pools: instance-wide (admins), or org-owned? | Instance-wide until an org needs its own API keys; then the same Move. |
| D6 | Glance and Home layouts per person (keyed by the signed-in id) instead of per device? Changing the key resets the founder's saved layout once unless it is copied. | Per person, copying the old key on first read. |
