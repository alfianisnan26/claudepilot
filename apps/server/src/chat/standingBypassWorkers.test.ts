// PILOT-1198 (T-3937) and PILOT-1178 (T-3762): the standing Bypass policy (PILOT-1129) for workers and for a wake. In a listed workspace a
// worker of a parent in Bypass starts in Bypass, over session_spawn and over session_start with a parent, with no mode, dontAsk or default
// asked (a lead persona's role defaults ask dontAsk); plan asked is kept. Negatives: an unlisted workspace and a parent not in Bypass hand
// nothing on. A lead in Bypass by the standing policy that sleeps comes back in Bypass at its wake, before the turn the wake was for runs.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { ChatPermissionMode, Workspace } from '@portal/contracts';
import { workerMode } from '@portal/contracts';
import { clearResolvers } from '../authz/seam.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { registerSessionTools } from '../portalmcp/tools/sessions.js';
import { registerChatTools } from './portalTools.js';
import { standingBypass } from './standingBypass.js';
import { APPLIED, controls, liveSession, ok, sleep, until, USAGE_API_KEY, type Live } from './testkit.js';

afterEach(() => (standingBypass.reset(), clearResolvers()));

/** Answers every mode switch (with the mode asked), settings read and usage read on the process that asked, until `p` settles. */
async function answering<T>(s: Live, p: Promise<T>): Promise<T> {
  let done = 0;
  const later: number[] = [];
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) {
    const due = later.splice(0);
    for (; done < s.ws.sends.length; done++) due.push(done);
    for (const i of due) {
      const sent = s.ws.sends[i]!;
      const c = controls({ sends: [sent] } as unknown as Live['ws'])[0];
      if (!c) continue;
      let at = -1;
      for (let j = s.ws.tailArgs.length - 1; j >= 0 && at < 0; j--) if (s.ws.tailArgs[j]![1] === sent.args[1]) at = j;
      const tail = s.ws.tails[at];
      if (!tail) {
        later.push(i);
        continue;
      }
      if (c.request.subtype === 'set_permission_mode') tail.push(ok(c.id, { mode: String(c.request.mode) }));
      else if (c.request.subtype === 'get_settings') tail.push(ok(c.id, APPLIED));
      else if (c.request.subtype === 'get_usage') tail.push(ok(c.id, USAGE_API_KEY));
    }
    await sleep(5);
  }
  return p;
}

type Spawned = { id: string; applied: string[]; unconfirmed: string[] };
const spawned = (raw: { result?: { structuredContent?: Record<string, unknown> } }) => raw.result!.structuredContent!.session as Spawned;

/** A live lead in docker/ws1 with the global switch on; `list` is the standing list set before it starts (so it starts capable there). */
async function rig(list: string, opts: Parameters<typeof liveSession>[0] = {}) {
  standingBypass.configure(list);
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const s = await liveSession(opts, true);
  s.controller.bypassAllowed = () => true;
  s.controller.reauth = { fresh: (token) => token === 'tok' };
  s.controller.agentCaps = () => ({ maxDepth: 2, maxChildren: 10, spawnsPerHour: 40, messagesPerHour: 40 });
  registerChatTools(s.controller, registry);
  h.alive.add(s.id);
  // Spawn deliveries (a worker's settings and first prompt) run on after the call answers: let them settle before the store closes.
  const done = async () => {
    for (const c of s.controller.children(s.id))
      await answering(
        s,
        s.controller.end(c.id).catch(() => undefined),
      );
    await answering(
      s,
      s.controller.end(s.id).catch(() => undefined),
    );
    await answering(s, sleep(200));
    h.done();
    await s.done();
  };
  return { h, s, registry, done };
}

/** Puts the lead in Bypass: by the standing policy when the workspace is listed, else by a person's own entry (capable by opt-in). */
async function bypassByStanding(s: Live) {
  await answering(s, s.controller.enterBypassStanding(s.id, { actor: 'portal:standing' }));
  assert.equal(s.controller.get(s.id)!.mode, 'bypassPermissions', 'set up: the lead is in Bypass');
}

test('workerMode: a standing parent in Bypass hands Bypass on over no mode, Auto, dontAsk and default; plan and acceptEdits asked are kept', () => {
  for (const asked of [undefined, 'auto', 'dontAsk', 'default'] as const)
    assert.equal(
      workerMode(asked, 'bypassPermissions', { parentInBypass: true, standingParent: true }),
      'bypassPermissions',
      String(asked),
    );
  for (const asked of ['plan', 'acceptEdits'] as const)
    assert.equal(workerMode(asked, 'bypassPermissions', { parentInBypass: true, standingParent: true }), asked, `${asked} kept`);
  // Without the standing policy the T-2997 rule is unchanged: a narrower mode asked by name wins.
  for (const asked of ['dontAsk', 'default'] as const)
    assert.equal(workerMode(asked, 'bypassPermissions', { parentInBypass: true }), asked, `${asked} outside the policy`);
});

