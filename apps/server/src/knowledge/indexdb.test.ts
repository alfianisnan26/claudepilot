import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ftsExpression, parseQuery, VaultIndex } from './indexdb.js';
import { parseNote } from './markdown.js';

const dir = mkdtempSync(join(tmpdir(), 'kg-index-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => new VaultIndex(join(dir, `i${n++}.db`));

function put(idx: VaultIndex, path: string, text: string) {
  const parsed = parseNote(text);
  return idx.upsertNote({ path, disk: null, size: text.length, mtimeMs: Date.now(), hash: createHash('sha256').update(text).digest('hex').slice(0, 16), parsed, body: text.slice(parsed.bodyStart), secret: false });
}

test('links resolve when the target is added later, and unresolve when it is removed', () => {
  const idx = fresh();
  put(idx, 'A.md', 'See [[B]] and [[Missing]] and [[b#Heading]].');
  assert.deepEqual(idx.outgoing(idx.get('A.md')!.id).map((l) => [l.target, l.to]), [['B', null], ['Missing', null], ['b', null]]);
  put(idx, 'sub/B.md', '# Heading\nbody');
  const out = idx.outgoing(idx.get('A.md')!.id);
  assert.deepEqual(out.map((l) => l.to), ['sub/B.md', null, 'sub/B.md']);
  assert.equal(out[2]!.anchorMissing, false);
  assert.deepEqual(idx.backlinks(idx.get('sub/B.md')!.id).map((b) => b.path), ['A.md', 'A.md']);
  assert.equal(idx.backlinkCount(idx.get('sub/B.md')!.id), 1);
  idx.removeFile('sub/B.md');
  assert.deepEqual(idx.outgoing(idx.get('A.md')!.id).map((l) => l.to), [null, null, null]);
  idx.close();
});

test('heading and block anchors are checked, and rechecked when the target changes', () => {
  const idx = fresh();
  put(idx, 'A.md', '[[B#Present]] [[B#Gone]] [[B#^blk]] [[B#^nope]] [[#Local]] [[#Absent]]\n\n# Local');
  put(idx, 'B.md', '# Present\ntext ^blk');
  const miss = () => idx.outgoing(idx.get('A.md')!.id).map((l) => l.anchorMissing);
  assert.deepEqual(miss(), [false, true, false, true, false, true]);
  put(idx, 'B.md', '# Gone\ntext');
  assert.deepEqual(miss(), [true, false, true, true, false, true]);
  idx.close();
});

test('duplicate names resolve by the nearest folder and are flagged ambiguous; unambiguous after one is removed', () => {
  const idx = fresh();
  put(idx, 'x/Note.md', 'x');
  put(idx, 'y/Note.md', 'y');
  put(idx, 'y/src.md', '[[Note]]');
  put(idx, 'x/src.md', '[[Note]]');
  const l = (p: string) => idx.outgoing(idx.get(p)!.id)[0]!;
  assert.deepEqual([l('y/src.md').to, l('y/src.md').ambiguous], ['y/Note.md', true]);
  assert.deepEqual([l('x/src.md').to, l('x/src.md').ambiguous], ['x/Note.md', true]);
  idx.removeFile('x/Note.md');
  assert.deepEqual([l('y/src.md').to, l('y/src.md').ambiguous], ['y/Note.md', false]);
  assert.deepEqual([l('x/src.md').to, l('x/src.md').ambiguous], ['y/Note.md', false]);
  assert.deepEqual(idx.health().duplicates.filter((d) => d.name === 'note'), []);
  idx.close();
});

test('attachments resolve embeds; tags, aliases and headings are read back', () => {
  const idx = fresh();
  put(idx, 'N.md', '---\ntags: [a, b/c]\naliases: [Alias One]\n---\n# Top\n![[pic.png|200]] #inline');
  idx.upsertAttachment({ path: 'img/pic.png', disk: null, size: 10, mtimeMs: 1 });
  const f = idx.get('N.md')!;
  assert.equal(idx.outgoing(f.id)[0]!.to, 'img/pic.png');
  assert.deepEqual(idx.tagsOf(f.id), ['a', 'b/c', 'inline']);
  assert.deepEqual(idx.aliasesOf(f.id), ['Alias One']);
  assert.deepEqual(idx.headingsOf(f.id).map((h) => h.text), ['Top']);
  assert.deepEqual(idx.tags('b'), [{ tag: 'b/c', count: 1 }]);
  assert.equal(idx.stats().notes, 1);
  assert.equal(idx.stats().files, 1);
  idx.close();
});

test('search: words, prefix, phrases, exclusions, filters, diacritics, ranking prefers titles', () => {
  const idx = fresh();
  put(idx, 'Projects/Alpha plan.md', '---\ntags: [work]\n---\nThe quick brown fox jumps over the lazy dog');
  put(idx, 'Projects/Beta.md', 'quick notes about espresso and crème brûlée #food');
  put(idx, 'Journal/quick thoughts.md', 'Nothing special here');
  const find = (q: string) => idx.search(parseQuery(q), 20, 0).rows.map((r) => r.path);
  assert.deepEqual(find('brown fox'), ['Projects/Alpha plan.md']);
  assert.deepEqual(find('creme brulee'), ['Projects/Beta.md']);
  assert.deepEqual(find('qui')[0], 'Journal/quick thoughts.md'); // prefix; the title match ranks first
  assert.deepEqual(find('"brown fox"'), ['Projects/Alpha plan.md']);
  assert.deepEqual(find('"fox brown"'), []);
  assert.deepEqual(find('quick -espresso').sort(), ['Journal/quick thoughts.md', 'Projects/Alpha plan.md']);
  assert.deepEqual(find('quick tag:work'), ['Projects/Alpha plan.md']);
  assert.deepEqual(find('quick folder:journal'), ['Journal/quick thoughts.md']);
  assert.deepEqual(find('tag:food'), ['Projects/Beta.md']);
  assert.deepEqual(find('quick file:beta'), ['Projects/Beta.md']);
  assert.deepEqual(find('"; DROP TABLE files; --'), []);
  assert.deepEqual(find('AND OR NOT NEAR'), []);
  assert.deepEqual(find('quick* ( ) :'), idx.search(parseQuery('quick'), 20, 0).rows.map((r) => r.path));
  assert.equal(idx.search(parseQuery('quick'), 1, 0).total, 3);
  idx.close();
});

test('the FTS expression only ever contains quoted terms', () => {
  assert.equal(ftsExpression(parseQuery('foo bar')), '"foo" AND "bar"*');
  assert.equal(ftsExpression(parseQuery('foo bar ')), '"foo" AND "bar"');
  assert.equal(ftsExpression(parseQuery('"two words" -skip')), '("two words") NOT ("skip")');
  assert.equal(ftsExpression(parseQuery('tag:x')), null);
});

test('quick switcher: exact, prefix, contains, alias, path and subsequence matches', () => {
  const idx = fresh();
  put(idx, 'Daily/2026-10-11.md', '');
  put(idx, 'Alpha plan.md', '---\naliases: [Roadmap]\n---\n');
  put(idx, 'Notes/Planning.md', '');
  put(idx, 'Zebra.md', '');
  const q = (s: string) => idx.quick(s, 10).map((h) => h.path);
  assert.deepEqual(q('zebra'), ['Zebra.md']);
  assert.equal(q('plan')[0], 'Notes/Planning.md'); // prefix of the name beats a contains match
  assert.ok(q('plan').includes('Alpha plan.md'));
  const road = idx.quick('road', 5)[0]!;
  assert.deepEqual([road.path, road.alias], ['Alpha plan.md', 'Roadmap']);
  assert.deepEqual(q('daily 2026'), ['Daily/2026-10-11.md']);
  assert.deepEqual(q('zbr'), ['Zebra.md']);
  idx.close();
});

test('health: unresolved with sources, ambiguous, orphans, missing anchors, broken embeds', () => {
  const idx = fresh();
  put(idx, 'A.md', '[[Nope]] [[Nope]] ![[gone.png]] [[B#Missing]]');
  put(idx, 'B.md', 'text');
  put(idx, 'Lonely.md', 'x');
  put(idx, 'C.md', '[[D]]');
  put(idx, 'sub/D.md', '');
  put(idx, 'other/D.md', '');
  const h = idx.health();
  assert.deepEqual(h.unresolved, [{ target: 'Nope', count: 2, sources: ['A.md'] }]);
  assert.deepEqual(h.ambiguous.map((a) => a.target), ['D']);
  // C's [[D]] resolves to the shortest path (sub/D.md), so other/D.md has no links in or out.
  assert.deepEqual(h.orphans, ['Lonely.md', 'other/D.md']);
  assert.deepEqual(h.anchors.map((a) => [a.path, a.heading]), [['A.md', 'Missing']]);
  assert.deepEqual(h.embeds.map((e) => e.target), ['gone.png']);
  assert.deepEqual(h.duplicates.map((d) => d.name), ['d']);
  idx.close();
});

test('tree listing: folders with counts, files in a folder, empty folders from the scan', () => {
  const idx = fresh();
  put(idx, 'a/b/one.md', '');
  put(idx, 'a/two.md', '');
  put(idx, 'root.md', '');
  idx.addDir('empty/deeper');
  const root = idx.listFolder('');
  assert.deepEqual(root.folders.map((f) => [f.name, f.count]), [['a', 2], ['empty', 0]]);
  assert.deepEqual(root.files.map((f) => f.path), ['root.md']);
  const a = idx.listFolder('a');
  assert.deepEqual(a.folders.map((f) => [f.path, f.count]), [['a/b', 1]]);
  assert.deepEqual(a.files.map((f) => f.path), ['a/two.md']);
  assert.deepEqual(idx.listFolder('empty').folders.map((f) => f.path), ['empty/deeper']);
  idx.close();
});

test('a damaged or old-schema index file is replaced with an empty one, not an error', () => {
  const file = join(dir, 'old.db');
  const a = new VaultIndex(file);
  put(a, 'x.md', 'hello');
  a.db.exec('PRAGMA user_version = 1');
  a.close();
  const b = new VaultIndex(file);
  assert.equal(b.stats().notes, 0);
  b.close();
});
