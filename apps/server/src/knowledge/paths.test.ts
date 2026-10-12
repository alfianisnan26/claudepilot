import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { classifyFile, attachmentType } from './attachments.js';
import { cleanPath, ensureDir, extOf, folderOf, isHiddenPath, noteName, resolveSafe } from './paths.js';

const bad = (raw: unknown, strict = true) => assert.throws(() => cleanPath(raw, { strict }), (e: unknown) => (e as { reason?: string }).reason === 'INVALID_PATH', String(raw));
const ok = (raw: string, strict = true) => cleanPath(raw, { strict });

test('paths: traversal, absolute, backslash, control characters, dot parts, empty parts', () => {
  for (const p of ['../x.md', 'a/../../x.md', '/abs.md', 'C:/win.md', 'c:x.md', 'a\\b.md', 'a/./b.md', 'a//b.md', 'a/b/', '', 'a\u0000b.md', 'a\nb.md', 'tab\there.md', 'a/..', '..', '.']) bad(p);
  bad(42);
  bad(null);
  assert.equal(cleanPath('', { strict: true, folder: true }), '');
  assert.equal(cleanPath('a/b/', { strict: true, folder: true }), 'a/b');
});

test('paths: hidden entries are never part of a vault', () => {
  for (const p of ['.obsidian/app.json', 'a/.trash/x.md', '.hidden.md', 'a/.git/config']) {
    bad(p);
    bad(p, false);
  }
  assert.equal(isHiddenPath('a/.obsidian/x'), true);
  assert.equal(isHiddenPath('__MACOSX/x.md'), true);
  assert.equal(isHiddenPath('Thumbs.db'), true);
  assert.equal(isHiddenPath('~$draft.docx'), true);
  assert.equal(isHiddenPath('a/b/c.md'), false);
});

test('paths: new names refuse what breaks links or other systems; existing names are kept in lenient mode', () => {
  for (const p of ['a:b.md', 'a*b.md', 'a?b.md', 'a"b.md', 'a<b.md', 'a>b.md', 'a|b.md', 'a#b.md', 'a^b.md', 'a[b].md', 'trailing space .md ', 'dot.', ' lead.md', 'CON.md', 'nul', 'Aux.txt', 'com3.md', 'LPT9.md', 'a/prn/x.md', 'a\u202eb.md', 'zero\u200bwidth.md']) bad(p);
  for (const p of ['ab:c.md', 'a*b.md', 'a#b.md', 'a[b].md', 'CON.md', 'a|b.md']) assert.equal(ok(p, false), p);
  assert.equal(ok('Straße & café – 日本語 (2).md'), 'Straße & café – 日本語 (2).md');
});

test('paths: normalized to NFC; segment, path and depth limits', () => {
  const nfd = 'Cafe\u0301.md';
  assert.equal(ok(nfd), 'Café.md');
  assert.equal(ok(nfd).length, 7);
  bad(`${'x'.repeat(256)}.md`);
  assert.equal(ok(`${'x'.repeat(250)}.md`).length, 253);
  bad(`${'é'.repeat(130)}.md`); // 260 bytes
  bad(`${Array(40).fill('d').join('/')}/n.md`);
  bad(`${'a/'.repeat(600)}n.md`);
});

test('path helpers', () => {
  assert.equal(folderOf('a/b/c.md'), 'a/b');
  assert.equal(folderOf('c.md'), '');
  assert.equal(noteName('a/My Note.md'), 'My Note');
  assert.equal(extOf('a/pic.PNG'), 'png');
  assert.equal(extOf('a/noext'), '');
  assert.equal(extOf('a/.hidden'), '');
});

const dir = mkdtempSync(join(tmpdir(), 'kg-paths-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('resolveSafe and ensureDir never go through a symlink', () => {
  const root = join(dir, 'vault');
  const elsewhere = join(dir, 'elsewhere');
  mkdirSync(root);
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'secret.md'), 'secret');
  symlinkSync(elsewhere, join(root, 'linkdir'));
  symlinkSync(join(elsewhere, 'secret.md'), join(root, 'leak.md'));
  mkdirSync(join(root, 'real'));
  writeFileSync(join(root, 'real', 'ok.md'), 'ok');
  assert.equal(resolveSafe(root, 'real/ok.md'), join(root, 'real', 'ok.md'));
  assert.equal(resolveSafe(root, 'real/new/deeper.md'), join(root, 'real', 'new', 'deeper.md'));
  for (const p of ['linkdir/secret.md', 'linkdir', 'leak.md', 'linkdir/new/x.md']) assert.throws(() => resolveSafe(root, p), (e: unknown) => (e as { reason?: string }).reason === 'INVALID_PATH', p);
  assert.throws(() => resolveSafe(root, 'real/ok.md/under'), (e: unknown) => (e as { reason?: string }).reason === 'INVALID_PATH');
  assert.throws(() => ensureDir(root, 'linkdir/made'), (e: unknown) => (e as { reason?: string }).reason === 'INVALID_PATH');
  assert.equal(ensureDir(root, 'real/a/b'), join(root, 'real', 'a', 'b'));
});

test('attachments: an allow-list by extension; nothing that runs is on it', () => {
  assert.deepEqual(attachmentType('x/pic.PNG'), { mime: 'image/png', inline: true });
  assert.deepEqual(attachmentType('doc.pdf'), { mime: 'application/pdf', inline: true });
  assert.equal(attachmentType('sheet.xlsx')!.inline, false);
  assert.equal(attachmentType('logo.svg')!.inline, false, 'svg can carry script: it downloads');
  for (const name of ['page.html', 'a.htm', 'x.xhtml', 'x.js', 'x.mjs', 'run.sh', 'a.exe', 'a.bat', 'x.jar', 'noext', 'x.svgz', 'x.php']) assert.equal(attachmentType(name), null, name);
  assert.deepEqual(classifyFile('Note.md'), { kind: 'note' });
  assert.equal(classifyFile('x.html').kind, 'skip');
  assert.deepEqual(classifyFile('x.html'), { kind: 'skip', reason: 'dangerous', ext: 'html' });
  assert.deepEqual(classifyFile('x.weird'), { kind: 'skip', reason: 'type', ext: 'weird' });
  assert.deepEqual(classifyFile('.obsidian/plugins/a.js'), { kind: 'skip', reason: 'hidden', ext: 'js' });
});
