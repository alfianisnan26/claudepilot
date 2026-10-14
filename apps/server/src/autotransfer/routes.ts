// `/api/autotransfer` (docs/prd/auto-transfer.md §11, `AUTOTRANSFER_API`), mounted behind the session guard and the Origin check. Who is
// asking is read ONCE per request (`owner.actorOf(c)`), never from a body or a header. A user sees and changes only their own choices,
// their own Claudes' settings, chats they may view (operate to change), their own cards and their own trail; an id of another user answers
// like an unknown one. JSON bodies at most 4 KB.

import { AppError, success } from '@isnanme/core';
import {
  AUTO_BOUNDS,
  AUTO_EVENT_KINDS,
  AUTO_MODES,
  type AutoEventKind,
  type AutoClaudeConfig,
  type AutoMode,
  type AutoUserPrefs,
  type ClaudeUsage,
  type SetAutoSessionRequest,
  type UpdateAutoClaudeRequest,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PlatformAudit } from '../platform/audit.js';
import type { PlatformOwner } from '../platform/owner.js';
import type { AutoTransferEngine } from './engine.js';
import type { ChatPort, UsagePort } from './ports.js';
import { effectiveSettings, platformSettings, type AutoSettingsReader } from './settings.js';
import type { AutoStore } from './store.js';

export interface AutoRouteDeps {
  owner: PlatformOwner;
  engine: AutoTransferEngine;
  store: AutoStore;
  chat: ChatPort;
  usage: UsagePort;
  settings: AutoSettingsReader | null;
  audit: PlatformAudit | null;
  publish: () => void;
}

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

const ID = /^[A-Za-z0-9_./:-]{1,120}$/;
const bad = (field: string, msg: string) => new AppError('VALIDATION_FAILED', msg, { details: { [field]: msg } });

function threshold(v: unknown, field = 'thresholdPct'): number | null {
  if (v === null) return null;
  const b = AUTO_BOUNDS.thresholdPct;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < b.min || v > b.max) throw bad(field, `A whole number from ${b.min} to ${b.max}.`);
  return v;
}
const flag = (v: unknown, field: string): boolean | null => {
  if (v === null || typeof v === 'boolean') return v;
  throw bad(field, 'On, off or default.');
};
const mode = (v: unknown, field = 'mode'): AutoMode | null => {
  if (v === null || (AUTO_MODES as readonly unknown[]).includes(v)) return v as AutoMode | null;
  throw bad(field, 'Off, ask, auto or default.');
};

