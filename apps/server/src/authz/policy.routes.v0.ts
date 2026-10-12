// Route policy v0: the FALLBACK declaration of every route no module declares itself (docs/prd/authorization.md Appendix A, generated from the
// real route table on 2026-10-12 and reviewed row by row; Appendix C adds the sockets and `/mcp`). The layer consults this table only for a key
// with no declaration in a `<module>/authz.ts` (policy.ts `effectivePolicyFor`), so a module that declares its own routes wins without touching
// this file, and the enumeration test (enumeration.test.ts) names the rows here a module has since superseded. The notation of the PRD, as
// data: `pub` = anyone; `signedIn` = any active user (`filter` names what a list holds, `creates` what a creator will own); `self` = the
// caller's own; `platform(area, verb)` = platform admins (`view` is admin-only too, except the `version` area: evaluate.ts); `obj([...])` = a
// right on each object the request names (ANDed); `reauth(...)` = a recent password check (enforced in accounts mode: enforce.ts).
// What this table cannot say is left to the handler and noted on the row: a conditional re-auth ("when it holds secrets"), a conditional
// object (a budget's scope), a consent step.

import type { ObjectCheck, ObjectType, PlatformArea, RoutePolicies, RoutePolicy, Verb } from '@portal/contracts';
import { declareFallbackPolicies } from './policy.js';

const pub = (why: string): RoutePolicy => ({ kind: 'public', why });
const signedIn = (o: { filter?: ObjectType; creates?: ObjectType } = {}): RoutePolicy => ({ kind: 'signed-in', ...o });
const self: RoutePolicy = { kind: 'self' };
const platform = (area: PlatformArea, verb: Verb): RoutePolicy => ({ kind: 'platform', area, verb });
const check = (type: ObjectType, verb: Verb, from: ObjectCheck['from'], param: string, o: Pick<ObjectCheck, 'optional' | 'many' | 'poolTypeParam'> = {}): ObjectCheck => ({ type, verb, from, param, ...o });
/** The workspace of `/:target/:name`. */
const ws = (verb: Verb, o: Pick<ObjectCheck, 'optional'> = {}): ObjectCheck => check('workspace', verb, 'path', 'target+name', o);
const obj = (checks: ObjectCheck[], o: { filter?: ObjectType; creates?: ObjectType } = {}): RoutePolicy => ({ kind: 'objects', checks, ...o });
const reauth = (p: RoutePolicy): RoutePolicy => ({ ...p, reauth: true });

