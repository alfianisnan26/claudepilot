// The canary's environment is an allowlist, never the portal's own (PLAN-2 A.11, docs/prd/claude-version-pinning.md §11): the real Claude Code CLI runs only
// inside the throwaway container, and nothing of the owner's Claude profile, messaging socket or SSH agent reaches it from the parent process.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Throwaway, ThrowawayAccess } from '../workspaces/runtime.js';
import { CanaryBox } from './canary/box.js';
import { CANARY_ENV_ALLOWED, canaryEnv } from './canary/env.js';

/** What a Claude Code session of the owner's has in its environment: none of it may reach the canary. */
const PARENT = {
  CLAUDE_CONFIG_DIR: '/home/owner/.claude-profiles/default',
  CLAUDE_CODE_MESSAGING_TOKEN: 'owner-messaging-token',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDECODE: '1',
  SSH_AUTH_SOCK: '/tmp/ssh-owner/agent.1',
  // Built at runtime: no token-shaped literal in the repository (push protection); the shape is what an owner's key looks like.
  ANTHROPIC_API_KEY: ['sk', 'ant', 'api03', 'OWNER-KEY-NOT-FOR-THE-CANARY'].join('-'),
  ANTHROPIC_AUTH_TOKEN: 'owner-auth-token',
  ANTHROPIC_BASE_URL: 'https://owner.example/anthropic',
  HTTPS_PROXY: 'http://owner-proxy:3128',
  NODE_EXTRA_CA_CERTS: '/etc/owner-ca.pem',
  KUBECONFIG: '/home/owner/.kube/config',
  GITHUB_TOKEN: ['gh', 'p_ownerToken'].join(''),
  HOME: '/home/owner',
  PATH: '/opt/owner/bin:/usr/bin',
} satisfies Record<string, string>;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [k, v] of Object.entries(PARENT)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('canaryEnv: nothing comes from process.env, whatever the parent holds', () => {
  const env = canaryEnv({ home: '/home/node', path: '/usr/local/bin:/usr/bin' });
  const serialized = JSON.stringify(env);
  for (const [k, v] of Object.entries(PARENT)) {
    if (k !== 'HOME' && k !== 'PATH') assert.ok(!(k in env), `${k} must not be in the canary environment`);
    if (v.length > 3) assert.ok(!serialized.includes(v), `the value of ${k} must not appear anywhere in it`);
  }
  assert.equal(env.HOME, '/home/node', 'the container’s home, not the parent’s');
  assert.equal(env.PATH, '/usr/local/bin:/usr/bin');
  assert.ok(Object.keys(env).every((k) => (CANARY_ENV_ALLOWED as readonly string[]).includes(k)), 'only allowlisted names');
  assert.deepEqual(Object.keys(env).sort(), ['DISABLE_ERROR_REPORTING', 'DISABLE_TELEMETRY', 'HOME', 'LANG', 'PATH', 'TERM']);
});

test('canaryEnv: the proxy and CA are the stand-in’s, given explicitly; an extra outside the allowlist is dropped', () => {
  const env = canaryEnv({
    home: '/home/node',
    path: '/bin',
    proxy: 'http://127.0.0.1:41000',
    ca: '/tmp/canary/state/pki/ca.pem',
    extra: { NO_PROXY: 'localhost', CLAUDE_CONFIG_DIR: '/home/node/.claudepilot/claudes/aaaaaaaaaaaaaaaa', SSH_AUTH_SOCK: '/evil', CLAUDECODE: '1', CLAUDE_CODE_MESSAGING_TOKEN: 'x', LD_PRELOAD: '/evil.so', ANTHROPIC_API_KEY: undefined },
  });
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:41000');
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/tmp/canary/state/pki/ca.pem');
  assert.equal(env.NO_PROXY, 'localhost');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/node/.claudepilot/claudes/aaaaaaaaaaaaaaaa', 'a check may name a Claude folder inside the container');
  for (const dropped of ['SSH_AUTH_SOCK', 'CLAUDECODE', 'CLAUDE_CODE_MESSAGING_TOKEN', 'LD_PRELOAD', 'ANTHROPIC_API_KEY']) assert.ok(!(dropped in env), `${dropped} is not an allowed extra`);
  assert.notEqual(env.HTTPS_PROXY, PARENT.HTTPS_PROXY);
});

/** A throwaway container that records everything the box asks of it. */
function fakeThrowaway() {
  const calls: { kind: string; script?: string; env?: Record<string, string>; command?: string[] }[] = [];
  const t: ThrowawayAccess = {
    start: async (): Promise<Throwaway> => ({ name: 'vc-canary-test' }),
    run: async (_n, script) => (calls.push({ kind: 'run', script }), { code: 0, stdout: '', stderr: '' }),
    put: async () => undefined,
    read: async () => null,
    exec: async (_n, command, opts) => {
      calls.push({ kind: 'exec', command, env: opts?.env });
      return { write: () => undefined, close: () => undefined, onData: () => undefined, onExit: () => undefined };
    },
    shell: async (_n, _s, command, opts) => {
      calls.push({ kind: 'shell', command, env: opts?.env });
      return { write: () => undefined, resize: () => undefined, close: () => undefined, onData: () => undefined, onExit: () => undefined };
    },
    isolate: async () => undefined,
    remove: async () => undefined,
    leftovers: async () => [],
  };
  return { t, calls };
}

test('the box: every run, exec and terminal carries the allowlisted environment and nothing from the parent', async () => {
  const { t, calls } = fakeThrowaway();
  const box = new CanaryBox(t, 'vc-canary-test', 'claude');
  box.proxy = 'http://127.0.0.1:41000';
  box.ca = '/tmp/canary/state/pki/ca.pem';
  await box.sh('claude --version');
  await box.exec(['claude', 'mcp', 'list']);
  await box.shell({ cols: 80, rows: 24 }, ['claude', 'mcp', 'login']);
  await box.stream(['--input-format', 'stream-json']);
  assert.equal(calls.length, 4);
  const everything = JSON.stringify(calls);
  for (const [k, v] of Object.entries(PARENT)) {
    if (k === 'HOME' || k === 'PATH') continue;
    if (v.length > 3) assert.ok(!everything.includes(v), `${k}'s value reached the container`);
    // The stand-in's proxy and CA are exported under the same names, with the stand-in's own values (the parent's values are checked above).
    if (k !== 'HTTPS_PROXY' && k !== 'NODE_EXTRA_CA_CERTS') assert.ok(!new RegExp(`export ${k}=`).test(everything), `${k} is exported into a script`);
  }
  for (const c of calls.filter((x) => x.kind !== 'run')) {
    assert.ok(c.env && Object.keys(c.env).every((k) => (CANARY_ENV_ALLOWED as readonly string[]).includes(k)), `${c.kind}: only allowlisted names (${Object.keys(c.env ?? {}).join(', ')})`);
    assert.equal(c.env!.HTTPS_PROXY, 'http://127.0.0.1:41000');
    assert.equal(c.env!.HOME, '/home/node');
  }
  const script = calls.find((c) => c.kind === 'run')!.script!;
  const exported = [...script.matchAll(/^export ([A-Z_]+)=/gm)].map((m) => m[1]);
  assert.ok(exported.every((k) => (CANARY_ENV_ALLOWED as readonly string[]).includes(k!)), `exported: ${exported.join(', ')}`);
});
