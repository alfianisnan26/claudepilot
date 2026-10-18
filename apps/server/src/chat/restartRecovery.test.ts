// T-971 H2 (chat-sessions PRD, restart recovery): a session that was WORKING when a portal start found its process gone is resumed by itself
// (the path every resume takes, then the continuation message), a few at a time, spaced apart, never into Bypass, on the record, and once.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Workspaces } from '../workspaces/manager.js';
import { ChatController } from './controller.js';
import { DAY_MS, pendingCutOffs, RESTART_PENDING_MS, RESTART_RESUME_MAX, RESTART_RESUME_STAGGER_SEC, restartResumesToday } from './recover.js';
import { controls, init, liveSession, ok, sleep, until, type Live } from './testkit.js';

const settings = (max: number, staggerSec = 0) => (key: string) => (key === RESTART_RESUME_MAX ? max : key === RESTART_RESUME_STAGGER_SEC ? staggerSec : undefined);
/** The restart settings, and a short wait for what a resumed fake process never answers (its control replies). */
const fast = (s: Live, max: number, staggerSec = 0) => {
  s.controller.controlTimeoutMs = 150;
  s.controller.recoverSettings = settings(max, staggerSec);
};
const CONTINUATION = /The portal restarted while you were working/;

const recoveries = (s: Live, id?: string) => s.controller.audit({ kind: 'session.restart_recovery', ...(id ? { sessionId: id } : {}) });
const cutoffs = (s: Live, id: string) => s.controller.audit({ kind: 'session.cutoff', sessionId: id });
const sent = (s: Live, id: string) => s.ws.sends.filter((x) => x.args[1] === id && CONTINUATION.test(x.line)).length;
const working = (s: Live, id: string) => s.store.db!.prepare("UPDATE chat_sessions SET state = 'working' WHERE id = ?").run(id);

/** Another idle session in the same workspace. */
async function made(s: Live, title: string, bypassOptIn = false) {
  const before = s.ws.tails.length;
  const c = await (bypassOptIn ? s.controller.create({ workspaceId: 'docker/ws1', title }, { bypassOptIn: true }) : s.controller.create({ workspaceId: 'docker/ws1', title }));
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(c.id)?.state === 'idle');
  await sleep(20);
  return { id: c.id, tail: s.ws.tails.at(-1)! };
}

/** These sessions are working; the host says their processes are gone; the portal starts. Returns once each cut-off is on the record. */
async function cutOff(s: Live, ids: string[]) {
  for (const id of ids) working(s, id);
  s.ws.alive = false;
  s.controller.start();
  await until(() => ids.every((id) => cutoffs(s, id).length >= 1));
  s.ws.alive = true;
}

test('T-971 H2: a session that was working when the portal started and lost its process is resumed once, with the continuation, and one line says so', async () => {
  const s = await liveSession();
  try {
    fast(s, 5);
    const lines: { sessionId: string; result: string; needsBypass: boolean; line: string }[] = [];
    s.controller.onRestartRecovery = (i) => lines.push(i);
    const starts = s.ws.startArgs.length;
    await cutOff(s, [s.id]);
    await until(() => recoveries(s, s.id).length === 1);
    await until(() => s.controller.get(s.id)!.process === 'live');
    assert.equal(recoveries(s, s.id)[0]!.detail.result, 'resumed');
    assert.equal(s.ws.startArgs.length, starts + 1, 'one new process');
    // A session that never took a turn has no conversation on disk yet: the launch path then starts it under its own id instead of --resume.
    assert.ok(s.ws.startArgs.at(-1)!.includes('--resume') || s.ws.startArgs.at(-1)!.includes('--session-id'), 'the same conversation, relaunched');
    assert.ok(s.ws.startArgs.at(-1)!.includes(s.id), 'under its own id');
    await until(() => sent(s, s.id) === 1);
    await sleep(150);
    assert.equal(s.ws.startArgs.length, starts + 1, 'not resumed again');
    assert.equal(sent(s, s.id), 1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.result, 'resumed');
    assert.equal(lines[0]!.needsBypass, false);
    assert.ok(lines[0]!.line.includes(s.id) && lines[0]!.line.includes('docker/ws1') && /resumed\.$/.test(lines[0]!.line), lines[0]!.line);
    assert.equal(recoveries(s, s.id)[0]!.detail.line, lines[0]!.line, 'the audit row says the same line');
  } finally {
    await s.done();
  }
});

