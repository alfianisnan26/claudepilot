import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { tempDirectory } from '../store/testTmp.js';
import { AGENT, harness, outside, readOutside, SESSION, UI } from './testkit.js';
import { hashOf } from './vault.js';

const h = await harness();
after(() => h.close());

const reason = (r: string) => (e: unknown) => (e as { reason?: string }).reason === r;
const tmpFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith('.tmp')) out.push(join(d, e.name));
    }
  };
  walk(root);
  return out;
};

test('create, read back, replace with the version, refuse a stale or missing version', () => {
  const v = h.vault();
  const a = v.writeNote('Folder/Note.md', 'hello', { actor: UI, create: true });
  assert.deepEqual([a.created, a.unchanged, a.version], [true, false, hashOf('hello')]);
  assert.equal(readFileSync(join(v.root, 'Folder', 'Note.md'), 'utf8'), 'hello');
  const r = v.readNote('Folder/Note.md');
  assert.deepEqual([r.text, r.version, r.path], ['hello', hashOf('hello'), 'Folder/Note.md']);
  assert.throws(() => v.writeNote('Folder/Note.md', 'x', { actor: UI, create: true }), reason('EXISTS'));
  assert.throws(() => v.writeNote('Folder/Note.md', 'x', { actor: UI }), reason('CONFLICT'));
  assert.throws(() => v.writeNote('Folder/Note.md', 'x', { actor: UI, baseVersion: 'deadbeefdeadbeef' }), (e: unknown) => {
    const d = (e as { details?: { currentVersion?: string; content?: string } }).details;
    return (e as { reason?: string }).reason === 'CONFLICT' && d?.currentVersion === hashOf('hello') && d?.content === 'hello';
  });
  const b = v.writeNote('Folder/Note.md', 'hello world', { actor: UI, baseVersion: a.version });
  assert.equal(b.version, hashOf('hello world'));
  assert.equal(readFileSync(join(v.root, 'Folder', 'Note.md'), 'utf8'), 'hello world');
  // The same content is a no-op: no new version, no history row.
  const c = v.writeNote('Folder/Note.md', 'hello world', { actor: UI, baseVersion: b.version });
  assert.equal(c.unchanged, true);
  // A write that expects a note that was deleted meanwhile is a conflict, not a silent re-create.
  v.deleteNote('Folder/Note.md', { actor: UI });
  assert.throws(() => v.writeNote('Folder/Note.md', 'again', { actor: UI, baseVersion: b.version }), (e: unknown) => (e as { details?: { deleted?: boolean } }).details?.deleted === true);
  assert.deepEqual(tmpFiles(v.root), []);
});

test('a write is atomic: no temporary file is left, and a failed write changes nothing', () => {
  const v = h.vault();
  v.writeNote('a.md', 'one', { actor: UI, create: true });
  // The folder for the new file can't be made because a file is in the way.
  assert.throws(() => v.writeNote('a.md/under.md', 'x', { actor: UI, create: true }), reason('INVALID_PATH'));
  const before = v.readNote('a.md');
  // Journal first: a pending row for a failed write is removed, history doesn't claim a change that never happened.
  const rows = () => h.journal.history(v.id, 'a.md').length;
  const n = rows();
  rmSync(join(v.root, 'a.md'));
  mkdirSync(join(v.root, 'a.md'));
  assert.throws(() => v.writeNote('a.md', 'two', { actor: UI, baseVersion: before.version }));
  assert.equal(rows(), n);
  assert.deepEqual(tmpFiles(v.root), []);
});

test('the byte-order mark and CRLF line endings of an existing note are kept when a person edits it', () => {
  const v = h.vault();
  outside(v, 'win.md', '﻿line one\r\nline two\r\n');
  const cur = v.readNote('win.md');
  assert.equal(cur.text.startsWith('﻿'), true);
  v.writeNote('win.md', 'line one\nline two\nline three\n', { actor: UI, baseVersion: cur.version });
  assert.equal(readFileSync(join(v.root, 'win.md')).toString('utf8'), '﻿line one\r\nline two\r\nline three\r\n');
  // A note that is LF stays LF.
  v.writeNote('lf.md', 'a\nb\n', { actor: UI, create: true });
  v.writeNote('lf.md', 'a\nb\nc\n', { actor: UI, baseVersion: v.readNote('lf.md').version });
  assert.equal(readOutside(v, 'lf.md'), 'a\nb\nc\n');
});

