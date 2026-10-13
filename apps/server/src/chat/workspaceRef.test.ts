// T-42 slice 3 (docs/prd/targets-connect.md §24.4): a chat session stores its workspace as the stable id and reads it back as the key, which
// is what the controller keys live processes and runtime calls by; rows written before (the key) read and match as they are; the background
// rewrite moves them; a removed workspace's sessions are not a new workspace's that took the name.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { SpendStore } from '../usagespend/store.js';
import { WorkspaceIdentities } from '../workspaces/identity.js';
import { rewriteWorkspaceRefs } from '../workspaces/refRewrite.js';
import { ChatStore } from './store.js';

async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-chatref-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const ids = new WorkspaceIdentities(store);
  const chat = new ChatStore(store, undefined, ids);
  let n = 0;
  const make = (workspaceId: string) => chat.create({ id: `c${++n}`, workspaceId, cwd: '/home/node', title: 't', origin: 'ui' }).id;
  const stored = (id: string) => (store.db!.prepare('SELECT workspace_id FROM chat_sessions WHERE id = ?').get(id) as { workspace_id: string }).workspace_id;
  /** A session as written before slice 3: the key in the column. */
  const legacy = (workspaceId: string) => {
    const id = make(workspaceId);
    store.db!.prepare('UPDATE chat_sessions SET workspace_id = ? WHERE id = ?').run(workspaceId, id);
    return id;
  };
  const done = () => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, ids, chat, make, stored, legacy, done };
}

test('chat sessions: written with the stable id, read as the key everywhere the controller reads, matched in either form', async () => {
  const w = await world();
  try {
    const api = w.ids.allocate('docker', 'api');
    const fresh = w.make('docker/api');
    assert.equal(w.stored(fresh), api.id, 'the row holds the id');
    assert.equal(w.chat.get(fresh)!.workspaceId, 'docker/api', 'the session reads as the key');
    assert.equal(w.chat.row(fresh)!.workspace_id, 'docker/api', 'and so does the raw row the controller keys processes by');
    const old = w.legacy('docker/api');
    const other = w.make('docker/web');
    assert.equal(w.stored(other), 'docker/web', 'a workspace the registry does not know is stored as given');
    assert.deepEqual(w.chat.list({ workspaceId: 'docker/api' }).map((s) => s.id).sort(), [fresh, old].sort());
    assert.deepEqual(w.chat.workspaceRows('docker/api').map((r) => [r.id, r.workspace_id]), [[fresh, 'docker/api'], [old, 'docker/api']]);
    assert.ok(w.chat.liveRows().every((r) => r.workspace_id === 'docker/api' || r.workspace_id === 'docker/web'));
    assert.equal(w.chat.openSessionsOnClaude('docker/api', '', true), 2);
    // After a rename the sessions are still its own, by the key and by the label.
    w.ids.relabel(api.id, 'isnan-pod');
    assert.deepEqual(w.chat.list({ workspaceId: 'docker/isnan-pod' }).map((s) => s.id).sort(), [fresh, old].sort());
    assert.equal(w.chat.get(old)!.workspaceId, 'docker/api', 'the key never changes with a rename');
    // Usage reads the session's workspace as the key too.
    const spend = new SpendStore(w.store);
    spend.workspaceKeyOf = (s) => w.ids.keyOf(s) ?? s;
    assert.equal(spend.liveSession(fresh)?.workspaceId, 'docker/api');
    assert.equal(spend.sessions([fresh]).get(fresh)?.workspaceId, 'docker/api');
  } finally {
    w.done();
  }
});

test('chat sessions: the rewrite moves old rows of live workspaces; a removed workspace keeps its sessions from the next of that name', async () => {
  const w = await world();
  try {
    const api = w.ids.allocate('docker', 'api');
    const a = w.legacy('docker/api');
    const gone = w.legacy('docker/gone');
    const results = await rewriteWorkspaceRefs(w.store, w.ids, { pauseMs: 0 });
    const r = results.find((x) => x.table === 'chat_sessions')!;
    assert.deepEqual([r.rewritten, r.kept, r.done], [1, 1, true]);
    assert.equal(w.stored(a), api.id);
    assert.equal(w.stored(gone), 'docker/gone');
    // A session not yet rewritten when its workspace is removed is pinned to the removed id.
    const b = w.legacy('docker/api');
    w.ids.retire('docker', 'api');
    assert.equal(w.stored(b), api.id);
    w.ids.allocate('docker', 'api');
    const c = w.make('docker/api');
    assert.deepEqual(w.chat.list({ workspaceId: 'docker/api' }).map((s) => s.id), [c], 'the new workspace starts with its own sessions only');
    assert.deepEqual(w.chat.workspaceRows('docker/api').map((x) => x.id), [c]);
    assert.equal(w.chat.get(a)!.workspaceId, 'docker/api', 'an old session still says which workspace it was');
  } finally {
    w.done();
  }
});