export const ROUTE_POLICIES_V0: RoutePolicies = {
  'GET /healthz': pub('liveness'),
  'GET /api/session': pub('AuthStatus: who is signed in, setup, registration mode, devSeed'),
  'POST /api/login': pub('dev seed only: 404 unless PORTAL_DEV_SEED (never in production)'),
  'POST /api/logout': pub('clears the cookie; works with or without a session'),
  'GET /api/admin/state': platform('registration', 'manage'), // returns the server code in clear to every signed-in tab: replaced by Me and the devices list
  'POST /api/admin/code': platform('registration', 'manage'), // rotating the shared code: gone with it
  'PUT /api/admin/enabled': platform('registration', 'manage'), // sign-in switch moves to IdentitySettings.signInEnabled; reauth
  'POST /api/admin/system/key/reset': reauth(platform('system', 'manage')), // the secret key and delivery pause are the platform's
  'GET /api/admin/system': signedIn(), // any user sees the trust state; secret key and backups only for admins (handler redacts)
  'POST /api/admin/system/key/setup': reauth(platform('system', 'manage')), // the secret key and delivery pause are the platform's
  'POST /api/admin/system/key/unlock': reauth(platform('system', 'manage')), // the secret key and delivery pause are the platform's
  'POST /api/admin/system/resume': reauth(platform('system', 'manage')), // the secret key and delivery pause are the platform's
  'GET /api/workspaces/targets': signedIn({ filter: 'target' }), // only targets the person may use; admins also see problems
  'GET /api/workspaces/usage': signedIn({ filter: 'workspace' }), // cpu and memory of the workspaces the person may view
  'GET /api/workspaces/:target/:name/claude-login': obj([ws('view')]), // status of a Claude's sign-in
  'POST /api/workspaces/:target/:name/claude-login': obj([ws('operate'), check('claude', 'manage', 'query', 'claude', { optional: true })]), // signing in is for the Claude's own person; a Claude a person signed in is theirs
  'POST /api/workspaces/:target/:name/claude-login/code': obj([ws('operate'), check('claude', 'manage', 'query', 'claude', { optional: true })]), // signing in is for the Claude's own person; a Claude a person signed in is theirs
  'DELETE /api/workspaces/:target/:name/claude-login': obj([ws('operate'), check('claude', 'manage', 'query', 'claude', { optional: true })]), // signing in is for the Claude's own person; a Claude a person signed in is theirs
  'POST /api/workspaces/:target/:name/claude-logout': obj([ws('operate'), check('claude', 'manage', 'query', 'claude')]),
  'GET /api/workspaces/:target/:name/terminals': obj([ws('operate')], { filter: 'terminal' }), // terminals are private to their creator in the UI (not a boundary: operate is a shell)
  'POST /api/workspaces/:target/:name/terminals': obj([ws('operate')]), // audit terminal.opened
  'DELETE /api/workspaces/:target/:name/terminals/:term': obj([check('terminal', 'manage', 'path', 'target+name+term')]), // the creator, or a manager of the workspace
  'GET /api/workspaces/:target/:name/claudes': obj([ws('view')], { filter: 'claude' }), // names and sign-in state; each row carries the person's level on that Claude
  'PATCH /api/workspaces/:target/:name/claudes/:claude': obj([check('claude', 'manage', 'path', 'claude')]),
  'DELETE /api/workspaces/:target/:name/claudes/:claude': obj([check('claude', 'manage', 'path', 'claude')]),
  'GET /api/workspaces': signedIn({ filter: 'workspace' }),
  'POST /api/workspaces': obj([check('target', 'operate', 'body', 'target'), check('team', 'view', 'body', 'ownerTeamId', { optional: true })], { creates: 'workspace' }), // a new workspace is owned by the creator (or the team); `local` and host-level targets are admins only
  'PUT /api/workspaces/:target/:name/account': obj([ws('manage'), check('account_pool', 'operate', 'body', 'poolId', { optional: true })]), // an account pool delivers API keys into the workspace: readable by its operators (sharing rules)
  'GET /api/workspaces/:target/:name/preflight': obj([ws('operate')]), // runs checks inside the workspace
  'POST /api/workspaces/:target/:name/adopt': obj([ws('manage')]),
  'POST /api/workspaces/:target/:name/start': obj([ws('operate')]), // ending running sessions of others: the system acts, it is audited
  'POST /api/workspaces/:target/:name/stop': obj([ws('operate')]), // ending running sessions of others: the system acts, it is audited
  'DELETE /api/workspaces/:target/:name': obj([ws('manage')]), // +reauth when it holds secrets (the handler) // removes ownership, shares, pool assignments; ends sessions
  'GET /api/workspaces/:target/:name/pools': obj([ws('view')]),
  'PUT /api/workspaces/:target/:name/pools/:type': obj([ws('manage'), check('pool', 'operate', 'body', 'items.poolId', { many: true, poolTypeParam: 'type' })]), // assigning a set needs operate on the set; a secrets set asks the exposure consent when others operate the workspace
  'GET /api/workspaces/:target/:name/secrets': obj([ws('operate')]), // names of what is delivered (never values)
  'POST /api/workspaces/:target/:name/secrets/check': obj([ws('operate')]),
  'GET /api/workspaces/:target/:name/repos': obj([ws('view')]),
  'POST /api/workspaces/:target/:name/repos/scan': obj([ws('operate')]),
  'GET /api/workspaces/:target/:name/repos/settings': obj([ws('view')]),
  'PUT /api/workspaces/:target/:name/repos/settings': obj([ws('manage')]),
  'GET /api/accounts': signedIn({ filter: 'account' }), // the overview holds only what the person may view; an API key is never returned
  'POST /api/accounts': signedIn({ creates: 'account' }), // owned by the creator (or a team they belong to)
  'POST /api/accounts/bulk': signedIn({ creates: 'account' }), // owned by the creator (or a team they belong to)
  'PATCH /api/accounts/:id': obj([check('account', 'manage', 'path', 'id')]),
  'POST /api/accounts/:id/check': obj([check('account', 'operate', 'path', 'id')]), // a check spends the key: operate
  'POST /api/accounts/:id/clear': obj([check('account', 'operate', 'path', 'id')]), // a check spends the key: operate
  'DELETE /api/accounts/:id': reauth(obj([check('account', 'manage', 'path', 'id')])),
  'POST /api/endpoints': signedIn({ creates: 'endpoint' }),
  'PATCH /api/endpoints/:id': obj([check('endpoint', 'manage', 'path', 'id')]),
  'GET /api/endpoints/:id/models': obj([check('endpoint', 'operate', 'path', 'id')]),
  'DELETE /api/endpoints/:id': obj([check('endpoint', 'manage', 'path', 'id')]),
  'GET /api/account-pools': signedIn({ filter: 'account_pool' }),
  'POST /api/account-pools': obj([check('account', 'operate', 'body', 'members', { many: true })], { creates: 'account_pool' }), // a pool of someone else's keys needs their operate (use)
  'PATCH /api/account-pools/:id': obj([check('account_pool', 'manage', 'path', 'id'), check('account', 'operate', 'body', 'members', { many: true, optional: true })]),
  'DELETE /api/account-pools/:id': obj([check('account_pool', 'manage', 'path', 'id')]),
  'GET /api/pools': signedIn(), // the registered types
  'GET /api/pools/:type': signedIn({ filter: 'pool' }),
  'POST /api/pools/:type': signedIn({ creates: 'pool' }), // owned by the creator (or a team)
  'POST /api/pools/:type/preview': signedIn(), // no object: previews unsaved content
  'GET /api/pools/:type/:id': obj([check('pool', 'view', 'path', 'id', { poolTypeParam: 'type' })]),
  'PUT /api/pools/:type/:id': obj([check('pool', 'manage', 'path', 'id', { poolTypeParam: 'type' })]),
  'DELETE /api/pools/:type/:id': obj([check('pool', 'manage', 'path', 'id', { poolTypeParam: 'type' })]), // +reauth for secrets (the handler) // `?unassign=1` also needs manage on each workspace it leaves
  'POST /api/pools/:type/:id/duplicate': obj([check('pool', 'view', 'path', 'id', { poolTypeParam: 'type' })], { creates: 'pool' }),
  'POST /api/pools/:type/:id/revisions/:rev/approve': obj([check('pool', 'manage', 'path', 'id', { poolTypeParam: 'type' })]), // approving a revision for delivery is the set owner's; the library review of skills/MCP entries stays an admin's
  'POST /api/pools/:type/:id/revisions/:rev/current': obj([check('pool', 'manage', 'path', 'id', { poolTypeParam: 'type' })]), // approving a revision for delivery is the set owner's; the library review of skills/MCP entries stays an admin's
  'POST /api/pools/:type/:id/rollout': obj([check('pool', 'manage', 'path', 'id', { poolTypeParam: 'type' })]),
  'POST /api/pools/:type/:id/assign': obj([check('pool', 'operate', 'path', 'id', { poolTypeParam: 'type' }), check('workspace', 'manage', 'body', 'workspaceIds', { many: true })]), // consent: credential when the set holds secrets
  'POST /api/pools/:type/:id/preview': obj([check('pool', 'view', 'path', 'id', { poolTypeParam: 'type' })]),
  'GET /api/mcp/catalog': signedIn({ filter: 'mcp_entry' }), // approved entries for everyone; drafts and proposals for their owner and admins
  'POST /api/mcp/catalog': signedIn({ creates: 'mcp_entry' }), // a draft owned by the creator
  'GET /api/mcp/catalog/:id': obj([check('mcp_entry', 'view', 'path', 'id')]),
  'PATCH /api/mcp/catalog/:id': obj([check('mcp_entry', 'manage', 'path', 'id')]),
  'DELETE /api/mcp/catalog/:id': obj([check('mcp_entry', 'manage', 'path', 'id')]),
  'POST /api/mcp/catalog/:id/versions': obj([check('mcp_entry', 'manage', 'path', 'id')]),
  'PUT /api/mcp/catalog/:id/versions/:vid': obj([check('mcp_entry', 'manage', 'path', 'id')]), // drafts only
  'DELETE /api/mcp/catalog/:id/versions/:vid': obj([check('mcp_entry', 'manage', 'path', 'id')]), // drafts only
  'POST /api/mcp/catalog/:id/versions/:vid/approve': platform('library', 'manage'), // approval is a platform admin's: it decides what can run in every user's workspaces
  'POST /api/mcp/catalog/:id/versions/:vid/deprecate': platform('library', 'manage'), // approval is a platform admin's: it decides what can run in every user's workspaces
  'POST /api/mcp/catalog/:id/versions/:vid/revoke': platform('library', 'manage'), // approval is a platform admin's: it decides what can run in every user's workspaces
  'GET /api/mcp/builtin': signedIn(),
  'POST /api/mcp/builtin/:id/preview': signedIn(), // preview writes nothing
  'POST /api/mcp/builtin/:id/add': platform('library', 'manage'), // Add and Update are admin-level acts (PRD mcp-builtin-catalogue)
  'POST /api/mcp/sets/:poolId/try': obj([check('pool', 'operate', 'path', 'poolId')]), // the body names a catalog entry and a version, no workspace,
  'GET /api/mcp/workspaces/:target/:name/auth': obj([ws('view')]),
  'POST /api/mcp/workspaces/:target/:name/auth': obj([ws('operate'), check('claude', 'operate', 'query', 'claude')]), // OAuth sign-in of a Claude: its person
  'POST /api/mcp/workspaces/:target/:name/signin': obj([ws('operate'), check('claude', 'operate', 'query', 'claude')]), // OAuth sign-in of a Claude: its person
  'POST /api/mcp/workspaces/:target/:name/signin/:signInId/complete': obj([ws('operate'), check('claude', 'operate', 'query', 'claude')]), // bound to the person who started it
  'DELETE /api/mcp/workspaces/:target/:name/signin/:signInId': obj([ws('operate')]), // bound to the person who started it
  'POST /api/mcp/workspaces/:target/:name/signout': obj([ws('operate'), check('claude', 'operate', 'query', 'claude')]), // OAuth sign-in of a Claude: its person
  'GET /api/mcp/workspaces/:target/:name': obj([ws('view')]),
  'GET /api/mcp/workspaces/:target/:name/matchers': obj([ws('view')]),
  'POST /api/mcp/workspaces/:target/:name/installs/retry': obj([ws('operate')]),
  'POST /api/mcp/workspaces/:target/:name/verify': obj([ws('operate')]),
  'GET /api/skills/library': signedIn({ filter: 'skill_version' }), // reviewed skills for everyone; waiting-review ones for their importer and admins
  'POST /api/skills/import': signedIn({ creates: 'skill_source' }), // URL and zip imports keep the SSRF and archive guards; the result waits for review
  'GET /api/skills/versions/:id': obj([check('skill_version', 'view', 'path', 'id')]),
  'GET /api/skills/versions/:id/file': obj([check('skill_version', 'view', 'path', 'id')]),
  'POST /api/skills/versions/:id/review': platform('library', 'manage'),
  'POST /api/skills/versions/:id/revoke': platform('library', 'manage'),
  'DELETE /api/skills/sources/:id': obj([check('skill_source', 'manage', 'path', 'id')]),
  'GET /api/skills/workspaces/:target/:name': obj([ws('view')]),
  'POST /api/skills/workspaces/:target/:name/verify': obj([ws('operate')]),
  'POST /api/secrets/:poolId/entries/:entryId/rotate': obj([check('pool', 'manage', 'path', 'poolId')]), // audit secret.rotated
  'GET /api/secrets/:poolId/rotations': obj([check('pool', 'view', 'path', 'poolId')]), // metadata only
  'GET /api/secrets/:poolId/entries/:entryId/versions': obj([check('pool', 'view', 'path', 'poolId')]), // metadata only
  'POST /api/secrets/:poolId/values/:valueId/revoke': obj([check('pool', 'manage', 'path', 'poolId')]), // audit secret.revoked
  'GET /api/settings': signedIn(), // effective values: a person should see why something is refused
  'GET /api/settings/audit': platform('settings', 'view'), // admins
  'GET /api/settings/lockdown/:target/:name': obj([ws('view')]),
  'PUT /api/settings/:key': platform('settings', 'manage'), // actor in setting_changes is the user
  'GET /api/personas/workspaces/:target/:name': obj([ws('view')]),
  'GET /api/personas/identities': signedIn({ filter: 'pool' }),
  'GET /api/personas/pools': signedIn({ filter: 'pool' }),
  'GET /api/personas/default': signedIn(),
  'PUT /api/personas/default': platform('settings', 'manage'), // the default persona of new workspaces is a platform choice
  'GET /api/personas/pools/:id/policy': obj([check('pool', 'view', 'path', 'id')]),
  'PUT /api/personas/pools/:id/policy': obj([check('pool', 'manage', 'path', 'id')]),
  'POST /api/personas/pools/:id/avatar': obj([check('pool', 'manage', 'path', 'id')]),
  'DELETE /api/personas/pools/:id/avatar': obj([check('pool', 'manage', 'path', 'id')]),
  'GET /api/personas/avatars/:sha': signedIn(), // content-addressed: the 256-bit hash is the reference
  'GET /api/personas/proposals': signedIn({ filter: 'proposal' }),
  'POST /api/personas/proposals/:id/:verb': obj([check('proposal', 'manage', 'path', 'id')]), // the persona's owner decides, not the proposing agent
  'GET /api/personas/pools/:id/revisions': obj([check('pool', 'view', 'path', 'id')]),
  'GET /api/personas/pools/:id/revisions/:rev': obj([check('pool', 'view', 'path', 'id')]),
  'GET /api/knowledge/graph': signedIn({ filter: 'vault' }), // only visible vaults enter a graph
  'GET /api/knowledge/sources': signedIn({ filter: 'vault' }), // only visible vaults enter a graph
  'GET /api/knowledge/vaults': signedIn({ filter: 'vault' }),
  'POST /api/knowledge/vaults': signedIn({ creates: 'vault' }),
  'POST /api/knowledge/vaults/import': signedIn({ creates: 'vault' }),
  'GET /api/knowledge/vaults/:id': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'PATCH /api/knowledge/vaults/:id': obj([check('vault', 'manage', 'path', 'id')]),
  'DELETE /api/knowledge/vaults/:id': reauth(obj([check('vault', 'manage', 'path', 'id')])),
  'GET /api/knowledge/vaults/:id/export': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'GET /api/knowledge/vaults/:id/tree': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'GET /api/knowledge/vaults/:id/note': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'PUT /api/knowledge/vaults/:id/note': obj([check('vault', 'operate', 'path', 'id')]), // an agent also needs the vault's own agent policy
  'DELETE /api/knowledge/vaults/:id/note': obj([check('vault', 'operate', 'path', 'id')]), // an agent also needs the vault's own agent policy
  'POST /api/knowledge/vaults/:id/note/append': obj([check('vault', 'operate', 'path', 'id')]), // an agent also needs the vault's own agent policy
  'POST /api/knowledge/vaults/:id/note/rename': obj([check('vault', 'operate', 'path', 'id')]), // an agent also needs the vault's own agent policy
  'POST /api/knowledge/vaults/:id/note/restore': obj([check('vault', 'operate', 'path', 'id')]), // an agent also needs the vault's own agent policy
  'GET /api/knowledge/vaults/:id/note/history': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'GET /api/knowledge/vaults/:id/note/version': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'GET /api/knowledge/vaults/:id/note/backlinks': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'GET /api/knowledge/vaults/:id/note/mentions': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'GET /api/knowledge/vaults/:id/embed': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'GET /api/knowledge/vaults/:id/file': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'PUT /api/knowledge/vaults/:id/file': obj([check('vault', 'operate', 'path', 'id')]), // an agent also needs the vault's own agent policy
  'POST /api/knowledge/vaults/:id/folder': obj([check('vault', 'operate', 'path', 'id')]), // an agent also needs the vault's own agent policy
  'GET /api/knowledge/vaults/:id/search': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'GET /api/knowledge/vaults/:id/quick': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'GET /api/knowledge/vaults/:id/tags': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'GET /api/knowledge/vaults/:id/health': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'GET /api/knowledge/vaults/:id/recent': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'GET /api/knowledge/vaults/:id/deleted': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'GET /api/knowledge/vaults/:id/daily': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'POST /api/knowledge/vaults/:id/daily': obj([check('vault', 'operate', 'path', 'id')]), // an agent also needs the vault's own agent policy
  'GET /api/knowledge/vaults/:id/activity': obj([check('vault', 'view', 'path', 'id')]), // export is a bulk read of what the person may view
  'POST /api/knowledge/vaults/:id/rescan': obj([check('vault', 'operate', 'path', 'id')]), // an agent also needs the vault's own agent policy
  'GET /api/portal-mcp': signedIn(), // own tokens and own activity; tool list; admins see the portal switches
  'PUT /api/portal-mcp/settings': reauth(platform('settings', 'manage')), // MCP on/off, session control
  'POST /api/portal-mcp/tokens': reauth(self), // a token is bound to its creator; scope is a cap, never a grant
  'DELETE /api/portal-mcp/tokens/:id': obj([check('personal', 'manage', 'path', 'id')]), // own tokens; platform admins revoke through the emergency route
  'POST /api/portal-mcp/revoke-all': self, // own tokens; everyone's: platform(emergency)
  'GET /api/portal-mcp/agents': signedIn({ filter: 'workspace' }), // the workspaces the person manages
  'PUT /api/portal-mcp/agents/:target/:name': reauth(obj([ws('manage')])), // agent access to portal tools is the workspace manager's switch
  'GET /api/portal-mcp/audit': signedIn(), // own rows; admins all
  'GET /api/tickets': signedIn({ filter: 'ticket' }),
  'POST /api/tickets': signedIn({ creates: 'ticket' }),
  'GET /api/tickets/tags': signedIn(), // tags of visible tickets only
  'GET /api/tickets/:id': obj([check('ticket', 'view', 'path', 'id')]),
  'GET /api/tickets/:id/brief': obj([check('ticket', 'view', 'path', 'id')]),
  'GET /api/tickets/:id/opening': obj([check('ticket', 'view', 'path', 'id')]),
  'PATCH /api/tickets/:id': obj([check('ticket', 'operate', 'path', 'id')]), // moving it to another workspace also needs workspace operate
  'DELETE /api/tickets/:id': obj([check('ticket', 'manage', 'path', 'id')]),
  'POST /api/tickets/:id/comments': obj([check('ticket', 'operate', 'path', 'id')]),
  'POST /api/tickets/:id/close': obj([check('ticket', 'operate', 'path', 'id')]),
  'DELETE /api/tickets/:id/close': obj([check('ticket', 'operate', 'path', 'id')]),
  'POST /api/tickets/:id/session': obj([check('ticket', 'operate', 'path', 'id'), check('workspace', 'operate', 'body', 'workspaceId'), check('claude', 'operate', 'body', 'claudeId', { optional: true })]), // the session belongs to the person starting it
  'GET /api/ci/runs': signedIn({ filter: 'ci_run' }),
  'POST /api/ci/runs': obj([check('ci_repo', 'operate', 'body', 'repoId')]), // the repo resolves to its workspace
  'GET /api/ci/runs/:id': obj([check('ci_run', 'view', 'path', 'id')]), // logs pass the redactor
  'GET /api/ci/runs/:id/log': obj([check('ci_run', 'view', 'path', 'id')]), // logs pass the redactor
  'POST /api/ci/runs/:id/cancel': obj([check('ci_run', 'operate', 'path', 'id')]),
  'POST /api/ci/runs/:id/rerun': obj([check('ci_run', 'operate', 'path', 'id')]),
  'GET /api/ci/repos': signedIn({ filter: 'ci_repo' }),
  'POST /api/ci/repos': obj([check('workspace', 'manage', 'body', 'workspaceId')]),
  'PATCH /api/ci/repos/:id': obj([check('ci_repo', 'manage', 'path', 'id')]),
  'DELETE /api/ci/repos/:id': obj([check('ci_repo', 'manage', 'path', 'id')]),
  'POST /api/ci/repos/:id/connect': obj([check('ci_repo', 'manage', 'path', 'id')]),
  'GET /api/ci/repos/:id/branches': obj([check('ci_repo', 'view', 'path', 'id')]),
  'GET /api/ci/repos/:id/pipelines': obj([check('ci_repo', 'view', 'path', 'id')]),
  'POST /api/ci/repos/:id/merge': obj([check('ci_repo', 'operate', 'path', 'id')]),
  'POST /api/ci/validate': signedIn(), // validates a spec in the body; reads no object
  'GET /api/repos': signedIn({ filter: 'repo' }),
  'GET /api/repos/events': signedIn({ filter: 'repo' }), // events of visible repos only
  'GET /api/repos/:id': obj([check('repo', 'view', 'path', 'id')]),
  'POST /api/repos/:id/scan': obj([check('repo', 'operate', 'path', 'id')]),
  'POST /api/repos/:id/worktrees': obj([check('repo', 'operate', 'path', 'id')]),
  'DELETE /api/repos/:id/worktree': obj([check('repo', 'operate', 'path', 'id')]),
  'PUT /api/repos/:id/sync': obj([check('repo', 'operate', 'path', 'id')]),
  'POST /api/repos/:id/sync': obj([check('repo', 'operate', 'path', 'id')]),
  'GET /api/claude-usage/summary': signedIn({ filter: 'claude' }), // only Claudes the person may use; per-person figures by memberScope
  'GET /api/claude-usage/requests': signedIn({ filter: 'claude' }), // only Claudes the person may use; per-person figures by memberScope
  'GET /api/claude-usage/recommend': signedIn({ filter: 'claude' }), // only Claudes the person may use; per-person figures by memberScope
  'GET /api/claude-usage/palette': signedIn({ filter: 'claude' }), // only Claudes the person may use; per-person figures by memberScope
  'GET /api/claude-usage/export': signedIn({ filter: 'claude' }), // only Claudes the person may use; per-person figures by memberScope
  'GET /api/claude-usage': signedIn({ filter: 'claude' }), // only Claudes the person may use; per-person figures by memberScope
  'GET /api/claude-usage/:claudeId/history': obj([check('claude', 'view', 'path', 'claudeId')]),
  'POST /api/claude-usage/:claudeId/check': obj([check('claude', 'operate', 'path', 'claudeId')]),
  'PUT /api/claude-usage/:claudeId/snooze': self, // a snooze is the person's own preference (today global: the retrofit makes it per user)
  'DELETE /api/claude-usage/:claudeId/snooze': self, // a snooze is the person's own preference (today global: the retrofit makes it per user)
  'GET /api/usage-spend': signedIn(), // visibility per object through Visibility -> canUser
  'GET /api/usage-spend/alerts': signedIn(), // visibility per object through Visibility -> canUser
  'GET /api/usage-spend/audit': signedIn(), // own rows; admins all
  'GET /api/usage-spend/attribution': signedIn(), // visibility per object through Visibility -> canUser
  'GET /api/usage-spend/budgets': signedIn(), // visibility per object through Visibility -> canUser
  'POST /api/usage-spend/budgets': signedIn({ creates: 'budget' }), // scope=workspace needs manage on scope.id, else platform(usage, manage): conditional, so the handler checks (MU6c)
  'PUT /api/usage-spend/budgets/:id': obj([check('budget', 'manage', 'path', 'id')]),
  'DELETE /api/usage-spend/budgets/:id': obj([check('budget', 'manage', 'path', 'id')]),
  'PUT /api/usage-spend/budgets/:id/snooze': self,
  'DELETE /api/usage-spend/budgets/:id/snooze': self,
  'GET /api/usage-spend/spikes': signedIn(), // visibility per object through Visibility -> canUser
  'PUT /api/usage-spend/spikes/snooze': self,
  'DELETE /api/usage-spend/spikes/snooze': self,
  'GET /api/chat/sessions': signedIn({ filter: 'session' }), // private to their creator unless shared
  'POST /api/chat/sessions': obj([check('workspace', 'operate', 'body', 'workspaceId'), check('claude', 'operate', 'body', 'claudeId', { optional: true }), check('ticket', 'operate', 'body', 'ticketId', { optional: true })], { creates: 'session' }), // the session is owned by its creator; created_by_user stamped; a child takes its root's
  'GET /api/chat/sessions/:id': obj([check('session', 'view', 'path', 'id')]),
  'POST /api/chat/sessions/:id/switch': obj([check('session', 'operate', 'path', 'id'), check('claude', 'operate', 'body', 'claudeId')]), // Move chat: the destination Claude must be usable by the person
  'GET /api/chat/sessions/:id/switch-options': obj([check('session', 'operate', 'path', 'id')]), // asks Claude Code
  'GET /api/chat/sessions/:id/bypass': obj([check('session', 'view', 'path', 'id')]),
  'POST /api/chat/sessions/:id/bypass': reauth(obj([check('session', 'manage', 'path', 'id')])), // only the creator's opt-in; never via MCP; audit bypass.*
  'POST /api/chat/sessions/:id/bypass/allow': reauth(obj([check('session', 'manage', 'path', 'id')])), // only the creator's opt-in; never via MCP; audit bypass.*
  'GET /api/chat/sessions/:id/segments': obj([check('session', 'view', 'path', 'id')]), // files: the session's folder only, by the existing deny rules
  'PATCH /api/chat/sessions/:id': obj([check('session', 'manage', 'path', 'id')]), // DELETE with ?worktree=force also needs workspace operate
  'DELETE /api/chat/sessions/:id': obj([check('session', 'manage', 'path', 'id')]), // DELETE with ?worktree=force also needs workspace operate
  'POST /api/chat/sessions/:id/end': obj([check('session', 'operate', 'path', 'id')]),
  'POST /api/chat/sessions/:id/archive': obj([check('session', 'manage', 'path', 'id')]),
  'GET /api/chat/sessions/:id/worktree': obj([check('session', 'manage', 'path', 'id')]),
  'DELETE /api/chat/sessions/:id/archive': obj([check('session', 'manage', 'path', 'id')]),
  'GET /api/chat/sessions/:id/events': obj([check('session', 'view', 'path', 'id')]), // files: the session's folder only, by the existing deny rules
  'GET /api/chat/sessions/:id/models': obj([check('session', 'operate', 'path', 'id')]), // asks Claude Code
  'GET /api/chat/sessions/:id/tasks': obj([check('session', 'view', 'path', 'id')]), // files: the session's folder only, by the existing deny rules
  'GET /api/chat/sessions/:id/blobs/:blobId': obj([check('session', 'view', 'path', 'id')]), // files: the session's folder only, by the existing deny rules
  'GET /api/chat/sessions/:id/files': obj([check('session', 'view', 'path', 'id')]), // files: the session's folder only, by the existing deny rules
  'GET /api/chat/sessions/:id/files/download': obj([check('session', 'view', 'path', 'id')]), // files: the session's folder only, by the existing deny rules
  'GET /api/chat/sessions/:id/diff': obj([check('session', 'view', 'path', 'id')]), // files: the session's folder only, by the existing deny rules
  'POST /api/chat/sessions/:id/uploads': obj([check('session', 'operate', 'path', 'id')]), // staged for this session only
  'DELETE /api/chat/sessions/:id/uploads/:uploadId': obj([check('session', 'operate', 'path', 'id')]), // staged for this session only
  'GET /api/chat/sessions/:id/blobs/:blobId/preview': obj([check('session', 'view', 'path', 'id')]), // files: the session's folder only, by the existing deny rules
  'GET /api/chat/sessions/:id/artifacts.zip': obj([check('session', 'view', 'path', 'id')]), // files: the session's folder only, by the existing deny rules
  'GET /api/chat/usage': signedIn(), // usage of the sessions the person may view
  'GET /api/chat/claudes': obj([check('workspace', 'view', 'query', 'workspaceId')], { filter: 'claude' }),
  'POST /api/chat/claudes': obj([check('workspace', 'operate', 'body', 'workspaceId')], { creates: 'claude' }), // a new Claude is owned by the person who adds it
  'GET /api/chat/trust/scan': obj([check('workspace', 'operate', 'query', 'workspaceId')]),
  'POST /api/chat/trust': obj([check('workspace', 'manage', 'body', 'workspaceId')]), // trusting a folder lets Claude Code run there for everyone who uses it
  'POST /api/chat/reauth': self, // replaced by POST /api/auth/reauth (kept as an alias)
  'GET /api/chat/worktrees': obj([check('workspace', 'view', 'query', 'workspaceId')]),
  'GET /api/chat/policy': signedIn(),
  'GET /api/chat/audit': signedIn({ filter: 'session' }), // rows about sessions the person may view; admins: platform rows too
  'GET /api/workspaces/:target/:name/browser': obj([ws('view')]), // status only
  'PUT /api/workspaces/:target/:name/browser/control': obj([ws('operate')]), // the lease binds (user, device), never a device id alone
  'POST /api/workspaces/:target/:name/browser/handoffs/:handoff': obj([ws('operate')]),
  'POST /api/workspaces/:target/:name/browser/install/retry': obj([ws('manage')]),
  'GET /api/workspaces/:target/:name/browser/configuration': obj([ws('view')]), // status only
  'POST /api/workspaces/:target/:name/browser/:action': obj([ws('operate')]),
  // Appendix C: the doors outside the route table (an upgrade request is not in `app.routes`; `/mcp` is). The chat socket is chat's own row.
  'ALL /api/live': signedIn({ filter: 'workspace' }), // the `workspaces` and `usage` frames are built per client by `visible`; the rest are nudges (R2)
  'ALL /api/workspaces/:target/:name/shell': obj([ws('operate')]), // `?term=` also needs the terminal's owner (terminal_owners), a `claude` terminal operate on its Claude: the shell checks
  'ALL /api/workspaces/:target/:name/browser/view': obj([ws('operate')]), // the lease binds (user, device)
  'ALL /api/workspaces/:target/:name/browser/preview': obj([ws('operate')]),
  'ALL /mcp': { kind: 'bearer', why: 'cpat_ and cpst_ tokens; each tool declares its access (policy.tools.v0.ts, Appendix B).' },
};

/** Socket paths the enumeration accepts as live `ALL` keys although no route lists them. */
export const SOCKET_PATHS_V0 = ['/api/live', '/api/chat/live', '/api/workspaces/:target/:name/shell', '/api/workspaces/:target/:name/browser/view', '/api/workspaces/:target/:name/browser/preview'] as const;

let declared = false;
/** Declares the fallback rows once (idempotent: modules and tests load this more than once). */
export function declareRoutePoliciesV0(): void {
  if (declared) return;
  declared = true;
  declareFallbackPolicies('authz.v0', ROUTE_POLICIES_V0);
}
