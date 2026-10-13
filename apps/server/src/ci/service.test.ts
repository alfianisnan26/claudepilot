// The CI service against the real runner and real git in a temporary home folder (the "workspace"), with the real database.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import { CiService } from './service.js';
import { codeOf, harness, PIPELINE, remote, sleep, WS } from './testkit.js';
import { valueRedactors } from './values.js';

test('a push becomes a run that goes queued, running, passed, with its steps, logs and a hook for others', async () => {
  const h = await harness();
  try {
    const repo = await remote(h);
    assert.deepEqual([repo.name, repo.defaultBranch, repo.protected, repo.hooks, repo.workspaceState], ['app', 'main', ['main'], 'ok', 'running']);
    assert.deepEqual(h.svc.list().items, [], 'creating a remote runs nothing');

    h.home.git(['checkout', '-q', '-b', 'ticket/12-login'], h.src);
    const sha = h.home.commit(h.src, { 'a.txt': 'a' }, 'add a\n\nTicket: T-12');
    h.home.git(['push', '-q', 'pilot', 'ticket/12-login'], h.src);
    await h.until('a run', () => h.svc.list().items.length === 1);
    const first = h.svc.list().items[0]!;
    assert.deepEqual([first.pipeline, first.branch, first.sha, first.trigger, first.actor, first.number, first.repo], ['ci', 'ticket/12-login', sha, 'push', 'push', 1, 'app']);
    assert.equal(first.subject, 'add a');
    await h.until('it to pass', () => h.svc.list().items[0]!.status === 'passed');

    const run = await h.run(first.id);
    assert.equal(run.status, 'passed');
    assert.deepEqual(run.detail.map((j) => [j.id, j.status, j.steps.map((s) => [s.name, s.status, s.exitCode])]), [['test', 'passed', [['Say', 'passed', 0], ['test -f README.md', 'passed', 0]]]]);
    assert.ok(run.durationMs !== null && run.startedAt && run.finishedAt);
    assert.equal(run.archived, true, 'logs are kept in the portal');
    const log = await h.svc.log(first.id, 'test', 0, 0);
    assert.deepEqual([log.text, log.done, log.source], ['hello from ticket/12-login\n', true, 'archive']);
    assert.ok(h.created.includes(first.id));
    assert.deepEqual(h.finished.map((f) => [f.status, f.was]).filter(([s]) => s !== 'queued'), [['running', 'queued'], ['passed', 'running']]);
    assert.ok(h.changes() > 0);

    // The event is on record, with what it did.
    const events = h.store.db!.prepare('SELECT outcome, note, via FROM ci_events').all() as { outcome: string; note: string; via: string }[];
    assert.deepEqual(events.map((e) => [e.outcome, e.note, e.via]), [['runs', '1 run', 'push']]);
    assert.equal(h.home.sh(`ls ${join(h.home.home, '.claudepilot/ci/events')}`).includes('done'), true, 'and acknowledged in the workspace');
    assert.equal(existsSync(join(h.home.home, '.claudepilot/ci/runs', first.id, 'work')), false, 'the checkout is gone');
  } finally {
    h.done();
  }
});

test('a failing step fails the run with the reason and the log; a rerun is a new run of the same commit', async () => {
  const h = await harness();
  try {
    await remote(h, { '.pilot/ci.yml': 'on: push\njobs:\n  test:\n    steps:\n      - run: echo before\n      - name: Break\n        run: echo "the failure" >&2; exit 4\n      - run: echo never\n  after:\n    needs: [test]\n    steps: [{run: echo x}]\n' });
    h.home.git(['checkout', '-q', '-b', 'dev'], h.src);
    h.home.commit(h.src, { 'x.txt': 'x' }, 'change');
    h.home.git(['push', '-q', 'pilot', 'dev'], h.src);
    await h.until('it to fail', () => h.svc.list().items[0]?.status === 'failed');
    const run = await h.run(h.svc.list().items[0]!.id);
    assert.deepEqual([run.status, run.reason], ['failed', 'step_failed']);
    assert.deepEqual(run.detail.map((j) => [j.id, j.status]), [['test', 'failed'], ['after', 'skipped']]);
    assert.deepEqual(run.detail[0]!.steps.map((s) => s.status), ['passed', 'failed', 'skipped']);
    assert.equal(run.detail[0]!.steps[1]!.exitCode, 4);
    assert.match((await h.svc.log(run.id, 'test', 1, 0)).text, /the failure/);

    const again = await h.svc.rerun(run.id);
    assert.deepEqual([again.rerunOf, again.trigger, again.sha, again.number, again.status], [run.id, 'rerun', run.sha, 2, 'queued']);
    await h.until('the rerun to finish', () => h.svc.list().items.every((r) => r.status === 'failed'));
    const third = await h.svc.rerun(run.id);
    assert.equal(third.status, 'queued');
    assert.equal(await codeOf(() => h.svc.rerun(third.id)), 'CONFLICT', 'a run that is still going can not be rerun');
  } finally {
    h.done();
  }
});

