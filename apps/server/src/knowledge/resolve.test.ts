import assert from 'node:assert/strict';
import { test } from 'node:test';
import { folderOf, foldPath } from './paths.js';
import { joinRelative, linkBase, linkTextFor, NameTable, resolveTarget, type FileRef } from './resolve.js';

function table(paths: string[]): NameTable {
  const t = new NameTable();
  paths.forEach((p, i) => {
    const note = /\.md$/i.test(p);
    const base = p.slice(p.lastIndexOf('/') + 1);
    t.add({ id: i + 1, path: p, lpath: foldPath(p), kind: note ? 'note' : 'file', lname: foldPath(note ? base.replace(/\.md$/i, '') : base), folder: folderOf(p) } satisfies FileRef);
  });
  return t;
}
const at = (t: NameTable, target: string, src = '', embed = false) => {
  const r = resolveTarget(t, { target, embed }, src);
  return [r.file?.path ?? null, r.ambiguous] as const;
};

test('a bare name: case-insensitive, .md optional, spaces and unicode', () => {
  const t = table(['Projects/Alpha Plan.md', 'Café.md', 'Notes/日本語.md']);
  assert.deepEqual(at(t, 'alpha plan'), ['Projects/Alpha Plan.md', false]);
  assert.deepEqual(at(t, 'Alpha Plan.md'), ['Projects/Alpha Plan.md', false]);
  assert.deepEqual(at(t, 'CAFÉ'), ['Café.md', false]);
  assert.deepEqual(at(t, '日本語'), ['Notes/日本語.md', false]);
  assert.deepEqual(at(t, 'missing'), [null, false]);
  assert.deepEqual(at(t, ''), [null, false]);
});

test('a path from the root, the tail of a path, and a path relative to the linking note', () => {
  const t = table(['a/b/Note.md', 'x/Note.md', 'a/Other.md', 'docs/prd/one.md', 'docs/prd/two.md', 'docs/README.md']);
  assert.deepEqual(at(t, 'a/b/Note'), ['a/b/Note.md', false]);
  assert.deepEqual(at(t, 'b/Note'), ['a/b/Note.md', false]);
  assert.deepEqual(at(t, '/x/Note.md'), ['x/Note.md', false]);
  assert.deepEqual(at(t, '../README.md', 'docs/prd'), ['docs/README.md', false]);
  assert.deepEqual(at(t, 'two.md', 'docs/prd'), ['docs/prd/two.md', false]);
  assert.deepEqual(at(t, './one.md', 'docs/prd'), ['docs/prd/one.md', false]);
  assert.deepEqual(at(t, '../../../up.md', 'docs/prd'), [null, false]);
});

test('duplicates: the same folder, then the closest, then the shortest path; flagged ambiguous', () => {
  const t = table(['Note.md', 'a/Note.md', 'a/b/Note.md', 'c/d/e/Note.md']);
  assert.deepEqual(at(t, 'Note', 'a/b'), ['a/b/Note.md', true]);
  assert.deepEqual(at(t, 'Note', 'a'), ['a/Note.md', true]);
  assert.deepEqual(at(t, 'Note', 'a/b/z'), ['a/b/Note.md', true]);
  assert.deepEqual(at(t, 'Note', 'c'), ['c/d/e/Note.md', true]); // shares the folder `c`; the root note shares nothing
  assert.deepEqual(at(t, 'Note', 'zzz'), ['Note.md', true]); // nothing shared: the shortest path
  assert.deepEqual(at(t, 'Note'), ['Note.md', true]);
  // A full path is exact, so not ambiguous even though the name repeats.
  assert.deepEqual(at(t, 'a/Note'), ['a/Note.md', false]);
});

test('attachments: embeds and extensions prefer files; a dotted note name still finds its note', () => {
  const t = table(['img/pic.png', 'Release 1.2.md', 'pic.md', 'doc.pdf']);
  assert.deepEqual(at(t, 'pic.png', '', true), ['img/pic.png', false]);
  assert.deepEqual(at(t, 'pic.png'), ['img/pic.png', false]);
  assert.deepEqual(at(t, 'pic'), ['pic.md', false]);
  assert.deepEqual(at(t, 'Release 1.2'), ['Release 1.2.md', false]);
  assert.deepEqual(at(t, 'doc.pdf'), ['doc.pdf', false]);
  assert.deepEqual(at(t, 'img/pic.png'), ['img/pic.png', false]);
});

test('helpers', () => {
  assert.equal(joinRelative('a/b', '../c'), 'a/c');
  assert.equal(joinRelative('', '../c'), null);
  assert.equal(linkBase('Folder/Deep Note.md'), 'deep note');
  assert.equal(linkBase('img/Pic.PNG'), 'pic.png');
  const t = table(['a/Same.md', 'b/Same.md', 'c/Unique.md']);
  assert.equal(linkTextFor(t, t.byPath('c/unique.md')!), 'Unique');
  assert.equal(linkTextFor(t, t.byPath('a/same.md')!), 'a/Same');
});
