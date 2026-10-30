// Claude usage against the REAL Claude Code CLI (PRD §16): the probe command, the parser and the passive events run on what
// Claude Code actually answers, for a Claude with a clearly fake claude.ai login and a scripted stand-in for api.anthropic.com
// (testkit/README.md). No sign-in, no real token, nothing leaves the machine. Skipped when `claude` or `openssl` is missing.

import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { parseRateLimitInfo } from './parse.js';
import { probeClaude, SAFE_MODE_FLAG, type ProbeIo } from './probe.js';
import { PRIME_SYSTEM_PROMPT, runPrime } from './prime.js';
import { localExec, makeFakeClaude, opensslAvailable, startStandIn, type FakeClaude, type StandIn } from './testkit/index.js';

const hasClaude = (() => {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const opts = { skip: hasClaude && opensslAvailable() ? false : 'needs the claude CLI and the openssl command', timeout: 120_000 };

/** A fake API key, joined at run time: no token-shaped literal sits in the repo (GitHub push protection and the commit scanner look for them). */
const FAKE_API_KEY = ['sk', 'ant', 'api03', 'x'.repeat(40)].join('-');

let standIn: StandIn;
const made: FakeClaude[] = [];
/**
 * T-2421: every Claude Code process this file starts, until it exits. A probe or a turn returns once stdin is closed, and the process may
 * write in its HOME (and run its SessionEnd hooks) for up to 2 s more before it is killed: removing the folders meanwhile failed the
 * teardown with ENOTEMPTY under the gate's load. The folders go only after every process is gone.
 */
const exited: Promise<void>[] = [];
const track = (child: ChildProcess) => void exited.push(new Promise((resolve) => child.once('close', () => resolve())));
/** Bounded: a child that never exits must not hang the teardown (and the gate) for ever; the removal's retries cover what is left. */
const allExited = () => Promise.race([Promise.all(exited), new Promise<void>((r) => setTimeout(r, 20_000).unref())]);
before(async () => {
  if (!opts.skip) standIn = await startStandIn();
});
after(async () => {
  await allExited();
  made.forEach((c) => c.remove());
  await standIn?.close();
});

const DIR = 'claudes/0123456789abcdef';
const fake = (o: Parameters<typeof makeFakeClaude>[0] = {}) => {
  const c = makeFakeClaude(o);
  made.push(c);
  return c;
};

/** The environment a workspace would hand `exec` (in `cwd` when given: where a project's own settings sit): plus an API key and a token that the probe must not pass on. */
const envFor = (c: FakeClaude) => ({ HOME: c.home, PATH: process.env.PATH ?? '', ...standIn.childEnv(), ANTHROPIC_API_KEY: FAKE_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: 'FAKE-must-be-dropped' });
const ioFor = (c: FakeClaude, cwd?: string): ProbeIo => ({ exec: localExec(envFor(c), { cwd, exited }) });

const iso = (ms: number) => new Date(ms).toISOString();
const at5h = Date.UTC(2026, 9, 12, 5, 0, 0);
const atWeek = Date.UTC(2026, 9, 15, 9, 0, 0);
const body = {
  five_hour: { utilization: 41, resets_at: iso(at5h) },
  seven_day: { utilization: 63, resets_at: iso(atWeek) },
  seven_day_oauth_apps: null,
  seven_day_opus: { utilization: 12.5, resets_at: iso(atWeek) },
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
};

test('real CLI: a fake Max login reads as a plan with its windows, and the workspace’s API key and token are not passed on', opts, async () => {
  const claude = fake({ directory: DIR });
  standIn.set({ usage: { body } });
  const r = await probeClaude(ioFor(claude), 'local', 'x', DIR);
  assert.deepEqual([r.runsOn, r.plan, r.problem, r.failed], ['plan', 'max', null, false], 'with the key in the environment it would have read as no plan limits');
  assert.deepEqual(r.windows.map((w) => [w.key, w.usedPct, w.resetsAtMs]), [['session', 41, at5h], ['week', 63, atWeek], ['week_opus', 12.5, atWeek]]);
  assert.ok(standIn.requests.some((q) => q.path.startsWith('/api/oauth/usage')), 'the CLI asked the usage endpoint itself');
  assert.ok(!standIn.requests.some((q) => q.method === 'CONNECT-REFUSED'), 'and reached nobody else through the proxy');
  assert.ok(!standIn.requests.some((q) => q.path.includes('/v1/messages')), 'no model request');
  assert.ok(!standIn.requests.some((q) => q.path.includes('event_logging')), 'no telemetry');
});

test('real CLI: the server’s limits[] rows, a model the plan names and extra usage come through', opts, async () => {
  const claude = fake({ directory: DIR });
  standIn.set({
    usage: {
      body: {
        ...body,
        extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25, currency: 'USD' },
        limits: [
          { kind: 'session', group: 'session', percent: 41, resets_at: iso(at5h), scope: null, severity: 'normal', is_active: false },
          { kind: 'weekly_scoped', group: 'weekly', percent: 88, resets_at: iso(atWeek), scope: { model: { display_name: 'Fable' } }, severity: 'warning', is_active: false },
        ],
      },
    },
  });
  const r = await probeClaude(ioFor(claude), 'local', 'x', DIR);
  assert.deepEqual(r.windows.map((w) => w.key), ['session', 'week', 'week_opus', 'model:fable']);
  assert.equal(r.windows.find((w) => w.key === 'model:fable')!.usedPct, 88);
  assert.deepEqual(r.extra, { enabled: true, usedPct: 25, limit: 5000, used: 1250, currency: 'USD' });
});

test('real CLI: the usage endpoint refusing (429) with no copy of its own is unknown, and a plan all the same', opts, async () => {
  const claude = fake({ directory: DIR });
  standIn.set({ usage: { status: 429, headers: { 'retry-after': '120' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited.' } } } });
  const r = await probeClaude(ioFor(claude), 'local', 'x', DIR);
  assert.deepEqual([r.runsOn, r.plan, r.problem, r.failed, r.windows.length], ['plan', 'max', 'unavailable', true, 0]);
});

test('real CLI: Default with no login is signed out; a Claude whose settings name an apiKeyHelper is an API key; neither has plan limits', opts, async () => {
  const out = fake({ signedOut: true });
  const a = await probeClaude(ioFor(out), 'local', 'x', '');
  assert.deepEqual([a.runsOn, a.windows.length, a.problem, a.failed], ['none', 0, null, false]);

  const key = fake({ directory: DIR, signedOut: true });
  mkdirSync(key.configDir!, { recursive: true });
  writeFileSync(join(key.configDir!, 'settings.json'), JSON.stringify({ apiKeyHelper: `echo ${FAKE_API_KEY}` }));
  const b = await probeClaude(ioFor(key), 'local', 'x', DIR);
  assert.deepEqual([b.runsOn, b.windows.length, b.problem, b.failed], ['key', 0, null, false]);
});

test('real CLI: a Claude not installed here reads as such', opts, async () => {
  const claude = fake();
  const r = await probeClaude({ exec: localExec({ HOME: claude.home, PATH: '/usr/bin:/bin' }, { exited }) }, 'local', 'x', '');
  // /usr/bin has no `claude`, so the wrapper's `exec env … claude` ends 127 (or `timeout` does), never a reading.
  assert.equal(r.failed, true);
  assert.ok(['not_installed', 'unreadable'].includes(r.problem!), String(r.problem));
});

/** The reply of `get_usage` from the CLI run directly (no probe wrapper) with exactly this environment. */
function rawUsage(env: Record<string, string>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    track(child);
    const timer = setTimeout(() => (child.kill('SIGKILL'), reject(new Error('no reply'))), 30_000);
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      for (const line of buf.split('\n')) {
        if (!line.includes('"control_response"')) continue;
        clearTimeout(timer);
        child.stdin.end();
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
        return resolve((JSON.parse(line) as { response: { response: Record<string, unknown> } }).response.response);
      }
    });
    child.on('error', reject);
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'raw1', request: { subtype: 'get_usage', skip_behaviors: true } })}\n`);
  });
}

test('real CLI: why the environment is cleaned: an API key in it makes the same plan login read as having no plan limits', opts, async () => {
  const claude = fake({ directory: DIR });
  standIn.set({ usage: { body } });
  const base = { HOME: claude.home, PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: claude.configDir!, ...standIn.childEnv() };
  const clean = await rawUsage(base);
  assert.equal(clean.rate_limits_available, true, 'the login alone: plan limits');
  const withKey = await rawUsage({ ...base, ANTHROPIC_API_KEY: FAKE_API_KEY });
  assert.equal(withKey.rate_limits_available, false, 'with a key in the environment Claude Code runs on the key');
  assert.equal(withKey.rate_limits, null);
});

/** One turn of the real CLI, as a chat session streams it: the lines up to its `result`. */
function runTurn(c: FakeClaude): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { HOME: c.home, PATH: process.env.PATH ?? '', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', ...standIn.childEnv() };
    if (c.configDir) env.CLAUDE_CONFIG_DIR = c.configDir;
    const child = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--no-session-persistence'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    track(child);
    const lines: Record<string, unknown>[] = [];
    let buf = '';
    const timer = setTimeout(() => (child.kill('SIGKILL'), reject(new Error('the turn did not finish'))), 60_000);
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        try {
          lines.push(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
        } catch {
          // not a stream line
        }
        buf = buf.slice(nl + 1);
        if (lines.at(-1)?.type === 'result') {
          clearTimeout(timer);
          child.stdin.end();
          setTimeout(() => child.kill('SIGKILL'), 2000).unref();
          resolve(lines);
        }
      }
    });
    child.on('error', reject);
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })}\n`);
  });
}