test('what an event does is recorded when it starts nothing: no pipeline, no match, [skip ci], an odd name', async () => {
  const h = await harness();
  try {
    await remote(h, { '.pilot/only-main.yml': 'on:\n  push: { branches: [main] }\njobs:\n  a:\n    steps: [{run: echo x}]\n' });
    const outcome = () => (h.store.db!.prepare('SELECT outcome, note FROM ci_events ORDER BY rowid').all() as { outcome: string; note: string }[]).map((e) => e.outcome);
    h.home.git(['checkout', '-q', '-b', 'feature'], h.src);
    h.home.commit(h.src, { 'f.txt': 'f' }, 'feature');
    h.home.git(['push', '-q', 'pilot', 'feature'], h.src);
    await h.until('the event', () => outcome().length === 1);
    assert.deepEqual(outcome(), ['no_match']);

    h.home.commit(h.src, { 'g.txt': 'g' }, 'docs only [skip ci]');
    h.home.git(['push', '-q', 'pilot', 'feature'], h.src);
    await h.until('the skip', () => outcome().length === 2);
    assert.equal(outcome()[1], 'skipped');

    h.home.git(['branch', 'dollar$HOME'], h.src);
    h.home.git(['push', '-q', 'pilot', 'dollar$HOME'], h.src);
    h.home.git(['push', '-q', 'pilot', '--delete', 'feature'], h.src);
    await h.until('the delete', () => outcome().length === 3);
    assert.equal(outcome()[2], 'ignored', 'a deleted ref starts nothing; the odd name never became an event');
    assert.deepEqual(h.svc.list().items, []);

    // A commit with no .pilot at all.
    const bare = h.home.repo('plain');
    const repo2 = await h.svc.createRepo({ workspaceId: WS, name: 'plain', source: bare, connect: true });
    assert.equal(repo2.name, 'plain');
    h.home.git(['checkout', '-q', '-b', 'x'], bare);
    h.home.commit(bare, { 'x.txt': 'x' }, 'x');
    h.home.git(['push', '-q', 'pilot', 'x'], bare);
    await h.until('the plain event', () => outcome().length === 4);
    assert.equal(outcome()[3], 'no_pipeline');
  } finally {
    h.done();
  }
});

test('a pipeline with a mistake is a failed run at once, with the diagnostics, and the push still shows a result', async () => {
  const h = await harness();
  try {
    await remote(h, { '.pilot/ci.yml': 'on: push\njobs:\n  a:\n    steps:\n      - script: npm test\n      - uses: actions/setup-node@v4\n' });
    h.home.git(['checkout', '-q', '-b', 'bad'], h.src);
    h.home.commit(h.src, { 'x.txt': 'x' }, 'x');
    h.home.git(['push', '-q', 'pilot', 'bad'], h.src);
    await h.until('the invalid run', () => h.svc.list().items.length === 1);
    const run = await h.run(h.svc.list().items[0]!.id);
    assert.deepEqual([run.status, run.reason, run.archived], ['failed', 'invalid_pipeline', true]);
    assert.deepEqual(run.diagnostics.map((d) => d.code).sort(), ['no-remote-actions', 'unsupported-key'], 'a step with `script` is told to use `run`, not also that `run` is missing');
    assert.ok(run.diagnostics.every((d) => d.file === '.pilot/ci.yml' && d.line > 0));
    assert.deepEqual(run.detail, []);
  } finally {
    h.done();
  }
});

