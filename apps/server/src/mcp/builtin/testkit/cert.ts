import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A self-signed certificate (PEM text) for `localhost`, `127.0.0.1` and `::1`, made with openssl, for a stand-in that serves https:
 * Claude Code takes an `authServerMetadataUrl` only as https. The client has to trust it (`NODE_EXTRA_CA_CERTS=<cert file>`). Throws
 * when openssl is not installed.
 */
export function selfSignedCertificate(days = 2): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bp-cert-'));
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', String(days), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1'],
      { stdio: 'ignore' },
    );
    return { cert: readFileSync(join(dir, 'cert.pem'), 'utf8'), key: readFileSync(join(dir, 'key.pem'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
