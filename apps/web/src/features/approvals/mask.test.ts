import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MASK, maskPayload, payloadText } from './mask.js';

// Credential-shaped values are built at run time: no token-shaped literal in the repository.
const shaped = () => ['gh', 'p_', 'B'.repeat(36)].join('');

test('the card masks secret-named keys and secret-shaped values at any depth, and keeps names and ordinary text', () => {
  const out = maskPayload({
    sessionId: 'abc-123',
    secretName: 'DEPLOY_TOKEN',
    token: 'anything',
    nested: { password: 'x', list: ['ok', shaped()], note: `see ${shaped()}` },
    empty: { apiKey: '' },
    n: 3,
  });
  assert.deepEqual(out, {
    sessionId: 'abc-123',
    secretName: 'DEPLOY_TOKEN',
    token: MASK,
    nested: { password: MASK, list: ['ok', MASK], note: MASK },
    empty: { apiKey: '' },
    n: 3,
  });
});

test('the text is the exact payload, indented, when nothing needs masking', () => {
  assert.equal(payloadText({ sessionId: 's-1' }), '{\n  "sessionId": "s-1"\n}');
  assert.ok(!payloadText({ text: shaped() }).includes(shaped()));
});
