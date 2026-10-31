// `/api/triggers` (docs/prd/triggers.md §14, `TRIGGER_API`). Mounted behind the session guard and the Origin check. Who is asking is read
// ONCE per request through the platform's owner adapter, never from a body or a header; a trigger the caller may not view answers like an
// unknown id (404), one they may view but not change answers 403. A trigger's owner is the signed-in user who made it; its runs act with
// that owner's rights. Rotating a secret or the receiver address needs the server code again. JSON bodies at most 32 KB.

import { AppError, defineErrorCodes, success } from '@isnanme/core';
import { REAUTH_REQUIRED, TRIGGER_RUN_STATES, type TriggerEventFacts, type TriggerRunPage, type TriggerRunState } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PlatformAudit } from '../platform/audit.js';
import type { PlatformOwner } from '../platform/owner.js';
import type { TriggerRunner } from './runner.js';
import { scheduleFacts } from './scheduler.js';
import type { TriggerService } from './service.js';
import type { TriggerRecord } from './store.js';

defineErrorCodes({ [REAUTH_REQUIRED]: { status: 403, message: 'Enter the server code again.' } });

export interface TriggerRouteDeps {
  owner: PlatformOwner;
  service: TriggerService;
  runner: TriggerRunner;
  audit: PlatformAudit;
  reauthFresh(signIn: string | undefined): boolean;
  publish(): void;
  now?: () => Date;
}

