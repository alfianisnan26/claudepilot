import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankInRemoteMcp, hasClaudeCredential, secretCredentialType, secretVariableReserved } from '@portal/contracts';
import { secretHint } from './values.js';

/* FR5 canaries (PRD §13): fake values in the shapes Claude credentials take, never real ones. */
const OAT = 'sk-ant-oat01-FAKEfakeFAKEfake0123456789abcdefABCDEF_-xyzXYZ0123456789AA';
const ORT = 'sk-ant-ort01-FAKEfakeFAKEfake9876543210fedcbaFEDCBA-_zyxZYX9876543210BB';
const API = 'sk-ant-api03-FAKEfakeFAKEfake00000000000000000000000000000000000000000-AAAAAAAA';
const ADMIN = 'sk-ant-admin01-FAKEfakeFAKEfake1111111111111111111111111111111111111111-BBBB';
const CREDENTIALS_JSON = JSON.stringify({
  claudeAiOauth: { accessToken: OAT, refreshToken: ORT, expiresAt: 1760000000000, scopes: ['user:inference'], subscriptionType: 'max' },
});
/** Just the key, with no `sk-ant-` anywhere (an exported file with tokens stripped still is a sign-in). */
const CREDENTIALS_SHAPE = '{"claudeAiOauth":{"accessToken":"","refreshToken":""}}';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const pct = (s: string) => [...Buffer.from(s, 'utf8')].map((b) => `%${b.toString(16).padStart(2, '0').toUpperCase()}`).join('');
const jsonEsc = (s: string) => s.replace(/[^A-Za-z0-9 ]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const ENCODINGS: [string, (s: string) => string][] = [
  ['raw', (s) => s],
  ['base64', b64],
  ['base64url', b64url],
  ['base64 twice', (s) => b64(b64(s))],
  ['base64url of base64', (s) => b64url(b64(s))],
  ['URL-encoded', pct],
  ['URL-encoded partly', encodeURIComponent],
  ['JSON-escaped', jsonEsc],
  ['JSON string', (s) => JSON.stringify(JSON.stringify(s))],
  ['base64 of JSON-escaped', (s) => b64(jsonEsc(s))],
  ['URL-encoded base64', (s) => pct(b64(s))],
  ['base64 inside text', (s) => `token: ${b64(s)} (copied)`],
  ['base64 glued to a word', (s) => `prefix${b64(`xx${s}`)}`],
  ['basic auth header', (s) => `Authorization: Basic ${b64(`user:${s}`)}`],
];

test('FR5: every Claude credential is refused, raw and in every encoding (fake .credentials.json, Bearer oat, bare ort, api and admin keys)', () => {
  const samples: [string, string][] = [
    ['.credentials.json', CREDENTIALS_JSON],
    ['credentials shape without tokens', CREDENTIALS_SHAPE],
    ['Bearer sk-ant-oat01', `Bearer ${OAT}`],
    ['bare sk-ant-ort01', ORT],
    ['sk-ant-api03', API],
    ['sk-ant-admin01', ADMIN],
    ['an app config holding a key', `ANTHROPIC_KEY=${API}\nOTHER=1`],
    ['upper case', OAT.toUpperCase()],
  ];
  for (const [what, value] of samples)
    for (const [how, encode] of ENCODINGS) assert.equal(hasClaudeCredential(encode(value)), true, `${what}, ${how}`);
});

test('FR5: other values pass, including other vendors’ keys, random base64 and near misses', () => {
  const fine = [
    '',
    'eu-west-1',
    'ghp_FAKEfakeFAKEfake0123456789abcdefABCD',
    'npm_FAKEfakeFAKEfake0123456789abcdefAB',
    'AKIAFAKEFAKEFAKE1234',
    b64('just some config, nothing secret here at all'),
    Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256)).toString('base64'),
    'sk-test-1234567890',
    'skant-key',
    'ask-antler',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2EAAAADAQABAAABAQ\n-----END OPENSSH PRIVATE KEY-----\n',
    'claude.ai/oauth',
  ];
  for (const value of fine) assert.equal(hasClaudeCredential(value), false, value.slice(0, 40));
});

