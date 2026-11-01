// Organizations slice 0, review M2: a chat session records the email account that started it (its agents act as that account and stop
// with it). The person's route passes its account; a worker takes its parent's; a Portal MCP token's start takes the account that minted
// the token; the server code, a ticket and a trigger record none (the founding user).
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import type { Workspaces } from '../workspaces/manager.js';
import { ChatController } from './controller.js';
import { ChatStore } from './store.js';
import { FakeWorkspaces, QUICK_GONE, freshStore, until } from './testkit.js';

test('the account that started a session is recorded: the person’s, a worker’s parent’s, a token’s minter’s, none for the server code', async () => {
  const { store, dataDir } = await freshStore();
  const ws = new FakeWorkspaces();
  const controller = new ChatController(store, ws as unknown as Workspaces, { ...QUICK_GONE });
  const chat = new ChatStore(store);
  try {
    store.db!.prepare("INSERT INTO token_accounts (kind, token_id, account_id) VALUES ('pmcp', 'ptk_minted', 'u_Minter_00001')").run();
    const mine = await controller.create({ workspaceId: 'docker/ws1' }, { account: 'u_Second-admin' });
    const code = await controller.create({ workspaceId: 'docker/ws1' }, { account: null });
    const legacy = await controller.create({ workspaceId: 'docker/ws1' });
    const viaToken = await controller.create({ workspaceId: 'docker/ws1' }, { actor: 'portal-mcp:ptk_minted' });
    const viaTicket = await controller.create({ workspaceId: 'docker/ws1' }, { actor: 'ticket:T-1' });
    assert.deepEqual(
      [mine, code, legacy, viaToken, viaTicket].map((s) => chat.startedByAccount(s.id)),
      ['u_Second-admin', null, null, 'u_Minter_00001', null],
    );
    await until(() => controller.get(mine.id)?.state === 'idle');
    const worker = await controller.create({ workspaceId: 'docker/ws1' }, { actor: `session:${mine.id}`, parentId: mine.id });
    assert.equal(chat.startedByAccount(worker.id), 'u_Second-admin', 'a worker is its parent’s person');
  } finally {
    controller.stop();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
