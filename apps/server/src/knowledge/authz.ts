// Knowledge (organizations slice 1, P4): every route under /api/knowledge, enforced centrally (authz/routeGuard.ts) through the vault's owner
// (authz/owners.ts, `kg_vaults.owner_kind/owner_id`, migration 410). Reading a vault's notes, files, history, graph or export is `view`;
// writing a note, a file or a folder, the daily note and a rescan are `operate`; renaming it, its settings and deleting it are `manage`.
// The lists (`/vaults`, the graph across vaults, the sources) are still the handler's: filtering them per person is P5 (slice 2).

import type { RoutePolicies, RoutePolicy, Verb } from '@portal/contracts';
import { declarePolicies } from '../authz/seam.js';

const vault = (verb: Verb): RoutePolicy => ({ kind: 'objects', checks: [{ type: 'vault', verb, from: 'path', param: 'id' }] });
const V = '/api/knowledge/vaults/:id';

export const KNOWLEDGE_POLICIES: RoutePolicies = {
  'GET /api/knowledge/vaults': { kind: 'signed-in' },
  'POST /api/knowledge/vaults': { kind: 'signed-in', creates: 'vault' },
  'POST /api/knowledge/vaults/import': { kind: 'signed-in', creates: 'vault' },
  'GET /api/knowledge/graph': { kind: 'signed-in' },
  'GET /api/knowledge/sources': { kind: 'signed-in' },
  [`GET ${V}`]: vault('view'),
  [`PATCH ${V}`]: vault('manage'),
  [`DELETE ${V}`]: vault('manage'),
  [`GET ${V}/activity`]: vault('view'),
  [`GET ${V}/daily`]: vault('view'),
  [`POST ${V}/daily`]: vault('operate'),
  [`GET ${V}/deleted`]: vault('view'),
  [`GET ${V}/embed`]: vault('view'),
  [`GET ${V}/export`]: vault('view'),
  [`GET ${V}/file`]: vault('view'),
  [`PUT ${V}/file`]: vault('operate'),
  [`POST ${V}/folder`]: vault('operate'),
  [`GET ${V}/health`]: vault('view'),
  [`GET ${V}/note`]: vault('view'),
  [`PUT ${V}/note`]: vault('operate'),
  [`DELETE ${V}/note`]: vault('operate'),
  [`POST ${V}/note/append`]: vault('operate'),
  [`GET ${V}/note/backlinks`]: vault('view'),
  [`GET ${V}/note/history`]: vault('view'),
  [`GET ${V}/note/mentions`]: vault('view'),
  [`POST ${V}/note/rename`]: vault('operate'),
  [`POST ${V}/note/restore`]: vault('operate'),
  [`GET ${V}/note/version`]: vault('view'),
  [`GET ${V}/quick`]: vault('view'),
  [`GET ${V}/recent`]: vault('view'),
  [`POST ${V}/rescan`]: vault('operate'),
  [`GET ${V}/search`]: vault('view'),
  [`GET ${V}/tags`]: vault('view'),
  [`GET ${V}/tree`]: vault('view'),
};

export function declareKnowledgePolicies(): void {
  declarePolicies('knowledge', KNOWLEDGE_POLICIES);
}
