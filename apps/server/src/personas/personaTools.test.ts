import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyPersona, PERSONA_AVATAR, type PersonaContent } from '@portal/contracts';
import sharp from 'sharp';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { PoolService } from '../pools/service.js';
import { Personas } from './index.js';
import { homePath, registerPersonaTools, type PersonaToolDeps } from './portalTools.js';

// The persona tools over the real MCP endpoint (interface I11): an agent's per-session token reaches them, an admin's
// token is refused, and "self" is always the persona of the workspace in the token. Nothing here can approve anything.

const WS1 = 'docker/ws1';
const WS2 = 'docker/ws2';

async function setup(deps: PersonaToolDeps = {}) {
  const h = await portalMcpHarness();
  const pools = new PoolService(h.store, { providers: [] });
  pools.reconciler = { request: () => Promise.resolve() };
  const personas = new Personas(h.store, pools);
  const switches = { allowed: true };
  personas.agentSelfEdit = () => switches.allowed;
  registerPersonaTools(personas, deps, h.registry);
  const instructions = '# Role\nYou review pull requests.\nBe terse.';
  const mine = pools.create('persona', { name: 'Reviewer', description: 'Reviews', content: { ...emptyPersona(), instructions, model: 'sonnet' } satisfies PersonaContent });
  const theirs = pools.create('persona', { name: 'Writer', content: { ...emptyPersona(), instructions: 'You write docs.' } satisfies PersonaContent });
  pools.setAssignments(WS1, 'persona', [{ poolId: mine.id }]);
  pools.setAssignments(WS2, 'persona', [{ poolId: theirs.id }]);
  personas.identity.setPolicy(mine.id, { agentsMayPropose: true });
  personas.identity.setPolicy(theirs.id, { agentsMayPropose: true });
  const out = (r: Awaited<ReturnType<typeof h.call>>) => r.result?.structuredContent as Record<string, any>;
  const text = (r: Awaited<ReturnType<typeof h.call>>) => r.result?.content?.map((c) => c.text).join('\n') ?? '';
  const png = (color = '#aa3399') => sharp({ create: { width: 128, height: 128, channels: 3, background: color } }).png().toBuffer();
  return { ...h, pools, personas, switches, mine, theirs, out, text, png };
}
type H = Awaited<ReturnType<typeof setup>>;

test('the persona tools are an agent’s, and only an agent’s: an admin’s token is refused, the agent is offered exactly these three', async () => {
  const h = await setup();
  try {
    const a = await h.agentToken(WS1, 's1');
    const listed = ((await h.rpc(a.secret, 'tools/list')).body.result.tools as { name: string; annotations?: { destructiveHint?: boolean } }[]).filter((t) => t.name.startsWith('persona_'));
    assert.deepEqual(listed.map((t) => t.name).sort(), ['persona_get_self', 'persona_propose_update', 'persona_set_avatar_proposal']);
    for (const t of listed) assert.notEqual(t.annotations?.destructiveHint, true, `${t.name} is not destructive`);
    for (const name of ['persona_propose_update', 'persona_set_avatar_proposal']) assert.ok(h.registry.get(name)?.rate?.perHour && h.registry.get(name)?.maxArgsBytes, `${name} is rate and size limited`);

    // An admin's token reaches the tool by scope, and is refused by what it is: personas are edited in the portal.
    const admin = h.token('admin');
    for (const [name, args] of [
      ['persona_get_self', {}],
      ['persona_propose_update', { name: 'Hacked', reason: 'x' }],
      ['persona_set_avatar_proposal', { image_base64: 'AAAA', reason: 'x' }],
    ] as const) {
      const r = await h.call(admin.secret, name, args);
      assert.equal(r.result?.isError, true, name);
      assert.match(h.text(r), /Only a session can use this tool/);
    }
    assert.equal(h.personas.proposals.list().length, 0);
  } finally {
    h.done();
  }
});

test('"self" is the persona of the token’s workspace: it reads its own, proposes for its own, and no argument names another', async () => {
  const h = await setup();
  try {
    const a = await h.agentToken(WS1, 's1');
    const b = await h.agentToken(WS2, 's2');
    const mine = h.out(await h.call(a.secret, 'persona_get_self'));
    assert.equal(mine.persona.name.untrusted_text, 'Reviewer');
    assert.match(mine.persona.instructions.untrusted_text, /You review pull requests/);
    assert.equal(mine.proposals_allowed, true);
    assert.equal(mine.persona.model, 'sonnet');
    assert.equal(mine.persona.instructions.source, 'persona', 'the persona’s text reaches the model labelled as data');
    assert.equal(h.out(await h.call(b.secret, 'persona_get_self')).persona.name.untrusted_text, 'Writer');

    // B names A's persona in every way an argument could: the token decides, so it proposes for ITS persona.
    const r = await h.call(b.secret, 'persona_propose_update', { name: 'Novelist', reason: 'I write novels.', persona_id: h.mine.id, workspace_id: WS1, session_id: 's1' } as never);
    const proposals = h.personas.proposals.list({ status: 'pending' });
    assert.ok(r.result?.isError !== true || /Unrecognized|unknown/i.test(h.text(r)), h.text(r));
    assert.ok(proposals.every((p) => p.poolId === h.theirs.id && p.workspaceId === WS2 && p.actor === 'session:s2'));
    assert.equal(h.personas.proposals.list({ poolId: h.mine.id }).length, 0, 'the other persona was never touched');
    assert.equal(h.personas.identity.identity(h.mine.id).name, 'Reviewer');
  } finally {
    h.done();
  }
});

