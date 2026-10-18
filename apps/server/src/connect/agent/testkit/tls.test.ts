// T-1600: gate #459 went red when the fixture's random serial began with a zero byte (ERR_OSSL_ASN1_ILLEGAL_PADDING).
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { test } from 'node:test';
import { certSerial, TEST_TLS } from './tls.js';

test('the serial is positive minimal DER for every first byte, including 0x00 and 0x80', () => {
  for (let b = 0; b < 256; b++) {
    const s = certSerial(Buffer.from([b, 0x05, 1, 2, 3, 4, 5, 6]));
    assert.notEqual(s[0], 0, `first byte ${b} leads with 0x00`);
    assert.ok(s[0]! < 0x80, `first byte ${b} reads as negative`);
  }
});

test('the fixture certificate parses', () => {
  assert.match(new X509Certificate(TEST_TLS.cert).subject, /pilot\.example\.test/);
});
