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
