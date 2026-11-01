// D-82 S1a, member access (owner request 2026-11-01: org people sign in through their org's SSO and USE the portal for what their org gives
// them). A member's session passes the session middleware like an admin's; what it may reach is decided by the route's declared policy:
//   - `objects`: the one `can()` on every object the route names (an org grant, a team grant, a session share, their own objects), so the
//     same 404 as a missing object for anything else; a route whose checks named NO object in this request (every one optional or left out of
//     the body or query) reaches its handler only when it is a door below, because such a handler may fall back to something of its own;
//   - `platform`: the seam refuses anyone who is not a platform admin (the same 404);
//   - `signed-in`, `self`, `handler`: ONLY the doors listed here. Each was read for a founding-user fallback or an unfiltered answer before it
//     was listed; the reason says why it is per person. Every other one answers a member the same 404 as an unknown route, so a new
//     `signed-in` route is closed to members until someone reads it and lists it (fail closed; authz/memberAccess.test.ts enumerates them).
// A platform admin (the founding user, an active admin account) is never held to this list: admin behaviour is unchanged.

/** `METHOD /full/path` (as the route table keys it) → why a member may pass this door. */
export const MEMBER_DOORS: Readonly<Record<string, string>> = {
  // Lists that keep what the person may view (`visible`) and narrow by `?org=` (authz/orgScope.ts).
  'GET /api/workspaces': 'visible(workspace) then the org scope',
  'GET /api/workspaces/labels': 'labels of the workspaces the person may view only',
  'GET /api/workspaces/usage': 'usage rows of the workspaces the person may view only',
  'GET /api/workspaces/targets': 'visible(target): targets are the platform’s, so a member gets none (the page then offers no New workspace)',
  'GET /api/chat/sessions': 'each row checked with view before it is shown; the cursor names only shown rows',
  'GET /api/chat/policy': 'one boolean: whether the policy allows Bypass at all (no person, no object)',
  'GET /api/tickets': 'each row and its bucket pass view (tickets/routes.ts viewerOf), then the org scope',
  'GET /api/tickets/tags': 'counted over the buckets the person may view only (tickets/service.ts #where)',
  'GET /api/tickets/timeline': 'filtered like the list',
  'GET /api/tickets/buckets': 'visible(ticket_bucket) then the org scope',
  'POST /api/tickets': 'a named bucket needs operate; none named: a bucket the person may file in (FR39), else refused',
  'GET /api/knowledge/vaults': 'the vaults the person may view (CallerScope.canView)',
  'GET /api/knowledge/graph': 'the vaults the person may view (viewScope)',
  'GET /api/ci/runs': 'each run checked with view (no SQL count fast path for a member: seesEverything is false)',
  'GET /api/ci/repos': 'visible(ci_repo) then the org scope',
  'GET /api/attention': 'each source filters by its own can() for this person (organizations slice 2)',
  'POST /api/attention/snooze': 'the person’s own Later, keyed by the actor',
  'GET /api/glance': 'built for the actor (glance/authz.ts)',
  // Organizations: every answer is the person's own memberships and abilities; creating one is the `orgs.create` ability's (the service).
  'GET /api/orgs': 'the orgs the person is in (OrgsService.mine)',
  'GET /api/orgs/abilities': 'the person’s own abilities',
  'GET /api/orgs/break-glass': 'the person’s own open entries (none for a member)',
  'POST /api/orgs': 'the service refuses without the orgs.create ability (403 ORG_CREATE_NOT_ALLOWED)',
  'POST /api/orgs/invitations/accept': 'the code, the account email match and the throttle (orgs/invitations.ts)',
  // Notifications: everything keyed by the actor's user id. Destinations are read only: a new webhook may reach a private network, so a
  // member does not make one yet (Web Push is the browser's own service).
  'GET /api/notify': 'the person’s own overview',
  'GET /api/notify/prefs': 'the person’s own',
  'PUT /api/notify/prefs': 'the person’s own, audited',
  'POST /api/notify/push': 'the person’s own Web Push subscription',
  'GET /api/notify/destinations': 'the person’s own list',
  'GET /api/notify/log': 'the person’s own deliveries',
  'GET /api/notify/history': 'the person’s own',
  'POST /api/notify/history/read': 'the person’s own',
  'DELETE /api/notify/history': 'the person’s own',
  'GET /api/notify/mutes': 'the person’s own',
  'GET /api/notify/mutes/offer/:ref': 'a session or Claude the person may view only (notify/routes.ts)',
  'POST /api/notify/mutes': 'the person’s own, audited',
  'DELETE /api/notify/mutes/:id': 'the person’s own',
  'DELETE /api/notify/mutes': 'the person’s own',
  'POST /api/notify/act': 'a one-time action token made for this person; the decision is checked with can() again',
  'GET /api/platform/audit': 'a person who is not an admin reads only rows about themselves (platform/routes.ts)',
};

export const isMemberDoor = (key: string): boolean => Object.prototype.hasOwnProperty.call(MEMBER_DOORS, key);
