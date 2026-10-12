import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import type { McpAuthEntry, McpCatalogEntry, McpServerAuth, McpWorkspaceStatus } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { FragmentProvider } from '../../delivery/reconciler.js';
import type { StepResult, WorkspaceStep, WorkspaceSteps } from '../../delivery/steps.js';
import { References } from '../../pools/references.js';
import { PoolService } from '../../pools/service.js';
import { generateSecretKey, parseSecretKey } from '../../store/secretBox.js';
import { Store } from '../../store/store.js';
import type { DeliveryAccess } from '../../workspaces/runtime.js';
import { McpSets } from '../index.js';
import { createOAuthRoutes } from './routes.js';
import { checkScript, type OAuthServer } from './status.js';
import { FakeLoginHost } from './testkit.js';

const WS = 'docker/lab';
const ACTOR = 'u_test';
const code = (c: string) => (e: unknown) => isAppError(e) && e.code === c;
const GET = (status: string, extra = '') => `  Scope: Dynamic config (from command line)\n  Status: ${status}\n${extra}  Type: http\n`;
const block = (name: string, body: string, exit = 0) => `<<<cp-auth>>>${name}\n${name}:\n${body}<<<cp-exit>>>${exit}\n`;

/** A fake workspace: `run` answers like `claude mcp get/logout` from `states`, and records every script. */
function fakeAccess(states: Record<string, string>) {
  const scripts: string[] = [];
  let running = true;
  const access: DeliveryAccess = {
    state: async () => ({ exists: true, running }),
    run: async (_name, script) => {
      scripts.push(script);
      if (/claude mcp logout '([^']+)'/.test(script)) {
        const name = /claude mcp logout '([^']+)'/.exec(script)![1]!;
        states[name] = '! Needs authentication';
        return { code: 0, stdout: `Signed out of "${name}".\n<<<cp-exit>>>0\n`, stderr: '' };
      }
      const names = [...script.matchAll(/claude mcp get '([^']+)'/g)].map((m) => m[1]!);
      return { code: 0, stdout: names.map((n) => block(n, GET(states[n] ?? '✔ Connected'))).join(''), stderr: '' };
    },
    put: async () => undefined,
    read: async () => null,
    watchStarts: () => () => undefined,
  };
  return { access, scripts, stop: () => (running = false), states };
}