test('a merge into a protected branch starts the pipelines that ask for it; the portal merge and a plain push both count', async () => {
  const h = await harness();
  try {
    await remote(h, { '.pilot/ci.yml': 'on: push\njobs:\n  t:\n    steps: [{run: echo push}]\n', '.pilot/release.yml': 'on:\n  merge: { branches: [main] }\njobs:\n  r:\n    steps: [{run: "echo released $PILOT_EVENT $PILOT_BRANCH"}]\n' });
    h.home.git(['checkout', '-q', '-b', 'feat'], h.src);
    h.home.commit(h.src, { 'f.txt': 'f' }, 'feat');
    h.home.git(['push', '-q', 'pilot', 'feat'], h.src);
    await h.until('the push run', () => h.svc.list().items.length === 1 && h.svc.list().items[0]!.status === 'passed');
    assert.equal(h.svc.list().items[0]!.pipeline, 'ci', 'release does not run for a feature branch');

    const merged = await h.svc.merge((await h.svc.repos())[0]!.id, { source: 'feat', target: 'main' });
    assert.deepEqual([merged.strategy, merged.alreadyMerged], ['ff', false]);
    await h.until('both runs on main', () => h.svc.list({ branch: 'main' }).items.length === 2 && h.svc.list({ branch: 'main' }).items.every((r) => r.status === 'passed'));
    const onMain = h.svc.list({ branch: 'main' }).items;
    assert.deepEqual(onMain.map((r) => [r.pipeline, r.trigger, r.actor]).sort(), [['ci', 'merge', 'ui'], ['release', 'merge', 'ui']]);
    const release = onMain.find((r) => r.pipeline === 'release')!;
    assert.match((await h.svc.log(release.id, 'r', 0, 0)).text, /released merge main/);
    const record = h.store.db!.prepare('SELECT outcome, result_sha, actor FROM ci_merges').all() as { outcome: string; result_sha: string }[];
    assert.deepEqual(record.map((m) => m.outcome), ['merged']);

    // Merging again says it is already there; a conflict is a 409 naming the files; the branch is gone from nowhere.
    assert.equal((await h.svc.merge((await h.svc.repos())[0]!.id, { source: 'feat', target: 'main' })).alreadyMerged, true);
    assert.equal(await codeOf(() => h.svc.merge(h.svc.list().items[0]!.repoId, { source: 'nope', target: 'main' })), 'NOT_FOUND');
    assert.equal(await codeOf(() => h.svc.merge(h.svc.list().items[0]!.repoId, { source: 'feat' })), 'VALIDATION_FAILED');

    // A plain push to main is a merge too.
    h.home.git(['checkout', '-q', 'main'], h.src);
    h.home.git(['merge', '-q', '--ff-only', 'feat'], h.src);
    const sha = h.home.commit(h.src, { 'm.txt': 'm' }, 'direct to main');
    h.home.git(['push', '-q', 'pilot', 'main'], h.src);
    await h.until('runs for the direct push', () => h.svc.list({ branch: 'main' }).items.length === 4);
    const direct = h.svc.list({ branch: 'main' }).items.filter((r) => r.sha === sha);
    assert.deepEqual(direct.map((r) => [r.trigger, r.actor]).sort(), [['merge', 'push'], ['merge', 'push']]);
  } finally {
    h.done();
  }
});

