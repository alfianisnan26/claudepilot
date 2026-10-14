// cp-ci against real git and a real shell, in a temporary home folder (no Docker). The Docker workspace run is the manual
// check in the PRD (§18); this proves the mechanics: hooks, events, plans, supervision, caps and the merge.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CP_CI } from '../runner.generated.js';
import { buildRunner } from './build.js';
import { Home, job, plan, runnerText, step } from './testkit.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pending = (h: Home) => h.ci(['poll']).then((p) => p.events as { id: string; repo: string; kind: string; ref: string; old: string; new: string; via: string }[]);
const logOf = (h: Home, runId: string, jobId: string, n: number) => readFileSync(join(h.home, '.claudepilot/ci/runs', runId, 'logs', jobId, `${n}.log`), 'utf8');

test('the generated runner is what the source builds, here and in the image folder', () => {
  assert.equal(CP_CI, buildRunner(), 'run: npm run gen:ci-runner -w @portal/server');
  const baked = join(new URL('../../../../../images/workspace/cp-ci', import.meta.url).pathname);
  assert.equal(readFileSync(baked, 'utf8'), CP_CI, 'images/workspace/cp-ci differs from the generated runner: npm run gen:ci-runner -w @portal/server');
  assert.ok(CP_CI.startsWith('#!/usr/bin/env node\n'));
  assert.ok(!/require\((['"])(?!node:)[a-z@]/.test(CP_CI), 'only Node built-ins');
  assert.equal(runnerText(), CP_CI);
});

test('a remote: made from a repository, connected, hooked, listed; names and paths are checked', async () => {
  const h = new Home();
  const src = h.repo('app');
  h.git(['checkout', '-q', '-b', 'feature/x'], src);
  h.commit(src, { 'x.txt': 'x' }, 'x');
  const made = await h.ci(['repo', 'create', 'app', '--from', src, '--connect']);
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.hook, 'ok');
  assert.equal(made.branches, 2);
  assert.ok(['main', 'feature/x'].includes(made.defaultBranch as string));
  assert.equal(h.git(['remote', 'get-url', 'pilot'], src), join(h.home, '.claudepilot/git/app.git'));
  assert.equal(h.git(['remote'], join(h.home, '.claudepilot/git/app.git')) , '', 'the bare clone does not keep the source as a remote');
  const hook = readFileSync(join(h.home, '.claudepilot/git/app.git/hooks/post-receive'), 'utf8');
  assert.match(hook, /^#!\/bin\/sh\n/);
  assert.ok(hook.includes(`'${h.script}' hook post-receive >/dev/null 2>&1 || true`));
  assert.equal((statSync(join(h.home, '.claudepilot/git/app.git/hooks/post-receive')).mode & 0o111) !== 0, true);

  const list = await h.ci(['repo', 'list']);
  assert.deepEqual((list.repos as { name: string; hook: string }[]).map((r) => [r.name, r.hook]), [['app', 'ok']]);

  // Tampering with the hook shows as outdated and is repaired by ensure.
  writeFileSync(join(h.home, '.claudepilot/git/app.git/hooks/post-receive'), '#!/bin/sh\nexit 0\n');
  assert.equal(((await h.ci(['poll'])).repos as { hook: string }[])[0]!.hook, 'outdated');
  assert.equal((await h.ci(['repo', 'ensure', 'app'])).hook, 'ok');

  for (const bad of ['../x', 'A', 'x.git', 'a..b', '', '-x', 'x'.repeat(65)]) assert.equal((await h.ci(['repo', 'create', bad])).error, 'bad_name', bad);
  assert.equal((await h.ci(['repo', 'create', 'app'])).error, 'exists');
  assert.equal((await h.ci(['repo', 'create', 'z', '--from', '/etc'])).error, 'bad_path');
  assert.equal((await h.ci(['repo', 'create', 'z', '--from', join(h.home, '.claudepilot')])).error, 'bad_path');
  assert.equal((await h.ci(['repo', 'create', 'z', '--from', 'relative'])).error, 'bad_path');
  assert.equal((await h.ci(['repo', 'create', 'z', '--from', join(h.home, 'work')])).error, 'not_a_repo');
  assert.equal(existsSync(join(h.home, '.claudepilot/git/z.git')), false, 'a failed create leaves nothing behind');
  assert.equal((await h.ci(['repo', 'create', 'e', '--bogus'])).error, 'bad_flag');

  // An empty remote, and connecting a second working repository.
  assert.equal((await h.ci(['repo', 'create', 'empty', '--branch', 'trunk'])).defaultBranch, 'trunk');
  const other = h.repo('other');
  assert.equal((await h.ci(['repo', 'connect', 'empty', other])).action, 'added');
  assert.equal((await h.ci(['repo', 'connect', 'empty', other])).action, 'unchanged');
  assert.equal((await h.ci(['repo', 'connect', 'app', other])).action, 'updated');
  assert.equal((await h.ci(['repo', 'delete', 'empty'])).ok, true);
  assert.equal(existsSync(join(h.home, '.claudepilot/git/empty.git')), false);
  assert.equal((await h.ci(['repo', 'delete', '../work'])).error, 'bad_name');
});

test('a push writes one event per ref update, and odd ref names never become events or commands', async () => {
  const h = new Home();
  const src = h.repo('app');
  await h.ci(['repo', 'create', 'app', '--from', src, '--connect']);
  assert.deepEqual(await pending(h), [], 'cloning fired nothing');

  h.git(['checkout', '-q', '-b', 'ticket/12-login'], src);
  const sha = h.commit(src, { 'a.txt': 'a' }, 'a');
  h.git(['push', '-q', 'pilot', 'ticket/12-login'], src);
  const [ev, ...rest] = await pending(h);
  assert.equal(rest.length, 0);
  assert.deepEqual([ev!.repo, ev!.kind, ev!.ref, ev!.new, ev!.via], ['app', 'push', 'refs/heads/ticket/12-login', sha, 'push']);
  assert.equal(ev!.old, '0'.repeat(40));
  assert.match(ev!.id, /^\d{10,16}-[0-9a-f]{8}$/);

  // Several refs in one push are several events; a tag and a deletion too.
  h.git(['checkout', '-q', '-b', 'two'], src);
  h.commit(src, { 'b.txt': 'b' }, 'b');
  h.git(['tag', 'v1.0'], src);
  h.git(['push', '-q', 'pilot', 'two', 'v1.0', 'main'], src);
  h.git(['push', '-q', 'pilot', '--delete', 'two'], src);
  const all = await pending(h);
  assert.deepEqual(all.map((e) => `${e.kind} ${e.ref}`).sort(), ['delete refs/heads/two', 'push refs/heads/two', 'push refs/tags/v1.0', 'push refs/heads/ticket/12-login'].sort(), 'a ref that did not move (main) is not an event');

  // Acknowledged events move away and are not listed again; a made-up id does nothing.
  const ids = all.map((e) => e.id);
  assert.equal((await h.ci(['poll', '--ack', `${ids.join(',')},../etc,nope`])).acked, ids.length);
  assert.deepEqual(await pending(h), []);
  assert.equal(readdirSync(join(h.home, '.claudepilot/ci/events/done')).length, ids.length);

  // Ref names with shell syntax: the push succeeds, nothing runs, and no event is written for them.
  let tried = 0;
  for (const odd of ['a$(touch PWNED)b', 'x;touch PWNED', "it's", 'a|b', 'a&b', 'dollar$HOME', 'a`touch PWNED`b', 'caf\u00e9', 'a{b}', 'a"b', 'plus+sign']) {
    try {
      h.git(['branch', '--no-track', odd], src); // git itself refuses some of these
    } catch {
      continue;
    }
    h.git(['push', '-q', 'pilot', odd], src);
    tried++;
  }
  assert.ok(tried >= 4, `exercised ${tried} hostile names`);
  assert.deepEqual(await pending(h), [], 'a name outside the pattern is never an event');
  assert.equal(existsSync(join(h.home, 'PWNED')), false);
  assert.equal(existsSync(join(h.home, '.claudepilot/git/app.git/PWNED')), false);

  // The hook can't break a push: without the runner it still succeeds, and writes nothing.
  h.sh(`rm ${h.script}`);
  h.git(['checkout', '-q', 'main'], src);
  h.commit(src, { 'c.txt': 'c' }, 'c');
  h.git(['push', '-q', 'pilot', 'main'], src);
  assert.equal(readdirSync(join(h.home, '.claudepilot/ci/events')).filter((n) => n.endsWith('.json')).length, 0);
});

test('an event file that is not valid is set aside, not read again', async () => {
  const h = new Home();
  await h.ci(['repo', 'create', 'app']);
  const dir = join(h.home, '.claudepilot/ci/events');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '1760000000000-abcdef01.json'), '{not json');
  writeFileSync(join(dir, '1760000000001-abcdef02.json'), JSON.stringify({ v: 1, id: '1760000000001-abcdef02', at: 'x', repo: '../..', kind: 'push', ref: 'refs/heads/x', old: '0'.repeat(40), new: 'a'.repeat(40), by: 'x', via: 'push' }));
  assert.deepEqual(await pending(h), []);
  assert.equal(readdirSync(join(dir, 'bad')).length, 2);
});

test('snapshot: the commit and its pipeline files, with links, big and odd files set aside', async () => {
  const h = new Home();
  const src = h.repo('app', { '.pilot/ci.yml': 'on: push\n', '.pilot/deploy.yaml': 'on: manual\n', '.pilot/steps/setup.yml': 'steps: []\n', '.pilot/scripts/x.sh': 'echo\n', 'README.md': 'hi' });
  mkdirSync(join(src, '.pilot'), { recursive: true });
  symlinkSync('ci.yml', join(src, '.pilot/link.yml'));
  writeFileSync(join(src, '.pilot/big.yml'), `# ${'x'.repeat(200_000)}\n`);
  writeFileSync(join(src, '.pilot/bin.yml'), Buffer.from([0x61, 0, 0x62]));
  const sha = h.commit(src, { 'tail.txt': 't' }, 'Ticket: T-9\n\nbody text\n\nTicket: T-9');
  await h.ci(['repo', 'create', 'app', '--from', src]);
  const r = await h.ci(['snapshot', 'app', sha]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.sha, sha);
  assert.equal(r.subject, 'Ticket: T-9');
  assert.match(r.message as string, /body text/);
  assert.deepEqual((r.author as { name: string }).name, 'Test User');
  assert.equal(r.hasPilot, true);
  const files = r.files as { path: string; text: string | null; skipped?: string }[];
  assert.deepEqual(
    files.map((f) => [f.path, f.skipped ?? (f.text === null ? 'none' : 'read')]),
    [['.pilot/big.yml', 'too_large'], ['.pilot/bin.yml', 'binary'], ['.pilot/ci.yml', 'read'], ['.pilot/deploy.yaml', 'read'], ['.pilot/link.yml', 'symlink'], ['.pilot/steps/setup.yml', 'read']],
  );
  assert.equal(files.find((f) => f.path === '.pilot/ci.yml')!.text, 'on: push\n');
  assert.equal((await h.ci(['snapshot', 'app', 'a'.repeat(40)])).error, 'no_commit');
  assert.equal((await h.ci(['snapshot', 'app', 'main'])).error, 'bad_sha');
  assert.equal((await h.ci(['snapshot', 'nope', sha])).error, 'no_repo');
  const none = await h.ci(['snapshot', 'app', h.git(['rev-parse', 'HEAD~1'], src)]);
  assert.equal(none.hasPilot, true);
  const bare = h.repo('plain');
  await h.ci(['repo', 'create', 'plain', '--from', bare]);
  assert.equal((await h.ci(['snapshot', 'plain', h.git(['rev-parse', 'HEAD'], bare)])).hasPilot, false);
});

test('snapshot: the context pack (T-292) is read when present, set aside past its cap, null without one', async () => {
  const h = new Home();
  const src = h.repo('app', { 'docs/context-pack.md': '# Context pack\n', 'README.md': 'hi' });
  const sha = h.git(['rev-parse', 'HEAD'], src);
  const big = h.commit(src, { 'docs/context-pack.md': 'x'.repeat(20 * 1024 + 1) }, 'too big');
  const gone = h.commit(src, { 'docs/other.md': 'o' }, 'other');
  h.git(['rm', '-q', 'docs/context-pack.md'], src);
  const none = h.commit(src, {}, 'no pack');
  await h.ci(['repo', 'create', 'app', '--from', src]);
  const r = await h.ci(['snapshot', 'app', sha]);
  assert.deepEqual(r.contextPack, { path: 'docs/context-pack.md', text: '# Context pack\n' });
  assert.equal(r.hasPilot, false, 'a pack is no pipeline');
  assert.deepEqual((await h.ci(['snapshot', 'app', big])).contextPack, { path: 'docs/context-pack.md', text: null, skipped: 'too_large' });
  assert.equal(((await h.ci(['snapshot', 'app', gone])).contextPack as { skipped?: string }).skipped, 'too_large');
  assert.equal((await h.ci(['snapshot', 'app', none])).contextPack, null);
});

test('branches and rev read the remote', async () => {
  const h = new Home();
  const src = h.repo('app');
  h.git(['checkout', '-q', '-b', 'dev'], src);
  const sha = h.commit(src, { 'd.txt': 'd' }, 'on dev');
  await h.ci(['repo', 'create', 'app', '--from', src]);
  const b = (await h.ci(['repo', 'branches', 'app'])).branches as { name: string; sha: string; subject: string }[];
  assert.deepEqual(b.map((x) => x.name).sort(), ['dev', 'main']);
  assert.equal(b.find((x) => x.name === 'dev')!.subject, 'on dev');
  assert.equal((await h.ci(['repo', 'rev', 'app', 'refs/heads/dev'])).sha, sha);
  assert.equal((await h.ci(['repo', 'rev', 'app', 'refs/heads/nope'])).error, 'no_ref');
  assert.equal((await h.ci(['repo', 'rev', 'app', '--all'])).error, 'bad_flag');
  assert.equal((await h.ci(['repo', 'rev', 'app', 'HEAD'])).error, 'bad_ref');
});

/* ---------- The merge ---------- */

test('merge: fast-forward, merge commit, already merged, conflict, moved target; each moving merge writes an event', async () => {
  const h = new Home();
  const src = h.repo('app', { 'a.txt': 'one\n', 'b.txt': 'b\n' });
  await h.ci(['repo', 'create', 'app', '--from', src, '--connect']);
  await h.ci(['poll', '--ack', '']);
  const main0 = h.git(['rev-parse', 'main'], src);

  // A branch ahead of main fast-forwards it.
  h.git(['checkout', '-q', '-b', 'ff'], src);
  const ff = h.commit(src, { 'c.txt': 'c\n' }, 'c');
  h.git(['push', '-q', 'pilot', 'ff', 'main'], src);
  await h.ci(['poll', '--ack', (await pending(h)).map((e) => e.id).join(',')]);
  const m1 = await h.ci(['merge', 'app', 'ff', 'main', '--strategy', 'ff']);
  assert.deepEqual([m1.ok, m1.sha, m1.strategy, m1.alreadyMerged], [true, ff, 'ff', false], JSON.stringify(m1));
  assert.equal(h.sh(`git --git-dir=${join(h.home, '.claudepilot/git/app.git')} rev-parse main`).trim(), ff);
  const evs = await pending(h);
  assert.deepEqual(evs.map((e) => [e.ref, e.old, e.new, e.via]), [['refs/heads/main', main0, ff, 'portal']]);
  await h.ci(['poll', '--ack', evs.map((e) => e.id).join(',')]);

  // Merging again is a no-op with no event.
  const again = await h.ci(['merge', 'app', 'ff', 'main']);
  assert.deepEqual([again.ok, again.alreadyMerged], [true, true]);
  assert.deepEqual(await pending(h), []);

  // Two branches that touch different files merge with a commit; the message and author are ours.
  h.git(['checkout', '-q', 'main'], src);
  h.git(['checkout', '-q', '-b', 'left'], src);
  h.commit(src, { 'left.txt': 'l\n' }, 'left');
  h.git(['checkout', '-q', 'main'], src);
  h.git(['checkout', '-q', '-b', 'right'], src);
  h.commit(src, { 'right.txt': 'r\n' }, 'right');
  h.git(['push', '-q', 'pilot', 'left', 'right'], src);
  await h.ci(['poll', '--ack', (await pending(h)).map((e) => e.id).join(',')]);
  // main moved on (the ff above), so left needs a merge commit too.
  assert.equal((await h.ci(['merge', 'app', 'left', 'main'])).strategy, 'merge');
  const both = await h.ci(['merge', 'app', 'right', 'main', '--message', 'Merge right\n\nTicket: T-3', '--author', 'Portal merge']);
  assert.deepEqual([both.ok, both.strategy], [true, 'merge'], JSON.stringify(both));
  const bare = join(h.home, '.claudepilot/git/app.git');
  const log = h.sh(`git --git-dir=${bare} log -1 --format='%P|%an|%ae|%B' main`);
  assert.match(log, /^[0-9a-f]{40} [0-9a-f]{40}\|Portal merge\|claudepilot@localhost\|Merge right/);
  assert.equal(h.sh(`git --git-dir=${bare} ls-tree --name-only main`).split('\n').filter(Boolean).join(','), 'a.txt,b.txt,c.txt,left.txt,right.txt', 'every side is in the tree');

  // ff-only refuses a merge that needs a commit; conflicting edits name the files and change nothing.
  h.git(['checkout', '-q', 'main'], src);
  h.git(['fetch', '-q', 'pilot'], src);
  h.git(['reset', '-q', '--hard', 'pilot/main'], src);
  h.git(['checkout', '-q', '-b', 'c1'], src);
  h.commit(src, { 'a.txt': 'from c1\n' }, 'c1');
  h.git(['checkout', '-q', 'main'], src);
  h.git(['checkout', '-q', '-b', 'c2'], src);
  h.commit(src, { 'a.txt': 'from c2\n' }, 'c2');
  h.git(['push', '-q', 'pilot', 'c1', 'c2'], src);
  await h.ci(['poll', '--ack', (await pending(h)).map((e) => e.id).join(',')]);
  await h.ci(['merge', 'app', 'c1', 'main']);
  const before = h.sh(`git --git-dir=${bare} rev-parse main`).trim();
  const conflict = await h.ci(['merge', 'app', 'c2', 'main']);
  assert.deepEqual([conflict.ok, conflict.error, conflict.files], [false, 'conflict', ['a.txt']], JSON.stringify(conflict));
  assert.equal(h.sh(`git --git-dir=${bare} rev-parse main`).trim(), before);
  assert.equal((await h.ci(['merge', 'app', 'c2', 'main', '--strategy', 'ff'])).error, 'not_ff');
  assert.equal((await h.ci(['merge', 'app', 'c2', 'main', '--expect', 'a'.repeat(40)])).error, 'moved');
  assert.equal((await h.ci(['merge', 'app', 'nope', 'main'])).error, 'no_branch');
  assert.equal((await h.ci(['merge', 'app', 'c2', 'c2'])).error, 'same_branch');
  assert.equal((await h.ci(['merge', 'app', 'a b', 'main'])).error, 'bad_branch');
});

/* ---------- Runs ---------- */

async function repoWithCommit(h: Home, files: Record<string, string> = { 'hello.txt': 'hello\n', 'sub/x.txt': 'x\n' }) {
  const src = h.repo('app', files);
  await h.ci(['repo', 'create', 'app', '--from', src]);
  return h.git(['rev-parse', 'HEAD'], src);
}

test('a run: jobs in order, a clean checkout, artifacts handed on, a failure skips what needs it', async () => {
  const h = new Home();
  const sha = await repoWithCommit(h);
  const p = plan('app', sha, [
    job('build', [step('test "$(cat hello.txt)" = hello && mkdir -p dist && echo built > dist/out.txt && echo "step one ok"'), step('echo "branch=$PILOT_BRANCH ci=$CI job=$PILOT_JOB"')], { artifacts: { paths: ['dist/**'], expireDays: 14, when: 'success' } }),
    job('test', [step('cat dist/out.txt && test ! -e /tmp/never'), step('pwd -P > pwd.txt && cat pwd.txt')], { needs: ['build'] }),
    job('later', [step('echo after test')], { needs: ['test'] }),
  ]);
  const t0 = Date.now();
  const started = await h.start(p);
  const startMs = Date.now() - t0;
  assert.deepEqual([started.ok, typeof started.pid], [true, 'number'], JSON.stringify(started));
  const done = await h.finished(p.runId);
  assert.equal(done.state.status, 'passed', JSON.stringify(done.state));
  assert.deepEqual(done.state.jobs.map((j) => [j.id, j.status]), [['build', 'passed'], ['test', 'passed'], ['later', 'passed']]);
  assert.match(logOf(h, p.runId, 'build', 0), /step one ok/);
  assert.match(logOf(h, p.runId, 'build', 1), /branch=main ci=true job=build/);
  assert.match(logOf(h, p.runId, 'test', 0), /built/);
  const pwd = logOf(h, p.runId, 'test', 1).trim();
  assert.ok(pwd.includes(`/.claudepilot/ci/runs/${p.runId}/work/test`), `the checkout is outside any project: ${pwd}`);
  assert.ok(!existsSync(join(h.home, '.claudepilot/ci/runs', p.runId, 'work')), 'checkouts are deleted when the run ends');
  assert.deepEqual(done.state.jobs[0]!.artifacts, [{ path: 'dist/out.txt', bytes: 6 }]);
  assert.equal(readFileSync(join(h.home, '.claudepilot/ci/runs', p.runId, 'artifacts/build/dist/out.txt'), 'utf8'), 'built\n');
  assert.ok(startMs < 5000, `start returns at once (${startMs} ms)`);
  // The same run started again is a no-op, and a finished run is not alive.
  const twice = await h.start(p);
  assert.deepEqual([twice.ok, twice.already, twice.status], [true, true, 'passed']);
  const polled = (await h.ci(['poll', '--runs', p.runId])).runs as Record<string, { alive: boolean }>;
  assert.equal(polled[p.runId]!.alive, false);
});

test('a failing step fails its job; later steps run only when allowed; jobs that need it are skipped unless they say otherwise', async () => {
  const h = new Home();
  const sha = await repoWithCommit(h);
  const p = plan('app', sha, [
    job('a', [step('echo one'), step('echo boom >&2; exit 3'), step('echo never'), step('echo cleanup', { when: 'always' }), step('echo on failure', { when: 'failure' })]),
    job('b', [step('echo b')], { needs: ['a'] }),
    job('report', [step('echo reporting')], { needs: ['a'], when: 'failure' }),
    job('always', [step('echo cleanup')], { needs: ['a'], when: 'always' }),
    job('soft', [step('exit 1', { continueOnError: true }), step('echo carried on')]),
    job('skipme', [step('echo x')], { skip: 'condition' }),
  ]);
  await h.start(p);
  const { state } = await h.finished(p.runId);
  assert.equal(state.status, 'failed');
  assert.equal(state.reason, 'step_failed');
  const by = Object.fromEntries(state.jobs.map((j) => [j.id, j]));
  assert.deepEqual(by.a!.steps.map((s) => s.status), ['passed', 'failed', 'skipped', 'passed', 'passed']);
  assert.equal(by.a!.steps[1]!.exitCode, 3);
  assert.equal(by.a!.steps[1]!.reason, 'step_failed');
  assert.match(logOf(h, p.runId, 'a', 1), /boom/);
  assert.deepEqual([by.b!.status, by.b!.reason], ['skipped', 'needs']);
  assert.equal(by.report!.status, 'passed');
  assert.equal(by.always!.status, 'passed');
  assert.deepEqual([by.soft!.status, by.soft!.steps[0]!.status, by.soft!.steps[0]!.ignored, by.soft!.steps[1]!.status], ['passed', 'failed', true, 'passed'], 'continue-on-error on a step');
  assert.deepEqual([by.skipme!.status, by.skipme!.reason], ['skipped', 'condition']);
});

test('a job under continue-on-error fails without failing the run, and its dependents still run', async () => {
  const h = new Home();
  const sha = await repoWithCommit(h);
  const p = plan('app', sha, [job('flaky', [step('exit 1')], { continueOnError: true }), job('after', [step('echo ok')], { needs: ['flaky'] })]);
  await h.start(p);
  const { state } = await h.finished(p.runId);
  assert.equal(state.status, 'passed');
  assert.deepEqual(state.jobs.map((j) => [j.status, j.ignored]), [['failed', true], ['passed', false]]);
});

test('timeouts: a step, a job and the run are stopped with their whole process group', async () => {
  const h = new Home();
  const sha = await repoWithCommit(h);
  // A step that forks a child that would outlive it.
  const p = plan('app', sha, [
    job('slow', [step('(sleep 60 & echo $! > child.pid; wait)', { timeoutMs: 1500 }), step('echo after', { when: 'always' })]),
    job('hung', [step('sleep 60')], { timeoutMs: 1500 }),
  ]);
  await h.start(p);
  const { state } = await h.finished(p.runId);
  const by = Object.fromEntries(state.jobs.map((j) => [j.id, j]));
  assert.deepEqual([by.slow!.steps[0]!.status, by.slow!.steps[0]!.reason], ['failed', 'timeout']);
  assert.deepEqual([by.slow!.status, by.slow!.reason], ['failed', 'timeout'], 'the job says why too');
  assert.equal(by.slow!.steps[1]!.status, 'passed', 'an always() step still runs');
  assert.match(logOf(h, p.runId, 'slow', 0), /\[pilot\] step timed out after 2 s/);
  assert.deepEqual([by.hung!.status, by.hung!.reason, by.hung!.steps[0]!.reason], ['failed', 'timeout', 'timeout']);
  assert.equal(state.status, 'failed');
  assert.equal(state.reason, 'timeout');

  const whole = plan('app', sha, [job('x', [step('sleep 60')], { timeoutMs: 120_000 }), job('y', [step('echo never')], { needs: ['x'] })], { timeoutMs: 2000 });
  await h.start(whole);
  const r2 = (await h.finished(whole.runId)).state;
  assert.deepEqual([r2.status, r2.reason], ['failed', 'timeout']);
  assert.deepEqual(r2.jobs.map((j) => j.status), ['failed', 'cancelled']);
});

test('cancel stops a running run; a run nobody supervises is settled directly', async () => {
  const h = new Home();
  const sha = await repoWithCommit(h);
  const p = plan('app', sha, [job('long', [step('echo started; sleep 60'), step('echo never')]), job('next', [step('echo never')], { needs: ['long'] })]);
  await h.start(p);
  for (let i = 0; i < 100; i++) {
    const s = ((await h.ci(['poll', '--runs', p.runId])).runs as Record<string, { state: { jobs: { steps: { status: string }[] }[] } }>)[p.runId]!.state;
    if (s.jobs[0]!.steps[0]!.status === 'running') break;
    await sleep(100);
  }
  const t0 = Date.now();
  const c = await h.ci(['cancel', p.runId]);
  assert.deepEqual([c.ok, c.signalled], [true, true]);
  const { state } = await h.finished(p.runId);
  assert.ok(Date.now() - t0 < 10_000, 'stopped promptly');
  assert.deepEqual([state.status, state.reason], ['cancelled', 'cancelled']);
  assert.deepEqual(state.jobs.map((j) => j.status), ['cancelled', 'cancelled']);
  assert.equal(state.jobs[0]!.steps[0]!.status, 'cancelled');
  assert.equal((await h.ci(['cancel', p.runId])).alreadyOver, true);

  // A state left "running" by a supervisor that is gone is closed by cancel.
  const ghost = plan('app', sha, [job('g', [step('echo x')])]);
  const dir = join(h.home, '.claudepilot/ci/runs', ghost.runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ v: 1, runId: ghost.runId, status: 'running', reason: null, startedAt: 'x', finishedAt: null, durationMs: null, jobs: [{ id: 'g', name: 'g', status: 'running', needs: [], startedAt: null, durationMs: null, ignored: false, reason: null, steps: [{ idx: 0, name: 's', status: 'running', startedAt: null, durationMs: null, exitCode: null, logBytes: 0, logTruncated: false, ignored: false, reason: null }], artifacts: [], artifactsSkipped: 0 }] }));
  assert.deepEqual(((await h.ci(['cancel', ghost.runId])) as { status?: string }).status, 'cancelled');
});

