import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatEvent } from '@portal/contracts';
import { btwTranscript, MIN_CONTEXT_CHARS } from './btwContext.js';

/** Key-shaped strings, built at runtime so no token-shaped literal sits in the repo. */
const FAKE_KEY = ['sk-ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH'].join('-');
const FAKE_GH = `${'ghp'}_abcdefghijklmnopqrstuvwxyz0123456789`;

let seq = 0;
const e = (kind: ChatEvent['kind'], rest: Partial<ChatEvent> = {}): ChatEvent => ({ seq: ++seq, at: '2026-10-12T00:00:00Z', kind, ...rest });
const user = (text: string, rest: Partial<ChatEvent> = {}) => e('user', { text, ...rest });
const claude = (text: string) => e('assistant', { text });

test('a conversation becomes You / Claude sections, tools under the turn with their results', () => {
  seq = 0;
  const t = btwTranscript(
    [
      user('fix the failing test'),
      e('tool_use', { toolName: 'Bash', text: 'npm test', toolUseId: 't1' }),
      e('tool_result', { text: '3 failed, 12 passed', toolUseId: 't1', isError: true }),
      e('tool_use', { toolName: 'Edit', text: 'src/a.ts', toolUseId: 't2' }),
      e('tool_result', { text: 'ok', toolUseId: 't2' }),
      claude('Fixed the assertion in a.ts.'),
    ],
    10_000,
  );
  assert.equal(t.messages, 2);
  assert.equal(t.truncated, false);
  assert.equal(t.lastSeq, 6);
  assert.match(t.text, /### You\n\nfix the failing test/);
  assert.match(t.text, /_Tools used:_\n- Bash \(npm test\) → failed: 3 failed, 12 passed\n- Edit \(src\/a\.ts\) → ok/);
  assert.match(t.text, /### Claude\n\nFixed the assertion/);
  assert.ok(t.text.indexOf('### You') < t.text.indexOf('Tools used') && t.text.indexOf('Tools used') < t.text.indexOf('### Claude'));
});

test('thinking, system notes, sub-agent lines, requests and pinned btw cards are not part of what Claude saw', () => {
  seq = 0;
  const t = btwTranscript(
    [
      user('hello'),
      e('thinking', { text: 'SECRET REASONING' }),
      e('system', { text: 'Ready' }),
      e('system', { text: 'btw: q\n\na', btw: { id: 'b', question: 'q', answer: 'PINNED ANSWER', askedAt: 'x', askedBy: 'user:u_owner' } }),
      e('assistant', { text: 'SUBAGENT TEXT', agentLabel: 'toolu_9' }),
      e('result', { text: 'done' }),
      e('request', { text: 'asks' }),
      claude('hi'),
    ],
    10_000,
  );
  assert.equal(t.messages, 2);
  for (const leaked of ['SECRET REASONING', 'Ready', 'PINNED ANSWER', 'SUBAGENT TEXT']) assert.ok(!t.text.includes(leaked), leaked);
});

test('the newest whole messages that fit are kept, older ones are left out and it says so', () => {
  seq = 0;
  const events: ChatEvent[] = [];
  for (let i = 1; i <= 40; i++) events.push(user(`question ${i} ${'x'.repeat(300)}`), claude(`answer ${i} ${'y'.repeat(300)}`));
  const t = btwTranscript(events, MIN_CONTEXT_CHARS);
  assert.equal(t.truncated, true);
  assert.ok(t.messages < 80 && t.messages >= 4, String(t.messages));
  assert.ok(t.text.length <= MIN_CONTEXT_CHARS + 100, String(t.text.length));
  assert.ok(t.text.includes('answer 40'), 'the newest is kept');
  assert.ok(!t.text.includes('question 1 '), 'the oldest is not');
  assert.equal(t.lastSeq, 80);
  // Never opens on a tools line.
  assert.ok(t.text.startsWith('### '));
});

test('a setting below the floor still gets the floor', () => {
  seq = 0;
  const t = btwTranscript([user('a'.repeat(3000)), claude('b'.repeat(900))], 10);
  assert.equal(t.messages, 2);
});

test('long messages and tool results are cut, and a long tool list is counted', () => {
  seq = 0;
  const events: ChatEvent[] = [user('z'.repeat(9000))];
  for (let i = 0; i < 20; i++) events.push(e('tool_use', { toolName: 'Read', text: `f${i}`, toolUseId: `t${i}` }), e('tool_result', { text: 'r'.repeat(900), toolUseId: `t${i}` }));
  events.push(claude('done'));
  const t = btwTranscript(events, 100_000);
  assert.ok(t.text.includes('… (cut)'));
  assert.ok(!t.text.includes('z'.repeat(4500)));
  assert.match(t.text, /- and 6 more/);
  assert.ok(!t.text.includes('r'.repeat(300)), 'a result is an excerpt');
});

test('attachments are named, a transferred opening and an actor message are labelled', () => {
  seq = 0;
  const t = btwTranscript(
    [
      user('here', { images: [{ blobId: 'a', mediaType: 'image/png' }, { blobId: 'b', mediaType: 'image/png' }], files: [{ blobId: 'c', name: 'notes.md', mediaType: 'text/markdown', size: 1, preview: 'none' } as never] }),
      user('moved context', { transfer: { fromClaude: 'Work', toClaude: 'Home', sourceSessionId: 's', path: '/x', messages: 3, truncated: false } }),
      user('CI says red', { actor: 'ci:run1', actorLabel: 'build' }),
    ],
    10_000,
  );
  assert.match(t.text, /_\(attached: 2 images, notes\.md\)_/);
  assert.match(t.text, /### Earlier context \(moved from Work\)/);
  assert.match(t.text, /### Message from ci:run1 “build”/);
});

test('credentials in stored text are redacted before the context leaves (the chat\'s own redactor)', () => {
  seq = 0;
  const t = btwTranscript([user(`my key is ${FAKE_KEY} ok`), claude(`noted, ${FAKE_GH}`)], 10_000);
  assert.ok(!t.text.includes(FAKE_KEY.slice(0, 16)));
  assert.ok(!t.text.includes(FAKE_GH.slice(0, 12)));
  assert.ok(t.text.includes('[redacted]'));
});

test('an empty session is an empty transcript', () => {
  seq = 0;
  const t = btwTranscript([], 10_000);
  assert.deepEqual({ text: t.text, messages: t.messages, truncated: t.truncated, lastSeq: t.lastSeq }, { text: '', messages: 0, truncated: false, lastSeq: 0 });
});
