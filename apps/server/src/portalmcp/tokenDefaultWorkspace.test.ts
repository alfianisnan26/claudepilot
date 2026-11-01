import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import type { Actor, PortalToken } from '@portal/contracts';
import { Hono } from 'hono';
import { singleOwner, useAuthz, type Authz } from '../authz/seam.js';
import { MIGRATIONS } from '../store/migrations.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { registerTicketTools, ticketWorkspaceOf } from '../tickets/portalTools.js';
import { Tickets } from '../tickets/service.js';
import { FakeSessions, UI } from '../tickets/testkit.js';
import { WorkspaceIdentities } from '../workspaces/identity.js';
import { ToolRegistry, type PortalToolContext } from './registry.js';
import { createPortalMcpRoutes } from './routes.js';
import { portalMcpHarness, URL_ } from './testkit.js';
import { PortalTokens } from './tokens.js';

// T-1105: an operate or admin token may have a default workspace, set only by a person through the token route; ticket_create without a
// workspace_id takes it while the token may still operate it; an explicit workspace_id wins; agents' tokens never use it.

const OWNER: Actor = { kind: 'user', userId: 'u_owner', loginSessionId: 'test', via: 'ui' };
const WORKSPACES = [
  { id: 'kubernetes/konfersi', name: 'konfersi' },
  { id: 'docker/api', name: 'api' },
  { id: 'docker/secret', name: 'secret' },
];

/** The seam as today, except that `who` may not operate `workspace` (the multi-user layer's answer for a workspace you don't hold). */
function denying(workspace: string, who: (a: Actor) => boolean): Authz {
  return {
    ...singleOwner,
    can(actor, verb, object) {
      if (object.type === 'workspace' && object.id === workspace && who(actor)) return { allow: false, reason: 'not_found', level: 'none' };
      return singleOwner.can(actor, verb, object);
    },
  };
}

