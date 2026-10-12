// PRD Q4 as a regression test: the agent serves each `docker` stream with a Node `http.Server` fed a non-socket duplex
// (`server.emit('connection', stream)`), and the portal's side is an `http.Agent` whose connection is a duplex. Node's HTTP stack was
// never promised to work on something that isn't a net.Socket, so this fails loudly if a later 22.x stops handling any of it: keep-alive
// on one connection, a chunked 3 MB POST, a 20 MB streamed response with backpressure, and an Upgrade answered with 101 and then raw
// bytes. If it ever breaks, the carrier becomes a unix-socket `net.Server` per agent (PRD §23.2, Q4).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';
import type { Duplex } from 'node:stream';
import { streamPair } from '../../testkit/streams.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function carrierServer() {
  const stats = { drains: 0 };
  const server = http.createServer(async (req, res) => {
    if (req.url === '/hash') {
      const h = createHash('sha256');
      let n = 0;
      for await (const c of req) {
        h.update(c as Buffer);
        n += (c as Buffer).length;
      }
      res.end(JSON.stringify({ n, sha: h.digest('hex') }));
    } else if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 7);
      let sent = 0;
      const pump = () => {
        while (sent < 20 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            stats.drains++;
            return void res.once('drain', pump);
          }
        }
        res.end();
      };
      pump();
    } else res.end(`hello ${req.url}`);
  });
  server.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    socket.on('data', (d: Buffer) => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
  });
  return { server, stats };
}

test('Q4: an http.Server over a duplex carries keep-alive, a chunked 3 MB POST, a 20 MB streamed response and an Upgrade', async () => {
  const { server, stats } = carrierServer();
  const [clientSide, serverSide] = streamPair();
  server.emit('connection', serverSide);

  let created = 0;
  class OneConnection extends http.Agent {
    override createConnection(_options: http.ClientRequestArgs, cb?: (err: Error | null, stream: Duplex) => void) {
      created++;
      if (created > 1) {
        cb?.(new Error('a second connection was requested: keep-alive failed'), undefined as never);
        return undefined;
      }
      return clientSide;
    }
  }
  const agent = new OneConnection({ keepAlive: true, maxSockets: 1 });
  const get = (path: string) =>
    new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const req = http.request({ host: 'x.invalid', port: 80, path, agent }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }));
      });
      req.on('error', reject);
      req.end();
    });

  const [r1, r2] = [await get('/a'), await get('/b')];
  assert.equal(`${r1.body}|${r2.body}`, 'hello /a|hello /b');
  assert.equal(created, 1, 'two requests used one connection');

  const body = Buffer.alloc(3 * 1024 * 1024, 5);
  const posted = await new Promise<string>((resolve, reject) => {
    const req = http.request({ host: 'x.invalid', port: 80, path: '/hash', method: 'POST', agent, headers: { 'transfer-encoding': 'chunked' } }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => resolve(Buffer.concat(parts).toString()));
    });
    req.on('error', reject);
    for (let i = 0; i < body.length; i += 100_000) req.write(body.subarray(i, i + 100_000));
    req.end();
  });
  assert.deepEqual(JSON.parse(posted), { n: body.length, sha: sha(body) });

  const big = await get('/big');
  assert.equal(big.body.length, 20 * 1024 * 1024);
  assert.ok(stats.drains > 0, 'the server was held back by the slow side at least once (backpressure works)');

  // An upgraded connection is not reusable, so it gets its own pair.
  const [c2, s2] = streamPair();
  server.emit('connection', s2);
  const up = await new Promise<string>((resolve, reject) => {
    const req = http.request({ host: 'x.invalid', port: 80, path: '/exec', method: 'POST', headers: { Connection: 'Upgrade', Upgrade: 'tcp' }, createConnection: () => c2 });
    req.on('upgrade', (res, socket) => {
      socket.write('ping');
      socket.once('data', (d: Buffer) => resolve(`${res.statusCode} ${d}`));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(up, '101 echo:ping');
  agent.destroy();
  clientSide.destroy();
  c2.destroy();
  server.close();
});
