// The bootstrap fetcher (PRD §13.4), run the way the installers run it (`node -e`), against a local server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { FETCHER, FETCHER_FORBIDDEN } from './fetcher.js';
import { integrity, sha256 } from './testkit.js';

const BODY = Buffer.from('export const agent = 1;\n');
let base = '';
let seen: IncomingHttpHeaders[] = [];
const server = createServer((req, res) => {
  seen.push(req.headers);
  if (req.url === '/agent.mjs') res.end(BODY);
  else res.writeHead(404).end('no');
});
const dir = mkdtempSync(join(tmpdir(), 'cx4-fetch-'));
before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Async: the server answering it lives in this process. */
const fetchTo = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(process.execPath, ['-e', FETCHER, ...args], { env: { PATH: process.env.PATH, HOME: dir, ...env } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });

test('the text survives sh, PowerShell, YAML and env files', () => {
  assert.doesNotMatch(FETCHER, FETCHER_FORBIDDEN);
  assert.ok(!FETCHER.includes('\n'));
  assert.ok(FETCHER.length < 1500);
});

test('downloads, checks the sha256, writes; keeps a good file without the network', async () => {
  const out = join(dir, 'a', 'agent.mjs');
  const r = await fetchTo([`${base}/agent.mjs`, sha256(BODY), out]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(out), BODY);
  assert.ok(!existsSync(`${out}.tmp`));
  const again = await fetchTo(['http://127.0.0.1:1/nothing', sha256(BODY), out]);
  assert.equal(again.status, 0, 'a file with the right checksum is kept');
});

test('an npm integrity (sha512) is checked the same way', async () => {
  const out = join(dir, 'b.tgz');
  assert.equal((await fetchTo([`${base}/agent.mjs`, integrity(BODY), out])).status, 0);
  assert.ok(existsSync(out));
});

test('a wrong checksum, a 404, an unreachable host and bad arguments exit 13 and write nothing', async () => {
  const out = join(dir, 'c.mjs');
  const bad = await fetchTo([`${base}/agent.mjs`, '0'.repeat(64), out]);
  assert.equal(bad.status, 13);
  assert.match(bad.stderr, /checksum mismatch for \/agent\.mjs/);
  assert.equal((await fetchTo([`${base}/missing`, sha256(BODY), out])).status, 13);
  const down = await fetchTo(['http://127.0.0.1:1/agent.mjs?x=secret', sha256(BODY), out]);
  assert.equal(down.status, 13);
  assert.doesNotMatch(down.stderr, /secret/, 'never the query');
  assert.equal((await fetchTo([`${base}/agent.mjs`, 'nothex', out])).status, 13);
  assert.equal((await fetchTo([])).status, 13);
  assert.ok(!existsSync(out) && !existsSync(`${out}.tmp`));
});

test('extra headers come from PILOT_HEADERS_FILE and are never printed', async () => {
  const hf = join(dir, 'headers');
  writeFileSync(hf, 'CF-Access-Client-Id: canary-id\r\nCF-Access-Client-Secret: canary-secret\n');
  seen = [];
  const r = await fetchTo([`${base}/missing`, sha256(BODY), join(dir, 'd')], { PILOT_HEADERS_FILE: hf });
  assert.equal(r.status, 13);
  assert.equal(seen[0]!['cf-access-client-secret'], 'canary-secret');
  assert.doesNotMatch(r.stdout + r.stderr, /canary/);
});

test('a PILOT_HEADERS_FILE that is not there means no extra headers (the Kubernetes manifest names one whose Secret is optional)', async () => {
  // Seen on a real cluster (T6): every Kubernetes install without PILOT_HEADERS crashed in the fetch init container with ENOENT.
  const out = join(dir, 'e.mjs');
  seen = [];
  const r = await fetchTo([`${base}/agent.mjs`, sha256(BODY), out], { PILOT_HEADERS_FILE: join(dir, 'no-such-dir', 'headers') });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(out), BODY);
  assert.equal(seen[0]!['cf-access-client-secret'], undefined);
});
