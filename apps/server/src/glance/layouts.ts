// The Home and Glance layouts per person and org context (owner decision D-111 D6, 2026-11-01; docs/prd/glance-widgets.md §7, §18).
// Read this before changing who reads a layout.
//
// - A layout is the signed-in PERSON's (`actorUserId`), never another's: there is no user in the path or the body, so nobody reads or writes
//   someone else's. A token or an agent has no layout (refused): the layout is what a person arranged in the web app.
// - Per context: `?org=personal` (or nothing) or an org the person holds an active role in (an org's slug is taken for its id). Any other
//   org (left, suspended, never in, made up) is the 404 of a missing one, so a layout never says whether an org exists.
// - The body is the web client's settings object, stored as given (the client cleans it on read, glance/settings.ts and home/settings.ts) and
//   capped at LAYOUT_LIMITS.bytes. It holds widget ids and switches only: no secret, no object's content.
// - Table `user_layouts` (migration 910).

import { AppError, success } from '@isnanme/core';
import { LAYOUT_KINDS, LAYOUT_LIMITS, actorUserId, isOrgId, type Actor, type LayoutKind, type Layouts, type SaveLayoutRequest, type UserId } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { actorOf, declarePolicies, orgIdBySlug, orgRoleIn } from '../authz/seam.js';
import type { Store } from '../store/store.js';

const notFound = () => new AppError('NOT_FOUND', 'Not found.');
const isKind = (v: unknown): v is LayoutKind => typeof v === 'string' && (LAYOUT_KINDS as readonly string[]).includes(v);

export class LayoutStore {
  readonly #store: Store;
  readonly #now: () => Date;
  constructor(store: Store, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
  }

  /** The person behind `actor` (a person signed in to the web app), or the refusal. */
  #person(actor: Actor): UserId {
    const userId = actorUserId(actor);
    if (actor.kind !== 'user' || !userId) throw new AppError('FORBIDDEN', 'Layouts belong to a person signed in to the portal.');
    return userId;
  }

  /** The context key: 'personal', or an org id the person is in; else the missing 404. */
  context(actor: Actor, raw: string | undefined): string {
    const userId = this.#person(actor);
    if (raw === undefined || raw === '' || raw === 'personal') return 'personal';
    const value = raw.slice(0, 100);
    const id = isOrgId(value) ? value : orgIdBySlug(value.toLowerCase());
    if (!id || !orgRoleIn(id, userId)) throw notFound();
    return id;
  }

  get(actor: Actor, rawContext: string | undefined): Layouts {
    const userId = this.#person(actor);
    const context = this.context(actor, rawContext);
    const out: Layouts = { glance: null, home: null };
    const db = this.#store.db;
    if (!db) return out;
    const rows = db.prepare('SELECT kind, body FROM user_layouts WHERE user_id = ? AND context = ?').all(userId, context) as { kind: string; body: string }[];
    for (const r of rows) {
      if (!isKind(r.kind)) continue;
      try {
        const v = JSON.parse(r.body) as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) out[r.kind] = v as Record<string, unknown>;
      } catch {
        // a row that is not JSON reads as none
      }
    }
    return out;
  }

  save(actor: Actor, rawContext: string | undefined, kind: unknown, req: Partial<SaveLayoutRequest>): { saved: true } {
    const userId = this.#person(actor);
    if (!isKind(kind)) throw notFound();
    const context = this.context(actor, rawContext);
    const layout = req?.layout;
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)) throw new AppError('VALIDATION_FAILED', 'Send the layout as an object.', { details: { layout: 'An object.' } });
    const body = JSON.stringify(layout);
    if (Buffer.byteLength(body, 'utf8') > LAYOUT_LIMITS.bytes) throw new AppError('VALIDATION_FAILED', 'That layout is too large.', { details: { layout: 'Too large.' } });
    const db = this.#store.writable ? this.#store.db : null;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    db.prepare(
      `INSERT INTO user_layouts (user_id, context, kind, body, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, context, kind) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
    ).run(userId, context, kind, body, this.#now().toISOString());
    return { saved: true };
  }
}

/** The routes are the person's own (`self`): no object, the signed-in person's rows only. */
export function declareLayoutPolicies(): void {
  declarePolicies('glance', {
    'GET /api/layouts': { kind: 'self' },
    'PUT /api/layouts/:kind': { kind: 'self' },
  });
}

async function body(c: Context): Promise<Partial<SaveLayoutRequest>> {
  try {
    const v: unknown = await c.req.json();
    return v && typeof v === 'object' ? (v as Partial<SaveLayoutRequest>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

/** `/api/layouts` (app.ts mounts it under the session guard). */
export function createLayoutRoutes(layouts: LayoutStore): Hono {
  declareLayoutPolicies();
  const r = new Hono();
  r.get('/', (c) => c.json(success(layouts.get(actorOf(c), c.req.query('org')))));
  r.put('/:kind', async (c) => c.json(success(layouts.save(actorOf(c), c.req.query('org'), c.req.param('kind'), await body(c)))));
  return r;
}
