// The exec of a workspace pod through the bridge (PILOT-1171, G6c slice 2), in place of @kubernetes/client-node's `Exec`. A stream cannot leave
// BridgeDO, so the caller (another object, or a Worker route) gets a WebSocket that BridgeDO relays:
//
//   caller  <-- WebSocket (channel-tagged binary messages) -->  BridgeDO  <-- `kube` stream: HTTP/1.1 upgrade, RFC 6455 frames -->  agent
//
// The caller asks with `bridgeExecRequest(spec)` on the cluster's BridgeDO stub (`stub.fetch`); the answer is a 101 with the WebSocket and
// the protocol the API server chose in `x-cp-exec-protocol`, or JSON with a KubeFailure. Each message, both ways, is one Kubernetes channel
// message: the channel byte, then the data.
//   caller -> pod:  0 stdin, 4 resize (`{"Width":w,"Height":h}`, checked and rewritten), 255 [255, 0] = close stdin (v5 only; dropped on v4).
//                   Any other channel, or a text message, closes the caller's socket 1008 / 1003.
//   pod -> caller:  1 stdout, 2 stderr, 3 status (the exit Status as JSON). The pod's close closes the caller's socket with its code.
// BridgeDO offers `v5.channel.k8s.io` then `v4.channel.k8s.io` and checks Sec-WebSocket-Accept. This file builds the request, codes the
// frames and runs the relay; it opens nothing itself.

import type { Duplex } from 'node:stream';
import { type ByteReader } from './http1.js';
import { kubeBadRequest, kubeNamespaceOk, kubePathProblem, kubeWorkspaceObjectOk, type KubeCall, type KubeFailure } from './kubeApi.js';

/** The path of BridgeDO's exec upgrade. Only Worker code reaches it: the /bridge route always sends `/bridge` (src/bridge/route.ts). */
export const BRIDGE_EXEC_PATH = '/__exec';
/** The internal header that carries the spec (with the bearer) to BridgeDO; never logged. */
export const BRIDGE_EXEC_HEADER = 'x-cp-exec';
/** On the 101 to the caller: the subprotocol the API server chose. */
export const EXEC_PROTOCOL_HEADER = 'x-cp-exec-protocol';

export const EXEC_PROTOCOLS = ['v5.channel.k8s.io', 'v4.channel.k8s.io'] as const;
export type ExecProtocol = (typeof EXEC_PROTOCOLS)[number];

export const EXEC_CHANNEL = { stdin: 0, stdout: 1, stderr: 2, status: 3, resize: 4, close: 255 } as const;

export const EXEC_LIMITS = {
  /** The container the agent's proxy lets in (apps/server/src/connect/agent/services/kube/rules.ts EXEC_KEYS). */
  container: 'workspace',
  /** The request target, path and query: well under Node's 16 KiB header limit on the agent's side. */
  maxTargetBytes: 8 * 1024,
  maxArgs: 1000,
  /** One message either way (a frame, or the fragments of one): Cloudflare's WebSocket message limit. */
  maxMessageBytes: 1024 * 1024,
  /** Stdin written toward the agent and not yet taken by the stream's window: past it the caller's socket is closed 1009. */
  maxQueuedStdin: 1024 * 1024,
  /** Execs one bridge link may run at once, so REST calls keep streams (BRIDGE_LINK.maxStreams is 32). */
  maxExecs: 16,
  maxTerminal: 10_000,
} as const;

