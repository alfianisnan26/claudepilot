// Org settings (owner request 2026-11-01): which sections and actions each role sees. The server decides every right; these keep a control
// off the screen when the server would refuse it (owner, admin, member, guest; active and suspended).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORGS_ERROR_CODES, type OrgRole } from '@portal/contracts';
import {
  AUDIT_FILTERS,
  auditActorText,
  auditKindText,
  canCreateTeam,
  canListInvitations,
  canManageTeam,
  canMoveHere,
  canRevokeShare,
  canSeeOwnerAudit,
  confirmsDelete,
  consentCredentials,
  orgErrorText,
  orgSections,
  objectRows,
  SECTION_LABEL,
  targetName,
} from './rules';

const ROLES: OrgRole[] = ['owner', 'admin', 'member', 'guest'];
const active = (myRole: OrgRole, may?: { invite: boolean; createTeam: boolean }) => ({ myRole, state: 'active' as const, may });

test('sections by role in an active org: owners everything; admins no Policies or Danger zone; members and guests less', () => {
  assert.deepEqual(orgSections(active('owner')), ['general', 'members', 'teams', 'invitations', 'objects', 'sharing', 'sign-in', 'policies', 'audit', 'danger']);
  assert.deepEqual(orgSections(active('admin')), ['general', 'members', 'teams', 'invitations', 'objects', 'sharing', 'sign-in', 'audit']);
  assert.deepEqual(orgSections(active('member', { invite: false, createTeam: true })), ['general', 'members', 'teams', 'objects', 'sharing']);
  assert.deepEqual(orgSections(active('guest', { invite: false, createTeam: false })), ['general', 'teams', 'objects']);
});

test('a member allowed to invite (membersMayInvite) gets Invitations, the form only', () => {
  assert.ok(orgSections(active('member', { invite: true, createTeam: true })).includes('invitations'));
  assert.equal(canListInvitations('member'), false, 'the list and revoke stay the managers’');
  assert.deepEqual(ROLES.map(canListInvitations), [true, true, false, false]);
});

test('a suspended org: its owners see General and Danger zone (resume, delete); nobody else sees more than General', () => {
  assert.deepEqual(orgSections({ myRole: 'owner', state: 'suspended' }), ['general', 'danger']);
  for (const r of ['admin', 'member', 'guest'] as const) assert.deepEqual(orgSections({ myRole: r, state: 'suspended' }), ['general'], r);
});

test('owner-only sections are never shown to anyone else', () => {
  for (const r of ['admin', 'member', 'guest'] as const) {
    const s = orgSections(active(r, { invite: true, createTeam: true }));
    assert.ok(!s.includes('policies') && !s.includes('danger'), r);
  }
  assert.deepEqual(ROLES.map(canSeeOwnerAudit), [true, false, false, false], 'transcript views and break-glass');
  for (const r of ['member', 'guest'] as const) {
    const s = orgSections(active(r, { invite: true, createTeam: true }));
    assert.ok(!s.includes('audit') && !s.includes('sign-in'), r);
  }
});

test('every section has a one- or two-word title', () => {
  for (const [k, v] of Object.entries(SECTION_LABEL)) assert.ok(v.split(' ').length <= 2, k);
});

test('teams: create follows Org.may (the policy), else managers; manage a team: org owners and admins, or the team’s owner', () => {
  assert.equal(canCreateTeam({ myRole: 'member', may: { invite: false, createTeam: true } }), true);
  assert.equal(canCreateTeam({ myRole: 'member', may: { invite: false, createTeam: false } }), false);
  assert.equal(canCreateTeam({ myRole: 'admin' }), true, 'an older server without `may`');
  assert.equal(canCreateTeam({ myRole: 'member' }), false);
  assert.deepEqual(ROLES.map((r) => canManageTeam(r, undefined)), [true, true, false, false]);
  assert.deepEqual(ROLES.map((r) => canManageTeam(r, 'member')), [true, true, false, false]);
  assert.deepEqual(ROLES.map((r) => canManageTeam(r, 'owner')), [true, true, true, true], 'a team owner manages their team');
});

