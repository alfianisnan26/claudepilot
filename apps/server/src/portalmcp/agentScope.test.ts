import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { agentCallable, portalTools, ToolRegistry, userTier } from './registry.js';
import { registerBuiltInPortalTools } from './tools/index.js';
import { portalMcpHarness } from './testkit.js';
import { registerTicketTools } from '../tickets/portalTools.js';
import { Tickets } from '../tickets/service.js';
import { FakeSessions } from '../tickets/testkit.js';

// The agents' scope over the portal's REAL tool set (interfaces I8 and I11): whatever area registers a tool, an
// agent's per-session token reaches only the ones that opted in, and none of those can be destructive.

test('registering: an agent-callable tool can’t be destructive', () => {
  const r = new ToolRegistry();
  const base = { title: 't', description: 'd', input: z.object({}), handler: () => ({}) };
  assert.throws(() => r.register({ ...base, name: 'bad_one', scope: 'agent', hints: { destructive: true } }), /destructive/);
  assert.throws(() => r.register({ ...base, name: 'bad_two', scope: 'operate', audience: 'both', hints: { destructive: true } }), /destructive/);
  r.register({ ...base, name: 'fine_one', scope: 'admin', hints: { destructive: true } });
  r.register({ ...base, name: 'fine_two', scope: 'agent', hints: { readOnly: true } });
  assert.equal(userTier({ scope: 'agent', hints: { readOnly: true } }), 'read');
  assert.equal(userTier({ scope: 'agent' }), 'operate');
  assert.equal(userTier({ scope: 'admin' }), 'admin');
  assert.equal(agentCallable({ scope: 'operate', audience: 'both' }), true);
  assert.equal(agentCallable({ scope: 'operate' }), false);
});

test('over the real tool set an agent sees only what opted in, and every other tool is refused by name', async () => {
  // The built-in tools and the ticket tools, registered as index.ts does (their handlers are never run here: no services).
  const fake = new Proxy({}, { get: () => ({}) });
  registerBuiltInPortalTools({ store: fake, module: fake, workspaces: fake, chat: fake, accounts: fake, accountPools: fake, poolService: fake, reconciler: fake, mcp: fake } as never);
  registerTicketTools(new Tickets({ db: null, writable: false } as never, new FakeSessions()));
  const h = await portalMcpHarness({ registry: portalTools });
  try {
    const a = await h.agentToken('docker/api', 'sa');
    const listed = new Set<string>((await h.rpc(a.secret, 'tools/list')).body.result.tools.map((t: { name: string }) => t.name));
    const all = portalTools.list();
    assert.ok(all.length > 40, `the real tool set is registered (${all.length})`);
    const optedIn = all.filter(agentCallable).map((t) => t.name).sort();
    assert.deepEqual([...listed].sort(), optedIn, 'an agent is offered exactly the tools that opted in');
    for (const t of all) {
      if (agentCallable(t)) {
        assert.ok(!t.hints?.destructive, `${t.name} is offered to agents but destructive`);
        assert.notEqual(t.requires, 'session_control', `${t.name}: session control is an admin switch`);
        continue;
      }
      const r = await h.call(a.secret, t.name, { id: 'x', confirm_token: 'x' });
      assert.ok(r.error || r.result?.isError, `${t.name} must be refused to an agent`);
      assert.ok(!/ok|confirmation_required/.test(JSON.stringify(r.result?.structuredContent ?? {}).slice(0, 0)), t.name);
    }
    // The agents' tools are the ones people expect: tickets, the catalog proposal, who-am-I.
    for (const name of ['portal_status', 'mcp_propose_entry', 'mcp_catalog_list', 'ticket_list', 'ticket_claim_next', 'ticket_comment']) assert.ok(listed.has(name), name);
    for (const name of ['workspace_create', 'workspace_delete', 'pool_assign', 'session_send', 'mcp_lockdown', 'account_check', 'audit_search']) assert.ok(!listed.has(name), `${name} is never an agent's`);
    // The proposals an agent can make are rate and size limited.
    for (const name of ['mcp_propose_entry']) {
      const t = portalTools.get(name)!;
      assert.ok(t.rate?.perHour && t.maxArgsBytes, `${name} declares a rate and a size cap`);
    }
  } finally {
    h.done();
  }
});
