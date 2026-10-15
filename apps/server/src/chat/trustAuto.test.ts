// Folder trust without a person (T-366, D-55): under `chat.trust.autoPermissionOnly` a folder never trusted before is trusted by
// itself when its settings hold permission rules only and no allow rule is broad; a hook, a server, env, a broad rule or the
// policy off still waits for a person, and the 409 says why by name. A rules edit that adds a runner stops the re-trust (T-38) too,
// and a portal worktree still copies its repository's trust at the same hash first.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { CHAT_FOLDER_UNTRUSTED, type ChatFolderScan } from '@portal/contracts';
import { ChatStore } from './store.js';
import { EMPTY_SCAN, liveSession, until, type Live } from './testkit.js';
import { FOLDER_CHANGED, FOLDER_NOT_TRUSTED } from './trust.js';

const LEAD = '/home/node/lead';
const REPO = '/home/node/proj';
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const BROAD = 'an allow rule runs any command or covers everything';

/** What `trustscan` prints for a folder whose one settings file holds permission rules only (no broad rule unless `extra` says so). */
const rules = (hash: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...EMPTY_SCAN, hash, files: ['.claude/settings.json'], allowRules: 2, rulesOnly: true, broadAllow: false, ...extra });

const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (isAppError(e) ? e : new Error(String(e))));
const trustRow = (s: Live, folder: string) => {
  const row = s.store.db!.prepare('SELECT scan_hash, actor FROM chat_folder_trust WHERE workspace_id = ? AND folder = ?').get('docker/ws1', folder) as { scan_hash: string; actor: string } | undefined;
  return row ? { scan_hash: row.scan_hash, actor: row.actor } : undefined; // a plain object (node:sqlite rows have no prototype)
};

async function start(s: Live, req: Record<string, unknown>) {
  const before = s.ws.tails.length;
  const session = await s.controller.create({ workspaceId: 'docker/ws1', ...req });
  await until(() => s.ws.tails.length === before + 1);
  return session;
}

/** The scan `trustscan` gives the lead's folder; every other folder has no settings. */
const only = (s: Live, folder: string, out: () => string) => (s.ws.scanFor = (f) => (f === folder ? out() : JSON.stringify(EMPTY_SCAN)));

test('first trust: a folder never trusted, rules only, is refused with the policy off and trusted by itself with it on, audited first', async () => {
  const s = await liveSession();
  try {
    only(s, LEAD, () => rules(H1));
    // The policy off: the person is asked, as before, and the message is the usual one.
    const off = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: LEAD }));
    assert.deepEqual([off && isAppError(off) ? off.code : String(off), off?.message], [CHAT_FOLDER_UNTRUSTED, FOLDER_NOT_TRUSTED]);
    assert.equal(trustRow(s, LEAD), undefined);

    // On: it starts, the trust is the portal's, and one audit row says it was the first.
    s.controller.autoTrustRules = () => true;
    const session = await start(s, { cwd: LEAD });
    assert.equal(session.cwd, LEAD);
    assert.deepEqual(trustRow(s, LEAD), { scan_hash: H1, actor: 'portal:rules-only' });
    const rows = s.controller.audit({ kind: 'trust.auto' });
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.severity, rows[0]!.actor, rows[0]!.workspaceId], ['medium', 'portal', 'docker/ws1']);
    assert.deepEqual(rows[0]!.detail, { reason: 'first', folder: LEAD, hash: H1, files: ['.claude/settings.json'], allowRules: 2 });
    // T-323: trusted now, so the launch passes the project's rules.
    assert.ok(s.ws.startArgs.at(-1)!.join(' ').includes(`${LEAD}/.claude/settings.json`), 'the project rules apply');
  } finally {
    await s.done();
  }
});

