import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keptResult, mapInputStrings, parseLine, RESULT_TEXT_MAX, RESULT_TEXT_SHORT, resultText, TOOL_INPUT_MAX, TOOL_INPUT_STRING_MAX, toolInput } from './protocol.js';
import { line } from './testkit.js';

// What a tool row keeps (chat PRD FR7): the input it was given, as written, and its output, bounded. Credential-shaped fixtures are
// built at runtime (no token-shaped literal in the repository).
const ghToken = () => ['gh', 'p_', 'Q7zK'.repeat(10)].join('');

test('toolInput: Bash keeps its command as written, line breaks and all', () => {
  const command = "cat <<'EOF' > /tmp/x\nline one\n\tline two\nEOF\nnpm test | tee out.log";
  assert.deepEqual(toolInput('Bash', { command, description: 'write a file' }), { input: { command }, cut: false });
});

test('toolInput: only the fields a row shows; a sub-agent’s prompt and unknown tools are never kept', () => {
  assert.deepEqual(toolInput('Read', { file_path: '/a/b.ts', offset: 10, limit: 20, extra: 'x' }), { input: { file_path: '/a/b.ts', offset: 10, limit: 20 }, cut: false });
  assert.deepEqual(toolInput('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' }), { input: { file_path: '/a', old_string: 'x', new_string: 'y' }, cut: false });
  assert.equal(toolInput('Task', { description: 'look', prompt: 'SECRET PROMPT' }), null);
  assert.equal(toolInput('Agent', { description: 'look', prompt: 'SECRET PROMPT' }), null);
  assert.equal(toolInput('TodoWrite', { todos: [] }), null);
  assert.equal(toolInput('WebFetch', { url: 'https://x.test', prompt: 'summarise' })!.input.prompt, undefined);
  assert.equal(toolInput(null, { command: 'ls' }), null);
  assert.equal(toolInput('Bash', 'ls'), null);
  assert.equal(toolInput('Bash', {}), null);
});

test('toolInput: an MCP tool keeps its whole input, nested values included', () => {
  const input = { repo: 'a/b', labels: ['x', 'y'], opts: { draft: true, n: 3 } };
  assert.deepEqual(toolInput('mcp__github__create_pr', input), { input, cut: false });
});

test('toolInput: redacted, and disguising characters shown as escapes', () => {
  const token = ghToken();
  const kept = toolInput('Bash', { command: `curl -H "Authorization: token ${token}" x\u202Eevil` })!;
  const command = kept.input.command as string;
  assert.ok(!command.includes(token), 'the token is not kept');
  assert.ok(command.includes('⟦U+202E⟧'), 'the override shows as an escape');
  assert.ok(command.includes('\n') === false && command.endsWith('evil'));
  const nested = toolInput('mcp__x__y', { deep: [{ key: token }] })!;
  assert.ok(!JSON.stringify(nested).includes(token));
});

test('toolInput: a write-only argument (pool_secret_set value) never reaches the row, whatever its shape (T-2866)', async () => {
  const { randomBytes } = await import('node:crypto');
  const value = `plain-${randomBytes(12).toString('hex')}`;
  for (const name of ['mcp__pilot__pool_secret_set', 'mcp__claude_ai_pilot__pool_secret_set']) {
    const kept = toolInput(name, { pool: 'kohi', name: 'API_KEY', value, note: 'rotate' })!;
    assert.ok(!JSON.stringify(kept).includes(value), `${name}: the value is not kept`);
    assert.equal(kept.input.value, '[write-only]');
    assert.equal(kept.input.name, 'API_KEY', 'the other arguments stay readable');
  }
  const call = parseLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_s', name: 'mcp__pilot__pool_secret_set', input: { pool: 'p', name: 'X', value } }] }, parent_tool_use_id: null }));
  assert.ok(!JSON.stringify(call.stored).includes(value), 'the stored event has no value');
  // another tool with a field called value is untouched
  assert.equal(toolInput('mcp__x__y', { value: 'shown' })!.input.value, 'shown');
});

test('toolInput: bounded per string and in all, and says so', () => {
  const long = 'a'.repeat(TOOL_INPUT_STRING_MAX + 100);
  const one = toolInput('Bash', { command: long })!;
  assert.equal((one.input.command as string).length, TOOL_INPUT_STRING_MAX);
  assert.equal(one.cut, true);
  const many = toolInput('mcp__x__y', Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, 'b'.repeat(TOOL_INPUT_STRING_MAX)])))!;
  const total = Object.values(many.input).reduce<number>((n, v) => n + (v as string).length, 0);
  assert.equal(total, TOOL_INPUT_MAX);
  assert.equal(many.cut, true);
  // a cut never leaves half a character
  const emoji = toolInput('Bash', { command: `${'a'.repeat(TOOL_INPUT_STRING_MAX - 1)}😀` })!;
  assert.ok(!/[\uD800-\uDBFF]$/.test(emoji.input.command as string));
});

test('parseLine: a tool_use carries its input, a Task never its prompt', () => {
  const call = parseLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls\npwd' } }] }, parent_tool_use_id: null }));
  assert.deepEqual(call.stored[0]!.toolInput, { command: 'ls\npwd' });
  assert.equal(call.stored[0]!.text, 'ls pwd', 'the one-line summary stays folded');
  const task = parseLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_t', name: 'Task', input: { description: 'd', prompt: 'SECRET PROMPT' } }] }, parent_tool_use_id: null }));
  assert.ok(!JSON.stringify(task.stored).includes('SECRET PROMPT'));
});

test('resultText: past the cap, the head and the tail with a line between; redacted before the cut', () => {
  assert.equal(resultText('short', 100), 'short');
  const text = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n');
  const kept = resultText(text, RESULT_TEXT_MAX);
  assert.ok(kept.length <= RESULT_TEXT_MAX);
  assert.ok(kept.startsWith('line 1\n'));
  assert.ok(kept.endsWith('line 5000'), 'the tail is kept');
  assert.match(kept, /\n… [\d,]+ characters not kept …\n/);
  const token = ghToken();
  assert.ok(!resultText(`x ${token} y`, 1000).includes(token));
  // megabytes are bounded before the scan, the tail still kept
  const huge = resultText(`${'z'.repeat(5_000_000)}END`, RESULT_TEXT_MAX);
  assert.ok(huge.endsWith('END') && huge.length <= RESULT_TEXT_MAX);
});

test('keptResult: a command or a failure keeps its output to the cap, the other tools a shorter piece', () => {
  const big = 'r'.repeat(RESULT_TEXT_MAX);
  assert.equal(keptResult('Bash', false, big), big);
  assert.equal(keptResult('Read', true, big), big);
  assert.ok(keptResult('Read', false, big).length <= RESULT_TEXT_SHORT);
  assert.ok(keptResult(undefined, undefined, big).length <= RESULT_TEXT_SHORT);
});

test('mapInputStrings: every string, at any depth, and nothing else', () => {
  assert.deepEqual(
    mapInputStrings({ a: 'x', b: [1, 'y', { c: 'z', d: null, e: true }] }, (s) => s.toUpperCase()),
    { a: 'X', b: [1, 'Y', { c: 'Z', d: null, e: true }] },
  );
});
