import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const lockFile = (dataDir: string) => join(dataDir, 'portal.lock');

/** The pid of the portal using this data dir, or null. A lock left by a dead process doesn't count. */
export function isPortalRunning(dataDir: string): number | null {
  const file = lockFile(dataDir);
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, 'utf8').split('\n')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' ? pid : null;
  }
}

/**
 * One portal per data dir: the database has a single writer, and offline commands (restore,
 * rotate-key) refuse to run while a portal holds the lock. Resolves to the release function; the
 * lock is also released when the process exits.
 */
export async function acquireLock(dataDir: string, { waitMs = 5000 } = {}): Promise<() => void> {
  // A dev reload starts the new process while the old one is still exiting: give it a moment.
  const deadline = Date.now() + waitMs;
  let running = isPortalRunning(dataDir);
  while (running && running !== process.pid && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    running = isPortalRunning(dataDir);
  }
  if (running && running !== process.pid)
    throw new Error(`Another portal (pid ${running}) is using ${dataDir}. If it isn't running, delete ${lockFile(dataDir)}.`);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = lockFile(dataDir);
  writeFileSync(file, `${process.pid}\n${new Date().toISOString()}\n`, { mode: 0o600 });
  const release = () => {
    try {
      if (readFileSync(file, 'utf8').startsWith(`${process.pid}\n`)) rmSync(file);
    } catch {
      // already gone
    }
  };
  process.once('exit', release);
  return release;
}
