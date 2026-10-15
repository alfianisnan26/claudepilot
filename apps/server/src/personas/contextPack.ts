// The context pack as an instruction context (T-292 slice 2, token economy lever 7). A repository's generated `docs/context-pack.md`
// (scripts/context-pack.sh) becomes the Context pool `<repo>-context-pack`, assigned to the workspace that hosts the repository's CI
// remote, so every session and sub-agent there reads it as managed instructions (contexts.ts). The CI service hands over the file
// from each push to the remote's default branch (`snapshot`); this module only decides what the pool gets. No new delivery: the pool
// service stores the revision and asks the reconciler, like any edit.
//
// T-472: the pool holds the pack as a path-scoped rule (`paths` frontmatter from its own Map), so in a workspace shared with other
// repositories only sessions working on this one load it. A delivery of it restarts no session: instruction contexts are hot-reloaded
// (chat/controller.ts HOT_AREAS).
//
// What it refuses, keeping what the pool had: a pack over an instruction context's cap (20 KB), anything secret-shaped (the context
// kind's own check, chat/redact.ts), and a pool of that name that belongs to another workspace. It never deletes the pool and never
// assigns it again once a person took it off the workspace.

import { isAppError } from '@isnanme/core';
import { PERSONA_LIMITS, type ContextContent } from '@portal/contracts';
import type { PoolService } from '../pools/service.js';
import { secretProblem } from './kind.js';

/** What a sync did. `refused` and `failed` carry a fixed code (never text from the file). */
export type ContextPackOutcome =
  | { outcome: 'created' | 'updated'; poolId: string; revision: number; assigned: boolean }
  | { outcome: 'unchanged'; poolId: string; revision: number }
  | { outcome: 'refused'; code: 'too_large' | 'secret' | 'unreadable' | 'invalid' | 'other_workspace'; poolId?: string }
  | { outcome: 'failed'; code: string };

export interface ContextPackInput {
  /** The workspace hosting the repository's CI remote: `<target>/<name>`. */
  workspaceId: string;
  /** The remote's name (`claudepilot`): the pool is `<repo>-context-pack`. */
  repo: string;
  branch: string;
  sha: string;
  /** The file as the snapshot read it: its text, or why it wasn't read. */
  file: { text: string | null; skipped?: string };
}

export const contextPackName = (repo: string) => `${repo.slice(0, 60 - '-context-pack'.length)}-context-pack`;

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
/** The body as the context kind stores it (contexts.ts `parse`), so equal files compare equal. */
const normal = (s: string) => s.replace(/\r\n/g, '\n').replace(/\s+$/, '');

type Audit = (e: { kind: string; actor: string; userId: string | null; severity?: 'info' | 'medium' | 'high'; subject?: string; detail?: Record<string, unknown> }) => void;

/**
 * CI's `contextPack` hook: syncs, then one platform audit row `pools.context_pack` for every change or refusal (an unchanged pack
 * leaves none). Names, ids and fixed codes only: never the file's text.
 */
export function contextPackHook(pools: PoolService, audit: Audit) {
  return (input: ContextPackInput): ContextPackOutcome => {
    const r = syncContextPack(pools, input);
    if (r.outcome === 'unchanged') return r;
    const refused = r.outcome === 'refused' || r.outcome === 'failed';
    if (refused) console.error(`[context-pack] ${input.repo}@${input.branch} ${input.sha.slice(0, 7)}: ${r.outcome} (${r.code})`);
    audit({
      kind: 'pools.context_pack',
      actor: 'portal',
      userId: null,
      severity: refused ? 'medium' : 'info',
      subject: contextPackName(input.repo),
      detail: { workspace: input.workspaceId, repo: input.repo, branch: input.branch, sha: input.sha.slice(0, 12), ...r },
    });
    return r;
  };
}

