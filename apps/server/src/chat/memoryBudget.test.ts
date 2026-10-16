// T-416 (D-61): the portal enforces a memory budget per workspace. A start or a wake that would leave less than 1.5 GiB free (anon +
// active_file + the session's estimate, one more per Agent-tool sub-agent, one more per launch not running yet) is refused at once with a
// readable reason and nothing is made; below it, it runs. An unavailable reading never blocks. The liveness round raises the 85% alert.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import { parseMemoryProbe, type MemoryReading } from '../workspaces/memory.js';
import { MEMORY_BUDGET, MEMORY_HEADROOM_BYTES, SESSION_MEMORY_ESTIMATE_BYTES, WorkspaceMemory } from './memory.js';
import { ChatStore } from './store.js';
import { firstTurn, liveSession, sleep, until, vanish } from './testkit.js';

const GiB = 1024 ** 3;
const LIMIT = 8 * GiB;
/** The most that may be in use for one more session (no sub-agents) to fit. */
const ONE_FITS = LIMIT - MEMORY_HEADROOM_BYTES - SESSION_MEMORY_ESTIMATE_BYTES;

function reading(used: number, at = Date.now()): MemoryReading {
  const anon = Math.floor(used / 2);
  return parseMemoryProbe(`max ${LIMIT}\nanon ${anon}\nactive_file ${used - anon}\nproc 317440 claude\n`, at)!;
}

/** A budget whose reading a test sets, and whose clock it steps past the cache. */
function budget(used: number | null) {
  const state = { used, clock: 1_000_000, reads: 0, logs: [] as string[] };
  const memory = new WorkspaceMemory({
    read: async () => (state.reads++, state.used === null ? null : reading(state.used, state.clock)),
    now: () => state.clock,
    log: (l) => state.logs.push(l),
  });
  return { state, memory, set: (u: number | null) => ((state.used = u), (state.clock += 60_000)) };
}

const isBudget = (e: unknown) => e instanceof AppError && e.code === MEMORY_BUDGET && e.status === 409;

test('T-416: a start one byte over the budget is refused at once with the reason, and nothing is made; at the line it runs', async () => {
  const s = await liveSession();
  try {
    const b = budget(ONE_FITS + 1);
    s.controller.memory = b.memory;
    const [rows, starts] = [s.controller.list().length, s.ws.starts];
    await assert.rejects(s.controller.create({ workspaceId: 'docker/ws1' }), (e: unknown) => {
      assert.ok(isBudget(e), String(e));
      assert.match((e as Error).message, /^Not enough memory in docker\/ws1: 6\.2 of 8\.0 GiB in use, and this session needs about 350 MB with 1\.5 GiB kept free\./);
      return true;
    });
    assert.equal(s.controller.list().length, rows, 'no session row');
    assert.equal(s.ws.starts, starts, 'no process');
    const audit = s.controller.audit({ kind: 'memory.refused' });
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0]!.detail.at, audit[0]!.detail.needBytes, audit[0]!.detail.agents], ['start', SESSION_MEMORY_ESTIMATE_BYTES, 0]);

    b.set(ONE_FITS);
    const made = await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.controller.get(made.id)?.process === 'live');
    assert.equal(s.ws.starts, starts + 1);
  } finally {
    await s.done();
  }
});

test('T-416: an unavailable reading does not block; it is logged once', async () => {
  const s = await liveSession();
  try {
    const b = budget(null);
    s.controller.memory = b.memory;
    const one = await s.controller.create({ workspaceId: 'docker/ws1' });
    b.set(null);
    const two = await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.controller.get(one.id)?.process === 'live' && s.controller.get(two.id)?.process === 'live');
    assert.equal(b.state.reads, 2);
    assert.equal(b.state.logs.length, 1, 'logged once');
    assert.equal(s.controller.audit({ kind: 'memory.refused' }).length, 0);
  } finally {
    await s.done();
  }
});

test('T-416: a launch not running yet counts: the second start in the same window is refused', async () => {
  const s = await liveSession();
  let open!: () => void;
  try {
    s.controller.memory = budget(ONE_FITS).memory;
    s.ws.startGate = new Promise<void>((r) => (open = r)); // the first launch is caught mid-way: not in the reading yet
    const first = await s.controller.create({ workspaceId: 'docker/ws1' });
    await assert.rejects(s.controller.create({ workspaceId: 'docker/ws1' }), isBudget);
    assert.equal(s.controller.audit({ kind: 'memory.refused' })[0]!.detail.pending, 1);
    open();
    await until(() => s.controller.get(first.id)?.process === 'live');
  } finally {
    open?.();
    await s.done();
  }
});

