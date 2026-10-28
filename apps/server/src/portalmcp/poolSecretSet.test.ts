import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { PROTECTED_POOL_REASON, secretExposeDefault, unexposedEnvSecrets, WRITE_ONLY_MASK, writeOnlyArgsOf } from '@portal/contracts';
import { secretsHarness } from '../secrets/testkit.js';
import { portalTools } from './registry.js';
import { portalMcpHarness } from './testkit.js';
import { registerPoolTools } from './tools/pools.js';

// T-2866 (PILOT-996 S3): secrets pools are write-only over Portal MCP. pool_secret_set takes a value and never gives it back: not in its
// result, not in the audit row, not in pool_get or pool_list. An agent reaches only the pools of its own workspace, and a protected pool
// is refused. Every value here is built at run time (no token-shaped literal in the repository).

const value = () => `v-${randomBytes(16).toString('hex')}`;

const s = await secretsHarness();
const h = await portalMcpHarness({ registry: portalTools });
registerPoolTools({ store: s.store, module: h.module, workspaces: { list: async () => [] }, poolService: s.service } as never);
after(() => {
  h.done();
  s.done();
});

const WS = 'docker/own';
const OTHER = 'docker/other';
const own = s.service.create('secrets', { name: 'own-keys', content: { entries: [{ kind: 'variable', name: 'REGION', value: 'eu' }] } });
s.service.setAssignments(WS, 'secrets', [{ poolId: own.id }]);
const elsewhere = s.service.create('secrets', { name: 'other-keys', content: { entries: [] } });
s.service.setAssignments(OTHER, 'secrets', [{ poolId: elsewhere.id }]);
const prd = s.service.create('secrets', { name: 'konfersi-prd', content: { entries: [] } });
const marked = s.service.create('secrets', { name: 'billing', description: 'Live billing keys [protected]', content: { entries: [] } });
const shared = s.service.create('secrets', { name: 'shared-keys', content: { entries: [] } });
s.service.setAssignments('docker/third', 'secrets', [{ poolId: shared.id }]);

type Out = { result?: { isError?: boolean; structuredContent?: any; content?: { text: string }[] } };
const sc = (r: Out) => r.result?.structuredContent;
const code = (r: Out) => sc(r)?.error?.code as string | undefined;
const textOf = (r: Out) => r.result?.content?.map((c) => c.text).join('\n') ?? '';
let n = 0;
/** A fresh agent session in a workspace: each has its own rate limit. */
const agent = async (ws = WS) => (await h.agentToken(ws, `sess-${++n}`)).secret;

test('set, then get: the value is never shown, only the name and a fingerprint', async () => {
  const v = value();
  const a = await agent();
  const set = await h.call(a, 'pool_secret_set', { pool: 'own-keys', name: 'API_KEY', value: v, note: 'first key' });
  assert.equal(set.result?.isError, undefined, textOf(set));
  const out = sc(set);
  assert.equal(out.name, 'API_KEY');
  assert.match(out.fingerprint, /^[0-9a-f]{8}$/);
  assert.equal(out.revision, 2, 'a new revision');
  assert.ok(!JSON.stringify(set).includes(v), 'the tool result has no value');
  assert.ok(!JSON.stringify(set).includes(v.slice(-4)), 'nor its last characters (the hint)');

  const admin = h.token('admin').secret;
  for (const r of [await h.call(admin, 'pool_get', { id: own.id }), await h.call(admin, 'pool_list', { type: 'secrets' })]) {
    const all = JSON.stringify(r);
    assert.ok(!all.includes(v), 'no read shows the value');
    assert.ok(!all.includes(v.slice(-4)), 'nor its hint');
  }
  const got = sc(await h.call(admin, 'pool_get', { id: own.id }));
  const entry = got.content.entries.find((e: { name: string }) => e.name === 'API_KEY');
  assert.equal(entry.secret.fingerprint, out.fingerprint);
  assert.equal(entry.secret.hint, undefined);
  assert.ok(got.content.entries.some((e: { name: string }) => e.name === 'REGION'), 'the other entries stay');

  // A second set replaces the value as a new version, under the same entry.
  const again = sc(await h.call(a, 'pool_secret_set', { pool: own.id, name: 'API_KEY', value: value() }));
  assert.equal(again.version, 2);
  assert.notEqual(again.fingerprint, out.fingerprint);
});

