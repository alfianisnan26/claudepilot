// The authorization seam (seam.ts): what the single-owner implementation does today, and what it already does for a type that has a resolver.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AppError } from '@isnanme/core';
import { actorString, parseActorString, sessionRef, ticketRef, workspaceRef, type Actor, type ObjectRef } from '@portal/contracts';
import {
  OWNER_ID,
  actorOf,
  actorOfPrincipal,
  asUser,
  can,
  clearResolvers,
  declarePolicies,
  declareToolPolicies,
  toolPolicyFor,
  emitAccessChange,
  levelOf,
  onAccessChange,
  ownerActor,
  registerResolver,
  requireCan,
  singleOwner,
  systemActor,
  useAuthz,
  visible,
  anonymous,
  type Authz,
} from './seam.js';

afterEach(() => clearResolvers());

const token = (scope: 'read' | 'operate' | 'admin'): Actor => ({ kind: 'token', userId: OWNER_ID, tokenId: 'ptk_1', scope });
const agent: Actor = { kind: 'agent', userId: OWNER_ID, tokenId: 'agt_1', sessionId: 'S1', workspaceId: 'docker/api' };
const user = (id: string): Actor => ({ kind: 'user', userId: id, loginSessionId: 'x', via: 'ui' });

test('today the owner may do anything, the portal itself too, and nobody else without a resolver', () => {
  assert.deepEqual(can(ownerActor(), 'manage', workspaceRef('docker/api')), { allow: true, level: 'manage' });
  assert.equal(can(systemActor('reconciler'), 'manage', ticketRef('T-1')).allow, true);
  assert.equal(can(asUser(OWNER_ID, 'trigger:t1'), 'operate', sessionRef('S9')).allow, true);
  const d = can(anonymous(), 'view', workspaceRef('docker/api'));
  assert.deepEqual(d, { allow: false, reason: 'unauthenticated', level: 'none' });
  const other = can(user('u_b'), 'view', workspaceRef('docker/api'));
  assert.equal(other.allow, false);
  assert.equal(!other.allow && other.reason, 'not_found', 'another user without any right is answered like a missing object');
  assert.equal(can(user('ui'), 'view', workspaceRef('docker/api')).allow, false, 'a name that is not a user id is no user');
});

test('a token is capped by its scope, and says why', () => {
  const ws = workspaceRef('docker/api');
  assert.equal(can(token('read'), 'view', ws).allow, true);
  const op = can(token('read'), 'operate', ws);
  assert.deepEqual(op, { allow: false, reason: 'scope', level: 'view' });
  assert.equal(can(token('operate'), 'operate', ws).allow, true);
  assert.equal(can(token('operate'), 'manage', ws).allow, false);
  assert.equal(can(token('admin'), 'manage', ws).allow, true);
  assert.equal(levelOf(token('operate'), ws), 'operate');
});

test('an agent holds operate at most, and only in its own session and workspace', () => {
  assert.equal(can(agent, 'operate', sessionRef('S1')).allow, true);
  assert.equal(can(agent, 'manage', sessionRef('S1')).allow, false);
  assert.equal(!can(agent, 'view', sessionRef('S2')).allow && (can(agent, 'view', sessionRef('S2')) as { reason: string }).reason, 'agent_box');
  assert.equal(can(agent, 'operate', workspaceRef('docker/api')).allow, true);
  assert.equal(can(agent, 'view', workspaceRef('docker/other')).allow, false);
  for (const type of ['platform', 'user', 'team', 'personal', 'target'] as const) assert.equal(can(agent, 'view', { type, id: 'x' }).allow, false, `an agent never reaches ${type}`);
  assert.equal(can(agent, 'view', ticketRef('T-3')).allow, true, 'other objects follow the owner’s rights (the tools add their own limits)');
});

test('a registered resolver turns on default deny for its type: the owner or nothing', () => {
  const rows: Record<string, { owner: string | null; pub?: 'view' | 'operate' }> = { T1: { owner: 'u_a' }, T2: { owner: 'u_b' }, T3: { owner: null }, L1: { owner: 'u_a', pub: 'operate' } };
  registerResolver({
    type: 'ticket',
    resolve: (id) => (rows[id] ? { ref: ticketRef(id), owner: rows[id]!.owner ? { kind: 'user', id: rows[id]!.owner! } : null, publicLevel: rows[id]!.pub } : null),
  });
  const a = user('u_a');
  const b = user('u_b');
  assert.equal(can(a, 'manage', ticketRef('T1')).allow, true);
  const peek = can(b, 'view', ticketRef('T1'));
  assert.deepEqual(peek, { allow: false, reason: 'not_found', level: 'none' }, 'user B cannot even view user A’s object, and learns nothing');
  assert.deepEqual(can(a, 'view', ticketRef('T-missing')), { allow: false, reason: 'not_found', level: 'none' });
  assert.deepEqual(can(a, 'view', ticketRef('T3')), { allow: false, reason: 'unowned', level: 'none' });
  assert.equal(can(b, 'operate', ticketRef('L1')).allow, true, 'a public level reaches every user');
  assert.equal(can(b, 'manage', ticketRef('L1')).allow, false);
  assert.deepEqual(
    visible(b, 'ticket', ['T1', 'T2', 'T3', 'L1'], (x) => x),
    ['T2', 'L1'],
    'a list holds only what the person may view',
  );
  assert.deepEqual(
    visible(ownerActor(), 'workspace', ['w1', 'w2'], (x) => x),
    ['w1', 'w2'],
    'a type with no resolver is the owner’s, whole',
  );
  assert.deepEqual(
    visible(agent, 'session', ['S1', 'S2'], (x) => x),
    ['S1'],
    'an agent sees its own session and not a sibling',
  );
});

