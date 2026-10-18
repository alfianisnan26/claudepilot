// The job-run Mac door (T-1083 S1b, D-84; authz in ./authz.ts).
//
// `createJobRunAdminRoutes`: `/api/jobrun/tokens` (list, mint, revoke) for an admin in the browser.
// `createJobRunDoor`: `/jobrun/mac/*` for `scripts/job-run.sh`, outside /api. Order on every request: the address's refusal bucket (429),
// the body (at most 64 KiB within 10 s: 413, 408), the `cpjr_` bearer, can(operate) on the token's workspace as its minting admin, then the
// token's own bucket (120 a minute, 429). Any refusal before the handler is the same 404 as a route that does not exist, and counts
// against the address. Nothing of the body, the bearer or a credential is logged or audited.
//
// S1b-1 has no Mac runtime: `runner` is absent, so the slot says `no-runtime`, a start is 503, and the list is empty. S1b-2 adds it.

import { AppError, success } from '@isnanme/core';
import {
  JOBRUN_DOOR_LIMITS,
  JOBRUN_MAC_SLOTS,
  actorString,
  platformRef,
  workspaceRef,
  type Actor,
  type JobRunMacRun,
  type JobRunSlot,
  type JobRunTokenCreate,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { actorOf, asUser, can, requireCan } from '../authz/seam.js';
import { config } from '../config.js';
import { readBody } from '../triggers/receiver.js';
import type { JobRunTokens } from './tokens.js';

const MAP_MAX = 10_000;
const LABEL = /^[\p{L}\p{N} ._:/-]{1,60}$/u;
const WORKSPACE_ID = /^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,64}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The workspace a token runs Jobs on, as the actor may see it; null when it does not exist or the actor may not view it. */
export type WorkspaceLookup = (id: string, actor: Actor) => Promise<{ id: string; status: string } | null>;

/** The Mac runtime (S1b-2). Every call is for one token: a run belongs to the token that started it. */
export interface MacRunner {
  /** Live runs on the Mac, all tokens: what the slot count reads. */
  liveCount(): number;
  list(tokenId: string): JobRunMacRun[];
  start(tokenId: string, workspaceId: string, body: unknown): Promise<JobRunMacRun>;
  /** The masked log of a run this token started, or null (unknown, or another token's). */
  log(tokenId: string, runId: string): Promise<Response | null>;
  /** Stops a run this token started; false when there is none. */
  stop(tokenId: string, runId: string): Promise<boolean>;
}

export interface JobRunAudit {
  record(e: { kind: string; actor: string; userId: string | null; subject?: string | null; detail?: Record<string, unknown>; severity?: 'info' | 'medium' }): void;
}

export interface JobRunDeps {
  tokens: JobRunTokens;
  workspace: WorkspaceLookup;
  runner?: MacRunner;
  audit?: JobRunAudit;
  clientAddress?(c: Context): string;
  now?: () => number;
}

