import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SecretsContent as View } from '@portal/contracts';
import { Reconciler } from '../delivery/reconciler.js';
import { memoryWorkspace, secretsHarness } from './testkit.js';

const WS = 'docker/ws1';
const HOOK = '/etc/profile.d/claudepilot.sh';
const BASHRC = '/etc/bash.bashrc';
const LINE = 'if [ -r /etc/claudepilot/secrets/env.sh ]; then . /etc/claudepilot/secrets/env.sh; fi # claudepilot';
const DROP_IN = '/etc/claude-code/managed-settings.d/20-claudepilot-env.json';

async function setup() {
  const h = await secretsHarness();
  const ws = memoryWorkspace();
  ws.files.set(BASHRC, { content: '# System-wide .bashrc file\nPS1=x\n', mode: 0o644, uid: 0, gid: 0 });
  // The service keeps the harness's recorder, so only `run` reconciles: one at a time, when the test says.
  const reconciler = new Reconciler(h.store, () => ws.runtime, () => [ws.runtime], h.providers);
  const row = () => reconciler.row(WS)!;
  const run = async (why = 'test') => {
    ws.scripts.length = 0;
    ws.puts.length = 0;
    await reconciler.request(WS, why);
  };
  const p = h.service.create('secrets', { name: 'team', content: { entries: [{ kind: 'variable', name: 'REGION', value: 'eu' }, { kind: 'secret', name: 'TOKEN', newValue: 'tok-value' }] } });
  const setRegion = (value: string) =>
    h.service.update(p.id, { content: { entries: (h.service.get(p.id).content as View).entries.map((e) => (e.kind === 'variable' ? { ...e, value } : e)) } });
  return { h, ws, reconciler, row, run, p, setRegion, done: h.done };
}

test('A3 hooks: the profile.d hook is delivered, the bash.bashrc line appended once, never repaired, and kept after unassign', async () => {
  const t = await setup();
  try {
    t.h.service.setAssignments(WS, 'secrets', [{ poolId: t.p.id }]);
    await t.run();
    assert.equal(t.row().status, 'synced', t.row().reason ?? '');
    const hook = t.ws.files.get(HOOK)!;
    assert.deepEqual([hook.mode, hook.uid, hook.gid], [0o644, 0, 0]);
    assert.match(hook.content, /^if \[ -r \/etc\/claudepilot\/secrets\/env\.sh \]; then \. \/etc\/claudepilot\/secrets\/env\.sh; fi$/m);
    assert.equal(t.ws.files.get(BASHRC)!.content, `# System-wide .bashrc file\nPS1=x\n${LINE}\n`);
    assert.deepEqual(t.ws.manifest()!.lines, [{ path: BASHRC, line: LINE }]);
    // The line goes in after the drop-ins and before the manifest.
    const write = t.ws.scripts.find((s) => s.script.includes('grep -qxF'))!.script.split('\n');
    assert.ok(write.findIndex((l) => l.includes(DROP_IN)) < write.findIndex((l) => l.includes('grep -qxF')));
    assert.ok(write.findIndex((l) => l.includes('grep -qxF')) < write.findIndex((l) => l.includes('state.json')));

    // Nothing changed: nothing written, nothing appended.
    await t.run();
    assert.equal(t.ws.puts.length, 0);
    // Removed by hand, then a change: written again, but the line isn't appended again (never repaired).
    t.ws.files.set(BASHRC, { content: '# mine\n', mode: 0o644, uid: 0, gid: 0 });
    t.setRegion('us');
    await t.run();
    assert.equal(t.row().status, 'synced');
    assert.equal(t.ws.files.get(BASHRC)!.content, '# mine\n');
    assert.ok(!t.ws.scripts.some((s) => s.script.includes('grep -qxF')));

    // Unassigned: the hook file goes after the grace period with the rest; the line stays.
    t.h.service.setAssignments(WS, 'secrets', []);
    await t.run();
    const rows = JSON.parse(t.row().pending_deletes) as { since?: number }[];
    t.h.store.db!.prepare('UPDATE workspace_delivery SET pending_deletes = ? WHERE workspace_id = ?').run(JSON.stringify(rows.map((r) => (r.since ? { ...r, since: r.since - 60_000 } : r))), WS);
    await t.run();
    assert.ok(!t.ws.files.has(HOOK) && !t.ws.files.has('/etc/claudepilot/secrets/env.sh') && !t.ws.files.has('/etc/claudepilot/secrets/files/TOKEN'));
    assert.equal(t.ws.files.get(BASHRC)!.content, '# mine\n');
  } finally {
    t.done();
  }
});