const HASH = 'a'.repeat(64);
const REPO = '/home/node/work/repo';
/** Trust for the repository folder, so a create there (with a worktree) passes the folder checks. */
function trustRepo(s: Awaited<ReturnType<typeof liveSession>>): void {
  s.ws.scanFor = () => JSON.stringify({ hash: HASH, files: ['.claude/settings.json'], invalid: [], mcpServers: [], hooks: [], plugins: [], allowRules: 57, envNames: [], rulesOnly: true, extras: [] });
  new ChatStore(s.store).saveFolderTrust('docker/ws1', REPO, HASH, { files: ['.claude/settings.json'], invalid: [], mcpServers: [], hooks: [], plugins: [], allowRules: 57, envNames: [] }, 'ui');
}

test('T-416: two creates at once with room for exactly one, the first held after its check (a worktree): one starts, the other is refused with the budget reason', async () => {
  const s = await liveSession();
  try {
    trustRepo(s);
    s.controller.memory = budget(ONE_FITS).memory;
    const starts = s.ws.starts;
    // The first passes the check and then waits on its worktree (a macrotask), before it has a row or a granted slot. The second looks
    // meanwhile: without the reservation made in the check's own step it sees nothing pending and both start (fails on d37c5f0).
    const [a, b] = await Promise.allSettled([
      s.controller.create({ workspaceId: 'docker/ws1', cwd: REPO, worktree: { branch: 'dev/t-416-race' } }),
      s.controller.create({ workspaceId: 'docker/ws1', cwd: REPO }),
    ]);
    const made = [a, b].filter((r) => r.status === 'fulfilled');
    const refused = [a, b].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(made.length, 1, 'one succeeds');
    assert.equal(refused.length, 1, 'one is refused');
    assert.ok(isBudget(refused[0]!.reason), String(refused[0]!.reason));
    assert.equal(s.controller.audit({ kind: 'memory.refused' }).length, 1);
    await until(() => s.ws.starts === starts + 1);
    assert.equal(s.ws.starts, starts + 1, 'one process');
  } finally {
    await s.done();
  }
});

test('T-416: a create that throws after its check (the worktree fails) releases its reservation: the next create with room for one runs', async () => {
  const s = await liveSession();
  try {
    trustRepo(s);
    s.controller.memory = budget(ONE_FITS).memory;
    const real = s.ws.wtAdd;
    s.ws.wtAdd = () => ({ code: 1, out: 'no such branch\n' });
    await assert.rejects(s.controller.create({ workspaceId: 'docker/ws1', cwd: REPO, worktree: { branch: 'dev/t-416-leak' } }), (e: unknown) => !isBudget(e));
    s.ws.wtAdd = real;
    const starts = s.ws.starts;
    const made = await s.controller.create({ workspaceId: 'docker/ws1', cwd: REPO });
    await until(() => s.controller.get(made.id)?.process === 'live');
    assert.equal(s.ws.starts, starts + 1);
    assert.equal(s.controller.audit({ kind: 'memory.refused' }).length, 0, 'never refused for a reservation that should be gone');
  } finally {
    await s.done();
  }
});

test('T-416: a launch whose process fails to spawn releases its reservation: the next create with room for one runs', async () => {
  const s = await liveSession();
  try {
    s.controller.memory = budget(ONE_FITS).memory;
    const real = s.ws.exec.bind(s.ws);
    let broken = true;
    let attempts = 0;
    s.ws.exec = async (target: string, name: string, command: string[]) => {
      if (broken && command[2] === 'start') {
        attempts++;
        throw new Error('spawn failed');
      }
      return real(target, name, command);
    };
    await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => attempts === 1);
    await sleep(100); // the launch settles and lets go
    broken = false;
    const made = await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.controller.get(made.id)?.process === 'live');
    assert.equal(s.controller.audit({ kind: 'memory.refused' }).length, 0);
  } finally {
    await s.done();
  }
});

