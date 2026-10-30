// scripts/cf-logs.sh (owner, 2026-10-19: agents read Cloudflare Workers Observability for stg): the guards run before any network
// call, so these tests need no token and no Cloudflare. A fake API on localhost checks the request and the redaction.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/cf-logs.sh');
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });

test('cf-logs refuses a Worker that is not stg, a bad --since and a missing token, before any request', () => {
  for (const name of ['konfersi-backend-uat', 'konfersi-backend', 'konfersi-backend-prod', 'x;rm -rf /-stg']) {
    const r = run(['--script', name]);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /only stg Workers/, name);
  }
  assert.match(run(['--since', '30x']).stderr, /--since is like/);
  assert.match(run(['--since', '8d']).stderr, /at most 7d/);
  assert.match(run([], { CF_OBS_TOKEN_FILE: '/nonexistent/token' }).stderr, /no token file/);
});

test('cf-logs asks for -stg Workers only, prints only -stg events and redacts credential-shaped text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cflogs-'));
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, ['fake', Math.random().toString(36).slice(2)].join('-'));
  let seen: { auth?: string; body?: { parameters: { filters: { key: string; operation: string; value: string }[] } } } = {};
  const jwtLike = ['eyJ' + 'a'.repeat(12), 'b'.repeat(12), 'c'.repeat(8)].join('.');
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen = { auth: req.headers.authorization, body: JSON.parse(b) };
      res.end(JSON.stringify({ success: true, result: { events: { events: [
        { timestamp: 1_760_000_000_000, $workers: { scriptName: 'konfersi-backend-stg', outcome: 'ok' }, $metadata: { level: 'error', message: `login failed ${jwtLike} token=abc123` } },
        { timestamp: 1_760_000_000_000, $workers: { scriptName: 'konfersi-backend-uat' }, $metadata: { level: 'error', message: 'uat event' } },
      ] } } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const r = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
      const p = spawn('bash', [SCRIPT, '--level', 'error'], {
        env: { PATH: process.env.PATH ?? '', CF_OBS_TOKEN_FILE: tokenFile, CF_API_BASE: `http://127.0.0.1:${port}` },
      });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (c) => (stdout += c));
      p.stderr.on('data', (c) => (stderr += c));
      p.on('close', () => resolve({ stdout, stderr }));
    });
    assert.match(r.stdout, /konfersi-backend-stg error ok/);
    assert.doesNotMatch(r.stdout, /uat event/, 'a non-stg event is never printed');
    assert.doesNotMatch(r.stdout, /eyJa/, 'a JWT-shaped value is redacted');
    assert.doesNotMatch(r.stdout, /abc123/, 'token=… is redacted');
    assert.match(r.stdout, /\[redacted\]/);
    const f = seen.body?.parameters.filters ?? [];
    assert.deepEqual(f[0], { key: '$workers.scriptName', operation: 'includes', type: 'string', value: '-stg' });
    assert.ok(f.some((x) => x.key === '$metadata.level' && x.value === 'error'));
    assert.match(seen.auth ?? '', /^Bearer fake-/);
  } finally {
    server.close();
  }
});
