import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VscodeAgent, VscodeApproval, VscodeStatus, VscodeTicket } from '../../../packages/contracts/src/vscode.js';
import { agentDescription, agentTree, approvalDocument, approvalHeadline, oneLine, statusView, ticketGroups } from '../src/model.js';
import { chatHtml, nonce } from '../src/page.js';

const agent = (id: string, o: Partial<VscodeAgent> = {}): VscodeAgent => ({
  id,
  title: `agent ${id}`,
  state: 'idle',
  waiting: 0,
  workspaceId: 'local/ws1',
  parentId: null,
  lead: false,
  ticketId: null,
  ticketKey: null,
  model: 'claude-opus-5-5',
  claudeName: 'Main',
  agent: null,
  costUsd: 0,
  costBasis: 'reported',
  lastActivityAt: new Date().toISOString(),
  url: `/admin/sessions/${id}`,
  ...o,
});

test('the Agents tree: leads at the top, workers under them at any depth, an orphan at the top, a loop cut', () => {
  const tree = agentTree([agent('lead'), agent('w1', { parentId: 'lead' }), agent('w2', { parentId: 'w1' }), agent('orphan', { parentId: 'gone' }), agent('x', { parentId: 'y' }), agent('y', { parentId: 'x' })]);
  const shape = (ns: ReturnType<typeof agentTree>): unknown => ns.map((n) => (n.children.length ? { [n.agent.id]: shape(n.children) } : n.agent.id));
  assert.deepEqual(shape(tree), [{ lead: [{ w1: ['w2'] }] }, 'orphan', { y: ['x'] }]);
});

test('an agent row says ticket, state, model and cost; an unknown turn cost is marked', () => {
  assert.equal(agentDescription(agent('a', { ticketKey: 'KONF-3', ticketId: 'T-3', state: 'waiting', waiting: 2, costUsd: 1.234 })), 'KONF-3 · waiting (2) · opus-5-5 · $1.23');
  assert.equal(agentDescription(agent('a', { ticketId: 'T-3', model: null, costBasis: 'unavailable' })), 'T-3 · idle · $0.00+');
});

const ticket = (id: string, bucket: string, status: VscodeTicket['status']): VscodeTicket => ({
  id,
  key: id,
  bucket,
  status,
  priority: 'normal',
  type: 'task',
  summary: id,
  assigneeSessionId: null,
  updatedAt: '',
  url: `/admin/tickets/${id}`,
});

test('tickets by bucket, then status with work in flight first, keeping the portal order inside', () => {
  const g = ticketGroups([ticket('K-2', 'KONF', 'open'), ticket('C-1', 'CP', 'blocked'), ticket('K-1', 'KONF', 'in_progress'), ticket('K-3', 'KONF', 'open')]);
  assert.deepEqual(
    g.map((b) => [b.bucket, b.count, b.statuses.map((s) => [s.status, s.tickets.map((t) => t.id)])]),
    [
      ['CP', 1, [['blocked', ['C-1']]]],
      ['KONF', 3, [['in_progress', ['K-1']], ['open', ['K-2', 'K-3']]]],
    ],
  );
});

const status = (o: Partial<VscodeStatus> = {}): VscodeStatus => ({
  quota: { claudeId: 'c1', claudeName: 'Main', label: 'Week', usedPct: 61.4, resetsAt: null },
  claudes: [
    { claudeId: 'c1', claudeName: 'Main', windows: [{ label: 'Week', usedPct: 61.4, resetsAt: null }] },
    { claudeId: 'c2', claudeName: 'Spare', windows: [{ label: 'Session', usedPct: null, resetsAt: null }] },
  ],
  attention: 3,
  approvals: 1,
  at: '',
  ...o,
});

test('the status bar: quota and what needs you; a missing number is unavailable, never 0 %', () => {
  const v = statusView(status());
  assert.equal(v.text, '$(dashboard) 61%  $(bell-dot) 3');
  assert.match(v.tooltip, /Main: Week 61%/);
  assert.match(v.tooltip, /Spare: Session —/);
  assert.equal(v.warn, true);
  const none = statusView(status({ quota: { claudeId: 'c1', claudeName: 'Main', label: 'Week', usedPct: null, resetsAt: null }, attention: 0, approvals: 0 }));
  assert.equal(none.text, '$(dashboard) —');
  assert.match(none.tooltip, /Week unavailable/);
  assert.equal(none.warn, false);
  assert.match(statusView(status({ attention: null, approvals: 2 })).tooltip, /Needs you: unavailable \(2 approvals\)/);
  assert.equal(statusView(null, { signedIn: false }).text, '$(account) ClaudePilot');
});

const approval = (o: Partial<VscodeApproval> = {}): VscodeApproval => ({
  sessionId: 's1',
  sessionTitle: 'Fix\nthe build',
  workspaceId: 'local/ws1',
  requestId: 'r1',
  kind: 'tool',
  toolName: 'Bash',
  title: 'Run a command',
  full: 'rm -rf build &&\n  npm run build',
  fullCut: false,
  allowable: true,
  note: null,
  fullSha256: 'x',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...o,
  url: '/admin/sessions/s1',
});

test('an approval: one line for the notification, the WHOLE text exactly in the review document', () => {
  assert.equal(approvalHeadline(approval()), 'Fix the build: Run a command (Bash)');
  const doc = approvalDocument(approval());
  assert.ok(doc.endsWith('----- request -----\nrm -rf build &&\n  npm run build\n'), 'the text as it will run, nothing folded');
  assert.match(approvalDocument(approval({ allowable: false, note: 'Too long to show in full.' })), /Too long to show in full\. It can only be denied\./);
  assert.equal(oneLine('a\u0000b\u2028c\n\nd', 10), 'a b c d');
  assert.equal(oneLine('x'.repeat(20), 5), 'xxxx…');
});

test('the chat page: a strict CSP with a fresh nonce, no inline script, no data in the HTML', () => {
  const n1 = nonce();
  assert.notEqual(n1, nonce());
  assert.match(n1, /^[A-Za-z0-9+/]{22}==$/);
  const html = chatHtml({ cspSource: 'vscode-resource:', nonce: n1, script: 'vscode-resource:/chat.js', style: 'vscode-resource:/chat.css' });
  const csp = /content="([^"]+)"/.exec(html)![1]!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, new RegExp(`script-src 'nonce-${n1.replace(/[+/]/g, (c) => `\\${c}`)}'`));
  assert.match(csp, /connect-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
  const scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/g) ?? [];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0]!, new RegExp(`^<script nonce="${n1.replace(/[+/]/g, (c) => `\\${c}`)}" src="vscode-resource:/chat.js"></script>$`), 'one script, by nonce, from a file');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline handlers');
});
