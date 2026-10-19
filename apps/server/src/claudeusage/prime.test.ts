// T-1707: the usage prime. A signed-in Claude that reads 0 % with no reset time gets one tiny request (Haiku, no tools, "ok") and a probe right
// after, at most once per `claude.usage.primeMin` minutes, never while a session runs on it, never for a signed-out Claude, and not at all
// when the setting is 0. A refusal for a plan limit makes it used up until the reset it states. The command, the run, and the service.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLine } from '../chat/protocol.js';
import { claude, HOUR, MIN, NOW, planResult, ScriptedExec, usageHarness, win } from './fixtures.js';
import { PRIME_INPUT, PRIME_MODEL, primeCommand, runPrime, type PrimeOutcome } from './prime.js';
import type { ProbeResult } from './probe.js';
import type { SourceClaude } from './service.js';
import { usageSource } from './source.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const INTERVAL = 600_000;
const reset5h = NOW + 4 * HOUR;
const BLIND = (): ProbeResult => planResult([win('session', 0, null, 'Session'), win('week', 0, null, 'Week')]);
const OPEN = (): ProbeResult => planResult([win('session', 1, reset5h, 'Session'), win('week', 20, NOW + 3 * 24 * HOUR, 'Week')]);

/** A `<synthetic>` limit line as Claude Code streams it (shape from this pod's streams, text made up here). */
const limitLine = (text: string, atMs: number) =>
  JSON.stringify({ type: 'assistant', message: { id: 'm1', model: '<synthetic>', role: 'assistant', type: 'message', content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 } }, parent_tool_use_id: null, session_id: 'x', uuid: 'u1', timestamp: new Date(atMs).toISOString(), error: 'rate_limit', is_api_error_message: true });
const resultLine = (ok: boolean) => JSON.stringify({ type: 'result', subtype: 'success', is_error: !ok, result: ok ? 'ok' : 'x', total_cost_usd: 0 });

/* ---------- The command and the run ---------- */

test('the prime: the cheapest model, no tools, safe mode, no session written, a strict timeout, as the Claude', () => {
  const cmd = primeCommand('claudes/0123456789abcdef');
  assert.equal(cmd[4], 'claudes/0123456789abcdef', 'the Claude’s directory is $1, never parsed by the shell');
  const run = cmd.slice(5);
  assert.equal(run[run.indexOf('--model') + 1], PRIME_MODEL);
  assert.equal(PRIME_MODEL, 'haiku');
  assert.equal(run[run.indexOf('--tools') + 1], '', 'every tool off');
  for (const f of ['--safe-mode', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '-p']) assert.ok(run.includes(f), f);
  assert.equal(run[run.indexOf('timeout') + 1], '40');
  assert.ok(run.includes('ENABLE_CLAUDEAI_MCP_SERVERS=false'));
  assert.throws(() => primeCommand('../elsewhere'));
  assert.deepEqual(JSON.parse(PRIME_INPUT), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'ok' }] } });
});

test('runPrime: answered is ok; Claude Code’s limit line is a refusal with its reset; nothing else of the output is kept', async () => {
  const io = (react: (s: ScriptedExec) => void) => ({ exec: async () => new ScriptedExec((s) => react(s)) });
  assert.deepEqual(await runPrime(io((s) => s.emit(`{"type":"system","subtype":"init"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n${resultLine(true)}\n`)), 'docker', 'ws1', ''), { outcome: 'ok' });
  const limited = await runPrime(io((s) => s.emit(`${limitLine("You've hit your session limit · resets 11pm (UTC)", NOW)}\n${resultLine(false)}\n`)), 'docker', 'ws1', '');
  assert.equal(limited.outcome, 'limited');
  assert.equal((limited as Extract<PrimeOutcome, { outcome: 'limited' }>).info.resetsAt, Date.parse('2026-10-12T23:00:00Z') / 1000);
  // A plain API failure is no refusal.
  assert.deepEqual(await runPrime(io((s) => s.emit(`${resultLine(false)}\n`)), 'docker', 'ws1', ''), { outcome: 'failed', why: 'error' });
  // Exit without a result, and a hang the portal's own limit ends.
  assert.deepEqual(await runPrime(io((s) => s.end(127)), 'docker', 'ws1', ''), { outcome: 'failed', why: 'not_installed' });
  let hung: ScriptedExec | null = null;
  const timedOut = await runPrime({ exec: async () => (hung = new ScriptedExec()), hardMs: 20 }, 'docker', 'ws1', '');
  assert.deepEqual(timedOut, { outcome: 'failed', why: 'timeout' });
  assert.equal((hung as ScriptedExec | null)?.closed, true, 'the run is closed');
  assert.deepEqual(await runPrime({ exec: async () => Promise.reject(new Error('down')) }, 'docker', 'ws1', ''), { outcome: 'failed', why: 'error' });
});