test('the audit row and the transcript of the call hold no value, and a key-shaped value is not refused as an argument', async () => {
  const v = `${['gh', 'p_'].join('')}${randomBytes(18).toString('hex')}`;
  const a = await agent();
  const set = await h.call(a, 'pool_secret_set', { pool: 'own-keys', name: 'GH_TOKEN', value: v });
  assert.equal(set.result?.isError, undefined, textOf(set));
  const rows = h.module.audit.list({ tool: 'pool_secret_set', limit: 50 });
  assert.ok(rows.length >= 1);
  assert.ok(!JSON.stringify(rows).includes(v), 'no audit row holds the value');
  assert.ok(JSON.stringify(rows).includes(WRITE_ONLY_MASK), 'the value is shown as masked');
  assert.ok(JSON.stringify(rows).includes('GH_TOKEN'), 'the other arguments stay readable');
  assert.deepEqual(writeOnlyArgsOf('mcp__pilot__pool_secret_set'), ['value']);
});

test('expose defaults to true for an environment-style name and false otherwise; a given expose wins', async () => {
  const a = await agent();
  assert.equal(sc(await h.call(a, 'pool_secret_set', { pool: 'own-keys', name: 'DB_PASSWORD', value: value() })).expose, true);
  assert.equal(sc(await h.call(a, 'pool_secret_set', { pool: 'own-keys', name: 'id_rsa', value: value() })).expose, false);
  assert.equal(sc(await h.call(a, 'pool_secret_set', { pool: 'own-keys', name: 'QUIET_KEY', value: value(), expose: false })).expose, false);
  assert.equal(secretExposeDefault('PATH'), false, 'a reserved name is never exposed by default');
  assert.equal(secretExposeDefault('ANTHROPIC_API_KEY'), false);
});

test('pool_get and pool_list warn about an environment-style secret stored without expose (T-2823)', async () => {
  const admin = h.token('admin').secret;
  const got = sc(await h.call(admin, 'pool_get', { id: own.id }));
  assert.ok(got.pool.warnings?.some((w: string) => w.includes('QUIET_KEY')), JSON.stringify(got.pool));
  assert.ok(!got.pool.warnings.some((w: string) => /\bid_rsa\b|DB_PASSWORD/.test(w)), 'a file name and an exposed name are fine');
  const listed = sc(await h.call(admin, 'pool_list', { type: 'secrets' })).pools.find((p: { id: string }) => p.id === own.id);
  assert.ok(listed.warnings.some((w: string) => w.includes('QUIET_KEY')));
  assert.deepEqual(unexposedEnvSecrets({ entries: [{ kind: 'secret', name: 'K_ONE', options: {} }, { kind: 'variable', name: 'V_ONE', value: 'x' }] }), ['K_ONE']);
});

test('a protected pool is refused with the reason, by name or by its [protected] mark, for an admin token too', async () => {
  const admin = h.token('admin').secret;
  for (const pool of [prd.id, marked.id]) {
    const r = await h.call(admin, 'pool_secret_set', { pool, name: 'API_KEY', value: value() });
    assert.equal(code(r), 'PROTECTED');
    assert.match(textOf(r), new RegExp(PROTECTED_POOL_REASON.replace(/[()]/g, '\\$&')));
  }
  assert.equal(s.service.get(prd.id).latestRevision, 1, 'nothing was written');
  assert.equal(s.service.get(marked.id).latestRevision, 1);
});

