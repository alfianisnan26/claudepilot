import { createHash } from 'node:crypto';
import { AppError } from '@isnanme/core';
import { PERSONA_LIMITS, type ContextContent, type PersonaContent } from '@portal/contracts';
import { CompileError } from '../delivery/compile.js';
import type { DeliveredFile, Fragment } from '../delivery/types.js';
import { ROOT } from '../delivery/types.js';
import type { AssignedPool, KindContext, ParseContext, PoolKind } from '../pools/kinds.js';
import type { PoolService } from '../pools/service.js';
import type { Store } from '../store/store.js';
import { CONTROL, INVISIBLE, secretProblem } from './kind.js';
import { CONTEXT_STAMP, contextFile, contextSlug, RULES_DIR, stamped } from './render.js';

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** One context a workspace gets, and where it came from. */
export interface ContextSource {
  poolId: string;
  name: string;
  revision: number;
  body: string;
  /** Assigned to the workspace on its own, or held by the workspace's persona. */
  via: 'assigned' | 'persona';
}

/**
 * The instruction context pool type (Persona PRD A9): a reusable piece of instructions ("Coding standards",
 * "Security review checklist") assigned to workspaces on its own, several per workspace, or held by
 * personas. Each context is one managed rule file, `/etc/claude-code/.claude/rules/cpx-<name>.md`, which
 * Claude Code loads next to the managed CLAUDE.md and before the repository's and the user's own (✅ observed
 * on 2.1.296: "organization-managed policy instructions"), so a context adds to them and never replaces them.
 *
 * A workspace gets the contexts assigned to it plus those its persona holds, each once. A context only its
 * persona holds belongs to the persona's lifecycle: it isn't named in the manifest as a pool of its own.
 * The contexts' own drop-in carries a stamp of what they deliver, so running sessions re-read the rules when
 * one changes (render.ts `stamped`).
 */
export class ContextKind implements PoolKind<ContextContent> {
  readonly type = 'context' as const;
  /** What each workspace's held contexts looked like when last compiled, to tell when a held context changed (`#nudge`). */
  readonly #seen = new Map<string, string>();
  #nudging = false;

  constructor(
    private readonly store: Store,
    private readonly service: () => PoolService,
  ) {}

  parse(input: unknown, _prev: ContextContent | null, _ctx?: ParseContext): ContextContent {
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? (input as { body?: unknown }).body : undefined;
    if (typeof raw !== 'string') throw invalid('body', 'Write the instructions.');
    const body = raw.replace(/\r\n/g, '\n').replace(/\s+$/, '');
    if (!body.trim()) throw invalid('body', 'Write the instructions.');
    if (bytes(body) > PERSONA_LIMITS.contextBytes) throw invalid('body', `Use at most ${PERSONA_LIMITS.contextBytes / 1024} KB. Split it into several contexts.`);
    if (CONTROL.test(body) || INVISIBLE.test(body)) throw invalid('body', 'Remove the control and invisible characters.');
    const secret = secretProblem(body);
    if (secret) throw invalid('body', secret);
    this.#nudge();
    return { body };
  }

  view(content: ContextContent): ContextContent {
    return content;
  }

  /** A draft becoming deliverable, or a revision made current: the persona-held copies change with it. */
  approve(): void {
    this.#nudge();
  }

  beforeCurrent(): void {
    this.#nudge();
  }

