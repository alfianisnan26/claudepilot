// Folder trust without a person (T-366, D-55, D-62): under `chat.trust.autoPermissionOnly` a folder never trusted before is trusted by
// itself ONLY by repository identity: the top of a clone or worktree whose origin is that of a folder trusted in the workspace, with
// its files byte for byte that folder's (the same hash), that folder still at the hash it was trusted at. Never by what its files say:
// a stranger's repository with harmless settings waits, and the 409 says why. A rules edit to a trusted folder is trusted again only
// when the classifier finds no broad rule (T-38). A portal worktree still copies its repository's trust at the same hash first.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { CHAT_FOLDER_UNTRUSTED, type ChatFolderScan } from '@portal/contracts';
import { ChatStore } from './store.js';
import { EMPTY_SCAN, liveSession, until, type Live } from './testkit.js';
import { FOLDER_CHANGED, FOLDER_NOT_TRUSTED } from './trust.js';

// The refusals as the 409 words them (trust.ts NO_SAME_REPO, NOT_A_REPO), spelled out: the text is the contract.
const NO_SAME_REPO = 'no trusted folder of the same repository has exactly these settings, skills, commands and agents';
const NOT_A_REPO = 'it is not the top folder of a git clone or worktree with an origin remote';

const LEAD = '/home/node/lead';
const REPO = '/home/node/proj';
const WT = '/home/node/proj.worktrees/w1';
const STRANGER = '/home/node/stranger';
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const BROAD = 'an allow rule runs any command or covers everything';
/** The same repository written three ways (https with a user, ssh, the scp form): one identity. */
const ORIGIN_HTTPS = `https://${['u', 'p'].join(':')}@GitHub.com/acme/proj.git`;
const ORIGIN_SCP = 'git@github.com:acme/proj';
const ORIGIN_SSH = 'ssh://git@github.com:22/acme/proj.git/';

/** What `trustscan` prints for a folder whose one settings file holds permission rules only (no broad rule unless `extra` says so). */
const rules = (hash: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...EMPTY_SCAN, hash, files: ['.claude/settings.json'], allowRules: 2, rulesOnly: true, broadAllow: false, ...extra });

const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (isAppError(e) ? e : new Error(String(e))));
const trustRow = (s: Live, folder: string) => {
  const row = s.store.db!.prepare('SELECT scan_hash, actor FROM chat_folder_trust WHERE workspace_id = ? AND folder = ?').get('docker/ws1', folder) as { scan_hash: string; actor: string } | undefined;
  return row ? { scan_hash: row.scan_hash, actor: row.actor } : undefined; // a plain object (node:sqlite rows have no prototype)
};
const codeOf = (e: Error | null) => (e && isAppError(e) ? e.code : String(e));
const refusalOf = (e: Error | null) => (e as unknown as { details: ChatFolderScan & { autoRefusal?: string } }).details.autoRefusal;

async function start(s: Live, req: Record<string, unknown>) {
  const before = s.ws.tails.length;
  const session = await s.controller.create({ workspaceId: 'docker/ws1', ...req });
  await until(() => s.ws.tails.length === before + 1);
  return session;
}

/** `trustscan` per folder from a table; a folder not in it has no settings. */
const scans = (s: Live, table: Record<string, string>) => (s.ws.scanFor = (f) => table[f] ?? JSON.stringify(EMPTY_SCAN));
/** The scan `trustscan` gives one folder; every other folder has no settings. */
const only = (s: Live, folder: string, out: () => string) => (s.ws.scanFor = (f) => (f === folder ? out() : JSON.stringify(EMPTY_SCAN)));

test('same repo: a new worktree of a trusted repository with byte-identical files waits with the policy off, and with it on is trusted, audited same-repo with the matched folder', async () => {
  const s = await liveSession();
  try {
    new ChatStore(s.store).saveFolderTrust('docker/ws1', REPO, H1, {}, 'ui');
    // A broad rule too: a person trusted exactly these files in this repository, and identity, not content, is the test (D-62).
    scans(s, { [REPO]: rules(H1, { origin: ORIGIN_HTTPS, broadAllow: true }), [WT]: rules(H1, { origin: ORIGIN_SCP, broadAllow: true }) });

    // The policy off: nothing changes, the person is asked with the usual message.
    const off = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: WT }));
    assert.deepEqual([codeOf(off), off?.message], [CHAT_FOLDER_UNTRUSTED, FOLDER_NOT_TRUSTED]);
    assert.equal(trustRow(s, WT), undefined);
    assert.equal(s.controller.audit({ kind: 'trust.auto' }).length, 0);

    s.controller.autoTrustRules = () => true;
    const session = await start(s, { cwd: WT });
    assert.equal(session.cwd, WT);
    assert.deepEqual(trustRow(s, WT), { scan_hash: H1, actor: 'portal:same-repo' });
    assert.deepEqual(trustRow(s, REPO), { scan_hash: H1, actor: 'ui' }, 'the repository’s own trust is untouched');
    const rows = s.controller.audit({ kind: 'trust.auto' });
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.severity, rows[0]!.actor, rows[0]!.workspaceId], ['medium', 'portal', 'docker/ws1']);
    assert.deepEqual(rows[0]!.detail, { reason: 'same-repo', folder: WT, hash: H1, matched: REPO, files: ['.claude/settings.json'], allowRules: 2 });
  } finally {
    await s.done();
  }
});

