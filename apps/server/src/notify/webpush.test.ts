// Web Push crypto with node:crypto only: the RFC 8291 Appendix A known-answer test (every intermediate value), a decrypt round trip with a
// receiver written here, the 4,096-byte bound, the VAPID JWT (RFC 8292) and the Topic header (RFC 8030).
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { test } from 'node:test';
import { payloadBytes, pushCode, pushPayload, sendPush } from './push.js';
import { fakeBrowser, standIn, testEgress } from './testkit.js';
import { decrypt, encrypt, PUSH_BODY_MAX, PUSH_PLAINTEXT_MAX, rawPublicKey, topicOf, validP256, vapidAuthorization } from './webpush.js';

const u = (s: string) => Buffer.from(s, 'base64url');
const b = (x: Buffer) => x.toString('base64url');

test('RFC 8291 Appendix A: every intermediate value and the message match the RFC', () => {
  const r = encrypt(
    {
      plaintext: u('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
      uaPublic: u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
      authSecret: u('BTBZMqHH6r4Tts7J_aSIgg'),
      asPrivate: u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      salt: u('DGv6ra1nlYgDCS1FRnbzlw'),
    },
    randomBytes,
  );
  assert.equal(b(r.debug.ecdhSecret), 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs');
  assert.equal(b(r.debug.prkKey), 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k');
  assert.equal(b(r.debug.ikm), 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg');
  assert.equal(b(r.debug.prk), '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc');
  assert.equal(b(r.debug.cek), 'oIhVW04MRdy2XN9CiKLxTg');
  assert.equal(b(r.debug.nonce), '4h_95klXJ5E_qnoN');
  assert.equal(b(r.debug.header), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  assert.equal(b(r.debug.ciphertext), '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ');
  assert.equal(r.debug.header.length, 86);
  // and the RFC's receiver key decrypts it
  assert.equal(decrypt(r.body, u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'), u('BTBZMqHH6r4Tts7J_aSIgg')).toString(), 'When I grow up, I want to be a watermelon');
});

test('round trip: a receiver written here decrypts what the sender encrypts; the size bound is exact', () => {
  const browser = fakeBrowser('https://push.example.test/x');
  const p256dh = u(browser.subscription.keys.p256dh);
  const auth = u(browser.subscription.keys.auth);
  const msg = pushPayload({ eventId: 'evt_0123456789abcdef', kind: 'test', title: 'Test', body: 'Notifications work', path: '/admin/notifications', tag: 'test:1', renotify: false }, 'https://pilot.example.test');
  const body = encrypt({ plaintext: Buffer.from(JSON.stringify(msg)), uaPublic: p256dh, authSecret: auth }, randomBytes).body;
  assert.deepEqual(browser.open(body), msg);
  // 4096 - 86 (header) - 16 (tag) - 1 (delimiter) = 3993 bytes of plaintext fit; one more does not
  assert.equal(PUSH_PLAINTEXT_MAX, 3993);
  const max = encrypt({ plaintext: Buffer.alloc(3993, 0x61), uaPublic: p256dh, authSecret: auth }, randomBytes).body;
  assert.equal(max.length, PUSH_BODY_MAX);
  assert.throws(() => encrypt({ plaintext: Buffer.alloc(3994, 0x61), uaPublic: p256dh, authSecret: auth }, randomBytes), /too large/);
  // a body that would not fit is cut to its first line, then refused
  const big = { eventId: 'evt_0', kind: 'test' as const, title: 'T', body: `a\n${'x'.repeat(5000)}`, path: '/admin/notifications', tag: 't', renotify: false };
  assert.ok(payloadBytes(big, 'https://p.test')!.length < 500);
  assert.ok(payloadBytes({ ...big, body: 'y'.repeat(5000) }, 'https://p.test')!.length < 500, 'a long single line is cut to 120');
  assert.equal(payloadBytes({ ...big, title: 'y'.repeat(5000) }, 'https://p.test'), null);
  // p256dh must be a point on the curve
  assert.equal(validP256(p256dh), true);
  assert.equal(validP256(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)])), false);
  assert.equal(validP256(p256dh.subarray(1)), false);
});

test('VAPID: ES256, aud is the push service origin, exp 12 h ahead, sub, k is the raw public key; it verifies', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = rawPublicKey(privateKey);
  assert.equal(pub.length, 65);
  assert.equal(pub[0], 4);
  const { header, claims } = vapidAuthorization({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc?x=1', privateKey, publicKey: pub, subject: 'mailto:ops@example.test', nowS: 1_791_800_000 });
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: 1_791_800_000 + 43_200, sub: 'mailto:ops@example.test' });
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
  assert.ok(m);
  assert.deepEqual(JSON.parse(u(m[1]!).toString()), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(u(m[2]!).toString()), claims);
  assert.equal(u(m[3]!).length, 64);
  assert.equal(m[4], b(pub));
  assert.ok(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, u(m[3]!)));
  // never more than 24 hours, whatever is asked
  assert.equal(vapidAuthorization({ endpoint: 'https://a.test/x', privateKey, publicKey: pub, subject: null, nowS: 0, ttlS: 99 * 3600 }).claims.exp, 86_400);
});

test('Topic: at most 32 URL-safe Base64 characters, stable per tag, and the tag is not readable from it', () => {
  const key = randomBytes(32);
  const t = topicOf(key, 'approval:s_41:r_7');
  assert.match(t, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(topicOf(key, 'approval:s_41:r_7'), t);
  assert.notEqual(topicOf(key, 'approval:s_41:r_8'), t);
  assert.ok(!t.includes('s_41'));
});

test('push codes: 404 and 410 end a subscription, 401/403 VAPID, 400 bad subscription, 413, 429, 5xx', () => {
  assert.equal(pushCode(201), null);
  assert.equal(pushCode(404), 'gone');
  assert.equal(pushCode(410), 'gone');
  assert.equal(pushCode(401), 'vapid_rejected');
  assert.equal(pushCode(403), 'vapid_rejected');
  assert.equal(pushCode(400), 'bad_subscription');
  assert.equal(pushCode(413), 'payload_too_large');
  assert.equal(pushCode(429), 'rate_limited');
  assert.equal(pushCode(503), 'http_5xx');
  assert.equal(pushCode(302), 'redirect');
});

test('sendPush: the stand-in push service gets RFC 8030 headers and a body only the browser can read', async () => {
  const svc = await standIn(() => ({ status: 201 }));
  try {
    const browser = fakeBrowser(`http://push.example.test:${svc.port}/send/abc`);
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const keys = { privateKey, publicKey: rawPublicKey(privateKey), topicKey: randomBytes(32) };
    const res = await sendPush({
      egress: testEgress(),
      keys,
      subscription: { endpoint: browser.subscription.endpoint, p256dh: browser.subscription.keys.p256dh, auth: browser.subscription.keys.auth },
      message: { eventId: 'evt_1', kind: 'approval', title: 'Approval needed', body: 'api-dev · run a command', path: '/admin/sessions/s_41?request=r_7', tag: 'approval:s_41:r_7', renotify: true, act: { t: 'cpna_x', d: ['deny'], exp: 1 } },
      origin: 'https://pilot.example.test',
      contact: 'mailto:ops@example.test',
      nowS: Math.floor(Date.now() / 1000),
    });
    assert.deepEqual(res, { ok: true, status: 201, error: null, retryAfterS: null });
    const got = svc.got[0]!;
    assert.equal(got.headers.ttl, '3600');
    assert.equal(got.headers.urgency, 'high');
    assert.match(String(got.headers.topic), /^[A-Za-z0-9_-]{32}$/);
    assert.equal(got.headers['content-encoding'], 'aes128gcm');
    assert.match(String(got.headers.authorization), /^vapid t=[^ ]+, k=[A-Za-z0-9_-]{87}$/);
    assert.ok(got.body.length <= PUSH_BODY_MAX);
    assert.ok(!got.body.includes(Buffer.from('cpna_')), 'the token is not readable on the wire');
    const p = browser.open(got.body);
    assert.equal(p.web_push, 8030);
    assert.equal(p.notification.navigate, 'https://pilot.example.test/admin/sessions/s_41?request=r_7');
    assert.deepEqual(p.notification.actions, [{ action: 'review', title: 'Review', navigate: 'https://pilot.example.test/admin/sessions/s_41?request=r_7' }]);
    assert.deepEqual(p.notification.data.act, { t: 'cpna_x', d: ['deny'], exp: 1 });
  } finally {
    await svc.close();
  }
});
