// PILOT-1144: the WebCrypto signature module of the contract (the one the Cloudflare Worker's /bridge uses) must agree byte for byte with
// this server's node:crypto one (auth.ts), both ways, and with the contract's vector.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  CONNECT_TEST_VECTORS,
  connectB64u,
  connectFromB64u,
  connectPkcs8FromSeed,
  connectSha256Hex,
  connectSignChallenge,
  connectTimingSafeEqual,
  connectVerifyChallenge,
} from '@portal/contracts';
import {
  b64u,
  fromB64u,
  generateNodeKeyPair,
  keyPairFromSeed,
  newConnId,
  newNonce,
  sha256Hex,
  signChallenge,
  verifyChallenge,
} from './auth.js';

const v = CONNECT_TEST_VECTORS.handshake;

describe('connectSign (WebCrypto) against auth.ts (node:crypto)', () => {
  test('the vector: the seed gives the same PKCS8, and the same signature verifies', async () => {
    const seed = fromB64u(v.seed);
    assert.equal(connectPkcs8FromSeed(new Uint8Array(seed)), keyPairFromSeed(seed).privateKey);
    assert.equal(await connectSignChallenge(connectPkcs8FromSeed(new Uint8Array(seed)), v.connId, v.nonce, v.node), v.signature);
    assert.equal(await connectVerifyChallenge(v.publicKey, v.signature, v.connId, v.nonce, v.node), true);
  });

  test('signed by node:crypto, verified by WebCrypto; and the other way round', async () => {
    for (let i = 0; i < 5; i++) {
      const keys = generateNodeKeyPair();
      const connId = newConnId();
      const nonce = newNonce();
      const node = `nd_${randomBytes(6).toString('hex')}`;
      assert.equal(
        await connectVerifyChallenge(keys.publicKey, signChallenge(keys.privateKey, connId, nonce, node), connId, nonce, node),
        true,
      );
      assert.equal(
        verifyChallenge(keys.publicKey, await connectSignChallenge(keys.privateKey, connId, nonce, node), connId, nonce, node),
        true,
      );
    }
  });

  test('a wrong node, nonce, connId, key or a flipped bit fails, never throws', async () => {
    const keys = generateNodeKeyPair();
    const other = generateNodeKeyPair();
    const sig = signChallenge(keys.privateKey, 'c1', 'n1', 'nd_a');
    assert.equal(await connectVerifyChallenge(keys.publicKey, sig, 'c1', 'n1', 'nd_b'), false);
    assert.equal(await connectVerifyChallenge(keys.publicKey, sig, 'c1', 'n2', 'nd_a'), false);
    assert.equal(await connectVerifyChallenge(keys.publicKey, sig, 'c2', 'n1', 'nd_a'), false);
    assert.equal(await connectVerifyChallenge(other.publicKey, sig, 'c1', 'n1', 'nd_a'), false);
    const flipped = fromB64u(sig);
    flipped[3] = flipped[3]! ^ 1;
    assert.equal(await connectVerifyChallenge(keys.publicKey, b64u(flipped), 'c1', 'n1', 'nd_a'), false);
    assert.equal(await connectVerifyChallenge(keys.publicKey, 'not base64!', 'c1', 'n1', 'nd_a'), false);
    assert.equal(await connectVerifyChallenge('short', sig, 'c1', 'n1', 'nd_a'), false);
    assert.equal(await connectVerifyChallenge(keys.publicKey, sig.slice(0, 40), 'c1', 'n1', 'nd_a'), false);
  });

  test('base64url and sha256 agree with Buffer and node:crypto', async () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33, 64]) {
      const bytes = randomBytes(n);
      assert.equal(connectB64u(bytes), b64u(bytes));
      assert.deepEqual(Buffer.from(connectFromB64u(b64u(bytes))!), bytes);
    }
    assert.equal(connectFromB64u('A'), null);
    assert.equal(connectFromB64u('AB'), null, 'non-canonical trailing bits are refused');
    assert.equal(connectFromB64u('a+b/'), null);
    const text = `token-${randomBytes(8).toString('hex')}`;
    assert.equal(await connectSha256Hex(text), sha256Hex(text));
    assert.equal(connectTimingSafeEqual('abc', 'abc'), true);
    assert.equal(connectTimingSafeEqual('abc', 'abd'), false);
    assert.equal(connectTimingSafeEqual('abc', 'abcd'), false);
  });
});
