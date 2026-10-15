// FR9d (D-62, T-527): `owner-checklist` puts a ticket on the owner's Needs you without an assignee, so an agent's token may add it only
// together with a tag the owner allows (`tickets.agentAssignUserTags`, default `production`). A person, an admin's token and a trigger are
// never refused; removing the tag is always allowed. Needs you lists an owner-checklist ticket only with an allowed tag or a person's tag.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttentionList } from '@portal/contracts';
import { ownerActor } from '../authz/seam.js';
import { createAttention } from '../attention/index.js';
import { canAgentTagChecklist, D62_CHECKLIST_REFUSAL, OWNER_CHECKLIST_TAG } from './authz.js';
import type { TicketAudit } from './service.js';
import { agent, ticketsHarness, token, UI } from './testkit.js';

const WS = 'kubernetes/kohi-event';
const CL = OWNER_CHECKLIST_TAG;

function refusal(fn: () => unknown): { code: string; message: string } | null {
  try {
    fn();
    return null;
  } catch (e) {
    return { code: (e as { code: string }).code, message: (e as Error).message };
  }
}

const assertD62 = (r: { code: string; message: string } | null, why: string) => {
  assert.ok(r, `${why}: refused`);
  assert.equal(r.code, 'FORBIDDEN', `${why}: not a 404, the agent may see the ticket`);
  assert.equal(r.message, D62_CHECKLIST_REFUSAL, why);
  assert.match(r.message, /^D-62: agents do not put a ticket on the owner checklist/);
  assert.match(r.message, /production/);
};

async function rig(agentAssignUserTags?: () => string) {
  const h = await ticketsHarness({ agentAssignUserTags });
  const audits: TicketAudit[] = [];
  h.tickets.onAudit = (e) => void audits.push(e);
  h.sessions.add({ id: 'lead', workspaceId: WS });
  h.sessions.add({ id: 'worker', workspaceId: WS, parentId: 'lead' });
  const attention = createAttention(h.store, { tickMs: 0, agentAssignUserTags });
  const listed = (): string[] => {
    const l: AttentionList = attention.list(ownerActor());
    return l.items.filter((i) => i.kind === 'ticket_approval').map((i) => i.id);
  };
  const done = () => {
    attention.stop();
    h.done();
  };
  return { ...h, done, audits, listed, lead: agent(WS, 'lead'), worker: agent(WS, 'worker') };
}

test('canAgentTagChecklist: only an agent adding the tag is judged; an allowed tag passes; removal and a tag already there are not judged', () => {
  const base = { callerKind: 'agent' as const, tagsBefore: [] as string[], tagsAfter: [CL], allowedTags: ['production'] };
  assert.deepEqual(canAgentTagChecklist(base), { allow: false, why: 'checklist_without_allowed_tag' });
  assert.deepEqual(canAgentTagChecklist({ ...base, tagsAfter: [CL, 'production'] }), { allow: true });
  for (const callerKind of ['ui', 'system', 'token', 'trigger'] as const) assert.deepEqual(canAgentTagChecklist({ ...base, callerKind }), { allow: true }, callerKind);
  assert.deepEqual(canAgentTagChecklist({ ...base, tagsBefore: [CL], tagsAfter: [CL, 'git'] }), { allow: true }, 'already there: not judged again');
  assert.deepEqual(canAgentTagChecklist({ ...base, tagsBefore: [CL, 'production'], tagsAfter: [] }), { allow: true }, 'removal');
  assert.deepEqual(canAgentTagChecklist({ ...base, tagsAfter: ['git'] }), { allow: true }, 'no checklist tag');
  assert.deepEqual(canAgentTagChecklist({ ...base, tagsAfter: [CL, 'production'], allowedTags: [] }), { allow: false, why: 'checklist_without_allowed_tag' }, 'empty setting: never');
});

test('an agent adding owner-checklist alone is refused with the D-62 path and an audit row, on create and on update; nothing changes and nothing is listed', async () => {
  const r = await rig();
  try {
    assertD62(refusal(() => r.tickets.create(r.lead, { summary: 'Persona read tools for QA', tags: [CL, 'permissions'] })), 'create');
    assert.equal(r.tickets.list(UI, {}).total, 0, 'nothing was made');
    const t = r.tickets.create(r.worker, { summary: 'A permissions question', tags: ['permissions'] });
    assertD62(refusal(() => r.tickets.update(r.worker, t.id, { tags: ['permissions', CL] })), 'update');
    assert.deepEqual(r.tickets.get(UI, t.id).tags, ['permissions'], 'the tags are unchanged');
    assert.deepEqual(r.listed(), [], 'not on Needs you');
    assert.equal(r.audits.length, 2);
    assert.deepEqual(r.audits[0], {
      kind: 'ticket.agent_checklist_refused',
      actor: 'session:lead',
      actorLabel: null,
      userId: r.audits[0]!.userId,
      subject: null,
      detail: { ticketId: null, action: 'create', sessionId: 'lead', leadId: null, tags: [CL, 'permissions'], allowedTags: ['production'], why: 'checklist_without_allowed_tag' },
    });
    assert.equal(r.audits[1]!.subject, `ticket:${t.id}`);
    assert.deepEqual(r.audits[1]!.detail, { ticketId: t.id, action: 'update', sessionId: 'worker', leadId: 'lead', tags: ['permissions', CL], allowedTags: ['production'], why: 'checklist_without_allowed_tag' });
  } finally {
    r.done();
  }
});

