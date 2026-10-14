// T-336: the admin tool session_start with a parent. A session it starts with `parent` is that session's worker, made through the same
// create a session_spawn makes: it shows in the parent's session_family, its turn end reaches the parent in one line, and the parent's
// limits hold (workers at once, depth). A parent that is missing, ended, in another workspace or one the caller may not operate is ONE
// not-found answer, and nothing starts.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { clearResolvers, declaredToolPolicies } from '../authz/seam.js';
import { declarePortalMcpPolicies } from '../portalmcp/authz.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { registerSessionTools } from '../portalmcp/tools/sessions.js';
import type { AgentCaps } from './agents.js';
import { registerChatAuthz } from './authz.js';
import { SESSION_CAP } from './caps.js';
import { CREW_REPORT_ACTOR } from './controller.js';
import { registerChatTools } from './portalTools.js';
import { line, liveSession, sleep, until } from './testkit.js';

const CAPS: AgentCaps = { maxDepth: 1, maxChildren: 5, spawnsPerHour: 20, messagesPerHour: 40 };

afterEach(() => clearResolvers());

async function rig() {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const s = await liveSession();
  s.controller.agentCaps = () => CAPS;
  s.controller.crewSettleMs = 20;
  s.controller.crewReportMs = 60;
  registerChatTools(s.controller, registry);
  registerSessionTools({ store: s.store, chat: s.controller }, registry);
  h.module.settings.update({ sessionControl: true });
  h.alive.add(s.id);
  const admin = h.token('admin');
  const start = (args: Record<string, unknown>) => h.call(admin.secret, 'session_start', { workspace_id: 'docker/ws1', ...args });
  return { h, s, admin, start, done: async () => (h.done(), s.done()) };
}

/** The lead's crew reports, as stored in its transcript. */
const reportsOf = (r: Awaited<ReturnType<typeof rig>>) => r.s.controller.history(r.s.id).flatMap((e) => (e.kind === 'user' && e.actor === CREW_REPORT_ACTOR ? [e.text ?? ''] : []));

test('session_start with parent: a worker of that session, in its family, and its turn end reaches the parent in one line', async () => {
  const r = await rig();
  try {
    const before = r.s.ws.tails.length;
    const started = await r.start({ parent: r.s.id, report: 'idle', title: 'Slice one' });
    assert.equal(started.result?.isError, undefined, JSON.stringify(started.raw));
    const id = started.result!.structuredContent.session.id as string;
    assert.equal(started.result!.structuredContent.session.parent_id, r.s.id);
    assert.match(started.result!.content![0]!.text, new RegExp(`a worker of ${r.s.id}`));
    await until(() => r.s.ws.tails.length === before + 1);
    await until(() => r.s.controller.get(id)?.state === 'idle');
    await sleep(20);
    const made = r.s.controller.get(id)!;
    assert.deepEqual([made.parentId, made.startedBy, made.bypassCapable], [r.s.id, `portal-mcp:${r.admin.id}`, false]);

    // The lead sees it in its family (its own token).
    const lead = await r.h.agentToken('docker/ws1', r.s.id);
    const fam = (await r.h.call(lead.secret, 'session_family', {})).result!.structuredContent;
    assert.deepEqual(
      fam.workers.map((w: { id: string }) => w.id),
      [id],
    );

    // Its turn ends: the lead gets the one-line report.
    const tail = r.s.ws.tails.at(-1)!;
    assert.equal((await r.h.call(r.admin.secret, 'session_send', { id, text: 'Split the router.' })).result?.isError, undefined);
    const csid = r.s.controller.get(id)!.claudeSessionId;
    const msg = r.s.controller.history(id).findLast((e) => e.kind === 'user')!;
    tail.push(line({ type: 'command_lifecycle', command_uuid: msg.uuid, state: 'started', uuid: randomUUID(), session_id: csid }));
    tail.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] }, parent_tool_use_id: null, uuid: randomUUID() }));
    tail.push(line({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, usage: { input_tokens: 1, output_tokens: 1 }, is_error: false, session_id: csid }));
    await until(() => reportsOf(r).some((x) => x.includes(id)));
    assert.match(reportsOf(r).find((x) => x.includes(id))!, /Worker “Slice one”/);
  } finally {
    await r.done();
  }
});

test('session_start with parent: unknown, ended, another workspace’s or a refused parent is the same not found, and nothing starts', async () => {
  const r = await rig();
  try {
    const elsewhere = await r.s.controller.create({ workspaceId: 'docker/ws2', title: 'Elsewhere' });
    const gone = await r.s.controller.create({ workspaceId: 'docker/ws1', title: 'Gone' });
    await until(() => r.s.ws.tails.length === 3);
    await until(() => r.s.controller.get(gone.id)?.state === 'idle');
    await r.s.controller.end(gone.id);
    const sessions = () => r.s.controller.list({}).length;
    const count = sessions();
    const answer = async (parent: string) => {
      const res = await r.start({ parent, prompt: 'x' });
      assert.equal(res.result?.isError, true, parent);
      return res.result!.structuredContent.error as { code: string; message: string };
    };
    const unknown = await answer(randomUUID());
    assert.equal(unknown.code, 'NOT_FOUND');
    assert.deepEqual(await answer(gone.id), unknown, 'ended');
    assert.deepEqual(await answer(elsewhere.id), unknown, 'another workspace');
    // The seam refuses the caller on the parent (another user's session): the same answer.
    registerChatAuthz((id) => {
      const f = r.s.controller.sessionFacts(id);
      return f && f.id === r.s.id ? { ...f, ownerId: 'u_b' } : f;
    });
    assert.deepEqual(await answer(r.s.id), unknown, 'refused by the seam');
    clearResolvers();
    assert.equal(sessions(), count, 'nothing was started');
    // report is only for a worker.
    assert.equal((await r.start({ report: 'idle' })).result?.structuredContent.error.code, 'VALIDATION_FAILED');
    assert.equal(sessions(), count);
    // Declared on the seam: the workspace and the optional parent.
    declarePortalMcpPolicies();
    assert.deepEqual(declaredToolPolicies().get('session_start')?.kind, 'objects');
  } finally {
    await r.done();
  }
});

test('session_start with parent: the parent’s limits hold (its workers at once, the depth)', async () => {
  const r = await rig();
  try {
    r.s.controller.setLimits(r.s.id, { maxWorkers: 1 }, { actor: 'ui' });
    const one = await r.start({ parent: r.s.id });
    assert.equal(one.result?.isError, undefined, JSON.stringify(one.raw));
    const workerId = one.result!.structuredContent.session.id as string;
    await until(() => r.s.controller.get(workerId)?.state === 'idle');
    const count = r.s.controller.list({}).length;
    const two = await r.start({ parent: r.s.id });
    assert.equal(two.result?.structuredContent.error.code, SESSION_CAP, 'one worker at once');
    // A worker is at depth 1 (the cap): it can't be a parent.
    const deeper = await r.start({ parent: workerId });
    assert.equal(deeper.result?.structuredContent.error.code, SESSION_CAP, 'depth');
    assert.equal(r.s.controller.list({}).length, count, 'nothing more was started');
  } finally {
    await r.done();
  }
});
