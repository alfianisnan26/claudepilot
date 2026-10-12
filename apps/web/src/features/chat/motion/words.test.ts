import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { holdEnd, scanWords, valueCut, wordRanges } from './words';

const ends = (text: string, ended = false) => {
  const out: number[] = [];
  scanWords(text, 0, ended, out);
  return out;
};

describe('scanWords', () => {
  it('finds the ends of the words that are complete, and holds back one still growing', () => {
    assert.deepEqual(ends('one two thr'), [3, 7]);
    assert.deepEqual(ends('one two thr', true), [3, 7, 11]);
    assert.deepEqual(ends('one two '), [3, 7]);
    assert.deepEqual(ends('  \n\t'), []);
  });

  it('resumes where it stopped, and finds each word once', () => {
    const out: number[] = [];
    let at = scanWords('hello wor', 0, false, out);
    at = scanWords('hello world and', at, false, out);
    at = scanWords('hello world and more', at, false, out);
    scanWords('hello world and more', at, true, out);
    assert.deepEqual(out, [5, 11, 15, 20]);
  });
});

describe('text written without spaces', () => {
  const zh = '今天天气很好，我们一起去公园散步吧。';
  const th = 'วันนี้อากาศดีมาก';

  it('is split into words, so it shows a few at a time rather than as one endless word', () => {
    for (const text of [zh, th, 'こんにちは世界、元気ですか']) {
      const all = ends(text, true);
      assert.ok(all.length >= 3, `${text}: ${all.length} units`);
      assert.equal(all.at(-1), text.length);
      for (let i = 1; i < all.length; i++) assert.ok(all[i]! > all[i - 1]!);
      // A word the reader sees in the middle of a run is never cut: the units tile the run.
      const ranges = wordRanges(text);
      assert.equal(ranges[0]![0], 0);
      assert.equal(ranges.at(-1)![1], text.length);
      for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i]![0], ranges[i - 1]![1]);
    }
  });

  it('holds back only the last unit of a run that is still arriving', () => {
    const part = ends(zh.slice(0, 9), false);
    const whole = ends(zh.slice(0, 9), true);
    assert.equal(part.length, whole.length - 1);
    assert.deepEqual(part, whole.slice(0, -1));
  });

  it('mixes with spaced text in one run', () => {
    const text = 'Hello 世界你好 world';
    const all = ends(text, true);
    assert.equal(all[0], 5);
    assert.equal(all.at(-1), text.length);
    assert.ok(all.length >= 4);
  });

  it('scans in pieces and finds each unit once', () => {
    const out: number[] = [];
    let at = 0;
    for (let n = 3; n <= zh.length; n += 3) at = scanWords(zh.slice(0, n), at, false, out);
    scanWords(zh, at, true, out);
    for (let i = 1; i < out.length; i++) assert.ok(out[i]! > out[i - 1]!, 'no repeats, in order');
    assert.equal(out.at(-1), zh.length);
  });
});

describe('wordRanges', () => {
  it('splits on whitespace and keeps punctuation and emoji with their word', () => {
    assert.deepEqual(wordRanges('Hi, there! 🎉🎉'), [[0, 3], [4, 10], [11, 15]]);
    assert.deepEqual(wordRanges('  '), []);
  });
});

describe('valueCut: how much of a text node shows', () => {
  it('is a subtraction when the text is its source', () => {
    assert.equal(valueCut('hello world', 'hello world', 5), 5);
  });

  it('walks past escapes, entities and indentation that only the source has', () => {
    assert.equal(valueCut('a*b', 'a\\*b', 3), 2); // "a\*" shows "a*"
    assert.equal(valueCut('1 < 2', '1 &lt; 2', 6), 3); // "1 &lt;" shows "1 <"
    assert.equal(valueCut('one\ntwo', 'one\n  two', 6), 4); // "one\n  t": the indentation is not text
    assert.equal(valueCut('x', 'x', 0), 0);
    assert.equal(valueCut('whole', 'whole', 99), 5);
  });
});

describe('holdEnd: where the reveal waits for the Markdown to settle', () => {
  it('shows everything of ordinary text', () => {
    for (const t of ['', 'plain text', 'a\n\nb\n', '- item\n- item', '# Title\n', 'run `a | b` now']) assert.equal(holdEnd(t), t.length, JSON.stringify(t));
  });

  it('holds a header line until the line after it has started, since only the delimiter row makes it a table', () => {
    assert.equal(holdEnd('Intro\n\n| a | b |'), 'Intro\n\n'.length);
    assert.equal(holdEnd('Intro\n\n| a | b |\n'), 'Intro\n\n'.length);
    assert.equal(holdEnd('Intro\n\n| a | b |\n|'), 'Intro\n\n| a | b |\n|'.length);
    assert.equal(holdEnd('| a | b |\n|---|---|\n| 1 | 2 |'), '| a | b |\n|---|---|\n| 1 | 2 |'.length);
    assert.equal(holdEnd('| a | b |'), 0);
  });

  it('lets the rows of a settled table show as they come', () => {
    const t = '| a | b |\n|---|---|\n| 1 | 2 |\n';
    assert.equal(holdEnd(t), t.length);
    assert.equal(holdEnd(`${t}| 3 | 4`), `${t}| 3 | 4`.length);
  });
});
