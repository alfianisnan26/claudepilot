// Relocation (owner request 2026-11-01, decommissioning the old shared workspaces): a session that is not running moves to another workspace
// and a Claude there, keeping its id, its row and its portal transcript; the rows that point at where it lives follow, the history stays.
// The platform admin only (anyone else: the 404 of a missing session); a running session is refused; a dry run changes nothing; running it
// twice is a no-op; an unknown workspace or Claude is refused; the bulk form decides each item on its own. Fixtures are built at runtime.

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { CHAT_API, FOUNDING_USER_ID, type Actor } from '@portal/contracts';
import { Hono } from 'hono';
import { clearResolvers, declaredPolicies } from '../authz/seam.js';
import { CHAT_RELOCATE_POLICIES } from './authz.js';
import { checkCwdMap, claudeConfigDir, claudeProjectSlug, mapPath, relocationCopies } from './relocate.js';
import { createSessionRelocateRoutes } from './relocateRoutes.js';
import { createChatRoutes } from './routes.js';
import { init, liveSession, until, vanish, type Live } from './testkit.js';

afterEach(() => clearResolvers());

const FROM = 'docker/ws1';
const TO = 'docker/ws2';
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (isAppError(e) ? e.code : String(e)));

/** The two route groups behind a stand-in for the sign-in guard: `actor` is who asks (the owner when absent). */
function app(s: Live, actor?: Actor) {
  const a = new Hono<{ Variables: { token: string; actor: Actor } }>();
  a.use(async (c, next) => {
    if (actor) c.set('actor', actor);
    else c.set('token', 'signed-in');
    await next();
  });
  a.onError((e, c) =>
    isAppError(e) ? c.json({ error: { code: e.code, message: e.message, details: e.details } }, e.status as 400) : c.json({ error: { code: 'INTERNAL', message: String(e) } }, 500),
  );
  a.route('/api/chat/sessions', createChatRoutes(s.controller));
  a.route('/api/workspaces', createSessionRelocateRoutes(s.controller));
  return a;
}
const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const raw = (s: Live) => s.store.db!;
const count = (s: Live, sql: string, ...args: string[]) => (raw(s).prepare(sql).get(...args) as { n: number }).n;
const audits = (s: Live, id: string) => count(s, "SELECT count(*) AS n FROM chat_audit WHERE kind = 'session.relocated' AND session_id = ?", id);
const eventsOf = (s: Live, id: string) => count(s, 'SELECT count(*) AS n FROM chat_events WHERE session_id = ?', id);
/** Where a session is, as the portal shows it. */
const place = (s: Live, id = s.id) => {
  const x = s.controller.get(id)!;
  return { workspaceId: x.workspaceId, claudeId: x.claudeId, cwd: x.cwd, state: x.state };
};
/** The Default Claude of the new workspace (made by the first read, as the Claudes list makes it). */
const destClaude = (s: Live) => s.controller.listClaudes(TO).find((c) => !c.directory)!.id;

/** A session that has ended, with a transcript and the rows that hang off it on the old workspace. */
async function endedWithRows(s: Live) {
  s.tail.push(init(s.id));
  await until(() => eventsOf(s, s.id) > 0);
  await s.controller.end(s.id);
  await until(() => s.controller.get(s.id)!.state === 'ended');
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const old = s.controller.get(s.id)!.claudeId;
  const db = raw(s);
  db.prepare('INSERT INTO pmcp_agent_tokens (id, token_hash, workspace_id, session_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    `t_${randomUUID()}`,
    randomBytes(16).toString('hex'),
    FROM,
    s.id,
    now,
    later,
  );
  db.prepare("INSERT INTO chat_worktrees (workspace_id, path, repo, branch, session_id, state, created_at) VALUES (?, ?, ?, ?, ?, 'kept', ?)").run(
    FROM,
    '/home/node/work/app-wt',
    '/home/node/work/app',
    'feat/x',
    s.id,
    now,
  );
  db.prepare("INSERT INTO autotransfer_sessions (session_id, mode, last_claude_id) VALUES (?, 'ask', ?)").run(s.id, old);
  db.prepare(
    "INSERT INTO autotransfer_suggestions (id, session_id, at, reason, from_claude, to_claude, facts, handoff, dropped, state) VALUES (?, ?, ?, 'low', ?, 'other', '{}', 'skip', '{}', 'open')",
  ).run(randomUUID(), s.id, now, old);
  return { old, events: eventsOf(s, s.id) };
}

