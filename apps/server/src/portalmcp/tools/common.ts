import { AppError } from '@isnanme/core';
import type { Workspace } from '@portal/contracts';
import { config } from '../../config.js';
import { findWorkspace } from '../../workspaces/identity.js';
import { PortalToolError, type PortalToolContext } from '../registry.js';
import { cleanText, type UntrustedText } from '../sanitize.js';

// Helpers the built-in tool files share.

/** Where a person opens something in the admin UI: `PORTAL_UI_URL`, else this portal on its own port. */
export function uiLink(path: string): string {
  const base = (config.portalMcp.uiUrl ?? `http://localhost:${config.port}`).replace(/\/+$/, '');
  return `${base}${path}`;
}

/** A short identifier or URL, safe to show as it is: no spaces, bounded. Anything else is prose. */
const IDENTIFIER = /^[A-Za-z0-9_.:@/+=?&#%~-]{1,120}$/;

/**
 * Labels the prose in imported or third-party structured data (pool content, descriptions, tool lists):
 * identifiers, versions and URLs stay as they are, and every string with spaces, or a long one, becomes
 * `{untrusted_text, source}`. Secrets are redacted either way. Depth-limited.
 */
export function labelProse<T>(value: T, source: string, depth = 0): unknown {
  if (depth > 12) return null;
  if (typeof value === 'string') {
    const clean = cleanText(value, 2_000);
    return IDENTIFIER.test(clean) ? clean : ({ untrusted_text: clean, source } satisfies UntrustedText);
  }
  if (Array.isArray(value)) return value.map((v) => labelProse(v, source, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[cleanText(k, 120)] = labelProse(v, source, depth + 1);
    return out;
  }
  return value;
}

/**
 * A workspace by its stable id (`ws_…`) or its `<target>/<name>` alias, both through the workspaces' one resolver (T-42), or by its exact
 * name when only one target has it.
 */
export function resolveWorkspace(all: Workspace[], idOrName: string): Workspace {
  const wanted = idOrName.trim();
  const byId = findWorkspace(all, wanted);
  if (byId) return byId;
  if (!wanted.includes('/')) {
    const named = all.filter((w) => w.name === wanted);
    if (named.length === 1) return named[0]!;
    if (named.length > 1)
      throw new PortalToolError('AMBIGUOUS', `${named.length} workspaces are named “${wanted}”. Use the full id.`, { matches: named.map((w) => w.id) });
  }
  throw new AppError('NOT_FOUND', `No workspace “${wanted}”. List them with workspace_list.`);
}

/** The portal's database must be writable for any change; Locked and Frozen get the codes PRD §16 names. */
export function assertCanChange(store: { writable: boolean; trust: { state: string; reasons: { message: string }[] } }, what: 'workspace' | 'pool' = 'pool'): void {
  if (!store.writable) throw new PortalToolError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now, so nothing can be changed.');
  if (store.trust.state === 'frozen' && what === 'pool')
    throw new PortalToolError('FROZEN', `Delivery is frozen: ${cleanText(store.trust.reasons[0]?.message ?? 'the portal does not trust its own state', 300)} A person must resume it in the portal.`);
}

export function assertUnlocked(store: { trust: { state: string } }): void {
  if (store.trust.state === 'locked') throw new PortalToolError('LOCKED', 'The portal is locked: its secret key is not loaded. A person must unlock it in the portal (Access → Storage).');
}

/** What a workspace looks like in a result: no secret, runtime text labelled. */
export function workspaceBrief(w: Workspace, ctx: PortalToolContext) {
  return {
    id: w.id,
    // The workspace's identity (T-42): `id` above is its `<target>/<name>` alias, which keeps working; both resolve.
    stable_id: w.stableId ?? null,
    name: w.name,
    target: w.target,
    runtime_name: w.runtimeName ?? null,
    status: w.status,
    detail: ctx.untrusted(w.detail ?? null, 'runtime'),
    cpus: w.cpus ?? null,
    memory_mb: w.memoryMb ?? null,
    created_at: w.createdAt,
    account_pool: w.account?.poolName ?? null,
    delivery: w.delivery ? { status: w.delivery.status, reason: ctx.untrusted(w.delivery.reason, 'delivery'), applied_at: w.delivery.appliedAt, claude_version: w.delivery.claudeVersion } : null,
  };
}
