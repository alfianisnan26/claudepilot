import { AppError, success } from '@isnanme/core';
import type { ContextContent, PersonaContent, PersonaProposalStatus, WorkspacePersona } from '@portal/contracts';
import { PERSONA_AVATAR } from '@portal/contracts';
import { Hono } from 'hono';
import type { PoolService } from '../pools/service.js';
import type { Store } from '../store/store.js';
import { normalizeAvatar } from './avatar.js';
import { ContextKind } from './contexts.js';
import { PersonaIdentityStore } from './identity.js';
import { PersonaKind } from './kind.js';
import { PersonaProposals } from './proposals.js';

/**
 * Personas and instruction contexts in one place (Persona PRD): the `persona` pool kind, the `context` pool
 * kind, a persona's identity (name, avatar, the switches that let agents propose changes) and those proposals
 * (I11), and the small read API other parts of the portal use (I5: sessions and tickets that want to say which
 * persona a workspace runs, with its name and avatar). Made once in index.ts, before the reconciler starts.
 * Nobody else edits persona code: they read through this.
 */
export class Personas {
  readonly persona: PersonaKind;
  readonly contexts: ContextKind;
  readonly identity: PersonaIdentityStore;
  readonly proposals: PersonaProposals;
  /** The portal-wide switch `agents.selfEdit`: index.ts sets it once the settings store exists. Off until then. */
  agentSelfEdit: () => boolean = () => false;

  constructor(
    private readonly store: Store,
    private readonly pools: PoolService,
    opts: { now?: () => Date } = {},
  ) {
    this.persona = new PersonaKind(store, () => pools);
    this.contexts = new ContextKind(store, () => pools);
    pools.register(this.persona);
    pools.register(this.contexts);
    this.identity = new PersonaIdentityStore(store, pools);
    this.proposals = new PersonaProposals(store, pools, this.identity, this.persona, () => this.agentSelfEdit(), opts.now);
  }

  /**
   * I5: the persona a workspace gets with its name and avatar, the instruction contexts it gets (assigned or held
   * by the persona), and the parts the persona sets. Read-only and never secret: personas hold none. Pins and
   * rollout pauses apply as they do to delivery.
   */
  personaFor(workspaceId: string): WorkspacePersona {
    const a = this.pools.assignedPools<PersonaContent>(workspaceId, 'persona')[0];
    const assigned = this.pools.assignedPools<ContextContent>(workspaceId, 'context');
    const c = a?.content;
    return {
      workspaceId,
      persona: a ? { poolId: a.pool.id, name: a.pool.name, revision: a.pool.revision, description: this.#description(a.pool.id), avatar: this.#avatar(a.pool.id) } : null,
      contexts: this.contexts.sourcesFor(workspaceId, assigned).map((s) => ({ poolId: s.poolId, name: s.name, revision: s.revision, via: s.via })),
      parts: {
        instructionLines: c?.instructions ? c.instructions.split('\n').length : 0,
        styles: c?.styles.map((s) => s.name) ?? [],
        defaultStyle: c?.defaultStyle ?? null,
        agents: c?.agents.map((x) => x.name) ?? [],
        model: c?.model ?? null,
        effort: c?.effort ?? null,
        hasChatPrompt: !!c?.chatPrompt.trim(),
      },
    };
  }

  /**
   * I5: the chat prompt a session of this workspace appends to its system prompt (FR6, P5), or null. The
   * session runner passes `--append-system-prompt-file` with the delivered file when it exists; this is the
   * same text, for places that show it.
   */
  chatPrompt(workspaceId: string): string | null {
    const prompt = this.pools.assignedPools<PersonaContent>(workspaceId, 'persona')[0]?.content.chatPrompt.trim();
    return prompt ? prompt : null;
  }

  /**
   * T-490 (D-63): the model a role (an agent of the workspace's persona) runs on by its definition, or null when the persona has no such
   * agent or the agent sets none (`''`, `inherit`). What `session_spawn` starts a worker of that role on when its lead names no model.
   */
  roleModel(workspaceId: string, role: string): string | null {
    const agent = this.pools.assignedPools<PersonaContent>(workspaceId, 'persona')[0]?.content.agents.find((x) => x.name === role);
    const model = agent?.model?.trim() ?? '';
    return model && model !== 'inherit' ? model : null;
  }

  /** A persona's or context's revisions, newest first, without their content: the history. */
  revisions(poolId: string) {
    this.#historic(poolId);
    const db = this.store.db!;
    const current = (db.prepare('SELECT current_revision FROM pools WHERE id = ?').get(poolId) as { current_revision: number }).current_revision;
    const rows = db.prepare('SELECT revision, status, note, created_at FROM pool_revisions WHERE pool_id = ? ORDER BY revision DESC').all(poolId) as unknown as {
      revision: number;
      status: string;
      note: string;
      created_at: string;
    }[];
    return rows.map((r) => ({ revision: r.revision, status: r.status, note: r.note, createdAt: r.created_at, current: r.revision === current }));
  }

  /** One revision with its content, for a diff or a restore. Personas hold no secrets, so the content is shown as stored. */
  revision(poolId: string, revision: number) {
    this.#historic(poolId);
    const db = this.store.db!;
    const row = db.prepare('SELECT revision, status, note, created_at, content FROM pool_revisions WHERE pool_id = ? AND revision = ?').get(poolId, revision) as unknown as
      | { revision: number; status: string; note: string; created_at: string; content: string }
      | undefined;
    if (!row) throw new AppError('NOT_FOUND', `There’s no revision ${revision}.`);
    const current = (db.prepare('SELECT current_revision FROM pools WHERE id = ?').get(poolId) as { current_revision: number }).current_revision;
    return { revision: row.revision, status: row.status, note: row.note, createdAt: row.created_at, current: row.revision === current, content: JSON.parse(row.content) as PersonaContent | ContextContent };
  }

  #historic(poolId: string): void {
    const type = this.pools.typeOf(poolId);
    if (type !== 'persona' && type !== 'context') throw new AppError('NOT_FOUND', 'That pool no longer exists.');
    if (!this.store.db) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not available.');
  }

