// T-476: the rule for ci_run_trigger from an agent, as decided in ci/authz.ts. Through the tool itself: leadTriggerMcp.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentStart, isProgramBranch } from './authz.js';
import { WS } from './testkit.js';

const BAD = ['main', 'refs/heads/dev/x', 'heads/dev/x', 'origin/dev/x', 'dev/../main', 'dev/x/../../main', 'Dev/x', 'DEV/x', 'dev/', 'dev', 'dev//x', 'dev/.x', 'dev/x.lock', 'dev/x.', 'devx/y', 'dev-x', 'ticket', 'dev/x y', 'dev/x~1', 'dev/x^', 'dev/@{u}', 'dev/x:y', '-dev/x', 'release/dev/x', `dev/${'x'.repeat(100)}`];

test('branches a lead may test: dev/* and ticket/* exactly, nothing that only looks like one', () => {
  for (const ok of ['dev/x', 'dev/T-271', 'ticket/476-lead-gate', 'dev/t-476/1', 'dev/a.b_c-d']) assert.equal(isProgramBranch(ok), true, ok);
  for (const bad of BAD) assert.equal(isProgramBranch(bad), false, JSON.stringify(bad));
});

test('the rule, decided in authz.ts: own branch, a lead on its program remote, else deployments only (another program: not found)', () => {
  const app = { name: 'app', workspaceId: WS, sourcePath: '/w/app', connected: ['/w/app'] };
  const other = { name: 'other', workspaceId: WS, sourcePath: '/w/other', connected: [] };
  const lead = { id: 'l', title: '', ticketId: null, branch: null, live: true, state: 'idle' as const, workspaceId: WS, lastActivityAt: '', cwd: '/w/app', lead: true };
  assert.deepEqual(agentStart(lead, app, 'dev/x'), { rule: 'program_branch', ref: 'refs/heads/dev/x' });
  assert.equal(agentStart(lead, app, 'main').rule, 'deployment');
  const elsewhere = agentStart(lead, other, 'dev/x');
  assert.equal(elsewhere.rule === 'deployment' && elsewhere.refusal.code, 'NOT_FOUND');
  assert.equal(agentStart({ ...lead, lead: false }, app, 'dev/x').rule, 'deployment', 'no crew: not a lead');
  assert.equal(agentStart({ ...lead, cwd: '/w/app/sub' }, app, 'dev/x').rule, 'deployment', 'the folder must be the remote\'s exactly');
  assert.equal(agentStart({ ...lead, lead: false, branch: 'dev/y' }, app, 'dev/y').rule, 'own_branch');
});
