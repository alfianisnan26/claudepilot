// A throwaway certificate authority and one certificate for api.anthropic.com, made with the `openssl` command in a
// temporary directory. The CA is handed to the child process under test only (NODE_EXTRA_CA_CERTS in its environment);
// nothing is installed on the machine, and the files are deleted with the stand-in.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestPki {
  dir: string;
  caFile: string;
  key: Buffer;
  cert: Buffer;
  remove(): void;
}

/** Whether `openssl` is on the PATH (a test that needs a stand-in skips itself when it is not). */
export function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A CA and a leaf for `host`, valid for two days. */
export function makeTestPki(host = 'api.anthropic.com'): TestPki {
  const dir = mkdtempSync(join(tmpdir(), 'cp-standin-pki-'));
  const run = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=claudepilot-test-ca-not-trusted');
  run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', `/CN=${host}`);
  writeFileSync(join(dir, 'ext.cnf'), `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
  run('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'ext.cnf');
  return {
    dir,
    caFile: join(dir, 'ca.pem'),
    key: readFileSync(join(dir, 'leaf.key')),
    cert: readFileSync(join(dir, 'leaf.pem')),
    // Retries: a CLI that was just stopped may still be writing into the directory (ENOTEMPTY).
    remove: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}
