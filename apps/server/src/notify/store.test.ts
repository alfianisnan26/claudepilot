// What is kept and for how long (PWA PRD §11.8): history and log 30 days, used or expired answer tokens a day; the push keys are made
// once, sealed, and unreadable without the key.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../store/store.js';
import { harness } from './testkit.js';

test('retention: 30 days of Inbox and log, a day of spent tokens; pending tokens stay', async () => {
  let now = new Date('2026-10-12T00:00:00.000Z');
  const h = await harness({ now: () => now });
  h.notify.pipeline.start();
  h.bus.emit({ kind: 'ci_failed', subject: { type: 'ci_run', id: 'r1' }, facts: {}, at: '2026-10-12T00:00:00.000Z' });
  await new Promise((r) => setTimeout(r, 10));
  const d = h.notify.destinations.createChannel('u_a', { type: 'webhook', name: 'x', url: 'http://hooks.example.test/x' }).destination;
  h.notify.history.log('u_a', { eventId: 'evt_1', kind: 'ci_failed', destinationId: d.id, status: 'sent', code: null });
  const used = h.notify.actions.issue({ ownerId: 'u_a', destinationId: d.id, eventId: 'e', sessionId: 's', requestId: 'r', decisions: ['deny'], toolClass: 'command', request: { toolName: 'Bash', full: 'ls' } })!;
  h.store.db!.prepare('UPDATE notify_action_tokens SET used_at = ?').run(now.toISOString());
  now = new Date('2026-10-12T23:00:00.000Z');
  h.notify.actions.issue({ ownerId: 'u_a', destinationId: d.id, eventId: 'e', sessionId: 's', requestId: 'r2', decisions: ['deny'], toolClass: 'command', request: { toolName: 'Bash', full: 'ls' } });
  const count = (t: string) => (h.store.db!.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  now = new Date('2026-10-13T00:00:01.000Z'); // a day and a second after the first was used
  h.notify.history.sweep();
  assert.equal(count('notify_action_tokens'), 1, 'the used one went; the pending one (expires in 10 min) not yet a day old stays');
  assert.equal(count('notify_history'), 1);
  now = new Date('2026-11-11T00:00:01.000Z'); // 30 days and a second
  h.notify.history.sweep();
  assert.equal(count('notify_history'), 0);
  assert.equal(count('notify_log'), 0);
  assert.equal(count('notify_action_tokens'), 0);
  assert.ok(used.token);
  h.notify.pipeline.stop();
});

test('push keys: made once on first use, the private and topic keys sealed in the file, none without the key', async () => {
  const h = await harness();
  const k1 = h.notify.keys.keys()!;
  const k2 = h.notify.keys.keys()!;
  assert.equal(k1.publicKey.toString('base64url'), k2.publicKey.toString('base64url'));
  assert.equal(h.notify.keys.publicKey(), k1.publicKey.toString('base64url'));
  const pkcs8 = k1.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  h.store.db!.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const file = readFileSync(join(h.dataDir, 'portal.db')).toString('latin1');
  assert.ok(!file.includes(pkcs8));
  assert.ok(!file.includes(k1.topicKey.toString('base64url')));
  h.store.close();
  // the same database without its key: Locked, no keys, and the overview says so
  const locked = await Store.open({ dataDir: h.dataDir, secretKey: null });
  assert.equal(locked.secrets, null);
  const { NotifyKeys } = await import('./vapid.js');
  assert.equal(new NotifyKeys(locked).keys(), null);
  assert.equal(new NotifyKeys(locked).publicKey(), k1.publicKey.toString('base64url'), 'the public key is public');
  locked.close();
});
