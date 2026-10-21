// T-348: a Portal MCP tool's declared policy is enforced at dispatch, through the one can(), before its handler runs. Per tool family: a
// denied actor gets the SAME result as for a missing object (byte for byte), and an allowed one reaches the handler. Then: every real tool's
// declaration names arguments its tool has, so no declaration says more (or less) than the dispatch can check.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { AppError } from '@isnanme/core';
import { FOUNDING_USER_ID, objectRef, type ObjectType, type ToolPolicy, type UserId } from '@portal/contracts';
import { z } from 'zod';
import { clearResolvers, declareToolPolicies, declaredToolPolicies, registerResolver } from '../authz/seam.js';
import { portalMcpHarness } from './testkit.js';
import { portalTools, ToolRegistry, type PortalToolDefinition } from './registry.js';

const WS = 'kubernetes/w1';
const OTHER_WS = 'kubernetes/w2';
const U_B = 'u_b' as UserId;

/** Objects of one type, by id: who owns each (missing ids are not there at all). */
function resolverOf(type: ObjectType, rows: Record<string, { owner: UserId; workspaceId: string }>): void {
  registerResolver({
    type,
    resolve: (id) => {
      const r = rows[id];
      return r ? { ref: objectRef(type, id), owner: { kind: 'user', id: r.owner }, attrs: { workspaceId: r.workspaceId } } : null;
    },
  });
}

after(() => clearResolvers());

/** A toy tool with a declared policy; its handler counts the calls that reached it and can answer its own NOT_FOUND. */
function family(policy: ToolPolicy, input: z.ZodObject, opts: { scope?: PortalToolDefinition['scope']; ownNotFound?: (args: Record<string, unknown>) => string | null } = {}) {
  const registry = new ToolRegistry();
  const name = `t348_${Math.random().toString(36).slice(2, 10)}`;
  const reached: unknown[] = [];
  declareToolPolicies('toolPolicy.test', { [name]: policy });
  registry.register({
    name,
    title: 'Toy',
    description: 'A toy tool for the dispatch check.',
    scope: opts.scope ?? 'agent',
    hints: { readOnly: true },
    input,
    handler: (_ctx, args) => {
      const own = opts.ownNotFound?.(args as Record<string, unknown>);
      if (own) throw new AppError('NOT_FOUND', own);
      reached.push(args);
      return { summary: 'reached', ok: true };
    },
  });
  return { registry, name, reached };
}

test('session family: a session of another user, or outside an agent\'s box, reads exactly like a missing one; the own one reaches the handler', async () => {
  resolverOf('session', { s_mine: { owner: FOUNDING_USER_ID, workspaceId: WS }, s_ended: { owner: FOUNDING_USER_ID, workspaceId: WS }, s_theirs: { owner: U_B, workspaceId: WS }, s_agent: { owner: FOUNDING_USER_ID, workspaceId: WS } });
  const NO = 'No such session.';
  const f = family({ kind: 'objects', checks: [{ type: 'session', verb: 'operate', arg: 'session_id', notFound: NO }] }, z.object({ session_id: z.string() }), {
    // The handler's own refusal (an ended session): the dispatch must answer a refusal with the same bytes.
    ownNotFound: (a) => (a.session_id === 's_ended' ? NO : null),
  });
  const h = await portalMcpHarness({ registry: f.registry });
  try {
    const admin = h.token('operate').secret;
    const theirs = await h.call(admin, f.name, { session_id: 's_theirs' });
    const missing = await h.call(admin, f.name, { session_id: 's_nosuch' });
    const ended = await h.call(admin, f.name, { session_id: 's_ended' });
    assert.equal(theirs.result?.isError, true);
    assert.equal(theirs.result?.structuredContent.error.code, 'NOT_FOUND');
    assert.deepEqual(theirs.result, missing.result, 'another user\'s session reads like a missing one');
    assert.deepEqual(theirs.result, ended.result, 'and like the handler\'s own not found');
    assert.equal(f.reached.length, 0, 'the handler never saw a refused call');
    assert.equal((await h.call(admin, f.name, { session_id: 's_mine' })).result?.isError, undefined);
    assert.equal(f.reached.length, 1, 'an allowed call reaches the handler');

    const agent = (await h.agentToken(WS, 's_agent')).secret;
    const other = await h.call(agent, f.name, { session_id: 's_mine' });
    assert.equal(other.result?.structuredContent.error.code, 'NOT_FOUND');
    assert.deepEqual(other.result, (await h.call(agent, f.name, { session_id: 's_nosuch' })).result, 'another session of its workspace is not there for an agent');
    assert.equal(f.reached.length, 1);
    assert.equal((await h.call(agent, f.name, { session_id: 's_agent' })).result?.isError, undefined);
    assert.equal(f.reached.length, 2, 'its own session reaches the handler');
  } finally {
    h.done();
    clearResolvers();
  }
});

