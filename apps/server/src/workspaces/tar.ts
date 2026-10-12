// The tar archive delivery writes into a workspace, shared by the Docker runtime (`putArchive`) and the Host runtime over a Connect
// tunnel (the `put` op streams the same archive; docs/prd/targets-connect.md §12.7).
import { pack } from 'tar-stream';
import type { TarEntry } from './runtime.js';

/** A tar archive (paths relative to `/`) with the entries' owner and mode in the headers. */
export async function tarOf(entries: TarEntry[]): Promise<Buffer> {
  const p = pack();
  for (const e of entries) {
    const name = e.path.replace(/^\/+/, '');
    const header = { name, mode: e.mode, uid: e.uid, gid: e.gid, mtime: new Date() };
    if (e.type === 'directory') p.entry({ ...header, type: 'directory' });
    else p.entry({ ...header, type: 'file' }, e.bytes ?? e.content ?? '');
  }
  p.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of p) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
