// T-416 (D-61): the portal enforces a memory budget per workspace. A start or a wake that would leave less than 1.5 GiB free (anon +
// active_file + the session's estimate, one more per Agent-tool sub-agent, one more per launch not running yet) is refused at once with a
// readable reason and nothing is made; below it, it runs. An unavailable reading never blocks. The liveness round raises the 85% alert.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import { parseMemoryProbe, type MemoryReading } from '../workspaces/memory.js';
import { MEMORY_BUDGET, MEMORY_HEADROOM_BYTES, SESSION_MEMORY_ESTIMATE_BYTES, WorkspaceMemory } from './memory.js';
import { ChatStore } from './store.js';
import { liveSession, sleep, until } from './testkit.js';

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
