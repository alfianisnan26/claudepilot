// Session shares and teams (owner, 2026-10-17: "lebih granular dan controllable", "team based multiaccount"): what a share allows, to an
// account or a team, until when; an account's own and its teams' shares add up; an end, leaving a team or removing it ends access at
// once; a team keeps an owner; the 402-403 grants carry over as shares.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import { MIGRATIONS } from '../store/migrations.js';
import { normalizeCaps, SessionGrants } from './grants.js';
import { PortalTeams } from './teams.js';
import { memoryDb } from './testkit.js';

const code = (fn: () => unknown): string => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof AppError ? e.code : String(e);
  }
};

test('caps: read always comes along, the order is fixed, an unknown one is refused', () => {
  assert.deepEqual(normalizeCaps(['stop', 'send']), ['read', 'send', 'stop']);
  assert.deepEqual(normalizeCaps([]), ['read']);
  assert.equal(code(() => normalizeCaps(['read', 'bypass'])), 'VALIDATION_FAILED');
  assert.equal(code(() => normalizeCaps('read')), 'VALIDATION_FAILED');
});

test('an account’s own share and its teams’ shares add up; the soonest end shows; Bypass is accepted only when every acting share accepted it', () => {
  const db = memoryDb();
  let now = new Date('2030-01-01T00:00:00Z');
  const g = new SessionGrants(() => db, () => db, () => now);
  g.share('s1', { kind: 'user', id: 'u_a' }, { caps: ['read'] }, 'ui');
  g.share('s1', { kind: 'team', id: 'tm_x' }, { caps: ['send'], expiresAt: '2030-01-02T00:00:00Z', bypassAck: true }, 'ui');
  g.share('s2', { kind: 'team', id: 'tm_y' }, { caps: ['respond'] }, 'ui');
  const held = g.sessionsFor('u_a', ['tm_x'], (id) => `team ${id}`);
  assert.deepEqual([...held.keys()], ['s1'], 'not s2: not in tm_y');
  assert.deepEqual(held.get('s1'), { caps: ['read', 'send'], bypassAck: true, expiresAt: '2030-01-02T00:00:00.000Z', via: ['you', 'team tm_x'] });
  // A second acting share without the acceptance: Bypass is no longer accepted.
  g.share('s1', { kind: 'user', id: 'u_a' }, { caps: ['stop'] }, 'ui');
  assert.equal(g.held('s1', 'u_a', ['tm_x'])?.bypassAck, false);
  // Leaving the team (not passing it) ends what it gave at once.
  assert.deepEqual(g.held('s1', 'u_a', [])?.caps, ['read', 'stop']);
  // The end passes: the team's share stops counting; the list still shows it, marked expired.
  now = new Date('2030-01-03T00:00:00Z');
  assert.deepEqual(g.held('s1', 'u_a', ['tm_x'])?.caps, ['read', 'stop']);
  assert.equal(g.forSession('s1').find((x) => x.subject.kind === 'team')?.expired, true);
  assert.equal(g.held('s1', 'u_b', ['tm_x']), null, 'an expired team share gives nothing');
});

test('an end is in the future and at most a year away; replacing a share keeps one row per subject; revoke by id', () => {
  const db = memoryDb();
  const now = new Date('2030-01-01T00:00:00Z');
  const g = new SessionGrants(() => db, () => db, () => now);
  assert.equal(code(() => g.share('s', { kind: 'user', id: 'u' }, { caps: ['read'], expiresAt: '2029-12-31T00:00:00Z' }, 'ui')), 'VALIDATION_FAILED');
  assert.equal(code(() => g.share('s', { kind: 'user', id: 'u' }, { caps: ['read'], expiresAt: '2031-06-01T00:00:00Z' }, 'ui')), 'VALIDATION_FAILED');
  assert.equal(code(() => g.share('s', { kind: 'user', id: 'u' }, { caps: ['read'], expiresAt: 'soon' }, 'ui')), 'VALIDATION_FAILED');
  assert.deepEqual(g.forSession('s'), [], 'nothing written by a refused share');
  g.share('s', { kind: 'user', id: 'u' }, { caps: ['read'] }, 'ui');
  const second = g.share('s', { kind: 'user', id: 'u' }, { caps: ['read', 'send'], note: 'night shift\u0007' }, 'account:u_admin');
  assert.equal(g.forSession('s').length, 1);
  assert.deepEqual([second.caps, second.note, second.grantedBy], [['read', 'send'], 'night shift', 'account:u_admin']);
  assert.equal(g.revokeId(second.id)?.session_id, 's');
  assert.equal(g.held('s', 'u', []), null);
  // A read-only share never carries a Bypass acceptance.
  assert.equal(g.share('s', { kind: 'user', id: 'u' }, { caps: ['read'], bypassAck: true }, 'ui').bypassAck, false);
});

