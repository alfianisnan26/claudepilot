// FR9c (D-62, T-483): an agent's token (a chat session or a crew worker) may not put a ticket on a person unless the ticket carries a tag
// the owner allows (`tickets.agentAssignUserTags`, default `production`). A person, the page, an admin's token and a trigger never are.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TICKET_SETTING_KEYS } from '@portal/contracts';
import { settingDef } from '../settings/registry.js';
import { allowedAssignTags, canAgentAssignUser, D62_ASSIGN_REFUSAL } from './authz.js';
import type { Caller, TicketAudit } from './service.js';
import './settings.js';
import { agent, ticketsHarness, token, UI } from './testkit.js';

const WS = 'kubernetes/kohi-event';
const PERSON = { kind: 'user' as const, name: 'admin' };

function refusal(fn: () => unknown): { code: string; message: string } | null {
  try {
    fn();
    return null;
  } catch (e) {
    return { code: (e as { code: string }).code, message: (e as Error).message };
  }
}

async function rig(agentAssignUserTags?: () => string) {
  const h = await ticketsHarness({ agentAssignUserTags });
  const audits: TicketAudit[] = [];
  h.tickets.onAudit = (e) => void audits.push(e);
  h.sessions.add({ id: 'lead', workspaceId: WS });
  h.sessions.add({ id: 'worker', workspaceId: WS, parentId: 'lead' });
  return { ...h, audits, lead: agent(WS, 'lead'), worker: agent(WS, 'worker') };
}

const assertD62 = (r: { code: string; message: string } | null, why: string) => {
  assert.ok(r, `${why}: refused`);
  assert.equal(r.code, 'FORBIDDEN', `${why}: not a 404, the agent may see the ticket`);
  assert.equal(r.message, D62_ASSIGN_REFUSAL, why);
  assert.match(r.message, /^D-62: agents do not assign tickets to a person\./);
};

test('canAgentAssignUser: only an agent is judged; an allowed tag passes; a move to a person or the last allowed tag removed is refused', () => {
  const base = { callerKind: 'agent' as const, assigneeAfter: 'user' as const, assignsUser: true, tagsBefore: [], tagsAfter: ['git'], allowedTags: ['production'] };
  assert.deepEqual(canAgentAssignUser(base), { allow: false, why: 'no_allowed_tag' });
  assert.deepEqual(canAgentAssignUser({ ...base, tagsAfter: ['git', 'production'] }), { allow: true });
  for (const callerKind of ['ui', 'system', 'token', 'trigger'] as const) assert.deepEqual(canAgentAssignUser({ ...base, callerKind }), { allow: true }, callerKind);
  assert.deepEqual(canAgentAssignUser({ ...base, assigneeAfter: 'session' }), { allow: true });
  assert.deepEqual(canAgentAssignUser({ ...base, assigneeAfter: null }), { allow: true });
  assert.deepEqual(canAgentAssignUser({ ...base, assignsUser: false }), { allow: true }, 'already on a person, left so: not judged again');
  assert.deepEqual(canAgentAssignUser({ ...base, assignsUser: false, tagsBefore: ['production'], tagsAfter: [] }), { allow: false, why: 'no_allowed_tag' }, 'the last allowed tag removed');
  assert.deepEqual(canAgentAssignUser({ ...base, tagsAfter: ['production'], allowedTags: [] }), { allow: false, why: 'no_allowed_tag' }, 'empty setting: never');
});

test('allowedAssignTags: comma or space separated, lowercase; not a string is the default; empty allows nothing', () => {
  assert.deepEqual(allowedAssignTags('production'), ['production']);
  assert.deepEqual(allowedAssignTags(' Production, prod-step  owner-checklist,,'), ['production', 'prod-step', 'owner-checklist']);
  assert.deepEqual(allowedAssignTags(undefined), ['production']);
  assert.deepEqual(allowedAssignTags(42), ['production']);
  assert.deepEqual(allowedAssignTags(''), []);
});

