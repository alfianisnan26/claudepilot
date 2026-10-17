// T-1043 S0a (D-82): the declarations of the routes app.ts owns itself (sign-in, the admin page, Claude accounts, endpoints, account pools),
// the catch-alls, and every module route whose module has no `authz.ts` of its own yet. The route guard (routeGuard.ts) refuses a non-owner
// any route that is not declared, and `routePolicies.test.ts` fails on one, so every route the app answers is named somewhere.
//
// The interim rule for a module that is not actor-aware yet (its handlers do not take the actor and filter): `platform` (an admin's area),
// `view` for a read and `manage` for a change. A member is refused there (403 "Only an admin can do this.") until the module's own slice
// declares the PRD's target row (docs/prd/authorization.md Appendix A) and its handlers take the actor. The founding owner, the server code and
// an admin account are not changed by any of this (D-82: admins keep full access).

import type { PlatformArea, RoutePolicies, RoutePolicy, Verb } from '@portal/contracts';
import { declareAttentionPolicies } from '../attention/authz.js';
import { declareAutoTransferPolicies } from '../autotransfer/authz.js';
import { declareBrowserPolicies } from '../browser/authz.js';
import { declareCiPolicies } from '../ci/authz.js';
import { declareClaudeVersionPolicies } from '../claudeversion/authz.js';
import { declareCodespacesPolicies } from '../codespaces/authz.js';
import { declareConnectPolicies } from '../connect/authz.js';
import { declareInstallPolicies } from '../connect/install/routes.js';
import { declareGlancePolicies } from '../glance/authz.js';
import { declareKeepGoingPolicies } from '../keepgoing/authz.js';
import { declareLabPolicies } from '../lab/authz.js';
import { declareNotifyPolicies } from '../notify/authz.js';
import { declareWorkspacePoolPolicies } from '../pools/authz.js';
import { declarePortalMcpPolicies } from '../portalmcp/authz.js';
import { declareWorkspaceReposPolicies } from '../repos/authz.js';
import { declareWorkspaceSecretsPolicies } from '../secrets/authz.js';
import { declareSettingsPolicies } from '../settings/authz.js';
import { declareTicketPolicies } from '../tickets/authz.js';
import { declareTriggerPolicies } from '../triggers/authz.js';
import { declareWorkspacePolicies } from '../workspaces/authz.js';
import { declarePolicies } from './seam.js';

const admin = (area: PlatformArea, verb: Verb): RoutePolicy => ({ kind: 'platform', area, verb });
const read = (area: PlatformArea) => admin(area, 'view');
const change = (area: PlatformArea) => admin(area, 'manage');

/** One area for a set of paths: GET reads (`view`), every other method changes (`manage`). */
function area(a: PlatformArea, keys: string[]): RoutePolicies {
  const out: RoutePolicies = {};
  for (const key of keys) out[key as keyof RoutePolicies] = key.startsWith('GET ') ? read(a) : change(a);
  return out;
}

