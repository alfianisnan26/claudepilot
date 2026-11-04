// Standing Bypass per workspace (PILOT-1129, T-3598; owner 2026-11-03: "make them all bypassed with self healing, for both konfersi and memor
// ... i dont wanted to do anything"). The owner lists workspaces in the deploy manifest (env PORTAL_BYPASS_STANDING_WORKSPACES, comma
// separated `<target>/<name>` ids). For sessions there the portal answers a session.bypass request itself ("standing policy (owner)"), Keep
// going puts Bypass back whenever it finds it off (no 24 hour window), every session starts bypass-capable, and workers of a parent in
// Bypass start in it. Guard rails: only a listed workspace; never one whose id or name reads as production (`prd`, `prod`, `production`,
// the protected-pool word rule) or that carries `[protected]`; the global Bypass switch (sessions.allowBypass) must still be on. An empty
// list is today's behaviour.

import { isProtectedPool } from '@portal/contracts';

export const STANDING_BYPASS_ENV = 'PORTAL_BYPASS_STANDING_WORKSPACES';
/** Who decided, on an approval row and in the audit trail. */
export const STANDING_BYPASS_DECIDER = 'standing policy (owner)';
/** At most this many workspaces are listed (more is a typo, not a policy). */
export const STANDING_BYPASS_MAX = 50;
const WORKSPACE_ID = /^[a-z0-9][a-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export type StandingRefusal = 'empty' | 'not_listed' | 'protected';

/** The list from the env: trimmed, valid `<target>/<name>` ids only, de-duplicated; what was dropped is reported, never guessed at. */
export function parseStandingWorkspaces(raw: string | undefined | null): { ids: string[]; ignored: string[] } {
  const ids: string[] = [];
  const ignored: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const id = part.trim();
    if (!id) continue;
    if (!WORKSPACE_ID.test(id) || ids.length >= STANDING_BYPASS_MAX) ignored.push(id.slice(0, 80));
    else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, ignored };
}

/** A workspace that reads as production or is marked protected: never under a standing policy, whatever the list says. */
export function workspaceProtected(w: { id: string; name?: string | null; description?: string | null }): boolean {
  const name = w.name ?? w.id.slice(w.id.indexOf('/') + 1);
  return isProtectedPool({ name: w.id.replace('/', ' ') }) || isProtectedPool({ name, description: w.description ?? null });
}

/**
 * The policy as the portal holds it: the listed ids, and what it knows of a workspace (its name and description, for the protected rule).
 * One instance for the process (`standingBypass`), configured at boot; tests configure and reset it.
 */
export class StandingBypassPolicy {
  #ids: string[] = [];
  #ignored: string[] = [];
  #describe: (id: string) => { name?: string | null; description?: string | null } | null = () => null;

  configure(raw: string | undefined | null, describe?: (id: string) => { name?: string | null; description?: string | null } | null): void {
    const { ids, ignored } = parseStandingWorkspaces(raw);
    this.#ids = ids;
    this.#ignored = ignored;
    if (describe) this.#describe = describe;
  }

  reset(): void {
    this.configure('', () => null);
  }

  /** The listed ids (for the read-only setting row) and the entries ignored as invalid. */
  get ids(): readonly string[] {
    return this.#ids;
  }
  get ignored(): readonly string[] {
    return this.#ignored;
  }

  /** Whether the standing policy covers a workspace, and why not. */
  check(workspaceId: string): { ok: true } | { ok: false; why: StandingRefusal } {
    if (!this.#ids.length) return { ok: false, why: 'empty' };
    if (!this.#ids.includes(workspaceId)) return { ok: false, why: 'not_listed' };
    let facts: { name?: string | null; description?: string | null } | null = null;
    try {
      facts = this.#describe(workspaceId);
    } catch {
      // unknown: the id alone decides
    }
    if (workspaceProtected({ id: workspaceId, ...(facts ?? {}) })) return { ok: false, why: 'protected' };
    return { ok: true };
  }

  applies(workspaceId: string | null | undefined): boolean {
    return !!workspaceId && this.check(workspaceId).ok;
  }
}

export const standingBypass = new StandingBypassPolicy();