/** What a caller asks for: a command in a workspace pod's `workspace` container. */
export interface KubeExecSpec {
  namespace: string;
  /** The agent's per-link kube bearer: never logged, stored or audited. */
  bearer: string;
  pod: string;
  command: string[];
  tty?: boolean;
  stdin?: boolean;
  stdout?: boolean;
  stderr?: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const BEARER_RE = /^[\x21-\x7e]{1,512}$/;

/** The request a caller sends to the cluster's BridgeDO (`locate(env.BRIDGE, cluster).fetch(...)`) for an exec. */
export function bridgeExecRequest(spec: KubeExecSpec): Request {
  return new Request(`https://bridge.internal${BRIDGE_EXEC_PATH}`, {
    method: 'GET',
    headers: { upgrade: 'websocket', [BRIDGE_EXEC_HEADER]: JSON.stringify(spec) },
  });
}

/** The spec from the internal header, checked, and the request to write; or why it is refused. */
export function kubeExecCallOf(raw: string | null): { spec: KubeExecSpec; call: KubeCall } | KubeFailure {
  let s: unknown;
  try {
    s = JSON.parse(raw ?? '');
  } catch {
    return kubeBadRequest('The exec is not valid.');
  }
  if (!isObject(s)) return kubeBadRequest('The exec is not valid.');
  if (!kubeNamespaceOk(s.namespace)) return kubeBadRequest('The namespace is not valid.');
  if (typeof s.bearer !== 'string' || !BEARER_RE.test(s.bearer)) return kubeBadRequest('The bearer is not valid.');
  if (!kubeWorkspaceObjectOk(s.pod)) return kubeBadRequest('The pod is not one of the portal’s workspaces.');
  const cmd = s.command;
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.length > EXEC_LIMITS.maxArgs)
    return kubeBadRequest('An exec needs a command of 1 to 1000 arguments.');
  if (!cmd.every((c): c is string => typeof c === 'string' && !c.includes('\0'))) return kubeBadRequest('A command argument is not valid.');
  const flags = { tty: false, stdin: true, stdout: true, stderr: s.tty !== true } as Record<'tty' | 'stdin' | 'stdout' | 'stderr', boolean>;
  for (const k of ['tty', 'stdin', 'stdout', 'stderr'] as const) {
    if (s[k] === undefined) continue;
    if (typeof s[k] !== 'boolean') return kubeBadRequest(`${k} is not a boolean.`);
    flags[k] = s[k];
  }
  // The API server refuses both: a terminal has one output stream.
  if (flags.tty && flags.stderr) return kubeBadRequest('A tty exec has no separate stderr.');
  if (!flags.stdout && !flags.stderr && !flags.stdin) return kubeBadRequest('An exec needs at least one stream.');

  const q = new URLSearchParams({ container: EXEC_LIMITS.container });
  for (const c of cmd) q.append('command', c);
  for (const k of ['stdin', 'stdout', 'stderr', 'tty'] as const) q.set(k, String(flags[k]));
  const path = `/api/v1/namespaces/${s.namespace}/pods/${s.pod}/exec`;
  const problem = kubePathProblem(path);
  if (problem) return kubeBadRequest(problem);
  const query = q.toString();
  if (path.length + 1 + query.length > EXEC_LIMITS.maxTargetBytes)
    return kubeBadRequest('The command is too long; send large input on stdin.');
  const spec: KubeExecSpec = { namespace: s.namespace, bearer: s.bearer, pod: s.pod, command: cmd, ...flags };
  return { spec, call: { method: 'GET', path, query } };
}

/** The upgrade headers of the exec request (the bearer added by the caller of this). */
export function execUpgradeHeaders(key: string): Record<string, string> {
  return {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': key,
    'Sec-WebSocket-Protocol': EXEC_PROTOCOLS.join(', '),
  };
}

