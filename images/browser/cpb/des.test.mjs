// FIPS 46-3 / classic DES vectors, so the VNC handshake's DES can be trusted without OpenSSL's legacy provider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desBlock, vncObfuscate, vncResponse } from './des.mjs';

const hex = (h) => Buffer.from(h, 'hex');

test('DES matches the classic vectors, both ways', () => {
  const vectors = [
    ['133457799bbcdff1', '0123456789abcdef', '85e813540f0ab405'],
    ['0e329232ea6d0d73', '8787878787878787', '0000000000000000'],
    ['0101010101010101', '95f8a5e5dd31d900', '8000000000000000'],
    ['fedcba9876543210', '0123456789abcdef', 'ed39d950fa74bcc4'],
  ];
  for (const [key, plain, cipher] of vectors) {
    assert.equal(desBlock(hex(key), hex(plain)).toString('hex'), cipher);
    assert.equal(desBlock(hex(key), hex(cipher), true).toString('hex'), plain);
  }
});

test('VNC password handling: truncation to 8 characters and a stable obfuscation', () => {
  const challenge = hex('000102030405060708090a0b0c0d0e0f');
  assert.equal(vncResponse(challenge, 'abcdefghIGNORED').toString('hex'), vncResponse(challenge, 'abcdefgh').toString('hex'));
  assert.notEqual(vncResponse(challenge, 'abcdefg').toString('hex'), vncResponse(challenge, 'abcdefgh').toString('hex'));
  assert.equal(vncObfuscate('password').length, 8);
  // OpenSSL's DES (legacy provider) gives the same for the VNC fixed key e84ad660c4721ae0.
  assert.equal(vncObfuscate('password').toString('hex'), 'dbd83cfd727a1458');
});