/* ---------- Pure ---------- */

test('mapPath rewrites the longest whole-segment prefix; checkCwdMap takes absolute folders only', () => {
  const map = { '/home/node/a': '/home/node/b', '/home/node/a/deep': '/srv/x' };
  assert.equal(mapPath('/home/node/a', map), '/home/node/b');
  assert.equal(mapPath('/home/node/a/src', map), '/home/node/b/src');
  assert.equal(mapPath('/home/node/a/deep/y', map), '/srv/x/y');
  assert.equal(mapPath('/home/node/ab', map), '/home/node/ab', 'never half a segment');
  assert.equal(mapPath('work/rel', map), 'work/rel');
  assert.equal(mapPath('/x', undefined), '/x');
  assert.deepEqual(checkCwdMap({ '/a/': '/b' }), { '/a': '/b' });
  assert.equal(checkCwdMap(undefined), undefined);
  for (const bad of [[], 'x', { a: '/b' }, { '/a': 'b' }, { '/a/../etc': '/b' }, { '/a': 5 }, Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`/p${i}`, '/q']))])
    assert.throws(() => checkCwdMap(bad), (e: unknown) => isAppError(e) && e.code === 'VALIDATION_FAILED', JSON.stringify(bad).slice(0, 40));
});

test('the copies name Claude Code’s transcript under each Claude’s config directory and the folder it runs in', () => {
  assert.equal(claudeProjectSlug('/home/node/work/my.app_1'), '-home-node-work-my-app-1');
  assert.equal(claudeConfigDir(''), '/home/node/.claude');
  assert.equal(claudeConfigDir('claudes/0123456789abcdef'), '/home/node/.claudepilot/claudes/0123456789abcdef');
  assert.equal(claudeConfigDir('claudes/../../etc'), '/home/node/.claude', 'a directory that is not a Claude’s is never used');
  const copies = relocationCopies({
    sessionId: 's1',
    claudeSessionId: 'c1',
    fromConfigDir: '/home/node/.claude',
    toConfigDir: '/home/node/.claudepilot/claudes/0123456789abcdef',
    fromCwd: '/home/node/work/a',
    toCwd: '/home/node/work/a',
  });
  assert.deepEqual(copies[0], {
    from: '/home/node/.claude/projects/-home-node-work-a/c1.jsonl',
    to: '/home/node/.claudepilot/claudes/0123456789abcdef/projects/-home-node-work-a/c1.jsonl',
    required: true,
    dir: false,
    why: copies[0]!.why,
  });
  assert.deepEqual(
    copies.filter((c) => !c.required).map((c) => c.from),
    ['/home/node/.claude/projects/-home-node-work-a/c1', '/home/node/.claudepilot/sessions/c1', '/home/node/.claudepilot/uploads/s1'],
  );
});

test('both routes are declared as the platform admin’s, with their audit action, and are mounted where the contract says', async () => {
  const s = await liveSession();
  try {
    const a = app(s);
    for (const [key, policy] of Object.entries(CHAT_RELOCATE_POLICIES)) {
      assert.deepEqual(declaredPolicies().get(key as never), policy, key);
      assert.deepEqual([policy.kind, policy.area, policy.verb, policy.audit], ['platform', 'system', 'manage', 'session.relocated'], key);
    }
    const mounted = new Set(a.routes.filter((r) => r.method === 'POST').map((r) => `POST ${r.path}`));
    for (const key of Object.keys(CHAT_RELOCATE_POLICIES)) assert.ok(mounted.has(key), `${key} is mounted`);
    assert.equal(CHAT_API.relocate('a b'), '/api/chat/sessions/a%20b/relocate');
    assert.equal(CHAT_API.relocateSessions('docker/ws1'), '/api/workspaces/docker/ws1/relocate-sessions');
  } finally {
    await s.done();
  }
});

