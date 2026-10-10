import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { Outbox, outboxPullScript, parseOutbox, type OutboxEvent } from '../delivery/outbox.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import type { Runtime } from '../workspaces/runtime.js';
import { AccountHealthService, classifyResponse, verdictOfCheck } from './health.js';
import { AccountPools } from './pools.js';
import { AccountsService } from './service.js';

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(10);
  }
}

/* ---------- The rule table (PRD §11.3) ---------- */

const now = new Date('2026-10-10T12:00:00Z');
const ok = { state: 'ok' as const, until: null, backoffMs: null };
const res = (status: number, error?: { type?: string; message?: string; details?: { error_code?: string } }, headers: Record<string, string> = {}) => ({
  status,
  body: error ? { type: 'error', error } : { type: 'message' },
  headers: new Headers(headers),
});

test('responses map to health states, and transient errors change nothing', () => {
  assert.equal(classifyResponse(res(200), now, ok)?.state, 'ok');
  assert.equal(classifyResponse(res(401, { type: 'authentication_error' }), now, ok)?.state, 'invalid');
  assert.equal(classifyResponse(res(402, { type: 'billing_error' }), now, ok)?.state, 'billing');
  assert.equal(classifyResponse(res(403, { type: 'permission_error' }), now, ok)?.state, 'attention');
  assert.equal(classifyResponse(res(404, { type: 'not_found_error', message: 'model: x' }), now, ok)?.state, 'attention');
  assert.equal(classifyResponse(res(400, { message: 'Your credit balance is too low' }), now, ok)?.state, 'billing');
  for (const status of [529, 500, 504, 400, 413]) assert.equal(classifyResponse(res(status, { type: 'api_error', message: 'x' }), now, ok), null);
});

test('rate limits cool down until retry-after, the exhausted bucket resets, or a doubling backoff', () => {
  const v = classifyResponse(res(429, { type: 'rate_limit_error' }, { 'retry-after': '30' }), now, ok)!;
  assert.deepEqual([v.state, v.until?.toISOString()], ['cooling', '2026-10-10T12:00:30.000Z']);

  const reset = classifyResponse(
    res(429, { type: 'rate_limit_error' }, { 'anthropic-ratelimit-tokens-remaining': '0', 'anthropic-ratelimit-tokens-reset': '2026-10-10T12:00:45Z', 'anthropic-ratelimit-requests-remaining': '7', 'anthropic-ratelimit-requests-reset': '2026-10-10T12:05:00Z' }),
    now,
    ok,
  )!;
  assert.equal(reset.until?.toISOString(), '2026-10-10T12:00:45.000Z');

  const first = classifyResponse(res(429, { type: 'rate_limit_error' }), now, ok)!;
  assert.deepEqual([first.backoffMs, first.until?.toISOString()], [2000, '2026-10-10T12:00:02.000Z']);
  // Still inside that window: no escalation.
  const again = classifyResponse(res(429, { type: 'rate_limit_error' }), now, { state: 'cooling', until: first.until, backoffMs: 2000 })!;
  assert.equal(again.backoffMs, 2000);
  // After it: doubles, up to 5 minutes.
  const later = new Date(now.getTime() + 3000);
  assert.equal(classifyResponse(res(429, { type: 'rate_limit_error' }), later, { state: 'cooling', until: first.until, backoffMs: 2000 })!.backoffMs, 4000);
  assert.equal(classifyResponse(res(429, { type: 'rate_limit_error' }), later, { state: 'cooling', until: first.until, backoffMs: 240_000 })!.backoffMs, 300_000);
});

test('spend caps and usage limits exhaust the account until the stated time or the 1st of next month', () => {
  const cap = classifyResponse(res(429, { type: 'rate_limit_error', message: 'cap', details: { error_code: 'enforced_spend_limit_reached' } }), now, ok)!;
  assert.deepEqual([cap.state, cap.until?.toISOString()], ['exhausted', '2026-11-01T00:00:00.000Z']);
  const stated = classifyResponse(res(400, { type: 'invalid_request_error', message: 'You have reached your specified API usage limits. You will regain access on 2026-10-15 at 00:00 UTC.' }), now, ok)!;
  assert.deepEqual([stated.state, stated.until?.toISOString()], ['exhausted', '2026-10-15T00:00:00.000Z']);
});

