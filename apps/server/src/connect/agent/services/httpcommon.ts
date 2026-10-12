// Pieces both policy proxies (docker and kube) use on the HTTP side: the framing check, the headers that may travel back, and reading the
// bytes after the headers of an upgrade request (Node leaves those to the handler).
import type http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** One Content-Length, or one chunked Transfer-Encoding, never both; one Host. Node's parser rejects most of these itself; this is the second wall. */
export function framingProblem(req: IncomingMessage): string | null {
  const counts = new Map<string, number>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if ((counts.get('content-length') ?? 0) > 1) return 'Duplicate Content-Length.';
  if ((counts.get('transfer-encoding') ?? 0) > 1) return 'Duplicate Transfer-Encoding.';
  if ((counts.get('host') ?? 0) > 1) return 'Duplicate Host.';
  if (counts.has('content-length') && counts.has('transfer-encoding')) return 'Both Content-Length and Transfer-Encoding.';
  const te = req.headers['transfer-encoding'];
  if (te !== undefined && te.toLowerCase() !== 'chunked') return 'Only a chunked Transfer-Encoding is understood.';
  const cl = req.headers['content-length'];
  if (cl !== undefined && !/^\d{1,15}$/.test(cl)) return 'Content-Length is not a number.';
  return null;
}


/** The upstream's response headers as the client may see them: everything except what is about this hop. */
export function relayHeaders(upRes: IncomingMessage): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(upRes.headers)) if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  return out;
}


/** The first `length` bytes after the headers of an upgrade request (`head` already has some), and whatever came after them. */
export function readFromSocket(socket: Duplex, head: Buffer, length: number): Promise<{ body: Buffer; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let held = head;
    const check = () => {
      if (held.length < length) return false;
      cleanup();
      socket.pause();
      resolve({ body: held.subarray(0, length), rest: held.subarray(length) });
      return true;
    };
    const onData = (c: Buffer) => {
      held = Buffer.concat([held, c]);
      check();
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('closed'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out'));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
    };
    if (check()) return;
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onEnd);
    socket.resume();
  });
}