test('paths and names: refused before anything is written', () => {
  const v = h.vault();
  for (const p of ['../escape.md', '/abs.md', 'a\\b.md', 'CON.md', 'bad:name.md', '.obsidian/app.md', 'no-extension', 'x.txt', 'a/../b.md']) assert.throws(() => v.writeNote(p, 'x', { actor: UI, create: true }), reason('INVALID_PATH'), p);
  assert.throws(() => v.writeNote('Note.MD', 'x', { actor: UI, create: true }), reason('INVALID_PATH'));
  v.writeNote('Case.md', 'x', { actor: UI, create: true });
  assert.throws(() => v.writeNote('case.md', 'y', { actor: UI, create: true }), reason('EXISTS'));
  assert.deepEqual(readdirSync(v.root).filter((n) => !n.startsWith('.')), ['Case.md']);
});

test('size caps: a note, an attachment, the number of files', async () => {
  const small = await harness({ limits: { noteBytes: 1000, attachmentBytes: 2000, vaultFiles: 100 } });
  try {
    const v = small.vault();
    assert.throws(() => v.writeNote('big.md', 'x'.repeat(1001), { actor: UI, create: true }), reason('TOO_LARGE'));
    assert.throws(() => v.writeFile('big.png', Buffer.alloc(2001), { actor: UI }), reason('TOO_LARGE'));
    assert.deepEqual(v.writeFile('ok.png', Buffer.alloc(2000), { actor: UI }), { path: 'ok.png', size: 2000 });
    assert.throws(() => v.writeFile('x.html', Buffer.from('<script>'), { actor: UI }), reason('UNSUPPORTED_TYPE'));
    assert.throws(() => v.writeFile('x.exe', Buffer.from('MZ'), { actor: UI }), reason('UNSUPPORTED_TYPE'));
    assert.throws(() => v.writeFile('dup.md', Buffer.from('x'), { actor: UI }), reason('INVALID_PATH'));
    assert.throws(() => v.writeFile('ok.png', Buffer.alloc(10), { actor: UI }), reason('EXISTS'));
  } finally {
    small.close();
  }
  const tiny = await harness({ limits: { vaultFiles: 100 } });
  try {
    const v = tiny.vault();
    for (let i = 0; i < 100; i++) v.writeNote(`n${i}.md`, 'x', { actor: UI, create: true });
    assert.throws(() => v.writeNote('one-more.md', 'x', { actor: UI, create: true }), reason('LIMIT_REACHED'));
  } finally {
    tiny.close();
  }
});

test('symbolic links are never followed: not for reading, writing or listing', async () => {
  const v = h.vault();
  const elsewhere = tempDirectory('kg-elsewhere-');
  writeFileSync(join(elsewhere, 'secret.md'), 'TOP SECRET');
  symlinkSync(elsewhere, join(v.root, 'linkdir'));
  symlinkSync(join(elsewhere, 'secret.md'), join(v.root, 'leak.md'));
  v.writeNote('real.md', 'real', { actor: UI, create: true });
  for (const p of ['linkdir/secret.md', 'leak.md']) assert.throws(() => v.readNote(p), reason('INVALID_PATH'), p);
  assert.throws(() => v.writeNote('linkdir/new.md', 'x', { actor: UI, create: true }), reason('INVALID_PATH'));
  assert.throws(() => v.writeNote('leak.md', 'x', { actor: UI, create: true }), reason('INVALID_PATH'));
  assert.equal(existsSync(join(elsewhere, 'new.md')), false);
  assert.equal(readFileSync(join(elsewhere, 'secret.md'), 'utf8'), 'TOP SECRET');
  const res = await v.scan();
  assert.equal(v.index.get('leak.md'), null);
  assert.equal(v.index.get('linkdir/secret.md'), null);
  assert.deepEqual(v.index.issues().filter((i) => i.kind === 'symlink').map((i) => i.path).sort(), ['leak.md', 'linkdir']);
  assert.ok(res.issues >= 2);
});