test('shares: org owners and admins revoke any; anyone else only what they shared', () => {
  const share = { createdBy: 'u_me' };
  assert.equal(canRevokeShare('owner', share, 'u_other'), true);
  assert.equal(canRevokeShare('admin', share, 'u_other'), true);
  assert.equal(canRevokeShare('member', share, 'u_me'), true);
  assert.equal(canRevokeShare('member', share, 'u_other'), false);
  assert.equal(canRevokeShare('member', share, null), false, 'not known yet: hidden');
});

test('Move here: members and up (the server also needs manage on the object)', () => {
  assert.deepEqual(ROLES.map(canMoveHere), [true, true, true, false]);
});

test('delete asks for the slug, exactly', () => {
  assert.equal(confirmsDelete('acme', 'acme'), true);
  assert.equal(confirmsDelete('  acme ', 'acme'), true);
  assert.equal(confirmsDelete('Acme', 'acme'), false);
  assert.equal(confirmsDelete('', 'acme'), false);
});

test('the consent step reads the credential sets off a CREDENTIALS_CONSENT_REQUIRED refusal only', () => {
  const creds = [{ poolId: 'p1', name: 'Prod' }, { poolId: 2, name: 'bad' }];
  assert.deepEqual(consentCredentials({ details: { reason: ORGS_ERROR_CODES.CREDENTIALS_CONSENT_REQUIRED, credentials: creds } }), [{ poolId: 'p1', name: 'Prod' }]);
  assert.equal(consentCredentials({ details: { reason: ORGS_ERROR_CODES.ORG_ALREADY_OWNER } }), null);
  assert.equal(consentCredentials(new Error('x')), null);
  assert.equal(consentCredentials(null), null);
});

test('audit: filters are kind prefixes the server accepts; kinds and actors read as words', () => {
  for (const f of AUDIT_FILTERS) assert.ok(f.kind === '' || /^[a-z][a-z0-9_.]{0,59}$/.test(f.kind), f.kind);
  assert.equal(auditKindText('org.member_role_changed'), 'Member role changed');
  assert.equal(auditKindText('object.transferred'), 'Object transferred');
  const names = new Map([['u_A', 'Alice']]);
  assert.equal(auditActorText({ actor: 'user:u_A' }, names), 'Alice');
  assert.equal(auditActorText({ actor: 'user:u_B' }, names), 'u_B');
  assert.equal(auditActorText({ actor: 'system:orgs-purge' }, names), 'system:orgs-purge');
});

test('objects as rows: workspaces, buckets, vaults, each by name, with where they open; a share names its object or shows its id', () => {
  const rows = objectRows({
    workspaces: [
      { id: 'docker/zeta', name: 'zeta' },
      { id: 'docker/a', name: 'a', label: 'Alpha' },
    ],
    buckets: [{ key: 'KONF', name: 'Konfersi' }],
    vaults: [{ id: 'v 1', name: 'Notes' }],
  });
  assert.deepEqual(
    rows.map((r) => [r.kind, r.name, r.href]),
    [
      ['workspace', 'Alpha', '/admin/workspaces'],
      ['workspace', 'zeta', '/admin/workspaces'],
      ['ticket_bucket', 'Konfersi', '/admin/tickets?bucket=KONF'],
      ['vault', 'Notes', '/admin/knowledge/v%201'],
    ],
  );
  assert.equal(targetName({ type: 'ticket_bucket', id: 'KONF' }, rows), 'Konfersi');
  assert.equal(targetName({ type: 'vault', id: 'KONF' }, rows), 'KONF', 'the kind must match too');
});

test('the new refusals read as words', () => {
  const err = (reason: string) => Object.assign(new Error('raw'), { details: { reason } });
  assert.match(orgErrorText(err(ORGS_ERROR_CODES.ORG_OWNS_OBJECTS), 'x'), /Move them out first/);
  assert.match(orgErrorText(err(ORGS_ERROR_CODES.ORG_SUSPENDED_BY_PLATFORM), 'x'), /portal’s admin/);
  assert.match(orgErrorText(err(ORGS_ERROR_CODES.TEAM_NOT_ORG_MEMBER), 'x'), /Only members/);
});
