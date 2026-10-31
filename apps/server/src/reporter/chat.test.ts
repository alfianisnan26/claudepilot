// Chat in the widget (PILOT-1111): the panel reads and writes only sessions of its token's bucket, sees less than the portal shows the owner
// (redacted text, tool calls as one line, no sub-agent lines, no tool output), and sends as the token's person, rate limited.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { REPORTER_LIMITS, REPORTER_ROUTES, type ReporterChatPage } from '@portal/contracts';
import { toChatMessage, toolLine } from './chat.js';
import { UI } from '../tickets/testkit.js';
import { build, capture, PORTAL, reporterHarness } from './testkit.js';

type Json = { data?: unknown; error?: { code: string; message: string } };
const body = async (r: Response) => (await r.json()) as Json;
const page = async (r: Response) => (await body(r)).data as ReporterChatPage;
// A credential-shaped string, made at runtime (never a literal in the repo).
const secretish = () => ['sk', 'ant', 'api03', 'Q'.repeat(40)].join('-');

async function withTarget() {
  const h = await reporterHarness();
  h.chat.add('lead1', 'idle', { title: 'Konfersi lead' });
  h.service.updateConfig('KONF', { sessionTargets: [{ sessionId: 'lead1', label: 'Lead' }] }, 't');
  return h;
}

test('the route table names the chat routes, and each is declared for the seam', () => {
  assert.equal(REPORTER_ROUTES.sessionMessages, '/reporter/v1/sessions/:id/messages');
  assert.equal(REPORTER_ROUTES.sessionStream, '/reporter/v1/sessions/:id/stream');
  assert.equal(REPORTER_ROUTES.sessionBlob, '/reporter/v1/sessions/:id/blobs/:blobId');
});

test('a direct-report target, a session on a bucket ticket and one in the default workspace are readable; others are the same 404', async () => {
  const h = await withTarget();
  try {
    const ctx = h.service.verify(h.mint().token)!;
    const t = h.mint().token;
    // On a KONF ticket.
    const key = h.service.createTicket(ctx, { summary: 'on a ticket', captures: [capture()], build: build(), sdkVersion: '1' }, PORTAL).key;
    h.chat.add('onticket', 'working', { ticketId: h.tickets.resolve({ kind: 'system' }, key)! });
    // In the default workspace.
    h.store.db!.prepare('UPDATE ticket_buckets SET default_workspace_id = ? WHERE key = ?').run('docker/konf-ws', 'KONF');
    h.chat.add('inws', 'idle', { workspaceId: 'docker/konf-ws' });
    // Neither: another workspace, and a session on a ticket of another bucket.
    h.chat.add('stranger', 'idle', { workspaceId: 'docker/elsewhere' });
    const other = h.tickets.create(UI, { bucket: 'OTHER', summary: 'not yours' });
    h.chat.add('otherbucket', 'idle', { workspaceId: 'docker/elsewhere', ticketId: other.id });

    for (const id of ['lead1', 'onticket', 'inws']) assert.equal((await h.call(`/reporter/v1/sessions/${id}/messages`, { token: t })).status, 200, id);
    const onTicket = await page(await h.call('/reporter/v1/sessions/onticket/messages', { token: t }));
    assert.equal(onTicket.session.ticketKey, key, 'the ticket it works on is named');
    for (const id of ['stranger', 'otherbucket', 'nosuch', 'bad%20id'])
      for (const path of [`/reporter/v1/sessions/${id}/messages`, `/reporter/v1/sessions/${id}/stream`, `/reporter/v1/sessions/${id}/blobs/${'a'.repeat(64)}`]) {
        const r = await h.call(path, { token: t });
        assert.equal(r.status, 404, `${path} is not found`);
      }
    const send = await h.postJson('/reporter/v1/sessions/stranger/messages', t, { uuid: randomUUID(), text: 'hi' });
    assert.equal(send.status, 404, 'sending to a foreign session is the same 404');
    assert.equal(h.chat.sent.length, 0);
    assert.equal((await h.call('/reporter/v1/sessions/lead1/messages')).status, 401, 'no token');
  } finally {
    h.done();
  }
});

