// T-ENR (docs/prd/targets-connect.md §19.3): tokens, their uses and refusals, the race for the last use, the status grace, rate limits, key
// validation and canaries, against a real SQLite store.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { isConnectToken } from '@portal/contracts';
import { AppError } from '@isnanme/core';
import { helloFor, openCore, wizard, type Core } from './testkit.js';
import { b64u } from './tunnel/auth.js';
import { randomBytes } from 'node:crypto';

const reasonOf = (e: unknown) => (e instanceof AppError ? `${e.status}:${(e.details as { reason?: string } | undefined)?.reason ?? e.code}` : String(e));
const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return reasonOf(e);
  }
  return 'no error';
};

/** Everything the portal wrote to disk for this core: the database and its journal files, as one string, to look for canaries in. */
const disk = (core: Core) =>
  readdirSync(core.dir)
    .filter((f) => /portal\.db/.test(f))
    .map((f) => readFileSync(join(core.dir, f)).toString('latin1'))
    .join('\n');

describe('tokens', () => {
  test('a token is cpen_ plus 43 characters and only its hash is stored', async () => {
    const core = await openCore();
    const w = wizard(core);
    assert.ok(isConnectToken(w.token));
    assert.equal(w.row.last4, w.token.slice(-4));
    assert.equal(w.row.tokenHash.length, 64);
    core.store.db!.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.ok(!disk(core).includes(w.token), 'the token is not in the database file');
    assert.ok(!JSON.stringify(w.enrollment).includes(w.token));
  });

  test('waiting, used, expired and revoked; the target stays pending until a node enrolls', async () => {
    const core = await openCore();
    const w = wizard(core, { ttlMinutes: 10 });
    assert.equal(w.enrollment.state, 'waiting');
    assert.equal(w.target.state, 'pending');
    const lookup = core.enrollments.lookup(w.token)!;
    assert.equal(lookup.usable, true);
    assert.equal(lookup.target.id, 'lab');
    core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '203.0.113.9');
    assert.equal(core.enrollments.list('lab')[0]!.state, 'used');
    assert.equal(core.registry.requireTarget('lab').state, 'active');
    // a second token that nobody uses runs out
    const w2 = wizard(core, { id: 'lab2', ttlMinutes: 10 });
    core.clock.now = new Date(core.clock.now.getTime() + 11 * 60_000);
    assert.equal(core.enrollments.list('lab2')[0]!.state, 'expired');
    assert.equal(core.enrollments.lookup(w2.token)!.usable, false);
    // revoked wins over everything
    const w3 = wizard(core, { id: 'lab3' });
    core.enrollments.revoke(w3.row, core.ctx);
    assert.equal(core.enrollments.list('lab3')[0]!.state, 'revoked');
    assert.deepEqual(core.enrollments.status(w3.token), { state: 'revoked' });
  });

  test('lookup and status do not use a token up', async () => {
    const core = await openCore();
    const w = wizard(core);
    for (let i = 0; i < 5; i++) {
      core.enrollments.lookup(w.token);
      core.enrollments.status(w.token);
    }
    assert.equal(core.enrollments.list('lab')[0]!.uses, 0);
    assert.deepEqual(core.enrollments.status(w.token), { state: 'waiting' });
    assert.equal(core.enrollments.lookup('cpen_notatoken'), null);
    assert.equal(core.enrollments.status(`cpen_${'A'.repeat(43)}`), null);
  });

  test('lifetimes and uses: a cluster hour, the wizard’s own, at most 24 hours and 50 uses; a single is always one use', async () => {
    const core = await openCore();
    const cluster = wizard(core, { id: 'c1' });
    assert.equal((Date.parse(cluster.row.expiresAt) - core.clock.now.getTime()) / 60_000, 60);
    const single = wizard(core, { id: 's1', kind: 'container', maxUses: 9 });
    assert.equal(single.row.maxUses, 1, 'a single is one use whatever was asked');
    assert.equal((Date.parse(single.row.expiresAt) - core.clock.now.getTime()) / 60_000, 15);
    const swarm = wizard(core, { id: 'sw', kind: 'swarm' });
    assert.equal(swarm.row.maxUses, 20);
    assert.throws(() => wizard(core, { id: 'c2', ttlMinutes: 1441 }), /ttlMinutes|Some fields/);
    assert.throws(() => wizard(core, { id: 'c3', maxUses: 51 }), /Some fields/);
    assert.equal(refused(() => wizard(core, { id: 'c4', ttlMinutes: 0 })), '422:VALIDATION_FAILED');
  });
});

