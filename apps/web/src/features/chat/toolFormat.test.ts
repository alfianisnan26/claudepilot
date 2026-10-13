import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalLang, clipOutput, editDiff, exitStatus, inputView, lineCount, linesLabel, readRange } from './toolFormat.js';

test('lineCount and linesLabel', () => {
  assert.equal(lineCount(''), 0);
  assert.equal(lineCount('a'), 1);
  assert.equal(lineCount('a\n'), 1, 'a final newline does not start a line');
  assert.equal(lineCount('a\nb'), 2);
  assert.equal(lineCount('\n'), 1);
  assert.equal(linesLabel(1), '1 line');
  assert.equal(linesLabel(5000), '5,000 lines');
});

test('readRange', () => {
  assert.equal(readRange(10, 20), 'lines 10–29');
  assert.equal(readRange(10, null), 'from line 10');
  assert.equal(readRange(null, 20), 'lines 1–20');
  assert.equal(readRange(null, null), null);
});

test('editDiff: context around the change, every changed line, a gap where context was left out', () => {
  assert.deepEqual(editDiff('a\nb\nc', 'a\nB\nc'), [
    { kind: 'ctx', text: 'a' },
    { kind: 'del', text: 'b' },
    { kind: 'add', text: 'B' },
    { kind: 'ctx', text: 'c' },
  ]);
  const long = editDiff('1\n2\n3\n4\n5\nx\n6\n7\n8\n9', '1\n2\n3\n4\n5\ny\nz\n6\n7\n8\n9');
  assert.deepEqual(long, [
    { kind: 'gap', text: '…' },
    { kind: 'ctx', text: '3' },
    { kind: 'ctx', text: '4' },
    { kind: 'ctx', text: '5' },
    { kind: 'del', text: 'x' },
    { kind: 'add', text: 'y' },
    { kind: 'add', text: 'z' },
    { kind: 'ctx', text: '6' },
    { kind: 'ctx', text: '7' },
    { kind: 'ctx', text: '8' },
    { kind: 'gap', text: '…' },
  ]);
  // an insertion into nothing, and a removal of everything
  assert.deepEqual(editDiff('', 'new'), [{ kind: 'add', text: 'new' }]);
  assert.deepEqual(editDiff('old', ''), [{ kind: 'del', text: 'old' }]);
});

test('inputView: Bash is its command as written, coloured as shell, with its facts', () => {
  const command = "cat <<'EOF' > x\nline\nEOF";
  assert.deepEqual(inputView('Bash', { command, timeout: 120000, run_in_background: true }, 'cat <<…'), {
    path: null,
    facts: ['background', 'timeout 120 s'],
    code: { text: command, lang: 'shell' },
    diff: null,
    cut: false,
  });
});

test('inputView: the file tools, the searches and an MCP tool', () => {
  const edit = inputView('Edit', { file_path: '/a/b.ts', old_string: 'x', new_string: 'y', replace_all: true }, 'b.ts');
  assert.equal(edit.path, '/a/b.ts');
  assert.deepEqual(edit.diff, [
    { kind: 'del', text: 'x' },
    { kind: 'add', text: 'y' },
  ]);
  assert.deepEqual(edit.facts, ['every match']);
  const multi = inputView('MultiEdit', { file_path: '/f', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }, undefined);
  assert.deepEqual(multi.diff?.map((l) => l.kind), ['del', 'add', 'gap', 'del', 'add']);
  assert.deepEqual(multi.facts, ['2 edits']);
  const write = inputView('Write', { file_path: '/f', content: 'one\ntwo\n' }, undefined);
  assert.deepEqual(write.diff, [
    { kind: 'add', text: 'one' },
    { kind: 'add', text: 'two' },
  ]);
  const read = inputView('Read', { file_path: '/f', offset: 5, limit: 10 }, undefined);
  assert.deepEqual([read.path, read.facts, read.code], ['/f', ['lines 5–14'], null]);
  const grep = inputView('Grep', { pattern: 'foo\\(', path: 'src', glob: '*.ts', '-i': true }, undefined);
  assert.deepEqual([grep.code, grep.path, grep.facts], [{ text: 'foo\\(', lang: 'text' }, 'src', ['*.ts', 'ignore case']]);
  const mcp = inputView('mcp__github__create_pr', { repo: 'a/b', draft: true }, undefined, true);
  assert.deepEqual(mcp.code, { text: '{\n  "repo": "a/b",\n  "draft": true\n}', lang: 'json' });
  assert.equal(mcp.cut, true);
});

test('inputView: a call stored before inputs were kept shows its one-line summary', () => {
  assert.deepEqual(inputView('Bash', undefined, 'npm test').code, { text: 'npm test', lang: 'shell' });
  assert.deepEqual(inputView('Read', undefined, '/a/b').code, { text: '/a/b', lang: 'text' });
  assert.equal(inputView('TodoWrite', undefined, undefined).code, null);
});

test('approvalLang: a command as shell, a whole input as JSON, the rest as text', () => {
  assert.equal(approvalLang('Bash', 'ls'), 'shell');
  assert.equal(approvalLang('mcp__x__y', '{\n  "a": 1\n}'), 'json');
  assert.equal(approvalLang('Read', '/a/b'), 'text');
  assert.equal(approvalLang(null, '{ not json'), 'text');
});

test('clipOutput: a long output shows its first and last lines, and says how many are between', () => {
  const text = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n');
  const c = clipOutput(text);
  assert.equal(c.total, 5000);
  assert.equal(c.hidden, 4920);
  assert.equal(c.head.split('\n').length, 40);
  assert.ok(c.head.startsWith('line 1\n') && c.head.endsWith('line 40'));
  assert.ok(c.tail!.startsWith('line 4961\n') && c.tail!.endsWith('line 5000'));
  // a few lines over the ends is not worth a button
  const short = Array.from({ length: 84 }, (_, i) => `${i}`).join('\n');
  assert.deepEqual(clipOutput(short), { head: short, tail: null, hidden: 0, total: 84 });
  // a final newline is not a line of its own
  assert.equal(clipOutput(`${text}\n`).tail!.endsWith('line 5000'), true);
});

test('exitStatus: from a failed command’s result, when it says', () => {
  assert.equal(exitStatus('Exit code 2\nboom'), 2);
  assert.equal(exitStatus('Error: Exit code 127\nnot found'), 127);
  assert.equal(exitStatus('some output\nExit code 1'), null);
  assert.equal(exitStatus(''), null);
});
