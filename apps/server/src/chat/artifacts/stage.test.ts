import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PUT_MAX_BASE64 } from '../host.js';
import { stagedName } from './names.js';
import { attachmentNote, stageFile, unstageSession } from './stage.js';
import { cleanup, LocalHost, temp } from './testkit.js';

after(cleanup);

/** Runs `put` by hand: base64 of `bytes` (or `chars`) on stdin. */
async function put(host: LocalHost, args: string[], stdin: string): Promise<{ code: number | null; out: string }> {
  const exec = await host.exec('docker', 'ws', ['sh', 'cp-session', 'put', ...args]);
  let out = '';
  exec.onData((b) => (out += b.toString('utf8')));
  const done = new Promise<number | null>((resolve) => exec.onExit(resolve));
  exec.write(stdin);
  return { code: await done, out: out.trim() };
}

const b64 = (b: Buffer) => b.toString('base64');

test('host put: the bytes arrive exactly, 0600, under the session’s folder, and the path comes back', async () => {
  const host = new LocalHost();
  const bytes = randomBytes(3 * 1024 * 1024 + 17); // binary, not a multiple of three
  const text = b64(bytes);
  const r = await put(host, ['S1', 'photo-1234abcd.jpg', String(text.length), String(bytes.length)], text);
  assert.equal(r.code, 0);
  assert.equal(r.out, join(host.uploads, 'S1', 'photo-1234abcd.jpg'));
  assert.ok(readFileSync(r.out).equals(bytes));
  assert.equal(statSync(r.out).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(host.uploads, 'S1')), ['photo-1234abcd.jpg'], 'no temporary file is left');
  // The same name again replaces it (same name means same content in practice).
  const again = await put(host, ['S1', 'photo-1234abcd.jpg', String(text.length), String(bytes.length)], text);
  assert.equal(again.code, 0);
});

test('host put: refuses names that are not plain, a size that doesn’t match, a folder that is a link, and too much', async () => {
  const host = new LocalHost();
  const data = b64(Buffer.from('hello'));
  const ok = (name: string) => put(host, ['S1', name, String(data.length), '5'], data);
  for (const bad of ['../x', 'a/b', '.hidden', 'a b', 'a;b', '$(id)', '', 'é.txt', 'x'.repeat(97)]) assert.equal((await ok(bad)).code, 2, `name ${JSON.stringify(bad)}`);
  assert.equal((await put(host, ['../S1', 'a.txt', String(data.length), '5'], data)).code, 2, 'a session id is not a path');
  assert.equal((await put(host, ['S1', 'a.txt', 'x', '5'], data)).code, 2);
  assert.equal((await put(host, ['S1', 'a.txt', String(data.length), '6'], data)).code, 4, 'five bytes arrived, six were promised: nothing is kept');
  assert.equal(existsSync(join(host.uploads, 'S1', 'a.txt')), false);
  assert.deepEqual(readdirSync(join(host.uploads, 'S1')), [], 'no temporary file after a refusal');
  assert.equal((await put(host, ['S1', 'a.txt', String(PUT_MAX_BASE64 + 1), '5'], '')).code, 6, 'more than the limit is refused before any is read');

  // A link where the session's folder should be is refused, and what it points at is untouched.
  const outside = temp('outside');
  mkdirSync(host.uploads, { recursive: true });
  symlinkSync(outside, join(host.uploads, 'LINKED'));
  assert.equal((await put(host, ['LINKED', 'a.txt', String(data.length), '5'], data)).code, 2);
  assert.deepEqual(readdirSync(outside), []);
  // And a link where the file should be is never followed.
  mkdirSync(join(host.uploads, 'S2'), { recursive: true });
  writeFileSync(join(outside, 'victim.txt'), 'keep');
  symlinkSync(join(outside, 'victim.txt'), join(host.uploads, 'S2', 'a.txt'));
  assert.equal((await put(host, ['S2', 'a.txt', String(data.length), '5'], data)).code, 2);
  assert.equal(readFileSync(join(outside, 'victim.txt'), 'utf8'), 'keep');
});

test('host unstage: deletes a session’s staged files and nothing else; a link is removed, not followed', async () => {
  const host = new LocalHost();
  const data = b64(Buffer.from('hello'));
  await put(host, ['S1', 'a.txt', String(data.length), '5'], data);
  await put(host, ['S2', 'b.txt', String(data.length), '5'], data);
  const unstage = async (id: string) => {
    const exec = await host.exec('docker', 'ws', ['sh', 'cp-session', 'unstage', id]);
    return new Promise<number | null>((resolve) => exec.onExit(resolve));
  };
  assert.equal(await unstage('S1'), 0);
  assert.equal(existsSync(join(host.uploads, 'S1')), false);
  assert.equal(existsSync(join(host.uploads, 'S2', 'b.txt')), true);
  assert.equal(await unstage('../S2'), 2);
  const outside = temp('outside');
  writeFileSync(join(outside, 'victim.txt'), 'keep');
  symlinkSync(outside, join(host.uploads, 'S3'));
  assert.equal(await unstage('S3'), 0);
  assert.equal(readFileSync(join(outside, 'victim.txt'), 'utf8'), 'keep', 'what the link led to is untouched');
  assert.equal(await unstage('never-existed'), 0);
});