test('the supervisor outlives the process that started it, and a dead one is seen as not alive', async () => {
  const h = new Home();
  const sha = await repoWithCommit(h);
  const p = plan('app', sha, [job('a', [step('sleep 1.5; echo done > $HOME/finished.txt')])]);
  await h.start(p);
  // `start` has exited by now; the run goes on by itself.
  const mid = ((await h.ci(['poll', '--runs', p.runId])).runs as Record<string, { alive: boolean }>)[p.runId]!;
  assert.equal(mid.alive, true);
  assert.equal(existsSync(join(h.home, 'finished.txt')), false);
  await h.finished(p.runId);
  assert.equal(readFileSync(join(h.home, 'finished.txt'), 'utf8'), 'done\n');

  // Kill a supervisor outright (a container restart): the record stays "running", and poll says nobody is alive.
  const q = plan('app', sha, [job('a', [step('sleep 30')])]);
  await h.start(q);
  await sleep(700);
  const pid = Number(readFileSync(join(h.home, '.claudepilot/ci/runs', q.runId, 'supervisor.pid'), 'utf8').trim().split(' ')[0]);
  process.kill(pid, 'SIGKILL');
  await sleep(300);
  const lost = ((await h.ci(['poll', '--runs', q.runId])).runs as Record<string, { alive: boolean; state: { status: string } }>)[q.runId]!;
  assert.deepEqual([lost.alive, lost.state.status], [false, 'running']);
  assert.equal(((await h.ci(['cancel', q.runId])) as { status?: string }).status, 'cancelled');
  h.sh('pkill -f "sleep 30" || true');
});

