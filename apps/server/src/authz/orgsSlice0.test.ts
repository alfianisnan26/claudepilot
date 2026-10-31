// Organizations slice 0 (docs/prd/organizations.md §13, P1 and P2) at the seam: an admin account is ITSELF (its own user id) and keeps full
// access through D-82 ("admin accounts keep full access"); a member, a disabled and a removed account hold only their own; a token is its
// minter's, capped by its scope; a socket is the person its cookie names; a request with no actor is anonymous, never the owner.
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { afterEach, test } from 'node:test';
import { FOUNDING_USER_ID, ticketBucketRef, workspaceRef, type Actor } from '@portal/contracts';
import {
  actorOf,
  actorOfPrincipal,
  actorOfSocket,
  anonymous,
  can,
  clearResolvers,
  isPlatformAdmin,
  memberScope,
  ownerActor,
  registerResolver,
  seesEverything,
  useAccountRoles,
  useSocketActor,
  visible,
  type AccountRoleOf,
} from './seam.js';

const ADMIN = 'u_Adm1n-2nd_x'; // an email account's id: base64url (identity/users.ts)
const MEMBER = 'u_Memb3r_0001';
const GONE = 'u_Gone00000001';
const OFF = 'u_D1sabled0001';
const roles: Record<string, ReturnType<AccountRoleOf>> = { [ADMIN]: 'admin', [MEMBER]: 'member', [OFF]: 'disabled' };

let restore: AccountRoleOf | null = null;
const install = () => (restore = useAccountRoles((id) => roles[id] ?? null));
afterEach(() => {
  clearResolvers();
  if (restore) useAccountRoles(restore);
  restore = null;
  useSocketActor(null);
});

const user = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'legacy', via: 'ui' });
const tokenOf = (userId: string | undefined, scope = 'admin') => actorOfPrincipal({ kind: 'user', userId, tokenId: 'ptk_x', scope, workspaceId: null, sessionId: null });

test('a second admin is its own user id and keeps the founding user’s rights (D-82); the founder is unchanged', () => {
  install();
  const ws = workspaceRef('docker/api');
  assert.deepEqual(can(ownerActor(), 'manage', ws), { allow: true, level: 'manage' });
  assert.deepEqual(can(user(ADMIN), 'manage', ws), { allow: true, level: 'manage' });
  assert.equal(isPlatformAdmin(FOUNDING_USER_ID), true);
  assert.equal(isPlatformAdmin(ADMIN), true, 'an active admin account is a platform admin, read on every use');
  assert.equal(seesEverything(user(ADMIN)), true);
  assert.deepEqual(memberScope(user(ADMIN), { kind: 'portal' } as never), { all: true, userIds: [] });
  assert.deepEqual(visible(user(ADMIN), 'workspace', ['a', 'b'], (r) => r), ['a', 'b']);
  // A demotion takes effect on the next call: the account holds only its own.
  roles[ADMIN] = 'member';
  try {
    assert.equal(can(user(ADMIN), 'view', ws).allow, false);
    assert.equal(isPlatformAdmin(ADMIN), false);
  } finally {
    roles[ADMIN] = 'admin';
  }
});

test('a member, a removed account and a database that cannot be read hold nothing of the founder’s; a disabled account acts for nobody', () => {
  install();
  const ws = workspaceRef('docker/api');
  for (const u of [MEMBER, GONE]) assert.equal(can(user(u), 'view', ws).allow, false, u);
  const off = can(tokenOf(OFF), 'view', ws);
  assert.equal(!off.allow && off.reason, 'actor_disabled');
  restore = useAccountRoles(() => {
    throw new Error('database locked');
  });
  assert.equal(can(user(ADMIN), 'view', ws).allow, false, 'fail closed when the role cannot be read');
  assert.equal(can(ownerActor(), 'view', ws).allow, true, 'the founding user needs no account row');
});

test('by ownership: an admin holds its own objects and the founder’s, never another user’s; a member only its own', () => {
  install();
  const owners: Record<string, string> = { OWNERS: FOUNDING_USER_ID, ADMINS: ADMIN, MEMBERS: MEMBER, OTHER: 'u_someoneElse1' };
  registerResolver({
    type: 'ticket_bucket',
    resolve: (id) => (owners[id] ? { ref: ticketBucketRef(id), owner: { kind: 'user', id: owners[id]! } } : null),
  });
  const reach = (a: Actor) => Object.keys(owners).filter((b) => can(a, 'view', ticketBucketRef(b)).allow);
  assert.deepEqual(reach(ownerActor()), ['OWNERS']);
  assert.deepEqual(reach(user(ADMIN)), ['OWNERS', 'ADMINS']);
  assert.deepEqual(reach(user(MEMBER)), ['MEMBERS']);
  // A token minted by the member cannot reach the founder's bucket, nor the admin's; one minted by the founder can't reach the member's.
  assert.deepEqual(reach(tokenOf(MEMBER)), ['MEMBERS']);
  assert.deepEqual(reach(tokenOf(FOUNDING_USER_ID)), ['OWNERS']);
});

test('tokens: the principal’s owner is the actor, capped by scope; no owner (or not a user id) is nobody; agents keep their session owner', () => {
  install();
  const t = tokenOf(MEMBER, 'read');
  assert.deepEqual(t, { kind: 'token', userId: MEMBER, tokenId: 'ptk_x', scope: 'read' });
  assert.deepEqual(tokenOf(ADMIN, 'operate'), { kind: 'token', userId: ADMIN, tokenId: 'ptk_x', scope: 'operate' });
  for (const bad of [undefined, '', 'ui', 'Admin', 'user:u_owner', 'u_owner; drop']) assert.deepEqual(tokenOf(bad), anonymous(), String(bad));
  const agent = actorOfPrincipal({ kind: 'agent', tokenId: 'agt', scope: 'agent', workspaceId: 'docker/api', sessionId: 'S1' });
  assert.equal(agent.kind === 'agent' && agent.userId, FOUNDING_USER_ID, 'sessions are the founding user’s until P3 records their creator');
  assert.equal(can(tokenOf(ADMIN, 'read'), 'operate', workspaceRef('docker/api')).allow, false, 'the scope still caps');
});

test('actorOf: only the actor the middleware set; a session token alone is anonymous (fail closed)', () => {
  const ctx = (vars: Record<string, unknown>) => ({ get: (k: string) => vars[k] });
  assert.deepEqual(actorOf(ctx({ token: 'a-session' })), anonymous());
  const a = user(ADMIN);
  assert.equal(actorOf(ctx({ token: 'a-session', actor: a })), a);
});

test('sockets: the installed reader names the person; not authorized or no person is anonymous', () => {
  const req = (cookie: string) => ({ headers: { cookie } }) as unknown as IncomingMessage;
  useSocketActor((r) => (r.headers.cookie === 's=admin' ? user(ADMIN) : null));
  assert.deepEqual(actorOfSocket(req('s=admin'), () => true), user(ADMIN));
  assert.deepEqual(actorOfSocket(req('s=other'), () => true), anonymous(), 'signed in, but nobody the reader knows');
  assert.deepEqual(actorOfSocket(req('s=admin'), () => false), anonymous(), 'the module’s own check still decides');
  useSocketActor(null);
  assert.deepEqual(actorOfSocket(req(''), () => true), ownerActor(), 'with no reader installed (a module’s unit test), as before');
});
