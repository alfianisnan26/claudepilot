// The agent-facing routes (docs/prd/targets-connect.md §15, `CONNECT_PUBLIC`): one prefix, `/connect/`, no cookie, none of `/api`'s Origin and CORS
// machinery, so a proxy or an access policy that must let agents through needs one rule. This file owns `health`, `enroll` and `enroll/status`
// and mounts the installers' routes (T4: the scripts, the plan, the manifest, the bundle, the context); the tunnel itself is the hub's upgrade
// handler (`GET /connect/v1/tunnel` without an upgrade answers 426). Paths are full (`/connect/v1/...`): mount this app at the root.
//
//  - 404 for everything under `/connect/` when Connect is turned off (FR61) and for what does not exist;
//  - a 16 KiB body at most, and a per-address request limit (wrong tokens have their own, tighter one);
//  - a request that carries an `Origin` header to `enroll` or the status route is refused: a browser must never act as an agent;
//  - errors are the usual `{ error: { code, message, details } }` with `details.reason` from `CONNECT_ENROLL_REASONS` (the scripts read it).

import type { IncomingMessage } from 'node:http';
import { AppError, success } from '@isnanme/core';
import { CONNECT_LIMITS, CONNECT_PROTOCOL, CONNECT_PUBLIC } from '@portal/contracts';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { RateLimiter } from '../rateLimit.js';
import type { ConnectConfig } from './config.js';
import { enrollRefusal, type EnrollmentService } from './enrollment.js';
import type { InstallPort } from './installPort.js';
import type { InstallDeps } from './seams.js';
import { bearerToken } from './tokens.js';

type Env = { Bindings: { incoming?: IncomingMessage } };

export interface PublicDeps {
  config: ConnectConfig;
  enrollments: EnrollmentService;
  install: InstallPort;
  installDeps: InstallDeps;
  /** Wrong tokens per address: the same instance the enrollment service uses, so a wrong token counts once across plan, enroll and status. */
  limiter: RateLimiter;
  portalVersion: string;
  clientIp(req: IncomingMessage | undefined): string | null;
}

/** Requests per address and minute to the routes this file owns (installers have their own cost: they are static). */
const REQUESTS_PER_MINUTE = 300;

export function createPublicRoutes(d: PublicDeps): Hono<Env> {
  const app = new Hono<Env>();
  const requests = new RateLimiter(REQUESTS_PER_MINUTE, 60_000);
  const ip = (c: Context<Env>) => d.clientIp(c.env?.incoming) ?? 'unknown';

  // The kill switch covers the whole prefix, installers included: nothing under /connect/ exists while Connect is off.
  app.use('/connect/*', async (c, next) => {
    if (!d.config.enabled) throw new AppError('NOT_FOUND', 'Not found.');
    await next();
  });

  /** The shared front of `enroll` and its status: not a browser, not from an address that guessed too often, not flooding. */
  const guard = (c: Context<Env>) => {
    if (c.req.header('origin') !== undefined) throw new AppError('FORBIDDEN', 'This is for agents, not browsers.');
    const key = ip(c);
    if (requests.blocked(key)) throw new AppError('RATE_LIMITED', 'Too many requests from this address. Wait a minute.', { details: { retryAfterS: 60 } });
    requests.fail(key);
    return key;
  };

  app.get(CONNECT_PUBLIC.health, (c) => c.json({ ok: true, protocol: CONNECT_PROTOCOL, version: d.portalVersion }));

  app.post(
    CONNECT_PUBLIC.enroll,
    bodyLimit({
      maxSize: CONNECT_LIMITS.preAuth.firstMessageBytes * 2,
      onError: () => {
        throw new AppError('PAYLOAD_TOO_LARGE', 'That request is too large.');
      },
    }),
    async (c) => {
      const key = guard(c);
      const token = bearerToken(c.req.header('authorization'));
      let parsed: unknown = null;
      try {
        parsed = await c.req.json();
      } catch {
        throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
      }
      const result = d.enrollments.enroll(token, parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as never) : null, key);
      return c.json(success(result));
    },
  );

  app.get(CONNECT_PUBLIC.enrollStatus, (c) => {
    const key = guard(c);
    if (d.limiter.blocked(key)) throw new AppError('RATE_LIMITED', 'Too many wrong tokens from this address. Wait a few minutes.', { details: { retryAfterS: 600 } });
    const token = bearerToken(c.req.header('authorization'));
    const found = token ? d.enrollments.lookup(token) : null;
    if (!token || !found) {
      d.limiter.fail(key);
      throw enrollRefusal('token_invalid', 'That token isn’t valid.', 'UNAUTHORIZED');
    }
    const status = d.enrollments.status(token);
    if (!status) throw enrollRefusal('token_used', 'That token was used, and its status is no longer kept.', 'UNAUTHORIZED');
    return c.json(success(status));
  });

  // A request that is not an upgrade: this is a WebSocket path.
  app.get(CONNECT_PUBLIC.tunnel, () => {
    throw new AppError('BAD_REQUEST', 'This is a WebSocket endpoint: connect with the subprotocol pilot.tunnel.v1.', { status: 426 });
  });

  // The installers, plan, manifest, bundle and context: their own routes (T4), with the wrong-token limiter shared.
  app.route('/', d.install.routes(d.installDeps, { limiter: d.limiter, clientIp: (c) => d.clientIp((c.env as { incoming?: IncomingMessage } | undefined)?.incoming) ?? 'unknown' }) as never);

  app.all('/connect/*', () => {
    throw new AppError('NOT_FOUND', 'Not found.');
  });
  return app;
}
