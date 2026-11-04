// JSON lines over a stream (docs/prd/targets-connect.md §9.4 and §9.5): the open request and answer (one line each way, at most 16 KiB)
// and the `control` stream (one JSON object per line, at most 256 KiB). A line is UTF-8 text ending in `\n`.
//
// Shared by the portal and the agent: only `node:*` is imported.

import type { Readable, Writable } from 'node:stream';

/** A line grew past its cap before its newline came. */
export class LineTooLong extends Error {
  override readonly name = 'LineTooLong';
}

/** The stream ended (or was destroyed) before a whole line arrived. */
export class LineEnded extends Error {
  override readonly name = 'LineEnded';
}

/** A line was not JSON. */
export class LineMalformed extends Error {
  override readonly name = 'LineMalformed';
}

/** Nobody sent a line in time. */
export class LineTimeout extends Error {
  override readonly name = 'LineTimeout';
}

const EMPTY = Buffer.alloc(0);

/**
 * Reads one line from `stream` (the text before the first newline, which must come within `maxBytes`) and leaves whatever follows it in the
 * stream, so the rest can be read as raw bytes, records or more lines. Resolves null when the stream ended with nothing read.
 */
export function readLine(stream: Readable, maxBytes: number, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string | null> {
  if (stream.readableEnded && stream.readableLength === 0) return Promise.resolve(null);
  if (stream.destroyed && stream.readableLength === 0) return Promise.reject(new LineEnded('The stream is closed.'));
  return new Promise((resolve, reject) => {
    let held: Buffer = EMPTY;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      stream.off('readable', onReadable);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.off('close', onClose);
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const done = (fn: () => void) => {
      cleanup();
      fn();
    };
    const onReadable = () => {
      let chunk: Buffer | null;
      while ((chunk = stream.read() as Buffer | null) !== null) {
        held = held.length ? Buffer.concat([held, chunk]) : chunk;
        const nl = held.indexOf(0x0a);
        if (nl >= 0 ? nl > maxBytes : held.length > maxBytes) return done(() => reject(new LineTooLong(`A line is longer than ${maxBytes} bytes.`)));
        if (nl >= 0) {
          const rest = held.subarray(nl + 1);
          const line = held.subarray(0, nl).toString('utf8');
          return done(() => {
            if (rest.length) stream.unshift(rest);
            resolve(line);
          });
        }
      }
    };
    const onEnd = () => done(() => (held.length ? reject(new LineEnded('The stream ended inside a line.')) : resolve(null)));
    const onError = (e: Error) => done(() => reject(e));
    const onClose = () => done(() => reject(new LineEnded('The stream closed.')));
    const onAbort = () => done(() => reject(opts.signal?.reason instanceof Error ? opts.signal.reason : new LineEnded('Aborted.')));
    if (opts.signal?.aborted) return onAbort();
    stream.on('readable', onReadable);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('close', onClose);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.timeoutMs !== undefined) timer = setTimeout(() => done(() => reject(new LineTimeout('No line arrived in time.'))), opts.timeoutMs);
    onReadable();
  });
}

/** `JSON.stringify` plus the newline, as bytes; refuses a line over `maxBytes` (a sender bug, not something to put on the wire). */
export function encodeLine(value: unknown, maxBytes?: number): Buffer {
  const buf = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (maxBytes !== undefined && buf.length - 1 > maxBytes) throw new LineTooLong(`A line of ${buf.length - 1} bytes is over the limit of ${maxBytes}.`);
  return buf;
}

/** Writes one line and resolves when it was accepted by the stream. */
export function writeLine(stream: Writable, value: unknown, maxBytes?: number): Promise<void> {
  const buf = encodeLine(value, maxBytes);
  return new Promise((resolve, reject) => {
    if (stream.destroyed) return reject(new LineEnded('The stream is closed.'));
    stream.write(buf, (e) => (e ? reject(e) : resolve()));
  });
}

/** Parses one line as JSON, or throws LineMalformed (never echoing the text: it may hold something secret). */
export function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new LineMalformed('A line is not JSON.');
  }
}

/**
 * The lines of `stream` as parsed JSON, until it ends. An empty line is skipped; a line over `maxBytes` or one that is not JSON throws, and the
 * caller closes the stream (and, for `control`, the connection: PRD §9.5).
 */
export async function* readJsonLines(stream: Readable, maxBytes: number): AsyncGenerator<unknown> {
  let held: Buffer = EMPTY;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    held = held.length ? Buffer.concat([held, chunk]) : chunk;
    let nl: number;
    while ((nl = held.indexOf(0x0a)) >= 0) {
      if (nl > maxBytes) throw new LineTooLong(`A line is longer than ${maxBytes} bytes.`);
      const text = held.subarray(0, nl).toString('utf8');
      held = held.subarray(nl + 1);
      if (text.trim()) yield parseLine(text);
    }
    if (held.length > maxBytes) throw new LineTooLong(`A line is longer than ${maxBytes} bytes.`);
  }
  if (held.length) throw new LineEnded('The stream ended inside a line.');
}
