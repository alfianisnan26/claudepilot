// QA-011: the knowledge module on a database it can't use must start, stay quiet and say why when asked.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { MIGRATIONS } from '../store/migrations.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { KnowledgeService } from './service.js';

const reason = (r: string) => (e: unknown) => (e as { reason?: string }).reason === r;
const key = () => parseSecretKey(generateSecretKey());

test('a database without the knowledge tables: start() and upkeep do nothing, reads are empty, writes say unavailable', async () => {
  const dir = tempDirectory('kg-old-');
  const store = await Store.open({ dataDir: dir, secretKey: key(), migrations: MIGRATIONS.filter((m) => m.version < 50) });
  const logs: string[] = [];
  const svc = new KnowledgeService(store, { dir: join(dir, 'knowledge'), log: (m) => logs.push(m) });
  assert.doesNotThrow(() => svc.start());
  assert.deepEqual(svc.list(), []);
  assert.throws(() => svc.create({ name: 'x' }), reason('UNAVAILABLE'));
  assert.throws(() => svc.summary('nope'), reason('UNAVAILABLE'));
  assert.throws(() => svc.getNote('nope', 'a.md'), reason('UNAVAILABLE'));
  await svc.maintain();
  svc.stop();
  store.close();
});

test('a frozen portal does not scan or upkeep in the background', async () => {
  const dir = tempDirectory('kg-frozen-');
  const store = await Store.open({ dataDir: dir, secretKey: key() });
  const logs: string[] = [];
  const svc = new KnowledgeService(store, { dir: join(dir, 'knowledge'), log: (m) => logs.push(m) });
  const v = svc.create({ name: 'Before' });
  svc.vault(v.id).writeNote('a.md', 'x', { actor: { id: 'ui', kind: 'user' }, create: true });
  svc.stop();
  store.freeze('frozen-by-admin', 'test');
  const again = new KnowledgeService(store, { dir: join(dir, 'knowledge'), log: (m) => logs.push(m) });
  again.start();
  await new Promise((r) => setTimeout(r, 100));
  // Nothing was opened by start(): the vault is only opened when someone asks for it.
  assert.equal(again.summary(v.id).indexState, 'scanning');
  await again.maintain();
  assert.deepEqual(logs, []);
  again.stop();
  store.close();
});

test('the service makes no folders until it needs them', async () => {
  const dir = tempDirectory('kg-lazy-');
  const store = await Store.open({ dataDir: dir, secretKey: key() });
  const svc = new KnowledgeService(store, { dir: join(dir, 'knowledge') });
  svc.start();
  assert.deepEqual((await import('node:fs')).existsSync(join(dir, 'knowledge')), false);
  svc.stop();
  store.close();
});