test('key checks change health only for results that say something about the key', () => {
  assert.equal(verdictOfCheck('invalid', now)?.state, 'invalid');
  assert.equal(verdictOfCheck('spend_limit', now)?.state, 'exhausted');
  assert.equal(verdictOfCheck('ok', now)?.state, 'ok');
  for (const r of ['rate_limited', 'unreachable', 'wrong_path', 'error', 'unknown'] as const) assert.equal(verdictOfCheck(r, now), null);
});

/* ---------- Outbox (foundation PRD §8) ---------- */

test('outbox output parses into sealed files and events, skipping torn or foreign lines', () => {
  const out = '\x1eaccount.17.pulling\n{"id":"1","type":"helper_run"}\nnot json\n{"no":"id"}\n\n\x1e../evil.pulling\n{"id":"2"}\n\x1emetrics.18.pulling\n{"id":"3"}\n';
  const { files, events } = parseOutbox(out);
  assert.deepEqual(files, ['account.17.pulling', 'metrics.18.pulling']);
  assert.deepEqual(events.map((e) => [e.channel, e.event.id]), [['account', '1'], ['metrics', '3']]);
});

test('pulls seal the outbox, deliver each event once (also after a restart), and delete what was stored', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-outbox-'));
  const box = join(root, 'outbox');
  mkdirSync(box);
  const script = join(root, 'outbox-pull');
  writeFileSync(script, outboxPullScript(box));
  chmodSync(script, 0o755);
  const runtime = {
    delivery: {
      state: async () => ({ exists: true, running: true }),
      run: async (_name: string, cmd: string) => {
        const r = await run('sh', ['-c', cmd.replace("'/etc/claudepilot/bin/outbox-pull'", script)]);
        return { code: 0, stdout: r.stdout, stderr: r.stderr };
      },
    },
  } as unknown as Runtime;
  const store = await Store.open({ dataDir: mkdtempSync(join(tmpdir(), 'cp-outbox-db-')), secretKey: parseSecretKey(generateSecretKey()) });
  const got: OutboxEvent[] = [];
  const subscribe = (o: Outbox) => o.subscribe('account', (_ws, events) => got.push(...events), () => ['docker/ws1']);

  const outbox = new Outbox(store, () => runtime);
  subscribe(outbox);
  writeFileSync(join(box, 'account.jsonl'), '{"id":"a1","type":"stop_failure"}\n{"id":"a2","type":"helper_run"}\n');
  await outbox.pull('docker/ws1');
  assert.deepEqual(got.map((e) => e.id), ['a1', 'a2']);
  assert.deepEqual(readdirSync(box).filter((f) => f.endsWith('.jsonl')), [], 'the live file was sealed');

  // A portal restart forgets which files it stored: they're read again, but nothing is delivered twice.
  const restarted = new Outbox(store, () => runtime);
  subscribe(restarted);
  writeFileSync(join(box, 'account.jsonl'), '{"id":"a3","type":"helper_run"}\n');
  await restarted.pull('docker/ws1');
  assert.deepEqual(got.map((e) => e.id), ['a1', 'a2', 'a3']);
  // The next pull deletes the files whose events are stored.
  await restarted.pull('docker/ws1');
  assert.deepEqual(readdirSync(box), []);
  store.close();
});

/* ---------- Detection, probes and failover (PRD §11.5, §12) ---------- */