test('append: to the end, under a heading, creating the note and the heading', () => {
  const v = h.vault();
  const a = v.appendNote('Log.md', 'first entry', { actor: AGENT });
  assert.equal(a.created, true);
  assert.equal(readOutside(v, 'Log.md'), 'first entry\n');
  v.appendNote('Log.md', 'second\nentry', { actor: AGENT });
  assert.equal(readOutside(v, 'Log.md'), 'first entry\nsecond\nentry\n');
  outside(v, 'Doc.md', '# Doc\n\n## Inbox\n- a\n\n## Done\n- z\n');
  v.appendNote('Doc.md', '- b', { actor: AGENT, heading: 'Inbox' });
  assert.equal(readOutside(v, 'Doc.md'), '# Doc\n\n## Inbox\n- a\n- b\n\n## Done\n- z\n');
  v.appendNote('Doc.md', '- y', { actor: AGENT, heading: 'Done' });
  assert.equal(readOutside(v, 'Doc.md'), '# Doc\n\n## Inbox\n- a\n- b\n\n## Done\n- z\n- y\n');
  v.appendNote('Doc.md', 'text', { actor: AGENT, heading: 'New section' });
  assert.equal(readOutside(v, 'Doc.md').endsWith('\n\n## New section\n\ntext\n'), true);
  // A note with no trailing newline, and CRLF.
  outside(v, 'NoEol.md', 'abc');
  v.appendNote('NoEol.md', 'def', { actor: AGENT });
  assert.equal(readOutside(v, 'NoEol.md'), 'abc\ndef\n');
  outside(v, 'Crlf.md', 'a\r\nb\r\n');
  v.appendNote('Crlf.md', 'c\nd', { actor: AGENT });
  assert.equal(readOutside(v, 'Crlf.md'), 'a\r\nb\r\nc\r\nd\r\n');
});

test('edit: one exact, unique replacement, with the version', () => {
  const v = h.vault();
  const w = v.writeNote('E.md', 'alpha beta gamma beta', { actor: UI, create: true });
  assert.throws(() => v.editNote('E.md', 'beta', 'B', { actor: AGENT, baseVersion: w.version }), reason('NOT_UNIQUE'));
  assert.throws(() => v.editNote('E.md', 'delta', 'D', { actor: AGENT, baseVersion: w.version }), reason('NOT_UNIQUE'));
  assert.throws(() => v.editNote('E.md', 'alpha', 'A', { actor: AGENT }), reason('CONFLICT'));
  assert.throws(() => v.editNote('E.md', 'alpha', 'A', { actor: AGENT, baseVersion: 'ffffffffffffffff' }), reason('CONFLICT'));
  const e = v.editNote('E.md', 'alpha ', 'ALPHA ', { actor: AGENT, baseVersion: w.version });
  assert.equal(readOutside(v, 'E.md'), 'ALPHA beta gamma beta');
  assert.equal(e.created, false);
});