test('same repo: a worktree whose settings file differs from every trusted folder’s waits, with the reason, and nothing is trusted', async () => {
  const s = await liveSession();
  try {
    s.controller.autoTrustRules = () => true;
    new ChatStore(s.store).saveFolderTrust('docker/ws1', REPO, H1, {}, 'ui');
    // Rules only and nothing broad: it would have passed the content check, and still waits.
    scans(s, { [REPO]: rules(H1, { origin: ORIGIN_SCP }), [WT]: rules(H2, { origin: ORIGIN_SCP }) });
    const e = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: WT }));
    assert.equal(codeOf(e), CHAT_FOLDER_UNTRUSTED);
    assert.equal(e!.message, `${FOLDER_NOT_TRUSTED} Not trusted by itself: ${NO_SAME_REPO}.`);
    assert.equal(refusalOf(e), NO_SAME_REPO);
    assert.equal(trustRow(s, WT), undefined);
    assert.equal(s.controller.audit({ kind: 'trust.auto' }).length, 0);
  } finally {
    await s.done();
  }
});

test('stranger: a clone of an untrusted repository with harmless settings waits, even byte-identical to a trusted folder; a folder that is no repository waits', async () => {
  const s = await liveSession();
  try {
    s.controller.autoTrustRules = () => true;
    // Nothing trusted at all: rules only, nothing broad, a real origin, and it waits.
    scans(s, { [STRANGER]: rules(H1, { origin: 'https://github.com/someone/else.git' }) });
    let e = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: STRANGER }));
    assert.equal(e!.message, `${FOLDER_NOT_TRUSTED} Not trusted by itself: ${NO_SAME_REPO}.`);

    // A trusted folder with the very same files, but another repository: still waits.
    new ChatStore(s.store).saveFolderTrust('docker/ws1', REPO, H1, {}, 'ui');
    scans(s, { [REPO]: rules(H1, { origin: ORIGIN_SCP }), [STRANGER]: rules(H1, { origin: 'https://github.com/someone/else.git' }) });
    e = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: STRANGER }));
    assert.equal(e!.message, `${FOLDER_NOT_TRUSTED} Not trusted by itself: ${NO_SAME_REPO}.`);

    // Not the top of a git work tree (the host says no origin): waits, saying so.
    scans(s, { [REPO]: rules(H1, { origin: ORIGIN_SCP }), [LEAD]: rules(H1) });
    e = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: LEAD }));
    assert.equal(e!.message, `${FOLDER_NOT_TRUSTED} Not trusted by itself: ${NOT_A_REPO}.`);

    for (const f of [STRANGER, LEAD]) assert.equal(trustRow(s, f), undefined, f);
    assert.equal(s.controller.audit({ kind: 'trust.auto' }).length, 0);
  } finally {
    await s.done();
  }
});

// trust.ts EXTRAS.unreadable and autoTrustRefusal's words, spelled out.
const UNREADABLE = 'a skill, command or agent file can’t be checked or has a frontmatter key beyond plain text';
const HOOKS = 'it loads hooks';
const MCP = 'it starts MCP servers';

test('same repo (third review, 1): a linked skill or a symlinked .claude/skills stops the scan before the hash, so the same hash proves nothing: it waits', async () => {
  const s = await liveSession();
  try {
    s.controller.autoTrustRules = () => true;
    new ChatStore(s.store).saveFolderTrust('docker/ws1', REPO, H1, {}, 'ui');
    // What trustscan prints for a worktree with .claude/skills/x/SKILL.md a link, or .claude/skills itself a link (host.test.ts
    // "a link, too many or too big files"): the hashing stopped at the link, so its hash can equal the clean repository's.
    const linked = rules(H1, { origin: ORIGIN_SCP, extras: ['unreadable'], rulesOnly: false });
    for (const why of ['a linked SKILL.md', 'a symlinked .claude/skills']) {
      scans(s, { [REPO]: rules(H1, { origin: ORIGIN_SCP }), [WT]: linked });
      const e = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: WT }));
      assert.equal(codeOf(e), CHAT_FOLDER_UNTRUSTED, why);
      assert.equal(e!.message, `${FOLDER_NOT_TRUSTED} Not trusted by itself: ${UNREADABLE}.`, why);
    }
    // A host that doesn't check skills at all (no extras): waits too.
    scans(s, { [REPO]: rules(H1, { origin: ORIGIN_SCP }), [WT]: rules(H1, { origin: ORIGIN_SCP, extras: undefined }) });
    let e = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: WT }));
    assert.equal(refusalOf(e), 'the workspace’s chat host doesn’t check skills, commands and agents');
    // The other way round: the trusted folder's own scan stopped at a link, so it can't vouch for the worktree's skills.
    scans(s, { [REPO]: linked, [WT]: rules(H1, { origin: ORIGIN_SCP }) });
    e = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: WT }));
    assert.equal(refusalOf(e), NO_SAME_REPO);
    assert.equal(trustRow(s, WT), undefined);
    assert.equal(s.controller.audit({ kind: 'trust.auto' }).length, 0);
  } finally {
    await s.done();
  }
});

