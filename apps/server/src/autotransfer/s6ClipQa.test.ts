// QA T-781 S6 (lane-cp-qa-perf): a secret that straddles a clip leaves no part of itself in the transfer text: the message clip (both budgets, both
// roles, a GitHub token and a PEM block) and the tools line (the tool summary is cut at 59 characters before the line is redacted: GAP expected on
// ff51fd8d, T-781 comment 7946). Written before the run, NOT run when committed. Every secret is built at run time: no token-shaped literal here.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { ChatEvent } from '@portal/contracts';
import { transferConversation, transferFileConversation } from '../chat/transfer.js';

const alnum = (n: number) => randomBytes(n * 2).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n);
const ghToken = () => ({ text: `${['gh', 'p_'].join('')}${alnum(36)}`, body: '' });
const pem = () => {
  const b = alnum(60);
  const lines = `${b.slice(0, 30)}\n${b.slice(30)}`;
  return { text: `-----${['BEGIN', 'RSA', 'PRIVATE', 'KEY'].join(' ')}-----\n${lines}\n-----${['END', 'RSA', 'PRIVATE', 'KEY'].join(' ')}-----`, body: b.slice(0, 12) };
};
const KEEPS = [1, 4, 5, 12, 19, 20, 23, 24, 30];
const ev = (seq: number, kind: ChatEvent['kind'], text: string, extra: Partial<ChatEvent> = {}): ChatEvent => ({ seq, at: '2026-10-16T12:00:00Z', kind, text, ...extra }) as ChatEvent;

function check(out: string, what: string, secret: { text: string; body: string }) {
  assert.ok(!out.includes('ghp_'), `${what}: a "ghp_" prefix is left`);
  assert.ok(!out.includes('BEGIN'), `${what}: a PEM header is left`);
  if (secret.body) assert.ok(!out.includes(secret.body), `${what}: a body fragment is left`);
  assert.ok(!out.includes(secret.text), `${what}: the whole secret is left`);
}

test('QA-S6-c1 message clip, the opening budget (200 per message): a secret with 1..30 characters inside the cut leaves nothing, user and assistant', () => {
  for (const make of [ghToken, pem]) {
    for (const kind of ['assistant', 'user'] as const) {
      for (const keep of KEEPS) {
        const s = make();
        const text = `${'w'.repeat(200 - keep)}${s.text} and after`;
        const out = transferConversation([ev(1, kind, text)], 100_000, 200).text;
        check(out, `${kind} keep=${keep} ${make.name}`, s);
        if (s.body === '') assert.ok(!out.includes(s.text.slice(4, 12)), `${kind} keep=${keep}: a token body fragment is left`);
      }
    }
  }
});

test('QA-S6-c2 message clip, the context-file budget (20000 per message): the same offsets leave nothing', () => {
  for (const make of [ghToken, pem]) {
    for (const kind of ['assistant', 'user'] as const) {
      for (const keep of KEEPS) {
        const s = make();
        const text = `${'w'.repeat(20_000 - keep)}${s.text} and after`;
        const out = transferFileConversation([ev(1, kind, text)]).text;
        check(out, `file ${kind} keep=${keep} ${make.name}`, s);
        if (s.body === '') assert.ok(!out.includes(s.text.slice(4, 12)), `file ${kind} keep=${keep}: a token body fragment is left`);
      }
    }
  }
});

test('QA-S6-c3 a secret in the middle of the clip window and one right at its end are redacted; the neighbours survive', () => {
  const s = ghToken();
  const text = `keep-this-start ${s.text} keep-this-end`;
  const out = transferConversation([ev(1, 'assistant', text)], 100_000, 200).text;
  assert.ok(out.includes('keep-this-start') && out.includes('keep-this-end'), 'text around a secret is kept');
  assert.ok(!out.includes(s.text.slice(0, 8)), 'the secret is gone');
});

test('QA-S6-c4 the tools line: a Bash command whose secret straddles the 59-character cut leaves no prefix (GAP expected on ff51fd8d: cut before redact)', () => {
  for (const make of [ghToken, pem]) {
    for (const keep of [1, 4, 5, 12, 19, 20, 23, 24, 30, 45]) {
      for (const tail of ['mid', 'end'] as const) {
        const s = make();
        const command = `${'x'.repeat(59 - keep)}${s.text}`.replace(/\s+/g, ' ');
        const events = [ev(1, 'assistant', 'one'), ev(2, 'tool_use', command, { toolName: 'Bash' } as Partial<ChatEvent>), ...(tail === 'mid' ? [ev(3, 'assistant', 'two')] : [])];
        const out = transferConversation(events, 100_000, 4_000).text;
        const what = `tools line keep=${keep} ${tail} ${make.name}`;
        assert.ok(!out.includes('ghp_'), `${what}: a "ghp_" prefix is left`);
        assert.ok(!out.includes('BEGIN'), `${what}: a PEM header is left`);
        assert.ok(!out.includes(s.text.slice(4, 12)) || s.body !== '', `${what}: a token body fragment is left`);
        if (s.body) assert.ok(!out.includes(s.body), `${what}: a PEM body fragment is left`);
      }
    }
  }
});

test('QA-S6-c5 the tools line with no secret: unchanged shape (name, one-line summary cut at 59 plus "…", counts), so the redact-first fix does not break it', () => {
  const command = `echo ${'y'.repeat(100)}`;
  const events = [ev(1, 'assistant', 'one'), ev(2, 'tool_use', command, { toolName: 'Bash' } as Partial<ChatEvent>), ev(3, 'tool_use', command, { toolName: 'Bash' } as Partial<ChatEvent>), ev(4, 'assistant', 'two')];
  const out = transferConversation(events, 100_000, 4_000).text;
  assert.match(out, /_Tools used: Bash \(echo y+…\) ×2_/, `the line keeps its form: ${out}`);
});