/* ---------- The service ---------- */

/** A probe that answers from a list (the last one repeats) and counts its calls. */
function probes(...answers: (() => ProbeResult)[]) {
  let n = 0;
  return {
    calls: () => n,
    probe: (async () => answers[Math.min(n++, answers.length - 1)]!()) as never,
  };
}

function primes(outcome: () => PrimeOutcome) {
  const calls: string[] = [];
  return { calls, prime: (async (c: SourceClaude) => (calls.push(c.id), outcome())) as never };
}

test('a Claude reading 0 % with no reset time is primed once, then probed again; not again inside the window, again after it', async () => {
  const p = probes(BLIND);
  const pr = primes(() => ({ outcome: 'ok' }));
  const audit: { kind: string; subject?: string | null; detail?: Record<string, unknown> }[] = [];
  const h = await usageHarness({ probe: p.probe, prime: pr.prime, primeMin: () => 30, audit: (e) => audit.push(e) });
  try {
    await h.usage.tick();
    await sleep(5);
    assert.deepEqual(pr.calls, ['c1']);
    assert.equal(p.calls(), 2, 'a success is followed by a probe');
    assert.deepEqual(audit, [{ kind: 'claude.usage.prime', actor: 'system', userId: null, subject: 'c1', detail: { claudeId: 'c1', workspaceId: 'docker/ws1', outcome: 'ok' } }]);
    // The next probe (the interval later) still reads no reset time: inside the 30 minutes, no prime.
    h.clock.t += INTERVAL + MIN;
    await h.usage.tick();
    await sleep(5);
    assert.equal(p.calls(), 3);
    assert.equal(pr.calls.length, 1);
    h.clock.t += INTERVAL + MIN;
    await h.usage.tick();
    await sleep(5);
    assert.equal(pr.calls.length, 1, '22 minutes after: still none');
    h.clock.t += INTERVAL + MIN;
    await h.usage.tick();
    await sleep(5);
    assert.equal(pr.calls.length, 2, '33 minutes after: one more');
    assert.equal(audit.length, 2);
  } finally {
    h.done();
  }
});

test('a success: the probe right after reads the window open, so the Claude is measured', async () => {
  const p = probes(BLIND, OPEN);
  const pr = primes(() => ({ outcome: 'ok' }));
  const h = await usageHarness({ probe: p.probe, prime: pr.prime, primeMin: () => 30 });
  try {
    await h.usage.tick();
    await sleep(5);
    assert.equal(p.calls(), 2);
    const c = (await h.usage.report()).claudes[0]!;
    assert.equal(c.unavailable, null);
    assert.equal(c.state, 'ok');
    assert.equal(c.windows.find((w) => w.key === 'session')?.resetsAt, new Date(reset5h).toISOString());
  } finally {
    h.done();
  }
});

test('a limit refusal: the Claude is used up until the reset the error states; a probe still reading 0 % changes nothing', async () => {
  const p = probes(BLIND);
  const info = parseLine(limitLine("You've hit your session limit · resets 11pm (UTC)", NOW)).rateLimitInfo as Record<string, unknown>;
  const pr = primes(() => ({ outcome: 'limited', info }));
  const audit: { detail?: Record<string, unknown> }[] = [];
  const h = await usageHarness({ probe: p.probe, prime: pr.prime, primeMin: () => 30, audit: (e) => audit.push(e) });
  try {
    await h.usage.tick();
    await sleep(5);
    assert.equal(p.calls(), 1, 'a refusal is the answer: no probe after it');
    let c = (await h.usage.report()).claudes[0]!;
    assert.equal(c.state, 'exhausted');
    assert.equal(c.unavailable, null, 'measured: used up');
    assert.deepEqual(c.limitReport, { window: 'session', label: 'Session', at: new Date(NOW).toISOString(), until: '2026-10-12T23:00:00.000Z', guessed: false, sessionId: null });
    assert.equal(h.usage.headroom('c1').exhausted, true);
    assert.deepEqual(audit[0]?.detail, { claudeId: 'c1', workspaceId: 'docker/ws1', outcome: 'limited', until: '2026-10-12T23:00:00.000Z' });
    h.clock.t += INTERVAL + MIN;
    await h.usage.tick();
    await sleep(5);
    c = (await h.usage.report()).claudes[0]!;
    assert.equal(c.state, 'exhausted');
    assert.equal(pr.calls.length, 1, 'used up is known: no prime');
  } finally {
    h.done();
  }
});

