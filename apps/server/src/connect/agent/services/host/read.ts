// `host` op `read` (docs/prd/targets-connect.md §11.6): one regular file, at most `maxBytes` (default 8 MiB), as DATA records, then
// EOF and RESULT. A missing file is `RESULT.error` ENOENT, never an exception; a file over the limit is TOO_LARGE before any byte goes.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ConnectHostOpen } from '@portal/contracts';
import { HostChannel, REC } from './channel.js';
import { errorResult, resultOfError, type HostContext } from './exec.js';

export type ReadOp = Extract<ConnectHostOpen, { op: 'read' }>;
export const DEFAULT_MAX_READ = 8 * 1024 * 1024;

export async function runRead(op: ReadOp, ch: HostChannel, ctx: HostContext): Promise<void> {
  if (typeof op.path !== 'string' || !op.path.startsWith('/') || op.path.includes('\0') || op.path.length > 4096) {
    return ch.finish(errorResult('EINVAL', 'path must be an absolute path'));
  }
  const limit = Math.min(Number.isInteger(op.maxBytes) && op.maxBytes! > 0 ? op.maxBytes! : DEFAULT_MAX_READ, ctx.maxRead);
  const target = ctx.paths.map(op.path);
  let size: number;
  try {
    const info = await stat(target);
    if (!info.isFile()) return ch.finish(errorResult('EINVAL', 'not a regular file'));
    size = info.size;
  } catch (e) {
    return ch.finish(resultOfError(e));
  }
  if (size > limit) return ch.finish(errorResult('TOO_LARGE', `the file is ${size} bytes; the limit is ${limit}`));

  return new Promise<void>((resolve) => {
    const rs = createReadStream(target, { highWaterMark: 64 * 1024 });
    let sent = 0;
    let paused = false;
    const end = (fn: () => void) => {
      fn();
      resolve();
    };
    rs.on('data', (chunk) => {
      const bytes = chunk as Buffer;
      sent += bytes.length;
      if (sent > limit) {
        rs.destroy();
        return end(() => ch.finish(errorResult('TOO_LARGE', `the file grew past the limit of ${limit} bytes`)));
      }
      if (ch.sendBytes(REC.data, bytes) || paused) return;
      paused = true;
      rs.pause();
      void ch.drained().then(() => {
        paused = false;
        rs.resume();
      });
    });
    rs.on('end', () =>
      end(() => {
        ch.send(REC.eof);
        ch.finish({ code: 0 });
      }),
    );
    rs.on('error', (e) => end(() => ch.finish(resultOfError(e))));
    ch.onClose(() => {
      rs.destroy();
      resolve();
    });
  });
}