export function createAutoTransferRoutes(d: AutoRouteDeps): Hono {
  const r = new Hono();
  r.use(
    '*',
    bodyLimit({
      maxSize: 4 * 1024,
      onError: (c) => c.json(new AppError('PAYLOAD_TOO_LARGE', 'That request is too large.').toJSON(), 413),
    }),
  );

  const who = (c: Context) => {
    const a = d.owner.actorOf(c);
    if (!a.userId) throw new AppError('UNAUTHORIZED', 'Sign in again.');
    return { ...a, userId: a.userId };
  };

  /** The Claudes the user may use, from the usage snapshot (never a probe). */
  const claudesOf = async (userId: string): Promise<ClaudeUsage[]> => (await d.usage.report({ actorId: userId })).claudes;
  const config = (userId: string, c: ClaudeUsage): AutoClaudeConfig => {
    const own = d.store.claude(userId, c.claudeId);
    return { claudeId: c.claudeId, claudeName: c.claudeName, workspaceId: c.workspaceId, thresholdPct: own.thresholdPct, destinations: own.destinations };
  };

  r.get('/', async (c) => {
    const a = who(c);
    const platform = platformSettings(d.settings);
    const prefs = d.store.prefs(a.userId);
    const claudes = (await claudesOf(a.userId)).filter((x) => x.runsOn !== 'pool');
    return c.json(success({ platform, prefs, effective: effectiveSettings(platform, prefs), claudes: claudes.map((x) => config(a.userId, x)) }));
  });

  r.put('/prefs', async (c) => {
    const a = who(c);
    const req = await body<AutoUserPrefs>(c);
    const next: AutoUserPrefs = { ...d.store.prefs(a.userId) };
    if (req.mode !== undefined) next.mode = mode(req.mode);
    if (req.thresholdPct !== undefined) next.thresholdPct = threshold(req.thresholdPct);
    if (req.useProjection !== undefined) next.useProjection = flag(req.useProjection, 'useProjection');
    if (req.sameModelOnly !== undefined) next.sameModelOnly = flag(req.sameModelOnly, 'sameModelOnly');
    if (req.allowApiKey !== undefined) next.allowApiKey = flag(req.allowApiKey, 'allowApiKey');
    const prefs = d.store.setPrefs(a.userId, next);
    d.audit?.record({ kind: 'autotransfer.prefs', actor: a.label, userId: a.userId, detail: { ...prefs } });
    d.publish();
    return c.json(success({ prefs, effective: effectiveSettings(platformSettings(d.settings), prefs) }));
  });

  r.put('/claudes/:claudeId', async (c) => {
    const a = who(c);
    const id = c.req.param('claudeId');
    const all = await claudesOf(a.userId);
    const claude = ID.test(id) ? all.find((x) => x.claudeId === id) : undefined;
    if (!claude || !d.owner.can(a.userId, 'operate', { type: 'claude', id, workspaceId: claude.workspaceId })) throw new AppError('NOT_FOUND', 'No such Claude.');
    const req = await body<UpdateAutoClaudeRequest>(c);
    const was = d.store.claude(a.userId, id);
    const next = { ...was };
    if (req.thresholdPct !== undefined) next.thresholdPct = threshold(req.thresholdPct);
    if (req.destinations !== undefined) {
      if (!Array.isArray(req.destinations) || req.destinations.length > 10) throw bad('destinations', 'At most 10 Claudes.');
      const sameWs = new Set(all.filter((x) => x.workspaceId === claude.workspaceId && x.claudeId !== id).map((x) => x.claudeId));
      const seen = new Set<string>();
      for (const x of req.destinations) {
        if (typeof x !== 'string' || !sameWs.has(x) || seen.has(x)) throw bad('destinations', 'Pick other Claudes of the same workspace, each once.');
        seen.add(x);
      }
      next.destinations = [...seen];
    }
    d.store.setClaude(a.userId, id, next);
    d.audit?.record({ kind: 'autotransfer.claude', actor: a.label, userId: a.userId, subject: `claude:${id}`, detail: { thresholdPct: next.thresholdPct, destinations: next.destinations } });
    d.publish();
    return c.json(success(config(a.userId, claude)));
  });

  // A chat: reading needs `view`, changing `operate`; an unknown or foreign chat is 404.
  const sessionFor = (c: Context, userId: string, verb: 'view' | 'operate') => {
    const id = c.req.param('id') ?? '';
    const s = /^[A-Za-z0-9_-]{1,100}$/.test(id) ? d.chat.get(id) : null;
    if (!s || !d.owner.can(userId, 'view', { type: 'session', id: s.id })) throw new AppError('NOT_FOUND', 'No such session.');
    if (!d.owner.can(userId, verb, { type: 'session', id: s.id })) throw new AppError('FORBIDDEN', 'You can’t do that here.');
    return s.id;
  };
  // What the engine waits for, per live chat the caller may view (T-105 item 5): the engine filters by `can(view)`.
  r.get('/state', async (c) => {
    const a = who(c);
    return c.json(success(await d.engine.engineState(a.userId)));
  });
  r.get('/sessions/:id', async (c) => {
    const a = who(c);
    return c.json(success(await d.engine.state(sessionFor(c, a.userId, 'view'), a.userId)));
  });
  r.put('/sessions/:id', async (c) => {
    const a = who(c);
    const id = sessionFor(c, a.userId, 'operate');
    const req = await body<SetAutoSessionRequest>(c);
    if (!('mode' in req)) throw bad('mode', 'Off, ask, auto or default.');
    return c.json(success(await d.engine.setMode(id, a.userId, a.label, mode(req.mode))));
  });

  r.post('/suggestions/:id/move', async (c) => {
    const a = who(c);
    const req = c.req.header('content-type')?.includes('json') ? await body<{ to: string }>(c) : {};
    if (req.to !== undefined && (typeof req.to !== 'string' || !ID.test(req.to))) throw bad('to', 'Pick one of the suggested Claudes.');
    return c.json(success(await d.engine.answerMove(c.req.param('id'), a.userId, a.label, req.to)));
  });
  r.post('/suggestions/:id/later', async (c) => {
    const a = who(c);
    return c.json(success(await d.engine.answerLater(c.req.param('id'), a.userId, a.label)));
  });
  r.post('/suggestions/:id/always', async (c) => {
    const a = who(c);
    return c.json(success(await d.engine.answerMove(c.req.param('id'), a.userId, a.label, undefined, { always: true })));
  });

  r.get('/events', (c) => {
    const a = who(c);
    const session = c.req.query('session');
    if (session !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(session)) throw bad('session', 'Unknown session.');
    // `?kind=moved,undone`: only those kinds (the Home page asks for the last move without reading the whole trail).
    const kindParam = c.req.query('kind');
    const kinds = kindParam ? kindParam.split(',') : undefined;
    if (kinds && (kinds.length > AUTO_EVENT_KINDS.length || kinds.some((k) => !(AUTO_EVENT_KINDS as readonly string[]).includes(k)))) throw bad('kind', 'Unknown kind.');
    const limit = Number(c.req.query('limit'));
    const before = Number(c.req.query('before'));
    return c.json(
      success(
        d.store.events(a.userId, {
          session,
          kinds: kinds as AutoEventKind[] | undefined,
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
          before: Number.isFinite(before) && before > 0 ? before : undefined,
        }),
      ),
    );
  });

  return r;
}