/** A glob a rule's `paths` may hold: relative, plain characters and globs, no `..`. */
const SAFE_GLOB = /^[A-Za-z0-9._{},*-]+(\/[A-Za-z0-9._{},*-]+)*$/;
const MAX_SCOPE = 40;

/**
 * T-472: the folders the pack's own `## Map` names (each entry's first `code` path), as `paths` globs, so the rule loads only in a session
 * that works on this repository's files (Claude Code matches them from the session's project folder, so a worktree matches too). A
 * one-level folder (`scripts/`, `deploy/`) is left out: other repositories have those as well. Empty when the Map names nothing usable.
 */
export function packScope(text: string): string[] {
  const map = /^## Map\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text.replace(/\r\n/g, '\n'))?.[1] ?? '';
  const out: string[] = [];
  for (const m of map.matchAll(/^- `([^`\s]+)`/gm)) {
    const p = m[1]!.replace(/\/\*?$/, ''); // `features/*` and `deploy/` name the folder
    if (!SAFE_GLOB.test(p) || p.split('/').includes('..') || p.split('/').length < 2) continue;
    const last = p.split('/').at(-1)!;
    const glob = /\.[A-Za-z0-9]+$/.test(last) ? p : `${p}/**`;
    if (!out.includes(glob)) out.push(glob);
    if (out.length >= MAX_SCOPE) break;
  }
  return out;
}

/**
 * T-472: the pack as a path-scoped rule: frontmatter with `paths` from its Map before the text, so sessions of other repositories in the
 * same workspace do not load it. A pack that brings its own frontmatter, or whose Map names nothing usable, is left as it is.
 */
export function scopedPack(body: string): string {
  if (body.startsWith('---\n')) return body;
  const scope = packScope(body);
  if (!scope.length) return body;
  return `---\npaths:\n${scope.map((g) => `  - "${g}"`).join('\n')}\n---\n${body}`;
}

/** Creates, updates or leaves the repository's context pack pool; never throws. */
export function syncContextPack(pools: PoolService, input: ContextPackInput): ContextPackOutcome {
  const { file } = input;
  if (file.skipped === 'too_large') return { outcome: 'refused', code: 'too_large' };
  if (file.text === null) return { outcome: 'refused', code: 'unreadable' };
  const body = scopedPack(normal(file.text));
  if (bytes(body) > PERSONA_LIMITS.contextBytes) return { outcome: 'refused', code: 'too_large' };
  if (secretProblem(body)) return { outcome: 'refused', code: 'secret' };
  const name = contextPackName(input.repo);
  const note = `context pack ${input.sha.slice(0, 7)} from ${input.repo}@${input.branch}`.slice(0, 200);
  try {
    const found = pools.list('context').find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!found) {
      const made = pools.create('context', {
        name,
        description: `The context pack of ${input.repo} (docs/context-pack.md), kept in step by the portal on each push to ${input.branch}.`,
        content: { body } satisfies ContextContent,
        note,
      });
      const assigned = pools.assignToMany(made.id, [input.workspaceId]).assigned.includes(input.workspaceId);
      return { outcome: 'created', poolId: made.id, revision: made.latestRevision, assigned };
    }
    const where = pools.get(found.id).assignedTo.map((a) => a.workspaceId);
    if (where.length && !where.includes(input.workspaceId)) return { outcome: 'refused', code: 'other_workspace', poolId: found.id };
    if ((found.content as ContextContent | null)?.body === body) return { outcome: 'unchanged', poolId: found.id, revision: found.latestRevision };
    const next = pools.update(found.id, { content: { body } satisfies ContextContent, note, baseRevision: found.latestRevision });
    return { outcome: 'updated', poolId: found.id, revision: next.latestRevision, assigned: where.includes(input.workspaceId) };
  } catch (e) {
    if (isAppError(e) && e.code === 'VALIDATION_FAILED') return { outcome: 'refused', code: 'invalid' };
    return { outcome: 'failed', code: isAppError(e) ? e.code : 'error' };
  }
}
