// T-921: a refused signal never kills the init, and Chrome that does not start with headers is started again without them.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { test } from 'node:test';
import { guardSignals, safeKill, startWithHeal } from './heal.mjs';

const errno = (code) => Object.assign(new Error(`kill ${code}`), { code, syscall: 'kill' });
const collector = () => {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(' ')) };
};

test('safeKill: EPERM and ESRCH are logged, never thrown', () => {
  for (const code of ['EPERM', 'ESRCH']) {
    const { lines, log } = collector();
    const child = { pid: 42, kill: () => { throw errno(code); } };
    assert.equal(safeKill(child, 'SIGKILL', { log }), false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`SIGKILL of pid 42 failed \\(${code}\\)`));
  }
});

test('safeKill: any other error is logged too, and the helper runs as Chrome only for EPERM', () => {
  const { lines, log } = collector();
  const calls = [];
  const asChrome = (pid, sig) => (calls.push([pid, sig]), true);
  assert.equal(safeKill({ pid: 7, kill: () => { throw errno('EIO'); } }, 'SIGTERM', { log, asChrome }), false);
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 1);
  assert.equal(safeKill({ pid: 7, kill: () => { throw errno('EPERM'); } }, 'SIGTERM', { log, asChrome }), true);
  assert.deepEqual(calls, [[7, 'SIGTERM']]);
});

test('safeKill: a helper that throws is logged; a delivered signal is true', () => {
  const { lines, log } = collector();
  const child = { pid: 9, kill: () => { throw errno('EPERM'); } };
  assert.equal(safeKill(child, 'SIGKILL', { log, asChrome: () => { throw new Error('no helper'); } }), false);
  assert.ok(lines.some((l) => /through the helper failed/.test(l)));
  assert.equal(safeKill({ pid: 1, kill: () => true }, 'SIGTERM', { log }), true);
  assert.equal(safeKill({ pid: 1, kill: () => false }, 'SIGTERM', { log }), false);
});

// The real mechanism (T-921): Node's ChildProcess.kill does not throw EPERM, it emits 'error'. A real child whose handle refuses the
// signal, as the init's kill of uid 1000 without CAP_KILL is refused in the Kubernetes container.
const { errno: E } = os.constants;
function refusingChild() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      child.removeListener('error', reject); // the test decides which listeners the child has
      child._handle.kill = () => -E.EPERM; // libuv's error number, as uv_process_kill returns it
      resolve(child);
    });
  });
}
const reap = (child) => {
  delete child._handle?.kill;
  child.kill('SIGKILL');
};

test('T-921 reproduction: a refused kill with no error listener throws out of kill(), so a timer that calls it ends the process', async () => {
  const child = await refusingChild();
  try {
    assert.equal(child.listenerCount('error'), 0);
    assert.throws(() => child.kill('SIGKILL'), (e) => e.code === 'EPERM' && e.syscall === 'kill');
  } finally {
    reap(child);
  }
});

test('guardSignals: a refused kill (twice, as stop and its 5 s backstop) is logged and sent again as Chrome; the caller never throws', async () => {
  const child = await refusingChild();
  try {
    const { lines, log } = collector();
    const helper = [];
    const others = [];
    guardSignals(child, { name: 'chrome', log, asChrome: (pid, sig) => (helper.push([pid, sig]), true), onError: (e) => others.push(e) });
    assert.equal(safeKill(child, 'SIGTERM', { log }), false);
    assert.equal(safeKill(child, 'SIGKILL', { log }), false);
    assert.deepEqual(helper, [[child.pid, 'SIGTERM'], [child.pid, 'SIGKILL']]);
    assert.deepEqual(lines, ['signal SIGTERM to chrome refused (EPERM)', 'signal SIGKILL to chrome refused (EPERM)']);
    assert.deepEqual(others, [], 'a signal error is not a failed start');
  } finally {
    reap(child);
  }
});

test('guardSignals: a helper that fails or does not deliver is logged; with no helper the error is only logged', async () => {
  const child = await refusingChild();
  try {
    const { lines, log } = collector();
    guardSignals(child, { name: 'chrome', log, asChrome: () => false });
    safeKill(child, 'SIGKILL', { log });
    assert.ok(lines.includes('signal SIGKILL to chrome through the helper not delivered'));
    const second = await refusingChild();
    try {
      const out = collector();
      guardSignals(second, { name: 'supervisor', log: out.log });
      assert.doesNotThrow(() => second.kill('SIGTERM'));
      assert.deepEqual(out.lines, ['signal SIGTERM to supervisor refused (EPERM)']);
      const thrower = collector();
      const third = await refusingChild();
      try {
        guardSignals(third, { name: 'chrome', log: thrower.log, asChrome: () => { throw new Error('helper gone'); } });
        assert.doesNotThrow(() => safeKill(third, 'SIGKILL'));
        assert.match(thrower.lines.at(-1), /through the helper failed: helper gone/);
      } finally {
        reap(third);
      }
    } finally {
      reap(second);
    }
  } finally {
    reap(child);
  }
});

