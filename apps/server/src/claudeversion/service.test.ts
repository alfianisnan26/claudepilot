// The version service (docs/prd/claude-version-pinning.md §7, §8): what a workspace runs next to its pin, the plan and the gates of Apply, Rollback, the
// images and their pruning, the default pin, the canary (one at a time, honest when it cannot run) and the schedule, against in-memory fakes.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { CLAUDE_CANARY_CHECKS, CLAUDE_CANARY_SUITE, type ChatSession, type ClaudeVersionWarning } from '@portal/contracts';
import { clearResolvers, ownerActor, registerResolver, singleOwner, systemActor, useAuthz } from '../authz/seam.js';
import { harness, outcome, ref, until, type Harness } from './testkit.js';

const owner = ownerActor();
let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
  clearResolvers();
});
const refused = (code: string, text?: RegExp) => (e: unknown) => isAppError(e) && e.code === code && (!text || text.test(e.message));
const session = (id: string, workspaceId: string, state: ChatSession['state']): ChatSession => ({ id, workspaceId, title: `Chat ${id}`, state }) as ChatSession;

/** Runs the canary on a version and waits for it; returns the run. */
async function canaryOn(x: Harness, version: string, failing: string[] = [], skipped: string[] = []) {
  x.control.canary = () => outcome(version, failing, skipped);
  const started = await x.svc.startCanary({ subject: 'target', version }, { trigger: 'manual', actor: owner });
  await until(() => x.svc.store.run(started.id)!.status !== 'running' && !x.svc.canaryRunning, 'the canary to finish');
  return x.svc.run(started.id);
}

test('what a workspace runs next to its pin: facts from caches, unknown stays unknown, flags only for what is known', async () => {
  h = await harness({ workspaces: [{ name: 'api' }, { name: 'old', running: '2.1.280', doctor: 'Auto-updates: enabled' }, { name: 'asleep', status: 'stopped', running: null }] });
  const list = await h.svc.infos(owner);
  assert.deepEqual(Object.keys(list).sort(), ['docker/api', 'docker/asleep', 'docker/old']);
  const api = list['docker/api']!;
  assert.deepEqual([api.pinned, api.running, api.imageTag, api.autoUpdate, api.tested, api.differs, api.flags, api.canRecreate], ['2.1.296', '2.1.296', ref('2.1.296'), 'off', true, false, [], true]);
  assert.ok(api.checkedAt, 'the reading carries its time');
  const old = list['docker/old']!;
  assert.deepEqual([old.running, old.autoUpdate, old.differs, old.flags], ['2.1.280', 'on', true, ['differs', 'below-minimum', 'auto-update-on', 'untested']]);
  assert.ok(old.belowMinimum.some((b) => b.feature === 'mcp-sets' && b.needs === '2.1.296'));
  const asleep = list['docker/asleep']!;
  assert.deepEqual([asleep.running, asleep.autoUpdate, asleep.tested, asleep.flags, asleep.checkedAt], [null, 'unknown', null, [], null], 'a stopped workspace is unknown, not fine and not wrong');
  // The list's brief is from caches only and never probes.
  const brief = h.svc.brief({ id: 'docker/old', name: 'old', target: 'docker', image: 'x', status: 'running', createdAt: '', claude: { pinned: '2.1.296', running: null, flags: [] } });
  assert.deepEqual([brief.pinned, brief.running, brief.flags], ['2.1.296', '2.1.280', ['differs', 'below-minimum', 'auto-update-on', 'untested']]);
  await assert.rejects(() => h!.svc.info('docker/nope'), refused('NOT_FOUND'));
});

