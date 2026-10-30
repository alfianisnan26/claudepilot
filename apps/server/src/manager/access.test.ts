// T-968 review (2026-10-18): the General Manager's token only while its person is signed in, and the heal after a sign-out.
// - Portal.signedIn: any live session of the person, on any device; a server-code session is the founding user's; a sign-out, a revoke and an
//   expiry end it.
// - managerAccess.mint (index.ts wiring): null when the person has no live portal session (no token is minted at all); else the grant with
//   the manager token, the URL and claude.ai's connectors off.
// - managerHealer (app.ts, at a sign-in): restarts the manager at its turn's end when it holds no live token; nothing when it holds one, when
//   it ended, when there is none, or when Portal MCP is not wired.
// Tokens are fakes built at run time; no token-shaped literal.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOUNDING_USER_ID, type ChatSession } from '@portal/contracts';
import { Portal } from '../portal.js';
import { managerAccess, managerHealer } from './access.js';

const CODE = '24681357';
const ALICE = 'u_alice';

test('Portal.signedIn: any live session of the person on any device; the server code is the founding user\'s; sign-out, revoke and expiry end it', async () => {
  const portal = new Portal(CODE, 60_000);
  portal.roleOf = () => 'admin';
  assert.equal(portal.signedIn(ALICE), false, 'nobody is signed in');
  assert.equal(portal.signedIn(FOUNDING_USER_ID), false);

  const phone = portal.openSession(ALICE);
  const laptop = portal.openSession(ALICE);
  assert.equal(portal.signedIn(ALICE), true);
  assert.equal(portal.signedIn(FOUNDING_USER_ID), false, 'an account session is not the server code\'s');
  assert.equal(portal.signedIn('u_bob'), false);
  portal.signOut(phone);
  assert.equal(portal.signedIn(ALICE), true, 'the laptop is still signed in');
  portal.signOut(laptop);
  assert.equal(portal.signedIn(ALICE), false);

  const code = portal.signIn(CODE);
  assert.equal(portal.signedIn(FOUNDING_USER_ID), true, 'a server-code session counts for the founding user');
  assert.equal(portal.signedIn(ALICE), false);
  portal.signOut(code);
  assert.equal(portal.signedIn(FOUNDING_USER_ID), false);

  portal.openSession(ALICE);
  portal.revokeUser(ALICE);
  assert.equal(portal.signedIn(ALICE), false, 'a revoke ends every session of the person');

  const short = new Portal(CODE, 5);
  short.roleOf = () => 'admin';
  short.openSession(ALICE);
  assert.equal(short.signedIn(ALICE), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(short.signedIn(ALICE), false, 'an expired session does not count');
});

/** A fake token store: what mint was asked, and a secret built at run time. */
function fakeTokens() {
  const minted: { userId: string; sessionId: string; keepOthers?: boolean }[] = [];
  const settled: [string, string, boolean][] = [];
  return {
    minted,
    settled,
    mint(req: { userId: string; sessionId: string }, opts: { keepOthers?: boolean } = {}) {
      minted.push({ ...req, keepOthers: opts.keepOthers });
      return { tokenId: `mgt_${minted.length}`, secret: ['fake', 'manager', String(minted.length)].join('-') };
    },
    settle(sessionId: string, tokenId: string, started: boolean) {
      settled.push([sessionId, tokenId, started]);
    },
  };
}

test('managerAccess.mint: null, and no token minted, when the person has no live portal session; the grant once they sign in', async () => {
  const portal = new Portal(CODE, 60_000);
  portal.roleOf = () => 'admin';
  const tokens = fakeTokens();
  const access = managerAccess({ signedIn: (u) => portal.signedIn(u), url: async () => 'http://portal.test/mcp', tokens, brief: () => 'the brief' });
  const req = { workspaceId: 'kubernetes/general-manager', sessionId: 'gm1', ownerId: ALICE };

  assert.equal(await access.mint(req), null, 'signed out: no grant');
  assert.equal(tokens.minted.length, 0, 'and no token was minted');

  const phone = portal.openSession(ALICE);
  const grant = await access.mint(req);
  assert.ok(grant);
  assert.deepEqual(tokens.minted, [{ userId: ALICE, sessionId: 'gm1', keepOthers: true }]);
  assert.equal(grant.tokenId, 'mgt_1');
  assert.equal(grant.env.PILOT_MCP_TOKEN, 'fake-manager-1');
  assert.equal(grant.env.PILOT_MCP_URL, 'http://portal.test/mcp');
  assert.equal(grant.env.PILOT_SESSION_ID, 'gm1');
  assert.equal(grant.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false', 'claude.ai connectors stay out of the manager');
  assert.match(grant.mcpConfig, /PILOT_MCP_TOKEN/);
  assert.equal(access.brief(), 'the brief');
  access.settle!('gm1', 'mgt_1', true);
  assert.deepEqual(tokens.settled, [['gm1', 'mgt_1', true]]);

  // A sign-out on the last device: the next wake gets nothing again.
  portal.signOut(phone);
  assert.equal(await access.mint(req), null);
  assert.equal(tokens.minted.length, 1);

  // Signed in but no URL for the workspace: nothing minted either.
  portal.openSession(ALICE);
  const noUrl = managerAccess({ signedIn: (u) => portal.signedIn(u), url: async () => null, tokens, brief: () => '' });
  assert.equal(await noUrl.mint(req), null);
  assert.equal(tokens.minted.length, 1);
});

const manager = (o: Partial<ChatSession> = {}) => ({ id: 'gm1', state: 'idle', ...o }) as ChatSession;

test('managerHealer: restarts at turn end a live manager with no live token; nothing when it has one, ended, missing, or MCP is off', async () => {
  const restarts: [string, unknown][] = [];
  const restart = async (id: string, opts: unknown) => void restarts.push([id, opts]);
  let live = false;
  let m: ChatSession | null = manager();
  const heal = managerHealer({ managerOf: (o) => (o === ALICE ? m : null), hasLive: () => live, restart });

  heal(ALICE);
  assert.deepEqual(restarts, [['gm1', { why: 'mcp', when: 'turn_end', actor: 'portal:manager', from: 'auto' }]], 'no live token: restarted at its turn\'s end');

  live = true;
  heal(ALICE);
  assert.equal(restarts.length, 1, 'a live token: nothing');

  live = false;
  heal('u_bob');
  assert.equal(restarts.length, 1, 'no manager: nothing');
  m = manager({ state: 'ended' });
  heal(ALICE);
  assert.equal(restarts.length, 1, 'an ended manager is not brought back');

  m = manager();
  managerHealer({ managerOf: () => m, restart })(ALICE);
  assert.equal(restarts.length, 1, 'without Portal MCP there is no token to heal');

  // A restart that fails is swallowed (a sign-in never fails because of it).
  managerHealer({ managerOf: () => m, hasLive: () => false, restart: async () => Promise.reject(new Error('busy')) })(ALICE);
  await new Promise((r) => setImmediate(r));
});

test('managerHealer: a store that throws (frozen or unreadable database) never breaks the sign-in that calls it', () => {
  const heal = managerHealer({
    managerOf: () => {
      throw new Error('file is not a database');
    },
    hasLive: () => false,
    restart: async () => undefined,
  });
  assert.doesNotThrow(() => heal(ALICE));
});