test('PILOT-1198: in a listed workspace session_spawn from a lead in Bypass starts the worker in Bypass with no mode, dontAsk or default asked; plan is kept', async () => {
  const r = await rig('docker/ws1');
  try {
    await bypassByStanding(r.s);
    const a = await r.h.agentToken('docker/ws1', r.s.id);
    for (const mode of [undefined, 'dontAsk', 'default', 'auto'] as const) {
      const raw = await answering(
        r.s,
        r.h.call(a.secret, 'session_spawn', { prompt: 'Ship it.', title: `Worker ${mode}`, ...(mode ? { mode } : {}) }),
      );
      const w = spawned(raw);
      assert.deepEqual([w.applied, w.unconfirmed], [['mode bypassPermissions'], []], String(mode));
      const worker = r.s.controller.get(w.id)!;
      assert.deepEqual([worker.mode, worker.bypassCapable, worker.parentId], ['bypassPermissions', true, r.s.id], String(mode));
      const entered = r.s.controller.audit({ kind: 'bypass.entered' }).find((x) => x.sessionId === w.id)!;
      assert.equal(entered.detail.how, 'standing', String(mode));
    }
    const plan = spawned(
      await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Plan it.', title: 'Plan worker', mode: 'plan' })),
    );
    assert.equal(r.s.controller.get(plan.id)!.mode, 'plan', 'plan asked by name is kept');
  } finally {
    await r.done();
  }
});

test('PILOT-1198 negatives: an unlisted workspace keeps dontAsk asked; a listed one with a parent not in Bypass hands no Bypass on', async () => {
  // Unlisted: the lead is in Bypass by a person's own entry; dontAsk asked by name stays dontAsk (T-2997), as before.
  const r = await rig('docker/other', {});
  try {
    const lead = await r.s.controller.create({ workspaceId: 'docker/ws1', title: 'Lead' }, { bypassOptIn: true });
    await until(() => r.s.controller.get(lead.id)?.state === 'idle');
    await sleep(20);
    r.h.alive.add(lead.id);
    await answering(r.s, r.s.controller.enterBypass(lead.id, { acknowledged: true, sessionToken: 'tok' }));
    assert.equal(r.s.controller.get(lead.id)!.mode, 'bypassPermissions');
    assert.equal(r.s.controller.standingParentInBypass(lead.id), false);
    const a = await r.h.agentToken('docker/ws1', lead.id);
    for (const mode of ['dontAsk', 'default'] as const) {
      const w = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Read.', title: `Unlisted ${mode}`, mode })));
      assert.deepEqual([r.s.controller.get(w.id)!.mode, r.s.controller.get(w.id)!.bypassCapable], [mode, false], mode);
    }
  } finally {
    await r.done();
  }
  // Listed, the parent not in Bypass (default): its worker gets no Bypass whatever is asked.
  const l = await rig('docker/ws1');
  try {
    assert.equal(l.s.controller.get(l.s.id)!.mode, 'default');
    assert.equal(l.s.controller.standingParentInBypass(l.s.id), false);
    const a = await l.h.agentToken('docker/ws1', l.s.id);
    for (const mode of [undefined, 'dontAsk', 'default'] as const) {
      const w = spawned(
        await answering(l.s, l.h.call(a.secret, 'session_spawn', { prompt: 'Read.', title: `Manual ${mode}`, ...(mode ? { mode } : {}) })),
      );
      assert.notEqual(l.s.controller.get(w.id)!.mode, 'bypassPermissions', String(mode));
      assert.equal(
        l.s.controller.audit({ kind: 'bypass.entered' }).some((x) => x.sessionId === w.id),
        false,
        String(mode),
      );
    }
  } finally {
    await l.done();
  }
});

