# PRD: Organizations and organization SSO

| | |
| --- | --- |
| Status | **Draft v0.1** (2026-10-31). Design only, **Not built**. Written from the code on `origin/main` at `e311a679` (portal 2026.10.31-5), the multi-user PRDs and the standing decisions. ✅ = checked in the code here (file:line), 📄 = documented elsewhere (linked), 🔬 = unverified. §14 is an honest review of the multi-user state today and lists what must change BEFORE organizations are safe. |
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
| O-G5 | Upgrading changes nothing for the owner: every existing object stays theirs, the server code still gets the instance admin in. |
| O-G6 | Leaving, removal, deletion and SSO de-provisioning have a defined, tested effect on every right and every running thing (sockets, sessions, terminals, tokens). |

## 4. Non-goals

SAML in v1 (§9.9); SCIM in v1 (§9.6); billing, quotas and plans per organization; cross-portal federation; an organization-level policy language; nested organizations or organizations owning organizations; making the portal public or commercial (D-53: internal only, Konfersi and Kohilabs); an org admin reading a member's private chat transcript (§6.5, decision OD-3).

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
| Organization `org_…` | A name, a slug (unique, used in URLs and the switcher), a state (`active` / `suspended` / `deleting`), policies (§6.6) | Always has at least one active owner (service + trigger, like teams). Created by any active account unless the instance policy restricts it (decision OD-2). |
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
| session | **user only, private** | D14 holds: a session belongs to its creator even in an org workspace. OD-3 decides what org admins may do on it. |
| claude (a workspace Claude login) | **user only** | D-33, D-53, D-56: a login is the person's; an org can only receive it by the person's consented contribution, never own it. |
| trigger, personal (tokens, devices, notification destinations) | user only | A trigger in an org workspace still runs as its owner with `can` at run time. |
| target | platform, **org** (later slice) | An org admin may enrol a Connect host for the org only (`platform(targets)` stays for instance-wide ones); host-level targets stay instance-admin only (D15). |
| mcp_entry, skill_* | platform, user (library) | Unchanged; an org-private library is an open question (§12, Q3). |

### 6.4 Sharing at the org level

A share is the [Sharing](sharing.md) bundle of grants, with one more subject kind:

- **Subjects:** `user`, `team`, **`org`** (every active member, admin and owner; never guests). A team subject must belong to the same org as the sharer's context, or to an org the sharer is in.
- **Levels:** view or operate to an org; view, operate or manage to a team or a user. `manage` to a whole org is refused (it would let any member re-share and delete).
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
2. **Sessions stay private** (D14). Org roles give no `view` on a session, also in an org workspace (unless OD-3 says otherwise).
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

The founding user stays the **platform admin** (`role = admin`, `platform(*)` areas). With organizations the platform admin: creates, suspends and deletes organizations; sees the list of organizations with names, member counts and owners (not their content); approves a domain for an org when DNS is not practical (audited, noisy); **recovers ownership** of an org that has no active owner (makes a named member owner, or themselves, with a fresh re-auth, a reason, an audit row of severity `medium` and a notification to every org admin). The platform admin holds **no right on org content** by role, as D12 and MO4 already say; if the owner wants a break-glass, that is OD-4.

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

## 7. Personal and organization context in the UI

- A **switcher** at the top of the side bar (desktop) and in the account sheet (phone, icon only): Personal, then each org by name with its role as an InfoTip. 44 px rows, one-word labels.
- The context is kept per device (`claudepilot.context.<userId>` in local storage) and sent as `?org=` on list calls. Lists show only that context; a "Shared with me" view shows grants from anywhere.
- **New workspace / project / vault** defaults the owner to the current context and shows it as a chip the person can change (to contexts where they may create).
- The share dialog gains subjects **Organization** and **Team** (only those of orgs the person is in), with the consent screen of Sharing.
- **Org settings** (owners and admins): Members, Teams, Invitations, Domains, Sign-in (SSO), Policies, Audit. Members see Members (not guests) and Teams.
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
| `GET /api/orgs` (mine), `POST /api/orgs` | signed-in (list filtered); create: signed-in + instance policy |
| `GET/PATCH/DELETE /api/orgs/:id` | `org` view / manage / owner-only (a declared `handler` check for owner) |
| `GET/POST /api/orgs/:id/members`, `PATCH/DELETE /api/orgs/:id/members/:uid`, `POST /api/orgs/:id/leave` | view (members+, guests refused) / manage |
| `GET/POST/DELETE /api/orgs/:id/invitations…`, `POST /api/org-invitations/accept` | manage / signed-in + code + email match |
| `GET/POST/DELETE /api/orgs/:id/teams…` | under `org` + `team` rules |
| `GET/POST/DELETE /api/orgs/:id/domains…`, `POST …/domains/:d/check` | manage; check rate limited |
| `GET/PUT/DELETE /api/orgs/:id/sso`, `POST …/sso/test` | manage; enforcement owner-only |
| `GET /api/orgs/:id/audit` | manage |
| `POST /api/objects/:type/:id/transfer` | `manage` on the object + membership in the target org |
| Platform: `GET /api/admin/orgs`, `POST /api/admin/orgs/:id/suspend|resume|recover-owner`, `POST /api/admin/orgs/:id/domains/:d/verify` | `platform(users)` + re-auth for recover |

