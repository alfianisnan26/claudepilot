import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GlanceApproval, GlanceAttention, GlanceCiRun, GlanceDeploy, GlanceSession, GlanceSnapshot, GlanceTicket } from '@portal/contracts';
import { NEED_ORDER, needsYou } from './needs.js';

const T = (min: number) => new Date(Date.parse('2026-10-12T12:00:00Z') - min * 60_000).toISOString();
const block = <X>(items: X[], count = items.length, ok = true) => ({ ok, count, items });
const approval = (id: string, min: number): GlanceApproval => ({
  sessionId: `s-${id}`, sessionTitle: `Session ${id}`, workspaceId: 'docker/dev', claudeId: 'c1', claudeName: 'Work', requestId: id, kind: 'tool', toolName: 'Bash',
  title: 'Run a command', detail: 'npm test', full: 'npm test', fullCut: false, agentName: null, createdAt: T(min),
});
const deploy = (id: string, min: number): GlanceDeploy => ({ id, number: 4, repo: 'claudepilot', pipeline: 'deploy', job: 'release', branch: 'main', workspaceId: 'docker/dev', startedAt: T(min) });
const failed = (id: string): GlanceCiRun => ({ id, number: 7, repo: 'api', pipeline: 'ci', branch: 'feat', subject: null, reason: 'step_failed', finishedAt: T(30), workspaceId: 'docker/dev' });
const ticket = (id: string): GlanceTicket => ({ id, summary: `Ticket ${id}`, priority: 'high', type: 'task', status: 'open', workspaceId: null, updatedAt: T(60) });
const sess = (id: string, state: GlanceSession['state'], min: number): GlanceSession => ({
  id, title: `S ${id}`, state, workspaceId: 'docker/api-dev', claudeId: 'c1', claudeName: 'Work', lastActivityAt: T(min), waiting: 0, waitingFor: null, pinned: false, branch: null, agents: 0,
});

function snap(att: Partial<GlanceAttention>, sessions: Partial<GlanceSnapshot['sessions']> = {}): GlanceSnapshot {
  const attention = { approvals: block<GlanceApproval>([]), tickets: block<GlanceTicket>([]), ci: block<GlanceCiRun>([]), deploys: block<GlanceDeploy>([]), ...att } as GlanceAttention;
  attention.count = attention.approvals.count + attention.tickets.count + attention.ci.count + attention.deploys.count;
  return {
    at: T(0),
    sessions: { ok: true, running: 0, waiting: 0, open: 0, interrupted: 0, items: [], recent: [], ...sessions },
    agents: { ok: true, running: 0, waiting: 0, rows: [], more: 0 },
    attention,
  };
}

test('what needs you, most blocking first: approvals (longest waiting first), deploys, interrupted sessions, failed CI, tickets', () => {
  const data = snap(
    { approvals: block([approval('r2', 3), approval('r1', 9)]), deploys: block([deploy('d2', 5), deploy('d1', 20)]), ci: block([failed('c1')]), tickets: block([ticket('T-4')]) },
    { interrupted: 2, items: [sess('g', 'interrupted', 180), sess('a', 'working', 1)], recent: [sess('h', 'interrupted', 30), sess('g', 'interrupted', 180)] },
  );
  const n = needsYou(data, 20);
  assert.deepEqual(n.items.map((i) => i.key), ['a:r1', 'a:r2', 'd:d1', 'd:d2', 's:h', 's:g', 'c:c1', 't:T-4']);
  assert.deepEqual([...new Set(n.items.map((i) => i.kind))], [...NEED_ORDER]);
  // 2 approvals + 2 deploys + 2 interrupted + 1 failed run + 1 ticket
  assert.equal(n.total, 8);
  assert.deepEqual(n.items[0], { key: 'a:r1', kind: 'approval', title: 'Session r1', meta: 'Run a command: npm test', href: '/admin/sessions/s-r1', at: T(9), level: 'critical' });
  assert.deepEqual(n.items[2]!.href, '/admin/ci/runs/d1');
  assert.deepEqual(n.items[4], { key: 's:h', kind: 'interrupted', title: 'S h', meta: 'Interrupted · Work · api-dev', href: '/admin/sessions/h', at: T(30), level: 'warn' });
  assert.equal(n.items.at(-1)!.href, '/admin/tickets/T-4');
});

test('the list is capped while the total stays whole; the counts beyond what the snapshot lists are counted', () => {
  const data = snap({ approvals: block([approval('r1', 9), approval('r2', 8)], 14), tickets: block([ticket('T-1')], 40) }, { interrupted: 3 });
  const n = needsYou(data, 2);
  assert.deepEqual(n.items.map((i) => i.key), ['a:r1', 'a:r2']);
  assert.equal(n.listed, 2);
  // 14 approvals + 3 interrupted (none listed in the snapshot) + 40 tickets
  assert.equal(n.total, 57);
});

test('nothing waiting is an empty list and zero; a source that could not be read is named and never counted as zero', () => {
  assert.deepEqual(needsYou(snap({})), { items: [], total: 0, listed: 0, unread: [] });
  const blind = needsYou(snap({ ci: block<GlanceCiRun>([], 0, false), deploys: block<GlanceDeploy>([], 0, false) }, { ok: false, interrupted: 0 }));
  assert.deepEqual(blind.unread, ['deploys', 'sessions', 'CI']);
  assert.equal(blind.total, 0);
});