test('history: the original is kept, same-actor edits within the window make one version, other actors and later edits make more', () => {
  const v = h.vault();
  outside(v, 'H.md', 'original');
  h.clock.now = new Date('2026-10-12T10:00:00Z');
  let cur = v.readNote('H.md');
  let w = v.writeNote('H.md', 'v1', { actor: UI, baseVersion: cur.version });
  h.clock.now = new Date('2026-10-12T10:01:00Z');
  w = v.writeNote('H.md', 'v1b', { actor: UI, baseVersion: w.version });
  h.clock.now = new Date('2026-10-12T10:02:00Z');
  w = v.writeNote('H.md', 'v1c', { actor: UI, baseVersion: w.version });
  let rows = h.journal.history(v.id, 'H.md');
  assert.deepEqual(rows.map((r) => [r.op, r.actor, r.note]), [['edit', 'ui', ''], ['external', 'external', 'original']]);
  assert.equal(h.journal.version(v.id, rows[0]!.id)!.content, 'v1c');
  assert.equal(h.journal.version(v.id, rows[1]!.id)!.content, 'original');
  // An agent edits: its own row. The same agent again in the window: coalesced.
  h.clock.now = new Date('2026-10-12T10:03:00Z');
  w = v.writeNote('H.md', 'agent1', { actor: AGENT, baseVersion: w.version });
  h.clock.now = new Date('2026-10-12T10:04:00Z');
  w = v.writeNote('H.md', 'agent2', { actor: AGENT, baseVersion: w.version });
  // A person edits after more than five minutes: a new row.
  h.clock.now = new Date('2026-10-12T10:30:00Z');
  w = v.writeNote('H.md', 'ui2', { actor: UI, baseVersion: w.version });
  rows = h.journal.history(v.id, 'H.md');
  assert.deepEqual(rows.map((r) => r.actor), ['ui', 'portal-mcp:tok1', 'ui', 'external']);
  const a = h.journal.authorship(v.id, 'H.md');
  assert.deepEqual([a.lastActor, a.lastKind, a.agentOnly, a.count], ['ui', 'user', false, 4]);
  // Restore writes an old version as a new change; history is never rewritten.
  const agentRow = rows[1]!;
  h.clock.now = new Date('2026-10-12T11:30:00Z');
  const restored = v.restoreVersion('H.md', agentRow.id, { actor: UI });
  assert.equal(readOutside(v, 'H.md'), 'agent2');
  assert.equal(restored.unchanged, false);
  assert.equal(h.journal.history(v.id, 'H.md')[0]!.op, 'restore');
  assert.throws(() => v.restoreVersion('Other.md', agentRow.id, { actor: UI }), reason('NOT_FOUND'));
});

test('an agent-written note is agent-only until a person touches it', () => {
  const v = h.vault();
  v.writeNote('Agent.md', 'by agent', { actor: AGENT, create: true });
  assert.equal(h.journal.authorship(v.id, 'Agent.md').agentOnly, true);
  assert.deepEqual([...h.journal.agentOnlyPaths(v.id, ['Agent.md', 'Missing.md'])], ['Agent.md']);
  h.clock.now = new Date(h.clock.now.getTime() + 3_600_000);
  v.writeNote('Agent.md', 'edited by a person', { actor: UI, baseVersion: v.readNote('Agent.md').version });
  assert.equal(h.journal.authorship(v.id, 'Agent.md').agentOnly, false);
  // A note a person made first is theirs even after an agent appends.
  v.writeNote('Mine.md', 'mine', { actor: UI, create: true });
  v.appendNote('Mine.md', 'agent adds', { actor: SESSION });
  assert.equal(h.journal.authorship(v.id, 'Mine.md').agentOnly, false);
});

test('delete keeps the last text in history and restore brings it back', () => {
  const v = h.vault();
  v.writeNote('Gone.md', 'precious', { actor: UI, create: true });
  v.deleteNote('Gone.md', { actor: UI });
  assert.equal(existsSync(join(v.root, 'Gone.md')), false);
  assert.throws(() => v.readNote('Gone.md'), reason('NOT_FOUND'));
  assert.deepEqual(v.deletedNotes().map((d) => d.path), ['Gone.md']);
  const last = h.journal.lastContent(v.id, 'Gone.md')!;
  const back = v.restoreVersion('Gone.md', last.id, { actor: UI });
  assert.equal(back.created, true);
  assert.equal(readOutside(v, 'Gone.md'), 'precious');
  assert.deepEqual(v.deletedNotes(), []);
});