test('the background pass reads old workspaces a few at a time, so the list’s flags fill in; stopped ones are left alone', async () => {
  h = await harness({ workspaces: [{ name: 'a' }, { name: 'b', doctor: 'Auto-updates: enabled' }, { name: 'c', status: 'stopped', running: null }, { name: 'd' }] });
  const flagsOf = (name: string) => h!.svc.brief({ id: `docker/${name}`, name, target: 'docker', image: 'x', status: 'running', createdAt: '', claude: { pinned: '2.1.296', running: null, flags: [] } }).flags;
  assert.deepEqual(flagsOf('b'), [], 'nothing read yet: nothing flagged');
  assert.equal(await h.svc.refreshReadings(2), 2, 'at most two per pass');
  assert.equal(await h.svc.refreshReadings(5), 1, 'the next pass reads the one left (the stopped one is not read, the fresh ones are not read again)');
  assert.deepEqual(flagsOf('b'), ['auto-update-on']);
  assert.deepEqual(flagsOf('a'), []);
  assert.equal(await h.svc.refreshReadings(5), 0, 'everything is fresh');
  h.clock.t += 31 * 60_000;
  assert.equal(await h.svc.refreshReadings(5), 3, 'half an hour later the three running workspaces are read again');
});

test('the default pin: the built-in one until a person picks another whose image exists; PORTAL_WORKSPACE_IMAGE fixes it', async () => {
  h = await harness();
  assert.equal(h.svc.defaultVersion(), '2.1.296');
  assert.equal(h.svc.defaultForNew(), '2.1.296');
  await assert.rejects(() => h!.svc.setDefault('2.1.300', owner), refused('CONFLICT', /Build the image/));
  await assert.rejects(() => h!.svc.setDefault('latest', owner), refused('VALIDATION_FAILED'));
  h.images.set(ref('2.1.300'), { ref: ref('2.1.300'), id: 'sha256:x', version: '2.1.300', builtAt: null, sizeBytes: null });
  assert.deepEqual(await h.svc.setDefault('2.1.300', owner), { defaultVersion: '2.1.300' });
  assert.equal(h.svc.defaultForNew(), '2.1.300');
  assert.equal(h.audit.at(-1)!.kind, 'claude.default_set');
  assert.deepEqual([h.audit.at(-1)!.actor, h.audit.at(-1)!.severity, h.audit.at(-1)!.detail], ['user:u_owner', 'medium', { version: '2.1.300' }]);
  const fixed = await harness({ imageFixed: true });
  assert.equal(fixed.svc.defaultForNew(), undefined, 'the image was named whole: the pin is not applied to new workspaces');
  await assert.rejects(() => fixed.svc.setDefault('2.1.296', owner), refused('CONFLICT', /PORTAL_WORKSPACE_IMAGE/));
  fixed.cleanup();
});

test('the plan lists what stands in the way, in order: image, canary, failures, staleness, an operation in flight', async () => {
  h = await harness({ installed: ['2.1.296'] });
  let plan = await h.svc.plan('docker/api', '2.1.300', owner);
  assert.deepEqual([plan.from, plan.to, plan.imageReady, plan.canary, plan.appliable], ['2.1.296', '2.1.300', false, null, false]);
  assert.deepEqual(plan.blockers, ['Build the image first.', 'Run the canary first.']);
  assert.ok(plan.willLose.length >= 2 && plan.willLose.some((l) => /outside the home folder/.test(l)));
  assert.deepEqual((await h.svc.plan('docker/api', '2.1.296', owner)).blockers, ['It is already on 2.1.296.', 'Run the canary first.']);
  await assert.rejects(() => h!.svc.plan('docker/api', '^2', owner), refused('VALIDATION_FAILED'));
  await assert.rejects(() => h!.svc.plan('docker/zzz', '2.1.300', owner), refused('NOT_FOUND'));
  await h.svc.buildImage('2.1.300', owner);
  await until(() => h!.svc.building().length === 0, 'the build');
  assert.deepEqual(h.built, ['2.1.300']);
  await canaryOn(h, '2.1.300', ['get-usage']);
  plan = await h.svc.plan('docker/api', '2.1.300', owner);
  assert.deepEqual([plan.imageReady, plan.canary!.verdict, plan.canary!.failed, plan.appliable], [true, 'fail', ['get-usage'], false]);
  assert.match(plan.blockers[0]!, /The canary failed: get-usage\. Accept the failed items/);
  const green = await canaryOn(h, '2.1.300');
  plan = await h.svc.plan('docker/api', '2.1.300', owner);
  assert.deepEqual([plan.canary!.runId, plan.canary!.verdict, plan.appliable, plan.blockers], [green.id, 'pass', true, []]);
});

