// GitHub Codespaces as a workspace target, the POC (docs/prd/codespaces-poc.md). Wiring and configuration: this module reads its own
// environment variables (no edit to config.ts):
//   PORTAL_GITHUB_CLIENT_ID   the client ID of a GitHub OAuth App (or GitHub App) with the device flow enabled. Unset: sign-in with GitHub
//                             is unavailable and says so; the token path still works. There is NO client secret setting, on purpose.
//   PORTAL_GITHUB_SCOPES      the scopes the device flow asks for (space or comma separated), default `codespace` (PRD §6).
//   PORTAL_GITHUB_STANDIN_URL a stand-in GitHub (standin.ts) for tests and scratch portals; honoured only when NODE_ENV is not
//                             production, and logged at start-up, because it sends tokens to a non-GitHub origin.

import { PlatformAudit } from '../platform/audit.js';
import type { PoolService } from '../pools/service.js';
import type { SecretValues } from '../secrets/values.js';
import type { Store } from '../store/store.js';
import { declareCodespacesPolicies } from './authz.js';
import { GitHubClient } from './github.js';
import { Codespaces } from './service.js';
import { secretsVault } from './vault.js';

export { createCodespacesRoutes } from './routes.js';
export { Codespaces } from './service.js';
export { startGitHubStandIn, type GitHubStandIn } from './standin.js';

export interface CodespacesEnv {
  clientId?: string;
  scopes?: string;
  standinUrl?: string;
  production?: boolean;
}

export function codespacesEnv(env: NodeJS.ProcessEnv = process.env): CodespacesEnv {
  const v = (k: string) => env[k]?.trim() || undefined;
  return { clientId: v('PORTAL_GITHUB_CLIENT_ID'), scopes: v('PORTAL_GITHUB_SCOPES'), standinUrl: v('PORTAL_GITHUB_STANDIN_URL'), production: env.NODE_ENV === 'production' };
}

export function createCodespaces(deps: { store: Store; pools: PoolService; values: SecretValues; dataDir: string; env?: CodespacesEnv }): Codespaces {
  const env = deps.env ?? codespacesEnv();
  declareCodespacesPolicies();
  const standin = env.standinUrl && !env.production ? new URL(env.standinUrl).origin : null;
  if (env.standinUrl && env.production) console.warn('[codespaces] PORTAL_GITHUB_STANDIN_URL is ignored in production');
  if (standin) console.warn(`[codespaces] using a STAND-IN GitHub at ${standin} (PORTAL_GITHUB_STANDIN_URL): not for real tokens`);
  const gh = new GitHubClient({ endpoints: standin ? { web: standin, api: standin } : { web: 'https://github.com', api: 'https://api.github.com' }, allowOtherHosts: !!standin });
  const audit = new PlatformAudit(deps.store);
  const clientId = env.clientId && /^[A-Za-z0-9._-]{1,100}$/.test(env.clientId) ? env.clientId : null;
  if (env.clientId && !clientId) console.warn('[codespaces] PORTAL_GITHUB_CLIENT_ID does not look like a client ID: device flow off');
  return new Codespaces({
    gh,
    host: standin ? new URL(standin).host : 'github.com',
    vault: secretsVault(deps.pools, deps.values),
    dataFile: `${deps.dataDir}/codespaces.json`,
    clientId,
    scopes: (env.scopes ?? 'codespace').split(/[\s,]+/).filter((s) => /^[a-z:_]{1,40}$/.test(s)).slice(0, 10),
    audit: (e) => audit.record(e),
  });
}
