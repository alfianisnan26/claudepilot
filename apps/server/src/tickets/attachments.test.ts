// Ticket attachments (owner, 2026-10-17: "ticket support with attachment, all files"): any type is kept and served back byte for byte to
// whoever may see the ticket; the limits hold; a name loses its folders; an agent attaches where it may comment and removes only its own;
// the bytes go when the last row naming them goes; every add and remove is one timeline entry.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import { TICKET_ATTACHMENT_LIMITS } from '@portal/contracts';
import { ticketFileDir } from './files.js';
import { agent, ticketsHarness, token, UI } from './testkit.js';

const code = (fn: () => unknown): string => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof AppError ? e.code : String(e);
  }
};

test('any file type is kept and read back byte for byte; the timeline says so; the detail lists it', async () => {
  const h = await ticketsHarness();
  try {
    const t = h.tickets.create(UI, { summary: 'with files' });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]);
    const a = h.tickets.attach(UI, t.id, { name: 'home-390-dark.png', mediaType: 'image/png', bytes: png });
    const b = h.tickets.attach(UI, t.id, { name: 'suite.log', mediaType: 'text/plain; charset=utf-8', bytes: Buffer.from('ok 1\nok 2\n') });
    const z = h.tickets.attach(UI, t.id, { name: 'build.tar.gz', mediaType: 'application/gzip', bytes: Buffer.alloc(1000, 7) });
    assert.deepEqual([a.mediaType, b.mediaType, z.mediaType], ['image/png', 'text/plain', 'application/gzip'], 'the type without parameters');
    assert.deepEqual(h.tickets.attachmentFile(UI, t.id, a.id).bytes, png);
    assert.equal(h.tickets.attachmentFile(UI, t.id, b.id).bytes.toString(), 'ok 1\nok 2\n');
    const d = h.tickets.get(UI, t.id);
    assert.deepEqual(d.attachments?.map((x) => x.name), ['home-390-dark.png', 'suite.log', 'build.tar.gz']);
    assert.equal(d.events.filter((e) => e.kind === 'attachment').length, 3);
    assert.equal(d.events.at(-1)?.data?.name, 'build.tar.gz');
    assert.equal(a.actor, 'ui');
    assert.equal(a.fromAgent, false);
  } finally {
    h.done();
  }
});

test('names lose folders and control characters; an odd type becomes octet-stream; empty, too large and too many are refused', async () => {
  const h = await ticketsHarness();
  try {
    const t = h.tickets.create(UI, { summary: 'limits' });
    assert.equal(h.tickets.attach(UI, t.id, { name: '../../etc/pass\u0007wd', bytes: Buffer.from('x') }).name, 'passwd');
    assert.equal(h.tickets.attach(UI, t.id, { name: 'C:\\Users\\a\\report.pdf', bytes: Buffer.from('x') }).name, 'report.pdf');
    assert.equal(h.tickets.attach(UI, t.id, { name: 'x.bin', mediaType: '<script>', bytes: Buffer.from('x') }).mediaType, 'application/octet-stream');
    assert.equal(h.tickets.attach(UI, t.id, { name: 'x.svg', mediaType: 'image/svg+xml', bytes: Buffer.from('<svg/>') }).mediaType, 'image/svg+xml', 'kept as given; the route serves it as a download');
    assert.equal(code(() => h.tickets.attach(UI, t.id, { name: '..', bytes: Buffer.from('x') })), 'VALIDATION_FAILED');
    assert.equal(code(() => h.tickets.attach(UI, t.id, { name: 'empty.txt', bytes: Buffer.alloc(0) })), 'VALIDATION_FAILED');
    assert.equal(code(() => h.tickets.attach(UI, t.id, { name: 'big.bin', bytes: Buffer.alloc(TICKET_ATTACHMENT_LIMITS.maxBytes + 1) })), 'PAYLOAD_TOO_LARGE');
    const many = h.tickets.create(UI, { summary: 'many' });
    for (let i = 0; i < TICKET_ATTACHMENT_LIMITS.perTicket; i++) h.tickets.attach(UI, many.id, { name: `f${i}.txt`, bytes: Buffer.from(String(i)) });
    assert.equal(code(() => h.tickets.attach(UI, many.id, { name: 'one-more.txt', bytes: Buffer.from('x') })), 'CONFLICT');
  } finally {
    h.done();
  }
});

test('an agent attaches where it may comment, not elsewhere; it removes only its own; a read token cannot attach; another ticket’s file is not found', async () => {
  const h = await ticketsHarness();
  try {
    const sa = h.sessions.add({ workspaceId: 'docker/api', id: 'sa' });
    const sb = h.sessions.add({ workspaceId: 'docker/api', id: 'sb' });
    const me = agent('docker/api', sa.id);
    const mine = h.tickets.create(UI, { summary: 'mine', assignee: { kind: 'session', sessionId: sa.id } });
    const theirs = h.tickets.create(UI, { summary: 'theirs', assignee: { kind: 'session', sessionId: sb.id } });
    const a = h.tickets.attach(me, mine.id, { name: 'shot.png', mediaType: 'image/png', bytes: Buffer.from('png') });
    assert.equal(a.actor, 'session:sa');
    assert.equal(a.fromAgent, true);
    assert.equal(code(() => h.tickets.attach(me, theirs.id, { name: 'x.txt', bytes: Buffer.from('x') })), 'FORBIDDEN', 'the comment rule');
    assert.equal(code(() => h.tickets.attach(token('ptk_r', 'read'), mine.id, { name: 'x.txt', bytes: Buffer.from('x') })), 'FORBIDDEN', 'a read token only reads');
    const byPerson = h.tickets.attach(UI, mine.id, { name: 'person.txt', bytes: Buffer.from('p') });
    assert.equal(code(() => h.tickets.removeAttachment(me, mine.id, byPerson.id)), 'FORBIDDEN', 'not its own file');
    assert.equal(code(() => h.tickets.attachmentFile(UI, theirs.id, a.id)), 'NOT_FOUND', 'a file is reached only through its own ticket');
    h.tickets.removeAttachment(me, mine.id, a.id);
    assert.deepEqual(h.tickets.attachments(UI, mine.id).map((x) => x.name), ['person.txt']);
    const removed = h.tickets.get(UI, mine.id).events.filter((e) => e.kind === 'attachment' && e.data?.removed);
    assert.equal(removed.length, 1);
  } finally {
    h.done();
  }
});

test('the bytes are kept while any row names them and go with the last one', async () => {
  const h = await ticketsHarness();
  try {
    const t1 = h.tickets.create(UI, { summary: 'one' });
    const t2 = h.tickets.create(UI, { summary: 'two' });
    const bytes = Buffer.from('same content on two tickets');
    const a = h.tickets.attach(UI, t1.id, { name: 'a.txt', bytes });
    const b = h.tickets.attach(UI, t2.id, { name: 'b.txt', bytes });
    assert.equal(a.sha256, b.sha256);
    const file = join(ticketFileDir(h.dataDir), a.sha256);
    h.tickets.removeAttachment(UI, t1.id, a.id);
    assert.ok(existsSync(file), 'still named by T-2');
    assert.equal(h.tickets.attachmentFile(UI, t2.id, b.id).bytes.toString(), 'same content on two tickets');
    h.tickets.removeAttachment(UI, t2.id, b.id);
    assert.ok(!existsSync(file), 'gone with the last row');
  } finally {
    h.done();
  }
});
