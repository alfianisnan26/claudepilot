import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Docker from 'dockerode';
import { config } from '../../config.js';
import { Reconciler, type FragmentProvider } from '../../delivery/reconciler.js';
import { claudePrint, startStandIn, STANDIN_DIR } from '../../pools/standin.js';
import { References } from '../../pools/references.js';
import { PoolService } from '../../pools/service.js';
import { generateSecretKey, parseSecretKey } from '../../store/secretBox.js';
import { Store } from '../../store/store.js';
import { DockerRuntime } from '../../workspaces/docker.js';
import { buildStandalone } from '../builtin/testkit/build.js';
import { McpSets } from '../index.js';
import type { OAuthHost } from './signin.js';

/**
 * MCP OAuth against a real Claude Code (MCP set PRD §13.3, Q2): the portal delivers an OAuth server into a throwaway
 * container from the workspace image, reads its state from `claude mcp get`, signs in through `claude mcp login`
 * in a terminal there, and a `claude -p` session against a scripted stand-in for the Anthropic API gets the
 * server's tools, and keeps getting them after the access token expired. The provider is the stand-in kit's
 * `gitea` preset (builtin/testkit): its own authorization server, OIDC discovery only, a pre-registered public
 * client, the redirect the Gitea template pins. A fake key, no network, no real account. Runs on the
 * Docker-in-Docker daemon with CLAUDEPILOT_DOCKER_TESTS=1, like skills/claude.integration.test.ts. Run it for each
 * Claude Code version before the pinned one moves: the parsers read its words.
 */
const enabled = process.env.CLAUDEPILOT_DOCKER_TESTS === '1';
const opts = { skip: enabled ? false : 'set CLAUDEPILOT_DOCKER_TESTS=1 to run against Docker' };
const socket = '/var/run/docker.sock';
const docker = new Docker({ socketPath: socket });
const runtime = new DockerRuntime({ id: 'docker', label: 'Docker', socket }, config.workspaces.dockerImage, config.workspaces.imageContext);
const d = runtime.delivery;
// Not labelled as a managed workspace: other portals on this daemon must not list a test container.
const name = `pl-it-oa-${randomBytes(3).toString('hex')}`;
const WS = `docker/${name}`;
const TOOL = 'mcp__plugin_cpm-lab_gitea__whoami';

before(async () => {
  if (!enabled) return;
  const c = await docker.createContainer({ name: `claudepilot-${name}`, Image: config.workspaces.dockerImage, User: 'node', Labels: { 'claudepilot.test': 'true' } });
  await c.start();
});
after(async () => {
  if (!enabled) return;
  await docker.getContainer(`claudepilot-${name}`).remove({ force: true }).catch(() => undefined);
});