test('a scheduled candidate run (a scratch install) informs the plan but never clears an Apply: only a canary on the version’s own image does', async () => {
  h = await harness();
  await h.svc.buildImage('2.1.300', owner);
  await until(() => h!.svc.building().length === 0, 'the build');
  h.control.candidateBody = JSON.stringify({ latest: '2.1.300' });
  h.control.canary = (t) => outcome(t.version, t.mode === 'scratch' ? ['get-usage'] : []);
  await h.svc.startCanary({ subject: 'installed' }, { trigger: 'manual', actor: owner });
  await until(() => !h!.svc.canaryRunning, 'the installed run');
  const cand = await h.svc.startCanary({ subject: 'candidate' }, { trigger: 'scheduled', actor: owner });
  await until(() => !h!.svc.canaryRunning, 'the candidate run');
  assert.equal(h.svc.run(cand.id).mode, 'scratch');
  const plan = await h.svc.plan('docker/api', '2.1.300', owner);
  assert.equal(plan.canary, null, 'the scratch run is not the image’s canary');
  assert.deepEqual(plan.blockers, ['Run the canary first.', 'The scheduled canary found 2.1.300 fails get-usage.']);
  await assert.rejects(() => h!.svc.apply('docker/api', { version: '2.1.300', canaryRunId: cand.id, confirm: true }, owner), refused('CONFLICT', /Run the canary on that version first/));
  const real = await canaryOn(h, '2.1.300');
  assert.deepEqual([(await h.svc.plan('docker/api', '2.1.300', owner)).appliable, real.mode], [true, 'image']);
});

test('the plan names the running sessions and counts terminals; a session the asker may not see is counted, not named', async () => {
  h = await harness();
  h.control.sessions = [session('s1', 'docker/api', 'working'), session('s2', 'docker/api', 'idle'), session('s3', 'docker/api', 'ended'), session('s4', 'docker/other', 'working'), session('s5', 'docker/api', 'interrupted')];
  h.control.terminals = 2;
  let plan = await h.svc.plan('docker/api', '2.1.300', owner);
  assert.deepEqual(plan.sessions.map((s) => s.id), ['s1', 's2'], 'running ones on this workspace only (ended, interrupted and other workspaces are not interrupted by it)');
  assert.deepEqual([plan.terminals, plan.hiddenSessions], [2, 0]);
  // Multi-user: another user's private session is counted, never named (default deny through a resolver).
  registerResolver({ type: 'session', resolve: (id) => ({ ref: { type: 'session', id }, owner: { kind: 'user', id: id === 's2' ? 'u_other' : 'u_owner' } }) });
  plan = await h.svc.plan('docker/api', '2.1.300', owner);
  assert.deepEqual([plan.sessions.map((s) => s.id), plan.hiddenSessions], [['s1'], 1]);
});