test('with production an agent may add owner-checklist and the ticket is listed; the tag the owner allows comes from the setting', async () => {
  const r = await rig();
  try {
    const t = r.tickets.create(r.lead, { summary: 'Konfersi production cutover step', tags: [CL, 'production'] });
    const u = r.tickets.create(r.lead, { summary: 'Another production step' });
    r.tickets.update(r.lead, u.id, { tags: ['production', CL] });
    assert.deepEqual(r.listed(), [t.id, u.id]);
    assert.equal(r.audits.length, 0);
    // The agent removes production later: the agent's own tag no longer counts.
    r.tickets.update(r.lead, u.id, { tags: [CL] });
    assert.deepEqual(r.listed(), [t.id]);
  } finally {
    r.done();
  }
  const custom = await rig(() => 'prod-step');
  try {
    assertD62(refusal(() => custom.tickets.create(custom.lead, { summary: 'x', tags: [CL, 'production'] })), 'production is not allowed when the owner lists only prod-step');
    const t = custom.tickets.create(custom.lead, { summary: 'y', tags: [CL, 'prod-step'] });
    assert.deepEqual(custom.listed(), [t.id]);
  } finally {
    custom.done();
  }
});

test("a person's tag always counts; a person and an admin's token are never refused", async () => {
  const r = await rig();
  try {
    const byPerson = r.tickets.create(UI, { summary: 'The owner checklist', tags: [CL] });
    const agentMade = r.tickets.create(r.lead, { summary: 'An agent question' });
    r.tickets.update(UI, agentMade.id, { tags: [CL] });
    const byToken = r.tickets.create(token('tok', 'operate'), { summary: 'From a script', tags: [CL] });
    assert.deepEqual(byToken.tags, [CL], "an admin's token is not refused");
    assert.deepEqual(r.listed(), [byPerson.id, agentMade.id], "a person's tag counts; an admin token's tag alone does not (it is not a person)");
    // The agent may change a ticket a person tagged, as long as it does not add the tag itself.
    r.tickets.update(r.lead, agentMade.id, { summary: 'An agent question, sharpened', tags: [CL, 'git'] });
    assert.deepEqual(r.listed(), [byPerson.id, agentMade.id], "the person's tag still counts");
    assert.equal(r.audits.length, 0);
  } finally {
    r.done();
  }
});

test('a ticket an agent tagged before the fix, without production, is not listed; nor is one tagged with no event at all', async () => {
  const r = await rig();
  try {
    const db = r.store.db!;
    const old = r.tickets.create(r.lead, { summary: 'T-525 as it was made' });
    const n = Number(old.id.slice(2));
    // What the service wrote before T-527: the tag and a `tags` event by the agent.
    db.prepare('INSERT INTO ticket_tags (ticket_number, tag) VALUES (?, ?)').run(n, CL);
    db.prepare('INSERT INTO ticket_events (ticket_number, at, kind, actor, actor_label, body, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      n,
      new Date().toISOString(),
      'tags',
      'session:lead',
      'lead',
      null,
      JSON.stringify({ from: [], to: [CL] }),
    );
    const bare = r.tickets.create(r.lead, { summary: 'Tagged outside the service' });
    db.prepare('INSERT INTO ticket_tags (ticket_number, tag) VALUES (?, ?)').run(Number(bare.id.slice(2)), CL);
    assert.deepEqual(r.listed(), []);
    // A person adding production makes it count.
    r.tickets.update(UI, old.id, { tags: [CL, 'production'] });
    assert.deepEqual(r.listed(), [old.id]);
  } finally {
    r.done();
  }
});

test('removing owner-checklist is always allowed, for an agent too, and drops the ticket from Needs you', async () => {
  const r = await rig();
  try {
    const t = r.tickets.create(r.lead, { summary: 'A production step', tags: [CL, 'production'] });
    assert.deepEqual(r.listed(), [t.id]);
    const up = r.tickets.update(r.lead, t.id, { tags: [] });
    assert.deepEqual(up.tags, []);
    assert.deepEqual(r.listed(), []);
    // Removing it from a ticket a person tagged is allowed too.
    const p = r.tickets.create(r.lead, { summary: 'Asked of the owner' });
    r.tickets.update(UI, p.id, { tags: [CL] });
    assert.deepEqual(r.tickets.update(r.lead, p.id, { tags: ['git'] }).tags, ['git']);
    assert.equal(r.audits.length, 0);
  } finally {
    r.done();
  }
});
