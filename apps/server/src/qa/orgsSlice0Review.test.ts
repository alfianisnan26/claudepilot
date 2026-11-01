// Organizations slice 0, blind review M1, M2, m1, m2, m8: tokens and agents live no longer than the account behind them, the founder
// account's included (its tokens carry `u_owner`, so the account is recorded at mint); a disable, a demotion and a removal revoke them for
// good; migrations 460-462 on an existing database (the real runner) keep today's tokens and audit the founder mark and guarded SSO links.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FOUNDING_USER_ID } from '@portal/contracts';
import { createApp } from '../app.js';
import { actorOfPrincipal, can, useAccountRoles } from '../authz/seam.js';
import { ChatStore } from '../chat/store.js';
import { accountStanding, revokeAccountTokens } from '../identity/accountGate.js';
import { Portal } from '../portal.js';
import { PortalMcpModule } from '../portalmcp/module.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { PortalTokens } from '../portalmcp/tokens.js';
import { MIGRATIONS } from '../store/migrations.js';
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

async function storeAt(migrations = MIGRATIONS, dataDir = mkdtempSync(join(tmpdir(), 'cp-orgs0r-')), key = parseSecretKey(generateSecretKey())) {
  const store = await Store.open({ dataDir, secretKey: key, migrations });
  return { store, dataDir, key };
}
const addAccount = (store: Store, id: string, role = 'admin', founder = 0) =>
  store
    .db!.prepare(
      "INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by, founder) VALUES (?, ?, ?, ?, ?, 'active', 'x', 'now', 'now', 'ui', ?)",
    )
    .run(id, `${id}@example.com`, `${id}@example.com`, id, role, founder);

