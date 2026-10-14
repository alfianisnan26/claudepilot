// `GET` and `PUT /api/chat/sessions/:id/keep-going` (T-259, `CHAT_API.keepGoing`), mounted behind the session guard and the Origin check.
// Who is asking is read ONCE (`owner.actorOf(c)`). Reading needs `view` on the chat; setting needs `operate`, and only a person or an admin
// token sets it: an agent (a chat keeping itself, or another chat, going) and a token below admin are refused, whatever the seam would allow.
// A chat of another user answers like an unknown one. Bodies at most 8 KB.

import { AppError, success } from '@isnanme/core';
import { KEEPGOING_BOUNDS as B, type ChatKeepGoingPolicy, type UpdateKeepGoingRequest } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PlatformOwner } from '../platform/owner.js';
import type { KeepGoingChatPort, KeepGoingEngine } from './engine.js';

export interface KeepGoingRouteDeps {
  owner: PlatformOwner;
  engine: KeepGoingEngine;
  chat: Pick<KeepGoingChatPort, 'get'>;
}

const bad = (field: string, msg: string) => new AppError('VALIDATION_FAILED', msg, { details: { [field]: msg } });

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

const whole = (v: unknown, field: string, b: { min: number; max: number }): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < b.min || v > b.max) throw bad(field, `A whole number from ${b.min} to ${b.max}.`);
  return v;
};

/** A text field: null or empty goes back to the default; one that is too long is refused. */
function text(v: unknown, field: string, max: number, oneLine: boolean): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw bad(field, 'Text, or null for the default.');
  const t = v.replace(/\r\n?/g, '\n').trim();
  if (!t) return null;
  if (t.length > max) throw bad(field, `At most ${max} characters.`);
  // eslint-disable-next-line no-control-regex
  if (oneLine ? /[\u0000-\u001f\u007f]/.test(t) : /[\u0000-\u0008\u000b-\u001f\u007f]/.test(t)) throw bad(field, 'No control characters.');
  return t;
}

/** The fields of a change, checked; absent fields stay. */
export function parsePatch(raw: Record<string, unknown>): Partial<ChatKeepGoingPolicy> {
  const known = new Set<keyof UpdateKeepGoingRequest>(['enabled', 'nudgeAfterMin', 'prompt', 'statusFile', 'maxNudgesPerDay', 'maxWakesPerDay']);
  for (const k of Object.keys(raw)) if (!known.has(k as keyof UpdateKeepGoingRequest)) throw bad(k, 'Unknown field.');
  const p: Partial<ChatKeepGoingPolicy> = {};
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw bad('enabled', 'True or false.');
    p.enabled = raw.enabled;
  }
  if (raw.nudgeAfterMin !== undefined) p.nudgeAfterMin = whole(raw.nudgeAfterMin, 'nudgeAfterMin', B.nudgeAfterMin);
  if (raw.maxNudgesPerDay !== undefined) p.maxNudgesPerDay = whole(raw.maxNudgesPerDay, 'maxNudgesPerDay', B.maxNudgesPerDay);
  if (raw.maxWakesPerDay !== undefined) p.maxWakesPerDay = whole(raw.maxWakesPerDay, 'maxWakesPerDay', B.maxWakesPerDay);
  if (raw.prompt !== undefined) p.prompt = text(raw.prompt, 'prompt', B.promptMax, false);
  if (raw.statusFile !== undefined) {
    const f = text(raw.statusFile, 'statusFile', B.statusFileMax, true);
    if (f && (f.startsWith('/') || f.split('/').includes('..'))) throw bad('statusFile', 'A path inside the chat’s folder.');
    p.statusFile = f;
  }
  return p;
}

export function createKeepGoingRoutes(d: KeepGoingRouteDeps): Hono {
  const app = new Hono();
  app.use('/:id/keep-going', bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'That request is too large.' } }, 413) }));

  /** The chat, when the caller may `verb` it; an unknown one and another user's answer the same 404. */
  const chatFor = (c: Context, verb: 'view' | 'operate') => {
    const who = d.owner.actorOf(c);
    const s = d.chat.get(c.req.param('id') ?? '');
    const subject = s ? { type: 'session' as const, id: s.id, workspaceId: s.workspaceId } : null;
    if (!s || !subject || !who.userId || !d.owner.can(who.userId, 'view', subject)) throw new AppError('NOT_FOUND', 'No such session.');
    // An agent is boxed to its own chat (the seam's rule), here too.
    if (who.actor.kind === 'agent' && who.actor.sessionId !== s.id) throw new AppError('NOT_FOUND', 'No such session.');
    if (verb === 'operate' && !d.owner.can(who.userId, 'operate', subject)) throw new AppError('FORBIDDEN', 'You can’t do that here.');
    return { who, s };
  };

  app.get('/:id/keep-going', (c) => {
    const { s } = chatFor(c, 'view');
    return c.json(success(d.engine.view(s.id)));
  });

  app.put('/:id/keep-going', async (c) => {
    const { who, s } = chatFor(c, 'operate');
    const kind = who.actor.kind;
    // A person, or an admin's token. An agent never sets a policy (its own chat or another), nor does a narrower token.
    if (kind === 'agent') throw new AppError('FORBIDDEN', 'Keep going is set by a person.');
    if (kind === 'token' && (who.actor as { scope?: string }).scope !== 'admin') throw new AppError('FORBIDDEN', 'Keep going needs an admin token.');
    if (kind !== 'user' && kind !== 'token') throw new AppError('FORBIDDEN', 'Keep going is set by a person.');
    const patch = parsePatch(await body(c));
    const ownerId = d.owner.ownersOf({ type: 'session', id: s.id, workspaceId: s.workspaceId })[0] ?? who.userId!;
    return c.json(success(d.engine.set(s.id, ownerId, who.label, patch)));
  });

  return app;
}
