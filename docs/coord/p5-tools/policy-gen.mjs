// Generates the route policy table (v0) from the REAL route dump and verifies every route is covered exactly once.
// usage: node policy-gen.mjs > policy-table.md   (reads routes.txt next to it; browser routes are added by hand below)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const routes = readFileSync(join(here, 'routes.txt'), 'utf8').split('\n').filter((l) => /^(GET|POST|PUT|PATCH|DELETE) /.test(l));
// the six browser routes (browser/routes.ts; the dump passed a stub for the module)
routes.push(
  'GET /api/workspaces/:target/:name/browser',
  'PUT /api/workspaces/:target/:name/browser/control',
  'POST /api/workspaces/:target/:name/browser/handoffs/:handoff',
  'POST /api/workspaces/:target/:name/browser/install/retry',
  'GET /api/workspaces/:target/:name/browser/configuration',
  'POST /api/workspaces/:target/:name/browser/:action',
);

// access notation: public | self | in | in:list(T) | in:create(T) | platform(area,verb) | obj(T verb from param; ...) [+reauth]
const W = (verb) => `workspace ${verb} path target+name`;
const R = [];
const rule = (re, access, note = '') => R.push({ re: new RegExp(re), access, note });

// ---- public and bearer
rule('^GET /healthz$', 'public', 'liveness');
rule('^GET /api/session$', 'public', 'AuthStatus: who is signed in, setup, registration mode, devSeed');
rule('^POST /api/login$', 'public', 'dev seed only: 404 unless PORTAL_DEV_SEED (never in production)');
rule('^POST /api/logout$', 'public', 'clears the cookie; works with or without a session');
// ---- /api/admin (today: the shared server code and the database)
rule('^GET /api/admin/state$', 'REMOVED', 'returns the server code in clear to every signed-in tab: replaced by Me and the devices list');
rule('^POST /api/admin/code$', 'REMOVED', 'rotating the shared code: gone with it');
rule('^PUT /api/admin/enabled$', 'platform(registration,manage)', 'sign-in switch moves to IdentitySettings.signInEnabled; reauth');
rule('^GET /api/admin/system$', 'in', 'any user sees the trust state; secret key and backups only for admins (handler redacts)');
rule('^POST /api/admin/system/(key/setup|key/unlock|key/reset|resume)$', 'platform(system,manage) +reauth', 'the secret key and delivery pause are the platform\'s');
// ---- workspaces
rule('^GET /api/workspaces/targets$', 'in:list(target)', 'only targets the person may use; admins also see problems');
rule('^GET /api/workspaces/usage$', 'in:list(workspace)', 'cpu and memory of the workspaces the person may view');
rule('^GET /api/workspaces$', 'in:list(workspace)', '');
rule('^POST /api/workspaces$', 'obj(target operate body target; team member of body ownerTeamId when set) in:create(workspace)', 'a new workspace is owned by the creator (or the team); `local` and host-level targets are admins only');
rule('^GET /api/workspaces/:target/:name/claude-login$', `obj(${W('view')})`, 'status of a Claude\'s sign-in');
rule('^(POST|DELETE) /api/workspaces/:target/:name/claude-login(/code)?$', `obj(${W('operate')}; claude manage query claude (default Claude when absent))`, 'signing in is for the Claude\'s own person; a Claude a person signed in is theirs');
rule('^POST /api/workspaces/:target/:name/claude-logout$', `obj(${W('operate')}; claude manage query claude)`, '');
rule('^GET /api/workspaces/:target/:name/terminals$', `obj(${W('operate')}) filter terminal (own only)`, 'terminals are private to their creator in the UI (not a boundary: operate is a shell)');
rule('^POST /api/workspaces/:target/:name/terminals$', `obj(${W('operate')})`, 'audit terminal.opened');
rule('^DELETE /api/workspaces/:target/:name/terminals/:term$', `obj(terminal manage path target+name+term)`, 'the creator, or a manager of the workspace');
rule('^GET /api/workspaces/:target/:name/claudes$', `obj(${W('view')}) filter claude`, 'names and sign-in state; each row carries the person\'s level on that Claude');
rule('^(PATCH|DELETE) /api/workspaces/:target/:name/claudes/:claude$', `obj(claude manage path claude)`, '');
rule('^PUT /api/workspaces/:target/:name/account$', `obj(${W('manage')}; account_pool operate body poolId optional) consent: credential`, 'an account pool delivers API keys into the workspace: readable by its operators (sharing rules)');
rule('^GET /api/workspaces/:target/:name/preflight$', `obj(${W('operate')})`, 'runs checks inside the workspace');
rule('^POST /api/workspaces/:target/:name/adopt$', `obj(${W('manage')})`, '');
rule('^POST /api/workspaces/:target/:name/(start|stop)$', `obj(${W('operate')})`, 'ending running sessions of others: the system acts, it is audited');
rule('^DELETE /api/workspaces/:target/:name$', `obj(${W('manage')}) +reauth when it holds secrets`, 'removes ownership, shares, pool assignments; ends sessions');
rule('^GET /api/workspaces/:target/:name/pools$', `obj(${W('view')})`, '');
rule('^PUT /api/workspaces/:target/:name/pools/:type$', `obj(${W('manage')}; pool operate body (each id), poolType from path) consent: credential`, 'assigning a set needs operate on the set; a secrets set asks the exposure consent when others operate the workspace');
rule('^GET /api/workspaces/:target/:name/secrets$', `obj(${W('operate')})`, 'names of what is delivered (never values)');
rule('^POST /api/workspaces/:target/:name/secrets/check$', `obj(${W('operate')})`, '');
rule('^GET /api/workspaces/:target/:name/repos(/settings)?$', `obj(${W('view')})`, '');
rule('^POST /api/workspaces/:target/:name/repos/scan$', `obj(${W('operate')})`, '');
rule('^PUT /api/workspaces/:target/:name/repos/settings$', `obj(${W('manage')})`, '');
rule('^GET /api/workspaces/:target/:name/browser(/configuration)?$', `obj(${W('view')})`, 'status only');
rule('^PUT /api/workspaces/:target/:name/browser/control$', `obj(${W('operate')})`, 'the lease binds (user, device), never a device id alone');
rule('^POST /api/workspaces/:target/:name/browser/(handoffs/:handoff|:action)$', `obj(${W('operate')})`, '');
rule('^POST /api/workspaces/:target/:name/browser/install/retry$', `obj(${W('manage')})`, '');
// ---- accounts, endpoints, account pools
rule('^GET /api/accounts$', 'in:list(account) + account pools', 'the overview holds only what the person may view; an API key is never returned');
rule('^POST /api/accounts(/bulk)?$', 'in:create(account)', 'owned by the creator (or a team they belong to)');
rule('^PATCH /api/accounts/:id$', 'obj(account manage path id)', '');
rule('^POST /api/accounts/:id/(check|clear)$', 'obj(account operate path id)', 'a check spends the key: operate');
rule('^DELETE /api/accounts/:id$', 'obj(account manage path id) +reauth', '');
rule('^POST /api/endpoints$', 'in:create(endpoint)', '');
rule('^GET /api/endpoints/:id/models$', 'obj(endpoint operate path id)', '');
rule('^(PATCH|DELETE) /api/endpoints/:id$', 'obj(endpoint manage path id)', '');
rule('^GET /api/account-pools$', 'in:list(account_pool)', '');
rule('^POST /api/account-pools$', 'in:create(account_pool); account operate body (each account)', 'a pool of someone else\'s keys needs their operate (use)');
rule('^(PATCH|DELETE) /api/account-pools/:id$', 'obj(account_pool manage path id; account operate body (each added))', '');
// ---- multi-assignment pools
rule('^GET /api/pools$', 'in', 'the registered types');
rule('^GET /api/pools/:type$', 'in:list(pool, poolType from path)', '');
rule('^POST /api/pools/:type$', 'in:create(pool, poolType from path)', 'owned by the creator (or a team)');
rule('^POST /api/pools/:type/preview$', 'in', 'no object: previews unsaved content');
rule('^GET /api/pools/:type/:id$', 'obj(pool view path id, poolType from path)', '');
rule('^PUT /api/pools/:type/:id$', 'obj(pool manage path id)', '');
rule('^DELETE /api/pools/:type/:id$', 'obj(pool manage path id) +reauth for secrets', '`?unassign=1` also needs manage on each workspace it leaves');
rule('^POST /api/pools/:type/:id/duplicate$', 'obj(pool view path id) in:create(pool)', '');
rule('^POST /api/pools/:type/:id/revisions/:rev/(approve|current)$', 'obj(pool manage path id)', 'approving a revision for delivery is the set owner\'s; the library review of skills/MCP entries stays an admin\'s');
rule('^POST /api/pools/:type/:id/rollout$', 'obj(pool manage path id)', '');
rule('^POST /api/pools/:type/:id/assign$', 'obj(pool operate path id; workspace manage body workspaceIds (each))', 'consent: credential when the set holds secrets');
rule('^POST /api/pools/:type/:id/preview$', 'obj(pool view path id)', '');
// ---- MCP
rule('^GET /api/mcp/catalog$', 'in:list(mcp_entry)', 'approved entries for everyone; drafts and proposals for their owner and admins');
rule('^POST /api/mcp/catalog$', 'in:create(mcp_entry)', 'a draft owned by the creator');
rule('^GET /api/mcp/catalog/:id$', 'obj(mcp_entry view path id)', '');
rule('^(PATCH|DELETE) /api/mcp/catalog/:id$', 'obj(mcp_entry manage path id)', '');
rule('^POST /api/mcp/catalog/:id/versions$', 'obj(mcp_entry manage path id)', '');
rule('^(PUT|DELETE) /api/mcp/catalog/:id/versions/:vid$', 'obj(mcp_entry manage path id)', 'drafts only');
rule('^POST /api/mcp/catalog/:id/versions/:vid/(approve|deprecate|revoke)$', 'platform(library,manage)', 'approval is a platform admin\'s: it decides what can run in every user\'s workspaces');
rule('^GET /api/mcp/builtin$', 'in', '');
rule('^POST /api/mcp/builtin/:id/(preview)$', 'in', 'preview writes nothing');
rule('^POST /api/mcp/builtin/:id/add$', 'platform(library,manage)', 'Add and Update are admin-level acts (PRD mcp-builtin-catalogue)');
rule('^POST /api/mcp/sets/:poolId/try$', 'obj(pool operate path poolId, poolType mcpset; workspace operate body)', '');
rule('^GET /api/mcp/workspaces/:target/:name(/auth|/matchers)?$', `obj(${W('view')})`, '');
rule('^POST /api/mcp/workspaces/:target/:name/(auth|signin|signout)$', `obj(${W('operate')}; claude operate query claude)`, 'OAuth sign-in of a Claude: its person');
rule('^POST /api/mcp/workspaces/:target/:name/signin/:signInId/complete$', `obj(${W('operate')}; claude operate query claude)`, 'bound to the person who started it');
rule('^DELETE /api/mcp/workspaces/:target/:name/signin/:signInId$', `obj(${W('operate')})`, 'bound to the person who started it');
rule('^POST /api/mcp/workspaces/:target/:name/(installs/retry|verify)$', `obj(${W('operate')})`, '');
// ---- skills
rule('^GET /api/skills/library$', 'in:list(skill_version)', 'reviewed skills for everyone; waiting-review ones for their importer and admins');
rule('^POST /api/skills/import$', 'in:create(skill_source)', 'URL and zip imports keep the SSRF and archive guards; the result waits for review');
rule('^GET /api/skills/versions/:id(/file)?$', 'obj(skill_version view path id)', '');
rule('^POST /api/skills/versions/:id/(review|revoke)$', 'platform(library,manage)', '');
rule('^DELETE /api/skills/sources/:id$', 'obj(skill_source manage path id)', '');
rule('^GET /api/skills/workspaces/:target/:name$', `obj(${W('view')})`, '');
rule('^POST /api/skills/workspaces/:target/:name/verify$', `obj(${W('operate')})`, '');
// ---- secrets
rule('^POST /api/secrets/:poolId/entries/:entryId/rotate$', 'obj(pool manage path poolId, poolType secrets)', 'audit secret.rotated');
rule('^GET /api/secrets/:poolId/(rotations|entries/:entryId/versions)$', 'obj(pool view path poolId, poolType secrets)', 'metadata only');
rule('^POST /api/secrets/:poolId/values/:valueId/revoke$', 'obj(pool manage path poolId, poolType secrets)', 'audit secret.revoked');
// ---- settings
rule('^GET /api/settings$', 'in', 'effective values: a person should see why something is refused');
rule('^GET /api/settings/audit$', 'platform(settings,view)', 'admins');
rule('^PUT /api/settings/:key$', 'platform(settings,manage)', 'actor in setting_changes is the user');
rule('^GET /api/settings/lockdown/:target/:name$', `obj(${W('view')})`, '');
// ---- personas
rule('^GET /api/personas/workspaces/:target/:name$', `obj(${W('view')})`, '');
rule('^GET /api/personas/(identities|pools)$', 'in:list(pool, poolType persona|context)', '');
rule('^GET /api/personas/default$', 'in', '');
rule('^PUT /api/personas/default$', 'platform(settings,manage)', 'the default persona of new workspaces is a platform choice');
rule('^(GET|PUT) /api/personas/pools/:id/policy$', 'obj(pool view|manage path id, poolType persona)', 'GET view, PUT manage');
rule('^(POST|DELETE) /api/personas/pools/:id/avatar$', 'obj(pool manage path id, poolType persona)', '');
rule('^GET /api/personas/avatars/:sha$', 'in', 'content-addressed: the 256-bit hash is the reference');
rule('^GET /api/personas/proposals$', 'in:list(proposal)', '');
rule('^POST /api/personas/proposals/:id/:verb$', 'obj(proposal manage path id)', 'the persona\'s owner decides, not the proposing agent');
rule('^GET /api/personas/pools/:id/revisions(/:rev)?$', 'obj(pool view path id, poolType persona)', '');
// ---- knowledge
rule('^GET /api/knowledge/(graph|sources)$', 'in:list(vault)', 'only visible vaults enter a graph');
rule('^GET /api/knowledge/vaults$', 'in:list(vault)', '');
rule('^POST /api/knowledge/vaults(/import)?$', 'in:create(vault)', '');
rule('^GET /api/knowledge/vaults/:id(/(export|tree|note|note/history|note/version|note/backlinks|note/mentions|embed|file|search|quick|tags|health|recent|deleted|daily|activity))?$', 'obj(vault view path id)', 'export is a bulk read of what the person may view');
rule('^PATCH /api/knowledge/vaults/:id$', 'obj(vault manage path id)', '');
rule('^DELETE /api/knowledge/vaults/:id$', 'obj(vault manage path id) +reauth', '');
rule('^(PUT|DELETE|POST) /api/knowledge/vaults/:id/(note|note/append|note/rename|note/restore|file|folder|daily|rescan)$', 'obj(vault operate path id)', 'an agent also needs the vault\'s own agent policy');
// ---- portal MCP admin
rule('^GET /api/portal-mcp$', 'in', 'own tokens and own activity; tool list; admins see the portal switches');
rule('^PUT /api/portal-mcp/settings$', 'platform(settings,manage) +reauth', 'MCP on/off, session control');
rule('^POST /api/portal-mcp/tokens$', 'self +reauth', 'a token is bound to its creator; scope is a cap, never a grant');
rule('^DELETE /api/portal-mcp/tokens/:id$', 'obj(personal manage path id)', 'own tokens; platform admins revoke through the emergency route');
rule('^POST /api/portal-mcp/revoke-all$', 'self', 'own tokens; everyone\'s: platform(emergency)');
rule('^GET /api/portal-mcp/agents$', 'in:list(workspace) managed', 'the workspaces the person manages');
rule('^PUT /api/portal-mcp/agents/:target/:name$', `obj(${W('manage')}) +reauth`, 'agent access to portal tools is the workspace manager\'s switch');
rule('^GET /api/portal-mcp/audit$', 'in', 'own rows; admins all');
// ---- tickets
rule('^GET /api/tickets$', 'in:list(ticket)', '');
rule('^POST /api/tickets$', 'in:create(ticket); workspace view body workspaceId optional (a linked ticket needs the link target to be visible)', '');
rule('^GET /api/tickets/tags$', 'in', 'tags of visible tickets only');
rule('^GET /api/tickets/:id(/brief|/opening)?$', 'obj(ticket view path id)', '');
rule('^PATCH /api/tickets/:id$', 'obj(ticket operate path id)', 'moving it to another workspace also needs workspace operate');
rule('^DELETE /api/tickets/:id$', 'obj(ticket manage path id)', '');
rule('^POST /api/tickets/:id/comments$', 'obj(ticket operate path id)', '');
rule('^(POST|DELETE) /api/tickets/:id/close$', 'obj(ticket operate path id)', '');
rule('^POST /api/tickets/:id/session$', 'obj(ticket operate path id; workspace operate body/ticket; claude operate body)', 'the session belongs to the person starting it');
// ---- CI
rule('^GET /api/ci/runs$', 'in:list(ci_run)', '');
rule('^POST /api/ci/runs$', 'obj(ci_repo operate body repoId)', 'the repo resolves to its workspace');
rule('^GET /api/ci/runs/:id(/log)?$', 'obj(ci_run view path id)', 'logs pass the redactor');
rule('^POST /api/ci/runs/:id/(cancel|rerun)$', 'obj(ci_run operate path id)', '');
rule('^GET /api/ci/repos$', 'in:list(ci_repo)', '');
rule('^POST /api/ci/repos$', 'obj(workspace manage body workspaceId)', '');
rule('^(PATCH|DELETE) /api/ci/repos/:id$', 'obj(ci_repo manage path id)', '');
rule('^POST /api/ci/repos/:id/connect$', 'obj(ci_repo manage path id)', '');
rule('^GET /api/ci/repos/:id/(branches|pipelines)$', 'obj(ci_repo view path id)', '');
rule('^POST /api/ci/repos/:id/merge$', 'obj(ci_repo operate path id)', '');
rule('^POST /api/ci/validate$', 'in', 'validates a spec in the body; reads no object');
// ---- repos
rule('^GET /api/repos$', 'in:list(repo)', '');
rule('^GET /api/repos/events$', 'in:list(repo)', 'events of visible repos only');
rule('^GET /api/repos/:id$', 'obj(repo view path id)', '');
rule('^(POST|PUT) /api/repos/:id/(scan|worktrees|sync)$', 'obj(repo operate path id)', '');
rule('^DELETE /api/repos/:id/worktree$', 'obj(repo operate path id)', '');
// ---- glance, usage
rule('^GET /api/glance$', 'in', 'the person\'s own snapshot: sources take the actor');
rule('^GET /api/claude-usage(/summary|/requests|/recommend|/palette|/export)?$', 'in:list(claude) + memberScope', 'only Claudes the person may use; per-person figures by memberScope');
rule('^GET /api/claude-usage/:claudeId/history$', 'obj(claude view path claudeId)', '');
rule('^POST /api/claude-usage/:claudeId/check$', 'obj(claude operate path claudeId)', '');
rule('^(PUT|DELETE) /api/claude-usage/:claudeId/snooze$', 'self', 'a snooze is the person\'s own preference (today global: the retrofit makes it per user)');
rule('^GET /api/usage-spend(/alerts|/attribution|/budgets|/spikes)?$', 'in + memberScope', 'visibility per object through Visibility -> canUser');
rule('^GET /api/usage-spend/audit$', 'in', 'own rows; admins all');
rule('^POST /api/usage-spend/budgets$', 'in:create(budget); workspace manage body when scope=workspace | platform(usage,manage) otherwise', '');
rule('^(PUT|DELETE) /api/usage-spend/budgets/:id$', 'obj(budget manage path id)', '');
rule('^(PUT|DELETE) /api/usage-spend/(budgets/:id/snooze|spikes/snooze)$', 'self', '');
// ---- chat
rule('^GET /api/chat/sessions$', 'in:list(session)', 'private to their creator unless shared');
rule('^POST /api/chat/sessions$', 'obj(workspace operate body workspaceId; claude operate body claudeId (default Claude when absent); ticket operate body ticketId optional) in:create(session)', 'the session is owned by its creator; created_by_user stamped; a child takes its root\'s');
rule('^GET /api/chat/sessions/:id$', 'obj(session view path id)', '');
rule('^POST /api/chat/sessions/:id/switch$', 'obj(session operate path id; claude operate body claudeId)', 'Move chat: the destination Claude must be usable by the person');
rule('^GET /api/chat/sessions/:id/(switch-options|models)$', 'obj(session operate path id)', 'asks Claude Code');
rule('^GET /api/chat/sessions/:id/bypass$', 'obj(session view path id)', '');
rule('^POST /api/chat/sessions/:id/bypass(/allow)?$', 'obj(session manage path id) +reauth', 'only the creator\'s opt-in; never via MCP; audit bypass.*');
rule('^GET /api/chat/sessions/:id/(segments|tasks|events|files|files/download|diff|artifacts.zip|blobs/:blobId|blobs/:blobId/preview)$', 'obj(session view path id)', 'files: the session\'s folder only, by the existing deny rules');
rule('^(PATCH|DELETE) /api/chat/sessions/:id$', 'obj(session manage path id)', 'DELETE with ?worktree=force also needs workspace operate');
rule('^POST /api/chat/sessions/:id/end$', 'obj(session operate path id)', '');
rule('^(POST|DELETE) /api/chat/sessions/:id/archive$', 'obj(session manage path id)', '');
rule('^GET /api/chat/sessions/:id/worktree$', 'obj(session manage path id)', '');
rule('^(POST|DELETE) /api/chat/sessions/:id/uploads(/:uploadId)?$', 'obj(session operate path id)', 'staged for this session only');
rule('^GET /api/chat/usage$', 'in + memberScope', 'usage of the sessions the person may view');
rule('^GET /api/chat/claudes$', 'obj(workspace view query workspaceId) filter claude', '');
rule('^POST /api/chat/claudes$', 'obj(workspace operate body workspaceId) in:create(claude)', 'a new Claude is owned by the person who adds it');
rule('^GET /api/chat/trust/scan$', 'obj(workspace operate query workspaceId)', '');
rule('^POST /api/chat/trust$', 'obj(workspace manage body workspaceId)', 'trusting a folder lets Claude Code run there for everyone who uses it');
rule('^POST /api/chat/reauth$', 'self', 'replaced by POST /api/auth/reauth (kept as an alias)');
rule('^GET /api/chat/worktrees$', 'obj(workspace view query workspaceId)', '');
rule('^GET /api/chat/policy$', 'in', '');
rule('^GET /api/chat/audit$', 'in:list(session audit rows)', 'rows about sessions the person may view; admins: platform rows too');

const rows = [];
const unmatched = [];
const seen = new Map();
for (const line of routes) {
  const key = line.trim();
  const hits = R.filter((r) => r.re.test(key));
  if (hits.length === 0) unmatched.push(key);
  else {
    seen.set(key, hits.length);
    rows.push({ key, ...hits[0] });
  }
}
const dup = [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k} (${n})`);
const unused = R.filter((r) => !routes.some((l) => r.re.test(l.trim())));
if (unmatched.length) console.error('UNMATCHED:', unmatched.join('\n  '));
if (dup.length) console.error('MORE THAN ONE RULE:', dup.join('\n  '));
if (unused.length) console.error('RULES THAT MATCH NO ROUTE:', unused.map((r) => r.re.source).join('\n  '));
console.error(`routes ${routes.length}, covered ${rows.length}, unmatched ${unmatched.length}, multiple ${dup.length}, unused rules ${unused.length}`);
const esc = (s) => s.replace(/\|/g, '\\|');
console.log('| Route | Access | Note |\n| --- | --- | --- |');
for (const r of rows) console.log(`| \`${esc(r.key)}\` | ${esc(r.access)} | ${esc(r.note)} |`);
