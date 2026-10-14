// T-323: Claude Code applies a project's ALLOW rules only in a folder it trusts itself, which the portal's folder trust never set, so a
// dontAsk session was refused what the repository allows. A folder the portal trusts at its current hash, whose project settings hold
// permission rules only, launches with `--settings <folder>/.claude/settings.json`; a folder with anything else, with no settings, or not
// trusted gets nothing (and an untrusted one does not start at all). Deny rules hold either way (a probe in the T-323 ticket).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatStore } from './store.js';
import { EMPTY_SCAN, liveSession, until } from './testkit.js';

const HASH = 'a'.repeat(64);
const scanOf = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ hash: HASH, files: ['.claude/settings.json'], invalid: [], mcpServers: [], hooks: [], plugins: [], allowRules: 57, envNames: [], rulesOnly: true, ...over });
const settingsOf = (args: string[]) => {
  const i = args.indexOf('--settings');
  return i === -1 ? null : args[i + 1]!;
};

test('T-323: a trusted, rules-only folder launches with its project settings as --settings; with hooks, without settings, the flag stays off', async () => {
  const s = await liveSession();
  try {
    const trust = (folder: string) => new ChatStore(s.store).saveFolderTrust('docker/ws1', folder, HASH, { files: ['.claude/settings.json'], invalid: [], mcpServers: [], hooks: [], plugins: [], allowRules: 57, envNames: [] }, 'ui');
    const start = async (folder: string) => {
      const before = s.ws.startArgs.length;
      const made = await s.controller.create({ workspaceId: 'docker/ws1', cwd: folder, title: folder });
      await until(() => s.ws.startArgs.length === before + 1);
      return { id: made.id, args: s.ws.startArgs.at(-1)! };
    };

    // Trusted at this hash, permission rules only: the rules a person trusted apply.
    s.ws.scanFor = (folder) => (folder.endsWith('/repo') ? scanOf() : folder.endsWith('/hooks') ? scanOf({ hooks: ['PreToolUse'], rulesOnly: false }) : JSON.stringify({ ...EMPTY_SCAN, rulesOnly: true }));
    trust('/home/node/work/repo');
    const repo = await start('/home/node/work/repo');
    assert.equal(settingsOf(repo.args), '/home/node/work/repo/.claude/settings.json');
    assert.ok(repo.args.indexOf('--settings') > repo.args.indexOf('--'), 'a flag of claude, after the host’s own arguments');

    // Trusted, but its settings would load a hook: no --settings (the portal passes permission rules only).
    trust('/home/node/work/hooks');
    const hooks = await start('/home/node/work/hooks');
    assert.equal(settingsOf(hooks.args), null);

    // No project settings at all: nothing to pass.
    const plain = await start('/home/node/work/plain');
    assert.equal(settingsOf(plain.args), null);

    // A relaunch scans again: the same folder still gets it; once its settings change (another hash), it is not trusted and does not start.
    await s.controller.end(repo.id);
    s.ws.scanFor = (folder) => (folder.endsWith('/repo') ? scanOf({ hash: 'b'.repeat(64) }) : scanOf());
    await assert.rejects(s.controller.create({ workspaceId: 'docker/ws1', cwd: '/home/node/work/repo' }), /FOLDER_UNTRUSTED|trust/i);
  } finally {
    await s.done();
  }
});