/** A fake host: `GET /v1/models` always works; probes answer per key. Keys end in their organization. */
let server: Server;
let base = '';
let probes = 0;
const answer = new Map<string, { status: number; error?: object; headers?: Record<string, string> }>();
before(async () => {
  server = createServer((req, res) => {
    const key = String(req.headers['x-api-key'] ?? '');
    req.resume().on('end', () => {
      const org = key.split('-').pop()!;
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'anthropic-organization-id': org });
        return res.end('{"data":[]}');
      }
      probes++;
      const a = answer.get(key) ?? { status: 200 };
      res.writeHead(a.status, { 'content-type': 'application/json', ...a.headers });
      res.end(JSON.stringify(a.error ? { type: 'error', error: a.error } : { type: 'message', content: [] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const limited = (seconds: number) => ({ status: 429, error: { type: 'rate_limit_error', message: 'slow down' }, headers: { 'retry-after': String(seconds) } });
const revoked = { status: 401, error: { type: 'authentication_error', message: 'invalid x-api-key' } };

/** Three accounts in one pool, in this priority order (`a` and `c` share an organization), and one workspace on `a`. */
async function setup(opts: { spacingMs?: number } = {}) {
  answer.clear();
  const store = await Store.open({ dataDir: mkdtempSync(join(tmpdir(), 'cp-health-')), secretKey: parseSecretKey(generateSecretKey()) });
  const accounts = new AccountsService(store);
  const pools = new AccountPools(store, { jitterMs: () => 0 });
  const health = new AccountHealthService(store, { spacingMs: opts.spacingMs ?? 0 });
  accounts.hooks = {
    changed: (id, why) => pools.accountChanged(id, why),
    checked: (id, result, manual) => health.fromCheck(id, result, manual),
    poolsWith: (id) => pools.poolsWith(id),
  };
  health.onChange = (id, why, o) => pools.accountChanged(id, why, o);
  health.activeAccount = (ws) => pools.activeAccount(ws);
  const endpoint = accounts.createEndpoint({ name: 'Local', baseUrl: base, allowPrivateNetwork: true });
  const add = async (name: string, key: string) => (await accounts.create({ name, endpointId: endpoint.id, key, confirmOwned: true })).id;
  const a = await add('a', 'sk-test-key-a-org1');
  const c = await add('c', 'sk-test-key-c-org1');
  const b = await add('b', 'sk-test-key-b-org2');
  const pool = pools.create({ name: 'main', endpointId: endpoint.id, members: [a, c, b] });
  pools.assign('docker/ws1', { poolId: pool.id }, { existing: false });
  const ws = () => pools.stateFor('docker/ws1')!;
  const events = (type: string) => store.db!.prepare('SELECT * FROM account_events WHERE type = ?').all(type) as { account_id: string; details: string }[];
  return { store, accounts, pools, health, ids: { a, b, c }, ws, events };
}

const helperRun = (account: string, atMs: number, ppid = 4242) => ({ id: `${atMs}000000-${atMs % 1000}`, type: 'helper_run', account, ppid, empty: false });

test('a key rejected mid-session (the helper runs again within seconds) is confirmed by a probe and the workspace moves', async () => {
  const { store, health, ids, ws, events } = await setup();
  assert.equal(ws().accountId, ids.a);
  answer.set('sk-test-key-a-org1', revoked);
  const t = Date.now();
  health.onSignals('docker/ws1', [helperRun(ids.a, t), helperRun(ids.a, t + 1100)]);
  await until(() => ws().accountId !== ids.a);
  assert.equal(ws().accountId, ids.c, 'next account in priority order');
  assert.equal(ws().state, 'active');
  assert.equal((store.db!.prepare('SELECT health FROM accounts WHERE id = ?').get(ids.a) as { health: string }).health, 'invalid');
  assert.equal(events('failover').length, 1);
  store.close();
});

test('runs a cache lifetime apart, or with a delivery in between, are normal', async () => {
  const { store, health, ids, ws } = await setup();
  answer.set('sk-test-key-a-org1', revoked);
  const before = probes;
  const t = Date.now() - 120_000;
  store.db!.prepare("INSERT INTO workspace_delivery (workspace_id, status, applied_at) VALUES ('docker/ws1', 'synced', ?)").run(new Date(t + 500).toISOString());
  health.onSignals('docker/ws1', [helperRun(ids.a, t), helperRun(ids.a, t + 1000), helperRun(ids.a, t + 62_000)]);
  await sleep(100);
  assert.equal(probes, before, 'no probe');
  assert.equal(ws().accountId, ids.a);
  store.close();
});

test('a long rate limit moves the workspace to another organization; a short one is left to Claude Code', async () => {
  const short = await setup();
  answer.set('sk-test-key-a-org1', limited(30));
  short.health.onSignals('docker/ws1', [{ id: '1', type: 'stop_failure', error: 'rate_limit', account: short.ids.a }]);
  await until(() => short.events('health_changed').length === 1);
  await sleep(50);
  assert.equal(short.ws().accountId, short.ids.a, 'a 30 s cooldown keeps the workspace where it is');
  short.store.close();

  const long = await setup();
  answer.set('sk-test-key-a-org1', limited(300));
  long.health.onSignals('docker/ws1', [{ id: '1', type: 'stop_failure', error: 'rate_limit', account: long.ids.a }]);
  await until(() => long.ws().accountId !== long.ids.a);
  assert.equal(long.ws().accountId, long.ids.b, 'skips c, which shares a’s organization and limits');
  long.store.close();
});

test('with nowhere to go, the workspace keeps its key and waits for the earliest recovery, then moves when one is back', async () => {
  const { store, health, ids, ws } = await setup();
  answer.set('sk-test-key-c-org1', limited(600));
  answer.set('sk-test-key-b-org2', limited(900));
  await health.probe(ids.c, { reasons: ['test'] });
  await health.probe(ids.b, { reasons: ['test'] });
  answer.set('sk-test-key-a-org1', revoked);
  await health.probe(ids.a, { reasons: ['test'] });
  await until(() => ws().state === 'waiting');
  const cUntil = (store.db!.prepare('SELECT health_until FROM accounts WHERE id = ?').get(ids.c) as { health_until: string }).health_until;
  assert.equal(ws().accountId, ids.a, 'the last key stays in place');
  assert.equal(ws().waitingUntil, cUntil, 'earliest recovery in the pool');

  // c's cooldown ends and a probe finds it working: the waiting workspace moves there.
  store.db!.prepare('UPDATE accounts SET health_until = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), ids.c);
  answer.delete('sk-test-key-c-org1');
  await health.probe(ids.c, { reasons: ['cooldown ended'] });
  await until(() => ws().state === 'active');
  assert.equal(ws().accountId, ids.c);
  store.close();
});

test('a probe that finds the key working wins over the signal: nothing moves, and it is logged as unconfirmed', async () => {
  const { store, health, ids, ws, events } = await setup();
  health.onSignals('docker/ws1', [{ id: '1', type: 'stop_failure', error: 'server_error', account: ids.a }]);
  await until(() => events('signal_unconfirmed').length === 1);
  assert.equal(ws().accountId, ids.a);
  assert.equal(events('health_changed').length, 0);
  store.close();
});

test('cooldowns are never shortened by a probe alone; an admin re-check or clear ends them', async () => {
  const { store, health, ids } = await setup();
  const row = () => store.db!.prepare('SELECT health, health_until FROM accounts WHERE id = ?').get(ids.b) as { health: string; health_until: string };
  answer.set('sk-test-key-b-org2', limited(300));
  await health.probe(ids.b, { reasons: ['test'] });
  const first = row().health_until;
  answer.set('sk-test-key-b-org2', limited(10));
  await health.probe(ids.b, { reasons: ['test'] });
  assert.equal(row().health_until, first, 'until = max(old, new)');
  answer.delete('sk-test-key-b-org2');
  await health.probe(ids.b, { reasons: ['test'] });
  assert.equal(row().health, 'cooling', 'a success before the expiry does not end it');
  await health.probe(ids.b, { reasons: ['admin re-check'], manual: true });
  assert.equal(row().health, 'ok');

  answer.set('sk-test-key-b-org2', limited(300));
  await health.probe(ids.b, { reasons: ['test'] });
  health.clear(ids.b);
  assert.equal(row().health, 'ok');
  store.close();
});

test('probes are spaced a minute apart per account; signals in between share the next one', async () => {
  const { store, health, ids } = await setup({ spacingMs: 60_000 });
  const before = probes;
  health.requestProbe(ids.a, 'one');
  await until(() => probes === before + 1);
  health.requestProbe(ids.a, 'two');
  health.requestProbe(ids.a, 'three');
  await sleep(100);
  assert.equal(probes, before + 1);
  health.stop();
  store.close();
});
