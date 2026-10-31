// Chat in the widget (PILOT-1111): the panel reads and writes only sessions of its token's bucket, sees less than the portal shows the owner
// (redacted text, tool calls as one line, no sub-agent lines, no tool output), and sends as the token's person, rate limited.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { REPORTER_LIMITS, REPORTER_ROUTES, type ReporterChatPage } from '@portal/contracts';
import { planOf, toChatMessage, toolLine } from './chat.js';
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
  const failed = toChatMessage({ seq: 3, at: 'x', kind: 'tool_result', toolUseId: 'call-1', isError: true, text: `\n  exit 1: token ${secretish()} rejected\n\nls: cannot access x\nline three of the output` }, url)!;
  assert.equal(failed.ok, false);
  assert.ok(failed.text.startsWith('exit 1: token'), failed.text);
  assert.ok(!failed.text.includes(secretish()), 'redacted');
  assert.ok(failed.text.endsWith(' · ls: cannot access x'), `the first two lines that say something: ${failed.text}`);
  assert.ok(!failed.text.includes('line three') && failed.text.length <= 160, 'one short line');
  assert.equal(toChatMessage({ seq: 4, at: 'x', kind: 'tool_result', toolUseId: 'call-1', isError: true, text: '' }, url)!.text, 'Failed');
  assert.equal(toChatMessage({ seq: 5, at: 'x', kind: 'tool_result', text: 'no id' }, url), null, 'a result without its call id cannot be joined: left out');
  assert.equal(toChatMessage({ seq: 6, at: 'x', kind: 'tool_result', toolUseId: 'c', agentLabel: 'explorer' }, url), null, 'a sub-agent’s result stays out');
});

test('the chat state carries the session runtime the portal header shows (model, effort, mode, Claude by name, context, cost, plan windows), never an email or credential', async () => {
  const resets = new Date(Date.now() + 3 * 3600_000).toISOString();
  const plans: string[] = [];
  const h = await reporterHarness({
    claudePlan: (id) => {
      plans.push(id);
      return id === 'work' ? { session: { usedPct: 42, resetsAt: resets }, week: { usedPct: 12.5, resetsAt: null } } : null;
    },
  });
  try {
    const email = ['alfian', 'example.com'].join('@');
    h.chat.add('lead1', 'working', {
      title: 'Konfersi lead',
      model: 'claude-opus-5-5',
      effort: 'high',
      mode: 'acceptEdits',
      context: { usedTokens: 84_000, windowTokens: 200_000 },
      costUsd: 1.25,
      claudeId: 'work',
      claudeName: `Work ${email} ${secretish()}`,
    });
    h.service.updateConfig('KONF', { sessionTargets: [{ sessionId: 'lead1', label: 'Lead' }] }, 't');
    const p = await page(await h.call('/reporter/v1/sessions/lead1/messages', { token: h.mint().token }));
    const r = p.session.runtime!;
    assert.deepEqual(
      { model: r.model, effort: r.effort, mode: r.mode, context: r.context, costUsd: r.costUsd, plan: r.plan },
      { model: 'claude-opus-5-5', effort: 'high', mode: 'acceptEdits', context: { usedTokens: 84_000, windowTokens: 200_000 }, costUsd: 1.25, plan: { session: { usedPct: 42, resetsAt: resets }, week: { usedPct: 12.5, resetsAt: null } } },
    );
    assert.match(r.claude!, /^Work /, 'the Claude by its portal name');
    const all = JSON.stringify(p);
    assert.ok(!all.includes(email) && !all.includes(secretish()), 'no email or credential-shaped text in the runtime');
    assert.ok(!/claudeId|"work"/.test(JSON.stringify(r)), 'not the Claude id either');
    assert.deepEqual(plans.at(-1), 'work');

    // A session with nothing reported yet: every field says so (null), never a made-up number.
    h.chat.add('bare', 'idle', { workspaceId: 'docker/konf' });
    h.service.updateConfig('KONF', { sessionTargets: [{ sessionId: 'lead1', label: 'Lead' }, { sessionId: 'bare', label: 'Bare' }] }, 't');
    const b = (await page(await h.call('/reporter/v1/sessions/bare/messages', { token: h.mint().token }))).session.runtime!;
    assert.deepEqual(b, { model: null, effort: null, mode: null, claude: null, context: null, costUsd: null, plan: null });
  } finally {
    h.done();
  }
});

test('planOf: the usage snapshot’s session and week windows as they stand; no plan reading is null (unavailable), never 0 %', () => {
  const w = (key: string, usedPct: number | null, resetsAt: string | null = null) => ({ key, label: key, usedPct, resetsAt, level: 'ok' as const });
  assert.deepEqual(planOf({ runsOn: 'plan', unavailable: null, windows: [w('session', 30, 'r1'), w('week', 70, 'r2'), w('week_opus', 90)] }), {
    session: { usedPct: 30, resetsAt: 'r1' },
    week: { usedPct: 70, resetsAt: 'r2' },
  });
  assert.equal(planOf({ runsOn: 'plan', unavailable: 'signed_out' as never, windows: [w('session', 0)] }), null);
  assert.equal(planOf({ runsOn: 'key', unavailable: null, windows: [] }), null);
  assert.equal(planOf(null), null);
  assert.deepEqual(planOf({ runsOn: 'plan', unavailable: null, windows: [w('session', null)] }), { session: { usedPct: null, resetsAt: null }, week: null });
});

test('toChatMessage: a call whose input has no field the panel reads falls back to the line the portal row shows (an Agent call’s description)', () => {
  const m = toChatMessage({ seq: 1, at: 'x', kind: 'tool_use', toolName: 'Agent', toolUseId: 'a1', text: `QA agent 1 (sonnet) ${secretish()}`, toolInput: {} }, (b) => b)!;
  assert.ok(m.text.startsWith('QA agent 1 (sonnet)'), m.text);
  assert.ok(!m.text.includes(secretish()), 'redacted');
});