test('requireCan answers 401, 404 or 403 and names what was needed', () => {
  registerResolver({ type: 'session', resolve: (id) => (id === 'S1' ? { ref: sessionRef('S1'), owner: { kind: 'user', id: 'u_a' } } : null) });
  const status = (fn: () => void) => {
    try {
      fn();
      return 200;
    } catch (e) {
      assert.ok(e instanceof AppError);
      return (e as AppError).status;
    }
  };
  assert.equal(status(() => requireCan(anonymous(), 'view', sessionRef('S1'))), 401);
  assert.equal(status(() => requireCan(user('u_b'), 'view', sessionRef('S1'))), 404);
  assert.equal(status(() => requireCan(user('u_a'), 'manage', sessionRef('S1'))), 200);
  try {
    requireCan(token('read'), 'operate', ticketRef('T-1'));
    assert.fail('a read token may not operate');
  } catch (e) {
    const err = e as AppError;
    assert.equal(err.status, 403);
    assert.deepEqual(err.details, { verb: 'operate', have: 'view', object: ticketRef('T-1') });
  }
});

test('actorOf reads the signed-in request, an actor the real layer set, or none', () => {
  const ctx = (vars: Record<string, unknown>) => ({ get: (k: string) => vars[k] });
  assert.deepEqual(actorOf(ctx({ token: 'abc' })), ownerActor());
  assert.deepEqual(actorOf(ctx({})), anonymous());
  const set = user('u_z');
  assert.equal(actorOf(ctx({ actor: set, token: 'abc' })), set);
  assert.deepEqual(actorOfPrincipal({ kind: 'agent', tokenId: 'agt_1', scope: 'agent', workspaceId: 'docker/api', sessionId: 'S1' }), agent);
  assert.deepEqual(actorOfPrincipal({ kind: 'user', tokenId: 'ptk_1', scope: 'operate', workspaceId: null, sessionId: null }), token('operate'));
});

test('actor strings keep the portal’s old spellings and add user:', () => {
  assert.equal(actorString(ownerActor()), 'user:u_owner');
  assert.equal(actorString(token('read')), 'portal-mcp:ptk_1');
  assert.equal(actorString(agent), 'session:S1');
  assert.equal(actorString(systemActor('reconciler')), 'system:reconciler');
  assert.deepEqual(parseActorString('ui'), { kind: 'user', id: 'u_owner', legacy: true });
  assert.deepEqual(parseActorString('Admin'), { kind: 'user', id: 'u_owner', legacy: true });
  assert.deepEqual(parseActorString('user:u_b'), { kind: 'user', id: 'u_b', legacy: false });
  assert.deepEqual(parseActorString('portal-mcp:ptk_1'), { kind: 'token', id: 'ptk_1' });
  assert.deepEqual(parseActorString('session:S1'), { kind: 'agent', id: 'S1' });
  assert.deepEqual(parseActorString('ci:42'), { kind: 'job', id: '42', prefix: 'ci' });
  assert.equal(parseActorString('whatever').kind, 'unknown');
});

test('route declarations are kept by key and a conflicting one throws', () => {
  declarePolicies('seam.test', { 'GET /api/seam-test/:id': { kind: 'objects', checks: [{ type: 'ticket', verb: 'view', from: 'path', param: 'id' }] } });
  declarePolicies('seam.test', { 'GET /api/seam-test/:id': { kind: 'objects', checks: [{ type: 'ticket', verb: 'view', from: 'path', param: 'id' }] } });
  assert.throws(() => declarePolicies('other', { 'GET /api/seam-test/:id': { kind: 'signed-in' } }), /declared twice/);
});

test('tool declarations are kept by name and a conflicting one throws', () => {
  declareToolPolicies('seam.test', { seam_test_tool: { kind: 'objects', checks: [{ type: 'ticket', verb: 'view', arg: 'id' }] } });
  declareToolPolicies('seam.test', { seam_test_tool: { kind: 'objects', checks: [{ type: 'ticket', verb: 'view', arg: 'id' }] } });
  assert.deepEqual(toolPolicyFor('seam_test_tool'), { kind: 'objects', checks: [{ type: 'ticket', verb: 'view', arg: 'id' }] });
  assert.throws(() => declareToolPolicies('other', { seam_test_tool: { kind: 'self' } }), /declared twice/);
});

test('access changes reach listeners, and a failing listener does not stop the others', () => {
  const seen: string[] = [];
  const off1 = onAccessChange(() => {
    throw new Error('boom');
  });
  const off2 = onAccessChange((c) => seen.push(`${c.userId}:${c.why}`));
  const log = console.error;
  console.error = () => undefined;
  try {
    emitAccessChange({ userId: 'u_b', ref: workspaceRef('docker/api'), why: 'share_ended' });
  } finally {
    console.error = log;
    off1();
    off2();
  }
  assert.deepEqual(seen, ['u_b:share_ended']);
  emitAccessChange({ userId: 'u_b', ref: null, why: 'signed_out' });
  assert.deepEqual(seen, ['u_b:share_ended'], 'unsubscribed');
});

test('useAuthz swaps the layer under every call site and returns the one it replaced', () => {
  const ref: ObjectRef = workspaceRef('docker/api');
  const fake: Authz = { ...singleOwner, mode: 'multi-user', can: () => ({ allow: false, reason: 'no_right', level: 'view' }) };
  const was = useAuthz(fake);
  try {
    assert.equal(was, singleOwner);
    assert.equal(can(ownerActor(), 'view', ref).allow, false);
    assert.throws(() => requireCan(ownerActor(), 'operate', ref), (e: unknown) => (e as AppError).status === 403);
  } finally {
    useAuthz(was);
  }
  assert.equal(can(ownerActor(), 'view', ref).allow, true);
});
