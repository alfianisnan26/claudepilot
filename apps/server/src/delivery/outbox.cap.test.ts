// T-404 review 7: the outbox timer pulls at most MAX_CONCURRENT_PULLS workspaces at once (the guard channel covers many
// workspaces); the rest wait their turn in the same tick, and each is pulled once.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import type { Runtime } from '../workspaces/runtime.js';
import { MAX_CONCURRENT_PULLS, Outbox } from './outbox.js';

test('outbox: a tick pulls at most MAX_CONCURRENT_PULLS workspaces at once, and every one in the end', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-outbox-cap-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  let now = 0;
  let peak = 0;
  const asked: string[] = [];
  const waiting: (() => void)[] = [];
  const runtime = {
    delivery: {
      state: (name: string) =>
        new Promise((resolve) => {
          asked.push(name);
          now++;
          peak = Math.max(peak, now);
          waiting.push(() => {
            now--;
            resolve({ exists: true, running: false });
          });
        }),
    },
  } as unknown as Runtime;
  const outbox = new Outbox(store, () => runtime);
  const ids = Array.from({ length: 10 }, (_, i) => `docker/w${i}`);
  outbox.subscribe('guard', () => undefined, () => ids);
  mock.timers.enable({ apis: ['setInterval'] });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  try {
    outbox.start();
    mock.timers.tick(10_000);
    await settle();
    assert.equal(asked.length, MAX_CONCURRENT_PULLS, 'only the cap starts');
    // Release them one batch at a time until all ten were asked.
    while (waiting.length) {
      for (const release of waiting.splice(0)) release();
      await settle();
    }
    assert.deepEqual([...asked].sort(), ids.map((id) => id.slice('docker/'.length)).sort(), 'each pulled once');
    assert.equal(peak, MAX_CONCURRENT_PULLS);
  } finally {
    outbox.stop();
    mock.timers.reset();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// T-404 review 2, item 8: pulls slower than a tick must not starve the end of the list; who waited goes first.
test('outbox: a workspace left waiting by one tick is pulled before the list starts again', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-outbox-fair-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const asked: string[] = [];
  const waiting: (() => void)[] = [];
  const runtime = {
    delivery: {
      state: (name: string) =>
        new Promise((resolve) => {
          asked.push(name);
          waiting.push(() => resolve({ exists: true, running: false }));
        }),
    },
  } as unknown as Runtime;
  const outbox = new Outbox(store, () => runtime);
  const ids = Array.from({ length: 10 }, (_, i) => `docker/w${i}`);
  outbox.subscribe('guard', () => undefined, () => ids);
  mock.timers.enable({ apis: ['setInterval'] });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const release = async () => {
    for (const r of waiting.splice(0)) r();
    await settle();
  };
  try {
    outbox.start();
    mock.timers.tick(10_000);
    await settle();
    await release(); // w0-w3 done: w4-w7 start, w8 and w9 wait
    assert.deepEqual(asked, ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']);
    mock.timers.tick(10_000); // the next tick while w4-w7 still run
    await settle();
    await release();
    assert.deepEqual(asked.slice(8), ['w8', 'w9', 'w0', 'w1'], 'the two that waited go before the list starts again');
  } finally {
    outbox.stop();
    mock.timers.reset();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
