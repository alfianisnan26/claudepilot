// T-968 S1 (general-manager PRD §2, §4, Q3): the General Manager's `cpmt_` token. It acts as its PERSON for can(), resolved on every call
// (no manager branch), with `manager:<session id>` an audit label only; a denial is the same not-found; the agent-self tools refuse it;
// it is revoked on any sign-out of the person, on any device (#11136); the database holds one manager per person. Tokens are minted at run
// time, never written here.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { z } from 'zod';
import { workspaceRef, type Actor, type ObjectRef, type UserId, type Verb } from '@portal/contracts';
import { actorOfPrincipal, can, clearResolvers, registerResolver, requireCan } from '../authz/seam.js';
import { Portal } from '../portal.js';
import { ManagerTokens } from './managers.js';
import { ToolRegistry, type PortalPrincipal } from './registry.js';
import { portalMcpHarness } from './testkit.js';

afterEach(() => clearResolvers());

const ALICE = 'u_alice';
const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'legacy', via: 'ui' });
const managerOf = (userId: string | undefined): PortalPrincipal => ({
  kind: 'manager',
  userId,
  tokenId: 'mgt_1',
  label: 'General Manager',
  scope: 'operate',
  workspaceId: null,
  sessionId: 'gm1',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  client: null,
  vaults: null,
});

/** Workspaces owned by two people; anything else is missing. */
function ownedWorkspaces() {
  const owners: Record<string, string> = { 'docker/alice': ALICE, 'docker/bob': 'u_bob' };
  registerResolver({ type: 'workspace', resolve: (id) => (owners[id] ? { ref: workspaceRef(id), owner: { kind: 'user', id: owners[id]! as UserId } } : null) });
}

test('seam: a manager principal is its person for can(), with the same answer as the person on every sampled object', () => {
  ownedWorkspaces();
  const actor = actorOfPrincipal(managerOf(ALICE));
  assert.deepEqual(actor, person(ALICE), 'the person, not manager:<id>');
  const sample: ObjectRef[] = ['docker/alice', 'docker/bob', 'docker/missing'].map(workspaceRef);
  for (const ref of sample)
    for (const verb of ['view', 'operate', 'manage'] as Verb[])
      assert.deepEqual(can(actor, verb, ref), can(person(ALICE), verb, ref), `${verb} ${ref.id}`);
  // The sample is not trivially equal: the person holds one and not the others.
  assert.equal(can(actor, 'manage', workspaceRef('docker/alice')).allow, true);
  assert.equal(can(actor, 'view', workspaceRef('docker/bob')).allow, false);
  // A manager without a person is nobody.
  assert.deepEqual(actorOfPrincipal(managerOf(undefined)), { kind: 'anonymous' });
});

/** How often each tool's handler ran: a refused call must never reach one. */
const ran: Record<string, number> = {};
/** A registry with a tool that reads a workspace through the seam, a who-am-I, an agent-self tool and an admin tool. */
function registry() {
  const r = new ToolRegistry();
  r.register({
    name: 'ws_peek',
    title: 'Peek',
    description: 'Reads a workspace through the seam.',
    scope: 'read',
    input: z.object({ id: z.string() }),
    handler: (ctx, args) => {
      requireCan(actorOfPrincipal(ctx.principal), 'view', workspaceRef(args.id));
      return { summary: 'seen', id: args.id };
    },
  });
  r.register({
    name: 'who_am_i',
    title: 'Who',
    description: 'The context a tool sees.',
    scope: 'read',
    input: z.object({}),
    handler: (ctx) => ({ actor: ctx.actor, label: ctx.actorLabel ?? null, isAgent: ctx.isAgent, sessionId: ctx.sessionId, workspaceId: ctx.workspaceId }),
  });
  r.register({ name: 'session_rename_self', title: 'Rename', description: 'Agent self.', scope: 'agent', input: z.object({}), handler: () => ((ran.session_rename_self = (ran.session_rename_self ?? 0) + 1), { renamed: true }) });
  r.register({ name: 'big_switch', title: 'Admin', description: 'Admin tier.', scope: 'admin', input: z.object({}), handler: () => ((ran.big_switch = (ran.big_switch ?? 0) + 1), { switched: true }) });
  return r;
}

const errorOf = (r: { result?: { isError?: boolean; structuredContent?: any; content?: { text: string }[] } }) => {
  assert.equal(r.result?.isError, true, JSON.stringify(r.result));
  return { structured: r.result?.structuredContent, text: r.result?.content?.[0]?.text };
};

