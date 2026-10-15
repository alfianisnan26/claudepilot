// Git worktrees per session: a chat that runs in a worktree of its own. What the portal asks the host to make, what it refuses
// before asking, how the new folder's trust is settled, and what happens to the folder when the chat is deleted or archived:
// kept unless the person says otherwise, and never removed over changes without their word.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { CHAT_FOLDER_UNTRUSTED, WORKTREE_DIRTY, type ChatFolderScan } from '@portal/contracts';
import { baseProblem, branchProblem, defaultBranch, slug, worktreeLeaf } from './worktrees.js';
import { EMPTY_SCAN, liveSession, until, type Live } from './testkit.js';

const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (isAppError(e) ? e : new Error(String(e))));
const HOME = '/home/node';
const REPO = `${HOME}/proj`;

/** A scan that names one MCP server, under a hash a test chooses. */
// Permission rules only: an MCP server, a hook or a linked skill is outside the hash and never copied (T-435, trustAuto.test.ts).
const scanOf = (hash: string) => JSON.stringify({ ...EMPTY_SCAN, hash, files: ['.claude/settings.json'], allowRules: 1, rulesOnly: true, broadAllow: false });

async function make(s: Live, req: Record<string, unknown> = {}, opts: Parameters<Live['controller']['create']>[1] = {}) {
  const before = s.ws.tails.length;
  const session = await s.controller.create({ workspaceId: 'docker/ws1', cwd: REPO, worktree: {}, ...req }, opts);
  await until(() => s.ws.tails.length === before + 1);
  return session;
}
const calls = (s: Live, cmd: string) => s.ws.wtCalls.filter((c) => c.cmd === cmd);
const dbRows = (s: Live) => s.store.db!.prepare('SELECT * FROM chat_worktrees').all() as Record<string, string | null>[];

test('names: branches and bases are checked before the host is asked; defaults read well and CI can parse the ticket one', () => {
  for (const ok of ['feat/x', 'ticket/12-fix-login', 'a.b_c-d', 'x'.repeat(100)]) assert.equal(branchProblem(ok), null, ok);
  for (const bad of ['', '-x', 'a..b', 'a b', 'a/', 'a//b', 'x.lock', 'a/.hidden', 'a.', 'é', 'x'.repeat(101), 'a;b', '$(id)']) assert.notEqual(branchProblem(bad), null, JSON.stringify(bad));
  for (const ok of ['main', 'origin/main', 'v1.2.3', 'abc1234', 'HEAD~2', 'main^', 'feat@x']) assert.equal(baseProblem(ok), null, ok);
  for (const bad of ['', '-x', '--output=x', 'a b', 'a;b', 'x'.repeat(101)]) assert.notEqual(baseProblem(bad), null, JSON.stringify(bad));
  assert.equal(slug('  Fix: the LOGIN redirect!! (café) '), 'fix-the-login-redirect-cafe');
  assert.equal(slug('???'), '');
  assert.equal(defaultBranch({ title: 'Fix the login redirect', token: 'ab12cd' }), 'session/fix-the-login-redirect-ab12cd');
  assert.equal(defaultBranch({ title: '???', token: 'ab12cd' }), 'session/chat-ab12cd');
  assert.equal(defaultBranch({ ticketId: 'T-12', title: 'T-12 Fix the login redirect', token: 'ab12cd' }), 'ticket/12-fix-the-login-redirect');
  assert.equal(defaultBranch({ ticketId: 'T-7', title: 'Fix it', token: 'x' }), 'ticket/7-fix-it');
  assert.equal(defaultBranch({ ticketId: 'T-7', title: '', token: 'x' }), 'ticket/7-work');
  assert.equal(worktreeLeaf('ticket/12-fix-login'), 'ticket-12-fix-login');
  assert.equal(worktreeLeaf('ticket/12-fix-login', 3), 'ticket-12-fix-login-3');
});

test('a chat started with a worktree runs in it: the host makes it, the chat’s folder is the worktree, and it is on the record', async () => {
  const s = await liveSession();
  try {
    const session = await make(s, { title: 'Fix the login redirect' });
    const [add] = calls(s, 'wt-add');
    assert.ok(add && add.args[0] === REPO && add.args[3] === '-', 'asked for the repository’s HEAD');
    assert.match(add!.args[2]!, /^session\/fix-the-login-redirect-[0-9a-f]{6}$/);
    assert.equal(add!.args[1], worktreeLeaf(add!.args[2]!));
    const path = `${REPO}.worktrees/${add!.args[1]}`;
    assert.deepEqual(session.worktree, { path, branch: add!.args[2], repo: REPO });
    assert.equal(session.cwd, path, 'the chat’s folder is the worktree');
    assert.ok(s.ws.startArgs.at(-1)!.includes(path), 'and Claude Code starts in it');
    assert.deepEqual(s.ws.scans.slice(-2), [REPO, path], 'the repository, then the new folder, were checked for trust');
    assert.deepEqual(dbRows(s).map((r) => [r.path, r.branch, r.session_id, r.state]), [[path, add!.args[2], session.id, 'active']]);
    assert.deepEqual(s.controller.audit({ kind: 'worktree.created' }).map((a) => [a.sessionId, a.detail.branch]), [[session.id, add!.args[2]]]);
    // A chat without the option never asks the host.
    s.ws.wtCalls.length = 0;
    await make(s, { worktree: undefined });
    assert.equal(s.ws.wtCalls.length, 0);
  } finally {
    await s.done();
  }
});