test('PILOT-1198: session_start with a parent in Bypass in a listed workspace starts the worker in Bypass (no mode, dontAsk, default); unlisted or a parent out of Bypass does not', async () => {
  const r = await rig('docker/ws1');
  const workspaces = [
    { id: 'docker/ws1', target: 'docker', name: 'ws1', label: 'One' },
    { id: 'docker/ws2', target: 'docker', name: 'ws2', label: 'Two' },
  ] as unknown as Workspace[];
  registerSessionTools(
    { store: r.s.store, chat: r.s.controller, workspaces: { list: async () => workspaces, resolve: () => null } },
    r.registry,
  );
  r.h.module.settings.update({ sessionControl: true });
  const admin = r.h.token('admin');
  try {
    // The parent not in Bypass yet: dontAsk asked stays dontAsk.
    const before = await answering(
      r.s,
      r.h.call(admin.secret, 'session_start', { workspace_id: 'docker/ws1', parent: r.s.id, mode: 'dontAsk' }),
    );
    assert.equal(before.result?.isError, undefined, JSON.stringify(before.raw));
    const beforeId = before.result!.structuredContent.session.id as string;
    assert.equal(r.s.controller.get(beforeId)!.mode, 'dontAsk', 'a parent out of Bypass hands nothing on');

    await bypassByStanding(r.s);
    for (const mode of [undefined, 'dontAsk', 'default'] as const) {
      const raw = await answering(
        r.s,
        r.h.call(admin.secret, 'session_start', { workspace_id: 'docker/ws1', parent: r.s.id, ...(mode ? { mode } : {}) }),
      );
      assert.equal(raw.result?.isError, undefined, JSON.stringify(raw.raw));
      const id = raw.result!.structuredContent.session.id as string;
      const w = r.s.controller.get(id)!;
      assert.deepEqual([w.mode, w.bypassCapable, w.parentId], ['bypassPermissions', true, r.s.id], String(mode));
    }
    // Unlisted now: dontAsk asked stays dontAsk even under the parent in Bypass.
    standingBypass.configure('docker/ws2');
    const raw = await answering(
      r.s,
      r.h.call(admin.secret, 'session_start', { workspace_id: 'docker/ws1', parent: r.s.id, mode: 'dontAsk' as ChatPermissionMode }),
    );
    const id = raw.result!.structuredContent.session.id as string;
    assert.equal(r.s.controller.get(id)!.mode, 'dontAsk', 'unlisted: as asked');
  } finally {
    await r.done();
  }
});

test('PILOT-1178: a lead in Bypass by the standing policy sleeps and wakes back in Bypass before the woken turn runs; unlisted it stays out', async () => {
  const r = await rig('docker/ws1', { idleSleepMs: 300 });
  try {
    await bypassByStanding(r.s);
    r.s.controller.setLimits(r.s.id, { maxWorkers: 3 }, { actor: 'ui' }); // a crew lead, as the memor.id lead was
    await until(() => r.s.controller.get(r.s.id)!.process === 'asleep', 4000);
    assert.equal(r.s.controller.get(r.s.id)!.mode === 'bypassPermissions', false, 'asleep: the start mode while nothing runs');
    const left = r.s.controller.audit({ kind: 'bypass.left' }).filter((x) => x.sessionId === r.s.id);
    assert.deepEqual([left[0]?.detail.why, left[0]?.detail.kept], ['sleep', true], 'the sleep keeps it');
    const sendsBefore = r.s.ws.sends.length;
    await answering(r.s, r.s.controller.send(r.s.id, 'wake-1', 'next ticket please'));
    assert.equal(r.s.controller.get(r.s.id)!.mode, 'bypassPermissions', 'back in Bypass after the wake');
    const entered = r.s.controller.audit({ kind: 'bypass.entered' }).find((x) => x.sessionId === r.s.id)!;
    assert.equal(entered.detail.how, 'wake');
    assert.equal(
      r.s.controller.audit({ kind: 'bypass.left' }).some((x) => x.sessionId === r.s.id && x.detail.why === 'not_confirmed'),
      false,
      'no lead gate dropped it',
    );
    // The switch to Bypass reached the woken process before the message the wake was for (its first turn, and so its first tool call).
    const after = r.s.ws.sends.slice(sendsBefore);
    const sw = after.findIndex((x) => /"set_permission_mode"/.test(x.line) && /bypassPermissions/.test(x.line));
    const msg = after.findIndex((x) => x.line.includes('next ticket please'));
    assert.ok(sw >= 0 && msg >= 0 && sw < msg, `the switch (${sw}) before the message (${msg})`);
  } finally {
    await r.done();
  }
  // Unlisted, the same lead entered by a person: no person's entry is missing, so this only checks the policy does not widen anything.
  standingBypass.configure('docker/other');
  const u = await rig('docker/other', { idleSleepMs: 300 });
  try {
    assert.equal(u.s.controller.standingFor(u.s.id), false);
    await assert.rejects(u.s.controller.enterBypassStanding(u.s.id), /standing Bypass policy does not cover/);
  } finally {
    await u.done();
  }
});