test('manual runs: a branch, inputs checked, a pipeline without a manual trigger refused', async () => {
  const h = await harness();
  try {
    const repo = await remote(h, { '.pilot/ci.yml': PIPELINE, '.pilot/auto.yml': 'on: push\njobs:\n  a:\n    steps: [{run: echo x}]\n' });
    const run = await h.svc.startRun({ repoId: repo.id, pipeline: 'ci', ref: 'main', inputs: { target: 'production' } }, 'portal-mcp:t1');
    assert.deepEqual([run.trigger, run.actor, run.branch, run.status, run.inputs], ['manual', 'portal-mcp:t1', 'main', 'queued', { target: 'production' }]);
    assert.equal(run.actorLabel, null, 'no label given, none made up');
    // T-6: a Portal MCP token's label is kept with the run, one line and bounded; a person's run has none
    const labelled = await h.svc.startRun({ repoId: repo.id, pipeline: 'ci', ref: 'main', inputs: { target: 'production' } }, 'portal-mcp:t1', { actorLabel: 'relay\n  ' + 'x'.repeat(100) });
    assert.equal(labelled.actorLabel, ('relay ' + 'x'.repeat(100)).slice(0, 60));
    assert.equal(h.svc.get(labelled.id).actorLabel, labelled.actorLabel, 'stored, not recomputed');
    assert.equal((await h.svc.startRun({ repoId: repo.id, pipeline: 'ci', ref: 'main', inputs: { target: 'production' } })).actorLabel, null);
    await h.until('it to pass', () => h.svc.list().items[0]!.status === 'passed');
    assert.equal(await codeOf(() => h.svc.startRun({ repoId: repo.id, pipeline: 'auto', ref: 'main' })), 'CONFLICT');
    assert.equal(await codeOf(() => h.svc.startRun({ repoId: repo.id, pipeline: 'ci', ref: 'main', inputs: { target: 'mars' } })), 'VALIDATION_FAILED');
    assert.equal(await codeOf(() => h.svc.startRun({ repoId: repo.id, pipeline: 'nope', ref: 'main' })), 'NOT_FOUND');
    assert.equal(await codeOf(() => h.svc.startRun({ repoId: repo.id, pipeline: 'ci', ref: 'no-such-branch' })), 'NOT_FOUND');
    assert.equal(await codeOf(() => h.svc.startRun({ repoId: 'nope', pipeline: 'ci', ref: 'main' })), 'NOT_FOUND');
    h.host.running = false;
    assert.equal(await codeOf(() => h.svc.startRun({ repoId: repo.id, pipeline: 'ci', ref: 'main' })), 'CONFLICT', 'a stopped workspace can not start one');
    // The pipelines view reads .pilot at the ref and says what each needs.
    h.host.running = true;
    const infos = await h.svc.pipelines(repo.id);
    assert.deepEqual(infos.map((p) => [p.file, p.valid, p.triggers]), [['.pilot/auto.yml', true, ['push']], ['.pilot/ci.yml', true, ['push', 'merge', 'manual']]]);
  } finally {
    h.done();
  }
});

test('the cap per workspace queues runs in order; cancel works on queued and running ones; a group can cancel what it supersedes', async () => {
  const h = await harness({ maxRunsPerWorkspace: 1 });
  try {
    const repo = await remote(h, { '.pilot/slow.yml': 'on: manual\njobs:\n  a:\n    steps: [{run: sleep 30}]\n', '.pilot/quick.yml': 'on: manual\njobs:\n  a:\n    steps: [{run: echo quick}]\n' });
    const slow = await h.svc.startRun({ repoId: repo.id, pipeline: 'slow', ref: 'main' });
    const quick = await h.svc.startRun({ repoId: repo.id, pipeline: 'quick', ref: 'main' });
    await h.until('the slow run to start', () => h.svc.list().items.find((r) => r.id === slow.id)!.status === 'running');
    await h.svc.poll(WS);
    assert.equal(h.svc.list().items.find((r) => r.id === quick.id)!.status, 'queued', 'one at a time');
    // Cancel the queued one: settled in the portal. Then the running one: stopped in the workspace.
    const q = await h.svc.cancel(quick.id, { actor: 'portal-mcp:ptk_x', label: 'relay' });
    assert.deepEqual([q.status, q.cancelledBy, q.cancelledByLabel, q.cancelNote], ['cancelled', 'portal-mcp:ptk_x', 'relay', null], 'who cancelled it is kept (T-95)');
    assert.equal(await codeOf(() => h.svc.cancel(quick.id)), 'CONFLICT');
    await h.svc.cancel(slow.id);
    await h.until('the cancel to show', () => h.svc.list().items.find((r) => r.id === slow.id)!.status === 'cancelled');
    const done = await h.run(slow.id);
    assert.deepEqual([done.status, done.reason, done.detail[0]!.steps[0]!.status], ['cancelled', 'cancelled', 'cancelled']);
    assert.equal(done.cancelledBy, 'ui', 'a cancel without an actor is the UI\'s');
    const again = await h.svc.rerun(quick.id);
    assert.deepEqual([again.status, again.cancelledBy], ['queued', null], 'a rerun does not inherit the cancel');
    await h.until('the rerun to pass', () => h.svc.list().items[0]!.status === 'passed');
  } finally {
    h.done();
  }
});