async function rig() {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const sessions = new FakeSessions();
  const tickets = new Tickets(h.store, sessions);
  tickets.start();
  // The workspaces the portal knows, as index.ts asks them (`Workspaces.resolve`): a removed one is retired and resolves to nothing.
  const identities = WorkspaceIdentities.memory();
  for (const w of WORKSPACES) identities.adopt(w.id.split('/')[0]!, w.name);
  registerTicketTools(tickets, registry, { workspaceExists: (id) => identities.resolve(id) !== null });
  const app = new Hono<{ Variables: { actor: Actor } }>();
  app.use('*', async (c, next) => {
    c.set('actor', OWNER);
    await next();
  });
  app.route('/api/portal-mcp', createPortalMcpRoutes(h.module, { workspaces: async () => WORKSPACES }));
  app.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', (e as Error).message);
    return c.json(err.toJSON(), err.status as 500);
  });
  const patch = async (id: string, body: unknown) => {
    const res = await app.request(`http://portal.test/api/portal-mcp/tokens/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => null)) as { data?: PortalToken; error?: { code: string } } | null;
    return { status: res.status, data: json?.data, error: json?.error };
  };
  /** ticket_create over the endpoint; returns the stored ticket's workspace. */
  const create = async (secret: string, args: Record<string, unknown> = {}) => {
    const r = await h.call(secret, 'ticket_create', { summary: 'From Hermes', ...args });
    const id = r.result?.structuredContent?.ticket?.id as string | undefined;
    assert.ok(id, JSON.stringify(r.result?.structuredContent));
    return tickets.get(UI, id).ticket.workspaceId;
  };
  return { h, tickets, sessions, identities, patch, create, done: () => (tickets.stop(), h.done()) };
}

test('a token’s default workspace: a ticket with no workspace_id goes there, an explicit one wins, an empty one is the shared queue', async () => {
  const r = await rig();
  try {
    const t = r.h.token('admin', 'hermes-konfersi-admin');
    assert.equal(await r.create(t.secret), null, 'no default yet: the shared queue');

    const set = await r.patch(t.id, { defaultWorkspaceId: 'kubernetes/konfersi' });
    assert.equal(set.status, 200, JSON.stringify(set.error));
    assert.equal(set.data?.defaultWorkspaceId, 'kubernetes/konfersi', 'the token view shows it');
    assert.equal(r.h.module.state(URL_).tokens.find((x) => x.id === t.id)?.defaultWorkspaceId, 'kubernetes/konfersi', 'and the list');

    assert.equal(await r.create(t.secret), 'kubernetes/konfersi', 'no workspace_id: the default');
    assert.equal(await r.create(t.secret, { workspace_id: 'docker/api' }), 'docker/api', 'an explicit workspace wins');
    assert.equal(await r.create(t.secret, { workspace_id: '' }), null, 'an empty one asks for the shared queue');

    // An operate token works the same; clearing it puts tickets back in the shared queue.
    const op = r.h.token('operate', 'script');
    assert.equal((await r.patch(op.id, { defaultWorkspaceId: 'docker/api' })).status, 200);
    assert.equal(await r.create(op.secret), 'docker/api');
    const cleared = await r.patch(op.id, { defaultWorkspaceId: null });
    assert.equal(cleared.data?.defaultWorkspaceId, null);
    assert.equal(await r.create(op.secret), null);

    // Every change is audited with who.
    const rows = (r.h.store.db!.prepare("SELECT token_id, details FROM pmcp_auth_events WHERE kind = 'token_default_workspace' ORDER BY id").all() as { token_id: string; details: string }[]).map((x) => ({
      id: x.token_id,
      ...(JSON.parse(x.details) as Record<string, unknown>),
    }));
    assert.deepEqual(rows, [
      { id: t.id, workspace: 'kubernetes/konfersi', from: null, by: 'user:u_owner' },
      { id: op.id, workspace: 'docker/api', from: null, by: 'user:u_owner' },
      { id: op.id, workspace: null, from: 'docker/api', by: 'user:u_owner' },
    ]);
  } finally {
    r.done();
  }
});

test('an agent’s token ignores any default: its ticket is in its own workspace', async () => {
  const r = await rig();
  try {
    const admin = r.h.token('admin', 'hermes-konfersi-admin');
    assert.equal((await r.patch(admin.id, { defaultWorkspaceId: 'kubernetes/konfersi' })).status, 200);
    r.sessions.add({ id: 'sa', workspaceId: 'docker/api', title: 'Session sa' });
    const agent = await r.h.agentToken('docker/api', 'sa');
    assert.equal(await r.create(agent.secret), 'docker/api');

    // The resolver itself: an agent's context (or the manager's) never takes a default, even one on its principal.
    const ctx = (kind: 'user' | 'agent' | 'manager', isAgent: boolean) =>
      ({ isAgent, principal: { kind, userId: 'u_owner', tokenId: 'ptk_x', label: 'x', scope: isAgent ? 'agent' : 'admin', workspaceId: isAgent ? 'docker/api' : null, sessionId: isAgent ? 'sa' : null, expiresAt: '', client: null, vaults: null, defaultWorkspaceId: 'kubernetes/konfersi' } }) as unknown as PortalToolContext;
    assert.equal(ticketWorkspaceOf(ctx('agent', true), undefined), undefined);
    assert.equal(ticketWorkspaceOf(ctx('manager', false), undefined), undefined);
    assert.equal(ticketWorkspaceOf(ctx('user', false), undefined), 'kubernetes/konfersi');
    assert.equal(ticketWorkspaceOf(ctx('user', false), 'docker/api'), 'docker/api');
  } finally {
    r.done();
  }
});

test('setting a default is refused for a workspace the person or the token may not operate, one that is not there, a read token and an ended token', async () => {
  const r = await rig();
  const t = r.h.token('admin', 'hermes-konfersi-admin');
  const read = r.h.token('read', 'dashboard');
  const was = useAuthz(denying('docker/secret', (a) => a.kind === 'user'));
  try {
    const person = await r.patch(t.id, { defaultWorkspaceId: 'docker/secret' });
    assert.equal(person.status, 404, 'the person may not operate it: the same not found as a missing one');
    useAuthz(denying('docker/secret', (a) => a.kind === 'token'));
    const token = await r.patch(t.id, { defaultWorkspaceId: 'docker/secret' });
    assert.equal(token.status, 403, 'the token may not operate it');
    assert.equal(token.error?.code, 'FORBIDDEN');
  } finally {
    useAuthz(was);
  }
  try {
    assert.equal((await r.patch(t.id, { defaultWorkspaceId: 'docker/gone' })).status, 404, 'not a workspace there is');
    assert.equal((await r.patch(t.id, { defaultWorkspaceId: '../etc' })).status, 422);
    assert.equal((await r.patch(t.id, { defaultWorkspaceId: 7 })).status, 422);
    assert.equal((await r.patch(t.id, {})).status, 422);
    assert.equal((await r.patch(read.id, { defaultWorkspaceId: 'docker/api' })).status, 422, 'a read token makes no tickets');
    assert.equal((await r.patch('ptk_nope', { defaultWorkspaceId: 'docker/api' })).status, 404);
    r.h.module.revokeToken(t.id);
    assert.equal((await r.patch(t.id, { defaultWorkspaceId: 'docker/api' })).status, 409, 'an ended token');
    assert.equal(r.h.module.tokens.get(t.id)?.defaultWorkspaceId, null, 'nothing was stored');
  } finally {
    r.done();
  }
});

test('a default the token may no longer operate is not used: the ticket goes to the shared queue', async () => {
  const r = await rig();
  try {
    const t = r.h.token('admin', 'hermes-konfersi-admin');
    assert.equal((await r.patch(t.id, { defaultWorkspaceId: 'kubernetes/konfersi' })).status, 200);
    const was = useAuthz(denying('kubernetes/konfersi', (a) => a.kind === 'token'));
    try {
      assert.equal(await r.create(t.secret), null);
    } finally {
      useAuthz(was);
    }
    assert.equal(await r.create(t.secret), 'kubernetes/konfersi', 'allowed again: used again');
  } finally {
    r.done();
  }
});

test('a default whose workspace was removed is not used: the ticket goes to the shared queue', async () => {
  const r = await rig();
  try {
    const t = r.h.token('admin', 'hermes-konfersi-admin');
    assert.equal((await r.patch(t.id, { defaultWorkspaceId: 'kubernetes/konfersi' })).status, 200);
    assert.equal(await r.create(t.secret), 'kubernetes/konfersi');
    r.identities.retire('kubernetes', 'konfersi');
    assert.equal(await r.create(t.secret), null, 'gone: the shared queue, though the single-owner seam would still allow the id');
    r.identities.allocate('kubernetes', 'konfersi');
    assert.equal(await r.create(t.secret), 'kubernetes/konfersi', 'a workspace by that name again: used again');
  } finally {
    r.done();
  }
});

test('migration 46: tokens from before have no default workspace, and one can be set', async () => {
  const secretKey = parseSecretKey(generateSecretKey());
  const dataDir = tempDirectory('cp-pmcp-mig46-');
  const old = await Store.open({ dataDir, secretKey, migrations: MIGRATIONS.filter((m) => m.version !== 46) });
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  old.db!.prepare("INSERT INTO pmcp_tokens (id, label, token_hash, last4, scope, created_at, expires_at) VALUES ('ptk_old', 'Old', 'h', 'abcd', 'admin', ?, ?)").run(at, later);
  assert.equal((old.db!.prepare('PRAGMA table_info(pmcp_tokens)').all() as { name: string }[]).some((c) => c.name === 'default_workspace_id'), false);
  old.close();

  const store = await Store.open({ dataDir, secretKey });
  try {
    const tokens = new PortalTokens(store);
    assert.equal(tokens.get('ptk_old')?.defaultWorkspaceId, null);
    assert.equal(tokens.setDefaultWorkspace('ptk_old', 'docker/api'), true);
    assert.equal(tokens.get('ptk_old')?.defaultWorkspaceId, 'docker/api');
  } finally {
    store.close();
  }
});
