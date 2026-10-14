// T-OUT for the outbox pull (docs/prd/targets-connect.md §12.5): a workspace whose target is unreachable is logged once per outage, not
// once per pull, and logged again only after a pull succeeded in between.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { TargetUnreachableError, type Runtime } from '../workspaces/runtime.js';
import { Outbox } from './outbox.js';

test('outbox: an unreachable target is one log line per outage', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cx3-outbox-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  let down = true;
  const runtime = {
    delivery: {
      state: async () => {
        if (down) throw new TargetUnreachableError('cx3-t', '2026-10-12T14:02:00.000Z');
        return { exists: true, running: false };
      },
    },
  } as unknown as Runtime;
  const outbox = new Outbox(store, () => runtime);
  outbox.subscribe('account', () => undefined, () => ['cx3-t/w1']);
  // Only the outbox's own lines: Node prints its warnings through console.error too, and a run without
  // --disable-warning=ExperimentalWarning caught SQLite's and the MockTimers API's ExperimentalWarning here (they print a tick later).
  const lines: string[] = [];
  const error = mock.method(console, 'error', (l: unknown) => void (typeof l === 'string' && l.startsWith('[outbox]') && lines.push(l)));
  mock.timers.enable({ apis: ['setInterval'] });
  const settle = () => new Promise((r) => setImmediate(r));
  try {
    outbox.start();
    for (let i = 0; i < 3; i++) {
      mock.timers.tick(10_000);
      await settle();
    }
    assert.deepEqual(lines, ['[outbox] cx3-t/w1: Target unreachable (since 14:02)']);
    down = false;
    mock.timers.tick(10_000);
    await settle();
    down = true;
    mock.timers.tick(10_000);
    await settle();
    assert.equal(lines.length, 2, 'a new outage is a new line');
  } finally {
    outbox.stop();
    mock.timers.reset();
    error.mock.restore();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
