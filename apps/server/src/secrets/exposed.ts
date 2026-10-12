import type { PoolService } from '../pools/service.js';
import { SecretsKind } from './kind.js';

/**
 * QA-006 / Secrets & env A9, for Chat sessions' redactor and artifact previews: every secret value the
 * workspace's sets deliver, current and recent (30 days), in memory only. Callers must never log, store,
 * return or put these in a response. `[]` for a portal without Secrets & env, or while it is Locked.
 *
 *   const values = exposedSecretValues(poolService, 'docker/ws1');
 */
export function exposedSecretValues(pools: Pick<PoolService, 'kind'>, workspaceId: string, opts?: { days?: number; minLength?: number; max?: number }): string[] {
  let kind: unknown;
  try {
    kind = pools.kind('secrets');
  } catch {
    return [];
  }
  return kind instanceof SecretsKind ? kind.exposedSecretValues(workspaceId, opts) : [];
}
