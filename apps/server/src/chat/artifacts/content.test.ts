import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ChatAttachment, ChatEvent } from '@portal/contracts';
import type { Workspaces } from '../../workspaces/manager.js';
import { blobDir } from '../blobs.js';
import { ChatController } from '../controller.js';
import { freshStore, FakeWorkspaces, until, sleep } from '../testkit.js';
import { isStagedUpload } from './records.js';
import { receiveUpload } from './uploads.js';
import { cleanup, StagingWorkspaces } from './testkit.js';

after(cleanup);

const body = (...chunks: Buffer[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(new Uint8Array(ch));
      c.close();
    },
  });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function liveChat() {
  const { store, dataDir } = await freshStore();
  const ws = new StagingWorkspaces();
  const controller = new ChatController(store, ws as unknown as Workspaces);
  const id = (await controller.create({ workspaceId: 'docker/ws1' })).id;
  await until(() => ws.tails.length === 1);
  await until(() => controller.get(id)?.state === 'idle');
  await sleep(20);
  const upload = (name: string, data: Buffer) => receiveUpload(store, id, { body: body(data), name, declaredSize: data.length });
  /** The user line the controller wrote for this message. */
  const sent = (uuid: string) => JSON.parse(ws.sends.find((x) => x.line.includes(uuid))!.line) as { message: { content: unknown } };
  const user = (uuid: string): ChatEvent => controller.history(id).find((e) => e.kind === 'user' && e.uuid === uuid)!;
  const done = async () => {
    await controller.end(id).catch(() => undefined);
    controller.stop();
    store.close();
  };
  return { store, dataDir, ws, controller, id, upload, sent, user, done };
}

test('send with uploaded files: staged for Claude, named in the message it reads, kept out of the words the person sees', async () => {
  const c = await liveChat();
  try {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(500), Buffer.from('\n%%EOF\n')]);
    const csv = Buffer.from('name,qty\nkopi,3\n');
    const mp3 = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00\xff\xfb\x90\x00'), randomBytes(200)]);
    const [a, b, d, e] = await Promise.all([c.upload('Q3 report.pdf', pdf), c.upload('data.csv', csv), c.upload('voice note.mp3', mp3), c.upload('photo.png', PNG)]);
    const uuid = randomUUID();
    const attachments: ChatAttachment[] = [{ uploadId: a.id }, { uploadId: b.id }, { uploadId: d.id }, { uploadId: e.id }];
    await c.controller.send(c.id, uuid, 'summarise these', { attachments });

    // What Claude gets: the words, a note with the paths, and only the PNG as an image block.
    const content = c.sent(uuid).message.content as { type: string; text?: string; source?: { media_type: string; data: string } }[];
    // Claude Code only follows @ mentions in the last block of a message, so the words come last.
    assert.deepEqual(content.map((x) => x.type), ['image', 'text']);
    const text = content.at(-1)!.text!;
    const dir = join(c.ws.local.uploads, c.id);
    assert.ok(text.startsWith('summarise these\n\n[Attached by the user, saved in the workspace:\n'));
    const pdfPath = join(dir, readdirSync(dir).find((f) => f.endsWith('.pdf'))!);
    assert.ok(text.includes(`@${pdfPath}`), 'a PDF is an @ mention: Claude opens it');
    assert.ok(text.includes(`@${join(dir, readdirSync(dir).find((f) => f.endsWith('.csv'))!)}`));
    const mp3Path = join(dir, readdirSync(dir).find((f) => f.endsWith('.mp3'))!);
    assert.ok(text.includes(`\n${mp3Path} (audio, `) && text.includes('you can’t hear it'), 'audio: no @, and what Claude can’t do');
    assert.ok(text.includes('(image, shown in this message)'));
    assert.ok(!text.includes('@' + join(dir, readdirSync(dir).find((f) => f.endsWith('.png'))!)), 'an image Claude is shown is not also an @ mention');
    assert.deepEqual(
      content.filter((x) => x.type === 'image').map((x) => [x.source!.media_type, x.source!.data]),
      [['image/png', PNG.toString('base64')]],
    );
    // Every file arrived in the workspace byte for byte.
    assert.ok(readFileSync(pdfPath).equals(pdf));
    assert.ok(readFileSync(mp3Path).equals(mp3));

    // What the person sees: their words only, the image with its size, the other files as files.
    const ev = c.user(uuid);
    assert.equal(ev.text, 'summarise these');
    assert.deepEqual(ev.images, [{ blobId: e.blobId, mediaType: 'image/png', name: 'photo.png', width: 1, height: 1 }]);
    assert.deepEqual(
      ev.files!.map((f) => [f.name, f.mediaType, f.preview, f.reach]),
      [
        ['Q3 report.pdf', 'application/pdf', 'pdf', 'reads'],
        ['data.csv', 'text/csv', 'text', 'reads'],
        ['voice note.mp3', 'audio/mpeg', 'audio', 'path'],
      ],
    );
    assert.ok(ev.files!.every((f) => f.path === undefined), 'the staged path is transport: the transcript never shows it');

    // The chat's file rows point at the event, and the waiting uploads are spent.
    const rows = c.store.db!.prepare("SELECT kind, event_seq, workspace_path FROM chat_files WHERE session_id = ? AND kind = 'upload'").all(c.id) as { kind: string; event_seq: number; workspace_path: string | null }[];
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.event_seq === ev.seq));
    assert.ok(rows.every((r) => r.workspace_path?.startsWith(dir)), 'where each is staged is on record, in the portal’s own table');
    assert.equal((c.store.db!.prepare('SELECT COUNT(*) AS n FROM chat_uploads').get() as { n: number }).n, 0);
    // The stored event never holds bytes.
    assert.ok(!JSON.stringify(c.store.db!.prepare('SELECT payload FROM chat_events').all()).includes(PNG.toString('base64')));
    assert.deepEqual(c.ws.ops.filter((o) => o.startsWith('put')).length, 4);
  } finally {
    await c.done();
  }
});