test('stageFile: a big binary file goes through the exec in pieces and arrives identical; a refusal says so', async () => {
  const host = new LocalHost();
  const dir = temp('blob');
  const bytes = randomBytes(5 * 1024 * 1024 + 1);
  const blobPath = join(dir, 'blob');
  writeFileSync(blobPath, bytes);
  const staged = stagedName('Q3 report (final).pdf', createHash('sha256').update(bytes).digest('hex'));
  const path = await stageFile(host.asWorkspaces(), 'docker/ws1', 'S1', { blobPath, staged });
  assert.equal(path, join(host.uploads, 'S1', staged));
  assert.ok(readFileSync(path).equals(bytes));
  assert.deepEqual(host.commands[0]!.slice(0, 3), ['put', 'S1', staged]);
  assert.ok(!host.commands[0]!.join(' ').includes('report (final)'), 'the display name never reaches a command line');

  await assert.rejects(stageFile(host.asWorkspaces(), 'docker/ws1', 'S1', { blobPath, staged: '../escape' }), /can’t be saved in the workspace/);
  host.env = { CLAUDEPILOT_UPLOADS_DIR: '/proc/no-such-place/uploads' }; // nowhere to write: the host fails and the failure is said
  await assert.rejects(stageFile(host.asWorkspaces(), 'docker/ws1', 'S1', { blobPath, staged: staged.replace('.pdf', '2.pdf') }), /Couldn’t save the file in the workspace/);
});

test('stageFile: a transfer cut on its way is tried once more, and a second cut says how many bytes arrived', async () => {
  const host = new LocalHost();
  const dir = temp('blob');
  const bytes = randomBytes(2 * 1024 * 1024 + 5);
  const blobPath = join(dir, 'blob');
  writeFileSync(blobPath, bytes);
  const staged = stagedName('photo.jpg', createHash('sha256').update(bytes).digest('hex'));
  // The first exec loses the tail of its stdin; the second is whole: the file arrives, the person hears nothing.
  host.cutStdinAfter = { bytes: 1_000_000, execs: 1 };
  const path = await stageFile(host.asWorkspaces(), 'docker/ws1', 'S1', { blobPath, staged });
  assert.ok(readFileSync(path).equals(bytes));
  assert.equal(host.commands.length, 2, 'put ran twice');
  // Cut both times: the error says what came (750000 of the base64's 1,000,000 characters decode to 750,000 bytes), nothing is kept.
  host.cutStdinAfter = { bytes: 1_000_000, execs: 2 };
  await assert.rejects(stageFile(host.asWorkspaces(), 'docker/ws1', 'S2', { blobPath, staged }), /Couldn’t save the file in the workspace: 750000 of 2097157 bytes arrived\./);
  assert.equal(existsSync(join(host.uploads, 'S2', staged)), false);
});

test('stageFile: an install that fails stops the transfer before any byte is written', async () => {
  const host = new LocalHost();
  const dir = temp('blob');
  const blobPath = join(dir, 'blob');
  writeFileSync(blobPath, 'hello');
  await assert.rejects(
    stageFile(host.asWorkspaces(), 'docker/ws1', 'S1', { blobPath, staged: 'a-12345678.txt' }, { install: async () => Promise.reject(new Error('no docker')) }),
    /bring the workspace’s chat host up to date/,
  );
});

test('unstageSession runs the host command and says whether it worked', async () => {
  const host = new LocalHost();
  const data = b64(Buffer.from('hello'));
  await put(host, ['S1', 'a.txt', String(data.length), '5'], data);
  assert.equal(await unstageSession(host.asWorkspaces(), 'docker/ws1', 'S1'), true);
  assert.equal(existsSync(join(host.uploads, 'S1')), false);
});

test('attachmentNote: Claude is told what each file is, with @ only for what it can open itself', () => {
  assert.equal(attachmentNote([]), '');
  const note = attachmentNote([
    { path: '/home/node/.claudepilot/uploads/S1/report-aaaaaaaa.pdf', reach: 'reads', label: 'PDF', size: 120_000 },
    { path: '/home/node/.claudepilot/uploads/S1/data-bbbbbbbb.csv', reach: 'reads', label: 'CSV', size: 800 },
    { path: '/home/node/.claudepilot/uploads/S1/photo-cccccccc.jpg', reach: 'sees', label: 'image', size: 900_000, shown: true },
    { path: '/home/node/.claudepilot/uploads/S1/clip-dddddddd.mp4', reach: 'path', label: 'video', size: 12_345_678, limit: 'you can’t watch or hear it' },
  ]);
  assert.equal(
    note,
    [
      '[Attached by the user, saved in the workspace:',
      '@/home/node/.claudepilot/uploads/S1/report-aaaaaaaa.pdf',
      '@/home/node/.claudepilot/uploads/S1/data-bbbbbbbb.csv',
      '/home/node/.claudepilot/uploads/S1/photo-cccccccc.jpg (image, shown in this message)',
      '/home/node/.claudepilot/uploads/S1/clip-dddddddd.mp4 (video, 12.3 MB; you can’t watch or hear it)]',
    ].join('\n'),
  );
});