test('T-971 H2 Bypass: a session that was in Bypass resumes in its normal mode, Bypass is never asked for again, and the line says it needs it', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    fast(s, 5);
    s.controller.bypassAllowed = () => true;
    s.controller.reauth = { fresh: (token) => token === 'tok' };
    const lead = await made(s, 'Lead', true);
    s.controller.setLimits(lead.id, { maxWorkers: 3 }, { actor: 'ui' }); // a lead: the gated path WOULD put Bypass back on a relaunch (T-416 S2)
    lead.tail.push(init(lead.id));
    const entering = s.controller.enterBypass(lead.id, { acknowledged: true, sessionToken: 'tok' });
    lead.tail.push(ok((await s.take('set_permission_mode')).id, { mode: 'bypassPermissions' }));
    await entering;
    assert.equal(s.controller.get(lead.id)!.mode, 'bypassPermissions');
    const asks = () => controls(s.ws).filter((c) => c.request.subtype === 'set_permission_mode' && c.request.mode === 'bypassPermissions').length;
    const asked = asks();
    const lines: string[] = [];
    s.controller.onRestartRecovery = (i) => lines.push(i.line);
    await cutOff(s, [lead.id]);
    assert.equal(cutoffs(s, lead.id)[0]!.detail.bypass, true);
    await until(() => recoveries(s, lead.id).length === 1);
    await until(() => s.controller.get(lead.id)!.process === 'live');
    await sleep(300); // a gated Bypass entry, if one were tried, is asked and times out within this
    assert.equal(recoveries(s, lead.id)[0]!.detail.result, 'resumed');
    assert.equal(s.controller.get(lead.id)!.mode, 'default', 'the normal mode');
    assert.equal(asks(), asked, 'Claude Code was never asked to enter Bypass again');
    assert.ok(!s.ws.startArgs.at(-1)!.includes('--dangerously-skip-permissions'));
    assert.equal(s.controller.audit({ kind: 'bypass.entered', sessionId: lead.id }).filter((a) => a.detail.how === 'lost').length, 0);
    assert.equal(recoveries(s, lead.id)[0]!.detail.needsBypass, true);
    assert.match(lines[0]!, /resumed; needs Bypass again\.$/);
    const left = s.controller.audit({ kind: 'bypass.left', sessionId: lead.id })[0]!;
    assert.deepEqual([left.detail.superseded ?? null, left.detail.restartResume ?? null], [true, true], 'the kept record no later wake may act on is superseded');
  } finally {
    await s.done();
  }
});

test('T-971 H2 limit: at most the setting per start are resumed, the rest stay Interrupted and are listed', async () => {
  const s = await liveSession();
  try {
    fast(s, 2);
    const b = await made(s, 'B');
    const c = await made(s, 'C');
    const ids = [s.id, b.id, c.id];
    const starts = s.ws.startArgs.length;
    await cutOff(s, ids);
    await until(() => recoveries(s).length === 3);
    const results = ids.map((id) => recoveries(s, id)[0]!.detail.result);
    assert.deepEqual(results.filter((r) => r === 'resumed').length, 2, JSON.stringify(results));
    assert.deepEqual(results.filter((r) => r === 'over_limit').length, 1);
    assert.equal(s.ws.startArgs.length, starts + 2, 'two processes, not three');
    const over = ids.find((id) => recoveries(s, id)[0]!.detail.result === 'over_limit')!;
    assert.equal(s.controller.get(over)!.state, 'interrupted');
    assert.match(String(recoveries(s, over)[0]!.detail.line), /over the limit of 2 per start: Resume it by hand/);
  } finally {
    await s.done();
  }
});