test('the setting: a typed default of production, owner only (protective: moving it off asks to confirm)', () => {
  const def = settingDef(TICKET_SETTING_KEYS.agentAssignUserTags);
  assert.ok(def, 'defined');
  assert.equal(def.type, 'string');
  assert.equal(def.default, 'production');
  assert.equal(def.protective, 'production');
  assert.equal(def.group, 'tickets');
});

test('an agent creating a ticket for a person is refused with the D-62 path and an audit row; nothing is made', async () => {
  const r = await rig();
  try {
    assertD62(refusal(() => r.tickets.create(r.lead, { summary: 'Allow-list change', type: 'approval', assignee: PERSON, tags: ['permissions'] })), 'create, user');
    assertD62(refusal(() => r.tickets.create(r.lead, { summary: 'Named person', assignee: { kind: 'user', name: 'bob' } })), 'create, user:<name>');
    assert.equal(r.tickets.list(UI, {}).total, 0, 'nothing was made');
    assert.equal(r.audits.length, 2);
    const a = r.audits[0]!;
    assert.equal(a.kind, 'ticket.agent_assign_refused');
    assert.equal(a.actor, 'session:lead');
    assert.deepEqual(a.detail, { ticketId: null, action: 'create', sessionId: 'lead', leadId: null, tags: ['permissions'], allowedTags: ['production'], why: 'no_allowed_tag' });
  } finally {
    r.done();
  }
});

test('with the production tag an agent may put a ticket on a person; unassigned and session tickets are untouched by the rule', async () => {
  const r = await rig();
  try {
    const t = r.tickets.create(r.lead, { summary: 'Konfersi production deploy', assignee: PERSON, tags: ['production'] });
    assert.deepEqual(t.assignee, PERSON);
    assert.equal(r.tickets.create(r.lead, { summary: 'queue work' }).assignee, null);
    assert.equal(r.tickets.create(r.lead, { summary: 'mine', assignee: { kind: 'session', sessionId: 'lead' } }).assignee?.kind, 'session');
    assert.equal(r.audits.length, 0);
  } finally {
    r.done();
  }
});

test('an agent moving its ticket to a person is refused (and stays as it was); adding the production tag in the same change passes', async () => {
  const r = await rig();
  try {
    const t = r.tickets.create(r.lead, { summary: 'held', assignee: { kind: 'session', sessionId: 'lead' }, tags: ['gate'] });
    assertD62(refusal(() => r.tickets.update(r.lead, t.id, { assignee: PERSON })), 'update to user');
    assertD62(refusal(() => r.tickets.update(r.lead, t.id, { assignee: PERSON, priority: 'urgent' })), 'update to user with another field');
    const after = r.tickets.get(UI, t.id).ticket;
    assert.deepEqual(after.assignee, { kind: 'session', sessionId: 'lead' }, 'unchanged');
    assert.equal(after.priority, 'normal', 'the whole change is refused');
    assert.equal(r.audits.at(-1)!.subject, `ticket:${t.id}`);
    assert.equal((r.audits.at(-1)!.detail as { action: string }).action, 'update');
    const ok = r.tickets.update(r.lead, t.id, { assignee: PERSON, tags: ['gate', 'production'] });
    assert.deepEqual(ok.assignee, PERSON);
  } finally {
    r.done();
  }
});

test('the production tag removed in the same update is refused; removing it from a ticket a person holds is refused', async () => {
  const r = await rig();
  try {
    const t = r.tickets.create(r.lead, { summary: 'held', assignee: { kind: 'session', sessionId: 'lead' }, tags: ['production'] });
    assertD62(refusal(() => r.tickets.update(r.lead, t.id, { assignee: PERSON, tags: [] })), 'assign and drop the tag together');
    // Its own ticket, on a person with the tag: it may still change it, but not strip the tag that allowed it.
    const p = r.tickets.create(r.lead, { summary: 'for the owner', assignee: PERSON, tags: ['production', 'konfersi'] });
    assertD62(refusal(() => r.tickets.update(r.lead, p.id, { tags: ['konfersi'] })), 'last allowed tag removed');
    assert.deepEqual(r.tickets.get(UI, p.id).ticket.tags.sort(), ['konfersi', 'production']);
    assert.equal(r.tickets.update(r.lead, p.id, { priority: 'high' }).priority, 'high', 'another field is fine');
    assertD62(refusal(() => r.tickets.update(r.lead, p.id, { assignee: { kind: 'user', name: 'bob' }, tags: ['konfersi'] })), 'to another person without the tag');
  } finally {
    r.done();
  }
});

