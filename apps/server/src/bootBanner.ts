// PILOT-1189: the boot banner never holds the server code. It says where the code comes from and whether it is strong; a generated code
// (which lives only in memory, so the banner used to be the one way to learn it) is written to a file only the portal's user can read.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeBits, formatCode, MIN_CODE_BITS, type CodeSource } from '@portal/contracts';

/** Where a generated server code is kept: in the data dir, next to the database and the secret key, mode 0600. */
export const codeFilePath = (dataDir: string): string => join(dataDir, 'server-code');

/**
 * Writes a generated code to its file (only this user can read it) and returns the path. Review 60273: whatever is at the path is unlinked
 * first (a symlink goes, its target is untouched), then the file is created new (`wx`: O_CREAT|O_EXCL, which never follows a symlink and
 * fails if anything got there in between) with mode 0600, so the code is never written through a link or into a file with a wider mode.
 */
export function writeCodeFile(dataDir: string, code: string): string {
  const path = codeFilePath(dataDir);
  rmSync(path, { force: true });
  writeFileSync(path, `${formatCode(code)}\n`, { flag: 'wx', mode: 0o600 });
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
  return [
    '',
    `  portal ${opts.dev ? 'dev' : 'production'} server on ${opts.where}`,
    `  ${codeLine(opts.source, opts.code, opts.file)}`,
    '',
  ].join('\n');
}