/* ---------- Who ---------- */

test('anyone but the platform admin gets the 404 of a missing session, on both routes, and nothing changes', async () => {
  const s = await liveSession();
  try {
    await endedWithRows(s);
    const dest = destClaude(s);
    const before = place(s);
    const others: Actor[] = [
      { kind: 'user', userId: 'u_a', loginSessionId: 'x', via: 'ui' } as Actor,
      { kind: 'agent', userId: FOUNDING_USER_ID, tokenId: 't1', sessionId: s.id, workspaceId: FROM } as Actor,
      { kind: 'token', userId: FOUNDING_USER_ID, tokenId: 't2', scope: 'operate' } as Actor,
    ];
    for (const actor of others) {
      const a = app(s, actor);
      const one = await a.request(CHAT_API.relocate(s.id), post({ workspaceId: TO, claudeId: dest }));
      const bulk = await a.request(CHAT_API.relocateSessions(FROM), post({ plan: [{ sessionId: s.id, workspaceId: TO, claudeId: dest }] }));
      const missing = await a.request(CHAT_API.relocate('nope'), post({ workspaceId: TO, claudeId: dest }));
      for (const res of [one, bulk, missing]) {
        assert.equal(res.status, 404, actor.kind);
        const err = ((await res.json()) as { error: { code: string; message: string } }).error;
        assert.deepEqual([err.code, err.message], ['NOT_FOUND', 'No such session.']);
      }
    }
    assert.deepEqual(place(s), before);
    assert.equal(audits(s, s.id), 0);
  } finally {
    await s.done();
  }
});

/* ---------- When ---------- */

test('a running session is refused (409, reason running) and nothing changes; once its process is gone it may move', async () => {
  const s = await liveSession();
  try {
    const dest = destClaude(s);
    const before = place(s);
    assert.equal(before.state, 'idle');
    const res = await app(s).request(CHAT_API.relocate(s.id), post({ workspaceId: TO, claudeId: dest }));
    assert.equal(res.status, 409);
    const err = ((await res.json()) as { error: { code: string; details: { reason: string } } }).error;
    assert.deepEqual([err.code, err.details.reason], ['CONFLICT', 'running']);
    assert.deepEqual(place(s), before);
    assert.equal(audits(s, s.id), 0);
    // Interrupted with no process (idle, nothing running): it may move.
    await vanish(s);
    const moved = await s.controller.relocate(s.id, { workspaceId: TO, claudeId: dest }, { actor: 'ui' });
    assert.equal(moved.status, 'relocated');
    assert.equal(s.controller.get(s.id)!.workspaceId, TO);
  } finally {
    await s.done();
  }
});

/* ---------- What ---------- */