test('a proposal waits: the text and name are not live, nothing the agent can call approves them, and the agent sees its own waiting ones', async () => {
  const h = await setup();
  try {
    const a = await h.agentToken(WS1, 's1');
    const made = await h.call(a.secret, 'persona_propose_update', {
      name: 'Careful reviewer',
      instructions_patch: { replace: [{ find: 'Be terse.', with: 'Be terse and kind.' }], append: 'Ask before guessing.' },
      reason: 'It makes reviews easier to act on.',
    });
    const body = h.out(made);
    assert.equal(made.result?.isError, undefined, h.text(made));
    assert.deepEqual(body.proposals.map((p: { kind: string; status: string }) => [p.kind, p.status]), [['name', 'pending'], ['instructions', 'pending']]);
    assert.match(h.text(made), /2 proposals waiting for a person/);
    assert.equal(h.pools.get(h.mine.id).name, 'Reviewer');
    assert.equal(h.pools.currentContent<PersonaContent>(h.mine.id)!.content.instructions, '# Role\nYou review pull requests.\nBe terse.');

    const again = h.out(await h.call(a.secret, 'persona_propose_update', { name: 'Careful reviewer', reason: 'Same.' }));
    assert.equal(again.proposals[0].duplicate, true);
    const self = h.out(await h.call(a.secret, 'persona_get_self'));
    assert.equal(self.your_pending_proposals.length, 2);

    // No tool approves. The portal's own routes do, as a person.
    for (const name of h.registry.list().map((t) => t.name).filter((n) => n.startsWith('persona_'))) assert.doesNotMatch(name, /approve|decide|publish|apply/);

    // Refusals say what to do: an edit that doesn't match, a secret, a missing reason.
    const miss = await h.call(a.secret, 'persona_propose_update', { instructions_patch: { replace: [{ find: 'Not there', with: 'x' }] }, reason: 'r' });
    assert.equal(miss.result?.isError, true);
    assert.match(h.text(miss), /isn’t in the instructions/);
    const leak = await h.call(a.secret, 'persona_propose_update', { instructions_patch: { append: 'token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' }, reason: 'r' });
    assert.match(h.text(leak), /looks like a secret/);
    const nothing = await h.call(a.secret, 'persona_propose_update', { reason: 'r' });
    assert.match(h.text(nothing), /Name something to change/);
    assert.equal(h.personas.proposals.list({ status: 'pending' }).length, 2, 'refused calls left nothing behind');
  } finally {
    h.done();
  }
});

test('the switches: the portal-wide one, then the persona’s own; auto-approval applies a name and an avatar and never instructions', async () => {
  const h = await setup();
  try {
    const a = await h.agentToken(WS1, 's1');
    h.switches.allowed = false;
    const off = await h.call(a.secret, 'persona_propose_update', { name: 'Nope', reason: 'r' });
    assert.equal(off.result?.isError, true);
    assert.match(h.text(off), /in Settings/);
    assert.equal(h.out(await h.call(a.secret, 'persona_get_self')).proposals_allowed, false);
    h.switches.allowed = true;
    h.personas.identity.setPolicy(h.mine.id, { agentsMayPropose: false });
    assert.match(h.text(await h.call(a.secret, 'persona_propose_update', { name: 'Nope', reason: 'r' })), /doesn’t take proposals from agents/);

    h.personas.identity.setPolicy(h.mine.id, { agentsMayPropose: true, autoApproveCosmetic: true });
    const r = h.out(await h.call(a.secret, 'persona_propose_update', { name: 'Auto reviewer', instructions_patch: { append: 'Be kind.' }, reason: 'r' }));
    assert.deepEqual(r.proposals.map((p: { kind: string; status: string }) => [p.kind, p.status]), [['name', 'approved'], ['instructions', 'pending']]);
    assert.equal(h.pools.get(h.mine.id).name, 'Auto reviewer');
    const avatar = h.out(await h.call(a.secret, 'persona_set_avatar_proposal', { image_base64: (await h.png()).toString('base64'), reason: 'A friendly face.' }));
    assert.equal(avatar.proposal.status, 'approved');
    assert.equal(avatar.proposal.decided_by, 'auto');
    assert.ok(h.personas.identity.meta(h.mine.id).avatar);
    assert.equal(h.pools.get(h.mine.id).latestRevision, 1, 'instructions are still only a proposal');
  } finally {
    h.done();
  }
});

