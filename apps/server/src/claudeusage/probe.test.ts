import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { askUsage, authCommand, inClaude, probeClaude, probeCommand, PROBE_LIMIT_S, SAFE_MODE_FLAG, type ProbeIo } from './probe.js';
import { localExec } from './testkit/localExec.js';
import { AUTH_KEY, AUTH_OUT, AUTH_PLAN, controlReply, REPLY_NO_LIMITS, REPLY_PLAN, REPLY_UNAVAILABLE, requestId, ScriptedExec } from './fixtures.js';

const DIR = 'claudes/0123456789abcdef';

/** Runs the probe's shell wrapper around `env`, which prints the environment the command would get. */
function environmentOf(dir: string, env: Record<string, string>): Record<string, string> {
  const [sh, ...args] = inClaude(dir, 'env');
  const out = execFileSync(sh!, args, { env, encoding: 'utf8' });
  return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

test('the command: a clean environment, only the network plumbing and the Claude’s own directory', () => {
  const secrets = {
    ANTHROPIC_API_KEY: ['sk', 'ant', 'canary', 'key'].join('-'), // joined at run time: no token-shaped literal in the repo
    ANTHROPIC_AUTH_TOKEN: 'canary-bearer',
    CLAUDE_CODE_OAUTH_TOKEN: 'canary-oauth',
    ANTHROPIC_BASE_URL: 'http://canary.invalid',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CONFIG_DIR: '/somewhere/else',
    AWS_SECRET_ACCESS_KEY: 'canary-aws',
    GITHUB_TOKEN: 'canary-gh',
  };
  const base = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/home/node', LANG: 'en_US.UTF-8', ...secrets };

  const plain = environmentOf('', base);
  assert.deepEqual(Object.keys(plain).sort(), ['DISABLE_AUTOUPDATER', 'DISABLE_ERROR_REPORTING', 'DISABLE_TELEMETRY', 'HOME', 'LANG', 'PATH']);
  assert.equal(plain.HOME, '/home/node');
  assert.equal(plain.LANG, 'C.UTF-8');
  assert.ok(plain.PATH!.startsWith('/home/node/.local/bin:'), 'where the native installer puts claude');
  assert.ok(!('CLAUDE_CONFIG_DIR' in plain), 'Default has no directory set');
  assert.ok(!Object.values(plain).some((v) => v.includes('canary')));

  const own = environmentOf(DIR, base);
  assert.equal(own.CLAUDE_CONFIG_DIR, `/home/node/.claudepilot/${DIR}`, 'the Claude’s directory, not the one in the environment');

  const proxied = environmentOf('', { ...base, HTTPS_PROXY: 'http://proxy.local:3128', no_proxy: 'localhost', NODE_EXTRA_CA_CERTS: '/etc/with space/ca.pem', SSL_CERT_DIR: '' });
  assert.equal(proxied.HTTPS_PROXY, 'http://proxy.local:3128');
  assert.equal(proxied.no_proxy, 'localhost');
  assert.equal(proxied.NODE_EXTRA_CA_CERTS, '/etc/with space/ca.pem', 'a value with a space stays whole');
  assert.ok(!('SSL_CERT_DIR' in proxied), 'an empty one is no one');

  const spaced = environmentOf(DIR, { ...base, HOME: '/Users/Jo Doe' });
  assert.equal(spaced.CLAUDE_CONFIG_DIR, `/Users/Jo Doe/.claudepilot/${DIR}`, 'a home with a space');
});

test('the command line: stream-json probe with no MCP servers, skills or saved session; never --bare', () => {
  const c = probeCommand(DIR);
  assert.deepEqual(c.slice(0, 2), ['sh', '-c']);
  assert.equal(c[3], 'sh');
  assert.equal(c[4], DIR, 'the directory is an argument, not part of the script');
  const tail = c.slice(5);
  assert.deepEqual(tail.slice(0, 4), ['timeout', String(PROBE_LIMIT_S), 'claude', '-p']);
  for (const flag of ['--input-format', '--output-format', '--verbose', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(tail.includes(flag), flag);
  assert.ok(!tail.includes('--bare'), '--bare skips the sign-in');
  assert.ok(!c.join(' ').includes('NONESSENTIAL'), 'that switch stops the usage fetch');
  assert.deepEqual(authCommand('').slice(5), ['timeout', '15', 'claude', 'auth', 'status', '--json']);
  for (const bad of ['claudes/ABC', '../etc', 'claudes/0123456789abcdef/x', 'claudes/0123456789abcdeg', 'x; rm -rf /', ' ']) assert.throws(() => probeCommand(bad), /isn’t valid/, bad);
});

/** An exec whose process answers the usage request with `reply`. */
const answering = (reply: unknown, opts: { chunks?: number; noise?: boolean } = {}) => () =>
  new ScriptedExec((self, line) => {
    const out = `${opts.noise ? 'warning: something on stderr\nnot json either\n{"type":"system","subtype":"hook"}\n' : ''}${controlReply(requestId(line), reply)}`;
    if (!opts.chunks) return self.emit(out);
    const step = Math.ceil(out.length / opts.chunks);
    for (let i = 0; i < out.length; i += step) self.emit(out.slice(i, i + step));
  });

const io = (spawn: (command: string[]) => ScriptedExec, extra: Partial<ProbeIo> = {}): ProbeIo & { commands: string[][]; execs: ScriptedExec[] } => {
  const commands: string[][] = [];
  const execs: ScriptedExec[] = [];
  return {
    commands,
    execs,
    exec: async (_t, _n, command) => {
      commands.push(command);
      const e = spawn(command);
      execs.push(e);
      return e;
    },
    ...extra,
  };
};

test('askUsage: writes get_usage with skip_behaviors and reads the reply to its own id, whatever else is on the line', async () => {
  const i = io(answering(REPLY_PLAN, { noise: true, chunks: 5 }));
  const r = await askUsage(i, 'docker', 'ws1', DIR);
  assert.deepEqual(r, { ok: true, response: REPLY_PLAN });
  const sent = JSON.parse(i.execs[0]!.written[0]!) as { type: string; request: unknown };
  assert.equal(sent.type, 'control_request');
  assert.deepEqual(sent.request, { subtype: 'get_usage', skip_behaviors: true });
  assert.equal(i.execs[0]!.written.length, 1, 'one line: no user message, so no model request');
  assert.ok(i.execs[0]!.closed, 'closed once answered');
});

test('askUsage: a reply to another request id is not ours; the process ending or hanging says why', async () => {
  const wrongId = io(() => new ScriptedExec((self) => self.emit(controlReply('someone-else', REPLY_PLAN))), { hardMs: 60 });
  assert.deepEqual(await askUsage(wrongId, 'docker', 'ws1', ''), { ok: false, problem: 'timeout' });
  assert.ok(wrongId.execs[0]!.closed, 'a hung probe is let go');

  const missing = io(() => new ScriptedExec((self) => self.end(127)));
  assert.deepEqual(await askUsage(missing, 'docker', 'ws1', ''), { ok: false, problem: 'not_installed' });
  const killed = io(() => new ScriptedExec((self) => self.end(124)));
  assert.deepEqual(await askUsage(killed, 'docker', 'ws1', ''), { ok: false, problem: 'timeout' });
  const dies = io(() => new ScriptedExec((self) => self.end(1)));
  assert.deepEqual(await askUsage(dies, 'docker', 'ws1', ''), { ok: false, problem: 'unreadable' });
  const refusal = io(() => new ScriptedExec((self, l) => self.emit(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId(l), error: 'Unsupported control request subtype: get_usage' } })}\n`)));
  assert.deepEqual(await askUsage(refusal, 'docker', 'ws1', ''), { ok: false, problem: 'unreadable' });
  const throws: ProbeIo = { exec: async () => Promise.reject(new Error('workspace is stopped')) };
  assert.deepEqual(await askUsage(throws, 'docker', 'ws1', ''), { ok: false, problem: 'unreadable' });
});

/** `claude auth status`: prints by itself (nothing is written to it), then ends. */
const auth = (text: string, code = 0) => () => {
  const e = new ScriptedExec();
  setTimeout(() => (e.emit(text), e.end(code)), 0);
  return e;
};
const both = (usage: unknown, authText: string, authCode = 0) => (command: string[]) => (command.includes('auth') ? auth(authText, authCode)() : answering(usage)());

test('probeClaude: a plan keeps its windows, and no second process is run', async () => {
  const i = io(both(REPLY_PLAN, AUTH_PLAN));
  const r = await probeClaude(i, 'docker', 'ws1', DIR);
  assert.equal(r.runsOn, 'plan');
  assert.equal(r.plan, 'max');
  assert.deepEqual(r.windows.map((w) => w.key), ['session', 'week', 'week_opus']);
  assert.equal(r.failed, false);
  assert.equal(i.commands.length, 1, 'auth status is only asked when there are no plan limits');
});

test('probeClaude: no plan limits, told apart by the sign-in state', async () => {
  const signedOut = await probeClaude(io(both(REPLY_NO_LIMITS, AUTH_OUT)), 'docker', 'ws1', '');
  assert.deepEqual([signedOut.runsOn, signedOut.problem, signedOut.failed], ['none', null, false]);
  const key = await probeClaude(io(both(REPLY_NO_LIMITS, AUTH_KEY)), 'docker', 'ws1', '');
  assert.deepEqual([key.runsOn, key.problem, key.failed], ['key', null, false]);
  // A claude.ai login whose token lacks the profile scope: a plan that can't report.
  const scope = await probeClaude(io(both({ ...REPLY_NO_LIMITS, subscription_type: 'max' }, AUTH_PLAN)), 'docker', 'ws1', '');
  assert.deepEqual([scope.runsOn, scope.plan, scope.problem, scope.failed], ['plan', 'max', 'no_scope', false]);
  // Signed out answers with exit 1 on some builds; the state is still read.
  const code1 = await probeClaude(io(both(REPLY_NO_LIMITS, AUTH_OUT, 1)), 'docker', 'ws1', '');
  assert.equal(code1.runsOn, 'none');
  // When even that can't be read, nothing is claimed.
  const unreadable = await probeClaude(io(both(REPLY_NO_LIMITS, 'garbage')), 'docker', 'ws1', '');
  assert.deepEqual([unreadable.runsOn, unreadable.problem, unreadable.failed], ['unknown', 'unreadable', true]);
  const noAuth = await probeClaude(io(both(REPLY_NO_LIMITS, '', 127)), 'docker', 'ws1', '');
  assert.equal(noAuth.failed, true);
});

test('probeClaude: a plan Claude Code could not reach is a failure that keeps being a plan; an unreadable reply is one too', async () => {
  const down = await probeClaude(io(answering(REPLY_UNAVAILABLE)), 'docker', 'ws1', '');
  assert.deepEqual([down.runsOn, down.plan, down.problem, down.failed, down.windows.length], ['plan', 'max', 'unavailable', true, 0]);
  const junk = await probeClaude(io(answering({ nothing: 'useful' })), 'docker', 'ws1', '');
  assert.deepEqual([junk.runsOn, junk.problem, junk.failed], ['unknown', 'unreadable', true]);
  const timeout = await probeClaude(io(() => new ScriptedExec(), { hardMs: 40 }), 'docker', 'ws1', '');
  assert.deepEqual([timeout.problem, timeout.failed], ['timeout', true]);
});

test('nothing from the account reaches a result: the canary in auth status and in the reply never comes back', async () => {
  const withCanary = { ...REPLY_PLAN, account: { email: 'someone-canary@example.invalid', organization: 'Canary Org' }, rate_limits: { ...REPLY_PLAN.rate_limits, org: 'canary-org-id' } };
  const r = await probeClaude(io(both(withCanary, AUTH_PLAN)), 'docker', 'ws1', '');
  assert.ok(!JSON.stringify(r).toLowerCase().includes('canary'));
  const k = await probeClaude(io(both(REPLY_NO_LIMITS, AUTH_PLAN.replace('"claude.ai"', '"api_key"'))), 'docker', 'ws1', '');
  assert.ok(!JSON.stringify(k).toLowerCase().includes('canary'));
});

/* ---------- Safe mode: a probe never runs the Claude's hooks (docs §11) ---------- */

test('the command line carries --safe-mode, once, and auth status does not (it runs no hook and takes the flag only before the subcommand)', () => {
  assert.equal(SAFE_MODE_FLAG, '--safe-mode', 'the exact flag the canary looks for');
  for (const dir of ['', DIR]) {
    const tail = probeCommand(dir).slice(5);
    assert.equal(tail.filter((a) => a === SAFE_MODE_FLAG).length, 1);
    assert.ok(!tail.includes('--bare'), 'safe mode keeps the sign-in; --bare would not');
  }
  // Observed on 2.1.296: `auth status` ran no hook and no apiKeyHelper, and `auth status --safe-mode` is an unknown option.
  assert.ok(!authCommand('').includes(SAFE_MODE_FLAG));
});

test('a Claude Code without --safe-mode starts nothing and says so: the probe is unsupported, fails closed, and asks no second question', async () => {
  const old = () =>
    new ScriptedExec((self) => {
      self.emit("error: unknown option '--safe-mode'\n");
      self.end(1);
    });
  assert.deepEqual(await askUsage(io(old), 'docker', 'ws1', DIR), { ok: false, problem: 'unreadable', unsupported: true });
  // Said in two chunks, the last without its line break, as a stream can deliver it.
  const split = () =>
    new ScriptedExec((self) => {
      self.emit("error: unknown opt");
      self.emit("ion '--safe-mode'");
      self.end(1);
    });
  assert.equal((await askUsage(io(split), 'docker', 'ws1', DIR) as { unsupported?: boolean }).unsupported, true);
  const i = io(old);
  const r = await probeClaude(i, 'docker', 'ws1', DIR);
  assert.deepEqual([r.failed, r.problem, r.unsupported, r.runsOn, r.windows.length], [true, 'unreadable', true, 'unknown', 0]);
  assert.equal(i.commands.length, 1, 'no auth status, no retry without the flag');
  // Another way to fail is not that: a crash, a missing CLI, a hang, another unknown option.
  for (const [text, code] of [['', 1], ["error: unknown option '--verbose'\n", 1], ['segfault\n', 139]] as const) {
    const other = io(() => new ScriptedExec((self) => (self.emit(text), self.end(code))));
    assert.equal((await askUsage(other, 'docker', 'ws1', DIR) as { unsupported?: boolean }).unsupported, undefined, JSON.stringify([text, code]));
  }
});

const hasTimeout = (() => {
  try {
    execFileSync('timeout', ['1', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('through the real shell wrapper, the process gets --safe-mode among its arguments; an old one that rejects it is told apart', { skip: hasTimeout ? false : 'needs GNU timeout' }, async () => {
  const bin = mkdtempSync(join(tmpdir(), 'cp-probe-shim-'));
  try {
    const args = join(bin, 'args.txt');
    // A stand-in `claude` that records its arguments and answers get_usage like a Claude Code with safe mode.
    writeFileSync(
      join(bin, 'claude'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\nread line\nid=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\\([^"]*\\)".*/\\1/p')\nprintf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"subscription_type":"max","rate_limits_available":true,"rate_limits":{"five_hour":{"utilization":10,"resets_at":"2026-10-12T05:00:00.000Z"}}}}}\\n' "$id"\n`,
    );
    chmodSync(join(bin, 'claude'), 0o755);
    const env = { HOME: bin, PATH: `${bin}:${process.env.PATH ?? ''}` };
    const ok = await probeClaude({ exec: localExec(env) }, 'local', 'x', '');
    assert.deepEqual([ok.runsOn, ok.failed, ok.windows.map((w) => w.key)], ['plan', false, ['session']]);
    const given = readFileSync(args, 'utf8').split('\n').filter(Boolean);
    assert.ok(given.includes(SAFE_MODE_FLAG), `the process was given: ${given.join(' ')}`);
    assert.deepEqual(given.slice(0, 1), ['-p']);

    // The same wrapper with a Claude Code from before 2.1.169: its parser rejects the flag and exits.
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "--safe-mode" ]; then echo "error: unknown option '--safe-mode'" >&2; exit 1; fi; done\necho started-without-safe-mode >&2\n`);
    const old = await probeClaude({ exec: localExec(env) }, 'local', 'x', '');
    assert.deepEqual([old.failed, old.problem, old.unsupported], [true, 'unreadable', true]);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