  #description(poolId: string): string {
    try {
      return this.pools.get(poolId).description;
    } catch {
      return '';
    }
  }

  #avatar(poolId: string): string | null {
    try {
      return this.identity.avatarUrl(this.identity.meta(poolId).avatar);
    } catch {
      return null;
    }
  }
}

/** A request body, at most `max` bytes: refused at the declared length, and again while reading. */
async function readCapped(req: Request, max: number): Promise<Buffer> {
  const tooBig = () => new AppError('PAYLOAD_TOO_LARGE', `The image is larger than ${max / 1024 / 1024} MB.`);
  if (Number(req.headers.get('content-length') ?? 0) > max) throw tooBig();
  const reader = req.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      void reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const STATUSES = new Set<PersonaProposalStatus>(['pending', 'approved', 'rejected', 'stale']);

/**
 * `/api/personas`: a workspace's persona and contexts, everyone's identity for lists, the default, one persona's
 * switches and avatar, proposals and their decisions, and revisions for history. Mounted behind the sign-in guard;
 * mutating requests pass the Origin check like every other route. Every decision is a person's: `Admin`.
 */
export function createPersonaRoutes(personas: Personas): Hono {
  const app = new Hono();
  const poolId = (id: string | undefined): string => {
    if (!id) throw new AppError('BAD_REQUEST', 'Name a persona.');
    return id;
  };

  app.get('/workspaces/:target/:name', (c) => {
    const target = c.req.param('target');
    const name = c.req.param('name');
    if (!target || !name) throw new AppError('BAD_REQUEST', 'Name a workspace.');
    return c.json(success(personas.personaFor(`${target}/${name}`)));
  });
  app.get('/identities', (c) => c.json(success(personas.identity.identities())));
  app.get('/pools', (c) => c.json(success(personas.identity.poolInfos())));

  app.get('/default', (c) => c.json(success({ poolId: personas.identity.defaultPool() })));
  app.put('/default', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { poolId?: unknown } | null;
    if (!body || (body.poolId !== null && typeof body.poolId !== 'string')) throw new AppError('VALIDATION_FAILED', 'Send `poolId`: a persona, or null.');
    personas.identity.setDefault(body.poolId);
    return c.json(success({ poolId: personas.identity.defaultPool() }));
  });

  app.get('/pools/:id/policy', (c) => c.json(success(personas.identity.policy(poolId(c.req.param('id')), personas.agentSelfEdit()))));
  app.put('/pools/:id/policy', async (c) => {
    const id = poolId(c.req.param('id'));
    const body = (await c.req.json().catch(() => null)) as { agentsMayPropose?: unknown; autoApproveCosmetic?: unknown } | null;
    if (!body || typeof body !== 'object') throw new AppError('VALIDATION_FAILED', 'Send the switches.');
    for (const k of ['agentsMayPropose', 'autoApproveCosmetic'] as const) if (body[k] !== undefined && typeof body[k] !== 'boolean') throw new AppError('VALIDATION_FAILED', `${k} is on or off.`);
    personas.identity.setPolicy(id, { agentsMayPropose: body.agentsMayPropose as boolean | undefined, autoApproveCosmetic: body.autoApproveCosmetic as boolean | undefined });
    return c.json(success(personas.identity.policy(id, personas.agentSelfEdit())));
  });

  // The avatar: the raw bytes of an image. It is decoded and re-encoded, so what is kept is the portal's PNG, not the upload.
  app.post('/pools/:id/avatar', async (c) => {
    const id = poolId(c.req.param('id'));
    const bytes = await readCapped(c.req.raw, PERSONA_AVATAR.inputBytes);
    const avatar = await normalizeAvatar(bytes);
    personas.identity.putAvatar(avatar);
    try {
      personas.identity.setAvatar(id, avatar.sha256);
    } catch (e) {
      // Not a persona (any more): the image kept for it goes again.
      personas.identity.collect();
      throw e;
    }
    return c.json(success({ avatar: personas.identity.avatarUrl(avatar.sha256) }));
  });
  app.delete('/pools/:id/avatar', (c) => {
    personas.identity.setAvatar(poolId(c.req.param('id')), null);
    return c.json(success({ avatar: null }));
  });
  app.get('/avatars/:sha', (c) => {
    const sha = c.req.param('sha');
    const png = personas.identity.avatarPng(sha);
    if (!png) throw new AppError('NOT_FOUND', 'No such image.');
    // Content-addressed, so it never changes; the policy and `nosniff` keep a browser from treating it as anything but a picture.
    return new Response(new Uint8Array(png), {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'private, max-age=31536000, immutable',
        etag: `"${sha}"`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  });

  app.get('/proposals', (c) => {
    const status = c.req.query('status');
    if (status !== undefined && !STATUSES.has(status as PersonaProposalStatus)) throw new AppError('BAD_REQUEST', 'Unknown status.');
    return c.json(success(personas.proposals.list({ poolId: c.req.query('pool') || undefined, status: status as PersonaProposalStatus | undefined })));
  });
  app.post('/proposals/:id/:verb', (c) => {
    const verb = c.req.param('verb');
    if (verb !== 'approve' && verb !== 'reject') throw new AppError('NOT_FOUND', 'No such action.');
    return c.json(success(personas.proposals.decide(c.req.param('id'), verb, 'Admin')));
  });

  app.get('/pools/:id/revisions', (c) => c.json(success(personas.revisions(poolId(c.req.param('id'))))));
  app.get('/pools/:id/revisions/:rev', (c) => {
    const n = Number(c.req.param('rev'));
    if (!Number.isInteger(n) || n < 1) throw new AppError('BAD_REQUEST', 'Revisions are numbered from 1.');
    return c.json(success(personas.revision(poolId(c.req.param('id')), n)));
  });
  return app;
}

/** Registers the persona and context types (index.ts): call before the reconciler starts. */
export function registerPersonas(deps: { store: Store; pools: PoolService }): Personas {
  return new Personas(deps.store, deps.pools);
}