test('Apply: a finished green canary for that version, the failed items accepted by name, and a confirm; nothing happens before', async () => {
  h = await harness();
  const req = { version: '2.1.300', confirm: true };
  await assert.rejects(() => h!.svc.apply('docker/api', req, owner), refused('CONFLICT', /Build the image/));
  await h.svc.buildImage('2.1.300', owner);
  await until(() => h!.svc.building().length === 0, 'the build');
  await assert.rejects(() => h!.svc.apply('docker/api', req, owner), refused('CONFLICT', /Run the canary on that version first/));
  const red = await canaryOn(h, '2.1.300', ['stream-turn', 'get-usage']);
  await assert.rejects(() => h!.svc.apply('docker/api', { ...req, canaryRunId: red.id }, owner), refused('CONFLICT', /failed: stream-turn, get-usage/));
  await assert.rejects(() => h!.svc.apply('docker/api', { ...req, canaryRunId: red.id, acceptFailed: ['stream-turn'] }, owner), refused('CONFLICT', /get-usage/), 'accepting one of two is not enough');
  await assert.rejects(() => h!.svc.apply('docker/api', { ...req, canaryRunId: red.id, acceptFailed: ['stream-turn', 'get-usage'], confirm: false }, owner), refused('CONFIRMATION_REQUIRED'));
  assert.deepEqual(h.recreated, [], 'nothing was applied by any refusal');
  assert.equal(h.workspaces[0]!.image.version, '2.1.296');
  // A canary of another version, or one that was not finished, clears nothing.
  const other = await canaryOn(h, '2.1.296');
  await assert.rejects(() => h!.svc.apply('docker/api', { ...req, canaryRunId: other.id }, owner), refused('CONFLICT', /Run the canary on that version first/));
  const op = await h.svc.apply('docker/api', { ...req, canaryRunId: red.id, acceptFailed: ['stream-turn', 'get-usage'], confirm: true }, owner);
  assert.deepEqual([op.kind, op.status, op.from, op.to], ['upgrade', 'running', '2.1.296', '2.1.300']);
  await assert.rejects(() => h!.svc.apply('docker/api', { ...req, canaryRunId: red.id, acceptFailed: ['stream-turn', 'get-usage'], confirm: true }, owner), refused('CONFLICT', /already running/));
  await until(async () => (await h!.svc.info('docker/api')).operation === null && h!.recreated.length === 1, 'the recreate');
  assert.deepEqual(h.recreated, [{ name: 'api', image: ref('2.1.300') }]);
  const info = await h.svc.info('docker/api');
  assert.deepEqual([info.pinned, info.running, info.imageTag, info.previous?.version, info.previous?.image], ['2.1.300', '2.1.300', ref('2.1.300'), '2.1.296', ref('2.1.296')]);
  const [row] = h.svc.history('docker/api');
  assert.deepEqual([row!.kind, row!.fromVersion, row!.toVersion, row!.canary, row!.accepted, row!.outcome, row!.actor, row!.canaryRunId], ['upgrade', '2.1.296', '2.1.300', 'fail', ['stream-turn', 'get-usage'], 'applied', 'user:u_owner', red.id]);
  assert.ok(!('fromImageId' in row!), 'the internal image id is not in the contract');
  const kinds = h.audit.map((a) => a.kind);
  assert.ok(kinds.includes('claude.upgrade_start') && kinds.includes('claude.upgrade'), kinds.join(','));
  assert.equal(h.audit.find((a) => a.kind === 'claude.upgrade')!.subject, 'docker/api');
  await assert.rejects(() => h!.svc.apply('docker/api', req, owner), refused('CONFLICT', /already on 2\.1\.300/));
});

test('a canary from an older suite, or older than a week, is not enough', async () => {
  h = await harness();
  await h.svc.buildImage('2.1.300', owner);
  await until(() => h!.svc.building().length === 0, 'the build');
  const run = await canaryOn(h, '2.1.300');
  h.store.db!.prepare('UPDATE claude_canary_runs SET suite = ? WHERE id = ?').run(CLAUDE_CANARY_SUITE - 1, run.id);
  await assert.rejects(() => h!.svc.apply('docker/api', { version: '2.1.300', canaryRunId: run.id, confirm: true }, owner), refused('CONFLICT', /old: run it again/));
  assert.match((await h.svc.plan('docker/api', '2.1.300', owner)).blockers.join(' '), /old: run it again/);
  h.store.db!.prepare('UPDATE claude_canary_runs SET suite = ? WHERE id = ?').run(CLAUDE_CANARY_SUITE, run.id);
  assert.equal((await h.svc.plan('docker/api', '2.1.300', owner)).appliable, true, 'a current-suite run of today clears it');
  h.clock.t += 8 * 86_400_000;
  await assert.rejects(() => h!.svc.apply('docker/api', { version: '2.1.300', canaryRunId: run.id, confirm: true }, owner), refused('CONFLICT', /old: run it again/));
});

