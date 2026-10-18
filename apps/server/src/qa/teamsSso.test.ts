// Teams, granular shares and SSO through the real app (owner, 2026-10-17): the sign-in page asks how an email signs in (an SSO domain goes to
// its provider, others use a password, and a password is refused for an SSO domain); a whole SSO sign-in lands a member in its team; a
// session shared to the team at `read` is readable by its members and nothing more; a team owner manages people, a member does not, an
// outsider is told nothing; SSO providers and shares are the admin's, and a client secret never comes back.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { authorizeParams, CLIENT_ID, fakeIdp, ISSUER } from '../identity/fakeIdp.js';
import { Portal } from '../portal.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';

const stub: object = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
  apply: () => stub,
  construct: () => stub,
  set: () => true,
});
const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
const CODE = '24681357';
const PASSWORD = ['plenty', 'long', 'test', 'pass', 'phrase'].join('-');
const SECRET = ['client', 'secret', 'for', 'tests'].join('-');
const H = { host: 'pilot.example.com', origin: 'http://pilot.example.com', 'content-type': 'application/json' };

function fakeChat() {
  const calls: string[] = [];
  const sessions: Record<string, { id: string; title: string; state: string; workspaceId: string; waiting: number; lastSeq: number; mode: string }> = {
    lead: { id: 'lead', title: 'Orchestrator', state: 'working', workspaceId: 'kubernetes/kohi-event', waiting: 0, lastSeq: 3, mode: 'default' },
  };
  return {
    calls,
    sessions,
    resolve: (id: string) => id,
    get: (id: string) => sessions[id] ?? null,
    history: () => [{ seq: 3, at: 't', kind: 'assistant', text: 'hello' }],
    historyPage: () => ({ events: [{ seq: 3, at: 't', kind: 'assistant', text: 'hello' }], more: false, before: null }),
    send: async (id: string, _u: string, text: string, o: { actor?: string }) => void calls.push(`send ${id} ${text} ${o.actor}`),
    respond: async () => void calls.push('respond'),
    control: async () => void calls.push('stop'),
  };
}