test('first trust: refused with the reason by name for a broad allow rule, a hook, an MCP server, env, or a host that does not say', async () => {
  const s = await liveSession();
  try {
    s.controller.autoTrustRules = () => true;
    for (const [extra, why] of [
      [{ broadAllow: true }, BROAD], // a runner (Bash(flock …:*)) or a blanket (Bash, Edit(/**)): the host's one flag, host.test.ts tells them apart
      [{ broadAllow: undefined }, BROAD], // a host older than T-366: broad until it says otherwise
      [{ hooks: ['SessionStart'], rulesOnly: false }, 'it loads hooks'],
      [{ files: ['.mcp.json', '.claude/settings.json'], mcpServers: ['db'], rulesOnly: false }, 'it starts MCP servers'],
      [{ envNames: ['NODE_OPTIONS'], rulesOnly: false }, 'it sets environment variables'],
      [{ rulesOnly: false }, 'it holds more than permission rules'],
    ] as const) {
      only(s, LEAD, () => rules(H1, extra));
      const e = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: LEAD }));
      assert.equal(e && isAppError(e) ? e.code : String(e), CHAT_FOLDER_UNTRUSTED, JSON.stringify(extra));
      assert.equal(e!.message, `${FOLDER_NOT_TRUSTED} Not trusted by itself: ${why}.`, JSON.stringify(extra));
      assert.equal(((e as unknown as { details: ChatFolderScan & { autoRefusal?: string } }).details).autoRefusal, why);
      assert.equal(trustRow(s, LEAD), undefined, JSON.stringify(extra));
    }
    assert.equal(s.controller.audit({ kind: 'trust.auto' }).length, 0);
  } finally {
    await s.done();
  }
});

test('re-trust (T-38): a rules edit that adds a runner waits for a person, with the reason; without it the folder is trusted again, audited changed', async () => {
  const s = await liveSession();
  try {
    s.controller.autoTrustRules = () => true;
    new ChatStore(s.store).saveFolderTrust('docker/ws1', LEAD, H1, {}, 'ui');
    only(s, LEAD, () => rules(H2, { broadAllow: true, allowRules: 3 }));
    const e = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: LEAD }));
    assert.equal(e && isAppError(e) ? e.code : String(e), CHAT_FOLDER_UNTRUSTED);
    assert.equal(e!.message, `${FOLDER_CHANGED} Not trusted by itself: ${BROAD}.`);
    assert.deepEqual(trustRow(s, LEAD), { scan_hash: H1, actor: 'ui' }, 'the old trust stands');
    assert.equal(s.controller.audit({ kind: 'trust.auto' }).length, 0);

    only(s, LEAD, () => rules(H2));
    await start(s, { cwd: LEAD });
    assert.deepEqual(trustRow(s, LEAD), { scan_hash: H2, actor: 'portal:rules-only' });
    const rows = s.controller.audit({ kind: 'trust.auto' });
    assert.deepEqual(rows.map((r) => r.detail), [{ reason: 'changed', folder: LEAD, hash: H2, before: H1, files: ['.claude/settings.json'], allowRules: 2 }]);
  } finally {
    await s.done();
  }
});

test('worktree: the repository’s trust at the same hash is still copied (portal:worktree, no audit), even with the policy on and a broad rule', async () => {
  const s = await liveSession();
  try {
    s.controller.autoTrustRules = () => true;
    new ChatStore(s.store).saveFolderTrust('docker/ws1', REPO, H1, {}, 'ui');
    s.ws.scanFor = () => rules(H1, { broadAllow: true }); // a person trusted exactly these files in the repository
    const same = await start(s, { cwd: REPO, worktree: {} });
    assert.notEqual(same.cwd, REPO);
    assert.deepEqual(trustRow(s, same.cwd), { scan_hash: H1, actor: 'portal:worktree' });
    assert.equal(s.controller.audit({ kind: 'trust.auto' }).length, 0);
  } finally {
    await s.done();
  }
});

test('worktree: other rules-only settings in a new worktree are trusted by the policy (first); a broad rule there is refused with the reason and the plan', async () => {
  const s = await liveSession();
  try {
    s.controller.autoTrustRules = () => true;
    new ChatStore(s.store).saveFolderTrust('docker/ws1', REPO, H1, {}, 'ui');
    s.ws.scanFor = (f) => (f === REPO ? rules(H1) : rules(H2));
    const made = await start(s, { cwd: REPO, worktree: {} });
    assert.deepEqual(trustRow(s, made.cwd), { scan_hash: H2, actor: 'portal:rules-only' });
    assert.deepEqual(s.controller.audit({ kind: 'trust.auto' }).map((r) => [r.detail.reason, r.detail.folder]), [['first', made.cwd]]);

    s.ws.scanFor = (f) => (f === REPO ? rules(H1) : rules(H2, { broadAllow: true }));
    const e = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: REPO, worktree: {} }));
    assert.equal(e && isAppError(e) ? e.code : String(e), CHAT_FOLDER_UNTRUSTED);
    assert.equal(e!.message, `${FOLDER_NOT_TRUSTED} Not trusted by itself: ${BROAD}.`);
    const scan = (e as unknown as { details: ChatFolderScan }).details;
    assert.equal(scan.worktree?.repo, REPO, 'the retry’s plan rides along');
    assert.equal(trustRow(s, scan.folder), undefined);
  } finally {
    await s.done();
  }
});