test('rename rewrites links in their own style, keeps history, and nothing is left unresolved', async () => {
  const v = h.vault();
  v.writeNote('Target.md', '# Head\ntext ^blk', { actor: UI, create: true });
  v.writeNote('A.md', '[[Target]] and [[Target#Head|shown]] ![[Target]] [md](Target.md) [rel](./Target.md#Head) [angle](<Target.md>) [[Target#^blk]]', { actor: UI, create: true });
  v.writeNote('sub/B.md', '[[Target]] [up](../Target.md) [root](/Target.md) [[other]]', { actor: UI, create: true });
  v.writeNote('other.md', 'unrelated [[Target.md]]', { actor: UI, create: true });
  h.clock.now = new Date(h.clock.now.getTime() + 3_600_000);
  const res = await v.renameNote('Target.md', 'Renamed/New Name.md', { actor: UI });
  assert.equal(res.renamed, true);
  assert.deepEqual(res.rewritten.sort(), ['A.md', 'other.md', 'sub/B.md']);
  assert.equal(
    readOutside(v, 'A.md'),
    '[[New Name]] and [[New Name#Head|shown]] ![[New Name]] [md](<Renamed/New Name.md>) [rel](<Renamed/New Name.md#Head>) [angle](<Renamed/New Name.md>) [[New Name#^blk]]',
  );
  assert.equal(readOutside(v, 'sub/B.md'), '[[New Name]] [up](<../Renamed/New Name.md>) [root](</Renamed/New Name.md>) [[other]]');
  assert.equal(readOutside(v, 'other.md'), 'unrelated [[New Name.md]]');
  assert.equal(existsSync(join(v.root, 'Target.md')), false);
  assert.equal(readOutside(v, 'Renamed/New Name.md'), '# Head\ntext ^blk');
  // Every link in the vault resolves to the moved note, with its heading and block still found.
  for (const p of ['A.md', 'sub/B.md', 'other.md']) {
    for (const l of v.index.outgoing(v.index.get(p)!.id).filter((x) => /name/i.test(x.target))) assert.equal(l.to, 'Renamed/New Name.md', `${p}: ${l.target}`);
  }
  assert.deepEqual(v.index.health().unresolved, []);
  assert.deepEqual(v.index.health().anchors, []);
  // History followed the note, and the rewritten notes have an entry by the same actor.
  assert.equal(h.journal.history(v.id, 'Target.md').length, 0);
  assert.equal(h.journal.history(v.id, 'Renamed/New Name.md')[0]!.op, 'rename');
  assert.equal(h.journal.history(v.id, 'A.md')[0]!.note, 'link to Target.md updated');
  // Renaming onto an existing name, or to a bad name, changes nothing.
  v.writeNote('Taken.md', 'x', { actor: UI, create: true });
  await assert.rejects(v.renameNote('Renamed/New Name.md', 'Taken.md', { actor: UI }), reason('EXISTS'));
  await assert.rejects(v.renameNote('Renamed/New Name.md', 'bad:name.md', { actor: UI }), reason('INVALID_PATH'));
  assert.equal(existsSync(join(v.root, 'Renamed', 'New Name.md')), true);
});

test('rename: a name that is no longer unique is linked by its path', async () => {
  const v = h.vault();
  v.writeNote('x/Same.md', 'x', { actor: UI, create: true });
  v.writeNote('Old.md', 'old', { actor: UI, create: true });
  v.writeNote('Link.md', '[[Old]]', { actor: UI, create: true });
  await v.renameNote('Old.md', 'y/Same.md', { actor: UI });
  assert.equal(readOutside(v, 'Link.md'), '[[y/Same]]');
  assert.equal(v.index.outgoing(v.index.get('Link.md')!.id)[0]!.to, 'y/Same.md');
});