export const APP_POLICIES: RoutePolicies = {
  // The doors before sign-in: the probe, the session check, signing in and out.
  'GET /healthz': { kind: 'public', why: 'the liveness probe' },
  'GET /api/session': { kind: 'public', why: 'tells the sign-in page whether a session is live' },
  'POST /api/login': { kind: 'public', why: 'signing in (rate limited)' },
  'POST /api/logout': { kind: 'public', why: 'signing out ends only the caller’s own cookie' },
  'GET /api/me': { kind: 'self' },
  // The catch-all of the API answers 404 for a path nobody serves; the web app's shell is the same page for every path.
  'ALL /api/*': { kind: 'public', why: 'answers 404 for an unknown API path' },
  'GET *': { kind: 'public', why: 'the web app shell and its static files' },
  // The admin page (Access): accounts and roles, the server code, sign-ups, the secret key and the database.
  ...area('users', ['GET /api/admin/users', 'POST /api/admin/users', 'PATCH /api/admin/users/:id', 'DELETE /api/admin/users/:id']),
  ...area('system', ['GET /api/admin/state', 'POST /api/admin/code', 'GET /api/admin/system', 'POST /api/admin/system/key/reset', 'POST /api/admin/system/key/setup', 'POST /api/admin/system/key/unlock', 'POST /api/admin/system/resume']),
  'PUT /api/admin/enabled': change('registration'),
  // Claude accounts, API endpoints and account pools: the portal's credentials, an admin's (Settings → Claude).
  ...area('settings', [
    'GET /api/accounts',
    'POST /api/accounts',
    'POST /api/accounts/bulk',
    'PATCH /api/accounts/:id',
    'POST /api/accounts/:id/check',
    'POST /api/accounts/:id/clear',
    'DELETE /api/accounts/:id',
    'POST /api/endpoints',
    'PATCH /api/endpoints/:id',
    'GET /api/endpoints/:id/models',
    'DELETE /api/endpoints/:id',
    'GET /api/account-pools',
    'POST /api/account-pools',
    'PATCH /api/account-pools/:id',
    'DELETE /api/account-pools/:id',
  ]),
  // MCP sets (mcp/routes.ts): the catalogue, its versions and approvals, and each workspace's MCP status. Interim: an admin's.
  ...area(
    'library',
    [
      'GET /api/mcp/catalog',
      'POST /api/mcp/catalog',
      'GET /api/mcp/catalog/:id',
      'PATCH /api/mcp/catalog/:id',
      'DELETE /api/mcp/catalog/:id',
      'POST /api/mcp/catalog/:id/versions',
      'PUT /api/mcp/catalog/:id/versions/:vid',
      'DELETE /api/mcp/catalog/:id/versions/:vid',
      'POST /api/mcp/catalog/:id/versions/:vid/approve',
      'POST /api/mcp/catalog/:id/versions/:vid/deprecate',
      'POST /api/mcp/catalog/:id/versions/:vid/revoke',
      'POST /api/mcp/sets/:poolId/try',
      'GET /api/mcp/workspaces/:target/:name',
      'GET /api/mcp/workspaces/:target/:name/matchers',
      'POST /api/mcp/workspaces/:target/:name/installs/retry',
      'POST /api/mcp/workspaces/:target/:name/verify',
    ].concat(
      // Skillsets (skills/routes.ts): the library, imports, reviews and each workspace's skills.
      [
        'GET /api/skills/library',
        'POST /api/skills/import',
        'GET /api/skills/versions/:id',
        'GET /api/skills/versions/:id/file',
        'POST /api/skills/versions/:id/review',
        'POST /api/skills/versions/:id/revoke',
        'DELETE /api/skills/sources/:id',
        'GET /api/skills/workspaces/:target/:name',
        'POST /api/skills/workspaces/:target/:name/verify',
      ],
      // Personas (personas/index.ts): identities, the default, policies, avatars, proposals and revisions.
      [
        'GET /api/personas/workspaces/:target/:name',
        'GET /api/personas/identities',
        'GET /api/personas/pools',
        'GET /api/personas/default',
        'PUT /api/personas/default',
        'GET /api/personas/pools/:id/policy',
        'PUT /api/personas/pools/:id/policy',
        'POST /api/personas/pools/:id/avatar',
        'DELETE /api/personas/pools/:id/avatar',
        'GET /api/personas/avatars/:sha',
        'GET /api/personas/proposals',
        'POST /api/personas/proposals/:id/:verb',
        'GET /api/personas/pools/:id/revisions',
        'GET /api/personas/pools/:id/revisions/:rev',
      ],
    ),
  ),
  // Knowledge (knowledge/routes.ts): the handlers act as the owner (`UI_ACTOR`), so the vaults stay an admin's until they take the actor.
  ...area(
    'settings',
    [
      'GET /api/knowledge/graph',
      'GET /api/knowledge/sources',
      'GET /api/knowledge/vaults',
      'POST /api/knowledge/vaults',
      'POST /api/knowledge/vaults/import',
      'GET /api/knowledge/vaults/:id',
      'PATCH /api/knowledge/vaults/:id',
      'DELETE /api/knowledge/vaults/:id',
      'GET /api/knowledge/vaults/:id/export',
      'GET /api/knowledge/vaults/:id/tree',
      'GET /api/knowledge/vaults/:id/note',
      'PUT /api/knowledge/vaults/:id/note',
      'DELETE /api/knowledge/vaults/:id/note',
      'POST /api/knowledge/vaults/:id/note/append',
      'POST /api/knowledge/vaults/:id/note/rename',
      'POST /api/knowledge/vaults/:id/note/restore',
      'GET /api/knowledge/vaults/:id/note/history',
      'GET /api/knowledge/vaults/:id/note/version',
      'GET /api/knowledge/vaults/:id/note/backlinks',
      'GET /api/knowledge/vaults/:id/note/mentions',
      'GET /api/knowledge/vaults/:id/embed',
      'GET /api/knowledge/vaults/:id/file',
      'PUT /api/knowledge/vaults/:id/file',
      'POST /api/knowledge/vaults/:id/folder',
      'GET /api/knowledge/vaults/:id/search',
      'GET /api/knowledge/vaults/:id/quick',
      'GET /api/knowledge/vaults/:id/tags',
      'GET /api/knowledge/vaults/:id/health',
      'GET /api/knowledge/vaults/:id/recent',
      'GET /api/knowledge/vaults/:id/deleted',
      'GET /api/knowledge/vaults/:id/daily',
      'POST /api/knowledge/vaults/:id/daily',
      'GET /api/knowledge/vaults/:id/activity',
      'POST /api/knowledge/vaults/:id/rescan',
    ],
  ),
  // Claude usage and usage spend (claudeusage/routes.ts, usagespend/routes.ts): Claude accounts' plan usage and the all-users views.
  ...area('usage', [
    'GET /api/claude-usage/summary',
    'GET /api/claude-usage/requests',
    'GET /api/claude-usage/recommend',
    'GET /api/claude-usage/palette',
    'GET /api/claude-usage/export',
    'GET /api/claude-usage',
    'GET /api/claude-usage/:claudeId/history',
    'POST /api/claude-usage/:claudeId/check',
    'PUT /api/claude-usage/:claudeId/snooze',
    'DELETE /api/claude-usage/:claudeId/snooze',
    'GET /api/usage-spend',
    'GET /api/usage-spend/alerts',
    'GET /api/usage-spend/audit',
    'GET /api/usage-spend/attribution',
    'GET /api/usage-spend/budgets',
    'POST /api/usage-spend/budgets',
    'PUT /api/usage-spend/budgets/:id',
    'DELETE /api/usage-spend/budgets/:id',
    'PUT /api/usage-spend/budgets/:id/snooze',
    'DELETE /api/usage-spend/budgets/:id/snooze',
    'GET /api/usage-spend/spikes',
    'PUT /api/usage-spend/spikes/snooze',
    'DELETE /api/usage-spend/spikes/snooze',
  ]),
};

let declared = false;
/** Declares the routes once (idempotent: the app is built more than once in tests). */
export function declareAppPolicies(): void {
  if (declared) return;
  declared = true;
  declarePolicies('app', APP_POLICIES);
  // Each module's own table, declared here as well as where the module builds itself: the guard must know every route before the first
  // request, whichever modules this app was given (each declare is idempotent, or declares the same rows again).
  for (const declare of [
    declareAttentionPolicies,
    declareAutoTransferPolicies,
    declareBrowserPolicies,
    declareCiPolicies,
    declareClaudeVersionPolicies,
    declareCodespacesPolicies,
    declareConnectPolicies,
    declareInstallPolicies,
    declareGlancePolicies,
    declareKeepGoingPolicies,
    declareLabPolicies,
    declareNotifyPolicies,
    declareWorkspacePoolPolicies,
    declarePortalMcpPolicies,
    declareWorkspaceReposPolicies,
    declareWorkspaceSecretsPolicies,
    declareSettingsPolicies,
    declareTicketPolicies,
    declareTriggerPolicies,
    declareWorkspacePolicies,
  ])
    declare();
}