test('concurrency.group with cancel-in-progress: the newer run cancels the older and starts after it', async () => {
  const h = await harness({ maxRunsPerWorkspace: 3 });
  try {
    const repo = await remote(h, { '.pilot/g.yml': 'on: manual\nconcurrency: { group: "g-${{ ci.branch }}", cancel-in-progress: true }\njobs:\n  a:\n    steps: [{run: "sleep 20; echo done"}]\n' });
    const first = await h.svc.startRun({ repoId: repo.id, pipeline: 'g', ref: 'main' });
    await h.until('the first to start', () => h.svc.list().items.find((r) => r.id === first.id)!.status === 'running');
    const second = await h.svc.startRun({ repoId: repo.id, pipeline: 'g', ref: 'main' });
    await h.until('the first to be superseded', () => h.svc.list().items.find((r) => r.id === first.id)!.status === 'cancelled');
    const old = await h.run(first.id);
    assert.equal(old.status, 'cancelled');
    await h.until('the supersede to be recorded', () => h.svc.list().items.find((r) => r.id === first.id)!.cancelledBy === 'pipeline');
    assert.equal(h.svc.list().items.find((r) => r.id === first.id)!.cancelNote, `for #${second.number}`, 'a stale run says which run replaced it (T-95)');
    await h.until('the second to start', () => h.svc.list().items.find((r) => r.id === second.id)!.status === 'running');
    await h.svc.cancel(second.id);
  } finally {
    h.done();
  }
});

test('the portal restarting between storing an event and acknowledging it makes no second run; a run in flight is picked up', async () => {
  const h = await harness();
  try {
    await remote(h, { '.pilot/ci.yml': 'on: push\njobs:\n  a:\n    steps: [{run: "sleep 2; echo survived"}]\n' });
    h.home.git(['checkout', '-q', '-b', 'r1'], h.src);
    h.home.commit(h.src, { 'x.txt': 'x' }, 'x');
    h.home.git(['push', '-q', 'pilot', 'r1'], h.src);
    await h.until('the run to be running', () => h.svc.list().items[0]?.status === 'running');
    const id = h.svc.list().items[0]!.id;

    // A new service on the same database and workspace: nothing remembered in memory (no acknowledgements, no cursors).
    const reborn = new CiService(h.store, h.host, { pollActiveMs: 50, pollIdleMs: 50 });
    // The event is still in the workspace unacknowledged: put it back as if the acknowledgement was lost.
    h.home.sh(`mv ${join(h.home.home, '.claudepilot/ci/events/done')}/*.json ${join(h.home.home, '.claudepilot/ci/events')}/ 2>/dev/null; true`);
    assert.ok(h.home.sh(`ls ${join(h.home.home, '.claudepilot/ci/events')}`).includes('.json'), 'the event is waiting in the workspace again');
    for (let i = 0; i < 100 && reborn.list().items[0]?.status !== 'passed'; i++) {
      await reborn.poll(WS);
      await sleep(100);
    }
    assert.equal(reborn.list().items.length, 1, 'the redelivered event made no second run');
    assert.deepEqual([reborn.list().items[0]!.id, reborn.list().items[0]!.status], [id, 'passed']);
    assert.match((await reborn.log(id, 'a', 0, 0)).text, /survived/);
  } finally {
    h.done();
  }
});

test('a run whose supervisor died is marked lost and can be run again; a stopped workspace is not asked', async () => {
  const h = await harness();
  try {
    const repo = await remote(h, { '.pilot/s.yml': 'on: manual\njobs:\n  a:\n    steps: [{run: sleep 30}]\n  b:\n    needs: [a]\n    steps: [{run: echo b}]\n' });
    const run = await h.svc.startRun({ repoId: repo.id, pipeline: 's', ref: 'main' });
    await h.until('it to run', () => h.svc.list().items[0]!.status === 'running');
    await sleep(800);
    const pid = Number(readFileSync(join(h.home.home, '.claudepilot/ci/runs', run.id, 'supervisor.pid'), 'utf8').trim().split(' ')[0]);
    process.kill(pid, 'SIGKILL');
    h.host.running = false;
    const callsBefore = h.host.calls.length;
    await h.svc.poll(WS);
    assert.equal(h.host.calls.length, callsBefore, 'nothing is asked of a stopped workspace');
    assert.equal(h.svc.list().items[0]!.status, 'running', 'its state waits for the workspace to come back');
    h.host.running = true;
    await h.until('it to be found lost', () => h.svc.list().items[0]!.status === 'failed');
    const lost = await h.run(run.id);
    assert.deepEqual([lost.status, lost.reason], ['failed', 'runner_lost']);
    assert.deepEqual(lost.detail.map((j) => [j.id, j.status, j.reason]), [['a', 'failed', 'runner_lost'], ['b', 'cancelled', 'runner_lost']]);
    h.home.sh('pkill -f "sleep 30" || true');
    assert.equal((await h.svc.rerun(run.id)).status, 'queued');
    await h.svc.cancel(h.svc.list().items[0]!.id).catch(() => undefined);
  } finally {
    h.done();
  }
});

