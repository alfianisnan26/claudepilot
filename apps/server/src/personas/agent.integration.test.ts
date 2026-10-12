import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { serve } from '@hono/node-server';
import { emptyPersona, type PersonaContent } from '@portal/contracts';
import Docker from 'dockerode';
import sharp from 'sharp';
import { config } from '../config.js';
import { Reconciler, type FragmentProvider } from '../delivery/reconciler.js';
import { internalUrlResolver } from '../portalmcp/internalUrl.js';
import { PortalMcpModule } from '../portalmcp/module.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { createPortalMcpEndpoint } from '../portalmcp/routes.js';
import { PoolService } from '../pools/service.js';
import { recorded, startStandIn, STANDIN_ENV, textOf } from '../pools/standin.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { DockerRuntime } from '../workspaces/docker.js';
import { Personas } from './index.js';
import { registerPersonaTools } from './portalTools.js';
import { readSessionBlob } from './sessionBlobs.js';
import { readWorkspaceFile } from './workspaceFiles.js';

/**
 * Interface I11 on a real Claude Code (Persona PRD A10): a session proposes changes to its own persona through the
 * portal's MCP endpoint with its per-session token, and a person approves them. The portal side is real (store, pool
 * service, delivery engine, the MCP endpoint over HTTP, the persona tools); the container is the workspace image, whose
 * `claude` talks to a scripted stand-in for the Anthropic API (a fake key, no sign-in) that makes the tool calls.
 * Runs with CLAUDEPILOT_DOCKER_TESTS=1.
 */
const enabled = process.env.CLAUDEPILOT_DOCKER_TESTS === '1';
const opts = { skip: enabled ? false : 'set CLAUDEPILOT_DOCKER_TESTS=1 to run against Docker' };
const socket = '/var/run/docker.sock';
const docker = new Docker({ socketPath: socket });
const runtime = new DockerRuntime({ id: 'docker', label: 'Docker', socket }, config.workspaces.dockerImage, config.workspaces.imageContext);
const d = runtime.delivery;
const name = `pe-ag-${randomBytes(3).toString('hex')}`;
const WS = `docker/${name}`;
const SESSION = 'sess-agent-1';
const SESSION2 = 'sess-agent-2';
const PROJECT = '/home/node/work/proj';

before(async () => {
  if (!enabled) return;
  const c = await docker.createContainer({ name: `claudepilot-${name}`, Image: config.workspaces.dockerImage, User: 'node', Labels: { 'claudepilot.test': 'true' }, HostConfig: { Memory: 1536 * 1024 * 1024 } });
  await c.start();
});
after(async () => {
  if (!enabled) return;
  await docker.getContainer(`claudepilot-${name}`).remove({ force: true }).catch(() => undefined);
  // The docker client keeps sockets open after its last call: end the process once the results are written.
  setTimeout(() => process.exit(0), 1500).unref();
});

