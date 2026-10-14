// `/api/notify` (docs/prd/web-app-pwa.md §11.8, `NOTIFY_API`). Mounted behind the session guard and the Origin check like the rest of
// `/api`. Who is asking is read ONCE per request (`owner.actorOf(c)`), never from a body or a header; every list, count and change is the
// caller's own, and another user's id answers like an unknown one. JSON bodies at most 4 KB, `act` at most 1 KB. No route returns a URL,
// an endpoint, a key or a signing secret (a new signing secret once, when it is made).

import { AppError, defineErrorCodes, success } from '@isnanme/core';
import { isMuteGuarded, REAUTH_REQUIRED, type CreateMuteRequest, type NotifyMute, type NotifyOverview, type NotifyUserPrefs, type QuotaWatchRequest, type QuotaWatchState, type SessionNotifyRequest } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PlatformAudit } from '../platform/audit.js';
import type { PlatformOwner } from '../platform/owner.js';
import type { NotifyActions } from './actions.js';
import type { Destinations } from './destinations.js';
import type { NotifyHistory } from './history.js';
import type { NotifyMutes } from './mutes.js';
import type { NotifyPipeline } from './pipeline.js';
import type { NotifyKeys } from './vapid.js';

// The chat's code, registered here too so this module answers it on its own (the same spec: re-registering keeps it as it is).
defineErrorCodes({ [REAUTH_REQUIRED]: { status: 403, message: 'Enter the server code again.' } });

export interface NotifyRouteDeps {
  owner: PlatformOwner;
  destinations: Destinations;
  history: NotifyHistory;
  mutes: NotifyMutes;
  pipeline: NotifyPipeline;
  actions: NotifyActions;
  keys: NotifyKeys;
  audit: PlatformAudit;
  ceiling: () => boolean;
  baseUrl: () => string | null;
  /** A session by id (the chat controller), for "Notify when done". */
  session: (id: string) => { id: string } | null;
  /** Whether this sign-in checked the server code recently (rotating a signing secret needs it). */
  reauthFresh: (signIn: string | undefined) => boolean;
  publish: () => void;
}

const limit = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (c) => {
      const e = new AppError('PAYLOAD_TOO_LARGE', 'That request is too large.');
      return c.json(e.toJSON(), 413);
    },
  });

