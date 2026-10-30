// Claude usage (docs/prd/claude-usage.md): the plan limits of each Claude. index.ts builds one, starts it, hands the
// chat reader's rate-limit events to `onRateLimit` (interface I12), and app.ts mounts its routes.

import { config } from '../config.js';
import type { Store } from '../store/store.js';
import type { Workspaces } from '../workspaces/manager.js';
import { ClaudeUsageMonitor, usageSettings, type UsageOptions } from './service.js';
import { usageSource, type ClaudeDirectory } from './source.js';
import { PRIME_MIN_SETTING } from './settings.js';

export { ClaudeUsageMonitor } from './service.js';
export { createClaudeUsageRoutes } from './routes.js';
export { OWNER_ACTOR } from './actor.js';

export interface ClaudeUsageDeps {
  store: Store;
  workspaces: Pick<Workspaces, 'list' | 'exec'>;
  chat: ClaudeDirectory;
  /** The workspace has an account pool (its Claudes run on API keys). */
  pooled: (workspaceId: string) => boolean;
  /** Tells open pages the snapshot changed. */
  notify: () => void;
  /** The shared settings (T-1707 reads `claude.usage.primeMin` at each use). */
  settings: { get(key: string): unknown };
  /** The platform audit (one `claude.usage.prime` row per prime). */
  audit: NonNullable<UsageOptions['audit']>;
}

export function createClaudeUsage(deps: ClaudeUsageDeps): ClaudeUsageMonitor {
  return new ClaudeUsageMonitor({
    store: deps.store,
    source: usageSource(deps.workspaces, deps.chat, deps.pooled),
    settings: usageSettings({ probes: config.claudeUsage.probes, intervalS: config.claudeUsage.intervalS, fastS: config.claudeUsage.fastS, only: config.claudeUsage.only }),
    notify: deps.notify,
    primeMin: () => Number(deps.settings.get(PRIME_MIN_SETTING)),
    audit: deps.audit,
  });
}
