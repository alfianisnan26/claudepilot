// T-968 review (2026-10-18): ci_run_trigger for the General Manager, through the tool. Its `cpmt_` token acts as its person, but it may start
// DEPLOYMENT pipelines only (a job names an environment, and that job waits for a person): any other pipeline, on any ref, is refused and
// nothing starts. A person's own operate token keeps starting any pipeline. Tokens are minted at run time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOUNDING_USER_ID } from '@portal/contracts';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { registerCiTools } from './portalTools.js';
import { FakeSessions } from './sessions.js';
import { harness, remote, WS } from './testkit.js';

const GATE = 'on: manual\njobs:\n  t:\n    steps: [{ run: echo gate }]\n';
const DEPLOY = 'on: manual\njobs:\n  build:\n    steps: [{ run: echo build }]\n  release:\n    needs: [build]\n    environment: stg\n    steps: [{ run: echo released }]\n';
const FILES = { '.pilot/gate.yml': GATE, '.pilot/deploy.yml': DEPLOY };

test('the General Manager starts a deployment pipeline (its release waits for a person) and nothing else; a person\'s token starts any', async () => {
  const sessions = new FakeSessions();
  const audits: { kind: string; actor: string; detail?: Record<string, unknown> }[] = [];
  const h = await harness({ sessions, audit: (e) => void audits.push(e) });
  const mcp = await portalMcpHarness();
  try {
    registerCiTools(h.svc, sessions, mcp.registry);
    await remote(h, FILES);
    h.home.git(['checkout', '-q', '-B', 'dev/x', 'main'], h.src);
    h.home.git(['push', '-q', 'pilot', 'dev/x'], h.src);
    mcp.alive.add('gm1');
    const gm = mcp.module.managers.mint({ userId: FOUNDING_USER_ID, sessionId: 'gm1' })!.secret;
    const call = (secret: string, args: Record<string, unknown>) => mcp.call(secret, 'ci_run_trigger', { workspace_id: WS, repo: 'app', ...args }).then((r) => r.result!);
    const started = () => audits.filter((a) => a.kind === 'ci.run_started');

    // Not a deployment pipeline: refused, on main and on any other ref; nothing started.
    for (const ref of ['main', 'dev/x']) {
      const no = await call(gm, { pipeline: 'gate', ref });
      assert.equal(no.isError, true, JSON.stringify(no));
      assert.match(no.content![0]!.text, /General Manager starts deployment pipelines only/);
    }
    assert.equal(started().length, 0);

    // A deployment pipeline: started as the manager, its deploying job held for a person.
    const d = await call(gm, { pipeline: 'deploy', ref: 'main' });
    assert.equal(d.isError, undefined, JSON.stringify(d));
    assert.match(d.content![0]!.text, /waits for a person's approval/);
    const id = d.structuredContent.run.id as string;
    await h.until('the release to wait', () => h.svc.get(id).deployments.some((x) => x.approval === 'waiting'));
    assert.deepEqual(started().map((a) => [a.detail?.pipeline, a.detail?.rule]), [['deploy', 'deployment']]);
    // Review 2026-10-18 M2: a deployment pipeline on a feature branch is refused too (its jobs before the deploying one would run that
    // branch's code); only integration or the default branch.
    const branch = await call(gm, { pipeline: 'deploy', ref: 'dev/x' });
    assert.equal(branch.isError, true, JSON.stringify(branch));
    assert.match(branch.content![0]!.text, /on integration or the default branch/);
    assert.equal(started().length, 1);

    // The rule is the manager's only: a person's own operate token still starts the gate.
    const person = await call(mcp.token('operate').secret, { pipeline: 'gate', ref: 'main' });
    assert.equal(person.isError, undefined, JSON.stringify(person));
    assert.deepEqual(started().map((a) => a.detail?.rule), ['deployment', 'token']);
  } finally {
    mcp.done();
    h.done();
  }
});
