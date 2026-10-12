// Codespaces POC: route declarations for the authorization layer (docs/prd/codespaces-poc.md §10). A connection is not an object type of its
// own: it is a pointer at a secret set, so every route is "signed-in" and the service checks `operate` on that set (`pool`, poolType
// `secrets`) and the connector rule before it opens the token. Lists are filtered the same way.

import { declarePolicies } from '../authz/seam.js';

export function declareCodespacesPolicies(): void {
  const handler = { kind: 'signed-in', filter: 'pool' } as const;
  declarePolicies('codespaces', {
    'GET /api/codespaces': handler,
    'POST /api/codespaces/connections': { kind: 'signed-in', creates: 'pool' },
    'POST /api/codespaces/connections/:id/check': handler,
    'DELETE /api/codespaces/connections/:id': { ...handler, audit: 'codespaces.disconnected' },
    'POST /api/codespaces/device': { kind: 'signed-in', creates: 'pool' },
    'GET /api/codespaces/device/:flowId': { kind: 'self' },
    'DELETE /api/codespaces/device/:flowId': { kind: 'self' },
    'GET /api/codespaces/connections/:id/repos': handler,
    'GET /api/codespaces/connections/:id/repos/:owner/:repo/options': handler,
    'GET /api/codespaces/connections/:id/billing': handler,
    'GET /api/codespaces/connections/:id/codespaces': handler,
    'POST /api/codespaces/connections/:id/codespaces': { ...handler, audit: 'codespaces.created' },
    'GET /api/codespaces/connections/:id/codespaces/:name': handler,
    'POST /api/codespaces/connections/:id/codespaces/:name/start': { ...handler, audit: 'codespaces.started' },
    'POST /api/codespaces/connections/:id/codespaces/:name/stop': { ...handler, audit: 'codespaces.stopped' },
    'POST /api/codespaces/connections/:id/codespaces/:name/attach': { ...handler, audit: 'codespaces.attached' },
    'POST /api/codespaces/connections/:id/codespaces/:name/detach': { ...handler, audit: 'codespaces.detached' },
    'DELETE /api/codespaces/connections/:id/codespaces/:name': { ...handler, audit: 'codespaces.deleted' },
  });
}
