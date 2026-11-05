// PILOT-1189: the boot banner never holds the server code. It says where the code comes from and whether it is strong; a generated code
// (which lives only in memory, so the banner used to be the one way to learn it) is written to a file only the portal's user can read.
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeBits, formatCode, MIN_CODE_BITS, type CodeSource } from '@portal/contracts';

/** Where a generated server code is kept: in the data dir, next to the database and the secret key, mode 0600. */
export const codeFilePath = (dataDir: string): string => join(dataDir, 'server-code');

/** Writes a generated code to its file (only this user can read it) and returns the path. */
export function writeCodeFile(dataDir: string, code: string): string {
  const path = codeFilePath(dataDir);
  writeFileSync(path, `${formatCode(code)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // a file left from before keeps its old mode with writeFileSync
  return path;
}

/** Removes the file: the code came from PORTAL_SERVER_CODE, or it changed (a rotation shows the new one in Access). */
export function removeCodeFile(dataDir: string): void {
  rmSync(codeFilePath(dataDir), { force: true });
}

/** The banner's code line: where the code comes from, its strength class and, for a generated one, its file. Never the code. */
export function codeLine(source: CodeSource, code: string, file: string | null): string {
  const strength = codeBits(code) >= MIN_CODE_BITS ? 'strong' : `weak (below ${MIN_CODE_BITS} bits)`;
  if (source === 'env') return `server code: from PORTAL_SERVER_CODE, ${strength}`;
  return `server code: ${source}, ${strength}${file ? `; it is in ${file} (this user only)` : ''}`;
}

/** The lines printed once the server listens. */
export function bootBanner(opts: { dev: boolean; where: string; source: CodeSource; code: string; file: string | null }): string {
  return ['', `  portal ${opts.dev ? 'dev' : 'production'} server on ${opts.where}`, `  ${codeLine(opts.source, opts.code, opts.file)}`, ''].join('\n');
}
