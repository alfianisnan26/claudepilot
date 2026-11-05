// src/bridge/kubeExec.ts without a link (PILOT-1171, G6c slice 2): the exec check and its request target, the frame codec, the resize
// check, and the relay over a stand-in stream. The relay through BridgeDO and a stand-in agent is in bridge.test.ts.

import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ByteReader } from '../src/bridge/http1.js';
import {
  EXEC_LIMITS,
  execProtocolOf,
  execResize,
  kubeExecCallOf,
  readWsFrame,
  relayExec,
  wsAccept,
  wsFrame,
  type ExecProtocol,
} from '../src/bridge/kubeExec.js';

const NS = 'claudepilot-workspaces';
const POD = 'ws-0123456789ab-5d8f7c9b4-x2x7q';
const spec = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ namespace: NS, bearer: crypto.randomUUID(), pod: POD, command: ['sh'], ...over });

describe('kubeExecCallOf: the exec check and its request', () => {
  it('builds the exec path and query: the workspace container, each argument, every stream flag explicit', () => {
    const r = kubeExecCallOf(spec({ command: ['sh', '-c', 'echo a&b=c'], tty: true }));
    expect('call' in r && r.call).toEqual({
      method: 'GET',
      path: `/api/v1/namespaces/${NS}/pods/${POD}/exec`,
      query: 'container=workspace&command=sh&command=-c&command=echo+a%26b%3Dc&stdin=true&stdout=true&stderr=false&tty=true',
    });
    const plain = kubeExecCallOf(spec());
    expect('call' in plain && new URLSearchParams(plain.call.query).get('stderr')).toBe('true');
  });

  it('refuses what the agent’s proxy or the API server would, before anything is sent', () => {
    const bad = [
      'not json',
      '[]',
      spec({ namespace: 'Bad_NS' }),
      spec({ namespace: '..' }),
      spec({ bearer: 'with space' }),
      spec({ bearer: 7 }),
      spec({ pod: 'kube-apiserver-node1' }),
      spec({ pod: 'ws-a/../../secrets' }),
      spec({ command: [] }),
      spec({ command: 'sh' }),
      spec({ command: ['sh', 7] }),
      spec({ command: ['sh', 'a\0b'] }),
      spec({ command: Array.from({ length: 1001 }, () => 'x') }),
      spec({ command: ['sh', 'x'.repeat(EXEC_LIMITS.maxTargetBytes)] }),
      spec({ tty: true, stderr: true }),
      spec({ tty: 'yes' }),
      spec({ stdin: false, stdout: false, stderr: false }),
    ];
    for (const raw of bad) expect(kubeExecCallOf(raw), raw.slice(0, 80)).toMatchObject({ ok: false, code: 'bad_request' });
    expect(kubeExecCallOf(null)).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('the container is always `workspace`: a caller’s container field is ignored', () => {
    const r = kubeExecCallOf(spec({ container: 'sidecar' }));
    expect('call' in r && new URLSearchParams(r.call.query).getAll('container')).toEqual(['workspace']);
  });
});

describe('the frame codec', () => {
  it('Sec-WebSocket-Accept matches RFC 6455’s example', async () => {
    expect(await wsAccept('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('round-trips short, 16-bit and 64-bit lengths, masked and not', async () => {
    for (const n of [0, 125, 126, 65_535, 65_536, 200_000]) {
      for (const mask of [true, false]) {
        const payload = crypto.getRandomValues(new Uint8Array(Math.min(n, 65_536))).slice();
        const data = n > 65_536 ? new Uint8Array(n).fill(7) : payload;
        const s = stand();
        s.feed(wsFrame(2, data, mask));
        const f = await readWsFrame(s.reader);
        expect([f.fin, f.opcode, f.masked, f.payload.length]).toEqual([true, 2, mask, n]);
        expect(Buffer.compare(f.payload, Buffer.from(data))).toBe(0);
      }
    }
  });

  it('refuses a frame over the cap before reading it, and reserved bits', async () => {
    const big = stand();
    big.feed(wsFrame(2, new Uint8Array(10), false).subarray(0, 2));
    await expect(readWsFrame(big.reader, 5)).rejects.toThrow('frame too large');
    const rsv = stand();
    rsv.feed(Buffer.from([0xc2, 0x00]));
    await expect(readWsFrame(rsv.reader)).rejects.toThrow('reserved bits');
  });

  it('execProtocolOf takes only what was offered', () => {
    expect(execProtocolOf('v5.channel.k8s.io')).toBe('v5.channel.k8s.io');
    expect(execProtocolOf(' v4.channel.k8s.io ')).toBe('v4.channel.k8s.io');
    for (const p of [undefined, '', 'base64.channel.k8s.io', 'channel.k8s.io', 'v5.channel.k8s.io, v4.channel.k8s.io'])
      expect(execProtocolOf(p)).toBeNull();
  });

  it('execResize keeps Width and Height (integers 1..10000) and drops the rest', () => {
    const enc = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
    expect(execResize(enc({ Width: 80, Height: 24, Extra: 'x' }))).toBe('{"Width":80,"Height":24}');
    for (const bad of [
      { Width: 0, Height: 1 },
      { Width: 1.5, Height: 2 },
      { Width: '80', Height: 24 },
      { Width: 10_001, Height: 1 },
      [80, 24],
      'nope',
    ])
      expect(execResize(enc(bad)), JSON.stringify(bad)).toBeNull();
    expect(execResize(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });
});

/** A stand-in for the `kube` stream after the 101: `feed` is what the pod sends, `written` what the relay wrote toward it. */
function stand() {
  const written: Buffer[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb) {
      written.push(Buffer.from(chunk));
      cb();
    },
  });
  const reader = new ByteReader(stream);
  return { stream, reader, written, feed: (b: Uint8Array) => void stream.push(Buffer.from(b)) };
}

/** Frames the relay wrote toward the pod, unmasked. */
async function writtenFrames(written: Buffer[]) {
  const s = stand();
  s.feed(Buffer.concat(written));
  s.stream.push(null);
  const out: { opcode: number; masked: boolean; data: number[] }[] = [];
  for (;;) {
    const f = await readWsFrame(s.reader).catch(() => null);
    if (!f) return out;
    out.push({ opcode: f.opcode, masked: f.masked, data: [...f.payload] });
  }
}

function relayOn(protocol: ExecProtocol) {
  const s = stand();
  const sent: number[][] = [];
  const closed: { code: number; reason: string }[] = [];
  const relay = relayExec({
    stream: s.stream,
    reader: s.reader,
    protocol,
    peer: { send: (d) => void sent.push([...d]), close: (code, reason) => void closed.push({ code, reason }) },
  });
  return { ...s, sent, closed, relay };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const bytes = (ch: number, s: string) => new Uint8Array([ch, ...new TextEncoder().encode(s)]);

describe('relayExec', () => {
  it('caller to pod: stdin and a checked resize go as masked binary frames; [255, 0] only on v5', async () => {
    for (const protocol of ['v5.channel.k8s.io', 'v4.channel.k8s.io'] as const) {
      const r = relayOn(protocol);
      r.relay.fromPeer(bytes(0, 'ls\n'));
      r.relay.fromPeer(bytes(4, '{"Width":100,"Height":30,"x":1}').buffer as ArrayBuffer);
      r.relay.fromPeer(new Uint8Array([255, 0]));
      const frames = await writtenFrames(r.written);
      const expected = [
        [0, ...new TextEncoder().encode('ls\n')],
        [4, ...new TextEncoder().encode('{"Width":100,"Height":30}')],
      ];
      if (protocol === 'v5.channel.k8s.io') expected.push([255, 0]);
      expect(frames.map((f) => f.data)).toEqual(expected);
      expect(frames.every((f) => f.masked && f.opcode === 2)).toBe(true);
      expect(r.closed).toEqual([]);
    }
  });

  it('pod to caller: output and the status, fragments joined, empty openers dropped, a ping answered with a pong', async () => {
    const r = relayOn('v5.channel.k8s.io');
    r.feed(wsFrame(2, new Uint8Array([1]), false));
    r.feed(wsFrame(2, bytes(1, 'he'), false, false));
    r.feed(wsFrame(0, new TextEncoder().encode('llo'), false));
    r.feed(wsFrame(9, new Uint8Array([1, 2]), false));
    r.feed(wsFrame(2, bytes(2, 'oops'), false));
    r.feed(wsFrame(2, bytes(3, '{"status":"Success"}'), false));
    r.feed(wsFrame(8, new Uint8Array([0x03, 0xe8]), false));
    expect(await r.relay.ended).toBe('The exec ended.');
    const dec = (a: number[]) => [a[0], new TextDecoder().decode(new Uint8Array(a.slice(1)))];
    expect(r.sent.map(dec)).toEqual([
      [1, 'hello'],
      [2, 'oops'],
      [3, '{"status":"Success"}'],
    ]);
    expect(await writtenFrames(r.written)).toEqual([{ opcode: 10, masked: true, data: [1, 2] }]);
    expect(r.closed).toEqual([{ code: 1000, reason: 'The exec ended.' }]);
  });

  it('a masked or text frame from the pod breaks the protocol: the caller is closed 1002', async () => {
    for (const frame of [wsFrame(2, bytes(1, 'x'), true), wsFrame(1, bytes(1, 'x'), false), wsFrame(0, bytes(1, 'x'), false)]) {
      const r = relayOn('v5.channel.k8s.io');
      r.feed(frame);
      await r.relay.ended;
      expect(r.closed[0]?.code).toBe(1002);
      expect(r.stream.destroyed).toBe(true);
    }
  });

  it('the caller sending a text message, an output channel, a bad resize or a bad close is closed, and the pod is told', async () => {
    const cases: [string | Uint8Array, number][] = [
      ['text', 1003],
      [bytes(1, 'x'), 1008],
      [bytes(4, '{"Width":-1,"Height":2}'), 1008],
      [new Uint8Array([255, 1]), 1008],
    ];
    for (const [msg, code] of cases) {
      const r = relayOn('v5.channel.k8s.io');
      r.relay.fromPeer(msg);
      await r.relay.ended;
      expect(r.closed[0]?.code).toBe(code);
      expect(await writtenFrames(r.written)).toEqual([{ opcode: 8, masked: true, data: [0x03, 0xe8] }]);
      r.stream.destroy();
    }
  });

  it('the caller closing sends a masked close frame and ends the stream; a lost stream closes the caller 1011', async () => {
    const a = relayOn('v4.channel.k8s.io');
    a.relay.peerClosed(1000);
    expect(await a.relay.ended).toBe('The caller closed.');
    expect(await writtenFrames(a.written)).toEqual([{ opcode: 8, masked: true, data: [0x03, 0xe8] }]);
    expect(a.stream.writableEnded).toBe(true);
    a.stream.destroy();

    const b = relayOn('v4.channel.k8s.io');
    b.stream.destroy();
    await tick();
    expect(await b.relay.ended).toBe('The exec stream ended.');
    expect(b.closed[0]?.code).toBe(1011);
  });

  it('a pod close code a Worker may not send becomes 1000', async () => {
    const r = relayOn('v5.channel.k8s.io');
    r.feed(wsFrame(8, new Uint8Array([0x03, 0xee]), false)); // 1006
    await r.relay.ended;
    expect(r.closed[0]?.code).toBe(1000);
  });
});