test('T-971 H2 stagger: the resumes of one start are spaced by the setting', async () => {
  const s = await liveSession();
  try {
    fast(s, 5, 1);
    const b = await made(s, 'B');
    await cutOff(s, [s.id, b.id]);
    await until(() => recoveries(s).length === 2, 6000);
    const [newest, oldest] = recoveries(s).map((r) => Date.parse(r.at));
    assert.ok(newest! - oldest! >= 900, `the second came ${newest! - oldest!} ms after the first`);
  } finally {
    await s.done();
  }
});

test('T-971 H2 skips: an ended session, an archived one and one already running are not resumed, and the line says why', async () => {
  const s = await liveSession();
  try {
    fast(s, 5);
    const ended = await made(s, 'Ended');
    const archived = await made(s, 'Archived');
    const db = s.store.db!;
    const plant = (id: string) =>
      db.prepare('INSERT INTO chat_audit (at, severity, kind, session_id, workspace_id, actor, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run(new Date().toISOString(), 'info', 'session.cutoff', id, 'docker/ws1', 'portal', JSON.stringify({ state: 'working', bypass: false }));
    await s.controller.end(ended.id);
    await s.controller.end(archived.id);
    db.prepare("UPDATE chat_sessions SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), archived.id);
    db.prepare("UPDATE chat_sessions SET state = 'interrupted', process = 'gone', ended_reason = NULL WHERE id = ?").run(archived.id);
    for (const id of [ended.id, archived.id, s.id]) plant(id); // s.id: running, as a person resumed it first
    const starts = s.ws.startArgs.length;
    s.controller.start();
    await until(() => recoveries(s).length === 3);
    assert.deepEqual(
      [ended.id, archived.id, s.id].map((id) => [recoveries(s, id)[0]!.detail.result, /it has ended|it is archived|it is running again/.exec(String(recoveries(s, id)[0]!.detail.line))?.[0]]),
      [['skipped', 'it has ended'], ['skipped', 'it is archived'], ['skipped', 'it is running again']],
    );
    assert.equal(s.ws.startArgs.length, starts, 'nothing was started');
  } finally {
    await s.done();
  }
});

test('T-971 H2 once: a second start before the resume still finds the cut-off, and a third finds nothing left', async () => {
  const s = await liveSession();
  try {
    fast(s, 0); // the first start records the cut-off but resumes nothing
    const starts = s.ws.startArgs.length;
    await cutOff(s, [s.id]);
    await sleep(100);
    assert.equal(recoveries(s).length, 0);
    assert.equal(s.controller.get(s.id)!.state, 'interrupted');
    s.controller.stop();
    // The second start (a new controller on the same store).
    const second = new ChatController(s.store, s.ws as unknown as Workspaces, {});
    second.controlTimeoutMs = 150;
    second.recoverSettings = settings(5);
    second.start();
    try {
      await until(() => recoveries(s, s.id).length === 1);
      await until(() => second.get(s.id)!.process === 'live');
      assert.equal(s.ws.startArgs.length, starts + 1, 'resumed by the second start');
    } finally {
      second.stop();
    }
    // The third start: the session is cut off again by something else and the old cut-off is already answered.
    s.store.db!.prepare("UPDATE chat_sessions SET state = 'interrupted', process = 'gone' WHERE id = ?").run(s.id);
    const third = new ChatController(s.store, s.ws as unknown as Workspaces, {});
    third.controlTimeoutMs = 150;
    third.recoverSettings = settings(5);
    third.start();
    try {
      await sleep(300);
      assert.equal(recoveries(s, s.id).length, 1, 'no second recovery row');
      assert.equal(s.ws.startArgs.length, starts + 1, 'and no second resume');
    } finally {
      third.stop();
    }
  } finally {
    await s.done();
  }
});

test('T-971 H2 what counts: a session that was idle, or whose process vanished long after the start, is not a cut-off', async () => {
  let now = Date.now();
  const s = await liveSession({ livenessMs: 20, clock: () => now });
  try {
    fast(s, 5);
    const b = await made(s, 'B');
    working(s, b.id);
    s.controller.start();
    await sleep(60);
    now += 11 * 60_000; // past the window: a vanishing now is a crash, not the restart
    s.ws.alive = false;
    await until(() => s.controller.get(s.id)!.state === 'interrupted' && s.controller.get(b.id)!.state === 'interrupted');
    await sleep(150);
    assert.equal(cutoffs(s, s.id).length + cutoffs(s, b.id).length, 0, 'no cut-off recorded');
    assert.equal(recoveries(s).length, 0);
  } finally {
    await s.done();
  }
});

test('T-971 H2 what counts: an idle session found gone at the start is not resumed', async () => {
  const s = await liveSession();
  try {
    fast(s, 5);
    const starts = s.ws.startArgs.length;
    s.ws.alive = false;
    s.controller.start();
    await until(() => s.controller.get(s.id)!.state === 'interrupted');
    await sleep(150);
    assert.equal(cutoffs(s, s.id).length, 0);
    assert.equal(s.ws.startArgs.length, starts);
  } finally {
    await s.done();
  }
});

test('T-971 H2 loop guard: a session a restart resumed three times today is not resumed a fourth time', async () => {
  const s = await liveSession();
  try {
    fast(s, 5);
    const db = s.store.db!;
    for (let i = 0; i < 3; i++)
      db.prepare('INSERT INTO chat_audit (at, severity, kind, session_id, workspace_id, actor, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run(new Date(Date.now() - 2 * 3_600_000 + i).toISOString(), 'info', 'session.restart_recovery', s.id, 'docker/ws1', 'portal', JSON.stringify({ result: 'resumed' }));
    const starts = s.ws.startArgs.length;
    await cutOff(s, [s.id]);
    await until(() => recoveries(s, s.id).length === 4);
    assert.equal(recoveries(s, s.id)[0]!.detail.result, 'looping');
    assert.equal(s.ws.startArgs.length, starts);
    assert.match(String(recoveries(s, s.id)[0]!.detail.line), /already resumed 3 times today: Resume it by hand/);
  } finally {
    await s.done();
  }
});

const HOUR = 3_600_000;
const plant = (s: Live, id: string, kind: string, at: number, detail: Record<string, unknown>) =>
  s.store.db!.prepare('INSERT INTO chat_audit (at, severity, kind, session_id, workspace_id, actor, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run(new Date(at).toISOString(), 'info', kind, id, 'docker/ws1', 'portal', JSON.stringify(detail));
const gone = (s: Live, id: string) => s.store.db!.prepare("UPDATE chat_sessions SET state = 'interrupted', process = 'gone' WHERE id = ?").run(id);

test('T-971 H2 loop guard edge (injected clock): three resumes just inside 24 hours stop a fourth, three just outside do not count', async () => {
  const now = Date.now();
  const s = await liveSession({ clock: () => now });
  try {
    fast(s, 5);
    const b = await made(s, 'B');
    for (let i = 0; i < 3; i++) {
      plant(s, s.id, 'session.restart_recovery', now - 24 * HOUR + 60_000 + i, { result: 'resumed' }); // 1 minute inside
      plant(s, b.id, 'session.restart_recovery', now - 24 * HOUR - 60_000 + i, { result: 'resumed' }); // 1 minute outside
    }
    await cutOff(s, [s.id, b.id]);
    await until(() => recoveries(s, s.id).length === 4 && recoveries(s, b.id).length === 4);
    assert.equal(recoveries(s, s.id)[0]!.detail.result, 'looping', 'inside the 24 hours: counted');
    assert.equal(recoveries(s, b.id)[0]!.detail.result, 'resumed', 'outside the 24 hours: not counted');
  } finally {
    await s.done();
  }
});

test('T-971 H2 a person chose since the cut-off: a session put to sleep, or resumed and stopped again, is not resumed; one left alone is', async () => {
  const s = await liveSession();
  try {
    fast(s, 0); // the first start records the cut-offs and resumes nothing
    const b = await made(s, 'B');
    const c = await made(s, 'C');
    const starts = s.ws.startArgs.length;
    await cutOff(s, [s.id, b.id, c.id]);
    await sleep(100);
    const db = s.store.db!;
    db.prepare("UPDATE chat_sessions SET state = 'idle', process = 'asleep' WHERE id = ?").run(s.id); // a person put it to sleep
    db.prepare('UPDATE chat_sessions SET process_started_at = ? WHERE id = ?').run('2099-01-01T00:00:00.000Z', b.id); // a person resumed it (another process) and stopped it again: gone, interrupted
    s.controller.stop();
    const second = new ChatController(s.store, s.ws as unknown as Workspaces, {});
    second.controlTimeoutMs = 150;
    second.recoverSettings = settings(5);
    second.start();
    try {
      await until(() => recoveries(s).length === 3);
      const why = (id: string) => [recoveries(s, id)[0]!.detail.result, /put to sleep since|resumed and stopped since/.exec(String(recoveries(s, id)[0]!.detail.line))?.[0]];
      assert.deepEqual(why(s.id), ['skipped', 'put to sleep since']);
      assert.deepEqual(why(b.id), ['skipped', 'resumed and stopped since']);
      assert.equal(recoveries(s, c.id)[0]!.detail.result, 'resumed', 'the one nobody touched is resumed');
      await until(() => second.get(c.id)!.process === 'live');
      assert.equal(s.ws.startArgs.length, starts + 1, 'only that one was started');
      assert.equal(second.get(s.id)!.process, 'asleep', 'the sleeper stays asleep');
    } finally {
      second.stop();
    }
  } finally {
    await s.done();
  }
});

test('T-971 H2 failed tries count: three failed resumes today stop a fourth; skipped, over-limit and looping rows do not count', async () => {
  const now = Date.now();
  const s = await liveSession({ clock: () => now });
  try {
    fast(s, 5);
    const b = await made(s, 'B');
    for (let i = 0; i < 3; i++) plant(s, s.id, 'session.restart_recovery', now - 5 * HOUR + i, { result: 'failed' });
    ['skipped', 'over_limit', 'looping'].forEach((result, i) => plant(s, b.id, 'session.restart_recovery', now - 5 * HOUR + i, { result }));
    await cutOff(s, [s.id, b.id]);
    await until(() => recoveries(s, s.id).length === 4 && recoveries(s, b.id).length === 4);
    assert.equal(recoveries(s, s.id)[0]!.detail.result, 'looping', 'three failed tries are three tries');
    assert.equal(recoveries(s, b.id)[0]!.detail.result, 'resumed', 'rows that tried nothing do not count');
  } finally {
    await s.done();
  }
});

test('T-971 H2 a failed resume: the error text is scrubbed before it reaches the audit row and the platform line', async () => {
  const s = await liveSession();
  try {
    fast(s, 5);
    const secret = `${['sk', 'ant', 'api03'].join('-')}-${'Zq9_'.repeat(12)}`; // built at run time: never a literal
    const lines: string[] = [];
    s.controller.onRestartRecovery = (i) => lines.push(i.line);
    // A raw error from the slot check on the way to the launch: it reaches the recovery's catch as it is. (An error from the launch itself is
    // read back from the session's stored ended_reason, already redacted, so it would pass with or without the scrub in the recovery.)
    s.controller.liveCaps = () => {
      throw new Error(`launch refused ${secret}`);
    };
    await cutOff(s, [s.id]);
    await until(() => recoveries(s, s.id).length === 1);
    const row = recoveries(s, s.id)[0]!;
    assert.equal(row.detail.result, 'failed');
    assert.match(String(row.detail.line), /could not be resumed: .*launch refused \[redacted\]/);
    assert.ok(!JSON.stringify(row).includes(secret), 'not in the audit row');
    assert.equal(lines.length, 1);
    assert.ok(!lines[0]!.includes(secret), 'not in the platform audit line');
    assert.match(lines[0]!, /\[redacted\]/);
  } finally {
    await s.done();
  }
});

test('T-971 H2 pending age (injected clock): a cut-off older than an hour is dropped, one just inside is resumed', async () => {
  const now = Date.now();
  const s = await liveSession({ clock: () => now });
  try {
    fast(s, 5);
    const b = await made(s, 'B');
    for (const id of [s.id, b.id]) gone(s, id);
    plant(s, s.id, 'session.cutoff', now - HOUR - 60_000, { state: 'working', bypass: false }); // 1 minute too old
    plant(s, b.id, 'session.cutoff', now - HOUR + 60_000, { state: 'working', bypass: false }); // 1 minute inside
    const starts = s.ws.startArgs.length;
    s.controller.start();
    await until(() => recoveries(s, b.id).length === 1);
    await sleep(150);
    assert.equal(recoveries(s, b.id)[0]!.detail.result, 'resumed');
    assert.equal(recoveries(s, s.id).length, 0, 'the old cut-off is dropped without a line');
    assert.equal(s.ws.startArgs.length, starts + 1, 'only one process started');
    assert.equal(sent(s, s.id), 0);
  } finally {
    await s.done();
  }
});

test('T-971 H2 exact edges (pure, fixed instants): a cut-off exactly an hour old is dropped, one a millisecond younger stays; a resume exactly 24 hours old no longer counts, one a millisecond younger does', () => {
  const now = Date.parse('2026-10-18T12:00:00.000Z');
  const at = (ms: number) => new Date(ms).toISOString();
  const cut = (sessionId: string, ms: number) => ({ kind: 'session.cutoff', sessionId, at: at(ms), detail: { bypass: false } });
  assert.deepEqual(pendingCutOffs([cut('edge', now - RESTART_PENDING_MS)], [], now), [], 'at exactly RESTART_PENDING_MS it is too old');
  assert.deepEqual(
    pendingCutOffs([cut('inside', now - RESTART_PENDING_MS + 1)], [], now).map((p) => p.sessionId),
    ['inside'],
    'one millisecond younger is still pending',
  );
  const resumed = (ms: number) => ({ kind: 'session.restart_recovery', sessionId: 's', at: at(ms), detail: { result: 'resumed' } });
  assert.equal(restartResumesToday([resumed(now - DAY_MS)], 's', now), 0, 'a resume exactly 24 hours old is outside the day');
  assert.equal(restartResumesToday([resumed(now - DAY_MS + 1)], 's', now), 1, 'one millisecond younger counts');
  const result = (r: string) => ({ kind: 'session.restart_recovery', sessionId: 's', at: at(now - 1000), detail: { result: r } });
  assert.equal(restartResumesToday([result('resumed'), result('failed'), result('failed')], 's', now), 3, 'a failed try is a try');
  assert.equal(restartResumesToday([result('skipped'), result('over_limit'), result('looping')], 's', now), 0, 'rows that tried nothing are not');
});

test('T-971 H2 race: a session a person resumed during the spacing wait is skipped: no message, and it does not count against the loop guard', async () => {
  const s = await liveSession();
  try {
    fast(s, 5, 1);
    // The spacing wait is the test's: held until released, so the person's resume lands inside it every time.
    let release!: () => void;
    let waiting = 0;
    s.controller.restartPause = () => {
      waiting++;
      return new Promise<void>((resolve) => (release = resolve));
    };
    const b = await made(s, 'B');
    const starts = s.ws.startArgs.length;
    await cutOff(s, [s.id, b.id]);
    await until(() => recoveries(s).length === 1 && waiting === 1);
    const first = recoveries(s)[0]!.sessionId!;
    const other = first === s.id ? b.id : s.id;
    assert.equal(s.controller.get(other)!.process, 'gone', 'it was still cut off when the portal began to wait for it');
    s.store.db!.prepare("UPDATE chat_sessions SET process = 'live', state = 'idle' WHERE id = ?").run(other); // a person resumed it during the wait
    release();
    await until(() => recoveries(s).length === 2, 6000);
    const row = recoveries(s, other)[0]!;
    assert.equal(row.detail.result, 'skipped');
    assert.match(String(row.detail.line), /it is running again/);
    assert.equal(sent(s, other), 0, 'no "portal restarted" message');
    assert.equal(s.ws.startArgs.length, starts + 1, 'one process started, for the first only');
    assert.equal(recoveries(s).filter((r) => r.detail.result === 'resumed').length, 1, 'only one counts toward the loop guard');
  } finally {
    await s.done();
  }
});
