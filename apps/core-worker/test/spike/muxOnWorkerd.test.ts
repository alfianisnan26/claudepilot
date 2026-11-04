// PILOT-1159 (G6 spike): can the portal's half of Connect run inside a Durable Object on workerd, with no node:net loopback?
//
// Inside BridgeDO (runInDurableObject), unchanged server code (apps/server/src/connect/tunnel: mux.ts, stream.ts, open.ts, lines.ts,
// frame.ts) runs a MuxSession on each end of a Cloudflare WebSocketPair. The portal end opens a `kube` stream with `openService` and writes
// HTTP/1.1 straight onto it (no @kubernetes/client-node, no loopback listener); the agent end stands in for the agent's kube proxy
// (apps/server/src/connect/agent/services/kube/proxy.ts): it accepts the stream with `acceptService`, checks the per-connection bearer and
// answers like the API server. Exec rides the same stream: a 101 to v5.channel.k8s.io, then RFC 6455 frames with a channel byte.
// What the spike found is in docs/prd/cf-bridge.md (G6).

import { CONNECT_LIMITS } from '@portal/contracts';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { MuxStream } from '../../../server/src/connect/tunnel/mux.js';
import { MuxSession } from '../../../server/src/connect/tunnel/mux.js';
import { acceptService, openService } from '../../../server/src/connect/tunnel/open.js';
import { locate } from '../../src/locate.js';
import {
  ByteReader,
  cfMuxSocket,
  readHead,
  readResponse,
  readWsFrame,
  wsAccept,
  wsFrame,
  writeRequest,
  type CfMuxSocket,
} from './wire.js';

const NS = 'ns-spike';
const PODS = `/api/v1/namespaces/${NS}/pods`;
const BIG = 2 * 1024 * 1024;

interface Rig {
  portal: MuxSession;
  agent: MuxSession;
  agentSocket: CfMuxSocket;
  /** The per-connection bearer the portal sends in `config` (hub.ts), made at run time. */
  bearer: string;
  close(): void;
}

function rig(): Rig {
  const pair = new WebSocketPair();
  const [portalWs, agentWs] = [pair[0], pair[1]];
  portalWs.accept();
  agentWs.accept();
  const bearer = crypto.randomUUID();
  const agentSocket = cfMuxSocket(agentWs);
  const agent = new MuxSession({ role: 'client', socket: agentSocket, onStream: (s) => void fakeKubeService(s, bearer) });
  const portal = new MuxSession({ role: 'server', socket: cfMuxSocket(portalWs) });
  return {
    portal,
    agent,
    agentSocket,
    bearer,
    close() {
      portal.close(1000, 'test over');
      agent.destroy();
    },
  };
}