test('scan: finds files added outside, edits, deletes and renames; journals outside edits of notes that have history', async () => {
  const v = h.vault();
  outside(v, 'one.md', 'one [[two]]');
  outside(v, 'two.md', 'two');
  outside(v, 'img/pic.png', Buffer.from([137, 80, 78, 71]));
  outside(v, '.obsidian/app.json', '{}');
  outside(v, '.trash/old.md', 'trash');
  outside(v, 'run.sh', 'echo');
  outside(v, 'page.html', '<script>');
  outside(v, 'binary.md', Buffer.from([0xff, 0xfe, 0xfd]));
  outside(v, 'Case.md', 'a');
  outside(v, 'case.md', 'b');
  let r = await v.scan();
  assert.equal(r.notes, 3, 'one, two, and one of the case pair');
  assert.deepEqual(v.index.recent(10).map((f) => f.path).sort(), ['Case.md', 'one.md', 'two.md']);
  assert.equal(v.index.get('img/pic.png')!.kind, 'file');
  assert.equal(v.index.get('.obsidian/app.json'), null);
  const kinds = v.index.issues().map((i) => `${i.kind}:${i.path}`).sort();
  assert.deepEqual(kinds, ['case-collision:case.md', 'not-utf8:binary.md', 'skipped-dangerous:page.html', 'skipped-dangerous:run.sh']);
  assert.equal(v.index.outgoing(v.index.get('one.md')!.id)[0]!.to, 'two.md');

  // Nothing changed: nothing happens.
  r = await v.scan();
  assert.deepEqual([r.added, r.changed, r.removed, r.renamed], [0, 0, 0, 0]);

  // A note with portal history is edited outside: the new text is a history row. One without isn't.
  v.writeNote('two.md', 'two edited by me', { actor: UI, baseVersion: v.readNote('two.md').version });
  h.clock.now = new Date(h.clock.now.getTime() + 3_600_000);
  outside(v, 'two.md', 'two edited elsewhere', Date.now() + 5000);
  outside(v, 'one.md', 'one edited elsewhere [[two]]', Date.now() + 5000);
  r = await v.scan();
  assert.equal(r.changed, 2);
  assert.deepEqual(h.journal.history(v.id, 'two.md').map((x) => [x.op, x.actor]).slice(0, 2), [['external', 'external'], ['edit', 'ui']]);
  assert.equal(h.journal.history(v.id, 'one.md').length, 0);
  assert.equal(v.readNote('two.md').text, 'two edited elsewhere');

  // A rename outside (same content, new name) keeps the history; a delete is recorded for notes with history.
  const bytes = readFileSync(join(v.root, 'two.md'));
  rmSync(join(v.root, 'two.md'));
  outside(v, 'moved/Two renamed.md', bytes);
  rmSync(join(v.root, 'one.md'));
  r = await v.scan();
  assert.deepEqual([r.renamed, r.removed], [1, 2]);
  assert.equal(h.journal.history(v.id, 'moved/Two renamed.md')[0]!.op, 'rename');
  assert.equal(h.journal.history(v.id, 'two.md').length, 0);
  assert.equal(v.index.get('one.md'), null);
});

test('reading brings a stale index up to date without waiting for a scan', () => {
  const v = h.vault();
  v.writeNote('Live.md', 'before', { actor: UI, create: true });
  outside(v, 'Live.md', 'after, edited elsewhere with a [[link]] and #tag', Date.now() + 10_000);
  const r = v.readNote('Live.md');
  assert.equal(r.text.startsWith('after'), true);
  assert.deepEqual(v.index.tagsOf(v.index.get('Live.md')!.id), ['tag']);
  // A note created outside and never scanned can still be opened.
  outside(v, 'Fresh.md', 'new outside');
  assert.equal(v.readNote('Fresh.md').text, 'new outside');
  // Names are matched case-insensitively once indexed, as links are.
  assert.equal(v.readNote('live.md').path, 'Live.md');
});

test('a crash between the journal row and the file: the row is settled by the file on the next open', () => {
  const v = h.vault('v00000000crash');
  v.writeNote('C.md', 'one', { actor: UI, create: true });
  const cur = v.readNote('C.md');
  // A pending row whose file never landed, and one whose file did.
  const lost = h.journal.begin({ vaultId: v.id, path: 'C.md', op: 'edit', actor: UI, baseHash: cur.version, hash: hashOf('never written'), content: 'never written' });
  const landed = h.journal.begin({ vaultId: v.id, path: 'C.md', op: 'edit', actor: AGENT, baseHash: cur.version, hash: cur.version, content: 'one' });
  assert.equal(h.journal.history(v.id, 'C.md').length, 1, 'pending rows are not history');
  v.close();
  const again = h.vault('v00000000crash');
  const rows = h.journal.history(again.id, 'C.md');
  assert.deepEqual(rows.map((r) => r.id).includes(lost), false);
  assert.equal(rows.some((r) => r.id === landed || r.actor === 'portal-mcp:tok1'), true);
});