test('a recreate that fails is recorded as failed (or restored when the runtime put the old container back), and nothing else changes', async () => {
  h = await harness();
  await h.svc.buildImage('2.1.300', owner);
  await until(() => h!.svc.building().length === 0, 'the build');
  const run = await canaryOn(h, '2.1.300');
  h.control.recreateFails = 'Could not start x: no space left on device. The workspace is back on claudepilot-workspace-t:cc-2.1.296.';
  const op = await h.svc.apply('docker/api', { version: '2.1.300', canaryRunId: run.id, confirm: true }, owner);
  await until(async () => (await h!.svc.info('docker/api')).operation === null, 'the failed recreate');
  const [row] = h.svc.history('docker/api');
  assert.deepEqual([row!.outcome, row!.toVersion, /back on/.test(row!.detail ?? '')], ['restored', '2.1.300', true]);
  assert.equal(h.workspaces[0]!.image.version, '2.1.296', 'still on the old version');
  assert.equal((await h.svc.info('docker/api')).previous, null, 'a failed change is not something to roll back');
  assert.ok(h.audit.some((a) => a.kind === 'claude.upgrade_failed' && a.severity === 'high'));
  assert.equal(op.status, 'running', 'the returned operation was a snapshot of the start');
  h.control.recreateFails = 'driver exploded';
  await h.svc.apply('docker/api', { version: '2.1.300', canaryRunId: run.id, confirm: true }, owner);
  await until(async () => h!.svc.history('docker/api').length === 2, 'the second failure');
  assert.equal(h.svc.history('docker/api')[0]!.outcome, 'failed');
});

test('Rollback: only to a previous applied tag, with a confirm; it can itself be rolled back; the old image is found by id when its tag moved', async () => {
  h = await harness();
  await assert.rejects(() => h!.svc.rollback('docker/api', { confirm: true }, owner), refused('CONFLICT', /nothing to roll back/));
  await h.svc.buildImage('2.1.300', owner);
  await until(() => h!.svc.building().length === 0, 'the build');
  const run = await canaryOn(h, '2.1.300');
  await h.svc.apply('docker/api', { version: '2.1.300', canaryRunId: run.id, confirm: true }, owner);
  await until(async () => h!.svc.history('docker/api').length === 1, 'the upgrade');
  await assert.rejects(() => h!.svc.rollback('docker/api', {}, owner), refused('CONFIRMATION_REQUIRED'));
  // The tag of the old image is gone, but the image is still there under the id recorded when it was left.
  const oldId = h.images.get(ref('2.1.296'))!.id;
  h.images.delete(ref('2.1.296'));
  h.images.set('sha256:untagged', { ref: 'sha256:untagged', id: oldId, version: '2.1.296', builtAt: null, sizeBytes: null });
  await h.svc.rollback('docker/api', { confirm: true }, owner);
  await until(async () => h!.svc.history('docker/api').length === 2, 'the rollback');
  assert.equal(h.recreated.at(-1)!.image, oldId, 'by the recorded image id');
  assert.deepEqual(h.built, ['2.1.300'], 'nothing had to be rebuilt');
  const info = await h.svc.info('docker/api');
  assert.deepEqual([info.pinned, info.running, info.previous?.version], ['2.1.296', '2.1.296', '2.1.300'], 'back on the old version; the rollback itself can be rolled back');
  const [row] = h.svc.history('docker/api');
  assert.deepEqual([row!.kind, row!.fromVersion, row!.toVersion, row!.canary, row!.canaryRunId, row!.outcome], ['rollback', '2.1.300', '2.1.296', 'none', null, 'applied']);
  await h.svc.rollback('docker/api', { confirm: true }, owner);
  await until(async () => h!.svc.history('docker/api').length === 3, 'the rollback of the rollback');
  assert.equal((await h.svc.info('docker/api')).running, '2.1.300');
});

test('Rollback to an image that was pruned: its tag names its version, so it is rebuilt first', async () => {
  h = await harness();
  await h.svc.buildImage('2.1.300', owner);
  await until(() => h!.svc.building().length === 0, 'the build');
  const run = await canaryOn(h, '2.1.300');
  await h.svc.apply('docker/api', { version: '2.1.300', canaryRunId: run.id, confirm: true }, owner);
  await until(async () => h!.svc.history('docker/api').length === 1, 'the upgrade');
  h.images.delete(ref('2.1.296'));
  await h.svc.rollback('docker/api', { confirm: true }, owner);
  await until(async () => h!.svc.history('docker/api').length === 2, 'the rollback');
  assert.deepEqual(h.built, ['2.1.300', '2.1.296'], 'the pruned version was built again');
  assert.equal(h.recreated.at(-1)!.image, ref('2.1.296'));
  assert.equal(h.svc.history('docker/api')[0]!.outcome, 'applied');
});

