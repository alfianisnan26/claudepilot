import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTag, endOfSection, maskText, normHeading, parseNote, sectionOf } from './markdown.js';

const wiki = (text: string) => parseNote(text).links.filter((l) => l.style === 'wiki');

test('wikilinks: plain, alias, heading, nested heading, block, same-note, embeds with sizes', () => {
  const text = [
    'See [[Note]] and [[Folder/Deep note|the alias]] and [[Note#Some Heading]].',
    'Block [[Note#^abc-12]] and same [[#Local heading]] and nested [[Note#H1#H2]].',
    '![[image.png|300]] ![[image.png|300x200]] ![[Other#Section]] ![[Other#^blk]]',
  ].join('\n');
  const links = wiki(text);
  assert.deepEqual(
    links.map((l) => [l.embed, l.target, l.heading, l.block, l.alias]),
    [
      [false, 'Note', null, null, null],
      [false, 'Folder/Deep note', null, null, 'the alias'],
      [false, 'Note', 'Some Heading', null, null],
      [false, 'Note', null, 'abc-12', null],
      [false, '', 'Local heading', null, null],
      [false, 'Note', 'H1#H2', null, null],
      [true, 'image.png', null, null, '300'],
      [true, 'image.png', null, null, '300x200'],
      [true, 'Other', 'Section', null, null],
      [true, 'Other', null, 'blk', null],
    ],
  );
  // Offsets slice the original text back to exactly the link syntax, lines are 1-based.
  for (const l of links) assert.match(text.slice(l.start, l.end), /^!?\[\[.*\]\]$/);
  assert.equal(links[0]!.line, 1);
  assert.equal(links[3]!.line, 2);
  assert.equal(links[6]!.line, 3);
});

test('a table cell escapes the alias pipe; the backslash is not part of the target', () => {
  const [l] = wiki('| a | b |\n| - | - |\n| [[Note\\|alias]] | x |');
  assert.equal(l!.target, 'Note');
  assert.equal(l!.alias, 'alias');
});

test('links in code, comments and math are not links; masking keeps every offset', () => {
  const text = [
    'real [[A]]',
    '```md',
    'fenced [[B]] #fenced',
    '```',
    '`inline [[C]]` and ``double `tick` [[D]]``',
    '%% hidden [[E]] %% shown [[F]]',
    '<!-- [[G]] -->',
    '$$',
    '[[H]]',
    '$$',
    '~~~',
    '[[I]]',
    '~~~',
  ].join('\n');
  const names = wiki(text).map((l) => l.target);
  assert.deepEqual(names, ['A', 'F']);
  assert.equal(maskText(text, 0).length, text.length);
});

test('a longer fence is closed only by a fence at least as long', () => {
  const text = ['````', '```', '[[In]]', '```', '````', '[[Out]]'].join('\n');
  assert.deepEqual(wiki(text).map((l) => l.target), ['Out']);
});

test('tags: nested, unicode, numbers, boundaries, code and frontmatter', () => {
  const text = [
    '---',
    'tags: [alpha, "#beta", Gamma/Sub]',
    '---',
    'Body #inline and #nested/deep and #日本語 and #über-cool #2024 #123 a#notatag http://x.com/#frag (#anchor)',
    '`#code` and a heading',
    '# Real heading',
    '```',
    '#fenced',
    '```',
  ].join('\n');
  const p = parseNote(text);
  assert.deepEqual(
    p.tags.map((t) => `${t.source}:${t.tag}`).sort(),
    ['frontmatter:alpha', 'frontmatter:beta', 'frontmatter:gamma/sub', 'inline:inline', 'inline:nested/deep', 'inline:über-cool', 'inline:日本語'].sort(),
  );
  assert.equal(cleanTag('123'), null);
  assert.equal(cleanTag('2024'), null);
  assert.equal(cleanTag('2024-plan'), '2024-plan');
  assert.equal(cleanTag('#a/b/'), 'a/b');
  assert.equal(cleanTag('has space'), null);
});

test('frontmatter: tags as a string or a block list, singular keys, aliases, title', () => {
  const a = parseNote('---\ntags: one, two three\naliases: First, Second\n---\n# T');
  assert.deepEqual(a.tags.map((t) => t.tag), ['one', 'two', 'three']);
  assert.deepEqual(a.aliases, ['First', 'Second']);
  const b = parseNote('---\ntag:\n  - x\n  - y/z\nalias: [Solo]\ntitle: A Title\n---\n');
  assert.deepEqual(b.tags.map((t) => t.tag), ['x', 'y/z']);
  assert.deepEqual(b.aliases, ['Solo']);
  assert.equal(b.title, 'A Title');
});

