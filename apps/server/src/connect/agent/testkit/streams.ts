// Test helpers: a pair of connected `TunnelStream`s with no tunnel between them (a `duplexPair` wearing the `net.Socket` stubs an
// `http.Agent` and an `http.Server` call). The agent's services are written against `TunnelStream`; these let their tests run
// without the mux, and the same shape is what the real mux hands out.
import { duplexPair, type Duplex } from 'node:stream';
import type { TunnelStream } from '../../seams.js';

/** Adds what the HTTP stack calls on a socket (keep-alive and timeouts are the mux's business: no-ops here). */
export function tunnelStream(d: Duplex): TunnelStream {
  const s = d as TunnelStream;
  s.setKeepAlive = () => s;
  s.setNoDelay = () => s;
  s.setTimeout = (_ms: number, cb?: () => void) => {
    if (cb) s.once('timeout', cb);
    return s;
  };
  s.ref = () => s;
  s.unref = () => s;
  Object.assign(s, { remoteAddress: '127.0.0.1', remotePort: 1, localAddress: '127.0.0.1', localPort: 2 });
  return s;
}

/**
 * [portal side, agent side]: what one writes the other reads. Like the mux, a destroy on one side (a reset) destroys the other too, while
 * an `end` is only a half-close: the other side's readable ends and its writable stays open until it ends it.
 */
export function streamPair(): [TunnelStream, TunnelStream] {
  const [a, b] = duplexPair();
  a.once('close', () => b.destroy());
  b.once('close', () => a.destroy());
  return [tunnelStream(a), tunnelStream(b)];
}