test('steps start from a clean environment, in a login shell, and a working directory can not leave the checkout', async () => {
  const h = new Home();
  const sha = await repoWithCommit(h);
  h.extraEnv = { ANTHROPIC_API_KEY: 'sk-ant-should-not-reach-a-step', PILOT_MCP_TOKEN: 'cpst_nope', SOME_OTHER: 'x' };
  writeFileSync(join(h.home, '.profile'), 'export FROM_PROFILE=yes\n');
  const p = plan('app', sha, [
    job('env', [
      step('env | sort > env.txt; cat env.txt'),
      step('echo "$FROM_PROFILE"'),
      step('cat x.txt', { workingDirectory: 'sub' }),
      step('pwd', { workingDirectory: 'nope' }),
      step('echo "$PILOT_BRANCH $INJECT"', { env: { INJECT: '$(touch injected)' }, when: 'always' }),
    ], { env: { FROM_JOB: 'j' } }),
  ], { env: { CI: 'true', PILOT_BRANCH: 'x"; touch hacked; "' } });
  await h.start(p);
  const { state } = await h.finished(p.runId);
  const env = logOf(h, p.runId, 'env', 0);
  assert.ok(!env.includes('ANTHROPIC_API_KEY') && !env.includes('PILOT_MCP_TOKEN') && !env.includes('SOME_OTHER'), 'the runner\'s own environment does not reach a step');
  assert.match(env, /^PILOT_RUN_ID|PILOT_JOB=env/m);
  assert.match(env, /PILOT_WORKDIR=.*\/work\/env/);
  assert.match(env, /FROM_JOB=j/);
  assert.match(logOf(h, p.runId, 'env', 1), /yes/, 'a login shell reads the profile');
  assert.match(logOf(h, p.runId, 'env', 2), /^x\n?$/);
  assert.equal(state.jobs[0]!.steps[3]!.status, 'failed');
  assert.match(logOf(h, p.runId, 'env', 3), /working-directory nope does not exist/);
  assert.match(logOf(h, p.runId, 'env', 4), /x"; touch hacked; " \$\(touch injected\)/, 'values are data, not shell');
  assert.equal(existsSync(join(h.home, '.claudepilot/ci/runs', p.runId, 'work')), false);
  for (const name of ['hacked', 'injected']) assert.equal(h.sh(`find ${h.home} -name ${name}`).trim(), '');

  // A link in the repository that points out of the checkout is refused as a working directory.
  const src2 = h.repo('linky', { 'ok.txt': 'ok' });
  symlinkSync('/etc', join(src2, 'etc'));
  const sha2 = h.commit(src2, {}, 'link') && h.git(['rev-parse', 'HEAD'], src2);
  await h.ci(['repo', 'create', 'linky', '--from', src2]);
  const q = plan('linky', sha2, [job('j', [step('ls', { workingDirectory: 'etc' })])]);
  await h.start(q);
  const r = (await h.finished(q.runId)).state;
  assert.equal(r.jobs[0]!.steps[0]!.status, 'failed');
  assert.match(logOf(h, q.runId, 'j', 0), /leaves the checkout/);
});

