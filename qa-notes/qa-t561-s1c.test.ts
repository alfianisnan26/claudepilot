// QA perf lane, T-561 S1c: symlink probes against the real hook command (not product code; run inside a Job clone only).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { leadHookCommand } from './leadRules.js';

const base = mkdtempSync('/var/tmp/qa561-');
const repo = join(base, 'repo');
mkdirSync(join(repo, 'docs/dev-sessions/status'), { recursive: true });
mkdirSync(join(repo, 'docs/dev-sessions/notes'), { recursive: true });
mkdirSync(join(repo, 'apps'));
const run = (file: string, tool = 'Write'): number | null =>
  spawnSync('sh', ['-c', leadHookCommand(repo)], { input: JSON.stringify({ tool_name: tool, tool_input: { file_path: file }, cwd: repo }) }).status;
const uniq = `${process.pid}-${Date.now()}`;

test('controls: apps refused, status and nested new status path allowed', () => {
  assert.equal(run(join(repo, 'apps/x.ts')), 2);
  assert.equal(run(join(repo, 'docs/dev-sessions/status/s.md')), 0);
  assert.equal(run(join(repo, 'docs/dev-sessions/status/new/deep/s.md')), 0);
});
test('A: dangling link in /tmp to a missing file in apps is refused', () => {
  const l = `/tmp/qa561-a-${uniq}`;
  symlinkSync(join(repo, 'apps/new.ts'), l);
  assert.equal(run(l), 2);
  rmSync(l);
});
test('A2: dangling RELATIVE link and a two-step chain to apps are refused', () => {
  const l1 = `/tmp/qa561-a2-${uniq}`;
  const l2 = `/tmp/qa561-a2b-${uniq}`;
  symlinkSync(`../${join(repo, 'apps/rel.ts').slice(1)}`, l1);
  symlinkSync(l1, l2);
  assert.equal(run(l1), 2);
  assert.equal(run(l2), 2);
  rmSync(l1);
  rmSync(l2);
});
test('A3: a link loop is refused; a dangling link to a missing file under /tmp stays allowed', () => {
  const a = `/tmp/qa561-loopa-${uniq}`;
  const b = `/tmp/qa561-loopb-${uniq}`;
  symlinkSync(b, a);
  symlinkSync(a, b);
  assert.equal(run(a), 2);
  rmSync(a);
  rmSync(b);
  const ok = `/tmp/qa561-ok-${uniq}`;
  symlinkSync(`/tmp/qa561-missing-${uniq}`, ok);
  assert.equal(run(ok), 0);
  rmSync(ok);
});
test('B: status being a link to apps allows nothing (apps and status/ both refused)', () => {
  rmSync(join(repo, 'docs/dev-sessions/status'), { recursive: true });
  symlinkSync(join(repo, 'apps'), join(repo, 'docs/dev-sessions/status'));
  assert.equal(run(join(repo, 'apps/y.ts')), 2);
  assert.equal(run(join(repo, 'docs/dev-sessions/status/y.ts')), 2);
  rmSync(join(repo, 'docs/dev-sessions/status'));
});
test('B2: notes being a dangling link into apps allows nothing', () => {
  rmSync(join(repo, 'docs/dev-sessions/notes'), { recursive: true });
  symlinkSync(join(repo, 'apps/not-yet'), join(repo, 'docs/dev-sessions/notes'));
  assert.equal(run(join(repo, 'docs/dev-sessions/notes/n.md')), 2);
  assert.equal(run(join(repo, 'apps/not-yet/n.md')), 2);
  rmSync(join(repo, 'docs/dev-sessions/notes'));
});
test('cleanup', () => rmSync(base, { recursive: true, force: true }));
