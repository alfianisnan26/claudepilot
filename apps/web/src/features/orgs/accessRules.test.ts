// Fine-grained access (docs/prd/access.md): what the Access screens offer to whom. The server decides; these keep a choice off the screen
// when the server would refuse it (tabs by role, the level ceiling, manage never to everyone, the granter's own end) and word the answers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccessReason, AccessRequest, OrgShare } from '@portal/contracts';
import {
  accessTabs,
  askableLevels,
  endText,
  exposesCredentials,
  levelChoices,
  maxDate,
  reasonText,
  sortRequests,
  subjectText,
  topLevel,
  untilChoices,
  untilValue,
  waitingCount,
} from './accessRules';
import { orgSections } from './rules';

const NOW = Date.parse('2030-01-01T12:00:00.000Z');
const DAY = 86_400_000;

test('tabs by role: owners and admins see objects, people, requests; members their own; guests nothing (and no Access section)', () => {
  assert.deepEqual(accessTabs('owner'), ['objects', 'people', 'requests']);
  assert.deepEqual(accessTabs('admin'), ['objects', 'people', 'requests']);
  assert.deepEqual(accessTabs('member'), ['objects', 'mine', 'requests']);
  assert.deepEqual(accessTabs('guest'), []);
  assert.ok(!orgSections({ myRole: 'guest', state: 'active' }).includes('access'));
  assert.ok(orgSections({ myRole: 'member', state: 'active' }).includes('access'));
  assert.ok(!orgSections({ myRole: 'owner', state: 'suspended' }).includes('access'), 'a suspended org shows no Access');
});

test('level cards: nothing above the granter’s own; manage never to everyone', () => {
  const all = levelChoices(['view', 'operate', 'manage'], 'team');
  assert.deepEqual(all.map((c) => c.allowed), [true, true, true]);
  assert.deepEqual(levelChoices(['view', 'operate', 'manage'], 'org').map((c) => c.allowed), [true, true, false]);
  assert.deepEqual(levelChoices(['view'], 'user').map((c) => [c.level, c.allowed]), [['view', true], ['operate', false], ['manage', false]]);
  assert.deepEqual(levelChoices([], 'user').filter((c) => c.allowed), [], 'may not grant: no card');
  assert.deepEqual(askableLevels('view'), ['operate', 'manage']);
  assert.deepEqual(askableLevels('manage'), []);
});

test('the credentials warning: operate or manage on a workspace with sets, never view, never another type', () => {
  assert.equal(exposesCredentials('workspace', 'operate', 2), true);
  assert.equal(exposesCredentials('workspace', 'manage', 1), true);
  assert.equal(exposesCredentials('workspace', 'view', 2), false);
  assert.equal(exposesCredentials('workspace', 'operate', 0), false);
  assert.equal(exposesCredentials('vault', 'operate', 2), false);
});

test('until: no end only without a ceiling; presets past the granter’s end are left out; a date ends that local day and never past it', () => {
  assert.deepEqual(untilChoices(null, NOW).map((c) => c.allowed), [true, true, true, true]);
  const tenDays = new Date(NOW + 10 * DAY).toISOString();
  assert.deepEqual(untilChoices(tenDays, NOW).map((c) => [c.key, c.allowed]), [['none', false], ['7d', true], ['30d', false], ['date', true]]);
  assert.equal(untilValue('none', '', NOW), null);
  assert.equal(untilValue('none', '', NOW, tenDays), 'invalid');
  assert.equal(untilValue('7d', '', NOW), new Date(NOW + 7 * DAY).toISOString());
  assert.equal(untilValue('30d', '', NOW, tenDays), 'invalid');
  const picked = untilValue('date', '2030-01-05', NOW);
  assert.equal(typeof picked, 'string');
  const d = new Date(picked as string);
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2030, 0, 5, 23, 59], 'the end of that local day');
  assert.equal(untilValue('date', '2029-12-01', NOW), 'invalid', 'in the past');
  assert.equal(untilValue('date', '2031-06-01', NOW), 'invalid', 'more than a year out');
  assert.equal(untilValue('date', '2030-02-01', NOW, tenDays), 'invalid', 'past the granter’s end');
  assert.equal(untilValue('date', 'soon', NOW), 'invalid');
  assert.equal(maxDate(tenDays, NOW) <= maxDate(null, NOW), true);
});

test('words: ends, reasons, subjects; the reasons’ top level; requests waiting first', () => {
  assert.equal(endText(null, NOW), null);
  assert.equal(endText(new Date(NOW - 1).toISOString(), NOW), 'ended');
  assert.equal(endText(new Date(NOW + 3_600_000).toISOString(), NOW), 'ends today');
  assert.equal(endText(new Date(NOW + 2.5 * DAY).toISOString(), NOW), 'ends in 3 d');
  const share = (subject: OrgShare['subject']): OrgShare => ({ id: 'osh_x', orgId: 'org_x', target: { type: 'vault', id: 'v' }, subject, level: 'view', personal: false, createdBy: 'u_a', createdAt: '' });
  const reasons: AccessReason[] = [
    { kind: 'owner', level: 'manage' },
    { kind: 'org_role', level: 'manage', role: 'admin' },
    { kind: 'creator', level: 'manage' },
    { kind: 'share', level: 'view', share: share({ kind: 'org' }), revocable: false },
    { kind: 'share', level: 'operate', share: share({ kind: 'team', teamId: 'tm_1', name: 'Ops' }), revocable: true },
    { kind: 'share', level: 'view', share: share({ kind: 'user', userId: 'u_b', name: 'Ben' }), revocable: true },
  ];
  assert.deepEqual(reasons.map(reasonText), ['Owner', 'Admin role', 'Creator', 'Everyone', 'Team Ops', 'Shared to them']);
  assert.equal(topLevel(reasons.slice(3)), 'operate');
  assert.equal(topLevel([]), 'none');
  assert.equal(subjectText({ kind: 'org_managers', id: 'org_x', name: 'x' }), 'Owners and admins');
  assert.equal(subjectText({ kind: 'team', id: 'tm_1', name: 'Ops' }), 'Team Ops');

  const req = (id: string, state: AccessRequest['state'], mayDecide: boolean, createdAt: string): AccessRequest => ({
    id,
    orgId: 'org_x',
    target: { type: 'vault', id: 'v' },
    name: 'V',
    requester: 'u_a',
    requesterName: 'A',
    level: 'view',
    note: null,
    state,
    createdAt,
    decidedBy: null,
    decidedAt: state === 'open' ? null : createdAt,
    decisionNote: null,
    grantedLevel: null,
    expiresAt: null,
    mayDecide,
  });
  const sorted = sortRequests([req('done', 'denied', false, '2030-01-01'), req('mine', 'open', false, '2030-01-01'), req('b', 'open', true, '2030-01-02'), req('a', 'open', true, '2030-01-01')]);
  assert.deepEqual(sorted.map((r) => r.id), ['a', 'b', 'mine', 'done']);
  assert.equal(waitingCount(sorted), 2);
});