test('logs are capped, read in whole lines, and archived as a head and a tail', async () => {
  const h = new Home();
  const sha = await repoWithCommit(h);
  const p = plan('app', sha, [
    job('noisy', [step('echo first; head -c 17000000 /dev/zero | tr "\\0" "a"; echo; echo never-seen')]),
    job('lines', [step('for i in 1 2 3 4 5; do echo "line $i"; done; printf partial')]),
    job('big', [step('i=0; while [ $i -lt 20000 ]; do echo "row $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done')]),
  ]);
  await h.start(p);
  const { state } = await h.finished(p.runId);
  const noisy = state.jobs[0]!.steps[0]!;
  assert.equal(noisy.logTruncated, true);
  assert.ok(noisy.logBytes <= 16 * 1024 * 1024, `capped (${noisy.logBytes})`);
  const text = logOf(h, p.runId, 'noisy', 0);
  assert.match(text, /^first\n/);
  assert.match(text, /\[pilot\] output cap reached/);
  assert.ok(!text.includes('never-seen'));

  // Reading in chunks: whole lines, the next offset, and done only at the end of a finished step.
  let offset = 0;
  const seen: string[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await h.ci(['log', p.runId, 'lines', '0', String(offset), '--max', '1024']);
    assert.equal(r.ok, true);
    seen.push(r.text as string);
    offset = r.next as number;
    if (r.done) break;
  }
  assert.equal(seen.join(''), 'line 1\nline 2\nline 3\nline 4\nline 5\npartial');
  assert.equal((await h.ci(['log', p.runId, 'lines', '0', '999999'])).text, '');
  assert.equal((await h.ci(['log', p.runId, '../x', '0', '0'])).error, 'bad_log');
  assert.equal((await h.ci(['log', p.runId, 'nope', '0', '0'])).done, true, 'a log that does not exist is empty and over');

  const a = await h.ci(['archive', p.runId, '--head', '4096', '--tail', '8192', '--total', '2000000']);
  const steps = a.steps as { job: string; step: number; size: number; head: string; tail: string | null; omitted: number }[];
  const big = steps.find((s) => s.job === 'big')!;
  assert.ok(big.size > 12288 && big.tail !== null && big.omitted > 0);
  assert.match(big.head, /^row 0 /);
  assert.match(big.tail!, /row 19999 x+\n$/);
  assert.equal(big.head.length + big.tail!.length + big.omitted, big.size);
  const small = steps.find((s) => s.job === 'lines')!;
  assert.deepEqual([small.tail, small.head.endsWith('partial')], [null, true]);
  const budgeted = (await h.ci(['archive', p.runId, '--head', '4096', '--tail', '8192', '--total', '5000'])).steps as { head: string; omitted: number }[];
  assert.ok(budgeted.some((s) => s.head === '' && s.omitted > 0), 'past the total, steps are listed with nothing kept');
});