test('workspace family (no resolver, as today): an agent outside its workspace gets the missing answer; the owner\'s token keeps every workspace', async () => {
  const f = family({ kind: 'objects', checks: [{ type: 'workspace', verb: 'operate', arg: 'workspace_id' }] }, z.object({ workspace_id: z.string() }));
  const h = await portalMcpHarness({ registry: f.registry });
  try {
    const agent = (await h.agentToken(WS, 's_a')).secret;
    const other = await h.call(agent, f.name, { workspace_id: OTHER_WS });
    assert.equal(other.result?.structuredContent.error.code, 'NOT_FOUND');
    assert.deepEqual(other.result, (await h.call(agent, f.name, { workspace_id: 'kubernetes/nosuch' })).result);
    assert.equal(f.reached.length, 0);
    assert.equal((await h.call(agent, f.name, { workspace_id: WS })).result?.isError, undefined);
    const admin = h.token('operate').secret;
    assert.equal((await h.call(admin, f.name, { workspace_id: OTHER_WS })).result?.isError, undefined, 'the owner\'s token is not narrowed');
    assert.equal(f.reached.length, 2);
  } finally {
    h.done();
  }
});

test('ci family: a run of another user\'s workspace reads like a missing run (the tools\' own text); an own run reaches the handler', async () => {
  resolverOf('ci_run', { r_mine: { owner: FOUNDING_USER_ID, workspaceId: WS }, r_theirs: { owner: U_B, workspaceId: OTHER_WS } });
  const NO = 'No such run.';
  const f = family({ kind: 'objects', checks: [{ type: 'ci_run', verb: 'view', arg: 'id', notFound: NO }] }, z.object({ id: z.string() }));
  const h = await portalMcpHarness({ registry: f.registry });
  try {
    for (const secret of [h.token('read').secret, (await h.agentToken(WS, 's_a')).secret]) {
      const theirs = await h.call(secret, f.name, { id: 'r_theirs' });
      assert.equal(theirs.result?.structuredContent.error.message, NO);
      assert.deepEqual(theirs.result, (await h.call(secret, f.name, { id: 'r_nosuch' })).result);
    }
    assert.equal(f.reached.length, 0);
    assert.equal((await h.call(h.token('read').secret, f.name, { id: 'r_mine' })).result?.isError, undefined);
    assert.equal(f.reached.length, 1);
  } finally {
    h.done();
    clearResolvers();
  }
});

test('platform family: an agent never reaches a platform tool; the owner\'s token does', async () => {
  const f = family({ kind: 'platform', area: 'version', verb: 'view' }, z.object({}));
  const h = await portalMcpHarness({ registry: f.registry });
  try {
    const denied = await h.call((await h.agentToken(WS, 's_a')).secret, f.name, {});
    assert.equal(denied.result?.structuredContent.error.code, 'NOT_FOUND');
    assert.equal(f.reached.length, 0);
    assert.equal((await h.call(h.token('read').secret, f.name, {})).result?.isError, undefined);
    assert.equal(f.reached.length, 1);
  } finally {
    h.done();
  }
});

test('optional, many and a missing required argument: left out is not checked, every id of a list is, a declared argument the call lacks is refused', async () => {
  resolverOf('session', { s_mine: { owner: FOUNDING_USER_ID, workspaceId: WS }, s_theirs: { owner: U_B, workspaceId: WS } });
  const opt = family({ kind: 'objects', checks: [{ type: 'session', verb: 'operate', arg: 'parent', optional: true }] }, z.object({ parent: z.string().optional() }), { scope: 'admin' });
  const many = family({ kind: 'objects', checks: [{ type: 'session', verb: 'view', arg: 'ids', many: true }] }, z.object({ ids: z.array(z.string()) }), { scope: 'admin' });
  const lacks = family({ kind: 'objects', checks: [{ type: 'session', verb: 'view', arg: 'id' }] }, z.object({ other: z.string().optional() }), { scope: 'admin' });
  const registry = new ToolRegistry();
  for (const t of [opt, many, lacks]) registry.register(t.registry.get(t.name)!);
  const h = await portalMcpHarness({ registry });
  try {
    const admin = h.token('admin').secret;
    assert.equal((await h.call(admin, opt.name, {})).result?.isError, undefined);
    assert.equal((await h.call(admin, opt.name, { parent: '' })).result?.isError, undefined, 'empty is left out, as the handlers read it');
    assert.equal((await h.call(admin, opt.name, { parent: 's_theirs' })).result?.structuredContent.error.code, 'NOT_FOUND');
    assert.equal(opt.reached.length, 2);
    assert.equal((await h.call(admin, many.name, { ids: ['s_mine', 's_theirs'] })).result?.structuredContent.error.code, 'NOT_FOUND');
    assert.equal((await h.call(admin, many.name, { ids: ['s_mine'] })).result?.isError, undefined);
    assert.equal(many.reached.length, 1);
    assert.equal((await h.call(admin, lacks.name, {})).result?.structuredContent.error.code, 'NOT_FOUND', 'fails closed');
    assert.equal(lacks.reached.length, 0);
  } finally {
    h.done();
    clearResolvers();
  }
});