test('M1: a token stops with its account: disabled, demoted, removed; the founder account’s too; the server code’s and older ones live on', async () => {
  const { store, dataDir } = await storeAt();
  try {
    const tokens = new PortalTokens(store);
    addAccount(store, 'u_Founder_0001', 'admin', 1);
    addAccount(store, 'u_Second_00001');
    addAccount(store, 'u_Gone_0000001');
    const mint = (label: string, ownerId: string, accountId: string | null) => tokens.create({ label, scope: 'admin' }, {}, { ownerId, accountId });
    const founder = mint('founder-laptop', FOUNDING_USER_ID, 'u_Founder_0001');
    const second = mint('second-script', 'u_Second_00001', 'u_Second_00001');
    const gone = mint('gone-script', 'u_Gone_0000001', 'u_Gone_0000001');
    const code = mint('server-code', FOUNDING_USER_ID, null);
    const ok = (s: { secret: string }) => tokens.verify(s.secret).ok;
    assert.deepEqual([founder, second, gone, code].map(ok), [true, true, true, true]);
    assert.equal(founder.token.ownerId, FOUNDING_USER_ID, 'the founder account’s token acts as u_owner');
    assert.equal(tokens.accountOf(founder.token.id), 'u_Founder_0001', '…and remembers the account');

    store.db!.prepare("UPDATE users SET state = 'disabled' WHERE id = 'u_Founder_0001'").run();
    store.db!.prepare("UPDATE users SET role = 'member' WHERE id = 'u_Second_00001'").run();
    store.db!.prepare("DELETE FROM users WHERE id = 'u_Gone_0000001'").run();
    assert.deepEqual([founder, second, gone, code].map(ok), [false, false, false, true], 'checked at use: disabled founder, demoted, removed; the server code’s lives on');
    assert.equal(accountStanding(store.db, null).userId, FOUNDING_USER_ID);

    // A revoke on disable makes it permanent: enabling the account again revives nothing.
    const ended = revokeAccountTokens(store.db!, 'u_Founder_0001', new Date().toISOString(), 'account disabled');
    assert.equal(ended.pmcp, 1);
    store.db!.prepare("UPDATE users SET state = 'active' WHERE id = 'u_Founder_0001'").run();
    assert.equal(ok(founder), false);
    assert.equal(tokens.get(founder.token.id)!.revokedReason, 'account disabled');
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('M1 at the seam: a token or an agent of an account that is gone acts for nobody once the portal’s users are installed', () => {
  const was = useAccountRoles((id) => (id === 'u_Admin_000001' ? 'admin' : null));
  try {
    const ref = { type: 'workspace', id: 'docker/api' } as const;
    const tok = (userId: string) => actorOfPrincipal({ kind: 'user', userId, tokenId: 'ptk', scope: 'admin', workspaceId: null, sessionId: null });
    const agent = (userId: string) => actorOfPrincipal({ kind: 'agent', userId, tokenId: 'agt', scope: 'agent', workspaceId: 'docker/api', sessionId: 'S1' });
    assert.equal(can(tok('u_Admin_000001'), 'manage', ref).allow, true);
    const gone = can(tok('u_Removed_0001'), 'view', ref);
    assert.equal(!gone.allow && gone.reason, 'actor_disabled');
    const goneAgent = can(agent('u_Removed_0001'), 'view', ref);
    assert.equal(!goneAgent.allow && goneAgent.reason, 'actor_disabled');
    assert.equal(can(tok(FOUNDING_USER_ID), 'manage', ref).allow, true, 'the founding user has no account row and needs none');
  } finally {
    useAccountRoles(was);
  }
});

test('M2: an agent acts as the account that started its session and stops with it', async () => {
  const { store, dataDir } = await storeAt();
  try {
    const alive = new Set(['S_admin', 'S_code']);
    const module = new PortalMcpModule(store, { registry: new ToolRegistry(), agentHost: { alive: (id) => alive.has(id), url: () => 'http://x/mcp' }, managerAlive: () => false });
    addAccount(store, 'u_Second_00001');
    const chat = new ChatStore(store);
    chat.create({ id: 'S_admin', workspaceId: 'docker/api', cwd: '/w', title: 'a', origin: 'ui', startedByAccount: 'u_Second_00001' });
    chat.create({ id: 'S_code', workspaceId: 'docker/api', cwd: '/w', title: 'b', origin: 'ui' });
    module.settings.update({ enabled: true });
    module.agents.setEnabled('docker/api', true);
    const a = (await module.agents.mint({ workspaceId: 'docker/api', sessionId: 'S_admin' }))!.env.PILOT_MCP_TOKEN!;
    const b = (await module.agents.mint({ workspaceId: 'docker/api', sessionId: 'S_code' }))!.env.PILOT_MCP_TOKEN!;
    const who = (secret: string) => {
      const v = module.agents.verify(secret);
      return v.ok ? actorOfPrincipal(v.principal) : v.reason;
    };
    const first = who(a);
    assert.equal(typeof first === 'object' && first.kind === 'agent' && first.userId, 'u_Second_00001');
    const second = who(b);
    assert.equal(typeof second === 'object' && second.kind === 'agent' && second.userId, FOUNDING_USER_ID, 'the server code’s session is the founding user’s');
    store.db!.prepare("UPDATE users SET role = 'member' WHERE id = 'u_Second_00001'").run();
    assert.equal(who(a), 'disabled', 'its starter was demoted: refused, and revoked');
    store.db!.prepare("UPDATE users SET role = 'admin' WHERE id = 'u_Second_00001'").run();
    assert.equal(who(a), 'revoked', 'promoting again revives nothing');
    assert.equal(typeof who(b), 'object');
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('M1 over HTTP: disabling, demoting or removing an account revokes what it minted and audits the count', async () => {
  process.env.PORTAL_PASSWORD_COST ??= 'test';
  const { store, dataDir } = await storeAt();
  const audit: { kind: string; detail?: Record<string, unknown> }[] = [];
  const platform = new Proxy({}, { get: (_t, p) => (p === 'audit' ? { record: (e: never) => void audit.push(e) } : p === 'then' ? undefined : stub) });
  const app = make(new Portal(CODE, 60_000), stub, store, stub, stub, stub, stub, stub, { serveWeb: false, poolService: stub, mcp: stub, skills: stub, platform });
  const call = (method: string, path: string, body?: unknown, cookie?: string) =>
    app.request(`http://localhost:3000${path}`, { method, headers: { ...H, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
  try {
    const code = /portal_session=[^;]+/.exec((await call('POST', '/api/login', { code: CODE })).headers.get('set-cookie') ?? '')![0];
    const tokens = new PortalTokens(store);
    const ids: Record<string, string> = {};
    for (const who of ['off', 'down', 'out']) {
      const r = await call('POST', '/api/admin/users', { email: `${who}@example.com`, password: PASSWORD, role: 'admin' }, code);
      ids[who] = ((await r.json()) as { data: { id: string } }).data.id;
    }
    const minted = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, tokens.create({ label: `${k}-token`, scope: 'operate' }, {}, { ownerId: id, accountId: id })]));
    assert.equal((await call('PATCH', `/api/admin/users/${ids.off}`, { state: 'disabled' }, code)).status, 200);
    assert.equal((await call('PATCH', `/api/admin/users/${ids.down}`, { role: 'member' }, code)).status, 200);
    assert.equal((await call('DELETE', `/api/admin/users/${ids.out}`, undefined, code)).status, 200);
    for (const k of ['off', 'down', 'out']) assert.ok(tokens.get(minted[k]!.token.id)!.revokedAt, `${k}: revoked`);
    const rows = audit.filter((r) => r.kind === 'account.tokens_revoked');
    assert.deepEqual(rows.map((r) => r.detail?.reason), ['account disabled', 'account demoted', 'account removed']);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('m1, m2, m8: 460-462 on an existing database through the real runner: tokens kept as the founding user’s; the founder and guarded links audited', async () => {
  const before = MIGRATIONS.filter((m) => m.version < 460 || m.version > 479);
  const first = await storeAt(before);
  const at = new Date().toISOString();
  const db = first.store.db!;
  const user = db.prepare(
    "INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, 'active', 'x', ?, ?, ?)",
  );
  user.run('u_Owner_Acct01', 'me@example.com', 'me@example.com', 'Me', 'admin', '2026-10-17T01:00:00.000Z', '2026-10-17T01:00:00.000Z', 'ui');
  user.run('u_Sso_Made0001', 'sso@example.com', 'sso@example.com', 'S', 'member', '2026-10-18T01:00:00.000Z', '2026-10-18T01:00:00.000Z', 'sso:sso_x');
  db.prepare("INSERT INTO sso_providers (id, name, issuer, client_id, domains, created_by, created_at, updated_at) VALUES ('sso_x', 'x', 'https://x.example', 'c', '[]', 'ui', ?, ?)").run(at, at);
  const link = db.prepare("INSERT INTO sso_identities (provider_id, subject, user_id, email, linked_at) VALUES ('sso_x', ?, ?, ?, ?)");
  link.run('sub-owner', 'u_Owner_Acct01', 'me@example.com', at);
  link.run('sub-sso', 'u_Sso_Made0001', 'sso@example.com', at);
  db.prepare("INSERT INTO pmcp_tokens (id, label, token_hash, last4, scope, created_at, expires_at) VALUES ('ptk_old', 'old', 'h1', 'abcd', 'admin', ?, ?)").run(at, at);
  db.prepare("INSERT INTO reporter_tokens (id, token_hash, bucket_key, origin, actor_user, actor_label, created_at, expires_at) VALUES ('rpt_ui', 'h2', 'B', 'https://a.example', 'ui', 'Owner', ?, ?)").run(at, at);
  first.store.close();

  const { store } = await storeAt(MIGRATIONS, first.dataDir, first.key);
  try {
    const d = store.db!;
    assert.ok(store.writable, 'the store opened and migrated');
    assert.equal((d.prepare("SELECT owner_id FROM pmcp_tokens WHERE id = 'ptk_old'").get() as { owner_id: string }).owner_id, FOUNDING_USER_ID);
    assert.equal((d.prepare("SELECT actor_user FROM reporter_tokens WHERE id = 'rpt_ui'").get() as { actor_user: string }).actor_user, FOUNDING_USER_ID);
    assert.equal((d.prepare("SELECT id FROM users WHERE founder = 1").get() as { id: string }).id, 'u_Owner_Acct01');
    const rows = d.prepare("SELECT kind, subject, detail FROM platform_audit WHERE actor = 'system:migration' ORDER BY id").all() as { kind: string; subject: string; detail: string }[];
    assert.deepEqual(
      rows.map((r) => [r.kind, r.subject, JSON.parse(r.detail).email]),
      [
        ['identity.founder_marked', 'user:u_Owner_Acct01', 'me@example.com'],
        ['identity.sso_link_guarded', 'user:u_Owner_Acct01', 'me@example.com'],
      ],
      'the founder named for the owner to confirm; only the guarded link flagged (the SSO-made member is not)',
    );
  } finally {
    store.close();
    rmSync(first.dataDir, { recursive: true, force: true });
  }
});