test('images: where each is used, what a Rollback needs, the default, and the last canary; prune never removes those, and lists first', async () => {
  h = await harness({ installed: ['2.1.296', '2.1.287', '2.1.290'] });
  await canaryOn(h, '2.1.290');
  // A workspace on 2.1.296 that was upgraded from 2.1.287 (its rollback target), and an unused 2.1.290.
  h.svc.store.addHistory({ workspaceId: 'docker/api', kind: 'upgrade', fromVersion: '2.1.287', toVersion: '2.1.296', fromImage: ref('2.1.287'), fromImageId: null, toImage: ref('2.1.296'), canaryRunId: null, canary: 'none', accepted: [], outcome: 'applied', detail: null, actor: 'user:u_owner' });
  const list = await h.svc.images();
  const by = Object.fromEntries(list.map((i) => [i.version, i]));
  assert.deepEqual([by['2.1.296']!.usedBy, by['2.1.296']!.isDefault, by['2.1.287']!.rollbackFor, by['2.1.290']!.usedBy, by['2.1.290']!.canary?.verdict], [['docker/api'], true, ['docker/api'], [], 'pass']);
  assert.deepEqual(list.map((i) => i.version), ['2.1.296', '2.1.290', '2.1.287'], 'newest first');
  const dry = await h.svc.prune({ dryRun: true }, owner);
  assert.deepEqual(dry.removed, [ref('2.1.290')]);
  assert.deepEqual(dry.kept.map((k) => [k.ref, k.why]).sort(), [[ref('2.1.287'), 'rollback for docker/api'], [ref('2.1.296'), 'used by docker/api']]);
  assert.ok(h.images.has(ref('2.1.290')), 'a dry run removes nothing');
  assert.deepEqual((await h.svc.prune({}, owner)).removed, [ref('2.1.290')]);
  assert.ok(!h.images.has(ref('2.1.290')) && h.images.has(ref('2.1.287')) && h.images.has(ref('2.1.296')));
  // By name: a rollback target may go when asked for, never one in use or the default, never a stranger's image.
  const named = await h.svc.prune({ refs: [ref('2.1.287'), ref('2.1.296'), 'other:latest'] }, owner);
  assert.deepEqual(named.removed, [ref('2.1.287')]);
  assert.deepEqual(named.kept.map((k) => k.ref).sort(), [ref('2.1.296'), 'other:latest']);
  assert.equal(named.kept.find((k) => k.ref === 'other:latest')!.why, 'not an image of this portal');
  assert.ok(h.audit.some((a) => a.kind === 'claude.image_prune' && a.severity === 'medium'));
});

test('the canary runs one at a time; it says so when it cannot run (no image for a scheduled run, an unreadable registry) and never guesses', async () => {
  h = await harness({ installed: [] });
  h.workspaces.length = 0;
  h.images.clear();
  // Scheduled: the default image is not built, so nothing runs and no container is made.
  const scheduled = await h.svc.startCanary({ subject: 'installed' }, { trigger: 'scheduled', actor: systemActor('claude-canary') });
  assert.deepEqual([scheduled.status, scheduled.verdict, scheduled.actor], ['unavailable', null, 'system:claude-canary']);
  assert.match(scheduled.note!, /default image .* is not built yet/);
  assert.deepEqual([h.started, h.runs], [[], []]);
  // A person asking builds the image first.
  await h.svc.startCanary({ subject: 'installed' }, { trigger: 'manual', actor: owner });
  await assert.rejects(() => h!.svc.startCanary({ subject: 'installed' }, { trigger: 'manual', actor: owner }), refused('CONFLICT', /one at a time/i));
  await until(() => !h!.svc.canaryRunning, 'the first canary');
  assert.deepEqual(h.built, ['2.1.296']);
  assert.equal(h.runs.length, 1);
  assert.deepEqual([h.runs[0]!.mode, h.runs[0]!.image, h.runs[0]!.version], ['image', ref('2.1.296'), '2.1.296']);
  // The candidate when the registry cannot be read: unavailable, with why.
  h.control.candidateOffline = true;
  const offline = await h.svc.startCanary({ subject: 'candidate' }, { trigger: 'scheduled', actor: systemActor('claude-canary') });
  assert.deepEqual([offline.status, offline.version, offline.mode], ['unavailable', null, 'scratch']);
  assert.match(offline.note!, /Could not reach the npm registry \(ENOTFOUND\)\. Nothing was guessed/);
  assert.equal(h.runs.length, 1, 'no container for a candidate nobody could name');
  await assert.rejects(() => h!.svc.startCanary({ subject: 'target', version: 'x' }, { trigger: 'manual', actor: owner }), refused('VALIDATION_FAILED'));
  await assert.rejects(() => h!.svc.startCanary({ subject: 'weird' as never }, { trigger: 'manual', actor: owner }), refused('VALIDATION_FAILED'));
});