test('an avatar from any of its three sources goes through the same pipeline; hostile, oversized and corrupt ones are refused without a trace', async () => {
  const files = new Map<string, Buffer>();
  const blobs = new Map<string, Buffer>();
  const h = await setup({
    readWorkspaceFile: async (ws, path, max) => {
      assert.equal(ws, WS1, 'the workspace is the token’s');
      assert.ok(path.startsWith('/home/node/'));
      const f = files.get(path);
      return f && f.length <= max ? f : null;
    },
    readSessionBlob: (sessionId, id) => (sessionId === 's1' ? (blobs.get(id) ?? null) : null),
  });
  try {
    const a = await h.agentToken(WS1, 's1');
    const png = await h.png();
    files.set('/home/node/avatar.png', png);
    blobs.set('b'.repeat(64), png);
    const pending = async () => h.personas.proposals.list({ status: 'pending' }).filter((p) => p.kind === 'avatar');

    // base64 (the same picture as below, so it is one proposal), a path in the home folder, a blob of the session.
    const inline = h.out(await h.call(a.secret, 'persona_set_avatar_proposal', { image_base64: png.toString('base64'), reason: 'One.' }));
    assert.equal(inline.proposal.status, 'pending');
    assert.equal(inline.image.format, 'png');
    const viaPath = h.out(await h.call(a.secret, 'persona_set_avatar_proposal', { workspace_path: '~/avatar.png', reason: 'Two.' }));
    assert.equal(viaPath.proposal.duplicate, true, 'the same picture from another source is the same proposal');
    const viaBlob = h.out(await h.call(a.secret, 'persona_set_avatar_proposal', { blob_id: 'b'.repeat(64), reason: 'Three.' }));
    assert.equal(viaBlob.proposal.duplicate, true);
    assert.equal((await pending()).length, 1);

    // What is refused.
    const refuse = async (args: Record<string, unknown>, re: RegExp) => {
      const before = (await pending()).length;
      // A fresh token each time: the registry's own per-token rate limit is not what this measures.
      const r = await h.call((await h.agentToken(WS1, 's1')).secret, 'persona_set_avatar_proposal', { reason: 'r', ...args });
      assert.equal(r.result?.isError, true, JSON.stringify(args).slice(0, 80));
      assert.match(h.text(r), re);
      assert.equal((await pending()).length, before, 'a refused image leaves no proposal');
      assert.equal(h.store.db!.prepare('SELECT count(*) AS n FROM persona_avatars').get()!.n, 1, 'and no image');
    };
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await refuse({ image_base64: svg.toString('base64') }, /PNG, JPEG or WebP/);
    await refuse({ image_base64: 'not base64 !!' }, /isn’t base64/);
    await refuse({ image_base64: Buffer.alloc(PERSONA_AVATAR.inlineBytes + 1, 1).toString('base64') }, /Inline images are at most/);
    await refuse({ image_base64: png.subarray(0, 50).toString('base64') }, /can’t be read/);
    files.set('/home/node/hostile.png', svg);
    await refuse({ workspace_path: '~/hostile.png' }, /PNG, JPEG or WebP/);
    await refuse({ workspace_path: '~/missing.png' }, /No image at that path/);
    await refuse({ workspace_path: '../../etc/passwd' }, /plain path inside your home folder/);
    await refuse({ workspace_path: '/etc/shadow' }, /Only files in \/home\/node/);
    await refuse({ blob_id: 'c'.repeat(64) }, /no such file/);
    await refuse({}, /exactly one image/);
    await refuse({ workspace_path: '~/avatar.png', image_base64: 'AAAA' }, /exactly one image/);
    // Another session's blob is not this session's.
    const other = await h.agentToken(WS1, 's-other');
    const stolen = await h.call(other.secret, 'persona_set_avatar_proposal', { blob_id: 'b'.repeat(64), reason: 'r' });
    assert.match(h.text(stolen), /no such file/);
  } finally {
    h.done();
  }
});

test('homePath: a plain path in the home folder, nothing else', () => {
  assert.equal(homePath('~/avatar.png'), '/home/node/avatar.png');
  assert.equal(homePath('avatar.png'), '/home/node/avatar.png');
  assert.equal(homePath('/home/node/work/a b.png'), '/home/node/work/a b.png');
  assert.equal(homePath('~/work/../work/x.png'.replace('/../work', '')), '/home/node/work/x.png');
  for (const bad of ['~/../etc/passwd', '/etc/passwd', '/home/nodes/x.png', '~/a\nb.png', '~/a\0.png', '/home/node/../../root/x']) assert.throws(() => homePath(bad), /plain path|Only files/, bad);
});
