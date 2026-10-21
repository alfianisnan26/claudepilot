import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PortalClient, PortalError, checkPortalUrl, compat, pollForToken } from '../src/api.js';
import { redact } from '../src/redact.js';
import { startFakePortal, type FakePortal } from './fake-portal.mjs';

let fake: FakePortal;
before(async () => {
  fake = await startFakePortal();
});
after(() => fake.close());

const noWait = { sleep: () => Promise.resolve(), cancelled: () => false };

test('the portal address: https anywhere, http only on this machine, no credentials or path', () => {
  assert.deepEqual(checkPortalUrl('https://pilot.example.com/'), { ok: true, url: 'https://pilot.example.com' });
  assert.deepEqual(checkPortalUrl(' http://127.0.0.1:3400 '), { ok: true, url: 'http://127.0.0.1:3400' });
  assert.equal(checkPortalUrl('http://localhost:3400').ok, true);
  assert.equal(checkPortalUrl('http://[::1]:3400').ok, true);
  assert.equal(checkPortalUrl('http://127.8.9.10').ok, true);
  for (const bad of ['http://pilot.example.com', 'http://10.0.0.5:3400', 'http://127.0.0.1.evil.example', 'https://a:b@pilot.example.com', 'https://pilot.example.com/x', 'ftp://pilot.example.com', 'pilot', ''])
    assert.equal(checkPortalUrl(bad).ok, false, bad);
  assert.throws(() => new PortalClient({ baseUrl: 'http://pilot.example.com' }), PortalError);
});

test('the version check: an extension older than the portal serves, or a portal older than the extension, is refused with a reason', () => {
  assert.deepEqual(compat({ api: 1, minApi: 1 }), { ok: true });
  assert.deepEqual(compat({ api: 3, minApi: 1 }), { ok: true }, 'a newer portal that still serves API 1');
  const old = compat({ api: 3, minApi: 2 });
  assert.equal(old.ok, false);
  assert.match((old as { reason: string }).reason, /extension is too old/);
  const behind = compat({ api: 0, minApi: 0 });
  assert.match((behind as { reason: string }).reason, /portal is older/);
});

test('sign-in against the fake portal: device start, polls until approved, then every call carries the bearer and no cookie', async () => {
  let token: string | undefined;
  const seen: number[] = [];
  const client = new PortalClient({ baseUrl: fake.url, token: async () => token, onApiVersion: (v) => seen.push(v) });
  assert.equal((await client.version()).api, 1);
  const start = await client.startDevice('test box');
  assert.equal(start.userCode, 'BCDF-GHJK');
  let polls = 0;
  const outcome = await pollForToken(
    { poll: async (d) => (++polls === 2 ? await fetch(`${fake.url}/fake/approve`, { method: 'POST' }).then(() => client.poll(d)) : client.poll(d)) },
    start,
    noWait,
  );
  assert.equal(outcome.ok, true);
  token = (outcome as { token: string }).token;
  assert.equal(polls, 2);
  const agents = await client.agents();
  assert.equal(agents.length, 2);
  assert.equal((await client.status()).quota?.usedPct, 61);
  assert.equal((await client.events('s1')).events.length, 2);
  assert.equal((await client.events('s1', 1)).events.length, 1);
  await client.send('s1', 'hi', crypto.randomUUID());
  assert.deepEqual(fake.state.sent.at(-1), { id: 's1', text: 'hi' });
  const authed = fake.state.calls.filter((c) => c.path.startsWith('/api/vscode/') && !/version|device|token$/.test(c.path));
  assert.ok(authed.length >= 4);
  assert.ok(authed.every((c) => c.auth === 'bearer' && !c.cookie), 'bearer on every call, a cookie on none');
  assert.ok(seen.every((v) => v === 1) && seen.length > 0, 'the API version is read from every answer');
});