/** The agent's end: what the kube proxy does for one stream, reduced to what the spike needs to show. */
async function fakeKubeService(stream: MuxStream, bearer: string): Promise<void> {
  const req = await acceptService(stream, (r) =>
    r.service === 'kube' ? { ok: true } : { ok: false, code: 'service_unavailable', message: 'Only kube here.' },
  );
  if (!req) return;
  const r = new ByteReader(stream);
  const send = (status: string, headers: Record<string, string>, body = '') => {
    const lines = [`HTTP/1.1 ${status}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    stream.write(Buffer.from(`${lines.join('\r\n')}\r\n\r\n${body}`, 'latin1'));
  };
  const json = (status: string, value: unknown) => {
    const body = JSON.stringify(value);
    send(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }, body);
  };
  for (;;) {
    let head: string;
    try {
      head = (await r.until('\r\n\r\n')).toString('latin1');
    } catch {
      return stream.end();
    }
    const [line = '', ...rest] = head.split('\r\n');
    const [method, path = ''] = line.split(' ');
    const h = new Map(rest.map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
    // 1. the proxy's first wall: the per-connection bearer, then the header is dropped
    if (h.get('authorization') !== `Bearer ${bearer}`) {
      json('401 Unauthorized', { kind: 'Status', status: 'Failure', code: 401 });
      continue;
    }
    // 2. the allowlist: this namespace only
    if (method === 'GET' && path.split('?')[0] === PODS) {
      // lists come back chunked from the API server
      const body = JSON.stringify({
        kind: 'PodList',
        apiVersion: 'v1',
        items: ['ws-a', 'ws-b'].map((name) => ({ metadata: { name, namespace: NS }, status: { phase: 'Running' } })),
      });
      const half = Math.floor(body.length / 2);
      send('200 OK', { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
      for (const part of [body.slice(0, half), body.slice(half)]) stream.write(`${part.length.toString(16)}\r\n${part}\r\n`);
      stream.write('0\r\n\r\n');
      continue;
    }
    if (method === 'GET' && path.split('?')[0] === `${PODS}/ws-a/log`) {
      // a big body: shows the mux's framing against Cloudflare's message size
      const body = 'x'.repeat(BIG);
      send('200 OK', { 'Content-Type': 'text/plain', 'Content-Length': String(BIG) }, body);
      continue;
    }
    if (method === 'GET' && path.split('?')[0] === `${PODS}/ws-a/exec` && h.get('upgrade')?.toLowerCase() === 'websocket') {
      const offered = (h.get('sec-websocket-protocol') ?? '').split(',').map((p) => p.trim());
      const protocol = offered.includes('v5.channel.k8s.io') ? 'v5.channel.k8s.io' : 'v4.channel.k8s.io';
      send('101 Switching Protocols', {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Accept': await wsAccept(h.get('sec-websocket-key') ?? ''),
        'Sec-WebSocket-Protocol': protocol,
      });
      // the exec: echo stdin (channel 0) upper-cased on stdout (channel 1); v5's close of stdin (channel 255) ends it with a status (3)
      for (;;) {
        const f = await readWsFrame(r);
        if (f.opcode !== 2) continue;
        const channel = f.payload[0];
        if (channel === 0) {
          const out = Buffer.concat([Buffer.from([1]), Buffer.from(f.payload.subarray(1).toString('utf8').toUpperCase())]);
          stream.write(wsFrame(2, out, false));
        } else if (channel === 255 && f.payload[1] === 0) {
          const status = Buffer.from(JSON.stringify({ metadata: {}, status: 'Success' }));
          stream.write(wsFrame(2, Buffer.concat([Buffer.from([3]), status]), false));
          stream.write(wsFrame(8, Buffer.from([0x03, 0xe8]), false));
          return void stream.end();
        }
      }
    }
    json('403 Forbidden', { kind: 'Status', status: 'Failure', code: 403, reason: 'Forbidden' });
  }
}

const inBridgeDO = <T>(fn: () => Promise<T>): Promise<T> => runInDurableObject(locate(env.BRIDGE, 'spike-g6'), fn);

describe('G6 spike: the portal half of Connect inside BridgeDO on workerd', () => {
  it('has the Node pieces the tunnel code leans on (nodejs_compat): Buffer, node:stream, process.nextTick, timers with unref', async () => {
    await inBridgeDO(async () => {
      const { Duplex } = await import('node:stream');
      expect(typeof Duplex).toBe('function');
      expect(Buffer.from('abc').toString('hex')).toBe('616263');
      await new Promise<void>((resolve) => process.nextTick(resolve));
      const t = setTimeout(() => undefined, 60_000);
      expect(typeof (t as unknown as { unref?: unknown }).unref).toBe('function');
      clearTimeout(t);
    });
  });

  it('lists pods over a kube stream with HTTP/1.1 written on the stream; keep-alive; the bearer and the namespace are checked', async () => {
    await inBridgeDO(async () => {
      const r = rig();
      try {
        const s = await openService(r.portal, { service: 'kube' });
        const rd = new ByteReader(s);
        const auth = { Authorization: `Bearer ${r.bearer}`, Accept: 'application/json' };
        writeRequest(s, { method: 'GET', path: `${PODS}?labelSelector=app%3Dclaudepilot-workspace`, headers: auth });
        const list = await readResponse(rd);
        expect(list.status).toBe(200);
        expect(list.headers.get('transfer-encoding')).toBe('chunked');
        const pods = JSON.parse(list.body.toString('utf8')) as { kind: string; items: { metadata: { name: string } }[] };
        expect(pods.kind).toBe('PodList');
        expect(pods.items.map((p) => p.metadata.name)).toEqual(['ws-a', 'ws-b']);
        // the same stream carries the next request (the kube client's keep-alive connection)
        writeRequest(s, { method: 'GET', path: '/api/v1/namespaces/kube-system/pods', headers: auth });
        expect((await readResponse(rd)).status).toBe(403);
        writeRequest(s, { method: 'GET', path: PODS, headers: { Authorization: 'Bearer wrong' } });
        expect((await readResponse(rd)).status).toBe(401);
        s.end();
        // a service the agent does not run is a typed refusal, not a hang
        await expect(openService(r.portal, { service: 'docker' })).rejects.toMatchObject({ code: 'service_unavailable' });
      } finally {
        r.close();
      }
    });
  });

  it('runs an exec (v5.channel.k8s.io) on the same kind of stream: 101, then channel-tagged WebSocket frames', async () => {
    await inBridgeDO(async () => {
      const r = rig();
      try {
        const s = await openService(r.portal, { service: 'kube' });
        const rd = new ByteReader(s);
        const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
        writeRequest(s, {
          method: 'GET',
          path: `${PODS}/ws-a/exec?container=main&command=cat&stdin=true&stdout=true&stderr=true`,
          headers: {
            Authorization: `Bearer ${r.bearer}`,
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': key,
            'Sec-WebSocket-Protocol': 'v5.channel.k8s.io, v4.channel.k8s.io',
          },
        });
        const head = await readHead(rd);
        expect(head.status).toBe(101);
        expect(head.headers.get('sec-websocket-protocol')).toBe('v5.channel.k8s.io');
        expect(head.headers.get('sec-websocket-accept')).toBe(await wsAccept(key));
        s.write(wsFrame(2, Buffer.concat([Buffer.from([0]), Buffer.from('hello pilot')]), true));
        const out = await readWsFrame(rd);
        expect(out.payload[0]).toBe(1);
        expect(out.payload.subarray(1).toString('utf8')).toBe('HELLO PILOT');
        s.write(wsFrame(2, Buffer.from([255, 0]), true)); // v5: close stdin
        const status = await readWsFrame(rd);
        expect(status.payload[0]).toBe(3);
        expect(JSON.parse(status.payload.subarray(1).toString('utf8'))).toMatchObject({ status: 'Success' });
        expect((await readWsFrame(rd)).opcode).toBe(8);
      } finally {
        r.close();
      }
    });
  });

  it('carries a 2 MiB body in mux frames far under the WebSocket payload cap, with flow control', async () => {
    await inBridgeDO(async () => {
      const r = rig();
      try {
        const s = await openService(r.portal, { service: 'kube' });
        writeRequest(s, { method: 'GET', path: `${PODS}/ws-a/log`, headers: { Authorization: `Bearer ${r.bearer}` } });
        const res = await readResponse(new ByteReader(s));
        expect(res.status).toBe(200);
        expect(res.body.length).toBe(BIG);
        const biggest = Math.max(...r.agentSocket.sentSizes);
        expect(biggest).toBeLessThanOrEqual(CONNECT_LIMITS.maxFramePayload + 12);
        expect(biggest).toBeLessThan(CONNECT_LIMITS.wsMaxPayload);
        // 2 MiB in 64 KiB frames is at least 32 messages; the 256 KiB window means the agent waited for window updates on the way
        expect(r.agentSocket.sentSizes.length).toBeGreaterThanOrEqual(BIG / CONNECT_LIMITS.maxFramePayload);
      } finally {
        r.close();
      }
    });
  });
});