test('frontmatter edge cases: empty, none, BOM, CRLF, invalid, not a mapping, unterminated, `...` terminator', () => {
  assert.equal(parseNote('---\n---\nbody').hasFrontmatter, true);
  assert.deepEqual(parseNote('---\n---\nbody').frontmatter, {});
  assert.equal(parseNote('no frontmatter\n---\ntags: x\n---').hasFrontmatter, false);
  const bom = parseNote('﻿---\ntags: [a]\n---\nbody');
  assert.equal(bom.hasFrontmatter, true);
  assert.deepEqual(bom.tags.map((t) => t.tag), ['a']);
  const crlf = parseNote('---\r\ntags: [a]\r\n---\r\n# H\r\nbody');
  assert.equal(crlf.hasFrontmatter, true);
  assert.equal(crlf.headings[0]!.text, 'H');
  const bad = parseNote('---\nfoo: [unclosed\n---\n[[Still a link]]');
  assert.equal(bad.hasFrontmatter, true);
  assert.match(bad.frontmatterError ?? '', /Not valid YAML/);
  assert.deepEqual(bad.links.map((l) => l.target), ['Still a link']);
  assert.match(parseNote('---\n- a\n- b\n---\n').frontmatterError ?? '', /mapping/);
  assert.equal(parseNote('---\ntags: [a]\nno end').hasFrontmatter, false);
  assert.equal(parseNote('---\ntags: [a]\n...\nbody').hasFrontmatter, true);
  // Tags inside frontmatter text are not inline tags, and links in it are not links.
  assert.deepEqual(parseNote('---\nnote: "#nottag [[NotLink]]"\n---\n').links, []);
});

test('a frontmatter bomb is cut down: aliases and depth are bounded', () => {
  const lines = ['a0: &a0 [x, x, x, x, x, x, x, x, x, x]'];
  for (let i = 1; i < 12; i++) lines.push(`a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(', ')}]`);
  const text = `---\n${lines.join('\n')}\n---\nbody`;
  const t0 = Date.now();
  const p = parseNote(text);
  assert.ok(Date.now() - t0 < 2000, 'must not expand the aliases');
  assert.ok(JSON.stringify(p.frontmatter).length <= 4096 + 64);
  // Over the size cap it is not read as frontmatter at all.
  const huge = `---\n${'k: v\n'.repeat(10_000)}---\nbody`;
  assert.equal(parseNote(huge).hasFrontmatter, false);
});

test('headings (atx, closing hashes, setext), block ids, code masked', () => {
  const text = ['# Title ##', '', '## Sub *one*', 'Setext', '======', 'Another', '------', '```', '# not a heading', '```', 'Paragraph ^para-1', '', '- item ^item-2', '', '^alone'].join('\n');
  const p = parseNote(text);
  assert.deepEqual(p.headings.map((h) => [h.level, h.text, h.line]), [[1, 'Title', 1], [2, 'Sub *one*', 3], [1, 'Setext', 4], [2, 'Another', 6]]);
  assert.equal(p.headings[1]!.norm, 'sub one');
  assert.deepEqual(p.blocks.map((b) => b.id), ['para-1', 'item-2', 'alone']);
  assert.equal(p.title, 'Title');
  assert.equal(normHeading('Q&A: What? [[x|y]]'), 'q&a what? y');
});

test('markdown links to notes and files: relative, root, <angle>, %20, fragments; URLs and mail skipped', () => {
  const text = [
    '[a](Folder/Note.md) [b](<My Note.md>) [c](My%20Note.md#Heading) [d](../up/Other.md) [e](https://example.com/x.md) [f](mailto:a@b.c)',
    '[g](#local) ![h](img/pic.png) [i](./rel.md "title") [j](Name(with)parens.md) [k]()',
  ].join('\n');
  const links = parseNote(text).links.filter((l) => l.style === 'md');
  assert.deepEqual(
    links.map((l) => [l.embed, l.target, l.heading]),
    [
      [false, 'Folder/Note.md', null],
      [false, 'My Note.md', null],
      [false, 'My Note.md', 'Heading'],
      [false, '../up/Other.md', null],
      [false, '', 'local'],
      [true, 'img/pic.png', null],
      [false, 'rel.md', null],
      [false, 'Name(with)parens.md', null],
    ],
  );
});

test('entity links are recognized and keep their whole text as the target', () => {
  const [a, b, c] = wiki('[[ticket:T-12]] [[session:abc123|that run]] [[workspace:docker/dev]]');
  assert.deepEqual(a!.entity, { type: 'ticket', key: 'T-12' });
  assert.deepEqual(b!.entity, { type: 'session', key: 'abc123' });
  assert.equal(b!.alias, 'that run');
  assert.deepEqual(c!.entity, { type: 'workspace', key: 'docker/dev' });
  assert.equal(wiki('[[Note: with colon]]')[0]!.entity, null);
});

test('sections: the text under a heading up to the next of the same or higher level; end-of-section for appends', () => {
  const text = '# A\nintro\n\n## B\nb1\nb2\n\n### C\nc1\n\n## D\nd1\n';
  const p = parseNote(text);
  const b = sectionOf(text, p, normHeading('B'))!;
  assert.equal(text.slice(b.start, b.end), '## B\nb1\nb2\n\n### C\nc1\n\n');
  const at = endOfSection(text, p, normHeading('B'))!;
  assert.equal(text.slice(0, at), '# A\nintro\n\n## B\nb1\nb2\n\n### C\nc1');
  assert.equal(endOfSection(text, p, normHeading('Missing')), null);
  assert.equal(endOfSection(text, p, normHeading('D')), text.length - 1);
});

test('big note: a link-heavy 1 MB note is read quickly and capped', () => {
  const text = Array.from({ length: 20_000 }, (_, i) => `line ${i} [[Target ${i % 500}]] #tag${i % 50} and some words to pad it out`).join('\n');
  const t0 = Date.now();
  const p = parseNote(text);
  const ms = Date.now() - t0;
  assert.equal(p.links.length, 5000);
  assert.ok(ms < 1500, `took ${ms} ms`);
});