test('a limit refusal with no reset time: used up until the next 5-hour boundary, said as guessed', async () => {
  const pr = primes(() => ({ outcome: 'limited', info: { status: 'rejected', rateLimitType: 'five_hour' } }));
  const h = await usageHarness({ probe: probes(BLIND).probe, prime: pr.prime, primeMin: () => 30 });
  try {
    await h.usage.tick();
    await sleep(5);
    const c = (await h.usage.report()).claudes[0]!;
    assert.equal(c.state, 'exhausted');
    assert.equal(c.limitReport?.until, new Date(NOW + 5 * HOUR).toISOString());
    assert.equal(c.limitReport?.guessed, true);
  } finally {
    h.done();
  }
});

test('no prime: while a session runs on the Claude, when it is signed out, when the setting is 0, for a measured reading, or a workspace that stopped', async () => {
  const cases: { why: string; probe: () => ProbeResult; min?: number; setup?: (h: Awaited<ReturnType<typeof usageHarness>>) => void; stop?: boolean }[] = [
    { why: 'a live session', probe: BLIND, setup: (h) => h.source.live.add('c1') },
    { why: 'signed out', probe: () => ({ runsOn: 'none', plan: null, windows: [], extra: null, problem: null, failed: false }) },
    { why: 'setting 0', probe: BLIND, min: 0 },
    { why: 'measured', probe: OPEN },
    { why: 'a failed probe', probe: () => ({ ...BLIND(), failed: true, problem: 'timeout' }) },
    { why: 'stopped meanwhile', probe: BLIND, stop: true },
  ];
  for (const k of cases) {
    const pr = primes(() => ({ outcome: 'ok' }));
    const probe = (async (c: SourceClaude) => {
      if (k.stop) c.running = false;
      return k.probe();
    }) as never;
    const h = await usageHarness({ probe, prime: pr.prime, primeMin: () => k.min ?? 30 });
    try {
      k.setup?.(h);
      await h.usage.tick();
      await sleep(5);
      assert.deepEqual(pr.calls, [], k.why);
    } finally {
      h.done();
    }
  }
});

test('a probe that failed primes nothing, even when the last reading kept is 0 % with no reset time', async () => {
  let min = 0;
  const pr = primes(() => ({ outcome: 'ok' }));
  const h = await usageHarness({ probe: probes(BLIND, () => ({ ...BLIND(), windows: [], failed: true, problem: 'timeout' })).probe, prime: pr.prime, primeMin: () => min });
  try {
    await h.usage.tick();
    await sleep(5);
    assert.equal((await h.usage.report()).claudes[0]!.unavailable, 'no_reset_time');
    min = 30;
    h.clock.t += INTERVAL + MIN;
    await h.usage.tick();
    await sleep(5);
    assert.equal((await h.usage.report()).claudes[0]!.unavailable, 'no_reset_time', 'the failure kept the last numbers');
    assert.deepEqual(pr.calls, []);
  } finally {
    h.done();
  }
});

test('Check now never primes (it answers at once); the background pass does', async () => {
  const pr = primes(() => ({ outcome: 'ok' }));
  const h = await usageHarness({ probe: probes(BLIND).probe, prime: pr.prime, primeMin: () => 30 });
  try {
    await h.usage.check('c1');
    assert.equal(pr.calls.length, 0);
  } finally {
    h.done();
  }
});

test('the source: a session is on a Claude while its process is live (a session with no Claude id runs in Default)', () => {
  const sessions = [
    { claudeId: 'c2', state: 'idle', process: 'live' },
    { claudeId: '', state: 'working', process: 'live' },
    { claudeId: 'c3', state: 'ended', process: 'gone' },
    { claudeId: 'c4', state: 'idle', process: 'asleep' },
  ];
  const src = usageSource({ list: async () => [], exec: async () => new ScriptedExec() } as never, { listClaudes: () => [], get: () => null, list: () => sessions }, () => false);
  const at = (id: string, directory = 'claudes/0123456789abcdef') => src.sessionOn({ ...claude({ id }), directory });
  assert.equal(at('c2'), true);
  assert.equal(at('c3'), false, 'ended');
  assert.equal(at('c4'), false, 'asleep: no process');
  assert.equal(at('c9'), false);
  assert.equal(at('default', ''), true, 'Default: the session with no Claude id');
});