test('same repo (third review, 2): a hook script or an MCP server’s code is outside the hash: the same settings with a hook or an MCP server wait', async () => {
  const s = await liveSession();
  try {
    s.controller.autoTrustRules = () => true;
    new ChatStore(s.store).saveFolderTrust('docker/ws1', REPO, H1, {}, 'ui');
    const hook = (o: string) => rules(H1, { origin: o, hooks: ['SessionStart'], rulesOnly: false });
    scans(s, { [REPO]: hook(ORIGIN_SCP), [WT]: hook(ORIGIN_SCP) });
    let e = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: WT }));
    assert.equal(codeOf(e), CHAT_FOLDER_UNTRUSTED);
    assert.equal(e!.message, `${FOLDER_NOT_TRUSTED} Not trusted by itself: ${HOOKS}.`);

    const mcp = (o: string) => rules(H1, { origin: o, files: ['.mcp.json', '.claude/settings.json'], mcpServers: ['tools'], rulesOnly: false });
    scans(s, { [REPO]: mcp(ORIGIN_SCP), [WT]: mcp(ORIGIN_SCP) });
    e = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: WT }));
    assert.equal(e!.message, `${FOLDER_NOT_TRUSTED} Not trusted by itself: ${MCP}.`);
    assert.equal(trustRow(s, WT), undefined);
    assert.equal(s.controller.audit({ kind: 'trust.auto' }).length, 0);
  } finally {
    await s.done();
  }
});

test('same repo: a trusted folder that is no longer at the hash it was trusted at, or is gone, matches nothing', async () => {
  const s = await liveSession();
  try {
    s.controller.autoTrustRules = () => true;
    new ChatStore(s.store).saveFolderTrust('docker/ws1', REPO, H1, {}, 'ui');
    // The repository's files changed since (H2) and nobody trusted them: a worktree at the old H1 isn't matched by it.
    scans(s, { [REPO]: rules(H2, { origin: ORIGIN_SSH }), [WT]: rules(H1, { origin: ORIGIN_SSH }) });
    let e = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: WT }));
    assert.equal(e!.message, `${FOLDER_NOT_TRUSTED} Not trusted by itself: ${NO_SAME_REPO}.`);
    // Gone: its scan fails, so it is skipped.
    s.ws.scanFor = (f) => (f === WT ? rules(H1, { origin: ORIGIN_SSH }) : f === REPO ? '' : JSON.stringify(EMPTY_SCAN));
    e = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: WT }));
    assert.equal(e!.message, `${FOLDER_NOT_TRUSTED} Not trusted by itself: ${NO_SAME_REPO}.`);
    assert.equal(trustRow(s, WT), undefined);
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
    assert.equal(codeOf(e), CHAT_FOLDER_UNTRUSTED);
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

test('worktree: other rules-only settings in a new portal worktree are no longer trusted by content; it waits with the reason and the plan', async () => {
  const s = await liveSession();
  try {
    s.controller.autoTrustRules = () => true;
    new ChatStore(s.store).saveFolderTrust('docker/ws1', REPO, H1, {}, 'ui');
    s.ws.scanFor = (f) => (f === REPO ? rules(H1, { origin: ORIGIN_SCP }) : rules(H2, { origin: ORIGIN_SCP }));
    const e = await err(s.controller.create({ workspaceId: 'docker/ws1', cwd: REPO, worktree: {} }));
    assert.equal(codeOf(e), CHAT_FOLDER_UNTRUSTED);
    assert.equal(e!.message, `${FOLDER_NOT_TRUSTED} Not trusted by itself: ${NO_SAME_REPO}.`);
    const scan = (e as unknown as { details: ChatFolderScan }).details;
    assert.equal(scan.worktree?.repo, REPO, 'the retry’s plan rides along');
    assert.equal(trustRow(s, scan.folder), undefined);
    assert.equal(s.controller.audit({ kind: 'trust.auto' }).length, 0);
  } finally {
    await s.done();
  }
});
