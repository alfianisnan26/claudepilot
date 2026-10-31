// .pilot/scripts/check.sh, the Check pipeline's step (owner, 2026-10-15: ClaudePilot on the Mac runner, falling back to the workspace). In a
// temporary repository with fake scripts/gate.sh and scripts/gate-job.sh: a push of documents only ends at once; on a runner (PILOT_RUNNER)
// the gate runs right there; in the workspace (the fallback) it goes to the cluster as a Job, never in the pod (D-61).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

/** The machine's git configuration (signing, hooks) stays out of the fixture. */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (cwd: string, cmd: string) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const tool = (path: string, body: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
};

/** A repository with the real check.sh and fake gate scripts that say how they were called; a base commit and a head that changes `files`. */
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'check-'));
  roots.push(root);
  mkdirSync(join(root, '.pilot/scripts'), { recursive: true });
  copyFileSync(join(REPO, '.pilot/scripts/check.sh'), join(root, '.pilot/scripts/check.sh'));
  tool(join(root, 'scripts/gate.sh'), 'echo "GATE HERE $*"');
  tool(join(root, 'scripts/gate-job.sh'), 'echo "GATE JOB $*"');
  // The run's clone has an origin whose branch head the step reads (a bare repository beside it).
  sh(root, `git init -q --bare ../${root.split('/').pop()}-origin.git`);
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  sh(root, 'git init -q -b integration && git add -A && git commit -qm base');
  const base = sh(root, 'git rev-parse HEAD');
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  sh(root, 'git add -A && git commit -qm head');
  const head = sh(root, 'git rev-parse HEAD');
  sh(root, `git remote add origin ../${root.split('/').pop()}-origin.git && git push -q origin HEAD:refs/heads/integration`);
  const run = (env: Record<string, string>) => spawnSync('bash', ['.pilot/scripts/check.sh'], { cwd: root, encoding: 'utf8', env: { ...GIT_ENV, PILOT_SHA: head, PILOT_BASE_SHA: base, ...env } });
  return { head, run, root };
}

test('a push of documents only ends at once: no gate here, no Job', () => {
  const f = fixture({ 'docs/dev-sessions/status/orchestrator.md': '# status\n', 'README.md': '# readme\n' });
  const r = f.run({ PILOT_RUNNER: 'mac/runner' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 changed file\(s\), all documents: nothing to gate/);
  assert.doesNotMatch(r.stdout, /GATE/);
});

test('on a runner (PILOT_RUNNER) the gate runs right there, on the run commit', () => {
  const f = fixture({ 'a.ts': 'export const a = 2;\n' });
  const r = f.run({ PILOT_RUNNER: 'mac/runner' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /on the runner mac\/runner/);
  assert.match(r.stdout, new RegExp(`GATE HERE ${f.head}`));
  assert.doesNotMatch(r.stdout, /GATE JOB/);
});

test('in the workspace (the fallback, no PILOT_RUNNER) the gate goes to the cluster as a Job, never here', () => {
  const f = fixture({ 'a.ts': 'export const a = 3;\n', 'docs/x.md': 'x\n' });
  const r = f.run({});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`GATE JOB ${f.head} typecheck,web-build,web-tests`));
  assert.doesNotMatch(r.stdout, /GATE HERE/);
});

test('a run whose commit is no longer the branch head ends at once: the newer commit has its own run', () => {
  const f = fixture({ 'a.ts': 'export const a = 4;\n' });
  const root = f.root;
  writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
  sh(root, 'git add -A && git commit -qm newer && git push -q origin HEAD:refs/heads/integration');
  const r = f.run({ PILOT_BRANCH: 'integration' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /superseded: integration is at/);
  assert.doesNotMatch(r.stdout, /GATE/);
});

test('with no base commit (a manual run) the gate always runs', () => {
  const f = fixture({ 'docs/only.md': 'x\n' });
  const r = f.run({ PILOT_BASE_SHA: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /GATE JOB/);
});

test('T-1609: in the workspace, a gate Job already in the cluster for this commit means no second Job; another commit\'s Job does not count', () => {
  const f = fixture({ 'a.ts': 'export const a = 5;\n' });
  const bin = join(f.root, '.fakebin');
  const withJobs = (names: string) => {
    tool(join(bin, 'kubectl'), `printf '%s\\n' ${names}`);
    return f.run({ PATH: `${bin}:${process.env.PATH}` });
  };
  const same = withJobs(`job.batch/claudepilot-gate-${f.head.slice(0, 7)}-a1b2 job.batch/claudepilot-job-0f`);
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /already in the cluster/);
  assert.doesNotMatch(same.stdout, /GATE JOB/);
  const other = withJobs('job.batch/claudepilot-gate-0000000-a1b2');
  assert.match(other.stdout, new RegExp(`GATE JOB ${f.head} typecheck,web-build,web-tests`));
});

test('T-2167: the gate Job for this commit is found even when kubectl is still writing the list after it (no pipefail race with grep -q)', () => {
  const f = fixture({ 'a.ts': 'export const a = 6;\n' });
  const bin = join(f.root, '.fakebin');
  // The matching name first, then more names a moment later: what a busy cluster's list looks like to a reader that stops at the first
  // match. Before T-2167, `kubectl | grep -q` under pipefail: grep quit, kubectl's next write failed, the pipeline read as "no Job".
  tool(join(bin, 'kubectl'), `printf '%s\\n' job.batch/claudepilot-gate-${f.head.slice(0, 7)}-a1b2\nsleep 0.3\nprintf '%s\\n' job.batch/claudepilot-job-0f job.batch/claudepilot-job-1f`);
  const r = f.run({ PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already in the cluster/);
  assert.doesNotMatch(r.stdout, /GATE JOB/);
});