describe('enroll', () => {
  test('a node comes out of one use: its key, fingerprint, a unique name, the audit rows with the address', async () => {
    const core = await openCore();
    const w = wizard(core);
    const keys = core.keys();
    const result = core.enrollments.enroll(w.token, { publicKey: keys.publicKey, hello: helloFor('docker') }, '198.51.100.7');
    assert.match(result.node, /^nd_[0-9a-f]{12}$/);
    assert.equal(result.target, 'lab');
    assert.equal(result.tunnel, 'wss://pilot.example.com/connect/v1/tunnel');
    assert.equal(result.protocol, 1);
    assert.equal(result.portalId, core.store.portalId);
    const node = core.registry.requireNode(result.node);
    assert.equal(node.name, 'lab-box');
    assert.equal(node.publicKey, keys.publicKey);
    assert.match(node.keyFingerprint, /^[0-9a-f]{32}$/);
    assert.equal(node.createdBy, 'u_owner');
    const events = core.events.list('lab');
    assert.deepEqual(events.map((e) => e.type).sort(), ['enrollment.created', 'enrollment.used', 'node.enrolled', 'target.created']);
    assert.equal(events.find((e) => e.type === 'node.enrolled')!.ip, '198.51.100.7');
    assert.equal(events.find((e) => e.type === 'node.enrolled')!.actor, `agent:${result.node}`);
    assert.equal(core.enrollments.status(w.token)!.state, 'enrolled');
    core.enrollments.useLive(() => true);
    assert.deepEqual(core.enrollments.status(w.token), { state: 'connected', node: result.node, target: 'lab' });
  });

  test('the second use of a spent token is token_used, and a refusal names its reason', async () => {
    const core = await openCore();
    const w = wizard(core);
    core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '198.51.100.7');
    assert.equal(refused(() => core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '198.51.100.8')), '401:token_used');
    const rejected = core.events.list('lab').filter((e) => e.type === 'enrollment.rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.ip, '198.51.100.8');
    assert.equal(rejected[0]!.detail.reason, 'token_used');
  });

  test('two enrolls racing for the last use: exactly one wins', async () => {
    const core = await openCore();
    const w = wizard(core);
    const attempts = await Promise.allSettled([1, 2, 3, 4].map(async (i) => core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker', { hostname: `box-${i}` }) }, `198.51.100.${i}`)));
    assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 1);
    assert.equal(core.registry.liveNodes('lab').length, 1);
    assert.equal(core.enrollments.list('lab')[0]!.uses, 1);
  });

  test('a cluster token enrolls up to its uses, names stay unique, then it is used up', async () => {
    const core = await openCore();
    const w = wizard(core, { maxUses: 3 });
    const names = [1, 2, 3].map((i) => core.registry.requireNode(core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, `198.51.100.${i}`).node).name);
    assert.deepEqual(names, ['lab-box', 'lab-box-2', 'lab-box-3']);
    assert.equal(refused(() => core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '198.51.100.9')), '401:token_used');
  });

  test('refusals: revoked, expired, wrong mode, bad keys, a plain-http address', async () => {
    const core = await openCore({ config: { allowHttp: true } });
    const w = wizard(core);
    assert.equal(refused(() => core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('host') }, '198.51.100.7')), '422:VALIDATION_FAILED');
    for (const bad of [b64u(randomBytes(31)), 'not a key', '', undefined as unknown as string]) {
      assert.equal(refused(() => core.enrollments.enroll(w.token, { publicKey: bad, hello: helloFor('docker') }, '198.51.100.7')), '422:bad_key');
    }
    assert.equal(refused(() => core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: null as never }, '198.51.100.7')), '422:VALIDATION_FAILED');
    core.enrollments.revoke(w.row, core.ctx);
    assert.equal(refused(() => core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '198.51.100.7')), '401:token_revoked');

    const w2 = wizard(core, { id: 'late', ttlMinutes: 5 });
    core.clock.now = new Date(core.clock.now.getTime() + 6 * 60_000);
    assert.equal(refused(() => core.enrollments.enroll(w2.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '198.51.100.7')), '401:token_expired');

    // an address that was fine when the target was made and is not now (the operator turned the allowance off)
    const lab = await openCore({ config: { allowHttp: true } });
    const target = lab.registry.createTarget({ kind: 'docker', platform: 'linux', id: 'plain', portalUrl: 'http://192.168.1.5:3000' }, null, lab.ctx);
    const made = lab.enrollments.create(target, { platform: 'linux' }, lab.ctx);
    lab.config.allowHttp = false;
    assert.equal(refused(() => lab.enrollments.enroll(made.token, { publicKey: lab.keys().publicKey, hello: helloFor('docker') }, '198.51.100.7')), '422:insecure_url');
  });

  test('a single has one node: a second token is refused at creation and at enroll until the first node is revoked', async () => {
    const core = await openCore();
    const a = wizard(core, { id: 'box', kind: 'container' });
    const b = core.enrollments.create(core.registry.requireTarget('box'), { platform: 'linux' }, core.ctx); // two tokens may exist before anyone enrolls
    const node = core.enrollments.enroll(a.token, { publicKey: core.keys().publicKey, hello: helloFor('container') }, '198.51.100.7').node;
    assert.equal(refused(() => core.enrollments.enroll(b.token, { publicKey: core.keys().publicKey, hello: helloFor('container') }, '198.51.100.8')), '409:target_enrolled');
    assert.equal(refused(() => core.enrollments.create(core.registry.requireTarget('box'), { platform: 'linux' }, core.ctx)), '409:target_enrolled');
    core.registry.revokeNode(node, 'lost', core.ctx);
    const c = core.enrollments.create(core.registry.requireTarget('box'), { platform: 'linux' }, core.ctx);
    assert.ok(core.enrollments.enroll(c.token, { publicKey: core.keys().publicKey, hello: helloFor('container') }, '198.51.100.9').node);
  });

  test('eleven wrong tokens from one address: the eleventh is 429; other addresses and right tokens are not blocked', async () => {
    const core = await openCore();
    const w = wizard(core);
    const wrong = `cpen_${b64u(randomBytes(32))}`;
    const results: string[] = [];
    for (let i = 0; i < 11; i++) results.push(refused(() => core.enrollments.enroll(wrong, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '192.0.2.1')));
    assert.deepEqual(results.slice(0, 10), Array(10).fill('401:token_invalid'));
    assert.equal(results[10], '429:RATE_LIMITED');
    assert.equal(refused(() => core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '192.0.2.1')), '429:RATE_LIMITED', 'blocked is blocked, even for a right token');
    assert.ok(core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '192.0.2.2').node, 'another address is fine');
    assert.equal(refused(() => core.enrollments.enroll(null, {}, '192.0.2.3')), '401:token_invalid');
  });

  test('used, expired and revoked tokens do not count as guesses', async () => {
    const core = await openCore();
    const w = wizard(core);
    core.enrollments.revoke(w.row, core.ctx);
    for (let i = 0; i < 15; i++) assert.equal(refused(() => core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '192.0.2.1')), '401:token_revoked');
  });

  test('a locked or frozen store refuses to enroll (503 store_locked) and the registry stays readable', async () => {
    const core = await openCore();
    const w = wizard(core);
    core.store.freeze('frozen-by-admin', 'test');
    assert.equal(refused(() => core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '192.0.2.1')), '503:store_locked');
    assert.equal(refused(() => wizard(core, { id: 'other' })), '503:store_locked');
    assert.equal(core.registry.targets().length, 1, 'reads still work');
    core.store.resume();
    assert.ok(core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '192.0.2.1').node);
  });
});

