// Temporary directories for tests: removed when the test process exits, pass or fail (they hold a database each).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = new Set<string>();
process.once('exit', () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory under the system temp dir, named `<prefix>XXXXXX`. */
export function tempDirectory(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.add(dir);
  return dir;
}
