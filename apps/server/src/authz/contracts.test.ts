// The multi-user contracts (packages/contracts/src/{authz,identity,sharing,teams}.ts): the pure rules the server and the forms share, and the
// consistency of the tables that the authorization layer will be built from. A change that breaks one of these breaks a PRD claim.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDIT_ACTIONS,
  LEVEL_RANK,
  LOGIN_LIMITS,
  OBJECT_TYPES,
  OBJECT_TYPE_IDS,
  PASSWORD,
  PLATFORM_AREAS,
  RESERVED_USERNAMES,
  USER_ID_PATTERN,
  VERBS,
  isCredential,
  isObjectType,
  isUserId,
  levelAtLeast,
  levelFor,
  maxLevel,
  minLevel,
  normalizeUsername,
  objectRef,
  passwordProblems,
  statusForDeny,
  usernameProblem,
  type DenyReason,
} from '@portal/contracts';
import { PlatformAudit } from '../platform/audit.js';

test('levels are ordered and inclusive', () => {
  assert.deepEqual(VERBS, ['view', 'operate', 'manage']);
  assert.ok(LEVEL_RANK.none < LEVEL_RANK.view && LEVEL_RANK.view < LEVEL_RANK.operate && LEVEL_RANK.operate < LEVEL_RANK.manage);
  assert.equal(levelAtLeast('manage', 'view'), true);
  assert.equal(levelAtLeast('view', 'operate'), false);
  assert.equal(levelAtLeast('none', 'view'), false);
  assert.equal(maxLevel('view', 'manage', 'none'), 'manage');
  assert.equal(minLevel('manage', 'operate'), 'operate');
  assert.equal(maxLevel(), 'none');
});

test('user ids: the founding id and random ones are ids, anything else is not', () => {
  for (const id of ['u_owner', 'u_a', 'u_0123456789abcdef01234567']) assert.ok(isUserId(id), id);
  for (const id of ['', 'owner', 'ui', 'U_owner', 'u_', 'u_Owner', 'u_owner; drop', `u_${'a'.repeat(41)}`]) assert.equal(isUserId(id), false, id);
  assert.ok(USER_ID_PATTERN.test('u_owner'));
});

test('every object type is consistent: parents exist, guards are named, only the right ones can be shared', () => {
  for (const type of OBJECT_TYPE_IDS) {
    const info = OBJECT_TYPES[type];
    assert.ok(isObjectType(type));
    assert.ok(info.owners.length > 0, `${type} has an owner kind`);
    if (info.parent) assert.ok(isObjectType(info.parent), `${type}'s parent ${info.parent} is a type`);
    if (info.inherit === 'guard') assert.ok(info.parent && info.guard, `${type} names its parent and the guard`);
    if (info.inherit === 'same') assert.ok(info.parent, `${type} inherits from a parent`);
    if (info.inherit === 'none') assert.equal(info.parent === undefined || info.guard === undefined, true, `${type} has no guard without inheriting`);
    if (info.grants) assert.ok(!info.owners.every((o) => o === 'platform') || type === 'target', `${type}: only a target is platform-owned and shareable`);
  }
  assert.equal(isObjectType('constructor'), false);
  assert.equal(isObjectType('toString'), false);
  // The ones the PRDs promise: a session is private (own rights, guarded by its workspace), a CI run is its workspace's.
  assert.deepEqual([OBJECT_TYPES.session.inherit, OBJECT_TYPES.session.parent, OBJECT_TYPES.session.guard], ['guard', 'workspace', 'operate']);
  assert.equal(OBJECT_TYPES.ci_run.inherit, 'same');
  assert.equal(OBJECT_TYPES.personal.grants, false);
  assert.equal(OBJECT_TYPES.workspace.grants, true);
  assert.ok(new Set(PLATFORM_AREAS).size === PLATFORM_AREAS.length);
  assert.deepEqual(objectRef('pool', 'p1', 'secrets'), { type: 'pool', id: 'p1', poolType: 'secrets' });
});

test('a refusal reaches the wire as 401, 404 or 403 and never says more', () => {
  const reasons: Record<DenyReason, 401 | 403 | 404> = {
    unauthenticated: 401,
    actor_disabled: 401,
    owner_disabled: 401,
    not_found: 404,
    unowned: 404,
    private: 404,
    no_right: 403,
    scope: 403,
    agent_box: 403,
    platform_only: 403,
    guard: 403,
    reauth: 403,
  };
  for (const [reason, status] of Object.entries(reasons) as [DenyReason, number][]) assert.equal(statusForDeny(reason), status, reason);
});

