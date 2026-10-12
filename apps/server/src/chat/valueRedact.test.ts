// QA-006: a secret the agent was allowed to print never reaches the transcript, a socket frame or the events API.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REDACTED, redact, StreamRedactor } from './redact.js';
import { NO_VALUES, SessionStream, ValueRedactor, variantsOf } from './valueRedact.js';

const SECRET = 'Hunter2/Pa$$w0rd+Zq9 "x"\\n';
const TOKEN = 'cpst_Zk3pQ7vR1mT8xN4bC6yL0wH2dF5gJ9aS-uE_iO';

test('forms: raw, JSON-escaped, URL-encoded (both cases of the hex), form-encoded and base64 at every alignment', () => {
  const r = new ValueRedactor([SECRET]);
  assert.equal(r.redact(`pw=${SECRET}!`), `pw=${REDACTED}!`);
  assert.equal(r.redact(`{"p":"${JSON.stringify(SECRET).slice(1, -1)}"}`), `{"p":"${REDACTED}"}`);
  assert.equal(r.redact(`?p=${encodeURIComponent(SECRET)}&x=1`), `?p=${REDACTED}&x=1`);
  assert.equal(r.redact(`?p=${encodeURIComponent(SECRET).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())}`), `?p=${REDACTED}`);
  assert.equal(r.redact(`?p=${encodeURIComponent(SECRET).replace(/%20/g, '+')}`), `?p=${REDACTED}`);
  // base64 of a longer string that contains it, wherever it starts and ends (Basic auth, a JSON blob, an env dump).
  for (let head = 0; head < 3; head++) {
    for (let tail = 0; tail < 3; tail++) {
      const wrapped = 'a'.repeat(head) + SECRET + 'z'.repeat(tail);
      for (const form of [Buffer.from(wrapped).toString('base64'), Buffer.from(wrapped).toString('base64url')]) {
        const out = r.redact(`Authorization: Basic ${form}`);
        assert.ok(out.includes(REDACTED), `head ${head} tail ${tail}: ${out}`);
        assert.ok(out.length < form.length, 'most of the encoded text went');
      }
    }
  }
  assert.ok(variantsOf(SECRET).length >= 8);
});

test('what is not a secret stays: short values, ordinary text, and a value the text only resembles', () => {
  const r = new ValueRedactor(['abc12', 'x', '', 'correct-horse-battery']);
  assert.equal(r.redact('abc12 and x go through'), 'abc12 and x go through');
  assert.equal(r.redact('correct-horse-battery-staple'), `${REDACTED}-staple`);
  assert.equal(r.redact('correct-horse-batter'), 'correct-horse-batter');
  assert.equal(new ValueRedactor([]).active, false);
  assert.equal(NO_VALUES.redact('anything'), 'anything');
});

test('the longest value wins where two start at the same place, and neighbours are all taken out', () => {
  const r = new ValueRedactor(['secret-one', 'secret-one-and-more']);
  assert.equal(r.redact('x secret-one-and-more y secret-one z'), `x ${REDACTED} y ${REDACTED} z`);
  assert.equal(r.redact('secret-onesecret-one'), `${REDACTED}${REDACTED}`);
});

test('streaming: a value split across deltas at any point never reaches the screen', () => {
  const values = new ValueRedactor([SECRET, 'another-secret-value-123']);
  const whole = `before ${SECRET} between another-secret-value-123 after`;
  const expected = values.redact(whole);
  for (let at = 1; at < whole.length; at++) {
    const stream = new SessionStream(values);
    const shown = stream.push(whole.slice(0, at)) + stream.push(whole.slice(at)) + stream.flush();
    assert.equal(shown, expected, `split at ${at}`);
  }
  // Many tiny deltas, and a tail that only looked like the start of a value is shown at the end.
  const stream = new SessionStream(values);
  let shown = '';
  for (const ch of `see another-secret-value-12 done`) shown += stream.push(ch);
  shown += stream.flush();
  assert.equal(shown, 'see another-secret-value-12 done');
  assert.equal(stream.holding, 0);
});

test('streaming holds back only what could still become a value', () => {
  const stream = new SessionStream(new ValueRedactor(['correct-horse-battery']));
  assert.equal(stream.push('just words '), 'just words ');
  assert.equal(stream.holding, 0);
  assert.equal(stream.push('then correct-ho'), 'then ');
  assert.equal(stream.holding, 10);
  assert.equal(stream.push('rse-battery!'), `${REDACTED}!`);
});

test('a value inside a longer text with credential shapes: both layers apply', () => {
  const values = new ValueRedactor(['my-internal-passphrase']);
  const text = `key sk-ant-api03-${'A1b2'.repeat(10)} and my-internal-passphrase`;
  const stream = new SessionStream(values);
  const out = stream.push(text) + stream.flush();
  assert.ok(!out.includes('my-internal-passphrase') && !out.includes('sk-ant-api03-A1b2'));
  assert.ok(new StreamRedactor().push(text).includes('my-internal-passphrase'), 'the shape layer alone does not know the value');
});

test('many values and a big text stay fast', () => {
  const values = Array.from({ length: 500 }, (_, i) => `value-${i}-${'q7Zk'.repeat(5)}`);
  const r = new ValueRedactor(values);
  const text = `${'lorem ipsum dolor sit amet '.repeat(40_000)}${values[321]}${' tail'.repeat(100)}`;
  const t = Date.now();
  const out = r.redact(text);
  assert.ok(!out.includes(values[321]!));
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
});

test('the portal’s own tokens are credentials by shape: an agent token printed by a tool never lands in a transcript', () => {
  for (const token of [TOKEN, 'cpat_' + 'a1B2'.repeat(11), 'cpoa_' + 'x9Y8'.repeat(8), 'cpor_' + 'k3L4'.repeat(8)]) {
    assert.equal(redact(`PILOT_MCP_TOKEN=${token}`), `PILOT_MCP_TOKEN=${REDACTED}`);
    assert.equal(redact(`curl -H "Authorization: Bearer ${token}" http://x`), `curl -H "Authorization: Bearer ${REDACTED}" http://x`);
    assert.equal(redact(`token is ${token}.`), `token is ${REDACTED}.`);
    for (let at = 1; at < token.length + 10; at++) {
      const text = `export T=${token} ok`;
      const stream = new StreamRedactor();
      const shown = stream.push(text.slice(0, at)) + stream.push(text.slice(at)) + stream.flush();
      assert.ok(!shown.includes(token.slice(5, 25)), `split at ${at}: ${shown}`);
    }
  }
  assert.equal(redact('cpst_short'), 'cpst_short', 'a word that only starts like one is left alone');
});