test('over /mcp: a manager token reads as its person, a denial is the same not-found, and the actor is an audit label only', async () => {
  ownedWorkspaces();
  const h = await portalMcpHarness({ registry: registry() });
  try {
    h.alive.add('gm1');
    const m = h.module.managers.mint({ userId: ALICE, sessionId: 'gm1' })!;
    assert.match(m.secret, /^cpmt_/);
    const ok = await h.call(m.secret, 'ws_peek', { id: 'docker/alice' });
    assert.equal(ok.result?.isError, undefined, JSON.stringify(ok.result));
    assert.equal(ok.result?.structuredContent?.id, 'docker/alice');
    const other = errorOf(await h.call(m.secret, 'ws_peek', { id: 'docker/bob' }));
    const missing = errorOf(await h.call(m.secret, 'ws_peek', { id: 'docker/missing' }));
    assert.deepEqual(other, missing, "another person's workspace reads exactly like a missing one");
    assert.match(String(other.text), /NOT_FOUND/);

    const who = await h.call(m.secret, 'who_am_i');
    assert.deepEqual(who.result?.structuredContent && { ...who.result.structuredContent, summary: undefined }, {
      actor: 'manager:gm1',
      label: 'General Manager',
      isAgent: false,
      sessionId: null,
      workspaceId: null,
      summary: undefined,
    });
  } finally {
    h.done();
  }
});

test('over /mcp: the agent-self tools are neither offered to nor callable by a manager, and admin-tier tools wait for S5', async () => {
  const h = await portalMcpHarness({ registry: registry() });
  try {
    h.alive.add('gm1');
    const m = h.module.managers.mint({ userId: ALICE, sessionId: 'gm1' })!;
    const listed = (await h.rpc(m.secret, 'tools/list')).body.result.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(listed, ['big_switch', 'who_am_i', 'ws_peek'], 'session_rename_self is not offered');
    // An agent-self tool is not even registered for a manager (server.ts #build), so the MCP SDK refuses the call as an unknown tool:
    // a JSON-RPC error, no tool result, and the handler never runs. (The SCOPE_REQUIRED branch in #call is the second wall, for a
    // path that bypasses #build; T-968 S1 QA: the first version of this test expected that tool error here, which was the test's mistake.)
    const self = await h.call(m.secret, 'session_rename_self');
    assert.equal(self.result, undefined, JSON.stringify(self.raw));
    assert.ok(self.error && /session_rename_self/.test(self.error.message), JSON.stringify(self.raw));
    assert.equal(ran.session_rename_self ?? 0, 0, 'the agent-self handler never ran');
    // An admin-tier tool is offered (the tier is the token's, S5 grants admin) but an operate manager is refused, as a tool error.
    const admin = errorOf(await h.call(m.secret, 'big_switch'));
    assert.match(String(admin.text), /SCOPE_REQUIRED/);
    assert.match(String(admin.text), /needs the admin scope; this token has operate/);
    assert.equal(ran.big_switch ?? 0, 0, 'the admin handler never ran');
  } finally {
    h.done();
  }
});

test('Q3 (#11136): the token is revoked on ANY sign-out of the person, even with another device still signed in; another person is untouched', async () => {
  const h = await portalMcpHarness({ registry: registry() });
  try {
    const portal = new Portal('24681357', 60_000);
    portal.roleOf = () => 'admin';
    portal.onSignedOut = (userId) => void h.module.managers.revokeUser(userId, 'signed out');
    const phone = portal.openSession(ALICE);
    const laptop = portal.openSession(ALICE);
    portal.openSession('u_bob');
    h.alive.add('gm1');
    h.alive.add('gm2');
    const mine = h.module.managers.mint({ userId: ALICE, sessionId: 'gm1' })!;
    const his = h.module.managers.mint({ userId: 'u_bob', sessionId: 'gm2' })!;
    const works = async (secret: string) => (await h.call(secret, 'who_am_i')).status === 200;

    assert.equal(await works(mine.secret), true, 'signed in on both: the manager works');
    portal.signOut(phone);
    assert.equal(await works(mine.secret), false, 'one sign-out stops the manager, though the laptop is still signed in');
    assert.equal(h.module.managers.verify(mine.secret).ok, false);
    assert.ok(portal.session(laptop),'the laptop session itself is untouched');
    assert.equal(await works(his.secret), true, "another person's manager is untouched");
    // The next sign-in mints a new token, and the laptop's later sign-out stops that one too.
    h.alive.add('gm5');
    const again = h.module.managers.mint({ userId: ALICE, sessionId: 'gm5' })!;
    assert.equal(await works(again.secret), true);
    portal.signOut(laptop);
    assert.equal(await works(again.secret), false);

    // A disable or removal (revokeUser with nothing kept) ends theirs too.
    portal.revokeUser('u_bob');
    assert.equal(await works(his.secret), false);

    // A new server code (rotate) ends every other session: the person who keeps theirs keeps their manager, the others lose theirs.
    const owner = portal.signIn('24681357');
    portal.openSession(ALICE);
    h.alive.add('gm3');
    h.alive.add('gm4');
    const owners = h.module.managers.mint({ userId: 'u_owner', sessionId: 'gm3' })!;
    const alices = h.module.managers.mint({ userId: ALICE, sessionId: 'gm4' })!;
    portal.rotate(owner);
    assert.equal(await works(owners.secret), true, 'the founding user kept their session');
    assert.equal(await works(alices.secret), false);
  } finally {
    h.done();
  }
});

