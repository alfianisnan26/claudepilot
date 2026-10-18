// The job-run Mac door (T-1083 S1b, D-84; who may call it: ./authz.ts; docs/prd/local-git-ci.md §25).
//
// `/jobrun/mac/*` for `scripts/job-run.sh`, outside /api: not behind the cookie, the CSRF check or /api's guards. The script calls it with the
// session's own `PILOT_MCP_TOKEN` as `Authorization: Bearer`, at `${PILOT_MCP_URL%/mcp}/jobrun/mac`. Order on every request: the address's
// refusal bucket (429), the body (at most 64 KiB within 10 s: 413, 408), the bearer through `AgentAccess.verify` and `jobRunCallerOf` (the
// workspace on `jobrun.macClients`), then the session's own bucket (120 a minute, 429). Any refusal before a handler is the same 404 as a route
// that does not exist, and counts against the address. Nothing of the body or the bearer is logged.
//
// S1b-1 has no Mac runtime: `runner` is absent, so the slot says `no-runtime`, a start is 503 and the list is empty. S1b-2 adds it.

import { JOBRUN_DOOR_LIMITS, JOBRUN_MAC_SLOTS, type JobRunMacRun, type JobRunSlot } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { config } from '../config.js';
import type { AgentVerify } from '../portalmcp/agents.js';
import { readBody } from '../triggers/receiver.js';
import { jobRunCallerOf, type JobRunCaller } from './authz.js';

const MAP_MAX = 10_000;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The Mac runtime (S1b-2). A run belongs to the session that started it. */
export interface MacRunner {
  /** Live runs on the Mac, every session's: what the slot count reads. */
  liveCount(): number;
  list(session: string): JobRunMacRun[];
  start(caller: JobRunCaller, macWorkspace: string, body: unknown): Promise<JobRunMacRun>;
  /** The masked log of a run this session started, or null (unknown, or another session's). */
  log(session: string, runId: string): Promise<Response | null>;
  /** Stops a run this session started; false when there is none. */
  stop(session: string, runId: string): Promise<boolean>;
}

export interface JobRunDoorDeps {
  /** `AgentAccess.verify`: the agent token check, the door's only key. */
  verify(secret: string): AgentVerify;
  /** The workspaces whose sessions may call (`jobrun.macClients`), read at each call. */
  clients(): readonly string[];
  /** The Mac workspace (`jobrun.macWorkspace`), read at each call; '' for none. */
  macWorkspace(): string;
  /** The Mac workspace's status, or null when it does not exist. */
  workspaceStatus(id: string): Promise<string | null>;
  runner?: MacRunner;
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

type DoorEnv = { Variables: { caller: JobRunCaller } };

/** `/jobrun/mac`: the door job-run.sh calls with `Authorization: Bearer <PILOT_MCP_TOKEN>`. */
export function createJobRunDoor(d: JobRunDoorDeps): Hono<DoorEnv> {
  const app = new Hono<DoorEnv>();
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

    const raw = await readBody(c.req.raw, JOBRUN_DOOR_LIMITS.bodyMaxBytes, JOBRUN_DOOR_LIMITS.bodyReadMs);
    if (raw === 'too_large') return json(c, 413, { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'That request is too large.' } }, { Connection: 'close' });
    if (raw === 'timeout') return json(c, 408, { ok: false, error: { code: 'TIMEOUT', message: 'The body took too long.' } }, { Connection: 'close' });
    bodies.set(c.req.raw, raw);

    // Only the Authorization header is a key: a cookie, a query string or a body field is never read as one.
    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
    const caller = bearer ? jobRunCallerOf(d.verify(bearer), d.clients()) : null;
    if (!caller) {
      bump(refused, addr, at);
      return notFound(c);
    }

    const sb = bump(used, caller.session, at);
    if (sb.n > JOBRUN_DOOR_LIMITS.sessionMinute) return tooMany(c, (sb.at + 60_000 - at) / 1000);
    c.set('caller', caller);
    await next();
  });

  app.get('/slot', async (c) => {
    const mac = d.macWorkspace();
    let answer: JobRunSlot;
    if (!mac) answer = { slot: false, reason: 'no-mac' };
    else if ((await d.workspaceStatus(mac).catch(() => null)) !== 'running') answer = { slot: false, reason: 'mac-not-running' };
    else if (!d.runner) answer = { slot: false, reason: 'no-runtime' };
    else {
      const free = JOBRUN_MAC_SLOTS - d.runner.liveCount();
      answer = free > 0 ? { slot: true, free } : { slot: false, reason: 'mac-full' };
    }
    return json(c, 200, { ok: true, data: answer });
  });

  app.get('/runs', (c) => json(c, 200, { ok: true, data: { items: d.runner?.list(c.get('caller').session) ?? [] } }));

  app.post('/runs', async (c) => {
    let body: unknown;
    try {
      body = JSON.parse((bodies.get(c.req.raw) ?? Buffer.alloc(0)).toString('utf8'));
    } catch {
      return json(c, 400, { ok: false, error: { code: 'VALIDATION_FAILED', message: 'The body is not JSON.' } });
    }
    const mac = d.macWorkspace();
    if (!mac || !d.runner) return json(c, 503, { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'No Mac runtime.' } });
    const run = await d.runner.start(c.get('caller'), mac, body);
    return json(c, 201, { ok: true, data: run });
  });

  app.get('/runs/:id/log', async (c) => {
    const id = c.req.param('id');
    const res = RUN_ID.test(id) && d.runner ? await d.runner.log(c.get('caller').session, id) : null;
    return res ?? notFound(c);
  });

  app.delete('/runs/:id', async (c) => {
    const id = c.req.param('id');
    const stopped = RUN_ID.test(id) && d.runner ? await d.runner.stop(c.get('caller').session, id) : false;
    return stopped ? json(c, 200, { ok: true, data: { stopped: true } }) : notFound(c);
  });

  app.notFound((c) => notFound(c));
  return app;
}
