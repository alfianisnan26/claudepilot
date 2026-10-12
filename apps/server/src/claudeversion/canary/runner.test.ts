// One canary run (docs/prd/claude-version-pinning.md §11): one throwaway container, always removed; a scratch install gets a network only while
// it installs; a check that throws, hangs or is cancelled is reported, never lost; the output is redacted and clipped.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_CANARY_CHECKS } from '@portal/contracts';
import type { Throwaway, ThrowawayAccess } from '../../workspaces/runtime.js';
import { CheckFailed } from './box.js';
import { clipDetail, DETAIL_MAX, runCanary, runOne } from './runner.js';
import type { CanaryCheck, CheckContext } from './support.js';

interface Calls {
  started: { image: string; network: string }[];
  removed: string[];
  isolated: string[];
  runs: string[];
}

/** A throwaway container that answers like a healthy one: the stand-in comes up, `claude --version` says what the test wants. */
function fake(o: { startFails?: boolean; versionOut?: string; installOut?: string } = {}) {
  const calls: Calls = { started: [], removed: [], isolated: [], runs: [] };
  const t: ThrowawayAccess = {
    start: async (spec): Promise<Throwaway> => {
      if (o.startFails) throw new Error('no Docker');
      calls.started.push({ image: spec.image, network: spec.network });
      return { name: 'vc-canary-fake' };
    },
    run: async (_n, script) => {
      calls.runs.push(script.split('\n').slice(-1)[0] ?? '');
      if (/npm install/.test(script)) return { code: 0, stdout: o.installOut ?? 'added 1 package', stderr: '' };
      if (/--version/.test(script)) return { code: 0, stdout: o.versionOut ?? '2.1.300 (Claude Code)\n', stderr: '' };
      if (/ready\.json/.test(script)) return { code: 0, stdout: '{"proxy":"http://127.0.0.1:1","http":"http://127.0.0.1:2","ca":"/tmp/ca.pem"}\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    put: async () => undefined,
    read: async () => null,
    exec: async () => ({ write: () => undefined, close: () => undefined, onData: () => undefined, onExit: () => undefined }),
    shell: async () => ({ write: () => undefined, resize: () => undefined, close: () => undefined, onData: () => undefined, onExit: () => undefined }),
    isolate: async (n) => void calls.isolated.push(n),
    remove: async (n) => void calls.removed.push(n),
    leftovers: async () => [],
  };
  return { t, calls };
}

const def = (id: string) => ({ ...CLAUDE_CANARY_CHECKS[0]!, id, label: id });
const check = (id: string, run: CanaryCheck['run']): CanaryCheck => ({ def: def(id), run });
const hooks = () => {
  const notes: string[] = [];
  return { notes, h: { note: (n: string) => void notes.push(n), results: () => undefined } };
};

test('a normal run: one container with no network, every check in order, the container removed', async () => {
  const { t, calls } = fake();
  const { h, notes } = hooks();
  const order: string[] = [];
  const checks = ['a', 'b', 'c'].map((id) => check(id, async () => (order.push(id), { status: 'pass', summary: `${id} ok`, detail: 'out' })));
  const out = await runCanary(t, { version: '2.1.300', mode: 'image', image: 'claudepilot-workspace:cc-2.1.300' }, h, checks);
  assert.equal(out.status, 'done');
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual(out.results.map((r) => [r.id, r.status]), [['a', 'pass'], ['b', 'pass'], ['c', 'pass']]);
  assert.deepEqual(calls.started, [{ image: 'claudepilot-workspace:cc-2.1.300', network: 'none' }]);
  assert.deepEqual(calls.removed, ['vc-canary-fake']);
  assert.deepEqual(calls.isolated, [], 'an image run never had a network to cut');
  assert.ok(notes.includes('Running: c'));
});

test('a check that throws, fails an assertion or hangs is a fail with its words; the others still run; the container is still removed', async () => {
  const { t, calls } = fake();
  const checks = [
    check('boom', async () => { throw new Error('the stream broke'); }),
    check('assert', async () => { throw new CheckFailed('No init line.', 'line 1\nline 2'); }),
    check('hang', () => new Promise<never>(() => undefined)),
    check('fine', async () => ({ status: 'pass', summary: 'ok' })),
  ];
  const ctx = { version: '2.1.300', mode: 'image', box: { killClaude: async () => undefined }, firstReported: { value: null }, shared: new Map() } as unknown as CheckContext;
  const hung = await runOne(checks[2]!, ctx, 40);
  assert.deepEqual([hung.status, /longer than/.test(hung.summary)], ['fail', true]);
  const out = await runCanary(t, { version: '2.1.300', mode: 'image', image: 'i' }, hooks().h, [checks[0]!, checks[1]!, checks[3]!]);
  assert.deepEqual(out.results.map((r) => [r.id, r.status, r.summary]), [['boom', 'fail', 'the stream broke'], ['assert', 'fail', 'No init line.'], ['fine', 'pass', 'ok']]);
  assert.equal(out.results[1]!.detail, 'line 1\nline 2');
  assert.deepEqual(calls.removed, ['vc-canary-fake']);
});

test('a container that cannot start is an error with the reason and no results; nothing to remove', async () => {
  const { t, calls } = fake({ startFails: true });
  const out = await runCanary(t, { version: '2.1.300', mode: 'image', image: 'i' }, hooks().h, [check('a', async () => ({ status: 'pass', summary: '' }))]);
  assert.deepEqual([out.status, out.results.length, /no Docker/.test(out.note ?? '')], ['error', 0, true]);
  assert.deepEqual(calls.removed, []);
});

test('scratch mode: a network only for the install, then none; the scratch Claude Code must report the version asked for', async () => {
  const { t, calls } = fake({ versionOut: '2.1.300 (Claude Code)\n' });
  const out = await runCanary(t, { version: '2.1.300', mode: 'scratch', image: 'claudepilot-workspace:cc-2.1.296' }, hooks().h, [check('a', async () => ({ status: 'pass', summary: 'ok' }))]);
  assert.equal(out.status, 'done');
  assert.deepEqual(calls.started, [{ image: 'claudepilot-workspace:cc-2.1.296', network: 'bridge' }], 'made from the INSTALLED image');
  assert.deepEqual(calls.isolated, ['vc-canary-fake'], 'cut off before any check');
  assert.ok(calls.runs.some((r) => /npm install/.test(r)), 'the candidate was installed in the container');
  assert.deepEqual(calls.removed, ['vc-canary-fake']);

  const wrong = fake({ versionOut: '2.1.296 (Claude Code)\n', installOut: 'npm ERR! 404 not found' });
  const bad = await runCanary(wrong.t, { version: '2.1.300', mode: 'scratch', image: 'i' }, hooks().h, [check('a', async () => ({ status: 'pass', summary: 'ok' }))]);
  assert.deepEqual([bad.status, bad.results.length], ['error', 0]);
  assert.match(bad.note!, /Could not install Claude Code 2\.1\.300/);
  assert.deepEqual(wrong.calls.isolated, [], 'no checks, so nothing to isolate');
  assert.deepEqual(wrong.calls.removed, ['vc-canary-fake']);
});

test('cancelling: the checks not yet run are skipped, not lost', async () => {
  const { t } = fake();
  let stop = false;
  const checks = [check('a', async () => ((stop = true), { status: 'pass', summary: 'ok' })), check('b', async () => ({ status: 'pass', summary: 'ok' }))];
  const out = await runCanary(t, { version: '2.1.300', mode: 'image', image: 'i' }, { note: () => undefined, results: () => undefined, cancelled: () => stop }, checks);
  assert.deepEqual(out.results.map((r) => [r.id, r.status]), [['a', 'pass'], ['b', 'skipped']]);
});

test('the real output is redacted and clipped before it is stored', () => {
  const token = `sk-ant-api03-${'A'.repeat(40)}-${'B'.repeat(20)}`;
  const clean = clipDetail(`key ${token} \u001b[31mred\u001b[0m ${'x'.repeat(DETAIL_MAX + 100)}`);
  assert.ok(!clean.includes(token), 'a credential shape never reaches a stored result');
  assert.ok(!clean.includes('\u001b'), 'terminal escapes are removed');
  assert.ok(clean.length <= DETAIL_MAX);
  assert.ok(clean.endsWith('…'));
});