test('the token: hashed at rest, at most 7 days, replaced on a new mint, refused once its session ended', async () => {
  const h = await portalMcpHarness({ registry: registry() });
  try {
    h.alive.add('gm1');
    const first = h.module.managers.mint({ userId: ALICE, sessionId: 'gm1' })!;
    const row = h.store.db!.prepare('SELECT token_hash, created_at, expires_at FROM pmcp_manager_tokens WHERE id = ?').get(first.tokenId) as {
      token_hash: string;
      created_at: string;
      expires_at: string;
    };
    assert.ok(!row.token_hash.includes(first.secret.slice(5)), 'only a hash is stored');
    assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), 7 * 24 * 60 * 60 * 1000);
    const second = h.module.managers.mint({ userId: ALICE, sessionId: 'gm1' })!;
    assert.deepEqual(h.module.managers.verify(first.secret), { ok: false, reason: 'revoked', tokenId: first.tokenId });
    assert.equal(h.module.managers.verify(second.secret).ok, true);
    h.alive.delete('gm1');
    assert.equal(h.module.managers.verify(second.secret).ok, false);
    // A cpmt_ token is not an admin's or an agent's: neither of those stores knows it.
    assert.equal(h.module.tokens.verify(second.secret, '10.0.0.9').ok, false);
    assert.equal(h.module.agents.verify(second.secret).ok, false);
  } finally {
    h.done();
  }
});

test('migration 793: every session is a workspace session of the founding user, and a second manager per person is refused', async () => {
  const h = await portalMcpHarness();
  try {
    const db = h.store.db!;
    const at = new Date().toISOString();
    const add = (id: string, kind?: string, owner?: string) =>
      db
        .prepare(
          `INSERT INTO chat_sessions (id, workspace_id, state_since, created_at, last_activity_at${kind ? ', kind' : ''}${owner ? ', owner_id' : ''}) VALUES (?, 'docker/api', ?, ?, ?${kind ? ', ?' : ''}${owner ? ', ?' : ''})`,
        )
        .run(id, at, at, at, ...(kind ? [kind] : []), ...(owner ? [owner] : []));
    add('w1');
    add('w2');
    // node:sqlite rows have a null prototype: copy into a plain object before the strict compare.
    assert.deepEqual({ ...db.prepare("SELECT kind, owner_id FROM chat_sessions WHERE id = 'w1'").get() }, { kind: 'workspace', owner_id: 'u_owner' });
    add('gm1', 'manager');
    assert.throws(() => add('gm2', 'manager'), /UNIQUE/, 'one manager per person, in the database');
    add('gm3', 'manager', ALICE);
    assert.throws(() => add('gm4', 'manager', ALICE), /UNIQUE/);
    assert.throws(() => add('x1', 'robot'), /CHECK/);
    // The index holds live rows only (review 2026-10-18): Disable ends the manager and its transcript stays; Enable again makes a new one.
    const end = (id: string) => db.prepare("UPDATE chat_sessions SET state = 'ended' WHERE id = ?").run(id);
    end('gm3');
    add('gm5', 'manager', ALICE);
    end('gm5');
    add('gm6', 'manager', ALICE);
    assert.throws(() => add('gm7', 'manager', ALICE), /UNIQUE/, 'still one live manager per person');
    const rows = db.prepare("SELECT id, state FROM chat_sessions WHERE kind = 'manager' AND owner_id = ? ORDER BY id").all(ALICE) as { id: string; state: string }[];
    assert.deepEqual(rows.map((r) => r.id), ['gm3', 'gm5', 'gm6'], 'the ended ones stay');
    assert.deepEqual(rows.filter((r) => r.state !== 'ended').map((r) => r.id), ['gm6']);
    // Bringing an ended manager back while another is live is refused as well.
    assert.throws(() => db.prepare("UPDATE chat_sessions SET state = 'idle' WHERE id = 'gm5'").run(), /UNIQUE/);
  } finally {
    h.done();
  }
});

test('review 2026-10-18 M4: a token passes only while its person is signed in; a check that says no revokes it', async () => {
  const h = await portalMcpHarness({ registry: registry() });
  try {
    let signedIn = true;
    const tokens = new ManagerTokens(h.store, { alive: () => true, signedIn: () => signedIn });
    const t = tokens.mint({ userId: ALICE, sessionId: 'gm1' })!;
    assert.equal(tokens.verify(t.secret).ok, true);
    signedIn = false;
    assert.deepEqual(tokens.verify(t.secret), { ok: false, reason: 'revoked', tokenId: t.tokenId });
    signedIn = true;
    assert.equal(tokens.verify(t.secret).ok, false, 'revoked stays revoked: the next sign-in mints a new one');
  } finally {
    h.done();
  }
});

test('review 2026-10-18 M4: an expired login signs the person out (their manager stops), like a sign-out', () => {
  const portal = new Portal(undefined, 50);
  const out: string[] = [];
  portal.onSignedOut = (u) => void out.push(u);
  const token = portal.openSession(ALICE);
  const start = Date.now();
  while (Date.now() - start < 80) {
    // wait past the 50 ms login lifetime
  }
  assert.equal(portal.anySession(token), undefined);
  assert.deepEqual(out, [ALICE]);
});
