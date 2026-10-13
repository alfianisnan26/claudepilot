// scripts/scratch-portal.sh stop ends what a scratch portal started, not only the portal: chat hosts and `claude -p` run in sessions of
// their own and outlived it (2026-10-13, six orphans found). A stand-in process with the scratch home as HOME, in its own session, must be gone
// after `stop`; one outside it must not.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const SCRIPT = join(import.meta.dirname, '../../../../scripts/scratch-portal.sh');

test('stop ends the processes the scratch portal started (its home or folder), and nothing else', async () => {
  const port = 6700 + Math.floor(Math.random() * 600); // nothing listens there: only the strays are found
  const dir = `/tmp/scratch-portal-${port}`;
  mkdirSync(join(dir, 'home'), { recursive: true });
  const stray = spawn('setsid', ['sleep', '300'], { env: { ...process.env, HOME: join(dir, 'home') }, detached: true, stdio: 'ignore' });
  const inside = spawn('sleep', ['300'], { cwd: dir, detached: true, stdio: 'ignore' });
  const outside = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  stray.unref();
  inside.unref();
  outside.unref();
  await new Promise((r) => setTimeout(r, 300));
  try {
    const r = spawnSync('sh', [SCRIPT, 'stop', String(port)], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /stopped [23] process\(es\) the portal had started/);
    await new Promise((res) => setTimeout(res, 300));
    const gone = (pid: number) => spawnSync('sh', ['-c', `[ -d /proc/${pid} ] && ! grep -q '^State:.*Z' /proc/${pid}/status`]).status !== 0;
    assert.ok(gone(stray.pid!), 'the process with its home, in a session of its own, is gone');
    assert.ok(gone(inside.pid!), 'the process in its folder is gone');
    assert.ok(!gone(outside.pid!), 'a process outside it is untouched');
  } finally {
    for (const c of [stray, inside, outside]) {
      try {
        process.kill(c.pid!, 'SIGKILL');
      } catch {
        // gone already
      }
    }
  }
});
