import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ChatEvent, ChatFile } from '@portal/contracts';
import { blobDir } from '../blobs.js';
import type { StoredEvent } from '../protocol.js';
import { redact } from '../redact.js';
import { ArtifactCapture, isDeliverable, parseProduced } from './capture.js';
import { blobFileFor } from './serve.js';
import { cleanup, LocalHost, storeWithSession } from './testkit.js';

after(cleanup);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** A session whose folder is inside a fake workspace home, with a capture that copies out through the real host script. */
async function setup() {
  const host = new LocalHost();
  const s = await storeWithSession('S1');
  const proj = join(host.files, 'proj');
  mkdirSync(proj, { recursive: true });
  s.store.db!.prepare('UPDATE chat_sessions SET cwd = ? WHERE id = ?').run(proj, 'S1');
  const events: ChatEvent[] = [];
  const capture = new ArtifactCapture({
    store: s.store,
    workspaces: host.asWorkspaces(),
    install: async () => undefined,
    workspaceOf: (id) => (id === 'S1' ? 'docker/ws1' : null),
    append: (id, ev: StoredEvent) => {
      const e = s.chat.appendEvent(id, ev);
      events.push(e);
      return e.seq;
    },
    redact: (_workspace, text) => redact(text),
  });
  /** What the controller shows the capture for one tool call and its result. */
  let n = 0;
  const call = (tool: string, summary: string, result: string, isError = false) => {
    const id = `toolu_${++n}`;
    capture.observe('S1', { kind: 'tool_use', toolName: tool, toolUseId: id, text: summary });
    capture.observe('S1', { kind: 'tool_result', toolUseId: id, text: result, ...(isError ? { isError: true } : {}) });
  };
  const write = (path: string, content: string | Buffer, created = true) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    call('Write', path, created ? `File created successfully at: ${path} (file state is current in your context — no need to Read it back)` : `The file ${path} has been updated successfully.`);
  };
  const endTurn = () => capture.observe('S1', { kind: 'result' });
  return { host, s, proj, events, capture, call, write, endTurn, files: () => events.flatMap((e) => e.files ?? []) };
}

test('isDeliverable: what a person takes away is pictures, media, documents, tables, pages and archives, not source', () => {
  for (const n of ['a.png', 'B.JPG', 'clip.mp4', 'voice.m4a', 'report.pdf', 'brief.docx', 'sheet.xlsx', 'data.csv', 'page.html', 'pack.zip', 'logo.svg']) assert.ok(isDeliverable(n), n);
  for (const n of ['app.ts', 'main.py', 'config.json', 'notes.md', 'README', 'Makefile', 'package-lock.json', 'a.log', 'x.sh', 'noext']) assert.ok(!isDeliverable(n), n);
});

test('parseProduced: the folder and the files with size and time; anything else is ignored', () => {
  assert.equal(parseProduced(''), null);
  assert.equal(parseProduced('nope\n'), null);
  assert.deepEqual(parseProduced('#dir\t/home/node/proj\n12\t1700000000.5\t./a/b c.png\n3\t1700000001\t./x.csv\nbad line\n7\t1\tabs/path\n'), {
    dir: '/home/node/proj',
    files: [
      { size: 12, mtime: 1700000000.5, rel: 'a/b c.png' },
      { size: 3, mtime: 1700000001, rel: 'x.csv' },
    ],
  });
});

test('Write: a file the agent created becomes a card where it happened — copied out, typed by its bytes, recorded', async () => {
  const c = await setup();
  try {
    c.write(join(c.proj, 'report.md'), '# Report\n\nAll good.\n');
    c.write(join(c.proj, 'chart.png'), PNG);
    await c.capture.idle();
    assert.deepEqual(
      c.events.map((e) => [e.kind, e.files!.map((f) => [f.name, f.mediaType, f.preview, f.source])]),
      [
        ['artifact', [['report.md', 'text/markdown', 'text', 'write']]],
        ['artifact', [['chart.png', 'image/png', 'image', 'write']]],
      ],
    );
    const [md, png] = c.files() as [ChatFile, ChatFile];
    assert.equal(md.path, join(c.proj, 'report.md'));
    assert.deepEqual([png.width, png.height, png.size], [1, 1, PNG.length]);
    // The copy is in the blob store, served from there, and the chat's table says which event it belongs to.
    assert.ok(existsSync(join(blobDir(c.s.store), png.blobId)));
    assert.equal(blobFileFor(c.s.store, 'S1', png.blobId)?.mediaType, 'image/png');
    const rows = c.s.store.db!.prepare("SELECT kind, workspace_path, event_seq FROM chat_files WHERE session_id = 'S1' ORDER BY id").all() as { kind: string; workspace_path: string; event_seq: number }[];
    assert.deepEqual(rows.map((r) => [r.kind, r.workspace_path, r.event_seq]), [['download', md.path, c.events[0]!.seq], ['download', png.path, c.events[1]!.seq]]);
  } finally {
    c.s.close();
  }
});