test('T-416: a refused create leaves no reservation behind', async () => {
  const s = await liveSession();
  try {
    s.controller.memory = budget(ONE_FITS + 1).memory;
    await assert.rejects(s.controller.create({ workspaceId: 'docker/ws1' }), isBudget);
    await assert.rejects(s.controller.create({ workspaceId: 'docker/ws1' }), isBudget);
    assert.deepEqual(s.controller.audit({ kind: 'memory.refused' }).map((a) => a.detail.pending), [0, 0]);
  } finally {
    await s.done();
  }
});

test('T-416: a wake counts the sleeping session’s sub-agents: refused with two running, it stays asleep; with none it wakes', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true);
  try {
    await until(() => s.controller.get(s.id)!.process === 'asleep', 4000);
    const db = s.store.db!;
    const at = new Date().toISOString();
    for (const t of ['t-1', 't-2']) db.prepare(`INSERT INTO chat_tasks (session_id, task_id, label, status, started_at) VALUES (?, ?, 'Look around', 'running', ?)`).run(s.id, t, at);
    assert.equal(s.controller.get(s.id)!.agentsRunning, 2);
    // Room for two estimates: the session alone fits, the session with its two sub-agents (three) does not.
    const b = budget(ONE_FITS - SESSION_MEMORY_ESTIMATE_BYTES);
    s.controller.memory = b.memory;
    const starts = s.ws.starts;

    await assert.rejects(s.controller.send(s.id, 'wake-1', 'go on'), isBudget);
    assert.equal(s.controller.get(s.id)!.process, 'asleep', 'still asleep');
    assert.equal(s.ws.starts, starts, 'no process');
    const refused = s.controller.audit({ kind: 'memory.refused', sessionId: s.id })[0]!;
    assert.deepEqual([refused.detail.at, refused.detail.agents, refused.detail.needBytes], ['wake', 2, 3 * SESSION_MEMORY_ESTIMATE_BYTES]);

    db.prepare(`UPDATE chat_tasks SET status = 'completed' WHERE session_id = ?`).run(s.id);
    b.set(ONE_FITS - SESSION_MEMORY_ESTIMATE_BYTES);
    void s.controller.send(s.id, 'wake-2', 'go on').catch(() => undefined);
    await until(() => s.controller.get(s.id)!.process === 'live', 4000);
    assert.equal(s.ws.starts, starts + 1);
  } finally {
    await s.done();
  }
});

/* ---------- T-416 review (comment 6187): each fails without its fix ---------- */

/** A second session in `s`, started and idle (its reader the newest tail). */
async function another(s: Awaited<ReturnType<typeof liveSession>>): Promise<string> {
  const before = s.ws.tails.length;
  const { id } = await s.controller.create({ workspaceId: 'docker/ws1' });
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(id)?.state === 'idle');
  await sleep(20);
  return id;
}

test('T-416 review 1: two wakes at once with room for exactly one: one wakes, the other is refused with the budget reason', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true);
  try {
    const other = await another(s);
    await until(() => s.controller.get(s.id)!.process === 'asleep' && s.controller.get(other)!.process === 'asleep', 4000);
    s.controller.memory = budget(ONE_FITS).memory;
    const starts = s.ws.starts;
    // Both checks share one reading: without the wake's reservation (made in the check's own step) neither sees the other and both wake.
    const outcomes: unknown[] = [];
    for (const [id, uuid] of [
      [s.id, 'wake-a'],
      [other, 'wake-b'],
    ] as const)
      void s.controller.send(id, uuid, 'go on').then(
        () => outcomes.push('ok'),
        (e: unknown) => outcomes.push(e),
      );
    await until(() => outcomes.some(isBudget), 4000);
    await until(() => s.ws.starts === starts + 1, 4000);
    await sleep(200);
    assert.equal(s.ws.starts, starts + 1, 'one process');
    assert.equal([s.id, other].filter((id) => s.controller.get(id)!.process === 'asleep').length, 1, 'the refused one stays asleep');
    const refused = s.controller.audit({ kind: 'memory.refused' });
    assert.deepEqual([refused.length, refused[0]!.detail.at, refused[0]!.detail.pending], [1, 'wake', 1]);
  } finally {
    await s.done();
  }
});