test('logs: live reads are redacted and in whole lines; a finished run is served from the portal and survives the workspace', async () => {
  const h = await harness();
  try {
    const key = `sk-ant-api03-${'k'.repeat(30)}`;
    const repo = await remote(h, { '.pilot/l.yml': `on: manual\njobs:\n  a:\n    steps:\n      - run: "echo start; echo token=${key}; echo -----BEGIN RSA PRIVATE KEY-----; echo MIIEabc123secretbody; echo -----END RSA PRIVATE KEY-----; sleep 3; echo end"\n` });
    const run = await h.svc.startRun({ repoId: repo.id, pipeline: 'l', ref: 'main' });
    await h.until('it to run', () => h.svc.list().items[0]!.status === 'running');
    let live = { text: '', next: 0, done: false, source: 'workspace' as string };
    let seen = '';
    for (let i = 0; i < 60 && !seen.includes('start'); i++) {
      live = await h.svc.log(run.id, 'a', 0, seen.length === 0 ? 0 : live.next);
      seen += live.text;
      await sleep(150);
    }
    assert.equal(live.source, 'workspace');
    assert.ok(seen.includes('start'));
    await h.until('it to finish', () => h.svc.list().items[0]!.status === 'passed');
    const kept = await h.svc.log(run.id, 'a', 0, 0);
    assert.equal(kept.source, 'archive');
    assert.ok(kept.text.includes('start') && kept.text.includes('end'));
    assert.ok(!kept.text.includes(key), 'the key is not in what the portal stored');
    assert.ok(!kept.text.includes('MIIEabc123secretbody'), 'nor the body of a private key');
    const stored = (h.store.db!.prepare('SELECT text FROM ci_logs').all() as { text: string }[]).map((r) => r.text).join('');
    assert.ok(!stored.includes(key) && !stored.includes('MIIEabc123secretbody'));
    // The workspace's own copy can go away: the portal still has the log.
    h.home.sh(`rm -rf ${join(h.home.home, '.claudepilot/ci/runs')}`);
    assert.ok((await h.svc.log(run.id, 'a', 0, 0)).text.includes('end'));
    assert.equal(await codeOf(() => h.svc.log(run.id, '../x', 0, 0)), 'VALIDATION_FAILED');
    assert.equal(await codeOf(() => h.svc.log(run.id, 'a', -1, 0)), 'VALIDATION_FAILED');
    assert.equal(await codeOf(() => h.svc.log('nope', 'a', 0, 0)), 'NOT_FOUND');
  } finally {
    h.done();
  }
});