test('a refused or revoked token is a signed-out error; its message has no secret in it', async () => {
  const leaked = `cpat_${'Q'.repeat(10)}${Math.random().toString(36).slice(2)}${'Z'.repeat(10)}`;
  const client = new PortalClient({ baseUrl: fake.url, token: async () => leaked });
  await assert.rejects(client.agents(), (e: unknown) => e instanceof PortalError && e.signedOut && !e.message.includes(leaked));
  const none = new PortalClient({ baseUrl: fake.url, token: async () => undefined });
  await assert.rejects(none.agents(), (e: unknown) => e instanceof PortalError && e.signedOut);
});

test('an unreachable portal is a network error that names the address, and a poll retries it', async () => {
  const client = new PortalClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 2000 });
  await assert.rejects(client.version(), (e: unknown) => e instanceof PortalError && e.code === 'NETWORK_ERROR' && e.message.includes('127.0.0.1:9'));
  let n = 0;
  const outcome = await pollForToken(
    {
      poll: async () => {
        n++;
        if (n === 1) throw new PortalError('NETWORK_ERROR', 'down', 0);
        return { status: 'denied' as const };
      },
    },
    { deviceCode: 'd', interval: 1, expiresIn: 60 },
    noWait,
  );
  assert.deepEqual(outcome, { ok: false, reason: 'denied' });
  assert.equal(n, 2);
});

test('polling: slow_down widens the wait, cancel and expiry end it', async () => {
  const waits: number[] = [];
  const answers = [{ status: 'slow_down' as const, interval: 10 }, { status: 'pending' as const }, { status: 'expired' as const }];
  const outcome = await pollForToken({ poll: async () => answers.shift()! }, { deviceCode: 'd', interval: 5, expiresIn: 600 }, { sleep: async (ms) => void waits.push(ms), cancelled: () => false });
  assert.deepEqual(outcome, { ok: false, reason: 'expired' });
  assert.deepEqual(waits, [5000, 10000, 10000]);
  const cancelled = await pollForToken({ poll: async () => ({ status: 'pending' as const }) }, { deviceCode: 'd', interval: 1, expiresIn: 600 }, { sleep: async () => {}, cancelled: () => true });
  assert.deepEqual(cancelled, { ok: false, reason: 'cancelled' });
  let t = 0;
  const timedOut = await pollForToken({ poll: async () => ({ status: 'pending' as const }) }, { deviceCode: 'd', interval: 5, expiresIn: 12 }, { sleep: async (ms) => void (t += ms), cancelled: () => false, now: () => t });
  assert.deepEqual(timedOut, { ok: false, reason: 'expired' });
});

test('Allow without the hash of the shown text is refused by the portal; with it, it goes through', async () => {
  const client = new PortalClient({ baseUrl: fake.url, token: async () => fake.state.token ?? undefined });
  const [a] = await client.approvals();
  await assert.rejects(client.respond(a!.sessionId, { requestId: a!.requestId, decision: 'allow' }), (e: unknown) => e instanceof PortalError && e.status === 409);
  await client.respond(a!.sessionId, { requestId: a!.requestId, decision: 'allow', fullSha256: a!.fullSha256! });
  assert.equal(fake.state.answered.length, 1);
});

test('pageUrl stays on the portal', () => {
  const client = new PortalClient({ baseUrl: fake.url });
  assert.equal(client.pageUrl('/admin/sessions/s1'), `${fake.url}/admin/sessions/s1`);
  assert.equal(client.pageUrl('//evil.example/x'), `${fake.url}/`);
  assert.equal(client.pageUrl('https://evil.example'), `${fake.url}/`);
});

test('redact hides tokens, bearer headers and key=value secrets', () => {
  const tok = `cpat_${'a1B2'.repeat(8)}`;
  assert.equal(redact(`failed with ${tok}`), 'failed with [hidden]');
  assert.equal(redact(`Authorization: Bearer ${tok}`), 'Authorization: [hidden]');
  assert.equal(redact('{"deviceCode":"abcdefghijklmnop"}'), '{"deviceCode":"[hidden]"}');
  assert.equal(redact('nothing secret here'), 'nothing secret here');
});
