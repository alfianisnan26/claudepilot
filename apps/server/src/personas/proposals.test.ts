import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { emptyPersona, PERSONA_PROPOSAL_LIMITS, type PersonaContent, type PersonaProposal } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import sharp from 'sharp';
import { PoolService } from '../pools/service.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { normalizeAvatar } from './avatar.js';
import { createPersonaRoutes, Personas } from './index.js';

const WS = 'docker/ws1';
const SESSION = { workspaceId: WS, sessionId: 's-1' };
const code = (c: string) => (e: unknown) => isAppError(e) && e.code === c;
const field = (f: string, re?: RegExp) => (e: unknown) => isAppError(e) && !!(e.details as Record<string, string> | undefined)?.[f] && (!re || re.test(String((e.details as Record<string, string>)[f])));

async function setup(opts: { allowed?: boolean; mayPropose?: boolean; auto?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-persona-proposals-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const pools = new PoolService(store, { providers: [] });
  const clock = { ms: Date.parse('2026-10-12T10:00:00Z') };
  const personas = new Personas(store, pools, { now: () => new Date(clock.ms) });
  const switches = { allowed: opts.allowed ?? true };
  personas.agentSelfEdit = () => switches.allowed;
  const requests: string[] = [];
  pools.reconciler = { request: (id: string) => (requests.push(id), Promise.resolve()) };
  const instructions = '# Role\nYou review pull requests.\nBe terse.\n\nNever guess.';
  const reviewer = pools.create('persona', { name: 'Reviewer', description: 'Reviews', content: { ...emptyPersona(), instructions } satisfies PersonaContent });
  pools.setAssignments(WS, 'persona', [{ poolId: reviewer.id }]);
  if (opts.mayPropose !== false) personas.identity.setPolicy(reviewer.id, { agentsMayPropose: true, autoApproveCosmetic: opts.auto ?? false });
  const png = async (color: string, size = 96) => normalizeAvatar(await sharp({ create: { width: size, height: size, channels: 3, background: color } }).png().toBuffer());
  const current = () => pools.currentContent<PersonaContent>(reviewer.id, 'persona')!.content.instructions;
  const done = () => (store.close(), rmSync(dataDir, { recursive: true, force: true }));
  return { store, pools, personas, reviewer, switches, clock, requests, png, current, done };
}
type H = Awaited<ReturnType<typeof setup>>;
const propose = (h: H, input: { name?: string; patch?: unknown; reason?: string }, ctx = SESSION) =>
  h.personas.proposals.proposeUpdate(ctx, { name: input.name, instructionsPatch: input.patch, reason: input.reason ?? 'Because it fits what I do.' });

/* ---------- Who may propose ---------- */

test('I11 gate: a session proposes only for its own workspace’s persona, only while the portal switch and the persona’s switch are on', async () => {
  const h = await setup({ mayPropose: false });
  try {
    // The persona hasn't been opened to agents yet.
    assert.throws(() => propose(h, { name: 'Wise reviewer' }), (e) => code('FORBIDDEN')(e) && /doesn’t take proposals from agents/.test((e as Error).message));
    h.personas.identity.setPolicy(h.reviewer.id, { agentsMayPropose: true });
    assert.equal(propose(h, { name: 'Wise reviewer' })[0]!.proposal.status, 'pending');
    // The portal's own switch outranks it.
    h.switches.allowed = false;
    assert.throws(() => propose(h, { name: 'Wiser reviewer' }), (e) => code('FORBIDDEN')(e) && /in Settings/.test((e as Error).message));
    assert.equal(h.personas.proposals.getSelf(SESSION)!.allowed, false);
    h.switches.allowed = true;
    // A workspace with no persona has nothing to change, and a session can't name another workspace's: there is no argument for it.
    assert.throws(() => propose(h, { name: 'Anything' }, { workspaceId: 'docker/other', sessionId: 's-9' }), code('NOT_FOUND'));
    assert.equal(h.personas.proposals.getSelf({ workspaceId: 'docker/other', sessionId: 's-9' }), null);
    // Another workspace with ANOTHER persona proposes for that one, never for this one.
    const other = h.pools.create('persona', { name: 'Writer', content: emptyPersona() });
    h.pools.setAssignments('docker/ws2', 'persona', [{ poolId: other.id }]);
    h.personas.identity.setPolicy(other.id, { agentsMayPropose: true });
    const made = propose(h, { name: 'Novelist' }, { workspaceId: 'docker/ws2', sessionId: 's-2' })[0]!.proposal;
    assert.equal(made.poolId, other.id);
    assert.equal(h.personas.proposals.list({ poolId: h.reviewer.id, status: 'pending' }).some((p) => p.name === 'Novelist'), false);
    // A persona nobody published can't be changed by an agent: there is nothing live to edit.
    const draft = h.pools.create('persona', { name: 'Draft only', content: emptyPersona(), draft: true });
    assert.equal(h.personas.identity.defaultPool(), null);
    assert.throws(() => h.personas.identity.setDefault(draft.id), code('CONFLICT'));
  } finally {
    h.done();
  }
});

/* ---------- Names ---------- */

test('a name: checked like a pool name, one proposal however often it is asked, applied only by approving, and refused when it was taken meanwhile', async () => {
  const h = await setup();
  try {
    const clash = h.pools.create('persona', { name: 'Taken', content: emptyPersona() });
    assert.throws(() => propose(h, { name: 'taken' }), code('CONFLICT'));
    assert.throws(() => propose(h, { name: 'Reviewer' }), field('name', /already its name/));
    assert.throws(() => propose(h, { name: 'x'.repeat(61) }), field('name', /at most 60/));
    assert.throws(() => propose(h, { name: 'Bad\u{200b}name' }), field('name', /invisible/));
    assert.throws(() => propose(h, { name: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' }), field('name', /looks like a secret/));
    assert.throws(() => propose(h, { name: 'Fine', reason: '' }), field('reason', /Say why/));
    assert.throws(() => propose(h, {}), field('update', /Name something to change/));

    const [a] = propose(h, { name: '  Wise   reviewer ', reason: 'I mostly teach.' });
    assert.deepEqual([a!.proposal.kind, a!.proposal.status, a!.proposal.name, a!.proposal.actor, a!.proposal.reason, a!.duplicate], ['name', 'pending', 'Wise reviewer', 'session:s-1', 'I mostly teach.', false]);
    assert.equal(h.pools.get(h.reviewer.id).name, 'Reviewer', 'nothing changes until a person approves');
    assert.equal(propose(h, { name: 'Wise reviewer' })[0]!.duplicate, true, 'the same call is the same proposal');
    assert.equal(h.personas.proposals.list({ status: 'pending' }).length, 1);

    // Someone else takes the name first: the proposal can no longer be approved.
    h.pools.update(clash.id, { name: 'Wise reviewer' });
    assert.equal(h.personas.proposals.list({ status: 'pending' })[0]!.problem, 'Another persona is called that.');
    assert.throws(() => h.personas.proposals.decide(a!.proposal.id, 'approve', 'Admin'), code('CONFLICT'));
    assert.equal(h.personas.proposals.list({ poolId: h.reviewer.id })[0]!.status, 'stale');

    // A fresh one, approved: the pool is renamed, and every list that shows it follows.
    h.pools.update(clash.id, { name: 'Taken' });
    const [b] = propose(h, { name: 'Sharp reviewer' });
    const decided = h.personas.proposals.decide(b!.proposal.id, 'approve', 'Admin');
    assert.deepEqual([decided.status, decided.decidedBy], ['approved', 'Admin']);
    assert.equal(h.pools.get(h.reviewer.id).name, 'Sharp reviewer');
    assert.equal(h.personas.personaFor(WS).persona?.name, 'Sharp reviewer');
    assert.equal(h.personas.identity.identities()[WS]?.name, 'Sharp reviewer');
    assert.throws(() => h.personas.proposals.decide(b!.proposal.id, 'reject', 'Admin'), (e) => code('CONFLICT')(e) && /already approved/.test((e as Error).message));
  } finally {
    h.done();
  }
});

/* ---------- Instructions ---------- */

test('instructions: exact edits against the current text, a person publishes them as a revision with the proposer named, and a changed text makes the proposal stale', async () => {
  const h = await setup();
  try {
    const patch = (p: object) => () => propose(h, { patch: p });
    // Each replacement names text that occurs once.
    assert.throws(patch({ replace: [{ find: 'Not in there', with: 'x' }] }), field('instructions_patch.replace.0', /isn’t in the instructions/));
    assert.throws(patch({ replace: [{ find: 'e', with: 'x' }] }), field('instructions_patch.replace.0', /occurs \d+ times/));
    assert.throws(patch({ replace: [{ find: 'Be terse.', with: 'Be terse.' }] }), field('instructions_patch', /changes nothing/));
    assert.throws(patch({}), field('instructions_patch', /something to add or replace/));
    assert.throws(patch({ append: 'x'.repeat(PERSONA_PROPOSAL_LIMITS.instructionsBytes + 1) }), field('instructions_patch', /at most 8 KB/));
    assert.throws(patch({ append: 'Call me with ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' }), field('instructions_patch', /looks like a secret/));
    assert.throws(patch({ append: 'hidden\u{202e}text' }), field('instructions_patch', /invisible/));
    assert.throws(patch({ replace: Array.from({ length: 6 }, (_, i) => ({ find: `a${i}`, with: 'b' })) }), field('instructions_patch.replace', /at most 5/));

    const [m] = propose(h, { patch: { replace: [{ find: 'Be terse.', with: 'Be terse, and say why.' }], append: 'Prefer small diffs.' }, reason: 'Reviews went better with reasons.' });
    const p = m!.proposal;
    assert.deepEqual([p.kind, p.status], ['instructions', 'pending']);
    assert.equal(p.instructions?.before, '# Role\nYou review pull requests.\nBe terse.\n\nNever guess.');
    assert.equal(p.instructions?.after, '# Role\nYou review pull requests.\nBe terse, and say why.\n\nNever guess.\n\nPrefer small diffs.');
    assert.equal(h.current(), p.instructions?.before, 'a proposal is not live');
    assert.equal(h.pools.get(h.reviewer.id).latestRevision, 1, 'and it is not a revision either');

    h.requests.length = 0;
    const done = h.personas.proposals.decide(p.id, 'approve', 'Admin');
    assert.equal(done.status, 'approved');
    assert.equal(h.current(), p.instructions?.after);
    const detail = h.pools.get(h.reviewer.id);
    assert.deepEqual([detail.revision, detail.latestRevision], [2, 2]);
    assert.deepEqual(h.requests, [WS], 'approving publishes: the workspace is asked to deliver');
    const revisions = h.personas.revisions(h.reviewer.id);
    assert.match(revisions[0]!.note, /Proposed by session:s-1, approved by Admin: Reviews went better with reasons\./);
    assert.equal((h.personas.revision(h.reviewer.id, 2).content as PersonaContent).instructions, p.instructions?.after);

    // The text a pending edit names is edited away by a person: the proposal is stale, with the reason.
    const [q] = propose(h, { patch: { replace: [{ find: 'Never guess.', with: 'Never guess; ask.' }] } });
    h.pools.update(h.reviewer.id, { content: { ...emptyPersona(), instructions: 'A brand new text.' } });
    assert.match(h.personas.proposals.list({ status: 'pending' })[0]!.problem ?? '', /isn’t in the instructions/);
    assert.throws(() => h.personas.proposals.decide(q!.proposal.id, 'approve', 'Admin'), (e) => code('CONFLICT')(e) && /isn’t in the instructions/.test((e as Error).message));
    assert.equal(h.personas.proposals.list({ poolId: h.reviewer.id }).find((x) => x.id === q!.proposal.id)?.status, 'stale');
    assert.equal(h.current(), 'A brand new text.');
  } finally {
    h.done();
  }
});

test('instructions never apply on their own, even with auto-approval on for names and avatars; a rejected proposal changes nothing and leaves no revision', async () => {
  const h = await setup({ auto: true });
  try {
    const made = propose(h, { name: 'Auto name', patch: { append: 'Be kind.' } });
    const byKind = Object.fromEntries(made.map((m) => [m.proposal.kind, m.proposal]));
    assert.deepEqual([byKind.name?.status, byKind.name?.decidedBy], ['approved', 'auto'], 'a name is cosmetic');
    assert.equal(h.pools.get(h.reviewer.id).name, 'Auto name');
    assert.deepEqual([byKind.instructions?.status, byKind.instructions?.decidedBy], ['pending', null], 'instructions wait for a person');
    assert.equal(h.pools.get(h.reviewer.id).latestRevision, 1);
    h.personas.proposals.decide(byKind.instructions!.id, 'reject', 'Admin');
    assert.equal(h.pools.get(h.reviewer.id).latestRevision, 1, 'rejecting makes no revision');
    assert.equal(h.personas.proposals.list({ poolId: h.reviewer.id, status: 'rejected' }).length, 1);
    // Turning proposals off turns auto-approval off with it.
    h.personas.identity.setPolicy(h.reviewer.id, { agentsMayPropose: false });
    assert.deepEqual([h.personas.identity.meta(h.reviewer.id).agentsMayPropose, h.personas.identity.meta(h.reviewer.id).autoApproveCosmetic], [false, false]);
    assert.throws(() => propose(h, { name: 'Nope' }), code('FORBIDDEN'));
  } finally {
    h.done();
  }
});

/* ---------- Avatars ---------- */

test('an avatar: kept as the portal’s PNG, applied only by approving (or by the persona’s switch), replaced and cleared, and unreferenced images are collected', async () => {
  const h = await setup();
  try {
    const red = await h.png('#cc2222');
    const first = h.personas.proposals.proposeAvatar(SESSION, red, 'Red suits a reviewer.');
    assert.deepEqual([first.proposal.kind, first.proposal.status, first.duplicate], ['avatar', 'pending', false]);
    assert.match(first.proposal.avatar ?? '', /^\/api\/personas\/avatars\/[0-9a-f]{64}$/);
    assert.deepEqual(h.personas.identity.avatarPng(red.sha256), red.png);
    assert.equal(h.personas.identity.meta(h.reviewer.id).avatar, null, 'not applied yet');
    assert.equal(h.personas.proposals.proposeAvatar(SESSION, red, 'Again.').duplicate, true);

    h.personas.proposals.decide(first.proposal.id, 'approve', 'Admin');
    assert.equal(h.personas.identity.meta(h.reviewer.id).avatar, red.sha256);
    assert.equal(h.personas.personaFor(WS).persona?.avatar, `/api/personas/avatars/${red.sha256}`);
    assert.throws(() => h.personas.proposals.proposeAvatar(SESSION, red, 'The same.'), field('avatar', /already its avatar/));

    // A new one rejected: the image goes with its proposal once the keeping period is over, the applied one stays.
    const blue = await h.png('#2222cc');
    const second = h.personas.proposals.proposeAvatar(SESSION, blue, 'Blue is calmer.');
    h.personas.proposals.decide(second.proposal.id, 'reject', 'Admin');
    assert.ok(h.personas.identity.avatarPng(blue.sha256), 'a rejected proposal still shows what was proposed');
    h.clock.ms += 31 * 24 * 60 * 60 * 1000;
    h.personas.identity.collect(new Date(h.clock.ms));
    assert.equal(h.personas.identity.avatarPng(blue.sha256), null);
    assert.ok(h.personas.identity.avatarPng(red.sha256));

    // A person clears it: none is a valid state. Its decided proposal still shows the image for the keeping period, then it goes.
    h.personas.identity.setAvatar(h.reviewer.id, null);
    assert.equal(h.personas.personaFor(WS).persona?.avatar, null);
    assert.ok(h.personas.identity.avatarPng(red.sha256));
    h.clock.ms += 31 * 24 * 60 * 60 * 1000;
    h.personas.identity.collect(new Date(h.clock.ms));
    assert.equal(h.personas.identity.avatarPng(red.sha256), null);
  } finally {
    h.done();
  }
});

test('with auto-approval on, a name and an avatar are applied at once and audited as auto', async () => {
  const h = await setup({ auto: true });
  try {
    const green = await h.png('#22aa44');
    const { proposal } = h.personas.proposals.proposeAvatar(SESSION, green, 'Green.');
    assert.deepEqual([proposal.status, proposal.decidedBy], ['approved', 'auto']);
    assert.equal(h.personas.identity.meta(h.reviewer.id).avatar, green.sha256);
    assert.equal(h.personas.proposals.getSelf(SESSION)!.autoApproves, true);
    h.switches.allowed = false;
    assert.equal(h.personas.proposals.getSelf(SESSION)!.autoApproves, false, 'the portal switch outranks the persona’s');
  } finally {
    h.done();
  }
});

/* ---------- Limits ---------- */

test('a looping or injected agent cannot bury the queue: a few waiting per persona, a few an hour per session', async () => {
  const h = await setup();
  try {
    for (let i = 0; i < PERSONA_PROPOSAL_LIMITS.pendingPerPersona; i++) propose(h, { name: `Name ${i}` }, { workspaceId: WS, sessionId: `b-${i}` });
    assert.throws(() => propose(h, { name: 'One more' }, { workspaceId: WS, sessionId: 's-new' }), (e) => code('RATE_LIMITED')(e) && /waiting for a person/.test((e as Error).message));
    // A person clears the queue; the hour limit is the session's own.
    for (const p of h.personas.proposals.list({ status: 'pending' })) h.personas.proposals.decide(p.id, 'reject', 'Admin');
    for (let i = 0; i < PERSONA_PROPOSAL_LIMITS.perHour; i++) {
      const made = propose(h, { name: `Again ${i}` });
      h.personas.proposals.decide(made[0]!.proposal.id, 'reject', 'Admin');
    }
    assert.throws(() => propose(h, { name: 'Too many' }), (e) => code('RATE_LIMITED')(e) && /an hour/.test((e as Error).message));
    h.clock.ms += 61 * 60 * 1000;
    assert.equal(propose(h, { name: 'An hour later' })[0]!.proposal.status, 'pending');
  } finally {
    h.done();
  }
});

/* ---------- Identity ---------- */

test('the default for new workspaces: one persona at most, published only, and it follows the persona when it is deleted', async () => {
  const h = await setup();
  try {
    assert.equal(h.personas.identity.defaultPool(), null);
    h.personas.identity.setDefault(h.reviewer.id);
    assert.equal(h.personas.identity.defaultPool(), h.reviewer.id);
    const other = h.pools.create('persona', { name: 'Other', content: emptyPersona() });
    h.personas.identity.setDefault(other.id);
    assert.equal(h.personas.identity.defaultPool(), other.id, 'one at a time');
    assert.equal(h.personas.identity.policy(h.reviewer.id, true).isDefault, false);
    assert.throws(() => h.personas.identity.setDefault('nope'), code('NOT_FOUND'));
    h.pools.delete(other.id);
    assert.equal(h.personas.identity.defaultPool(), null, 'a deleted persona is no longer the default');
    h.personas.identity.setDefault(null);
    assert.equal(h.personas.identity.defaultPool(), null);
    // Deleting a persona takes its record, its proposals and (once nothing refers to it) its avatar with it.
    const red = await h.png('#cc2222');
    const w = h.pools.create('persona', { name: 'Doomed', content: emptyPersona() });
    h.pools.setAssignments('docker/ws3', 'persona', [{ poolId: w.id }]);
    h.personas.identity.setPolicy(w.id, { agentsMayPropose: true });
    h.personas.proposals.proposeAvatar({ workspaceId: 'docker/ws3', sessionId: 's-3' }, red, 'Red.');
    h.pools.setAssignments('docker/ws3', 'persona', []);
    h.pools.delete(w.id);
    assert.equal(h.personas.proposals.list({ poolId: w.id }).length, 0);
    assert.equal(h.store.db!.prepare('SELECT count(*) AS n FROM persona_meta WHERE pool_id = ?').get(w.id)!.n, 0);
  } finally {
    h.done();
  }
});

/* ---------- Routes ---------- */

test('routes: upload re-encodes, the image is served as a locked-down PNG, refusals say why, and decisions are a person’s', async () => {
  const h = await setup();
  try {
    const app = new Hono();
    // Like app.ts: AppErrors keep their status, message and details.
    app.onError((e, c) => {
      const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
      return c.json(err.toJSON(), err.status as ContentfulStatusCode);
    });
    app.route('/', createPersonaRoutes(h.personas));
    const send = (path: string, init: RequestInit = {}) => app.request(path, init);
    const json = async (r: Response) => ((await r.json()) as { data?: any; error?: { code: string; message: string } });
    const upload = await sharp({ create: { width: 700, height: 300, channels: 3, background: '#aa3399' } }).jpeg().toBuffer();

    const ok = await send(`/pools/${h.reviewer.id}/avatar`, { method: 'POST', body: new Uint8Array(upload), headers: { 'content-type': 'image/jpeg' } });
    assert.equal(ok.status, 200);
    const { avatar } = (await json(ok)).data as { avatar: string };
    const shown = await send(avatar.replace('/api/personas', ''));
    assert.equal(shown.status, 200);
    assert.equal(shown.headers.get('content-type'), 'image/png');
    assert.equal(shown.headers.get('x-content-type-options'), 'nosniff');
    assert.match(shown.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(shown.headers.get('cache-control') ?? '', /immutable/);
    const bytes = Buffer.from(await shown.arrayBuffer());
    assert.equal((await sharp(bytes).metadata()).format, 'png', 'what is served is the re-encoded PNG, not the upload');
    assert.notDeepEqual(bytes, upload);

    const svg = await send(`/pools/${h.reviewer.id}/avatar`, { method: 'POST', body: '<svg xmlns="http://www.w3.org/2000/svg"/>', headers: { 'content-type': 'image/png' } });
    assert.equal(svg.status, 422);
    assert.match((await json(svg)).error!.message, /PNG, JPEG or WebP/);
    const huge = await send(`/pools/${h.reviewer.id}/avatar`, { method: 'POST', body: new Uint8Array(4 * 1024 * 1024), headers: { 'content-length': String(4 * 1024 * 1024) } });
    assert.equal(huge.status, 413);
    assert.equal((await send('/avatars/' + 'f'.repeat(64))).status, 404);
    assert.equal((await send('/avatars/not-a-hash')).status, 404);
    assert.equal((await send(`/pools/nope/policy`)).status, 404);

    const pol = await send(`/pools/${h.reviewer.id}/policy`, { method: 'PUT', body: JSON.stringify({ agentsMayPropose: true, autoApproveCosmetic: true }), headers: { 'content-type': 'application/json' } });
    assert.deepEqual((await json(pol)).data, { agentsMayPropose: true, autoApproveCosmetic: true, portalAllows: true, isDefault: false, avatar: avatar });
    assert.equal((await send(`/pools/${h.reviewer.id}/policy`, { method: 'PUT', body: JSON.stringify({ agentsMayPropose: 'yes' }), headers: { 'content-type': 'application/json' } })).status, 422);

    // Decisions go through the routes as `Admin`.
    h.personas.identity.setPolicy(h.reviewer.id, { autoApproveCosmetic: false });
    const [made] = propose(h, { name: 'Routed' });
    const list = (await json(await send('/proposals?status=pending'))).data as PersonaProposal[];
    assert.deepEqual(list.map((p) => p.id), [made!.proposal.id]);
    assert.equal((await send('/proposals?status=bogus')).status, 400);
    assert.equal((await send(`/proposals/${made!.proposal.id}/delete`, { method: 'POST' })).status, 404);
    const decided = (await json(await send(`/proposals/${made!.proposal.id}/approve`, { method: 'POST' }))).data as PersonaProposal;
    assert.deepEqual([decided.status, decided.decidedBy], ['approved', 'Admin']);
    const revisions = (await json(await send(`/pools/${h.reviewer.id}/revisions`))).data as { revision: number; current: boolean; content?: unknown }[];
    assert.deepEqual(revisions.map((r) => [r.revision, r.current]), [[1, true]]);
    assert.equal(revisions[0]!.content, undefined, 'the history is metadata: a revision’s text is asked for on its own');
    const one = (await json(await send(`/pools/${h.reviewer.id}/revisions/1`))).data as { content: PersonaContent };
    assert.match(one.content.instructions, /You review pull requests/);
    assert.equal((await send(`/pools/${h.reviewer.id}/revisions/9`)).status, 404);
    assert.equal((await send(`/pools/${h.reviewer.id}/revisions/zero`)).status, 400);
    assert.equal((await send('/pools/nope/revisions')).status, 404);

    const def = await send('/default', { method: 'PUT', body: JSON.stringify({ poolId: h.reviewer.id }), headers: { 'content-type': 'application/json' } });
    assert.deepEqual((await json(def)).data, { poolId: h.reviewer.id });
    assert.deepEqual((await json(await send('/default'))).data, { poolId: h.reviewer.id });
    const ids = (await json(await send('/identities'))).data as Record<string, { name: string; avatar: string | null }>;
    assert.equal(ids[WS]?.name, 'Routed');
    assert.match(ids[WS]?.avatar ?? '', /^\/api\/personas\/avatars\//);
  } finally {
    h.done();
  }
});
