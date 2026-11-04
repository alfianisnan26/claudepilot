import type { Env } from '../env.js';
import { SchemaDO } from './schema.js';

// Phase 1 stubs (PILOT-1131, D2): one class per shard. Each starts at schema version 1, a key/value meta table;
// the real tables arrive with the slices that move each area.
const BASELINE = 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)';

/** The platform shard: settings, users, orgs index (one object). */
export class PlatformDO extends SchemaDO {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, 'platform', [BASELINE]);
  }
}

/** One per org. */
export class OrgDO extends SchemaDO {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, 'org', [BASELINE]);
  }
}

/** One per workspace. */
export class WorkspaceDO extends SchemaDO {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, 'workspace', [BASELINE]);
  }
}

/** One per chat session: 30 days of live history, then R2 (D7). */
export class ChatSessionDO extends SchemaDO {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, 'chat-session', [BASELINE]);
  }
}

/** One per cluster: the dial-out link from cp-bridge (D4, PILOT-1144). */
export { BridgeDO } from './bridge.js';
