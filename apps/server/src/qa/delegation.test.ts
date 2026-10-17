// Session delegation (owner, 2026-10-17): one session to one account at view or operate, through the delegate's own door, checked on
// every request; no grant reads as not found; view cannot act; operate can send, answer and stop that session only; revoke is immediate;
// the grant routes are the owner's (a member is refused them).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../app.js';
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
const H = { host: 'localhost:3000', origin: 'http://localhost:3000', 'content-type': 'application/json' };

/** The slice of the chat controller the delegate door uses, recording what it is asked to do. */
function fakeChat() {
  const calls: string[] = [];
  const sessions: Record<string, { id: string; title: string; state: string; workspaceId: string; waiting: number }> = {
    lead: { id: 'lead', title: 'Orchestrator', state: 'working', workspaceId: 'kubernetes/kohi-event', waiting: 1 },
    other: { id: 'other', title: 'Other', state: 'idle', workspaceId: 'kubernetes/kohi-event', waiting: 0 },
  };
  return {
    calls,
    resolve: (id: string) => id,
    get: (id: string) => sessions[id] ?? null,
    history: (id: string, after: number) => [{ seq: after + 1, kind: 'assistant', text: `hello from ${id}` }],
    historyPage: (id: string) => ({ items: [{ seq: 1, kind: 'user', text: `first in ${id}` }], more: false }),
    send: async (id: string, _uuid: string, text: string, o: { actor?: string }) => void calls.push(`send ${id} ${text} ${o.actor}`),
    respond: async (id: string, req: string, d: string, o: { actor?: string }) => void calls.push(`respond ${id} ${req} ${d} ${o.actor}`),
    control: async (id: string, op: string, _a: unknown, o: { actor?: string }) => void calls.push(`control ${id} ${op} ${o.actor}`),
  };
}

async function build() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-delegation-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const portal = new Portal(CODE, 60_000);
  const chat = fakeChat();
  const app = make(portal, stub, store, stub, stub, stub, stub, chat, { serveWeb: false, poolService: stub, mcp: stub, skills: stub });
  const call = (method: string, path: string, body?: unknown, cookie?: string) =>
    app.request(`http://localhost:3000${path}`, { method, headers: { ...H, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
  const cookieOf = (r: Response) => /portal_session=[^;]+/.exec(r.headers.get('set-cookie') ?? '')?.[0];
  return { call, cookieOf, chat, done: () => (store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}

test('a member sees only what is delegated; view reads; operate sends, answers and stops; revoke is immediate', async () => {
  const { call, cookieOf, chat, done } = await build();
  try {
    const admin = cookieOf(await call('POST', '/api/login', { code: CODE }))!;
    const u = ((await (await call('POST', '/api/admin/users', { email: 'd@example.com', password: PASSWORD }, admin)).json()) as { data: { id: string } }).data;
    const m = cookieOf(await call('POST', '/api/login', { email: 'd@example.com', password: PASSWORD }))!;
    const json = async (r: Response) => ((await r.json()) as { data: unknown }).data;

    // No grant: an empty list, and the session reads as not found (the same as one that does not exist).
    assert.deepEqual(await json(await call('GET', '/api/me/sessions', undefined, m)), []);
    assert.equal((await call('GET', '/api/me/sessions/lead', undefined, m)).status, 404);
    assert.equal((await call('GET', '/api/me/sessions/nope', undefined, m)).status, 404);
    // The grant routes are the owner's: a member is refused.
    assert.equal((await call('PUT', '/api/admin/session-grants/lead', { userId: u.id, level: 'operate' }, m)).status, 403);

    // View: list, read; never send, answer or stop.
    assert.equal((await call('PUT', '/api/admin/session-grants/lead', { userId: u.id, level: 'view' }, admin)).status, 200);
    const list = (await json(await call('GET', '/api/me/sessions', undefined, m))) as { id: string; level: string }[];
    assert.deepEqual(list.map((x) => [x.id, x.level]), [['lead', 'view']]);
    assert.equal((await call('GET', '/api/me/sessions/lead/events?after=4', undefined, m)).status, 200);
    assert.equal((await call('GET', '/api/me/sessions/other', undefined, m)).status, 404, 'another session of the same workspace: not found');
    for (const [path, body] of [['send', { text: 'hi' }], ['respond', { requestId: 'r1', decision: 'allow' }], ['stop', {}]] as const)
      assert.equal((await call('POST', `/api/me/sessions/lead/${path}`, body, m)).status, 403, `view cannot ${path}`);
    assert.deepEqual(chat.calls, []);

    // Operate: send, answer, stop: that session only, recorded as the account.
    assert.equal((await call('PUT', '/api/admin/session-grants/lead', { userId: u.id, level: 'operate' }, admin)).status, 200);
    assert.equal((await call('POST', '/api/me/sessions/lead/send', { text: 'please continue' }, m)).status, 200);
    assert.equal((await call('POST', '/api/me/sessions/lead/respond', { requestId: 'r1', decision: 'deny', note: 'no' }, m)).status, 200);
    assert.equal((await call('POST', '/api/me/sessions/lead/stop', {}, m)).status, 200);
    assert.equal((await call('POST', '/api/me/sessions/other/send', { text: 'x' }, m)).status, 404, 'operate on one session reaches no other');
    assert.deepEqual(chat.calls, [`send lead please continue account:${u.id}`, `respond lead r1 deny account:${u.id}`, `control lead stop account:${u.id}`]);
    assert.equal((await call('GET', '/api/workspaces', undefined, m)).status, 403, 'still no admin route');

    // Revoke: the next request is refused.
    assert.equal((await call('DELETE', `/api/admin/session-grants/lead/${u.id}`, undefined, admin)).status, 200);
    assert.equal((await call('GET', '/api/me/sessions/lead/events?after=0', undefined, m)).status, 404);
    assert.equal((await call('POST', '/api/me/sessions/lead/send', { text: 'x' }, m)).status, 404);
  } finally {
    done();
  }
});