test('a ticket’s chat gets the branch CI reads, an explicit branch and base are taken as given, and a folder inside the repository maps into the worktree', async () => {
  const s = await liveSession();
  try {
    s.controller.ticketExists = () => true;
    await make(s, { ticketId: 'T-12', title: 'T-12 Fix the login redirect' }, { actor: 'ticket:T-12' });
    assert.equal(calls(s, 'wt-add')[0]!.args[2], 'ticket/12-fix-the-login-redirect');

    s.ws.wtCalls.length = 0;
    await make(s, { worktree: { branch: 'feat/own', base: 'origin/main' } });
    assert.deepEqual(calls(s, 'wt-add')[0]!.args.slice(2), ['feat/own', 'origin/main']);

    // The host says the repository's top and where the asked-for folder is inside it.
    s.ws.wtCalls.length = 0;
    s.ws.wtAdd = ([, leaf, branch]) => ({ code: 0, out: `ok\t${REPO}.worktrees/${leaf}\t${branch}\tc0ffee\t${REPO}\t/api\n` });
    const sub = await make(s, { cwd: `${REPO}/api` });
    assert.equal(sub.cwd, `${REPO}.worktrees/${calls(s, 'wt-add')[0]!.args[1]}/api`);
    assert.equal(sub.worktree!.repo, REPO);
  } finally {
    await s.done();
  }
});

test('what is refused is refused before or by the host with its own words, and leaves no chat and no record', async () => {
  const s = await liveSession();
  try {
    const before = s.controller.list().length;
    const refused = async (worktree: unknown, code: string) => {
      const e = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: REPO, worktree: worktree as never }));
      assert.equal(e && isAppError(e) ? e.code : String(e), code, JSON.stringify(worktree));
    };
    await refused({ branch: '-bad' }, 'VALIDATION_FAILED');
    await refused({ branch: 'a..b' }, 'VALIDATION_FAILED');
    await refused({ base: '--output=/tmp/x' }, 'VALIDATION_FAILED');
    await refused({ repo: 5 }, 'VALIDATION_FAILED');
    await refused('yes', 'VALIDATION_FAILED');
    assert.equal(s.ws.wtCalls.length, 0, 'none of that reached the host');
    for (const [exit, code, words] of [[3, 'VALIDATION_FAILED', /isn’t in a git repository/], [4, 'CONFLICT', /already checked out/], [5, 'VALIDATION_FAILED', /no “nope”/], [2, 'VALIDATION_FAILED', /home folder itself/], [1, 'SERVICE_UNAVAILABLE', /exit 1/]] as const) {
      s.ws.wtAdd = () => ({ code: exit, out: '' });
      const e = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: REPO, worktree: { base: 'nope' } }));
      assert.equal(e && isAppError(e) ? e.code : String(e), code, `exit ${exit}`);
      assert.match((e as Error).message, words);
    }
    assert.equal(s.controller.list().length, before);
    assert.equal(dbRows(s).length, 0);
    // A folder name that is taken gets a number.
    let n = 0;
    s.ws.wtAdd = ([folder, leaf, branch]) => (++n < 3 ? { code: 6, out: '' } : { code: 0, out: `ok\t${folder}.worktrees/${leaf}\t${branch}\tc0ffee\t${folder}\t\n` });
    const made = await make(s, { worktree: { branch: 'feat/x' } });
    assert.deepEqual(calls(s, 'wt-add').slice(-3).map((c) => c.args[1]), ['feat-x', 'feat-x-2', 'feat-x-3']);
    assert.equal(made.worktree!.path, `${REPO}.worktrees/feat-x-3`);
  } finally {
    await s.done();
  }
});