test('leftover temporary files of an interrupted write are removed at the next open, recent ones are left', () => {
  const v = h.vault('v00000000tmp00');
  v.writeNote('a/b.md', 'x', { actor: UI, create: true });
  const old = join(v.root, 'a', '.pilot-0123456789abcdef.tmp');
  const fresh = join(v.root, 'a', '.pilot-fedcba9876543210.tmp');
  writeFileSync(old, 'half');
  writeFileSync(fresh, 'half');
  const past = new Date(Date.now() - 2 * 3600_000);
  utimesSync(old, past, past);
  v.close();
  const again = h.vault('v00000000tmp00');
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
  assert.equal(readOutside(again, 'a/b.md'), 'x');
});

test('export lists every file, and an import into another vault reproduces them byte for byte', () => {
  const a = h.vault();
  a.writeNote('Notes/One.md', '# One\n[[Two]] #t', { actor: UI, create: true });
  a.writeNote('Two.md', 'two', { actor: UI, create: true });
  a.writeFile('img/a.png', Buffer.from([1, 2, 3, 4]), { actor: UI });
  const entries = [...a.exportEntries()];
  assert.deepEqual(entries.map((e) => e.name), ['Notes/One.md', 'Two.md', 'img/a.png']);
  const b = h.vault();
  for (const e of entries) assert.equal(b.importFile(e.name, e.data, 'skip', { id: 'import', kind: 'system' }).outcome, 'added');
  for (const e of entries) assert.deepEqual(readFileSync(join(b.root, e.name)), e.data);
  assert.equal(b.index.outgoing(b.index.get('Notes/One.md')!.id)[0]!.to, 'Two.md');
  // Conflict policies.
  assert.equal(b.importFile('Two.md', Buffer.from('different'), 'skip', { id: 'import', kind: 'system' }).outcome, 'skipped');
  assert.equal(readOutside(b, 'Two.md'), 'two');
  const kept = b.importFile('Two.md', Buffer.from('different'), 'keep-both', { id: 'import', kind: 'system' });
  assert.deepEqual([kept.outcome, kept.path], ['renamed', 'Two (2).md']);
  const over = b.importFile('Two.md', Buffer.from('overwritten'), 'overwrite', { id: 'import', kind: 'system' });
  assert.equal(over.outcome, 'overwritten');
  assert.equal(readOutside(b, 'Two.md'), 'overwritten');
  // An overwrite is recoverable: the original is in history.
  assert.equal(h.journal.history(b.id, 'Two.md').some((r) => h.journal.version(b.id, r.id)?.content === 'two'), true);
  assert.equal(statSync(join(b.root, 'Two.md')).mode & 0o777, 0o600);
});

test('a read-only vault refuses every change and keeps no history', async () => {
  const src = h.vault('v0000readonly', { readOnly: true });
  outside(src, 'Doc.md', '# Doc\n[[Other]]');
  outside(src, 'Other.md', 'other');
  assert.throws(() => src.writeNote('New.md', 'x', { actor: UI, create: true }), reason('READ_ONLY'));
  assert.throws(() => src.appendNote('Doc.md', 'x', { actor: AGENT }), reason('READ_ONLY'));
  assert.throws(() => src.deleteNote('Doc.md', { actor: UI }), reason('READ_ONLY'));
  await assert.rejects(src.renameNote('Doc.md', 'D2.md', { actor: UI }), reason('READ_ONLY'));
  assert.throws(() => src.writeFile('a.png', Buffer.alloc(1), { actor: UI }), reason('READ_ONLY'));
  assert.equal(readOutside(src, 'Doc.md'), '# Doc\n[[Other]]');
  return src.scan().then(() => {
    assert.equal(src.index.outgoing(src.index.get('Doc.md')!.id)[0]!.to, 'Other.md');
    outside(src, 'Doc.md', '# Doc changed', Date.now() + 5000);
    return src.scan().then(() => assert.equal(h.journal.history(src.id, 'Doc.md').length, 0));
  });
});