test('T-416 review 2: a launch that settled still counts until a reading late enough to see it; then its hold ends', async () => {
  const s = await liveSession();
  try {
    const b = budget(ONE_FITS);
    s.controller.memory = b.memory;
    const a = await another(s); // launched and settled; the reading (cached, taken before it) cannot see it
    assert.ok(a);
    await sleep(50);
    await assert.rejects(s.controller.create({ workspaceId: 'docker/ws1' }), isBudget);
    assert.equal(s.controller.audit({ kind: 'memory.refused' })[0]!.detail.pending, 1);
    b.set(ONE_FITS); // a reading a minute later: it sees the process, and room for one again
    const c = await s.controller.create({ workspaceId: 'docker/ws1' });
    assert.ok(c.id);
    assert.equal(s.controller.audit({ kind: 'memory.refused' }).length, 1, 'the hold ended with the newer reading');
  } finally {
    await s.done();
  }
});

test('T-416 review 3: a queued start is checked again when its slot comes; while queued it holds nothing', async () => {
  const s = await liveSession();
  try {
    s.controller.setLimits(s.id, { maxWorkers: 3 }, { actor: 'ui' }); // a lead: it never sleeps for the cap
    s.controller.slotPollMs = 100;
    const caps = { perWorkspace: 1, total: 10 };
    s.controller.liveCaps = () => caps;
    const b = budget(ONE_FITS);
    s.controller.memory = b.memory;
    const starts = s.ws.starts;
    const q = await s.controller.create({ workspaceId: 'docker/ws1' });
    assert.ok(q.slotWait, 'q waits for a slot');
    // Room for one, and q is asleep in the queue: r is not refused for q's memory (it queues behind q).
    const r = await s.controller.create({ workspaceId: 'docker/ws1' });
    assert.ok(r.slotWait, 'r waits too, not refused');
    assert.equal(s.controller.audit({ kind: 'memory.refused' }).length, 0);
    // The memory runs out while they wait; then the slots come.
    b.set(ONE_FITS + 1);
    caps.perWorkspace = 10;
    await until(() => [q.id, r.id].every((id) => s.controller.get(id)!.state === 'interrupted'), 4000);
    assert.equal(s.ws.starts, starts, 'no process started');
    for (const id of [q.id, r.id]) assert.match(s.controller.get(id)!.endedReason ?? '', /^Not enough memory in docker\/ws1/);
    assert.deepEqual(
      s.controller.audit({ kind: 'memory.refused' }).map((a) => a.detail.at),
      ['queued', 'queued'],
    );
  } finally {
    await s.done();
  }
});

/* ---------- T-416 review 6310: each fails on 89e270cc ---------- */

const refusedAt = (s: Awaited<ReturnType<typeof liveSession>>) => s.controller.audit({ kind: 'memory.refused' }).map((a) => a.detail.at);

test('T-416 review 6310 #1: a restart of an asleep session is a wake: refused when memory is short (it stays asleep), runs when there is room', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true);
  try {
    await until(() => s.controller.get(s.id)!.process === 'asleep', 4000);
    const b = budget(ONE_FITS + 1);
    s.controller.memory = b.memory;
    const starts = s.ws.starts;
    await assert.rejects(s.controller.restart(s.id), isBudget);
    assert.equal(s.controller.get(s.id)!.process, 'asleep', 'still asleep');
    assert.equal(s.ws.starts, starts, 'no process');
    assert.deepEqual(refusedAt(s), ['restart']);
    b.set(ONE_FITS);
    const restarted = await s.answering(s.controller.restart(s.id));
    assert.equal(restarted.process, 'live');
    assert.equal(s.ws.starts, starts + 1);
  } finally {
    await s.done();
  }
});