test('teams: unique names, members and roles, the last owner stays, removing a team removes its people', () => {
  const db = memoryDb();
  const now = new Date().toISOString();
  for (const [id, email] of [['u_a', 'a@example.com'], ['u_b', 'b@example.com']] as const)
    db.prepare("INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, 'x', 'member', 'active', 'h', ?, ?, 'ui')").run(id, email, email, now, now);
  const t = new PortalTeams(() => db);
  const team = t.create({ name: '  Konfersi\u0000 QA ', description: 'testers' }, ['u_a'], 'ui');
  assert.equal(team.name, 'Konfersi QA');
  assert.equal(code(() => t.create({ name: 'konfersi qa' }, [], 'ui')), 'CONFLICT');
  assert.equal(code(() => t.create({ name: 'x'.repeat(41) }, [], 'ui')), 'VALIDATION_FAILED');
  t.setMember(team.id, 'u_b', 'member', 'account:u_a');
  assert.deepEqual(t.members(team.id).map((m) => [m.email, m.role]), [['a@example.com', 'owner'], ['b@example.com', 'member']], 'owners first');
  assert.deepEqual(t.idsOf('u_b'), [team.id]);
  assert.equal(t.mine('u_b')[0]?.myRole, 'member');
  assert.equal(code(() => t.removeMember(team.id, 'u_a')), 'CONFLICT', 'the last owner stays');
  assert.equal(code(() => t.setMember(team.id, 'u_a', 'member', 'ui')), 'CONFLICT', 'nor is demoted');
  t.setMember(team.id, 'u_b', 'owner', 'ui');
  t.setMember(team.id, 'u_a', 'member', 'ui');
  assert.equal(t.removeMember(team.id, 'u_a'), true);
  t.remove(team.id);
  assert.deepEqual(t.idsOf('u_b'), []);
  assert.equal((db.prepare('SELECT count(*) AS n FROM team_members').get() as { n: number }).n, 0);
});

test('migration 405: the view and operate grants of 402-403 become shares (view = read, operate = all four, the Bypass acceptance kept)', () => {
  const db = new DatabaseSync(':memory:');
  const sorted = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  for (const m of sorted.filter((m) => m.version <= 403)) m.up(db);
  db.prepare("INSERT INTO session_grants (session_id, user_id, level, granted_by, created_at, bypass_ack) VALUES ('s1', 'u_v', 'view', 'ui', '2026-10-17T00:00:00Z', 0)").run();
  db.prepare("INSERT INTO session_grants (session_id, user_id, level, granted_by, created_at, bypass_ack) VALUES ('s1', 'u_o', 'operate', 'account:u_x', '2026-10-17T00:00:00Z', 1)").run();
  for (const m of sorted.filter((m) => m.version > 403)) m.up(db);
  const g = new SessionGrants(() => db);
  const rows = g.forSession('s1').map((x) => [x.subject.id, x.caps.join(','), x.bypassAck, x.grantedBy]);
  assert.deepEqual(rows.sort(), [
    ['u_o', 'read,send,respond,stop', true, 'account:u_x'],
    ['u_v', 'read', false, 'ui'],
  ]);
  assert.ok(g.forSession('s1').every((x) => /^sh_[0-9a-f]{18}$/.test(x.id)));
});

test('review: an ended share is not brought back by changing something else; a new end (or none) is said again', () => {
  const db = memoryDb();
  let now = new Date('2030-01-01T00:00:00Z');
  const g = new SessionGrants(() => db, () => db, () => now);
  const s = g.share('s', { kind: 'user', id: 'u' }, { caps: ['read'], expiresAt: '2030-01-02T00:00:00Z' }, 'ui');
  now = new Date('2030-01-05T00:00:00Z');
  assert.equal(code(() => g.update(s.id, { caps: ['read', 'send'] }, 'ui')), 'VALIDATION_FAILED');
  assert.equal(g.held('s', 'u', []), null, 'still ended');
  assert.deepEqual(g.update(s.id, { caps: ['read', 'send'], expiresAt: '2030-01-10T00:00:00Z' }, 'ui').caps, ['read', 'send']);
});