test('a run in progress is read as far as its last whole line', async () => {
  const h = new Home();
  const sha = await repoWithCommit(h);
  const p = plan('app', sha, [job('a', [step('echo one; echo -n half; sleep 2; echo " done"; echo two')])]);
  await h.start(p);
  let first = '';
  for (let i = 0; i < 40 && !first; i++) {
    const r = await h.ci(['log', p.runId, 'a', '0', '0']);
    first = r.text as string;
    if (!first) await sleep(100);
  }
  assert.equal(first, 'one\n', 'the unfinished line waits');
  await h.finished(p.runId);
  const rest = await h.ci(['log', p.runId, 'a', '0', '4']);
  assert.equal(rest.text, 'half done\ntwo\n');
  assert.equal(rest.done, true);
});

test('a plan the runner can not trust is refused before anything runs', async () => {
  const h = new Home();
  const sha = await repoWithCommit(h);
  const good = plan('app', sha, [job('a', [step('echo x')])]);
  const tries: [string, (p: Record<string, unknown>) => void][] = [
    ['an id that is not one', (p) => (p.runId = '../../x')],
    ['a repo path', (p) => (p.repo = '../work')],
    ['a ref that is not a ref', (p) => (p.ref = 'HEAD')],
    ['a sha that is not one', (p) => (p.sha = 'main')],
    ['a variable name', (p) => (p.env = { 'BAD NAME': 'x' })],
    ['a job id', (p) => ((p.jobs as Record<string, unknown>[])[0]!.id = '../x')],
    ['a need that is missing', (p) => ((p.jobs as Record<string, unknown>[])[0]!.needs = ['nope'])],
    ['a working directory', (p) => (((p.jobs as { steps: Record<string, unknown>[] }[])[0]!.steps[0]!.workingDirectory = '../..'))],
    ['an artifact path', (p) => ((p.jobs as Record<string, unknown>[])[0]!.artifacts = { paths: ['/etc'], expireDays: 1, when: 'success' })],
    ['a timeout past the cap', (p) => (p.timeoutMs = 99 * 3_600_000)],
    ['no jobs', (p) => (p.jobs = [])],
  ];
  for (const [what, edit] of tries) {
    const p = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    edit(p);
    const text = JSON.stringify(p);
    const id = typeof p.runId === 'string' && /^r[a-z0-9]{6,24}$/.test(p.runId) ? p.runId : good.runId;
    const r = await h.ci(['start', id, '--bytes', String(Buffer.byteLength(text))], { stdin: text });
    assert.equal(r.ok, false, what);
    assert.ok(['bad_plan', 'bad_run'].includes(r.error!), `${what}: ${JSON.stringify(r)}`);
  }
  assert.equal(existsSync(join(h.home, '.claudepilot/ci/runs')) ? readdirSync(join(h.home, '.claudepilot/ci/runs')).length : 0, 0, 'nothing was started');
  const cyc = JSON.parse(JSON.stringify(plan('app', sha, [job('a', [step('x')], { needs: ['b'] }), job('b', [step('x')], { needs: ['a'] })]))) as Record<string, unknown>;
  const text = JSON.stringify(cyc);
  assert.equal((await h.ci(['start', cyc.runId as string, '--bytes', String(text.length)], { stdin: text })).error, 'bad_plan');
  assert.equal((await h.ci(['start', good.runId, '--bytes', '5'], { stdin: 'short' })).error, 'bad_plan');
});

