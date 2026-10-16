// T-416 (D-61): the memory probe reads anon + active_file against memory.max from the workspace's cgroup, never memory.current (which
// counts the page cache the kernel gives back first). The cgroup files are faked in a temporary folder and the real `sh` script reads them.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MEMORY_PROBE, parseMemoryProbe, readWorkspaceMemory } from './memory.js';

const GiB = 1024 ** 3;

/** The probe run here as the runtime's exec would run it in a workspace: `sh -c <probe> sh <root>`, to its end. */
const run = (command: string[]) =>
  new Promise<{ code: number | null; output: string }>((resolve) => {
    execFile(command[0]!, command.slice(1), { timeout: 10_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });

function fakeCgroup(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cp-cgroup-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

/** 2026-10-15 02:52 UTC as comment 2778 measured it: memory.current 6.8 GiB of 8, anon 1.75 GiB, file 4.8 GiB, inactive_file 4.3 GiB. */
const stat = (anon: number, active: number, inactive: number) =>
  [`anon ${anon}`, `file ${active + inactive}`, `kernel 1000`, `active_anon 10`, `inactive_anon ${anon - 10}`, `active_file ${active}`, `inactive_file ${inactive}`, 'anon_thp 0'].join('\n') + '\n';

test('T-416: the probe reads anon + active_file against memory.max, never memory.current', async () => {
  const anon = Math.round(1.75 * GiB);
  const active = Math.round(0.5 * GiB);
  const dir = fakeCgroup({ 'memory.max': `${8 * GiB}\n`, 'memory.current': `${Math.round(6.8 * GiB)}\n`, 'memory.stat': stat(anon, active, Math.round(4.3 * GiB)) });
  try {
    const r = await readWorkspaceMemory(run, { root: dir, now: () => 42 });
    assert.ok(r, 'a reading');
    assert.equal(r.limitBytes, 8 * GiB);
    assert.equal(r.anonBytes, anon);
    assert.equal(r.activeFileBytes, active);
    assert.equal(r.usedBytes, anon + active, 'anon + active_file');
    assert.notEqual(r.usedBytes, Math.round(6.8 * GiB), 'not memory.current');
    assert.equal(r.at, 42);
    // The five largest processes of this machine, by name and MB only (this test's own node is one of them at least).
    assert.ok(r.top.length >= 1 && r.top.length <= 5, JSON.stringify(r.top));
    for (const p of r.top) {
      assert.match(p.name, /^[\w.@+:?-]{1,32}$/, 'a process name, never a command line');
      assert.ok(Number.isInteger(p.mb) && p.mb >= 0);
    }
    assert.deepEqual([...r.top].sort((a, b) => b.mb - a.mb), r.top, 'largest first');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T-416: no limit, or no cgroup v2 memory files, is an unavailable reading (null), not zero', async () => {
  const unlimited = fakeCgroup({ 'memory.max': 'max\n', 'memory.stat': stat(GiB, GiB, GiB) });
  const empty = fakeCgroup({});
  const noStat = fakeCgroup({ 'memory.max': `${8 * GiB}\n`, 'memory.current': `${GiB}\n` });
  try {
    assert.equal(await readWorkspaceMemory(run, { root: unlimited }), null, 'memory.max says max');
    assert.equal(await readWorkspaceMemory(run, { root: empty }), null, 'no files (cgroup v1, or the root cgroup)');
    assert.equal(await readWorkspaceMemory(run, { root: noStat }), null, 'memory.current alone is never used');
  } finally {
    for (const d of [unlimited, empty, noStat]) rmSync(d, { recursive: true, force: true });
  }
});

test('T-416: an exec that fails is an unavailable reading', async () => {
  assert.equal(await readWorkspaceMemory(async () => ({ code: null, output: '' })), null, 'timed out');
  assert.equal(await readWorkspaceMemory(async () => ({ code: 127, output: 'sh: not found' })), null);
});

test('T-416: the parser keeps names clipped to safe characters and at most five processes', () => {
  const out = ['max 1000', 'anon 100', 'active_file 50', ...Array.from({ length: 7 }, (_, i) => `proc ${(i + 1) * 1024} na me/${i}`)].join('\n');
  const r = parseMemoryProbe(out, 1)!;
  assert.equal(r.usedBytes, 150);
  assert.equal(r.top.length, 5);
  assert.deepEqual(r.top[0], { name: 'na?me?4', mb: 5 });
  assert.equal(parseMemoryProbe('max 1000\nanon 100\n', 1), null, 'active_file missing');
  assert.equal(parseMemoryProbe(`none\n`, 1), null);
  assert.ok(MEMORY_PROBE.includes('memory.stat') && !MEMORY_PROBE.includes('memory.current') && !MEMORY_PROBE.includes('cmdline'));
});
