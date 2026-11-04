// The mux's socket on a hibernatable WebSocket (PILOT-1170). Under the Hibernation API the runtime calls the Durable Object's
// `webSocketMessage` / `webSocketClose` (never an addEventListener handler, which would keep the object awake), so this socket is fed by
// BridgeDO: `push` a message, `ended` a close. What it sends goes straight to `ws.send`.
//
// Cloudflare's `send` has no completion callback and no `bufferedAmount`: the runtime takes the message at once. So the callback fires on the
// next microtask and `bufferedAmount` is 0, and the mux's high/low water marks never hold back. What bounds the bytes queued toward the
// agent instead is the per-stream window (a stream sends at most what the agent granted, `initialWindow`) times the streams a link may
// hold: BRIDGE_LINK below (the decision is on PILOT-1170).

import { CONNECT_LIMITS } from '@portal/contracts';
import type { MuxLimits, MuxSocket } from '@portal/connect-tunnel/mux';

/** The limits of one bridge link's mux session (the rest are the contract's). */
const MAX_STREAMS = 32;
export const BRIDGE_LINK = {
  /** Streams one link may hold, both directions: far under the contract's 256, so the bound below fits a Durable Object's 128 MB. */
  maxStreams: MAX_STREAMS,
  /** The most a link can have queued toward the agent: every stream's whole window (`maxStreams * initialWindow` = 8 MiB). */
  maxQueuedBytes: MAX_STREAMS * CONNECT_LIMITS.initialWindow,
  /** The largest response body the bridge reads into memory from one request. */
  maxBodyBytes: 4 * 1024 * 1024,
} as const;

export const bridgeMuxLimits = (): Partial<MuxLimits> => ({ maxStreams: BRIDGE_LINK.maxStreams });

export interface HibernatedSocket extends MuxSocket {
  /** A message the runtime delivered to `webSocketMessage`. */
  push(message: string | ArrayBuffer): void;
  /** The runtime delivered `webSocketClose` (or `webSocketError`: 1006). */
  ended(code: number, reason: string): void;
}

export function hibernatedSocket(ws: WebSocket): HibernatedSocket {
  let message: ((data: Buffer, isBinary: boolean) => void) | null = null;
  let close: ((code: number, reason: string) => void) | null = null;
  let done = false;
  const shut = (code: number, reason: string) => {
    if (done) return;
    done = true;
    try {
      ws.close(code, reason.slice(0, 100));
    } catch {
      // already closed
    }
  };
  return {
    bufferedAmount: 0,
    send(data, cb) {
      try {
        ws.send(data);
        queueMicrotask(() => cb());
      } catch (e) {
        queueMicrotask(() => cb(e instanceof Error ? e : new Error(String(e))));
      }
    },
    close: shut,
    // Cloudflare has no abortive close: 1011 is the nearest.
    terminate: () => shut(1011, 'terminated'),
    onMessage: (fn) => void (message = fn),
    onClose: (fn) => void (close = fn),
    onError: () => undefined, // an error reaches the object as webSocketError, which calls `ended`
    push(m) {
      if (done) return;
      if (typeof m === 'string') message?.(Buffer.from(m, 'utf8'), false);
      else message?.(Buffer.from(m), true);
    },
    ended(code, reason) {
      done = true;
      close?.(code, reason);
    },
  };
}