test('a dry run decides and counts exactly, and changes nothing', async () => {
  const s = await liveSession();
  try {
    await endedWithRows(s);
    const dest = destClaude(s);
    const before = place(s);
    const snapshot = () =>
      JSON.stringify([
        raw(s).prepare('SELECT * FROM chat_sessions WHERE id = ?').get(s.id),
        raw(s).prepare('SELECT * FROM chat_segments WHERE session_id = ?').all(s.id),
        raw(s).prepare('SELECT * FROM chat_worktrees WHERE session_id = ?').all(s.id),
        raw(s).prepare('SELECT revoked_at FROM pmcp_agent_tokens WHERE session_id = ?').all(s.id),
        raw(s).prepare('SELECT * FROM autotransfer_sessions WHERE session_id = ?').all(s.id),
        raw(s).prepare('SELECT state FROM autotransfer_suggestions WHERE session_id = ?').all(s.id),
        raw(s).prepare('SELECT count(*) AS n FROM chat_audit').get(),
      ]);
    const was = snapshot();
    const res = await app(s).request(CHAT_API.relocate(s.id), post({ workspaceId: TO, claudeId: dest, dryRun: true }));
    assert.equal(res.status, 200);
    const r = ((await res.json()) as { data: import('@portal/contracts').ChatRelocation }).data;
    assert.equal(r.status, 'would_relocate');
    assert.deepEqual(r.counts, { session: 1, openRun: r.counts!.openRun, worktrees: 1, tokensRevoked: 1, autotransfer: 2 });
    assert.deepEqual([r.from?.workspaceId, r.to?.workspaceId, r.to?.claudeId], [FROM, TO, dest]);
    assert.equal(snapshot(), was, 'not a row changed');
    assert.deepEqual(place(s), before);
    // The bulk form's dry run too.
    const bulk = await app(s).request(CHAT_API.relocateSessions(FROM), post({ plan: [{ sessionId: s.id, workspaceId: TO, claudeId: dest }], dryRun: true }));
    const b = ((await bulk.json()) as { data: import('@portal/contracts').RelocateSessionsResult }).data;
    assert.deepEqual([b.dryRun, b.items.map((i) => i.status)], [true, ['would_relocate']]);
    assert.equal(snapshot(), was);
  } finally {
    await s.done();
  }
});

test('a relocated session lists under the new workspace, keeps its id and messages, its rows follow, the history stays, one audit row; twice is a no-op', async () => {
  const s = await liveSession();
  try {
    const { old, events } = await endedWithRows(s);
    const dest = destClaude(s);
    assert.notEqual(dest, old);
    const usageBefore = count(s, 'SELECT count(*) AS n FROM chat_usage WHERE session_id = ?', s.id);
    const res = await app(s).request(CHAT_API.relocate(s.id), post({ workspaceId: TO, claudeId: dest }));
    assert.equal(res.status, 200);
    const r = ((await res.json()) as { data: import('@portal/contracts').ChatRelocation }).data;
    assert.equal(r.status, 'relocated');
    assert.equal(r.files?.claudeSessionId, s.controller.get(s.id)!.claudeSessionId);
    assert.ok(r.files!.copies.some((c) => c.required && c.from.endsWith(`/${r.files!.claudeSessionId}.jsonl`)));

    // The session: same id, new place, same transcript.
    const now = s.controller.get(s.id)!;
    assert.deepEqual([now.id, now.workspaceId, now.claudeId, now.state], [s.id, TO, dest, 'ended']);
    assert.equal(eventsOf(s, s.id), events);
    assert.ok(s.controller.listPage({ workspaceId: TO }, {}).items.some((x) => x.id === s.id), 'listed under the new workspace');
    assert.ok(!s.controller.listPage({ workspaceId: FROM }, {}).items.some((x) => x.id === s.id), 'gone from the old one');

    // The rows that point at where it lives.
    assert.deepEqual((raw(s).prepare('SELECT workspace_id AS w FROM chat_worktrees WHERE session_id = ?').all(s.id) as { w: string }[]).map((r) => r.w), [TO]);
    assert.equal(count(s, 'SELECT count(*) AS n FROM pmcp_agent_tokens WHERE session_id = ? AND revoked_at IS NULL', s.id), 0, 'its old token is revoked');
    assert.equal((raw(s).prepare('SELECT last_claude_id AS c FROM autotransfer_sessions WHERE session_id = ?').get(s.id) as { c: string }).c, dest);
    assert.equal((raw(s).prepare('SELECT state FROM autotransfer_suggestions WHERE session_id = ?').get(s.id) as { state: string }).state, 'superseded');
    const open = raw(s).prepare('SELECT claude_id AS c FROM chat_segments WHERE session_id = ? AND ended_at IS NULL').all(s.id) as { c: string }[];
    for (const seg of open) assert.equal(seg.c, dest, 'the run going now names the new Claude');
    // History stays as it ran.
    assert.equal(count(s, 'SELECT count(*) AS n FROM chat_usage WHERE session_id = ?', s.id), usageBefore);

    // One audit row, on the new workspace, with both places.
    const audit = s.controller.audit({ kind: 'session.relocated', sessionId: s.id });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.workspaceId, TO);
    assert.equal(audit[0]!.actor, 'ui');
    assert.deepEqual([(audit[0]!.detail.from as { workspaceId: string }).workspaceId, (audit[0]!.detail.to as { workspaceId: string }).workspaceId], [FROM, TO]);

    // Twice: nothing written, no second audit row.
    const again = await s.controller.relocate(s.id, { workspaceId: TO, claudeId: dest }, { actor: 'ui' });
    assert.deepEqual([again.status, again.counts], ['unchanged', null]);
    assert.equal(audits(s, s.id), 1);
  } finally {
    await s.done();
  }
});