describe('status grace', () => {
  test('a spent token answers enroll/status for 30 minutes after its last use, and then not at all', async () => {
    const core = await openCore();
    const w = wizard(core);
    core.enrollments.enroll(w.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '192.0.2.1');
    core.clock.now = new Date(core.clock.now.getTime() + 29 * 60_000);
    assert.equal(core.enrollments.status(w.token)!.state, 'enrolled');
    core.clock.now = new Date(core.clock.now.getTime() + 2 * 60_000);
    assert.equal(core.enrollments.status(w.token), null);
  });

  test('an expired, never-used token says expired; a node revoked meanwhile says revoked', async () => {
    const core = await openCore();
    const w = wizard(core, { ttlMinutes: 1 });
    core.clock.now = new Date(core.clock.now.getTime() + 2 * 60_000);
    assert.deepEqual(core.enrollments.status(w.token), { state: 'expired' });
    const w2 = wizard(core, { id: 'two' });
    const node = core.enrollments.enroll(w2.token, { publicKey: core.keys().publicKey, hello: helloFor('docker') }, '192.0.2.1').node;
    core.registry.revokeNode(node, 'test', core.ctx);
    assert.equal(core.enrollments.status(w2.token)!.state, 'revoked');
  });
});

describe('canaries', () => {
  test('no token appears in any response, event, or file the portal wrote, after wrong, used and revoked attempts', async () => {
    const core = await openCore();
    const w = wizard(core);
    const attempts: string[] = [];
    const wrong = `cpen_${b64u(randomBytes(32))}`;
    for (const token of [wrong, w.token, w.token]) {
      try {
        core.enrollments.enroll(token, { publicKey: core.keys().publicKey, hello: helloFor('docker', { hostname: `box ${token}` }) }, '192.0.2.77');
      } catch (e) {
        attempts.push(JSON.stringify((e as AppError).toJSON?.() ?? String(e)));
      }
    }
    core.enrollments.revoke(core.enrollments.resolve('lab', w.row.id), core.ctx);
    const everything = [
      ...attempts,
      JSON.stringify(core.events.list('lab', { limit: 500 })),
      JSON.stringify(core.registry.view(core.registry.requireTarget('lab'))),
      JSON.stringify(core.enrollments.list('lab')),
    ].join('\n');
    assert.ok(!everything.includes(w.token), 'the real token is nowhere');
    assert.ok(!everything.includes(wrong), 'the wrong token is nowhere');
    core.store.db!.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.ok(!disk(core).includes(w.token));
    assert.ok(!disk(core).includes(wrong));
  });
});
