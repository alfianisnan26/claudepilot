import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatSession, TicketItem, Workspace } from '@portal/contracts';
import { actionItems, pageItems, sessionItems, ticketItems, workspaceItems } from './items.js';

const session = (over: Partial<ChatSession> & { id: string }): ChatSession =>
  ({ workspaceId: 'docker/api-dev', title: 'Fix tests', state: 'working', claudeName: 'Satria', worktree: null, ticketId: null, archivedAt: null, lastActivityAt: '2026-10-12T11:00:00.000Z', ...over }) as ChatSession;

test('sessions: archived ones are left out, an ended one stays; each row says how it stands and where it runs, and opens its page', () => {
  const items = sessionItems([
    session({ id: 'a', title: 'Fix tests' }),
    session({ id: 'b', title: 'Old', state: 'ended' }),
    session({ id: 'c', title: 'Hidden', archivedAt: '2026-10-01T00:00:00Z' }),
    session({ id: 'd', title: '', state: 'waiting' }),
  ]);
  assert.deepEqual(items.map((i) => [i.id, i.title, i.hint, i.to, i.state]), [
    ['session:a', 'Fix tests', 'Working · api-dev', '/admin/sessions/a', 'working'],
    ['session:b', 'Old', 'Ended · api-dev', '/admin/sessions/b', 'ended'],
    ['session:d', 'Untitled', 'Needs you · api-dev', '/admin/sessions/d', 'waiting'],
  ]);
  assert.equal(items[0]!.recent, Date.parse('2026-10-12T11:00:00.000Z'));
});

test('sessions are findable by the Claude, the branch and the ticket, as the Sessions page\'s own search does', () => {
  const [i] = sessionItems([session({ id: 'x', worktree: { path: '/w', branch: 'ticket/T-4-login', repo: '/r' }, ticketId: 'T-4' })]);
  assert.match(i!.keywords!, /Satria/);
  assert.match(i!.keywords!, /ticket\/T-4-login/);
  assert.match(i!.keywords!, /T-4/);
  assert.match(i!.keywords!, /docker\/api-dev/);
});

const ws = (over: Partial<Workspace>): Workspace => ({ id: 'docker/api-dev', name: 'api-dev', target: 'docker', image: '', status: 'running', createdAt: '', ...over });

test('a workspace opens its shell while it runs, else the Workspaces page, and the row says which', () => {
  assert.deepEqual(workspaceItems([ws({})]).map((i) => [i.title, i.hint, i.to]), [['api-dev', 'Shell', '/admin/workspaces/docker/api-dev/shell']]);
  assert.deepEqual(workspaceItems([ws({ status: 'stopped' })]).map((i) => [i.hint, i.to]), [['stopped', '/admin/workspaces']]);
  assert.deepEqual(workspaceItems([ws({ status: 'error' })]).map((i) => i.hint), ['error']);
});

test('tickets the portal found are matched already and open their page', () => {
  const t = { id: 'T-12', summary: 'Ship it', status: 'in_progress', tags: ['release', 'web'] } as TicketItem;
  assert.deepEqual(ticketItems([t]), [{ id: 'ticket:T-12', kind: 'ticket', title: 'Ship it', hint: 'T-12 · In progress', to: '/admin/tickets/T-12', keywords: 'T-12 release web', matched: true }]);
  // T-1098: a ticket with a bucket key shows and links the key; both ids match.
  assert.deepEqual(ticketItems([{ ...t, key: 'KONF-3' }])[0], { id: 'ticket:T-12', kind: 'ticket', title: 'Ship it', hint: 'KONF-3 · In progress', to: '/admin/tickets/KONF-3', keywords: 'T-12 KONF-3 release web', matched: true });
});

test('pages come from the sidebar\'s own list', () => {
  assert.deepEqual(pageItems([{ id: 'usage', to: '/admin/usage', label: 'Usage' }]), [{ id: 'page:usage', kind: 'page', title: 'Usage', hint: '', to: '/admin/usage' }]);
});

test('actions: a new session, and the widgets\' full forms opened on the page you are on, keeping the rest of its address', () => {
  const items = actionItems({ pathname: '/admin/usage', search: '?tab=claudes' });
  assert.deepEqual(items.map((i) => [i.id, i.to]), [
    ['action:new-session', '/admin/sessions?new=1'],
    ['action:attention', '/admin/usage?tab=claudes&glance=attention'],
    ['action:quota', '/admin/usage?tab=claudes&glance=quota'],
    ['action:agents', '/admin/usage?tab=claudes&glance=agents'],
  ]);
  assert.equal(actionItems({ pathname: '/admin/sessions', search: '' })[1]!.to, '/admin/sessions?glance=attention');
  assert.equal(actionItems({ pathname: '/admin/sessions', search: '?glance=quota' })[1]!.to, '/admin/sessions?glance=attention', 'an old glance parameter is replaced, not doubled');
});