test('the candidate: the same as installed is not run twice; a newer one runs in a scratch install on the installed image; breaks warn once', async () => {
  h = await harness();
  const told: ClaudeVersionWarning[] = [];
  h.svc.onWarning((w) => told.push(w));
  const installed = await h.svc.startCanary({ subject: 'installed' }, { trigger: 'manual', actor: owner });
  await until(() => !h!.svc.canaryRunning, 'the installed run');
  // Same as installed (the registry's newest is 2.1.296): the installed run answers for it.
  const same = await h.svc.startCanary({ subject: 'candidate' }, { trigger: 'scheduled', actor: owner });
  assert.equal(same.id, installed.id, 'no second run');
  assert.equal(h.runs.length, 1);
  // A newer one, which breaks two items the installed version passes.
  h.control.candidateBody = JSON.stringify({ stable: '2.1.296', latest: '2.1.300' });
  h.control.canary = (t) => outcome(t.version, t.version === '2.1.300' ? ['stream-turn', 'get-usage'] : []);
  const cand = await h.svc.startCanary({ subject: 'candidate' }, { trigger: 'scheduled', actor: owner });
  assert.deepEqual([cand.version, cand.mode, cand.subject], ['2.1.300', 'scratch', 'candidate']);
  await until(() => !h!.svc.canaryRunning, 'the candidate run');
  assert.deepEqual([h.runs.at(-1)!.mode, h.runs.at(-1)!.image], ['scratch', ref('2.1.296')], 'a scratch install on the INSTALLED image: no image was built');
  assert.deepEqual(h.built, [], 'no image for a candidate');
  const report = await h.svc.report();
  assert.deepEqual([report.breaks, report.candidateInfo.status, report.candidate!.version, report.installed!.version], [['stream-turn', 'get-usage'], 'newer', '2.1.300', '2.1.296']);
  const warnings = await h.svc.warnings(owner);
  const breaks = warnings.find((w) => w.kind === 'candidate-breaks')!;
  assert.match(breaks.detail, /Claude Code 2\.1\.300 .* fails Stream and Usage/);
  await until(() => told.length === 1, 'the warning sink');
  assert.equal(told[0]!.kind, 'candidate-breaks');
  // Run again: the same finding is not told twice.
  await h.svc.startCanary({ subject: 'candidate' }, { trigger: 'manual', actor: owner });
  await until(() => !h!.svc.canaryRunning, 'the second candidate run');
  await h.svc.idle();
  assert.equal(told.length, 1);
  const overview = await h.svc.overview(owner);
  assert.deepEqual([overview.defaultVersion, overview.installed, overview.report.breaks, overview.schedule.everyDays, overview.recreateTargets], ['2.1.296', '2.1.296', ['stream-turn', 'get-usage'], 7, ['docker']]);
  assert.ok(overview.images.length >= 1);
});

test('a canary that errors, or is cut short by a restart, says so and is no pass; the container is the runner’s to remove', async () => {
  h = await harness();
  h.control.canary = () => ({ status: 'error', note: 'The canary could not run: no Docker', reported: null, results: [] });
  const run = await h.svc.startCanary({ subject: 'installed' }, { trigger: 'manual', actor: owner });
  await until(() => !h!.svc.canaryRunning, 'the run');
  const done = h.svc.run(run.id);
  assert.deepEqual([done.status, done.verdict, done.note], ['error', null, 'The canary could not run: no Docker']);
  assert.ok((await h.svc.report()).installed === null, 'an errored run is not the installed version’s report');
  h.control.canary = () => { throw new Error('the runner blew up'); };
  const run2 = await h.svc.startCanary({ subject: 'installed' }, { trigger: 'manual', actor: owner });
  await until(() => !h!.svc.canaryRunning, 'the second run');
  assert.deepEqual([h.svc.run(run2.id).status, h.svc.run(run2.id).note], ['error', 'the runner blew up']);
  await assert.rejects(async () => h!.svc.run(9999), refused('NOT_FOUND'));
});