test('send: only attachments is a message; nothing at all is not; the checks happen before anything is stored or staged', async () => {
  const c = await liveChat();
  try {
    const only = await c.upload('data.csv', Buffer.from('a,b\n'));
    await c.controller.send(c.id, randomUUID(), '', { attachments: [{ uploadId: only.id }] });
    assert.equal(c.controller.history(c.id).filter((e) => e.kind === 'user').length, 1);
    const after = c.controller.history(c.id).length;
    const puts = c.ws.ops.filter((o) => o.startsWith('put')).length;
    await assert.rejects(c.controller.send(c.id, randomUUID(), '  ', { attachments: [] }), /Type a message/);
    await assert.rejects(c.controller.send(c.id, randomUUID(), 'x', { attachments: [{ uploadId: 'f'.repeat(24) }] }), /no longer there/);
    await assert.rejects(c.controller.send(c.id, randomUUID(), 'x', { attachments: [{ uploadId: only.id }] }), /no longer there/, 'an upload is spent once its message is sent');
    await assert.rejects(c.controller.send(c.id, randomUUID(), 'x', { attachments: 'nope' }), /list of files/);
    await assert.rejects(
      c.controller.send(c.id, randomUUID(), 'x', { attachments: Array.from({ length: 21 }, () => ({ uploadId: 'a'.repeat(24) })) }),
      /at most 20 files/,
    );
    assert.equal(c.controller.history(c.id).length, after, 'nothing was stored');
    assert.equal(c.ws.ops.filter((o) => o.startsWith('put')).length, puts, 'nothing was staged');
  } finally {
    await c.done();
  }
});

test('send: a chat can not use another chat’s upload', async () => {
  const c = await liveChat();
  try {
    const other = await c.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => c.ws.tails.length === 2);
    const theirs = await receiveUpload(c.store, other.id, { body: body(Buffer.from('secret plans')), name: 'plans.txt', declaredSize: 12 });
    await assert.rejects(c.controller.send(c.id, randomUUID(), 'use it', { attachments: [{ uploadId: theirs.id }] }), /no longer there/);
    assert.equal(c.ws.ops.filter((o) => o.startsWith('put')).length, 0);
  } finally {
    await c.done();
  }
});

