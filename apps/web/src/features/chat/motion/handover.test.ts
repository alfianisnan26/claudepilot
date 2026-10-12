import type { ChatEvent } from '@portal/contracts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findStored } from './handover';

const ev = (seq: number, kind: ChatEvent['kind'], text?: string, agentLabel?: string | null): ChatEvent => ({ seq, at: '', kind, text, agentLabel });
const live = (text: string, agentLabel: string | null = null, startSeq = 4) => ({ text, agentLabel, startSeq });

describe('findStored: which stored reply a live one became', () => {
  it('finds the reply with the same text, new since the live one began', () => {
    const found = findStored(live('Hello there'), [ev(3, 'assistant', 'Hello there'), ev(5, 'assistant', 'Hello there'), ev(6, 'result')]);
    assert.deepEqual(found, { seq: 5, text: 'Hello there' });
  });

  it('ignores replies from before it began, even with the same text', () => {
    assert.equal(findStored(live('Same'), [ev(3, 'assistant', 'Same'), ev(4, 'assistant', 'Same')]), null);
  });

  it('takes the stored text when it carries on past what was shown (the tail still arriving)', () => {
    assert.deepEqual(findStored(live('The end is near'), [ev(5, 'assistant', 'The end is nearly here.')]), { seq: 5, text: 'The end is nearly here.' });
  });

  it('takes no notice of trailing whitespace, and keeps the shown text (the reveal carries on from it)', () => {
    assert.deepEqual(findStored(live('Done.\n\n'), [ev(5, 'assistant', 'Done.')]), { seq: 5, text: 'Done.\n\n' });
    assert.deepEqual(findStored(live('Done.'), [ev(5, 'assistant', 'Done.\n')]), { seq: 5, text: 'Done.\n' });
  });

  it('keeps the shown text when the stored one is shorter than it (the shown text carried on past it)', () => {
    assert.deepEqual(findStored(live('Done. And one more thing'), [ev(5, 'assistant', 'Done.')]), { seq: 5, text: 'Done. And one more thing' });
  });

  it('does not match a reply that diverges from what was shown', () => {
    assert.equal(findStored(live('Hello world'), [ev(5, 'assistant', 'Hello there')]), null);
  });

  it('does not match another agent, other kinds, or a different text', () => {
    assert.equal(findStored(live('Hi', 'agent-1'), [ev(5, 'assistant', 'Hi', 'agent-2')]), null);
    assert.equal(findStored(live('Hi'), [ev(5, 'assistant', 'Hi', 'agent-2')]), null);
    assert.equal(findStored(live('Hi'), [ev(5, 'user', 'Hi')]), null);
    assert.equal(findStored(live('Hi there'), [ev(5, 'assistant', 'Something else')]), null);
    assert.equal(findStored(live('Hi'), []), null);
  });

  it('matches a sub-agent reply to its own label', () => {
    assert.deepEqual(findStored(live('Result', 'agent-1'), [ev(5, 'assistant', 'Result', 'agent-1')]), { seq: 5, text: 'Result' });
  });
});
