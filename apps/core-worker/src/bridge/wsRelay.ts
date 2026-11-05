// A WebSocket relayed through an `http` stream (PILOT-1149): /api/live and the chat socket of a scratch portal. BridgeDO did the upgrade on
// the stream (it is the WebSocket client there: its frames are masked) and accepted a WebSocket for the browser; this moves messages
// between the two, text and binary, as they are. Unlike the exec relay (kubeExec.ts) nothing is tagged or checked inside a message.
//
//  - A message is at most API_LIMITS.maxMessageBytes either way; fragments from the portal are joined into one message first.
//  - A ping from the portal is answered; a pong is dropped. A close passes its code on (one a Worker may send; otherwise 1000).
//  - Text from the portal must be UTF-8 (1007 otherwise). A masked frame, reserved bits or frames out of order: 1002.
//  - Input the stream has not taken past API_LIMITS.maxMessageBytes * 2: the browser's socket is closed 1009.
// workerd's WebSocket has no bufferedAmount, so output toward the browser is not held back; one message at a time is bounded.

import type { Duplex } from 'node:stream';
import { API_LIMITS } from './apiProxy.js';
import type { ByteReader } from './http1.js';
import { ExecProtocolError, readWsFrame, wsFrame } from './kubeExec.js';

export interface WsPeer {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface WsRelay {
  fromPeer(data: string | ArrayBuffer | Uint8Array): void;
  peerClosed(code: number): void;
  /** Resolves once, when both sides are ended, with why. */
  readonly ended: Promise<string>;
}

/** Close codes a Worker may send as they are (the exec relay's rule); anything else becomes 1000. */
export const wsPassable = (c: number) => c === 1000 || (c >= 1001 && c <= 1003) || (c >= 1007 && c <= 1011) || (c >= 3000 && c <= 4999);

export function relayWs(opts: { stream: Duplex; reader: ByteReader; peer: WsPeer }): WsRelay {
  const { stream, reader, peer } = opts;
  let done = false;
  let resolveEnded!: (why: string) => void;
  const ended = new Promise<string>((r) => (resolveEnded = r));

  const finish = (code: number, why: string, toStream: 'frame' | 'destroy') => {
    if (done) return;
    done = true;
    const sent = wsPassable(code) ? code : 1000;
    try {
      peer.close(sent, why.slice(0, 100));
    } catch {
      // already closed
    }
    if (toStream === 'frame' && !stream.destroyed) {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(sent, 0);
      stream.write(wsFrame(8, payload, true));
      stream.end();
      const t = setTimeout(() => stream.destroy(), 5_000);
      stream.once('close', () => clearTimeout(t));
    } else stream.destroy();
    resolveEnded(why);
  };

  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

  void (async () => {
    const parts: Buffer[] = [];
    let size = 0;
    let opcode = 0;
    try {
      for (;;) {
        const f = await readWsFrame(reader, API_LIMITS.maxMessageBytes);
        if (f.masked) throw new ExecProtocolError('a masked frame from the server');
        if (f.opcode >= 8) {
          if (!f.fin || f.payload.length > 125) throw new ExecProtocolError('a bad control frame');
          if (f.opcode === 9) stream.write(wsFrame(10, f.payload, true));
          else if (f.opcode === 8) {
            const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1000;
            return finish(code, 'The portal closed.', 'destroy');
          } else if (f.opcode !== 10) throw new ExecProtocolError('an unknown control frame');
          continue;
        }
        if (f.opcode === 1 || f.opcode === 2) {
          if (parts.length > 0) throw new ExecProtocolError('frames out of order');
          opcode = f.opcode;
        } else if (f.opcode !== 0 || parts.length === 0) throw new ExecProtocolError('frames out of order');
        size += f.payload.length;
        if (size > API_LIMITS.maxMessageBytes) throw new ExecProtocolError('message too large');
        parts.push(f.payload);
        if (!f.fin) continue;
        const msg = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
        parts.length = 0;
        size = 0;
        if (opcode === 1) {
          let text: string;
          try {
            text = utf8.decode(msg);
          } catch {
            return finish(1007, 'The portal sent text that is not UTF-8.', 'frame');
          }
          peer.send(text);
        } else peer.send(new Uint8Array(msg));
      }
    } catch (e) {
      if (done) return;
      if (e instanceof ExecProtocolError) finish(1002, `The portal's socket broke the protocol: ${e.message}.`, 'destroy');
      else finish(1011, 'The portal’s socket ended.', 'destroy');
    }
  })();

  return {
    ended,
    fromPeer(data) {
      if (done) return;
      const text = typeof data === 'string';
      const bytes = text ? Buffer.from(data, 'utf8') : data instanceof Uint8Array ? data : new Uint8Array(data);
      if (bytes.length > API_LIMITS.maxMessageBytes) return finish(1009, 'The message is too large.', 'frame');
      stream.write(wsFrame(text ? 1 : 2, bytes, true));
      if (stream.writableLength > API_LIMITS.maxMessageBytes * 2) finish(1009, 'Too much input waiting for the portal.', 'destroy');
    },
    peerClosed(code) {
      finish(code, 'The browser closed.', 'frame');
    },
  };
}