test('gc removes old finished runs and stray checkouts, and keeps the rest', async () => {
  const h = new Home();
  const sha = await repoWithCommit(h);
  const a = plan('app', sha, [job('a', [step('echo a')])]);
  const b = plan('app', sha, [job('a', [step('echo b')])]);
  await h.start(a);
  await h.start(b);
  await h.finished(a.runId);
  await h.finished(b.runId);
  const old = new Date(Date.now() - 20 * 86_400_000);
  utimesSync(join(h.home, '.claudepilot/ci/runs', a.runId, 'state.json'), old, old);
  mkdirSync(join(h.home, '.claudepilot/ci/runs', b.runId, 'work/left'), { recursive: true });
  const g = await h.ci(['gc', '--days', '14']);
  assert.deepEqual([g.ok, g.runs, g.work], [true, 1, 1]);
  assert.equal(existsSync(join(h.home, '.claudepilot/ci/runs', a.runId)), false);
  assert.equal(existsSync(join(h.home, '.claudepilot/ci/runs', b.runId, 'state.json')), true);
  assert.equal(existsSync(join(h.home, '.claudepilot/ci/runs', b.runId, 'work')), false);
});

test('version reports the script, node and git', async () => {
  const h = new Home();
  const v = await h.ci(['version']);
  assert.equal(v.ok, true);
  assert.match(v.version as string, /^[0-9a-f]{16}$/);
  assert.match(v.node as string, /^v22/);
  assert.equal((await h.ci(['nonsense'])).error, 'bad_command');
});