test('usernames: a plain ASCII name, case-folded, never reserved and never an id', () => {
  assert.equal(normalizeUsername('  Alice '), 'alice');
  for (const ok of ['alice', 'b.chen', 'dev-2', 'x_y_z']) assert.equal(usernameProblem(ok), null, ok);
  for (const bad of ['', 'ab', 'Al ice', 'ünï', '1abc', '-abc', 'a'.repeat(33), 'u_owner', 'u_abc', 'a/b', 'a@b']) assert.equal(usernameProblem(bad), 'format', bad);
  for (const name of RESERVED_USERNAMES) if (/^[a-z][a-z0-9._-]{2,31}$/.test(name) && !name.startsWith('u_')) assert.equal(usernameProblem(name), 'reserved', name);
  assert.equal(usernameProblem('ＡＤＭＩＮ'), 'reserved', 'full-width letters fold to admin (NFKC) and are refused');
});

test('passwords: length is the rule, the structural checks name what is wrong, the minimum is 15', () => {
  assert.equal(PASSWORD.min, 15);
  assert.deepEqual(passwordProblems('correct horse battery'), []);
  assert.deepEqual(passwordProblems('short'), ['too_short']);
  assert.ok(passwordProblems('a'.repeat(129)).includes('too_long'));
  assert.ok(passwordProblems('x'.repeat(15)).includes('repeated'));
  assert.ok(passwordProblems('1234567890123456').includes('sequence'));
  assert.ok(passwordProblems('my name is alice ok', { username: 'alice' }).includes('same_as_username'));
  assert.ok(passwordProblems('alice jones is here', { displayName: 'Alice Jones' }).includes('same_as_name'));
  // Spaces and Unicode are fine, and a passphrase is not penalised for having none of the usual symbols.
  assert.deepEqual(passwordProblems('le café du matin est bon'), []);
  // 15 characters, counted as characters (an emoji is one), not bytes.
  assert.deepEqual(passwordProblems('ab cd ef gh ij k😀'), []);
});

test('login limits: the lock doubles from 30 seconds to a 15 minute ceiling', () => {
  const { failures, baseLockMs, maxLockMs } = LOGIN_LIMITS.perUser;
  const lock = (n: number) => Math.min(baseLockMs * 2 ** (n - failures), maxLockMs);
  assert.deepEqual([5, 6, 7, 8, 9, 10, 11].map(lock).map((ms) => ms / 1000), [30, 60, 120, 240, 480, 900, 900]);
});

test('a share carries what it should: sets are seen, work is worked on, credentials are used', () => {
  assert.equal(levelFor('workspace', 'operate'), 'operate');
  assert.equal(levelFor('pool', 'manage'), 'view');
  assert.equal(levelFor('claude', 'view'), 'operate');
  assert.equal(levelFor('account_pool', 'operate'), 'operate');
  assert.equal(levelFor('ticket', 'manage'), 'operate');
  assert.equal(levelFor('ticket', 'view'), 'view');
  assert.equal(levelFor('vault', 'operate'), 'operate');
  assert.equal(isCredential(objectRef('pool', 'p', 'secrets')), true);
  assert.equal(isCredential(objectRef('pool', 'p', 'mcpset')), false);
  assert.equal(isCredential(objectRef('claude', 'c')), true);
  assert.equal(isCredential(objectRef('account_pool', 'a')), true);
  assert.equal(isCredential(objectRef('ticket', 'T-1')), false);
});

test('every audit action is one the platform audit accepts', () => {
  // PlatformAudit.record throws for a kind that does not look like module.action (platform/audit.ts KIND): the identity, sharing and teams rows use the same writer.
  const KIND = /^[a-z][a-z0-9_]{0,30}(?:\.[a-z][a-z0-9_]{0,30}){0,3}$/;
  for (const action of AUDIT_ACTIONS) assert.ok(KIND.test(action), action);
  assert.equal(new Set(AUDIT_ACTIONS).size, AUDIT_ACTIONS.length, 'no action is listed twice');
  assert.equal(typeof PlatformAudit, 'function');
});