test('agent, self and signed-in policies are the handler\'s: the dispatch adds no refusal', async () => {
  const fams = [family({ kind: 'agent', reach: 'workspace' }, z.object({ session_id: z.string() })), family({ kind: 'self' }, z.object({})), family({ kind: 'signed-in' }, z.object({}))];
  const registry = new ToolRegistry();
  for (const t of fams) registry.register(t.registry.get(t.name)!);
  const h = await portalMcpHarness({ registry });
  try {
    const agent = (await h.agentToken(WS, 's_a')).secret;
    for (const t of fams) assert.equal((await h.call(agent, t.name, { session_id: 's_elsewhere' })).result?.isError, undefined, t.name);
    assert.deepEqual(fams.map((t) => t.reached.length), [1, 1, 1]);
  } finally {
    h.done();
  }
});

/** Anything at all: the tools are only built here, never called, so their services are never asked. */
const stub: any = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.iterator || k === 'then' || k === Symbol.toPrimitive ? undefined : stub), apply: () => stub, construct: () => stub });

test('every real tool\'s object checks name arguments of its input, optional exactly where the input is', async () => {
  const { registerSessionTools } = await import('./tools/sessions.js');
  const { registerWorkspaceTools } = await import('./tools/workspaces.js');
  const { declarePortalMcpPolicies } = await import('./authz.js');
  const { registerChatTools } = await import('../chat/portalTools.js');
  const { registerChatAuthz } = await import('../chat/authz.js');
  const { registerCiTools } = await import('../ci/portalTools.js');
  const { registerClaudeVersionTools } = await import('../claudeversion/portalTools.js');
  const { declareClaudeVersionPolicies } = await import('../claudeversion/authz.js');
  const { registerKeepGoingTools } = await import('../keepgoing/portalTools.js');
  const { declareKeepGoingPolicies } = await import('../keepgoing/authz.js');
  const { registerLabTools } = await import('../lab/portalTools.js');
  const { registerTicketTools } = await import('../tickets/portalTools.js');
  const { registerAutoTransferTools } = await import('../autotransfer/portalTools.js');
  const { declareAutoTransferPolicies } = await import('../autotransfer/authz.js');
  const { declareWorkspacePolicies } = await import('../workspaces/authz.js');
  registerSessionTools(stub);
  registerWorkspaceTools(stub);
  registerChatTools(stub);
  registerCiTools(stub, undefined);
  registerClaudeVersionTools(stub);
  registerKeepGoingTools(stub);
  registerLabTools(stub);
  registerTicketTools(stub);
  registerAutoTransferTools(stub);
  const { registerChatManagerTools } = await import('../chat/managerTools.js');
  registerChatManagerTools(stub);
  declarePortalMcpPolicies();
  registerChatAuthz(() => null);
  declareClaudeVersionPolicies();
  declareKeepGoingPolicies();
  declareAutoTransferPolicies();
  declareWorkspacePolicies();
  clearResolvers();

  const checked: string[] = [];
  for (const [name, policy] of declaredToolPolicies()) {
    if (policy.kind !== 'objects' || name.startsWith('t348_')) continue;
    const tool = portalTools.get(name);
    assert.ok(tool, `${name} is declared and registered`);
    const shape = tool.input.shape as Record<string, z.ZodType>;
    for (const c of policy.checks) {
      assert.ok(c.arg in shape, `${name}: the declared argument ${c.arg} is in its input`);
      assert.equal(!!c.optional, shape[c.arg]!.safeParse(undefined).success, `${name}: ${c.arg} is optional in the declaration exactly when the input lets it out`);
    }
    checked.push(name);
  }
  assert.deepEqual(checked.sort(), ['approvals_list', 'autotransfer_events', 'autotransfer_status', 'ci_run_bump', 'ci_run_cancel', 'ci_run_get', 'ci_run_logs', 'crew_limits_get', 'manager_message', 'session_keepgoing_set', 'session_start', 'ticket_bump', 'ticket_create', 'ticket_list', 'ticket_update', 'workspace_rename', 'workspace_resources']);
});