test('trust: the repository comes first; the new folder is trusted when its settings are the very ones the person trusted, asked about otherwise, and the retry reuses the worktree', async () => {
  const s = await liveSession();
  try {
    // An untrusted repository: nothing is made.
    s.ws.scanFor = () => scanOf('a'.repeat(64));
    const first = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: REPO, worktree: {} }));
    assert.equal(first && isAppError(first) ? first.code : '', CHAT_FOLDER_UNTRUSTED);
    assert.equal(s.ws.wtCalls.length, 0, 'an untrusted repository gets no worktree');

    // Trusted at hash A, and the worktree carries the same files: trusted too, by the portal, on the record.
    s.store.db!.prepare(`INSERT INTO chat_folder_trust (workspace_id, folder, scan_hash, scan, trusted_at, actor) VALUES (?, ?, ?, '{}', ?, 'ui')`).run('docker/ws1', REPO, 'a'.repeat(64), new Date().toISOString());
    const same = await make(s);
    const trust = s.store.db!.prepare('SELECT folder, scan_hash, actor FROM chat_folder_trust WHERE folder = ?').get(same.cwd) as { folder: string; scan_hash: string; actor: string };
    assert.deepEqual([trust.scan_hash, trust.actor], ['a'.repeat(64), 'portal:worktree']);

    // The branch it starts from has other settings: the person is asked about the NEW folder, with the retry's plan.
    s.ws.wtCalls.length = 0;
    s.ws.scanFor = (folder) => scanOf(folder === REPO ? 'a'.repeat(64) : 'b'.repeat(64));
    const asked = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: REPO, worktree: { base: 'release' } }));
    assert.equal(asked && isAppError(asked) ? asked.code : '', CHAT_FOLDER_UNTRUSTED);
    const scan = (asked as unknown as { details: ChatFolderScan }).details;
    assert.match(scan.folder, /^\/home\/node\/proj\.worktrees\/session-chat-[0-9a-f]{6}$/);
    assert.deepEqual([scan.worktree?.repo, scan.worktree?.base, scan.worktree?.branch], [REPO, 'release', calls(s, 'wt-add')[0]!.args[2]]);
    assert.deepEqual(dbRows(s).filter((r) => r.state === 'reserved').map((r) => r.branch), [scan.worktree!.branch], 'reserved for the retry');

    // The person trusts it; the retry with the plan makes no second worktree and the chat starts in the first.
    s.store.db!.prepare(`INSERT INTO chat_folder_trust (workspace_id, folder, scan_hash, scan, trusted_at, actor) VALUES (?, ?, ?, '{}', ?, 'ui')`).run('docker/ws1', scan.folder, scan.hash, new Date().toISOString());
    const added = calls(s, 'wt-add').length;
    const retried = await make(s, { worktree: scan.worktree });
    assert.equal(calls(s, 'wt-add').length, added, 'the same worktree');
    assert.equal(retried.cwd, scan.folder);
    assert.ok(calls(s, 'wt-status').length > 0, 'it was checked to still be there');
    assert.deepEqual(dbRows(s).filter((r) => r.path === scan.folder).map((r) => [r.state, r.session_id]), [['active', retried.id]]);
  } finally {
    await s.done();
  }
});

test('a reservation nobody came back for is swept at the next worktree start: removed when nothing is in it, kept when something is', async () => {
  const s = await liveSession();
  try {
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    const insert = s.store.db!.prepare(`INSERT INTO chat_worktrees (workspace_id, path, repo, branch, base, session_id, state, created_at) VALUES ('docker/ws1', ?, ?, ?, NULL, NULL, 'reserved', ?)`);
    insert.run(`${REPO}.worktrees/clean`, REPO, 'clean', old);
    insert.run(`${REPO}.worktrees/busy`, REPO, 'busy', old);
    insert.run(`${REPO}.worktrees/gone`, REPO, 'gone', old);
    s.ws.wtStatus = ([path]) => (path!.endsWith('/busy') ? { code: 0, out: 'dirty=2\nuntracked=0\nunique=0\nbranch=busy\nhead=x\n' } : path!.endsWith('/gone') ? { code: 2, out: '' } : { code: 0, out: 'dirty=0\nuntracked=0\nunique=0\nbranch=clean\nhead=x\n' });
    await make(s);
    assert.deepEqual(calls(s, 'wt-remove').map((c) => c.args), [[`${REPO}.worktrees/clean`, 'safe']]);
    const state = Object.fromEntries(dbRows(s).map((r) => [String(r.path).split('/').pop(), r.state]));
    assert.equal(state.clean, 'removed');
    assert.equal(state.busy, 'kept');
    assert.equal(state.gone, 'removed');
  } finally {
    await s.done();
  }
});