test('a page shows text redacted, tool calls as one line, and leaves out sub-agent lines, tool output and thinking', async () => {
  const h = await withTarget();
  try {
    const t = h.mint().token;
    h.chat.push('lead1', { kind: 'user', text: 'Why is the hero cut off?' });
    h.chat.push('lead1', { kind: 'thinking', text: 'private reasoning' });
    h.chat.push('lead1', { kind: 'tool_use', toolName: 'Bash', toolInput: { command: `grep -rn hero src\n  && echo ${secretish()}` } });
    h.chat.push('lead1', { kind: 'tool_result', text: 'src/hero.tsx:12: <h1>' });
    h.chat.push('lead1', { kind: 'assistant', text: 'Sub-agent work', agentLabel: 'explorer' });
    h.chat.push('lead1', { kind: 'assistant', text: `Found it. The key ${secretish()} should not show.` });
    h.chat.push('lead1', { kind: 'user', text: 'From a ticket', actor: 'ticket:T-1', actorLabel: 'UI report KONF-1' });
    const p = await page(await h.call('/reporter/v1/sessions/lead1/messages', { token: t }));
    assert.deepEqual(
      p.items.map((m) => m.kind),
      ['user', 'tool', 'assistant', 'user'],
    );
    const all = JSON.stringify(p);
    assert.ok(!all.includes(secretish()), 'nothing credential-shaped leaves');
    assert.ok(!all.includes('private reasoning') && !all.includes('Sub-agent work') && !all.includes('src/hero.tsx:12'), 'thinking, sub-agents and tool output are left out');
    const tool = p.items[1]!;
    assert.equal(tool.tool, 'Bash');
    assert.ok(!tool.text.includes('\n') && tool.text.length <= 120, 'one short line');
    assert.equal(p.items[3]!.from, 'UI report KONF-1');
    assert.equal(p.session.title, 'Konfersi lead');
    assert.equal(p.session.lastSeq, 7);
  } finally {
    h.done();
  }
});

test('paging: the newest first, older by the `before` cursor, newer with `after`', async () => {
  const h = await withTarget();
  try {
    const t = h.mint().token;
    for (let i = 1; i <= 30; i++) h.chat.push('lead1', { kind: i % 2 ? 'user' : 'assistant', text: `m${i}` });
    const first = await page(await h.call('/reporter/v1/sessions/lead1/messages?limit=5', { token: t }));
    assert.deepEqual(first.items.map((m) => m.text), ['m21', 'm22', 'm23', 'm24', 'm25', 'm26', 'm27', 'm28', 'm29', 'm30'].slice(-first.items.length));
    assert.ok(first.before !== null);
    const older = await page(await h.call(`/reporter/v1/sessions/lead1/messages?limit=5&before=${first.before}`, { token: t }));
    assert.ok(older.items.at(-1)!.seq < first.items[0]!.seq, 'strictly older');
    const newer = await page(await h.call('/reporter/v1/sessions/lead1/messages?after=28', { token: t }));
    assert.deepEqual(newer.items.map((m) => m.text), ['m29', 'm30']);
  } finally {
    h.done();
  }
});

test('send: as the token’s person through the reporter, with an optional image; ended refused; rate limited per token', async () => {
  const h = await withTarget();
  try {
    const t = h.mint().token;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
    const r = await h.postJson('/reporter/v1/sessions/lead1/messages', t, { uuid: randomUUID(), text: '  Please look at this  ', image: { mediaType: 'image/png', dataBase64: png } });
    assert.equal(r.status, 201);
    const sent = h.chat.sent[0]!;
    assert.equal(sent.text, 'Please look at this');
    assert.match(sent.opts.actor, /^portal-mcp:/);
    assert.match(sent.opts.actorLabel, /reporter, https:\/\/stg\.konfersi\.com/);
    assert.equal((sent.opts.attachments as { mediaType: string }[])[0]!.mediaType, 'image/png');

    assert.equal((await h.postJson('/reporter/v1/sessions/lead1/messages', t, { uuid: 'nope', text: 'x' })).status, 422, 'a uuid is required');
    assert.equal((await h.postJson('/reporter/v1/sessions/lead1/messages', t, { uuid: randomUUID(), text: '   ' })).status, 422, 'empty text');
    assert.equal((await h.postJson('/reporter/v1/sessions/lead1/messages', t, { uuid: randomUUID(), text: 'x', image: { mediaType: 'image/svg+xml', dataBase64: png } })).status, 422, 'images only');

    // Every attempt counts, the three refused above too (a bad request is not free): 4 used so far.
    for (let i = 4; i < REPORTER_LIMITS.chatMessagesPer10Min; i++) assert.equal((await h.postJson('/reporter/v1/sessions/lead1/messages', t, { uuid: randomUUID(), text: `n${i}` })).status, 201);
    const over = await h.postJson('/reporter/v1/sessions/lead1/messages', t, { uuid: randomUUID(), text: 'one more' });
    assert.equal(over.status, 429);

    const t2 = h.mint().token;
    h.chat.sessions.get('lead1')!.state = 'ended';
    assert.equal((await h.postJson('/reporter/v1/sessions/lead1/messages', t2, { uuid: randomUUID(), text: 'late' })).status, 409, 'an ended session refuses');
  } finally {
    h.done();
  }
});

