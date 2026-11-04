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
  connectPublicKeyProblem,
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
  publicKeyProblem,
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

// PILOT-1172: the Worker's registry uses the contract's key check; the portal (and the agent bundle, which may carry only connect.ts) keeps
// its own in auth.ts. They must refuse exactly the same keys, with the same words.
describe('connectPublicKeyProblem (contract) against publicKeyProblem (auth.ts)', () => {
  const same = (key: unknown) => assert.equal(connectPublicKeyProblem(key), publicKeyProblem(key), JSON.stringify(key));

  test('the same answer for wrong shapes, real keys and random 32-byte strings (about half off the curve)', () => {
    for (const bad of [undefined, null, 42, '', 'abc', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}!`, b64u(randomBytes(31)), b64u(randomBytes(33))]) same(bad);
    for (let i = 0; i < 50; i++) {
      const k = generateNodeKeyPair().publicKey;
      assert.equal(connectPublicKeyProblem(k), null);
      same(k);
    }
    let off = 0;
    for (let i = 0; i < 400; i++) {
      const k = b64u(randomBytes(32));
      same(k);
      if (connectPublicKeyProblem(k) === 'That is not an Ed25519 public key.') off++;
    }
    assert.ok(off > 120 && off < 280, `${off} of 400 random strings were off the curve`);
  });

  test('the same refusal for every small-order point (libsodium list, both sign bits) and for y = p', () => {
    const hexes = [
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0100000000000000000000000000000000000000000000000000000000000000',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      '0000000000000000000000000000000000000000000000000000000000000080',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    ];
    for (const h of hexes) {
      const k = b64u(Buffer.from(h, 'hex'));
      assert.notEqual(connectPublicKeyProblem(k), null, h);
      same(k);
    }
    assert.match(connectPublicKeyProblem(b64u(Buffer.from(hexes[0]!, 'hex'))) ?? '', /small order/);
  });

  test('a non-canonical spelling of a real key is refused by both', () => {
    // The 43rd character carries 4 bits; flipping the low (unused) bits gives another spelling of the same bytes.
    const k = generateNodeKeyPair().publicKey;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(k[42]!);
    const respelled = k.slice(0, 42) + alphabet[last ^ 1]!;
    assert.deepEqual(fromB64u(respelled), fromB64u(k));
    same(respelled);
    assert.notEqual(connectPublicKeyProblem(respelled), null);
  });
});
