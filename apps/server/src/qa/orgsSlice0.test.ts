// Organizations slice 0 over HTTP and sockets (docs/prd/organizations.md §13 P1, P2): a second admin account signs in and is ITSELF on every
// request (the audit row names it), on its sockets, and in the tokens it mints; the server code and the founder account stay `u_owner`;
// a member is still refused (D-82). Built on a real store with stub runtimes, as qa/emailLogin.test.ts.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FOUNDING_USER_ID, ticketBucketRef } from '@portal/contracts';
import { createApp } from '../app.js';
import { actorOfPrincipal, actorOfSocket, can, clearResolvers, registerResolver } from '../authz/seam.js';
import { Portal } from '../portal.js';
import { PortalMcpModule } from '../portalmcp/module.js';
import { ToolRegistry } from '../portalmcp/registry.js';
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
const H = { host: 'localhost:3000', origin: 'http://localhost:3000', 'content-type': 'application/json' };

interface AuditRow {
  kind: string;
  actor: string;
  userId: string | null;
  subject: string | null;
}

async function build() {
  process.env.PORTAL_PASSWORD_COST ??= 'test';
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-orgs0-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const portal = new Portal(CODE, 60_000);
  const audit: AuditRow[] = [];
  // The platform: a stub except its audit, which the test reads.
  const platform = new Proxy({}, { get: (_t, p) => (p === 'audit' ? { record: (e: AuditRow) => void audit.push(e) } : p === 'then' ? undefined : stub) });
  const app = make(portal, stub, store, stub, stub, stub, stub, stub, { serveWeb: false, poolService: stub, mcp: stub, skills: stub, platform });
  const call = (method: string, path: string, body?: unknown, cookie?: string) =>
    app.request(`http://localhost:3000${path}`, { method, headers: { ...H, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
  const cookieOf = (r: Response) => /portal_session=[^;]+/.exec(r.headers.get('set-cookie') ?? '')?.[0];
  const account = async (cookie: string, email: string, role: 'admin' | 'member') => {
    const r = await call('POST', '/api/admin/users', { email, password: PASSWORD, role }, cookie);
    assert.equal(r.status, 201, await r.clone().text());
    return ((await r.json()) as { data: { id: string } }).data.id;
  };
  const login = async (email: string) => cookieOf(await call('POST', '/api/login', { email, password: PASSWORD }))!;
  const socketReq = (cookie: string) => ({ headers: { cookie } }) as unknown as IncomingMessage;
  return { store, portal, audit, call, cookieOf, account, login, socketReq, done: () => (store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}

test('a second admin is itself on HTTP (its own audit rows) and on sockets; the server code stays the founding user', async () => {
  const t = await build();
  try {
    const code = t.cookieOf(await t.call('POST', '/api/login', { code: CODE }))!;
    const second = await t.account(code, 'second@example.com', 'admin');
    assert.notEqual(second, FOUNDING_USER_ID);
    const created = t.audit.find((r) => r.kind === 'account.created')!;
    assert.deepEqual([created.actor, created.userId], [`user:${FOUNDING_USER_ID}`, FOUNDING_USER_ID], 'the server code is the founding user');

    const admin2 = await t.login('second@example.com');
    const third = await t.account(admin2, 'third@example.com', 'member');
    const row = t.audit.filter((r) => r.kind === 'account.created').at(-1)!;
    assert.deepEqual([row.actor, row.userId, row.subject], [`user:${second}`, second, `user:${third}`], 'the audit names the admin who acted, not the owner');
    assert.equal((await t.call('PATCH', `/api/admin/users/${third}`, { displayName: 'Third' }, admin2)).status, 200);
    assert.equal(t.audit.find((r) => r.kind === 'account.updated')!.userId, second);
    // Identity's own rows (teams, shares, SSO providers) name the admin too.
    assert.equal((await t.call('POST', '/api/admin/teams', { name: 'Ops' }, admin2)).status, 201);
    const team = t.audit.find((r) => r.kind === 'team.created')!;
    assert.deepEqual([team.actor, team.userId], [`user:${second}`, second]);

    // D-82: the second admin keeps full access (it reads the admin app like the owner).
    assert.equal((await t.call('GET', '/api/admin/users', undefined, admin2)).status, 200);

    // Sockets read the same person from the same cookie.
    const viaSocket = actorOfSocket(t.socketReq(admin2), () => true);
    assert.deepEqual(viaSocket.kind === 'user' && viaSocket.userId, second);
    const owner = actorOfSocket(t.socketReq(code), () => true);
    assert.equal(owner.kind === 'user' && owner.userId, FOUNDING_USER_ID);
    assert.equal(actorOfSocket(t.socketReq('portal_session=made-up'), () => true).kind, 'anonymous', 'a cookie that is no session is nobody');

    // A member is still refused the admin app (D-82 S1a), and its socket names nobody.
    const member = await t.login('third@example.com');
    assert.equal((await t.call('GET', '/api/admin/users', undefined, member)).status, 403);
    assert.equal(actorOfSocket(t.socketReq(member), () => true).kind, 'anonymous');
  } finally {
    t.done();
  }
});

test('the account marked founder (migration 460) is the founding user; a demoted admin loses its session at once', async () => {
  const t = await build();
  try {
    const code = t.cookieOf(await t.call('POST', '/api/login', { code: CODE }))!;
    const founder = await t.account(code, 'founder@example.com', 'admin');
    t.store.db!.prepare('UPDATE users SET founder = 1 WHERE id = ?').run(founder);
    const f = await t.login('founder@example.com');
    await t.account(f, 'x@example.com', 'member');
    const row = t.audit.filter((r) => r.kind === 'account.created').at(-1)!;
    assert.deepEqual([row.actor, row.userId], [`user:${FOUNDING_USER_ID}`, FOUNDING_USER_ID]);
    const viaSocket = actorOfSocket(t.socketReq(f), () => true);
    assert.equal(viaSocket.kind === 'user' && viaSocket.userId, FOUNDING_USER_ID);

    const other = await t.account(code, 'other@example.com', 'admin');
    const o = await t.login('other@example.com');
    assert.equal((await t.call('PATCH', `/api/admin/users/${other}`, { role: 'member' }, code)).status, 200);
    assert.equal((await t.call('GET', '/api/admin/users', undefined, o)).status, 401, 'the demotion ended its session');
  } finally {
    t.done();
  }
});

test('Portal MCP tokens (and VS Code ones) are bound to who minted them; a token of one user never reaches another’s bucket', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-orgs0-tok-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  try {
    const module = new PortalMcpModule(store, { registry: new ToolRegistry(), agentHost: { alive: () => false, url: () => 'http://x/mcp' }, managerAlive: () => false });
    const A = 'u_userA_000001';
    const B = 'u_userB-000002';
    const mintA = module.createToken({ label: 'a-script', scope: 'admin' }, 'http://p/mcp', `user:${A}`);
    const mintB = module.createToken({ label: 'b-editor', scope: 'operate' }, 'http://p/mcp', `user:${B}`, { client: 'vscode', instance: 'inst-b' });
    const legacy = module.createToken({ label: 'old-ui', scope: 'read' }, 'http://p/mcp'); // `ui`: the founding user
    assert.deepEqual([mintA.token.ownerId, mintB.token.ownerId, legacy.token.ownerId], [A, B, FOUNDING_USER_ID]);
    assert.throws(() => module.createToken({ label: 'from-token', scope: 'read' }, 'http://p/mcp', 'portal-mcp:ptk_x'), /signed-in person/, 'no person, no token');
    assert.equal(module.createToken({ label: 'by-a-token', scope: 'read' }, 'http://p/mcp', 'portal-mcp:ptk_x', undefined, B).token.ownerId, B, 'an admin token mints for its own person');

    const actorFor = (secret: string) => {
      const v = module.tokens.verify(secret);
      assert.ok(v.ok);
      return actorOfPrincipal(v.principal);
    };
    const a = actorFor(mintA.secret);
    const b = actorFor(mintB.secret);
    assert.deepEqual([a.kind === 'token' && a.userId, b.kind === 'token' && b.userId], [A, B]);
    assert.equal(b.kind === 'token' && b.scope, 'operate', 'the scope still caps');
    registerResolver({ type: 'ticket_bucket', resolve: (id) => ({ ref: ticketBucketRef(id), owner: { kind: 'user', id: id === 'AAA' ? A : B } }) });
    assert.equal(can(a, 'view', ticketBucketRef('AAA')).allow, true);
    assert.equal(can(b, 'view', ticketBucketRef('AAA')).allow, false, 'B’s token cannot reach A’s bucket');
    assert.equal(can(b, 'operate', ticketBucketRef('BBB')).allow, true);
  } finally {
    clearResolvers();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