test('real CLI, passive: a turn with unified rate-limit headers streams a rate_limit_event the parser reads', opts, async () => {
  const claude = fake({ directory: DIR });
  const reset5h = Math.floor(Date.now() / 1000) + 7200;
  const resetWeek = reset5h + 200_000;
  standIn.set({
    messages: {
      text: 'hello from the stand-in',
      headers: {
        'anthropic-ratelimit-unified-status': 'allowed_warning',
        'anthropic-ratelimit-unified-reset': String(reset5h),
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-5h-utilization': '0.82',
        'anthropic-ratelimit-unified-5h-reset': String(reset5h),
        'anthropic-ratelimit-unified-7d-utilization': '0.63',
        'anthropic-ratelimit-unified-7d-reset': String(resetWeek),
      },
    },
  });
  const lines = await runTurn(claude);
  const event = lines.find((l) => l.type === 'rate_limit_event');
  assert.ok(event, 'the stream carries a rate_limit_event');
  const p = parseRateLimitInfo((event as { rate_limit_info: unknown }).rate_limit_info)!;
  assert.deepEqual(p.windows.map((w) => [w.key, w.usedPct, w.resetsAtMs]), [['session', 82, reset5h * 1000], ['week', 63, resetWeek * 1000]]);
  assert.deepEqual(p.rejected, []);
});