test('T-675 R2: a message sent while a restart of an asleep session waits for its memory reading (the in-flight reading is shared, so the send queues behind the restart) is not lost and its process is not stopped by the restart', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true);
  try {
    await until(() => s.controller.get(s.id)!.process === 'asleep', 4000);
    // The reading is held back: the restart (a wake) waits in `#memoryBudget`, the gap the turn can start in.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reads = 0;
    // R2b: ONLY the first reading (the restart's) is held; a second read call would answer at once. What keeps the send behind the restart
    // here is WorkspaceMemory.reading(): a reading already in flight is shared (`#inFlight`), so the send's wake check joins the held one
    // and resumes after the restart's. (`await this.#restarting.get()` in send() is a second guard that this window does not need: removing
    // it leaves this test green, T-675 R2b evidence.) Without the shared reading, the send would start its process while the restart waits,
    // and the restart would then stop it: that mutant turns this test red. No real-clock sleep: the send gets many event-loop turns.
    s.controller.memory = new WorkspaceMemory({ read: async () => (reads++ === 0 && (await gate), reading(2 * GiB)) });
    const [starts, stops] = [s.ws.starts, s.ws.stops];
    const restarting = s.controller.restart(s.id);
    await until(() => reads >= 1, 4000);
    const sent = s.controller.send(s.id, 'gap-1', 'MESSAGE in the gap').then(() => 'sent', (e: unknown) => `rejected: ${String(e)}`);
    // Answering starts BEFORE the release: a launch asks for the settings, so a send that got ahead could finish its start in this window.
    const answered = s.answering(Promise.all([restarting, sent]));
    // Wait for the event that shows the send got ahead (its process started while the restart is held); with the guards in place it never
    // comes, so the wait is capped. It ends at once when it does, which is why this does not depend on a sleep being long enough.
    await until(() => s.ws.starts > starts, 400).catch(() => undefined);
    release();
    const [restarted, outcome] = await answered;
    assert.equal(outcome, 'sent');
    assert.equal(restarted.process, 'live');
    assert.equal(s.controller.get(s.id)!.state === 'ended', false, 'the session was not ended');
    assert.equal(s.ws.stops, stops, 'no process was stopped: the message did not start a process the restart then killed');
    assert.equal(s.ws.starts, starts + 1, 'one process, the restart’s');
    const line = s.ws.sends.find((x) => x.line.includes('MESSAGE in the gap'));
    assert.ok(line, 'the message reached a process');
    assert.equal(line.args[1], s.controller.get(s.id)!.claudeSessionId, 'the process that is live now');
  } finally {
    await s.done();
  }
});

test('T-416 review 6310 #1: a restart of a gone (interrupted) session is a wake: refused when memory is short, nothing started', async () => {
  const s = await liveSession();
  try {
    await firstTurn(s);
    await vanish(s);
    assert.equal(s.controller.get(s.id)!.process, 'gone');
    const b = budget(ONE_FITS + 1);
    s.controller.memory = b.memory;
    const starts = s.ws.starts;
    await assert.rejects(s.controller.restart(s.id), isBudget);
    assert.deepEqual([s.controller.get(s.id)!.state, s.controller.get(s.id)!.process], ['interrupted', 'gone']);
    assert.equal(s.ws.starts, starts, 'no process');
    assert.deepEqual(refusedAt(s), ['restart']);
    b.set(ONE_FITS);
    const restarted = await s.answering(s.controller.restart(s.id));
    assert.equal(restarted.process, 'live');
  } finally {
    await s.done();
  }
});

/** Counts the budget checks (a start's, a wake's, a restart's): the liveness round's looks pass a max age and are not counted. */
class CountedMemory extends WorkspaceMemory {
  checks = 0;
  override async reading(workspaceId: string, maxAgeMs?: number) {
    if (maxAgeMs === undefined) this.checks++;
    return super.reading(workspaceId, maxAgeMs);
  }
}

test('T-416 review 6310 #3: a send while a queued start checks the memory waits for that start: no second check, one launch', async () => {
  const s = await liveSession();
  let open: () => void = () => undefined;
  try {
    s.controller.setLimits(s.id, { maxWorkers: 3 }, { actor: 'ui' }); // a lead: it never sleeps for the cap
    s.controller.slotPollMs = 20;
    const caps = { perWorkspace: 1, total: 10 };
    s.controller.liveCaps = () => caps;
    const st = { clock: 1_000_000, gate: null as Promise<void> | null };
    const memory = new CountedMemory({
      read: async () => {
        if (st.gate) await st.gate;
        return reading(ONE_FITS - SESSION_MEMORY_ESTIMATE_BYTES, st.clock);
      },
      now: () => st.clock,
    });
    s.controller.memory = memory;
    const q = await s.controller.create({ workspaceId: 'docker/ws1' });
    assert.ok(q.slotWait, 'q waits for a slot');
    const checks = memory.checks; // the create's
    const starts = s.ws.starts;
    st.gate = new Promise<void>((r) => (open = r)); // the queued check's reading is held
    st.clock += 60_000;
    caps.perWorkspace = 10; // the slot comes
    await until(() => memory.checks === checks + 1, 4000);
    void s.controller.send(q.id, 'q-1', 'go on').catch(() => undefined);
    await sleep(150);
    assert.equal(memory.checks, checks + 1, 'the send waits for the queued start: it runs no check of its own');
    open();
    await until(() => s.controller.get(q.id)!.process === 'live', 4000);
    await sleep(100);
    assert.equal(memory.checks, checks + 1, 'one check for the queued start');
    assert.equal(s.ws.starts, starts + 1, 'one launch');
  } finally {
    open();
    await s.done();
  }
});