  /**
   * Personas that hold a context, by name: in their current or newest revision. Older revisions may name a
   * context that's gone; delivery skips one that has nothing published, so history doesn't pin a context forever.
   */
  #heldBy(poolId: string): string[] {
    const rows = (this.store.db
      ?.prepare(
        `SELECT p.id, p.name, r.content FROM pools p JOIN pool_revisions r ON r.pool_id = p.id
         WHERE p.type = 'persona' AND (r.revision = p.current_revision OR r.revision = (SELECT max(revision) FROM pool_revisions WHERE pool_id = p.id))`,
      )
      .all() ?? []) as { id: string; name: string; content: string }[];
    const names = new Set<string>();
    for (const r of rows) {
      try {
        if (((JSON.parse(r.content) as Partial<PersonaContent>).contexts ?? []).includes(poolId)) names.add(r.name);
      } catch {
        // A row that isn't JSON holds nothing.
      }
    }
    return [...names].sort();
  }

  /** Deleting is refused while a persona holds the context (A9); removing it from a workspace just takes the file away. */
  beforeUnassign(workspaceId: string, poolId: string): string[] {
    if (workspaceId) {
      const held = this.service().assignedPools<PersonaContent>(workspaceId, 'persona').some((a) => a.content.contexts.includes(poolId));
      return held ? ['Its persona still holds it, so the workspace keeps getting it through the persona.'] : [];
    }
    const by = this.#heldBy(poolId);
    if (by.length) throw new AppError('CONFLICT', `${by.map((n) => `“${n}”`).join(', ')} ${by.length === 1 ? 'holds' : 'hold'} this context. Take it out of ${by.length === 1 ? 'that persona' : 'those personas'} first.`);
    return [];
  }

  /** What a workspace gets, from its assignments and its persona, each context once, in a stable order. */
  sourcesFor(workspaceId: string, assigned: AssignedPool<ContextContent>[]): ContextSource[] {
    const out = new Map<string, ContextSource>();
    for (const a of assigned) out.set(a.pool.id, { poolId: a.pool.id, name: a.pool.name, revision: a.pool.revision, body: a.content.body, via: 'assigned' });
    if (workspaceId) {
      const persona = this.service().assignedPools<PersonaContent>(workspaceId, 'persona')[0];
      for (const id of persona?.content.contexts ?? []) {
        if (out.has(id)) continue;
        const held = this.service().currentContent<ContextContent>(id, 'context');
        if (held) out.set(id, { poolId: id, name: held.pool.name, revision: held.pool.revision, body: held.content.body, via: 'persona' });
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.poolId.localeCompare(b.poolId));
  }

  fragments(assigned: AssignedPool<ContextContent>[], ctx: KindContext): Fragment[] {
    const sources = this.sourcesFor(ctx.workspaceId, assigned);
    if (ctx.workspaceId && !ctx.preview) this.#seen.set(ctx.workspaceId, fingerprint(sources));
    if (sources.length === 0) return [];
    // Names → files: two contexts whose names make the same slug get a number, in a stable order.
    const used = new Set<string>();
    const files: { source: ContextSource; file: DeliveredFile }[] = sources.map((s) => {
      const base = contextSlug(s.name);
      let slug = base;
      for (let n = 2; used.has(slug); n++) slug = `${base.slice(0, 44)}-${n}`;
      used.add(slug);
      return { source: s, file: contextFile(slug, s.name, s.revision, s.body) };
    });
    const total = files.reduce((n, f) => n + bytes(f.file.content), 0);
    if (total > PERSONA_LIMITS.compiledBytes) throw new CompileError('context', `the contexts add up to ${Math.round(total / 1024)} KB; a workspace takes at most ${PERSONA_LIMITS.compiledBytes / 1024} KB.`);
    // Each assigned context is named in the manifest, so one the database forgot freezes the workspace (§6.5); a
    // context only the persona holds is part of the persona and isn't named on its own.
    const out: Fragment[] = files.map(({ source, file }) => ({
      owner: 'context',
      ...(source.via === 'assigned' ? { pool: { id: source.poolId, revision: source.revision } } : {}),
      files: [file],
    }));
    for (const a of assigned) if (!out.some((f) => f.pool?.id === a.pool.id)) out.push({ owner: 'context', pool: { id: a.pool.id, revision: a.pool.revision } });
    // The rules folder, and the one drop-in this type has: a stamp of what it delivers (render.ts `stamped`).
    out.push({
      owner: 'context',
      dirs: [{ path: RULES_DIR, mode: 0o755, uid: ROOT, gid: ROOT }],
      settings: stamped(
        CONTEXT_STAMP,
        files.map((f) => f.file),
        {},
      ),
    });
    return out;
  }

  /**
   * The pool service asks for delivery to the workspaces a pool is assigned to. A context a persona holds
   * isn't assigned to anything, so a change to it would wait for the 60 s timer: once the change is stored,
   * ask for delivery to the workspaces whose held contexts differ from what was last compiled for them.
   * Coalesced, and run after the service's transaction has committed.
   */
  #nudge(): void {
    if (this.#nudging) return;
    this.#nudging = true;
    setImmediate(() => {
      this.#nudging = false;
      try {
        this.#requestHolders();
      } catch (e) {
        console.error(`[personas] could not ask for delivery of a changed context: ${(e as Error).message}`);
      }
    });
  }

  #requestHolders(): void {
    const reconciler = this.service().reconciler;
    const db = this.store.db;
    if (!reconciler || !db) return;
    const rows = db.prepare("SELECT DISTINCT workspace_id FROM assignments WHERE pool_type = 'persona'").all() as { workspace_id: string }[];
    for (const { workspace_id: ws } of rows) {
      const held = this.sourcesFor(ws, []).filter((s) => s.via === 'persona');
      if (held.length === 0) continue;
      const assigned = this.service().assignedPools<ContextContent>(ws, 'context');
      if (this.#seen.get(ws) !== fingerprint(this.sourcesFor(ws, assigned))) void reconciler.request(ws, 'context changed', { changed: true });
    }
  }
}

/** Which contexts a workspace gets at which revision, and what they say. */
function fingerprint(sources: ContextSource[]): string {
  const h = createHash('sha256');
  for (const s of sources) h.update(`${s.poolId}\0${s.revision}\0${s.name}\0${s.via}\0${s.body}\0`);
  return h.digest('hex');
}