test('real CLI, passive: a refused turn (429, rejected) streams the event, the usage_limit_reached line and an error result; no retry', opts, async () => {
  const claude = fake({ directory: DIR });
  const reset5h = Math.floor(Date.now() / 1000) + 3600;
  standIn.set({
    messages: {
      status: 429,
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } },
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': String(reset5h),
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-5h-utilization': '1.0',
        'anthropic-ratelimit-unified-5h-reset': String(reset5h),
        'anthropic-ratelimit-unified-7d-utilization': '0.71',
        'anthropic-ratelimit-unified-7d-reset': String(reset5h + 200_000),
        'retry-after': '3600',
      },
    },
  });
  const lines = await runTurn(claude);
  const event = lines.find((l) => l.type === 'rate_limit_event') as { rate_limit_info: unknown } | undefined;
  assert.ok(event);
  const p = parseRateLimitInfo(event.rate_limit_info)!;
  assert.deepEqual(p.rejected, ['session']);
  assert.equal(p.windows.find((w) => w.key === 'session')!.usedPct, 100);
  const refusal = lines.find((l) => l.type === 'assistant' && (l as { api_error?: string }).api_error === 'usage_limit_reached') as { api_error_params?: { rate_limit_info?: unknown } } | undefined;
  assert.ok(refusal, 'an assistant line says the usage limit was reached');
  assert.equal(parseRateLimitInfo(refusal.api_error_params?.rate_limit_info)?.rejected[0], 'session', 'with the same info under api_error_params');
  assert.ok(!lines.some((l) => l.type === 'api_retry'), 'a usage limit is not retried');
  assert.equal((lines.find((l) => l.type === 'result') as { is_error?: boolean }).is_error, true);
});

/**
 * A Claude whose settings, and a project's, say to run a command when a session starts and ends: each leaves a marker file named for who ran it. This is what
 * a workspace's own hooks, or an agent's, look like to a probe: it starts a session (no message sent), and without safe mode Claude Code ran them.
 */
