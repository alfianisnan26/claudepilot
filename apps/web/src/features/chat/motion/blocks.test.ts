import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BlockSplitter, splitBlocks } from './blocks';

const texts = (md: string) => splitBlocks(md).map((b) => md.slice(b.start, b.end));

describe('splitBlocks', () => {
  it('has no blocks for an empty reply and one for a single paragraph', () => {
    assert.deepEqual(splitBlocks(''), []);
    assert.deepEqual(texts('Just one line'), ['Just one line']);
  });

  it('splits at blank lines and covers the text end to end', () => {
    const md = 'First para.\n\nSecond para\nstill second.\n\n## Heading\nbody\n';
    const blocks = splitBlocks(md);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0]!.start, 0);
    for (let i = 1; i < blocks.length; i++) assert.equal(blocks[i]!.start, blocks[i - 1]!.end);
    assert.equal(blocks.at(-1)!.end, md.length);
    assert.equal(texts(md)[1], 'Second para\nstill second.\n\n');
  });

  it('never splits inside a fenced code block, blank lines and all', () => {
    const md = 'Intro\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nAfter\n';
    const t = texts(md);
    assert.equal(t.length, 3);
    assert.ok(t[1]!.startsWith('```ts') && t[1]!.includes('const b = 2;'));
    assert.ok(t[2]!.startsWith('After'));
  });

  it('knows a fence closes only with the same character and at least as many', () => {
    const md = '````md\n```\ninner fence\n```\n\nstill inside\n````\n\nout\n';
    const t = texts(md);
    assert.equal(t.length, 2);
    assert.ok(t[0]!.includes('still inside'));
    const tilde = '~~~\n```\n\n~~~\n\nafter\n';
    assert.equal(texts(tilde).length, 2);
  });

  it('does not take a line with backticks in its info string for a fence', () => {
    const md = 'Use ```inline``` here\n\nNext para\n';
    assert.equal(texts(md).length, 2);
    const md2 = '```not a fence```\n\nNext\n';
    assert.equal(texts(md2).length, 2);
  });

  it('keeps a loose list together: blank lines between items, nested content', () => {
    const md = '1. First\n\n2. Second\n\n   ```sh\n   run it\n\n   again\n   ```\n\n3. Third\n\nDone.\n';
    const t = texts(md);
    assert.equal(t.length, 2);
    assert.ok(t[0]!.includes('3. Third'));
    assert.equal(t[1], 'Done.\n');
    assert.equal(texts('- a\n\n- b\n\n* c\n').length, 1);
  });

  it('splits a list from a paragraph that follows it, and numbering carries on from the markers', () => {
    const t = texts('1. one\n\npara\n\n2. two\n');
    assert.equal(t.length, 3);
  });

  it('keeps indented continuations with the block above', () => {
    assert.equal(texts('- item\n\n  continued paragraph\n\n- next\n').length, 1);
    assert.equal(texts('text\n\n    indented code\n\nmore\n').length, 2);
  });

  it('splits blockquotes and tables at their blank lines', () => {
    assert.equal(texts('> quote\n\n> another\n').length, 2);
    assert.equal(texts('| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n').length, 2);
  });

  it('does not split a reply whose meaning can depend on something further down', () => {
    // Link reference definitions and footnotes resolve references above them; multi-line HTML runs across blank lines.
    assert.equal(texts('See [the docs][1].\n\nMore text.\n\n[1]: https://example.com\n').length, 1);
    assert.equal(texts('A claim[^1].\n\nMore.\n\n[^1]: The note.\n').length, 1);
    assert.equal(texts('Before\n\n<pre>\nraw\n\nmore raw\n</pre>\n\nAfter\n').length, 1);
    assert.equal(texts('Before\n\n<!-- a\n\ncomment -->\n\nAfter\n').length, 1);
  });

  it('is not fooled by those inside a code fence', () => {
    assert.equal(texts('```html\n<pre>\n</pre>\n[1]: not a definition\n```\n\nAfter\n').length, 2);
  });

  it('ignores blank lines at the start', () => {
    assert.equal(texts('\n\nHello\n\nWorld\n').length, 2);
  });

  it('waits to split before a line that is still being typed', () => {
    // "2" may become "2. Second" (the same list) or stay a number (a new paragraph): no split until it can be told.
    assert.equal(texts('1. First\n\n2').length, 1);
    assert.equal(texts('1. First\n\n2. S').length, 1);
    assert.equal(texts('Para\n\nWor').length, 1);
    assert.equal(texts('Para\n\nWord and').length, 2);
    assert.equal(texts('Para\n\nWord\n').length, 2);
  });
});

/** Every prefix of a stream gives the same blocks, split at once or grown one chunk at a time. */
describe('BlockSplitter (incremental)', () => {
  const docs = [
    'Intro paragraph.\n\n## A heading\n\n- one\n- two\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nClosing words.\n',
    '1. First\n\n2. Second\n\n   ```sh\n   run it\n\n   again\n   ```\n\n3. Third\n\nDone.\n',
    '| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n> again\n\nText.\n\nSee [x][1].\n\n[1]: https://example.com\n\nTail.\n',
    '\n\nLeading blank\n\n\nTwo blanks\n\n~~~\nfence\n\n~~~\n\nEnd',
  ];

  it('matches a full split at every prefix', () => {
    for (const doc of docs) {
      const splitter = new BlockSplitter();
      for (let n = 1; n <= doc.length; n++) {
        const prefix = doc.slice(0, n);
        assert.deepEqual([...splitter.update(prefix)], splitBlocks(prefix), `doc ${docs.indexOf(doc)}, prefix ${n}: ${JSON.stringify(prefix.slice(-20))}`);
      }
    }
  });

  it('matches in chunks of irregular size, and starts over for a different text', () => {
    const doc = docs[0]!;
    const splitter = new BlockSplitter();
    let at = 0;
    for (const size of [3, 17, 1, 40, 9, 100]) {
      at = Math.min(doc.length, at + size);
      assert.deepEqual([...splitter.update(doc.slice(0, at))], splitBlocks(doc.slice(0, at)));
    }
    assert.deepEqual([...splitter.update('Something\n\nelse')], splitBlocks('Something\n\nelse'));
    assert.deepEqual([...splitter.update('')], []);
  });
});