/** Sec-WebSocket-Accept for a key (RFC 6455 §4.2.2), on WebCrypto. */
export async function wsAccept(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`));
  return Buffer.from(digest).toString('base64');
}

/** The protocol of a 101, or null when it is not one this side offered. */
export const execProtocolOf = (header: string | undefined): ExecProtocol | null =>
  (EXEC_PROTOCOLS as readonly string[]).includes((header ?? '').trim()) ? ((header ?? '').trim() as ExecProtocol) : null;

/** A frame as written by a client (masked, RFC 6455 §5.3) or a server (not masked). */
export function wsFrame(opcode: number, payload: Uint8Array, mask: boolean, fin = true): Buffer {
  const len = payload.length;
  const ext = len < 126 ? 0 : len < 65_536 ? 2 : 8;
  const head = Buffer.alloc(2 + ext + (mask ? 4 : 0));
  head[0] = (fin ? 0x80 : 0) | opcode;
  head[1] = (mask ? 0x80 : 0) | (ext === 0 ? len : ext === 2 ? 126 : 127);
  if (ext === 2) head.writeUInt16BE(len, 2);
  if (ext === 8) head.writeBigUInt64BE(BigInt(len), 2);
  const body = Buffer.from(payload);
  if (mask) {
    const key = crypto.getRandomValues(new Uint8Array(4));
    head.set(key, 2 + ext);
    for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ key[i % 4]!;
  }
  return Buffer.concat([head, body]);
}

export class ExecProtocolError extends Error {}

export interface WsFrame {
  fin: boolean;
  opcode: number;
  masked: boolean;
  payload: Buffer;
}

/** One frame; a payload over `max` bytes is refused before it is read. */
export async function readWsFrame(r: ByteReader, max: number = EXEC_LIMITS.maxMessageBytes): Promise<WsFrame> {
  const [b0, b1] = await r.take(2);
  if (b0! & 0x70) throw new ExecProtocolError('reserved bits set');
  let len = b1! & 0x7f;
  if (len === 126) len = (await r.take(2)).readUInt16BE(0);
  else if (len === 127) {
    const big = (await r.take(8)).readBigUInt64BE(0);
    if (big > BigInt(max)) throw new ExecProtocolError('frame too large');
    len = Number(big);
  }
  if (len > max) throw new ExecProtocolError('frame too large');
  const masked = (b1! & 0x80) !== 0;
  const key = masked ? await r.take(4) : null;
  const payload = Buffer.from(await r.take(len));
  if (key) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ key[i % 4]!;
  return { fin: (b0! & 0x80) !== 0, opcode: b0! & 0x0f, masked, payload };
}

/** A resize message's data checked and rewritten (`{"Width":w,"Height":h}`, integers 1..10000), or null. */
export function execResize(data: Uint8Array): string | null {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data));
  } catch {
    return null;
  }
  if (!isObject(v)) return null;
  const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= EXEC_LIMITS.maxTerminal;
  return ok(v.Width) && ok(v.Height) ? JSON.stringify({ Width: v.Width, Height: v.Height }) : null;
}

/** The caller's side of the relay: the WebSocket BridgeDO accepted for it (or a test's stand-in). */
export interface ExecPeer {
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface ExecRelay {
  /** A message from the caller. */
  fromPeer(data: string | ArrayBuffer | Uint8Array): void;
  /** The caller closed (or its socket failed). */
  peerClosed(code: number): void;
  /** Resolves once, when both sides are ended, with why. */
  readonly ended: Promise<string>;
}

/** Close codes a Worker may pass on to the caller as they are; anything else becomes 1000 (or 1011 for a failure). */
const passable = (c: number) => c === 1000 || (c >= 1001 && c <= 1003) || (c >= 1007 && c <= 1011) || (c >= 3000 && c <= 4999);

/**
 * Relays one exec: the stream (after the 101, read through `reader`) and the caller's socket. Frames toward the agent are masked (this side is
 * the WebSocket client); a ping is answered; fragments are joined into one message, at most EXEC_LIMITS.maxMessageBytes.
 */
export function relayExec(opts: { stream: Duplex; reader: ByteReader; peer: ExecPeer; protocol: ExecProtocol }): ExecRelay {
  const { stream, reader, peer, protocol } = opts;
  let done = false;
  let resolveEnded!: (why: string) => void;
  const ended = new Promise<string>((r) => (resolveEnded = r));

  const finish = (code: number, why: string, closeStream: 'frame' | 'destroy') => {
    if (done) return;
    done = true;
    try {
      peer.close(passable(code) ? code : 1000, why.slice(0, 100));
    } catch {
      // already closed
    }
    if (closeStream === 'frame' && !stream.destroyed) {
      // Tell the API server, then end our half; the agent's proxy tears the rest down. Destroyed after a grace in any case.
      stream.write(wsFrame(8, Buffer.from([0x03, 0xe8]), true));
      stream.end();
      const t = setTimeout(() => stream.destroy(), 5_000);
      stream.once('close', () => clearTimeout(t));
    } else stream.destroy();
    resolveEnded(why);
  };

  const toPod = (data: Uint8Array) => {
    stream.write(wsFrame(2, data, true));
    if (stream.writableLength > EXEC_LIMITS.maxQueuedStdin) finish(1009, 'Too much input waiting for the pod.', 'destroy');
  };

  void (async () => {
    const parts: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const f = await readWsFrame(reader);
        if (f.masked) throw new ExecProtocolError('a masked frame from the server');
        if (f.opcode >= 8) {
          if (!f.fin || f.payload.length > 125) throw new ExecProtocolError('a bad control frame');
          if (f.opcode === 9) stream.write(wsFrame(10, f.payload, true));
          else if (f.opcode === 8) {
            const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1000;
            return finish(code, 'The exec ended.', 'destroy');
          } else if (f.opcode !== 10) throw new ExecProtocolError('an unknown control frame');
          continue;
        }
        if (f.opcode === 1) throw new ExecProtocolError('a text frame (no base64 protocol was offered)');
        if (f.opcode === 2 ? parts.length > 0 : f.opcode !== 0 || parts.length === 0) throw new ExecProtocolError('frames out of order');
        size += f.payload.length;
        if (size > EXEC_LIMITS.maxMessageBytes) throw new ExecProtocolError('message too large');
        parts.push(f.payload);
        if (!f.fin) continue;
        const msg = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
        parts.length = 0;
        size = 0;
        const ch = msg[0];
        // The API server may open with an empty message per channel: dropped. Only output and the status go to the caller.
        if (ch === EXEC_CHANNEL.status || ((ch === EXEC_CHANNEL.stdout || ch === EXEC_CHANNEL.stderr) && msg.length > 1)) peer.send(msg);
      }
    } catch (e) {
      if (done) return;
      if (e instanceof ExecProtocolError) finish(1002, `The pod's stream broke the protocol: ${e.message}.`, 'destroy');
      else finish(1011, 'The exec stream ended.', 'destroy');
    }
  })();

  return {
    ended,
    fromPeer(data) {
      if (done) return;
      if (typeof data === 'string') return finish(1003, 'Only binary messages.', 'frame');
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (bytes.length === 0) return;
      switch (bytes[0]) {
        case EXEC_CHANNEL.stdin:
          return toPod(bytes);
        case EXEC_CHANNEL.resize: {
          const size = execResize(bytes.subarray(1));
          if (!size) return finish(1008, 'A resize is {"Width":w,"Height":h}.', 'frame');
          return toPod(Buffer.concat([Buffer.from([EXEC_CHANNEL.resize]), Buffer.from(size)]));
        }
        case EXEC_CHANNEL.close:
          if (bytes.length !== 2 || bytes[1] !== EXEC_CHANNEL.stdin) return finish(1008, 'Only stdin (0) can be closed.', 'frame');
          // v4 has no half-close: dropped (the caller sees the protocol on the 101).
          if (protocol === 'v5.channel.k8s.io') toPod(bytes);
          return;
        default:
          return finish(1008, `Channel ${bytes[0]} is not one a caller sends.`, 'frame');
      }
    },
    peerClosed(code) {
      finish(code, 'The caller closed.', 'frame');
    },
  };
}