test('an unknown or removed target workspace, a Claude of another workspace, a missing Claude: refused, nothing changes', async () => {
  const s = await liveSession();
  try {
    await endedWithRows(s);
    const dest = destClaude(s);
    const own = s.controller.get(s.id)!.claudeId;
    s.controller.workspaceExists = async (id) => id !== 'docker/gone';
    const before = place(s);
    for (const [workspaceId, claudeId] of [
      ['docker/gone', dest],
      ['nowhere/ws2', dest],
      ['docker/x/y', dest],
      ['', dest],
      ['kubernetes/general-manager', dest],
      [TO, own],
      [TO, 'no-such-claude'],
      [TO, ''],
    ] as const) {
      assert.equal(await codeOf(s.controller.relocate(s.id, { workspaceId, claudeId }, { actor: 'ui' })), 'VALIDATION_FAILED', `${workspaceId} ${claudeId}`);
    }
    assert.equal(await codeOf(s.controller.relocate('nope', { workspaceId: TO, claudeId: dest }, { actor: 'ui' })), 'NOT_FOUND');
    assert.deepEqual(place(s), before);
    assert.equal(audits(s, s.id), 0);
  } finally {
    await s.done();
  }
});

test('a cwdMap rewrites the folder (and the copies follow it); the bulk form decides each item on its own and refuses one not on this workspace', async () => {
  const s = await liveSession({}, false, { cwd: '/home/node/work/app' });
  try {
    await endedWithRows(s);
    const dest = destClaude(s);
    // Another session, on another workspace: not this plan's to move.
    const elsewhere = (await s.controller.create({ workspaceId: 'docker/ws3' })).id;
    const res = await app(s).request(
      CHAT_API.relocateSessions(FROM),
      post({
        plan: [
          { sessionId: s.id, workspaceId: TO, claudeId: dest },
          { sessionId: elsewhere, workspaceId: TO, claudeId: dest },
        ],
        cwdMap: { '/home/node/work': '/home/node/projects' },
      }),
    );
    assert.equal(res.status, 200);
    const b = ((await res.json()) as { data: import('@portal/contracts').RelocateSessionsResult }).data;
    assert.deepEqual(
      b.items.map((i) => [i.sessionId, i.status, i.error?.code]),
      [
        [s.id, 'relocated', undefined],
        [elsewhere, 'refused', 'NOT_FOUND'],
      ],
    );
    assert.equal(s.controller.get(s.id)!.cwd, '/home/node/projects/app');
    assert.equal(s.controller.get(elsewhere)!.workspaceId, 'docker/ws3');
    const copy = b.items[0]!.files!.copies[0]!;
    assert.ok(copy.from.includes('/projects/-home-node-work-app/') && copy.to.includes('/projects/-home-node-projects-app/'), JSON.stringify(copy));
    // A plan is checked whole first: a session named twice changes nothing.
    const twice = await app(s).request(
      CHAT_API.relocateSessions(TO),
      post({ plan: [{ sessionId: s.id, workspaceId: FROM, claudeId: dest }, { sessionId: s.id, workspaceId: FROM, claudeId: dest }] }),
    );
    assert.equal(twice.status, 422);
    assert.equal(s.controller.get(s.id)!.workspaceId, TO);
  } finally {
    await s.done();
  }
});