test('moving a note to another folder keeps its own relative Markdown links working; wikilinks by name need no change', async () => {
  const v = h.vault();
  v.writeNote('docs/Other.md', 'other', { actor: UI, create: true });
  v.writeNote('docs/Sibling.md', 'sibling', { actor: UI, create: true });
  v.writeNote('top.md', 'top', { actor: UI, create: true });
  v.writeNote('docs/Mover.md', '[a](Other.md) [b](./Sibling.md) [c](../top.md) [[Other]] [d](<Other.md#Head>)', { actor: UI, create: true });
  const before = (p: string) => v.index.outgoing(v.index.get(p)!.id).map((l) => l.to);
  assert.deepEqual(before('docs/Mover.md'), ['docs/Other.md', 'docs/Sibling.md', 'top.md', 'docs/Other.md', 'docs/Other.md']);
  const res = await v.renameNote('docs/Mover.md', 'deep/er/Mover.md', { actor: UI });
  assert.deepEqual(res.rewritten, ['deep/er/Mover.md']);
  // Only links written relative to the note (`./`, `../`) are fixed; bare names find their note wherever it is.
  assert.equal(readOutside(v, 'deep/er/Mover.md'), '[a](Other.md) [b](../../docs/Sibling.md) [c](../../top.md) [[Other]] [d](<Other.md#Head>)');
  assert.deepEqual(before('deep/er/Mover.md'), ['docs/Other.md', 'docs/Sibling.md', 'top.md', 'docs/Other.md', 'docs/Other.md']);
  assert.deepEqual(v.index.health().unresolved, []);
});

test('a hub with many inbound links renames without blocking: it yields, rewrites each note once, and skips notes changed meanwhile', async () => {
  const v = h.vault();
  v.writeNote('Hub.md', 'hub', { actor: UI, create: true });
  v.writeNote('Other/Hub.md', 'another note with the same name', { actor: UI, create: true });
  for (let i = 0; i < 120; i++) v.writeNote(`n/${i}.md`, `see [[Hub]] and [[Hub|alias ${i}]]`, { actor: UI, create: true });
  assert.equal(v.index.outgoing(v.index.get('n/0.md')!.id)[0]!.to, 'Hub.md');
  let yielded = 0;
  const watcher = setInterval(() => yielded++, 1);
  const pending = v.renameNote('Hub.md', 'Central/Hub.md', { actor: UI });
  // A note changes while the rewrite is running: it's left alone, never overwritten.
  v.writeNote('n/119.md', 'changed meanwhile [[Hub]]', { actor: UI, baseVersion: v.readNote('n/119.md').version });
  const res = await pending;
  clearInterval(watcher);
  // The bare name is ambiguous now, so each link says which Hub.
  assert.equal(res.rewritten.length, 119);
  assert.ok(yielded > 0, 'the event loop ran during the rewrite');
  assert.equal(readOutside(v, 'n/0.md'), 'see [[Central/Hub]] and [[Central/Hub|alias 0]]');
  assert.equal(readOutside(v, 'n/119.md'), 'changed meanwhile [[Hub]]');
  assert.equal(v.index.get('Hub.md'), null);
  assert.ok(v.index.get('Central/Hub.md'));
});

test('a scan asked for while one runs waits for the next, so a change made after the first began is seen', async () => {
  const v = h.vault();
  for (let i = 0; i < 30; i++) outside(v, `Many/n${i}.md`, `note ${i}`);
  const first = v.scan();
  outside(v, 'late.md', 'came in after the first scan listed the folder');
  const second = v.scan();
  const third = v.scan();
  assert.equal(third, second, 'askers during one run share the follow-up');
  assert.equal((await first).added, 30, 'the first scan did not see the late file');
  const r = await second;
  assert.ok(v.index.get('late.md'), 'the follow-up did');
  assert.equal(r.added, 1);
  // A scan that fails still lets the next one run.
  assert.equal((await v.scan()).added, 0);
});
