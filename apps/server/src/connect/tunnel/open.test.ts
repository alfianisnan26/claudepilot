// T-MUX / T-AGENT: the stream open handshake (docs/prd/targets-connect.md §9.4) over a memory pair.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CONNECT_LIMITS, type ConnectOpenRequest } from '@portal/contracts';
import { ConnectError } from '../seams.js';
import { readLine, writeLine } from './lines.js';
import { memoryPair } from './memory.js';
import { MuxSession, type MuxStream } from './mux.js';
import { acceptService, openService } from './open.js';

function pair(onStream: (s: MuxStream) => void, limits: Partial<ConstructorParameters<typeof MuxSession>[0]['limits'] & object> = {}) {
  const [a, b] = memoryPair();
  const client = new MuxSession({ role: 'client', socket: a, limits });
  const server = new MuxSession({ role: 'server', socket: b, onStream, limits });
  return { client, server, close: () => (client.destroy(), server.destroy()) };
}

const codeOf = (e: unknown) => (e instanceof ConnectError ? e.code : `not a ConnectError: ${String(e)}`);

describe('open handshake', () => {
  test('an accepted request returns the stream, with what the acceptor sent behind its answer', async () => {
    const seen: ConnectOpenRequest[] = [];
    const p = pair(async (s) => {
      const req = await acceptService(s, (r) => (seen.push(r), { ok: true }));
      if (req) s.write('raw bytes right behind the answer');
    });
    try {
      const stream = await openService(p.client, { service: 'docker', trace: 'a1b2c3d4' });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(stream.read().toString(), 'raw bytes right behind the answer');
      assert.deepEqual(seen, [{ v: 1, service: 'docker', trace: 'a1b2c3d4' }]);
      stream.destroy();
    } finally {
      p.close();
    }
  });

  test('host arguments travel with the request', async () => {
    let got: ConnectOpenRequest | null = null;
    const p = pair(async (s) => void (await acceptService(s, (r) => ((got = r), { ok: true }))));
    try {
      const stream = await openService(p.client, { service: 'host', args: { op: 'read', path: '/etc/hostname', maxBytes: 10 } });
      assert.deepEqual((got as ConnectOpenRequest | null)?.args, { op: 'read', path: '/etc/hostname', maxBytes: 10 });
      stream.destroy();
    } finally {
      p.close();
    }
  });

  test('a refusal carries its typed code and message, and the opener gets a ConnectError', async () => {
    const p = pair((s) => void acceptService(s, () => ({ ok: false, code: 'busy', message: '64 docker streams are open' })));
    try {
      await assert.rejects(openService(p.client, { service: 'docker' }), (e) => codeOf(e) === 'busy' && /64 docker streams/.test((e as Error).message));
    } finally {
      p.close();
    }
  });

  test('every typed code round-trips; an unknown code becomes internal', async () => {
    for (const code of ['bad_open', 'service_unavailable', 'denied', 'upstream_unreachable', 'timeout', 'internal'] as const) {
      const p = pair((s) => void acceptService(s, () => ({ ok: false, code, message: code })));
      try {
        await assert.rejects(openService(p.client, { service: 'kube' }), (e) => codeOf(e) === code);
      } finally {
        p.close();
      }
    }
    const p = pair(async (s) => {
      await readLine(s, 1000);
      await writeLine(s, { v: 1, ok: false, code: 'made_up', message: 'x' });
    });
    try {
      await assert.rejects(openService(p.client, { service: 'kube' }), (e) => codeOf(e) === 'internal');
    } finally {
      p.close();
    }
  });

  test('the acceptor refuses a request that is not understood with bad_open', async () => {
    for (const line of ['not json', '{"v":2,"service":"docker"}', '{"v":1,"service":"tcp"}', '{"v":1}', '{"v":1,"service":"host","args":[1]}']) {
      let answer = '';
      const p = pair((s) => void acceptService(s, () => ({ ok: true })));
      try {
        const s = p.client.open();
        s.on('error', () => undefined);
        s.write(`${line}\n`);
        answer = (await readLine(s, 1000)) ?? '';
        assert.match(answer, /"code":"bad_open"/, line);
        s.destroy();
      } finally {
        p.close();
      }
    }
  });

  test('a request line over 16 KiB is refused', async () => {
    const p = pair((s) => void acceptService(s, () => ({ ok: true })));
    try {
      const s = p.client.open();
      s.on('error', () => undefined);
      s.write(`${'x'.repeat(CONNECT_LIMITS.maxOpenLine + 10)}\n`);
      assert.match((await readLine(s, 1000)) ?? '', /"code":"bad_open"/);
      s.destroy();
    } finally {
      p.close();
    }
  });

  test('an acceptor that never answers times out; a decide that throws is internal', async () => {
    const quiet = pair((s) => s.on('error', () => undefined));
    try {
      await assert.rejects(openService(quiet.client, { service: 'docker' }, { timeoutMs: 60 }), (e) => codeOf(e) === 'timeout');
    } finally {
      quiet.close();
    }
    const boom = pair((s) => void acceptService(s, () => { throw new Error('exploded'); }));
    try {
      await assert.rejects(openService(boom.client, { service: 'docker' }), (e) => codeOf(e) === 'internal' && /exploded/.test((e as Error).message));
    } finally {
      boom.close();
    }
  });

  test('the tunnel going away while waiting is agent_offline; opening on a closed or leaving session is too', async () => {
    const p = pair((s) => s.on('error', () => undefined));
    const pending = openService(p.client, { service: 'docker' }, { timeoutMs: 5_000 });
    setTimeout(() => p.server.destroy(), 30);
    await assert.rejects(pending, (e) => codeOf(e) === 'agent_offline');
    await assert.rejects(openService(p.client, { service: 'docker' }), (e) => codeOf(e) === 'agent_offline');
    p.close();
  });

  test('at the stream cap the opener gets busy', async () => {
    const p = pair((s) => void acceptService(s, () => ({ ok: true })), { maxStreams: 2 });
    try {
      const a = await openService(p.client, { service: 'docker' });
      const b = await openService(p.client, { service: 'docker' });
      await assert.rejects(openService(p.client, { service: 'docker' }), (e) => codeOf(e) === 'busy');
      a.destroy();
      b.destroy();
    } finally {
      p.close();
    }
  });

  test('an abort signal ends the wait', async () => {
    const p = pair((s) => s.on('error', () => undefined));
    const ac = new AbortController();
    const pending = openService(p.client, { service: 'docker' }, { signal: ac.signal, timeoutMs: 5_000 });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(pending);
    p.close();
  });
});