test('the schedule: off at 0, due when never run or older than the cadence; a scheduled pass runs installed then candidate as the system actor and asks the policy when it RUNS', async () => {
  h = await harness();
  h.control.days = 0;
  assert.equal(h.svc.due(), false);
  assert.equal(h.svc.schedule().nextAt, null);
  h.control.days = 7;
  assert.equal(h.svc.due(), true, 'never run');
  h.control.candidateBody = JSON.stringify({ latest: '2.1.300' });
  const runs = await h.svc.runScheduled();
  assert.deepEqual(runs.map((r) => [r.subject, r.trigger, r.actor]), [['installed', 'scheduled', 'system:claude-canary'], ['candidate', 'scheduled', 'system:claude-canary']]);
  await until(() => !h!.svc.canaryRunning, 'the scheduled runs');
  assert.equal(h.svc.due(), false, 'ran just now');
  const next = h.svc.schedule();
  assert.ok(next.lastAt && next.nextAt && Date.parse(next.nextAt) - Date.parse(next.lastAt) === 7 * 86_400_000);
  h.clock.t += 6 * 86_400_000;
  assert.equal(h.svc.due(), false, 'six days is inside a seven-day cadence');
  h.clock.t += 2 * 86_400_000;
  assert.equal(h.svc.due(), true, 'older than the cadence');
  // The job re-checks its right when it runs: a layer that no longer allows the system actor stops it.
  const was = useAuthz({ ...singleOwner, can: () => ({ allow: false, reason: 'no_right', level: 'none' }) });
  try {
    assert.deepEqual(await h.svc.runScheduled(), []);
  } finally {
    useAuthz(was);
  }
  assert.ok(h.audit.some((a) => a.kind === 'claude.canary_scheduled' && a.actor === 'system:claude-canary' && a.userId === null));
});

test('the cadence setting is audited as a platform act', async () => {
  h = await harness();
  h.svc.start();
  assert.equal(h.settingListeners.length, 1);
  h.settingListeners[0]!('claude.canaryDays', 14, 7);
  h.settingListeners[0]!('something.else', 1, 2);
  const rows = h.audit.filter((a) => a.kind === 'claude.schedule_set');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.actor, rows[0]!.detail], ['user:u_owner', { note: 'every 14 days (was 7)' }]);
  h.svc.stop();
  assert.equal(h.settingListeners.length, 0, 'stopped: unsubscribed');
});

test('warnings: the canary’s findings and each workspace’s own, most urgent first', async () => {
  h = await harness({ workspaces: [{ name: 'api' }, { name: 'old', running: '2.1.280', doctor: 'Auto-updates: enabled' }] });
  await canaryOn(h, '2.1.296', ['mcp-login']);
  h.store.db!.prepare("UPDATE claude_canary_runs SET subject = 'installed' WHERE version = '2.1.296'").run();
  const warnings = await h.svc.warnings(owner);
  assert.deepEqual(warnings.map((w) => w.kind), ['installed-fails', 'below-minimum', 'pin-differs', 'auto-update-on']);
  assert.deepEqual(warnings.map((w) => w.severity), ['urgent', 'attention', 'attention', 'info']);
  assert.ok(warnings.slice(1).every((w) => w.workspaceId === 'docker/old'));
  assert.equal(new Set(warnings.map((w) => w.id)).size, warnings.length);
});

test('checks and the registry are served as data', async () => {
  h = await harness();
  assert.deepEqual(h.svc.checks().map((c) => c.id), CLAUDE_CANARY_CHECKS.map((c) => c.id));
  assert.ok(h.svc.features().length >= 10);
});
