// PILOT-1129 (T-3598): the standing Bypass policy per workspace. The env list, the protected and production guard, the empty list as today's
// behaviour; in a covered workspace: sessions start bypass-capable, a session.bypass card is allowed by the portal ("standing policy
// (owner)", audited), waiting cards are allowed at startup, Keep going's put-back has no 24 hour window and makes a session capable first,
// a worker of a parent in Bypass enters it; never in another workspace, never with the global switch off.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Approvals } from '../approvals/service.js';
import { Settings } from '../settings/store.js';
import { STANDING_BYPASS_SETTING } from './bypass.js';
import {
  STANDING_BYPASS_DECIDER,
  StandingBypassPolicy,
  parseStandingWorkspaces,
  standingBypass,
  workspaceProtected,
} from './standingBypass.js';
import { APPLIED, controls, liveSession, ok, sleep, until, type Live } from './testkit.js';

afterEach(() => standingBypass.reset());

test('the env list: valid <target>/<name> ids, trimmed and de-duplicated; anything else ignored and reported', () => {
  assert.deepEqual(parseStandingWorkspaces(' konfersi/konfersi, kohilabs/kohilabs ,,konfersi/konfersi'), {
    ids: ['konfersi/konfersi', 'kohilabs/kohilabs'],
    ignored: [],
  });
  assert.deepEqual(parseStandingWorkspaces(undefined), { ids: [], ignored: [] });
  assert.deepEqual(parseStandingWorkspaces('konfersi, a/b c, /x, docker/ws1').ids, ['docker/ws1']);
  assert.deepEqual(parseStandingWorkspaces('konfersi, a/b c, /x').ignored, ['konfersi', 'a/b c', '/x']);
});

test('the guard rails: an empty list covers nothing, another workspace is not covered, a production or protected one never is', () => {
  const p = new StandingBypassPolicy();
  p.configure('');
  assert.deepEqual(p.check('konfersi/konfersi'), { ok: false, why: 'empty' });
  p.configure('konfersi/konfersi,konfersi/konfersi-prd,docker/prod,docker/marked', (id) =>
    id === 'docker/marked' ? { name: 'marked', description: 'Billing [protected]' } : null,
  );
  assert.deepEqual(p.check('konfersi/konfersi'), { ok: true });
  assert.deepEqual(p.check('kohilabs/kohilabs'), { ok: false, why: 'not_listed' });
  assert.deepEqual(p.check('konfersi/konfersi-prd'), { ok: false, why: 'protected' });
  assert.deepEqual(p.check('docker/prod'), { ok: false, why: 'protected' });
  assert.deepEqual(p.check('docker/marked'), { ok: false, why: 'protected' }, 'marked [protected]');
  assert.equal(workspaceProtected({ id: 'memorid/memorid' }), false);
  assert.equal(workspaceProtected({ id: 'docker/product' }), false, 'a word that only contains prod is not one');
  assert.equal(p.applies(null), false);
});

test('Settings: the list is a read-only row (fixedBy the env), and a change through the store is refused', async () => {
  const s = await liveSession();
  try {
    standingBypass.configure('docker/ws1, kohilabs/kohilabs');
    const settings = new Settings(s.store);
    const row = settings.view().settings.find((x) => x.key === STANDING_BYPASS_SETTING)!;
    assert.deepEqual([row.value, row.fixedBy], ['docker/ws1, kohilabs/kohilabs', 'PORTAL_BYPASS_STANDING_WORKSPACES']);
    assert.equal(settings.get(STANDING_BYPASS_SETTING), 'docker/ws1, kohilabs/kohilabs');
    assert.throws(() => settings.set(STANDING_BYPASS_SETTING, 'docker/other', { actor: 'ui' }), /deploy manifest/);
    standingBypass.configure('');
    assert.equal(settings.view().settings.find((x) => x.key === STANDING_BYPASS_SETTING)!.value, '', 'empty: off');
  } finally {
    await s.done();
  }
});

/** A live controller with the global Bypass switch on and the approvals service over it. */
function rig(s: Live, allowed = true) {
  s.controller.bypassAllowed = () => allowed;
  s.controller.reauth = { fresh: () => false }; // no person's server code anywhere in these tests
  return new Approvals({ db: () => s.store.db, chat: s.controller });
}

async function newSession(s: Live, workspaceId = 'docker/ws1', opts: Parameters<Live['controller']['create']>[1] = {}) {
  const before = s.ws.tails.length;
  const created = await s.controller.create({ workspaceId }, opts);
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(created.id)?.state === 'idle');
  await sleep(20);
  return { id: created.id, tail: s.ws.tails.at(-1)! };
}

/** Answers the next set_permission_mode with Bypass on the newest process. */
async function answerBypass(s: Live) {
  const req = await s.take('set_permission_mode');
  s.ws.tails.at(-1)!.push(ok(req.id, { mode: 'bypassPermissions' }));
}

const decidedBy = (s: Live, id: string) => ({
  ...(s.store.db!.prepare('SELECT status, decided_by FROM approvals WHERE id = ?').get(id) as {
    status: string;
    decided_by: string | null;
  }),
});

