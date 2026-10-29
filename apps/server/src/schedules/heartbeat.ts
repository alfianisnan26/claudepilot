// `POST /api/schedules/heartbeat` (T-965 item 1, general-manager PRD §9.2): a helper outside the portal (the supervisor, a coordinator's
// monitor, a job elsewhere) says it is alive, and the Schedules list shows it, `stale` when it is late by two intervals.
//
// Its own door, mounted by app.ts in front of the cookie guard: `Authorization: Bearer <portal MCP token>` and never a cookie. Only an admin's
// token (Access, MCP) opens it: an agent's per-session token, the manager's and a first-party client's (VS Code) are unknown here, like a
// revoked or expired one (401, counted per address). The token then goes through the seam as what it is (a token actor capped by its
// scope): it needs `operate` on the platform's `system` area, so a read token is told the route does not exist (404), the same answer as
// while the Portal MCP is off. A beat writes no audit row (one a minute per helper would bury the audit); its token id is kept with it.

import { AppError, success } from '@isnanme/core';
import { platformRef, type ScheduleHeartbeatAck } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { actorOfPrincipal, can } from '../authz/seam.js';
import type { VerifyResult } from '../portalmcp/tokens.js';
import { RateLimiter } from '../rateLimit.js';
import type { HelperRegistry } from './helpers.js';

export interface HeartbeatDeps {
  /** The Portal MCP's admin tokens (`PortalMcp.tokens`). */
  tokens: { verify(secret: string, ip?: string): VerifyResult };
  helpers: Pick<HelperRegistry, 'beat'>;
  /** Access, MCP: off refuses every token, as `/mcp` does. */
  mcpEnabled: () => boolean;
  /** The address a request came from (the proxy rule of app.ts). */
  clientKey: (c: Context) => string;
  now?: () => Date;
}

/** Beats a token may send a minute (a helper beats every 10 s at most). */
export const BEATS_PER_TOKEN_MINUTE = 30;
/** Requests without a valid token an address may send a minute. */
export const UNAUTHENTICATED_PER_MINUTE = 20;
const BODY_MAX = 4 * 1024;

const NOT_FOUND = () => new AppError('NOT_FOUND', 'Not found.');

export function createHeartbeatRoutes(d: HeartbeatDeps): Hono {
  const app = new Hono();
  const perToken = new RateLimiter(BEATS_PER_TOKEN_MINUTE, 60_000);
  const unauthenticated = new RateLimiter(UNAUTHENTICATED_PER_MINUTE, 60_000);

  app.post('/', async (c) => {
    if (!d.mcpEnabled()) throw NOT_FOUND();
    const ip = d.clientKey(c);
    if (unauthenticated.blocked(ip)) throw new AppError('RATE_LIMITED', 'Too many requests without a valid token. Wait a minute.');
    // A bearer request carries no cookie: a page in a signed-in browser can never ride the person's session in here.
    if (c.req.header('cookie')) throw new AppError('BAD_REQUEST', 'Send the token without a cookie.');
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    const v = m ? d.tokens.verify(m[1]!, ip) : null;
    if (!v?.ok || v.token.client || v.principal.kind !== 'user') {
      unauthenticated.fail(ip);
      throw new AppError('UNAUTHORIZED', 'Send a portal access token: Authorization: Bearer cpat_…');
    }
    const actor = actorOfPrincipal(v.principal);
    if (!can(actor, 'operate', platformRef('system')).allow) throw NOT_FOUND();
    if (perToken.blocked(v.token.id)) throw new AppError('RATE_LIMITED', 'Too many beats. Wait a minute.');
    perToken.fail(v.token.id);

    if (!/^application\/json/i.test(c.req.header('content-type') ?? '')) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Send application/json.');
    const text = await c.req.text();
    if (text.length > BODY_MAX) throw new AppError('PAYLOAD_TOO_LARGE', 'That request is too large.');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new AppError('BAD_REQUEST', 'Expected a JSON object.');
    }
    const ack = d.helpers.beat(body, { tokenId: v.token.id, label: v.token.label }, d.now?.() ?? new Date());
    return c.json(success<ScheduleHeartbeatAck>(ack));
  });
  return app;
}