/* ---------- T-416 QA 6326: the mutants that survived (M2, M3, M9, M10) ---------- */

/** Makes every process start in `s` fail while `state.broken`; counts the tries. */
function failingStarts(s: Awaited<ReturnType<typeof liveSession>>) {
  const state = { broken: true, attempts: 0 };
  const real = s.ws.exec.bind(s.ws);
  s.ws.exec = async (target: string, name: string, command: string[]) => {
    if (state.broken && command[2] === 'start') {
      state.attempts++;
      throw new Error('spawn failed');
    }
    return real(target, name, command);
  };
  return state;
}

/** The lead `s` (a workers limit, so it never sleeps for the cap) alone at a cap of 1 per workspace: a create waits for a slot. */
function queueing(s: Awaited<ReturnType<typeof liveSession>>) {
  s.controller.setLimits(s.id, { maxWorkers: 3 }, { actor: 'ui' });
  s.controller.slotPollMs = 20;
  const caps = { perWorkspace: 1, total: 10 };
  s.controller.liveCaps = () => caps;
  return caps;
}

test('T-416 QA M2: a wake whose launch fails lets its memory go: a create with room for exactly one runs after it', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true);
  try {
    await until(() => s.controller.get(s.id)!.process === 'asleep', 4000);
    s.controller.memory = budget(ONE_FITS).memory;
    const fail = failingStarts(s);
    await s.controller.send(s.id, 'wake-fail', 'go on').catch(() => undefined);
    await until(() => fail.attempts >= 1, 4000);
    await sleep(100); // the wake settles
    fail.broken = false;
    const made = await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.controller.get(made.id)?.process === 'live', 4000);
    assert.equal(s.controller.audit({ kind: 'memory.refused' }).length, 0, 'no hold left behind by the failed wake');
  } finally {
    await s.done();
  }
});

test('T-416 QA M3: a queued start whose launch fails lets its memory go: a create with room for exactly one runs after it', async () => {
  const s = await liveSession();
  try {
    const caps = queueing(s);
    s.controller.memory = budget(ONE_FITS).memory;
    const fail = failingStarts(s);
    const q = await s.controller.create({ workspaceId: 'docker/ws1' });
    assert.ok(q.slotWait, 'q waits for a slot');
    caps.perWorkspace = 10; // the slot comes; the launch fails
    await until(() => fail.attempts >= 1, 4000);
    await sleep(100); // the queued start settles
    fail.broken = false;
    const made = await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.controller.get(made.id)?.process === 'live', 4000);
    assert.equal(s.controller.audit({ kind: 'memory.refused' }).length, 0, 'no hold left behind by the failed queued start');
  } finally {
    await s.done();
  }
});

test('T-416 QA M9: a queued start with room for exactly one runs when its slot comes: its own granted slot is not counted again', async () => {
  const s = await liveSession();
  try {
    const caps = queueing(s);
    s.controller.memory = budget(ONE_FITS).memory;
    const starts = s.ws.starts;
    const q = await s.controller.create({ workspaceId: 'docker/ws1' });
    assert.ok(q.slotWait, 'q waits for a slot');
    caps.perWorkspace = 10;
    await until(() => s.controller.get(q.id)!.process === 'live' || s.controller.get(q.id)!.state === 'interrupted', 4000);
    assert.equal(s.controller.get(q.id)!.process, 'live', s.controller.get(q.id)!.endedReason ?? '');
    assert.equal(s.ws.starts, starts + 1);
    assert.equal(s.controller.audit({ kind: 'memory.refused' }).length, 0);
  } finally {
    await s.done();
  }
});