test('secrets: read from the workspace\'s secret files for the job that names them, never written, masked in its logs, and a missing one fails the job before any step', async () => {
  const h = new Home();
  const sha = await repoWithCommit(h);
  // Secrets & env's files live in <etc>/secrets/files/; the script sits in <etc>/bin, so here <etc> is the home folder.
  mkdirSync(join(h.home, 'secrets/files'), { recursive: true });
  const token = 'tok_live_9f8e7d6c5b4a3210';
  writeFileSync(join(h.home, 'secrets/files/NPM_TOKEN'), `${token}\n`);
  writeFileSync(join(h.home, 'secrets/files/OTHER'), 'not-requested-by-anyone-1234');
  const p = plan('app', sha, [
    job('uses', [
      // The script never holds the value itself: it takes it apart with the shell.
      step('echo "got it: $NPM_TOKEN"; echo "also in two writes:"; printf "%s" "${NPM_TOKEN:0:10}"; sleep 0.4; printf "%s\\n" "${NPM_TOKEN:10}"; echo "json: \\"$NPM_TOKEN\\""; test -z "${OTHER:-}" && echo "OTHER is not set"; printf "%s" "$NPM_TOKEN" | wc -c'),
      step('env | grep -c "^NPM_TOKEN=" || true'),
    ], { secrets: ['NPM_TOKEN'] }),
    job('without', [step('test -z "${NPM_TOKEN:-}" && echo "no token here"')]),
    job('missing', [step('echo never')], { secrets: ['NOT_THERE'] }),
  ]);
  await h.start(p);
  const { state } = await h.finished(p.runId);
  const by = Object.fromEntries(state.jobs.map((j) => [j.id, j]));
  assert.equal(by.uses!.status, 'passed');
  const log = logOf(h, p.runId, 'uses', 0);
  assert.ok(!log.includes(token), 'the value is not in the log');
  assert.match(log, new RegExp(`\\n${token.length}\\n$`), 'it really was the whole value the step saw');
  assert.match(log, /got it: \[redacted\]/);
  assert.match(log, /also in two writes:\n?\[redacted\]/, 'a value written in two pieces is still taken out');
  assert.match(log, /OTHER is not set/);
  assert.match(logOf(h, p.runId, 'uses', 1), /^1\n$/, 'the step sees it as an environment variable');
  assert.equal(by.without!.status, 'passed', 'a job that does not name it does not get it');
  assert.equal(by.missing!.status, 'failed');
  assert.equal(by.missing!.reason, 'runner_error');
  assert.match(logOf(h, p.runId, 'missing', 0), /The secret NOT_THERE is not available in this workspace/);
  // Nothing of the value was written anywhere under the run's folder (plan, state, supervisor log, logs).
  assert.equal(h.sh(`grep -rl ${token} ${join(h.home, '.claudepilot')} || echo clean`).trim(), 'clean');
  // The plan only ever carries names.
  assert.ok(!readFileSync(join(h.home, '.claudepilot/ci/runs', p.runId, 'plan.json'), 'utf8').includes(token));
});

