// The four safe-mode guards of the probe-safe-mode check (docs/prd/claude-version-pinning.md §16.1): (a) the flag is in the help, (b) the hook marker
// test (no marker under the flag, markers without it), (c) get_usage still answers under the flag, (d) CLAUDE_CODE_SAFE_MODE is not a substitute.
// Each guard is shown passing and failing on recorded observations (`judgeSafeMode`), and the whole check runs once against a fake CLI in a fake
// container to show the runs feed the guards (the real CLI runs in canary.integration.test.ts, with Docker).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeCommand } from '../../claudeusage/probe.js';
import type { ExecSession, ThrowawayAccess } from '../../workspaces/runtime.js';
import { CanaryBox, CheckFailed } from './box.js';
import { canaryChecks, judgeSafeMode, type SafeModeObservation } from './checks.js';
import type { CheckContext } from './support.js';

const resets = Date.now() + 3 * 3600_000;
/** A get_usage reply as Claude Code sends it for a plan (built at runtime; the clock is the real one, no fixed date). */
const reply = (session = 41) => ({ subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: session, resets_at: new Date(resets).toISOString() }, seven_day: { utilization: 63, resets_at: new Date(resets + 86_400_000).toISOString() } } });
const MARKERS = 'project-SessionEnd project-SessionStart user-SessionEnd user-SessionStart';

const good = (): SafeModeObservation => ({
  helpListsFlag: true,
  helpOut: '1',
  own: probeCommand(''),
  safe: { reply: reply(), out: '', ran: '' },
  bare: { reply: reply(), out: '', ran: MARKERS },
  envOnly: { reply: reply(), out: '', ran: MARKERS },
});
const fails = (o: SafeModeObservation, words: RegExp) => assert.throws(() => judgeSafeMode(o), (e: unknown) => e instanceof CheckFailed && words.test(e.message));

test('all four guards pass on what 2.1.296 does: the flag listed, no hook under it, hooks without it, the same windows, the flag in the probe', () => {
  const out = judgeSafeMode(good());
  assert.equal(out.status, 'pass');
  for (const g of ['flag:', 'hooks:', 'get_usage:', 'variable: CLAUDE_CODE_SAFE_MODE=1 alone is not a substitute']) assert.ok(out.detail!.includes(g), g);
});

test('guard (a), flag present: a help without --safe-mode fails, before anything else is judged', () => {
  fails({ ...good(), helpListsFlag: false, safe: { reply: null, out: "error: unknown option '--safe-mode'", ran: '' } }, /does not list --safe-mode/);
});

test('guard (b), hook marker: a marker under the flag fails; no marker without the flag fails too (the test would prove nothing)', () => {
  fails({ ...good(), safe: { reply: reply(), out: '', ran: 'user-SessionStart' } }, /these hooks still ran during a probe: user-SessionStart/);
  fails({ ...good(), bare: { reply: reply(), out: '', ran: '' } }, /proves nothing/);
});

test('guard (c), get_usage: no answer, not a plan, or other windows than without the flag fail', () => {
  fails({ ...good(), safe: { reply: null, out: 'timeout', ran: '' } }, /did not answer under --safe-mode/);
  fails({ ...good(), safe: { reply: { rate_limits_available: false }, out: '', ran: '' } }, /did not read as a plan/);
  fails({ ...good(), bare: { reply: reply(77), out: '', ran: MARKERS } }, /answers differently/);
});

test('guard (d), the variable is not a substitute: a probe that sets CLAUDE_CODE_SAFE_MODE instead of passing the flag fails; the variable alone is reported', () => {
  const own = probeCommand('').filter((a) => a !== '--safe-mode');
  const at = own.indexOf('timeout');
  fails({ ...good(), own: [...own.slice(0, at), 'CLAUDE_CODE_SAFE_MODE=1', ...own.slice(at)] }, /sets CLAUDE_CODE_SAFE_MODE but does not pass --safe-mode/);
  fails({ ...good(), own }, /does not pass --safe-mode/);
  // A flag that is not an argument of claude (in the wrapper's script, say) does not count either.
  fails({ ...good(), own: ['--safe-mode', ...own] }, /does not pass --safe-mode/);
  // If a later version honours the variable alone, the check still passes (the probe passes the flag) and says so.
  const later = judgeSafeMode({ ...good(), envOnly: { reply: reply(), out: '', ran: '' } });
  assert.match(later.detail!, /alone now stops the hooks too/);
});

/** A container whose `claude` behaves as the test says: whether it knows the flag, and whether the variable alone stops hooks. */
function fakeBox(cli: { knowsFlag: boolean; envStopsHooks?: boolean; hooksRun?: boolean }) {
  let markers = '';
  const commands: string[][] = [];
  const t = {
    run: async (_n: string, script: string) => {
      if (/--help/.test(script)) return { code: 0, stdout: cli.knowsFlag ? '1\n' : '0\n', stderr: '' };
      if (/rm -f .*hook-\*/.test(script)) markers = '';
      if (/grep '\^hook-'/.test(script)) return { code: 0, stdout: markers, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    put: async () => undefined,
    exec: async (_n: string, command: string[]): Promise<ExecSession> => {
      commands.push(command);
      const flag = command.slice(command.indexOf('claude') + 1).includes('--safe-mode');
      const env = command.includes('CLAUDE_CODE_SAFE_MODE=1');
      let data: (b: Buffer) => void = () => undefined;
      let exit: (c: number | null) => void = () => undefined;
      const quiet = (flag && cli.knowsFlag) || (env && cli.envStopsHooks) || cli.hooksRun === false;
      return {
        write: (line) => {
          if (flag && !cli.knowsFlag) return void setImmediate(() => (data(Buffer.from("error: unknown option '--safe-mode'\n")), exit(1)));
          const id = (JSON.parse(String(line)) as { request_id: string }).request_id;
          setImmediate(() => data(Buffer.from(`${JSON.stringify({ type: 'control_response', response: { request_id: id, subtype: 'success', response: reply() } })}\n`)));
        },
        close: () => {
          if (!quiet) markers = MARKERS;
          setImmediate(() => exit(0));
        },
        onData: (fn) => void (data = fn),
        onExit: (fn) => void (exit = fn),
      };
    },
  } as unknown as ThrowawayAccess;
  return { box: new CanaryBox(t, 'vc-canary-fake', 'claude'), commands };
}

const check = canaryChecks().find((c) => c.def.id === 'probe-safe-mode')!;
const ctx = (box: CanaryBox) => ({ version: '2.1.296', mode: 'image', box, firstReported: { value: null }, shared: new Map() }) as unknown as CheckContext;

test('the whole check against a fake CLI: passes as 2.1.296 behaves; fails on a CLI without the flag and on one whose hooks never run', { timeout: 60_000 }, async () => {
  const ok = fakeBox({ knowsFlag: true });
  const out = await check.run(ctx(ok.box));
  assert.equal(out.status, 'pass', out.summary);
  assert.equal(ok.commands.length, 3, 'with the flag, without it, the variable alone');
  assert.ok(ok.commands[2]!.includes('CLAUDE_CODE_SAFE_MODE=1') && !ok.commands[2]!.slice(ok.commands[2]!.indexOf('claude')).includes('--safe-mode'));
  const old = fakeBox({ knowsFlag: false });
  await assert.rejects(() => check.run(ctx(old.box)), /does not list --safe-mode/);
  assert.equal(old.commands.length, 0, 'no probe run without the flag in the help');
  await assert.rejects(() => check.run(ctx(fakeBox({ knowsFlag: true, hooksRun: false }).box)), /proves nothing/);
});