test('guardSignals: a spawn error is not a signal error: it goes to onError (the start fails)', async () => {
  const child = spawn(`/nonexistent-${randomBytes(4).toString('hex')}/chromium`, [], { stdio: 'ignore' });
  const { lines, log } = collector();
  const got = await new Promise((resolve) => guardSignals(child, { name: 'chrome', log, onError: resolve }));
  assert.equal(got.code, 'ENOENT');
  assert.deepEqual(lines, []);
});

/** A fake Chrome: never answers when it was started with headers (the extension), answers otherwise. */
function fakeChrome({ answersWithHeaders = false, answersWithout = true } = {}) {
  const log = [];
  return {
    log,
    start: async ({ headers }) => (log.push(`start headers=${headers}`), { pid: 100 + log.length, headers }),
    waitReady: async (s) => {
      if (s.headers ? !answersWithHeaders : !answersWithout) throw new Error('no CDP');
    },
    stop: async () => void log.push('stop'),
  };
}

test('startWithHeal: no CDP with headers, the second start without them answers, and it says degraded', async () => {
  const f = fakeChrome();
  const { lines, log } = collector();
  const state = { degradedAt: 0 };
  const r = await startWithHeal({ ...f, state, log, now: () => 1000 });
  assert.equal(r.headers, 'degraded');
  assert.deepEqual(f.log, ['start headers=true', 'stop', 'start headers=false']);
  assert.equal(state.degradedAt, 1000);
  assert.deepEqual(lines, ['headers disabled: Chrome did not start with them']);
});

test('startWithHeal: the next wake inside the cooldown skips the headers, after it they are tried again', async () => {
  const state = { degradedAt: 1000 };
  const f = fakeChrome();
  const inside = await startWithHeal({ ...f, state, now: () => 1000 + 60_000, cooldownMs: 10 * 60_000 });
  assert.equal(inside.headers, 'degraded');
  assert.deepEqual(f.log, ['start headers=false']);

  const g = fakeChrome({ answersWithHeaders: true });
  const after = await startWithHeal({ ...g, state, now: () => 1000 + 11 * 60_000, cooldownMs: 10 * 60_000 });
  assert.equal(after.headers, 'on');
  assert.deepEqual(g.log, ['start headers=true']);
  assert.equal(state.degradedAt, 0);
});

test('startWithHeal: headers working is "on"; no headers configured is "off" and never retried', async () => {
  const ok = fakeChrome({ answersWithHeaders: true });
  assert.equal((await startWithHeal({ ...ok, state: { degradedAt: 0 } })).headers, 'on');

  const none = { log: [], start: async () => ({ pid: 1, headers: false }), waitReady: async () => { throw new Error('no CDP'); }, stop: async () => {} };
  await assert.rejects(startWithHeal({ ...none, state: { degradedAt: 0 } }), /no CDP/);
});

test('startWithHeal: when the second start fails too, it throws', async () => {
  const f = fakeChrome({ answersWithout: false });
  await assert.rejects(startWithHeal({ ...f, state: { degradedAt: 0 } }), /no CDP/);
  assert.deepEqual(f.log, ['start headers=true', 'stop', 'start headers=false']);
});

test('no header value reaches a log line, a result or an error', async () => {
  // Fixtures built at runtime: the values exist only in this closure, as the init holds them only in its own memory.
  const idValue = randomBytes(16).toString('hex');
  const secretValue = randomBytes(24).toString('hex');
  const { lines, log } = collector();
  const f = fakeChrome();
  const start = async (o) => {
    const s = await f.start(o);
    return o.headers ? { ...s, rules: [{ name: 'x-id', value: idValue }, { name: 'x-secret', value: secretValue }] } : s;
  };
  const r = await startWithHeal({ ...f, start, state: { degradedAt: 0 }, log });
  const printed = JSON.stringify({ lines, r: { headers: r.headers, pid: r.started.pid }, f: f.log });
  assert.ok(!printed.includes(idValue) && !printed.includes(secretValue));

  const e = await startWithHeal({ ...fakeChrome({ answersWithout: false }), start, state: { degradedAt: 0 }, log }).catch((x) => x);
  assert.ok(!String(e.message).includes(idValue) && !String(e.message).includes(secretValue));
  assert.ok(!lines.join('\n').includes(idValue));
});