test('deleting a chat keeps its worktree unless asked; removing refuses over changes before anything ends, and force is only for a person who was told', async () => {
  const s = await liveSession();
  try {
    const a = await make(s);
    const b = await make(s);
    const c = await make(s);
    const d = await make(s);
    // Keep (the default): the folder stays and is listed as kept.
    s.ws.wtCalls.length = 0;
    assert.deepEqual(await s.controller.delete(a.id), { purged: true, worktree: 'kept' });
    assert.equal(calls(s, 'wt-remove').length, 0);
    assert.equal(dbRows(s).find((r) => r.path === a.worktree!.path)!.state, 'kept');
    assert.deepEqual((await s.controller.worktrees('docker/ws1')).filter((w) => w.state === 'kept').map((w) => w.path), [a.worktree!.path]);

    // Remove, nothing to lose: removed, the answer says so, the audit has it.
    assert.deepEqual(await s.controller.delete(b.id, { worktree: 'remove' }), { purged: true, worktree: 'removed' });
    assert.deepEqual(calls(s, 'wt-remove').map((x) => x.args), [[b.worktree!.path, 'safe']]);
    assert.equal(dbRows(s).find((r) => r.path === b.worktree!.path)!.state, 'removed');
    assert.deepEqual(s.controller.audit({ kind: 'worktree.removed' }).map((x) => [x.sessionId, x.detail.forced]), [[b.id, false]]);

    // Changes: refused with what is there, BEFORE the chat is ended or anything removed.
    s.ws.wtStatus = () => ({ code: 0, out: 'dirty=3\nuntracked=1\nunique=2\nbranch=feature\nhead=x\n' });
    const dirty = await err(s.controller.delete(c.id, { worktree: 'remove' }));
    assert.equal(dirty && isAppError(dirty) ? dirty.code : '', WORKTREE_DIRTY);
    assert.deepEqual((dirty as unknown as { details: unknown }).details, { exists: true, branch: 'feature', dirty: 3, untracked: 1, unique: 2, needsForce: true });
    assert.notEqual(s.controller.get(c.id)!.state, 'ended', 'the chat was not touched');
    assert.equal(calls(s, 'wt-remove').length, 1);
    // The person said so: forced, and on the record as forced.
    assert.deepEqual(await s.controller.delete(c.id, { worktree: 'force' }), { purged: true, worktree: 'removed' });
    assert.deepEqual(calls(s, 'wt-remove').at(-1)!.args, [c.worktree!.path, 'force']);
    assert.deepEqual(s.controller.audit({ kind: 'worktree.removed' }).map((x) => x.detail.forced), [true, false]);

    // Archive: the folder stays by default; removal on request, with the same refusal.
    s.ws.wtCalls.length = 0;
    await s.controller.archive(d.id);
    assert.equal(calls(s, 'wt-remove').length, 0);
    assert.ok(s.controller.get(d.id)!.archivedAt);
    s.ws.wtStatus = () => ({ code: 0, out: 'dirty=0\nuntracked=0\nunique=0\nbranch=feature\nhead=x\n' });
    const e = await make(s);
    await s.controller.archive(e.id, { worktree: 'remove' });
    assert.deepEqual(calls(s, 'wt-remove').map((x) => x.args), [[e.worktree!.path, 'safe']]);
  } finally {
    await s.done();
  }
});

test('status: what removal would lose, "gone" once the folder is, nothing for a chat in a plain folder; the list merges what git knows', async () => {
  const s = await liveSession();
  try {
    const plain = await s.controller.create({ workspaceId: 'docker/ws1', cwd: REPO });
    assert.equal(await s.controller.worktreeStatus(plain.id), null);
    const wt = await make(s);
    s.ws.wtStatus = () => ({ code: 0, out: 'dirty=1\nuntracked=2\nunique=0\nbranch=feature\nhead=x\n' });
    assert.deepEqual(await s.controller.worktreeStatus(wt.id), { exists: true, branch: 'feature', dirty: 1, untracked: 2, unique: 0, needsForce: true });
    s.ws.wtStatus = () => ({ code: 2, out: '' });
    assert.deepEqual(await s.controller.worktreeStatus(wt.id), { exists: false, branch: wt.worktree!.branch, dirty: 0, untracked: 0, unique: 0, needsForce: false });

    s.ws.wtList = () => ({
      code: 0,
      out: JSON.stringify([
        { path: REPO, branch: 'main', head: 'x', detached: false, locked: false, prunable: false },
        { path: wt.worktree!.path, branch: wt.worktree!.branch, head: 'x', detached: false, locked: false, prunable: false },
        { path: `${REPO}.worktrees/by-hand`, branch: 'hand', head: 'x', detached: false, locked: true, prunable: false },
        { path: 'relative', branch: 'bad', head: 'x', detached: false, locked: false, prunable: false },
      ]),
    });
    const list = await s.controller.worktrees('docker/ws1', REPO);
    assert.deepEqual(list.map((w) => [w.path, w.state, w.sessionId === wt.id, w.locked]), [
      [wt.worktree!.path, 'active', true, false],
      [`${REPO}.worktrees/by-hand`, 'other', false, true],
    ]);
  } finally {
    await s.done();
  }
});