test('a matrix group: fail-fast stops the combinations that have not started, max-parallel caps how many run at once', async () => {
  const h = new Home();
  const sha = await repoWithCommit(h);
  const grp = (failFast: boolean, maxParallel: number | null) => ({ id: 'test', failFast, maxParallel });
  // fail-fast: the first combination fails at once; with one at a time the others never start.
  const ff = plan('app', sha, [
    job('test-m1', [step('exit 1')], { group: grp(true, 1) }),
    job('test-m2', [step('echo never')], { group: grp(true, 1) }),
    job('test-m3', [step('echo never')], { group: grp(true, 1) }),
    job('other', [step('echo runs anyway')]),
  ]);
  await h.start(ff);
  const a = (await h.finished(ff.runId)).state;
  assert.deepEqual(a.jobs.map((j) => [j.id, j.status, j.reason]), [['test-m1', 'failed', 'step_failed'], ['test-m2', 'skipped', 'fail_fast'], ['test-m3', 'skipped', 'fail_fast'], ['other', 'passed', null]]);

  // Without fail-fast the siblings run on.
  const keep = plan('app', sha, [job('test-m1', [step('exit 1')], { group: grp(false, 1) }), job('test-m2', [step('echo ok')], { group: grp(false, 1) })]);
  await h.start(keep);
  assert.deepEqual((await h.finished(keep.runId)).state.jobs.map((j) => j.status), ['failed', 'passed']);

  // max-parallel: three combinations of 1 s each, two at a time, with room for four: at most two overlap.
  const cap = plan('app', sha, [1, 2, 3].map((n) => job(`test-m${n}`, [step(`date +%s%N > $HOME/start.${n}; sleep 1; date +%s%N > $HOME/end.${n}`)], { group: grp(false, 2) })), { maxParallel: 4 });
  await h.start(cap);
  await h.finished(cap.runId);
  const t = (f: string) => Number(readFileSync(join(h.home, f), 'utf8').trim());
  const spans = [1, 2, 3].map((n) => [t(`start.${n}`), t(`end.${n}`)] as const);
  const overlapping = (at: number) => spans.filter(([s, e]) => s <= at && at < e).length;
  assert.ok(spans.every(([s]) => overlapping(s) <= 2), 'never more than two at once');
  assert.ok(Math.max(...spans.map(([s]) => overlapping(s))) === 2, 'but two did run together');
});

test('a job with an approval gate waits; a forged or wrong key approves nothing; the right key lets it run; a reject ends the run as rejected', async () => {
  const { createHash, randomBytes } = await import('node:crypto');
  const h = new Home();
  const sha = await repoWithCommit(h);
  const key = randomBytes(32).toString('hex');
  const gate = createHash('sha256').update(key).digest('hex');
  const stateOf = async (id: string) => ((await h.ci(['poll', '--runs', id])).runs as Record<string, { state: { status: string; reason: string | null; jobs: { id: string; status: string; reason: string | null }[] } }>)[id]!.state;
  const waitFor = async (id: string, job: string, status: string) => {
    for (let i = 0; i < 150; i++) {
      if ((await stateOf(id)).jobs.find((j) => j.id === job)?.status === status) return;
      await sleep(100);
    }
    throw new Error(`${job} never became ${status}: ${JSON.stringify(await stateOf(id))}`);
  };
  const p = plan('app', sha, [
    job('build', [step('echo built')]),
    job('release', [step('echo released > released.txt; cat released.txt')], { needs: ['build'], environment: 'production', approval: { environment: 'production', gate } }),
    job('after', [step('echo after')], { needs: ['release'] }),
  ]);
  const started = await h.start(p);
  assert.equal(started.ok, true, JSON.stringify(started));
  await waitFor(p.runId, 'release', 'waiting');
  const s0 = await stateOf(p.runId);
  assert.deepEqual([s0.status, s0.jobs.map((j) => j.status)], ['running', ['passed', 'waiting', 'pending']]);
  assert.ok(!existsSync(join(h.home, '.claudepilot/ci/runs', p.runId, 'logs/release')), 'nothing of the held job ran');

  // The workspace user writing the decision file by hand, with no key or a made-up one: thrown away, still waiting.
  const approvals = join(h.home, '.claudepilot/ci/runs', p.runId, 'approvals');
  mkdirSync(approvals, { recursive: true });
  writeFileSync(join(approvals, 'release'), JSON.stringify({ decision: 'approve', key: randomBytes(32).toString('hex') }));
  await sleep(800);
  assert.equal(existsSync(join(approvals, 'release')), false, 'a wrong key is thrown away');
  assert.equal((await stateOf(p.runId)).jobs[1]!.status, 'waiting');
  // cp-ci approve refuses what can not be meant, and checks nothing it can not check (the key is the supervisor's to judge).
  assert.equal((await h.ci(['approve', p.runId, 'build', '--bytes', '64'], { stdin: key })).error, 'no_gate');
  assert.equal((await h.ci(['approve', p.runId, 'nope', '--bytes', '64'], { stdin: key })).error, 'no_job');
  assert.equal((await h.ci(['approve', p.runId, 'release'])).error, 'bad_key');
  assert.equal((await h.ci(['approve', p.runId, 'release', '--bytes', '64'], { stdin: 'z'.repeat(64) })).error, 'bad_key');

  const ok = await h.ci(['approve', p.runId, 'release', '--bytes', '64'], { stdin: key });
  assert.deepEqual([ok.ok, ok.decision], [true, 'approve'], JSON.stringify(ok));
  const done = await h.finished(p.runId);
  assert.equal(done.state.status, 'passed', JSON.stringify(done.state));
  assert.deepEqual(done.state.jobs.map((j) => j.status), ['passed', 'passed', 'passed']);
  assert.match(logOf(h, p.runId, 'release', 0), /released/);
  assert.equal((await h.ci(['approve', p.runId, 'release', '--bytes', '64'], { stdin: key })).error, 'over');

  // A reject: the held job and what waits on it are cancelled, the run ends cancelled (rejected), nothing else is started.
  const r = plan('app', sha, [
    job('release', [step('echo never')], { environment: 'production', approval: { environment: 'production', gate } }),
    job('verify', [step('echo never')], { needs: ['release'] }),
    job('rollback', [step('echo never')], { needs: ['release', 'verify'], when: 'failure' }),
  ]);
  await h.start(r);
  await waitFor(r.runId, 'release', 'waiting');
  assert.equal((await h.ci(['approve', r.runId, 'release', '--reject'])).ok, true);
  const rejected = await h.finished(r.runId);
  assert.deepEqual([rejected.state.status, rejected.state.reason], ['cancelled', 'rejected']);
  assert.deepEqual(rejected.state.jobs.map((j) => [j.status, j.reason]), [['cancelled', 'rejected'], ['cancelled', 'rejected'], ['cancelled', 'rejected']], 'a rejection never starts the rollback');

  // Cancelling a run that waits settles the held job; a plan with a malformed gate is refused.
  const c = plan('app', sha, [job('release', [step('echo never')], { approval: { environment: 'production', gate } })]);
  await h.start(c);
  await waitFor(c.runId, 'release', 'waiting');
  await h.ci(['cancel', c.runId]);
  const cancelled = await h.finished(c.runId);
  assert.deepEqual([cancelled.state.status, cancelled.state.jobs[0]!.status], ['cancelled', 'cancelled']);
  const bad = plan('app', sha, [job('release', [step('echo never')], { approval: { environment: 'production', gate: 'nothex' } })]);
  assert.equal((await h.start(bad)).error, 'bad_plan');
});
