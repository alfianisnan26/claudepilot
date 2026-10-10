import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A small JSON document on disk. Writes go to a temp file, are flushed to disk, then renamed into
 * place, so a crash mid-write never leaves half a file behind.
 */
export class JsonFile<T> {
  constructor(
    private readonly path: string,
    private readonly fallback: T,
  ) {}

  read(): T {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[store] could not read ${this.path}: ${(e as Error).message}`);
      return this.fallback;
    }
  }

  write(value: T) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}
