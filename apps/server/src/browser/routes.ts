import type { IncomingMessage } from 'node:http';
import type { HttpBindings } from '@hono/node-server';
import { createHash } from 'node:crypto';
import { AppError, success } from '@isnanme/core';
import type { BrowserAction, BrowserControl, BrowserControlRequest, BrowserHandoffAnswer, BrowserStatus } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { config } from '../config.js';
import { workspaceGuard } from '../workspaces/authz.js';
import { declareBrowserPolicies } from './authz.js';
import type { BrowserService } from './service.js';

type Env = { Bindings: HttpBindings; Variables: { token: string } };

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

/**
 * Whether input is allowed from this connection (browser PRD §12.1): behind HTTPS, or from a loopback peer
 * (localhost, the VS Code forward). Over plain HTTP, keystrokes — website passwords included — would cross the
 * network in the clear, and the session cookie lacks `Secure`.
 */
export function secureContext(req: IncomingMessage, forwardedProto?: string): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  if (config.trustProxy && forwardedProto?.split(',').at(-1)?.trim() === 'https') return true;
  return LOOPBACK.test(req.socket.remoteAddress ?? '');
}

const ACTIONS: readonly BrowserAction[] = ['wake', 'stop', 'restart'];

/**
 * `/api/workspaces/:target/:name/browser…` (browser PRD §12, §15): the browser's status, and wake, stop and
 * restart. Mounted behind the session guard, with the origin check every mutating request already has.
 */
export function createBrowserRoutes(service: BrowserService) {
  declareBrowserPolicies();
  const app = new Hono<Env>();
  const id = (c: Context<Env>) => `${c.req.param('target')}/${c.req.param('name')}`;
  // T-531: the seam first, with the verb declared in ./authz.ts; a workspace the caller may not see is the same 404 as a missing one.
  const toView = workspaceGuard('view');
  const toOperate = workspaceGuard('operate');

  app.get('/:target/:name/browser', toView, async (c) =>
    c.json(
      success<BrowserStatus>(
        await service.status(id(c), {
          deviceId: c.req.query('deviceId')?.slice(0, 80),
          secure: secureContext(c.env.incoming, c.req.header('x-forwarded-proto')),
        }),
      ),
    ),
  );

  /** Who did it, for the audit log: the first digits of the session's hash, never the token (PRD §16). */
  const who = (c: Context<Env>) => ({
    secure: secureContext(c.env.incoming, c.req.header('x-forwarded-proto')),
    session: createHash('sha256').update(c.get('token')).digest('hex').slice(0, 8),
  });
  const body = async <T>(c: Context<Env>): Promise<Partial<T>> => {
    const v: unknown = await c.req.json().catch(() => null);
    if (!v || typeof v !== 'object') throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
    return v as Partial<T>;
  };

  // Take, renew or release control from a device (PRD §12.3); the device renews while it is around.
  app.put('/:target/:name/browser/control', toOperate, async (c) => c.json(success<BrowserControl>(await service.setControl(id(c), await body<BrowserControlRequest>(c), who(c)))));

  // Answer a handoff: handed back, or declined.
  app.post('/:target/:name/browser/handoffs/:handoff', toOperate, async (c) => {
    const b = await body<BrowserHandoffAnswer & { deviceId?: string }>(c);
    await service.answerHandoff(id(c), c.req.param('handoff'), b, { device: typeof b.deviceId === 'string' ? b.deviceId : null, session: who(c).session });
    return c.json(success({ ok: true }));
  });

  app.post('/:target/:name/browser/install/retry', toOperate, (c) => {
    service.retryInstall(id(c));
    return c.json(success({ ok: true }));
  });

  app.get('/:target/:name/browser/configuration', toView, (c) => c.json(success(service.configuration(id(c)))));

  app.post('/:target/:name/browser/:action', toOperate, async (c) => {
    const action = c.req.param('action') as BrowserAction;
    if (!ACTIONS.includes(action)) throw new AppError('NOT_FOUND');
    await service.action(id(c), action);
    return c.json(success({ ok: true }));
  });

  return app;
}
