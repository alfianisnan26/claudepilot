// T-968 S1 (general-manager PRD §4, "No browser authority"): a live General Manager token (cpmt_) never authenticates a web route, as a
// bearer or in either session cookie, and actorOf on a web request never yields a manager. The app is built with stub dependencies (as in
// appports/routes.test.ts) and the real Portal MCP module, so the token is a real, live one. Minted at run time, never written here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { actorOf } from '../authz/seam.js';
import { Portal } from '../portal.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';

const spy = (): object =>
  new Proxy(function () {}, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : spy()),
    apply: () => spy(),
    construct: () => spy(),
    set: () => true,
  });

test('a live manager token is refused on web routes (bearer and both cookie names); the owner cookie is the control', async () => {
  const h = await portalMcpHarness();
  try {
    const portal = new Portal('24681357', 60_000);
    const owner = portal.signIn('24681357');
    h.alive.add('gm1');
    const m = h.module.managers.mint({ userId: 'u_owner', sessionId: 'gm1' })!;
    assert.equal(h.module.managers.verify(m.secret).ok, true, 'the token is live on /mcp');

    const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
    const app = make(portal, spy(), spy(), spy(), spy(), spy(), spy(), spy(), {
      serveWeb: false,
      poolService: spy(),
      mcp: spy(),
      skills: spy(),
      personas: spy(),
      settings: spy(),
      portalMcp: h.module,
      tickets: spy(),
      ci: spy(),
      knowledge: spy(),
      repos: spy(),
      claudeVersions: spy(),
      claudeUsage: spy(),
    });
    const env = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
    const get = async (path: string, headers: Record<string, string>) => {
      const res = await app.request(`https://pilot.test${path}`, { headers: { host: 'pilot.test', ...headers } }, env);
      return { status: res.status, json: (await res.json().catch(() => ({}))) as { data?: { authenticated?: boolean } } };
    };

    // The control: the person's own cookie opens the admin state, so a refusal below is the token's, not the route's.
    assert.equal((await get('/api/admin/state', { cookie: `portal_session=${owner}` })).status, 200);

    const ways: Record<string, string>[] = [
      { authorization: `Bearer ${m.secret}` },
      { cookie: `portal_session=${m.secret}` },
      { cookie: `__Host-portal_session=${m.secret}` },
    ];
    for (const headers of ways) {
      const how = Object.keys(headers)[0]! + (headers.cookie ? ` ${headers.cookie.split('=')[0]}` : '');
      assert.equal((await get('/api/admin/state', headers)).status, 401, `admin state, ${how}`);
      assert.equal((await get('/api/me', headers)).status, 401, `/api/me, ${how}`);
      assert.equal((await get('/api/session', headers)).json.data?.authenticated, false, `/api/session, ${how}`);
    }
    assert.equal(h.module.managers.verify(m.secret).ok, true, 'still live: the refusals were the web side, not a revoke');

    // actorOf on a web request: no session token set means anonymous, whatever bearer the request carried.
    assert.deepEqual(actorOf({ get: () => undefined }), { kind: 'anonymous' });
  } finally {
    h.done();
  }
});
