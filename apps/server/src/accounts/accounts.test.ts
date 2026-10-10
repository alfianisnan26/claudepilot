import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ANTHROPIC_ENDPOINT_ID } from '@portal/contracts';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { forgetSecrets, Store } from '../store/store.js';
import { checkKey, classify, isPrivateAddress, normalizeBaseUrl, redact } from './check.js';
import { AccountsService, fingerprintOf, maskKey } from './service.js';

/** A fake Anthropic-compatible host: the key decides the answer. */
let server: Server;
let base = '';
const seen: { path: string; xApiKey?: string; auth?: string }[] = [];
before(async () => {
  server = createServer((req, res) => {
    const key = String(req.headers['x-api-key'] ?? '');
    seen.push({ path: req.url ?? '', xApiKey: key, auth: req.headers.authorization });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (key === 'sk-good-key-000001' || key === 'sk-good-key-000002')
      return json(200, { data: [{ id: 'gateway-large' }, { id: 'gateway-small' }] }, { 'anthropic-organization-id': 'org-123', 'anthropic-workspace-id': 'wrkspc-9' });
    if (key === 'sk-capped-key-0001')
      return json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'spend cap', details: { error_code: 'enforced_spend_limit_reached' } } });
    if (key === 'sk-throttled-key-1') return json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after': '3' });
    if (key === 'sk-echo-key-secret') return json(500, { type: 'error', error: { type: 'api_error', message: `bad key sk-echo-key-secret here` } });
    if (key === 'sk-slow-key-000001') return; // never answers
    return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const newKey = () => parseSecretKey(generateSecretKey());
async function service(secretKey: Buffer | null = newKey(), dataDir = mkdtempSync(join(tmpdir(), 'cp-acc-'))) {
  const store = await Store.open({ dataDir, secretKey });
  return { store, accounts: new AccountsService(store), dataDir };
}
const local = (accounts: AccountsService) => accounts.createEndpoint({ name: 'Local gateway', baseUrl: `${base}/v1/messages`, allowPrivateNetwork: true });

test('base URLs are stored without /, /v1 or /v1/messages, and only as plain http(s)', () => {
  assert.equal(normalizeBaseUrl('https://gw.example.com/'), 'https://gw.example.com');
  assert.equal(normalizeBaseUrl('https://gw.example.com/v1'), 'https://gw.example.com');
  assert.equal(normalizeBaseUrl('https://gw.example.com/api/v1/messages/'), 'https://gw.example.com/api');
  assert.throws(() => normalizeBaseUrl('ftp://gw.example.com'), /http or https/);
  assert.throws(() => normalizeBaseUrl('https://user:pw@gw.example.com'), /credentials/);
  assert.throws(() => normalizeBaseUrl('gw.example.com'), /full URL/);
});

test('private addresses are recognized', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '172.20.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])
    assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['1.1.1.1', '160.79.104.10', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('classification follows structured fields first', () => {
  const h = (o: Record<string, string> = {}) => new Headers(o);
  assert.equal(classify(200, {}, h()), 'ok');
  assert.equal(classify(401, {}, h()), 'invalid');
  assert.equal(classify(402, {}, h()), 'billing');
  assert.equal(classify(403, {}, h()), 'no_permission');
  assert.equal(classify(404, {}, h()), 'wrong_path');
  assert.equal(classify(429, { error: { details: { error_code: 'enforced_spend_limit_reached' } } }, h()), 'spend_limit');
  assert.equal(classify(429, { error: { message: 'slow down' } }, h({ 'retry-after': '3' })), 'rate_limited');
  assert.equal(classify(400, { error: { message: 'You have reached your specified API usage limits.' } }, h()), 'spend_limit');
  assert.equal(classify(529, { error: { type: 'overloaded_error' } }, h()), 'error');
});

test('provider text never keeps the key', () => {
  assert.equal(redact('bad sk-ant-api03-abcdefghijklmnopqrstuvwxyz key', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'), 'bad [redacted] key');
  assert.equal(redact('ends with ...mnopqrstuvwxyz', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'), 'ends with ...mn[redacted]', 'the last 12 characters are removed');
});

test('a check reports one result and sends the key in both headers', async () => {
  const ep = { baseUrl: base, allowPrivateNetwork: true };
  const ok = await checkKey(ep, 'sk-good-key-000001');
  assert.deepEqual([ok.result, ok.status, ok.organizationId, ok.anthropicWorkspaceId], ['ok', 200, 'org-123', 'wrkspc-9']);
  const last = seen.at(-1)!;
  assert.equal(last.path, '/v1/models?limit=1');
  assert.equal(last.xApiKey, 'sk-good-key-000001');
  assert.equal(last.auth, 'Bearer sk-good-key-000001');
  assert.equal((await checkKey(ep, 'sk-nope')).result, 'invalid');
  assert.equal((await checkKey(ep, 'sk-capped-key-0001')).result, 'spend_limit');
  assert.equal((await checkKey(ep, 'sk-throttled-key-1')).result, 'rate_limited');
  const echoed = await checkKey(ep, 'sk-echo-key-secret');
  assert.equal(echoed.result, 'error');
  assert.ok(!echoed.detail!.includes('sk-echo-key-secret'), 'the echoed key is redacted');
});

test('private hosts are refused unless the endpoint allows them', async () => {
  const refused = await checkKey({ baseUrl: base, allowPrivateNetwork: false }, 'sk-good-key-000001');
  assert.equal(refused.result, 'unreachable');
  assert.match(refused.detail!, /private address/);
});

test('keys are masked and fingerprinted, never more', () => {
  assert.equal(maskKey('sk-ant-api03-xyz-a1b2'), 'sk-ant-…a1b2');
  assert.equal(maskKey('gw-secret-9f8e'), '…9f8e');
  assert.equal(fingerprintOf('abc'), fingerprintOf('abc'));
  assert.notEqual(fingerprintOf('abc'), fingerprintOf('abd'));
});

test('adding an account seals the key, checks it, and never returns it', async () => {
  const { accounts, store } = await service();
  const ep = local(accounts);
  const account = await accounts.create({ name: 'Team gateway', endpointId: ep.id, key: 'sk-good-key-000001', confirmOwned: true });
  assert.equal(account.check.result, 'ok');
  assert.equal(account.organizationId, 'org-123');
  assert.equal(account.masked, '…0001');
  const overview = JSON.stringify(accounts.overview());
  assert.ok(!overview.includes('sk-good-key-000001'), 'the overview has no key');
  const row = store.db!.prepare('SELECT secret FROM accounts WHERE id = ?').get(account.id) as { secret: string };
  assert.match(row.secret, /^v1\./, 'stored sealed');
  store.close();
});

test('rules: ownership confirmation, unique names, unique keys', async () => {
  const { accounts, store } = await service();
  const ep = local(accounts);
  await assert.rejects(accounts.create({ name: 'A', endpointId: ep.id, key: 'sk-good-key-000001', confirmOwned: false }), /belongs to you/);
  await accounts.create({ name: 'A', endpointId: ep.id, key: 'sk-good-key-000001', confirmOwned: true });
  await assert.rejects(accounts.create({ name: 'a', endpointId: ep.id, key: 'sk-good-key-000002', confirmOwned: true }), /already exists/);
  await assert.rejects(accounts.create({ name: 'B', endpointId: ep.id, key: 'sk-good-key-000001', confirmOwned: true }), /already saved as “A”/);
  await assert.rejects(accounts.create({ name: 'C', endpointId: ep.id, key: 'has space', confirmOwned: true }), /no spaces/);
  store.close();
});

test('a failed check still saves the account', async () => {
  const { accounts, store } = await service();
  const ep = local(accounts);
  const account = await accounts.create({ name: 'Staged', endpointId: ep.id, key: 'sk-bad-key-00001', confirmOwned: true });
  assert.equal(account.check.result, 'invalid');
  assert.equal(accounts.overview().accounts.length, 1);
  store.close();
});

test('while the portal is Locked nothing secret can be stored or used', async () => {
  const { accounts, store } = await service(null);
  assert.ok(accounts.overview().locked);
  await assert.rejects(
    accounts.create({ name: 'A', endpointId: ANTHROPIC_ENDPOINT_ID, key: 'sk-ant-x', confirmOwned: true }),
    (e: { code?: string }) => e.code === 'LOCKED',
  );
  store.close();
});

test('updating: rename keeps the key; replacing the key re-checks it', async () => {
  const { accounts, store } = await service();
  const ep = local(accounts);
  const a = await accounts.create({ name: 'A', endpointId: ep.id, key: 'sk-bad-key-00001', confirmOwned: true });
  const renamed = await accounts.update(a.id, { name: 'Renamed', enabled: false });
  assert.equal(renamed.name, 'Renamed');
  assert.equal(renamed.enabled, false);
  assert.equal(renamed.fingerprint, a.fingerprint);
  const replaced = await accounts.update(a.id, { key: 'sk-good-key-000002' });
  assert.equal(replaced.check.result, 'ok');
  assert.notEqual(replaced.fingerprint, a.fingerprint);
  store.close();
});

test('bulk add creates valid lines at once and reports the rest', async () => {
  const { accounts, store } = await service();
  const ep = local(accounts);
  const result = accounts.bulkAdd({
    endpointId: ep.id,
    confirmOwned: true,
    lines: 'one|sk-good-key-000001\n\nno-bar-here\ntwo|sk-good-key-000002\nthree|sk-good-key-000001',
  });
  assert.deepEqual(result.created.map((a) => a.name), ['one', 'two']);
  assert.deepEqual(result.skipped.map((s) => s.line), [3, 5]);
  assert.equal(result.created[0]!.check.result, 'unknown', 'checked afterwards, in the background');
  store.close();
});

test('endpoints: built-in is fixed; a custom one with accounts cannot be removed; models import', async () => {
  const { accounts, store } = await service();
  assert.throws(() => accounts.updateEndpoint(ANTHROPIC_ENDPOINT_ID, { name: 'x' }), /built in/);
  const ep = local(accounts);
  assert.equal(ep.baseUrl, base);
  await assert.rejects(accounts.endpointModels(ep.id), /Add a key/);
  await accounts.create({ name: 'A', endpointId: ep.id, key: 'sk-good-key-000001', confirmOwned: true });
  assert.deepEqual(await accounts.endpointModels(ep.id), ['gateway-large', 'gateway-small']);
  assert.throws(() => accounts.removeEndpoint(ep.id), /Remove its 1 account/);
  store.close();
});

test('after forget-secrets the account stays but needs its key again', async () => {
  const { accounts, store, dataDir } = await service();
  const ep = local(accounts);
  const a = await accounts.create({ name: 'A', endpointId: ep.id, key: 'sk-good-key-000001', confirmOwned: true });
  store.close();
  const fresh = newKey();
  await forgetSecrets({ dataDir, newKey: fresh });
  const again = await service(fresh, dataDir);
  const account = again.accounts.overview().accounts.find((x) => x.id === a.id)!;
  assert.equal(account.hasSecret, false);
  await assert.rejects(again.accounts.check(a.id), /no key/);
  again.store.close();
});
