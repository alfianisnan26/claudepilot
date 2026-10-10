import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateSecretKey, loadSecretKey, parseSecretKey, SecretBox, SecretKeyError, SecretOpenError } from './secretBox.js';

const slot = { table: 'accounts', row: 'a1', column: 'secret' };
const box = () => new SecretBox(parseSecretKey(generateSecretKey()));

test('seal then open returns the plaintext', () => {
  const b = box();
  const sealed = b.seal('sk-ant-example', slot);
  assert.match(sealed, /^v1\.[0-9a-f]{12}\.[\w-]+\.[\w-]+$/);
  assert.equal(b.open(sealed, slot), 'sk-ant-example');
});

test('each seal uses a fresh IV', () => {
  const b = box();
  assert.notEqual(b.seal('same', slot), b.seal('same', slot));
});

test('a value moved to another row or column does not open', () => {
  const b = box();
  const sealed = b.seal('secret', slot);
  assert.throws(() => b.open(sealed, { ...slot, row: 'a2' }), SecretOpenError);
  assert.throws(() => b.open(sealed, { ...slot, column: 'other' }), SecretOpenError);
});

test('another key does not open it, and says so', () => {
  const sealed = box().seal('secret', slot);
  assert.throws(() => box().open(sealed, slot), /another key/);
});

test('a tampered value does not open', () => {
  const b = box();
  const sealed = b.seal('secret', slot);
  const parts = sealed.split('.');
  const body = Buffer.from(parts[3]!, 'base64url');
  body[0] = body[0]! ^ 1;
  parts[3] = body.toString('base64url');
  assert.throws(() => b.open(parts.join('.'), slot), SecretOpenError);
});

test('the key ID is stable per key and readable from an envelope', () => {
  const key = parseSecretKey(generateSecretKey());
  const a = new SecretBox(key);
  const b = new SecretBox(key);
  assert.equal(a.keyId, b.keyId);
  assert.equal(SecretBox.keyIdOf(a.seal('x', slot)), a.keyId);
  assert.equal(SecretBox.keyIdOf('not an envelope'), null);
});

test('keys must be 32 bytes', () => {
  assert.throws(() => parseSecretKey('c2hvcnQ'), SecretKeyError);
  assert.equal(parseSecretKey(generateSecretKey()).length, 32);
  // plain base64 (with + / =) is accepted too
  assert.equal(parseSecretKey(Buffer.alloc(32, 255).toString('base64')).length, 32);
});

test('loadSecretKey reads the variable or the file, and is null when neither is set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-key-'));
  const key = generateSecretKey();
  writeFileSync(join(dir, 'k'), `${key}\n`);
  assert.equal(loadSecretKey({ file: join(dir, 'k') })!.toString('base64url'), key);
  assert.equal(loadSecretKey({ value: key })!.toString('base64url'), key);
  assert.equal(loadSecretKey({}), null);
  assert.throws(() => loadSecretKey({ file: join(dir, 'missing') }), /can't be read/);
});
