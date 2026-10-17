// T-356: the CI tools for a PERSON's token (an admin's cpat_ token acting as its owner), once workspaces have owners. With the workspace owned by
// someone else, ci_runs_list shows that token none of its runs (the same filter the route applies, D-58) and ci_run_trigger answers exactly as it
// does for a remote that does not exist. With the workspace the token owner's own, both behave as they always did.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { UserId } from '@portal/contracts';
import { clearResolvers } from '../authz/seam.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { registerCiAuthz } from './authz.js';
import { registerCiTools } from './portalTools.js';
import { FakeSessions } from './sessions.js';
import { FakeTickets } from './tickets.js';
import { harness, remote, WS } from './testkit.js';

const PIPELINE = 'on:\n  push: {}\n  manual: {}\njobs:\n  test:\n    steps:\n      - run: echo hi\n';
const OTHER = 'u_b' as UserId;

after(() => clearResolvers());

test('a person\'s token: ci_runs_list keeps to the runs it may view; ci_run_trigger on a remote it may not operate reads like a missing remote', async () => {
  const sessions = new FakeSessions();
  const h = await harness({ tickets: new FakeTickets('T-12'), sessions });
  const mcp = await portalMcpHarness();
  try {
    registerCiTools(h.svc, sessions, mcp.registry);
    await remote(h, { '.pilot/ci.yml': PIPELINE });
    h.home.git(['checkout', '-q', '-B', 'dev/x', 'main'], h.src);
    h.home.commit(h.src, { 'x.txt': 'x' }, 'change on dev/x');
    h.home.git(['push', '-q', 'pilot', 'dev/x'], h.src);
    await h.until('the run to finish', () => h.svc.list().items.length >= 1 && h.svc.list().items.every((r) => r.status === 'passed' || r.status === 'failed'));
    const runs = h.svc.list().items.length;

    const admin = mcp.token('admin');
    const listed = async () => (await mcp.call(admin.secret, 'ci_runs_list', {})).result!.structuredContent.runs as { id: string }[];

    // The token owner's own workspace (the founding user is the default owner): every run, and the trigger finds the remote.
    registerCiAuthz(h.svc);
    assert.equal((await listed()).length, runs, 'own workspace: all runs');
    const mine = await mcp.call(admin.secret, 'ci_run_trigger', { repo: 'app', pipeline: 'ci', ref: 'main', workspace_id: WS });
    assert.equal(mine.result!.isError, undefined, JSON.stringify(mine.result));

    // Someone else's workspace: none of its runs, and the trigger is the missing-remote answer, byte for byte but for the name asked.
    registerCiAuthz(h.svc, () => OTHER);
    assert.deepEqual(await listed(), [], 'another person\'s workspace: no runs');
    const before = h.svc.list().items.length;
    const denied = await mcp.call(admin.secret, 'ci_run_trigger', { repo: 'app', pipeline: 'ci', ref: 'main', workspace_id: WS });
    const missing = await mcp.call(admin.secret, 'ci_run_trigger', { repo: 'nosuch', pipeline: 'ci', ref: 'main', workspace_id: WS });
    assert.equal(denied.result!.isError, true);
    assert.equal(missing.result!.isError, true);
    assert.equal(denied.result!.content![0]!.text.replaceAll('app', '<repo>'), missing.result!.content![0]!.text.replaceAll('nosuch', '<repo>'), 'denied reads exactly like missing');
    assert.equal(h.svc.list().items.length, before, 'the denied call started nothing');
  } finally {
    mcp.done();
    h.done();
  }
});