test('OAuth on a real Claude Code: status after delivery, guided sign-in, tools in a session, refresh, sign-out', { ...opts, timeout: 420_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-mcp-oauth-it-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const providers: FragmentProvider[] = [];
  const pools = new PoolService(store, { providers });
  const references = new References();
  references.provideSecretNames({ namesFor: () => new Map() });
  const mcp = new McpSets(store, pools, references, () => d, { resolveDns: false });
  mcp.oauth.host = { shell: (_t, n, size, cmd) => runtime.shell(n, size, cmd), exec: (_t, n, cmd) => runtime.exec(n, cmd) } satisfies OAuthHost;
  const reconciler = new Reconciler(store, () => runtime, () => [runtime], providers);
  const run = (script: string) => d.run(name, script, { user: 'node' });
  /** Whether the newest model request the stand-in recorded offered the tool. (Read with `grep` in the container: `recorded()` leaves its archive socket open.) */
  const offered = async () => (await run(`tail -n 1 ${STANDIN_DIR}/requests.jsonl | grep -c '"${TOOL}"'`)).stdout.trim() === '1';
  try {
    // The stand-in provider, in the container: the kit as one script (`gitea` preset: resource on 4601, its own authorization server on 4602).
    await d.put(name, [{ path: '/tmp/standin.cjs', type: 'file', content: buildStandalone(), mode: 0o755, uid: 1000, gid: 1000 }]);
    await run('cd /tmp && (nohup node standin.cjs --preset gitea --port 4601 --auth-port 4602 --public-host localhost --control >standin.out 2>&1 &) && sleep 2');
    const ready = JSON.parse(((await run('head -n 1 /tmp/standin.out')).stdout || '{}').trim()) as { ready?: boolean; url?: string };
    assert.equal(ready.ready, true, 'the stand-in provider is up');
    const control = async (method: string, path: string, body?: unknown) =>
      JSON.parse((await run(`curl -s -X ${method} -H 'content-type: application/json' ${body === undefined ? '' : `-d '${JSON.stringify(body)}'`} http://127.0.0.1:4601/__standin${path}`)).stdout || '{}') as Record<string, unknown>;

    // A catalog entry for it, as the Gitea template makes one: a pre-registered client, the pinned callback port, scopes.
    const entry = await mcp.catalog.create({
      key: 'gitea',
      displayName: 'Stand-in Gitea',
      kind: 'remote',
      spec: { url: 'http://localhost:4601/mcp', transport: 'http', auth: 'oauth', allowPrivateNetwork: true, oauth: { clientId: 'standin-gitea-client', callbackPort: 24819, scopes: ['write:repository', 'write:issue'] } },
    });
    mcp.catalog.approve(entry.id, entry.versions[0]!.id, { reviewed: true });
    const set = pools.create('mcpset', { name: 'Lab', content: { slug: 'lab', servers: [{ key: 'gitea', entry: entry.id, version: 'v1', enabled: true, config: {}, secrets: {} }] } });
    pools.setAssignments(WS, 'mcpset', [{ poolId: set.id }]);
    await reconciler.request(WS, 'test');
    assert.equal(reconciler.row(WS)?.status, 'synced', reconciler.row(WS)?.reason ?? '');
    await mcp.steps.idle(WS);

    // `.mcp.json` carries the scopes as ONE string (a list would make Claude Code drop the server without a word).
    const mcpJson = (await run('cat /etc/claudepilot/marketplace/plugins/cpm-lab/*/.mcp.json')).stdout;
    assert.match(mcpJson, /"scopes": "write:repository write:issue"/);

    // 1. After the delivery, the portal asked Claude Code: it needs a sign-in.
    const status = mcp.status(WS).servers[0]!;
    assert.equal(status.auth?.state, 'needs_sign_in', JSON.stringify(status.auth));

    // A session meanwhile runs without the server's tools.
    await startStandIn(d, name);
    assert.equal((await claudePrint(d, name, 'before the sign-in')).code, 0);
    assert.ok(!(await offered()), 'no tools before the sign-in');

    // 2. The guided sign-in: the provider's page, as Claude Code printed it; a wrong paste is refused; the right one finishes it.
    const start = await mcp.oauth.signIn(WS, '', { plugin: 'cpm-lab', key: 'gitea' }, 'u_it');
    const url = new URL(start.url);
    assert.equal(url.origin, 'http://localhost:4602', 'the provider’s own authorization server');
    assert.equal(url.searchParams.get('client_id'), 'standin-gitea-client');
    assert.equal(url.searchParams.get('scope'), 'write:repository write:issue', 'pinned scopes win');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:24819/callback');
    assert.equal(start.callback, 'http://localhost:24819/callback');
    await assert.rejects(() => mcp.oauth.complete(WS, start.signInId, 'not an address', 'u_it'), /isn’t an address/);
    await assert.rejects(() => mcp.oauth.complete(WS, start.signInId, `${start.callback}?code=abc&state=WRONG`, 'u_it'), /doesn’t accept that address/);
    // The browser, played from inside the container: the provider approves and sends it to the callback address.
    const hop = (await run(`curl -s -o /dev/null -D - '${start.url}' | grep -i '^location' | cut -d' ' -f2-`)).stdout.trim();
    assert.ok(hop.startsWith('http://localhost:24819/callback?code='), hop.replace(/code=[^&]*/, 'code=…'));
    const auth = await mcp.oauth.complete(WS, start.signInId, hop, 'u_it');
    assert.equal(auth.state, 'connected', JSON.stringify(auth));
    assert.equal(mcp.status(WS).servers[0]!.auth?.state, 'connected');
    assert.equal(mcp.oauth.signIns.count(), 0, 'no login is left');
    assert.equal((await run('ps -eo args | grep -c "[c]laude mcp login"')).stdout.trim(), '0');

    // 3. A session now gets the server's tools: Claude Code signed in by `claude mcp login` is the one that runs `-p`.
    assert.equal((await claudePrint(d, name, 'after the sign-in')).code, 0);
    assert.ok(await offered(), 'the OAuth server’s tool is offered');

    // 4. The access token expires; the next session refreshes it by itself and still has the tools.
    const before = (await control('GET', '/state')) as { requests?: unknown[] };
    await control('POST', '/advance', { ms: 3 * 3600_000 });
    assert.equal((await claudePrint(d, name, 'after the token expired')).code, 0);
    assert.ok(await offered(), 'tools after a refresh');
    const refreshed = JSON.stringify((await control('GET', '/state')).requests ?? []);
    assert.match(refreshed, /refresh_token/, 'Claude Code used the refresh grant');
    void before;

    // 5. The portal never held anything: no file of the delivery, no log, no state holds a code or a token.
    const leaks = (await run(`grep -rlE 'code=[A-Za-z0-9_-]{16,}' /etc/claudepilot /etc/claude-code 2>/dev/null | head -3`)).stdout.trim();
    assert.equal(leaks, '', 'nothing delivered holds an authorization code');

    // 6. Sign-out: Claude Code's own `claude mcp logout`; a session has no tools again.
    const out = await mcp.oauth.signOut(WS, '', { plugin: 'cpm-lab', key: 'gitea' }, 'u_it');
    assert.equal(out.state, 'needs_sign_in', JSON.stringify(out));
    // Each act left an audit event with its actor, and none holds an address or a code.
    const events = (store.db!.prepare("SELECT type, details FROM mcp_events WHERE type LIKE 'oauth_%' ORDER BY id").all() as { type: string; details: string }[]).map((e) => `${e.type}:${(JSON.parse(e.details) as { actor: string }).actor}`);
    assert.deepEqual(events, ['oauth_signin_started:u_it', 'oauth_signed_in:u_it', 'oauth_signed_out:u_it']);
    assert.ok(!/code=|localhost/.test(JSON.stringify(store.db!.prepare("SELECT details FROM mcp_events WHERE type LIKE 'oauth_%'").all())));
    assert.equal((await claudePrint(d, name, 'after the sign-out')).code, 0);
    assert.ok(!(await offered()), 'no tools after the sign-out');
  } finally {
    reconciler.stop();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
