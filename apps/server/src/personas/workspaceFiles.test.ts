import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Runtime } from '../workspaces/runtime.js';
import { readWorkspaceFile } from './workspaceFiles.js';

// The one script the portal runs in a workspace on an agent's behalf (an avatar given by path), against a
// plain local shell standing in for the container: only a regular file within the cap comes back, never a link,
// a folder or a device, and the path travels on stdin, so nothing in it is ever read as a command.

const runtime = (): Runtime =>
  ({
    target: { id: 'docker', kind: 'docker' },
    delivery: {
      run: async (_name: string, script: string, opts: { stdin?: string } = {}) => {
        const r = spawnSync('sh', ['-c', script], { input: opts.stdin ?? '', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
      },
    },
  }) as unknown as Runtime;

const read = (path: string, max = 1024) => readWorkspaceFile((t) => (t === 'docker' ? runtime() : undefined), 'docker/ws', path, max);

test('only a plain file within the cap is read; links, folders, missing files and files over the cap are not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-wsfile-'));
  try {
    writeFileSync(join(dir, 'a.png'), Buffer.from([1, 2, 3, 250, 0, 255]));
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(2000, 7));
    writeFileSync(join(dir, 'secret.txt'), 'top secret');
    symlinkSync(join(dir, 'secret.txt'), join(dir, 'link.png'));
    mkdirSync(join(dir, 'folder.png'));
    assert.deepEqual(await read(join(dir, 'a.png')), Buffer.from([1, 2, 3, 250, 0, 255]), 'binary bytes survive');
    assert.equal(await read(join(dir, 'big.bin')), null, 'over the cap');
    assert.deepEqual((await read(join(dir, 'big.bin'), 4096))?.length, 2000);
    assert.equal(await read(join(dir, 'link.png')), null, 'a link is never followed');
    assert.equal(await read(join(dir, 'folder.png')), null, 'a folder is not a file');
    assert.equal(await read(join(dir, 'missing.png')), null);
    assert.equal(await read('/dev/zero'), null, 'a device is not a file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the path is data, never a command: quotes, substitutions and options in a name change nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-wsfile-'));
  try {
    const names = ['it\'s "quoted".png', 'a $(touch pwned).png', 'b `touch pwned`.png', '-n.png', 'c; touch pwned; .png', 'spaces in name.png'];
    for (const n of names) writeFileSync(join(dir, n), n);
    for (const n of names) assert.equal((await read(join(dir, n)))?.toString(), n, n);
    assert.equal((await read(join(dir, 'a $(touch pwned).png')))?.toString(), 'a $(touch pwned).png');
    assert.equal(spawnSync('sh', ['-c', `[ -e ${JSON.stringify(join(dir, 'pwned'))} ]`]).status, 1, 'nothing was executed');
    // A workspace that can't be reached or has no delivery access reads nothing.
    assert.equal(await readWorkspaceFile(() => undefined, 'docker/ws', join(dir, 'x'), 10), null);
    assert.equal(await readWorkspaceFile(() => ({ target: { id: 'k8s' } }) as unknown as Runtime, 'k8s/ws', join(dir, 'x'), 10), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