async function body<T>(c: Context): Promise<Partial<T>> {
  let v: unknown;
  try {
    v = await c.req.json();
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AppError('BAD_REQUEST', 'Expected a JSON object.');
  return v as Partial<T>;
}

export function createNotifyRoutes(d: NotifyRouteDeps): Hono {
  const r = new Hono();
  r.use('/act', limit(1024));
  r.use('*', limit(4 * 1024));

  /** The caller, signed in (the guard ran first). */
  const who = (c: Context) => {
    const a = d.owner.actorOf(c);
    if (!a.userId) throw new AppError('UNAUTHORIZED', 'Sign in again.');
    return { ...a, userId: a.userId };
  };
  const signIn = (c: Context) => (c.get('token' as never) as string | undefined) ?? '';

  r.get('/', (c) => {
    const a = who(c);
    const policy = d.destinations.prefs(a.userId);
    const ceiling = d.ceiling();
    const overview: NotifyOverview = {
      state: d.pipeline.state(),
      vapidPublicKey: d.keys.keys()?.publicKey.toString('base64url') ?? d.keys.publicKey(),
      baseUrl: d.baseUrl(),
      destinations: d.destinations.list(a.userId),
      policy: ceiling ? policy : { deny: false, allowRead: false, allowEdit: false, allowCommand: false },
      actionsCeiling: ceiling,
      unread: d.history.unread(a.userId),
    };
    return c.json(success(overview));
  });

  r.get('/prefs', (c) => c.json(success<NotifyUserPrefs>(d.destinations.prefs(who(c).userId))));
  r.put('/prefs', async (c) => {
    const a = who(c);
    const req = await body<NotifyUserPrefs>(c);
    const was = d.destinations.prefs(a.userId);
    const next = { ...was };
    for (const k of ['deny', 'allowRead', 'allowEdit', 'allowCommand'] as const) {
      if (req[k] === undefined) continue;
      if (typeof req[k] !== 'boolean') throw new AppError('VALIDATION_FAILED', 'On or off.', { details: { [k]: 'On or off.' } });
      next[k] = req[k];
    }
    const turnedOn = (['allowRead', 'allowEdit', 'allowCommand'] as const).filter((k) => next[k] && !was[k]);
    if (turnedOn.length && req.confirm !== true) throw new AppError('CONFIRMATION_REQUIRED', 'Confirm: this lets a tap on a notification allow it.', { details: { turnedOn } });
    const saved = d.destinations.setPrefs(a.userId, next);
    d.audit.record({ kind: 'notify.prefs', severity: turnedOn.length ? 'medium' : 'info', actor: a.label, userId: a.userId, detail: { ...saved } });
    d.publish();
    return c.json(success<NotifyUserPrefs>(saved));
  });

  r.post('/push', async (c) => {
    const a = who(c);
    const req = await body<{ subscription: unknown; name: unknown; tz: unknown }>(c);
    const { destination, movedFrom } = d.destinations.registerPush(a.userId, req as never);
    if (movedFrom) d.audit.record({ kind: 'notify.device_moved', actor: a.label, userId: movedFrom, subject: `destination:${destination.id}`, detail: { destination: destination.id } });
    d.publish();
    return c.json(success(destination));
  });

  r.get('/destinations', (c) => c.json(success(d.destinations.list(who(c).userId))));
  r.post('/destinations', async (c) => {
    const a = who(c);
    const created = d.destinations.createChannel(a.userId, await body(c));
    d.audit.record({ kind: 'notify.channel', actor: a.label, userId: a.userId, subject: `destination:${created.destination.id}`, detail: { action: 'created', type: created.destination.type, host: created.destination.hint, signed: created.destination.signed, privateNetwork: created.destination.allowPrivateNetwork } });
    d.publish();
    return c.json(success(created));
  });
  r.patch('/destinations/:id', async (c) => {
    const a = who(c);
    const updated = d.destinations.update(c.req.param('id'), a.userId, await body(c));
    d.publish();
    return c.json(success(updated));
  });
  r.delete('/destinations/:id', (c) => {
    const a = who(c);
    const id = c.req.param('id');
    const dest = d.destinations.get(id, a.userId);
    d.destinations.remove(id, a.userId);
    d.audit.record({ kind: 'notify.channel', actor: a.label, userId: a.userId, subject: `destination:${id}`, detail: { action: 'removed', type: dest.type } });
    d.publish();
    return c.json(success({ ok: true }));
  });
  r.post('/destinations/:id/test', async (c) => {
    const a = who(c);
    const id = c.req.param('id');
    const result = await d.pipeline.test(id, a.userId);
    d.audit.record({ kind: 'notify.test', actor: a.label, userId: a.userId, subject: `destination:${id}`, detail: { ok: result.ok, error: result.error } });
    return c.json(success(result));
  });
  r.post('/destinations/:id/secret', (c) => {
    const a = who(c);
    const id = c.req.param('id');
    d.destinations.get(id, a.userId); // 404 first: another user's id is unknown, re-check or not
    if (!d.reauthFresh(signIn(c))) throw new AppError(REAUTH_REQUIRED, 'Enter the server code again.');
    const signingSecret = d.destinations.rotateSecret(id, a.userId);
    d.audit.record({ kind: 'notify.channel', severity: 'medium', actor: a.label, userId: a.userId, subject: `destination:${id}`, detail: { action: 'secret_rotated' } });
    return c.json(success({ signingSecret }));
  });

  r.get('/log', (c) => {
    const n = Number(c.req.query('limit'));
    return c.json(success(d.history.deliveries(who(c).userId, { destination: c.req.query('destination') || undefined, limit: Number.isFinite(n) && n > 0 ? n : undefined })));
  });
  r.get('/history', (c) => {
    const n = Number(c.req.query('limit'));
    return c.json(success(d.history.page(who(c).userId, { before: c.req.query('before') || undefined, limit: Number.isFinite(n) && n > 0 ? n : undefined, muted: c.req.query('muted') === '1' })));
  });
  r.post('/history/read', async (c) => {
    const a = who(c);
    const req = c.req.header('content-type')?.includes('json') ? await body<{ upTo: string }>(c) : {};
    const unread = d.history.markRead(a.userId, typeof req.upTo === 'string' ? req.upTo : null);
    d.publish();
    return c.json(success({ unread }));
  });
  r.delete('/history', (c) => {
    d.history.clear(who(c).userId);
    d.publish();
    return c.json(success({ ok: true }));
  });

  // Mute rules ("Mute similar"): the caller's own; another user's rule or Inbox item answers like an unknown one. Create and delete audit.
  const muteAudit = (a: ReturnType<typeof who>, action: string, m: NotifyMute | null, extra: Record<string, unknown> = {}) =>
    d.audit.record({
      kind: 'notify.mute',
      // A rule on an approval or a deploy wait hushes something that blocks: worth a second look.
      severity: m && isMuteGuarded(m.kind) ? 'medium' : 'info',
      actor: a.label,
      userId: a.userId,
      subject: m ? `mute:${m.id}` : null,
      detail: { action, ...(m ? { kind: m.kind, scope: m.scope ? `${m.scope.type}:${m.scope.id}` : null, destination: m.destinationId, expiresAt: m.expiresAt } : {}), ...extra },
    });
  r.get('/mutes', (c) => c.json(success(d.mutes.list(who(c).userId))));
  r.get('/mutes/offer/:ref', (c) => c.json(success(d.mutes.offer(who(c).userId, c.req.param('ref')))));
  r.post('/mutes', async (c) => {
    const a = who(c);
    const m = d.mutes.create(a.userId, await body<CreateMuteRequest>(c));
    muteAudit(a, 'created', m);
    d.publish();
    return c.json(success(m));
  });
  r.delete('/mutes/:id', (c) => {
    const a = who(c);
    const m = d.mutes.remove(a.userId, c.req.param('id'));
    muteAudit(a, 'removed', m);
    d.publish();
    return c.json(success({ ok: true }));
  });
  r.delete('/mutes', (c) => {
    const a = who(c);
    const removed = d.mutes.clear(a.userId);
    muteAudit(a, 'cleared', null, { removed });
    d.publish();
    return c.json(success({ removed }));
  });

  // "Notify when done": reading it needs `view` on the session, changing it `operate`; an unknown or foreign session is 404.
  const sessionFor = (c: Context, userId: string, verb: 'view' | 'operate') => {
    const id = c.req.param('id') ?? '';
    const s = /^[A-Za-z0-9_-]{1,100}$/.test(id) ? d.session(id) : null;
    if (!s || !d.owner.can(userId, 'view', { type: 'session', id: s.id })) throw new AppError('NOT_FOUND', 'No such session.');
    if (!d.owner.can(userId, verb, { type: 'session', id: s.id })) throw new AppError('FORBIDDEN', 'You can’t do that here.');
    return s.id;
  };
  r.get('/sessions/:id', (c) => {
    const a = who(c);
    return c.json(success({ done: d.destinations.sessionDone(sessionFor(c, a.userId, 'view'), a.userId) }));
  });
  r.put('/sessions/:id', async (c) => {
    const a = who(c);
    const id = sessionFor(c, a.userId, 'operate');
    const req = await body<SessionNotifyRequest>(c);
    if (typeof req.done !== 'boolean') throw new AppError('VALIDATION_FAILED', 'On or off.', { details: { done: 'On or off.' } });
    d.destinations.setSessionDone(id, a.userId, req.done);
    return c.json(success({ done: req.done }));
  });

  // T-126 item 1: "Alert when idle" for one Claude, the caller's own; a Claude they may not see answers like an unknown one.
  const claudeFor = (c: Context, userId: string) => {
    const id = c.req.param('claudeId') ?? '';
    if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(id) || !d.owner.can(userId, 'view', { type: 'claude', id })) throw new AppError('NOT_FOUND', 'No such Claude.');
    return id;
  };
  r.get('/quota-watch/:claudeId', (c) => {
    const a = who(c);
    const state: QuotaWatchState = { watch: d.history.watches(a.userId, claudeFor(c, a.userId)) };
    return c.json(success(state));
  });
  r.put('/quota-watch/:claudeId', async (c) => {
    const a = who(c);
    const id = claudeFor(c, a.userId);
    const req = await body<QuotaWatchRequest>(c);
    if (typeof req.watch !== 'boolean') throw new AppError('VALIDATION_FAILED', 'On or off.', { details: { watch: 'On or off.' } });
    d.history.setWatch(a.userId, id, req.watch);
    const state: QuotaWatchState = { watch: req.watch };
    return c.json(success(state));
  });

  r.post('/act', async (c) => {
    const a = who(c);
    const req = await body<{ token: string; decision: string }>(c);
    const result = await d.actions.act({ userId: a.userId, actor: a.label, signIn: signIn(c), token: req.token, decision: req.decision });
    d.publish();
    return c.json(success(result));
  });

  return r;
}