test('Write and Edit: source files are the Changes view, not cards — a few created ones are shown, edits and the rest are not', async () => {
  const c = await setup();
  try {
    for (let i = 1; i <= 6; i++) c.write(join(c.proj, `src/mod${i}.ts`), `export const n = ${i};\n`);
    await c.capture.idle();
    assert.equal(c.files().length, 4, 'at most four source files a turn');
    // Edited (not created) source and config: never a card.
    c.call('Edit', join(c.proj, 'src/mod1.ts'), 'The file has been updated successfully.');
    c.write(join(c.proj, 'package.json'), '{}', false);
    // Edited notes and documents: shown.
    writeFileSync(join(c.proj, 'notes.md'), 'edited notes\n');
    c.call('Edit', join(c.proj, 'notes.md'), 'The file has been updated successfully.');
    writeFileSync(join(c.proj, 'brief.docx'), randomBytes(200));
    c.call('Edit', join(c.proj, 'brief.docx'), 'The file has been updated successfully.');
    await c.capture.idle();
    assert.deepEqual(c.files().slice(4).map((f) => [f.name, f.source]), [['notes.md', 'edit'], ['brief.docx', 'edit']]);
    // The next turn starts fresh.
    c.endTurn();
    c.write(join(c.proj, 'src/again.ts'), 'x\n');
    await c.capture.idle();
    assert.equal(c.files().at(-1)!.name, 'again.ts');
  } finally {
    c.s.close();
  }
});

test('Write: a failed write, a path the policy refuses, a link out, and a file that is too large leave no card and no trace', async () => {
  const c = await setup();
  try {
    writeFileSync(join(c.proj, 'a.md'), 'x');
    c.call('Write', join(c.proj, 'a.md'), 'File created successfully at: x', true); // the tool failed
    // Outside the workspace's home, and the portal's and Claude Code's own folders.
    mkdirSync(join(c.host.files, '.claude'), { recursive: true });
    mkdirSync(join(c.host.files, '.claudepilot'), { recursive: true });
    writeFileSync(join(c.host.files, '.claude/settings.json'), '{}');
    writeFileSync(join(c.host.files, '.claudepilot/secret.md'), 'token');
    c.call('Write', join(c.host.files, '.claude/settings.json'), 'File created successfully at: x');
    c.call('Write', join(c.host.files, '.claudepilot/secret.md'), 'File created successfully at: x');
    c.call('Write', '/etc/passwd', 'File created successfully at: /etc/passwd');
    // A link inside the folder to somewhere outside it.
    writeFileSync(join(c.host.root, 'outside.txt'), 'not yours');
    symlinkSync(join(c.host.root, 'outside.txt'), join(c.proj, 'link.txt'));
    c.call('Write', join(c.proj, 'link.txt'), 'File created successfully at: x');
    // Larger than a card keeps.
    writeFileSync(join(c.proj, 'huge.csv'), '');
    truncateSync(join(c.proj, 'huge.csv'), 26_000_000);
    c.call('Write', join(c.proj, 'huge.csv'), 'File created successfully at: x');
    // A path the summary cut short names no file.
    c.call('Write', `${join(c.proj, 'x'.repeat(50))}…`, 'File created successfully at: x');
    await c.capture.idle();
    assert.deepEqual(c.events, []);
    assert.equal((c.s.store.db!.prepare('SELECT COUNT(*) AS n FROM chat_files').get() as { n: number }).n, 0);
    assert.deepEqual(blobFilesIn(c.s.store), [], 'nothing was left in the blob store, temporary files included');
  } finally {
    c.s.close();
  }
});

function blobFilesIn(store: Parameters<typeof blobDir>[0]): string[] {
  try {
    return (require('node:fs') as typeof import('node:fs')).readdirSync(blobDir(store));
  } catch {
    return [];
  }
}

test('Write: a text copy never keeps a secret; the file in the workspace is untouched', async () => {
  const c = await setup();
  try {
    const key = 'sk-ant-api03-' + 'a1B2c3D4e5'.repeat(5);
    const path = join(c.proj, '.env.example');
    c.write(path, `ANTHROPIC_API_KEY=${key}\nPLAIN=value\n`);
    await c.capture.idle();
    const f = c.files()[0]!;
    assert.equal(f.redacted, true);
    const file = blobFileFor(c.s.store, 'S1', f.blobId)!;
    const stored = (await import('node:fs')).readFileSync(file.path, 'utf8');
    assert.ok(!stored.includes(key) && stored.includes('PLAIN=value'));
    assert.equal(f.size, Buffer.byteLength(stored), 'the size is the stored copy’s');
    assert.ok((await import('node:fs')).readFileSync(path, 'utf8').includes(key), 'the workspace’s own file is as it was');
  } finally {
    c.s.close();
  }
});

