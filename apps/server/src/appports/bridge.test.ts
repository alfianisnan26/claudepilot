// T-948 S1 (docs/prd/app-ports.md §5): the bridge delivers every byte the app sent before it closed. The app writes 8 MiB and closes at once;
// the reader waits before it reads, so the bridge's stdout is backed up when the app's close arrives. A bridge that exits on that close
// without flushing loses the tail; this one must hand over all of it and exit 0.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { bridgeCommand } from './dial.js';

test('the bridge flushes everything the app sent before it closed, then exits 0', { timeout: 30_000 }, async () => {
  const SIZE = 8 * 1024 * 1024;
  const payload = Buffer.alloc(SIZE, 0x61);
  const app = createServer((s) => s.end(payload));
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const port = (app.address() as AddressInfo).port;
  try {
    const [, ...args] = bridgeCommand(port);
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.pause();
    const exited = new Promise<number | null>((r) => child.on('close', (c) => r(c)));
    await sleep(500); // the app has closed by now; the bridge's stdout is full
    let got = 0;
    child.stdout.on('data', (c: Buffer) => (got += c.length));
    child.stdout.resume();
    const code = await exited;
    assert.equal(got, SIZE, 'every byte arrived');
    assert.equal(code, 0);
    child.stdin.end();
  } finally {
    await new Promise((r) => app.close(r));
  }
});
