// Test rig: T1's real hub on a loopback port (testkit.ts of the control plane: a real SQLite store, the registry, enrollment and the hub), plus
// the one agent-facing HTTP route a test of the agent needs, `POST /connect/v1/enroll`, answered by the real EnrollmentService. This is "agent and
// hub in one process" (PRD §20, C2's gate); the real routes and the installers are T1's and T4's.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '@isnanme/core';
import type { ConnectKind } from '@portal/contracts';
import { openCore, openHub, withTimeout, wizard, type Core, type TestHub } from '../../testkit.js';
import type { AgentHandle } from '../client.js';

/**
 * Stops the agents a test started (and empties the list). A stop that does not return within `ms` fails the hook by name instead of holding the
 * suite: an unbounded `await a.stop()` in `afterEach` is how rekey.test.ts hung the release gate for 26 minutes. An error from the stop itself
 * (the agent was already gone) is not a failure.
 */
export async function stopAgents(agents: AgentHandle[], ms = 10_000): Promise<void> {
  for (const a of agents.splice(0)) await withTimeout(a.stop().catch(() => undefined), `the stop of an agent (state ${a.state()})`, ms);
}

const readBody = async (req: IncomingMessage) => {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  return Buffer.concat(parts).toString('utf8');
};

export interface Portal {
  core: Core;
  hub: TestHub;
  origin: string;
  /** A pending target with a usable token, as the wizard makes. */
  target(over?: { id?: string; kind?: ConnectKind; maxUses?: number; options?: Record<string, unknown> }): { id: string; token: string };
  /** Everything the audit recorded for a target. */
  events(targetId: string): { type: string; detail: Record<string, unknown> }[];
  close(): Promise<void>;
}

export async function openPortal(opts: { build?: string; timing?: Parameters<typeof openHub>[1] extends infer O ? (O extends { timing?: infer T } ? T : never) : never } = {}): Promise<Portal> {
  const core = await openCore();
  const hub = await openHub(core, { ...(opts.build ? { build: opts.build } : {}), ...(opts.timing ? { timing: opts.timing } : {}) });
  hub.server.on('request', async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, value: unknown) => {
      const text = JSON.stringify(value);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    };
    if (req.method === 'POST' && req.url === '/connect/v1/enroll') {
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      try {
        const body = JSON.parse(await readBody(req)) as never;
        send(200, { data: core.enrollments.enroll(token, body, String(req.headers['x-test-ip'] ?? '198.51.100.20')) });
      } catch (e) {
        const err = AppError.from(e);
        send(err.status, err.toJSON());
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/connect/v1/health') return send(200, { ok: true, protocol: 1, version: '0.0.0' });
    send(404, { error: { code: 'NOT_FOUND', message: 'No such route.' } });
  });
  return {
    core,
    hub,
    origin: hub.origin,
    target: (over = {}) => {
      const w = wizard(core, { kind: 'host', options: { hostAccess: true }, ...over });
      return { id: w.target.id, token: w.token };
    },
    events: (targetId) => core.events.list(targetId, { limit: 200 }).map((e) => ({ type: e.type, detail: e.detail })),
    close: () => hub.close(),
  };
}
