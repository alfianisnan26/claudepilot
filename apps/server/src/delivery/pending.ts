import { folderPlugin } from './marketplace.js';
import { deliverable, OWNERSHIP } from './ownership.js';
import type { Owner, Tombstone } from './types.js';

/**
 * `workspace_delivery.pending_deletes`: what a workspace still holds from earlier deliveries, on its way
 * out (foundation §6.4). Files no longer wanted wait for a grace period, version folders no longer
 * current (paths ending in `/`) for retention, and tombstones for older `claude` processes to exit.
 * Rows written before plugins and tombstones hold files only, `[{path, since}]`, and read the same;
 * workspaces that use neither keep writing exactly that.
 */
export interface Pending {
  /** Path → when it stopped being wanted (epoch ms). */
  paths: Map<string, number>;
  tombstones: Tombstone[];
}

type Row = { path?: unknown; since?: unknown; env?: unknown; owner?: unknown; value?: unknown };

/**
 * Reads the column, keeping only entries the reconciler may act on: files some owner may write, version
 * folders inside the marketplace, tombstones of known owners. Anything else is dropped, never deleted.
 */
export function parsePending(json: string | null | undefined): Pending {
  const out: Pending = { paths: new Map(), tombstones: [] };
  let rows: unknown;
  try {
    rows = JSON.parse(json || '[]');
  } catch {
    return out;
  }
  if (!Array.isArray(rows)) return out;
  for (const r of rows as Row[]) {
    if (!r || typeof r !== 'object' || typeof r.since !== 'number' || !Number.isFinite(r.since)) continue;
    if (typeof r.path === 'string') {
      if (r.path.endsWith('/') ? folderPlugin(r.path) : deliverable(r.path)) out.paths.set(r.path, r.since);
    } else if (typeof r.env === 'string' && typeof r.owner === 'string' && Object.hasOwn(OWNERSHIP, r.owner) && typeof r.value === 'string') {
      out.tombstones.push({ owner: r.owner as Owner, name: r.env, value: r.value, since: r.since });
    }
  }
  return out;
}

export function serializePending(p: Pending): string {
  return JSON.stringify([
    ...[...p.paths].map(([path, since]) => ({ path, since })),
    ...p.tombstones.map((t) => ({ env: t.name, owner: t.owner, value: t.value, since: t.since })),
  ]);
}