const json = (c: Context, status: number, body: object, headers: Record<string, string> = {}) =>
  c.body(JSON.stringify(body), status as never, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
const notFound = (c: Context) => json(c, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
const tooMany = (c: Context, retryS: number) =>
  json(c, 429, { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }, { 'Retry-After': String(Math.max(1, Math.ceil(retryS))) });

const portalAddress = (c: Context): string => {
  const forwarded = config.trustProxy ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined;
  return forwarded || ((c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? 'unknown');
};

const safeAudit = (audit: JobRunAudit | undefined, e: Parameters<JobRunAudit['record']>[0]) => {
  try {
    audit?.record(e);
  } catch {
    // the audit never breaks the request
  }
};

/** `/api/jobrun`: mounted behind `requireSession` (the cookie) and the /api CSRF and body guards. Admin only (./authz.ts). */
export function createJobRunAdminRoutes(d: Pick<JobRunDeps, 'tokens' | 'workspace' | 'audit'>): Hono {
  const app = new Hono();
  app.get('/tokens', (c) => {
    requireCan(actorOf(c), 'manage', platformRef('targets'));
    return c.json(success({ items: d.tokens.list() }));
  });
  app.post('/tokens', async (c) => {
    const actor = actorOf(c);
    requireCan(actor, 'manage', platformRef('targets'));
    const body = (await c.req.json().catch(() => null)) as Partial<JobRunTokenCreate> | null;
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : '';
    if (!LABEL.test(label)) throw new AppError('VALIDATION_FAILED', 'Name the token (1 to 60 characters).', { details: { label: 'Name the token.' } });
    if (!WORKSPACE_ID.test(workspaceId)) throw new AppError('VALIDATION_FAILED', 'Pick the workspace that runs the Jobs.', { details: { workspaceId: 'Pick a workspace.' } });
    // The token acts as this admin on that workspace: they must be able to operate it now (and every call checks it again).
    if (!can(actor, 'operate', workspaceRef(workspaceId)).allow || !(await d.workspace(workspaceId, actor).catch(() => null)))
      throw new AppError('VALIDATION_FAILED', 'That workspace was not found.', { details: { workspaceId: 'Not found.' } });
    const userId = 'userId' in actor ? actor.userId : null;
    if (!userId) throw new AppError('UNAUTHORIZED', 'Sign in again.');
    const made = d.tokens.mint({ userId, workspaceId, label });
    if (!made) throw new AppError('SERVICE_UNAVAILABLE', 'The database is read-only.');
    safeAudit(d.audit, { kind: 'jobrun.token.create', actor: actorString(actor), userId, subject: `jobrun-token:${made.token.id}`, detail: { workspaceId, label }, severity: 'medium' });
    return c.json(success({ token: made.token, secret: made.secret }), 201);
  });
  app.delete('/tokens/:id', (c) => {
    const actor = actorOf(c);
    requireCan(actor, 'manage', platformRef('targets'));
    const id = c.req.param('id');
    if (!d.tokens.get(id)) throw new AppError('NOT_FOUND', 'Not found.');
    const revoked = d.tokens.revoke(id, 'revoked by an admin');
    if (revoked) safeAudit(d.audit, { kind: 'jobrun.token.revoke', actor: actorString(actor), userId: 'userId' in actor ? actor.userId : null, subject: `jobrun-token:${id}` });
    return c.json(success({ revoked }));
  });
  return app;
}

type Door = { tokenId: string; workspaceId: string; actor: Actor };

/** `/jobrun/mac`: the door job-run.sh calls with `Authorization: Bearer cpjr_…`. Not behind the cookie, the CSRF check or /api's guards. */
export function createJobRunDoor(d: JobRunDeps): Hono<{ Variables: { door: Door } }> {
  const app = new Hono<{ Variables: { door: Door } }>();
  const now = d.now ?? Date.now;
  const address = d.clientAddress ?? portalAddress;
  const refused = new Map<string, { at: number; n: number }>();
  const used = new Map<string, { at: number; n: number }>();
  const bodies = new WeakMap<Request, Buffer>();

  const bump = (m: Map<string, { at: number; n: number }>, key: string, at: number) => {
    const cur = m.get(key);
    const b = cur && at - cur.at < 60_000 ? cur : { at, n: 0 };
    b.n++;
    if (m.size > MAP_MAX) m.clear();
    m.set(key, b);
    return b;
  };

  app.use('*', async (c, next) => {
    const at = now();
    const addr = address(c).slice(0, 64);
    const rb = refused.get(addr);
    if (rb && at - rb.at < 60_000 && rb.n >= JOBRUN_DOOR_LIMITS.refusedMinute) return tooMany(c, (rb.at + 60_000 - at) / 1000);
    const refuse = () => {
      bump(refused, addr, at);
      return notFound(c);
    };

    const raw = await readBody(c.req.raw, JOBRUN_DOOR_LIMITS.bodyMaxBytes, JOBRUN_DOOR_LIMITS.bodyReadMs);
    if (raw === 'too_large') return json(c, 413, { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'That request is too large.' } }, { Connection: 'close' });
    if (raw === 'timeout') return json(c, 408, { ok: false, error: { code: 'TIMEOUT', message: 'The body took too long.' } }, { Connection: 'close' });
    bodies.set(c.req.raw, raw);

    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
    const v = d.tokens.verify(bearer);
    if (!v.ok) return refuse();
    const actor = asUser(v.userId, `jobrun:${v.tokenId}`);
    if (!can(actor, 'operate', workspaceRef(v.workspaceId)).allow) return refuse();

    const tb = bump(used, v.tokenId, at);
    if (tb.n > JOBRUN_DOOR_LIMITS.tokenMinute) return tooMany(c, (tb.at + 60_000 - at) / 1000);
    c.set('door', { tokenId: v.tokenId, workspaceId: v.workspaceId, actor });
    await next();
  });

  app.get('/slot', async (c) => {
    const door = c.get('door');
    const ws = await d.workspace(door.workspaceId, door.actor).catch(() => null);
    let answer: JobRunSlot;
    if (!ws || ws.status !== 'running') answer = { slot: false, reason: 'mac-not-running' };
    else if (!d.runner) answer = { slot: false, reason: 'no-runtime' };
    else {
      const free = JOBRUN_MAC_SLOTS - d.runner.liveCount();
      answer = free > 0 ? { slot: true, free } : { slot: false, reason: 'mac-full' };
    }
    return json(c, 200, { ok: true, data: answer });
  });

  app.get('/runs', (c) => json(c, 200, { ok: true, data: { items: d.runner?.list(c.get('door').tokenId) ?? [] } }));

  app.post('/runs', async (c) => {
    const door = c.get('door');
    let body: unknown;
    try {
      body = JSON.parse((bodies.get(c.req.raw) ?? Buffer.alloc(0)).toString('utf8'));
    } catch {
      return json(c, 400, { ok: false, error: { code: 'VALIDATION_FAILED', message: 'The body is not JSON.' } });
    }
    if (!d.runner) return json(c, 503, { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'No Mac runtime yet.' } });
    const run = await d.runner.start(door.tokenId, door.workspaceId, body);
    return json(c, 201, { ok: true, data: run });
  });

  app.get('/runs/:id/log', async (c) => {
    const id = c.req.param('id');
    const res = RUN_ID.test(id) && d.runner ? await d.runner.log(c.get('door').tokenId, id) : null;
    return res ?? notFound(c);
  });

  app.delete('/runs/:id', async (c) => {
    const id = c.req.param('id');
    const stopped = RUN_ID.test(id) && d.runner ? await d.runner.stop(c.get('door').tokenId, id) : false;
    return stopped ? json(c, 200, { ok: true, data: { stopped: true } }) : notFound(c);
  });

  app.notFound((c) => notFound(c));
  return app;
}