test('blobs: an image a line links is served; anything else is the same 404', async () => {
  const h = await withTarget();
  try {
    const t = h.mint().token;
    const dir = mkdtempSync(join(tmpdir(), 'rpt-chat-'));
    const img = join(dir, 'a.png');
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const txt = join(dir, 'a.txt');
    writeFileSync(txt, 'plain');
    const imgId = 'a'.repeat(64);
    const txtId = 'b'.repeat(64);
    h.chat.blobs.set(imgId, { path: img, mediaType: 'image/png', size: 4 });
    h.chat.blobs.set(txtId, { path: txt, mediaType: 'text/plain', size: 5 });
    const ok = await h.call(`/reporter/v1/sessions/lead1/blobs/${imgId}`, { token: t });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.match(ok.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal((await h.call(`/reporter/v1/sessions/lead1/blobs/${txtId}`, { token: t })).status, 404, 'not an image');
  } finally {
    h.done();
  }
});

test('the live stream answers hello with the session state first', async () => {
  const h = await withTarget();
  try {
    const t = h.mint().token;
    const r = await h.call('/reporter/v1/sessions/lead1/stream', { token: t });
    assert.equal(r.status, 200);
    const reader = r.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const line = JSON.parse(new TextDecoder().decode(value).split('\n')[0]!) as { type: string; session: { id: string } };
    assert.equal(line.type, 'hello');
    assert.equal(line.session.id, 'lead1');
  } finally {
    h.done();
  }
});

test('toChatMessage: approvals become a line, images keep their size, an unknown sender is never named by its raw id', () => {
  const url = (b: string) => `/blob/${b}`;
  const a = toChatMessage({ seq: 1, at: 'x', kind: 'request', request: { requestId: 'r', kind: 'tool', toolName: 'Bash', agentLabel: null, title: 'Run a command', detail: 'npm test' } as never }, url)!;
  assert.equal(a.kind, 'approval');
  assert.equal(a.text, 'Run a command: npm test');
  const u = toChatMessage({ seq: 2, at: 'x', kind: 'user', text: 'hi', actor: 'session:abc', images: [{ blobId: 'f'.repeat(64), mediaType: 'image/png', width: 10, height: 20 }] }, url)!;
  assert.equal(u.from, 'Another session');
  assert.deepEqual(u.images[0], { url: `/blob/${'f'.repeat(64)}`, mediaType: 'image/png', width: 10, height: 20 });
  assert.equal(toChatMessage({ seq: 3, at: 'x', kind: 'result' }, url), null);
  assert.equal(toolLine({ file_path: '/src/a.ts' }), '/src/a.ts');
  assert.equal(toolLine(undefined), '');
});

test('toChatMessage: a tool result says only whether it failed, joined to its call by id; the output never leaves, an error is one redacted line', () => {
  const url = (b: string) => `/blob/${b}`;
  const c = toChatMessage({ seq: 1, at: 'x', kind: 'tool_use', toolName: 'Bash', toolUseId: 'call-1', toolInput: { command: 'npm test' } }, url)!;
  assert.equal(c.toolId, 'call-1');
  const ok = toChatMessage({ seq: 2, at: 'x', kind: 'tool_result', toolUseId: 'call-1', text: 'all 12 tests passed\nsrc/secret-output.ts' }, url)!;
  assert.deepEqual({ kind: ok.kind, ok: ok.ok, text: ok.text, toolId: ok.toolId }, { kind: 'tool_result', ok: true, text: '', toolId: 'call-1' }, 'no output');
  const failed = toChatMessage({ seq: 3, at: 'x', kind: 'tool_result', toolUseId: 'call-1', isError: true, text: `\n  exit 1: token ${secretish()} rejected\nline two of the output` }, url)!;
  assert.equal(failed.ok, false);
  assert.ok(failed.text.startsWith('exit 1: token'), failed.text);
  assert.ok(!failed.text.includes(secretish()), 'redacted');
  assert.ok(!failed.text.includes('line two') && failed.text.length <= 160, 'one short line');
  assert.equal(toChatMessage({ seq: 4, at: 'x', kind: 'tool_result', toolUseId: 'call-1', isError: true, text: '' }, url)!.text, 'Failed');
  assert.equal(toChatMessage({ seq: 5, at: 'x', kind: 'tool_result', text: 'no id' }, url), null, 'a result without its call id cannot be joined: left out');
  assert.equal(toChatMessage({ seq: 6, at: 'x', kind: 'tool_result', toolUseId: 'c', agentLabel: 'explorer' }, url), null, 'a sub-agent’s result stays out');
});