test('send: when the workspace can’t take the file nothing is stored or sent, and the upload waits for a retry', async () => {
  const c = await liveChat();
  try {
    const up = await c.upload('data.csv', Buffer.from('a,b\n1,2\n'));
    const events = c.controller.history(c.id).length;
    const sends = c.ws.sends.length;
    c.ws.putCode = 5;
    await assert.rejects(c.controller.send(c.id, randomUUID(), 'here', { attachments: [{ uploadId: up.id }] }), /Couldn’t save the file in the workspace/);
    assert.equal(c.controller.history(c.id).length, events);
    assert.equal(c.ws.sends.length, sends);
    assert.equal((c.store.db!.prepare('SELECT COUNT(*) AS n FROM chat_uploads WHERE id = ?').get(up.id) as { n: number }).n, 1, 'the upload is still waiting');
    c.ws.putCode = 0;
    await c.controller.send(c.id, randomUUID(), 'here', { attachments: [{ uploadId: up.id }] });
    assert.equal(c.controller.history(c.id).filter((e) => e.kind === 'user').length, 1);
  } finally {
    await c.done();
  }
});

test('send: the same file twice is staged once under one path, two different files with one name never overwrite each other', async () => {
  const c = await liveChat();
  try {
    const a1 = await c.upload('report.txt', Buffer.from('first'));
    const a2 = await c.upload('report.txt', Buffer.from('second'));
    const again = await c.upload('report.txt', Buffer.from('first'));
    await c.controller.send(c.id, randomUUID(), 'x', { attachments: [{ uploadId: a1.id }, { uploadId: a2.id }, { uploadId: again.id }] });
    const dir = join(c.ws.local.uploads, c.id);
    const staged = readdirSync(dir).sort();
    assert.equal(staged.length, 2);
    assert.deepEqual(staged.map((f) => readFileSync(join(dir, f), 'utf8')).sort(), ['first', 'second']);
  } finally {
    await c.done();
  }
});

test('delete: the staged files in the workspace are removed, and the portal’s blobs go with the chat when nothing else links them', async () => {
  const c = await liveChat();
  try {
    const up = await c.upload('data.csv', Buffer.from('a,b\n'));
    await c.controller.send(c.id, randomUUID(), 'x', { attachments: [{ uploadId: up.id }] });
    assert.equal(existsSync(join(c.ws.local.uploads, c.id)), true);
    assert.equal(existsSync(join(blobDir(c.store), up.blobId)), true);
    await c.controller.delete(c.id);
    assert.equal(existsSync(join(c.ws.local.uploads, c.id)), false, 'unstaged in the workspace');
    assert.equal(existsSync(join(blobDir(c.store), up.blobId)), false, 'pruned from the blob store');
    assert.ok(c.ws.ops.includes(`unstage ${c.id}`));
  } finally {
    c.controller.stop();
    c.store.close();
  }
});

test('isStagedUpload: only a Read of exactly a file staged for this chat is the person’s own', async () => {
  const c = await liveChat();
  try {
    const up = await c.upload('report.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(50)]));
    await c.controller.send(c.id, randomUUID(), 'x', { attachments: [{ uploadId: up.id }] });
    const dir = join(c.ws.local.uploads, c.id);
    const path = join(dir, readdirSync(dir)[0]!);
    assert.equal(isStagedUpload(c.store, c.id, 'Read', { file_path: path }), true);
    assert.equal(isStagedUpload(c.store, c.id, 'Read', path), true);
    assert.equal(isStagedUpload(c.store, c.id, 'Bash', { file_path: path }), false, 'not a command');
    assert.equal(isStagedUpload(c.store, c.id, 'Edit', { file_path: path }), false, 'not a write');
    assert.equal(isStagedUpload(c.store, 'another-chat', 'Read', { file_path: path }), false, 'not another chat’s file');
    assert.equal(isStagedUpload(c.store, c.id, 'Read', { file_path: `${dir}/../../.ssh/id_rsa` }), false);
    assert.equal(isStagedUpload(c.store, c.id, 'Read', { file_path: `${path}x` }), false);
    assert.equal(isStagedUpload(c.store, c.id, 'Read', { file_path: dir }), false, 'the folder is not a file');
    assert.equal(isStagedUpload(c.store, c.id, 'Read', {}), false);
  } finally {
    await c.done();
  }
});