test('FR5: large values are scanned quickly (256 KB of base64)', () => {
  const big = Buffer.alloc(192 * 1024, 7).toString('base64');
  const started = performance.now();
  assert.equal(hasClaudeCredential(big), false);
  assert.equal(hasClaudeCredential(`${big}${b64(OAT)}`), true);
  assert.ok(performance.now() - started < 2000, `${Math.round(performance.now() - started)} ms`);
});

test('FR6: credential-looking values (prefixes, PEM headers, JWTs, 20+ random characters); plain values don’t', () => {
  const looks: [string, string][] = [
    ['ghp_FAKEfakeFAKEfake0123456789abcdefABCD', 'github'],
    ['github_pat_11FAKEFAKE0abcdefghijklmnopqrstuvwxyz', 'github'],
    ['glpat' + '-FAKEfakeFAKEfake0123', 'gitlab'],
    ['npm_FAKEfakeFAKEfake0123456789abcdefAB', 'npm'],
    ['AKIAFAKEFAKEFAKE1234', 'aws'],
    ['xoxb-1234567890-FAKEfake', 'slack'],
    ['sk_live_FAKEfakeFAKEfake0123', 'stripe'],
    ['AIzaFAKEfakeFAKEfake0123456789abcdefABC', 'google'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'pem'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl', 'jwt'],
    ['Zx8Qp2Lm9Vt4Rw7Ny3Ks6Hb1', 'random'],
    ['3f9a1c2e8b7d6f5a4c3b2a1908f7e6d5c4b3a291', 'random'],
  ];
  for (const [value, type] of looks) assert.equal(secretCredentialType(value), type, value);
  const plain = [
    'eu-west-1',
    'https://api.example.com/v1/items?limit=100',
    '/home/node/.config/gh',
    'my-very-long-project-name-2024',
    '123e4567-e89b-12d3-a456-426614174000',
    'THIS_IS_A_LONG_CONSTANT_NAME_HERE',
    'production',
    '2026-10-10T00:00:00Z',
    'postgres://db.internal:5432/app',
  ];
  for (const value of plain) assert.equal(secretCredentialType(value), null, value);
});

test('hints: a known prefix and the last four of 20+ characters, else dots', () => {
  assert.equal(secretHint('ghp_FAKEfakeFAKEfake0123456789abcdefABCD'), 'ghp_…ABCD');
  assert.equal(secretHint('AKIAFAKEFAKEFAKE1234'), 'AKIA…1234');
  assert.equal(secretHint('Zx8Qp2Lm9Vt4Rw7Ny3Ks6Hb1'), '…6Hb1');
  assert.equal(secretHint('short-one'), '••••••');
  assert.equal(secretHint('-----BEGIN KEY-----\nAAAAAAAAAAAAAAAAAAAAAAAA\n-----END KEY-----\n'), '••••••');
});

test('FR4 reserved names, and FR24 names remote MCP servers read as empty', () => {
  for (const name of ['ANTHROPIC_API_KEY', 'claude_x', 'CLAUDEPILOT_ACCOUNT', 'MCP_TOOL_TIMEOUT', 'DISABLE_AUTOUPDATER', 'HOME', 'LD_LIBRARY_PATH', 'Http_Proxy', 'NODE_TLS_REJECT_UNAUTHORIZED', 'AWS_CA_BUNDLE', 'GIT_CONFIG_COUNT', 'GIT_SSH', 'GIT_ASKPASS', 'GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES', 'NPM_CONFIG_GLOBALCONFIG'])
    assert.ok(secretVariableReserved(name), name);
  for (const name of ['LINEAR_API_KEY', 'NPM_TOKEN', 'GITHUB_TOKEN', 'DATABASE_URL', 'MY_PATH']) assert.equal(secretVariableReserved(name), null, name);
  for (const name of ['NPM_TOKEN', 'HTTPS_PROXY', 'https_proxy', 'NODE_AUTH_TOKEN', 'PIP_INDEX_URL', 'VAULT_TOKEN', 'INPUT_NPM_TOKEN', 'GIT_CONFIG_VALUE_0', 'CARGO_REGISTRIES_MY_TOKEN'])
    assert.ok(blankInRemoteMcp(name), name);
  for (const name of ['LINEAR_API_KEY', 'CONTEXT7_API_KEY', 'GITHUB_TOKEN', 'REGION']) assert.equal(blankInRemoteMcp(name), false, name);
});