test('Write: the same bytes twice in a turn are one card; a new version of the same path is another, and the newest is what shows', async () => {
  const c = await setup();
  try {
    const path = join(c.proj, 'draft.md');
    // (A write is seen as its result arrives; the next one comes seconds later, after the copy-out.)
    c.write(path, 'v1\n');
    await c.capture.idle();
    c.write(path, 'v1\n', false);
    await c.capture.idle();
    c.write(path, 'v2\n', false);
    await c.capture.idle();
    assert.equal(c.files().length, 2, 'v1 once, then v2');
    assert.deepEqual(c.files().map((f) => f.size), [3, 3]);
    assert.notEqual(c.files()[0]!.blobId, c.files()[1]!.blobId);
  } finally {
    c.s.close();
  }
});

test('sweep: when a turn that ran commands ends, the pictures, tables and documents they made are found; source, notes and noise are not', async () => {
  const c = await setup();
  try {
    // The agent ran a command; files appear.
    c.capture.observe('S1', { kind: 'tool_use', toolName: 'Bash', toolUseId: 'b1', text: 'python make.py' });
    mkdirSync(join(c.proj, 'out'), { recursive: true });
    mkdirSync(join(c.proj, 'node_modules/pkg'), { recursive: true });
    mkdirSync(join(c.proj, '.git'), { recursive: true });
    writeFileSync(join(c.proj, 'out/chart.png'), PNG);
    writeFileSync(join(c.proj, 'out/data.csv'), 'a,b\n1,2\n');
    writeFileSync(join(c.proj, 'out/report.pdf'), '%PDF-1.4\n%%EOF\n');
    writeFileSync(join(c.proj, 'make.py'), 'print(1)\n');
    writeFileSync(join(c.proj, 'notes.md'), 'a note\n');
    writeFileSync(join(c.proj, 'node_modules/pkg/logo.png'), PNG);
    writeFileSync(join(c.proj, '.git/thing.png'), PNG);
    writeFileSync(join(c.proj, 'old.png'), PNG);
    utimesSync(join(c.proj, 'old.png'), new Date(Date.now() - 3 * 3600_000), new Date(Date.now() - 3 * 3600_000));
    c.capture.observe('S1', { kind: 'tool_result', toolUseId: 'b1', text: 'done' });
    c.endTurn();
    await c.capture.idle();
    assert.equal(c.events.length, 1, 'one event for the whole sweep');
    assert.deepEqual(c.files().map((f) => [f.name, f.source]).sort(), [['chart.png', 'command'], ['data.csv', 'command'], ['report.pdf', 'command']]);
    assert.ok(c.files().every((f) => f.path!.startsWith(join(c.proj, 'out'))));
    // Nothing is shown twice: a second identical turn finds nothing new.
    c.capture.observe('S1', { kind: 'tool_use', toolName: 'Bash', toolUseId: 'b2', text: 'ls' });
    c.endTurn();
    await c.capture.idle();
    assert.equal(c.events.length, 1);
  } finally {
    c.s.close();
  }
});

test('sweep: a file Write already showed this turn is not shown again; a turn without commands is never swept', async () => {
  const c = await setup();
  try {
    c.capture.observe('S1', { kind: 'tool_use', toolName: 'Bash', toolUseId: 'b1', text: 'convert' });
    c.write(join(c.proj, 'made.png'), PNG);
    c.capture.observe('S1', { kind: 'tool_result', toolUseId: 'b1', text: 'ok' });
    c.endTurn();
    await c.capture.idle();
    assert.equal(c.files().filter((f) => f.name === 'made.png').length, 1);
    // No Bash this turn: a picture dropped in the folder by something else is not an artifact.
    writeFileSync(join(c.proj, 'stray.png'), randomBytes(50));
    c.call('Read', join(c.proj, 'a.txt'), 'x');
    c.endTurn();
    await c.capture.idle();
    assert.ok(!c.files().some((f) => f.name === 'stray.png'));
  } finally {
    c.s.close();
  }
});

test('sweep: a dozen files at most, newest first, and a chat with no room keeps nothing', async () => {
  const c = await setup();
  try {
    c.capture.observe('S1', { kind: 'tool_use', toolName: 'Bash', toolUseId: 'b1', text: 'gen' });
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(c.proj, `p${i}.png`), Buffer.concat([PNG, Buffer.from([i])]));
      utimesSync(join(c.proj, `p${i}.png`), new Date(Date.now() - (15 - i) * 400), new Date(Date.now() - (15 - i) * 400));
    }
    c.endTurn();
    await c.capture.idle();
    assert.equal(c.files().length, 12);
    assert.ok(!c.files().some((f) => f.name === 'p0.png' || f.name === 'p1.png' || f.name === 'p2.png'), 'the oldest three were left out');

    process.env.PORTAL_CHAT_SESSION_QUOTA_MB = '0.0001'; // 100 bytes
    try {
      const before = c.events.length;
      c.write(join(c.proj, 'more.md'), '# more\n');
      await c.capture.idle();
      assert.equal(c.events.length, before, 'no room: no copy, no card');
    } finally {
      delete process.env.PORTAL_CHAT_SESSION_QUOTA_MB;
    }
  } finally {
    c.s.close();
  }
});
