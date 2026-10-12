// Test fixture: a throwaway self-signed certificate and its key for pilot.example.test, localhost and 127.0.0.1, made at import time with Node's
// crypto (no openssl, and no key or certificate text in the repository). The agent's TLS and proxy tests trust it by passing it as the CA; nothing
// else does. The certificate is an ECDSA P-256 X.509 v3, built by hand in DER (Node can parse certificates, not make them).
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const length = (n: number): Buffer => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const set = (...p: Buffer[]) => tlv(0x31, ...p);
const oid = (...bytes: number[]) => tlv(0x06, Buffer.from(bytes));
const integer = (b: Buffer) => tlv(0x02, b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const octets = (b: Buffer) => tlv(0x04, b);
const bits = (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const utcTime = (d: Date) => tlv(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`));

const ECDSA_WITH_SHA256 = oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02);
const COMMON_NAME = oid(0x55, 0x04, 0x03);

/** DER to PEM (Node 22.13's X509Certificate reads PEM only; later versions read DER too). The label is a parameter, so no PEM header is spelled out here. */
const pem = (label: string, der: Buffer): string => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;

export interface TestTls {
  host: string;
  key: string;
  cert: string;
}

function makeTestTls(host = 'pilot.example.test'): TestTls {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const name = seq(set(seq(COMMON_NAME, tlv(0x0c, Buffer.from(host)))));
  const now = new Date();
  const validity = seq(utcTime(new Date(now.getTime() - 86_400_000)), utcTime(new Date(now.getTime() + 10 * 365 * 86_400_000)));
  const serial = randomBytes(8);
  serial[0]! &= 0x7f;
  const extensions = tlv(
    0xa3,
    seq(
      seq(oid(0x55, 0x1d, 0x13), tlv(0x01, Buffer.from([0xff])), octets(seq(tlv(0x01, Buffer.from([0xff]))))), // basicConstraints: CA, critical
      seq(oid(0x55, 0x1d, 0x11), octets(seq(tlv(0x82, Buffer.from(host)), tlv(0x82, Buffer.from('localhost')), tlv(0x87, Buffer.from([127, 0, 0, 1]))))), // subjectAltName
    ),
  );
  const tbs = seq(tlv(0xa0, integer(Buffer.from([2]))), integer(serial), seq(ECDSA_WITH_SHA256), name, validity, name, publicKey.export({ type: 'spki', format: 'der' }), extensions);
  const der = seq(tbs, seq(ECDSA_WITH_SHA256), bits(sign('sha256', tbs, privateKey)));
  return { host, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, cert: pem('CERTIFICATE', der) };
}

export const TEST_TLS: TestTls = makeTestTls();
