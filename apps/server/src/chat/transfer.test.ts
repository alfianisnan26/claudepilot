// T-781 S1b leak: the transfer text is redacted before it is clipped, so a secret that straddles the clip boundary leaves no prefix.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatEvent } from '@portal/contracts';
import { transferConversation } from './transfer.js';

test('a secret cut by the 59-character tool summary leaves no prefix in the tools line', () => {
  const secret = `${['sk', 'ant', 'api03'].join('-')}-${'Zq7'.repeat(14)}`;
  for (const keep of [3, 7, 12, 20]) {
    const command = `${'p'.repeat(59 - keep)}${secret}`; // `keep` characters of the secret fall inside the 59
    const events: ChatEvent[] = [{ seq: 1, at: '2026-10-16T12:00:00Z', kind: 'tool_use', toolName: 'Bash', text: command }];
    const out = transferConversation(events).text;
    assert.ok(!out.includes('sk-'), `no "sk-" prefix remains (keep=${keep}): ${out}`);
    assert.ok(!out.includes('Zq7'), `no secret body remains (keep=${keep})`);
  }
});

test('a secret straddling the per-message clip leaves no prefix in the transfer text', () => {
  const max = 200;
  // Built at runtime: never a token-shaped literal in the source.
  const secret = `${['sk', 'ant', 'api03'].join('-')}-${'Zq7'.repeat(14)}`;
  for (const keep of [3, 7, 12, 20]) {
    // `keep` characters of the secret fall inside the clip: with the clip first they would be a bare prefix.
    const text = `${'p'.repeat(max - keep)}${secret} and more`;
    const events: ChatEvent[] = [{ seq: 1, at: '2026-10-16T12:00:00Z', kind: 'assistant', text }];
    const out = transferConversation(events, 100_000, max).text;
    assert.ok(!out.includes('sk-'), `no "sk-" prefix remains (keep=${keep})`);
    assert.ok(!out.includes('Zq7'), `no secret body remains (keep=${keep})`);
  }
});
