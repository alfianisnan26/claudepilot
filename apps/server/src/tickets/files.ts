// Ticket attachments' bytes (owner, 2026-10-17: "ticket support with attachment, all files"). Content-addressed under
// `<dataDir>/ticket-files/<sha256>` (0700 directory, 0600 files), written whole under a temporary name and renamed. Kept apart from the chat
// blobs on purpose: chat retention removes any blob no chat row links, which would take a ticket's file with it.

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHA = /^[a-f0-9]{64}$/;

export const ticketFileDir = (dataDir: string): string => join(dataDir, 'ticket-files');

function ensureDir(dataDir: string): string {
  const dir = ticketFileDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // not ours to change (a mount); the files are still 0600
  }
  return dir;
}

/** Stores the bytes once per content; returns their sha256. */
export function putTicketFile(dataDir: string, bytes: Buffer): string {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const file = join(ensureDir(dataDir), sha);
  if (!existsSync(file)) {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }
  return sha;
}

/** The bytes of a stored file, or null when it is missing (or the id is not a sha256). */
export function readTicketFile(dataDir: string, sha: string): Buffer | null {
  if (!SHA.test(sha)) return null;
  const file = join(ticketFileDir(dataDir), sha);
  return existsSync(file) ? readFileSync(file) : null;
}

/** Removes a stored file (the caller checked nothing else names it). */
export function removeTicketFile(dataDir: string, sha: string): void {
  if (SHA.test(sha)) rmSync(join(ticketFileDir(dataDir), sha), { force: true });
}
