// Needs you (docs/prd/attention.md): index.ts builds one registry with the first sources, chains module changes into it, and app.ts mounts
// its route. A new source is one file next to its module and one line here.

import type { Store } from '../store/store.js';
import { toolApprovalAttentionSource } from '../chat/attention.js';
import { ciAttentionSource } from '../ci/attention.js';
import { mcpAttentionSource } from '../mcp/attention.js';
import { skillAttentionSource } from '../skills/attention.js';
import { ticketAttentionSource } from '../tickets/attention.js';
import { declareAttentionPolicies } from './authz.js';
import { AttentionRegistry, type AttentionOptions } from './registry.js';

export { AttentionRegistry, type AttentionChanged, type AttentionSource } from './registry.js';
export { createAttentionRoutes } from './routes.js';

export function createAttention(store: Pick<Store, 'db'>, opts: AttentionOptions = {}): AttentionRegistry {
  declareAttentionPolicies();
  const db = () => store.db;
  const registry = new AttentionRegistry({ log: (what, e) => console.error(`[attention] reading ${what} failed: ${(e as Error).message}`), ...opts });
  registry.register(mcpAttentionSource(db));
  registry.register(skillAttentionSource(db));
  registry.register(ciAttentionSource(db));
  registry.register(ticketAttentionSource(db));
  registry.register(toolApprovalAttentionSource(db));
  return registry;
}
