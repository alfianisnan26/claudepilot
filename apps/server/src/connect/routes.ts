// Connect's admin REST (docs/prd/targets-connect.md §15, `CONNECT_API` in the contract): mounted by app.ts under `/api/connect` behind the session
// guard, so it inherits the Origin check and the JSON envelope of every other `/api` route. Each handler reads who is asking once
// (`actorOf(c)`) and passes it down; nothing here trusts a user id from a body or a header.

import type { IncomingMessage } from 'node:http';
import { AppError, success } from '@isnanme/core';
import { CONNECT_REMOVE_QUERY } from '@portal/contracts';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { actorOf } from '../authz/seam.js';
import type { ConnectAdmin, RequestMeta } from './admin.js';

type Env = { Bindings: { incoming?: IncomingMessage } };

async function body<T>(c: Context<Env>): Promise<Partial<T>> {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('BAD_REQUEST', 'Expected a JSON object.');
  return value as Partial<T>;
}

/** A path id is short plain text; anything else is a thing that does not exist (no existence leak, nothing odd reaches a query). */
function idOf(c: Context<Env>, name: string): string {
  const v = c.req.param(name) ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v)) throw new AppError('NOT_FOUND', 'Not found.');
  return v;
}

function intQuery(c: Context<Env>, name: string): number | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new AppError('VALIDATION_FAILED', `${name} must be a whole number.`, { details: { [name]: 'A whole number.' } });
  return n;
}

/** The address the admin's browser is on: the origin of the request (the wizard prefills it as the portal address). */
function originOf(c: Context<Env>): string | null {
  const origin = c.req.header('origin');
  if (origin) {
    try {
      return new URL(origin).origin;
    } catch {
      // fall through to the host
    }
  }
  const host = c.req.header('host');
  if (!host) return null;
  const proto = c.req.header('x-forwarded-proto')?.split(',').at(-1)?.trim() === 'https' ? 'https' : 'http';
  return /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(host) ? `${proto}://${host}` : null;
}

export function createConnectRoutes(admin: ConnectAdmin, opts: { clientIp(req: IncomingMessage | undefined): string | null }): Hono<Env> {
  const r = new Hono<Env>();
  const meta = (c: Context<Env>): RequestMeta => ({ ip: opts.clientIp(c.env?.incoming), origin: originOf(c) });

  // ---- targets ---------------------------------------------------------------------------------------------------------------------
  r.get('/targets', async (c) => c.json(success(await admin.list(actorOf(c)))));
  r.post('/targets', async (c) => c.json(success(admin.create(actorOf(c), await body(c), meta(c))), 201));
  r.get('/targets/:id', (c) => c.json(success(admin.view(actorOf(c), idOf(c, 'id')))));
  r.patch('/targets/:id', async (c) => c.json(success(admin.update(actorOf(c), idOf(c, 'id'), await body(c), meta(c)))));
  r.delete('/targets/:id', async (c) => {
    await admin.remove(actorOf(c), idOf(c, 'id'), c.req.query(CONNECT_REMOVE_QUERY), meta(c));
    return c.json(success({ ok: true }));
  });
  r.post('/targets/:id/check', async (c) => c.json(success(await admin.check(actorOf(c), idOf(c, 'id')))));

  // ---- tokens ----------------------------------------------------------------------------------------------------------------------
  r.get('/targets/:id/enrollments', (c) => c.json(success(admin.enrollments(actorOf(c), idOf(c, 'id')))));
  r.post('/targets/:id/enrollments', async (c) => c.json(success(admin.createEnrollment(actorOf(c), idOf(c, 'id'), await body(c), meta(c))), 201));
  r.delete('/targets/:id/enrollments/:eid', (c) => {
    admin.revokeEnrollment(actorOf(c), idOf(c, 'id'), idOf(c, 'eid'), meta(c));
    return c.json(success({ ok: true }));
  });
  r.get('/targets/:id/enrollments/:eid/plan', (c) => c.json(success(admin.planPreview(actorOf(c), idOf(c, 'id'), idOf(c, 'eid')))));
  r.get('/targets/:id/events', (c) => c.json(success(admin.events(actorOf(c), idOf(c, 'id'), { limit: intQuery(c, 'limit'), before: intQuery(c, 'before') }))));

  // ---- nodes -----------------------------------------------------------------------------------------------------------------------
  r.patch('/nodes/:nid', async (c) => c.json(success(admin.updateNode(actorOf(c), idOf(c, 'nid'), await body(c), meta(c)))));
  r.delete('/nodes/:nid', async (c) => {
    await admin.revokeNode(actorOf(c), idOf(c, 'nid'), meta(c));
    return c.json(success({ ok: true }));
  });
  r.post('/nodes/:nid/rotate', async (c) => {
    await admin.rotateNode(actorOf(c), idOf(c, 'nid'));
    return c.json(success({ ok: true }), 202);
  });

  // ---- scanned targets and settings --------------------------------------------------------------------------------------------------
  r.patch('/scanned/:id', async (c) => c.json(success(await admin.updateScanned(actorOf(c), idOf(c, 'id'), await body(c) as { hidden: boolean }))));
  r.get('/settings', (c) => c.json(success(admin.settings(actorOf(c)))));
  r.put('/settings', async (c) => c.json(success(admin.updateSettings(actorOf(c), await body(c), meta(c)))));

  return r;
}