function hooked(directory: string) {
  const claude = fake({ directory });
  const marks = mkdtempSync(join(tmpdir(), 'cp-hook-marks-'));
  const project = mkdtempSync(join(tmpdir(), 'cp-hook-project-'));
  const hooks = (who: string) => ({ hooks: Object.fromEntries(['SessionStart', 'SessionEnd'].map((e) => [e, [{ hooks: [{ type: 'command', command: `touch '${marks}/${who}-${e}'` }] }]])) });
  const dir = claude.configDir ?? join(claude.home, '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(hooks('user')));
  mkdirSync(join(project, '.claude'));
  writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify(hooks('project')));
  return {
    claude,
    project,
    /** What ran, after a moment for a hook that runs as the process ends. */
    fired: async () => (await new Promise((r) => setTimeout(r, 1500)), readdirSync(marks).sort()),
    /** After every process this file started is gone (T-2421); a hook's own `touch` may still land, hence the retries. */
    remove: async () => {
      await allExited();
      for (const d of [marks, project]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

test('real CLI: the probe runs no hook (--safe-mode), in the Claude’s settings or the project’s, and still reads the plan; without the flag the same hooks run', opts, async () => {
  for (const directory of [DIR, '']) {
    const h = hooked(directory);
    try {
      standIn.set({ usage: { body } });
      const r = await probeClaude(ioFor(h.claude, h.project), 'local', 'x', directory);
      assert.deepEqual([r.runsOn, r.plan, r.failed, r.windows.length], ['plan', 'max', false, 3], 'safe mode keeps the sign-in and the usage reply');
      assert.deepEqual(await h.fired(), [], `a probe of ${directory || 'Default'} ran a hook`);

      // The control: the same Claude and project with only the flag taken out of the command. A regression test that cannot fail proves nothing.
      const run = localExec(envFor(h.claude), { cwd: h.project, exited });
      const unsafe: ProbeIo = { exec: (t, n, cmd) => run(t, n, cmd.filter((a) => a !== SAFE_MODE_FLAG)) };
      await probeClaude(unsafe, 'local', 'x', directory);
      const fired = await h.fired();
      assert.ok(fired.includes('user-SessionStart') && fired.includes('project-SessionStart'), `without --safe-mode the hooks ran (${fired.join(', ') || 'none'})`);
    } finally {
      await h.remove();
    }
  }
});

test('real CLI, prime (T-1707): one request on the cheapest model with no tools and a one-line system prompt, answered is ok', opts, async () => {
  const claude = fake({ directory: DIR });
  standIn.set({ usage: { body }, messages: { text: 'ok' } });
  const before = standIn.requests.length;
  const r = await runPrime(ioFor(claude), 'local', 'x', DIR);
  assert.deepEqual(r, { outcome: 'ok' });
  const asked = standIn.requests.slice(before).filter((q) => q.method === 'POST' && q.path.startsWith('/v1/messages') && !q.path.includes('count_tokens'));
  assert.equal(asked.length, 1, 'one model request');
  assert.match(asked[0]!.model ?? '', /haiku/i, 'the alias resolves to a Haiku model');
  assert.equal(asked[0]!.tools, 0, 'no tools sent');
  assert.ok((asked[0]!.systemChars ?? 0) < PRIME_SYSTEM_PROMPT.length + 400, `a short system prompt (${asked[0]!.systemChars} chars)`);
  assert.ok(!standIn.requests.some((q) => q.method === 'CONNECT-REFUSED'), 'and reached nobody else');
});

test('real CLI, prime (T-1707): a refusal for the plan limit is limited, with the reset the refusal states', opts, async () => {
  const claude = fake({ directory: DIR });
  const reset5h = Math.floor(Date.now() / 1000) + 3600;
  standIn.set({
    messages: {
      status: 429,
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } },
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': String(reset5h),
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-5h-utilization': '1.0',
        'anthropic-ratelimit-unified-5h-reset': String(reset5h),
        'retry-after': '3600',
      },
    },
  });
  const r = await runPrime(ioFor(claude), 'local', 'x', DIR);
  assert.equal(r.outcome, 'limited');
  const p = parseRateLimitInfo(r.outcome === 'limited' ? r.info : null)!;
  assert.deepEqual(p.rejected, ['session']);
  assert.equal(p.windows.find((w) => w.key === 'session')?.resetsAtMs, reset5h * 1000);
});
