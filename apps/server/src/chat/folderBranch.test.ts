// T-476: a worker started in a plain folder that is a git work tree records that folder's branch once, at its start, so CI counts it as the
// worker's own branch. Only a worker, only the folder itself (git's own list, exact path), never a detached HEAD or a name the portal refuses.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveSession, until, type Live } from './testkit.js';

const CREW = '/home/node/crew-api';
const list = (trees: { path: string; branch: string | null; detached?: boolean }[]) => () => ({
  code: 0,
  out: JSON.stringify(trees.map((t) => ({ path: t.path, head: 'c0ffee', branch: t.branch, detached: t.detached ?? false, locked: false, prunable: false }))),
});

async function worker(s: Live, cwd: string) {
  const before = s.ws.tails.length;
  const made = await s.controller.create({ workspaceId: 'docker/ws1', cwd, title: 'event-api' }, { actor: `session:${s.id}`, parentId: s.id });
  await until(() => s.ws.tails.length === before + 1);
  return made;
}

test('a worker in a crew folder on dev/T-271 records dev/T-271 at its start; the record does not follow a later checkout', async () => {
  const s = await liveSession();
  try {
    s.ws.wtList = list([{ path: '/home/node/event', branch: 'main' }, { path: CREW, branch: 'dev/T-271' }]);
    const w = await worker(s, CREW);
    assert.deepEqual(s.ws.wtCalls.filter((c) => c.cmd === 'wt-list').map((c) => c.args), [[CREW]]);
    assert.equal(w.folderBranch, 'dev/T-271');
    assert.equal(s.controller.get(w.id)!.folderBranch, 'dev/T-271', 'kept on the row');
    s.ws.wtList = list([{ path: CREW, branch: 'main' }]);
    assert.equal(s.controller.get(w.id)!.folderBranch, 'dev/T-271', 'recorded once, at the start');
  } finally {
    await s.done();
  }
});

test('no folder branch: a session with no parent, a subfolder, a detached HEAD, a name the portal refuses, a host that can not tell', async () => {
  const s = await liveSession();
  try {
    s.ws.wtList = list([{ path: CREW, branch: 'dev/x' }]);
    const lead = await s.controller.create({ workspaceId: 'docker/ws1', cwd: CREW, title: 'not a worker' });
    assert.equal(lead.folderBranch, undefined, 'only a worker records it');
    assert.equal(s.ws.wtCalls.filter((c) => c.cmd === 'wt-list').length, 0, 'and the host is not asked for one that is not a worker');
    assert.equal((await worker(s, `${CREW}/apps`)).folderBranch, undefined, 'a subfolder of the work tree');
    s.ws.wtList = list([{ path: CREW, branch: null, detached: true }]);
    assert.equal((await worker(s, CREW)).folderBranch, undefined, 'detached');
    s.ws.wtList = list([{ path: CREW, branch: 'dev/../main' }]);
    assert.equal((await worker(s, CREW)).folderBranch, undefined, 'a name the portal would not take');
    s.ws.wtList = () => ({ code: 1, out: '' });
    assert.equal((await worker(s, CREW)).folderBranch, undefined, 'the host could not tell');
  } finally {
    await s.done();
  }
});