/** Answers every settings read and every switch to Bypass, on the newest process, until `p` settles (a restart makes a new one). */
async function driving<T>(s: Live, p: Promise<T>): Promise<T> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  const seen = new Set<string>();
  while (!settled) {
    for (const c of controls(s.ws)) {
      if (seen.has(c.id)) continue;
      if (c.request.subtype === 'get_settings') (seen.add(c.id), s.ws.tails.at(-1)!.push(ok(c.id, APPLIED)));
      else if (c.request.subtype === 'set_permission_mode')
        (seen.add(c.id), s.ws.tails.at(-1)!.push(ok(c.id, { mode: 'bypassPermissions' })));
    }
    await sleep(5);
  }
  return p;
}

test('a covered workspace: the session starts bypass-capable, its session.bypass card is allowed by the standing policy (owner), audited', async () => {
  const s = await liveSession();
  try {
    standingBypass.configure('docker/ws1');
    const approvals = rig(s);
    const b = await newSession(s);
    assert.equal(s.controller.get(b.id)!.bypassCapable, true, 'capable without a person’s opt-in');
    assert.equal(s.controller.get(b.id)!.standingBypass, true, 'the badge');
    assert.deepEqual(s.controller.audit({ kind: 'bypass.capable', sessionId: b.id })[0]?.detail, {
      how: 'standing',
      decidedBy: STANDING_BYPASS_DECIDER,
    });
    const a = approvals.create(
      { kind: 'session.bypass', payload: { sessionId: b.id }, reason: 'self-heal' },
      { sessionId: b.id, workspaceId: 'docker/ws1' },
    );
    await answerBypass(s);
    await approvals.standingDone();
    assert.deepEqual(decidedBy(s, a.id), { status: 'allowed', decided_by: STANDING_BYPASS_DECIDER });
    assert.equal(s.controller.get(b.id)!.mode, 'bypassPermissions');
    const entered = s.controller.audit({ kind: 'bypass.entered', sessionId: b.id })[0]!;
    assert.deepEqual(
      [entered.actor, entered.severity, entered.detail.policy, entered.detail.decidedBy, entered.detail.approvalId],
      ['portal', 'high', 'standing', STANDING_BYPASS_DECIDER, a.id],
    );
  } finally {
    await s.done();
  }
});

test('negatives: another workspace, an empty list, or the global switch off: not capable, the card waits for a person', async () => {
  for (const [list, allowed] of [
    ['docker/other', true],
    ['', true],
    ['docker/ws1', false],
  ] as const) {
    const s = await liveSession();
    try {
      standingBypass.configure(list);
      const approvals = rig(s, allowed);
      const b = await newSession(s);
      assert.equal(s.controller.get(b.id)!.bypassCapable, false, `${list || 'empty'} / switch ${allowed}`);
      assert.equal(s.controller.standingFor(b.id), false);
      const a = approvals.create({ kind: 'session.bypass', payload: { sessionId: b.id } }, { sessionId: b.id, workspaceId: 'docker/ws1' });
      await approvals.standingDone();
      await sleep(30);
      assert.deepEqual(decidedBy(s, a.id), { status: 'pending', decided_by: null });
      assert.equal(s.controller.get(b.id)!.mode === 'bypassPermissions', false);
      assert.equal(await s.controller.restoreBypass(b.id), false, 'no put-back either');
      await assert.rejects(s.controller.enterBypassStanding(b.id), /standing Bypass policy does not cover|blocked by policy/);
    } finally {
      await s.done();
    }
  }
});

test('startup: cards that waited for a person are allowed once the session’s workspace is covered', async () => {
  const s = await liveSession();
  try {
    const approvals = rig(s);
    const b = await newSession(s, 'docker/ws1', { bypassOptIn: true });
    const a = approvals.create({ kind: 'session.bypass', payload: { sessionId: b.id } }, { sessionId: b.id, workspaceId: 'docker/ws1' });
    await approvals.standingDone();
    assert.equal(decidedBy(s, a.id).status, 'pending', 'no policy yet: it waits');
    standingBypass.configure('docker/ws1');
    const allowing = approvals.allowStandingPending();
    await answerBypass(s);
    assert.equal(await allowing, 1);
    assert.deepEqual(decidedBy(s, a.id), { status: 'allowed', decided_by: STANDING_BYPASS_DECIDER });
    assert.equal(s.controller.get(b.id)!.mode, 'bypassPermissions');
  } finally {
    await s.done();
  }
});

test('Keep going’s put-back under the standing policy: no 24 hour window, and a session started before the policy is made capable first', async () => {
  const s = await liveSession({}, true);
  try {
    rig(s);
    // Started before the policy: not capable, never in Bypass (no bypassSeenAt at all).
    const b = await newSession(s);
    assert.equal(s.controller.get(b.id)!.bypassCapable, false);
    assert.equal(s.controller.bypassSeenAt(b.id), null);
    standingBypass.configure('docker/ws1');
    const tails = s.ws.tails.length;
    // The restart for the flag (a new process), then the switch on it.
    assert.equal(await driving(s, s.controller.restoreBypass(b.id)), true);
    assert.ok(s.ws.tails.length > tails, 'restarted with the flag');
    assert.equal(s.controller.get(b.id)!.mode, 'bypassPermissions');
    assert.equal(s.controller.get(b.id)!.bypassCapable, true);
    assert.equal(s.controller.audit({ kind: 'bypass.capable', sessionId: b.id })[0]?.detail.how, 'standing');
  } finally {
    await s.done();
  }
});
