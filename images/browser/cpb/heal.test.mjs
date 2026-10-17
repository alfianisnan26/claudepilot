// T-921: a refused signal never kills the init, and Chrome that does not start with headers is started again without them.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { safeKill, startWithHeal } from './heal.mjs';

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
