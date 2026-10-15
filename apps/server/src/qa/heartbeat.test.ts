import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../../../scripts/heartbeat.mjs', import.meta.url));

type Issue = { number: number; state: string; labels: string[]; comments: string[] };

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function rig() {
  const state = { healthy: false, failFirst: 0, issues: [] as Issue[], writes: 0 };
  const health = await listen((_req, res) => {
    const fail = state.failFirst > 0;
    if (fail) state.failFirst--;
    res.statusCode = state.healthy && !fail ? 200 : 503;
    res.end('{}');
  });
  const api = await listen((req, res) => {
    if (!req.headers.authorization?.startsWith('Bearer ')) { res.statusCode = 401; res.end(); return; }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = req.url ?? '';
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && path.startsWith('/repos/o/r/issues?')) {
        res.end(JSON.stringify(state.issues.filter((i) => i.state === 'open').map((i) => ({ number: i.number }))));
      } else if (req.method === 'POST' && path === '/repos/o/r/issues') {
        state.writes++;
        const n = state.issues.length + 1;
        state.issues.push({ number: n, state: 'open', labels: JSON.parse(body).labels, comments: [] });
        res.end(JSON.stringify({ number: n }));
      } else if (req.method === 'POST' && /\/issues\/\d+\/comments$/.test(path)) {
        state.writes++;
        state.issues[Number(path.split('/')[5]) - 1]!.comments.push(JSON.parse(body).body);
        res.end('{}');
      } else if (req.method === 'PATCH' && /\/issues\/\d+$/.test(path)) {
        state.writes++;
        state.issues[Number(path.split('/')[5]) - 1]!.state = JSON.parse(body).state;
        res.end('{}');
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  const run = (extra: string[] = []) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [SCRIPT, '--url', `${health.url}/healthz`, '--retry-delay-ms', '10', ...extra],
        { env: { PATH: process.env.PATH ?? '', GITHUB_TOKEN: `t${Date.now()}`, GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: api.url } },
        (err, stdout, stderr) => (err ? reject(new Error(stderr || String(err))) : resolve(stdout)),
      );
    });
  const stop = () => { health.server.close(); api.server.close(); };
  return { state, run, stop };
}

test('one miss then an answer opens nothing', async () => {
  const r = await rig();
  try {
    r.state.healthy = true;
    r.state.failFirst = 1; // 503 once, then healthy on the retry
    assert.match(await r.run(), /result: miss/);
    assert.equal(r.state.issues.length, 0);
    assert.equal(r.state.writes, 0);
  } finally { r.stop(); }
});

test('two misses open exactly one issue, a third opens no second, recovery closes it', async () => {
  const r = await rig();
  try {
    assert.match(await r.run(), /result: down-opened/);
    assert.equal(r.state.issues.length, 1);
    assert.deepEqual(r.state.issues[0]!.labels, ['portal-down']);
    assert.match(await r.run(), /result: down-already-open/);
    assert.equal(r.state.issues.length, 1);
    r.state.healthy = true;
    assert.match(await r.run(), /result: up-closed/);
    assert.equal(r.state.issues[0]!.state, 'closed');
    assert.equal(r.state.issues[0]!.comments.length, 1);
    assert.match(await r.run(), /result: up\b/);
  } finally { r.stop(); }
});

test('dry run reads but writes nothing', async () => {
  const r = await rig();
  try {
    assert.match(await r.run(['--dry-run']), /result: down-opened/);
    assert.equal(r.state.writes, 0);
  } finally { r.stop(); }
});
