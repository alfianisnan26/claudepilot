// T-1065: a password, secret or token after its key goes at any length, and so does the password of URL userinfo.
// Every value is built at runtime (no credential-shaped literal in the repository).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_HOLD, REDACTED, redact, StreamRedactor } from './redact.js';

/** A short value made at runtime; `MARK` lets a test see whether any of it survived. */
const MARK = ['q', 'z', 'x'].join('');
const short = (n: number) => `${MARK}${String(n)}`; // e.g. "qzx7": four characters, no shape of its own
const spaced = `${MARK} ${MARK}`; // a quoted value with a space in it

const NAMES = ['password', 'passwd', 'pwd', 'secret', 'token', 'DB_PASSWORD', 'client_secret', 'X-Auth-Token', 'mysql.pwd'];

test('T-1065: the value after a password, passwd, pwd, secret or token key goes at any length, in every key form', () => {
  for (const k of NAMES) {
    const v = short(7);
    const cases: [string, string][] = [
      [`${k}=${v}`, `${k}=${REDACTED}`],
      [`export ${k}=${MARK}`, `export ${k}=${REDACTED}`],
      [`${k}: ${v}`, `${k}: ${REDACTED}`],
      [`${k} = ${v}`, `${k} = ${REDACTED}`],
      [`{"${k}":"${v}"}`, `{"${k}":"${REDACTED}"}`],
      [`{"${k}": "${spaced}", "n": 1}`, `{"${k}": "${REDACTED}", "n": 1}`],
      [`${k}='${spaced}' next`, `${k}='${REDACTED}' next`],
      [`${k} = "${spaced}"`, `${k} = "${REDACTED}"`],
      [`https://x.io/cb?${k}=${v}&next=1`, `https://x.io/cb?${k}=${REDACTED}&next=1`],
      [`--${k}=${v} --verbose`, `--${k}=${REDACTED} --verbose`],
    ];
    for (const [input, want] of cases) {
      const out = redact(input);
      assert.equal(out, want, input);
      assert.ok(!out.includes(MARK), `${input} kept part of its value`);
    }
  }
  // One character is a value too, and a quoted value keeps an escaped quote inside it.
  assert.equal(redact(`password=${MARK[0]}`), `password=${REDACTED}`);
  assert.equal(redact(`{"token":"${MARK}\\"${MARK}"}`), `{"token":"${REDACTED}"}`);
  // A value that is a type name in another case is still a value when it is longer.
  assert.equal(redact(`password: string${MARK}`), `password: ${REDACTED}`);
});

test('T-1065: the password of URL userinfo goes; the scheme, the user and the host stay', () => {
  const pw = short(3);
  const cases: [string, string][] = [
    [`postgres://app:${pw}@db.internal:5432/main`, `postgres://app:${REDACTED}@db.internal:5432/main`],
    [`git clone https://bot:${pw}@git.example.com/org/repo.git`, `git clone https://bot:${REDACTED}@git.example.com/org/repo.git`],
    [`redis://:${pw}@cache:6379`, `redis://:${REDACTED}@cache:6379`],
    // An `@` inside the password: the last one before the host ends it, so nothing of it is left.
    [`amqp://user:${MARK}@${MARK}@mq.local/vhost`, `amqp://user:${REDACTED}@mq.local/vhost`],
    [`see (mongodb+srv://u:${pw}@c0.example.net/?retryWrites=true)`, `see (mongodb+srv://u:${REDACTED}@c0.example.net/?retryWrites=true)`],
  ];
  for (const [input, want] of cases) {
    const out = redact(input);
    assert.equal(out, want, input);
    assert.ok(!out.includes(MARK), `${input} kept part of its password`);
  }
});

test('T-1065: the word password in prose, comparisons, types and URLs without a password are left alone', () => {
  for (const text of [
    'Reset your password and sign in again.',
    'The password field is required; a token is sent by mail.',
    'Use a secret manager, never a plain password in the repo.',
    'max_tokens: 1024',
    'secretName: portal-db',
    'if (password === confirm) save();',
    'if (token == null) return;',
    'const check = (token) => token.length > 0;',
    'type Login = { password: string; token: string | null; otp?: number };',
    'password: process.env.DB_PASSWORD',
    'https://example.com:8443/path?q=1',
    'ssh://git@host.example:22/org/repo.git',
    'git@github.com:org/repo.git',
    'http://localhost:3000/a',
    'mail me at someone@example.com: thanks',
  ])
    assert.equal(redact(text), text, text);
});

// Twins: each case above next to the same text with the one thing changed that makes it a secret. The secret goes, its twin stays whole,
// so a rule widened past that one thing (a name that only contains the word, `==` or `=>`, a URL with no `@` after the colon) fails here.
test('T-1065 twins: a key form next to the same text whose name does not end in the word, or that compares', () => {
  for (const k of NAMES) {
    const v = short(4);
    const pairs: [string, string][] = [
      [`${k}=${v}`, `${k}_hint=${v}`],
      [`${k}: ${v}`, `${k}less: ${v}`],
      [`{"${k}":"${v}"}`, `{"${k}_len":"${v}"}`],
      [`${k}='${spaced}' next`, `${k}.file='${spaced}' next`],
      [`--${k}=${v} --verbose`, `--${k}-file=${v} --verbose`],
      [`https://x.io/cb?${k}=${v}&next=1`, `https://x.io/cb?${k}_kind=${v}&next=1`],
      [`${k} = ${v}`, `${k} == ${v}`],
      [`${k}=${v}`, `${k}=>${v}`],
    ];
    for (const [secret, twin] of pairs) {
      assert.ok(!redact(secret).includes(MARK), `${secret} kept part of its value`);
      assert.equal(redact(twin), twin, `the twin of ${secret}`);
    }
  }
});

