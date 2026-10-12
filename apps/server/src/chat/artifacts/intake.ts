// Chat content: taking bytes into the blob store (chat-sessions PRD FR31, §13). Whatever arrives, from a
// browser or from a workspace, is streamed to a temporary file in the blob directory while its hash and its
// first bytes (for the sniffer) are taken, so a large file is never held whole in memory and a connection
// that drops leaves nothing behind. The caller then decides what to do with the finished file.

import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { AppError } from '@isnanme/core';
import type { Store } from '../../store/store.js';
import { ensureBlobDir } from '../blobs.js';
import { SNIFF_BYTES } from './sniff.js';

export interface Intake {
  /** The finished temporary file (in the blob directory): adopt it with `adoptBlob`, or delete it. */
  tmp: string;
  sha256: string;
  size: number;
  /** The first {@link SNIFF_BYTES} bytes, or all of them when the file is shorter. */
  head: Buffer;
}

/**
 * Streams `body` to a temporary file. `tooLarge` is the error thrown (and the file removed) when more than
 * `maxBytes` arrive; a failed or dropped stream throws `interrupted`. An empty body is allowed here: the
 * caller says what that means.
 */
export async function intakeStream(
  store: Store,
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  errors: { tooLarge: () => AppError; interrupted?: () => AppError },
): Promise<Intake> {
  const tmp = join(ensureBlobDir(store), `.in-${randomBytes(8).toString('hex')}.part`);
  const hash = createHash('sha256');
  const head: Buffer[] = [];
  let headLength = 0;
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > maxBytes) return done(errors.tooLarge());
      hash.update(chunk);
      if (headLength < SNIFF_BYTES) {
        const take = chunk.subarray(0, SNIFF_BYTES - headLength);
        head.push(take);
        headLength += take.length;
      }
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>), tap, createWriteStream(tmp, { mode: 0o600, flags: 'wx' }));
  } catch (e) {
    rmSync(tmp, { force: true });
    if (e instanceof AppError) throw e;
    throw errors.interrupted?.() ?? new AppError('BAD_REQUEST', 'The transfer was interrupted.', { cause: e });
  }
  return { tmp, sha256: hash.digest('hex'), size, head: Buffer.concat(head) };
}