async function body(c: Context): Promise<Record<string, unknown>> {
  let v: unknown;
  try {
    v = await c.req.json();
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AppError('BAD_REQUEST', 'Expected a JSON object.');
  return v as Record<string, unknown>;
}

const optionalBody = async (c: Context): Promise<Record<string, unknown>> => ((c.req.header('content-length') ?? '0') === '0' && !c.req.header('transfer-encoding') ? {} : body(c));

/** A manual event (Run now): a schedule's for cron, a bare one for CI (the limits and approval apply as to any fire). */
export function manualFacts(t: TriggerRecord, at: string): TriggerEventFacts {
  if (t.source === 'cron') return scheduleFacts(at);
  return { ...scheduleFacts(at), source: 'ci_failed', event: 'ci_failed' };
}

export function createTriggerRoutes(d: TriggerRouteDeps): Hono {
  const r = new Hono();
  r.use(
    '*',
    bodyLimit({
      maxSize: 32 * 1024,
      onError: (c) => c.json(new AppError('PAYLOAD_TOO_LARGE', 'That request is too large.').toJSON(), 413),
    }),
  );
  const who = (c: Context) => {
    const a = d.owner.actorOf(c);
    if (!a.userId) throw new AppError('UNAUTHORIZED', 'Sign in again.');
    return { ...a, userId: a.userId };
  };
  const signIn = (c: Context) => (c.get('token' as never) as string | undefined) ?? '';
  /** The trigger, when the caller holds `verb` on it: 404 when they may not even view it (no existence leak), 403 otherwise. */
  const need = (c: Context, verb: 'view' | 'operate' | 'manage') => {
    const a = who(c);
    const id = c.req.param('id') ?? '';
    const t = d.service.store.get(id);
    const subject = { type: 'trigger' as const, id };
    if (!t || !d.owner.can(a.userId, 'view', subject)) throw new AppError('NOT_FOUND', 'No such trigger.');
    if (verb !== 'view' && !d.owner.can(a.userId, verb, subject)) throw new AppError('FORBIDDEN', 'You can’t do that to this trigger.');
    return { a, t };
  };
  const needRun = (c: Context, verb: 'view' | 'operate') => {
    const x = need(c, verb);
    const row = d.service.store.runRow(c.req.param('runId') ?? '');
    if (!row || row.trigger_id !== x.t.id) throw new AppError('NOT_FOUND', 'No such run.');
    return { ...x, row };
  };
  /** The workspace a trigger acts on must be one the owner may operate, when it is made or moved (and again at every run). */
  const mayUse = (userId: string, input: Record<string, unknown>) => {
    const ws = (input.action as { workspaceId?: unknown } | undefined)?.workspaceId;
    if (typeof ws === 'string' && !d.owner.can(userId, 'operate', { type: 'workspace', id: ws })) throw new AppError('VALIDATION_FAILED', 'Pick a workspace you can use.', { details: { 'action.workspaceId': 'Not one you can use.' } });
  };
  const audit = (kind: string, a: { label: string; userId: string }, t: { id: string; ownerId: string }, detail: Record<string, unknown> = {}) =>
    d.audit.record({ kind, actor: a.label, userId: t.ownerId, subject: `trigger:${t.id}`, severity: kind === 'trigger.secret_rotated' || kind === 'trigger.deleted' ? 'medium' : 'info', detail: { triggerId: t.id, ...detail } });
  const runPage = (rows: ReturnType<TriggerService['store']['runs']>, names: Map<string, string>): TriggerRunPage => ({
    items: rows.rows.map((row) => d.service.store.view(row, names.get(row.trigger_id) ?? 'Deleted trigger')),
    next: rows.next,
  });
  const pageArgs = (c: Context) => {
    const state = c.req.query('state');
    const limit = Number(c.req.query('limit') ?? 50);
    const before = c.req.query('before');
    return {
      state: state && TRIGGER_RUN_STATES.includes(state as TriggerRunState) ? (state as TriggerRunState) : undefined,
      limit: Number.isFinite(limit) ? limit : 50,
      before: before && before.length <= 40 ? before : undefined,
    };
  };
  const visibleTriggers = (userId: string) => d.service.store.list(userId).filter((t) => d.owner.can(userId, 'view', { type: 'trigger', id: t.id }));

  r.get('/', (c) => {
    const a = who(c);
    return c.json(success(visibleTriggers(a.userId).map((t) => d.service.view(t))));
  });

  r.post('/', async (c) => {
    const a = who(c);
    const input = await body(c);
    mayUse(a.userId, input);
    const made = d.service.create(a.userId, a.userId, input);
    audit('trigger.created', a, made.record, { source: made.record.source });
    d.publish();
    return c.json(success(d.service.created(made)), 201);
  });

  r.post('/preview', async (c) => {
    who(c);
    const input = await body(c);
    const w = d.service.validate(input, null);
    return c.json(success(d.service.test({ ...w }, input.sample)));
  });

  r.get('/runs', (c) => {
    const a = who(c);
    const p = pageArgs(c);
    const triggerId = c.req.query('trigger');
    const names = new Map(visibleTriggers(a.userId).map((t) => [t.id, t.name]));
    if (triggerId && !names.has(triggerId)) return c.json(success({ items: [], next: null } satisfies TriggerRunPage));
    return c.json(success(runPage(d.service.store.runs({ ownerId: a.userId, triggerId: triggerId || undefined, ...p }), names)));
  });

  r.get('/:id', (c) => c.json(success(d.service.view(need(c, 'view').t))));

  r.patch('/:id', async (c) => {
    const { a, t } = need(c, 'manage');
    const input = await body(c);
    mayUse(a.userId, input);
    const next = d.service.update(t, input);
    audit('trigger.updated', a, next, { enabled: next.enabled, approval: next.approval.mode });
    d.publish();
    return c.json(success(d.service.view(next)));
  });

  r.delete('/:id', (c) => {
    const { a, t } = need(c, 'manage');
    d.service.remove(t);
    audit('trigger.deleted', a, t);
    d.publish();
    return c.json(success({ ok: true }));
  });

  r.post('/:id/run', async (c) => {
    const { a, t } = need(c, 'operate');
    if (t.source === 'webhook') throw new AppError('CONFLICT', 'A webhook trigger runs on its events: use Test, or the Git host’s test delivery.');
    const res = await d.runner.fire(t, { facts: manualFacts(t, (d.now ?? (() => new Date()))().toISOString()), actor: a.label, unfiltered: true });
    if (res.kind !== 'run') throw new AppError('SERVICE_UNAVAILABLE', 'Nothing was started: the portal is not accepting runs now.');
    return c.json(success(res.run));
  });

  r.post('/:id/test', async (c) => {
    const { t } = need(c, 'operate');
    const input = await optionalBody(c);
    return c.json(success(d.service.test(t, input.sample)));
  });

  r.get('/:id/runs', (c) => {
    const { t } = need(c, 'view');
    return c.json(success(runPage(d.service.store.runs({ ownerId: null, triggerId: t.id, ...pageArgs(c) }), new Map([[t.id, t.name]]))));
  });

  r.get('/:id/runs/:runId', (c) => {
    const { t, row } = needRun(c, 'view');
    return c.json(success(d.service.store.view(row, t.name)));
  });

  r.post('/:id/runs/:runId/approve', async (c) => {
    const { a, t, row } = needRun(c, 'operate');
    if (row.state !== 'pending_approval') throw new AppError('CONFLICT', 'This run is not waiting for approval.');
    const run = await d.runner.approve(t, row.id, a.label);
    if (!run) throw new AppError('CONFLICT', 'This run was already answered.');
    return c.json(success(run));
  });

  r.post('/:id/runs/:runId/skip', (c) => {
    const { a, t, row } = needRun(c, 'operate');
    if (!d.runner.skip(t, row.id, a.label)) throw new AppError('CONFLICT', 'This run is not waiting for approval.');
    return c.json(success(d.service.store.view(d.service.store.runRow(row.id)!, t.name)));
  });

  r.post('/:id/runs/:runId/stop', (c) => {
    const { a, t, row } = needRun(c, 'operate');
    if (!d.runner.stopRun(t, row.id, a.label, null)) throw new AppError('CONFLICT', 'This run is not running.');
    return c.json(success(d.service.store.view(d.service.store.runRow(row.id)!, t.name)));
  });

  /** The rotations: manage, then the server code again. The 404 comes first, so another user's id is unknown with or without the code. */
  const fresh = (c: Context) => {
    if (!d.reauthFresh(signIn(c))) throw new AppError(REAUTH_REQUIRED, 'Enter the server code again.');
  };

  r.post('/:id/secret', (c) => {
    const { a, t } = need(c, 'manage');
    fresh(c);
    const secret = d.service.rotateSecret(t);
    audit('trigger.secret_rotated', a, t, { what: 'secret' });
    d.publish();
    return c.json(success({ secret }));
  });

  r.put('/:id/secret', async (c) => {
    const { a, t } = need(c, 'manage');
    fresh(c);
    const input = await body(c);
    const next = d.service.setProvidedSecret(t, input.secret);
    audit('trigger.secret_rotated', a, t, { what: 'signing_token' });
    d.publish();
    return c.json(success(d.service.view(next)));
  });

  r.post('/:id/url', (c) => {
    const { a, t } = need(c, 'manage');
    fresh(c);
    const next = d.service.rotateUrl(t);
    audit('trigger.secret_rotated', a, t, { what: 'url' });
    d.publish();
    return c.json(success(d.service.view(next)));
  });

  return r;
}