test('remotes: created, protected branches edited, connected, listed with branches and run chips, deleted', async () => {
  const h = await harness();
  try {
    const repo = await remote(h);
    assert.equal(await codeOf(() => h.svc.createRepo({ workspaceId: WS, name: 'app' })), 'CONFLICT', 'a name is taken');
    assert.equal(await codeOf(() => h.svc.createRepo({ workspaceId: WS, name: '../x' })), 'VALIDATION_FAILED');
    assert.equal(await codeOf(() => h.svc.createRepo({ workspaceId: 'x', name: 'y' })), 'VALIDATION_FAILED');
    assert.equal(await codeOf(() => h.svc.createRepo({ workspaceId: WS, name: 'z', source: '/etc' })), 'VALIDATION_FAILED');
    assert.equal(await codeOf(() => h.svc.createRepo({ workspaceId: WS, name: 'z', source: 'relative' })), 'VALIDATION_FAILED');

    const updated = await h.svc.updateRepo(repo.id, { protected: ['main', 'release/*'] });
    assert.deepEqual(updated.protected, ['main', 'release/*']);
    assert.equal(await codeOf(() => h.svc.updateRepo(repo.id, { protected: ['bad name'] })), 'VALIDATION_FAILED');
    const other = h.home.repo('other');
    const connected = await h.svc.connectRepo(repo.id, { path: other });
    assert.ok(connected.connected.includes(other));
    assert.equal(await codeOf(() => h.svc.connectRepo(repo.id, { path: '/etc' })), 'VALIDATION_FAILED');

    h.home.git(['checkout', '-q', '-b', 'chip'], h.src);
    h.home.commit(h.src, { 'c.txt': 'c' }, 'chip commit');
    h.home.git(['push', '-q', 'pilot', 'chip'], h.src);
    await h.until('its run to pass', () => h.svc.list().items[0]?.status === 'passed');
    const branches = await h.svc.branches(repo.id);
    const chip = branches.find((b) => b.name === 'chip')!;
    assert.deepEqual([chip.protected, chip.subject, chip.runs.map((r) => [r.pipeline, r.status])], [false, 'chip commit', [['ci', 'passed']]]);
    assert.equal(branches.find((b) => b.name === 'main')!.protected, true);

    // A remote with a run going can't be deleted; after, its folder and its record go and the history stays.
    const live = await h.svc.startRun({ repoId: repo.id, pipeline: 'ci', ref: 'main' });
    assert.equal(await codeOf(() => h.svc.deleteRepo(repo.id)), 'CONFLICT');
    await h.until('it to pass', () => h.svc.list().items.find((r) => r.id === live.id)!.status === 'passed');
    await h.svc.deleteRepo(repo.id);
    assert.equal(existsSync(join(h.home.home, '.claudepilot/git/app.git')), false);
    assert.deepEqual(await h.svc.repos(), []);
    assert.ok(h.svc.list().items.length >= 2, 'the runs stay');
    assert.equal(await codeOf(() => h.svc.branches(repo.id)), 'NOT_FOUND');
  } finally {
    h.done();
  }
});

test('validate reads files given as text and makes no call to a workspace', async () => {
  const h = await harness();
  try {
    const before = h.host.calls.length;
    const r = h.svc.validate({ files: { '.pilot/ci.yml': PIPELINE, '.pilot/bad.yml': 'on: push\njobs: {}\n', 'README.md': 'ignored' } });
    assert.deepEqual(r.pipelines.map((p) => [p.file, p.valid]), [['.pilot/bad.yml', false], ['.pilot/ci.yml', true]]);
    assert.equal(h.host.calls.length, before);
    assert.throws(() => h.svc.validate({ files: 'x' as never }), AppError);
    assert.throws(() => h.svc.validate({ files: { '.pilot/a.yml': 5 as never } }), AppError);
  } finally {
    h.done();
  }
});

test('a workspace that errors is tried again, and its trouble is reported once', async () => {
  const h = await harness();
  try {
    await remote(h);
    const logged: string[] = [];
    const orig = console.error;
    console.error = (m: unknown) => void logged.push(String(m));
    try {
      h.host.failNext = new Error('connection dropped');
      await h.svc.poll(WS);
      h.host.failNext = new Error('connection dropped');
      await h.svc.poll(WS);
    } finally {
      console.error = orig;
    }
    assert.equal(logged.filter((l) => l.includes('connection dropped')).length, 1, 'one line per distinct problem');
    h.home.git(['checkout', '-q', '-b', 'later'], h.src);
    h.home.commit(h.src, { 'l.txt': 'l' }, 'l');
    h.home.git(['push', '-q', 'pilot', 'later'], h.src);
    await h.until('the run after the trouble', () => h.svc.list().items[0]?.status === 'passed');
  } finally {
    h.done();
  }
});

test('start does nothing on a database CI can not use, and the timer ticks on its own', async () => {
  const h = await harness({ pollActiveMs: 30, pollIdleMs: 30 });
  try {
    await remote(h);
    h.home.git(['checkout', '-q', '-b', 'auto'], h.src);
    h.home.commit(h.src, { 'a.txt': 'a' }, 'a');
    h.home.git(['push', '-q', 'pilot', 'auto'], h.src);
    h.svc.start();
    for (let i = 0; i < 150 && h.svc.list().items[0]?.status !== 'passed'; i++) await sleep(200);
    assert.equal(h.svc.list().items[0]?.status, 'passed', 'the portal found the push and ran it with no one asking');
    h.svc.stop();
  } finally {
    h.done();
  }
});

