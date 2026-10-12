// T-AUTH (the key and signature part, docs/prd/targets-connect.md §9.2, §10): the contract's vector, key validation, rotation signatures.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { CONNECT_TEST_VECTORS, connectSignedMessage } from '@portal/contracts';
import {
  b64u,
  fromB64u,
  generateNodeKeyPair,
  keyFingerprint,
  keyPairFromSeed,
  newConnId,
  newNonce,
  publicKeyOf,
  publicKeyProblem,
  signChallenge,
  signRekey,
  spendVerifyTime,
  verifyChallenge,
  verifyRekey,
} from './auth.js';

const h = CONNECT_TEST_VECTORS.handshake;

describe('handshake vector', () => {
  const pair = keyPairFromSeed(fromB64u(h.seed));

  test('the seed gives the contract’s public key and fingerprint', () => {
    assert.equal(pair.publicKey, h.publicKey);
    assert.equal(keyFingerprint(h.publicKey), h.fingerprint);
    assert.equal(publicKeyOf(pair.privateKey), h.publicKey);
  });

  test('the signature over the signed message is the contract’s (Ed25519 is deterministic)', () => {
    assert.equal(connectSignedMessage(h.connId, h.nonce, h.node), `claudepilot-connect-v1\n${h.connId}\n${h.nonce}\n${h.node}`);
    assert.equal(signChallenge(pair.privateKey, h.connId, h.nonce, h.node), h.signature);
    assert.equal(verifyChallenge(h.publicKey, h.signature, h.connId, h.nonce, h.node), true);
  });

  test('a signature made for one challenge does not verify for another, or with another key', () => {
    assert.equal(verifyChallenge(h.publicKey, h.signature, 'c0ffee00-0000-4000-8000-000000000002', h.nonce, h.node), false);
    assert.equal(verifyChallenge(h.publicKey, h.signature, h.connId, newNonce(), h.node), false);
    assert.equal(verifyChallenge(h.publicKey, h.signature, h.connId, h.nonce, 'nd_ffffffffffff'), false);
    assert.equal(verifyChallenge(generateNodeKeyPair().publicKey, h.signature, h.connId, h.nonce, h.node), false);
  });

  test('garbage never throws: a short, long or non-base64 signature is simply false', () => {
    for (const sig of ['', 'AAAA', 'x'.repeat(200), b64u(randomBytes(63)), b64u(randomBytes(65)), '!!!']) assert.equal(verifyChallenge(h.publicKey, sig, h.connId, h.nonce, h.node), false);
    assert.equal(verifyChallenge('not a key', h.signature, h.connId, h.nonce, h.node), false);
  });
});

describe('keys', () => {
  test('a generated pair is valid, its fingerprint is 32 hex, and the public key is recoverable from the private one', () => {
    for (let i = 0; i < 300; i++) {
      const k = generateNodeKeyPair();
      assert.equal(publicKeyProblem(k.publicKey), null, 'a real key must never be refused');
      assert.equal(publicKeyOf(k.privateKey), k.publicKey);
      assert.match(keyFingerprint(k.publicKey), /^[0-9a-f]{32}$/);
    }
  });

  test('publicKeyProblem: wrong shapes, and bytes that are not a point of the curve', () => {
    for (const bad of [undefined, null, 42, '', 'abc', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}!`, b64u(randomBytes(31)), b64u(randomBytes(33))]) {
      assert.match(publicKeyProblem(bad) ?? '', /32 bytes/);
    }
    // about half of all 32-byte strings are not on the curve: refusing exactly those is what "forms a valid key" means
    let off = 0;
    for (let i = 0; i < 400; i++) if (publicKeyProblem(b64u(randomBytes(32))) === 'That is not an Ed25519 public key.') off++;
    assert.ok(off > 120 && off < 280, `${off} of 400 random strings were off the curve`);
    // y = p is not canonical (y must be below p = 2^255 - 19)
    const nonCanonical = Buffer.alloc(32, 0xff);
    nonCanonical[0] = 0xed;
    nonCanonical[31] = 0x7f;
    assert.equal(publicKeyProblem(b64u(nonCanonical)), 'That is not an Ed25519 public key.');
    // the identity point (y = 1) is on the curve
    const identity = Buffer.alloc(32);
    identity[0] = 1;
    assert.equal(publicKeyProblem(b64u(identity)), null);
  });

  test('a key rotation is signed with the OLD key over the new public key', () => {
    const old = generateNodeKeyPair();
    const next = generateNodeKeyPair();
    const sig = signRekey(old.privateKey, 'nd_0123456789ab', next.publicKey);
    assert.equal(verifyRekey(old.publicKey, sig, 'nd_0123456789ab', next.publicKey), true);
    assert.equal(verifyRekey(next.publicKey, sig, 'nd_0123456789ab', next.publicKey), false, 'the new key can not vouch for itself');
    assert.equal(verifyRekey(old.publicKey, sig, 'nd_0123456789ab', generateNodeKeyPair().publicKey), false);
    assert.equal(verifyRekey(old.publicKey, sig, 'nd_other0000000', next.publicKey), false);
  });

  test('nonces are 32 random bytes and connection ids are UUIDs', () => {
    assert.equal(fromB64u(newNonce()).length, 32);
    assert.notEqual(newNonce(), newNonce());
    assert.match(newConnId(), /^[0-9a-f-]{36}$/);
    assert.doesNotThrow(spendVerifyTime);
  });
});