test('another workspace’s pool is the same not found as one that does not exist; a shared pool is refused', async () => {
  const a = await agent();
  const missing = await h.call(a, 'pool_secret_set', { pool: 'no-such-pool', name: 'API_KEY', value: value() });
  const other = await h.call(a, 'pool_secret_set', { pool: 'other-keys', name: 'API_KEY', value: value() });
  const otherById = await h.call(a, 'pool_secret_set', { pool: elsewhere.id, name: 'API_KEY', value: value() });
  const prdFromAgent = await h.call(a, 'pool_secret_set', { pool: prd.id, name: 'API_KEY', value: value() });
  assert.equal(code(missing), 'NOT_FOUND');
  assert.equal(code(other), 'NOT_FOUND');
  assert.equal(textOf(other), textOf(missing).replace('no-such-pool', 'other-keys'), 'the same answer');
  assert.equal(code(otherById), 'NOT_FOUND');
  assert.equal(code(prdFromAgent), 'NOT_FOUND', 'a protected pool the agent can’t reach does not say it is protected');
  assert.equal(s.service.get(elsewhere.id).latestRevision, 1, 'nothing was written');

  // A pool its workspace shares with another is refused: a value set there would change the other workspace's credential.
  s.service.setAssignments(WS, 'secrets', [{ poolId: own.id }, { poolId: shared.id }]);
  try {
    assert.equal(code(await h.call(a, 'pool_secret_set', { pool: 'shared-keys', name: 'API_KEY', value: value() })), 'SHARED_POOL');
  } finally {
    s.service.setAssignments(WS, 'secrets', [{ poolId: own.id }]);
  }

  // An operate token is not enough; an admin token may write to any pool that is not protected.
  assert.equal(code(await h.call(h.token('operate').secret, 'pool_secret_set', { pool: own.id, name: 'API_KEY', value: value() })), 'NOT_FOUND');
  assert.equal(sc(await h.call(h.token('admin').secret, 'pool_secret_set', { pool: elsewhere.id, name: 'API_KEY', value: value() })).name, 'API_KEY');
});

test('reading a value stays impossible: no tool returns one, and pool_update and pool_delete stay refused for secrets', async () => {
  const v = value();
  const admin = h.token('admin').secret;
  assert.equal(sc(await h.call(admin, 'pool_secret_set', { pool: own.id, name: 'READ_ME', value: v })).name, 'READ_ME');
  const reads = [
    await h.call(admin, 'pool_get', { id: own.id }),
    await h.call(admin, 'pool_get', { id: 'own-keys' }),
    await h.call(admin, 'pool_list', {}),
    await h.call(admin, 'pool_types', {}),
  ];
  for (const r of reads) assert.ok(!JSON.stringify(r).includes(v));
  assert.equal(code(await h.call(admin, 'pool_update', { id: own.id, base_revision: s.service.get(own.id).latestRevision, content: { entries: [] } })), 'UI_ONLY');
  assert.equal(code(await h.call(admin, 'pool_delete', { id: own.id })), 'UI_ONLY');
  // Nothing an agent can call reads a pool's content: pool_get and pool_list are not offered to its token.
  const a = await agent();
  const listed = new Set<string>((await h.rpc(a, 'tools/list')).body.result.tools.map((t: { name: string }) => t.name));
  assert.ok(listed.has('pool_secret_set'));
  assert.ok(!listed.has('pool_get') && !listed.has('pool_list'));
});

test('pool_create makes a secrets pool from names only; a value in it is refused', async () => {
  const admin = h.token('admin').secret;
  const made = sc(await h.call(admin, 'pool_create', { type: 'secrets', name: 'fresh-keys', content: { names: ['NEW_KEY', 'cert.pem'] } }));
  assert.deepEqual(made.secrets_missing, ['NEW_KEY', 'cert.pem']);
  const entries = s.service.get(made.pool.id).content as { entries: { name: string; options?: { expose?: boolean }; secret?: unknown }[] };
  assert.deepEqual(entries.entries.map((e) => [e.name, e.options?.expose === true, e.secret ?? null]), [['NEW_KEY', true, null], ['cert.pem', false, null]]);
  const v = value();
  const refused = await h.call(admin, 'pool_create', { type: 'secrets', name: 'bad-keys', content: { entries: [{ kind: 'secret', name: 'K', newValue: v }] } });
  assert.equal(code(refused), 'VALIDATION_FAILED');
  assert.ok(!JSON.stringify(refused).includes(v), 'the refusal does not echo the value');
  assert.ok(!s.service.list('secrets').some((p) => p.name === 'bad-keys'));
});