test('I11 on a real Claude Code: a session reads and proposes changes to its own persona over MCP, hostile images are refused, nothing is live until a person approves, and the approved text reaches the workspace', { ...opts, timeout: 300_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-persona-agent-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const providers: FragmentProvider[] = [];
  const pools = new PoolService(store, { providers });
  const personas = new Personas(store, pools);
  personas.agentSelfEdit = () => true;
  const reconciler = new Reconciler(store, () => runtime, () => [runtime], providers);
  pools.reconciler = reconciler;
  const registry = new ToolRegistry();
  registerPersonaTools(personas, { readWorkspaceFile: (ws, p, max) => readWorkspaceFile(() => runtime, ws, p, max), readSessionBlob: (s, b, max) => readSessionBlob(store, s, b, max) }, registry);

  // The portal's /mcp endpoint over real HTTP, as a workspace reaches it: on the machine's address, not loopback.
  let mcpUrl: string | null = null;
  const module = new PortalMcpModule(store, { registry, agentHost: { alive: (id) => id === SESSION || id === SESSION2, url: () => mcpUrl } });
  module.settings.update({ enabled: true });
  module.agents.setEnabled(WS, true);
  const server = serve({ fetch: createPortalMcpEndpoint(module).fetch, port: 0, hostname: '0.0.0.0' });
  await new Promise<void>((ok) => server.once('listening', ok));
  const port = (server.address() as AddressInfo).port;

  try {
    const instructions = '# Role\nYou review pull requests.\nBe terse.\n\nNever guess.';
    const reviewer = pools.create('persona', { name: 'Reviewer', description: 'Reviews', content: { ...emptyPersona(), instructions } satisfies PersonaContent });
    const writer = pools.create('persona', { name: 'Writer', content: { ...emptyPersona(), instructions: 'You write docs.' } satisfies PersonaContent });
    pools.setAssignments(WS, 'persona', [{ poolId: reviewer.id }]);
    personas.identity.setPolicy(reviewer.id, { agentsMayPropose: true });
    await reconciler.request(WS, 'test');
    await reconciler.request(WS, 'test');
    assert.equal(reconciler.row(WS)?.status, 'synced', reconciler.row(WS)?.reason ?? '');

    // The workspace's side: the files an agent may offer, and the stand-in that scripts its calls.
    const url = await internalUrlResolver({ workspaces: { runtimeFor: () => runtime } as never, port, configured: null })(WS);
    assert.match(url ?? '', /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/mcp$/, 'the portal is reachable from the workspace');
    mcpUrl = url;
    const grant = await module.agents.mint({ workspaceId: WS, sessionId: SESSION });
    assert.ok(grant);
    const face = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#c0392b' } }).png().toBuffer();
    const png = (data: Buffer) => data.toString('base64');
    await d.run(name, `mkdir -p ${PROJECT} && cd /home/node && printf %s '${png(face)}' | base64 -d > avatar.png && printf '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' > hostile.png && head -c 4194304 /dev/zero > huge.png && head -c 300 avatar.png > corrupt.png`, { user: 'node' });
    const tools = ['persona_get_self', 'persona_propose_update', 'persona_set_avatar_proposal'].map((t) => `mcp__pilot__${t}`);
    const call = (tool: string, input: unknown) => ({ tool: `mcp__pilot__${tool}`, input });
    await startStandIn(d, name, [
      call('persona_get_self', {}),
      call('persona_propose_update', { name: 'Careful reviewer', instructions_patch: { replace: [{ find: 'Be terse.', with: 'Be terse, and say why.' }] }, reason: 'Reasons make reviews easier to act on.' }),
      call('persona_set_avatar_proposal', { workspace_path: '~/avatar.png', reason: 'A friendly face.' }),
      call('persona_set_avatar_proposal', { workspace_path: '~/hostile.png', reason: 'Another one.' }),
      call('persona_set_avatar_proposal', { workspace_path: '~/corrupt.png', reason: 'Another one.' }),
      call('persona_set_avatar_proposal', { workspace_path: '~/huge.png', reason: 'Another one.' }),
      call('persona_set_avatar_proposal', { workspace_path: '/etc/passwd', reason: 'Another one.' }),
      // Naming another persona and another workspace changes nothing: the token says who it is.
      call('persona_propose_update', { name: 'Hijacked', reason: 'x', persona_id: writer.id, workspace_id: 'docker/elsewhere', session_id: 'sess-someone-else' }),
      { text: 'All done.' },
    ]);

    const env = Object.entries(grant!.env).map(([k, v]) => `${k}=${v}`).join(' ');
    const run = await d.run(
      name,
      `cd ${PROJECT} && env ${STANDIN_ENV} ${env} timeout 200 claude -p 'adjust yourself' --mcp-config '${grant!.mcpConfig}' --strict-mcp-config --allowedTools ${tools.join(' ')} 2>&1`,
      { user: 'node', timeoutMs: 240_000 },
    );
    assert.equal(run.code, 0, run.stdout);

    // What the agent was offered, and what came back to it, as Claude Code saw it.
    const requests = await recorded(d, name);
    const offered = requests.find((r) => r.tools.some((t) => t.startsWith('mcp__pilot__')))?.tools.filter((t) => t.startsWith('mcp__pilot__')).sort();
    assert.deepEqual(offered, [...tools].sort(), 'an agent is offered exactly the persona tools of the portal tools that opted in');
    // The stand-in's own log looks at the last message only, and Claude Code ends a request with a system message: read the results from the requests.
    const found = new Map<string, { error: boolean; content: string }>();
    for (const r of requests)
      for (const m of r.messages)
        if (m.role === 'user' && Array.isArray(m.content))
          for (const b of m.content as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[])
            if (b?.type === 'tool_result' && b.tool_use_id) found.set(b.tool_use_id, { error: !!b.is_error, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
    const results = [...found.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
    assert.equal(results.length, 8, 'every call was answered');
    type Result = { error: boolean; content: string };
    const [self, update, avatar, hostile, corrupt, huge, passwd, hijack] = results as [Result, Result, Result, Result, Result, Result, Result, Result];
    assert.equal(self.error, false);
    assert.match(self.content, /Reviewer/);
    assert.match(self.content, /untrusted_text/, 'the persona’s own text reaches the model labelled as data');
    assert.equal(update.error, false);
    assert.deepEqual(
      (JSON.parse(update.content) as { proposals: { kind: string; status: string }[] }).proposals.map((p) => [p.kind, p.status]),
      [['name', 'pending'], ['instructions', 'pending']],
    );
    assert.equal(avatar.error, false);
    assert.equal((JSON.parse(avatar.content) as { proposal: { status: string } }).proposal.status, 'pending');
    assert.equal(hostile.error, true);
    assert.match(hostile.content, /PNG, JPEG or WebP/);
    assert.equal(corrupt.error, true);
    assert.match(corrupt.content, /can’t be read/);
    assert.equal(huge.error, true);
    assert.match(huge.content, /No image at that path/);
    assert.equal(passwd.error, true);
    assert.match(passwd.content, /Only files in \/home\/node/);
    assert.equal(hijack.error, false, 'unknown arguments are dropped, the call is the session’s own');

    // The portal's side: exactly the proposals of THIS persona, from THIS session, none of them live.
    const pending = personas.proposals.list({ status: 'pending' });
    assert.deepEqual(
      pending.map((p) => [p.kind, p.poolId === reviewer.id, p.actor, p.workspaceId]).sort(),
      [
        ['avatar', true, `session:${SESSION}`, WS],
        ['instructions', true, `session:${SESSION}`, WS],
        ['name', true, `session:${SESSION}`, WS],
        ['name', true, `session:${SESSION}`, WS],
      ].sort(),
      'the hijack attempt is another name proposal for the session’s own persona',
    );
    assert.equal(personas.proposals.list({ poolId: writer.id }).length, 0, 'the other persona was never touched');
    assert.equal(pools.get(reviewer.id).name, 'Reviewer');
    assert.equal(pools.get(reviewer.id).latestRevision, 1);
    assert.equal(personas.identity.meta(reviewer.id).avatar, null);
    assert.equal(store.db!.prepare('SELECT count(*) AS n FROM persona_avatars').get()!.n, 1, 'one image was kept: the valid one, re-encoded');
    const kept = personas.identity.avatarPng(pending.find((p) => p.kind === 'avatar')!.avatar!.split('/').pop()!)!;
    const meta = await sharp(kept).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', 480, 480], 'a 640 x 480 picture became a 480 px square');

    // A person decides. The text reaches the workspace; the name and the avatar become the persona's.
    for (const p of pending.filter((x) => x.name !== 'Hijacked')) personas.proposals.decide(p.id, 'approve', 'Admin');
    for (const p of personas.proposals.list({ status: 'pending' })) personas.proposals.decide(p.id, 'reject', 'Admin');
    assert.equal(pools.get(reviewer.id).name, 'Careful reviewer');
    assert.ok(personas.identity.meta(reviewer.id).avatar);
    await reconciler.request(WS, 'approved');
    await reconciler.request(WS, 'approved');
    assert.equal(reconciler.row(WS)?.status, 'synced', reconciler.row(WS)?.reason ?? '');
    const file = await d.read(name, '/etc/claude-code/CLAUDE.md');
    assert.match(file ?? '', /Be terse, and say why\./);
    assert.match(file ?? '', /Never guess\./);
    const revisions = personas.revisions(reviewer.id);
    assert.match(revisions[0]!.note, /Proposed by session:sess-agent-1, approved by Admin: Reasons make reviews easier to act on\./);

    // A second session, with the persona's auto-approval on: a name and an avatar apply at once, instructions still wait.
    personas.identity.setPolicy(reviewer.id, { autoApproveCosmetic: true });
    const grant2 = await module.agents.mint({ workspaceId: WS, sessionId: SESSION2 });
    assert.ok(grant2);
    const face2 = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#2980b9' } }).jpeg().toBuffer();
    await d.run(name, `cd /home/node && printf %s '${png(face2)}' | base64 -d > avatar2.jpg`, { user: 'node' });
    // The first stand-in is still serving its script: end it (by a pattern that doesn't match this very command) and start one with the next.
    await d.run(name, "kill $(ps -eo pid,args | awk '/[n]ode api.js/ {print $1}') 2>/dev/null; sleep 1; true", { user: 'node' });
    await d.run(name, 'rm -f /tmp/standin/requests.jsonl', { user: 'node' });
    await startStandIn(d, name, [
      call('persona_propose_update', { name: 'Auto-named', instructions_patch: { append: 'Always cite the file and line.' }, reason: 'A name that says what I do; a rule I want to keep.' }),
      call('persona_set_avatar_proposal', { workspace_path: '~/avatar2.jpg', reason: 'Blue is calmer.' }),
      { text: 'Done again.' },
    ]);
    const env2 = Object.entries(grant2!.env).map(([k, v]) => `${k}=${v}`).join(' ');
    const run2 = await d.run(name, `cd ${PROJECT} && env ${STANDIN_ENV} ${env2} timeout 200 claude -p 'adjust yourself again' --mcp-config '${grant2!.mcpConfig}' --strict-mcp-config --allowedTools ${tools.join(' ')} 2>&1`, { user: 'node', timeoutMs: 240_000 });
    assert.equal(run2.code, 0, run2.stdout);
    const second = personas.proposals.list({ poolId: reviewer.id }).filter((p) => p.actor === `session:${SESSION2}`);
    assert.deepEqual(second.map((p) => [p.kind, p.status, p.decidedBy]).sort(), [['avatar', 'approved', 'auto'], ['instructions', 'pending', null], ['name', 'approved', 'auto']].sort());
    assert.equal(pools.get(reviewer.id).name, 'Auto-named', 'a name applies at once when the persona says so');
    const avatar2 = await sharp(personas.identity.avatarPng(personas.identity.meta(reviewer.id).avatar!)!).metadata();
    assert.deepEqual([avatar2.format, avatar2.width], ['png', 256], 'a JPEG offered by the agent is the persona’s avatar as a PNG');
    assert.equal(pools.get(reviewer.id).latestRevision, 2, 'the instructions are still only a proposal');
    assert.equal(personas.proposals.list({ poolId: reviewer.id, status: 'pending' }).length, 1);
    personas.proposals.decide(second.find((p) => p.kind === 'instructions')!.id, 'reject', 'Admin');

    // And a real session in the workspace is told the new text.
    await d.run(name, 'rm -f /tmp/standin/requests.jsonl', { user: 'node' });
    await d.run(name, `cd ${PROJECT} && env ${STANDIN_ENV} timeout 100 claude -p 'probe' 2>&1`, { user: 'node' });
    const text = textOf((await recorded(d, name)).filter((r) => r.tools.length > 0).at(-1)!);
    assert.match(text, /Be terse, and say why\./);
  } finally {
    server.close();
    reconciler.stop();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