test('a ticket already on a person (the owner moved it there) is not judged again when its agent changes another field', async () => {
  const r = await rig();
  try {
    const t = r.tickets.create(r.lead, { summary: 'agent made it' });
    r.tickets.update(UI, t.id, { assignee: PERSON });
    assert.equal(r.tickets.update(r.lead, t.id, { priority: 'high', tags: ['note'] }).priority, 'high');
    assert.equal(r.audits.length, 0);
  } finally {
    r.done();
  }
});

test('a crew worker’s token is refused too', async () => {
  const r = await rig();
  try {
    assertD62(refusal(() => r.tickets.create(r.worker, { summary: 'needs the owner', assignee: PERSON })), 'worker create');
    const t = r.tickets.create(r.worker, { summary: 'worker’s', assignee: { kind: 'session', sessionId: 'worker' } });
    assertD62(refusal(() => r.tickets.update(r.worker, t.id, { assignee: PERSON })), 'worker update');
    assert.equal((r.audits[0]!.detail as { leadId: string }).leadId, 'lead', 'the audit names its lead');
  } finally {
    r.done();
  }
});

test('the owner, the page, an admin token and a trigger are never refused', async () => {
  const r = await rig();
  try {
    const trigger: Caller = { kind: 'trigger', triggerId: 'tr1', ownerId: 'u_owner', label: 'Nightly' };
    for (const c of [UI, { kind: 'system' } as Caller, token('tk1', 'operate'), token('tk2', 'admin'), trigger]) {
      const t = r.tickets.create(c, { summary: 'for a person', assignee: PERSON, workspaceId: WS });
      assert.deepEqual(t.assignee, PERSON, c.kind);
      const u = r.tickets.create(c, { summary: 'moved later', workspaceId: WS });
      assert.deepEqual(r.tickets.update(c, u.id, { assignee: { kind: 'user', name: 'bob' } }).assignee, { kind: 'user', name: 'bob' }, c.kind);
    }
    // An admin token acting for a session (session_id) is still the token.
    assert.deepEqual(r.tickets.create(token('tk3', 'operate'), { summary: 'for the lead', assignee: PERSON }, { sessionId: 'lead' }).assignee, PERSON);
    assert.equal(r.audits.length, 0);
  } finally {
    r.done();
  }
});

test('the setting decides the tags: another tag, empty (never), unreadable (the default holds)', async () => {
  const custom = await rig(() => 'owner-checklist, prod-step');
  try {
    assert.deepEqual(custom.tickets.create(custom.lead, { summary: 'a', assignee: PERSON, tags: ['prod-step'] }).assignee, PERSON);
    assertD62(refusal(() => custom.tickets.create(custom.lead, { summary: 'b', assignee: PERSON, tags: ['production'] })), 'production not listed');
  } finally {
    custom.done();
  }
  const never = await rig(() => '');
  try {
    assertD62(refusal(() => never.tickets.create(never.lead, { summary: 'c', assignee: PERSON, tags: ['production'] })), 'empty: never');
  } finally {
    never.done();
  }
  const broken = await rig(() => {
    throw new Error('settings store gone');
  });
  try {
    assert.deepEqual(broken.tickets.create(broken.lead, { summary: 'd', assignee: PERSON, tags: ['production'] }).assignee, PERSON);
    assertD62(refusal(() => broken.tickets.create(broken.lead, { summary: 'e', assignee: PERSON })), 'default holds');
  } finally {
    broken.done();
  }
});