Portal MCP: `org_list` (signed-in, own orgs) and `org_members` (org view) for the General Manager; **no** tool creates orgs, changes roles, SSO or domains (people only, like bucket admin today). Every route and tool is declared; the module's enumeration test fails on an undeclared one.

## 11. Migration of existing data

Nothing is rewritten. Every existing object keeps `owner_kind = 'user', owner_id = 'u_owner'` (personal). Then, by default (decision OD-1):

1. The migration creates **one organization** owned by `u_owner` (name and slug from an instance setting, default "Pilot" / `pilot`), adds every existing account (admin → org `admin`, member → `member`, `via = 'migration'`), moves every existing team into it (`teams.org_id`), and records it in `portal_meta.default_org`.
2. Existing instance SSO providers stay instance-wide (`org_id = NULL`); their `default_team_id` keeps working; their JIT accounts also join the default org with `member`.
3. Session shares stay as they are (they are user or team grants on one session).
4. The owner then moves what should be shared work into the org with **Move to organization** (bulk for workspaces, buckets, vaults), or creates more orgs (Konfersi, Kohilabs) and moves into them.

The alternative (OD-1 b) is "everything becomes the default org's"; it would make every existing object visible to every admin of that org and blurs what is personal, so it is not recommended.

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
| Q2 | Org-scoped Connect targets: in v1 or later? Default later (slice 9). | Product |
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

### 13.2 Slices (each with its tests and a blind security review, D-82 style)

| # | Slice | Tests (minimum) |
| --- | --- | --- |
| 0 | P1 + P2 (actor and tokens) | two admin accounts get different `actorString`; a token minted by `u_b` cannot reach `u_a`'s bucket; reporter token with a non-user id refused; cookie-less socket anonymous |
| 1 | P3 + P4 (owners, resolvers, enumeration, middleware) | whole-app enumeration: no undeclared route or tool; generated probes per declared policy with `u_a`/`u_b`; unowned → 404 |
| 2 | P5 + P6 | cross-user live/search/aggregator leaks (X-cases); SSO linking matrix of §9.4; DNS-rebinding guard with a fake resolver |
| 3 | Orgs core: tables, `org` object type, memberships, roles, invariants, the default-org migration, the platform admin list and recovery | last owner cannot leave (service and trigger, two connections); org 404 for non-members; migration on a copy of the real schema keeps every owner |
| 4 | Org-owned objects + Move to organization (workspace, bucket, vault first) | org admin manages, member none without grant; creator grant; personal objects unreachable by org admin; transfer re-consents credentials |
| 5 | Org-level and team sharing (grants with `subject_kind = 'org'`), teams scoped to orgs | guest excluded from org grants; leaving ends grants made; team of org A never counts for a user who left A; revoke closes sockets and stops sessions |
| 6 | Invitations, leaving/removal effects, suspension, deletion, audit | single use, expiry, email match, throttle; every §6.9 row as a test |
| 7 | Web: switcher, context filter, share dialog subjects, Org settings (Members, Teams, Invitations, Policies, Audit) | `tools/qa` at 390 and 1280, light and dark, 44 px, no horizontal scroll; context never widens (API test with a forged `?org=`) |
| 8 | Org SSO: domains (TXT), org providers, JIT, groups, `requireSso`, step-up, token freshness | DNS fake; domain unique across orgs and instance providers; owner never mapped; enforcement lock-out guard; fake IdP (`identity/fakeIdp.ts` ✅ exists) for every §9.4 row |
| 9 | Later: org-scoped Connect targets, SCIM, org library | — |

Abuse matrix: Authorization §12 gains O1-O15 (org object across tenants, org grant to guest, team cross-org, forged context, token narrowed by `org_id`, suspended org, removed member's agent token, JIT into another org's domain, IdP minting an admin's email, requireSso bypass with a password session, discovery for an unverified domain, invitation replay, invitation to another org's domain, transfer without membership, platform admin reading org content).

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

## 15. Decisions that need the owner

| ID | Decision | Recommended default |
| --- | --- | --- |
| OD-1 | Upgrade: existing data stays **personal** (yours) and one default org is created holding today's accounts and teams; you move what you want into orgs. Or: everything becomes the default org's. | Personal + one default org (§11). |
| OD-2 | Who may create an organization: any account, or only the instance admin (you) for now. | Instance admin only in v1 (internal portal, D-53); a policy switch opens it later. |
| OD-3 | Org admins and private sessions in org workspaces: no right at all (D14 as is), or may **stop** a session and see its title, creator and cost (never the transcript). | Stop + metadata, never the transcript. |
| OD-4 | Your access as instance owner to org content: none (D12, MO4) with ownership recovery only, or a loud break-glass (re-auth, reason, 1 h, org admins notified). | None; ownership recovery only (§6.7). |
| OD-5 | Org SSO protocols and enforcement: OIDC only, `requireSso` makes non-domain members guests, groups mapped at sign-in (no SCIM in v1). | Yes to all three; SAML and SCIM only on a concrete need. |