test('A3 hooks: a stopped workspace gets the hook file now and the bash.bashrc line at its next start', async () => {
  const t = await setup();
  try {
    t.ws.state.running = false;
    t.h.service.setAssignments(WS, 'secrets', [{ poolId: t.p.id }]);
    await t.run();
    assert.equal(t.row().status, 'synced', t.row().reason ?? '');
    assert.ok(t.ws.files.has(HOOK));
    assert.ok(!t.ws.files.get(BASHRC)!.content.includes('claudepilot'), 'no exec while stopped');
    assert.equal(t.ws.manifest()!.lines, undefined);
    t.ws.state.running = true;
    await t.run('started');
    assert.ok(t.ws.files.get(BASHRC)!.content.endsWith(`${LINE}\n`));
    assert.deepEqual(t.ws.manifest()!.lines, [{ path: BASHRC, line: LINE }]);
  } finally {
    t.done();
  }
});

test('FR12: after each write the workspace user must read the delivered files; one it can’t fails the delivery until it can', async () => {
  const t = await setup();
  try {
    t.h.service.setAssignments(WS, 'secrets', [{ poolId: t.p.id }]);
    await t.run();
    const check = t.ws.scripts.find((s) => s.script.startsWith('while IFS= read -r f;'))!;
    assert.equal(check.user, 'node', 'as the workspace user');
    assert.deepEqual(check.stdin!.trim().split('\n').sort(), ['/etc/claudepilot/secrets/env.sh', '/etc/claudepilot/secrets/files/TOKEN', DROP_IN].sort());

    // The image's user can't read the drop-in (another group, say): the delivery fails, naming it.
    t.ws.state.unreadable.add(DROP_IN);
    t.setRegion('us');
    await t.run();
    assert.equal(t.row().status, 'failed');
    assert.match(t.row().reason!, /can’t read \/etc\/claude-code\/managed-settings\.d\/20-claudepilot-env\.json/);
    assert.equal(t.row().applied_hash, null, 'the next attempt writes and checks again');
    const failed = t.h.store.db!.prepare("SELECT details FROM delivery_events WHERE kind = 'failed' ORDER BY id DESC").get() as { details: string };
    assert.match(failed.details, /can’t read/);

    t.ws.state.unreadable.clear();
    await t.run('retry');
    assert.equal(t.row().status, 'synced');
    assert.ok(t.ws.puts.length > 0, 'written again');
    // No write, no check.
    await t.run();
    assert.ok(!t.ws.scripts.some((s) => s.script.startsWith('while IFS= read -r f;')));
  } finally {
    t.done();
  }
});

test('the drop-in, env.sh and secret files land with the modes and owners of §10.1, in write order', async () => {
  const t = await setup();
  try {
    t.h.service.setAssignments(WS, 'secrets', [{ poolId: t.p.id }]);
    await t.run();
    const f = (p: string) => t.ws.files.get(p)!;
    assert.deepEqual([f(DROP_IN).mode, f(DROP_IN).uid, f(DROP_IN).gid], [0o440, 0, 1000]);
    assert.deepEqual([f('/etc/claudepilot/secrets/env.sh').mode, f('/etc/claudepilot/secrets/env.sh').gid], [0o440, 1000]);
    assert.deepEqual([f('/etc/claudepilot/secrets/files/TOKEN').mode, f('/etc/claudepilot/secrets/files/TOKEN').uid, f('/etc/claudepilot/secrets/files/TOKEN').gid], [0o440, 0, 1000]);
    assert.ok(t.ws.dirs.has('/etc/claudepilot/secrets') && t.ws.dirs.has('/etc/claudepilot/secrets/files'));
    const dirEntry = t.ws.puts.flat().find((e) => e.path === '/etc/claudepilot/secrets')!;
    assert.deepEqual([dirEntry.mode, dirEntry.uid, dirEntry.gid], [0o750, 0, 1000]);
    const moves = t.ws.scripts.find((s) => s.script.includes('mv -f'))!.script.split('\n');
    assert.ok(moves.findIndex((l) => l.endsWith("'/etc/claudepilot/secrets/files/TOKEN'")) < moves.findIndex((l) => l.endsWith(`'${DROP_IN}'`)), 'files before the drop-in that names them');
    assert.deepEqual(t.h.store.db!.prepare('SELECT secret_ref, workspace_id, removed_at FROM exposures').all().map((r) => ({ ...r })), [
      { secret_ref: `secret:${(t.h.service.get(t.p.id).content as View).entries[1]!.secret && (t.h.store.db!.prepare('SELECT id FROM secret_values').get() as { id: string }).id}`, workspace_id: WS, removed_at: null },
    ]);
  } finally {
    t.done();
  }
});