async function setup(states: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-mcp-oauth-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const providers: FragmentProvider[] = [];
  const pools = new PoolService(store, { providers });
  const references = new References();
  references.provideSecretNames({ namesFor: () => new Map() });
  const queued: { ws: string; step: WorkspaceStep }[] = [];
  const steps = { enqueue: (ws: string, list: WorkspaceStep[]) => list.forEach((step) => queued.push({ ws, step })), queued: () => [] } as unknown as WorkspaceSteps;
  const fake = fakeAccess(states);
  const mcp = new McpSets(store, pools, references, () => fake.access, { resolveDns: false, steps });
  const host = new FakeLoginHost();
  mcp.oauth.host = host;
  const claudes = new Map([['c1', 'claudes/0123456789abcdef']]);
  mcp.oauth.claudeDirectory = (ws, id) => (ws === WS ? (claudes.get(id) ?? null) : null);
  const provider = providers.find((p) => p.type === 'mcpset')!;
  const changes: number[] = [];
  const onChange = pools.onChange.bind(pools);
  pools.onChange = () => (changes.push(1), onChange());
  return { store, pools, mcp, provider, fake, host, queued, changes, done: () => (host.done(), store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}
type H = Awaited<ReturnType<typeof setup>>;

async function oauthEntry(h: H, key: string, auth: 'oauth' | 'headers' = 'oauth', url = `https://${key}.example.com/mcp`): Promise<McpCatalogEntry> {
  const e = await h.mcp.catalog.create({
    key,
    displayName: `Server ${key}`,
    kind: 'remote',
    spec: { url, auth, ...(auth === 'oauth' ? { oauth: { clientId: 'pub-1', callbackPort: 24819, scopes: ['read', 'write'] } } : {}) },
    slots: auth === 'headers' ? [{ name: 'Authorization', target: 'header', secret: false, required: false, default: 'x' }] : [],
  });
  return h.mcp.catalog.approve(e.id, e.versions[0]!.id, { reviewed: true });
}

/** A set with these entries, assigned to WS and compiled (so `mcp_delivery` has its rows). */
async function deliver(h: H, entries: McpCatalogEntry[], name = 'Lab') {
  const servers = entries.map((e) => ({ key: e.key, entry: e.id, version: e.versions[0]!.version, enabled: true, config: {}, secrets: {} }));
  const set = h.pools.create('mcpset', { name, content: { servers } });
  h.pools.setAssignments(WS, 'mcpset', [{ poolId: set.id }]);
  const fragments = h.provider.fragments(WS, { running: true, now: new Date() });
  return { set, fragments };
}

const plugin = 'cpm-lab';

test('status: only OAuth servers carry auth; it is unknown until Claude Code has been asked, then its word', async () => {
  const h = await setup();
  try {
    const a = await oauthEntry(h, 'gitea');
    const b = await oauthEntry(h, 'plain', 'headers');
    await deliver(h, [a, b]);
    const before = h.mcp.status(WS).servers;
    assert.equal(before.find((s) => s.key === 'plain')!.auth, null);
    assert.deepEqual(before.find((s) => s.key === 'gitea')!.auth, { mode: 'oauth', state: 'unknown', detail: null, checkedAt: null });
    assert.deepEqual(h.mcp.oauthServers(WS), [{ plugin, key: 'gitea', name: 'Server gitea' }]);

    h.fake.states['plugin:cpm-lab:gitea'] = '! Needs authentication';
    const entries = await h.mcp.oauth.check(WS, '');
    assert.deepEqual(entries.map((e) => [e.plugin, e.key, e.auth.state]), [[plugin, 'gitea', 'needs_sign_in']]);
    assert.equal(h.mcp.status(WS).servers.find((s) => s.key === 'gitea')!.auth!.state, 'needs_sign_in');
    assert.ok(h.changes.length > 0, 'the status page is told');
    // Only the OAuth server was asked, by its name as Claude Code has it.
    assert.match(h.fake.scripts.at(-1)!, /claude mcp get 'plugin:cpm-lab:gitea'/);
    assert.ok(!/plain/.test(h.fake.scripts.at(-1)!));
  } finally {
    h.done();
  }
});

test('check: a failure keeps Claude Code’s reason, a server it doesn’t list is "unknown", a stopped workspace is refused', async () => {
  const h = await setup({ 'plugin:cpm-lab:a': '✘ Failed to connect', 'plugin:cpm-lab:b': '✔ Connected' });
  try {
    const a = await oauthEntry(h, 'a');
    const b = await oauthEntry(h, 'b');
    await deliver(h, [a, b]);
    const run = h.fake.access.run;
    h.fake.access.run = async (name, script, opts) => {
      const r = await run(name, script, opts);
      return { ...r, stdout: r.stdout.replace('  Status: ✘ Failed to connect\n', '  Status: ✘ Failed to connect\n  Issue: Incompatible auth server: does not support dynamic client registration\n') };
    };
    const got = await h.mcp.oauth.check(WS, '');
    assert.deepEqual(got.map((e) => [e.key, e.auth.state, e.auth.detail]), [
      ['a', 'failed', 'Incompatible auth server: does not support dynamic client registration'],
      ['b', 'connected', null],
    ]);
    h.fake.access.run = async () => ({ code: 0, stdout: '<<<cp-auth>>>plugin:cpm-lab:a\nNo MCP server named "plugin:cpm-lab:a". Configured servers: x\n<<<cp-exit>>>1\n', stderr: '' });
    const one = await h.mcp.oauth.check(WS, '', { plugin, key: 'a' });
    assert.deepEqual(one.map((e) => [e.key, e.auth.state, e.auth.detail]), [['a', 'unknown', 'Claude Code hasn’t loaded this server yet.']]);
    h.fake.stop();
    await assert.rejects(() => h.mcp.oauth.check(WS, ''), code('CONFLICT'));
    await assert.rejects(() => h.mcp.oauth.check(WS, '', { plugin, key: 'nope' }), code('NOT_FOUND'));
  } finally {
    h.done();
  }
});

test('check: a Claude other than Default is asked in its own folder, and keeps its own state', async () => {
  const h = await setup();
  try {
    await deliver(h, [await oauthEntry(h, 'gitea')]);
    h.fake.states['plugin:cpm-lab:gitea'] = '! Needs authentication';
    await h.mcp.oauth.check(WS, 'claudes/0123456789abcdef');
    assert.match(h.fake.scripts.at(-1)!, /export CLAUDE_CONFIG_DIR="\$HOME\/\.claudepilot\/claudes\/0123456789abcdef"/);
    assert.equal(h.mcp.oauth.list(WS, 'claudes/0123456789abcdef')[0]!.auth.state, 'needs_sign_in');
    assert.equal(h.mcp.oauth.list(WS, '')[0]!.auth.state, 'unknown', 'Default was not asked');
    assert.equal(h.mcp.oauth.dirOf(WS, 'c1'), 'claudes/0123456789abcdef');
    assert.equal(h.mcp.oauth.dirOf(WS, undefined), '');
    assert.throws(() => h.mcp.oauth.dirOf(WS, 'nope'), code('NOT_FOUND'));
    assert.ok(!/CLAUDE_CONFIG_DIR/.test(checkScript([{ plugin, key: 'gitea', name: 'x' }], '')), 'Default sets nothing');
  } finally {
    h.done();
  }
});

test('after a delivery: the check is queued once, again after 15 minutes, sooner when it could not tell, and when the server changed', async () => {
  const h = await setup();
  try {
    await deliver(h, [await oauthEntry(h, 'gitea')]);
    const compiled = (h.mcp.kind as unknown as { compileFor(ws: string): unknown }).compileFor(WS) as { plugins: { plugin: string; hash12: string }[]; servers: unknown[] };
    const c = { ...compiled, workspaceId: WS } as Parameters<typeof h.mcp.oauth.steps>[0];
    const t0 = new Date('2026-10-12T10:00:00Z');
    const first = h.mcp.oauth.steps(c, t0);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.owner, 'mcpset');
    assert.equal(first[0]!.key, 'auth:default');
    // The step's own script and its answer.
    h.fake.states['plugin:cpm-lab:gitea'] = '✔ Connected';
    const out = await h.fake.access.run('lab', first[0]!.script);
    first[0]!.done!({ ...out, timedOut: false, ms: 1 } as StepResult);
    assert.equal(h.mcp.oauth.list(WS, '')[0]!.auth.state, 'connected');
    const checked = Date.parse(h.mcp.oauth.list(WS, '')[0]!.auth.checkedAt!);
    const at = (min: number) => new Date(checked + min * 60_000);
    assert.equal(h.mcp.oauth.steps(c, at(5)).length, 0, 'fresh');
    assert.equal(h.mcp.oauth.steps(c, at(16)).length, 1, 'old');
    // A different plugin folder (the server changed) is asked at once.
    const changed = { ...c, plugins: c.plugins.map((p) => ({ ...p, hash12: 'ffffffffffff' })) };
    assert.equal(h.mcp.oauth.steps(changed, at(1)).length, 1);
    // "Can't tell" is asked again after 2 minutes.
    h.mcp.oauth.status.set(WS, '', { plugin, key: 'gitea' }, 'unknown', 'Claude Code didn’t answer in time.', new Date(checked), c.plugins[0]!.hash12);
    assert.equal(h.mcp.oauth.steps(c, at(1)).length, 0);
    assert.equal(h.mcp.oauth.steps(c, at(3)).length, 1);
    // A step that didn't run (the workspace stopped) changes nothing.
    const before = JSON.stringify(h.mcp.oauth.list(WS, ''));
    first[0]!.done!({ code: null, stdout: '', stderr: '', timedOut: false, skipped: 'not running', ms: 0 });
    assert.equal(JSON.stringify(h.mcp.oauth.list(WS, '')), before);
  } finally {
    h.done();
  }
});

test('seen: a chat session’s system/init is Claude Code’s word for that Claude; servers that need a sign-in come back', async () => {
  const h = await setup();
  try {
    await deliver(h, [await oauthEntry(h, 'gitea'), await oauthEntry(h, 'cf')]);
    const needs = h.mcp.oauth.seen(WS, 'claudes/0123456789abcdef', [
      { name: 'plugin:cpm-lab:gitea', status: 'needs-auth' },
      { name: 'plugin:cpm-lab:cf', status: 'connected' },
      { name: 'plugin:cpm-lab:unknown', status: 'needs-auth' },
      { name: 'plugin:cpm-other:gitea', status: 'failed' },
    ]);
    assert.deepEqual(needs, [{ plugin, key: 'gitea', name: 'Server gitea' }]);
    const entries = h.mcp.oauth.list(WS, 'claudes/0123456789abcdef');
    assert.deepEqual(entries.map((e) => [e.key, e.auth.state]), [['cf', 'connected'], ['gitea', 'needs_sign_in']]);
    assert.deepEqual(h.mcp.oauth.seen(WS, '../x', [{ name: 'plugin:cpm-lab:gitea', status: 'connected' }]), []);
  } finally {
    h.done();
  }
});

test('sign-out asks Claude Code to log out, then asks where the server stands', async () => {
  const h = await setup();
  try {
    await deliver(h, [await oauthEntry(h, 'gitea')]);
    const auth = await h.mcp.oauth.signOut(WS, 'claudes/0123456789abcdef', { plugin, key: 'gitea' }, ACTOR);
    assert.equal(auth.state, 'needs_sign_in');
    const logout = h.fake.scripts.find((s) => /mcp logout/.test(s))!;
    assert.match(logout, /export CLAUDE_CONFIG_DIR="\$HOME\/\.claudepilot\/claudes\/0123456789abcdef"/);
    assert.match(logout, /claude mcp logout 'plugin:cpm-lab:gitea'/);
    h.fake.access.run = async () => ({ code: 1, stdout: 'No MCP server named "x"\n<<<cp-exit>>>1\n', stderr: '' });
    await assert.rejects(() => h.mcp.oauth.signOut(WS, '', { plugin, key: 'gitea' }, ACTOR), (e) => isAppError(e) && /didn’t sign out/.test(e.message));
    await assert.rejects(() => h.mcp.oauth.signOut(WS, '', { plugin: 'cpm-lab; x', key: 'gitea' }, ACTOR), code('VALIDATION_FAILED'));
  } finally {
    h.done();
  }
});

test('guided sign-in end to end: start, paste, and the state Claude Code reports afterwards', async () => {
  const h = await setup();
  try {
    await deliver(h, [await oauthEntry(h, 'ok')]);
    // The fake login's server name picks its behaviour; this set's plugin is cpm-lab, so serve it as "ok" through a rename.
    const origShell = h.host.shell.bind(h.host);
    h.host.shell = (t, n, s, command) => origShell(t, n, s, command && [...command.slice(0, -1), 'plugin:cpm-ok:ok']);
    h.fake.states['plugin:cpm-lab:ok'] = '! Needs authentication';
    const start = await h.mcp.oauth.signIn(WS, '', { plugin, key: 'ok' }, ACTOR);
    assert.match(start.url, /^https:\/\//);
    const redirect = `${start.callback}?code=goodcode&state=${new URL(start.url).searchParams.get('state')}`;
    h.fake.states['plugin:cpm-lab:ok'] = '✔ Connected'; // what Claude Code says once the login ran
    const auth: McpServerAuth = await h.mcp.oauth.complete(WS, start.signInId, redirect, ACTOR);
    assert.equal(auth.state, 'connected');
    assert.equal(h.mcp.status(WS).servers[0]!.auth!.state, 'connected');
    await assert.rejects(() => h.mcp.oauth.signIn(WS, '', { plugin, key: 'nope' }, ACTOR), code('NOT_FOUND'));
    h.fake.stop();
    await assert.rejects(() => h.mcp.oauth.signIn(WS, '', { plugin, key: 'ok' }, ACTOR), code('CONFLICT'));
  } finally {
    h.done();
  }
});

test('audit: sign-in start, finish, end and sign-out are recorded with the actor, in words and ids only', async () => {
  const h = await setup();
  try {
    await deliver(h, [await oauthEntry(h, 'ok')]);
    const origShell = h.host.shell.bind(h.host);
    h.host.shell = (t, n, s, command) => origShell(t, n, s, command && [...command.slice(0, -1), 'plugin:cpm-ok:ok']);
    const dir = 'claudes/0123456789abcdef';
    const first = await h.mcp.oauth.signIn(WS, '', { plugin, key: 'ok' }, 'u_alice');
    await h.mcp.oauth.cancel(WS, first.signInId, 'u_bob'); // another person closes it
    const second = await h.mcp.oauth.signIn(WS, dir, { plugin, key: 'ok' }, 'u_alice');
    const redirect = `${second.callback}?code=goodcode&state=${new URL(second.url).searchParams.get('state')}`;
    await h.mcp.oauth.complete(WS, second.signInId, redirect, 'u_carol'); // a third person pastes it
    await h.mcp.oauth.signOut(WS, dir, { plugin, key: 'ok' }, 'u_alice');
    const rows = (h.store.db!.prepare("SELECT type, workspace_id, details FROM mcp_events WHERE type LIKE 'oauth_%' ORDER BY id").all() as { type: string; workspace_id: string; details: string }[]).map((r) => ({
      type: r.type,
      ws: r.workspace_id,
      ...(JSON.parse(r.details) as Record<string, unknown>),
    }));
    assert.deepEqual(rows, [
      { type: 'oauth_signin_started', ws: WS, actor: 'u_alice', server: 'cpm-lab/ok', claude: 'default' },
      { type: 'oauth_signin_ended', ws: WS, actor: 'u_bob', startedBy: 'u_alice', reason: 'cancelled', server: 'cpm-lab/ok', claude: 'default' },
      { type: 'oauth_signin_started', ws: WS, actor: 'u_alice', server: 'cpm-lab/ok', claude: dir },
      { type: 'oauth_signed_in', ws: WS, actor: 'u_carol', startedBy: 'u_alice', via: 'paste', state: 'connected', server: 'cpm-lab/ok', claude: dir },
      { type: 'oauth_signed_out', ws: WS, actor: 'u_alice', server: 'cpm-lab/ok', claude: dir },
    ]);
    const all = JSON.stringify(rows);
    assert.ok(!/goodcode|localhost|https?:|state=/.test(all), 'no address, code or URL in the audit');
    // A start that fails leaves its end, not a start.
    h.host.shell = (t, n, s, command) => origShell(t, n, s, command && [...command.slice(0, -1), 'plugin:cpm-nourl:ok']);
    await assert.rejects(() => h.mcp.oauth.signIn(WS, '', { plugin, key: 'ok' }, 'u_alice'), /Incompatible auth server/);
    const last = h.store.db!.prepare("SELECT type, details FROM mcp_events WHERE type LIKE 'oauth_%' ORDER BY id DESC LIMIT 1").get() as { type: string; details: string };
    assert.equal(last.type, 'oauth_signin_ended');
    assert.equal((JSON.parse(last.details) as { reason: string }).reason, 'failed');
  } finally {
    h.done();
  }
});

test('routes: the guided sign-in over HTTP; the pasted address is read from the body only and never echoed', async () => {
  const h = await setup();
  try {
    await deliver(h, [await oauthEntry(h, 'ok')]);
    const origShell = h.host.shell.bind(h.host);
    h.host.shell = (t, n, s, command) => origShell(t, n, s, command && [...command.slice(0, -1), 'plugin:cpm-ok:ok']);
    const app = new Hono();
    // The portal's own error mapping (app.ts): an AppError answers with its status.
    app.onError((e, c) => {
      const error = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
      return c.json(error.toJSON(), error.status as ContentfulStatusCode);
    });
    app.route('/', createOAuthRoutes(h.mcp.oauth));
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/workspaces/docker/lab${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, text: await res.text() };
    };
    const list = await call('GET', '/auth');
    assert.equal(list.status, 200);
    assert.deepEqual((JSON.parse(list.text).data as McpAuthEntry[]).map((e) => [e.key, e.auth.state]), [['ok', 'unknown']]);
    assert.equal((await call('GET', '/auth?claude=nope')).status, 404);
    assert.equal((await call('GET', '/auth?claude=c1')).status, 200);

    const started = await call('POST', '/signin', { plugin, key: 'ok' });
    assert.equal(started.status, 200, started.text);
    const start = JSON.parse(started.text).data as { signInId: string; url: string; callback: string };
    assert.equal((await call('POST', '/signin/not-an-id/complete', { redirectUrl: 'x' })).status, 404);
    const secret = 'sUp3rS3cretC0de';
    const refused = await call('POST', `/signin/${start.signInId}/complete`, { redirectUrl: `http://localhost:9/callback?code=${secret}&state=x` });
    assert.equal(refused.status, 422);
    assert.ok(!refused.text.includes(secret), 'the code is not echoed back');
    const missing = await call('POST', `/signin/${start.signInId}/complete`, {});
    assert.equal(missing.status, 422);
    const done = await call('POST', `/signin/${start.signInId}/complete`, { redirectUrl: `${start.callback}?code=goodcode&state=${new URL(start.url).searchParams.get('state')}` });
    assert.equal(done.status, 200, done.text);
    assert.equal((JSON.parse(done.text).data as McpServerAuth).mode, 'oauth');
    const again = await call('DELETE', `/signin/${start.signInId}`);
    assert.equal(again.status, 200, 'cancelling a finished sign-in is fine');
    assert.equal((await call('POST', '/signout', { plugin, key: 'ok' })).status, 200);
    assert.equal((await call('POST', '/auth', {})).status, 200);
  } finally {
    h.done();
  }
});

test('forgetting a workspace drops its states and ends its sign-ins', async () => {
  const h = await setup();
  try {
    await deliver(h, [await oauthEntry(h, 'ok')]);
    await h.mcp.oauth.check(WS, '');
    assert.equal(h.mcp.oauth.list(WS, '')[0]!.auth.state, 'connected');
    h.mcp.kind.forgetWorkspace(WS);
    assert.equal(h.mcp.oauth.list(WS, '')[0]?.auth.state ?? 'unknown', 'unknown');
  } finally {
    h.done();
  }
});

test('the status contract: McpWorkspaceStatus servers carry auth only for OAuth', async () => {
  const h = await setup();
  try {
    await deliver(h, [await oauthEntry(h, 'ok'), await oauthEntry(h, 'plain', 'headers')]);
    const status: McpWorkspaceStatus = h.mcp.status(WS);
    assert.deepEqual(status.servers.map((s) => [s.key, s.auth?.mode ?? null]), [['ok', 'oauth'], ['plain', null]]);
  } finally {
    h.done();
  }
});

// Keep the unused-import guard honest: the helper type is part of this file's contract with status.ts.
void (null as unknown as OAuthServer);