test('T-416 QA M10: a queued start refused for memory gives its slot back: the next create starts at once when there is room', async () => {
  const s = await liveSession();
  try {
    const caps = queueing(s);
    const b = budget(ONE_FITS);
    s.controller.memory = b.memory;
    const q = await s.controller.create({ workspaceId: 'docker/ws1' });
    assert.ok(q.slotWait, 'q waits for a slot');
    b.set(ONE_FITS + 1);
    caps.perWorkspace = 2; // room for the lead and one more
    await until(() => s.controller.get(q.id)!.state === 'interrupted', 4000);
    b.set(ONE_FITS);
    const r = await s.controller.create({ workspaceId: 'docker/ws1' });
    assert.equal(r.slotWait ?? null, null, 'r does not wait behind a slot q no longer uses');
    await until(() => s.controller.get(r.id)?.process === 'live', 4000);
    assert.deepEqual(
      s.controller.audit({ kind: 'memory.refused' }).map((a) => a.detail.at),
      ['queued'],
    );
  } finally {
    await s.done();
  }
});

test('T-416: the liveness round reads the memory of the workspaces it runs sessions in and raises the 85 percent alert', async () => {
  const s = await liveSession({ livenessMs: 50 }, true);
  try {
    const b = budget(Math.round(0.9 * LIMIT));
    s.controller.memory = b.memory;
    await until(() => b.memory.alerts().length === 1, 3000);
    assert.equal(b.memory.alerts()[0]!.workspaceId, 'docker/ws1');
    await sleep(200);
    assert.equal(b.state.reads, 1, 'at most once a minute per workspace');
  } finally {
    await s.done();
  }
});

/* ---------- T-675: the wake's audit names who woke it; a restart's hold ends when #live skips ---------- */

test('T-675: a wake refused for memory names the actor whose message (or Resume) woke the session; a person’s message is `ui`', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true);
  try {
    await until(() => s.controller.get(s.id)!.process === 'asleep', 4000);
    s.controller.memory = budget(ONE_FITS + 1).memory;
    await assert.rejects(s.controller.send(s.id, 'w-1', 'wake up', { actor: 'ticket:T-12' }), isBudget);
    await assert.rejects(s.controller.send(s.id, 'w-2', 'wake up', { actor: 'ui' }), isBudget);
    await assert.rejects(s.controller.send(s.id, 'w-3', 'wake up'), isBudget);
    await assert.rejects(s.controller.control(s.id, 'resume', undefined, { actor: 'portal-mcp:ptk_1' }), isBudget);
    await assert.rejects(s.controller.control(s.id, 'resume'), isBudget);
    const actors = s.controller.audit({ kind: 'memory.refused', sessionId: s.id }).map((a) => a.actor);
    assert.deepEqual([...actors].sort(), ['portal-mcp:ptk_1', 'ticket:T-12', 'ui', 'ui', 'ui']);
  } finally {
    await s.done();
  }
});

test('T-675 (T-416 QA R2): a restart of an asleep session whose check passed but whose launch #live skipped lets its hold go', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true);
  try {
    await until(() => s.controller.get(s.id)!.process === 'asleep', 4000);
    // The session ends while the restart's reading is taken: the check passes and holds, then the stop and #live find an ended row and
    // do nothing, so only the restart's own `finally` lets the hold go.
    const chat = new ChatStore(s.store);
    const clock = 1_000_000;
    s.controller.memory = new WorkspaceMemory({
      read: async () => {
        chat.patchSession(s.id, { state: 'ended' });
        return reading(ONE_FITS, clock);
      },
      now: () => clock + 60_000,
    });
    await s.controller.restart(s.id).catch(() => undefined);
    assert.equal(s.controller.get(s.id)!.state, 'ended');
    // Room for exactly one: a create fits only when nothing is still held for the ended session.
    s.controller.memory = budget(ONE_FITS).memory;
    const made = await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.controller.get(made.id)?.process === 'live', 4000);
    assert.equal(s.controller.audit({ kind: 'memory.refused' }).length, 0, 'no hold left behind');
    await sleep(300); // the ended session's own follow-up work settles before the store closes
  } finally {
    await s.done();
  }
});