test('T-1065 twins: a URL with a userinfo password next to the same URL without one', () => {
  const pw = short(6);
  const pairs: [string, string][] = [
    [`postgres://app:${pw}@db.internal:5432/main`, `postgres://app@db.internal:5432/main`],
    [`postgres://app:${pw}@db.internal:5432/main`, `postgres://db.internal:5432/${pw}`],
    [`git clone https://bot:${pw}@git.example.com/org/repo.git`, `git clone https://bot@git.example.com/org/repo.git`],
    [`redis://:${pw}@cache:6379`, `redis://cache:6379/${pw}`],
    // A colon and an `@` after the host are a path, not userinfo.
    [`https://u:${pw}@x.io/a`, `https://x.io/u:${pw}@a`],
    [`amqp://user:${MARK}@${MARK}@mq.local/vhost`, `amqp://user@mq.local/${MARK}@${MARK}`],
  ];
  for (const [secret, twin] of pairs) {
    assert.ok(!redact(secret).includes(MARK), `${secret} kept part of its password`);
    assert.equal(redact(twin), twin, `the twin of ${secret}`);
  }
});

test('T-1065 twins: in a stream the twin comes out whole wherever it is split', () => {
  for (const text of [`Here: pwd_hint=${short(5)} and more.`, `Use password == ${MARK} here.`, `Open postgres://app@db.internal:5432/${MARK} now.`, `See https://x.io/u:${MARK}@a too.`]) {
    assert.equal(redact(text), text, text);
    for (let at = 0; at <= text.length; at++) {
      const r = new StreamRedactor();
      assert.equal([r.push(text.slice(0, at)), r.push(text.slice(at)), r.flush()].join(''), text, `${text} split at ${at}`);
    }
  }
});

// QA #11410: prose with a colon after the word is not cut. Each secret differs from its twin in the one thing that makes it a value: a
// digit in it, or the end of its line after it.
test('T-1065 twins: a word of prose after `password:` stays; a value there still goes', () => {
  const pairs: [string, string][] = [
    [`Enter your password: ${MARK}7 then press enter`, `Enter your password: ${MARK} then press enter`],
    [`password: ${MARK}\nnext`, `password: ${MARK} next`],
    [`password: ${MARK}`, `password: ${MARK}, then`],
    [`"token": ${MARK}-x and more`, `"token": ${MARK} and more`],
  ];
  for (const [secret, twin] of pairs) {
    assert.ok(!redact(secret).includes(MARK), `${secret} kept part of its value`);
    assert.equal(redact(twin), twin, `the twin of ${secret}`);
  }
  // `=` is never prose: the word goes there, more text or not.
  assert.equal(redact(`password=${MARK} then`), `password=${REDACTED} then`);
  // Split anywhere, a stream gives what the whole text gives, and never shows the value.
  for (const text of [`Enter your password: ${MARK} then press enter`, `password: ${MARK}\nnext`, `Say password: ${MARK}`]) {
    const whole = redact(text);
    for (let at = 0; at <= text.length; at++) {
      const r = new StreamRedactor();
      const frames = [r.push(text.slice(0, at)), r.push(text.slice(at)), r.flush()];
      assert.equal(frames.join(''), whole, `${text} split at ${at}`);
    }
    const r = new StreamRedactor();
    let out = '';
    for (const ch of text) out += r.push(ch);
    assert.equal(out + r.flush(), whole, `${text} one character at a time`);
  }
});

test('T-1065: redacting twice changes nothing more', () => {
  const text = `password=${MARK} and {"token": "${spaced}"} and postgres://a:${MARK}@db/x`;
  const once = redact(text);
  assert.ok(!once.includes(MARK), once);
  assert.equal(redact(once), once);
});

test('T-1065: in a stream, a short password or a userinfo password split anywhere never reaches the output', () => {
  const texts = [
    `Here: pwd=${short(5)} and more words.`,
    `Config {"password": "${spaced}", "user": "app"} done.`,
    `secret='${spaced}' then text`,
    `Clone postgres://app:${short(9)}@db.internal:5432/main now.`,
    `Clone redis://:${MARK}@${MARK}@cache:6379 now.`,
    'Types: { password: string; token: null } stay.',
  ];
  for (const text of texts) {
    const whole = redact(text);
    for (let at = 0; at <= text.length; at++) {
      const r = new StreamRedactor();
      const frames = [r.push(text.slice(0, at)), r.push(text.slice(at)), r.flush()];
      assert.ok(!frames.some((f) => f.includes(MARK)), `${text} split at ${at}: ${JSON.stringify(frames)}`);
      assert.equal(frames.join(''), whole, `${text} split at ${at}`);
    }
    const r = new StreamRedactor();
    let out = '';
    for (const ch of text) {
      const frame = r.push(ch);
      assert.ok(!frame.includes(MARK), `${text} one character at a time: ${frame}`);
      assert.ok(r.holding <= MAX_HOLD, `${text} held ${r.holding}`);
      out += frame;
    }
    assert.equal(out + r.flush(), whole, `${text} one character at a time`);
  }
});