async function build() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-teams-sso-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const portal = new Portal(CODE, 60_000);
  const chat = fakeChat();
  const idp = fakeIdp();
  const app = make(portal, stub, store, stub, stub, stub, stub, chat, { serveWeb: false, poolService: stub, mcp: stub, skills: stub, oidc: idp.client });
  const callOver = (scheme: 'http' | 'https') => (method: string, path: string, body?: unknown, cookie?: string) =>
    app.request(
      `${scheme}://pilot.example.com${path}`,
      { method, headers: { ...H, origin: `${scheme}://pilot.example.com`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
    );
  const call = callOver('http');
  // `(^|[\s,])` so `portal_session` never matches inside `__Host-portal_session`.
  const cookieOf = (r: Response, name = 'portal_session') => new RegExp(`(?:^|[\\s,])(${name}=[^;]+)`).exec(r.headers.get('set-cookie') ?? '')?.[1];
  const data = async <T>(r: Response) => ((await r.json()) as { data: T }).data;
  return { call, https: callOver('https'), cookieOf, data, chat, idp, done: () => (store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}

test('SSO: the domain decides; a password is refused for it; a whole sign-in makes a member in the team; the secret never comes back', async () => {
  const { call, cookieOf, data, idp, done } = await build();
  try {
    const admin = cookieOf(await call('POST', '/api/login', { code: CODE }))!;
    const team = await data<{ id: string }>(await call('POST', '/api/admin/teams', { name: 'Konfersi' }, admin));
    const created = await call('POST', '/api/admin/sso', { name: 'Example', issuer: ISSUER, clientId: CLIENT_ID, clientSecret: SECRET, domains: ['example.com'], defaultTeamId: team.id }, admin);
    assert.equal(created.status, 201);
    const listed = JSON.stringify(await data(await call('GET', '/api/admin/sso', undefined, admin)));
    assert.ok(!listed.includes(SECRET) && listed.includes('"hasClientSecret":true'));
    assert.match(listed, /"redirectUri":"https:\/\/pilot\.example\.com\/api\/auth\/sso\/callback"/);

    // How each email signs in: only the domain decides (an account that does not exist answers the same).
    assert.deepEqual(await data(await call('POST', '/api/auth/discover', { email: 'someone@gmail.com' })), { method: 'password' });
    const m = await data<{ method: string; start: string }>(await call('POST', '/api/auth/discover', { email: 'Ana@Example.com' }));
    assert.equal(m.method, 'sso');
    // A password account on an SSO domain cannot use its password any more.
    await call('POST', '/api/admin/users', { email: 'old@example.com', password: PASSWORD }, admin);
    const pw = await call('POST', '/api/login', { email: 'old@example.com', password: PASSWORD });
    assert.equal(pw.status, 403);
    assert.equal(cookieOf(pw), undefined);

    // The whole flow: start -> provider -> callback.
    const start = await call('GET', m.start);
    assert.equal(start.status, 302);
    const q = authorizeParams(start.headers.get('location')!);
    const bind = cookieOf(start, 'portal_sso')!;
    assert.match(start.headers.get('set-cookie') ?? '', /portal_sso=.*HttpOnly.*SameSite=Lax/i);
    idp.next = { nonce: q.nonce, email: 'ana@example.com', sub: 'ana-sub' };
    const noCookie = await call('GET', `/api/auth/sso/callback?code=c1&state=${q.state}`);
    assert.equal(noCookie.headers.get('location'), '/login?sso_error=state', 'a callback without the browser’s cookie is refused');
    const start2 = await call('GET', m.start);
    const q2 = authorizeParams(start2.headers.get('location')!);
    idp.next = { nonce: q2.nonce, email: 'ana@example.com', sub: 'ana-sub' };
    const back = await call('GET', `/api/auth/sso/callback?code=c2&state=${q2.state}`, undefined, cookieOf(start2, 'portal_sso'));
    assert.equal(back.status, 302);
    assert.equal(back.headers.get('location'), '/');
    const ana = cookieOf(back)!;
    assert.ok(ana && bind);
    const me = await data<{ kind: string; user: { email: string; role: string; id: string } }>(await call('GET', '/api/me', undefined, ana));
    assert.deepEqual([me.kind, me.user.email, me.user.role], ['account', 'ana@example.com', 'member']);
    // T-1043 S0a (review 10681 #5): an admin route refuses a member with the unknown path's 404, never a 403 that says it is there.
    assert.equal((await call('GET', '/api/workspaces', undefined, ana)).status, 404, 'a member, not an admin');
    const mine = await data<{ id: string; myRole: string }[]>(await call('GET', '/api/me/teams', undefined, ana));
    assert.deepEqual(mine.map((t) => [t.id, t.myRole]), [[team.id, 'member']]);
    // A member reaches none of the admin's SSO or share routes.
    assert.equal((await call('GET', '/api/admin/sso', undefined, ana)).status, 404);
    assert.equal((await call('GET', '/api/admin/session-shares', undefined, ana)).status, 404);
  } finally {
    done();
  }
});

test('T-976 over https: an email sign-in and an SSO sign-in both set __Host-portal_session (Secure, no Domain); an old cookie moves; sign-out clears both', async () => {
  const { call, https, cookieOf, data, idp, done } = await build();
  const HOST_COOKIE = '__Host-portal_session';
  const sessionSet = (r: Response) => r.headers.getSetCookie().filter((c) => c.startsWith(`${HOST_COOKIE}=`) && !/Max-Age=0/i.test(c));
  const assertHostCookie = (r: Response, what: string) => {
    const [c, ...more] = sessionSet(r);
    assert.ok(c, `${what}: ${r.headers.getSetCookie().map((x) => x.split('=')[0]).join(', ')}`);
    assert.equal(more.length, 0, what);
    assert.match(c, /;\s*Secure/i, what);
    assert.match(c, /;\s*Path=\/(;|$)/, what);
    assert.match(c, /;\s*HttpOnly/i, what);
    assert.doesNotMatch(c, /;\s*Domain=/i, what);
    assert.ok(!r.headers.getSetCookie().some((x) => x.startsWith('portal_session=') && !/Max-Age=0/i.test(x)), `${what}: the old name is only ever cleared over https`);
    return `${HOST_COOKIE}=${c.slice(HOST_COOKIE.length + 1).split(';')[0]}`;
  };
  try {
    const admin = cookieOf(await https('POST', '/api/login', { code: CODE }), HOST_COOKIE)!;
    assert.ok(admin, 'the server code over https');
    const team = await data<{ id: string }>(await https('POST', '/api/admin/teams', { name: 'Konfersi' }, admin));
    assert.equal((await https('POST', '/api/admin/sso', { name: 'Example', issuer: ISSUER, clientId: CLIENT_ID, clientSecret: SECRET, domains: ['example.com'], defaultTeamId: team.id }, admin)).status, 201);
    assert.ok((await data<{ id: string }>(await https('POST', '/api/admin/users', { email: 'pw@corp.test', password: PASSWORD }, admin))).id);

    // An email account.
    const pw = await https('POST', '/api/login', { email: 'pw@corp.test', password: PASSWORD });
    assert.equal(pw.status, 200);
    const pwCookie = assertHostCookie(pw, 'email sign-in');
    assert.equal((await data<{ kind: string }>(await https('GET', '/api/me', undefined, pwCookie))).kind, 'account');

    // SSO: start -> provider -> callback.
    const m = await data<{ start: string }>(await https('POST', '/api/auth/discover', { email: 'ana@example.com' }));
    const start = await https('GET', m.start);
    const q = authorizeParams(start.headers.get('location')!);
    idp.next = { nonce: q.nonce, email: 'ana@example.com', sub: 'ana-sub' };
    const back = await https('GET', `/api/auth/sso/callback?code=c1&state=${q.state}`, undefined, cookieOf(start, 'portal_sso'));
    assert.equal(back.headers.get('location'), '/');
    const ana = assertHostCookie(back, 'SSO callback');
    const me = await data<{ user: { email: string } }>(await https('GET', '/api/me', undefined, ana));
    assert.equal(me.user.email, 'ana@example.com');
    const session = await data<{ authenticated: boolean; member: boolean }>(await https('GET', '/api/session', undefined, ana));
    assert.deepEqual([session.authenticated, session.member], [true, true]);

    // A member signed in before T-976 (old name only) stays signed in and is moved to the __Host- name.
    const oldName = `portal_session=${ana.slice(HOST_COOKIE.length + 1)}`;
    const moved = await https('GET', '/api/me', undefined, oldName);
    assert.equal(moved.status, 200);
    assert.equal(assertHostCookie(moved, 'migration of a member'), ana, 'the same session under the new name');

    // With both names the __Host- one is read (a planted old-name session is ignored), and sign-out ends it and clears both names.
    const both = `portal_session=${pwCookie.slice(HOST_COOKIE.length + 1)}; ${ana}`;
    assert.equal((await data<{ user: { email: string } }>(await https('GET', '/api/me', undefined, both))).user.email, 'ana@example.com');
    const out = await https('POST', '/api/logout', {}, both);
    assert.equal(out.status, 200);
    const cleared = out.headers.getSetCookie();
    assert.ok(cleared.some((c) => c.startsWith(`${HOST_COOKIE}=;`) && /Max-Age=0/i.test(c) && /;\s*Secure/i.test(c)), cleared.join(' | '));
    assert.ok(cleared.some((c) => c.startsWith('portal_session=;') && /Max-Age=0/i.test(c)), cleared.join(' | '));
    assert.equal((await https('GET', '/api/me', undefined, ana)).status, 401, 'the SSO session is ended');
    assert.equal((await https('GET', '/api/me', undefined, pwCookie)).status, 200, 'the other session is not');

    // Plain http keeps the old name for an email account (a dev or scratch portal).
    const plain = await call('POST', '/api/login', { email: 'pw@corp.test', password: PASSWORD });
    assert.equal(plain.status, 200);
    assert.ok(cookieOf(plain), 'portal_session over http');
    assert.equal(cookieOf(plain, HOST_COOKIE), undefined);
  } finally {
    done();
  }
});

test('teams and granular shares: read-only through a team; an owner manages people, a member does not, an outsider sees nothing; leaving ends it', async () => {
  const { call, cookieOf, data, chat, done } = await build();
  try {
    const admin = cookieOf(await call('POST', '/api/login', { code: CODE }))!;
    const mk = async (email: string) => {
      const u = await data<{ id: string }>(await call('POST', '/api/admin/users', { email, password: PASSWORD }, admin));
      return { id: u.id, c: cookieOf(await call('POST', '/api/login', { email, password: PASSWORD }))! };
    };
    const own = await mk('owner@corp.test');
    const mem = await mk('mem@corp.test');
    const out = await mk('out@corp.test');
    const team = await data<{ id: string }>(await call('POST', '/api/admin/teams', { name: 'Ops', owners: [own.id] }, admin));
    // The team owner adds a member; a member cannot add; an outsider is told nothing.
    assert.equal((await call('POST', `/api/teams/${team.id}/members`, { email: 'mem@corp.test' }, own.c)).status, 200);
    assert.equal((await call('POST', `/api/teams/${team.id}/members`, { email: 'out@corp.test' }, mem.c)).status, 403);
    assert.equal((await call('POST', `/api/teams/${team.id}/members`, { email: 'out@corp.test' }, out.c)).status, 404);
    assert.equal((await call('GET', `/api/teams/${team.id}`, undefined, out.c)).status, 404);
    assert.equal((await call('POST', `/api/teams/${team.id}/members`, { email: 'nobody@corp.test' }, own.c)).status, 422);

    // Share to the team: read only, with an end.
    const end = new Date(Date.now() + 86_400_000).toISOString();
    const put = await call('PUT', '/api/admin/session-grants/lead', { subject: { kind: 'team', id: team.id }, caps: ['read'], expiresAt: end, note: 'on call' }, admin);
    assert.equal(put.status, 200);
    const share = await data<{ id: string; caps: string[]; subjectName: string }>(put);
    assert.deepEqual([share.caps, share.subjectName], [['read'], 'Ops']);
    const list = await data<{ id: string; caps: string[]; via: string[]; expiresAt: string }[]>(await call('GET', '/api/me/sessions', undefined, mem.c));
    assert.deepEqual(list.map((x) => [x.id, x.caps, x.via]), [['lead', ['read'], ['Ops']]]);
    assert.equal((await call('GET', '/api/me/sessions/lead/events?after=0', undefined, mem.c)).status, 200);
    assert.equal((await call('POST', '/api/me/sessions/lead/send', { text: 'hi' }, mem.c)).status, 403, 'read only');
    assert.equal((await call('GET', '/api/me/sessions/lead', undefined, out.c)).status, 404, 'not in the team');
    // The team's owners see what is shared to it; a plain member does not.
    assert.equal((await data<{ shares: unknown[] }>(await call('GET', `/api/teams/${team.id}`, undefined, own.c))).shares.length, 1);
    assert.equal((await data<{ shares: unknown[] }>(await call('GET', `/api/teams/${team.id}`, undefined, mem.c))).shares.length, 0);

    // Granular: give `send` only (no stop, no approvals).
    assert.equal((await call('PATCH', `/api/admin/session-shares/${share.id}`, { caps: ['read', 'send'] }, admin)).status, 200);
    assert.equal((await call('POST', '/api/me/sessions/lead/send', { text: 'go on' }, mem.c)).status, 200);
    assert.equal((await call('POST', '/api/me/sessions/lead/stop', {}, mem.c)).status, 403);
    assert.equal((await call('POST', '/api/me/sessions/lead/respond', { requestId: 'r', decision: 'allow' }, mem.c)).status, 403);
    assert.deepEqual(chat.calls, [`send lead go on account:${mem.id}`]);
    // Bypass: an acting share needs the acceptance; without it the share is not written.
    chat.sessions.lead!.mode = 'bypassPermissions';
    assert.equal((await call('POST', '/api/me/sessions/lead/send', { text: 'x' }, mem.c)).status, 403, 'Bypass came after the share');
    assert.equal((await call('PUT', '/api/admin/session-grants/lead', { subject: { kind: 'user', id: out.id }, caps: ['send'] }, admin)).status, 422);
    assert.equal((await call('GET', '/api/me/sessions/lead', undefined, out.c)).status, 404, 'the refused share was not written');
    chat.sessions.lead!.mode = 'default';

    // The admin's overview lists it; leaving the team ends it at once; removing the team removes its shares.
    const all = await data<{ id: string; sessionTitle: string }[]>(await call('GET', '/api/admin/session-shares', undefined, admin));
    assert.deepEqual(all.map((x) => [x.id, x.sessionTitle]), [[share.id, 'Orchestrator']]);
    assert.equal((await call('DELETE', `/api/teams/${team.id}/members/${mem.id}`, undefined, mem.c)).status, 200, 'a member may leave');
    assert.equal((await call('GET', '/api/me/sessions/lead', undefined, mem.c)).status, 404);
    assert.equal((await call('DELETE', `/api/teams/${team.id}/members/${own.id}`, undefined, own.c)).status, 409, 'the last owner stays');
    assert.equal((await call('DELETE', `/api/admin/teams/${team.id}`, undefined, admin)).status, 200);
    assert.deepEqual(await data(await call('GET', '/api/admin/session-shares', undefined, admin)), []);
  } finally {
    done();
  }
});