test('secrets: a job that names one the workspace cannot give fails before it starts, with the reason; one it can give is masked everywhere', async () => {
  const known = new Map<string, { kind: string; asFile: boolean; asVariable: boolean }>([
    ['NPM_TOKEN', { kind: 'secret', asFile: true, asVariable: false }],
    ['ONLY_VAR', { kind: 'variable', asFile: false, asVariable: true }],
  ]);
  const other = 'hunter2-not-declared-anywhere';
  const values = valueRedactors(() => [other]);
  const h = await harness({ secrets: (_ws, name) => known.get(name) ?? null, redactFor: values.redactFor, streamFor: values.streamFor });
  try {
    const repo = await remote(h, {
      '.pilot/ok.yml': 'on: manual\njobs:\n  a:\n    secrets: [NPM_TOKEN]\n    steps:\n      - run: echo "token=$NPM_TOKEN"; echo "stray=' + other + '"\n',
      '.pilot/missing.yml': 'on: manual\njobs:\n  a:\n    secrets: [NOT_ASSIGNED]\n    steps: [{run: echo x}]\n',
      '.pilot/var.yml': 'on: manual\njobs:\n  a:\n    secrets: [ONLY_VAR]\n    steps: [{run: echo x}]\n  b:\n    if: ci.branch == \'nope\'\n    secrets: [SKIPPED_JOB_NOT_CHECKED]\n    steps: [{run: echo x}]\n',
    });
    h.home.sh(`mkdir -p ${join(h.home.home, 'secrets/files')}; printf 'npm_live_abcdef0123456789' > ${join(h.home.home, 'secrets/files/NPM_TOKEN')}`);

    const miss = await h.svc.startRun({ repoId: repo.id, pipeline: 'missing', ref: 'main' });
    assert.deepEqual([miss.status, miss.reason, miss.diagnostics.map((d) => [d.code, d.path])], ['failed', 'invalid_pipeline', [['secret-missing', 'jobs.a.secrets']]]);
    assert.match(miss.diagnostics[0]!.message, /NOT_ASSIGNED is not available in this workspace/);
    const variable = await h.svc.startRun({ repoId: repo.id, pipeline: 'var', ref: 'main' });
    assert.match(variable.diagnostics[0]!.message, /ONLY_VAR reaches Claude Code as a variable only/);
    assert.equal(variable.diagnostics.length, 1, 'a job its condition leaves out is not checked');

    const run = await h.svc.startRun({ repoId: repo.id, pipeline: 'ok', ref: 'main' });
    await h.until('it to pass', () => h.svc.list().items.find((r) => r.id === run.id)!.status === 'passed');
    const log = (await h.svc.log(run.id, 'a', 0, 0)).text;
    assert.ok(log.includes('token=[redacted]'), log);
    assert.ok(!log.includes('npm_live_abcdef0123456789'), 'the declared secret is masked at its source');
    assert.ok(!log.includes(other), 'another exposed secret is taken out by value before the portal keeps it');
    const plans = (h.store.db!.prepare('SELECT plan FROM ci_runs').all() as { plan: string | null }[]).map((r) => r.plan ?? '').join('');
    const logs = (h.store.db!.prepare('SELECT text FROM ci_logs').all() as { text: string }[]).map((r) => r.text).join('');
    assert.ok(!plans.includes('npm_live_abcdef0123456789'), 'the plan only names the secret');
    assert.ok(!logs.includes('npm_live_abcdef0123456789') && !logs.includes(other), 'no value in the kept logs');

    // The pipelines view says the same as a warning, before anyone runs it.
    const infos = await h.svc.pipelines(repo.id);
    const w = infos.find((p) => p.file === '.pilot/missing.yml')!;
    assert.deepEqual([w.valid, w.diagnostics.map((d) => [d.severity, d.code])], [true, [['warning', 'secret-missing']]]);
    assert.deepEqual(infos.find((p) => p.file === '.pilot/ok.yml')!.diagnostics, []);
  } finally {
    h.done();
  }
});
